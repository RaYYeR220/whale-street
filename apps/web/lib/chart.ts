/**
 * Geometry of the company chart (NAV vs share price, hype gap, filing balloons), ported from the
 * design reference. Pure: the component measures its box and renders what this returns.
 */
import type { FilingView } from './api-types';
import { kindOf, type Tone } from './filings';
import { MINUTE_MS, type Series } from './store';

export type Range = '1h' | '24h' | '7d' | 'ipo';
export const RANGE_LABEL: Record<Range, string> = {
  '1h': 'Past hour',
  '24h': 'Past 24 hours',
  '7d': 'Past 7 days',
  ipo: 'Since the IPO',
};
/** The engine keeps at most 7 days of history per query. */
export const MAX_HISTORY_MIN = 10_080;

export interface ChartSeries {
  t: number[];
  nav: Array<number | null>;
  price: Array<number | null>;
  stepMin: number;
}

export function rangeMinutes(range: Range, listedAt: number | null, now: number): number {
  if (range === '1h') return 60;
  if (range === '24h') return 1_440;
  if (range === '7d') return MAX_HISTORY_MIN;
  const since = listedAt === null ? MAX_HISTORY_MIN : Math.ceil((now - listedAt) / MINUTE_MS) + 1;
  return Math.max(10, Math.min(MAX_HISTORY_MIN, since));
}

export function stepFor(minutes: number): number {
  if (minutes <= 60) return 1;
  if (minutes <= 1_440) return 15;
  return Math.max(1, Math.ceil(minutes / 240));
}

/** Re-buckets a minute series onto a fixed grid ending at `endAt` (last value in each bucket wins). */
export function bucketSeries(s: Series | undefined, endAt: number, minutes: number): ChartSeries {
  const stepMin = stepFor(minutes);
  const n = Math.max(2, Math.ceil(minutes / stepMin));
  const stepMs = stepMin * MINUTE_MS;
  const end = Math.floor(endAt / MINUTE_MS) * MINUTE_MS;
  const start = end - (n - 1) * stepMs;
  const t = Array.from({ length: n }, (_, i) => start + i * stepMs);
  const nav: Array<number | null> = new Array(n).fill(null);
  const price: Array<number | null> = new Array(n).fill(null);
  if (s) {
    for (let i = 0; i < s.t.length; i++) {
      const ti = s.t[i] as number;
      const idx = Math.round((ti - start) / stepMs + 0.4999);
      const slot = Math.min(n - 1, Math.max(0, idx));
      if (ti < start - stepMs || ti > end) continue;
      const nv = s.nav[i] ?? null;
      const pv = s.price[i] ?? null;
      if (nv !== null || pv !== null) {
        nav[slot] = nv;
        price[slot] = pv;
      }
    }
  }
  return { t, nav, price, stepMin };
}

export function niceTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const err = step0 / mag;
  const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

export function tickLabel(t: number): string {
  if (t >= 1000) return t.toLocaleString('en-US');
  return t % 1 ? t.toFixed(t < 10 ? 2 : 1) : String(t);
}

export interface Cluster {
  x: number;
  i: number;
  items: FilingView[];
  tone: Tone;
  glyph: string;
}

export interface EndLabels {
  xe: number;
  yP: number;
  yN: number;
  pY: number;
  nY: number;
  lx: number;
  lp: number;
  ln: number;
  hy: number;
  bracket: string | null;
  showHype: boolean;
}

export interface ChartModel {
  w: number;
  h: number;
  m: { l: number; r: number; t: number; b: number };
  iw: number;
  ih: number;
  n: number;
  yTicks: Array<{ v: number; y: number }>;
  xTicks: Array<{ x: number; t: number }>;
  up: string;
  dn: string;
  navD: string;
  priceD: string;
  halt: { x: number; w: number } | null;
  ipoX: number | null;
  clusters: Cluster[];
  end: EndLabels | null;
  X(i: number): number;
  Y(v: number): number;
}

const ok = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

export function chartModel(
  s: ChartSeries,
  filings: readonly FilingView[],
  w: number,
  h: number,
  o: { ipoAt?: number | null } = {},
): ChartModel {
  const { nav, price } = s;
  const n = nav.length;
  const mob = w < 560;
  const m = { l: mob ? 40 : 52, r: mob ? 84 : 132, t: 42, b: 30 };
  const iw = Math.max(1, w - m.l - m.r);
  const ih = Math.max(1, h - m.t - m.b);
  const vals = [...nav, ...price].filter(ok);
  let lo = vals.length ? Math.min(...vals) : 0;
  let hi = vals.length ? Math.max(...vals) : 1;
  if (hi - lo < 1e-6) {
    hi += 1;
    lo -= 1;
  }
  const pad = (hi - lo) * 0.08;
  lo = Math.max(0, lo - pad);
  hi += pad;
  const ticks = niceTicks(lo, hi, mob ? 3 : 4);
  lo = Math.min(lo, ticks[0] ?? lo);
  hi = Math.max(hi, ticks[ticks.length - 1] ?? hi);
  const X = (i: number) => m.l + (n > 1 ? i / (n - 1) : 1) * iw;
  const Y = (v: number) => m.t + (1 - (v - lo) / (hi - lo)) * ih;

  const line = (arr: ReadonlyArray<number | null>) => {
    let d = '';
    let pen = false;
    arr.forEach((v, i) => {
      if (!ok(v)) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const quad = (x0: number, pa: number, pb: number, x1: number, qa: number, qb: number) =>
    `M${x0.toFixed(1)} ${Y(pa).toFixed(1)}L${x1.toFixed(1)} ${Y(qa).toFixed(1)}L${x1.toFixed(1)} ${Y(qb).toFixed(1)}L${x0.toFixed(1)} ${Y(pb).toFixed(1)}Z`;
  let up = '';
  let dn = '';
  for (let i = 0; i < n - 1; i++) {
    const a0 = price[i];
    const a1 = price[i + 1];
    const b0 = nav[i];
    const b1 = nav[i + 1];
    if (!ok(a0) || !ok(a1) || !ok(b0) || !ok(b1)) continue;
    const d0 = a0 - b0;
    const d1 = a1 - b1;
    if (d0 >= 0 && d1 >= 0) up += quad(X(i), a0, b0, X(i + 1), a1, b1);
    else if (d0 <= 0 && d1 <= 0) dn += quad(X(i), a0, b0, X(i + 1), a1, b1);
    else {
      const t = d0 / (d0 - d1);
      const xm = X(i) + (X(i + 1) - X(i)) * t;
      const vm = b0 + (b1 - b0) * t;
      const s1 = quad(X(i), a0, b0, xm, vm, vm);
      const s2 = quad(xm, vm, vm, X(i + 1), a1, b1);
      if (d0 > 0) {
        up += s1;
        dn += s2;
      } else {
        dn += s1;
        up += s2;
      }
    }
  }

  let li = -1;
  for (let i = n - 1; i >= 0; i--)
    if (ok(price[i])) {
      li = i;
      break;
    }

  const t0 = s.t[0] ?? 0;
  const stepMs = s.stepMin * MINUTE_MS;
  const span = (n - 1) * stepMs;
  // x ticks: a round interval that gives at most 5 labels, leaving the right edge to the end labels
  const opts = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 4320, 10080, 14400];
  const ivMin = opts.find((o) => span / MINUTE_MS / o <= 5) ?? 20160;
  const iv = ivMin * MINUTE_MS;
  const xTicks: Array<{ x: number; t: number }> = [];
  for (let t = Math.ceil(t0 / iv) * iv; t <= t0 + span; t += iv) {
    if (t0 + span - t < span * 0.06) continue;
    xTicks.push({ x: X((t - t0) / stepMs), t });
  }

  const fx = filings
    .filter((f) => f.at >= t0 - stepMs / 2 && f.at <= t0 + span + stepMs / 2)
    .map((f) => {
      const idx = (f.at - t0) / stepMs;
      return { f, x: X(idx), i: Math.round(idx) };
    })
    .sort((a, b) => a.x - b.x);
  const clusters: Cluster[] = [];
  for (const o of fx) {
    const c = clusters[clusters.length - 1];
    if (c && o.x - c.x < 30) c.items.push(o.f);
    else clusters.push({ x: o.x, i: o.i, items: [o.f], tone: '', glyph: '' });
  }
  for (const c of clusters) {
    const last = c.items[c.items.length - 1] as FilingView;
    const k = kindOf(last);
    c.tone =
      c.items.length === 1 ? k.tone : c.items.some((f) => kindOf(f).tone === 'red') ? 'red' : '';
    c.glyph = c.items.length === 1 ? k.glyph : String(c.items.length);
  }

  let end: EndLabels | null = null;
  if (li >= 0) {
    const lp = price[li] as number;
    const ln = nav[li];
    if (ok(ln)) {
      const xe = X(li);
      const yP = Y(lp);
      const yN = Y(ln);
      const hy = ln > 0 ? lp / ln - 1 : 0;
      const gapPx = Math.abs(yP - yN);
      let bracket: string | null = null;
      if (gapPx > 14) {
        const bx = xe + 10;
        const a = Math.min(yP, yN) + 3;
        const b = Math.max(yP, yN) - 3;
        const mid = (a + b) / 2;
        bracket = `M${bx - 4} ${a} H${bx} V${mid - 5} L${bx + 5} ${mid} L${bx} ${mid + 5} V${b} H${bx - 4}`;
      }
      let pY = yP;
      let nY = yN;
      const minSep = 36;
      if (Math.abs(pY - nY) < minSep) {
        const c = (pY + nY) / 2;
        const dir = pY <= nY ? -1 : 1;
        pY = c + (dir * minSep) / 2;
        nY = c - (dir * minSep) / 2;
      }
      end = {
        xe,
        yP,
        yN,
        pY,
        nY,
        lx: xe + 22,
        lp,
        ln,
        hy,
        bracket,
        showHype: gapPx >= 84 && ln > 0 && !mob,
      };
    }
  }

  const ipoX =
    o.ipoAt != null && o.ipoAt >= t0 && o.ipoAt <= t0 + span ? X((o.ipoAt - t0) / stepMs) : null;

  return {
    w,
    h,
    m,
    iw,
    ih,
    n,
    yTicks: ticks.map((v) => ({ v, y: Y(v) })),
    xTicks,
    up,
    dn,
    navD: line(nav),
    priceD: line(price),
    halt: li >= 0 && li < n - 1 ? { x: X(li), w: X(n - 1) - X(li) } : null,
    ipoX,
    clusters,
    end,
    X,
    Y,
  };
}

/** Index under a pointer x (px within the chart box). */
export function indexAt(model: ChartModel, px: number): number {
  const i = Math.round(((px - model.m.l) / model.iw) * (model.n - 1));
  return Math.max(0, Math.min(model.n - 1, i));
}
