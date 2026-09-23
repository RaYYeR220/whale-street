import { type Address, type Marks, type Maybe, none, some } from '@whale-street/core';
import type { FeedStatus, HlFeed, HlInfo, HlPerpState, HlTrade } from '@whale-street/hl';

/** Programmable HlInfo. Unknown users are flat accounts with zero equity. */
export class FakeInfo implements HlInfo {
  readonly states = new Map<string, HlPerpState | string>();
  readonly vaults = new Map<string, boolean | string>();
  readonly calls: string[] = [];
  mids: Marks = {};

  async allMids(): Promise<Maybe<Marks>> {
    this.calls.push('allMids');
    return some(this.mids);
  }
  async clearinghouse(user: Address): Promise<Maybe<HlPerpState>> {
    this.calls.push(`clearinghouse:${user}`);
    const s = this.states.get(user);
    if (typeof s === 'string') return none(s);
    return some(s ?? { positions: [], accountValue: 0, time: null });
  }
  async isVault(address: Address): Promise<Maybe<boolean>> {
    this.calls.push(`isVault:${address}`);
    const v = this.vaults.get(address);
    if (typeof v === 'string') return none(v);
    return some(v ?? false);
  }
}

/** HlFeed driven by the test: call emitMids / emitTrades. */
export class FakeFeed implements HlFeed {
  private readonly midsCbs = new Set<(m: Marks, at: number) => void>();
  private readonly tradesCbs = new Set<(t: HlTrade[]) => void>();
  private readonly statusCbs = new Set<(s: FeedStatus) => void>();
  coins: string[] = [];
  running = false;

  onMids(cb: (m: Marks, at: number) => void) {
    this.midsCbs.add(cb);
    return () => {
      this.midsCbs.delete(cb);
    };
  }
  onTrades(cb: (t: HlTrade[]) => void) {
    this.tradesCbs.add(cb);
    return () => {
      this.tradesCbs.delete(cb);
    };
  }
  onStatus(cb: (s: FeedStatus) => void) {
    this.statusCbs.add(cb);
    return () => {
      this.statusCbs.delete(cb);
    };
  }
  setTradeCoins(coins: readonly string[]) {
    this.coins = [...coins].sort();
  }
  start() {
    this.running = true;
    for (const cb of this.statusCbs) cb('open');
  }
  stop() {
    this.running = false;
    for (const cb of this.statusCbs) cb('closed');
  }
  emitMids(m: Marks, at: number) {
    for (const cb of this.midsCbs) cb(m, at);
  }
  emitTrades(t: HlTrade[]) {
    for (const cb of this.tradesCbs) cb(t);
  }
}

export const hlTrade = (coin: string, users: [string, string], time = 0): HlTrade => ({
  coin,
  side: 'B',
  px: 1,
  sz: 1,
  time,
  hash: `0x${time.toString(16)}`,
  users,
});
