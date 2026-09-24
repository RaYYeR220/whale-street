import { PARAMS, type Params } from './params';
import { type Address, type Marks, type Maybe, type Position, RATINGS, type Rating } from './types';
import { isSanePosition, isValidPx } from './validity';

export interface PnlStats {
  realizedPnlUsd: number;
  feesUsd: number;
  /** Fraction in [0, 1]. */
  winRate: number;
  /** Nansen `closed_trade_count`: counts closing FILLS (47,399 vs 8,036 trades live), not round trips. */
  closedTrades: number;
  tradedTimes: number;
  topCoins: string[];
}

export interface LinkedWallet {
  address: Address;
  relation: 'related' | 'first_funder' | 'counterparty';
  positions: Maybe<readonly Position[]>;
}

export interface ListingEvidence {
  address: Address;
  now: number;
  /** First Hyperliquid perp fill (spot fills excluded); null when the address has no perp fill. */
  firstTradeAt: Maybe<number | null>;
  pnl: Maybe<PnlStats>;
  /** Largest single realized trade PnL; null when there are no closed trades. */
  topTradePnlUsd: Maybe<number | null>;
  equityUsd: Maybe<number>;
  positions: Maybe<readonly Position[]>;
  linked: Maybe<readonly LinkedWallet[]>;
  isVault: Maybe<boolean>;
  marks: Marks;
  alreadyListed: boolean;
  cooldownUntil: number | null;
}

export type CheckId =
  | 'TRACK_RECORD'
  | 'SIZE'
  | 'HUMAN_TRADER'
  | 'HIDDEN_HEDGE'
  | 'CONCENTRATION'
  | 'UNIQUENESS';
export type CheckStatus = 'PASS' | 'FAIL' | 'FLAG' | 'UNKNOWN';
export interface CheckResult {
  id: CheckId;
  status: CheckStatus;
  detail: string;
}
export interface HedgeLink {
  address: Address;
  coin: string;
  side: 'LONG' | 'SHORT';
  notionalUsd: number;
}
export type Decision = 'APPROVED' | 'DENIED' | 'DEFERRED';
export interface Prospectus {
  style: 'Scalper' | 'Day Trader' | 'Swing Trader' | 'Position Trader';
  historyDays: number;
  winRate: number;
  realizedPnlBand: string;
  avgLeverage: number;
  favoriteCoins: string[];
  linkedWallets: number;
}
export interface ListingVerdict {
  decision: Decision;
  checks: CheckResult[];
  rating: Rating | null;
  prospectus: Prospectus | null;
  hedgeLinks: HedgeLink[];
}

const DAY_MS = 86_400_000;
const unknown = (id: CheckId, why: string): CheckResult => ({
  id,
  status: 'UNKNOWN',
  detail: `evidence unavailable: ${why}`,
});
/** Position price = live mark if valid, else the reported entryPx if valid, else unpriceable. */
function priceOf(p: Position, marks: Marks): number | null {
  const m = marks[p.coin];
  if (isValidPx(m)) return m;
  if (isValidPx(p.entryPx)) return p.entryPx;
  return null;
}

/** Notional-weighted average leverage; skips positions with no usable price. */
export function avgLeverage(positions: readonly Position[], marks: Marks): number {
  let notional = 0;
  let weighted = 0;
  for (const p of positions) {
    const price = priceOf(p, marks);
    if (price === null) continue;
    const n = Math.abs(p.size) * price;
    notional += n;
    weighted += n * p.leverage;
  }
  return notional > 0 ? weighted / notional : 1;
}

export function ratingScore(i: {
  winRate: number;
  historyDays: number;
  realizedPnlUsd: number;
  avgLeverage: number;
  equityUsd: number;
}): number {
  const win = Math.min(1, Math.max(0, i.winRate)) * 30;
  const hist = Math.min(1, Math.max(0, i.historyDays / 180)) * 20;
  const pnl =
    i.realizedPnlUsd <= 0 ? 0 : Math.min(1, Math.log10(1 + i.realizedPnlUsd / 10_000) / 2) * 20;
  const lev = i.avgLeverage <= 3 ? 15 : i.avgLeverage <= 10 ? 10 : i.avgLeverage <= 25 ? 5 : 0;
  const eq =
    i.equityUsd >= 1_000_000 ? 15 : i.equityUsd >= 250_000 ? 10 : i.equityUsd >= 25_000 ? 5 : 0;
  return win + hist + pnl + lev + eq;
}

export function scoreToRating(score: number, params: Params = PARAMS): Rating {
  const t = params.committee.ratingThresholds;
  if (score >= t.AAA) return 'AAA';
  if (score >= t.AA) return 'AA';
  if (score >= t.A) return 'A';
  if (score >= t.BBB) return 'BBB';
  if (score >= t.BB) return 'BB';
  if (score >= t.B) return 'B';
  return 'CCC';
}

export function downgrade(r: Rating, notches: number): Rating {
  const i = Math.min(RATINGS.length - 1, RATINGS.indexOf(r) + Math.max(0, notches));
  return RATINGS[i] as Rating;
}

function pnlBand(usd: number, bands: Params['committee']['pnlBands']): string {
  if (usd < 0) return 'Net loss';
  if (usd < bands.under10k) return 'Under $10k';
  if (usd < bands.under100k) return '$10k–$100k';
  if (usd < bands.under1m) return '$100k–$1M';
  if (usd < bands.under10m) return '$1M–$10M';
  return '$10M+';
}

/**
 * Average minutes per trade over the history: divided by the smaller of closing fills and trades,
 * since one trade closes over many fills (never below 1).
 */
function avgHoldMinutes(days: number, pnl: PnlStats): number {
  return (days * 1_440) / Math.max(1, Math.min(pnl.closedTrades, pnl.tradedTimes));
}

function styleOf(
  avgHoldMinutes: number,
  minutes: Params['committee']['styleMinutes'],
): Prospectus['style'] {
  if (avgHoldMinutes < minutes.scalper) return 'Scalper';
  if (avgHoldMinutes < minutes.dayTrader) return 'Day Trader';
  if (avgHoldMinutes < minutes.swingTrader) return 'Swing Trader';
  return 'Position Trader';
}

export function evaluateListing(ev: ListingEvidence, params: Params = PARAMS): ListingVerdict {
  const c = params.committee;
  const checks: CheckResult[] = [];
  const hedgeLinks: HedgeLink[] = [];
  const history =
    ev.firstTradeAt.ok && ev.firstTradeAt.value !== null
      ? (ev.now - ev.firstTradeAt.value) / DAY_MS
      : null;

  // 1. Track record
  if (!ev.firstTradeAt.ok) checks.push(unknown('TRACK_RECORD', ev.firstTradeAt.error));
  else if (!ev.pnl.ok) checks.push(unknown('TRACK_RECORD', ev.pnl.error));
  else if (history === null)
    checks.push({ id: 'TRACK_RECORD', status: 'FAIL', detail: 'no Hyperliquid perp fills found' });
  else {
    const passed = history >= c.minHistoryDays && ev.pnl.value.closedTrades >= c.minClosedTrades;
    checks.push({
      id: 'TRACK_RECORD',
      status: passed ? 'PASS' : 'FAIL',
      detail: `${Math.floor(history)} days, ${ev.pnl.value.closedTrades} closed trades (min ${c.minHistoryDays} days, ${c.minClosedTrades} trades)`,
    });
  }

  // 2. Size
  if (!ev.equityUsd.ok) checks.push(unknown('SIZE', ev.equityUsd.error));
  else {
    const passed = ev.equityUsd.value >= c.minEquityUsd;
    checks.push({
      id: 'SIZE',
      status: passed ? 'PASS' : 'FAIL',
      detail: `equity $${Math.round(ev.equityUsd.value).toLocaleString('en-US')} (min $${c.minEquityUsd.toLocaleString('en-US')})`,
    });
  }

  // 3. Human trader
  if (!ev.pnl.ok) checks.push(unknown('HUMAN_TRADER', ev.pnl.error));
  else if (!ev.firstTradeAt.ok) checks.push(unknown('HUMAN_TRADER', ev.firstTradeAt.error));
  else {
    const days = Math.max(1, history ?? 0);
    const perDay = ev.pnl.value.tradedTimes / days;
    const hold = avgHoldMinutes(days, ev.pnl.value);
    const mmProfile = !(perDay <= c.maxTradesPerDay && hold >= c.minAvgHoldMinutes);
    if (mmProfile) {
      // A market-maker profile is disqualifying on its own; no need to know isVault.
      checks.push({
        id: 'HUMAN_TRADER',
        status: 'FAIL',
        detail: `market-maker profile: ${perDay.toFixed(0)} trades/day, ~${hold.toFixed(1)} min per trade`,
      });
    } else if (!ev.isVault.ok) {
      checks.push(unknown('HUMAN_TRADER', ev.isVault.error));
    } else if (ev.isVault.value) {
      checks.push({ id: 'HUMAN_TRADER', status: 'FAIL', detail: 'address is a vault' });
    } else {
      checks.push({
        id: 'HUMAN_TRADER',
        status: 'PASS',
        detail: `${perDay.toFixed(1)} trades/day`,
      });
    }
  }

  // 4. Hidden hedge
  if (!ev.positions.ok) checks.push(unknown('HIDDEN_HEDGE', ev.positions.error));
  else if (!ev.linked.ok) checks.push(unknown('HIDDEN_HEDGE', ev.linked.error));
  else {
    const appUnusable = ev.positions.value.some(
      (p) => p.size !== 0 && (!isSanePosition(p) || priceOf(p, ev.marks) === null),
    );
    if (appUnusable) {
      checks.push(unknown('HIDDEN_HEDGE', 'applicant position data is invalid'));
    } else {
      const app = new Map<string, { side: number; notional: number }>();
      for (const p of ev.positions.value) {
        if (p.size === 0) continue;
        const price = priceOf(p, ev.marks);
        if (price === null) continue; // unreachable: appUnusable already ruled this out
        app.set(p.coin, { side: Math.sign(p.size), notional: Math.abs(p.size) * price });
      }

      const linkedUnusable = ev.linked.value.some(
        (l) =>
          l.positions.ok &&
          l.positions.value.some(
            (p) =>
              app.has(p.coin) &&
              p.size !== 0 &&
              (!isSanePosition(p) || priceOf(p, ev.marks) === null),
          ),
      );
      if (linkedUnusable) {
        checks.push(unknown('HIDDEN_HEDGE', 'a linked wallet position is invalid'));
      } else {
        const opp = new Map<string, number>();
        const links: HedgeLink[] = [];
        for (const l of ev.linked.value) {
          if (!l.positions.ok) continue;
          for (const p of l.positions.value) {
            const a = app.get(p.coin);
            if (!a || p.size === 0 || Math.sign(p.size) === a.side) continue;
            const price = priceOf(p, ev.marks);
            if (price === null) continue; // unreachable: linkedUnusable already ruled this out
            const n = Math.abs(p.size) * price;
            opp.set(p.coin, (opp.get(p.coin) ?? 0) + n);
            links.push({
              address: l.address,
              coin: p.coin,
              side: p.size > 0 ? 'LONG' : 'SHORT',
              notionalUsd: n,
            });
          }
        }
        let total = 0;
        let covered = 0;
        for (const [coin, a] of app) {
          total += a.notional;
          covered += Math.min(a.notional, opp.get(coin) ?? 0);
        }
        const ratio = total > 0 ? covered / total : 0;
        const failed = total > 0 && ratio >= c.hedgeOffsetThreshold;
        const failedLink = ev.linked.value.find((l) => !l.positions.ok);

        if (failed) {
          // Monotonic: the offset already proven from the wallets that DID load is enough to
          // deny, regardless of any other wallet that failed to load.
          checks.push({
            id: 'HIDDEN_HEDGE',
            status: 'FAIL',
            detail: `${Math.round(ratio * 100)}% of exposure offset by linked wallets`,
          });
          hedgeLinks.push(...links);
        } else if (failedLink && !failedLink.positions.ok) {
          checks.push(
            unknown('HIDDEN_HEDGE', `${failedLink.address}: ${failedLink.positions.error}`),
          );
        } else {
          checks.push({
            id: 'HIDDEN_HEDGE',
            status: 'PASS',
            detail:
              total === 0
                ? 'no open exposure'
                : `${Math.round(ratio * 100)}% of exposure offset by linked wallets`,
          });
        }
      }
    }
  }

  // 5. Concentration
  if (!ev.pnl.ok) checks.push(unknown('CONCENTRATION', ev.pnl.error));
  else if (!ev.topTradePnlUsd.ok) checks.push(unknown('CONCENTRATION', ev.topTradePnlUsd.error));
  else {
    const realized = ev.pnl.value.realizedPnlUsd;
    const top = ev.topTradePnlUsd.value;
    const share = realized > 0 && top !== null ? top / realized : 0;
    const flagged = share >= c.concentrationThreshold;
    checks.push({
      id: 'CONCENTRATION',
      status: flagged ? 'FLAG' : 'PASS',
      detail: flagged
        ? `one-hit wonder: ${Math.round(share * 100)}% of profit from one trade`
        : 'profit spread across trades',
    });
  }

  // 6. Uniqueness
  if (ev.alreadyListed) checks.push({ id: 'UNIQUENESS', status: 'FAIL', detail: 'already listed' });
  else if (ev.cooldownUntil !== null && ev.cooldownUntil > ev.now) {
    checks.push({ id: 'UNIQUENESS', status: 'FAIL', detail: 'bankruptcy cooldown in effect' });
  } else checks.push({ id: 'UNIQUENESS', status: 'PASS', detail: 'not listed' });

  const decision: Decision = checks.some((x) => x.status === 'FAIL')
    ? 'DENIED'
    : checks.some((x) => x.status === 'UNKNOWN')
      ? 'DEFERRED'
      : 'APPROVED';

  let prospectus: Prospectus | null = null;
  if (ev.pnl.ok && ev.positions.ok && history !== null) {
    const hold = avgHoldMinutes(Math.max(1, history), ev.pnl.value);
    prospectus = {
      style: styleOf(hold, c.styleMinutes),
      historyDays: Math.floor(history),
      winRate: ev.pnl.value.winRate,
      realizedPnlBand: pnlBand(ev.pnl.value.realizedPnlUsd, c.pnlBands),
      avgLeverage: avgLeverage(ev.positions.value, ev.marks),
      favoriteCoins: ev.pnl.value.topCoins.slice(0, 3),
      linkedWallets: ev.linked.ok ? ev.linked.value.length : 0,
    };
  }

  let rating: Rating | null = null;
  if (
    decision === 'APPROVED' &&
    ev.pnl.ok &&
    ev.equityUsd.ok &&
    ev.positions.ok &&
    history !== null
  ) {
    const base = scoreToRating(
      ratingScore({
        winRate: ev.pnl.value.winRate,
        historyDays: history,
        realizedPnlUsd: ev.pnl.value.realizedPnlUsd,
        avgLeverage: avgLeverage(ev.positions.value, ev.marks),
        equityUsd: ev.equityUsd.value,
      }),
      params,
    );
    const flagged = checks.some((x) => x.id === 'CONCENTRATION' && x.status === 'FLAG');
    rating = flagged ? downgrade(base, c.concentrationNotches) : base;
  }

  return { decision, checks, rating, prospectus, hedgeLinks };
}
