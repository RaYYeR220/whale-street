'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { CompanyDetail } from '../../lib/api';
import type { FilingView, HistoryPoint, IpoView } from '../../lib/api-types';
import { bucketSeries, MAX_HISTORY_MIN, type Range, rangeMinutes } from '../../lib/chart';
import { toDisplay } from '../../lib/company';
import { price } from '../../lib/format';
import { mergeSeries, type Series, seriesFromHistory } from '../../lib/store';
import { useChannels, useEngine, useEngineNow, useEngineRuntime } from '../providers/engine';
import { usePlayer } from '../providers/player';
import { CompanyHead } from './CompanyHead';
import { NavChart } from './NavChart';
import { DeskPanel, FilingsTimeline, Holders, Prospectus, RiskPanel } from './Panels';
import { TradeTicket } from './TradeTicket';

const MirrorPanel = dynamic(() => import('../mirror/MirrorPanel'), {
  ssr: false,
  loading: () => (
    <section className="co-ticket co-mirror" aria-label="Mirror with real money">
      <p style={{ padding: 16, margin: 0 }}>Loading Mirror…</p>
    </section>
  ),
});

export const DETAIL_REFRESH_MS = 15_000;

export function CompanyView({
  ticker,
  initial,
  initialHistory,
}: {
  ticker: string;
  initial: CompanyDetail;
  initialHistory: HistoryPoint[];
}) {
  useChannels(['market', 'filings']);
  const { api, store } = useEngineRuntime();
  const entry = useEngine((s) => s.market?.byTicker[ticker]);
  const live = useEngine((s) => s.series[ticker]);
  const liveFilings = useEngine((s) => s.filings);
  const epoch = useEngine((s) => s.epoch);
  const now = useEngineNow();
  const { player } = usePlayer();
  const [detail, setDetail] = useState<CompanyDetail>(initial);
  const [range, setRange] = useState<Range>('1h');
  const [history, setHistory] = useState<{ range: Range; series: Series } | null>(null);
  const [loadingRange, setLoadingRange] = useState(false);
  const [record, setRecord] = useState<IpoView | null>(null);
  const [lit, setLit] = useState<ReadonlySet<number>>(new Set());
  const [sheet, setSheet] = useState<'trade' | 'mirror' | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: seed once per replay epoch
  useEffect(() => {
    store.seedSeries(ticker, initialHistory);
  }, [store, ticker, epoch]);

  const tickerFilingsHead = liveFilings.find((f) => f.ticker === ticker)?.id ?? null;
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const r = await api.company(ticker);
      if (!cancelled && r.ok) {
        setDetail(r.data);
        store.setView(r.data.company);
      }
    };
    const t = setTimeout(load, tickerFilingsHead === null ? DETAIL_REFRESH_MS : 1_000);
    const id = setInterval(load, DETAIL_REFRESH_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
      clearInterval(id);
    };
  }, [api, store, ticker, tickerFilingsHead]);

  useEffect(() => {
    let cancelled = false;
    void api.ipoList(100).then((r) => {
      if (cancelled || !r.ok) return;
      setRecord(r.data.apps.find((a) => a.ticker === ticker && a.status === 'APPROVED') ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [api, ticker]);

  const view = detail.company;
  const listedAt = view.listedAt;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload a range when the replay loop restarts
  useEffect(() => {
    if (range === '1h' || now === null) return;
    let cancelled = false;
    setLoadingRange(true);
    void api.history(ticker, rangeMinutes(range, listedAt, now)).then((r) => {
      if (cancelled) return;
      setLoadingRange(false);
      if (r.ok) setHistory({ range, series: seriesFromHistory(r.data.points) });
    });
    return () => {
      cancelled = true;
    };
  }, [api, ticker, range, listedAt, epoch, now === null]);

  const c = toDisplay(entry, view, live, now);
  const chartSeries = useMemo(() => {
    if (now === null) return null;
    const minutes = rangeMinutes(range, listedAt, now);
    const base =
      range === '1h'
        ? live
        : history?.range === range
          ? mergeSeries(history.series, live)
          : undefined;
    if (range !== '1h' && !base) return null;
    return bucketSeries(base, now, minutes);
  }, [range, live, history, now, listedAt]);

  const filings = useMemo(() => {
    const seen = new Set<number>();
    const out: FilingView[] = [];
    for (const f of [...liveFilings.filter((x) => x.ticker === ticker), ...detail.filings]) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      out.push(f);
    }
    return out.sort((a, b) => b.at - a.at || b.id - a.id);
  }, [liveFilings, detail.filings, ticker]);

  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSheet(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sheet]);

  if (!c) return null;
  const chartStatus =
    c.display === 'bankrupt' || c.display === 'delisted'
      ? 'bankrupt'
      : c.display === 'halted'
        ? 'halted'
        : 'active';
  const ipoRangeAvailable =
    listedAt !== null && now !== null && now - listedAt <= MAX_HISTORY_MIN * 60_000;

  return (
    <>
      <a className="co-skip" href="#chart-h">
        Skip to the chart
      </a>
      <a className="co-skip" href="#trade-h">
        Skip to the trade ticket
      </a>
      <div className="co-page">
        <nav className="co-crumb" aria-label="Breadcrumb">
          <Link href="/floor" className="co-back">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M10 3 L5 8 L10 13"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            The floor
          </Link>
          <span aria-current="page">{c.ticker}</span>
        </nav>
        <main className="co-main" id="main">
          <CompanyHead c={c} holders={detail.holders} now={now} provenance={view.provenance} />
          <NavChart
            ticker={c.ticker}
            series={chartSeries}
            range={range}
            onRange={setRange}
            filings={filings}
            now={now}
            status={chartStatus}
            listedAt={listedAt}
            ipoRangeAvailable={ipoRangeAvailable}
            loading={loadingRange}
            onPickFilings={(ids) => setLit(new Set(ids))}
          />
          <div className="co-row co-row--risk">
            <RiskPanel c={c} />
            <DeskPanel c={c} now={now} provenance={view.provenance} />
          </div>
          <div className="co-row co-row--files">
            <FilingsTimeline filings={filings} now={now} lit={lit} />
            <div className="co-stack">
              <Prospectus c={c} prospectus={view.prospectus} source={view.source} record={record} />
              <Holders holders={detail.holders} you={player?.handle ?? null} />
            </div>
          </div>
          <footer className="co-foot">
            <p>
              NAV is the trader's real Hyperliquid performance per share, read from Nansen. Share
              price is NAV plus whatever the crowd pays on top. Trade uses play money; Mirror uses
              your own USDC on Hyperliquid.
            </p>
            <span>
              Powered by <b>Nansen API</b>
            </span>
          </footer>
        </main>
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the rail becomes a modal dialog while it is open as a sheet */}
        <aside
          id="rail"
          className={`co-rail${sheet ? ' is-open' : ''}`}
          data-sheet={sheet ?? undefined}
          aria-label="Trade and mirror"
          role={sheet ? 'dialog' : undefined}
          aria-modal={sheet ? true : undefined}
        >
          <div className="co-sheet__head">
            <span className="co-sheet__grab" aria-hidden="true" />
            <button
              className="ws-x"
              type="button"
              aria-label="Close"
              onClick={() => setSheet(null)}
            >
              ×
            </button>
          </div>
          <TradeTicket c={c} now={now} />
          <MirrorPanel view={view} />
        </aside>
      </div>
      {sheet ? (
        <div className="ws-scrim is-open" onClick={() => setSheet(null)} aria-hidden="true" />
      ) : null}
      <div className="co-actbar">
        <div className="co-actbar__px">
          <b>{c.ticker}</b>
          <span className="ws-num">{price(c.price)}</span>
        </div>
        <button
          className="ws-btn"
          type="button"
          aria-controls="rail"
          onClick={() => setSheet('trade')}
        >
          Trade
        </button>
        <button
          className="ws-btn ws-btn--short"
          type="button"
          aria-controls="rail"
          onClick={() => setSheet('mirror')}
        >
          Mirror
        </button>
      </div>
    </>
  );
}
