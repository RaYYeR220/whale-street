import { PARAMS, type Params } from './params';
import type { Marks, Position, Snapshot } from './types';
import { isValidPx } from './validity';

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

/** First valid price in the fallback chain, or undefined if none are valid. */
function firstValidPx(...candidates: (number | undefined)[]): number | undefined {
  return candidates.find(isValidPx);
}

/** notionalUsd/realizedPnlUsd for a filing, omitted entirely (never NaN) if mark is unknown. */
function amounts(
  qty: number,
  mark: number | undefined,
  closed?: { size: number; entryPx: number },
): Pick<Filing, 'notionalUsd' | 'realizedPnlUsd'> {
  if (mark === undefined) return {};
  const notionalUsd = Math.abs(qty) * mark;
  if (!closed) return { notionalUsd };
  return { notionalUsd, realizedPnlUsd: closed.size * (mark - closed.entryPx) };
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
    const mark = firstValidPx(marks[coin], n?.entryPx, p?.entryPx);
    const base = {
      coin,
      sizeBefore: a,
      sizeAfter: b,
      at: next.fetchedAt,
      provenance: next.provenance,
    };

    if (a === 0) {
      filings.push({ ...base, kind: 'OPEN', ...amounts(b, mark) });
      continue;
    }
    const prevPos = p as Position;

    if (b !== 0 && Math.sign(a) !== Math.sign(b)) {
      filings.push({
        ...base,
        kind: 'FLIP',
        ...amounts(b, mark, { size: a, entryPx: prevPos.entryPx }),
      });
      continue;
    }
    if (Math.abs(b) > Math.abs(a)) {
      filings.push({ ...base, kind: 'ADD', ...amounts(b - a, mark) });
      continue;
    }
    const closed = a - b;
    if (mark !== undefined && crossedLiq(prevPos, mark)) {
      liquidated = true;
      filings.push({
        ...base,
        kind: 'LIQUIDATION',
        ...amounts(closed, mark, { size: closed, entryPx: prevPos.entryPx }),
      });
    } else {
      filings.push({
        ...base,
        kind: b === 0 ? 'CLOSE' : 'REDUCE',
        ...amounts(closed, mark, { size: closed, entryPx: prevPos.entryPx }),
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
