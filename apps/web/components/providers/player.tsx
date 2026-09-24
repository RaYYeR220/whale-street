'use client';

import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import type { PlayerView, PortfolioView, SeasonResultRow } from '../../lib/api-types';
import { bootstrapPlayer, rankOf, safeStorage } from '../../lib/player';
import { useChannels, useEngine, useEngineRuntime } from './engine';

export interface PlayerContextValue {
  status: 'loading' | 'ready' | 'offline';
  token: string | null;
  player: PlayerView | null;
  portfolio: PortfolioView | null;
  seasons: SeasonResultRow[];
  rank: number | null;
  error: string | null;
  retry(): void;
  /** Re-reads /api/me (after a wallet link, an order, a season rollover). */
  refresh(): Promise<void>;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const { api, socket, store, tokenRef } = useEngineRuntime();
  const [status, setStatus] = useState<PlayerContextValue['status']>('loading');
  const [token, setToken] = useState<string | null>(null);
  const [player, setPlayer] = useState<PlayerView | null>(null);
  const [seasons, setSeasons] = useState<SeasonResultRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const portfolio = useEngine((s) => s.portfolio);
  const leaderboard = useEngine((s) => s.leaderboard);
  useChannels(['player', 'leaderboard']);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the bootstrap on retry
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    void bootstrapPlayer(api, safeStorage()).then((r) => {
      if (cancelled) return;
      if (!r.ok) {
        setStatus('offline');
        setError(r.message);
        return;
      }
      tokenRef.current = r.token;
      setToken(r.token);
      setPlayer(r.me.player);
      setSeasons(r.me.seasons);
      store.setPortfolio(r.me.portfolio);
      setError(null);
      setStatus('ready');
      socket.rehello();
    });
    return () => {
      cancelled = true;
    };
  }, [api, socket, store, tokenRef, attempt]);

  const refresh = useCallback(async () => {
    const t = tokenRef.current;
    if (!t) return;
    const me = await api.me(t);
    if (!me.ok) return;
    setPlayer(me.data.player);
    setSeasons(me.data.seasons);
    store.setPortfolio(me.data.portfolio);
  }, [api, store, tokenRef]);

  const value: PlayerContextValue = {
    status,
    token,
    player,
    portfolio,
    seasons,
    rank: rankOf(leaderboard, player?.id),
    error,
    retry: () => setAttempt((n) => n + 1),
    refresh,
  };
  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayer(): PlayerContextValue {
  const v = useContext(PlayerContext);
  if (!v) throw new Error('usePlayer must be used inside <PlayerProvider>');
  return v;
}
