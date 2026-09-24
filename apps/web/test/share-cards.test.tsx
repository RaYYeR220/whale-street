/** Share cards: every card that shows moving numbers says so when they come from a replay. */
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../lib/api';
import type { StatusView } from '../lib/api-types';
import { companyView, portfolio, status } from './helpers';

const engine = vi.hoisted(() => ({
  status: null as unknown,
  company: null as unknown,
  profile: null as unknown,
}));
vi.mock('next/og', () => ({
  ImageResponse: class {
    constructor(readonly element: ReactElement) {}
  },
}));
vi.mock('../lib/server', () => ({
  serverApi: () => ({
    status: async () => engine.status,
    company: async () => engine.company,
    profile: async () => engine.profile,
  }),
}));
vi.mock('../lib/og/og', async (load) => ({
  ...(await load<typeof import('../lib/og/og')>()),
  ogFonts: async () => [],
}));

const { movingFooter } = await import('../lib/og/og');
const { default: companyCard } = await import('../app/(app)/c/[ticker]/opengraph-image');
const { default: profileCard } = await import('../app/(app)/u/[handle]/opengraph-image');

const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, data });
const markup = (r: unknown) => renderToStaticMarkup((r as { element: ReactElement }).element);
const REPLAY = 'REPLAY of a recorded session';

beforeEach(() => {
  engine.company = ok({ company: companyView(), filings: [], holders: [] });
  engine.profile = ok({
    player: { id: 'p1', handle: 'Molten Mako', kind: 'human', createdAt: 0, walletLinked: false },
    portfolio: portfolio({ netWorth: 10_550 }),
    seasons: [],
    trades: [],
  });
});

describe('share cards in REPLAY', () => {
  it('label the company card and the profile card alike', async () => {
    engine.status = ok<StatusView>(status({ mode: 'replay' }));
    expect(markup(await companyCard({ params: Promise.resolve({ ticker: 'OOH' }) }))).toContain(
      REPLAY,
    );
    const profile = markup(
      await profileCard({ params: Promise.resolve({ handle: 'Molten%20Mako' }) }),
    );
    expect(profile).toContain('$10,550.00');
    expect(profile).toContain(REPLAY);
  });

  it('say nothing of a replay on a live engine', async () => {
    engine.status = ok<StatusView>(status({ mode: 'live' }));
    const profile = markup(
      await profileCard({ params: Promise.resolve({ handle: 'Molten%20Mako' }) }),
    );
    expect(profile).toContain('$10,550.00');
    expect(profile).not.toContain(REPLAY);
  });
});

describe('share cards when the status call fails', () => {
  const down: ApiResult<StatusView> = {
    ok: false,
    status: 0,
    error: 'TIMEOUT',
    message: 'the engine did not answer in time',
  };

  it('keep the last mode the engine reported', async () => {
    engine.status = ok<StatusView>(status({ mode: 'replay' }));
    await profileCard({ params: Promise.resolve({ handle: 'Molten%20Mako' }) });
    engine.status = down;
    expect(markup(await companyCard({ params: Promise.resolve({ ticker: 'OOH' }) }))).toContain(
      REPLAY,
    );
  });

  it('say the mode is unknown when the engine never reported one, never pass for live', () => {
    const memory = { mode: null };
    expect(movingFooter(down, 'Play money', memory)).toBe('Live status unknown · Play money');
    expect(movingFooter(ok(status({ mode: 'live' })), 'Play money', memory)).toBe('Play money');
    expect(movingFooter(down, 'Play money', memory)).toBe('Play money');
  });
});
