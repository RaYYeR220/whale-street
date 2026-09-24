/**
 * The Mirror agent key lives only in this browser (IndexedDB), keyed by the master wallet.
 * It is never sent anywhere: the engine only learns the agent's address.
 */
import type { Hex } from 'viem';

export interface AgentRecord {
  /** Master wallet (lowercase) that approved this agent on Hyperliquid. */
  master: string;
  agentAddress: `0x${string}`;
  privateKey: Hex;
  agentName: string;
  validUntil: number;
  createdAt: number;
  /** When the approveAgent action was accepted by Hyperliquid (null until then). */
  approvedAt: number | null;
}

export interface KeyStore {
  load(master: string): Promise<AgentRecord | null>;
  save(record: AgentRecord): Promise<void>;
  remove(master: string): Promise<void>;
}

export function createMemoryKeyStore(): KeyStore {
  const m = new Map<string, AgentRecord>();
  return {
    async load(master) {
      return m.get(master.toLowerCase()) ?? null;
    },
    async save(r) {
      m.set(r.master.toLowerCase(), { ...r, master: r.master.toLowerCase() });
    },
    async remove(master) {
      m.delete(master.toLowerCase());
    },
  };
}

const DB = 'whale-street';
const STORE = 'mirror-agents';

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE))
        req.result.createObjectStore(STORE, { keyPath: 'master' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

function run<T>(
  factory: IDBFactory,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return openDb(factory).then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
        tx.oncomplete = () => db.close();
      }),
  );
}

/** IndexedDB-backed store; throws on use when IndexedDB is unavailable (private mode, old browser). */
export function createIdbKeyStore(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): KeyStore {
  const need = (): IDBFactory => {
    if (!factory)
      throw new Error('This browser has no IndexedDB, so it cannot keep a Mirror agent key.');
    return factory;
  };
  return {
    async load(master) {
      const r = await run<AgentRecord | undefined>(need(), 'readonly', (s) =>
        s.get(master.toLowerCase()),
      );
      return r ?? null;
    },
    async save(r) {
      await run(need(), 'readwrite', (s) => s.put({ ...r, master: r.master.toLowerCase() }));
    },
    async remove(master) {
      await run(need(), 'readwrite', (s) => s.delete(master.toLowerCase()));
    },
  };
}
