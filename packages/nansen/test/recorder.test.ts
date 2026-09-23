import { describe, expect, it } from 'vitest';
import { type NansenRecord, recordingFetch, replayFetch, requestKey } from '../src/index';

describe('recorder', () => {
  it('requestKey ignores volatile fields and key order', () => {
    const a = requestKey(
      'POST',
      'https://api.nansen.ai/api/v1/x',
      JSON.stringify({ address: '0x1', date: { from: '2026-01-01', to: '2026-02-01' } }),
    );
    const b = requestKey(
      'POST',
      'https://api.nansen.ai/api/v1/x',
      JSON.stringify({ date: { from: '2025-01-01', to: '2025-02-01' }, address: '0x1' }),
    );
    expect(a).toBe(b);
    expect(a).toBe('POST /api/v1/x {"address":"0x1"}');
  });

  it('records responses without leaking headers', async () => {
    const recs: NansenRecord[] = [];
    const inner = (async () =>
      new Response('{"ok":1}', { status: 200 })) as unknown as typeof fetch;
    const f = recordingFetch(
      inner,
      (r) => recs.push(r),
      () => 42,
    );
    const res = await f('https://api.nansen.ai/api/v1/y', {
      method: 'POST',
      headers: { apikey: 'secret' },
      body: '{"a":1}',
    });
    expect(await res.json()).toEqual({ ok: 1 });
    expect(recs).toEqual([
      {
        t: 42,
        k: 'nansen',
        key: 'POST /api/v1/y {"a":1}',
        path: '/api/v1/y',
        status: 200,
        body: { ok: 1 },
      },
    ]);
    expect(JSON.stringify(recs)).not.toContain('secret');
  });

  it('replays the latest record at or before now, earliest otherwise, 503 when missing', async () => {
    const key = 'POST /api/v1/y {"a":1}';
    const recs: NansenRecord[] = [
      { t: 100, k: 'nansen', key, path: '/api/v1/y', status: 200, body: { v: 1 } },
      { t: 200, k: 'nansen', key, path: '/api/v1/y', status: 200, body: { v: 2 } },
    ];
    let now = 150;
    const f = replayFetch(recs, () => now);
    const call = async () =>
      (await f('https://api.nansen.ai/api/v1/y', { method: 'POST', body: '{"a":1}' })).json();
    expect(await call()).toEqual({ v: 1 });
    now = 250;
    expect(await call()).toEqual({ v: 2 });
    now = 50;
    expect(await call()).toEqual({ v: 1 });
    const miss = await f('https://api.nansen.ai/api/v1/z', { method: 'POST', body: '{}' });
    expect(miss.status).toBe(503);
  });
});
