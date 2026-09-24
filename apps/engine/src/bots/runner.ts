import { type Holding, mulberry32, multiplier } from '@whale-street/core';
import { HOUR_MS, MINUTE_MS } from '../dates';
import type { Repos } from '../db/repos';
import type { Logger } from '../log';
import type { MarketState } from '../market/state';
import type { ExchangeService } from '../services/exchange';
import type { PlayersService } from '../services/players';
import { type BotKind, type BotView, decide } from './strategies';

export const BOTS: ReadonlyArray<{ id: string; kind: BotKind; handle: string }> = [
  { id: 'bot-value', kind: 'value', handle: 'Value Fund' },
  { id: 'bot-vulture', kind: 'vulture', handle: 'Vulture Fund' },
  { id: 'bot-cohort', kind: 'cohort', handle: 'Cohort Fund' },
  { id: 'bot-momentum', kind: 'momentum', handle: 'Momentum Fund' },
  { id: 'bot-tape', kind: 'tape', handle: 'Tape Reader' },
];

export const BOT_MIN_WAIT_MS = 20_000;
export const BOT_JITTER_MS = 20_000;
/** The Tape Reader follows the NAV direction over this window. */
export const TAPE_WINDOW_MS = 5 * MINUTE_MS;

/**
 * Momentum's lookback: 1 h in LIVE; in REPLAY a quarter of the loop span (at most 1 h), so a
 * recording shorter than an hour still gives it a trend to follow.
 */
export function momentumLookbackMs(loopSpanMs: number | null): number {
  return loopSpanMs === null ? HOUR_MS : Math.min(HOUR_MS, loopSpanMs / 4);
}

export interface BotRunner {
  onTick(now: number): void;
  /** Forgets every bot's next decision time (REPLAY loop wrap: the virtual clock jumped back). */
  reset(): void;
}

export function createBotRunner(d: {
  state: MarketState;
  repos: Repos;
  exchange: ExchangeService;
  players: PlayersService;
  log: Logger;
  seed?: number;
  /** Default 1 h (LIVE); see momentumLookbackMs. */
  momentumLookbackMs?: number;
  /** REPLAY: Value also trades healthy NAV dips (see BotView.valueBuysDips). Default false. */
  valueBuysDips?: boolean;
}): BotRunner {
  const rand = mulberry32(d.seed ?? 42);
  const lookback = d.momentumLookbackMs ?? HOUR_MS;
  const nextAt = new Map<string, number>();
  for (const b of BOTS) d.players.ensureBot(b.id, b.handle);

  const navAt = (id: string, t: number) => d.repos.navPoints.atOrBefore(id, t)?.nav ?? null;

  const view = (botId: string, now: number): BotView => {
    const pf = d.exchange.portfolio(botId);
    const holdings: Record<string, Holding> = {};
    for (const h of pf.holdings) {
      holdings[h.companyId] = {
        longQty: h.longQty,
        longCost: h.longCost,
        shortQty: h.shortQty,
        shortCollateral: h.shortCollateral,
      };
    }
    return {
      cash: pf.cash,
      holdings,
      companies: d.state.listed().map((rt) => ({
        id: rt.id,
        ticker: rt.ticker,
        status: rt.status,
        mult: multiplier(rt.pool),
        hp: rt.hp,
        nav: rt.nav.nav,
        price: d.state.price(rt),
        positions: rt.nav.snapshot.positions,
        navLookback: navAt(rt.id, now - lookback),
        nav5mAgo: navAt(rt.id, now - TAPE_WINDOW_MS),
      })),
      mood: d.state.mood,
      marks: d.state.marks,
      rand,
      valueBuysDips: d.valueBuysDips ?? false,
    };
  };

  return {
    onTick(now) {
      if (d.state.flags.idle) return;
      for (const bot of BOTS) {
        const due = nextAt.get(bot.id);
        if (due === undefined) {
          nextAt.set(bot.id, now + BOT_MIN_WAIT_MS + rand() * BOT_JITTER_MS);
          continue;
        }
        if (now < due) continue;
        nextAt.set(bot.id, now + BOT_MIN_WAIT_MS + rand() * BOT_JITTER_MS);
        const order = decide(bot.kind, view(bot.id, now));
        if (!order) continue;
        const r = d.exchange.placeOrder(bot.id, order);
        if (!r.ok)
          d.log.info('bot order rejected', { bot: bot.id, ticker: order.ticker, code: r.code });
      }
    },
    reset() {
      nextAt.clear();
    },
  };
}
