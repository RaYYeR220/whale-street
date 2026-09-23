import {
  type Address,
  type Marks,
  type Maybe,
  none,
  type Position,
  some,
} from '@whale-street/core';
import { parseMids } from './feed';

export interface HlPerpState {
  positions: Position[];
  accountValue: number;
  time: number | null;
}

export interface HlInfo {
  allMids(): Promise<Maybe<Marks>>;
  clearinghouse(user: Address): Promise<Maybe<HlPerpState>>;
  isVault(address: Address): Promise<Maybe<boolean>>;
}

const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v));

export function createHlInfo(
  o: { url?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
): HlInfo {
  const url = o.url ?? 'https://api.hyperliquid.xyz/info';
  const f = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? 10_000;

  async function post(body: unknown): Promise<Maybe<unknown>> {
    try {
      const res = await f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) return none(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      return some(JSON.parse(text) as unknown);
    } catch (e) {
      return none(e instanceof Error ? e.message : String(e));
    }
  }

  return {
    async allMids() {
      const r = await post({ type: 'allMids' });
      return r.ok ? some(parseMids({ mids: r.value })) : r;
    },

    async clearinghouse(user) {
      const r = await post({ type: 'clearinghouseState', user });
      if (!r.ok) return r;
      const d = r.value as {
        assetPositions?: Array<{ position: Record<string, unknown> }>;
        marginSummary?: { accountValue?: unknown };
        time?: unknown;
      } | null;
      const accountValue = n(d?.marginSummary?.accountValue);
      if (!d || !Number.isFinite(accountValue)) return none('malformed clearinghouseState');
      const positions: Position[] = [];
      for (const { position: p } of d.assetPositions ?? []) {
        const liq = p.liquidationPx;
        const lev = (p.leverage as { value?: unknown } | undefined)?.value;
        const pos: Position = {
          coin: String(p.coin),
          size: n(p.szi),
          entryPx: n(p.entryPx),
          liqPx: liq === null || liq === undefined || liq === '' ? null : n(liq),
          leverage: n(lev),
          marginUsed: n(p.marginUsed),
          unrealizedPnl: n(p.unrealizedPnl),
        };
        if (
          ![pos.size, pos.entryPx, pos.leverage, pos.marginUsed, pos.unrealizedPnl].every(
            Number.isFinite,
          )
        ) {
          return none(`malformed position for ${pos.coin}`);
        }
        positions.push(pos);
      }
      const time = n(d.time);
      return some({ positions, accountValue, time: Number.isFinite(time) ? time : null });
    },

    async isVault(address) {
      const r = await post({ type: 'vaultDetails', vaultAddress: address });
      if (!r.ok) return r;
      if (r.value === null) return some(false);
      if (typeof r.value === 'object' && r.value !== null && 'vaultAddress' in r.value)
        return some(true);
      return none('unexpected vaultDetails response');
    },
  };
}
