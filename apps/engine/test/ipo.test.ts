import { evaluateListing } from '@whale-street/core';
import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS } from '../src/dates';
import { FIRST_FILL_PAGE, gatherEvidence, TOP_TRADE_PAGE } from '../src/ingest/evidence';
import { silentLogger } from '../src/log';
import { createIpoService, deniedKey } from '../src/services/ipo';
import { createListingService } from '../src/services/listing';
import { companyRow } from './helpers/db';
import { FakeInfo } from './helpers/fake-hl';
import { FakeNansen, fail } from './helpers/fake-nansen';
import { programCleanTrader, programHedgedTrader, tradeRow } from './helpers/traders';
import { addCompany, makeWorld, pos } from './helpers/world';

const APP = '0x00000000000000000000000000000000000000a1' as const;
const LINK = '0x00000000000000000000000000000000000000b2' as const;
const CP = '0x00000000000000000000000000000000000000c3' as const;
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

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

  it('skips counterparties (5 credits) once related wallets + first funder already link 2 wallets', async () => {
    const { w, nansen, info } = setup();
    programCleanTrader(nansen, info, APP, w.clock.now());
    nansen.related.set(APP, [{ address: LINK, relation: 'First Funder', chain: 'arbitrum' }]);
    nansen.funders.set(APP, { funder: CP, funderName: null });
    info.states.set(CP, {
      positions: [pos('BTC', -1.5, 60_000, 80_000)],
      accountValue: 1,
      time: null,
    });
    const { ev } = await gatherEvidence(APP, { ...w, nansen, info });
    expect(nansen.count('counterparties')).toBe(0);
    if (!ev.linked.ok) throw new Error(ev.linked.error);
    expect(ev.linked.value.map((l) => [l.address, l.relation])).toEqual([
      [LINK, 'related'],
      [CP, 'first_funder'],
    ]);
    // Skipping it is not missing evidence: the hedge check still decides (here: a hedge, denied).
    const v = evaluateListing(ev);
    expect(v.checks.find((c) => c.id === 'HIDDEN_HEDGE')?.status).toBe('FAIL');
    expect(v.decision).toBe('DENIED');
  });

  it('asks counterparties when fewer than 2 wallets are linked; its failure is missing evidence', async () => {
    const { w, nansen, info } = setup();
    programCleanTrader(nansen, info, APP, w.clock.now());
    // The funder is the same wallet as the related one: 1 linked wallet.
    nansen.related.set(APP, [{ address: LINK, relation: 'First Funder', chain: 'arbitrum' }]);
    nansen.funders.set(APP, { funder: LINK, funderName: null });
    nansen.counterpartyLists.set(APP, fail('HTTP 500: upstream error'));
    const { ev } = await gatherEvidence(APP, { ...w, nansen, info });
    expect(nansen.count('counterparties')).toBe(1);
    expect(ev.linked).toEqual({ ok: false, error: 'counterparties: HTTP 500: upstream error' });
    const v = evaluateListing(ev);
    expect(v.checks.find((c) => c.id === 'HIDDEN_HEDGE')?.status).toBe('UNKNOWN');
    expect(v.decision).toBe('DEFERRED');
    // A failed related-wallets or first-funder read spends nothing more on counterparties.
    const again = setup();
    programCleanTrader(again.nansen, again.info, APP, again.w.clock.now());
    again.nansen.funders.set(APP, fail('timeout'));
    const { ev: ev2 } = await gatherEvidence(APP, {
      ...again.w,
      nansen: again.nansen,
      info: again.info,
    });
    expect(ev2.linked).toEqual({ ok: false, error: 'first funder: timeout' });
    expect(again.nansen.count('counterparties')).toBe(0);
  });

  it('keeps Nansen as the size source in credit-saver mode (no silent switch to Hyperliquid)', async () => {
    const { w, nansen, info } = setup();
    programCleanTrader(nansen, info, APP, w.clock.now());
    w.state.flags.creditSaver = true;
    const { ev, positions } = await gatherEvidence(APP, { ...w, nansen, info });
    expect(nansen.count('perpPositions')).toBe(1);
    expect(info.calls).not.toContain(`clearinghouse:${APP}`);
    expect(positions?.source).toBe('nansen');
    expect(ev.equityUsd).toEqual({ ok: true, value: 600_000 });
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

  it('asks for pages large enough to find the first perp fill and the top perp trade (spot fills are dropped)', async () => {
    const { w, nansen, info } = setup();
    programCleanTrader(nansen, info, APP, w.clock.now());
    await gatherEvidence(APP, { ...w, nansen, info });
    expect(nansen.calls.filter((c) => c.method === 'perpTrades').map((c) => c.args[3])).toEqual([
      { orderBy: 'timestamp', direction: 'ASC', perPage: FIRST_FILL_PAGE },
      { orderBy: 'closed_pnl', direction: 'DESC', perPage: TOP_TRADE_PAGE },
    ]);
    expect([FIRST_FILL_PAGE, TOP_TRADE_PAGE]).toEqual([100, 5]);
  });

  it('no perp fill on the page while the P&L summary shows perp trading is unknown, never "never traded"', async () => {
    const { w, nansen, info } = setup();
    programCleanTrader(nansen, info, APP, w.clock.now());
    // Every fill on both pages was a spot fill (dropped by the client).
    nansen.firstTrades.set(APP, []);
    nansen.topTrades.set(APP, []);
    const { ev } = await gatherEvidence(APP, { ...w, nansen, info });
    expect(ev.firstTradeAt).toEqual({
      ok: false,
      error: `no Hyperliquid perp fill among the first ${FIRST_FILL_PAGE} fills`,
    });
    expect(ev.topTradePnlUsd).toEqual({
      ok: false,
      error: `no Hyperliquid perp fill among the top ${TOP_TRADE_PAGE} fills`,
    });
    expect(evaluateListing(ev).decision).toBe('DEFERRED');
    // No perp trading at all: the known "no trades" answer (TRACK_RECORD fails on it).
    nansen.pnl.set(APP, {
      realizedPnlUsd: 0,
      feesUsd: 0,
      winRate: 0,
      closedTrades: 0,
      tradedTimes: 0,
      topCoins: [],
    });
    const idle = await gatherEvidence(APP, { ...w, nansen, info });
    expect(idle.ev.firstTradeAt).toEqual({ ok: true, value: null });
    expect(idle.ev.topTradePnlUsd).toEqual({ ok: true, value: null });
  });

  it('an unreported top-trade profit is unknown, never the same as having no top trade at all', async () => {
    const { w, nansen, info } = setup();
    programCleanTrader(nansen, info, APP, w.clock.now());
    nansen.topTrades.set(APP, [tradeRow({ closedPnl: null })]);
    const { ev } = await gatherEvidence(APP, { ...w, nansen, info });
    expect(ev.topTradePnlUsd.ok).toBe(false);
  });

  it('stops at a HIP-3 position (a dex-prefixed coin), before spending the rest of the committee budget', async () => {
    const { w, nansen, info } = setup();
    programCleanTrader(nansen, info, APP, w.clock.now());
    nansen.positions.set(APP, {
      positions: [pos('BTC', 2, 60_000, 40_000), pos('xyz:TSLA', 1, 100)],
      accountValue: 600_000,
      time: null,
    });
    const { ev, positions, hip3Coin } = await gatherEvidence(APP, { ...w, nansen, info });
    expect(hip3Coin).toBe('xyz:TSLA');
    expect(positions).toBeNull();
    // The remaining evidence calls (human, hedge, concentration) never ran.
    expect(nansen.count('perpTrades')).toBe(1);
    expect(info.calls).not.toContain(`isVault:${APP}`);
    expect(nansen.count('relatedWallets')).toBe(0);
    expect(ev.isVault.ok).toBe(false);
    expect(ev.linked.ok).toBe(false);
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
    // Listed: its application is the answer, at any age, without a new evidence run.
    const calls = nansen.calls.length;
    w.clock.advance(3 * DAY_MS);
    expect(ipo.apply('p2', APP)).toMatchObject({
      ok: true,
      existing: true,
      app: { id: r.app.id, status: 'APPROVED' },
    });
    expect(nansen.calls).toHaveLength(calls);
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

  it('defers an application holding a HIP-3 position with the visible reason, never lists it', async () => {
    const { w, nansen, info, ipo } = setup();
    programCleanTrader(nansen, info, APP, w.clock.now());
    nansen.positions.set(APP, {
      positions: [pos('BTC', 2, 60_000, 40_000), pos('xyz:TSLA', 1, 100)],
      accountValue: 600_000,
      time: null,
    });
    const r = ipo.apply('p1', APP);
    if (!r.ok) throw new Error(r.message);
    await ipo.drained();
    expect(ipo.get(r.app.id)).toMatchObject({
      status: 'DEFERRED',
      reason: 'holds HIP-3 markets (not supported yet)',
    });
    expect(w.state.get(APP)).toBeUndefined();
  });

  it('rejects bad addresses and rate-limits players to 3 per hour', () => {
    const { ipo } = setup();
    expect(ipo.apply('p1', 'nope')).toMatchObject({ ok: false, code: 'INVALID_ADDRESS' });
    for (let i = 0; i < 3; i++) expect(ipo.apply('p1', addr(0x500 + i)).ok).toBe(true);
    expect(ipo.apply('p1', addr(0x510))).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    expect(ipo.apply('p2', addr(0x510)).ok).toBe(true);
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

  it('caps the desk at 30 applications per wall-clock hour across all players (IPO_DESK_BUSY, no call)', async () => {
    const { w, nansen, ipo } = setup();
    for (let i = 0; i < 30; i++)
      expect(ipo.apply(`p${i}`, addr(0x100 + i), `10.0.${i}.1`).ok).toBe(true);
    const calls = nansen.calls.length;
    expect(ipo.apply('p99', addr(0x200), '10.9.9.9')).toMatchObject({
      ok: false,
      code: 'IPO_DESK_BUSY',
    });
    expect(nansen.calls).toHaveLength(calls);
    expect(w.repos.ipoApps.recent(100)).toHaveLength(30);
    await ipo.drained();
    w.clock.advance(HOUR_MS + 1);
    expect(ipo.apply('p99', addr(0x200), '10.9.9.9').ok).toBe(true);
    await ipo.drained();
  });

  it('caps one client IP at 10 applications per hour, across players (IPO_DESK_BUSY)', async () => {
    const { nansen, ipo } = setup();
    for (let i = 0; i < 10; i++)
      expect(ipo.apply(`p${i}`, addr(0x300 + i), '198.51.100.7').ok).toBe(true);
    const calls = nansen.calls.length;
    expect(ipo.apply('p9', addr(0x310), '198.51.100.7')).toMatchObject({
      ok: false,
      code: 'IPO_DESK_BUSY',
    });
    expect(nansen.calls).toHaveLength(calls);
    expect(ipo.apply('p9', addr(0x310), '198.51.100.8').ok).toBe(true);
    await ipo.drained();
  });

  it('returns the pending application for an address; once denied, the denial memory answers', async () => {
    const { w, nansen, info, ipo } = setup();
    programHedgedTrader(nansen, info, APP, LINK, w.clock.now());
    const first = ipo.apply('p1', APP, '10.0.0.1');
    if (!first.ok) throw new Error(first.message);
    expect(first.existing).toBe(false);
    expect(ipo.apply('p2', APP, '10.0.0.2')).toMatchObject({
      ok: true,
      existing: true,
      app: { id: first.app.id, status: 'PENDING' },
    });
    await ipo.drained();
    expect(ipo.get(first.app.id)?.status).toBe('DENIED');
    const calls = nansen.calls.length;
    // The scout's 7-day denial memory refuses it from local state, within 24 h and after.
    for (const step of [1, DAY_MS]) {
      w.clock.advance(step);
      expect(ipo.apply('p3', APP, '10.0.0.3')).toMatchObject({
        ok: false,
        code: 'RECENTLY_DENIED',
      });
    }
    expect(nansen.calls).toHaveLength(calls);
    expect(w.repos.ipoApps.recent(10)).toHaveLength(1);
  });

  it('an address approved, then delisted the same day, is cooling down (not its old application)', async () => {
    const { w, nansen, info, ipo } = setup();
    programCleanTrader(nansen, info, APP, w.clock.now());
    const first = ipo.apply('p1', APP, '10.0.0.1');
    if (!first.ok) throw new Error(first.message);
    await ipo.drained();
    expect(ipo.get(first.app.id)?.status).toBe('APPROVED');
    const rt = w.state.get(APP);
    if (!rt) throw new Error('not listed');
    // Bankrupt within the hour: delisted with a relisting cooldown.
    w.clock.advance(HOUR_MS);
    rt.status = 'DELISTED';
    rt.delistedAt = w.clock.now();
    rt.cooldownUntil = w.clock.now() + 14 * DAY_MS;
    w.statusOps.persist(rt);
    const calls = nansen.calls.length;
    expect(ipo.apply('p2', APP, '10.0.0.2')).toMatchObject({ ok: false, code: 'COOLING_DOWN' });
    expect(nansen.calls).toHaveLength(calls);
  });

  it('keeps the denial memory on wall time: a looping engine clock neither freezes nor extends it', async () => {
    const w = makeWorld();
    const nansen = new FakeNansen();
    const info = new FakeInfo();
    const listing = createListingService({ ...w, nansen });
    const wall = { t: 5_000_000 };
    const ipo = createIpoService({
      ...w,
      nansen,
      info,
      listing,
      log: silentLogger,
      wallNow: () => wall.t,
    });
    w.state.setMarks({ BTC: 60_000 }, w.clock.now());
    programHedgedTrader(nansen, info, APP, LINK, w.clock.now());
    const loopStart = w.clock.now();
    w.clock.advance(5 * 60_000);
    const first = ipo.apply('p1', APP);
    if (!first.ok) throw new Error(first.message);
    await ipo.drained();
    expect(ipo.get(first.app.id)?.status).toBe('DENIED');
    // A REPLAY wrap: the engine clock goes back to the loop start while wall time moves on.
    w.clock.t = loopStart;
    wall.t += 60_000;
    expect(ipo.apply('p1', APP)).toMatchObject({ ok: false, code: 'RECENTLY_DENIED' });
    // A week of wall time later (the looping engine clock never gets there), it may apply again.
    wall.t += 7 * DAY_MS;
    w.clock.t = loopStart + 60_000;
    expect(ipo.apply('p1', APP)).toMatchObject({ ok: true, existing: false });
    await ipo.drained();
  });

  it('defers applications left pending by a restart, announcing each like any other decision', () => {
    const w = makeWorld();
    w.repos.ipoApps.insert({
      id: 'ipo_stale',
      address: APP,
      playerId: 'p1',
      status: 'PENDING',
      verdict: null,
      reason: null,
      ticker: null,
      createdAt: w.clock.now(),
      decidedAt: null,
      appliedWallAt: w.clock.now(),
    });
    const nansen = new FakeNansen();
    const listing = createListingService({ ...w, nansen });
    createIpoService({ ...w, nansen, info: new FakeInfo(), listing, log: silentLogger });
    expect(w.repos.ipoApps.get('ipo_stale')).toMatchObject({
      status: 'DEFERRED',
      reason: 'engine restarted',
      decidedAt: w.clock.now(),
    });
    expect(w.events).toContainEqual({
      t: 'ipo',
      update: {
        appId: 'ipo_stale',
        kind: 'decided',
        status: 'DEFERRED',
        ticker: null,
        reason: 'engine restarted',
      },
    });
  });

  it('a hedging counterparty without volume figures still fails the hidden-hedge check', async () => {
    const { w, nansen, info, ipo } = setup();
    programCleanTrader(nansen, info, APP, w.clock.now());
    nansen.counterpartyLists.set(APP, [{ address: LINK, interactions: null, volumeUsd: null }]);
    info.states.set(LINK, {
      positions: [pos('BTC', -1.5, 60_000, 80_000)],
      accountValue: 200_000,
      time: null,
    });
    const r = ipo.apply('p1', APP);
    if (!r.ok) throw new Error(r.message);
    await ipo.drained();
    const app = ipo.get(r.app.id);
    expect(app?.status).toBe('DENIED');
    expect(app?.reason).toContain('HIDDEN_HEDGE');
    expect(app?.verdict?.hedgeLinks).toEqual([
      { address: LINK, coin: 'BTC', side: 'SHORT', notionalUsd: 90_000 },
    ]);
  });

  it('a committee DEFERRED is reused for 24 h; a deferral without an evidence run is not', async () => {
    const { w, nansen, info, ipo } = setup();
    programCleanTrader(nansen, info, APP, w.clock.now());
    nansen.pnl.set(APP, fail('timeout'));
    const first = ipo.apply('p1', APP);
    if (!first.ok) throw new Error(first.message);
    await ipo.drained();
    expect(ipo.get(first.app.id)).toMatchObject({ status: 'DEFERRED' });
    expect(ipo.apply('p1', APP)).toMatchObject({ existing: true, app: { id: first.app.id } });
    w.clock.advance(DAY_MS + 1);
    const retry = ipo.apply('p1', APP);
    expect(retry).toMatchObject({ ok: true, existing: false });
    await ipo.drained();

    w.state.flags.creditFloor = true;
    const floored = ipo.apply('p2', LINK);
    expect(floored).toMatchObject({ ok: true, existing: false, app: { status: 'DEFERRED' } });
    w.state.flags.creditFloor = false;
    expect(ipo.apply('p2', LINK)).toMatchObject({ ok: true, existing: false });
    await ipo.drained();
  });

  it('refuses listed, cooling-down and recently denied addresses from local state (no call, no row)', () => {
    const { w, nansen, ipo } = setup();
    const now = w.clock.now();
    addCompany(w, { id: APP, ticker: 'AAA' }); // listed by the scout: no application
    expect(ipo.apply('p1', APP, '10.0.0.1')).toMatchObject({
      ok: false,
      code: 'ALREADY_LISTED',
    });
    w.repos.companies.upsert(
      companyRow({ id: LINK, status: 'DELISTED', delistedAt: now, cooldownUntil: now + DAY_MS }),
    );
    expect(ipo.apply('p1', LINK, '10.0.0.1')).toMatchObject({ ok: false, code: 'COOLING_DOWN' });
    w.repos.kv.set(deniedKey(CP), String(now - 2 * DAY_MS));
    expect(ipo.apply('p1', CP, '10.0.0.1')).toMatchObject({ ok: false, code: 'RECENTLY_DENIED' });
    expect(nansen.calls).toHaveLength(0);
    expect(w.repos.ipoApps.recent(10)).toHaveLength(0);
  });

  it('bounds the queue at 10 pending; beyond it DEFERRED "desk busy" without a call', async () => {
    const { nansen, ipo } = setup();
    const apps = Array.from({ length: 11 }, (_, i) => ipo.apply(null, addr(0x400 + i)));
    expect(ipo.pendingAddresses().size).toBe(10);
    expect(apps[10]).toMatchObject({
      ok: true,
      app: { status: 'DEFERRED', reason: expect.stringContaining('desk busy') },
    });
    await ipo.drained();
    expect(nansen.calls.some((c) => c.args[0] === addr(0x400 + 10))).toBe(false);
  });

  it('re-checks the credit floor when an application is dequeued', async () => {
    const { w, nansen, info, ipo } = setup();
    programCleanTrader(nansen, info, APP, w.clock.now());
    const a = ipo.apply(null, APP);
    const b = ipo.apply(null, LINK);
    if (!a.ok || !b.ok) throw new Error('apply failed');
    w.state.flags.creditFloor = true;
    await ipo.drained();
    expect(ipo.get(b.app.id)).toMatchObject({
      status: 'DEFERRED',
      reason: expect.stringContaining('credit floor'),
    });
    expect(nansen.calls.some((c) => c.args[0] === LINK)).toBe(false);
  });
});
