import { type Address, companyIdentity } from '@whale-street/core';
import type { HlRecord, HlTrade } from '@whale-street/hl';
import { type CohortPositioning, type NansenRecord, requestKey } from '@whale-street/nansen';
import { utcDate } from '../dates';
import { skewsOf } from '../ingest/mood';
import type { MoodRecord, SeedRecord, SessionLine } from './session';

export const SYNTHETIC_T0 = 1_790_000_000_000;
export const SYNTHETIC_A: Address = '0x00000000000000000000000000000000000000a1';
export const SYNTHETIC_B: Address = '0x00000000000000000000000000000000000000b2';
const COUNTERPARTY = '0x00000000000000000000000000000000000000ff';
const NANSEN = 'https://api.nansen.ai';

interface Pos {
  coin: string;
  size: number;
  entry: number;
  liq: number | null;
  lev: number;
  upnl: number;
}

const positionsBody = (positions: Pos[], accountValue: number, t: number) => ({
  data: {
    assetPositions: positions.map((p) => ({
      position: {
        token_symbol: p.coin,
        size: String(p.size),
        entry_price_usd: String(p.entry),
        liquidation_price_usd: p.liq === null ? null : String(p.liq),
        leverage_value: p.lev,
        margin_used_usd: String((Math.abs(p.size) * p.entry) / p.lev),
        unrealized_pnl_usd: String(p.upnl),
      },
      position_type: 'oneWay',
    })),
    margin_summary_account_value_usd: String(accountValue),
    time: t,
  },
});

const nansenRecord = (
  t: number,
  path: string,
  requestBody: unknown,
  body: unknown,
): NansenRecord => ({
  t,
  k: 'nansen',
  key: requestKey('POST', `${NANSEN}${path}`, JSON.stringify(requestBody)),
  path,
  status: 200,
  body,
});

const seed = (address: Address, t: number): SeedRecord => {
  const id = companyIdentity(address);
  return {
    t,
    k: 'seed',
    company: {
      address,
      ticker: id.tickerCandidates[0] ?? 'XXX',
      name: id.name,
      anchorDate: utcDate(t),
      listedAt: t,
    },
  };
};

const cohort = (
  smartLongs: number,
  smartShorts: number,
  whaleLongs: number,
  whaleShorts: number,
  publicLongs: number,
  publicShorts: number,
): CohortPositioning => ({
  smartLongs,
  smartShorts,
  whaleLongs,
  whaleShorts,
  publicLongs,
  publicShorts,
});

/** A mood line holds only the skews derived from the (made-up) cohort totals. */
const mood = (t: number, coin: string, positioning: CohortPositioning): MoodRecord => ({
  t,
  k: 'mood',
  coin,
  ...skewsOf(positioning),
});

const trade = (coin: string, px: number, time: number, users: [string, string]): HlTrade => ({
  coin,
  side: 'B',
  px,
  sz: 1,
  time,
  hash: `0x${time.toString(16)}`,
  users,
});

/**
 * A deterministic 10-minute session for tests and keyless demos (clearly labelled "synthetic"):
 * company A closes a BTC long at 4:55 (CLOSE) and opens a SOL long at 6:55 (OPEN) into a rally;
 * company B's 10x ETH long is liquidated at 8:05 with equity collapsing from $30,000 to $1,000
 * (LIQUIDATION → BANKRUPTCY). Street mood (skews derived from made-up cohort totals): smart
 * traders net long BTC, net short ETH and SOL.
 */
export function syntheticSession(t0: number = SYNTHETIC_T0): string[] {
  const at = (s: number) => t0 + s * 1_000;
  const lines: SessionLine[] = [seed(SYNTHETIC_A, t0), seed(SYNTHETIC_B, t0)];
  const pp = '/api/v1/profiler/perp-positions';
  const summary = {
    data: {
      top5_coins: [],
      traded_times: 0,
      closed_trade_count: 0,
      realized_pnl_usd: 0,
      win_rate: 0,
      fees_usd: 0,
    },
  };

  lines.push(
    nansenRecord(
      at(0),
      pp,
      { address: SYNTHETIC_A },
      positionsBody(
        [{ coin: 'BTC', size: 2, entry: 60_000, liq: 45_000, lev: 5, upnl: 0 }],
        250_000,
        at(0),
      ),
    ),
    nansenRecord(at(295), pp, { address: SYNTHETIC_A }, positionsBody([], 251_000, at(295))),
    nansenRecord(
      at(415),
      pp,
      { address: SYNTHETIC_A },
      positionsBody(
        [{ coin: 'SOL', size: 1_000, entry: 150, liq: 100, lev: 3, upnl: 0 }],
        251_000,
        at(415),
      ),
    ),
    nansenRecord(
      at(0),
      pp,
      { address: SYNTHETIC_B },
      positionsBody(
        [{ coin: 'ETH', size: 100, entry: 3_000, liq: 2_800, lev: 10, upnl: 0 }],
        30_000,
        at(0),
      ),
    ),
    nansenRecord(at(485), pp, { address: SYNTHETIC_B }, positionsBody([], 1_000, at(485))),
    nansenRecord(at(0), '/api/v1/profiler/perp-pnl-summary', { address: SYNTHETIC_A }, summary),
    nansenRecord(at(0), '/api/v1/profiler/perp-pnl-summary', { address: SYNTHETIC_B }, summary),
  );

  for (let s = 0; s <= 600; s += 5) {
    const btc = 60_000 + 500 * Math.min(1, s / 295);
    const eth = s <= 360 ? 3_000 : s >= 480 ? 2_790 : 3_000 - (210 * (s - 360)) / 120;
    const sol = s <= 420 ? 150 : 150 + (10 * (s - 420)) / 180;
    const mids: HlRecord = {
      t: at(s),
      k: 'hl',
      channel: 'mids',
      data: { BTC: btc, ETH: eth, SOL: sol },
    };
    lines.push(mids);
  }
  lines.push(
    {
      t: at(290),
      k: 'hl',
      channel: 'trades',
      data: [trade('BTC', 60_500, at(290), [SYNTHETIC_A, COUNTERPARTY])],
    },
    {
      t: at(410),
      k: 'hl',
      channel: 'trades',
      data: [trade('SOL', 150, at(410), [COUNTERPARTY, SYNTHETIC_A])],
    },
    {
      t: at(480),
      k: 'hl',
      channel: 'trades',
      data: [trade('ETH', 2_790, at(480), [SYNTHETIC_B, COUNTERPARTY])],
    },
    mood(at(0), 'BTC', cohort(48e6, 21e6, 310e6, 265e6, 4e6, 3e6)),
    mood(at(0), 'ETH', cohort(18e6, 29e6, 140e6, 155e6, 2e6, 2e6)),
    mood(at(0), 'SOL', cohort(6e6, 10e6, 40e6, 52e6, 1e6, 1e6)),
    mood(at(300), 'BTC', cohort(47e6, 22e6, 305e6, 268e6, 4e6, 3e6)),
    mood(at(300), 'ETH', cohort(15e6, 34e6, 132e6, 166e6, 2e6, 3e6)),
  );
  return lines.sort((a, b) => a.t - b.t).map((l) => JSON.stringify(l));
}
