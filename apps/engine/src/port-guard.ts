import { connect } from 'node:net';

const WILDCARD = new Set(['0.0.0.0', '::']);
const LOOPBACKS = ['127.0.0.1', '::1'] as const;

/** True if something accepts TCP on host:port; any error or timeout counts as "no". */
function answers(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/**
 * Refuses a wildcard listen on a port another process already serves on loopback. Windows lets a
 * wildcard listener coexist with another process's 127.0.0.1 / ::1 listener on the same port, and
 * localhost clients then reach the other process. A specific host needs no probe (the OS answers
 * EADDRINUSE itself); on Linux nothing answers and the probe returns at once.
 */
export async function assertLoopbackFree(
  host: string,
  port: number,
  timeoutMs = 500,
): Promise<void> {
  if (port === 0 || !WILDCARD.has(host)) return;
  for (const lo of LOOPBACKS) {
    if (await answers(lo, port, timeoutMs))
      throw new Error(
        `port ${port} is already in use on loopback (${lo}): another process would shadow this engine for localhost clients`,
      );
  }
}
