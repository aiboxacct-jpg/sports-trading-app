import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  abbrFromKalshi, isInProgress, periodLabel, winnerAbbr,
  normalizeScheduleGames, findGameFor, fetchLiveGames,
} from '../src/data/nhlLiveFeed.js';

const espn = (over = {}) => ({
  events: [{
    date: '2026-10-08T23:00:00Z',
    status: { period: over.period ?? 2, displayClock: over.clock ?? '5:20', type: { state: over.state ?? 'in', name: over.name ?? 'STATUS_IN_PROGRESS' } },
    competitions: [{
      competitors: [
        { homeAway: 'home', team: { abbreviation: 'TOR', displayName: 'Toronto Maple Leafs' }, score: over.homeScore ?? '3' },
        { homeAway: 'away', team: { abbreviation: 'MTL', displayName: 'Montreal Canadiens' }, score: over.awayScore ?? '2' },
      ],
    }],
  }],
});

test('abbrFromKalshi maps NHL cities incl. the two New York teams', () => {
  assert.equal(abbrFromKalshi('Toronto'), 'TOR');
  assert.equal(abbrFromKalshi('New York R'), 'NYR');
  assert.equal(abbrFromKalshi('New York I'), 'NYI');
  assert.equal(abbrFromKalshi('Los Angeles'), 'LA');
  assert.equal(abbrFromKalshi('Vegas'), 'VGK');
  assert.equal(abbrFromKalshi('Nowhere'), null);
});

test('normalizeScheduleGames + findGameFor', () => {
  const [g] = normalizeScheduleGames(espn());
  assert.equal(g.away, 'MTL');
  assert.equal(g.home, 'TOR');
  assert.equal(g.awayScore, 2);
  assert.equal(g.homeScore, 3);
  assert.equal(findGameFor([g], 'TOR', 'MTL'), g);
  assert.equal(findGameFor([g], 'MTL', 'BOS'), null);
});

test('periodLabel covers regulation / OT / shootout / final / pre', () => {
  assert.equal(periodLabel(normalizeScheduleGames(espn({ state: 'in', period: 2, clock: '5:20' }))[0]), 'P2 5:20');
  assert.equal(periodLabel(normalizeScheduleGames(espn({ state: 'in', period: 4, clock: '1:12' }))[0]), 'OT 1:12');
  assert.equal(periodLabel(normalizeScheduleGames(espn({ state: 'in', period: 5 }))[0]), 'Shootout');
  assert.equal(periodLabel(normalizeScheduleGames(espn({ state: 'post', name: 'STATUS_FINAL' }))[0]), 'Final');
  assert.equal(periodLabel(normalizeScheduleGames(espn({ state: 'pre', period: 0 }))[0]), '');
});

test('isInProgress + winnerAbbr', () => {
  const [live] = normalizeScheduleGames(espn({ state: 'in' }));
  assert.equal(isInProgress(live), true);
  assert.equal(winnerAbbr(live), null); // not final

  const [fin] = normalizeScheduleGames(espn({ state: 'post', name: 'STATUS_FINAL', homeScore: '4', awayScore: '2' }));
  assert.equal(isInProgress(fin), false);
  assert.equal(winnerAbbr(fin), 'TOR'); // home won
});

test('fetchLiveGames hits the NHL endpoint with a date and parses', async () => {
  let url = null;
  const okFetch = async (u) => { url = u; return { ok: true, json: async () => espn({ state: 'post', homeScore: '5', awayScore: '1' }) }; };
  const games = await fetchLiveGames('2026-10-08', { fetchImpl: okFetch });
  assert.match(url, /hockey\/nhl\/scoreboard\?dates=20261008/);
  assert.equal(games[0].home, 'TOR');
  await assert.rejects(() => fetchLiveGames('2026-10-08', { fetchImpl: async () => ({ ok: false, status: 500 }) }), /500/);
});
