export type Address = `0x${string}`;

/** Mark price per coin symbol (e.g. { BTC: 64000 }). */
export type Marks = Readonly<Record<string, number>>;

export interface Position {
  coin: string;
  /** Signed size in base units: long > 0, short < 0. */
  size: number;
  entryPx: number;
  /** Liquidation price, or null when the position cannot be liquidated. */
  liqPx: number | null;
  leverage: number;
  marginUsed: number;
  /** Unrealized PnL in USD as reported by the data source at fetch time. */
  unrealizedPnl: number;
}

export interface Snapshot {
  address: Address;
  positions: readonly Position[];
  /** Account equity in USD at fetch time (E_snap). */
  accountValue: number;
  /** Realized PnL net of fees since the company's anchor date (R). */
  realizedSinceAnchor: number;
  fetchedAt: number;
  /** Ids of the data-source calls behind this snapshot. */
  provenance: readonly string[];
}

export type CompanyStatus = 'ACTIVE' | 'HALTED' | 'BANKRUPT' | 'DELISTED';

export type Rating = 'AAA' | 'AA' | 'A' | 'BBB' | 'BB' | 'B' | 'CCC';
export const RATINGS: readonly Rating[] = ['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'CCC'];

export type Maybe<T> = { ok: true; value: T } | { ok: false; error: string };
export const some = <T>(value: T): Maybe<T> => ({ ok: true, value });
export const none = <T = never>(error: string): Maybe<T> => ({ ok: false, error });
