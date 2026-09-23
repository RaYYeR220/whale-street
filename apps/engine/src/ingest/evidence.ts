import {
  type Address,
  type LinkedWallet,
  type ListingEvidence,
  type Maybe,
  none,
  some,
} from '@whale-street/core';
import type { HlInfo } from '@whale-street/hl';
import { toMaybe } from '@whale-street/nansen';
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
}

export const MAX_LINKED = 10;

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
  const pos = await fetchPositions(address, {
    nansen: d.nansen,
    info: d.info,
    creditSaver: d.state.flags.creditSaver,
  });
  onProgress('size', 'done');

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
  const row = d.repos.companies.get(address);
  onProgress('uniqueness', 'done');

  return {
    ev: {
      address,
      now,
      firstTradeAt: first.ok ? some(first.value[0]?.at ?? null) : none(first.error),
      pnl: toMaybe(pnl),
      topTradePnlUsd: top.ok ? some(top.value[0]?.closedPnl ?? null) : none(top.error),
      equityUsd: pos.ok ? some(pos.value.accountValue) : none(pos.error),
      positions: pos.ok ? some(pos.value.positions) : none(pos.error),
      linked,
      isVault,
      marks: { ...d.state.marks },
      alreadyListed: row !== undefined && row.status !== 'DELISTED',
      cooldownUntil: row?.cooldownUntil ?? null,
    },
    positions: pos.ok ? pos.value : null,
  };
}
