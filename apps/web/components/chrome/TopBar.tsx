'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCompanyViews, useEngineNow } from '../providers/engine';
import { ModeBadge } from './ModeBadge';
import { PlayerChip } from './PlayerChip';
import { SeasonClock } from './SeasonClock';

export const NAV = [
  { href: '/floor', label: 'Floor' },
  { href: '/ipo', label: 'IPO desk' },
  { href: '/leaderboard', label: 'Board' },
  { href: '/agents', label: 'Agents' },
] as const;

export function isCurrent(pathname: string, href: string): boolean {
  return (
    pathname === href ||
    pathname.startsWith(`${href}/`) ||
    (href === '/floor' && pathname.startsWith('/c/'))
  );
}

function IpoPip() {
  const views = useCompanyViews();
  const now = useEngineNow();
  if (now === null) return null;
  const open = Object.values(views).filter((v) => v.status === 'ACTIVE' && now < v.ipoUntil).length;
  if (open === 0) return null;
  return (
    <span className="ws-nav__pip" role="img" aria-label={`${open} IPO open`}>
      {open}
    </span>
  );
}

/** App top bar: brand, main nav, season clock, mode badge and the player chip. */
export function TopBar() {
  const pathname = usePathname() ?? '/';
  return (
    <header className="ws-topbar">
      <Link className="ws-brand" href="/" aria-label="Whale Street home">
        <span className="ws-brand__seal" aria-hidden="true" />
        WHALE STREET
      </Link>
      <nav className="ws-nav" aria-label="Main">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            aria-current={isCurrent(pathname, n.href) ? 'page' : undefined}
          >
            {n.label}
            {n.href === '/ipo' ? <IpoPip /> : null}
          </Link>
        ))}
      </nav>
      <div className="ws-topbar__right">
        <SeasonClock />
        <ModeBadge />
        <PlayerChip />
      </div>
    </header>
  );
}
