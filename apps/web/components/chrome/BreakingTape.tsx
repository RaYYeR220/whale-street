'use client';

import Link from 'next/link';
import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { displayStatus, hypeOf, portraitStatus } from '../../lib/company';
import { filingText, foldRepeats } from '../../lib/filings';
import { ago, agoSec, compact } from '../../lib/format';
import { Portrait } from '../ink/Portrait';
import { useChannels, useEngine, useEngineNow, useEngineRuntime } from '../providers/engine';

const BIG_TRADE_USD = 5_000;
const VERB = { BUY: 'bought', SELL: 'sold', SHORT: 'shorted', COVER: 'covered' } as const;

interface Item {
  key: string;
  ticker: string;
  companyId: string | null;
  kind: string;
  text: string;
  ago: string;
}

function Face({ ticker, companyId }: { ticker: string; companyId: string | null }) {
  const e = useEngine((s) => s.market?.byTicker[ticker]);
  return (
    <span className="ws-breaking__face">
      <Portrait
        seed={companyId ?? e?.id ?? ticker}
        hp={e?.hp}
        hype={hypeOf(e?.mult)}
        status={e ? portraitStatus(displayStatus(e.status, null, null)) : 'active'}
        size={42}
        label=""
      />
    </span>
  );
}

function ItemLink({ it, hidden }: { it: Item; hidden?: boolean }) {
  return (
    <Link
      className="ws-breaking__item"
      href={`/c/${it.ticker}`}
      data-kind={it.kind}
      tabIndex={hidden ? -1 : undefined}
      aria-hidden={hidden ? true : undefined}
    >
      <Face ticker={it.ticker} companyId={it.companyId} />
      <span className="ws-breaking__tk">{it.ticker}</span>
      <span className="ws-breaking__txt">{it.text}</span>
      <span className="ws-breaking__ago">{it.ago}</span>
    </Link>
  );
}

/** Scrolling manga news strip of the latest filings and big trades (one rotating line on phones). */
export function BreakingTape() {
  useChannels(['filings', 'tape']);
  const { api, store } = useEngineRuntime();
  const epoch = useEngine((s) => s.epoch);
  const filings = useEngine((s) => s.filings);
  const tape = useEngine((s) => s.tape);
  const now = useEngineNow(15_000);
  // The socket only pushes new filings; backfill the latest ones on every page and replay loop.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the replay epoch changes
  useEffect(() => {
    let cancelled = false;
    void api.filings({ limit: 20 }).then((r) => {
      if (!cancelled && r.ok) store.seedFilings(r.data.filings);
    });
    return () => {
      cancelled = true;
    };
  }, [api, store, epoch]);
  const items = useMemo<Item[]>(() => {
    const f = foldRepeats(filings)
      .slice(0, 12)
      .map(({ filing: x }) => ({
        key: `f${x.id}`,
        ticker: x.ticker,
        companyId: x.companyId,
        kind: x.kind === 'CLOSE' && (x.realizedPnlUsd ?? 0) > 0 ? 'EARNINGS' : x.kind,
        text: filingText(x),
        ago: now === null ? '' : ago(now - x.at),
      }));
    const big = tape
      .filter((t) => t.cash > BIG_TRADE_USD)
      .slice(0, 6)
      .map((t, i) => ({
        key: `t${t.at}-${i}`,
        ticker: t.ticker,
        companyId: null,
        kind: 'TRADE',
        text: `${t.handle} ${VERB[t.side]} ${compact(t.cash)}`,
        ago: now === null ? '' : agoSec(now - t.at),
      }));
    const out: Item[] = [];
    f.forEach((it, i) => {
      out.push(it);
      const b = big[i];
      if (b) out.push(b);
    });
    return out;
  }, [filings, tape, now]);
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((n) => n + 1), 4_200);
    return () => clearInterval(id);
  }, []);
  const one = items.length ? items[i % items.length] : undefined;
  return (
    <section className="ws-breaking" aria-label="Breaking news">
      <div className="ws-breaking__label" aria-hidden="true">
        BREAKING
      </div>
      <div className="ws-breaking__viewport">
        {items.length === 0 ? (
          <span className="ws-breaking__item" style={{ cursor: 'default' }}>
            <span className="ws-breaking__txt">
              No filings yet. The newsroom prints the first one here.
            </span>
          </span>
        ) : (
          <div
            className="ws-breaking__track"
            style={{ '--marquee-s': `${items.length * 5}s` } as CSSProperties}
          >
            {items.map((it) => (
              <ItemLink key={it.key} it={it} />
            ))}
            {items.map((it) => (
              <ItemLink key={`${it.key}-copy`} it={it} hidden />
            ))}
          </div>
        )}
      </div>
      <div className="ws-breaking__one" aria-live="off">
        {one ? <ItemLink it={one} /> : null}
      </div>
    </section>
  );
}
