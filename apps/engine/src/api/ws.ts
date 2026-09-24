import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { Engine } from '../engine';
import { type Channel, ClientMessage, type MoodEntry, type ServerMessage } from './protocol';

export const LEADERBOARD_EVERY_MS = 10_000;
export const PING_EVERY_MS = 25_000;
/** Slow consumers are skipped (not buffered without bound). */
export const MAX_BUFFERED_BYTES = 1_000_000;
/** Client messages per connection per second; one more closes the socket (1008). */
export const MAX_MESSAGES_PER_SECOND = 20;
/**
 * Open connections per client IP, sized for a room sharing one address (venue Wi-Fi, office NAT);
 * a further one is closed at once (1008).
 */
export const MAX_CONNECTIONS_PER_IP = 30;
/** The leaderboard frame is computed at most this often and shared by every subscriber. */
export const LEADERBOARD_CACHE_MS = 1_000;
/** WebSocket close code 'policy violation'. */
const POLICY_VIOLATION = 1008;

interface Client {
  socket: WebSocket;
  channels: Set<Channel>;
  playerId: string | null;
  alive: boolean;
  /** Wall-clock start of the current one-second message window, and messages seen in it. */
  windowAt: number;
  messages: number;
}

export function registerWs(app: FastifyInstance, e: Engine): void {
  const clients = new Set<Client>();
  const perIp = new Map<string, number>();

  const sendRaw = (c: Client, frame: string) => {
    if (c.socket.readyState === 1 && c.socket.bufferedAmount < MAX_BUFFERED_BYTES)
      c.socket.send(frame);
  };
  const send = (c: Client, msg: ServerMessage) => sendRaw(c, JSON.stringify(msg));
  const broadcast = (channel: Channel, msg: ServerMessage) => {
    let frame: string | null = null;
    for (const c of clients) {
      if (!c.channels.has(channel)) continue;
      frame ??= JSON.stringify(msg);
      sendRaw(c, frame);
    }
  };
  const subscribed = (channel: Channel) => [...clients].some((c) => c.channels.has(channel));

  const mood = (): MoodEntry[] =>
    [...e.state.mood].map(([coin, m]) => ({
      coin,
      smartSkew: m.smartSkew,
      whaleSkew: m.whaleSkew,
      asOf: m.asOf,
    }));
  const market = (at: number): ServerMessage => ({
    t: 'market',
    at,
    mode: e.config.mode,
    companies: e.state.marketEntries(),
    mood: mood(),
  });
  // Wall time, like the broadcast throttle below (the REPLAY clock jumps back at a wrap).
  let leaderboardCache: { at: number; frame: string } | null = null;
  const leaderboardFrame = (): string => {
    const wall = e.wallNow();
    if (leaderboardCache && wall - leaderboardCache.at < LEADERBOARD_CACHE_MS)
      return leaderboardCache.frame;
    const msg: ServerMessage = { t: 'leaderboard', rows: e.exchange.leaderboard(50) };
    leaderboardCache = { at: wall, frame: JSON.stringify(msg) };
    return leaderboardCache.frame;
  };
  const status = (): ServerMessage => ({ t: 'status', status: e.status() });

  let lastLeaderboard = Number.NEGATIVE_INFINITY;
  const off = e.bus.on((ev) => {
    switch (ev.t) {
      case 'market': {
        broadcast('market', market(ev.at));
        // Throttled on wall time: the REPLAY clock jumps back at a loop wrap, which would stall
        // an engine-clock throttle for a whole loop.
        const wall = e.wallNow();
        if (wall - lastLeaderboard >= LEADERBOARD_EVERY_MS && subscribed('leaderboard')) {
          lastLeaderboard = wall;
          const frame = leaderboardFrame();
          for (const c of clients) if (c.channels.has('leaderboard')) sendRaw(c, frame);
        }
        break;
      }
      case 'filing':
        broadcast('filings', { t: 'filing', filing: ev.filing });
        break;
      case 'tape':
        broadcast('tape', { t: 'tape', trade: ev.trade });
        break;
      case 'ipo':
        broadcast('ipo', { t: 'ipo', update: ev.update });
        break;
      case 'player':
        for (const c of clients) {
          if (c.playerId === ev.playerId && c.channels.has('player')) {
            send(c, { t: 'player', portfolio: e.exchange.portfolio(ev.playerId) });
          }
        }
        break;
      case 'status':
        broadcast('status', status());
        break;
    }
  });

  const pinger = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.socket.terminate();
        continue;
      }
      c.alive = false;
      c.socket.ping();
    }
  }, PING_EVERY_MS);
  pinger.unref();

  app.addHook('onClose', async () => {
    off();
    clearInterval(pinger);
    for (const c of clients) c.socket.close();
  });

  app.get('/ws', { websocket: true }, (socket, req) => {
    const ip = req.ip;
    const open = perIp.get(ip) ?? 0;
    if (open >= MAX_CONNECTIONS_PER_IP) {
      socket.close(POLICY_VIOLATION, 'too many connections from this address');
      return;
    }
    perIp.set(ip, open + 1);
    const c: Client = {
      socket,
      channels: new Set(),
      playerId: null,
      alive: true,
      windowAt: e.wallNow(),
      messages: 0,
    };
    clients.add(c);
    e.idle.clientConnected(e.clock.now());

    socket.on('pong', () => {
      c.alive = true;
    });
    socket.on('close', () => {
      clients.delete(c);
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left > 0) perIp.set(ip, left);
      else perIp.delete(ip);
      e.idle.clientDisconnected(e.clock.now());
    });
    socket.on('message', (raw) => {
      c.alive = true;
      const wall = e.wallNow();
      if (wall - c.windowAt >= 1_000) {
        c.windowAt = wall;
        c.messages = 0;
      }
      if (++c.messages > MAX_MESSAGES_PER_SECOND) {
        socket.close(POLICY_VIOLATION, 'too many messages');
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(String(raw));
      } catch {
        send(c, { t: 'error', error: 'BAD_MESSAGE', message: 'invalid JSON' });
        return;
      }
      const parsed = ClientMessage.safeParse(json);
      if (!parsed.success) {
        send(c, {
          t: 'error',
          error: 'BAD_MESSAGE',
          message: 'expected {op:"hello"|"sub"|"unsub"}',
        });
        return;
      }
      const msg = parsed.data;
      if (msg.op === 'hello') {
        const player = msg.token ? e.players.auth(msg.token) : null;
        c.playerId = player?.id ?? null;
        send(c, { t: 'hello', player });
        send(c, status());
        return;
      }
      if (msg.op === 'unsub') {
        for (const ch of msg.channels) c.channels.delete(ch);
        return;
      }
      for (const ch of msg.channels) {
        if (c.channels.has(ch)) continue;
        c.channels.add(ch);
        if (ch === 'market') send(c, market(e.clock.now()));
        if (ch === 'status') send(c, status());
        if (ch === 'leaderboard') sendRaw(c, leaderboardFrame());
        if (ch === 'player' && c.playerId)
          send(c, { t: 'player', portfolio: e.exchange.portfolio(c.playerId) });
      }
    });
  });
}
