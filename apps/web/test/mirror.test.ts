import type { IRequestTransport } from '@nktkas/hyperliquid';
import { ApproveAgentTypes, ApproveBuilderFeeTypes } from '@nktkas/hyperliquid/api/exchange';
import { PARAMS } from '@whale-street/core';
import {
  type Hex,
  recoverTypedDataAddress,
  serializeSignature,
  UserRejectedRequestError,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseSiweMessage } from 'viem/siwe';
import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../../engine/src/db/index';
import { createRepos } from '../../engine/src/db/repos';
import {
  MARKET_SLIPPAGE as ENGINE_SLIPPAGE,
  STEP_TTL_MS as ENGINE_STEP_TTL_MS,
  MAX_BUILDER_FEE,
} from '../../engine/src/services/mirror';
import { createPlayersService, LINK_STATEMENT } from '../../engine/src/services/players';
import { type Api, createApi } from '../lib/api';
import type { LinkErrorCode, MirrorOrderView, MirrorReceipt, PrepareView } from '../lib/api-types';
import { linkErrorText } from '../lib/errors';
import {
  AGENT_BASE_NAME,
  agentName,
  isUsable,
  newAgent,
  RENEW_MARGIN_MS,
} from '../lib/mirror/agent';
import { approveAgentKey } from '../lib/mirror/approve';
import {
  agentProblem,
  isDefinitiveRejection,
  type MirrorOutcome,
  resolveUnknown,
  runMirror,
  unknownFromLog,
  unresolvedOrders,
  walletProblem,
} from '../lib/mirror/flow';
import {
  approveAgentOnHl,
  approveBuilderFeeOnHl,
  builderFeeRate,
  hlErrorText,
} from '../lib/mirror/hl';
import { createIdbKeyStore, createMemoryKeyStore } from '../lib/mirror/keystore';
import { linkWallet } from '../lib/mirror/link';
import {
  BUILDER_FEE_CEILING,
  checkRows,
  MARKET_SLIPPAGE,
  mirrorUsage,
  previewContext,
  previewMirror,
  STEP_TTL_MS,
} from '../lib/mirror/policy';
import { signStep } from '../lib/mirror/sign';
import { companyView, fakeFetch, json, T0 } from './helpers';

// Well-known test keys (never used for anything real).
const MASTER_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const AGENT_KEY: Hex = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const master = privateKeyToAccount(MASTER_KEY);
const agent = privateKeyToAccount(AGENT_KEY);
const MASTER_LOWER = master.address.toLowerCase();
const ARBITRUM = '0xa4b1';

function capture() {
  const sent: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
  const transport: IRequestTransport = {
    isTestnet: false,
    async request(endpoint, payload) {
      sent.push({ endpoint, payload: payload as Record<string, unknown> });
      return { status: 'ok', response: { type: 'default' } } as never;
    },
  };
  return { sent, transport };
}

const hlDomain = {
  name: 'HyperliquidSignTransaction',
  version: '1',
  chainId: 42161,
  verifyingContract: '0x0000000000000000000000000000000000000000',
} as const;

describe('agent keys', () => {
  it('names the agent so it never replaces the player’s own Hyperliquid session', () => {
    const r = newAgent(master.address, T0);
    expect(r.master).toBe(master.address.toLowerCase());
    expect(r.agentName).toBe(`${AGENT_BASE_NAME} valid_until ${r.validUntil}`);
    expect(r.validUntil - T0).toBe(180 * 86_400_000);
    expect(privateKeyToAccount(r.privateKey).address).toBe(r.agentAddress);
    expect(newAgent(master.address, T0).privateKey).not.toBe(r.privateKey);
  });

  it('is usable only once approved and until a day before expiry', () => {
    const r = newAgent(master.address, T0);
    expect(isUsable(r, T0)).toBe(false);
    const approved = { ...r, approvedAt: T0 };
    expect(isUsable(approved, T0)).toBe(true);
    expect(isUsable(approved, r.validUntil - RENEW_MARGIN_MS)).toBe(false);
    expect(isUsable(null, T0)).toBe(false);
  });

  it('keeps records per master wallet, case-insensitively', async () => {
    const store = createMemoryKeyStore();
    const r = newAgent(master.address, T0);
    await store.save(r);
    expect(await store.load(master.address.toUpperCase().replace('0X', '0x'))).toEqual(r);
    await store.remove(master.address);
    expect(await store.load(master.address)).toBeNull();
  });

  it('refuses to pretend it stored a key when IndexedDB is missing', async () => {
    const store = createIdbKeyStore(undefined);
    await expect(store.save(newAgent(master.address, T0))).rejects.toThrow(/IndexedDB/);
  });
});

describe('Hyperliquid approvals (user-signed by the master wallet)', () => {
  it('approveAgent is signed by the master over HyperliquidSignTransaction', async () => {
    const { sent, transport } = capture();
    const name = agentName(T0 + 86_400_000);
    await approveAgentOnHl(
      { wallet: master, transport, signatureChainId: ARBITRUM },
      { agentAddress: agent.address, agentName: name },
    );
    expect(sent).toHaveLength(1);
    const { endpoint, payload } = sent[0] as (typeof sent)[number];
    expect(endpoint).toBe('exchange');
    const action = payload.action as Record<string, unknown>;
    expect(action).toMatchObject({
      type: 'approveAgent',
      signatureChainId: ARBITRUM,
      hyperliquidChain: 'Mainnet',
      agentAddress: agent.address.toLowerCase(),
      agentName: name,
    });
    const sig = payload.signature as { r: Hex; s: Hex; v: number };
    const signer = await recoverTypedDataAddress({
      domain: hlDomain,
      types: ApproveAgentTypes,
      primaryType: 'HyperliquidTransaction:ApproveAgent',
      message: {
        hyperliquidChain: 'Mainnet',
        agentAddress: agent.address.toLowerCase() as Hex,
        agentName: name,
        nonce: BigInt(action.nonce as number),
      },
      signature: serializeSignature({ r: sig.r, s: sig.s, v: BigInt(sig.v) }),
    });
    expect(signer).toBe(master.address);
  });

  it('approveBuilderFee sends the ceiling as a percent string and a lowercase builder', async () => {
    const { sent, transport } = capture();
    const builder = '0xAbC0000000000000000000000000000000000DeF';
    await approveBuilderFeeOnHl(
      { wallet: master, transport, signatureChainId: ARBITRUM },
      { builder, tenthsBp: 80 },
    );
    const action = (sent[0]?.payload.action ?? {}) as Record<string, unknown>;
    expect(action).toMatchObject({
      type: 'approveBuilderFee',
      maxFeeRate: '0.08%',
      builder: builder.toLowerCase(),
    });
    const sig = sent[0]?.payload.signature as { r: Hex; s: Hex; v: number };
    const signer = await recoverTypedDataAddress({
      domain: hlDomain,
      types: ApproveBuilderFeeTypes,
      primaryType: 'HyperliquidTransaction:ApproveBuilderFee',
      message: {
        hyperliquidChain: 'Mainnet',
        maxFeeRate: '0.08%',
        builder: builder.toLowerCase() as Hex,
        nonce: BigInt(action.nonce as number),
      },
      signature: serializeSignature({ r: sig.r, s: sig.s, v: BigInt(sig.v) }),
    });
    expect(signer).toBe(master.address);
  });

  it('converts tenths of a basis point to Hyperliquid’s percent string', () => {
    expect(builderFeeRate(80)).toBe('0.08%');
    expect(builderFeeRate(10)).toBe('0.01%');
    expect(builderFeeRate(5)).toBe('0.005%');
  });

  it('turns wallet and Hyperliquid errors into plain sentences', () => {
    expect(hlErrorText(new Error('User rejected the request.'))).toBe(
      'You declined the signature in your wallet.',
    );
    expect(hlErrorText(new Error('Must deposit before performing actions'))).toMatch(
      /Deposit USDC/,
    );
  });

  it('recognises a real wallet decline wrapped by the Hyperliquid library', async () => {
    const { sent, transport } = capture();
    const declining = {
      address: master.address,
      signTypedData: async (_a: unknown) => {
        throw new UserRejectedRequestError(new Error('User denied message signature.'));
      },
    };
    const err = await approveAgentOnHl(
      { wallet: declining as never, transport, signatureChainId: ARBITRUM },
      { agentAddress: agent.address, agentName: agentName(T0) },
    ).catch((e: unknown) => e);
    expect(sent).toEqual([]);
    expect((err as Error).message).toBe('Failed to sign the typed data using the wallet');
    expect(hlErrorText(err)).toBe('You declined the signature in your wallet.');
    // An EIP-1193 provider error (code 4001) anywhere in the cause chain is a decline too.
    const raw = { code: 4001, message: 'Request rejected' };
    expect(hlErrorText(new Error('Failed to sign', { cause: raw }))).toBe(
      'You declined the signature in your wallet.',
    );
    expect(
      hlErrorText(
        new Error('outer', { cause: new Error('Must deposit before performing actions') }),
      ),
    ).toMatch(/Deposit USDC/);
    expect(hlErrorText(new Error('Failed to sign', { cause: new Error('device locked') }))).toBe(
      'Failed to sign: device locked',
    );
  });
});

describe('agent signatures for Nansen steps', () => {
  const eip712 = {
    domain: {
      name: 'Exchange',
      version: '1',
      chainId: 1337,
      verifyingContract: '0x0000000000000000000000000000000000000000',
    },
    types: {
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' },
      ],
    },
    primaryType: 'Agent',
    message: { source: 'a', connectionId: `0x${'11'.repeat(32)}` },
  };

  it('signs exactly the payload the engine sent, recoverable to the agent address', async () => {
    const sig = await signStep(AGENT_KEY, eip712);
    expect([27, 28]).toContain(sig.v);
    const signer = await recoverTypedDataAddress({
      domain: eip712.domain as never,
      types: eip712.types,
      primaryType: 'Agent',
      message: eip712.message as never,
      signature: serializeSignature({ r: sig.r as Hex, s: sig.s as Hex, v: BigInt(sig.v) }),
    });
    expect(signer).toBe(agent.address);
  });
});

describe('wallet link (Sign-In with Ethereum)', () => {
  const ORIGIN = 'http://localhost:3000';
  const target = {
    address: master.address,
    chainId: 42_161,
    host: 'localhost:3000',
    origin: ORIGIN,
  };

  /** The engine's real wallet-link service behind the web client's two calls. */
  function engineLinks(origins: string[] = [ORIGIN]) {
    const repos = createRepos(openDb(':memory:'));
    const players = createPlayersService({ repos, clock: { now: () => Date.now() }, origins });
    const { player } = players.create('human');
    const nonces: string[] = [];
    const api: Pick<Api, 'authNonce' | 'authLink'> = {
      authNonce: async () => {
        const nonce = players.nonce(player.id);
        nonces.push(nonce);
        return { ok: true, data: { nonce, message: LINK_STATEMENT } };
      },
      authLink: async (_t, message, signature) => {
        const r = await players.link(player.id, message, signature);
        return r.ok
          ? { ok: true, data: { player: r.player } }
          : { ok: false, status: 401, error: r.code, message: r.message };
      },
    };
    return { api, nonces, player: () => players.get(player.id) };
  }

  it('signs the canonical EIP-4361 message the engine verifies, and links the wallet', async () => {
    const e = engineLinks();
    const signed: string[] = [];
    const r = await linkWallet(e.api, 'tok', target, async (message) => {
      signed.push(message);
      return master.signMessage({ message });
    });
    expect(r).toMatchObject({ ok: true, player: { walletAddress: MASTER_LOWER } });
    expect(e.player()?.walletAddress).toBe(MASTER_LOWER);
    const m = parseSiweMessage(signed[0] ?? '');
    expect(m).toMatchObject({
      domain: 'localhost:3000',
      address: master.address,
      statement: LINK_STATEMENT,
      uri: ORIGIN,
      version: '1',
      chainId: 42_161,
      nonce: e.nonces[0],
    });
  });

  it('asks for a fresh nonce on every attempt', async () => {
    const e = engineLinks();
    const sign = async (message: string) => master.signMessage({ message });
    await linkWallet(e.api, 'tok', target, sign);
    const again = await linkWallet(e.api, 'tok', target, sign);
    expect(again.ok).toBe(true);
    expect(new Set(e.nonces).size).toBe(2);
  });

  it('explains an engine refusal in plain words', async () => {
    const elsewhere = await linkWallet(
      engineLinks(['https://whalestreet.example']).api,
      'tok',
      target,
      async (message) => master.signMessage({ message }),
    );
    expect(elsewhere).toEqual({
      ok: false,
      code: 'DOMAIN_MISMATCH',
      message: linkErrorText('DOMAIN_MISMATCH', ''),
    });
    const wrongSigner = await linkWallet(engineLinks().api, 'tok', target, async (message) =>
      agent.signMessage({ message }),
    );
    expect(wrongSigner).toMatchObject({ ok: false, code: 'BAD_SIGNATURE' });
    expect(wrongSigner.ok ? '' : wrongSigner.message).toMatch(/does not match this wallet/);
  });

  it('says so when the wallet declines the signature', async () => {
    const declined = await linkWallet(engineLinks().api, 'tok', target, async () => {
      throw new UserRejectedRequestError(new Error('User rejected the request.'));
    });
    expect(declined).toEqual({
      ok: false,
      code: 'DECLINED',
      message: 'You declined the signature.',
    });
  });

  it('maps every engine link refusal to its own sentence', () => {
    const codes: LinkErrorCode[] = [
      'INVALID_MESSAGE',
      'NO_NONCE',
      'DOMAIN_MISMATCH',
      'NONCE_MISMATCH',
      'MESSAGE_EXPIRED',
      'MESSAGE_NOT_YET_VALID',
      'BAD_SIGNATURE',
    ];
    const texts = codes.map((c) => linkErrorText(c, 'raw engine text'));
    expect(texts.every((t) => t !== 'raw engine text')).toBe(true);
    expect(new Set(texts).size).toBe(codes.length);
  });
});

describe('policy preview', () => {
  const view = companyView({
    lastSnapshotAt: T0 - 12_000,
    hp: 0.82,
    positions: [
      {
        coin: 'BTC',
        size: 10,
        entryPx: 111_200,
        liqPx: 58_400,
        leverage: 2,
        marginUsed: 1,
        unrealizedPnl: 0,
        mark: 113_950,
        hp: 0.82,
      },
    ],
  });

  it('counts open mirrors of any age (as the engine does) and today’s notional', () => {
    const base = {
      groupId: 'g',
      ticker: 'OOH',
      coin: 'BTC',
      refusals: null,
      hlOid: null,
      avgPx: null,
      error: null,
      explorerUrl: '',
      kind: 'order' as const,
    };
    const usage = mirrorUsage(
      [
        { ...base, id: '1', status: 'FILLED', notionalUsd: 50, createdAt: T0 - 1000 },
        { ...base, id: '2', status: 'CLOSED', notionalUsd: 60, createdAt: T0 - 2000 },
        { ...base, id: '3', status: 'REFUSED', notionalUsd: 70, createdAt: T0 - 3000 },
        { ...base, id: '4', status: 'FILLED', notionalUsd: 80, createdAt: T0 - 2 * 86_400_000 },
      ],
      T0,
    );
    expect(usage).toEqual({ open: 2, dailyUsd: 110 });
  });

  const req = { coin: 'BTC', notionalUsd: 50, leverage: 2, stopLossPct: 0.25 };
  const at = (o: Partial<typeof view> = {}) =>
    previewContext(companyView({ ...view, ...o }), 'BTC', T0, { open: 0, dailyUsd: 0 });

  it('quotes the daily cap in dollars and cents: the engine stores size × mark', () => {
    const ctx = previewContext(companyView(view), 'BTC', T0, { open: 1, dailyUsd: 82.1 + 17.8 });
    const row = checkRows(req, ctx, previewMirror(req, ctx), 'OOH').find(
      (r) => r.code === 'DAILY_CAP',
    );
    expect(row?.value).toBe('$149.90 of $300.00');
  });

  it('clears a good order', () => {
    const p = previewMirror(req, at());
    expect(p).toEqual({ canSend: true, blocking: [], advisory: [], staleMs: null });
    expect(checkRows(req, at(), p, 'OOH').every((r) => r.state === 'pass')).toBe(true);
  });

  it('never blocks a send on snapshot age: the engine refreshes the snapshot at prepare', () => {
    const ctx = at({ lastSnapshotAt: T0 - 5 * 60_000 });
    const p = previewMirror(req, ctx);
    expect(p.canSend).toBe(true);
    expect(p.blocking).toEqual([]);
    expect(p.advisory).toEqual([]);
    expect(p.staleMs).toBe(5 * 60_000);
    const row = checkRows(req, ctx, p, 'OOH').find((r) => r.code === 'STALE_DATA');
    expect(row).toMatchObject({ state: 'wait' });
    expect(row?.value).toBe('snapshot 5 min old, refreshed when you send');
  });

  it('keeps refusals on market data advisory: only the engine’s fresh check decides', () => {
    const late = at({
      positions: [
        { ...(view.positions[0] as (typeof view.positions)[number]), mark: 111_200 * 1.08 },
      ],
    });
    const p = previewMirror(req, late);
    expect(p.canSend).toBe(true);
    expect(p.blocking).toEqual([]);
    expect(p.advisory.map((r) => r.code)).toEqual(['ANTI_FOMO']);
    const rows = checkRows(req, late, p, 'OOH');
    expect(rows).toHaveLength(12);
    expect(rows.filter((r) => r.state !== 'pass').map((r) => [r.code, r.state])).toEqual([
      ['ANTI_FOMO', 'warn'],
    ]);
    expect(PARAMS.mirror.antiFomoPct).toBeLessThan(0.08);
    const busy = previewMirror(
      req,
      previewContext(companyView(view), 'BTC', T0, { open: 3, dailyUsd: 280 }),
    );
    expect(busy.canSend).toBe(true);
    expect(busy.advisory.map((r) => r.code)).toEqual(['TOO_MANY_OPEN', 'DAILY_CAP']);
  });

  it('blocks only the player’s own inputs out of range', () => {
    for (const [bad, code] of [
      [{ notionalUsd: 500 }, 'NOTIONAL_OUT_OF_RANGE'],
      [{ stopLossPct: 0.9 }, 'STOP_LOSS_TOO_LOOSE'],
      [{ leverage: 9 }, 'LEVERAGE_CAP'],
    ] as const) {
      const r = { ...req, ...bad };
      const p = previewMirror(r, at());
      expect(p.canSend, code).toBe(false);
      expect(p.blocking.map((x) => x.code)).toEqual([code]);
      expect(checkRows(r, at(), p, 'OOH').find((x) => x.code === code)?.state).toBe('fail');
    }
  });
});

describe('runMirror', () => {
  const order = {
    coin: 'BTC',
    isBuy: true,
    notionalUsd: 50,
    size: 0.00044,
    leverage: 2,
    stopLossPx: 99_706,
    markPx: 113_950,
  };
  const step = (kind: 'leverage' | 'order', stepId: string) => ({
    stepId,
    kind,
    eip712: {
      domain: {
        name: 'Exchange',
        version: '1',
        chainId: 1337,
        verifyingContract: '0x0000000000000000000000000000000000000000',
      },
      types: { Agent: [{ name: 'source', type: 'string' }] },
      primaryType: 'Agent',
      message: { source: stepId },
    },
  });
  const prepared: PrepareView = {
    ok: true,
    groupId: 'g1',
    order,
    steps: [step('leverage', 's1'), step('order', 's2')],
  };
  const receipt = (
    stepId: string,
    status: MirrorReceipt['status'],
    o: Partial<MirrorReceipt> = {},
  ): MirrorReceipt => ({
    stepId,
    kind: stepId === 's1' ? 'leverage' : 'order',
    status,
    hlOid: null,
    avgPx: null,
    error: null,
    explorerUrl: '',
    ...o,
  });
  type ExecResult = Awaited<ReturnType<Api['mirrorExecute']>>;
  const fake = (
    results: ExecResult[],
    prep: Awaited<ReturnType<Api['mirrorPrepare']>> = { ok: true, data: prepared },
  ) => {
    const executed: string[] = [];
    const api: Pick<Api, 'mirrorPrepare' | 'mirrorExecute'> = {
      mirrorPrepare: async () => prep,
      mirrorExecute: async (_t, stepId) => {
        executed.push(stepId);
        return results.shift() as ExecResult;
      },
    };
    return { api, executed };
  };
  const body = { ticker: 'OOH', coin: 'BTC', notionalUsd: 50, leverage: 2, stopLossPct: 0.25 };

  it('signs and executes leverage then order, and reports the fill', async () => {
    const { api, executed } = fake([
      { ok: true, data: receipt('s1', 'FILLED') },
      { ok: true, data: receipt('s2', 'FILLED', { hlOid: 42, avgPx: 113_990 }) },
    ]);
    const r = await runMirror({ api, token: 't', body, privateKey: AGENT_KEY });
    expect(executed).toEqual(['s1', 's2']);
    expect(r).toMatchObject({ kind: 'filled', groupId: 'g1', warning: null });
  });

  it('returns the committee refusals from prepare', async () => {
    const refusals = [{ code: 'ANTI_FOMO', message: 'entry 5.5% worse than the trader' }];
    const { api, executed } = fake([], { ok: true, data: { ok: false, groupId: 'g2', refusals } });
    expect(await runMirror({ api, token: 't', body, privateKey: AGENT_KEY })).toEqual({
      kind: 'refused',
      refusals,
      groupId: 'g2',
    });
    expect(executed).toEqual([]);
  });

  it('stops before the order when the leverage change is unconfirmed', async () => {
    const { api, executed } = fake([{ ok: true, data: receipt('s1', 'UNKNOWN') }]);
    const r = await runMirror({ api, token: 't', body, privateKey: AGENT_KEY });
    expect(r).toMatchObject({ kind: 'error', code: 'LEVERAGE_UNCONFIRMED' });
    expect(executed).toEqual(['s1']);
  });

  it('reports an order timeout as unknown and never re-sends it', async () => {
    const { api, executed } = fake([
      { ok: true, data: receipt('s1', 'FILLED') },
      { ok: false, status: 0, error: 'TIMEOUT', message: 'the engine did not answer in time' },
    ]);
    const r = await runMirror({ api, token: 't', body, privateKey: AGENT_KEY });
    expect(r).toMatchObject({
      kind: 'unknown',
      groupId: 'g1',
      detail: 'the engine did not answer in time',
    });
    expect(executed).toEqual(['s1', 's2']);
  });

  it('treats a 202 UNKNOWN receipt as unknown, not as filled', async () => {
    const { api } = fake([
      { ok: true, data: receipt('s1', 'FILLED') },
      { ok: true, data: receipt('s2', 'UNKNOWN', { error: 'Hyperliquid did not answer' }) },
    ]);
    expect(await runMirror({ api, token: 't', body, privateKey: AGENT_KEY })).toMatchObject({
      kind: 'unknown',
      detail: 'Hyperliquid did not answer',
    });
  });

  it('surfaces a policy change between prepare and execute as a refusal', async () => {
    const refusals = [{ code: 'POLICY_CHANGED', message: 'the trader closed BTC' }];
    const { api } = fake([
      { ok: false, status: 409, error: 'REFUSED', message: 'refused', refusals },
    ]);
    expect(await runMirror({ api, token: 't', body, privateKey: AGENT_KEY })).toEqual({
      kind: 'refused',
      refusals,
      groupId: 'g1',
    });
  });

  it.each([
    ['a gateway error', { ok: false, status: 502, error: 'HTTP_502', message: 'Bad Gateway' }],
    ['an engine crash', { ok: false, status: 500, error: 'INTERNAL', message: 'boom' }],
    ['a request timeout', { ok: false, status: 408, error: 'HTTP_408', message: 'Timeout' }],
    ['an unreadable 2xx', { ok: false, status: 200, error: 'BAD_RESPONSE', message: 'empty' }],
    ['a network error', { ok: false, status: 0, error: 'NETWORK', message: 'fetch failed' }],
  ] as const)('reports %s on the order step as unknown, never as not sent', async (_n, res) => {
    const { api, executed } = fake([{ ok: true, data: receipt('s1', 'FILLED') }, res]);
    const r = await runMirror({ api, token: 't', body, privateKey: AGENT_KEY, now: () => T0 });
    expect(r).toMatchObject({
      kind: 'unknown',
      groupId: 'g1',
      stepId: 's2',
      since: T0,
      detail: res.message,
    });
    expect(executed).toEqual(['s1', 's2']);
  });

  it('reports a definitive rejection of the order as not placed', async () => {
    const { api } = fake([
      { ok: true, data: receipt('s1', 'FILLED') },
      { ok: false, status: 422, error: 'REJECTED', message: 'Insufficient margin' },
    ]);
    expect(await runMirror({ api, token: 't', body, privateKey: AGENT_KEY })).toMatchObject({
      kind: 'error',
      code: 'REJECTED',
      message: 'Insufficient margin',
    });
  });

  it('stops with an error when the leverage step fails, before any order is sent', async () => {
    const { api, executed } = fake([
      { ok: false, status: 502, error: 'HTTP_502', message: 'Bad Gateway' },
    ]);
    expect(await runMirror({ api, token: 't', body, privateKey: AGENT_KEY })).toMatchObject({
      kind: 'error',
      code: 'HTTP_502',
    });
    expect(executed).toEqual(['s1']);
  });

  it('treats only a 4xx other than 408 as definitive, like the engine', () => {
    const statuses = [0, 200, 202, 400, 401, 404, 408, 409, 410, 422, 451, 499, 500, 502, 504];
    expect(statuses.filter(isDefinitiveRejection)).toEqual([
      400, 401, 404, 409, 410, 422, 451, 499,
    ]);
  });
});

describe('resolving an unknown order from the engine’s order log', () => {
  const row = (o: Partial<MirrorOrderView> = {}): MirrorOrderView => ({
    id: 's2',
    groupId: 'g1',
    kind: 'order',
    ticker: 'OOH',
    coin: 'BTC',
    status: 'UNKNOWN',
    notionalUsd: 50,
    refusals: null,
    hlOid: null,
    avgPx: null,
    error: null,
    createdAt: T0,
    explorerUrl: 'https://app.hyperliquid.xyz/explorer/address/0xabc',
    ...o,
  });
  const later = T0 + 60 * 60_000;

  it('keeps waiting while the engine has no definitive answer', () => {
    expect(resolveUnknown(row(), T0, later)).toEqual({ kind: 'unknown', status: 'unknown' });
    expect(resolveUnknown(row({ status: 'SUBMITTED' }), T0, later)).toEqual({
      kind: 'unknown',
      status: 'submitted',
    });
    expect(resolveUnknown(undefined, T0, later)).toEqual({
      kind: 'unknown',
      status: 'no record yet',
    });
    expect(resolveUnknown(row({ status: 'PREPARED' }), T0, T0 + 30_000).kind).toBe('unknown');
  });

  it('reports a fill found on Hyperliquid and keeps the reconcile note off the stop-loss line', () => {
    const note = 'reconciled from the Hyperliquid position; fill price unknown';
    expect(resolveUnknown(row({ status: 'FILLED', error: note }), T0, later)).toMatchObject({
      kind: 'filled',
      closed: false,
      note,
      warning: null,
      receipt: { stepId: 's2', kind: 'order', status: 'FILLED', avgPx: null },
    });
    const warning = 'stop-loss not placed: bad trigger — set a stop on Hyperliquid';
    expect(
      resolveUnknown(row({ status: 'FILLED', hlOid: 7, avgPx: 1.5, error: warning }), T0, later),
    ).toMatchObject({ kind: 'filled', warning, note: null, receipt: { hlOid: 7, avgPx: 1.5 } });
    expect(resolveUnknown(row({ status: 'RESTING' }), T0, later).kind).toBe('filled');
    expect(resolveUnknown(row({ status: 'CLOSED' }), T0, later)).toMatchObject({
      kind: 'filled',
      closed: true,
    });
  });

  it('reports a definitive rejection', () => {
    expect(
      resolveUnknown(row({ status: 'REJECTED', error: 'Insufficient margin' }), T0, later),
    ).toEqual({
      kind: 'rejected',
      message: 'Insufficient margin',
    });
  });

  it('calls a prepared step not placed only once no request can still reach it', () => {
    const prepared = row({ status: 'PREPARED' });
    const at = T0 + STEP_TTL_MS + 3 * 60_000;
    // Long expired on the engine, but our request failed moments ago: it may still be in flight.
    expect(resolveUnknown(prepared, at - 5_000, at).kind).toBe('unknown');
    expect(resolveUnknown(prepared, T0 + 10_000, at)).toMatchObject({ kind: 'rejected' });
  });
});

describe('orders still unknown on the engine', () => {
  const row = (o: Partial<MirrorOrderView>): MirrorOrderView => ({
    id: 's1',
    groupId: 'g1',
    kind: 'order',
    ticker: 'OOH',
    coin: 'BTC',
    status: 'UNKNOWN',
    notionalUsd: 50,
    refusals: null,
    hlOid: null,
    avgPx: null,
    error: null,
    createdAt: T0,
    explorerUrl: null,
    ...o,
  });

  it('lists UNKNOWN and SUBMITTED orders, newest first, minus the ones put aside', () => {
    const rows = [
      row({ id: 'a', createdAt: T0 }),
      row({ id: 'b', status: 'SUBMITTED', createdAt: T0 + 1 }),
      row({ id: 'c', status: 'FILLED' }),
      row({ id: 'd', kind: 'leverage' }),
      row({ id: 'e', createdAt: T0 + 2 }),
    ];
    expect(unresolvedOrders(rows, new Set(['e'])).map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('turns one into the checking state without inventing the order it cannot know', () => {
    const out = unknownFromLog(row({ id: 's7', error: null }));
    expect(out).toMatchObject({
      kind: 'unknown',
      stepId: 's7',
      order: null,
      logged: { ticker: 'OOH', coin: 'BTC', notionalUsd: 50 },
    });
  });
});

describe('agent key problems', () => {
  const err = (code: string, message: string): MirrorOutcome => ({
    kind: 'error',
    code,
    message,
    receipts: [],
  });

  it('asks for a new agent key when the engine or Hyperliquid no longer accepts this one', () => {
    expect(agentProblem(err('BAD_SIGNATURE', 'not signed by your approved agent key'))).toBe(true);
    expect(agentProblem(err('NO_AGENT', 'approve a Whale Street agent key first'))).toBe(true);
    expect(agentProblem(err('REJECTED', 'User or API Wallet 0xab12 does not exist.'))).toBe(true);
    expect(agentProblem(err('REJECTED', 'Insufficient margin to place order.'))).toBe(false);
    expect(agentProblem(err('HTTP_502', 'Bad Gateway'))).toBe(false);
  });

  it('asks to link the wallet again, not for a new key, when the player’s wallet changed', () => {
    const changed = err('NO_WALLET', 'your linked wallet changed');
    expect(agentProblem(changed)).toBe(false);
    expect(walletProblem(changed)).toBe(true);
    expect(walletProblem(err('BAD_SIGNATURE', 'not signed by your approved agent key'))).toBe(
      false,
    );
  });
});

describe('engine limits quoted by the ticket', () => {
  it('match the engine’s own constants', () => {
    expect(MARKET_SLIPPAGE).toBe(ENGINE_SLIPPAGE);
    expect(BUILDER_FEE_CEILING).toBe(MAX_BUILDER_FEE);
    expect(STEP_TTL_MS).toBe(ENGINE_STEP_TTL_MS);
  });
});

describe('agent approval', () => {
  const FEE = {
    approved: false,
    maxFeeRate: 0,
    requiredFee: 80,
    builderAddress: '0x00000000000000000000000000000000000b0b0b' as const,
  };
  function setup(
    register: Awaited<ReturnType<Api['registerAgent']>> = { ok: true, data: { ok: true } },
  ) {
    const { sent, transport } = capture();
    const registered: string[] = [];
    const store = createMemoryKeyStore();
    const api: Pick<Api, 'builderFee' | 'registerAgent'> = {
      builderFee: async () => ({ ok: true, data: FEE }),
      registerAgent: async (_t, _m, agentAddress) => {
        registered.push(agentAddress);
        return register;
      },
    };
    const base = { api, token: 't', store, master: master.address.toLowerCase(), now: () => T0 };
    return { sent, transport, registered, store, base };
  }
  /** Signs the first `n` typed-data requests, then declines like a wallet does. */
  const declinesAfter = (n: number) => {
    let left = n;
    return {
      address: master.address,
      signTypedData: async (a: Parameters<typeof master.signTypedData>[0]) => {
        if (left-- > 0) return master.signTypedData(a);
        throw new UserRejectedRequestError(new Error('User denied message signature.'));
      },
    };
  };

  it('marks the key usable only after Hyperliquid, the builder fee and the engine accepted it', async () => {
    const { sent, transport, registered, store, base } = setup();
    const rec = await approveAgentKey({ ...base, signer: { wallet: master, transport } });
    expect(sent.map((s) => (s.payload.action as { type: string }).type)).toEqual([
      'approveAgent',
      'approveBuilderFee',
    ]);
    expect(registered).toEqual([rec.agentAddress]);
    expect(isUsable(await store.load(master.address), T0)).toBe(true);
  });

  it('keeps a key pending when the builder fee is declined, and reuses it on retry', async () => {
    const { sent, transport, registered, store, base } = setup();
    const wallet = declinesAfter(1);
    const declined = await approveAgentKey({ ...base, signer: { wallet, transport } }).catch(
      (e: unknown) => e,
    );
    expect(hlErrorText(declined)).toBe('You declined the signature in your wallet.');
    const pending = await store.load(master.address);
    expect(pending?.approvedAt).toBeNull();
    expect(isUsable(pending, T0)).toBe(false);
    expect(registered).toEqual([]);

    const rec = await approveAgentKey({ ...base, signer: { wallet: master, transport } });
    expect(rec.agentAddress).toBe(pending?.agentAddress);
    // approveAgent was accepted the first time: the retry does not approve it again.
    expect(sent.map((s) => (s.payload.action as { type: string }).type)).toEqual([
      'approveAgent',
      'approveBuilderFee',
    ]);
    expect(registered).toEqual([rec.agentAddress]);
    expect(isUsable(await store.load(master.address), T0)).toBe(true);
  });

  it('keeps a key pending when the engine refuses to register it', async () => {
    const { transport, store, base } = setup({
      ok: false,
      status: 409,
      error: 'WALLET_IN_USE',
      message: 'this wallet already trades through another player',
    });
    await expect(
      approveAgentKey({ ...base, signer: { wallet: master, transport } }),
    ).rejects.toThrow('this wallet already trades through another player');
    expect(isUsable(await store.load(master.address), T0)).toBe(false);
  });
});

describe('the agent key never leaves the browser', () => {
  it('appears in no request body, header, URL or log line of a full approve and send', async () => {
    const seen: string[] = [];
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        seen.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
      }),
    );
    const hl: IRequestTransport = {
      isTestnet: false,
      async request(endpoint, payload) {
        seen.push(endpoint, JSON.stringify(payload));
        return { status: 'ok', response: { type: 'default' } } as never;
      },
    };
    const prepared: PrepareView = {
      ok: true,
      groupId: 'g1',
      order: {
        coin: 'BTC',
        isBuy: true,
        notionalUsd: 50,
        size: 0.00044,
        leverage: 2,
        stopLossPx: 99_706,
        markPx: 113_950,
      },
      steps: (['leverage', 'order'] as const).map((kind, i) => ({
        stepId: `s${i + 1}`,
        kind,
        eip712: {
          domain: { name: 'Exchange', version: '1', chainId: 1337 },
          types: { Agent: [{ name: 'source', type: 'string' }] },
          primaryType: 'Agent',
          message: { source: `s${i + 1}` },
        },
      })),
    };
    const engine = fakeFetch({
      'GET /api/mirror/builder-fee': () =>
        json({
          approved: false,
          maxFeeRate: 0,
          requiredFee: 80,
          builderAddress: `0x${'b'.repeat(40)}`,
        }),
      'POST /api/mirror/agent': () => json({ ok: true }),
      'POST /api/mirror/prepare': () => json(prepared),
      'POST /api/mirror/execute': ({ init }) => {
        const { stepId } = JSON.parse(String(init.body)) as { stepId: string };
        return json({
          stepId,
          kind: stepId === 's1' ? 'leverage' : 'order',
          status: 'FILLED',
          hlOid: 1,
          avgPx: 1,
          error: null,
          explorerUrl: '',
        });
      },
    });
    const api = createApi('http://engine.test', engine.impl);
    const store = createMemoryKeyStore();
    const rec = await approveAgentKey({
      api,
      token: 'tok',
      store,
      master: master.address.toLowerCase(),
      signer: { wallet: master, transport: hl },
    });
    const out = await runMirror({
      api,
      token: 'tok',
      body: { ticker: 'OOH', coin: 'BTC', notionalUsd: 50, leverage: 2, stopLossPct: 0.25 },
      privateKey: rec.privateKey,
    });
    for (const l of logs) l.mockRestore();
    expect(out.kind).toBe('filled');
    for (const c of engine.calls)
      seen.push(c.url.toString(), JSON.stringify(c.init.headers ?? {}), String(c.init.body ?? ''));
    expect(engine.calls.length).toBeGreaterThanOrEqual(4);
    const hex = rec.privateKey.slice(2).toLowerCase();
    expect(seen.join('\n').toLowerCase()).toContain(rec.agentAddress.slice(2).toLowerCase());
    expect(seen.join('\n').toLowerCase()).not.toContain(hex);
  });
});

describe('IndexedDB key store', () => {
  it('round-trips a record, removes it, and finds nothing in a cleared database', async () => {
    const db = fakeIndexedDb();
    const store = createIdbKeyStore(db.factory);
    const r = newAgent(master.address, T0);
    await store.save(r);
    expect(await store.load(master.address.toUpperCase().replace('0X', '0x'))).toEqual(r);
    await store.remove(master.address);
    expect(await store.load(master.address)).toBeNull();
    await store.save(r);
    expect(await createIdbKeyStore(fakeIndexedDb().factory).load(master.address)).toBeNull();
  });

  it('reports a save only once the transaction committed', async () => {
    const db = fakeIndexedDb();
    await createIdbKeyStore(db.factory).save(newAgent(master.address, T0));
    expect(db.committed.has(master.address.toLowerCase())).toBe(true);
  });

  it('rejects a failed write and closes the database', async () => {
    const db = fakeIndexedDb({ failWrites: true });
    await expect(createIdbKeyStore(db.factory).save(newAgent(master.address, T0))).rejects.toThrow(
      'QuotaExceededError',
    );
    expect(db.committed.size).toBe(0);
    expect(db.open).toBe(0);
  });
});

/**
 * Just enough of IndexedDB for the key store: requests succeed a tick before their transaction
 * commits (as in browsers), and a failed write aborts the transaction.
 */
function fakeIndexedDb(o: { failWrites?: boolean } = {}) {
  const committed = new Map<string, unknown>();
  let hasStore = false;
  const state = { committed, open: 0 };
  const later = (fn: () => void) => setTimeout(fn, 0);
  const factory = {
    open() {
      const req: Record<string, unknown> & {
        onupgradeneeded?: () => void;
        onsuccess?: () => void;
      } = {};
      later(() => {
        state.open += 1;
        const db = {
          objectStoreNames: { contains: () => hasStore },
          createObjectStore: () => {
            hasStore = true;
          },
          close: () => {
            state.open = Math.max(0, state.open - 1);
          },
          transaction: () => {
            const tx: Record<string, unknown> & {
              oncomplete?: () => void;
              onerror?: () => void;
              onabort?: () => void;
            } = {};
            const request = (op: () => unknown, write: (() => void) | null) => {
              const r: Record<string, unknown> & { onsuccess?: () => void; onerror?: () => void } =
                {};
              later(() => {
                if (write && o.failWrites) {
                  r.error = new Error('QuotaExceededError');
                  tx.error = r.error;
                  r.onerror?.();
                  tx.onerror?.();
                  tx.onabort?.();
                  return;
                }
                r.result = op();
                r.onsuccess?.();
                later(() => {
                  write?.();
                  tx.oncomplete?.();
                });
              });
              return r;
            };
            tx.objectStore = () => ({
              get: (k: string) => request(() => committed.get(k), null),
              put: (v: { master: string }) =>
                request(
                  () => v.master,
                  () => committed.set(v.master, structuredClone(v)),
                ),
              delete: (k: string) =>
                request(
                  () => undefined,
                  () => committed.delete(k),
                ),
            });
            return tx;
          },
        };
        req.result = db;
        if (!hasStore) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
  return {
    factory: factory as unknown as IDBFactory,
    committed,
    get open() {
      return state.open;
    },
  };
}
