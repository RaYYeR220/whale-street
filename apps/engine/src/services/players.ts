import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { verifyMessage } from 'viem';
import { createSiweMessage, parseSiweMessage, type SiweMessage } from 'viem/siwe';
import type { Clock } from '../clock';
import { MINUTE_MS } from '../dates';
import type { PlayerRow, Repos } from '../db/repos';
import type { PlayerKind } from '../types';

const ADJECTIVES = [
  'Gilded',
  'Silent',
  'Crimson',
  'Lucky',
  'Velvet',
  'Iron',
  'Neon',
  'Arctic',
  'Copper',
  'Cobalt',
  'Midnight',
  'Golden',
  'Rogue',
  'Stoic',
  'Brazen',
  'Lunar',
  'Tidal',
  'Molten',
  'Amber',
  'Onyx',
  'Jade',
  'Marble',
  'Phantom',
  'Royal',
  'Rusty',
  'Nimble',
  'Restless',
  'Steady',
  'Wild',
  'Cosmic',
] as const;
const CREATURES = [
  'Barracuda',
  'Marlin',
  'Orca',
  'Narwhal',
  'Stingray',
  'Swordfish',
  'Squid',
  'Falcon',
  'Heron',
  'Pelican',
  'Jackal',
  'Lynx',
  'Panther',
  'Cobra',
  'Gecko',
  'Badger',
  'Otter',
  'Walrus',
  'Puffin',
  'Lobster',
  'Urchin',
  'Moray',
  'Manatee',
  'Beluga',
  'Hammerhead',
  'Mako',
  'Fox',
  'Owl',
  'Kraken',
  'Mongoose',
] as const;

export const NONCE_TTL_MS = 10 * MINUTE_MS;
/** A SIWE issuedAt may run this far ahead of the engine clock (browser clock drift). */
export const ISSUED_AT_SKEW_MS = 30_000;
/** Suggested SIWE statement, served as `message` by GET /api/auth/nonce. */
export const LINK_STATEMENT = 'Link this wallet to your Whale Street player.';

export interface PlayerView {
  id: string;
  handle: string;
  kind: PlayerKind;
  walletAddress: string | null;
  createdAt: number;
}

export type LinkErrorCode =
  | 'INVALID_MESSAGE'
  | 'NO_NONCE'
  | 'DOMAIN_MISMATCH'
  | 'NONCE_MISMATCH'
  | 'MESSAGE_EXPIRED'
  | 'MESSAGE_NOT_YET_VALID'
  | 'BAD_SIGNATURE';

export type LinkResult =
  | { ok: true; player: PlayerView }
  | { ok: false; code: LinkErrorCode; message: string };

export interface PlayersService {
  create(kind: 'human' | 'agent', name?: string): { player: PlayerView; token: string };
  /** Idempotent: creates the bot player on first call (bots have no bearer token). */
  ensureBot(id: string, handle: string): PlayerView;
  auth(token: string | null | undefined): PlayerView | null;
  get(id: string): PlayerView | null;
  nonce(playerId: string): string;
  /**
   * Links the wallet that signed `message`, an EIP-4361 (SIWE) message: canonical text, domain and
   * uri origin of a configured web origin, the player's unexpired nonce (spent by any attempt),
   * a chain id, issuedAt within the nonce TTL (and not in the future), and a matching signature.
   */
  link(playerId: string, message: string, signature: string): Promise<LinkResult>;
}

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

type LinkFields = Required<
  Pick<SiweMessage, 'address' | 'chainId' | 'domain' | 'issuedAt' | 'nonce' | 'uri' | 'version'>
> &
  SiweMessage;

/**
 * The message's fields when it is a complete EIP-4361 message in canonical form (exactly what
 * viem createSiweMessage renders for those fields, which is what wallets display as SIWE); null
 * otherwise.
 */
function parseLinkMessage(message: string): LinkFields | null {
  const m = parseSiweMessage(message);
  const { address, chainId, domain, issuedAt, nonce, uri, version } = m;
  if (!address || chainId === undefined || !domain || !issuedAt || !nonce || !uri) return null;
  if (version !== '1' || Number.isNaN(issuedAt.getTime())) return null;
  for (const t of [m.expirationTime, m.notBefore]) if (t && Number.isNaN(t.getTime())) return null;
  const fields: LinkFields = { ...m, address, chainId, domain, issuedAt, nonce, uri, version };
  try {
    if (createSiweMessage(fields) !== message) return null;
  } catch {
    return null;
  }
  return fields;
}

/** True when the message's domain, uri origin and (optional) scheme belong to one web origin. */
function fromWebOrigin(f: LinkFields, origins: readonly string[]): boolean {
  let uriOrigin: string;
  try {
    uriOrigin = new URL(f.uri).origin;
  } catch {
    return false;
  }
  return origins.some((o) => {
    let web: URL;
    try {
      web = new URL(o);
    } catch {
      return false;
    }
    return (
      f.domain === web.host &&
      uriOrigin === web.origin &&
      (f.scheme === undefined || `${f.scheme}:` === web.protocol)
    );
  });
}

export const playerView = (p: PlayerRow): PlayerView => ({
  id: p.id,
  handle: p.handle,
  kind: p.kind,
  walletAddress: p.walletAddress,
  createdAt: p.createdAt,
});

const pick = <T>(xs: readonly T[]): T => xs[randomInt(xs.length)] as T;

/**
 * `wallNow` (default `clock.now`) times the wallet-link nonce: a TTL must not loop with REPLAY.
 * `origins`: the web app origins (CORS_ORIGINS) a wallet-link message must name; none (the
 * default) refuses every link.
 */
export function createPlayersService(d: {
  repos: Repos;
  clock: Clock;
  origins?: readonly string[];
  wallNow?: () => number;
}): PlayersService {
  const wallNow = d.wallNow ?? (() => d.clock.now());
  const uniqueHandle = (base: () => string): string => {
    for (let i = 0; i < 50; i++) {
      const h = `${base()} #${randomInt(100, 1_000)}`;
      if (!d.repos.players.byHandle(h)) return h;
    }
    return `${base()} #${randomInt(1_000, 1_000_000)}`;
  };

  return {
    create(kind, name) {
      const clean = (name ?? '')
        .replace(/[^A-Za-z0-9 _-]/g, '')
        .trim()
        .slice(0, 24);
      const handle =
        kind === 'agent'
          ? uniqueHandle(() => (clean.length > 0 ? clean : 'Agent'))
          : uniqueHandle(() => `${pick(ADJECTIVES)} ${pick(CREATURES)}`);
      const token = randomBytes(32).toString('hex');
      const row: PlayerRow = {
        id: `p_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        handle,
        tokenHash: hashToken(token),
        kind,
        walletAddress: null,
        createdAt: d.clock.now(),
      };
      d.repos.players.insert(row);
      return { player: playerView(row), token };
    },
    ensureBot(id, handle) {
      const existing = d.repos.players.get(id);
      if (existing) return playerView(existing);
      const row: PlayerRow = {
        id,
        handle,
        tokenHash: `bot:${id}`,
        kind: 'bot',
        walletAddress: null,
        createdAt: d.clock.now(),
      };
      d.repos.players.insert(row);
      return playerView(row);
    },
    auth(token) {
      if (!token || token.length < 16) return null;
      const p = d.repos.players.byTokenHash(hashToken(token));
      return p ? playerView(p) : null;
    },
    get(id) {
      const p = d.repos.players.get(id);
      return p ? playerView(p) : null;
    },
    nonce(playerId) {
      const nonce = randomBytes(16).toString('hex');
      d.repos.kv.setJson(`nonce:${playerId}`, { nonce, exp: wallNow() + NONCE_TTL_MS });
      return nonce;
    },
    async link(playerId, message, signature) {
      const refuse = (code: LinkErrorCode, text: string): LinkResult => ({
        ok: false,
        code,
        message: text,
      });
      const f = parseLinkMessage(message);
      if (!f)
        return refuse(
          'INVALID_MESSAGE',
          'expected an EIP-4361 (Sign-In with Ethereum) message as rendered by createSiweMessage',
        );
      const now = wallNow();
      const stored = d.repos.kv.getJson<{ nonce: string; exp: number }>(`nonce:${playerId}`);
      if (!stored || stored.exp < now) return refuse('NO_NONCE', 'request a fresh nonce first');
      // One attempt per nonce, whatever its outcome.
      d.repos.kv.delete(`nonce:${playerId}`);
      if (!fromWebOrigin(f, d.origins ?? []))
        return refuse('DOMAIN_MISMATCH', "the message must name this game's web origin");
      if (f.nonce !== stored.nonce)
        return refuse('NONCE_MISMATCH', 'the message does not carry the nonce issued last');
      const issuedAt = f.issuedAt.getTime();
      if (issuedAt > now + ISSUED_AT_SKEW_MS || (f.notBefore && f.notBefore.getTime() > now))
        return refuse('MESSAGE_NOT_YET_VALID', 'the message is not valid yet');
      if (issuedAt < now - NONCE_TTL_MS || (f.expirationTime && f.expirationTime.getTime() <= now))
        return refuse('MESSAGE_EXPIRED', 'the message has expired; sign a fresh one');
      let valid = false;
      try {
        valid = await verifyMessage({
          address: f.address,
          message,
          signature: signature as `0x${string}`,
        });
      } catch {
        valid = false;
      }
      if (!valid) return refuse('BAD_SIGNATURE', 'signature does not match the wallet');
      const wallet = f.address.toLowerCase();
      d.repos.tx(() => {
        // A different wallet invalidates the mirror agent key: it must be re-approved for the new one.
        if (d.repos.players.get(playerId)?.walletAddress?.toLowerCase() !== wallet)
          d.repos.agentKeys.remove(playerId);
        d.repos.players.setWallet(playerId, wallet);
      });
      const p = d.repos.players.get(playerId);
      if (!p) return refuse('BAD_SIGNATURE', 'unknown player');
      return { ok: true, player: playerView(p) };
    },
  };
}
