import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  nickFromKalshi, nickFromStatsName, inningLabel,
  normalizeScheduleGames, findGameFor, etDateStr, fetchLiveGames,
} from '../src/data/mlbLiveFeed.js';

test('nickFromKalshi maps disambiguated shared-city labels', () => {
  assert.equal(nickFromKalshi('Baltimore'), 'Orioles');
  assert.equal(nickFromKalshi('Tampa Bay'), 'Rays');
  assert.equal(nickFromKalshi('Chicago C'), 'Cubs');
  assert.equal(nickFromKalshi('Chicago WS'), 'White Sox');
  assert.equal(nickFromKalshi('New York Y'), 'Yankees');
  assert.equal(nickFromKalshi('New York M'), 'Mets');
  assert.equal(nickFromKalshi("A's"), 'Athletics');
  assert.equal(nickFromKalshi('Nowhere'), null);
});

test('nickFromStatsName extracts the nickname from the full team name', () => {
  assert.equal(nickFromStatsName('Baltimore Orioles'), 'Orioles');
  assert.equal(nickFromStatsName('Tampa Bay Rays'), 'Rays');
  assert.equal(nickFromStatsName('Boston Red Sox'), 'Red Sox');
  assert.equal(nickFromStatsName('Chicago White Sox'), 'White Sox'); // not confused with Red Sox
  assert.equal(nickFromStatsName('Athletics'), 'Athletics');
});

test('normalizeScheduleGames flattens + matches a live game', () => {
  const json = {
    dates: [{
      games: [{
        gameDate: '2026-08-16T16:15:00Z',
        status: { abstractGameState: 'Live', detailedState: 'In Progress' },
        teams: {
          away: { team: { name: 'Baltimore Orioles' }, score: 0 },
          home: { team: { name: 'Tampa Bay Rays' }, score: 2 },
        },
        linescore: { currentInning: 3, inningState: 'End', currentInningOrdinal: '3rd' },
      }],
    }],
  };
  const [g] = normalizeScheduleGames(json);
  assert.equal(g.away, 'Orioles');
  assert.equal(g.home, 'Rays');
  assert.equal(g.state, 'Live');
  assert.equal(g.awayScore, 0);
  assert.equal(g.homeScore, 2);
  assert.equal(inningLabel(g), 'End 3rd');

  // matchable in either order
  assert.equal(findGameFor([g], 'Orioles', 'Rays'), g);
  assert.equal(findGameFor([g], 'Rays', 'Orioles'), g);
  assert.equal(findGameFor([g], 'Orioles', 'Yankees'), null);
});

test('etDateStr renders the US-Eastern game day', () => {
  // 2026-08-16 04:00 UTC is still 2026-08-16 00:00 ET (previous evening -> same date)
  assert.equal(etDateStr(Date.parse('2026-08-16T12:00:00Z')), '2026-08-16');
  // 03:00 UTC = 11pm ET the day before
  assert.equal(etDateStr(Date.parse('2026-08-16T03:00:00Z')), '2026-08-15');
});

test('fetchLiveGames throws on non-OK without hanging (injected fetch)', async () => {
  const fakeFetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(() => fetchLiveGames('2026-08-16', { fetchImpl: fakeFetch }), /503/);
});

test('fetchLiveGames parses an injected OK response', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ dates: [{ games: [{
      status: { abstractGameState: 'Final', detailedState: 'Final' },
      teams: { away: { team: { name: 'Houston Astros' }, score: 4 }, home: { team: { name: 'Seattle Mariners' }, score: 1 } },
      linescore: { currentInning: 9, inningState: 'Bottom', currentInningOrdinal: '9th' },
    }] }] }),
  });
  const games = await fetchLiveGames('2026-08-16', { fetchImpl: fakeFetch });
  assert.equal(games.length, 1);
  assert.equal(games[0].away, 'Astros');
  assert.equal(games[0].state, 'Final');
});
