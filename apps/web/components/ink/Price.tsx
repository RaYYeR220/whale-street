'use client';

import { useEffect, useRef, useState } from 'react';
import { price as fmtPrice } from '../../lib/format';

interface Flip {
  dir: 'up' | 'down';
  delta: number;
  v: number;
}

/**
 * Share price that flips on every change and floats the delta above the nearest positioned
 * ancestor, as the design reference does (reduced motion hides both via CSS).
 */
export function Price({ value }: { value: number | null | undefined }) {
  const prev = useRef(value);
  const [flip, setFlip] = useState<Flip | null>(null);
  useEffect(() => {
    const old = prev.current;
    prev.current = value;
    if (old == null || value == null || !Number.isFinite(old) || !Number.isFinite(value)) return;
    if (old === value) return;
    setFlip((f) => ({ dir: value >= old ? 'up' : 'down', delta: value - old, v: (f?.v ?? 0) + 1 }));
  }, [value]);
  useEffect(() => {
    if (!flip || flip.delta === 0) return;
    const id = setTimeout(
      () => setFlip((f) => (f && f.v === flip.v ? { ...f, delta: 0 } : f)),
      1_000,
    );
    return () => clearTimeout(id);
  }, [flip]);
  const d = flip?.delta ?? 0;
  return (
    <>
      <span key={flip?.v ?? 0} className={`ws-price ws-num${flip ? ` is-${flip.dir}` : ''}`}>
        {fmtPrice(value)}
      </span>
      {Math.abs(d) >= 0.01 ? (
        <span
          key={`t${flip?.v ?? 0}`}
          className={`ws-tick ${d >= 0 ? 'ws-v-up' : 'ws-v-down'}`}
          aria-hidden="true"
        >
          {d >= 0 ? '+' : '−'}
          {Math.abs(d).toFixed(2)}
        </span>
      ) : null}
    </>
  );
}
