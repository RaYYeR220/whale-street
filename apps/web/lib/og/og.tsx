/**
 * Shared pieces of the Open Graph cards (next/og, Node runtime on Next 16.3.6, which carries the
 * ImageResponse security fix). Fonts are fetched as small text-only subsets from Google Fonts; if
 * that fails the card still renders with the default font rather than failing the share.
 */
import type { ReactNode } from 'react';
import { type PortraitOptions, renderPortrait } from '../portrait';

export const OG_SIZE = { width: 1200, height: 630 };
export const INK = '#1a1714';
export const PAPER = '#f3eee2';
export const PANEL = '#e4dccb';
export const PINK = '#ff48b0';
export const BLUE = '#0078bf';
export const MINT_TEXT = '#006b45';
export const RED = '#d8342c';
export const PINK_TEXT = '#a8106a';
export const BLUE_TEXT = '#005d94';

type Font = { name: string; data: ArrayBuffer; weight: 400 | 700 | 900; style: 'normal' };

async function googleFont(
  family: string,
  weight: number,
  text: string,
): Promise<ArrayBuffer | null> {
  try {
    const url = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}:wght@${weight}&text=${encodeURIComponent(text)}`;
    const css = await (await fetch(url, { cache: 'force-cache' })).text();
    const src = css.match(/src: url\((.+?)\) format\('(opentype|truetype)'\)/)?.[1];
    if (!src) return null;
    const res = await fetch(src, { cache: 'force-cache' });
    return res.ok ? await res.arrayBuffer() : null;
  } catch {
    return null;
  }
}

/** Dela Gothic One for display text and Zen Kaku Gothic New (bold) for UI text, subset to `text`. */
export async function ogFonts(text: string): Promise<Font[]> {
  const chars = `${text}0123456789.,%+−$—:·() ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz`;
  const [display, ui] = await Promise.all([
    googleFont('Dela Gothic One', 400, chars),
    googleFont('Zen Kaku Gothic New', 700, chars),
  ]);
  const fonts: Font[] = [];
  if (display) fonts.push({ name: 'Dela Gothic One', data: display, weight: 400, style: 'normal' });
  if (ui) fonts.push({ name: 'Zen Kaku Gothic New', data: ui, weight: 700, style: 'normal' });
  return fonts;
}

/** A portrait as an <img> data URI (standalone SVG: hex colours and its own filters). */
export function portraitSrc(o: PortraitOptions): string {
  const svg = renderPortrait({ ...o, standalone: true });
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

export function OgFrame({ children, footer }: { children: ReactNode; footer: string }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: PAPER,
        padding: 36,
        fontFamily: 'Zen Kaku Gothic New',
        color: INK,
      }}
    >
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          background: PANEL,
          border: `6px solid ${INK}`,
          padding: '28px 36px',
          position: 'relative',
        }}
      >
        {children}
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: 16,
          fontSize: 24,
        }}
      >
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 12, fontFamily: 'Dela Gothic One' }}
        >
          <div style={{ width: 26, height: 26, borderRadius: 13, border: `4px solid ${PINK}` }} />
          WHALE STREET
        </div>
        <div style={{ display: 'flex', color: MINT_TEXT }}>{footer}</div>
      </div>
    </div>
  );
}

export function OgHanko({ kanji, word, color }: { kanji: string; word: string; color: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        right: 40,
        top: 40,
        width: 210,
        height: 210,
        borderRadius: 105,
        border: `10px solid ${color}`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color,
        transform: 'rotate(-12deg)',
        fontFamily: 'Dela Gothic One',
      }}
    >
      <div style={{ fontSize: 64, display: 'flex' }}>{kanji}</div>
      <div style={{ fontSize: 26, display: 'flex' }}>{word}</div>
    </div>
  );
}
