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
import { KalshiMarketProvider, KALSHI_PROD, KALSHI_DEMO } from '../data/kalshiMarketProvider.js';
import { fetchLiveGames, nickFromKalshi, findGameFor, inningLabel, etDateStr } from '../data/mlbLiveFeed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3210;
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
let liveCache = { at: 0, board: [] };

// Map Kalshi's grouped MLB games into board candidates (one per priced team side),
// tagged verified + source so the UI can badge them 🟢 and never confuse them with sim.
const LIVE_PLAY_WINDOW_MS = 4 * 3600e3; // a game is "in progress" for ~4h after first pitch

function mlbGamesToCandidates(games, now = Date.now()) {
  const board = [];
  for (const g of games) {
    for (const s of g.sides) {
      if (s.priceCents == null) continue; // never invent a price
      const other = g.sides.find((x) => x.ticker !== s.ticker);
      const tradeable = s.status === 'active' || s.status === 'open';
      // "Live now" heuristic from Kalshi data alone: first pitch has passed, the market
      // is still open, and we're inside the typical play window. Real inning/score comes
      // with the MLB feed (Phase 2). null start time => unknown, treat as not-yet-live.
      const startMs = s.occurrenceTime ? Date.parse(s.occurrenceTime) : NaN;
      const started = Number.isFinite(startMs) && startMs <= now;
      const live = started && tradeable && (now - startMs <= LIVE_PLAY_WINDOW_MS);
      board.push({
        id: s.ticker,
        team: s.team,
        opponent: other?.team ?? null,
        ticker: s.ticker,
        kind: 'single',
        priceCents: s.priceCents,
        gameState: live ? '🔴 LIVE' : null, // real inning/score arrives with the MLB feed
        live,
        startTime: s.occurrenceTime ?? null,
        status: tradeable ? 'open' : (s.status ?? 'open'),
        verified: true,
        source: 'KALSHI',
      });
    }
  }
  return board;
}

// Overlay authoritative MLB game state (live?/inning/score) onto the Kalshi board.
// MLB StatsAPI wins over the unreliable Kalshi scheduled-start heuristic; if it's
// unreachable we silently keep the heuristic so the board still works.
async function annotateLive(board, nowMs) {
  let games;
  try { games = await fetchLiveGames(etDateStr(nowMs)); }
  catch { return; }
  for (const c of board) {
    const g = findGameFor(games, nickFromKalshi(c.team), nickFromKalshi(c.opponent));
    if (!g) continue;
    c.mlbMatched = true;
    if (g.state === 'Live') {
      c.live = true;
      c.gameState = `${inningLabel(g)} · ${g.away} ${g.awayScore}–${g.homeScore} ${g.home}`;
    } else if (g.state === 'Final') {
      c.live = false;
      c.gameState = `Final · ${g.away} ${g.awayScore}–${g.homeScore} ${g.home}`;
    } else {
      c.live = false; // Preview / scheduled — not started yet, keep the start time
      c.gameState = null;
    }
  }
}

async function liveMlbBoard({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - liveCache.at < LIVE_TTL_MS && liveCache.board.length) return liveCache.board;
  // Today's slate: games in progress (started up to 6h ago) through the next ~20h.
  const games = await kalshiProvider().listMlbGames({
    status: 'open', limit: 300, withinHoursBehind: 6, withinHoursAhead: 20,
  });
  const board = mlbGamesToCandidates(games, kalshiProvider().serverNow());
  await annotateLive(board, kalshiProvider().serverNow());
  liveCache = { at: now, board };
  return board;
}

function liveBaseLabel(url) {
  if (url === KALSHI_PROD || url?.includes('elections.kalshi.com')) return 'PRODUCTION';
  if (url === KALSHI_DEMO || url?.includes('demo.kalshi')) return 'DEMO';
  return url ?? 'PRODUCTION';
}

// ---- state: loaded from disk on boot, saved after every change ------------
let engine;
let simHistory;   // SIMULATION decision history — kept SEPARATE from any live history
let missed;       // 👻 missed-opportunity ledger
let liveBoard;    // 🔴 games "in progress" you can jump into (simulated; a live feed fills this later)

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

const saved = loadState(STATE_FILE);
if (saved && saved.engine) {
  engine = SimEngine.fromState(saved.engine);
  simHistory = Array.isArray(saved.simHistory) ? saved.simHistory : [];
  missed = Array.isArray(saved.missed) ? saved.missed : [];
  liveBoard = Array.isArray(saved.liveBoard) && saved.liveBoard.length ? saved.liveBoard : generateLiveBoard();
  console.log(`↺ restored state: ${engine.positions.length} positions, ${simHistory.length} decisions, ${missed.length} missed`);
} else {
  engine = newEngine({ startingDollars: 100, targetDollars: 5 });
  simHistory = [];
  missed = [];
  liveBoard = generateLiveBoard();
}

// Teams (and their opponents) currently in open positions — kept out of new slates.
function heldTeams() {
  const s = new Set();
  for (const p of engine.positions) {
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
  saveState(STATE_FILE, { version: 1, engine: engine.toState(), simHistory, missed, liveBoard });
}

// minSample: 3 so the profile activates after a few games in a price bucket.
const historicalEngine = () => new HistoricalDecisionEngine(simHistory, { minSample: 3 });

// 👻 Missed-opportunity ledger: picks you were shown but skipped.
// regret = profit left on the table by skipped WINS; dodged = stake spared on skipped LOSSES.
function missedSummary() {
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
function recordDecision(pos) {
  if (!pos) return;
  const committed = pos.committedCents ?? ((pos.costCents ?? 0) + (pos.entryFeeCents ?? 0));
  simHistory.push({
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
function resolveCandidate(c, i) {
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
const api = {
  'GET /api/state': () => {
    const snapshot = engine.snapshot();
    return { snapshot, goalPath: computeGoalPath(snapshot) };
  },

  'POST /api/reset': (body) => {
    engine = newEngine({
      startingDollars: body.startingDollars ?? 100,
      targetDollars: body.targetDollars ?? 5,
    });
    return { snapshot: engine.snapshot() };
  },

  // Full clean slate: new bankroll AND wipe decision history, missed ledger, live board.
  'POST /api/clear': (body) => {
    engine = newEngine({
      startingDollars: body.startingDollars ?? 100,
      targetDollars: body.targetDollars ?? 5,
    });
    simHistory.length = 0;
    missed.length = 0;
    liveBoard = generateLiveBoard();
    return { snapshot: engine.snapshot() };
  },

  'POST /api/price': (body) => {
    engine.setPrice(String(body.ticker), int(body.priceCents));
    return { snapshot: engine.snapshot() };
  },

  'POST /api/open': (body) => {
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

  'POST /api/close': (body) => {
    recordDecision(engine.close(String(body.id), int(body.exitPriceCents)));
    return { snapshot: engine.snapshot() };
  },

  'POST /api/settle': (body) => {
    recordDecision(engine.settle(String(body.id), body.outcome === 'win' ? 'win' : 'loss'));
    return { snapshot: engine.snapshot() };
  },

  'POST /api/gamestate': (body) => {
    engine.setGameState(String(body.id), String(body.gameState ?? ''));
    return { snapshot: engine.snapshot() };
  },

  'GET /api/postgame': () => ({
    postgame: sessionPostGame(engine.positions, { targetCents: engine.targetCents }),
  }),

  'POST /api/pregame': (body) => {
    const board = addCombos((body.board ?? []).map(resolveCandidate));
    const mode = body.mode === 'LIVE' ? 'LIVE' : 'SIMULATION';
    return { pregame: buildPreGameReport(engine.snapshot(), board, { feeRate: engine.feeRate, historical: historicalEngine(), mode, ...sizingOpts(body) }) };
  },

  'POST /api/livegame': (body) => ({
    livegame: buildPreGameReport(engine.snapshot(), liveBoard, { feeRate: engine.feeRate, historical: historicalEngine(), ...sizingOpts(body) }),
  }),

  'POST /api/livegame/refresh': (body) => {
    driftLiveBoard();
    return { livegame: buildPreGameReport(engine.snapshot(), liveBoard, { feeRate: engine.feeRate, historical: historicalEngine(), ...sizingOpts(body) }) };
  },

  // Pull a fresh random daily slate of live games.
  'POST /api/livegame/new': (body) => {
    liveBoard = generateLiveBoard(heldTeams());
    return { livegame: buildPreGameReport(engine.snapshot(), liveBoard, { feeRate: engine.feeRate, historical: historicalEngine(), ...sizingOpts(body) }) };
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
    return { livegame: buildPreGameReport(engine.snapshot(), liveBoard, { feeRate: engine.feeRate, historical: historicalEngine(), ...sizingOpts(body) }) };
  },

  // ---- LIVE Kalshi board (real prices, read-only) -------------------------
  // Config/connectivity status for the UI's live-mode banner. No secrets returned.
  'GET /api/live/status': () => {
    const p = kalshiProvider();
    return {
      live: {
        configured: p.isConfigured,
        source: p.source,
        base: liveBaseLabel(p.baseUrl),
        verified: p.verified,
        note: p.isConfigured
          ? 'Read-only live prices. The app never places orders.'
          : '🔴 NOT VERIFIED — add Kalshi credentials to .env (see KALSHI_SETUP.md).',
      },
    };
  },

  // Real MLB board from Kalshi, ranked by the same edge/EV engine. mode: 'LIVE'.
  'POST /api/live/board': async (body) => {
    const board = await liveMlbBoard();
    return {
      livegame: buildPreGameReport(engine.snapshot(), board, {
        feeRate: engine.feeRate, historical: historicalEngine(), mode: 'LIVE', ...sizingOpts(body),
      }),
      candidates: board, // raw real-price board so ranking/pre-game/replacements can reuse it
      asOf: new Date(liveCache.at).toISOString(),
      priced: board.length,
      source: 'KALSHI',
      base: liveBaseLabel(kalshiProvider().baseUrl),
    };
  },

  // Sync OPEN positions to live data: real Kalshi price (by ticker) + real MLB game
  // state (inning/score, by matchup). Read-only — never auto-settles; the user decides.
  'POST /api/live/sync': async () => {
    const board = await liveMlbBoard();
    const priceByTicker = new Map(board.map((c) => [c.ticker, c.priceCents]));
    let games = [];
    try { games = await fetchLiveGames(etDateStr(kalshiProvider().serverNow())); } catch { /* keep going */ }
    let priced = 0, stated = 0;
    for (const p of engine.positions) {
      if (p.status !== 'open') continue;
      const px = priceByTicker.get(p.ticker);
      if (px != null) { engine.setPrice(p.ticker, px); priced++; }
      const g = findGameFor(games, nickFromKalshi(p.team), nickFromKalshi(p.opponent));
      if (g) {
        const gs = g.state === 'Live' ? `${inningLabel(g)} · ${g.away} ${g.awayScore}–${g.homeScore} ${g.home}`
          : g.state === 'Final' ? `Final · ${g.away} ${g.awayScore}–${g.homeScore} ${g.home}`
          : null;
        if (gs) { engine.setGameState(p.id, gs); stated++; }
      }
    }
    const snapshot = engine.snapshot();
    return { snapshot, goalPath: computeGoalPath(snapshot), synced: { priced, stated } };
  },

  // Force a fresh pull (bypass the cache), e.g. on "u"/"update"/"refresh".
  'POST /api/live/refresh': async (body) => {
    const board = await liveMlbBoard({ force: true });
    return {
      livegame: buildPreGameReport(engine.snapshot(), board, {
        feeRate: engine.feeRate, historical: historicalEngine(), mode: 'LIVE', ...sizingOpts(body),
      }),
      candidates: board, // raw real-price board so ranking/pre-game/replacements can reuse it
      asOf: new Date(liveCache.at).toISOString(),
      priced: board.length,
      source: 'KALSHI',
      base: liveBaseLabel(kalshiProvider().baseUrl),
    };
  },

  'POST /api/replacements': (body) => {
    const board = addCombos((body.board ?? []).map(resolveCandidate));
    return { replacements: findReplacements(engine.snapshot(), board, { feeRate: engine.feeRate, historical: historicalEngine(), ...sizingOpts(body) }) };
  },

  'GET /api/history': () => {
    const items = simHistory;
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
        kinds: historicalEngine().kindSummary(),
      },
    };
  },

  'GET /api/missed': () => ({ missed: missedSummary() }),

  'POST /api/missed/log': (body) => {
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
    return { missed: missedSummary() };
  },

  'POST /api/missed/resolve': (body) => {
    const m = missed.find((x) => x.id === String(body.id));
    if (!m) throw new Error(`no missed item ${body.id}`);
    m.status = body.outcome === 'win' ? 'won' : 'lost';
    m.resolvedAt = new Date().toISOString();
    return { missed: missedSummary() };
  },

  'POST /api/missed/clear': () => {
    missed.length = 0;
    return { missed: missedSummary() };
  },

  'POST /api/rank': (body) => {
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
    const result = engine.rankBoard(board, { stakeCents, historical: historicalEngine() });
    return { ranking: result, stakeCents };
  },
};

// Routes that change state and must be persisted after handling.
const MUTATING = new Set([
  '/api/reset', '/api/clear', '/api/price', '/api/open', '/api/close', '/api/settle', '/api/gamestate',
  '/api/missed/log', '/api/missed/resolve', '/api/missed/clear',
  '/api/livegame/refresh', '/api/livegame/tick', '/api/livegame/new', '/api/live/sync',
]);

// ---- request routing ------------------------------------------------------
const server = createServer(async (req, res) => {
  try {
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
    const result = await handler(body);
    if (MUTATING.has(url.pathname)) persist();
    return sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: err.message });
  }
});

server.listen(PORT, () => {
  const p = kalshiProvider();
  const live = p.isConfigured ? `🟢 LIVE ready (${liveBaseLabel(p.baseUrl)}, read-only)` : '⚪ live not configured';
  console.log(`Sports Trading App running at http://localhost:${PORT}  —  ${live}`);
});
