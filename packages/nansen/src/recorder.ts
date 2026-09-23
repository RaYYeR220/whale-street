import { stableStringify } from './stable';

export interface NansenRecord {
  t: number;
  k: 'nansen';
  key: string;
  path: string;
  status: number;
  body: unknown;
}

export const VOLATILE_FIELDS: ReadonlySet<string> = new Set([
  'date',
  'date_range',
  'to_date',
  'from_date',
  'as_of_ts',
  'as_of_date',
  'lookback_hours',
]);

function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (v === null || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!VOLATILE_FIELDS.has(k)) out[k] = strip(x);
  }
  return out;
}

export function requestKey(method: string, url: string, body: string | undefined): string {
  const u = new URL(url);
  let b = '';
  if (body !== undefined && body !== '') {
    try {
      b = stableStringify(strip(JSON.parse(body)));
    } catch {
      b = body;
    }
  }
  return `${method.toUpperCase()} ${u.pathname}${u.search} ${b}`.trimEnd();
}

function describeRequest(
  input: string | URL | Request,
  init?: RequestInit,
): { method: string; url: string; body: string | undefined } {
  const url = input instanceof Request ? input.url : String(input);
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  const body = typeof init?.body === 'string' ? init.body : undefined;
  return { method, url, body };
}

export function recordingFetch(
  inner: typeof fetch,
  sink: (r: NansenRecord) => void,
  now: () => number,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const d = describeRequest(input, init);
    const res = await inner(input, init);
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    sink({
      t: now(),
      k: 'nansen',
      key: requestKey(d.method, d.url, d.body),
      path: new URL(d.url).pathname,
      status: res.status,
      body,
    });
    return new Response(text, { status: res.status, headers: res.headers });
  }) as typeof fetch;
}

export function replayFetch(records: readonly NansenRecord[], now: () => number): typeof fetch {
  const byKey = new Map<string, NansenRecord[]>();
  for (const r of records) {
    const list = byKey.get(r.key) ?? [];
    list.push(r);
    byKey.set(r.key, list);
  }
  for (const list of byKey.values()) list.sort((a, b) => a.t - b.t);

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const d = describeRequest(input, init);
    const list = byKey.get(requestKey(d.method, d.url, d.body));
    if (!list || list.length === 0) {
      return new Response(JSON.stringify({ error: 'not in recording' }), { status: 503 });
    }
    const t = now();
    let pick = list[0] as NansenRecord;
    for (const r of list) if (r.t <= t) pick = r;
    return new Response(JSON.stringify(pick.body), {
      status: pick.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}
