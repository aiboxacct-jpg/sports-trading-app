// server.js — a tiny zero-dependency web app for the trading engine.
//
// Uses only Node built-ins (http, fs, path, url). Holds ONE in-memory SimEngine for
// the SIMULATION side (bankroll, positions, history — persisted to disk). LIVE mode
// layers real, READ-ONLY Kalshi market prices on top; it NEVER places orders and
// NEVER mixes live prices into the simulated bankroll.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';

// Load local secrets (Kalshi key id + private key) for LIVE mode. Safe no-op if absent.
if (existsSync('.env')) process.loadEnvFile('.env');

import { SimEngine } from '../engine/simEngine.js';
import { toCents } from '../domain/money.js';
import { sessionPostGame } from '../report/postGameReport.js';
import { buildPreGameReport, addCombos } from '../report/preGameReport.js';
import { HistoricalDecisionEngine } from '../ranking/historicalDecisionEngine.js';
import { findReplacements } from '../ranking/dynamicReplacement.js';
import { computeGoalPath } from '../report/goalPath.js';
import { loadState, saveState } from '../data/store.js';
import { KalshiMarketProvider, KALSHI_PROD, KALSHI_DEMO, KALSHI_MLB_SERIES, KALSHI_NFL_SERIES, KALSHI_NHL_SERIES, mlbTickerDate, mlbTickerGameNumber } from '../data/kalshiMarketProvider.js';
import * as mlbFeed from '../data/mlbLiveFeed.js';
import * as nflFeed from '../data/nflLiveFeed.js';
import * as nhlFeed from '../data/nhlLiveFeed.js';
import { etDateStr } from '../data/mlbLiveFeed.js'; // ET game-day helper — sport-agnostic

// ---- sport registry: one entry per supported live sport. Each bundles its Kalshi
// series + a feed adapter, so the live board / sync / auto-settle / edge logic is shared.
const SPORTS = {
  mlb: {
    key: 'mlb', label: 'MLB', emoji: '⚾', series: KALSHI_MLB_SERIES,
    teamKey: mlbFeed.nickFromKalshi,       // Kalshi label -> match key (nickname)
    fetchGames: mlbFeed.fetchLiveGames,    // (etDate) -> normalized games
    findGame: mlbFeed.findGameFor,         // (games, k1, k2, gameNumber)
    isInProgress: mlbFeed.isInProgress,
    isFinal: (g) => g.state === 'Final',
    stateLabel: mlbFeed.inningLabel,       // "Top 4th"
    winner: mlbFeed.winnerNick,            // -> winning key | null (tie/not final)
    winProb: mlbFeed.fetchWinProb,         // -> HOME live win prob 0..1 (independent edge)
    gameNumber: mlbTickerGameNumber,       // doubleheaders (MLB only)
  },
  nfl: {
    key: 'nfl', label: 'NFL', emoji: '🏈', series: KALSHI_NFL_SERIES,
    teamKey: nflFeed.abbrFromKalshi,       // Kalshi label -> abbreviation
    fetchGames: nflFeed.fetchLiveGames,
    findGame: nflFeed.findGameFor,         // (games, k1, k2) — ignores gameNumber
    isInProgress: nflFeed.isInProgress,
    isFinal: (g) => g.state === 'post',
    stateLabel: nflFeed.quarterLabel,      // "Q3 5:20"
    winner: nflFeed.winnerAbbr,            // -> winning abbr | null (tie -> push)
    winProb: nflFeed.fetchWinProb,
    gameNumber: () => null,                // NFL has no doubleheaders
  },
  nhl: {
    key: 'nhl', label: 'NHL', emoji: '🏒', series: KALSHI_NHL_SERIES,
    teamKey: nhlFeed.abbrFromKalshi,
    fetchGames: nhlFeed.fetchLiveGames,
    findGame: nhlFeed.findGameFor,
    isInProgress: nhlFeed.isInProgress,
    isFinal: (g) => g.state === 'post',
    stateLabel: nhlFeed.periodLabel,       // "P2 5:20" / "OT" / "Shootout"
    winner: nhlFeed.winnerAbbr,
    winProb: nhlFeed.fetchWinProb,
    gameNumber: () => null,                // NHL has no doubleheaders
  },
};
const sportFor = (s) => SPORTS[s] || SPORTS.mlb;
// Infer a position's sport from its ticker when the field isn't stored (older positions).
const sportOfTicker = (t) =>
  /^KXNFLGAME/.test(t || '') ? 'nfl' : /^KXNHLGAME/.test(t || '') ? 'nhl' : 'mlb';
// A game's score line, e.g. "Orioles 2–1 Rays" (MLB) or "WSH 17–21 DAL" (NFL).
const scoreLine = (g) => `${g.away} ${g.awayScore}–${g.homeScore} ${g.home}`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3210;

// ---- HTTP Basic Auth (for hosting on a public domain) ---------------------
// OFF by default (local dev stays password-free). Set AUTH_PASS in the environment to
// require a login on every request — do this whenever the app is reachable publicly.
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS || '';
const AUTH_ENABLED = AUTH_PASS.length > 0;
function safeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
function authOk(req) {
  if (!AUTH_ENABLED) return true;
  const m = /^Basic (.+)$/.exec(req.headers['authorization'] || '');
  if (!m) return false;
  let decoded = '';
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return false; }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  // constant-time compare on both fields so timing can't leak the password
  return safeEqual(decoded.slice(0, i), AUTH_USER) & safeEqual(decoded.slice(i + 1), AUTH_PASS);
}
const STATE_FILE = process.env.STATE_FILE || join(__dirname, '../../data/sim-state.json');

// ---- LIVE Kalshi data (read-only; NEVER places orders) --------------------
// One lazily-built provider reads real MLB prices. A short cache keeps refreshes
// snappy without hammering the API. In LIVE mode we NEVER fall back to fake data —
// a fetch failure surfaces as an error so the board can never mix live with sim.
let kalshi = null;
function kalshiProvider() {
  if (!kalshi) kalshi = new KalshiMarketProvider();
  return kalshi;
}
const LIVE_TTL_MS = 8000;
const liveCaches = { mlb: { at: 0, board: [] }, nfl: { at: 0, board: [] }, nhl: { at: 0, board: [] } }; // per-sport board cache

// Map Kalshi's grouped games into board candidates (one per priced team side), tagged
// verified + source so the UI can badge them 🟢 and never confuse them with sim.
const LIVE_PLAY_WINDOW_MS = 4 * 3600e3; // a game is "in progress" for ~4h after first pitch

function gamesToCandidates(games, now, sport) {
  const board = [];
  for (const g of games) {
    for (const s of g.sides) {
      if (s.priceCents == null) continue; // never invent a price
      const other = g.sides.find((x) => x.ticker !== s.ticker);
      const tradeable = s.status === 'active' || s.status === 'open';
      // "Live now" heuristic from Kalshi data alone (used only if the feed is down): start
      // has passed, market still open, inside the typical play window.
      const startMs = s.occurrenceTime ? Date.parse(s.occurrenceTime) : NaN;
      const started = Number.isFinite(startMs) && startMs <= now;
      const live = started && tradeable && (now - startMs <= LIVE_PLAY_WINDOW_MS);
      board.push({
        id: s.ticker,
        team: s.team,
        opponent: other?.team ?? null,
        ticker: s.ticker,
        kind: 'single',
        sport: sport.key,
        priceCents: s.priceCents,
        gameState: live ? '🔴 LIVE' : null, // real inning/score arrives from the feed
        live,
        gameNumber: sport.gameNumber(s.ticker), // 1/2 for MLB doubleheaders, else null
        startTime: s.occurrenceTime ?? null,
        status: tradeable ? 'open' : (s.status ?? 'open'),
        verified: true,
        source: 'KALSHI',
      });
    }
  }
  return board;
}

// Apply one authoritative game's state (inning/quarter + score) to a board candidate.
function annotateFromSchedule(c, g, sport) {
  c.mlbMatched = true;
  if (sport.isInProgress(g)) {
    c.live = true;
    c.gameState = `${sport.stateLabel(g)} · ${scoreLine(g)}`;
  } else if (sport.isFinal(g)) {
    c.live = false;
    c.gameState = `Final · ${scoreLine(g)}`;
  } else {
    c.live = false; // scheduled / warmup / pre — not underway yet, keep the start time
    c.gameState = null;
  }
}

// Attach an independent live win probability (per team) to in-progress candidates, so the
// ranking has real edge even with no personal history. Cached briefly; failures are silent.
const WP_TTL_MS = 15000;
const wpCache = new Map(); // "sport:feedId" -> { at, homeWinPct }
async function cachedWinProb(sport, g) {
  const key = `${sport.key}:${g.feedId}`;
  const hit = wpCache.get(key);
  if (hit && Date.now() - hit.at < WP_TTL_MS) return hit.homeWinPct;
  let p = null;
  try { p = await sport.winProb(g); } catch { p = null; }
  wpCache.set(key, { at: Date.now(), homeWinPct: p });
  return p;
}
async function attachModelWinProb(board, schedule, sport) {
  if (!sport.winProb || !schedule || !schedule.length) return;
  const gameFor = (c) => sport.findGame(schedule, sport.teamKey(c.team), sport.teamKey(c.opponent), c.gameNumber);
  // Unique in-progress games among the board's live candidates.
  const games = new Map();
  for (const c of board) {
    if (!c.live) continue;
    const g = gameFor(c);
    if (g && g.feedId != null) games.set(g.feedId, g);
  }
  const homePctByGame = new Map();
  await Promise.all([...games.values()].map(async (g) => {
    const p = await cachedWinProb(sport, g);
    if (p != null) homePctByGame.set(g.feedId, p);
  }));
  for (const c of board) {
    if (!c.live) continue;
    const g = gameFor(c);
    const home = g && homePctByGame.get(g.feedId);
    if (home == null) continue;
    const isHome = sport.teamKey(c.team) === g.home;
    c.modelWinPct = Math.round((isHome ? home : 1 - home) * 1000) / 10; // 0..100, 1 dp
    c.modelSource = 'live win prob';
  }
}

// Fallback overlay when the sport's feed is unreachable: keep the occurrence heuristic.
async function annotateLive(board, nowMs, sport) {
  let games;
  try { games = await sport.fetchGames(etDateStr(nowMs)); }
  catch { return; }
  for (const c of board) {
    const g = sport.findGame(games, sport.teamKey(c.team), sport.teamKey(c.opponent), c.gameNumber);
    if (g) annotateFromSchedule(c, g, sport);
  }
}

async function liveKalshiBoard(sport, { force = false } = {}) {
  const cache = liveCaches[sport.key];
  const now = Date.now();
  if (!force && now - cache.at < LIVE_TTL_MS && cache.board.length) return cache.board;
  const nowMs = kalshiProvider().serverNow();
  const today = etDateStr(nowMs);

  // Scope to TODAY by the date baked into the ticker (reliable), which also drops
  // future-day duplicates of the same matchup.
  const games = await kalshiProvider().listMlbGames({ seriesTicker: sport.series, status: 'open', limit: 400 });
  let board = gamesToCandidates(games, nowMs, sport).filter((c) => mlbTickerDate(c.ticker) === today);

  // Authoritative live state from the sport's feed; drop games already final so the board
  // only shows what you can still act on. If the feed is down, keep the heuristic.
  let schedule = null;
  try { schedule = await sport.fetchGames(today); } catch { schedule = null; }
  if (schedule && schedule.length) {
    board = board.filter((c) => {
      const g = sport.findGame(schedule, sport.teamKey(c.team), sport.teamKey(c.opponent), c.gameNumber);
      if (g && sport.isFinal(g)) return false; // finished — not actionable
      if (g) annotateFromSchedule(c, g, sport);
      return true;
    });
    await attachModelWinProb(board, schedule, sport); // independent live edge
  } else {
    await annotateLive(board, nowMs, sport);
  }

  liveCaches[sport.key] = { at: now, board };
  return board;
}

function liveBaseLabel(url) {
  if (url === KALSHI_PROD || url?.includes('elections.kalshi.com')) return 'PRODUCTION';
  if (url === KALSHI_DEMO || url?.includes('demo.kalshi')) return 'DEMO';
  return url ?? 'PRODUCTION';
}

// ---- state: TWO fully separate books — SIMULATION and LIVE never share a bankroll,
// positions, or decision history. `book(mode)` picks one; each persists to disk.
const books = {
  sim:  { engine: null, history: [], missed: [] },
  live: { engine: null, history: [], missed: [] },
};
const book = (mode) => books[mode === 'live' ? 'live' : 'sim'];
let liveBoard;    // 🔴 simulated daily slate (SIMULATION mode only)

// MLB inning label for a live-board step (0..17 = Top 1 .. Bot 9).
function liveInningLabel(step) {
  const s = ((step % 18) + 18) % 18;
  return `${s % 2 === 0 ? 'Top' : 'Bot'} ${Math.floor(s / 2) + 1}`;
}

const MLB_TEAMS = [
  'Yankees', 'Red Sox', 'Blue Jays', 'Rays', 'Orioles', 'Guardians', 'Tigers', 'Twins',
  'White Sox', 'Royals', 'Astros', 'Mariners', 'Rangers', 'Angels', 'Athletics', 'Braves',
  'Phillies', 'Mets', 'Marlins', 'Nationals', 'Brewers', 'Cubs', 'Cardinals', 'Reds',
  'Pirates', 'Dodgers', 'Padres', 'Giants', 'Diamondbacks', 'Rockies',
];

// A random "daily slate" of in-progress games — varying count, matchups, innings and
// prices — so each day feels different. Simulated until a real MLB feed is wired in.
// `exclude` keeps teams you already hold out of the slate, so no team appears twice.
function generateLiveBoard(exclude = new Set()) {
  const teams = MLB_TEAMS.filter((t) => !exclude.has(t));
  for (let i = teams.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [teams[i], teams[j]] = [teams[j], teams[i]];
  }
  const games = 8 + Math.floor(Math.random() * 8); // 8..15 games
  const board = [];
  for (let i = 0; i < games && teams.length >= 2; i++) {
    const team = teams.pop();
    const opponent = teams.pop();
    const step = Math.floor(Math.random() * 18);
    const priceCents = 20 + Math.floor(Math.random() * 61); // 20..80
    board.push({
      id: `lv-${i}-${team}`,
      team,
      opponent,
      ticker: `LIVE-${team.toUpperCase().replace(/\s+/g, '')}`,
      priceCents,
      step,
      gameState: liveInningLabel(step),
      status: 'open',
    });
  }
  return board;
}

function loadBook(s) {
  return {
    engine: s && s.engine ? SimEngine.fromState(s.engine) : newEngine({ startingDollars: 100, targetDollars: 5 }),
    history: Array.isArray(s && s.history) ? s.history : [],
    missed: Array.isArray(s && s.missed) ? s.missed : [],
    bankedCents: Number(s && s.bankedCents) || 0, // profit banked across completed target rounds
    roundsWon: Number(s && s.roundsWon) || 0,     // how many target rounds have been hit
  };
}
const bankedInfo = (bk) => ({ cents: bk.bankedCents || 0, rounds: bk.roundsWon || 0 });
const saved = loadState(STATE_FILE);
if (saved && saved.version === 2) {
  books.sim = loadBook(saved.sim);
  books.live = loadBook(saved.live);
  liveBoard = Array.isArray(saved.liveBoard) && saved.liveBoard.length ? saved.liveBoard : generateLiveBoard();
} else if (saved && saved.engine) {
  // Migrate v1 (single shared ledger). That ledger was used for LIVE play, so it becomes
  // the LIVE book; SIMULATION starts clean so the two are finally separate.
  books.live = loadBook({ engine: saved.engine, history: saved.simHistory, missed: saved.missed });
  books.sim = loadBook(null);
  liveBoard = Array.isArray(saved.liveBoard) && saved.liveBoard.length ? saved.liveBoard : generateLiveBoard();
  console.log('↺ migrated v1 ledger -> LIVE book; SIMULATION reset clean (separation fix)');
} else {
  books.sim = loadBook(null);
  books.live = loadBook(null);
  liveBoard = generateLiveBoard();
}
console.log(`↺ sim: ${books.sim.engine.positions.length} pos / ${books.sim.history.length} decisions · live: ${books.live.engine.positions.length} pos / ${books.live.history.length} decisions`);

// Teams (and their opponents) currently in open SIM positions — kept out of new slates.
function heldTeams() {
  const s = new Set();
  for (const p of books.sim.engine.positions) {
    if (p.status !== 'open') continue;
    if (p.team) s.add(p.team);
    if (p.opponent) s.add(p.opponent);
  }
  return s;
}

// Random-walk the live prices so the board feels live between refreshes.
function driftLiveBoard() {
  for (const g of liveBoard) {
    g.priceCents = Math.max(1, Math.min(99, g.priceCents + Math.round((Math.random() * 2 - 1) * 4)));
  }
}

function persist() {
  saveState(STATE_FILE, {
    version: 2,
    sim: { engine: books.sim.engine.toState(), history: books.sim.history, missed: books.sim.missed, bankedCents: books.sim.bankedCents, roundsWon: books.sim.roundsWon },
    live: { engine: books.live.engine.toState(), history: books.live.history, missed: books.live.missed, bankedCents: books.live.bankedCents, roundsWon: books.live.roundsWon },
    liveBoard,
  });
}

// minSample: 3 so the profile activates after a few games in a price bucket.
const historicalEngine = (history) => new HistoricalDecisionEngine(history, { minSample: 3 });

// 👻 Missed-opportunity ledger: picks you were shown but skipped.
// regret = profit left on the table by skipped WINS; dodged = stake spared on skipped LOSSES.
function missedSummary(missed) {
  const won = missed.filter((m) => m.status === 'won');
  const lost = missed.filter((m) => m.status === 'lost');
  const regretCents = won.reduce((a, m) => a + (m.potentialProfitCents || 0), 0);
  const dodgedCents = lost.reduce((a, m) => a + (m.stakeForTargetCents || 0), 0);
  return {
    items: missed,
    pending: missed.filter((m) => m.status === 'pending').length,
    won: won.length,
    lost: lost.length,
    regretCents,
    dodgedCents,
    netCents: regretCents - dodgedCents, // >0 means skipping cost you overall
  };
}
function recordDecision(history, pos) {
  if (!pos) return;
  const committed = pos.committedCents ?? ((pos.costCents ?? 0) + (pos.entryFeeCents ?? 0));
  history.push({
    ts: new Date().toISOString(),
    team: pos.team ?? pos.ticker ?? null,
    opponent: pos.opponent ?? null,
    kind: pos.kind ?? 'single',
    entryPriceCents: pos.entryPriceCents,
    exitPriceCents: pos.status === 'settled' ? (pos.settlement === 'win' ? 100 : 0) : pos.exitPriceCents,
    settlement: pos.settlement ?? null,
    closedType: pos.status, // 'settled' | 'closed'
    contracts: pos.contracts,
    stakeCents: committed,
    realizedPureProfitCents: pos.realizedPureProfitCents,
    won: pos.realizedPureProfitCents > 0,
    roiPct: committed > 0 ? Math.round((pos.realizedPureProfitCents / committed) * 1000) / 10 : 0,
  });
}

function newEngine({ startingDollars, targetDollars }) {
  return new SimEngine({
    startingBankrollCents: toCents(Number(startingDollars)),
    targetCents: toCents(Number(targetDollars)),
  });
}

// ---- helpers --------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const int = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`expected an integer, got "${v}"`);
  return n;
};

// Normalize a candidate from the client; resolve missing prices from the market.
function resolveCandidate(c, i, engine) {
  const base = {
    id: c.id || `cand-${i + 1}`, team: c.team, opponent: c.opponent,
    kind: c.kind === 'combo' ? 'combo' : 'single',
    verified: c.verified === true, source: c.source || null, // keep 🟢 real-price provenance
    gameTime: c.gameTime || null, gameState: c.gameState || null, status: c.status || 'open',
  };
  if (base.kind === 'combo') {
    return { ...base, legs: (c.legs ?? []).map((l) => ({ ...l, priceCents: l.priceCents == null ? (l.ticker ? engine.market.getPrice(l.ticker) : null) : int(l.priceCents) })) };
  }
  return { ...base, ticker: c.ticker, priceCents: c.priceCents == null ? (c.ticker ? engine.market.getPrice(c.ticker) : null) : int(c.priceCents) };
}

// Sizing options from a request: fixed stake (respect the user's dollars) or size-to-target.
function sizingOpts(body) {
  return {
    sizeMode: body && body.sizeMode === 'fixed' ? 'fixed' : 'target',
    stakeCents: body && body.stakeDollars != null ? toCents(Number(body.stakeDollars)) : undefined,
  };
}

// ---- API ------------------------------------------------------------------
// Every generic handler receives (body, mode); `mode` ('sim'|'live') selects the book,
// so SIMULATION and LIVE never share a bankroll, positions, or history.
const api = {
  'GET /api/state': (body, mode) => {
    const snapshot = book(mode).engine.snapshot();
    return { snapshot, goalPath: computeGoalPath(snapshot), mode, banked: bankedInfo(book(mode)) };
  },

  'POST /api/reset': (body, mode) => {
    book(mode).engine = newEngine({
      startingDollars: body.startingDollars ?? 100,
      targetDollars: body.targetDollars ?? 5,
    });
    return { snapshot: book(mode).engine.snapshot() };
  },

  // Bank a completed target round and start fresh: add the round's realized profit to the
  // lifetime "banked" tally, bump the rounds-won count, then reset the bankroll (KEEPING
  // history + missed so the learning engine carries over). This is the goal-seeking loop.
  'POST /api/newround': (body, mode) => {
    const bk = book(mode);
    const realized = bk.engine.snapshot().bankroll.realizedPureProfitCents;
    bk.bankedCents = (bk.bankedCents || 0) + realized;
    bk.roundsWon = (bk.roundsWon || 0) + 1;
    bk.engine = newEngine({
      startingDollars: body.startingDollars ?? 100,
      targetDollars: body.targetDollars ?? 5,
    });
    const snapshot = bk.engine.snapshot();
    return { snapshot, goalPath: computeGoalPath(snapshot), banked: bankedInfo(bk), bankedThisRoundCents: realized };
  },

  // Full clean slate for THIS mode only: new bankroll + wipe its history & missed ledger.
  'POST /api/clear': (body, mode) => {
    const bk = book(mode);
    bk.engine = newEngine({
      startingDollars: body.startingDollars ?? 100,
      targetDollars: body.targetDollars ?? 5,
    });
    bk.history.length = 0;
    bk.missed.length = 0;
    bk.bankedCents = 0;
    bk.roundsWon = 0;
    if (mode !== 'live') liveBoard = generateLiveBoard();
    return { snapshot: bk.engine.snapshot(), banked: bankedInfo(bk) };
  },

  'POST /api/price': (body, mode) => {
    book(mode).engine.setPrice(String(body.ticker), int(body.priceCents));
    return { snapshot: book(mode).engine.snapshot() };
  },

  'POST /api/open': (body, mode) => {
    const engine = book(mode).engine;
    const ticker = String(body.ticker);
    const entryPriceCents = int(body.priceCents);
    // Seed a current price so the position is immediately valued, unless one exists.
    if (engine.market.getPrice(ticker) == null) engine.setPrice(ticker, entryPriceCents);
    engine.open({
      ticker,
      team: body.team || ticker,
      opponent: body.opponent || null,
      kind: body.kind === 'combo' ? 'combo' : 'single',
      entryPriceCents,
      stakeCents: toCents(Number(body.stakeDollars)),
      gameStateAtEntry: body.gameState || null,
    });
    return { snapshot: engine.snapshot() };
  },

  'POST /api/close': (body, mode) => {
    const bk = book(mode);
    recordDecision(bk.history, bk.engine.close(String(body.id), int(body.exitPriceCents)));
    return { snapshot: bk.engine.snapshot() };
  },

  'POST /api/settle': (body, mode) => {
    const bk = book(mode);
    recordDecision(bk.history, bk.engine.settle(String(body.id), body.outcome === 'win' ? 'win' : 'loss'));
    return { snapshot: bk.engine.snapshot() };
  },

  'POST /api/gamestate': (body, mode) => {
    book(mode).engine.setGameState(String(body.id), String(body.gameState ?? ''));
    return { snapshot: book(mode).engine.snapshot() };
  },

  'GET /api/postgame': (body, mode) => ({
    postgame: sessionPostGame(book(mode).engine.positions, { targetCents: book(mode).engine.targetCents }),
  }),

  'POST /api/pregame': (body, mode) => {
    const bk = book(mode);
    const board = addCombos((body.board ?? []).map((c, i) => resolveCandidate(c, i, bk.engine)));
    const reportMode = mode === 'live' ? 'LIVE' : 'SIMULATION';
    return { pregame: buildPreGameReport(bk.engine.snapshot(), board, { feeRate: bk.engine.feeRate, historical: historicalEngine(bk.history), mode: reportMode, ...sizingOpts(body) }) };
  },

  // The SIMULATION daily slate (always the sim book).
  'POST /api/livegame': (body) => ({
    livegame: buildPreGameReport(books.sim.engine.snapshot(), liveBoard, { feeRate: books.sim.engine.feeRate, historical: historicalEngine(books.sim.history), ...sizingOpts(body) }),
  }),

  'POST /api/livegame/refresh': (body) => {
    driftLiveBoard();
    return { livegame: buildPreGameReport(books.sim.engine.snapshot(), liveBoard, { feeRate: books.sim.engine.feeRate, historical: historicalEngine(books.sim.history), ...sizingOpts(body) }) };
  },

  // Pull a fresh random daily slate of live games.
  'POST /api/livegame/new': (body) => {
    liveBoard = generateLiveBoard(heldTeams());
    return { livegame: buildPreGameReport(books.sim.engine.snapshot(), liveBoard, { feeRate: books.sim.engine.feeRate, historical: historicalEngine(books.sim.history), ...sizingOpts(body) }) };
  },

  // Advance the live board one clock step: drift prices + move each game's inning.
  // A game that finishes regulation restarts as a fresh matchup so the board stays live.
  'POST /api/livegame/tick': (body) => {
    for (const g of liveBoard) {
      g.priceCents = Math.max(1, Math.min(99, g.priceCents + Math.round((Math.random() * 2 - 1) * 4)));
      g.step = (g.step ?? 0) + 1;
      if (g.step > 17) { g.step = 0; g.priceCents = 40 + Math.floor(Math.random() * 21); } // new game
      g.gameState = liveInningLabel(g.step);
    }
    return { livegame: buildPreGameReport(books.sim.engine.snapshot(), liveBoard, { feeRate: books.sim.engine.feeRate, historical: historicalEngine(books.sim.history), ...sizingOpts(body) }) };
  },

  // ---- LIVE Kalshi board (real prices, read-only) -------------------------
  // Config/connectivity status for the UI's live-mode banner. No secrets returned.
  'GET /api/live/status': (body) => {
    const p = kalshiProvider();
    const sport = sportFor(body.sport);
    return {
      live: {
        configured: p.isConfigured,
        source: p.source,
        base: liveBaseLabel(p.baseUrl),
        verified: p.verified,
        sport: sport.key,
        sports: Object.values(SPORTS).map((s) => ({ key: s.key, label: s.label, emoji: s.emoji })),
        note: p.isConfigured
          ? 'Read-only live prices. The app never places orders.'
          : '🔴 NOT VERIFIED — add Kalshi credentials to .env (see KALSHI_SETUP.md).',
      },
    };
  },

  // Real board from Kalshi for the chosen sport, ranked by the edge/EV engine — LIVE book.
  'POST /api/live/board': async (body) => {
    const bk = books.live;
    const sport = sportFor(body.sport);
    const board = await liveKalshiBoard(sport);
    return {
      livegame: buildPreGameReport(bk.engine.snapshot(), board, {
        feeRate: bk.engine.feeRate, historical: historicalEngine(bk.history), mode: 'LIVE', ...sizingOpts(body),
      }),
      candidates: board, // raw real-price board so ranking/pre-game/replacements can reuse it
      asOf: new Date(liveCaches[sport.key].at).toISOString(),
      priced: board.length, source: 'KALSHI', sport: sport.key,
      base: liveBaseLabel(kalshiProvider().baseUrl),
    };
  },

  // Sync OPEN live positions to live data + auto-settle finished games — LIVE book only.
  // Positions carry their own sport, so a mixed book (MLB + NFL) syncs each correctly.
  'POST /api/live/sync': async () => {
    const bk = books.live;
    const engine = bk.engine;
    const nowMs = kalshiProvider().serverNow();
    const priceByTicker = new Map();
    const schedules = {};                 // sport key -> today's games (fetched once each)
    for (const s of Object.values(SPORTS)) {
      try { for (const c of await liveKalshiBoard(s)) priceByTicker.set(c.ticker, c.priceCents); } catch { /* skip */ }
    }
    let priced = 0, stated = 0;
    const autoSettled = [];
    for (const p of engine.positions) {
      if (p.status !== 'open') continue;
      const sport = sportFor(p.sport || sportOfTicker(p.ticker));
      if (schedules[sport.key] === undefined) {
        try { schedules[sport.key] = await sport.fetchGames(etDateStr(nowMs)); } catch { schedules[sport.key] = null; }
      }
      const games = schedules[sport.key] || [];
      const g = sport.findGame(games, sport.teamKey(p.team), sport.teamKey(p.opponent), sport.gameNumber(p.ticker));
      // Auto-settle the LIVE paper ledger from the real result once the game is final.
      // Never touches real money on Kalshi — only records the outcome you'd have had.
      const winner = sport.winner(g);
      if (winner) {
        const outcome = sport.teamKey(p.team) === winner ? 'win' : 'loss';
        recordDecision(bk.history, engine.settle(p.id, outcome));
        autoSettled.push({ team: p.team, outcome, score: scoreLine(g) });
        continue; // settled — no more price/state updates for this one
      }
      const px = priceByTicker.get(p.ticker);
      if (px != null) { engine.setPrice(p.ticker, px); priced++; }
      if (g) {
        // In progress -> inning/quarter + score; final tie -> final; not underway yet
        // (warmup / scheduled / other DH game) -> clear so it never shows a wrong score.
        const gs = sport.isInProgress(g) ? `${sport.stateLabel(g)} · ${scoreLine(g)}`
          : sport.isFinal(g) ? `Final · ${scoreLine(g)}`
          : '';
        engine.setGameState(p.id, gs); stated++;
      }
    }
    const snapshot = engine.snapshot();
    return { snapshot, goalPath: computeGoalPath(snapshot), synced: { priced, stated }, autoSettled, banked: bankedInfo(bk) };
  },

  // Force a fresh pull (bypass the cache), e.g. on "u"/"update"/"refresh".
  'POST /api/live/refresh': async (body) => {
    const bk = books.live;
    const sport = sportFor(body.sport);
    const board = await liveKalshiBoard(sport, { force: true });
    return {
      livegame: buildPreGameReport(bk.engine.snapshot(), board, {
        feeRate: bk.engine.feeRate, historical: historicalEngine(bk.history), mode: 'LIVE', ...sizingOpts(body),
      }),
      candidates: board,
      asOf: new Date(liveCaches[sport.key].at).toISOString(),
      priced: board.length, source: 'KALSHI', sport: sport.key,
      base: liveBaseLabel(kalshiProvider().baseUrl),
    };
  },

  'POST /api/replacements': (body, mode) => {
    const bk = book(mode);
    const board = addCombos((body.board ?? []).map((c, i) => resolveCandidate(c, i, bk.engine)));
    return { replacements: findReplacements(bk.engine.snapshot(), board, { feeRate: bk.engine.feeRate, historical: historicalEngine(bk.history), ...sizingOpts(body) }) };
  },

  'GET /api/history': (body, mode) => {
    const items = book(mode).history;
    const n = items.length;
    const wins = items.filter((d) => d.won).length;
    const totalRealizedCents = items.reduce((a, d) => a + (d.realizedPureProfitCents || 0), 0);
    const totalStakeCents = items.reduce((a, d) => a + (d.stakeCents || 0), 0);
    const profits = items.map((d) => d.realizedPureProfitCents || 0);
    return {
      history: {
        items,
        count: n,
        wins,
        losses: n - wins,
        winRatePct: n ? Math.round((wins / n) * 1000) / 10 : null,
        totalRealizedCents,
        roiPct: totalStakeCents > 0 ? Math.round((totalRealizedCents / totalStakeCents) * 1000) / 10 : 0,
        bestCents: n ? Math.max(...profits) : 0,
        worstCents: n ? Math.min(...profits) : 0,
        kinds: historicalEngine(items).kindSummary(),
      },
      mode,
    };
  },

  'GET /api/missed': (body, mode) => ({ missed: missedSummary(book(mode).missed) }),

  'POST /api/missed/log': (body, mode) => {
    const missed = book(mode).missed;
    const pendingTeams = new Set(missed.filter((m) => m.status === 'pending').map((m) => m.team));
    for (const p of body.picks ?? []) {
      if (!p || !p.team || pendingTeams.has(p.team)) continue; // dedup pending by team
      missed.push({
        id: `miss-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        team: String(p.team),
        kind: p.kind === 'combo' ? 'combo' : 'single',
        priceCents: p.priceCents == null ? null : int(p.priceCents),
        stakeForTargetCents: Number(p.stakeForTargetCents) || 0,
        potentialProfitCents: Number(p.potentialProfitCents) || 0,
        loggedAt: new Date().toISOString(),
        status: 'pending',
        resolvedAt: null,
      });
      pendingTeams.add(p.team);
    }
    return { missed: missedSummary(missed) };
  },

  'POST /api/missed/resolve': (body, mode) => {
    const missed = book(mode).missed;
    const m = missed.find((x) => x.id === String(body.id));
    if (!m) throw new Error(`no missed item ${body.id}`);
    m.status = body.outcome === 'win' ? 'won' : 'lost';
    m.resolvedAt = new Date().toISOString();
    return { missed: missedSummary(missed) };
  },

  'POST /api/missed/clear': (body, mode) => {
    book(mode).missed.length = 0;
    return { missed: missedSummary(book(mode).missed) };
  },

  'POST /api/rank': (body, mode) => {
    const bk = book(mode);
    const stakeCents = toCents(Number(body.stakeDollars ?? 10));
    const board = (body.board ?? []).map((c, i) => ({
      id: c.id || `cand-${i + 1}`,
      team: c.team,
      opponent: c.opponent,
      kind: c.kind === 'combo' ? 'combo' : 'single',
      priceCents: c.priceCents == null ? null : int(c.priceCents),
      gameTime: c.gameTime || null,
      gameState: c.gameState || null,
      status: c.status || 'open',
    }));
    const result = bk.engine.rankBoard(board, { stakeCents, historical: historicalEngine(bk.history) });
    return { ranking: result, stakeCents };
  },
};

// Routes that change state and must be persisted after handling.
const MUTATING = new Set([
  '/api/reset', '/api/clear', '/api/newround', '/api/price', '/api/open', '/api/close', '/api/settle', '/api/gamestate',
  '/api/missed/log', '/api/missed/resolve', '/api/missed/clear',
  '/api/livegame/refresh', '/api/livegame/tick', '/api/livegame/new', '/api/live/sync',
]);

// ---- request routing ------------------------------------------------------
const server = createServer(async (req, res) => {
  try {
    // Gate everything behind Basic Auth when a password is configured.
    if (!authOk(req)) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="Sports Trading App", charset="UTF-8"',
        'Content-Type': 'text/plain',
      });
      return res.end('Authentication required.');
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    const key = `${req.method} ${url.pathname}`;

    if (key === 'GET /' || url.pathname === '/index.html') {
      const html = await readFile(join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (url.pathname === '/spec' || url.pathname === '/spec.html') {
      const html = await readFile(join(__dirname, 'spec.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (url.pathname === '/history' || url.pathname === '/history.html') {
      const html = await readFile(join(__dirname, 'history.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    const handler = api[key];
    if (!handler) return sendJson(res, 404, { error: `no route ${key}` });

    const body = req.method === 'POST' ? await readBody(req) : {};
    // Which book this request touches: from the body (POST) or ?mode= (GET). Default sim.
    const rawMode = (body && body.mode) || url.searchParams.get('mode') || 'sim';
    const mode = rawMode === 'live' ? 'live' : 'sim';
    // Which sport (live endpoints): body.sport (POST) or ?sport= (GET). Default mlb.
    body.sport = (body && body.sport) || url.searchParams.get('sport') || 'mlb';
    const result = await handler(body, mode);
    if (MUTATING.has(url.pathname)) persist();
    return sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: err.message });
  }
});

server.listen(PORT, () => {
  const p = kalshiProvider();
  const live = p.isConfigured ? `🟢 LIVE ready (${liveBaseLabel(p.baseUrl)}, read-only)` : '⚪ live not configured';
  const auth = AUTH_ENABLED ? `🔒 password-protected (user "${AUTH_USER}")` : '🔓 no auth (set AUTH_PASS before exposing publicly)';
  console.log(`Sports Trading App running at http://localhost:${PORT}  —  ${live}  —  ${auth}`);
});
