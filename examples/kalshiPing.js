// kalshiPing.js — Phase 0 connectivity check. Run once your .env has Kalshi creds:
//   npm run kalshi:ping
//
// It proves the RSA request-signing authenticates, then pulls a couple of real
// markets and prints their prices. No orders, read-only.

import { existsSync } from 'node:fs';
import { KalshiMarketProvider, KALSHI_DEMO, KALSHI_PROD } from '../src/data/kalshiMarketProvider.js';

// Load .env if present (Node >=20.12 / 24).
if (existsSync('.env')) { try { process.loadEnvFile('.env'); } catch {} }

const k = new KalshiMarketProvider();

if (!k.isConfigured) {
  console.log('🔴 Not configured. Add KALSHI_API_KEY_ID and a private key to .env — see KALSHI_SETUP.md.');
  process.exit(1);
}

const which = k.baseUrl === KALSHI_DEMO ? 'DEMO (sandbox)' : k.baseUrl === KALSHI_PROD ? 'PRODUCTION' : k.baseUrl;
console.log(`⚪ Kalshi ping → ${which}\n`);

try {
  const status = await k.getExchangeStatus();
  console.log('✅ Auth OK — exchange status:', JSON.stringify(status));

  const markets = await k.listMarkets({ status: 'open', limit: 3 });
  console.log(`\n✅ Pulled ${markets.length} open market(s):`);
  for (const m of markets) {
    console.log(`   ${m.ticker}  last=${m.last_price ?? '—'}¢  bid=${m.yes_bid ?? '—'}  ask=${m.yes_ask ?? '—'}  (${m.title ?? ''})`);
  }
  console.log('\n🟢 Phase 0 verified — signing works and real prices are flowing.');
} catch (e) {
  console.error('🔴 Request failed:', e.message);
  console.error('\nCommon causes: wrong base URL (demo vs prod), key id/PEM mismatch, or clock skew.');
  process.exit(1);
}
