// marketProvider.js — the interface every price source implements.
//
// Both the simulation provider and the (future) live Kalshi provider satisfy this
// shape, so the engine never cares which one it's talking to. Swapping in live data
// later is a one-line change at construction time.

/**
 * @typedef {Object} MarketProvider
 * @property {(ticker: string) => (number|null)} getPrice
 *   Current executable price in cents for `ticker`, or null if unknown/unverified.
 * @property {string} source   Human label, e.g. "SIMULATION" or "KALSHI".
 * @property {boolean} verified Whether prices from this source are live-verified.
 */

export class MarketProvider {
  get source() { return 'ABSTRACT'; }
  get verified() { return false; }
  // eslint-disable-next-line no-unused-vars
  getPrice(ticker) {
    throw new Error('MarketProvider.getPrice must be implemented by a subclass');
  }
}
