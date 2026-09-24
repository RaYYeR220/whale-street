/**
 * One-time user-signed Hyperliquid actions, signed by the player's own wallet (EIP-712 domain
 * HyperliquidSignTransaction, signatureChainId = the wallet's active chain so MetaMask accepts it)
 * and posted straight to api.hyperliquid.xyz/exchange. Nansen's /perp/execute does not take approveAgent.
 */
import { HttpTransport, type IRequestTransport } from '@nktkas/hyperliquid';
import { approveAgent, approveBuilderFee } from '@nktkas/hyperliquid/api/exchange';
import type { AbstractWallet } from '@nktkas/hyperliquid/signing';

export interface HlSigner {
  wallet: AbstractWallet;
  transport?: IRequestTransport;
  /** Hex chain id to sign with; defaults to the wallet's active chain. */
  signatureChainId?: `0x${string}`;
}

/** Builder fee ceiling as HL expects it: tenths of a basis point → percent string (80 → "0.08%"). */
export function builderFeeRate(tenthsBp: number): string {
  const pct = tenthsBp / 1_000;
  return `${Number(pct.toFixed(4))}%`;
}

const config = (s: HlSigner) => ({
  transport: s.transport ?? new HttpTransport(),
  wallet: s.wallet,
  ...(s.signatureChainId ? { signatureChainId: s.signatureChainId } : {}),
});

export async function approveAgentOnHl(
  s: HlSigner,
  agent: { agentAddress: `0x${string}`; agentName: string },
): Promise<void> {
  await approveAgent(config(s), { agentAddress: agent.agentAddress, agentName: agent.agentName });
}

export async function approveBuilderFeeOnHl(
  s: HlSigner,
  fee: { builder: `0x${string}`; tenthsBp: number },
): Promise<void> {
  await approveBuilderFee(config(s), {
    builder: fee.builder.toLowerCase() as `0x${string}`,
    maxFeeRate: builderFeeRate(fee.tenthsBp),
  });
}

/** Short human reason from a Hyperliquid/transport error. */
export function hlErrorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/user rejected|denied/i.test(msg)) return 'You declined the signature in your wallet.';
  if (/must deposit/i.test(msg))
    return 'This wallet has no Hyperliquid deposit yet. Deposit USDC on Hyperliquid first.';
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}
