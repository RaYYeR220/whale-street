'use client';

import { dayLabel } from '../../lib/format';
import { useEngine } from '../providers/engine';

/** LIVE (mint dot), REPLAY (blue, with the recording date) and the credit-saver note. Never hidden. */
export function ModeBadge() {
  const status = useEngine((s) => s.status);
  const connection = useEngine((s) => s.connection);
  if (!status)
    return (
      <span
        className="ws-badge ws-badge--saver"
        title="Waiting for the engine to report its mode"
        data-short={connection === 'reconnecting' ? 'OFF' : '…'}
      >
        {connection === 'reconnecting' ? 'OFFLINE' : 'CONNECTING'}
      </span>
    );
  return (
    <>
      {status.mode === 'live' ? (
        <span
          className="ws-badge ws-badge--live"
          title="Prices move with live Nansen data"
          data-mode="live"
        >
          LIVE
        </span>
      ) : (
        <span
          className="ws-badge ws-badge--replay"
          data-mode="replay"
          data-short="REPLAY"
          title="Replaying a recorded session: no Nansen key is used and nothing here is live"
        >
          {status.synthetic
            ? 'REPLAY · synthetic demo'
            : `REPLAY · recorded ${status.recordedAt !== null ? dayLabel(status.recordedAt) : 'session'}`}
        </span>
      )}
      {status.creditSaver ? (
        <span
          className="ws-badge ws-badge--saver"
          title="Nansen credits are low: live positions are read from Hyperliquid directly"
          data-short="SAVER"
        >
          CREDIT-SAVER: positions via Hyperliquid
        </span>
      ) : null}
    </>
  );
}
