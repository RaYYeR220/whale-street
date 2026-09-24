import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { EngineOffline } from '../../../../components/chrome/EngineOffline';
import { IpoDesk } from '../../../../components/ipo/IpoDesk';
import { headline } from '../../../../lib/committee';
import { shortAddress } from '../../../../lib/format';
import { serverApi } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const r = await serverApi().ipo(id);
  if (!r.ok) return { title: 'Verdict' };
  const title = `${headline(r.data.app, null)} (${shortAddress(r.data.app.address)})`;
  return { title, description: `The Whale Street listing committee on ${r.data.app.address}.` };
}

export default async function VerdictPage({ params }: Props) {
  const { id } = await params;
  const api = serverApi();
  const [app, list] = await Promise.all([api.ipo(id), api.ipoList(12)]);
  if (!app.ok) {
    if (app.status === 404) notFound();
    return <EngineOffline what="this verdict" message={app.message} />;
  }
  return <IpoDesk initialApps={list.ok ? list.data.apps : []} initialApp={app.data.app} />;
}
