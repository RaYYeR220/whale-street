import { describe, expect, it } from 'vitest';
import { companyIdentity, hash32, mulberry32 } from '../src/index';

const A = '0x93053f1e7a5efeda532fe69cbbe43cbec3a0f13f' as const;
const B = '0x0000000000000000000000000000000000000001' as const;

describe('identity', () => {
  it('hash32 is stable', () => {
    expect(hash32('abc')).toBe(hash32('abc'));
    expect(hash32('abc')).not.toBe(hash32('abd'));
  });

  it('mulberry32 yields values in [0,1) deterministically', () => {
    const r1 = mulberry32(42);
    const r2 = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const v = r1();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(v).toBe(r2());
    }
  });

  it('is deterministic and case-insensitive on the address', () => {
    const a = companyIdentity(A);
    expect(companyIdentity(A)).toEqual(a);
    expect(companyIdentity(A.toUpperCase().replace('0X', '0x') as `0x${string}`)).toEqual(a);
  });

  it('produces a three-word name and valid ticker candidates', () => {
    const id = companyIdentity(A);
    expect(id.name.split(' ').length).toBeGreaterThanOrEqual(3);
    expect(id.tickerCandidates.length).toBeGreaterThanOrEqual(10);
    for (const t of id.tickerCandidates) expect(t).toMatch(/^[A-Z][A-Z0-9]{2,3}$/);
    expect(new Set(id.tickerCandidates).size).toBe(id.tickerCandidates.length);
    expect(Number.isInteger(id.logoSeed)).toBe(true);
  });

  it('differs across addresses', () => {
    expect(companyIdentity(A).logoSeed).not.toBe(companyIdentity(B).logoSeed);
    const names = new Set(
      Array.from(
        { length: 20 },
        (_, i) =>
          companyIdentity(`0x${(i + 1).toString(16).padStart(40, '0')}` as `0x${string}`).name,
      ),
    );
    expect(names.size).toBeGreaterThanOrEqual(15);
  });
});
