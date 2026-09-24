/**
 * The agent key signs exactly the EIP-712 payload the engine sent (Nansen's prepared Hyperliquid
 * L1 action, domain chainId 1337). A local viem account does not check the chain, so this works in
 * any browser without a wallet prompt.
 */
import { type Hex, parseSignature } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Eip712Payload, SignatureParts } from '../api-types';

export async function signStep(privateKey: Hex, eip712: Eip712Payload): Promise<SignatureParts> {
  const account = privateKeyToAccount(privateKey);
  const hex = await account.signTypedData({
    domain: eip712.domain,
    types: eip712.types,
    primaryType: eip712.primaryType,
    message: eip712.message,
  } as Parameters<typeof account.signTypedData>[0]);
  const { r, s, v, yParity } = parseSignature(hex);
  return { r, s, v: v !== undefined ? Number(v) : 27 + yParity };
}
