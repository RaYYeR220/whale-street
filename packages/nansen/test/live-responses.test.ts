import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type CallRecord,
  type Clock,
  NansenClient,
  NansenHttp,
  PerpTradesResponse,
} from '../src/index';

/** Real response bodies (and the headers the client reads), recorded live on 2026-09-24. */
interface Recorded {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}
const live = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/live-responses.json', import.meta.url)), 'utf8'),
) as Record<
  | 'perpPositions'
  | 'perpTradesFirstFill'
  | 'perpTradesTopByPnl'
  | 'positionIntelligenceBtc'
  | 'perpPnlSummaryUnused'
  | 'rateLimited',
  Recorded
>;

const TRADER = '0xea0027b6ea9b6d7d401b5266979cc3b3ca87a918' as const;

class FakeClock implements Clock {
  t = 0;
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.t += ms;
  }
}

/** A client answering every call with the recorded responses, in order. */
function replaying(replies: Recorded[], o: { clock?: Clock; calls?: CallRecord[] } = {}) {
  const sentAt: number[] = [];
  const clock = o.clock ?? new FakeClock();
  const fetch = (async () => {
    sentAt.push(clock.now());
    const r = replies.shift();
    if (!r) throw new Error('no more recorded replies');
    return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as unknown as typeof globalThis.fetch;
  const http = new NansenHttp({
    apiKey: 'k',
    fetch,
    clock,
    onCall: (c) => o.calls?.push(c),
  });
  return { client: new NansenClient(http), http, sentAt };
}

describe('real Nansen responses (recorded 2026-09-24)', () => {
  it('perp positions: all snake_case, string numbers, HIP-3 coins and null liquidation prices', async () => {
    const calls: CallRecord[] = [];
    const { client } = replaying([live.perpPositions], { calls });
    const r = await client.perpPositions(TRADER);
    if (!r.ok) throw new Error(r.error);
    expect(r.value.time).toBe(1_790_284_682_672);
    expect(r.value.accountValue).toBeCloseTo(8_367_801.789, 3);
    expect(r.value.positions).toHaveLength(11);
    expect(r.value.positions.filter((p) => p.coin.includes(':')).map((p) => p.coin)).toEqual([
      'xyz:BRENTOIL',
      'xyz:CL',
      'io:NBIS',
      'xyz:SNDK',
    ]);
    expect(r.value.positions[0]).toEqual({
      coin: 'ETH',
      size: 9_003.8263,
      entryPx: 2_003.01,
      liqPx: 771.556240106,
      leverage: 5,
      marginUsed: 4_841_357.40151,
      unrealizedPnl: 6_172_008.142244,
    });
    // A short is a negative size; a liquidation price Nansen did not report stays null.
    expect(r.value.positions.find((p) => p.coin === 'xyz:BRENTOIL')?.size).toBe(-55_000);
    expect(r.value.positions.find((p) => p.coin === 'HYPE')?.liqPx).toBeNull();
    expect(r.value.positions.filter((p) => p.liqPx === null).map((p) => p.coin)).toEqual([
      'HYPE',
      'ZEC',
      'xyz:SNDK',
      'LIT',
      'VVV',
      'SOL',
      'PURR',
    ]);
    // The metered response reports the balance it left.
    expect(calls[0]).toMatchObject({ creditsUsed: 1, creditsRemaining: 1_094 });
  });

  it('perp trades: the first fill of the #1 trader is a spot fill ("@142"), dropped; a perp fill is kept', async () => {
    const raw = PerpTradesResponse.parse(live.perpTradesFirstFill.body).data;
    expect(raw.map((t) => [t.token_symbol, t.side, t.action])).toEqual([['@142', 'Short', 'Sell']]);
    const { client } = replaying([live.perpTradesFirstFill, live.perpTradesTopByPnl]);
    const first = await client.perpTrades(TRADER, '2025-09-24', '2026-09-24', {
      orderBy: 'timestamp',
      direction: 'ASC',
    });
    expect(first).toMatchObject({ ok: true, value: [] });
    const top = await client.perpTrades(TRADER, '2025-09-24', '2026-09-24', {
      orderBy: 'closed_pnl',
    });
    expect(top).toMatchObject({
      ok: true,
      value: [
        {
          at: Date.parse('2026-09-23T09:29:46.009Z'),
          coin: 'ZEC',
          side: 'Long',
          action: 'Reduce',
          closedPnl: 3_957_898.553276,
          feeUsd: 4_719.461607,
        },
      ],
    });
  });

  it('position intelligence: cohort totals, shorts reported as positive figures', async () => {
    const { client } = replaying([live.positionIntelligenceBtc]);
    const r = await client.positionIntelligence('BTC');
    if (!r.ok) throw new Error(r.error);
    expect(r.value).toEqual({
      smartLongs: 99_356_615.65089002,
      smartShorts: 29_404_176.990659997,
      whaleLongs: 1_372_580_877.64329,
      whaleShorts: 1_207_088_074.7921698,
      publicLongs: 68_809_739.71769999,
      publicShorts: 75_458_359.50614999,
    });
  });

  it('pnl summary of an address that never traded: zeros, not null', async () => {
    const { client } = replaying([live.perpPnlSummaryUnused]);
    const r = await client.perpPnlSummary(
      '0x000000000000000000000000000000000000dead',
      '2025-09-24',
      '2026-09-24',
    );
    expect(r).toEqual({
      ok: true,
      callId: expect.any(String),
      value: {
        realizedPnlUsd: 0,
        feesUsd: 0,
        winRate: 0,
        closedTrades: 0,
        tradedTimes: 0,
        topCoins: [],
      },
    });
  });

  it('the endpoint-scoped 429 envelope: code kept in the error, the endpoint held for Retry-After', async () => {
    const clock = new FakeClock();
    const { http, sentAt } = replaying([live.rateLimited, live.perpTradesTopByPnl], { clock });
    const path = '/api/v1/profiler/perp-trades';
    const r = await http.request('POST', path, {}, (j) => j, { retries: 0 });
    expect(r).toMatchObject({
      ok: false,
      status: 429,
      error: 'HTTP 429: rate_limit_exceeded: Rate limit exceeded. Please try again later.',
    });
    await http.request('POST', path, {}, (j) => j);
    expect(sentAt).toEqual([0, 60_000]);
  });
});
