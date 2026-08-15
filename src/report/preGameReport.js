// preGameReport.js — the rich PRE-GAME decision report.
//
// Given a board of candidate markets (prices the user enters — SIMULATION, or live
// once the Kalshi feed is connected), it produces:
//   - a quick board sized to the profit target (stake-to-target, not a fixed stake)
//   - an action ranking with reasoning and capital-concentration warnings
//   - a target monitor
//   - a numbered decision list
//
// The strategy here sizes every candidate to the SAME target, so the decision is not
// "who wins" but "which target-sized bet is the best use of capital right now."

import { assertPrice, fmt, fmtPrice } from '../domain/money.js';
import { tradeFeeCents } from '../domain/fees.js';

/**
 * Smallest stake (in cents) whose WIN pays at least `targetCents` PURE PROFIT,
 * net of the entry fee. Kalshi contracts are integer, so we round up and, if fees
 * nudge it under target, add contracts until it clears.
 * Returns null when the price can't reach the target at all.
 */
export function stakeForTarget(priceCents, targetCents, feeRate) {
  assertPrice(priceCents);
  const profitPerContract = 100 - priceCents; // cents, before fees
  if (profitPerContract <= 0) return null;

  let contracts = Math.ceil(targetCents / profitPerContract);
  // Bump for fees, with a safety bound so we never loop forever.
  for (let guard = 0; guard < 100000; guard++) {
    const fee = tradeFeeCents(contracts, priceCents, feeRate);
    const potential = contracts * profitPerContract - fee;
    if (potential >= targetCents) {
      return { contracts, stakeCents: contracts * priceCents, potentialProfitCents: potential, entryFeeCents: fee };
    }
    contracts += 1;
  }
  return null;
}

/**
 * Return the board plus every 2-leg combo (parlay) of its priced singles.
 * A combo pays only if BOTH legs win; its combined price is the product of the
 * leg probabilities, so it's cheaper with a much bigger payout multiple.
 */
export function addCombos(board, { maxCombos = 20 } = {}) {
  const singles = board.filter((c) => (c.kind ?? 'single') !== 'combo' && c.priceCents != null);
  const combos = [];
  for (let i = 0; i < singles.length; i++) {
    for (let j = i + 1; j < singles.length; j++) {
      if (combos.length >= maxCombos) break;
      const a = singles[i];
      const b = singles[j];
      combos.push({
        id: `combo-${a.id ?? a.team}-${b.id ?? b.team}`,
        kind: 'combo',
        team: `${a.team} + ${b.team}`,
        gameTime: a.gameTime || b.gameTime || null,
        status: 'open',
        legs: [
          { team: a.team, ticker: a.ticker, priceCents: a.priceCents },
          { team: b.team, ticker: b.ticker, priceCents: b.priceCents },
        ],
      });
    }
  }
  return [...board, ...combos];
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const comboPriceCents = (legs) =>
  Math.max(1, Math.min(99, Math.round(legs.reduce((a, l) => a * (l.priceCents / 100), 1) * 100)));

export function evaluate(cand, { targetCents, cashCents, feeRate, historical }) {
  const kind = cand.kind ?? 'single';
  const status = cand.status ?? 'open';

  let priceCents;
  let impliedProb;
  if (kind === 'combo') {
    if (!cand.legs?.length || cand.legs.some((l) => l.priceCents == null)) {
      return { excluded: true, id: cand.id, team: cand.team, reason: '🔴 NOT VERIFIED — a combo leg has no price' };
    }
    priceCents = comboPriceCents(cand.legs);
    impliedProb = cand.legs.reduce((a, l) => a * (l.priceCents / 100), 1);
  } else {
    if (cand.priceCents == null) return { excluded: true, id: cand.id, team: cand.team, reason: '🔴 NOT VERIFIED — no current price' };
    priceCents = cand.priceCents;
    impliedProb = priceCents / 100;
  }
  if (status !== 'open') return { excluded: true, id: cand.id, team: cand.team, reason: `market is ${status}` };

  const sized = stakeForTarget(priceCents, targetCents, feeRate);
  if (!sized) return { excluded: true, id: cand.id, team: cand.team, reason: 'price too high to reach target' };

  const affordable = cashCents == null ? true : sized.stakeCents <= cashCents;
  const capitalPct = cashCents > 0 ? Math.round((sized.stakeCents / cashCents) * 1000) / 10 : null;
  const rewardPerRisk = sized.potentialProfitCents / sized.stakeCents;

  // component scores — reach is always met (sized to target), so it drops out.
  const confidence = clamp01(impliedProb);
  const efficiency = capitalPct == null ? 0.5 : clamp01(1 - capitalPct / 100); // cheaper = better
  const rr = rewardPerRisk / (rewardPerRisk + 1);
  const hist = historical ? historical.fitFor({ kind, priceCents }) : { score: null, rationale: 'Insufficient historical data' };
  const histScore = hist.score ?? 0.5;

  const score = Math.round(1000 * (0.35 * confidence + 0.20 * efficiency + 0.30 * rr + 0.15 * histScore)) / 10;

  return {
    excluded: false,
    id: cand.id,
    team: cand.team,
    opponent: cand.opponent,
    ticker: cand.ticker,
    kind,
    gameTime: cand.gameTime ?? null,
    gameState: cand.gameState ?? null,
    priceCents,
    marketProbabilityPct: Math.round(impliedProb * 1000) / 10,
    payoutMultiple: Math.round((100 / priceCents) * 10) / 10, // $1 stake pays this on a win
    legs: cand.legs ? cand.legs.map((l) => ({ team: l.team, priceCents: l.priceCents })) : null,
    contracts: sized.contracts,
    stakeForTargetCents: sized.stakeCents,
    potentialProfitCents: sized.potentialProfitCents,
    capitalPct,
    affordable,
    rewardPerRisk: Math.round(rewardPerRisk * 100) / 100,
    historicalFit: hist.rationale,
    score,
  };
}

function narrate(item, targetCents) {
  const p = item.marketProbabilityPct;
  const tag = p >= 60 ? 'strong favorite' : p >= 50 ? 'slight favorite' : 'market underdog';
  const cost =
    item.capitalPct == null ? 'stake sizeable' :
    item.capitalPct >= 60 ? `expensive — ${item.capitalPct}% of your cash` :
    item.capitalPct >= 35 ? `moderate cost — ${item.capitalPct}% of cash` :
    `cheap entry — ${item.capitalPct}% of cash`;
  const why = `${tag} at ${p}%; ${cost}. ${fmt(item.stakeForTargetCents)} → +${fmt(item.potentialProfitCents)} on a win.`;
  const warning = !item.affordable
    ? `⚠️ Not affordable: needs ${fmt(item.stakeForTargetCents)}, more than your available cash.`
    : item.capitalPct != null && item.capitalPct >= 50
      ? `⚠️ Heavy concentration: one bet would tie up ${item.capitalPct}% of your cash.`
      : null;
  const action = item.affordable
    ? `Enter ${item.kind} — ${item.contracts} @ ${item.priceCents}¢ (${fmt(item.stakeForTargetCents)})`
    : `Skip or size down — full target bet is unaffordable`;
  return { why, warning, action };
}

/**
 * Build the full pre-game report.
 * @param {Object} snapshot  from SimEngine.snapshot()
 * @param {Array}  board     candidate markets (prices resolved)
 * @param {Object} opts      { feeRate, historical }
 */
export function buildPreGameReport(snapshot, board, { feeRate, historical } = {}) {
  const targetCents = snapshot.target.targetCents;
  const cashCents = snapshot.bankroll.currentCashCents;

  const evaluated = board.map((c) => evaluate(c, { targetCents, cashCents, feeRate, historical }));
  const ranked = evaluated.filter((e) => !e.excluded).sort((a, b) => b.score - a.score || a.stakeForTargetCents - b.stakeForTargetCents);
  const excluded = evaluated.filter((e) => e.excluded);

  const medal = (i) => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`);
  ranked.forEach((it, i) => {
    it.rank = i + 1;
    it.medal = medal(i);
    Object.assign(it, narrate(it, targetCents));
  });

  const affordableCount = ranked.filter((r) => r.affordable).length;
  const t = snapshot.target;
  const histDecisions = historical ? historical.decisions.length : 0;
  const histWins = historical ? historical.decisions.filter((d) => d.won).length : 0;

  return {
    mode: 'SIMULATION',
    generatedAt: snapshot.generatedAt,
    header: {
      startingBankrollCents: snapshot.bankroll.startingBankrollCents,
      cashCents,
      targetCents,
      realizedPureProfitCents: snapshot.bankroll.realizedPureProfitCents,
      potentialPureProfitCents: snapshot.bankroll.unrealizedPureProfitCents,
      activePositions: snapshot.bankroll.openCount,
      historicalActive: histDecisions > 0,
      historicalDecisions: histDecisions,
      historicalRecord: histDecisions ? `${histWins}W-${histDecisions - histWins}L` : null,
      targetLock: t.state === 'TARGET LOCKED' || t.state === 'TARGET REALIZED',
    },
    quickBoard: ranked.map((r) => ({
      rank: r.rank, medal: r.medal, team: r.team, opponent: r.opponent, kind: r.kind,
      priceCents: r.priceCents, marketProbabilityPct: r.marketProbabilityPct,
      payoutMultiple: r.payoutMultiple, legs: r.legs,
      stakeForTargetCents: r.stakeForTargetCents, potentialProfitCents: r.potentialProfitCents,
      capitalPct: r.capitalPct, affordable: r.affordable, gameTime: r.gameTime,
    })),
    actionRanking: ranked,
    excluded,
    targetMonitor: {
      startingBankrollCents: snapshot.bankroll.startingBankrollCents,
      realizedPureProfitCents: snapshot.bankroll.realizedPureProfitCents,
      potentialPureProfitCents: snapshot.bankroll.unrealizedPureProfitCents,
      targetCents,
      progressPct: Math.round(t.realizedProgress * 100),
      withinReach: t.state === 'TARGET AVAILABLE' || t.state === 'TARGET LOCKED',
      approaching: t.realizableIfExitNowCents >= targetCents / 2 && t.state === 'TARGET NOT REACHED',
      achieved: t.state === 'TARGET REALIZED',
      affordableTargetBets: `${affordableCount} of ${ranked.length}`,
    },
    decisions: [
      ...ranked.map((r, i) => `${i + 1} — Enter ${r.medal} ${r.team ?? r.ticker} · ${fmt(r.stakeForTargetCents)} for +${fmt(r.potentialProfitCents)}${r.affordable ? '' : ' (unaffordable)'}`),
      `${ranked.length + 1} — Wait / no entry`,
    ],
  };
}
