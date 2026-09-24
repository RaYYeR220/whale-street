/**
 * Ports for the e2e servers. They differ from the dev ports (8787 / 3000) so a running `pnpm dev`,
 * possibly LIVE with a Nansen key, is never reused or written to by the suite.
 */
export const ENGINE_PORT = 8790;
export const WEB_PORT = 3100;
export const ENGINE_URL = `http://localhost:${ENGINE_PORT}`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;
