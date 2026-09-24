// @vitest-environment jsdom
/**
 * The Mirror ticket as a player uses it: a wallet (mocked wagmi), a fake engine behind the real
 * API client, and an in-memory agent key store. Real money depends on these paths.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Hex } from 'viem';
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
type Reply = Response | Promise<Response>;

/** A fake engine: the routes the ticket calls, with every request recorded. */
function fakeEngine(o: {
  prepare?: () => Reply;
  execute?: (stepId: string) => Reply;
  orders?: () => MirrorOrderView[];
  status?: () => Reply;
}) {
  const seen = { prepare: 0, execute: [] as string[], orders: 0 };
  const fake = fakeFetch({
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
