import { describe, expect, it } from 'vitest';
import { type CallRecord, type Clock, NansenHttp } from '../src/index';

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

  it('applies the per-endpoint limit for profiler/perp-trades', async () => {
    const clock = new FakeClock();
    const replies = Array.from({ length: 6 }, () => ({ status: 200, body: '{}' }));
    const http = new NansenHttp({ apiKey: 'k', fetch: fakeFetch(replies), clock });
    for (let i = 0; i < 6; i++)
      await http.request('POST', '/api/v1/profiler/perp-trades', {}, parseAny);
    expect(clock.t).toBeGreaterThanOrEqual(60_000);
  });
});
