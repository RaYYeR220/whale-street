/**
 * Client-side mirror of the live engine: an external store fed by WebSocket frames and REST seeds,
 * read through useSyncExternalStore. Slices are replaced only when their content changes, so
 * selectors return stable references and components re-render only for data they use.
 */
import type {
  CompanyView,
  FilingView,
  HistoryPoint,
  IpoUpdate,
  LeaderboardEntry,
  MarketEntry,
  Mode,
  MoodEntry,
  PlayerView,
  PortfolioView,
  ServerMessage,
  StatusView,
  TapeView,
} from './api-types';
import type { ConnectionState } from './ws-client';

export const MINUTE_MS = 60_000;
export const SERIES_MAX_POINTS = 1_440;
export const FILINGS_MAX = 120;
export const TAPE_MAX = 40;
export const IPO_UPDATES_MAX = 60;
/** A market frame this far behind the previous one means the replay loop restarted. */
export const WRAP_BACKSTEP_MS = 5_000;

/** Minute-bucketed NAV and price; null marks a minute with no trustworthy value (halt, bankruptcy). */
export interface Series {
  t: number[];
  nav: Array<number | null>;
  price: Array<number | null>;
}

export interface MarketSlice {
  at: number;
  mode: Mode;
  companies: MarketEntry[];
  byTicker: Readonly<Record<string, MarketEntry>>;
  mood: MoodEntry[];
  /** Client clock (Date.now) when the frame arrived; lets the UI extrapolate engine time smoothly. */
  receivedAt: number;
}

export interface EngineState {
  connection: ConnectionState;
  status: StatusView | null;
  /** Client clock (Date.now) when the status arrived: engine time runs on from status.now. */
  statusAt: number | null;
  market: MarketSlice | null;
  /** Previous tick's entries (for price flip direction). */
  previous: Readonly<Record<string, MarketEntry>>;
  series: Readonly<Record<string, Series>>;
  /** Slower REST views (name, rating, positions, prospectus) by ticker. */
  views: Readonly<Record<string, CompanyView>>;
  /** Client time of the last /api/companies refresh (only whether there was one is used). */
  viewsAt: number | null;
  filings: FilingView[];
  tape: TapeView[];
  leaderboard: LeaderboardEntry[] | null;
  portfolio: PortfolioView | null;
  hello: PlayerView | null;
  ipo: IpoUpdate[];
  /** Increments whenever the replay loop restarts (clients refetch history). */
  epoch: number;
  lastError: { error: string; message: string } | null;
}

export const INITIAL_STATE: EngineState = Object.freeze({
  connection: 'idle',
  status: null,
  statusAt: null,
  market: null,
  previous: {},
  series: {},
  views: {},
  viewsAt: null,
  filings: [],
  tape: [],
  leaderboard: null,
  portfolio: null,
  hello: null,
  ipo: [],
  epoch: 0,
  lastError: null,
}) as EngineState;

const sameEntry = (a: MarketEntry | undefined, b: MarketEntry): boolean =>
  !!a &&
  a.id === b.id &&
  a.ticker === b.ticker &&
  Object.is(a.nav, b.nav) &&
  Object.is(a.price, b.price) &&
  Object.is(a.mult, b.mult) &&
  Object.is(a.hp, b.hp) &&
  a.status === b.status;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Identifies one trade for de-duplication (TapeView carries no id): the REST seed and the WS event
 * for the same DB row always agree on every one of these fields.
 */
const tapeKey = (t: TapeView): string =>
  `${t.at}|${t.ticker}|${t.side}|${t.qty}|${t.avgPrice}|${t.cash}|${t.handle}`;

/** Appends (or overwrites the current minute of) one point; trims to SERIES_MAX_POINTS. */
export function appendPoint(
  s: Series | undefined,
  at: number,
  nav: number | null,
  price: number | null,
): Series {
  const bucket = Math.floor(at / MINUTE_MS) * MINUTE_MS;
  const t = s ? s.t.slice() : [];
  const n = s ? s.nav.slice() : [];
  const p = s ? s.price.slice() : [];
  const last = t[t.length - 1];
  if (last !== undefined && last === bucket) {
    n[n.length - 1] = nav;
    p[p.length - 1] = price;
  } else if (last !== undefined && bucket < last) {
    return s as Series;
  } else {
    t.push(bucket);
    n.push(nav);
    p.push(price);
  }
  const extra = t.length - SERIES_MAX_POINTS;
  if (extra > 0) {
    t.splice(0, extra);
    n.splice(0, extra);
    p.splice(0, extra);
  }
  return { t, nav: n, price: p };
}

/** Builds a minute series from REST history (sorted, de-duplicated per minute, last value wins). */
export function seriesFromHistory(points: readonly HistoryPoint[]): Series {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  let s: Series = { t: [], nav: [], price: [] };
  for (const pt of sorted) s = appendPoint(s, pt.t, num(pt.nav), num(pt.price));
  return s;
}

/** Merges a REST seed under the live points (live minutes win). */
export function mergeSeries(seed: Series, live: Series | undefined): Series {
  if (!live || live.t.length === 0) return seed;
  let s = seed;
  for (let i = 0; i < live.t.length; i++) {
    const t = live.t[i] as number;
    s = appendPoint(s, t, live.nav[i] ?? null, live.price[i] ?? null);
  }
  return s;
}

export interface EngineStore {
  getState(): EngineState;
  subscribe(listener: () => void): () => void;
  dispatch(msg: ServerMessage, now?: number): void;
  setConnection(c: ConnectionState): void;
  /** `receivedAt`: client clock when it arrived (default now). */
  setStatus(s: StatusView, receivedAt?: number): void;
  seedFilings(filings: readonly FilingView[]): void;
  /** REST seed of recent trades (page load, warm from a cold Tape); merges under the live ones. */
  seedTape(trades: readonly TapeView[]): void;
  seedSeries(ticker: string, points: readonly HistoryPoint[]): void;
  setPortfolio(p: PortfolioView | null): void;
  setViews(views: readonly CompanyView[], at: number): void;
  setView(view: CompanyView): void;
}

export function createEngineStore(initial: EngineState = INITIAL_STATE): EngineStore {
  let state = initial;
  const listeners = new Set<() => void>();
  const set = (next: EngineState) => {
    if (next === state) return;
    state = next;
    for (const l of listeners) l();
  };

  const onMarket = (m: Extract<ServerMessage, { t: 'market' }>, now: number) => {
    const prevMarket = state.market;
    const wrapped = prevMarket !== null && m.at < prevMarket.at - WRAP_BACKSTEP_MS;
    const prevBy = wrapped ? {} : (prevMarket?.byTicker ?? {});
    const byTicker: Record<string, MarketEntry> = {};
    let changed = !prevMarket || wrapped || prevMarket.companies.length !== m.companies.length;
    const companies = m.companies.map((e, i) => {
      const old = prevBy[e.ticker];
      const keep = old && sameEntry(old, e) ? old : e;
      if (keep !== prevMarket?.companies[i]) changed = true;
      byTicker[e.ticker] = keep;
      return keep;
    });
    const series: Record<string, Series> = wrapped ? {} : { ...state.series };
    for (const e of companies) {
      const trusted = e.status === 'ACTIVE';
      series[e.ticker] = appendPoint(
        series[e.ticker],
        m.at,
        trusted ? num(e.nav) : null,
        trusted ? num(e.price) : null,
      );
    }
    set({
      ...state,
      previous: prevMarket?.byTicker ?? {},
      market: {
        at: m.at,
        mode: m.mode,
        companies: changed || !prevMarket ? companies : prevMarket.companies,
        byTicker: changed || !prevMarket ? byTicker : prevMarket.byTicker,
        mood: m.mood,
        receivedAt: now,
      },
      series,
      // A replay loop restarts the clock: drop news from the previous pass (it is refetched).
      filings: wrapped ? [] : state.filings,
      tape: wrapped ? [] : state.tape,
      epoch: wrapped ? state.epoch + 1 : state.epoch,
    });
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch(msg, now = Date.now()) {
      switch (msg.t) {
        case 'market':
          onMarket(msg, now);
          return;
        case 'status':
          set({ ...state, status: msg.status, statusAt: now });
          return;
        case 'filing': {
          if (state.filings.some((f) => f.id === msg.filing.id)) return;
          set({ ...state, filings: [msg.filing, ...state.filings].slice(0, FILINGS_MAX) });
          return;
        }
        case 'tape': {
          // Already on the tape (the REST seed can race a live event for the same DB row).
          if (state.tape.some((t) => tapeKey(t) === tapeKey(msg.trade))) return;
          set({ ...state, tape: [msg.trade, ...state.tape].slice(0, TAPE_MAX) });
          return;
        }
        case 'leaderboard':
          set({ ...state, leaderboard: msg.rows });
          return;
        case 'player':
          set({ ...state, portfolio: msg.portfolio });
          return;
        case 'hello':
          set({ ...state, hello: msg.player });
          return;
        case 'ipo':
          set({ ...state, ipo: [msg.update, ...state.ipo].slice(0, IPO_UPDATES_MAX) });
          return;
        case 'error':
          set({ ...state, lastError: { error: msg.error, message: msg.message } });
          return;
      }
    },
    setConnection(c) {
      if (state.connection !== c) set({ ...state, connection: c });
    },
    setStatus(s, receivedAt = Date.now()) {
      set({ ...state, status: s, statusAt: receivedAt });
    },
    seedFilings(filings) {
      const known = new Set(state.filings.map((f) => f.id));
      const merged = [...state.filings, ...filings.filter((f) => !known.has(f.id))]
        .sort((a, b) => b.at - a.at || b.id - a.id)
        .slice(0, FILINGS_MAX);
      set({ ...state, filings: merged });
    },
    seedTape(trades) {
      const known = new Set(state.tape.map(tapeKey));
      const merged = [...state.tape, ...trades.filter((t) => !known.has(tapeKey(t)))]
        .sort((a, b) => b.at - a.at)
        .slice(0, TAPE_MAX);
      set({ ...state, tape: merged });
    },
    seedSeries(ticker, points) {
      const seed = seriesFromHistory(points);
      set({
        ...state,
        series: { ...state.series, [ticker]: mergeSeries(seed, state.series[ticker]) },
      });
    },
    setPortfolio(p) {
      set({ ...state, portfolio: p });
    },
    setViews(views, at) {
      const next: Record<string, CompanyView> = {};
      for (const v of views) next[v.ticker] = v;
      set({ ...state, views: next, viewsAt: at });
    },
    setView(view) {
      set({ ...state, views: { ...state.views, [view.ticker]: view } });
    },
  };
}

/**
 * Engine time at client time `clientNow`: the newest engine reading (status.now or the market
 * frame's `at`, whichever arrived last) plus the wall time elapsed since it arrived. In REPLAY this
 * is recording time; the browser clock only measures how much time passed. Null before either.
 */
export function engineNow(s: EngineState, clientNow: number): number | null {
  const fromStatus =
    s.status && s.statusAt !== null && Number.isFinite(s.status.now)
      ? { at: s.status.now, received: s.statusAt }
      : null;
  const fromMarket = s.market ? { at: s.market.at, received: s.market.receivedAt } : null;
  const base =
    fromStatus && fromMarket
      ? fromStatus.received > fromMarket.received
        ? fromStatus
        : fromMarket
      : (fromStatus ?? fromMarket);
  return base ? base.at + Math.max(0, clientNow - base.received) : null;
}

/** Last `minutes` buckets of a series ending at `endAt`, gaps filled with null (for sparklines). */
export function lastMinutes(
  s: Series | undefined,
  endAt: number,
  minutes: number,
): { nav: Array<number | null>; price: Array<number | null> } {
  const end = Math.floor(endAt / MINUTE_MS) * MINUTE_MS;
  const nav: Array<number | null> = new Array(minutes).fill(null);
  const price: Array<number | null> = new Array(minutes).fill(null);
  if (!s) return { nav, price };
  for (let i = 0; i < s.t.length; i++) {
    const t = s.t[i] as number;
    const idx = minutes - 1 - Math.round((end - t) / MINUTE_MS);
    if (idx < 0 || idx >= minutes) continue;
    nav[idx] = s.nav[i] ?? null;
    price[idx] = s.price[i] ?? null;
  }
  return { nav, price };
}

/** Relative change from the first to the last known value, or null. */
export function change(values: ReadonlyArray<number | null>): number | null {
  let first: number | null = null;
  let last: number | null = null;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    if (first === null) first = v;
    last = v;
  }
  if (first === null || last === null || first === 0) return null;
  return last / first - 1;
}
