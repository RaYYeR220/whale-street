import type { Metadata } from 'next';
import { AgentsView } from '../../../components/agents/AgentsView';
import { serverApi } from '../../../lib/server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Agents',
  description:
    'Connect an AI agent to Whale Street over MCP. It trades the same floor, with the same play money, labelled on the tape.',
};

export default async function AgentsPage() {
  const r = await serverApi().companies();
  return <AgentsView initialCompanies={r.ok ? r.data.companies : []} />;
}
