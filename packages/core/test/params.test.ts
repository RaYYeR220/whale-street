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
});
