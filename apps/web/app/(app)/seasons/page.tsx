import { redirect } from 'next/navigation';

/** Seasons live on the Board, which has the season picker (current season and every closed one). */
export default function SeasonsPage() {
  redirect('/leaderboard');
}
