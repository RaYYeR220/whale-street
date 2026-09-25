// @vitest-environment jsdom
/**
 * The Mirror ticket as a player uses it: a wallet (mocked wagmi), a fake engine behind the real
 * API client, and an in-memory agent key store. Real money depends on these paths.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type Hex, UserRejectedRequestError, verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseSiweMessage } from 'viem/siwe';
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
  chainId: 42_161 as number | undefined,
  client: null as unknown,
  /** personal_sign of the connected wallet. */
  sign: async (_message: string): Promise<string> => '0x',
}));
vi.mock('wagmi', () => ({
  useConnection: () => ({ address: wallet.address, chainId: wallet.chainId }),
  useConnectors: () => [],
  useConnect: () => ({ mutateAsync: async () => undefined }),
  useSignMessage: () => ({
    mutateAsync: ({ message }: { message: string }) => wallet.sign(message),
  }),
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
  /** The order log is unreachable while this returns true (the engine answers 503). */
  ordersDown?: () => boolean;
  status?: () => Reply;
  /** The player's linked wallet as /api/me reports it (default: the connected master). */
  linked?: () => string | null;
  link?: (body: { message: string; signature: string }) => Reply;
  agent?: () => Reply;
}) {
  const seen = {
    prepare: 0,
    prepareBodies: [] as Array<Record<string, unknown>>,
    execute: [] as string[],
    orders: 0,
    agents: [] as string[],
    links: [] as Array<{ message: string; signature: string }>,
  };
  const fake = fakeFetch({
    'GET /api/auth/nonce': () => json({ nonce: 'a1b2c3d4e5f60718', message: 'Link this wallet.' }),
    'POST /api/auth/link': ({ init }) => {
      const body = JSON.parse(String(init.body)) as { message: string; signature: string };
      seen.links.push(body);
      return o.link?.(body) ?? json({ error: 'BAD_SIGNATURE', message: 'no' }, 401);
    },
    'GET /api/mirror/builder-fee': () =>
      json({
        approved: false,
        maxFeeRate: 0,
        requiredFee: 80,
        builderAddress: `0x${'b'.repeat(40)}`,
      }),
    'POST /api/mirror/agent': ({ init }) => {
      if (o.agent) return o.agent();
      seen.agents.push((JSON.parse(String(init.body)) as { agentAddress: string }).agentAddress);
      return json({ ok: true });
    },
    'GET /api/me': () =>
      json({
        player: {
          id: 'p1',
          handle: 'Tester',
          kind: 'human',
          walletAddress: o.linked ? o.linked() : MASTER,
          createdAt: 0,
        },
        portfolio: portfolio(),
        seasons: [],
      }),
    'GET /api/mirror/status': o.status ?? (() => json({ available: true, mode: 'live' })),
    'GET /api/mirror/orders': () => {
      seen.orders += 1;
      if (o.ordersDown?.()) return json({ error: 'INTERNAL', message: 'engine restarting' }, 503);
      return json({ orders: o.orders?.() ?? [] });
    },
    'POST /api/mirror/prepare': ({ init }) => {
      seen.prepare += 1;
      seen.prepareBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
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

function tree(engine: ReturnType<typeof fakeEngine>, keyStore: KeyStore, v: CompanyView) {
  return (
    <EngineProvider runtime={engine.runtime}>
      <PlayerProvider>
        <ToastProvider>
          <DrawerProvider>
            <MirrorTicket view={v} keyStore={keyStore} />
          </DrawerProvider>
        </ToastProvider>
      </PlayerProvider>
    </EngineProvider>
  );
}

/** Renders the ticket; `update` re-renders it with a refreshed company view, as the page does. */
function mount(engine: ReturnType<typeof fakeEngine>, keyStore: KeyStore, v = view()) {
  const r = render(tree(engine, keyStore, v));
  return { ...r, update: (next: CompanyView) => r.rerender(tree(engine, keyStore, next)) };
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
  wallet.chainId = 42_161;
  wallet.sign = async () => '0x';
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
    expect(send.textContent).toBe('Sign and send $50 long BTC');
    expect(screen.getByText(/snapshot 5 min old, refreshed when you send/)).toBeTruthy();
  });

  it('shows a refusal on market data as likely, lets the engine decide and renders its answer', async () => {
    const refusals = [{ code: 'ANTI_FOMO', message: 'you’d enter 8.0% worse than the trader' }];
    const engine = fakeEngine({ prepare: () => json({ ok: false, groupId: 'g2', refusals }) });
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

describe('Mirror ticket: the position you picked', () => {
  const ETH: PositionView = {
    coin: 'ETH',
    size: -20,
    entryPx: 4_000,
    liqPx: 4_800,
    leverage: 3,
    marginUsed: 1,
    unrealizedPnl: 0,
    mark: 3_990,
    hp: 0.8,
  };
  const changed = /The trader's position changed — pick again/;

  it('names the coin and side it sends', async () => {
    mount(fakeEngine({}), await approvedStore(), view({ positions: [BTC, ETH] }));
    expect((await toSend()).textContent).toBe('Sign and send $50 long BTC');
  });

  it('stops Send, instead of switching coin, when the trader closes the picked position', async () => {
    const engine = fakeEngine({});
    const m = mount(engine, await approvedStore(), view({ positions: [BTC, ETH] }));
    await toSend();
    m.update(view({ positions: [ETH] }));
    expect((await screen.findByRole('alert')).textContent).toMatch(changed);
    const send = screen.getByRole('button', { name: 'Sign and send $50 long BTC' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /ETH/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Pick again' }));
    fireEvent.click(screen.getByRole('radio', { name: /SHORT ETH/ }));
    const again = await toSend();
    expect(again.textContent).toBe('Sign and send $50 short ETH');
    expect(again.disabled).toBe(false);
    expect(screen.queryByText(changed)).toBeNull();
    expect(engine.seen.prepare).toBe(0);
  });

  it.each([
    ['flips to short on the same coin', { ...BTC, size: -10 }],
    ['changes the size of the position', { ...BTC, size: 12 }],
  ])('stops Send when the trader %s', async (_n, next) => {
    const engine = fakeEngine({});
    const m = mount(engine, await approvedStore());
    await toSend();
    m.update(view({ positions: [next] }));
    expect((await screen.findByRole('alert')).textContent).toMatch(changed);
    const send = screen.getByRole('button', { name: 'Sign and send $50 long BTC' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(send);
    expect(engine.seen.prepare).toBe(0);
  });

  it('keeps Send enabled when only the price moves', async () => {
    const m = mount(fakeEngine({}), await approvedStore());
    await toSend();
    m.update(view({ positions: [{ ...BTC, mark: 114_500 }] }));
    const send = screen.getByRole('button', { name: 'Sign and send $50 long BTC' });
    expect((send as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(changed)).toBeNull();
  });

  it('asks the engine to refuse unless the trader still holds the picked side', async () => {
    const engine = fakeEngine({
      prepare: () =>
        json({
          ok: false,
          groupId: 'g1',
          refusals: [
            {
              code: 'POLICY_CHANGED',
              message: 'the trader no longer holds the ETH short you picked',
            },
          ],
        }),
    });
    mount(engine, await approvedStore(), view({ positions: [BTC, ETH] }));
    fireEvent.click(await screen.findByRole('radio', { name: /SHORT ETH/ }));
    fireEvent.click(await toSend());
    expect(await screen.findByText(/no longer holds the ETH short you picked/)).toBeTruthy();
    expect(engine.seen.prepareBodies).toEqual([
      expect.objectContaining({ coin: 'ETH', expect: { coin: 'ETH', side: 'SHORT' } }),
    ]);
    expect(engine.seen.execute).toEqual([]);
  });

  it('signs nothing when the engine prepares a different side than the one picked', async () => {
    const engine = fakeEngine({
      prepare: () => json({ ...PREPARED, order: { ...order, isBuy: false } }),
    });
    mount(engine, await approvedStore());
    fireEvent.click(await toSend());
    expect((await screen.findByRole('alert')).textContent).toMatch(/position changed/);
    expect(engine.seen.prepare).toBe(1);
    expect(engine.seen.execute).toEqual([]);
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
    const again = screen.getByRole('button', { name: 'Sign and send $50 long BTC' });
    expect((again as HTMLButtonElement).disabled).toBe(false);
    expect(engine.seen.execute).toEqual([]);
  });
});

describe('Mirror ticket: an order whose outcome is unknown', () => {
  it('never offers to send again and settles from the engine’s order log', async () => {
    let row = orderRow();
    const engine: ReturnType<typeof fakeEngine> = fakeEngine({
      execute: (id) =>
        id === 's2'
          ? new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' })
          : json(receipt(id)),
      // The engine logs the order once it is sent.
      orders: () => (engine?.seen.execute.length ? [row] : []),
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
    const engine: ReturnType<typeof fakeEngine> = fakeEngine({
      execute: (id) =>
        id === 's2' ? json({ error: 'INTERNAL', message: 'boom' }, 500) : json(receipt(id)),
      // The engine logs the order once it is sent.
      orders: () => (engine?.seen.execute.length ? [row] : []),
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
    await screen.findByRole('button', { name: 'Sign and send $50 long BTC' });
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

describe('Mirror ticket: while this browser looks for the agent key', () => {
  it('offers no approval until the key store has answered', async () => {
    let answer: () => void = () => undefined;
    const approved = await approvedStore();
    const slow: KeyStore = {
      ...approved,
      load: async (m) => {
        await new Promise<void>((resolve) => {
          answer = resolve;
        });
        return approved.load(m);
      },
    };
    mount(fakeEngine({}), slow);
    expect(await screen.findByText(/Looking for this wallet’s agent key/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve agent key' })).toBeNull();
    answer();
    expect(await screen.findByRole('button', { name: 'Use this position' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve agent key' })).toBeNull();
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

  it('never calls a storage refusal a declined signature', async () => {
    const denied: KeyStore = {
      load: async () => {
        throw new Error('access to the Indexed Database API is denied in this context');
      },
      save: async () => undefined,
      remove: async () => undefined,
    };
    mount(fakeEngine({}), denied);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This browser cannot keep a Mirror agent key: access to the Indexed Database API is denied in this context',
    );
  });
});

describe('Mirror ticket: the engine’s answers', () => {
  it('shows a refusal at the credit floor with what reopens Mirror', async () => {
    const refusals = [
      {
        code: 'CREDIT_FLOOR',
        message: 'Nansen credits are nearly used up, so the trader data cannot be refreshed',
      },
    ];
    const engine = fakeEngine({ prepare: () => json({ ok: false, groupId: 'g3', refusals }) });
    mount(engine, await approvedStore());
    fireEvent.click(await toSend());
    await screen.findByText('The engine refused on a fresh snapshot');
    expect(screen.getByText(/reopens once Nansen credits are topped up/)).toBeTruthy();
    expect(engine.seen.execute).toEqual([]);
  });

  it('offers to link the wallet again, not a dead re-approve, when the linked wallet changed', async () => {
    let linked: string | null = MASTER;
    const engine = fakeEngine({
      linked: () => linked,
      execute: () => {
        linked = `0x${'d'.repeat(40)}`;
        return json(
          {
            error: 'NO_WALLET',
            message: 'your linked wallet changed; approve an agent key for it first',
          },
          403,
        );
      },
    });
    mount(engine, await approvedStore());
    fireEvent.click(await toSend());
    await screen.findByText('Your player is linked to another wallet now');
    expect(screen.queryByRole('button', { name: 'Re-approve agent' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Link this wallet again' }));
    expect(await screen.findByRole('button', { name: 'Sign to link' })).toBeTruthy();
  });

  it('tells the player to link the wallet when it mirrors through another player', async () => {
    stubHyperliquid();
    const engine = fakeEngine({
      agent: () =>
        json({ error: 'WALLET_IN_USE', message: 'this wallet trades through another player' }, 409),
    });
    const store = createMemoryKeyStore();
    mount(engine, store);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve agent key' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /mirrors through another Whale Street player. Link it to this player first/,
    );
    expect((await store.load(MASTER))?.approvedAt).toBeNull();
  });
});

describe('Mirror ticket: an order still unknown after a reload', () => {
  it('opens on the checking state from the engine’s order log and never offers a resend', async () => {
    // The engine stores size × mark, so the notional arrives as a raw float.
    const notionalUsd = 49.8671999;
    let row = orderRow({ status: 'SUBMITTED', notionalUsd });
    const engine = fakeEngine({ orders: () => [row] });
    mount(engine, await approvedStore());
    await screen.findByText('Outcome unknown — checking with Hyperliquid');
    expect(screen.getByText(/\$49\.87 of BTC/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/49\.867/);
    for (const name of [/Sign and send/, /Use this position/, /Start again/])
      expect(screen.queryByRole('button', { name })).toBeNull();
    row = orderRow({ status: 'FILLED', avgPx: 113_990, hlOid: 42, notionalUsd });
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await screen.findByText(/Mirrored BTC, \$49\.87$/);
    expect(engine.seen.prepare).toBe(0);
    expect(engine.seen.execute).toEqual([]);
  });

  it('names an unknown order on another company without blocking this one', async () => {
    const engine = fakeEngine({ orders: () => [orderRow({ ticker: 'GBC', coin: 'ETH' })] });
    mount(engine, await approvedStore());
    expect((await screen.findByTestId('mirror-elsewhere')).textContent).toMatch(
      /GBC \(ETH\).*still being checked with Hyperliquid/,
    );
    expect(await toSend()).toBeTruthy();
  });

  it('can be put aside after an engine check and a confirmation, and stays put aside', async () => {
    const engine = fakeEngine({
      orders: () => [orderRow({ status: 'UNKNOWN', createdAt: Date.now() - 10 * 60_000 })],
    });
    const store = await approvedStore();
    mount(engine, store);
    await screen.findByText('Outcome unknown — checking with Hyperliquid');
    // Old enough, but this page has not heard back from a single engine check yet.
    expect(screen.queryByRole('button', { name: /put this aside/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await screen.findByText(/Still no definitive answer/);
    fireEvent.click(screen.getByRole('button', { name: 'Put this aside…' }));
    const confirm = screen.getByRole('group', { name: 'Put this order aside' });
    expect(confirm.textContent).toMatch(/still counts it toward your caps/);
    expect(confirm.textContent).toMatch(/opens a second position/);
    fireEvent.click(screen.getByRole('button', { name: 'I checked on Hyperliquid, put it aside' }));
    expect(await toSend()).toBeTruthy();
    cleanup();
    mount(engine, store);
    expect(await toSend()).toBeTruthy();
    expect(screen.queryByText('Outcome unknown — checking with Hyperliquid')).toBeNull();
  });

  it('offers no way to put aside an order sent under two minutes ago, even after checks', async () => {
    const engine = fakeEngine({
      orders: () => [orderRow({ status: 'UNKNOWN', createdAt: Date.now() - 60_000 })],
    });
    mount(engine, await approvedStore());
    await screen.findByText('Outcome unknown — checking with Hyperliquid');
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await screen.findByText(/Still no definitive answer/);
    expect(screen.queryByRole('button', { name: /put this aside/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /put it aside/i })).toBeNull();
  });

  it('can step back from putting an order aside', async () => {
    const engine = fakeEngine({
      orders: () => [orderRow({ status: 'UNKNOWN', createdAt: Date.now() - 10 * 60_000 })],
    });
    mount(engine, await approvedStore());
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));
    await screen.findByText(/Still no definitive answer/);
    fireEvent.click(screen.getByRole('button', { name: 'Put this aside…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep checking' }));
    expect(screen.queryByRole('group', { name: 'Put this order aside' })).toBeNull();
    expect(screen.getByText('Outcome unknown — checking with Hyperliquid')).toBeTruthy();
  });
});

describe('Mirror ticket: linking a wallet', () => {
  it('signs in with Ethereum for this page, then asks to approve the agent again for the new wallet', async () => {
    let linked: string | null = `0x${'c'.repeat(40)}`;
    wallet.sign = (message) => master.signMessage({ message });
    const store = await approvedStore();
    const engine = fakeEngine({
      linked: () => linked,
      link: () => {
        linked = MASTER;
        return json({
          player: {
            id: 'p1',
            handle: 'Tester',
            kind: 'human',
            walletAddress: MASTER,
            createdAt: 0,
          },
        });
      },
    });
    mount(engine, store);
    expect((await screen.findByTestId('relink-warning')).textContent).toMatch(
      /replaces it, and Mirror then needs its agent key approved again/,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign to link' }));
    await screen.findByRole('button', { name: 'Approve agent key' });
    const sent = engine.seen.links[0] as { message: string; signature: Hex };
    expect(parseSiweMessage(sent.message)).toMatchObject({
      domain: window.location.host,
      uri: window.location.origin,
      address: master.address,
      chainId: 42_161,
      nonce: 'a1b2c3d4e5f60718',
      statement: 'Link this wallet.',
      version: '1',
    });
    expect(
      await verifyMessage({
        address: master.address,
        message: sent.message,
        signature: sent.signature,
      }),
    ).toBe(true);
    expect((await store.load(MASTER))?.approvedAt).toBeNull();
  });

  it('explains a refused link in plain words', async () => {
    wallet.sign = (message) => master.signMessage({ message });
    const engine = fakeEngine({
      linked: () => null,
      link: () => json({ error: 'DOMAIN_MISMATCH', message: 'raw' }, 401),
    });
    mount(engine, await approvedStore());
    expect(screen.queryByTestId('relink-warning')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign to link' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /does not accept wallet links from this web address/,
    );
  });
});

describe('Mirror ticket: when the order log cannot be read', () => {
  const paused = /Couldn't load your Mirror orders — sending is paused until they load/;

  it('pauses sending, claims no usage and retries by itself until the log loads', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let down = true;
    const engine = fakeEngine({ ordersDown: () => down });
    mount(engine, await approvedStore());
    const send = await toSend();
    expect(send.disabled).toBe(true);
    expect((await screen.findByRole('alert')).textContent).toMatch(paused);
    const note = document.getElementById('m-usd-note')?.textContent ?? '';
    expect(note).not.toMatch(/\$0\.00/);
    expect(note).toMatch(/Used today — of \$300\.00\. Open mirrors — of 3/);
    expect(screen.getAllByText('unknown until your Mirror orders load')).toHaveLength(2);
    expect(screen.queryByText('0 of 3')).toBeNull();
    fireEvent.click(send);
    expect(engine.seen.prepare).toBe(0);
    const tries = engine.seen.orders;
    down = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine.seen.orders).toBeGreaterThan(tries);
    await screen.findByText(/Used today/);
    expect(screen.queryByText(paused)).toBeNull();
    const ready = screen.getByRole('button', { name: 'Sign and send $50 long BTC' });
    expect((ready as HTMLButtonElement).disabled).toBe(false);
    expect(document.getElementById('m-usd-note')?.textContent).toMatch(
      /Used today \$0\.00 of \$300\.00\. Open mirrors 0 of 3/,
    );
  });

  it('keeps Send off while the log is still loading', async () => {
    let answer: () => void = () => undefined;
    const engine = fakeEngine({});
    const load = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const impl = engine.runtime.api;
    engine.runtime.api = {
      ...impl,
      mirrorOrders: async (t) => {
        await load;
        return impl.mirrorOrders(t);
      },
    };
    mount(engine, await approvedStore());
    const send = await toSend();
    expect(send.disabled).toBe(true);
    expect(screen.getByText(/Reading your Mirror orders/)).toBeTruthy();
    answer();
    await vi.waitFor(() => expect(send.disabled).toBe(false));
  });

  it('shows the checking state only once a load has read the unknown order', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let down = true;
    const engine = fakeEngine({
      ordersDown: () => down,
      orders: () => [orderRow({ status: 'UNKNOWN' })],
    });
    mount(engine, await approvedStore());
    expect((await screen.findByRole('alert')).textContent).toMatch(paused);
    expect(screen.queryByText('Outcome unknown — checking with Hyperliquid')).toBeNull();
    const send = screen.queryByRole('button', {
      name: /Sign and send/,
    }) as HTMLButtonElement | null;
    if (send) expect(send.disabled).toBe(true);
    down = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again now' }));
    await screen.findByText('Outcome unknown — checking with Hyperliquid');
    expect(screen.queryByRole('button', { name: /Sign and send/ })).toBeNull();
    expect(engine.seen.prepare).toBe(0);
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

/** What a console line shows of an argument: objects in full (an Error by name, message and stack). */
const logText = (x: unknown): string => {
  if (typeof x === 'string') return x;
  if (x instanceof Error)
    return `${x.name}: ${x.message}
${x.stack ?? ''}`;
  try {
    return JSON.stringify(x) ?? String(x);
  } catch {
    return String(x);
  }
};

describe('Mirror ticket: the agent key never leaves the browser', () => {
  it('appears in no request, header or log line from approval to a filled order', async () => {
    const hl = stubHyperliquid();
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        lines.push(a.map(logText).join(' '));
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
