import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findReplacements } from '../src/ranking/dynamicReplacement.js';
import { addCombos } from '../src/report/preGameReport.js';
import { SimEngine } from '../src/engine/simEngine.js';

test('flags a higher-probability leg when the held position slumps', () => {
  const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 });
  eng.setPrice('HELD', 55);
  const p = eng.open({ team: 'Held', ticker: 'HELD', kind: 'single', entryPriceCents: 55, stakeCents: 1000 });
  eng.setPrice('HELD', 30); // slumped -> now a low-probability underdog
  const board = addCombos([
    { id: 'held', team: 'Held', ticker: 'HELD', priceCents: 30, status: 'open' }, // same leg -> excluded
    { id: 'fav', team: 'Favorite', ticker: 'FAV', priceCents: 65, status: 'open' },
  ]);
  const { suggestions } = findReplacements(eng.snapshot(), board, {});
  const s = suggestions.find((x) => x.positionId === p.id);
  assert.ok(s, 'expected a replacement suggestion');
  assert.equal(s.better.team, 'Favorite');           // favorites-first: swap up in probability
  assert.ok(s.scoreGain >= 5);                        // beats the default margin
});

test('never suggests a combo that reuses a held leg', () => {
  const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 });
  eng.setPrice('HELD', 30);
  eng.open({ team: 'Held', ticker: 'HELD', kind: 'single', entryPriceCents: 30, contracts: 5 });
  const board = addCombos([
    { id: 'held', team: 'Held', ticker: 'HELD', priceCents: 30, status: 'open' },
    { id: 'fav', team: 'Favorite', ticker: 'FAV', priceCents: 65, status: 'open' },
  ]); // addCombos makes a "Held + Favorite" combo — must be filtered out
  const { suggestions } = findReplacements(eng.snapshot(), board, {});
  for (const s of suggestions) assert.ok(!String(s.better.team).includes('Held'));
});

test('no suggestion when the held favorite outranks everything on the board', () => {
  const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 });
  eng.setPrice('A', 65);
  eng.open({ team: 'A', ticker: 'A', kind: 'single', entryPriceCents: 65, stakeCents: 1000 });
  const board = [{ id: 'b', team: 'B', ticker: 'B', priceCents: 30, status: 'open' }]; // underdog, worse
  const { suggestions } = findReplacements(eng.snapshot(), board, {});
  assert.equal(suggestions.length, 0);
});

test('no suggestions when there are no open positions', () => {
  const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 });
  const board = [{ id: 'b', team: 'B', ticker: 'B', priceCents: 45, status: 'open' }];
  assert.deepEqual(findReplacements(eng.snapshot(), board, {}).suggestions, []);
});
