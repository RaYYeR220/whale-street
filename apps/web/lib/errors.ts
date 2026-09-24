import type { LinkErrorCode } from './api-types';

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

/** Wallet-link refusals: every engine code (contract-checked), plus the transport ones. */
const LINK: Record<
  LinkErrorCode | 'RATE_LIMITED' | 'UNAUTHORIZED' | 'NETWORK' | 'TIMEOUT',
  string
> = {
  INVALID_MESSAGE: 'The engine could not read the sign-in message. Reload the page and link again.',
  NO_NONCE: 'The sign-in request expired before it reached the engine. Link again.',
  DOMAIN_MISMATCH:
    'The engine does not accept wallet links from this web address. Open Whale Street from its own address and link again.',
  NONCE_MISMATCH: 'Another link was started in the meantime, maybe in another tab. Link again.',
  MESSAGE_EXPIRED: 'The signature arrived too late and expired. Link again and sign right away.',
  MESSAGE_NOT_YET_VALID:
    "Your device's clock runs ahead of the engine's. Correct the clock, then link again.",
  BAD_SIGNATURE: 'The signature does not match this wallet. Sign with the wallet shown here.',
  RATE_LIMITED: 'Too many link attempts from your network. Wait a minute and try again.',
  UNAUTHORIZED: 'Your player session expired. Reload the page.',
  NETWORK: 'Cannot reach the engine. Nothing was linked.',
  TIMEOUT: 'The engine did not answer in time. Check your desk before linking again.',
};

export function linkErrorText(code: string, message: string): string {
  return (LINK as Record<string, string>)[code] ?? message;
}
