/** Shared rate gates passed to both REST and MCP so limits apply across surfaces. */
export interface Gates {
  readonly orders: RateGate;
}

/**
 * Sliding-window rate gate keyed by caller (player id or IP). Keys whose newest hit left the
 * window are swept at most once per window (amortized in `allow`), so rotating or spoofed keys
 * cannot grow memory without bound.
 */
export class RateGate {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private lastSweep = Number.NEGATIVE_INFINITY;

  constructor(limit: number, windowMs: number, now: () => number) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Records a hit and returns true, or returns false (no hit recorded) when the window is full. */
  allow(key: string): boolean {
    const t = this.now();
    if (t - this.lastSweep >= this.windowMs) this.sweep(t);
    const recent = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }

  /** Number of keys currently tracked. */
  size(): number {
    return this.hits.size;
  }

  private sweep(t: number): void {
    this.lastSweep = t;
    for (const [key, hits] of this.hits) {
      const newest = hits.at(-1) ?? Number.NEGATIVE_INFINITY;
      if (newest <= t - this.windowMs) this.hits.delete(key);
    }
  }
}
