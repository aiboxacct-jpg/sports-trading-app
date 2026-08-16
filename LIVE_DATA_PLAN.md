# Live Data — Architecture & Roadmap

Turning the simulator into a live tool: real **Kalshi** prices + real **game state**,
MLB first, then NHL and football. This is the map. Nothing here places trades.

## Guardrails (non-negotiable)

1. **No automated trading.** The app reads live data, tracks positions you've entered,
   and computes P&L. It never sends orders to Kalshi. You execute on Kalshi yourself.
2. **Live ranking = advice-sensitive.** Ranking real-money markets is different from
   ranking hypothetical ones. Live mode is framed as *your analysis dashboard / market
   info*, not "place this bet." (Decision to confirm — see Open Questions.)
3. **Verified or nothing.** Any live value that can't be confirmed from its source is
   marked `🔴 NOT VERIFIED` and left out of rankings (already the rule in SPEC.md).
4. **Secrets never touch chat or git.** API keys live in `.env` on the server only;
   the browser never sees them (server proxies all authed calls).
5. **Sim and live stay separate.** Separate engine state, separate history stores. A
   simulated result never affects the live record, ever.

## What "live" needs — two independent feeds

### A. Kalshi (the market / money side)
- **Auth:** API key id + RSA private key. Every authed request is signed with an
  RSA-PSS signature over `timestamp + METHOD + path`, sent in `KALSHI-ACCESS-*` headers.
- **Read (prices/status):** list markets for a series, get a market's yes/no bid/ask,
  order book, volume, and open/closed status.
- **Read (your account, optional):** positions & fills — so the app can auto-track what
  you actually hold instead of you typing it in. Needs account-scoped auth.
- Already stubbed: `src/data/kalshiMarketProvider.js` implements the `MarketProvider`
  interface and returns `NOT VERIFIED` until this is built.

### B. Sports data (the game side)
- Per sport: schedule (today's games), and live game state (score, period/inning/quarter,
  clock, situation).
- **MLB:** MLB StatsAPI (`statsapi.mlb.com`) — free, no key. Innings, outs, score, pitchers.
- **NHL:** NHL API (`api-web.nhle.com`) — free. Periods, clock, score.
- **NFL/football:** harder — no clean free official feed; likely a paid provider
  (SportsDataIO / similar) or an unofficial ESPN endpoint. Cost + reliability TBD.

### C. The glue (the hard part)
- **Match a Kalshi market ↔ a real game.** Parse the Kalshi ticker/series + teams +
  date and link it to the sports-feed game id. This mapping is where most of the
  fiddly work lives (team-name normalization, doubleheaders, postponements).

## Architecture

```
Browser (dashboard)  ──HTTP──▶  Node server (holds secrets, proxies)
                                   │
                 ┌─────────────────┼──────────────────┐
                 ▼                 ▼                  ▼
        KalshiMarketProvider   SportsFeed         Matcher
        (prices, status,       (per sport:        (ticker ↔ game)
         positions/fills)       MLB/NHL/NFL)
                 │                 │
                 └──────▶ LiveEngine ◀──────┘
                          (separate state + live history store)
```

- **Providers** stay behind the interfaces we already have, so `SimEngine` and a new
  `LiveEngine` share the same domain math (money, fees, pure profit, target, ranking).
- **`SportsFeed` interface** (new): `getGames(date)`, `getGameState(gameId)` →
  normalized `{ status, homeScore, awayScore, period, clock, situation }`.
- **Sport config** (new): each sport declares its clock model and how its Kalshi markets
  map — MLB innings, NHL periods, NFL quarters. The sim already speaks MLB/NHL clocks,
  so we generalize that.
- **LiveEngine**: same engine, live providers, its own persisted `live-state.json` and
  its own history — never mixed with the sim.

## Phased roadmap

| Phase | Goal | Status / Notes |
|------|------|-------|
| **0. Connectivity** | Kalshi auth signing works; one real fetch returns verified data | ✅ **Built** — signing + `npm run kalshi:ping`; awaiting user's demo keys to verify |
| **1. Live MLB prices** (Live Play, paper) | Real Kalshi MLB prices on the board, `🟢 VERIFIED` badges, `NOT VERIFIED` fallback | **NEXT** — read-only; play money; no game state yet |
| **2. Live MLB game state** | MLB StatsAPI wired: real inning/score/outs on positions & board | Replaces the simulated clock for MLB |
| **3. Order prep + hand-off** | App shows the exact order and deep-links you to that Kalshi market — **you place & approve it on Kalshi** | Real money, manual on Kalshi's side. NO in-app order submission, ever |
| **4. Live engine + history** | Separate LiveEngine + live history; the Sim/Live toggle drives real data | Honors the sim-vs-live separation rule |
| **5. Multi-sport** | NHL via NHL API; football via a paid/unofficial feed | Sport config + matcher per sport |
| **— Live Tracking** (parked) | Auto-sync your real Kalshi portfolio (positions/fills) for hands-off P&L | Deferred at user's request; revisit later |

## Decisions (locked)

- **No in-app trade execution — ever.** The app never submits real-money orders. Even
  with per-order manual approval, code that POSTs orders to Kalshi is off the table.
  Real bets are placed by the user, on Kalshi's own app/site (Phase 3 hands off to it).
- **Live-mode posture:** read-only info + your P&L. Rankings on live markets are framed
  as analysis, not "place this bet."
- **First sport / source:** MLB via the free StatsAPI. Football later (likely paid).
- **Deployment:** local first, `.env` for secrets. Demo (paper) Kalshi before production.

## Risks / unknowns
- Kalshi RSA signing correctness and rate limits.
- Kalshi market ↔ game matching (naming, doubleheaders, postponements).
- Football data licensing/cost.
- Keeping the advice framing right on live real-money markets.
- Polling vs websockets for freshness (start with polling on Update/interval).

## Risks / unknowns
- Kalshi RSA signing correctness and rate limits.
- Kalshi market ↔ game matching (naming, doubleheaders, postponements).
- Football data licensing/cost.
- Keeping the advice framing right on live real-money markets.
- Polling vs websockets for freshness (start with polling on Update/interval).
