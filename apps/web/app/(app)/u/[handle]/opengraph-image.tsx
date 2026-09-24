import { PARAMS } from '@whale-street/core';
import { ImageResponse } from 'next/og';
import { pct, usd } from '../../../../lib/format';
import {
  BLUE_TEXT,
  movingFooter,
  OG_SIZE,
  OgFrame,
  ogFonts,
  PINK_TEXT,
  portraitSrc,
} from '../../../../lib/og/og';
import { serverApi } from '../../../../lib/server';

export const alt = 'A Whale Street player: net worth and season return';
export const size = OG_SIZE;
export const contentType = 'image/png';

export default async function Image({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const name = decodeURIComponent(handle);
  const api = serverApi();
  const [r, st] = await Promise.all([api.profile(name), api.status()]);
  if (!r.ok) {
    const text = 'Player not found';
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
  const p = r.data.player;
  const nw = r.data.portfolio.netWorth;
  const ret = nw === null ? null : nw / PARAMS.seasonStartCash - 1;
  const text = `${p.handle}Net worth Season return AGENT BOT ${usd(nw)}${pct(ret)}`;
  return new ImageResponse(
    <OgFrame footer={movingFooter(st, 'Play money · Powered by Nansen API')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 40, flex: 1 }}>
        {/* biome-ignore lint/performance/noImgElement: next/og renders plain <img> */}
        <img
          src={portraitSrc({ seed: p.handle, hp: 0.86, size: 340 })}
          width={340}
          height={340}
          alt=""
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div
            style={{
              display: 'flex',
              fontFamily: 'Dela Gothic One',
              fontSize: 64,
              lineHeight: 1.1,
            }}
          >
            {p.handle}
          </div>
          {p.kind !== 'human' ? (
            <div style={{ display: 'flex', fontSize: 28, color: BLUE_TEXT }}>
              {p.kind === 'agent' ? 'AGENT' : 'BOT'}
            </div>
          ) : null}
          <div style={{ display: 'flex', fontSize: 30, marginTop: 20 }}>Net worth</div>
          <div style={{ display: 'flex', fontSize: 84, fontWeight: 700 }}>{usd(nw)}</div>
          <div
            style={{
              display: 'flex',
              fontSize: 36,
              color: (ret ?? 0) >= 0 ? PINK_TEXT : BLUE_TEXT,
            }}
          >
            {pct(ret)} this season
          </div>
        </div>
      </div>
    </OgFrame>,
    { ...size, fonts: await ogFonts(text) },
  );
}
