import type { HlRecord } from '@whale-street/hl';
import type { NansenRecord } from '@whale-street/nansen';
import { isSkew } from '../ingest/mood';
import { type MoodRecord, redistributable, type SeedCompany, type SessionLine } from './session';

export interface LoadedSession {
  nansen: NansenRecord[];
  hl: HlRecord[];
  seeds: SeedCompany[];
  /** Street mood (derived cohort skews per coin), in file order. */
  moods: MoodRecord[];
  startT: number;
  endT: number;
  recordedAt: number;
  /** Addresses the recording can answer for (seeds + any address in a recorded request). */
  knownAddresses: ReadonlySet<string>;
  /** Records the load policy refused (always 0 for a plain parseSession). */
  dropped: number;
}

/**
 * A mood line goes straight into what clients are served: both skews must be present, each null
 * or a number in [−1, 1].
 */
function isMoodRecord(r: { coin?: unknown; smartSkew?: unknown; whaleSkew?: unknown }): boolean {
  return (
    typeof r.coin === 'string' && r.coin.length > 0 && isSkew(r.smartSkew) && isSkew(r.whaleSkew)
  );
}

export function parseSessionLine(line: string, lineNo: number): SessionLine {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    throw new Error(`session line ${lineNo}: invalid JSON`);
  }
  const r = v as { k?: unknown; t?: unknown } | null;
  if (
    r === null ||
    typeof r !== 'object' ||
    typeof r.t !== 'number' ||
    !Number.isFinite(r.t) ||
    (r.k !== 'nansen' && r.k !== 'hl' && r.k !== 'seed' && r.k !== 'mood')
  ) {
    throw new Error(`session line ${lineNo}: not a session record`);
  }
  if (r.k === 'mood' && !isMoodRecord(v as Record<string, unknown>)) {
    throw new Error(`session line ${lineNo}: malformed street-mood record`);
  }
  return v as SessionLine;
}

/**
 * Parses a session file. `policy` may rewrite or refuse (null) each record; refused records do
 * not count toward the time window or the known addresses.
 */
export function parseSession(
  text: string,
  policy?: (r: SessionLine) => SessionLine | null,
): LoadedSession {
  const nansen: NansenRecord[] = [];
  const hl: HlRecord[] = [];
  const seeds = new Map<string, SeedCompany>();
  const moods: MoodRecord[] = [];
  const known = new Set<string>();
  let startT = Number.POSITIVE_INFINITY;
  let endT = Number.NEGATIVE_INFINITY;
  let dropped = 0;

  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === '') return;
    const parsed = parseSessionLine(line, i + 1);
    const r = policy ? policy(parsed) : parsed;
    if (!r) {
      dropped++;
      return;
    }
    startT = Math.min(startT, r.t);
    endT = Math.max(endT, r.t);
    if (r.k === 'nansen') {
      nansen.push(r);
      for (const a of r.key.toLowerCase().match(/0x[0-9a-f]{40}/g) ?? []) known.add(a);
    } else if (r.k === 'hl') {
      hl.push(r);
    } else if (r.k === 'mood') {
      moods.push(r);
    } else {
      const address = r.company.address.toLowerCase();
      known.add(address);
      if (!seeds.has(address)) seeds.set(address, { ...r.company, address });
    }
  });
  if (!Number.isFinite(startT)) throw new Error('session is empty');
  return {
    nansen,
    hl,
    seeds: [...seeds.values()],
    moods,
    startT,
    endT,
    recordedAt: startT,
    knownAddresses: known,
    dropped,
  };
}

/**
 * The REPLAY loader: applies the same redistribution policy as the bundler (allowlisted paths,
 * label/name scrub), so even a raw recording dropped in as REPLAY_FILE can only serve
 * redistributable data.
 */
export function loadReplaySession(text: string): LoadedSession {
  return parseSession(text, redistributable);
}
