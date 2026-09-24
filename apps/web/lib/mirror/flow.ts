/**
 * One Mirror order, end to end: engine prepare (policy on a fresh snapshot) → agent signs each
 * step's EIP-712 → engine execute (it verifies the signer and forwards to Nansen). Steps run in
 * order and stop at the first failure. On the order step anything but a definitive rejection (a
 * timeout, a network error, 408, 5xx, an unreadable reply or a 202 UNKNOWN receipt) is "result
 * unknown": the flow never re-sends by itself, and resolveUnknown reads the answer later.
 */
import type { MirrorOrder } from '@whale-street/core';
import type { Hex } from 'viem';
import type { Api } from '../api';
import type { MirrorOrderView, MirrorPrepareBody, MirrorReason, MirrorReceipt } from '../api-types';
import { STEP_TTL_MS } from './policy';
import { signStep } from './sign';

export type MirrorOutcome =
  | { kind: 'refused'; refusals: MirrorReason[]; groupId: string | null }
  | {
      kind: 'filled';
      groupId: string;
      order: MirrorOrder;
      receipts: MirrorReceipt[];
      /** A problem with the attached stop-loss (the order itself is on Hyperliquid). */
      warning: string | null;
      /** How the fill was learned when it was not answered directly (e.g. from the HL position). */
      note?: string | null;
      /** Filled, and the position has been closed on Hyperliquid since. */
      closed?: boolean;
    }
  | {
      kind: 'unknown';
      groupId: string;
      /** The order step whose outcome is unknown. */
      stepId: string;
      /** When the outcome became unknown (browser clock). */
      since: number;
      order: MirrorOrder;
      receipts: MirrorReceipt[];
      detail: string;
    }
  | { kind: 'error'; code: string; message: string; receipts: MirrorReceipt[] };

/**
 * Same rule as the engine's isDefinitiveRejection: only a 4xx other than 408 means "not
 * executed". A timeout or network error (status 0), 408, 5xx or a 2xx whose body could not be
 * read may all have reached Hyperliquid.
 */
export function isDefinitiveRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408;
}

/** How long after our failed request an engine request could still be working on the step. */
export const IN_FLIGHT_MS = 90_000;
/** Allowance for the browser clock differing from the engine's when comparing with createdAt. */
export const CLOCK_SKEW_MS = 120_000;

export type Resolution =
  | {
      kind: 'filled';
      receipt: MirrorReceipt;
      closed: boolean;
      warning: string | null;
      note: string | null;
    }
  | { kind: 'rejected'; message: string }
  | { kind: 'unknown'; status: string };

/**
 * Reads an unknown order's row in the engine's order log (the engine reconciles it against the
 * wallet's Hyperliquid position when the log is read). FILLED, RESTING and CLOSED mean the order
 * is on Hyperliquid; REJECTED means it is not. A step still PREPARED long after it expired, with
 * no request of ours still in flight, never reached Hyperliquid. Anything else stays unknown.
 */
export function resolveUnknown(
  row: MirrorOrderView | undefined,
  since: number,
  now: number,
): Resolution {
  if (!row) return { kind: 'unknown', status: 'no record yet' };
  if (row.status === 'FILLED' || row.status === 'RESTING' || row.status === 'CLOSED') {
    const stopProblem = row.error !== null && /stop-loss/i.test(row.error);
    return {
      kind: 'filled',
      closed: row.status === 'CLOSED',
      warning: stopProblem ? row.error : null,
      note: stopProblem ? null : row.error,
      receipt: {
        stepId: row.id,
        kind: row.kind,
        status: row.status,
        hlOid: row.hlOid,
        avgPx: row.avgPx,
        error: row.error,
        explorerUrl: row.explorerUrl ?? '',
      },
    };
  }
  if (row.status === 'REJECTED')
    return { kind: 'rejected', message: row.error ?? 'rejected before reaching Hyperliquid' };
  if (
    row.status === 'PREPARED' &&
    now - row.createdAt > STEP_TTL_MS + CLOCK_SKEW_MS &&
    now - since > IN_FLIGHT_MS
  )
    return {
      kind: 'rejected',
      message: 'the signed order never reached the engine and has expired unused',
    };
  return { kind: 'unknown', status: row.status.toLowerCase() };
}

/** Hyperliquid's answer when the signing agent is not (or no longer) approved for the wallet. */
const HL_AGENT_REJECTED =
  /(api wallet|agent)[^.]*(does not exist|not found|unauthori[sz]ed|not approved|expired)/i;

/**
 * True when the stored agent key can no longer trade: the engine has another agent or wallet on
 * record (BAD_SIGNATURE, NO_AGENT, NO_WALLET) or Hyperliquid rejects the agent itself.
 */
export function agentProblem(out: MirrorOutcome): boolean {
  if (out.kind !== 'error') return false;
  if (out.code === 'BAD_SIGNATURE' || out.code === 'NO_AGENT' || out.code === 'NO_WALLET')
    return true;
  return out.code === 'REJECTED' && HL_AGENT_REJECTED.test(out.message);
}

export type MirrorProgress =
  | 'preparing'
  | 'signing-leverage'
  | 'sending-leverage'
  | 'signing-order'
  | 'sending-order';

export async function runMirror(o: {
  api: Pick<Api, 'mirrorPrepare' | 'mirrorExecute'>;
  token: string;
  body: MirrorPrepareBody;
  privateKey: Hex;
  onProgress?: (p: MirrorProgress) => void;
  now?: () => number;
}): Promise<MirrorOutcome> {
  const now = o.now ?? Date.now;
  o.onProgress?.('preparing');
  const prep = await o.api.mirrorPrepare(o.token, o.body);
  if (!prep.ok) {
    if (prep.refusals && prep.refusals.length > 0)
      return { kind: 'refused', refusals: prep.refusals, groupId: null };
    return { kind: 'error', code: prep.error, message: prep.message, receipts: [] };
  }
  if ('refusals' in prep.data)
    return { kind: 'refused', refusals: prep.data.refusals, groupId: prep.data.groupId };
  const { order, steps, groupId } = prep.data;
  const receipts: MirrorReceipt[] = [];
  for (const step of steps) {
    o.onProgress?.(step.kind === 'leverage' ? 'signing-leverage' : 'signing-order');
    const signature = await signStep(o.privateKey, step.eip712);
    o.onProgress?.(step.kind === 'leverage' ? 'sending-leverage' : 'sending-order');
    const r = await o.api.mirrorExecute(o.token, step.stepId, signature);
    const unknown = (detail: string): MirrorOutcome => ({
      kind: 'unknown',
      groupId,
      stepId: step.stepId,
      since: now(),
      order,
      receipts,
      detail,
    });
    if (!r.ok) {
      // Only a definitive rejection means the order is not on Hyperliquid; the rest may be.
      if (step.kind === 'order' && !isDefinitiveRejection(r.status)) return unknown(r.message);
      if (r.refusals && r.refusals.length > 0)
        return { kind: 'refused', refusals: r.refusals, groupId };
      return { kind: 'error', code: r.error, message: r.message, receipts };
    }
    receipts.push(r.data);
    if ((r.data.status === 'UNKNOWN' || r.data.status === 'SUBMITTED') && step.kind === 'leverage')
      return {
        kind: 'error',
        code: 'LEVERAGE_UNCONFIRMED',
        message:
          'Hyperliquid did not confirm the leverage change, so no order was sent. Try again in a minute.',
        receipts,
      };
    if (r.data.status === 'UNKNOWN' || r.data.status === 'SUBMITTED')
      return unknown(r.data.error ?? 'Hyperliquid did not confirm the order');
    if (r.data.status === 'REJECTED')
      return {
        kind: 'error',
        code: 'REJECTED',
        message: r.data.error ?? 'rejected by Hyperliquid',
        receipts,
      };
  }
  const last = receipts[receipts.length - 1];
  return { kind: 'filled', groupId, order, receipts, warning: last?.error ?? null };
}
