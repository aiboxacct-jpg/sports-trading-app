import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SimEngine } from '../src/engine/simEngine.js';
import { computeGoalPath } from '../src/report/goalPath.js';

test('NO_POSITIONS when nothing is open and target unmet', () => {
  const eng = new SimEngine({ startingBankrollCents: 5000, targetCents: 500 });
  const g = computeGoalPath(eng.snapshot());
  assert.equal(g.state, 'NO_POSITIONS');
  assert.equal(g.distanceCents, 500);
});

test('LOCK_AVAILABLE names the minimal set of exits to secure the target', () => {
  const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 });
  eng.setPrice('A', 50).setPrice('B', 50);
  eng.open({ ticker: 'A', team: 'A', entryPriceCents: 50, contracts: 100 });
  eng.open({ ticker: 'B', team: 'B', entryPriceCents: 50, contracts: 100 });
  // Push A far enough that exiting A alone clears the +$5 target.
  eng.setPrice('A', 62);
  const g = computeGoalPath(eng.snapshot());
  assert.equal(g.state, 'LOCK_AVAILABLE');
  assert.equal(g.lockPlan.length, 1);        // A alone is enough — minimal set
  assert.equal(g.lockPlan[0].team, 'A');
  assert.ok(g.lockReachesTarget);
});

test('HOLD_TO_REACH when a win still reaches the target but exiting now does not', () => {
  const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 });
  eng.setPrice('A', 40);
  eng.open({ ticker: 'A', team: 'A', entryPriceCents: 40, contracts: 100 }); // win pays 100*100-cost
  // Price barely up: exiting now is tiny, but a win yields ~ +$59.
  eng.setPrice('A', 41);
  const g = computeGoalPath(eng.snapshot());
  assert.equal(g.state, 'HOLD_TO_REACH');
  assert.ok(g.holdBestCaseCents >= 500);
});

test('NEED_NEW_ENTRY when even winning everything falls short', () => {
  const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 });
  eng.setPrice('A', 96);
  eng.open({ ticker: 'A', team: 'A', entryPriceCents: 96, contracts: 5 }); // win pays 500-480-fee < 500
  eng.setPrice('A', 96);
  const g = computeGoalPath(eng.snapshot());
  assert.equal(g.state, 'NEED_NEW_ENTRY');
  assert.ok(g.holdBestCaseCents < 500);
});

test('ACHIEVED once realized profit meets the target', () => {
  const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 });
  eng.setPrice('A', 40);
  const p = eng.open({ ticker: 'A', team: 'A', entryPriceCents: 40, contracts: 100 });
  eng.close(p.id, 50); // realize > $5
  const g = computeGoalPath(eng.snapshot());
  assert.equal(g.state, 'ACHIEVED');
});
