import type { Metadata } from 'next';
import { EngineOffline } from '../../../components/chrome/EngineOffline';
import { IpoDesk } from '../../../components/ipo/IpoDesk';
import { serverApi } from '../../../lib/server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'IPO desk',
  description:
    'Send a Hyperliquid address to the listing committee. Six checks on Nansen data decide whether the trader lists.',
};

export default async function IpoPage() {
  const r = await serverApi().ipoList(12);
  // No verdict wall is not an empty one: say the engine did not answer.
  if (!r.ok) return <EngineOffline what="the IPO desk" message={r.message} />;
  return <IpoDesk initialApps={r.data.apps} initialApp={null} />;
}
