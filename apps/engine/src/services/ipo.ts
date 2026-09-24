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
import { RateGate } from '../api/rate';
import type { Clock } from '../clock';
import { DAY_MS, HOUR_MS } from '../dates';
import type { IpoAppRow, Repos } from '../db/repos';
import type { EventBus } from '../events';
import { gatherEvidence, HIP3_REASON } from '../ingest/evidence';
import type { Logger } from '../log';
import type { MarketState } from '../market/state';
import type { NansenPort } from '../ports';
import type { IpoStatus } from '../types';
import type { ListingService } from './listing';

export const IPO_PER_PLAYER_PER_HOUR = 3;

/** Desk-wide limits that protect the Nansen credit budget (one evaluation costs ~20–30 credits). */
export interface IpoLimits {
  /** New applications per wall-clock hour, all players together. */
  readonly globalPerHour: number;
  /**
   * New applications per wall-clock hour from one client IP, across players (a room on one
   * shared network counts as one IP).
   */
  readonly perIpPerHour: number;
  /** Applications queued or under evaluation; beyond it a new one is DEFERRED "desk busy". */
  readonly maxPending: number;
  /** An address applied for within this window returns its existing (committee-run) application. */
  readonly dedupMs: number;
}

export const IPO_LIMITS: IpoLimits = Object.freeze({
  globalPerHour: 30,
  perIpPerHour: 10,
  maxPending: 10,
  dedupMs: DAY_MS,
});

/** How long a committee denial keeps an address out (the scout and the desk both honour it). */
export const DENIAL_MEMORY_MS = 7 * DAY_MS;

const CREDIT_FLOOR_REASON =
  'credit floor: the IPO desk is paused to protect the Nansen credit budget';

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

export type ApplyErrorCode =
  | 'INVALID_ADDRESS'
  | 'RATE_LIMITED'
  | 'IPO_DESK_BUSY'
  | 'ALREADY_LISTED'
  | 'COOLING_DOWN'
  | 'RECENTLY_DENIED';

/** `existing`: the address already had an application (pending or recent); that one is returned. */
export type ApplyResult =
  | { ok: true; app: IpoView; existing: boolean }
  | { ok: false; code: ApplyErrorCode; message: string };

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
  /** Overrides of IPO_LIMITS (tests). */
  limits?: Partial<IpoLimits>;
}

export interface IpoService {
  /**
   * Files an application, or answers from local state without any Nansen call: the existing
   * application of an address that is pending, listed or applied for within 24 h; a refusal for a
   * listed (without application), cooling-down or recently denied address; the hourly caps.
   * `clientIp` (REST/MCP caller) feeds the per-IP cap; null skips it (internal callers).
   */
  apply(playerId: string | null, address: string, clientIp?: string | null): ApplyResult;
  get(id: string): IpoView | null;
  recent(limit: number): IpoView[];
  /** Addresses of applications queued or under evaluation (not yet decided). */
  pendingAddresses(): ReadonlySet<string>;
  /** Resolves when the application queue is empty. */
  drained(): Promise<void>;
}

/** kv key of a committee denial; its value is the wall-clock time of the denial. */
export const deniedKey = (address: string) => `denied:${address}`;

/** True while a committee denial of `address` is within DENIAL_MEMORY_MS of wall time `wall`. */
export function deniedRecently(repos: Repos, address: string, wall: number): boolean {
  const deniedAt = Number(repos.kv.get(deniedKey(address)) ?? Number.NaN);
  return Number.isFinite(deniedAt) && wall - deniedAt < DENIAL_MEMORY_MS;
}

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
  const limits: IpoLimits = { ...IPO_LIMITS, ...d.limits };
  const perIp = new RateGate(limits.perIpPerHour, HOUR_MS, wallNow);
  const queue: string[] = [];
  /** Application id → address, while queued or under evaluation. */
  const pending = new Map<string, string>();
  let running: Promise<void> | null = null;

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

  // Applications a previous run left queued or under evaluation will never finish.
  for (const stale of d.repos.ipoApps.recent(1_000).filter((a) => a.status === 'PENDING'))
    decide(stale.id, 'DEFERRED', null, 'engine restarted');

  async function evaluate(id: string): Promise<void> {
    const app = d.repos.ipoApps.get(id);
    if (!app) return;
    // The floor may have been reached while this application waited in the queue.
    if (d.state.flags.creditFloor) {
      decide(id, 'DEFERRED', null, CREDIT_FLOOR_REASON);
      return;
    }
    const address = app.address as Address;
    const { ev, positions, hip3Coin } = await gatherEvidence(address, d, (step, state) =>
      d.bus.emit({ t: 'ipo', update: { appId: id, kind: 'progress', step, state } }),
    );
    if (hip3Coin) {
      decide(id, 'DEFERRED', null, HIP3_REASON);
      return;
    }
    const verdict = evaluateListing(ev, params);
    if (verdict.decision !== 'APPROVED') {
      // Wall time: the REPLAY engine clock loops, so a denial stamped on it would never lapse.
      if (verdict.decision === 'DENIED') d.repos.kv.set(deniedKey(address), String(wallNow()));
      decide(id, verdict.decision, verdict, reasonOf(verdict));
      return;
    }
    // The committee approves only on position evidence, which is this very snapshot.
    if (!positions) throw new Error('approved without a positions snapshot');
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

  const existing = (row: IpoAppRow): ApplyResult => ({ ok: true, app: view(row), existing: true });

  /**
   * The answer local state already gives, or null when the address needs a new application. In
   * order: the application in flight; listed; bankruptcy cooldown; the committee's denial memory;
   * then the 24 h dedup (so a company delisted the same day answers COOLING_DOWN, not the
   * application that listed it). Deferrals without a verdict (credit floor, desk busy, restart,
   * not in recording) never ran the committee, so they are not reused.
   */
  const localAnswer = (address: string, now: number, wall: number): ApplyResult | null => {
    const apps = d.repos.ipoApps.byAddress(address, 20);
    const inFlight = apps.find((a) => a.status === 'PENDING' && pending.has(a.id));
    if (inFlight) return existing(inFlight);
    const company = d.repos.companies.get(address);
    if (company && company.status !== 'DELISTED') {
      const listedBy = apps.find((a) => a.status === 'APPROVED' && a.ticker === company.ticker);
      if (listedBy) return existing(listedBy);
      return {
        ok: false,
        code: 'ALREADY_LISTED',
        message: `already listed as ${company.ticker}`,
      };
    }
    if (company && (company.cooldownUntil ?? 0) > now) {
      return {
        ok: false,
        code: 'COOLING_DOWN',
        message: 'bankruptcy cooldown in effect for this address',
      };
    }
    if (deniedRecently(d.repos, address, wall)) {
      return {
        ok: false,
        code: 'RECENTLY_DENIED',
        message: 'the listing committee denied this address within the last 7 days',
      };
    }
    const recent = apps.find(
      (a) =>
        a.verdict !== null &&
        a.status !== 'PENDING' &&
        (a.appliedWallAt ?? Number.NEGATIVE_INFINITY) >= wall - limits.dedupMs,
    );
    if (recent) return existing(recent);
    return null;
  };

  return {
    apply(playerId, raw, clientIp = null) {
      if (!isAddress(raw))
        return {
          ok: false,
          code: 'INVALID_ADDRESS',
          message: 'expected a 0x-prefixed 40-hex address',
        };
      const address = raw.toLowerCase();
      const now = d.clock.now();
      const wall = wallNow();

      // Local state first: none of these answers spends a Nansen credit.
      const known = localAnswer(address, now, wall);
      if (known) return known;

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
      if (d.repos.ipoApps.countAppliedSince(wall - HOUR_MS) >= limits.globalPerHour) {
        return {
          ok: false,
          code: 'IPO_DESK_BUSY',
          message: `the IPO desk takes at most ${limits.globalPerHour} applications per hour; try again later`,
        };
      }
      // Last: the only check that records a hit.
      if (clientIp && !perIp.allow(clientIp)) {
        return {
          ok: false,
          code: 'IPO_DESK_BUSY',
          message: `at most ${limits.perIpPerHour} applications per hour from one address; try again later`,
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
        decide(id, 'DEFERRED', null, CREDIT_FLOOR_REASON);
      } else if (d.knownAddresses && !d.knownAddresses.has(address)) {
        decide(
          id,
          'DEFERRED',
          null,
          'not in recording: REPLAY mode can only evaluate recorded addresses',
        );
      } else if (pending.size >= limits.maxPending) {
        decide(
          id,
          'DEFERRED',
          null,
          `desk busy: ${limits.maxPending} applications are already waiting; apply again later`,
        );
      } else {
        pending.set(id, address);
        queue.push(id);
        pump();
      }
      const row = d.repos.ipoApps.get(id);
      if (!row) throw new Error('ipo application vanished');
      return { ok: true, app: view(row), existing: false };
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
