import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tradeFeeCents } from '../src/domain/fees.js';
import { openPosition, valuePosition, settleValue, worstCasePureProfit } from '../src/domain/position.js';
import { evaluateTarget, TARGET_STATES } from '../src/domain/target.js';
import { assertPrice } from '../src/domain/money.js';

test('fees round up to the cent and are zero for no contracts', () => {
  // 18 @ 55¢: 0.07 * 18 * 0.55 * 0.45 = $0.31185 -> ceil -> 32¢
  assert.equal(tradeFeeCents(18, 55), 32);
  assert.equal(tradeFeeCents(0, 55), 0);
  // deepest fee is near 50¢ where P(1-P) peaks: 0.07 * 100 * 0.5 * 0.5 = $1.75 exactly.
  // (Asserting the literal guards the float-drift fix — a naive ceil returns 176.)
  assert.equal(tradeFeeCents(100, 50), 175);
});

test('assertPrice rejects out-of-range and non-integers', () => {
  assert.throws(() => assertPrice(0));
  assert.throws(() => assertPrice(100));
  assert.throws(() => assertPrice(55.5));
  assert.equal(assertPrice(1), 1);
  assert.equal(assertPrice(99), 99);
});

test('openPosition derives contracts from stake via floor', () => {
  const p = openPosition({ ticker: 'X', entryPriceCents: 55, stakeCents: 1000 });
  assert.equal(p.contracts, 18);          // floor(1000/55)
  assert.equal(p.costCents, 18 * 55);     // 990
  assert.equal(p.entryFeeCents, 32);
  assert.equal(p.committedCents, 990 + 32);
});

test('openPosition rejects stakes too small to buy a contract', () => {
  assert.throws(() => openPosition({ ticker: 'X', entryPriceCents: 90, stakeCents: 50 }));
});

test('valuePosition nets entry AND exit fees out of unrealized pure profit', () => {
  const p = openPosition({ ticker: 'X', entryPriceCents: 50, contracts: 100 }); // cost 5000, entry fee 175
  const v = valuePosition(p, 60); // value 6000, exit fee = ceil(0.07*100*0.6*0.4*100)=168
  assert.equal(v.positionValueCents, 6000);
  assert.equal(v.exitFeeCents, tradeFeeCents(100, 60));
  assert.equal(v.unrealizedPureProfitCents, 6000 - 5000 - 175 - v.exitFeeCents);
});

test('settleValue: win pays 100 with no settlement fee; loss forfeits everything', () => {
  const p = openPosition({ ticker: 'X', entryPriceCents: 40, contracts: 10 }); // cost 400, entry fee
  const win = settleValue(p, 'win');
  assert.equal(win.proceedsCents, 1000);
  assert.equal(win.realizedPureProfitCents, 1000 - 400 - p.entryFeeCents);
  const loss = settleValue(p, 'loss');
  assert.equal(loss.proceedsCents, 0);
  assert.equal(loss.realizedPureProfitCents, worstCasePureProfit(p));
  assert.throws(() => settleValue(p, 'nonsense'));
});

test('target machine distinguishes the four states', () => {
  const target = 500;
  // nothing yet
  let r = evaluateTarget({ targetCents: target, realizedPureProfitCents: 0, unrealizedIfExitNowCents: 100, guaranteedWorstCaseCents: -1000 });
  assert.equal(r.state, TARGET_STATES.NOT_REACHED);
  assert.equal(r.shortfallCents, 400);
  // could exit now for >= target but haven't
  r = evaluateTarget({ targetCents: target, realizedPureProfitCents: 0, unrealizedIfExitNowCents: 600, guaranteedWorstCaseCents: -1000 });
  assert.equal(r.state, TARGET_STATES.AVAILABLE);
  assert.equal(r.alert, '🚨🎯 TARGET AVAILABLE');
  // hedged: worst case already covers target
  r = evaluateTarget({ targetCents: target, realizedPureProfitCents: 0, unrealizedIfExitNowCents: 700, guaranteedWorstCaseCents: 550 });
  assert.equal(r.state, TARGET_STATES.LOCKED);
  // actually banked it
  r = evaluateTarget({ targetCents: target, realizedPureProfitCents: 500, unrealizedIfExitNowCents: 0, guaranteedWorstCaseCents: 500 });
  assert.equal(r.state, TARGET_STATES.REALIZED);
  assert.equal(r.alert, '🚨🎯 TARGET ACHIEVED');
});

test('a winning team is NOT a realized target while still open', () => {
  // Big unrealized gain, nothing closed -> AVAILABLE, never REALIZED.
  const r = evaluateTarget({ targetCents: 500, realizedPureProfitCents: 0, unrealizedIfExitNowCents: 9999, guaranteedWorstCaseCents: -1000 });
  assert.equal(r.state, TARGET_STATES.AVAILABLE);
  assert.notEqual(r.state, TARGET_STATES.REALIZED);
});
