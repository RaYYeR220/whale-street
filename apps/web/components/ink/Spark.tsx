'use client';

import { type CSSProperties, type PointerEvent, useMemo, useState } from 'react';
import { price as fmtPrice, pct } from '../../lib/format';
import { SPARK_H, SPARK_W, sparkGeometry } from '../../lib/ink';
import { FloatingTip } from './FloatingTip';

export interface SparkProps {
  nav: ReadonlyArray<number | null>;
  price: ReadonlyArray<number | null>;
  label?: string;
  /** Minutes between points (for the hover label). */
  stepMin?: number;
  height?: string;
}

/** Paired sparkline: NAV (mint) vs price (ink) on one scale, the gap tinted pink (hype) or blue. */
export function Spark({ nav, price, label, stepMin = 1, height }: SparkProps) {
  const g = useMemo(() => sparkGeometry(nav, price), [nav, price]);
  const [hover, setHover] = useState<{ i: number; x: number; top: number; bottom: number } | null>(
    null,
  );
  const n = nav.length;
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (n < 2) return;
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1))));
    setHover({ i, x: e.clientX, top: r.top, bottom: r.bottom });
  };
  const style = height ? ({ '--spark-h': height } as CSSProperties) : undefined;
  const nv = hover ? (nav[hover.i] ?? null) : null;
  const pv = hover ? (price[hover.i] ?? null) : null;
  const mins = hover ? (n - 1 - hover.i) * stepMin : 0;
  const when = mins === 0 ? 'now' : `${mins} min ago`;
  return (
    <div
      className="ws-spark"
      role="img"
      aria-label={label}
      style={style}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
    >
      <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden="true">
        <path className="ws-spark__gap ws-spark__gap--up" d={g.up} />
        <path className="ws-spark__gap ws-spark__gap--down" d={g.dn} />
        <path className="ws-spark__price" d={g.priceD} vectorEffect="non-scaling-stroke" />
        <path className="ws-spark__nav" d={g.navD} vectorEffect="non-scaling-stroke" />
      </svg>
      {g.priceDot ? <i className="ws-spark__dot ws-spark__dot--price" style={g.priceDot} /> : null}
      {g.navDot ? <i className="ws-spark__dot ws-spark__dot--nav" style={g.navDot} /> : null}
      <i
        className="ws-spark__x"
        hidden={!hover}
        style={hover && n > 1 ? { left: `${(hover.i / (n - 1)) * 100}%` } : undefined}
      />
      {hover ? (
        <FloatingTip x={hover.x} top={hover.top} bottom={hover.bottom}>
          <b>{when}</b>
          {nv == null && pv == null ? (
            <span>No data</span>
          ) : (
            <>
              <span>
                <i className="k k--nav" />
                NAV {fmtPrice(nv)}
              </span>
              <span>
                <i className="k k--price" />
                Price {fmtPrice(pv)}
              </span>
              {nv && pv ? <span>Hype {pct(pv / nv - 1)}</span> : null}
            </>
          )}
        </FloatingTip>
      ) : null}
    </div>
  );
}
