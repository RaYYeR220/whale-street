export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface WindowLimit {
  limit: number;
  windowMs: number;
}

/**
 * Sliding-window limiter over several windows; acquire() resolves once every window has room and
 * any block set by blockFor() has ended.
 */
export class RateLimiter {
  private readonly stamps: number[][];
  private blockedUntil = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly windows: WindowLimit[],
    private readonly clock: Clock = realClock,
  ) {
    this.stamps = windows.map(() => []);
  }

  /** Holds every acquire for `ms` from now (the server said Retry-After); never shortens a block. */
  blockFor(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.clock.now() + ms);
  }

  waitTime(): number {
    const now = this.clock.now();
    let wait = Math.max(0, this.blockedUntil - now);
    this.windows.forEach((w, i) => {
      const s = this.stamps[i] as number[];
      while (s.length > 0 && (s[0] as number) <= now - w.windowMs) s.shift();
      if (s.length >= w.limit) wait = Math.max(wait, (s[0] as number) + w.windowMs - now);
    });
    return wait;
  }

  async acquire(): Promise<void> {
    for (;;) {
      const w = this.waitTime();
      if (w <= 0) break;
      await this.clock.sleep(w);
    }
    const now = this.clock.now();
    for (const s of this.stamps) s.push(now);
  }
}
