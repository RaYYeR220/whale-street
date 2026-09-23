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

/** Sliding-window limiter over several windows; acquire() resolves once every window has room. */
export class RateLimiter {
  private readonly stamps: number[][];

  constructor(
    private readonly windows: WindowLimit[],
    private readonly clock: Clock = realClock,
  ) {
    this.stamps = windows.map(() => []);
  }

  waitTime(): number {
    const now = this.clock.now();
    let wait = 0;
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
