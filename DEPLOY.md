# Deploy to Render + a custom domain

The app is a zero-dependency Node server. It reads `PORT`, persists to `STATE_FILE`, and
password-protects itself when `AUTH_PASS` is set. Everything below is done in the Render
dashboard and your domain registrar — no code changes needed.

## 1. Create the Render service
Two ways — the Blueprint is fastest:

**A) Blueprint (uses `render.yaml`)**
1. Push this repo to GitHub (already done).
2. Render → **New +** → **Blueprint** → pick this repo → **Apply**.
   It creates a Node web service with the health check, disk, and non-secret env vars.

**B) Manual (if you prefer clicking)**
1. Render → **New +** → **Web Service** → connect this repo.
2. Runtime **Node**, Build `npm install`, Start `node src/server/server.js`.
3. Plan **Free**. Health check path `/healthz`.

## 2. Set the environment variables (Environment tab)
| Key | Value |
|---|---|
| `KALSHI_BASE_URL` | `https://api.elections.kalshi.com/trade-api/v2` (production, read-only) |
| `KALSHI_API_KEY_ID` | your Kalshi key id |
| `KALSHI_PRIVATE_KEY` | paste the **full PEM** (BEGIN…END, multi-line is fine) |
| `AUTH_USER` | e.g. `admin` |
| `AUTH_PASS` | **a strong password** — this is your login |

> Tip: use `KALSHI_PRIVATE_KEY` (inline) rather than a file — no upload needed. Never
> commit these; they live only in Render.

## 3. Storage — free vs paid
- **Free (default):** no persistent disk, so the sim/live **paper ledgers reset on each
  redeploy and after a cold start**. Everything else (live boards, edges, auth, custom
  domain) works fully. Great for using and testing.
- **Keep history across restarts (Starter, $7/mo):** change `plan: free` → `plan: starter`
  in `render.yaml`, add a **Disk** (name `data`, mount `/data`, 1 GB), and set env
  `STATE_FILE=/data/sim-state.json`. That's the only difference.

> Free note: the service sleeps after ~15 min idle; the first visit after that takes
> ~30–60s to wake, then it's fast again.

## 4. Deploy & verify
1. Render builds and starts it; watch the log for
   `Sports Trading App running … 🟢 LIVE ready (PRODUCTION, read-only) … 🔒 password-protected`.
2. Open the `onrender.com` URL → browser prompts for `AUTH_USER` / `AUTH_PASS`.
3. `https://<your-app>.onrender.com/healthz` returns `ok` (no login) — that's the probe.

## 5. Custom domain
1. Buy a domain (Namecheap, Cloudflare, …).
2. Render → your service → **Settings → Custom Domains** → add `app.yourdomain.com`
   (a subdomain is simplest).
3. At your registrar/DNS, add the **CNAME** Render shows (points the subdomain at Render).
4. Render provisions HTTPS automatically. Done — visit `https://app.yourdomain.com`.

## Security recap
- Keep it **password-protected** (`AUTH_PASS`) — the server holds your Kalshi key.
- Only served over **HTTPS** (Render does this) so the Basic-Auth password isn't exposed.
- The app is **read-only** on Kalshi; it never places orders.
