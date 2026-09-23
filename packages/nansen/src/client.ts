import {
  type Address,
  type Maybe,
  none,
  type PnlStats,
  type Position,
  some,
} from '@whale-street/core';
import type { ApiResult, NansenHttp } from './http';
import {
  AccountResponse,
  CounterpartiesResponse,
  FirstFunderResponse,
  LeaderboardResponse,
  PerpPnlSummaryResponse,
  PerpPositionsResponse,
  PerpTradesResponse,
  PositionIntelligenceResponse,
  RelatedWalletsResponse,
  SmPerpTradesResponse,
} from './schemas';

export interface PerpState {
  positions: Position[];
  accountValue: number;
  time: number | null;
}
export interface PerpTradeRow {
  at: number;
  coin: string;
  side: string;
  action: string;
  price: number;
  size: number;
  valueUsd: number;
  closedPnl: number;
  feeUsd: number;
}
export interface LeaderboardRow {
  address: Address;
  totalPnl: number | null;
  roi: number | null;
  accountValue: number | null;
  totalTrades: number | null;
}
export interface SmPerpTrade {
  address: Address;
  coin: string;
  side: string;
  action: string;
  valueUsd: number | null;
  at: number;
}
export interface CohortPositioning {
  smartLongs: number;
  smartShorts: number;
  whaleLongs: number;
  whaleShorts: number;
  publicLongs: number;
  publicShorts: number;
}
export interface RelatedWallet {
  address: Address;
  relation: string;
  chain: string;
}
export interface FirstFunder {
  funder: Address | null;
  funderName: string | null;
}
export interface Counterparty {
  address: Address;
  interactions: number | null;
  volumeUsd: number | null;
}
export interface AccountInfo {
  plan: string;
  creditsRemaining: number;
}

export function isAddress(s: unknown): s is Address {
  return typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
}
const addr = (s: string): Address | null => (isAddress(s) ? (s.toLowerCase() as Address) : null);

/** Bare decimal (int or float) string, used to detect epoch-second/millisecond strings before
 * falling back to ISO date parsing. */
const NUMERIC_TS_RE = /^-?\d+(\.\d+)?$/;
/** An ISO timestamp with an explicit UTC/offset marker at the end. */
const HAS_OFFSET_RE = /[zZ]|[+-]\d\d:?\d\d$/;

function toMs(v: number | string): number {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) throw new Error(`bad timestamp: ${v}`);
    return v < 1e12 ? v * 1_000 : v;
  }
  const s = v.trim();
  if (s === '') throw new Error('bad timestamp: empty string');
  if (NUMERIC_TS_RE.test(s)) {
    const n = Number(s);
    const t = n < 1e12 ? n * 1_000 : n;
    if (Number.isFinite(t) && t > 0) return t;
    throw new Error(`bad timestamp: ${v}`);
  }
  // An ISO string with no offset is ambiguous in local time; Nansen's data is UTC, so append Z.
  const iso = HAS_OFFSET_RE.test(s) ? s : `${s}Z`;
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t <= 0) throw new Error(`bad timestamp: ${v}`);
  return t;
}

export function toMaybe<T>(r: ApiResult<T>): Maybe<T> {
  return r.ok ? some(r.value) : none(r.error);
}

export class NansenClient {
  constructor(private readonly http: NansenHttp) {}

  perpPositions(address: Address): Promise<ApiResult<PerpState>> {
    return this.http.request('POST', '/api/v1/profiler/perp-positions', { address }, (j) => {
      const d = PerpPositionsResponse.parse(j).data;
      return {
        positions: d.assetPositions.map(({ position: p }) => ({
          coin: p.token_symbol,
          size: p.size,
          entryPx: p.entry_price_usd,
          liqPx: p.liquidation_price_usd,
          leverage: p.leverage_value,
          marginUsed: p.margin_used_usd,
          unrealizedPnl: p.unrealized_pnl_usd,
        })),
        accountValue: d.margin_summary_account_value_usd,
        time: d.time,
      };
    });
  }

  perpPnlSummary(address: Address, from: string, to: string): Promise<ApiResult<PnlStats>> {
    return this.http.request(
      'POST',
      '/api/v1/profiler/perp-pnl-summary',
      { address, date: { from, to } },
      (j) => {
        const d = PerpPnlSummaryResponse.parse(j).data;
        if (!d)
          return {
            realizedPnlUsd: 0,
            feesUsd: 0,
            winRate: 0,
            closedTrades: 0,
            tradedTimes: 0,
            topCoins: [],
          };
        return {
          realizedPnlUsd: d.realized_pnl_usd,
          feesUsd: d.fees_usd,
          winRate: d.win_rate > 1 ? d.win_rate / 100 : d.win_rate,
          closedTrades: d.closed_trade_count,
          tradedTimes: d.traded_times,
          topCoins: (d.top5_coins ?? []).map((c) => c.coin),
        };
      },
    );
  }

  perpTrades(
    address: Address,
    from: string,
    to: string,
    o: { orderBy?: 'timestamp' | 'closed_pnl'; direction?: 'ASC' | 'DESC'; perPage?: number } = {},
  ): Promise<ApiResult<PerpTradeRow[]>> {
    const body = {
      address,
      date: { from, to },
      pagination: { page: 1, per_page: o.perPage ?? 100 },
      order_by: [{ field: o.orderBy ?? 'timestamp', direction: o.direction ?? 'DESC' }],
    };
    return this.http.request('POST', '/api/v1/profiler/perp-trades', body, (j) =>
      PerpTradesResponse.parse(j).data.map((t) => ({
        at: toMs(t.timestamp),
        coin: t.token_symbol,
        side: t.side,
        action: t.action,
        price: t.price,
        size: t.size,
        valueUsd: t.value_usd,
        closedPnl: t.closed_pnl ?? 0,
        feeUsd: t.fee_usd ?? 0,
      })),
    );
  }

  perpLeaderboard(from: string, to: string, perPage = 100): Promise<ApiResult<LeaderboardRow[]>> {
    const body = {
      date: { from, to },
      pagination: { page: 1, per_page: perPage },
      order_by: [{ field: 'total_pnl', direction: 'DESC' }],
    };
    return this.http.request('POST', '/api/v1/perp-leaderboard', body, (j) =>
      LeaderboardResponse.parse(j).data.flatMap((r) => {
        const a = addr(r.trader_address);
        return a
          ? [
              {
                address: a,
                totalPnl: r.total_pnl,
                roi: r.roi,
                accountValue: r.account_value,
                totalTrades: r.total_trades,
              },
            ]
          : [];
      }),
    );
  }

  smartMoneyPerpTrades(
    lookbackHours: number,
    onlyNewPositions: boolean,
    perPage = 100,
  ): Promise<ApiResult<SmPerpTrade[]>> {
    const body = {
      lookback_hours: lookbackHours,
      only_new_positions: onlyNewPositions,
      pagination: { page: 1, per_page: perPage },
      order_by: [{ field: 'block_timestamp', direction: 'DESC' }],
    };
    return this.http.request('POST', '/api/v1/smart-money/perp-trades', body, (j) =>
      SmPerpTradesResponse.parse(j).data.flatMap((t) => {
        const a = addr(t.trader_address);
        return a
          ? [
              {
                address: a,
                coin: t.token_symbol,
                side: t.side ?? '',
                action: t.action,
                valueUsd: t.value_usd,
                at: toMs(t.block_timestamp),
              },
            ]
          : [];
      }),
    );
  }

  positionIntelligence(coin: string): Promise<ApiResult<CohortPositioning>> {
    return this.http.request(
      'POST',
      '/api/v1/tgm/position-intelligence',
      { token_address: coin },
      (j) => {
        const row = PositionIntelligenceResponse.parse(j).data[0];
        if (!row) throw new Error('no cohort data');
        return {
          smartLongs: row.smart_trader_longs_usd ?? 0,
          smartShorts: row.smart_trader_shorts_usd ?? 0,
          whaleLongs: row.whale_longs_usd ?? 0,
          whaleShorts: row.whale_shorts_usd ?? 0,
          publicLongs: row.public_figure_longs_usd ?? 0,
          publicShorts: row.public_figure_shorts_usd ?? 0,
        };
      },
    );
  }

  relatedWallets(address: Address, chain: string): Promise<ApiResult<RelatedWallet[]>> {
    const body = { address, chain, pagination: { page: 1, per_page: 50 } };
    return this.http.request('POST', '/api/v1/profiler/address/related-wallets', body, (j) =>
      RelatedWalletsResponse.parse(j).data.flatMap((r) => {
        const a = addr(r.address);
        return a ? [{ address: a, relation: r.relation, chain: r.chain ?? chain }] : [];
      }),
    );
  }

  firstFunder(address: Address): Promise<ApiResult<FirstFunder>> {
    return this.http.request(
      'POST',
      '/api/v1/profiler/address/first-funder',
      { address, chain: 'all' },
      (j) => {
        const row = FirstFunderResponse.parse(j).data[0];
        const funder = row?.first_funder_address ? addr(row.first_funder_address) : null;
        return { funder, funderName: row?.first_funder_name ?? null };
      },
    );
  }

  counterparties(
    address: Address,
    chain: string,
    from: string,
    to: string,
    perPage = 25,
  ): Promise<ApiResult<Counterparty[]>> {
    const body = {
      address,
      chain,
      date: { from, to },
      group_by: 'wallet',
      source_input: 'Combined',
      pagination: { page: 1, per_page: perPage },
    };
    return this.http.request('POST', '/api/v1/profiler/address/counterparties', body, (j) =>
      CounterpartiesResponse.parse(j).data.flatMap((r) => {
        const a = addr(r.counterparty_address);
        return a
          ? [{ address: a, interactions: r.interaction_count, volumeUsd: r.total_volume_usd }]
          : [];
      }),
    );
  }

  account(): Promise<ApiResult<AccountInfo>> {
    return this.http.request('GET', '/api/v1/account', undefined, (j) => {
      const d = AccountResponse.parse(j);
      return { plan: d.plan, creditsRemaining: d.credits_remaining };
    });
  }
}
