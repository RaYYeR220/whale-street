'use client';

import { countdown } from '../../lib/format';
import { useEngine, useEngineNow } from '../providers/engine';

/** Season countdown on engine time; in REPLAY the looping recording only runs a practice season. */
export function SeasonClock() {
  const season = useEngine((s) => s.status?.season ?? null);
  const replay = useEngine((s) => s.status?.mode === 'replay');
  const now = useEngineNow(30_000);
  if (!season) return null;
  return (
    <div className="ws-clock" aria-live="off">
      <b>{now === null ? '—' : countdown(season.endsAt - now)}</b>
      <span>{replay ? 'left in the practice season (replay)' : `left in Season ${season.id}`}</span>
    </div>
  );
}
