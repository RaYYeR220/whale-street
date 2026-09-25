'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CompanyView, FilingView, TapeView } from '../../lib/api-types';
import { type DisplayCompany, toDisplay } from '../../lib/company';
import { place, rank, SLOTS, type SortKey } from '../../lib/roster';
import { isDown } from '../../lib/ws-client';
import { useTrade } from '../company/useTrade';
import { useReducedMotion } from '../ink/motion';
import { Portrait } from '../ink/Portrait';
import {
  useChannels,
  useCompanyViews,
  useEngine,
  useEngineNow,
  useEngineRuntime,
  useHourHistory,
} from '../providers/engine';
import { usePlayer } from '../providers/player';
import { CompanyPanel, QUICK_USD } from './CompanyPanel';
import { MarketStrip } from './MarketStrip';
import { Newsroom, StreetMood, Tape } from './Rails';

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: 'movers', label: 'Movers' },
  { key: 'hype', label: 'Hype' },
  { key: 'nearliq', label: 'Near liquidation' },
  { key: 'new', label: 'New listings' },
  { key: 'rated', label: 'Top rated' },
];

export function FloorView({
  initialCompanies,
  initialFilings,
  initialTape,
  engineError,
}: {
  initialCompanies: CompanyView[];
  initialFilings: FilingView[];
  initialTape: TapeView[];
  engineError: string | null;
}) {
  useChannels(['market', 'filings', 'tape', 'leaderboard']);
  const { store } = useEngineRuntime();
  const views = useCompanyViews(initialCompanies);
  const market = useEngine((s) => s.market);
  const series = useEngine((s) => s.series);
  const filings = useEngine((s) => s.filings);
  const tape = useEngine((s) => s.tape);
  const connection = useEngine((s) => s.connection);
  const now = useEngineNow();
  const { player } = usePlayer();
  const trade = useTrade();
  const reduce = useReducedMotion();
  const [sort, setSort] = useState<SortKey>('movers');
  const [sorting, setSorting] = useState(false);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [pinged, setPinged] = useState<string | null>(null);

  useEffect(() => {
    store.seedFilings(initialFilings);
  }, [store, initialFilings]);

  useEffect(() => {
    store.seedTape(initialTape);
  }, [store, initialTape]);

  const tickers = useMemo(() => {
    const set = new Set<string>(Object.keys(views));
    for (const e of market?.companies ?? []) set.add(e.ticker);
    return [...set].sort();
  }, [views, market?.companies]);
  useHourHistory(tickers);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), 120);
    return () => clearTimeout(id);
  }, [query]);

  const companies = useMemo(
    () =>
      tickers
        .map((t) => toDisplay(market?.byTicker[t], views[t], series[t], now))
        .filter((c): c is DisplayCompany => c !== null),
    [tickers, market?.byTicker, views, series, now],
  );
  const ranked = useMemo(() => rank(companies, sort, now), [companies, sort, now]);
  const placements = useMemo(() => place(ranked, debounced), [ranked, debounced]);
  const lastFiling = useMemo(() => {
    const m: Record<string, FilingView> = {};
    for (const f of filings) if (!m[f.ticker]) m[f.ticker] = f;
    return m;
  }, [filings]);

  const chooseSort = (key: SortKey) => {
    if (key === sort) return;
    if (reduce) {
      setSort(key);
      return;
    }
    setSorting(true);
    setTimeout(() => {
      setSort(key);
      setSorting(false);
    }, 180);
  };

  const pingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const go = (ticker: string) => {
    const el = document.getElementById(`co-${ticker}`);
    if (!el) return;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    setPinged(ticker);
    if (pingTimer.current) clearTimeout(pingTimer.current);
    pingTimer.current = setTimeout(() => setPinged(null), 1_600);
    el.querySelector<HTMLAnchorElement>('.ws-co__tk')?.focus({ preventScroll: true });
  };

  const onTrade = (kind: 'buy' | 'short', c: DisplayCompany) => {
    if (kind === 'buy') void trade({ ticker: c.ticker, side: 'BUY', cash: QUICK_USD });
    else if (c.price && c.price > 0)
      void trade({
        ticker: c.ticker,
        side: 'SHORT',
        qty: Math.floor((QUICK_USD / c.price) * 100) / 100,
      });
  };

  const loading = !market && companies.length === 0;
  const empty = market !== null && companies.length === 0;
  const offline = loading && (engineError !== null || isDown(connection));

  return (
    <>
      <MarketStrip companies={companies} now={now} />
      <main className="floor" id="main">
        <h1 className="ws-sr">The floor: every listed trader and their risk</h1>
        <div className="floor__main">
          <div className="floor__controls">
            <fieldset className="floor__chips" aria-label="Sort the floor by">
              {SORTS.map((s) => (
                <button
                  key={s.key}
                  className="ws-chip"
                  type="button"
                  aria-pressed={sort === s.key}
                  onClick={() => chooseSort(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </fieldset>
            <label className="ws-search">
              <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
                <circle
                  cx="8.5"
                  cy="8.5"
                  r="6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                />
                <path
                  d="M13 13 L18 18"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                />
              </svg>
              <span className="ws-sr">Find a trader</span>
              <input
                type="search"
                placeholder="Find a ticker or name"
                autoComplete="off"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="floor__meta">
              <p className="floor__hint">
                <b>Bigger panels need your attention.</b> Faces show how close each trader is to
                liquidation.
              </p>
              <div className="ws-legend">
                <span>
                  <i className="k k--nav" />
                  NAV, from Nansen
                </span>
                <span>
                  <i className="k k--price" />
                  Share price
                </span>
                <span>
                  <i className="sw sw--up" />
                  Hype premium
                </span>
                <span>
                  <i className="sw sw--down" />
                  Discount
                </span>
              </div>
            </div>
          </div>
          <div className={`roster${sorting ? ' is-sorting' : ''}`} id="roster" data-testid="roster">
            {offline ? (
              <div className="ws-panel ws-panel--flat roster__none">
                <div className="ws-offline">
                  <h2>The floor cannot reach the engine</h2>
                  <p>
                    {engineError ?? 'The live connection dropped.'} No price is shown until the
                    engine answers again.
                  </p>
                </div>
              </div>
            ) : loading ? (
              <>
                {SLOTS.map((s) => (
                  <div
                    key={`${s.col}-${s.row}`}
                    className="ws-panel ws-sketch"
                    style={{ gridColumn: s.col, gridRow: s.row }}
                    aria-hidden="true"
                  >
                    <span>loading</span>
                  </div>
                ))}
                <p className="ws-sr" role="status">
                  Loading the floor
                </p>
              </>
            ) : empty ? (
              <div className="ws-panel roster__none" style={{ ['--rot' as string]: '-.3deg' }}>
                <div className="ws-empty">
                  <Portrait
                    seed="EMPTY-FLOOR"
                    hp={1}
                    status="halted"
                    size={140}
                    label="An empty desk"
                  />
                  <h2>The floor opens when the first trader is listed</h2>
                  <p>
                    Send a Hyperliquid address to the listing committee. If it passes all six
                    checks, it lists here with an IPO window.
                  </p>
                  <Link className="ws-btn" href="/ipo">
                    Go to the IPO desk
                  </Link>
                </div>
              </div>
            ) : placements.length === 0 ? (
              <div className="ws-panel ws-panel--flat roster__none">
                <div className="ws-empty">
                  <h2>No listed trader matches “{debounced}”</h2>
                  <p>Try a ticker, or clear the search to see the whole floor.</p>
                  <button
                    className="ws-btn ws-btn--quiet"
                    type="button"
                    onClick={() => setQuery('')}
                  >
                    Clear search
                  </button>
                </div>
              </div>
            ) : (
              placements.map((p) => (
                <CompanyPanel
                  key={p.company.ticker}
                  c={p.company}
                  slot={p.slot}
                  why={ranked.why[p.company.ticker]}
                  lastFiling={lastFiling[p.company.ticker]}
                  now={now}
                  pinged={pinged === p.company.ticker}
                  onTrade={onTrade}
                />
              ))
            )}
          </div>
        </div>
        <aside className="floor__rail" aria-label="Floor news">
          <Newsroom filings={filings} byTicker={market?.byTicker ?? {}} now={now} onGo={go} />
          <StreetMood mood={market?.mood ?? []} now={now} />
          <Tape tape={tape} now={now} you={player?.handle ?? null} />
        </aside>
        <footer className="floor__foot">
          <p>
            NAV is the trader's real Hyperliquid performance per share, read from Nansen. Share
            price is NAV plus whatever the crowd pays on top. Play money only.
          </p>
          <span>
            Powered by <b>Nansen API</b>
          </span>
        </footer>
      </main>
    </>
  );
}
