import type { Address, PnlStats } from '@whale-street/core';
import type {
  AccountInfo,
  ApiResult,
  CohortPositioning,
  Counterparty,
  FirstFunder,
  LeaderboardRow,
  PerpState,
  PerpTradeRow,
  RelatedWallet,
  SmPerpTrade,
} from '@whale-street/nansen';
import type { NansenPort } from '../../src/ports';

/** Marks a programmed reply as a failed call. */
export class Fail {
  constructor(readonly error: string) {}
}
export const fail = (error = 'HTTP 500: upstream error') => new Fail(error);

type Reply<T> = T | Fail;

/** Programmable in-memory NansenPort. Unprogrammed calls fail with 404 (fail-closed). */
export class FakeNansen implements NansenPort {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  readonly positions = new Map<string, Reply<PerpState>>();
  readonly pnl = new Map<string, Reply<PnlStats>>();
  readonly firstTrades = new Map<string, Reply<PerpTradeRow[]>>();
  readonly topTrades = new Map<string, Reply<PerpTradeRow[]>>();
  readonly related = new Map<string, Reply<RelatedWallet[]>>();
  readonly funders = new Map<string, Reply<FirstFunder>>();
  readonly counterpartyLists = new Map<string, Reply<Counterparty[]>>();
  readonly cohorts = new Map<string, Reply<CohortPositioning>>();
  leaderboard: Reply<LeaderboardRow[]> = [];
  smTrades: Reply<SmPerpTrade[]> = [];
  accountInfo: Reply<AccountInfo> = { plan: 'free', creditsRemaining: 10_000 };
  private seq = 0;

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  private reply<T>(
    method: string,
    args: unknown[],
    v: Reply<T> | undefined,
  ): Promise<ApiResult<T>> {
    this.calls.push({ method, args });
    const callId = `nc_fake_${++this.seq}`;
    if (v === undefined)
      return Promise.resolve({ ok: false, error: 'HTTP 404: not programmed', status: 404, callId });
    if (v instanceof Fail)
      return Promise.resolve({ ok: false, error: v.error, status: 500, callId });
    return Promise.resolve({ ok: true, value: v, callId });
  }

  perpPositions(a: Address) {
    return this.reply('perpPositions', [a], this.positions.get(a));
  }
  perpPnlSummary(a: Address, from: string, to: string) {
    return this.reply('perpPnlSummary', [a, from, to], this.pnl.get(a));
  }
  perpTrades(
    a: Address,
    from: string,
    to: string,
    o: { orderBy?: 'timestamp' | 'closed_pnl'; direction?: 'ASC' | 'DESC'; perPage?: number } = {},
  ) {
    const src = o.orderBy === 'closed_pnl' ? this.topTrades : this.firstTrades;
    return this.reply('perpTrades', [a, from, to, o], src.get(a));
  }
  perpLeaderboard(from: string, to: string, perPage?: number) {
    return this.reply('perpLeaderboard', [from, to, perPage], this.leaderboard);
  }
  smartMoneyPerpTrades(lookbackHours: number, onlyNewPositions: boolean, perPage?: number) {
    return this.reply(
      'smartMoneyPerpTrades',
      [lookbackHours, onlyNewPositions, perPage],
      this.smTrades,
    );
  }
  positionIntelligence(coin: string) {
    return this.reply('positionIntelligence', [coin], this.cohorts.get(coin));
  }
  relatedWallets(a: Address, chain: string) {
    return this.reply('relatedWallets', [a, chain], this.related.get(a) ?? []);
  }
  firstFunder(a: Address) {
    return this.reply(
      'firstFunder',
      [a],
      this.funders.get(a) ?? { funder: null, funderName: null },
    );
  }
  counterparties(a: Address, chain: string, from: string, to: string, perPage?: number) {
    return this.reply(
      'counterparties',
      [a, chain, from, to, perPage],
      this.counterpartyLists.get(a) ?? [],
    );
  }
  account() {
    return this.reply('account', [], this.accountInfo);
  }
}
