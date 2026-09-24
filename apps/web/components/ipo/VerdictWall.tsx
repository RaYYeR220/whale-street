'use client';

import Link from 'next/link';
import type { IpoView } from '../../lib/api-types';
import { deferral, MEMBERS, verdictChecks } from '../../lib/committee';
import { ago, shortAddress } from '../../lib/format';
import { Hanko } from '../ink/Hanko';
import { Portrait } from '../ink/Portrait';
import { CopyLink } from './VerdictSheet';

const ROT = [-0.8, 0.6, -0.3, 0.9, 0.4, -0.7, 0.7, -0.4];

export function VerdictWall({
  apps,
  now,
  current,
}: {
  apps: readonly IpoView[];
  now: number | null;
  current: string | null;
}) {
  const decided = apps.filter((a) => a.status !== 'PENDING');
  return (
    <section className="ipo-wall" aria-labelledby="wall-h">
      <div className="ipo-wall__head">
        <h2 className="ipo-h2" id="wall-h">
          Recent verdicts
        </h2>
        <p>Every decision gets its own page. Copy a link to share it.</p>
      </div>
      {decided.length === 0 ? (
        <p className="co-sub">No verdicts yet. Send the first address above.</p>
      ) : (
        <ol className="ipo-wall__grid">
          {decided.map((a, i) => {
            const checks = verdictChecks(a);
            const bad =
              checks.find((c) => c.status === 'FAIL') ?? checks.find((c) => c.status === 'UNKNOWN');
            const name = bad ? MEMBERS.find((m) => m.id === bad.id)?.name : null;
            const H =
              a.status === 'DENIED'
                ? { kanji: '否決', tone: 'red' as const, word: 'denied' }
                : a.status === 'APPROVED'
                  ? { kanji: '承認', tone: 'blue' as const, word: 'listed' }
                  : { kanji: '保留', tone: 'ink' as const, word: 'deferred' };
            return (
              <li
                key={a.id}
                className={`ipo-card${a.id === current ? ' is-current' : ''}`}
                style={{ ['--r' as string]: `${ROT[i % ROT.length]}deg` }}
              >
                <Hanko kanji={H.kanji} tone={H.tone} label={`Stamped ${H.word}`} />
                <div className="ipo-card__top">
                  <Portrait
                    className="ws-face"
                    seed={a.address}
                    hp={a.status === 'DENIED' ? 0.25 : 0.8}
                    status={a.status === 'DEFERRED' ? 'halted' : 'active'}
                    size={64}
                    label=""
                  />
                  <span>
                    <span className="ipo-card__addr">{shortAddress(a.address)}</span>
                    <span className="ipo-card__ago">
                      {a.decidedAt !== null && now !== null ? `${ago(now - a.decidedAt)} ago` : ''}
                    </span>
                  </span>
                </div>
                <p className="ipo-card__check">
                  {a.status === 'APPROVED' ? (
                    <>
                      <b className="ws-v-down">Listed</b>, rated {a.verdict?.rating ?? '—'}
                    </>
                  ) : a.status === 'DEFERRED' && !a.verdict ? (
                    <>
                      <b>Deferred:</b> {deferral(a).headline.replace(/^Deferred: /, '')}
                    </>
                  ) : a.status === 'DEFERRED' ? (
                    <>
                      <b>Unknown:</b> {name ?? 'evidence'}
                    </>
                  ) : (
                    <>
                      <b className="ws-v-red">Failed:</b> {name ?? 'a check'}
                    </>
                  )}
                </p>
                <p className="ipo-card__line">
                  {a.status === 'APPROVED'
                    ? `Listed as ${a.ticker}.`
                    : a.status === 'DEFERRED' && !a.verdict
                      ? deferral(a).detail
                      : (bad?.detail ?? a.reason ?? '')}
                </p>
                <div className="ipo-card__foot">
                  <Link className="ws-link" href={`/ipo/${a.id}`}>
                    Open verdict {a.id.replace(/^ipo_/, '')}
                  </Link>
                  <CopyLink id={a.id} label="Copy link" />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
