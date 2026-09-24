// @vitest-environment jsdom
/** The evidence drawer: the Nansen calls behind a company's numbers, as the engine logged them. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EvidenceDrawer } from '../components/desk/EvidenceDrawer';
import type { NansenCallView } from '../lib/api-types';
import { companyView, json, T0 } from './helpers';
import { testRuntime, Wrap } from './render';

const call = (id: string, o: Partial<NansenCallView> = {}): NansenCallView => ({
  id,
  method: 'POST',
  path: '/api/v1/profiler/perp-positions',
  requestHash: 'rq',
  status: 200,
  credits: 1,
  latencyMs: 20,
  at: T0,
  responseHash: 'abcdef0123456789',
  error: null,
  attempts: 1,
  recorded: false,
  ...o,
});

function drawer(ids: string[], calls: Record<string, NansenCallView>) {
  const routes: Parameters<typeof testRuntime>[0] = {
    'GET /api/companies/OOH': () =>
      json({ company: companyView({ provenance: ids }), filings: [], holders: [] }),
  };
  for (const id of ids)
    routes[`GET /api/provenance/${id}`] = () => {
      const c = calls[id];
      return c ? json({ call: c }) : json({ error: 'NOT_FOUND', message: 'no such call' }, 404);
    };
  render(
    <Wrap runtime={testRuntime(routes)}>
      <EvidenceDrawer ticker="OOH" />
    </Wrap>,
  );
}

afterEach(cleanup);

describe('evidence drawer', () => {
  it('labels the calls answered from the REPLAY recording as recorded', async () => {
    drawer(['nc_1', 'nc_2'], {
      nc_1: call('nc_1', { recorded: true, credits: null }),
      nc_2: call('nc_2', { path: '/api/v1/profiler/perp-pnl-summary' }),
    });
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toMatch(/recorded/);
    expect(rows[1]?.textContent).not.toMatch(/recorded/);
  });

  it('shows unknown credits as unknown and says how many calls could not be loaded', async () => {
    drawer(['nc_1', 'nc_2', 'nc_gone'], {
      nc_1: call('nc_1', { credits: null }),
      nc_2: call('nc_2', { credits: 2 }),
    });
    const rows = await screen.findAllByRole('listitem');
    expect(rows[0]?.textContent).toMatch(/— credits/);
    expect(rows[0]?.textContent).not.toMatch(/0 credits/);
    expect(screen.getByText(/1 call could not be loaded/)).toBeTruthy();
    expect(screen.getByText(/At least 2 credits/)).toBeTruthy();
  });

  it('never says no call is recorded when the lookups failed', async () => {
    drawer(['nc_gone'], {});
    expect(await screen.findByText(/1 call could not be loaded/)).toBeTruthy();
    expect(screen.queryByText(/No Nansen call is recorded/)).toBeNull();
  });
});
