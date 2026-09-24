import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type HlFeed, recordFeed } from '@whale-street/hl';
import { recordingFetch } from '@whale-street/nansen';
import type { MoodSkew } from '../ingest/mood';
import { redistributable, type SeedCompany, type SessionLine } from './session';

export interface SessionRecorder {
  readonly path: string;
  /**
   * Wraps a fetch so every redistributable response (allowlisted Nansen path or HL info, labels
   * scrubbed) is appended as a NansenRecord line; headers are never stored.
   */
  wrapFetch(inner: typeof fetch): typeof fetch;
  /**
   * Records HL mids (throttled to 1/s) for the given coins, and of the trades on those coins only
   * the ones involving an address known at that moment (`addresses`: listed companies and pending
   * IPO applicants; the engine reacts to no other trade).
   */
  attachFeed(
    feed: HlFeed,
    coins: () => ReadonlySet<string>,
    addresses: () => ReadonlySet<string>,
  ): () => void;
  seed(company: SeedCompany): void;
  /** Records the street mood the engine derived for one coin: its skews only (never raw totals). */
  mood(coin: string, mood: MoodSkew): void;
}

/**
 * LIVE + RECORD=1: appends NDJSON lines to `path` (under DATA_DIR/sessions, never inside the repo).
 * Every line passes the same redistribution policy as the bundler and the REPLAY loader, so raw
 * leaderboard, smart-money or cohort bodies and label/name fields never land on disk (the engine
 * still uses those responses in memory). Only wrap the market-data reads with it: trading calls
 * and the Mirror's reads of a player's own wallet must go through an unwrapped fetch so no
 * wallet, EIP-712 payload or signature is recorded.
 */
export function createSessionRecorder(path: string, now: () => number = Date.now): SessionRecorder {
  mkdirSync(dirname(path), { recursive: true });
  const write = (line: SessionLine) => {
    const kept = redistributable(line);
    if (kept) appendFileSync(path, `${JSON.stringify(kept)}\n`);
  };
  return {
    path,
    wrapFetch: (inner) => recordingFetch(inner, write, now),
    attachFeed: (feed, coins, addresses) =>
      recordFeed(
        feed,
        (r) => {
          if (r.channel !== 'trades') return write(r);
          const known = addresses();
          const data = r.data.filter((t) => t.users.some((u) => known.has(u.toLowerCase())));
          if (data.length > 0) write({ ...r, data });
        },
        { coins, now },
      ),
    seed: (company) => write({ t: now(), k: 'seed', company }),
    mood: (coin, m) =>
      write({ t: now(), k: 'mood', coin, smartSkew: m.smartSkew, whaleSkew: m.whaleSkew }),
  };
}
