'use client';

import { usd } from '../../lib/format';
import { Portrait } from '../ink/Portrait';
import { usePlayer } from '../providers/player';
import { useDrawer } from './Drawer';

/** Handle, net worth and rank; opens the portfolio drawer. */
export function PlayerChip() {
  const { status, player, portfolio, rank } = usePlayer();
  const { open } = useDrawer();
  // When net worth is unknown, say why in words (not only in a hover tooltip).
  const why = portfolio && portfolio.netWorth === null ? portfolio.netWorthReason : null;
  const label =
    status === 'ready' && player
      ? `Your desk: ${player.handle}, net worth ${usd(portfolio?.netWorth)}${why ? ` (${why})` : ''}${rank !== null ? `, rank ${rank}` : ''}`
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
        <b>{player?.handle ?? (status === 'offline' ? 'Offline' : 'Signing in…')}</b>
        <span title={why ?? undefined}>
          {usd(portfolio?.netWorth)}
          {why ? <span className="ws-player__rank">, {why}</span> : null}
          {rank !== null ? <span className="ws-player__rank">, rank {rank}</span> : null}
        </span>
      </span>
    </button>
  );
}
