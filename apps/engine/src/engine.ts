import { PARAMS, type Params } from '@whale-street/core';
import { createBotRunner, momentumLookbackMs } from './bots/runner';
import type { Clock } from './clock';
import type { Config } from './config';
import { DAY_MS } from './dates';
import type { Db } from './db/index';
import { createRepos, type Repos } from './db/repos';
import { EventBus } from './events';
import { createCreditMonitor, withCreditAlarm } from './ingest/credits';
import { createIdleGate, type IdleGate } from './ingest/idle';
import { MOOD_LAST_KEY, refreshMood, restoreMood, saveMood } from './ingest/mood';
import { createRefresher, type Refresher } from './ingest/refresh';
import { createScheduler, type Scheduler } from './ingest/scheduler';
import { runScout, SCOUT_LAST_KEY } from './ingest/scout';
import type { Logger } from './log';
import { createMarketLoop } from './market/loop';
import { MarketState, runtimeFromRow } from './market/state';
import { createStatusOps, type StatusOps } from './market/status';
import type { HlPorts, NansenPort, TradingPort } from './ports';
import { type BankruptcyService, createBankruptcyService } from './services/bankruptcy';
import { createExchange, type ExchangeService } from './services/exchange';
import { createFilingService, type FilingService } from './services/filings';
import { createIpoService, type IpoService } from './services/ipo';
import { createListingService, type ListingService } from './services/listing';
import { createMirrorService, type MirrorService } from './services/mirror';
import { createPlayersService, type PlayersService } from './services/players';
import { createSeasonService, type SeasonService } from './services/seasons';

/** REPLAY wiring supplied by main.ts (see replay/). */
export interface ReplayRuntime {
  recordedAt: number;
  /** True for the synthetic demo session (no recording available). */
  synthetic: boolean;
  knownAddresses: ReadonlySet<string>;
  /** Engine-clock bounds of the recording; the REPLAY clock loops over [startT, endT). */
  readonly startT: number;
  readonly endT: number;
  /** How many times the loop has wrapped since boot (0 in the first pass). */
  loopIndex(): number;
  /** Called first in every tick: advances the replay feed and street mood, detects loop wraps. */
  advance(): void;
}

export interface EngineDeps {
  config: Config;
  db: Db;
  nansen: NansenPort;
  trading: TradingPort | null;
  hl: HlPorts;
  clock: Clock;
  log: Logger;
  replay: ReplayRuntime | null;
  params?: Params;
  /**
   * Monotonic wall clock for anti-abuse windows (rate gates, per-hour caps, nonce TTLs) and
   * presentation throttles: it never loops, unlike the REPLAY clock. Defaults to `clock.now`
   * (identical in LIVE); REPLAY passes the real wall clock.
   */
  wallNow?: () => number;
}

export interface StatusView {
  mode: 'live' | 'replay';
  recordedAt: number | null;
  synthetic: boolean;
  idle: boolean;
  creditSaver: boolean;
  creditFloor: boolean;
  creditsRemaining: number | null;
  marksDelayed: boolean;
  season: { id: number; endsAt: number } | null;
  companies: number;
  viewers: number;
  /**
   * Engine clock (ms). In REPLAY every engine timestamp (filings, trades, createdAt, season end)
   * is recording time, and repeats each loop.
   */
  now: number;
  /** REPLAY: the loop being played (index counts wraps since boot); null in LIVE. */
  loop: { index: number; startT: number; endT: number } | null;
}

export interface Engine {
  readonly config: Config;
  readonly clock: Clock;
  /** Wall time for rate gates and caps (see EngineDeps.wallNow); never the looping REPLAY clock. */
  wallNow(): number;
  readonly log: Logger;
  readonly params: Params;
  readonly repos: Repos;
  readonly bus: EventBus;
  readonly state: MarketState;
  readonly nansen: NansenPort;
  readonly trading: TradingPort | null;
  readonly hl: HlPorts;
  readonly replay: ReplayRuntime | null;
  readonly filings: FilingService;
  readonly statusOps: StatusOps;
  readonly bankruptcy: BankruptcyService;
  readonly refresher: Refresher;
  readonly listing: ListingService;
  readonly ipo: IpoService;
  readonly players: PlayersService;
  readonly seasons: SeasonService;
  readonly exchange: ExchangeService;
  readonly mirror: MirrorService;
  readonly idle: IdleGate;
  readonly scheduler: Scheduler;
  /** One 1 Hz step: replay advance → idle gate → scheduler → market loop → bots → season rollover. */
  tick(): void;
  /**
   * REPLAY loop wrap: re-bases every timer kept in engine-clock time (scheduler due times,
   * heartbeats, bot decision times, the idle gate, the marks timestamp) on the rewound clock.
   */
  resetTimers(now: number): void;
  /** Starts the HL feed and the 1 Hz interval. */
  start(): void;
  stop(): Promise<void>;
  /** Registers background work; settle() awaits it. */
  track(p: Promise<unknown>): void;
  settle(): Promise<void>;
  status(): StatusView;
}

export function createEngine(deps: EngineDeps): Engine {
  const { config, clock, log, hl } = deps;
  const params = deps.params ?? PARAMS;
  const wallNow = deps.wallNow ?? (() => clock.now());
  const now = clock.now();
  const repos = createRepos(deps.db);
  const bus = new EventBus(log);
  const state = new MarketState(now);
  for (const row of repos.companies.all()) {
    if (row.status !== 'DELISTED' || (row.delistedAt ?? 0) > now - DAY_MS)
      state.add(runtimeFromRow(row));
  }

  const tasks = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => {
    tasks.add(p);
    void p.catch(() => {}).finally(() => tasks.delete(p));
  };

  const live = config.mode === 'live';
  // The last street mood, so the panel is not empty until the next refresh (REPLAY replays its own).
  if (live) restoreMood(repos, state);
  const credits = live
    ? createCreditMonitor({ nansen: deps.nansen, state, repos, bus, clock, log, track })
    : null;
  // Every data call reports a refusal for credits to the monitor, which checks the account at once.
  const nansen = credits ? withCreditAlarm(deps.nansen, () => credits.alarm()) : deps.nansen;

  const filings = createFilingService(repos, state, bus);
  const statusOps = createStatusOps(repos, filings);
  const bankruptcy = createBankruptcyService({ repos, filings, statusOps, bus, params, log });
  const refresher = createRefresher({
    state,
    filings,
    statusOps,
    bankruptcy,
    nansen,
    info: hl.info,
    clock,
    log,
    params,
  });
  const listing = createListingService({ state, repos, filings, statusOps, nansen, clock, params });
  const ipo = createIpoService({
    state,
    repos,
    bus,
    clock,
    log,
    nansen,
    info: hl.info,
    listing,
    knownAddresses: deps.replay?.knownAddresses ?? null,
    params,
    wallNow,
  });
  const players = createPlayersService({ repos, clock, origins: config.corsOrigins, wallNow });
  const seasons = createSeasonService({ repos, state, bus, seasonDays: config.seasonDays, log });
  seasons.ensure(now);
  const exchange = createExchange({ state, repos, bus, clock, seasons, params, log });
  const mirror = createMirrorService({
    config,
    trading: deps.trading,
    state,
    repos,
    refresher,
    clock,
    log,
    info: hl.mirrorInfo ?? hl.info,
    params,
  });
  const loop = createMarketLoop({
    state,
    repos,
    bus,
    filings,
    statusOps,
    params,
    autoCover: (rt, t) => exchange.autoCover(rt, t),
  });

  const lastRunAt = (key: string): number | null => {
    const v = Number(repos.kv.get(key) ?? Number.NaN);
    return Number.isFinite(v) ? v : null;
  };
  const scheduler = createScheduler({
    state,
    refresher,
    feed: hl.feed,
    clock,
    log,
    track,
    credits: credits ? () => credits.check() : null,
    mood: live
      ? async () => {
          await refreshMood({ nansen, state, clock, log });
          repos.kv.set(MOOD_LAST_KEY, String(state.moodAt));
          saveMood(repos, state);
          bus.emit({ t: 'mood', at: clock.now() });
        }
      : null,
    scout: live
      ? () =>
          runScout({
            nansen,
            info: hl.info,
            state,
            repos,
            clock,
            log,
            listing,
            targetCompanies: config.targetCompanies,
            params,
            wallNow,
          })
      : null,
    lastRun: live
      ? { scout: lastRunAt(SCOUT_LAST_KEY), mood: lastRunAt(MOOD_LAST_KEY) }
      : undefined,
  });
  scheduler.start(now);
  const idle = createIdleGate(state, bus, (t) => scheduler.wake(t), now);
  const bots = createBotRunner({
    state,
    repos,
    exchange,
    players,
    log,
    momentumLookbackMs: momentumLookbackMs(
      deps.replay ? deps.replay.endT - deps.replay.startT : null,
    ),
    valueBuysDips: deps.replay !== null,
  });

  let timer: ReturnType<typeof setInterval> | null = null;

  const engine: Engine = {
    config,
    clock,
    wallNow,
    log,
    params,
    repos,
    bus,
    state,
    nansen,
    trading: deps.trading,
    hl,
    replay: deps.replay,
    filings,
    statusOps,
    bankruptcy,
    refresher,
    listing,
    ipo,
    players,
    seasons,
    exchange,
    mirror,
    idle,
    scheduler,
    tick() {
      try {
        deps.replay?.advance();
        const t = clock.now();
        idle.tick(t);
        scheduler.onTick(t);
        loop.tick(t);
        bots.onTick(t);
        seasons.maybeRollover(t);
      } catch (err) {
        log.error('tick failed', { error: String(err) });
      }
    },
    resetTimers(t) {
      scheduler.reset(t);
      bots.reset();
      idle.reset(t);
      // Marks stamped in the previous loop's future would look fresh for a whole loop; mark them
      // stale instead (the replay feed's opening mids re-stamp them right away).
      if (state.marksAt > t) state.marksAt = 0;
    },
    start() {
      hl.feed.start();
      if (!timer) timer = setInterval(() => engine.tick(), 1_000);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      scheduler.stop();
      hl.feed.stop();
      await engine.settle();
    },
    track,
    async settle() {
      for (let i = 0; i < 20; i++) {
        const pending = [...tasks, ...refresher.pending()];
        await ipo.drained();
        if (pending.length === 0) return;
        await Promise.allSettled(pending);
      }
    },
    status() {
      const f = state.flags;
      const season = repos.seasons.current();
      return {
        mode: config.mode,
        recordedAt: deps.replay?.recordedAt ?? null,
        synthetic: deps.replay?.synthetic ?? false,
        idle: f.idle,
        creditSaver: f.creditSaver,
        creditFloor: f.creditFloor,
        creditsRemaining: f.creditsRemaining,
        marksDelayed: f.marksDelayed,
        season: season ? { id: season.id, endsAt: season.endsAt } : null,
        companies: state.listed().length,
        viewers: idle.clients(),
        now: clock.now(),
        loop: deps.replay
          ? {
              index: deps.replay.loopIndex(),
              startT: deps.replay.startT,
              endT: deps.replay.endT,
            }
          : null,
      };
    },
  };
  return engine;
}
