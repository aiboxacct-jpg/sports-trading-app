// postGameReport.js — post-game analysis for closed/settled positions.
//
// Pure functions over snapshot-style positions. ROI is realized pure profit over the
// cash committed. "Lessons" are honest heuristics about THIS outcome — they never
// fabricate historical statistics (that's the historical engine's job, and only from
// real data).

import { priceBucket } from '../ranking/historicalDecisionEngine.js';

const bucketLabel = { low: 'longshot', mid: 'toss-up', high: 'favorite' };

/** Post-game report for a single closed/settled position. */
export function postGameForPosition(pos, { targetCents = 500 } = {}) {
  const done = pos.status === 'closed' || pos.status === 'settled';
  if (!done) throw new Error(`Position ${pos.id} is still ${pos.status} — no post-game yet`);

  const realized = pos.realizedPureProfitCents;
  const committed = pos.committedCents;
  const roiPct = committed > 0 ? Math.round((realized / committed) * 1000) / 10 : 0;
  const result = realized > 0 ? 'WIN' : realized < 0 ? 'LOSS' : 'FLAT';
  const targetReached = realized >= targetCents;
  const bucket = priceBucket(pos.entryPriceCents);

  const exit =
    pos.status === 'settled'
      ? { type: 'settlement', label: `settled ${pos.settlement.toUpperCase()}` }
      : { type: 'exit', priceCents: pos.exitPriceCents, label: `exited ${pos.exitPriceCents}¢` };

  return {
    id: pos.id,
    team: pos.team,
    opponent: pos.opponent,
    ticker: pos.ticker,
    kind: pos.kind,
    entryPriceCents: pos.entryPriceCents,
    contracts: pos.contracts,
    stakeCents: committed,
    exit,
    result,
    realizedPureProfitCents: realized,
    roiPct,
    targetReached,
    gameStateAtEntry: pos.gameStateAtEntry ?? null,
    exitTs: pos.exitTs ?? null,
    priceJourney: Array.isArray(pos.priceJourney) ? pos.priceJourney : [],
    lesson: lessonFor({ result, targetReached, bucket, status: pos.status, kind: pos.kind }),
  };
}

function lessonFor({ result, targetReached, bucket, status, kind }) {
  if (result === 'WIN' && targetReached && status === 'closed') {
    return `Banked the +target by exiting early on a ${bucketLabel[bucket]} ${kind} — consistent with a fixed profit target.`;
  }
  if (result === 'WIN' && status === 'settled' && bucket === 'low') {
    return `A ${bucketLabel[bucket]} paid off at settlement — high variance; a good result, not a repeatable edge.`;
  }
  if (result === 'WIN') {
    return `Profitable ${kind} on a ${bucketLabel[bucket]}. Fees still took a cut — factor them into every entry.`;
  }
  if (result === 'LOSS' && bucket === 'low') {
    return `Longshot ${kind} didn't hit — expected most of the time at this price. Size accordingly.`;
  }
  if (result === 'LOSS') {
    return `Full loss on a ${bucketLabel[bucket]} ${kind}. Review whether the entry price left enough room for the target.`;
  }
  return 'Flat result after fees — the move didn\'t cover trading costs.';
}

/** Session-level post-game summary across all closed/settled positions. */
export function sessionPostGame(positions, { targetCents = 500 } = {}) {
  const done = positions.filter((p) => p.status === 'closed' || p.status === 'settled');
  const reports = done.map((p) => postGameForPosition(p, { targetCents }));

  const totalRealizedCents = reports.reduce((a, r) => a + r.realizedPureProfitCents, 0);
  const totalStakeCents = reports.reduce((a, r) => a + r.stakeCents, 0);
  const wins = reports.filter((r) => r.result === 'WIN').length;
  const losses = reports.filter((r) => r.result === 'LOSS').length;

  return {
    count: reports.length,
    wins,
    losses,
    totalRealizedCents,
    totalStakeCents,
    roiPct: totalStakeCents > 0 ? Math.round((totalRealizedCents / totalStakeCents) * 1000) / 10 : 0,
    targetAchieved: totalRealizedCents >= targetCents,
    targetCents,
    reports,
  };
}
