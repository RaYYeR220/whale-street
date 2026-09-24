/**
 * One Mirror order, end to end: engine prepare (policy on a fresh snapshot) → agent signs each
 * step's EIP-712 → engine execute (it verifies the signer and forwards to Nansen). Steps run in
 * order and stop at the first failure. A timeout, a network error or a 202 UNKNOWN receipt after
 * submission is "result unknown": the flow never re-sends by itself.
 */
import type { MirrorOrder } from '@whale-street/core';
import type { Hex } from 'viem';
import type { Api } from '../api';
import type { MirrorPrepareBody, MirrorReason, MirrorReceipt } from '../api-types';
import { signStep } from './sign';

export type MirrorOutcome =
  | { kind: 'refused'; refusals: MirrorReason[]; groupId: string | null }
  | {
      kind: 'filled';
      groupId: string;
      order: MirrorOrder;
      receipts: MirrorReceipt[];
      warning: string | null;
    }
  | {
      kind: 'unknown';
      groupId: string;
      order: MirrorOrder;
      receipts: MirrorReceipt[];
      detail: string;
    }
  | { kind: 'error'; code: string; message: string; receipts: MirrorReceipt[] };

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
}): Promise<MirrorOutcome> {
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
    if (!r.ok) {
      if (r.status === 0 && step.kind === 'order')
        return { kind: 'unknown', groupId, order, receipts, detail: r.message };
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
      return {
        kind: 'unknown',
        groupId,
        order,
        receipts,
        detail: r.data.error ?? 'Hyperliquid did not confirm the order',
      };
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
