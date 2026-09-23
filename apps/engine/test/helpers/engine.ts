import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { openDb } from '../../src/db/index';
import { createEngine, type Engine } from '../../src/engine';
import { silentLogger } from '../../src/log';
import type { TradingPort } from '../../src/ports';
import { FakeClock } from './fake-clock';
import { FakeFeed, FakeInfo } from './fake-hl';
import { FakeNansen } from './fake-nansen';

export interface TestEngine {
  engine: Engine;
  app: FastifyInstance;
  clock: FakeClock;
  nansen: FakeNansen;
  info: FakeInfo;
  feed: FakeFeed;
}

/** A full engine on fakes + in-memory SQLite, with its Fastify app (ready for inject / injectWS). */
export async function testEngine(
  o: { mode?: 'live' | 'replay'; trading?: TradingPort | null } = {},
): Promise<TestEngine> {
  const clock = new FakeClock();
  const nansen = new FakeNansen();
  const info = new FakeInfo();
  const feed = new FakeFeed();
  const config = loadConfig(
    o.mode === 'live' ? { MODE: 'live', NANSEN_API_KEY: 'test-key' } : { MODE: 'replay' },
    () => {
      throw new Error('no env file in tests');
    },
  );
  const engine = createEngine({
    config,
    db: openDb(':memory:'),
    nansen,
    trading: o.trading ?? null,
    hl: { feed, info },
    clock,
    log: silentLogger,
    replay: null,
  });
  const app = await buildApp(engine);
  await app.ready();
  return { engine, app, clock, nansen, info, feed };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
