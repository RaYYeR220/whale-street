import type { CheckResult, ListingVerdict } from '@whale-street/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { returnsByKind, TOOLS } from '../components/agents/AgentsView';
import { LandingView } from '../components/landing/LandingView';
import type { IpoView, LeaderboardEntry } from '../lib/api-types';
import { companyView } from './helpers';
import { Wrap } from './render';

describe('agents page', () => {
  it('lists the engine’s MCP tools', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'list_companies',
      'get_company',
      'get_filings',
      'quote',
      'trade',
      'portfolio',
      'leaderboard',
      'apply_ipo',
    ]);
  });

  it('averages returns per kind of player and skips unknown net worth', () => {
    const row = (kind: LeaderboardEntry['kind'], netWorth: number | null): LeaderboardEntry => ({
      rank: 1,
      playerId: `${kind}${netWorth}`,
      handle: 'h',
      kind,
      netWorth,
    });
    const r = returnsByKind([
      row('agent', 11_000),
      row('agent', 9_000),
      row('bot', null),
      row('human', 10_500),
    ]);
    expect(r.agents.n).toBe(2);
    expect(r.agents.r).toBeCloseTo(0);
    expect(r.bots).toEqual({ n: 0, r: null });
    expect(r.humans.r).toBeCloseTo(0.05);
  });
});

const APPLICANT = '0x1111111111111111111111111111111111111111';
const LINKED = '0x2222222222222222222222222222222222222222';
const checks = (fail: CheckResult['id'], detail: string): CheckResult[] =>
  (
    [
      'TRACK_RECORD',
      'SIZE',
      'HUMAN',
      'HIDDEN_HEDGE',
      'CONCENTRATION',
      'UNIQUENESS',
    ] as CheckResult['id'][]
  ).map((id) =>
    id === fail ? { id, status: 'FAIL', detail } : { id, status: 'PASS', detail: 'ok' },
  );
const denial = (o: Partial<IpoView> & { verdict: ListingVerdict | null }): IpoView => ({
  id: 'app1',
  address: APPLICANT,
  status: 'DENIED',
  reason: null,
  ticker: null,
  createdAt: 0,
  decidedAt: 0,
  ...o,
});
const landing = (denied: IpoView | null) =>
  renderToStaticMarkup(
    <Wrap>
      <LandingView initialCompanies={[companyView()]} denied={denied} />
    </Wrap>,
  );
/** Everything the example figure invents. */
const INVENTED = [
  '0x19c2…04ab',
  '0x7a3f…c91e',
  'Most of this trader’s long was cancelled out',
  'The limit is 50%',
  'Linked through Nansen’s wallet graph',
];

describe('landing: the committee figure', () => {
  it('draws a real hedge denial from its own linked wallet', () => {
    const html = landing(
      denial({
        reason: 'HIDDEN_HEDGE: 82% of exposure offset by linked wallets',
        verdict: {
          decision: 'DENIED',
          checks: checks('HIDDEN_HEDGE', '82% of exposure offset by linked wallets'),
          rating: null,
          prospectus: null,
          hedgeLinks: [{ address: LINKED, coin: 'ETH', side: 'SHORT', notionalUsd: 250_000 }],
        },
      }),
    );
    expect(html).toContain('a real verdict from this engine');
    expect(html).toContain('0x2222…2222');
    expect(html).toContain('LONG ETH');
    expect(html).toContain('SHORT ETH');
    expect(html).toContain('82% of exposure offset by linked wallets');
    expect(html).not.toContain('Example');
    expect(html).not.toContain('BTC');
    for (const s of INVENTED.slice(0, 4)) expect(html).not.toContain(s);
  });

  it('shows only the real reason and checks for a denial without a hedge link', () => {
    const html = landing(
      denial({
        reason: 'TRACK_RECORD: 3 days of history, needs 30',
        verdict: {
          decision: 'DENIED',
          checks: checks('TRACK_RECORD', '3 days of history, needs 30'),
          rating: null,
          prospectus: null,
          hedgeLinks: [],
        },
      }),
    );
    expect(html).toContain('a real verdict from this engine');
    expect(html).toContain('3 days of history, needs 30');
    expect(html).not.toContain('Hidden hedge: failed');
    expect(html).not.toContain('lp-graph');
    expect(html).not.toContain('lp-offset');
    expect(html).not.toContain('LONG BTC');
    expect(html).not.toContain('SHORT BTC');
    for (const s of INVENTED) expect(html).not.toContain(s);
  });

  it('invents no reason when the real denial has none', () => {
    const html = landing(denial({ verdict: null }));
    expect(html).toContain('a real verdict from this engine');
    for (const s of INVENTED) expect(html).not.toContain(s);
    expect(html).not.toContain('lp-graph');
  });

  it('labels the whole figure as an example when the engine has no denial', () => {
    const html = landing(null);
    expect(html).toContain('Example application');
    expect(html).not.toContain('a real verdict from this engine');
    expect(html).toMatch(/lp-graph[^>]*>[\s\S]*Example/);
  });
});

describe('landing page', () => {
  it('labels its examples as examples when the engine has no real denial yet', () => {
    const html = renderToStaticMarkup(
      <Wrap>
        <LandingView initialCompanies={[companyView()]} denied={null} />
      </Wrap>,
    );
    expect(html).toContain('Don’t trade tokens.');
    expect(html).toContain('Example application');
    expect(html).toContain('no denial on this engine yet');
    expect(html).toContain('Mirror with real money, an example');
    expect(html).toContain('Powered by');
  });
});
