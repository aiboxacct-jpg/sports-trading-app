import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  abbrFromKalshi, isInProgress, quarterLabel, winnerAbbr,
  normalizeScheduleGames, findGameFor, fetchLiveGames,
} from '../src/data/nflLiveFeed.js';

// A tiny ESPN-shaped scoreboard fixture.
const espn = (over = {}) => ({
  events: [{
    date: '2026-09-20T23:25:00Z',
    status: { period: over.period ?? 3, displayClock: over.clock ?? '5:20', type: { state: over.state ?? 'in', name: over.name ?? 'STATUS_IN_PROGRESS' } },
    competitions: [{
      competitors: [
        { homeAway: 'home', team: { abbreviation: 'DAL', displayName: 'Dallas Cowboys' }, score: over.homeScore ?? '21' },
        { homeAway: 'away', team: { abbreviation: 'WSH', displayName: 'Washington Commanders' }, score: over.awayScore ?? '17' },
      ],
    }],
  }],
});

test('abbrFromKalshi maps labels (incl. disambiguated shared cities) to ESPN abbr', () => {
  assert.equal(abbrFromKalshi('Washington'), 'WSH');
  assert.equal(abbrFromKalshi('New York G'), 'NYG');
  assert.equal(abbrFromKalshi('New York J'), 'NYJ');
  assert.equal(abbrFromKalshi('Los Angeles R'), 'LAR');
  assert.equal(abbrFromKalshi('Los Angeles C'), 'LAC');
  assert.equal(abbrFromKalshi('Kansas City'), 'KC');
  assert.equal(abbrFromKalshi('Nowhere'), null);
});

test('normalizeScheduleGames flattens an ESPN event', () => {
  const [g] = normalizeScheduleGames(espn());
  assert.equal(g.away, 'WSH');
  assert.equal(g.home, 'DAL');
  assert.equal(g.awayScore, 17);
  assert.equal(g.homeScore, 21);
  assert.equal(g.state, 'in');
  assert.equal(g.period, 3);
  assert.equal(findGameFor([g], 'DAL', 'WSH'), g);       // either order
  assert.equal(findGameFor([g], 'WSH', 'DAL'), g);
  assert.equal(findGameFor([g], 'DAL', 'NYG'), null);
});

test('isInProgress + quarterLabel reflect real play (not pre-game)', () => {
  const [live] = normalizeScheduleGames(espn({ state: 'in', period: 3, clock: '5:20' }));
  assert.equal(isInProgress(live), true);
  assert.equal(quarterLabel(live), 'Q3 5:20');

  const [pre] = normalizeScheduleGames(espn({ state: 'pre', name: 'STATUS_SCHEDULED', period: 0 }));
  assert.equal(isInProgress(pre), false);

  const [half] = normalizeScheduleGames(espn({ state: 'in', name: 'STATUS_HALFTIME' }));
  assert.equal(quarterLabel(half), 'Halftime');

  const [ot] = normalizeScheduleGames(espn({ state: 'in', period: 5, clock: '1:12' }));
  assert.equal(quarterLabel(ot), 'OT 1:12');
});

test('winnerAbbr resolves a final, and pushes on a tie', () => {
  const [win] = normalizeScheduleGames(espn({ state: 'post', name: 'STATUS_FINAL', homeScore: '24', awayScore: '20' }));
  assert.equal(winnerAbbr(win), 'DAL'); // home won
  assert.equal(quarterLabel(win), 'Final');
  assert.equal(isInProgress(win), false);

  const [tie] = normalizeScheduleGames(espn({ state: 'post', name: 'STATUS_FINAL', homeScore: '20', awayScore: '20' }));
  assert.equal(winnerAbbr(tie), null); // tie -> push, no settle

  const [live] = normalizeScheduleGames(espn({ state: 'in' }));
  assert.equal(winnerAbbr(live), null); // not final yet
});

test('fetchLiveGames uses the date param, parses OK, throws on non-OK', async () => {
  let calledUrl = null;
  const okFetch = async (url) => { calledUrl = url; return { ok: true, json: async () => espn({ state: 'post', homeScore: '30', awayScore: '10' }) }; };
  const games = await fetchLiveGames('2026-09-20', { fetchImpl: okFetch });
  assert.match(calledUrl, /dates=20260920/);
  assert.equal(games[0].home, 'DAL');

  const badFetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(() => fetchLiveGames('2026-09-20', { fetchImpl: badFetch }), /503/);
});
