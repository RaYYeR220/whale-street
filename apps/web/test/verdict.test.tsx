import { PARAMS } from '@whale-street/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VerdictSheet } from '../components/ipo/VerdictSheet';
import type { IpoView } from '../lib/api-types';
import { IPO_CAP_USD } from '../lib/company';
import { companyView, T0 } from './helpers';

const approved: IpoView = {
  id: 'ipo_1',
  address: `0x${'a'.repeat(40)}`,
  status: 'APPROVED',
  reason: null,
  ticker: 'OOH',
  verdict: null,
  createdAt: T0 - 5_000,
  decidedAt: T0 - 1_000,
};

describe('approved verdict', () => {
  it('shows the IPO window’s time left and the per-player allocation cap', () => {
    const html = renderToStaticMarkup(
      <VerdictSheet
        app={approved}
        checks={[]}
        company={companyView({ ipoUntil: T0 + 42_000 })}
        now={T0}
        animate={false}
      />,
    );
    expect(IPO_CAP_USD).toBe(PARAMS.ipoCapFrac * PARAMS.seasonStartCash);
    expect(html).toContain('its IPO window is open for 0:42');
    // Pinned, not derived: the cap a player reads is $1,000 (10% of the $10,000 season cash).
    expect(html).toContain('buy up to $1,000.00 per player');
  });

  it('names no cap once the window has closed', () => {
    const html = renderToStaticMarkup(
      <VerdictSheet
        app={approved}
        checks={[]}
        company={companyView({ ipoUntil: T0 - 1 })}
        now={T0}
        animate={false}
      />,
    );
    expect(html).not.toContain('per player');
    expect(html).toContain('Trade OOH');
  });
});
