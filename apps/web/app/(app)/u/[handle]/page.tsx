import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { EngineOffline } from '../../../../components/chrome/EngineOffline';
import { ProfileView } from '../../../../components/profile/ProfileView';
import { serverApi } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params;
  const name = decodeURIComponent(handle);
  return {
    title: name,
    description: `${name} on Whale Street: holdings, trades and season record.`,
  };
}

export default async function ProfilePage({ params }: Props) {
  const { handle } = await params;
  const r = await serverApi().profile(decodeURIComponent(handle));
  if (!r.ok) {
    if (r.status === 404) notFound();
    return <EngineOffline what="this profile" message={r.message} />;
  }
  return <ProfileView profile={r.data} />;
}
