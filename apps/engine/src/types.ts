import type { MirrorRefusalCode, NavState, OrderSide, Snapshot } from '@whale-street/core';

/** How a company got listed. SEEDED = loaded from a REPLAY session (no committee run). */
export type CompanySource = 'SCOUT' | 'IPO_DESK' | 'SEEDED';

/** `data` halts resume on the next good snapshot; `equity` halts resume once equity recovers. */
export type HaltKind = 'data' | 'equity';

export type PlayerKind = 'human' | 'bot' | 'agent';

/** Ledger side of a trades row; SETTLE rows come from bankruptcy and season-end settlement. */
export type TradeSide = OrderSide | 'SETTLE';

export type SeasonStatus = 'ACTIVE' | 'CLOSED';

export type IpoStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'DEFERRED';

export type MirrorKind = 'leverage' | 'order';
/**
 * UNKNOWN = execute sent but the outcome is not definitive (timeout, network error, 5xx, an
 * unparseable 2xx): the order may have reached Hyperliquid. Counts toward the caps like a fill.
 * CLOSED = a FILLED order whose coin later showed no position on the master wallet: it no longer
 * counts as open, but its notional still counts toward the daily cap.
 */
export type MirrorStatus =
  | 'REFUSED'
  | 'PREPARED'
  | 'SUBMITTED'
  | 'FILLED'
  | 'RESTING'
  | 'REJECTED'
  | 'UNKNOWN'
  | 'CLOSED';

/**
 * A reason stored with a mirror attempt (mirror_orders.refusals_json): a core policy refusal, or
 * an engine-side one — the size rounds below the minimum, the policy changed before execute, or
 * trading is unavailable (region block).
 */
export interface MirrorReason {
  code: MirrorRefusalCode | 'BELOW_MIN_SIZE' | 'POLICY_CHANGED' | 'TRADING_UNAVAILABLE';
  message: string;
}

/** Persisted NAV state of a company (companies.nav_state_json). */
export interface NavPersist {
  state: NavState;
  /** Nansen pnl-summary realized-minus-fees since anchorDate, captured at listing (null if unavailable). */
  summaryBaseline: number | null;
  /** Snapshot the company was listed on; REPLAY restarts re-initialize NAV from it. */
  firstSnapshot: Snapshot;
}
