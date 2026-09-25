/**
 * Anonymous player bootstrap. First visit: POST /api/players and keep the bearer token in
 * localStorage. Later visits: GET /api/me with the stored token; a 401 means the token is gone
 * (new engine database), so a fresh player is created. A network failure never creates a player.
 */
import type { Api, MeView } from './api';

export const TOKEN_KEY = 'ws.player.token';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type BootstrapResult =
  | { ok: true; token: string; me: MeView; created: boolean }
  | { ok: false; message: string };

export function safeStorage(): KeyValueStorage | null {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    const probe = '__ws_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

/**
 * Where the token lives when first-party storage is blocked: this tab's engine runtime, which
 * outlives any remount of the player tree, so a remount finds the tab's player instead of signing
 * up another one. The token is gone when the tab closes.
 */
export function tabStorage(ref: { current: string | null }): KeyValueStorage {
  return {
    getItem: (key) => (key === TOKEN_KEY ? ref.current : null),
    setItem: (key, value) => {
      if (key === TOKEN_KEY) ref.current = value;
    },
    removeItem: (key) => {
      if (key === TOKEN_KEY) ref.current = null;
    },
  };
}

function read(storage: KeyValueStorage | null): string | null {
  try {
    return storage?.getItem(TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

function write(storage: KeyValueStorage | null, token: string | null): void {
  try {
    if (!storage) return;
    if (token === null) storage.removeItem(TOKEN_KEY);
    else storage.setItem(TOKEN_KEY, token);
  } catch {
    /* private mode or blocked storage: the session lives in memory only */
  }
}

export async function bootstrapPlayer(
  api: Pick<Api, 'me' | 'createPlayer'>,
  storage: KeyValueStorage | null,
): Promise<BootstrapResult> {
  const stored = read(storage);
  if (stored) {
    const me = await api.me(stored);
    if (me.ok) return { ok: true, token: stored, me: me.data, created: false };
    if (me.status !== 401) return { ok: false, message: me.message };
    write(storage, null);
  }
  const created = await api.createPlayer();
  if (!created.ok) return { ok: false, message: created.message };
  write(storage, created.data.token);
  const me = await api.me(created.data.token);
  if (!me.ok) return { ok: false, message: me.message };
  return { ok: true, token: created.data.token, me: me.data, created: true };
}

/** Rank of a player in the leaderboard rows the client holds, or null when outside them. */
export function rankOf(
  rows: ReadonlyArray<{ playerId: string; rank: number }> | null,
  playerId: string | undefined,
): number | null {
  if (!rows || !playerId) return null;
  return rows.find((r) => r.playerId === playerId)?.rank ?? null;
}
