// simReport.js — render a SimEngine snapshot as a plain-text report.
//
// This mirrors the LIVE report layout so the two modes feel identical, but it is
// stamped SIMULATION everywhere and uses the ⚪ SIMULATED badge — never the
// 🟢 VERIFIED badges reserved for live Kalshi / live game data.

import { fmt, fmtPrice } from '../domain/money.js';

const line = (ch = '─', n = 60) => ch.repeat(n);

export function renderSimReport(snap) {
  const b = snap.bankroll;
  const t = snap.target;
  const out = [];

  out.push(line('='));
  out.push('  ⚪ SIMULATION REPORT — HYPOTHETICAL DATA, NOT REAL PERFORMANCE');
  out.push(`  generated ${snap.generatedAt}`);
  out.push(line('='));

  // Bankroll
  out.push('');
  out.push('BANKROLL');
  out.push(`  Starting        ${fmt(b.startingBankrollCents)}`);
  out.push(`  Current cash    ${fmt(b.currentCashCents)}`);
  out.push(`  Committed       ${fmt(b.committedCents)}   (${b.openCount} open)`);
  out.push(`  Position value  ${fmt(b.positionValueCents)}   (mark-to-market)`);
  out.push(`  Unrealized P/P  ${fmt(b.unrealizedPureProfitCents)}`);
  out.push(`  Realized  P/P   ${fmt(b.realizedPureProfitCents)}`);
  out.push(`  Equity          ${fmt(b.equityCents)}   (cash + open value)`);
  if (b.unpriced.length) {
    out.push(`  🔴 NOT VERIFIED / unpriced: ${b.unpriced.join(', ')}`);
  }

  // Target
  out.push('');
  out.push('TARGET');
  out.push(`  Target          ${fmt(t.targetCents)} PURE PROFIT`);
  out.push(`  State           ${t.state}`);
  out.push(`  Realized so far ${fmt(t.realizedPureProfitCents)}  (${Math.round(t.realizedProgress * 100)}% of target)`);
  out.push(`  Best exit now   ${fmt(t.realizableIfExitNowCents)}${t.shortfallCents ? `  (short ${fmt(t.shortfallCents)})` : ''}`);
  out.push(`  Worst case      ${fmt(t.guaranteedWorstCaseCents)}  (if everything open loses)`);
  if (t.alert) out.push(`  ${t.alert}`);

  // Positions
  out.push('');
  out.push('POSITIONS');
  if (snap.positions.length === 0) {
    out.push('  (none)');
  } else {
    for (const p of snap.positions) {
      const head = `  ${p.team ?? p.ticker} ${p.opponent ? `vs ${p.opponent} ` : ''}— ${p.kind} [${p.status}]`;
      out.push(head);
      out.push(`      ticker ${p.ticker}  entry ${fmtPrice(p.entryPriceCents)}  x${p.contracts}  committed ${fmt(p.committedCents)}`);
      if (p.status === 'open') {
        if (p.currentPriceCents != null) {
          out.push(`      now ${fmtPrice(p.currentPriceCents)}  value ${fmt(p.currentValueCents)}  unrealized P/P ${fmt(p.unrealizedPureProfitCents)}`);
        } else {
          out.push('      🔴 NOT VERIFIED — no current price');
        }
      } else if (p.status === 'closed') {
        out.push(`      exited ${fmtPrice(p.exitPriceCents)}  realized P/P ${fmt(p.realizedPureProfitCents)}`);
      } else if (p.status === 'settled') {
        out.push(`      settled ${p.settlement.toUpperCase()}  realized P/P ${fmt(p.realizedPureProfitCents)}`);
      }
    }
  }

  out.push('');
  out.push(line('='));
  out.push('  ⚪ SIMULATION — does not affect real bankroll or live history');
  out.push(line('='));
  return out.join('\n');
}
