/**
 * The Floor as a manga page: fixed panel slots, companies poured in by prominence for the active
 * sort. Halted and bankrupt companies are pinned to the last slots so they never vanish silently.
 */
import type { Rating } from '@whale-street/core';
import type { DisplayCompany } from './company';
import { pct } from './format';

export type SortKey = 'movers' | 'hype' | 'nearliq' | 'new' | 'rated';
export type PanelSize = 'xl' | 'l' | 'm' | 's';

export interface Slot {
  size: PanelSize;
  col: string;
  row: string;
}

export const SLOTS: readonly Slot[] = [
  { size: 'xl', col: '1 / span 6', row: '1 / span 2' },
  { size: 'l', col: '7 / span 6', row: '1' },
  { size: 's', col: '7 / span 3', row: '2' },
  { size: 's', col: '10 / span 3', row: '2' },
  { size: 'l', col: '1 / span 6', row: '3' },
  { size: 's', col: '7 / span 3', row: '3' },
  { size: 's', col: '10 / span 3', row: '3' },
  { size: 'm', col: '1 / span 4', row: '4' },
  { size: 'm', col: '5 / span 4', row: '4' },
  { size: 'm', col: '9 / span 4', row: '4' },
  { size: 's', col: '1 / span 3', row: '5' },
  { size: 's', col: '4 / span 3', row: '5' },
  { size: 'l', col: '7 / span 6', row: '5' },
  { size: 'm', col: '1 / span 4', row: '6' },
  { size: 'm', col: '5 / span 4', row: '6' },
  { size: 'm', col: '9 / span 4', row: '6' },
];
/** Slot index for the n-th ranked company. */
export const PROMINENCE: readonly number[] = [0, 1, 4, 12, 7, 8, 9, 13, 2, 3, 5, 6, 10, 11];
export const PINNED_SLOTS: readonly number[] = [14, 15];

export const RATING_SCORE: Record<Rating, number> = {
  AAA: 7,
  AA: 6,
  A: 5,
  BBB: 4,
  BB: 3,
  B: 2,
  CCC: 1,
};

export interface Why {
  text: string;
  tone: '' | 'pink' | 'red';
}

export interface Ranked {
  order: DisplayCompany[];
  pinned: DisplayCompany[];
  why: Record<string, Why>;
}

const val = (v: number | null, fallback = Number.NEGATIVE_INFINITY) =>
  v === null || !Number.isFinite(v) ? fallback : v;

export function rank(
  companies: readonly DisplayCompany[],
  sort: SortKey,
  now: number | null,
): Ranked {
  const live = companies.filter((c) => c.display === 'active' || c.display === 'ipo');
  const score: Record<SortKey, (c: DisplayCompany) => number> = {
    movers: (c) => Math.abs(val(c.priceChg1h, 0)),
    hype: (c) => val(c.hype),
    nearliq: (c) => 1 - val(c.hp, 1),
    new: (c) => val(c.listedAt),
    rated: (c) => (c.rating ? RATING_SCORE[c.rating] : 0) * 10 + val(c.hp, 0),
  };
  let order = [...live].sort((a, b) => score[sort](b) - score[sort](a));
  const why: Record<string, Why> = {};
  if (sort === 'movers' && order.length > 0) {
    const [top, ...rest] = order as [DisplayCompany, ...DisplayCompany[]];
    // Only call something out when there is something to call out.
    const hypeTop = [...rest]
      .filter((c) => val(c.hype) >= 0.001)
      .sort((a, b) => val(b.hype) - val(a.hype))[0];
    const liqTop = rest
      .filter((c) => c !== hypeTop && c.hp !== null && c.hp < 0.5)
      .sort((a, b) => val(a.hp, 1) - val(b.hp, 1))[0];
    const ipo = rest.find((c) => c.display === 'ipo' && c !== hypeTop && c !== liqTop);
    const specials = [liqTop, hypeTop, ipo].filter((c): c is DisplayCompany => !!c);
    order = [top, ...specials, ...rest.filter((c) => !specials.includes(c))];
    if (top.priceChg1h !== null && Math.abs(top.priceChg1h) >= 0.001)
      why[top.ticker] = { text: `Top mover, ${pct(top.priceChg1h)} this hour`, tone: '' };
    else if (top.display === 'ipo' && top.listedAt !== null && now !== null)
      why[top.ticker] = {
        text: `New listing, ${Math.max(0, Math.round((now - top.listedAt) / 60_000))} min old`,
        tone: '',
      };
    if (liqTop && liqTop.hp !== null)
      why[liqTop.ticker] = {
        text: `Closest to liquidation, ${Math.round(liqTop.hp * 100)}% HP left`,
        tone: 'red',
      };
    if (hypeTop)
      why[hypeTop.ticker] = { text: `Biggest hype, ${pct(hypeTop.hype)} over NAV`, tone: 'pink' };
    if (ipo && ipo.listedAt !== null && now !== null)
      why[ipo.ticker] = {
        text: `New listing, ${Math.max(0, Math.round((now - ipo.listedAt) / 60_000))} min old`,
        tone: '',
      };
  } else {
    for (const c of order.slice(0, 4)) {
      const days =
        c.listedAt !== null && now !== null ? Math.floor((now - c.listedAt) / 86_400_000) : null;
      const text =
        sort === 'hype'
          ? `Hype ${pct(c.hype)} over NAV`
          : sort === 'nearliq'
            ? `${c.hp === null ? '—' : Math.round(c.hp * 100)}% HP left`
            : sort === 'new'
              ? days === null
                ? 'Recently listed'
                : days === 0
                  ? 'Listed today'
                  : `Listed ${days} day${days === 1 ? '' : 's'} ago`
              : c.rating
                ? `Rated ${c.rating} by the committee`
                : 'Not rated';
      why[c.ticker] = { text, tone: sort === 'nearliq' ? 'red' : sort === 'hype' ? 'pink' : '' };
    }
  }
  const pinned = [
    ...companies.filter((c) => c.display === 'halted'),
    ...companies.filter((c) => c.display === 'bankrupt' || c.display === 'delisted'),
  ];
  return { order, pinned, why };
}

export interface Placement {
  company: DisplayCompany;
  slot: Slot;
}

/** Panels for the roster. While searching, the page re-flows compactly in attention order. */
export function place(ranked: Ranked, query: string): Placement[] {
  const q = query.trim().toLowerCase();
  const match = (c: DisplayCompany) =>
    !q || c.ticker.toLowerCase().includes(q) || c.name.toLowerCase().includes(q);
  const order = ranked.order.filter(match);
  const pins = ranked.pinned.filter(match);
  if (q) {
    const list = [...order, ...pins];
    return list.map((company, i) => {
      const size: PanelSize = i === 0 && list.length > 2 ? 'xl' : i < 3 ? 'l' : 'm';
      const span = size === 'm' ? 4 : 6;
      return {
        company,
        slot: { size, col: `auto / span ${span}`, row: size === 'xl' ? 'auto / span 2' : 'auto' },
      };
    });
  }
  const out: Placement[] = [];
  const placed = new Map<number, DisplayCompany>();
  const total = order.length + pins.length;
  if (total >= SLOTS.length) {
    order.forEach((c, i) => {
      const idx = PROMINENCE[i];
      if (idx !== undefined) placed.set(idx, c);
    });
    pins.forEach((c, i) => {
      const idx = PINNED_SLOTS[i];
      if (idx !== undefined) placed.set(idx, c);
    });
  } else {
    // A short roster fills the first slots of the page so no hole opens above the last row:
    // pinned companies take the last of those slots, the rest go biggest-first by prominence.
    const pinSlots = pins.map((_, i) => total - 1 - i);
    const free = PROMINENCE.filter((idx) => idx < total && !pinSlots.includes(idx));
    order.forEach((c, i) => {
      const idx = free[i];
      if (idx !== undefined) placed.set(idx, c);
    });
    pins.forEach((c, i) => {
      const idx = pinSlots[i];
      if (idx !== undefined) placed.set(idx, c);
    });
  }
  SLOTS.forEach((slot, i) => {
    const c = placed.get(i);
    if (c) out.push({ company: c, slot });
  });
  // More companies than slots: keep them visible as medium panels after the page.
  const shown = new Set(out.map((p) => p.company.ticker));
  for (const c of [...order, ...pins]) {
    if (shown.has(c.ticker)) continue;
    out.push({ company: c, slot: { size: 'm', col: 'auto / span 4', row: 'auto' } });
  }
  return out;
}
