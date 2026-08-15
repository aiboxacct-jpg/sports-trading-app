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
import { loadState, saveState } from '../data/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3210;
const STATE_FILE = process.env.STATE_FILE || join(__dirname, '../../data/sim-state.json');

// ---- state: loaded from disk on boot, saved after every change ------------
let engine;
let simHistory;   // SIMULATION decision history — kept SEPARATE from any live history
let missed;       // 👻 missed-opportunity ledger

const saved = loadState(STATE_FILE);
if (saved && saved.engine) {
  engine = SimEngine.fromState(saved.engine);
  simHistory = Array.isArray(saved.simHistory) ? saved.simHistory : [];
  missed = Array.isArray(saved.missed) ? saved.missed : [];
  console.log(`↺ restored state: ${engine.positions.length} positions, ${simHistory.length} decisions, ${missed.length} missed`);
} else {
  engine = newEngine({ startingDollars: 100, targetDollars: 5 });
  simHistory = [];
  missed = [];
}

function persist() {
  saveState(STATE_FILE, { version: 1, engine: engine.toState(), simHistory, missed });
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
  'GET /api/state': () => ({ snapshot: engine.snapshot() }),

  'POST /api/reset': (body) => {
    engine = newEngine({
      startingDollars: body.startingDollars ?? 100,
      targetDollars: body.targetDollars ?? 5,
    });
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
  '/api/reset', '/api/price', '/api/open', '/api/close', '/api/settle', '/api/gamestate',
  '/api/missed/log', '/api/missed/resolve', '/api/missed/clear',
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
