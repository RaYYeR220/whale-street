import { beforeEach, describe, expect, it } from 'vitest';
import { EngineSocket, LIMITED_DELAY_MS } from '../lib/ws-client';
import { FakeSocket, manualTimers } from './helpers';

function setup(token: string | null = 'tok') {
  FakeSocket.all = [];
  const timers = manualTimers();
  const tokenRef = { current: token };
  const states: string[] = [];
  const messages: unknown[] = [];
  const s = new EngineSocket({
    url: 'ws://engine.test/ws',
    token: () => tokenRef.current,
    createSocket: (url) => new FakeSocket(url),
    random: () => 1,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    watchdogMs: 10_000,
  });
  s.onState((st) => states.push(st));
  s.onMessage((m) => messages.push(m));
  const last = () => FakeSocket.all[FakeSocket.all.length - 1] as FakeSocket;
  return { s, timers, tokenRef, states, messages, last };
}

describe('EngineSocket', () => {
  beforeEach(() => {
    FakeSocket.all = [];
  });

  it('says hello with the token and subscribes to every channel on open', () => {
    const { s, last } = setup();
    s.subscribe(['market', 'filings']);
    s.start();
    last().open();
    expect(last().sent).toEqual([
      { op: 'hello', token: 'tok' },
      { op: 'sub', channels: ['market', 'filings'] },
    ]);
  });

  it('says hello without a token for an anonymous visitor', () => {
    const { s, last } = setup(null);
    s.start();
    last().open();
    expect(last().sent).toEqual([{ op: 'hello' }]);
  });

  it('ref-counts subscriptions: one sub for the first user, one unsub after the last', () => {
    const { s, last } = setup();
    s.start();
    last().open();
    const a = s.subscribe(['market']);
    const b = s.subscribe(['market', 'tape']);
    a();
    a();
    expect(last().sent.slice(1)).toEqual([
      { op: 'sub', channels: ['market'] },
      { op: 'sub', channels: ['tape'] },
    ]);
    b();
    expect(last().sent.slice(3)).toEqual([{ op: 'unsub', channels: ['market', 'tape'] }]);
    expect(s.channels()).toEqual([]);
  });

  it('delivers parsed server messages and drops malformed ones', () => {
    const { s, last, messages } = setup();
    s.start();
    last().open();
    last().receive({ t: 'status', status: { mode: 'replay' } });
    last().receive('not json');
    last().receive({ nope: true });
    expect(messages).toEqual([{ t: 'status', status: { mode: 'replay' } }]);
  });

  it('reconnects with exponential backoff and re-subscribes after a drop', () => {
    const { s, last, timers, states } = setup();
    s.subscribe(['market']);
    s.start();
    last().open();
    last().drop();
    expect(states).toEqual(['connecting', 'open', 'reconnecting']);
    expect(timers.delays()).toEqual([500]);
    timers.fire(500);
    last().drop();
    expect(timers.delays()).toEqual([1_000]);
    timers.fire(1_000);
    last().open();
    expect(last().sent).toEqual([
      { op: 'hello', token: 'tok' },
      { op: 'sub', channels: ['market'] },
    ]);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it('caps the backoff at 15 seconds', () => {
    const { s, last, timers } = setup();
    s.start();
    for (let i = 0; i < 10; i++) {
      last().drop();
      timers.fire();
    }
    last().drop();
    expect(timers.delays()).toEqual([15_000]);
  });

  it('backs off for long, and says so, when the engine closes for too many connections or messages', () => {
    const { s, last, timers, states } = setup();
    s.start();
    last().open();
    last().closeWith(1008, 'too many connections from this address');
    expect(states.at(-1)).toBe('limited');
    expect(timers.delays()).toEqual([LIMITED_DELAY_MS]);
    timers.fire(LIMITED_DELAY_MS);
    // Accepted, then closed at once again: a bare open does not count as healthy.
    last().open();
    last().closeWith(1008, 'too many connections from this address');
    expect(timers.delays()).toEqual([2 * LIMITED_DELAY_MS]);
    timers.fire(2 * LIMITED_DELAY_MS);
    last().open();
    last().receive({ t: 'status', status: {} });
    last().drop();
    expect(states.at(-1)).toBe('reconnecting');
    expect(timers.delays()).toEqual([500]);
  });

  it('never waits longer than two minutes after repeated limits', () => {
    const { s, last, timers } = setup();
    s.start();
    for (let i = 0; i < 6; i++) {
      last().closeWith(1008, 'too many messages');
      timers.fire();
    }
    last().closeWith(1008, 'too many messages');
    expect(timers.delays()).toEqual([120_000]);
  });

  it('treats a silent socket as dead after the watchdog period', () => {
    const { s, last, timers, states } = setup();
    s.start();
    const first = last();
    first.open();
    first.receive({ t: 'status', status: {} });
    timers.fire(10_000);
    expect(first.closed).toBe(true);
    expect(states.at(-1)).toBe('reconnecting');
    timers.fire(500);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('re-announces the player after the token changes', () => {
    const { s, last, tokenRef } = setup(null);
    s.subscribe(['player']);
    s.start();
    last().open();
    tokenRef.current = 'new';
    s.rehello();
    expect(last().sent.slice(2)).toEqual([
      { op: 'hello', token: 'new' },
      { op: 'unsub', channels: ['player'] },
      { op: 'sub', channels: ['player'] },
    ]);
  });

  it('stops for good: no reconnect after stop()', () => {
    const { s, last, timers, states } = setup();
    s.start();
    last().open();
    s.stop();
    expect(states.at(-1)).toBe('closed');
    expect(timers.delays()).toEqual([]);
  });
});
