import { describe, expect, it } from 'vitest';
import {
  computeHp,
  computeHpStrict,
  marginCallCrossed,
  type Position,
  positionHp,
} from '../src/index';

const long: Position = {
  coin: 'BTC',
  size: 1,
  entryPx: 100,
  liqPx: 80,
  leverage: 5,
  marginUsed: 20,
  unrealizedPnl: 0,
};
const short: Position = {
  coin: 'ETH',
  size: -1,
  entryPx: 100,
  liqPx: 120,
  leverage: 5,
  marginUsed: 20,
  unrealizedPnl: 0,
};

describe('hp', () => {
  it('is 1 at or above entry for a long, 0 at liquidation', () => {
    expect(positionHp(long, 100)).toBe(1);
    expect(positionHp(long, 130)).toBe(1);
    expect(positionHp(long, 90)).toBeCloseTo(0.5, 10);
    expect(positionHp(long, 80)).toBe(0);
    expect(positionHp(long, 70)).toBe(0);
  });

  it('mirrors for shorts', () => {
    expect(positionHp(short, 110)).toBeCloseTo(0.5, 10);
    expect(positionHp(short, 125)).toBe(0);
  });

  it('is 1 for positions without a liquidation price', () => {
    expect(positionHp({ ...long, liqPx: null }, 1)).toBe(1);
  });

  it('computeHp takes the minimum and ignores coins without marks', () => {
    expect(computeHp([long, short], { BTC: 90, ETH: 105 })).toBeCloseTo(0.5, 10);
    expect(computeHp([long, short], { ETH: 105 })).toBeCloseTo(0.75, 10);
    expect(computeHp([], {})).toBe(1);
  });

  it('computeHp also ignores a mark of zero or negative (invalid px)', () => {
    expect(computeHp([long, short], { BTC: 0, ETH: 105 })).toBeCloseTo(0.75, 10);
    expect(computeHp([long, short], { BTC: -10, ETH: 105 })).toBeCloseTo(0.75, 10);
  });

  it('computeHpStrict is null when any position lacks a valid mark', () => {
    expect(computeHpStrict([long, short], { BTC: 90 })).toBeNull();
    expect(computeHpStrict([long, short], { BTC: 90, ETH: 0 })).toBeNull();
    expect(computeHpStrict([long, short], {})).toBeNull();
  });

  it('computeHpStrict is null when any position is not sane', () => {
    expect(computeHpStrict([{ ...long, size: 0 }, short], { BTC: 90, ETH: 105 })).toBeNull();
  });

  it('computeHpStrict equals computeHp when every position has a valid mark', () => {
    expect(computeHpStrict([long, short], { BTC: 90, ETH: 105 })).toBe(
      computeHp([long, short], { BTC: 90, ETH: 105 }),
    );
    expect(computeHpStrict([], {})).toBe(1);
  });

  it('detects a downward margin-call crossing only', () => {
    expect(marginCallCrossed(0.2, 0.05)).toBe(true);
    expect(marginCallCrossed(0.05, 0.04)).toBe(false);
    expect(marginCallCrossed(0.05, 0.2)).toBe(false);
  });
});
