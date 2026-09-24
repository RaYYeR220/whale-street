import type { CSSProperties } from 'react';
import { band, DROPS, dropsSvg } from '../../lib/ink';
import { Markup } from './Markup';

export interface HpProps {
  hp: number | null | undefined;
  size?: 'lg';
  /** Heartbeat pulse (margin call). */
  doki?: boolean;
  label?: string;
}

/** HP stress meter: colour and texture both carry severity; unknown HP is shown as unknown. */
export function Hp({ hp, size, doki = false, label = 'Distance to liquidation' }: HpProps) {
  const known = typeof hp === 'number' && Number.isFinite(hp);
  const v = known ? Math.min(1, Math.max(0, hp)) : 0;
  const b = band(v);
  const pct = Math.round(v * 100);
  const cls = `ws-hp${size ? ` ws-hp--${size}` : ''}${doki ? ' is-doki' : ''}`;
  const style = { '--hp': v.toFixed(3) } as CSSProperties;
  const inner = (
    <>
      <span className="ws-hp__k">HP</span>
      <span className="ws-hp__bar">
        <span className="ws-hp__fill" />
        <Markup className="ws-hp__drops" html={known ? dropsSvg(DROPS[b]) : ''} />
      </span>
      <span className="ws-hp__v">{known ? `${pct}%` : '—'}</span>
    </>
  );
  if (!known)
    return (
      <div
        className={cls}
        data-band="unknown"
        style={style}
        role="img"
        aria-label={`${label}: unknown`}
      >
        {inner}
      </div>
    );
  return (
    // biome-ignore lint/a11y/useSemanticElements: a drawn bar; the native <meter> cannot take this design
    <div
      className={cls}
      data-band={b}
      style={style}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={label}
    >
      {inner}
    </div>
  );
}
