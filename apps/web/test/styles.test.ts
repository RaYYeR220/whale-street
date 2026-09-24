/** The design reference stylesheets, ported into one global stylesheet. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = join(import.meta.dirname, '..');
const STYLES = join(WEB, 'app/styles');
const css = (name: string) => readFileSync(join(STYLES, name), 'utf8');
const ORDER = [
  'ws',
  'chrome',
  'floor',
  'company',
  'ipo',
  'board',
  'agents',
  'landing',
  'embed',
  'profile',
];

describe('global stylesheet', () => {
  it('imports every stylesheet once, shared rules first', () => {
    const layout = readFileSync(join(WEB, 'app/layout.tsx'), 'utf8');
    const imported = [...layout.matchAll(/import '\.\/styles\/([a-z]+)\.css';/g)].map((m) => m[1]);
    expect(imported).toEqual(ORDER);
    expect(readdirSync(STYLES).sort()).toEqual(ORDER.map((n) => `${n}.css`).sort());
  });

  it('loads the two reference typefaces under their exact family names', () => {
    const layout = readFileSync(join(WEB, 'app/layout.tsx'), 'utf8');
    expect(layout).toContain('family=Dela+Gothic+One');
    expect(layout).toContain('family=Zen+Kaku+Gothic+New');
  });

  it('defines the app chrome in chrome.css only', () => {
    for (const name of ORDER.filter((n) => n !== 'chrome'))
      expect(css(`${name}.css`), name).not.toMatch(/^\.ws-skip \{/m);
    expect(css('chrome.css')).toMatch(/^\.ws-skip \{/m);
  });

  it('scopes the company page’s chrome overrides to that page', () => {
    const company = css('company.css');
    expect(company).not.toContain('#mode-badge');
    expect(company).toContain(':root:has(.co-page) .ws-breaking');
    expect(company).not.toMatch(/^ {2}\.ws-breaking \{\s*display: none;/m);
  });

  it('points at the SVG defs component instead of the reference script', () => {
    expect(css('ws.css')).toContain('components/ink/SvgDefs.tsx');
    expect(css('ws.css')).not.toContain('Include portrait.js');
  });

  it('keeps the design tokens of the design reference', () => {
    const ws = css('ws.css');
    for (const token of [
      '--ws-paper: #f3eee2',
      '--ws-ink: #1a1714',
      '--ws-pink: #ff48b0',
      '--ws-blue: #0078bf',
    ])
      expect(ws).toContain(token);
  });

  it('leaves no empty media blocks behind', () => {
    for (const name of ORDER) expect(css(`${name}.css`), name).not.toMatch(/@media[^{]+\{\s*\}/);
  });
});
