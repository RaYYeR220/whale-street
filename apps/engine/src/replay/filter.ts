import { parseSessionLine } from './load';
import { redistributable } from './session';

/**
 * Turns raw recorded session lines into a bundle-safe REPLAY file: keeps seed lines, HL feed
 * records and allowlisted Nansen/HL-info records (with label/name fields scrubbed from their
 * bodies), optionally trimmed to [start, end]. Seed lines survive any window, re-timed into it,
 * so a trimmed bundle still lists the companies that were listed when the recording started.
 */
export function filterSessionLines(
  lines: readonly string[],
  window?: readonly [number, number],
): string[] {
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    const r = parseSessionLine(line, i + 1);
    if (window && r.k === 'seed') {
      out.push(JSON.stringify({ ...r, t: Math.min(Math.max(r.t, window[0]), window[1]) }));
      return;
    }
    if (window && (r.t < window[0] || r.t > window[1])) return;
    const kept = redistributable(r);
    if (kept) out.push(JSON.stringify(kept));
  });
  return out;
}
