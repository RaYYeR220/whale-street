import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/engine/test/**/*.test.ts',
      'apps/web/test/**/*.test.{ts,tsx}',
    ],
    // Tests wait on events, never on wall-clock sleeps, so the timeout only guards against a hang.
    // The first engine + Fastify app of each test file is CPU-heavy (plugin setup, JIT warm-up):
    // with every file running in parallel it can take several seconds on a busy machine.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
