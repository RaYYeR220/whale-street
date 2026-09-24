import type { Metadata } from 'next';
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
  return <IpoDesk initialApps={r.ok ? r.data.apps : []} initialApp={null} />;
}
