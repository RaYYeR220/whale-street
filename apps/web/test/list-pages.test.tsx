/** List pages rendered on the server: an engine that does not answer is said so, not shown as empty. */
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardView } from '../components/board/BoardView';
import { IpoDesk } from '../components/ipo/IpoDesk';
import type { ApiResult } from '../lib/api';

const engine = vi.hoisted(() => ({ up: true }));
const down: ApiResult<never> = {
  ok: false,
  status: 0,
  error: 'NETWORK',
  message: 'cannot reach the engine (fetch failed)',
};
vi.mock('../lib/server', () => ({
  serverApi: () => ({
    seasons: async () => (engine.up ? { ok: true, data: { seasons: [] } } : down),
    leaderboard: async () => (engine.up ? { ok: true, data: { rows: [] } } : down),
    ipoList: async () => (engine.up ? { ok: true, data: { apps: [] } } : down),
  }),
}));

const { default: BoardPage } = await import('../app/(app)/leaderboard/page');
const { default: IpoPage } = await import('../app/(app)/ipo/page');

beforeEach(() => {
  engine.up = true;
});

describe('list pages when the engine is unreachable', () => {
  it('the board says it cannot load instead of showing an empty board', async () => {
    engine.up = false;
    const html = renderToStaticMarkup((await BoardPage()) as ReactElement);
    expect(html).toContain('Cannot load the board');
    expect(html).toContain('cannot reach the engine (fetch failed)');
  });

  it('the IPO desk says it cannot load instead of showing an empty wall', async () => {
    engine.up = false;
    const html = renderToStaticMarkup((await IpoPage()) as ReactElement);
    expect(html).toContain('Cannot load the IPO desk');
  });

  it('render the views when the engine answers, even with nothing in them', async () => {
    expect(((await BoardPage()) as ReactElement).type).toBe(BoardView);
    expect(((await IpoPage()) as ReactElement).type).toBe(IpoDesk);
  });
});
