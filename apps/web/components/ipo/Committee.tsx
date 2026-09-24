'use client';

import type { CheckResult } from '@whale-street/core';
import type { CSSProperties } from 'react';
import type { IpoView } from '../../lib/api-types';
import { MARK, MEMBERS, type MemberState, SAY, stampColumn } from '../../lib/committee';
import { Hanko } from '../ink/Hanko';
import { Portrait } from '../ink/Portrait';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const SHOUT: Partial<Record<CheckResult['id'], string>> = {
  TRACK_RECORD: 'Come back with a real track record!',
  SIZE: "That's too small to list!",
  HUMAN_TRADER: 'That’s a market maker, not a person!',
  HIDDEN_HEDGE: 'Their other wallet holds the other side!',
  UNIQUENESS: 'We can’t list this one again!',
};

function memberFace(i: number, state: MemberState) {
  const m = MEMBERS[i] as (typeof MEMBERS)[number];
  const hp = state === 'FAIL' ? 0.22 : state === 'FLAG' ? 0.45 : 0.86;
  const status = state === 'UNKNOWN' ? 'halted' : 'active';
  const mood = {
    FAIL: 'shocked',
    FLAG: 'frowning',
    UNKNOWN: 'asleep, waiting for evidence',
    PASS: 'satisfied',
    thinking: 'reading the dossier',
    read: 'done reading',
    pending: 'waiting',
  }[state];
  return (
    <Portrait
      seed={m.seed}
      hp={hp}
      status={status}
      size={150}
      label={`Committee member for ${m.name.toLowerCase()}, ${mood}`}
    />
  );
}

export function Committee({
  states,
  checks,
  app,
  animate,
  subtitle,
  progressText,
  onReplay,
}: {
  states: MemberState[];
  checks: CheckResult[] | null;
  app: IpoView | null;
  animate: boolean;
  subtitle: string;
  progressText: string;
  onReplay?: () => void;
}) {
  const decided =
    app !== null &&
    app.status !== 'PENDING' &&
    states.every((s) => s !== 'pending' && s !== 'thinking' && s !== 'read');
  const H =
    app?.status === 'DENIED'
      ? { kanji: '否決', word: 'DENIED', tone: 'red' as const }
      : app?.status === 'APPROVED'
        ? { kanji: '承認', word: 'LISTED', tone: 'blue' as const }
        : { kanji: '保留', word: 'DEFERRED', tone: 'ink' as const };
  const col = checks && app ? stampColumn(checks, app.status) : 3;
  return (
    <section
      className={`ws-panel ipo-room${decided ? ' is-decided' : ''}${decided && animate && app?.status === 'DENIED' ? ' is-shake' : ''}`}
      id="room"
      aria-labelledby="room-h"
      style={{ ['--rot' as string]: '-.15deg' }}
      tabIndex={-1}
    >
      <h2 className="ws-cap" id="room-h">
        Listing committee <small>{subtitle}</small>
      </h2>
      <div className="ipo-progress">
        <span className="ipo-progress__t">{progressText}</span>
        <span className="ipo-progress__bar" aria-hidden="true">
          {states.map((s, i) => (
            <i
              key={MEMBERS[i]?.id ?? i}
              className={
                s === 'thinking' ? 'is-reading' : s === 'pending' || s === 'read' ? '' : `is-${s}`
              }
            />
          ))}
        </span>
        {decided && onReplay ? (
          <button className="ws-link ipo-replay" type="button" onClick={onReplay}>
            Watch it again
          </button>
        ) : null}
      </div>
      <ol className="ipo-table" aria-label="The six committee members and their checks">
        {MEMBERS.map((m, i) => {
          const s = states[i] ?? 'pending';
          const check = checks?.[i];
          const final = s === 'PASS' || s === 'FAIL' || s === 'FLAG' || s === 'UNKNOWN';
          return (
            <li key={m.id} className="ipo-member" data-s={s}>
              <div className="ipo-member__bubble" aria-hidden="true">
                {s === 'thinking' ? (
                  <span className="ipo-think">
                    <span>.</span>
                    <span>.</span>
                    <span>.</span>
                  </span>
                ) : s === 'UNKNOWN' ? (
                  <span className="ipo-think ipo-think--q">?</span>
                ) : s === 'FAIL' && SHOUT[m.id] ? (
                  <p className="ws-balloon ws-balloon--shout ws-balloon--red ipo-shout">
                    {SHOUT[m.id]}
                  </p>
                ) : s === 'FLAG' ? (
                  <p className="ws-balloon ws-balloon--tail-bottom ipo-shout">
                    One trade made most of it.
                  </p>
                ) : null}
              </div>
              <div className="ipo-member__face">{memberFace(i, s)}</div>
              <div className="ipo-desk">
                <div className="ipo-paper">
                  {final ? (
                    <span className={`ipo-mark${animate ? ' is-stamping' : ''}`} data-s={s}>
                      <b>{MARK[s][0]}</b>
                      <small>{MARK[s][1]}</small>
                    </span>
                  ) : null}
                </div>
              </div>
              <span className="ipo-plate">{m.name}</span>
              <p className="ipo-member__detail">
                {final && check ? (
                  <>
                    <b>{SAY[s]}</b>
                    {cap(check.detail)}
                  </>
                ) : s === 'thinking' ? (
                  <>
                    <b>Reading</b>Asking Nansen
                  </>
                ) : s === 'read' ? (
                  <>
                    <b>Evidence in</b>Waiting for the vote
                  </>
                ) : (
                  <>
                    <b>Waiting</b>Evidence not in yet
                  </>
                )}
                <span className="ipo-member__src">{m.source}</span>
              </p>
            </li>
          );
        })}
      </ol>
      <div
        className="ipo-stamp-slot"
        aria-hidden="true"
        style={{ '--stamp-x': `${(col / 6) * 100}%` } as CSSProperties}
      >
        {decided ? (
          <Hanko kanji={H.kanji} word={H.word} tone={H.tone} stamping={animate} label={H.word} />
        ) : null}
      </div>
      {decided && app?.status === 'APPROVED' ? (
        <span className="ipo-bell" aria-hidden="true">
          <svg width="64" height="64" viewBox="0 0 40 40" aria-hidden="true">
            <path
              d="M9 27 C9 17 13.5 12 19.5 12 C25.5 12 30 17 30 27 L33 30 L6 30 Z"
              fill="#ff48b0"
              transform="translate(1 .8)"
            />
            <path
              d="M9 27 C9 17 13.5 12 19.5 12 C25.5 12 30 17 30 27 L33 30 L6 30 Z"
              fill="none"
              stroke="#1a1714"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
            <circle cx="19.5" cy="10.2" r="2" fill="none" stroke="#1a1714" strokeWidth="1.5" />
            <circle cx="19.5" cy="32.2" r="2.5" fill="#1a1714" />
            <path
              d="M4 15 L1 12 M35 15 L38 12 M3 21 L0 21 M36 21 L39 21"
              stroke="#1a1714"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
          <span
            className={`ws-kan${animate ? ' is-ringing' : ''}`}
            style={{ left: 52, top: -4, fontSize: '1.3rem' }}
          >
            KAN KAN KAN
          </span>
        </span>
      ) : null}
    </section>
  );
}
