'use client';

import { type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { FilingView } from '../../lib/api-types';
import {
  type ChartModel,
  type ChartSeries,
  chartModel,
  indexAt,
  RANGE_LABEL,
  type Range,
  tickLabel,
} from '../../lib/chart';
import { filingText, kindOf } from '../../lib/filings';
import { agoLong, dayLabel, hhmm, pct, price, upDown } from '../../lib/format';
import { FloatingTip } from '../ink/FloatingTip';

const RANGES: Array<{ key: Range; label: string }> = [
  { key: '1h', label: '1H' },
  { key: '24h', label: '24H' },
  { key: '7d', label: '7D' },
  { key: 'ipo', label: 'Since IPO' },
];

function when(t: number, stepMin: number, now: number | null): string {
  const ago = now === null ? null : now - t;
  if (stepMin < 60)
    return ago !== null && ago < 60_000 ? `${hhmm(t)}, now` : `${hhmm(t)}, ${agoLong(ago)}`;
  return ago !== null && ago < 86_400_000 ? `${hhmm(t)} today` : `${dayLabel(t)}, ${hhmm(t)}`;
}

export interface NavChartProps {
  ticker: string;
  series: ChartSeries | null;
  range: Range;
  onRange(r: Range): void;
  filings: readonly FilingView[];
  now: number | null;
  status: 'active' | 'halted' | 'bankrupt';
  listedAt: number | null;
  ipoRangeAvailable: boolean;
  loading: boolean;
  onPickFilings(ids: number[]): void;
}

/** The hero of the company page: NAV (mint) vs share price (ink), the pink gap is hype. */
export function NavChart(p: NavChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [tipAt, setTipAt] = useState<{ x: number; top: number; bottom: number } | null>(null);
  const [cluster, setCluster] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const [live, setLive] = useState('');

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const model: ChartModel | null = useMemo(
    () =>
      p.series && size && size.w > 0
        ? chartModel(p.series, p.filings, size.w, size.h, {
            ipoAt: p.range === 'ipo' ? p.listedAt : null,
          })
        : null,
    [p.series, p.filings, size, p.range, p.listedAt],
  );

  const s = p.series;
  const summary = useMemo(() => {
    if (!s) return '';
    if (p.status === 'bankrupt')
      return 'Bankrupt: trading stopped and holders were settled at NAV. The chart stops here.';
    const fi = s.price.findIndex((v) => v != null);
    let li = -1;
    for (let i = s.price.length - 1; i >= 0; i--)
      if (s.price[i] != null) {
        li = i;
        break;
      }
    const n0 = s.nav[fi] ?? null;
    const n1 = s.nav[li] ?? null;
    const p0 = s.price[fi] ?? null;
    const p1 = s.price[li] ?? null;
    if (fi < 0 || n0 === null || n1 === null || p0 === null || p1 === null)
      return `${RANGE_LABEL[p.range]}: no trustworthy points yet.`;
    return `${RANGE_LABEL[p.range]}: NAV ${pct(n1 / n0 - 1)}, price ${pct(p1 / p0 - 1)}. Hype went from ${pct(p0 / n0 - 1)} to ${pct(p1 / n1 - 1)}.${p.status === 'halted' ? ' No fresh Nansen data: trading is halted.' : ''}`;
  }, [s, p.range, p.status]);

  const describe = (i: number) => {
    if (!s) return { label: '', nv: null, pv: null };
    return {
      label: when(s.t[i] ?? 0, s.stepMin, p.now),
      nv: s.nav[i] ?? null,
      pv: s.price[i] ?? null,
    };
  };

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!model || (e.target as Element).closest('.cp-balloon')) return;
    const r = e.currentTarget.getBoundingClientRect();
    const i = indexAt(model, e.clientX - r.left);
    setHover(i);
    setCluster(null);
    setTipAt({
      x: r.left + model.X(i),
      top: r.top + model.m.t,
      bottom: r.top + model.m.t + model.ih,
    });
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!model) return;
    let i = hover ?? model.n - 1;
    if (e.key === 'ArrowLeft') i -= e.shiftKey ? 10 : 1;
    else if (e.key === 'ArrowRight') i += e.shiftKey ? 10 : 1;
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = model.n - 1;
    else if (e.key === 'Escape') {
      setHover(null);
      setTipAt(null);
      return;
    } else return;
    e.preventDefault();
    i = Math.max(0, Math.min(model.n - 1, i));
    setHover(i);
    const r = e.currentTarget.getBoundingClientRect();
    setTipAt({
      x: r.left + model.X(i),
      top: r.top + model.m.t,
      bottom: r.top + model.m.t + model.ih,
    });
    const d = describe(i);
    setLive(`${d.label}. NAV ${price(d.nv)}, price ${price(d.pv)}.`);
  };

  const hv = hover !== null ? describe(hover) : null;
  const cl = cluster !== null && model ? model.clusters[cluster] : null;
  const rows = useMemo(() => {
    if (!s) return [];
    const n = s.nav.length;
    const k = Math.min(14, n);
    return Array.from({ length: k }, (_, j) =>
      Math.round(((k - 1 - j) / Math.max(1, k - 1)) * (n - 1)),
    );
  }, [s]);

  return (
    <section className="ws-panel ws-panel--flat co-chart" aria-labelledby="chart-h">
      <h2 className="ws-cap" id="chart-h" tabIndex={-1}>
        NAV vs share price <small>the pink gap is hype</small>
      </h2>
      <div className="co-chart__bar">
        <fieldset className="co-range" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r.key}
              className="ws-chip"
              type="button"
              aria-pressed={p.range === r.key}
              disabled={r.key === 'ipo' && !p.ipoRangeAvailable}
              title={
                r.key === 'ipo' && !p.ipoRangeAvailable
                  ? 'Listed more than 7 days ago: the engine keeps 7 days'
                  : undefined
              }
              onClick={() => {
                setHover(null);
                setTipAt(null);
                p.onRange(r.key);
              }}
            >
              {r.label}
            </button>
          ))}
        </fieldset>
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
          <span>
            <i className="co-legend-balloon" aria-hidden="true" />
            Filing
          </span>
        </div>
      </div>
      <p className="co-chart__sum">{summary}</p>
      {/* biome-ignore lint/a11y/useSemanticElements: a chart, not a form group */}
      <div
        ref={box}
        className={`co-plot${p.loading ? ' is-loading' : ''}`}
        role="group"
        aria-roledescription="chart"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the chart is read point by point with the arrow keys
        tabIndex={0}
        aria-label={`${p.ticker} NAV and share price, ${RANGE_LABEL[p.range].toLowerCase()}. ${summary} Use the left and right arrow keys to read points.`}
        onPointerMove={onMove}
        onPointerLeave={() => {
          setHover(null);
          setTipAt(null);
        }}
        onKeyDown={onKey}
        onBlur={() => {
          setHover(null);
          setTipAt(null);
        }}
      >
        {model ? (
          <>
            <svg viewBox={`0 0 ${model.w} ${model.h}`} aria-hidden="true">
              <g className="cp-grid">
                {model.yTicks.map((t) => (
                  <line
                    key={t.v}
                    x1={model.m.l}
                    x2={model.w - model.m.r + 8}
                    y1={t.y.toFixed(1)}
                    y2={t.y.toFixed(1)}
                  />
                ))}
              </g>
              {model.yTicks.map((t) => (
                <text
                  key={`y${t.v}`}
                  className="cp-ytxt"
                  x={model.m.l - 8}
                  y={(t.y + 4).toFixed(1)}
                  textAnchor="end"
                >
                  {tickLabel(t.v)}
                </text>
              ))}
              <line
                className="cp-base"
                x1={model.m.l}
                x2={model.w - model.m.r + 8}
                y1={model.m.t + model.ih}
                y2={model.m.t + model.ih}
              />
              {model.xTicks.map((t) => (
                <text
                  key={`x${t.t}`}
                  className="cp-xtxt"
                  x={t.x.toFixed(1)}
                  y={model.h - 8}
                  textAnchor="middle"
                >
                  {s && s.stepMin * (s.nav.length - 1) >= 2_880 ? dayLabel(t.t) : hhmm(t.t)}
                </text>
              ))}
              {model.halt ? (
                <>
                  <rect
                    className="cp-halt"
                    x={model.halt.x.toFixed(1)}
                    y={model.m.t}
                    width={model.halt.w.toFixed(1)}
                    height={model.ih}
                  />
                  <text
                    className="cp-halt-txt"
                    x={(model.halt.x + 8).toFixed(1)}
                    y={model.m.t + model.ih - 10}
                  >
                    No data
                  </text>
                </>
              ) : null}
              {model.ipoX !== null ? (
                <line
                  className="cp-ipo"
                  x1={model.ipoX}
                  x2={model.ipoX}
                  y1={model.m.t}
                  y2={model.m.t + model.ih}
                />
              ) : null}
              <defs>
                <pattern
                  id="cp-dots-pink"
                  width="5"
                  height="5"
                  patternUnits="userSpaceOnUse"
                  patternTransform="rotate(18)"
                >
                  <circle cx="2.5" cy="2.5" r="1.25" fill="#ff48b0" />
                </pattern>
                <pattern
                  id="cp-dots-blue"
                  width="5"
                  height="5"
                  patternUnits="userSpaceOnUse"
                  patternTransform="rotate(72)"
                >
                  <circle cx="2.5" cy="2.5" r="1.3" fill="#0078bf" />
                </pattern>
              </defs>
              <path className="cp-gap-up" d={model.up} />
              <path className="cp-dots-up" d={model.up} />
              <path className="cp-gap-dn" d={model.dn} />
              <path className="cp-dots-dn" d={model.dn} />
              <path className="cp-price" d={model.priceD} />
              <path className="cp-nav" d={model.navD} />
              {model.clusters.map((c) => {
                const i = Math.max(0, Math.min(model.n - 1, c.i));
                const pv = s?.price[i] ?? model.end?.lp ?? null;
                return pv === null ? null : (
                  <line
                    key={`st${c.x}`}
                    className="cp-stem"
                    x1={c.x.toFixed(1)}
                    x2={c.x.toFixed(1)}
                    y1={model.m.t - 12}
                    y2={model.Y(pv).toFixed(1)}
                  />
                );
              })}
              {model.end ? (
                <>
                  {model.end.bracket ? (
                    <path
                      className={`cp-bracket${model.end.hy < 0 ? ' cp-bracket--dn' : ''}`}
                      d={model.end.bracket}
                    />
                  ) : null}
                  <text className="cp-lbl" x={model.end.lx} y={(model.end.pY - 4).toFixed(1)}>
                    Price
                  </text>
                  <text className="cp-val" x={model.end.lx} y={(model.end.pY + 13).toFixed(1)}>
                    {price(model.end.lp)}
                  </text>
                  <text className="cp-lbl" x={model.end.lx} y={(model.end.nY - 4).toFixed(1)}>
                    NAV
                  </text>
                  <text
                    className="cp-val cp-val--nav"
                    x={model.end.lx}
                    y={(model.end.nY + 13).toFixed(1)}
                  >
                    {price(model.end.ln)}
                  </text>
                  {model.end.showHype ? (
                    <>
                      <text
                        className={`cp-hype${model.end.hy < 0 ? ' cp-hype--dn' : ''}`}
                        x={model.end.lx}
                        y={((model.end.yP + model.end.yN) / 2 + 6).toFixed(1)}
                      >
                        {pct(model.end.hy)}
                      </text>
                      <text
                        className="cp-lbl"
                        x={model.end.lx}
                        y={((model.end.yP + model.end.yN) / 2 + 24).toFixed(1)}
                      >
                        {model.end.hy >= 0 ? 'hype' : 'discount'}
                      </text>
                    </>
                  ) : null}
                  <circle
                    className="cp-dot cp-dot--price"
                    cx={model.end.xe.toFixed(1)}
                    cy={model.end.yP.toFixed(1)}
                    r="5"
                  />
                  <circle
                    className="cp-dot cp-dot--nav"
                    cx={model.end.xe.toFixed(1)}
                    cy={model.end.yN.toFixed(1)}
                    r="5"
                  />
                </>
              ) : null}
              {hover !== null && hv ? (
                <g>
                  <line
                    className="cp-cross"
                    x1={model.X(hover).toFixed(1)}
                    x2={model.X(hover).toFixed(1)}
                    y1={model.m.t - 4}
                    y2={model.m.t + model.ih}
                  />
                  {hv.pv !== null ? (
                    <circle
                      className="cp-dot cp-dot--price"
                      cx={model.X(hover).toFixed(1)}
                      cy={model.Y(hv.pv).toFixed(1)}
                      r="5"
                    />
                  ) : null}
                  {hv.nv !== null ? (
                    <circle
                      className="cp-dot cp-dot--nav"
                      cx={model.X(hover).toFixed(1)}
                      cy={model.Y(hv.nv).toFixed(1)}
                      r="5"
                    />
                  ) : null}
                </g>
              ) : null}
            </svg>
            {model.clusters.map((c, k) => {
              const one = c.items.length === 1;
              const label = c.items
                .map(
                  (f) =>
                    `${kindOf(f).label}, ${p.now === null ? '' : agoLong(p.now - f.at)}: ${filingText(f)}`,
                )
                .join(' ');
              return (
                <button
                  key={`b${c.x}`}
                  className="cp-balloon"
                  type="button"
                  data-tone={c.tone}
                  style={{ left: `${c.x.toFixed(1)}px`, top: `${model.m.t - 34}px` }}
                  aria-label={one ? `Filing. ${label}` : `${c.items.length} filings. ${label}`}
                  onPointerEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setHover(null);
                    setCluster(k);
                    setTipAt({ x: r.left + r.width / 2, top: r.top, bottom: r.bottom });
                  }}
                  onFocus={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setCluster(k);
                    setTipAt({ x: r.left + r.width / 2, top: r.top, bottom: r.bottom });
                  }}
                  onBlur={() => setCluster(null)}
                  onClick={() => p.onPickFilings(c.items.map((f) => f.id))}
                >
                  {c.glyph}
                </button>
              );
            })}
          </>
        ) : null}
        {tipAt && cl ? (
          <FloatingTip x={tipAt.x} top={tipAt.top} bottom={tipAt.bottom}>
            {[...cl.items].reverse().map((f) => (
              <span key={f.id} style={{ display: 'grid', whiteSpace: 'normal', maxWidth: 280 }}>
                <b>
                  {kindOf(f).label}, {p.now === null ? '' : agoLong(p.now - f.at)}
                </b>
                <span>{filingText(f)}</span>
              </span>
            ))}
          </FloatingTip>
        ) : tipAt && hv ? (
          <FloatingTip x={tipAt.x} top={tipAt.top} bottom={tipAt.bottom}>
            <b>{hv.label}</b>
            {hv.nv === null && hv.pv === null ? (
              <span>No data</span>
            ) : (
              <>
                <span>
                  <i className="k k--nav" />
                  NAV {price(hv.nv)}
                </span>
                <span>
                  <i className="k k--price" />
                  Price {price(hv.pv)}
                </span>
                {hv.nv && hv.pv ? (
                  <span className={upDown(hv.pv - hv.nv)}>Hype {pct(hv.pv / hv.nv - 1)}</span>
                ) : null}
              </>
            )}
          </FloatingTip>
        ) : null}
      </div>
      <p className="ws-sr" aria-live="polite">
        {live}
      </p>
      <div className="co-chart__foot">
        <p>Hover or use the arrow keys on the chart to read any point. Balloons are filings.</p>
        <button
          className="ws-link"
          type="button"
          aria-expanded={table}
          aria-controls="chart-table"
          onClick={() => setTable((v) => !v)}
        >
          {table ? 'Hide the numbers' : 'Show the numbers'}
        </button>
      </div>
      <div id="chart-table" className="co-table-wrap" hidden={!table}>
        {table && s ? (
          <table className="co-table">
            <caption className="ws-sr">{p.ticker} NAV, price and hype</caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">NAV</th>
                <th scope="col">Price</th>
                <th scope="col">Hype</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => {
                const nv = s.nav[i] ?? null;
                const pv = s.price[i] ?? null;
                return (
                  <tr key={i}>
                    <td>{when(s.t[i] ?? 0, s.stepMin, p.now)}</td>
                    <td>{price(nv)}</td>
                    <td>{price(pv)}</td>
                    <td>{nv && pv ? pct(pv / nv - 1) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </div>
    </section>
  );
}
