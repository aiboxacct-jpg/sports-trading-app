// position.js — a single Kalshi position and its valuation math.
//
// A position is `contracts` of one market side, bought at `entryPriceCents`, that
// pays $1.00 (100¢) per contract if the outcome hits ("win") and $0.00 if it does
// not ("loss"). This is side-agnostic: a "Giants YES" and a "Dodgers YES" are just
// two positions with different tickers/prices.
//
// PURE PROFIT = proceeds − premium paid − ALL fees. It is always net of fees, never
// gross. Unrealized pure profit assumes you exit NOW and pay the exit fee too.

import { assertPrice } from './money.js';
import { tradeFeeCents } from './fees.js';

/**
 * Open a position. Provide either `contracts` OR `stakeCents` (contracts is then
 * floor(stake / price) — Kalshi has no fractional contracts). Never invents a stake.
 */
export function openPosition({
  id,
  game,
  team,
  opponent,
  ticker,
  kind = 'single',                 // 'single' | 'combo'
  entryPriceCents,
  contracts,
  stakeCents,
  gameStateAtEntry = null,
  entryTs = new Date().toISOString(),
  feeRate,
}) {
  assertPrice(entryPriceCents);

  if (contracts == null) {
    if (stakeCents == null) {
      throw new Error('openPosition needs either `contracts` or `stakeCents` — never invent a stake');
    }
    contracts = Math.floor(stakeCents / entryPriceCents);
  }
  if (!Number.isInteger(contracts) || contracts <= 0) {
    throw new Error(`Position would hold ${contracts} contracts (stake too small for ${entryPriceCents}¢?)`);
  }

  const costCents = contracts * entryPriceCents;              // premium actually paid
  const entryFeeCents = tradeFeeCents(contracts, entryPriceCents, feeRate);
  const committedCents = costCents + entryFeeCents;           // total cash at risk

  return {
    id, game, team, opponent, ticker, kind,
    entryPriceCents, contracts,
    costCents,
    entryFeeCents,
    committedCents,
    // The user-committed stake (what they set aside). If contracts were given
    // directly, the stake equals the premium+entry fee.
    stakeCents: stakeCents ?? committedCents,
    gameStateAtEntry,
    currentGameState: gameStateAtEntry, // updated during the live phase
    entryTs,
    feeRate,
    status: 'open',                // 'open' | 'closed' | 'settled'
    exitPriceCents: null,
    exitTs: null,
    exitFeeCents: 0,
    settlement: null,             // 'win' | 'loss' when settled
    realizedPureProfitCents: 0,
    // price-over-time for the post-game journey graph; starts at the entry price
    priceJourney: [{ priceCents: entryPriceCents, label: gameStateAtEntry ?? 'Entry' }],
  };
}

/**
 * Mark-to-market an OPEN position at a current price.
 * Returns gross value, the fee to exit now, and unrealized pure profit (net of fees).
 */
export function valuePosition(pos, currentPriceCents) {
  assertPrice(currentPriceCents);
  const positionValueCents = pos.contracts * currentPriceCents;         // gross if sold now
  const exitFeeCents = tradeFeeCents(pos.contracts, currentPriceCents, pos.feeRate);
  const unrealizedPureProfitCents =
    positionValueCents - pos.costCents - pos.entryFeeCents - exitFeeCents;
  return { positionValueCents, exitFeeCents, unrealizedPureProfitCents };
}

/**
 * Realized pure profit if the position is HELD to settlement.
 * 'win'  -> each contract pays 100¢, no settlement fee.
 * 'loss' -> contracts expire worthless.
 */
export function settleValue(pos, outcome) {
  if (outcome !== 'win' && outcome !== 'loss') {
    throw new Error(`settleValue outcome must be 'win' or 'loss', got ${outcome}`);
  }
  const proceedsCents = outcome === 'win' ? pos.contracts * 100 : 0;
  const realizedPureProfitCents = proceedsCents - pos.costCents - pos.entryFeeCents;
  return { proceedsCents, realizedPureProfitCents };
}

/** Worst-case pure profit while still holding an open position (it loses = expires worthless). */
export function worstCasePureProfit(pos) {
  return -(pos.costCents + pos.entryFeeCents);
}
