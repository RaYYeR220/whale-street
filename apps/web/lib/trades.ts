/** One line per play-money trade, as the desk and the profile list them. */
import type { TradeRowView } from './api-types';
import { price, shares, usd } from './format';

export const PAST: Record<TradeRowView['side'], string> = {
  BUY: 'Bought',
  SELL: 'Sold',
  SHORT: 'Shorted',
  COVER: 'Covered',
  SETTLE: 'Settled',
};

/**
 * "Covered 4 GBC at 250.00 (auto), $12.50 written off: …". A forced cover whose buyback cost more
 * than the short's collateral writes the excess off (a short's loss stops at its collateral).
 */
export function tradeText(
  t: Pick<TradeRowView, 'side' | 'qty' | 'ticker' | 'avgPrice' | 'forced' | 'writeOffUsd'>,
): string {
  const base = `${PAST[t.side]} ${shares(t.qty)} ${t.ticker} at ${price(t.avgPrice)}${t.forced ? ' (auto)' : ''}`;
  return t.writeOffUsd > 0
    ? `${base}, ${usd(t.writeOffUsd)} written off: the loss stops at the collateral`
    : base;
}
