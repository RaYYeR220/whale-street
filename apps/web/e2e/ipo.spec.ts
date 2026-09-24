import { expect, test } from '@playwright/test';
import { unknownAddress } from './helpers';

test('the IPO desk defers an address the recording does not know', async ({ page }) => {
  await page.goto('/ipo');
  await page.getByLabel('Hyperliquid address').fill('0x123');
  await page.getByRole('button', { name: 'Send to the committee' }).click();
  await expect(page.getByText(/That isn’t a Hyperliquid address/)).toBeVisible();

  const address = unknownAddress();
  await page.getByLabel('Hyperliquid address').fill(address);
  await page.getByRole('button', { name: 'Send to the committee' }).click();
  const verdict = page.getByTestId('verdict');
  await expect(verdict).toBeVisible({ timeout: 20_000 });
  await expect(verdict).toContainText('Deferred');
  await expect(verdict).toContainText(/not in recording/);

  // Every decision has its own shareable page, listed on the wall of recent verdicts.
  const href = await page
    .getByRole('link', { name: /^Open verdict / })
    .first()
    .getAttribute('href');
  expect(href).toMatch(/^\/ipo\/[\w-]+$/);
  await page.goto(String(href));
  await expect(page.getByTestId('verdict')).toContainText('Deferred');
});
