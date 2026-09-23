import { PARAMS, type Params } from './params';
import type { Marks, Position, Snapshot } from './types';

export type FilingKind =
  | 'OPEN'
  | 'ADD'
  | 'REDUCE'
  | 'CLOSE'
  | 'FLIP'
  | 'MARGIN_CALL'
  | 'LIQUIDATION'
  | 'BANKRUPTCY'
  | 'RESTATEMENT'
  | 'HALT'
  | 'RESUME'
  | 'IPO'
  | 'DELISTING';

export interface Filing {
  kind: FilingKind;
  coin?: string;
  sizeBefore?: number;
  sizeAfter?: number;
  notionalUsd?: number;
  realizedPnlUsd?: number;
  at: number;
  provenance: readonly string[];
  detail?: string;
}

export interface DiffResult {
  filings: Filing[];
  liquidated: boolean;
  bankrupt: boolean;
}

function crossedLiq(p: Position, mark: number): boolean {
  if (p.liqPx === null) return false;
  return p.size > 0 ? mark <= p.liqPx : mark >= p.liqPx;
}

export function diffSnapshots(
  prev: Snapshot,
  next: Snapshot,
  marks: Marks,
  params: Params = PARAMS,
): DiffResult {
  const before = new Map(prev.positions.map((p) => [p.coin, p]));
  const after = new Map(next.positions.map((p) => [p.coin, p]));
  const coins = [...new Set([...before.keys(), ...after.keys()])].sort();
  const filings: Filing[] = [];
  let liquidated = false;

  for (const coin of coins) {
    const p = before.get(coin);
    const n = after.get(coin);
    const a = p?.size ?? 0;
    const b = n?.size ?? 0;
    if (a === b) continue;
    const mark = marks[coin] ?? n?.entryPx ?? p?.entryPx ?? 0;
    const base = {
      coin,
      sizeBefore: a,
      sizeAfter: b,
      at: next.fetchedAt,
      provenance: next.provenance,
    };

    if (a === 0) {
      filings.push({ ...base, kind: 'OPEN', notionalUsd: Math.abs(b) * mark });
      continue;
    }
    const prevPos = p as Position;
    const realizedOn = (closed: number) => closed * (mark - prevPos.entryPx);

    if (b !== 0 && Math.sign(a) !== Math.sign(b)) {
      filings.push({
        ...base,
        kind: 'FLIP',
        notionalUsd: Math.abs(b) * mark,
        realizedPnlUsd: realizedOn(a),
      });
      continue;
    }
    if (Math.abs(b) > Math.abs(a)) {
      filings.push({ ...base, kind: 'ADD', notionalUsd: Math.abs(b - a) * mark });
      continue;
    }
    const closed = a - b;
    if (crossedLiq(prevPos, mark)) {
      liquidated = true;
      filings.push({
        ...base,
        kind: 'LIQUIDATION',
        notionalUsd: Math.abs(closed) * mark,
        realizedPnlUsd: realizedOn(closed),
      });
    } else {
      filings.push({
        ...base,
        kind: b === 0 ? 'CLOSE' : 'REDUCE',
        notionalUsd: Math.abs(closed) * mark,
        realizedPnlUsd: realizedOn(closed),
      });
    }
  }

  const bankrupt =
    liquidated && next.accountValue < params.bankruptcyEquityFrac * prev.accountValue;
  if (bankrupt) {
    filings.push({ kind: 'BANKRUPTCY', at: next.fetchedAt, provenance: next.provenance });
  }
  return { filings, liquidated, bankrupt };
}
