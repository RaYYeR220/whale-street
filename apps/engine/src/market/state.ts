import {
  type Address,
  type CompanyStatus,
  type Marks,
  multiplier,
  type NavState,
  type Pool,
  type Position,
  type Prospectus,
  positionHp,
  type Rating,
  type Snapshot,
  sharePrice,
} from '@whale-street/core';
import type { CompanyRow } from '../db/repos';
import type { StreetMood } from '../ingest/mood';
import type { CompanySource, HaltKind } from '../types';

export interface CompanyRuntime {
  id: Address;
  ticker: string;
  name: string;
  logoSeed: number;
  rating: Rating | null;
  source: CompanySource;
  status: CompanyStatus;
  haltKind: HaltKind | null;
  haltReason: string | null;
  listedAt: number;
  anchorDate: string;
  ipoUntil: number;
  prospectus: Prospectus | null;
  nav: NavState;
  summaryBaseline: number | null;
  firstSnapshot: Snapshot;
  pool: Pool;
  hp: number;
  /** Engine-clock time of the last successful snapshot. */
  lastSnapshotAt: number;
  /** Set when an HL trade by this address was seen and not yet resolved by a refresh. */
  pendingTriggerAt: number | null;
  /** Minute index of the last persisted nav point (-1 = none yet). */
  lastPointMinute: number;
  delistedAt: number | null;
  cooldownUntil: number | null;
}

export interface EngineFlags {
  idle: boolean;
  /** Engine-clock time the engine last woke from IDLE (stale-halt timers restart from here). */
  wokeAt: number;
  creditSaver: boolean;
  creditFloor: boolean;
  creditsRemaining: number | null;
  marksDelayed: boolean;
}

export interface PositionView extends Position {
  mark: number | null;
  hp: number;
}

export interface CompanyView {
  id: string;
  ticker: string;
  name: string;
  logoSeed: number;
  rating: Rating | null;
  source: CompanySource;
  status: CompanyStatus;
  haltReason: string | null;
  nav: number;
  price: number;
  mult: number;
  hp: number;
  equityUsd: number;
  listedAt: number;
  ipoUntil: number;
  lastSnapshotAt: number;
  prospectus: Prospectus | null;
  positions: PositionView[];
  provenance: readonly string[];
}

/** Compact per-company entry of the 1 Hz market frame. */
export interface MarketEntry {
  id: string;
  ticker: string;
  nav: number;
  price: number;
  mult: number;
  hp: number;
  status: CompanyStatus;
}

export class MarketState {
  readonly companies = new Map<string, CompanyRuntime>();
  marks: Record<string, number> = {};
  marksAt = 0;
  /** Street mood per coin: derived cohort skews with their fetch time (see ingest/mood). */
  readonly mood = new Map<string, StreetMood>();
  /** Engine-clock time the last street-mood run started (REPLAY: of the last mood line). */
  moodAt = 0;
  /**
   * Set at boot and on a wake from IDLE, cleared by the next market-loop tick that moves NAV on
   * fresh marks: until then NAV is the one saved before a restart, or the frozen pre-IDLE value.
   */
  awaitingNavTick = true;
  readonly flags: EngineFlags;

  constructor(now: number) {
    this.flags = {
      idle: false,
      wokeAt: now,
      creditSaver: false,
      creditFloor: false,
      creditsRemaining: null,
      marksDelayed: false,
    };
  }

  /** Adds (or replaces) a company, keyed by its lowercase address (its id is normalized too). */
  add(rt: CompanyRuntime): void {
    rt.id = rt.id.toLowerCase() as Address;
    this.companies.set(rt.id, rt);
  }

  get(id: string): CompanyRuntime | undefined {
    return this.companies.get(id.toLowerCase());
  }

  byTicker(ticker: string): CompanyRuntime | undefined {
    const t = ticker.toUpperCase();
    for (const rt of this.companies.values()) if (rt.ticker === t) return rt;
    return undefined;
  }

  list(): CompanyRuntime[] {
    return [...this.companies.values()];
  }

  /** Companies that are listed and not in bankruptcy (ACTIVE or HALTED). */
  listed(): CompanyRuntime[] {
    return this.list().filter((c) => c.status === 'ACTIVE' || c.status === 'HALTED');
  }

  /**
   * True while NAV is not following the market (IDLE, delayed marks, or woken but not yet ticked):
   * non-forced orders are refused so nobody trades at a frozen price.
   */
  paused(): boolean {
    return this.flags.idle || this.flags.marksDelayed || this.awaitingNavTick;
  }

  setMarks(m: Marks, at: number): void {
    this.marks = { ...this.marks, ...m };
    this.marksAt = at;
  }

  price(rt: CompanyRuntime): number {
    return sharePrice(rt.nav.nav, rt.pool);
  }

  /** Coins held by listed companies (drives the HL per-coin trades subscriptions). */
  heldCoins(): Set<string> {
    const coins = new Set<string>();
    for (const rt of this.listed()) for (const p of rt.nav.snapshot.positions) coins.add(p.coin);
    return coins;
  }

  /** Every company in memory, including this session's DELISTED tombstones. */
  marketEntries(): MarketEntry[] {
    return this.list().map((rt) => ({
      id: rt.id,
      ticker: rt.ticker,
      nav: rt.nav.nav,
      price: this.price(rt),
      mult: multiplier(rt.pool),
      hp: rt.hp,
      status: rt.status,
    }));
  }

  view(rt: CompanyRuntime): CompanyView {
    return {
      id: rt.id,
      ticker: rt.ticker,
      name: rt.name,
      logoSeed: rt.logoSeed,
      rating: rt.rating,
      source: rt.source,
      status: rt.status,
      haltReason: rt.haltReason,
      nav: rt.nav.nav,
      price: this.price(rt),
      mult: multiplier(rt.pool),
      hp: rt.hp,
      equityUsd: rt.nav.equity,
      listedAt: rt.listedAt,
      ipoUntil: rt.ipoUntil,
      lastSnapshotAt: rt.lastSnapshotAt,
      prospectus: rt.prospectus,
      positions: rt.nav.snapshot.positions.map((p) => {
        const mark = this.marks[p.coin] ?? null;
        return { ...p, mark, hp: mark === null ? 1 : positionHp(p, mark) };
      }),
      provenance: rt.nav.snapshot.provenance,
    };
  }
}

export function runtimeFromRow(row: CompanyRow): CompanyRuntime {
  return {
    id: row.id.toLowerCase() as Address,
    ticker: row.ticker,
    name: row.name,
    logoSeed: row.logoSeed,
    rating: row.rating,
    source: row.source,
    status: row.status,
    haltKind: row.haltKind,
    haltReason: row.haltReason,
    listedAt: row.listedAt,
    anchorDate: row.anchorDate,
    ipoUntil: row.ipoUntil,
    prospectus: row.prospectus,
    nav: row.navState.state,
    summaryBaseline: row.navState.summaryBaseline,
    firstSnapshot: row.navState.firstSnapshot,
    pool: { x: row.poolX, y: row.poolY, l0: row.poolL0 },
    hp: row.hp,
    lastSnapshotAt: row.navState.state.snapshot.fetchedAt,
    pendingTriggerAt: null,
    lastPointMinute: -1,
    delistedAt: row.delistedAt,
    cooldownUntil: row.cooldownUntil,
  };
}

export function rowFromRuntime(rt: CompanyRuntime): CompanyRow {
  return {
    id: rt.id,
    ticker: rt.ticker,
    name: rt.name,
    logoSeed: rt.logoSeed,
    status: rt.status,
    haltKind: rt.haltKind,
    haltReason: rt.haltReason,
    rating: rt.rating,
    source: rt.source,
    listedAt: rt.listedAt,
    anchorDate: rt.anchorDate,
    navState: {
      state: rt.nav,
      summaryBaseline: rt.summaryBaseline,
      firstSnapshot: rt.firstSnapshot,
    },
    poolX: rt.pool.x,
    poolY: rt.pool.y,
    poolL0: rt.pool.l0,
    hp: rt.hp,
    ipoUntil: rt.ipoUntil,
    prospectus: rt.prospectus,
    delistedAt: rt.delistedAt,
    cooldownUntil: rt.cooldownUntil,
  };
}
