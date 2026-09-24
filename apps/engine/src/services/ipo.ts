import { randomUUID } from 'node:crypto';
import {
  type Address,
  evaluateListing,
  type ListingVerdict,
  PARAMS,
  type Params,
} from '@whale-street/core';
import type { HlInfo } from '@whale-street/hl';
import { isAddress } from '@whale-street/nansen';
import type { Clock } from '../clock';
import { HOUR_MS } from '../dates';
import type { IpoAppRow, Repos } from '../db/repos';
import type { EventBus } from '../events';
import { gatherEvidence } from '../ingest/evidence';
import type { Logger } from '../log';
import type { MarketState } from '../market/state';
import type { NansenPort } from '../ports';
import type { IpoStatus } from '../types';
import type { ListingService } from './listing';

export const IPO_PER_PLAYER_PER_HOUR = 3;

export interface IpoView {
  id: string;
  address: string;
  status: IpoStatus;
  reason: string | null;
  ticker: string | null;
  verdict: ListingVerdict | null;
  createdAt: number;
  decidedAt: number | null;
}

export type ApplyResult =
  | { ok: true; app: IpoView }
  | { ok: false; code: 'INVALID_ADDRESS' | 'RATE_LIMITED'; message: string };

export interface IpoDeps {
  state: MarketState;
  repos: Repos;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  nansen: NansenPort;
  info: HlInfo;
  listing: ListingService;
  /** REPLAY only: addresses present in the recording; anything else is DEFERRED without a call. */
  knownAddresses?: ReadonlySet<string> | null;
  params?: Params;
  /**
   * Wall clock for the per-player hourly cap (default `clock.now`). In REPLAY the engine clock
   * loops, which would turn a clock-time window into a lifetime cap.
   */
  wallNow?: () => number;
}

export interface IpoService {
  apply(playerId: string | null, address: string): ApplyResult;
  get(id: string): IpoView | null;
  recent(limit: number): IpoView[];
  /** Addresses of applications queued or under evaluation (not yet decided). */
  pendingAddresses(): ReadonlySet<string>;
  /** Resolves when the application queue is empty. */
  drained(): Promise<void>;
}

export const deniedKey = (address: string) => `denied:${address}`;

const view = (r: IpoAppRow): IpoView => ({
  id: r.id,
  address: r.address,
  status: r.status,
  reason: r.reason,
  ticker: r.ticker,
  verdict: r.verdict,
  createdAt: r.createdAt,
  decidedAt: r.decidedAt,
});

/** First failing (or, failing that, unknown) check explains a DENIED/DEFERRED verdict. */
function reasonOf(v: ListingVerdict): string | null {
  const c =
    v.checks.find((x) => x.status === 'FAIL') ?? v.checks.find((x) => x.status === 'UNKNOWN');
  return c ? `${c.id}: ${c.detail}` : null;
}

export function createIpoService(d: IpoDeps): IpoService {
  const params = d.params ?? PARAMS;
  const wallNow = d.wallNow ?? (() => d.clock.now());
  const queue: string[] = [];
  /** Application id → address, while queued or under evaluation. */
  const pending = new Map<string, string>();
  let running: Promise<void> | null = null;

  for (const stale of d.repos.ipoApps.recent(1_000).filter((a) => a.status === 'PENDING')) {
    d.repos.ipoApps.update(stale.id, {
      status: 'DEFERRED',
      reason: 'engine restarted',
      decidedAt: d.clock.now(),
    });
  }

  const decide = (
    id: string,
    status: IpoStatus,
    verdict: ListingVerdict | null,
    reason: string | null,
    ticker: string | null = null,
  ) => {
    d.repos.ipoApps.update(id, { status, verdict, reason, ticker, decidedAt: d.clock.now() });
    pending.delete(id);
    d.bus.emit({ t: 'ipo', update: { appId: id, kind: 'decided', status, ticker, reason } });
  };

  async function evaluate(id: string): Promise<void> {
    const app = d.repos.ipoApps.get(id);
    if (!app) return;
    const address = app.address as Address;
    const { ev, positions } = await gatherEvidence(address, d, (step, state) =>
      d.bus.emit({ t: 'ipo', update: { appId: id, kind: 'progress', step, state } }),
    );
    const verdict = evaluateListing(ev, params);
    if (verdict.decision === 'APPROVED' && positions) {
      try {
        const rt = await d.listing.list({
          address,
          source: 'IPO_DESK',
          rating: verdict.rating,
          prospectus: verdict.prospectus,
          positions,
        });
        decide(id, 'APPROVED', verdict, null, rt.ticker);
      } catch (err) {
        decide(
          id,
          'DEFERRED',
          verdict,
          `listing failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }
    if (verdict.decision === 'DENIED') d.repos.kv.set(deniedKey(address), String(d.clock.now()));
    decide(
      id,
      verdict.decision === 'APPROVED' ? 'DEFERRED' : verdict.decision,
      verdict,
      reasonOf(verdict),
    );
  }

  const pump = () => {
    if (running) return;
    running = (async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        const current = id;
        await evaluate(current).catch((err: unknown) => {
          d.log.error('ipo application failed', { id: current, error: String(err) });
          decide(current, 'DEFERRED', null, 'internal error');
        });
      }
    })().finally(() => {
      running = null;
    });
  };

  return {
    apply(playerId, raw) {
      if (!isAddress(raw))
        return {
          ok: false,
          code: 'INVALID_ADDRESS',
          message: 'expected a 0x-prefixed 40-hex address',
        };
      const address = raw.toLowerCase();
      const now = d.clock.now();
      const wall = wallNow();
      if (
        playerId &&
        d.repos.ipoApps.countByPlayerAppliedSince(playerId, wall - HOUR_MS) >=
          IPO_PER_PLAYER_PER_HOUR
      ) {
        return {
          ok: false,
          code: 'RATE_LIMITED',
          message: `at most ${IPO_PER_PLAYER_PER_HOUR} applications per hour`,
        };
      }
      const id = `ipo_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      d.repos.ipoApps.insert({
        id,
        address,
        playerId,
        status: 'PENDING',
        verdict: null,
        reason: null,
        ticker: null,
        createdAt: now,
        decidedAt: null,
        appliedWallAt: wall,
      });
      if (d.state.flags.creditFloor) {
        decide(
          id,
          'DEFERRED',
          null,
          'credit floor: the IPO desk is paused to protect the Nansen credit budget',
        );
      } else if (d.knownAddresses && !d.knownAddresses.has(address)) {
        decide(
          id,
          'DEFERRED',
          null,
          'not in recording: REPLAY mode can only evaluate recorded addresses',
        );
      } else {
        pending.set(id, address);
        queue.push(id);
        pump();
      }
      const row = d.repos.ipoApps.get(id);
      if (!row) throw new Error('ipo application vanished');
      return { ok: true, app: view(row) };
    },
    get(id) {
      const r = d.repos.ipoApps.get(id);
      return r ? view(r) : null;
    },
    recent(limit) {
      return d.repos.ipoApps.recent(limit).map(view);
    },
    pendingAddresses: () => new Set(pending.values()),
    async drained() {
      while (running) await running;
    },
  };
}
