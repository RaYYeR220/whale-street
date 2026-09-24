/**
 * One WebSocket to the engine per tab: hello with the player token, ref-counted channel
 * subscriptions, exponential reconnect with jitter, and a watchdog that treats a silent socket
 * (no market frame for WATCHDOG_MS) as dead. Every reconnect re-sends hello and every subscription.
 */
import type { Channel, ClientMessage, ServerMessage } from './api-types';

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string) => SocketLike;

export interface EngineSocketOptions {
  url: string;
  token?: () => string | null;
  createSocket?: SocketFactory;
  baseDelayMs?: number;
  maxDelayMs?: number;
  watchdogMs?: number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const BASE_DELAY_MS = 500;
export const MAX_DELAY_MS = 15_000;
export const WATCHDOG_MS = 10_000;
const OPEN = 1;

export class EngineSocket {
  private readonly o: Required<Omit<EngineSocketOptions, 'token'>> & {
    token: () => string | null;
  };
  private socket: SocketLike | null = null;
  private stateValue: ConnectionState = 'idle';
  private attempt = 0;
  private everOpened = false;
  private retryTimer: unknown = null;
  private watchdog: unknown = null;
  private readonly refs = new Map<Channel, number>();
  private readonly messageListeners = new Set<(m: ServerMessage) => void>();
  private readonly stateListeners = new Set<(s: ConnectionState) => void>();

  constructor(options: EngineSocketOptions) {
    this.o = {
      url: options.url,
      token: options.token ?? (() => null),
      createSocket: options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike),
      baseDelayMs: options.baseDelayMs ?? BASE_DELAY_MS,
      maxDelayMs: options.maxDelayMs ?? MAX_DELAY_MS,
      watchdogMs: options.watchdogMs ?? WATCHDOG_MS,
      random: options.random ?? Math.random,
      setTimer: options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
    };
  }

  get state(): ConnectionState {
    return this.stateValue;
  }

  start(): void {
    if (this.stateValue === 'connecting' || this.stateValue === 'open') return;
    this.connect();
  }

  stop(): void {
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onopen = s.onclose = s.onerror = s.onmessage = null;
      s.close();
    }
    this.setState('closed');
  }

  /** Adds one reference to each channel; returns the matching release function. */
  subscribe(channels: readonly Channel[]): () => void {
    const fresh: Channel[] = [];
    for (const ch of channels) {
      const n = this.refs.get(ch) ?? 0;
      this.refs.set(ch, n + 1);
      if (n === 0) fresh.push(ch);
    }
    if (fresh.length) this.send({ op: 'sub', channels: fresh });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const gone: Channel[] = [];
      for (const ch of channels) {
        const n = (this.refs.get(ch) ?? 0) - 1;
        if (n <= 0) {
          this.refs.delete(ch);
          gone.push(ch);
        } else this.refs.set(ch, n);
      }
      if (gone.length) this.send({ op: 'unsub', channels: gone });
    };
  }

  /** Re-announces the player (after the token changed) and re-subscribes the `player` channel. */
  rehello(): void {
    this.send(this.hello());
    if (this.refs.has('player')) {
      this.send({ op: 'unsub', channels: ['player'] });
      this.send({ op: 'sub', channels: ['player'] });
    }
  }

  onMessage(cb: (m: ServerMessage) => void): () => void {
    this.messageListeners.add(cb);
    return () => this.messageListeners.delete(cb);
  }

  onState(cb: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  channels(): Channel[] {
    return [...this.refs.keys()];
  }

  private hello(): ClientMessage {
    const token = this.o.token();
    return token ? { op: 'hello', token } : { op: 'hello' };
  }

  private send(msg: ClientMessage): void {
    const s = this.socket;
    if (s && s.readyState === OPEN) s.send(JSON.stringify(msg));
  }

  private setState(s: ConnectionState): void {
    if (this.stateValue === s) return;
    this.stateValue = s;
    for (const cb of this.stateListeners) cb(s);
  }

  private clearTimers(): void {
    if (this.retryTimer !== null) this.o.clearTimer(this.retryTimer);
    if (this.watchdog !== null) this.o.clearTimer(this.watchdog);
    this.retryTimer = null;
    this.watchdog = null;
  }

  private armWatchdog(): void {
    if (this.watchdog !== null) this.o.clearTimer(this.watchdog);
    this.watchdog = this.o.setTimer(() => {
      this.watchdog = null;
      this.drop();
    }, this.o.watchdogMs);
  }

  private connect(): void {
    this.clearTimers();
    this.setState(this.everOpened ? 'reconnecting' : 'connecting');
    let s: SocketLike;
    try {
      s = this.o.createSocket(this.o.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = s;
    s.onopen = () => {
      if (this.socket !== s) return;
      this.attempt = 0;
      this.everOpened = true;
      this.setState('open');
      s.send(JSON.stringify(this.hello()));
      const channels = this.channels();
      if (channels.length) s.send(JSON.stringify({ op: 'sub', channels }));
      this.armWatchdog();
    };
    s.onmessage = (ev) => {
      if (this.socket !== s) return;
      this.armWatchdog();
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') return;
      for (const cb of this.messageListeners) cb(msg);
    };
    s.onerror = () => {
      /* onclose follows and schedules the retry */
    };
    s.onclose = () => {
      if (this.socket !== s) return;
      this.socket = null;
      this.scheduleRetry();
    };
  }

  /** Closes the current socket (e.g. silent for too long) and reconnects with backoff. */
  private drop(): void {
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onopen = s.onclose = s.onerror = s.onmessage = null;
      try {
        s.close();
      } catch {
        /* already closed */
      }
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stateValue === 'closed') return;
    this.setState(this.everOpened ? 'reconnecting' : 'connecting');
    const exp = Math.min(this.o.maxDelayMs, this.o.baseDelayMs * 2 ** this.attempt);
    const delay = Math.round(exp * (0.5 + this.o.random() * 0.5));
    this.attempt += 1;
    if (this.watchdog !== null) this.o.clearTimer(this.watchdog);
    this.watchdog = null;
    this.retryTimer = this.o.setTimer(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }
}
