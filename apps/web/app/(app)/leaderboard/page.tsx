import type { Metadata } from 'next';
import { BoardView } from '../../../components/board/BoardView';
import { serverApi } from '../../../lib/server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Board',
  description: 'Season standings: every player, bot and agent ranked by net worth.',
};

export default async function BoardPage() {
  const api = serverApi();
  const [seasons, rows] = await Promise.all([api.seasons(), api.leaderboard(50)]);
  return (
    <BoardView
      seasons={seasons.ok ? [...seasons.data.seasons].sort((a, b) => b.id - a.id) : []}
      initialRows={rows.ok ? rows.data.rows : []}
    />
  );
}
