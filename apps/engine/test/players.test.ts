import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { createPlayersService, linkMessage } from '../src/services/players';
import { testRepos } from './helpers/db';
import { FakeClock } from './helpers/fake-clock';

function setup() {
  const repos = testRepos();
  const clock = new FakeClock();
  return { repos, clock, players: createPlayersService({ repos, clock }) };
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

  it('links a wallet with a one-time nonce and a personal_sign signature', async () => {
    const { players } = setup();
    const { player } = players.create('human');
    const account = privateKeyToAccount(generatePrivateKey());
    const nonce = players.nonce(player.id);
    const signature = await account.signMessage({ message: linkMessage(account.address, nonce) });
    const r = await players.link(player.id, account.address, signature);
    expect(r).toMatchObject({ ok: true, player: { walletAddress: account.address.toLowerCase() } });
    expect(await players.link(player.id, account.address, signature)).toMatchObject({
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
      const nonce = players.nonce(player.id);
      const sig = await account.signMessage({ message: linkMessage(account.address, nonce) });
      return players.link(player.id, account.address, sig);
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

  it('rejects signatures from another key, expired nonces and bad addresses', async () => {
    const { players, clock } = setup();
    const { player } = players.create('human');
    const wallet = privateKeyToAccount(generatePrivateKey());
    const attacker = privateKeyToAccount(generatePrivateKey());
    const nonce = players.nonce(player.id);
    const forged = await attacker.signMessage({ message: linkMessage(wallet.address, nonce) });
    expect(await players.link(player.id, wallet.address, forged)).toMatchObject({
      ok: false,
      code: 'BAD_SIGNATURE',
    });
    const n2 = players.nonce(player.id);
    clock.advance(11 * 60_000);
    const late = await wallet.signMessage({ message: linkMessage(wallet.address, n2) });
    expect(await players.link(player.id, wallet.address, late)).toMatchObject({
      ok: false,
      code: 'NO_NONCE',
    });
    expect(await players.link(player.id, 'nope', late)).toMatchObject({
      ok: false,
      code: 'INVALID_ADDRESS',
    });
  });
});
