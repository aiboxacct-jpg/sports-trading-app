// rankingDemo.js — rank a hypothetical MLB board. All prices are made up.
//   node examples/rankingDemo.js

import { SimEngine } from '../src/engine/simEngine.js';
import { HistoricalDecisionEngine } from '../src/ranking/historicalDecisionEngine.js';
import { renderRankingReport } from '../src/report/rankingReport.js';

const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 }); // $100, +$5 target

// A made-up board: set hypothetical prices, then describe the candidates.
eng
  .setPrice('MLB-YANKEES', 62)
  .setPrice('MLB-ASTROS', 48)
  .setPrice('MLB-RAYS', 44)
  .setPrice('MLB-BREWERS', 71)
  .setPrice('MLB-MARLINS', 12);

const board = [
  { id: 'nyy', team: 'Yankees', opponent: 'Red Sox', ticker: 'MLB-YANKEES', gameTime: '7:05 PM', gameState: 'Pre-game', status: 'open' },
  { id: 'hou', team: 'Astros', opponent: 'Mariners', ticker: 'MLB-ASTROS', gameTime: '8:10 PM', gameState: 'Pre-game', status: 'open' },
  { id: 'tbr', team: 'Rays', opponent: 'Blue Jays', ticker: 'MLB-RAYS', gameTime: '6:40 PM', gameState: 'Top 2, 0 out', status: 'open' },
  { id: 'mil', team: 'Brewers', opponent: 'Reds', ticker: 'MLB-BREWERS', gameTime: '2:20 PM', gameState: 'Final in 3 innings', status: 'open' },
  { id: 'mia', team: 'Marlins', opponent: 'Braves', ticker: 'MLB-MARLINS', gameTime: '7:20 PM', gameState: 'Pre-game', status: 'open' },
  // A parlay-style combo:
  { id: 'combo1', kind: 'combo', gameTime: 'various', gameState: 'Pre-game', status: 'open',
    legs: [{ team: 'Yankees', ticker: 'MLB-YANKEES' }, { team: 'Brewers', ticker: 'MLB-BREWERS' }] },
  // Something that must be excluded (not verified):
  { id: 'unknown', team: 'Padres', opponent: 'Dodgers', ticker: 'MLB-PADRES', gameTime: '9:40 PM', gameState: 'Pre-game', status: 'open' },
];

console.log('\n===== WITHOUT historical data =====');
console.log(renderRankingReport(eng.rankBoard(board, { stakeCents: 1000 }), { stakeCents: 1000, targetCents: 500 }));

// Now feed hypothetical past decisions so "historical fit" has something to say.
// Buckets: low <34¢, mid 34–66¢, high >66¢. The board's singles (48/44/62¢) and
// the derived combo price (44¢) all land in the MID bucket, so we stock that bucket:
//   mid singles  -> mostly WON  (boosts those singles)
//   mid combos   -> mostly LOST (penalizes the combo)
const hist = new HistoricalDecisionEngine([
  // 6 mid-price singles, 5 wins (83%)
  { kind: 'single', entryPriceCents: 50, won: true, realizedPureProfitCents: 480 },
  { kind: 'single', entryPriceCents: 47, won: true, realizedPureProfitCents: 610 },
  { kind: 'single', entryPriceCents: 55, won: true, realizedPureProfitCents: 300 },
  { kind: 'single', entryPriceCents: 60, won: true, realizedPureProfitCents: 320 },
  { kind: 'single', entryPriceCents: 44, won: true, realizedPureProfitCents: 720 },
  { kind: 'single', entryPriceCents: 62, won: false, realizedPureProfitCents: -1019 },
  // 5 mid-price combos, 1 win (20%)
  { kind: 'combo', entryPriceCents: 40, won: false, realizedPureProfitCents: -800 },
  { kind: 'combo', entryPriceCents: 44, won: false, realizedPureProfitCents: -1006 },
  { kind: 'combo', entryPriceCents: 50, won: false, realizedPureProfitCents: -1000 },
  { kind: 'combo', entryPriceCents: 38, won: true, realizedPureProfitCents: 1600 },
  { kind: 'combo', entryPriceCents: 46, won: false, realizedPureProfitCents: -900 },
]);

console.log('\n\n===== WITH historical data (mid-price singles win, combos do not) =====');
console.log(renderRankingReport(eng.rankBoard(board, { stakeCents: 1000, historical: hist }), { stakeCents: 1000, targetCents: 500 }));
