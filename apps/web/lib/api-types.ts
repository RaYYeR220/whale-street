/**
 * Wire types of the engine API (REST + WebSocket), mirrored from apps/engine/src
 * (engine.ts, events.ts, market/state.ts, services/*.ts, api/protocol.ts).
 * contract/engine-contract.ts checks at type level that every engine payload is assignable here.
 * Numbers the engine computes can arrive as null (JSON has no NaN), so formatting treats them as unknown.
 */
import type {
  CompanyStatus,
  FilingKind,
  Holding,
  ListingVerdict,
  MirrorOrder,
  OrderSide,
  Position,
  Prospectus,
  Rating,
} from '@whale-street/core';

export type Mode = 'live' | 'replay';
export type PlayerKind = 'human' | 'bot' | 'agent';
export type CompanySource = 'SCOUT' | 'IPO_DESK' | 'SEEDED';
export type IpoStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'DEFERRED';
export type SeasonStatus = 'ACTIVE' | 'CLOSED';
export type MirrorKind = 'leverage' | 'order';
/**
 * UNKNOWN: execute was sent but the outcome is not definitive; the order may be on Hyperliquid.
 * CLOSED: a filled order whose coin later showed no position on the wallet (no longer open).
 */
export type MirrorStatus =
  | 'REFUSED'
  | 'PREPARED'
  | 'SUBMITTED'
  | 'FILLED'
  | 'RESTING'
  | 'REJECTED'
  | 'UNKNOWN'
  | 'CLOSED';

/** A refusal reason: a core policy code or an engine-side one (BELOW_MIN_SIZE, POLICY_CHANGED, ...). */
export interface MirrorReason {
  code: string;
  message: string;
}

export interface StatusView {
  mode: Mode;
  recordedAt: number | null;
  synthetic: boolean;
  idle: boolean;
  creditSaver: boolean;
  creditFloor: boolean;
  creditsRemaining: number | null;
  marksDelayed: boolean;
  season: { id: number; endsAt: number } | null;
  companies: number;
  viewers: number;
}

export interface PlayerView {
  id: string;
  handle: string;
  kind: PlayerKind;
  walletAddress: string | null;
  createdAt: number;
}

/** Refusals of POST /api/auth/link: 400 INVALID_MESSAGE and NO_NONCE, 401 for the rest. */
export type LinkErrorCode =
  | 'INVALID_MESSAGE'
  | 'NO_NONCE'
  | 'DOMAIN_MISMATCH'
  | 'NONCE_MISMATCH'
  | 'MESSAGE_EXPIRED'
  | 'MESSAGE_NOT_YET_VALID'
  | 'BAD_SIGNATURE';

export interface PublicPlayerView {
  id: string;
  handle: string;
  kind: PlayerKind;
  createdAt: number;
  walletLinked: boolean;
}

export interface PositionView extends Position {
  mark: number | null;
  hp: number;
}

export interface CompanyView {
  id: string;
  ticker: string;
  name: string;
  logoSeed: number;
  rating: Rating | null;
  source: CompanySource;
  status: CompanyStatus;
  haltReason: string | null;
  nav: number;
  price: number;
  mult: number;
  hp: number;
  equityUsd: number;
  listedAt: number;
  ipoUntil: number;
  lastSnapshotAt: number;
  prospectus: Prospectus | null;
  positions: PositionView[];
  provenance: readonly string[];
}

export interface MarketEntry {
  id: string;
  ticker: string;
  nav: number;
  price: number;
  mult: number;
  hp: number;
  status: CompanyStatus;
}

/**
 * Street mood of one coin: how Nansen's smart traders and whales lean, each as
 * (long − short) / (long + short) ∈ [−1, 1], null when unknown. `asOf`: when the engine read it
 * (engine clock; REPLAY: recording time).
 */
export interface MoodEntry {
  coin: string;
  smartSkew: number | null;
  whaleSkew: number | null;
  asOf: number;
}

export interface FilingView {
  id: number;
  companyId: string;
  ticker: string;
  kind: FilingKind;
  coin: string | null;
  sizeBefore: number | null;
  sizeAfter: number | null;
  notionalUsd: number | null;
  realizedPnlUsd: number | null;
  at: number;
  provenance: string[];
  detail: string | null;
  explorerUrl: string;
}

export interface TapeView {
  ticker: string;
  side: OrderSide;
  qty: number;
  avgPrice: number;
  cash: number;
  handle: string;
  kind: PlayerKind;
  forced: boolean;
  at: number;
}

export type IpoStep = 'track_record' | 'size' | 'human' | 'hedge' | 'concentration' | 'uniqueness';

export type IpoUpdate =
  | { appId: string; kind: 'progress'; step: IpoStep; state: 'running' | 'done' }
  | {
      appId: string;
      kind: 'decided';
      status: IpoStatus;
      ticker: string | null;
      reason: string | null;
    };

/** Refusals of POST /api/ipo: 400 INVALID_ADDRESS, 429 RATE_LIMITED / IPO_DESK_BUSY, 409 the rest. */
export type IpoApplyErrorCode =
  | 'INVALID_ADDRESS'
  | 'RATE_LIMITED'
  | 'IPO_DESK_BUSY'
  | 'ALREADY_LISTED'
  | 'COOLING_DOWN'
  | 'RECENTLY_DENIED';

export interface IpoView {
  id: string;
  address: string;
  status: IpoStatus;
  reason: string | null;
  ticker: string | null;
  verdict: ListingVerdict | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface FillView {
  ticker: string;
  side: OrderSide;
  qty: number;
  cash: number;
  avgPrice: number;
  nav: number;
  multiplierBefore: number;
  multiplierAfter: number;
  price: number;
}

export interface HoldingView extends Holding {
  companyId: string;
  ticker: string;
  /** Null when the company has no live price right now. */
  price: number | null;
  value: number | null;
}

export interface PortfolioView {
  playerId: string;
  seasonId: number;
  cash: number;
  /** Null (never a fabricated number) when a held company has no live price; see netWorthReason. */
  netWorth: number | null;
  netWorthReason: string | null;
  holdings: HoldingView[];
}

export interface LeaderboardEntry {
  rank: number;
  playerId: string;
  handle: string;
  kind: PlayerKind;
  /** Null when a held company has no live price right now. */
  netWorth: number | null;
}

export interface HolderView {
  handle: string;
  kind: PlayerKind;
  longQty: number;
  shortQty: number;
}

export interface QuoteView {
  ok: true;
  ticker: string;
  side: OrderSide;
  qty: number;
  cash: number;
  avgPrice: number;
  price: number;
  priceAfter: number;
}

export interface OrderFilled {
  ok: true;
  fill: FillView;
  portfolio: PortfolioView;
}

export interface OrderBody {
  ticker: string;
  side: OrderSide;
  qty?: number;
  cash?: number;
}

export interface HistoryPoint {
  t: number;
  nav: number;
  price: number;
}

export interface SeasonRow {
  id: number;
  startedAt: number;
  endsAt: number;
  status: SeasonStatus;
}

export interface SeasonResultRow {
  seasonId: number;
  playerId: string;
  netWorth: number;
  rank: number;
}

export interface SeasonResultView {
  rank: number;
  netWorth: number;
  handle: string;
  kind: PlayerKind;
}

export interface TradeRowView {
  id: number;
  playerId: string;
  seasonId: number;
  companyId: string;
  side: OrderSide | 'SETTLE';
  qty: number;
  cash: number;
  avgPrice: number;
  nav: number;
  multBefore: number;
  multAfter: number;
  forced: boolean;
  at: number;
  ticker: string;
}

export interface NansenCallView {
  id: string;
  method: 'GET' | 'POST';
  path: string;
  requestHash: string;
  status: number | null;
  credits: number | null;
  latencyMs: number;
  at: number;
  responseHash: string | null;
  error: string | null;
  attempts: number;
}

export interface BuilderFeeStatus {
  approved: boolean;
  maxFeeRate: number;
  requiredFee: number;
  builderAddress: `0x${string}`;
}

export interface Eip712Payload {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface SignatureParts {
  r: string;
  s: string;
  v: number;
}

export interface MirrorStep {
  stepId: string;
  kind: MirrorKind;
  eip712: Eip712Payload;
}

/** POST /api/mirror/prepare, HTTP 200: a policy refusal (ok: false) or the steps to sign. */
export type PrepareView =
  | { ok: false; groupId: string; refusals: MirrorReason[] }
  | { ok: true; groupId: string; order: MirrorOrder; steps: MirrorStep[] };

/** Mirror route errors (the HTTP status is in the reply); POLICY_CHANGED also carries refusals. */
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

export interface MirrorPrepareBody {
  ticker: string;
  coin: string;
  notionalUsd: number;
  leverage: number;
  stopLossPct?: number;
}

export interface MirrorReceipt {
  stepId: string;
  kind: MirrorKind;
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
  explorerUrl: string | null;
}

export const CHANNELS = [
  'market',
  'filings',
  'tape',
  'leaderboard',
  'ipo',
  'player',
  'status',
] as const;
export type Channel = (typeof CHANNELS)[number];

export type ClientMessage =
  | { op: 'hello'; token?: string }
  | { op: 'sub'; channels: Channel[] }
  | { op: 'unsub'; channels: Channel[] };

export type ServerMessage =
  | { t: 'hello'; player: PlayerView | null }
  | { t: 'market'; at: number; mode: Mode; companies: MarketEntry[]; mood: MoodEntry[] }
  | { t: 'filing'; filing: FilingView }
  | { t: 'tape'; trade: TapeView }
  | { t: 'leaderboard'; rows: LeaderboardEntry[] }
  | { t: 'ipo'; update: IpoUpdate }
  | { t: 'player'; portfolio: PortfolioView }
  | { t: 'status'; status: StatusView }
  | { t: 'error'; error: string; message: string };

export interface ApiErrorBody {
  error: string;
  message: string;
  refusals?: MirrorReason[];
}
