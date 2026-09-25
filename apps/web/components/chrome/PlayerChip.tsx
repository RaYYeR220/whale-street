'use client';

import { usd } from '../../lib/format';
import { Portrait } from '../ink/Portrait';
import { usePlayer } from '../providers/player';
import { useDrawer } from './Drawer';

/** Visible length of the net-worth reason in the compact chip (the label and tooltip keep it whole). */
const CHIP_REASON_CHARS = 26;
const clip = (t: string) =>
  t.length > CHIP_REASON_CHARS ? `${t.slice(0, CHIP_REASON_CHARS).trimEnd()}…` : t;

/** Handle, net worth and rank (or why there is no player yet); opens the portfolio drawer. */
export function PlayerChip() {
  const { status, player, portfolio, rank, error } = usePlayer();
  const { open } = useDrawer();
  // When net worth is unknown, say why in words (not only in a hover tooltip).
  const why = portfolio && portfolio.netWorth === null ? portfolio.netWorthReason : null;
  const label =
    status === 'ready' && player
      ? `Your desk: ${player.handle}, net worth ${usd(portfolio?.netWorth)}${why ? ` (${why})` : ''}${rank !== null ? `, rank ${rank}` : ''}`
      : status === 'offline'
        ? `Your desk: no player yet. ${error ?? 'The engine did not answer.'} Trying again by itself.`
        : 'Your desk';
  return (
    <button
      className="ws-player"
      type="button"
      aria-haspopup="dialog"
      aria-label={label}
      onClick={() => open({ kind: 'desk' })}
    >
      <span className="ws-player__face">
        {player ? <Portrait seed={player.handle} hp={0.8} size={48} label="Your avatar" /> : null}
      </span>
      <span className="ws-player__t">
        <b>{player?.handle ?? (status === 'offline' ? 'No player yet' : 'Signing in…')}</b>
        {status === 'offline' ? (
          <span className="ws-player__rank" title={error ?? undefined}>
            {clip(error ?? 'The engine did not answer.')}
          </span>
        ) : (
          <span title={why ?? undefined}>
            {usd(portfolio?.netWorth)}
            {why ? <span className="ws-player__rank">, {clip(why)}</span> : null}
            {rank !== null ? <span className="ws-player__rank">, rank {rank}</span> : null}
          </span>
        )}
      </span>
    </button>
  );
}
