import { afterEach, describe, expect, it } from 'vitest';
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
