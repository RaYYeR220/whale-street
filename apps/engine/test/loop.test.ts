import { multiplier } from '@whale-street/core';
import { describe, expect, it, vi } from 'vitest';
import { createMarketLoop } from '../src/market/loop';
import { runtimeFromRow } from '../src/market/state';
import { addCompany, makeWorld, pos } from './helpers/world';

const A = '0x00000000000000000000000000000000000000a1' as const;
const B = '0x00000000000000000000000000000000000000b2' as const;

function setup() {
  const w = makeWorld();
  const autoCover = vi.fn();
  const loop = createMarketLoop({ ...w, autoCover });
  return { w, loop, autoCover };
}

describe('market loop', () => {
  it('ticks NAV on marks, emits a market frame, persists one nav point per minute', () => {
    const { w, loop, autoCover } = setup();
    const rt = addCompany(w, {
      id: A,
      ticker: 'AAA',
      positions: [pos('BTC', 1, 100)],
      accountValue: 1_000,
    });
    w.state.setMarks({ BTC: 100 }, w.clock.now());
    loop.tick(w.clock.now());
    w.state.setMarks({ BTC: 110 }, w.clock.now() + 1_000);
    w.clock.advance(1_000);
    loop.tick(w.clock.now());
    expect(rt.nav.nav).toBeCloseTo(101, 8);
    expect(w.events.filter((e) => e.t === 'market')).toHaveLength(2);
    expect(w.repos.navPoints.history(A, 0, w.clock.now())).toHaveLength(1);
    w.clock.advance(60_000);
    w.state.setMarks({ BTC: 110 }, w.clock.now());
    loop.tick(w.clock.now());
    expect(w.repos.navPoints.history(A, 0, w.clock.now())).toHaveLength(2);
    expect(autoCover).toHaveBeenCalledTimes(3);
  });

  it('freezes NAV while idle or when marks are older than 10 s', () => {
    const { w, loop } = setup();
    const rt = addCompany(w, {
      id: A,
      ticker: 'AAA',
      positions: [pos('BTC', 1, 100)],
      accountValue: 1_000,
    });
    w.state.setMarks({ BTC: 150 }, w.clock.now() - 11_000);
    loop.tick(w.clock.now());
    expect(rt.nav.nav).toBe(100);
    expect(w.state.flags.marksDelayed).toBe(true);
    expect(w.events.some((e) => e.t === 'status')).toBe(true);
    w.state.setMarks({ BTC: 150 }, w.clock.now());
    w.state.flags.idle = true;
    loop.tick(w.clock.now());
    expect(rt.nav.nav).toBe(100);
    w.state.flags.idle = false;
    loop.tick(w.clock.now());
    expect(rt.nav.nav).toBeCloseTo(105, 8);
  });

  it('decays the hype multiplier toward 1', () => {
    const { w, loop } = setup();
    const rt = addCompany(w, { id: A, ticker: 'AAA' });
    rt.pool = { x: 4_000, y: 6_000, l0: 5_000 };
    w.state.setMarks({}, w.clock.now());
    loop.tick(w.clock.now());
    w.clock.advance(3_600_000);
    w.state.setMarks({}, w.clock.now());
    loop.tick(w.clock.now());
    expect(multiplier(rt.pool)).toBeLessThan(1.5);
    expect(multiplier(rt.pool)).toBeGreaterThan(1);
  });

  it('files a MARGIN_CALL when HP crosses below 10%', () => {
    const { w, loop } = setup();
    addCompany(w, {
      id: A,
      ticker: 'AAA',
      positions: [pos('ETH', 10, 100, 80)],
      accountValue: 100_000,
    });
    w.state.setMarks({ ETH: 95 }, w.clock.now());
    loop.tick(w.clock.now());
    w.state.setMarks({ ETH: 81 }, w.clock.now());
    loop.tick(w.clock.now());
    const kinds = w.repos.filings.recent(10).map((f) => f.kind);
    expect(kinds).toEqual(['MARGIN_CALL']);
  });

  it('halts on an unresolved trigger, on stale data, and on low equity — with visible reasons', () => {
    const { w, loop } = setup();
    const a = addCompany(w, { id: A, ticker: 'AAA' });
    const b = addCompany(w, { id: B, ticker: 'BBB' });
    a.pendingTriggerAt = w.clock.now();
    w.clock.advance(121_000);
    w.state.setMarks({}, w.clock.now());
    loop.tick(w.clock.now());
    expect(a.status).toBe('HALTED');
    expect(a.haltReason).toBe('triggered refresh unresolved for 120 s');
    expect(b.status).toBe('ACTIVE');

    w.clock.advance(1_800_000);
    w.state.setMarks({}, w.clock.now());
    loop.tick(w.clock.now());
    expect(b.status).toBe('HALTED');
    expect(b.haltKind).toBe('data');
    expect(w.repos.companies.get(B)?.haltReason).toBe('no fresh snapshot for 30 min');

    const w2 = setup();
    const c = addCompany(w2.w, { id: A, ticker: 'CCC', accountValue: 900 });
    w2.w.state.setMarks({}, w2.w.clock.now());
    w2.loop.tick(w2.w.clock.now());
    expect(c.status).toBe('HALTED');
    expect(c.haltKind).toBe('equity');
    expect(w2.w.repos.filings.recent(5).map((f) => f.detail)).toEqual(['equity below $1,000']);
  });

  it('does not stale-halt while idle and restarts the timer on wake', () => {
    const { w, loop } = setup();
    const a = addCompany(w, { id: A, ticker: 'AAA' });
    w.state.flags.idle = true;
    w.clock.advance(3_600_000);
    w.state.setMarks({}, w.clock.now());
    loop.tick(w.clock.now());
    expect(a.status).toBe('ACTIVE');
    w.state.flags.idle = false;
    w.state.flags.wokeAt = w.clock.now();
    loop.tick(w.clock.now());
    expect(a.status).toBe('ACTIVE');
  });

  it('does not halt on an unresolved trigger while idle (refreshes are skipped then)', () => {
    const { w, loop } = setup();
    const a = addCompany(w, { id: A, ticker: 'AAA' });
    a.pendingTriggerAt = w.clock.now();
    w.state.flags.idle = true;
    w.clock.advance(121_000);
    w.state.setMarks({}, w.clock.now());
    loop.tick(w.clock.now());
    expect(a.status).toBe('ACTIVE');
    expect(w.repos.filings.recent(5)).toEqual([]);
  });

  it('persisted rows round-trip into runtime', () => {
    const { w } = setup();
    const a = addCompany(w, { id: A, ticker: 'AAA', positions: [pos('BTC', 1, 100)] });
    const row = w.repos.companies.get(A);
    if (!row) throw new Error('missing row');
    const back = runtimeFromRow(row);
    expect(back.nav).toEqual(a.nav);
    expect(back.pool).toEqual(a.pool);
    expect(back.lastSnapshotAt).toBe(a.nav.snapshot.fetchedAt);
  });
});
