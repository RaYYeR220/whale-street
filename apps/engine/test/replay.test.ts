import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { boot } from '../src/boot';
import { loadConfig } from '../src/config';
import { buildRuntime } from '../src/deps';
import { fetchPositions } from '../src/ingest/positions';
import { silentLogger } from '../src/log';
import { filterSessionLines } from '../src/replay/filter';
import { parseSession } from '../src/replay/load';
import { createSessionRecorder } from '../src/replay/record';
import { SYNTHETIC_A, SYNTHETIC_B, SYNTHETIC_T0, syntheticSession } from '../src/replay/synthetic';
import { FakeFeed, hlTrade } from './helpers/fake-hl';
import { NANSEN_BUILDER } from './helpers/fake-trading';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('session recorder', () => {
  it('writes Nansen/HL-info responses, feed records and seeds as NDJSON without headers', async () => {
    const dir = join(tmpdir(), `ws-rec-${randomUUID()}`);
    dirs.push(dir);
    let t = 1_000;
    const rec = createSessionRecorder(join(dir, 'sessions', 's.ndjson'), () => t);
    const inner = (async () =>
      new Response('{"data":[]}', { status: 200 })) as unknown as typeof fetch;
    const f = rec.wrapFetch(inner);
    await f('https://api.nansen.ai/api/v1/profiler/perp-positions', {
      method: 'POST',
      headers: { apikey: 'secret-key-123' },
      body: JSON.stringify({ address: SYNTHETIC_A }),
    });
    const feed = new FakeFeed();
    rec.attachFeed(feed, () => new Set(['BTC']));
    t = 2_000;
    feed.emitMids({ BTC: 1, DOGE: 2 }, t);
    feed.emitTrades([hlTrade('BTC', [SYNTHETIC_A, SYNTHETIC_B], t)]);
    rec.seed({
      address: SYNTHETIC_A,
      ticker: 'AAA',
      name: 'A Holdings',
      anchorDate: '2026-09-21',
      listedAt: 2_000,
    });

    const text = readFileSync(rec.path, 'utf8');
    expect(text).not.toContain('secret-key-123');
    const s = parseSession(text);
    expect(s.nansen).toHaveLength(1);
    expect(s.nansen[0]?.path).toBe('/api/v1/profiler/perp-positions');
    expect(s.hl.map((r) => r.channel)).toEqual(['mids', 'trades']);
    expect(s.hl[0]?.data).toEqual({ BTC: 1 });
    expect(s.seeds).toEqual([
      {
        address: SYNTHETIC_A,
        ticker: 'AAA',
        name: 'A Holdings',
        anchorDate: '2026-09-21',
        listedAt: 2_000,
      },
    ]);
    expect([s.startT, s.endT]).toEqual([1_000, 2_000]);
  });
});

describe('session loading and filtering', () => {
  it('parses the synthetic session: two seeds, a 10-minute window, known addresses', () => {
    const s = parseSession(syntheticSession().join('\n'));
    expect(s.seeds.map((x) => x.address)).toEqual([SYNTHETIC_A, SYNTHETIC_B]);
    expect(s.startT).toBe(SYNTHETIC_T0);
    expect(s.endT).toBe(SYNTHETIC_T0 + 600_000);
    expect(s.knownAddresses.has(SYNTHETIC_B)).toBe(true);
    expect(s.hl.filter((r) => r.channel === 'trades')).toHaveLength(3);
  });

  it('rejects malformed lines with a line number', () => {
    expect(() => parseSession('{"t":1,"k":"hl","channel":"mids","data":{}}\nnot json')).toThrow(
      'session line 2',
    );
    expect(() => parseSession('')).toThrow('session is empty');
  });

  it('keeps only redistribution-safe records and trims to a window', () => {
    const rec = (t: number, path: string) =>
      JSON.stringify({ t, k: 'nansen', key: `POST ${path} {}`, path, status: 200, body: {} });
    const lines = [
      rec(1, '/api/v1/profiler/perp-positions'),
      rec(2, '/api/v1/perp-leaderboard'),
      rec(3, '/api/v1/smart-money/perp-trades'),
      rec(4, '/api/v1/account'),
      rec(5, '/api/v1/perp/order'),
      rec(6, '/info'),
      JSON.stringify({ t: 7, k: 'hl', channel: 'mids', data: { BTC: 1 } }),
      JSON.stringify({
        t: 8,
        k: 'seed',
        company: { address: SYNTHETIC_A, ticker: 'A', name: 'A', anchorDate: 'x', listedAt: 8 },
      }),
      '',
    ];
    const kept = filterSessionLines(lines).map((l) => JSON.parse(l) as { t: number });
    expect(kept.map((r) => r.t)).toEqual([1, 6, 7, 8]);
    expect(
      filterSessionLines(lines, [5, 7]).map((l) => (JSON.parse(l) as { t: number }).t),
    ).toEqual([6, 7]);
  });

  it('scrubs Nansen label/name fields from bundled bodies, recursively, keeping everything else', () => {
    const path = '/api/v1/profiler/address/counterparties';
    const line = JSON.stringify({
      t: 1,
      k: 'nansen',
      key: `POST ${path} {}`,
      path,
      status: 200,
      body: {
        data: [
          {
            counterparty_address: SYNTHETIC_B,
            counterparty_address_label: 'Some Exchange: Hot Wallet',
            total_volume_usd: 5,
            nested: {
              first_funder_name: 'Somebody',
              token_symbol: 'BTC',
              deep: [{ address_label: 'Fund X', entity_name: 'Entity', keep: 1 }],
            },
          },
        ],
        label_count: 3,
      },
    });
    const [out] = filterSessionLines([line]);
    expect(JSON.parse(out ?? '')).toEqual({
      t: 1,
      k: 'nansen',
      key: `POST ${path} {}`,
      path,
      status: 200,
      body: {
        data: [
          {
            counterparty_address: SYNTHETIC_B,
            total_volume_usd: 5,
            nested: { token_symbol: 'BTC', deep: [{ keep: 1 }] },
          },
        ],
        label_count: 3,
      },
    });
    expect(out).not.toContain('Hot Wallet');
    // Seed lines keep their (engine-generated) company name.
    const seed = JSON.stringify({
      t: 2,
      k: 'seed',
      company: { address: SYNTHETIC_A, ticker: 'A', name: 'A Co', anchorDate: 'x', listedAt: 2 },
    });
    expect(filterSessionLines([seed])).toEqual([seed]);
  });
});

describe('LIVE recording privacy', () => {
  it('records company reads and seeds, never trading calls, the mirror wallet read or the key', async () => {
    const dir = join(tmpdir(), `ws-live-${randomUUID()}`);
    dirs.push(dir);
    const MASTER = '0x00000000000000000000000000000000000000c3';
    const AGENT = '0x00000000000000000000000000000000000000d4';
    const hlUsers: string[] = [];
    const paths: string[] = [];
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as { type?: string; user?: string })
          : {};
      paths.push(url.pathname);
      switch (url.pathname) {
        case '/info':
          if (body.type === 'clearinghouseState') {
            hlUsers.push(String(body.user));
            return json({ assetPositions: [], marginSummary: { accountValue: '500' }, time: 0 });
          }
          return json({ BTC: '60000' });
        case '/api/v1/profiler/perp-positions':
          return json({
            data: {
              assetPositions: [
                {
                  position: {
                    token_symbol: 'BTC',
                    size: '2',
                    entry_price_usd: '60000',
                    liquidation_price_usd: '45000',
                    leverage_value: 5,
                    margin_used_usd: '24000',
                    unrealized_pnl_usd: '0',
                  },
                },
              ],
              margin_summary_account_value_usd: '250000',
              time: 0,
            },
          });
        case '/api/v1/profiler/perp-pnl-summary':
          return json({
            data: {
              top5_coins: [],
              traded_times: 0,
              closed_trade_count: 0,
              realized_pnl_usd: 0,
              win_rate: 0,
              fees_usd: 0,
            },
          });
        case '/api/v1/perp/meta':
          return json({ assets: [{ asset_id: 0, name: 'BTC', sz_decimals: 5, max_leverage: 40 }] });
        case '/api/v1/perp/builder-fee':
          return json({
            approved: true,
            max_fee_rate: 80,
            required_fee: 80,
            builder_address: NANSEN_BUILDER,
          });
        default:
          return json({ message: 'not in this fake' }, 400);
      }
    }) as typeof fetch;

    const config = loadConfig(
      { MODE: 'live', NANSEN_API_KEY: 'secret-key-xyz', RECORD: '1', DATA_DIR: dir },
      () => {
        throw new Error('unused');
      },
    );
    const runtime = buildRuntime(config, {
      log: silentLogger,
      dbPath: ':memory:',
      fetch: fakeFetch,
    });
    const recorder = runtime.recorder;
    if (!recorder) throw new Error('RECORD=1 must create a recorder');
    expect(recorder.path.startsWith(join(dir, 'sessions'))).toBe(true);
    const { engine, app } = await boot(runtime);

    // A company listed through the real read path (recorded) → an IPO filing → a seed line.
    const positions = await fetchPositions(SYNTHETIC_A, {
      nansen: engine.nansen,
      info: engine.hl.info,
      creditSaver: false,
    });
    if (!positions.ok) throw new Error(positions.error);
    const rt = await engine.listing.list({
      address: SYNTHETIC_A,
      source: 'SCOUT',
      rating: null,
      prospectus: null,
      positions: positions.value,
    });
    expect((await engine.hl.info.clearinghouse(SYNTHETIC_B)).ok).toBe(true);

    // A mirror attempt: trading calls and the player's own wallet read must stay off the record.
    engine.state.setMarks({ BTC: 60_000 }, engine.clock.now());
    engine.state.flags.creditsRemaining = 10_000;
    const { player } = engine.players.create('human');
    engine.repos.players.setWallet(player.id, MASTER);
    expect(engine.mirror.registerAgent(player.id, MASTER, AGENT)).toEqual({ ok: true });
    await engine.mirror.prepare(player.id, {
      ticker: rt.ticker,
      coin: 'BTC',
      notionalUsd: 50,
      leverage: 3,
    });
    expect(paths).toContain('/api/v1/perp/meta');
    expect(hlUsers).toContain(MASTER);

    const text = readFileSync(recorder.path, 'utf8');
    const s = parseSession(text);
    expect(s.nansen.map((r) => r.path)).toEqual(
      expect.arrayContaining(['/api/v1/profiler/perp-positions', '/info']),
    );
    expect(s.nansen.some((r) => r.key.includes(SYNTHETIC_B))).toBe(true);
    expect(s.seeds.map((x) => x.address)).toEqual([SYNTHETIC_A]);
    expect(text).not.toContain('/api/v1/perp/');
    expect(text.toLowerCase()).not.toContain(MASTER);
    expect(text).not.toContain('wallet_address');
    expect(text).not.toContain('secret-key-xyz');
    // Trading still reports into the shared provenance log.
    expect(engine.repos.nansenCalls.recent(50).map((c) => c.path)).toContain('/api/v1/perp/meta');

    await app.close();
    await engine.stop();
    runtime.deps.db.close();
  });
});
