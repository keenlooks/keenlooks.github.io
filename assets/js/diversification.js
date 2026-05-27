/* ==========================================================================
   Diversification explainer — why holding many uncorrelated bets narrows the
   range of outcomes (kills the worst cases) while keeping most of the upside,
   and how fees skim off the top.
   --------------------------------------------------------------------------
   Data: real value-weighted annual returns for 30 industry portfolios,
   1995–2024 (Ken French Data Library — free to use/redistribute), bundled in
   diversification-data.js as window.DIVERSIFICATION_DATA.

   Simulation: for each portfolio size N (1..30), run many trials. Each trial
   picks a random 10-consecutive-year window and N random industries, holds them
   equal-weighted (rebalanced annually), and compounds to a final value of an
   initial $10,000. We chart, per N, the spread of GROSS outcomes (5–95 and
   25–75 percentile bands + median) — it funnels inward as N grows — plus a RED
   line for the NET-of-fee median, the gap being what fees take.

   Seeded PRNG so the picture is stable across redraws (Reshuffle re-seeds).
   Theme-aware; responsive (DPR-capped). No live data / no network.
   ========================================================================== */
(function () {
  var canvas = document.getElementById('div-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  var D = window.DIVERSIFICATION_DATA;
  if (!D || !D.returns) return;

  function id(x) { return document.getElementById(x); }
  var elFee = id('div-fee'), elFeeVal = id('div-fee-val');
  var btnShuffle = id('div-shuffle'), btnReset = id('div-reset');
  var roGross = id('div-gross'), roNet = id('div-net'), roLost = id('div-lost'), roNote = id('div-note');

  var INITIAL = 10000, HORIZON = 10, TRIALS = 500;
  var nInd = D.returns.length, nYears = D.years.length, maxStart = nYears - HORIZON;
  var DEF_FEE = 1.0;
  var state = { fee: DEF_FEE, seed: 12345 };
  var sim = null;   // cached simulation result

  function effectiveTheme() {
    var f = document.documentElement.getAttribute('data-theme');
    if (f === 'light' || f === 'dark') return f;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }
  function palette() {
    var light = effectiveTheme() === 'light';
    return {
      text:   light ? '#262626' : '#d6d6d6',
      muted:  light ? '#737373' : '#9a9a9a',
      grid:   light ? 'rgba(0,0,0,0.09)'  : 'rgba(255,255,255,0.09)',
      axis:   light ? 'rgba(0,0,0,0.40)'  : 'rgba(255,255,255,0.38)',
      accent: light ? '#34568a' : '#82a6cc',
      band1:  light ? 'rgba(52,86,138,0.13)' : 'rgba(130,166,204,0.14)',  // 5–95
      band2:  light ? 'rgba(52,86,138,0.26)' : 'rgba(130,166,204,0.30)',  // 25–75
      fee:    light ? '#b4452f' : '#d98b76',   // reserved red = cost
      feeFill:light ? 'rgba(180,69,47,0.16)' : 'rgba(217,139,118,0.18)',
      panel:  light ? '#ffffff' : '#141414'
    };
  }

  // deterministic PRNG (mulberry32) so the chart is stable across redraws
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function pct(sorted, q) {
    var idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
    return sorted[idx];
  }

  // Run the simulation for the current seed + fee. Returns per-N bands.
  function simulate() {
    var rng = mulberry32(state.seed);
    var idxPool = []; for (var a = 0; a < nInd; a++) idxPool.push(a);
    var out = [];
    for (var n = 1; n <= nInd; n++) {
      var gross = new Array(TRIALS), net = new Array(TRIALS);
      for (var t = 0; t < TRIALS; t++) {
        var start = Math.floor(rng() * (maxStart + 1));
        // partial Fisher–Yates: pick n distinct industries
        for (var p = 0; p < n; p++) {
          var j = p + Math.floor(rng() * (nInd - p));
          var tmp = idxPool[p]; idxPool[p] = idxPool[j]; idxPool[j] = tmp;
        }
        var gMult = 1, nMult = 1;
        for (var y = start; y < start + HORIZON; y++) {
          var sum = 0;
          for (var k = 0; k < n; k++) sum += D.returns[idxPool[k]][y];
          var r = sum / n;                 // equal-weight portfolio return (%)
          gMult *= (1 + r / 100);
          nMult *= (1 + (r - state.fee) / 100);
        }
        gross[t] = INITIAL * gMult;
        net[t]   = INITIAL * nMult;
      }
      gross.sort(function (x, z) { return x - z; });
      net.sort(function (x, z) { return x - z; });
      out.push({
        n: n,
        p5: pct(gross, 0.05), p25: pct(gross, 0.25), p50: pct(gross, 0.50),
        p75: pct(gross, 0.75), p95: pct(gross, 0.95), min: gross[0],
        netMed: pct(net, 0.50)
      });
    }
    return out;
  }

  // ---- chart -------------------------------------------------------------
  var W = 0, H = 0, M = { l: 64, r: 16, t: 24, b: 42 }, yMax = 1;
  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function xPx(n) { return M.l + ((n - 1) / (nInd - 1)) * (W - M.l - M.r); }
  function yPx(v) { return (H - M.b) - (v / yMax) * (H - M.b - M.t); }
  function usd(v) { return '$' + Math.round(v).toLocaleString('en-US'); }
  function usdK(v) { return v >= 1000 ? '$' + Math.round(v / 1000) + 'k' : '$' + Math.round(v); }

  function bandPath(arr, key) {
    ctx.beginPath();
    for (var i = 0; i < arr.length; i++) { var x = xPx(arr[i].n), y = yPx(arr[i][key]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
  }
  function fillBetween(arr, topKey, botKey, color) {
    ctx.beginPath();
    var i;
    for (i = 0; i < arr.length; i++) { var x = xPx(arr[i].n), y = yPx(arr[i][topKey]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    for (i = arr.length - 1; i >= 0; i--) ctx.lineTo(xPx(arr[i].n), yPx(arr[i][botKey]));
    ctx.closePath(); ctx.fillStyle = color; ctx.fill();
  }
  function lineOf(arr, key, color, width, dash) {
    ctx.setLineDash(dash || []);
    bandPath(arr, key);
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.setLineDash([]);
  }

  function draw() {
    if (!W || !H) resize();
    if (!W || !H || !sim) return;
    var c = palette();
    ctx.clearRect(0, 0, W, H);
    ctx.font = '12px "Source Sans 3", system-ui, sans-serif';

    // y gridlines + $ labels
    ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    for (var i = 0; i <= 4; i++) {
      var v = (yMax / 4) * i, gy = yPx(v);
      ctx.strokeStyle = c.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(M.l, gy); ctx.lineTo(W - M.r, gy); ctx.stroke();
      ctx.fillStyle = c.muted; ctx.fillText(usdK(v), M.l - 8, gy);
    }
    // x gridlines + labels (1,5,10,...,30)
    ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    var xt = [1, 5, 10, 15, 20, 25, 30];
    for (var k = 0; k < xt.length; k++) {
      var gx = xPx(xt[k]);
      ctx.fillStyle = c.muted; ctx.fillText(xt[k], gx, H - M.b + 7);
    }
    // initial-investment reference line
    var iy = yPx(INITIAL);
    ctx.setLineDash([4, 4]); ctx.strokeStyle = c.muted; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(M.l, iy); ctx.lineTo(W - M.r, iy); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = c.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText('$10,000 invested', M.l + 4, iy - 3);

    // axes
    ctx.strokeStyle = c.axis; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(M.l, M.t); ctx.lineTo(M.l, H - M.b); ctx.lineTo(W - M.r, H - M.b); ctx.stroke();
    ctx.fillStyle = c.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('Number of industries held', (M.l + (W - M.r)) / 2, H - 6);

    // gross spread funnel
    fillBetween(sim, 'p95', 'p5', c.band1);
    fillBetween(sim, 'p75', 'p25', c.band2);
    lineOf(sim, 'p50', c.accent, 2.4);
    // net-of-fee median (red) + red fill of the gap (fees eaten)
    fillBetween(sim, 'p50', 'netMed', c.feeFill);
    lineOf(sim, 'netMed', c.fee, 2.2, [5, 4]);

    // labels at the right edge
    var last = sim[sim.length - 1];
    ctx.font = '600 12px "Source Sans 3", system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    ctx.fillStyle = c.accent; ctx.fillText('median', W - M.r - 4, yPx(last.p50) - 10);
    ctx.fillStyle = c.fee;    ctx.fillText('after fees', W - M.r - 4, yPx(last.netMed) + 12);
  }

  // ---- recompute + readouts ---------------------------------------------
  function recompute() {
    sim = simulate();
    // y-axis: cover the widest gross band (N=1, p95) with headroom
    yMax = sim[0].p95 * 1.06;
    draw();
    var div = sim[sim.length - 1];   // fully diversified (all 30)
    var gain = div.p50 - INITIAL, net = div.netMed, lost = div.p50 - div.netMed;
    if (roGross) roGross.textContent = usd(div.p50);
    if (roNet) roNet.textContent = usd(net);
    if (roLost) roLost.textContent = usd(lost);
    if (roNote) {
      var pctLost = gain > 0 ? Math.round((lost / gain) * 100) : 0;
      roNote.textContent = 'Holding all 30 industries, a typical $10,000 grew to about ' + usd(div.p50)
        + ' over 10 years. A ' + state.fee.toFixed(1) + '% annual fee leaves you ' + usd(net) + ' — roughly '
        + usd(lost) + ', or ' + pctLost + '% of your gains, skimmed off by fees.';
    }
  }

  if (elFee) elFee.addEventListener('input', function () {
    state.fee = +elFee.value; if (elFeeVal) elFeeVal.textContent = state.fee.toFixed(1) + '%'; recompute();
  });
  if (btnShuffle) btnShuffle.addEventListener('click', function () { state.seed = (Math.random() * 1e9) | 0; recompute(); });
  if (btnReset) btnReset.addEventListener('click', function () {
    state.fee = DEF_FEE; state.seed = 12345;
    if (elFee) elFee.value = DEF_FEE; if (elFeeVal) elFeeVal.textContent = DEF_FEE.toFixed(1) + '%';
    recompute();
  });

  var mo = new MutationObserver(draw);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (window.matchMedia) { try { window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', draw); } catch (e) {} }
  var rt;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { resize(); draw(); }, 120); });

  resize();
  recompute();
})();
