# Kalshi API Setup (Phase 0)

Get read-only Kalshi credentials and verify the connection. **Start with the DEMO
sandbox** — fake money, zero risk — to prove everything works before touching real markets.

> Never paste your private key or key id into a chat. They live only in your local `.env`.

## 1. Create an account

- **Demo (recommended first):** sign up at **https://demo.kalshi.co** — a full sandbox
  with fake funds.
- **Production (later):** your real account at **https://kalshi.com**.

## 2. Generate an API key

1. Log in (demo or prod).
2. Go to **Settings → API** (a.k.a. "API Keys").
3. Click **Create / Generate API key**.
4. **Download the private key** file (a `.pem`) and save it somewhere safe on your machine.
   You only get it once.
5. Copy the **API Key ID** (a UUID-looking string).

## 3. Put the credentials in `.env`

Copy `.env.example` to `.env` (it's gitignored) and fill in:

```
KALSHI_API_KEY_ID=<your key id>
KALSHI_PRIVATE_KEY_PATH=C:\path\to\your\kalshi_private_key.pem
# Demo sandbox (recommended first):
KALSHI_BASE_URL=https://external-api.demo.kalshi.co/trade-api/v2
# Production (switch to this later):
# KALSHI_BASE_URL=https://api.elections.kalshi.com/trade-api/v2
```

(You can instead paste the PEM inline as `KALSHI_PRIVATE_KEY="-----BEGIN...\n...\n-----END..."`,
but pointing at the `.pem` file is easier.)

## 4. Verify the connection

```bash
npm run kalshi:ping
```

Success looks like:

```
✅ Auth OK — exchange status: {...}
✅ Pulled 3 open market(s): ...
🟢 Phase 0 verified — signing works and real prices are flowing.
```

If it fails, the usual culprits are: demo-vs-prod base URL mismatch, a key id that
doesn't match the PEM, or a wrong path to the `.pem`.

## What this does / doesn't do

- ✅ Reads real market prices and status (signed, read-only).
- ❌ Never places orders. You execute any trades yourself on Kalshi.

Once `kalshi:ping` is green, we move to **Phase 1**: wiring these real prices into the
board with 🟢 VERIFIED badges.
