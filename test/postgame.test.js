import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SimEngine } from '../src/engine/simEngine.js';
import { postGameForPosition, sessionPostGame } from '../src/report/postGameReport.js';

function playedOut() {
  const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 });
  eng.setPrice('WIN', 40).setPrice('LOSE', 45);
  const w = eng.open({ ticker: 'WIN', team: 'Giants', opponent: 'Dodgers', entryPriceCents: 40, contracts: 100 });
  const l = eng.open({ ticker: 'LOSE', team: 'Dodgers', opponent: 'Giants', entryPriceCents: 45, contracts: 100 });
  eng.close(w.id, 55);       // exit for profit
  eng.settle(l.id, 'loss');  // lost at settlement
  return eng;
}

test('post-game refuses positions that are still open', () => {
  const eng = new SimEngine({ startingBankrollCents: 5000 });
  eng.setPrice('X', 50);
  const p = eng.open({ ticker: 'X', entryPriceCents: 50, contracts: 10 });
  assert.throws(() => postGameForPosition(p, {}));
});

test('post-game computes result, realized pure profit and ROI', () => {
  const eng = playedOut();
  const [gia, dod] = eng.positions.map((p) => postGameForPosition(p, { targetCents: 500 }));

  // Giants: 100 @40 -> cost 4000, entry fee 168; exit 55 -> value 5500, exit fee ~174
  assert.equal(gia.result, 'WIN');
  assert.equal(gia.realizedPureProfitCents, eng.positions[0].realizedPureProfitCents);
  assert.equal(gia.roiPct, Math.round((gia.realizedPureProfitCents / gia.stakeCents) * 1000) / 10);
  assert.equal(gia.targetReached, gia.realizedPureProfitCents >= 500);
  assert.equal(gia.exit.type, 'exit');
  assert.equal(gia.exit.priceCents, 55);

  // Dodgers: settled loss -> loses committed
  assert.equal(dod.result, 'LOSS');
  assert.equal(dod.exit.type, 'settlement');
  assert.ok(dod.realizedPureProfitCents < 0);
  assert.ok(dod.roiPct < 0);
});

test('session summary aggregates realized, ROI, wins and losses', () => {
  const eng = playedOut();
  const s = sessionPostGame(eng.positions, { targetCents: 500 });
  assert.equal(s.count, 2);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 1);
  const expectedRealized = eng.positions.reduce((a, p) => a + p.realizedPureProfitCents, 0);
  assert.equal(s.totalRealizedCents, expectedRealized);
  assert.equal(s.targetAchieved, expectedRealized >= 500);
});

test('every finished position gets a non-empty lesson', () => {
  const s = sessionPostGame(playedOut().positions, { targetCents: 500 });
  for (const r of s.reports) assert.ok(r.lesson && r.lesson.length > 0);
});
