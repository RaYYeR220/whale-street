'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useDrawer } from './Drawer';
import { isCurrent } from './TopBar';

const ICON = {
  floor: 'M4 4h9v7H4zM15 4h9v4h-9zM15 10h9v10h-9zM4 13h9v7H4z',
  ipo: 'M7 17c0-7 3-11 7-11s7 4 7 11l2 2H5z M12 21h4',
  board: 'M9 3h10v6a5 5 0 0 1-10 0zM9 5H5c0 4 2 5 4 5M19 5h4c0 4-2 5-4 5M14 14v4M10 21h8',
};

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 28 24" aria-hidden="true">
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Phone navigation: Floor, IPO, Board, Me (the desk drawer). */
export function TabBar() {
  const pathname = usePathname() ?? '/';
  const { open } = useDrawer();
  const tab = (href: string, label: string, d: string) => (
    <Link href={href} aria-current={isCurrent(pathname, href) ? 'page' : undefined}>
      <Icon d={d} />
      {label}
    </Link>
  );
  return (
    <nav className="ws-tabbar" aria-label="Main (mobile)">
      {tab('/floor', 'Floor', ICON.floor)}
      {tab('/ipo', 'IPO', ICON.ipo)}
      {tab('/leaderboard', 'Board', ICON.board)}
      <button type="button" aria-haspopup="dialog" onClick={() => open({ kind: 'desk' })}>
        <svg viewBox="0 0 28 24" aria-hidden="true">
          <circle cx="14" cy="8" r="4.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
          <path
            d="M5 22c1-5 5-7 9-7s8 2 9 7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </svg>
        Me
      </button>
    </nav>
  );
}
