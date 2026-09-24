/**
 * SIWE-lite wallet link: the engine issues a nonce, the wallet personal_signs this exact message,
 * the engine verifies it and binds the wallet to the player (required before an agent can be registered).
 */
import type { Api } from '../api';
import type { PlayerView } from '../api-types';

/** Must match apps/engine/src/services/players.ts linkMessage byte for byte. */
export const linkMessage = (address: string, nonce: string): string =>
  `Whale Street: link wallet ${address.toLowerCase()} nonce ${nonce}`;

export type LinkResult = { ok: true; player: PlayerView } | { ok: false; message: string };

export async function linkWallet(
  api: Pick<Api, 'authNonce' | 'authLink'>,
  token: string,
  address: string,
  signMessage: (message: string) => Promise<string>,
): Promise<LinkResult> {
  const n = await api.authNonce(token);
  if (!n.ok) return { ok: false, message: n.message };
  let signature: string;
  try {
    signature = await signMessage(linkMessage(address, n.data.nonce));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: /reject|denied/i.test(msg) ? 'You declined the signature.' : msg };
  }
  const r = await api.authLink(token, address, signature);
  return r.ok ? { ok: true, player: r.data.player } : { ok: false, message: r.message };
}
