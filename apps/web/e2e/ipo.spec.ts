import { expect, test } from '@playwright/test';
import { ENGINE_URL } from './env';
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
  await expect(verdict).toContainText('Deferred: not in this recording');
  await expect(verdict).toContainText(/REPLAY mode can only evaluate recorded addresses/);

  // Every decision has its own shareable page, listed on the wall of recent verdicts.
  const href = await page
    .getByRole('link', { name: /^Open verdict / })
    .first()
    .getAttribute('href');
  expect(href).toMatch(/^\/ipo\/[\w-]+$/);
  await page.goto(String(href));
  await expect(page.getByTestId('verdict')).toContainText('Deferred');
});

test('the IPO desk refuses a trader already listed on the floor (409), without a committee run', async ({
  page,
  request,
}) => {
  const res = await request.get(`${ENGINE_URL}/api/companies`);
  const [listed] = ((await res.json()) as { companies: Array<{ id: string; ticker: string }> })
    .companies;
  expect(listed, 'the engine lists at least one company').toBeTruthy();
  await page.goto('/ipo');
  await expect(page.locator('.ws-player')).toContainText('$');
  await page.getByLabel('Hyperliquid address').fill(String(listed?.id));
  await page.getByRole('button', { name: 'Send to the committee' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'already listed' })).toHaveText(
    `This trader is already listed on the floor as ${listed?.ticker}.`,
  );
  await expect(page.getByTestId('verdict')).toHaveCount(0);
});
