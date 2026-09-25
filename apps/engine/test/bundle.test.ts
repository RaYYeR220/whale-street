/** The replay session that ships with the repository: a real, redistribution-safe recording. */
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadReplaySession } from '../src/replay/load';
import { REPLAY_ALLOWED_PATHS } from '../src/replay/session';

const file = fileURLToPath(new URL('../replay/session.ndjson', import.meta.url));
const text = readFileSync(file, 'utf8');
const records = text
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l) as { k: string; path?: string; body?: unknown });

function labelKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) labelKeys(x, out);
  else if (v !== null && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      if (/_(label|name)s?$/i.test(k)) out.push(k);
      labelKeys(x, out);
    }
  return out;
}

describe('bundled replay session', () => {
  it('is a recorded session of at least 30 minutes with listed companies', () => {
    const s = loadReplaySession(text);
    expect(s.dropped).toBe(0);
    expect(s.seeds.length).toBeGreaterThanOrEqual(3);
    expect(s.endT - s.startT).toBeGreaterThanOrEqual(30 * 60_000);
    expect(s.recordedAt).not.toBeNull();
  });

  it('holds only redistributable Nansen data: allowlisted paths, no label or name fields', () => {
    const nansen = records.filter((r) => r.k === 'nansen');
    expect(nansen.length).toBeGreaterThan(0);
    for (const r of nansen) expect(REPLAY_ALLOWED_PATHS.has(String(r.path))).toBe(true);
    expect(labelKeys(nansen.map((r) => r.body))).toEqual([]);
  });

  it('carries no wallet signatures or trading payloads and stays small enough to clone quickly', () => {
    expect(text).not.toMatch(/"(signature|eip712|agentAddress|privateKey)"/);
    expect(statSync(file).size).toBeLessThan(25 * 1024 * 1024);
  });
});
