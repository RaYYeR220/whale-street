import { PARAMS } from '@whale-street/core';
import { describe, expect, it } from 'vitest';
import { faceReading } from '../components/company/CompanyHead';
import { feeOf, IPO_HEADROOM, ipoAllowance, qtyFor } from '../components/company/TradeTicket';
import { toDisplay } from '../lib/company';
import { entry, T0 } from './helpers';

describe('trade ticket maths', () => {
  it('turns dollars into whole cents of shares, capped by what you hold', () => {
    expect(qtyFor('usd', 1_000, 280)).toBe(3.57);
    expect(qtyFor('shares', 12.345, 280)).toBe(12.34);
    expect(qtyFor('usd', 1_000, null)).toBe(0);
    expect(qtyFor('shares', 10, 280, 4)).toBe(4);
  });

  it('keeps IPO buys inside the per-player allowance', () => {
    expect(ipoAllowance(undefined)).toBe(PARAMS.ipoCapFrac * PARAMS.seasonStartCash);
    expect(ipoAllowance(600)).toBe(400);
    expect(ipoAllowance(5_000)).toBe(0);
    expect(IPO_HEADROOM).toBeLessThan(1 / (1 + PARAMS.feeRate));
  });

  it('shows the fee inside the quoted cash', () => {
    const f = PARAMS.feeRate;
    expect(feeOf('buy', 1_000 * (1 + f))).toBeCloseTo(1_000 * f);
    expect(feeOf('sell', 1_000 * (1 - f))).toBeCloseTo(1_000 * f);
  });
});

describe('face reading', () => {
  it('explains the face in words', () => {
    const d = toDisplay(entry({ hp: 0.82, mult: 1.117 }), null, undefined, T0);
    expect(d && faceReading(d)).toBe(
      'Why this face: Calm, 82% HP; pink aura, priced 11.7% over NAV.',
    );
    const halted = toDisplay(entry({ status: 'HALTED' }), null, undefined, T0);
    expect(halted && faceReading(halted)).toMatch(/^Asleep: no fresh Nansen data/);
  });
});
