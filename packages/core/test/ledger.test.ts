import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createPool,
  type ExecContext,
  executeOrder,
  needsAutoCover,
  netWorth,
  newPortfolio,
  PARAMS,
  quoteBuy,
  sharePrice,
} from '../src/index';

const CTX: ExecContext = { status: 'ACTIVE', nav: 100 };
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
};

describe('ledger', () => {
  it('BUY debits cash, credits shares and cost basis', () => {
    const r = ok(
      executeOrder(newPortfolio(), createPool(), { companyId: 'c1', side: 'BUY', qty: 10 }, CTX),
    );
    const h = r.portfolio.holdings.c1;
    expect(h?.longQty).toBe(10);
    expect(r.portfolio.cash).toBeCloseTo(PARAMS.seasonStartCash - r.fill.cash, 8);
    expect(h?.longCost).toBeCloseTo(r.fill.cash, 8);
    expect(r.fill.multiplierAfter).toBeGreaterThan(r.fill.multiplierBefore);
  });

  it('rejects non-ACTIVE companies, bad qty, insufficient cash, IPO cap', () => {
    const pf = newPortfolio(100);
    const pool = createPool();
    expect(
      executeOrder(pf, pool, { companyId: 'c', side: 'BUY', qty: 1 }, { ...CTX, status: 'HALTED' }),
    ).toEqual({ ok: false, reason: 'COMPANY_NOT_TRADING' });
    expect(executeOrder(pf, pool, { companyId: 'c', side: 'BUY', qty: -1 }, CTX)).toEqual({
      ok: false,
      reason: 'INVALID_QTY',
    });
    expect(executeOrder(pf, pool, { companyId: 'c', side: 'BUY', qty: 5 }, CTX)).toEqual({
      ok: false,
      reason: 'INSUFFICIENT_CASH',
    });
    expect(
      executeOrder(
        newPortfolio(),
        pool,
        { companyId: 'c', side: 'BUY', qty: 5 },
        { ...CTX, ipoRemainingCash: 100 },
      ),
    ).toEqual({ ok: false, reason: 'IPO_ALLOCATION_EXCEEDED' });
  });

  it('SELL returns proceeds and reduces cost basis proportionally', () => {
    const b = ok(
      executeOrder(newPortfolio(), createPool(), { companyId: 'c', side: 'BUY', qty: 10 }, CTX),
    );
    const s = ok(executeOrder(b.portfolio, b.pool, { companyId: 'c', side: 'SELL', qty: 4 }, CTX));
    expect(s.portfolio.holdings.c?.longQty).toBeCloseTo(6, 10);
    expect(s.portfolio.holdings.c?.longCost).toBeCloseTo(b.fill.cash * 0.6, 8);
    expect(
      executeOrder(s.portfolio, s.pool, { companyId: 'c', side: 'SELL', qty: 7 }, CTX),
    ).toEqual({ ok: false, reason: 'INSUFFICIENT_SHARES' });
  });

  it('SHORT locks proceeds + matching cash; COVER releases it', () => {
    const sh = ok(
      executeOrder(newPortfolio(), createPool(), { companyId: 'c', side: 'SHORT', qty: 10 }, CTX),
    );
    const proceeds = sh.fill.cash;
    expect(sh.portfolio.cash).toBeCloseTo(PARAMS.seasonStartCash - proceeds, 8);
    expect(sh.portfolio.holdings.c?.shortCollateral).toBeCloseTo(2 * proceeds, 8);
    const cv = ok(
      executeOrder(sh.portfolio, sh.pool, { companyId: 'c', side: 'COVER', qty: 10 }, CTX),
    );
    expect(cv.portfolio.holdings.c).toBeUndefined();
    expect(cv.portfolio.cash).toBeCloseTo(
      PARAMS.seasonStartCash - proceeds + 2 * proceeds - cv.fill.cash,
      8,
    );
    expect(cv.portfolio.cash).toBeLessThan(PARAMS.seasonStartCash); // fees
  });

  it('forbids long and short in the same company', () => {
    const b = ok(
      executeOrder(newPortfolio(), createPool(), { companyId: 'c', side: 'BUY', qty: 1 }, CTX),
    );
    expect(
      executeOrder(b.portfolio, b.pool, { companyId: 'c', side: 'SHORT', qty: 1 }, CTX),
    ).toEqual({ ok: false, reason: 'CLOSE_LONG_FIRST' });
    const s = ok(
      executeOrder(newPortfolio(), createPool(), { companyId: 'c', side: 'SHORT', qty: 1 }, CTX),
    );
    expect(executeOrder(s.portfolio, s.pool, { companyId: 'c', side: 'BUY', qty: 1 }, CTX)).toEqual(
      { ok: false, reason: 'COVER_SHORT_FIRST' },
    );
  });

  it('netWorth marks longs and shorts at price', () => {
    const b = ok(
      executeOrder(newPortfolio(), createPool(), { companyId: 'c', side: 'BUY', qty: 10 }, CTX),
    );
    const price = sharePrice(100, b.pool);
    expect(netWorth(b.portfolio, { c: price })).toBeCloseTo(b.portfolio.cash + 10 * price, 8);
  });

  it('needsAutoCover triggers when buy-back cost reaches 95% of collateral', () => {
    const sh = ok(
      executeOrder(newPortfolio(), createPool(), { companyId: 'c', side: 'SHORT', qty: 10 }, CTX),
    );
    const h = sh.portfolio.holdings.c;
    if (!h) throw new Error('missing holding');
    expect(needsAutoCover(h, sh.pool, 100)).toBe(false);
    expect(needsAutoCover(h, sh.pool, 200)).toBe(true);
  });

  it('cash never goes negative across random non-forced order sequences', () => {
    const side = fc.constantFrom('BUY', 'SELL', 'SHORT', 'COVER') as fc.Arbitrary<
      'BUY' | 'SELL' | 'SHORT' | 'COVER'
    >;
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            side,
            qty: fc.double({ min: 0.01, max: 200, noNaN: true }),
            nav: fc.double({ min: 1, max: 500, noNaN: true }),
          }),
          { maxLength: 40 },
        ),
        (orders) => {
          let pf = newPortfolio();
          let pool = createPool();
          for (const o of orders) {
            const r = executeOrder(
              pf,
              pool,
              { companyId: 'c', side: o.side, qty: o.qty },
              { status: 'ACTIVE', nav: o.nav },
            );
            if (r.ok) {
              pf = r.portfolio;
              pool = r.pool;
            }
            expect(pf.cash).toBeGreaterThanOrEqual(-1e-6);
          }
        },
      ),
    );
    expect(quoteBuy(createPool(), 1, 1).ok).toBe(true);
  });
});
