'use client';

import { PARAMS } from '@whale-street/core';
import { useMemo } from 'react';
import type { DisplayCompany } from '../../lib/company';
import { ago, pct, price, upDown, usd } from '../../lib/format';
import { NMark } from '../chrome/Drawer';
import { Portrait } from '../ink/Portrait';
import { Spark } from '../ink/Spark';
import { useEngine } from '../providers/engine';
import { usePlayer } from '../providers/player';

const DAY_MS = 86_400_000;

/** Average NAV of listed companies per minute (ignores minutes a company has no trusted value). */
export function indexSeries(companies: readonly DisplayCompany[]): Array<number | null> {
  const listed = companies.filter((c) => c.display !== 'bankrupt' && c.display !== 'delisted');
  const n = listed[0]?.spark.nav.length ?? 0;
  return Array.from({ length: n }, (_, i) => {
    const vals = listed.map((c) => c.spark.nav[i]).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  });
}

export function MarketStrip({
  companies,
  now,
}: {
  companies: DisplayCompany[];
  now: number | null;
}) {
  const status = useEngine((s) => s.status);
  // Engine time of the last market frame (the e2e suite watches it advance).
  const marketAt = useEngine((s) => s.market?.at ?? null);
  const filings = useEngine((s) => s.filings);
  const leaderboard = useEngine((s) => s.leaderboard);
  const { portfolio, rank } = usePlayer();
  const listed = companies.filter((c) => c.display !== 'bankrupt' && c.display !== 'delisted');
  const idx = listed.length
    ? listed.reduce((s, c) => s + (c.nav ?? 0), 0) / listed.filter((c) => c.nav !== null).length
    : null;
  const series = useMemo(() => indexSeries(companies), [companies]);
  const first = series.find((v) => v != null) ?? null;
  const idxChg = idx !== null && first ? idx / first - 1 : null;
  const ipo = companies.filter((c) => c.display === 'ipo').length;
  const halted = companies.filter((c) => c.display === 'halted').length;
  const bankruptcies =
    now === null ? [] : filings.filter((f) => f.kind === 'BANKRUPTCY' && now - f.at < DAY_MS);
  const lastBk = bankruptcies[0];
  const nw = portfolio?.netWorth ?? null;
  const bots = leaderboard?.filter((r) => r.kind === 'bot').length ?? null;
  const agents = leaderboard?.filter((r) => r.kind === 'agent').length ?? null;
  return (
    <section
      className="ws-strip"
      aria-label="Market summary"
      data-market-at={marketAt ?? undefined}
    >
      <div className="ws-stat ws-stat--spark">
        <span className="ws-stat__k">
          Whale Street Index <NMark label="Where the index NAVs come from" />
        </span>
        <span className="ws-stat__v">
          <span className="ws-num" data-testid="index-value">
            {price(idx)}
          </span>
          <small className={idxChg !== null && idxChg >= 0 ? 'ws-v-nav' : 'ws-v-down'}>
            {pct(idxChg)} 1h
          </small>
        </span>
        <Spark nav={series} price={series.map(() => null)} label="Whale Street Index, last hour" />
      </div>
      <div className="ws-stat">
        <span className="ws-stat__k">Listed traders</span>
        <span className="ws-stat__v">
          {listed.length}
          <small className="ws-v-up">{ipo} in IPO</small>
          <small className="ws-v-down">{halted} halted</small>
        </span>
      </div>
      <div className="ws-stat">
        <span className="ws-stat__k">Bankrupt, last 24h</span>
        <span className="ws-stat__v strip-bk">
          {bankruptcies.length}
          {lastBk && now !== null ? (
            <>
              <span className="strip-bk__face">
                <Portrait seed={lastBk.companyId} hp={0} status="bankrupt" size={40} label="" />
              </span>
              <small className="ws-v-muted">
                {lastBk.ticker}, {ago(now - lastBk.at)} ago
              </small>
            </>
          ) : null}
        </span>
      </div>
      <div className="ws-stat">
        <span className="ws-stat__k">Your net worth</span>
        <span className="ws-stat__v">
          <span className="ws-num" title={portfolio?.netWorthReason ?? undefined}>
            {usd(nw)}
          </span>
          <small className={upDown(nw === null ? null : nw - PARAMS.seasonStartCash)}>
            {pct(nw === null ? null : nw / PARAMS.seasonStartCash - 1)} season
          </small>
          <small className="ws-v-muted">{rank !== null ? `rank ${rank}` : 'unranked'}</small>
        </span>
      </div>
      <div className="ws-stat">
        <span className="ws-stat__k">On the floor now</span>
        <span className="ws-stat__v">
          <span className="ws-num">{status ? status.viewers : '—'}</span>
          <small className="ws-v-muted">watching,</small>
          <small className="ws-v-down">
            {bots === null ? '—' : `${bots} bots, ${agents} agents on the board`}
          </small>
        </span>
      </div>
      <div className="ws-stat strip-nansen">
        <span className="ws-stat__k">
          {status?.mode === 'replay' ? 'Data' : 'Nansen credits left'}
        </span>
        <span className="ws-stat__v">
          <span className="ws-num">
            {status?.mode === 'replay'
              ? 'Recorded'
              : status?.creditsRemaining != null
                ? status.creditsRemaining.toLocaleString('en-US')
                : '—'}
          </span>
          <small className="ws-v-nav">Powered by Nansen API</small>
        </span>
      </div>
    </section>
  );
}
