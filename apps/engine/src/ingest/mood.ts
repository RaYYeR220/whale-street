import type { Clock } from '../clock';
import type { Logger } from '../log';
import type { MarketState } from '../market/state';
import type { NansenPort } from '../ports';

export const MOOD_COINS = 6;

/** Coins with the largest total notional across listed companies. */
export function topCoinsByNotional(state: MarketState, n: number = MOOD_COINS): string[] {
  const notional = new Map<string, number>();
  for (const rt of state.listed()) {
    for (const p of rt.nav.snapshot.positions) {
      const px = state.marks[p.coin] ?? p.entryPx;
      notional.set(p.coin, (notional.get(p.coin) ?? 0) + Math.abs(p.size) * px);
    }
  }
  return [...notional.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n)
    .map(([coin]) => coin);
}

/** Street mood: Nansen position-intelligence (cohort positioning) for the top coins; 1 credit per coin. */
export async function refreshMood(d: {
  nansen: NansenPort;
  state: MarketState;
  clock: Clock;
  log: Logger;
}): Promise<void> {
  for (const coin of topCoinsByNotional(d.state)) {
    const r = await d.nansen.positionIntelligence(coin);
    if (r.ok) d.state.mood.set(coin, r.value);
    else d.log.warn('mood fetch failed', { coin, error: r.error });
  }
  d.state.moodAt = d.clock.now();
}
