import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SimEngine } from '../src/engine/simEngine.js';
import { KalshiMarketProvider } from '../src/data/kalshiMarketProvider.js';

test('SimEngine refuses to run without a user-set bankroll', () => {
  assert.throws(() => new SimEngine({}));
});

test('cash and equity identities hold across open/close/settle', () => {
  const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 });
  eng.setPrice('GIANTS', 55).setPrice('DODGERS', 45);
  const g = eng.open({ ticker: 'GIANTS', team: 'Giants', opponent: 'Dodgers', entryPriceCents: 55, stakeCents: 1000 });
  eng.open({ ticker: 'DODGERS', team: 'Dodgers', opponent: 'Giants', entryPriceCents: 45, stakeCents: 1000 });

  let s = eng.snapshot();
  // cash = starting - committed(open) + realized
  assert.equal(
    s.bankroll.currentCashCents,
    s.bankroll.startingBankrollCents - s.bankroll.committedCents + s.bankroll.realizedPureProfitCents,
  );
  // equity = starting + realized + unrealized
  assert.equal(
    s.bankroll.equityCents,
    s.bankroll.startingBankrollCents + s.bankroll.realizedPureProfitCents + s.bankroll.unrealizedPureProfitCents,
  );

  // Giants rallies; close it, Dodgers lose at settlement.
  eng.setPrice('GIANTS', 72);
  eng.close(g.id, 72);
  eng.settle('sim-2', 'loss');

  s = eng.snapshot();
  assert.equal(s.bankroll.openCount, 0);
  // identities still hold with everything closed
  assert.equal(
    s.bankroll.currentCashCents,
    s.bankroll.startingBankrollCents + s.bankroll.realizedPureProfitCents,
  );
  assert.equal(s.bankroll.equityCents, s.bankroll.currentCashCents);
});

test('unknown price marks a position unpriced (NOT VERIFIED), never invented', () => {
  const eng = new SimEngine({ startingBankrollCents: 5000 });
  eng.open({ ticker: 'MYSTERY', team: 'Rays', entryPriceCents: 40, contracts: 10 });
  const s = eng.snapshot();
  assert.deepEqual(s.bankroll.unpriced, ['sim-1']);
  assert.equal(s.bankroll.unrealizedPureProfitCents, 0); // excluded from mark-to-market
  assert.equal(s.positions[0].currentPriceCents, null);
});

test('target flips to AVAILABLE when an open position could be exited for >= target', () => {
  const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 });
  eng.setPrice('A', 40);
  eng.open({ ticker: 'A', entryPriceCents: 40, contracts: 100 }); // cost 4000
  assert.equal(eng.snapshot().target.state, 'TARGET NOT REACHED');
  // +7¢ (47) is only ~$3.57 after fees — still short. +12¢ (52) clears the $5 target.
  eng.setPrice('A', 47);
  assert.equal(eng.snapshot().target.state, 'TARGET NOT REACHED');
  eng.setPrice('A', 52); // +12¢ * 100 = +1200 gross, ~$8.57 after fees
  assert.equal(eng.snapshot().target.state, 'TARGET AVAILABLE');
});

test('closing to bank the profit moves target to REALIZED', () => {
  const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 });
  eng.setPrice('A', 40);
  const p = eng.open({ ticker: 'A', entryPriceCents: 40, contracts: 100 });
  eng.close(p.id, 50); // +1000 gross, minus fees
  const s = eng.snapshot();
  assert.equal(s.target.state, 'TARGET REALIZED');
  assert.ok(s.bankroll.realizedPureProfitCents >= 500);
});

test('price journey records entry, each move, and the exit', () => {
  const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 });
  eng.setPrice('T', 50);
  const p = eng.open({ ticker: 'T', team: 'A', entryPriceCents: 50, contracts: 10, gameStateAtEntry: 'Top 1' });
  eng.setPrice('T', 55);
  eng.setPrice('T', 60);
  eng.close(p.id, 62);
  const j = eng.positions[0].priceJourney;
  assert.deepEqual(j.map((x) => x.priceCents), [50, 55, 60, 62]);
  assert.equal(j.at(-1).label, 'Exit');
});

test('settle appends a final 100 (win) or 0 (loss) point', () => {
  const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 });
  eng.setPrice('T', 40);
  const p = eng.open({ ticker: 'T', team: 'A', entryPriceCents: 40, contracts: 10 });
  eng.setPrice('T', 45);
  eng.settle(p.id, 'win');
  assert.equal(eng.positions[0].priceJourney.at(-1).priceCents, 100);
  assert.equal(eng.positions[0].priceJourney.at(-1).label, 'Final W');
});

test('KalshiMarketProvider returns null (NOT VERIFIED) while unconfigured', () => {
  const k = new KalshiMarketProvider({ apiKeyId: null, privateKeyPem: null });
  assert.equal(k.isConfigured, false);
  assert.equal(k.verified, false);
  assert.equal(k.getPrice('ANY'), null);
  assert.throws(() => k.assertConfigured());
});
