import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { type CallRecord, type Clock, DEFAULT_ENDPOINT_LIMITS, NansenHttp } from '../src/index';

class FakeClock implements Clock {
  t = 0;
  sleeps: number[] = [];
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.sleeps.push(ms);
    this.t += ms;
  }
}

type Reply = { status: number; body: string; headers?: Record<string, string> };
function fakeFetch(replies: Reply[], seen: Request[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(new Request(input, init));
    const r = replies.shift();
    if (!r) throw new Error('no more replies');
    return new Response(r.body, { status: r.status, headers: r.headers });
  }) as typeof fetch;
}

const parseAny = (j: unknown) => j as { n: number };

describe('NansenHttp', () => {
  it('sends the api key and body, returns parsed value and logs one call', async () => {
    const seen: Request[] = [];
    const calls: CallRecord[] = [];
    const http = new NansenHttp({
      apiKey: 'k-123',
      fetch: fakeFetch(
        [{ status: 200, body: '{"n":1}', headers: { 'X-Nansen-Credits-Used': '5' } }],
        seen,
      ),
      clock: new FakeClock(),
      onCall: (c) => calls.push(c),
    });
    const r = await http.request('POST', '/api/v1/x', { a: 1 }, parseAny);
    expect(r).toMatchObject({ ok: true, value: { n: 1 } });
    expect(seen[0]?.headers.get('apikey')).toBe('k-123');
    expect(seen[0]?.url).toBe('https://api.nansen.ai/api/v1/x');
    expect(await seen[0]?.text()).toBe('{"a":1}');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/v1/x',
      status: 200,
      creditsUsed: 5,
      error: null,
      attempts: 1,
    });
    expect(calls[0]?.id).toBe(r.callId);
    expect(JSON.stringify(calls)).not.toContain('k-123');
  });

  it('retries 429 honoring Retry-After, then succeeds', async () => {
    const clock = new FakeClock();
    const http = new NansenHttp({
      apiKey: 'k',
      fetch: fakeFetch([
        { status: 429, body: '{"message":"slow down"}', headers: { 'Retry-After': '2' } },
        { status: 200, body: '{"n":2}' },
      ]),
      clock,
    });
    const r = await http.request('GET', '/api/v1/account', undefined, parseAny);
    expect(r.ok).toBe(true);
    expect(clock.sleeps).toContain(2_000);
  });

  it('gives up after max retries on 5xx and reports the status', async () => {
    const calls: CallRecord[] = [];
    const http = new NansenHttp({
      apiKey: 'k',
      fetch: fakeFetch([
        { status: 502, body: 'bad' },
        { status: 502, body: 'bad' },
        { status: 502, body: 'bad' },
      ]),
      clock: new FakeClock(),
      onCall: (c) => calls.push(c),
    });
    const r = await http.request('POST', '/api/v1/y', {}, parseAny);
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(calls[0]?.attempts).toBe(3);
  });

  it('does not retry when retries: 0', async () => {
    const http = new NansenHttp({
      apiKey: 'k',
      fetch: fakeFetch([{ status: 503, body: '' }]),
      clock: new FakeClock(),
    });
    const r = await http.request('POST', '/api/v1/perp/execute', {}, parseAny, { retries: 0 });
    expect(r).toMatchObject({ ok: false, status: 503 });
  });

  it('maps 4xx messages, invalid JSON and schema errors', async () => {
    const http = new NansenHttp({
      apiKey: 'k',
      fetch: fakeFetch([
        { status: 422, body: '{"message":"Order rejected: insufficient margin"}' },
        { status: 200, body: 'not json' },
        { status: 200, body: '{"n":1}' },
      ]),
      clock: new FakeClock(),
    });
    expect(await http.request('POST', '/a', {}, parseAny)).toMatchObject({
      ok: false,
      error: 'HTTP 422: Order rejected: insufficient margin',
    });
    expect(await http.request('POST', '/b', {}, parseAny)).toMatchObject({
      ok: false,
      error: 'invalid JSON',
    });
    const r = await http.request('POST', '/c', {}, () => {
      throw new Error('missing field data');
    });
    expect(r).toMatchObject({ ok: false, error: 'schema: missing field data' });
  });

  it('appends query parameters', async () => {
    const seen: Request[] = [];
    const http = new NansenHttp({
      apiKey: 'k',
      fetch: fakeFetch([{ status: 200, body: '{}' }], seen),
      clock: new FakeClock(),
    });
    await http.request('GET', '/api/v1/perp/builder-fee', undefined, parseAny, {
      query: { wallet_address: '0xabc' },
    });
    expect(seen[0]?.url).toBe('https://api.nansen.ai/api/v1/perp/builder-fee?wallet_address=0xabc');
  });

  it('never exposes the api key on the instance (JSON.stringify / util.inspect)', () => {
    const http = new NansenHttp({
      apiKey: 'super-secret-key',
      fetch: fakeFetch([]),
      clock: new FakeClock(),
    });
    expect(JSON.stringify(http)).not.toContain('super-secret-key');
    expect(inspect(http)).not.toContain('super-secret-key');
  });

  it('uses a full randomUUID for call ids', async () => {
    const http = new NansenHttp({
      apiKey: 'k',
      fetch: fakeFetch([{ status: 200, body: '{}' }]),
      clock: new FakeClock(),
    });
    const r = await http.request('GET', '/api/v1/account', undefined, parseAny);
    expect(r.callId).toMatch(/^nc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('caps the Retry-After sleep at 60,000 ms', async () => {
    const clock = new FakeClock();
    const http = new NansenHttp({
      apiKey: 'k',
      fetch: fakeFetch([
        { status: 429, body: '{"message":"slow down"}', headers: { 'Retry-After': '3600' } },
        { status: 200, body: '{"n":2}' },
      ]),
      clock,
    });
    const r = await http.request('GET', '/api/v1/account', undefined, parseAny);
    expect(r.ok).toBe(true);
    expect(clock.sleeps).toContain(60_000);
    expect(clock.sleeps).not.toContain(3_600_000);
  });

  it('applies the per-endpoint limit for profiler/perp-trades (5 per 62 s: the server window starts on receipt)', async () => {
    expect(DEFAULT_ENDPOINT_LIMITS['/api/v1/profiler/perp-trades']).toEqual([
      { limit: 5, windowMs: 62_000 },
    ]);
    const clock = new FakeClock();
    const replies = Array.from({ length: 6 }, () => ({ status: 200, body: '{}' }));
    const http = new NansenHttp({ apiKey: 'k', fetch: fakeFetch(replies), clock });
    for (let i = 0; i < 6; i++)
      await http.request('POST', '/api/v1/profiler/perp-trades', {}, parseAny);
    expect(clock.t).toBeGreaterThanOrEqual(62_000);
  });

  /** A fetch that notes the fake-clock time of every request it receives. */
  function timedFetch(clock: FakeClock, replies: Reply[], sentAt: number[]): typeof fetch {
    const inner = fakeFetch(replies);
    return (async (input: string | URL | Request, init?: RequestInit) => {
      sentAt.push(clock.now());
      return inner(input, init);
    }) as typeof fetch;
  }
  const endpoint429 = (retryAfter: string): Reply => ({
    status: 429,
    body: '{"code":"rate_limit_exceeded","message":"Rate limit exceeded.","retry_after":60}',
    headers: { 'retry-after': retryAfter, 'x-nansen-ratelimit-scope': 'endpoint' },
  });

  it('an endpoint-scoped 429 blocks that endpoint for Retry-After; other endpoints go on', async () => {
    const clock = new FakeClock();
    const sentAt: number[] = [];
    const ok = { status: 200, body: '{}' };
    const http = new NansenHttp({
      apiKey: 'k',
      fetch: timedFetch(clock, [endpoint429('60'), ok, ok, endpoint429('30'), ok], sentAt),
      clock,
    });
    const trades = '/api/v1/profiler/perp-trades';
    const r = await http.request('POST', trades, {}, parseAny, { retries: 0 });
    expect(r).toMatchObject({ ok: false, status: 429 });
    await http.request('POST', '/api/v1/profiler/perp-positions', {}, parseAny);
    await http.request('POST', trades, {}, parseAny);
    expect(sentAt).toEqual([0, 0, 60_000]);
    // Also an endpoint with no configured window of its own.
    const summary = '/api/v1/profiler/perp-pnl-summary';
    await http.request('POST', summary, {}, parseAny, { retries: 0 });
    await http.request('POST', summary, {}, parseAny);
    expect(sentAt.slice(3)).toEqual([60_000, 90_000]);
  });

  it('caps the endpoint block at 60,000 ms; a 429 of another scope blocks nothing', async () => {
    const clock = new FakeClock();
    const sentAt: number[] = [];
    const ok = { status: 200, body: '{}' };
    const keyScoped: Reply = { status: 429, body: '{}', headers: { 'retry-after': '30' } };
    const http = new NansenHttp({
      apiKey: 'k',
      fetch: timedFetch(clock, [endpoint429('3600'), ok, keyScoped, ok], sentAt),
      clock,
    });
    const path = '/api/v1/profiler/perp-positions';
    await http.request('POST', path, {}, parseAny, { retries: 0 });
    await http.request('POST', path, {}, parseAny);
    expect(sentAt).toEqual([0, 60_000]);
    await http.request('POST', path, {}, parseAny, { retries: 0 });
    await http.request('POST', path, {}, parseAny);
    expect(sentAt.slice(2)).toEqual([60_000, 60_000]);
  });

  it('keeps the error code and reads `detail`: credit exhaustion is a 403 with code insufficient_credits', async () => {
    const http = new NansenHttp({
      apiKey: 'k',
      fetch: fakeFetch([
        {
          status: 403,
          body: '{"code":"insufficient_credits","message":"You have run out of credits.","detail":"Top up at app.nansen.ai"}',
        },
        { status: 403, body: '{"code":"insufficient_credits","detail":"Not enough credits"}' },
        { status: 422, body: '{"detail":"Order rejected: wrong side"}' },
        { status: 403, body: '{"code":"forbidden"}' },
        { status: 422, body: '{"detail":[{"loc":["body"],"msg":"bad"}]}' },
      ]),
      clock: new FakeClock(),
    });
    const errorOf = async () => {
      const r = await http.request('POST', '/api/v1/x', {}, parseAny);
      return r.ok ? null : r.error;
    };
    expect(await errorOf()).toBe('HTTP 403: insufficient_credits: You have run out of credits.');
    expect(await errorOf()).toBe('HTTP 403: insufficient_credits: Not enough credits');
    expect(await errorOf()).toBe('HTTP 422: Order rejected: wrong side');
    expect(await errorOf()).toBe('HTTP 403: forbidden');
    expect(await errorOf()).toBe('HTTP 422: {"detail":[{"loc":["body"],"msg":"bad"}]}');
  });

  it('records the balance a response reports in x-nansen-credits-remaining', async () => {
    const calls: CallRecord[] = [];
    const http = new NansenHttp({
      apiKey: 'k',
      fetch: fakeFetch([
        {
          status: 200,
          body: '{}',
          headers: { 'x-nansen-credits-used': '5', 'x-nansen-credits-remaining': '1095' },
        },
        { status: 200, body: '{}', headers: { 'x-nansen-credits-cost': '0' } },
        { status: 403, body: '{}', headers: { 'x-nansen-credits-remaining': '0' } },
        { status: 200, body: '{}', headers: { 'x-nansen-credits-remaining': 'lots' } },
      ]),
      clock: new FakeClock(),
      onCall: (c) => calls.push(c),
    });
    for (let i = 0; i < 4; i++) await http.request('POST', '/api/v1/x', {}, parseAny);
    expect(calls.map((c) => c.creditsRemaining)).toEqual([1_095, null, 0, null]);
    expect(calls[0]?.creditsUsed).toBe(5);
  });
});
