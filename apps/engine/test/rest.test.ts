import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { IDLE_AFTER_MS } from '../src/ingest/idle';
import { linkMessage } from '../src/services/players';
import { bearer, type TestEngine, testEngine } from './helpers/engine';
import { programCleanTrader } from './helpers/traders';
import { addCompany } from './helpers/world';

const A = '0x00000000000000000000000000000000000000a1' as const;
let t: TestEngine;

afterEach(async () => {
  await t.app.close();
});

async function signup() {
  const r = await t.app.inject({ method: 'POST', url: '/api/players' });
  expect(r.statusCode).toBe(201);
  return r.json() as { player: { id: string; handle: string }; token: string };
}

function seedCompany() {
  const rt = addCompany(t.engine, { id: A, ticker: 'AAA' });
  t.clock.advance(61_000);
  return rt;
}

describe('REST', () => {
  it('health, status and anonymous signup', async () => {
    t = await testEngine();
    expect((await t.app.inject({ url: '/healthz' })).json()).toEqual({ ok: true });
    const status = (await t.app.inject({ url: '/api/status' })).json();
    expect(status).toMatchObject({
      mode: 'replay',
      idle: false,
      creditSaver: false,
      season: { id: 1 },
      now: t.clock.now(),
      loop: null,
    });
    const { player, token } = await signup();
    const me = await t.app.inject({ url: '/api/me', headers: bearer(token) });
    expect(me.json()).toMatchObject({
      player: { id: player.id },
      portfolio: { cash: 10_000, holdings: [] },
    });
    expect((await t.app.inject({ url: '/api/me' })).statusCode).toBe(401);
    expect(
      (await t.app.inject({ url: '/api/me', headers: bearer('x'.repeat(64)) })).json(),
    ).toMatchObject({ error: 'UNAUTHORIZED' });
  });

  it('companies, quote, orders and leaderboard', async () => {
    t = await testEngine();
    seedCompany();
    const { token, player } = await signup();
    const list = (await t.app.inject({ url: '/api/companies' })).json();
    expect(list.companies.map((c: { ticker: string }) => c.ticker)).toEqual(['AAA']);
    const detail = (await t.app.inject({ url: '/api/companies/aaa' })).json();
    expect(detail.company).toMatchObject({ ticker: 'AAA', nav: 100, price: 100, status: 'ACTIVE' });
    expect((await t.app.inject({ url: '/api/companies/ZZZ' })).statusCode).toBe(404);

    const quote = await t.app.inject({ url: '/api/quote?ticker=AAA&side=BUY&qty=10' });
    expect(quote.json()).toMatchObject({ ok: true, ticker: 'AAA', qty: 10 });

    const buy = await t.app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: bearer(token),
      payload: { ticker: 'AAA', side: 'BUY', qty: 10 },
    });
    expect(buy.statusCode).toBe(200);
    expect(buy.json().portfolio.holdings[0]).toMatchObject({ ticker: 'AAA', longQty: 10 });
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: bearer(token),
      payload: { ticker: 'AAA', side: 'SELL', qty: 99 },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: 'INSUFFICIENT_SHARES' });
    const invalid = await t.app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: bearer(token),
      payload: { ticker: 'AAA', side: 'HOLD' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/orders',
          payload: { ticker: 'AAA', side: 'BUY', qty: 1 },
        })
      ).statusCode,
    ).toBe(401);

    const lb = (await t.app.inject({ url: '/api/leaderboard' })).json();
    expect(lb.rows[0]).toMatchObject({ rank: 1, playerId: player.id });
    const profile = (
      await t.app.inject({ url: `/api/players/${encodeURIComponent(player.handle)}` })
    ).json();
    expect(profile.player).toMatchObject({ handle: player.handle, walletLinked: false });
    expect(profile.trades[0]).toMatchObject({ ticker: 'AAA', side: 'BUY' });
  });

  it('history, filings and provenance', async () => {
    t = await testEngine();
    const rt = seedCompany();
    t.engine.state.setMarks({}, t.clock.now());
    t.engine.tick();
    t.engine.statusOps.halt(rt, 'data', 'test halt', t.clock.now());
    t.engine.repos.nansenCalls.insert({
      id: 'nc_1',
      method: 'POST',
      path: '/api/v1/profiler/perp-positions',
      requestHash: 'rq',
      status: 200,
      creditsUsed: 1,
      latencyMs: 20,
      at: t.clock.now(),
      responseHash: 'rs',
      error: null,
      attempts: 1,
    });
    const history = (await t.app.inject({ url: '/api/companies/AAA/history?minutes=60' })).json();
    expect(history.points).toHaveLength(1);
    const filings = (await t.app.inject({ url: '/api/filings?ticker=AAA&limit=5' })).json();
    expect(filings.filings.map((f: { kind: string }) => f.kind)).toEqual(['HALT']);
    expect(filings.filings[0].explorerUrl).toContain(A);
    expect((await t.app.inject({ url: '/api/provenance/nc_1' })).json().call).toMatchObject({
      path: '/api/v1/profiler/perp-positions',
      credits: 1,
    });
    expect((await t.app.inject({ url: '/api/provenance' })).json().calls).toHaveLength(1);
    expect((await t.app.inject({ url: '/api/provenance/nope' })).statusCode).toBe(404);
    // Trading calls (Mirror) stay in the DB but are never public.
    t.engine.repos.nansenCalls.insert({
      id: 'nc_trade',
      method: 'POST',
      path: '/api/v1/perp/order',
      requestHash: 'rq2',
      status: 200,
      creditsUsed: 0,
      latencyMs: 30,
      at: t.clock.now() + 1,
      responseHash: 'rs2',
      error: null,
      attempts: 1,
    });
    expect(t.engine.repos.nansenCalls.get('nc_trade')).toBeDefined();
    const calls = (await t.app.inject({ url: '/api/provenance' })).json().calls;
    expect(calls.map((c: { id: string }) => c.id)).toEqual(['nc_1']);
    expect((await t.app.inject({ url: '/api/provenance/nc_trade' })).statusCode).toBe(404);
  });

  it('IPO desk end to end: apply, poll, list verdicts', async () => {
    t = await testEngine();
    const { token } = await signup();
    programCleanTrader(t.nansen, t.info, A, t.clock.now());
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/ipo',
      headers: bearer(token),
      payload: { address: A },
    });
    expect(r.statusCode).toBe(202);
    const id = r.json().app.id as string;
    await t.engine.settle();
    const app = (await t.app.inject({ url: `/api/ipo/${id}` })).json().app;
    expect(app).toMatchObject({ status: 'APPROVED', address: A });
    expect((await t.app.inject({ url: '/api/ipo?limit=5' })).json().apps).toHaveLength(1);
    // The same address again: 200 with the existing application, no new evidence run.
    const calls = t.nansen.calls.length;
    const again = await t.app.inject({
      method: 'POST',
      url: '/api/ipo',
      headers: bearer(token),
      payload: { address: A },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().app).toMatchObject({ id, status: 'APPROVED' });
    expect(t.nansen.calls).toHaveLength(calls);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/ipo',
          headers: bearer(token),
          payload: { address: 'bad' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('IPO desk refusals: listed → 409, per-IP cap → 429 IPO_DESK_BUSY', async () => {
    t = await testEngine();
    seedCompany();
    const players = [await signup(), await signup(), await signup()];
    const apply = (token: string, address: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/ipo',
        headers: bearer(token),
        payload: { address },
      });
    const listed = await apply(players[0]?.token ?? '', A);
    expect(listed.statusCode).toBe(409);
    expect(listed.json()).toMatchObject({ error: 'ALREADY_LISTED' });
    const addr = (i: number) => `0x${(0xd00 + i).toString(16).padStart(40, '0')}`;
    for (let i = 0; i < 6; i++) {
      const r = await apply(players[Math.floor(i / 3)]?.token ?? '', addr(i));
      expect(r.statusCode).toBe(202);
    }
    const busy = await apply(players[2]?.token ?? '', addr(6));
    expect(busy.statusCode).toBe(429);
    expect(busy.json()).toMatchObject({ error: 'IPO_DESK_BUSY' });
    await t.engine.settle();
  });

  it('seasons, agents and wallet linking', async () => {
    t = await testEngine();
    expect((await t.app.inject({ url: '/api/seasons' })).json().seasons[0]).toMatchObject({
      id: 1,
      status: 'ACTIVE',
    });
    expect((await t.app.inject({ url: '/api/seasons/1' })).json()).toMatchObject({
      season: { id: 1 },
      results: [],
    });
    const agent = await t.app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: { name: 'Quant Bot' },
    });
    expect(agent.json().player).toMatchObject({ kind: 'agent' });

    const { token } = await signup();
    const account = privateKeyToAccount(generatePrivateKey());
    const { nonce } = (
      await t.app.inject({ url: '/api/auth/nonce', headers: bearer(token) })
    ).json();
    const signature = await account.signMessage({ message: linkMessage(account.address, nonce) });
    const linked = await t.app.inject({
      method: 'POST',
      url: '/api/auth/link',
      headers: bearer(token),
      payload: { address: account.address, signature },
    });
    expect(linked.json().player.walletAddress).toBe(account.address.toLowerCase());
  });

  it('refuses orders while IDLE with 503 MARKET_PAUSED, wakes the engine, and fills once NAV is live', async () => {
    t = await testEngine();
    seedCompany();
    const { token } = await signup();
    const liveTick = () => {
      t.engine.state.setMarks({}, t.clock.now());
      t.engine.tick();
    };
    liveTick();
    t.clock.advance(IDLE_AFTER_MS);
    liveTick();
    expect(t.engine.status().idle).toBe(true);
    const order = () =>
      t.app.inject({
        method: 'POST',
        url: '/api/orders',
        headers: bearer(token),
        payload: { ticker: 'AAA', side: 'BUY', qty: 1 },
      });
    const paused = await order();
    expect(paused.statusCode).toBe(503);
    expect(paused.json()).toMatchObject({ error: 'MARKET_PAUSED', retryAfterMs: 2_000 });
    expect(paused.headers['retry-after']).toBe('2');
    expect(t.engine.status().idle).toBe(false);
    expect(t.engine.state.flags.wokeAt).toBe(t.clock.now());
    // Awake, but NAV has not ticked since the wake: still paused.
    expect((await order()).statusCode).toBe(503);
    const quote = (await t.app.inject({ url: '/api/quote?ticker=AAA&side=BUY&qty=1' })).json();
    expect(quote).toMatchObject({ ok: true, paused: true });
    t.clock.advance(1_000);
    liveTick();
    expect((await order()).statusCode).toBe(200);
    expect(
      (await t.app.inject({ url: '/api/quote?ticker=AAA&side=BUY&qty=1' })).json(),
    ).toMatchObject({ ok: true, paused: false });
    // The write kept the engine awake: a viewer-less stretch shorter than the idle window stays live.
    t.clock.advance(IDLE_AFTER_MS - 1_000);
    liveTick();
    expect(t.engine.status().idle).toBe(false);
  });

  it('refuses orders with 503 MARKET_PAUSED while marks are delayed; fresh marks let the retry fill', async () => {
    t = await testEngine();
    seedCompany();
    const { token } = await signup();
    t.engine.tick(); // no HL mids yet: marks delayed
    expect(t.engine.status().marksDelayed).toBe(true);
    const order = () =>
      t.app.inject({
        method: 'POST',
        url: '/api/orders',
        headers: bearer(token),
        payload: { ticker: 'AAA', side: 'BUY', qty: 1 },
      });
    const paused = await order();
    expect(paused.statusCode).toBe(503);
    expect(paused.json()).toMatchObject({ error: 'MARKET_PAUSED', retryAfterMs: 2_000 });
    t.engine.state.setMarks({}, t.clock.now());
    t.engine.tick();
    expect((await order()).statusCode).toBe(200);
  });

  it('rate-limits /api/auth/nonce, /api/auth/link and /api/mirror/agent to 10 per minute per IP', async () => {
    t = await testEngine();
    const { token } = await signup();
    const hit = (method: 'GET' | 'POST', url: string) =>
      t.app.inject({
        method,
        url,
        headers: bearer(token),
        payload: method === 'POST' ? {} : undefined,
      });
    for (const [method, url] of [
      ['GET', '/api/auth/nonce'],
      ['POST', '/api/auth/link'],
      ['POST', '/api/mirror/agent'],
    ] as const) {
      for (let i = 0; i < 10; i++) expect((await hit(method, url)).statusCode).not.toBe(429);
      const limited = await hit(method, url);
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ error: 'RATE_LIMITED' });
    }
    t.clock.advance(60_000);
    expect((await hit('GET', '/api/auth/nonce')).statusCode).toBe(200);
  });

  it('TRUST_PROXY=0 (default): a spoofed X-Forwarded-For does not change the rate key', async () => {
    t = await testEngine();
    for (let i = 0; i < 20; i++) {
      const r = await t.app.inject({
        method: 'POST',
        url: '/api/players',
        headers: { 'x-forwarded-for': `10.0.0.${i}` },
      });
      expect(r.statusCode).toBe(201);
    }
    const spoofed = await t.app.inject({
      method: 'POST',
      url: '/api/players',
      headers: { 'x-forwarded-for': '10.9.9.9' },
    });
    expect(spoofed.statusCode).toBe(429);
  });

  it('TRUST_PROXY=1: the right-most X-Forwarded-For hop is the client', async () => {
    t = await testEngine({ env: { TRUST_PROXY: '1' } });
    for (let i = 0; i < 20; i++) {
      const r = await t.app.inject({
        method: 'POST',
        url: '/api/players',
        headers: { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7` },
      });
      expect(r.statusCode).toBe(201);
    }
    const sameClient = await t.app.inject({
      method: 'POST',
      url: '/api/players',
      headers: { 'x-forwarded-for': '10.9.9.9, 203.0.113.7' },
    });
    expect(sameClient.statusCode).toBe(429);
    const otherClient = await t.app.inject({
      method: 'POST',
      url: '/api/players',
      headers: { 'x-forwarded-for': '203.0.113.7, 198.51.100.4' },
    });
    expect(otherClient.statusCode).toBe(201);
  });

  it('rate-limits signups per IP and orders per player', async () => {
    t = await testEngine();
    seedCompany();
    for (let i = 0; i < 19; i++) await signup();
    const { token } = await signup();
    expect((await t.app.inject({ method: 'POST', url: '/api/players' })).statusCode).toBe(429);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await t.app.inject({
        method: 'POST',
        url: '/api/orders',
        headers: bearer(token),
        payload: { ticker: 'AAA', side: 'BUY', qty: 0.1 },
      });
      codes.push(r.statusCode);
    }
    expect(codes.filter((c) => c === 200)).toHaveLength(10);
    expect(codes.at(-1)).toBe(429);
  });
});
