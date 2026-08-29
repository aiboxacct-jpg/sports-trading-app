// nflLiveFeed.js — live NFL game state from ESPN's public scoreboard API (no auth).
//
// Mirrors mlbLiveFeed.js so both sports can share one registry later. Matching is by
// team ABBREVIATION (ESPN gives it directly; Kalshi labels map to it). Everything here
// is READ-ONLY public data; pure helpers are unit-tested, the fetch is thin + defensive.

const ESPN_NFL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

// Kalshi `yes_sub_title` -> ESPN team abbreviation (all 32; shared cities disambiguated
// the way Kalshi does: "New York G"/"New York J", "Los Angeles R"/"Los Angeles C").
export const KALSHI_TO_ABBR = {
  'Arizona': 'ARI', 'Atlanta': 'ATL', 'Baltimore': 'BAL', 'Buffalo': 'BUF', 'Carolina': 'CAR',
  'Chicago': 'CHI', 'Cincinnati': 'CIN', 'Cleveland': 'CLE', 'Dallas': 'DAL', 'Denver': 'DEN',
  'Detroit': 'DET', 'Green Bay': 'GB', 'Houston': 'HOU', 'Indianapolis': 'IND', 'Jacksonville': 'JAX',
  'Kansas City': 'KC', 'Las Vegas': 'LV', 'Los Angeles C': 'LAC', 'Los Angeles R': 'LAR', 'Miami': 'MIA',
  'Minnesota': 'MIN', 'New England': 'NE', 'New Orleans': 'NO', 'New York G': 'NYG', 'New York J': 'NYJ',
  'Philadelphia': 'PHI', 'Pittsburgh': 'PIT', 'San Francisco': 'SF', 'Seattle': 'SEA', 'Tampa Bay': 'TB',
  'Tennessee': 'TEN', 'Washington': 'WSH',
};

/** Kalshi team label -> ESPN abbreviation (null if unknown). */
export function abbrFromKalshi(label) {
  return (label && KALSHI_TO_ABBR[label]) || null;
}

/** True only when the game is actually being played (ESPN abstract state "in"). */
export function isInProgress(g) {
  return !!g && g.state === 'in';
}

/** Short game-state label, e.g. "Q3 5:20", "Halftime", "OT 1:12", "Final". */
export function quarterLabel(g) {
  if (!g) return '';
  if (g.state === 'post') return 'Final';
  if (g.state === 'pre') return '';                       // scheduled — not started
  if (g.detail === 'STATUS_HALFTIME') return 'Halftime';
  if (!g.period) return 'Live';
  const ord = g.period >= 5 ? 'OT' : `Q${g.period}`;
  return g.clock ? `${ord} ${g.clock}` : ord;
}

/** Winning team's abbreviation for a FINAL game, or null (not final / tie -> push). */
export function winnerAbbr(g) {
  if (!g || g.state !== 'post') return null;
  if (g.awayScore == null || g.homeScore == null || g.awayScore === g.homeScore) return null;
  return g.awayScore > g.homeScore ? g.away : g.home;
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
      away: away?.team?.abbreviation ?? null,
      home: home?.team?.abbreviation ?? null,
      awayScore: away?.score != null && away.score !== '' ? Number(away.score) : null,
      homeScore: home?.score != null && home.score !== '' ? Number(home.score) : null,
      state: type.state ?? null,   // pre | in | post
      detail: type.name ?? null,   // STATUS_SCHEDULED | STATUS_IN_PROGRESS | STATUS_HALFTIME | STATUS_FINAL ...
      period: st.period ?? null,   // quarter (5 = OT)
      clock: st.displayClock ?? null,
      feedId: g.id ?? null,        // ESPN event id (for win probability)
      date: g.date ?? null,
    };
  }).filter((x) => x.away && x.home);
}

/** Live model HOME win probability (0..1) from ESPN's game summary, or null. */
export async function fetchWinProb(game, { fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  if (!game || game.feedId == null) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${game.feedId}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const j = await res.json();
    const arr = j.winprobability || [];
    const last = arr[arr.length - 1];
    const h = last?.homeWinPercentage;
    return h == null ? null : Math.max(0, Math.min(1, Number(h)));
  } catch { return null; } finally { clearTimeout(timer); }
}

/** Find the normalized game matching two abbreviations (either home/away order). */
export function findGameFor(games, abbr1, abbr2) {
  return games.find(
    (g) => (g.away === abbr1 && g.home === abbr2) || (g.away === abbr2 && g.home === abbr1),
  ) || null;
}

/** Fetch + normalize NFL games for a date (YYYY-MM-DD). Times out; throws on failure. */
export async function fetchLiveGames(dateStr, { fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  const yyyymmdd = (dateStr || '').replace(/-/g, '');
  const url = yyyymmdd ? `${ESPN_NFL}?dates=${yyyymmdd}` : ESPN_NFL;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`ESPN NFL ${res.status}`);
    return normalizeScheduleGames(await res.json());
  } finally {
    clearTimeout(timer);
  }
}
