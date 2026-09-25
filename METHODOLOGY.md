# How Whale Street works

The numbers on the site, how they are computed, and what the engine does when data is missing. Tunable values live in `packages/core/src/params.ts`. The engine's schedules live in `apps/engine/src/ingest/`.

## 1. Snapshots

A snapshot of a trader comes from Nansen `profiler/perp-positions`, which serves Hyperliquid's clearinghouse state. For each open position it gives the coin, signed size, entry price, liquidation price (often empty), leverage, margin used and unrealized PnL. For the account it gives the account value E. The endpoint has no mark price. Marks come from Hyperliquid's `allMids` feed.

In a side-by-side read on 24 September 2026, Nansen's positions matched Hyperliquid's own `clearinghouseState` on the default dex exactly, 0.6 to 0.7 seconds behind it. One difference: Nansen lists positions on every Hyperliquid dex, while its account value covers the default dex only (see HIP-3 in the README's honest limits).

A snapshot must pass sanity checks: every size finite and non-zero, every price positive, liquidation price empty or positive, leverage positive, margin not negative, one row per coin, a finite account value. Rows of exactly zero size are closed coins and are dropped. A snapshot that fails is rejected and the previous one stays.

A company's snapshot is refreshed when:

- the address trades on Hyperliquid. The engine watches the per-coin `trades` feed for the coins listed companies hold; every trade names both sides. The refresh runs 10 seconds after the first trade seen, so a burst of fills costs one snapshot;
- its heartbeat comes due, every 12 minutes, staggered across companies;
- the engine wakes from idle (see section 9);
- someone prepares a Mirror order on it.

## 2. NAV: a flow-neutral performance index

NAV starts at 100 when a trader is listed.

- U(t) = Σ size × (mark(t) − entry), over the latest snapshot's positions
- C(t) = R + U(t), where R is realized PnL since listing
- E(t) = E_snap + (U(t) − U_snap)
- NAV(t) = NAV(t−1) × (1 + (C(t) − C(t−1)) / E(t−1)), every second

Deposits and withdrawals change E but not C, so they never move NAV. When a new snapshot arrives, its positions, R and E_snap replace the old ones, and the change in C is applied as one step. NAV never goes below 0.

Realized PnL. When a new snapshot shows a position closed or reduced, the engine books the realized part at once: closed size × (mark − entry). This is provisional and leaves out fees. On each heartbeat the engine reads realized PnL minus fees from Nansen `profiler/perp-pnl-summary`, from the listing day to today, and subtracts what that figure already held on the listing day. If the result differs from the booked value by more than max($50, 0.5% of equity), a RESTATEMENT filing records the correction and R takes the Nansen value. The LIVE session filed no RESTATEMENT, and neither does its replay.

Guards. The company halts with the reason on screen, and resumes by itself:

| Condition | What happens | Resumes when |
|---|---|---|
| equity under $1,000 | HALT | equity recovers |
| a triggered refresh unresolved after 120 s | HALT | the next good snapshot |
| no successful snapshot for 30 minutes (not counted while idle) | HALT | the next good snapshot |
| a held coin with no mark for 60 s (for example a HIP-3 market) | HALT | the mark returns |
| all marks older than 10 s | NAV freezes, never extrapolated; orders pause; "marks delayed" on screen | marks return |

## 3. Price: NAV times hype

Each company has a constant-product pool of virtual reserves: X shares and Y hype units, both starting at 5,000. The hype multiplier μ = Y / X starts at 1.

- Price P = NAV × μ.
- Buying q shares: X' = X − q (X' must stay at least 5% of the start), Y' = k / X', cost = NAV × (Y' − Y) × 1.003.
- Selling q shares: X' = X + q, Y' = k / X', proceeds = NAV × (Y − Y') × 0.997.
- Shorting sells into the pool. The proceeds plus the same amount of your cash are locked as collateral. Covering buys back from that collateral. A short is covered automatically when buying it back would cost 95% of its collateral; if a forced cover costs more than the collateral, the rest is written off, not taken from your cash.
- Hype decays toward 1 with a 6-hour time constant: μ ← 1 + (μ − 1) × e^(−Δt / 6 h). That pulls the price back to NAV.
- You cannot hold a long and a short in the same company. A BUY can be sized by cash instead of shares.
- For the first 60 seconds after a listing, one player can spend at most $1,000 on it (10% of season cash).
- While NAV is frozen (idle, marks delayed, or just after waking) orders are refused with `MARKET_PAUSED` and a retry time. Quotes still answer, marked as indicative.

Net worth = cash + longs × P + (short collateral − shorts × P, never below 0). Seasons last 7 days. At season end every holding settles at P, the ranks are archived and everyone starts again with 10,000 play dollars.

The exchange is the counterparty to NAV moves. Play money is not conserved, but every cash movement, including settlements and write-offs, is a row in the ledger.

## 4. Filings

From consecutive snapshots: OPEN, ADD, REDUCE, CLOSE (with its realized PnL, shown as a close for a profit or at a loss), FLIP, LIQUIDATION and BANKRUPTCY. From the engine: MARGIN_CALL (HP falls below 10%), RESTATEMENT, HALT, RESUME, IPO and DELISTING.

An OPEN or CLOSE worth less than $1 is dust and files nothing. Each filing carries the ids of the Nansen calls behind it and a link to the address on the Hyperliquid explorer.

## 5. HP and bankruptcy

HP of one position is the share of the distance from entry to liquidation price that is still left at the current mark: (mark − liquidation) / (entry − liquidation) for a long, mirrored for a short, clamped to [0, 1]. A position with no liquidation price counts as 1. A company's HP is the lowest over its positions, 1 when flat, and shows as critical under 15%.

A company goes bankrupt when a new snapshot shows a position reduced or gone while the mark is at or beyond its liquidation price (a LIQUIDATION filing), and the account value after it is under 20% of the value before. NAV has already taken the real loss. Then, in one database transaction: trading stops, every long and short settles at NAV (hype forced to 1), the company is delisted and a 14-day cooldown starts. If that transaction fails, the company halts with "settlement pending" and the next refresh retries.

## 6. The listing committee

Deterministic code: `packages/core/src/committee.ts`. The evidence comes from Nansen, plus Hyperliquid for the vault lookup and linked wallets' positions (`apps/engine/src/ingest/evidence.ts`).

| # | Check | Rule | Result |
|---|---|---|---|
| 1 | Track record | first Hyperliquid perp fill (spot fills dropped, within the last year) at least 30 days ago, and at least 20 closing fills (Nansen `closed_trade_count`) | FAIL → DENIED |
| 2 | Size | account value at least $25,000 | FAIL → DENIED |
| 3 | Human trader | at most 500 trades a day (Nansen `traded_times` over the history), at least 5 minutes per trade on average, and not a Hyperliquid vault | FAIL → DENIED ("market-maker profile") |
| 4 | Hidden hedge | linked wallets' opposite-side notional in the same coins covers at least 50% of the applicant's notional | FAIL → DENIED, with the links shown |
| 5 | Concentration | the top realized trade is 60% or more of realized PnL | FLAG → rating −2 notches |
| 6 | Uniqueness | not listed, not in a bankruptcy cooldown | FAIL → DENIED |

Average time per trade = history in minutes / the smaller of closing fills and trades, because one trade often closes over many fills. Linked wallets are the applicant's Nansen related wallets (on Arbitrum) and first funder, plus up to 5 top counterparties over 90 days when those two link fewer than 2 wallets. At most 10 linked wallets are read, each through Hyperliquid's `clearinghouseState`. Coverage is counted per coin, capped at the applicant's notional in that coin.

Any FAIL means DENIED. Otherwise any check that cannot be evaluated (a failed call, a missing field) means DEFERRED. An address holding a HIP-3 market is deferred before the rest of the evidence is fetched. A denied address stays out for 7 days, for the scout and the IPO desk alike.

Rating: score = 30 × win rate + 20 × min(1, history days / 180) + 20 × min(1, log10(1 + realized PnL / $10,000) / 2) + leverage points (average leverage ≤ 3x: 15, ≤ 10x: 10, ≤ 25x: 5) + equity points (≥ $1M: 15, ≥ $250k: 10, ≥ $25k: 5). AAA ≥ 85, AA ≥ 75, A ≥ 65, BBB ≥ 55, BB ≥ 45, B ≥ 35, otherwise CCC. Average leverage is weighted by notional.

The prospectus shows the style (average time per trade: Scalper under an hour, Day Trader under a day, Swing Trader under a week, otherwise Position Trader), history, win rate, a realized-PnL band, average leverage, favourite coins and the number of linked wallets.

The scout runs every 3 hours while fewer than `TARGET_COMPANIES` are listed. Candidates come from the Nansen perp leaderboard (top 100 by PnL over 30 days, account value at least $25,000) and smart-money perp trades (new positions in the last 24 hours). Leaderboard rows that show a HIP-3 position are dropped before any evidence call. At most 5 candidates are evaluated per run, by the same committee. The candidate lists live only in memory for the run: they are never stored, logged or served.

## 7. Mirror

Policy (`packages/core/src/mirror.ts`), checked when the order is prepared and again right before it is sent. Any doubt refuses, and every refusal names its reason:

- the company is ACTIVE and its snapshot is at most 60 seconds old. The engine fetches a fresh Nansen snapshot at prepare time;
- the trader holds the coin, the Nansen Trading API lists it, and a live mark (at most 10 seconds old) exists;
- $10 to $100 per order; the size is rounded down to the coin's lot and must stay at $10 or more;
- at most 3 open mirrors and $300 per 24 hours per wallet. An attempt whose outcome is unknown counts as placed;
- leverage at most the trader's and at most 5x;
- a stop-loss is always attached: by default at a loss of 25% of the order's margin, never looser than 50%;
- refused when the company's HP is under 15%;
- anti-FOMO: refused when the mark is 5% or more worse than the trader's entry, in the trader's direction;
- refused at the credit floor, since the fresh snapshot cannot be fetched.

Signing, without custody:

1. You connect a wallet and link it to your player with Sign-In with Ethereum. The ticket can switch accounts ("Use a different wallet") or disconnect; linking another account replaces the old link.
2. The browser creates an agent key and keeps it in IndexedDB. It never leaves the browser.
3. Your wallet signs two Hyperliquid actions, and the browser sends them straight to Hyperliquid. `approveAgent` names the agent ("whalestreet valid_until …", valid up to 180 days), so your own Hyperliquid session keeps its agent. `approveBuilderFee` approves Nansen's builder for at most 0.08%, only if Nansen reports it is not approved yet.
4. For each order the engine asks Nansen to prepare two actions for your address: `/perp/leverage` (set the leverage) and `/perp/order` (a market order sent as an immediate-or-cancel limit within 1% of the mark, with a reduce-only market stop-loss). It checks both actions against the policy: asset, side, size, price, notional, the stop price, only reduce-only exit legs, Nansen's builder with a fee of at most 0.08%, and no vault. Then it sends the EIP-712 payloads to the browser.
5. The agent key signs each payload. The engine checks that the signature recovers to your registered agent and submits it through Nansen `/perp/execute`, without retries. The leverage step goes first; the order step runs the policy again first. Both must be sent within 60 seconds of preparing.
6. Only a 4xx answer (other than 408), or a Hyperliquid error on the entry, is a rejection. A timeout, a 5xx or an unreadable answer is recorded as UNKNOWN, counts toward the caps and is later checked against your wallet's Hyperliquid position. It is never recorded as rejected. If the stop-loss leg fails while the entry fills, the receipt says so and tells you to set a stop on Hyperliquid.
7. A 451 from Nansen means the engine's region cannot trade perps. The ticket says "trading unavailable in this region", and nothing is retried elsewhere.

## 8. Street mood and the bots

For the 6 coins with the most exposure across listed companies, the engine reads Nansen `tgm/position-intelligence` every 15 minutes. It keeps only two skews per coin, for smart traders and for whales: (longs − shorts) / (longs + shorts), from −1 to 1, or unknown. The raw totals are never stored or served.

Five bot funds trade through the same exchange code as people, and are labelled BOT. Each makes at most one decision every 20 to 40 seconds, exits before entries, and draws from a seeded random generator:

| Fund | Buys or shorts | Exits |
|---|---|---|
| Value | buys 2–4% of cash in the deepest hype discount (μ < 0.97) | sells when μ > 1.05 |
| Vulture | shorts 3% of cash in the company with the lowest HP under 25% | covers when HP is back above 50% |
| Cohort | buys 3% of cash in the company whose positions agree most with the smart-money skew (alignment > 0.5, readings under 30 minutes old) | sells when alignment drops below −0.2, or after holding longer than the lookback |
| Momentum | buys 3% of cash on a NAV rise of 2% or more over its lookback (1 hour) | sells when the trend turns, or after holding longer than the lookback |
| Tape Reader | trades 1–2% of cash in the 5-minute NAV direction of a random company, long or short | exits against the move; trims half at 10% of cash |

The lookback is 1 hour in LIVE. In REPLAY it is a quarter of the loop (at most an hour), and two funds get a second rule, because a short recording rarely moves hype far enough or brings a trader near liquidation. Value also buys healthy NAV dips (−2% or more, HP at least 50%) and sells on a +2% recovery. Vulture also shorts the steepest NAV slide (−2% or more over the lookback) and covers once the slide is over or after the lookback. Momentum, Cohort and the Vulture's slide shorts also exit a position opened before a loop wrap.

## 9. Credit budget

- **Idle.** With no WebSocket viewer for 2 minutes the engine goes IDLE: Nansen polling stops, the Hyperliquid feeds stay up (they are free), NAV freezes with a marker and bots pause. An authenticated write (an order, an IPO application) counts as activity too. The first viewer back triggers a catch-up: companies whose snapshot is older than 5 minutes, or that traded while idle, refresh 3 seconds apart.
- **Snapshots** are event-driven (a trade by the address) plus a 12-minute heartbeat. `perp-pnl-summary` runs on the heartbeat. A listed company costs 2 credits per heartbeat.
- **Scout** every 3 hours: 10 credits for the candidate lists, plus up to 5 committee runs, and only while fewer than `TARGET_COMPANIES` are listed.
- **Street mood** every 15 minutes: up to 6 credits.
- **IPO applications:** 6 credits each, 11 when counterparties are needed. At most 3 per player and 10 per network per hour, 30 per hour for the whole desk, and 10 waiting at once.
- No label, agent or historical endpoints on any path.
- **Balance.** Every Nansen response reports the remaining balance in a header, and the engine applies it at once. `/account` (free) is also read every 10 minutes. Under `CREDIT_SAVER_AT` (default 1,500) routine position refreshes read Hyperliquid's `clearinghouseState`, with a visible badge. Under `CREDIT_FLOOR` (default 200) the scout, the IPO desk and Mirror pause with a reason. A call refused for credits (the `insufficient_credits` code, or HTTP 402) triggers an immediate balance check; if that check fails too, credit-saver turns on. The engine has not met a refusal for credits in practice yet.
- **Measured.** The LIVE session behind the replay ran on the author's machine on 25 September 2026, 15:02 to 16:27 UTC. It spent 178 credits in 84 minutes (about 127 an hour) with up to 6 companies, 7 IPO applications, `CREDIT_SAVER_AT=300` and `CREDIT_FLOOR=100`. Per call, Nansen reported 1 credit for perp positions, PnL summary, perp trades (also at 100 rows a page), related wallets, first funder and position intelligence; 5 for counterparties, the leaderboard and smart-money perp trades; none for `account` and the trading API.

Rate limits. The engine stays within the free plan's documented limit of 15 requests a second and 300 a minute per key, split between market data (13 and 280) and trading (2 and 20). `profiler/perp-trades` has its own window of 5 calls per 62 seconds. A 429 scoped to one endpoint holds every caller of that endpoint for the time Nansen asks, up to 60 seconds.

## 10. Redistribution

The engine follows Nansen's data redistribution guide:

- **Displayed:** profiler perp positions, perp PnL summary and perp trades (the company page, the committee's findings), and related wallets, first funder and counterparties (the hidden-hedge links on a verdict).
- **Used for selection only, never displayed:** `perp-leaderboard` and `smart-money/perp-trades`. The scout holds them in memory for one run.
- **Derived only:** `tgm/position-intelligence` becomes two skews per coin. The raw cohort totals are never stored, served or recorded.
- **Dropped:** Nansen label and entity-name fields. Nothing in the engine uses them, and recordings remove them.
- **Attribution:** "Powered by Nansen API" appears on the landing page, the floor, company pages, the IPO desk, the board, profiles, the agents page, the embed widget, the share cards and the evidence drawer.

Recordings. The session recorder, the replay bundler and the REPLAY loader apply one policy (`apps/engine/src/replay/session.ts`). A recording may contain only responses from `profiler/perp-positions`, `profiler/perp-pnl-summary`, `profiler/perp-trades`, `profiler/address/related-wallets`, `profiler/address/first-funder`, `profiler/address/counterparties` and Hyperliquid `/info`. Every key ending in `_label` or `_name` is removed from those bodies at any depth. Rate-limited (429) and server-error (5xx) answers are dropped. Street mood is kept as the derived skews only. Hyperliquid trades are kept only when they involve a listed or applying address. Trading calls and the Mirror's reads of a player's wallet go through a separate, unrecorded client, so no wallet, payload or signature is ever recorded. The public call log (`/api/provenance`) leaves out trading calls.

## 11. REPLAY

The engine replays a recorded session at real speed, in a loop, through the same code as LIVE.

- Nansen and Hyperliquid info answers come from the recording: for each request, the latest answer recorded at or before the replay clock (before the first one, the earliest). A request the recording lacks gets a 503, so the engine defers or halts as it would live.
- Hyperliquid mark prices and trades, and the street mood, play back on the same clock.
- The companies listed during the recording are listed at boot without a committee run. A company listed partway through the recording is answered as of its recorded listing until the loop reaches that point, so its first heartbeat reconciles against the listing-day PnL and not against an earlier answer to the same request (the scout's or the committee's).
- The bundled session is two recorded files (the recording engine was restarted once, at 16:13 UTC) cut to one window, 15:47:10 to 16:27:28 UTC. All six companies have marks from its first second. The restart left a one-minute gap in mark prices, about 27 minutes into the loop, where the market shows "marks delayed" and orders pause for about 50 seconds. The bundle keeps no Nansen answers from before the window, so in roughly the first 11 minutes of a loop a snapshot's recorded time can be ahead of the replay clock.
- At each loop wrap the filings are cleared, and every company restarts from its first recorded snapshot at NAV 100 with no hype. Players keep their portfolios.
- The IPO desk evaluates only addresses the recording knows. Anything else is deferred with "not in recording", never guessed.
- Mirror is off. The season is a practice season.
- Each bundle gets its own database, named after a hash of the session, so a new recording never mixes with an old one.
- Timestamps are recording time. The badge always says REPLAY with the recording date and the loop number. The evidence drawer marks replayed calls "recorded"; their credit cost was not recorded.

## 12. When data is missing

| Missing | What the engine does |
|---|---|
| A snapshot fails or does not parse | keeps the previous snapshot; halts the company after 30 minutes without one |
| Marks older than 10 seconds | freezes NAV, pauses orders, shows "marks delayed" |
| A mark for one held coin, for 60 seconds | halts that company |
| Committee evidence | DEFERRED, never listed |
| The Mirror's fresh snapshot, a live mark, or the policy's inputs | refuses, with the reason |
| An unknown Mirror outcome | UNKNOWN, counted toward the caps, checked against Hyperliquid later |
| Credits running out | credit-saver, then the credit floor, both visible on screen |
| A price for a held company | net worth shows as unknown, never as a made-up number |
