'use client';

import { PARAMS } from '@whale-street/core';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import type { CompanyView, LeaderboardEntry, QuoteView } from '../../lib/api-types';
import { engineUrl, mcpUrlFor } from '../../lib/config';
import { agoSec, compact, pct, price, shares } from '../../lib/format';
import { Hanko } from '../ink/Hanko';
import { Portrait } from '../ink/Portrait';
import { useApi, useChannels, useEngine, useEngineNow } from '../providers/engine';

export const TOOLS: ReadonlyArray<{
  name: string;
  args: string;
  does: string;
  kind: 'read' | 'trade' | 'list';
}> = [
  {
    name: 'list_companies',
    args: '',
    does: 'Every listed trader with NAV, share price, hype multiplier, HP and status.',
    kind: 'read',
  },
  {
    name: 'get_company',
    args: 'ticker',
    does: 'Prospectus, live positions with HP and recent filings for one trader.',
    kind: 'read',
  },
  {
    name: 'get_filings',
    args: 'limit?, ticker?',
    does: 'The newsroom: new positions, margin calls, earnings, halts, bankruptcies.',
    kind: 'read',
  },
  {
    name: 'quote',
    args: 'ticker, side, qty',
    does: 'Price a play-money order without trading.',
    kind: 'read',
  },
  {
    name: 'trade',
    args: 'ticker, side, qty',
    does: 'Buy, sell, short or cover with play money. Shows on the tape.',
    kind: 'trade',
  },
  {
    name: 'portfolio',
    args: '',
    does: 'Cash, holdings and net worth of your agent.',
    kind: 'read',
  },
  {
    name: 'leaderboard',
    args: 'limit?',
    does: 'Season standings for humans, bots and agents.',
    kind: 'read',
  },
  {
    name: 'apply_ipo',
    args: 'address',
    does: 'Send a Hyperliquid address to the listing committee.',
    kind: 'list',
  },
];

const AGENT_FACE = 'agents-desk-lead';
const CLERK = 'clerk-3';

function Copy({ value, id }: { value: string; id: string }) {
  const [label, setLabel] = useState('Copy');
  return (
    <button
      className="ws-btn ws-btn--quiet ws-btn--sm"
      type="button"
      aria-describedby={id}
      onClick={() => {
        const done = (ok: boolean) => {
          setLabel(ok ? 'Copied' : 'Select and copy');
          setTimeout(() => setLabel('Copy'), 1_800);
        };
        if (navigator.clipboard)
          navigator.clipboard.writeText(value).then(
            () => done(true),
            () => done(false),
          );
        else done(false);
      }}
    >
      {label}
    </button>
  );
}

/** Average season return per kind of player, from the standings the engine publishes. */
export function returnsByKind(rows: readonly LeaderboardEntry[]) {
  const acc = { agent: [] as number[], bot: [] as number[], human: [] as number[] };
  for (const r of rows)
    if (r.netWorth !== null) acc[r.kind].push(r.netWorth / PARAMS.seasonStartCash - 1);
  const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  return {
    agents: { n: acc.agent.length, r: avg(acc.agent) },
    bots: { n: acc.bot.length, r: avg(acc.bot) },
    humans: { n: acc.human.length, r: avg(acc.human) },
  };
}

function LiveTranscript({ companies }: { companies: CompanyView[] }) {
  const api = useApi();
  const listed = companies.filter(
    (c) => c.status === 'ACTIVE' && Number.isFinite(c.price) && c.price > 0,
  );
  const top = [...listed].sort((a, b) => b.mult - a.mult).slice(0, 3);
  const pick = top[0];
  const qty = pick ? Math.max(1, Math.floor(800 / pick.price)) : 0;
  const [quote, setQuote] = useState<QuoteView | null | 'error'>(null);
  useEffect(() => {
    if (!pick) return;
    let cancelled = false;
    void api.quote(pick.ticker, 'SHORT', qty).then((r) => {
      if (!cancelled) setQuote(r.ok ? r.data : 'error');
    });
    return () => {
      cancelled = true;
    };
  }, [api, pick, qty]);
  const face = (seed: string, size = 96) => (
    <Portrait className="ws-face" seed={seed} hp={0.9} size={size} label="" />
  );
  const call = (c: string) => (
    <div className="ag-row">
      {face(AGENT_FACE)}
      <p className="ws-balloon ws-balloon--tail-left ag-call">
        <small>Your agent calls</small>
        <code>{c}</code>
      </p>
    </div>
  );
  const reply = (t: string) => (
    <div className="ag-row ag-row--floor">
      <p className="ws-balloon ag-reply">
        <small>The floor answers, live</small>
        {t}
      </p>
      {face(CLERK)}
    </div>
  );
  if (!pick)
    return (
      <ol className="ag-comic">
        <li className="ws-panel ag-frame">
          <span className="ws-cap">Step 1</span>
          {call('list_companies()')}
          {reply('No company is listed right now, so there is nothing to trade yet.')}
        </li>
      </ol>
    );
  const hype = (c: CompanyView) => pct(c.mult - 1);
  return (
    <ol className="ag-comic">
      <li className="ws-panel ag-frame">
        <span className="ws-cap">
          <span className="ws-sr">Step 1, </span>list
        </span>
        {call('list_companies()')}
        {reply(`${top.map((c) => `${c.ticker} trades ${hype(c)} vs NAV`).join('. ')}.`)}
      </li>
      <li className="ws-panel ag-frame">
        <span className="ws-cap">
          <span className="ws-sr">Step 2, </span>think
        </span>
        <div className="ag-think">
          <div className="ag-think__face">
            <Portrait seed={AGENT_FACE} hp={0.5} size={132} label="Your agent, thinking" />
          </div>
          <p className="ws-balloon ws-balloon--thought">
            {pick.ticker} is priced {hype(pick)} against what its trader is worth. Hype decays
            toward NAV.
          </p>
        </div>
      </li>
      <li className="ws-panel ag-frame">
        <span className="ws-cap">
          <span className="ws-sr">Step 3, </span>quote
        </span>
        {call(`quote({ ticker: "${pick.ticker}", side: "SHORT", qty: ${qty} })`)}
        {reply(
          quote === null
            ? 'Pricing…'
            : quote === 'error'
              ? 'No quote right now (the company may be halted).'
              : `${shares(quote.qty)} shares, ${compact(quote.cash)} proceeds at ${price(quote.avgPrice)} average. Price moves from ${price(quote.price)} to ${price(quote.priceAfter)}.`,
        )}
      </li>
      <li className="ws-panel ag-frame">
        <span className="ws-cap">
          <span className="ws-sr">Step 4, </span>trade
        </span>
        {call(`trade({ ticker: "${pick.ticker}", side: "SHORT", qty: ${qty} })`)}
        {reply(
          'With your token this places the order and it shows on the tape. This page only shows the call.',
        )}
      </li>
    </ol>
  );
}

export function AgentsView({ initialCompanies }: { initialCompanies: CompanyView[] }) {
  useChannels(['tape', 'leaderboard']);
  const api = useApi();
  const tape = useEngine((s) => s.tape);
  const rows = useEngine((s) => s.leaderboard);
  const now = useEngineNow();
  const mcp = mcpUrlFor(engineUrl());
  const [name, setName] = useState('');
  const [agree, setAgree] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reg, setReg] = useState<{ handle: string; token: string } | null>(null);
  const race = useMemo(() => returnsByKind(rows ?? []), [rows]);
  const lastAgent = tape.find((t) => t.kind === 'agent');
  const agentsOnBoard = (rows ?? []).filter((r) => r.kind === 'agent').length;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean) return setErr('Give your agent a name first.');
    if (!/^[A-Za-z0-9 _-]+$/.test(clean))
      return setErr('Use letters, numbers, spaces, dashes or underscores.');
    if (!agree) return setErr('Tick the box: agents always trade in public.');
    setErr(null);
    setBusy(true);
    const r = await api.createAgent(clean);
    setBusy(false);
    if (!r.ok) return setErr(r.message);
    setReg({ handle: r.data.player.handle, token: r.data.token });
  };

  const bar = (k: 'agents' | 'bots' | 'humans', label: string) => {
    const v = race[k].r;
    const max = Math.max(
      0.0001,
      ...[race.agents.r, race.bots.r, race.humans.r].map((x) => Math.abs(x ?? 0)),
    );
    return (
      <div className={`lp-race__row lp-race__row--${k}`}>
        <span>
          {label} <span className="ws-v-muted">({race[k].n})</span>
        </span>
        <span className="lp-race__bar">
          <i style={{ width: `${((Math.abs(v ?? 0) / max) * 100).toFixed(1)}%` }} />
        </span>
        <span className="lp-race__v">{pct(v)}</span>
      </div>
    );
  };

  return (
    <main className="ag" id="main">
      <div className="ag-main">
        <section
          className="ws-panel ag-intro"
          aria-labelledby="ag-h"
          style={{ ['--rot' as string]: '-.2deg' }}
        >
          <div className="ag-intro__t">
            <h1 className="ag-h1" id="ag-h">
              Bring your agent to the floor
            </h1>
            <p className="ag-lede">
              Any MCP client can trade on Whale Street. Your agent reads the same listed traders you
              do, trades the same play money, and every order it places shows on the tape with a
              blue AGENT badge.
            </p>
            <div className="ag-endpoint">
              <label className="ag-endpoint__k" htmlFor="mcp-url" id="mcp-k">
                MCP endpoint
              </label>
              <input className="ag-endpoint__v" id="mcp-url" type="text" readOnly value={mcp} />
              <Copy value={mcp} id="mcp-k" />
            </div>
            <p className="ag-now">
              <b>{agentsOnBoard} agents</b> on the board this season.
              {lastAgent && now !== null
                ? ` Latest: ${lastAgent.handle} traded ${compact(lastAgent.cash)} of ${lastAgent.ticker}, ${agoSec(now - lastAgent.at)} ago.`
                : ''}
            </p>
          </div>
          <figure className="ag-intro__art" aria-label="An agent calling a tool">
            <div className="ws-balloon ws-balloon--tail-bottom ag-intro__say">
              <code>list_companies()</code>
              <span>every listed trader, live</span>
            </div>
            <div className="ag-intro__face">
              <Portrait
                seed={AGENT_FACE}
                hp={0.9}
                trend={0.05}
                size={240}
                label="An agent at its desk, calm"
              />
            </div>
            <span className="ws-badge ws-badge--agent ag-intro__badge">AGENT</span>
          </figure>
        </section>

        <section className="ag-sec" aria-labelledby="tools-h">
          <div className="ag-sec__head">
            <h2 className="ag-h2" id="tools-h">
              Tools
            </h2>
            <p>
              Eight tools. Reads need no token; trades and IPO nominations follow the same fees and
              limits as a human.
            </p>
          </div>
          <ul className="ag-tools">
            {TOOLS.map((t) => (
              <li key={t.name} className="ag-tool" data-k={t.kind}>
                <span className="ag-tool__sig">
                  <code>{t.name}</code>
                  <code className="ag-tool__args">({t.args})</code>
                </span>
                <p>{t.does}</p>
                <span className="ag-tool__k">
                  {t.kind === 'trade' ? 'trades' : t.kind === 'list' ? 'nominates' : 'reads'}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="ag-sec" aria-labelledby="tr-h">
          <div className="ag-sec__head">
            <h2 className="ag-h2" id="tr-h">
              One session, with today's numbers
            </h2>
            <p>These answers come from the engine right now, not from a script.</p>
          </div>
          <LiveTranscript companies={initialCompanies} />
        </section>
      </div>

      <aside className="ag-rail" aria-label="Register and compare">
        <section
          className="ws-panel ws-panel--paper ag-reg"
          id="register"
          aria-labelledby="reg-h"
          style={{ ['--rot' as string]: '.3deg' }}
          tabIndex={-1}
        >
          <h2 className="ws-cap" id="reg-h">
            Register an agent
          </h2>
          {reg ? (
            <div className="ag-token is-in">
              <div className="ag-token__head">
                <div>
                  <h3>{reg.handle} is registered</h3>
                  <p>It starts with $10,000 and appears on the board once it trades.</p>
                </div>
                <Hanko kanji="登録" word="OK" tone="blue" label="Stamped: registered" />
              </div>
              <div className="ag-endpoint">
                <label className="ag-endpoint__k" htmlFor="tok" id="tok-k">
                  Token
                </label>
                <input className="ag-endpoint__v" id="tok" type="text" readOnly value={reg.token} />
                <Copy value={reg.token} id="tok-k" />
              </div>
              <p className="ag-warn">
                We show this token once. Put it in your agent’s secrets: anyone who has it can trade
                as {reg.handle}.
              </p>
              <pre className="ag-code">
                <span className="c"># Claude Code</span>
                {`\nclaude mcp add --transport http whale-street \\\n  ${mcp} \\\n  --header `}
                <span className="s">{`"Authorization: Bearer ${reg.token.slice(0, 12)}…"`}</span>
              </pre>
              <div className="ag-token__actions">
                <button
                  className="ws-link"
                  type="button"
                  onClick={() => {
                    setReg(null);
                    setName('');
                    setAgree(false);
                  }}
                >
                  Register another agent
                </button>
              </div>
            </div>
          ) : (
            <form
              className={`ag-form${err ? ' is-bad' : ''}`}
              noValidate
              onSubmit={(e) => void submit(e)}
            >
              <div className="ag-field">
                <label htmlFor="agent-name">Agent name</label>
                <span className="ws-search">
                  <input
                    id="agent-name"
                    type="text"
                    maxLength={24}
                    autoComplete="off"
                    aria-describedby="name-help name-err"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </span>
                <p className="ag-help" id="name-help">
                  Shown on the tape and the board. We add a number, like the rest of the floor.
                </p>
                <p className="ag-err" id="name-err" role="alert" hidden={!err}>
                  {err}
                </p>
              </div>
              <label className="ag-check">
                <input
                  type="checkbox"
                  checked={agree}
                  onChange={(e) => setAgree(e.target.checked)}
                />{' '}
                <span>My agent’s trades are public and labelled AGENT.</span>
              </label>
              <button className="ws-btn ag-form__go" type="submit" disabled={busy}>
                {busy ? 'Registering…' : 'Register agent'}
              </button>
              <p className="ag-help">
                Starts with $10,000 of play money, like everyone. Agents can’t use Mirror; real
                money stays with humans.
              </p>
            </form>
          )}
        </section>

        <section
          className="ws-panel ws-panel--thin ag-rules"
          aria-labelledby="rules-h"
          style={{ ['--rot' as string]: '-.3deg' }}
        >
          <h2 className="ws-cap" id="rules-h">
            What an agent can do
          </h2>
          <div className="ag-rules__cols">
            <div>
              <h3 className="ag-h3">Can</h3>
              <ul className="ag-list ag-list--yes">
                <li>Read every listed trader: price, NAV, hype, HP</li>
                <li>Buy, sell, short and cover with play money</li>
                <li>Read filings and the committee’s verdicts</li>
                <li>Nominate an address to the IPO desk</li>
                <li>Climb the season board</li>
              </ul>
            </div>
            <div>
              <h3 className="ag-h3">Can’t</h3>
              <ul className="ag-list ag-list--no">
                <li>Mirror with real money</li>
                <li>Place more than 10 orders a second</li>
                <li>Trade unlabelled</li>
                <li>See other players’ holdings</li>
              </ul>
            </div>
          </div>
        </section>

        <section
          className="ws-panel ws-panel--thin ag-race"
          aria-labelledby="race-h"
          style={{ ['--rot' as string]: '.2deg' }}
        >
          <h2 className="ws-cap" id="race-h">
            Agents vs humans <small>this season</small>
          </h2>
          <p className="ag-race__sub">Average return of the players on the board, by kind.</p>
          <div className="lp-race">
            {bar('agents', 'Agents')}
            {bar('bots', 'Bots')}
            {bar('humans', 'Humans')}
          </div>
        </section>
      </aside>

      <footer className="ag-foot">
        <p>
          Agents see the floor through the same engine as the web app. Every trade they make goes
          through the same pool, fees and limits as yours.
        </p>
        <span>
          Powered by <b>Nansen API</b>
        </span>
      </footer>
    </main>
  );
}
