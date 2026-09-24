'use client';

import { PARAMS } from '@whale-street/core';
import Link from 'next/link';
import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import type {
  LeaderboardEntry,
  PlayerKind,
  SeasonResultView,
  SeasonRow,
} from '../../lib/api-types';
import { countdown, dayLabel, pct, upDown, usd } from '../../lib/format';
import { useReducedMotion } from '../ink/motion';
import { Portrait } from '../ink/Portrait';
import { useChannels, useEngine, useEngineNow, useEngineRuntime } from '../providers/engine';
import { usePlayer } from '../providers/player';

interface Row {
  rank: number | null;
  handle: string;
  kind: PlayerKind;
  netWorth: number | null;
  you: boolean;
}

const ret = (nw: number | null) => (nw === null ? null : nw / PARAMS.seasonStartCash - 1);

function Badges({ kind, you }: { kind: PlayerKind; you?: boolean }) {
  return (
    <>
      {you ? <span className="ws-badge ws-badge--you">YOU</span> : null}
      {kind === 'agent' ? <span className="ws-badge ws-badge--agent">AGENT</span> : null}
      {kind === 'bot' ? <span className="ws-badge ws-badge--bot">BOT</span> : null}
    </>
  );
}

function Trophy({ fill, place }: { fill: string; place: number }) {
  const INK = '#1a1714';
  const PAPER = '#f3eee2';
  return (
    <svg className="bd-trophy" viewBox="0 0 100 92" aria-hidden="true">
      <path
        d="M27 20 C9 20 9 48 31 50 M73 20 C91 20 91 48 69 50"
        fill="none"
        stroke={INK}
        strokeWidth="5"
        strokeLinecap="round"
      />
      <path
        d="M24 10 H76 V30 C76 50 64 60 50 60 C36 60 24 50 24 30 Z"
        fill={fill}
        transform="translate(1.6 1.2)"
      />
      <path
        d="M24 10 H76 V30 C76 50 64 60 50 60 C36 60 24 50 24 30 Z"
        fill="none"
        stroke={INK}
        strokeWidth="3.5"
        strokeLinejoin="round"
      />
      <path d="M33 17 V33" stroke={PAPER} strokeWidth="4" strokeLinecap="round" opacity=".85" />
      <text
        x="50"
        y="42"
        textAnchor="middle"
        fontFamily="'Dela Gothic One',sans-serif"
        fontSize="20"
        fill={place === 2 ? PAPER : INK}
      >
        {place}
      </text>
      <path d="M44 60 H56 V71 H44 Z" fill={fill} stroke={INK} strokeWidth="3" />
      <path d="M29 71 H71 V84 H29 Z" fill={INK} />
      <path d="M36 76 H64" stroke={PAPER} strokeWidth="2" />
      <ellipse cx="13" cy="40" rx="9" ry="11" fill={PAPER} stroke={INK} strokeWidth="3" />
      <ellipse cx="87" cy="40" rx="9" ry="11" fill={PAPER} stroke={INK} strokeWidth="3" />
    </svg>
  );
}

function Confetti() {
  let seed = 11;
  const r = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const bits = Array.from({ length: 26 }, (_, i) => {
    const x = 8 + r() * 84;
    const y = 4 + r() * 40;
    return {
      key: i,
      x: `${x.toFixed(1)}%`,
      y: `${y.toFixed(1)}%`,
      w: (6 + r() * 6).toFixed(0),
      h: (3 + r() * 3).toFixed(0),
      rot: (r() * 80 - 40).toFixed(0),
      fill: i % 2 ? '#ff48b0' : '#0078bf',
    };
  });
  return (
    <svg className="bd-confetti" aria-hidden="true">
      {bits.map((b) => (
        <rect
          key={b.key}
          x={b.x}
          y={b.y}
          width={b.w}
          height={b.h}
          fill={b.fill}
          transform={`rotate(${b.rot})`}
          style={{ transformOrigin: `${b.x} ${b.y}` }}
          opacity=".85"
        />
      ))}
    </svg>
  );
}

export function BoardView({
  seasons,
  initialRows,
}: {
  seasons: SeasonRow[];
  initialRows: LeaderboardEntry[];
}) {
  useChannels(['leaderboard']);
  const { api } = useEngineRuntime();
  const liveRows = useEngine((s) => s.leaderboard);
  const now = useEngineNow(30_000);
  const reduce = useReducedMotion();
  const { player, portfolio } = usePlayer();
  const current = seasons.find((s) => s.status === 'ACTIVE') ?? seasons[0] ?? null;
  const [seasonId, setSeasonId] = useState<number | null>(current?.id ?? null);
  const [closed, setClosed] = useState<SeasonResultView[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'human' | 'machine'>('all');
  const [rising, setRising] = useState(true);
  const season = seasons.find((s) => s.id === seasonId) ?? current;
  // Without a season list (the request failed) the standings shown are the live ones.
  const live = season ? season.status === 'ACTIVE' : true;

  useEffect(() => {
    if (!season || live) {
      setClosed(null);
      return;
    }
    let cancelled = false;
    void api.season(season.id).then((r) => {
      if (!cancelled) setClosed(r.ok ? r.data.results : []);
    });
    return () => {
      cancelled = true;
    };
  }, [api, season, live]);

  const rows: Row[] = useMemo(() => {
    if (!live) return (closed ?? []).map((r) => ({ ...r, you: r.handle === player?.handle }));
    return (liveRows ?? initialRows).map((r) => ({
      rank: r.rank,
      handle: r.handle,
      kind: r.kind,
      netWorth: r.netWorth,
      you: r.playerId === player?.id,
    }));
  }, [live, closed, liveRows, initialRows, player]);

  const me = rows.find((r) => r.you) ?? null;
  const top = rows.slice(0, 3);
  const ahead = me?.rank ? rows.find((r) => r.rank === (me.rank as number) - 1) : null;
  const keep = (r: Row) =>
    r.you || filter === 'all' || (filter === 'human' ? r.kind === 'human' : r.kind !== 'human');
  // "Everyone" lists the rows under the podium; the filtered views list every matching row.
  const list = rows.filter(keep).filter((r) => filter !== 'all' || !top.includes(r));
  const maxRet = Math.max(0.0001, ...rows.map((r) => ret(r.netWorth) ?? 0));
  const machines = top.filter((r) => r.kind !== 'human').length;
  const podiumNote =
    machines === 0
      ? `no machines in the top ${top.length}`
      : machines === 1
        ? `1 of the top ${top.length} is a machine`
        : `${machines} of the top ${top.length} are machines`;

  const pickSeason = (id: number) => {
    setSeasonId(id);
    if (!reduce) {
      setRising(false);
      requestAnimationFrame(() => setRising(true));
    }
  };

  return (
    <main className="bd" id="main">
      <div className="bd-head">
        <div>
          <h1 className="bd-h1">{season ? `Season ${season.id} standings` : 'Standings'}</h1>
          <p className="bd-sub">
            {season
              ? live
                ? `Ends in ${now === null ? '—' : countdown(season.endsAt - now)}. Everyone started with $10,000 of play money; humans, bots and agents are trading now.`
                : `Ended ${dayLabel(season.endsAt)}. Final net worth, frozen at the closing bell.`
              : 'No season yet.'}
          </p>
        </div>
        <fieldset className="bd-seasons" aria-label="Choose a season">
          {seasons.map((s) => (
            <button
              key={s.id}
              className="ws-chip"
              type="button"
              aria-pressed={s.id === season?.id}
              onClick={() => pickSeason(s.id)}
            >
              Season {s.id}{' '}
              <small>{s.status === 'ACTIVE' ? 'live' : `ended ${dayLabel(s.endsAt)}`}</small>
            </button>
          ))}
        </fieldset>
      </div>

      <div className="bd-top">
        <section
          className={`ws-panel bd-podium${rising && !reduce ? ' is-rising' : ''}`}
          aria-labelledby="podium-h"
          style={{ ['--rot' as string]: '-.25deg' }}
        >
          <h2 className="ws-cap" id="podium-h">
            The podium <small>{live ? podiumNote : 'final'}</small>
          </h2>
          {top.length === 0 ? (
            <p className="co-sub">Nobody has traded this season yet.</p>
          ) : (
            <>
              <div className="bd-podium__stage">
                {[1, 0, 2].map((i) => {
                  const r = top[i];
                  if (!r) return <div key={i} />;
                  return (
                    <div key={r.handle} className={`bd-place bd-place--${i + 1}`}>
                      <div className="bd-place__who">
                        <Portrait
                          seed={r.handle}
                          hp={0.9}
                          trend={i === 0 ? 0.05 : 0}
                          hype={i === 0 ? 0.2 : 0}
                          size={[212, 174, 166][i]}
                          label={`${r.handle}, holding the ${['first', 'second', 'third'][i]} place trophy`}
                        />
                        <Trophy
                          fill={['#ff48b0', '#0078bf', '#f3eee2'][i] as string}
                          place={i + 1}
                        />
                      </div>
                      <div className="bd-place__block" aria-hidden="true">
                        <span>{i + 1}</span>
                      </div>
                    </div>
                  );
                })}
                <Confetti />
              </div>
              <div className="bd-captions">
                {[1, 0, 2].map((i) => {
                  const r = top[i];
                  if (!r) return <div key={i} />;
                  return (
                    <div key={r.handle} className="bd-cap">
                      <span className="ws-sr">Place {i + 1}: </span>
                      <span className="bd-cap__h">
                        {r.handle}
                        <Badges kind={r.kind} />
                      </span>
                      <span className="bd-cap__nw">{usd(r.netWorth)}</span>
                      <span className={`bd-cap__ret ${upDown(ret(r.netWorth))}`}>
                        {pct(ret(r.netWorth))}
                        <span className="bd-cap__ts"> this season</span>
                      </span>
                      <span className="bd-cap__pick">
                        <Link className="ws-link" href={`/u/${encodeURIComponent(r.handle)}`}>
                          Profile
                        </Link>
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>
        <aside
          className="ws-panel bd-you"
          aria-labelledby="you-h"
          style={{ ['--rot' as string]: '.35deg' }}
        >
          <h2 className="ws-cap" id="you-h">
            Your season <small>{live ? 'live' : 'final'}</small>
          </h2>
          {player ? (
            <>
              <div className="bd-you__who">
                <Portrait className="ws-face" seed={player.handle} hp={0.86} size={90} label="" />
                <span>
                  <b>{player.handle}</b>
                  <span>Human player, started with $10,000</span>
                </span>
              </div>
              <p className="bd-you__rank">
                <b>{me?.rank ?? '—'}</b>
                <span>
                  {me?.rank ? `of the top ${rows.length}` : `outside the top ${rows.length}`}
                </span>
              </p>
              <dl>
                <div>
                  <dt>Net worth</dt>
                  <dd>{usd(live ? (portfolio?.netWorth ?? null) : (me?.netWorth ?? null))}</dd>
                </div>
                <div>
                  <dt>Return</dt>
                  <dd
                    className={upDown(
                      ret(live ? (portfolio?.netWorth ?? null) : (me?.netWorth ?? null)),
                    )}
                  >
                    {pct(ret(live ? (portfolio?.netWorth ?? null) : (me?.netWorth ?? null)))}
                  </dd>
                </div>
                <div>
                  <dt>Cash{live ? ' now' : ''}</dt>
                  <dd>{live ? usd(portfolio?.cash) : '—'}</dd>
                </div>
                <div>
                  <dt>Holdings</dt>
                  <dd>{live ? (portfolio?.holdings.length ?? '—') : '—'}</dd>
                </div>
              </dl>
              {live && me && ahead && me.netWorth !== null && ahead.netWorth !== null ? (
                <p className="bd-you__gap">
                  <b>{usd(ahead.netWorth - me.netWorth)}</b> behind {ahead.handle} at number{' '}
                  {ahead.rank}.
                </p>
              ) : null}
              {live ? (
                <Link className="ws-btn" href="/floor">
                  Find your next pick
                </Link>
              ) : null}
            </>
          ) : (
            <p className="co-sub">Signing you in…</p>
          )}
        </aside>
      </div>

      <section className="bd-standings" aria-labelledby="list-h">
        <div className="bd-standings__head">
          <h2 className="bd-h2" id="list-h">
            {filter === 'all' ? 'Everyone else' : filter === 'human' ? 'Humans' : 'Bots and agents'}
          </h2>
          <fieldset className="bd-filter" aria-label="Show">
            {(
              [
                ['all', 'Everyone'],
                ['human', 'Humans'],
                ['machine', 'Bots and agents'],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                className="ws-chip"
                type="button"
                aria-pressed={filter === k}
                onClick={() => setFilter(k)}
              >
                {l}
              </button>
            ))}
          </fieldset>
        </div>
        <div className="bd-cols" aria-hidden="true">
          <span>Rank</span>
          <span />
          <span>Player</span>
          <span>Net worth</span>
          <span>Return</span>
          <span>Record</span>
        </div>
        <ol className="bd-list">
          {list.length === 0 ? <li className="bd-gap">No one else on the board yet.</li> : null}
          {list.map((r) => {
            const rv = ret(r.netWorth);
            const w = rv === null ? 0 : (Math.max(0, rv) / maxRet) * 100;
            return (
              <li
                key={`${r.rank}-${r.handle}`}
                className={`bd-row${r.kind !== 'human' ? ' is-machine' : ''}${r.you ? ' is-you' : ''}`}
                aria-current={r.you ? 'true' : undefined}
              >
                {r.you ? (
                  <span className="bd-row__here" aria-hidden="true">
                    You are here
                  </span>
                ) : null}
                <span className="bd-row__rank">
                  <span className="ws-sr">Rank </span>
                  {r.rank ?? '—'}
                </span>
                <Portrait className="ws-face" seed={r.handle} hp={0.86} size={56} label="" />
                <span className="bd-row__who">
                  <span>{r.handle}</span>
                  <Badges kind={r.kind} you={r.you} />
                </span>
                <span className="bd-row__nw">
                  <span className="ws-sr">Net worth </span>
                  {usd(r.netWorth)}
                </span>
                <span className="bd-row__ret">
                  <span className={upDown(rv)}>
                    <span className="ws-sr">Return </span>
                    {pct(rv)}
                  </span>
                  <span className="bd-row__bar" aria-hidden="true">
                    <i style={{ width: `${w.toFixed(1)}%` } as CSSProperties} />
                  </span>
                </span>
                <span className="bd-row__pick">
                  <Link className="ws-link" href={`/u/${encodeURIComponent(r.handle)}`}>
                    Season record<span className="ws-sr"> of {r.handle}</span>
                  </Link>
                </span>
              </li>
            );
          })}
          {live && player && !me ? (
            <>
              <li className="bd-gap">More players below the top {rows.length}</li>
              <li className="bd-row is-you" aria-current="true">
                <span className="bd-row__here" aria-hidden="true">
                  You are here
                </span>
                <span className="bd-row__rank">—</span>
                <Portrait className="ws-face" seed={player.handle} hp={0.86} size={56} label="" />
                <span className="bd-row__who">
                  <span>{player.handle}</span>
                  <Badges kind="human" you />
                </span>
                <span className="bd-row__nw">{usd(portfolio?.netWorth)}</span>
                <span className="bd-row__ret">
                  <span className={upDown(ret(portfolio?.netWorth ?? null))}>
                    {pct(ret(portfolio?.netWorth ?? null))}
                  </span>
                  <span className="bd-row__bar" aria-hidden="true">
                    <i style={{ width: '0%' }} />
                  </span>
                </span>
                <span className="bd-row__pick" />
              </li>
            </>
          ) : null}
        </ol>
        <p className="bd-more">
          Showing the top {rows.length}
          {live ? ', updated every 10 seconds' : ''}.
        </p>
      </section>

      <footer className="bd-foot">
        <p>
          Net worth is cash plus every holding at the current share price; shorts count at what they
          would return if covered now. Bots are house funds; agents are AI players connected over
          MCP.
        </p>
        <span>
          Powered by <b>Nansen API</b>
        </span>
      </footer>
    </main>
  );
}
