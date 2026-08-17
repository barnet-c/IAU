#!/usr/bin/env node
/**
 * ARKB ETF Creation/Redemption Arbitrage — Phase 2: Live Monitor
 *
 * Usage:
 *   node monitor.js              # Live mode
 *   node monitor.js --dry-run    # Simulated prices for testing
 */

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const {
  evaluateSignal,
  createSignalGate,
  midPrice,
  fmt,
  fmtUsd,
  fetchArkHoldings,
  resolveBtcPerShare,
  DEFAULT_BTC_PER_SHARE,
} = require('./lib/utils');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SIGNAL_COOLDOWN_MS = Number(config.signals?.cooldownMs) || 15000;

const state = {
  arkbBid: 0,
  arkbAsk: 0,
  arkbLast: 0,
  btcPrice: 0,
  btcPerShare: Number(config.etf.btcPerShare) || DEFAULT_BTC_PER_SHARE,
  btcPerShareSource: 'config',
  trades: [],
  startTime: Date.now(),
  lastArkbFetch: 0,
  lastError: null,
};

const signalGate = createSignalGate(SIGNAL_COOLDOWN_MS);
const TRADE_LOG = path.join(__dirname, 'trades.csv');
let btcSocket = null;
let btcReconnectTimer = null;
let shuttingDown = false;

function initCsv() {
  if (!fs.existsSync(TRADE_LOG)) {
    fs.writeFileSync(
      TRADE_LOG,
      'timestamp,signal,arkb_price,btc_price,nav_estimate,spread_bps,pnl_usd\n'
    );
  }
}

function logTrade(trade) {
  state.trades.push(trade);
  if (state.trades.length > 500) state.trades.shift();
  const line = [
    trade.timestamp,
    trade.signal,
    trade.arkbPrice.toFixed(4),
    trade.btcPrice.toFixed(2),
    trade.navEstimate.toFixed(4),
    trade.spreadBps.toFixed(2),
    trade.pnl.toFixed(2),
  ].join(',');
  fs.appendFileSync(TRADE_LOG, `${line}\n`);
}

function startBtcFeed() {
  if (DRY_RUN) {
    state.btcPrice = Number(config.market?.btcSpotUsd) || 85000;
    setInterval(() => {
      state.btcPrice *= 1 + (Math.random() - 0.5) * 0.002;
    }, 1000);
    console.log(`[DRY RUN] Simulated BTC feed started at $${fmt(state.btcPrice, 0)}`);
    return;
  }

  const wsUrl = config.coinbase.wsUrl;
  console.log('Connecting to Coinbase WebSocket...');

  function connect() {
    if (shuttingDown) return;
    const ws = new WebSocket(wsUrl);
    btcSocket = ws;

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'subscribe',
        product_ids: ['BTC-USD'],
        channels: ['ticker'],
      }));
      console.log('Subscribed to Coinbase BTC-USD ticker');
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ticker' && msg.price) {
          const price = parseFloat(msg.price);
          if (Number.isFinite(price) && price > 0) state.btcPrice = price;
        }
      } catch {
        // ignore malformed frames
      }
    });

    ws.on('error', (e) => {
      state.lastError = e.message;
      console.error('BTC WS error:', e.message);
    });

    ws.on('close', () => {
      if (shuttingDown) return;
      console.warn('BTC WS closed, reconnecting in 5s...');
      btcReconnectTimer = setTimeout(connect, 5000);
    });
  }

  connect();
}

async function refreshBtcPerShare() {
  if (DRY_RUN) return;
  try {
    const holdings = await fetchArkHoldings(config);
    const resolved = resolveBtcPerShare(config, holdings);
    if (resolved.btcPerShare > 0) {
      state.btcPerShare = resolved.btcPerShare;
      state.btcPerShareSource = resolved.source;
      console.log(
        `BTC/share updated from ${resolved.source}: ${state.btcPerShare.toFixed(8)}` +
        (holdings.asOf ? ` (as of ${holdings.asOf})` : '')
      );
    }
  } catch (e) {
    console.warn(`Holdings refresh failed, keeping ${state.btcPerShareSource}: ${e.message}`);
  }
}

async function fetchArkbQuote() {
  if (DRY_RUN) {
    const nav = state.btcPrice * state.btcPerShare;
    // Mean-reverting basis so dry-run can still produce occasional signals
    if (state._basis == null) state._basis = 0;
    state._basis += (Math.random() - 0.5) * 4;
    state._basis *= 0.92;
    state._basis = Math.max(-80, Math.min(80, state._basis));
    const mid = nav * (1 + state._basis / 10000);
    const spread = mid * 0.0003;
    state.arkbBid = mid - spread / 2;
    state.arkbAsk = mid + spread / 2;
    state.arkbLast = mid;
    return;
  }

  if (Date.now() - state.lastArkbFetch < 10000) return;
  state.lastArkbFetch = Date.now();

  try {
    const quote = await yahooFinance.quote(config.etf.ticker);
    state.arkbBid = Number(quote.bid) || Number(quote.regularMarketPrice) || 0;
    state.arkbAsk = Number(quote.ask) || Number(quote.regularMarketPrice) || 0;
    state.arkbLast = Number(quote.regularMarketPrice) || 0;
    state.lastError = null;
    // Intentionally do NOT set btcPerShare = mid/btc — that zeros premium.
  } catch (e) {
    state.lastError = e.message;
  }
}

function currentEval() {
  const mid = midPrice(state.arkbBid, state.arkbAsk, state.arkbLast);
  return evaluateSignal({
    arkbMid: mid,
    btcPrice: state.btcPrice,
    btcPerShare: state.btcPerShare,
    config,
  });
}

function maybeTrade() {
  const ev = currentEval();
  if (!ev.ok || !signalGate.shouldEmit(ev.signal)) return null;

  const trade = {
    timestamp: new Date().toISOString(),
    signal: ev.signal,
    arkbPrice: midPrice(state.arkbBid, state.arkbAsk, state.arkbLast),
    btcPrice: state.btcPrice,
    navEstimate: ev.nav,
    spreadBps: ev.spreadCapturedBps,
    pnl: ev.pnlUsd,
  };
  logTrade(trade);
  return trade;
}

function printDashboard() {
  const mid = midPrice(state.arkbBid, state.arkbAsk, state.arkbLast);
  const ev = currentEval();
  const premBps = ev.premBps;
  const trigger = ev.triggerBps;

  let signalStr = '⚪ NEUTRAL';
  if (ev.signal === 'CREATE') signalStr = '🟢 CREATE_SIGNAL';
  if (ev.signal === 'REDEEM') signalStr = '🔴 REDEEM_SIGNAL';

  const totalPnl = state.trades.reduce((s, t) => s + t.pnl, 0);
  const wins = state.trades.filter((t) => t.pnl > 0).length;
  const winRate = state.trades.length > 0 ? (wins / state.trades.length) * 100 : 0;
  const elapsed = ((Date.now() - state.startTime) / 60000).toFixed(1);
  const now = new Date().toLocaleTimeString();

  process.stdout.write('\x1Bc');
  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║  ARKB ARBITRAGE MONITOR ${DRY_RUN ? '(DRY RUN)' : '(LIVE)   '}        ${now.padStart(15)}  ║
║  ARK 21Shares Bitcoin ETF | Custodian: Coinbase Custody           ║
╠═══════════════════════════════════════════════════════════════════╣
║  ARKB  Bid: $${fmt(state.arkbBid, 4).padStart(10)}  Ask: $${fmt(state.arkbAsk, 4).padStart(10)}  Mid: $${fmt(mid, 4).padStart(10)}  ║
║  BTC   Price: $${fmt(state.btcPrice, 2).padStart(12)}                                    ║
║  NAV   Est:   $${fmt(ev.nav, 4).padStart(12)}     BTC/Share: ${state.btcPerShare.toFixed(8)} (${state.btcPerShareSource})  ║
╠═══════════════════════════════════════════════════════════════════╣
║  Premium/Discount: ${(premBps >= 0 ? '+' : '') + fmt(premBps, 1)} bps                                    ║
║  Cost threshold:   ±${fmt(trigger, 1)} bps  (costs ${fmt(ev.costBps, 1)} + edge ${config.signals.minSpreadAfterCostsBps})        ║
║  Signal: ${signalStr.padEnd(20)}                                     ║
╠═══════════════════════════════════════════════════════════════════╣
║  Session: ${elapsed} min | Trades: ${String(state.trades.length).padStart(4)} | Win: ${fmt(winRate, 1)}% | PnL: ${fmtUsd(totalPnl).padStart(12)} ║
║  Data: ${DRY_RUN ? 'Simulated (dry run)                            ' : 'Coinbase WS + Yahoo Finance                    '}  ║
${state.lastError ? `║  Last error: ${String(state.lastError).slice(0, 55).padEnd(55)} ║\n` : ''}╚═══════════════════════════════════════════════════════════════════╝
`);

  if (state.trades.length > 0) {
    console.log('  Recent Trades:');
    for (const t of state.trades.slice(-5)) {
      const icon = t.signal === 'CREATE' ? '🟢' : '🔴';
      const time = t.timestamp.slice(11, 19);
      console.log(`    ${icon} ${time} ${t.signal.padEnd(7)} | Spread: ${fmt(t.spreadBps, 1).padStart(6)} bps | PnL: ${fmtUsd(t.pnl).padStart(10)}`);
    }
  }

  console.log('\n  Arb Mechanics:');
  console.log('    CREATE  → Buy BTC on spot → Deliver to Coinbase Custody → Receive ARKB shares → Sell ARKB');
  console.log('    REDEEM  → Buy ARKB on exchange → Redeem with ARK/21Shares → Receive BTC → Sell BTC');
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  ARKB Arbitrage — Phase 2: Live Monitor                 ║');
  console.log(`║  Mode: ${DRY_RUN ? 'DRY RUN (simulated prices)              ' : 'LIVE (Coinbase + Yahoo Finance)            '}║`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  initCsv();
  startBtcFeed();
  await refreshBtcPerShare();

  console.log('Waiting for price data...');
  await new Promise((r) => setTimeout(r, 2000));

  let tick = 0;
  const interval = setInterval(async () => {
    try {
      await fetchArkbQuote();
      if (tick > 0 && tick % 300 === 0) await refreshBtcPerShare();

      const trade = maybeTrade();
      if (trade) {
        const icon = trade.signal === 'CREATE' ? '🟢' : '🔴';
        console.log(`\n${icon} ${trade.signal} SIGNAL | Spread: ${fmt(trade.spreadBps, 1)} bps | PnL: ${fmtUsd(trade.pnl)}`);
      }

      if (tick % 5 === 0) printDashboard();
      tick += 1;
    } catch (e) {
      state.lastError = e.message;
    }
  }, 1000);

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(interval);
    if (btcReconnectTimer) clearTimeout(btcReconnectTimer);
    if (btcSocket) {
      try { btcSocket.close(); } catch { /* ignore */ }
    }

    const totalPnl = state.trades.reduce((s, t) => s + t.pnl, 0);
    const elapsed = ((Date.now() - state.startTime) / 60000).toFixed(1);
    console.log(`\n${'='.repeat(60)}`);
    console.log('  ARKB ARBITRAGE — SESSION SUMMARY');
    console.log('='.repeat(60));
    console.log(`  Duration      : ${elapsed} minutes`);
    console.log(`  Total trades  : ${state.trades.length}`);
    console.log(`  Creates       : ${state.trades.filter((t) => t.signal === 'CREATE').length}`);
    console.log(`  Redeems       : ${state.trades.filter((t) => t.signal === 'REDEEM').length}`);
    console.log(`  Total P&L     : ${fmtUsd(totalPnl)}`);
    console.log(`  Trade log     : ${TRADE_LOG}`);
    console.log('='.repeat(60));
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
