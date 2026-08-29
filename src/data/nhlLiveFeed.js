// nhlLiveFeed.js — live NHL game state from ESPN's public scoreboard API (no auth).
//
// Same shape/interface as nflLiveFeed.js (ESPN is uniform across sports); differences are
// the endpoint, the team map, and period labels (P1–P3 / OT / Shootout). Read-only.
//
// NOTE: Kalshi lists no per-game NHL markets in the offseason, so the KALSHI_TO_ABBR map
// below is provisional — VERIFY the exact yes_sub_title labels once KXNHLGAME goes live
// (esp. the two New York teams and any city Kalshi abbreviates differently).

const ESPN_NHL = 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard';

// Kalshi `yes_sub_title` -> ESPN abbreviation (all 32). Single-city teams use the city;
// New York is the only shared NHL city (Rangers/Islanders), disambiguated like MLB/NFL.
export const KALSHI_TO_ABBR = {
  'Anaheim': 'ANA', 'Boston': 'BOS', 'Buffalo': 'BUF', 'Calgary': 'CGY', 'Carolina': 'CAR',
  'Chicago': 'CHI', 'Colorado': 'COL', 'Columbus': 'CBJ', 'Dallas': 'DAL', 'Detroit': 'DET',
  'Edmonton': 'EDM', 'Florida': 'FLA', 'Los Angeles': 'LA', 'Minnesota': 'MIN', 'Montreal': 'MTL',
  'Nashville': 'NSH', 'New Jersey': 'NJ', 'New York I': 'NYI', 'New York R': 'NYR', 'Ottawa': 'OTT',
  'Philadelphia': 'PHI', 'Pittsburgh': 'PIT', 'San Jose': 'SJ', 'Seattle': 'SEA', 'St. Louis': 'STL',
  'Tampa Bay': 'TB', 'Toronto': 'TOR', 'Utah': 'UTAH', 'Vancouver': 'VAN', 'Vegas': 'VGK',
  'Washington': 'WSH', 'Winnipeg': 'WPG',
};

/** Kalshi team label -> ESPN abbreviation (null if unknown). */
export function abbrFromKalshi(label) {
  return (label && KALSHI_TO_ABBR[label]) || null;
}

/** True only when the game is actually being played (ESPN abstract state "in"). */
export function isInProgress(g) {
  return !!g && g.state === 'in';
}

/** Short game-state label, e.g. "P2 5:20", "OT 1:12", "Shootout", "Final". */
export function periodLabel(g) {
  if (!g) return '';
  if (g.state === 'post') return 'Final';
  if (g.state === 'pre') return '';                       // scheduled — not started
  const per = g.period;
  if (!per) return 'Live';
  if (per >= 5) return 'Shootout';
  if (per === 4) return g.clock ? `OT ${g.clock}` : 'OT';
  return g.clock ? `P${per} ${g.clock}` : `P${per}`;
}

/** Winning team's abbreviation for a FINAL game (NHL always has a winner via OT/SO). */
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
    const type = (g.status || {}).type || {};
    return {
      away: away?.team?.abbreviation ?? null,
      home: home?.team?.abbreviation ?? null,
      awayScore: away?.score != null && away.score !== '' ? Number(away.score) : null,
      homeScore: home?.score != null && home.score !== '' ? Number(home.score) : null,
      state: type.state ?? null,   // pre | in | post
      detail: type.name ?? null,
      period: g.status?.period ?? null,   // 1–3 regulation, 4 OT, 5 shootout
      clock: g.status?.displayClock ?? null,
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
    const res = await fetchImpl(`https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/summary?event=${game.feedId}`, { signal: ctrl.signal });
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

/** Fetch + normalize NHL games for a date (YYYY-MM-DD). Times out; throws on failure. */
export async function fetchLiveGames(dateStr, { fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  const yyyymmdd = (dateStr || '').replace(/-/g, '');
  const url = yyyymmdd ? `${ESPN_NHL}?dates=${yyyymmdd}` : ESPN_NHL;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`ESPN NHL ${res.status}`);
    return normalizeScheduleGames(await res.json());
  } finally {
    clearTimeout(timer);
  }
}
