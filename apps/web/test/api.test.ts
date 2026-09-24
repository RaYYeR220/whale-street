import { describe, expect, it } from 'vitest';
import { createApi, EXECUTE_TIMEOUT_MS } from '../lib/api';
import { fakeFetch, json, status } from './helpers';

const BASE = 'http://engine.test/';

describe('engine API client', () => {
  it('returns data on success and trims the trailing slash of the base', async () => {
    const f = fakeFetch({ 'GET /api/status': () => json(status()) });
    const api = createApi(BASE, f.impl);
    expect(api.base).toBe('http://engine.test');
    const r = await api.status();
    expect(r).toEqual({ ok: true, data: status() });
  });

  it('sends the bearer token, JSON body and query string', async () => {
    const f = fakeFetch({
      'POST /api/orders': () => json({ ok: true }),
      'GET /api/quote': () => json({ ok: true }),
    });
    const api = createApi(BASE, f.impl);
    await api.placeOrder('tok', { ticker: 'OOH', side: 'BUY', qty: 2 });
    await api.quote('OOH', 'SELL', 1.5);
    const [order, quote] = f.calls;
    const headers = order?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(String(order?.init.body))).toEqual({ ticker: 'OOH', side: 'BUY', qty: 2 });
    expect(quote?.url.searchParams.get('side')).toBe('SELL');
    expect(quote?.url.searchParams.get('qty')).toBe('1.5');
  });

  it('surfaces engine error bodies, including mirror refusals', async () => {
    const refusals = [{ code: 'STALE_SNAPSHOT', message: 'trader data is 75 s old' }];
    const f = fakeFetch({
      'POST /api/mirror/prepare': () =>
        json({ error: 'REFUSED', message: 'refused', refusals }, 422),
    });
    const r = await createApi(BASE, f.impl).mirrorPrepare('tok', {
      ticker: 'OOH',
      coin: 'BTC',
      notionalUsd: 50,
      leverage: 2,
      stopLossPct: 0.25,
    });
    expect(r).toEqual({ ok: false, status: 422, error: 'REFUSED', message: 'refused', refusals });
  });

  it('falls back to the HTTP status when the error body is not JSON', async () => {
    const f = fakeFetch({
      'GET /api/status': () =>
        new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
    });
    const r = await createApi(BASE, f.impl).status();
    expect(r).toEqual({ ok: false, status: 502, error: 'HTTP_502', message: 'Bad Gateway' });
  });

  it('treats an empty success body as a bad response, not as data', async () => {
    const f = fakeFetch({ 'GET /api/status': () => new Response('', { status: 200 }) });
    const r = await createApi(BASE, f.impl).status();
    expect(r).toMatchObject({ ok: false, error: 'BAD_RESPONSE' });
  });

  it('reports a network failure with status 0 and never throws', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const r = await createApi(BASE, failing).companies();
    expect(r).toMatchObject({ ok: false, status: 0, error: 'NETWORK' });
  });

  it('reports a timeout distinctly', async () => {
    const hanging = ((_: unknown, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const r = await createApi(BASE, hanging).request('GET', '/api/status', { timeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, status: 0, error: 'TIMEOUT' });
  });

  it('reports a request its caller cancelled as CANCELLED, not as a network failure', async () => {
    const hanging = ((_: unknown, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const ctl = new AbortController();
    const pending = createApi(BASE, hanging).quote('OOH', 'BUY', 1, ctl.signal);
    ctl.abort();
    expect(await pending).toMatchObject({ ok: false, status: 0, error: 'CANCELLED' });
  });

  it('posts the agent signature to execute, with a 30 s budget', async () => {
    const f = fakeFetch({ 'POST /api/mirror/execute': () => json({ status: 'FILLED' }) });
    await createApi(BASE, f.impl).mirrorExecute('tok', 'step-1', { r: '0x1', s: '0x2', v: 27 });
    expect(EXECUTE_TIMEOUT_MS).toBe(30_000);
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({
      stepId: 'step-1',
      signature: { r: '0x1', s: '0x2', v: 27 },
    });
  });

  it('encodes path segments', async () => {
    const f = fakeFetch({ 'GET /api/players/Velvet%20Anchovy%20%23412': () => json({}) });
    const r = await createApi(BASE, f.impl).profile('Velvet Anchovy #412');
    expect(r.ok).toBe(true);
  });
});
