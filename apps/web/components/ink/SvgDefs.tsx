import { DEFS_INNER } from '../../lib/portrait';

/** The shared hand-inked filters and halftone patterns (#ws-rough, #ws-rough-sm, #ws-rough-stamp, dots). */
export function SvgDefs() {
  return (
    <svg
      id="ws-defs"
      width="0"
      height="0"
      style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
      aria-hidden="true"
      focusable="false"
    >
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static filter definitions from lib/portrait.ts */}
      <defs dangerouslySetInnerHTML={{ __html: DEFS_INNER }} />
    </svg>
  );
}
