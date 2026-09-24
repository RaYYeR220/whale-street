import type { IpoApplyErrorCode, LinkErrorCode, MirrorErrorCode } from './api-types';

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
  MARKET_PAUSED:
    'The market is still paused while prices catch up. Nothing was traded; try again in a moment.',
  UNAUTHORIZED: 'Your player session expired. Reload the page.',
  NETWORK: 'Cannot reach the engine. Nothing was traded.',
  TIMEOUT: 'The engine did not answer in time. Check your desk before trying again.',
};

export function orderErrorText(code: string, message: string): string {
  return ORDER[code] ?? message;
}

/** IPO desk refusals: every engine code (contract-checked), plus the transport ones. */
const IPO: Record<IpoApplyErrorCode | 'UNAUTHORIZED' | 'NETWORK', string> = {
  INVALID_ADDRESS: 'That is not a Hyperliquid address. It starts with 0x and has 42 characters.',
  RATE_LIMITED:
    'The committee takes at most 3 applications an hour from one player. Try again later.',
  IPO_DESK_BUSY:
    'The IPO desk is full for this hour: it takes a limited number of applications per hour, across the desk and per network. Try again later.',
  ALREADY_LISTED: 'This trader is already listed on the floor.',
  COOLING_DOWN:
    'This trader is cooling down after a bankruptcy on the floor and cannot list again yet.',
  RECENTLY_DENIED:
    'The committee denied this address in the last 7 days. It can apply again after that.',
  UNAUTHORIZED: 'Your player session expired. Reload the page.',
  NETWORK: 'Cannot reach the engine. Nothing was sent.',
};

export function ipoErrorText(code: string, message: string): string {
  if (code === 'ALREADY_LISTED') {
    const ticker = message.match(/already listed as (\S+)/)?.[1];
    if (ticker) return `This trader is already listed on the floor as ${ticker}.`;
  }
  return (IPO as Record<string, string>)[code] ?? message;
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

/**
 * Mirror route errors: every engine code (contract-checked). REJECTED keeps Hyperliquid's own
 * words (margin, size, ...), which say more than any sentence of ours.
 */
const MIRROR: Record<Exclude<MirrorErrorCode, 'REJECTED'>, string> = {
  TRADING_UNAVAILABLE: 'Mirror trading is off on this engine right now. Nothing was sent.',
  REGION_BLOCKED: 'Real orders cannot be placed from the engine’s region right now.',
  NO_WALLET: 'Your player is linked to another wallet now. Link this wallet again first.',
  WALLET_IN_USE:
    'This wallet mirrors through another Whale Street player. Link it to this player first (one free signature), then approve its agent key here; the other player loses its key.',
  NO_AGENT: 'The engine has no agent key on record for this wallet. Approve the agent key again.',
  UNKNOWN_TICKER: 'That company is no longer listed. Nothing was sent.',
  INVALID_ADDRESS: 'That wallet address is not valid.',
  PREPARE_FAILED:
    'The Nansen Trading API could not prepare the order. Nothing was signed; try again in a minute.',
  ACTION_MISMATCH:
    'The prepared order did not match what you asked for, so nothing was signed or sent.',
  NOT_FOUND: 'The engine has no record of this step. Nothing was sent.',
  BAD_STATE: 'This step was already sent or refused, so it was not sent again.',
  EXPIRED: 'The prepared order expired before it was sent. Send it again.',
  BAD_SIGNATURE: 'The engine did not accept this agent key’s signature.',
  POLICY_CHANGED:
    'The trader or the market moved between the check and the send, so nothing was sent.',
  UPSTREAM_FAILED: 'Hyperliquid or Nansen did not answer. Try again in a minute.',
};

export function mirrorErrorText(code: string, message: string): string {
  return (MIRROR as Record<string, string>)[code] ?? message;
}
