import {
  type Address,
  type LinkedWallet,
  type ListingEvidence,
  type Maybe,
  none,
  type Position,
  some,
} from '@whale-street/core';
import type { HlInfo } from '@whale-street/hl';
import { type ApiResult, type PerpTradeRow, toMaybe } from '@whale-street/nansen';
import type { Clock } from '../clock';
import { daysBefore, utcDate } from '../dates';
import type { Repos } from '../db/repos';
import type { IpoStep } from '../events';
import type { MarketState } from '../market/state';
import type { NansenPort } from '../ports';
import { fetchPositions, type PositionsResult } from './positions';

export interface EvidenceDeps {
  nansen: NansenPort;
  info: HlInfo;
  state: MarketState;
  repos: Repos;
  clock: Clock;
}

export type ProgressFn = (step: IpoStep, state: 'running' | 'done') => void;

export interface Evidence {
  ev: ListingEvidence;
  /** The positions fetch behind `ev.positions` (null when it failed); becomes the listing snapshot. */
  positions: PositionsResult | null;
  /**
   * A HIP-3 coin ("dex:COIN", e.g. "xyz:TSLA") found among the trader's open positions, or null.
   * The engine's universe is standard Hyperliquid perps only (the feed carries default-dex mids
   * only): a set value means evaluation stopped here and the address is never listed.
   */
  hip3Coin: string | null;
}

export const MAX_LINKED = 10;
/** Visible reason an address holding a HIP-3 market is never evaluated further. */
export const HIP3_REASON = 'holds HIP-3 markets (not supported yet)';

/** The first HIP-3 coin ("dex:COIN") among open positions, or null: a standard perp coin has no dex prefix. */
const hip3CoinOf = (positions: readonly Position[]): string | null =>
  positions.find((p) => p.coin.includes(':'))?.coin ?? null;

/**
 * The committee's concentration evidence: no trade at all is a known zero-risk `null`, but a top
 * trade whose own profit Nansen did not report is unknown (`none`) — never confused with "no
 * trade" and never an invented zero.
 */
function topTradePnlUsd(top: ApiResult<PerpTradeRow[]>): Maybe<number | null> {
  if (!top.ok) return none(top.error);
  const trade = top.value[0];
  if (!trade) return some(null);
  return trade.closedPnl === null ? none('top trade profit not reported') : some(trade.closedPnl);
}

async function gatherLinked(
  address: Address,
  d: EvidenceDeps,
  now: number,
): Promise<Maybe<readonly LinkedWallet[]>> {
  const [related, funder, counterparties] = await Promise.all([
    d.nansen.relatedWallets(address, 'arbitrum'),
    d.nansen.firstFunder(address),
    d.nansen.counterparties(address, 'arbitrum', daysBefore(now, 90), utcDate(now), 5),
  ]);
  if (!related.ok) return none(`related wallets: ${related.error}`);
  if (!funder.ok) return none(`first funder: ${funder.error}`);
  if (!counterparties.ok) return none(`counterparties: ${counterparties.error}`);

  const picked = new Map<Address, LinkedWallet['relation']>();
  const add = (a: string, relation: LinkedWallet['relation']) => {
    const x = a.toLowerCase() as Address;
    if (x !== address && !picked.has(x) && picked.size < MAX_LINKED) picked.set(x, relation);
  };
  for (const r of related.value) add(r.address, 'related');
  if (funder.value.funder) add(funder.value.funder, 'first_funder');
  for (const c of counterparties.value) add(c.address, 'counterparty');

  const wallets = await Promise.all(
    [...picked].map(async ([a, relation]): Promise<LinkedWallet> => {
      const s = await d.info.clearinghouse(a);
      return { address: a, relation, positions: s.ok ? some(s.value.positions) : none(s.error) };
    }),
  );
  return some(wallets);
}

/** Collects the committee's evidence for an address (fail-closed: every failure becomes `none`). */
export async function gatherEvidence(
  address: Address,
  d: EvidenceDeps,
  onProgress: ProgressFn = () => {},
): Promise<Evidence> {
  const now = d.clock.now();
  const today = utcDate(now);
  const yearAgo = daysBefore(now, 365);

  onProgress('track_record', 'running');
  const [first, pnl] = await Promise.all([
    d.nansen.perpTrades(address, yearAgo, today, {
      orderBy: 'timestamp',
      direction: 'ASC',
      perPage: 1,
    }),
    d.nansen.perpPnlSummary(address, yearAgo, today),
  ]);
  onProgress('track_record', 'done');

  onProgress('size', 'running');
  // The committee's size evidence keeps Nansen as its source in credit-saver mode too.
  const pos = await fetchPositions(address, { nansen: d.nansen, info: d.info, creditSaver: false });
  onProgress('size', 'done');

  const row = d.repos.companies.get(address);
  const alreadyListed = row !== undefined && row.status !== 'DELISTED';
  const cooldownUntil = row?.cooldownUntil ?? null;
  const firstTradeAt = first.ok ? some(first.value[0]?.at ?? null) : none(first.error);

  // The universe is standard Hyperliquid perps only: a HIP-3 holder is never listed, and stops
  // here before spending any more of the committee's Nansen credits.
  const hip3Coin = pos.ok ? hip3CoinOf(pos.value.positions) : null;
  if (pos.ok && hip3Coin) {
    onProgress('uniqueness', 'running');
    onProgress('uniqueness', 'done');
    return {
      ev: {
        address,
        now,
        firstTradeAt,
        pnl: toMaybe(pnl),
        topTradePnlUsd: none(HIP3_REASON),
        equityUsd: some(pos.value.accountValue),
        positions: some(pos.value.positions),
        linked: none(HIP3_REASON),
        isVault: none(HIP3_REASON),
        marks: { ...d.state.marks },
        alreadyListed,
        cooldownUntil,
      },
      positions: null,
      hip3Coin,
    };
  }

  onProgress('human', 'running');
  const isVault = await d.info.isVault(address);
  onProgress('human', 'done');

  onProgress('hedge', 'running');
  const linked = await gatherLinked(address, d, now);
  onProgress('hedge', 'done');

  onProgress('concentration', 'running');
  const top = await d.nansen.perpTrades(address, yearAgo, today, {
    orderBy: 'closed_pnl',
    direction: 'DESC',
    perPage: 1,
  });
  onProgress('concentration', 'done');

  onProgress('uniqueness', 'running');
  onProgress('uniqueness', 'done');

  return {
    ev: {
      address,
      now,
      firstTradeAt,
      pnl: toMaybe(pnl),
      // No trade at all is a known "no concentration risk" (null); a trade whose own profit
      // Nansen did not report is unknown, never the same thing (never the invented zero either).
      topTradePnlUsd: topTradePnlUsd(top),
      equityUsd: pos.ok ? some(pos.value.accountValue) : none(pos.error),
      positions: pos.ok ? some(pos.value.positions) : none(pos.error),
      linked,
      isVault,
      marks: { ...d.state.marks },
      alreadyListed,
      cooldownUntil,
    },
    positions: pos.ok ? pos.value : null,
    hip3Coin: null,
  };
}
