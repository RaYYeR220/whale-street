'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { DrawerProvider } from '../chrome/Drawer';
import { ToastProvider } from '../chrome/Toast';
import { EngineProvider, type EngineRuntime } from './engine';
import { PlayerProvider } from './player';

/**
 * Pages rendered without a player: the embed widget. A framed view with blocked or partitioned
 * storage would otherwise sign up a new anonymous player every time it is shown.
 */
export const isBarePath = (path: string | null): boolean =>
  path !== null && /^\/embed(\/|$)/.test(path);

/**
 * Every page: one engine connection per tab, and one player (with toasts and drawers) per tab
 * for every page but the embed. The player tree lives here, in the root layout, so moving between
 * the landing page and the app never remounts it: a remount would bootstrap the player again and,
 * with storage blocked, sign up another one. `runtime` is injectable for tests.
 */
export function Providers({ children, runtime }: { children: ReactNode; runtime?: EngineRuntime }) {
  const bare = isBarePath(usePathname());
  return (
    <EngineProvider runtime={runtime}>
      {bare ? children : <PlayerProviders>{children}</PlayerProviders>}
    </EngineProvider>
  );
}

/** The player, toasts and drawers (inside Providers on every page but the embed). */
export function PlayerProviders({ children }: { children: ReactNode }) {
  return (
    <PlayerProvider>
      <ToastProvider>
        <DrawerProvider>{children}</DrawerProvider>
      </ToastProvider>
    </PlayerProvider>
  );
}
