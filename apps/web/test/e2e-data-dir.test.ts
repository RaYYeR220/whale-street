import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DATA_DIR_ENV, e2eDataDir } from '../e2e/data-dir';

describe('e2e engine data directory', () => {
  it('is made once per run, shared with the workers, and removed when the runner exits', () => {
    const env = {} as NodeJS.ProcessEnv;
    const atExit: Array<() => void> = [];
    const dir = e2eDataDir(env, (fn) => atExit.push(fn));
    expect(existsSync(dir)).toBe(true);
    expect(env[DATA_DIR_ENV]).toBe(dir);
    // A worker process loads the config again with the runner's environment.
    expect(e2eDataDir(env, (fn) => atExit.push(fn))).toBe(dir);
    expect(atExit).toHaveLength(1);
    atExit[0]?.();
    expect(existsSync(dir)).toBe(false);
  });
});
