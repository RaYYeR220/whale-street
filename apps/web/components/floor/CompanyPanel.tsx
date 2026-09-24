'use client';

import { PARAMS } from '@whale-street/core';
import Link from 'next/link';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import type { FilingView } from '../../lib/api-types';
import {
  type DisplayCompany,
  IPO_CAP_USD,
  notional,
  portraitStatus,
  side,
  unrealized,
} from '../../lib/company';
import { filingText, KIND } from '../../lib/filings';
import { ago, coinPx, compact, mmss, pct, price, upDown } from '../../lib/format';
import { expression, hash } from '../../lib/portrait';
import type { PanelSize, Slot, Why } from '../../lib/roster';
import { allowSfx, inViewport } from '../../lib/sfx';
import { NMark } from '../chrome/Drawer';
import { Hanko } from '../ink/Hanko';
import { Hp } from '../ink/Hp';
import { Portrait } from '../ink/Portrait';
import { Price } from '../ink/Price';
import { useSfx } from '../ink/Sfx';
import { Spark } from '../ink/Spark';
import { Stamp } from '../ink/Stamp';

export const ART: Record<PanelSize, number> = { xl: 212, l: 150, m: 92, s: 64 };
export const QUICK_USD = 1_000;
const BIG_MOVE = 0.011;
const CRACK_PATHS = [
  'M0 34 L14 37 L22 50 L37 45 L49 60 L63 55 L74 71 L100 64',
  'M22 50 L18 66 L26 83 L24 100',
  'M49 60 L54 78 L47 100',
  'M63 55 L70 36 L66 18 L72 0',
];

export function Crack({ paths = CRACK_PATHS }: { paths?: readonly string[] }) {
  return (
    <svg className="ws-crack" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {paths.map((d) => (
        <path key={d} vectorEffect="non-scaling-stroke" d={d} />
      ))}
    </svg>
  );
}

/** Fixed small rotation per company, like hand-pasted manga panels (same formula as the design reference). */
export const rotOf = (ticker: string): number => (((hash(ticker) >> 5) % 11) - 5) / 10;

export interface CompanyPanelProps {
  c: DisplayCompany;
  slot: Slot;
  why?: Why;
  lastFiling?: FilingView;
  now: number | null;
  pinged?: boolean;
  onTrade(kind: 'buy' | 'short', c: DisplayCompany): void;
}

function PriceBlock({ c }: { c: DisplayCompany }) {
  if (c.display === 'bankrupt' || c.display === 'delisted')
    return (
      <>
        <span className="ws-price ws-num">{price(c.price)}</span>
        <span className="ws-co__chg ws-v-red">settled at NAV</span>
      </>
    );
  if (c.display === 'halted')
    return (
      <>
        <span className="ws-price ws-num">{price(c.price)}</span>
        <span className="ws-co__chg ws-v-down">last price, halted</span>
      </>
    );
  return (
    <>
      <Price value={c.price} />
      <span className={`ws-co__chg ${upDown(c.priceChg1h)}`}>{pct(c.priceChg1h)} 1h</span>
    </>
  );
}

function PosBlock({
  c,
  size,
  now,
  lastFiling,
}: {
  c: DisplayCompany;
  size: PanelSize;
  now: number | null;
  lastFiling?: FilingView;
}) {
  if (c.display === 'ipo' && c.ipoUntil !== null && now !== null) {
    const left = Math.max(0, c.ipoUntil - now);
    const frac = Math.min(1, left / PARAMS.ipoWindowMs);
    return (
      <div className="ws-co__alloc">
        <div className="ws-co__alloc-row">
          <span>
            IPO window: buy up to <b>{compact(IPO_CAP_USD)}</b> per player
          </span>
          <span className="ws-num">closes in {mmss(left)}</span>
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: a drawn bar; the native <meter> cannot take this design */}
        <div
          className="ws-co__alloc-bar"
          role="meter"
          aria-label="IPO window time left"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(frac * 100)}
        >
          <i style={{ width: `${frac * 100}%` }} />
        </div>
      </div>
    );
  }
  if (c.display === 'halted')
    return (
      <div className="ws-co__halt-note">
        {c.haltReason ? `Halted: ${c.haltReason}.` : 'Halted: no fresh Nansen data.'} Trading
        paused; your shares are safe.
      </div>
    );
  if (c.display === 'bankrupt' || c.display === 'delisted')
    return (
      <div className="ws-co__rip">
        {lastFiling && now !== null
          ? `${filingText(lastFiling)} ${ago(now - lastFiling.at)} ago. `
          : ''}
        Delisted; holders were settled at NAV.
      </div>
    );
  const h = c.headline;
  if (!h) return <div className="ws-co__pos">No open positions</div>;
  return (
    <div className="ws-co__pos">
      <b>{h.text}</b>
      <span>{compact(h.usd)}</span>
      {size !== 's' && h.liq !== null ? (
        <span className="ws-co__liq">liq {coinPx(h.liq)}</span>
      ) : null}
      {c.positions.length > 1 ? (
        <span className="ws-co__more">+{c.positions.length - 1} more</span>
      ) : null}
    </div>
  );
}

function DeskBlock({ c }: { c: DisplayCompany }) {
  const top = [...c.positions].sort((a, b) => (notional(b) ?? 0) - (notional(a) ?? 0)).slice(0, 3);
  if (top.length === 0) return <div className="ws-co__pos">No open positions</div>;
  return (
    <div className="ws-co__desk">
      {top.map((p) => {
        const u = unrealized(p);
        return (
          <div key={p.coin} className="ws-paper-slip" data-side={side(p)}>
            <b>
              {side(p)} {p.coin} {Math.round(p.leverage)}x
            </b>
            <span>
              {compact(notional(p))} at {coinPx(p.entryPx)}
            </span>
            <span>
              {p.liqPx !== null ? `Liq ${coinPx(p.liqPx)}` : 'No liq price'},{' '}
              <span className={upDown(u.usd)}>
                {u.usd === null ? '—' : `${u.usd >= 0 ? '+' : '−'}${compact(Math.abs(u.usd))}`}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** A company as a manga panel: face (expression = risk), price, NAV, hype, HP, headline position. */
export function CompanyPanel({
  c,
  slot,
  why,
  lastFiling,
  now,
  pinged,
  onTrade,
}: CompanyPanelProps) {
  const size = slot.size;
  const ref = useRef<HTMLElement>(null);
  const { node: sfx, fire } = useSfx();
  const [doki, setDoki] = useState(false);
  const prev = useRef(c.price);
  const expr = expression(c.hp, portraitStatus(c.display));

  useEffect(() => {
    const old = prev.current;
    prev.current = c.price;
    if (old === null || c.price === null || old <= 0) return;
    const move = c.price / old - 1;
    if (Math.abs(move) > BIG_MOVE && inViewport(ref.current) && allowSfx(2_600)) {
      const up = move > 0;
      fire({
        text: up ? 'ZAWA ZAWA' : 'ZAWA…',
        kana: 'ざわ… ざわ…',
        tone: up ? 'pink' : 'blue',
        x: '38%',
        y: '18%',
      });
    }
  }, [c.price, fire]);

  useEffect(() => {
    if (expr !== 'meltdown') return;
    const id = setInterval(
      () => {
        if (!inViewport(ref.current) || !allowSfx(2_200)) return;
        setDoki(true);
        fire({
          text: 'DOKI DOKI',
          kana: 'ドキ ドキ',
          tone: 'red',
          small: true,
          x: '45%',
          y: '58%',
          ms: 1_600,
        });
        setTimeout(() => setDoki(false), 1_700);
      },
      5_200 + (hash(c.ticker) % 2_600),
    );
    return () => clearInterval(id);
  }, [expr, c.ticker, fire]);

  const cls = [
    'ws-panel',
    'ws-co',
    `ws-co--${size}`,
    `is-${c.display === 'delisted' ? 'bankrupt' : c.display}`,
  ];
  if (expr === 'meltdown') cls.push('is-meltdown');
  if (pinged) cls.push('is-pinged');
  const big = size === 'xl' || size === 'l';
  const statusText = {
    ipo: 'IPO window open.',
    halted: 'Trading halted: data unavailable.',
    bankrupt: 'Bankrupt and delisted.',
    delisted: 'Bankrupt and delisted.',
    active: '',
  }[c.display];
  const k = lastFiling ? KIND[lastFiling.kind] : null;
  const style = {
    '--rot': `${rotOf(c.ticker)}deg`,
    gridColumn: slot.col,
    gridRow: slot.row,
  } as CSSProperties;
  const tradable = c.display === 'active' || c.display === 'ipo';

  return (
    <article
      ref={ref}
      className={cls.join(' ')}
      id={`co-${c.ticker}`}
      style={style}
      aria-labelledby={`tk-${c.ticker}`}
    >
      {big ? (
        <span className={`ws-co__why${why?.tone ? ` ws-co__why--${why.tone}` : ''}`} hidden={!why}>
          {why?.text}
        </span>
      ) : null}
      <div className="ws-co__art">
        <div data-face="">
          <Portrait
            seed={c.id}
            hp={c.hp}
            trend={c.navChg1h}
            hype={c.hype}
            status={portraitStatus(c.display)}
            size={ART[size]}
          />
        </div>
        {size === 'xl' ? null : <Stamp rating={c.rating} />}
      </div>
      <div className="ws-co__head">
        <div className="ws-co__id">
          <Link className="ws-co__tk" id={`tk-${c.ticker}`} href={`/c/${c.ticker}`}>
            {c.ticker}
            <span className="ws-sr">
              , {c.name}. {statusText}
            </span>
          </Link>
          <span className="ws-co__name">
            {c.name}
            {size === 'xl' && c.style ? `, ${c.style.toLowerCase()}` : ''}
          </span>
        </div>
        {size === 'xl' ? <Stamp rating={c.rating} /> : null}
      </div>
      <div className="ws-co__px">
        <PriceBlock c={c} />
      </div>
      <div className="ws-co__kv">
        {c.display === 'bankrupt' || c.display === 'delisted' ? (
          <span>
            NAV <b className="ws-v-red">{price(c.nav)}</b>
          </span>
        ) : (
          <>
            <span>
              NAV <b className="ws-v-nav">{price(c.nav)}</b>
              <NMark label={`Where ${c.ticker}'s NAV comes from`} ticker={c.ticker} />
            </span>
            <span>
              Hype <b className={(c.hype ?? 0) >= 0 ? 'ws-v-up' : 'ws-v-down'}>{pct(c.hype)}</b>
            </span>
          </>
        )}
      </div>
      <div className="ws-co__spark">
        <Spark
          nav={c.spark.nav}
          price={c.spark.price}
          label={`${c.ticker} NAV and price, last hour`}
        />
      </div>
      <div className="ws-co__hp">
        <Hp hp={c.hp} size={size === 'xl' ? 'lg' : undefined} doki={doki} />
      </div>
      {size === 'xl' && tradable ? (
        <DeskBlock c={c} />
      ) : (
        <PosBlock c={c} size={size} now={now} lastFiling={lastFiling} />
      )}
      {c.display === 'active' ? (
        <div className="ws-co__actions">
          <button className="ws-btn ws-btn--sm" type="button" onClick={() => onTrade('buy', c)}>
            Buy {compact(QUICK_USD)}
          </button>
          <button
            className="ws-btn ws-btn--short ws-btn--sm"
            type="button"
            onClick={() => onTrade('short', c)}
          >
            Short {compact(QUICK_USD)}
          </button>
        </div>
      ) : c.display === 'ipo' ? (
        <div className="ws-co__actions">
          <button className="ws-btn ws-btn--sm" type="button" onClick={() => onTrade('buy', c)}>
            Buy IPO shares
          </button>
        </div>
      ) : c.display === 'halted' ? (
        <div className="ws-co__actions">
          <button className="ws-btn ws-btn--sm" type="button" disabled>
            Trading paused
          </button>
        </div>
      ) : null}
      {lastFiling && k && now !== null ? (
        <div
          className={`ws-co__say ws-balloon ${k.shout ? k.balloon : `ws-balloon--tail-bottom ${k.balloon}`}`}
          role="note"
        >
          <small>Latest filing, {ago(now - lastFiling.at)} ago</small>
          {filingText(lastFiling)}
        </div>
      ) : null}
      {c.display === 'ipo' ? (
        <>
          <span className="ws-sticker ws-sticker--ipo">IPO NOW</span>
          <span
            className="ws-kan is-ringing"
            style={{ left: `${ART[size] * 0.02 + 10}px`, top: `${size === 'xl' ? 118 : 30}px` }}
            aria-hidden="true"
          >
            KAN KAN KAN
          </span>
        </>
      ) : null}
      {c.display === 'halted' ? (
        <div className="ws-hazard" aria-hidden="true">
          <span>HALTED</span>
          <span>HALTED</span>
          <span>HALTED</span>
        </div>
      ) : null}
      {c.display === 'bankrupt' || c.display === 'delisted' ? (
        <>
          <Crack />
          <Hanko kanji="倒産" word="BANKRUPT" label="Bankrupt" />
        </>
      ) : null}
      {sfx}
    </article>
  );
}
