import { PARAMS, type Params } from '@whale-street/core';
import { createBotRunner } from './bots/runner';
import type { Clock } from './clock';
import type { Config } from './config';
import { DAY_MS } from './dates';
import type { Db } from './db/index';
import { createRepos, type Repos } from './db/repos';
import { EventBus } from './events';
import { createCreditMonitor } from './ingest/credits';
import { createIdleGate, type IdleGate } from './ingest/idle';
import { refreshMood } from './ingest/mood';
import { createRefresher, type Refresher } from './ingest/refresh';
import { createScheduler, type Scheduler } from './ingest/scheduler';
import { runScout } from './ingest/scout';
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
  /** Called first in every tick: advances the replay feed and detects loop wraps. */
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
}

export interface Engine {
  readonly config: Config;
  readonly clock: Clock;
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
  /** Starts the HL feed and the 1 Hz interval. */
  start(): void;
  stop(): Promise<void>;
  /** Registers background work; settle() awaits it. */
  track(p: Promise<unknown>): void;
  settle(): Promise<void>;
  status(): StatusView;
}

export function createEngine(deps: EngineDeps): Engine {
  const { config, clock, log, nansen, hl } = deps;
  const params = deps.params ?? PARAMS;
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

  const filings = createFilingService(repos, state, bus);
  const statusOps = createStatusOps(repos, filings);
  const bankruptcy = createBankruptcyService({ repos, filings, statusOps, bus, params });
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
  });
  const players = createPlayersService({ repos, clock });
  const seasons = createSeasonService({ repos, state, bus, seasonDays: config.seasonDays });
  seasons.ensure(now);
  const exchange = createExchange({ state, repos, bus, clock, seasons, params });
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

  const live = config.mode === 'live';
  const credits = live ? createCreditMonitor({ nansen, state, repos, bus, clock, log }) : null;
  const scheduler = createScheduler({
    state,
    refresher,
    feed: hl.feed,
    clock,
    log,
    track,
    credits: credits ? () => credits.check() : null,
    mood: live ? () => refreshMood({ nansen, state, clock, log }) : null,
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
          })
      : null,
  });
  scheduler.start(now);
  const idle = createIdleGate(state, bus, (t) => scheduler.wake(t), now);
  const bots = createBotRunner({ state, repos, exchange, players, log });

  let timer: ReturnType<typeof setInterval> | null = null;

  const engine: Engine = {
    config,
    clock,
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
      };
    },
  };
  return engine;
}
