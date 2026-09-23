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

    const rw = await clientWith({
      data: [{ address: A, relation: 'First Funder', chain: 'arbitrum' }],
    }).relatedWallets(A, 'arbitrum');
    expect(rw).toMatchObject({
      ok: true,
      value: [{ address: A, relation: 'First Funder', chain: 'arbitrum' }],
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
