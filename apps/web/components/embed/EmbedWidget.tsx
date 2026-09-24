'use client';

import { useEffect } from 'react';
import type { CompanyView, HistoryPoint, Mode } from '../../lib/api-types';
import { portraitStatus, toDisplay } from '../../lib/company';
import { pct, price, upDown } from '../../lib/format';
import { isDown } from '../../lib/ws-client';
import { Portrait } from '../ink/Portrait';
import { Price } from '../ink/Price';
import { Spark } from '../ink/Spark';
import { useChannels, useEngine, useEngineNow, useEngineRuntime } from '../providers/engine';

/** 320 × 120 live stock widget for iframes: face, price, NAV, hype, sparkline, "on Whale Street". */
export function EmbedWidget({
  view,
  history,
  siteUrl,
  initialMode = null,
}: {
  view: CompanyView;
  history: HistoryPoint[];
  siteUrl: string;
  /** The engine mode from the server-rendered status call, until the socket says otherwise. */
  initialMode?: Mode | null;
}) {
  useChannels(['market']);
  const { store } = useEngineRuntime();
  const entry = useEngine((s) => s.market?.byTicker[view.ticker]);
  const series = useEngine((s) => s.series[view.ticker]);
  const live = useEngine((s) => s.market?.mode ?? s.status?.mode ?? null);
  const mode = live ?? initialMode;
  const connection = useEngine((s) => s.connection);
  const now = useEngineNow();
  useEffect(() => {
    store.seedSeries(view.ticker, history);
  }, [store, view.ticker, history]);
  const c = toDisplay(entry, view, series, now);
  if (!c) return null;
  const dead = c.display === 'bankrupt' || c.display === 'delisted';
  const halted = c.display === 'halted';
  const hp = c.hp === null ? null : Math.round(c.hp * 100);
  const label = `${c.ticker}, ${c.name}, on Whale Street: ${dead ? 'bankrupt' : halted ? 'trading halted' : `share price ${price(c.price)}, NAV ${price(c.nav)}, hype ${pct(c.hype)}`}. ${mode === 'replay' ? ' A recorded session, not live prices.' : ''} Opens the company page.`;
  return (
    <div className="em-body">
      <a
        className={`em is-${c.display}${(c.hype ?? 0) > 0.1 && !dead && !halted ? ' is-hype' : ''}`}
        href={`${siteUrl}/c/${c.ticker}`}
        target="_top"
        aria-label={label}
      >
        <span className="em__art" aria-hidden="true">
          <Portrait
            seed={c.id}
            hp={c.hp}
            trend={c.navChg1h}
            hype={c.hype}
            status={portraitStatus(c.display)}
            size={100}
            label=""
          />
        </span>
        <span className="em__head">
          <span className="em__id">
            <span className="em__tk">{c.ticker}</span>
            <span className="em__name">{c.name}</span>
          </span>
          {dead || halted ? (
            <span className="ws-price ws-num">{price(c.price)}</span>
          ) : (
            <Price value={c.price} />
          )}
        </span>
        <span className="em__kv">
          {dead ? (
            <span>
              NAV <b className="ws-v-red">{price(c.nav)}</b>
            </span>
          ) : (
            <>
              <span>
                NAV <b className="ws-v-nav">{price(c.nav)}</b>
              </span>
              <span>
                Hype <b className={(c.hype ?? 0) >= 0 ? 'ws-v-up' : 'ws-v-down'}>{pct(c.hype)}</b>
              </span>
            </>
          )}
          {dead ? (
            <span className="em__chg ws-v-red">Bankrupt</span>
          ) : halted ? (
            <span className="em__chg ws-v-down">Halted</span>
          ) : (
            <span className={`em__chg ${upDown(c.priceChg1h)}`}>{pct(c.priceChg1h)} 1h</span>
          )}
        </span>
        <span className="em__spark" aria-hidden="true">
          <Spark nav={c.spark.nav} price={c.spark.price} />
        </span>
        <span className="em__foot">
          <span className="em__on">
            <i />
            on <b>Whale Street</b>
            {mode === 'replay' ? (
              <span className="em__mode" title="A recorded session replayed, not live prices">
                REPLAY
              </span>
            ) : null}
          </span>
          <span className={`em__hp${hp !== null && hp < 15 && !dead ? ' is-hot' : ''}`}>
            {isDown(connection)
              ? 'reconnecting'
              : dead
                ? 'delisted'
                : halted
                  ? 'paused'
                  : `HP ${hp === null ? '—' : `${hp}%`}`}
          </span>
        </span>
        <span className="em__src">Powered by Nansen API</span>
      </a>
    </div>
  );
}
