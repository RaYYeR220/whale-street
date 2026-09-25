import type { ReactNode } from 'react';
import { AppShell } from '../../components/chrome/AppShell';

/** The player providers sit in the root layout (Providers), shared with the landing page. */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
