/**
 * Repository guards for the web app: no secret can reach the browser bundle and the Mirror agent
 * key stays inside the Mirror modules (test/mirror*.test.ts also check the wire at run time).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(WEB, p), 'utf8');

function walk(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, keep));
    else if (keep(name)) out.push(full);
  }
  return out;
}
const sources = (dir: string): string[] =>
  walk(join(WEB, dir), (n) => /\.(ts|tsx)$/.test(n)).map((f) =>
    relative(WEB, f).replace(/\\/g, '/'),
  );
const app = [...sources('app'), ...sources('components'), ...sources('lib')];

/**
 * Every environment variable a source reads: `process.env.X`, `process.env['X']`, and
 * `<dynamic>` for a computed key or the whole object (destructuring, spreading), which no scan
 * can vouch for.
 */
export function envReads(src: string): string[] {
  const out: string[] = [];
  const re =
    /process\.env(?:\s*\.\s*([A-Za-z_$][\w$]*)|\s*\[\s*(['"`])([^'"`]*)\2\s*\]|\s*(\[)|(?![\w$.[]))/g;
  for (const m of src.matchAll(re)) out.push(m[1] ?? m[3] ?? '<dynamic>');
  return out;
}

describe('no secrets in the browser', () => {
  it('finds every form of environment read', () => {
    expect(
      envReads(
        'a(process.env.NEXT_PUBLIC_A); b(process.env["SECRET_B"]); c(process.env[`C`]); ' +
          "d(process.env[ 'D' ]); e(process.env[key]); const { F } = process.env; g({ ...process.env })",
      ),
    ).toEqual(['NEXT_PUBLIC_A', 'SECRET_B', 'C', 'D', '<dynamic>', '<dynamic>', '<dynamic>']);
  });

  it('reads only NEXT_PUBLIC_* environment variables', () => {
    const reads = app.flatMap((f) => envReads(read(f)).map((name) => `${f}: ${name}`));
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

const BUILD = join(WEB, '.next');
const built = existsSync(join(BUILD, 'static'));

// Runs whenever a production build is present (`pnpm --filter @whale-street/web build`).
describe.runIf(built)('the production build', () => {
  const text = (dir: string) =>
    existsSync(dir) ? walk(dir, (n) => /\.(js|mjs|cjs|json|html|rsc|txt|map)$/.test(n)) : [];

  it('sends the browser no non-public environment read', () => {
    const js = walk(join(BUILD, 'static'), (n) => /\.(js|mjs)$/.test(n));
    expect(js.length).toBeGreaterThan(0);
    const bad = js.flatMap((f) =>
      envReads(readFileSync(f, 'utf8'))
        .filter((name) => !/^NEXT_PUBLIC_[A-Z0-9_]+$/.test(name) && name !== 'NODE_ENV')
        .map((name) => `${relative(BUILD, f)}: ${name}`),
    );
    expect(bad).toEqual([]);
  });

  it('never names the Nansen API key, in browser or server output', () => {
    const files = [...text(join(BUILD, 'static')), ...text(join(BUILD, 'server'))];
    expect(files.length).toBeGreaterThan(0);
    expect(
      files
        .filter((f) => readFileSync(f, 'utf8').includes('NANSEN_API_KEY'))
        .map((f) => relative(BUILD, f)),
    ).toEqual([]);
  });
});
