/**
 * Repository guards for the web app: no secret can reach the browser bundle and the Mirror agent
 * key stays inside the Mirror modules.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(WEB, p), 'utf8');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(WEB, dir))) {
    const rel = join(dir, name);
    if (statSync(join(WEB, rel)).isDirectory()) out.push(...sources(rel));
    else if (/\.(ts|tsx)$/.test(name)) out.push(relative(WEB, join(WEB, rel)).replace(/\\/g, '/'));
  }
  return out;
}
const app = [...sources('app'), ...sources('components'), ...sources('lib')];

describe('no secrets in the browser', () => {
  it('reads only NEXT_PUBLIC_* environment variables', () => {
    const reads = app.flatMap((f) =>
      [...read(f).matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => `${f}: ${m[1]}`),
    );
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((r) => !/: NEXT_PUBLIC_[A-Z0-9_]+$/.test(r))).toEqual([]);
  });

  it('never mentions the Nansen API key', () => {
    expect(app.filter((f) => /NANSEN_API_KEY|apiKey/i.test(read(f)))).toEqual([]);
  });

  it('keeps the agent private key inside the Mirror modules', () => {
    const allowed = new Set([
      'components/mirror/MirrorTicket.tsx',
      'lib/mirror/agent.ts',
      'lib/mirror/flow.ts',
      'lib/mirror/keystore.ts',
      'lib/mirror/sign.ts',
    ]);
    const users = app.filter((f) => /privateKey/.test(read(f)));
    expect(users.filter((f) => !allowed.has(f))).toEqual([]);
    expect(read('lib/api.ts')).not.toMatch(/privateKey/);
  });
});
