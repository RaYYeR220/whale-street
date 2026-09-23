import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createPool,
  decayPool,
  multiplier,
  PARAMS,
  qtyForCash,
  quoteBuy,
  quoteSell,
  sharePrice,
} from '../src/index';

describe('amm', () => {
  it('starts at multiplier 1 and price = NAV', () => {
    const p = createPool();
    expect(multiplier(p)).toBe(1);
    expect(sharePrice(123, p)).toBe(123);
  });

  it('buy cost matches the formula', () => {
    const p = createPool(1_000);
    const q = quoteBuy(p, 100, 50);
    if (!q.ok) throw new Error(q.error);
    const y2 = (1_000 * 1_000) / 900;
    expect(q.cash).toBeCloseTo(50 * (y2 - 1_000) * (1 + PARAMS.feeRate), 8);
    expect(q.pool.x).toBe(900);
    expect(multiplier(q.pool)).toBeGreaterThan(1);
  });

  it('rejects bad input and draining below the reserve floor', () => {
    const p = createPool(1_000);
    expect(quoteBuy(p, 0, 10)).toEqual({ ok: false, error: 'INVALID_QTY' });
    expect(quoteBuy(p, 1, 0)).toEqual({ ok: false, error: 'INVALID_NAV' });
    expect(quoteBuy(p, 951, 10)).toEqual({ ok: false, error: 'INSUFFICIENT_LIQUIDITY' });
    expect(quoteSell(p, Number.NaN, 10)).toEqual({ ok: false, error: 'INVALID_QTY' });
  });

  it('round trip never profits and restores the pool', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 4_000, noNaN: true }),
        fc.double({ min: 0.01, max: 10_000, noNaN: true }),
        (qty, nav) => {
          const p = createPool();
          const b = quoteBuy(p, qty, nav);
          if (!b.ok) return true;
          const s = quoteSell(b.pool, qty, nav);
          if (!s.ok) throw new Error(s.error);
          expect(s.cash).toBeLessThan(b.cash);
          expect(s.pool.x).toBeCloseTo(p.x, 6);
          expect(s.pool.y).toBeCloseTo(p.y, 6);
          return true;
        },
      ),
    );
  });

  it('price is monotone in buys and sells', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.01, max: 1_000, noNaN: true }), (qty) => {
        const p = createPool();
        const b = quoteBuy(p, qty, 10);
        const s = quoteSell(p, qty, 10);
        if (!b.ok || !s.ok) throw new Error('quote failed');
        expect(multiplier(b.pool)).toBeGreaterThan(multiplier(p));
        expect(multiplier(s.pool)).toBeLessThan(multiplier(p));
      }),
    );
  });

  it('qtyForCash buys at most the given cash', () => {
    fc.assert(
      fc.property(fc.double({ min: 1, max: 1_000_000, noNaN: true }), (cash) => {
        const p = createPool();
        const q = qtyForCash(p, cash, 100);
        expect(q).toBeGreaterThan(0);
        const b = quoteBuy(p, q, 100);
        if (!b.ok) throw new Error(b.error);
        expect(b.cash).toBeLessThanOrEqual(cash * (1 + 1e-9) + 1e-9);
      }),
    );
  });

  it('decay pulls the multiplier toward 1 without crossing it', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.05, max: 20, noNaN: true }),
        fc.integer({ min: 1, max: 48 * 3_600_000 }),
        (mu, dt) => {
          const p = { x: 1_000, y: 1_000 * mu, l0: 5_000 };
          const d = decayPool(p, dt);
          const before = multiplier(p) - 1;
          const after = multiplier(d) - 1;
          expect(Math.abs(after)).toBeLessThanOrEqual(Math.abs(before) + 1e-12);
          if (before !== 0)
            expect(Math.sign(after) === Math.sign(before) || after === 0).toBe(true);
        },
      ),
    );
    const half = decayPool({ x: 100, y: 300, l0: 100 }, PARAMS.hypeTauMs * Math.LN2);
    expect(multiplier(half)).toBeCloseTo(2, 10);
  });
});
