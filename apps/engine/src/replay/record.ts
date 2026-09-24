import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type HlFeed, recordFeed } from '@whale-street/hl';
import { type CohortPositioning, recordingFetch } from '@whale-street/nansen';
import type { SeedCompany, SessionLine } from './session';

export interface SessionRecorder {
  readonly path: string;
  /** Wraps a fetch so every response (Nansen or HL info) is appended as a NansenRecord line; headers are never stored. */
  wrapFetch(inner: typeof fetch): typeof fetch;
  /** Records HL mids (throttled to 1/s) and trades for the given coins. */
  attachFeed(feed: HlFeed, coins: () => ReadonlySet<string>): () => void;
  seed(company: SeedCompany): void;
  /** Records the street mood the engine derived for one coin (never the raw Nansen body). */
  mood(coin: string, positioning: CohortPositioning): void;
}

/**
 * LIVE + RECORD=1: appends NDJSON lines to `path` (under DATA_DIR/sessions, never inside the repo).
 * Only wrap the market-data reads with it: trading calls and the Mirror's reads of a player's own
 * wallet must go through an unwrapped fetch so no wallet, EIP-712 payload or signature is recorded.
 */
export function createSessionRecorder(path: string, now: () => number = Date.now): SessionRecorder {
  mkdirSync(dirname(path), { recursive: true });
  const write = (line: SessionLine) => appendFileSync(path, `${JSON.stringify(line)}\n`);
  return {
    path,
    wrapFetch: (inner) => recordingFetch(inner, write, now),
    attachFeed: (feed, coins) => recordFeed(feed, write, { coins, now }),
    seed: (company) => write({ t: now(), k: 'seed', company }),
    mood: (coin, positioning) => write({ t: now(), k: 'mood', coin, positioning }),
  };
}
