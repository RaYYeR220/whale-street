/**
 * Number and time formatting. Every formatter treats null, undefined and non-finite values as
 * unknown and prints an em dash: the UI never invents a number it does not have.
 */

export const DASH = '—';

const finite = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n);

export function price(n: number | null | undefined): string {
  if (!finite(n)) return DASH;
  return n >= 1000
    ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : n.toFixed(2);
}

/** Signed percentage of a fraction: 0.117 → "+11.7%", -0.03 → "−3.0%". */
export function pct(f: number | null | undefined, digits = 1): string {
  if (!finite(f)) return DASH;
  const sign = f > 0 ? '+' : f < 0 ? '−' : '';
  return `${sign}${Math.abs(f * 100).toFixed(digits)}%`;
}

/** Unsigned percentage of a fraction: 0.117 → "11.7%". */
export function pctAbs(f: number | null | undefined, digits = 1): string {
  if (!finite(f)) return DASH;
  return `${Math.abs(f * 100).toFixed(digits)}%`;
}

export function usd(n: number | null | undefined): string {
  if (!finite(n)) return DASH;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Signed dollars: "+$12.40" / "−$3.00". */
export function signedUsd(n: number | null | undefined): string {
  if (!finite(n)) return DASH;
  return `${n >= 0 ? '+' : '−'}${usd(Math.abs(n))}`;
}

export function compact(n: number | null | undefined): string {
  if (!finite(n)) return DASH;
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '')}k`;
  return `$${Math.round(n)}`;
}

/** Coin prices: 113,950 / 207.10 / 0.2490. */
export function coinPx(v: number | null | undefined): string {
  if (!finite(v)) return DASH;
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return v >= 1 ? v.toFixed(2) : v.toFixed(4);
}

export function shares(q: number | null | undefined): string {
  if (!finite(q)) return DASH;
  return Number.isInteger(q)
    ? q.toLocaleString('en-US')
    : q.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Short relative age from milliseconds: "now", "4m", "3h", "2d". */
export function ago(ms: number | null | undefined): string {
  if (!finite(ms)) return DASH;
  const min = Math.max(0, ms) / 60_000;
  if (min < 1) return 'now';
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 1440) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}

/** Long relative age: "just now", "4 min ago", "3 h ago", "2 days ago". */
export function agoLong(ms: number | null | undefined): string {
  if (!finite(ms)) return 'at an unknown time';
  const min = Math.max(0, ms) / 60_000;
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.round(min)} min ago`;
  if (min < 1440) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
}

/** Seconds-level age for the tape: "12s", "3m". */
export function agoSec(ms: number | null | undefined): string {
  if (!finite(ms)) return DASH;
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
}

export function mmss(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Season countdown: "4d 12h 07m". */
export function countdown(ms: number | null | undefined): string {
  if (!finite(ms)) return DASH;
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}d ${h}h ${String(m).padStart(2, '0')}m`;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sep 26" in the viewer's time zone. Render only on the client (after mount). */
export function dayLabel(t: number): string {
  const d = new Date(t);
  return `${MON[d.getMonth()]} ${d.getDate()}`;
}

/** "12:43" in the viewer's time zone. Render only on the client (after mount). */
export function hhmm(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "0x3b1e…a7d2". */
export function shortAddress(a: string | null | undefined): string {
  if (!a) return DASH;
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** CSS class for a signed value: pink up, blue down, muted flat or unknown. */
export function upDown(v: number | null | undefined): 'ws-v-up' | 'ws-v-down' | 'ws-v-muted' {
  if (!finite(v)) return 'ws-v-muted';
  return v > 0 ? 'ws-v-up' : v < 0 ? 'ws-v-down' : 'ws-v-muted';
}

export const isFiniteNumber = finite;
