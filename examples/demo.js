// demo.js — a scripted SIMULATION walkthrough. All numbers here are hypothetical.
//   node examples/demo.js
//
// It reproduces the spec's example (Giants single, Dodgers single) on a $100
// simulated bankroll with the default +$5 target, then walks a price move,
// an early exit, and a settlement — printing the report at each step.

import { SimEngine } from '../src/engine/simEngine.js';
import { renderSimReport } from '../src/report/simReport.js';

const step = (label) => console.log(`\n\n########## ${label} ##########`);

const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 }); // $100 bankroll, +$5 target

// --- Opening two single positions (hypothetical prices) ---------------------
eng.setPrice('MLB-GIANTS-YES', 55).setPrice('MLB-DODGERS-YES', 45);

const giants = eng.open({
  ticker: 'MLB-GIANTS-YES', team: 'Giants', opponent: 'Dodgers',
  kind: 'single', entryPriceCents: 55, stakeCents: 1000,          // $10
  gameStateAtEntry: 'Pre-game',
});
eng.open({
  ticker: 'MLB-DODGERS-YES', team: 'Dodgers', opponent: 'Giants',
  kind: 'single', entryPriceCents: 45, stakeCents: 1000,          // $10
  gameStateAtEntry: 'Pre-game',
});

step('1) Positions opened');
console.log(renderSimReport(eng.snapshot()));

// --- Giants rally: market moves in our favor -------------------------------
step('2) Giants rally to 72¢ / Dodgers slip to 28¢');
eng.setPrice('MLB-GIANTS-YES', 72).setPrice('MLB-DODGERS-YES', 28);
console.log(renderSimReport(eng.snapshot()));

// --- Bank the Giants gain early --------------------------------------------
step('3) Exit Giants at 72¢ (realize pure profit)');
eng.close(giants.id, 72);
console.log(renderSimReport(eng.snapshot()));

// --- Let the Dodgers position ride to a losing settlement ------------------
step('4) Dodgers settle LOSS');
eng.settle('sim-2', 'loss');
console.log(renderSimReport(eng.snapshot()));
