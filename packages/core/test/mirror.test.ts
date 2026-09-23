import { describe, expect, it } from 'vitest';
import { evaluateMirror, type MirrorContext, type MirrorRequest } from '../src/index';

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

  it('fails closed on NaN in numeric guards', () => {
    // NaN in hp should refuse NEAR_LIQUIDATION
    const nanHp = evaluateMirror(req(), ctx({ hp: Number.NaN }));
    expect(nanHp.allow).toBe(false);
    if (!nanHp.allow) {
      expect(nanHp.refusals.find((r) => r.code === 'NEAR_LIQUIDATION')).toBeDefined();
    }

    // NaN in snapshotAgeMs should refuse STALE_DATA
    const nanSnapshot = evaluateMirror(req(), ctx({ snapshotAgeMs: Number.NaN }));
    expect(nanSnapshot.allow).toBe(false);
    if (!nanSnapshot.allow) {
      expect(nanSnapshot.refusals.find((r) => r.code === 'STALE_DATA')).toBeDefined();
    }

    // NaN in playerOpenMirrors should refuse TOO_MANY_OPEN
    const nanOpenMirrors = evaluateMirror(req(), ctx({ playerOpenMirrors: Number.NaN }));
    expect(nanOpenMirrors.allow).toBe(false);
    if (!nanOpenMirrors.allow) {
      expect(nanOpenMirrors.refusals.find((r) => r.code === 'TOO_MANY_OPEN')).toBeDefined();
    }

    // NaN in playerDailyNotionalUsd should refuse DAILY_CAP
    const nanDaily = evaluateMirror(req(), ctx({ playerDailyNotionalUsd: Number.NaN }));
    expect(nanDaily.allow).toBe(false);
    if (!nanDaily.allow) {
      expect(nanDaily.refusals.find((r) => r.code === 'DAILY_CAP')).toBeDefined();
    }

    // NaN in traderPosition.entryPx should refuse ANTI_FOMO
    const nanEntryPx = evaluateMirror(
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
    expect(nanEntryPx.allow).toBe(false);
    if (!nanEntryPx.allow) {
      expect(nanEntryPx.refusals.find((r) => r.code === 'ANTI_FOMO')).toBeDefined();
    }
  });

  it('fails closed on non-finite position size and mark', () => {
    // NaN in traderPosition.size should refuse NO_POSITION
    const sizeNaN = evaluateMirror(
      req(),
      ctx({
        traderPosition: {
          coin: 'HYPE',
          size: Number.NaN,
          entryPx: 40,
          liqPx: 30,
          leverage: 10,
          marginUsed: 400,
          unrealizedPnl: 0,
        },
      }),
    );
    expect(sizeNaN.allow).toBe(false);
    if (!sizeNaN.allow) {
      expect(sizeNaN.refusals.find((r) => r.code === 'NO_POSITION')).toBeDefined();
    }

    // Infinity in traderPosition.size should refuse NO_POSITION
    const sizeInfinity = evaluateMirror(
      req(),
      ctx({
        traderPosition: {
          coin: 'HYPE',
          size: Number.POSITIVE_INFINITY,
          entryPx: 40,
          liqPx: 30,
          leverage: 10,
          marginUsed: 400,
          unrealizedPnl: 0,
        },
      }),
    );
    expect(sizeInfinity.allow).toBe(false);
    if (!sizeInfinity.allow) {
      expect(sizeInfinity.refusals.find((r) => r.code === 'NO_POSITION')).toBeDefined();
    }

    // Infinity in mark with SHORT position should refuse NO_MARK
    const markInfinityShort = evaluateMirror(
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
        mark: Number.POSITIVE_INFINITY,
      }),
    );
    expect(markInfinityShort.allow).toBe(false);
    if (!markInfinityShort.allow) {
      expect(markInfinityShort.refusals.find((r) => r.code === 'NO_MARK')).toBeDefined();
    }

    // Infinity in mark with LONG position should refuse NO_MARK
    const markInfinityLong = evaluateMirror(
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
        },
        mark: Number.POSITIVE_INFINITY,
      }),
    );
    expect(markInfinityLong.allow).toBe(false);
    if (!markInfinityLong.allow) {
      expect(markInfinityLong.refusals.find((r) => r.code === 'NO_MARK')).toBeDefined();
    }
  });

  it('fails closed on negative and infinite context values', () => {
    // +Infinity in hp should refuse NEAR_LIQUIDATION
    const hpInfinity = evaluateMirror(req(), ctx({ hp: Number.POSITIVE_INFINITY }));
    expect(hpInfinity.allow).toBe(false);
    if (!hpInfinity.allow) {
      expect(hpInfinity.refusals.find((r) => r.code === 'NEAR_LIQUIDATION')).toBeDefined();
    }

    // -Infinity in snapshotAgeMs should refuse STALE_DATA
    const snapshotNegInf = evaluateMirror(req(), ctx({ snapshotAgeMs: Number.NEGATIVE_INFINITY }));
    expect(snapshotNegInf.allow).toBe(false);
    if (!snapshotNegInf.allow) {
      expect(snapshotNegInf.refusals.find((r) => r.code === 'STALE_DATA')).toBeDefined();
    }

    // -Infinity in playerOpenMirrors should refuse TOO_MANY_OPEN
    const openMirrorsNegInf = evaluateMirror(
      req(),
      ctx({ playerOpenMirrors: Number.NEGATIVE_INFINITY }),
    );
    expect(openMirrorsNegInf.allow).toBe(false);
    if (!openMirrorsNegInf.allow) {
      expect(openMirrorsNegInf.refusals.find((r) => r.code === 'TOO_MANY_OPEN')).toBeDefined();
    }

    // -Infinity in playerDailyNotionalUsd should refuse DAILY_CAP
    const dailyNegInf = evaluateMirror(
      req(),
      ctx({ playerDailyNotionalUsd: Number.NEGATIVE_INFINITY }),
    );
    expect(dailyNegInf.allow).toBe(false);
    if (!dailyNegInf.allow) {
      expect(dailyNegInf.refusals.find((r) => r.code === 'DAILY_CAP')).toBeDefined();
    }
  });

  it('collects LEVERAGE_CAP even when mark is invalid', () => {
    // Invalid mark with high leverage should get both NO_MARK and LEVERAGE_CAP
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
