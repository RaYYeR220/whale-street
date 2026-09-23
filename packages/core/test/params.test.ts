import { describe, expect, it } from 'vitest';
import { PARAMS } from '../src/index';

describe('PARAMS', () => {
  it('matches spec defaults', () => {
    expect(PARAMS.navStart).toBe(100);
    expect(PARAMS.feeRate).toBe(0.003);
    expect(PARAMS.committee.minEquityUsd).toBe(25_000);
    expect(PARAMS.mirror.antiFomoPct).toBe(0.05);
    expect(PARAMS.mirror.maxLeverage).toBe(5);
  });

  it('is deeply frozen, including the nested committee and mirror objects', () => {
    expect(Object.isFrozen(PARAMS)).toBe(true);
    expect(Object.isFrozen(PARAMS.committee)).toBe(true);
    expect(Object.isFrozen(PARAMS.mirror)).toBe(true);

    const before = PARAMS.committee.minEquityUsd;
    try {
      // @ts-expect-error intentional mutation attempt to prove the freeze holds
      PARAMS.committee.minEquityUsd = 0;
    } catch {
      // strict mode throws on a frozen object; sloppy mode would silently no-op either way
    }
    expect(PARAMS.committee.minEquityUsd).toBe(before);
  });

  it('still supports overriding via a spread of the nested objects', () => {
    const custom = { ...PARAMS, mirror: { ...PARAMS.mirror, antiFomoPct: 0.1 } };
    expect(custom.mirror.antiFomoPct).toBe(0.1);
    expect(custom.committee).toBe(PARAMS.committee);
    expect(PARAMS.mirror.antiFomoPct).toBe(0.05); // original untouched
  });

  it('exposes the rating, style and PnL-band thresholds used by the committee', () => {
    expect(PARAMS.committee.ratingThresholds).toEqual({
      AAA: 85,
      AA: 75,
      A: 65,
      BBB: 55,
      BB: 45,
      B: 35,
    });
    expect(PARAMS.committee.styleMinutes).toEqual({
      scalper: 60,
      dayTrader: 1_440,
      swingTrader: 10_080,
    });
    expect(PARAMS.committee.pnlBands).toEqual({
      under10k: 10_000,
      under100k: 100_000,
      under1m: 1_000_000,
      under10m: 10_000_000,
    });
  });
});
