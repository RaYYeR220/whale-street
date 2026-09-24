import type { ReactNode } from 'react';
import { AppShell } from '../../components/chrome/AppShell';
import { PlayerProviders } from '../../components/providers/Providers';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <PlayerProviders>
      <AppShell>{children}</AppShell>
    </PlayerProviders>
  );
}
