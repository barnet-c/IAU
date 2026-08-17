/**
 * ARKB ETF Arbitrage — Shared utilities
 *
 * IMPORTANT: Never derive btcPerShare from ARKB_mid / BTC_spot.
 * That identity forces NAV ≈ mid and zeros measured premium/discount.
 */

const https = require('https');
const http = require('http');
const zlib = require('zlib');

// Last-resort fallback only: config.json is preferred, ARK holdings above that.
// Keep in step with config.json — 0.000303 was stale by ~950 bps.
const DEFAULT_BTC_PER_SHARE = 0.0003315923068464;
const DEFAULT_SHARES_OUTSTANDING = 75_000_000;

function pickModule(url) {
  return url.startsWith('https') ? https : http;
}

function fetchText(url, { timeoutMs = 15000, accept = '*/*', maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) {
      reject(new Error(`Too many redirects for ${url}`));
      return;
    }

    const mod = pickModule(url);
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'ARKB-Arb-Monitor/2.0 (+https://github.com/bazinganinga67/ARKB)',
        'Accept': accept,
        'Accept-Encoding': 'gzip, deflate, identity',
      },
      timeout: timeoutMs,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        fetchText(next, { timeoutMs, accept, maxRedirects: maxRedirects - 1 })
          .then(resolve)
          .catch(reject);
        return;
      }

      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }

      let stream = res;
      const encoding = (res.headers['content-encoding'] || '').toLowerCase();
      if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());

      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => {
        let data = Buffer.concat(chunks).toString('utf8');
        if (data.charCodeAt(0) === 0xFEFF) data = data.slice(1);
        resolve(data);
      });
      stream.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timed out for ${url}`));
    });
  });
}

function fetchJson(url, options = {}) {
  return fetchText(url, { ...options, accept: 'application/json' }).then((text) => {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`Failed to parse JSON from ${url}: ${e.message}\nBody: ${text.slice(0, 200)}`);
    }
  });
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function parseNumber(value) {
  if (value == null) return NaN;
  const cleaned = String(value).replace(/[$,\s]/g, '').replace(/%/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '—') return NaN;
  return Number(cleaned);
}

async function fetchArkHoldings(config) {
  const url = config?.ark21shares?.holdingsUrl;
  if (!url) throw new Error('config.ark21shares.holdingsUrl is required');

  const data = await fetchText(url, { accept: 'text/csv,*/*', timeoutMs: 15000 });
  const lines = data.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error('ARK holdings CSV is empty');

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const findCol = (...needles) => header.findIndex((h) => needles.every((n) => h.includes(n)));

  const sharesIdx = findCol('shares');
  const qtyIdx = sharesIdx >= 0 ? sharesIdx : findCol('quantity');
  const mvIdx = header.findIndex((h) => h.includes('market') && h.includes('value'));
  const tickerIdx = findCol('ticker');
  const companyIdx = findCol('company');
  const dateIdx = header.findIndex((h) => h.includes('date'));
  const weightIdx = header.findIndex((h) => h.includes('weight'));

  let btcLine = null;
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    const ticker = (tickerIdx >= 0 ? cols[tickerIdx] : '').toUpperCase();
    const company = (companyIdx >= 0 ? cols[companyIdx] : '').toUpperCase();
    const joined = cols.join(' ').toUpperCase();
    if (
      ticker === 'BTC' ||
      ticker.includes('BTC') ||
      company.includes('BITCOIN') ||
      joined.includes('BITCOIN')
    ) {
      btcLine = cols;
      break;
    }
  }
  if (!btcLine) throw new Error('BTC row not found in ARK holdings CSV');

  const btcQuantity = qtyIdx >= 0 ? parseNumber(btcLine[qtyIdx]) : NaN;
  const marketValue = mvIdx >= 0 ? parseNumber(btcLine[mvIdx]) : NaN;
  const asOf = dateIdx >= 0 ? btcLine[dateIdx] : null;

  let sharesOutstanding = NaN;
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    const joined = cols.join(' ').toLowerCase();
    if (joined.includes('shares outstanding') || joined.includes('net assets')) {
      for (const col of cols) {
        const n = parseNumber(col);
        if (Number.isFinite(n) && n > 1_000_000) {
          sharesOutstanding = n;
          break;
        }
      }
    }
    if (Number.isFinite(sharesOutstanding)) break;
  }

  if (!Number.isFinite(sharesOutstanding)) {
    sharesOutstanding = Number(config?.etf?.sharesOutstanding) || DEFAULT_SHARES_OUTSTANDING;
  }

  let btcPerShare = NaN;
  if (Number.isFinite(btcQuantity) && btcQuantity > 0 && sharesOutstanding > 0) {
    btcPerShare = btcQuantity / sharesOutstanding;
  }

  return {
    btcQuantity: Number.isFinite(btcQuantity) ? btcQuantity : 0,
    marketValue: Number.isFinite(marketValue) ? marketValue : 0,
    sharesOutstanding,
    btcPerShare: Number.isFinite(btcPerShare) ? btcPerShare : null,
    weight: weightIdx >= 0 ? parseNumber(btcLine[weightIdx]) : null,
    asOf,
    source: 'ark-holdings-csv',
  };
}

function resolveBtcPerShare(config, holdings = null) {
  if (holdings && Number.isFinite(holdings.btcPerShare) && holdings.btcPerShare > 0) {
    return {
      btcPerShare: holdings.btcPerShare,
      source: holdings.source || 'ark-holdings-csv',
      sharesOutstanding: holdings.sharesOutstanding,
      btcQuantity: holdings.btcQuantity,
    };
  }

  const fromConfig = Number(config?.etf?.btcPerShare);
  if (Number.isFinite(fromConfig) && fromConfig > 0) {
    return {
      btcPerShare: fromConfig,
      source: 'config',
      sharesOutstanding: Number(config?.etf?.sharesOutstanding) || DEFAULT_SHARES_OUTSTANDING,
      btcQuantity: null,
    };
  }

  return {
    btcPerShare: DEFAULT_BTC_PER_SHARE,
    source: 'default',
    sharesOutstanding: DEFAULT_SHARES_OUTSTANDING,
    btcQuantity: null,
  };
}

function totalCostBps(config, arkbPrice) {
  const price = Number(arkbPrice);
  if (!Number.isFinite(price) || price <= 0) return Infinity;

  const c = config.costs || {};
  const cu = Number(config.etf?.creationUnitShares) || 5000;
  const notional = cu * price;
  if (!(notional > 0)) return Infinity;

  const feeUsd = Number(c.creationRedemptionFeeUsd) || 0;
  const commissionPerShare = Number(c.etfCommissionPerShare) || 0;
  const btcExec = Number(c.btcExecutionBps) || 0;
  const impact = Number(c.marketImpactBps) || 0;
  const spotSpread = Number(c.btcSpotSpreadBps) || 0;

  const feeBps = (feeUsd / notional) * 10000;
  const commBps = (commissionPerShare / price) * 10000;
  return feeBps + commBps + btcExec + impact * 2 + spotSpread;
}

function costBreakdown(config, arkbPrice) {
  const price = Number(arkbPrice);
  const cu = Number(config.etf?.creationUnitShares) || 5000;
  const c = config.costs || {};
  const notional = cu * price;
  const feeUsd = Number(c.creationRedemptionFeeUsd) || 0;
  const commissionPerShare = Number(c.etfCommissionPerShare) || 0;

  return {
    creationUnitShares: cu,
    notionalUsd: notional,
    feeUsd,
    feeBps: notional > 0 ? (feeUsd / notional) * 10000 : Infinity,
    commissionPerShare,
    commissionBps: price > 0 ? (commissionPerShare / price) * 10000 : Infinity,
    btcExecutionBps: Number(c.btcExecutionBps) || 0,
    marketImpactBpsEach: Number(c.marketImpactBps) || 0,
    marketImpactBpsTotal: (Number(c.marketImpactBps) || 0) * 2,
    btcSpotSpreadBps: Number(c.btcSpotSpreadBps) || 0,
    totalBps: totalCostBps(config, price),
  };
}

function evaluateSignal({ arkbMid, btcPrice, btcPerShare, config }) {
  const mid = Number(arkbMid);
  const btc = Number(btcPrice);
  const bps = Number(btcPerShare);

  if (!(mid > 0) || !(btc > 0) || !(bps > 0)) {
    return {
      ok: false,
      nav: 0,
      premBps: 0,
      costBps: Infinity,
      triggerBps: Infinity,
      signal: 'NEUTRAL',
      spreadCapturedBps: 0,
      pnlUsd: 0,
    };
  }

  const nav = btc * bps;
  const premBps = ((mid - nav) / nav) * 10000;
  const costBps = totalCostBps(config, mid);
  const minEdge = Number(config.signals?.minSpreadAfterCostsBps) || 0;
  const triggerBps = costBps + minEdge;

  let signal = 'NEUTRAL';
  if (premBps > triggerBps) signal = 'CREATE';
  else if (premBps < -triggerBps) signal = 'REDEEM';

  const spreadCapturedBps = signal === 'NEUTRAL' ? 0 : Math.abs(premBps) - costBps;
  const cu = Number(config.etf?.creationUnitShares) || 5000;
  const pnlUsd = (spreadCapturedBps / 10000) * cu * mid;

  return {
    ok: true,
    nav,
    premBps,
    costBps,
    triggerBps,
    signal,
    spreadCapturedBps,
    pnlUsd,
    creationUnitNotional: cu * mid,
    creationUnitBtc: cu * bps,
  };
}

function createSignalGate(cooldownMs = 15000) {
  let lastAt = 0;
  let lastSignal = 'NEUTRAL';

  return {
    shouldEmit(signal) {
      if (!signal || signal === 'NEUTRAL') {
        lastSignal = 'NEUTRAL';
        return false;
      }
      const now = Date.now();
      if (signal === lastSignal && now - lastAt < cooldownMs) return false;
      lastSignal = signal;
      lastAt = now;
      return true;
    },
    reset() {
      lastAt = 0;
      lastSignal = 'NEUTRAL';
    },
  };
}

function midPrice(bid, ask, last = 0) {
  const b = Number(bid) || 0;
  const a = Number(ask) || 0;
  if (b > 0 && a > 0) return (b + a) / 2;
  const l = Number(last) || 0;
  return l > 0 ? l : 0;
}

function fmt(n, decimals = 2) {
  const value = Number(n);
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtUsd(n, decimals = 2) {
  const value = Number(n);
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  return `${sign}$${fmt(Math.abs(value), decimals)}`;
}

module.exports = {
  DEFAULT_BTC_PER_SHARE,
  DEFAULT_SHARES_OUTSTANDING,
  fetchText,
  fetchJson,
  fetchArkHoldings,
  resolveBtcPerShare,
  totalCostBps,
  costBreakdown,
  evaluateSignal,
  createSignalGate,
  midPrice,
  fmt,
  fmtUsd,
  parseCsvLine,
  parseNumber,
};
