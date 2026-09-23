import { PARAMS, type Params } from './params';
import type { Marks, Position } from './types';

export function positionHp(p: Position, mark: number): number {
  if (p.liqPx === null || p.size === 0) return 1;
  const span = Math.abs(p.entryPx - p.liqPx);
  if (span < 1e-12) return 0;
  const dist = p.size > 0 ? mark - p.liqPx : p.liqPx - mark;
  return Math.min(1, Math.max(0, dist / span));
}

export function computeHp(positions: readonly Position[], marks: Marks): number {
  let hp = 1;
  for (const p of positions) {
    const m = marks[p.coin];
    if (m === undefined || !Number.isFinite(m)) continue;
    hp = Math.min(hp, positionHp(p, m));
  }
  return hp;
}

export function marginCallCrossed(
  hpBefore: number,
  hpAfter: number,
  params: Params = PARAMS,
): boolean {
  return hpBefore >= params.marginCallHp && hpAfter < params.marginCallHp;
}
