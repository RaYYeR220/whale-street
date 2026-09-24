import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FloorView } from '../components/floor/FloorView';
import { indexSeries } from '../components/floor/MarketStrip';
import { toDisplay } from '../lib/company';
import { seriesFromHistory } from '../lib/store';
import { companyView, entry, T0 } from './helpers';
import { Wrap } from './render';

const views = [
  companyView({ id: '0xa1', ticker: 'OOH', name: 'Obsidian Octopus Holdings' }),
  companyView({ id: '0xb2', ticker: 'GBC', name: 'Gilded Badger Capital', hp: 0.12 }),
  companyView({
    id: '0xc3',
    ticker: 'QLP',
    name: 'Quiet Lynx Partners',
    status: 'HALTED',
    haltReason: 'Nansen did not answer',
  }),
];

describe('the floor, first paint from the server', () => {
  const html = renderToStaticMarkup(
    <Wrap>
      <FloorView initialCompanies={views} initialFilings={[]} engineError={null} />
    </Wrap>,
  );

  it('draws a panel for every listed company, halted ones included', () => {
    for (const t of ['OOH', 'GBC', 'QLP']) expect(html).toContain(`href="/c/${t}"`);
    expect(html).toContain('HALTED');
  });

  it('offers the five sorts and the search box', () => {
    for (const label of ['Movers', 'Hype', 'Near liquidation', 'New listings', 'Top rated'])
      expect(html).toContain(`>${label}</button>`);
    expect(html).toContain('placeholder="Find a ticker or name"');
  });

  it('credits Nansen', () => {
    expect(html).toContain('Powered by');
  });
});

describe('the floor without an engine', () => {
  it('says it cannot reach the engine instead of drawing an empty market', () => {
    const html = renderToStaticMarkup(
      <Wrap>
        <FloorView
          initialCompanies={[]}
          initialFilings={[]}
          engineError="cannot reach the engine (fetch failed)"
        />
      </Wrap>,
    );
    expect(html).toContain('The floor cannot reach the engine');
    expect(html).toContain('fetch failed');
  });
});

describe('Whale Street Index', () => {
  it('averages the NAV of listed companies minute by minute', () => {
    const a = toDisplay(
      entry({ id: 'a', ticker: 'A' }),
      null,
      seriesFromHistory([{ t: T0, nav: 100, price: 100 }]),
      T0,
    );
    const b = toDisplay(
      entry({ id: 'b', ticker: 'B' }),
      null,
      seriesFromHistory([{ t: T0, nav: 120, price: 120 }]),
      T0,
    );
    const s = indexSeries([a, b].filter((c) => c !== null));
    expect(s.at(-1)).toBe(110);
    expect(s[0]).toBeNull();
  });
});
