# ARKB Arb — How to Run

This project has two independent simulation engines:
1. **Python sim** (`sim.py`) — Monte Carlo / GBM simulation of arb mechanics
2. **Node.js suite** (`node/`) — Historical analysis + live monitor + web dashboard

---

## Python Simulation (`sim.py`)

### Requirements
- Python 3.7+
- No external dependencies required for `--no-chart`
- `matplotlib` optional (for chart output)

```bash
# Install matplotlib (optional, for chart PNG)
pip3 install matplotlib
```

### Quick Start

```bash
cd ARKB-arb/

# Single day, default params
python3 sim.py --no-chart

# Since inception (592 trading days, Jan 11 2024 → Apr 17 2026)
python3 sim.py --days 592 --no-chart

# With chart output (requires matplotlib)
python3 sim.py --days 5
```

### All CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--days N` | `1` | Number of trading days to simulate |
| `--btc-price N` | `85000` | Starting BTC price (USD) |
| `--vol N` | `0.025` | Daily BTC volatility (e.g. `0.04` = 4%) |
| `--ap-threshold N` | `10` | AP arb trigger threshold (bps) |
| `--no-chart` | off | Skip matplotlib chart (faster, no deps) |

### Examples

```bash
# 5-day run at current BTC price
python3 sim.py --days 5

# High-volatility stress test
python3 sim.py --days 30 --vol 0.06

# Tighter arb spreads (more competitive APs)
python3 sim.py --days 592 --ap-threshold 5 --no-chart

# Different BTC starting price
python3 sim.py --days 10 --btc-price 100000 --no-chart

# Full inception-to-date Monte Carlo
python3 sim.py --days 592 --no-chart
```

### Output

All output lands in `results/`:

| File | Description |
|------|-------------|
| `results/snapshots.csv` | Per-minute BTC price, NAV, market price, premium/discount |
| `results/arb_events.csv` | Every creation/redemption event with P&L breakdown |
| `results/chart.png` | Price + premium/discount chart (if matplotlib installed) |

### Configuration (`config.json`)

All parameters are in `config.json`. Edit this file to change defaults without touching code:

```json
{
  "etf": {
    "creation_unit_size": 5000,       // shares per basket (prospectus-confirmed)
    "btc_per_share": 0.001050,        // approx BTC per share
    "management_fee_bps": 21          // 0.21%/yr sponsor fee
  },
  "arbitrage": {
    "ap_trigger_threshold_bps": 10.0, // min spread to trigger arb
    "ap_transaction_cost_bps": 6.0,   // total round-trip cost estimate
    "num_aps": 4                       // number of simulated APs
  },
  "costs": {
    "wire_fee_usd": 200               // creation/redemption fee (estimated)
  }
}
```

---

## Node.js Suite (`node/`)

### Requirements

```bash
cd ARKB-arb/node/
npm install
```

Dependencies: `express`, `socket.io`, `ws`, `node-fetch` (see `package.json`)

### Phase 1: Historical Analysis

Fetches real ARKB price data from Yahoo Finance and computes actual premium/discount history + P&L model.

```bash
cd ARKB-arb/node/
node analyze.js
```

**Output:**
- Terminal table: monthly premium/discount stats, arb event count, estimated P&L
- `analysis.csv`: full daily history export

### Phase 2: Live Terminal Monitor

Watches Coinbase WebSocket (BTC spot) + Yahoo Finance (ARKB quote) and fires CREATE/REDEEM signals in real time.

```bash
# Dry run (simulated prices, no external calls)
node monitor.js --dry-run

# Live mode (requires internet)
node monitor.js
```

Or via npm:
```bash
npm run monitor    # dry-run
```

**What you see:**
```
[14:23:01] BTC: $87,432.10  ARKB: $91.88  NAV: $91.82
           Premium: +6.5 bps  [WATCHING...]

[14:23:15] ⚡ CREATE SIGNAL
           Premium: +12.3 bps > threshold (10 bps)
           Basket: 5,000 shares | Value: $459,100
           Est. P&L: $341 after costs
```

### Phase 3: Web Dashboard (Frontend-Only)

**No backend required.** The dashboard is a pure static frontend that:
- Fetches live BTC prices directly from **Coinbase WebSocket API** (via REST polling every 5 seconds)
- Computes ARKB NAV client-side using config parameters
- Displays premium/discount and arb signals in real time
- Charts and trades are all in-browser state

#### Local Development

Serve the dashboard locally from the source folder:

```bash
cd ARKB-arb/node/

# Install dependencies (first time only)
npm install

# Start local dev server on http://localhost:3000
npm run dev
```

Then open **http://localhost:3000** in your browser.

The dashboard will start fetching live BTC prices immediately and display real-time premium/discount data.

#### Build for Production

```bash
# Build static artifact into dist/
npm run build

# Verify dist artifact works
npm run verify
```

Deployed to Azure Static Web Apps: [https://jolly-sand-003901d0f.7.azurestaticapps.net](https://jolly-sand-003901d0f.7.azurestaticapps.net)

#### Customization

Edit cost model and signal thresholds in `config.json`, then rebuild:

```json
{
  "etf": {
    "btcPerShare": 0.000303,  // Update if ARKB composition changes
    "creationUnitShares": 5000
  },
  "costs": {
    "creationRedemptionFeeUsd": 200,
    "etfCommissionPerShare": 0.005,
    "btcExecutionBps": 2,
    "marketImpactBps": 1,
    "btcSpotSpreadBps": 2
  },
  "signals": {
    "minSpreadAfterCostsBps": 10  // Arb trigger threshold
  }
}
```

### Configuration (`node/config.json`)

Key fields:

```json
{
  "etf": {
    "creationUnitShares": 5000,         // shares per basket
    "btcPerShare": 0.001050,            // approx BTC per share
    "managementFeeBps": 21              // 0.21%/yr
  },
  "costs": {
    "creationRedemptionFeeUsd": 200,    // creation/redemption fee (estimated)
    "etfCommissionPerShare": 0.005,     // $0.005/share ETF commission
    "btcExecutionBps": 2,               // BTC execution cost
    "btcSpotSpreadBps": 2               // BTC spot spread
  },
  "signals": {
    "minSpreadAfterCostsBps": 10        // arb trigger threshold
  }
}
```

---

## Parameter Reference

See **[PARAMETERS.md](./PARAMETERS.md)** for full documentation of every parameter, its source, and confidence level.

Key facts confirmed from the ARKB prospectus (SEC S-1/A, Jan 2024):
- ✅ **Basket size: 5,000 shares** per creation/redemption unit
- ✅ **Management fee: 0.21%/yr** (21 bps)
- ✅ **Custodian: Coinbase Custody** (primary) + BitGo (added Dec 2025)
- ✅ **Cash-only creation/redemption** at AP level (trust buys BTC via Bitcoin Counterparty)
- ⚠️ **BTC per share: ~0.000303** (current Apr 2026; was ~0.000336 at inception — drifts down as fees accrue; use live holdings CSV for precision)
- ⚠️ **Creation fee: ~$200 estimated** (not publicly disclosed — see PARAMETERS.md)

---

## Simulation Architecture

```
BTC Price (GBM)
     │
     ▼
Intraday NAV = BTC × btcPerShare × (1 - accrued_fee)
     │
     ├── + mean-reverting premium noise
     ▼
ARKB Market Price
     │
     ▼
Premium/Discount = (Market - NAV) / NAV × 10000 bps
     │
     ├── > +threshold bps → AP creates (buys BTC, gets shares, sells shares)
     └── < -threshold bps → AP redeems (buys shares, redeems for BTC, sells BTC)
           │
           └── Each arb event: compresses spread by convergence_speed × spread
                              earns: spread_captured - total_costs
```

---

## Key Results (as of Apr 17, 2026)

### Python Sim — Inception-to-Date (592 days, Monte Carlo)

| Metric | Value |
|--------|-------|
| Arb events | 37,010 |
| Creations | 33,432 units |
| Redemptions | 32,990 units |
| Avg premium/discount | 10.77 bps |
| **Cumulative AP P&L** | **$35,608,368** |

> Note: BTC path is randomly generated (GBM). Re-runs will produce different P&L.
> Each run uses `random_seed: 42` in config for reproducibility.

### Node.js — Historical Analysis

See `node/analysis.csv` for actual ARKB premium/discount data since launch.

---

*Last updated: 2026-04-17*
