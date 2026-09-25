import type { Metadata } from 'next';
import { FloorView } from '../../../components/floor/FloorView';
import { serverApi } from '../../../lib/server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'The Floor',
  description: 'Every listed company is a real Hyperliquid trader. Their faces show their risk.',
};

export default async function FloorPage() {
  const api = serverApi();
  const [companies, filings, trades] = await Promise.all([
    api.companies(),
    api.filings({ limit: 40 }),
    api.trades({ limit: 40 }),
  ]);
  return (
    <FloorView
      initialCompanies={companies.ok ? companies.data.companies : []}
      initialFilings={filings.ok ? filings.data.filings : []}
      initialTape={trades.ok ? trades.data.trades : []}
      engineError={companies.ok ? null : companies.message}
    />
  );
}
