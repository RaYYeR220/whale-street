import { describe, expect, it } from 'vitest';
import { num, numOrNull } from '../src/index';

describe('num', () => {
  it('accepts plain decimal numbers and strings', () => {
    expect(num.parse(1)).toBe(1);
    expect(num.parse('1')).toBe(1);
    expect(num.parse('-2.5')).toBe(-2.5);
    expect(num.parse('1e3')).toBe(1_000);
  });

  it('rejects empty, whitespace-only and hex strings', () => {
    expect(() => num.parse('')).toThrow();
    expect(() => num.parse('  ')).toThrow();
    expect(() => num.parse('0x10')).toThrow();
  });
});

describe('numOrNull', () => {
  it('maps missing, null, empty and whitespace-only to null', () => {
    expect(numOrNull.parse(undefined)).toBeNull();
    expect(numOrNull.parse(null)).toBeNull();
    expect(numOrNull.parse('')).toBeNull();
    expect(numOrNull.parse('  ')).toBeNull();
  });

  it('parses valid decimal numbers and strings', () => {
    expect(numOrNull.parse(1)).toBe(1);
    expect(numOrNull.parse('1e3')).toBe(1_000);
    expect(numOrNull.parse('-2.5')).toBe(-2.5);
  });

  it('rejects non-decimal strings like hex', () => {
    expect(() => numOrNull.parse('0x10')).toThrow();
  });
});
