import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerMirrorRoutes } from './api/mirror-routes';
import { registerRest } from './api/rest';
import { registerWs } from './api/ws';
import type { Engine } from './engine';

/** One Fastify instance serves REST (/api), WebSocket (/ws) and MCP (/mcp) on one port. */
export async function buildApp(e: Engine): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 64 * 1024 });
  await app.register(cors, { origin: e.config.corsOrigins });
  await app.register(websocket, { options: { maxPayload: 64 * 1024, perMessageDeflate: false } });
  registerRest(app, e);
  registerWs(app, e);
  registerMirrorRoutes(app, e);
  return app;
}
