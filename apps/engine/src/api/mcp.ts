import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  type CallToolResult,
  createMcpHandler,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  McpServer,
  validateHostHeader,
  validateOriginHeader,
} from '@modelcontextprotocol/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Engine } from '../engine';
import type { PlayerView } from '../services/players';
import { bearerToken, sendError } from './auth';
import type { Gates } from './rate';

const SIDE = z.enum(['BUY', 'SELL', 'SHORT', 'COVER']);
const TICKER = z.string().min(1).max(8).describe('Company ticker, e.g. "OOH"');

const json = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
});
const fail = (message: string): CallToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});
const NEEDS_TOKEN =
  'this tool needs `Authorization: Bearer <token>` (POST /api/agents {name} returns one)';

/** Hostnames of the configured CORS origins (e.g. https://whalestreet.app → whalestreet.app). */
const hostsOf = (origins: readonly string[]): string[] =>
  origins.flatMap((o) => {
    try {
      return [new URL(o).hostname];
    } catch {
      return [];
    }
  });

/** One MCP server per request (stateless); tools act for the bearer-token player, if any. */
export function buildMcpServer(e: Engine, player: PlayerView | null, gates: Gates): McpServer {
  const s = new McpServer({ name: 'whale-street', version: '0.1.0' });

  s.registerTool(
    'list_companies',
    {
      description:
        'All listed companies (real Hyperliquid traders) with NAV, share price, hype multiplier, HP and status.',
      inputSchema: z.object({}),
    },
    async () =>
      json(
        e.state.list().map((rt) => {
          const v = e.state.view(rt);
          return {
            ticker: v.ticker,
            name: v.name,
            status: v.status,
            rating: v.rating,
            nav: v.nav,
            price: v.price,
            mult: v.mult,
            hp: v.hp,
          };
        }),
      ),
  );

  s.registerTool(
    'get_company',
    {
      description: 'One company: prospectus, live positions with HP, recent filings.',
      inputSchema: z.object({ ticker: TICKER }),
    },
    async ({ ticker }) => {
      const rt = e.state.byTicker(ticker);
      if (!rt) return fail(`unknown ticker ${ticker}`);
      return json({ company: e.state.view(rt), filings: e.filings.recent(10, rt.id) });
    },
  );

  s.registerTool(
    'get_filings',
    {
      description:
        'Recent filings (position changes, earnings, halts, bankruptcies), newest first.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional(),
        ticker: TICKER.optional(),
      }),
    },
    async ({ limit, ticker }) => {
      const rt = ticker ? e.state.byTicker(ticker) : undefined;
      if (ticker && !rt) return fail(`unknown ticker ${ticker}`);
      return json(e.filings.recent(limit ?? 20, rt?.id));
    },
  );

  s.registerTool(
    'quote',
    {
      description: 'Price a hypothetical order without trading.',
      inputSchema: z.object({ ticker: TICKER, side: SIDE, qty: z.number().positive() }),
    },
    async ({ ticker, side, qty }) => {
      const q = e.exchange.quote(ticker, side, qty);
      return q.ok ? json(q) : fail(`${q.code}: ${q.message}`);
    },
  );

  s.registerTool(
    'trade',
    {
      description:
        'Place a play-money order (BUY, SELL, SHORT, COVER) for the authenticated player.',
      inputSchema: z.object({ ticker: TICKER, side: SIDE, qty: z.number().positive() }),
    },
    async ({ ticker, side, qty }) => {
      if (!player) return fail(NEEDS_TOKEN);
      if (!gates.orders.allow(player.id)) return fail('RATE_LIMITED: at most 10 orders per second');
      const r = e.exchange.placeOrder(player.id, { ticker, side, qty });
      return r.ok ? json(r) : fail(`${r.code}: ${r.message}`);
    },
  );

  s.registerTool(
    'portfolio',
    {
      description: 'Cash, holdings and net worth of the authenticated player.',
      inputSchema: z.object({}),
    },
    async () => (player ? json(e.exchange.portfolio(player.id)) : fail(NEEDS_TOKEN)),
  );

  s.registerTool(
    'leaderboard',
    {
      description: 'Season leaderboard by net worth (humans, agents and BOT funds).',
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    },
    async ({ limit }) => json(e.exchange.leaderboard(limit ?? 20)),
  );

  s.registerTool(
    'apply_ipo',
    {
      description:
        'Propose a Hyperliquid address for listing; the deterministic committee rules on Nansen evidence.',
      inputSchema: z.object({ address: z.string().min(1).max(64) }),
    },
    async ({ address }) => {
      if (!player) return fail(NEEDS_TOKEN);
      const r = e.ipo.apply(player.id, address);
      return r.ok ? json(r.app) : fail(`${r.code}: ${r.message}`);
    },
  );

  return s;
}

/** Stateless MCP (Streamable HTTP) at /mcp with Host/Origin validation (the SDK handler validates nothing). */
export function registerMcp(app: FastifyInstance, e: Engine, gates: Gates): void {
  const handler = createMcpHandler(
    (ctx) =>
      buildMcpServer(
        e,
        e.players.auth(bearerToken(ctx.requestInfo?.headers.get('authorization'))),
        gates,
      ),
    { onerror: (err) => e.log.warn('mcp request failed', { error: err.message }) },
  );
  const node = toNodeHandler(handler, {
    onerror: (err) => e.log.error('mcp adapter failed', { error: err.message }),
  });
  const hosts = [...localhostAllowedHostnames(), ...e.config.publicHosts];
  const origins = [
    ...localhostAllowedOrigins(),
    ...e.config.publicHosts,
    ...hostsOf(e.config.corsOrigins),
  ];

  app.all('/mcp', async (req, reply) => {
    const host = validateHostHeader(req.headers.host, hosts);
    if (!host.ok) return sendError(reply, 403, 'FORBIDDEN_HOST', host.message);
    const origin = validateOriginHeader(req.headers.origin, origins);
    if (!origin.ok) return sendError(reply, 403, 'FORBIDDEN_ORIGIN', origin.message);
    reply.hijack();
    await node(req.raw, reply.raw, req.body);
  });

  app.addHook('onClose', async () => {
    await handler.close();
  });
}
