// @vitest-environment jsdom
/**
 * One player per tab: moving between the landing page and the app keeps the same player tree,
 * and even a remount never signs up a second anonymous player when storage is blocked.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineProvider } from '../components/providers/engine';
import { Providers } from '../components/providers/Providers';
import { PlayerProvider, usePlayer } from '../components/providers/player';
import { json, portfolio } from './helpers';
import { testRuntime } from './render';

const nav = vi.hoisted(() => ({ path: '/' as string | null }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.path }));

function Handle() {
  const { player } = usePlayer();
  return <p>{player ? player.handle : 'loading'}</p>;
}

/** An engine that signs up a new anonymous player on every POST /api/players. */
function engine() {
  let signups = 0;
  const rt = testRuntime({
    'POST /api/players': () => {
      signups += 1;
      return json({ player: { id: `p${signups}` }, token: `tok-${signups}` }, 201);
    },
    'GET /api/me': ({ init }) => {
      const token = new Headers(init.headers).get('authorization')?.replace('Bearer ', '') ?? '';
      const n = Number(token.replace('tok-', ''));
      return json({
        player: {
          id: `p${n}`,
          handle: `Player #${n}`,
          kind: 'human',
          walletAddress: null,
          createdAt: 0,
        },
        portfolio: portfolio(),
        seasons: [],
      });
    },
  });
  return { rt, signups: () => signups };
}

beforeEach(() => {
  // Blocked first-party storage (a strict privacy mode): the token cannot be kept on disk.
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  });
  nav.path = '/';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('one player per tab', () => {
  it('keeps the same player from the landing page into the app', async () => {
    const { rt, signups } = engine();
    const { rerender } = render(
      <Providers runtime={rt}>
        <main>
          <Handle />
        </main>
      </Providers>,
    );
    expect(await screen.findByText('Player #1')).toBeTruthy();
    // Client navigation to the floor: another page under the same root layout.
    nav.path = '/floor';
    rerender(
      <Providers runtime={rt}>
        <div>
          <Handle />
        </div>
      </Providers>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByText('Player #1')).toBeTruthy();
    expect(signups()).toBe(1);
  });

  it('reuses the tab’s player when the player tree mounts again without storage', async () => {
    const { rt, signups } = engine();
    const tree = (
      <EngineProvider runtime={rt}>
        <PlayerProvider>
          <Handle />
        </PlayerProvider>
      </EngineProvider>
    );
    const first = render(tree);
    expect(await screen.findByText('Player #1')).toBeTruthy();
    first.unmount();
    render(tree);
    expect(await screen.findByText('Player #1')).toBeTruthy();
    expect(signups()).toBe(1);
  });

  it('gives the embed widget no player at all', () => {
    nav.path = '/embed/OOH';
    const { rt } = engine();
    expect(() =>
      render(
        <Providers runtime={rt}>
          <Handle />
        </Providers>,
      ),
    ).toThrow(/inside <PlayerProvider>/);
  });
});
