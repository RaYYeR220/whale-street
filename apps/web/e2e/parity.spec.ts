import { expect, test } from '@playwright/test';
import { listedTickers } from './helpers';

/**
 * Design parity with the design reference: the tokens and fonts are checked here; full page
 * screenshots are saved next to the test results for a side-by-side look (live data differs, so
 * pixels are not compared).
 */
test('design tokens and fonts match the design reference', async ({ page }) => {
  await page.goto('/floor');
  const s = await page.evaluate(() => {
    const body = getComputedStyle(document.body);
    const brand = document.querySelector('.ws-brand');
    return {
      bg: body.backgroundColor,
      font: body.fontFamily,
      size: Number.parseFloat(body.fontSize),
      paper: getComputedStyle(document.documentElement).getPropertyValue('--ws-paper').trim(),
      display: brand ? getComputedStyle(brand).fontFamily : '',
    };
  });
  expect(s.paper).toBe('#f3eee2');
  expect(s.bg).toBe('rgb(243, 238, 226)');
  expect(s.font).toContain('Zen Kaku Gothic New');
  expect(s.display).toContain('Dela Gothic One');
  expect(s.size).toBeGreaterThanOrEqual(13);
});

test('reduced motion turns the ticker animations off', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/floor');
  const anim = await page.evaluate(() => {
    const track = document.querySelector('.ws-breaking__track');
    return track ? getComputedStyle(track).animationName : 'none';
  });
  expect(anim).toBe('none');
});

test('keyboard users can skip to the content and see focus', async ({ page }) => {
  await page.goto('/floor');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  const outline = await skip.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe('none');
});

test('screenshots for side-by-side review', async ({ page, request }, info) => {
  const [ticker] = await listedTickers(request);
  for (const [name, path] of [
    ['floor', '/floor'],
    ['company', `/c/${ticker}`],
    ['ipo', '/ipo'],
    ['board', '/leaderboard'],
    ['agents', '/agents'],
    ['landing', '/'],
  ] as const) {
    await page.goto(path);
    await expect(page.locator('h1').first()).toBeVisible();
    await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
  }
});
