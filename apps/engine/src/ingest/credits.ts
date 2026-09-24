import type { ApiResult, CallRecord } from '@whale-street/nansen';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import type { EventBus } from '../events';
import type { Logger } from '../log';
import type { MarketState } from '../market/state';
import type { NansenPort } from '../ports';

/**
 * Default: below this, live positions come from Hyperliquid clearinghouseState (visible
 * "credit-saver" badge). Configurable with CREDIT_SAVER_AT.
 */
export const CREDIT_SAVER_AT = 1_500;
/**
 * Default: below this, the scout and the IPO desk pause (applications DEFERRED with a reason).
 * Configurable with CREDIT_FLOOR.
 */
export const CREDIT_FLOOR = 200;
/** After a data call is refused for credits, further refusals within this window share one check. */
export const CREDIT_ALARM_DEBOUNCE_MS = 60_000;

export interface CreditThresholds {
  saverAt: number;
  floor: number;
}

export interface CreditMonitor {
  check(): Promise<void>;
  /**
   * A data call was refused for lack of credits: checks the account right away (one check per
   * burst). If that check fails too, credit-saver goes on rather than keeping the current mode.
   */
  alarm(): void;
  /**
   * The balance a Nansen response just reported (`x-nansen-credits-remaining`). It is applied at
   * once; an `/account` read that was asked before it (`/account` lags) does not overwrite it.
   */
  observe(remaining: number): void;
}

/**
 * A Nansen refusal for lack of credits: the `insufficient_credits` error code (HTTP 403 live) or
 * HTTP 402; the message wording is only a fallback.
 */
export function isCreditError(r: ApiResult<unknown>): boolean {
  if (r.ok) return false;
  return (
    /\binsufficient_credits\b/.test(r.error) ||
    r.status === 402 ||
    /insufficient[_\s-]?credits/i.test(r.error)
  );
}

/** Relays the balance every Nansen response reports (`x-nansen-credits-remaining`). */
export interface CreditHeaderFeed {
  /** One finished call (from `NansenHttp`'s `onCall`); a call without the header is ignored. */
  push(r: Pick<CallRecord, 'creditsRemaining'>): void;
  subscribe(fn: (remaining: number) => void): void;
}

export function createCreditHeaderFeed(): CreditHeaderFeed {
  const subscribers: Array<(remaining: number) => void> = [];
  return {
    push(r) {
      const n = r.creditsRemaining;
      if (n !== null) for (const fn of subscribers) fn(n);
    },
    subscribe(fn) {
      subscribers.push(fn);
    },
  };
}

/** The same port, raising `alarm` whenever a call comes back refused for credits. */
export function withCreditAlarm(port: NansenPort, alarm: () => void): NansenPort {
  const watch =
    <A extends unknown[], T>(call: (...args: A) => Promise<ApiResult<T>>) =>
    async (...args: A): Promise<ApiResult<T>> => {
      const r = await call(...args);
      if (isCreditError(r)) alarm();
      return r;
    };
  return {
    perpPositions: watch(port.perpPositions.bind(port)),
    perpPnlSummary: watch(port.perpPnlSummary.bind(port)),
    perpTrades: watch(port.perpTrades.bind(port)),
    perpLeaderboard: watch(port.perpLeaderboard.bind(port)),
    smartMoneyPerpTrades: watch(port.smartMoneyPerpTrades.bind(port)),
    positionIntelligence: watch(port.positionIntelligence.bind(port)),
    relatedWallets: watch(port.relatedWallets.bind(port)),
    firstFunder: watch(port.firstFunder.bind(port)),
    counterparties: watch(port.counterparties.bind(port)),
    account: port.account.bind(port),
  };
}

export function createCreditMonitor(d: {
  nansen: NansenPort;
  state: MarketState;
  repos: Repos;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  /** Registers the alarm's background check (tests and shutdown await it). */
  track?: (p: Promise<unknown>) => void;
  /** Credit-saver and floor thresholds (default CREDIT_SAVER_AT / CREDIT_FLOOR). */
  thresholds?: CreditThresholds;
}): CreditMonitor {
  const { saverAt, floor: floorAt } = d.thresholds ?? {
    saverAt: CREDIT_SAVER_AT,
    floor: CREDIT_FLOOR,
  };
  let alarmAt = Number.NEGATIVE_INFINITY;
  let alarmCheck: Promise<void> | null = null;
  /** When the newest balance header was seen (engine clock). */
  let headerAt = Number.NEGATIVE_INFINITY;

  /** Sets the balance and the modes it implies (a status event when anything changed). */
  const apply = (remaining: number): void => {
    const f = d.state.flags;
    const saver = remaining < saverAt;
    const floor = remaining < floorAt;
    const changed =
      saver !== f.creditSaver || floor !== f.creditFloor || remaining !== f.creditsRemaining;
    f.creditSaver = saver;
    f.creditFloor = floor;
    f.creditsRemaining = remaining;
    d.repos.kv.setJson('credits', { remaining, at: d.clock.now() });
    if (changed) d.bus.emit({ t: 'status' });
  };

  const check = async (failClosed: boolean): Promise<void> => {
    const askedAt = d.clock.now();
    const r = await d.nansen
      .account()
      .catch((err: unknown) => ({ ok: false as const, error: String(err) }));
    const f = d.state.flags;
    if (!r.ok) {
      if (!failClosed) {
        d.log.warn('credit check failed; keeping current mode', { error: r.error });
        return;
      }
      // Credits just ran out on a data call and the balance is unknown: stop spending.
      d.log.warn('credit check failed after a credit error; credit-saver mode on', {
        error: r.error,
      });
      if (!f.creditSaver) {
        f.creditSaver = true;
        d.bus.emit({ t: 'status' });
      }
      return;
    }
    const remaining = r.value.creditsRemaining;
    if (headerAt >= askedAt) {
      // A response reported the balance after this read was asked: that figure is fresher.
      d.log.info('account balance is older than the latest credits header; keeping the header', {
        account: remaining,
        header: f.creditsRemaining,
      });
      return;
    }
    apply(remaining);
    if (f.creditSaver) d.log.warn('credit-saver mode on', { remaining, floor: f.creditFloor });
  };

  return {
    check: () => check(false),
    observe(remaining) {
      headerAt = d.clock.now();
      apply(remaining);
    },
    alarm() {
      const now = d.clock.now();
      if (alarmCheck || now - alarmAt < CREDIT_ALARM_DEBOUNCE_MS) return;
      alarmAt = now;
      d.log.warn('Nansen refused a call for credits; checking the account now');
      const p = check(true)
        .catch((err: unknown) => d.log.error('credit check failed', { error: String(err) }))
        .finally(() => {
          alarmCheck = null;
        });
      alarmCheck = p;
      d.track?.(p);
    },
  };
}
