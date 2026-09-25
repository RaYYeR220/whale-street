import { describe, expect, it } from 'vitest';
import type { Api } from '../lib/api';
import type { PlayerView } from '../lib/api-types';
import { bootstrapPlayer, type KeyValueStorage, rankOf, TOKEN_KEY } from '../lib/player';
import { portfolio } from './helpers';

const player: PlayerView = {
  id: 'p1',
  handle: 'Velvet Anchovy #412',
  kind: 'human',
  walletAddress: null,
  createdAt: 0,
};

function memoryStorage(
  init: Record<string, string> = {},
): KeyValueStorage & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

type Fake = Pick<Api, 'me' | 'createPlayer'> & { created: number };

function fakeApi(valid: Set<string>, reachable = true): Fake {
  const f: Fake = {
    created: 0,
    me: async (token) =>
      !reachable
        ? { ok: false, status: 0, error: 'NETWORK', message: 'cannot reach the engine' }
        : valid.has(token)
          ? { ok: true, data: { player, portfolio: portfolio(), seasons: [] } }
          : { ok: false, status: 401, error: 'UNAUTHORIZED', message: 'unknown token' },
    createPlayer: async () => {
      if (!reachable)
        return { ok: false, status: 0, error: 'NETWORK', message: 'cannot reach the engine' };
      f.created += 1;
      const token = `tok-${f.created}`;
      valid.add(token);
      return { ok: true, data: { player, token } };
    },
  };
  return f;
}

describe('anonymous player bootstrap', () => {
  it('creates a player on the first visit and stores the token', async () => {
    const storage = memoryStorage();
    const api = fakeApi(new Set());
    const r = await bootstrapPlayer(api, storage);
    expect(r).toMatchObject({ ok: true, token: 'tok-1', created: true });
    expect(storage.data[TOKEN_KEY]).toBe('tok-1');
  });

  it('reuses a stored token', async () => {
    const storage = memoryStorage({ [TOKEN_KEY]: 'kept' });
    const api = fakeApi(new Set(['kept']));
    const r = await bootstrapPlayer(api, storage);
    expect(r).toMatchObject({ ok: true, token: 'kept', created: false });
    expect(api.created).toBe(0);
  });

  it('replaces a token the engine no longer knows', async () => {
    const storage = memoryStorage({ [TOKEN_KEY]: 'stale' });
    const api = fakeApi(new Set());
    const r = await bootstrapPlayer(api, storage);
    expect(r).toMatchObject({ ok: true, token: 'tok-1', created: true });
    expect(storage.data[TOKEN_KEY]).toBe('tok-1');
  });

  it('never creates a player (or drops the token) when the engine is unreachable', async () => {
    const storage = memoryStorage({ [TOKEN_KEY]: 'kept' });
    const api = fakeApi(new Set(['kept']), false);
    const r = await bootstrapPlayer(api, storage);
    expect(r).toEqual({ ok: false, code: 'NETWORK', message: 'cannot reach the engine' });
    expect(api.created).toBe(0);
    expect(storage.data[TOKEN_KEY]).toBe('kept');
  });

  it('works without storage (private mode): the session lives in memory', async () => {
    const r = await bootstrapPlayer(fakeApi(new Set()), null);
    expect(r).toMatchObject({ ok: true, created: true });
  });

  it('rankOf reads the rank from the rows the client holds', () => {
    expect(rankOf([{ playerId: 'p1', rank: 7 }], 'p1')).toBe(7);
    expect(rankOf([{ playerId: 'p2', rank: 1 }], 'p1')).toBeNull();
    expect(rankOf(null, 'p1')).toBeNull();
  });
});
