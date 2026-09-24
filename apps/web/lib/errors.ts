/** Player-facing wording for engine error codes (the engine's own message is kept as detail). */
const ORDER: Record<string, string> = {
  COMPANY_NOT_TRADING: 'Trading is paused for this company.',
  INVALID_QTY: 'Enter a positive amount.',
  INVALID_NAV: 'This company has no valid NAV right now, so nobody can trade it at a fair price.',
  INSUFFICIENT_CASH: 'Not enough cash.',
  INSUFFICIENT_SHARES: "You don't hold that many shares.",
  INSUFFICIENT_LIQUIDITY: 'Too large for the pool. Try a smaller order.',
  COVER_SHORT_FIRST: 'Cover your short before buying.',
  CLOSE_LONG_FIRST: 'Sell your shares before shorting.',
  IPO_ALLOCATION_EXCEEDED:
    'IPO allocation used up: at most 10% of season cash in the first minute.',
  UNKNOWN_TICKER: 'That company is not listed.',
  RATE_LIMITED: 'Too many orders at once. Wait a second.',
  UNAUTHORIZED: 'Your player session expired. Reload the page.',
  NETWORK: 'Cannot reach the engine. Nothing was traded.',
  TIMEOUT: 'The engine did not answer in time. Check your desk before trying again.',
};

export function orderErrorText(code: string, message: string): string {
  return ORDER[code] ?? message;
}

const IPO: Record<string, string> = {
  INVALID_ADDRESS: 'That is not a Hyperliquid address. It starts with 0x and has 42 characters.',
  RATE_LIMITED:
    'The committee takes at most 3 applications an hour from one player. Try again later.',
  UNAUTHORIZED: 'Your player session expired. Reload the page.',
  NETWORK: 'Cannot reach the engine. Nothing was sent.',
};

export function ipoErrorText(code: string, message: string): string {
  return IPO[code] ?? message;
}
