import type { Address } from '@whale-street/core';
import { z } from 'zod';
import type { ApiResult, NansenHttp } from './http';
import { num, numOrNull } from './schemas';

export interface BuilderFeeStatus {
  approved: boolean;
  maxFeeRate: number;
  requiredFee: number;
  builderAddress: Address;
}
export interface PerpAsset {
  assetId: number;
  name: string;
  szDecimals: number;
  maxLeverage: number;
}
export interface Eip712Payload {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}
export interface PreparedAction {
  action: Record<string, unknown>;
  nonce: number;
  vaultAddress: string | null;
  eip712: Eip712Payload;
  size: number | null;
  price: number | null;
}
export interface OrderRequest {
  walletAddress: Address;
  coin: string;
  isBuy: boolean;
  size: number;
  price: number;
  orderType: 'market' | 'limit';
  reduceOnly?: boolean;
  tif?: 'Gtc' | 'Ioc' | 'Alo';
  slippage?: number;
  takeProfit?: number | null;
  stopLoss?: number | null;
}
export interface Signature {
  r: string;
  s: string;
  v: number;
}
export interface ExecuteResult {
  status: string;
  statuses: unknown[];
}

const BuilderFeeResponse = z.looseObject({
  approved: z.boolean(),
  max_fee_rate: num,
  required_fee: num,
  builder_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});
const MetaResponse = z.looseObject({
  assets: z.array(
    z.looseObject({ asset_id: num, name: z.string(), sz_decimals: num, max_leverage: num }),
  ),
});
const PrepareResponse = z.looseObject({
  action: z.record(z.string(), z.unknown()),
  nonce: num,
  vault_address: z.string().nullish(),
  eip712: z.looseObject({
    domain: z.record(z.string(), z.unknown()),
    types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
    primaryType: z.string(),
    message: z.record(z.string(), z.unknown()),
  }),
  size: numOrNull,
  price: numOrNull,
});
const ExecuteResponse = z.looseObject({
  status: z.string().nullish(),
  // A 2xx execute response has been observed with a bare string `response` (e.g. "accepted") as
  // well as the documented `{ data: { statuses: [...] } }` shape. Accept anything here and pull
  // `statuses` out defensively below: a 2xx must never turn into ok:false over an unexpected but
  // harmless response shape.
  response: z.unknown().optional(),
});

/** Defensively pulls `statuses` out of an execute response's `response` field. Any shape other
 * than `{ data: { statuses: [...] } }` yields an empty list rather than an error. */
function extractStatuses(response: unknown): unknown[] {
  if (response === null || typeof response !== 'object') return [];
  const data = (response as { data?: unknown }).data;
  if (data === null || typeof data !== 'object') return [];
  const statuses = (data as { statuses?: unknown }).statuses;
  return Array.isArray(statuses) ? statuses : [];
}

function toPrepared(j: unknown): PreparedAction {
  const p = PrepareResponse.parse(j);
  return {
    action: p.action,
    nonce: p.nonce,
    vaultAddress: p.vault_address ?? null,
    eip712: {
      domain: p.eip712.domain,
      types: p.eip712.types,
      primaryType: p.eip712.primaryType,
      message: p.eip712.message,
    },
    size: p.size,
    price: p.price,
  };
}

export class NansenTrading {
  constructor(private readonly http: NansenHttp) {}

  builderFee(wallet: Address): Promise<ApiResult<BuilderFeeStatus>> {
    return this.http.request(
      'GET',
      '/api/v1/perp/builder-fee',
      undefined,
      (j) => {
        const d = BuilderFeeResponse.parse(j);
        return {
          approved: d.approved,
          maxFeeRate: d.max_fee_rate,
          requiredFee: d.required_fee,
          builderAddress: d.builder_address.toLowerCase() as Address,
        };
      },
      { query: { wallet_address: wallet } },
    );
  }

  meta(): Promise<ApiResult<PerpAsset[]>> {
    return this.http.request('GET', '/api/v1/perp/meta', undefined, (j) =>
      MetaResponse.parse(j).assets.map((a) => ({
        assetId: a.asset_id,
        name: a.name,
        szDecimals: a.sz_decimals,
        maxLeverage: a.max_leverage,
      })),
    );
  }

  prepareOrder(req: OrderRequest): Promise<ApiResult<PreparedAction>> {
    const body = {
      wallet_address: req.walletAddress,
      coin: req.coin,
      is_buy: req.isBuy,
      size: req.size,
      price: req.price,
      order_type: req.orderType,
      reduce_only: req.reduceOnly ?? false,
      tif: req.tif ?? 'Gtc',
      slippage: req.slippage ?? 0.03,
      take_profit: req.takeProfit ?? null,
      stop_loss: req.stopLoss ?? null,
    };
    return this.http.request('POST', '/api/v1/perp/order', body, toPrepared);
  }

  prepareLeverage(
    wallet: Address,
    coin: string,
    leverage: number,
    isCross = true,
  ): Promise<ApiResult<PreparedAction>> {
    return this.http.request(
      'POST',
      '/api/v1/perp/leverage',
      { wallet_address: wallet, coin, leverage, is_cross: isCross },
      toPrepared,
    );
  }

  execute(p: {
    action: Record<string, unknown>;
    nonce: number;
    signature: Signature;
    vaultAddress: string | null;
  }): Promise<ApiResult<ExecuteResult>> {
    const body = {
      action: p.action,
      nonce: p.nonce,
      signature: p.signature,
      vault_address: p.vaultAddress,
    };
    return this.http.request(
      'POST',
      '/api/v1/perp/execute',
      body,
      (j) => {
        const d = ExecuteResponse.parse(j);
        return { status: d.status ?? 'unknown', statuses: extractStatuses(d.response) };
      },
      { retries: 0 },
    );
  }
}
