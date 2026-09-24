import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHlFeed, createHlInfo, createReplayFeed, type ReplayFeed } from '@whale-street/hl';
import { NansenClient, NansenHttp, NansenTrading, replayFetch } from '@whale-street/nansen';
import { createReplayClock, type ReplayClock, realClock } from './clock';
import type { Config } from './config';
import { openDb } from './db/index';
import { createRepos } from './db/repos';
import type { EngineDeps } from './engine';
import type { Logger } from './log';
import { parseSession } from './replay/load';
import { createSessionRecorder, type SessionRecorder } from './replay/record';
import type { SeedCompany } from './replay/session';
import { syntheticSession } from './replay/synthetic';

export interface Runtime {
  deps: EngineDeps;
  /** REPLAY: companies to list at boot. */
  seeds: SeedCompany[];
  replay: { clock: ReplayClock; feed: ReplayFeed } | null;
  recorder: SessionRecorder | null;
}

export interface RuntimeOptions {
  log: Logger;
  /** Overrides the SQLite path (tests pass ':memory:'). */
  dbPath?: string;
  /** Wall clock driving the REPLAY loop (tests control it). */
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
    const onCall = (c: Parameters<typeof repos.nansenCalls.insert>[0]) =>
      repos.nansenCalls.insert(c);
    const http = new NansenHttp({ apiKey: key, fetch: readFetch, onCall });
    // Trading (wallets, EIP-712 payloads, signatures, builder fee) has its own client over the
    // raw fetch: it never lands in a session recording. Same key, same provenance log.
    const tradingHttp = new NansenHttp({ apiKey: key, fetch: rawFetch, onCall });
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
        log: o.log,
        replay: null,
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
  const session = parseSession(text);
  const clock = createReplayClock(session.startT, session.endT, wallNow(), wallNow);
  const db = openDb(o.dbPath ?? join(config.dataDir, 'whale-street-replay.db'));
  const repos = createRepos(db);
  // Nansen and HL info both answer from the recording; anything unrecorded is a 503 (fail closed).
  const recorded = replayFetch(session.nansen, () => clock.now());
  const http = new NansenHttp({
    apiKey: 'replay',
    fetch: recorded,
    maxRetries: 0,
    onCall: (c) => repos.nansenCalls.insert(c),
  });
  const feed = createReplayFeed(session.hl, () => clock.now());
  return {
    deps: {
      config,
      db,
      nansen: new NansenClient(http),
      trading: null,
      hl: { feed, info: createHlInfo({ fetch: recorded }) },
      clock,
      log: o.log,
      replay: {
        recordedAt: session.recordedAt,
        synthetic,
        knownAddresses: session.knownAddresses,
        advance: () => {
          feed.advance();
          clock.poll();
        },
      },
    },
    seeds: session.seeds,
    replay: { clock, feed },
    recorder: null,
  };
}
