import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rankBoard, evaluateCandidate, DEFAULT_WEIGHTS } from '../src/ranking/actionRanking.js';
import { HistoricalDecisionEngine, priceBucket } from '../src/ranking/historicalDecisionEngine.js';
import { SimEngine } from '../src/engine/simEngine.js';

const ctx = () => ({ stakeCents: 1000, targetCents: 500, weights: DEFAULT_WEIGHTS });

test('unpriced and closed markets are excluded, never ranked', () => {
  const board = [
    { id: 'a', team: 'A', priceCents: 50, status: 'open' },
    { id: 'b', team: 'B', priceCents: null, status: 'open' },       // no price
    { id: 'c', team: 'C', priceCents: 50, status: 'final' },        // closed
  ];
  const { ranked, excluded } = rankBoard(board, ctx());
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, 'a');
  assert.deepEqual(excluded.map((e) => e.id).sort(), ['b', 'c']);
  assert.match(excluded.find((e) => e.id === 'b').reason, /NOT VERIFIED/);
});

test('ranking assigns medals in score order', () => {
  const board = [
    { id: 'fav', team: 'Fav', priceCents: 80, status: 'open' },
    { id: 'mid', team: 'Mid', priceCents: 50, status: 'open' },
    { id: 'dog', team: 'Dog', priceCents: 15, status: 'open' },
  ];
  const { ranked } = rankBoard(board, ctx());
  assert.deepEqual(ranked.map((r) => r.medal), ['🥇', '🥈', '🥉']);
  // scores must be non-increasing
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].score >= ranked[i].score);
  }
});

test('economics: potential profit and reward/risk computed net of fees', () => {
  const [item] = rankBoard([{ id: 'x', team: 'X', priceCents: 50, status: 'open' }], ctx()).ranked;
  // stake 1000 @ 50¢ -> 20 contracts, cost 1000, entry fee tradeFee(20,50)=35
  assert.equal(item.contracts, 20);
  assert.equal(item.riskCents, 1000 + 35);
  assert.equal(item.potentialProfitCents, 20 * 50 - 35); // 20*(100-50) - 35 = 965
  assert.equal(item.rewardPerRisk, Math.round((965 / 1035) * 100) / 100);
});

test('a longshot does not automatically top a favorite (confidence matters)', () => {
  // Pure reward/risk would love the 10¢ dog; confidence weight should stop it winning.
  const board = [
    { id: 'dog', team: 'Dog', priceCents: 10, status: 'open' },
    { id: 'solid', team: 'Solid', priceCents: 45, status: 'open' },
  ];
  const { ranked } = rankBoard(board, ctx());
  assert.equal(ranked[0].id, 'solid');
});

test('combo price is the product of leg probabilities', () => {
  const combo = {
    id: 'combo', kind: 'combo', status: 'open',
    legs: [{ team: 'A', priceCents: 50 }, { team: 'B', priceCents: 40 }],
  };
  const item = evaluateCandidate(combo, { ...ctx(), weights: DEFAULT_WEIGHTS });
  assert.equal(item.priceCents, 20);            // 0.5 * 0.4 = 0.20
  assert.equal(item.marketProbabilityPct, 20);
});

test('combo with an unpriced leg is excluded', () => {
  const board = [{
    id: 'combo', kind: 'combo', status: 'open',
    legs: [{ team: 'A', priceCents: 50 }, { team: 'B', priceCents: null }],
  }];
  const { ranked, excluded } = rankBoard(board, ctx());
  assert.equal(ranked.length, 0);
  assert.match(excluded[0].reason, /NOT VERIFIED/);
});

test('historical fit says "insufficient" below the sample threshold', () => {
  const hist = new HistoricalDecisionEngine([
    { kind: 'single', entryPriceCents: 50, won: true, realizedPureProfitCents: 300 },
  ]);
  const board = [{ id: 'x', team: 'X', priceCents: 50, status: 'open' }];
  const { ranked } = rankBoard(board, { ...ctx(), historical: hist });
  assert.match(ranked[0].historicalFit, /Insufficient/);
  assert.equal(ranked[0].historicalScoreKnown, false);
});

test('historical fit reports a real win rate once enough data exists', () => {
  const decisions = Array.from({ length: 6 }, (_, i) => ({
    kind: 'single', entryPriceCents: 50,
    won: i < 4, realizedPureProfitCents: i < 4 ? 300 : -500,
  }));
  const hist = new HistoricalDecisionEngine(decisions);
  const fit = hist.fitFor({ kind: 'single', priceCents: 55 });
  assert.equal(fit.sampleSize, 6);
  assert.equal(fit.score, 4 / 6);
  assert.match(fit.rationale, /4\/6 won/);
});

test('priceBucket boundaries', () => {
  assert.equal(priceBucket(33), 'low');
  assert.equal(priceBucket(34), 'mid');
  assert.equal(priceBucket(66), 'mid');
  assert.equal(priceBucket(67), 'high');
});

test('SimEngine.rankBoard resolves prices from its market provider', () => {
  const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 });
  eng.setPrice('T1', 55).setPrice('T2', 40);
  const board = [
    { id: '1', team: 'One', ticker: 'T1', status: 'open' },
    { id: '2', team: 'Two', ticker: 'T2', status: 'open' },
    { id: '3', team: 'Three', ticker: 'UNKNOWN', status: 'open' }, // no price set
  ];
  const { ranked, excluded } = eng.rankBoard(board, { stakeCents: 1000 });
  assert.equal(ranked.length, 2);
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].id, '3');
});
