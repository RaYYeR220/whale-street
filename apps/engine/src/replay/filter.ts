import { parseSessionLine } from './load';
import { REPLAY_ALLOWED_PATHS } from './session';

/**
 * Nansen label / entity-name fields (`address_label`, `counterparty_address_label`,
 * `first_funder_name`, …): not redistributable, and the engine never computes anything from them.
 */
const LABEL_KEY = /_(label|name)s?$/i;

/** Deep copy of a response body without any `*_label` / `*_name` key (at any depth). */
export function scrubLabels(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrubLabels);
  if (v === null || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!LABEL_KEY.test(k)) out[k] = scrubLabels(x);
  }
  return out;
}

/**
 * Turns raw recorded session lines into a bundle-safe REPLAY file: keeps seed lines, HL feed
 * records and allowlisted Nansen/HL-info records (with label/name fields scrubbed from their
 * bodies), optionally trimmed to [start, end].
 */
export function filterSessionLines(
  lines: readonly string[],
  window?: readonly [number, number],
): string[] {
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    const r = parseSessionLine(line, i + 1);
    if (window && (r.t < window[0] || r.t > window[1])) return;
    if (r.k === 'nansen') {
      if (!REPLAY_ALLOWED_PATHS.has(r.path)) return;
      out.push(JSON.stringify({ ...r, body: scrubLabels(r.body) }));
      return;
    }
    out.push(JSON.stringify(r));
  });
  return out;
}
