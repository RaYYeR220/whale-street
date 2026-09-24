// @vitest-environment jsdom
/** The player's desk: mirror receipts as the engine reports them. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeskDrawer } from '../components/desk/DeskDrawer';
import type { MirrorOrderView } from '../lib/api-types';
import { TOKEN_KEY } from '../lib/player';
import { json, portfolio, T0 } from './helpers';
import { testRuntime, Wrap } from './render';

const PLAYER = { id: 'p1', handle: 'Tester', kind: 'human', walletAddress: null, createdAt: 0 };
const row = (o: Partial<MirrorOrderView>): MirrorOrderView => ({
  id: 's1',
  groupId: 'g1',
  kind: 'order',
  ticker: 'OOH',
  coin: 'BTC',
  status: 'FILLED',
  notionalUsd: 49.8,
  refusals: null,
  hlOid: 42,
  avgPx: 113_990,
  error: null,
  createdAt: T0,
  explorerUrl: null,
  ...o,
});

type Route = () => Response;

function desk(
  orders: MirrorOrderView[],
  o: { status?: Route; orders?: Route; profile?: Route } = {},
) {
  const runtime = testRuntime({
    'GET /api/me': () => json({ player: PLAYER, portfolio: portfolio(), seasons: [] }),
    'GET /api/players/Tester':
      o.profile ??
      (() => json({ player: PLAYER, portfolio: portfolio(), seasons: [], trades: [] })),
    'GET /api/mirror/status': o.status ?? (() => json({ available: true, mode: 'live' })),
    'GET /api/mirror/orders': o.orders ?? (() => json({ orders })),
  });
  render(
    <Wrap runtime={runtime}>
      <DeskDrawer onNavigate={() => undefined} />
    </Wrap>,
  );
}

beforeEach(() => localStorage.setItem(TOKEN_KEY, 'tok'));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('desk mirror receipts', () => {
  it('says a closed mirror filled and has been closed on Hyperliquid since', async () => {
    desk([row({ id: 'a', status: 'CLOSED' })]);
    expect(await screen.findByText(/Filled, and closed on Hyperliquid since/)).toBeTruthy();
    expect(screen.getByText('Closed')).toBeTruthy();
  });

  it('says an unknown one has no definitive answer yet', async () => {
    desk([row({ id: 'b', status: 'UNKNOWN', hlOid: null, avgPx: null })]);
    expect(await screen.findByText(/No definitive answer from Hyperliquid/)).toBeTruthy();
    expect(screen.getByText(/OOH: BTC, \$49\.80/)).toBeTruthy();
  });
});

describe('desk when the engine does not answer', () => {
  const down = () => json({ error: 'INTERNAL', message: 'engine restarting' }, 503);

  it('says the Mirror orders could not be loaded instead of showing none', async () => {
    desk([], { orders: down });
    expect((await screen.findByText(/Couldn't load your Mirror orders/)).textContent).toMatch(
      /engine restarting/,
    );
    expect(screen.queryByText(/No mirror orders/)).toBeNull();
    expect(screen.queryByText(/Mirror is off/)).toBeNull();
  });

  it('never says Mirror is off when it could not ask', async () => {
    desk([], { status: down });
    expect(await screen.findByText(/No mirror orders yet/)).toBeTruthy();
    expect(screen.queryByText(/Mirror is off/)).toBeNull();
  });

  it('names the real reason Mirror is off: REPLAY only when the engine replays', async () => {
    desk([], { status: () => json({ available: false, mode: 'live' }) });
    expect((await screen.findByText(/Mirror is off on this engine/)).textContent).not.toMatch(
      /REPLAY/,
    );
    cleanup();
    desk([], { status: () => json({ available: false, mode: 'replay' }) });
    expect((await screen.findByText(/Mirror is off on this engine/)).textContent).toMatch(/REPLAY/);
  });

  it('says the trades could not be loaded instead of showing none', async () => {
    desk([], { profile: down });
    expect(await screen.findByText(/Couldn't load your trades/)).toBeTruthy();
    expect(screen.queryByText(/No trades yet/)).toBeNull();
  });
});
