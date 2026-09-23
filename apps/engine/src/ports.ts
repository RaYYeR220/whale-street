import type { HlFeed, HlInfo } from '@whale-street/hl';
import type { NansenClient, NansenTrading } from '@whale-street/nansen';

/** The Nansen read endpoints the engine uses (satisfied structurally by NansenClient). */
export type NansenPort = Pick<
  NansenClient,
  | 'perpPositions'
  | 'perpPnlSummary'
  | 'perpTrades'
  | 'perpLeaderboard'
  | 'smartMoneyPerpTrades'
  | 'positionIntelligence'
  | 'relatedWallets'
  | 'firstFunder'
  | 'counterparties'
  | 'account'
>;

/** The Nansen perp trading endpoints used by Mirror (satisfied structurally by NansenTrading). */
export type TradingPort = Pick<
  NansenTrading,
  'builderFee' | 'meta' | 'prepareOrder' | 'prepareLeverage' | 'execute'
>;

export interface HlPorts {
  feed: HlFeed;
  info: HlInfo;
}
