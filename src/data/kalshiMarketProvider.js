// kalshiMarketProvider.js — LIVE data source. STUB until credentials are wired in.
//
// This deliberately refuses to return prices while unconfigured, rather than guessing.
// Per the data-integrity rules: if live data cannot be verified, mark it NOT VERIFIED,
// do not invent a value, and do not let it into any ranking.
//
// To finish this later you will need (from https://kalshi.com, no secrets in chat):
//   KALSHI_API_KEY_ID   — the API key id (a UUID)
//   KALSHI_PRIVATE_KEY  — the RSA private key used to SIGN each request
// Kalshi authenticates trading requests with an RSA-PSS signature over
//   (timestamp + HTTP method + path), sent in the KALSHI-ACCESS-* headers.
// Put those in a local .env (see .env.example) — never commit them.

import { MarketProvider } from './marketProvider.js';

const NOT_CONFIGURED =
  '🔴 NOT VERIFIED — Kalshi live provider is not configured. ' +
  'Add KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY, then implement fetchMarket(). ' +
  'Until then, live data must be treated as NOT VERIFIED and left out of rankings.';

export class KalshiMarketProvider extends MarketProvider {
  constructor({ apiKeyId, privateKeyPem, baseUrl = 'https://api.elections.kalshi.com/trade-api/v2' } = {}) {
    super();
    this.apiKeyId = apiKeyId ?? process.env.KALSHI_API_KEY_ID ?? null;
    this.privateKeyPem = privateKeyPem ?? process.env.KALSHI_PRIVATE_KEY ?? null;
    this.baseUrl = baseUrl;
  }

  get source() { return 'KALSHI'; }
  get verified() { return this.isConfigured; }

  get isConfigured() {
    return Boolean(this.apiKeyId && this.privateKeyPem);
  }

  getPrice(_ticker) {
    // Even once credentials exist, this returns null until fetchMarket() is
    // implemented — the engine treats null as "unpriced / NOT VERIFIED".
    if (!this.isConfigured) return null;
    return null;
  }

  // --- To implement when wiring live data ---------------------------------
  // async fetchMarket(ticker) {
  //   const path = `/markets/${ticker}`;
  //   const res = await this.#signedFetch('GET', path);
  //   const { market } = await res.json();
  //   return market; // read market.yes_bid / market.yes_ask (cents) from here
  // }
  //
  // async #signedFetch(method, path) {
  //   const ts = Date.now().toString();
  //   const msg = ts + method + path;
  //   const signature = signRsaPss(this.privateKeyPem, msg); // base64
  //   return fetch(this.baseUrl + path, {
  //     method,
  //     headers: {
  //       'KALSHI-ACCESS-KEY': this.apiKeyId,
  //       'KALSHI-ACCESS-TIMESTAMP': ts,
  //       'KALSHI-ACCESS-SIGNATURE': signature,
  //       'Content-Type': 'application/json',
  //     },
  //   });
  // }

  assertConfigured() {
    if (!this.isConfigured) throw new Error(NOT_CONFIGURED);
  }
}

export { NOT_CONFIGURED };
