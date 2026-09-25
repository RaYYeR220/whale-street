# Reviewing Whale Street

A five-minute path through the product, and where to check each claim.

## 1. Open the site

Open https://whale-street-xi.vercel.app and choose **Enter the floor**.

The public site replays 40 minutes of a real session recorded from Nansen and Hyperliquid on 25 September 2026, 15:47 to 16:27 UTC, with 6 listed traders. Its badge says REPLAY and the loop number. The engine runs on a free server: if a page says it cannot reach the engine, wait a minute and reload.

## 2. A market of real traders

- Every tile on `/floor` is a real Hyperliquid address. Open one: the company header links to the address on the Hyperliquid explorer.
- Prices tick every second on Hyperliquid mark prices. The company chart draws NAV (the trader's real performance) and price (NAV × crowd hype) separately. Hype decays back toward NAV with a 6-hour time constant.
- Bot funds trade through the same exchange code as people and are labelled BOT. Their fills show on the tape.
- Buy or short a company with your 10,000 play dollars. The ticket quotes the price before you trade.

## 3. Every number traces back to a Nansen call

On a company page, click any small **N**. The evidence drawer lists the Nansen calls behind the page: endpoint, time, credits and a hash of the response, under "Powered by Nansen API". In REPLAY each call is marked "recorded" and its time is when it was recorded.

The same call log is public:

- `https://whale-street-engine.onrender.com/api/provenance` lists the latest calls.
- `https://whale-street-engine.onrender.com/api/provenance/<id>` shows one call: endpoint, status, credits, latency, time, request and response hashes.

Every filing carries the ids of the calls behind it.

## 4. The listing committee decides on evidence

At `/ipo`, paste a Hyperliquid address. The committee is deterministic code (`packages/core/src/committee.ts`), not a model.

Try `0xc179e03922afe8fa9533d3f896338b9fb87ce0c8`. The committee denied it in the recorded session (verdict `ipo_0812b3178fe0`, the one in the demo video): HUMAN_TRADER, "market-maker profile: 817 trades/day, ~1.8 min per trade". In REPLAY it is evaluated again from the recorded evidence and denied again for the same reason. If someone applied it in the last 7 days, the desk says the address was recently denied, and the verdict is on the wall of recent verdicts on the same page.

| # | Check | Rule | Evidence |
|---|---|---|---|
| 1 | Track record | first Hyperliquid perp fill at least 30 days ago, and at least 20 closing fills | `profiler/perp-trades` (oldest fills, spot fills dropped), `profiler/perp-pnl-summary` |
| 2 | Size | account value of at least $25,000 | `profiler/perp-positions` |
| 3 | Human trader | at most 500 trades a day, at least 5 minutes per trade on average, not a vault | `profiler/perp-pnl-summary`, the first fill from `profiler/perp-trades`, Hyperliquid `vaultDetails` |
| 4 | Hidden hedge | linked wallets hold the opposite side in the same coins for at least 50% of the applicant's notional | `profiler/address/related-wallets`, `profiler/address/first-funder`, `profiler/address/counterparties` (only when the first two link fewer than 2 wallets), then up to 10 linked wallets' Hyperliquid positions |
| 5 | Concentration | 60% or more of realized PnL from one trade lowers the rating two notches | `profiler/perp-trades` (top trades by realized PnL), `profiler/perp-pnl-summary` |
| 6 | Uniqueness | not already listed, not in a 14-day bankruptcy cooldown | engine state |

Any failed check means DENIED, and a denied address stays out for 7 days. Otherwise, a check that cannot be evaluated (a failed call, a missing field) means DEFERRED: nothing is listed on missing data. An applicant holding a HIP-3 market is also deferred. When every check passes, the company lists at NAV 100 with a rating from AAA to CCC.

In the LIVE session the scout listed 2 traders and the IPO desk listed 4 more, denied 2 (the market maker above, and one with 16 days of history and 0 closed trades) and deferred 1 that held a HIP-3 market. The hidden-hedge check has not fired on real data yet: 12 leaderboard traders run through it before the recording had 0% of their exposure offset by linked wallets.

## 5. Mirror places real orders, and refuses

The public engine runs REPLAY, so Mirror is off there. The real order below was placed during the recorded LIVE session, which ran on the author's machine:

- Wallet `0x481ef824EdF8D012095E2bc7365A61bc5eD96Aff`, HYPE LONG copied from `COV`: a $12 order at 2x on 2026-09-25 16:22 UTC, filled 0.13 HYPE at 90.875 ($11.81).
- Hyperliquid order id `556603464150`, fill `0x07672b2ee9f7b35208e004452ffe1e020bb9001484fad224ab2fd681a8fb8d3c`, builder fee 0.009451 USDC. The reduce-only stop-loss rested at 79.547 (order `556603464151`).
- The position was closed on Hyperliquid at 16:24 UTC at 91.15 (+$0.04 before fees).
- Explorer: https://app.hyperliquid.xyz/explorer/address/0x481ef824EdF8D012095E2bc7365A61bc5eD96Aff

Three minutes earlier the same wallet tried $12 on `HET`, and the policy refused it (`ANTI_FOMO`: "you'd enter 132.4% worse than the trader"). Both attempts are in the demo video.

Check it without trusting us:

```bash
curl -s https://api.hyperliquid.xyz/info -H 'content-type: application/json' \
  -d '{"type":"orderStatus","user":"0x481ef824EdF8D012095E2bc7365A61bc5eD96Aff","oid":556603464150}'
curl -s https://api.hyperliquid.xyz/info -H 'content-type: application/json' \
  -d '{"type":"userFills","user":"0x481ef824EdF8D012095E2bc7365A61bc5eD96Aff"}'
```

- The fill carries a builder fee: the order was built by the Nansen Trading API with Nansen's builder code.
- The policy (`packages/core/src/mirror.ts`) runs when the order is prepared, on a fresh Nansen snapshot, and again right before it is sent. The limits: $10 to $100 per order, 3 open mirrors and $300 per 24 hours per wallet, leverage at most the trader's and at most 5x, a stop-loss always attached, refused when the company's HP is under 15%, and refused when you would enter 5% or more worse than the trader ("that's how FOMO loses money").
- The engine checks the order Nansen prepared before anyone signs it: asset, side, size, price, a reduce-only market stop at the policy price, Nansen's builder, no vault.
- Non-custodial: the browser creates an agent key and keeps it. The wallet signs only Hyperliquid's approveAgent and, if needed, approveBuilderFee, and the browser sends those straight to Hyperliquid. The engine checks that every signature recovers to that agent before sending it to Nansen.
- Once a wallet is connected, the ticket offers "Use a different wallet" and "Disconnect". Linking another account replaces the old link, and that account needs its own agent approval.
- Every attempt, refused or sent, is stored with its reasons or its Hyperliquid result.

## 6. Where Nansen data drives the logic

| Decision | Code | Nansen data |
|---|---|---|
| NAV and halts | `packages/core/src/nav.ts`, `apps/engine/src/ingest/refresh.ts`, `apps/engine/src/market/loop.ts` | `profiler/perp-positions`, `profiler/perp-pnl-summary` |
| Filings, HP, bankruptcy | `packages/core/src/filings.ts`, `packages/core/src/hp.ts`, `apps/engine/src/services/bankruptcy.ts` | `profiler/perp-positions` |
| Committee and IPO desk | `packages/core/src/committee.ts`, `apps/engine/src/ingest/evidence.ts`, `apps/engine/src/services/ipo.ts` | profiler trades, PnL summary, positions, related wallets, first funder, counterparties |
| Scout | `apps/engine/src/ingest/scout.ts` | `perp-leaderboard`, `smart-money/perp-trades` (selection only) |
| Street mood, Cohort fund | `apps/engine/src/ingest/mood.ts`, `apps/engine/src/bots/strategies.ts` | `tgm/position-intelligence` |
| Mirror | `packages/core/src/mirror.ts`, `apps/engine/src/services/mirror.ts`, `apps/web/lib/mirror/` | `perp/meta`, `perp/builder-fee`, `perp/leverage`, `perp/order`, `perp/execute`, `profiler/perp-positions` |
| Credit budget | `apps/engine/src/ingest/credits.ts`, `idle.ts`, `scheduler.ts` | `account` and every response's balance header |
| Provenance | `packages/nansen/src/http.ts` → `nansen_calls` table → `/api/provenance` | every call |

## 7. Endpoints and their cost

Credits per call as Nansen reported them in the `x-nansen-credits-used` header.

| Endpoint | Credits | Used for | How often |
|---|---|---|---|
| `profiler/perp-positions` | 1 | snapshots, committee size check | 10 s after a trade by the address, every 12 min per company, per application, before every Mirror order |
| `profiler/perp-pnl-summary` | 1 | realized-PnL reconciliation, committee | at listing, every 12 min per company, per application |
| `profiler/perp-trades` | 1 (5 per minute) | first perp fill, top trade | 2 per application |
| `profiler/address/related-wallets` | 1 | hidden hedge | per application |
| `profiler/address/first-funder` | 1 | hidden hedge | per application |
| `profiler/address/counterparties` | 5 | hidden hedge | per application, only when fewer than 2 wallets are linked |
| `perp-leaderboard` | 5 | scout candidates, never displayed | every 3 hours while fewer than `TARGET_COMPANIES` are listed |
| `smart-money/perp-trades` | 5 | scout candidates, never displayed | same as above |
| `tgm/position-intelligence` | 1 | street mood, Cohort fund | every 15 min, up to 6 coins |
| `account` | 0 | credit monitor | every 10 min |
| `perp/meta`, `perp/builder-fee` | 0 | Mirror | meta cached for an hour, builder status per wallet for a minute |
| `perp/leverage`, `perp/order`, `perp/execute` | 0 | Mirror | 2 prepares and 2 executes per order |

The `account` and trading calls report no credit use. An IPO evaluation costs 6 credits, or 11 when counterparties are needed, plus 1 when the company lists. A listed company costs 2 credits every 12 minutes, plus 1 each time it trades (trades within 10 seconds share one snapshot). With nobody watching, the engine spends nothing.

This project's key made 253 Nansen API calls during the buildathon. The LIVE session behind the recording ran on the author's machine on 25 September 2026 from 15:02 to 16:27 UTC (with a one-minute restart at 16:13), made 181 Nansen calls and spent 178 credits of the balance in those 84 minutes. The public replay is its last 40 minutes.

## 8. Run it yourself

See [README → Run it locally](README.md#run-it-locally-in-under-10-minutes-no-keys): `pnpm install && pnpm dev`, no keys, REPLAY of the recorded session. The known limits are in [README → Honest limits](README.md#honest-limits).
