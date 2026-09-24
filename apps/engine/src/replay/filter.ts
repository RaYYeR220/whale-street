import { parseSessionLine } from './load';
import { type MoodRecord, redistributable } from './session';

/**
 * Turns raw recorded session lines into a bundle-safe REPLAY file: keeps seed lines, HL feed
 * records, street-mood lines and allowlisted Nansen/HL-info records (with label/name fields
 * scrubbed from their bodies), optionally trimmed to [start, end]. Seed lines survive any window,
 * re-timed into it, so a trimmed bundle still lists the companies that were listed when the
 * recording started; likewise the latest street mood per coin before the window opens it.
 */
export function filterSessionLines(
  lines: readonly string[],
  window?: readonly [number, number],
): string[] {
  const out: string[] = [];
  const openingMood = new Map<string, MoodRecord>();
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    const r = parseSessionLine(line, i + 1);
    if (window && r.k === 'seed') {
      out.push(JSON.stringify({ ...r, t: Math.min(Math.max(r.t, window[0]), window[1]) }));
      return;
    }
    if (window && r.k === 'mood' && r.t < window[0]) {
      const prev = openingMood.get(r.coin);
      if (!prev || prev.t <= r.t) openingMood.set(r.coin, r);
      return;
    }
    if (window && (r.t < window[0] || r.t > window[1])) return;
    const kept = redistributable(r);
    if (kept) out.push(JSON.stringify(kept));
  });
  const start = window?.[0];
  const opening = [...openingMood.values()].map((m) => JSON.stringify({ ...m, t: start ?? m.t }));
  return [...opening, ...out];
}
