import type { WebSocket } from 'ws';

export type Msg = { t: string } & Record<string, unknown>;

/** Collects every frame a test WebSocket receives; `waitFor` resolves on the first matching frame. */
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
    waitFor(pred: (m: Msg) => boolean, timeoutMs = 2_000): Promise<Msg> {
      const found = msgs.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for a frame')),
          timeoutMs,
        );
        waiters.push({
          pred,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
        });
      });
    },
  };
}

export const send = (ws: WebSocket, msg: unknown) => ws.send(JSON.stringify(msg));
