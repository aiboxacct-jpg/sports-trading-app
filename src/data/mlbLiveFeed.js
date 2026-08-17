// mlbLiveFeed.js — authoritative live game state from MLB's free StatsAPI (no auth).
//
// Kalshi's scheduled-start field proved unreliable (it can be hours off for a game that
// is actually in progress), so "is this game live, and what inning/score" comes from the
// MLB StatsAPI schedule endpoint. Everything here is READ-ONLY public data. The pure
// helpers (name matching, normalization) are unit-tested; the fetch is thin and defensive
// so a StatsAPI outage never breaks the live board.

const STATS_BASE = 'https://statsapi.mlb.com/api/v1';

// Kalshi's `yes_sub_title` (city-ish, disambiguated for shared cities) -> MLB nickname.
// StatsAPI full team names end with the nickname (e.g. "Baltimore Orioles"), so we match
// on the nickname, which is unique across the league.
export const KALSHI_TO_NICK = {
  'Arizona': 'Diamondbacks', 'Atlanta': 'Braves', 'Baltimore': 'Orioles', 'Boston': 'Red Sox',
  'Chicago C': 'Cubs', 'Chicago WS': 'White Sox', 'Cincinnati': 'Reds', 'Cleveland': 'Guardians',
  'Colorado': 'Rockies', 'Detroit': 'Tigers', 'Houston': 'Astros', 'Kansas City': 'Royals',
  'Los Angeles A': 'Angels', 'Los Angeles D': 'Dodgers', 'Miami': 'Marlins', 'Milwaukee': 'Brewers',
  'Minnesota': 'Twins', 'New York M': 'Mets', 'New York Y': 'Yankees', "A's": 'Athletics',
  'Oakland': 'Athletics', 'Philadelphia': 'Phillies', 'Pittsburgh': 'Pirates', 'San Diego': 'Padres',
  'San Francisco': 'Giants', 'Seattle': 'Mariners', 'St. Louis': 'Cardinals', 'Tampa Bay': 'Rays',
  'Texas': 'Rangers', 'Toronto': 'Blue Jays', 'Washington': 'Nationals',
};

const NICKS = [...new Set(Object.values(KALSHI_TO_NICK))].sort((a, b) => b.length - a.length);

/** Kalshi team label -> MLB nickname (null if unknown). */
export function nickFromKalshi(label) {
  if (!label) return null;
  if (KALSHI_TO_NICK[label]) return KALSHI_TO_NICK[label];
  return NICKS.find((n) => label === n || label.includes(n)) || null;
}

/** StatsAPI full team name -> MLB nickname (null if unknown). Longest match wins. */
export function nickFromStatsName(name) {
  if (!name) return null;
  return NICKS.find((n) => name.includes(n)) || null;
}

/** Short inning label, e.g. "Mid 3rd" / "Top 5th". Falls back to the detailed state. */
export function inningLabel(g) {
  if (!g.ordinal) return g.detailed || 'Live';
  const s = { Top: 'Top', Middle: 'Mid', Bottom: 'Bot', End: 'End' }[g.inningState] || g.inningState || '';
  return `${s} ${g.ordinal}`.trim();
}

/** Normalize a StatsAPI schedule payload into flat, matched game states. */
export function normalizeScheduleGames(json) {
  const games = (json?.dates ?? []).flatMap((d) => d.games || []);
  return games.map((g) => {
    const ls = g.linescore || {};
    return {
      away: nickFromStatsName(g.teams?.away?.team?.name),
      home: nickFromStatsName(g.teams?.home?.team?.name),
      state: g.status?.abstractGameState || null, // Preview | Live | Final
      detailed: g.status?.detailedState || null,  // In Progress | Warmup | Final | ...
      inning: ls.currentInning ?? null,
      inningState: ls.inningState ?? null,
      ordinal: ls.currentInningOrdinal ?? (ls.currentInning ? String(ls.currentInning) : null),
      awayScore: g.teams?.away?.score ?? null,
      homeScore: g.teams?.home?.score ?? null,
      gameDate: g.gameDate || null,
    };
  }).filter((x) => x.away && x.home);
}

/**
 * Winning team's nickname for a FINAL game, or null if not final / tied / missing scores.
 * Used to auto-settle the paper ledger from the real result.
 */
export function winnerNick(g) {
  if (!g || g.state !== 'Final') return null;
  if (g.awayScore == null || g.homeScore == null || g.awayScore === g.homeScore) return null;
  return g.awayScore > g.homeScore ? g.away : g.home;
}

/** Find the normalized game matching two nicknames (either home/away order). */
export function findGameFor(games, nick1, nick2) {
  return games.find(
    (g) => (g.away === nick1 && g.home === nick2) || (g.away === nick2 && g.home === nick1),
  ) || null;
}

/** ISO date (YYYY-MM-DD) in US Eastern for a given epoch ms — the MLB "game day". */
export function etDateStr(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

/** Fetch + normalize today's MLB games. Times out and throws on failure (caller decides). */
export async function fetchLiveGames(dateStr, { fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  const url = `${STATS_BASE}/schedule?sportId=1&date=${dateStr}&hydrate=linescore,team`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`MLB StatsAPI ${res.status}`);
    return normalizeScheduleGames(await res.json());
  } finally {
    clearTimeout(timer);
  }
}
