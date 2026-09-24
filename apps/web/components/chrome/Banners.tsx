'use client';

import { useEffect, useState } from 'react';
import { useEngine } from '../providers/engine';

const STALL_MS = 5_000;

/** Global data-health strip: every degraded state is said out loud, never silently absorbed. */
export function Banners() {
  const connection = useEngine((s) => s.connection);
  const status = useEngine((s) => s.status);
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (connection !== 'connecting') {
      setStalled(false);
      return;
    }
    const id = setTimeout(() => setStalled(true), STALL_MS);
    return () => clearTimeout(id);
  }, [connection]);

  const items: Array<{ key: string; text: string; dots?: boolean }> = [];
  if (connection === 'limited')
    items.push({
      key: 'limit',
      text: 'Too many connections or messages from your network: the engine turned this tab away. Live updates resume by themselves in a minute or two; closing other Whale Street tabs helps.',
    });
  else if (connection === 'reconnecting')
    items.push({
      key: 'ws',
      text: 'Reconnecting to the floor. Prices will catch up when we are back.',
      dots: true,
    });
  else if (stalled)
    items.push({
      key: 'down',
      text: 'Cannot reach the engine. Nothing on this page updates until it answers.',
      dots: true,
    });
  if (status?.marksDelayed)
    items.push({
      key: 'marks',
      text: 'Hyperliquid prices are delayed: NAV is frozen, not guessed, until they return.',
    });
  if (status?.idle)
    items.push({
      key: 'idle',
      text: 'The floor was idle. Catching up with Nansen now.',
      dots: true,
    });
  if (status?.creditFloor)
    items.push({
      key: 'floor',
      text: 'Nansen credit floor reached: the IPO desk and the scout are paused.',
    });
  if (items.length === 0) return null;
  return (
    <div className="ws-banners">
      {items.map((b) => (
        <div key={b.key} className="ws-banner" role="status" data-banner={b.key}>
          {b.text}
          {b.dots ? (
            <>
              <i />
              <i />
              <i />
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
}
