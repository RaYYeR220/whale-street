'use client';

import { useEffect, useRef } from 'react';
import type { HolderView } from '../../lib/api-types';
import { type DisplayCompany, portraitStatus } from '../../lib/company';
import { explorerAddressUrl } from '../../lib/config';
import { compact, mmss, pct, pctAbs, price, shortAddress, upDown } from '../../lib/format';
import { expression } from '../../lib/portrait';
import { NMark, useDrawer } from '../chrome/Drawer';
import { Crack } from '../floor/CompanyPanel';
import { Hanko } from '../ink/Hanko';
import { Portrait } from '../ink/Portrait';
import { Price } from '../ink/Price';
import { useSfx } from '../ink/Sfx';
import { Stamp } from '../ink/Stamp';

const HEAD_CRACK = [
  'M0 38 L10 40 L18 55 L31 49 L44 63 L58 57 L70 72 L100 66',
  'M18 55 L15 72 L22 100',
  'M58 57 L66 36 L61 14 L67 0',
];

const EXT = (
  <svg className="co-ext" viewBox="0 0 12 12" aria-hidden="true">
    <path
      d="M4.5 2H2v8h8V7.5M7 1.5h3.5V5M10.2 1.8 5.5 6.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** "Why this face": the reading of the portrait in words (the face is never the only signal). */
export function faceReading(c: DisplayCompany): string {
  const e = expression(c.hp, portraitStatus(c.display));
  if (e === 'bankrupt') return 'X-eyes: bankrupt. Trading stopped and holders were settled at NAV.';
  if (e === 'halted')
    return `Asleep: ${c.haltReason ?? 'no fresh Nansen data'}. Trading is paused; your shares are safe.`;
  const word = { calm: 'Calm', tense: 'Tense', panic: 'Panicking', meltdown: 'Meltdown' }[e];
  const bits = [`${word}, ${c.hp === null ? 'HP unknown' : `${Math.round(c.hp * 100)}% HP`}`];
  if ((c.navChg1h ?? 0) > 0.02) bits.push(`sparkles, NAV up ${pctAbs(c.navChg1h)} this hour`);
  if ((c.navChg1h ?? 0) < -0.02) bits.push(`rain cloud, NAV down ${pctAbs(c.navChg1h)} this hour`);
  if ((c.hype ?? 0) > 0.1) bits.push(`pink aura, priced ${pctAbs(c.hype)} over NAV`);
  if ((c.hype ?? 0) < -0.1) bits.push(`blue gloom, priced ${pctAbs(c.hype)} under NAV`);
  return `Why this face: ${bits.join('; ')}.`;
}

export function CompanyHead({
  c,
  holders,
  now,
  provenance,
}: {
  c: DisplayCompany;
  holders: readonly HolderView[];
  now: number | null;
  provenance: readonly string[];
}) {
  const { open } = useDrawer();
  const { node: sfx, fire } = useSfx();
  const bankrupt = c.display === 'bankrupt' || c.display === 'delisted';
  const fired = useRef(false);
  useEffect(() => {
    if (!bankrupt || fired.current) return;
    fired.current = true;
    const id = setTimeout(
      () => fire({ text: 'BAKOOM', kana: 'バコーン', tone: 'red', x: '40%', y: '8%', ms: 1_800 }),
      500,
    );
    return () => clearTimeout(id);
  }, [bankrupt, fire]);
  const float = holders.reduce((s, h) => s + h.longQty, 0);
  const days =
    c.listedAt !== null && now !== null ? Math.floor((now - c.listedAt) / 86_400_000) : null;
  return (
    <section
      className={`ws-panel co-head is-${bankrupt ? 'bankrupt' : c.display}`}
      aria-labelledby="co-tk"
      style={{ ['--rot' as string]: '-.25deg' }}
    >
      <div className="co-head__art" data-face="">
        <Portrait
          seed={c.id}
          hp={c.hp}
          trend={c.navChg1h}
          hype={c.hype}
          status={portraitStatus(c.display)}
          size={164}
        />
      </div>
      <div className="co-head__id">
        <h1 className="co-head__tk" id="co-tk">
          {c.ticker}
        </h1>
        {c.rating ? <Stamp rating={c.rating} /> : <span className="co-tag">Unrated</span>}
        <span className="co-head__name">{c.name}</span>
      </div>
      <div className="co-meta">
        {c.style ? <span className="co-tag">{c.style}</span> : null}
        {c.display === 'active' && days !== null ? (
          <span className="co-tag">
            {days === 0 ? 'Listed today' : `Listed ${days} day${days === 1 ? '' : 's'} ago`}
          </span>
        ) : null}
        {c.display === 'ipo' && c.ipoUntil !== null && now !== null ? (
          <span className="co-tag co-tag--pink">
            IPO window, closes in <span className="ws-num">{mmss(c.ipoUntil - now)}</span>
          </span>
        ) : null}
        {c.display === 'halted' ? (
          <span className="co-tag co-tag--blue">
            Halted{c.haltReason ? `: ${c.haltReason}` : ''}
          </span>
        ) : null}
        {bankrupt ? <span className="co-tag co-tag--red">Bankrupt, delisted</span> : null}
        <a
          className="co-tag"
          href={explorerAddressUrl(c.id)}
          target="_blank"
          rel="noopener noreferrer"
        >
          {shortAddress(c.id)}
          {EXT}
          <span className="ws-sr"> (opens the Hyperliquid explorer)</span>
        </a>
        <button
          className="co-tag co-tag--nansen"
          type="button"
          onClick={() => open({ kind: 'evidence', ticker: c.ticker, provenance })}
        >
          Profiled by Nansen{' '}
          <span className="ws-n" aria-hidden="true">
            N
          </span>
        </button>
      </div>
      <p className="co-read">{faceReading(c)}</p>
      <div className="co-quote">
        {bankrupt ? (
          <>
            <span className="ws-price ws-num">{price(c.price)}</span>
            <span className="co-quote__chg ws-v-red">settled at NAV</span>
          </>
        ) : (
          <>
            <Price value={c.price} />
            {c.display === 'halted' ? (
              <span className="co-quote__chg ws-v-down">last price, halted</span>
            ) : (
              <span className={`co-quote__chg ${upDown(c.priceChg1h)}`}>
                {pct(c.priceChg1h)} in 1h
              </span>
            )}
          </>
        )}
        <span className="co-quote__kv">
          <span>
            NAV <b className={`${bankrupt ? 'ws-v-red' : 'ws-v-nav'} ws-num`}>{price(c.nav)}</b>
            <NMark
              label={`Where ${c.ticker}'s NAV comes from`}
              ticker={c.ticker}
              provenance={provenance}
            />
          </span>
          {bankrupt ? null : (
            <span>
              Hype{' '}
              <b className={`${(c.hype ?? 0) >= 0 ? 'ws-v-up' : 'ws-v-down'} ws-num`}>
                {pct(c.hype)}
              </b>
            </span>
          )}
        </span>
        <span className="co-quote__small">
          {holders.length} holder{holders.length === 1 ? '' : 's'}, market value{' '}
          {c.price === null ? '—' : compact(c.price * float)}
        </span>
      </div>
      {c.display === 'ipo' ? (
        <>
          <span className="ws-sticker ws-sticker--ipo">IPO NOW</span>
          <span className="ws-kan is-ringing" aria-hidden="true">
            KAN KAN KAN
          </span>
        </>
      ) : null}
      {c.display === 'halted' ? (
        <div className="ws-hazard" aria-hidden="true">
          <span>HALTED</span>
          <span>HALTED</span>
        </div>
      ) : null}
      {bankrupt ? (
        <>
          <Crack paths={HEAD_CRACK} />
          <Hanko kanji="倒産" word="BANKRUPT" label="Bankrupt" />
        </>
      ) : null}
      {sfx}
    </section>
  );
}
