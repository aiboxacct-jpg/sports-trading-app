import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findReplacements } from '../src/ranking/dynamicReplacement.js';
import { addCombos } from '../src/report/preGameReport.js';
import { SimEngine } from '../src/engine/simEngine.js';

test('flags a better available leg once the held price is expensive', () => {
  const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 });
  eng.setPrice('HELD', 55);
  const p = eng.open({ team: 'Held', ticker: 'HELD', kind: 'single', entryPriceCents: 55, stakeCents: 1000 });
  eng.setPrice('HELD', 90); // now an expensive, low-value fresh entry
  const board = addCombos([
    { id: 'held', team: 'Held', ticker: 'HELD', priceCents: 90, status: 'open' }, // same leg -> excluded
    { id: 'alt', team: 'Cheap', ticker: 'CHEAP', priceCents: 45, status: 'open' },
  ]);
  const { suggestions } = findReplacements(eng.snapshot(), board, {});
  const s = suggestions.find((x) => x.positionId === p.id);
  assert.ok(s, 'expected a replacement suggestion');
  assert.notEqual(s.better.team, 'Held');           // never suggests what you already hold
  assert.ok(s.scoreGain >= 5);                       // beats the default margin
});

test('never suggests a combo that reuses a held leg', () => {
  const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 });
  eng.setPrice('HELD', 90);
  eng.open({ team: 'Held', ticker: 'HELD', kind: 'single', entryPriceCents: 90, contracts: 5 });
  const board = addCombos([
    { id: 'held', team: 'Held', ticker: 'HELD', priceCents: 90, status: 'open' },
    { id: 'alt', team: 'Cheap', ticker: 'CHEAP', priceCents: 45, status: 'open' },
  ]); // addCombos makes a "Held + Cheap" combo — must be filtered out
  const { suggestions } = findReplacements(eng.snapshot(), board, {});
  for (const s of suggestions) assert.ok(!String(s.better.team).includes('Held'));
});

test('no suggestion when nothing on the board is better', () => {
  const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 });
  eng.setPrice('A', 45);
  eng.open({ team: 'A', ticker: 'A', kind: 'single', entryPriceCents: 45, stakeCents: 1000 });
  const board = [{ id: 'b', team: 'B', ticker: 'B', priceCents: 92, status: 'open' }];
  const { suggestions } = findReplacements(eng.snapshot(), board, {});
  assert.equal(suggestions.length, 0);
});

test('no suggestions when there are no open positions', () => {
  const eng = new SimEngine({ startingBankrollCents: 10000, targetCents: 500 });
  const board = [{ id: 'b', team: 'B', ticker: 'B', priceCents: 45, status: 'open' }];
  assert.deepEqual(findReplacements(eng.snapshot(), board, {}).suggestions, []);
});
