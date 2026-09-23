import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import type { EventBus } from '../events';
import type { Logger } from '../log';
import type { MarketState } from '../market/state';
import type { NansenPort } from '../ports';

/** Below this, live positions come from Hyperliquid clearinghouseState (visible "credit-saver" badge). */
export const CREDIT_SAVER_AT = 1_500;
/** Below this, the scout and the IPO desk pause (applications DEFERRED with a reason). */
export const CREDIT_FLOOR = 200;

export interface CreditMonitor {
  check(): Promise<void>;
}

export function createCreditMonitor(d: {
  nansen: NansenPort;
  state: MarketState;
  repos: Repos;
  bus: EventBus;
  clock: Clock;
  log: Logger;
}): CreditMonitor {
  return {
    async check() {
      const r = await d.nansen.account();
      if (!r.ok) {
        d.log.warn('credit check failed; keeping current mode', { error: r.error });
        return;
      }
      const remaining = r.value.creditsRemaining;
      const f = d.state.flags;
      const saver = remaining < CREDIT_SAVER_AT;
      const floor = remaining < CREDIT_FLOOR;
      const changed =
        saver !== f.creditSaver || floor !== f.creditFloor || remaining !== f.creditsRemaining;
      f.creditSaver = saver;
      f.creditFloor = floor;
      f.creditsRemaining = remaining;
      d.repos.kv.setJson('credits', { remaining, at: d.clock.now() });
      if (changed) d.bus.emit({ t: 'status' });
      if (saver) d.log.warn('credit-saver mode on', { remaining, floor });
    },
  };
}
