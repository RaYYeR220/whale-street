'use client';

import type { CheckResult } from '@whale-street/core';
import Link from 'next/link';
import { useState } from 'react';
import type { CompanyView, IpoView } from '../../lib/api-types';
import { headline, hedgeOffset, MEMBERS } from '../../lib/committee';
import { IPO_CAP_USD } from '../../lib/company';
import { agoLong, compact, mmss, shortAddress } from '../../lib/format';
import { Portrait } from '../ink/Portrait';
import { Stamp } from '../ink/Stamp';

export function CopyLink({
  id,
  label = 'Copy link to this verdict',
}: {
  id: string;
  label?: string;
}) {
  const [text, setText] = useState(label);
  return (
    <button
      className="ws-link"
      type="button"
      onClick={() => {
        const url = `${window.location.origin}/ipo/${id}`;
        const done = (ok: boolean) => {
          setText(ok ? 'Link copied' : `Copy failed: ${url}`);
          setTimeout(() => setText(label), 2_200);
        };
        if (navigator.clipboard)
          navigator.clipboard.writeText(url).then(
            () => done(true),
            () => done(false),
          );
        else done(false);
      }}
    >
      {text}
    </button>
  );
}

function Meta({ app, now }: { app: IpoView; now: number | null }) {
  return (
    <dl className="ipo-v__meta">
      <div>
        <dt>Verdict</dt>
        <dd>{app.id}</dd>
      </div>
      <div>
        <dt>Address</dt>
        <dd>{shortAddress(app.address)}</dd>
      </div>
      <div>
        <dt>Decided</dt>
        <dd>{app.decidedAt !== null && now !== null ? agoLong(now - app.decidedAt) : '—'}</dd>
      </div>
    </dl>
  );
}

function HedgeFigure({ app, checks }: { app: IpoView; checks: CheckResult[] }) {
  const links = app.verdict?.hedgeLinks ?? [];
  const hedge = checks.find((c) => c.id === 'HIDDEN_HEDGE');
  const offset = hedgeOffset(hedge?.detail);
  const first = links[0];
  if (!first) return null;
  const node = (who: string, address: string, side: string, coin: string, usd: number | null) => (
    <div className="ipo-node">
      <span className="ipo-node__who">{who}</span>
      <Portrait className="ws-face" seed={address} hp={0.86} size={140} label={who} />
      <span className="ipo-node__addr">{shortAddress(address)}</span>
      <span className={`ipo-slip ipo-slip--${side.toLowerCase()}`}>
        {side} {coin}
        {usd === null ? '' : ` ${compact(usd)}`}
      </span>
    </div>
  );
  return (
    <figure className="ipo-v__fig ipo-hedge">
      <figcaption className="ipo-hedge__title">The hidden hedge</figcaption>
      <div className="ipo-graph">
        {node('Applicant', app.address, first.side === 'LONG' ? 'SHORT' : 'LONG', first.coin, null)}
        <div className="ipo-edge">
          <svg viewBox="0 0 200 24" preserveAspectRatio="none" aria-hidden="true">
            <path
              d="M4 12 L196 12"
              stroke="#1a1714"
              strokeWidth="3"
              strokeDasharray="9 7"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d="M4 12 l11 -7 M4 12 l11 7 M196 12 l-11 -7 M196 12 l-11 7"
              stroke="#1a1714"
              strokeWidth="3"
              strokeLinecap="round"
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <span>
            <b>Linked</b> through Nansen's wallet graph
            {links.length > 1 ? `, with ${links.length - 1} more` : ''}
          </span>
          <span>Opposite side of the same coin</span>
        </div>
        {node('Linked wallet', first.address, first.side, first.coin, first.notionalUsd)}
      </div>
      {offset !== null ? (
        <div className="ipo-offset">
          <span>Exposure that cancels out</span>
          {/* biome-ignore lint/a11y/useSemanticElements: a drawn bar; the native <meter> cannot take this design */}
          <span
            className="ipo-offset__bar"
            role="meter"
            aria-label="Exposure offset by linked wallets"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(offset * 100)}
          >
            <i style={{ width: `${Math.min(100, offset * 100)}%` }} />
            <u>
              <span>limit 50%</span>
            </u>
          </span>
          <b className="ws-v-red">{Math.round(offset * 100)}%</b>
        </div>
      ) : null}
      <p className="ipo-evid">
        <span className="ws-n" aria-hidden="true">
          N
        </span>
        From Nansen: related wallets of {shortAddress(app.address)}, and the positions of each one.
      </p>
    </figure>
  );
}

function EvidenceLog({ checks }: { checks: CheckResult[] }) {
  return (
    <figure className="ipo-v__fig ipo-log">
      <figcaption className="ipo-hedge__title">Evidence log</figcaption>
      <ol>
        {MEMBERS.map((m, i) => {
          const c = checks[i];
          const bad = c?.status === 'UNKNOWN';
          return (
            <li key={m.id} className={bad ? 'is-bad' : undefined}>
              <span>{m.name}</span>
              <span>{bad ? 'no answer' : 'ok'}</span>
              <small>
                {m.source}: {c ? c.detail.replace(/^evidence unavailable: /, '') : 'no record'}
              </small>
            </li>
          );
        })}
      </ol>
    </figure>
  );
}

function ProspectusFigure({ app, company }: { app: IpoView; company: CompanyView | null }) {
  const pr = app.verdict?.prospectus;
  if (!pr) return null;
  return (
    <figure className="ipo-v__fig ipo-pro">
      <figcaption className="ipo-hedge__title">Prospectus</figcaption>
      <div className="ipo-pro__art">
        <Portrait
          seed={app.address}
          hp={company?.hp ?? 0.8}
          status="active"
          size={170}
          label={`${company?.name ?? 'The new company'}'s CEO`}
        />
        <Stamp rating={app.verdict?.rating} />
      </div>
      <div>
        <p className="ipo-pro__tk">{app.ticker}</p>
        <p className="ipo-pro__name">
          {company?.name ?? 'New listing'}, {shortAddress(app.address)}
        </p>
        <dl>
          <div>
            <dt>Style</dt>
            <dd>{pr.style}</dd>
          </div>
          <div>
            <dt>History</dt>
            <dd>{pr.historyDays} days</dd>
          </div>
          <div>
            <dt>Win rate</dt>
            <dd>{Math.round(pr.winRate * 100)}%</dd>
          </div>
          <div>
            <dt>Realized P&amp;L</dt>
            <dd>{pr.realizedPnlBand}</dd>
          </div>
          <div>
            <dt>Average leverage</dt>
            <dd>{pr.avgLeverage.toFixed(1)}x</dd>
          </div>
          <div>
            <dt>Favourite coins</dt>
            <dd>{pr.favoriteCoins.join(', ') || '—'}</dd>
          </div>
          <div>
            <dt>Linked wallets</dt>
            <dd>{pr.linkedWallets}</dd>
          </div>
          <div>
            <dt>Rating</dt>
            <dd>{app.verdict?.rating ?? '—'}</dd>
          </div>
        </dl>
      </div>
    </figure>
  );
}

export function VerdictSheet({
  app,
  checks,
  company,
  now,
  animate,
  onAgain,
}: {
  app: IpoView;
  checks: CheckResult[];
  company: CompanyView | null;
  now: number | null;
  animate: boolean;
  onAgain?: () => void;
}) {
  const title = headline(app, company?.name ?? null);
  const ipoLeft = company && now !== null ? company.ipoUntil - now : null;
  return (
    <section
      className={`ws-panel ipo-verdict${animate ? ' is-in' : ''}`}
      id="verdict"
      data-d={app.status}
      aria-labelledby="verdict-h"
      style={{ ['--rot' as string]: '.2deg' }}
      tabIndex={-1}
      data-testid="verdict"
    >
      <div className="ipo-v__main">
        <h2 id="verdict-h">{title}</h2>
        {app.status === 'APPROVED' ? (
          <>
            <p className="ipo-v__reason">
              All checks cleared
              {checks.some((c) => c.status === 'FLAG') ? ' (a flag costs two rating notches)' : ''}.{' '}
              {app.ticker} is listed on the floor
              {ipoLeft !== null && ipoLeft > 0
                ? ` and its IPO window is open for ${mmss(ipoLeft)}: buy up to $${IPO_CAP_USD.toLocaleString('en-US')} per player`
                : ''}
              .
            </p>
            <Meta app={app} now={now} />
            <div className="ipo-v__actions">
              {app.ticker ? (
                <Link className="ws-btn" href={`/c/${app.ticker}`}>
                  {ipoLeft !== null && ipoLeft > 0 ? 'Buy IPO shares' : `Trade ${app.ticker}`}
                </Link>
              ) : null}
              <CopyLink id={app.id} label="Copy link" />
            </div>
          </>
        ) : (
          <>
            <p className="ipo-v__reason">
              {app.status === 'DEFERRED'
                ? `${app.reason ? `${app.reason.replace(/^[A-Z_]+: /, '')}. ` : ''}Unknown is never a pass and never a fail, so nothing was decided. Send the address again later.`
                : app.reason
                  ? app.reason.replace(/^[A-Z_]+: /, 'Failed: ')
                  : 'One of the six checks failed.'}
            </p>
            <Meta app={app} now={now} />
            <div className="ipo-v__actions">
              <CopyLink id={app.id} />
              {onAgain ? (
                <button className="ws-link" type="button" onClick={onAgain}>
                  Check another address
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>
      {app.status === 'APPROVED' ? (
        <ProspectusFigure app={app} company={company} />
      ) : app.status === 'DENIED' && (app.verdict?.hedgeLinks.length ?? 0) > 0 ? (
        <HedgeFigure app={app} checks={checks} />
      ) : (
        <EvidenceLog checks={checks} />
      )}
    </section>
  );
}
