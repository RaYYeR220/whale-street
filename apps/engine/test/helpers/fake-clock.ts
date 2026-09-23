import type { Clock } from '../../src/clock';

/** 2026-09-21T14:13:20Z — a fixed, readable epoch for tests. */
export const T0 = 1_790_000_000_000;

export class FakeClock implements Clock {
  constructor(public t: number = T0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
