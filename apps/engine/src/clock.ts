export interface Clock {
  now(): number;
}

export const realClock: Clock = { now: () => Date.now() };

/** Virtual clock that loops over a recorded session window [startT, endT). */
export interface ReplayClock extends Clock {
  readonly startT: number;
  readonly endT: number;
  /** Returns true (and notifies onWrap listeners) when the loop wrapped since the last poll. */
  poll(): boolean;
  onWrap(cb: () => void): () => void;
}

export function createReplayClock(
  startT: number,
  endT: number,
  bootAt: number,
  wallNow: () => number = Date.now,
): ReplayClock {
  const span = Math.max(1, endT - startT);
  const elapsed = () => Math.max(0, wallNow() - bootAt);
  const listeners = new Set<() => void>();
  let lastLoop = 0;
  return {
    startT,
    endT,
    now: () => startT + (elapsed() % span),
    poll() {
      const loop = Math.floor(elapsed() / span);
      if (loop === lastLoop) return false;
      lastLoop = loop;
      for (const cb of listeners) cb();
      return true;
    },
    onWrap(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
