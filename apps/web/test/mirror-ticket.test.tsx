// @vitest-environment jsdom
/**
 * The Mirror ticket as a player uses it: a wallet (mocked wagmi), a fake engine behind the real
 * API client, and an in-memory agent key store. Real money depends on these paths.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type Hex, UserRejectedRequestError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawerProvider } from '../components/chrome/Drawer';
import { ToastProvider } from '../components/chrome/Toast';
import { MirrorTicket } from '../components/mirror/MirrorTicket';
import { EngineProvider, type EngineRuntime } from '../components/providers/engine';
import { PlayerProvider } from '../components/providers/player';
import { createApi } from '../lib/api';
import type {
  CompanyView,
  MirrorOrderView,
  MirrorReceipt,
  PositionView,
  PrepareView,
} from '../lib/api-types';
import { newAgent } from '../lib/mirror/agent';
import { createMemoryKeyStore, type KeyStore } from '../lib/mirror/keystore';
import { TOKEN_KEY } from '../lib/player';
import { createEngineStore } from '../lib/store';
import { EngineSocket } from '../lib/ws-client';
import { companyView, FakeSocket, fakeFetch, json, portfolio } from './helpers';

const wallet = vi.hoisted(() => ({
  address: undefined as string | undefined,
  client: null as unknown,
}));
vi.mock('wagmi', () => ({
  useConnection: () => ({ address: wallet.address }),
  useConnectors: () => [],
  useConnect: () => ({ mutateAsync: async () => undefined }),
  useSignMessage: () => ({ mutateAsync: async () => '0x' }),
  createConfig: () => ({}),
  http: () => ({}),
  injected: () => ({}),
}));
vi.mock('wagmi/actions', () => ({ getWalletClient: async () => wallet.client }));

// Well-known test key (never used for anything real).
const MASTER_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const master = privateKeyToAccount(MASTER_KEY);
const MASTER = master.address.toLowerCase();

const BTC: PositionView = {
  coin: 'BTC',
  size: 10,
  entryPx: 111_200,
  liqPx: 58_400,
  leverage: 2,
  marginUsed: 1,
  unrealizedPnl: 0,
  mark: 113_950,
  hp: 0.82,
};
const view = (o: Partial<CompanyView> = {}): CompanyView =>
  companyView({ hp: 0.82, lastSnapshotAt: Date.now() - 5_000, positions: [BTC], ...o });

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
const PREPARED: PrepareView = {
  ok: true,
  groupId: 'g1',
  order,
  steps: [step('leverage', 's1'), step('order', 's2')],
};
const receipt = (stepId: string, o: Partial<MirrorReceipt> = {}): MirrorReceipt => ({
  stepId,
  kind: stepId === 's1' ? 'leverage' : 'order',
  status: 'FILLED',
  hlOid: stepId === 's2' ? 42 : null,
  avgPx: stepId === 's2' ? 113_990 : null,
  error: null,
  explorerUrl: `https://app.hyperliquid.xyz/explorer/address/${MASTER}`,
  ...o,
});
const orderRow = (o: Partial<MirrorOrderView> = {}): MirrorOrderView => ({
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
  createdAt: Date.now(),
  explorerUrl: `https://app.hyperliquid.xyz/explorer/address/${MASTER}`,
  ...o,
});
type Reply = Response | Promise<Response>;

/** A fake engine: the routes the ticket calls, with every request recorded. */
function fakeEngine(o: {
  prepare?: () => Reply;
  execute?: (stepId: string) => Reply;
  orders?: () => MirrorOrderView[];
  status?: () => Reply;
}) {
  const seen = { prepare: 0, execute: [] as string[], orders: 0, agents: [] as string[] };
  const fake = fakeFetch({
    'GET /api/mirror/builder-fee': () =>
      json({
        approved: false,
        maxFeeRate: 0,
        requiredFee: 80,
        builderAddress: `0x${'b'.repeat(40)}`,
      }),
    'POST /api/mirror/agent': ({ init }) => {
      seen.agents.push((JSON.parse(String(init.body)) as { agentAddress: string }).agentAddress);
      return json({ ok: true });
    },
    'GET /api/me': () =>
      json({
        player: { id: 'p1', handle: 'Tester', kind: 'human', walletAddress: MASTER, createdAt: 0 },
        portfolio: portfolio(),
        seasons: [],
      }),
    'GET /api/mirror/status': o.status ?? (() => json({ available: true, mode: 'live' })),
    'GET /api/mirror/orders': () => {
      seen.orders += 1;
      return json({ orders: o.orders?.() ?? [] });
    },
    'POST /api/mirror/prepare': () => {
      seen.prepare += 1;
      return o.prepare?.() ?? json(PREPARED);
    },
    'POST /api/mirror/execute': ({ init }) => {
      const { stepId } = JSON.parse(String(init.body)) as { stepId: string };
      seen.execute.push(stepId);
      return o.execute?.(stepId) ?? json(receipt(stepId));
    },
  });
  const runtime: EngineRuntime = {
    api: createApi('http://engine.test', fake.impl),
    store: createEngineStore(),
    socket: new EngineSocket({
      url: 'ws://engine.test/ws',
      createSocket: (u) => new FakeSocket(u),
    }),
    tokenRef: { current: null },
  };
  return { runtime, seen, calls: fake.calls };
}

async function approvedStore(): Promise<KeyStore> {
  const store = createMemoryKeyStore();
  await store.save({ ...newAgent(MASTER, Date.now()), approvedAt: Date.now() });
  return store;
}

function mount(engine: ReturnType<typeof fakeEngine>, keyStore: KeyStore, v = view()) {
  return render(
    <EngineProvider runtime={engine.runtime}>
      <PlayerProvider>
        <ToastProvider>
          <DrawerProvider>
            <MirrorTicket view={v} keyStore={keyStore} />
          </DrawerProvider>
        </ToastProvider>
      </PlayerProvider>
    </EngineProvider>,
  );
}

/** Walks the stepper up to the Send button (wallet connected, linked, agent approved). */
async function toSend(): Promise<HTMLButtonElement> {
  fireEvent.click(await screen.findByRole('button', { name: 'Use this position' }));
  return (await screen.findByRole('button', {
    name: /^Sign and send|^Refused/,
  })) as HTMLButtonElement;
}

beforeEach(() => {
  wallet.address = master.address;
  wallet.client = master;
  localStorage.setItem(TOKEN_KEY, 'tok');
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Mirror ticket: the engine has the final say', () => {
  it('keeps Send enabled on an old snapshot and says the engine refreshes it', async () => {
    const engine = fakeEngine({});
    mount(engine, await approvedStore(), view({ lastSnapshotAt: Date.now() - 5 * 60_000 }));
    const send = await toSend();
    expect(send.disabled).toBe(false);
    expect(send.textContent).toBe('Sign and send $50 mirror');
    expect(screen.getByText(/snapshot 5 min old, refreshed when you send/)).toBeTruthy();
  });

  it('shows a refusal on market data as likely, lets the engine decide and renders its answer', async () => {
    const refusals = [{ code: 'ANTI_FOMO', message: 'you’d enter 8.0% worse than the trader' }];
    const engine = fakeEngine({ prepare: () => json({ ok: true, groupId: 'g2', refusals }) });
    mount(engine, await approvedStore(), view({ positions: [{ ...BTC, mark: 111_200 * 1.08 }] }));
    const send = await toSend();
    expect(send.disabled).toBe(false);
    expect(screen.getByText('The engine will probably refuse this.')).toBeTruthy();
    fireEvent.click(send);
    await screen.findByText('The engine refused on a fresh snapshot');
    expect(engine.seen.prepare).toBe(1);
    expect(engine.seen.execute).toEqual([]);
  });

  it('blocks Send while the player’s own input is out of range', async () => {
    const engine = fakeEngine({});
    mount(engine, await approvedStore());
    await toSend();
    fireEvent.change(screen.getByLabelText('Order size'), { target: { value: '500' } });
    const send = screen.getByRole('button', { name: 'Refused by the committee' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('NOTIONAL_OUT_OF_RANGE')).toBeTruthy();
  });
});

/** Hyperliquid's /exchange behind the library's HttpTransport (global fetch). */
function stubHyperliquid(): string[] {
  const bodies: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(`${String(input)} ${String(init?.body ?? '')}`);
    return new Response(JSON.stringify({ status: 'ok', response: { type: 'default' } }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  return bodies;
}
const hlActions = (bodies: string[]) =>
  bodies.map(
    (b) => (JSON.parse(b.slice(b.indexOf(' ') + 1)) as { action: { type: string } }).action.type,
  );

describe('Mirror ticket: one click, one order', () => {
  it('sends once however fast the button is clicked', async () => {
    const engine = fakeEngine({});
    mount(engine, await approvedStore());
    const send = await toSend();
    fireEvent.click(send);
    fireEvent.click(send);
    fireEvent.click(send);
    // Busy at once: the button is replaced by the sending status before any await resolves.
    expect(screen.queryByRole('button', { name: /Sign and send/ })).toBeNull();
    await screen.findByText(/Mirrored LONG BTC 2x/);
    expect(engine.seen.prepare).toBe(1);
    expect(engine.seen.execute).toEqual(['s1', 's2']);
  });

  it('clears the spinner and shows the error when signing throws', async () => {
    const broken: PrepareView = {
      ...PREPARED,
      steps: [
        { ...step('leverage', 's1'), eip712: { ...step('leverage', 's1').eip712, types: {} } },
      ],
    };
    const engine = fakeEngine({ prepare: () => json(broken) });
    mount(engine, await approvedStore());
    fireEvent.click(await toSend());
    expect((await screen.findByRole('alert')).textContent).not.toBe('');
    expect(screen.queryByText('Your agent key is signing…')).toBeNull();
    const again = screen.getByRole('button', { name: 'Sign and send $50 mirror' });
    expect((again as HTMLButtonElement).disabled).toBe(false);
    expect(engine.seen.execute).toEqual([]);
  });
});

describe('Mirror ticket: an order whose outcome is unknown', () => {
  it('never offers to send again and settles from the engine’s order log', async () => {
    let row = orderRow();
    const engine = fakeEngine({
      execute: (id) =>
        id === 's2'
          ? new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' })
          : json(receipt(id)),
      orders: () => [row],
    });
    mount(engine, await approvedStore());
    fireEvent.click(await toSend());
    await screen.findByText('Outcome unknown — checking with Hyperliquid');
    expect(screen.queryByText('Not placed')).toBeNull();
    for (const name of [/Start again/, /Mirror another/, /Sign and send/, /Try another/])
      expect(screen.queryByRole('button', { name })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await screen.findByText(/Still no definitive answer \(unknown\)/);
    expect(screen.queryByRole('button', { name: /Sign and send/ })).toBeNull();

    row = orderRow({
      status: 'FILLED',
      error: 'reconciled from the Hyperliquid position; fill price unknown',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await screen.findByText(/Mirrored LONG BTC 2x/);
    expect(screen.getByText(/fill price unknown/)).toBeTruthy();
    expect(screen.getByText(/check that it is on Hyperliquid/)).toBeTruthy();
    expect(engine.seen.prepare).toBe(1);
    expect(engine.seen.execute).toEqual(['s1', 's2']);
  });

  it('keeps checking by itself until the engine knows', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let row = orderRow();
    const engine = fakeEngine({
      execute: (id) =>
        id === 's2' ? json({ error: 'INTERNAL', message: 'boom' }, 500) : json(receipt(id)),
      orders: () => [row],
    });
    mount(engine, await approvedStore());
    fireEvent.click(await toSend());
    await screen.findByText('Outcome unknown — checking with Hyperliquid');
    const before = engine.seen.orders;
    row = orderRow({ status: 'REJECTED', error: 'Insufficient margin to place order.' });
    await vi.advanceTimersByTimeAsync(10_000);
    await screen.findByText('Not placed');
    expect(engine.seen.orders).toBeGreaterThan(before);
    expect(screen.getByText(/Insufficient margin/)).toBeTruthy();
  });

  it('says Not placed for a definitive rejection', async () => {
    const engine = fakeEngine({
      execute: (id) =>
        id === 's2'
          ? json({ error: 'REJECTED', message: 'Insufficient margin to place order.' }, 422)
          : json(receipt(id)),
    });
    mount(engine, await approvedStore());
    fireEvent.click(await toSend());
    await screen.findByText('Not placed');
    expect(screen.getByRole('button', { name: 'Start again' })).toBeTruthy();
  });
});

describe('Mirror ticket: agent key recovery', () => {
  it('re-approves a new agent key when the engine no longer accepts the stored one', async () => {
    const hl = stubHyperliquid();
    const store = await approvedStore();
    const old = await store.load(MASTER);
    const engine = fakeEngine({
      execute: () =>
        json({ error: 'BAD_SIGNATURE', message: 'not signed by your approved agent key' }, 401),
    });
    mount(engine, store);
    fireEvent.click(await toSend());
    fireEvent.click(await screen.findByRole('button', { name: 'Re-approve agent' }));
    await screen.findByRole('button', { name: 'Sign and send $50 mirror' });
    const fresh = await store.load(MASTER);
    expect(fresh?.agentAddress).not.toBe(old?.agentAddress);
    expect(fresh?.approvedAt).not.toBeNull();
    expect(engine.seen.agents).toEqual([fresh?.agentAddress]);
    expect(hlActions(hl)).toEqual(['approveAgent', 'approveBuilderFee']);
  });

  it('offers it when Hyperliquid rejects the agent itself', async () => {
    const engine = fakeEngine({
      execute: () =>
        json({ error: 'REJECTED', message: 'User or API Wallet 0xab12 does not exist.' }, 422),
    });
    mount(engine, await approvedStore());
    fireEvent.click(await toSend());
    expect(await screen.findByRole('button', { name: 'Re-approve agent' })).toBeTruthy();
  });

  it('does not treat a key as approved until the builder fee and registration succeed', async () => {
    const hl = stubHyperliquid();
    let signed = 0;
    wallet.client = {
      address: master.address,
      signTypedData: async (a: Parameters<typeof master.signTypedData>[0]) => {
        signed += 1;
        if (signed === 1) return master.signTypedData(a);
        throw new UserRejectedRequestError(new Error('User denied message signature.'));
      },
    };
    const store = createMemoryKeyStore();
    const engine = fakeEngine({});
    mount(engine, store);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve agent key' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'You declined the signature in your wallet.',
    );
    expect((await store.load(MASTER))?.approvedAt).toBeNull();
    expect(engine.seen.agents).toEqual([]);
    expect(hlActions(hl)).toEqual(['approveAgent']);
    const retry = screen.getByRole('button', { name: 'Approve agent key' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
  });
});

describe('Mirror ticket: a browser that cannot keep the key', () => {
  it('says so instead of failing silently', async () => {
    const blocked: KeyStore = {
      load: async () => {
        throw new Error('The operation is insecure.');
      },
      save: async () => undefined,
      remove: async () => undefined,
    };
    mount(fakeEngine({}), blocked);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This browser cannot keep a Mirror agent key: The operation is insecure.',
    );
  });
});

describe('Mirror ticket: when Mirror is off', () => {
  it('says the engine could not be asked instead of inventing a reason', async () => {
    const engine = fakeEngine({ status: () => json({ error: 'X', message: 'down' }, 503) });
    mount(engine, await approvedStore());
    const off = await screen.findByTestId('mirror-off');
    expect(off.textContent).toMatch(/Cannot ask the engine whether Mirror is on/);
    expect(off.textContent).not.toMatch(/REPLAY/);
  });

  it('names REPLAY only when the engine says it replays', async () => {
    const engine = fakeEngine({ status: () => json({ available: false, mode: 'replay' }) });
    mount(engine, await approvedStore());
    const off = await screen.findByTestId('mirror-off');
    expect(off.textContent).toMatch(/Mirror is off on this engine/);
    expect(off.textContent).toMatch(/replays a recorded session/);
  });
});

describe('Mirror ticket: the agent key never leaves the browser', () => {
  it('appears in no request, header or log line from approval to a filled order', async () => {
    const hl = stubHyperliquid();
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        lines.push(a.map((x) => (typeof x === 'string' ? x : String(x))).join(' '));
      }),
    );
    const store = createMemoryKeyStore();
    const engine = fakeEngine({});
    mount(engine, store);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve agent key' }));
    fireEvent.click(await toSend());
    await screen.findByText(/Mirrored LONG BTC 2x/);
    for (const s of spies) s.mockRestore();
    const rec = await store.load(MASTER);
    expect(rec?.approvedAt).not.toBeNull();
    const wire = [
      ...hl,
      ...lines,
      ...engine.calls.map(
        (c) => `${c.url} ${JSON.stringify(c.init.headers ?? {})} ${String(c.init.body ?? '')}`,
      ),
    ]
      .join('\n')
      .toLowerCase();
    expect(engine.seen.execute).toEqual(['s1', 's2']);
    expect(wire).toContain(String(rec?.agentAddress).slice(2).toLowerCase());
    expect(wire).not.toContain(String(rec?.privateKey).slice(2).toLowerCase());
  });
});
