// goalPath.js — live 🎯 Goal-Seeking: "what's the best path to the target right now?"
//
// Given the current snapshot (realized profit, target, open positions with their
// exit-now and settle-if-win values), it decides the single best next move:
//   ACHIEVED        — already banked the target
//   LOCK_AVAILABLE  — exiting a set of positions now secures the target (names the
//                     MINIMAL set to lock)
//   HOLD_TO_REACH   — can't lock yet, but a win still gets there — hold
//   NEED_NEW_ENTRY  — even winning everything falls short — add a pick
//   NO_POSITIONS    — nothing open — enter a target-sized pick

import { fmt } from '../domain/money.js';

export function computeGoalPath(snapshot) {
  const targetCents = snapshot.target.targetCents;
  const realizedCents = snapshot.bankroll.realizedPureProfitCents;
  const open = snapshot.positions.filter((p) => p.status === 'open');
  const distanceCents = Math.max(0, targetCents - realizedCents);

  // Exit-now value of the profitable positions (net of exit fees), best first.
  const positive = open
    .filter((p) => p.unrealizedPureProfitCents != null && p.unrealizedPureProfitCents > 0)
    .sort((a, b) => b.unrealizedPureProfitCents - a.unrealizedPureProfitCents);
  const exitAllPositiveCents = positive.reduce((a, p) => a + p.unrealizedPureProfitCents, 0);

  // Best case if every open position is held to a winning settlement.
  const holdBestCaseCents = realizedCents + open.reduce((a, p) => a + (p.contracts * 100 - p.committedCents), 0);

  // Minimal set of exits whose realized profit reaches the target.
  let cum = 0;
  const lockPlan = [];
  for (const p of positive) {
    cum += p.unrealizedPureProfitCents;
    lockPlan.push({ id: p.id, team: p.team ?? p.ticker, realizesCents: p.unrealizedPureProfitCents });
    if (realizedCents + cum >= targetCents) break;
  }
  const lockReachesTarget = realizedCents + cum >= targetCents;

  let state, message, action;
  if (realizedCents >= targetCents) {
    state = 'ACHIEVED';
    message = `Target already realized — ${fmt(realizedCents)} banked.`;
    action = 'Done. Bank it, or start a new game.';
  } else if (open.length === 0) {
    state = 'NO_POSITIONS';
    message = `No open positions — you're ${fmt(distanceCents)} from the target.`;
    action = 'Enter a target-sized pick from the Pre-Game report.';
  } else if (lockReachesTarget) {
    state = 'LOCK_AVAILABLE';
    const names = lockPlan.map((l) => `${l.team} (+${fmt(l.realizesCents)})`).join(' + ');
    message = `Lock ${names} now → realizes the ${fmt(targetCents)} target.`;
    action = `Exit ${lockPlan.map((l) => l.team).join(' + ')} to secure it.`;
  } else if (holdBestCaseCents >= targetCents) {
    state = 'HOLD_TO_REACH';
    message = `Can't lock yet — exiting everything now realizes ${fmt(realizedCents + exitAllPositiveCents)}, ` +
      `short of ${fmt(targetCents)}. A winning settlement gets you to ${fmt(holdBestCaseCents)}.`;
    action = 'Hold and monitor — you need a position to hit.';
  } else {
    state = 'NEED_NEW_ENTRY';
    message = `Even if every open position wins you'd reach ${fmt(holdBestCaseCents)} — still short of ${fmt(targetCents)}.`;
    action = 'Add another target-sized pick from Pre-Game.';
  }

  return {
    state, message, action,
    targetCents, realizedCents, distanceCents,
    lockPlan, lockRealizesCents: cum, lockReachesTarget,
    exitAllRealizableCents: realizedCents + exitAllPositiveCents,
    holdBestCaseCents,
  };
}
