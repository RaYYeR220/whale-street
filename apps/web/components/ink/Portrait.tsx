import { useMemo } from 'react';
import { expression, type PortraitStatus, renderPortrait } from '../../lib/portrait';
import { Markup } from './Markup';

export interface PortraitProps {
  seed: string;
  hp?: number | null;
  trend?: number | null;
  hype?: number | null;
  status?: PortraitStatus;
  size?: number;
  label?: string;
  className?: string;
}

/** The face only re-renders when its expression or an overlay flips, like the design reference. */
export function Portrait({ seed, hp, trend, hype, status, size, label, className }: PortraitProps) {
  const expr = expression(hp, status);
  const t = trend ?? 0;
  const h = hype ?? 0;
  const key = `${expr}|${t > 0.02 ? 'k' : t < -0.02 ? 'r' : ''}|${h > 0.1 ? 'a' : h < -0.1 ? 'g' : ''}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` captures every visual change of hp/trend/hype
  const html = useMemo(
    () => renderPortrait({ seed, hp, trend, hype, status, size, label }),
    [seed, key, status, size, label],
  );
  return <Markup className={className} html={html} />;
}
