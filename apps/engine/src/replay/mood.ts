import type { CohortPositioning } from '@whale-street/nansen';
import type { MoodRecord } from './session';

export type MoodListener = (coin: string, positioning: CohortPositioning, at: number) => void;

/** Replays recorded street-mood lines on the REPLAY clock, like the replay feed does HL records. */
export interface ReplayMood {
  onMood(cb: MoodListener): () => void;
  /** Emits every not-yet-emitted line recorded at or before now. */
  advance(): void;
  /** Back to the first line (REPLAY loop wrap). */
  rewind(): void;
}

export function createReplayMood(records: readonly MoodRecord[], now: () => number): ReplayMood {
  const sorted = [...records].sort((a, b) => a.t - b.t);
  const listeners = new Set<MoodListener>();
  let cursor = 0;
  return {
    onMood(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    advance() {
      const t = now();
      for (let r = sorted[cursor]; r !== undefined && r.t <= t; r = sorted[cursor]) {
        cursor++;
        for (const cb of listeners) cb(r.coin, r.positioning, r.t);
      }
    },
    rewind() {
      cursor = 0;
    },
  };
}
