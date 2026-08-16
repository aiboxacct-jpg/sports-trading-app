// server.js — a tiny zero-dependency web app to exercise the SimEngine.
//
// Uses only Node built-ins (http, fs, path, url). Holds ONE in-memory SimEngine —
// state resets when the server restarts (persistence is a separate feature).
// Everything here is SIMULATION; it never touches live data or real money.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SimEngine } from '../engine/simEngine.js';
import { toCents } from '../domain/money.js';
import { sessionPostGame } from '../report/postGameReport.js';
import { buildPreGameReport, addCombos } from '../report/preGameReport.js';
import { HistoricalDecisionEngine } from '../ranking/historicalDecisionEngine.js';
import { findReplacements } from '../ranking/dynamicReplacement.js';
import { computeGoalPath } from '../report/goalPath.js';
import { loadState, saveState } from '../data/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3210;
const STATE_FILE = process.env.STATE_FILE || join(__dirname, '../../data/sim-state.json');

// ---- state: loaded from disk on boot, saved after every change ------------
let engine;
let simHistory;   // SIMULATION decision history — kept SEPARATE from any live history
let missed;       // 👻 missed-opportunity ledger
let liveBoard;    // 🔴 games "in progress" you can jump into (simulated; a live feed fills this later)

// Simulated slate of in-progress games. Prices drift on refresh; game states are
// illustrative until a real MLB feed is wired in.
function defaultLiveBoard() {
  return [
    { id: 'lv-cubs', team: 'Cubs', opponent: 'Cardinals', ticker: 'LIVE-CUBS', priceCents: 58, step: 9, gameState: 'Bot 5', status: 'open' },
    { id: 'lv-mets', team: 'Mets', opponent: 'Phillies', ticker: 'LIVE-METS', priceCents: 47, step: 11, gameState: 'Bot 6', status: 'open' },
    { id: 'lv-lad', team: 'Dodgers', opponent: 'Padres', ticker: 'LIVE-LAD', priceCents: 66, step: 13, gameState: 'Bot 7', status: 'open' },
    { id: 'lv-cle', team: 'Guardians', opponent: 'Tigers', ticker: 'LIVE-CLE', priceCents: 39, step: 6, gameState: 'Top 4', status: 'open' },
    { id: 'lv-bal', team: 'Orioles', opponent: 'Rays', ticker: 'LIVE-BAL', priceCents: 52, step: 5, gameState: 'Bot 3', status: 'open' },
  ];
}

// MLB inning label for a live-board step (0..17 = Top 1 .. Bot 9).
function liveInningLabel(step) {
  const s = ((step % 18) + 18) % 18;
  return `${s % 2 === 0 ? 'Top' : 'Bot'} ${Math.floor(s / 2) + 1}`;
}

const saved = loadState(STATE_FILE);
if (saved && saved.engine) {
  engine = SimEngine.fromState(saved.engine);
  simHistory = Array.isArray(saved.simHistory) ? saved.simHistory : [];
  missed = Array.isArray(saved.missed) ? saved.missed : [];
  liveBoard = Array.isArray(saved.liveBoard) && saved.liveBoard.length ? saved.liveBoard : defaultLiveBoard();
  console.log(`↺ restored state: ${engine.positions.length} positions, ${simHistory.length} decisions, ${missed.length} missed`);
} else {
  engine = newEngine({ startingDollars: 100, targetDollars: 5 });
  simHistory = [];
  missed = [];
  liveBoard = defaultLiveBoard();
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
  simHistory.push({
    kind: pos.kind ?? 'single',
    entryPriceCents: pos.entryPriceCents,
    won: pos.realizedPureProfitCents > 0,
    realizedPureProfitCents: pos.realizedPureProfitCents,
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
    gameTime: c.gameTime || null, gameState: c.gameState || null, status: c.status || 'open',
  };
  if (base.kind === 'combo') {
    return { ...base, legs: (c.legs ?? []).map((l) => ({ ...l, priceCents: l.priceCents == null ? (l.ticker ? engine.market.getPrice(l.ticker) : null) : int(l.priceCents) })) };
  }
  return { ...base, ticker: c.ticker, priceCents: c.priceCents == null ? (c.ticker ? engine.market.getPrice(c.ticker) : null) : int(c.priceCents) };
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
    liveBoard = defaultLiveBoard();
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
    return { pregame: buildPreGameReport(engine.snapshot(), board, { feeRate: engine.feeRate, historical: historicalEngine() }) };
  },

  'POST /api/livegame': () => ({
    livegame: buildPreGameReport(engine.snapshot(), liveBoard, { feeRate: engine.feeRate, historical: historicalEngine() }),
  }),

  'POST /api/livegame/refresh': () => {
    driftLiveBoard();
    return { livegame: buildPreGameReport(engine.snapshot(), liveBoard, { feeRate: engine.feeRate, historical: historicalEngine() }) };
  },

  // Advance the live board one clock step: drift prices + move each game's inning.
  // A game that finishes regulation restarts as a fresh matchup so the board stays live.
  'POST /api/livegame/tick': () => {
    for (const g of liveBoard) {
      g.priceCents = Math.max(1, Math.min(99, g.priceCents + Math.round((Math.random() * 2 - 1) * 4)));
      g.step = (g.step ?? 0) + 1;
      if (g.step > 17) { g.step = 0; g.priceCents = 40 + Math.floor(Math.random() * 21); } // new game
      g.gameState = liveInningLabel(g.step);
    }
    return { livegame: buildPreGameReport(engine.snapshot(), liveBoard, { feeRate: engine.feeRate, historical: historicalEngine() }) };
  },

  'POST /api/replacements': (body) => {
    const board = addCombos((body.board ?? []).map(resolveCandidate));
    return { replacements: findReplacements(engine.snapshot(), board, { feeRate: engine.feeRate, historical: historicalEngine() }) };
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
  '/api/missed/log', '/api/missed/resolve', '/api/missed/clear', '/api/livegame/refresh', '/api/livegame/tick',
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

    const handler = api[key];
    if (!handler) return sendJson(res, 404, { error: `no route ${key}` });

    const body = req.method === 'POST' ? await readBody(req) : {};
    const result = handler(body);
    if (MUTATING.has(url.pathname)) persist();
    return sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`⚪ Sports Trading App (SIMULATION) running at http://localhost:${PORT}`);
});
