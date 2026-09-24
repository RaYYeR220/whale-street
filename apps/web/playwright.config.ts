import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { ENGINE_PORT, ENGINE_URL, WEB_PORT, WEB_URL } from './e2e/env';

/**
 * End-to-end suite against a real engine in REPLAY (no Nansen key: the bundled recording or the
 * labelled synthetic session) and a production build of the web app, on their own ports. Each run
 * starts from an empty engine database.
 */
const dataDir = mkdtempSync(join(tmpdir(), 'ws-e2e-'));

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
      testIgnore: /responsive\.spec\.ts/,
    },
    { name: 'phone', use: { ...devices['Pixel 7'] }, testMatch: /responsive\.spec\.ts/ },
  ],
  webServer: [
    {
      command: 'pnpm --filter @whale-street/engine start',
      url: `${ENGINE_URL}/api/status`,
      env: {
        MODE: 'replay',
        PORT: String(ENGINE_PORT),
        DATA_DIR: dataDir,
        CORS_ORIGINS: WEB_URL,
        NANSEN_API_KEY: '',
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm build && pnpm exec next start --port ${WEB_PORT}`,
      url: `${WEB_URL}/floor`,
      env: { NEXT_PUBLIC_ENGINE_URL: ENGINE_URL, NEXT_PUBLIC_SITE_URL: WEB_URL },
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
});
