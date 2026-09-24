import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Carries the run's engine data directory from the Playwright runner to its worker processes. */
export const DATA_DIR_ENV = 'WS_E2E_DATA_DIR';

/**
 * The engine's data directory for one e2e run. The runner process creates it and removes it when
 * it exits, after Playwright has stopped the servers; worker processes load the config again and
 * reuse the runner's directory through the environment instead of making their own.
 */
export function e2eDataDir(
  env: NodeJS.ProcessEnv = process.env,
  atExit: (fn: () => void) => void = (fn) => {
    process.on('exit', fn);
  },
): string {
  const existing = env[DATA_DIR_ENV];
  if (existing) return existing;
  const dir = mkdtempSync(join(tmpdir(), 'ws-e2e-'));
  env[DATA_DIR_ENV] = dir;
  atExit(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      console.warn(`e2e: could not remove ${dir}: ${String(err)}`);
    }
  });
  return dir;
}
