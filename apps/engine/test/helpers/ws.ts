import type { WebSocket } from 'ws';
import type { Engine } from '../../src/engine';

export type Msg = { t: string } & Record<string, unknown>;

/**
 * Collects every frame a test WebSocket receives; `waitFor` resolves on the first matching frame.
 * It has no timer of its own: a frame that never comes fails the test through the test timeout,
 * so a slow machine can never turn a correct run into a failure.
 */
export function inbox(ws: WebSocket) {
  const msgs: Msg[] = [];
  const waiters: Array<{ pred: (m: Msg) => boolean; resolve: (m: Msg) => void }> = [];
  ws.on('message', (data) => {
    const m = JSON.parse(String(data)) as Msg;
    msgs.push(m);
    for (const w of [...waiters]) {
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  });
  return {
    msgs,
    clear: () => {
      msgs.length = 0;
    },
    waitFor(pred: (m: Msg) => boolean): Promise<Msg> {
      const found = msgs.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve) => {
        waiters.push({ pred, resolve });
      });
    },
  };
}

export const send = (ws: WebSocket, msg: unknown) => ws.send(JSON.stringify(msg));

/** Resolves once the gateway has processed the next viewer disconnect (the server-side close). */
export function nextDisconnect(e: Engine): Promise<void> {
  const idle = e.idle;
  const original = idle.clientDisconnected;
  return new Promise((resolve) => {
    idle.clientDisconnected = (now) => {
      idle.clientDisconnected = original;
      original.call(idle, now);
      resolve();
    };
  });
}
