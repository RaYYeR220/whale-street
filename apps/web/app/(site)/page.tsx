import { LandingView } from '../../components/landing/LandingView';
import { serverApi } from '../../lib/server';

export const dynamic = 'force-dynamic';

export default async function LandingPage() {
  const api = serverApi();
  const [companies, apps] = await Promise.all([api.companies(), api.ipoList(50)]);
  const denied =
    (apps.ok ? apps.data.apps : []).find(
      (a) => a.status === 'DENIED' && (a.verdict?.hedgeLinks.length ?? 0) > 0,
    ) ??
    (apps.ok ? apps.data.apps : []).find((a) => a.status === 'DENIED') ??
    null;
  return (
    <LandingView initialCompanies={companies.ok ? companies.data.companies : []} denied={denied} />
  );
}
