import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cfbNorm, abbrFromKalshi, isInProgress, quarterLabel, winnerAbbr,
  normalizeScheduleGames, findGameFor, fetchLiveGames, fetchWinProb,
} from '../src/data/cfbLiveFeed.js';

// ESPN college-football-shaped fixture: teams carry a school `location` + `abbreviation`.
const espn = (over = {}) => ({
  events: [{
    date: '2026-09-20T23:25:00Z',
    status: { period: over.period ?? 3, displayClock: over.clock ?? '5:20', type: { state: over.state ?? 'in', name: over.name ?? 'STATUS_IN_PROGRESS' } },
    competitions: [{
      competitors: [
        { homeAway: 'home', team: { abbreviation: 'OSU', location: 'Ohio State', displayName: 'Ohio State Buckeyes' }, score: over.homeScore ?? '21' },
        { homeAway: 'away', team: { abbreviation: 'ORE', location: 'Oregon', displayName: 'Oregon Ducks' }, score: over.awayScore ?? '17' },
      ],
    }],
  }],
});

test('cfbNorm canonicalizes St./State, punctuation, and parentheticals', () => {
  assert.equal(cfbNorm('Ohio St.'), 'ohio state');
  assert.equal(cfbNorm('Ohio State'), 'ohio state');
  assert.equal(cfbNorm('Oregon'), 'oregon');
  assert.equal(cfbNorm('Portland St.'), 'portland state');
  assert.equal(cfbNorm('Texas A&M'), 'texas a and m'); // stable both sides, so it still matches
  assert.equal(cfbNorm('Miami (FL)'), 'miami');   // parenthetical dropped (documented caveat)
  assert.notEqual(cfbNorm('Ohio'), cfbNorm('Ohio State')); // "X" and "X State" stay distinct
});

test('abbrFromKalshi returns the normalized school key', () => {
  assert.equal(abbrFromKalshi('Ohio St.'), 'ohio state');
  assert.equal(abbrFromKalshi('Oregon'), 'oregon');
  assert.equal(abbrFromKalshi(''), null);
});

test('normalizeScheduleGames flattens with display abbr + strict match keys', () => {
  const [g] = normalizeScheduleGames(espn());
  assert.equal(g.away, 'ORE');            // display
  assert.equal(g.home, 'OSU');
  assert.equal(g.awayKey, 'oregon');      // match key from location
  assert.equal(g.homeKey, 'ohio state');
  assert.equal(g.awayScore, 17);
  assert.equal(g.homeScore, 21);
  // find by Kalshi-derived keys, either order
  assert.equal(findGameFor([g], abbrFromKalshi('Oregon'), abbrFromKalshi('Ohio St.')), g);
  assert.equal(findGameFor([g], abbrFromKalshi('Ohio St.'), abbrFromKalshi('Oregon')), g);
  assert.equal(findGameFor([g], 'oregon', 'michigan'), null);
});

test('isInProgress + quarterLabel reflect real play', () => {
  const [live] = normalizeScheduleGames(espn({ state: 'in', period: 3, clock: '5:20' }));
  assert.equal(isInProgress(live), true);
  assert.equal(quarterLabel(live), 'Q3 5:20');
  const [pre] = normalizeScheduleGames(espn({ state: 'pre', name: 'STATUS_SCHEDULED', period: 0 }));
  assert.equal(isInProgress(pre), false);
  const [ot] = normalizeScheduleGames(espn({ state: 'in', period: 5, clock: '1:12' }));
  assert.equal(quarterLabel(ot), 'OT 1:12');
});

test('winnerAbbr returns the winning school KEY (matches teamKey), pushes on a tie', () => {
  const [win] = normalizeScheduleGames(espn({ state: 'post', name: 'STATUS_FINAL', homeScore: '24', awayScore: '20' }));
  assert.equal(winnerAbbr(win), 'ohio state');          // home won -> its key
  assert.equal(winnerAbbr(win), abbrFromKalshi('Ohio St.')); // === teamKey(label): safe auto-settle
  const [tie] = normalizeScheduleGames(espn({ state: 'post', name: 'STATUS_FINAL', homeScore: '20', awayScore: '20' }));
  assert.equal(winnerAbbr(tie), null);
  const [live] = normalizeScheduleGames(espn({ state: 'in' }));
  assert.equal(winnerAbbr(live), null);
});

test('fetchWinProb returns the latest ESPN home win % (0..1)', async () => {
  const okFetch = async () => ({ ok: true, json: async () => ({ winprobability: [{ homeWinPercentage: 0.4 }, { homeWinPercentage: 0.88 }] }) });
  assert.ok(Math.abs(await fetchWinProb({ feedId: '9' }, { fetchImpl: okFetch }) - 0.88) < 1e-9);
  assert.equal(await fetchWinProb({ feedId: null }, { fetchImpl: okFetch }), null);
});

test('fetchLiveGames uses the date param and parses OK', async () => {
  let calledUrl = null;
  const okFetch = async (url) => { calledUrl = url; return { ok: true, json: async () => espn({ state: 'post', homeScore: '30', awayScore: '10' }) }; };
  const games = await fetchLiveGames('2026-09-20', { fetchImpl: okFetch });
  assert.match(calledUrl, /dates=20260920/);
  assert.equal(games[0].homeKey, 'ohio state');
  await assert.rejects(() => fetchLiveGames('2026-09-20', { fetchImpl: async () => ({ ok: false, status: 503 }) }), /503/);
});
