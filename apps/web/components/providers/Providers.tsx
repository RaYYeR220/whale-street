'use client';

import type { ReactNode } from 'react';
import { DrawerProvider } from '../chrome/Drawer';
import { ToastProvider } from '../chrome/Toast';
import { EngineProvider } from './engine';
import { PlayerProvider } from './player';

/** Every page: one engine connection per tab. */
export function Providers({ children }: { children: ReactNode }) {
  return <EngineProvider>{children}</EngineProvider>;
}

/**
 * Pages with a player (the app and the landing page). The embed widget has none: a framed view
 * with blocked or partitioned storage would otherwise sign up a new anonymous player every time.
 */
export function PlayerProviders({ children }: { children: ReactNode }) {
  return (
    <PlayerProvider>
      <ToastProvider>
        <DrawerProvider>{children}</DrawerProvider>
      </ToastProvider>
    </PlayerProvider>
  );
}
