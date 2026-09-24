import type { EventBus } from '../events';
import type { MarketState } from '../market/state';

/** No WS viewer for this long → IDLE (Nansen polling stops, NAV freezes, bots pause). */
export const IDLE_AFTER_MS = 120_000;

export interface IdleGate {
  clientConnected(now: number): void;
  clientDisconnected(now: number): void;
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
  return {
    clientConnected(now) {
      count++;
      lastSeen = now;
      if (state.flags.idle) {
        state.flags.idle = false;
        state.flags.wokeAt = now;
        bus.emit({ t: 'status' });
        onWake(now);
      }
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
