import { randomUUID } from 'node:crypto';
import { type Clock, RateLimiter, realClock, type WindowLimit } from './limiter';
import { RECORDED_AT_HEADER } from './recorder';
import { sha256Hex, stableStringify } from './stable';

export interface CallRecord {
  id: string;
  method: 'GET' | 'POST';
  path: string;
  requestHash: string;
  status: number | null;
  creditsUsed: number | null;
  /** The account balance the response reported (`x-nansen-credits-remaining`), if any. */
  creditsRemaining: number | null;
  latencyMs: number;
  at: number;
  responseHash: string | null;
  error: string | null;
  attempts: number;
  /** REPLAY: answered from the recording; `at` is then the time it was recorded. */
  recorded: boolean;
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
  /**
   * REPLAY: answers carry the time they were recorded (RECORDED_AT_HEADER, set by replayFetch);
   * each such call is logged at that time with `recorded: true`. Off (LIVE): the header is ignored.
   */
  replay?: boolean;
}

export interface RequestOptions {
  retries?: number;
  query?: Record<string, string>;
}

/** Caps how long we'll honor a server-supplied Retry-After header, so a misbehaving or hostile
 * response can't stall a caller indefinitely. */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Per-endpoint request windows. perp-trades allows 5 per minute in a fixed window that starts when
 * the server receives the first call, while our limiter stamps a call before it is sent: the extra
 * 2 s absorbs that skew (a 60 s window drew a 429 and a 60 s stall live).
 */
export const DEFAULT_ENDPOINT_LIMITS: Record<string, WindowLimit[]> = {
  '/api/v1/profiler/perp-trades': [{ limit: 5, windowMs: 62_000 }],
};

const nextId = () => `nc_${randomUUID()}`;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * The error text of a failed response: `code: message` when the body carries a machine code
 * (e.g. `insufficient_credits`, which arrives as HTTP 403), the message taken from `message`,
 * `detail` or `error`; the raw text (trimmed) otherwise.
 */
function messageOf(text: string): string {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const message = str(j.message) ?? str(j.detail) ?? str(j.error);
    const code = str(j.code);
    if (code) return message ? `${code}: ${message}` : code;
    if (message) return message;
  } catch {
    // not JSON (or not an object)
  }
  return text.slice(0, 200);
}

/** A header holding a finite number, or null. */
function numHeader(h: Headers, name: string): number | null {
  const v = h.get(name);
  return v !== null && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
}

/**
 * How long the server asked us to wait, in ms (capped): the Retry-After header in seconds, else
 * the body's `retry_after`; null when neither gives a positive number.
 */
function retryAfterMs(h: Headers, text: string): number | null {
  let s = Number(h.get('retry-after'));
  if (!(Number.isFinite(s) && s > 0)) {
    try {
      s = Number((JSON.parse(text) as { retry_after?: unknown }).retry_after);
    } catch {
      s = Number.NaN;
    }
  }
  return Number.isFinite(s) && s > 0 ? Math.min(s * 1_000, MAX_RETRY_AFTER_MS) : null;
}

interface Meter {
  used: number | null;
  remaining: number | null;
}
const NO_METER: Meter = { used: null, remaining: null };

export class NansenHttp {
  // True (ES) private fields: unlike `private` (a TypeScript-only annotation), these are excluded
  // from JSON.stringify, Object.keys/entries and util.inspect, so the api key never leaks via
  // logging or serializing an instance.
  #apiKey: string;
  #onCall: ((r: CallRecord) => void) | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly replay: boolean;
  private readonly global: RateLimiter;
  private readonly perEndpoint = new Map<string, RateLimiter>();

  constructor(o: NansenHttpOptions) {
    this.#apiKey = o.apiKey;
    this.#onCall = o.onCall;
    this.baseUrl = o.baseUrl ?? 'https://api.nansen.ai';
    this.fetchImpl = o.fetch ?? fetch;
    this.clock = o.clock ?? realClock;
    this.timeoutMs = o.timeoutMs ?? 15_000;
    this.maxRetries = o.maxRetries ?? 2;
    this.replay = o.replay ?? false;
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

  /** The limiter of one endpoint, created (without windows of its own) on first need. */
  private endpointLimiter(path: string): RateLimiter {
    let limiter = this.perEndpoint.get(path);
    if (!limiter) {
      limiter = new RateLimiter([], this.clock);
      this.perEndpoint.set(path, limiter);
    }
    return limiter;
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
    /** REPLAY: when the answer being logged was recorded. */
    let recordedAt: number | null = null;

    const finish = (
      r: ApiResult<T>,
      status: number | null,
      meter: Meter,
      responseHash: string | null,
      started: number,
    ): ApiResult<T> => {
      this.#onCall?.({
        id,
        method,
        path,
        requestHash,
        status,
        creditsUsed: meter.used,
        creditsRemaining: meter.remaining,
        latencyMs: this.clock.now() - started,
        at: recordedAt ?? at,
        responseHash,
        error: r.ok ? null : r.error,
        attempts,
        recorded: recordedAt !== null,
      });
      return r;
    };

    for (;;) {
      attempts++;
      recordedAt = null;
      await this.global.acquire();
      await this.perEndpoint.get(path)?.acquire();
      const started = this.clock.now();
      let res: Response;
      let text: string;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}${query}`, {
          method,
          headers: {
            apikey: this.#apiKey,
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
          NO_METER,
          null,
          started,
        );
      }

      recordedAt = this.replay ? numHeader(res.headers, RECORDED_AT_HEADER) : null;
      const credits: Meter = {
        used: numHeader(res.headers, 'x-nansen-credits-used'),
        remaining: numHeader(res.headers, 'x-nansen-credits-remaining'),
      };

      if (res.status === 429 || res.status >= 500) {
        const waitMs = retryAfterMs(res.headers, text);
        // An endpoint-scoped limit holds every caller of this endpoint, not just this one.
        if (
          res.status === 429 &&
          waitMs !== null &&
          res.headers.get('x-nansen-ratelimit-scope')?.toLowerCase() === 'endpoint'
        )
          this.endpointLimiter(path).blockFor(waitMs);
        if (attempts <= retries) {
          await this.clock.sleep(waitMs ?? 500 * 2 ** (attempts - 1));
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
