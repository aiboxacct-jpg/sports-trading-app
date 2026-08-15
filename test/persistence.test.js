import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadState, saveState } from '../src/data/store.js';
import { SimEngine } from '../src/engine/simEngine.js';

test('store saves and loads state (round-trip), null when missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-'));
  const file = join(dir, 'state.json');
  assert.equal(loadState(file), null); // missing file
  const state = { version: 1, engine: { targetCents: 500 }, simHistory: [{ won: true }], missed: [] };
  saveState(file, state);
  assert.deepEqual(loadState(file), state);
  rmSync(dir, { recursive: true, force: true });
});

test('store returns null on corrupt json instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-'));
  const file = join(dir, 'state.json');
  writeFileSync(file, '{ not valid json');
  assert.equal(loadState(file), null);
  rmSync(dir, { recursive: true, force: true });
});

test('SimEngine survives a toState -> fromState round-trip', () => {
  const eng = new SimEngine({ startingBankrollCents: 2000, targetCents: 500 });
  eng.setPrice('T1', 55).setPrice('T2', 40);
  eng.open({ ticker: 'T1', team: 'A', entryPriceCents: 55, stakeCents: 1000 });
  const p = eng.open({ ticker: 'T2', team: 'B', entryPriceCents: 40, contracts: 10 });
  eng.settle(p.id, 'win');

  const restored = SimEngine.fromState(eng.toState());
  assert.equal(restored.startingBankrollCents, 2000);
  assert.equal(restored.targetCents, 500);
  assert.equal(restored.positions.length, 2);
  assert.equal(restored.market.getPrice('T1'), 55);
  // computed state matches exactly after restore
  assert.deepEqual(restored.snapshot().bankroll, eng.snapshot().bankroll);
  // the id sequence continues — no collision with restored positions
  const next = restored.open({ ticker: 'T1', team: 'C', entryPriceCents: 55, contracts: 5 });
  assert.equal(next.id, 'sim-3');
});
