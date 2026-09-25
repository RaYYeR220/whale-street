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

test('the embed fits its real 320×120 box in REPLAY: HP and the Nansen line fully visible', async ({
  page,
  request,
}) => {
  const [ticker] = await listedTickers(request);
  await page.setViewportSize({ width: 320, height: 120 });
  await page.goto(`/embed/${ticker}`);
  await expect(page.locator('.em__mode')).toHaveText('REPLAY');
  await expect(page.locator('.em__hp')).toHaveText(/^HP (\d+%|—)$/);
  await expect(page.locator('.em__src')).toHaveText('Powered by Nansen API');
  const card = await page.locator('.em').boundingBox();
  if (!card) throw new Error('no embed card');
  for (const sel of ['.em__on', '.em__mode', '.em__hp', '.em__src']) {
    const el = page.locator(sel);
    const box = await el.boundingBox();
    if (!box) throw new Error(`${sel} is not rendered`);
    // The box and the text actually drawn stay inside the card's 2.5px border (the card clips
    // everything past it), and the text is not squeezed narrower than it needs.
    const drawn = await el.evaluate((n) => {
      const range = document.createRange();
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
    for (const [what, left, right, top, bottom] of [
      ['box', box.x, box.x + box.width, box.y, box.y + box.height],
      ['text', drawn.left, drawn.right, drawn.top, drawn.bottom],
    ] as const) {
      expect(left, `${sel} ${what} left edge`).toBeGreaterThanOrEqual(card.x + 2.5);
      expect(right, `${sel} ${what} right edge`).toBeLessThanOrEqual(card.x + card.width - 2.5);
      expect(top, `${sel} ${what} top edge`).toBeGreaterThanOrEqual(card.y + 2.5);
      expect(bottom, `${sel} ${what} bottom edge`).toBeLessThanOrEqual(card.y + card.height - 2.5);
    }
    const squeezed = await el.evaluate((n) => n.scrollWidth > n.clientWidth + 0.5);
    expect(squeezed, `${sel} is squeezed`).toBe(false);
  }
  const size = await page
    .locator('.em__src')
    .evaluate((n) => Number.parseFloat(getComputedStyle(n).fontSize));
  expect(size).toBeGreaterThanOrEqual(11);
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
