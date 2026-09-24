'use client';

import { countdown } from '../../lib/format';
import { useEngine, useEngineNow } from '../providers/engine';

export function SeasonClock() {
  const season = useEngine((s) => s.status?.season ?? null);
  const now = useEngineNow(30_000);
  if (!season) return null;
  return (
    <div className="ws-clock" aria-live="off">
      <b>{now === null ? '—' : countdown(season.endsAt - now)}</b>
      <span>left in Season {season.id}</span>
    </div>
  );
}
