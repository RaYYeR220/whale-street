import { randomUUID } from 'node:crypto';
import {
  type Address,
  computeHpStrict,
  evaluateMirror,
  type MirrorContext,
  type MirrorOrder,
  type MirrorRequest,
  PARAMS,
  type Params,
} from '@whale-street/core';
import type { HlInfo, HlPerpState } from '@whale-street/hl';
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
import { RateGate } from '../api/rate';
import type { Clock } from '../clock';
import type { Config } from '../config';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../dates';
import type { AgentKeyRow, MirrorOrderRow, Repos } from '../db/repos';
import { explorerUrl } from '../events';
import type { Refresher } from '../ingest/refresh';
import type { Logger } from '../log';
import { MARKS_DELAY_MS } from '../market/loop';
import type { CompanyRuntime, MarketState } from '../market/state';
import type { TradingPort } from '../ports';
import type { MirrorKind, MirrorReason, MirrorStatus } from '../types';

/** A prepared step must be signed and executed within this window (Nansen nonces go stale). */
export const STEP_TTL_MS = 60_000;
export const MARKET_SLIPPAGE = 0.01;
/** Highest builder fee accepted in a prepared order, in tenths of a basis point (80 = 0.08%). */
export const MAX_BUILDER_FEE = 80;
/** An UNKNOWN/SUBMITTED order is re-checked against Hyperliquid only once it is this old... */
export const RECONCILE_MIN_AGE_MS = 30_000;
/** ...and at most this often per player. */
export const RECONCILE_INTERVAL_MS = 15_000;
/**
 * A placed order stops counting as open once the master wallet shows no position on its coin and
 * the order is older than this (time for a fill to show up on Hyperliquid).
 */
export const CLOSE_GRACE_MS = 5 * MINUTE_MS;
const META_TTL_MS = HOUR_MS;
/** A wallet's builder-fee status is re-read from Nansen at most this often (failures: 10 s). */
export const BUILDER_STATUS_TTL_MS = MINUTE_MS;
const BUILDER_STATUS_FAILURE_TTL_MS = 10_000;
/** Stop-loss trigger may differ from the policy price by this fraction (HL tick rounding). */
const STOP_TOLERANCE = 0.01;
/** size × limit price may exceed maxNotionalUsd by the market slippage plus this rounding margin. */
const NOTIONAL_ROUNDING = 0.005;
/** Statuses that count as an open mirror (unless the wallet is flat on the coin, see openMirrors). */
const OPEN_STATUS_LIST: readonly MirrorStatus[] = ['SUBMITTED', 'FILLED', 'RESTING', 'UNKNOWN'];
/** Attempts that reached (or may have reached) Hyperliquid: their notional counts toward the daily cap. */
const PLACED_STATUSES: ReadonlySet<MirrorStatus> = new Set([...OPEN_STATUS_LIST, 'CLOSED']);
/** Order statuses whose real outcome may still be learned from Hyperliquid. */
const RECONCILABLE: ReadonlySet<MirrorStatus> = new Set(['UNKNOWN', 'SUBMITTED']);
const REGION_MESSAGE = 'trading unavailable in this region';
const TRADING_UNAVAILABLE: MirrorReason = { code: 'TRADING_UNAVAILABLE', message: REGION_MESSAGE };
/** At the credit floor the fresh Nansen snapshot a mirror needs is not fetched: refuse visibly. */
const CREDIT_FLOOR_REFUSAL: MirrorReason = {
  code: 'CREDIT_FLOOR',
  message:
    'Nansen credits are nearly used up, so the trader data cannot be refreshed: mirror orders are paused',
};

export type MirrorErrorCode =
  | 'TRADING_UNAVAILABLE'
  | 'REGION_BLOCKED'
  | 'NO_WALLET'
  | 'WALLET_IN_USE'
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
  refusals?: MirrorReason[];
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
  | { ok: true; groupId: string; refusals: MirrorReason[] }
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
  refusals: MirrorReason[] | null;
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
  refusals?: MirrorReason[],
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
type WireTrigger = { triggerPx?: unknown; tpsl?: unknown; isMarket?: unknown };

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const triggerOf = (o: WireOrder): WireTrigger | null =>
  asRecord(asRecord(o.t)?.trigger) as WireTrigger | null;

/** Rounds a size DOWN to `decimals` places (the epsilon absorbs binary noise like 2.4299999…). */
const floorTo = (x: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.floor(x * f + 1e-9) / f;
};

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
 * The notional an order action really sends: its entry leg's size × limit price (null when the
 * leg is unreadable; a validated action always has one).
 */
export function entryNotional(action: Record<string, unknown>): number | null {
  const main = Array.isArray(action.orders) ? asRecord(action.orders[0]) : null;
  const size = num(main?.s);
  const px = num(main?.p);
  return size === null || px === null ? null : size * px;
}

/** What a prepared order is checked against besides the policy decision. */
export interface OrderActionLimits {
  /** Nansen's builder address (from /perp/builder-fee); the order's builder code must be it. */
  builderAddress: string;
  /** params.mirror.maxNotionalUsd: size × limit price may exceed it only by slippage + rounding. */
  maxNotionalUsd: number;
}

/**
 * Re-checks Nansen's prepared order action against the policy decision, failing closed on any
 * other shape: a `normalTpsl` bracket with no vault; an IOC limit entry (how market orders are
 * sent) on the right asset and side, with the policy size, a price within slippage of the mark and
 * a notional within the cap; only reduce-only exits, including a market stop-loss trigger at the
 * policy stop price; and Nansen's own builder code with a fee at most MAX_BUILDER_FEE.
 */
export function validateOrderAction(
  action: Record<string, unknown>,
  order: MirrorOrder,
  asset: PerpAsset,
  limits: OrderActionLimits,
): string | null {
  if (action.type !== 'order') return 'not an order action';
  if (action.grouping !== 'normalTpsl')
    return `grouping ${String(action.grouping)} is not normalTpsl`;
  if (action.vaultAddress !== undefined && action.vaultAddress !== null)
    return 'order must not target a vault';
  const legs = Array.isArray(action.orders) ? action.orders.map(asRecord) : [];
  if (legs.length === 0) return 'no order legs';
  if (legs.some((l) => l === null)) return 'malformed order leg';
  const [main, ...exits] = legs as WireOrder[];
  if (!main) return 'no order legs';
  if (main.a !== asset.assetId) return 'wrong asset';
  if (main.b !== order.isBuy) return 'wrong side';
  if (main.r !== false) return 'entry leg must not be reduce-only';
  if (asRecord(asRecord(main.t)?.limit)?.tif !== 'Ioc')
    return 'entry leg must be an Ioc limit order (a market order)';
  const size = num(main.s) ?? Number.NaN;
  const tolerance = Math.max(order.size * 0.01, 10 ** -asset.szDecimals);
  if (!(size > 0 && Math.abs(size - order.size) <= tolerance))
    return `size ${String(main.s)} differs from ${order.size}`;
  const px = num(main.p) ?? Number.NaN;
  if (!(Math.abs(px / order.markPx - 1) <= MARKET_SLIPPAGE + 0.002))
    return `price ${String(main.p)} is too far from mark`;
  const maxNotional = limits.maxNotionalUsd * (1 + MARKET_SLIPPAGE + NOTIONAL_ROUNDING);
  if (!(size * px <= maxNotional))
    return `notional $${(size * px).toFixed(2)} exceeds $${maxNotional.toFixed(2)}`;
  if (exits.some((o) => o.a !== asset.assetId || o.b !== !order.isBuy || o.r !== true))
    return 'unexpected extra order leg (only reduce-only exits are allowed)';
  const stop = exits.find((o) => triggerOf(o)?.tpsl === 'sl');
  if (!stop) return 'missing reduce-only stop-loss leg';
  if (triggerOf(stop)?.isMarket !== true) return 'stop-loss leg must be a market trigger';
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
  if (builder.b.toLowerCase() !== limits.builderAddress.toLowerCase())
    return `builder ${builder.b} is not Nansen's builder ${limits.builderAddress}`;
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
  let builder: { at: number; address: string } | null = null;
  /** One Hyperliquid reconcile read per player per interval; idle players are swept out. */
  const reconcileGate = new RateGate(1, RECONCILE_INTERVAL_MS, () => d.clock.now());
  /** Builder-fee status per wallet (lowercase): the status route must not call Nansen per request. */
  const builderStatuses = new Map<
    string,
    { until: number; result: { ok: true; status: BuilderFeeStatus } | MirrorError }
  >();

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

  /** Nansen's builder address (global; cached like meta), from the builder-fee endpoint. */
  const builderAddress = async (wallet: Address): Promise<string | MirrorError> => {
    const now = d.clock.now();
    if (builder && now - builder.at < META_TTL_MS) return builder.address;
    const trading = d.trading;
    if (!trading) return err(503, 'TRADING_UNAVAILABLE', 'mirror trading is disabled');
    const r = await trading.builderFee(wallet);
    if (!r.ok)
      return r.status === 451
        ? regionBlocked()
        : err(502, 'UPSTREAM_FAILED', `could not load the Nansen builder: ${redact(r.error)}`);
    builder = { at: now, address: r.value.builderAddress.toLowerCase() };
    return builder.address;
  };

  /** The master wallet's Hyperliquid positions; null when they could not be read. */
  const readHl = async (wallet: Address): Promise<HlPerpState | null> => {
    if (!info) return null;
    try {
      const r = await info.clearinghouse(wallet);
      if (r.ok) return r.value;
      d.log.warn('mirror: hyperliquid positions unavailable', { error: r.error });
    } catch (e) {
      d.log.warn('mirror: hyperliquid positions unavailable', { error: String(e) });
    }
    return null;
  };

  /**
   * Open mirrors of a master wallet, of any age. An order stops counting only when the HL read
   * succeeded, the wallet has no position on the order's coin and the order is older than
   * CLOSE_GRACE_MS; a FILLED one is then persisted as CLOSED (UNKNOWN/SUBMITTED keep their
   * truthful status). Without a successful read (hl === null) every order counts: fail closed.
   */
  const openMirrors = (master: string, hl: HlPerpState | null, now: number): number => {
    let open = 0;
    for (const o of d.repos.mirrorOrders.ordersByMasterIn(master, OPEN_STATUS_LIST)) {
      const settled =
        hl !== null &&
        now - o.createdAt > CLOSE_GRACE_MS &&
        !hl.positions.some((p) => p.coin === o.coin);
      if (!settled) open++;
      else if (o.status === 'FILLED')
        d.repos.mirrorOrders.update(o.id, { status: 'CLOSED', updatedAt: now });
    }
    return open;
  };

  /** The player's agent key, but only while the player's linked wallet is still its master. */
  const boundAgent = (playerId: string): AgentKeyRow | MirrorError => {
    const agent = d.repos.agentKeys.get(playerId);
    if (!agent) return err(409, 'NO_AGENT', 'approve a Whale Street agent key first');
    const wallet = d.repos.players.get(playerId)?.walletAddress?.toLowerCase();
    if (!wallet || wallet !== agent.masterAddress.toLowerCase())
      return err(403, 'NO_WALLET', 'your linked wallet changed; approve an agent key for it first');
    return agent;
  };

  /**
   * Caps are counted per master wallet (the real-money identity), whichever player placed them.
   * Marks older than MARKS_DELAY_MS (or no mark for the coin) count as no mark at all: the policy
   * then refuses with NO_MARK and an unavailable health, never gating on a stale price.
   */
  const context = (
    rt: CompanyRuntime,
    coin: string,
    master: string,
    supported: boolean,
    hl: HlPerpState | null,
  ): MirrorContext => {
    const now = d.clock.now();
    const open = openMirrors(master, hl, now);
    const placed = d.repos.mirrorOrders
      .ordersByMaster(master, now - DAY_MS)
      .filter((o) => PLACED_STATUSES.has(o.status));
    const marksFresh = now - d.state.marksAt <= MARKS_DELAY_MS;
    const mark = marksFresh ? (d.state.marks[coin] ?? null) : null;
    return {
      companyStatus: rt.status,
      snapshotAgeMs: now - rt.lastSnapshotAt,
      coinSupported: supported,
      traderPosition: rt.nav.snapshot.positions.find((p) => p.coin === coin) ?? null,
      mark,
      hp:
        mark === null
          ? Number.NaN
          : (computeHpStrict(rt.nav.snapshot.positions, d.state.marks) ?? Number.NaN),
      playerOpenMirrors: open,
      playerDailyNotionalUsd: placed.reduce((s, o) => s + o.notionalUsd, 0),
    };
  };

  const row = (o: {
    playerId: string;
    master: string;
    rt: CompanyRuntime;
    coin: string;
    kind: MirrorKind;
    stepIndex: number;
    groupId: string;
    status: MirrorStatus;
    notionalUsd: number;
    request: Record<string, unknown>;
    /** Defaults to now; prepared steps use the moment their nonce was requested. */
    createdAt?: number;
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
      createdAt: o.createdAt ?? now,
      updatedAt: now,
      masterAddress: o.master,
    };
  };

  /** `master` is the fallback wallet for rows written before master_address existed. */
  const view = (o: MirrorOrderRow, master: string | null): MirrorOrderView => {
    const wallet = o.masterAddress ?? master;
    return {
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
      explorerUrl: wallet ? explorerUrl(wallet) : null,
    };
  };

  return {
    available,

    async builderStatus(playerId) {
      const trading = d.trading;
      if (!available() || !trading)
        return err(503, 'TRADING_UNAVAILABLE', 'mirror trading is disabled in this mode');
      const wallet = d.repos.players.get(playerId)?.walletAddress;
      if (!wallet) return err(403, 'NO_WALLET', 'link a wallet first');
      const key = wallet.toLowerCase();
      const now = d.clock.now();
      const cached = builderStatuses.get(key);
      if (cached && now < cached.until) return cached.result;
      const r = await trading.builderFee(wallet as Address);
      const result: { ok: true; status: BuilderFeeStatus } | MirrorError = r.ok
        ? { ok: true, status: r.value }
        : r.status === 451
          ? regionBlocked()
          : err(502, 'UPSTREAM_FAILED', redact(r.error));
      if (r.ok) builder = { at: now, address: r.value.builderAddress.toLowerCase() };
      for (const [k, v] of builderStatuses) if (v.until <= now) builderStatuses.delete(k);
      builderStatuses.set(key, {
        until: now + (r.ok ? BUILDER_STATUS_TTL_MS : BUILDER_STATUS_FAILURE_TTL_MS),
        result,
      });
      return result;
    },

    registerAgent(playerId, masterAddress, agentAddress) {
      if (!available())
        return err(503, 'TRADING_UNAVAILABLE', 'mirror trading is disabled in this mode');
      if (!isAddress(masterAddress) || !isAddress(agentAddress))
        return err(400, 'INVALID_ADDRESS', 'invalid address');
      const player = d.repos.players.get(playerId);
      const master = masterAddress.toLowerCase();
      if (player?.walletAddress?.toLowerCase() !== master) {
        return err(403, 'NO_WALLET', 'link this wallet to your player first');
      }
      // One agent key per master wallet: otherwise players sharing a wallet multiply its caps.
      if (d.repos.agentKeys.byMaster(master).some((k) => k.playerId !== playerId))
        return err(409, 'WALLET_IN_USE', 'this wallet already trades through another player');
      d.repos.agentKeys.upsert({
        playerId,
        masterAddress: master,
        agentAddress: agentAddress.toLowerCase(),
        registeredAt: d.clock.now(),
      });
      return { ok: true };
    },

    async prepare(playerId, req) {
      const trading = d.trading;
      if (!available() || !trading)
        return err(503, 'TRADING_UNAVAILABLE', 'mirror trading is disabled in this mode');
      const agent = boundAgent(playerId);
      if ('ok' in agent) return agent;
      const rt = d.state.byTicker(req.ticker);
      if (!rt) return err(404, 'UNKNOWN_TICKER', 'no such ticker');
      const master = agent.masterAddress as Address;

      const groupId = `mg_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const request: StoredRequest = { ...req };
      /** Every attempt on a listed company is a row: REFUSED (policy) or REJECTED (failure). */
      const record = (
        status: 'REFUSED' | 'REJECTED',
        refusals: MirrorReason[] | null,
        error: string | null,
      ) => {
        const r = row({
          playerId,
          master,
          rt,
          coin: req.coin,
          kind: 'order',
          stepIndex: 1,
          groupId,
          status,
          notionalUsd: req.notionalUsd,
          request: { ...request },
        });
        d.repos.mirrorOrders.insert({ ...r, refusals, error });
      };
      const refuse = (refusals: MirrorReason[]): PrepareResult => {
        record('REFUSED', refusals, null);
        return { ok: true, groupId, refusals };
      };
      const fail = (code: MirrorErrorCode, status: number, message: string): MirrorError => {
        record('REJECTED', code === 'REGION_BLOCKED' ? [TRADING_UNAVAILABLE] : null, message);
        return err(status, code, message);
      };
      const failWith = (e: MirrorError) => fail(e.code, e.status, e.message);

      if (d.state.flags.creditFloor) return refuse([CREDIT_FLOOR_REFUSAL]);
      await d.refresher.refresh(rt.id, 'mirror');
      const table = await assets();
      if (!(table instanceof Map)) return failWith(table);
      const asset = table.get(req.coin) ?? null;
      // One HL read: live positions for the open-mirror count, and the reconcile baseline.
      const hl = await readHl(master);
      const decision = evaluateMirror(
        {
          coin: req.coin,
          notionalUsd: req.notionalUsd,
          leverage: req.leverage,
          stopLossPct: req.stopLossPct,
        },
        context(rt, req.coin, master, asset !== null, hl),
        params,
      );
      if (!decision.allow || !asset) return refuse(decision.allow ? [] : decision.refusals);

      // Whole lots only: round the size DOWN (so rounding never lifts it past the cap) and refuse
      // when that leaves less than the minimum order.
      if (!(Number.isInteger(asset.szDecimals) && asset.szDecimals >= 0 && asset.szDecimals <= 12))
        return fail('UPSTREAM_FAILED', 502, `invalid size precision for ${req.coin}`);
      const size = floorTo(decision.order.size, asset.szDecimals);
      const min = params.mirror.minNotionalUsd;
      if (!(size * decision.order.markPx >= min)) {
        return refuse([
          {
            code: 'BELOW_MIN_SIZE',
            message: `${req.coin} trades in steps of ${10 ** -asset.szDecimals}: $${req.notionalUsd} rounds down to ${size} ${req.coin}, below the $${min} minimum`,
          },
        ]);
      }
      const order: MirrorOrder = { ...decision.order, size };

      const nansenBuilder = await builderAddress(master);
      if (typeof nansenBuilder !== 'string') return failWith(nansenBuilder);

      // The 60 s step window starts at the first Nansen prepare call (when the nonce is minted).
      const preparedAt = d.clock.now();
      const lev = await trading.prepareLeverage(master, req.coin, order.leverage);
      if (!lev.ok)
        return lev.status === 451
          ? fail('REGION_BLOCKED', 451, REGION_MESSAGE)
          : fail('PREPARE_FAILED', 502, `leverage: ${redact(lev.error)}`);
      if (lev.value.vaultAddress !== null)
        return fail('ACTION_MISMATCH', 502, 'prepared leverage rejected: it targets a vault');
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
      if (prepared.value.vaultAddress !== null)
        return fail('ACTION_MISMATCH', 502, 'prepared order rejected: it targets a vault');
      const mismatch = validateOrderAction(prepared.value.action, order, asset, {
        builderAddress: nansenBuilder,
        maxNotionalUsd: params.mirror.maxNotionalUsd,
      });
      if (mismatch) return fail('ACTION_MISMATCH', 502, `prepared order rejected: ${mismatch}`);

      // Baseline for reconciling a non-definitive execute later (null if HL is unreachable).
      const baseline =
        hl === null ? null : (hl.positions.find((p) => p.coin === req.coin)?.size ?? 0);
      const levRow: MirrorOrderRow = {
        ...row({
          playerId,
          master,
          rt,
          coin: req.coin,
          kind: 'leverage',
          stepIndex: 0,
          groupId,
          status: 'PREPARED',
          notionalUsd: 0,
          request: { ...request },
          createdAt: preparedAt,
        }),
        action: lev.value.action,
        eip712: lev.value.eip712,
        nonce: lev.value.nonce,
        vaultAddress: lev.value.vaultAddress,
      };
      const orderRow: MirrorOrderRow = {
        ...row({
          playerId,
          master,
          rt,
          coin: req.coin,
          kind: 'order',
          stepIndex: 1,
          groupId,
          status: 'PREPARED',
          // What the validated action really sends (lots, slippage), so the daily cap counts it.
          notionalUsd: entryNotional(prepared.value.action) ?? order.notionalUsd,
          request: { ...request, hlBaselineSzi: baseline },
          createdAt: preparedAt,
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
      const agent = boundAgent(playerId);
      if ('ok' in agent) return agent;

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
      // Live positions for the open-mirror re-check (the critical section below cannot await).
      const hl = pre.kind === 'order' ? await readHl(agent.masterAddress as Address) : null;

      // Critical section: no await from here until the row is SUBMITTED, so concurrent executes
      // can neither run the same step twice nor both slip under the open/daily caps.
      const step = d.repos.mirrorOrders.get(stepId);
      if (step?.status !== 'PREPARED' || !step.action || step.nonce === null)
        return err(409, 'BAD_STATE', `step is ${(step?.status ?? 'gone').toLowerCase()}`);
      const bound = boundAgent(playerId);
      if ('ok' in bound) return bound;
      if (bound.agentAddress !== agent.agentAddress || bound.masterAddress !== agent.masterAddress)
        return err(401, 'BAD_SIGNATURE', 'agent key changed; sign again');
      if (step.masterAddress !== bound.masterAddress)
        return err(403, 'NO_WALLET', 'this step was prepared for another wallet');
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
        if (!rt) {
          const refusals: MirrorReason[] = [
            { code: 'POLICY_CHANGED', message: 'company no longer listed' },
          ];
          d.repos.mirrorOrders.update(step.id, {
            status: 'REJECTED',
            refusals,
            error: 'company no longer listed',
            updatedAt: now,
          });
          return err(409, 'POLICY_CHANGED', 'company no longer listed', refusals);
        }
        const again = evaluateMirror(
          {
            coin: req.coin,
            notionalUsd: req.notionalUsd,
            leverage: req.leverage,
            stopLossPct: req.stopLossPct,
          },
          context(rt, step.coin, bound.masterAddress, true, hl),
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
      // From here on the attempt counts toward the caps (SUBMITTED is an open status).
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
      if (!available() || !info) return;
      // Never read (or trade on the evidence of) a wallet the player no longer has linked.
      const agent = boundAgent(playerId);
      if ('ok' in agent) return;
      const master = agent.masterAddress;
      const now = d.clock.now();
      const recent = d.repos.mirrorOrders.ordersByMaster(master, now - DAY_MS);
      const candidates = recent.filter(
        (o) =>
          o.playerId === playerId &&
          RECONCILABLE.has(o.status) &&
          now - o.updatedAt >= RECONCILE_MIN_AGE_MS,
      );
      if (candidates.length === 0) return;
      if (!reconcileGate.allow(playerId)) return;
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
            PLACED_STATUSES.has(x.status) &&
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
