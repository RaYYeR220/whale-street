import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { settleCompany, settleHolding } from '../src/index';

describe('settlement', () => {
  it('pays longs at price and returns short collateral minus buy-back', () => {
    expect(settleHolding({ longQty: 10, longCost: 900, shortQty: 0, shortCollateral: 0 }, 5)).toBe(
      50,
    );
    expect(
      settleHolding({ longQty: 0, longCost: 0, shortQty: 10, shortCollateral: 2_000 }, 20),
    ).toBe(1_800);
  });

  it('never returns negative cash for a blown short', () => {
    expect(settleHolding({ longQty: 0, longCost: 0, shortQty: 10, shortCollateral: 100 }, 50)).toBe(
      0,
    );
  });

  it('settleCompany sums to the per-holding values', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            longQty: fc.double({ min: 0, max: 1_000, noNaN: true }),
            shortQty: fc.double({ min: 0, max: 1_000, noNaN: true }),
            shortCollateral: fc.double({ min: 0, max: 100_000, noNaN: true }),
          }),
          { maxLength: 30 },
        ),
        fc.double({ min: 0, max: 1_000, noNaN: true }),
        (hs, price) => {
          const entries = hs.map((h, i) => ({ playerId: `p${i}`, holding: { ...h, longCost: 0 } }));
          const lines = settleCompany(entries, price);
          expect(lines).toHaveLength(entries.length);
          const total = lines.reduce((a, l) => a + l.cashDelta, 0);
          const expected = entries.reduce((a, e) => a + settleHolding(e.holding, price), 0);
          expect(total).toBeCloseTo(expected, 6);
          for (const l of lines) expect(l.cashDelta).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});
