/** One-time setup of a Mirror agent key: Hyperliquid approvals, then registration with the engine. */
import type { Api } from '../api';
import { newAgent, RENEW_MARGIN_MS } from './agent';
import { approveAgentOnHl, approveBuilderFeeOnHl, type HlSigner } from './hl';
import type { AgentRecord, KeyStore } from './keystore';
import { BUILDER_FEE_CEILING } from './policy';

/** The engine refused a setup step, with its error code (WALLET_IN_USE, NO_WALLET, ...). */
export class EngineRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'EngineRefusal';
  }
}

export interface ApproveDeps {
  api: Pick<Api, 'builderFee' | 'registerAgent'>;
  token: string;
  store: KeyStore;
  /** Master wallet, lowercase. */
  master: string;
  signer: HlSigner;
  now?: () => number;
}

/**
 * Approves a Whale Street agent key for `master`: Hyperliquid's approveAgent (skipped when this
 * key was already accepted), Nansen's builder fee (only if the wallet has not approved it yet),
 * then registration with the engine. The key becomes usable (approvedAt) only once all three
 * succeeded; any failure leaves it pending, so a retry reuses the same key instead of minting a
 * new one and never leaves a half-registered key that looks ready.
 */
export async function approveAgentKey(d: ApproveDeps): Promise<AgentRecord> {
  const now = d.now ?? Date.now;
  const saved = await d.store.load(d.master);
  let rec =
    saved && saved.approvedAt === null && saved.validUntil - RENEW_MARGIN_MS > now()
      ? saved
      : newAgent(d.master, now());
  await d.store.save(rec);
  if (!rec.hlApprovedAt) {
    await approveAgentOnHl(d.signer, rec);
    rec = { ...rec, hlApprovedAt: now() };
    await d.store.save(rec);
  }
  const fee = await d.api.builderFee(d.token);
  if (!fee.ok) throw new EngineRefusal(fee.error, fee.message);
  if (!fee.data.approved)
    await approveBuilderFeeOnHl(d.signer, {
      builder: fee.data.builderAddress,
      tenthsBp: BUILDER_FEE_CEILING,
    });
  const reg = await d.api.registerAgent(d.token, d.master, rec.agentAddress);
  if (!reg.ok) throw new EngineRefusal(reg.error, reg.message);
  rec = { ...rec, approvedAt: now() };
  await d.store.save(rec);
  return rec;
}
