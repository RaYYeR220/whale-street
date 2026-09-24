import { describe, expect, it, vi } from 'vitest';
import { HOUR_MS, MINUTE_MS } from '../src/dates';
import { openDb } from '../src/db/index';
import { createRepos } from '../src/db/repos';
import {
  CREDIT_ALARM_DEBOUNCE_MS,
  createCreditMonitor,
  isCreditError,
} from '../src/ingest/credits';
import { IDLE_AFTER_MS } from '../src/ingest/idle';
import { MOOD_LAST_KEY, refreshMood, topCoinsByNotional } from '../src/ingest/mood';
import { MOOD_EVERY_MS } from '../src/ingest/scheduler';
import { runScout, SCOUT_LAST_KEY, SCOUT_MAX_EVALUATIONS } from '../src/ingest/scout';
import { silentLogger } from '../src/log';
import { deniedKey } from '../src/services/ipo';
import { createListingService } from '../src/services/listing';
import { testEngine } from './helpers/engine';
import { T0 } from './helpers/fake-clock';
import { FakeInfo } from './helpers/fake-hl';
import { FakeNansen, fail } from './helpers/fake-nansen';
import { programCleanTrader, programHedgedTrader } from './helpers/traders';
import { addCompany, makeWorld, pos } from './helpers/world';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;

describe('credit monitor', () => {
  it('switches credit-saver below 1,500 and the floor below 200, visibly', async () => {
    const w = makeWorld();
    const nansen = new FakeNansen();
    const monitor = createCreditMonitor({ ...w, nansen, log: silentLogger });
    nansen.accountInfo = { plan: 'free', creditsRemaining: 5_000 };
    await monitor.check();
    expect(w.state.flags).toMatchObject({
      creditSaver: false,
      creditFloor: false,
      creditsRemaining: 5_000,
    });
    nansen.accountInfo = { plan: 'free', creditsRemaining: 1_499 };
    await monitor.check();
    expect(w.state.flags).toMatchObject({ creditSaver: true, creditFloor: false });
    nansen.accountInfo = { plan: 'free', creditsRemaining: 150 };
    await monitor.check();
    expect(w.state.flags).toMatchObject({ creditSaver: true, creditFloor: true });
    expect(w.events.filter((e) => e.t === 'status')).toHaveLength(3);
    nansen.accountInfo = fail('timeout');
    await monitor.check();
    expect(w.state.flags.creditsRemaining).toBe(150);
    expect(w.repos.kv.getJson('credits')).toMatchObject({ remaining: 150 });
  });

  it('recognises a refusal for credits by status 402 or by the insufficient_credits code', () => {
    const r = (status: number | null, error: string) =>
      ({ ok: false, error, status, callId: 'nc_x' }) as const;
    expect(isCreditError(r(402, 'HTTP 402: payment required'))).toBe(true);
    expect(isCreditError(r(403, 'HTTP 403: insufficient_credits'))).toBe(true);
    expect(isCreditError(r(500, 'HTTP 500: Insufficient credits'))).toBe(true);
    expect(isCreditError(r(500, 'HTTP 500: upstream error'))).toBe(false);
    expect(isCreditError(r(null, 'timeout'))).toBe(false);
  });

  it('an alarm checks the account at once, one check per burst', async () => {
    const w = makeWorld();
    const nansen = new FakeNansen();
    const tracked: Promise<unknown>[] = [];
    const monitor = createCreditMonitor({
      ...w,
      nansen,
      log: silentLogger,
      track: (p) => tracked.push(p),
    });
    nansen.accountInfo = { plan: 'free', creditsRemaining: 120 };
    monitor.alarm();
    monitor.alarm();
    monitor.alarm();
    await Promise.all(tracked);
    expect(nansen.count('account')).toBe(1);
    expect(w.state.flags).toMatchObject({
      creditSaver: true,
      creditFloor: true,
      creditsRemaining: 120,
    });
    w.clock.advance(CREDIT_ALARM_DEBOUNCE_MS - 1);
    monitor.alarm();
    await Promise.all(tracked);
    expect(nansen.count('account')).toBe(1);
    w.clock.advance(1);
    monitor.alarm();
    await Promise.all(tracked);
    expect(nansen.count('account')).toBe(2);
  });

  it('enters credit-saver when the account check fails after a credit error (fail closed)', async () => {
    const w = makeWorld();
    const nansen = new FakeNansen();
    const tracked: Promise<unknown>[] = [];
    const monitor = createCreditMonitor({
      ...w,
      nansen,
      log: silentLogger,
      track: (p) => tracked.push(p),
    });
    nansen.accountInfo = fail('timeout', null);
    monitor.alarm();
    await Promise.all(tracked);
    expect(w.state.flags).toMatchObject({ creditSaver: true, creditFloor: false });
    expect(w.events.filter((e) => e.t === 'status')).toHaveLength(1);
  });

  it('a data call refused for credits triggers the account check without waiting for its cadence', async () => {
    const t = await testEngine({ mode: 'live' });
    const e = t.engine;
    addCompany(e, { id: addr(1), ticker: 'AAA' });
    addCompany(e, { id: addr(2), ticker: 'BBB' });
    e.tick();
    await e.settle();
    expect(t.nansen.count('account')).toBe(1);
    expect(e.state.flags.creditSaver).toBe(false);
    t.clock.advance(60_000);
    const noCredits = fail('HTTP 402: insufficient_credits', 402);
    t.nansen.positions.set(addr(1), noCredits);
    t.nansen.positions.set(addr(2), noCredits);
    t.nansen.accountInfo = { plan: 'free', creditsRemaining: 90 };
    await Promise.all([
      e.refresher.refresh(addr(1), 'heartbeat'),
      e.refresher.refresh(addr(2), 'heartbeat'),
    ]);
    await e.settle();
    expect(t.nansen.count('account')).toBe(2);
    expect(e.state.flags).toMatchObject({
      creditSaver: true,
      creditFloor: true,
      creditsRemaining: 90,
    });
    await t.app.close();
  });
});

describe('street mood', () => {
  it('fetches cohort positioning for the top coins by listed notional', async () => {
    const w = makeWorld();
    const nansen = new FakeNansen();
    addCompany(w, {
      id: addr(1),
      ticker: 'AAA',
      positions: [pos('BTC', 1, 60_000), pos('DOGE', 1_000, 0.1)],
    });
    addCompany(w, { id: addr(2), ticker: 'BBB', positions: [pos('ETH', -30, 3_000)] });
    expect(topCoinsByNotional(w.state)).toEqual(['ETH', 'BTC', 'DOGE']);
    nansen.cohorts.set('BTC', {
      smartLongs: 10,
      smartShorts: 2,
      whaleLongs: 0,
      whaleShorts: 0,
      publicLongs: 0,
      publicShorts: 0,
    });
    await refreshMood({ ...w, nansen, log: silentLogger });
    expect([...w.state.mood.keys()]).toEqual(['BTC']);
    expect(nansen.count('positionIntelligence')).toBe(3);
    expect(w.state.moodAt).toBe(w.clock.now());
  });
});

describe('scout', () => {
  function setup(target = 3) {
    const w = makeWorld();
    const nansen = new FakeNansen();
    const info = new FakeInfo();
    const listing = createListingService({ ...w, nansen });
    const run = () =>
      runScout({ ...w, nansen, info, listing, log: silentLogger, targetCompanies: target });
    return { w, nansen, info, run };
  }

  it('lists approved candidates from the leaderboard and smart-money trades, remembers denials', async () => {
    const { w, nansen, info, run } = setup(2);
    const now = w.clock.now();
    programCleanTrader(nansen, info, addr(1), now);
    programHedgedTrader(nansen, info, addr(2), addr(99), now);
    programCleanTrader(nansen, info, addr(3), now);
    nansen.leaderboard = [
      { address: addr(1), totalPnl: 1, roi: 1, accountValue: 600_000, totalTrades: 10 },
      { address: addr(4), totalPnl: 1, roi: 1, accountValue: 1_000, totalTrades: 10 },
      { address: addr(2), totalPnl: 1, roi: 1, accountValue: null, totalTrades: 10 },
    ];
    nansen.smTrades = [
      { address: addr(3), coin: 'BTC', side: 'Long', action: 'Open', valueUsd: 1, at: now },
    ];
    const r = await run();
    expect(r.evaluated).toBe(3);
    expect(r.listed).toHaveLength(2);
    expect(w.state.get(addr(1))?.source).toBe('SCOUT');
    expect(w.state.get(addr(3))?.source).toBe('SCOUT');
    expect(w.state.get(addr(4))).toBeUndefined();
    expect(w.repos.kv.get(deniedKey(addr(2)))).toBe(String(now));
  });

  it('lists a trader whose Nansen positions include a closed coin at zero size', async () => {
    const { w, nansen, info, run } = setup(1);
    const now = w.clock.now();
    programCleanTrader(nansen, info, addr(1), now);
    nansen.positions.set(addr(1), {
      positions: [pos('BTC', 2, 60_000, 40_000), pos('ETH', 0, 3_000)],
      accountValue: 600_000,
      time: null,
    });
    nansen.leaderboard = [
      { address: addr(1), totalPnl: 1, roi: 1, accountValue: 600_000, totalTrades: 10 },
    ];
    expect((await run()).listed).toHaveLength(1);
    expect(w.state.get(addr(1))?.nav.snapshot.positions.map((p) => p.coin)).toEqual(['BTC']);
  });

  it('never stores raw leaderboard data', async () => {
    const { w, nansen, run } = setup(1);
    nansen.leaderboard = [
      { address: addr(7), totalPnl: 123_456_789, roi: 42, accountValue: 999_999, totalTrades: 77 },
    ];
    await run();
    const dump = JSON.stringify([
      w.repos.companies.all(),
      w.repos.filings.recent(100),
      w.repos.kv.get('scout:last'),
    ]);
    expect(dump).not.toContain('123456789');
    expect(dump).not.toContain('999999');
  });

  it('skips listed, cooling-down and recently denied addresses; caps evaluations per run', async () => {
    const { w, nansen, run } = setup(20);
    const now = w.clock.now();
    addCompany(w, { id: addr(1), ticker: 'AAA' });
    w.repos.kv.set(deniedKey(addr(2)), String(now - 86_400_000));
    nansen.leaderboard = Array.from({ length: 10 }, (_, i) => ({
      address: addr(i + 1),
      totalPnl: 1,
      roi: 1,
      accountValue: null,
      totalTrades: 1,
    }));
    const r = await run();
    expect(r.evaluated).toBe(SCOUT_MAX_EVALUATIONS);
    const evaluated = nansen.calls
      .filter((c) => c.method === 'perpPnlSummary')
      .map((c) => c.args[0]);
    expect(evaluated).not.toContain(addr(1));
    expect(evaluated).not.toContain(addr(2));
  });

  it('does nothing below the credit floor or when the target is met', async () => {
    const a = setup(1);
    a.w.state.flags.creditFloor = true;
    expect(await a.run()).toEqual({ evaluated: 0, listed: [] });
    expect(a.nansen.calls).toHaveLength(0);
    const b = setup(1);
    addCompany(b.w, { id: addr(1), ticker: 'AAA' });
    expect(await b.run()).toEqual({ evaluated: 0, listed: [] });
    expect(b.nansen.calls).toHaveLength(0);
  });
});

describe('boot-time job seeding', () => {
  it('first boot runs scout and mood (recording mood:last); a restart after recent runs calls neither', async () => {
    const first = await testEngine({ mode: 'live' });
    addCompany(first.engine, { id: addr(1), ticker: 'AAA', positions: [pos('BTC', 1, 60_000)] });
    first.engine.tick();
    await first.engine.settle();
    expect(first.nansen.count('perpLeaderboard')).toBe(1);
    expect(first.nansen.count('positionIntelligence')).toBe(1);
    expect(first.engine.repos.kv.get(MOOD_LAST_KEY)).toBe(String(first.clock.now()));
    await first.app.close();

    const db = openDb(':memory:');
    const repos = createRepos(db);
    repos.kv.set(SCOUT_LAST_KEY, String(T0 - HOUR_MS));
    repos.kv.set(MOOD_LAST_KEY, String(T0 - 5 * MINUTE_MS));
    const restart = await testEngine({ mode: 'live', db });
    addCompany(restart.engine, { id: addr(1), ticker: 'AAA', positions: [pos('BTC', 1, 60_000)] });
    restart.engine.tick();
    await restart.engine.settle();
    expect(restart.nansen.count('perpLeaderboard')).toBe(0);
    expect(restart.nansen.count('smartMoneyPerpTrades')).toBe(0);
    expect(restart.nansen.count('positionIntelligence')).toBe(0);
    await restart.app.close();
  });
});

describe('waking from IDLE', () => {
  it('two wakes within 3 minutes spend once: no second catch-up refresh and no forced mood', async () => {
    const t = await testEngine({ mode: 'live' });
    const e = t.engine;
    const positions = [pos('BTC', 1, 60_000)];
    addCompany(e, { id: addr(1), ticker: 'AAA', positions });
    t.nansen.positions.set(addr(1), { positions, accountValue: 50_000, time: null });
    const refresh = vi.spyOn(e.refresher, 'refresh');
    const wakes = () => refresh.mock.calls.filter((c) => c[1] === 'wake').length;
    const moods = () => t.nansen.count('positionIntelligence');
    const run = async (ms: number) => {
      for (let i = 0; i < ms; i += 1_000) {
        t.clock.advance(1_000);
        e.state.setMarks({ BTC: 60_000 }, t.clock.now());
        e.tick();
      }
      await e.settle();
    };
    e.tick();
    await e.settle();
    expect(moods()).toBe(1);

    // IDLE for longer than the mood cadence: the first wake refreshes the old snapshot and the mood.
    await run(IDLE_AFTER_MS + MOOD_EVERY_MS);
    expect(e.state.flags.idle).toBe(true);
    e.idle.touch(t.clock.now());
    await run(10_000);
    expect([wakes(), moods()]).toEqual([1, 2]);
    const positionCalls = t.nansen.count('perpPositions');

    // IDLE again and woken again 130 s later: everything is still fresh, nothing is spent.
    await run(IDLE_AFTER_MS);
    expect(e.state.flags.idle).toBe(true);
    e.idle.touch(t.clock.now());
    await run(10_000);
    expect([wakes(), moods()]).toEqual([1, 2]);
    expect(t.nansen.count('perpPositions')).toBe(positionCalls);
    await t.app.close();
  });
});
