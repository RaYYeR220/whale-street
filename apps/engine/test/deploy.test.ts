/** The deploy files say what the deploy notes say. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${p}`, import.meta.url)), 'utf8');

/** The `- item` lines of one list under `key:` (indentation-based; enough for render.yaml). */
function yamlList(text: string, key: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `${key}:`);
  if (start < 0) return [];
  const indent = (lines[start] ?? '').search(/\S/);
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (line.search(/\S/) <= indent) break;
    const m = line.match(/^\s*- (.+)$/);
    if (m?.[1]) items.push(m[1].trim());
  }
  return items;
}

/** One `- key: NAME` entry of envVars with its sibling fields. */
function envVar(text: string, name: string): Record<string, string> | null {
  const m = text.match(new RegExp(`^( *)- key: ${name}\\r?\\n((?:\\1  \\w+: .*\\r?\\n?)*)`, 'm'));
  if (!m) return null;
  return Object.fromEntries(
    [...(m[2] ?? '').matchAll(/^\s*(\w+): (.*)$/gm)].map((f) => [f[1], f[2]?.trim()]),
  );
}

describe('engine deploy files (Render)', () => {
  const render = repo('render.yaml');
  const docker = repo('Dockerfile');
  const ignore = repo('.dockerignore');

  it('declares one free Docker web service in Frankfurt that deploys main', () => {
    expect(render.match(/^\s*- type: /gm)).toHaveLength(1);
    expect(render).toMatch(/^ {2}- type: web$/m);
    expect(render).toMatch(/^ {4}name: whale-street-engine$/m);
    expect(render).toMatch(/^ {4}runtime: docker$/m);
    expect(render).toMatch(/^ {4}plan: free$/m);
    expect(render).toMatch(/^ {4}region: frankfurt$/m);
    expect(render).toMatch(/^ {4}branch: main$/m);
    expect(render).toMatch(/^ {4}autoDeployTrigger: commit$/m);
    expect(render).toMatch(/^ {4}dockerfilePath: \.\/Dockerfile$/m);
    expect(render).toMatch(/^ {4}healthCheckPath: \/api\/status$/m);
  });

  it('runs REPLAY behind one proxy hop; the web origin is entered in the dashboard', () => {
    expect(envVar(render, 'MODE')).toEqual({ value: 'replay' });
    expect(envVar(render, 'TRUST_PROXY')).toEqual({ value: '"1"' });
    expect(envVar(render, 'NODE_ENV')).toEqual({ value: 'production' });
    expect(envVar(render, 'CORS_ORIGINS')).toEqual({ sync: 'false' });
  });

  it('keeps every secret out of the file', () => {
    expect(render).not.toMatch(/NANSEN_API_KEY|ENV_FILE|generateValue|RECORD|CREDIT_/);
  });

  it('rebuilds on a change to anything the image is built from, and not on tests', () => {
    const paths = yamlList(render, 'paths');
    const covered = (src: string) =>
      paths.some((p) =>
        p.endsWith('/**') ? src === p.slice(0, -3) || src.startsWith(p.slice(0, -2)) : p === src,
      );
    const sources = [...docker.matchAll(/^COPY (?!--from)(.+)$/gm)].flatMap((m) =>
      (m[1] ?? '').trim().split(/\s+/).slice(0, -1),
    );
    expect(sources.length).toBeGreaterThan(5);
    for (const src of sources.map((s) => s.replace(/^\.\//, '')))
      if (!src.startsWith('apps/web/')) expect(covered(src), src).toBe(true);
    expect(paths).toContain('Dockerfile');
    expect(yamlList(render, 'ignoredPaths')).toEqual(['packages/*/test/**', 'apps/engine/test/**']);
  });

  it('builds on Node 24 with the pinned pnpm and listens on the platform PORT', () => {
    const pinned = JSON.parse(repo('package.json')).packageManager as string;
    expect(docker).toMatch(/^FROM node:24-bookworm-slim AS build$/m);
    expect(docker).toContain(`npm install -g ${pinned}`);
    expect(docker).toContain(
      'pnpm install --frozen-lockfile --prod --filter "@whale-street/engine..."',
    );
    // The image keeps production dependencies only, and runs the sources through tsx.
    expect(JSON.parse(repo('apps/engine/package.json')).dependencies.tsx).toBeDefined();
    expect(docker).toMatch(/^\s*HOST=0\.0\.0\.0\b/m);
    const port = docker.match(/^\s*PORT=(\d+)\b/m)?.[1];
    expect(port).toBe('10000');
    expect(docker).toMatch(new RegExp(`^EXPOSE ${port}$`, 'm'));
    expect(docker).toMatch(/^\s*DATA_DIR=\/tmp\/whale-street\b/m);
    expect(docker).toMatch(/^USER node$/m);
    expect(docker).toContain('CMD ["node", "--import", "tsx", "src/main.ts"]');
  });

  it('ships the replay bundle, never local data, keys or installed modules', () => {
    expect(ignore).toMatch(/^\*\*\/node_modules$/m);
    expect(ignore).toMatch(/^apps\/engine\/data$/m);
    expect(ignore).toMatch(/^\*\*\/\.env$/m);
    expect(ignore).toMatch(/^\*\*\/\.env\.\*$/m);
    expect(ignore).not.toMatch(/replay/);
  });
});

describe('keep-alive workflow', () => {
  const wf = repo('.github/workflows/keepalive.yml');

  it('pings the status endpoint every 5 minutes at the address from a repository variable', () => {
    expect(wf).toMatch(/^\s*- cron: "\*\/5 \* \* \* \*"$/m);
    expect(wf).toMatch(/^\s*workflow_dispatch:$/m);
    expect(wf).toMatch(/^\s*ENGINE_URL: \$\{\{ vars\.ENGINE_URL \}\}$/m);
    expect(wf).toContain('curl -fsS --max-time 60 --retry 2');
    expect(wf).toContain('/api/status');
    expect(wf).not.toMatch(/https?:\/\//);
  });

  it('succeeds with a notice while the variable is unset', () => {
    expect(wf).toMatch(/if \[ -z "\$ENGINE_URL" \]; then\s+echo "::notice::[^"]+"\s+exit 0/);
  });

  it('pings again 60s later only when the first ping was slow (a cold start)', () => {
    expect(wf).toMatch(/elapsed=.*\bdate \+%s\b/);
    expect(wf).toMatch(/if \[ "\$elapsed" -gt 20 \]; then/);
    expect(wf).toMatch(/sleep 60/);
    // Two ping call sites: the required first ping, and the conditional second one.
    expect(wf.match(/\bping\b/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
