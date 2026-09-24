import type { Metadata } from 'next';
import { EmbedWidget } from '../../../../components/embed/EmbedWidget';
import { serverApi } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ ticker: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { ticker } = await params;
  return { title: `${ticker.toUpperCase()} on Whale Street`, robots: { index: false } };
}

export default async function EmbedPage({ params }: Props) {
  const { ticker } = await params;
  const api = serverApi();
  const [detail, history, status] = await Promise.all([
    api.company(ticker),
    api.history(ticker, 60),
    api.status(),
  ]);
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? '';
  if (!detail.ok)
    return (
      <div className="em-body">
        <div className="em is-offline" role="status">
          <span className="em__head">
            {detail.status === 404
              ? `${ticker.toUpperCase()} is not listed on Whale Street.`
              : 'Whale Street is unreachable right now.'}
          </span>
        </div>
      </div>
    );
  return (
    <EmbedWidget
      view={detail.data.company}
      history={history.ok ? history.data.points : []}
      siteUrl={site}
      initialMode={status.ok ? status.data.mode : null}
    />
  );
}
