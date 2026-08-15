// fees.js — Kalshi trading-fee MODEL.
//
// IMPORTANT: this is an estimate used by the SIMULATION engine, not a live quote.
// Kalshi's general trading-fee formula rounds UP to the next cent:
//
//     fee = ceil( rate * C * P * (1 - P) )        // in dollars, P in dollars (0..1)
//
// where C = number of contracts, P = execution price in dollars, default rate 0.07.
// Fees are charged on executed trades (entry and exit). Settlement/expiry is free.
//
// Real fee schedules vary by market and change over time. When the live Kalshi layer
// is wired in, prefer fees reported by the API over this model.

export const DEFAULT_FEE_RATE = 0.07;

/**
 * Trading fee for one execution, in integer cents (rounded up).
 * @param {number} contracts
 * @param {number} priceCents  execution price, 1..99
 * @param {number} [rate]      fee rate (default 0.07)
 */
export function tradeFeeCents(contracts, priceCents, rate = DEFAULT_FEE_RATE) {
  if (contracts <= 0) return 0;
  // Work in cents with an integer price so we avoid float drift, e.g. 0.07*100
  // evaluates to 7.000000000000001, which would tip an exact 175¢ fee to 176¢.
  // rawCents = rate * C * P * (1 - P) * 100, with P = priceCents/100:
  //          = rate * C * priceCents * (100 - priceCents) / 100
  const rawCents = (rate * contracts * priceCents * (100 - priceCents)) / 100;
  // Subtract a tiny epsilon so values that are mathematically whole cents don't
  // get pushed to the next cent by binary rounding. Real fees are never within
  // 1e-6 of a cent boundary unless they are meant to land exactly on it.
  return Math.ceil(rawCents - 1e-6);
}
