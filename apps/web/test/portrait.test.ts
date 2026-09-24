import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  catalog,
  describe as describePortrait,
  expression,
  hash,
  type PortraitOptions,
  renderPortrait,
  traits,
} from '../lib/portrait';
import fixture from './fixtures/prototype-ink.json';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('portrait parity with the design reference', () => {
  it('renders the same SVG as the reference portrait renderer for 80 seed/state pairs', () => {
    expect(fixture.portraits).toHaveLength(80);
    for (const p of fixture.portraits) {
      const svg = renderPortrait(p.opts as PortraitOptions);
      expect({ seed: p.opts.seed, length: svg.length, sha: sha(svg) }).toEqual({
        seed: p.opts.seed,
        length: p.length,
        sha: p.sha256,
      });
    }
  });

  it('draws the same traits for the same seeds', () => {
    for (const t of fixture.traits) expect(traits(t.seed)).toEqual(t.traits);
  });
});

describe('portrait determinism and range', () => {
  it('is a pure function of its options', () => {
    const o: PortraitOptions = { seed: '0xabc', hp: 0.4, trend: 0.03, hype: 0.2, size: 120 };
    expect(renderPortrait(o)).toBe(renderPortrait({ ...o }));
    expect(hash('0xabc')).toBe(hash('0xabc'));
  });

  it('produces at least 40 distinct trait combinations over 200 addresses', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const seed = `0x${(i * 2654435761).toString(16).padStart(40, '0')}`;
      seen.add(JSON.stringify(traits(seed)));
    }
    expect(seen.size).toBeGreaterThanOrEqual(40);
  });

  it('only draws traits from the catalog', () => {
    for (let i = 0; i < 100; i++) {
      const t = traits(`seed-${i}`);
      for (const k of Object.keys(catalog) as Array<keyof typeof catalog>)
        expect(catalog[k] as readonly string[]).toContain(t[k]);
    }
  });

  it('maps HP and status to an expression, unknown HP reads as tense', () => {
    expect(expression(0.9)).toBe('calm');
    expect(expression(0.3)).toBe('tense');
    expect(expression(0.2)).toBe('panic');
    expect(expression(0.05)).toBe('meltdown');
    expect(expression(null)).toBe('tense');
    expect(expression(Number.NaN)).toBe('tense');
    expect(expression(0.9, 'bankrupt')).toBe('bankrupt');
    expect(expression(0.9, 'halted')).toBe('halted');
  });

  it('describes the overlays in plain words', () => {
    expect(describePortrait({ hp: 0.9, trend: 0.05, hype: 0.2 })).toBe(
      'CEO calm, confident grin; sparkles: NAV rising this hour; pink speed lines: priced far above NAV',
    );
    expect(describePortrait({ hp: 0, status: 'bankrupt', trend: -0.5 })).toBe(
      'CEO bankrupt, X-eyes, soul leaving',
    );
  });
});

describe('standalone portraits (OG images, data URIs)', () => {
  const svg = renderPortrait({ seed: 'OOH', hp: 0.5, size: 200, standalone: true });

  it('carries its own namespace and filters', () => {
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('<filter id="ws-rough-sm"');
  });

  it('uses plain hex colours only', () => {
    expect(svg).not.toContain('var(');
  });

  it('escapes the label', () => {
    const out = renderPortrait({ seed: 'x', label: 'a "b" <c> & d' });
    expect(out).toContain('aria-label="a &quot;b&quot; &lt;c&gt; &amp; d"');
  });
});
