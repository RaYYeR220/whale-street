import { describe, expect, it } from 'vitest';
import { type Clock, NansenHttp, NansenTrading } from '../src/index';

const clock: Clock = { now: () => 0, sleep: async () => {} };
const W = '0x00000000000000000000000000000000000000cc' as const;
const prepared = {
  action: {
    type: 'order',
    orders: [{ a: 1, b: true, p: '1850.7', s: '0.0123', r: false, t: { limit: { tif: 'Ioc' } } }],
    grouping: 'na',
    builder: { b: '0x93053f1e7a5efeda532fe69cbbe43cbec3a0f13f', f: 80 },
  },
  nonce: 1_754_476_800_000,
  vault_address: null,
  eip712: {
    domain: {
      name: 'Exchange',
      version: '1',
      chainId: 1337,
      verifyingContract: '0x0000000000000000000000000000000000000000',
    },
    types: {
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' },
      ],
    },
    primaryType: 'Agent',
    message: { source: 'a', connectionId: '0x01' },
  },
  size: 0.0123,
  price: 1850.7,
};

function trading(replies: Array<{ status: number; body: unknown }>, seen: Request[] = []) {
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(new Request(input, init));
    const r = replies.shift();
    if (!r) throw new Error('no reply');
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return new NansenTrading(new NansenHttp({ apiKey: 'k', fetch: f, clock }));
}

describe('NansenTrading', () => {
  it('builder fee status', async () => {
    const seen: Request[] = [];
    const t = trading(
      [
        {
          status: 200,
          body: {
            approved: false,
            max_fee_rate: 0,
            required_fee: 80,
            builder_address: '0x93053F1E7A5EFEDA532FE69CBBE43CBEC3A0F13F',
          },
        },
      ],
      seen,
    );
    const r = await t.builderFee(W);
    expect(seen[0]?.url).toContain(`/api/v1/perp/builder-fee?wallet_address=${W}`);
    expect(r).toMatchObject({
      ok: true,
      value: {
        approved: false,
        requiredFee: 80,
        builderAddress: '0x93053f1e7a5efeda532fe69cbbe43cbec3a0f13f',
      },
    });
  });

  it('meta lists assets', async () => {
    const r = await trading([
      {
        status: 200,
        body: { assets: [{ asset_id: 0, name: 'BTC', sz_decimals: 5, max_leverage: 40 }] },
      },
    ]).meta();
    expect(r).toMatchObject({
      ok: true,
      value: [{ assetId: 0, name: 'BTC', szDecimals: 5, maxLeverage: 40 }],
    });
  });

  it('prepares an order with snake_case body and returns the eip712 payload verbatim', async () => {
    const seen: Request[] = [];
    const t = trading([{ status: 200, body: prepared }], seen);
    const r = await t.prepareOrder({
      walletAddress: W,
      coin: 'ETH',
      isBuy: true,
      size: 0.0123,
      price: 1800,
      orderType: 'market',
      slippage: 0.03,
      stopLoss: 1700,
    });
    expect(await seen[0]?.json()).toEqual({
      wallet_address: W,
      coin: 'ETH',
      is_buy: true,
      size: 0.0123,
      price: 1800,
      order_type: 'market',
      reduce_only: false,
      tif: 'Gtc',
      slippage: 0.03,
      take_profit: null,
      stop_loss: 1700,
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.action).toEqual(prepared.action);
    expect(r.value.eip712.primaryType).toBe('Agent');
    expect(r.value.nonce).toBe(prepared.nonce);
  });

  it('execute sends the signature, never retries, and surfaces 422 rejections', async () => {
    const seen: Request[] = [];
    const t = trading(
      [{ status: 422, body: { message: 'Insufficient margin to place order.' } }],
      seen,
    );
    const r = await t.execute({
      action: prepared.action,
      nonce: prepared.nonce,
      signature: { r: '0x1', s: '0x2', v: 27 },
      vaultAddress: null,
    });
    expect(await seen[0]?.json()).toEqual({
      action: prepared.action,
      nonce: prepared.nonce,
      signature: { r: '0x1', s: '0x2', v: 27 },
      vault_address: null,
    });
    expect(r).toMatchObject({
      ok: false,
      status: 422,
      error: 'HTTP 422: Insufficient margin to place order.',
    });

    const t2 = trading([
      { status: 502, body: {} },
      { status: 200, body: {} },
    ]);
    expect(
      await t2.execute({
        action: {},
        nonce: 1,
        signature: { r: '0x1', s: '0x2', v: 28 },
        vaultAddress: null,
      }),
    ).toMatchObject({ ok: false, status: 502 });
  });

  it('execute maps statuses', async () => {
    const t = trading([
      {
        status: 200,
        body: {
          status: 'ok',
          response: {
            type: 'order',
            data: { statuses: [{ filled: { oid: 77, totalSz: '0.0123', avgPx: '1851' } }] },
          },
        },
      },
    ]);
    const r = await t.execute({
      action: {},
      nonce: 1,
      signature: { r: '0x1', s: '0x2', v: 28 },
      vaultAddress: null,
    });
    expect(r).toMatchObject({
      ok: true,
      value: { status: 'ok', statuses: [{ filled: { oid: 77 } }] },
    });
  });
});
