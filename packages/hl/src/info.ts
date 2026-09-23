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

const n = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : Number.NaN;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return Number.NaN;
    const parsed = Number(t);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
};

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
      if (!r.ok) return r;
      if (typeof r.value !== 'object' || r.value === null || Array.isArray(r.value)) {
        return none('malformed allMids');
      }
      const m = parseMids({ mids: r.value });
      // A well-shaped body that still parses to zero usable coins is indistinguishable from a
      // malformed one; never hand callers an empty snapshot as if it were real market data.
      if (Object.keys(m).length === 0) return none('malformed allMids');
      return some(m);
    },

    async clearinghouse(user) {
      const r = await post({ type: 'clearinghouseState', user });
      if (!r.ok) return r;
      try {
        const d = r.value as {
          assetPositions?: unknown;
          marginSummary?: { accountValue?: unknown };
          time?: unknown;
        } | null;
        const accountValue = n(d?.marginSummary?.accountValue);
        if (!d || !Number.isFinite(accountValue)) return none('malformed clearinghouseState');
        // `assetPositions` missing or non-array is malformed; only an actual empty array is a
        // legit flat account (no open positions).
        if (!Array.isArray(d.assetPositions)) return none('malformed clearinghouseState');
        const rawPositions = d.assetPositions;
        const positions: Position[] = [];
        for (const entry of rawPositions) {
          const p = (entry as { position?: unknown } | null)?.position;
          if (!p || typeof p !== 'object') return none('malformed clearinghouseState');
          const rec = p as Record<string, unknown>;
          const coin = rec.coin;
          if (typeof coin !== 'string' || coin.trim() === '') {
            return none(`malformed position for ${String(coin)}`);
          }
          const size = n(rec.szi);
          if (size === 0) continue; // HL sometimes lists closed coins at zero size; skip them
          const liqRaw = rec.liquidationPx;
          const liqPx = liqRaw === null || liqRaw === undefined || liqRaw === '' ? null : n(liqRaw);
          const entryPx = n(rec.entryPx);
          const leverage = n((rec.leverage as { value?: unknown } | undefined)?.value);
          const marginUsed = n(rec.marginUsed);
          const unrealizedPnl = n(rec.unrealizedPnl);
          const numericOk = [size, entryPx, leverage, marginUsed, unrealizedPnl].every(
            Number.isFinite,
          );
          const liqOk = liqPx === null || (Number.isFinite(liqPx) && liqPx > 0);
          if (!numericOk || !liqOk) return none(`malformed position for ${coin}`);
          positions.push({ coin, size, entryPx, liqPx, leverage, marginUsed, unrealizedPnl });
        }
        const time = n(d.time);
        return some({ positions, accountValue, time: Number.isFinite(time) ? time : null });
      } catch (e) {
        return none(`malformed clearinghouseState: ${e instanceof Error ? e.message : String(e)}`);
      }
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
