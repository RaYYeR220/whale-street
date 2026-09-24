import { describe, expect, it } from 'vitest';
import { RateGate } from '../src/api/rate';

describe('RateGate', () => {
  it('allows `limit` hits per sliding window and key', () => {
    let t = 0;
    const gate = new RateGate(2, 1_000, () => t);
    expect([gate.allow('a'), gate.allow('a'), gate.allow('a')]).toEqual([true, true, false]);
    expect(gate.allow('b')).toBe(true);
    t = 1_000;
    expect(gate.allow('a')).toBe(true);
  });

  it('evicts keys whose newest hit is older than the window (rotating keys cannot grow memory)', () => {
    let t = 0;
    const gate = new RateGate(5, 1_000, () => t);
    for (let i = 0; i < 100; i++) gate.allow(`spoofed-${i}`);
    expect(gate.size()).toBe(100);
    t = 500;
    gate.allow('late');
    expect(gate.size()).toBe(101);
    t = 1_001;
    gate.allow('fresh');
    // Everything but 'late' (hit at 500) and 'fresh' is past the window.
    expect(gate.size()).toBe(2);
    t = 1_600;
    gate.allow('fresh');
    t = 2_200;
    gate.allow('fresh');
    expect(gate.size()).toBe(1);
  });
});
