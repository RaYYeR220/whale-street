/** Server Components and OG images only; the browser uses the same client through EngineProvider. */
import { createApi } from './api';
import { engineUrl } from './config';

/** Engine client for Server Components and OG images (same public API the browser uses). */
export function serverApi() {
  return createApi(engineUrl());
}
