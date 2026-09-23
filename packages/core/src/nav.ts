import { PARAMS } from './params';
import type { Marks, Position, Snapshot } from './types';

/** Live unrealized PnL at the given marks; null if any needed mark is missing or invalid. */
export function unrealizedAt(positions: readonly Position[], marks: Marks): number | null {
  let total = 0;
  for (const p of positions) {
    const m = marks[p.coin];
    if (m === undefined || !Number.isFinite(m) || m <= 0) return null;
    total += p.size * (m - p.entryPx);
  }
  return total;
}

export function snapshotUnrealized(s: Snapshot): number {
  let total = 0;
  for (const p of s.positions) total += p.unrealizedPnl;
  return total;
}

export interface NavState {
  nav: number;
  /** C(t−1): realized since anchor + unrealized at the last step. */
  cumPnl: number;
  /** E(t−1): live equity estimate at the last step. */
  equity: number;
  snapshot: Snapshot;
  /** U_snap: reported unrealized PnL of the current snapshot. */
  uSnap: number;
}

export function initNav(snapshot: Snapshot, start: number = PARAMS.navStart): NavState {
  const uSnap = snapshotUnrealized(snapshot);
  return {
    nav: start,
    cumPnl: snapshot.realizedSinceAnchor + uSnap,
    equity: snapshot.accountValue,
    snapshot,
    uSnap,
  };
}

function stepNav(state: NavState, cum: number): number {
  if (!(state.equity > 0)) return state.nav;
  const r = (cum - state.cumPnl) / state.equity;
  return Math.max(0, state.nav * (1 + r));
}

/** Advance NAV to new marks with positions unchanged. Missing marks freeze the state. */
export function tickNav(state: NavState, marks: Marks): NavState {
  const u = unrealizedAt(state.snapshot.positions, marks);
  if (u === null) return state;
  const cum = state.snapshot.realizedSinceAnchor + u;
  return {
    ...state,
    nav: stepNav(state, cum),
    cumPnl: cum,
    equity: state.snapshot.accountValue + (u - state.uSnap),
  };
}

/** Swap in a new snapshot and apply the PnL jump since the last step as one NAV step. */
export function applySnapshot(state: NavState, snapshot: Snapshot, marks: Marks): NavState {
  const uSnap = snapshotUnrealized(snapshot);
  const u = unrealizedAt(snapshot.positions, marks) ?? uSnap;
  const cum = snapshot.realizedSinceAnchor + u;
  return {
    nav: stepNav(state, cum),
    cumPnl: cum,
    equity: snapshot.accountValue + (u - uSnap),
    snapshot,
    uSnap,
  };
}
