/**
 * Deterministic salaryman portraits. Same seed (company address or player handle) → same face;
 * the expression follows HP, the overlays follow the NAV trend and the hype premium.
 * Output is an SVG string so the same markup serves the page (inline) and OG images (data URI).
 */

export type PortraitStatus = 'active' | 'ipo' | 'halted' | 'bankrupt';
export type Expression = 'calm' | 'tense' | 'panic' | 'meltdown' | 'bankrupt' | 'halted';

export interface PortraitOptions {
  seed: string;
  /** Distance to liquidation, 0..1. Null or NaN when unknown. */
  hp?: number | null;
  /** NAV change over 1 h as a fraction. */
  trend?: number | null;
  /** price / NAV - 1. */
  hype?: number | null;
  status?: PortraitStatus;
  size?: number;
  label?: string;
  /** Self-contained SVG (hex colours, embedded filters, xmlns) for data URIs and OG images. */
  standalone?: boolean;
}

export interface Traits {
  face: 'round' | 'square' | 'long';
  hair: 'side' | 'spiky' | 'slick' | 'bowl' | 'combover' | 'pompadour' | 'buzz' | 'curly' | 'bob';
  hairTone: 'ink' | 'blue';
  glasses: 'none' | 'round' | 'square' | 'reading' | 'shades';
  accessory: 'none' | 'headband' | 'earpiece' | 'phone' | 'coffee' | 'calculator' | 'pencil';
  tie: 'pink' | 'blue' | 'ink';
  jacket: 'ink' | 'blue' | 'pinstripe';
  facial: 'none' | 'moustache' | 'stubble';
}

const INK = 'var(--ws-ink,#1a1714)';
const PAPER = 'var(--ws-paper,#f3eee2)';
const PANEL = 'var(--ws-panel,#e4dccb)';
const PINK = 'var(--ws-pink,#ff48b0)';
const BLUE = 'var(--ws-blue,#0078bf)';
const MINT = 'var(--ws-mint,#00a86b)';
const RED = 'var(--ws-red,#d8342c)';

export function hash(input: string): number {
  const s = String(input);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, arr: readonly T[]): T => arr[Math.floor(r() * arr.length)] as T;

/** Shared filters and halftone patterns referenced by ws.css and every portrait (ids are global). */
export const DEFS_INNER =
  '<filter id="ws-rough" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="0.02 0.06" numOctaves="2" seed="7" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="6"/></filter>' +
  '<filter id="ws-rough-sm" x="-20%" y="-20%" width="140%" height="140%"><feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="2" seed="3" result="n2"/><feDisplacementMap in="SourceGraphic" in2="n2" scale="2.4"/></filter>' +
  '<filter id="ws-rough-stamp" x="-20%" y="-20%" width="140%" height="140%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="1" seed="11" result="speck"/><feColorMatrix in="speck" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -6 4.1" result="holes"/><feComposite in="SourceGraphic" in2="holes" operator="in" result="inked"/><feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="5" result="n3"/><feDisplacementMap in="inked" in2="n3" scale="3"/></filter>' +
  '<pattern id="ws-dots-ink" width="3.2" height="3.2" patternUnits="userSpaceOnUse"><circle cx="1.6" cy="1.6" r="0.75" fill="#1a1714"/></pattern>' +
  '<pattern id="ws-dots-blue" width="3.4" height="3.4" patternUnits="userSpaceOnUse" patternTransform="rotate(15)"><circle cx="1.7" cy="1.7" r="0.95" fill="#0078bf"/></pattern>' +
  '<pattern id="ws-dots-pink" width="3.4" height="3.4" patternUnits="userSpaceOnUse" patternTransform="rotate(75)"><circle cx="1.7" cy="1.7" r="0.95" fill="#ff48b0"/></pattern>' +
  '<pattern id="ws-dots-red" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><circle cx="1.5" cy="1.5" r="0.9" fill="#d8342c"/></pattern>' +
  '<pattern id="ws-pinstripe" width="4.5" height="10" patternUnits="userSpaceOnUse"><rect width="4.5" height="10" fill="#d9cfbb"/><line x1="1" y1="0" x2="1" y2="10" stroke="#1a1714" stroke-width="0.7" opacity="0.55"/></pattern>';

export const catalog = {
  face: ['round', 'square', 'long'],
  hair: ['side', 'spiky', 'slick', 'bowl', 'combover', 'pompadour', 'buzz', 'curly', 'bob'],
  hairTone: ['ink', 'ink', 'ink', 'blue'],
  glasses: ['none', 'none', 'round', 'square', 'reading', 'shades'],
  accessory: ['none', 'headband', 'earpiece', 'phone', 'coffee', 'calculator', 'pencil'],
  tie: ['pink', 'blue', 'ink'],
  jacket: ['ink', 'blue', 'pinstripe'],
  facial: ['none', 'none', 'moustache', 'stubble'],
} as const satisfies { [K in keyof Traits]: readonly Traits[K][] };

export function traits(seed: string): Traits {
  const r = rng(hash(seed));
  const t: Traits = {
    face: pick(r, catalog.face),
    hair: pick(r, catalog.hair),
    hairTone: pick(r, catalog.hairTone),
    glasses: pick(r, catalog.glasses),
    accessory: pick(r, catalog.accessory),
    tie: pick(r, catalog.tie),
    jacket: pick(r, catalog.jacket),
    facial: pick(r, catalog.facial),
  };
  if (t.glasses === 'shades' && t.accessory === 'headband') t.glasses = 'round';
  if (t.hair === 'bob' && (t.accessory === 'earpiece' || t.accessory === 'pencil')) t.hair = 'side';
  return t;
}

export function expression(hp: number | null | undefined, status?: PortraitStatus): Expression {
  if (status === 'bankrupt') return 'bankrupt';
  if (status === 'halted') return 'halted';
  if (hp == null || Number.isNaN(hp)) return 'tense';
  if (hp >= 0.6) return 'calm';
  if (hp >= 0.3) return 'tense';
  if (hp >= 0.15) return 'panic';
  return 'meltdown';
}

const FACE = {
  round: { d: 'M36 50 A24 26 0 1 0 84 50 A24 26 0 1 0 36 50 Z', l: 36, r: 84 },
  square: {
    d: 'M36 46 C36 29 46 24 60 24 C74 24 84 29 84 46 L84 57 C84 70 74 77 60 77 C46 77 36 70 36 57 Z',
    l: 36,
    r: 84,
  },
  long: { d: 'M39 50 A21 28 0 1 0 81 50 A21 28 0 1 0 39 50 Z', l: 39, r: 81 },
} as const;

const HAIR: Record<Traits['hair'], (c: string) => string> = {
  side: (c) =>
    `<path d="M34 50 C30 26 46 18 62 19 C80 20 88 32 86 50 C82 38 76 32 66 31 C58 36 46 34 40 30 C37 36 35 42 34 50 Z" fill="${c}"/>`,
  spiky: (c) =>
    `<path d="M34 48 L29 31 L40 34 L37 18 L49 27 L54 11 L62 26 L72 13 L72 28 L87 21 L82 34 L91 38 L85 48 C80 36 70 32 60 33 C50 32 40 37 34 48 Z" fill="${c}"/>`,
  slick: (c) =>
    `<path d="M35 44 C34 24 48 19 60 19 C74 19 86 25 85 44 C80 32 72 28 60 28 C48 28 40 32 35 44 Z" fill="${c}"/><path d="M47 23 Q58 19.5 70 22.5" stroke="${PAPER}" stroke-width="1.6" fill="none" stroke-linecap="round" opacity="0.8"/>`,
  bowl: (c) =>
    `<path d="M34 45 C33 24 46 18 60 18 C74 18 87 24 86 45 L86 39.5 Q60 37 34 39.5 Z" fill="${c}"/>`,
  combover: (c) =>
    `<path d="M34.5 52 C33 42 35.5 37 38.5 35 L40.5 49 Z M85.5 52 C87 42 84.5 37 81.5 35 L79.5 49 Z" fill="${c}"/><path d="M39 33 Q60 20 81 31 M40 29 Q60 18 78 26 M42 37 Q62 24 83 35" stroke="${c}" stroke-width="2" fill="none" stroke-linecap="round"/>`,
  pompadour: (c) =>
    `<path d="M34 46 C32 30 40 22 50 20 C48 11 62 5 76 11 C83 14 85 18 80 21 C86 25 88 34 86 46 C82 36 74 30 60 30 C48 30 38 36 34 46 Z" fill="${c}"/><path d="M56 13 Q66 9 74 13" stroke="${PAPER}" stroke-width="1.4" fill="none" opacity="0.8"/>`,
  buzz: (c) =>
    `<path d="M36 44 C35 26 46 22 60 22 C74 22 85 26 84 44 C78 34 70 31 60 31 C50 31 42 34 36 44 Z" fill="url(#ws-dots-ink)" stroke="${c}" stroke-width="1.2"/>`,
  curly: (c) =>
    `<g fill="${c}"><circle cx="37" cy="41" r="6.5"/><circle cx="41" cy="31" r="8"/><circle cx="51" cy="24" r="8.5"/><circle cx="63" cy="21.5" r="8.5"/><circle cx="75" cy="25" r="8.5"/><circle cx="83" cy="34" r="7.5"/><circle cx="85" cy="43" r="5.5"/><circle cx="60" cy="30" r="9"/></g>`,
  bob: (c) =>
    `<path d="M33 62 C27 30 42 17 60 17 C78 17 93 30 87 62 L81 62 C84 45 78 33 62 30 L60 34 L58 30 C42 33 36 45 39 62 Z" fill="${c}"/>`,
};

const BROWS: Record<Expression, [string, string]> = {
  calm: ['M44 41 Q50 37 56 40', 'M64 40 Q70 37 76 41'],
  tense: ['M44 39.5 L56 43', 'M64 43 L76 39.5'],
  panic: ['M44 41.5 L56 36.5', 'M64 36.5 L76 41.5'],
  meltdown: ['M44 40 Q50 32 56 35', 'M64 35 Q70 32 76 40'],
  bankrupt: ['M45 42.5 L55 42.5', 'M65 42.5 L75 42.5'],
  halted: ['M45 42 Q50 40 55 42', 'M65 42 Q70 40 75 42'],
};

function spiral(cx: number, cy: number): string {
  let d = '';
  for (let i = 0; i <= 42; i++) {
    const a = i * 0.45;
    const rr = 0.4 + i * 0.12;
    d += `${i ? ' L' : 'M'}${(cx + Math.cos(a) * rr).toFixed(2)} ${(cy + Math.sin(a) * rr).toFixed(2)}`;
  }
  return `<path d="${d}" stroke="${INK}" stroke-width="1.4" fill="none" stroke-linecap="round"/>`;
}

function eyes(expr: Expression): string {
  const L = 50;
  const R = 70;
  const Y = 50;
  switch (expr) {
    case 'calm':
      return (
        `<circle cx="${L}" cy="${Y}" r="2.7" fill="${INK}"/><circle cx="${R}" cy="${Y}" r="2.7" fill="${INK}"/>` +
        `<path d="M46.5 54.2 Q50 55.8 53.5 54.2 M66.5 54.2 Q70 55.8 73.5 54.2" stroke="${INK}" stroke-width="1.2" fill="none" stroke-linecap="round"/>`
      );
    case 'tense':
      return (
        `<circle cx="${L}" cy="${Y + 0.6}" r="2.4" fill="${INK}"/><circle cx="${R}" cy="${Y + 0.6}" r="2.4" fill="${INK}"/>` +
        `<path d="M45.5 47.6 L54.5 48.6 M65.5 48.6 L74.5 47.6" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/>`
      );
    case 'panic':
      return (
        `<circle cx="${L}" cy="${Y}" r="5.2" fill="${PAPER}" stroke="${INK}" stroke-width="1.7"/><circle cx="${R}" cy="${Y}" r="5.2" fill="${PAPER}" stroke="${INK}" stroke-width="1.7"/>` +
        `<circle cx="${L + 0.6}" cy="${Y + 0.4}" r="1.35" fill="${INK}"/><circle cx="${R - 0.6}" cy="${Y + 0.4}" r="1.35" fill="${INK}"/>`
      );
    case 'meltdown':
      return `<circle cx="${L}" cy="${Y}" r="5.6" fill="${PAPER}"/><circle cx="${R}" cy="${Y}" r="5.6" fill="${PAPER}"/>${spiral(L, Y)}${spiral(R, Y)}`;
    case 'bankrupt':
      return `<path d="M46.5 46.5 L53.5 53.5 M53.5 46.5 L46.5 53.5 M66.5 46.5 L73.5 53.5 M73.5 46.5 L66.5 53.5" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>`;
    case 'halted':
      return `<path d="M45.5 50 Q50 53.5 54.5 50 M65.5 50 Q70 53.5 74.5 50" stroke="${INK}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
  }
}

function mouth(expr: Expression): string {
  switch (expr) {
    case 'calm':
      return `<path d="M48.5 62.5 Q60 75 71.5 62.5 Q60 66.5 48.5 62.5 Z" fill="${INK}"/><path d="M50.8 63.6 Q60 66.7 69.2 63.6 L68.2 65.4 Q60 68.2 51.8 65.4 Z" fill="${PAPER}"/>`;
    case 'tense':
      return `<path d="M51 66 Q54 63.8 57 66 T63 66 T69 66" stroke="${INK}" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    case 'panic':
      return (
        `<path d="M50 62 Q60 60.5 70 62 L69 70.5 Q60 72 51 70.5 Z" fill="${PAPER}" stroke="${INK}" stroke-width="1.9" stroke-linejoin="round"/>` +
        `<path d="M50.6 66.2 L69.4 66.2 M55 61.5 L55 71 M60 61 L60 71.5 M65 61.5 L65 71" stroke="${INK}" stroke-width="1.1"/>`
      );
    case 'meltdown':
      return `<path d="M49.5 60.5 Q60 56.5 70.5 60.5 Q72 75 60 77 Q48 75 49.5 60.5 Z" fill="${INK}"/><path d="M53.5 72.5 Q60 68 66.5 72.5 Q60 76.5 53.5 72.5 Z" fill="${PINK}"/>`;
    case 'bankrupt':
      return `<path d="M52 67.5 L55.5 65 L59 67.5 L62.5 65 L66 67.5 L68.5 66" stroke="${INK}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    case 'halted':
      return `<ellipse cx="60" cy="66.5" rx="2.2" ry="2.6" fill="none" stroke="${INK}" stroke-width="1.7"/>`;
  }
}

function drop(x: number, y: number, scale?: number): string {
  const s = scale || 1;
  return (
    `<path d="M${x} ${y - 5 * s} Q${x + 4.2 * s} ${y + 1.5 * s} ${x} ${y + 5.5 * s} Q${x - 4.2 * s} ${y + 1.5 * s} ${x} ${y - 5 * s} Z" fill="${BLUE}" stroke="${INK}" stroke-width="0.9"/>` +
    `<ellipse cx="${x - 1.2 * s}" cy="${y + 1.6 * s}" rx="${0.9 * s}" ry="${1.5 * s}" fill="${PAPER}" opacity="0.85"/>`
  );
}

function glasses(kind: Traits['glasses']): string {
  const st = `stroke="${INK}" stroke-width="2" fill="none" stroke-linecap="round"`;
  switch (kind) {
    case 'round':
      return `<g ${st}><circle cx="50" cy="50" r="6.9"/><circle cx="70" cy="50" r="6.9"/><path d="M56.9 49 Q60 47 63.1 49 M43.1 49 L37 47 M76.9 49 L83 47"/></g>`;
    case 'square':
      return `<g ${st}><rect x="42.3" y="44.6" width="15.4" height="11" rx="2"/><rect x="62.3" y="44.6" width="15.4" height="11" rx="2"/><path d="M57.7 48.6 L62.3 48.6 M42.3 48 L36.5 46.5 M77.7 48 L83.5 46.5"/></g>`;
    case 'reading':
      return `<g ${st}><path d="M43.5 52.2 L56.5 52.2 Q56 59.2 50 59.2 Q44 59.2 43.5 52.2 Z M63.5 52.2 L76.5 52.2 Q76 59.2 70 59.2 Q64 59.2 63.5 52.2 Z M56.5 53 L63.5 53"/></g>`;
    case 'shades':
      return (
        `<path d="M42 28.5 L57 28.5 Q57 35.5 50 35.5 Q43 35.5 42 28.5 Z M63 28.5 L78 28.5 Q78 35.5 71 35.5 Q63 35.5 63 28.5 Z" fill="${INK}"/>` +
        `<path d="M57 29.4 L63 29.4" stroke="${INK}" stroke-width="1.8"/><path d="M45 30.8 L48.5 30.8 M66 30.8 L69.5 30.8" stroke="${PAPER}" stroke-width="1.2" stroke-linecap="round"/>`
      );
    case 'none':
      return '';
  }
}

function jacketFill(tone: Traits['jacket']): string {
  if (tone === 'ink') return INK;
  if (tone === 'blue') return BLUE;
  return 'url(#ws-pinstripe)';
}

function body(t: Traits, expr: Expression): string {
  const J = 'M8 120 C10 101 24 91 45 86 L75 86 C96 91 110 101 112 120 Z';
  let s = '';
  // jacket: riso misregistration, the colour plate shifted about 1px from the key line
  if (t.jacket === 'blue')
    s += `<path d="${J}" fill="${BLUE}" transform="translate(1.3 0.9)"/><path d="${J}" fill="none" stroke="${INK}" stroke-width="2.6" filter="url(#ws-rough-sm)"/>`;
  else if (t.jacket === 'ink')
    s += `<path d="${J}" fill="${INK}" stroke="${INK}" stroke-width="2.6" filter="url(#ws-rough-sm)"/><path d="M45 87 L53.5 105 M75 87 L66.5 105" stroke="${PAPER}" stroke-width="1.3" opacity="0.7"/>`;
  else
    s += `<path d="${J}" fill="url(#ws-pinstripe)" stroke="${INK}" stroke-width="2.6" filter="url(#ws-rough-sm)"/>`;
  s += `<path d="M45 86 L60 108 L75 86 Z" fill="${PAPER}" stroke="${INK}" stroke-width="2"/>`;
  const tieFill = t.tie === 'pink' ? PINK : t.tie === 'blue' ? BLUE : INK;
  const knot = 'M56.5 89.5 L63.5 89.5 L62.2 95.5 L57.8 95.5 Z';
  const blade = 'M57.8 95.5 L62.2 95.5 L66 111 L60 118 L54 111 Z';
  const rot = expr === 'bankrupt' ? ' transform="rotate(16 60 93) translate(0 3)"' : '';
  s += `<g${rot}>`;
  if (t.tie === 'ink') s += `<path d="${knot} ${blade}" fill="${INK}"/>`;
  else
    s += `<path d="${knot} ${blade}" fill="${tieFill}" transform="translate(1 0.7)"/><path d="${knot} ${blade}" fill="none" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>`;
  s += '</g>';
  s += `<path d="M45 85 L59 90 L52 98 Z M75 85 L61 90 L68 98 Z" fill="${PAPER}" stroke="${INK}" stroke-width="1.8" stroke-linejoin="round"/>`;
  return s;
}

const hairColor = (t: Traits): string => (t.hairTone === 'blue' ? BLUE : INK);

function accessoryBack(t: Traits): string {
  if (t.accessory === 'phone') {
    const sleeve = jacketFill(t.jacket);
    return `<path d="M14 120 C14 104 19 90 27 79 L38 84 C32 94 30 106 32 120 Z" fill="${sleeve}" stroke="${INK}" stroke-width="2.2"/>`;
  }
  return '';
}

function accessoryFront(t: Traits): string {
  switch (t.accessory) {
    case 'headband':
      return (
        `<path d="M34.5 35.5 Q60 26.5 85.5 35.5 L86 41.5 Q60 32.5 34 41.5 Z" fill="${PAPER}" stroke="${INK}" stroke-width="1.8" stroke-linejoin="round"/>` +
        `<circle cx="60" cy="34.2" r="3.3" fill="${PINK}"/>` +
        `<path d="M85.5 36.5 L97.5 30.5 L96 37 Z M85.5 39.5 L96.5 45.5 L91 46 Z" fill="${PAPER}" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>`
      );
    case 'earpiece':
      return (
        `<path d="M84.5 47.5 C89.5 46.5 90.5 55.5 85.5 56.5 Z" fill="${INK}"/>` +
        `<path d="M87 56.5 C91 58.5 83 61 87 63 C91 65 83 67.5 87 69.5 C91 71.5 83 74 87 76 L86 86" stroke="${INK}" stroke-width="1.2" fill="none" stroke-linecap="round"/>`
      );
    case 'phone':
      return (
        `<g transform="rotate(-12 31 56)"><rect x="26.5" y="42" width="9.5" height="25" rx="2.2" fill="${INK}"/><path d="M29 45 L29 51" stroke="${PAPER}" stroke-width="1" stroke-linecap="round"/></g>` +
        `<path d="M27 83 C21.5 81 21.5 70 26 65.5 C29 62.5 34.5 63.5 35.5 68 L36.5 80 C34.5 84.5 30.5 84.5 27 83 Z" fill="${PAPER}" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>`
      );
    case 'coffee':
      return (
        `<path d="M85 83 q-3 -4 0 -8 q3 -4 0 -8 M92 83 q-3 -4 0 -8" stroke="${INK}" stroke-width="1.3" fill="none" stroke-linecap="round" opacity="0.7"/>` +
        `<path d="M80 92 L98 92 L96 116 L82 116 Z" fill="${PAPER}" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>` +
        `<path d="M78.5 88 L99.5 88 L99.5 92 L78.5 92 Z" fill="${INK}"/>` +
        `<path d="M81.2 99 L96.8 99 L96.2 107 L81.8 107 Z" fill="${PINK}"/>` +
        `<path d="M75.5 104 C72 98 76 94 81 96 L82 110 C78 112.5 76 108 75.5 104 Z" fill="${PAPER}" stroke="${INK}" stroke-width="1.8" stroke-linejoin="round"/>`
      );
    case 'calculator':
      return (
        `<path d="M15 93 L42 88.5 L45.5 116 L18.5 120.5 Z" fill="${PANEL}" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>` +
        `<path d="M18.8 95.5 L39.3 92 L40.2 98 L19.7 101.5 Z" fill="${MINT}" stroke="${INK}" stroke-width="1"/>` +
        `<g fill="${INK}"><circle cx="23.5" cy="107" r="1.7"/><circle cx="30.5" cy="106" r="1.7"/><circle cx="37.5" cy="105" r="1.7"/><circle cx="24.5" cy="113.5" r="1.7"/><circle cx="31.5" cy="112.5" r="1.7"/><circle cx="38.5" cy="111.5" r="1.7"/></g>` +
        `<path d="M42.5 99.5 C48.5 97.5 50.5 106 46.5 110 L43.5 110.5 Z" fill="${PAPER}" stroke="${INK}" stroke-width="1.8" stroke-linejoin="round"/>`
      );
    case 'pencil':
      return (
        `<path d="M76 38 L96 26 L98.5 29.5 L78.5 41.5 Z" fill="${PINK}" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>` +
        `<path d="M96 26 L102.2 23.4 L98.5 29.5 Z" fill="${PAPER}" stroke="${INK}" stroke-width="1.2" stroke-linejoin="round"/><path d="M100.9 24 L102.2 23.4 L101.6 24.9 Z" fill="${INK}"/>`
      );
    case 'none':
      return '';
  }
}

function facial(kind: Traits['facial']): string {
  if (kind === 'moustache')
    return `<path d="M51 60.5 Q55.5 57 60 59.6 Q64.5 57 69 60.5 Q64.5 62.6 60 61 Q55.5 62.6 51 60.5 Z" fill="${INK}"/>`;
  if (kind === 'stubble') {
    const pts: Array<[number, number]> = [
      [45, 67],
      [48, 70.5],
      [52, 72.8],
      [56, 74],
      [60, 74.4],
      [64, 74],
      [68, 72.8],
      [72, 70.5],
      [75, 67],
      [50, 75.5],
      [70, 75.5],
      [58, 77],
      [62, 77],
    ];
    return `<g fill="${INK}" opacity="0.6">${pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="0.7"/>`).join('')}</g>`;
  }
  return '';
}

function aura(): string {
  let s = '<circle cx="60" cy="52" r="46" fill="url(#ws-dots-pink)" opacity="0.55"/>';
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + (i % 2 ? 0.05 : -0.04);
    const r1 = 42 + (i % 3) * 3;
    const r2 = 54 + (i % 4) * 3;
    s += `<line x1="${(60 + Math.cos(a) * r1).toFixed(1)}" y1="${(52 + Math.sin(a) * r1).toFixed(1)}" x2="${(60 + Math.cos(a) * r2).toFixed(1)}" y2="${(52 + Math.sin(a) * r2).toFixed(1)}" stroke="${PINK}" stroke-width="${i % 2 ? 1.2 : 2.4}" stroke-linecap="round"/>`;
  }
  return s;
}

function gloom(r: () => number): string {
  let s = '';
  for (let x = 4; x < 120; x += 4.6) {
    const len = 24 + r() * 46;
    s += `<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${len.toFixed(1)}" stroke="${BLUE}" stroke-width="${r() > 0.5 ? 1.4 : 0.9}" opacity="0.85"/>`;
  }
  return s;
}

function star(cx: number, cy: number, rr: number): string {
  return `<path d="M${cx} ${cy - rr} Q${cx} ${cy} ${cx + rr} ${cy} Q${cx} ${cy} ${cx} ${cy + rr} Q${cx} ${cy} ${cx - rr} ${cy} Q${cx} ${cy} ${cx} ${cy - rr} Z" fill="${MINT}" stroke="${INK}" stroke-width="0.9" stroke-linejoin="round"/>`;
}

function sparkle(big: boolean): string {
  return (
    star(101, 22, 8.5) +
    star(91, 8, 4.8) +
    star(110, 39, 4.6) +
    (big
      ? `<text x="88" y="66" transform="rotate(-14 88 66)" font-family="'Dela Gothic One',sans-serif" font-size="8.5" fill="${INK}" stroke="${PAPER}" stroke-width="2.4" paint-order="stroke">KIRA</text>`
      : '')
  );
}

function rain(): string {
  return (
    `<path d="M11 21 C6 21 6 13.5 12 12.5 C12 6 20.5 4 24 8.5 C27 2 37.5 3 38.5 10 C45 9 47 18 41.5 21 Z" fill="${PAPER}" stroke="${INK}" stroke-width="1.8" stroke-linejoin="round"/>` +
    `<path d="M14 25 L12 31 M22 25 L20 31 M30 25 L28 31 M38 25 L36 31 M18 33 L16 39 M26 33 L24 39 M34 33 L32 39" stroke="${BLUE}" stroke-width="1.7" stroke-linecap="round"/>`
  );
}

function bell(): string {
  const b = 'M9 27 C9 17 13.5 12 19.5 12 C25.5 12 30 17 30 27 L33 30 L6 30 Z';
  return (
    `<path d="${b}" fill="${PINK}" transform="translate(1 0.8)"/><path d="${b}" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linejoin="round"/>` +
    `<circle cx="19.5" cy="10.2" r="2" fill="none" stroke="${INK}" stroke-width="1.5"/><circle cx="19.5" cy="32.2" r="2.5" fill="${INK}"/>` +
    `<path d="M4 15 L1 12 M35 15 L38 12 M3 21 L0 21 M36 21 L39 21" stroke="${INK}" stroke-width="1.4" stroke-linecap="round"/>`
  );
}

function fx(expr: Expression, faceL: number, faceR: number): string {
  let s = '';
  if (expr === 'tense') s += drop(faceR + 3, 36);
  if (expr === 'panic' || expr === 'meltdown') {
    s += `<path d="M27 34 Q23 42 27 50 M21 32 Q16 42 21 52 M93 34 Q97 42 93 50 M99 32 Q104 42 99 52" stroke="${INK}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`;
    s += `<path d="M48 30 L48 38 M52 29 L52 37.5 M56 28.5 L56 37 M60 28.5 L60 37 M64 28.5 L64 37 M68 29 L68 37.5 M72 30 L72 38" stroke="${BLUE}" stroke-width="1.3" stroke-linecap="round" opacity="0.9"/>`;
  }
  if (expr === 'panic')
    s += drop(faceR + 3, 34) + drop(faceL - 3, 39, 0.85) + drop(faceR + 5, 58, 0.8);
  if (expr === 'meltdown') {
    s +=
      `<path d="M${faceR + 2} 30 L${faceR + 2} 44 M${faceL - 2} 36 L${faceL - 2} 48" stroke="${BLUE}" stroke-width="1.4" stroke-linecap="round"/>` +
      drop(faceR + 2, 48, 1.1) +
      drop(faceL - 2, 52, 0.95) +
      drop(faceR + 6, 64, 0.8) +
      drop(45, 80, 0.7);
    s += `<path d="M40 16 q-3 -3 0 -6 q3 -3 0 -6 M80 14 q-3 -3 0 -6 q3 -3 0 -6 M60 9 q-3 -3 0 -5" stroke="${INK}" stroke-width="1.4" fill="none" stroke-linecap="round"/>`;
  }
  if (expr === 'bankrupt') {
    s +=
      `<path d="M66 64 C78 58 74 42 84 30" stroke="${INK}" stroke-width="1.1" fill="none" stroke-dasharray="2 2.4"/>` +
      `<path d="M80 28 C78 17 82 8 89 8 C96 8 100 17 98 28 L95 25 L92 29 L89 25 L86 29 L83 25 Z" fill="${PAPER}" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>` +
      `<circle cx="86.5" cy="16" r="1.1" fill="${INK}"/><circle cx="92" cy="16" r="1.1" fill="${INK}"/>`;
  }
  if (expr === 'halted') {
    s +=
      `<circle cx="66.5" cy="61" r="5" fill="${PAPER}" fill-opacity="0.6" stroke="${BLUE}" stroke-width="1.2"/><path d="M64.5 58.8 Q65.5 57.8 66.8 58" stroke="${BLUE}" stroke-width="0.9" fill="none"/>` +
      `<g font-family="'Dela Gothic One',sans-serif" fill="${INK}" stroke="${PAPER}" stroke-width="2.2" paint-order="stroke"><text x="88" y="30" font-size="15">Z</text><text x="100" y="17" font-size="10.5">z</text><text x="107" y="8" font-size="7.5">z</text></g>`;
  }
  return s;
}

const EXPR_TEXT: Record<Expression, string> = {
  calm: 'calm, confident grin',
  tense: 'tense, furrowed brow and one sweat drop',
  panic: 'panicking, sweating and shaking',
  meltdown: 'in meltdown, spiral eyes and dripping sweat',
  bankrupt: 'bankrupt, X-eyes, soul leaving',
  halted: 'asleep, data halted',
};

/** Plain-language alt text for a portrait. */
export function describe(o: Omit<PortraitOptions, 'seed'>): string {
  const expr = expression(o.hp, o.status);
  const bits = [`CEO ${EXPR_TEXT[expr]}`];
  if (expr !== 'bankrupt' && expr !== 'halted') {
    if ((o.trend ?? 0) > 0.02) bits.push('sparkles: NAV rising this hour');
    if ((o.trend ?? 0) < -0.02) bits.push('rain cloud: NAV falling this hour');
    if ((o.hype ?? 0) > 0.1) bits.push('pink speed lines: priced far above NAV');
    if ((o.hype ?? 0) < -0.1) bits.push('blue gloom: priced far below NAV');
  }
  if (o.status === 'ipo') bits.push('IPO bell ringing');
  return bits.join('; ');
}

const escapeAttr = (s: string): string =>
  s.replace(
    /[&<>"]/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch,
  );

/** Replaces every `var(--ws-x,#hex)` with its hex fallback (for renderers without CSS). */
export const inlineInks = (svg: string): string =>
  svg.replace(/var\(--ws-[a-z0-9-]+,(#[0-9a-fA-F]{3,8})\)/g, '$1');

export function renderPortrait(o: PortraitOptions): string {
  const seed = o.seed || 'anon';
  const size = o.size || 96;
  const status = o.status || 'active';
  const expr = expression(o.hp, status);
  const t = traits(seed);
  const r = rng(hash(`${seed}#fx`));
  const f = FACE[t.face];
  const hc = hairColor(t);
  const live = expr !== 'bankrupt' && expr !== 'halted';
  const trend = o.trend ?? 0;
  const hype = o.hype ?? 0;

  let bg = '';
  if (live && hype > 0.1) bg = aura();
  else if (live && hype < -0.1) bg = gloom(r);

  const earL = f.l;
  const earR = f.r;
  let head = '';
  head += `<path d="M51 66 L51 88 L69 88 L69 66 Z" fill="${PAPER}" stroke="${INK}" stroke-width="2.2"/>`;
  head += `<path d="M51 71 Q60 80 69 71 L69 76 Q60 84 51 76 Z" fill="${INK}" opacity="0.14"/>`;
  head += `<circle cx="${earL}" cy="52" r="5.5" fill="${PAPER}" stroke="${INK}" stroke-width="2"/><circle cx="${earR}" cy="52" r="5.5" fill="${PAPER}" stroke="${INK}" stroke-width="2"/>`;
  head += `<path d="${f.d}" fill="${PAPER}" stroke="${INK}" stroke-width="2.7" filter="url(#ws-rough-sm)"/>`;
  head += `<path d="M${f.r - 4} 34 Q${f.r + 4} 52 ${f.r - 6} 70 Q${f.r - 1} 52 ${f.r - 4} 34 Z" fill="${INK}" opacity="0.12"/>`;
  if (expr === 'meltdown') {
    head += `<path d="${f.d}" fill="url(#ws-dots-red)" opacity="0.75"/>`;
    head += `<path d="M41 60 l4 -4 M44 61.5 l4 -4 M47 62.5 l4 -4 M69 62.5 l4 -4 M72 61.5 l4 -4 M75 60 l4 -4" stroke="${RED}" stroke-width="1.3" stroke-linecap="round"/>`;
  }
  head += HAIR[t.hair](hc);
  const [bl, br] = BROWS[expr];
  head += `<path d="${bl} M${br.slice(1)}" stroke="${INK}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
  if (expr === 'tense')
    head += `<path d="M59 39.5 L59.4 44 M61 39.5 L60.6 44" stroke="${INK}" stroke-width="1" stroke-linecap="round"/>`;
  head += eyes(expr);
  head += `<path d="M60.5 52 Q56.8 58 61 59" stroke="${INK}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`;
  head += facial(t.facial);
  head += mouth(expr);
  head += glasses(t.glasses);

  const tilt = expr === 'halted' ? ' transform="rotate(-8 60 86)"' : '';
  let overlay = fx(expr, earL, earR);
  if (live && trend > 0.02) overlay += sparkle(size >= 110);
  if (live && trend < -0.02 && status !== 'ipo') overlay += rain();
  if (status === 'ipo') overlay += bell();

  const label = o.label ?? describe(o);
  const grey =
    expr === 'bankrupt' ? ' style="filter:grayscale(1) contrast(.8) brightness(1.08)"' : '';
  const front = accessoryFront(t);
  const heldProp = t.accessory === 'coffee' || t.accessory === 'calculator';
  const ns = o.standalone ? ' xmlns="http://www.w3.org/2000/svg"' : '';
  const defs = o.standalone ? `<defs>${DEFS_INNER}</defs>` : '';
  const svg =
    `<svg${ns} class="ws-portrait wsp--${expr}" viewBox="0 0 120 120" width="${size}" height="${size}" role="img" aria-label="${escapeAttr(label)}"${grey}>` +
    defs +
    `<g class="wsp-bg">${bg}</g>` +
    `<g class="wsp-body">${accessoryBack(t)}${body(t, expr)}</g>` +
    `<g class="wsp-head"${tilt}>${head}${front && !heldProp ? front : ''}</g>` +
    `<g class="wsp-props">${heldProp ? front : ''}</g>` +
    `<g class="wsp-fx">${overlay}</g>` +
    '</svg>';
  return o.standalone ? inlineInks(svg) : svg;
}
