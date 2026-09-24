'use client';

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { type Api, createApi } from '../../lib/api';
import type { Channel, CompanyView } from '../../lib/api-types';
import { engineUrl, wsUrlFor } from '../../lib/config';
import {
  createEngineStore,
  type EngineState,
  type EngineStore,
  engineNow,
  INITIAL_STATE,
} from '../../lib/store';
import { EngineSocket } from '../../lib/ws-client';

export interface EngineRuntime {
  api: Api;
  socket: EngineSocket;
  store: EngineStore;
  /** Current player token (read lazily by the socket's hello). */
  tokenRef: { current: string | null };
}

const EngineContext = createContext<EngineRuntime | null>(null);

export function createEngineRuntime(base: string = engineUrl()): EngineRuntime {
  const tokenRef = { current: null as string | null };
  return {
    api: createApi(base),
    store: createEngineStore(),
    socket: new EngineSocket({ url: wsUrlFor(base), token: () => tokenRef.current }),
    tokenRef,
  };
}

/** One engine connection per tab. `runtime` is injectable for tests. */
export function EngineProvider({
  children,
  runtime: injected,
}: {
  children: ReactNode;
  runtime?: EngineRuntime;
}) {
  const [runtime] = useState<EngineRuntime>(() => injected ?? createEngineRuntime());

  useEffect(() => {
    const { socket, store } = runtime;
    const offMsg = socket.onMessage((m) => store.dispatch(m));
    const offState = socket.onState((s) => store.setConnection(s));
    socket.start();
    return () => {
      offMsg();
      offState();
      socket.stop();
    };
  }, [runtime]);

  return <EngineContext.Provider value={runtime}>{children}</EngineContext.Provider>;
}

export function useEngineRuntime(): EngineRuntime {
  const r = useContext(EngineContext);
  if (!r) throw new Error('useEngineRuntime must be used inside <EngineProvider>');
  return r;
}

export function useApi(): Api {
  return useEngineRuntime().api;
}

/** Subscribes to a slice of the live engine state. The selector must return stable references. */
export function useEngine<T>(selector: (s: EngineState) => T): T {
  const { store } = useEngineRuntime();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(INITIAL_STATE),
  );
}

/** Keeps the given WebSocket channels subscribed while the component is mounted. */
export function useChannels(channels: readonly Channel[]): void {
  const { socket } = useEngineRuntime();
  const key = [...channels].sort().join(',');
  useEffect(() => {
    const release = socket.subscribe(key.split(',').filter(Boolean) as Channel[]);
    return release;
  }, [socket, key]);
}

/**
 * Engine time (ms) from status.now and the 1 Hz market frames, run on between them so clocks tick
 * smoothly. Every age, countdown and season clock reads it: in REPLAY it is the recorded session's
 * clock, never the browser's. Null before the engine has said what time it is.
 */
export function useEngineNow(stepMs = 1_000): number | null {
  const { store } = useEngineRuntime();
  const market = useEngine((s) => s.market);
  const status = useEngine((s) => s.status);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(engineNow(store.getState(), Date.now()));
    tick();
    const id = setInterval(tick, stepMs);
    return () => clearInterval(id);
  }, [store, stepMs]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new frame or status re-reads the time
  useEffect(() => {
    setNow(engineNow(store.getState(), Date.now()));
  }, [store, market, status]);
  return now;
}

/** True once the component has mounted in the browser (for values that must not render on the server). */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

export const VIEWS_REFRESH_MS = 30_000;

/**
 * REST company views (name, rating, positions, prospectus, IPO window), kept fresh: on mount,
 * every 30 s, shortly after any new filing, and whenever a company appears or disappears.
 */
export function useCompanyViews(
  initial?: readonly CompanyView[],
): Readonly<Record<string, CompanyView>> {
  const { api, store } = useEngineRuntime();
  const views = useEngine((s) => s.views);
  const loaded = useEngine((s) => s.viewsAt !== null);
  const filingsHead = useEngine((s) => s.filings[0]?.id ?? null);
  const count = useEngine((s) => s.market?.companies.length ?? null);
  const fallback = useMemo(() => {
    const m: Record<string, CompanyView> = {};
    for (const v of initial ?? []) m[v.ticker] = v;
    return m;
  }, [initial]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const r = await api.companies();
      if (!cancelled && r.ok) store.setViews(r.data.companies, Date.now());
    };
    const t = setTimeout(load, filingsHead === null && count === null ? 0 : 1_500);
    const id = setInterval(load, VIEWS_REFRESH_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
      clearInterval(id);
    };
  }, [api, store, filingsHead, count]);
  return loaded ? views : fallback;
}

/**
 * Seeds the last hour of NAV and price for each ticker from REST, so sparks and 1h changes are
 * right on first paint instead of starting from the page load. Refetches after a replay loop.
 */
export function useHourHistory(tickers: readonly string[]): void {
  const { api, store } = useEngineRuntime();
  const epoch = useEngine((s) => s.epoch);
  const key = [...tickers].sort().join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: key stands for the ticker list
  useEffect(() => {
    let cancelled = false;
    for (const t of key ? key.split(',') : []) {
      void api.history(t, 60).then((r) => {
        if (!cancelled && r.ok) store.seedSeries(t, r.data.points);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [api, store, key, epoch]);
}
