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

/** What the engine's order log says about an order this page did not send itself (a reload). */
export interface LoggedOrder {
  ticker: string;
  coin: string;
  notionalUsd: number;
}

export type MirrorOutcome =
  | { kind: 'refused'; refusals: MirrorReason[]; groupId: string | null }
  | {
      kind: 'filled';
      groupId: string;
      /** Null for an order known only from the engine's log (sent before this page loaded). */
      order: MirrorOrder | null;
      logged?: LoggedOrder;
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
      /** Null for an order known only from the engine's log (sent before this page loaded). */
      order: MirrorOrder | null;
      logged?: LoggedOrder;
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

/** Order statuses whose outcome the engine is still learning from Hyperliquid. */
export const UNRESOLVED = new Set<MirrorOrderView['status']>(['UNKNOWN', 'SUBMITTED']);

/** The player's orders whose outcome is still unknown on the engine, newest first. */
export function unresolvedOrders(
  orders: readonly MirrorOrderView[],
  putAside: ReadonlySet<string>,
): MirrorOrderView[] {
  return orders
    .filter((o) => o.kind === 'order' && UNRESOLVED.has(o.status) && !putAside.has(o.id))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * An order the engine still lists as UNKNOWN or SUBMITTED, as the "checking with Hyperliquid"
 * outcome: after a reload the page must not forget it and offer to send the same order again.
 */
export function unknownFromLog(row: MirrorOrderView): Extract<MirrorOutcome, { kind: 'unknown' }> {
  return {
    kind: 'unknown',
    groupId: row.groupId,
    stepId: row.id,
    since: row.createdAt,
    order: null,
    logged: { ticker: row.ticker, coin: row.coin, notionalUsd: row.notionalUsd },
    receipts: [],
    detail: row.error ?? 'Sent earlier; Hyperliquid has not confirmed it yet.',
  };
}

/** Hyperliquid's answer when the signing agent is not (or no longer) approved for the wallet. */
const HL_AGENT_REJECTED =
  /(api wallet|agent)[^.]*(does not exist|not found|unauthori[sz]ed|not approved|expired)/i;

/**
 * True when the stored agent key can no longer trade: the engine has another agent on record
 * (BAD_SIGNATURE, NO_AGENT) or Hyperliquid rejects the agent itself. A changed wallet link
 * (NO_WALLET) is not an agent problem: a new key would be refused the same way (walletProblem).
 */
export function agentProblem(out: MirrorOutcome): boolean {
  if (out.kind !== 'error') return false;
  if (out.code === 'BAD_SIGNATURE' || out.code === 'NO_AGENT') return true;
  return out.code === 'REJECTED' && HL_AGENT_REJECTED.test(out.message);
}

/** The player's linked wallet is no longer this one: link it again (then approve its agent). */
export function walletProblem(out: MirrorOutcome): boolean {
  return out.kind === 'error' && out.code === 'NO_WALLET';
}

export type MirrorProgress =
  | 'preparing'
  | 'signing-leverage'
  | 'sending-leverage'
  | 'signing-order'
  | 'sending-order';

/** The prepared order is not the position the player picked: nothing was signed. */
export const POSITION_CHANGED = 'POSITION_CHANGED';

export async function runMirror(o: {
  api: Pick<Api, 'mirrorPrepare' | 'mirrorExecute'>;
  token: string;
  body: MirrorPrepareBody;
  /**
   * The coin and direction the player picked. The engine copies the trader's side as it is at
   * prepare, so a trader who flipped since the page last looked would get the other direction:
   * the flow signs nothing unless the prepared order matches.
   */
  expect?: { coin: string; isBuy: boolean };
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
  if (o.expect && (order.coin !== o.expect.coin || order.isBuy !== o.expect.isBuy))
    return {
      kind: 'error',
      code: POSITION_CHANGED,
      message: `The trader's position changed — pick again. The engine prepared a ${order.isBuy ? 'long' : 'short'} ${order.coin}, not the ${o.expect.isBuy ? 'long' : 'short'} ${o.expect.coin} you picked, so nothing was signed or sent.`,
      receipts: [],
    };
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
