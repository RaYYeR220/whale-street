import { describe, expect, it } from 'vitest';
import {
  isSanePosition,
  isSaneSnapshot,
  isValidPx,
  type Position,
  type Snapshot,
} from '../src/index';

const ADDR = '0x00000000000000000000000000000000000000cc' as const;

function pos(p: Partial<Position> = {}): Position {
  return {
    coin: 'BTC',
    size: 1,
    entryPx: 100,
    liqPx: 80,
    leverage: 5,
    marginUsed: 20,
    unrealizedPnl: 0,
    ...p,
  };
}

function snap(s: Partial<Snapshot> = {}): Snapshot {
  return {
    address: ADDR,
    positions: [pos()],
    accountValue: 1_000,
    realizedSinceAnchor: 0,
    fetchedAt: 0,
    provenance: [],
    ...s,
  };
}

describe('isValidPx', () => {
  it('accepts positive finite numbers', () => {
    expect(isValidPx(1)).toBe(true);
    expect(isValidPx(0.0001)).toBe(true);
    expect(isValidPx(1e9)).toBe(true);
  });

  it('rejects zero, negative, non-finite and non-numbers', () => {
    expect(isValidPx(0)).toBe(false);
    expect(isValidPx(-1)).toBe(false);
    expect(isValidPx(Number.NaN)).toBe(false);
    expect(isValidPx(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidPx(Number.NEGATIVE_INFINITY)).toBe(false);
    expect(isValidPx('1')).toBe(false);
    expect(isValidPx(null)).toBe(false);
    expect(isValidPx(undefined)).toBe(false);
  });
});

describe('isSanePosition', () => {
  it('accepts a well-formed position', () => {
    expect(isSanePosition(pos())).toBe(true);
  });

  it('accepts liqPx null', () => {
    expect(isSanePosition(pos({ liqPx: null }))).toBe(true);
  });

  it('rejects non-finite or zero size', () => {
    expect(isSanePosition(pos({ size: 0 }))).toBe(false);
    expect(isSanePosition(pos({ size: Number.NaN }))).toBe(false);
    expect(isSanePosition(pos({ size: Number.POSITIVE_INFINITY }))).toBe(false);
  });

  it('rejects invalid entryPx', () => {
    expect(isSanePosition(pos({ entryPx: 0 }))).toBe(false);
    expect(isSanePosition(pos({ entryPx: -5 }))).toBe(false);
    expect(isSanePosition(pos({ entryPx: Number.NaN }))).toBe(false);
  });

  it('rejects invalid liqPx (when not null)', () => {
    expect(isSanePosition(pos({ liqPx: 0 }))).toBe(false);
    expect(isSanePosition(pos({ liqPx: -1 }))).toBe(false);
    expect(isSanePosition(pos({ liqPx: Number.NaN }))).toBe(false);
  });

  it('rejects non-finite or non-positive leverage', () => {
    expect(isSanePosition(pos({ leverage: 0 }))).toBe(false);
    expect(isSanePosition(pos({ leverage: -1 }))).toBe(false);
    expect(isSanePosition(pos({ leverage: Number.NaN }))).toBe(false);
  });

  it('rejects non-finite or negative marginUsed', () => {
    expect(isSanePosition(pos({ marginUsed: -1 }))).toBe(false);
    expect(isSanePosition(pos({ marginUsed: Number.NaN }))).toBe(false);
    expect(isSanePosition(pos({ marginUsed: 0 }))).toBe(true);
  });

  it('rejects non-finite unrealizedPnl', () => {
    expect(isSanePosition(pos({ unrealizedPnl: Number.NaN }))).toBe(false);
    expect(isSanePosition(pos({ unrealizedPnl: Number.POSITIVE_INFINITY }))).toBe(false);
  });
});

describe('isSaneSnapshot', () => {
  it('accepts a well-formed snapshot', () => {
    expect(isSaneSnapshot(snap())).toBe(true);
  });

  it('accepts no positions', () => {
    expect(isSaneSnapshot(snap({ positions: [] }))).toBe(true);
  });

  it('rejects when any position is not sane', () => {
    expect(isSaneSnapshot(snap({ positions: [pos({ size: 0 })] }))).toBe(false);
  });

  it('rejects duplicate coins', () => {
    expect(isSaneSnapshot(snap({ positions: [pos({ coin: 'BTC' }), pos({ coin: 'BTC' })] }))).toBe(
      false,
    );
  });

  it('rejects non-finite accountValue', () => {
    expect(isSaneSnapshot(snap({ accountValue: Number.NaN }))).toBe(false);
    expect(isSaneSnapshot(snap({ accountValue: Number.POSITIVE_INFINITY }))).toBe(false);
  });

  it('rejects non-finite realizedSinceAnchor', () => {
    expect(isSaneSnapshot(snap({ realizedSinceAnchor: Number.NaN }))).toBe(false);
  });

  it('rejects non-finite fetchedAt', () => {
    expect(isSaneSnapshot(snap({ fetchedAt: Number.NaN }))).toBe(false);
  });
});
