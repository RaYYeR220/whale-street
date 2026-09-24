'use client';

import { useEffect, useState } from 'react';
import type { NansenCallView } from '../../lib/api-types';
import { agoLong, hhmm } from '../../lib/format';
import { useApi, useEngine, useEngineNow } from '../providers/engine';

const MAX_CALLS = 12;

type Loaded =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; calls: NansenCallView[]; snapshotAt: number | null };

const time = (t: number) => {
  const d = new Date(t);
  return `${hhmm(t)}:${String(d.getSeconds()).padStart(2, '0')}`;
};

/** Every Nansen call behind the numbers on screen: endpoint, time, credits and response hash. */
export function EvidenceDrawer({
  ticker,
  provenance,
}: {
  ticker?: string;
  provenance?: readonly string[];
}) {
  const api = useApi();
  const status = useEngine((s) => s.status);
  const now = useEngineNow();
  const [data, setData] = useState<Loaded>({ state: 'loading' });
  const idsKey = provenance?.join(',') ?? '';

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let ids = idsKey ? idsKey.split(',') : [];
      let snapshotAt: number | null = null;
      if (ticker) {
        const c = await api.company(ticker);
        if (!c.ok) {
          if (!cancelled) setData({ state: 'error', message: c.message });
          return;
        }
        snapshotAt = c.data.company.lastSnapshotAt;
        if (ids.length === 0) ids = [...c.data.company.provenance];
      }
      if (ids.length === 0) {
        const recent = await api.provenance(MAX_CALLS);
        if (cancelled) return;
        if (!recent.ok) setData({ state: 'error', message: recent.message });
        else setData({ state: 'ready', calls: recent.data.calls, snapshotAt });
        return;
      }
      const results = await Promise.all(
        ids.slice(0, MAX_CALLS).map((id) => api.provenanceCall(id)),
      );
      if (cancelled) return;
      const calls = results.flatMap((r) => (r.ok ? [r.data.call] : []));
      setData({ state: 'ready', calls, snapshotAt });
    })();
    return () => {
      cancelled = true;
    };
  }, [api, ticker, idsKey]);

  if (data.state === 'loading') return <p role="status">Loading the Nansen calls…</p>;
  if (data.state === 'error')
    return (
      <p role="alert" className="ws-v-red">
        Could not load the evidence: {data.message}
      </p>
    );
  const age = data.snapshotAt !== null && now !== null ? now - data.snapshotAt : null;
  const credits = data.calls.reduce((s, c) => s + (c.credits ?? 0), 0);
  return (
    <>
      <p style={{ margin: 0, fontSize: 'var(--ws-fs-16)' }}>
        {ticker
          ? `Every number on ${ticker}'s page comes from these Nansen calls.`
          : 'The latest Nansen calls the engine made.'}{' '}
        Each one is logged with its time, cost and a hash of the response.
      </p>
      {ticker ? (
        <div className="ws-panel ws-panel--flat ws-panel--thin ws-panel--paper co-ev-snap">
          <span>Current snapshot</span>
          <b>{age === null ? 'Age unknown' : `Taken ${agoLong(age)}`}</b>
          <span>Mirror only copies positions seen in the last 60 seconds.</span>
        </div>
      ) : null}
      {data.calls.length === 0 ? (
        <p>
          No Nansen call is recorded for this yet
          {status?.mode === 'replay' ? ' (the recorded session keeps no call log).' : '.'}
        </p>
      ) : (
        <ul className="co-ev">
          {data.calls.map((c) => {
            const failed = c.error !== null || (c.status !== null && c.status >= 400);
            return (
              <li key={c.id} className="ws-panel ws-panel--flat ws-panel--thin">
                <b>
                  {c.method} {c.path}
                </b>
                {failed ? (
                  <span className="ws-v-red" style={{ fontWeight: 700 }}>
                    {c.error ?? `HTTP ${c.status}`}
                    {c.attempts > 1 ? `, after ${c.attempts} tries` : ''}
                  </span>
                ) : null}
                <span className="row">
                  <span>{time(c.at)}</span>
                  <span>
                    {c.credits ?? 0} credit{c.credits === 1 ? '' : 's'}
                  </span>
                  <span>{c.responseHash ? `${c.responseHash.slice(0, 10)}…` : 'no hash'}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p style={{ margin: 0, color: 'var(--ws-text-2)', fontSize: 'var(--ws-fs-13)' }}>
        Powered by Nansen API. {credits} credit{credits === 1 ? '' : 's'} for the calls above
        {status?.creditsRemaining != null
          ? `; ${status.creditsRemaining.toLocaleString('en-US')} left on the account.`
          : '.'}
      </p>
    </>
  );
}
