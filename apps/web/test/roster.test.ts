import { describe, expect, it } from 'vitest';
import { toDisplay } from '../lib/company';
import { place, rank, SLOTS } from '../lib/roster';
import { entry, T0 } from './helpers';

describe('floor roster', () => {
  const co = (ticker: string, o: Parameters<typeof entry>[0] = {}) => {
    const d = toDisplay(entry({ id: ticker, ticker, ...o }), null, undefined, T0);
    if (!d) throw new Error('no display');
    return d;
  };

  it('puts halted and bankrupt companies in pinned slots, never dropping them', () => {
    const list = [co('AAA'), co('BBB', { status: 'HALTED' }), co('CCC', { status: 'BANKRUPT' })];
    const r = rank(list, 'movers', T0);
    expect(r.order.map((c) => c.ticker)).toEqual(['AAA']);
    expect(r.pinned.map((c) => c.ticker)).toEqual(['BBB', 'CCC']);
    expect(
      place(r, '')
        .map((p) => p.company.ticker)
        .sort(),
    ).toEqual(['AAA', 'BBB', 'CCC']);
  });

  it('fills a short roster from the first slots of the page, biggest panel first', () => {
    const list = Array.from({ length: 8 }, (_, i) => co(`T${i}`, { hp: 0.9 - i * 0.01 }));
    const placed = place(rank(list, 'rated', T0), '');
    const used = placed.map((p) => SLOTS.indexOf(p.slot)).sort((a, b) => a - b);
    expect(used).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(placed[0]?.slot.size).toBe('xl');
  });

  it('keeps every company visible when there are more than slots', () => {
    const list = Array.from({ length: 20 }, (_, i) => co(`T${i}`));
    expect(place(rank(list, 'new', T0), '')).toHaveLength(20);
  });

  it('only labels a biggest-hype or near-liquidation panel when it is true', () => {
    const calm = [co('AAA', { price: 101, nav: 100, mult: 1 }), co('BBB', { mult: 1, hp: 0.9 })];
    const why = rank(calm, 'movers', T0).why;
    expect(
      Object.values(why)
        .map((w) => w.text)
        .join(' '),
    ).not.toMatch(/Biggest hype|Closest to liquidation/);
  });

  it('does not call a company that has not moved the top mover', () => {
    const flat = [co('AAA'), co('BBB')];
    expect(Object.values(rank(flat, 'movers', T0).why).map((w) => w.text)).not.toContain(
      'Top mover, 0.0% this hour',
    );
    expect(rank(flat, 'movers', T0).why.AAA).toBeUndefined();
  });

  it('reflows compactly while searching', () => {
    const list = [co('OOH'), co('GBC'), co('CMP')];
    const hits = place(rank(list, 'movers', T0), 'gb');
    expect(hits.map((p) => p.company.ticker)).toEqual(['GBC']);
  });
});
