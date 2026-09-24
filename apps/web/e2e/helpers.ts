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
