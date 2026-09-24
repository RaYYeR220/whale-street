// @vitest-environment jsdom
/** The play-money trade ticket while the market is paused (engine idle, marks delayed, or booting). */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TradeTicket } from '../components/company/TradeTicket';
import { toDisplay } from '../lib/company';
import { TOKEN_KEY } from '../lib/player';
import { companyView, entry, json, portfolio, status, T0 } from './helpers';
import { testRuntime, Wrap } from './render';

const quote = (paused = false) => ({
  ok: true,
  ticker: 'OOH',
  side: 'BUY',
  qty: 9.09,
  cash: 1_000,
  avgPrice: 110,
  price: 110,
  priceAfter: 110.4,
  paused,
});
const filled = json({
  ok: true,
  fill: {
    ticker: 'OOH',
    side: 'BUY',
    qty: 9.09,
    cash: 1_000,
    avgPrice: 110,
    nav: 100,
    multiplierBefore: 1.1,
    multiplierAfter: 1.104,
    price: 110.4,
  },
  portfolio: portfolio(),
});
const paused = () =>
  json(
    {
      error: 'MARKET_PAUSED',
      message:
        'market paused while prices catch up (no live viewer or delayed marks); retry shortly',
      retryAfterMs: 40,
    },
    503,
  );

function ticket(o: { orders: Array<() => Response>; quotePaused?: boolean; idle?: boolean }) {
  const calls: string[] = [];
  const replies = [...o.orders];
  const routes = {
    'GET /api/me': () =>
      json({
        player: { id: 'p1', handle: 'Tester', kind: 'human', walletAddress: null, createdAt: 0 },
        portfolio: portfolio(),
        seasons: [],
      }),
    'GET /api/quote': () => json(quote(o.quotePaused)),
    'POST /api/orders': () => {
      calls.push('order');
      return (replies.shift() ?? paused)();
    },
  };
  const runtime = testRuntime(routes);
  runtime.store.setStatus(status({ idle: o.idle ?? false }), T0);
  const c = toDisplay(entry(), companyView({ ipoUntil: T0 - 1 }), undefined, T0);
  if (!c) throw new Error('no company');
  render(
    <Wrap runtime={runtime}>
      <TradeTicket c={c} now={T0} />
    </Wrap>,
  );
  return calls;
}

const buy = async () => {
  const go = await screen.findByRole('button', { name: /^Buy 9\.09 OOH$/ });
  fireEvent.click(go);
};

beforeEach(() => localStorage.setItem(TOKEN_KEY, 'tok'));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('trading while the market is paused', () => {
  it('says the market is waking up, retries once after the engine’s delay, and fills', async () => {
    const calls = ticket({ orders: [paused, () => filled], idle: true });
    await buy();
    expect(await screen.findByText('Market waking up…')).toBeTruthy();
    expect(await screen.findByText(/Bought 9\.09 OOH/)).toBeTruthy();
    expect(calls).toEqual(['order', 'order']);
  });

  it('says the market is opening after a boot, and shows the refusal if the retry is paused too', async () => {
    const calls = ticket({ orders: [paused, paused] });
    await buy();
    expect(await screen.findByText('Market opening…')).toBeTruthy();
    expect(await screen.findByText(/Not traded: OOH/)).toBeTruthy();
    expect(screen.getByText(/still paused/)).toBeTruthy();
    await act(async () => new Promise((r) => setTimeout(r, 100)));
    expect(calls).toEqual(['order', 'order']);
  });

  it('marks a quote taken while the market is paused', async () => {
    ticket({ orders: [() => filled], quotePaused: true });
    expect(await screen.findByText(/Market paused while prices catch up/)).toBeTruthy();
  });
});
