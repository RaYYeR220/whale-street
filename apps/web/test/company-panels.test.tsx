// @vitest-environment jsdom
/** Company page panels: the risk panel speaks the same HP as the meter. */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RiskPanel } from '../components/company/Panels';
import type { PositionView } from '../lib/api-types';
import { cushionLeft, toDisplay } from '../lib/company';
import { companyView, entry, T0 } from './helpers';

afterEach(cleanup);

const position = (o: Partial<PositionView>): PositionView => ({
  coin: 'ETH',
  size: 100,
  entryPx: 3_000,
  liqPx: 2_800,
  leverage: 10,
  marginUsed: 30_000,
  unrealizedPnl: 0,
  mark: 3_000,
  hp: 1,
  ...o,
});

function panel(positions: PositionView[], hp: number) {
  const c = toDisplay(entry({ hp }), companyView({ positions }), undefined, T0);
  if (!c) throw new Error('no company');
  render(<RiskPanel c={c} />);
  return screen.getByRole('region', { name: /Risk/ });
}

describe('risk panel', () => {
  it('draws each position on the HP scale: a 10x long at its entry has its whole cushion left', () => {
    const risk = panel([position({})], 1);
    const bars = within(risk).getAllByRole('meter');
    // The HP meter and the position's bar agree: 100%.
    expect(bars.map((b) => b.getAttribute('aria-valuenow'))).toEqual(['100', '100']);
    expect(bars[1]?.getAttribute('aria-valuemax')).toBe('100');
    expect(risk.textContent).toContain('100% of the cushion left');
    // The absolute distance is secondary text, never the bar's scale.
    expect(risk.textContent).toContain('liquidation 6.7% below the mark');
    expect(risk.textContent).not.toMatch(/Bars fill up to 50% away/);
    expect(risk.textContent).toContain(
      'HP is how much of the distance from entry to liquidation is still left',
    );
  });

  it('names the position with the least cushion as the one that sets HP, not the nearest in %', () => {
    // A 2x long most of the way to liquidation (20% cushion, 16.7% away) next to a fresh 20x long
    // (100% cushion, 5% away): HP is 20%, set by the 2x.
    const worn = position({ coin: 'BTC', entryPx: 100, liqPx: 50, mark: 60, leverage: 2 });
    const fresh = position({ coin: 'SOL', entryPx: 100, liqPx: 95, mark: 100, leverage: 20 });
    const risk = panel([fresh, worn], 0.2);
    const rows = within(risk).getAllByRole('listitem');
    expect(rows[0]?.textContent).toMatch(/LONG BTC 2x.*Sets HP.*20% of the cushion left/);
    expect(rows[0]?.textContent).toContain('liquidation 16.7% below the mark');
    expect(rows[1]?.textContent).toMatch(/LONG SOL 20x.*100% of the cushion left/);
    expect(rows[1]?.textContent).not.toContain('Sets HP');
    expect(
      within(rows[0] as HTMLElement)
        .getByRole('meter')
        .getAttribute('aria-valuenow'),
    ).toBe('20');
  });

  it('puts a short’s liquidation above the mark, and says when the cushion cannot be measured', () => {
    const risk = panel(
      [
        position({ coin: 'ETH', size: -10, entryPx: 3_000, liqPx: 3_300, mark: 3_150 }),
        position({ coin: 'BTC', liqPx: null }),
        position({ coin: 'SOL', mark: null }),
      ],
      0.5,
    );
    expect(risk.textContent).toContain('50% of the cushion left');
    expect(risk.textContent).toContain('liquidation 4.8% above the mark');
    expect(risk.textContent).toContain('no liquidation price');
    expect(risk.textContent).toContain('no live mark');
  });

  it('measures the cushion with the same rule as HP', () => {
    expect(cushionLeft(position({}))).toBe(1);
    expect(cushionLeft(position({ mark: 2_900 }))).toBeCloseTo(0.5);
    expect(cushionLeft(position({ mark: 2_700 }))).toBe(0);
    expect(cushionLeft(position({ mark: null }))).toBeNull();
    expect(cushionLeft(position({ liqPx: null }))).toBeNull();
  });
});
