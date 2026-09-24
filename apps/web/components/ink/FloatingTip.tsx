'use client';

import { type ReactNode, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/** Fixed-position tooltip beside a pointer x, above `top` (or below `bottom` when there is no room). */
export function FloatingTip({
  x,
  top,
  bottom,
  children,
}: {
  x: number;
  top: number;
  bottom: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    let tx = x + 14;
    let ty = top - th - 8;
    if (tx + tw > window.innerWidth - 8) tx = x - tw - 14;
    if (tx < 8) tx = 8;
    if (ty < 8) ty = bottom + 8;
    el.style.transform = `translate(${tx}px, ${ty}px)`;
  });
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div ref={ref} className="ws-tip" role="presentation">
      {children}
    </div>,
    document.body,
  );
}
