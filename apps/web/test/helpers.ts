/** Test factories and fakes shared by the web tests. */
import type {
  CompanyView,
  FilingView,
  MarketEntry,
  PortfolioView,
  ServerMessage,
  StatusView,
} from '../lib/api-types';
import type { SocketLike } from '../lib/ws-client';

export const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);

export const entry = (o: Partial<MarketEntry> = {}): MarketEntry => ({
  id: '0x0000000000000000000000000000000000000a01',
  ticker: 'OOH',
  nav: 100,
  price: 110,
  mult: 1.1,
  hp: 0.8,
  status: 'ACTIVE',
  ...o,
});

export const market = (at: number, companies: MarketEntry[]): ServerMessage => ({
  t: 'market',
  at,
  mode: 'replay',
  companies,
  mood: [],
});

export const filing = (o: Partial<FilingView> = {}): FilingView => ({
  id: 1,
  companyId: '0x0000000000000000000000000000000000000a01',
  ticker: 'OOH',
  kind: 'OPEN',
  coin: 'HYPE',
  sizeBefore: 0,
  sizeAfter: 1000,
  notionalUsd: 3_400_000,
  realizedPnlUsd: null,
  at: T0,
  provenance: ['nc_1'],
  detail: null,
  explorerUrl: 'https://app.hyperliquid.xyz/explorer/address/0x0',
  ...o,
});

export const status = (o: Partial<StatusView> = {}): StatusView => ({
  mode: 'replay',
  recordedAt: null,
  synthetic: false,
  idle: false,
  creditSaver: false,
  creditFloor: false,
  creditsRemaining: null,
  marksDelayed: false,
  season: { id: 1, endsAt: T0 + 7 * 86_400_000 },
  companies: 2,
  viewers: 1,
  ...o,
});

export const portfolio = (o: Partial<PortfolioView> = {}): PortfolioView => ({
  playerId: 'p1',
  seasonId: 1,
  cash: 10_000,
  holdings: [],
  netWorth: 10_000,
  netWorthReason: null,
  ...o,
});

export const companyView = (o: Partial<CompanyView> = {}): CompanyView => ({
  id: '0x0000000000000000000000000000000000000a01',
  ticker: 'OOH',
  name: 'Obsidian Octopus Holdings',
  logoSeed: 1,
  rating: 'AA',
  source: 'SCOUT',
  status: 'ACTIVE',
  haltReason: null,
  nav: 100,
  price: 110,
  mult: 1.1,
  hp: 0.8,
  equityUsd: 500_000,
  listedAt: T0 - 86_400_000,
  ipoUntil: T0 - 86_400_000 + 60_000,
  lastSnapshotAt: T0,
  prospectus: null,
  positions: [],
  provenance: ['nc_1'],
  ...o,
});

/** A fetch that answers from a route table and records every request. */
export function fakeFetch(
  routes: Record<string, (req: { url: URL; init: RequestInit }) => Response | Promise<Response>>,
) {
  const calls: Array<{ method: string; url: URL; init: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push({ method, url, init });
    const route = routes[`${method} ${url.pathname}`];
    if (!route)
      return new Response(JSON.stringify({ error: 'NOT_FOUND', message: 'no route' }), {
        status: 404,
      });
    return route({ url, init });
  }) as typeof fetch;
  return { impl, calls };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** In-memory WebSocket stand-in driven by the test. */
export class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg: unknown): void {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

/** Manual timers for backoff and watchdog tests. */
export function manualTimers() {
  let seq = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => {
      seq += 1;
      pending.set(seq, { fn, ms });
      return seq;
    },
    clearTimer: (h: unknown) => {
      pending.delete(h as number);
    },
    /** Runs the timer with the given delay (the first one if several match). */
    fire(ms?: number) {
      for (const [id, t] of pending) {
        if (ms === undefined || t.ms === ms) {
          pending.delete(id);
          t.fn();
          return t.ms;
        }
      }
      throw new Error(`no timer${ms === undefined ? '' : ` of ${ms} ms`}`);
    },
    delays: () => [...pending.values()].map((t) => t.ms),
  };
}
