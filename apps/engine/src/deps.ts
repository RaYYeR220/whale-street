import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHlFeed, createHlInfo, createReplayFeed, type ReplayFeed } from '@whale-street/hl';
import { NansenClient, NansenHttp, NansenTrading, replayFetch } from '@whale-street/nansen';
import { createReplayClock, type ReplayClock, realClock } from './clock';
import type { Config } from './config';
import { openDb } from './db/index';
import { createRepos } from './db/repos';
import type { EngineDeps } from './engine';
import { createCreditHeaderFeed } from './ingest/credits';
import type { Logger } from './log';
import { loadReplaySession } from './replay/load';
import { createReplayMood, type ReplayMood } from './replay/mood';
import { createSessionRecorder, type SessionRecorder } from './replay/record';
import type { SeedCompany } from './replay/session';
import { syntheticSession } from './replay/synthetic';

/** Request limits of one Nansen API key. */
export const NANSEN_KEY_LIMITS = { perSecond: 15, perMinute: 300 } as const;
/** LIVE trading client's slice of the key budget (human-triggered, meta/builder-fee cached 1 h). */
export const NANSEN_TRADING_BUDGET = { perSecond: 2, perMinute: 20 } as const;
/** LIVE data client's slice: the rest of the key budget, so both clients together stay within it. */
export const NANSEN_DATA_BUDGET = {
  perSecond: NANSEN_KEY_LIMITS.perSecond - NANSEN_TRADING_BUDGET.perSecond,
  perMinute: NANSEN_KEY_LIMITS.perMinute - NANSEN_TRADING_BUDGET.perMinute,
} as const;

/**
 * REPLAY database file of one session: named after the first 8 hex of the sha256 of the session
 * content, so another bundle starts a fresh world while a restart on the same bundle keeps its
 * players and portfolios.
 */
export function replayDbFile(sessionText: string): string {
  const sha8 = createHash('sha256').update(sessionText).digest('hex').slice(0, 8);
  return `whale-street-replay-${sha8}.db`;
}

export interface Runtime {
  deps: EngineDeps;
  /** REPLAY: companies to list at boot. */
  seeds: SeedCompany[];
  replay: { clock: ReplayClock; feed: ReplayFeed; mood: ReplayMood } | null;
  recorder: SessionRecorder | null;
}

export interface RuntimeOptions {
  log: Logger;
  /** Overrides the SQLite path (tests pass ':memory:'). */
  dbPath?: string;
  /** Wall clock driving the REPLAY loop and every rate gate / cap window (tests control it). */
  wallNow?: () => number;
  /** LIVE network fetch for Nansen and Hyperliquid info (tests pass a fake). */
  fetch?: typeof fetch;
}

/** Wires real (LIVE) or recorded (REPLAY) data sources from the config. */
export function buildRuntime(config: Config, o: RuntimeOptions): Runtime {
  const wallNow = o.wallNow ?? Date.now;
  if (config.mode === 'live') {
    const key = config.nansenApiKey;
    if (!key) throw new Error('LIVE mode requires NANSEN_API_KEY');
    const db = openDb(o.dbPath ?? join(config.dataDir, 'whale-street.db'));
    const repos = createRepos(db);
    const recorder = config.record
      ? createSessionRecorder(
          join(
            config.dataDir,
            'sessions',
            `${new Date(wallNow()).toISOString().replace(/[:.]/g, '-')}.ndjson`,
          ),
        )
      : null;
    const rawFetch = o.fetch ?? fetch;
    // Market-data reads (Nansen profiler/leaderboard/… and HL info for companies) are recorded.
    const readFetch = recorder ? recorder.wrapFetch(rawFetch) : rawFetch;
    // Every response's balance header reaches the engine's credit monitor.
    const creditHeaders = createCreditHeaderFeed();
    const onCall = (c: Parameters<typeof repos.nansenCalls.insert>[0]) => {
      repos.nansenCalls.insert(c);
      creditHeaders.push(c);
    };
    const http = new NansenHttp({ apiKey: key, fetch: readFetch, onCall, ...NANSEN_DATA_BUDGET });
    // Trading (wallets, EIP-712 payloads, signatures, builder fee) has its own client over the
    // raw fetch: it never lands in a session recording. Same key and provenance log; the key's
    // rate budget is split between the two clients so together they stay within it.
    const tradingHttp = new NansenHttp({
      apiKey: key,
      fetch: rawFetch,
      onCall,
      ...NANSEN_TRADING_BUDGET,
    });
    const info = createHlInfo({ fetch: readFetch });
    // The Mirror reads the player's own wallet: never recorded.
    const mirrorInfo = recorder ? createHlInfo({ fetch: rawFetch }) : info;
    return {
      deps: {
        config,
        db,
        nansen: new NansenClient(http),
        trading: new NansenTrading(tradingHttp),
        hl: { feed: createHlFeed(), info, mirrorInfo },
        clock: realClock,
        wallNow,
        log: o.log,
        replay: null,
        creditHeaders,
      },
      seeds: [],
      replay: null,
      recorder,
    };
  }

  const synthetic = !existsSync(config.replayFile);
  if (synthetic)
    o.log.warn('no replay session found; using the synthetic demo session', {
      replayFile: config.replayFile,
    });
  const text = synthetic ? syntheticSession().join('\n') : readFileSync(config.replayFile, 'utf8');
  const session = loadReplaySession(text);
  if (session.dropped > 0)
    o.log.warn('replay session: ignored records that are not redistributable', {
      dropped: session.dropped,
    });
  const clock = createReplayClock(session.startT, session.endT, wallNow(), wallNow);
  const dbFile = replayDbFile(text);
  o.log.info('replay database', { file: dbFile });
  const db = openDb(o.dbPath ?? join(config.dataDir, dbFile));
  const repos = createRepos(db);
  // Nansen and HL info both answer from the recording; anything unrecorded is a 503 (fail closed).
  const recorded = replayFetch(session.nansen, () => clock.now());
  // Every answer served from the recording is logged at the time it was recorded, marked
  // recorded, so the evidence drawer shows the calls behind a replayed number too.
  const http = new NansenHttp({
    apiKey: 'replay',
    fetch: recorded,
    maxRetries: 0,
    replay: true,
    onCall: (c) => repos.nansenCalls.insert(c),
  });
  const feed = createReplayFeed(session.hl, () => clock.now());
  const mood = createReplayMood(session.moods, () => clock.now());
  return {
    deps: {
      config,
      db,
      nansen: new NansenClient(http),
      trading: null,
      hl: { feed, info: createHlInfo({ fetch: recorded }) },
      clock,
      wallNow,
      log: o.log,
      replay: {
        recordedAt: session.recordedAt,
        synthetic,
        knownAddresses: session.knownAddresses,
        startT: clock.startT,
        endT: clock.endT,
        loopIndex: () => clock.loopIndex(),
        advance: () => {
          feed.advance();
          mood.advance();
          clock.poll();
        },
      },
    },
    seeds: session.seeds,
    replay: { clock, feed, mood },
    recorder: null,
  };
}
