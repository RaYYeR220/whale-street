import type { ReactNode } from 'react';
import { PlayerProviders } from '../../components/providers/Providers';

export default function SiteLayout({ children }: { children: ReactNode }) {
  return <PlayerProviders>{children}</PlayerProviders>;
}
