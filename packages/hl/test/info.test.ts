import { describe, expect, it } from 'vitest';
import { createHlInfo } from '../src/index';

const U = '0x00000000000000000000000000000000000000dd' as const;
function infoWith(replies: Array<{ status: number; body: unknown }>, seen: unknown[] = []) {
  const f = (async (_u: string | URL | Request, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body)));
    const r = replies.shift();
    if (!r) throw new Error('no reply');
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return createHlInfo({ fetch: f });
}

describe('HlInfo', () => {
  it('allMids', async () => {
    const seen: unknown[] = [];
    const r = await infoWith([{ status: 200, body: { BTC: '64000', '@7': '1' } }], seen).allMids();
    expect(seen[0]).toEqual({ type: 'allMids' });
    expect(r).toEqual({ ok: true, value: { BTC: 64_000 } });
  });

  it('clearinghouse maps positions', async () => {
    const seen: unknown[] = [];
    const body = {
      assetPositions: [
        {
          type: 'oneWay',
          position: {
            coin: 'ETH',
            szi: '-2',
            entryPx: '2500',
            liquidationPx: null,
            leverage: { type: 'cross', value: 5 },
            marginUsed: '1000',
            unrealizedPnl: '30',
          },
        },
      ],
      marginSummary: { accountValue: '12000.5' },
      time: 1_758_000_000_000,
    };
    const r = await infoWith([{ status: 200, body }], seen).clearinghouse(U);
    expect(seen[0]).toEqual({ type: 'clearinghouseState', user: U });
    expect(r).toEqual({
      ok: true,
      value: {
        accountValue: 12_000.5,
        time: 1_758_000_000_000,
        positions: [
          {
            coin: 'ETH',
            size: -2,
            entryPx: 2_500,
            liqPx: null,
            leverage: 5,
            marginUsed: 1_000,
            unrealizedPnl: 30,
          },
        ],
      },
    });
  });

  it('isVault: null → false, object → true, error → none', async () => {
    expect(await infoWith([{ status: 200, body: null }]).isVault(U)).toEqual({
      ok: true,
      value: false,
    });
    expect(
      await infoWith([{ status: 200, body: { vaultAddress: U, name: 'HLP' } }]).isVault(U),
    ).toEqual({ ok: true, value: true });
    const bad = await infoWith([{ status: 500, body: 'boom' }]).isVault(U);
    expect(bad.ok).toBe(false);
  });
});
