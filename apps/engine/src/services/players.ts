import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { isAddress } from '@whale-street/nansen';
import { verifyMessage } from 'viem';
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

export interface PlayerView {
  id: string;
  handle: string;
  kind: PlayerKind;
  walletAddress: string | null;
  createdAt: number;
}

export type LinkResult =
  | { ok: true; player: PlayerView }
  | { ok: false; code: 'INVALID_ADDRESS' | 'NO_NONCE' | 'BAD_SIGNATURE'; message: string };

export interface PlayersService {
  create(kind: 'human' | 'agent', name?: string): { player: PlayerView; token: string };
  /** Idempotent: creates the bot player on first call (bots have no bearer token). */
  ensureBot(id: string, handle: string): PlayerView;
  auth(token: string | null | undefined): PlayerView | null;
  get(id: string): PlayerView | null;
  nonce(playerId: string): string;
  link(playerId: string, address: string, signature: string): Promise<LinkResult>;
}

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** The exact personal_sign message the browser signs to link a wallet. */
export const linkMessage = (address: string, nonce: string): string =>
  `Whale Street: link wallet ${address.toLowerCase()} nonce ${nonce}`;

export const playerView = (p: PlayerRow): PlayerView => ({
  id: p.id,
  handle: p.handle,
  kind: p.kind,
  walletAddress: p.walletAddress,
  createdAt: p.createdAt,
});

const pick = <T>(xs: readonly T[]): T => xs[randomInt(xs.length)] as T;

export function createPlayersService(d: { repos: Repos; clock: Clock }): PlayersService {
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
      d.repos.kv.setJson(`nonce:${playerId}`, { nonce, exp: d.clock.now() + NONCE_TTL_MS });
      return nonce;
    },
    async link(playerId, address, signature) {
      if (!isAddress(address))
        return { ok: false, code: 'INVALID_ADDRESS', message: 'invalid wallet address' };
      const stored = d.repos.kv.getJson<{ nonce: string; exp: number }>(`nonce:${playerId}`);
      if (!stored || stored.exp < d.clock.now()) {
        return { ok: false, code: 'NO_NONCE', message: 'request a fresh nonce first' };
      }
      d.repos.kv.delete(`nonce:${playerId}`);
      let valid = false;
      try {
        valid = await verifyMessage({
          address,
          message: linkMessage(address, stored.nonce),
          signature: signature as `0x${string}`,
        });
      } catch {
        valid = false;
      }
      if (!valid)
        return { ok: false, code: 'BAD_SIGNATURE', message: 'signature does not match the wallet' };
      d.repos.players.setWallet(playerId, address.toLowerCase());
      const p = d.repos.players.get(playerId);
      if (!p) return { ok: false, code: 'BAD_SIGNATURE', message: 'unknown player' };
      return { ok: true, player: playerView(p) };
    },
  };
}
