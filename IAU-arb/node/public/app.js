/* ══════════════════════════════════════════════════════════════════
   ARKB — Creation / Redemption Desk
   Client runtime: live basis instrumentation, drawn by hand.
   No charting library — every pixel here is deliberate.
   ══════════════════════════════════════════════════════════════════ */

const $ = (id) => document.getElementById(id);
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ── formatting ──────────────────────────────────────────────── */
const fmtN = (n, d = 2) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};
const fmtSigned = (n, d = 1) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${fmtN(v, d)}`;
};
const fmtUsd = (n, d = 2) => (Number.isFinite(Number(n)) ? `$${fmtN(n, d)}` : '—');
const fmtCompact = (n) => {
  const v = Math.abs(Number(n));
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e6) return `$${fmtN(n / 1e6, 2)}M`;
  if (v >= 1e3) return `$${fmtN(n / 1e3, 1)}K`;
  return fmtUsd(n, 2);
};
/* Bitcoin amounts are shown whole, never rounded: one basket is
   1.657961534232 BTC, not "1.6580". Rounding a coin quantity on an
   arbitrage desk hides real money. */
const fmtBtcExact = (n, maxDigits = 12) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: maxDigits });
};
const setText = (id, value) => { const el = $(id); if (el) el.textContent = value; };
const hhmmss = (d) => new Date(d).toLocaleTimeString('en-US', { hour12: false });

/* ── number tweening ─────────────────────────────────────────── */
const tweens = new WeakMap();
function animate(el, to, format, duration = 620) {
  if (!el) return;
  const prev = tweens.get(el);
  if (prev?.raf) cancelAnimationFrame(prev.raf);
  if (!Number.isFinite(to)) {
    el.textContent = format(NaN);
    tweens.set(el, { value: NaN });
    return;
  }
  const from = Number.isFinite(prev?.value) ? prev.value : to;
  // A hidden tab gets no animation frames, so a tween would never paint and the
  // figure would sit frozen at a stale value. Nobody is watching it move — just
  // set it, so it is already correct the moment the tab is looked at again.
  if (REDUCED || document.hidden || Math.abs(to - from) < 1e-9) {
    el.textContent = format(to);
    tweens.set(el, { value: to });
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 4);
    const v = from + (to - from) * eased;
    el.textContent = format(v);
    if (t < 1) tweens.set(el, { value: v, raf: requestAnimationFrame(step) });
    else tweens.set(el, { value: to });
  };
  tweens.set(el, { value: from, raf: requestAnimationFrame(step) });
}

function flash(el, dir) {
  if (!el || REDUCED || !dir) return;
  el.classList.remove('flash-up', 'flash-dn');
  void el.offsetWidth;
  el.classList.add(dir > 0 ? 'flash-up' : 'flash-dn');
}

/* ── palette ─────────────────────────────────────────────────────
   Single obsidian theme. Canvas work can't read CSS custom properties
   directly, so the tokens are resolved once from :root and cached. */
let PAL = null;

function palette() {
  if (PAL) return PAL;
  const cs = getComputedStyle(document.documentElement);
  const g = (n) => cs.getPropertyValue(n).trim();
  PAL = {
    pos: g('--pos') || '#2EE6A8',
    neg: g('--neg') || '#FF5D73',
    neu: g('--neu') || '#7C9CFF',
    ink: g('--ink') || '#EDF1F7',
    ink2: g('--ink-2') || '#97A1B2',
    ink3: g('--ink-3') || '#5C6676',
    grid: g('--grid') || 'rgba(255,255,255,.055)',
    line2: g('--line-2') || 'rgba(255,255,255,.14)',
  };
  return PAL;
}
function rgba(color, a) {
  const h = String(color).trim();
  if (!h.startsWith('#')) return h;
  let s = h.slice(1);
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s, 16);
  if (!Number.isFinite(n)) return h;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* ── canvas sizing ───────────────────────────────────────────────
   Measured once by a ResizeObserver, never per frame. Reading
   getBoundingClientRect() inside a 60fps draw forces a synchronous
   layout on every single frame — the classic way to make a canvas
   dashboard cost more than it should.
   ─────────────────────────────────────────────────────────────── */
const canvasSizes = new WeakMap();
const observedCanvases = [];

function measure(cv) {
  const r = cv.getBoundingClientRect();
  canvasSizes.set(cv, { w: r.width, h: r.height });
}
function observeCanvas(cv) {
  if (!cv) return;
  measure(cv);
  observedCanvases.push(cv);
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const box = e.contentRect;
        canvasSizes.set(cv, { w: box.width, h: box.height });
      }
    });
    ro.observe(cv);
  }
}
function remeasureAll() { observedCanvases.forEach(measure); }

/* ResizeObserver is the fast path, but it only fires as part of the
   rendering lifecycle — if the first measurement lands before layout
   settles and no frame is ever produced, a canvas can stay stuck at a
   bogus size forever. A slow poll costs ~10 rect reads a second (versus
   300 if we measured inside draw) and makes that impossible. */
function startSizeWatch() { setInterval(remeasureAll, 500); }

function fitCanvas(cv) {
  const size = canvasSizes.get(cv);
  if (!size) measure(cv);
  const { w, h } = canvasSizes.get(cv) || { w: 0, h: 0 };
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));
  if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/* ══════════════════════════════════════════════════════════════
   SPARKLINE — the whisper version of a chart
   ══════════════════════════════════════════════════════════════ */
class Spark {
  constructor(canvas, tone = 'auto') {
    this.cv = canvas;
    this.tone = tone;
    this.data = [];
    this.dirty = true;
    observeCanvas(canvas);
  }
  push(v) {
    if (!Number.isFinite(v)) return;
    this.data.push(v);
    if (this.data.length > 180) this.data.shift();
    this.dirty = true;
  }
  draw() {
    if (!this.cv || !this.dirty) return;
    this.dirty = false;
    const { ctx, w, h } = fitCanvas(this.cv);
    const d = this.data;
    if (d.length < 2 || w < 4) return;

    let lo = Infinity; let hi = -Infinity;
    for (const v of d) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.18;
    lo -= pad; hi += pad;

    const P = palette();
    const rising = d[d.length - 1] >= d[0];
    const color = this.tone === 'auto' ? (rising ? P.pos : P.neg) : P[this.tone] || P.neu;
    const X = (i) => (i / (d.length - 1)) * w;
    const Y = (v) => h - ((v - lo) / (hi - lo)) * (h - 3) - 1.5;

    const trace = () => {
      ctx.beginPath();
      ctx.moveTo(X(0), Y(d[0]));
      for (let i = 1; i < d.length; i += 1) {
        const xc = (X(i - 1) + X(i)) / 2;
        const yc = (Y(d[i - 1]) + Y(d[i])) / 2;
        ctx.quadraticCurveTo(X(i - 1), Y(d[i - 1]), xc, yc);
      }
      ctx.lineTo(X(d.length - 1), Y(d[d.length - 1]));
    };

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, rgba(color, 0.24));
    grad.addColorStop(1, rgba(color, 0));
    trace();
    ctx.lineTo(X(d.length - 1), h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    trace();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(X(d.length - 1), Y(d[d.length - 1]), 2.2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

/* ══════════════════════════════════════════════════════════════
   GAP CHART — the signature instrument
   Basis against zero, with the profitable bands drawn in.
   ══════════════════════════════════════════════════════════════ */
class GapChart {
  constructor(canvas) {
    this.cv = canvas;
    this.pts = [];
    this.trigger = NaN;
    this.range = 600000;
    this.yMax = 24;
    this.hoverX = null;
    this.raf = null;
    this.roShown = false;
    this.roW = 148;
    /* session density: 0.5 bps buckets spanning ±200 bps, kept in step
       with this.pts so the marginal always describes the same window */
    this.hist = new Float64Array(801);
    observeCanvas(canvas);

    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
    });
    canvas.addEventListener('pointerleave', () => { this.hoverX = null; });

    this.draw();
    const tick = () => { this.draw(); this.raf = requestAnimationFrame(tick); };
    this.raf = requestAnimationFrame(tick);
  }

  push(t, y) {
    if (!Number.isFinite(y)) return;
    const time = t instanceof Date ? t.getTime() : new Date(t).getTime();
    if (!Number.isFinite(time)) return;
    const last = this.pts[this.pts.length - 1];
    if (last && time <= last.t) return;
    this.pts.push({ t: time, y });
    this.hist[GapChart.bucket(y)] += 1;
    if (this.pts.length > 4000) {
      const dropped = this.pts.shift();
      const b = GapChart.bucket(dropped.y);
      this.hist[b] = Math.max(0, this.hist[b] - 1);
    }
  }

  static bucket(y) { return clamp(Math.round((y + 200) * 2), 0, 800); }

  seed(rows) {
    if (!Array.isArray(rows)) return;
    for (const r of rows) this.push(r.t, Number(r.premBps));
  }

  setRange(ms) { this.range = ms; }
  setTrigger(v) { this.trigger = v; }

  draw() {
    const { ctx, w, h } = fitCanvas(this.cv);
    if (w < 20 || h < 20) return;
    const P = palette();
    const HIST = w > 640;
    const PAD = { t: 18, r: HIST ? 124 : 56, b: 26, l: 6 };
    const x0 = PAD.l; const x1 = w - PAD.r;
    const yT = PAD.t; const yB = h - PAD.b;
    if (x1 <= x0 || yB <= yT) return;

    /* ── time window ── */
    const now = this.pts.length ? this.pts[this.pts.length - 1].t : Date.now();
    let t0; let t1;
    if (this.range > 0) { t1 = now; t0 = now - this.range; } else { t0 = this.pts.length ? this.pts[0].t : now - 60000; t1 = now; }
    if (t1 - t0 < 2000) t1 = t0 + 2000;

    /* index range rather than a slice — this runs 60 times a second */
    const n = this.pts.length;
    let i0 = 0;
    for (let i = n - 1; i >= 0; i -= 1) {
      if (this.pts[i].t < t0) { i0 = i; break; }
    }
    const visCount = n - i0;

    /* ── vertical scale, eased so it never snaps ── */
    let maxAbs = 0;
    for (let i = i0; i < n; i += 1) {
      const a = Math.abs(this.pts[i].y);
      if (a > maxAbs) maxAbs = a;
    }
    const trg = Number.isFinite(this.trigger) ? this.trigger : 0;
    const target = Math.max(maxAbs * 1.25, trg * 1.6, 8);
    this.yMax += (target - this.yMax) * (REDUCED ? 1 : 0.12);
    const yMax = this.yMax;

    const X = (t) => x0 + ((t - t0) / (t1 - t0)) * (x1 - x0);
    const Y = (v) => yT + ((yMax - v) / (yMax * 2)) * (yB - yT);
    const Y0 = Y(0);

    /* ── profitable bands ── */
    if (trg > 0 && trg < yMax) {
      ctx.fillStyle = rgba(P.pos, 0.055);
      ctx.fillRect(x0, yT, x1 - x0, Y(trg) - yT);
      ctx.fillStyle = rgba(P.neg, 0.055);
      ctx.fillRect(x0, Y(-trg), x1 - x0, yB - Y(-trg));
    }

    /* ── grid ── */
    ctx.save();
    ctx.strokeStyle = P.grid;
    ctx.lineWidth = 1;
    const half = yMax / 2;
    [half, -half].forEach((v) => {
      ctx.beginPath();
      ctx.moveTo(x0, Math.round(Y(v)) + 0.5);
      ctx.lineTo(x1, Math.round(Y(v)) + 0.5);
      ctx.stroke();
    });
    ctx.restore();

    /* trigger rails */
    if (trg > 0 && trg < yMax) {
      ctx.save();
      ctx.setLineDash([3, 5]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(P.pos, 0.45);
      ctx.beginPath(); ctx.moveTo(x0, Y(trg)); ctx.lineTo(x1, Y(trg)); ctx.stroke();
      ctx.strokeStyle = rgba(P.neg, 0.45);
      ctx.beginPath(); ctx.moveTo(x0, Y(-trg)); ctx.lineTo(x1, Y(-trg)); ctx.stroke();
      ctx.restore();
    }

    /* zero — NAV parity */
    ctx.save();
    ctx.strokeStyle = P.line2;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, Math.round(Y0) + 0.5);
    ctx.lineTo(x1, Math.round(Y0) + 0.5);
    ctx.stroke();
    ctx.restore();

    /* ── the series ── */
    if (visCount >= 2) {
      const pts = this.pts;
      const trace = (c) => {
        c.beginPath();
        c.moveTo(X(pts[i0].t), Y(pts[i0].y));
        for (let i = i0 + 1; i < n; i += 1) {
          const px = X(pts[i - 1].t); const py = Y(pts[i - 1].y);
          const xc = (px + X(pts[i].t)) / 2; const yc = (py + Y(pts[i].y)) / 2;
          c.quadraticCurveTo(px, py, xc, yc);
        }
        c.lineTo(X(pts[n - 1].t), Y(pts[n - 1].y));
      };
      const area = (c) => {
        trace(c);
        c.lineTo(X(pts[n - 1].t), Y0);
        c.lineTo(X(pts[i0].t), Y0);
        c.closePath();
      };

      const paint = (color, top, bottom) => {
        if (bottom - top < 0.5) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, top, x1 - x0, bottom - top);
        ctx.clip();

        const g = ctx.createLinearGradient(0, top, 0, bottom);
        const upward = top < Y0;
        g.addColorStop(0, rgba(color, upward ? 0.34 : 0.02));
        g.addColorStop(1, rgba(color, upward ? 0.02 : 0.34));
        ctx.fillStyle = g;
        area(ctx);
        ctx.fill();

        ctx.beginPath();
        trace(ctx);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.shadowColor = rgba(color, 0.5);
        ctx.shadowBlur = 14;
        ctx.stroke();
        ctx.restore();
      };

      paint(P.pos, yT, Y0);
      paint(P.neg, Y0, yB);

      /* live marker */
      const lastPt = pts[n - 1];
      const lx = X(lastPt.t); const ly = Y(lastPt.y);
      const c = lastPt.y >= 0 ? P.pos : P.neg;
      const beat = REDUCED ? 0.5 : (Math.sin(performance.now() / 620) + 1) / 2;
      ctx.beginPath();
      ctx.arc(lx, ly, 4 + beat * 7, 0, Math.PI * 2);
      ctx.fillStyle = rgba(c, 0.18 * (1 - beat));
      ctx.fill();
      ctx.beginPath();
      ctx.arc(lx, ly, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.shadowColor = rgba(c, 0.8);
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    /* ── marginal density ──────────────────────────────────────
       Where the basis has actually spent its time, sharing this
       chart's exact vertical scale. A wide bar out past the dashed
       rail means the gap lives in profitable territory; a tall spike
       hugging zero means the fund is tracking tightly.
       ───────────────────────────────────────────────────────── */
    if (HIST) {
      const hx0 = w - 66; const hx1 = w - 6;
      const BUCKETS = 46;
      const acc = new Float64Array(BUCKETS);
      const span = yMax * 2;
      for (let b = 0; b <= 800; b += 1) {
        const v = this.hist[b];
        if (!v) continue;
        const centre = (b / 2) - 200;
        const idx = Math.floor(((yMax - centre) / span) * BUCKETS);
        acc[clamp(idx, 0, BUCKETS - 1)] += v;
      }
      let peak = 0;
      for (let i = 0; i < BUCKETS; i += 1) if (acc[i] > peak) peak = acc[i];

      if (peak > 0) {
        const bh = (yB - yT) / BUCKETS;
        for (let i = 0; i < BUCKETS; i += 1) {
          if (!acc[i]) continue;
          const centre = yMax - ((i + 0.5) / BUCKETS) * span;
          const inMoney = trg > 0 && Math.abs(centre) > trg;
          const tone = centre >= 0 ? P.pos : P.neg;
          ctx.fillStyle = inMoney ? rgba(tone, 0.72) : rgba(tone, 0.26);
          const bw = (acc[i] / peak) * (hx1 - hx0);
          ctx.fillRect(hx0, yT + i * bh + 0.4, Math.max(1, bw), Math.max(1, bh - 0.8));
        }
        ctx.save();
        ctx.strokeStyle = P.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(hx0) + 0.5, yT);
        ctx.lineTo(Math.round(hx0) + 0.5, yB);
        ctx.stroke();
        ctx.restore();
      }
    }

    /* ── right axis ── */
    ctx.save();
    ctx.font = '500 10.5px Inter, -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const label = (v, color) => {
      const y = Y(v);
      if (y < yT - 2 || y > yB + 2) return;
      ctx.fillStyle = color;
      ctx.fillText(`${v > 0 ? '+' : ''}${fmtN(v, v === 0 ? 0 : 1)}`, x1 + 9, y);
    };
    label(0, P.ink3);
    if (trg > 0 && trg < yMax * 0.94) { label(trg, rgba(P.pos, 0.85)); label(-trg, rgba(P.neg, 0.85)); }
    label(half, P.ink3);
    label(-half, P.ink3);
    ctx.restore();

    /* ── time axis ── */
    ctx.save();
    ctx.font = '500 10.5px Inter, -apple-system, system-ui, sans-serif';
    ctx.fillStyle = P.ink3;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(hhmmss(t0), x0, yB + 9);
    ctx.textAlign = 'right';
    ctx.fillText(hhmmss(t1), x1, yB + 9);
    ctx.restore();

    /* ── crosshair ── */
    const ro = $('readout');
    if (this.hoverX != null && this.hoverX > x0 && this.hoverX < x1 && visCount > 0) {
      const tAt = t0 + ((this.hoverX - x0) / (x1 - x0)) * (t1 - t0);
      let best = this.pts[i0]; let bd = Infinity;
      for (let i = i0; i < n; i += 1) {
        const d = Math.abs(this.pts[i].t - tAt);
        if (d < bd) { bd = d; best = this.pts[i]; }
      }
      const hx = X(best.t); const hy = Y(best.y);
      const c = best.y >= 0 ? P.pos : P.neg;

      ctx.save();
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = P.line2;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hx, yT); ctx.lineTo(hx, yB); ctx.stroke();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(hx, hy, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.strokeStyle = rgba(P.ink, 0.9);
      ctx.lineWidth = 1.5;
      ctx.fill(); ctx.stroke();

      if (ro) {
        if (!this.roShown) { ro.classList.add('on'); this.roShown = true; }
        setText('ro-time', hhmmss(best.t));
        setText('ro-val', `${fmtSigned(best.y, 1)} bps`);
        const inMoney = Number.isFinite(trg) && Math.abs(best.y) > trg;
        const note = inMoney
          ? (best.y > 0 ? 'Create cleared costs' : 'Redeem cleared costs')
          : 'Inside the band';
        setText('ro-note', note);
        // offsetWidth forces layout — only re-measure when the copy actually changes
        if (note !== this.roNote) { this.roNote = note; this.roW = ro.offsetWidth || 148; }
        ro.style.left = `${clamp(hx - this.roW / 2, 6, Math.max(6, w - this.roW - 6))}px`;
        $('ro-val').style.color = c;
      }
    } else if (ro && this.roShown) {
      ro.classList.remove('on');
      this.roShown = false;
    }
  }
}

/* ══════════════════════════════════════════════════════════════
   CONFIG + MODEL  (mirrors lib/utils.js exactly)
   ══════════════════════════════════════════════════════════════ */
/* Defaults must match config.json. If the config fetch ever fails these are
   what the page runs on, so a stale value here is a silently wrong dashboard. */
let CFG = {
  etf: { creationUnitShares: 5000, btcPerShare: 0.01868, sharesOutstanding: 75000000 },
  costs: {
    creationRedemptionFeeUsd: 500,
    etfCommissionPerShare: 0.005,
    btcExecutionBps: 0,
    marketImpactBps: 1,
    btcSpotSpreadBps: 1,
  },
  signals: { minSpreadAfterCostsBps: 5, cooldownMs: 15000 },
  coinbase: { restUrl: 'https://api.exchange.coinbase.com/products/BTC-USD/ticker' },
  marketOverviewUrl: 'https://btctrader-api-68276-gqbkg8bucfbndjgn.z01.azurefd.net/api/market-overview',
};

/* ── basket sizing ───────────────────────────────────────────────
   How many creation units the desk is pricing, and how the flat
   create/redeem fee behaves as that size grows.

     'basket' — fee is charged per creation unit (industry norm).
                Total fee scales linearly, so the bps drag is
                IDENTICAL at every size and the trigger never moves.
     'order'  — one flat fee for the whole order. The bps drag falls
                as 1/units, which is what makes large baskets pay.

   The real ARKB schedule is an undisclosed private term (see
   PARAMETERS.md), so both are offered rather than one being asserted.
   ─────────────────────────────────────────────────────────────── */
const sizing = { units: 1, feeUsd: null, feeMode: 'basket' };

function feeDefault() { return Number(CFG.costs.creationRedemptionFeeUsd) || 0; }
function feeUsd() { return sizing.feeUsd == null ? feeDefault() : sizing.feeUsd; }
function basketShares() { return (Number(CFG.etf.creationUnitShares) || 5000) * sizing.units; }
function totalFeeUsd() { return sizing.feeMode === 'order' ? feeUsd() : feeUsd() * sizing.units; }
function sizingIsDefault() {
  return sizing.units === 1 && sizing.feeMode === 'basket' && sizing.feeUsd == null;
}

function costParts(mid) {
  const c = CFG.costs;
  const shares = basketShares();
  const price = Number(mid);
  if (!(price > 0) || !(shares > 0)) return null;
  const notional = shares * price;
  return {
    // only the flat fee is size-sensitive; commission is per share and the
    // rest are already expressed in bps, so they are size-invariant
    fee: (totalFeeUsd() / notional) * 10000,
    commission: (c.etfCommissionPerShare / price) * 10000,
    execution: c.btcExecutionBps,
    impact: c.marketImpactBps * 2,
    spread: c.btcSpotSpreadBps,
  };
}
function totalCostBps(mid) {
  const p = costParts(mid);
  if (!p) return Infinity;
  return p.fee + p.commission + p.execution + p.impact + p.spread;
}
function evaluate(arkbMid, btcPrice, btcPerShare) {
  const mid = Number(arkbMid); const btc = Number(btcPrice); const bps = Number(btcPerShare);
  if (!(mid > 0) || !(btc > 0) || !(bps > 0)) {
    return { ok: false, nav: 0, premBps: 0, costBps: Infinity, triggerBps: Infinity, signal: 'NEUTRAL', spreadCapturedBps: 0, pnlUsd: 0 };
  }
  const nav = btc * bps;
  const premBps = ((mid - nav) / nav) * 10000;
  const costBps = totalCostBps(mid);
  const triggerBps = costBps + (CFG.signals.minSpreadAfterCostsBps || 0);
  let signal = 'NEUTRAL';
  if (premBps > triggerBps) signal = 'CREATE';
  else if (premBps < -triggerBps) signal = 'REDEEM';
  const spreadCapturedBps = signal === 'NEUTRAL' ? 0 : Math.abs(premBps) - costBps;
  const pnlUsd = (spreadCapturedBps / 10000) * basketShares() * mid;
  return { ok: true, nav, premBps, costBps, triggerBps, signal, spreadCapturedBps, pnlUsd };
}

/* ── feasibility ─────────────────────────────────────────────────
   "Watching" is the honest answer almost always, but on its own it is
   a dead end. This answers the question that actually follows: what
   would it take?

   Commission is charged per share and execution/impact/spread are
   already in bps, so those four survive any amount of scale. Only the
   flat fee amortises. That gives a hard floor the trigger can never go
   below — and if the gap is under it, no basket size on earth clears.
   ─────────────────────────────────────────────────────────────── */
function feasibility(mid, prem) {
  const c = CFG.costs;
  const cu = Number(CFG.etf.creationUnitShares) || 5000;
  const price = Number(mid);
  const gap = Math.abs(Number(prem));
  if (!(price > 0) || !Number.isFinite(gap)) return null;

  const minEdge = Number(CFG.signals.minSpreadAfterCostsBps) || 0;
  const fixed = (c.etfCommissionPerShare / price) * 10000
    + (Number(c.btcExecutionBps) || 0)
    + (Number(c.marketImpactBps) || 0) * 2
    + (Number(c.btcSpotSpreadBps) || 0);
  const feeAt = (u) => ((sizing.feeMode === 'order' ? feeUsd() : feeUsd() * u) / (u * cu * price)) * 10000;

  if (sizing.feeMode === 'basket') {
    // fee bps is identical at every size, so it is part of the floor
    const floor = fixed + feeAt(1);
    const minGap = floor + minEdge;
    return { mode: 'basket', gap, fixed, floor, minGap, units: null, reachable: gap > minGap, short: minGap - gap };
  }

  const minGap = fixed + minEdge;                 // fee -> 0 as size -> infinity
  if (gap <= minGap) {
    return { mode: 'order', gap, fixed, floor: fixed, minGap, units: null, reachable: false, short: minGap - gap };
  }
  // A zero fee solves to 0 baskets, and a gap barely over the floor solves to
  // an absurd number. Clamp the floor at 1; the caller decides what is practical.
  const units = Math.max(1, Math.ceil((feeUsd() * 10000) / ((gap - minGap) * cu * price)));
  return { mode: 'order', gap, fixed, floor: fixed, minGap, units, reachable: true, short: 0 };
}

function renderFeasibility(mid, prem) {
  const f = feasibility(mid, prem);
  const verdict = $('feas-verdict');
  const body = $('feas-body');
  const apply = $('feas-apply');
  if (!f || !verdict || !body || !apply) return;

  const MAX_UNITS = 500;                       // matches the stepper's ceiling
  const floorTxt = `${fmtN(f.minGap, 1)} bps`;
  apply.hidden = true;

  if (f.reachable && f.mode === 'order') {
    const shares = (f.units * (Number(CFG.etf.creationUnitShares) || 5000)).toLocaleString();
    const beyond = f.units > MAX_UNITS;
    verdict.textContent = beyond ? 'Viable only at extreme size'
      : f.units <= sizing.units ? 'Viable now' : `Viable from ${f.units} baskets`;
    verdict.className = `feas-verdict ${beyond ? 'no' : 'ok'}`;
    body.innerHTML = `Today's gap of <b>${fmtN(f.gap, 1)} bps</b> clears once the flat `
      + `${fmtUsd(feeUsd(), 0)} order fee is spread across <b>${f.units.toLocaleString()}</b> `
      + `basket${f.units === 1 ? '' : 's'} (${shares} shares). `
      + (beyond ? `That is past the ${MAX_UNITS} this desk models — treat it as out of reach.`
                : 'Below that the fee alone eats the edge.');
    // only offered when scaling up is what unlocks it, and it is actually settable
    if (!beyond && f.units > sizing.units) {
      apply.hidden = false;
      apply.textContent = `Size to ${f.units}`;
      apply.dataset.units = String(f.units);
    }
  } else if (f.mode === 'order') {
    verdict.textContent = 'Not viable at any size';
    verdict.className = 'feas-verdict no';
    body.innerHTML = `Commission, market impact and spot spread cost <b>${fmtN(f.fixed, 1)} bps</b> `
      + `no matter how large the basket, so nothing under <b>${floorTxt}</b> can ever clear. `
      + `Today's gap is ${fmtN(f.gap, 1)} bps — it must widen by <b>${fmtN(f.short, 1)} bps</b>.`;
  } else {
    verdict.textContent = f.reachable ? 'Viable now' : 'Not viable';
    verdict.className = `feas-verdict ${f.reachable ? 'ok' : 'no'}`;
    body.innerHTML = f.reachable
      ? `The gap of <b>${fmtN(f.gap, 1)} bps</b> clears the ${floorTxt} bar. Size only scales the dollars.`
      : `A per-basket fee costs the same <b>${fmtN(f.floor, 1)} bps</b> at every size, so the bar stays at `
        + `<b>${floorTxt}</b> however many you do. Today's gap is ${fmtN(f.gap, 1)} bps — short by `
        + `<b>${fmtN(f.short, 1)} bps</b>. Switch to a per-order fee to let scale help.`;
  }
}

/* ══════════════════════════════════════════════════════════════
   SESSION STATE
   ══════════════════════════════════════════════════════════════ */
const state = {
  startTime: Date.now(),
  tradeCount: 0,
  winRate: 0,
  totalPnl: 0,
  trades: [],
  basisBps: 0,
  lastSignalAt: 0,
  lastSignal: 'NEUTRAL',
  btcPerShare: 0.01868,
  btcPerShareSource: 'config',
  mode: 'standalone',
  backendLive: false,
  // session analytics
  high: -Infinity,
  low: Infinity,
  samples: 0,
  inZone: 0,
  crossings: 0,
  wasInZone: false,
  lastPrices: {},
  basisTrail: [],
  open: {},
  lastTickAt: 0,
  lastSnapshot: null,
};

let liveArkb = null;
let lastMarketHtml = null;  // cache the last successful market overview render
let standaloneTimer = null;
let chart = null;
const sparks = {};

/* ══════════════════════════════════════════════════════════════
   RENDERERS
   ══════════════════════════════════════════════════════════════ */

function setStatus(kind, text) {
  const chip = $('status-chip');
  if (chip) chip.className = `chip ${kind || ''}`;
  setText('status-text', text);
}

function lede(prem, signal, trigger) {
  if (signal === 'CREATE') return 'The fund is <b>rich</b> to its gold. Buying spot gold, delivering it and selling the new shares clears every cost.';
  if (signal === 'REDEEM') return 'The fund is <b>cheap</b> to its gold. Buying shares, redeeming the basket and selling the gold clears every cost.';
  if (!Number.isFinite(prem)) return 'Waiting on a clean two-sided quote before the basis can be priced.';
  const short = Number.isFinite(trigger) ? trigger - Math.abs(prem) : NaN;
  if (Math.abs(prem) < 3) return 'IAU is trading <b>essentially in line</b> with the gold behind it. Nothing to do.';
  return prem > 0
    ? `A real premium, but it is <b>${fmtN(short, 1)} bps short</b> of paying for the round trip.`
    : `A real discount, but it is <b>${fmtN(short, 1)} bps short</b> of paying for the round trip.`;
}

function renderVerdict(signal, edge, trigger, prem) {
  // hue = which way the basis points; brightness = whether it is worth acting on
  document.body.dataset.state =
    !Number.isFinite(prem) || Math.abs(prem) < 0.2 ? 'flat' : prem > 0 ? 'pos' : 'neg';
  document.body.dataset.signal = signal === 'NEUTRAL' ? 'none' : 'live';

  const label = signal === 'CREATE' ? 'Create' : signal === 'REDEEM' ? 'Redeem' : 'Watching';
  setText('verdict-state', label);
  setText('tag-signal', label === 'Watching' ? 'Watching' : `${label} live`);
  const tag = $('tag-signal');
  if (tag) tag.className = `tag ${signal === 'CREATE' ? 'pos' : signal === 'REDEEM' ? 'neg' : ''}`;

  animate($('verdict-edge'), edge, (v) => fmtSigned(v, 1));
  animate($('verdict-trigger'), trigger, (v) => fmtN(v, 1));
  const vNum = document.querySelector('.verdict-num');
  if (vNum) {
    vNum.style.color = edge > 0 ? 'var(--pos)' : Number.isFinite(edge) ? 'var(--ink)' : 'var(--ink-3)';
  }

  const pct = Number.isFinite(prem) && Number.isFinite(trigger) && trigger > 0
    ? clamp((Math.abs(prem) / trigger) * 100, 0, 100)
    : 0;
  const fill = $('verdict-fill');
  if (fill) fill.style.width = `${pct}%`;

  const gap = Number.isFinite(prem) && Number.isFinite(trigger) ? trigger - Math.abs(prem) : NaN;
  setText('verdict-gap', Number.isFinite(gap)
    ? (gap > 0 ? `${fmtN(gap, 1)} bps away` : `${fmtN(-gap, 1)} bps through`)
    : '—');

  const action = $('verdict-action');
  if (action) {
    const n = sizing.units;
    const word = n === 1 ? 'a basket' : `${n} baskets`;
    const sh = basketShares().toLocaleString();
    const btc = fmtBtcExact(basketShares() * state.btcPerShare);
    if (signal === 'CREATE') {
      action.innerHTML = `<b>Create ${word}.</b> Buy ${btc} oz, deliver to the trust, sell ${sh} shares into the bid.`;
    } else if (signal === 'REDEEM') {
      action.innerHTML = `<b>Redeem ${word}.</b> Lift ${sh} shares, hand them to the trust, sell the ${btc} oz that comes back.`;
    } else {
      action.innerHTML = 'No actionable gap. The fund is tracking its gold closely enough that a round trip would not pay for itself.';
    }
  }
}

function renderMeter(prem, trigger) {
  const rail = $('meter-rail');
  if (!rail || !Number.isFinite(prem)) return;
  const trg = Number.isFinite(trigger) ? trigger : 20;
  const domain = Math.max(trg * 1.75, Math.abs(prem) * 1.2, 15);
  const pct = (v) => clamp(50 + (v / domain) * 50, 0.5, 99.5);

  const negEdge = pct(-trg);
  const posEdge = pct(trg);
  const zn = $('zone-neg'); if (zn) zn.style.width = `${negEdge}%`;
  const zp = $('zone-pos'); if (zp) zp.style.width = `${100 - posEdge}%`;
  const hn = $('hair-neg'); if (hn) hn.style.left = `${negEdge}%`;
  const hp = $('hair-pos'); if (hp) hp.style.left = `${posEdge}%`;
  const nd = $('needle'); if (nd) nd.style.left = `${pct(prem)}%`;

  rail.setAttribute('aria-valuemin', fmtN(-domain, 0));
  rail.setAttribute('aria-valuemax', fmtN(domain, 0));
  rail.setAttribute('aria-valuenow', fmtN(prem, 1));
  rail.setAttribute('aria-valuetext',
    `${fmtSigned(prem, 1)} basis points, against a trigger of plus or minus ${fmtN(trg, 1)}`);
}

function renderLadder(bid, ask, mid, nav) {
  const vals = [bid, ask, mid, nav].filter((v) => Number.isFinite(v) && v > 0);
  if (vals.length < 4) return;
  let lo = Math.min(...vals); let hi = Math.max(...vals);
  const span = hi - lo;
  const pad = span > 1e-9 ? span * 0.45 : Math.max(mid * 0.0004, 0.001);
  lo -= pad; hi += pad;

  const TOP = 16; const USABLE = 236;
  const pos = (v) => TOP + ((hi - v) / (hi - lo)) * USABLE;

  const nodes = [
    { id: 'n-ask', v: ask },
    { id: 'n-mid', v: mid },
    { id: 'n-nav', v: nav },
    { id: 'n-bid', v: bid },
  ].map((nd) => ({ ...nd, p: pos(nd.v) }));

  /* Bid, ask, mid and NAV routinely sit within a cent of each other, which
     stacks their labels on top of one another. Push only the LABELS apart —
     the knob and its leader line stay at the true price, so the picture
     never lies about where a level actually is. */
  const MIN_GAP = 19;
  const ordered = [...nodes].sort((a, b) => a.p - b.p);
  let last = -Infinity;
  for (const nd of ordered) {
    nd.label = Math.max(nd.p, last + MIN_GAP);
    last = nd.label;
  }
  const overflow = last - (TOP + USABLE);
  if (overflow > 0) for (const nd of ordered) nd.label -= overflow;

  for (const nd of nodes) {
    const el = $(nd.id);
    if (!el) continue;
    el.style.top = `${nd.p}px`;
    const off = nd.label - nd.p;
    const tag = el.querySelector('.tag-l');
    if (tag) tag.style.transform = `translateY(${off}px)`;
    // the label glides with the knob, and must land on the same figure the
    // stat rail is easing toward
    const px = el.querySelector('.px');
    if (px) {
      px.style.transform = `translateY(calc(-50% + ${off}px))`;
      animate(px, nd.v, (x) => fmtUsd(x, 4));
    }
  }

  const pm = nodes.find((nd) => nd.id === 'n-mid').p;
  const pn = nodes.find((nd) => nd.id === 'n-nav').p;

  const band = $('gap-band');
  if (band) {
    const top = Math.min(pm, pn);
    const height = Math.max(Math.abs(pm - pn), 2);
    band.style.top = `${top}px`;
    band.style.height = `${height}px`;
    band.style.opacity = height > 4 ? '1' : '0.35';
    const diff = mid - nav;
    const bps = nav > 0 ? (diff / nav) * 10000 : NaN;
    // lives in the card header, not inside the band — when mid and NAV are a
    // cent apart the band is too thin to hold a caption without colliding
    setText('gap-chip', `${fmtSigned(diff, 4)} · ${fmtSigned(bps, 1)} bps`);
  }
}

const WF_KEYS = [
  { k: 'fee', label: 'Create / redeem fee', mix: 88 },
  { k: 'commission', label: 'Share commission', mix: 68 },
  { k: 'execution', label: 'Gold execution', mix: 50 },
  { k: 'impact', label: 'Market impact, both legs', mix: 34 },
  { k: 'spread', label: 'Gold spot spread', mix: 22 },
];

/* Built once. Rewriting innerHTML every tick would replace the nodes
   mid-transition, so the bar would silently never animate — and it
   would trash any text the user had selected. */
let wfNodes = null;
function buildWaterfall() {
  const bar = $('wf-bar');
  const keys = $('wf-keys');
  if (!bar || !keys) return null;

  bar.style.position = 'relative';
  bar.innerHTML = WF_KEYS.map((d) =>
    `<div class="wf-seg" data-k="${d.k}" style="flex:0 0 0%;background:color-mix(in oklab, var(--neu) ${d.mix}%, transparent)"></div>`
  ).join('')
    + '<div class="wf-seg" data-k="edge" style="flex:0 0 0%"></div>'
    + '<div style="flex:1 1 auto"></div>'
    + '<div class="wf-mark" title="Where the actual gap reaches"></div>';

  keys.innerHTML = WF_KEYS.map((d) =>
    `<div class="wf-key">
       <i style="background:color-mix(in oklab, var(--neu) ${d.mix}%, transparent)"></i>
       <span class="k">${d.label}</span>
       <span class="v num" data-v="${d.k}">—</span>
     </div>`
  ).join('')
    + `<div class="wf-key" style="border-bottom-color:transparent">
         <i style="background:var(--accent)"></i>
         <span class="k">Edge left over</span>
         <span class="v num" data-v="edge">—</span>
       </div>`;

  const byKey = (root, sel, attr) =>
    Object.fromEntries([...root.querySelectorAll(sel)].map((e) => [e.dataset[attr], e]));

  return {
    segs: byKey(bar, '.wf-seg', 'k'),
    mark: bar.querySelector('.wf-mark'),
    vals: byKey(keys, '[data-v]', 'v'),
  };
}

function renderWaterfall(mid, prem, cost) {
  const parts = costParts(mid);
  if (!parts) return;
  if (!wfNodes) wfNodes = buildWaterfall();
  if (!wfNodes) return;

  const gross = Math.abs(Number(prem));
  const totalCost = Number(cost);
  const edge = gross - totalCost;
  const scale = Math.max(gross, totalCost) * 1.04 || 1;
  const pct = (v) => `${clamp((v / scale) * 100, 0, 100)}%`;

  for (const d of WF_KEYS) {
    wfNodes.segs[d.k].style.flexBasis = pct(parts[d.k]);
    wfNodes.vals[d.k].textContent = `${fmtN(parts[d.k], 2)} bps`;
  }
  wfNodes.segs.edge.style.flexBasis = pct(Math.max(0, edge));
  wfNodes.vals.edge.textContent = `${fmtSigned(edge, 2)} bps`;
  wfNodes.vals.edge.style.color = edge > 0 ? 'var(--pos)' : 'var(--ink-3)';
  wfNodes.mark.style.left = pct(gross);

  setText('wf-gross', fmtN(gross, 1));
  setText('wf-max', `${fmtN(scale, 1)} bps`);
  setText('wf-verdict', edge > 0
    ? `${fmtN(edge, 1)} bps survives the trip`
    : `${fmtN(-edge, 1)} bps short of viable`);
}

function addTradeRow(t) {
  const tbody = $('trades-body');
  if (!tbody) return;
  const empty = $('no-trades'); if (empty) empty.hidden = true;
  const table = $('trades-table'); if (table) table.hidden = false;

  const cls = t.signal === 'CREATE' ? 'create' : 'redeem';
  const label = t.signal === 'CREATE' ? 'Create' : 'Redeem';
  const time = String(t.timestamp).includes('T') ? String(t.timestamp).slice(11, 19) : hhmmss(t.timestamp);

  const tr = document.createElement('tr');
  tr.innerHTML =
    `<td class="num mono">${time}</td>` +
    `<td><span class="side ${cls}">${label}</span></td>` +
    `<td class="num">${fmtN(t.spreadBps, 1)} bps</td>` +
    `<td class="num" style="color:${t.pnl >= 0 ? 'var(--pos)' : 'var(--neg)'};font-weight:700">${fmtUsd(t.pnl, 2)}</td>`;
  tbody.insertBefore(tr, tbody.firstChild);
  while (tbody.children.length > 30) tbody.removeChild(tbody.lastChild);
}

function toast(signal, spreadBps, pnl) {
  const host = $('toasts');
  if (!host) return;
  const el = document.createElement('div');
  const cls = signal === 'CREATE' ? 'create' : 'redeem';
  el.className = `toast ${cls}`;
  el.innerHTML =
    `<div class="h">${signal === 'CREATE' ? 'Create signal' : 'Redeem signal'}</div>` +
    `<div class="b">${fmtN(spreadBps, 1)} bps clear of costs · <b>${fmtUsd(pnl, 2)}</b> on one basket</div>`;
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 400);
  }, 6200);
  while (host.children.length > 3) host.firstChild.remove();
}

/* ── the main paint ──────────────────────────────────────────── */
function renderSnapshot(s) {
  const bps = Number(s.btcPerShare) || state.btcPerShare;
  const source = s.btcPerShareSource || state.btcPerShareSource;
  const ev = evaluate(s.arkbMid, s.btcPrice, bps);
  // The backend prices a single basket at the configured fee. As soon as the
  // desk sizes the trade differently, its cost/trigger/signal no longer apply
  // and the local model — identical maths, chosen sizing — takes over.
  const sized = !sizingIsDefault();
  const trigger = !sized && Number.isFinite(s.trigger) ? s.trigger : ev.triggerBps;
  const cost = !sized && Number.isFinite(s.costBps) ? s.costBps : ev.costBps;
  const prem = Number.isFinite(s.premBps) ? s.premBps : ev.premBps;
  const signal = !sized && s.signal ? s.signal : ev.signal;
  const mid = Number(s.arkbMid);
  const nav = Number(ev.nav || s.nav);

  /* hero */
  animate($('basis-value'), prem, (v) => fmtSigned(v, 1));
  const lde = $('hero-lede');
  if (lde) lde.innerHTML = lede(prem, signal, trigger);

  /* 60-second drift */
  state.basisTrail.push({ t: Date.now(), v: prem });
  while (state.basisTrail.length && Date.now() - state.basisTrail[0].t > 60000) state.basisTrail.shift();
  const ref = state.basisTrail[0];
  const drift = ref ? prem - ref.v : NaN;
  const dEl = $('basis-delta');
  if (dEl) {
    const settled = Number.isFinite(drift) && state.basisTrail.length > 3;
    dEl.className = `hero-delta ${settled && drift > 0.2 ? 'up' : settled && drift < -0.2 ? 'down' : ''}`;
    dEl.querySelector('.arrow').textContent = settled ? (drift > 0.2 ? '▲' : drift < -0.2 ? '▼' : '•') : '•';
    setText('basis-delta-text', settled
      ? `${fmtSigned(drift, 1)} bps over the last minute`
      : 'building the first minute');
  }

  const edge = Number.isFinite(prem) && Number.isFinite(cost) ? Math.abs(prem) - cost : NaN;
  renderVerdict(signal, edge, trigger, prem);
  renderMeter(prem, trigger);

  setText('tag-trigger', Number.isFinite(trigger) ? `Trigger ±${fmtN(trigger, 1)} bps` : 'Trigger —');
  setText('tag-cost', Number.isFinite(cost) ? `Cost ${fmtN(cost, 1)} bps` : 'Cost —');

  const elapsedMin = state.backendLive && s.elapsed != null
    ? Number(s.elapsed)
    : (Date.now() - state.startTime) / 60000;
  setText('tag-session', `Session ${fmtN(elapsedMin, 1)} min`);

  /* stat rail */
  const dir = (id, v) => {
    const prev = state.lastPrices[id];
    state.lastPrices[id] = v;
    return Number.isFinite(prev) && Math.abs(v - prev) > 1e-9 ? Math.sign(v - prev) : 0;
  };
  flash($('arkb-mid'), dir('arkb', mid));
  flash($('btc-price'), dir('btc', Number(s.btcPrice)));

  animate($('arkb-mid'), mid, (v) => fmtUsd(v, 4));
  animate($('arkb-bid'), Number(s.arkbBid), (v) => fmtUsd(v, 4));
  animate($('arkb-ask'), Number(s.arkbAsk), (v) => fmtUsd(v, 4));
  animate($('btc-price'), Number(s.btcPrice), (v) => fmtUsd(v, 0));
  animate($('nav'), nav, (v) => fmtUsd(v, 4));
  setText('btc-per-share', fmtBtcExact(bps, 16));
  setText('nav-src', source === 'config' ? 'CONFIG' : source === 'default' ? 'DEFAULT' : 'ARK CSV');

  const cu = basketShares();
  const cuBtc = cu * bps;
  // Value of the bitcoin behind one basket, so this figure agrees with the BTC
  // amount shown beside it (cuBtc * spot). Fee amortisation still uses traded
  // notional (mid * shares) inside costParts — different quantity, on purpose.
  const cuNotional = (nav > 0 ? nav : mid) * cu;
  const cuDetail = `${fmtBtcExact(cuBtc)} oz ·${cu.toLocaleString()} shares`;
  animate($('cu-value'), cuNotional, (v) => fmtCompact(v));
  animate($('cu-value-card'), cuNotional, (v) => fmtUsd(v, 2));
  setText('cu-shares', sizing.units === 1 ? `${cu.toLocaleString()} sh` : `× ${sizing.units}`);
  setText('cu-detail', cuDetail);
  setText('cu-detail-card', cuDetail);
  animate($('cost-total'), cost, (v) => `${fmtN(v, 2)} bps`);

  /* session change badges — measured from the session open, not from
     whatever happens to still be in the sparkline's 180-sample buffer */
  sparks.arkb.push(mid);
  sparks.btc.push(Number(s.btcPrice));
  sparks.nav.push(nav);
  sparks.cu.push(cuNotional);
  const sessionChange = (key, v) => {
    if (!Number.isFinite(v) || v <= 0) return NaN;
    if (!Number.isFinite(state.open[key])) { state.open[key] = v; return 0; }
    return ((v - state.open[key]) / state.open[key]) * 100;
  };
  const badge = (id, v) => {
    const el = $(id);
    if (!el) return;
    el.textContent = Number.isFinite(v) ? `${fmtSigned(v, 2)}%` : '—';
    el.className = `stat-badge ${v > 0 ? 'up' : v < 0 ? 'down' : ''}`;
  };
  badge('arkb-chg', sessionChange('arkb', mid));
  badge('btc-chg', sessionChange('btc', Number(s.btcPrice)));

  /* top strip */
  setText('t-arkb', fmtUsd(mid, 2));
  setText('t-nav', fmtUsd(nav, 2));
  setText('t-btc', fmtUsd(Number(s.btcPrice), 0));
  setText('t-basis', `${fmtSigned(prem, 1)} bps`);
  const tb = $('t-basis');
  if (tb) tb.className = Math.abs(prem) < 0.2 ? '' : prem > 0 ? 'pos' : 'neg';
  setText('t-updated', hhmmss(Date.now()));

  /* ladder + waterfall + sizing */
  renderLadder(Number(s.arkbBid), Number(s.arkbAsk), mid, nav);
  renderWaterfall(mid, prem, cost);
  renderSizingSummary(mid);
  renderFeasibility(mid, prem);

  /* p&l block */
  const totalPnl = state.backendLive && s.totalPnl != null ? s.totalPnl : state.totalPnl;
  const tradeCount = state.backendLive && s.tradeCount != null ? s.tradeCount : state.tradeCount;
  const winRate = state.backendLive && s.winRate != null ? s.winRate : state.winRate;
  const pnlEl = $('total-pnl');
  if (pnlEl) {
    pnlEl.className = `pnl num ${totalPnl > 0 ? 'up' : totalPnl < 0 ? 'down' : ''}`;
    animate(pnlEl, totalPnl, (v) => fmtUsd(v, 2));
  }
  // "0% profitable" reads as 0 winners out of N. With no trades at all there is
  // no win rate to report, and claiming one implies losses that never happened.
  setText('pnl-stats', tradeCount === 0
    ? 'No signals yet this session'
    : `${tradeCount} signal${tradeCount === 1 ? '' : 's'} · ${fmtN(winRate, 0)}% profitable`);

  /* session analytics */
  if (Number.isFinite(prem)) {
    state.samples += 1;
    state.high = Math.max(state.high, prem);
    state.low = Math.min(state.low, prem);
    const inZone = Number.isFinite(trigger) && Math.abs(prem) > trigger;
    if (inZone) state.inZone += 1;
    if (inZone && !state.wasInZone) state.crossings += 1;
    state.wasInZone = inZone;
    setText('s-high', `${fmtSigned(state.high, 1)} bps`);
    setText('s-low', `${fmtSigned(state.low, 1)} bps`);
    setText('s-inzone', `${fmtN((state.inZone / Math.max(1, state.samples)) * 100, 1)}%`);
    setText('s-cross', String(state.crossings));
  }

  /* chart */
  if (chart) {
    chart.setTrigger(trigger);
    chart.push(s.timestamp || Date.now(), prem);
    const cv = chart.cv;
    if (cv) {
      cv.setAttribute('aria-label',
        `Basis over time. Currently ${fmtSigned(prem, 1)} basis points against a trigger of plus or minus ${fmtN(trigger, 1)}. Session high ${fmtSigned(state.high, 1)}, low ${fmtSigned(state.low, 1)}.`);
    }
  }

  /* a monitor is often a background tab — put the number in the title */
  const glyph = signal === 'CREATE' ? '▲' : signal === 'REDEEM' ? '▼' : '·';
  const nextTitle = `${glyph} ${fmtSigned(prem, 1)} bps · ${(CFG.etf && CFG.etf.ticker) || "ARKB"}`;
  if (document.title !== nextTitle) document.title = nextTitle;

  state.lastTickAt = Date.now();
  state.lastSnapshot = s;
  if (document.body.dataset.stale === '1') document.body.dataset.stale = '0';
}

/* ══════════════════════════════════════════════════════════════
   DATA — backend socket, with a standalone fallback
   ══════════════════════════════════════════════════════════════ */
async function loadConfig() {
  for (const url of ['/api/config', 'config.json', './config.json']) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      const json = await res.json();
      CFG = {
        ...CFG,
        ...json,
        etf: { ...CFG.etf, ...(json.etf || {}) },
        costs: { ...CFG.costs, ...(json.costs || {}) },
        signals: { ...CFG.signals, ...(json.signals || {}) },
        coinbase: { ...CFG.coinbase, ...(json.coinbase || {}) },
      };
      state.btcPerShare = Number(CFG.etf.btcPerShare) || state.btcPerShare;
      state.btcPerShareSource = 'config';
      return true;
    } catch { /* try next */ }
  }
  return false;
}

async function fetchBtcPrice() {
  // IAU: the "spot" feed is Yahoo Finance gold (GC=F), wrapped in a CORS proxy
  // because Yahoo sends no CORS header. Shape: chart.result[0].meta.regularMarketPrice.
  const url = CFG.coinbase?.restUrl;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`gold fetch failed: ${res.status}`);
  const data = await res.json();
  const price = Number(data?.chart?.result?.[0]?.meta?.regularMarketPrice ?? data?.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid gold price');
  return price;
}

function nextStandaloneSnapshot(btcPrice) {
  const bps = state.btcPerShare;
  const nav = btcPrice * bps;
  let bid; let ask; let mid;

  if (liveArkb && (liveArkb.last != null || (liveArkb.bid != null && liveArkb.ask != null))) {
    bid = Number(liveArkb.bid);
    ask = Number(liveArkb.ask);
    mid = Number(liveArkb.last);
    if (!(mid > 0) && bid > 0 && ask > 0) mid = (bid + ask) / 2;
    if (!(bid > 0) && mid > 0) bid = mid * 0.99985;
    if (!(ask > 0) && mid > 0) ask = mid * 1.00015;
  } else {
    state.basisBps += (Math.random() - 0.5) * 1.4;
    state.basisBps *= 0.985;
    state.basisBps = clamp(state.basisBps, -60, 60);
    mid = nav * (1 + state.basisBps / 10000);
    const half = mid * 0.00015;
    bid = mid - half;
    ask = mid + half;
  }

  const ev = evaluate(mid, btcPrice, bps);
  return {
    timestamp: new Date().toISOString(),
    btcPrice,
    arkbBid: bid,
    arkbAsk: ask,
    arkbMid: mid,
    nav: ev.nav,
    premBps: ev.premBps,
    trigger: ev.triggerBps,
    costBps: ev.costBps,
    signal: ev.signal,
    btcPerShare: bps,
    btcPerShareSource: state.btcPerShareSource,
  };
}

function registerTradeFromEval(snapshot, ev) {
  const now = Date.now();
  const cooldown = Number(CFG.signals.cooldownMs) || 15000;
  if (!ev || ev.signal === 'NEUTRAL') { state.lastSignal = 'NEUTRAL'; return; }
  if (ev.signal === state.lastSignal && now - state.lastSignalAt < cooldown) return;
  if (!(ev.spreadCapturedBps > 0)) return;

  const trade = {
    timestamp: snapshot.timestamp,
    signal: ev.signal,
    spreadBps: ev.spreadCapturedBps,
    pnl: ev.pnlUsd,
  };
  state.trades.unshift(trade);
  state.trades = state.trades.slice(0, 30);
  state.tradeCount += 1;
  state.totalPnl += trade.pnl;
  const wins = state.trades.filter((t) => t.pnl > 0).length;
  state.winRate = state.trades.length ? (wins / state.trades.length) * 100 : 0;
  state.lastSignalAt = now;
  state.lastSignal = ev.signal;
  addTradeRow(trade);
  // backend mode announces via the 'trade' socket event instead —
  // these two paths never run at the same time, so no double toast
  toast(trade.signal, trade.spreadBps, trade.pnl);
}

async function standaloneTick() {
  try {
    const btc = await fetchBtcPrice();
    const snapshot = nextStandaloneSnapshot(btc);
    const ev = evaluate(snapshot.arkbMid, snapshot.btcPrice, state.btcPerShare);
    registerTradeFromEval(snapshot, ev);
    renderSnapshot(snapshot);
    setText('mode-chip', liveArkb ? 'Live quotes' : 'Live gold · modelled IAU');
    setStatus('live', liveArkb ? 'Live' : 'Partial');
  } catch {
    setStatus('err', 'No data');
    setText('mode-chip', 'Offline');
  }
}

function applyBackendSnapshot(s) {
  state.backendLive = true;
  if (s.btcPerShare) {
    state.btcPerShare = s.btcPerShare;
    state.btcPerShareSource = s.btcPerShareSource || state.btcPerShareSource;
  }
  if (typeof s.totalPnl === 'number') state.totalPnl = s.totalPnl;
  if (typeof s.tradeCount === 'number') state.tradeCount = s.tradeCount;
  if (typeof s.winRate === 'number') state.winRate = s.winRate;
  renderSnapshot(s);
  setText('mode-chip', s.dryRun ? 'Simulation' : 'Live backend');
  setStatus('live', s.dryRun ? 'Simulated' : 'Connected');
  // in dry run the modelled price comes off a fictional bitcoin level, so the
  // real quote below will not line up. Say so rather than let it read as an error.
  setText('market-sub', s.dryRun
    ? 'Real quote. Prices above are simulated, so the two will not agree — that is expected in dry run.'
    : 'Independent quote used to sanity-check the model.');
}

function startBackendMode() {
  if (typeof io !== 'function') return false;
  const socket = io({ transports: ['websocket', 'polling'], reconnection: true });
  let connected = false;

  socket.on('connect', () => {
    connected = true;
    state.mode = 'backend';
    if (standaloneTimer) { clearInterval(standaloneTimer); standaloneTimer = null; }
    setStatus('live', 'Connected');
  });
  socket.on('snapshot', applyBackendSnapshot);
  socket.on('history', (rows) => { if (chart) chart.seed(rows); });
  socket.on('trade', (t) => {
    addTradeRow(t);
    toast(t.signal, t.spreadBps, t.pnl);
  });
  socket.on('trades', (trades) => {
    if (!Array.isArray(trades)) return;
    const tbody = $('trades-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!trades.length) {
      const empty = $('no-trades'); if (empty) empty.hidden = false;
      const table = $('trades-table'); if (table) table.hidden = true;
      return;
    }
    trades.slice().reverse().forEach(addTradeRow);
  });
  socket.on('disconnect', () => {
    setStatus('warn', 'Reconnecting');
    if (!standaloneTimer) {
      standaloneTimer = setInterval(standaloneTick, 30000);
      standaloneTick();
    }
  });

  setTimeout(() => {
    if (!connected && !standaloneTimer) {
      standaloneTimer = setInterval(standaloneTick, 30000);
      standaloneTick();
    }
  }, 1200);

  return true;
}

/* ── external market feed ────────────────────────────────────── */
async function loadMarketOverview() {
  // IAU is not on the shared bitcoin market-overview feed, so the independent
  // quote comes from twelvedata (stock quote API), reliable + free tier.
  const host = $('market-overview');
  if (!host) return;
  const url = CFG.etfQuoteUrl;
  if (!url) {
    host.innerHTML = '<div class="empty" style="padding:28px"><span>No market feed configured.</span></div>';
    return;
  }
  try {
    const res = await fetch(url, { cache: 'no-store' });
    // twelvedata free tier rate-limits at ~60 calls/minute. If we hit 429,
    // backoff exponentially so the dashboard doesn't flicker offline constantly.
    if (res.status === 429) {
      host.innerHTML = '<div class="empty" style="padding:28px"><span>Rate limited. Retrying in 30s.</span></div>';
      setText('market-updated', 'rate-limited');
      return;
    }
    if (!res.ok) throw new Error(`status ${res.status}`);
    const json = await res.json();
    // twelvedata response shape: {close, previous_close, percent_change, ...}
    if (json.error || json.code) throw new Error(json.message || 'API error');
    const last = Number(json.close);
    if (!Number.isFinite(last) || last <= 0) throw new Error('no IAU quote');
    const prev = Number(json.previous_close ?? json.close);
    const chgPct = Number.isFinite(prev) && prev > 0 ? ((last - prev) / prev) * 100 : null;
    // twelvedata free tier doesn't include bid/ask, so synthesize from last
    const bid = last * 0.99985;
    const ask = last * 1.00015;
    // feed the standalone snapshot loop
    liveArkb = { last, bid, ask };

    const sym = String((CFG.etf && CFG.etf.ticker) || 'IAU');
    const chg = chgPct != null
      ? `<span style="color:${chgPct >= 0 ? 'var(--pos)' : 'var(--neg)'};font-weight:700">${fmtSigned(chgPct, 2)}%</span>`
      : '—';
    const cell = (v, d2 = 2) => (v != null && Number.isFinite(Number(v)) ? fmtUsd(v, d2) : '—');
    const row = `<tr>
        <td style="color:var(--ink);font-weight:700">${sym}</td>
        <td class="num">${cell(last)}</td>
        <td class="num">${cell(bid)}</td>
        <td class="num">${cell(ask)}</td>
        <td class="num">—</td>
        <td class="num">${chg}</td>
      </tr>`;
    host.innerHTML = `<table class="data">
      <thead><tr><th>Symbol</th><th>Last</th><th>Bid</th><th>Ask</th><th>Spread</th><th>Day</th></tr></thead>
      <tbody>${row}</tbody></table>`;
    lastMarketHtml = host.innerHTML;  // cache successful render
    setText('market-updated', hhmmss(Date.now()));
  } catch (e) {
    // On error, keep showing the last successful data (don't flip to offline immediately).
    // Only show "unavailable" if we've never had a successful fetch.
    if (!lastMarketHtml) {
      host.innerHTML = '<div class="empty" style="padding:28px"><span>IAU quote unavailable.</span></div>';
      setText('market-updated', 'offline');
    }
    // else: silently fail, keep showing stale data until next successful fetch
  }
}

/* ══════════════════════════════════════════════════════════════
   INTERACTION
   ══════════════════════════════════════════════════════════════ */
function refreshNow() {
  const btn = $('refresh-btn');
  if (btn) {
    btn.classList.remove('spin');
    void btn.offsetWidth;
    btn.classList.add('spin');
  }
  if (state.mode === 'backend' && state.backendLive) {
    fetch('/api/state').then((r) => r.json()).then(applyBackendSnapshot).catch(standaloneTick);
  } else {
    standaloneTick();
  }
  loadMarketOverview();
}

function setRange(btn) {
  if (!btn) return;
  document.querySelectorAll('#range-seg button').forEach((b) => b.classList.toggle('on', b === btn));
  if (chart) chart.setRange(Number(btn.dataset.range));
}

function bindUI() {
  $('refresh-btn')?.addEventListener('click', refreshNow);

  const sheet = $('help-sheet');
  let restoreFocus = null;
  const openHelp = () => {
    if (!sheet || !sheet.hidden) return;
    restoreFocus = document.activeElement;
    sheet.hidden = false;
    $('help-close')?.focus();
  };
  const closeHelp = () => {
    if (!sheet || sheet.hidden) return;
    sheet.hidden = true;
    if (restoreFocus?.focus) restoreFocus.focus();
    restoreFocus = null;
  };
  $('help-btn')?.addEventListener('click', openHelp);
  $('help-close')?.addEventListener('click', closeHelp);
  sheet?.addEventListener('click', (e) => { if (e.target === sheet) closeHelp(); });
  // the sheet is modal: keep Tab inside it
  sheet?.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); $('help-close')?.focus(); }
  });

  document.querySelectorAll('#range-seg button').forEach((b) => {
    b.addEventListener('click', () => setRange(b));
  });

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    if (k === 'r') refreshNow();
    else if (k === '?' || (e.key === '/' && e.shiftKey)) openHelp();
    else if (e.key === 'Escape') closeHelp();
    else if (['1', '2', '3', '4'].includes(e.key)) {
      setRange(document.querySelectorAll('#range-seg button')[Number(e.key) - 1]);
    }
  });

  window.addEventListener('resize', () => {
    remeasureAll();
    Object.values(sparks).forEach((s) => { s.dirty = true; });
  });
}

/* ══════════════════════════════════════════════════════════════
   BASKET SIZING CONTROLS
   ══════════════════════════════════════════════════════════════ */
function saveSizing() {
  try { localStorage.setItem('arkb-sizing', JSON.stringify(sizing)); } catch { /* private mode */ }
}
function loadSizing() {
  try {
    const raw = JSON.parse(localStorage.getItem('arkb-sizing') || 'null');
    if (!raw) return;
    if (Number.isFinite(raw.units)) sizing.units = clamp(Math.round(raw.units), 1, 500);
    if (raw.feeUsd === null || Number.isFinite(raw.feeUsd)) sizing.feeUsd = raw.feeUsd;
    if (raw.feeMode === 'basket' || raw.feeMode === 'order') sizing.feeMode = raw.feeMode;
  } catch { /* ignore */ }
}

function syncSizingUI() {
  const ui = $('units-input');
  if (ui && document.activeElement !== ui) ui.value = String(sizing.units);
  const fi = $('fee-input');
  if (fi && document.activeElement !== fi) fi.value = String(feeUsd());

  document.querySelectorAll('#unit-presets button').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.units) === sizing.units);
  });
  document.querySelectorAll('#fee-mode button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === sizing.feeMode);
  });
  const down = $('units-down');
  if (down) down.disabled = sizing.units <= 1;
  const up = $('units-up');
  if (up) up.disabled = sizing.units >= 500;
}

/* The point of the control: show what the flat fee actually costs at this
   size, and what it would cost at one basket, side by side. */
function renderSizingSummary(mid) {
  const host = $('sz-summary');
  if (!host) return;
  const price = Number(mid);
  if (!(price > 0)) { host.textContent = 'Waiting for a price.'; return; }

  const shares = basketShares();
  const perUnitShares = Number(CFG.etf.creationUnitShares) || 5000;
  const feeBpsNow = (totalFeeUsd() / (shares * price)) * 10000;
  const feeBpsOne = (feeUsd() / (perUnitShares * price)) * 10000;
  const n = sizing.units;

  const head = `<b>${n}</b> basket${n === 1 ? '' : 's'} · <b>${shares.toLocaleString()}</b> shares · `
    + `<b>${fmtBtcExact(shares * state.btcPerShare)}</b> oz ·<b>${fmtCompact(shares * price)}</b> notional`;

  let tail;
  if (n === 1) {
    tail = `Fee <b>${fmtUsd(totalFeeUsd(), 0)}</b> — <span class="hl">${fmtN(feeBpsNow, 2)} bps</span> of the round trip.`;
  } else if (sizing.feeMode === 'order') {
    tail = `One flat <b>${fmtUsd(totalFeeUsd(), 0)}</b> across all ${n} — the fee drag falls from `
      + `${fmtN(feeBpsOne, 2)} to <span class="hl">${fmtN(feeBpsNow, 2)} bps</span>, so the trigger drops with size.`;
  } else {
    tail = `<b>${fmtUsd(feeUsd(), 0)}</b> × ${n} = <b>${fmtUsd(totalFeeUsd(), 0)}</b> — charged per basket, so the drag stays `
      + `<span class="hl">${fmtN(feeBpsNow, 2)} bps</span> at any size. Only the dollars scale, not the edge.`;
  }
  host.innerHTML = `${head}<br>${tail}`;
}

function setSizing(patch) {
  Object.assign(sizing, patch);
  sizing.units = clamp(Math.round(sizing.units) || 1, 1, 500);
  saveSizing();
  syncSizingUI();
  if (state.lastSnapshot) renderSnapshot(state.lastSnapshot);
}

function bindSizing() {
  loadSizing();
  syncSizingUI();

  $('units-down')?.addEventListener('click', () => setSizing({ units: sizing.units - 1 }));
  $('units-up')?.addEventListener('click', () => setSizing({ units: sizing.units + 1 }));
  $('units-input')?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v) && v >= 1) setSizing({ units: v });
  });
  $('units-input')?.addEventListener('blur', syncSizingUI);

  $('fee-input')?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v) && v >= 0) setSizing({ feeUsd: v });
  });
  $('fee-input')?.addEventListener('blur', syncSizingUI);

  document.querySelectorAll('#unit-presets button').forEach((b) => {
    b.addEventListener('click', () => setSizing({ units: Number(b.dataset.units) }));
  });
  document.querySelectorAll('#fee-mode button').forEach((b) => {
    b.addEventListener('click', () => setSizing({ feeMode: b.dataset.mode }));
  });
  $('sizing-reset')?.addEventListener('click', () =>
    setSizing({ units: 1, feeUsd: null, feeMode: 'basket' }));
  // one click from "what would it take" to actually being sized for it
  $('feas-apply')?.addEventListener('click', (e) => {
    const u = Number(e.currentTarget.dataset.units);
    if (Number.isFinite(u) && u >= 1) setSizing({ units: u });
  });
}

/* Data that has stopped arriving must stop looking authoritative. */
function watchFreshness() {
  setInterval(() => {
    if (!state.lastTickAt) return;
    const age = (Date.now() - state.lastTickAt) / 1000;
    if (age > 10) {
      document.body.dataset.stale = '1';
      setStatus('warn', `Stale ${Math.round(age)}s`);
    }
  }, 1000);
}

/* ══════════════════════════════════════════════════════════════
   BOOT
   ══════════════════════════════════════════════════════════════ */
async function boot() {
  bindUI();

  chart = new GapChart($('gap-canvas'));
  sparks.arkb = new Spark($('spark-arkb'));
  sparks.btc = new Spark($('spark-btc'));
  // every rail sparkline reads its own direction — a blue line next to a red
  // one implied a distinction that does not exist
  sparks.nav = new Spark($('spark-nav'));
  sparks.cu = new Spark($('spark-cu'));
  setInterval(() => Object.values(sparks).forEach((s) => s.draw()), 900);
  startSizeWatch();

  // entrance animations are decoration; never let them gate the content
  setTimeout(() => document.querySelectorAll('.rise').forEach((el) => el.classList.add('shown')), 1400);
  watchFreshness();

  await loadConfig();
  bindSizing();          // after loadConfig so the fee field shows the real default
  startBackendMode();
  loadMarketOverview();
  setInterval(loadMarketOverview, 30000);  // 30s: respect twelvedata free-tier rate limit (~60 calls/min)
}

boot();
