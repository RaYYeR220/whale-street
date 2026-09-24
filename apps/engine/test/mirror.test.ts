import type { Eip712Payload } from '@whale-street/nansen';
import { parseSignature } from 'viem';
import { generatePrivateKey, type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '../src/engine';
import { validateLeverageAction, validateOrderAction } from '../src/services/mirror';
import { linkMessage } from '../src/services/players';
import { bearer, type TestEngine, testEngine } from './helpers/engine';
import { FakeTrading, NANSEN_BUILDER } from './helpers/fake-trading';
import { addCompany, pos } from './helpers/world';

const TRADER = '0x00000000000000000000000000000000000000a1' as const;
let t: TestEngine;

afterEach(async () => {
  await t.app.close();
});

async function sign(account: PrivateKeyAccount, eip712: Eip712Payload) {
  const hex = await account.signTypedData({
    domain: eip712.domain,
    types: eip712.types,
    primaryType: eip712.primaryType,
    message: eip712.message,
  } as Parameters<PrivateKeyAccount['signTypedData']>[0]);
  const { r, s, v } = parseSignature(hex);
  return { r, s, v: Number(v) };
}

async function setup(o: { mode?: 'live' | 'replay'; mark?: number } = {}) {
  const trading = new FakeTrading();
  t = await testEngine({ mode: o.mode ?? 'live', trading });
  const e = t.engine;
  const master = privateKeyToAccount(generatePrivateKey());
  const agent = privateKeyToAccount(generatePrivateKey());
  const { player, token } = e.players.create('human');
  e.repos.players.setWallet(player.id, master.address.toLowerCase());
  const traderPositions = [pos('HYPE', 100, 40, 30, 10)];
  addCompany(e, { id: TRADER, ticker: 'HYP', positions: traderPositions, accountValue: 100_000 });
  t.nansen.positions.set(TRADER, { positions: traderPositions, accountValue: 100_000, time: null });
  e.state.setMarks({ HYPE: o.mark ?? 41 }, t.clock.now());
  e.state.flags.creditsRemaining = 10_000;
  return { e, trading, master, agent, player, token };
}

/** Prepares a mirror group and returns its two steps (leverage, order). */
async function prepareSteps(e: Engine, playerId: string, notionalUsd = 50) {
  const r = await e.mirror.prepare(playerId, {
    ticker: 'HYP',
    coin: 'HYPE',
    notionalUsd,
    leverage: 3,
  });
  if (!r.ok || !('steps' in r)) throw new Error(`expected steps, got ${JSON.stringify(r)}`);
  const [lev, ord] = r.steps;
  if (!lev || !ord) throw new Error('missing steps');
  return { lev, ord };
}

/** Prepares and executes one mirror; `fail` makes the order step's execute fail that way. */
async function placeOrder(
  e: Engine,
  trading: FakeTrading,
  playerId: string,
  agent: PrivateKeyAccount,
  notionalUsd = 50,
  fail: { status: number | null; error: string } | null = null,
) {
  const { lev, ord } = await prepareSteps(e, playerId, notionalUsd);
  await e.mirror.execute(playerId, lev.stepId, await sign(agent, lev.eip712));
  trading.executeFail = fail;
  const r = await e.mirror.execute(playerId, ord.stepId, await sign(agent, ord.eip712));
  trading.executeFail = null;
  if (!r.ok) throw new Error(`execute failed: ${JSON.stringify(r)}`);
  return ord.stepId;
}

const refusalCodes = (r: Awaited<ReturnType<Engine['mirror']['prepare']>>) =>
  r.ok && 'refusals' in r ? r.refusals.map((x) => x.code) : r.ok ? 'allowed' : r.code;

const HYP_50 = { ticker: 'HYP', coin: 'HYPE', notionalUsd: 50, leverage: 3 };

describe('mirror', () => {
  it('happy path over REST: register agent → prepare → sign leverage → sign order → receipts', async () => {
    const { trading, master, agent, token } = await setup();
    const fee = await t.app.inject({ url: '/api/mirror/builder-fee', headers: bearer(token) });
    expect(fee.json()).toMatchObject({ approved: true, builderAddress: NANSEN_BUILDER });
    const reg = await t.app.inject({
      method: 'POST',
      url: '/api/mirror/agent',
      headers: bearer(token),
      payload: { masterAddress: master.address, agentAddress: agent.address },
    });
    expect(reg.json()).toEqual({ ok: true });

    const prep = await t.app.inject({
      method: 'POST',
      url: '/api/mirror/prepare',
      headers: bearer(token),
      payload: { ticker: 'HYP', coin: 'HYPE', notionalUsd: 50, leverage: 3 },
    });
    expect(prep.statusCode).toBe(200);
    const body = prep.json();
    expect(body.order).toMatchObject({ coin: 'HYPE', isBuy: true, leverage: 3, markPx: 41 });
    expect(body.steps.map((s: { kind: string }) => s.kind)).toEqual(['leverage', 'order']);
    expect(JSON.stringify(body)).not.toContain('"action"');
    expect(JSON.stringify(body)).not.toContain('nonce');
    const orderReq = trading.calls.find((c) => c.method === 'prepareOrder')?.args[0] as {
      stopLoss: number;
      slippage: number;
    };
    expect(orderReq.stopLoss).toBeCloseTo(41 * (1 - 0.25 / 3), 8);
    expect(orderReq.slippage).toBe(0.01);

    const [lev, ord] = body.steps as Array<{ stepId: string; eip712: Eip712Payload }>;
    if (!lev || !ord) throw new Error('missing steps');
    const r1 = await t.app.inject({
      method: 'POST',
      url: '/api/mirror/execute',
      headers: bearer(token),
      payload: { stepId: lev.stepId, signature: await sign(agent, lev.eip712) },
    });
    expect(r1.json()).toMatchObject({ kind: 'leverage', status: 'FILLED' });
    const r2 = await t.app.inject({
      method: 'POST',
      url: '/api/mirror/execute',
      headers: bearer(token),
      payload: { stepId: ord.stepId, signature: await sign(agent, ord.eip712) },
    });
    expect(r2.json()).toMatchObject({ kind: 'order', status: 'FILLED', hlOid: 77, avgPx: 41.05 });
    expect(r2.json().explorerUrl).toContain(master.address.toLowerCase());
    // The server forwards the action it stored at prepare, never one sent by the client.
    const exec = trading.calls.filter((c) => c.method === 'execute');
    const sent = exec[1]?.args[0] as { action?: unknown } | undefined;
    expect(sent?.action).toEqual(t.engine.repos.mirrorOrders.get(ord.stepId)?.action);
    expect(sent?.action).toMatchObject({ type: 'order', grouping: 'normalTpsl' });
    const orders = (
      await t.app.inject({ url: '/api/mirror/orders', headers: bearer(token) })
    ).json().orders;
    expect(orders.map((o: { status: string }) => o.status).sort()).toEqual(['FILLED', 'FILLED']);
    expect(orders[0].explorerUrl).toContain(master.address.toLowerCase());
  });

  it('refuses with reasons (anti-FOMO) and logs the refused attempt', async () => {
    const { e, trading, master, agent, player } = await setup({ mark: 42.2 });
    e.mirror.registerAgent(player.id, master.address, agent.address);
    const r = await e.mirror.prepare(player.id, {
      ticker: 'HYP',
      coin: 'HYPE',
      notionalUsd: 50,
      leverage: 3,
    });
    expect(r.ok && 'refusals' in r && r.refusals.map((x) => x.code)).toEqual(['ANTI_FOMO']);
    expect(trading.calls.filter((c) => c.method.startsWith('prepare'))).toEqual([]);
    expect(e.mirror.orders(player.id)[0]).toMatchObject({
      status: 'REFUSED',
      refusals: [{ code: 'ANTI_FOMO' }],
    });
  });

  it('is unavailable in REPLAY and requires a linked wallet for the agent', async () => {
    const { e, master, agent, player } = await setup({ mode: 'replay' });
    expect(e.mirror.registerAgent(player.id, master.address, agent.address)).toMatchObject({
      ok: false,
      code: 'TRADING_UNAVAILABLE',
      status: 503,
    });
    expect(
      await e.mirror.prepare(player.id, {
        ticker: 'HYP',
        coin: 'HYPE',
        notionalUsd: 50,
        leverage: 3,
      }),
    ).toMatchObject({ code: 'TRADING_UNAVAILABLE' });
    await t.app.close();
    const live = await setup();
    const other = privateKeyToAccount(generatePrivateKey());
    expect(
      live.e.mirror.registerAgent(live.player.id, other.address, live.agent.address),
    ).toMatchObject({ code: 'NO_WALLET', status: 403 });
    expect(
      await live.e.mirror.prepare(live.player.id, {
        ticker: 'HYP',
        coin: 'HYPE',
        notionalUsd: 50,
        leverage: 3,
      }),
    ).toMatchObject({ code: 'NO_AGENT' });
  });

  it('enforces step order, the agent signature and the 60 s window', async () => {
    const { e, master, agent, player } = await setup();
    e.mirror.registerAgent(player.id, master.address, agent.address);
    const r = await e.mirror.prepare(player.id, {
      ticker: 'HYP',
      coin: 'HYPE',
      notionalUsd: 50,
      leverage: 3,
    });
    if (!r.ok || !('steps' in r)) throw new Error('expected steps');
    const [lev, ord] = r.steps;
    if (!lev || !ord) throw new Error('missing steps');
    expect(
      await e.mirror.execute(player.id, ord.stepId, await sign(agent, ord.eip712)),
    ).toMatchObject({ code: 'BAD_STATE' });
    const intruder = privateKeyToAccount(generatePrivateKey());
    expect(
      await e.mirror.execute(player.id, lev.stepId, await sign(intruder, lev.eip712)),
    ).toMatchObject({ code: 'BAD_SIGNATURE', status: 401 });
    expect(
      await e.mirror.execute('someone-else', lev.stepId, await sign(agent, lev.eip712)),
    ).toMatchObject({ code: 'NOT_FOUND' });
    t.clock.advance(61_000);
    expect(
      await e.mirror.execute(player.id, lev.stepId, await sign(agent, lev.eip712)),
    ).toMatchObject({ code: 'EXPIRED', status: 410 });
  });

  it('rejects a prepared action that does not match the policy decision', async () => {
    const { e, trading, master, agent, player } = await setup();
    trading.flipSide = true;
    e.mirror.registerAgent(player.id, master.address, agent.address);
    const r = await e.mirror.prepare(player.id, {
      ticker: 'HYP',
      coin: 'HYPE',
      notionalUsd: 50,
      leverage: 3,
    });
    expect(r).toMatchObject({ ok: false, code: 'ACTION_MISMATCH' });
    expect(e.mirror.orders(player.id)[0]).toMatchObject({ status: 'REJECTED' });
  });

  it('surfaces a 451 as a region block and HL rejections as REJECTED', async () => {
    const { e, trading, master, agent, player } = await setup();
    e.mirror.registerAgent(player.id, master.address, agent.address);
    trading.prepareFail = { status: 451, error: 'HTTP 451: region' };
    expect(
      await e.mirror.prepare(player.id, {
        ticker: 'HYP',
        coin: 'HYPE',
        notionalUsd: 50,
        leverage: 3,
      }),
    ).toMatchObject({ code: 'REGION_BLOCKED', message: 'trading unavailable in this region' });
    trading.prepareFail = null;
    const r = await e.mirror.prepare(player.id, {
      ticker: 'HYP',
      coin: 'HYPE',
      notionalUsd: 50,
      leverage: 3,
    });
    if (!r.ok || !('steps' in r)) throw new Error('expected steps');
    const [lev, ord] = r.steps;
    if (!lev || !ord) throw new Error('missing steps');
    await e.mirror.execute(player.id, lev.stepId, await sign(agent, lev.eip712));
    trading.executeFail = { status: 422, error: 'HTTP 422: Insufficient margin to place order.' };
    expect(
      await e.mirror.execute(player.id, ord.stepId, await sign(agent, ord.eip712)),
    ).toMatchObject({ code: 'REJECTED', message: 'HTTP 422: Insufficient margin to place order.' });
  });

  it('records non-definitive execute outcomes as UNKNOWN (never REJECTED) and counts them toward the caps', async () => {
    const { e, trading, master, agent, player, token } = await setup();
    e.mirror.registerAgent(player.id, master.address, agent.address);
    const attempt = async (fail: { status: number | null; error: string } | null) => {
      const { lev, ord } = await prepareSteps(e, player.id, 100);
      await e.mirror.execute(player.id, lev.stepId, await sign(agent, lev.eip712));
      trading.executeFail = fail;
      const sig = await sign(agent, ord.eip712);
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/mirror/execute',
        headers: bearer(token),
        payload: { stepId: ord.stepId, signature: sig },
      });
      trading.executeFail = null;
      return res;
    };

    const timeout = await attempt({ status: null, error: 'timeout' });
    expect(timeout.statusCode).toBe(202);
    expect(timeout.json()).toMatchObject({ kind: 'order', status: 'UNKNOWN', hlOid: null });
    expect(timeout.json().error).toContain('result unknown — check Hyperliquid');
    expect(timeout.json().explorerUrl).toContain(master.address.toLowerCase());

    const upstream = await attempt({ status: 502, error: 'HTTP 502: Hyperliquid unreachable' });
    expect(upstream.statusCode).toBe(202);
    expect(upstream.json()).toMatchObject({ status: 'UNKNOWN' });

    const filled = await attempt(null);
    expect(filled.json()).toMatchObject({ status: 'FILLED' });

    // 2 unknown + 1 filled, $100 each: the 3-open and $300/day caps are both exhausted.
    const next = await e.mirror.prepare(player.id, {
      ticker: 'HYP',
      coin: 'HYPE',
      notionalUsd: 100,
      leverage: 3,
    });
    const codes = next.ok && 'refusals' in next ? next.refusals.map((x) => x.code) : [];
    expect(codes).toEqual(expect.arrayContaining(['TOO_MANY_OPEN', 'DAILY_CAP']));
    const statuses = e.mirror
      .orders(player.id)
      .filter((o) => o.kind === 'order')
      .map((o) => o.status);
    expect(statuses.filter((s) => s === 'UNKNOWN')).toHaveLength(2);
    expect(statuses).not.toContain('REJECTED');
  });

  it('never treats a 2xx as a failure; only statuses[0].error is a definitive rejection', async () => {
    const { e, trading, master, agent, player } = await setup();
    e.mirror.registerAgent(player.id, master.address, agent.address);
    const run = async (orderFail: { status: number | null; error: string } | null = null) => {
      const { lev, ord } = await prepareSteps(e, player.id, 20);
      await e.mirror.execute(player.id, lev.stepId, await sign(agent, lev.eip712));
      trading.executeFail = orderFail;
      const res = await e.mirror.execute(player.id, ord.stepId, await sign(agent, ord.eip712));
      trading.executeFail = null;
      return res;
    };

    trading.executeStatuses = [];
    expect(await run()).toMatchObject({ ok: true, receipt: { status: 'SUBMITTED' } });

    trading.executeStatuses = [
      { error: 'Order could not immediately match against any resting orders.' },
    ];
    expect(await run()).toMatchObject({
      ok: false,
      code: 'REJECTED',
      status: 422,
      message: 'Order could not immediately match against any resting orders.',
    });

    // A 2xx whose body could not be parsed: the order may well have gone through.
    trading.executeStatuses = [{ filled: { oid: 78, totalSz: '0.49', avgPx: '41.02' } }];
    const garbled = await run({ status: 200, error: 'invalid JSON' });
    expect(garbled).toMatchObject({ ok: true, receipt: { status: 'UNKNOWN' } });

    // An entry fill whose stop-loss leg was rejected is FILLED, with a loud warning.
    trading.executeStatuses = [
      { filled: { oid: 79, totalSz: '0.49', avgPx: '41.02' } },
      { error: 'Invalid TP/SL price.' },
    ];
    const naked = await run();
    expect(naked).toMatchObject({ ok: true, receipt: { status: 'FILLED', hlOid: 79 } });
    expect(naked.ok && naked.receipt.error).toContain('stop-loss');
  });

  it('marks an unknown leverage step UNKNOWN and blocks its order step', async () => {
    const { e, trading, master, agent, player } = await setup();
    e.mirror.registerAgent(player.id, master.address, agent.address);
    const { lev, ord } = await prepareSteps(e, player.id);
    trading.executeFail = { status: null, error: 'network: socket hang up' };
    expect(
      await e.mirror.execute(player.id, lev.stepId, await sign(agent, lev.eip712)),
    ).toMatchObject({ ok: true, receipt: { kind: 'leverage', status: 'UNKNOWN' } });
    trading.executeFail = null;
    expect(
      await e.mirror.execute(player.id, ord.stepId, await sign(agent, ord.eip712)),
    ).toMatchObject({ code: 'BAD_STATE' });
    expect(trading.calls.filter((c) => c.method === 'execute')).toHaveLength(1);
  });

  it('enforces the open-mirror cap atomically across concurrent executes', async () => {
    const { e, trading, master, agent, player } = await setup();
    e.mirror.registerAgent(player.id, master.address, agent.address);
    const groups = [];
    for (let i = 0; i < 4; i++) groups.push(await prepareSteps(e, player.id, 50));
    for (const g of groups)
      await e.mirror.execute(player.id, g.lev.stepId, await sign(agent, g.lev.eip712));
    // Sign first so all four executes start in the same tick and race for the cap.
    const signed = await Promise.all(
      groups.map(async (g) => ({ stepId: g.ord.stepId, sig: await sign(agent, g.ord.eip712) })),
    );
    const results = await Promise.all(
      signed.map((s) => e.mirror.execute(player.id, s.stepId, s.sig)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok)).toMatchObject([
      { code: 'POLICY_CHANGED', refusals: [{ code: 'TOO_MANY_OPEN' }] },
    ]);
    const orderExecutes = trading.calls.filter(
      (c) =>
        c.method === 'execute' &&
        (c.args[0] as { action: { type: string } }).action.type === 'order',
    );
    expect(orderExecutes).toHaveLength(3);
  });

  it('executes a step at most once under concurrent requests', async () => {
    const { e, trading, master, agent, player } = await setup();
    e.mirror.registerAgent(player.id, master.address, agent.address);
    const { lev } = await prepareSteps(e, player.id);
    const sig = await sign(agent, lev.eip712);
    const [a, b] = await Promise.all([
      e.mirror.execute(player.id, lev.stepId, sig),
      e.mirror.execute(player.id, lev.stepId, sig),
    ]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect([a, b].find((r) => !r.ok)).toMatchObject({ code: 'BAD_STATE' });
    expect(trading.calls.filter((c) => c.method === 'execute')).toHaveLength(1);
  });

  it('reconciles UNKNOWN orders from the Hyperliquid position on GET /api/mirror/orders', async () => {
    const { e, trading, master, agent, player, token } = await setup();
    e.mirror.registerAgent(player.id, master.address, agent.address);
    const { lev, ord } = await prepareSteps(e, player.id);
    await e.mirror.execute(player.id, lev.stepId, await sign(agent, lev.eip712));
    trading.executeFail = { status: null, error: 'timeout' };
    await e.mirror.execute(player.id, ord.stepId, await sign(agent, ord.eip712));
    trading.executeFail = null;
    const list = async () =>
      (await t.app.inject({ url: '/api/mirror/orders', headers: bearer(token) }))
        .json()
        .orders.find((o: { id: string }) => o.id === ord.stepId);

    // No position change on Hyperliquid yet: the outcome stays unknown (never guessed REJECTED).
    t.clock.advance(31_000);
    expect(await list()).toMatchObject({ status: 'UNKNOWN' });
    const wallet = master.address.toLowerCase();
    expect(t.info.calls).toContain(`clearinghouse:${wallet}`);

    t.info.states.set(wallet, {
      positions: [pos('HYPE', 1.22, 41.05, null, 3)],
      accountValue: 500,
      time: null,
    });
    t.clock.advance(16_000);
    const reconciled = await list();
    expect(reconciled).toMatchObject({ status: 'FILLED' });
    expect(reconciled.error).toContain('reconciled');
  });

  it('does not credit a retry fill to an earlier UNKNOWN order on the same coin', async () => {
    const { e, trading, master, agent, player } = await setup();
    e.mirror.registerAgent(player.id, master.address, agent.address);
    const first = await prepareSteps(e, player.id);
    await e.mirror.execute(player.id, first.lev.stepId, await sign(agent, first.lev.eip712));
    trading.executeFail = { status: 504, error: 'HTTP 504: gateway timeout' };
    await e.mirror.execute(player.id, first.ord.stepId, await sign(agent, first.ord.eip712));
    trading.executeFail = null;
    const retry = await prepareSteps(e, player.id);
    await e.mirror.execute(player.id, retry.lev.stepId, await sign(agent, retry.lev.eip712));
    await e.mirror.execute(player.id, retry.ord.stepId, await sign(agent, retry.ord.eip712));
    t.info.states.set(master.address.toLowerCase(), {
      positions: [pos('HYPE', 1.22, 41.05, null, 3)],
      accountValue: 500,
      time: null,
    });
    t.clock.advance(31_000);
    await e.mirror.reconcile(player.id);
    const byId = new Map(e.mirror.orders(player.id).map((o) => [o.id, o.status]));
    expect(byId.get(first.ord.stepId)).toBe('UNKNOWN');
    expect(byId.get(retry.ord.stepId)).toBe('FILLED');
  });

  it('refuses prepare with NO_WALLET once the linked wallet no longer matches the agent master', async () => {
    const { e, trading, master, agent, player } = await setup();
    e.mirror.registerAgent(player.id, master.address, agent.address);
    const other = privateKeyToAccount(generatePrivateKey());
    e.repos.players.setWallet(player.id, other.address.toLowerCase());
    expect(
      await e.mirror.prepare(player.id, {
        ticker: 'HYP',
        coin: 'HYPE',
        notionalUsd: 50,
        leverage: 3,
      }),
    ).toMatchObject({ ok: false, code: 'NO_WALLET', status: 403 });
    expect(trading.calls.filter((c) => c.method.startsWith('prepare'))).toEqual([]);
  });

  it('re-checks the linked wallet inside the execute critical section', async () => {
    const { e, trading, master, agent, player } = await setup();
    e.mirror.registerAgent(player.id, master.address, agent.address);
    const { lev } = await prepareSteps(e, player.id);
    const sig = await sign(agent, lev.eip712);
    const other = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    // The wallet changes while the signature is being verified (after the early checks ran).
    const pending = e.mirror.execute(player.id, lev.stepId, sig);
    e.repos.players.setWallet(player.id, other);
    expect(await pending).toMatchObject({ ok: false, code: 'NO_WALLET', status: 403 });
    expect(await e.mirror.execute(player.id, lev.stepId, sig)).toMatchObject({ code: 'NO_WALLET' });
    expect(trading.calls.filter((c) => c.method === 'execute')).toEqual([]);
  });

  it('does not reconcile against a master wallet the player no longer has linked', async () => {
    const { e, trading, master, agent, player } = await setup();
    e.mirror.registerAgent(player.id, master.address, agent.address);
    const { lev, ord } = await prepareSteps(e, player.id);
    await e.mirror.execute(player.id, lev.stepId, await sign(agent, lev.eip712));
    trading.executeFail = { status: null, error: 'timeout' };
    await e.mirror.execute(player.id, ord.stepId, await sign(agent, ord.eip712));
    trading.executeFail = null;
    const wallet = master.address.toLowerCase();
    t.info.states.set(wallet, {
      positions: [pos('HYPE', 1.22, 41.05, null, 3)],
      accountValue: 500,
      time: null,
    });
    e.repos.players.setWallet(player.id, privateKeyToAccount(generatePrivateKey()).address);
    const before = t.info.calls.length;
    t.clock.advance(31_000);
    await e.mirror.reconcile(player.id);
    expect(t.info.calls.slice(before)).not.toContain(`clearinghouse:${wallet}`);
    expect(e.repos.mirrorOrders.get(ord.stepId)?.status).toBe('UNKNOWN');
  });

  it('refuses an agent for a master wallet another player already registered (WALLET_IN_USE)', async () => {
    const { e, master, agent, player } = await setup();
    expect(e.mirror.registerAgent(player.id, master.address, agent.address)).toEqual({ ok: true });
    const b = e.players.create('human');
    e.repos.players.setWallet(b.player.id, master.address.toLowerCase());
    const agentB = privateKeyToAccount(generatePrivateKey());
    expect(e.mirror.registerAgent(b.player.id, master.address, agentB.address)).toMatchObject({
      ok: false,
      status: 409,
      code: 'WALLET_IN_USE',
    });
    // The owner may still rotate its own agent key.
    expect(e.mirror.registerAgent(player.id, master.address, agentB.address)).toEqual({ ok: true });
  });

  it('counts the open and daily caps per master wallet, across players', async () => {
    const { e, master, agent, player } = await setup();
    e.mirror.registerAgent(player.id, master.address, agent.address);
    const wallet = master.address.toLowerCase();
    for (let i = 0; i < 3; i++) {
      const { lev, ord } = await prepareSteps(e, player.id, 100);
      await e.mirror.execute(player.id, lev.stepId, await sign(agent, lev.eip712));
      expect(
        await e.mirror.execute(player.id, ord.stepId, await sign(agent, ord.eip712)),
      ).toMatchObject({ ok: true, receipt: { status: 'FILLED' } });
      expect(e.repos.mirrorOrders.get(ord.stepId)?.masterAddress).toBe(wallet);
      expect(e.repos.mirrorOrders.get(lev.stepId)?.masterAddress).toBe(wallet);
    }
    // Player A moves to another wallet (its agent key is dropped); player B takes over the wallet.
    const next = privateKeyToAccount(generatePrivateKey());
    const nonce = e.players.nonce(player.id);
    const linkSig = await next.signMessage({ message: linkMessage(next.address, nonce) });
    expect(await e.players.link(player.id, next.address, linkSig)).toMatchObject({ ok: true });
    const b = e.players.create('human');
    e.repos.players.setWallet(b.player.id, wallet);
    const agentB = privateKeyToAccount(generatePrivateKey());
    expect(e.mirror.registerAgent(b.player.id, master.address, agentB.address)).toEqual({
      ok: true,
    });
    const r = await e.mirror.prepare(b.player.id, {
      ticker: 'HYP',
      coin: 'HYPE',
      notionalUsd: 50,
      leverage: 3,
    });
    const codes = r.ok && 'refusals' in r ? r.refusals.map((x) => x.code) : [];
    expect(codes).toEqual(expect.arrayContaining(['TOO_MANY_OPEN', 'DAILY_CAP']));
  });

  it('keeps counting an old FILLED mirror while the wallet still holds a position on its coin', async () => {
    const { e, trading, master, agent, player } = await setup();
    e.mirror.registerAgent(player.id, master.address, agent.address);
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await placeOrder(e, trading, player.id, agent));
    t.info.states.set(master.address.toLowerCase(), {
      positions: [pos('HYPE', 3.63, 41, null, 3)],
      accountValue: 500,
      time: null,
    });
    t.clock.advance(25 * 3_600_000);
    // 25 h later the daily cap is free again, but the three mirrors are still open on Hyperliquid.
    expect(refusalCodes(await e.mirror.prepare(player.id, HYP_50))).toEqual(['TOO_MANY_OPEN']);
    expect(ids.map((id) => e.repos.mirrorOrders.get(id)?.status)).toEqual([
      'FILLED',
      'FILLED',
      'FILLED',
    ]);
  });

  it('closes a FILLED mirror once its coin is flat on Hyperliquid, freeing the slot but not the daily cap', async () => {
    const { e, trading, master, agent, player } = await setup();
    e.mirror.registerAgent(player.id, master.address, agent.address);
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await placeOrder(e, trading, player.id, agent, 100));
    // Still inside the 5-minute grace: a flat account does not free anything yet.
    t.clock.advance(4 * 60_000);
    expect(refusalCodes(await e.mirror.prepare(player.id, HYP_50))).toEqual([
      'TOO_MANY_OPEN',
      'DAILY_CAP',
    ]);
    t.clock.advance(2 * 60_000);
    // No HYPE position (the account is flat) and older than 5 minutes: closed.
    expect(refusalCodes(await e.mirror.prepare(player.id, HYP_50))).toEqual(['DAILY_CAP']);
    expect(ids.map((id) => e.repos.mirrorOrders.get(id)?.status)).toEqual([
      'CLOSED',
      'CLOSED',
      'CLOSED',
    ]);
    // Reconcile never moves a CLOSED mirror back, even when a position shows up again.
    t.info.states.set(master.address.toLowerCase(), {
      positions: [pos('HYPE', 7.32, 41, null, 3)],
      accountValue: 900,
      time: null,
    });
    t.clock.advance(31_000);
    await e.mirror.reconcile(player.id);
    expect(ids.map((id) => e.repos.mirrorOrders.get(id)?.status)).toEqual([
      'CLOSED',
      'CLOSED',
      'CLOSED',
    ]);
  });

  it('stops counting stale UNKNOWN mirrors on a flat coin without rewriting their status (prepare and execute)', async () => {
    const { e, trading, master, agent, player } = await setup();
    e.mirror.registerAgent(player.id, master.address, agent.address);
    const ids = [];
    for (let i = 0; i < 3; i++)
      ids.push(
        await placeOrder(e, trading, player.id, agent, 50, { status: null, error: 'timeout' }),
      );
    expect(refusalCodes(await e.mirror.prepare(player.id, HYP_50))).toEqual(['TOO_MANY_OPEN']);
    t.clock.advance(6 * 60_000);
    const id = await placeOrder(e, trading, player.id, agent);
    expect(e.repos.mirrorOrders.get(id)?.status).toBe('FILLED');
    expect(ids.map((x) => e.repos.mirrorOrders.get(x)?.status)).toEqual([
      'UNKNOWN',
      'UNKNOWN',
      'UNKNOWN',
    ]);
  });

  it('counts every mirror when the Hyperliquid read fails (fail closed)', async () => {
    const { e, trading, master, agent, player } = await setup();
    e.mirror.registerAgent(player.id, master.address, agent.address);
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await placeOrder(e, trading, player.id, agent));
    t.info.states.set(master.address.toLowerCase(), 'HTTP 502: hyperliquid down');
    t.clock.advance(25 * 3_600_000);
    expect(refusalCodes(await e.mirror.prepare(player.id, HYP_50))).toEqual(['TOO_MANY_OPEN']);
    expect(ids.map((x) => e.repos.mirrorOrders.get(x)?.status)).toEqual([
      'FILLED',
      'FILLED',
      'FILLED',
    ]);
  });

  it('never leaks the Nansen API key into responses or the database', async () => {
    const { e, trading, master, agent, player } = await setup();
    e.mirror.registerAgent(player.id, master.address, agent.address);
    const { lev, ord } = await prepareSteps(e, player.id);
    await e.mirror.execute(player.id, lev.stepId, await sign(agent, lev.eip712));
    trading.executeFail = { status: 401, error: 'HTTP 401: invalid apikey test-key' };
    const r = await e.mirror.execute(player.id, ord.stepId, await sign(agent, ord.eip712));
    expect(JSON.stringify(r)).not.toContain('test-key');
    expect(JSON.stringify(e.repos.mirrorOrders.byPlayer(player.id, 10))).not.toContain('test-key');
  });
});

describe('validateOrderAction', () => {
  const order = {
    coin: 'HYPE',
    isBuy: true,
    notionalUsd: 50,
    size: 1.22,
    leverage: 3,
    stopLossPx: 37.6,
    markPx: 41,
  };
  const asset = { assetId: 159, name: 'HYPE', szDecimals: 2, maxLeverage: 10 };
  const good = () => ({
    type: 'order',
    orders: [
      { a: 159, b: true, p: '41.41', s: '1.22', r: false, t: { limit: { tif: 'Ioc' } } },
      {
        a: 159,
        b: false,
        p: '37.6',
        s: '1.22',
        r: true,
        t: { trigger: { isMarket: true, triggerPx: '37.6', tpsl: 'sl' } },
      },
    ],
    grouping: 'normalTpsl',
    builder: { b: NANSEN_BUILDER, f: 80 },
  });

  it('accepts the expected bracket and names each mismatch', () => {
    expect(validateOrderAction(good(), order, asset)).toBeNull();
    expect(validateOrderAction({ ...good(), builder: undefined }, order, asset)).toBe(
      'missing builder code',
    );
    expect(validateOrderAction({ ...good(), orders: [good().orders[0]] }, order, asset)).toBe(
      'missing reduce-only stop-loss leg',
    );
    expect(validateOrderAction(good(), { ...order, size: 2 }, asset)).toContain('size');
    expect(validateOrderAction(good(), { ...order, markPx: 50 }, asset)).toContain('price');
    expect(validateOrderAction(good(), order, { ...asset, assetId: 1 })).toBe('wrong asset');
  });

  it('rejects extra opening legs, a misplaced stop and an excessive builder fee', () => {
    const [entry, stop] = good().orders;
    expect(
      validateOrderAction({ ...good(), orders: [entry, stop, entry] }, order, asset),
    ).toContain('extra');
    const farStop = {
      ...stop,
      t: { trigger: { isMarket: true, triggerPx: '30', tpsl: 'sl' } },
    };
    expect(validateOrderAction({ ...good(), orders: [entry, farStop] }, order, asset)).toContain(
      'stop-loss',
    );
    // A tight stop (40.9 under a 41 mark): a trigger above the mark is within 1% but would fire at once.
    const wrongSide = {
      ...stop,
      t: { trigger: { isMarket: true, triggerPx: '41.2', tpsl: 'sl' } },
    };
    const tight = { ...order, stopLossPx: 40.9 };
    expect(validateOrderAction({ ...good(), orders: [entry, wrongSide] }, tight, asset)).toContain(
      'stop-loss',
    );
    const tp = { ...stop, t: { trigger: { isMarket: true, triggerPx: '37.6', tpsl: 'tp' } } };
    expect(validateOrderAction({ ...good(), orders: [entry, tp] }, order, asset)).toBe(
      'missing reduce-only stop-loss leg',
    );
    expect(
      validateOrderAction({ ...good(), builder: { b: NANSEN_BUILDER, f: 500 } }, order, asset),
    ).toContain('builder fee');
  });

  it('checks the prepared leverage action', () => {
    const lev = { type: 'updateLeverage', asset: 159, isCross: true, leverage: 3 };
    expect(validateLeverageAction(lev, order, asset)).toBeNull();
    expect(validateLeverageAction({ ...lev, leverage: 20 }, order, asset)).toContain('leverage');
    expect(validateLeverageAction({ ...lev, asset: 1 }, order, asset)).toBe('wrong asset');
    expect(validateLeverageAction({ ...lev, type: 'order' }, order, asset)).toBe(
      'not a leverage action',
    );
  });
});
