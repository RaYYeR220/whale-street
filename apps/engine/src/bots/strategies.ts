import type { CompanyStatus, Holding, Marks, Position } from '@whale-street/core';
import type { CohortPositioning } from '@whale-street/nansen';

export type BotKind = 'value' | 'vulture' | 'cohort' | 'momentum';

export interface BotCompany {
  id: string;
  ticker: string;
  status: CompanyStatus;
  mult: number;
  hp: number;
  nav: number;
  price: number;
  positions: readonly Position[];
  /** NAV one hour ago (from nav_points), null when there is no history yet. */
  navHourAgo: number | null;
}

export interface BotView {
  cash: number;
  holdings: Readonly<Record<string, Holding>>;
  companies: readonly BotCompany[];
  mood: ReadonlyMap<string, CohortPositioning>;
  marks: Marks;
  /** Seeded PRNG in [0, 1). */
  rand: () => number;
}

export type BotOrder =
  | { ticker: string; side: 'BUY'; cash: number }
  | { ticker: string; side: 'SELL' | 'SHORT' | 'COVER'; qty: number };

const EPS = 1e-9;
const longOf = (v: BotView, id: string) => v.holdings[id]?.longQty ?? 0;
const shortOf = (v: BotView, id: string) => v.holdings[id]?.shortQty ?? 0;
const flat = (v: BotView, id: string) => longOf(v, id) < EPS && shortOf(v, id) < EPS;
const active = (v: BotView) => v.companies.filter((c) => c.status === 'ACTIVE');
const stake = (v: BotView, frac: number) => v.cash * frac;

/** Buys hype discounts (μ < 0.97), sells hype premiums (μ > 1.05). */
function value(v: BotView): BotOrder | null {
  for (const c of active(v))
    if (longOf(v, c.id) > EPS && c.mult > 1.05)
      return { ticker: c.ticker, side: 'SELL', qty: longOf(v, c.id) };
  const pick = active(v)
    .filter((c) => c.mult < 0.97 && flat(v, c.id))
    .sort((a, b) => a.mult - b.mult)[0];
  return pick ? { ticker: pick.ticker, side: 'BUY', cash: stake(v, 0.02 + 0.02 * v.rand()) } : null;
}

/** Shorts traders close to liquidation (HP < 25%), covers on recovery (HP > 50%). */
function vulture(v: BotView): BotOrder | null {
  for (const c of active(v))
    if (shortOf(v, c.id) > EPS && c.hp > 0.5)
      return { ticker: c.ticker, side: 'COVER', qty: shortOf(v, c.id) };
  const pick = active(v)
    .filter((c) => c.hp < 0.25 && flat(v, c.id) && c.price > 0)
    .sort((a, b) => a.hp - b.hp)[0];
  return pick ? { ticker: pick.ticker, side: 'SHORT', qty: stake(v, 0.03) / pick.price } : null;
}

/**
 * Alignment of a company's open positions with the smart-trader cohort:
 * Σ notional·sign(size)·sign(smartLongs − smartShorts) / Σ notional, over coins with mood data.
 */
export function cohortAlignment(
  c: BotCompany,
  mood: ReadonlyMap<string, CohortPositioning>,
  marks: Marks,
): number | null {
  let num = 0;
  let den = 0;
  for (const p of c.positions) {
    const m = mood.get(p.coin);
    if (!m || p.size === 0) continue;
    const notional = Math.abs(p.size) * (marks[p.coin] ?? p.entryPx);
    num += notional * Math.sign(p.size) * Math.sign(m.smartLongs - m.smartShorts);
    den += notional;
  }
  return den > 0 ? num / den : null;
}

/** Buys companies aligned with the smart-money cohort (> 0.5), sells misaligned ones (< −0.2). */
function cohort(v: BotView): BotOrder | null {
  for (const c of active(v)) {
    const a = cohortAlignment(c, v.mood, v.marks);
    if (longOf(v, c.id) > EPS && a !== null && a < -0.2)
      return { ticker: c.ticker, side: 'SELL', qty: longOf(v, c.id) };
  }
  const scored = active(v)
    .filter((c) => flat(v, c.id))
    .map((c) => ({ c, a: cohortAlignment(c, v.mood, v.marks) }))
    .filter((x): x is { c: BotCompany; a: number } => x.a !== null && x.a > 0.5)
    .sort((x, y) => y.a - x.a)[0];
  return scored ? { ticker: scored.c.ticker, side: 'BUY', cash: stake(v, 0.03) } : null;
}

/** Follows the 1-hour NAV trend (±2%). */
function momentum(v: BotView): BotOrder | null {
  const change = (c: BotCompany) =>
    c.navHourAgo !== null && c.navHourAgo > 0 ? c.nav / c.navHourAgo - 1 : null;
  for (const c of active(v)) {
    const ch = change(c);
    if (longOf(v, c.id) > EPS && ch !== null && ch < -0.02)
      return { ticker: c.ticker, side: 'SELL', qty: longOf(v, c.id) };
  }
  const pick = active(v)
    .filter((c) => flat(v, c.id))
    .map((c) => ({ c, ch: change(c) }))
    .filter((x): x is { c: BotCompany; ch: number } => x.ch !== null && x.ch > 0.02)
    .sort((x, y) => y.ch - x.ch)[0];
  return pick ? { ticker: pick.c.ticker, side: 'BUY', cash: stake(v, 0.03) } : null;
}

const STRATEGIES: Record<BotKind, (v: BotView) => BotOrder | null> = {
  value,
  vulture,
  cohort,
  momentum,
};

/** At most one order per decision; exits are always considered before entries. */
export function decide(kind: BotKind, v: BotView): BotOrder | null {
  return STRATEGIES[kind](v);
}
