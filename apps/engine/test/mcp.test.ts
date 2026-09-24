import { afterEach, describe, expect, it } from 'vitest';
import { IDLE_AFTER_MS } from '../src/ingest/idle';
import { bearer, type TestEngine, testEngine } from './helpers/engine';
import { addCompany } from './helpers/world';

let t: TestEngine;

afterEach(async () => {
  await t.app.close();
});

type RpcMessage = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

/** POSTs one JSON-RPC message to /mcp and returns the JSON-RPC messages from the (SSE or JSON) reply. */
async function rpc(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const r = await t.app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
      ...headers,
    },
    payload: { jsonrpc: '2.0', ...body },
  });
  const text = r.body;
  const messages: RpcMessage[] = String(r.headers['content-type'] ?? '').includes(
    'text/event-stream',
  )
    ? text
        .split('\n')
        .filter((l) => l.startsWith('data: ') && l.length > 6)
        .map((l) => JSON.parse(l.slice(6)) as RpcMessage)
    : text.length > 0
      ? [JSON.parse(text) as RpcMessage]
      : [];
  return { status: r.statusCode, messages, first: messages[0] };
}

const call = (
  name: string,
  args: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) => rpc({ id: 3, method: 'tools/call', params: { name, arguments: args } }, headers);

const toolText = (m: RpcMessage | undefined) => {
  const content = (m?.result?.content ?? []) as Array<{ type: string; text: string }>;
  return { isError: m?.result?.isError === true, text: content[0]?.text ?? '' };
};

describe('MCP /mcp', () => {
  it('initializes and lists the eight tools', async () => {
    t = await testEngine();
    const init = await rpc({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });
    expect(init.status).toBe(200);
    expect(init.first?.result?.serverInfo).toMatchObject({ name: 'whale-street' });
    const list = await rpc({ id: 2, method: 'tools/list' });
    const names = ((list.first?.result?.tools ?? []) as Array<{ name: string }>)
      .map((x) => x.name)
      .sort();
    expect(names).toEqual([
      'apply_ipo',
      'get_company',
      'get_filings',
      'leaderboard',
      'list_companies',
      'portfolio',
      'quote',
      'trade',
    ]);
  });

  it('public tools work without a token; trading tools need one', async () => {
    t = await testEngine();
    addCompany(t.engine, { id: '0x00000000000000000000000000000000000000a1', ticker: 'AAA' });
    t.clock.advance(61_000);
    const companies = toolText((await call('list_companies')).first);
    expect(JSON.parse(companies.text)[0]).toMatchObject({ ticker: 'AAA', nav: 100 });
    const quote = toolText((await call('quote', { ticker: 'AAA', side: 'BUY', qty: 5 })).first);
    expect(JSON.parse(quote.text)).toMatchObject({ ok: true, qty: 5 });
    const denied = toolText((await call('trade', { ticker: 'AAA', side: 'BUY', qty: 5 })).first);
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('Bearer');

    const agent = (
      await t.app.inject({ method: 'POST', url: '/api/agents', payload: { name: 'Quant Desk' } })
    ).json();
    const trade = toolText(
      (await call('trade', { ticker: 'AAA', side: 'BUY', qty: 5 }, bearer(agent.token))).first,
    );
    expect(JSON.parse(trade.text)).toMatchObject({ ok: true, fill: { ticker: 'AAA', qty: 5 } });
    const pf = toolText((await call('portfolio', {}, bearer(agent.token))).first);
    expect(JSON.parse(pf.text).holdings[0]).toMatchObject({ ticker: 'AAA', longQty: 5 });
    const lb = toolText((await call('leaderboard', { limit: 5 })).first);
    expect(JSON.parse(lb.text)[0]).toMatchObject({ kind: 'agent' });
    const bad = toolText((await call('get_company', { ticker: 'ZZZ' })).first);
    expect(bad).toEqual({ isError: true, text: 'unknown ticker ZZZ' });
    const ipo = toolText(
      (
        await call(
          'apply_ipo',
          { address: '0x00000000000000000000000000000000000000b2' },
          bearer(agent.token),
        )
      ).first,
    );
    expect(JSON.parse(ipo.text)).toMatchObject({ status: 'PENDING' });
    await t.engine.settle();
  });

  it('rate-limits MCP trades per player (10/second)', async () => {
    t = await testEngine();
    addCompany(t.engine, { id: '0x00000000000000000000000000000000000000a1', ticker: 'AAA' });
    t.clock.advance(61_000);
    const agent = (
      await t.app.inject({ method: 'POST', url: '/api/agents', payload: { name: 'Quant Desk' } })
    ).json();
    const results: Array<{ isError: boolean; text: string }> = [];
    for (let i = 0; i < 11; i++) {
      results.push(
        toolText(
          (await call('trade', { ticker: 'AAA', side: 'BUY', qty: 0.1 }, bearer(agent.token)))
            .first,
        ),
      );
    }
    expect(results.filter((r) => !r.isError)).toHaveLength(10);
    expect(results.at(-1)).toMatchObject({
      isError: true,
      text: 'RATE_LIMITED: at most 10 orders per second',
    });
  });

  it('shares the order rate limit between REST and MCP', async () => {
    t = await testEngine();
    addCompany(t.engine, { id: '0x00000000000000000000000000000000000000a1', ticker: 'AAA' });
    t.clock.advance(61_000);
    const agent = (
      await t.app.inject({ method: 'POST', url: '/api/agents', payload: { name: 'Quant Desk' } })
    ).json();
    for (let i = 0; i < 10; i++) {
      const r = await t.app.inject({
        method: 'POST',
        url: '/api/orders',
        headers: bearer(agent.token),
        payload: { ticker: 'AAA', side: 'BUY', qty: 0.1 },
      });
      expect(r.statusCode).toBe(200);
    }
    const mcpTrade = toolText(
      (await call('trade', { ticker: 'AAA', side: 'BUY', qty: 0.1 }, bearer(agent.token))).first,
    );
    expect(mcpTrade).toMatchObject({
      isError: true,
      text: 'RATE_LIMITED: at most 10 orders per second',
    });
  });

  it('trade while IDLE: MARKET_PAUSED, the engine wakes, and the retry fills once NAV is live', async () => {
    t = await testEngine();
    addCompany(t.engine, { id: '0x00000000000000000000000000000000000000a1', ticker: 'AAA' });
    t.clock.advance(61_000);
    const agent = (
      await t.app.inject({ method: 'POST', url: '/api/agents', payload: { name: 'Quant Desk' } })
    ).json();
    const liveTick = () => {
      t.engine.state.setMarks({}, t.clock.now());
      t.engine.tick();
    };
    t.clock.advance(IDLE_AFTER_MS);
    liveTick();
    expect(t.engine.status().idle).toBe(true);
    const trade = async () =>
      toolText(
        (await call('trade', { ticker: 'AAA', side: 'BUY', qty: 1 }, bearer(agent.token))).first,
      );
    expect(await trade()).toMatchObject({
      isError: true,
      text: expect.stringMatching(/^MARKET_PAUSED: /),
    });
    expect(t.engine.status().idle).toBe(false);
    const quote = toolText((await call('quote', { ticker: 'AAA', side: 'BUY', qty: 1 })).first);
    expect(JSON.parse(quote.text)).toMatchObject({ ok: true, paused: true });
    t.clock.advance(1_000);
    liveTick();
    const filled = await trade();
    expect(filled.isError).toBe(false);
    expect(JSON.parse(filled.text)).toMatchObject({ ok: true, fill: { ticker: 'AAA', qty: 1 } });
  });

  it('refuses a garbage bearer token on trade without placing an order', async () => {
    t = await testEngine();
    addCompany(t.engine, { id: '0x00000000000000000000000000000000000000a1', ticker: 'AAA' });
    t.clock.advance(61_000);
    const denied = toolText(
      (
        await call(
          'trade',
          { ticker: 'AAA', side: 'BUY', qty: 5 },
          bearer('garbage-token-that-is-definitely-not-real'),
        )
      ).first,
    );
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('Bearer');
    expect(t.engine.repos.trades.recent(10)).toEqual([]);
  });

  it('apply_ipo shares the desk rules: dedup, listed refusal and the per-IP cap', async () => {
    t = await testEngine();
    addCompany(t.engine, { id: '0x00000000000000000000000000000000000000a1', ticker: 'AAA' });
    const agents: Array<{ token: string }> = [];
    for (let i = 0; i < 3; i++)
      agents.push(
        (
          await t.app.inject({ method: 'POST', url: '/api/agents', payload: { name: `Desk ${i}` } })
        ).json() as { token: string },
      );
    const apply = async (i: number, address: string) =>
      toolText((await call('apply_ipo', { address }, bearer(agents[i]?.token ?? ''))).first);
    expect(await apply(0, '0x00000000000000000000000000000000000000a1')).toMatchObject({
      isError: true,
      text: expect.stringContaining('ALREADY_LISTED'),
    });
    const addr = (n: number) => `0x${(0xe00 + n).toString(16).padStart(40, '0')}`;
    const first = JSON.parse((await apply(0, addr(0))).text);
    expect(JSON.parse((await apply(1, addr(0))).text)).toMatchObject({ id: first.id });
    for (let n = 1; n < 6; n++) expect((await apply(n < 3 ? 0 : 1, addr(n))).isError).toBe(false);
    expect(await apply(2, addr(6))).toMatchObject({
      isError: true,
      text: expect.stringContaining('IPO_DESK_BUSY'),
    });
    await t.engine.settle();
  });

  it('rejects foreign Host and Origin headers (DNS-rebinding guard)', async () => {
    t = await testEngine();
    expect((await rpc({ id: 2, method: 'tools/list' }, { host: 'evil.example' })).status).toBe(403);
    expect(
      (await rpc({ id: 2, method: 'tools/list' }, { origin: 'https://evil.example' })).status,
    ).toBe(403);
    expect(
      (await rpc({ id: 2, method: 'tools/list' }, { origin: 'http://localhost:3000' })).status,
    ).toBe(200);
  });
});
