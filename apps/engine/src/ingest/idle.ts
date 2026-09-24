import type { EventBus } from '../events';
import type { MarketState } from '../market/state';

/** No WS viewer for this long → IDLE (Nansen polling stops, NAV freezes, bots pause). */
export const IDLE_AFTER_MS = 120_000;

export interface IdleGate {
  clientConnected(now: number): void;
  clientDisconnected(now: number): void;
  /**
   * Activity without a WS viewer (an authenticated REST/MCP write): wakes the engine if IDLE and
   * holds IDLE off for the same window a departing viewer would.
   */
  touch(now: number): void;
  clients(): number;
  tick(now: number): void;
  /** REPLAY loop wrap: re-bases the idle timer (and the wake time) on the rewound clock. */
  reset(now: number): void;
}

export function createIdleGate(
  state: MarketState,
  bus: EventBus,
  onWake: (now: number) => void,
  bootAt: number,
): IdleGate {
  let count = 0;
  let lastSeen = bootAt;
  const wake = (now: number) => {
    if (!state.flags.idle) return;
    state.flags.idle = false;
    state.flags.wokeAt = now;
    // NAV is still the frozen pre-IDLE value until the next loop tick moves it.
    state.awaitingNavTick = true;
    bus.emit({ t: 'status' });
    onWake(now);
  };
  return {
    clientConnected(now) {
      count++;
      lastSeen = now;
      wake(now);
    },
    touch(now) {
      lastSeen = now;
      wake(now);
    },
    clientDisconnected(now) {
      count = Math.max(0, count - 1);
      lastSeen = now;
    },
    clients: () => count,
    tick(now) {
      if (count === 0 && !state.flags.idle && now - lastSeen >= IDLE_AFTER_MS) {
        state.flags.idle = true;
        bus.emit({ t: 'status' });
      }
    },
    reset(now) {
      lastSeen = now;
      state.flags.wokeAt = Math.min(state.flags.wokeAt, now);
    },
  };
}
