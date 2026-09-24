import { ImageResponse } from 'next/og';
import { displayStatus, hypeOf, portraitStatus } from '../../../../lib/company';
import { pct, price } from '../../../../lib/format';
import {
  BLUE,
  BLUE_TEXT,
  INK,
  MINT_TEXT,
  movingFooter,
  OG_SIZE,
  OgFrame,
  OgHanko,
  ogFonts,
  PINK_TEXT,
  portraitSrc,
  RED,
} from '../../../../lib/og/og';
import { serverApi } from '../../../../lib/server';

export const alt = 'A listed trader on Whale Street: price, NAV and hype';
export const size = OG_SIZE;
export const contentType = 'image/png';

export default async function Image({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await params;
  const api = serverApi();
  const [r, st] = await Promise.all([api.company(ticker), api.status()]);
  if (!r.ok) {
    const text =
      r.status === 404 ? `${ticker.toUpperCase()} is not listed` : 'Whale Street is unreachable';
    return new ImageResponse(
      <OgFrame footer="Powered by Nansen API">
        <div
          style={{ display: 'flex', fontFamily: 'Dela Gothic One', fontSize: 72, margin: 'auto' }}
        >
          {text}
        </div>
      </OgFrame>,
      { ...size, fonts: await ogFonts(text) },
    );
  }
  const c = r.data.company;
  const status = portraitStatus(displayStatus(c.status, c.ipoUntil, null));
  const hype = hypeOf(c.mult);
  const dead = c.status === 'BANKRUPT' || c.status === 'DELISTED';
  const text = `${c.ticker}${c.name}NAV Hype HP 倒産BANKRUPT HALTED ${price(c.price)}${price(c.nav)}${pct(hype)}`;
  return new ImageResponse(
    <OgFrame footer={movingFooter(st, 'NAV from Nansen · Powered by Nansen API')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 36, flex: 1 }}>
        {/* biome-ignore lint/performance/noImgElement: next/og renders plain <img> */}
        <img
          src={portraitSrc({ seed: c.id, hp: c.hp, hype, status, size: 360 })}
          width={360}
          height={360}
          alt=""
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div
            style={{ display: 'flex', fontFamily: 'Dela Gothic One', fontSize: 110, lineHeight: 1 }}
          >
            {c.ticker}
          </div>
          <div style={{ display: 'flex', fontSize: 34 }}>{c.name}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 24, marginTop: 18 }}>
            <div
              style={{
                display: 'flex',
                fontSize: 96,
                fontWeight: 700,
                textDecoration: dead ? 'line-through' : 'none',
                color: INK,
              }}
            >
              {price(c.price)}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 36, fontSize: 36 }}>
            <div style={{ display: 'flex', gap: 10 }}>
              NAV <span style={{ color: MINT_TEXT, fontWeight: 700 }}>{price(c.nav)}</span>
            </div>
            {dead ? null : (
              <div style={{ display: 'flex', gap: 10 }}>
                Hype{' '}
                <span style={{ color: (hype ?? 0) >= 0 ? PINK_TEXT : BLUE_TEXT, fontWeight: 700 }}>
                  {pct(hype)}
                </span>
              </div>
            )}
            {dead ? null : (
              <div style={{ display: 'flex', gap: 10 }}>
                HP{' '}
                <span style={{ fontWeight: 700 }}>
                  {Number.isFinite(c.hp) ? `${Math.round(c.hp * 100)}%` : '—'}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
      {dead ? <OgHanko kanji="倒産" word="BANKRUPT" color={RED} /> : null}
      {c.status === 'HALTED' ? <OgHanko kanji="停止" word="HALTED" color={BLUE} /> : null}
    </OgFrame>,
    { ...size, fonts: await ogFonts(`${text}停止`) },
  );
}
