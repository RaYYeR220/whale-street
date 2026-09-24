import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { returnsByKind, TOOLS } from '../components/agents/AgentsView';
import { LandingView } from '../components/landing/LandingView';
import type { LeaderboardEntry } from '../lib/api-types';
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
