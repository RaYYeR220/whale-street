import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { createPlayersService } from '../src/services/players';
import { testRepos } from './helpers/db';
import { FakeClock } from './helpers/fake-clock';
import { siweMessage, WEB_ORIGIN } from './helpers/siwe';

function setup() {
  const repos = testRepos();
  const clock = new FakeClock();
  return { repos, clock, players: createPlayersService({ repos, clock, origins: [WEB_ORIGIN] }) };
}

describe('players', () => {
  it('creates anonymous humans with a handle and a bearer token stored only as a hash', () => {
    const { repos, players } = setup();
    const { player, token } = players.create('human');
    expect(player.handle).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ #\d{3}$/);
    expect(player.kind).toBe('human');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const row = repos.players.get(player.id);
    expect(row?.tokenHash).not.toBe(token);
    expect(players.auth(token)?.id).toBe(player.id);
    expect(players.auth('wrong-token-wrong-token')).toBeNull();
    expect(players.auth(undefined)).toBeNull();
  });

  it('creates agents from a sanitized name and bots idempotently (bots cannot authenticate)', () => {
    const { players } = setup();
    expect(players.create('agent', 'Alpha<script>Bot').player.handle).toMatch(
      /^AlphascriptBot #\d{3}$/,
    );
    const bot = players.ensureBot('bot-value', 'Value Fund');
    expect(players.ensureBot('bot-value', 'Value Fund')).toEqual(bot);
    expect(bot.kind).toBe('bot');
    expect(players.auth('bot:bot-value')).toBeNull();
  });

  it('links a wallet with a SIWE message bound to the web origin and a one-time nonce', async () => {
    const { players, clock } = setup();
    const { player } = players.create('human');
    const account = privateKeyToAccount(generatePrivateKey());
    const nonce = players.nonce(player.id);
    const message = siweMessage(account.address, nonce, clock.now());
    const signature = await account.signMessage({ message });
    const r = await players.link(player.id, message, signature);
    expect(r).toMatchObject({ ok: true, player: { walletAddress: account.address.toLowerCase() } });
    // Replaying the same signed message: its nonce is spent.
    expect(await players.link(player.id, message, signature)).toMatchObject({
      ok: false,
      code: 'NO_NONCE',
    });
  });

  it('drops the mirror agent key when a different wallet is linked (re-linking the same keeps it)', async () => {
    const { repos, players, clock } = setup();
    const { player } = players.create('human');
    const a = privateKeyToAccount(generatePrivateKey());
    const b = privateKeyToAccount(generatePrivateKey());
    const link = async (account: typeof a) => {
      const message = siweMessage(account.address, players.nonce(player.id), clock.now());
      return players.link(player.id, message, await account.signMessage({ message }));
    };
    expect(await link(a)).toMatchObject({ ok: true });
    repos.agentKeys.upsert({
      playerId: player.id,
      masterAddress: a.address.toLowerCase(),
      agentAddress: '0x00000000000000000000000000000000000000ee',
      registeredAt: clock.now(),
    });
    expect(await link(a)).toMatchObject({ ok: true });
    expect(repos.agentKeys.get(player.id)).toBeDefined();
    expect(await link(b)).toMatchObject({ ok: true });
    expect(repos.agentKeys.get(player.id)).toBeUndefined();
  });

  it('refuses each broken SIWE condition with its own code (and spends the nonce)', async () => {
    const { players, clock } = setup();
    const { player } = players.create('human');
    const wallet = privateKeyToAccount(generatePrivateKey());
    const attacker = privateKeyToAccount(generatePrivateKey());
    const attempt = async (
      over: Parameters<typeof siweMessage>[3] = {},
      signer = wallet,
      nonce = players.nonce(player.id),
    ) => {
      const message = siweMessage(wallet.address, nonce, clock.now(), over);
      return players.link(player.id, message, await signer.signMessage({ message }));
    };
    const code = async (p: Promise<unknown>) => ((await p) as { code?: string }).code;

    expect(await code(attempt({ domain: 'evil.example' }))).toBe('DOMAIN_MISMATCH');
    expect(await code(attempt({ uri: 'https://evil.example/login' }))).toBe('DOMAIN_MISMATCH');
    expect(await code(attempt({ scheme: 'https' }))).toBe('DOMAIN_MISMATCH');
    const old = players.nonce(player.id);
    players.nonce(player.id); // a fresh nonce replaces the old one
    expect(await code(attempt({}, wallet, old))).toBe('NONCE_MISMATCH');
    expect(await code(attempt({ issuedAt: new Date(clock.now() - 11 * 60_000) }))).toBe(
      'MESSAGE_EXPIRED',
    );
    expect(await code(attempt({ expirationTime: new Date(clock.now() - 1) }))).toBe(
      'MESSAGE_EXPIRED',
    );
    expect(await code(attempt({ issuedAt: new Date(clock.now() + 5 * 60_000) }))).toBe(
      'MESSAGE_NOT_YET_VALID',
    );
    expect(await code(attempt({ notBefore: new Date(clock.now() + 60_000) }))).toBe(
      'MESSAGE_NOT_YET_VALID',
    );
    expect(await code(attempt({}, attacker))).toBe('BAD_SIGNATURE');

    // Every attempt above spent its nonce; a used nonce and an expired one are both gone.
    const n = players.nonce(player.id);
    expect(await attempt({}, wallet, n)).toMatchObject({ ok: true });
    expect(await code(attempt({}, wallet, n))).toBe('NO_NONCE');
    const late = players.nonce(player.id);
    clock.advance(11 * 60_000);
    expect(await code(attempt({}, wallet, late))).toBe('NO_NONCE');
  });

  it('accepts only a canonical EIP-4361 message (400-class INVALID_MESSAGE, nonce kept)', async () => {
    const { players, clock } = setup();
    const { player } = players.create('human');
    const wallet = privateKeyToAccount(generatePrivateKey());
    const nonce = players.nonce(player.id);
    const legacy = `Whale Street: link wallet ${wallet.address.toLowerCase()} nonce ${nonce}`;
    expect(
      await players.link(player.id, legacy, await wallet.signMessage({ message: legacy })),
    ).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
    // Same fields, non-canonical text (lowercase address): wallets would not render it as SIWE.
    const good = siweMessage(wallet.address, nonce, clock.now());
    const lower = good.replace(wallet.address, wallet.address.toLowerCase());
    expect(
      await players.link(player.id, lower, await wallet.signMessage({ message: lower })),
    ).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
    // The nonce survived both: the canonical message still links.
    expect(
      await players.link(player.id, good, await wallet.signMessage({ message: good })),
    ).toMatchObject({ ok: true });
  });
});
