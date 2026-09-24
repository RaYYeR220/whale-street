import type { Metadata } from 'next';
import { BoardView } from '../../../components/board/BoardView';
import { EngineOffline } from '../../../components/chrome/EngineOffline';
import { serverApi } from '../../../lib/server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Board',
  description: 'Season standings: every player, bot and agent ranked by net worth.',
};

export default async function BoardPage() {
  const api = serverApi();
  const [seasons, rows] = await Promise.all([api.seasons(), api.leaderboard(50)]);
  // No standings is not an empty board: say the engine did not answer.
  if (!rows.ok) return <EngineOffline what="the board" message={rows.message} />;
  return (
    <BoardView
      seasons={seasons.ok ? [...seasons.data.seasons].sort((a, b) => b.id - a.id) : []}
      initialRows={rows.data.rows}
    />
  );
}
