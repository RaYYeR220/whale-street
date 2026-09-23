import { z } from 'zod';

/** Number that may arrive as a numeric string. */
export const num = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) {
    ctx.addIssue({ code: 'custom', message: `not a number: ${String(v)}` });
    return z.NEVER;
  }
  return n;
});

/** Nullable number: a missing key, null, undefined or "" become null. `.optional()` sits on the
 * input side so zod treats the object key as optional; the transform still maps undefined → null. */
export const numOrNull = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((v) => (v === null || v === undefined || v === '' ? null : Number(v)))
  .refine((v) => v === null || Number.isFinite(v), 'not a number');

export const PerpPositionSchema = z.looseObject({
  token_symbol: z.string(),
  size: num,
  entry_price_usd: num,
  liquidation_price_usd: numOrNull,
  leverage_value: num,
  margin_used_usd: num,
  unrealized_pnl_usd: num,
});

export const PerpPositionsResponse = z.looseObject({
  data: z.looseObject({
    assetPositions: z.array(z.looseObject({ position: PerpPositionSchema })),
    margin_summary_account_value_usd: num,
    time: numOrNull,
  }),
});

export const PerpPnlSummaryResponse = z.looseObject({
  data: z
    .looseObject({
      top5_coins: z.array(z.looseObject({ coin: z.string() })).nullish(),
      traded_times: num,
      closed_trade_count: num,
      realized_pnl_usd: num,
      win_rate: num,
      fees_usd: num,
    })
    .nullish(),
});

const tsValue = z.union([z.number(), z.string()]);

export const PerpTradesResponse = z.looseObject({
  data: z.array(
    z.looseObject({
      timestamp: tsValue,
      side: z.string(),
      action: z.string(),
      token_symbol: z.string(),
      price: num,
      size: num,
      value_usd: num,
      closed_pnl: numOrNull,
      fee_usd: numOrNull,
    }),
  ),
});

export const LeaderboardResponse = z.looseObject({
  data: z.array(
    z.looseObject({
      trader_address: z.string(),
      total_pnl: num,
      roi: num,
      account_value: numOrNull,
      total_trades: num,
    }),
  ),
});

export const SmPerpTradesResponse = z.looseObject({
  data: z.array(
    z.looseObject({
      trader_address: z.string(),
      token_symbol: z.string(),
      side: z.string(),
      action: z.string(),
      value_usd: num,
      block_timestamp: tsValue,
    }),
  ),
});

export const PositionIntelligenceResponse = z.looseObject({
  data: z.array(
    z.looseObject({
      smart_trader_longs_usd: numOrNull,
      smart_trader_shorts_usd: numOrNull,
      whale_longs_usd: numOrNull,
      whale_shorts_usd: numOrNull,
      public_figure_longs_usd: numOrNull,
      public_figure_shorts_usd: numOrNull,
    }),
  ),
});

export const RelatedWalletsResponse = z.looseObject({
  data: z.array(
    z.looseObject({ address: z.string(), relation: z.string(), chain: z.string().nullish() }),
  ),
});

export const FirstFunderResponse = z.looseObject({
  data: z.array(
    z.looseObject({
      first_funder_address: z.string().nullish(),
      first_funder_name: z.string().nullish(),
    }),
  ),
});

export const CounterpartiesResponse = z.looseObject({
  data: z.array(
    z.looseObject({
      counterparty_address: z.string(),
      interaction_count: num,
      total_volume_usd: num,
    }),
  ),
});

export const AccountResponse = z.looseObject({ plan: z.string(), credits_remaining: num });
