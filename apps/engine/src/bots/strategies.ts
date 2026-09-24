import type { CompanyStatus, Holding, Marks, Position } from '@whale-street/core';
import type { MoodSkew } from '../ingest/mood';

export type BotKind = 'value' | 'vulture' | 'cohort' | 'momentum' | 'tape';

export interface BotCompany {
  id: string;
  ticker: string;
  status: CompanyStatus;
  mult: number;
  hp: number;
  nav: number;
  price: number;
  positions: readonly Position[];
  /**
   * NAV one momentum lookback ago (1 h in LIVE, a quarter of the loop in REPLAY; from
   * nav_points), null when there is no history yet.
   */
  navLookback: number | null;
  /** NAV five minutes ago (the Tape Reader's window), null when there is no history yet. */
  nav5mAgo: number | null;
  /**
   * Engine-clock time of this bot's latest BUY (long) or SHORT (short) into its current position
   * here; null when flat or unknown. After a REPLAY loop wrap it can lie after `now`.
   */
  heldSince: number | null;
}

export interface BotView {
  cash: number;
  holdings: Readonly<Record<string, Holding>>;
  companies: readonly BotCompany[];
  mood: ReadonlyMap<string, MoodSkew>;
  marks: Marks;
  /** Seeded PRNG in [0, 1). */
  rand: () => number;
  /**
   * REPLAY: the only hype is the bot desk's own small flow (the hype pool resets every loop), so
   * Value's hype bands are out of reach; it also trades healthy NAV dips there.
   */
  valueBuysDips: boolean;
  /** Engine clock of the decision. */
  now: number;
  /** Momentum's lookback window (see BotCompany.navLookback); also its longest holding time. */
  lookbackMs: number;
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

/** NAV change over the momentum lookback, null without history. */
const lookbackChange = (c: BotCompany) =>
  c.navLookback !== null && c.navLookback > 0 ? c.nav / c.navLookback - 1 : null;

/**
 * Buys hype discounts (μ < 0.97), sells hype premiums (μ > 1.05). With `valueBuysDips` (REPLAY)
 * it also buys the deepest NAV dip (≤ −2% over the lookback) of a healthy company (HP ≥ 50%)
 * and sells a holding once its NAV has recovered (≥ +2% over the lookback).
 */
function value(v: BotView): BotOrder | null {
  for (const c of active(v)) {
    if (longOf(v, c.id) <= EPS) continue;
    const ch = lookbackChange(c);
    if (c.mult > 1.05 || (v.valueBuysDips && ch !== null && ch > 0.02))
      return { ticker: c.ticker, side: 'SELL', qty: longOf(v, c.id) };
  }
  const discount = active(v)
    .filter((c) => c.mult < 0.97 && flat(v, c.id))
    .sort((a, b) => a.mult - b.mult)[0];
  const dip = v.valueBuysDips
    ? active(v)
        .filter((c) => c.hp >= 0.5 && flat(v, c.id))
        .map((c) => ({ c, ch: lookbackChange(c) }))
        .filter((x): x is { c: BotCompany; ch: number } => x.ch !== null && x.ch < -0.02)
        .sort((x, y) => x.ch - y.ch)[0]?.c
    : undefined;
  const pick = discount ?? dip;
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
 * Σ notional·sign(size)·sign(smartSkew) / Σ notional, over coins with a known smart skew (an
 * unknown skew is no signal).
 */
export function cohortAlignment(
  c: BotCompany,
  mood: ReadonlyMap<string, MoodSkew>,
  marks: Marks,
): number | null {
  let num = 0;
  let den = 0;
  for (const p of c.positions) {
    const smartSkew = mood.get(p.coin)?.smartSkew ?? null;
    if (smartSkew === null || p.size === 0) continue;
    const notional = Math.abs(p.size) * (marks[p.coin] ?? p.entryPx);
    num += notional * Math.sign(p.size) * Math.sign(smartSkew);
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

/**
 * Held for longer than the lookback window, or since an unknown time, or since a time after now
 * (bought in an earlier REPLAY loop: the clock went back since).
 */
const heldTooLong = (v: BotView, c: BotCompany) =>
  c.heldSince === null || c.heldSince > v.now || v.now - c.heldSince > v.lookbackMs;

/**
 * Buys an up-trend (+2% over its lookback); sells when that trend reverses (the change over the
 * lookback turns negative) or once it has held for longer than the lookback window, so it keeps
 * trading in every REPLAY loop instead of holding one position forever.
 */
function momentum(v: BotView): BotOrder | null {
  for (const c of active(v)) {
    if (longOf(v, c.id) <= EPS) continue;
    const ch = lookbackChange(c);
    if ((ch !== null && ch < 0) || heldTooLong(v, c))
      return { ticker: c.ticker, side: 'SELL', qty: longOf(v, c.id) };
  }
  const pick = active(v)
    .filter((c) => flat(v, c.id))
    .map((c) => ({ c, ch: lookbackChange(c) }))
    .filter((x): x is { c: BotCompany; ch: number } => x.ch !== null && x.ch > 0.02)
    .sort((x, y) => y.ch - x.ch)[0];
  return pick ? { ticker: pick.c.ticker, side: 'BUY', cash: stake(v, 0.03) } : null;
}

/** The Tape Reader's position cap in one company, as a fraction of its cash. */
const TAPE_CAP = 0.1;
/** At its cap it trims this fraction of the position. */
const TAPE_TRIM = 0.5;

/**
 * Tape Reader: a small trade (1–2% of cash) in the 5-minute NAV direction of one randomly picked
 * active company, long or short. Against its position it exits first; with it, it adds while the
 * position is worth less than 10% of its cash, and at that cap it trims half (takes profit), so a
 * company that only ever rises keeps it trading both ways. Needs nothing but NAV history, so it
 * works in REPLAY too.
 */
function tape(v: BotView): BotOrder | null {
  const tradable = active(v).filter((c) => c.price > 0);
  const c = tradable[Math.floor(v.rand() * tradable.length)];
  if (!c || c.nav5mAgo === null || !(c.nav5mAgo > 0)) return null;
  const dir = Math.sign(c.nav - c.nav5mAgo);
  const atCap = (qty: number) => qty * c.price >= TAPE_CAP * v.cash;
  const long = longOf(v, c.id);
  const short = shortOf(v, c.id);
  if (dir > 0) {
    if (short > EPS) return { ticker: c.ticker, side: 'COVER', qty: short };
    if (atCap(long)) return { ticker: c.ticker, side: 'SELL', qty: long * TAPE_TRIM };
    return { ticker: c.ticker, side: 'BUY', cash: stake(v, 0.01 + 0.01 * v.rand()) };
  }
  if (dir < 0) {
    if (long > EPS) return { ticker: c.ticker, side: 'SELL', qty: long };
    if (atCap(short)) return { ticker: c.ticker, side: 'COVER', qty: short * TAPE_TRIM };
    return { ticker: c.ticker, side: 'SHORT', qty: stake(v, 0.01 + 0.01 * v.rand()) / c.price };
  }
  return null;
}

const STRATEGIES: Record<BotKind, (v: BotView) => BotOrder | null> = {
  value,
  vulture,
  cohort,
  momentum,
  tape,
};

/** At most one order per decision; exits are always considered before entries. */
export function decide(kind: BotKind, v: BotView): BotOrder | null {
  return STRATEGIES[kind](v);
}
