import { expect, test } from '@playwright/test';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseSiweMessage } from 'viem/siwe';
import { TOKEN_KEY } from '../lib/player';
import { ENGINE_URL, WEB_URL } from './env';
import { listedTickers } from './helpers';

// Well-known test key (never used for anything real).
const KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

test('a wallet links to the player with Sign-In with Ethereum, verified by the engine', async ({
  page,
  request,
}) => {
  const account = privateKeyToAccount(KEY);
  const signed: string[] = [];
  // A minimal injected wallet (EIP-1193) whose personal_sign is done here, in the test process.
  await page.exposeFunction('wsTestSign', async (raw: Hex) => {
    const text = Buffer.from(raw.slice(2), 'hex').toString('utf8');
    signed.push(text);
    return account.signMessage({ message: { raw } });
  });
  await page.addInitScript((address: string) => {
    const w = window as unknown as {
      ethereum: unknown;
      wsTestSign(raw: string): Promise<string>;
    };
    const toHex = (s: string) =>
      `0x${Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('')}`;
    w.ethereum = {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        switch (method) {
          case 'eth_requestAccounts':
          case 'eth_accounts':
            return [address];
          case 'eth_chainId':
            return '0xa4b1';
          case 'net_version':
            return '42161';
          case 'wallet_requestPermissions':
          case 'wallet_getPermissions':
            return [{ parentCapability: 'eth_accounts' }];
          case 'personal_sign': {
            const data = String(params?.[0] ?? '');
            return w.wsTestSign(data.startsWith('0x') ? data : toHex(data));
          }
          default:
            throw Object.assign(new Error(`unsupported: ${method}`), { code: 4200 });
        }
      },
      on: () => undefined,
      removeListener: () => undefined,
    };
  }, account.address);
  // The REPLAY engine has no trading key, so it reports Mirror off; the wallet link needs none,
  // so the page is told Mirror is on to reach the link step. The link itself is the real engine's.
  await page.route('**/api/mirror/status', (route) =>
    route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: { available: true, mode: 'replay' },
    }),
  );

  const [ticker] = await listedTickers(request);
  await page.goto(`/c/${ticker}`);
  await expect(page.locator('.ws-player')).toContainText('$10,000.00');
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('button', { name: 'Sign to link' }).click();
  await expect(page.getByText('Linked to your player')).toBeVisible();

  expect(parseSiweMessage(signed[0] ?? '')).toMatchObject({
    domain: new URL(WEB_URL).host,
    uri: WEB_URL,
    address: account.address,
    chainId: 42_161,
    version: '1',
  });
  const token = await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY);
  const me = await request.get(`${ENGINE_URL}/api/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(((await me.json()) as { player: { walletAddress: string } }).player.walletAddress).toBe(
    account.address.toLowerCase(),
  );
});
