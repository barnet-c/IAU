# ARKB Arb — Node.js Monitor & Dashboard

Real-time arbitrage monitor and web dashboard for **ARKB (ARK 21Shares Bitcoin ETF)**, built to match the architecture of the IBIT arb Node.js project.

## Structure

```
node/
├── analyze.js       # Phase 1: Historical analysis (Yahoo Finance + ARK holdings CSV)
├── monitor.js       # Phase 2: Live terminal monitor (Coinbase WS + Yahoo Finance)
├── dashboard.js     # Phase 3: Express + Socket.IO web dashboard
├── lib/
│   ├── utils.js     # Shared: ARK holdings fetch, cost model, formatters
│   └── discord.js   # Discord alerts (#arkb-arb-alerts channel)
├── public/
│   └── index.html   # Web UI (Chart.js live premium/discount chart)
├── config.json      # All parameters
└── .env             # Discord credentials (DISCORD_TOKEN, DISCORD_USER_ID, GUILD_ID)
```

## ARKB vs IBIT Differences

| | IBIT (BlackRock) | ARKB (ARK 21Shares) |
|---|---|---|
| Sponsor | BlackRock | ARK Investment Management / 21Shares |
| Custodian | Coinbase Custody | Coinbase Custody |
| Creation unit | 40,000 shares | **5,000 shares** |
| BTC per share | ~0.000567 | **~0.000303** |
| Mgmt fee | 0.25% | **0.21%** |
| Holdings source | BlackRock iShares JSON API | **ARK 21Shares CSV** |
| Creation fee | $750 | **~$300 (⚠️ unconfirmed — see PARAMETERS.md)** |

## Usage

```bash
# Install deps
npm install

# Phase 1: Historical analysis (fetches Yahoo Finance data)
node analyze.js

# Phase 2: Terminal monitor (dry run — simulated prices)
node monitor.js --dry-run

# Phase 2: Terminal monitor (live — Coinbase WS + Yahoo Finance)
node monitor.js

# Phase 3: Web dashboard (dry run)
node dashboard.js --dry-run

# Phase 3: Web dashboard (live, custom port)
node dashboard.js --port 8080

# Or use npm scripts
npm run analyze
npm run monitor      # dry run
npm run dashboard    # dry run
npm test             # unit tests
npm run test:all     # tests + build + smoke verify
```

## Discord Alerts

Copy `.env.example` (or create `.env`) with:
```
DISCORD_TOKEN=your_bot_token
DISCORD_USER_ID=your_user_id
DISCORD_GUILD_ID=your_guild_id
```

The bot will create/find a `#arkb-arb-alerts` channel and post embeds on CREATE/REDEEM signals.

## Critical correctness note

**Do not derive tcPerShare from live ARKB mid / BTC spot.** That forces NAV ~ mid and zeros premium/discount.
This codebase resolves BTC/share from config + ARK holdings CSV only.

## How It Works

### Creation (ETF at premium)
1. AP buys BTC on spot
2. Delivers BTC to **Coinbase Custody**
3. Receives 5,000 ARKB shares from ARK/21Shares
4. Sells ARKB shares on exchange → captures premium

### Redemption (ETF at discount)
1. AP buys ARKB shares on exchange (below NAV)
2. Redeems with **ARK / 21Shares**
3. Receives BTC from Coinbase Custody
4. Sells BTC on spot → captures discount

### Cost Model
- Creation/redemption fee: ~$300 flat (**⚠️ unconfirmed — see PARAMETERS.md**)
- ETF commission: $0.005/share
- BTC execution: 2 bps
- Market impact (×2): 1 bps each side
- BTC spot spread: 2 bps
- **Total: ~8 bps + flat fee (amortized)**

Signal triggers when `|premium| > total_cost_bps + 5 bps` (configurable via
`signals.minSpreadAfterCostsBps`).
