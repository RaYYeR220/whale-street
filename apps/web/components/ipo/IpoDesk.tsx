'use client';

import type { CheckResult } from '@whale-street/core';
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CompanyView, IpoView } from '../../lib/api-types';
import {
  decidedUpdate,
  headline,
  isDecided,
  MEMBERS,
  type MemberState,
  progressStates,
  SAY,
  verdictChecks,
} from '../../lib/committee';
import { ipoErrorText } from '../../lib/errors';
import { shortAddress } from '../../lib/format';
import { useReducedMotion } from '../ink/motion';
import { useChannels, useEngine, useEngineNow, useEngineRuntime } from '../providers/engine';
import { usePlayer } from '../providers/player';
import { Committee } from './Committee';
import { VerdictSheet } from './VerdictSheet';
import { VerdictWall } from './VerdictWall';

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const POLL_MS = 2_000;
const REVEAL_MS = 450;

export function addressProblem(raw: string): string | null {
  const v = raw.trim();
  if (!v) return 'Paste a Hyperliquid address first. It starts with 0x and has 42 characters.';
  if (!ADDRESS_RE.test(v))
    return `That isn’t a Hyperliquid address. It starts with 0x and has 42 characters; this has ${v.length}.`;
  return null;
}

function decidedText(checks: readonly { status: string }[] | null): string {
  const missing = checks?.filter((c) => c.status === 'UNKNOWN').length ?? 0;
  if (!checks || checks.length === 0) return 'Decided without a check record';
  return missing === 0
    ? `Decided, all ${checks.length} checks backed by evidence`
    : `Decided, ${missing} of ${checks.length} checks had no evidence`;
}

/** The IPO desk: nominate an address, watch the six members check it, get a shareable verdict. */
export function IpoDesk({
  initialApps,
  initialApp,
}: {
  initialApps: IpoView[];
  initialApp: IpoView | null;
}) {
  useChannels(['ipo', 'status']);
  const { api } = useEngineRuntime();
  const updates = useEngine((s) => s.ipo);
  const creditFloor = useEngine((s) => s.status?.creditFloor ?? false);
  const now = useEngineNow();
  const { token, status } = usePlayer();
  const reduce = useReducedMotion();
  const [address, setAddress] = useState(initialApp?.address ?? '');
  const [formError, setFormError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [app, setApp] = useState<IpoView | null>(initialApp);
  const [reveal, setReveal] = useState(initialApp && isDecided(initialApp) ? MEMBERS.length : 0);
  const [animate, setAnimate] = useState(false);
  const [apps, setApps] = useState<IpoView[]>(initialApps);
  const [company, setCompany] = useState<CompanyView | null>(null);
  const [live, setLive] = useState('');
  const [replay, setReplay] = useState(0);
  const roomRef = useRef<HTMLDivElement>(null);

  const refreshWall = useCallback(async () => {
    const r = await api.ipoList(12);
    if (r.ok) setApps(r.data.apps);
  }, [api]);

  // Poll the application until decided (covers missed WebSocket events), then load the full verdict.
  const appId = app?.id ?? null;
  const pending = app?.status === 'PENDING';
  const decidedEvent = appId ? decidedUpdate(updates, appId) : null;
  useEffect(() => {
    if (!appId || (!pending && !decidedEvent)) return;
    let cancelled = false;
    const load = async () => {
      const r = await api.ipo(appId);
      if (cancelled || !r.ok) return;
      if (r.data.app.status !== 'PENDING') setApp(r.data.app);
    };
    void load();
    const id = pending ? setInterval(load, POLL_MS) : null;
    return () => {
      cancelled = true;
      if (id) clearInterval(id);
    };
  }, [api, appId, pending, decidedEvent]);

  // Reveal the stamps one member at a time once a verdict is in.
  const decided = isDecided(app);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `replay` restarts the reveal
  useEffect(() => {
    if (!decided) return;
    if (reduce || !animate) {
      setReveal(MEMBERS.length);
      return;
    }
    setReveal(0);
    let n = 0;
    const id = setInterval(() => {
      n += 1;
      setReveal(n);
      if (n >= MEMBERS.length) clearInterval(id);
    }, REVEAL_MS);
    return () => clearInterval(id);
  }, [decided, reduce, animate, replay]);

  useEffect(() => {
    if (app?.status !== 'APPROVED' || !app.ticker) {
      setCompany(null);
      return;
    }
    let cancelled = false;
    void api.company(app.ticker).then((r) => {
      if (!cancelled && r.ok) setCompany(r.data.company);
    });
    return () => {
      cancelled = true;
    };
  }, [api, app]);

  const checks: CheckResult[] | null = useMemo(
    () => (decided && app ? verdictChecks(app) : null),
    [decided, app],
  );
  const progress = app
    ? progressStates(updates, app.id)
    : MEMBERS.map((): MemberState => 'pending');
  const states: MemberState[] = checks
    ? checks.map((c, i) =>
        i < reveal ? c.status : progress[i] === 'pending' ? 'read' : (progress[i] as MemberState),
      )
    : progress;
  const allRevealed = checks !== null && reveal >= MEMBERS.length;

  useEffect(() => {
    if (!app || !checks || !allRevealed) return;
    setLive(`Verdict: ${headline(app, company?.name ?? null)}.`);
    void refreshWall();
  }, [app, checks, allRevealed, company, refreshWall]);

  const done = states.filter((s) => s !== 'pending' && s !== 'thinking').length;
  const progressText = !app
    ? 'Waiting for an address'
    : allRevealed
      ? decidedText(checks)
      : `Evidence from Nansen: ${done} of 6 checks`;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const problem = addressProblem(address);
    if (problem) {
      setFormError(problem);
      return;
    }
    if (!token) {
      setFormError(
        status === 'offline'
          ? 'Cannot reach the engine. Nothing was sent.'
          : 'Your player is still signing in.',
      );
      return;
    }
    setFormError(null);
    setSending(true);
    const r = await api.applyIpo(token, address.trim());
    setSending(false);
    if (!r.ok) {
      setFormError(ipoErrorText(r.error, r.message));
      return;
    }
    setAnimate(true);
    setReveal(0);
    setApp(r.data.app);
    setLive(`Committee reviewing ${shortAddress(r.data.app.address)}.`);
    roomRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  };

  const tries = useMemo(() => apps.filter((a) => a.status !== 'PENDING').slice(0, 3), [apps]);

  return (
    <main className="ipo" id="main">
      <section className="ipo-intake" aria-labelledby="ipo-h">
        <div className="ipo-intake__t">
          <h1 className="ipo-h1" id="ipo-h">
            IPO desk
          </h1>
          <p>
            Nominate any Hyperliquid trader. Six committee members check them with Nansen data. Six
            passes and they list on the floor with an IPO window; one fail and they don’t.
          </p>
        </div>
        <form
          className={`ipo-form${formError ? ' is-bad' : ''}`}
          noValidate
          onSubmit={(e) => void submit(e)}
        >
          <label className="ipo-form__l" htmlFor="addr">
            Hyperliquid address
          </label>
          <div className="ipo-form__row">
            <span className="ws-search ipo-form__field">
              <input
                id="addr"
                name="addr"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="0x… (42 characters)"
                aria-describedby="addr-help addr-err"
                aria-invalid={formError ? true : undefined}
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value);
                  if (formError) setFormError(null);
                }}
              />
            </span>
            <button className="ws-btn ipo-form__go" type="submit" disabled={sending || creditFloor}>
              {sending ? 'Sending…' : 'Send to the committee'}
            </button>
          </div>
          <p className="ipo-form__err" id="addr-err" role="alert" hidden={!formError}>
            {formError}
          </p>
          <p className="ipo-form__help" id="addr-help">
            {creditFloor
              ? 'The committee is paused: the Nansen credit floor was reached. It reopens when credits are topped up.'
              : tries.length > 0
                ? 'Or send a recent one again: '
                : 'Up to 3 applications an hour per player.'}
            {creditFloor
              ? null
              : tries.map((a, i) => (
                  <span key={a.id}>
                    <button className="ws-link" type="button" onClick={() => setAddress(a.address)}>
                      {shortAddress(a.address)}
                    </button>
                    {i < tries.length - 1 ? ', ' : '.'}
                  </span>
                ))}
          </p>
        </form>
      </section>

      <div ref={roomRef}>
        <Committee
          states={states}
          checks={checks}
          app={allRevealed ? app : app ? { ...app, status: 'PENDING' } : null}
          animate={animate && !reduce}
          subtitle={
            app
              ? `${allRevealed ? 'on' : 'reviewing'} ${shortAddress(app.address)}`
              : 'waiting for an address'
          }
          progressText={progressText}
          onReplay={
            app
              ? () => {
                  setAnimate(true);
                  setReplay((n) => n + 1);
                }
              : undefined
          }
        />
      </div>
      <p className="ws-sr" aria-live="polite">
        {live}
        {checks
          ? checks
              .slice(0, reveal)
              .map((c, i) => `${MEMBERS[i]?.name}: ${SAY[c.status]}.`)
              .join(' ')
          : ''}
      </p>

      {app && checks && allRevealed ? (
        <VerdictSheet
          app={app}
          checks={checks}
          company={company}
          now={now}
          animate={animate && !reduce}
          onAgain={() => {
            setAddress('');
            document.getElementById('addr')?.focus();
          }}
        />
      ) : null}

      <VerdictWall apps={apps} now={now} current={app?.id ?? null} />

      <footer className="ipo-foot">
        <p>
          The committee only reads evidence. When evidence is missing it defers instead of guessing,
          and every check names the Nansen source behind it.
        </p>
        <span>
          Powered by <b>Nansen API</b>
        </span>
      </footer>
    </main>
  );
}
