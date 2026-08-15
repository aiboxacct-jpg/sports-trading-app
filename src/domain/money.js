// money.js — everything monetary in this engine is INTEGER CENTS.
// No floats for balances. Kalshi contract prices are integer cents in 1..99
// (a price of 55¢ implies a 55% market probability and pays $1.00 if it hits).

export const toCents = (dollars) => Math.round(dollars * 100);
export const toDollars = (cents) => cents / 100;

/** Format integer cents as a signed dollar string, e.g. -430 -> "-$4.30". */
export function fmt(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

/** Format a Kalshi price for display, e.g. 55 -> "55¢". */
export const fmtPrice = (priceCents) => `${priceCents}¢`;

/** Validate a Kalshi contract price. Throws rather than silently accepting garbage. */
export function assertPrice(priceCents) {
  if (!Number.isInteger(priceCents) || priceCents < 1 || priceCents > 99) {
    throw new Error(`Invalid Kalshi price ${priceCents}¢ — must be an integer 1..99`);
  }
  return priceCents;
}

/** Implied probability (0..1) from a price in cents. */
export const impliedProb = (priceCents) => priceCents / 100;
