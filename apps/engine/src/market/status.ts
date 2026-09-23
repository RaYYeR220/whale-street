import type { Repos } from '../db/repos';
import type { FilingService } from '../services/filings';
import type { HaltKind } from '../types';
import { type CompanyRuntime, rowFromRuntime } from './state';

export interface StatusOps {
  /** ACTIVE → HALTED with a visible reason (no-op for any other status). */
  halt(rt: CompanyRuntime, kind: HaltKind, reason: string, now: number): void;
  /** HALTED → ACTIVE (no-op for any other status). */
  resume(rt: CompanyRuntime, now: number, detail: string): void;
  /** Writes the company row (status, NAV state, pool, HP). */
  persist(rt: CompanyRuntime): void;
}

export function createStatusOps(repos: Repos, filings: FilingService): StatusOps {
  const persist = (rt: CompanyRuntime) => repos.companies.upsert(rowFromRuntime(rt));
  return {
    halt(rt, kind, reason, now) {
      if (rt.status !== 'ACTIVE') return;
      rt.status = 'HALTED';
      rt.haltKind = kind;
      rt.haltReason = reason;
      persist(rt);
      filings.record(rt.id, { kind: 'HALT', at: now, provenance: [], detail: reason });
    },
    resume(rt, now, detail) {
      if (rt.status !== 'HALTED') return;
      rt.status = 'ACTIVE';
      rt.haltKind = null;
      rt.haltReason = null;
      persist(rt);
      filings.record(rt.id, {
        kind: 'RESUME',
        at: now,
        provenance: rt.nav.snapshot.provenance,
        detail,
      });
    },
    persist,
  };
}
