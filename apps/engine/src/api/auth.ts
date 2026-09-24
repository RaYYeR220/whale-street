import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Engine } from '../engine';
import type { PlayerView } from '../services/players';

/** Extracts the token from an `Authorization: Bearer <token>` header. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(\S+)$/i);
  return m?.[1] ?? null;
}

export function playerFrom(e: Engine, req: FastifyRequest): PlayerView | null {
  return e.players.auth(bearerToken(req.headers.authorization));
}

export function sendError(
  reply: FastifyReply,
  status: number,
  error: string,
  message: string,
): FastifyReply {
  return reply.code(status).send({ error, message });
}

/**
 * Resolves the caller or answers 401; handlers return early on null. An authenticated write
 * (any method but GET/HEAD) counts as activity: it wakes the engine from IDLE and keeps it awake
 * like a WS viewer would (see IdleGate.touch).
 */
export function requirePlayer(
  e: Engine,
  req: FastifyRequest,
  reply: FastifyReply,
): PlayerView | null {
  const p = playerFrom(e, req);
  if (!p) sendError(reply, 401, 'UNAUTHORIZED', 'missing or invalid bearer token');
  else if (req.method !== 'GET' && req.method !== 'HEAD') e.idle.touch(e.clock.now());
  return p;
}
