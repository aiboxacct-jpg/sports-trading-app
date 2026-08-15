// dynamicReplacement.js — "is there a better leg now?"
//
// For each OPEN position, score it at its CURRENT price as if it were a fresh entry,
// then compare against the live board (singles + combos, excluding what you already
// hold). If a board pick beats the held position's current-entry score by a margin,
// surface it as a swap candidate — with the score gap, the alternative's payout, and
// what exiting the held position would realize right now. It suggests; it never acts.
//
// Scoring reuses the exact pre-game scorer, so replacement logic and entry logic
// can never drift apart.

import { evaluate } from '../report/preGameReport.js';

export function findReplacements(snapshot, board, { feeRate, historical, margin = 5 } = {}) {
  const targetCents = snapshot.target.targetCents;
  const cashCents = snapshot.bankroll.currentCashCents;
  const open = snapshot.positions.filter((p) => p.status === 'open' && p.currentPriceCents != null);
  if (!open.length) return { suggestions: [], margin };

  const ctx = { targetCents, cashCents, feeRate, historical };
  const heldKeys = new Set();
  for (const p of open) { if (p.ticker) heldKeys.add(p.ticker); if (p.team) heldKeys.add(p.team); }
  const held = (key) => key != null && heldKeys.has(key);

  // Score every board pick once; drop anything unrankable, already held, or a combo
  // that would double up on a leg you already hold.
  const alternatives = board
    .map((c) => evaluate(c, ctx))
    .filter((e) => !e.excluded && !held(e.ticker) && !held(e.team) && !(e.legs && e.legs.some((l) => held(l.team))));

  const suggestions = [];
  for (const p of open) {
    // Score the held position at its current price as a fresh single entry.
    const held = evaluate(
      { team: p.team, opponent: p.opponent, ticker: p.ticker, kind: 'single', priceCents: p.currentPriceCents, status: 'open' },
      ctx,
    );
    if (held.excluded) continue;

    let best = null;
    for (const alt of alternatives) if (!best || alt.score > best.score) best = alt;
    if (best && best.score - held.score >= margin) {
      suggestions.push({
        positionId: p.id,
        held: {
          team: p.team ?? p.ticker,
          priceCents: p.currentPriceCents,
          score: held.score,
          unrealizedPureProfitCents: p.unrealizedPureProfitCents,
        },
        better: {
          team: best.team ?? best.ticker,
          kind: best.kind,
          priceCents: best.priceCents,
          score: best.score,
          payoutMultiple: best.payoutMultiple,
          stakeForTargetCents: best.stakeForTargetCents,
          affordableAfterExit: best.stakeForTargetCents <= cashCents + (p.currentValueCents ?? 0),
        },
        scoreGain: Math.round((best.score - held.score) * 10) / 10,
        exitRealizesCents: p.unrealizedPureProfitCents,
      });
    }
  }
  return { suggestions, margin };
}
