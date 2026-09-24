/**
 * Client-side preview of the Mirror policy, so the committee stamps react while the player edits
 * size, leverage and stop. Advisory only: the engine re-runs the same core policy on a fresh
 * snapshot at prepare and again before execute, and only its answer counts. The page blocks a
 * send only on what it knows for sure: the player's own inputs outside the fixed limits.
 */
import {
  evaluateMirror,
  type MirrorContext,
  type MirrorRefusal,
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

export const MIRROR = PARAMS.mirror;

/**
 * Usage as far as this player's order log shows. Open mirrors count at any age, like the engine;
 * the engine also counts other players on the same wallet, so it has the final say.
 */
export function mirrorUsage(
  orders: readonly MirrorOrderView[],
  now: number,
): { open: number; dailyUsd: number } {
  const placed = orders.filter((o) => o.kind === 'order');
  return {
    open: placed.filter((o) => OPEN_STATUSES.has(o.status)).length,
    dailyUsd: placed
      .filter((o) => o.createdAt > now - DAY_MS && PLACED_STATUSES.has(o.status))
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

/** Checks on the player's own inputs against fixed limits: the only refusals the page is sure of. */
export const INPUT_CHECKS: ReadonlySet<string> = new Set([
  'NOTIONAL_OUT_OF_RANGE',
  'LEVERAGE_CAP',
  'STOP_LOSS_TOO_LOOSE',
]);

export interface MirrorPreview {
  /** False only while the player's own inputs are out of range; everything else is the engine's call. */
  canSend: boolean;
  /** Input refusals: Send stays disabled until the player fixes them. */
  blocking: MirrorRefusal[];
  /** Refusals on market data and usage the engine re-reads at prepare: likely, never blocking. */
  advisory: MirrorRefusal[];
  /** Snapshot age when past the policy limit (the engine refreshes it at prepare), otherwise null. */
  staleMs: number | null;
}

export function previewMirror(req: MirrorRequest, ctx: MirrorContext): MirrorPreview {
  const d = evaluateMirror(req, ctx, PARAMS);
  const refusals = d.allow ? [] : d.refusals;
  const blocking = refusals.filter((r) => INPUT_CHECKS.has(r.code));
  return {
    canSend: blocking.length === 0,
    blocking,
    advisory: refusals.filter((r) => !INPUT_CHECKS.has(r.code) && r.code !== 'STALE_DATA'),
    staleMs: refusals.some((r) => r.code === 'STALE_DATA') ? ctx.snapshotAgeMs : null,
  };
}

/** "12s" under a minute and a half, "5 min" above, "unknown" when there is no usable age. */
export function ageText(ms: number): string {
  if (!(Number.isFinite(ms) && ms >= 0)) return 'unknown';
  return ms < 90_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`;
}

/** pass; fail blocks the send; warn: the engine will likely refuse; wait: the engine checks it at send. */
export type CheckState = 'pass' | 'fail' | 'warn' | 'wait';

/** The twelve checks as committee stamps: label, current value and state. */
export function checkRows(
  req: MirrorRequest,
  ctx: MirrorContext,
  preview: MirrorPreview,
  ticker: string,
): Array<{ code: string; label: string; value: string; state: CheckState }> {
  const failed = new Set<string>(preview.blocking.map((r) => r.code));
  const warned = new Set<string>(preview.advisory.map((r) => r.code));
  const pos = ctx.traderPosition;
  const mark = ctx.mark;
  const adverse =
    pos && mark && mark > 0
      ? pos.size > 0
        ? (mark - pos.entryPx) / pos.entryPx
        : (pos.entryPx - mark) / pos.entryPx
      : null;
  const allowedLev = pos ? Math.min(pos.leverage, MIRROR.maxLeverage) : MIRROR.maxLeverage;
  const sl = req.stopLossPct ?? MIRROR.defaultStopLossPct;
  const stale = preview.staleMs !== null;
  const rows: Array<[string, string, string]> = [
    ['COMPANY_NOT_ACTIVE', 'Trading open', `${ticker} ${ctx.companyStatus.toLowerCase()}`],
    [
      'STALE_DATA',
      'Fresh data',
      stale
        ? `snapshot ${ageText(ctx.snapshotAgeMs)} old, refreshed when you send`
        : `${ageText(ctx.snapshotAgeMs)}, max ${MIRROR.maxSnapshotAgeMs / 1000}s`,
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
  const stateOf = (code: string): CheckState => {
    if (failed.has(code)) return 'fail';
    if (warned.has(code)) return 'warn';
    return code === 'STALE_DATA' && stale ? 'wait' : 'pass';
  };
  return rows.map(([code, label, value]) => ({ code, label, value, state: stateOf(code) }));
}
