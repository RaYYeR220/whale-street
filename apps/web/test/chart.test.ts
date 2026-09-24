import { describe, expect, it } from 'vitest';
import {
  bucketSeries,
  chartModel,
  indexAt,
  MAX_HISTORY_MIN,
  niceTicks,
  rangeMinutes,
  stepFor,
  tickLabel,
} from '../lib/chart';
import { MINUTE_MS, seriesFromHistory } from '../lib/store';
import { filing, T0 } from './helpers';

describe('chart ranges', () => {
  it('asks the engine for at most 7 days', () => {
    expect(rangeMinutes('1h', null, T0)).toBe(60);
    expect(rangeMinutes('24h', null, T0)).toBe(1_440);
    expect(rangeMinutes('7d', null, T0)).toBe(MAX_HISTORY_MIN);
    expect(rangeMinutes('ipo', T0 - 30 * MINUTE_MS, T0)).toBe(31);
    expect(rangeMinutes('ipo', T0 - 60_000, T0)).toBe(10);
    expect(rangeMinutes('ipo', T0 - 30 * 86_400_000, T0)).toBe(MAX_HISTORY_MIN);
  });

  it('picks a bucket size per range', () => {
    expect(stepFor(60)).toBe(1);
    expect(stepFor(1_440)).toBe(15);
    expect(stepFor(MAX_HISTORY_MIN)).toBe(42);
  });
});

describe('bucketSeries', () => {
  it('lays points on a fixed grid ending now, leaving gaps as null', () => {
    const s = seriesFromHistory([
      { t: T0 - 2 * MINUTE_MS, nav: 1, price: 2 },
      { t: T0, nav: 3, price: 4 },
    ]);
    const b = bucketSeries(s, T0, 60);
    expect(b.t).toHaveLength(60);
    expect(b.t.at(-1)).toBe(T0);
    expect(b.nav.at(-1)).toBe(3);
    expect(b.nav.at(-3)).toBe(1);
    expect(b.nav.at(-2)).toBeNull();
  });

  it('never draws an unknown minute as zero', () => {
    const b = bucketSeries(undefined, T0, 60);
    expect(b.nav.every((v) => v === null)).toBe(true);
  });
});

describe('ticks', () => {
  it('chooses round steps', () => {
    expect(niceTicks(135, 160, 5)).toEqual([135, 140, 145, 150, 155, 160]);
    expect(niceTicks(0.21, 0.29, 4)).toEqual([0.22, 0.24, 0.26, 0.28]);
  });

  it('labels ticks', () => {
    expect(tickLabel(113950)).toBe('113,950');
    expect(tickLabel(145)).toBe('145');
    expect(tickLabel(2.5)).toBe('2.50');
  });
});

describe('chartModel', () => {
  const s = bucketSeries(
    seriesFromHistory(
      Array.from({ length: 60 }, (_, i) => ({
        t: T0 - (59 - i) * MINUTE_MS,
        nav: 100 + i * 0.1,
        price: 105 + i * 0.2,
      })),
    ),
    T0,
    60,
  );

  it('maps the series into the box with the hype gap shaded', () => {
    const m = chartModel(s, [], 800, 320);
    expect(m.n).toBe(60);
    expect(m.X(0)).toBe(m.m.l);
    expect(m.X(59)).toBeCloseTo(m.m.l + m.iw);
    expect(m.up.length).toBeGreaterThan(0);
    expect(m.dn).toBe('');
    expect(m.navD.startsWith('M')).toBe(true);
    expect(m.end).not.toBeNull();
  });

  it('places filing balloons inside the range only', () => {
    const inside = filing({ id: 1, at: T0 - 10 * MINUTE_MS });
    const outside = filing({ id: 2, at: T0 - 3 * 3_600_000 });
    const m = chartModel(s, [inside, outside], 800, 320);
    const ids = m.clusters.flatMap((c) => c.items.map((f) => f.id));
    expect(ids).toEqual([1]);
  });

  it('finds the point under the pointer', () => {
    const m = chartModel(s, [], 800, 320);
    expect(indexAt(m, m.m.l - 50)).toBe(0);
    expect(indexAt(m, m.m.l + m.iw + 50)).toBe(59);
  });
});
