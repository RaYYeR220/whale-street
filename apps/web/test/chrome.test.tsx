// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardView } from '../components/board/BoardView';
import { Banners } from '../components/chrome/Banners';
import { EngineOffline } from '../components/chrome/EngineOffline';
import { ModeBadge } from '../components/chrome/ModeBadge';
import { PlayerChip } from '../components/chrome/PlayerChip';
import { SeasonClock } from '../components/chrome/SeasonClock';
import { isCurrent, NAV } from '../components/chrome/TopBar';
import { EngineProvider, type EngineRuntime } from '../components/providers/engine';
import { createApi } from '../lib/api';
import { PLAYER_RETRY_MS } from '../lib/player';
import { createEngineStore } from '../lib/store';
import { EngineSocket } from '../lib/ws-client';
import { FakeSocket, fakeFetch, json, portfolio, status, T0 } from './helpers';
import { testRuntime, Wrap } from './render';

function runtime(): EngineRuntime {
  return {
    api: createApi('http://engine.test', fakeFetch({}).impl),
    store: createEngineStore(),
    socket: new EngineSocket({
      url: 'ws://engine.test/ws',
      createSocket: (u) => new FakeSocket(u),
    }),
    tokenRef: { current: null },
  };
}

function mount(ui: React.ReactNode) {
  const rt = runtime();
  render(<EngineProvider runtime={rt}>{ui}</EngineProvider>);
  return rt;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('mode badge (never hidden)', () => {
  it('says CONNECTING before the engine reports its mode', () => {
    mount(<ModeBadge />);
    expect(screen.getByText('CONNECTING')).toBeTruthy();
  });

  it('shows REPLAY with a short label for phones', () => {
    const rt = mount(<ModeBadge />);
    act(() => rt.store.setStatus(status({ mode: 'replay' })));
    const badge = screen.getByText('REPLAY · recorded session');
    expect(badge.getAttribute('data-mode')).toBe('replay');
    expect(badge.getAttribute('data-short')).toBe('REPLAY');
  });

  it('says which replay loop is playing', () => {
    const rt = mount(<ModeBadge />);
    act(() =>
      rt.store.setStatus(
        status({ mode: 'replay', loop: { index: 2, startT: T0, endT: T0 + 600_000 } }),
      ),
    );
    expect(screen.getByText('REPLAY · recorded session · loop 3')).toBeTruthy();
  });

  it('keeps the last known mode when the engine stops answering', () => {
    const rt = mount(<ModeBadge />);
    act(() => rt.store.setStatus(status({ mode: 'replay' })));
    act(() => rt.store.setConnection('reconnecting'));
    expect(screen.getByText('REPLAY · recorded session')).toBeTruthy();
  });

  it('shows credit-saver from the engine’s flag, never from the credits number', () => {
    const rt = mount(<ModeBadge />);
    act(() =>
      rt.store.setStatus(status({ mode: 'live', creditSaver: true, creditsRemaining: 9_000 })),
    );
    expect(screen.getByText('CREDIT-SAVER: positions via Hyperliquid')).toBeTruthy();
    act(() =>
      rt.store.setStatus(status({ mode: 'live', creditSaver: false, creditsRemaining: 3 })),
    );
    expect(screen.queryByText('CREDIT-SAVER: positions via Hyperliquid')).toBeNull();
  });

  it('names the synthetic demo', () => {
    const rt = mount(<ModeBadge />);
    act(() => rt.store.setStatus(status({ synthetic: true })));
    expect(screen.getByText('REPLAY · synthetic demo')).toBeTruthy();
  });

  it('shows LIVE and the credit-saver note together', () => {
    const rt = mount(<ModeBadge />);
    act(() => rt.store.setStatus(status({ mode: 'live', creditSaver: true })));
    expect(screen.getByText('LIVE').getAttribute('data-mode')).toBe('live');
    expect(screen.getByText('CREDIT-SAVER: positions via Hyperliquid')).toBeTruthy();
  });
});

describe('data-health banners', () => {
  it('shows nothing while everything is healthy', () => {
    const rt = mount(<Banners />);
    act(() => {
      rt.store.setConnection('open');
      rt.store.setStatus(status());
    });
    expect(screen.queryAllByRole('status')).toHaveLength(0);
  });

  it('says every degraded state out loud', () => {
    const rt = mount(<Banners />);
    act(() => {
      rt.store.setConnection('reconnecting');
      rt.store.setStatus(status({ marksDelayed: true, idle: true, creditFloor: true }));
    });
    const keys = screen.getAllByRole('status').map((el) => el.getAttribute('data-banner'));
    expect(keys).toEqual(['ws', 'marks', 'idle', 'floor']);
    expect(screen.getByText(/NAV is frozen, not guessed/)).toBeTruthy();
  });

  it('says when the engine turned this network away for too many connections or messages', () => {
    const rt = mount(<Banners />);
    act(() => rt.store.setConnection('limited'));
    const banner = document.querySelector('[data-banner="limit"]');
    expect(banner?.textContent).toMatch(/Too many connections or messages from your network/);
  });

  it('reports an unreachable engine after 5 seconds of connecting', () => {
    vi.useFakeTimers();
    const rt = mount(<Banners />);
    act(() => rt.store.setConnection('connecting'));
    expect(screen.queryByText(/Cannot reach the engine/)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText(/Cannot reach the engine/)).toBeTruthy();
  });
});

describe('engine offline page', () => {
  it('names what could not load and why', () => {
    render(<EngineOffline what="this company" message="cannot reach the engine (fetch failed)" />);
    expect(screen.getByRole('heading').textContent).toMatch(/this company/);
    expect(screen.getByText(/fetch failed/)).toBeTruthy();
  });
});

describe('navigation', () => {
  it('marks the floor current on company pages', () => {
    expect(NAV.map((n) => n.href)).toEqual(['/floor', '/ipo', '/leaderboard', '/agents']);
    expect(isCurrent('/c/OOH', '/floor')).toBe(true);
    expect(isCurrent('/ipo/abc', '/ipo')).toBe(true);
    expect(isCurrent('/ipox', '/ipo')).toBe(false);
  });
});

describe('player chip', () => {
  it('says why the net worth is hidden, in visible text as well as the label', async () => {
    const player = { id: 'p1', handle: 'Tester', kind: 'human', walletAddress: null, createdAt: 0 };
    const rt = testRuntime({
      'POST /api/players': () => json({ player, token: 'tok' }),
      'GET /api/me': () =>
        json({
          player,
          portfolio: portfolio({ netWorth: null, netWorthReason: 'missing live price for OOH' }),
          seasons: [],
        }),
    });
    render(
      <Wrap runtime={rt}>
        <PlayerChip />
      </Wrap>,
    );
    const chip = await screen.findByRole('button', { name: /^Your desk: Tester/ });
    expect(chip.textContent).toContain('—');
    expect(screen.getByText(/missing live price for OOH/)).toBeTruthy();
    expect(chip.getAttribute('aria-label')).toMatch(/net worth — \(missing live price for OOH\)/);
    localStorage.clear();
  });

  it('keeps a long reason short in the chip and whole in its label and tooltip', async () => {
    const player = { id: 'p1', handle: 'Tester', kind: 'human', walletAddress: null, createdAt: 0 };
    const why = 'no live price for GBC, QLP and OOH while their marks are delayed';
    const rt = testRuntime({
      'POST /api/players': () => json({ player, token: 'tok' }),
      'GET /api/me': () =>
        json({
          player,
          portfolio: portfolio({ netWorth: null, netWorthReason: why }),
          seasons: [],
        }),
    });
    render(
      <Wrap runtime={rt}>
        <PlayerChip />
      </Wrap>,
    );
    const chip = await screen.findByRole('button', { name: /^Your desk: Tester/ });
    expect(chip.textContent).toContain('no live price for GBC, QLP…');
    expect(chip.textContent).not.toContain(why);
    expect(chip.getAttribute('aria-label')).toContain(why);
    expect(chip.querySelector(`[title="${why}"]`)).toBeTruthy();
    localStorage.clear();
  });
});

describe('player chip without a player', () => {
  it('says why signup failed and tries again by itself, backing off', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const player = { id: 'p1', handle: 'Tester', kind: 'human', walletAddress: null, createdAt: 0 };
    let signups = 0;
    const rt = testRuntime({
      'POST /api/players': () => {
        signups += 1;
        return signups < 3
          ? json({ error: 'RATE_LIMITED', message: 'too many new players from this address' }, 429)
          : json({ player, token: 'tok' }, 201);
      },
      'GET /api/me': () => json({ player, portfolio: portfolio(), seasons: [] }),
    });
    render(
      <Wrap runtime={rt}>
        <PlayerChip />
      </Wrap>,
    );
    const chip = await vi.waitFor(() =>
      screen.getByRole('button', { name: /^Your desk: no player yet/ }),
    );
    expect(chip.textContent).toContain('No player yet');
    expect(chip.textContent).toContain('Too many new players');
    expect(chip.getAttribute('aria-label')).toMatch(
      /Too many new players from your network in the last hour\. Trying again by itself\./,
    );
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(signups).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(PLAYER_RETRY_MS[0] ?? 0));
    await vi.waitFor(() => expect(signups).toBe(2));
    await act(() => vi.advanceTimersByTimeAsync(PLAYER_RETRY_MS[1] ?? 0));
    await vi.waitFor(() => screen.getByRole('button', { name: /^Your desk: Tester/ }));
    expect(signups).toBe(3);
    localStorage.clear();
  });
});

describe('the season in REPLAY', () => {
  const season = { id: 1, startedAt: T0, endsAt: T0 + 7 * 86_400_000, status: 'ACTIVE' as const };
  const board = (mode: 'live' | 'replay') => {
    const rt = testRuntime();
    rt.store.setStatus(status({ mode }), T0);
    render(
      <Wrap runtime={rt}>
        <SeasonClock />
        <BoardView seasons={[season]} initialRows={[]} />
      </Wrap>,
    );
    return document.body.textContent ?? '';
  };

  it('is a practice season: the recording loops and positions are revalued at each wrap', () => {
    const text = board('replay');
    expect(text).toContain('Practice season (replay) standings');
    expect(text).toContain('left in the practice season (replay)');
    expect(text).toMatch(/recorded session loops/);
    expect(text).not.toContain('Season 1 standings');
  });

  it('keeps the numbered season in LIVE', () => {
    const text = board('live');
    expect(text).toContain('Season 1 standings');
    expect(text).toContain('left in Season 1');
    expect(text).not.toContain('Practice season');
  });
});
