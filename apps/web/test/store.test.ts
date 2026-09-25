import { describe, expect, it } from 'vitest';
import {
  appendPoint,
  change,
  createEngineStore,
  engineNow,
  FILINGS_MAX,
  lastMinutes,
  MINUTE_MS,
  seriesFromHistory,
  TAPE_MAX,
} from '../lib/store';
import { entry, filing, market, status, T0, tape } from './helpers';

describe('market frames', () => {
  it('keeps unchanged entries (and the list) referentially stable', () => {
    const store = createEngineStore();
    store.dispatch(market(T0, [entry(), entry({ id: 'b', ticker: 'GBC' })]), T0);
    const first = store.getState().market;
    store.dispatch(market(T0 + 1000, [entry(), entry({ id: 'b', ticker: 'GBC' })]), T0 + 1000);
    const second = store.getState().market;
    expect(second?.companies).toBe(first?.companies);
    expect(second?.byTicker.OOH).toBe(first?.byTicker.OOH);
    expect(second?.at).toBe(T0 + 1000);
  });

  it('replaces only the entry that moved and remembers the previous tick', () => {
    const store = createEngineStore();
    store.dispatch(market(T0, [entry(), entry({ id: 'b', ticker: 'GBC' })]), T0);
    const before = store.getState().market;
    store.dispatch(
      market(T0 + 1000, [entry({ price: 111 }), entry({ id: 'b', ticker: 'GBC' })]),
      T0 + 1000,
    );
    const after = store.getState().market;
    expect(after?.byTicker.OOH?.price).toBe(111);
    expect(after?.byTicker.GBC).toBe(before?.byTicker.GBC);
    expect(store.getState().previous.OOH?.price).toBe(110);
  });

  it('builds minute series and records null while a company is not trading', () => {
    const store = createEngineStore();
    store.dispatch(market(T0, [entry()]), T0);
    store.dispatch(market(T0 + MINUTE_MS, [entry({ status: 'HALTED', nav: 99, price: 99 })]), T0);
    const s = store.getState().series.OOH;
    expect(s?.t).toEqual([T0, T0 + MINUTE_MS]);
    expect(s?.nav).toEqual([100, null]);
    expect(s?.price).toEqual([110, null]);
  });

  it('detects a replay loop restart: new epoch, fresh series, cleared news', () => {
    const store = createEngineStore();
    store.dispatch(market(T0 + 600_000, [entry()]), T0);
    store.dispatch({ t: 'filing', filing: filing() });
    store.dispatch(market(T0, [entry()]), T0);
    const st = store.getState();
    expect(st.epoch).toBe(1);
    expect(st.series.OOH?.t).toEqual([T0]);
    expect(st.filings).toEqual([]);
  });

  it('ignores small clock jitter (no false restart)', () => {
    const store = createEngineStore();
    store.dispatch(market(T0 + 10_000, [entry()]), T0);
    store.dispatch(market(T0 + 8_000, [entry()]), T0);
    expect(store.getState().epoch).toBe(0);
  });
});

describe('news and player slices', () => {
  it('deduplicates filings, newest first, capped', () => {
    const store = createEngineStore();
    store.dispatch({ t: 'filing', filing: filing({ id: 1 }) });
    store.dispatch({ t: 'filing', filing: filing({ id: 1 }) });
    store.dispatch({ t: 'filing', filing: filing({ id: 2, at: T0 + 1 }) });
    expect(store.getState().filings.map((f) => f.id)).toEqual([2, 1]);
    for (let i = 3; i < FILINGS_MAX + 10; i++)
      store.dispatch({ t: 'filing', filing: filing({ id: i }) });
    expect(store.getState().filings).toHaveLength(FILINGS_MAX);
  });

  it('merges a REST seed of filings under the live ones', () => {
    const store = createEngineStore();
    store.dispatch({ t: 'filing', filing: filing({ id: 5, at: T0 + 5 }) });
    store.seedFilings([
      filing({ id: 5, at: T0 + 5 }),
      filing({ id: 3, at: T0 + 3 }),
      filing({ id: 4, at: T0 + 4 }),
    ]);
    expect(store.getState().filings.map((f) => f.id)).toEqual([5, 4, 3]);
  });

  it('seeds the tape from REST under the live trades, newest first, no duplicate', () => {
    const store = createEngineStore();
    // A trade arrived live before the REST seed resolved: the seed must not duplicate it.
    store.dispatch({ t: 'tape', trade: tape({ handle: 'anon2', at: T0 + 10 }) });
    store.seedTape([tape({ handle: 'anon2', at: T0 + 10 }), tape({ handle: 'anon1', at: T0 })]);
    expect(store.getState().tape.map((t) => [t.handle, t.at])).toEqual([
      ['anon2', T0 + 10],
      ['anon1', T0],
    ]);
  });

  it('never appends a live trade already seeded from REST', () => {
    const store = createEngineStore();
    store.seedTape([tape({ handle: 'anon1', at: T0 })]);
    store.dispatch({ t: 'tape', trade: tape({ handle: 'anon1', at: T0 }) });
    expect(store.getState().tape).toHaveLength(1);
  });

  it('caps the seeded tape at TAPE_MAX', () => {
    const store = createEngineStore();
    const seed = Array.from({ length: TAPE_MAX + 10 }, (_, i) =>
      tape({ handle: `anon${i}`, at: T0 + i }),
    );
    store.seedTape(seed);
    expect(store.getState().tape).toHaveLength(TAPE_MAX);
    expect(store.getState().tape[0]?.handle).toBe(`anon${TAPE_MAX + 9}`);
  });

  it('notifies subscribers only when something changed', () => {
    const store = createEngineStore();
    let calls = 0;
    const off = store.subscribe(() => {
      calls += 1;
    });
    store.setConnection('open');
    store.setConnection('open');
    store.dispatch({ t: 'error', error: 'BAD', message: 'bad' });
    off();
    store.setConnection('closed');
    expect(calls).toBe(2);
    expect(store.getState().lastError).toEqual({ error: 'BAD', message: 'bad' });
  });
});

describe('series helpers', () => {
  it('appendPoint overwrites the current minute and ignores late points', () => {
    let s = appendPoint(undefined, T0 + 5_000, 1, 2);
    s = appendPoint(s, T0 + 40_000, 3, 4);
    expect(s).toEqual({ t: [T0], nav: [3], price: [4] });
    expect(appendPoint(s, T0 - MINUTE_MS, 9, 9)).toBe(s);
  });

  it('seriesFromHistory sorts and buckets REST points', () => {
    const s = seriesFromHistory([
      { t: T0 + MINUTE_MS, nav: 2, price: 2 },
      { t: T0, nav: 1, price: 1 },
    ]);
    expect(s.t).toEqual([T0, T0 + MINUTE_MS]);
  });

  it('seeding history keeps the live minutes on top', () => {
    const store = createEngineStore();
    store.dispatch(market(T0 + MINUTE_MS, [entry({ nav: 50, price: 55 })]), T0);
    store.seedSeries('OOH', [
      { t: T0, nav: 40, price: 41 },
      { t: T0 + MINUTE_MS, nav: 1, price: 1 },
    ]);
    const s = store.getState().series.OOH;
    expect(s?.nav).toEqual([40, 50]);
  });

  it('lastMinutes pads missing minutes with null', () => {
    const s = seriesFromHistory([{ t: T0, nav: 1, price: 2 }]);
    const w = lastMinutes(s, T0 + 2 * MINUTE_MS, 4);
    expect(w.nav).toEqual([null, 1, null, null]);
  });

  it('change is null without two known values', () => {
    expect(change([null, 100, null, 110])).toBeCloseTo(0.1);
    expect(change([null, null])).toBeNull();
    expect(change([0, 5])).toBeNull();
  });
});

describe('engine time', () => {
  it('runs from the newest of the status and the market frame, at wall speed in between', () => {
    const store = createEngineStore();
    expect(engineNow(store.getState(), T0)).toBeNull();
    // REPLAY: engine time is recording time, a week before the wall clock here.
    const rec = T0 - 7 * 86_400_000;
    store.setStatus(status({ now: rec }), T0);
    expect(engineNow(store.getState(), T0 + 500)).toBe(rec + 500);
    store.dispatch(market(rec + 30_000, []), T0 + 1_000);
    expect(engineNow(store.getState(), T0 + 1_500)).toBe(rec + 30_500);
    // A later status frame wins, even when the replay loop jumped back.
    store.dispatch({ t: 'status', status: status({ now: rec - 600_000 }) }, T0 + 2_000);
    expect(engineNow(store.getState(), T0 + 2_000)).toBe(rec - 600_000);
  });
});
