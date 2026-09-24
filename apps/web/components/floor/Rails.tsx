'use client';

import { Fragment, useMemo, useState } from 'react';
import type { FilingView, MarketEntry, MoodEntry, TapeView } from '../../lib/api-types';
import { displayStatus, hypeOf, portraitStatus } from '../../lib/company';
import { filingText, foldRepeats, kindOf, TONE_TEXT } from '../../lib/filings';
import { ago, agoSec, compact } from '../../lib/format';
import { NMark } from '../chrome/Drawer';
import { Portrait } from '../ink/Portrait';

function face(
  ticker: string,
  companyId: string,
  byTicker: Readonly<Record<string, MarketEntry>>,
  size: number,
) {
  const e = byTicker[ticker];
  return (
    <Portrait
      seed={companyId}
      hp={e?.hp}
      hype={hypeOf(e?.mult)}
      status={e ? portraitStatus(displayStatus(e.status, null, null)) : 'active'}
      size={size}
      label=""
    />
  );
}

export function Newsroom({
  filings,
  byTicker,
  now,
  onGo,
}: {
  filings: readonly FilingView[];
  byTicker: Readonly<Record<string, MarketEntry>>;
  now: number | null;
  onGo(ticker: string): void;
}) {
  const [all, setAll] = useState(false);
  const items = useMemo(() => foldRepeats(filings), [filings]);
  return (
    <section
      className={`ws-panel ws-panel--flat ws-panel--thin ws-rail-panel rail-news${all ? ' is-all' : ''}`}
      aria-labelledby="news-h"
    >
      <h2 className="ws-cap" id="news-h">
        Newsroom <small>filings, newest first</small>
      </h2>
      {items.length === 0 ? (
        <p className="ws-rail-sub">
          No filings yet. Every position change by a listed trader lands here.
        </p>
      ) : (
        <ol className="ws-news">
          {items.map(({ filing: f, count }) => {
            const k = kindOf(f);
            return (
              <li key={f.id} className="ws-news__item">
                <button
                  className="ws-news__face"
                  type="button"
                  aria-label={`Show ${f.ticker} on the floor`}
                  onClick={() => onGo(f.ticker)}
                >
                  {face(f.ticker, f.companyId, byTicker, 60)}
                </button>
                <div
                  className={`ws-balloon ${k.shout ? '' : 'ws-balloon--tail-left '}${k.balloon}`}
                >
                  <div className="ws-news__meta">
                    <span className="tk">{f.ticker}</span>
                    <span className={`kind ${TONE_TEXT[k.tone]}`}>
                      {k.label}
                      {count > 1 ? ` ×${count}` : ''}
                    </span>
                    {k.nansen && f.provenance.length > 0 ? (
                      <NMark label="Where this filing comes from" provenance={f.provenance} />
                    ) : null}
                    <span className="ago">{now === null ? '' : ago(now - f.at)}</span>
                  </div>
                  <div>{filingText(f)}</div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {items.length > 7 ? (
        <button className="ws-link ws-news-more" type="button" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer filings' : 'Show all filings'}
        </button>
      ) : null}
    </section>
  );
}

const PERSON = (lean: number) => (
  <svg width="9" height="18" viewBox="0 0 9 18" aria-hidden="true">
    <g transform={`rotate(${lean} 4.5 17)`}>
      <circle cx="4.5" cy="3.6" r="2.7" fill="#1a1714" />
      <path d="M1 17 L1.6 9.5 Q4.5 6.8 7.4 9.5 L8 17 Z" fill="#1a1714" />
    </g>
  </svg>
);
const WHALE = (flip: boolean) => (
  <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true" style={{ margin: '0 -1.5px' }}>
    <g transform={flip ? 'translate(12 0) scale(-1 1)' : undefined}>
      <path
        d="M0.5 9 Q1 4.5 6 4.5 Q10 4.5 10.5 8 L12 6 L11.7 10.5 L10 9.6 Q9 13 5 13 Q0.6 13 0.5 9 Z"
        fill="#0078bf"
        stroke="#1a1714"
        strokeWidth=".8"
      />
      <circle cx="3" cy="8.4" r=".7" fill="#1a1714" />
    </g>
  </svg>
);

function Crowd({
  label,
  long,
  short,
  glyph,
}: {
  label: string;
  long: number;
  short: number;
  glyph: 'p' | 'w';
}) {
  const tot = long + short;
  const nl = tot > 0 ? Math.round((10 * long) / tot) : 5;
  const ns = 10 - nl;
  return (
    <div className="ws-crowd" title={`${label}: ${compact(short)} short, ${compact(long)} long`}>
      <span className="ws-crowd__usd ws-crowd__usd--l">{compact(short)}</span>
      <span className="ws-crowd__side ws-crowd__side--short">
        {Array.from({ length: ns }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: identical glyphs in a fixed order
          <Fragment key={`s${i}`}>{glyph === 'p' ? PERSON(-12) : WHALE(true)}</Fragment>
        ))}
      </span>
      <span className="ws-crowd__axis" />
      <span className="ws-crowd__side">
        {Array.from({ length: nl }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: identical glyphs in a fixed order
          <Fragment key={`l${i}`}>{glyph === 'p' ? PERSON(12) : WHALE(false)}</Fragment>
        ))}
      </span>
      <span className="ws-crowd__usd">{compact(long)}</span>
      <span className="ws-sr">
        {label}: {compact(short)} short, {compact(long)} long.
      </span>
    </div>
  );
}

/** Nansen cohort positioning per coin: smart traders and whales drawn as two crowds leaning. */
export function StreetMood({ mood }: { mood: readonly MoodEntry[] }) {
  return (
    <section
      className="ws-panel ws-panel--flat ws-panel--thin ws-rail-panel rail-mood"
      aria-labelledby="mood-h"
    >
      <h2 className="ws-cap" id="mood-h">
        Street mood <NMark label="Where street mood comes from" />
      </h2>
      <p className="ws-rail-sub">
        How Nansen's smart traders and whales are positioned on the coins our traders hold.
      </p>
      {mood.length === 0 ? (
        <p className="ws-rail-sub">
          No cohort data yet. The engine reads it every 15 minutes while someone is watching (LIVE
          only).
        </p>
      ) : (
        <div className="ws-mood">
          <div className="ws-mood__legend" aria-hidden="true">
            <span>Short</span>
            <span>{PERSON(0)} smart traders</span>
            <span>{WHALE(false)} whales</span>
            <span>Long</span>
          </div>
          {mood.map((m) => {
            const tot = m.smartLongs + m.smartShorts;
            const s = tot > 0 ? m.smartLongs / tot : 0.5;
            const lean = s > 0.6 ? 'leans long' : s < 0.4 ? 'leans short' : 'split';
            return (
              <div key={m.coin} className="ws-mood__coin">
                <div className="ws-mood__name">
                  {m.coin}
                  <small>{lean}</small>
                </div>
                <div className="ws-mood__rows">
                  <Crowd
                    label={`Smart traders on ${m.coin}`}
                    long={m.smartLongs}
                    short={m.smartShorts}
                    glyph="p"
                  />
                  <Crowd
                    label={`Whales on ${m.coin}`}
                    long={m.whaleLongs}
                    short={m.whaleShorts}
                    glyph="w"
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

const SIDE_WORD = { BUY: 'Buy', SELL: 'Sell', SHORT: 'Short', COVER: 'Cover' } as const;

export function Tape({
  tape,
  now,
  you,
}: {
  tape: readonly TapeView[];
  now: number | null;
  you: string | null;
}) {
  return (
    <section
      className="ws-panel ws-panel--flat ws-panel--thin ws-rail-panel rail-tape"
      aria-labelledby="tape-h"
    >
      <h2 className="ws-cap" id="tape-h">
        Tape <small>players' trades</small>
      </h2>
      {tape.length === 0 ? (
        <p className="ws-rail-sub">Waiting for the first trade on the floor.</p>
      ) : (
        <ol className="ws-tape" aria-label="Latest trades by players, bots and agents">
          {tape.slice(0, 13).map((t) => {
            const mine = you !== null && t.handle === you;
            return (
              <li
                key={`${t.at}-${t.handle}-${t.ticker}-${t.side}-${t.cash}`}
                className={`ws-tape__row${mine ? ' is-you' : ''}`}
              >
                <span className="ws-tape__ago">{now === null ? '' : agoSec(now - t.at)}</span>
                <span className="ws-tape__who">
                  {mine ? <span className="ws-badge ws-badge--you">YOU</span> : null}
                  {t.kind === 'bot' ? <span className="ws-badge ws-badge--bot">BOT</span> : null}
                  {t.kind === 'agent' ? (
                    <span className="ws-badge ws-badge--agent">AGENT</span>
                  ) : null}
                  <span>{t.handle}</span>
                </span>
                <span className="ws-tape__side" data-side={t.side}>
                  {SIDE_WORD[t.side]}
                  {t.forced ? ' (auto)' : ''}
                </span>
                <span className="ws-tape__tk">{t.ticker}</span>
                <span className="ws-tape__usd">{compact(t.cash)}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
