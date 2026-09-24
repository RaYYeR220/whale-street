'use client';

import { PARAMS } from '@whale-street/core';
import Link from 'next/link';
import type { ProfileView as Profile } from '../../lib/api';
import { hypeOf } from '../../lib/company';
import { agoSec, dayLabel, pct, price, shares, signedUsd, upDown, usd } from '../../lib/format';
import { avgEntry, holdingPnl, holdingReturn, isShort } from '../../lib/portfolio';
import { useDrawer } from '../chrome/Drawer';
import { Portrait } from '../ink/Portrait';
import { useChannels, useEngine, useEngineNow } from '../providers/engine';
import { usePlayer } from '../providers/player';

const PAST: Record<string, string> = {
  BUY: 'Bought',
  SELL: 'Sold',
  SHORT: 'Shorted',
  COVER: 'Covered',
  SETTLE: 'Settled',
};

/** A player's verified record: holdings, trades and past seasons. */
export function ProfileView({ profile }: { profile: Profile }) {
  useChannels(['market']);
  const market = useEngine((s) => s.market);
  const now = useEngineNow(15_000);
  const { player } = usePlayer();
  const { open } = useDrawer();
  const p = profile.player;
  const mine = player?.id === p.id;
  const pf = profile.portfolio;
  const r = pf.netWorth === null ? null : pf.netWorth / PARAMS.seasonStartCash - 1;
  return (
    <main className="pf" id="main">
      <section
        className="ws-panel pf-head"
        aria-labelledby="pf-h"
        style={{ ['--rot' as string]: '-.2deg' }}
      >
        <Portrait
          className="ws-face"
          seed={p.handle}
          hp={0.86}
          size={132}
          label={`${p.handle}'s avatar`}
        />
        <div>
          <h1 id="pf-h">
            {p.handle}
            {mine ? <span className="ws-badge ws-badge--you">YOU</span> : null}
            {p.kind === 'agent' ? <span className="ws-badge ws-badge--agent">AGENT</span> : null}
            {p.kind === 'bot' ? <span className="ws-badge ws-badge--bot">BOT</span> : null}
          </h1>
          <p>
            {p.kind === 'human'
              ? 'Human player'
              : p.kind === 'agent'
                ? 'AI agent over MCP'
                : 'House bot fund'}
            , joined {dayLabel(p.createdAt)}.{' '}
            {p.walletLinked ? 'Hyperliquid wallet linked.' : 'No wallet linked.'}
          </p>
        </div>
      </section>
      <div className="pf-col">
        <div className="me-stats">
          <div className="ws-stat">
            <span className="ws-stat__k">Net worth</span>
            <span className="ws-stat__v ws-num" title={pf.netWorthReason ?? undefined}>
              {usd(pf.netWorth)}
            </span>
          </div>
          <div className="ws-stat">
            <span className="ws-stat__k">Cash</span>
            <span className="ws-stat__v ws-num">{usd(pf.cash)}</span>
          </div>
          <div className="ws-stat">
            <span className="ws-stat__k">This season</span>
            <span className={`ws-stat__v ${upDown(r)}`}>{pct(r)}</span>
          </div>
        </div>
        {pf.netWorth === null && pf.netWorthReason ? (
          <p className="co-sub">Net worth is hidden: {pf.netWorthReason}.</p>
        ) : null}
        <section className="ws-panel ws-panel--thin pf-sec" aria-labelledby="pf-hold">
          <h2 className="ws-cap" id="pf-hold">
            Holdings <small>play money, season {pf.seasonId}</small>
          </h2>
          <div className="me-hold">
            {pf.holdings.length === 0 ? (
              <p style={{ margin: 0 }}>No holdings this season.</p>
            ) : (
              pf.holdings.map((h) => {
                const e = market?.byTicker[h.ticker];
                const short = isShort(h);
                const pnl = holdingPnl(h);
                const rr = holdingReturn(h);
                return (
                  <Link
                    key={h.companyId}
                    href={`/c/${h.ticker}`}
                    className="ws-panel ws-panel--thin me-hold__row"
                    style={{ textDecoration: 'none' }}
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
                        {shares(short ? h.shortQty : h.longQty)} shares at {price(avgEntry(h))}, now{' '}
                        {price(h.price)}
                      </span>
                    </span>
                    <span className={`pl ${upDown(pnl)}`}>
                      {signedUsd(pnl)}
                      <small>{rr === null ? '' : pct(rr)}</small>
                    </span>
                  </Link>
                );
              })
            )}
          </div>
        </section>
      </div>
      <div className="pf-col">
        <section className="ws-panel ws-panel--thin pf-sec" aria-labelledby="pf-trades">
          <h2 className="ws-cap" id="pf-trades">
            Trades <small>latest first</small>
          </h2>
          <ul className="me-list">
            {profile.trades.length === 0 ? (
              <li>
                <span>No trades yet.</span>
              </li>
            ) : (
              profile.trades.slice(0, 20).map((t) => (
                <li key={t.id}>
                  <span>
                    {PAST[t.side]} {shares(t.qty)} {t.ticker} at {price(t.avgPrice)}
                    {t.forced ? ' (auto)' : ''}
                  </span>
                  <span>{now === null ? '' : `${agoSec(now - t.at)} ago`}</span>
                </li>
              ))
            )}
          </ul>
        </section>
        <section className="ws-panel ws-panel--thin pf-sec" aria-labelledby="pf-seasons">
          <h2 className="ws-cap" id="pf-seasons">
            Past seasons
          </h2>
          {profile.seasons.length === 0 ? (
            <p className="co-sub" style={{ margin: 0 }}>
              No finished season yet.
            </p>
          ) : (
            <ol className="pf-seasons">
              {profile.seasons.map((s) => (
                <li key={s.seasonId}>
                  <span>Season {s.seasonId}</span>
                  <span>
                    rank {s.rank}, {usd(s.netWorth)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
        {mine ? (
          <button
            className="ws-btn ws-btn--quiet"
            type="button"
            onClick={() => open({ kind: 'desk' })}
          >
            Open your desk (mirror receipts too)
          </button>
        ) : null}
      </div>
      <footer className="pf-foot">
        <p>Every trade on Whale Street is recorded by the engine; this page reads that record.</p>
        <span>
          Powered by <b>Nansen API</b>
        </span>
      </footer>
    </main>
  );
}
