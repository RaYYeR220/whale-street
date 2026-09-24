import { describe, expect, it } from 'vitest';
import {
  ago,
  agoLong,
  agoSec,
  coinPx,
  compact,
  countdown,
  DASH,
  mmss,
  pct,
  pctAbs,
  price,
  shares,
  shortAddress,
  signedUsd,
  upDown,
  usd,
} from '../lib/format';

describe('formatters never invent a number', () => {
  const unknowns = [null, undefined, Number.NaN, Number.POSITIVE_INFINITY];
  for (const f of [
    price,
    pct,
    pctAbs,
    usd,
    signedUsd,
    compact,
    coinPx,
    shares,
    ago,
    agoSec,
    countdown,
  ])
    it(`${f.name} prints a dash for unknown values`, () => {
      for (const v of unknowns) expect(f(v)).toBe(DASH);
    });

  it('agoLong says the time is unknown', () => {
    expect(agoLong(null)).toBe('at an unknown time');
  });

  it('shortAddress prints a dash for a missing address', () => {
    expect(shortAddress(null)).toBe(DASH);
    expect(shortAddress('')).toBe(DASH);
  });

  it('upDown is muted for unknown values', () => {
    expect(upDown(null)).toBe('ws-v-muted');
  });
});

describe('formats', () => {
  it('prices', () => {
    expect(price(12.3456)).toBe('12.35');
    expect(price(113950)).toBe('113,950.00');
  });

  it('percentages use a real minus sign', () => {
    expect(pct(-0.034)).toBe('−3.4%');
    expect(pct(0)).toBe('0.0%');
    expect(pctAbs(-0.25, 0)).toBe('25%');
  });

  it('dollars', () => {
    expect(usd(1234.5)).toBe('$1,234.50');
    expect(signedUsd(-3)).toBe('−$3.00');
    expect(signedUsd(12.4)).toBe('+$12.40');
    expect(compact(3_400_000)).toBe('$3.4M');
    expect(compact(12_000_000)).toBe('$12M');
    expect(compact(186_000)).toBe('$186k');
    expect(compact(1_500)).toBe('$1.5k');
  });

  it('coin prices and share counts', () => {
    expect(coinPx(113950.4)).toBe('113,950');
    expect(coinPx(207.1)).toBe('207.10');
    expect(coinPx(0.249)).toBe('0.2490');
    expect(shares(12)).toBe('12');
    expect(shares(3.456)).toBe('3.46');
  });

  it('ages and countdowns', () => {
    expect(ago(30_000)).toBe('now');
    expect(ago(4 * 60_000)).toBe('4m');
    expect(ago(3 * 3_600_000)).toBe('3h');
    expect(ago(2 * 86_400_000)).toBe('2d');
    expect(ago(-5_000)).toBe('now');
    expect(agoLong(4 * 60_000)).toBe('4 min ago');
    expect(agoSec(12_000)).toBe('12s');
    expect(agoSec(190_000)).toBe('3m');
    expect(mmss(51_000)).toBe('0:51');
    expect(countdown((4 * 86_400 + 12 * 3600 + 7 * 60) * 1000)).toBe('4d 12h 07m');
  });

  it('short addresses', () => {
    expect(shortAddress('0x3b1e2c4d5e6f708192a3b4c5d6e7f8091a2ba7d2')).toBe('0x3b1e…a7d2');
  });
});
