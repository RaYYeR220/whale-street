import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Hp } from '../components/ink/Hp';
import { compact, pct, price, usd } from '../lib/format';
import { band, DROPS, dropsSvg, sparkGeometry, stampTone } from '../lib/ink';
import fixture from './fixtures/prototype-ink.json';

const attr = (html: string, cls: string) =>
  html.match(new RegExp(`class="${cls}" d="([^"]*)"`))?.[1] ?? null;
const dot = (html: string, kind: string) => {
  const m = html.match(new RegExp(`ws-spark__dot--${kind}" style="left:([^;]+);top:([^"]+)"`));
  return m ? { left: m[1], top: m[2] } : null;
};

describe('sparkline geometry matches the design reference', () => {
  for (const [i, s] of fixture.sparks.entries()) {
    it(`spark ${i}`, () => {
      const g = sparkGeometry(s.input.nav, s.input.price);
      expect(g.up).toBe(attr(s.html, 'ws-spark__gap ws-spark__gap--up'));
      expect(g.dn).toBe(attr(s.html, 'ws-spark__gap ws-spark__gap--down'));
      expect(g.priceD).toBe(attr(s.html, 'ws-spark__price'));
      expect(g.navD).toBe(attr(s.html, 'ws-spark__nav'));
      expect(g.priceDot).toEqual(dot(s.html, 'price'));
      expect(g.navDot).toEqual(dot(s.html, 'nav'));
    });
  }
});

describe('HP meter matches the design reference', () => {
  for (const h of fixture.hps) {
    it(`hp ${h.hp}`, () => {
      expect(band(h.hp)).toBe(h.band);
      const drops = h.html.match(/<span class="ws-hp__drops">(.*?)<\/span><\/span>/)?.[1] ?? '';
      expect(dropsSvg(DROPS[band(h.hp)])).toBe(drops);
      const html = renderToStaticMarkup(<Hp hp={h.hp} />);
      expect(html).toContain(`data-band="${h.band}"`);
      expect(html).toContain(`--hp:${h.hp.toFixed(3)}`);
      expect(html).toContain(`aria-valuenow="${Math.round(h.hp * 100)}"`);
      expect(html).toContain(`<span class="ws-hp__v">${Math.round(h.hp * 100)}%</span>`);
    });
  }

  it('shows unknown HP as unknown, never as a number', () => {
    for (const v of [null, undefined, Number.NaN]) {
      const html = renderToStaticMarkup(<Hp hp={v} />);
      expect(html).toContain('data-band="unknown"');
      expect(html).toContain('role="img"');
      expect(html).toContain('aria-label="Distance to liquidation: unknown"');
      expect(html).toContain('<span class="ws-hp__v">—</span>');
      expect(html).not.toContain('aria-valuenow');
    }
  });
});

describe('number formats match the design reference', () => {
  for (const f of fixture.fmt) {
    it(`formats ${f.n}`, () => {
      expect(price(f.n)).toBe(f.price);
      expect(usd(f.n)).toBe(f.usd);
      expect(compact(f.n)).toBe(f.compact);
    });
  }
  for (const f of fixture.pct) {
    it(`formats ${f.f} as a percentage`, () => {
      expect(pct(f.f)).toBe(f.pct);
      expect(pct(f.f, 2)).toBe(f.pct2);
    });
  }
});

describe('rating stamp tone', () => {
  it('is blue for A grades, red for C grades, ink otherwise', () => {
    expect(stampTone('AAA')).toBe('blue');
    expect(stampTone('A')).toBe('blue');
    expect(stampTone('BBB')).toBe('ink');
    expect(stampTone('CCC')).toBe('red');
  });
});
