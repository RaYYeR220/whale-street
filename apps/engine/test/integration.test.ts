import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { boot } from '../src/boot';
import { loadConfig } from '../src/config';
import { buildRuntime } from '../src/deps';
import { silentLogger } from '../src/log';
import { SYNTHETIC_A, SYNTHETIC_B, syntheticSession } from '../src/replay/synthetic';
import { bearer } from './helpers/engine';
import { inbox, send } from './helpers/ws';

const dir = join(tmpdir(), `ws-int-${randomUUID()}`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('REPLAY mini-session end to end', () => {
  it('seeds companies, ticks NAV, files CLOSE/OPEN/LIQUIDATION/BANKRUPTCY, trades, streams, and loops', async () => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'session.ndjson');
    writeFileSync(file, `${syntheticSession().join('\n')}\n`);
    const config = loadConfig({ MODE: 'replay', REPLAY_FILE: file, DATA_DIR: dir }, () => {
      throw new Error('unused');
    });
    let wall = 5_000_000;
    const runtime = buildRuntime(config, {
      log: silentLogger,
      dbPath: ':memory:',
      wallNow: () => wall,
    });
    const { engine, app } = await boot(runtime);
    await app.ready();

    expect(engine.status()).toMatchObject({ mode: 'replay', synthetic: false, companies: 2 });
    const a = engine.state.get(SYNTHETIC_A);
    const b = engine.state.get(SYNTHETIC_B);
    if (!a || !b) throw new Error('seed companies missing');
    expect(a.source).toBe('SEEDED');

    const ws = await app.injectWS('/ws');
    const box = inbox(ws);
    send(ws, { op: 'sub', channels: ['market', 'filings'] });
    await box.waitFor((m) => m.t === 'market');

    const player = (await app.inject({ method: 'POST', url: '/api/players' })).json();
    let navBeforeClose = 0;
    for (let s = 1; s < 600; s++) {
      wall += 1_000;
      engine.tick();
      await engine.settle();
      if (s === 120) {
        const buy = await app.inject({
          method: 'POST',
          url: '/api/orders',
          headers: bearer(player.token),
          payload: { ticker: a.ticker, side: 'BUY', qty: 20 },
        });
        expect(buy.statusCode).toBe(200);
      }
      if (s === 240) {
        const sell = await app.inject({
          method: 'POST',
          url: '/api/orders',
          headers: bearer(player.token),
          payload: { ticker: a.ticker, side: 'SELL', qty: 20 },
        });
        expect(sell.statusCode).toBe(200);
      }
      if (s === 290) navBeforeClose = a.nav.nav;
    }

    expect(navBeforeClose).toBeGreaterThan(100);
    const kinds = engine.repos.filings
      .recent(200)
      .map((f) => `${f.companyId === SYNTHETIC_A ? 'A' : 'B'}:${f.kind}`)
      .reverse();
    expect(kinds).toEqual(
      expect.arrayContaining([
        'A:IPO',
        'B:IPO',
        'A:CLOSE',
        'A:OPEN',
        'B:MARGIN_CALL',
        'B:LIQUIDATION',
        'B:BANKRUPTCY',
        'B:DELISTING',
      ]),
    );
    expect(kinds.indexOf('A:CLOSE')).toBeLessThan(kinds.indexOf('A:OPEN'));
    expect(a.nav.snapshot.realizedSinceAnchor).toBeCloseTo(1_000, 6);
    expect(b.status).toBe('DELISTED');

    const trades = engine.repos.trades.recent(100);
    expect(trades.some((t) => t.playerId === 'bot-vulture' && t.side === 'SHORT')).toBe(true);
    expect(trades.some((t) => t.playerId === 'bot-vulture' && t.side === 'SETTLE')).toBe(true);
    expect(trades.filter((t) => t.playerId === player.player.id).map((t) => t.side)).toEqual([
      'SELL',
      'BUY',
    ]);
    await box.waitFor((m) => m.t === 'market' && m.at === engine.clock.now());
    expect(box.msgs.some((m) => m.t === 'filing')).toBe(true);

    wall += 1_000;
    engine.tick();
    await engine.settle();
    expect(b.status).toBe('ACTIVE');
    expect(b.nav.nav).toBe(100);
    expect(engine.repos.filings.recent(1, SYNTHETIC_B)[0]).toMatchObject({
      kind: 'RESUME',
      detail: 'replay restarted',
    });

    ws.terminate();
    await app.close();
    await engine.stop();
  }, 60_000);
});
