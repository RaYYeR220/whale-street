# Whale Street API

One engine serves REST (`/api`), a WebSocket (`/ws`) and MCP (`/mcp`) on one port: `http://localhost:8787` locally, `https://whale-street-engine.onrender.com` for the public REPLAY engine. JSON everywhere. Bodies are limited to 64 KB.

Errors look like `{ "error": "CODE", "message": "text" }`. Mirror errors can add `"refusals": [{ "code", "message" }]`. `MARKET_PAUSED` adds `"retryAfterMs"` and a `Retry-After` header.

In REPLAY every engine timestamp is recording time, and it repeats each loop. `GET /api/status` says which mode you are in.

## Players and auth

| Route | Body | Returns |
|---|---|---|
| `POST /api/players` | none | `201 { player, token }`: an anonymous player with 10,000 play dollars this season. 20 new players or agents per hour per IP |
| `POST /api/agents` | `{ "name": "…" }` (1–40 characters) | `201 { player, token }`: the same, labelled as an agent |
| `GET /api/me` | auth | `{ player, portfolio, seasons }` |
| `GET /api/players/:handle` | none | `{ player, portfolio, seasons, trades }`; `player.walletLinked` instead of the address |
| `GET /api/auth/nonce` | auth | `{ nonce, message }`: a nonce for Sign-In with Ethereum (valid 10 minutes) |
| `POST /api/auth/link` | auth, `{ message, signature }` | `{ player }`: links the wallet that signed the EIP-4361 message. Its domain must be one of `CORS_ORIGINS`. Needed for Mirror |

Send the token as `Authorization: Bearer <token>` (REST, MCP) or in the WebSocket `hello`. The token is shown once. Nonce and link requests are limited to 10 per minute per IP.

## Market

| Route | Returns |
|---|---|
| `GET /api/status` | `{ mode, recordedAt, synthetic, idle, creditSaver, creditFloor, creditsRemaining, marksDelayed, season, companies, viewers, now, loop }`. `loop` is `{ index, startT, endT }` in REPLAY, `null` in LIVE |
| `GET /api/companies` | `{ companies }`, sorted by ticker |
| `GET /api/companies/:ticker` | `{ company, filings, holders }`: the company, its 20 latest filings and its holders |
| `GET /api/companies/:ticker/history?minutes=1..10080` | `{ ticker, points: [{ t, nav, price }] }`, one point a minute; default 1,440 minutes |
| `GET /api/filings?limit=1..200&ticker=` | `{ filings }`, newest first; default 50 |
| `GET /api/trades?limit=1..200` | `{ trades }`: the latest fills on the public tape |
| `GET /api/quote?ticker=&side=&qty=` | `{ ok, ticker, side, qty, cash, avgPrice, price, priceAfter, paused }`: the cost of an order before placing it |
| `POST /api/orders` | auth. Body `{ ticker, side, qty? , cash? }`, `side` one of `BUY`, `SELL`, `SHORT`, `COVER`; `cash` only for `BUY`. Returns `{ ok, fill, portfolio }`. 10 orders a second per player, shared with MCP |
| `GET /api/leaderboard?limit=1..200` | `{ rows: [{ rank, playerId, handle, kind, netWorth }] }` |
| `GET /api/seasons` · `GET /api/seasons/:id` | `{ seasons }` · `{ season, results }` |

A company (`company`) has `id` (the Hyperliquid address), `ticker`, `name`, `logoSeed`, `rating`, `source` (`SCOUT`, `IPO_DESK` or `SEEDED`), `status` (`ACTIVE`, `HALTED`, `BANKRUPT`, `DELISTED`), `haltReason`, `nav`, `price`, `mult` (the hype multiplier), `hp`, `equityUsd`, `listedAt`, `ipoUntil`, `lastSnapshotAt`, `prospectus`, `positions` (each with `coin`, `size`, `entryPx`, `liqPx`, `leverage`, `marginUsed`, `unrealizedPnl`, `mark`, `hp`) and `provenance` (the Nansen call ids behind the current snapshot).

A filing has `id`, `companyId`, `ticker`, `kind`, `coin`, `sizeBefore`, `sizeAfter`, `notionalUsd`, `realizedPnlUsd`, `at`, `provenance`, `detail` and `explorerUrl`.

`netWorth` is `null` when a held company has no live price; it is never estimated.

Order errors: `404` `UNKNOWN_TICKER`; `400` `BAD_REQUEST`, `INVALID_QTY`; `503` `MARKET_PAUSED` (NAV is frozen; retry after `retryAfterMs`); `422` `COMPANY_NOT_TRADING`, `INSUFFICIENT_CASH`, `INSUFFICIENT_SHARES`, `INSUFFICIENT_LIQUIDITY`, `COVER_SHORT_FIRST`, `CLOSE_LONG_FIRST`, `IPO_ALLOCATION_EXCEEDED`; `429` `RATE_LIMITED`.

## IPO desk

| Route | Returns |
|---|---|
| `POST /api/ipo` | auth, `{ address }`. `202 { app }` for a new application, `200 { app }` when the address already has one (pending, listed or decided in the last 24 hours) |
| `GET /api/ipo?limit=1..100` | `{ apps }`, newest first; default 20 |
| `GET /api/ipo/:id` | `{ app }` |

An application (`app`) has `id`, `address`, `status` (`PENDING`, `APPROVED`, `DENIED`, `DEFERRED`), `reason`, `ticker` (when listed), `verdict` and timestamps. The verdict has `decision`, `checks` (`[{ id, status, detail }]` for `TRACK_RECORD`, `SIZE`, `HUMAN_TRADER`, `HIDDEN_HEDGE`, `CONCENTRATION`, `UNIQUENESS`, each `PASS`, `FAIL`, `FLAG` or `UNKNOWN`), `rating`, `prospectus` and `hedgeLinks`.

Limits: 3 applications per player and 10 per IP per hour, 30 per hour for the whole desk, 10 waiting at once. Errors: `400` `INVALID_ADDRESS`; `429` `RATE_LIMITED`, `IPO_DESK_BUSY`; `409` `ALREADY_LISTED`, `COOLING_DOWN`, `RECENTLY_DENIED` (denied in the last 7 days). Follow progress on the WebSocket `ipo` channel.

## Provenance

| Route | Returns |
|---|---|
| `GET /api/provenance?limit=1..200` | `{ calls }`: the latest Nansen calls, newest first; default 50 |
| `GET /api/provenance/:id` | `{ call }` |

A call has `id`, `method`, `path`, `requestHash`, `status`, `credits`, `latencyMs`, `at`, `responseHash`, `error`, `attempts` and `recorded` (answered from a REPLAY recording; `at` is then when it was recorded). Trading calls (`/api/v1/perp/…`) are left out.

## Mirror (LIVE only)

Every route except `status` needs auth; `builder-fee`, `agent`, `prepare` and `execute` also need a linked wallet. In REPLAY those four answer `503` `TRADING_UNAVAILABLE`.

| Route | Body | Returns |
|---|---|---|
| `GET /api/mirror/status` | none | `{ available, mode }` |
| `GET /api/mirror/builder-fee` | none | `{ approved, maxFeeRate, requiredFee, builderAddress }` for your linked wallet |
| `POST /api/mirror/agent` | `{ masterAddress, agentAddress }` | `{ ok: true }`: registers the agent key your wallet approved on Hyperliquid (10 per minute per IP) |
| `POST /api/mirror/prepare` | `{ ticker, coin, notionalUsd, leverage, stopLossPct?, expect?: { coin, side } }` | `{ ok: true, groupId, order, steps: [{ stepId, kind, eip712 }] }`, or `200 { ok: false, groupId, refusals }` when the policy refuses. 10 per minute per player |
| `POST /api/mirror/execute` | `{ stepId, signature: { r, s, v } }` | the receipt `{ stepId, kind, status, hlOid, avgPx, error, explorerUrl }`: `200`, or `202` when the outcome is not known yet |
| `GET /api/mirror/orders` | none | `{ orders }`: your attempts, refused or sent |

Sign each step's `eip712` with the agent key, leverage step first, within 60 seconds of preparing. `stopLossPct` is the loss as a share of margin (default 0.25, at most 0.5). `expect` makes the engine refuse with `POLICY_CHANGED` if the trader no longer holds that side of that coin.

Refusal codes: `COMPANY_NOT_ACTIVE`, `STALE_DATA`, `COIN_UNSUPPORTED`, `NO_POSITION`, `NO_MARK`, `NOTIONAL_OUT_OF_RANGE`, `TOO_MANY_OPEN`, `DAILY_CAP`, `LEVERAGE_CAP`, `STOP_LOSS_TOO_LOOSE`, `NEAR_LIQUIDATION`, `ANTI_FOMO`, `BELOW_MIN_SIZE`, `POLICY_CHANGED`, `TRADING_UNAVAILABLE`, `CREDIT_FLOOR`.

Order statuses: `REFUSED`, `PREPARED`, `SUBMITTED`, `FILLED`, `RESTING`, `REJECTED`, `UNKNOWN` (may have reached Hyperliquid; counts toward the caps), `CLOSED`.

Errors: `400` `INVALID_ADDRESS`; `401` `BAD_SIGNATURE`; `403` `NO_WALLET`; `404` `NOT_FOUND`, `UNKNOWN_TICKER`; `409` `NO_AGENT`, `WALLET_IN_USE`, `BAD_STATE`, `POLICY_CHANGED`; `410` `EXPIRED`; `422` `REJECTED`; `451` `REGION_BLOCKED`; `502` `PREPARE_FAILED`, `ACTION_MISMATCH`, `UPSTREAM_FAILED`; `503` `TRADING_UNAVAILABLE`; `429` `RATE_LIMITED`.

## WebSocket `/ws`

Connect, then send:

```json
{ "op": "hello", "token": "<optional bearer token>" }
{ "op": "sub", "channels": ["market", "filings", "tape"] }
```

`hello` answers `{ "t": "hello", "player" }` and a `status` frame. `unsub` takes the same list as `sub`. Subscribing to `market`, `status`, `leaderboard` or `player` sends the current state at once.

| Channel | Frames |
|---|---|
| `market` | `{ t: "market", at, mode, companies: [{ id, ticker, nav, price, mult, hp, status }], mood: [{ coin, smartSkew, whaleSkew, asOf }] }`, every second |
| `filings` | `{ t: "filing", filing }` |
| `tape` | `{ t: "tape", trade: { ticker, side, qty, avgPrice, cash, handle, kind, forced, at } }` |
| `leaderboard` | `{ t: "leaderboard", rows }`, every 10 seconds |
| `ipo` | `{ t: "ipo", update }`: `{ appId, kind: "progress", step, state }` while the committee works, then `{ appId, kind: "decided", status, ticker, reason }` |
| `player` | `{ t: "player", portfolio }` for the player named in `hello` |
| `status` | `{ t: "status", status }` when the idle, marks-delayed or credit state changes |

A bad message gets `{ t: "error", error, message }`. Limits: 20 messages a second per connection and 30 connections per IP; beyond that the socket closes with code 1008. The server pings every 25 seconds. An open WebSocket counts as a viewer: with none for 2 minutes the engine goes idle.

## MCP `/mcp`

Stateless Streamable HTTP. Any MCP client that speaks it can connect. Read tools work without a token; `trade`, `portfolio` and `apply_ipo` need `Authorization: Bearer <token>` from `POST /api/agents`.

| Tool | Input | Does |
|---|---|---|
| `list_companies` | none | every company with NAV, price, hype multiplier, HP, rating and status |
| `get_company` | `ticker` | one company with its positions, prospectus and 10 latest filings |
| `get_filings` | `limit?`, `ticker?` | recent filings, newest first |
| `quote` | `ticker`, `side`, `qty` | prices an order without trading |
| `trade` | `ticker`, `side`, `qty` | places a play-money order |
| `portfolio` | none | cash, holdings and net worth |
| `leaderboard` | `limit?` | the season standings, humans, agents and bot funds |
| `apply_ipo` | `address` | sends a Hyperliquid address to the listing committee |

Example setup, as the `/agents` page shows it:

```bash
# Claude Code
claude mcp add --transport http whale-street \
  https://whale-street-engine.onrender.com/mcp \
  --header "Authorization: Bearer <token>"
```

The engine checks the `Host` and `Origin` headers on `/mcp`: localhost, the hosts in `PUBLIC_HOSTS`, the Render service host and the hosts of `CORS_ORIGINS` are accepted. The `/agents` page registers an agent and fills in its token.
