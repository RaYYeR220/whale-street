import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { HOUR_MS, MINUTE_MS } from '../dates';
import type { Engine } from '../engine';
import type { ExchangeErrorCode } from '../services/exchange';
import { playerView } from '../services/players';
import { requirePlayer, sendError } from './auth';
import { type Gates, RateGate } from './rate';

const SIDES = ['BUY', 'SELL', 'SHORT', 'COVER'] as const;

const OrderBody = z
  .object({
    ticker: z.string().min(1).max(8),
    side: z.enum(SIDES),
    qty: z.number().positive().optional(),
    cash: z.number().positive().optional(),
  })
  .refine((b) => b.qty !== undefined || b.cash !== undefined, {
    message: 'qty or cash is required',
  });
const QuoteQuery = z.object({
  ticker: z.string().min(1).max(8),
  side: z.enum(SIDES),
  qty: z.coerce.number().positive(),
});
const limitOf = (def: number, max: number) => z.coerce.number().int().min(1).max(max).default(def);
const LimitQuery = z.object({ limit: limitOf(50, 200) });
const FilingsQuery = z.object({
  limit: limitOf(50, 200),
  ticker: z.string().min(1).max(8).optional(),
});
const HistoryQuery = z.object({
  minutes: z.coerce.number().int().min(1).max(10_080).default(1_440),
});
const TickerParams = z.object({ ticker: z.string().min(1).max(8) });
const IdParams = z.object({ id: z.string().min(1).max(64) });
const HandleParams = z.object({ handle: z.string().min(1).max(64) });
const IpoBody = z.object({ address: z.string().min(1).max(64) });
const LinkBody = z.object({
  address: z.string().min(1).max(64),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});
const AgentBody = z.object({ name: z.string().min(1).max(40) });

function parse<T>(schema: z.ZodType<T>, value: unknown, reply: FastifyReply): T | null {
  const r = schema.safeParse(value ?? {});
  if (r.success) return r.data;
  sendError(reply, 400, 'BAD_REQUEST', z.prettifyError(r.error));
  return null;
}

const statusFor = (code: ExchangeErrorCode): number =>
  code === 'UNKNOWN_TICKER' || code === 'UNKNOWN_PLAYER'
    ? 404
    : code === 'BAD_REQUEST' || code === 'INVALID_QTY'
      ? 400
      : 422;

export function registerRest(app: FastifyInstance, e: Engine, gates: Gates): void {
  const now = () => e.clock.now();
  const signups = new RateGate(20, HOUR_MS, now);

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/api/status', async () => e.status());

  app.post('/api/players', async (req, reply) => {
    if (!signups.allow(`ip:${req.ip}`))
      return sendError(reply, 429, 'RATE_LIMITED', 'too many new players from this address');
    return reply.code(201).send(e.players.create('human'));
  });

  app.post('/api/agents', async (req, reply) => {
    const body = parse(AgentBody, req.body, reply);
    if (!body) return reply;
    if (!signups.allow(`ip:${req.ip}`))
      return sendError(reply, 429, 'RATE_LIMITED', 'too many new players from this address');
    return reply.code(201).send(e.players.create('agent', body.name));
  });

  app.get('/api/me', async (req, reply) => {
    const player = requirePlayer(e, req, reply);
    if (!player) return reply;
    return {
      player,
      portfolio: e.exchange.portfolio(player.id),
      seasons: e.repos.seasonResults.forPlayer(player.id),
    };
  });

  app.get('/api/players/:handle', async (req, reply) => {
    const params = parse(HandleParams, req.params, reply);
    if (!params) return reply;
    const row = e.repos.players.byHandle(params.handle);
    if (!row) return sendError(reply, 404, 'NOT_FOUND', 'no such player');
    const { walletAddress, ...pub } = playerView(row);
    return {
      player: { ...pub, walletLinked: walletAddress !== null },
      portfolio: e.exchange.portfolio(row.id),
      seasons: e.repos.seasonResults.forPlayer(row.id),
      trades: e.repos.trades
        .forPlayer(row.id, 50)
        .map((t) => ({ ...t, ticker: e.state.get(t.companyId)?.ticker ?? '?' })),
    };
  });

  app.get('/api/companies', async () => ({
    companies: e.state
      .list()
      .map((rt) => e.state.view(rt))
      .sort((a, b) => (a.ticker < b.ticker ? -1 : 1)),
  }));

  app.get('/api/companies/:ticker', async (req, reply) => {
    const params = parse(TickerParams, req.params, reply);
    if (!params) return reply;
    const rt = e.state.byTicker(params.ticker);
    if (!rt) return sendError(reply, 404, 'UNKNOWN_TICKER', 'no such ticker');
    return {
      company: e.state.view(rt),
      filings: e.filings.recent(20, rt.id),
      holders: e.exchange.holders(rt.id),
    };
  });

  app.get('/api/companies/:ticker/history', async (req, reply) => {
    const params = parse(TickerParams, req.params, reply);
    const query = parse(HistoryQuery, req.query, reply);
    if (!params || !query) return reply;
    const rt = e.state.byTicker(params.ticker);
    if (!rt) return sendError(reply, 404, 'UNKNOWN_TICKER', 'no such ticker');
    const points = e.repos.navPoints.history(rt.id, now() - query.minutes * MINUTE_MS);
    return { ticker: rt.ticker, points: points.map(({ t, nav, price }) => ({ t, nav, price })) };
  });

  app.get('/api/filings', async (req, reply) => {
    const query = parse(FilingsQuery, req.query, reply);
    if (!query) return reply;
    let companyId: string | undefined;
    if (query.ticker) {
      const rt = e.state.byTicker(query.ticker);
      if (!rt) return sendError(reply, 404, 'UNKNOWN_TICKER', 'no such ticker');
      companyId = rt.id;
    }
    return { filings: e.filings.recent(query.limit, companyId) };
  });

  app.get('/api/quote', async (req, reply) => {
    const query = parse(QuoteQuery, req.query, reply);
    if (!query) return reply;
    const q = e.exchange.quote(query.ticker, query.side, query.qty);
    return q.ok ? q : sendError(reply, statusFor(q.code), q.code, q.message);
  });

  app.post('/api/orders', async (req, reply) => {
    const player = requirePlayer(e, req, reply);
    if (!player) return reply;
    const body = parse(OrderBody, req.body, reply);
    if (!body) return reply;
    if (!gates.orders.allow(player.id))
      return sendError(reply, 429, 'RATE_LIMITED', 'at most 10 orders per second');
    const r = e.exchange.placeOrder(player.id, body);
    return r.ok ? r : sendError(reply, statusFor(r.code), r.code, r.message);
  });

  app.get('/api/leaderboard', async (req, reply) => {
    const query = parse(LimitQuery, req.query, reply);
    if (!query) return reply;
    return { rows: e.exchange.leaderboard(query.limit) };
  });

  app.get('/api/seasons', async () => ({ seasons: e.repos.seasons.all() }));

  app.get('/api/seasons/:id', async (req, reply) => {
    const params = parse(z.object({ id: z.coerce.number().int().positive() }), req.params, reply);
    if (!params) return reply;
    const season = e.repos.seasons.get(params.id);
    if (!season) return sendError(reply, 404, 'NOT_FOUND', 'no such season');
    const results = e.repos.seasonResults.forSeason(season.id);
    const players = new Map(
      e.repos.players.many(results.map((r) => r.playerId)).map((p) => [p.id, p]),
    );
    return {
      season,
      results: results.map((r) => ({
        rank: r.rank,
        netWorth: r.netWorth,
        handle: players.get(r.playerId)?.handle ?? '?',
        kind: players.get(r.playerId)?.kind ?? 'human',
      })),
    };
  });

  app.post('/api/ipo', async (req, reply) => {
    const player = requirePlayer(e, req, reply);
    if (!player) return reply;
    const body = parse(IpoBody, req.body, reply);
    if (!body) return reply;
    const r = e.ipo.apply(player.id, body.address);
    if (!r.ok) return sendError(reply, r.code === 'RATE_LIMITED' ? 429 : 400, r.code, r.message);
    return reply.code(202).send({ app: r.app });
  });

  app.get('/api/ipo', async (req, reply) => {
    const query = parse(z.object({ limit: limitOf(20, 100) }), req.query, reply);
    if (!query) return reply;
    return { apps: e.ipo.recent(query.limit) };
  });

  app.get('/api/ipo/:id', async (req, reply) => {
    const params = parse(IdParams, req.params, reply);
    if (!params) return reply;
    const app1 = e.ipo.get(params.id);
    return app1 ? { app: app1 } : sendError(reply, 404, 'NOT_FOUND', 'no such application');
  });

  app.get('/api/provenance', async (req, reply) => {
    const query = parse(LimitQuery, req.query, reply);
    if (!query) return reply;
    return { calls: e.repos.nansenCalls.recent(query.limit) };
  });

  app.get('/api/provenance/:id', async (req, reply) => {
    const params = parse(IdParams, req.params, reply);
    if (!params) return reply;
    const call = e.repos.nansenCalls.get(params.id);
    return call ? { call } : sendError(reply, 404, 'NOT_FOUND', 'no such call');
  });

  app.get('/api/auth/nonce', async (req, reply) => {
    const player = requirePlayer(e, req, reply);
    if (!player) return reply;
    const nonce = e.players.nonce(player.id);
    return { nonce, message: 'Whale Street: link wallet <address> nonce <nonce>' };
  });

  app.post('/api/auth/link', async (req, reply) => {
    const player = requirePlayer(e, req, reply);
    if (!player) return reply;
    const body = parse(LinkBody, req.body, reply);
    if (!body) return reply;
    const r = await e.players.link(player.id, body.address, body.signature);
    return r.ok
      ? { player: r.player }
      : sendError(reply, r.code === 'INVALID_ADDRESS' ? 400 : 401, r.code, r.message);
  });
}
