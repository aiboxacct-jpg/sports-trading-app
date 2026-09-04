# Live Trading (real order execution)

By default this app is **read-only** — it shows real Kalshi prices and tracks a paper
ledger, but never places orders. This document covers the **opt-in** live-trading layer
that lets your Open/Sell actions place **real orders** on Kalshi.

> ⚠️ Real orders move real money. Build and test on the **demo** exchange first (play
> money). Nothing here executes until you deliberately arm it via environment variables.

## How the safety gate works

Execution is blocked unless **all** of these are true:

1. `KALSHI_TRADING_ARMED=true` — the master switch (absent/false ⇒ read-only).
2. The target exchange is allowed:
   - **Demo** (`KALSHI_BASE_URL` = the demo URL) — allowed when armed.
   - **Production** (real money) — additionally requires `KALSHI_TRADING_ALLOW_PROD=true`.
3. Kalshi credentials are configured.
4. Each order passes the **size caps** and carries an explicit confirmation.

Even when the server is armed, the browser adds a second, per-session gate: the 💵 **arm
real orders** switch in Live mode (defaults OFF every session) plus a confirm dialog on
each order. The server never trusts the client — it re-checks every rule on its side.

## Caps (per order)

| Env var | Default | Meaning |
|---|---|---|
| `KALSHI_TRADING_MAX_CONTRACTS` | `10` | Max contracts in a single order |
| `KALSHI_TRADING_MAX_ORDER_DOLLARS` | `25` | Max capital (count × limit price) per order |

Orders over a cap are rejected server-side with a clear message.

## Recommended path: demo first

1. In `.env`, point at the demo exchange:
   ```
   KALSHI_BASE_URL=https://external-api.demo.kalshi.co/trade-api/v2
   KALSHI_TRADING_ARMED=true
   ```
   (Leave `KALSHI_TRADING_ALLOW_PROD` unset — you're on demo.)
2. Restart. The boot log should read `💵 TRADING ARMED on DEMO …`.
3. In the app, switch to **Live Play**. The 💵 bar shows your demo balance and a
   **arm real orders** switch. Tick it (confirm), then place a small limit order.
4. Verify the order appears in your Kalshi demo account.

## Going to production (real money)

Only after demo works end-to-end:

```
KALSHI_BASE_URL=https://api.elections.kalshi.com/trade-api/v2
KALSHI_TRADING_ARMED=true
KALSHI_TRADING_ALLOW_PROD=true
```

Keep the caps low to start. Consider a Kalshi API key scoped to the minimum you need.

## Endpoints (all gated)

- `GET  /api/trade/status` — armed?, exchange, caps, balance, blocked-reason (read-only).
- `POST /api/trade/order` — place a limit order (`confirm:true` required; enforces caps).
- `GET  /api/trade/positions` — your resting orders + positions (read-only).
- `POST /api/trade/cancel` — cancel a resting order.

## Note on the current key

As of writing, market-data reads succeed on **production**, but `/portfolio/balance`
returns `401 authentication_error` there — market data on Kalshi is effectively public,
so those reads working on prod doesn't prove account auth works on prod. Account/trading
actions are expected to authenticate on **demo**; confirm balance shows in the 💵 bar on
demo before trusting production.
