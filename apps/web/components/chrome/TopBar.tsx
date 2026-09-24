'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { MarketEntry } from '../../lib/api-types';
import { openIpoCount } from '../../lib/company';
import { useCompanyViews, useEngine, useEngineNow } from '../providers/engine';
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

const NO_ENTRIES: Readonly<Record<string, MarketEntry>> = {};

function IpoPip() {
  const views = useCompanyViews();
  const live = useEngine((s) => s.market?.byTicker ?? NO_ENTRIES);
  const now = useEngineNow();
  // The floor's own rule, so the pip never disagrees with the IPO panels.
  const open = openIpoCount(views, live, now);
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
