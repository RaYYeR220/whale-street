/**
 * How filings read on the page: label, tone, timeline glyph and balloon style per kind, plus a
 * plain sentence built only from the filing's own fields (never invented figures).
 */
import type { FilingKind } from '@whale-street/core';
import type { FilingView } from './api-types';
import { haltText } from './company';
import { compact, pctAbs } from './format';

export type Tone = '' | 'mint' | 'red' | 'blue' | 'pink';

export interface KindStyle {
  label: string;
  tone: Tone;
  glyph: string;
  balloon: string;
  /** Balloons with a jagged edge have no tail. */
  shout: boolean;
  /** Filings whose numbers come straight from a Nansen snapshot (show the N evidence mark). */
  nansen: boolean;
}

export const KIND: Record<FilingKind, KindStyle> = {
  OPEN: { label: 'New position', tone: '', glyph: '+', balloon: '', shout: false, nansen: true },
  ADD: { label: 'Added', tone: '', glyph: '+', balloon: '', shout: false, nansen: true },
  REDUCE: {
    label: 'Cut a position',
    tone: '',
    glyph: '−',
    balloon: '',
    shout: false,
    nansen: true,
  },
  CLOSE: {
    label: 'Closed a trade',
    tone: 'mint',
    glyph: '$',
    balloon: '',
    shout: false,
    nansen: true,
  },
  FLIP: { label: 'Flipped', tone: '', glyph: '⇄', balloon: '', shout: false, nansen: true },
  MARGIN_CALL: {
    label: 'Margin call',
    tone: 'red',
    glyph: '!',
    balloon: 'ws-balloon--shout',
    shout: true,
    nansen: false,
  },
  LIQUIDATION: {
    label: 'Liquidation',
    tone: 'red',
    glyph: '!',
    balloon: 'ws-balloon--shout ws-balloon--red',
    shout: true,
    nansen: true,
  },
  BANKRUPTCY: {
    label: 'Bankrupt',
    tone: 'red',
    glyph: '✕',
    balloon: 'ws-balloon--shout ws-balloon--red',
    shout: true,
    nansen: false,
  },
  RESTATEMENT: {
    label: 'Restatement',
    tone: '',
    glyph: '±',
    balloon: '',
    shout: false,
    nansen: true,
  },
  HALT: {
    label: 'Halted',
    tone: 'blue',
    glyph: 'z',
    balloon: 'ws-balloon--thought',
    shout: false,
    nansen: false,
  },
  RESUME: { label: 'Resumed', tone: 'blue', glyph: '▸', balloon: '', shout: false, nansen: false },
  IPO: {
    label: 'IPO',
    tone: 'pink',
    glyph: 'IPO',
    balloon: 'ws-balloon--pink',
    shout: false,
    nansen: false,
  },
  DELISTING: {
    label: 'Delisted',
    tone: 'red',
    glyph: '✕',
    balloon: '',
    shout: false,
    nansen: false,
  },
};

export const TONE_TEXT: Record<Tone, string> = {
  '': '',
  mint: 'ws-v-nav',
  red: 'ws-v-red',
  blue: 'ws-v-down',
  pink: 'ws-v-up',
};

/** Label and tone, refined by the realized PnL of a close. */
export function kindOf(f: Pick<FilingView, 'kind' | 'realizedPnlUsd'>): KindStyle {
  const k = KIND[f.kind];
  if (f.kind === 'CLOSE' && (f.realizedPnlUsd ?? 0) < 0)
    return { ...k, label: 'Closed at a loss', tone: 'blue' };
  if (f.kind === 'CLOSE' && (f.realizedPnlUsd ?? 0) > 0)
    return { ...k, label: 'Closed for a profit' };
  return k;
}

const sideOf = (size: number | null): string | null =>
  size === null || size === 0 ? null : size > 0 ? 'long' : 'short';

const pnl = (usd: number | null): string =>
  usd === null ? '' : ` for ${usd >= 0 ? '+' : '−'}${compact(Math.abs(usd))}`;

/** One sentence describing a filing from its own fields. */
export function filingText(f: FilingView): string {
  const coin = f.coin ?? 'a coin';
  const before = sideOf(f.sizeBefore);
  const after = sideOf(f.sizeAfter);
  const size = f.notionalUsd === null ? '' : `, ${compact(f.notionalUsd)}`;
  switch (f.kind) {
    case 'OPEN':
      return `Opened ${after ? after.toUpperCase() : 'a position in'} ${coin}${size}.`;
    case 'ADD':
      return `Added to the ${coin} ${after ?? 'position'}${size ? `, now${size.slice(1)}` : ''}.`;
    case 'REDUCE': {
      const b = f.sizeBefore;
      const a = f.sizeAfter;
      const cut = b !== null && a !== null && b !== 0 ? 1 - Math.abs(a) / Math.abs(b) : null;
      return `Cut the ${coin} ${before ?? 'position'}${cut !== null ? ` by ${pctAbs(cut, 0)}` : ''}${pnl(f.realizedPnlUsd)}.`;
    }
    case 'CLOSE':
      return `Closed the ${coin} ${before ?? 'position'}${pnl(f.realizedPnlUsd)}.`;
    case 'FLIP':
      return `Flipped ${coin} from ${before ?? '?'} to ${after ?? '?'}${size}.`;
    case 'LIQUIDATION':
      return `${coin} ${before ?? 'position'} liquidated${pnl(f.realizedPnlUsd)}.`;
    case 'MARGIN_CALL':
      return f.detail ? `Margin call: ${f.detail}.` : 'Margin call: HP under 10%.';
    case 'BANKRUPTCY':
      return f.detail ? `Bankrupt: ${f.detail.replace(/^bankrupt:\s*/, '')}.` : 'Bankrupt.';
    case 'DELISTING':
      return f.detail ? `Delisted: ${f.detail}.` : 'Delisted.';
    case 'HALT':
      return f.detail ? `Trading halted: ${haltText(f.detail)}.` : 'Trading halted.';
    case 'RESUME':
      return f.detail === 'marks returned'
        ? 'Trading resumed: live prices are back.'
        : f.detail
          ? `Trading resumed: ${f.detail}.`
          : 'Trading resumed.';
    case 'RESTATEMENT':
      return f.detail ? `Restated: ${f.detail}.` : 'NAV restated.';
    case 'IPO':
      return f.detail ? `${f.detail}. IPO window open.` : 'Listed. IPO window open.';
  }
}

export interface NewsItem {
  filing: FilingView;
  /** How many filings this entry stands for (repeated margin calls fold into the newest). */
  count: number;
}

export const REPEAT_WINDOW_MS = 15 * 60_000;

/**
 * Folds repeated margin calls from the same company inside REPEAT_WINDOW_MS into the newest one,
 * so a trader hovering at the line does not flood the newsroom. Input is newest first.
 */
export function foldRepeats(
  filings: readonly FilingView[],
  windowMs = REPEAT_WINDOW_MS,
): NewsItem[] {
  const out: NewsItem[] = [];
  const open = new Map<string, NewsItem>();
  for (const f of filings) {
    if (f.kind !== 'MARGIN_CALL') {
      out.push({ filing: f, count: 1 });
      continue;
    }
    const head = open.get(f.companyId);
    if (head && head.filing.at - f.at <= windowMs) {
      head.count += 1;
      continue;
    }
    const item = { filing: f, count: 1 };
    open.set(f.companyId, item);
    out.push(item);
  }
  return out;
}

export interface FoldedFiling {
  /** The newest filing of the run (its id anchors the entry). */
  filing: FilingView;
  /** Ids of every filing the entry stands for, newest first. */
  ids: number[];
}

/**
 * Folds runs of identical consecutive filings (same company, kind and sentence, so the same
 * detail) into their newest one: a condition that is filed again and again reads as one entry
 * with a count. Input is newest first.
 */
export function foldConsecutive(filings: readonly FilingView[]): FoldedFiling[] {
  const out: FoldedFiling[] = [];
  let last: { item: FoldedFiling; key: string } | null = null;
  for (const f of filings) {
    const key = `${f.companyId}|${f.kind}|${filingText(f)}`;
    if (last && last.key === key) {
      last.item.ids.push(f.id);
      continue;
    }
    const item = { filing: f, ids: [f.id] };
    out.push(item);
    last = { item, key };
  }
  return out;
}
