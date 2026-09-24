import { describe, expect, it } from 'vitest';
import { addressProblem } from '../components/ipo/IpoDesk';
import type { IpoView } from '../lib/api-types';
import {
  deferral,
  hedgeOffset,
  headline as ipoHeadline,
  listingRecord,
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

  it('names why the desk deferred without asking the committee', () => {
    const deferred = (reason: string) => app({ status: 'DEFERRED', verdict: null, reason });
    const hip3 = deferred('holds HIP-3 markets (not supported yet)');
    expect(ipoHeadline(hip3, null)).toBe('Deferred: holds HIP-3 markets');
    expect(deferral(hip3).detail).toMatch(/HIP-3 markets.*not list yet/);
    const busy = deferred('desk busy: 10 applications are already waiting; apply again later');
    expect(ipoHeadline(busy, null)).toBe('Deferred: the desk was busy');
    expect(deferral(busy).detail).toMatch(/10 applications are already waiting/);
    expect(
      ipoHeadline(
        deferred('credit floor: the IPO desk is paused to protect the Nansen credit budget'),
        null,
      ),
    ).toBe('Deferred: Nansen credit floor');
    expect(ipoHeadline(deferred('engine restarted'), null)).toBe('Deferred: the engine restarted');
    const odd = deferred('listing failed: disk full');
    expect(ipoHeadline(odd, null)).toBe('Deferred: evidence unavailable');
    expect(deferral(odd).detail).toMatch(/listing failed: disk full/);
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

describe('the committee record behind a listing', () => {
  const app = (o: Partial<IpoView>): IpoView => ({
    id: 'ipo_1',
    address: `0x${'ab'.repeat(20)}`,
    status: 'APPROVED',
    reason: null,
    ticker: 'OOH',
    verdict: null,
    createdAt: T0,
    decidedAt: T0,
    ...o,
  });

  it('finds the approved application by ticker or by the company address', () => {
    const company = { id: `0x${'AB'.repeat(20)}`, ticker: 'NEW' };
    const byAddress = app({ id: 'a', ticker: 'OLD' });
    expect(listingRecord([app({ id: 'x', status: 'DENIED' }), byAddress], company)).toEqual({
      kind: 'found',
      app: byAddress,
    });
    expect(listingRecord([app({ id: 'b', address: '0x1', ticker: 'NEW' })], company)).toMatchObject(
      { kind: 'found', app: { id: 'b' } },
    );
  });

  it('says it was not found among the applications it could read', () => {
    expect(
      listingRecord([app({ address: '0x1', ticker: 'GBC' })], { id: '0x2', ticker: 'OOH' }),
    ).toEqual({
      kind: 'missing',
      scanned: 1,
    });
  });
});
