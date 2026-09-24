import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BoardView, splitBoard } from '../components/board/BoardView';
import { ProfileView } from '../components/profile/ProfileView';
import type { LeaderboardEntry } from '../lib/api-types';
import { portfolio, T0 } from './helpers';
import { Wrap } from './render';

const row = (
  rank: number,
  handle: string,
  kind: LeaderboardEntry['kind'],
  netWorth: number | null,
): LeaderboardEntry => ({
  rank,
  playerId: `p${rank}`,
  handle,
  kind,
  netWorth,
});

describe('season standings', () => {
  it('puts the top three on the podium and counts the machines there honestly', () => {
    const html = renderToStaticMarkup(
      <Wrap>
        <BoardView
          seasons={[{ id: 1, startedAt: T0, endsAt: T0 + 7 * 86_400_000, status: 'ACTIVE' }]}
          initialRows={[
            row(1, 'Vulture Fund', 'bot', 10_400),
            row(2, 'Molten Mako #833', 'human', 10_055),
            row(3, 'Heron Agent #3', 'agent', 9_990),
            row(4, 'Soggy Tuna #19', 'human', 9_800),
          ]}
        />
      </Wrap>,
    );
    expect(html).toContain('2 of the top 3 are machines');
    // Row 4 is listed under the podium; podium rows are not repeated there.
    const [podium, list] = html.split('<ol class="bd-list">') as [string, string];
    expect(podium).toContain('Vulture Fund');
    expect(list).toContain('Soggy Tuna #19');
    expect(list).not.toContain('Vulture Fund');
  });

  it('shows an unknown net worth as a dash', () => {
    const html = renderToStaticMarkup(
      <Wrap>
        <BoardView
          seasons={[]}
          initialRows={[
            row(1, 'A', 'human', 10_000),
            row(2, 'B', 'human', null),
            row(3, 'C', 'bot', 9_000),
            row(4, 'D', 'human', null),
          ]}
        />
      </Wrap>,
    );
    expect(html).toContain('—');
    expect(html).not.toContain('NaN');
  });

  it('says so when nobody is below the podium', () => {
    const html = renderToStaticMarkup(
      <Wrap>
        <BoardView seasons={[]} initialRows={[row(1, 'Vulture Fund', 'bot', 10_000)]} />
      </Wrap>,
    );
    expect(html).toContain('No one else on the board yet.');
    expect(html).toContain('1 of the top 1 is a machine');
  });
});

describe('player profile', () => {
  it('shows the record and hides net worth when a price is missing', () => {
    const html = renderToStaticMarkup(
      <Wrap>
        <ProfileView
          profile={{
            player: {
              id: 'p9',
              handle: 'Velvet Anchovy #412',
              kind: 'human',
              createdAt: T0,
              walletLinked: false,
            },
            portfolio: portfolio({ netWorth: null, netWorthReason: 'QLP has no live price' }),
            seasons: [],
            trades: [],
          }}
        />
      </Wrap>,
    );
    expect(html).toContain('Velvet Anchovy #412');
    expect(html).toContain('Net worth is hidden: QLP has no live price.');
    expect(html).toContain('No holdings this season.');
  });
});

describe('the list under the podium', () => {
  const rows = [
    { rank: 1, handle: 'Ada', kind: 'human', netWorth: 10_400, you: false },
    { rank: 2, handle: 'Vulture Fund', kind: 'bot', netWorth: 10_300, you: false },
    { rank: 3, handle: 'Me', kind: 'human', netWorth: 10_200, you: true },
    { rank: 4, handle: 'Bea', kind: 'human', netWorth: 10_100, you: false },
    { rank: 5, handle: 'Deep Kelp', kind: 'agent', netWorth: 10_000, you: false },
  ] as const;

  it('never repeats a podium row, whatever the filter', () => {
    for (const filter of ['all', 'human', 'machine'] as const) {
      const { top, list } = splitBoard([...rows], filter);
      expect(top.map((r) => r.handle)).toEqual(['Ada', 'Vulture Fund', 'Me']);
      expect(list.filter((r) => top.includes(r))).toEqual([]);
    }
    expect(splitBoard([...rows], 'human').list.map((r) => r.handle)).toEqual(['Bea']);
    expect(splitBoard([...rows], 'machine').list.map((r) => r.handle)).toEqual(['Deep Kelp']);
    expect(splitBoard([...rows], 'all').list.map((r) => r.handle)).toEqual(['Bea', 'Deep Kelp']);
  });
});
