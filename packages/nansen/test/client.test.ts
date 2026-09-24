import { describe, expect, it } from 'vitest';
import { type Clock, NansenClient, NansenHttp, toMaybe } from '../src/index';

const clock: Clock = { now: () => 0, sleep: async () => {} };
function clientWith(body: unknown, seen: { path?: string; body?: unknown } = {}) {
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.path = new URL(String(input)).pathname;
    seen.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return new NansenClient(new NansenHttp({ apiKey: 'k', fetch: f, clock }));
}
const A = '0x00000000000000000000000000000000000000aa' as const;

describe('NansenClient', () => {
  it('maps perp positions (string numbers, null liq price)', async () => {
    const seen: { path?: string; body?: unknown } = {};
    const c = clientWith(
      {
        data: {
          assetPositions: [
            {
              position: {
                token_symbol: 'BTC',
                size: '-0.5',
                entry_price_usd: '64000',
                liquidation_price_usd: '70000.5',
                leverage_value: 10,
                margin_used_usd: '3200',
                unrealized_pnl_usd: '-120.5',
              },
              position_type: 'oneWay',
            },
            {
              position: {
                token_symbol: 'HYPE',
                size: '100',
                entry_price_usd: '40',
                liquidation_price_usd: null,
                leverage_value: '3',
                margin_used_usd: '1333',
                unrealized_pnl_usd: '50',
              },
              position_type: 'oneWay',
            },
          ],
          margin_summary_account_value_usd: '25000.75',
          time: 1_758_000_000_000,
        },
      },
      seen,
    );
    const r = await c.perpPositions(A);
    if (!r.ok) throw new Error(r.error);
    expect(seen).toEqual({ path: '/api/v1/profiler/perp-positions', body: { address: A } });
    expect(r.value.accountValue).toBe(25_000.75);
    expect(r.value.time).toBe(1_758_000_000_000);
    expect(r.value.positions).toEqual([
      {
        coin: 'BTC',
        size: -0.5,
        entryPx: 64_000,
        liqPx: 70_000.5,
        leverage: 10,
        marginUsed: 3_200,
        unrealizedPnl: -120.5,
      },
      {
        coin: 'HYPE',
        size: 100,
        entryPx: 40,
        liqPx: null,
        leverage: 3,
        marginUsed: 1_333,
        unrealizedPnl: 50,
      },
    ]);
  });

  it('perp positions: a snake_case payload maps identically to the camelCase one', async () => {
    const position = {
      position: {
        token_symbol: 'BTC',
        size: '1',
        entry_price_usd: '1',
        liquidation_price_usd: null,
        leverage_value: '1',
        margin_used_usd: '1',
        unrealized_pnl_usd: '1',
      },
    };
    const rCamel = await clientWith({
      data: {
        assetPositions: [position],
        margin_summary_account_value_usd: '100',
        time: 1_758_000_000_000,
      },
    }).perpPositions(A);
    const rSnake = await clientWith({
      data: {
        asset_positions: [position],
        margin_summary_account_value_usd: '100',
        timestamp: 1_758_000_000_000,
      },
    }).perpPositions(A);
    if (!rCamel.ok) throw new Error(rCamel.error);
    if (!rSnake.ok) throw new Error(rSnake.error);
    expect(rSnake.value).toEqual(rCamel.value);
    expect(rCamel.value.time).toBe(1_758_000_000_000);
  });

  it('maps pnl summary and normalizes percentage win rates', async () => {
    const c = clientWith({
      data: {
        top5_coins: [{ coin: 'BTC' }, { coin: 'ETH' }],
        traded_times: '40',
        closed_trade_count: 30,
        realized_pnl_usd: '1500',
        win_rate: 62.5,
        fees_usd: '12',
      },
    });
    const r = await c.perpPnlSummary(A, '2025-09-01', '2026-09-23');
    expect(r).toMatchObject({
      ok: true,
      value: {
        realizedPnlUsd: 1_500,
        feesUsd: 12,
        winRate: 0.625,
        closedTrades: 30,
        tradedTimes: 40,
        topCoins: ['BTC', 'ETH'],
      },
    });
  });

  it('missing pnl summary data fails rather than fabricating zeros', async () => {
    const r = await clientWith({ data: null }).perpPnlSummary(A, '2025-09-01', '2026-09-23');
    expect(r).toMatchObject({ ok: false, error: 'schema: no pnl data' });
    const r2 = await clientWith({}).perpPnlSummary(A, '2025-09-01', '2026-09-23');
    expect(r2).toMatchObject({ ok: false, error: 'schema: no pnl data' });
  });

  it('perp trades: request shape and timestamp parsing', async () => {
    const seen: { path?: string; body?: unknown } = {};
    const c = clientWith(
      {
        data: [
          {
            timestamp: '2026-01-02T03:04:05Z',
            side: 'Long',
            action: 'Close',
            token_symbol: 'SOL',
            price: '150',
            size: '2',
            value_usd: '300',
            closed_pnl: '42',
            fee_usd: '0.3',
          },
        ],
        pagination: { page: 1, per_page: 1, is_last_page: true },
      },
      seen,
    );
    const r = await c.perpTrades(A, '2025-09-23', '2026-09-23', {
      orderBy: 'closed_pnl',
      perPage: 1,
    });
    expect(seen.body).toEqual({
      address: A,
      date: { from: '2025-09-23', to: '2026-09-23' },
      pagination: { page: 1, per_page: 1 },
      order_by: [{ field: 'closed_pnl', direction: 'DESC' }],
    });
    expect(r).toMatchObject({
      ok: true,
      value: [
        {
          at: Date.parse('2026-01-02T03:04:05Z'),
          coin: 'SOL',
          closedPnl: 42,
          feeUsd: 0.3,
          valueUsd: 300,
        },
      ],
    });
  });

  it('perp trades: spot fills (token_symbol "@<index>") are dropped, perp fills kept', async () => {
    const fill = (token_symbol: string, closed_pnl: number) => ({
      timestamp: '2026-01-23T16:09:04.842000Z',
      side: 'Short',
      action: 'Sell',
      token_symbol,
      price: 89725,
      size: 0.00027,
      value_usd: 24.22575,
      closed_pnl,
      fee_usd: 0.0096903,
    });
    const r = await clientWith({
      data: [fill('@142', 0.00891001), fill('ZEC', 12.5), fill('@151', 0), fill('xyz:CL', 1)],
    }).perpTrades(A, '2025-09-24', '2026-09-24', { direction: 'ASC', perPage: 100 });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.map((t) => t.coin)).toEqual(['ZEC', 'xyz:CL']);
  });

  it('perp trades: an ISO timestamp without an offset is treated as UTC', async () => {
    const c = clientWith({
      data: [
        {
          timestamp: '2025-10-08T18:46:11.452000',
          side: 'Long',
          action: 'Close',
          token_symbol: 'SOL',
          price: '1',
          size: '1',
          value_usd: '1',
          closed_pnl: '0',
          fee_usd: '0',
        },
      ],
    });
    const r = await c.perpTrades(A, '2025-09-23', '2026-09-23');
    expect(r).toMatchObject({
      ok: true,
      value: [{ at: Date.parse('2025-10-08T18:46:11.452Z') }],
    });
  });

  it('perp trades: an empty timestamp fails rather than fabricating a time', async () => {
    const c = clientWith({
      data: [
        {
          timestamp: '',
          side: 'Long',
          action: 'Close',
          token_symbol: 'SOL',
          price: '1',
          size: '1',
          value_usd: '1',
          closed_pnl: '0',
          fee_usd: '0',
        },
      ],
    });
    const r = await c.perpTrades(A, '2025-09-23', '2026-09-23');
    expect(r.ok).toBe(false);
  });

  it('perp trades: a missing closed_pnl or fee_usd stays null, never an invented zero', async () => {
    const c = clientWith({
      data: [
        {
          timestamp: '2026-01-02T03:04:05Z',
          side: 'Long',
          action: 'Close',
          token_symbol: 'SOL',
          price: '150',
          size: '2',
          value_usd: '300',
          closed_pnl: null,
          fee_usd: null,
        },
        {
          timestamp: '2026-01-02T03:04:05Z',
          side: 'Long',
          action: 'Close',
          token_symbol: 'SOL',
          price: '150',
          size: '2',
          value_usd: '300',
        },
      ],
    });
    const r = await c.perpTrades(A, '2025-09-23', '2026-09-23');
    expect(r).toMatchObject({
      ok: true,
      value: [
        { closedPnl: null, feeUsd: null },
        { closedPnl: null, feeUsd: null },
      ],
    });
  });

  it('leaderboard drops invalid addresses and keeps null numeric fields', async () => {
    const c = clientWith({
      data: [
        {
          trader_address: '0x00000000000000000000000000000000000000BB',
          total_pnl: '1000',
          roi: '0.5',
          account_value: '50000',
          total_trades: 12,
        },
        { trader_address: 'not-an-address', total_pnl: 1, roi: 0, total_trades: 1 },
        {
          trader_address: '0x00000000000000000000000000000000000000cd',
          total_pnl: null,
          roi: null,
          account_value: null,
          total_trades: null,
        },
      ],
    });
    const r = await c.perpLeaderboard('2026-08-23', '2026-09-23');
    expect(r).toMatchObject({
      ok: true,
      value: [
        {
          address: '0x00000000000000000000000000000000000000bb',
          totalPnl: 1_000,
          roi: 0.5,
          accountValue: 50_000,
          totalTrades: 12,
        },
        {
          address: '0x00000000000000000000000000000000000000cd',
          totalPnl: null,
          roi: null,
          accountValue: null,
          totalTrades: null,
        },
      ],
    });
  });

  it('leaderboard: a row whose top positions include a HIP-3 market ("dex:COIN") is marked hip3', async () => {
    const row = (n: number, top_positions: unknown) => ({
      trader_address: `0x${n.toString(16).padStart(40, '0')}`,
      total_pnl: 1,
      roi: 0.1,
      account_value: 600_000,
      total_trades: 10,
      top_positions,
    });
    const r = await clientWith({
      data: [
        row(1, [
          { coin: 'ETH', side: 'long', size_base: 9003.8263, position_value_usd: 24_206_336 },
          { coin: 'xyz:BRENTOIL', side: 'short', size_base: 55_000, position_value_usd: 5_517_600 },
        ]),
        row(2, [{ coin: 'SOL', side: 'long', size_base: 10 }]),
        row(3, []),
        row(4, null),
        row(5, undefined),
        // A malformed list is only a hint gone missing: the row stays, not marked.
        row(6, [{ coin: 5 }]),
      ],
    }).perpLeaderboard('2026-08-25', '2026-09-24');
    if (!r.ok) throw new Error(r.error);
    expect(r.value.map((x) => x.hip3)).toEqual([true, false, false, false, false, false]);
  });

  it('smart money perp trades, cohort positioning, wallet graph, account', async () => {
    const sm = await clientWith({
      data: [
        {
          trader_address: A,
          token_symbol: 'ETH',
          side: 'Long',
          action: 'Open',
          value_usd: '250000',
          block_timestamp: 1_758_000_000,
        },
      ],
    }).smartMoneyPerpTrades(24, true);
    expect(sm).toMatchObject({
      ok: true,
      value: [{ address: A, coin: 'ETH', valueUsd: 250_000, at: 1_758_000_000_000 }],
    });

    const smMissingSideAndValue = await clientWith({
      data: [
        {
          trader_address: A,
          token_symbol: 'ETH',
          action: 'Open',
          value_usd: null,
          block_timestamp: 1_758_000_000,
        },
      ],
    }).smartMoneyPerpTrades(24, true);
    expect(smMissingSideAndValue).toMatchObject({
      ok: true,
      value: [{ address: A, coin: 'ETH', side: '', valueUsd: null, at: 1_758_000_000_000 }],
    });

    const pi = await clientWith({
      data: [
        {
          smart_trader_longs_usd: '10',
          smart_trader_shorts_usd: '5',
          whale_longs_usd: 1,
          whale_shorts_usd: 2,
          public_figure_longs_usd: 0,
          public_figure_shorts_usd: '3',
        },
      ],
    }).positionIntelligence('BTC');
    expect(pi).toMatchObject({
      ok: true,
      value: {
        smartLongs: 10,
        smartShorts: 5,
        whaleLongs: 1,
        whaleShorts: 2,
        publicLongs: 0,
        publicShorts: 3,
      },
    });
    expect(await clientWith({ data: [] }).positionIntelligence('BTC')).toMatchObject({
      ok: false,
      error: 'schema: no cohort data',
    });
    // Missing or null cohort figures stay unknown (null), never zero.
    const partial = await clientWith({
      data: [{ smart_trader_longs_usd: '10', smart_trader_shorts_usd: null, whale_longs_usd: 0 }],
    }).positionIntelligence('BTC');
    expect(partial).toEqual({
      ok: true,
      callId: expect.any(String),
      value: {
        smartLongs: 10,
        smartShorts: null,
        whaleLongs: 0,
        whaleShorts: null,
        publicLongs: null,
        publicShorts: null,
      },
    });

    const rwSeen: { path?: string; body?: unknown } = {};
    const rw = await clientWith(
      { data: [{ address: A, relation: 'First Funder', chain: 'arbitrum' }] },
      rwSeen,
    ).relatedWallets(A, 'arbitrum');
    expect(rw).toMatchObject({
      ok: true,
      value: [{ address: A, relation: 'First Funder', chain: 'arbitrum' }],
    });
    // `address` is deprecated on this endpoint (Warning: 299); `wallet_address` is the parameter.
    expect(rwSeen).toEqual({
      path: '/api/v1/profiler/address/related-wallets',
      body: { wallet_address: A, chain: 'arbitrum', pagination: { page: 1, per_page: 50 } },
    });

    const ff = await clientWith({
      data: [{ wallet_address: A, first_funder_address: A, first_funder_name: 'Binance 14' }],
    }).firstFunder(A);
    expect(ff).toMatchObject({ ok: true, value: { funder: A, funderName: 'Binance 14' } });
    expect(await clientWith({ data: [] }).firstFunder(A)).toMatchObject({
      ok: true,
      value: { funder: null, funderName: null },
    });

    const cp = await clientWith({
      data: [{ counterparty_address: A, interaction_count: 7, total_volume_usd: '900' }],
    }).counterparties(A, 'arbitrum', '2026-06-01', '2026-09-01');
    expect(cp).toMatchObject({
      ok: true,
      value: [{ address: A, interactions: 7, volumeUsd: 900 }],
    });

    const cpNull = await clientWith({
      data: [{ counterparty_address: A, interaction_count: null, total_volume_usd: null }],
    }).counterparties(A, 'arbitrum', '2026-06-01', '2026-09-01');
    expect(cpNull).toMatchObject({
      ok: true,
      value: [{ address: A, interactions: null, volumeUsd: null }],
    });

    expect(await clientWith({ plan: 'free', credits_remaining: 1100 }).account()).toMatchObject({
      ok: true,
      value: { plan: 'free', creditsRemaining: 1_100 },
    });
  });

  it('toMaybe converts results', () => {
    expect(toMaybe({ ok: true, value: 1, callId: 'x' })).toEqual({ ok: true, value: 1 });
    expect(toMaybe({ ok: false, error: 'e', status: 500, callId: 'x' })).toEqual({
      ok: false,
      error: 'e',
    });
  });
});
