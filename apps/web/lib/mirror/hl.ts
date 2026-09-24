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

/** The error and every `cause` under it (wallet libraries wrap the provider's error). */
function causes(err: unknown): unknown[] {
  const out: unknown[] = [];
  for (let e = err; e !== null && e !== undefined && out.length < 10; ) {
    out.push(e);
    e = typeof e === 'object' ? (e as { cause?: unknown }).cause : undefined;
  }
  return out;
}

const messageOf = (e: unknown): string =>
  typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string'
    ? (e as { message: string }).message
    : String(e);

/** A wallet decline: viem's UserRejectedRequestError or an EIP-1193 4001 anywhere in the chain. */
export function isUserRejection(err: unknown): boolean {
  return causes(err).some((e) => {
    const o = (typeof e === 'object' && e !== null ? e : {}) as { name?: unknown; code?: unknown };
    return (
      o.name === 'UserRejectedRequestError' ||
      o.code === 4001 ||
      /user rejected|user denied|denied/i.test(messageOf(e))
    );
  });
}

/** Short human reason from a wallet, Hyperliquid or transport error. */
export function hlErrorText(err: unknown): string {
  if (isUserRejection(err)) return 'You declined the signature in your wallet.';
  const chain = causes(err).map(messageOf);
  if (chain.some((m) => /must deposit/i.test(m)))
    return 'This wallet has no Hyperliquid deposit yet. Deposit USDC on Hyperliquid first.';
  // Keep the wrapper's words and add the innermost reason ("Failed to sign…: device locked").
  const top = chain[0] ?? String(err);
  const inner = chain.length > 1 ? chain[chain.length - 1] : undefined;
  const msg = inner && inner !== top ? `${top}: ${inner}` : top;
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}
