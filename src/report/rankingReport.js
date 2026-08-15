// rankingReport.js — render an action ranking as the 🥇🥈🥉 board from the spec.
// Simulation-only: stamped ⚪ SIMULATED, prices are hypothetical.

import { fmt, fmtPrice } from '../domain/money.js';

const line = (ch = '─', n = 64) => ch.repeat(n);

export function renderRankingReport(result, { stakeCents, targetCents } = {}) {
  const out = [];
  out.push(line('='));
  out.push('  ⚪ ACTION RANKING — SIMULATION (hypothetical board & prices)');
  if (stakeCents != null) out.push(`  sizing each at ${fmt(stakeCents)} stake · target ${fmt(targetCents)} pure profit`);
  out.push(line('='));

  if (result.ranked.length === 0) {
    out.push('  (no rankable markets — see excluded below)');
  }

  for (const item of result.ranked) {
    const label =
      item.kind === 'combo'
        ? (item.legs ?? []).map((l) => l.team ?? l.ticker).join(' + ')
        : `${item.team ?? item.ticker}${item.opponent ? ` vs ${item.opponent}` : ''}`;
    out.push('');
    out.push(`  ${item.medal}  ${label}  — ${item.kind}   [score ${item.score}]`);
    out.push(`       price ${fmtPrice(item.priceCents)} · market prob ${item.marketProbabilityPct}% · ${item.gameState ?? 'state n/a'} · ${item.gameTime ?? 'time n/a'} · ${item.status}`);
    out.push(`       ${item.contracts} contracts · risk ${fmt(item.riskCents)} · potential ${fmt(item.potentialProfitCents)} · reward/risk ${item.rewardPerRisk} · edge ${fmt(item.edgeCents)}`);
    out.push(`       historical fit: ${item.historicalFit}`);
    out.push(`       why: ${item.why}`);
    out.push(`       → ${item.recommendedAction}`);
  }

  if (result.excluded.length) {
    out.push('');
    out.push('  EXCLUDED (not ranked):');
    for (const e of result.excluded) {
      out.push(`     • ${e.team ?? e.id ?? '(candidate)'} — ${e.reason}`);
    }
  }

  // YOUR DECISION area — numbered choices mapping to the ranked board.
  out.push('');
  out.push('  YOUR DECISION');
  result.ranked.forEach((item, i) => {
    const label = item.kind === 'combo'
      ? (item.legs ?? []).map((l) => l.team ?? l.ticker).join(' + ')
      : (item.team ?? item.ticker);
    out.push(`     ${i + 1} — Enter ${item.medal} ${label} (${item.kind})`);
  });
  out.push(`     ${result.ranked.length + 1} — Wait / no entry`);

  out.push('');
  out.push(line('='));
  out.push('  ⚪ SIMULATION — not advice, not a real-money recommendation');
  out.push(line('='));
  return out.join('\n');
}
