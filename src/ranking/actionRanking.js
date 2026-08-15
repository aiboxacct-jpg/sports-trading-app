// actionRanking.js — scan a board of candidate markets and RANK them.
//
// The ranking is deliberately NOT "highest probability wins." It balances four
// transparent factors, and every ranked item exposes its component scores so the
// "why" is real rather than a black box:
//
//   reach       can this position actually reach the target profit at this stake?
//   riskReward  reward per unit of risk (favors cheaper contracts / bigger upside)
//   confidence  market-implied probability (favors likelier outcomes)
//   historical  fit from the user's own past decisions (neutral if insufficient)
//
// reach/riskReward pull toward cheap longshots; confidence pulls toward favorites.
// The weighted blend is where the actual decision trade-off lives.
//
// Data integrity: a candidate with no verified price, or whose market is not open,
// is EXCLUDED with a reason and never ranked.

import { assertPrice } from '../domain/money.js';
import { tradeFeeCents } from '../domain/fees.js';

export const DEFAULT_WEIGHTS = {
  reach: 0.30,
  riskReward: 0.25,
  confidence: 0.30,
  historical: 0.15,
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));

function normalizeWeights(w) {
  const sum = w.reach + w.riskReward + w.confidence + w.historical;
  if (sum <= 0) throw new Error('Ranking weights must sum to a positive number');
  return {
    reach: w.reach / sum,
    riskReward: w.riskReward / sum,
    confidence: w.confidence / sum,
    historical: w.historical / sum,
  };
}

/** Combined price for a combo = product of leg probabilities, back in cents (1..99). */
function comboPriceCents(legs) {
  const prob = legs.reduce((a, l) => a * (l.priceCents / 100), 1);
  return Math.max(1, Math.min(99, Math.round(prob * 100)));
}

function excluded(cand, reason) {
  return { id: cand.id, kind: cand.kind ?? 'single', team: cand.team, excluded: true, reason };
}

const medalFor = (rank) =>
  rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;

/**
 * Evaluate one candidate. `ctx` = { stakeCents, targetCents, feeRate, weights, historical }.
 */
export function evaluateCandidate(cand, ctx) {
  const { stakeCents, targetCents, feeRate } = ctx;
  const kind = cand.kind ?? 'single';
  const status = cand.status ?? 'open';

  // --- resolve price & implied probability -------------------------------
  let priceCents;
  let impliedProb;
  if (kind === 'combo') {
    if (!cand.legs || cand.legs.length === 0) return excluded(cand, 'Combo has no legs');
    if (cand.legs.some((l) => l.priceCents == null)) {
      return excluded(cand, '🔴 NOT VERIFIED — a combo leg has no price');
    }
    priceCents = comboPriceCents(cand.legs);
    impliedProb = cand.legs.reduce((a, l) => a * (l.priceCents / 100), 1);
  } else {
    if (cand.priceCents == null) return excluded(cand, '🔴 NOT VERIFIED — no current price');
    priceCents = cand.priceCents;
    impliedProb = priceCents / 100;
  }

  if (status !== 'open') return excluded(cand, `Market is ${status} — not tradeable`);
  assertPrice(priceCents);

  const contracts = Math.floor(stakeCents / priceCents);
  if (contracts <= 0) return excluded(cand, 'Stake too small to buy a contract at this price');

  // --- economics (all integer cents) -------------------------------------
  const entryFeeCents = tradeFeeCents(contracts, priceCents, feeRate);
  const riskCents = contracts * priceCents + entryFeeCents;            // cash at risk
  const potentialProfitCents = contracts * (100 - priceCents) - entryFeeCents; // if held to a win
  const rewardPerRisk = potentialProfitCents / riskCents;
  // Edge vs. the market's own price ≈ negative of the fee drag (the vig). Shown honestly.
  const edgeCents = Math.round(impliedProb * potentialProfitCents - (1 - impliedProb) * riskCents);

  // --- component scores (0..1) -------------------------------------------
  const reach = clamp01(potentialProfitCents / targetCents);
  const riskReward = rewardPerRisk / (rewardPerRisk + 1); // saturating
  const confidence = clamp01(impliedProb);
  const hist = ctx.historical
    ? ctx.historical.fitFor({ kind, priceCents })
    : { score: null, sampleSize: 0, rationale: 'Insufficient historical data' };
  const historicalScore = hist.score ?? 0.5; // neutral when unknown

  const w = ctx.weights;
  const score =
    100 *
    (w.reach * reach +
      w.riskReward * riskReward +
      w.confidence * confidence +
      w.historical * historicalScore);

  return {
    id: cand.id,
    kind,
    team: cand.team,
    opponent: cand.opponent,
    ticker: cand.ticker,
    legs: cand.legs,
    gameTime: cand.gameTime ?? null,
    status,
    gameState: cand.gameState ?? null,
    excluded: false,

    priceCents,
    marketProbabilityPct: Math.round(impliedProb * 1000) / 10, // one decimal
    contracts,
    riskCents,
    potentialProfitCents,
    rewardPerRisk: Math.round(rewardPerRisk * 100) / 100,
    edgeCents,

    components: { reach, riskReward, confidence, historical: historicalScore },
    historicalFit: hist.rationale,
    historicalScoreKnown: hist.score != null,
    score: Math.round(score * 10) / 10,

    // filled in by rankBoard once order is known
    rank: null,
    medal: null,
    why: null,
    recommendedAction: null,
  };
}

function explain(item, targetCents) {
  const c = item.components;
  const bits = [];
  bits.push(`win prob ${item.marketProbabilityPct}%`);
  bits.push(`reward/risk ${item.rewardPerRisk}`);
  bits.push(
    item.potentialProfitCents >= targetCents
      ? 'clears the target on a win'
      : 'falls short of target on a win at this stake',
  );
  if (item.historicalScoreKnown) {
    const pct = Math.round(c.historical * 100);
    const verb =
      c.historical >= 0.55 ? 'history favors it'
      : c.historical <= 0.45 ? 'history is against it'
      : 'history is mixed';
    bits.push(`${verb} (${pct}%)`);
  } else {
    bits.push('no historical read yet');
  }
  return bits.join('; ');
}

function recommend(item, targetCents) {
  const risk = (item.riskCents / 100).toFixed(2);
  const pot = (item.potentialProfitCents / 100).toFixed(2);
  const enter = `Enter ${item.kind} — ${item.contracts} @ ${item.priceCents}¢ (risk $${risk}, potential $${pot})`;
  if (item.potentialProfitCents < targetCents) {
    return `${enter} — or PASS: can't reach the $${(targetCents / 100).toFixed(2)} target at this stake`;
  }
  if (item.marketProbabilityPct < 25) {
    return `${enter} — high upside but low win probability; size down or WAIT`;
  }
  return enter;
}

/**
 * Rank a whole board.
 * @param {Array} board candidate markets
 * @param {Object} ctx { stakeCents, targetCents, feeRate?, weights?, historical? }
 * @returns {{ ranked: Array, excluded: Array, weights: Object }}
 */
export function rankBoard(board, ctx) {
  if (ctx?.stakeCents == null) throw new Error('rankBoard needs a stakeCents to size positions');
  if (ctx?.targetCents == null) throw new Error('rankBoard needs a targetCents');

  const weights = normalizeWeights(ctx.weights ?? DEFAULT_WEIGHTS);
  const fullCtx = { ...ctx, weights };

  const evaluated = board.map((c) => evaluateCandidate(c, fullCtx));

  const ranked = evaluated
    .filter((e) => !e.excluded)
    .sort((a, b) => b.score - a.score || b.rewardPerRisk - a.rewardPerRisk);

  ranked.forEach((item, i) => {
    item.rank = i + 1;
    item.medal = medalFor(i + 1);
    item.why = explain(item, ctx.targetCents);
    item.recommendedAction = recommend(item, ctx.targetCents);
  });

  const excludedList = evaluated.filter((e) => e.excluded);
  return { ranked, excluded: excludedList, weights };
}
