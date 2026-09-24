'use client';

import type { ReactNode } from 'react';
import { DrawerProvider } from '../chrome/Drawer';
import { ToastProvider } from '../chrome/Toast';
import { EngineProvider } from './engine';
import { PlayerProvider } from './player';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <EngineProvider>
      <PlayerProvider>
        <ToastProvider>
          <DrawerProvider>{children}</DrawerProvider>
        </ToastProvider>
      </PlayerProvider>
    </EngineProvider>
  );
}
