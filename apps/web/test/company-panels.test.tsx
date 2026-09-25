// @vitest-environment jsdom
/** Company page panels: the risk panel speaks the same HP as the meter; filings fold repeats. */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanyView } from '../components/company/CompanyView';
import { FilingsTimeline, RiskPanel } from '../components/company/Panels';
import { MarketStrip } from '../components/floor/MarketStrip';
import type { HolderView, PositionView } from '../lib/api-types';
import { cushionLeft, toDisplay } from '../lib/company';
import { companyView, entry, filing, json, market, T0 } from './helpers';
import { testRuntime, Wrap } from './render';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

describe('filings timeline', () => {
  const call = (id: number, at: number) =>
    filing({
      id,
      kind: 'MARGIN_CALL',
      coin: 'ETH',
      at,
      detail: 'ETH is 92% of the way from entry to its liquidation price (health 8%)',
    });

  it('folds consecutive identical filings into one entry with a count', () => {
    const filings = [
      call(9, T0),
      call(8, T0 - 1_000),
      call(7, T0 - 2_000),
      filing({ id: 6, kind: 'RESUME', detail: 'marks returned', at: T0 - 3_000 }),
      call(5, T0 - 4_000),
      filing({ id: 4, kind: 'OPEN', coin: 'SOL', at: T0 - 5_000 }),
      filing({ id: 3, kind: 'OPEN', coin: 'BTC', at: T0 - 6_000 }),
    ];
    render(
      <Wrap>
        <FilingsTimeline filings={filings} now={T0} lit={new Set([8])} />
      </Wrap>,
    );
    const items = within(screen.getByRole('region', { name: /Filings/ })).getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('.kind')?.textContent)).toEqual([
      'Margin call ×3',
      'Resumed',
      'Margin call',
      'New position',
      'New position',
    ]);
    // The folded entry stands for every filing in it (a chart balloon on any of them lights it).
    expect(items[0]?.className).toContain('is-lit');
    expect(items[0]?.getAttribute('aria-label') ?? items[0]?.textContent).toMatch(/3 times/);
  });
});

describe('company page across a replay wrap', () => {
  it('drops the previous loop’s filings at once instead of at the next refresh', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const old = filing({ id: 41, kind: 'MARGIN_CALL', at: T0 - 5_000, detail: 'old loop call' });
    let filings = [old];
    const rt = testRuntime({
      'GET /api/companies/OOH': () =>
        json({ company: companyView(), filings, holders: [] as HolderView[] }),
      'GET /api/ipo': () => json({ apps: [] }),
      'GET /api/companies/OOH/history': () => json({ ticker: 'OOH', points: [] }),
    });
    render(
      <Wrap runtime={rt}>
        <CompanyView
          ticker="OOH"
          initial={{ company: companyView(), filings: [old], holders: [] }}
          initialHistory={[]}
        />
      </Wrap>,
    );
    act(() => rt.store.dispatch(market(T0, [entry()]), Date.now()));
    expect(screen.getAllByText(/old loop call/).length).toBeGreaterThan(0);
    // The loop restarts: the engine cleared that filing, and the page follows right away.
    filings = [];
    act(() => rt.store.dispatch(market(T0 - 400_000, [entry()]), Date.now()));
    await waitFor(() => expect(screen.queryAllByText(/old loop call/)).toEqual([]), {
      timeout: 2_000,
    });
  });
});

describe('market strip', () => {
  it('dates the last bankruptcy in words: just now, then minutes ago', () => {
    const rt = testRuntime();
    rt.store.seedFilings([filing({ id: 7, kind: 'BANKRUPTCY', at: T0 - 20_000 })]);
    const c = toDisplay(entry(), companyView(), undefined, T0);
    if (!c) throw new Error('no company');
    const { rerender } = render(
      <Wrap runtime={rt}>
        <MarketStrip companies={[c]} now={T0} />
      </Wrap>,
    );
    const bk = () => screen.getByText(/^OOH, /).textContent;
    expect(bk()).toBe('OOH, just now');
    rerender(
      <Wrap runtime={rt}>
        <MarketStrip companies={[c]} now={T0 + 4 * 60_000} />
      </Wrap>,
    );
    expect(bk()).toBe('OOH, 4m ago');
  });
});
