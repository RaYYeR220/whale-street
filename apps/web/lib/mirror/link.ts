/**
 * Wallet link with Sign-In with Ethereum (EIP-4361): the engine issues a nonce, the wallet
 * personal_signs a message rendered by viem's createSiweMessage for this page's host and origin,
 * and the engine verifies it (canonical text, one of its web origins, the nonce, the signature)
 * before binding the wallet to the player. Every attempt takes a fresh nonce: the engine spends a
 * nonce on any attempt, whatever its outcome.
 */
import { type Address, getAddress } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import type { Api } from '../api';
import type { PlayerView } from '../api-types';
import { linkErrorText } from '../errors';
import { hlErrorText, isUserRejection } from './hl';

export interface LinkTarget {
  /** The connected wallet. */
  address: string;
  /** EIP-155 id of the chain the wallet is on (any chain; the message just names it). */
  chainId: number;
  /** This page's host (with port) and origin: the engine accepts only its own web origins. */
  host: string;
  origin: string;
}

/** The exact EIP-4361 text the wallet signs (viem renders it; never edit it by hand). */
export function linkMessage(
  t: LinkTarget & { nonce: string; statement?: string; issuedAt: Date },
): string {
  return createSiweMessage({
    domain: t.host,
    address: getAddress(t.address) as Address,
    ...(t.statement ? { statement: t.statement } : {}),
    uri: t.origin,
    version: '1',
    chainId: t.chainId,
    nonce: t.nonce,
    issuedAt: t.issuedAt,
  });
}

export type LinkResult =
  | { ok: true; player: PlayerView }
  | { ok: false; code: string; message: string };

export async function linkWallet(
  api: Pick<Api, 'authNonce' | 'authLink'>,
  token: string,
  target: LinkTarget,
  signMessage: (message: string) => Promise<string>,
  now: () => Date = () => new Date(),
): Promise<LinkResult> {
  const n = await api.authNonce(token);
  if (!n.ok) return { ok: false, code: n.error, message: linkErrorText(n.error, n.message) };
  let message: string;
  try {
    // issuedAt is wall time on purpose: the engine times the nonce on its wall clock too.
    message = linkMessage({
      ...target,
      nonce: n.data.nonce,
      statement: n.data.message,
      issuedAt: now(),
    });
  } catch (err) {
    return {
      ok: false,
      code: 'INVALID_MESSAGE',
      message: `Cannot build the sign-in message: ${hlErrorText(err)}`,
    };
  }
  let signature: string;
  try {
    signature = await signMessage(message);
  } catch (err) {
    return isUserRejection(err)
      ? { ok: false, code: 'DECLINED', message: 'You declined the signature.' }
      : { ok: false, code: 'SIGN_FAILED', message: hlErrorText(err) };
  }
  const r = await api.authLink(token, message, signature);
  return r.ok
    ? { ok: true, player: r.data.player }
    : { ok: false, code: r.error, message: linkErrorText(r.error, r.message) };
}
