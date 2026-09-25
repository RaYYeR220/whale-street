import type { APIRequestContext, Page } from '@playwright/test';
import { ENGINE_URL } from './env';

/** Tickers the engine lists right now (REPLAY: the recording's companies or the synthetic two). */
export async function listedTickers(request: APIRequestContext): Promise<string[]> {
  const res = await request.get(`${ENGINE_URL}/api/companies`);
  const body = (await res.json()) as { companies: Array<{ ticker: string; status: string }> };
  return body.companies.filter((c) => c.status === 'ACTIVE').map((c) => c.ticker);
}

/** Collects console errors and failed page requests (ignores the favicon probe). */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

/** A random, well-formed address the recording cannot know. */
export const unknownAddress = (): string =>
  `0x${Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`;

/**
 * Horizontal overflow of the market strip (positive: content scrolls past view on the right,
 * hiding whatever comes last — the Nansen credit; 0 or less once it wraps or shrinks to fit).
 */
export async function stripOverflow(page: Page): Promise<number> {
  const strip = page.locator('.ws-strip').first();
  await strip.waitFor();
  return strip.evaluate((el) => el.scrollWidth - el.clientWidth);
}

/**
 * Street mood rows whose "leans long, read 4 min ago" line overlaps the crowd figures or their
 * percentages (empty when the layout keeps them apart).
 */
export async function moodOverlaps(page: Page): Promise<string[]> {
  await page.locator('.ws-mood__coin').first().waitFor();
  return page.evaluate(() => {
    const hit = (a: DOMRect, b: DOMRect) =>
      a.left < b.right - 0.5 &&
      b.left < a.right - 0.5 &&
      a.top < b.bottom - 0.5 &&
      b.top < a.bottom - 0.5;
    const out: string[] = [];
    for (const coin of document.querySelectorAll('.ws-mood__coin')) {
      const line = coin.querySelector('.ws-mood__name small');
      if (!line) continue;
      // Where the text is drawn (a nowrap line can spill out of its own box).
      const range = document.createRange();
      range.selectNodeContents(line);
      const box = range.getBoundingClientRect();
      for (const other of coin.querySelectorAll('.ws-crowd__usd, .ws-crowd__side'))
        if (hit(box, other.getBoundingClientRect()))
          out.push(`${line.textContent} overlaps ${other.textContent || 'the crowd'}`);
    }
    return out;
  });
}
