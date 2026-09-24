'use client';

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useReducedMotion } from './motion';

export interface SfxOptions {
  text: string;
  kana?: string;
  tone?: 'pink' | 'blue' | 'ink' | 'red';
  small?: boolean;
  burst?: boolean;
  x?: string;
  y?: string;
  ms?: number;
}

/** One-shot manga sound effect inside a positioned host. Skipped entirely under reduced motion. */
export function useSfx(): { node: ReactNode; fire: (o: SfxOptions) => void } {
  const reduce = useReducedMotion();
  const [sfx, setSfx] = useState<(SfxOptions & { key: number }) | null>(null);
  const seq = useRef(0);
  const fire = useCallback(
    (o: SfxOptions) => {
      if (reduce) return;
      seq.current += 1;
      const key = seq.current;
      setSfx((cur) => cur ?? { ...o, key });
    },
    [reduce],
  );
  useEffect(() => {
    if (!sfx) return;
    const id = setTimeout(() => setSfx(null), sfx.ms ?? 1_500);
    return () => clearTimeout(id);
  }, [sfx]);
  const node = sfx ? (
    <span
      key={sfx.key}
      className={`ws-sfx ws-sfx--${sfx.tone ?? 'pink'}${sfx.small ? ' ws-sfx--sm' : ''}${sfx.burst ? ' ws-sfx--burst' : ''}`}
      aria-hidden="true"
      style={{ left: sfx.x, top: sfx.y }}
    >
      <span className="ws-sfx__t">{sfx.text}</span>
      {sfx.kana ? <span className="ws-sfx__k">{sfx.kana}</span> : null}
    </span>
  ) : null;
  return { node, fire };
}
