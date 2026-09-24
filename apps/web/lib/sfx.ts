/** One orchestrated effect at a time: a shared throttle for manga SFX across the page. */
let last = 0;

export function allowSfx(minGapMs: number, now: number = Date.now()): boolean {
  if (now - last < minGapMs) return false;
  last = now;
  return true;
}

export function resetSfxThrottle(): void {
  last = 0;
}

export function inViewport(el: Element | null): boolean {
  if (!el || typeof window === 'undefined') return false;
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight;
}
