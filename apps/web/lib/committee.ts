/**
 * The listing committee as six members at one table, one per check, seated in the order the
 * engine evaluates them. Member state comes from the engine's progress events and the verdict.
 */
import type { CheckId, CheckResult, CheckStatus } from '@whale-street/core';
import type { IpoStep, IpoUpdate, IpoView } from './api-types';

export interface Member {
  id: CheckId;
  step: IpoStep;
  name: string;
  seed: string;
  source: string;
}

export const MEMBERS: readonly Member[] = [
  {
    id: 'TRACK_RECORD',
    step: 'track_record',
    name: 'Track record',
    seed: 'committee-kobayashi',
    source: 'Nansen profiler, perp P&L summary and trades',
  },
  {
    id: 'SIZE',
    step: 'size',
    name: 'Size',
    seed: 'committee-mori-2',
    source: 'Nansen profiler, perp positions',
  },
  {
    id: 'HUMAN_TRADER',
    step: 'human',
    name: 'Human trader',
    seed: 'committee-sato',
    source: 'Nansen P&L summary + Hyperliquid vault list',
  },
  {
    id: 'HIDDEN_HEDGE',
    step: 'hedge',
    name: 'Hidden hedge',
    seed: 'committee-ito-7',
    source: 'Nansen related wallets + their positions',
  },
  {
    id: 'CONCENTRATION',
    step: 'concentration',
    name: 'Concentration',
    seed: 'committee-yamada',
    source: 'Nansen profiler, perp trades',
  },
  {
    id: 'UNIQUENESS',
    step: 'uniqueness',
    name: 'Uniqueness',
    seed: 'committee-suzuki-3',
    source: 'Whale Street listings register',
  },
];

export type MemberState = 'pending' | 'thinking' | 'read' | CheckStatus;

export const MARK: Record<CheckStatus, [string, string]> = {
  PASS: ['可', 'PASS'],
  FAIL: ['否', 'FAIL'],
  UNKNOWN: ['?', 'UNKNOWN'],
  FLAG: ['注', 'FLAG'],
};
export const SAY: Record<CheckStatus, string> = {
  PASS: 'Pass',
  FAIL: 'Fail',
  UNKNOWN: 'Unknown',
  FLAG: 'Flag',
};

/** Per-member state from the progress events seen so far (before the verdict arrives). */
export function progressStates(updates: readonly IpoUpdate[], appId: string): MemberState[] {
  const states: MemberState[] = MEMBERS.map(() => 'pending');
  const mine = updates.filter((u) => u.appId === appId && u.kind === 'progress').reverse();
  for (const u of mine) {
    if (u.kind !== 'progress') continue;
    const i = MEMBERS.findIndex((m) => m.step === u.step);
    if (i < 0) continue;
    states[i] = u.state === 'running' ? 'thinking' : 'read';
  }
  return states;
}

/** The six checks of a decided application; a verdict-less decision makes every member unknown. */
export function verdictChecks(app: IpoView): CheckResult[] {
  if (app.verdict) {
    return MEMBERS.map(
      (m) =>
        app.verdict?.checks.find((c) => c.id === m.id) ?? {
          id: m.id,
          status: 'UNKNOWN',
          detail: 'no answer recorded',
        },
    );
  }
  return MEMBERS.map((m) => ({
    id: m.id,
    status: 'UNKNOWN',
    detail: app.reason ?? 'evidence unavailable',
  }));
}

export function isDecided(app: IpoView | null): app is IpoView {
  return !!app && app.status !== 'PENDING';
}

export const decidedUpdate = (updates: readonly IpoUpdate[], appId: string) =>
  updates.find((u) => u.appId === appId && u.kind === 'decided') ?? null;

/**
 * Why an application was deferred, in words. The desk defers some without asking the committee
 * (engine reasons: HIP-3 exposure, a full queue, the credit floor, a restart, REPLAY addresses);
 * a committee deferral means evidence was missing.
 */
export function deferral(app: IpoView): { headline: string; detail: string } {
  const reason = app.reason ?? '';
  // The engine's words after its "kind:" prefix, as a sentence.
  const after = (r: string) => {
    const t = r.replace(/^[^:]*:\s*/, '');
    return t.charAt(0).toUpperCase() + t.slice(1);
  };
  if (/^holds HIP-3 markets/.test(reason))
    return {
      headline: 'Deferred: holds HIP-3 markets',
      detail:
        'This trader holds HIP-3 markets (perps deployed by builders), which Whale Street does not list yet. Nothing was decided.',
    };
  if (/^desk busy/.test(reason))
    return {
      headline: 'Deferred: the desk was busy',
      detail: `${after(reason).replace(/;\s*apply again later$/, '')}. Nothing was decided; send the address again later.`,
    };
  if (/^credit floor/.test(reason))
    return {
      headline: 'Deferred: Nansen credit floor',
      detail: `${after(reason)}. Send the address again once the desk reopens.`,
    };
  if (reason === 'engine restarted')
    return {
      headline: 'Deferred: the engine restarted',
      detail: 'The engine restarted before the committee finished. Send the address again.',
    };
  if (/^not in recording/.test(reason))
    return {
      headline: 'Deferred: not in this recording',
      detail: `${after(reason)}.`,
    };
  return {
    headline: 'Deferred: evidence unavailable',
    detail: `${reason ? `${reason.replace(/^[A-Z_]+: /, '')}. ` : ''}Unknown is never a pass and never a fail, so nothing was decided. Send the address again later.`,
  };
}

export function headline(app: IpoView, companyName: string | null): string {
  if (app.status === 'APPROVED') return `Listed: ${companyName ?? app.ticker ?? 'new company'}`;
  if (app.status === 'DEFERRED') return deferral(app).headline;
  if (app.status === 'DENIED') {
    const fail = verdictChecks(app).find((c) => c.status === 'FAIL');
    const m = fail ? MEMBERS.find((x) => x.id === fail.id) : null;
    return m ? `Denied: ${m.name.toLowerCase()}` : 'Denied';
  }
  return 'The committee is reviewing';
}

/** Where the giant stamp lands on one row of six: over two neighbours that passed, so the failing check stays readable. */
export function stampColumn(checks: readonly CheckResult[], decision: IpoView['status']): number {
  if (decision === 'APPROVED') return 3;
  for (let i = checks.length - 2; i >= 0; i--)
    if (checks[i]?.status === 'PASS' && checks[i + 1]?.status === 'PASS') return i + 1;
  return 3;
}

/** "75% of exposure offset by linked wallets" → 0.75. */
export function hedgeOffset(detail: string | undefined): number | null {
  const m = detail?.match(/(\d+(?:\.\d+)?)%/);
  return m ? Number(m[1]) / 100 : null;
}
