import { createSiweMessage, type SiweMessage } from 'viem/siwe';
import { LINK_STATEMENT } from '../../src/services/players';

/** The web app origin the test engines allow (the CORS_ORIGINS default). */
export const WEB_ORIGIN = 'http://localhost:3000';

/** A wallet-link message exactly as the web client builds it (viem createSiweMessage). */
export function siweMessage(
  address: `0x${string}`,
  nonce: string,
  issuedAtMs: number,
  over: Partial<SiweMessage> = {},
): string {
  return createSiweMessage({
    domain: 'localhost:3000',
    address,
    statement: LINK_STATEMENT,
    uri: WEB_ORIGIN,
    version: '1',
    chainId: 42_161,
    nonce,
    issuedAt: new Date(issuedAtMs),
    ...over,
  });
}
