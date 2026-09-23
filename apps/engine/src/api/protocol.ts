import type { CohortPositioning } from '@whale-street/nansen';
import { z } from 'zod';
import type { StatusView } from '../engine';
import type { FilingView, IpoUpdate, TapeView } from '../events';
import type { MarketEntry } from '../market/state';
import type { LeaderboardEntry, PortfolioView } from '../services/exchange';
import type { PlayerView } from '../services/players';

export const CHANNELS = [
  'market',
  'filings',
  'tape',
  'leaderboard',
  'ipo',
  'player',
  'status',
] as const;
export type Channel = (typeof CHANNELS)[number];

export const ClientMessage = z.discriminatedUnion('op', [
  z.object({ op: z.literal('hello'), token: z.string().max(200).optional() }),
  z.object({ op: z.literal('sub'), channels: z.array(z.enum(CHANNELS)).max(CHANNELS.length) }),
  z.object({ op: z.literal('unsub'), channels: z.array(z.enum(CHANNELS)).max(CHANNELS.length) }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export interface MoodEntry extends CohortPositioning {
  coin: string;
}

export type ServerMessage =
  | { t: 'hello'; player: PlayerView | null }
  | {
      t: 'market';
      at: number;
      mode: 'live' | 'replay';
      companies: MarketEntry[];
      mood: MoodEntry[];
    }
  | { t: 'filing'; filing: FilingView }
  | { t: 'tape'; trade: TapeView }
  | { t: 'leaderboard'; rows: LeaderboardEntry[] }
  | { t: 'ipo'; update: IpoUpdate }
  | { t: 'player'; portfolio: PortfolioView }
  | { t: 'status'; status: StatusView }
  | { t: 'error'; error: string; message: string };
