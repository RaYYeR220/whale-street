import { describe, expect, it } from 'vitest';
import { type Clock, RateLimiter, stableStringify } from '../src/index';

class FakeClock implements Clock {
  t = 0;
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.t += ms;
  }
}

describe('stableStringify', () => {
  it('sorts keys recursively and drops undefined fields', () => {
    expect(stableStringify({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[2,{"y":2,"z":1}]},"b":1}',
    );
    expect(stableStringify(null)).toBe('null');
  });
});

describe('RateLimiter', () => {
  it('lets calls through until the window is full, then waits', async () => {
    const clock = new FakeClock();
    const lim = new RateLimiter([{ limit: 2, windowMs: 1_000 }], clock);
    await lim.acquire();
    await lim.acquire();
    expect(clock.t).toBe(0);
    await lim.acquire();
    expect(clock.t).toBe(1_000);
  });

  it('respects the strictest of several windows', async () => {
    const clock = new FakeClock();
    const lim = new RateLimiter(
      [
        { limit: 10, windowMs: 1_000 },
        { limit: 3, windowMs: 60_000 },
      ],
      clock,
    );
    for (let i = 0; i < 3; i++) await lim.acquire();
    expect(lim.waitTime()).toBe(60_000);
    await lim.acquire();
    expect(clock.t).toBe(60_000);
  });

  it('blockFor holds every acquire until the block ends (a shorter block never shortens it)', async () => {
    const clock = new FakeClock();
    const lim = new RateLimiter([{ limit: 10, windowMs: 1_000 }], clock);
    lim.blockFor(60_000);
    lim.blockFor(5_000);
    expect(lim.waitTime()).toBe(60_000);
    await lim.acquire();
    expect(clock.t).toBe(60_000);
    await lim.acquire();
    expect(clock.t).toBe(60_000);
    const bare = new RateLimiter([], clock);
    bare.blockFor(1_000);
    await bare.acquire();
    expect(clock.t).toBe(61_000);
  });
});
