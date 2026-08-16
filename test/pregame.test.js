import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stakeForTarget, fixedStake, buildPreGameReport, addCombos } from '../src/report/preGameReport.js';
import { SimEngine } from '../src/engine/simEngine.js';
import { HistoricalDecisionEngine } from '../src/ranking/historicalDecisionEngine.js';

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

test('addCombos generates every 2-leg parlay from priced singles', () => {
  const board = [
    { id: 'a', team: 'A', priceCents: 60, status: 'open' },
    { id: 'b', team: 'B', priceCents: 50, status: 'open' },
    { id: 'c', team: 'C', priceCents: 40, status: 'open' },
    { id: 'd', team: 'D', priceCents: null, status: 'open' }, // unpriced -> not combined
  ];
  const out = addCombos(board);
  const combos = out.filter((c) => c.kind === 'combo');
  assert.equal(combos.length, 3); // C(3,2) from the three priced singles
  const ab = combos.find((c) => c.team === 'A + B');
  assert.deepEqual(ab.legs.map((l) => l.priceCents), [60, 50]);
});

test('combo pricing, payout multiple, and stake-to-target are consistent', () => {
  const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 });
  const board = addCombos([
    { id: 'a', team: 'A', priceCents: 50, status: 'open' },
    { id: 'b', team: 'B', priceCents: 40, status: 'open' },
  ]);
  const pg = buildPreGameReport(eng.snapshot(), board, {});
  const combo = pg.actionRanking.find((r) => r.kind === 'combo');
  assert.equal(combo.priceCents, 20);          // 0.5 * 0.4 = 0.20
  assert.equal(combo.payoutMultiple, 5);       // 100 / 20 = 5×
  const single = pg.actionRanking.find((r) => r.team === 'A');
  assert.equal(single.payoutMultiple, 2);      // 100 / 50 = 2×
  assert.ok(combo.potentialProfitCents >= 500); // combo still sized to clear target
});

test('game state flows through the report (used by the live game board)', () => {
  const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 });
  const board = [{ id: 'a', team: 'Cubs', opponent: 'Cardinals', priceCents: 58, gameState: 'Bot 5 · 2-1 CHC', status: 'open' }];
  const pg = buildPreGameReport(eng.snapshot(), board, {});
  assert.equal(pg.actionRanking[0].gameState, 'Bot 5 · 2-1 CHC');
});

test('edge-first: a bucket where you beat the market shows positive edge and EV', () => {
  // Mid-price singles have won 5/6 (83%) historically — well above a 50¢ market's 50%.
  const decisions = Array.from({ length: 6 }, (_, i) => ({ kind: 'single', entryPriceCents: 50, won: i < 5, realizedPureProfitCents: i < 5 ? 400 : -500 }));
  const hist = new HistoricalDecisionEngine(decisions, { minSample: 3 });
  const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 });
  const pg = buildPreGameReport(eng.snapshot(), [{ id: 'x', team: 'X', priceCents: 50, status: 'open' }], { historical: hist });
  const it = pg.actionRanking[0];
  assert.ok(it.historicallyInformed);
  assert.ok(it.estProbPct > it.marketProbabilityPct); // your rate beats the market
  assert.ok(it.edgePct > 0);
  assert.ok(it.evCents > 0);                            // positive expected value from the edge
});

test('single-vs-combo verdict steers toward the more profitable kind', () => {
  const decisions = [
    ...Array.from({ length: 4 }, () => ({ kind: 'single', entryPriceCents: 50, won: true, realizedPureProfitCents: 400 })),
    ...Array.from({ length: 4 }, () => ({ kind: 'combo', entryPriceCents: 30, won: false, realizedPureProfitCents: -500 })),
  ];
  const s = new HistoricalDecisionEngine(decisions, { minSample: 3 }).kindSummary();
  assert.match(s.verdict, /Favor singles/);
  assert.equal(s.single.n, 4);
  assert.equal(s.combo.n, 4);
});

test('fixedStake buys whole contracts and reports realistic profit', () => {
  const r = fixedStake(71, 100); // $1 at 71¢
  assert.equal(r.contracts, 1);
  assert.equal(r.stakeCents, 71);
  const r2 = fixedStake(12, 100); // $1 at 12¢
  assert.equal(r2.contracts, 8);
  assert.equal(fixedStake(71, 50), null); // 50¢ can't buy a 71¢ contract
});

test('fixed-stake mode sizes to the user dollars, not the target', () => {
  const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 });
  const pg = buildPreGameReport(eng.snapshot(), [{ id: 'x', team: 'X', priceCents: 71, status: 'open' }], { stakeCents: 100, sizeMode: 'fixed' });
  const it = pg.actionRanking[0];
  assert.equal(it.contracts, 1);              // $1 buys one 71¢ contract
  assert.equal(it.stakeForTargetCents, 71);   // committed = actual cost, not $13.49
  assert.ok(it.potentialProfitCents < 500);   // realistic profit, below the +$5 target
  assert.equal(it.reachesTarget, false);
});

test('unaffordable target bet is flagged', () => {
  const eng = new SimEngine({ startingBankrollCents: 500, targetCents: 500 }); // only $5 cash
  const board = [{ id: 'x', team: 'Pricey', priceCents: 64, status: 'open' }];
  const pg = buildPreGameReport(eng.snapshot(), board, {});
  const item = pg.actionRanking[0];
  assert.equal(item.affordable, false);
  assert.match(item.warning, /Not affordable/);
});
