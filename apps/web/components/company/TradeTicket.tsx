'use client';

import { type OrderSide, PARAMS } from '@whale-street/core';
import Link from 'next/link';
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import type { QuoteView } from '../../lib/api-types';
import { type DisplayCompany, IPO_CAP_USD } from '../../lib/company';
import { orderErrorText } from '../../lib/errors';
import { mmss, pct, pctAbs, price, shares, signedUsd, upDown, usd } from '../../lib/format';
import { avgEntry, holdingPnl, holdingReturn } from '../../lib/portfolio';
import { useApi } from '../providers/engine';
import { usePlayer } from '../providers/player';
import { useTrade } from './useTrade';

type Side = 'buy' | 'sell' | 'short' | 'cover';
const VERB: Record<Side, string> = { buy: 'Buy', sell: 'Sell', short: 'Short', cover: 'Cover' };
const WIRE: Record<Side, OrderSide> = { buy: 'BUY', sell: 'SELL', short: 'SHORT', cover: 'COVER' };
/** Share of the IPO allowance a dollar amount may use, leaving room for the fee and price impact. */
export const IPO_HEADROOM = 0.97;

/** What a player may still spend on a company during its IPO minute (the engine enforces it). */
export function ipoAllowance(longCost: number | undefined): number {
  return Math.max(0, IPO_CAP_USD - (longCost ?? 0));
}

/** Share quantity for an amount (2 decimals, never more than `cap`). */
export function qtyFor(
  unit: 'usd' | 'shares',
  amt: number,
  px: number | null,
  cap = Number.POSITIVE_INFINITY,
): number {
  const raw = unit === 'shares' ? amt : px && px > 0 ? amt / px : 0;
  return Math.max(0, Math.floor(Math.min(raw, cap) * 100) / 100);
}

/** Fee inside a quoted cash amount: buys pay cash·(1+f), sells receive cash·(1−f). */
export function feeOf(side: Side, cash: number): number {
  const f = PARAMS.feeRate;
  return side === 'buy' || side === 'cover' ? (cash * f) / (1 + f) : (cash * f) / (1 - f);
}

export function TradeTicket({ c, now }: { c: DisplayCompany; now: number | null }) {
  const api = useApi();
  const trade = useTrade();
  const { portfolio, status } = usePlayer();
  const ipo = c.display === 'ipo';
  const [side, setSide] = useState<Side>('buy');
  const [unit, setUnit] = useState<'usd' | 'shares'>('usd');
  const [amt, setAmt] = useState(1_000);
  const [quote, setQuote] = useState<{
    q: QuoteView | null;
    error: string | null;
    qty: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const holding = portfolio?.holdings.find((h) => h.ticker === c.ticker);
  const ipoLeft = ipoAllowance(holding?.longCost);
  // During the IPO minute the default amount has to fit what is left of the allowance.
  useEffect(() => {
    if (ipo) setAmt((a) => Math.min(a, Math.floor(ipoLeft * IPO_HEADROOM)));
  }, [ipo, ipoLeft]);
  const longQty = holding?.longQty ?? 0;
  const shortQty = holding?.shortQty ?? 0;
  const cash = portfolio?.cash ?? 0;
  const cap = side === 'sell' ? longQty : side === 'cover' ? shortQty : Number.POSITIVE_INFINITY;
  const qty = qtyFor(unit, amt, c.price, cap);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-quote whenever the share price moves
  useEffect(() => {
    if (!(qty > 0) || (c.display !== 'active' && !ipo)) {
      setQuote(null);
      return;
    }
    const ctl = new AbortController();
    const id = setTimeout(async () => {
      const r = await api.quote(c.ticker, WIRE[side], qty, ctl.signal);
      if (ctl.signal.aborted) return;
      setQuote(
        r.ok
          ? { q: r.data, error: null, qty }
          : { q: null, error: orderErrorText(r.error, r.message), qty },
      );
    }, 250);
    return () => {
      ctl.abort();
      clearTimeout(id);
    };
  }, [api, c.ticker, c.display, ipo, side, qty, c.price]);

  const q = quote?.qty === qty ? quote.q : null;
  const collateral = side === 'short' && q ? q.cash * PARAMS.shortCollateralMultiple : null;
  const clientError = useMemo(() => {
    if (!(amt > 0)) return 'Enter an amount.';
    if (side === 'sell' && longQty <= 0) return `You don't hold ${c.ticker} yet.`;
    if (side === 'cover' && shortQty <= 0) return `You aren't short ${c.ticker}. Nothing to cover.`;
    if (!(qty > 0)) return 'Too small for a hundredth of a share.';
    if (q && side === 'buy' && q.cash > cash + 1e-6) return 'Not enough cash.';
    if (q && side === 'buy' && ipo && q.cash > ipoLeft + 1e-6)
      return `IPO buys are capped at ${usd(IPO_CAP_USD)} per player in the first minute; ${usd(ipoLeft)} left.`;
    if (collateral !== null && collateral - (q?.cash ?? 0) > cash + 1e-6)
      return 'Not enough cash for the collateral.';
    return null;
  }, [amt, side, longQty, shortQty, qty, q, cash, ipo, ipoLeft, collateral, c.ticker]);
  const error = clientError ?? quote?.error ?? null;
  const ok = !error && q !== null && status === 'ready' && !busy;

  const place = async () => {
    if (!ok) return;
    setBusy(true);
    await trade({ ticker: c.ticker, side: WIRE[side], qty });
    setBusy(false);
  };

  const pickSide = (s: Side) => {
    setSide(s);
    if (s === 'sell' || s === 'cover') {
      setUnit('shares');
      setAmt(s === 'sell' ? longQty : shortQty);
    } else if (unit === 'shares') {
      setUnit('usd');
      setAmt(1_000);
    }
    setQuote(null);
  };
  const tabs: Side[] = ipo ? ['buy'] : ['buy', 'sell', 'short', 'cover'];
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = tabs.indexOf(side);
    const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length] as Side;
    pickSide(n);
    document.getElementById(`tab-${n}`)?.focus();
  };

  const cap2 = (
    <h2 className="ws-cap" id="trade-h" tabIndex={-1}>
      Trade <small>play money</small>
    </h2>
  );

  if (c.display === 'bankrupt' || c.display === 'delisted')
    return (
      <section className="ws-panel ws-panel--flat co-ticket co-trade" aria-labelledby="trade-h">
        {cap2}
        <div className="co-closed co-closed--red">
          <b>{c.ticker} is delisted.</b>
          <span>It went bankrupt. Every holder was settled at NAV and the shares are gone.</span>
          <Link className="ws-btn ws-btn--quiet" href="/floor">
            Find another trader
          </Link>
        </div>
      </section>
    );

  const halted = c.display === 'halted';
  const rows: Array<[string, string, string?, string?]> = [];
  rows.push([
    side === 'short' ? 'You short' : side === 'sell' ? 'You sell' : 'You get',
    `${shares(qty)} shares`,
  ]);
  if (q) {
    rows.push(['Average price', price(q.avgPrice)]);
    const impact = q.price > 0 ? q.priceAfter / q.price - 1 : null;
    rows.push([
      'Hype impact',
      `${impact !== null && impact >= 0 ? '+' : '−'}${pctAbs(impact, 2)}`,
      undefined,
      `price ${price(q.price)} to ${price(q.priceAfter)}`,
    ]);
    rows.push([`Fee (${(PARAMS.feeRate * 100).toFixed(1)}%)`, usd(feeOf(side, q.cash))]);
    if (collateral !== null)
      rows.push([
        'Collateral locked',
        usd(collateral),
        undefined,
        `${PARAMS.shortCollateralMultiple}× the sale, returned when you cover`,
      ]);
    rows.push([
      side === 'buy' || side === 'cover' ? 'Total cost' : 'You receive',
      usd(q.cash),
      'is-total',
    ]);
  }
  const cashAfter = q
    ? side === 'buy'
      ? cash - q.cash
      : side === 'sell'
        ? cash + q.cash
        : side === 'short'
          ? cash - (collateral ?? 0) + q.cash
          : null
    : null;

  return (
    <section className="ws-panel ws-panel--flat co-ticket co-trade" aria-labelledby="trade-h">
      {cap2}
      <div
        className="co-tabs"
        role="tablist"
        aria-label="Order side"
        style={{ gridTemplateColumns: `repeat(${tabs.length},1fr)` }}
      >
        {tabs.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            id={`tab-${s}`}
            data-side={s}
            aria-selected={side === s}
            aria-controls="trade-panel"
            tabIndex={side === s ? 0 : -1}
            disabled={halted}
            onClick={() => pickSide(s)}
            onKeyDown={onTabKey}
          >
            {s === 'buy' && ipo ? 'Buy IPO shares' : VERB[s]}
          </button>
        ))}
      </div>
      <div id="trade-panel" role="tabpanel" aria-labelledby={`tab-${side}`}>
        {halted ? (
          <div className="co-closed">
            <b>Trading paused</b>
            <span>
              {c.haltReason ? `${c.haltReason}. ` : ''}Nobody can trade {c.ticker} at a fair price
              until fresh data returns. Your shares are safe.
            </span>
          </div>
        ) : (
          <>
            <div className="co-field">
              <div className="co-field__top">
                <label htmlFor="amt">Amount</label>
                <fieldset className="co-unit" aria-label="Amount in">
                  <button
                    type="button"
                    aria-pressed={unit === 'usd'}
                    onClick={() => {
                      if (unit === 'usd') return;
                      setAmt(Math.round(amt * (c.price ?? 0)));
                      setUnit('usd');
                    }}
                  >
                    Dollars
                  </button>
                  <button
                    type="button"
                    aria-pressed={unit === 'shares'}
                    onClick={() => {
                      if (unit === 'shares') return;
                      setAmt(qtyFor('usd', amt, c.price));
                      setUnit('shares');
                    }}
                  >
                    Shares
                  </button>
                </fieldset>
              </div>
              <div className={`co-input${error && amt > 0 ? ' is-bad' : ''}`}>
                <span aria-hidden="true">{unit === 'usd' ? '$' : '#'}</span>
                <input
                  id="amt"
                  inputMode="decimal"
                  autoComplete="off"
                  aria-describedby="trade-err"
                  value={Number.isFinite(amt) ? String(amt) : ''}
                  onChange={(e) =>
                    setAmt(Number.parseFloat(e.target.value.replace(/[^0-9.]/g, '')) || 0)
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void place();
                  }}
                />
              </div>
              <div className="co-quick">
                {side === 'sell' || side === 'cover'
                  ? (['25%', '50%', 'All'] as const).map((l) => (
                      <button
                        key={l}
                        className="ws-chip"
                        type="button"
                        onClick={() => {
                          const have = side === 'sell' ? longQty : shortQty;
                          setUnit('shares');
                          setAmt(
                            l === 'All' ? have : Math.floor(have * (l === '25%' ? 25 : 50)) / 100,
                          );
                        }}
                      >
                        {l}
                      </button>
                    ))
                  : (
                      (ipo
                        ? [
                            ['$250', 250],
                            ['$500', 500],
                            ['Max', -1],
                          ]
                        : [
                            ['$500', 500],
                            ['$1k', 1_000],
                            ['$2k', 2_000],
                            ['Max', -1],
                          ]) as ReadonlyArray<readonly [string, number]>
                    ).map(([l, v]) => (
                      <button
                        key={l}
                        className="ws-chip"
                        type="button"
                        onClick={() => {
                          setUnit('usd');
                          const max =
                            side === 'short' ? cash / PARAMS.shortCollateralMultiple : cash;
                          setAmt(
                            v < 0
                              ? Math.floor(ipo ? Math.min(max, ipoLeft * IPO_HEADROOM) : max)
                              : v,
                          );
                        }}
                      >
                        {l}
                      </button>
                    ))}
              </div>
            </div>
            <dl className="co-q">
              {rows.map(([k, v, cls, small]) => (
                <div key={k} className={cls}>
                  <dt>{k}</dt>
                  <dd>
                    {v}
                    {small ? <small>{small}</small> : null}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="co-ticket__note ws-v-red" id="trade-err" role="alert">
              {amt > 0 ? error : ''}
            </p>
            <button
              className={`ws-btn co-go${side === 'short' || side === 'sell' ? ' ws-btn--short' : ''}`}
              type="button"
              disabled={!ok}
              onClick={() => void place()}
            >
              {busy
                ? 'Sending…'
                : ok
                  ? `${VERB[side]} ${shares(qty)} ${c.ticker}`
                  : `${VERB[side]} ${c.ticker}`}
            </button>
            <p className="co-ticket__note">
              Cash <b>{usd(portfolio?.cash)}</b>
              {cashAfter !== null && !error ? (
                <>
                  , after this trade <b>{usd(cashAfter)}</b>
                </>
              ) : null}
              .
            </p>
          </>
        )}
      </div>
      {ipo && c.ipoUntil !== null && now !== null ? (
        <div className="co-ipo">
          <div className="co-ipo__row">
            <span>
              IPO window: buy up to <b>{usd(IPO_CAP_USD)}</b> per player
            </span>
            <span className="ws-num">{mmss(c.ipoUntil - now)}</span>
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: a drawn bar; the native <meter> cannot take this design */}
          <div
            className="ws-co__alloc-bar"
            role="meter"
            aria-label="IPO window time left"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(
              Math.max(0, Math.min(1, (c.ipoUntil - now) / PARAMS.ipoWindowMs)) * 100,
            )}
          >
            <i
              style={{
                width: `${Math.max(0, Math.min(1, (c.ipoUntil - now) / PARAMS.ipoWindowMs)) * 100}%`,
              }}
            />
          </div>
          <span>The pool prices every buy; the cap lifts when the window closes.</span>
        </div>
      ) : null}
      <div className="co-pos">
        {holding ? (
          <>
            <div className="co-pos__h">
              <b>{shortQty > 0 ? 'Your short' : 'Your position'}</b>
              <span className={`co-pos__pl ${upDown(holdingPnl(holding))}`}>
                {signedUsd(holdingPnl(holding))}
              </span>
            </div>
            <span>
              {shares(shortQty > 0 ? shortQty : longQty)} shares at {price(avgEntry(holding))}{' '}
              average, now {price(holding.price)}. Worth {usd(holding.value)},{' '}
              {pct(holdingReturn(holding))}.
            </span>
          </>
        ) : (
          <>
            <div className="co-pos__h">
              <b>Your position</b>
            </div>
            <span>You don't hold {c.ticker} yet.</span>
          </>
        )}
      </div>
    </section>
  );
}
