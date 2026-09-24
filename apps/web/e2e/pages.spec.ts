import { expect, test } from '@playwright/test';
import { listedTickers, watchErrors } from './helpers';

test('every page renders without console errors', async ({ page, request }) => {
  const [ticker] = await listedTickers(request);
  const errors = watchErrors(page);
  for (const path of ['/', '/floor', `/c/${ticker}`, '/ipo', '/leaderboard', '/agents']) {
    await page.goto(path);
    await expect(page.locator('h1').first(), path).toBeVisible();
    await expect(page.locator('[data-mode="replay"]').first(), path).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('a profile page shows the player’s season', async ({ page }) => {
  await page.goto('/leaderboard');
  const chip = page.locator('.ws-player');
  await expect(chip).toContainText('$10,000.00');
  const handle = (await page.locator('.ws-player__t b').first().textContent())?.trim() ?? '';
  expect(handle).not.toBe('');
  await page.goto(`/u/${encodeURIComponent(handle)}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(handle);
});

test('the embed widget renders, says REPLAY and may be framed anywhere', async ({
  page,
  request,
}) => {
  const [ticker] = await listedTickers(request);
  const res = await page.goto(`/embed/${ticker}`);
  expect(res?.headers()['content-security-policy']).toBe('frame-ancestors *');
  await expect(page.locator('.em__tk')).toHaveText(String(ticker));
  await expect(page.locator('.em__mode')).toHaveText('REPLAY');
  const floor = await request.get('/floor');
  expect(floor.headers()['x-frame-options']).toBe('SAMEORIGIN');
});

test('an unknown ticker says so instead of showing a blank company', async ({ page }) => {
  const res = await page.goto('/c/NOPE');
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('open graph cards render', async ({ request }) => {
  const [ticker] = await listedTickers(request);
  const html = await (await request.get(`/c/${ticker}`)).text();
  const og = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
  expect(og, 'the company page declares an og:image').toBeTruthy();
  const url = new URL(String(og).replace(/&amp;/g, '&'));
  const res = await request.get(`${url.pathname}${url.search}`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('image/png');
});
