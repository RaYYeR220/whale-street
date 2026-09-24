import { describe, expect, it } from 'vitest';
import { gatherEvidence } from '../src/ingest/evidence';
import { silentLogger } from '../src/log';
import { createIpoService, deniedKey } from '../src/services/ipo';
import { createListingService } from '../src/services/listing';
import { FakeInfo } from './helpers/fake-hl';
import { FakeNansen, fail } from './helpers/fake-nansen';
import { programCleanTrader, programHedgedTrader } from './helpers/traders';
import { makeWorld } from './helpers/world';

const APP = '0x00000000000000000000000000000000000000a1' as const;
const LINK = '0x00000000000000000000000000000000000000b2' as const;
const CP = '0x00000000000000000000000000000000000000c3' as const;

function setup(knownAddresses: ReadonlySet<string> | null = null) {
  const w = makeWorld();
  const nansen = new FakeNansen();
  const info = new FakeInfo();
  const listing = createListingService({ ...w, nansen });
  const ipo = createIpoService({ ...w, nansen, info, listing, log: silentLogger, knownAddresses });
  w.state.setMarks({ BTC: 60_000 }, w.clock.now());
  return { w, nansen, info, ipo };
}

describe('gatherEvidence', () => {
  it('collects every field, dedupes linked wallets and reports progress per check', async () => {
    const { w, nansen, info } = setup();
    programCleanTrader(nansen, info, APP, w.clock.now());
    nansen.related.set(APP, [
      { address: LINK, relation: 'Funded By', chain: 'arbitrum' },
      { address: APP, relation: 'Self', chain: 'arbitrum' },
    ]);
    nansen.funders.set(APP, { funder: LINK, funderName: null });
    nansen.counterpartyLists.set(APP, [{ address: CP, interactions: 3, volumeUsd: 10 }]);
    info.states.set(CP, 'HTTP 500: boom');
    const steps: string[] = [];
    const { ev, positions } = await gatherEvidence(APP, { ...w, nansen, info }, (s, st) =>
      steps.push(`${s}:${st}`),
    );
    expect(steps).toEqual([
      'track_record:running',
      'track_record:done',
      'size:running',
      'size:done',
      'human:running',
      'human:done',
      'hedge:running',
      'hedge:done',
      'concentration:running',
      'concentration:done',
      'uniqueness:running',
      'uniqueness:done',
    ]);
    expect(ev.firstTradeAt).toEqual({ ok: true, value: w.clock.now() - 200 * 86_400_000 });
    expect(ev.topTradePnlUsd).toEqual({ ok: true, value: 50_000 });
    expect(ev.equityUsd).toEqual({ ok: true, value: 600_000 });
    expect(ev.isVault).toEqual({ ok: true, value: false });
    expect(positions?.provenance).toHaveLength(1);
    if (!ev.linked.ok) throw new Error(ev.linked.error);
    expect(ev.linked.value.map((l) => [l.address, l.relation, l.positions.ok])).toEqual([
      [LINK, 'related', true],
      [CP, 'counterparty', false],
    ]);
  });

  it('turns failed calls into none (never fabricated)', async () => {
    const { w, nansen, info } = setup();
    programCleanTrader(nansen, info, APP, w.clock.now());
    nansen.related.set(APP, fail('timeout'));
    nansen.positions.set(APP, fail('HTTP 502: bad gateway'));
    const { ev, positions } = await gatherEvidence(APP, { ...w, nansen, info });
    expect(ev.linked).toEqual({ ok: false, error: 'related wallets: timeout' });
    expect(ev.equityUsd.ok).toBe(false);
    expect(positions).toBeNull();
  });
});

describe('ipo service', () => {
  it('approves and lists a clean trader, streaming progress then the decision', async () => {
    const { w, nansen, info, ipo } = setup();
    programCleanTrader(nansen, info, APP, w.clock.now());
    const r = ipo.apply('p1', APP.toUpperCase().replace('0X', '0x'));
    if (!r.ok) throw new Error(r.message);
    expect(r.app.status).toBe('PENDING');
    await ipo.drained();
    const app = ipo.get(r.app.id);
    expect(app?.status).toBe('APPROVED');
    expect(app?.verdict?.decision).toBe('APPROVED');
    expect(app?.ticker).toBe(w.state.get(APP)?.ticker);
    expect(w.state.get(APP)?.source).toBe('IPO_DESK');
    const updates = w.events.flatMap((e) => (e.t === 'ipo' ? [e.update] : []));
    expect(updates.filter((u) => u.kind === 'progress')).toHaveLength(12);
    expect(updates.at(-1)).toMatchObject({ kind: 'decided', status: 'APPROVED' });
  });

  it('NEGATIVE CONTROL: denies a hedged cluster and remembers the denial for the scout', async () => {
    const { w, nansen, info, ipo } = setup();
    programHedgedTrader(nansen, info, APP, LINK, w.clock.now());
    const r = ipo.apply('p1', APP);
    if (!r.ok) throw new Error(r.message);
    await ipo.drained();
    const app = ipo.get(r.app.id);
    expect(app?.status).toBe('DENIED');
    expect(app?.reason).toContain('HIDDEN_HEDGE');
    expect(app?.verdict?.hedgeLinks).toEqual([
      { address: LINK, coin: 'BTC', side: 'SHORT', notionalUsd: 90_000 },
    ]);
    expect(w.state.get(APP)).toBeUndefined();
    expect(w.repos.kv.get(deniedKey(APP))).toBe(String(w.clock.now()));
  });

  it('defers when evidence is missing', async () => {
    const { w, nansen, info, ipo } = setup();
    programCleanTrader(nansen, info, APP, w.clock.now());
    nansen.pnl.set(APP, fail('timeout'));
    const r = ipo.apply(null, APP);
    if (!r.ok) throw new Error(r.message);
    await ipo.drained();
    expect(ipo.get(r.app.id)).toMatchObject({ status: 'DEFERRED' });
    expect(ipo.get(r.app.id)?.reason).toContain('TRACK_RECORD');
  });

  it('rejects bad addresses and rate-limits players to 3 per hour', () => {
    const { ipo } = setup();
    expect(ipo.apply('p1', 'nope')).toMatchObject({ ok: false, code: 'INVALID_ADDRESS' });
    for (let i = 0; i < 3; i++) expect(ipo.apply('p1', APP).ok).toBe(true);
    expect(ipo.apply('p1', APP)).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    expect(ipo.apply('p2', APP).ok).toBe(true);
  });

  it('knows which applicants are still pending (the session recorder keeps their trades)', async () => {
    const { w, nansen, info, ipo } = setup();
    programCleanTrader(nansen, info, APP, w.clock.now());
    expect(ipo.pendingAddresses().size).toBe(0);
    expect(ipo.apply('p1', APP.toUpperCase().replace('0X', '0x')).ok).toBe(true);
    expect([...ipo.pendingAddresses()]).toEqual([APP]);
    await ipo.drained();
    expect(ipo.pendingAddresses().size).toBe(0);
    // Decided on the spot: never pending.
    w.state.flags.creditFloor = true;
    expect(ipo.apply('p1', LINK).ok).toBe(true);
    expect(ipo.pendingAddresses().size).toBe(0);
  });

  it('defers immediately below the credit floor and for unrecorded addresses in REPLAY', async () => {
    const a = setup();
    a.w.state.flags.creditFloor = true;
    const r1 = a.ipo.apply('p1', APP);
    expect(r1.ok && r1.app.status).toBe('DEFERRED');
    expect(a.nansen.calls).toHaveLength(0);

    const b = setup(new Set([LINK]));
    const r2 = b.ipo.apply('p1', APP);
    expect(r2.ok && r2.app.reason).toContain('not in recording');
    expect(b.nansen.calls).toHaveLength(0);
  });
});
