#!/usr/bin/env node
/**
 * ARKB ETF Creation/Redemption Arbitrage — Web Dashboard
 *
 * Usage:
 *   node dashboard.js              # Live mode (default port 5001)
 *   node dashboard.js --dry-run    # Simulated prices
 *   node dashboard.js --port 8080  # Custom port
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const {
  evaluateSignal,
  createSignalGate,
  midPrice,
  fmt,
  fetchArkHoldings,
  resolveBtcPerShare,
  costBreakdown,
  DEFAULT_BTC_PER_SHARE,
} = require('./lib/utils');
const discord = require('./lib/discord');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : (Number(process.env.PORT) || 5001);
const SIGNAL_COOLDOWN_MS = Number(config.signals?.cooldownMs) || 15000;

const state = {
  arkbBid: 0,
  arkbAsk: 0,
  arkbLast: 0,
  btcPrice: 0,
  btcPerShare: Number(config.etf.btcPerShare) || DEFAULT_BTC_PER_SHARE,
  btcPerShareSource: 'config',
  trades: [],
  history: [],
  startTime: Date.now(),
  lastArkbFetch: 0,
  lastError: null,
  _basis: 0,
};

const signalGate = createSignalGate(SIGNAL_COOLDOWN_MS);
const TRADE_LOG = path.join(__dirname, 'trades.csv');
let btcSocket = null;
let btcReconnectTimer = null;
let shuttingDown = false;

function initCsv() {
  if (!fs.existsSync(TRADE_LOG)) {
    fs.writeFileSync(TRADE_LOG, 'timestamp,signal,arkb_price,btc_price,nav_estimate,spread_bps,pnl_usd\n');
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
    console.log(`[DRY RUN] Simulated BTC feed at $${fmt(state.btcPrice, 0)}`);
    return;
  }

  const wsUrl = config.coinbase.wsUrl;
  console.log('Connecting to Coinbase WebSocket...');

  function connect() {
    if (shuttingDown) return;
    const ws = new WebSocket(wsUrl);
    btcSocket = ws;
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker'] }));
      console.log('Subscribed to Coinbase BTC-USD ticker');
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ticker' && msg.price) {
          const price = parseFloat(msg.price);
          if (Number.isFinite(price) && price > 0) state.btcPrice = price;
        }
      } catch { /* ignore */ }
    });
    ws.on('error', (e) => {
      state.lastError = e.message;
      console.error('BTC WS error:', e.message);
    });
    ws.on('close', () => {
      if (shuttingDown) return;
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
      console.log(`BTC/share: ${state.btcPerShare.toFixed(8)} (${state.btcPerShareSource})`);
    }
  } catch (e) {
    console.warn(`Holdings refresh failed: ${e.message}`);
  }
}

async function fetchArkbQuote() {
  if (DRY_RUN) {
    const nav = state.btcPrice * state.btcPerShare;
    state._basis += (Math.random() - 0.5) * 5;
    state._basis *= 0.9;
    state._basis = Math.max(-90, Math.min(90, state._basis));
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
    const q = await yahooFinance.quote(config.etf.ticker);
    state.arkbBid = Number(q.bid) || Number(q.regularMarketPrice) || 0;
    state.arkbAsk = Number(q.ask) || Number(q.regularMarketPrice) || 0;
    state.arkbLast = Number(q.regularMarketPrice) || 0;
    state.lastError = null;
  } catch (e) {
    state.lastError = e.message;
  }
}

function getSnapshot() {
  const mid = midPrice(state.arkbBid, state.arkbAsk, state.arkbLast);
  const ev = evaluateSignal({
    arkbMid: mid,
    btcPrice: state.btcPrice,
    btcPerShare: state.btcPerShare,
    config,
  });

  const totalPnl = state.trades.reduce((s, t) => s + t.pnl, 0);
  const wins = state.trades.filter((t) => t.pnl > 0).length;
  const winRate = state.trades.length > 0 ? (wins / state.trades.length) * 100 : 0;
  const breakdown = mid > 0 ? costBreakdown(config, mid) : null;

  return {
    timestamp: new Date().toISOString(),
    arkbBid: state.arkbBid,
    arkbAsk: state.arkbAsk,
    arkbMid: mid,
    btcPrice: state.btcPrice,
    nav: ev.nav,
    premBps: ev.premBps,
    costBps: Number.isFinite(ev.costBps) ? ev.costBps : null,
    trigger: Number.isFinite(ev.triggerBps) ? ev.triggerBps : null,
    signal: ev.signal,
    btcPerShare: state.btcPerShare,
    btcPerShareSource: state.btcPerShareSource,
    creationUnitShares: config.etf.creationUnitShares,
    creationUnitBtc: ev.creationUnitBtc || config.etf.creationUnitShares * state.btcPerShare,
    creationUnitNotional: ev.creationUnitNotional || mid * config.etf.creationUnitShares,
    costBreakdown: breakdown,
    tradeCount: state.trades.length,
    totalPnl,
    winRate,
    elapsed: ((Date.now() - state.startTime) / 60000).toFixed(1),
    dryRun: DRY_RUN,
    lastError: state.lastError,
  };
}

function checkSignal() {
  const snap = getSnapshot();
  if (!signalGate.shouldEmit(snap.signal) || !(snap.arkbMid > 0)) return null;
  const ev = evaluateSignal({
    arkbMid: snap.arkbMid,
    btcPrice: snap.btcPrice,
    btcPerShare: snap.btcPerShare,
    config,
  });
  return {
    timestamp: new Date().toISOString(),
    signal: ev.signal,
    arkbPrice: snap.arkbMid,
    btcPrice: snap.btcPrice,
    navEstimate: ev.nav,
    spreadBps: ev.spreadCapturedBps,
    pnl: ev.pnlUsd,
  };
}

const PUBLIC_DIR = path.resolve(__dirname, 'public');
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true },
});

app.use(express.static(PUBLIC_DIR));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/api/health', (req, res) => res.json({ ok: true, dryRun: DRY_RUN, uptimeSec: process.uptime() }));
app.get('/api/state', (req, res) => res.json(getSnapshot()));
app.get('/api/history', (req, res) => res.json(state.history));
app.get('/api/trades', (req, res) => res.json(state.trades.slice(-100)));
app.get('/api/config', (req, res) => {
  // Do not leak secrets; config.json has none today, but strip env-like keys defensively.
  const safe = JSON.parse(JSON.stringify(config));
  delete safe.discord;
  delete safe.secrets;
  res.json(safe);
});

io.on('connection', (socket) => {
  socket.emit('snapshot', getSnapshot());
  socket.emit('history', state.history);
  socket.emit('trades', state.trades.slice(-50));
});

async function main() {
  if (!Number.isFinite(PORT) || PORT <= 0) {
    throw new Error(`Invalid port: ${args[portIdx + 1]}`);
  }

  console.log(`\n  ARKB Arbitrage Dashboard — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('  ARK 21Shares Bitcoin ETF | Custodian: Coinbase Custody');
  console.log(`  Starting on http://localhost:${PORT}\n`);

  initCsv();
  await discord.init().catch((e) => console.warn(`[Discord] init skipped: ${e.message}`));
  startBtcFeed();
  await refreshBtcPerShare();
  await new Promise((r) => setTimeout(r, 1500));

  let tick = 0;
  const loop = setInterval(async () => {
    try {
      await fetchArkbQuote();
      if (tick > 0 && tick % 300 === 0) await refreshBtcPerShare();

      const snap = getSnapshot();
      state.history.push({
        t: snap.timestamp,
        premBps: snap.premBps,
        arkbMid: snap.arkbMid,
        btcPrice: snap.btcPrice,
        nav: snap.nav,
        signal: snap.signal,
      });
      if (state.history.length > 3600) state.history.shift();

      const trade = checkSignal();
      if (trade) {
        logTrade(trade);
        io.emit('trade', trade);
        discord.sendTradeAlert(trade).catch(() => {});
        const icon = trade.signal === 'CREATE' ? '🟢' : '🔴';
        console.log(`  ${icon} ${trade.signal} | Spread: ${trade.spreadBps.toFixed(1)} bps | PnL: $${trade.pnl.toFixed(2)}`);
      }

      io.emit('snapshot', snap);
      tick += 1;
    } catch (e) {
      state.lastError = e.message;
    }
  }, 1000);

  server.listen(PORT, () => {
    console.log(`  ✅ Dashboard: http://localhost:${PORT}`);
    console.log('  Press Ctrl+C to stop\n');
  });

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(loop);
    if (btcReconnectTimer) clearTimeout(btcReconnectTimer);
    if (btcSocket) {
      try { btcSocket.close(); } catch { /* ignore */ }
    }
    const totalPnl = state.trades.reduce((s, t) => s + t.pnl, 0);
    console.log(`\n  Trades: ${state.trades.length} | P&L: $${totalPnl.toFixed(2)}`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
