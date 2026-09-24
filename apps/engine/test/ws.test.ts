import { afterEach, describe, expect, it, vi } from 'vitest';
import { bearer, type TestEngine, testEngine } from './helpers/engine';
import { addCompany } from './helpers/world';
import { inbox, send } from './helpers/ws';

const A = '0x00000000000000000000000000000000000000a1' as const;
let t: TestEngine;

afterEach(async () => {
  await t.app.close();
});

async function connect() {
  const ws = await t.app.injectWS('/ws');
  return { ws, box: inbox(ws) };
}

describe('WS gateway', () => {
  it('hello authenticates, sub market streams a frame now and on every tick', async () => {
    t = await testEngine();
    addCompany(t.engine, { id: A, ticker: 'AAA' });
    const signup = (await t.app.inject({ method: 'POST', url: '/api/players' })).json();
    const { ws, box } = await connect();
    send(ws, { op: 'hello', token: signup.token });
    const hello = await box.waitFor((m) => m.t === 'hello');
    expect(hello.player).toMatchObject({ id: signup.player.id });
    await box.waitFor((m) => m.t === 'status');
    send(ws, { op: 'sub', channels: ['market'] });
    const first = await box.waitFor((m) => m.t === 'market');
    expect(first).toMatchObject({
      mode: 'replay',
      companies: [{ ticker: 'AAA', nav: 100, price: 100, mult: 1, status: 'ACTIVE' }],
    });
    box.clear();
    t.clock.advance(1_000);
    t.engine.state.setMarks({}, t.clock.now());
    t.engine.tick();
    const next = await box.waitFor((m) => m.t === 'market');
    expect(next.at).toBe(t.clock.now());
    ws.terminate();
  });

  it('pushes filings, tape and the caller’s own portfolio', async () => {
    t = await testEngine();
    const rt = addCompany(t.engine, { id: A, ticker: 'AAA' });
    t.clock.advance(61_000);
    const signup = (await t.app.inject({ method: 'POST', url: '/api/players' })).json();
    const { ws, box } = await connect();
    send(ws, { op: 'hello', token: signup.token });
    await box.waitFor((m) => m.t === 'hello');
    send(ws, { op: 'sub', channels: ['filings', 'tape', 'player'] });
    await box.waitFor((m) => m.t === 'player');
    box.clear();

    await t.app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: bearer(signup.token),
      payload: { ticker: 'AAA', side: 'BUY', qty: 3 },
    });
    const tape = await box.waitFor((m) => m.t === 'tape');
    expect(tape.trade).toMatchObject({
      ticker: 'AAA',
      side: 'BUY',
      qty: 3,
      handle: signup.player.handle,
      kind: 'human',
    });
    const mine = await box.waitFor((m) => m.t === 'player');
    expect(mine.portfolio).toMatchObject({
      playerId: signup.player.id,
      holdings: [{ ticker: 'AAA', longQty: 3 }],
    });

    t.engine.statusOps.halt(rt, 'data', 'test', t.clock.now());
    const filing = await box.waitFor((m) => m.t === 'filing');
    expect(filing.filing).toMatchObject({ kind: 'HALT', ticker: 'AAA', detail: 'test' });
    ws.terminate();
  });

  it('closes a connection that sends more than 20 messages per second (1008)', async () => {
    t = await testEngine();
    const { ws, box } = await connect();
    /** n messages in one burst; the last (hello) is answered once the server processed them all. */
    const burst = async (n: number) => {
      for (let i = 0; i < n - 1; i++) send(ws, { op: 'unsub', channels: ['market'] });
      send(ws, { op: 'hello' });
      await box.waitFor((m) => m.t === 'hello');
      box.clear();
    };
    await burst(20);
    t.clock.advance(1_000);
    await burst(20); // a new second: a fresh budget
    expect(ws.readyState).toBe(1);
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    for (let i = 0; i < 21; i++) send(ws, { op: 'unsub', channels: ['market'] });
    expect(await closed).toBe(1008);
  });

  it('accepts 30 connections per IP (a room on one Wi-Fi); the 31st is closed with 1008', async () => {
    t = await testEngine();
    const sockets = [];
    for (let i = 0; i < 30; i++) sockets.push((await connect()).ws);
    expect(t.engine.status().viewers).toBe(30);
    const extra = await t.app.injectWS('/ws');
    const code = await new Promise<number>((resolve) => extra.on('close', (c) => resolve(c)));
    expect(code).toBe(1008);
    expect(t.engine.status().viewers).toBe(30);
    sockets[0]?.terminate();
    for (let i = 0; i < 100 && t.engine.status().viewers > 29; i++)
      await new Promise((r) => setTimeout(r, 10));
    const again = await connect();
    expect(t.engine.status().viewers).toBe(30);
    for (const s of [...sockets, again.ws]) s.terminate();
  });

  it('computes the leaderboard frame at most once per second, shared across subscribers', async () => {
    t = await testEngine();
    const spy = vi.spyOn(t.engine.exchange, 'leaderboard');
    const a = await connect();
    const b = await connect();
    send(a.ws, { op: 'sub', channels: ['leaderboard'] });
    send(b.ws, { op: 'sub', channels: ['leaderboard'] });
    await a.box.waitFor((m) => m.t === 'leaderboard');
    await b.box.waitFor((m) => m.t === 'leaderboard');
    send(a.ws, { op: 'unsub', channels: ['leaderboard'] });
    send(a.ws, { op: 'sub', channels: ['leaderboard'] });
    await new Promise((r) => setTimeout(r, 50));
    expect(a.box.msgs.filter((m) => m.t === 'leaderboard')).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(1);
    t.clock.advance(1_000);
    send(b.ws, { op: 'unsub', channels: ['leaderboard'] });
    send(b.ws, { op: 'sub', channels: ['leaderboard'] });
    await new Promise((r) => setTimeout(r, 50));
    expect(spy).toHaveBeenCalledTimes(2);
    a.ws.terminate();
    b.ws.terminate();
  });

  it('counts viewers for idle gating and answers bad messages with an error frame', async () => {
    t = await testEngine();
    const { ws, box } = await connect();
    expect(t.engine.status().viewers).toBe(1);
    ws.send('not json');
    expect(await box.waitFor((m) => m.t === 'error')).toMatchObject({ error: 'BAD_MESSAGE' });
    send(ws, { op: 'sub', channels: ['nope'] });
    await box.waitFor((m) => m.t === 'error' && String(m.message).includes('op'));
    send(ws, { op: 'sub', channels: ['leaderboard', 'status'] });
    expect(await box.waitFor((m) => m.t === 'leaderboard')).toMatchObject({ rows: [] });
    ws.terminate();
    for (let i = 0; i < 100 && t.engine.status().viewers > 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(t.engine.status().viewers).toBe(0);
  });
});
