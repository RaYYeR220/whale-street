import type { NavState, OrderSide, Snapshot } from '@whale-street/core';

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
export type MirrorStatus = 'REFUSED' | 'PREPARED' | 'SUBMITTED' | 'FILLED' | 'RESTING' | 'REJECTED';

/** Persisted NAV state of a company (companies.nav_state_json). */
export interface NavPersist {
  state: NavState;
  /** Nansen pnl-summary realized-minus-fees since anchorDate, captured at listing (null if unavailable). */
  summaryBaseline: number | null;
  /** Snapshot the company was listed on; REPLAY restarts re-initialize NAV from it. */
  firstSnapshot: Snapshot;
}
