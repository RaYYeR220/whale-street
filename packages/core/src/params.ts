/** Default tunables. Values mirror the design spec; every function takes a params override. */
const PARAMS_MUTABLE = {
  navStart: 100,
  poolDepth: 5_000,
  minReserveFrac: 0.05,
  feeRate: 0.003,
  hypeTauMs: 6 * 60 * 60 * 1000,
  shortCollateralMultiple: 2,
  autoCoverAt: 0.95,
  seasonStartCash: 10_000,
  seasonLengthMs: 7 * 24 * 60 * 60 * 1000,
  ipoWindowMs: 60_000,
  ipoCapFrac: 0.1,
  minEquityHaltUsd: 1_000,
  triggerStaleMs: 120_000,
  staleHaltMs: 1_800_000,
  bankruptcyEquityFrac: 0.2,
  marginCallHp: 0.1,
  hpCritical: 0.15,
  committee: {
    minHistoryDays: 30,
    minClosedTrades: 20,
    minEquityUsd: 25_000,
    maxTradesPerDay: 500,
    minAvgHoldMinutes: 5,
    hedgeOffsetThreshold: 0.5,
    concentrationThreshold: 0.6,
    concentrationNotches: 2,
    cooldownDays: 14,
    /** scoreToRating cutoffs; CCC is the implicit catch-all below B. */
    ratingThresholds: { AAA: 85, AA: 75, A: 65, BBB: 55, BB: 45, B: 35 },
    /** Prospectus style cutoffs, in average-hold minutes. */
    styleMinutes: { scalper: 60, dayTrader: 1_440, swingTrader: 10_080 },
    /** Prospectus realized-PnL band edges, in USD. */
    pnlBands: { under10k: 10_000, under100k: 100_000, under1m: 1_000_000, under10m: 10_000_000 },
  },
  mirror: {
    minNotionalUsd: 10,
    maxNotionalUsd: 100,
    maxOpen: 3,
    dailyCapUsd: 300,
    maxLeverage: 5,
    defaultStopLossPct: 0.25,
    maxStopLossPct: 0.5,
    minHp: 0.15,
    antiFomoPct: 0.05,
    maxSnapshotAgeMs: 60_000,
  },
};

type DeepReadonly<T> = { readonly [K in keyof T]: DeepReadonly<T[K]> };

function deepFreeze<T>(o: T): DeepReadonly<T> {
  for (const value of Object.values(o as Record<string, unknown>)) {
    if (value !== null && typeof value === 'object') deepFreeze(value);
  }
  return Object.freeze(o) as DeepReadonly<T>;
}

export const PARAMS = deepFreeze(PARAMS_MUTABLE);

export type Params = typeof PARAMS;
