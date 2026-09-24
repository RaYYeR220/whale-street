'use client';

import type { ReactNode } from 'react';
import { useChannels } from '../providers/engine';
import { Banners } from './Banners';
import { BreakingTape } from './BreakingTape';
import { TabBar } from './TabBar';
import { TopBar } from './TopBar';

/** Chrome shared by every app page: top bar, data-health banners, breaking tape, phone tab bar. */
export function AppShell({ children }: { children: ReactNode }) {
  useChannels(['status', 'market']);
  return (
    <>
      <a className="ws-skip" href="#main">
        Skip to content
      </a>
      <TopBar />
      <Banners />
      {children}
      <BreakingTape />
      <TabBar />
    </>
  );
}
