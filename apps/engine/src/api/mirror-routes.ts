import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { MINUTE_MS } from '../dates';
import type { Engine } from '../engine';
import type { MirrorError } from '../services/mirror';
import { requirePlayer, sendError } from './auth';
import { RateGate } from './rate';

const AgentBody = z.object({ masterAddress: z.string().max(64), agentAddress: z.string().max(64) });
const PrepareBody = z.object({
  ticker: z.string().min(1).max(8),
  coin: z.string().min(1).max(20),
  notionalUsd: z.number().positive(),
  leverage: z.number().int().min(1).max(50),
  stopLossPct: z.number().positive().max(1).optional(),
});
const ExecuteBody = z.object({
  stepId: z.string().min(1).max(64),
  signature: z.object({
    r: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
    s: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
    v: z.number().int(),
  }),
});

const fail = (reply: FastifyReply, e: MirrorError) =>
  reply
    .code(e.status)
    .send({ error: e.code, message: e.message, ...(e.refusals ? { refusals: e.refusals } : {}) });

export function registerMirrorRoutes(app: FastifyInstance, e: Engine): void {
  const prepares = new RateGate(10, MINUTE_MS, () => e.wallNow());

  app.get('/api/mirror/status', async () => ({
    available: e.mirror.available(),
    mode: e.config.mode,
  }));

  app.get('/api/mirror/builder-fee', async (req, reply) => {
    const player = requirePlayer(e, req, reply);
    if (!player) return reply;
    const r = await e.mirror.builderStatus(player.id);
    return r.ok ? r.status : fail(reply, r);
  });

  app.post('/api/mirror/agent', async (req, reply) => {
    const player = requirePlayer(e, req, reply);
    if (!player) return reply;
    const body = AgentBody.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'BAD_REQUEST', z.prettifyError(body.error));
    const r = e.mirror.registerAgent(player.id, body.data.masterAddress, body.data.agentAddress);
    return r.ok ? { ok: true } : fail(reply, r);
  });

  app.post('/api/mirror/prepare', async (req, reply) => {
    const player = requirePlayer(e, req, reply);
    if (!player) return reply;
    const body = PrepareBody.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'BAD_REQUEST', z.prettifyError(body.error));
    if (!prepares.allow(player.id))
      return sendError(reply, 429, 'RATE_LIMITED', 'at most 10 mirror prepares per minute');
    const r = await e.mirror.prepare(player.id, body.data);
    return r.ok ? r : fail(reply, r);
  });

  app.post('/api/mirror/execute', async (req, reply) => {
    const player = requirePlayer(e, req, reply);
    if (!player) return reply;
    const body = ExecuteBody.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'BAD_REQUEST', z.prettifyError(body.error));
    const r = await e.mirror.execute(player.id, body.data.stepId, body.data.signature);
    if (!r.ok) return fail(reply, r);
    // 202: sent, but the outcome is not known yet ("result unknown — check Hyperliquid").
    return reply.code(r.receipt.status === 'UNKNOWN' ? 202 : 200).send(r.receipt);
  });

  app.get('/api/mirror/orders', async (req, reply) => {
    const player = requirePlayer(e, req, reply);
    if (!player) return reply;
    // Answer from storage at once; the (rate-limited) Hyperliquid reconcile runs in the background.
    e.track(
      e.mirror
        .reconcile(player.id)
        .catch((err) => e.log.warn('mirror reconcile failed', { error: String(err) })),
    );
    return { orders: e.mirror.orders(player.id) };
  });
}
