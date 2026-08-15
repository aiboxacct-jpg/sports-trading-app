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

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3210;

// ---- the one simulated engine this server drives --------------------------
let engine = newEngine({ startingDollars: 100, targetDollars: 5 });

// SIMULATION decision history — accumulates across resets so the engine can learn
// across games, but is kept SEPARATE from any (future) live history. minSample: 3
// so the profile activates after a few games in a price bucket.
const simHistory = [];
const historicalEngine = () => new HistoricalDecisionEngine(simHistory, { minSample: 3 });
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
    return sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`⚪ Sports Trading App (SIMULATION) running at http://localhost:${PORT}`);
});
