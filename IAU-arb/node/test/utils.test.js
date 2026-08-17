#!/usr/bin/env node
const assert = require('assert');
const {
  totalCostBps, evaluateSignal, createSignalGate, resolveBtcPerShare, midPrice, costBreakdown,
} = require('../lib/utils');
const config = {
  etf: { creationUnitShares: 5000, btcPerShare: 0.000303 },
  costs: { creationRedemptionFeeUsd: 200, etfCommissionPerShare: 0.005, btcExecutionBps: 2, marketImpactBps: 1, btcSpotSpreadBps: 2 },
  signals: { minSpreadAfterCostsBps: 10 },
};
function approx(a, b, eps = 1e-6) { assert.ok(Math.abs(a - b) <= eps, `expected ${a} ~ ${b}`); }
const mid = 25.755;
const cost = totalCostBps(config, mid);
assert.ok(Number.isFinite(cost) && cost > 0 && cost < 100, 'cost range');
approx(costBreakdown(config, mid).totalBps, cost);
assert.strictEqual(totalCostBps(config, 0), Infinity);
const btc = 85000, bps = 0.000303, nav = btc * bps;
assert.strictEqual(evaluateSignal({ arkbMid: nav, btcPrice: btc, btcPerShare: bps, config }).signal, 'NEUTRAL');
assert.strictEqual(evaluateSignal({ arkbMid: nav * 1.01, btcPrice: btc, btcPerShare: bps, config }).signal, 'CREATE');
assert.strictEqual(evaluateSignal({ arkbMid: nav * 0.99, btcPrice: btc, btcPerShare: bps, config }).signal, 'REDEEM');
const wrong = evaluateSignal({ arkbMid: 30, btcPrice: btc, btcPerShare: 30 / btc, config });
approx(wrong.premBps, 0, 1e-9);
const right = evaluateSignal({ arkbMid: 30, btcPrice: btc, btcPerShare: bps, config });
assert.ok(Math.abs(right.premBps) > 100, 'true premium large');
assert.strictEqual(resolveBtcPerShare(config, { btcPerShare: 0.00031, source: 'x' }).btcPerShare, 0.00031);
assert.strictEqual(midPrice(10, 12), 11);
const gate = createSignalGate(10000);
assert.strictEqual(gate.shouldEmit('CREATE'), true);
assert.strictEqual(gate.shouldEmit('CREATE'), false);
assert.strictEqual(gate.shouldEmit('REDEEM'), true);
console.log('All utils tests passed.');
