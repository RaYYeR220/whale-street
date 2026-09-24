import {
  applySnapshot,
  computeHp,
  diffSnapshots,
  type Filing,
  isSaneSnapshot,
  PARAMS,
  type Params,
  type Snapshot,
} from '@whale-street/core';
import type { HlInfo } from '@whale-street/hl';
import type { Clock } from '../clock';
import { utcDate } from '../dates';
import type { Logger } from '../log';
import { isMissingMarkHalt } from '../market/loop';
import type { CompanyRuntime, MarketState } from '../market/state';
import type { StatusOps } from '../market/status';
import type { NansenPort } from '../ports';
import { type BankruptcyService, isSettlementPendingHalt } from '../services/bankruptcy';
import type { FilingService } from '../services/filings';
import { fetchPositions } from './positions';

export type RefreshReason = 'heartbeat' | 'trigger' | 'wake' | 'mirror' | 'listing';

export type RefreshOutcome =
  | { kind: 'ok' }
  | { kind: 'failed'; error: string }
  | { kind: 'skipped'; why: string };

export interface RefreshDeps {
  state: MarketState;
  filings: FilingService;
  statusOps: StatusOps;
  bankruptcy: BankruptcyService;
  nansen: NansenPort;
  info: HlInfo;
  clock: Clock;
  log: Logger;
  params?: Params;
}

export interface Refresher {
  refresh(id: string, reason: RefreshReason): Promise<RefreshOutcome>;
  /** Promises of refreshes currently in flight (tests and shutdown await them). */
  pending(): Promise<RefreshOutcome>[];
}

/** Reasons allowed to call Nansen while the engine is IDLE. */
const IDLE_ALLOWED: ReadonlySet<RefreshReason> = new Set(['mirror', 'listing', 'wake']);
/**
 * Routine refreshes: the only ones credit-saver moves to Hyperliquid. The Mirror's fresh snapshot
 * (and a listing) keeps Nansen as its source whatever the credit mode.
 */
const ROUTINE: ReadonlySet<RefreshReason> = new Set(['heartbeat', 'trigger', 'wake']);

/** Realized-PnL drift that triggers a RESTATEMENT: max($50, 0.5% of equity). */
export const restatementThreshold = (equity: number): number =>
  Math.max(50, 0.005 * Math.abs(equity));

const listed = (rt: CompanyRuntime): boolean =>
  rt.status !== 'BANKRUPT' && rt.status !== 'DELISTED';

export function createRefresher(d: RefreshDeps): Refresher {
  const params = d.params ?? PARAMS;
  /** One refresh per company at a time; `viaHl` = served by Hyperliquid (credit-saver). */
  const inflight = new Map<string, { p: Promise<RefreshOutcome>; viaHl: boolean }>();

  async function run(
    rt: CompanyRuntime,
    reason: RefreshReason,
    viaHl: boolean,
  ): Promise<RefreshOutcome> {
    // A refresh queued behind another one may find the company gone by the time it starts.
    if (!listed(rt)) return { kind: 'skipped', why: 'not listed' };
    const res = await fetchPositions(rt.id, { nansen: d.nansen, info: d.info, creditSaver: viaHl });
    if (!res.ok) {
      d.log.warn('refresh failed', { company: rt.ticker, reason, error: res.error });
      return { kind: 'failed', error: res.error };
    }
    if (!listed(rt)) return { kind: 'skipped', why: 'not listed' };

    const now = d.clock.now();
    const prev = rt.nav.snapshot;
    const probe: Snapshot = {
      address: rt.id,
      positions: res.value.positions,
      accountValue: res.value.accountValue,
      realizedSinceAnchor: prev.realizedSinceAnchor,
      fetchedAt: now,
      provenance: res.value.provenance,
    };
    if (!isSaneSnapshot(probe)) {
      d.log.warn('refresh rejected: snapshot failed sanity checks', { company: rt.ticker, reason });
      return { kind: 'failed', error: 'snapshot failed sanity checks' };
    }
    const diff = diffSnapshots(prev, probe, d.state.marks, params);
    let realized = prev.realizedSinceAnchor;
    for (const f of diff.filings) realized += f.realizedPnlUsd ?? 0;
    const provenance = [...res.value.provenance];
    let restatement: Filing | null = null;

    if (reason === 'heartbeat') {
      const s = await d.nansen.perpPnlSummary(rt.id, rt.anchorDate, utcDate(now));
      if (s.ok) {
        provenance.push(s.callId);
        const nansenRealized = s.value.realizedPnlUsd - s.value.feesUsd;
        if (rt.summaryBaseline === null) {
          rt.summaryBaseline = nansenRealized - realized;
        } else {
          const reconciled = nansenRealized - rt.summaryBaseline;
          const drift = reconciled - realized;
          if (Math.abs(drift) > restatementThreshold(res.value.accountValue)) {
            restatement = {
              kind: 'RESTATEMENT',
              at: now,
              provenance: [s.callId],
              realizedPnlUsd: drift,
              detail: `realized PnL since listing restated from $${realized.toFixed(2)} (fills) to $${reconciled.toFixed(2)} (Nansen perp-pnl-summary)`,
            };
            realized = reconciled;
          }
        }
      } else {
        d.log.warn('pnl summary failed; keeping provisional realized PnL', {
          company: rt.ticker,
          error: s.error,
        });
      }
    }

    const next: Snapshot = { ...probe, realizedSinceAnchor: realized, provenance };
    for (const f of diff.filings) d.filings.record(rt.id, { ...f, provenance });
    if (restatement) d.filings.record(rt.id, restatement);
    rt.nav = applySnapshot(rt.nav, next, d.state.marks);
    rt.hp = computeHp(next.positions, d.state.marks);
    rt.lastSnapshotAt = now;
    rt.pendingTriggerAt = null;

    // A settlement that failed earlier is retried here (the liquidation is not in this diff); a
    // persisted settlement-pending halt keeps retrying even after a restart loses `unsettled`.
    if (
      (diff.bankrupt || d.bankruptcy.pending(rt.id) || isSettlementPendingHalt(rt)) &&
      d.bankruptcy.declare(rt, now)
    )
      return { kind: 'ok' };
    // A missing-mark halt is lifted by the market loop once the mark returns, not by a snapshot.
    // A settlement-pending halt is lifted only by the successful retried declare, just above.
    if (
      rt.status === 'HALTED' &&
      rt.haltKind === 'data' &&
      !isMissingMarkHalt(rt) &&
      !isSettlementPendingHalt(rt)
    )
      d.statusOps.resume(rt, now, 'fresh snapshot received');
    if (next.accountValue < params.minEquityHaltUsd) {
      d.statusOps.halt(rt, 'equity', 'equity below $1,000', now);
    } else if (rt.status === 'HALTED' && rt.haltKind === 'equity') {
      d.statusOps.resume(rt, now, 'equity recovered');
    }
    d.statusOps.persist(rt);
    return { kind: 'ok' };
  }

  return {
    refresh(id, reason) {
      const rt = d.state.get(id);
      if (!rt) return Promise.resolve({ kind: 'skipped', why: 'unknown company' });
      if (rt.status === 'BANKRUPT' || rt.status === 'DELISTED') {
        return Promise.resolve({ kind: 'skipped', why: 'not listed' });
      }
      if (d.state.flags.idle && !IDLE_ALLOWED.has(reason))
        return Promise.resolve({ kind: 'skipped', why: 'idle' });
      const viaHl = d.state.flags.creditSaver && ROUTINE.has(reason);
      const existing = inflight.get(rt.id);
      // Nansen data serves every reason; a refresh that needs Nansen never rides on a
      // Hyperliquid one (no silent source switch): it runs its own fetch right after it.
      if (existing && (viaHl || !existing.viaHl)) return existing.p;
      const start = existing
        ? existing.p.then(() => run(rt, reason, viaHl))
        : run(rt, reason, viaHl);
      const p: Promise<RefreshOutcome> = start
        .catch((err: unknown): RefreshOutcome => ({ kind: 'failed', error: String(err) }))
        .finally(() => {
          if (inflight.get(rt.id)?.p === p) inflight.delete(rt.id);
        });
      inflight.set(rt.id, { p, viaHl });
      return p;
    },
    pending: () => [...inflight.values()].map((f) => f.p),
  };
}
