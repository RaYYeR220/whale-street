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

type Fields = Record<string, unknown>;

const isObject = (v: unknown): v is Fields =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A seed lists a company at boot: every field of SeedCompany, with a real address. */
function seedProblem(r: Fields): string | null {
  const c = r.company;
  if (!isObject(c)) return 'a seed record needs a company';
  if (typeof c.address !== 'string' || !ADDRESS.test(c.address))
    return 'a seed company needs a 0x address';
  for (const key of ['ticker', 'name', 'anchorDate'] as const)
    if (!isText(c[key])) return `a seed company needs a ${key}`;
  if (!isNumber(c.listedAt)) return 'a seed company needs a listedAt time';
  return null;
}

/** A Nansen / HL-info record answers one request key with a status and a (JSON) body. */
function nansenProblem(r: Fields): string | null {
  if (!isText(r.key)) return 'a nansen record needs a request key';
  if (typeof r.path !== 'string') return 'a nansen record needs a path';
  if (!Number.isInteger(r.status)) return 'a nansen record needs an HTTP status';
  if (!('body' in r)) return 'a nansen record needs a body';
  return null;
}

/** An HL feed record: mids (coin → number) or trades (coin, px, sz, time and the two users). */
function hlProblem(r: Fields): string | null {
  if (r.channel === 'mids') {
    if (!isObject(r.data) || !Object.values(r.data).every(isNumber))
      return 'an hl mids record needs numeric mids by coin';
    return null;
  }
  if (r.channel === 'trades') {
    if (!Array.isArray(r.data)) return 'an hl trades record needs a list of trades';
    const ok = r.data.every(
      (t) =>
        isObject(t) &&
        isText(t.coin) &&
        isNumber(t.px) &&
        isNumber(t.sz) &&
        isNumber(t.time) &&
        Array.isArray(t.users) &&
        t.users.length === 2 &&
        t.users.every((u) => typeof u === 'string'),
    );
    return ok ? null : 'an hl trade needs coin, px, sz, time and two users';
  }
  return 'an hl record needs channel mids or trades';
}

/**
 * A mood line goes straight into what clients are served: both skews must be present, each null
 * or a number in [−1, 1].
 */
function moodProblem(r: Fields): string | null {
  return isText(r.coin) && isSkew(r.smartSkew) && isSkew(r.whaleSkew)
    ? null
    : 'malformed street-mood record';
}

const PROBLEM_OF = { seed: seedProblem, nansen: nansenProblem, hl: hlProblem, mood: moodProblem };

/** Parses one NDJSON line and checks it has the fields its kind needs (errors name the line). */
export function parseSessionLine(line: string, lineNo: number): SessionLine {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    throw new Error(`session line ${lineNo}: invalid JSON`);
  }
  if (
    !isObject(v) ||
    !isNumber(v.t) ||
    (v.k !== 'nansen' && v.k !== 'hl' && v.k !== 'seed' && v.k !== 'mood')
  ) {
    throw new Error(`session line ${lineNo}: not a session record`);
  }
  const problem = PROBLEM_OF[v.k](v);
  if (problem) throw new Error(`session line ${lineNo}: ${problem}`);
  return v as unknown as SessionLine;
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

/**
 * The recording time a REPLAY answer is served as of. Every recorded company is seeded when the
 * loop starts, also one listed partway through the recording; until the loop reaches its recorded
 * listing, requests about it are answered as of that listing. The earlier answers under the same
 * request key (date ranges are not part of a key) were for other windows, such as the scout's
 * evaluation, and would restate the realized PnL the listing started from.
 */
export function replayAsOf(
  seeds: readonly SeedCompany[],
  now: () => number,
): (key: string) => number {
  const listedAt = new Map(seeds.map((s) => [s.address.toLowerCase(), s.listedAt]));
  return (key) => {
    let t = now();
    for (const a of key.toLowerCase().match(/0x[0-9a-f]{40}/g) ?? []) {
      const at = listedAt.get(a);
      if (at !== undefined && at > t) t = at;
    }
    return t;
  };
}
