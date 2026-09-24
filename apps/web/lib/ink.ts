/**
 * Pure drawing helpers behind the ink components (HP meter, paired sparkline, rating stamp).
 * Geometry matches the design reference byte for byte so the shapes read the same.
 */
import type { Rating } from '@whale-street/core';
import { type Expression, expression } from './portrait';

export type HpBand = Exclude<Expression, 'bankrupt' | 'halted'>;

/** Expression band for an HP value, same thresholds as the face. */
export function band(hp: number | null | undefined): HpBand {
  return expression(hp, 'active') as HpBand;
}

export const DROPS: Record<HpBand, number> = { calm: 0, tense: 1, panic: 2, meltdown: 3 };

const BLUE = 'var(--ws-blue,#0078bf)';
const INK = 'var(--ws-ink,#1a1714)';

/** Sweat drops riding the HP bar, one per severity step. */
export function dropsSvg(n: number): string {
  if (!n) return '';
  let s = '';
  for (let i = 0; i < n; i++)
    s += `<path transform="translate(${i * 7} ${i % 2 ? 3 : 0})" d="M3.5 0 Q7 5.5 3.5 9.5 Q0 5.5 3.5 0 Z" fill="${BLUE}" stroke="${INK}" stroke-width="0.8"/>`;
  return `<svg width="${n * 7 + 2}" height="13" viewBox="-0.5 -0.5 ${n * 7 + 2} 13" aria-hidden="true">${s}</svg>`;
}

export interface SparkGeometry {
  /** SVG path data for the pink (price above NAV) and blue (below) gap fills. */
  up: string;
  dn: string;
  navD: string;
  priceD: string;
  /** Last-point dots in percent of the box, or null when a series has no points. */
  navDot: { left: string; top: string } | null;
  priceDot: { left: string; top: string } | null;
}

export const SPARK_W = 100;
export const SPARK_H = 40;

/** NAV (mint) and price (ink) on one shared y-scale; the gap between them is hype. */
export function sparkGeometry(
  nav: ReadonlyArray<number | null>,
  price: ReadonlyArray<number | null>,
): SparkGeometry {
  const n = nav.length;
  const vals = [...nav, ...price].filter((v): v is number => v != null && Number.isFinite(v));
  let lo = vals.length ? Math.min(...vals) : 0;
  let hi = vals.length ? Math.max(...vals) : 1;
  if (hi - lo < 1e-6) {
    hi += 1;
    lo -= 1;
  }
  const pad = (hi - lo) * 0.12;
  lo -= pad;
  hi += pad;
  const W = SPARK_W;
  const H = SPARK_H;
  const X = (i: number) => (n > 1 ? (i / (n - 1)) * W : W);
  const Y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
  const ok = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
  const line = (arr: ReadonlyArray<number | null>) => {
    let d = '';
    let pen = false;
    arr.forEach((v, i) => {
      if (!ok(v)) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${X(i).toFixed(2)} ${Y(v).toFixed(2)} `;
      pen = true;
    });
    return d;
  };
  const q = (x0: number, pa: number, pb: number, x1: number, qa: number, qb: number) =>
    `M${x0.toFixed(2)} ${Y(pa).toFixed(2)}L${x1.toFixed(2)} ${Y(qa).toFixed(2)}L${x1.toFixed(2)} ${Y(qb).toFixed(2)}L${x0.toFixed(2)} ${Y(pb).toFixed(2)}Z`;
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
    if (d0 >= 0 && d1 >= 0) up += q(X(i), a0, b0, X(i + 1), a1, b1);
    else if (d0 <= 0 && d1 <= 0) dn += q(X(i), a0, b0, X(i + 1), a1, b1);
    else {
      const t = d0 / (d0 - d1);
      const xm = X(i) + (X(i + 1) - X(i)) * t;
      const vm = b0 + (b1 - b0) * t;
      const s1 = q(X(i), a0, b0, xm, vm, vm);
      const s2 = q(xm, vm, vm, X(i + 1), a1, b1);
      if (d0 > 0) {
        up += s1;
        dn += s2;
      } else {
        dn += s1;
        up += s2;
      }
    }
  }
  const lastIdx = (arr: ReadonlyArray<number | null>) => {
    for (let i = arr.length - 1; i >= 0; i--) if (ok(arr[i])) return i;
    return -1;
  };
  const dot = (arr: ReadonlyArray<number | null>) => {
    const i = lastIdx(arr);
    const v = arr[i];
    if (i < 0 || !ok(v)) return null;
    return {
      left: `${((X(i) / W) * 100).toFixed(2)}%`,
      top: `${((Y(v) / H) * 100).toFixed(2)}%`,
    };
  };
  return {
    up,
    dn,
    navD: line(nav),
    priceD: line(price),
    navDot: dot(nav),
    priceDot: dot(price),
  };
}

export type StampTone = 'blue' | 'ink' | 'red';

export function stampTone(rating: Rating | string): StampTone {
  return /^A/.test(rating) ? 'blue' : /^C/.test(rating) ? 'red' : 'ink';
}
