'use client';

import { PARAMS } from '@whale-street/core';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { MirrorOrderView, TradeRowView } from '../../lib/api-types';
import { hypeOf } from '../../lib/company';
import {
  agoLong,
  agoSec,
  pct,
  price,
  shares,
  shortAddress,
  signedUsd,
  upDown,
  usd,
} from '../../lib/format';
import { avgEntry, holdingPnl, holdingReturn, isShort } from '../../lib/portfolio';
import { Portrait } from '../ink/Portrait';
import { useApi, useEngine, useEngineNow } from '../providers/engine';
import { usePlayer } from '../providers/player';

const PAST: Record<string, string> = {
  BUY: 'Bought',
  SELL: 'Sold',
  SHORT: 'Shorted',
  COVER: 'Covered',
  SETTLE: 'Settled',
};

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
  const [trades, setTrades] = useState<TradeRowView[] | null>(null);
  const [mirror, setMirror] = useState<{ available: boolean; orders: MirrorOrderView[] } | null>(
    null,
  );

  useEffect(() => {
    if (!player || !token) return;
    let cancelled = false;
    void Promise.all([
      api.profile(player.handle),
      api.mirrorStatus(),
      api.mirrorOrders(token),
    ]).then(([p, ms, mo]) => {
      if (cancelled) return;
      setTrades(p.ok ? p.data.trades.slice(0, 6) : []);
      setMirror({
        available: ms.ok && ms.data.available,
        orders: mo.ok ? mo.data.orders.filter((o) => o.kind === 'order') : [],
      });
    });
    return () => {
      cancelled = true;
    };
  }, [api, player, token]);

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
        ) : mirror.orders.length === 0 ? (
          <p style={{ margin: 0 }}>
            {mirror.available
              ? 'No mirror orders yet. Mirror starts from any company page.'
              : 'Mirror is off on this engine (REPLAY runs without real orders).'}
          </p>
        ) : (
          <ul className="me-mir">
            {mirror.orders.map((m) => (
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
          ) : trades.length === 0 ? (
            <li>
              <span>No trades yet. Buy a trader from the floor.</span>
            </li>
          ) : (
            trades.map((t) => (
              <li key={t.id}>
                <span>
                  {PAST[t.side]} {shares(t.qty)} {t.ticker} at {price(t.avgPrice)}
                </span>
                <span>{now !== null ? `${agoSec(now - t.at)} ago` : ''}</span>
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
