import type { FilingKind, OrderSide } from '@whale-street/core';
import { type Logger, silentLogger } from './log';
import type { IpoStatus, PlayerKind } from './types';

/** A filing as served to clients (REST, WS, MCP). */
export interface FilingView {
  id: number;
  companyId: string;
  ticker: string;
  kind: FilingKind;
  coin: string | null;
  sizeBefore: number | null;
  sizeAfter: number | null;
  notionalUsd: number | null;
  realizedPnlUsd: number | null;
  at: number;
  /** Ids of the Nansen calls behind this filing (see /api/provenance/:id). */
  provenance: string[];
  detail: string | null;
  explorerUrl: string;
}

/** One executed order on the public tape. */
export interface TapeView {
  ticker: string;
  side: OrderSide;
  qty: number;
  avgPrice: number;
  cash: number;
  handle: string;
  kind: PlayerKind;
  forced: boolean;
  at: number;
}

export type IpoStep = 'track_record' | 'size' | 'human' | 'hedge' | 'concentration' | 'uniqueness';

export type IpoUpdate =
  | { appId: string; kind: 'progress'; step: IpoStep; state: 'running' | 'done' }
  | {
      appId: string;
      kind: 'decided';
      status: IpoStatus;
      ticker: string | null;
      reason: string | null;
    };

export type EngineEvent =
  | { t: 'market'; at: number }
  | { t: 'filing'; filing: FilingView }
  | { t: 'tape'; trade: TapeView }
  | { t: 'ipo'; update: IpoUpdate }
  | { t: 'player'; playerId: string }
  | { t: 'status' };

export class EventBus {
  private readonly listeners = new Set<(e: EngineEvent) => void>();
  private readonly log: Logger;

  constructor(log: Logger = silentLogger) {
    this.log = log;
  }

  on(cb: (e: EngineEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  emit(e: EngineEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch (err) {
        this.log.error('event listener failed', { event: e.t, error: String(err) });
      }
    }
  }
}

export const explorerUrl = (address: string): string =>
  `https://app.hyperliquid.xyz/explorer/address/${address}`;
