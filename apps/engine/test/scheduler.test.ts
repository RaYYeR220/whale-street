import { describe, expect, it, vi } from 'vitest';
import { createIdleGate, IDLE_AFTER_MS } from '../src/ingest/idle';
import type { Refresher } from '../src/ingest/refresh';
import {
  createScheduler,
  HEARTBEAT_MS,
  MOOD_EVERY_MS,
  TRIGGER_DEBOUNCE_MS,
} from '../src/ingest/scheduler';
import { silentLogger } from '../src/log';
import { FakeFeed, hlTrade } from './helpers/fake-hl';
import { addCompany, makeWorld, pos } from './helpers/world';

const A = '0x00000000000000000000000000000000000000a1' as const;
const B = '0x00000000000000000000000000000000000000b2' as const;
const OTHER = '0x00000000000000000000000000000000000000ff';

function setup() {
  const w = makeWorld();
  const feed = new FakeFeed();
  const refresh = vi.fn<Refresher['refresh']>(async () => ({ kind: 'ok' }));
  const refresher: Refresher = { refresh, pending: () => [] };
  const credits = vi.fn(async () => {});
  const mood = vi.fn(async () => {});
  const scout = vi.fn(async () => {});
  const tracked: Promise<unknown>[] = [];
  const scheduler = createScheduler({
    ...w,
    refresher,
    feed,
    log: silentLogger,
    credits,
    mood,
    scout,
    track: (p) => tracked.push(p),
  });
  const a = addCompany(w, { id: A, ticker: 'AAA', positions: [pos('BTC', 1, 60_000)] });
  const b = addCompany(w, { id: B, ticker: 'BBB', positions: [pos('ETH', -3, 3_000)] });
  scheduler.start(w.clock.now());
  const tickFor = (ms: number, step = 1_000) => {
    for (let t = 0; t < ms; t += step) {
      w.clock.advance(step);
      scheduler.onTick(w.clock.now());
    }
  };
  const flush = () => Promise.all(tracked.splice(0));
  return { w, feed, refresh, credits, mood, scout, scheduler, a, b, tickFor, flush };
}

const calls = (refresh: ReturnType<typeof setup>['refresh'], reason: string) =>
  refresh.mock.calls.filter((c) => c[1] === reason).map((c) => c[0]);

describe('scheduler', () => {
  it('routes HL mids into the market state', () => {
    const { w, feed } = setup();
    feed.emitMids({ BTC: 61_000 }, 123);
    expect(w.state.marks.BTC).toBe(61_000);
    expect(w.state.marksAt).toBe(w.clock.now());
  });

  it('a trade by a listed address marks the trigger and refreshes once after the 10 s debounce', () => {
    const { w, feed, refresh, a, scheduler, tickFor } = setup();
    feed.emitTrades([hlTrade('BTC', [A, OTHER]), hlTrade('BTC', [OTHER, A])]);
    expect(a.pendingTriggerAt).toBe(w.clock.now());
    scheduler.onTick(w.clock.now());
    expect(calls(refresh, 'trigger')).toEqual([]);
    tickFor(TRIGGER_DEBOUNCE_MS);
    expect(calls(refresh, 'trigger')).toEqual([A]);
    tickFor(30_000);
    expect(calls(refresh, 'trigger')).toEqual([A]);
  });

  it('ignores trades while idle', () => {
    const { w, feed, a, refresh, tickFor } = setup();
    w.state.flags.idle = true;
    feed.emitTrades([hlTrade('BTC', [A, OTHER])]);
    tickFor(20_000);
    expect(a.pendingTriggerAt).toBeNull();
    expect(calls(refresh, 'trigger')).toEqual([]);
  });

  it('heartbeats every company once per 12 minutes, staggered, and skips them while idle', () => {
    const { w, refresh, tickFor } = setup();
    tickFor(HEARTBEAT_MS + 1_000, 5_000);
    expect(calls(refresh, 'heartbeat').sort()).toEqual([A, B]);
    tickFor(HEARTBEAT_MS, 5_000);
    expect(calls(refresh, 'heartbeat')).toHaveLength(4);
    w.state.flags.idle = true;
    tickFor(HEARTBEAT_MS, 5_000);
    expect(calls(refresh, 'heartbeat')).toHaveLength(4);
  });

  it('subscribes HL trades for held coins plus mood coins', () => {
    const { w, feed, scheduler } = setup();
    scheduler.onTick(w.clock.now());
    expect(feed.coins).toEqual(['BTC', 'ETH']);
  });

  it('wake staggers a catch-up refresh of every listed company', () => {
    const { w, refresh, scheduler, tickFor } = setup();
    scheduler.wake(w.clock.now());
    scheduler.onTick(w.clock.now());
    expect(calls(refresh, 'wake')).toEqual([A]);
    tickFor(3_000);
    expect(calls(refresh, 'wake')).toEqual([A, B]);
  });

  it('runs credit, mood and scout jobs on start and on their cadence, never while idle', async () => {
    const { w, credits, mood, scout, scheduler, tickFor, flush } = setup();
    scheduler.onTick(w.clock.now());
    expect([credits.mock.calls.length, mood.mock.calls.length, scout.mock.calls.length]).toEqual([
      1, 1, 1,
    ]);
    await flush();
    tickFor(MOOD_EVERY_MS, 60_000);
    await flush();
    expect(mood.mock.calls.length).toBe(2);
    expect(credits.mock.calls.length).toBe(2);
    w.state.flags.idle = true;
    tickFor(MOOD_EVERY_MS, 60_000);
    expect(mood.mock.calls.length).toBe(2);
  });
});

describe('idle gate', () => {
  it('goes IDLE 120 s after the last viewer leaves and wakes on the next one', () => {
    const w = makeWorld();
    const onWake = vi.fn();
    const gate = createIdleGate(w.state, w.bus, onWake, w.clock.now());
    gate.clientConnected(w.clock.now());
    w.clock.advance(IDLE_AFTER_MS * 2);
    gate.tick(w.clock.now());
    expect(w.state.flags.idle).toBe(false);
    gate.clientDisconnected(w.clock.now());
    w.clock.advance(IDLE_AFTER_MS - 1);
    gate.tick(w.clock.now());
    expect(w.state.flags.idle).toBe(false);
    w.clock.advance(1);
    gate.tick(w.clock.now());
    expect(w.state.flags.idle).toBe(true);
    gate.clientConnected(w.clock.now());
    expect(w.state.flags.idle).toBe(false);
    expect(w.state.flags.wokeAt).toBe(w.clock.now());
    expect(onWake).toHaveBeenCalledWith(w.clock.now());
    expect(gate.clients()).toBe(1);
  });

  it('activity (an authenticated write) wakes it and holds IDLE off for the same window', () => {
    const w = makeWorld();
    const onWake = vi.fn();
    const gate = createIdleGate(w.state, w.bus, onWake, w.clock.now());
    w.clock.advance(IDLE_AFTER_MS);
    gate.tick(w.clock.now());
    expect(w.state.flags.idle).toBe(true);
    gate.touch(w.clock.now());
    expect(w.state.flags.idle).toBe(false);
    expect(w.state.flags.wokeAt).toBe(w.clock.now());
    expect(onWake).toHaveBeenCalledTimes(1);
    // Woken, but NAV has not ticked since: orders stay paused until the next live tick.
    expect(w.state.paused()).toBe(true);
    expect(gate.clients()).toBe(0);
    w.clock.advance(IDLE_AFTER_MS - 1);
    gate.tick(w.clock.now());
    expect(w.state.flags.idle).toBe(false);
    gate.touch(w.clock.now());
    expect(onWake).toHaveBeenCalledTimes(1);
    w.clock.advance(IDLE_AFTER_MS - 1);
    gate.tick(w.clock.now());
    expect(w.state.flags.idle).toBe(false);
    w.clock.advance(1);
    gate.tick(w.clock.now());
    expect(w.state.flags.idle).toBe(true);
  });
});
