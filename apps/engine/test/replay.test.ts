import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestKey } from '@whale-street/nansen';
import { afterEach, describe, expect, it } from 'vitest';
import { boot } from '../src/boot';
import { BOTS } from '../src/bots/runner';
import { loadConfig } from '../src/config';
import { DAY_MS, utcDate } from '../src/dates';
import {
  buildRuntime,
  NANSEN_DATA_BUDGET,
  NANSEN_KEY_LIMITS,
  NANSEN_TRADING_BUDGET,
} from '../src/deps';
import type { MoodSkew } from '../src/ingest/mood';
import { fetchPositions } from '../src/ingest/positions';
import { silentLogger } from '../src/log';
import { filterSessionLines } from '../src/replay/filter';
import { loadReplaySession, parseSession } from '../src/replay/load';
import { createSessionRecorder } from '../src/replay/record';
import { REPLAY_ALLOWED_PATHS, redistributable, type SessionLine } from '../src/replay/session';
import { SYNTHETIC_A, SYNTHETIC_B, SYNTHETIC_T0, syntheticSession } from '../src/replay/synthetic';
import { FakeFeed, hlTrade } from './helpers/fake-hl';
import { NANSEN_BUILDER } from './helpers/fake-trading';
import { inbox, send } from './helpers/ws';

/** Street mood as derived from smart 3 vs 1 and whale 20 vs 10 (USD totals). */
const MOOD = { smartSkew: 0.5, whaleSkew: 1 / 3 };

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
    rec.attachFeed(
      feed,
      () => new Set(['BTC']),
      () => new Set([SYNTHETIC_A]),
    );
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
    // A served reading carries its asOf; the line keeps only the skews (t is the recording time).
    const reading = { ...MOOD, asOf: 1_500 };
    rec.mood('BTC', reading);

    const text = readFileSync(rec.path, 'utf8');
    expect(text).not.toContain('secret-key-123');
    const s = parseSession(text);
    expect(s.moods).toEqual([{ t: 2_000, k: 'mood', coin: 'BTC', ...MOOD }]);
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

  it('records only HL trades involving a known address (listed companies, pending applicants)', () => {
    const dir = join(tmpdir(), `ws-rec-${randomUUID()}`);
    dirs.push(dir);
    const rec = createSessionRecorder(join(dir, 's.ndjson'), () => 5_000);
    const feed = new FakeFeed();
    const known = new Set([SYNTHETIC_A]);
    rec.attachFeed(
      feed,
      () => new Set(['BTC']),
      () => known,
    );
    const STRANGER = '0x00000000000000000000000000000000000000e5';
    // An unrelated trade on a held coin: not written.
    feed.emitTrades([hlTrade('BTC', [STRANGER, COUNTERPARTY], 1)]);
    // A mixed batch keeps only the known address's trade (matched case-insensitively).
    feed.emitTrades([
      hlTrade('BTC', [STRANGER, COUNTERPARTY], 2),
      hlTrade('BTC', [COUNTERPARTY, SYNTHETIC_A.toUpperCase().replace('0X', '0x')], 3),
    ]);
    // An applicant that became known later is recorded from then on.
    known.add(SYNTHETIC_B);
    feed.emitTrades([hlTrade('BTC', [SYNTHETIC_B, COUNTERPARTY], 4)]);
    feed.emitMids({ BTC: 1 }, 5_000);

    const s = parseSession(readFileSync(rec.path, 'utf8'));
    const trades = s.hl.flatMap((r) => (r.channel === 'trades' ? r.data : []));
    expect(trades.map((t) => t.time)).toEqual([3, 4]);
    expect(s.hl.filter((r) => r.channel === 'mids')).toHaveLength(1);
  });

  it('never writes non-redistributable bodies: leaderboard, smart money, cohort data, labels', async () => {
    const dir = join(tmpdir(), `ws-rec-${randomUUID()}`);
    dirs.push(dir);
    const rec = createSessionRecorder(join(dir, 's.ndjson'), () => 7_000);
    const bodies: Record<string, unknown> = {
      '/api/v1/perp-leaderboard': { data: [{ trader_address: SYNTHETIC_A, total_pnl: 1 }] },
      '/api/v1/smart-money/perp-trades': { data: [{ trader_address: SYNTHETIC_A }] },
      '/api/v1/tgm/position-intelligence': { data: [{ smart_trader_longs_usd: 5 }] },
      '/api/v1/profiler/address/first-funder': {
        data: [{ first_funder_address: SYNTHETIC_B, first_funder_name: 'Secret Fund' }],
      },
      '/api/v1/profiler/perp-positions': { data: { assetPositions: [] } },
    };
    const f = rec.wrapFetch((async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      return new Response(JSON.stringify(bodies[path]), { status: 200 });
    }) as typeof fetch);
    for (const path of Object.keys(bodies))
      await f(`https://api.nansen.ai${path}`, { method: 'POST', body: '{}' });

    const text = readFileSync(rec.path, 'utf8');
    expect(text).not.toContain('trader_address');
    expect(text).not.toContain('smart_trader_longs_usd');
    expect(text).not.toContain('Secret Fund');
    expect(parseSession(text).nansen.map((r) => r.path)).toEqual([
      '/api/v1/profiler/address/first-funder',
      '/api/v1/profiler/perp-positions',
    ]);
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
    // Street mood for every held coin from the first second (derived cohort positioning only).
    expect(
      s.moods
        .filter((m) => m.t === SYNTHETIC_T0)
        .map((m) => m.coin)
        .sort(),
    ).toEqual(['BTC', 'ETH', 'SOL']);
    expect(Object.keys(s.moods[0] ?? {}).sort()).toEqual([
      'coin',
      'k',
      'smartSkew',
      't',
      'whaleSkew',
    ]);
    for (const m of s.moods)
      for (const v of [m.smartSkew, m.whaleSkew]) expect(v === null || Math.abs(v) <= 1).toBe(true);
  });

  it('rejects malformed street-mood lines with a line number', () => {
    const mood = (skews: Record<string, unknown>, coin: unknown = 'BTC') =>
      JSON.stringify({ t: 1, k: 'mood', coin, ...skews });
    expect(parseSession(mood(MOOD)).moods).toHaveLength(1);
    expect(parseSession(mood({ smartSkew: null, whaleSkew: -1 })).moods).toHaveLength(1);
    expect(() => parseSession(mood({ ...MOOD, smartSkew: 'lots' }))).toThrow('session line 1');
    expect(() => parseSession(mood({ ...MOOD, smartSkew: 1.5 }))).toThrow('session line 1');
    expect(() => parseSession(mood({ smartSkew: 0.1 }))).toThrow('session line 1');
    expect(() => parseSession(mood(MOOD, ''))).toThrow('session line 1');
  });

  it('rebuilds street-mood lines to exactly the derived keys (record, bundle, load); unknown is null', () => {
    const derived = { t: 1, k: 'mood', coin: 'BTC', smartSkew: 0.5, whaleSkew: null };
    // Extra keys (raw totals, a nested label) never pass; a null skew stays null, never 0.
    const extra = { ...derived, smartLongs: 48e6, positioning: { address_label: 'Fund X' } };
    const asLine = (r: unknown) => r as SessionLine;
    expect(redistributable(asLine(extra))).toEqual(derived);
    // A skew missing from a line handed to the policy directly is unknown: null, not dropped.
    const { whaleSkew: _dropped, ...missing } = derived;
    expect(redistributable(asLine(missing))).toEqual(derived);
    // Bundle: plain and trimmed (the carried opening mood too).
    const parse = (lines: string[]) => lines.map((l) => JSON.parse(l) as unknown);
    expect(parse(filterSessionLines([JSON.stringify(extra)]))).toEqual([derived]);
    const mids = JSON.stringify({ t: 5, k: 'hl', channel: 'mids', data: { BTC: 1 } });
    expect(parse(filterSessionLines([JSON.stringify(extra), mids], [3, 10]))[0]).toEqual({
      ...derived,
      t: 3,
    });
    // Load: what the engine will serve.
    expect(loadReplaySession(JSON.stringify(extra)).moods).toEqual([derived]);
    // A file line without a skew key still fails loudly at load (its line is named).
    expect(() => loadReplaySession(JSON.stringify(missing))).toThrow('session line 1');
    // Record: a served reading (with asOf and anything else) is written as the derived line.
    const dir = join(tmpdir(), `ws-rec-${randomUUID()}`);
    dirs.push(dir);
    const rec = createSessionRecorder(join(dir, 's.ndjson'), () => 1);
    rec.mood('BTC', { smartSkew: 0.5, whaleSkew: null, asOf: 0, smartLongs: 48e6 } as MoodSkew);
    expect(parse(readFileSync(rec.path, 'utf8').trim().split('\n'))).toEqual([derived]);
  });

  it('carries the latest street mood per coin into a trimmed window', () => {
    const mood = (t: number, coin: string, smartSkew: number) =>
      JSON.stringify({ t, k: 'mood', coin, smartSkew, whaleSkew: null });
    const lines = [
      mood(1, 'BTC', 0.1),
      mood(10, 'BTC', 0.2),
      mood(10, 'ETH', 0.5),
      JSON.stringify({ t: 50, k: 'hl', channel: 'mids', data: { BTC: 1 } }),
      mood(55, 'BTC', 0.3),
      mood(90, 'BTC', 0.4),
    ];
    const out = filterSessionLines(lines, [40, 60]).map(
      (l) => JSON.parse(l) as { t: number; k: string; coin?: string; smartSkew?: number },
    );
    expect(out.map((r) => [r.k, r.t, r.coin ?? null, r.smartSkew ?? null])).toEqual([
      ['mood', 40, 'BTC', 0.2],
      ['mood', 40, 'ETH', 0.5],
      ['hl', 50, null, null],
      ['mood', 55, 'BTC', 0.3],
    ]);
  });

  it('rejects malformed lines with a line number', () => {
    expect(() => parseSession('{"t":1,"k":"hl","channel":"mids","data":{}}\nnot json')).toThrow(
      'session line 2',
    );
    expect(() => parseSession('')).toThrow('session is empty');
  });

  it('checks every record for the fields its kind needs, naming the line', () => {
    const company = {
      address: SYNTHETIC_A,
      ticker: 'A',
      name: 'A Co',
      anchorDate: '2026-09-21',
      listedAt: 2,
    };
    const trade = { coin: 'BTC', side: 'B', px: 1, sz: 1, time: 2, hash: '0x2', users: ['a', 'b'] };
    const nansen = {
      t: 2,
      k: 'nansen',
      key: 'POST /info {}',
      path: '/info',
      status: 200,
      body: {},
    };
    const at = (bad: unknown) =>
      [
        JSON.stringify({ t: 1, k: 'hl', channel: 'mids', data: { BTC: 1 } }),
        JSON.stringify(bad),
      ].join('\n');
    // Well-formed records of every kind load.
    const good = [
      { t: 2, k: 'seed', company },
      nansen,
      { ...nansen, body: null },
      { t: 2, k: 'hl', channel: 'trades', data: [trade] },
    ];
    for (const r of good) expect(() => parseSession(at(r)), JSON.stringify(r)).not.toThrow();
    const bad = [
      { t: 2, k: 'seed' },
      { t: 2, k: 'seed', company: 'A' },
      { t: 2, k: 'seed', company: { ...company, address: 'not-an-address' } },
      { t: 2, k: 'seed', company: { ...company, ticker: '' } },
      { t: 2, k: 'seed', company: { ...company, name: 7 } },
      { t: 2, k: 'seed', company: { ...company, anchorDate: '' } },
      { t: 2, k: 'seed', company: { ...company, listedAt: 'soon' } },
      { ...nansen, key: undefined },
      { ...nansen, key: '' },
      { ...nansen, path: 42 },
      { ...nansen, status: '200' },
      { ...nansen, body: undefined },
      { t: 2, k: 'hl', channel: 'book', data: [] },
      { t: 2, k: 'hl', channel: 'mids', data: [1] },
      { t: 2, k: 'hl', channel: 'mids', data: { BTC: 'high' } },
      { t: 2, k: 'hl', channel: 'trades', data: {} },
      { t: 2, k: 'hl', channel: 'trades', data: [{ ...trade, users: undefined }] },
      { t: 2, k: 'hl', channel: 'trades', data: [{ ...trade, px: 'x' }] },
      { t: 2, k: 'hl', channel: 'trades', data: [{ ...trade, coin: null }] },
    ];
    for (const r of bad)
      expect(() => parseSession(at(r)), JSON.stringify(r)).toThrow(/^session line 2: /);
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
    // Seed lines survive any window (re-timed into it) so a trimmed bundle keeps its companies.
    const trimmed = filterSessionLines(lines, [5, 7]).map(
      (l) => JSON.parse(l) as { t: number; k: string },
    );
    expect(trimmed.map((r) => `${r.k}@${r.t}`)).toEqual(['nansen@6', 'hl@7', 'seed@7']);
  });

  it('keeps seed lines regardless of the window, clamped to its bounds', () => {
    const seed = (t: number, address: string) =>
      JSON.stringify({
        t,
        k: 'seed',
        company: { address, ticker: 'A', name: 'A Co', anchorDate: 'x', listedAt: t },
      });
    const lines = [
      seed(1, SYNTHETIC_A),
      JSON.stringify({ t: 50, k: 'hl', channel: 'mids', data: { BTC: 1 } }),
      seed(90, SYNTHETIC_B),
    ];
    const out = filterSessionLines(lines, [40, 60]).map(
      (l) => JSON.parse(l) as { t: number; k: string; company?: { address: string } },
    );
    expect(out.map((r) => [r.k, r.t, r.company?.address ?? null])).toEqual([
      ['seed', 40, SYNTHETIC_A],
      ['hl', 50, null],
      ['seed', 60, SYNTHETIC_B],
    ]);
    const s = parseSession(out.map((r) => JSON.stringify(r)).join('\n'));
    expect([s.startT, s.endT]).toEqual([40, 60]);
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
        case '/api/v1/tgm/position-intelligence':
          return json({
            data: [
              {
                smart_trader_longs_usd: 3,
                smart_trader_shorts_usd: 1,
                whale_longs_usd: 20,
                whale_shorts_usd: 10,
                public_figure_longs_usd: 0,
                public_figure_shorts_usd: 2,
              },
            ],
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
    // A test-driven HL feed in place of the real websocket.
    const feed = new FakeFeed();
    runtime.deps.hl = { ...runtime.deps.hl, feed };
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
    // The HL tape: trades of the listed company and of a pending IPO applicant are kept.
    const STRANGER = '0x00000000000000000000000000000000000000e5';
    const APPLICANT = '0x00000000000000000000000000000000000000d7';
    expect(engine.ipo.apply(engine.players.create('human').player.id, APPLICANT).ok).toBe(true);
    feed.emitTrades([
      hlTrade('BTC', [STRANGER, COUNTERPARTY], 11),
      hlTrade('BTC', [SYNTHETIC_A, COUNTERPARTY], 12),
      hlTrade('BTC', [COUNTERPARTY, APPLICANT], 13),
    ]);
    await engine.ipo.drained();
    feed.emitTrades([hlTrade('BTC', [APPLICANT, COUNTERPARTY], 14)]);
    // The first tick runs the street-mood job: its derived cohort positioning is recorded.
    engine.tick();
    await engine.settle();
    expect(engine.state.mood.get('BTC')).toEqual({ ...MOOD, asOf: expect.any(Number) });

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
    expect(s.moods.map((m) => [m.coin, m.smartSkew, m.whaleSkew])).toEqual([
      ['BTC', MOOD.smartSkew, MOOD.whaleSkew],
    ]);
    // Once decided (not listed), the applicant's trades are no longer recorded.
    const tape = s.hl.flatMap((r) => (r.channel === 'trades' ? r.data : []));
    expect(tape.map((t) => t.time)).toEqual([12, 13]);
    // The raw cohort body and totals (and the scout's / credit check's calls) never reach the disk.
    expect(text).not.toContain('smart_trader_longs_usd');
    expect(text).not.toContain('smartLongs');
    expect(s.nansen.filter((r) => !REPLAY_ALLOWED_PATHS.has(r.path))).toEqual([]);
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

const COUNTERPARTY = '0x00000000000000000000000000000000000000ff';

/**
 * Boots the real REPLAY runtime from session lines, with a test-controlled wall clock. With
 * `dir`, the session file and the SQLite database live in that DATA_DIR (as in production);
 * otherwise the database is in memory.
 */
async function bootReplay(lines: readonly string[], o: { dir?: string } = {}) {
  const dir = o.dir ?? join(tmpdir(), `ws-replay-${randomUUID()}`);
  if (!o.dir) dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session.ndjson');
  writeFileSync(file, `${lines.join('\n')}\n`);
  const config = loadConfig({ MODE: 'replay', REPLAY_FILE: file, DATA_DIR: dir }, () => {
    throw new Error('unused');
  });
  const wall = { t: 5_000_000 };
  const runtime = buildRuntime(config, {
    log: silentLogger,
    ...(o.dir ? {} : { dbPath: ':memory:' }),
    wallNow: () => wall.t,
  });
  const { engine, app } = await boot(runtime);
  await app.ready();
  const step = async (ms = 1_000) => {
    wall.t += ms;
    engine.tick();
    await engine.settle();
  };
  const close = async () => {
    await app.close();
    await engine.stop();
    runtime.deps.db.close();
  };
  return { engine, app, runtime, wall, step, close };
}

describe('REPLAY loader', () => {
  it('serves only allowlisted, label-scrubbed records even from a raw session file', async () => {
    const nansenLine = (path: string, requestBody: unknown, body: unknown) =>
      JSON.stringify({
        t: SYNTHETIC_T0 + 1_000,
        k: 'nansen',
        key: requestKey('POST', `https://api.nansen.ai${path}`, JSON.stringify(requestBody)),
        path,
        status: 200,
        body,
      });
    const leaderboard = nansenLine(
      '/api/v1/perp-leaderboard',
      {
        date: { from: 'x', to: 'y' },
        pagination: { page: 1, per_page: 100 },
        order_by: [{ field: 'total_pnl', direction: 'DESC' }],
      },
      {
        data: [
          { trader_address: SYNTHETIC_A, total_pnl: 1, roi: 1, account_value: 1, total_trades: 1 },
        ],
      },
    );
    const funder = nansenLine(
      '/api/v1/profiler/address/first-funder',
      { address: SYNTHETIC_A, chain: 'all' },
      { data: [{ first_funder_address: SYNTHETIC_B, first_funder_name: 'Secret Fund' }] },
    );
    const raw = [...syntheticSession(), leaderboard, funder];
    const loaded = loadReplaySession(raw.join('\n'));
    expect(loaded.dropped).toBe(1);
    expect(loaded.nansen.map((x) => x.path)).not.toContain('/api/v1/perp-leaderboard');
    expect(JSON.stringify(loaded.nansen)).not.toContain('Secret Fund');
    expect(parseSession(raw.join('\n')).dropped).toBe(0);

    const r = await bootReplay(raw);
    const lb = await r.runtime.deps.nansen.perpLeaderboard('2026-01-01', '2026-01-02');
    expect(lb).toMatchObject({ ok: false, status: 503 });
    const ff = await r.runtime.deps.nansen.firstFunder(SYNTHETIC_A);
    expect(ff).toMatchObject({ ok: true, value: { funder: SYNTHETIC_B, funderName: null } });
    await r.close();
  });
});

describe('REPLAY street mood', () => {
  it('replays the recorded cohort positioning into the market frame, loop after loop', async () => {
    const r = await bootReplay(syntheticSession());
    const { engine, app } = r;
    engine.idle.clientConnected(engine.clock.now());
    await r.step();
    const opening = new Map(engine.state.mood);
    expect([...opening.keys()].sort()).toEqual(['BTC', 'ETH', 'SOL']);
    const ws = await app.injectWS('/ws');
    const box = inbox(ws);
    send(ws, { op: 'sub', channels: ['market'] });
    const frame = await box.waitFor((m) => m.t === 'market');
    const entries = frame.mood as Array<Record<string, unknown>>;
    expect(entries.map((m) => m.coin).sort()).toEqual(['BTC', 'ETH', 'SOL']);
    // Derived skews with their recording time only: no raw cohort totals are served.
    for (const m of entries)
      expect(Object.keys(m).sort()).toEqual(['asOf', 'coin', 'smartSkew', 'whaleSkew']);
    expect(entries.every((m) => m.asOf === SYNTHETIC_T0)).toBe(true);

    // Mid-recording update, then back to the opening positioning after the wrap.
    for (let s = 0; s < 400; s++) await r.step();
    expect(engine.state.mood.get('ETH')).not.toEqual(opening.get('ETH'));
    for (let s = 0; s < 201; s++) await r.step();
    expect(engine.clock.now() - SYNTHETIC_T0).toBeLessThan(5_000);
    expect(new Map(engine.state.mood)).toEqual(opening);
    ws.terminate();
    await r.close();
  }, 30_000);
});

describe('REPLAY database', () => {
  it('is per session: another bundle starts a fresh world, the same bundle keeps its players', async () => {
    const dir = join(tmpdir(), `ws-replay-db-${randomUUID()}`);
    dirs.push(dir);
    const OTHER = '0x00000000000000000000000000000000000000c7';
    const first = syntheticSession();
    // Same shape, but company A is somebody else: a different bundle.
    const second = first.map((l) => l.replaceAll(SYNTHETIC_A.slice(2), OTHER.slice(2)));
    const ids = (r: { engine: { state: { list(): Array<{ id: string }> } } }) =>
      r.engine.state
        .list()
        .map((c) => c.id)
        .sort();

    const r1 = await bootReplay(first, { dir });
    expect(ids(r1)).toEqual([SYNTHETIC_A, SYNTHETIC_B]);
    const { player } = r1.engine.players.create('human');
    await r1.close();

    const r2 = await bootReplay(second, { dir });
    expect(ids(r2)).toEqual([SYNTHETIC_B, OTHER]);
    expect(r2.engine.status().companies).toBe(2);
    expect(r2.engine.players.get(player.id)).toBeNull();
    await r2.close();

    const r3 = await bootReplay(first, { dir });
    expect(ids(r3)).toEqual([SYNTHETIC_A, SYNTHETIC_B]);
    expect(r3.engine.players.get(player.id)?.handle).toBe(player.handle);
    await r3.close();

    const dbs = readdirSync(dir).filter((f) => /^whale-street-replay-[0-9a-f]{8}\.db$/.test(f));
    expect(dbs).toHaveLength(2);
  });
});

describe('REPLAY listing anchor', () => {
  it('lists a seed on its recorded anchor date, not the replay clock day', async () => {
    const clockDay = utcDate(SYNTHETIC_T0);
    const seedDay = utcDate(SYNTHETIC_T0 - DAY_MS);
    // A recording made the day after company A was listed: its seed keeps the listing day.
    const lines = syntheticSession().map((l) => {
      const r = JSON.parse(l) as { k: string; company?: { address: string; anchorDate: string } };
      if (r.k !== 'seed' || r.company?.address !== SYNTHETIC_A) return l;
      return JSON.stringify({ ...r, company: { ...r.company, anchorDate: seedDay } });
    });
    const r = await bootReplay(lines);
    const a = r.engine.state.get(SYNTHETIC_A);
    expect(clockDay).not.toBe(seedDay);
    expect(a?.anchorDate).toBe(seedDay);
    // The recorded pnl-summary answered the listing's request.
    expect(a?.summaryBaseline).not.toBeNull();
    const summaries = r.engine.repos.nansenCalls
      .recent(100)
      .filter((c) => c.path === '/api/v1/profiler/perp-pnl-summary');
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.every((c) => c.status === 200)).toBe(true);
    await r.close();
  });
});

describe('LIVE Nansen budget', () => {
  it('splits the key budget between the data and trading clients', async () => {
    expect(NANSEN_TRADING_BUDGET).toEqual({ perSecond: 2, perMinute: 20 });
    expect(NANSEN_DATA_BUDGET).toEqual({ perSecond: 13, perMinute: 280 });
    expect(NANSEN_DATA_BUDGET.perSecond + NANSEN_TRADING_BUDGET.perSecond).toBeLessThanOrEqual(
      NANSEN_KEY_LIMITS.perSecond,
    );
    expect(NANSEN_DATA_BUDGET.perMinute + NANSEN_TRADING_BUDGET.perMinute).toBeLessThanOrEqual(
      NANSEN_KEY_LIMITS.perMinute,
    );
    const dir = join(tmpdir(), `ws-budget-${randomUUID()}`);
    dirs.push(dir);
    const fakeFetch = (async () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const config = loadConfig({ MODE: 'live', NANSEN_API_KEY: 'k', DATA_DIR: dir }, () => {
      throw new Error('unused');
    });
    const runtime = buildRuntime(config, {
      log: silentLogger,
      dbPath: ':memory:',
      fetch: fakeFetch,
    });
    const trading = runtime.deps.trading;
    if (!trading) throw new Error('LIVE must have a trading port');
    const t0 = Date.now();
    const data: number[] = [];
    const trades: number[] = [];
    await Promise.all([
      ...Array.from({ length: 14 }, () =>
        runtime.deps.nansen.perpPositions(SYNTHETIC_A).then(() => data.push(Date.now() - t0)),
      ),
      ...Array.from({ length: 3 }, () => trading.meta().then(() => trades.push(Date.now() - t0))),
    ]);
    // Lower bounds only: the 14th data call (13/s) and the 3rd trading call (2/s) had to wait.
    expect(Math.max(...data)).toBeGreaterThanOrEqual(900);
    expect(Math.max(...trades)).toBeGreaterThanOrEqual(900);
    runtime.deps.db.close();
  });
});

describe('REPLAY loop wrap', () => {
  it('keeps bots, heartbeats and triggers alive in every loop; a late trade does not halt', async () => {
    // Company A also trades 5 s before the end of the recording: its trigger would come due
    // after endT, which the looping clock never reaches.
    const late = JSON.stringify({
      t: SYNTHETIC_T0 + 595_000,
      k: 'hl',
      channel: 'trades',
      data: [
        {
          coin: 'SOL',
          side: 'B',
          px: 151,
          sz: 1,
          time: SYNTHETIC_T0 + 595_000,
          hash: '0x595',
          users: [SYNTHETIC_A, COUNTERPARTY],
        },
      ],
    });
    const r = await bootReplay([...syntheticSession(), late]);
    const { engine } = r;
    engine.idle.clientConnected(engine.clock.now());
    const beats = [0, 0, 0];
    let loop = 0;
    const refresh = engine.refresher.refresh.bind(engine.refresher);
    engine.refresher.refresh = (id, reason) => {
      if (reason === 'heartbeat') beats[loop] = (beats[loop] ?? 0) + 1;
      return refresh(id, reason);
    };
    const lastTradeId = () => engine.repos.trades.recent(1)[0]?.id ?? 0;
    const lastFilingId = () => engine.repos.filings.recent(1)[0]?.id ?? 0;
    const bounds: Array<{ trade: number; filing: number }> = [];
    for (loop = 0; loop < 3; loop++) {
      bounds.push({ trade: lastTradeId(), filing: lastFilingId() });
      for (let s = 0; s < 600; s++) await r.step();
    }
    bounds.push({ trade: lastTradeId(), filing: lastFilingId() });

    const inLoop = <T extends { id: number }>(rows: T[], l: number, key: 'trade' | 'filing') =>
      rows.filter((x) => x.id > (bounds[l]?.[key] ?? 0) && x.id <= (bounds[l + 1]?.[key] ?? 0));
    const trades = engine.repos.trades.recent(100_000);
    const filings = engine.repos.filings.recent(100_000);
    // A lively desk: every bot places at least one order of its own within the first two loops.
    const placed = [...inLoop(trades, 0, 'trade'), ...inLoop(trades, 1, 'trade')].filter(
      (t) => !t.forced && t.side !== 'SETTLE',
    );
    for (const bot of BOTS)
      expect(
        placed.filter((t) => t.playerId === bot.id).length,
        `${bot.id} orders`,
      ).toBeGreaterThan(0);
    for (const l of [1, 2]) {
      expect(beats[l], `heartbeats in loop ${l}`).toBeGreaterThan(0);
      const bot = inLoop(trades, l, 'trade').filter((t) => t.playerId.startsWith('bot-'));
      expect(bot.length, `bot trades in loop ${l}`).toBeGreaterThan(0);
      expect(bot.some((t) => t.playerId === 'bot-vulture' && t.side === 'SHORT')).toBe(true);
      const kinds = inLoop(filings, l, 'filing').map(
        (f) => `${f.companyId === SYNTHETIC_A ? 'A' : 'B'}:${f.kind}`,
      );
      expect(kinds, `filings in loop ${l}`).toEqual(
        expect.arrayContaining(['A:CLOSE', 'A:OPEN', 'B:LIQUIDATION', 'B:BANKRUPTCY']),
      );
      expect(kinds, `no halt for A in loop ${l}`).not.toContain('A:HALT');
    }
    expect(engine.state.get(SYNTHETIC_A)?.status).toBe('ACTIVE');
    await r.close();
  }, 60_000);

  it('tells clients the engine time and the loop they are watching', async () => {
    const r = await bootReplay(syntheticSession());
    const { engine, app } = r;
    const status = async () => (await app.inject({ url: '/api/status' })).json();
    await r.step(5_000);
    const loop = { startT: SYNTHETIC_T0, endT: SYNTHETIC_T0 + 600_000 };
    expect(await status()).toMatchObject({
      now: SYNTHETIC_T0 + 5_000,
      loop: { index: 0, ...loop },
    });
    await r.step(600_000);
    expect(await status()).toMatchObject({
      now: SYNTHETIC_T0 + 5_000,
      loop: { index: 1, ...loop },
    });
    expect(engine.status().now).toBe(engine.clock.now());
    await r.close();
  });

  it('lists IPO applications in the order they were made, even across a wrap', async () => {
    const r = await bootReplay(syntheticSession());
    const { engine, app } = r;
    const { player } = engine.players.create('human');
    await r.step(500_000);
    // Two unlisted addresses (a listed one is refused from local state).
    const late = engine.ipo.apply(player.id, '0x00000000000000000000000000000000000000f1');
    await r.step(200_000); // wrapped: the next application has an earlier engine-clock time
    const early = engine.ipo.apply(player.id, '0x00000000000000000000000000000000000000f2');
    if (!late.ok || !early.ok) throw new Error('apply failed');
    expect(early.app.createdAt).toBeLessThan(late.app.createdAt);
    const apps = (await app.inject({ url: '/api/ipo' })).json().apps as Array<{ id: string }>;
    expect(apps.map((a) => a.id)).toEqual([early.app.id, late.app.id]);
    await r.close();
  });

  it('runs anti-abuse caps on wall time: a wrap neither resets them nor makes them lifetime', async () => {
    const r = await bootReplay(syntheticSession());
    const { engine, app } = r;
    const { player } = engine.players.create('human');
    const addr = (i: number) => `0x${(0xc00 + i).toString(16).padStart(40, '0')}`;
    for (let i = 0; i < 3; i++) expect(engine.ipo.apply(player.id, addr(i)).ok).toBe(true);
    expect(engine.ipo.apply(player.id, addr(3))).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    const signup = async () =>
      (await app.inject({ method: 'POST', url: '/api/players' })).statusCode;
    for (let i = 0; i < 20; i++) expect(await signup()).toBe(201);
    expect(await signup()).toBe(429);

    // 30 minutes later: three loop wraps, but still inside the hour.
    await r.step(30 * 60_000);
    expect(engine.ipo.apply(player.id, addr(4))).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    expect(await signup()).toBe(429);

    // Past the hour on the wall clock: the caps have room again.
    await r.step(31 * 60_000);
    expect(engine.ipo.apply(player.id, addr(5)).ok).toBe(true);
    expect(await signup()).toBe(201);
    await r.close();
  });

  it('serves no history from the rest of the recording after a wrap; the latest point is this loop', async () => {
    const r = await bootReplay(syntheticSession());
    const { engine, app } = r;
    engine.idle.clientConnected(engine.clock.now());
    const a = engine.state.get(SYNTHETIC_A);
    if (!a) throw new Error('company A missing');
    type Point = { t: number; nav: number; price: number };
    const history = async (): Promise<Point[]> =>
      (await app.inject({ url: `/api/companies/${a.ticker}/history?minutes=60` })).json().points;

    for (let s = 0; s < 599; s++) await r.step();
    const loop0 = new Map((await history()).map((p) => [p.t, p.price]));
    expect(loop0.size).toBeGreaterThan(5);
    await r.step(); // the wrap
    await r.step(61_000); // past the IPO window of the new loop
    const { player } = engine.players.create('human');
    expect(
      engine.exchange.placeOrder(player.id, { ticker: a.ticker, side: 'BUY', cash: 5_000 }),
    ).toMatchObject({ ok: true });
    for (let s = 0; s < 61; s++) await r.step();

    const now = engine.clock.now();
    const points = await history();
    expect(points.length).toBeGreaterThan(0);
    expect(points.filter((p) => p.t > now)).toEqual([]);
    const latest = points[points.length - 1] as Point;
    expect(latest.t).toBe(Math.floor(now / 60_000) * 60_000);
    // Rewritten in this loop, after the buy: not the previous loop's price for the same minute.
    expect(latest.price).toBeGreaterThan((loop0.get(latest.t) ?? Number.POSITIVE_INFINITY) * 1.01);
    await r.close();
  }, 30_000);
});
