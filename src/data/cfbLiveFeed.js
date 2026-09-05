// cfbLiveFeed.js — live College Football game state from ESPN's public scoreboard API.
//
// Mirrors nflLiveFeed.js. College football has 130+ FBS teams, so instead of a hand-kept
// abbreviation map we match on a NORMALIZED SCHOOL NAME: Kalshi's `yes_sub_title` (e.g.
// "Oregon", "Ohio St.", "Miami (FL)") vs ESPN's team.location ("Oregon", "Ohio State",
// "Miami"), canonicalizing "St."<->"State" and dropping parentheticals. Matching is STRICT
// (both sides must resolve to the same normalized name) so a mismatch never auto-settles a
// position wrongly — it just won't sync live state for that game. READ-ONLY public data.

const ESPN_CFB = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';

/** Normalize a school name to a stable match key: lowercase, drop "(FL)"/"(OH)" and
 *  punctuation, and canonicalize a trailing "St" to "State" ("Ohio St." -> "ohio state"). */
export function cfbNorm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')     // drop parentheticals — NOTE: collapses Miami (FL)/(OH)
    .replace(/&/g, ' and ')
    .replace(/[.'`]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\bst\b/g, 'state');    // "portland st" -> "portland state"
}

/** Kalshi team label -> normalized school key (this app's CFB match key). */
export function abbrFromKalshi(label) {
  const k = cfbNorm(label);
  return k || null;
}

/** True only when the game is actually being played (ESPN abstract state "in"). */
export function isInProgress(g) {
  return !!g && g.state === 'in';
}

/** Short game-state label, e.g. "Q3 5:20", "Halftime", "OT", "Final". */
export function quarterLabel(g) {
  if (!g) return '';
  if (g.state === 'post') return 'Final';
  if (g.state === 'pre') return '';
  if (g.detail === 'STATUS_HALFTIME') return 'Halftime';
  if (!g.period) return 'Live';
  const ord = g.period >= 5 ? 'OT' : `Q${g.period}`;
  return g.clock ? `${ord} ${g.clock}` : ord;
}

/** Winning team's normalized key for a FINAL game, or null (not final / tie). */
export function winnerAbbr(g) {
  if (!g || g.state !== 'post') return null;
  if (g.awayScore == null || g.homeScore == null || g.awayScore === g.homeScore) return null;
  return g.awayScore > g.homeScore ? g.awayKey : g.homeKey;
}

/** Normalize an ESPN scoreboard payload into flat game states. */
export function normalizeScheduleGames(json) {
  const events = json?.events ?? [];
  return events.map((g) => {
    const c = g.competitions?.[0] || {};
    const comps = c.competitors || [];
    const home = comps.find((t) => t.homeAway === 'home');
    const away = comps.find((t) => t.homeAway === 'away');
    const st = g.status || {};
    const type = st.type || {};
    return {
      away: away?.team?.abbreviation ?? null,   // display (scoreLine)
      home: home?.team?.abbreviation ?? null,
      awayKey: cfbNorm(away?.team?.location),   // strict match key
      homeKey: cfbNorm(home?.team?.location),
      awayScore: away?.score != null && away.score !== '' ? Number(away.score) : null,
      homeScore: home?.score != null && home.score !== '' ? Number(home.score) : null,
      state: type.state ?? null,
      detail: type.name ?? null,
      period: st.period ?? null,
      clock: st.displayClock ?? null,
      feedId: g.id ?? null,
      date: g.date ?? null,
    };
  }).filter((x) => x.awayKey && x.homeKey);
}

/** Live model HOME win probability (0..1) from ESPN's game summary, or null. */
export async function fetchWinProb(game, { fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  if (!game || game.feedId == null) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=${game.feedId}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const j = await res.json();
    const arr = j.winprobability || [];
    const last = arr[arr.length - 1];
    const h = last?.homeWinPercentage;
    return h == null ? null : Math.max(0, Math.min(1, Number(h)));
  } catch { return null; } finally { clearTimeout(timer); }
}

/** Find the normalized game matching two school keys (either home/away order). */
export function findGameFor(games, key1, key2) {
  return games.find(
    (g) => (g.awayKey === key1 && g.homeKey === key2) || (g.awayKey === key2 && g.homeKey === key1),
  ) || null;
}

/** Fetch + normalize CFB games for a date (YYYY-MM-DD). Times out; throws on failure. */
export async function fetchLiveGames(dateStr, { fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  const yyyymmdd = (dateStr || '').replace(/-/g, '');
  const url = yyyymmdd ? `${ESPN_CFB}?dates=${yyyymmdd}&groups=80&limit=200` : `${ESPN_CFB}?groups=80&limit=200`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`ESPN CFB ${res.status}`);
    return normalizeScheduleGames(await res.json());
  } finally {
    clearTimeout(timer);
  }
}
