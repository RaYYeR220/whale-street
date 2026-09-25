import { expect, test } from '@playwright/test';
import { listedTickers, moodOverlaps, stripOverflow } from './helpers';

test('phones: no sideways scroll, the mode badge stays visible', async ({ page, request }) => {
  const [ticker] = await listedTickers(request);
  for (const path of ['/', '/floor', `/c/${ticker}`, '/ipo', '/leaderboard', '/agents']) {
    await page.goto(path);
    await expect(page.locator('h1').first(), path).toBeVisible();
    await expect(page.locator('[data-mode="replay"]').first(), path).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);
  }
});

test('phones: the tab bar replaces the top navigation', async ({ page }) => {
  await page.goto('/floor');
  await expect(page.locator('.ws-tabbar')).toBeVisible();
  await expect(page.locator('.ws-nav')).toBeHidden();
});

test('phones: street mood keeps each coin reading clear of the crowds', async ({ page }) => {
  await page.goto('/floor');
  expect(await moodOverlaps(page)).toEqual([]);
});

test('phones: market strip keeps its Nansen credit on screen', async ({ page }) => {
  await page.goto('/floor');
  expect(await stripOverflow(page)).toBeLessThanOrEqual(0);
  await expect(page.getByText('Powered by Nansen API').first()).toBeInViewport();
});
