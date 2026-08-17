#!/usr/bin/env node
/**
 * ARKB ETF Creation/Redemption Arbitrage — Phase 1: Historical Analysis
 *
 * Usage:
 *   node analyze.js
 */

const fs = require('fs');
const path = require('path');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const { createObjectCsvWriter } = require('csv-writer');
const {
  fetchArkHoldings,
  resolveBtcPerShare,
  totalCostBps,
  costBreakdown,
  evaluateSignal,
  fmt,
  fmtUsd,
  DEFAULT_BTC_PER_SHARE,
} = require('./lib/utils');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));

async function fetchHistorical(ticker, startDate) {
  console.log(`Fetching ${ticker} from ${startDate}...`);
  const result = await yahooFinance.chart(ticker, {
    period1: startDate,
    interval: '1d',
  });
  const quotes = result.quotes || [];
  console.log(`  → ${quotes.length} data points`);
  return quotes;
}

function dateKeyFromQuote(q) {
  if (!q?.date) return null;
  if (typeof q.date === 'string') return q.date.slice(0, 10);
  try {
    return q.date.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

/**
 * Estimate historical BTC/share path from a known current ratio by
 * reversing the continuous sponsor-fee bleed (~mgmt fee annual).
 * btc_per_share declines roughly with fee accrual over time.
 */
function btcPerShareOnDate(currentBps, currentDate, targetDate, feeBpsAnnual) {
  const cur = new Date(`${currentDate}T00:00:00Z`).getTime();
  const tgt = new Date(`${targetDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(cur) || !Number.isFinite(tgt)) return currentBps;
  const years = (cur - tgt) / (365.25 * 24 * 3600 * 1000);
  // Going backward in time: shares had slightly more BTC before fees accrued
  const factor = Math.exp((feeBpsAnnual / 10000) * years);
  return currentBps * factor;
}

function buildAnalysis(arkbQuotes, btcQuotes, btcPerShareNow, asOfDate) {
  const btcByDate = new Map();
  for (const q of btcQuotes) {
    const key = dateKeyFromQuote(q);
    if (!key || q.close == null) continue;
    btcByDate.set(key, q.close);
  }

  const feeBps = Number(config.etf.managementFeeBps) || 21;
  const rows = [];

  for (const q of arkbQuotes) {
    const dateKey = dateKeyFromQuote(q);
    if (!dateKey || q.close == null) continue;
    const btcClose = btcByDate.get(dateKey);
    if (btcClose == null) continue;

    const btcPerShare = btcPerShareOnDate(btcPerShareNow, asOfDate, dateKey, feeBps);
    const ev = evaluateSignal({
      arkbMid: q.close,
      btcPrice: btcClose,
      btcPerShare,
      config,
    });

    rows.push({
      date: dateKey,
      arkbClose: q.close,
      arkbVolume: q.volume ?? 0,
      btcClose,
      btcPerShare,
      navEstimate: ev.nav,
      premDiscBps: ev.premBps,
      costBps: ev.costBps,
      triggerBps: ev.triggerBps,
      isCreate: ev.signal === 'CREATE',
      isRedeem: ev.signal === 'REDEEM',
      spreadCapturedBps: ev.spreadCapturedBps,
      pnlPerTrade: ev.pnlUsd,
    });
  }

  return rows;
}

function printSummary(rows, meta) {
  const cu = config.etf.creationUnitShares;
  const premDiscValues = rows.map((r) => r.premDiscBps);
  const mean = premDiscValues.reduce((a, b) => a + b, 0) / premDiscValues.length;
  const sorted = [...premDiscValues].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const stdDev = Math.sqrt(
    premDiscValues.reduce((s, v) => s + (v - mean) ** 2, 0) / premDiscValues.length
  );
  const min = Math.min(...premDiscValues);
  const max = Math.max(...premDiscValues);

  const creates = rows.filter((r) => r.isCreate);
  const redeems = rows.filter((r) => r.isRedeem);
  const trades = rows.filter((r) => r.isCreate || r.isRedeem);
  const totalDays = rows.length;
  const years = totalDays / 252;

  const avgPrice = rows.reduce((s, r) => s + r.arkbClose, 0) / rows.length;
  const capital = cu * avgPrice;
  const breakdown = costBreakdown(config, avgPrice);

  const sep = '='.repeat(60);
  console.log(`\n${sep}`);
  console.log(' ARKB ETF ARBITRAGE — HISTORICAL ANALYSIS');
  console.log(' ARK 21Shares Bitcoin ETF | Sponsor: ARK / 21Shares');
  console.log(` Custodian: Coinbase Custody | Creation Unit: ${cu.toLocaleString()} shares`);
  console.log(sep);
  console.log(` Period          : ${rows[0].date} → ${rows[rows.length - 1].date}`);
  console.log(` Trading days    : ${totalDays}`);
  console.log(` Years           : ${fmt(years)}`);
  console.log(` BTC/share now   : ${meta.btcPerShare.toFixed(8)} (${meta.source})`);
  if (meta.asOf) console.log(` Holdings as-of  : ${meta.asOf}`);
  console.log('');
  console.log(' Premium/Discount Stats (bps):');
  console.log(`   Mean           : ${fmt(mean, 2).padStart(10)}`);
  console.log(`   Median         : ${fmt(median, 2).padStart(10)}`);
  console.log(`   Std Dev        : ${fmt(stdDev, 2).padStart(10)}`);
  console.log(`   Min            : ${fmt(min, 2).padStart(10)}`);
  console.log(`   Max            : ${fmt(max, 2).padStart(10)}`);
  console.log('');
  console.log(' Cost Breakdown (bps @ avg ARKB price):');
  console.log(`   Create/Redeem fee : ${fmt(breakdown.feeBps, 2).padStart(8)}  ($${breakdown.feeUsd} flat / order)`);
  console.log(`   ETF commission    : ${fmt(breakdown.commissionBps, 2).padStart(8)}  ($${breakdown.commissionPerShare}/share)`);
  console.log(`   BTC execution     : ${fmt(breakdown.btcExecutionBps, 2).padStart(8)}`);
  console.log(`   Market impact (×2): ${fmt(breakdown.marketImpactBpsTotal, 2).padStart(8)}`);
  console.log(`   BTC spot spread   : ${fmt(breakdown.btcSpotSpreadBps, 2).padStart(8)}`);
  console.log(`   TOTAL             : ${fmt(breakdown.totalBps, 2).padStart(8)}`);
  console.log('');
  console.log(' Actionable Opportunities:');
  console.log(`   Create signals : ${String(creates.length).padStart(6)}  (${fmt((creates.length / totalDays) * 100, 1)}% of days)`);
  console.log(`   Redeem signals : ${String(redeems.length).padStart(6)}  (${fmt((redeems.length / totalDays) * 100, 1)}% of days)`);
  console.log(`   Total trades   : ${String(trades.length).padStart(6)}  (${fmt((trades.length / totalDays) * 100, 1)}% of days)`);
  console.log('');

  if (trades.length > 0) {
    const avgPnl = trades.reduce((s, t) => s + t.pnlPerTrade, 0) / trades.length;
    const totalPnl = trades.reduce((s, t) => s + t.pnlPerTrade, 0);
    const annualPnl = totalPnl / years;
    const annualReturn = (annualPnl / capital) * 100;
    const avgSpread = trades.reduce((s, t) => s + t.spreadCapturedBps, 0) / trades.length;

    console.log(` P&L Analysis (creation unit = ${cu.toLocaleString()} shares):`);
    console.log(`   Capital required : ${fmtUsd(capital).padStart(18)}`);
    console.log(`   Avg spread capt. : ${fmt(avgSpread, 2).padStart(10)} bps`);
    console.log(`   Avg P&L / trade  : ${fmtUsd(avgPnl).padStart(18)}`);
    console.log(`   Total P&L        : ${fmtUsd(totalPnl).padStart(18)}`);
    console.log(`   Annualized P&L   : ${fmtUsd(annualPnl).padStart(18)}`);
    console.log(`   Annualized Return: ${fmt(annualReturn, 2).padStart(10)}%`);
  } else {
    console.log(' No actionable opportunities at current thresholds.');
    console.log(' Try lowering signals.minSpreadAfterCostsBps in config.json');
  }
  console.log(sep);
}

async function exportCsv(rows, filepath) {
  const writer = createObjectCsvWriter({
    path: filepath,
    header: [
      { id: 'date', title: 'Date' },
      { id: 'arkbClose', title: 'ARKB Close' },
      { id: 'arkbVolume', title: 'ARKB Volume' },
      { id: 'btcClose', title: 'BTC Close' },
      { id: 'btcPerShare', title: 'BTC Per Share' },
      { id: 'navEstimate', title: 'NAV Estimate' },
      { id: 'premDiscBps', title: 'Premium/Discount (bps)' },
      { id: 'costBps', title: 'Cost (bps)' },
      { id: 'triggerBps', title: 'Trigger (bps)' },
      { id: 'isCreate', title: 'Create Signal' },
      { id: 'isRedeem', title: 'Redeem Signal' },
      { id: 'spreadCapturedBps', title: 'Spread Captured (bps)' },
      { id: 'pnlPerTrade', title: 'P&L Per Trade (USD)' },
    ],
  });
  await writer.writeRecords(rows.map((r) => ({
    ...r,
    arkbClose: r.arkbClose.toFixed(4),
    btcClose: r.btcClose.toFixed(2),
    btcPerShare: r.btcPerShare.toFixed(10),
    navEstimate: r.navEstimate.toFixed(4),
    premDiscBps: r.premDiscBps.toFixed(2),
    costBps: Number.isFinite(r.costBps) ? r.costBps.toFixed(2) : '',
    triggerBps: Number.isFinite(r.triggerBps) ? r.triggerBps.toFixed(2) : '',
    spreadCapturedBps: r.spreadCapturedBps.toFixed(2),
    pnlPerTrade: r.pnlPerTrade.toFixed(2),
  })));
  console.log(`\nExported analysis to ${filepath}`);
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  ARKB Arbitrage — Phase 1: Historical Analysis          ║');
  console.log('║  Data: Yahoo Finance + ARK 21Shares Holdings CSV        ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  let holdings = null;
  try {
    console.log('Fetching ARK 21Shares ARKB holdings...');
    holdings = await fetchArkHoldings(config);
    console.log(`  BTC held: ${fmt(holdings.btcQuantity, 4)}`);
    console.log(`  Market value: ${fmtUsd(holdings.marketValue)}`);
    console.log(`  Shares outstanding used: ${fmt(holdings.sharesOutstanding, 0)}`);
  } catch (e) {
    console.warn(`  Warning: Could not fetch ARK holdings: ${e.message}`);
  }

  const resolved = resolveBtcPerShare(config, holdings);
  const btcPerShare = resolved.btcPerShare || config.etf.btcPerShare || DEFAULT_BTC_PER_SHARE;
  console.log(`\nBTC per share: ${btcPerShare.toFixed(8)} (${resolved.source})`);

  const startDate = config.analysis.startDate;
  const [arkbQuotes, btcQuotes] = await Promise.all([
    fetchHistorical(config.etf.ticker, startDate),
    fetchHistorical(config.bitcoin.ticker, startDate),
  ]);

  if (arkbQuotes.length === 0) {
    console.error('No ARKB data returned. Check ticker and date range.');
    process.exit(1);
  }

  const asOfDate = holdings?.asOf && /^\d{4}-\d{2}-\d{2}/.test(holdings.asOf)
    ? holdings.asOf.slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const rows = buildAnalysis(arkbQuotes, btcQuotes, btcPerShare, asOfDate);
  if (rows.length === 0) {
    console.error('No overlapping data. Check date range and tickers.');
    process.exit(1);
  }

  // Sanity: average |premium| should not be huge if btc/share is reasonable
  const avgAbsPrem = rows.reduce((s, r) => s + Math.abs(r.premDiscBps), 0) / rows.length;
  if (avgAbsPrem > 500) {
    console.warn(`\nWARNING: avg |premium| is ${avgAbsPrem.toFixed(0)} bps — btcPerShare may be wrong.`);
  }

  printSummary(rows, { btcPerShare, source: resolved.source, asOf: holdings?.asOf || null });

  const csvPath = path.join(__dirname, 'analysis.csv');
  await exportCsv(rows, csvPath);

  console.log('\n Monthly Breakdown:');
  console.log(' ─────────────────────────────────────────────────────────────');
  console.log(' Month       | Days | Creates | Redeems | Total P&L    | Avg Prem');
  console.log(' ─────────────────────────────────────────────────────────────');

  const byMonth = new Map();
  for (const r of rows) {
    const month = r.date.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(r);
  }

  for (const [month, monthRows] of byMonth) {
    const creates = monthRows.filter((r) => r.isCreate).length;
    const redeems = monthRows.filter((r) => r.isRedeem).length;
    const pnl = monthRows.reduce((s, r) => s + r.pnlPerTrade, 0);
    const avgPrem = monthRows.reduce((s, r) => s + r.premDiscBps, 0) / monthRows.length;
    console.log(
      ` ${month}    |  ${String(monthRows.length).padStart(3)} |     ${String(creates).padStart(3)} |     ${String(redeems).padStart(3)} | ${fmtUsd(pnl).padStart(13)} | ${fmt(avgPrem, 2).padStart(7)} bps`
    );
  }
  console.log(' ─────────────────────────────────────────────────────────────');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
