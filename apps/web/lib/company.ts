/**
 * Display model of a listed company: the live 1 Hz entry (price, NAV, HP, status) merged with the
 * slower REST view (name, rating, positions, prospectus) and the minute series.
 */
import { type CompanyStatus, PARAMS, type Rating } from '@whale-street/core';
import type { CompanyView, MarketEntry, PositionView } from './api-types';
import type { PortraitStatus } from './portrait';
import { change, lastMinutes, type Series } from './store';

export type DisplayStatus = 'active' | 'ipo' | 'halted' | 'bankrupt' | 'delisted';

/** What one player may buy of a company during its IPO window (the engine enforces it). */
export const IPO_CAP_USD = PARAMS.ipoCapFrac * PARAMS.seasonStartCash;

export interface HeadlinePosition {
  text: string;
  usd: number | null;
  liq: number | null;
}

export interface DisplayCompany {
  id: string;
  ticker: string;
  name: string;
  rating: Rating | null;
  style: string | null;
  status: CompanyStatus;
  display: DisplayStatus;
  nav: number | null;
  price: number | null;
  hype: number | null;
  hp: number | null;
  haltReason: string | null;
  listedAt: number | null;
  ipoUntil: number | null;
  lastSnapshotAt: number | null;
  positions: PositionView[];
  headline: HeadlinePosition | null;
  navChg1h: number | null;
  priceChg1h: number | null;
  spark: { nav: Array<number | null>; price: Array<number | null> };
}

const finite = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

export const side = (p: { size: number }): 'LONG' | 'SHORT' => (p.size >= 0 ? 'LONG' : 'SHORT');

/** Notional in USD at the live mark (entry price when no mark is known). */
export function notional(p: PositionView): number | null {
  const px = finite(p.mark) ?? finite(p.entryPx);
  return px === null ? null : Math.abs(p.size) * px;
}

/** Fraction the mark can move before liquidation, or null when there is no liquidation price. */
export function liqDistance(p: PositionView): number | null {
  const mark = finite(p.mark);
  const liq = finite(p.liqPx);
  if (mark === null || liq === null || mark <= 0) return null;
  return Math.abs(mark - liq) / mark;
}

/** Live unrealized PnL at the mark; falls back to the value reported with the snapshot. */
export function unrealized(p: PositionView): { usd: number | null; live: boolean } {
  const mark = finite(p.mark);
  if (mark !== null && finite(p.entryPx) !== null)
    return { usd: p.size * (mark - p.entryPx), live: true };
  return { usd: finite(p.unrealizedPnl), live: false };
}

export function headline(positions: readonly PositionView[]): HeadlinePosition | null {
  let best: PositionView | null = null;
  let bestUsd = -1;
  for (const p of positions) {
    const usd = notional(p) ?? 0;
    if (usd > bestUsd) {
      best = p;
      bestUsd = usd;
    }
  }
  if (!best) return null;
  return {
    text: `${side(best)} ${best.coin} ${Math.round(best.leverage)}x`,
    usd: notional(best),
    liq: finite(best.liqPx),
  };
}

export function displayStatus(
  status: CompanyStatus,
  ipoUntil: number | null,
  now: number | null,
): DisplayStatus {
  if (status === 'HALTED') return 'halted';
  if (status === 'BANKRUPT') return 'bankrupt';
  if (status === 'DELISTED') return 'delisted';
  if (ipoUntil !== null && now !== null && now < ipoUntil) return 'ipo';
  return 'active';
}

/** Companies whose IPO window is open now, by the floor's rule (live status before the REST view's). */
export function openIpoCount(
  views: Readonly<Record<string, CompanyView>>,
  live: Readonly<Record<string, MarketEntry>>,
  now: number | null,
): number {
  if (now === null) return 0;
  return Object.values(views).filter(
    (v) => displayStatus(live[v.ticker]?.status ?? v.status, v.ipoUntil, now) === 'ipo',
  ).length;
}

export function portraitStatus(d: DisplayStatus): PortraitStatus {
  if (d === 'delisted' || d === 'bankrupt') return 'bankrupt';
  if (d === 'halted') return 'halted';
  if (d === 'ipo') return 'ipo';
  return 'active';
}

export function hypeOf(mult: number | null | undefined): number | null {
  const m = finite(mult);
  return m === null ? null : m - 1;
}

export function toDisplay(
  entry: MarketEntry | null | undefined,
  view: CompanyView | null | undefined,
  series: Series | undefined,
  now: number | null,
): DisplayCompany | null {
  const base = entry ?? view;
  if (!base) return null;
  const status = entry?.status ?? view?.status ?? 'ACTIVE';
  const ipoUntil = view?.ipoUntil ?? null;
  const end = now ?? series?.t[series.t.length - 1] ?? 0;
  const spark = lastMinutes(series, end, 60);
  const positions = view?.positions ?? [];
  return {
    id: base.id,
    ticker: base.ticker,
    name: view?.name ?? base.ticker,
    rating: view?.rating ?? null,
    style: view?.prospectus?.style ?? null,
    status,
    display: displayStatus(status, ipoUntil, now),
    nav: finite(entry?.nav ?? view?.nav),
    price: finite(entry?.price ?? view?.price),
    hype: hypeOf(entry?.mult ?? view?.mult),
    hp: finite(entry?.hp ?? view?.hp),
    haltReason: view?.haltReason ?? null,
    listedAt: view?.listedAt ?? null,
    ipoUntil,
    lastSnapshotAt: view?.lastSnapshotAt ?? null,
    positions,
    headline: headline(positions),
    navChg1h: change(spark.nav),
    priceChg1h: change(spark.price),
    spark,
  };
}
