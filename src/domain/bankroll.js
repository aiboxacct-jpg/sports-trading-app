// bankroll.js — aggregate a set of positions into a bankroll snapshot.
//
// Cash identity (kept exact, all integer cents):
//     currentCash = starting − committed(open) + realizedPureProfit
//     equity      = starting + realizedPureProfit + unrealizedPureProfit
//
// `priceOf(pos)` returns the current price in cents, or null when unknown.
// Unknown prices are NOT invented — the position is listed under `unpriced` and
// left out of mark-to-market, matching the "NOT VERIFIED — do not rank" rule.

import { valuePosition, worstCasePureProfit } from './position.js';

export function computeBankroll({ startingBankrollCents, positions, priceOf }) {
  if (startingBankrollCents == null) {
    throw new Error('computeBankroll needs startingBankrollCents — never invent a bankroll');
  }

  let committedCents = 0;               // cash at risk in open positions
  let positionValueCents = 0;           // gross mark-to-market of priced open positions
  let unrealizedPureProfitCents = 0;    // net of exit fees, priced open positions only
  let realizedPureProfitCents = 0;      // from closed + settled positions
  let guaranteedWorstCaseCents = 0;     // realized + worst case of everything still open
  const unpriced = [];

  for (const p of positions) {
    if (p.status === 'open') {
      committedCents += p.committedCents;
      guaranteedWorstCaseCents += worstCasePureProfit(p);
      const price = priceOf(p);
      if (price == null) {
        unpriced.push(p.id);
        continue;
      }
      const v = valuePosition(p, price);
      positionValueCents += v.positionValueCents;
      unrealizedPureProfitCents += v.unrealizedPureProfitCents;
    } else {
      realizedPureProfitCents += p.realizedPureProfitCents;
      guaranteedWorstCaseCents += p.realizedPureProfitCents;
    }
  }

  const currentCashCents = startingBankrollCents - committedCents + realizedPureProfitCents;
  const equityCents = startingBankrollCents + realizedPureProfitCents + unrealizedPureProfitCents;

  return {
    startingBankrollCents,
    currentCashCents,
    committedCents,
    positionValueCents,
    unrealizedPureProfitCents,
    realizedPureProfitCents,
    equityCents,
    guaranteedWorstCaseCents,
    unpriced,                 // ids of open positions with no verified price
    openCount: positions.filter((p) => p.status === 'open').length,
  };
}
