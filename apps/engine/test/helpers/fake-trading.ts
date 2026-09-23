import type { Address } from '@whale-street/core';
import type {
  ApiResult,
  BuilderFeeStatus,
  Eip712Payload,
  ExecuteResult,
  OrderRequest,
  PerpAsset,
  PreparedAction,
  Signature,
} from '@whale-street/nansen';
import type { TradingPort } from '../../src/ports';

export const NANSEN_BUILDER = '0x93053f1e7a5efeda532fe69cbbe43cbec3a0f13f';

/** The HL L1 "phantom agent" payload shape Nansen returns for every prepared action. */
export const agentEip712 = (seed: number): Eip712Payload => ({
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
  message: { source: 'a', connectionId: `0x${seed.toString(16).padStart(64, '0')}` },
});

/** A failed call as NansenHttp reports it: status null = timeout / network error. */
type Fail = { status: number | null; error: string };

/** Programmable TradingPort shaped like Nansen's /perp/* (prepare returns a normalTpsl bracket). */
export class FakeTrading implements TradingPort {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  assets: PerpAsset[] = [{ assetId: 159, name: 'HYPE', szDecimals: 2, maxLeverage: 10 }];
  prepareFail: Fail | null = null;
  executeFail: Fail | null = null;
  flipSide = false;
  /** Top-level `status` of a 2xx execute response (NansenTrading maps a missing one to 'unknown'). */
  executeStatus = 'ok';
  executeStatuses: unknown[] = [{ filled: { oid: 77, totalSz: '1.2', avgPx: '41.05' } }];
  private nonce = 1_790_000_000_000;

  private ok<T>(callId: string, value: T): Promise<ApiResult<T>> {
    return Promise.resolve({ ok: true, value, callId });
  }
  private no<T>(f: Fail): Promise<ApiResult<T>> {
    return Promise.resolve({
      ok: false,
      error: f.error,
      status: f.status,
      callId: 'nc_trade_fail',
    });
  }

  builderFee(wallet: Address) {
    this.calls.push({ method: 'builderFee', args: [wallet] });
    // Nansen units: fee rates in tenths of a basis point (80 = 8 bp = 0.08%).
    return this.ok<BuilderFeeStatus>('nc_bf', {
      approved: true,
      maxFeeRate: 80,
      requiredFee: 80,
      builderAddress: NANSEN_BUILDER,
    });
  }
  meta() {
    this.calls.push({ method: 'meta', args: [] });
    return this.ok('nc_meta', this.assets);
  }
  prepareLeverage(wallet: Address, coin: string, leverage: number, isCross?: boolean) {
    this.calls.push({ method: 'prepareLeverage', args: [wallet, coin, leverage, isCross] });
    if (this.prepareFail) return this.no<PreparedAction>(this.prepareFail);
    const n = ++this.nonce;
    return this.ok<PreparedAction>('nc_lev', {
      action: { type: 'updateLeverage', asset: 159, isCross: true, leverage },
      nonce: n,
      vaultAddress: null,
      eip712: agentEip712(n),
      size: null,
      price: null,
    });
  }
  prepareOrder(req: OrderRequest) {
    this.calls.push({ method: 'prepareOrder', args: [req] });
    if (this.prepareFail) return this.no<PreparedAction>(this.prepareFail);
    const n = ++this.nonce;
    const isBuy = this.flipSide ? !req.isBuy : req.isBuy;
    const limit = req.price * (isBuy ? 1 + (req.slippage ?? 0) : 1 - (req.slippage ?? 0));
    const size = Math.round(req.size * 100) / 100;
    return this.ok<PreparedAction>('nc_order', {
      action: {
        type: 'order',
        orders: [
          {
            a: 159,
            b: isBuy,
            p: limit.toFixed(3),
            s: size.toFixed(2),
            r: false,
            t: { limit: { tif: 'Ioc' } },
          },
          {
            a: 159,
            b: !isBuy,
            p: String(req.stopLoss),
            s: size.toFixed(2),
            r: true,
            t: { trigger: { isMarket: true, triggerPx: String(req.stopLoss), tpsl: 'sl' } },
          },
        ],
        grouping: 'normalTpsl',
        builder: { b: NANSEN_BUILDER, f: 80 },
      },
      nonce: n,
      vaultAddress: null,
      eip712: agentEip712(n),
      size,
      price: limit,
    });
  }
  execute(p: {
    action: Record<string, unknown>;
    nonce: number;
    signature: Signature;
    vaultAddress: string | null;
  }) {
    this.calls.push({ method: 'execute', args: [p] });
    if (this.executeFail) return this.no<ExecuteResult>(this.executeFail);
    const statuses = p.action.type === 'order' ? this.executeStatuses : [];
    return this.ok<ExecuteResult>('nc_exec', { status: this.executeStatus, statuses });
  }
}
