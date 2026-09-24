import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { EngineOffline } from '../../../../components/chrome/EngineOffline';
import { CompanyView } from '../../../../components/company/CompanyView';
import { serverApi } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ ticker: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { ticker } = await params;
  const r = await serverApi().company(ticker);
  if (!r.ok) return { title: ticker.toUpperCase() };
  const c = r.data.company;
  return {
    title: `${c.ticker}, ${c.name}`,
    description: `${c.name} is a real Hyperliquid trader listed on Whale Street. NAV from Nansen, price from the crowd.`,
  };
}

export default async function CompanyPage({ params }: Props) {
  const { ticker } = await params;
  const api = serverApi();
  const [detail, history] = await Promise.all([api.company(ticker), api.history(ticker, 60)]);
  if (!detail.ok) {
    if (detail.status === 404) notFound();
    return <EngineOffline what={`${ticker.toUpperCase()}'s page`} message={detail.message} />;
  }
  return (
    <CompanyView
      ticker={detail.data.company.ticker}
      initial={detail.data}
      initialHistory={history.ok ? history.data.points : []}
    />
  );
}
