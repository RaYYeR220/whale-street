/** Server Components and OG images only; the browser uses the same client through EngineProvider. */
import { createApi } from './api';
import { engineUrl } from './config';

/**
 * A server render waits this long for the engine: a hanging (not refused) engine then shows the
 * offline page within a few seconds instead of after the browser client's longer budget.
 */
export const SERVER_TIMEOUT_MS = 4_000;

/** Engine client for Server Components and OG images (same public API the browser uses). */
export function serverApi() {
  return createApi(engineUrl(), undefined, { timeoutMs: SERVER_TIMEOUT_MS });
}
