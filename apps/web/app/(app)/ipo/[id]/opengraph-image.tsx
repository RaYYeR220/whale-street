import { ImageResponse } from 'next/og';
import { headline, MEMBERS, verdictChecks } from '../../../../lib/committee';
import { shortAddress } from '../../../../lib/format';
import {
  BLUE,
  INK,
  OG_SIZE,
  OgFrame,
  OgHanko,
  ogFonts,
  portraitSrc,
  RED,
} from '../../../../lib/og/og';
import { serverApi } from '../../../../lib/server';

export const alt = 'A Whale Street listing committee verdict';
export const size = OG_SIZE;
export const contentType = 'image/png';

const SEAL = { PASS: '可', FAIL: '否', FLAG: '注', UNKNOWN: '?' } as const;

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await serverApi().ipo(id);
  if (!r.ok) {
    const text = 'Verdict not found';
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
  const app = r.data.app;
  const checks = verdictChecks(app);
  const title = headline(app, null);
  const H =
    app.status === 'DENIED'
      ? { kanji: '否決', word: 'DENIED', color: RED }
      : app.status === 'APPROVED'
        ? { kanji: '承認', word: 'LISTED', color: BLUE }
        : { kanji: '保留', word: 'DEFERRED', color: INK };
  const text = `${title}${shortAddress(app.address)}${MEMBERS.map((m) => m.name).join('')}${H.kanji}${H.word}可否注?Listing committee`;
  return new ImageResponse(
    <OgFrame footer="Six checks on Nansen data · Powered by Nansen API">
      <div style={{ display: 'flex', gap: 32, alignItems: 'center' }}>
        {/* biome-ignore lint/performance/noImgElement: next/og renders plain <img> */}
        <img
          src={portraitSrc({
            seed: app.address,
            hp: app.status === 'DENIED' ? 0.25 : 0.85,
            size: 220,
          })}
          width={220}
          height={220}
          alt=""
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 600 }}>
          <div style={{ display: 'flex', fontSize: 30 }}>
            Listing committee on {shortAddress(app.address)}
          </div>
          <div
            style={{
              display: 'flex',
              fontFamily: 'Dela Gothic One',
              fontSize: 64,
              lineHeight: 1.1,
              color: H.color,
            }}
          >
            {title}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 14, marginTop: 'auto' }}>
        {MEMBERS.map((m, i) => {
          const s = checks[i]?.status ?? 'UNKNOWN';
          const col = s === 'FAIL' ? RED : s === 'PASS' ? BLUE : INK;
          return (
            <div
              key={m.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 6,
                width: 160,
              }}
            >
              <div
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: 36,
                  border: `5px solid ${col}`,
                  color: col,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 34,
                  fontFamily: 'Dela Gothic One',
                }}
              >
                {SEAL[s]}
              </div>
              <div style={{ display: 'flex', fontSize: 22 }}>{m.name}</div>
            </div>
          );
        })}
      </div>
      <OgHanko kanji={H.kanji} word={H.word} color={H.color} />
    </OgFrame>,
    { ...size, fonts: await ogFonts(text) },
  );
}
