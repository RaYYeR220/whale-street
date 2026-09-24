import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './styles/ws.css';
import './styles/chrome.css';
import './styles/floor.css';
import './styles/company.css';
import './styles/ipo.css';
import './styles/board.css';
import './styles/agents.css';
import './styles/landing.css';
import './styles/embed.css';
import './styles/profile.css';

const FONTS =
  'https://fonts.googleapis.com/css2?family=Dela+Gothic+One&family=Zen+Kaku+Gothic+New:wght@400;500;700;900&display=swap';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: { default: 'Whale Street', template: '%s — Whale Street' },
  description:
    'A live play-money exchange where every listed company is a real Hyperliquid trader, profiled with Nansen data.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#f3eee2',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* The ported stylesheets and the portrait SVG text use these exact family names. */}
        <link rel="stylesheet" href={FONTS} />
      </head>
      <body className="ws">{children}</body>
    </html>
  );
}
