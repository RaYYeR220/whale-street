import { z } from 'zod';

/** A plain decimal number string: optional leading `-`, digits, optional fraction, optional
 * exponent. Rejects hex ("0x10"), empty/whitespace-only strings and any other non-decimal form. */
const DECIMAL_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/** Number that may arrive as a numeric string. Strings are trimmed and must match a strict
 * decimal shape; a malformed string is a schema error, never a silently coerced value. */
export const num = z.union([z.number(), z.string()]).transform((v, ctx) => {
  let n: number;
  if (typeof v === 'number') {
    n = v;
  } else {
    const t = v.trim();
    if (t === '' || !DECIMAL_RE.test(t)) {
      ctx.addIssue({ code: 'custom', message: `not a number: ${String(v)}` });
      return z.NEVER;
    }
    n = Number(t);
  }
  if (!Number.isFinite(n)) {
    ctx.addIssue({ code: 'custom', message: `not a number: ${String(v)}` });
    return z.NEVER;
  }
  return n;
});

/** Nullable number: a missing key, null, undefined, "" or whitespace-only become null.
 * `.optional()` sits on the input side so zod treats the object key as optional. Any other
 * non-decimal string (e.g. "0x10") is a schema error, not a silently coerced value. */
export const numOrNull = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) {
        ctx.addIssue({ code: 'custom', message: `not a number: ${String(v)}` });
        return z.NEVER;
      }
      return v;
    }
    const t = v.trim();
    if (t === '') return null;
    if (!DECIMAL_RE.test(t)) {
      ctx.addIssue({ code: 'custom', message: `not a number: ${v}` });
      return z.NEVER;
    }
    const n = Number(t);
    if (!Number.isFinite(n)) {
      ctx.addIssue({ code: 'custom', message: `not a number: ${v}` });
      return z.NEVER;
    }
    return n;
  });

export const PerpPositionSchema = z.looseObject({
  token_symbol: z.string(),
  size: num,
  entry_price_usd: num,
  liquidation_price_usd: numOrNull,
  leverage_value: num,
  margin_used_usd: num,
  unrealized_pnl_usd: num,
});

/** Nansen's perp-positions payload has been observed with both camelCase and snake_case keys
 * for `assetPositions`/`time`. Normalize before validating so both spellings map identically;
 * any other keys pass through untouched. */
function normalizePerpPositionsPayload(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  const outer = v as Record<string, unknown>;
  const d = outer.data;
  if (d === null || typeof d !== 'object') return v;
  const rec = d as Record<string, unknown>;
  const assetPositions = 'assetPositions' in rec ? rec.assetPositions : rec.asset_positions;
  const time = 'time' in rec ? rec.time : rec.timestamp;
  return { ...outer, data: { ...rec, assetPositions, time } };
}

export const PerpPositionsResponse = z.preprocess(
  normalizePerpPositionsPayload,
  z.looseObject({
    data: z.looseObject({
      assetPositions: z.array(z.looseObject({ position: PerpPositionSchema })),
      margin_summary_account_value_usd: num,
      time: numOrNull,
    }),
  }),
);

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
      total_pnl: numOrNull,
      roi: numOrNull,
      account_value: numOrNull,
      total_trades: numOrNull,
    }),
  ),
});

export const SmPerpTradesResponse = z.looseObject({
  data: z.array(
    z.looseObject({
      trader_address: z.string(),
      token_symbol: z.string(),
      side: z.string().nullish(),
      action: z.string(),
      value_usd: numOrNull,
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
      interaction_count: numOrNull,
      total_volume_usd: numOrNull,
    }),
  ),
});

export const AccountResponse = z.looseObject({ plan: z.string(), credits_remaining: num });
