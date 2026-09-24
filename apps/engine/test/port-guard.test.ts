import { createServer, type Server } from 'node:net';
import { describe, expect, it } from 'vitest';
import { assertLoopbackFree } from '../src/port-guard';

function listen(host: string, port = 0): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(port, host, () => resolve(s));
  });
}
const close = (s: Server) => new Promise<void>((resolve) => s.close(() => resolve()));
const portOf = (s: Server) => {
  const a = s.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
};

describe('assertLoopbackFree', () => {
  it('refuses a wildcard listen when another process serves the port on 127.0.0.1', async () => {
    const other = await listen('127.0.0.1');
    const port = portOf(other);
    await expect(assertLoopbackFree('0.0.0.0', port)).rejects.toThrow(
      new RegExp(`port ${port} is already in use on loopback \\(127\\.0\\.0\\.1\\)`),
    );
    await expect(assertLoopbackFree('::', port)).rejects.toThrow(/127\.0\.0\.1/);
    await close(other);
    // Freed: the same port passes.
    await expect(assertLoopbackFree('0.0.0.0', port)).resolves.toBeUndefined();
  });

  it('refuses when the port is served on ::1 (skipped without IPv6 loopback)', async (ctx) => {
    let other: Server;
    try {
      other = await listen('::1');
    } catch {
      ctx.skip();
      return;
    }
    const port = portOf(other);
    await expect(assertLoopbackFree('0.0.0.0', port)).rejects.toThrow(/::1/);
    await close(other);
  });

  it('does not probe for a specific host (the OS reports EADDRINUSE itself) or port 0', async () => {
    const other = await listen('127.0.0.1');
    const port = portOf(other);
    await expect(assertLoopbackFree('127.0.0.1', port)).resolves.toBeUndefined();
    await expect(assertLoopbackFree('0.0.0.0', 0)).resolves.toBeUndefined();
    await close(other);
  });
});
