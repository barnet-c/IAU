# ARKB Simulation Parameters â€” Source Documentation

This file documents every key parameter in the simulation, its source, confidence level, and notes on verification.

---

## ETF Structure Parameters

### Basket Size (Creation Unit)
| Parameter | Value | Confidence |
|-----------|-------|------------|
| `creation_unit_size` / `creationUnitShares` | **5,000 shares** | âœ… **Confirmed** |

**Source:** ARK 21Shares Bitcoin ETF S-1/A, filed January 9, 2024 (SEC Accession No. 0001193125-24-005412), page 1:
> *"bitcoin will be transferred into or out of the Trust, as applicable, in exchange for blocks of **5,000 Shares** (a 'Basket')"*

SEC EDGAR: https://www.sec.gov/Archives/edgar/data/1869699/000119312524005412/d549524ds1a.htm

---

### Management Fee (Sponsor Fee)
| Parameter | Value | Confidence |
|-----------|-------|------------|
| `management_fee_bps` / `managementFeeBps` | **21 bps (0.21%/yr)** | âœ… **Confirmed** |

**Source:** Same S-1/A, Fees and Expenses section:
> *"The Trust will pay the unitary Sponsor Fee of **0.21%** of the Trust's bitcoin holdings."*

Note: ARK waived the fee for the first 6 months OR first $1B AUM (whichever came first). For ongoing simulation, 21 bps applies.

---

### BTC Per Share
| Parameter | Value | Confidence |
|-----------|-------|------------|
| `btcPerShare` / `btc_per_share` | **~0.000303 BTC** (Apr 2026) | âš ï¸ **Derived from market prices** |

**Source:** Derived from live market data: ARKB ~$25.72 / BTC ~$85,000 = 0.000303 BTC/share (Apr 2026). At inception (Jan 11, 2024): ARKB ~$15.59 / BTC ~$46,369 = 0.000336 BTC/share. The ratio drifts down slowly over time as the 0.21%/yr sponsor fee accrues.

**Note:** The original config had `0.001050` which was incorrect (off by ~3.5Ã—). Corrected April 2026. Use the ARK 21Shares daily holdings CSV for the precise live value.

---

### Custodian
| Parameter | Value | Confidence |
|-----------|-------|------------|
| `custodian` | **Coinbase Custody Trust Company, LLC** | âœ… **Confirmed** |

**Source:** S-1/A, Trust structure section.

---

### Cash Custodian / Transfer Agent
| Parameter | Value | Confidence |
|-----------|-------|------------|
| Transfer Agent | **BNY Mellon** | âœ… **Confirmed** |
| Cash Custodian | **BNY Mellon** | âœ… **Confirmed** |

---

### Exchange
| Parameter | Value | Confidence |
|-----------|-------|------------|
| Listing exchange | **Cboe BZX Exchange** | âœ… **Confirmed** |
| Ticker | **ARKB** | âœ… **Confirmed** |

---

## Transaction / Creation Fee

| Parameter | Value | Confidence |
|-----------|-------|------------|
| `creationRedemptionFeeUsd` / `wire_fee_usd` | **âš ï¸ NOT PUBLICLY DISCLOSED â€” currently set to $500** | âŒ **Private commercial term** |

**What the prospectus says:** The S-1/A confirms a flat transaction fee exists, payable **per order** (not per basket), to the Transfer Agent (BNY Mellon). The exact dollar amount is defined in **Exhibit E of the Authorized Participant Agreement** â€” which in all public EDGAR filings is a blank placeholder dated `[DATE]`. It is a private commercial term between 21Shares US LLC (Sponsor) and each AP.

**Exhaustive search conducted (April 2026):**
- S-1/A (all 9 amendments, 2021â€“2024): No dollar amount stated
- 10-K annual reports (2024, 2025, 2026): No dollar amount stated
- AP Agreement EX-10.2: Exhibit E is blank `[DATE]` placeholder
- Cboe BZX 19b-4 rule filings (SR-CboeBZX-2023-028): Not mentioned
- Federal Register notices (Amendment No. 5, in-kind amendments): Not mentioned
- ARK Funds website: Not disclosed

**Best estimate based on analogous ETF data:**
- ARKB uses **cash-only** AP creations (AP deposits cash; Trust buys BTC via Bitcoin Counterparty)
- Calamos structured ETFs holding ARKB reference $100 (cash) / $250 (in-kind) as typical fee ranges for ETFs on their platform
- IBIT (BlackRock): $750 per order for 40,000-share baskets (in-kind)
- FBTC (Fidelity): ~$500 per order for 50,000-share baskets (in-kind)
- ARKB's cash model and smaller 5,000-share baskets suggest **~$100â€“$300** is most likely

**Sim impact at BTC = $85,000 (5,000-share basket â‰ˆ $446,250):**
- $100 fee = **~2.2 bps** of friction
- $300 fee = **~6.7 bps** of friction  
- $500 fee = **~11.2 bps** of friction

This materially affects the arb trigger threshold. The sim currently uses $500 â€” this is likely **too high**. Consider using $100â€“$300 pending confirmation.

**To confirm:** Contact ARK/21Shares investor relations at ark-funds.com or 21shares.com, or request the AP Agreement from an Authorized Participant (Jane Street, Virtu, etc.).

---

## Market / Cost Parameters

### BTC Execution Spread
| Parameter | Value | Source |
|-----------|-------|--------|
| `btcExecutionBps` / `btc_trading_spread_bps` | **2 bps (node) / 1 bps (python)** | Industry estimate |

Coinbase Prime BTC spread for institutional size is typically 1â€“3 bps. The node and python sims use slightly different defaults â€” should be aligned.

### ETF Trading Spread
| Parameter | Value | Source |
|-----------|-------|--------|
| `etfCommissionPerShare` | $0.005/share | Industry estimate |
| `etf_trading_spread_bps` | 2 bps | Industry estimate |

ARKB is liquid â€” intraday spread is typically 1â€“2 bps for small orders, potentially wider for basket-sized blocks.

### AP Trigger Threshold
| Parameter | Value | Source |
|-----------|-------|--------|
| `minSpreadAfterCostsBps` / `ap_trigger_threshold_bps` | **10 bps** | Conservative estimate |

Real APs likely trigger at smaller spreads (5â€“8 bps) given their scale advantages. 10 bps is a conservative floor for the simulation.

---

## Parameters Summary Table

| Parameter | Python Config | Node Config | Value | Verified? |
|-----------|--------------|-------------|-------|-----------|
| Basket size | `creation_unit_size` | `creationUnitShares` | 5,000 shares | âœ… Yes |
| Mgmt fee | `management_fee_bps` | `managementFeeBps` | 21 bps | âœ… Yes |
| BTC/share | `btc_per_share` | `btcPerShare` | ~0.001050 | âš ï¸ Approx |
| Creation fee | `wire_fee_usd` | `creationRedemptionFeeUsd` | $500 | âŒ Unconfirmed |
| Custodian | â€” | `custodian` | Coinbase Custody | âœ… Yes |
| BTC spread | `btc_trading_spread_bps` | `btcExecutionBps` | 1â€“2 bps | âš ï¸ Estimate |
| ETF spread | `etf_trading_spread_bps` | `etfCommissionPerShare` | 2 bps / $0.005 | âš ï¸ Estimate |
| Arb threshold | `ap_trigger_threshold_bps` | `minSpreadAfterCostsBps` | 10 bps | âš ï¸ Estimate |

---

## References

- ARKB S-1/A (Jan 10, 2024): https://www.sec.gov/Archives/edgar/data/1869699/000119312524005412/d549524ds1a.htm
- ARKB EDGAR filing index: https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001869699&type=S-1
- ARK Funds ARKB page: https://ark-funds.com/funds/arkb/
- Live holdings CSV: https://ark-funds.com/wp-content/uploads/funds-etf-csv/ARK_21SHARES_BITCOIN_ETF_ARKB_HOLDINGS.csv

---

*Last updated: 2026-08-10*
*Basket size updated from 50,000 â†’ 5,000 based on prospectus review.*
*Creation fee flagged as unconfirmed â€” Exhibit E of AP Agreement not accessible.*

