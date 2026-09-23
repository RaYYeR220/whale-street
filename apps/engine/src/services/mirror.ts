import { randomUUID } from 'node:crypto';
import {
  type Address,
  computeHpStrict,
  evaluateMirror,
  type MirrorContext,
  type MirrorOrder,
  type MirrorRefusal,
  type MirrorRequest,
  PARAMS,
  type Params,
} from '@whale-street/core';
import type { HlInfo } from '@whale-street/hl';
import {
  type ApiResult,
  type BuilderFeeStatus,
  type Eip712Payload,
  type ExecuteResult,
  isAddress,
  type PerpAsset,
  type Signature,
} from '@whale-street/nansen';
import {
  type Hex,
  hexToBigInt,
  numberToHex,
  recoverTypedDataAddress,
  serializeSignature,
  type TypedDataDomain,
} from 'viem';
import type { Clock } from '../clock';
import type { Config } from '../config';
import { DAY_MS, HOUR_MS } from '../dates';
import type { MirrorOrderRow, Repos } from '../db/repos';
import { explorerUrl } from '../events';
import type { Refresher } from '../ingest/refresh';
import type { Logger } from '../log';
import type { CompanyRuntime, MarketState } from '../market/state';
import type { TradingPort } from '../ports';
import type { MirrorKind, MirrorStatus } from '../types';

/** A prepared step must be signed and executed within this window (Nansen nonces go stale). */
export const STEP_TTL_MS = 60_000;
export const MARKET_SLIPPAGE = 0.01;
/** Highest builder fee accepted in a prepared order, in tenths of a basis point (80 = 0.08%). */
export const MAX_BUILDER_FEE = 80;
/** An UNKNOWN/SUBMITTED order is re-checked against Hyperliquid only once it is this old... */
export const RECONCILE_MIN_AGE_MS = 30_000;
/** ...and at most this often per player. */
export const RECONCILE_INTERVAL_MS = 15_000;
const META_TTL_MS = HOUR_MS;
/** Stop-loss trigger may differ from the policy price by this fraction (HL tick rounding). */
const STOP_TOLERANCE = 0.01;
/** Statuses that count toward the open-mirror and daily-notional caps. */
const OPEN_STATUSES: ReadonlySet<MirrorStatus> = new Set([
  'SUBMITTED',
  'FILLED',
  'RESTING',
  'UNKNOWN',
]);
/** Order statuses whose real outcome may still be learned from Hyperliquid. */
const RECONCILABLE: ReadonlySet<MirrorStatus> = new Set(['UNKNOWN', 'SUBMITTED']);
const REGION_MESSAGE = 'trading unavailable in this region';

export type MirrorErrorCode =
  | 'TRADING_UNAVAILABLE'
  | 'REGION_BLOCKED'
  | 'NO_WALLET'
  | 'NO_AGENT'
  | 'UNKNOWN_TICKER'
  | 'INVALID_ADDRESS'
  | 'PREPARE_FAILED'
  | 'ACTION_MISMATCH'
  | 'NOT_FOUND'
  | 'BAD_STATE'
  | 'EXPIRED'
  | 'BAD_SIGNATURE'
  | 'POLICY_CHANGED'
  | 'REJECTED'
  | 'UPSTREAM_FAILED';

export interface MirrorError {
  ok: false;
  status: number;
  code: MirrorErrorCode;
  message: string;
  refusals?: MirrorRefusal[];
}

export interface MirrorPrepareRequest extends MirrorRequest {
  ticker: string;
}

export interface MirrorStep {
  stepId: string;
  kind: MirrorKind;
  eip712: Eip712Payload;
}

export type PrepareResult =
  | { ok: true; groupId: string; refusals: MirrorRefusal[] }
  | { ok: true; groupId: string; order: MirrorOrder; steps: MirrorStep[] }
  | MirrorError;

export interface MirrorReceipt {
  stepId: string;
  kind: MirrorKind;
  /** UNKNOWN: the order may or may not have reached Hyperliquid (see `error`). */
  status: MirrorStatus;
  hlOid: number | null;
  avgPx: number | null;
  error: string | null;
  explorerUrl: string;
}

export interface MirrorOrderView {
  id: string;
  groupId: string;
  kind: MirrorKind;
  ticker: string;
  coin: string;
  status: MirrorStatus;
  notionalUsd: number;
  refusals: MirrorRefusal[] | null;
  hlOid: number | null;
  avgPx: number | null;
  error: string | null;
  createdAt: number;
  /** Hyperliquid explorer page of the wallet the order was placed for. */
  explorerUrl: string | null;
}

export interface MirrorService {
  available(): boolean;
  /** Whether the linked wallet already approved Nansen's builder fee (the browser signs approveBuilderFee only if not). */
  builderStatus(playerId: string): Promise<{ ok: true; status: BuilderFeeStatus } | MirrorError>;
  registerAgent(
    playerId: string,
    masterAddress: string,
    agentAddress: string,
  ): { ok: true } | MirrorError;
  prepare(playerId: string, req: MirrorPrepareRequest): Promise<PrepareResult>;
  execute(
    playerId: string,
    stepId: string,
    signature: Signature,
  ): Promise<{ ok: true; receipt: MirrorReceipt } | MirrorError>;
  /**
   * Re-checks the player's UNKNOWN/SUBMITTED orders against the master wallet's Hyperliquid
   * position and upgrades them to FILLED when the position grew by the order size since prepare.
   * Never downgrades: an order without evidence stays UNKNOWN (and keeps counting toward caps).
   */
  reconcile(playerId: string): Promise<void>;
  orders(playerId: string): MirrorOrderView[];
}

export interface MirrorDeps {
  config: Config;
  trading: TradingPort | null;
  state: MarketState;
  repos: Repos;
  refresher: Refresher;
  clock: Clock;
  log: Logger;
  /** Hyperliquid reads used to reconcile non-definitive outcomes (optional). */
  info?: HlInfo | null;
  params?: Params;
}

/** The order row's request_json: the player's request plus the HL position seen at prepare. */
interface StoredRequest extends MirrorPrepareRequest {
  /** Signed size of the master's position in the coin at prepare (null if unknown). */
  hlBaselineSzi?: number | null;
}

const err = (
  status: number,
  code: MirrorErrorCode,
  message: string,
  refusals?: MirrorRefusal[],
): MirrorError => ({
  ok: false,
  status,
  code,
  message,
  ...(refusals ? { refusals } : {}),
});

const regionBlocked = () => err(451, 'REGION_BLOCKED', REGION_MESSAGE);

/**
 * Only a 4xx is a definitive "not executed" answer (HL rejections arrive as 422). Timeouts and
 * network errors (status null), 408, 5xx and a 2xx whose body could not be read may all have
 * reached Hyperliquid.
 */
const isDefinitiveRejection = (status: number | null): boolean =>
  status !== null && status >= 400 && status < 500 && status !== 408;

type WireOrder = { a?: unknown; b?: unknown; p?: unknown; s?: unknown; r?: unknown; t?: unknown };
type WireTrigger = { triggerPx?: unknown; tpsl?: unknown };

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const triggerOf = (o: WireOrder): WireTrigger | null =>
  asRecord(asRecord(o.t)?.trigger) as WireTrigger | null;

/** Strict numeric read of an HL wire value (number or numeric string); anything else → null. */
const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/**
 * Re-checks Nansen's prepared order action against the policy decision: asset, side, size, price,
 * reduce-only flag, a reduce-only stop-loss trigger leg at the policy stop price, no extra opening
 * legs, and Nansen's builder code with a fee at most MAX_BUILDER_FEE.
 */
export function validateOrderAction(
  action: Record<string, unknown>,
  order: MirrorOrder,
  asset: PerpAsset,
): string | null {
  if (action.type !== 'order') return 'not an order action';
  const orders = Array.isArray(action.orders) ? (action.orders as WireOrder[]) : [];
  const main = orders[0];
  if (!main) return 'no order legs';
  if (main.a !== asset.assetId) return 'wrong asset';
  if (main.b !== order.isBuy) return 'wrong side';
  if (main.r !== false) return 'entry leg must not be reduce-only';
  if (!asRecord(asRecord(main.t)?.limit)) return 'entry leg must be a limit order';
  const size = num(main.s) ?? Number.NaN;
  const tolerance = Math.max(order.size * 0.01, 10 ** -asset.szDecimals);
  if (!(size > 0 && Math.abs(size - order.size) <= tolerance))
    return `size ${String(main.s)} differs from ${order.size}`;
  const px = num(main.p) ?? Number.NaN;
  if (!(Math.abs(px / order.markPx - 1) <= MARKET_SLIPPAGE + 0.002))
    return `price ${String(main.p)} is too far from mark`;
  const exits = orders.slice(1);
  if (exits.some((o) => o.a !== asset.assetId || o.b !== !order.isBuy || o.r !== true))
    return 'unexpected extra order leg (only reduce-only exits are allowed)';
  const stop = exits.find((o) => triggerOf(o)?.tpsl === 'sl');
  if (!stop) return 'missing reduce-only stop-loss leg';
  const triggerPx = num(triggerOf(stop)?.triggerPx) ?? Number.NaN;
  // Tick rounding only: never more than half-way to the mark, so the stop stays on the right side.
  const stopTolerance = Math.min(
    order.stopLossPx * STOP_TOLERANCE,
    Math.abs(order.markPx - order.stopLossPx) / 2,
  );
  if (!(Math.abs(triggerPx - order.stopLossPx) <= stopTolerance))
    return `stop-loss trigger ${String(triggerOf(stop)?.triggerPx)} differs from ${order.stopLossPx}`;
  if (!(Math.abs((num(stop.s) ?? Number.NaN) - size) <= tolerance))
    return `stop-loss size ${String(stop.s)} differs from ${size}`;
  const builder = asRecord(action.builder);
  if (!builder || typeof builder.b !== 'string') return 'missing builder code';
  if (typeof builder.f !== 'number' || !(builder.f >= 0 && builder.f <= MAX_BUILDER_FEE))
    return `builder fee ${String(builder.f)} exceeds ${MAX_BUILDER_FEE}`;
  return null;
}

/** Re-checks Nansen's prepared updateLeverage action: asset and leverage must match the decision. */
export function validateLeverageAction(
  action: Record<string, unknown>,
  order: MirrorOrder,
  asset: PerpAsset,
): string | null {
  if (action.type !== 'updateLeverage') return 'not a leverage action';
  if (action.asset !== asset.assetId) return 'wrong asset';
  if (action.leverage !== order.leverage)
    return `leverage ${String(action.leverage)} differs from ${order.leverage}`;
  return null;
}

/** Canonical {r, s, v} (32-byte r/s, v 27|28) plus the serialized form used for recovery. */
function canonicalSignature(sig: Signature): { wire: Signature; hex: Hex } {
  const v = BigInt(sig.v);
  const yParity = v === 0n || v === 1n ? Number(v) : v === 27n || v === 28n ? Number(v - 27n) : -1;
  if (yParity !== 0 && yParity !== 1) throw new Error('invalid v');
  const r = numberToHex(hexToBigInt(sig.r as Hex), { size: 32 });
  const s = numberToHex(hexToBigInt(sig.s as Hex), { size: 32 });
  return { wire: { r, s, v: 27 + yParity }, hex: serializeSignature({ r, s, yParity }) };
}

export function createMirrorService(d: MirrorDeps): MirrorService {
  const params = d.params ?? PARAMS;
  const info = d.info ?? null;
  const secret = d.config.nansenApiKey;
  let meta: { at: number; assets: Map<string, PerpAsset> } | null = null;
  const lastReconcile = new Map<string, number>();

  const available = () => d.config.mode === 'live' && d.trading !== null;

  /** Upstream text is stored and returned to players: make sure the API key can never ride along. */
  const redact = (s: string): string =>
    secret && secret.length > 0 ? s.split(secret).join('[redacted]') : s;

  const assets = async (): Promise<Map<string, PerpAsset> | MirrorError> => {
    const now = d.clock.now();
    if (meta && now - meta.at < META_TTL_MS) return meta.assets;
    const trading = d.trading;
    if (!trading) return err(503, 'TRADING_UNAVAILABLE', 'mirror trading is disabled');
    const r = await trading.meta();
    if (!r.ok)
      return r.status === 451
        ? regionBlocked()
        : err(502, 'UPSTREAM_FAILED', `could not load Nansen perp markets: ${redact(r.error)}`);
    meta = { at: now, assets: new Map(r.value.map((a) => [a.name, a])) };
    return meta.assets;
  };

  /** Signed size of `wallet`'s position in `coin` on Hyperliquid (0 = flat, null = unknown). */
  const hlSize = async (wallet: Address, coin: string): Promise<number | null> => {
    if (!info) return null;
    const r = await info.clearinghouse(wallet);
    if (!r.ok) return null;
    return r.value.positions.find((p) => p.coin === coin)?.size ?? 0;
  };

  const context = (
    rt: CompanyRuntime,
    coin: string,
    playerId: string,
    supported: boolean,
  ): MirrorContext => {
    const now = d.clock.now();
    const recent = d.repos.mirrorOrders.ordersSince(playerId, now - DAY_MS);
    const live = recent.filter((o) => OPEN_STATUSES.has(o.status));
    return {
      companyStatus: rt.status,
      snapshotAgeMs: now - rt.lastSnapshotAt,
      coinSupported: supported,
      traderPosition: rt.nav.snapshot.positions.find((p) => p.coin === coin) ?? null,
      mark: d.state.marks[coin] ?? null,
      hp: computeHpStrict(rt.nav.snapshot.positions, d.state.marks) ?? Number.NaN,
      playerOpenMirrors: live.length,
      playerDailyNotionalUsd: live.reduce((s, o) => s + o.notionalUsd, 0),
    };
  };

  const row = (o: {
    playerId: string;
    rt: CompanyRuntime;
    coin: string;
    kind: MirrorKind;
    stepIndex: number;
    groupId: string;
    status: MirrorStatus;
    notionalUsd: number;
    request: Record<string, unknown>;
  }): MirrorOrderRow => {
    const now = d.clock.now();
    return {
      id: `ms_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      playerId: o.playerId,
      companyId: o.rt.id,
      coin: o.coin,
      kind: o.kind,
      stepIndex: o.stepIndex,
      groupId: o.groupId,
      status: o.status,
      notionalUsd: o.notionalUsd,
      refusals: null,
      request: o.request,
      action: null,
      eip712: null,
      nonce: null,
      vaultAddress: null,
      hlOid: null,
      avgPx: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
  };

  const view = (o: MirrorOrderRow, master: string | null): MirrorOrderView => ({
    id: o.id,
    groupId: o.groupId,
    kind: o.kind,
    ticker: d.state.get(o.companyId)?.ticker ?? '?',
    coin: o.coin,
    status: o.status,
    notionalUsd: o.notionalUsd,
    refusals: o.refusals,
    hlOid: o.hlOid,
    avgPx: o.avgPx,
    error: o.error,
    createdAt: o.createdAt,
    explorerUrl: master ? explorerUrl(master) : null,
  });

  return {
    available,

    async builderStatus(playerId) {
      const trading = d.trading;
      if (!available() || !trading)
        return err(503, 'TRADING_UNAVAILABLE', 'mirror trading is disabled in this mode');
      const wallet = d.repos.players.get(playerId)?.walletAddress;
      if (!wallet) return err(403, 'NO_WALLET', 'link a wallet first');
      const r = await trading.builderFee(wallet as Address);
      if (!r.ok)
        return r.status === 451 ? regionBlocked() : err(502, 'UPSTREAM_FAILED', redact(r.error));
      return { ok: true, status: r.value };
    },

    registerAgent(playerId, masterAddress, agentAddress) {
      if (!available())
        return err(503, 'TRADING_UNAVAILABLE', 'mirror trading is disabled in this mode');
      if (!isAddress(masterAddress) || !isAddress(agentAddress))
        return err(400, 'INVALID_ADDRESS', 'invalid address');
      const player = d.repos.players.get(playerId);
      if (!player?.walletAddress || player.walletAddress !== masterAddress.toLowerCase()) {
        return err(403, 'NO_WALLET', 'link this wallet to your player first');
      }
      d.repos.agentKeys.upsert({
        playerId,
        masterAddress: masterAddress.toLowerCase(),
        agentAddress: agentAddress.toLowerCase(),
        registeredAt: d.clock.now(),
      });
      return { ok: true };
    },

    async prepare(playerId, req) {
      const trading = d.trading;
      if (!available() || !trading)
        return err(503, 'TRADING_UNAVAILABLE', 'mirror trading is disabled in this mode');
      const agent = d.repos.agentKeys.get(playerId);
      if (!agent) return err(409, 'NO_AGENT', 'approve a Whale Street agent key first');
      const rt = d.state.byTicker(req.ticker);
      if (!rt) return err(404, 'UNKNOWN_TICKER', 'no such ticker');
      const master = agent.masterAddress as Address;

      await d.refresher.refresh(rt.id, 'mirror');
      const table = await assets();
      if (!(table instanceof Map)) return table;
      const asset = table.get(req.coin) ?? null;
      const decision = evaluateMirror(
        {
          coin: req.coin,
          notionalUsd: req.notionalUsd,
          leverage: req.leverage,
          stopLossPct: req.stopLossPct,
        },
        context(rt, req.coin, playerId, asset !== null),
        params,
      );
      const groupId = `mg_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const request: StoredRequest = { ...req };
      if (!decision.allow || !asset) {
        const refusals = decision.allow ? [] : decision.refusals;
        const r = row({
          playerId,
          rt,
          coin: req.coin,
          kind: 'order',
          stepIndex: 1,
          groupId,
          status: 'REFUSED',
          notionalUsd: req.notionalUsd,
          request: { ...request },
        });
        d.repos.mirrorOrders.insert({ ...r, refusals });
        return { ok: true, groupId, refusals };
      }
      const order = decision.order;

      /** Every failed attempt is logged as a REJECTED order row. */
      const fail = (code: MirrorErrorCode, status: number, message: string) => {
        const r = row({
          playerId,
          rt,
          coin: req.coin,
          kind: 'order',
          stepIndex: 1,
          groupId,
          status: 'REJECTED',
          notionalUsd: req.notionalUsd,
          request: { ...request },
        });
        d.repos.mirrorOrders.insert({ ...r, error: message });
        return err(status, code, message);
      };

      const lev = await trading.prepareLeverage(master, req.coin, order.leverage);
      if (!lev.ok)
        return lev.status === 451
          ? fail('REGION_BLOCKED', 451, REGION_MESSAGE)
          : fail('PREPARE_FAILED', 502, `leverage: ${redact(lev.error)}`);
      const levMismatch = validateLeverageAction(lev.value.action, order, asset);
      if (levMismatch)
        return fail('ACTION_MISMATCH', 502, `prepared leverage rejected: ${levMismatch}`);
      const prepared = await trading.prepareOrder({
        walletAddress: master,
        coin: req.coin,
        isBuy: order.isBuy,
        size: order.size,
        price: order.markPx,
        orderType: 'market',
        slippage: MARKET_SLIPPAGE,
        stopLoss: order.stopLossPx,
      });
      if (!prepared.ok)
        return prepared.status === 451
          ? fail('REGION_BLOCKED', 451, REGION_MESSAGE)
          : fail('PREPARE_FAILED', 502, `order: ${redact(prepared.error)}`);
      const mismatch = validateOrderAction(prepared.value.action, order, asset);
      if (mismatch) return fail('ACTION_MISMATCH', 502, `prepared order rejected: ${mismatch}`);

      // Baseline for reconciling a non-definitive execute later (null if HL is unreachable).
      const baseline = await hlSize(master, req.coin);
      const levRow: MirrorOrderRow = {
        ...row({
          playerId,
          rt,
          coin: req.coin,
          kind: 'leverage',
          stepIndex: 0,
          groupId,
          status: 'PREPARED',
          notionalUsd: 0,
          request: { ...request },
        }),
        action: lev.value.action,
        eip712: lev.value.eip712,
        nonce: lev.value.nonce,
        vaultAddress: lev.value.vaultAddress,
      };
      const orderRow: MirrorOrderRow = {
        ...row({
          playerId,
          rt,
          coin: req.coin,
          kind: 'order',
          stepIndex: 1,
          groupId,
          status: 'PREPARED',
          notionalUsd: order.notionalUsd,
          request: { ...request, hlBaselineSzi: baseline },
        }),
        action: prepared.value.action,
        eip712: prepared.value.eip712,
        nonce: prepared.value.nonce,
        vaultAddress: prepared.value.vaultAddress,
      };
      d.repos.tx(() => {
        d.repos.mirrorOrders.insert(levRow);
        d.repos.mirrorOrders.insert(orderRow);
      });
      return {
        ok: true,
        groupId,
        order,
        steps: [
          { stepId: levRow.id, kind: 'leverage', eip712: lev.value.eip712 },
          { stepId: orderRow.id, kind: 'order', eip712: prepared.value.eip712 },
        ],
      };
    },

    async execute(playerId, stepId, signature) {
      const trading = d.trading;
      if (!available() || !trading)
        return err(503, 'TRADING_UNAVAILABLE', 'mirror trading is disabled in this mode');
      const pre = d.repos.mirrorOrders.get(stepId);
      if (!pre || pre.playerId !== playerId) return err(404, 'NOT_FOUND', 'no such step');
      if (pre.status !== 'PREPARED' || !pre.action || !pre.eip712 || pre.nonce === null) {
        return err(409, 'BAD_STATE', `step is ${pre.status.toLowerCase()}`);
      }
      const agent = d.repos.agentKeys.get(playerId);
      if (!agent) return err(409, 'NO_AGENT', 'approve a Whale Street agent key first');

      // The signature must recover (over the EIP-712 payload stored at prepare) to the approved agent.
      let wire: Signature;
      let signer: string;
      try {
        const sig = canonicalSignature(signature);
        wire = sig.wire;
        signer = await recoverTypedDataAddress({
          domain: pre.eip712.domain as TypedDataDomain,
          types: pre.eip712.types,
          primaryType: pre.eip712.primaryType,
          message: pre.eip712.message,
          signature: sig.hex,
        });
      } catch {
        return err(401, 'BAD_SIGNATURE', 'signature could not be verified');
      }
      if (signer.toLowerCase() !== agent.agentAddress)
        return err(401, 'BAD_SIGNATURE', 'not signed by your approved agent key');

      // Critical section: no await from here until the row is SUBMITTED, so concurrent executes
      // can neither run the same step twice nor both slip under the open/daily caps.
      const step = d.repos.mirrorOrders.get(stepId);
      if (step?.status !== 'PREPARED' || !step.action || step.nonce === null)
        return err(409, 'BAD_STATE', `step is ${(step?.status ?? 'gone').toLowerCase()}`);
      if (d.repos.agentKeys.get(playerId)?.agentAddress !== agent.agentAddress)
        return err(401, 'BAD_SIGNATURE', 'agent key changed; sign again');
      const now = d.clock.now();
      if (now - step.createdAt > STEP_TTL_MS) {
        d.repos.mirrorOrders.update(step.id, {
          status: 'REJECTED',
          error: 'expired before signing',
          updatedAt: now,
        });
        return err(410, 'EXPIRED', 'prepared step expired; prepare again');
      }
      if (step.stepIndex > 0) {
        const prev = d.repos.mirrorOrders
          .byGroup(step.groupId)
          .find((o) => o.stepIndex === step.stepIndex - 1);
        if (prev?.status !== 'FILLED')
          return err(409, 'BAD_STATE', 'execute the leverage step first');
      }
      if (step.kind === 'order') {
        const rt = d.state.get(step.companyId);
        const req = step.request as unknown as StoredRequest;
        if (!rt) return err(409, 'POLICY_CHANGED', 'company no longer listed');
        const again = evaluateMirror(
          {
            coin: req.coin,
            notionalUsd: req.notionalUsd,
            leverage: req.leverage,
            stopLossPct: req.stopLossPct,
          },
          context(rt, step.coin, playerId, true),
          params,
        );
        if (!again.allow) {
          d.repos.mirrorOrders.update(step.id, {
            status: 'REJECTED',
            refusals: again.refusals,
            error: 'policy changed',
            updatedAt: now,
          });
          return err(
            409,
            'POLICY_CHANGED',
            'the trade no longer passes the mirror policy',
            again.refusals,
          );
        }
      }
      // From here on the attempt counts toward the caps (SUBMITTED ∈ OPEN_STATUSES).
      d.repos.mirrorOrders.update(step.id, { status: 'SUBMITTED', updatedAt: now });
      const action = step.action;
      const nonce = step.nonce;

      const finish = (status: MirrorStatus, patch: Partial<MirrorOrderRow>): MirrorReceipt => {
        d.repos.mirrorOrders.update(step.id, { status, ...patch, updatedAt: d.clock.now() });
        return {
          stepId: step.id,
          kind: step.kind,
          status,
          hlOid: patch.hlOid ?? null,
          avgPx: patch.avgPx ?? null,
          error: patch.error ?? null,
          explorerUrl: explorerUrl(agent.masterAddress),
        };
      };
      const rejected = (message: string): MirrorError => {
        finish('REJECTED', { error: message });
        return err(422, 'REJECTED', message);
      };
      /** Not definitive: the order may have reached Hyperliquid. Never recorded as REJECTED. */
      const unknown = (detail: string): { ok: true; receipt: MirrorReceipt } => {
        d.log.warn('mirror execute outcome unknown', { stepId: step.id, kind: step.kind, detail });
        return {
          ok: true,
          receipt: finish('UNKNOWN', { error: `result unknown — check Hyperliquid (${detail})` }),
        };
      };

      let r: ApiResult<ExecuteResult>;
      try {
        r = await trading.execute({
          action,
          nonce,
          signature: wire,
          vaultAddress: step.vaultAddress,
        });
      } catch (e) {
        return unknown(redact(`exception: ${e instanceof Error ? e.message : String(e)}`));
      }
      if (!r.ok) {
        if (r.status === 451) {
          finish('REJECTED', { error: REGION_MESSAGE });
          return regionBlocked();
        }
        return isDefinitiveRejection(r.status)
          ? rejected(redact(r.error))
          : unknown(redact(r.error));
      }

      // A 2xx is never a failure; only an explicit HL error on the entry leg is a rejection.
      const statuses = r.value.statuses;
      const entry = asRecord(statuses[0]);
      if (entry && entry.error !== undefined && entry.error !== null)
        return rejected(redact(String(entry.error)));
      const stopLeg = step.kind === 'order' ? asRecord(statuses[1]) : null;
      const stopWarning =
        stopLeg && stopLeg.error !== undefined && stopLeg.error !== null
          ? `stop-loss not placed: ${redact(String(stopLeg.error))} — set a stop on Hyperliquid`
          : null;
      const filled = asRecord(entry?.filled);
      if (filled) {
        return {
          ok: true,
          receipt: finish('FILLED', {
            hlOid: num(filled.oid),
            avgPx: num(filled.avgPx),
            error: stopWarning,
          }),
        };
      }
      const resting = asRecord(entry?.resting);
      if (resting) {
        return {
          ok: true,
          receipt: finish('RESTING', { hlOid: num(resting.oid), error: stopWarning }),
        };
      }
      if (r.value.status === 'ok')
        return { ok: true, receipt: finish(step.kind === 'leverage' ? 'FILLED' : 'SUBMITTED', {}) };
      return unknown(`unexpected execute status "${redact(r.value.status)}"`);
    },

    async reconcile(playerId) {
      if (!info) return;
      const now = d.clock.now();
      const recent = d.repos.mirrorOrders.ordersSince(playerId, now - DAY_MS);
      const candidates = recent.filter(
        (o) => RECONCILABLE.has(o.status) && now - o.updatedAt >= RECONCILE_MIN_AGE_MS,
      );
      if (candidates.length === 0) return;
      if (now - (lastReconcile.get(playerId) ?? Number.NEGATIVE_INFINITY) < RECONCILE_INTERVAL_MS)
        return;
      lastReconcile.set(playerId, now);
      const master = d.repos.agentKeys.get(playerId)?.masterAddress;
      if (!master) return;
      const st = await info.clearinghouse(master as Address);
      if (!st.ok) {
        d.log.warn('mirror reconcile: hyperliquid read failed', { error: st.error });
        return;
      }
      for (const o of candidates) {
        // Another order on this coin that executed after o's baseline could explain the same
        // position change (e.g. a retry that filled): attribution is ambiguous, keep it UNKNOWN.
        const ambiguous = recent.some(
          (x) =>
            x.id !== o.id &&
            x.coin === o.coin &&
            OPEN_STATUSES.has(x.status) &&
            x.updatedAt >= o.createdAt,
        );
        if (ambiguous) continue;
        const baseline = (o.request as unknown as StoredRequest).hlBaselineSzi;
        const legs = o.action?.orders;
        const leg = Array.isArray(legs) ? ((legs[0] as WireOrder | undefined) ?? null) : null;
        const size = num(leg?.s);
        if (typeof baseline !== 'number' || !leg || typeof leg.b !== 'boolean' || size === null)
          continue;
        const current = st.value.positions.find((p) => p.coin === o.coin)?.size ?? 0;
        const grown = leg.b ? current - baseline : baseline - current;
        if (!(grown >= size * 0.5)) continue;
        const latest = d.repos.mirrorOrders.get(o.id);
        if (!latest || !RECONCILABLE.has(latest.status)) continue;
        d.repos.mirrorOrders.update(o.id, {
          status: 'FILLED',
          error: 'reconciled from the Hyperliquid position; fill price unknown',
          updatedAt: d.clock.now(),
        });
      }
    },

    orders(playerId) {
      const master = d.repos.agentKeys.get(playerId)?.masterAddress ?? null;
      return d.repos.mirrorOrders.byPlayer(playerId, 50).map((o) => view(o, master));
    },
  };
}
