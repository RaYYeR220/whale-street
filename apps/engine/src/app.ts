import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerMcp } from './api/mcp';
import { registerMirrorRoutes } from './api/mirror-routes';
import { type Gates, RateGate } from './api/rate';
import { registerRest } from './api/rest';
import { registerWs } from './api/ws';
import type { Engine } from './engine';

/** One Fastify instance serves REST (/api), WebSocket (/ws) and MCP (/mcp) on one port. */
export async function buildApp(e: Engine): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 64 * 1024 });
  await app.register(cors, { origin: e.config.corsOrigins });
  await app.register(websocket, { options: { maxPayload: 64 * 1024, perMessageDeflate: false } });
  // Shared across REST and MCP so an agent can't bypass the per-player order limit via /mcp.
  // Wall time: a REPLAY loop wrap must neither reset nor freeze a rate window.
  const gates: Gates = { orders: new RateGate(10, 1_000, () => e.wallNow()) };
  registerRest(app, e, gates);
  registerWs(app, e);
  registerMirrorRoutes(app, e);
  registerMcp(app, e, gates);
  return app;
}
