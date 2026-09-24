/** The company page's committee record: what it says when the application is not in reach. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Prospectus } from '../components/company/Panels';
import type { ListingLookup } from '../lib/committee';
import { toDisplay } from '../lib/company';
import { companyView, entry, T0 } from './helpers';
import { Wrap } from './render';

const c = toDisplay(entry(), companyView(), undefined, T0);

function html(source: 'SCOUT' | 'IPO_DESK' | 'SEEDED', lookup: ListingLookup) {
  if (!c) throw new Error('no company');
  return renderToStaticMarkup(
    <Wrap>
      <Prospectus c={c} prospectus={null} source={source} lookup={lookup} />
    </Wrap>,
  );
}

describe('committee record lookup', () => {
  it('says the record is not among the recent applications it read, not that none exists', () => {
    expect(html('IPO_DESK', { kind: 'missing', scanned: 100 })).toContain(
      'Not found among the 100 most recent applications',
    );
  });

  it('says it is still looking, or that the engine did not answer', () => {
    expect(html('IPO_DESK', { kind: 'loading' })).toContain('Looking up the committee record');
    expect(html('IPO_DESK', { kind: 'error', message: 'engine down' })).toContain(
      'Cannot load the committee record (engine down)',
    );
  });

  it('explains the listings that have no application at all', () => {
    expect(html('SCOUT', { kind: 'missing', scanned: 3 })).toContain('found by the scout');
    expect(html('SEEDED', { kind: 'missing', scanned: 3 })).toContain('no committee ran for it');
  });
});
