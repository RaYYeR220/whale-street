import { describe, expect, it } from 'vitest';
import { addressProblem } from '../components/ipo/IpoDesk';
import type { IpoView } from '../lib/api-types';
import {
  hedgeOffset,
  headline as ipoHeadline,
  MEMBERS,
  progressStates,
  stampColumn,
  verdictChecks,
} from '../lib/committee';
import { T0 } from './helpers';

describe('listing committee', () => {
  const app = (o: Partial<IpoView> = {}): IpoView => ({
    id: 'app1',
    address: '0x3b1e2c4d5e6f708192a3b4c5d6e7f8091a2ba7d2',
    status: 'DENIED',
    reason: null,
    ticker: null,
    verdict: {
      decision: 'DENIED',
      rating: null,
      prospectus: null,
      hedgeLinks: [],
      checks: MEMBERS.map((m) => ({
        id: m.id,
        status: m.id === 'HIDDEN_HEDGE' ? 'FAIL' : 'PASS',
        detail: m.id === 'HIDDEN_HEDGE' ? '75% of exposure offset by linked wallets' : 'ok',
      })),
    },
    createdAt: T0,
    decidedAt: T0 + 5_000,
    ...o,
  });

  it('seats six members in engine order', () => {
    expect(MEMBERS.map((m) => m.step)).toEqual([
      'track_record',
      'size',
      'human',
      'hedge',
      'concentration',
      'uniqueness',
    ]);
  });

  it('turns progress events into member states', () => {
    const s = progressStates(
      [
        { appId: 'app1', kind: 'progress', step: 'size', state: 'running' },
        { appId: 'app1', kind: 'progress', step: 'track_record', state: 'done' },
        { appId: 'other', kind: 'progress', step: 'hedge', state: 'done' },
      ],
      'app1',
    );
    expect(s).toEqual(['read', 'thinking', 'pending', 'pending', 'pending', 'pending']);
  });

  it('headlines the failing check and reads the hedge offset', () => {
    expect(ipoHeadline(app(), null)).toBe('Denied: hidden hedge');
    expect(hedgeOffset(verdictChecks(app())[3]?.detail)).toBe(0.75);
    expect(hedgeOffset('no number')).toBeNull();
  });

  it('marks every member unknown when there is no verdict (deferred)', () => {
    const checks = verdictChecks(
      app({ status: 'DEFERRED', verdict: null, reason: 'not in recording' }),
    );
    expect(checks.every((c) => c.status === 'UNKNOWN' && c.detail === 'not in recording')).toBe(
      true,
    );
    expect(ipoHeadline(app({ status: 'DEFERRED', verdict: null }), null)).toBe(
      'Deferred: evidence unavailable',
    );
  });

  it('lands the stamp over two passing neighbours', () => {
    const checks = verdictChecks(app());
    expect(stampColumn(checks, 'DENIED')).toBe(5);
    expect(stampColumn(checks, 'APPROVED')).toBe(3);
  });
});

describe('IPO address check', () => {
  it('explains what is wrong with the input', () => {
    expect(addressProblem('')).toMatch(/Paste a Hyperliquid address/);
    expect(addressProblem('0x123')).toMatch(/this has 5/);
    expect(addressProblem(' 0x3b1e2c4d5e6f708192a3b4c5d6e7f8091a2ba7d2 ')).toBeNull();
  });
});
