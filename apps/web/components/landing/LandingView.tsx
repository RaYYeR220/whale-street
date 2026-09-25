'use client';

import Link from 'next/link';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import type { CompanyView, IpoView } from '../../lib/api-types';
import { hedgeOffset, verdictChecks } from '../../lib/committee';
import { type DisplayCompany, portraitStatus, toDisplay } from '../../lib/company';
import { engineUrl, mcpUrlFor, repoUrl } from '../../lib/config';
import { coinPx, compact, pct, price, shortAddress, upDown } from '../../lib/format';
import { describe, expression } from '../../lib/portrait';
import { allowSfx, inViewport } from '../../lib/sfx';
import { Banners } from '../chrome/Banners';
import { ModeBadge } from '../chrome/ModeBadge';
import { Crack } from '../floor/CompanyPanel';
import { Hanko } from '../ink/Hanko';
import { Hp } from '../ink/Hp';
import { useReducedMotion } from '../ink/motion';
import { Portrait } from '../ink/Portrait';
import { Price } from '../ink/Price';
import { useSfx } from '../ink/Sfx';
import { Spark } from '../ink/Spark';
import { Stamp } from '../ink/Stamp';
import {
  useChannels,
  useCompanyViews,
  useEngine,
  useEngineNow,
  useHourHistory,
} from '../providers/engine';

const STORY_SEED = 'story-vivid-python';

function series(n: number, from: number, to: number, wobble: number, seed0: number): number[] {
  let s = seed0;
  const r = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647 - 0.5;
  };
  return Array.from(
    { length: n },
    (_, i) => +(from + (to - from) * (i / (n - 1)) + r() * wobble).toFixed(2),
  );
}

/** A check stamp; `null` is a check the committee could not answer (never shown as a fail). */
function Mark({ ok }: { ok: boolean | null }) {
  return (
    <span className="ws-stamp" data-tone={ok === null ? undefined : ok ? 'blue' : 'red'}>
      <span className="ws-stamp__t">{ok === null ? '?' : ok ? 'PASS' : 'FAIL'}</span>
    </span>
  );
}

/**
 * Applicant, linked wallet and the edge between them. Null addresses draw the labelled example
 * (placeholder faces and addresses); real ones come from the verdict's hedge link.
 */
function HedgeGraph({
  applicant,
  applicantSlip,
  linked,
  linkedSlip,
  edge,
}: {
  applicant: string | null;
  applicantSlip: ['LONG' | 'SHORT', string];
  linked: string | null;
  linkedSlip: ['LONG' | 'SHORT', string];
  edge: string;
}) {
  return (
    <div className="lp-graph">
      <div className="lp-node">
        <span className="lp-node__who">Applicant</span>
        <Portrait
          className="lp-node__face lp-face"
          seed={applicant ?? 'example-applicant'}
          hp={0.8}
          size={164}
          label="Applicant"
        />
        <span className="lp-node__addr">{applicant ? shortAddress(applicant) : '0x7a3f…c91e'}</span>
        <span className={`lp-slip lp-slip--${applicantSlip[0].toLowerCase()}`}>
          {applicantSlip.join(' ')}
        </span>
      </div>
      <div className="lp-edge">
        <svg viewBox="0 0 200 30" preserveAspectRatio="none" aria-hidden="true">
          <path
            d="M4 15 L196 15"
            stroke="#1a1714"
            strokeWidth="3"
            strokeDasharray="9 7"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d="M4 15 l12 -8 M4 15 l12 8 M196 15 l-12 -8 M196 15 l-12 8"
            stroke="#1a1714"
            strokeWidth="3"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            fill="none"
          />
        </svg>
        <span className="lp-edge__label">{edge}</span>
      </div>
      <div className="lp-node">
        <span className="lp-node__who">Linked wallet</span>
        <Portrait
          className="lp-node__face lp-face"
          seed={linked ?? 'example-linked'}
          hp={0.8}
          size={164}
          label="Linked wallet"
        />
        <span className="lp-node__addr">{linked ? shortAddress(linked) : '0x19c2…04ab'}</span>
        <span className={`lp-slip lp-slip--${linkedSlip[0].toLowerCase()}`}>
          {linkedSlip.join(' ')}
        </span>
      </div>
    </div>
  );
}

function SidePanel({ c, rot }: { c: DisplayCompany; rot: number }) {
  const expr = expression(c.hp, portraitStatus(c.display));
  return (
    <article
      className={`ws-panel ws-co ws-co--m is-${c.display === 'delisted' ? 'bankrupt' : c.display}${expr === 'meltdown' ? ' is-meltdown' : ''}`}
      style={{ ['--rot' as string]: `${rot}deg` }}
      aria-labelledby={`tk-${c.ticker}`}
    >
      <div className="ws-co__art">
        <div data-face="">
          <Portrait
            seed={c.id}
            hp={c.hp}
            trend={c.navChg1h}
            hype={c.hype}
            status={portraitStatus(c.display)}
            size={92}
          />
        </div>
        <Stamp rating={c.rating} />
      </div>
      <div className="ws-co__head">
        <div className="ws-co__id">
          <Link className="ws-co__tk" id={`tk-${c.ticker}`} href={`/c/${c.ticker}`}>
            {c.ticker}
            <span className="ws-sr">, {c.name}</span>
          </Link>
          <span className="ws-co__name">{c.name}</span>
        </div>
      </div>
      <div className="ws-co__px">
        <Price value={c.price} />
        <span className={`ws-co__chg ${upDown(c.priceChg1h)}`}>{pct(c.priceChg1h)} 1h</span>
      </div>
      <div className="ws-co__kv">
        <span>
          NAV <b className="ws-v-nav">{price(c.nav)}</b>
        </span>
        <span>
          Hype <b className={(c.hype ?? 0) >= 0 ? 'ws-v-up' : 'ws-v-down'}>{pct(c.hype)}</b>
        </span>
      </div>
      <div className="ws-co__spark">
        <Spark
          nav={c.spark.nav}
          price={c.spark.price}
          label={`${c.ticker} NAV and price, last hour`}
        />
      </div>
      <div className="ws-co__hp">
        <Hp hp={c.hp} />
      </div>
      <div className="ws-co__pos">
        {c.headline ? (
          <>
            <b>{c.headline.text}</b>
            <span>{compact(c.headline.usd)}</span>
            {c.headline.liq !== null ? (
              <span className="ws-co__liq">liq {coinPx(c.headline.liq)}</span>
            ) : null}
          </>
        ) : (
          'No open positions'
        )}
      </div>
    </article>
  );
}

function FocusLines({ target }: { target: RefObject<HTMLDivElement | null> }) {
  const ref = useRef<SVGSVGElement>(null);
  const [lines, setLines] = useState<{
    vb: string;
    items: Array<{
      k: number;
      x1: string;
      y1: string;
      x2: string;
      y2: string;
      w: string;
      o: string;
    }>;
  } | null>(null);
  useEffect(() => {
    const draw = () => {
      const svg = ref.current;
      const art = target.current;
      const panel = svg?.parentElement;
      if (!svg || !art || !panel) return;
      const pr = panel.getBoundingClientRect();
      const ar = art.getBoundingClientRect();
      if (!pr.width || !ar.width) return;
      const cx = ar.left - pr.left + ar.width * 0.5;
      const cy = ar.top - pr.top + ar.width * 0.4;
      const R = Math.hypot(pr.width, pr.height);
      let seed = 7;
      const rnd = () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647;
      };
      const items = Array.from({ length: 92 }, (_, i) => {
        const a = (i / 92) * Math.PI * 2 + (rnd() - 0.5) * 0.05;
        const r0 = ar.width * (0.36 + rnd() * 0.22);
        return {
          k: i,
          w: (0.6 + rnd() * 2.2).toFixed(2),
          o: (0.16 + rnd() * 0.2).toFixed(2),
          x1: (cx + Math.cos(a) * r0).toFixed(1),
          y1: (cy + Math.sin(a) * r0).toFixed(1),
          x2: (cx + Math.cos(a) * R).toFixed(1),
          y2: (cy + Math.sin(a) * R).toFixed(1),
        };
      });
      setLines({ vb: `0 0 ${pr.width.toFixed(0)} ${pr.height.toFixed(0)}`, items });
    };
    draw();
    const ro = new ResizeObserver(draw);
    if (ref.current?.parentElement) ro.observe(ref.current.parentElement);
    void document.fonts?.ready.then(draw);
    return () => ro.disconnect();
  }, [target]);
  return (
    <svg
      ref={ref}
      className="lp-hero__focus"
      aria-hidden="true"
      focusable="false"
      viewBox={lines?.vb}
    >
      {lines?.items.map((l) => (
        <line key={l.k} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} strokeWidth={l.w} opacity={l.o} />
      ))}
    </svg>
  );
}

export function LandingView({
  initialCompanies,
  denied,
}: {
  initialCompanies: CompanyView[];
  denied: IpoView | null;
}) {
  useChannels(['market', 'status', 'leaderboard']);
  const views = useCompanyViews(initialCompanies);
  const market = useEngine((s) => s.market);
  const seriesAll = useEngine((s) => s.series);
  const rows = useEngine((s) => s.leaderboard);
  const now = useEngineNow();
  const reduce = useReducedMotion();
  const artRef = useRef<HTMLDivElement>(null);
  const heroPanel = useRef<HTMLElement>(null);
  const { node: sfx, fire } = useSfx();
  const [copied, setCopied] = useState('Copy');
  const [stamped, setStamped] = useState(false);
  const denyRef = useRef<HTMLElement>(null);
  const mcp = mcpUrlFor(engineUrl());
  const repo = repoUrl();

  const companies = useMemo(() => {
    const tickers = new Set<string>([
      ...Object.keys(views),
      ...(market?.companies ?? []).map((e) => e.ticker),
    ]);
    return [...tickers]
      .map((t) => toDisplay(market?.byTicker[t], views[t], seriesAll[t], now))
      .filter(
        (c): c is DisplayCompany => c !== null && (c.display === 'active' || c.display === 'ipo'),
      );
  }, [views, market, seriesAll, now]);

  useHourHistory(companies.map((c) => c.ticker));

  const hero = useMemo(
    () =>
      [...companies].sort((a, b) => Math.abs(b.priceChg1h ?? 0) - Math.abs(a.priceChg1h ?? 0))[0] ??
      null,
    [companies],
  );
  const side = useMemo(() => {
    const rest = companies.filter((c) => c !== hero);
    const by = (lo: number, hi: number) =>
      rest.find((c) => c.hp !== null && c.hp >= lo && c.hp < hi);
    const picks = [by(0.6, 2), by(0.15, 0.6), by(-1, 0.15)].filter((c): c is DisplayCompany => !!c);
    for (const c of rest) if (picks.length < 3 && !picks.includes(c)) picks.push(c);
    return picks.slice(0, 3);
  }, [companies, hero]);

  const heroPrice = useRef<number | null>(null);
  useEffect(() => {
    const old = heroPrice.current;
    heroPrice.current = hero?.price ?? null;
    if (!hero || old === null || hero.price === null || old <= 0) return;
    const move = hero.price / old - 1;
    if (Math.abs(move) > 0.011 && inViewport(heroPanel.current) && allowSfx(2_600))
      fire({
        text: move > 0 ? 'ZAWA ZAWA' : 'ZAWA…',
        kana: 'ざわ… ざわ…',
        tone: move > 0 ? 'pink' : 'blue',
        x: '58%',
        y: '16%',
      });
  }, [hero, fire]);

  useEffect(() => {
    const el = denyRef.current;
    if (!el || stamped) return;
    if (reduce) {
      setStamped(true);
      return;
    }
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          io.disconnect();
          setTimeout(() => setStamped(true), 350);
        }
      },
      { threshold: 0.55 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduce, stamped]);

  const nav2 = series(24, 100, 101.2, 0.5, 11)
    .slice(0, 14)
    .concat(series(10, 112.4, 113.2, 0.4, 5));
  const nav3 = series(24, 113.2, 113.2, 0.7, 3);
  const px3 = nav3.map(
    (v, i) => +(v * (1 + 0.24 * (i / 23) ** 1.3) + ((i % 3) - 1) * 0.6).toFixed(2),
  );
  px3[0] = nav3[0] as number;
  px3[23] = 140.37;
  nav3[23] = 113.2;
  const nav4 = series(24, 113, 96, 1.2, 9).map((v, i) =>
    i < 15 ? v : i < 20 ? +(v * (1 - (i - 14) / 6)).toFixed(2) : 0,
  );
  const px4 = nav4.map((v, i) =>
    i < 15 ? +(v * 1.18).toFixed(2) : i < 20 ? +(v * 1.1).toFixed(2) : 0,
  );
  const frames = [
    {
      h: 'Nansen profiles a real Hyperliquid trader',
      p: 'Someone nominates a wallet. Nansen returns its whole trading history, the committee approves it, and it lists as a company at a NAV of 100.',
      state: { hp: 0.9, trend: 0, hype: 0, status: 'active' as const },
      vis: (
        <figure className="lp-dossier lp-vis" aria-label="Nansen dossier, example">
          <div className="lp-dossier__row">
            <span>Wallet</span>
            <b>0x0c61…2bb9</b>
          </div>
          <div className="lp-dossier__row">
            <span>Style</span>
            <b>Momentum trader</b>
          </div>
          <div className="lp-dossier__row">
            <span>History</span>
            <b>88 days, 164 trades</b>
          </div>
          <div className="lp-dossier__row">
            <span>Equity</span>
            <b>$310,000</b>
          </div>
          <div className="lp-dossier__row">
            <span>Lists at</span>
            <b className="ws-v-nav">NAV 100.00</b>
          </div>
        </figure>
      ),
    },
    {
      h: 'Their real P&L moves the NAV',
      p: 'Say they close an ETH long for +$41k on $310k of equity. NAV rises by the same 13.2%, from 100.00 to 113.20. Nobody votes on it.',
      state: { hp: 0.72, trend: 0.04, hype: 0, status: 'active' as const },
      vis: (
        <div className="lp-vis">
          <Spark nav={nav2} price={nav2.map(() => null)} label="NAV rising from 100 to 113.20" />
          <p className="lp-eq">
            <span>NAV</span>
            <b>100.00</b>
            <span className="op">+ 13.2% =</span>
            <b className="ws-v-nav">113.20</b>
          </p>
        </div>
      ),
    },
    {
      h: 'The crowd’s buying adds hype on top',
      p: 'Players pile in and bid the shares up to 140.37 while NAV stays at 113.20. The 24% gap is hype. It moves the price, never the NAV, and it fades.',
      state: { hp: 0.44, trend: 0.01, hype: 0.24, status: 'active' as const },
      vis: (
        <div className="lp-vis">
          <Spark nav={nav3} price={px3} label="Price pulling away above a flat NAV" />
          <p className="lp-eq">
            <span>Price</span>
            <b>140.37</b>
            <span className="op">=</span>
            <span>NAV</span>
            <b className="ws-v-nav">113.20</b>
            <span className="op">+</span>
            <span>hype</span>
            <b className="ws-v-up">24%</b>
          </p>
        </div>
      ),
    },
    {
      h: 'Liquidation means bankruptcy',
      p: 'They go 25x long and the market turns. The position is liquidated, the company is delisted, and holders are paid what the NAV is worth then: next to nothing.',
      state: { hp: 0, trend: 0, hype: 0, status: 'bankrupt' as const },
      vis: (
        <div className="lp-vis">
          <Spark nav={nav4} price={px4} label="NAV and price collapsing" />
          <p className="lp-eq">
            <span>Share price</span>
            <b className="ws-v-red">≈ 0</b>
            <span className="op">after</span>
            <b>140.37</b>
          </p>
        </div>
      ),
    },
  ];

  const deniedChecks = denied ? verdictChecks(denied) : null;
  const link = denied?.verdict?.hedgeLinks[0] ?? null;
  const offset = hedgeOffset(deniedChecks?.find((c) => c.id === 'HIDDEN_HEDGE')?.detail);
  const top6 = (rows ?? []).slice(0, 6);
  const race = (k: 'agent' | 'bot' | 'human') => {
    const vs = (rows ?? [])
      .filter((r) => r.kind === k && r.netWorth !== null)
      .map((r) => (r.netWorth as number) / 10_000 - 1);
    return { n: vs.length, v: vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null };
  };
  const races = { agents: race('agent'), bots: race('bot'), humans: race('human') };
  const maxRace = Math.max(0.0001, ...Object.values(races).map((r) => Math.abs(r.v ?? 0)));

  return (
    <>
      <a className="ws-skip" href="#main">
        Skip to content
      </a>
      <header className="ws-topbar">
        <Link className="ws-brand" href="/" aria-label="Whale Street home">
          <span className="ws-brand__seal" aria-hidden="true" />
          WHALE STREET
        </Link>
        <nav className="ws-nav" aria-label="Main">
          <Link href="/floor">Floor</Link>
          <Link href="/ipo">IPO desk</Link>
          <Link href="/leaderboard">Board</Link>
          <Link href="/agents">Agents</Link>
        </nav>
        <div className="ws-topbar__right">
          <ModeBadge />
          <span className="lp-credit">
            Powered by <b>Nansen API</b>
          </span>
        </div>
      </header>
      {/* The same data-health banners as every app page: this page shows live numbers too. */}
      <Banners />
      <main id="main">
        <section className="lp-hero" aria-labelledby="claim">
          <article
            ref={heroPanel}
            className="ws-panel lp-hero__panel"
            style={{ ['--rot' as string]: '-.35deg' }}
          >
            <FocusLines target={artRef} />
            <div className="lp-hero__copy">
              <div className={`ws-balloon lp-hero__balloon${reduce ? '' : ' is-popping'}`}>
                <h1 className="lp-claim" id="claim">
                  <span>Don’t trade tokens.</span> <span>Trade the traders.</span>
                </h1>
              </div>
              <p className="lp-hero__sub">
                Every listed company is a real Hyperliquid trader. The share price is their real
                P&amp;L, read by <b>Nansen</b>, plus whatever the crowd pays on top.
              </p>
              <Link className="ws-btn lp-hero__cta" href="/floor">
                Enter the floor
              </Link>
            </div>
            <div className="lp-hero__art" ref={artRef}>
              <Portrait
                seed={hero?.id ?? 'whale-street-host'}
                hp={hero?.hp ?? 0.85}
                trend={hero?.navChg1h ?? 0.03}
                hype={hero?.hype ?? 0}
                status={hero ? portraitStatus(hero.display) : 'active'}
                size={520}
                label={
                  hero
                    ? `${hero.name}'s CEO: ${describe({ hp: hero.hp, trend: hero.navChg1h, hype: hero.hype })}`
                    : 'A listed trader, calm'
                }
              />
            </div>
            {hero ? (
              <Link
                className="lp-plate"
                href={`/c/${hero.ticker}`}
                aria-label={`${hero.ticker}, ${hero.name}: share price ${price(hero.price)}, NAV ${price(hero.nav)}, hype ${pct(hero.hype)}. Open the company page.`}
              >
                <span className="ws-co__why ws-co__why--pink">
                  {hero.priceChg1h
                    ? `Top mover, ${pct(hero.priceChg1h)} this hour`
                    : 'On the floor now'}
                </span>
                <span className="lp-plate__tk">{hero.ticker}</span>
                <span
                  className="lp-price-wrap"
                  style={{ position: 'relative', justifySelf: 'end' }}
                >
                  <Price value={hero.price} />
                </span>
                <span className="lp-plate__name">{hero.name}</span>
                <span className={`lp-plate__chg ${upDown(hero.priceChg1h)}`}>
                  {pct(hero.priceChg1h)} 1h
                </span>
                <span className="lp-plate__kv">
                  <span>
                    NAV <b className="ws-v-nav">{price(hero.nav)}</b>
                  </span>
                  <span>
                    Hype{' '}
                    <b className={(hero.hype ?? 0) >= 0 ? 'ws-v-up' : 'ws-v-down'}>
                      {pct(hero.hype)}
                    </b>
                  </span>
                  <span>
                    HP <b>{hero.hp === null ? '—' : `${Math.round(hero.hp * 100)}%`}</b>
                  </span>
                </span>
              </Link>
            ) : null}
            {sfx}
          </article>
          <section className="lp-hero__side" aria-label="Traders on the floor right now">
            {side.map((c, i) => (
              <SidePanel key={c.ticker} c={c} rot={[0.4, -0.5, 0.3][i] ?? 0} />
            ))}
          </section>
        </section>

        <section className="lp-sec lp-how" aria-labelledby="how-h">
          <div className="lp-sec__head">
            <h2 className="lp-h2" id="how-h">
              How a trader becomes a stock
            </h2>
            <p className="lp-lede">
              A worked example in four panels. Every listed company can live through all four.
            </p>
          </div>
          <ol className="lp-strip">
            {frames.map((fr, i) => {
              const bust = i === 3;
              return (
                <li key={fr.h} className={`ws-panel lp-frame${bust ? ' lp-frame--bust' : ''}`}>
                  <span className="lp-frame__n" aria-hidden="true">
                    {i + 1}
                  </span>
                  <div className="lp-frame__art">
                    <Portrait seed={STORY_SEED} {...fr.state} size={176} />
                    {bust ? (
                      <>
                        <Crack
                          paths={[
                            'M0 30 L16 36 L26 52 L40 46 L52 62 L66 56 L78 72 L100 66',
                            'M26 52 L20 70 L28 86 L24 100',
                            'M66 56 L72 36 L68 16 L74 0',
                          ]}
                        />
                        <span className="ws-sfx ws-sfx--red lp-bakoom" aria-hidden="true">
                          <span className="ws-sfx__t">BAKOOM</span>
                        </span>
                      </>
                    ) : null}
                  </div>
                  <div className="lp-frame__txt">
                    <h3>
                      <span className="ws-sr">Step {i + 1}: </span>
                      {fr.h}
                    </h3>
                    <p>{fr.p}</p>
                    {fr.vis}
                  </div>
                  {bust ? <Hanko kanji="倒産" word="BANKRUPT" label="Bankrupt" /> : null}
                </li>
              );
            })}
          </ol>
        </section>

        <section className="lp-sec lp-deny" aria-labelledby="deny-h">
          <div className="lp-deny__text">
            <h2 className="lp-h2" id="deny-h">
              The listing committee says no
            </h2>
            <p className="lp-lede">
              Anyone can nominate a trader. Six committee members check the evidence from Nansen
              first, and one of them looks for the oldest trick there is: a second wallet quietly
              holding the other side of the bet.
            </p>
            <p className="lp-body">
              A trader who is hedged in secret can’t really lose, so their stock would be a lie.
            </p>
            <Link className="ws-link lp-more" href={denied ? `/ipo/${denied.id}` : '/ipo'}>
              {denied ? 'Open this verdict' : 'Watch the committee decide'}
            </Link>
          </div>
          <figure
            ref={denyRef}
            className="ws-panel lp-deny__art"
            style={{ ['--rot' as string]: '.4deg' }}
            aria-labelledby="deny-cap"
          >
            <figcaption className="ws-cap" id="deny-cap">
              {denied ? `Application ${shortAddress(denied.address)}` : 'Example application'}{' '}
              <small>
                {denied ? 'a real verdict from this engine' : 'no denial on this engine yet'}
              </small>
            </figcaption>
            {/* A real denial shows only what the engine recorded; the example is labelled as one. */}
            {denied ? (
              <p className="lp-deny__why">
                <b>{link ? 'Hidden hedge: failed.' : 'Denied.'}</b>
                {denied.reason ? ` ${denied.reason.replace(/^[A-Z_]+: /, '')}` : null}
              </p>
            ) : (
              <p className="lp-deny__why">
                <b>Hidden hedge: failed.</b> Most of this trader’s long was cancelled out by a
                wallet funded from the same source. The limit is 50%.
              </p>
            )}
            {denied && link ? (
              <HedgeGraph
                applicant={denied.address}
                applicantSlip={[link.side === 'LONG' ? 'SHORT' : 'LONG', link.coin]}
                linked={link.address}
                linkedSlip={[link.side, `${link.coin} ${compact(link.notionalUsd)}`]}
                edge="Linked through Nansen’s wallet graph"
              />
            ) : denied ? null : (
              <HedgeGraph
                applicant={null}
                applicantSlip={['LONG', 'BTC']}
                linked={null}
                linkedSlip={['SHORT', 'BTC']}
                edge="Example: linked through Nansen’s wallet graph"
              />
            )}
            {(denied && link && offset !== null) || !denied ? (
              <div className="lp-offset">
                <span>Exposure that cancels out</span>
                {/* biome-ignore lint/a11y/useSemanticElements: a drawn bar; the native <meter> cannot take this design */}
                <span
                  className="lp-offset__bar"
                  role="meter"
                  aria-label="Exposure offset by linked wallets"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round((offset ?? 0.75) * 100)}
                >
                  <i style={{ width: `${Math.round((offset ?? 0.75) * 100)}%` }} />
                  <u />
                </span>
                <b className="ws-v-red">{Math.round((offset ?? 0.75) * 100)}%</b>
              </div>
            ) : null}
            <ol className="lp-checks" aria-label="The six committee checks">
              {deniedChecks
                ? deniedChecks.map((c) => (
                    <li key={c.id}>
                      <Mark
                        ok={
                          c.status === 'PASS' || c.status === 'FLAG'
                            ? true
                            : c.status === 'FAIL'
                              ? false
                              : null
                        }
                      />
                      {c.id
                        .replace(/_/g, ' ')
                        .toLowerCase()
                        .replace(/^./, (x) => x.toUpperCase())}
                    </li>
                  ))
                : [
                    'Track record',
                    'Size',
                    'Human trader',
                    'Hidden hedge',
                    'Concentration',
                    'Uniqueness',
                  ].map((n) => (
                    <li key={n}>
                      <Mark ok={n !== 'Hidden hedge'} />
                      {n}
                    </li>
                  ))}
            </ol>
            <span
              className={`ws-hanko lp-deny__hanko${stamped ? (reduce ? '' : ' is-stamping') : ' is-waiting'}`}
              role="img"
              aria-label="Verdict: denied"
            >
              <span className="ws-hanko__kanji">否決</span>
              <span className="ws-hanko__word">DENIED</span>
            </span>
          </figure>
        </section>

        <section className="lp-sec lp-leash" aria-labelledby="leash-h">
          <figure className="lp-leash__card" aria-labelledby="mirror-cap">
            <figcaption className="lp-ticket__head" id="mirror-cap">
              <Portrait
                className="lp-ticket__face lp-face"
                seed="example-momentum-trader"
                hp={0.58}
                hype={0.26}
                size={80}
                label=""
              />
              <span>
                <b>Mirror with real money, an example</b>
                <span>Copying a trader’s SOL long 10x, entered at 196.40. SOL is 207.20 now.</span>
              </span>
            </figcaption>
            <dl className="lp-ticket__order">
              <div>
                <dt>Your size</dt>
                <dd>$50</dd>
              </div>
              <div>
                <dt>Leverage</dt>
                <dd>5x</dd>
              </div>
              <div>
                <dt>Stop-loss</dt>
                <dd>25% of margin</dd>
              </div>
            </dl>
            <ol className="lp-ticket__checks" aria-label="Order checks">
              {[
                ['Size between $10 and $100', true, '$50'],
                ['Leverage at most 5x, never above the trader’s', true, '5x'],
                ['Stop-loss risks at most 50% of margin', true, '25%'],
                ['Trader HP at least 15%', true, '58%'],
                ['Trader data under 60 seconds old', true, '12 s'],
                ['Entry within 5% of the trader', false, '5.5% worse'],
              ].map(([n, ok, d]) => (
                <li key={n as string} className={ok ? undefined : 'is-fail'}>
                  <Mark ok={ok as boolean} />
                  <span>{n}</span>
                  <span>{d}</span>
                </li>
              ))}
            </ol>
            <div className="lp-refusal">
              <p className="ws-balloon ws-balloon--shout ws-balloon--red" role="note">
                You’d enter 5.5% worse than the trader — that’s how FOMO loses money.
              </p>
              <Hanko kanji="却下" word="REFUSED" label="Order refused" />
            </div>
            <button className="ws-btn lp-ticket__sign" type="button" disabled>
              Sign and send the order
            </button>
          </figure>
          <div className="lp-leash__text">
            <h2 className="lp-h2" id="leash-h">
              Real money, on a leash
            </h2>
            <p className="lp-lede">
              Like a trader enough to follow them for real? Mirror places a small Hyperliquid order
              next to theirs: $10 to $100, at most 5x, always with a stop-loss.
            </p>
            <p className="lp-body">
              Every order is checked before you sign it. If the trader is close to liquidation, if
              the data is stale, or if you are simply late to the trade, it refuses and tells you
              why.
            </p>
          </div>
        </section>

        <section className="lp-sec lp-agents" aria-labelledby="agents-h">
          <div className="lp-agents__text">
            <h2 className="lp-h2" id="agents-h">
              Agents trade here too
            </h2>
            <p className="lp-lede">
              Point any MCP client at the floor. Agents read the same prices, trade the same play
              money and show up on the tape with a blue AGENT badge.
            </p>
            <div className="lp-endpoint">
              <span className="lp-endpoint__k" id="mcp-k">
                MCP endpoint
              </span>
              <code className="lp-endpoint__v">{mcp}</code>
              <button
                className="ws-btn ws-btn--quiet ws-btn--sm"
                type="button"
                aria-describedby="mcp-k"
                onClick={() => {
                  const done = (ok: boolean) => {
                    setCopied(ok ? 'Copied' : 'Select and copy');
                    setTimeout(() => setCopied('Copy'), 1_800);
                  };
                  if (navigator.clipboard)
                    navigator.clipboard.writeText(mcp).then(
                      () => done(true),
                      () => done(false),
                    );
                  else done(false);
                }}
              >
                {copied}
              </button>
            </div>
            <pre className="lp-code">
              <code>
                <span className="c">POST {mcp}</span>
                {'\n{ '}
                <span className="k">"method"</span>: <span className="s">"tools/call"</span>
                {',\n  '}
                <span className="k">"params"</span>: {'{ '}
                <span className="k">"name"</span>: <span className="s">"trade"</span>
                {',\n    '}
                <span className="k">"arguments"</span>: {'{ '}
                <span className="k">"ticker"</span>:{' '}
                <span className="s">"{hero?.ticker ?? 'TICKER'}"</span>
                {',\n      '}
                <span className="k">"side"</span>: <span className="s">"SHORT"</span>,{' '}
                <span className="k">"qty"</span>: 10 {'} } }'}
              </code>
            </pre>
            <Link className="ws-link lp-more" href="/agents">
              Register an agent
            </Link>
          </div>
          <section
            className="ws-panel lp-agents__board"
            style={{ ['--rot' as string]: '-.3deg' }}
            aria-labelledby="mini-h"
          >
            <h3 className="ws-cap" id="mini-h">
              The board <small>this season, top 6</small>
            </h3>
            {top6.length === 0 ? (
              <p className="co-sub">Nobody has traded this season yet.</p>
            ) : (
              <ol className="lp-mini">
                {top6.map((r) => (
                  <li key={r.playerId} className={r.kind !== 'human' ? 'is-bot' : undefined}>
                    <span className="lp-mini__r">{r.rank}</span>
                    <Portrait
                      className="lp-mini__face lp-face"
                      seed={r.handle}
                      hp={0.8}
                      size={50}
                      label=""
                    />
                    <span className="lp-mini__who">
                      <span>{r.handle}</span>
                      {r.kind === 'agent' ? (
                        <span className="ws-badge ws-badge--agent">AGENT</span>
                      ) : null}
                      {r.kind === 'bot' ? (
                        <span className="ws-badge ws-badge--bot">BOT</span>
                      ) : null}
                    </span>
                    <span
                      className={`lp-mini__ret ${upDown(r.netWorth === null ? null : r.netWorth - 10_000)}`}
                    >
                      {pct(r.netWorth === null ? null : r.netWorth / 10_000 - 1)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            <div className="lp-race">
              <p className="lp-race__k">Average return this season, by kind of player</p>
              {(['agents', 'bots', 'humans'] as const).map((k) => (
                <div key={k} className={`lp-race__row lp-race__row--${k}`}>
                  <span>
                    {k.charAt(0).toUpperCase() + k.slice(1)}{' '}
                    <span className="ws-v-muted">({races[k].n})</span>
                  </span>
                  <span className="lp-race__bar">
                    <i
                      style={{
                        width: `${((Math.abs(races[k].v ?? 0) / maxRace) * 100).toFixed(1)}%`,
                      }}
                    />
                  </span>
                  <span className="lp-race__v">{pct(races[k].v)}</span>
                </div>
              ))}
            </div>
          </section>
        </section>
      </main>
      <footer className="lp-foot">
        <div className="lp-foot__nav">
          <p className="lp-foot__nav-t">
            The floor is open. <span>{companies.length} traders listed right now.</span>
          </p>
          <Link className="ws-btn" href="/floor">
            Enter the floor
          </Link>
        </div>
        <div className="lp-foot__row">
          <p className="lp-foot__how">
            <b>How NAV works.</b> Every trader lists at a NAV of 100, and each tick NAV moves by the
            change in their real P&amp;L divided by their account equity, read from Nansen and
            Hyperliquid.{' '}
            <Link className="ws-link" href="/floor">
              See the numbers live
            </Link>
          </p>
          <p className="lp-foot__nansen">
            <span className="ws-n" aria-hidden="true">
              N
            </span>{' '}
            Powered by <b>Nansen API</b>
          </p>
          {repo ? (
            <a className="ws-link" href={repo} rel="noopener noreferrer">
              Source on GitHub
            </a>
          ) : null}
        </div>
        <p className="lp-foot__fine">Play money only. Mirror orders are real and capped at $100.</p>
      </footer>
    </>
  );
}
