import { randomUUID } from 'node:crypto';
import { type Clock, RateLimiter, realClock, type WindowLimit } from './limiter';
import { sha256Hex, stableStringify } from './stable';

export interface CallRecord {
  id: string;
  method: 'GET' | 'POST';
  path: string;
  requestHash: string;
  status: number | null;
  creditsUsed: number | null;
  latencyMs: number;
  at: number;
  responseHash: string | null;
  error: string | null;
  attempts: number;
}

export type ApiResult<T> =
  | { ok: true; value: T; callId: string }
  | { ok: false; error: string; status: number | null; callId: string };

export interface NansenHttpOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  clock?: Clock;
  timeoutMs?: number;
  maxRetries?: number;
  onCall?: (r: CallRecord) => void;
  perSecond?: number;
  perMinute?: number;
  endpointLimits?: Record<string, WindowLimit[]>;
}

export interface RequestOptions {
  retries?: number;
  query?: Record<string, string>;
}

export const DEFAULT_ENDPOINT_LIMITS: Record<string, WindowLimit[]> = {
  '/api/v1/profiler/perp-trades': [{ limit: 5, windowMs: 60_000 }],
};

let counter = 0;
const nextId = () => `nc_${(++counter).toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 6)}`;

function messageOf(text: string): string {
  try {
    const j = JSON.parse(text) as { message?: unknown; error?: unknown };
    if (typeof j.message === 'string') return j.message;
    if (typeof j.error === 'string') return j.error;
  } catch {
    // not JSON
  }
  return text.slice(0, 200);
}

export class NansenHttp {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly global: RateLimiter;
  private readonly perEndpoint = new Map<string, RateLimiter>();

  constructor(private readonly o: NansenHttpOptions) {
    this.baseUrl = o.baseUrl ?? 'https://api.nansen.ai';
    this.fetchImpl = o.fetch ?? fetch;
    this.clock = o.clock ?? realClock;
    this.timeoutMs = o.timeoutMs ?? 15_000;
    this.maxRetries = o.maxRetries ?? 2;
    this.global = new RateLimiter(
      [
        { limit: o.perSecond ?? 15, windowMs: 1_000 },
        { limit: o.perMinute ?? 300, windowMs: 60_000 },
      ],
      this.clock,
    );
    for (const [path, windows] of Object.entries(o.endpointLimits ?? DEFAULT_ENDPOINT_LIMITS)) {
      this.perEndpoint.set(path, new RateLimiter(windows, this.clock));
    }
  }

  async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    parse: (json: unknown) => T,
    opts: RequestOptions = {},
  ): Promise<ApiResult<T>> {
    const id = nextId();
    const retries = opts.retries ?? this.maxRetries;
    const query =
      opts.query && Object.keys(opts.query).length > 0 ? `?${new URLSearchParams(opts.query)}` : '';
    const requestHash = sha256Hex(stableStringify({ method, path, query: opts.query, body }));
    const at = this.clock.now();
    let attempts = 0;

    const finish = (
      r: ApiResult<T>,
      status: number | null,
      credits: number | null,
      responseHash: string | null,
      started: number,
    ): ApiResult<T> => {
      this.o.onCall?.({
        id,
        method,
        path,
        requestHash,
        status,
        creditsUsed: credits,
        latencyMs: this.clock.now() - started,
        at,
        responseHash,
        error: r.ok ? null : r.error,
        attempts,
      });
      return r;
    };

    for (;;) {
      attempts++;
      await this.global.acquire();
      await this.perEndpoint.get(path)?.acquire();
      const started = this.clock.now();
      let res: Response;
      let text: string;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}${query}`, {
          method,
          headers: {
            apikey: this.o.apiKey,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        text = await res.text();
      } catch (e) {
        const err =
          e instanceof Error && e.name === 'TimeoutError'
            ? 'timeout'
            : `network: ${e instanceof Error ? e.message : String(e)}`;
        if (attempts <= retries) {
          await this.clock.sleep(500 * 2 ** (attempts - 1));
          continue;
        }
        return finish(
          { ok: false, error: err, status: null, callId: id },
          null,
          null,
          null,
          started,
        );
      }

      const creditsHeader = res.headers.get('x-nansen-credits-used');
      const credits =
        creditsHeader !== null && creditsHeader !== '' && Number.isFinite(Number(creditsHeader))
          ? Number(creditsHeader)
          : null;

      if (res.status === 429 || res.status >= 500) {
        if (attempts <= retries) {
          const ra = Number(res.headers.get('retry-after'));
          await this.clock.sleep(
            Number.isFinite(ra) && ra > 0 ? ra * 1_000 : 500 * 2 ** (attempts - 1),
          );
          continue;
        }
        return finish(
          {
            ok: false,
            error: `HTTP ${res.status}: ${messageOf(text)}`,
            status: res.status,
            callId: id,
          },
          res.status,
          credits,
          null,
          started,
        );
      }
      if (!res.ok) {
        return finish(
          {
            ok: false,
            error: `HTTP ${res.status}: ${messageOf(text)}`,
            status: res.status,
            callId: id,
          },
          res.status,
          credits,
          null,
          started,
        );
      }
      const responseHash = sha256Hex(text);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return finish(
          { ok: false, error: 'invalid JSON', status: res.status, callId: id },
          res.status,
          credits,
          responseHash,
          started,
        );
      }
      try {
        return finish(
          { ok: true, value: parse(json), callId: id },
          res.status,
          credits,
          responseHash,
          started,
        );
      } catch (e) {
        return finish(
          {
            ok: false,
            error: `schema: ${e instanceof Error ? e.message : String(e)}`,
            status: res.status,
            callId: id,
          },
          res.status,
          credits,
          responseHash,
          started,
        );
      }
    }
  }
}
