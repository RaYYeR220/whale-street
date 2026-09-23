import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applySnapshot,
  initNav,
  type Position,
  type Snapshot,
  tickNav,
  unrealizedAt,
} from '../src/index';

const ADDR = '0x00000000000000000000000000000000000000aa' as const;

function pos(p: Partial<Position> & { coin: string; size: number; entryPx: number }): Position {
  return { liqPx: null, leverage: 1, marginUsed: 0, unrealizedPnl: 0, ...p };
}

function snap(p: Partial<Snapshot>): Snapshot {
  return {
    address: ADDR,
    positions: [],
    accountValue: 1_000,
    realizedSinceAnchor: 0,
    fetchedAt: 0,
    provenance: [],
    ...p,
  };
}

describe('nav', () => {
  it('starts at 100', () => {
    expect(initNav(snap({})).nav).toBe(100);
  });

  it('moves with unrealized PnL relative to equity', () => {
    const s0 = snap({ positions: [pos({ coin: 'BTC', size: 1, entryPx: 100 })] });
    let st = initNav(s0);
    st = tickNav(st, { BTC: 110 }); // +10 on 1000 equity = +1%
    expect(st.nav).toBeCloseTo(101, 10);
    expect(st.equity).toBeCloseTo(1_010, 10);
    st = tickNav(st, { BTC: 121 }); // +11 on 1010 equity
    expect(st.nav).toBeCloseTo(101 * (1 + 11 / 1_010), 10);
  });

  it('short positions gain when price falls', () => {
    const st = tickNav(
      initNav(snap({ positions: [pos({ coin: 'ETH', size: -2, entryPx: 50 })] })),
      {
        ETH: 45,
      },
    );
    expect(st.nav).toBeCloseTo(101, 10); // +10 on 1000
  });

  it('freezes when a mark is missing', () => {
    const st0 = initNav(snap({ positions: [pos({ coin: 'BTC', size: 1, entryPx: 100 })] }));
    expect(tickNav(st0, {})).toBe(st0);
  });

  it('closing a position at the current mark keeps NAV continuous', () => {
    const open = snap({ positions: [pos({ coin: 'BTC', size: 1, entryPx: 100 })] });
    let st = tickNav(initNav(open), { BTC: 110 });
    const before = st.nav;
    const closed = snap({ positions: [], realizedSinceAnchor: 10, accountValue: 1_010 });
    st = applySnapshot(st, closed, { BTC: 110 });
    expect(st.nav).toBeCloseTo(before, 10);
  });

  it('a deposit or withdrawal never moves NAV (flow-neutral)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -500, max: 5_000, noNaN: true }), {
          minLength: 1,
          maxLength: 20,
        }),
        (flows) => {
          // Reported uPnL (5) equals live uPnL at mark 110 (0.5 · 10), so only flows vary.
          const positions = [pos({ coin: 'BTC', size: 0.5, entryPx: 100, unrealizedPnl: 5 })];
          let equity = 2_000;
          let st = initNav(snap({ positions, accountValue: equity }));
          for (const f of flows) {
            equity = Math.max(100, equity + f);
            st = applySnapshot(st, snap({ positions, accountValue: equity }), { BTC: 110 });
            expect(st.equity).toBeCloseTo(equity, 8);
          }
          expect(st.nav).toBeCloseTo(100, 10);
        },
      ),
    );
  });

  it('a liquidation loss drops NAV by the realized loss over equity', () => {
    const open = snap({
      positions: [pos({ coin: 'SOL', size: 10, entryPx: 100, liqPx: 91 })],
      accountValue: 100,
    });
    let st = initNav(open);
    st = tickNav(st, { SOL: 95 }); // -50 on 100 equity
    expect(st.nav).toBeCloseTo(50, 10);
    const liquidated = snap({ positions: [], realizedSinceAnchor: -90, accountValue: 10 });
    st = applySnapshot(st, liquidated, { SOL: 91 }); // cum -90 vs -50, equity 50 => -80%
    expect(st.nav).toBeCloseTo(50 * (1 - 40 / 50), 8);
  });

  it('never goes negative', () => {
    const st = tickNav(
      initNav(snap({ positions: [pos({ coin: 'X', size: 100, entryPx: 10 })], accountValue: 10 })),
      { X: 1 },
    );
    expect(st.nav).toBe(0);
  });

  it('freezes NAV when equity is zero or negative', () => {
    // Zero equity case
    const st0 = initNav(
      snap({ positions: [pos({ coin: 'BTC', size: 1, entryPx: 100 })], accountValue: 0 }),
    );
    expect(st0.nav).toBe(100);
    const st0Tick = tickNav(st0, { BTC: 150 });
    expect(st0Tick.nav).toBe(100); // NAV unchanged
    expect(st0Tick.cumPnl).toBe(50); // but cumPnl updated

    // Negative equity case
    const stNeg = initNav(
      snap({ positions: [pos({ coin: 'BTC', size: 1, entryPx: 100 })], accountValue: -10 }),
    );
    expect(stNeg.nav).toBe(100);
    const stNegTick = tickNav(stNeg, { BTC: 150 });
    expect(stNegTick.nav).toBe(100); // NAV unchanged
    expect(stNegTick.cumPnl).toBe(50); // but cumPnl updated
  });

  it('applySnapshot uses fallback uSnap when mark is missing', () => {
    // Initial state with open position
    const open = snap({
      positions: [pos({ coin: 'BTC', size: 1, entryPx: 100, unrealizedPnl: 15 })],
      accountValue: 1_000,
    });
    let st = initNav(open);
    st = tickNav(st, { BTC: 115 }); // +15 on 1000

    // New snapshot: still open but no mark available
    const nextSnap = snap({
      positions: [pos({ coin: 'BTC', size: 1, entryPx: 100, unrealizedPnl: 25 })],
      realizedSinceAnchor: 0,
      accountValue: 1_000,
    });
    const prevCumPnl = st.cumPnl;
    const prevEquity = st.equity;
    st = applySnapshot(st, nextSnap, {}); // BTC mark missing, uses reported uPnL

    expect(st.cumPnl).toBe(25); // realizedSinceAnchor (0) + reported unrealizedPnl (25)
    const deltaCum = st.cumPnl - prevCumPnl;
    const expectedNav = 100 * (1 + deltaCum / prevEquity);
    expect(st.nav).toBeCloseTo(expectedNav, 10);
  });

  it('unrealizedAt returns null for non-positive or non-finite marks', () => {
    const positions = [pos({ coin: 'BTC', size: 1, entryPx: 100 })];

    // Zero mark
    expect(unrealizedAt(positions, { BTC: 0 })).toBeNull();

    // NaN mark
    expect(unrealizedAt(positions, { BTC: Number.NaN })).toBeNull();

    // Negative mark
    expect(unrealizedAt(positions, { BTC: -50 })).toBeNull();

    // Infinity mark
    expect(unrealizedAt(positions, { BTC: Infinity })).toBeNull();
  });

  it('unrealizedAt returns null when a position has a non-finite size or an invalid entryPx', () => {
    const marks = { BTC: 110 };
    expect(unrealizedAt([pos({ coin: 'BTC', size: Number.NaN, entryPx: 100 })], marks)).toBeNull();
    expect(
      unrealizedAt([pos({ coin: 'BTC', size: Number.POSITIVE_INFINITY, entryPx: 100 })], marks),
    ).toBeNull();
    expect(unrealizedAt([pos({ coin: 'BTC', size: 1, entryPx: Number.NaN })], marks)).toBeNull();
    expect(unrealizedAt([pos({ coin: 'BTC', size: 1, entryPx: 0 })], marks)).toBeNull();
    expect(unrealizedAt([pos({ coin: 'BTC', size: 1, entryPx: -5 })], marks)).toBeNull();
  });

  it('applySnapshot ignores a snapshot with a NaN realizedSinceAnchor and recovers on the next clean one', () => {
    const open = snap({ positions: [pos({ coin: 'BTC', size: 1, entryPx: 100 })] });
    let st = tickNav(initNav(open), { BTC: 110 }); // +10 on 1000 => nav 101
    const before = st;

    const poisoned = snap({
      positions: [pos({ coin: 'BTC', size: 1, entryPx: 100 })],
      realizedSinceAnchor: Number.NaN,
      accountValue: 1_010,
    });
    st = applySnapshot(st, poisoned, { BTC: 110 });
    expect(st).toBe(before); // untouched: old snapshot kept

    const clean = snap({ positions: [], realizedSinceAnchor: 10, accountValue: 1_010 });
    st = applySnapshot(st, clean, { BTC: 110 });
    expect(Number.isFinite(st.nav)).toBe(true);
    expect(st.nav).toBeCloseTo(before.nav, 10);
  });

  it('applySnapshot ignores a snapshot with a non-finite unrealizedPnl field and recovers on the next clean one', () => {
    const open = snap({ positions: [pos({ coin: 'BTC', size: 1, entryPx: 100 })] });
    let st = tickNav(initNav(open), { BTC: 110 });
    const before = st;

    const poisoned = snap({
      positions: [pos({ coin: 'BTC', size: 1, entryPx: 100, unrealizedPnl: Number.NaN })],
      accountValue: 1_010,
    });
    st = applySnapshot(st, poisoned, { BTC: 110 });
    expect(st).toBe(before);

    const clean = snap({
      positions: [pos({ coin: 'BTC', size: 1, entryPx: 100, unrealizedPnl: 10 })],
      accountValue: 1_010,
    });
    st = applySnapshot(st, clean, { BTC: 110 });
    expect(Number.isFinite(st.nav)).toBe(true);
    expect(st.nav).toBeCloseTo(before.nav, 10);
  });

  it('applySnapshot ignores a snapshot with an invalid entryPx and recovers on the next clean one', () => {
    const open = snap({ positions: [pos({ coin: 'BTC', size: 1, entryPx: 100 })] });
    let st = tickNav(initNav(open), { BTC: 110 });
    const before = st;

    const poisoned = snap({
      positions: [pos({ coin: 'BTC', size: 1, entryPx: Number.NaN })],
      accountValue: 1_010,
    });
    st = applySnapshot(st, poisoned, { BTC: 110 });
    expect(st).toBe(before);

    const clean = snap({ positions: [], realizedSinceAnchor: 10, accountValue: 1_010 });
    st = applySnapshot(st, clean, { BTC: 110 });
    expect(Number.isFinite(st.nav)).toBe(true);
    expect(st.nav).toBeCloseTo(before.nav, 10);
  });

  it('a deposit or withdrawal never moves NAV even when the mark has moved since the last flow (flow-neutral)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            isFlow: fc.boolean(),
            amount: fc.double({ min: -500, max: 5_000, noNaN: true }),
            mark: fc.double({ min: 80, max: 130, noNaN: true }),
            reportedU: fc.double({ min: -20, max: 20, noNaN: true }),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (steps) => {
          const base = pos({ coin: 'BTC', size: 0.5, entryPx: 100, unrealizedPnl: 5 });
          let equity = 2_000;
          let lastMark = 110;
          let st = initNav(snap({ positions: [base], accountValue: equity }));
          for (const step of steps) {
            if (step.isFlow) {
              const before = st.nav;
              equity = Math.max(100, equity + step.amount);
              const flowPositions = [{ ...base, unrealizedPnl: step.reportedU }];
              st = applySnapshot(st, snap({ positions: flowPositions, accountValue: equity }), {
                BTC: lastMark,
              });
              expect(st.nav).toBeCloseTo(before, 10);
            } else {
              lastMark = step.mark;
              st = tickNav(st, { BTC: lastMark });
            }
            expect(Number.isFinite(st.nav)).toBe(true);
          }
        },
      ),
    );
  });

  it('tickNav freezes when the computed cum/equity is non-finite', () => {
    const huge = snap({ positions: [pos({ coin: 'BTC', size: Number.MAX_VALUE, entryPx: 100 })] });
    const st0 = initNav(huge);
    expect(tickNav(st0, { BTC: 110 })).toBe(st0);
  });
});
