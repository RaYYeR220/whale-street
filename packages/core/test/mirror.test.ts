import { describe, expect, it } from 'vitest';
import {
  evaluateMirror,
  type MirrorContext,
  type MirrorRefusalCode,
  type MirrorRequest,
  type Position,
} from '../src/index';

const ctx = (o: Partial<MirrorContext> = {}): MirrorContext => ({
  companyStatus: 'ACTIVE',
  snapshotAgeMs: 5_000,
  coinSupported: true,
  traderPosition: {
    coin: 'HYPE',
    size: 100,
    entryPx: 40,
    liqPx: 30,
    leverage: 10,
    marginUsed: 400,
    unrealizedPnl: 0,
  },
  mark: 41,
  hp: 0.8,
  playerOpenMirrors: 0,
  playerDailyNotionalUsd: 0,
  ...o,
});
const req = (o: Partial<MirrorRequest> = {}): MirrorRequest => ({
  coin: 'HYPE',
  notionalUsd: 50,
  leverage: 3,
  ...o,
});

describe('mirror policy', () => {
  it('allows a sane request and builds the order with a mandatory stop', () => {
    const d = evaluateMirror(req(), ctx());
    if (!d.allow) throw new Error(JSON.stringify(d.refusals));
    expect(d.order).toMatchObject({
      coin: 'HYPE',
      isBuy: true,
      notionalUsd: 50,
      leverage: 3,
      markPx: 41,
    });
    expect(d.order.size).toBeCloseTo(50 / 41, 10);
    expect(d.order.stopLossPx).toBeCloseTo(41 * (1 - 0.25 / 3), 10);
  });

  it('short side places the stop above the mark', () => {
    const d = evaluateMirror(
      req(),
      ctx({
        traderPosition: {
          coin: 'HYPE',
          size: -5,
          entryPx: 42,
          liqPx: 60,
          leverage: 5,
          marginUsed: 0,
          unrealizedPnl: 0,
        },
      }),
    );
    if (!d.allow) throw new Error('refused');
    expect(d.order.isBuy).toBe(false);
    expect(d.order.stopLossPx).toBeGreaterThan(41);
  });

  it('STALE_DATA message reports the configured max snapshot age', () => {
    const d = evaluateMirror(req(), ctx({ snapshotAgeMs: 120_000 }));
    expect(d.allow).toBe(false);
    if (!d.allow) {
      const r = d.refusals.find((x) => x.code === 'STALE_DATA');
      expect(r?.message).toBe('trader data is older than 60 seconds');
    }
  });

  it('ANTI_FOMO when the mark ran away from the trader entry', () => {
    const d = evaluateMirror(req(), ctx({ mark: 42.2 }));
    expect(d.allow).toBe(false);
    if (d.allow) return;
    const r = d.refusals.find((x) => x.code === 'ANTI_FOMO');
    expect(r?.message).toContain("you'd enter 5.5% worse than the trader");
  });

  it('collects every refusal', () => {
    const d = evaluateMirror(
      req({ notionalUsd: 500, leverage: 20, stopLossPct: 0.9 }),
      ctx({
        companyStatus: 'HALTED',
        snapshotAgeMs: 120_000,
        coinSupported: false,
        hp: 0.1,
        playerOpenMirrors: 3,
        playerDailyNotionalUsd: 290,
      }),
    );
    expect(d.allow).toBe(false);
    if (d.allow) return;
    expect(d.refusals.map((r) => r.code).sort()).toEqual(
      [
        'COIN_UNSUPPORTED',
        'COMPANY_NOT_ACTIVE',
        'DAILY_CAP',
        'LEVERAGE_CAP',
        'NEAR_LIQUIDATION',
        'NOTIONAL_OUT_OF_RANGE',
        'STALE_DATA',
        'STOP_LOSS_TOO_LOOSE',
        'TOO_MANY_OPEN',
      ].sort(),
    );
  });

  it('refuses without a trader position or mark', () => {
    const a = evaluateMirror(req(), ctx({ traderPosition: null }));
    const b = evaluateMirror(req(), ctx({ mark: null }));
    expect(a.allow || a.refusals.map((r) => r.code)).toEqual(['NO_POSITION']);
    expect(b.allow || b.refusals.map((r) => r.code)).toEqual(['NO_MARK']);
  });

  it.each([
    [
      'long with a negative entryPx',
      {
        coin: 'HYPE',
        size: 100,
        entryPx: -40,
        liqPx: 30,
        leverage: 10,
        marginUsed: 400,
        unrealizedPnl: 0,
      },
    ],
    [
      'short with entryPx zero',
      {
        coin: 'HYPE',
        size: -5,
        entryPx: 0,
        liqPx: 60,
        leverage: 5,
        marginUsed: 0,
        unrealizedPnl: 0,
      },
    ],
    [
      'a position in a different coin than requested',
      {
        coin: 'BTC',
        size: 1,
        entryPx: 60_000,
        liqPx: 50_000,
        leverage: 5,
        marginUsed: 0,
        unrealizedPnl: 0,
      },
    ],
  ] as Array<[string, Position]>)('refuses NO_POSITION for %s', (_label, traderPosition) => {
    const d = evaluateMirror(req(), ctx({ traderPosition }));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.refusals.find((r) => r.code === 'NO_POSITION')).toBeDefined();
  });

  it('leverage above the trader leverage is refused even under the global cap', () => {
    const d = evaluateMirror(
      req({ leverage: 4 }),
      ctx({
        traderPosition: {
          coin: 'HYPE',
          size: 1,
          entryPx: 41,
          liqPx: 20,
          leverage: 2,
          marginUsed: 0,
          unrealizedPnl: 0,
        },
      }),
    );
    expect(d.allow || d.refusals.map((r) => r.code)).toEqual(['LEVERAGE_CAP']);
  });

  it.each([
    ['hp', Number.NaN, 'NEAR_LIQUIDATION'],
    ['hp', Number.POSITIVE_INFINITY, 'NEAR_LIQUIDATION'],
    ['snapshotAgeMs', Number.NaN, 'STALE_DATA'],
    ['snapshotAgeMs', Number.NEGATIVE_INFINITY, 'STALE_DATA'],
    ['playerOpenMirrors', Number.NaN, 'TOO_MANY_OPEN'],
    ['playerOpenMirrors', Number.NEGATIVE_INFINITY, 'TOO_MANY_OPEN'],
    ['playerDailyNotionalUsd', Number.NaN, 'DAILY_CAP'],
    ['playerDailyNotionalUsd', Number.NEGATIVE_INFINITY, 'DAILY_CAP'],
  ] as Array<[keyof MirrorContext, number, MirrorRefusalCode]>)(
    'fails closed when %s is %p',
    (field, value, code) => {
      const d = evaluateMirror(req(), ctx({ [field]: value } as Partial<MirrorContext>));
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.refusals.find((r) => r.code === code)).toBeDefined();
    },
  );

  it('fails closed with NO_POSITION on a NaN trader entryPx (not a sane position)', () => {
    const d = evaluateMirror(
      req(),
      ctx({
        traderPosition: {
          coin: 'HYPE',
          size: 100,
          entryPx: Number.NaN,
          liqPx: 30,
          leverage: 10,
          marginUsed: 400,
          unrealizedPnl: 0,
        },
      }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.refusals.find((r) => r.code === 'NO_POSITION')).toBeDefined();
  });

  it.each([
    ['a NaN size', { size: Number.NaN }],
    ['an infinite size', { size: Number.POSITIVE_INFINITY }],
  ] as Array<[string, Partial<Position>]>)(
    'refuses NO_POSITION for a trader position with %s',
    (_label, override) => {
      const d = evaluateMirror(
        req(),
        ctx({
          traderPosition: {
            coin: 'HYPE',
            size: 100,
            entryPx: 40,
            liqPx: 30,
            leverage: 10,
            marginUsed: 400,
            unrealizedPnl: 0,
            ...override,
          },
        }),
      );
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.refusals.find((r) => r.code === 'NO_POSITION')).toBeDefined();
    },
  );

  it.each([
    [
      'short',
      {
        coin: 'HYPE',
        size: -5,
        entryPx: 42,
        liqPx: 60,
        leverage: 5,
        marginUsed: 0,
        unrealizedPnl: 0,
      },
    ],
    [
      'long',
      {
        coin: 'HYPE',
        size: 100,
        entryPx: 40,
        liqPx: 30,
        leverage: 10,
        marginUsed: 400,
        unrealizedPnl: 0,
      },
    ],
  ] as Array<[string, Position]>)(
    'refuses NO_MARK on an infinite mark (%s position)',
    (_side, traderPosition) => {
      const d = evaluateMirror(req(), ctx({ traderPosition, mark: Number.POSITIVE_INFINITY }));
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.refusals.find((r) => r.code === 'NO_MARK')).toBeDefined();
    },
  );

  it('collects LEVERAGE_CAP even when mark is invalid', () => {
    const d = evaluateMirror(
      req({ leverage: 20 }),
      ctx({
        mark: null,
        traderPosition: {
          coin: 'HYPE',
          size: 100,
          entryPx: 40,
          liqPx: 30,
          leverage: 10,
          marginUsed: 400,
          unrealizedPnl: 0,
        },
      }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.refusals.find((r) => r.code === 'NO_MARK')).toBeDefined();
      expect(d.refusals.find((r) => r.code === 'LEVERAGE_CAP')).toBeDefined();
    }
  });
});
