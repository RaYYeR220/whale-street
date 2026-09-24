/** Mirror agent keys: generated in the browser, named, time-limited, never reused after expiry. */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { AgentRecord } from './keystore';

/** A named agent only replaces Hyperliquid's agent of the same name, so the user's HL web session survives. */
export const AGENT_BASE_NAME = 'whalestreet';
/** Hyperliquid allows agent approvals of up to 180 days. */
export const AGENT_VALID_DAYS = 180;
const DAY_MS = 86_400_000;
/** Re-approve a little before expiry so an order is never signed by a key about to lapse. */
export const RENEW_MARGIN_MS = DAY_MS;

export const agentName = (validUntil: number): string =>
  `${AGENT_BASE_NAME} valid_until ${validUntil}`;

export function newAgent(master: string, now: number, validDays = AGENT_VALID_DAYS): AgentRecord {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const validUntil = now + Math.min(validDays, AGENT_VALID_DAYS) * DAY_MS;
  return {
    master: master.toLowerCase(),
    agentAddress: account.address,
    privateKey,
    agentName: agentName(validUntil),
    validUntil,
    createdAt: now,
    approvedAt: null,
  };
}

/** Approved and not about to expire. */
export function isUsable(r: AgentRecord | null, now: number): r is AgentRecord {
  return !!r && r.approvedAt !== null && r.validUntil - RENEW_MARGIN_MS > now;
}
