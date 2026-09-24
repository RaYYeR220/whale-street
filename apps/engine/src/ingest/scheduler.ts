import { hash32 } from '@whale-street/core';
import type { HlFeed, HlTrade } from '@whale-street/hl';
import type { Clock } from '../clock';
import { HOUR_MS, MINUTE_MS } from '../dates';
import type { Logger } from '../log';
import type { MarketState } from '../market/state';
import { topCoinsByNotional } from './mood';
import type { Refresher } from './refresh';

export const HEARTBEAT_MS = 12 * MINUTE_MS;
export const TRIGGER_DEBOUNCE_MS = 10_000;
export const WAKE_STAGGER_MS = 3_000;
export const COIN_SYNC_MS = 10_000;
export const CREDIT_CHECK_MS = 10 * MINUTE_MS;
export const MOOD_EVERY_MS = 15 * MINUTE_MS;
export const SCOUT_EVERY_MS = 3 * HOUR_MS;

export type Job = () => Promise<unknown>;

export interface SchedulerDeps {
  state: MarketState;
  refresher: Refresher;
  feed: HlFeed;
  clock: Clock;
  log: Logger;
  /** Periodic jobs; null disables one (e.g. REPLAY has no credit check or scout). */
  credits: Job | null;
  mood: Job | null;
  scout: Job | null;
  /** Registers background work so tests and shutdown can await it. */
  track: (p: Promise<unknown>) => void;
  /**
   * Engine-clock times of the last scout / mood runs (persisted in kv): a restart schedules the
   * next run a full period after them instead of spending credits at every boot. null = never.
   */
  lastRun?: { scout: number | null; mood: number | null };
}

export interface Scheduler {
  start(now: number): void;
  stop(): void;
  onTick(now: number): void;
  /** First viewer after IDLE: staggered catch-up refresh of every listed company. */
  wake(now: number): void;
  /**
   * Forgets every due time (triggers, wake-ups, heartbeats, periodic jobs) and restarts the
   * schedule from `now`. REPLAY calls it on a loop wrap: the virtual clock jumps back, so due
   * times from the previous loop would otherwise lie beyond the loop's end and never fire.
   */
  reset(now: number): void;
}

/** Due time one period after the last run (at most one period from now); now when never run. */
const afterLast = (last: number | null, every: number, now: number): number =>
  last === null ? now : Math.min(last, now) + every;

export function createScheduler(d: SchedulerDeps): Scheduler {
  const triggerDue = new Map<string, number>();
  const wakeDue = new Map<string, number>();
  const nextBeat = new Map<string, number>();
  const busy = new Set<string>();
  const next = { coins: 0, credits: 0, mood: 0, scout: 0 };
  const unsubs: Array<() => void> = [];

  const runJob = (name: string, job: Job | null) => {
    if (!job || busy.has(name)) return;
    busy.add(name);
    d.track(
      job()
        .catch((err: unknown) => d.log.error('job failed', { job: name, error: String(err) }))
        .finally(() => busy.delete(name)),
    );
  };

  const refresh = (id: string, reason: 'trigger' | 'wake' | 'heartbeat') =>
    d.track(d.refresher.refresh(id, reason));

  const onTrades = (trades: HlTrade[]) => {
    if (d.state.flags.idle) return;
    const now = d.clock.now();
    for (const t of trades) {
      for (const user of t.users) {
        const rt = d.state.get(user);
        if (!rt || (rt.status !== 'ACTIVE' && rt.status !== 'HALTED')) continue;
        if (!triggerDue.has(rt.id)) triggerDue.set(rt.id, now + TRIGGER_DEBOUNCE_MS);
        if (rt.pendingTriggerAt === null) rt.pendingTriggerAt = now;
      }
    }
  };

  return {
    start(now) {
      next.coins = now;
      next.credits = now;
      next.mood = afterLast(d.lastRun?.mood ?? null, MOOD_EVERY_MS, now);
      next.scout = afterLast(d.lastRun?.scout ?? null, SCOUT_EVERY_MS, now);
      unsubs.push(d.feed.onMids((m) => d.state.setMarks(m, d.clock.now())));
      unsubs.push(d.feed.onTrades(onTrades));
    },
    stop() {
      for (const u of unsubs.splice(0)) u();
    },
    wake(now) {
      d.state.listed().forEach((rt, i) => {
        wakeDue.set(rt.id, now + i * WAKE_STAGGER_MS);
      });
      next.mood = now;
    },
    reset(now) {
      triggerDue.clear();
      wakeDue.clear();
      nextBeat.clear();
      next.coins = now;
      next.credits = now;
      next.mood = now;
      next.scout = now;
    },
    onTick(now) {
      const idle = d.state.flags.idle;

      if (now >= next.coins) {
        next.coins = now + COIN_SYNC_MS;
        const coins = new Set([...d.state.heldCoins(), ...topCoinsByNotional(d.state)]);
        d.feed.setTradeCoins([...coins].sort());
      }

      for (const [id, due] of triggerDue) {
        if (now < due) continue;
        triggerDue.delete(id);
        refresh(id, 'trigger');
      }
      for (const [id, due] of wakeDue) {
        if (now < due) continue;
        wakeDue.delete(id);
        refresh(id, 'wake');
      }
      for (const rt of d.state.listed()) {
        const beat = nextBeat.get(rt.id);
        if (beat === undefined) {
          nextBeat.set(rt.id, now + Math.floor((HEARTBEAT_MS * (hash32(rt.id) % 1_000)) / 1_000));
          continue;
        }
        if (now < beat) continue;
        nextBeat.set(rt.id, now + HEARTBEAT_MS);
        if (!idle) refresh(rt.id, 'heartbeat');
      }

      if (idle) return;
      if (now >= next.credits) {
        next.credits = now + CREDIT_CHECK_MS;
        runJob('credits', d.credits);
      }
      if (now >= next.mood) {
        next.mood = now + MOOD_EVERY_MS;
        runJob('mood', d.mood);
      }
      if (now >= next.scout) {
        next.scout = now + SCOUT_EVERY_MS;
        runJob('scout', d.scout);
      }
    },
  };
}
