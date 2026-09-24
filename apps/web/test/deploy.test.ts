/** The deploy files say what the deploy notes say. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE_URL, MISSING_ENGINE_URL, resolveEngineUrl } from '../lib/config';

const read = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8');

describe('deploy files', () => {
  it('documents exactly the public variables the app reads', () => {
    const keys = [...read('.env.example').matchAll(/^#?\s?(NEXT_PUBLIC_[A-Z_]+)=/gm)].map(
      (m) => m[1],
    );
    expect(keys).toEqual([
      'NEXT_PUBLIC_ENGINE_URL',
      'NEXT_PUBLIC_SITE_URL',
      'NEXT_PUBLIC_REPO_URL',
    ]);
  });

  it('builds on Vercel as a Next.js app on Node 24', () => {
    expect(JSON.parse(read('vercel.json')).framework).toBe('nextjs');
    expect(JSON.parse(read('package.json')).engines).toEqual({ node: '24.x' });
  });

  it('fails a production build without NEXT_PUBLIC_ENGINE_URL; dev keeps the local engine', () => {
    expect(() => resolveEngineUrl('production', undefined)).toThrow(MISSING_ENGINE_URL);
    expect(() => resolveEngineUrl('production', '  ')).toThrow(/NEXT_PUBLIC_ENGINE_URL is not set/);
    expect(resolveEngineUrl('production', 'https://engine.example.com/')).toBe(
      'https://engine.example.com',
    );
    expect(resolveEngineUrl('development', undefined)).toBe(DEFAULT_ENGINE_URL);
    expect(resolveEngineUrl('test', undefined)).toBe(DEFAULT_ENGINE_URL);
    // The check runs when the config module loads, which every page does during the build.
    expect(read('lib/config.ts')).toMatch(/^engineUrl\(\);$/m);
  });
});
