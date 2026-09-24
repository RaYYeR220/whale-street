import type { CSSProperties } from 'react';

/**
 * Renders SVG markup produced by lib/portrait.ts and lib/ink.ts. Those builders only interpolate
 * numbers, fixed palette tokens and attribute-escaped labels, never raw user input.
 */
export function Markup({
  html,
  className,
  style,
}: {
  html: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={className}
      style={style}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: markup comes from our own escaped SVG builders
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
