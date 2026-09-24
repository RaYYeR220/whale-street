/** The deploy files say what the deploy notes say. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
});
