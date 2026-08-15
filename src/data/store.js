// store.js — dead-simple JSON persistence (zero dependency).
//
// The whole app state is small (a bankroll, a handful of positions, some history),
// so we snapshot it to one JSON file and rewrite it on every change. Writes are
// atomic (temp file + rename) so a crash mid-write can't corrupt the ledger.
// Persistence is best-effort: a failed write logs but never breaks a request.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function loadState(file) {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('state load failed (starting fresh):', e.message);
    return null;
  }
}

export function saveState(file, state) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, file);
  } catch (e) {
    console.error('state save failed (continuing):', e.message);
  }
}
