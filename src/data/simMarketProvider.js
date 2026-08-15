// simMarketProvider.js — hypothetical prices you set by hand for SIMULATION mode.
//
// Nothing here touches the network. Prices are whatever you type in, which is exactly
// what a simulation is for. It reports source="SIMULATION" and verified=false so no
// report can ever mistake these for live Kalshi data.

import { assertPrice } from '../domain/money.js';
import { MarketProvider } from './marketProvider.js';

export class SimMarketProvider extends MarketProvider {
  constructor(initialPrices = {}) {
    super();
    /** @type {Map<string, number>} */
    this.prices = new Map();
    for (const [ticker, price] of Object.entries(initialPrices)) {
      this.setPrice(ticker, price);
    }
  }

  get source() { return 'SIMULATION'; }
  get verified() { return false; }

  setPrice(ticker, priceCents) {
    assertPrice(priceCents);
    this.prices.set(ticker, priceCents);
    return this;
  }

  getPrice(ticker) {
    return this.prices.has(ticker) ? this.prices.get(ticker) : null;
  }
}
