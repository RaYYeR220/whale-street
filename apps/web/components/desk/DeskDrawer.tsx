'use client';

import { PARAMS } from '@whale-street/core';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { MirrorOrderView, TradeRowView } from '../../lib/api-types';
import { hypeOf } from '../../lib/company';
import {
  agoLong,
  pct,
  price,
  shares,
  shortAddress,
  signedUsd,
  upDown,
  usd,
} from '../../lib/format';
import { avgEntry, holdingPnl, holdingReturn, isShort } from '../../lib/portfolio';
import { tradeText } from '../../lib/trades';
import { Portrait } from '../ink/Portrait';
import { useApi, useEngine, useEngineNow } from '../providers/engine';
import { usePlayer } from '../providers/player';

/** A read that answered, or why it did not (never shown as an empty list). */
type Loaded<T> = { ok: true; data: T } | { ok: false; message: string };

function MirrorSeal({ status }: { status: MirrorOrderView['status'] }) {
  if (status === 'FILLED' || status === 'RESTING' || status === 'CLOSED')
    return (
      <span className="co-seal co-seal--sm" data-s="pass" role="img" aria-label="Filled">
        <span>約</span>
      </span>
    );
  if (status === 'REFUSED' || status === 'REJECTED')
    return (
      <span className="co-seal co-seal--sm" data-s="fail" role="img" aria-label="Refused">
        <span>否</span>
      </span>
    );
  return (
    <span className="co-seal co-seal--sm" data-s="wait" role="img" aria-label="Unknown">
      <span>?</span>
    </span>
  );
}

export function DeskDrawer({ onNavigate }: { onNavigate(): void }) {
  const api = useApi();
  const { status, player, portfolio, rank, token, error, retry } = usePlayer();
  const market = useEngine((s) => s.market);
  const now = useEngineNow();
  const [trades, setTrades] = useState<Loaded<TradeRowView[]> | null>(null);
  const [mirror, setMirror] = useState<{
    /** Null when the status call failed: nothing is claimed about whether Mirror is on. */
    status: { available: boolean; mode: 'live' | 'replay' } | null;
    orders: Loaded<MirrorOrderView[]>;
  } | null>(null);
  const [again, setAgain] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `again` re-reads after a failure
  useEffect(() => {
    if (!player || !token) return;
    let cancelled = false;
    setTrades(null);
    setMirror(null);
    void Promise.all([
      api.profile(player.handle),
      api.mirrorStatus(),
      api.mirrorOrders(token),
    ]).then(([p, ms, mo]) => {
      if (cancelled) return;
      setTrades(
        p.ok ? { ok: true, data: p.data.trades.slice(0, 6) } : { ok: false, message: p.message },
      );
      setMirror({
        status: ms.ok ? ms.data : null,
        orders: mo.ok
          ? { ok: true, data: mo.data.orders.filter((o) => o.kind === 'order') }
          : { ok: false, message: mo.message },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [api, player, token, again]);

  if (status === 'loading') return <p role="status">Opening your desk…</p>;
  if (status === 'offline' || !player)
    return (
      <div className="ws-empty">
        <h2>Your desk is offline</h2>
        <p>{error ?? 'The engine did not answer.'} Nothing is shown until it does.</p>
        <button className="ws-btn ws-btn--quiet" type="button" onClick={retry}>
          Try again
        </button>
      </div>
    );

  const start = PARAMS.seasonStartCash;
  const nw = portfolio?.netWorth ?? null;
  return (
    <>
      <div className="me-head">
        <span>
          <Portrait seed={player.handle} hp={0.8} size={96} label="Your avatar" />
        </span>
        <div>
          <h3>{player.handle}</h3>
          <p>{rank !== null ? `Rank ${rank} this season` : 'Not in the top 50 yet'}</p>
        </div>
      </div>
      <div className="me-stats">
        <div className="ws-stat">
          <span className="ws-stat__k">Net worth</span>
          <span className="ws-stat__v ws-num" title={portfolio?.netWorthReason ?? undefined}>
            {usd(nw)}
          </span>
        </div>
        <div className="ws-stat">
          <span className="ws-stat__k">Cash</span>
          <span className="ws-stat__v ws-num">{usd(portfolio?.cash)}</span>
        </div>
        <div className="ws-stat">
          <span className="ws-stat__k">Since start</span>
          <span className={`ws-stat__v ${upDown(nw === null ? null : nw - start)}`}>
            {pct(nw === null ? null : nw / start - 1)}
          </span>
        </div>
      </div>
      {nw === null && portfolio?.netWorthReason ? (
        <p className="co-sub" style={{ margin: 0 }}>
          Net worth is hidden: {portfolio.netWorthReason}.
        </p>
      ) : null}

      <section>
        <h3 className="me-h">
          Holdings <small className="co-sub">play money</small>
        </h3>
        <div className="me-hold">
          {portfolio && portfolio.holdings.length > 0 ? (
            portfolio.holdings.map((h) => {
              const e = market?.byTicker[h.ticker];
              const short = isShort(h);
              const pnl = holdingPnl(h);
              const ret = holdingReturn(h);
              const qty = short ? h.shortQty : h.longQty;
              const avg = avgEntry(h);
              return (
                <Link
                  key={h.companyId}
                  href={`/c/${h.ticker}`}
                  onClick={onNavigate}
                  className="ws-panel ws-panel--thin me-hold__row"
                  style={{
                    ['--rot' as string]: short ? '.4deg' : '-.3deg',
                    textDecoration: 'none',
                  }}
                >
                  <span className="face">
                    <Portrait
                      seed={h.companyId}
                      hp={e?.hp}
                      hype={hypeOf(e?.mult)}
                      status={
                        e?.status === 'HALTED'
                          ? 'halted'
                          : e && e.status !== 'ACTIVE'
                            ? 'bankrupt'
                            : 'active'
                      }
                      size={70}
                      label={`${h.ticker} CEO`}
                    />
                  </span>
                  <span>
                    <span className="t">
                      {short ? 'Short ' : ''}
                      {h.ticker}
                    </span>
                    <br />
                    <span className="d">
                      {shares(qty)} shares{avg !== null ? ` at ${price(avg)}` : ''}, now{' '}
                      {price(h.price)}
                    </span>
                  </span>
                  <span className={`pl ${upDown(pnl)}`}>
                    {signedUsd(pnl)}
                    <small>{ret === null ? '' : pct(ret)}</small>
                  </span>
                </Link>
              );
            })
          ) : (
            <p style={{ margin: 0 }}>No holdings yet. Buy a trader from the floor.</p>
          )}
        </div>
      </section>

      <section>
        <h3 className="me-h">
          Mirror orders and receipts <small className="co-sub">real money</small>
        </h3>
        {mirror === null ? (
          <p role="status">Loading…</p>
        ) : !mirror.orders.ok ? (
          <div className="ws-v-red" role="alert">
            <p style={{ margin: 0 }}>
              Couldn't load your Mirror orders ({mirror.orders.message}). Check them on Hyperliquid
              before sending anything again.
            </p>
            <button className="ws-link" type="button" onClick={() => setAgain((n) => n + 1)}>
              Try again
            </button>
          </div>
        ) : mirror.orders.data.length === 0 ? (
          <p style={{ margin: 0 }}>
            {mirror.status === null || mirror.status.available
              ? 'No mirror orders yet. Mirror starts from any company page.'
              : mirror.status.mode === 'replay'
                ? 'Mirror is off on this engine (REPLAY runs without real orders).'
                : 'Mirror is off on this engine (it runs without access to the Nansen Trading API).'}
          </p>
        ) : (
          <ul className="me-mir">
            {mirror.orders.data.map((m) => (
              <li
                key={m.id}
                className={
                  m.status === 'REFUSED' || m.status === 'REJECTED'
                    ? 'is-refused'
                    : m.status === 'UNKNOWN' || m.status === 'SUBMITTED'
                      ? 'is-unknown'
                      : ''
                }
              >
                <MirrorSeal status={m.status} />
                <span>
                  <b>
                    {m.ticker}: {m.coin}, {usd(m.notionalUsd)}
                  </b>
                  <span className="s">
                    {m.status === 'REFUSED'
                      ? (m.refusals ?? []).map((r) => `${r.code}: “${r.message}”`).join(' ')
                      : m.status === 'UNKNOWN' || m.status === 'SUBMITTED'
                        ? 'No definitive answer from Hyperliquid. Check it there before sending again.'
                        : m.status === 'CLOSED'
                          ? `Filled, and closed on Hyperliquid since${m.hlOid !== null ? ` (order ${m.hlOid})` : ''}.`
                          : m.error
                            ? m.error
                            : m.hlOid !== null
                              ? `Order ${m.hlOid}${m.avgPx !== null ? ` at ${price(m.avgPx)}` : ''}`
                              : 'Sent'}
                  </span>
                  <span className="s">{now !== null ? agoLong(now - m.createdAt) : ''}</span>
                </span>
                <span
                  className={`me-mir__st ${m.status === 'REFUSED' || m.status === 'REJECTED' ? 'ws-v-red' : m.status === 'UNKNOWN' || m.status === 'SUBMITTED' ? 'ws-v-down' : 'ws-v-nav'}`}
                >
                  {m.status === 'RESTING'
                    ? 'Resting'
                    : m.status.charAt(0) + m.status.slice(1).toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ws-panel ws-panel--flat ws-panel--thin ws-panel--paper me-wallet">
        <h3 className="me-h">
          {player.walletAddress ? 'Hyperliquid wallet' : 'Mirror with real money'}
        </h3>
        {player.walletAddress ? (
          <p>
            Linked wallet <b>{shortAddress(player.walletAddress)}</b>. Mirror orders use its USDC on
            Hyperliquid, never your play money.
          </p>
        ) : (
          <p>
            Link a Hyperliquid wallet from any company page to copy a listed trader with a small,
            capped stake. The committee checks every order first.
          </p>
        )}
      </section>

      <section>
        <h3 className="me-h">Your trades</h3>
        <ul className="me-list">
          {trades === null ? (
            <li>
              <span>Loading…</span>
            </li>
          ) : !trades.ok ? (
            <li className="ws-v-red">
              <span>Couldn't load your trades ({trades.message}).</span>
            </li>
          ) : trades.data.length === 0 ? (
            <li>
              <span>No trades yet. Buy a trader from the floor.</span>
            </li>
          ) : (
            trades.data.map((t) => (
              <li key={t.id}>
                <span>{tradeText(t)}</span>
                <span>{now !== null ? agoLong(now - t.at) : ''}</span>
              </li>
            ))
          )}
        </ul>
      </section>
      <Link
        className="ws-link"
        href={`/u/${encodeURIComponent(player.handle)}`}
        onClick={onNavigate}
      >
        Open your public profile
      </Link>
    </>
  );
}
