#!/usr/bin/env bash
# run.sh — Quick launcher for ARKB arbitrage simulation
set -e
cd "$(dirname "$0")"

echo "Installing optional deps (silent)..."
pip3 install matplotlib rich 2>/dev/null | tail -1

echo ""
echo "=== Running 1-day default simulation ==="
python3 sim.py

echo ""
echo "=== Running 5-day stress sim (higher vol) ==="
python3 sim.py --days 5 --vol 0.04 --seed 99 --out results/stress

echo ""
echo "=== Running low-threshold sim (tight arb, 5bps) ==="
python3 sim.py --days 2 --ap-threshold 5 --seed 7 --out results/tight-arb

echo ""
echo "Done! Check results/ for CSV + charts."
