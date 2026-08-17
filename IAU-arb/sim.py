#!/usr/bin/env python3
"""
ARKB ETF Creation/Redemption Arbitrage Simulation
==================================================
Models intraday arbitrage between ARKB market price and Bitcoin NAV,
driven by Authorized Participants (APs) exploiting premium/discount spreads.

Author: OpenClaw Simulation Engine
"""

import argparse
import json
import math
import os
import random
import sys
from dataclasses import dataclass, field
from typing import List, Optional
import csv
from datetime import datetime, timedelta

# ─── Optional rich output ────────────────────────────────────────────────────
try:
    from rich.console import Console
    from rich.table import Table
    from rich.panel import Panel
    from rich.progress import track
    from rich import print as rprint
    RICH = True
    console = Console()
except ImportError:
    RICH = False
    console = None

# ─── Optional matplotlib ─────────────────────────────────────────────────────
try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.gridspec as gridspec
    MATPLOTLIB = True
except ImportError:
    MATPLOTLIB = False


# ─── Data classes ─────────────────────────────────────────────────────────────

@dataclass
class SimConfig:
    # ETF
    ticker: str = "ARKB"
    shares_outstanding: int = 75_000_000
    creation_unit_size: int = 5_000
    btc_per_share: float = 0.000303
    management_fee_bps: float = 21.0

    # Market
    btc_spot_price_usd: float = 85_000.0
    trading_days: int = 1
    minutes_per_day: int = 390
    btc_daily_vol: float = 0.025
    market_noise_vol_bps: float = 8.0

    # Arbitrage
    ap_trigger_threshold_bps: float = 10.0
    ap_transaction_cost_bps: float = 8.0
    ap_execution_delay_minutes: int = 15
    max_creation_units_per_trade: int = 3
    convergence_speed: float = 0.7
    num_aps: int = 4

    # Costs
    btc_trading_spread_bps: float = 2.0
    etf_trading_spread_bps: float = 2.0
    wire_fee_usd: float = 200.0
    wire_fee_per_order: bool = True

    # Sim
    random_seed: int = 42
    output_dir: str = "results"

    @classmethod
    def from_json(cls, path: str) -> "SimConfig":
        with open(path) as f:
            raw = json.load(f)
        c = cls()
        etf = raw.get("etf", {})
        mkt = raw.get("market", {})
        arb = raw.get("arbitrage", {})
        costs = raw.get("costs", {})
        sim = raw.get("simulation", {})

        c.ticker = etf.get("ticker", c.ticker)
        c.shares_outstanding = etf.get("shares_outstanding", c.shares_outstanding)
        c.creation_unit_size = etf.get("creation_unit_size", c.creation_unit_size)
        c.btc_per_share = etf.get("btc_per_share", c.btc_per_share)
        c.management_fee_bps = etf.get("management_fee_bps", c.management_fee_bps)

        c.btc_spot_price_usd = mkt.get("btc_spot_price_usd", c.btc_spot_price_usd)
        c.trading_days = mkt.get("trading_days", c.trading_days)
        c.minutes_per_day = mkt.get("minutes_per_day", c.minutes_per_day)
        c.btc_daily_vol = mkt.get("btc_daily_vol", c.btc_daily_vol)
        c.market_noise_vol_bps = mkt.get("market_noise_vol_bps", c.market_noise_vol_bps)

        c.ap_trigger_threshold_bps = arb.get("ap_trigger_threshold_bps", c.ap_trigger_threshold_bps)
        c.ap_transaction_cost_bps = arb.get("ap_transaction_cost_bps", c.ap_transaction_cost_bps)
        c.ap_execution_delay_minutes = arb.get("ap_execution_delay_minutes", c.ap_execution_delay_minutes)
        c.max_creation_units_per_trade = arb.get("max_creation_units_per_trade", c.max_creation_units_per_trade)
        c.convergence_speed = arb.get("convergence_speed", c.convergence_speed)
        c.num_aps = arb.get("num_aps", c.num_aps)

        c.btc_trading_spread_bps = costs.get("btc_trading_spread_bps", c.btc_trading_spread_bps)
        c.etf_trading_spread_bps = costs.get("etf_trading_spread_bps", c.etf_trading_spread_bps)
        c.wire_fee_usd = costs.get("wire_fee_usd", c.wire_fee_usd)
        c.wire_fee_per_order = bool(costs.get("wire_fee_per_order", getattr(c, "wire_fee_per_order", True)))

        c.random_seed = sim.get("random_seed", c.random_seed)
        c.output_dir = sim.get("output_dir", c.output_dir)
        c.validate()
        return c

    def validate(self) -> None:
        if self.creation_unit_size <= 0:
            raise ValueError("creation_unit_size must be > 0")
        if self.btc_per_share <= 0:
            raise ValueError("btc_per_share must be > 0")
        if self.btc_spot_price_usd <= 0:
            raise ValueError("btc_spot_price_usd must be > 0")
        if self.trading_days <= 0:
            raise ValueError("trading_days must be > 0")
        if self.minutes_per_day <= 0:
            raise ValueError("minutes_per_day must be > 0")
        if self.num_aps <= 0:
            raise ValueError("num_aps must be > 0")
        if not (0 < self.convergence_speed <= 1):
            raise ValueError("convergence_speed must be in (0, 1]")
        if self.shares_outstanding < self.creation_unit_size:
            raise ValueError("shares_outstanding must cover at least one creation unit")


@dataclass
class MinuteSnapshot:
    minute: int
    day: int
    btc_price: float
    nav_per_share: float
    market_price: float
    premium_bps: float
    creations: int           # creation units created this minute
    redemptions: int         # creation units redeemed this minute
    shares_outstanding: int
    ap_pnl_usd: float        # cumulative AP P&L
    total_arb_events: int


@dataclass
class ArbEvent:
    minute: int
    day: int
    event_type: str          # "creation" or "redemption"
    units: int
    spread_bps: float
    gross_pnl_usd: float
    net_pnl_usd: float
    btc_price: float
    etf_price: float


# ─── Simulation Engine ────────────────────────────────────────────────────────

class ARKBSimulation:
    def __init__(self, cfg: SimConfig):
        self.cfg = cfg
        random.seed(cfg.random_seed)
        self._seed_state = random.getstate()

        # Use Box-Muller for normals
        self._norm_spare: Optional[float] = None

        # State
        self.btc_price = cfg.btc_spot_price_usd
        self.shares_outstanding = cfg.shares_outstanding
        self.market_premium_bps = cfg.market_noise_vol_bps * self._randn() * 0.5

        # Per-minute vol (from daily vol via square-root-of-time)
        self.per_min_vol = cfg.btc_daily_vol / math.sqrt(cfg.minutes_per_day)

        # AP cooldown tracking: each AP has a cooldown counter
        self.ap_cooldowns = [0] * cfg.num_aps

        # Accumulators
        self.snapshots: List[MinuteSnapshot] = []
        self.arb_events: List[ArbEvent] = []
        self.cumulative_ap_pnl = 0.0
        self.total_arb_events = 0
        self.elapsed_minutes = 0

    def _randn(self) -> float:
        """Box-Muller normal sample."""
        if self._norm_spare is not None:
            v = self._norm_spare
            self._norm_spare = None
            return v
        while True:
            u = random.random() * 2 - 1
            v = random.random() * 2 - 1
            s = u * u + v * v
            if 0 < s < 1:
                mul = math.sqrt(-2.0 * math.log(s) / s)
                self._norm_spare = v * mul
                return u * mul

    def nav_per_share(self) -> float:
        """Intraday indicative NAV per share with accrued sponsor fee."""
        gross = self.btc_price * self.cfg.btc_per_share
        # Accrue management fee over elapsed simulation minutes
        minutes_per_year = 252 * 390
        fee_frac = (self.cfg.management_fee_bps / 10_000) * (self.elapsed_minutes / minutes_per_year)
        fee_frac = min(fee_frac, 0.05)  # safety cap
        return gross * (1.0 - fee_frac)

    def market_price(self) -> float:
        """Market price = NAV * (1 + premium)."""
        return self.nav_per_share() * (1 + self.market_premium_bps / 10_000)

    def _step_btc_price(self):
        """GBM step for BTC spot price."""
        drift = -0.5 * self.per_min_vol ** 2  # Ito correction
        shock = self.per_min_vol * self._randn()
        self.btc_price *= math.exp(drift + shock)

    def _step_market_noise(self):
        """Random walk for market premium with mean-reversion."""
        noise_vol = self.cfg.market_noise_vol_bps / 10_000
        mean_rev = 0.05  # pulls toward 0 each minute
        self.market_premium_bps += (
            -mean_rev * self.market_premium_bps
            + noise_vol * self._randn() * 10_000
        )

    def _try_arbitrage(self, minute: int, day: int) -> tuple:
        """
        Each AP independently checks whether to arb.
        Returns (creations, redemptions, pnl) for this minute.
        """
        nav = self.nav_per_share()
        mkt = self.market_price()
        premium_bps = self.market_premium_bps
        creations = 0
        redemptions = 0
        minute_pnl = 0.0

        threshold = self.cfg.ap_trigger_threshold_bps
        cost_bps = self.cfg.ap_transaction_cost_bps
        unit_size = self.cfg.creation_unit_size
        btc_per_unit = unit_size * self.cfg.btc_per_share

        for ap_idx in range(self.cfg.num_aps):
            # AP on cooldown?
            if self.ap_cooldowns[ap_idx] > 0:
                self.ap_cooldowns[ap_idx] -= 1
                continue

            spread = abs(premium_bps)
            if spread < threshold:
                continue

            # AP will trade 1-max_creation_units based on spread conviction
            conviction = min(
                self.cfg.max_creation_units_per_trade,
                max(1, int(spread / threshold))
            )
            # Each AP randomly participates (simulate competition)
            if random.random() > 0.6:
                continue

            units = conviction

            if premium_bps > threshold:
                # ETF at premium → CREATION
                # AP buys BTC, delivers to custodian, receives ARKB shares, sells shares
                # Cost: BTC spread + wire + ETF spread
                btc_cost = nav * unit_size * (1 + self.cfg.btc_trading_spread_bps / 10_000)
                etf_proceeds = mkt * unit_size * (1 - self.cfg.etf_trading_spread_bps / 10_000)
                gross_pnl = (etf_proceeds - btc_cost) * units
                wire = self.cfg.wire_fee_usd if getattr(self.cfg, "wire_fee_per_order", True) else self.cfg.wire_fee_usd * units
                net_pnl = gross_pnl - wire

                if net_pnl > 0:
                    creations += units
                    minute_pnl += net_pnl
                    self.shares_outstanding += units * unit_size
                    # Convergence: premium compresses
                    self.market_premium_bps *= (1 - self.cfg.convergence_speed * units / self.cfg.max_creation_units_per_trade)
                    self.ap_cooldowns[ap_idx] = self.cfg.ap_execution_delay_minutes

                    self.arb_events.append(ArbEvent(
                        minute=minute, day=day, event_type="creation",
                        units=units, spread_bps=premium_bps,
                        gross_pnl_usd=gross_pnl, net_pnl_usd=net_pnl,
                        btc_price=self.btc_price, etf_price=mkt
                    ))

            elif premium_bps < -threshold:
                # ETF at discount → REDEMPTION
                # AP buys ARKB shares cheap, redeems for BTC, sells BTC
                etf_cost = mkt * unit_size * (1 + self.cfg.etf_trading_spread_bps / 10_000)
                btc_proceeds = nav * unit_size * (1 - self.cfg.btc_trading_spread_bps / 10_000)
                gross_pnl = (btc_proceeds - etf_cost) * units
                wire = self.cfg.wire_fee_usd if getattr(self.cfg, "wire_fee_per_order", True) else self.cfg.wire_fee_usd * units
                net_pnl = gross_pnl - wire

                if net_pnl > 0:
                    # Keep shares outstanding non-negative
                    max_units = self.shares_outstanding // unit_size
                    if max_units <= 0:
                        continue
                    units = min(units, max_units)
                    # recompute pnl if units clamped
                    if units != conviction:
                        gross_pnl = (btc_proceeds - etf_cost) * units
                        net_pnl = gross_pnl - wire
                        if net_pnl <= 0:
                            continue
                    redemptions += units
                    minute_pnl += net_pnl
                    self.shares_outstanding -= units * unit_size
                    # Convergence: discount compresses
                    self.market_premium_bps *= (1 - self.cfg.convergence_speed * units / self.cfg.max_creation_units_per_trade)
                    self.ap_cooldowns[ap_idx] = self.cfg.ap_execution_delay_minutes

                    self.arb_events.append(ArbEvent(
                        minute=minute, day=day, event_type="redemption",
                        units=units, spread_bps=premium_bps,
                        gross_pnl_usd=gross_pnl, net_pnl_usd=net_pnl,
                        btc_price=self.btc_price, etf_price=mkt
                    ))

        return creations, redemptions, minute_pnl

    def run(self) -> List[MinuteSnapshot]:
        total_minutes = self.cfg.trading_days * self.cfg.minutes_per_day

        iterator = range(total_minutes)
        if RICH:
            iterator = track(iterator, description="[cyan]Simulating ARKB intraday...")

        for t in iterator:
            day = t // self.cfg.minutes_per_day + 1
            minute = t % self.cfg.minutes_per_day
            self.elapsed_minutes = t + 1

            # Step prices
            self._step_btc_price()
            self._step_market_noise()

            # AP arbitrage check
            creations, redemptions, pnl = self._try_arbitrage(minute, day)
            self.cumulative_ap_pnl += pnl
            self.total_arb_events += (1 if (creations + redemptions) > 0 else 0)

            snap = MinuteSnapshot(
                minute=minute,
                day=day,
                btc_price=self.btc_price,
                nav_per_share=self.nav_per_share(),
                market_price=self.market_price(),
                premium_bps=self.market_premium_bps,
                creations=creations,
                redemptions=redemptions,
                shares_outstanding=self.shares_outstanding,
                ap_pnl_usd=self.cumulative_ap_pnl,
                total_arb_events=self.total_arb_events,
            )
            self.snapshots.append(snap)

        return self.snapshots


# ─── Output ───────────────────────────────────────────────────────────────────

def save_csv(snapshots: List[MinuteSnapshot], arb_events: List[ArbEvent], out_dir: str):
    os.makedirs(out_dir, exist_ok=True)

    # Minute snapshots
    snap_path = os.path.join(out_dir, "snapshots.csv")
    with open(snap_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["day", "minute", "btc_price", "nav_per_share", "market_price",
                    "premium_bps", "creations", "redemptions",
                    "shares_outstanding", "ap_pnl_cumulative_usd"])
        for s in snapshots:
            w.writerow([s.day, s.minute, f"{s.btc_price:.2f}", f"{s.nav_per_share:.4f}",
                        f"{s.market_price:.4f}", f"{s.premium_bps:.4f}",
                        s.creations, s.redemptions, s.shares_outstanding,
                        f"{s.ap_pnl_usd:.2f}"])

    # Arb events
    arb_path = os.path.join(out_dir, "arb_events.csv")
    with open(arb_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["day", "minute", "type", "units", "spread_bps",
                    "gross_pnl_usd", "net_pnl_usd", "btc_price", "etf_price"])
        for e in arb_events:
            w.writerow([e.day, e.minute, e.event_type, e.units,
                        f"{e.spread_bps:.2f}", f"{e.gross_pnl_usd:.2f}",
                        f"{e.net_pnl_usd:.2f}", f"{e.btc_price:.2f}",
                        f"{e.etf_price:.4f}"])

    return snap_path, arb_path


def save_chart(snapshots: List[MinuteSnapshot], arb_events: List[ArbEvent],
               cfg: SimConfig, out_dir: str) -> str:
    if not MATPLOTLIB:
        return ""
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "arkb_arb_simulation.png")

    minutes = [s.minute + (s.day - 1) * cfg.minutes_per_day for s in snapshots]
    nav = [s.nav_per_share for s in snapshots]
    mkt = [s.market_price for s in snapshots]
    prem = [s.premium_bps for s in snapshots]
    btc = [s.btc_price for s in snapshots]
    shares = [s.shares_outstanding / 1_000_000 for s in snapshots]
    ap_pnl = [s.ap_pnl_usd for s in snapshots]

    creation_mins = [e.minute + (e.day-1)*cfg.minutes_per_day for e in arb_events if e.event_type == "creation"]
    redemption_mins = [e.minute + (e.day-1)*cfg.minutes_per_day for e in arb_events if e.event_type == "redemption"]

    fig = plt.figure(figsize=(16, 12), facecolor="#0d1117")
    fig.suptitle(f"ARKB ETF Creation/Redemption Arbitrage Simulation\n"
                 f"BTC @ ${cfg.btc_spot_price_usd:,.0f} | {cfg.trading_days}d | "
                 f"AP Threshold: {cfg.ap_trigger_threshold_bps}bps",
                 color="white", fontsize=14, y=0.98)

    gs = gridspec.GridSpec(3, 2, figure=fig, hspace=0.45, wspace=0.35)

    ax_style = dict(facecolor="#161b22", grid_color="#30363d")

    def style_ax(ax, title, ylabel):
        ax.set_facecolor(ax_style["facecolor"])
        ax.spines[:].set_color("#30363d")
        ax.tick_params(colors="#8b949e", labelsize=8)
        ax.set_title(title, color="#e6edf3", fontsize=10, pad=6)
        ax.set_ylabel(ylabel, color="#8b949e", fontsize=8)
        ax.set_xlabel("Minutes", color="#8b949e", fontsize=8)
        ax.grid(True, color="#30363d", linewidth=0.5, linestyle="--", alpha=0.7)

    # 1. BTC Spot Price
    ax1 = fig.add_subplot(gs[0, 0])
    ax1.plot(minutes, btc, color="#f7931a", linewidth=1.2, label="BTC Spot")
    style_ax(ax1, "Bitcoin Spot Price", "USD")
    ax1.yaxis.set_major_formatter(plt.FuncFormatter(lambda x, _: f"${x:,.0f}"))

    # 2. ARKB NAV vs Market Price
    ax2 = fig.add_subplot(gs[0, 1])
    ax2.plot(minutes, nav, color="#58a6ff", linewidth=1.2, label="NAV/Share", alpha=0.9)
    ax2.plot(minutes, mkt, color="#3fb950", linewidth=1.0, label="Market Price", alpha=0.8)
    if creation_mins:
        c_nav = [nav[m] for m in creation_mins if m < len(nav)]
        ax2.scatter(creation_mins[:len(c_nav)], c_nav, color="#ff7b72", s=20, zorder=5, label="Creation", marker="^")
    if redemption_mins:
        r_nav = [nav[m] for m in redemption_mins if m < len(nav)]
        ax2.scatter(redemption_mins[:len(r_nav)], r_nav, color="#d2a8ff", s=20, zorder=5, label="Redemption", marker="v")
    ax2.legend(fontsize=7, facecolor="#161b22", labelcolor="white", framealpha=0.8)
    style_ax(ax2, "ARKB: NAV vs Market Price", "USD/Share")

    # 3. Premium/Discount (bps)
    ax3 = fig.add_subplot(gs[1, 0])
    colors = ["#3fb950" if p > 0 else "#ff7b72" for p in prem]
    ax3.bar(minutes, prem, color=colors, width=1.0, alpha=0.8)
    ax3.axhline(cfg.ap_trigger_threshold_bps, color="#f8e81c", linewidth=1,
                linestyle="--", alpha=0.8, label=f"+{cfg.ap_trigger_threshold_bps}bps threshold")
    ax3.axhline(-cfg.ap_trigger_threshold_bps, color="#f8e81c", linewidth=1,
                linestyle="--", alpha=0.8, label=f"-{cfg.ap_trigger_threshold_bps}bps threshold")
    ax3.legend(fontsize=7, facecolor="#161b22", labelcolor="white", framealpha=0.8)
    style_ax(ax3, "ARKB Premium / Discount (bps)", "Basis Points")

    # 4. Shares Outstanding
    ax4 = fig.add_subplot(gs[1, 1])
    ax4.plot(minutes, shares, color="#79c0ff", linewidth=1.2)
    ax4.fill_between(minutes, shares, min(shares)*0.999, alpha=0.2, color="#79c0ff")
    style_ax(ax4, "Shares Outstanding", "Millions")

    # 5. Cumulative AP P&L
    ax5 = fig.add_subplot(gs[2, 0])
    ax5.plot(minutes, ap_pnl, color="#56d364", linewidth=1.4)
    ax5.fill_between(minutes, ap_pnl, 0, alpha=0.15, color="#56d364")
    style_ax(ax5, "Cumulative AP Arbitrage P&L", "USD")
    ax5.yaxis.set_major_formatter(plt.FuncFormatter(lambda x, _: f"${x:,.0f}"))

    # 6. Arb event timeline
    ax6 = fig.add_subplot(gs[2, 1])
    if arb_events:
        c_events = [(e.minute + (e.day-1)*cfg.minutes_per_day, e.net_pnl_usd)
                    for e in arb_events if e.event_type == "creation"]
        r_events = [(e.minute + (e.day-1)*cfg.minutes_per_day, e.net_pnl_usd)
                    for e in arb_events if e.event_type == "redemption"]
        if c_events:
            ax6.bar([x[0] for x in c_events], [x[1] for x in c_events],
                    color="#3fb950", alpha=0.8, label="Creation P&L", width=2)
        if r_events:
            ax6.bar([x[0] for x in r_events], [x[1] for x in r_events],
                    color="#d2a8ff", alpha=0.8, label="Redemption P&L", width=2)
        ax6.legend(fontsize=7, facecolor="#161b22", labelcolor="white", framealpha=0.8)
    style_ax(ax6, "Per-Event AP Net P&L", "USD")
    ax6.yaxis.set_major_formatter(plt.FuncFormatter(lambda x, _: f"${x:,.0f}"))

    plt.savefig(path, dpi=150, bbox_inches="tight", facecolor="#0d1117")
    plt.close()
    return path


def print_summary(sim: ARKBSimulation, chart_path: str, snap_path: str, arb_path: str):
    cfg = sim.cfg
    snaps = sim.snapshots
    events = sim.arb_events

    final = snaps[-1]
    first = snaps[0]

    premiums = [abs(s.premium_bps) for s in snaps]
    avg_abs_premium = sum(premiums) / len(premiums)
    max_premium = max(s.premium_bps for s in snaps)
    min_premium = min(s.premium_bps for s in snaps)

    creations = [e for e in events if e.event_type == "creation"]
    redemptions = [e for e in events if e.event_type == "redemption"]
    total_btc_created = sum(e.units * cfg.creation_unit_size * cfg.btc_per_share for e in creations)
    total_btc_redeemed = sum(e.units * cfg.creation_unit_size * cfg.btc_per_share for e in redemptions)

    btc_return = (final.btc_price - first.btc_price) / first.btc_price * 100

    if RICH:
        console.print()
        console.print(Panel.fit(
            f"[bold cyan]ARKB ETF Arbitrage Simulation Results[/bold cyan]\n"
            f"[dim]{cfg.trading_days} trading day(s) | {len(snaps):,} minutes simulated[/dim]",
            border_style="cyan"
        ))

        t = Table(show_header=True, header_style="bold magenta",
                  border_style="dim", min_width=55)
        t.add_column("Metric", style="cyan", min_width=32)
        t.add_column("Value", justify="right", min_width=20)

        t.add_section()
        t.add_row("[bold]── Bitcoin ──", "")
        t.add_row("  Start Price", f"${first.btc_price:>12,.2f}")
        t.add_row("  End Price", f"${final.btc_price:>12,.2f}")
        t.add_row("  Return", f"[{'green' if btc_return >= 0 else 'red'}]{btc_return:>+.2f}%[/]")

        t.add_section()
        t.add_row("[bold]── ARKB ETF ──", "")
        t.add_row("  Start NAV/Share", f"${first.nav_per_share:>10.4f}")
        t.add_row("  End NAV/Share", f"${final.nav_per_share:>10.4f}")
        t.add_row("  Start Shares Outstanding", f"{first.shares_outstanding:>15,}")
        t.add_row("  End Shares Outstanding", f"{final.shares_outstanding:>15,}")
        net_flow = (final.shares_outstanding - first.shares_outstanding) // cfg.creation_unit_size
        t.add_row("  Net Creation Units Flow", f"{net_flow:>+15,}")

        t.add_section()
        t.add_row("[bold]── Premium / Discount ──", "")
        t.add_row("  Avg |Premium| (bps)", f"{avg_abs_premium:>12.2f}")
        t.add_row("  Max Premium (bps)", f"[green]{max_premium:>+12.2f}[/]")
        t.add_row("  Min Premium (bps)", f"[red]{min_premium:>+12.2f}[/]")

        t.add_section()
        t.add_row("[bold]── Arbitrage Activity ──", "")
        t.add_row("  Total Arb Events", f"{sim.total_arb_events:>15,}")
        t.add_row("  Creations (units)", f"[green]{sum(e.units for e in creations):>15,}[/]")
        t.add_row("  Redemptions (units)", f"[red]{sum(e.units for e in redemptions):>15,}[/]")
        t.add_row("  BTC Delivered (creation)", f"{total_btc_created:>15,.4f} BTC")
        t.add_row("  BTC Returned (redemption)", f"{total_btc_redeemed:>15,.4f} BTC")

        t.add_section()
        t.add_row("[bold]── AP Economics ──", "")
        t.add_row("  AP Trigger Threshold", f"{cfg.ap_trigger_threshold_bps:>10.1f} bps")
        t.add_row("  AP Transaction Cost", f"{cfg.ap_transaction_cost_bps:>10.1f} bps")
        if events:
            avg_gross = sum(e.gross_pnl_usd for e in events) / len(events)
            avg_net = sum(e.net_pnl_usd for e in events) / len(events)
            t.add_row("  Avg Gross P&L / Event", f"${avg_gross:>12,.2f}")
            t.add_row("  Avg Net P&L / Event", f"${avg_net:>12,.2f}")
        t.add_row("  [bold]Cumulative AP P&L", f"[bold green]${final.ap_pnl_usd:>12,.2f}[/]")

        console.print(t)
        console.print()
        if chart_path:
            console.print(f"[dim]📊 Chart saved:[/dim] [link={chart_path}]{chart_path}[/link]")
        console.print(f"[dim]📄 Snapshots:[/dim] {snap_path}")
        console.print(f"[dim]📄 Arb events:[/dim] {arb_path}")
        console.print()
    else:
        # Plain text fallback
        sep = "-" * 55
        print(f"\n{'ARKB ETF ARBITRAGE SIMULATION RESULTS':^55}")
        print(sep)
        print(f"  Days: {cfg.trading_days}  |  Minutes: {len(snaps):,}")
        print(sep)
        print(f"  BTC: ${first.btc_price:,.2f} → ${final.btc_price:,.2f}  ({btc_return:+.2f}%)")
        print(f"  NAV/Share: ${first.nav_per_share:.4f} → ${final.nav_per_share:.4f}")
        print(f"  Avg |Premium|: {avg_abs_premium:.2f} bps")
        print(f"  Max/Min Premium: {max_premium:+.2f} / {min_premium:+.2f} bps")
        print(sep)
        print(f"  Arb Events: {sim.total_arb_events}")
        print(f"  Creations: {sum(e.units for e in creations)} units")
        print(f"  Redemptions: {sum(e.units for e in redemptions)} units")
        print(f"  Cumulative AP P&L: ${final.ap_pnl_usd:,.2f}")
        print(sep)
        if chart_path:
            print(f"  Chart: {chart_path}")
        print(f"  CSV: {snap_path}")
        print(f"  Arb CSV: {arb_path}")
        print()


# ─── Main ─────────────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(
        description="ARKB ETF Creation/Redemption Arbitrage Simulation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python3 sim.py                        # 1-day sim with defaults
  python3 sim.py --days 5               # 5-day simulation
  python3 sim.py --btc-price 100000     # Start BTC at $100k
  python3 sim.py --vol 0.04             # Higher daily BTC vol (4%)
  python3 sim.py --ap-threshold 15      # AP triggers at 15bps
  python3 sim.py --no-chart             # Skip matplotlib chart
        """
    )
    p.add_argument("--config", default="config.json", help="Config JSON path")
    p.add_argument("--days", type=int, help="Trading days to simulate")
    p.add_argument("--btc-price", type=float, help="Starting BTC spot price (USD)")
    p.add_argument("--vol", type=float, help="BTC daily volatility (e.g. 0.025 = 2.5%%)")
    p.add_argument("--ap-threshold", type=float, help="AP trigger threshold in bps")
    p.add_argument("--ap-cost", type=float, help="AP transaction cost in bps")
    p.add_argument("--seed", type=int, help="Random seed")
    p.add_argument("--no-chart", action="store_true", help="Skip chart generation")
    p.add_argument("--out", default=None, help="Output directory override")
    return p.parse_args()


def main():
    # Best-effort UTF-8 console on Windows
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    args = parse_args()

    # Resolve paths relative to sim.py location
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)

    # Load config
    cfg_path = args.config
    if os.path.exists(cfg_path):
        cfg = SimConfig.from_json(cfg_path)
    else:
        cfg = SimConfig()
        if RICH:
            console.print(f"[yellow]⚠ Config not found at {cfg_path}, using defaults[/yellow]")

    # CLI overrides
    if args.days:
        cfg.trading_days = args.days
    if args.btc_price:
        cfg.btc_spot_price_usd = args.btc_price
    if args.vol:
        cfg.btc_daily_vol = args.vol
    if args.ap_threshold:
        cfg.ap_trigger_threshold_bps = args.ap_threshold
    if args.ap_cost:
        cfg.ap_transaction_cost_bps = args.ap_cost
    if args.seed is not None:
        cfg.random_seed = args.seed
    if args.out:
        cfg.output_dir = args.out

    cfg.validate()

    if RICH:
        console.print(Panel.fit(
            f"[bold]ARKB ETF Arbitrage Simulator[/bold]\n"
            f"BTC @ [yellow]${cfg.btc_spot_price_usd:,.0f}[/yellow]  |  "
            f"Vol: [cyan]{cfg.btc_daily_vol*100:.1f}%/day[/cyan]  |  "
            f"AP threshold: [magenta]{cfg.ap_trigger_threshold_bps}bps[/magenta]  |  "
            f"Days: [green]{cfg.trading_days}[/green]",
            border_style="bright_blue"
        ))
    else:
        print(f"\nARKB Arbitrage Simulator | BTC=${cfg.btc_spot_price_usd:,.0f} | "
              f"Vol={cfg.btc_daily_vol*100:.1f}%/d | AP={cfg.ap_trigger_threshold_bps}bps | "
              f"{cfg.trading_days}d\n")

    sim = ARKBSimulation(cfg)
    sim.run()

    snap_path, arb_path = save_csv(sim.snapshots, sim.arb_events, cfg.output_dir)

    chart_path = ""
    if not args.no_chart:
        chart_path = save_chart(sim.snapshots, sim.arb_events, cfg, cfg.output_dir)
        if chart_path and RICH:
            console.print(f"[green]✓[/green] Chart rendered")
        elif not chart_path and not args.no_chart:
            if RICH:
                console.print("[yellow]⚠ matplotlib not available — skipping chart (pip install matplotlib)[/yellow]")

    print_summary(sim, chart_path, snap_path, arb_path)


if __name__ == "__main__":
    main()
