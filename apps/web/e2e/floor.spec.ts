import { expect, test } from '@playwright/test';
import { listedTickers, moodOverlaps, stripOverflow, watchErrors } from './helpers';

test('the floor shows the REPLAY badge and ticks', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/floor');
  const badge = page.locator('.ws-topbar [data-mode="replay"]');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText(/^REPLAY · /);
  await expect(page.getByTestId('roster').locator('.ws-co').first()).toBeVisible();
  await expect(page.getByText('Powered by Nansen API').first()).toBeVisible();

  const strip = page.locator('.ws-strip');
  await expect(strip).toHaveAttribute('data-market-at', /\d+/);
  const first = Number(await strip.getAttribute('data-market-at'));
  await expect
    .poll(async () => Number(await strip.getAttribute('data-market-at')), { timeout: 10_000 })
    .toBeGreaterThan(first);
  expect(errors).toEqual([]);
});

test('street mood keeps each coin reading clear of the crowds and percentages', async ({
  page,
}) => {
  await page.goto('/floor');
  expect(await moodOverlaps(page)).toEqual([]);
});

test('market strip keeps its Nansen credit on screen at 1280, 1440 and 1920', async ({ page }) => {
  await page.goto('/floor');
  const credit = page.getByText('Powered by Nansen API').first();
  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await stripOverflow(page), `${width}px`).toBeLessThanOrEqual(0);
    await expect(credit, `${width}px`).toBeInViewport();
  }
});

test('a company page takes a play-money order', async ({ page, request }) => {
  const [ticker] = await listedTickers(request);
  expect(ticker, 'the engine lists at least one active company').toBeTruthy();
  await page.goto(`/c/${ticker}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(String(ticker));
  // Wait for the anonymous player (the chip shows a handle once the engine answered).
  await expect(page.locator('.ws-player')).toContainText('$10,000.00');
  const buy = page.getByRole('button', { name: new RegExp(`^Buy [\\d.]+ ${ticker}$`) });
  await expect(buy).toBeEnabled();
  await buy.click();
  await expect(page.locator('.ws-toast')).toContainText(`Bought`);
  await expect(page.locator('.co-pos, .co-position').first()).toContainText('shares at');
});

test('Mirror says it is off when the engine has no trading key', async ({ page, request }) => {
  const [ticker] = await listedTickers(request);
  await page.goto(`/c/${ticker}`);
  const off = page.getByTestId('mirror-off');
  await expect(off).toBeVisible();
  await expect(off).toContainText('Mirror is off on this engine');
  await expect(page.getByTestId('mirror-on')).toHaveCount(0);
});

test('an order refused while the market is paused is sent once more and fills', async ({
  page,
  request,
}) => {
  const [ticker] = await listedTickers(request);
  // The engine pauses orders while it is idle or catching up; a viewer keeps it awake, so the
  // first reply is made to be MARKET_PAUSED here. The second request reaches the real engine.
  let refused = 0;
  await page.route('**/api/orders', async (route) => {
    if (refused > 0 || route.request().method() !== 'POST') return route.continue();
    refused += 1;
    await route.fulfill({
      status: 503,
      headers: { 'retry-after': '2', 'access-control-allow-origin': '*' },
      json: {
        error: 'MARKET_PAUSED',
        message:
          'market paused while prices catch up (no live viewer or delayed marks); retry shortly',
        retryAfterMs: 2_000,
      },
    });
  });
  await page.goto(`/c/${ticker}`);
  await expect(page.locator('.ws-player')).toContainText('$10,000.00');
  const buy = page.getByRole('button', { name: new RegExp(`^Buy [\\d.]+ ${ticker}$`) });
  await expect(buy).toBeEnabled();
  await buy.click();
  await expect(page.getByRole('button', { name: /^Market (opening|waking up)…$/ })).toBeVisible();
  await expect(page.locator('.ws-toast')).toContainText('Bought', { timeout: 10_000 });
  expect(refused).toBe(1);
});
