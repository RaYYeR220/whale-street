import type { Filing } from '@whale-street/core';
import type { FilingRow, Repos } from '../db/repos';
import { type EventBus, explorerUrl, type FilingView } from '../events';
import type { MarketState } from '../market/state';

export interface FilingService {
  /** Persists a filing and broadcasts it on the `filings` channel. */
  record(companyId: string, f: Filing): FilingView;
  /**
   * Newest first, never a filing stamped after engine now: in REPLAY a row from a later point of
   * the recording must not show up early (the same rule as the history points).
   */
  recent(limit: number, companyId?: string): FilingView[];
  /**
   * REPLAY loop start: deletes every filing, so the filings page only ever holds what happened in
   * the loop being played, up to engine now.
   */
  clear(): void;
}

export function filingView(row: FilingRow, ticker: string): FilingView {
  return {
    id: row.id,
    companyId: row.companyId,
    ticker,
    kind: row.kind,
    coin: row.coin,
    sizeBefore: row.sizeBefore,
    sizeAfter: row.sizeAfter,
    notionalUsd: row.notionalUsd,
    realizedPnlUsd: row.realizedPnlUsd,
    at: row.at,
    provenance: row.provenance,
    detail: row.detail,
    explorerUrl: explorerUrl(row.companyId),
  };
}

export function createFilingService(
  repos: Repos,
  state: MarketState,
  bus: EventBus,
  /** Engine clock (REPLAY: recording time). */
  now: () => number,
): FilingService {
  const tickerOf = (companyId: string) =>
    state.get(companyId)?.ticker ?? repos.companies.get(companyId)?.ticker ?? '?';

  return {
    record(companyId, f) {
      const row = repos.filings.insert({
        companyId,
        kind: f.kind,
        coin: f.coin ?? null,
        sizeBefore: f.sizeBefore ?? null,
        sizeAfter: f.sizeAfter ?? null,
        notionalUsd: f.notionalUsd ?? null,
        realizedPnlUsd: f.realizedPnlUsd ?? null,
        at: f.at,
        provenance: [...f.provenance],
        detail: f.detail ?? null,
      });
      const view = filingView(row, tickerOf(companyId));
      bus.emit({ t: 'filing', filing: view });
      return view;
    },
    recent(limit, companyId) {
      return repos.filings
        .recent(limit, companyId, now())
        .map((r) => filingView(r, tickerOf(r.companyId)));
    },
    clear() {
      repos.filings.clear();
    },
  };
}
