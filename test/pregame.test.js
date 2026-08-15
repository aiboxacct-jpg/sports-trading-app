import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stakeForTarget, buildPreGameReport } from '../src/report/preGameReport.js';
import { SimEngine } from '../src/engine/simEngine.js';

test('stakeForTarget: the WIN actually clears the target, net of fees', () => {
  // Yankees @59¢, +$5 target. profit/contract = 41¢, ceil(500/41)=13 contracts.
  const r = stakeForTarget(59, 500);
  assert.equal(r.contracts, 13);
  assert.equal(r.stakeCents, 13 * 59);            // 767¢ = $7.67 (NOT $12.20)
  assert.ok(r.potentialProfitCents >= 500);       // clears target after fees
  // sanity: the flawed "target/(1-price)" formula would give ~1220¢ — much larger
  assert.ok(r.stakeCents < 900);
});

test('stakeForTarget at a near-certain price still clears target (just expensive)', () => {
  // 99¢ = 1¢ profit/contract; you need many contracts, but it terminates and clears.
  const r = stakeForTarget(99, 500);
  assert.ok(r.potentialProfitCents >= 500);
  assert.ok(r.contracts > 500);          // lots of contracts needed
  assert.ok(r.stakeCents > 40000);       // and a large stake
});

test('stakeForTarget clears target for a range of prices', () => {
  for (const price of [12, 44, 48, 54, 59, 64]) {
    const r = stakeForTarget(price, 500);
    assert.ok(r.potentialProfitCents >= 500, `price ${price} should reach target`);
  }
});

test('pre-game report ranks, sizes to target, and flags concentration', () => {
  const eng = new SimEngine({ startingBankrollCents: 2000, targetCents: 500 }); // $20 bankroll
  const snap = eng.snapshot();
  const board = [
    { id: 'nyy', team: 'Yankees', opponent: 'Blue Jays', priceCents: 59, gameTime: '7:15 PM', status: 'open' },
    { id: 'atl', team: 'Braves', opponent: 'Diamondbacks', priceCents: 54, gameTime: '7:15 PM', status: 'open' },
    { id: 'sd', team: 'Padres', opponent: 'Guardians', priceCents: 48, gameTime: '6:40 PM', status: 'open' },
    { id: 'bad', team: 'Nobody', priceCents: null, status: 'open' }, // excluded
  ];
  const pg = buildPreGameReport(snap, board, {});
  assert.equal(pg.quickBoard.length, 3);
  assert.equal(pg.excluded.length, 1);
  assert.match(pg.excluded[0].reason, /NOT VERIFIED/);
  // every ranked pick is sized so its win clears the target
  for (const it of pg.actionRanking) assert.ok(it.potentialProfitCents >= 500);
  // capital concentration computed against the $20 cash
  const nyy = pg.actionRanking.find((r) => r.team === 'Yankees');
  assert.equal(nyy.capitalPct, Math.round((nyy.stakeForTargetCents / 2000) * 1000) / 10);
  assert.ok(nyy.capitalPct < 45); // ~38%, NOT the example's bogus 61%
  // decisions list ends with a Wait option
  assert.match(pg.decisions.at(-1), /Wait/);
});

test('unaffordable target bet is flagged', () => {
  const eng = new SimEngine({ startingBankrollCents: 500, targetCents: 500 }); // only $5 cash
  const board = [{ id: 'x', team: 'Pricey', priceCents: 64, status: 'open' }];
  const pg = buildPreGameReport(eng.snapshot(), board, {});
  const item = pg.actionRanking[0];
  assert.equal(item.affordable, false);
  assert.match(item.warning, /Not affordable/);
});
