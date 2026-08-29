# To-Do / Roadmap

Parked items, in rough priority order. Nothing here is started yet.

## ✅ NFL live support — DONE (2026-08-28)
Built end to end: `nflLiveFeed.js` (ESPN scoreboard — state/quarter/clock/score/winner,
ties→push), a shared **sport registry** in the server (MLB + NFL reuse board / sync /
auto-settle / edge), generalized ticker parser + `listMlbGames(seriesTicker)`, and a
⚾/🏈 toggle in Live mode. Verified against real Kalshi NFL markets + ESPN data. Still to
confirm once games are actually being played: live in-progress quarter/clock/score sync
and NFL auto-settle (preseason games Aug 28 evenings; regular season Sept).

## ✅ NHL live support — built (2026-08-28), verify when markets appear
`nhlLiveFeed.js` (ESPN NHL scoreboard — P1–3 / OT / Shootout / Final) + registry entry +
🏒 in the toggle. Board is correctly EMPTY now (offseason — Kalshi lists no `KXNHLGAME`).
**To confirm when the season nears (~late Sept):** the Kalshi NHL team-label map (esp.
the two New York teams and any city Kalshi abbreviates oddly) and live in-progress sync.

All three leagues now share one live pipeline — adding a 4th (NBA, etc.) is just another
`*LiveFeed.js` + one `SPORTS` registry entry + a toggle option.
**Why parked:** it's the NHL offseason (regular season starts ~October). Kalshi has
**no per-game NHL markets** yet — `KXNHLGAME` is empty; only season futures
(`KXNHL-27-*`) are listed. And with no games being played we can't test against live
data — which is exactly how we caught the MLB bugs (warmup-not-live, doubleheaders,
stale innings). Revisit ~Sept/Oct.

When ready, the work (mirrors the MLB stack):
1. `nhlLiveFeed.js` against the free NHL API `api-web.nhle.com` (confirmed reachable):
   parse LIVE / FINAL / scheduled, period + clock (3 periods, OT, shootout), scores,
   winner. Team-nickname map Kalshi → NHL.
2. Confirm Kalshi's per-game NHL series once posted (ticker date/team encoding,
   `yes_sub_title` values, doubleheader-equivalent? — usually none in hockey).
3. Generalize the server into a sport registry:
   `sport → { kalshiSeries, feed, tickerParser, labels }` so MLB + NHL share the
   board / sync / auto-settle / edge logic instead of duplicating it.
4. UI: ⚾/🏒 sport toggle in Live mode; hockey period labels. (Sim clock already has NHL.)

## 🔄 History-driven Dynamic Replacement rework (do once buckets have volume)
Today the replacement score falls back to ~70% market-confidence when a bucket lacks
history, so it just favors the chalk. Once the sim/live buckets fill in:
1. Confidence-gate suggestions (only 🟡 moderate / ✅ solid samples).
2. Net-of-cost check — only suggest a swap when expected gain > exit cost.
3. Rank by realized edge (your bucket win-rate vs market), not generic score.
4. Cite the history behind each suggestion ("you're 8–2 here vs market 67%").

## 🛡️ Risk Engine hard limits (last partial pillar)
Real guardrails, not just warnings: max % of cash per bet, per-round stop-loss,
max concurrent exposure. Currently it only warns about heavy concentration.

## 📤 Phase 3 — order prep + hand-off (still no in-app execution)
A ready-to-place order slip you confirm manually on Kalshi. App stays read-only;
never submits real-money orders.

## 🎯 External edge data (no personal history needed)
- ✅ **Live win probability** (2026-08-28) — in-progress picks compare Kalshi to the
  game feed's live win% (MLB StatsAPI, NFL/NHL ESPN) → real edge from day one.
- ⏭️ **Pre-game Vegas moneyline** — do the same for games that haven't started, using
  ESPN summary `pickcenter` (de-vig the moneyline → fair win%), so pre-game picks also
  show an edge, not just live ones. (`fetchWinProb` pattern already in each feed.)
- Later: ESPN `predictor`, records/form power-rating as extra baselines.

## Small niceties
- Show the 🏦 banked total per book on the History page.
- Optional: sample size on each pick card ("edge +23% · based on 5 bets").
