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
/**
 * The first decision round after the market opens (boot, a wake from IDLE, the MARKET_PAUSED
 * state clearing on the first fresh tick, a REPLAY wrap) comes within this window of that tick,
 * so within 5 s of the event on the 1 Hz loop: the tape moves in a visitor's first minute instead
 * of after a full 20–40 s wait.
 */
export const BOT_FIRST_ROUND_MS = 4_000;
/** The Tape Reader follows the NAV direction over this window. */
export const TAPE_WINDOW_MS = 5 * MINUTE_MS;
/** A bot's recent trades searched for the ones that opened its current positions. */
const OPENING_TRADES_SCAN = 200;

/**
 * Momentum's lookback: 1 h in LIVE; in REPLAY a quarter of the loop span (at most 1 h), so a
 * recording shorter than an hour still gives it a trend to follow.
 */
export function momentumLookbackMs(loopSpanMs: number | null): number {
  return loopSpanMs === null ? HOUR_MS : Math.min(HOUR_MS, loopSpanMs / 4);
}

export interface BotRunner {
  /** Skips while the market is paused (MarketState.paused): a refused order would waste a round. */
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
  /** The market was paused at the last tick (it is at boot: it opens on the first fresh tick). */
  let wasPaused = true;
  const soon = (now: number) => now + rand() * BOT_FIRST_ROUND_MS;
  for (const b of BOTS) d.players.ensureBot(b.id, b.handle);

  const navAt = (id: string, t: number) => d.repos.navPoints.atOrBefore(id, t)?.nav ?? null;

  /** Per held company: when the bot last added to its position (its latest BUY or SHORT there). */
  const openedAt = (botId: string, holdings: Record<string, Holding>): Map<string, number> => {
    const at = new Map<string, number>();
    for (const t of d.repos.trades.forPlayer(botId, OPENING_TRADES_SCAN)) {
      const h = holdings[t.companyId];
      if (!h || t.forced || at.has(t.companyId)) continue;
      if ((t.side === 'BUY' && h.longQty > 0) || (t.side === 'SHORT' && h.shortQty > 0))
        at.set(t.companyId, t.at);
    }
    return at;
  };

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
    const opened = openedAt(botId, holdings);
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
        heldSince: opened.get(rt.id) ?? null,
      })),
      mood: d.state.mood,
      marks: d.state.marks,
      rand,
      valueBuysDips: d.valueBuysDips ?? false,
      now,
      lookbackMs: lookback,
    };
  };

  return {
    onTick(now) {
      if (d.state.paused()) {
        wasPaused = true;
        return;
      }
      if (wasPaused) {
        wasPaused = false;
        for (const bot of BOTS) nextAt.set(bot.id, soon(now));
      }
      for (const bot of BOTS) {
        const due = nextAt.get(bot.id);
        if (due === undefined) {
          nextAt.set(bot.id, soon(now));
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
