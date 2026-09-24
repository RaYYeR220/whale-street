// @vitest-environment jsdom
/** The IPO desk's answers to a nomination: new, already on file, refused, or the desk is full. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IpoDesk } from '../components/ipo/IpoDesk';
import type { IpoView } from '../lib/api-types';
import { MEMBERS } from '../lib/committee';
import { TOKEN_KEY } from '../lib/player';
import { json, portfolio, T0 } from './helpers';
import { testRuntime, Wrap } from './render';

const ADDRESS = `0x${'3b'.repeat(20)}`;
const denied: IpoView = {
  id: 'ipo_old',
  address: ADDRESS,
  status: 'DEFERRED',
  reason: 'TRACK_RECORD: pnl summary timed out',
  ticker: null,
  verdict: {
    decision: 'DEFERRED',
    rating: null,
    prospectus: null,
    hedgeLinks: [],
    checks: MEMBERS.map((m) => ({
      id: m.id,
      status: m.id === 'TRACK_RECORD' ? 'UNKNOWN' : 'PASS',
      detail: 'checked',
    })),
  },
  createdAt: T0 - 3_600_000,
  decidedAt: T0 - 3_590_000,
};

function desk(apply: () => Response) {
  const runtime = testRuntime({
    'GET /api/me': () =>
      json({
        player: { id: 'p1', handle: 'Tester', kind: 'human', walletAddress: null, createdAt: 0 },
        portfolio: portfolio(),
        seasons: [],
      }),
    'GET /api/ipo': () => json({ apps: [] }),
    'GET /api/ipo/ipo_old': () => json({ app: denied }),
    'POST /api/ipo': apply,
  });
  render(
    <Wrap runtime={runtime}>
      <IpoDesk initialApps={[]} initialApp={null} />
    </Wrap>,
  );
}

async function nominate() {
  fireEvent.change(await screen.findByLabelText('Hyperliquid address'), {
    target: { value: ADDRESS },
  });
  // The player bootstraps from /api/me first; the desk needs its token.
  await new Promise((r) => setTimeout(r, 0));
  fireEvent.click(screen.getByRole('button', { name: 'Send to the committee' }));
}

beforeEach(() => {
  localStorage.setItem(TOKEN_KEY, 'tok');
  // jsdom lays nothing out, so it has no scrolling.
  Element.prototype.scrollIntoView = () => undefined;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('IPO desk answers', () => {
  it('opens the application the address already has (200) instead of starting a new one', async () => {
    desk(() => json({ app: denied }, 200));
    await nominate();
    expect((await screen.findByTestId('ipo-existing')).textContent).toMatch(
      /already has an application/,
    );
    expect(await screen.findByText('Deferred: evidence unavailable')).toBeTruthy();
  });

  it('starts the committee on a new application (202)', async () => {
    desk(() => json({ app: { ...denied, id: 'ipo_new', status: 'PENDING', verdict: null } }, 202));
    await nominate();
    expect(await screen.findByText('Committee reviewing 0x3b3b…3b3b.')).toBeTruthy();
    expect(screen.queryByTestId('ipo-existing')).toBeNull();
  });

  it.each([
    ['RECENTLY_DENIED', 409, /denied this address in the last 7 days/],
    ['COOLING_DOWN', 409, /cooling down after a bankruptcy/],
    ['ALREADY_LISTED', 409, /already listed on the floor as OOH/],
    ['IPO_DESK_BUSY', 429, /desk is full for this hour/],
  ])('explains %s', async (code, status, text) => {
    desk(() => json({ error: code, message: 'already listed as OOH' }, status));
    await nominate();
    expect((await screen.findByRole('alert')).textContent).toMatch(text);
  });
});
