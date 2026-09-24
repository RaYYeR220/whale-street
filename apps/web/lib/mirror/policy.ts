/**
 * Client-side preview of the Mirror policy, so the committee stamps react while the player edits
 * size, leverage and stop. Advisory only: the engine re-runs the same core policy on a fresh
 * snapshot at prepare and again before execute, and only its answer counts.
 */
import {
  evaluateMirror,
  type MirrorContext,
  type MirrorDecision,
  type MirrorRequest,
  PARAMS,
} from '@whale-street/core';
import type { CompanyView, MirrorOrderView } from '../api-types';

const DAY_MS = 86_400_000;
/** Statuses that count as open mirrors (the engine may also discount coins the wallet is flat on). */
export const OPEN_STATUSES = new Set<MirrorOrderView['status']>([
  'SUBMITTED',
  'FILLED',
  'RESTING',
  'UNKNOWN',
]);
/** Attempts that reached (or may have reached) Hyperliquid count toward the daily cap. */
export const PLACED_STATUSES = new Set<MirrorOrderView['status']>([...OPEN_STATUSES, 'CLOSED']);

export function mirrorUsage(
  orders: readonly MirrorOrderView[],
  now: number,
): { open: number; dailyUsd: number } {
  const day = orders.filter((o) => o.kind === 'order' && o.createdAt > now - DAY_MS);
  return {
    open: day.filter((o) => OPEN_STATUSES.has(o.status)).length,
    dailyUsd: day
      .filter((o) => PLACED_STATUSES.has(o.status))
      .reduce((s, o) => s + o.notionalUsd, 0),
  };
}

export function previewContext(
  view: CompanyView,
  coin: string,
  now: number,
  usage: { open: number; dailyUsd: number },
): MirrorContext {
  const p = view.positions.find((x) => x.coin === coin) ?? null;
  return {
    companyStatus: view.status,
    snapshotAgeMs: now - view.lastSnapshotAt,
    // Only the engine knows which coins the Nansen Trading API routes; it refuses the rest.
    coinSupported: true,
    traderPosition: p,
    mark: p?.mark ?? null,
    hp: Number.isFinite(view.hp) ? view.hp : Number.NaN,
    playerOpenMirrors: usage.open,
    playerDailyNotionalUsd: usage.dailyUsd,
  };
}

export function previewMirror(req: MirrorRequest, ctx: MirrorContext): MirrorDecision {
  return evaluateMirror(req, ctx, PARAMS);
}

export const MIRROR = PARAMS.mirror;

/** The twelve checks as committee stamps: label, current value, failed or not. */
export function checkRows(
  req: MirrorRequest,
  ctx: MirrorContext,
  decision: MirrorDecision,
  ticker: string,
): Array<{ code: string; label: string; value: string; fail: boolean }> {
  const failed = new Set(decision.allow ? [] : decision.refusals.map((r) => r.code));
  const pos = ctx.traderPosition;
  const mark = ctx.mark;
  const adverse =
    pos && mark && mark > 0
      ? pos.size > 0
        ? (mark - pos.entryPx) / pos.entryPx
        : (pos.entryPx - mark) / pos.entryPx
      : null;
  const allowedLev = pos ? Math.min(pos.leverage, MIRROR.maxLeverage) : MIRROR.maxLeverage;
  const age = ctx.snapshotAgeMs;
  const sl = req.stopLossPct ?? MIRROR.defaultStopLossPct;
  const rows: Array<[string, string, string]> = [
    ['COMPANY_NOT_ACTIVE', 'Trading open', `${ticker} ${ctx.companyStatus.toLowerCase()}`],
    [
      'STALE_DATA',
      'Fresh data',
      `${Number.isFinite(age) ? (age < 90_000 ? `${Math.round(age / 1000)}s` : `${Math.round(age / 60_000)} min`) : 'unknown'}, max ${MIRROR.maxSnapshotAgeMs / 1000}s`,
    ],
    ['COIN_UNSUPPORTED', 'Coin routable', `${req.coin} via Nansen`],
    [
      'NO_POSITION',
      'Trader holds it',
      pos ? `${pos.size > 0 ? 'Long' : 'Short'} ${req.coin}` : `No ${req.coin}`,
    ],
    ['NO_MARK', 'Live price', mark ? String(mark) : 'none'],
    [
      'NOTIONAL_OUT_OF_RANGE',
      'Order size',
      `$${req.notionalUsd || 0} of $${MIRROR.minNotionalUsd}–${MIRROR.maxNotionalUsd}`,
    ],
    ['TOO_MANY_OPEN', 'Open mirrors', `${ctx.playerOpenMirrors} of ${MIRROR.maxOpen}`],
    [
      'DAILY_CAP',
      'Daily cap',
      `$${ctx.playerDailyNotionalUsd + (req.notionalUsd || 0)} of $${MIRROR.dailyCapUsd}`,
    ],
    ['LEVERAGE_CAP', 'Leverage', `${req.leverage}x, cap ${allowedLev}x`],
    [
      'STOP_LOSS_TOO_LOOSE',
      'Stop-loss',
      `${Math.round(sl * 100)}%, max ${Math.round(MIRROR.maxStopLossPct * 100)}%`,
    ],
    [
      'NEAR_LIQUIDATION',
      'Trader HP',
      `${Number.isFinite(ctx.hp) ? Math.round(ctx.hp * 100) : '—'}%, min ${Math.round(MIRROR.minHp * 100)}%`,
    ],
    [
      'ANTI_FOMO',
      'Entry vs trader',
      adverse === null
        ? 'no entry'
        : `${adverse >= 0 ? '+' : '−'}${Math.abs(adverse * 100).toFixed(1)}%, max ${Math.round(MIRROR.antiFomoPct * 100)}%`,
    ],
  ];
  return rows.map(([code, label, value]) => ({
    code,
    label,
    value,
    fail: failed.has(code as never),
  }));
}
