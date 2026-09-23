import { afterEach, describe, expect, it } from 'vitest';
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
