# Sports Trading App

An MLB / Kalshi **decision-support** engine. It tracks a bankroll and positions,
computes **pure profit** (always net of fees), and runs a four-state target system.

> This tool is decision *support*, not financial advice. It does not place trades.
> The **live** mode requires your own verified Kalshi + MLB data; nothing is invented.

## Status

- ✅ **Simulation engine** — bankroll, positions, pure-profit + target math, reports.
- ✅ **Action ranking** — scans a board, ranks with 🥇🥈🥉, explains every rank,
  and folds in "historical fit" from your own past decisions.
- 🔌 **Live Kalshi layer** — stubbed behind a clean interface. Returns
  `🔴 NOT VERIFIED` until you add credentials and implement the fetch/signing.

The two modes are kept strictly separate: simulation results never touch real
bankroll or live history.

## Run

```bash
npm start                     # launch the web app at http://localhost:3210
node --test                   # run the test suite (24 tests)
node examples/demo.js         # scripted simulation walkthrough
node examples/rankingDemo.js  # rank a hypothetical MLB board
```

Requires Node ≥ 24 (uses the built-in test runner; no dependencies).

## Web app

`npm start` runs a tiny zero-dependency web app (Node's built-in `http`) at
**http://localhost:3210**. It drives one in-memory `SimEngine`, so you can:

- set a bankroll + target,
- open positions, then **move the current price** and watch unrealized pure profit
  and the **target state** react (NOT REACHED → AVAILABLE → REALIZED),
- close or settle (win/loss) positions,
- build a hypothetical board and **rank it** (🥇🥈🥉) with the "why" for each.

State is in-memory and resets on restart — persistence is a separate feature.
It is stamped ⚪ SIMULATION throughout; it never uses live data or real money.

## Layout

```
src/
  domain/
    money.js       integer-cents helpers, Kalshi price validation
    fees.js        Kalshi trading-fee MODEL (float-safe, rounds up to the cent)
    position.js    open / value / settle a position; pure-profit math
    bankroll.js    aggregate positions -> bankroll snapshot (cash & equity identities)
    target.js      four-state target machine (NOT REACHED / AVAILABLE / LOCKED / REALIZED)
  data/
    marketProvider.js       the price-source interface both modes implement
    simMarketProvider.js    hypothetical prices you set by hand (SIMULATION)
    kalshiMarketProvider.js  LIVE stub — refuses to guess until configured
  ranking/
    actionRanking.js            score & rank a board (reach/riskReward/confidence/historical)
    historicalDecisionEngine.js  "historical fit" from past decisions (says "insufficient" honestly)
  engine/
    simEngine.js   the simulation engine (open/close/settle/snapshot/rankBoard)
  report/
    simReport.js       render a bankroll snapshot (⚪ SIMULATED badge)
    rankingReport.js   render the 🥇🥈🥉 board + "Your Decision" choices
examples/
  demo.js         scripted bankroll/position walkthrough
  rankingDemo.js  scripted board-ranking walkthrough
test/             node:test suite
```

## Key rules baked in

- **Pure profit is net of all fees** (entry + exit), never gross.
- **Unrealized ≠ realized.** A winning team is never a "realized target."
- **Target states** are distinct: you can *exit now for ≥ target* (AVAILABLE),
  have a *hedge that guarantees ≥ target* (LOCKED), or have *actually banked it*
  (REALIZED).
- **No invented data.** An unknown price marks a position `NOT VERIFIED` and drops
  it from mark-to-market — or excludes it from the ranking — rather than guessing.
- **Ranking is not "highest probability wins."** It weighs whether a position can
  reach the target, its reward-per-risk, its win probability, and your historical
  fit — and shows the component scores so every rank is explainable.

## Finishing the live layer (later)

1. Get a Kalshi API key id + RSA private key (account → API keys).
2. Put them in `.env` (see `.env.example`) — never commit, never paste in chat.
3. Implement `fetchMarket()` / request signing in `kalshiMarketProvider.js`
   (RSA-PSS over `timestamp + method + path`, sent in `KALSHI-ACCESS-*` headers).
4. Add a live game-data source for score / inning / outs / pitchers.
5. Build the `LiveEngine` alongside `SimEngine` with its own separate history store.
```
