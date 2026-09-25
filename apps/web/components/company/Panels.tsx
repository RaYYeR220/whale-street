'use client';

import { type CheckResult, PARAMS, type Prospectus as ProspectusData } from '@whale-street/core';
import { useMemo, useState } from 'react';
import type { FilingView, HolderView, PositionView } from '../../lib/api-types';
import type { ListingLookup } from '../../lib/committee';
import {
  cushionLeft,
  type DisplayCompany,
  liqDistance,
  notional,
  side,
  unrealized,
} from '../../lib/company';
import { filingText, foldConsecutive, kindOf, TONE_TEXT } from '../../lib/filings';
import { ago, agoLong, coinPx, compact, pctAbs, upDown } from '../../lib/format';
import { band } from '../../lib/ink';
import { NMark } from '../chrome/Drawer';
import { Hp } from '../ink/Hp';

export function RiskPanel({ c }: { c: DisplayCompany }) {
  const bankrupt = c.display === 'bankrupt' || c.display === 'delisted';
  // Least cushion first: that position sets HP.
  const pos = [...c.positions].sort(
    (a, b) =>
      (cushionLeft(a) ?? Number.POSITIVE_INFINITY) - (cushionLeft(b) ?? Number.POSITIVE_INFINITY),
  );
  const risky = pos[0];
  const minHp = PARAMS.mirror.minHp;
  return (
    <section
      className="ws-panel ws-panel--thin co-risk"
      aria-labelledby="risk-h"
      style={{ ['--rot' as string]: '.3deg' }}
    >
      <h2 className="ws-cap" id="risk-h">
        Risk <small>distance to liquidation</small>
      </h2>
      <Hp hp={bankrupt ? 0 : c.hp} size="lg" />
      {bankrupt ? (
        <>
          <p className="co-risk__why">
            <b>0% HP.</b> A liquidation wiped out the account. Nothing is left to measure.
          </p>
          <p className="co-risk__rule">
            Mirror stays refused: the company is bankrupt and has no open positions.
          </p>
        </>
      ) : (
        <>
          <p className="co-risk__why">
            {risky ? (
              <>
                HP is how much of the distance from entry to liquidation is still left. It follows
                the position with the least left,{' '}
                <b>
                  {side(risky).toLowerCase()} {risky.coin} {Math.round(risky.leverage)}x
                </b>
                . The face gets tenser as it falls.
              </>
            ) : (
              'No open positions: nothing can be liquidated.'
            )}
            {c.display === 'halted' ? ' As of the last Nansen snapshot.' : ''}
          </p>
          <ul className="co-liq">
            {pos.map((p, k) => (
              <LiqRow key={p.coin} p={p} first={k === 0} />
            ))}
          </ul>
          <p className="co-risk__rule">
            {c.hp === null
              ? `Mirror needs a known HP of at least ${Math.round(minHp * 100)}%. It is unknown right now, so Mirror is closed.`
              : c.hp >= minHp
                ? `Mirror copies this trader only while HP is at least ${Math.round(minHp * 100)}%. Now ${Math.round(c.hp * 100)}%, so Mirror is open.`
                : `Mirror refuses below ${Math.round(minHp * 100)}% HP. Now ${Math.round(c.hp * 100)}%, so Mirror is closed for ${c.ticker}.`}
          </p>
        </>
      )}
    </section>
  );
}

/** Bar texture by the face's bands: calm, tense, then panic and meltdown alike. */
const BAR_BAND = { calm: '', tense: 'tense', panic: 'hot', meltdown: 'hot' } as const;

/** One position on the HP scale: the share of its entry-to-liquidation cushion still left. */
function LiqRow({ p, first }: { p: PositionView; first: boolean }) {
  const left = cushionLeft(p);
  const d = liqDistance(p);
  const title = `${side(p)} ${p.coin} ${Math.round(p.leverage)}x`;
  if (left === null || d === null)
    return (
      <li>
        <div className="co-liq__top">
          <span>
            <b>{title}</b>
          </span>
          <span>{p.liqPx === null ? 'no liquidation price' : 'no live mark'}</span>
        </div>
        <div className="co-liq__note">
          {p.liqPx === null
            ? "Fully collateralized; it can't be liquidated."
            : 'Hyperliquid has no mark for this coin right now.'}
        </div>
      </li>
    );
  const pct = Math.round(left * 100);
  return (
    <li>
      <div className="co-liq__top">
        <span>
          <b>{title}</b>
          {first ? <span className="ws-badge ws-badge--bot">Sets HP</span> : null}
        </span>
        <span className="ws-num">
          <b>{pct}%</b> of the cushion left
        </span>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a drawn bar; the native <meter> cannot take this design */}
      <div
        className="co-liq__bar"
        data-band={BAR_BAND[band(left)]}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={`${p.coin}: share of the distance from entry to liquidation still left`}
      >
        <i style={{ width: `${(left * 100).toFixed(1)}%` }} />
      </div>
      <div className="co-liq__note">
        {p.coin} liquidation {pctAbs(d)} {side(p) === 'LONG' ? 'below' : 'above'} the mark: at{' '}
        {coinPx(p.liqPx)}, now {coinPx(p.mark)}, entry {coinPx(p.entryPx)}.
      </div>
    </li>
  );
}

export function DeskPanel({
  c,
  now,
  provenance,
}: {
  c: DisplayCompany;
  now: number | null;
  provenance: readonly string[];
}) {
  const age = c.lastSnapshotAt !== null && now !== null ? now - c.lastSnapshotAt : null;
  return (
    <section
      className="ws-panel ws-panel--thin co-desk"
      aria-labelledby="desk-h"
      style={{ ['--rot' as string]: '-.35deg' }}
    >
      <h2 className="ws-cap" id="desk-h">
        The desk <small>open positions on Hyperliquid</small>
      </h2>
      {c.positions.length === 0 ? (
        <div className="co-desk__none">
          <b>The desk is cleared</b>
          {c.display === 'bankrupt' || c.display === 'delisted'
            ? 'The positions were liquidated. None are open.'
            : 'No open positions right now.'}
        </div>
      ) : (
        <>
          <p className="co-sub">
            {c.display === 'halted'
              ? 'Last known positions, from the last Nansen snapshot. Nansen has not answered since.'
              : `Read from Hyperliquid through Nansen ${age === null ? '' : agoLong(age)}. Size is notional at the live mark.`}
          </p>
          <div className="co-slips">
            {c.positions.map((p) => {
              const u = unrealized(p);
              return (
                <article
                  key={p.coin}
                  className="co-slip"
                  data-side={side(p)}
                  aria-label={`${side(p)} ${p.coin} ${Math.round(p.leverage)}x`}
                >
                  <span className="co-slip__clip" aria-hidden="true" />
                  <div className="co-slip__h">
                    <span className="co-slip__coin">{p.coin}</span>
                    <span
                      className={`co-slip__side ${side(p) === 'LONG' ? 'ws-v-up' : 'ws-v-down'}`}
                    >
                      {side(p) === 'LONG' ? 'Long' : 'Short'} {Math.round(p.leverage)}x
                    </span>
                    <NMark
                      label="Where this position comes from"
                      ticker={c.ticker}
                      provenance={provenance}
                    />
                  </div>
                  <dl>
                    <dt>Size</dt>
                    <dd>{compact(notional(p))}</dd>
                    <dt>Entry</dt>
                    <dd>{coinPx(p.entryPx)}</dd>
                    <dt>Mark</dt>
                    <dd>{coinPx(p.mark)}</dd>
                    <dt>Liquidation</dt>
                    <dd>{p.liqPx === null ? 'none' : coinPx(p.liqPx)}</dd>
                  </dl>
                  <div className="co-slip__pnl">
                    <span>{u.live ? 'Unrealized' : 'Unrealized at snapshot'}</span>
                    <b className={upDown(u.usd)}>
                      {u.usd === null
                        ? '—'
                        : `${u.usd >= 0 ? '+' : '−'}${compact(Math.abs(u.usd))}`}
                    </b>
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

export function FilingsTimeline({
  filings,
  now,
  lit,
}: {
  filings: readonly FilingView[];
  now: number | null;
  lit: ReadonlySet<number>;
}) {
  const [all, setAll] = useState(false);
  const items = useMemo(() => foldConsecutive(filings), [filings]);
  const isLit = (ids: readonly number[]) => ids.some((id) => lit.has(id));
  const showAll = all || items.slice(8).some((x) => isLit(x.ids));
  return (
    <section
      className="ws-panel ws-panel--flat ws-panel--thin co-filings"
      aria-labelledby="filings-h"
    >
      <h2 className="ws-cap" id="filings-h">
        Filings <small>full history, newest first</small>
      </h2>
      {items.length === 0 ? (
        <p className="co-sub">No filings yet.</p>
      ) : (
        <ol className={`co-tl${showAll ? ' is-all' : ''}`}>
          {items.map(({ filing: f, ids }) => {
            const k = kindOf(f);
            const times = ids.length;
            return (
              <li key={f.id} id={`fl-${f.id}`} className={isLit(ids) ? 'is-lit' : undefined}>
                <span className="co-tl__when">{now === null ? '' : ago(now - f.at)}</span>
                <span className="co-tl__dot" data-tone={k.tone} aria-hidden="true" />
                <div
                  className={`ws-balloon ${k.shout ? '' : 'ws-balloon--tail-left '}${k.balloon}`}
                >
                  <div className="co-tl__meta">
                    <span className={`kind ${TONE_TEXT[k.tone]}`}>
                      {k.label}
                      {times > 1 ? <span aria-hidden="true"> ×{times}</span> : null}
                    </span>
                    {times > 1 ? (
                      <span className="ws-sr">, filed {times} times in a row</span>
                    ) : null}
                    <span className="ws-sr">{now === null ? '' : agoLong(now - f.at)}</span>
                    {f.provenance.length > 0 ? (
                      <>
                        <NMark label="Nansen evidence for this filing" provenance={f.provenance} />
                        <span className="hash">{f.provenance[0]}</span>
                      </>
                    ) : null}
                  </div>
                  <div>{filingText(f)}</div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {items.length > 8 ? (
        <button
          className="ws-link co-more"
          type="button"
          aria-expanded={showAll}
          onClick={() => setAll((v) => !v)}
        >
          {showAll ? 'Show fewer filings' : `Show all ${items.length} entries`}
        </button>
      ) : null}
    </section>
  );
}

const SEAL: Record<CheckResult['status'], string> = {
  PASS: '可',
  FLAG: '注',
  FAIL: '否',
  UNKNOWN: '?',
};
export const CHECK_NAME: Record<CheckResult['id'], string> = {
  TRACK_RECORD: 'Track record',
  SIZE: 'Size',
  HUMAN_TRADER: 'Human trader',
  HIDDEN_HEDGE: 'Hidden hedge',
  CONCENTRATION: 'Concentration',
  UNIQUENESS: 'Uniqueness',
};

export function Seal({
  status,
  small,
}: {
  status: CheckResult['status'] | 'wait';
  small?: boolean;
}) {
  const s = status === 'wait' ? 'wait' : status.toLowerCase();
  return (
    <span
      className={`co-seal${small ? ' co-seal--sm' : ''}`}
      data-s={s}
      role="img"
      aria-label={status === 'wait' ? 'Pending' : status}
    >
      <span>{status === 'wait' ? '…' : SEAL[status]}</span>
    </span>
  );
}

/** Why there is no committee record to show, in words. */
function noRecord(source: string | null, lookup: ListingLookup): string {
  if (source === 'SEEDED')
    return 'Loaded from the recorded session (REPLAY), so no committee ran for it.';
  if (source === 'SCOUT')
    return 'This listing was found by the scout, not nominated at the desk, so there is no application to publish.';
  if (lookup.kind === 'loading') return 'Looking up the committee record…';
  if (lookup.kind === 'error') return `Cannot load the committee record (${lookup.message}).`;
  if (lookup.kind === 'missing')
    return `Not found among the ${lookup.scanned} most recent applications, the most the engine lists: its record is older.`;
  return 'The committee record for this listing is not published.';
}

export function Prospectus({
  c,
  prospectus,
  source,
  lookup,
}: {
  c: DisplayCompany;
  prospectus: ProspectusData | null;
  source: string | null;
  lookup: ListingLookup;
}) {
  const record = lookup.kind === 'found' ? lookup.app : null;
  const view = prospectus ?? record?.verdict?.prospectus ?? null;
  const checks = record?.verdict?.checks ?? null;
  const pass = checks?.filter((x) => x.status === 'PASS').length ?? 0;
  const flags = checks?.filter((x) => x.status === 'FLAG').length ?? 0;
  return (
    <section
      className="ws-panel ws-panel--thin co-dossier"
      aria-labelledby="dossier-h"
      style={{ ['--rot' as string]: '.25deg' }}
    >
      <h2 className="ws-cap" id="dossier-h">
        Prospectus <small>from the listing committee</small>
      </h2>
      {view ? (
        <dl className="co-facts">
          <div>
            <dt>Style</dt>
            <dd>{view.style}</dd>
          </div>
          <div>
            <dt>History</dt>
            <dd>{view.historyDays} days</dd>
          </div>
          <div>
            <dt>Win rate</dt>
            <dd>
              {Math.round(view.winRate * 100)}%
              <NMark label="Where the win rate comes from" ticker={c.ticker} />
            </dd>
          </div>
          <div>
            <dt>Realized PnL</dt>
            <dd>
              {view.realizedPnlBand}
              <NMark label="Where realized PnL comes from" ticker={c.ticker} />
            </dd>
          </div>
          <div>
            <dt>Average leverage</dt>
            <dd>{view.avgLeverage.toFixed(1)}x</dd>
          </div>
          <div>
            <dt>Favourite coins</dt>
            <dd>{view.favoriteCoins.join(', ') || '—'}</dd>
          </div>
          <div>
            <dt>Linked wallets</dt>
            <dd>
              {view.linkedWallets}
              <NMark label="Where linked wallets come from" ticker={c.ticker} />
            </dd>
          </div>
          <div>
            <dt>Rating</dt>
            <dd>
              {c.rating ?? 'Unrated'}{' '}
              {checks ? (
                <small>
                  {pass} passed{flags ? `, ${flags} flagged` : ''}
                </small>
              ) : null}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="co-sub">{noRecord(source, lookup)}</p>
      )}
      <h3 className="co-h3">Committee checks</h3>
      {checks ? (
        <ul className="co-checks6">
          {checks.map((k) => (
            <li key={k.id}>
              <Seal status={k.status} />
              <span>
                <b>{CHECK_NAME[k.id]}</b>
                <span>{k.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="co-sub">
          {view
            ? `No six-check record to show. ${noRecord(source, lookup)}`
            : 'No six-check record to show.'}
        </p>
      )}
    </section>
  );
}

export function Holders({ holders, you }: { holders: readonly HolderView[]; you: string | null }) {
  const float = holders.reduce((s, h) => s + h.longQty, 0);
  const shorted = holders.reduce((s, h) => s + h.shortQty, 0);
  const top = holders.filter((h) => h.longQty > 0).slice(0, 8);
  const max = top[0]?.longQty ?? 1;
  const mine = you ? holders.find((h) => h.handle === you) : undefined;
  const machines = top.filter((h) => h.kind !== 'human').reduce((s, h) => s + h.longQty, 0);
  const badge = (h: HolderView) =>
    h.handle === you ? (
      <span className="ws-badge ws-badge--you">YOU</span>
    ) : h.kind === 'bot' ? (
      <span className="ws-badge ws-badge--bot">BOT</span>
    ) : h.kind === 'agent' ? (
      <span className="ws-badge ws-badge--agent">AGENT</span>
    ) : null;
  return (
    <section
      className="ws-panel ws-panel--thin co-holders"
      aria-labelledby="holders-h"
      style={{ ['--rot' as string]: '-.2deg' }}
    >
      <h2 className="ws-cap" id="holders-h">
        Holders <small>share of float</small>
      </h2>
      {holders.length === 0 ? (
        <p className="co-sub">Nobody holds it yet this season.</p>
      ) : (
        <>
          <p className="co-hold__sum">
            <span>
              <b>{holders.length}</b> holders
            </span>
            <span>
              <b>{float.toLocaleString('en-US', { maximumFractionDigits: 0 })}</b> shares held
            </span>
            <span>
              Bots and agents in the top 8:{' '}
              <b>{float > 0 ? ((machines / float) * 100).toFixed(0) : 0}%</b>
            </span>
            <span>
              Short interest <b>{float > 0 ? ((shorted / float) * 100).toFixed(1) : '0.0'}%</b>
            </span>
          </p>
          <ol className="co-hold" aria-label="Top holders by share of float">
            {top.map((h, i) => (
              <li key={h.handle} className={h.handle === you ? 'is-you' : undefined}>
                <span className="co-hold__rank">{i + 1}</span>
                <span className="co-hold__who">
                  {badge(h)}
                  <span>{h.handle}</span>
                </span>
                <span className="co-hold__bar" aria-hidden="true">
                  <i style={{ width: `${Math.max(2, (h.longQty / max) * 100).toFixed(1)}%` }} />
                </span>
                <span className="co-hold__pct">
                  {float > 0 ? ((h.longQty / float) * 100).toFixed(1) : '0.0'}%
                </span>
              </li>
            ))}
            {mine && !top.includes(mine) && mine.longQty > 0 ? (
              <li className="is-you">
                <span className="co-hold__rank" />
                <span className="co-hold__who">
                  {badge(mine)}
                  <span>{mine.handle}</span>
                </span>
                <span className="co-hold__bar" aria-hidden="true">
                  <i style={{ width: `${Math.max(2, (mine.longQty / max) * 100).toFixed(1)}%` }} />
                </span>
                <span className="co-hold__pct">{((mine.longQty / float) * 100).toFixed(1)}%</span>
              </li>
            ) : null}
            {holders.length > top.length ? (
              <li className="is-other">
                <span className="co-hold__rank" />
                <span className="co-hold__who">
                  <span>Everyone else, {holders.length - top.length} holders</span>
                </span>
                <span />
                <span className="co-hold__pct">
                  {float > 0
                    ? (((float - top.reduce((s, h) => s + h.longQty, 0)) / float) * 100).toFixed(1)
                    : '0.0'}
                  %
                </span>
              </li>
            ) : null}
          </ol>
        </>
      )}
    </section>
  );
}
