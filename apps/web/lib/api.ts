/**
 * Typed client for the engine REST API. Never throws: every call resolves to an ApiResult so callers
 * must handle the failure branch (and render it) instead of showing a stale or invented value.
 */
import type { OrderSide } from '@whale-street/core';
import type {
  ApiErrorBody,
  BuilderFeeStatus,
  CompanyView,
  FilingView,
  HistoryPoint,
  HolderView,
  IpoView,
  LeaderboardEntry,
  MirrorOrderView,
  MirrorPrepareBody,
  MirrorReason,
  MirrorReceipt,
  NansenCallView,
  OrderBody,
  OrderFilled,
  PlayerView,
  PortfolioView,
  PrepareView,
  PublicPlayerView,
  QuoteView,
  SeasonResultRow,
  SeasonResultView,
  SeasonRow,
  SignatureParts,
  StatusView,
  TradeRowView,
} from './api-types';

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; message: string; refusals?: MirrorReason[] };

export interface RequestOptions {
  token?: string | null;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface Session {
  player: PlayerView;
  token: string;
}

export interface MeView {
  player: PlayerView;
  portfolio: PortfolioView;
  seasons: SeasonResultRow[];
}

export interface ProfileView {
  player: PublicPlayerView;
  portfolio: PortfolioView;
  seasons: SeasonResultRow[];
  trades: TradeRowView[];
}

export interface CompanyDetail {
  company: CompanyView;
  filings: FilingView[];
  holders: HolderView[];
}

export const DEFAULT_TIMEOUT_MS = 10_000;
/** Mirror execute waits on Nansen and Hyperliquid; a timeout there means "result unknown", never "failed". */
export const EXECUTE_TIMEOUT_MS = 30_000;

export function createApi(base: string, fetchImpl: typeof fetch = (...a) => fetch(...a)) {
  const root = base.replace(/\/+$/, '');

  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    o: RequestOptions = {},
  ): Promise<ApiResult<T>> {
    const url = new URL(`${root}${path}`);
    for (const [k, v] of Object.entries(o.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: 'application/json' };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    const timeout = AbortSignal.timeout(o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal,
        cache: 'no-store',
      });
    } catch (err) {
      const timedOut = timeout.aborted;
      return {
        ok: false,
        status: 0,
        error: timedOut ? 'TIMEOUT' : 'NETWORK',
        message: timedOut
          ? 'the engine did not answer in time'
          : `cannot reach the engine (${err instanceof Error ? err.message : String(err)})`,
      };
    }
    let json: unknown = null;
    const text = await res.text().catch(() => '');
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (res.ok) {
      if (json === null)
        return { ok: false, status: res.status, error: 'BAD_RESPONSE', message: 'empty reply' };
      return { ok: true, data: json as T };
    }
    const body = (json ?? {}) as Partial<ApiErrorBody>;
    return {
      ok: false,
      status: res.status,
      error: typeof body.error === 'string' ? body.error : `HTTP_${res.status}`,
      message: typeof body.message === 'string' ? body.message : res.statusText || 'request failed',
      ...(Array.isArray(body.refusals) ? { refusals: body.refusals } : {}),
    };
  }

  const get = <T>(path: string, o?: RequestOptions) => request<T>('GET', path, o);
  const post = <T>(path: string, o?: RequestOptions) => request<T>('POST', path, o);
  const seg = encodeURIComponent;

  return {
    base: root,
    request,
    status: () => get<StatusView>('/api/status'),
    createPlayer: () => post<Session>('/api/players'),
    createAgent: (name: string) => post<Session>('/api/agents', { body: { name } }),
    me: (token: string) => get<MeView>('/api/me', { token }),
    profile: (handle: string) => get<ProfileView>(`/api/players/${seg(handle)}`),
    companies: () => get<{ companies: CompanyView[] }>('/api/companies'),
    company: (ticker: string) => get<CompanyDetail>(`/api/companies/${seg(ticker)}`),
    history: (ticker: string, minutes: number) =>
      get<{ ticker: string; points: HistoryPoint[] }>(`/api/companies/${seg(ticker)}/history`, {
        query: { minutes },
      }),
    filings: (o: { limit?: number; ticker?: string } = {}) =>
      get<{ filings: FilingView[] }>('/api/filings', { query: o }),
    quote: (ticker: string, side: OrderSide, qty: number, signal?: AbortSignal) =>
      get<QuoteView>('/api/quote', { query: { ticker, side, qty }, signal }),
    placeOrder: (token: string, body: OrderBody) =>
      post<OrderFilled>('/api/orders', { token, body }),
    leaderboard: (limit = 50) =>
      get<{ rows: LeaderboardEntry[] }>('/api/leaderboard', { query: { limit } }),
    seasons: () => get<{ seasons: SeasonRow[] }>('/api/seasons'),
    season: (id: number) =>
      get<{ season: SeasonRow; results: SeasonResultView[] }>(`/api/seasons/${id}`),
    applyIpo: (token: string, address: string) =>
      post<{ app: IpoView }>('/api/ipo', { token, body: { address } }),
    ipoList: (limit = 20) => get<{ apps: IpoView[] }>('/api/ipo', { query: { limit } }),
    ipo: (id: string) => get<{ app: IpoView }>(`/api/ipo/${seg(id)}`),
    provenance: (limit = 50) =>
      get<{ calls: NansenCallView[] }>('/api/provenance', { query: { limit } }),
    provenanceCall: (id: string) => get<{ call: NansenCallView }>(`/api/provenance/${seg(id)}`),
    authNonce: (token: string) =>
      get<{ nonce: string; message: string }>('/api/auth/nonce', { token }),
    authLink: (token: string, address: string, signature: string) =>
      post<{ player: PlayerView }>('/api/auth/link', { token, body: { address, signature } }),
    mirrorStatus: () => get<{ available: boolean; mode: 'live' | 'replay' }>('/api/mirror/status'),
    builderFee: (token: string) => get<BuilderFeeStatus>('/api/mirror/builder-fee', { token }),
    registerAgent: (token: string, masterAddress: string, agentAddress: string) =>
      post<{ ok: true }>('/api/mirror/agent', { token, body: { masterAddress, agentAddress } }),
    mirrorPrepare: (token: string, body: MirrorPrepareBody) =>
      post<PrepareView>('/api/mirror/prepare', { token, body }),
    mirrorExecute: (token: string, stepId: string, signature: SignatureParts) =>
      post<MirrorReceipt>('/api/mirror/execute', {
        token,
        body: { stepId, signature },
        timeoutMs: EXECUTE_TIMEOUT_MS,
      }),
    mirrorOrders: (token: string) =>
      get<{ orders: MirrorOrderView[] }>('/api/mirror/orders', { token }),
  };
}

export type Api = ReturnType<typeof createApi>;
