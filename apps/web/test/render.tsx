/** Test harness: the app providers around an injected engine runtime (fake fetch, fake socket). */
import type { ReactNode } from 'react';
import { DrawerProvider } from '../components/chrome/Drawer';
import { ToastProvider } from '../components/chrome/Toast';
import { EngineProvider, type EngineRuntime } from '../components/providers/engine';
import { PlayerProvider } from '../components/providers/player';
import { createApi } from '../lib/api';
import { createEngineStore } from '../lib/store';
import { EngineSocket } from '../lib/ws-client';
import { FakeSocket, fakeFetch } from './helpers';

export function testRuntime(routes: Parameters<typeof fakeFetch>[0] = {}): EngineRuntime {
  return {
    api: createApi('http://engine.test', fakeFetch(routes).impl),
    store: createEngineStore(),
    socket: new EngineSocket({
      url: 'ws://engine.test/ws',
      createSocket: (u) => new FakeSocket(u),
    }),
    tokenRef: { current: null },
  };
}

export function Wrap({ runtime, children }: { runtime?: EngineRuntime; children: ReactNode }) {
  return (
    <EngineProvider runtime={runtime ?? testRuntime()}>
      <PlayerProvider>
        <ToastProvider>
          <DrawerProvider>{children}</DrawerProvider>
        </ToastProvider>
      </PlayerProvider>
    </EngineProvider>
  );
}
