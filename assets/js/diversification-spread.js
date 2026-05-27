/* ==========================================================================
   Diversification — "blend the lines" intro plot (sits ABOVE the funnel).
   --------------------------------------------------------------------------
   Goal: make the funnel below click. We plot the growth of $10,000 over the
   full 1995–2024 history (y = value, log scale; x = years held). The SHADED
   FAN is the variance of the blend itself for the current N — per-year 5–95 and
   25–75 percentiles of the equal-weight portfolio across many random N-subsets
   (recomputed when N changes). It is WIDE for small N and collapses to a single
   line at N = all (only one way to hold everything). The y-axis is fixed to the
   single-industry range so the fan visibly shrinks as you raise N. A slider sets
   N; every ~⅔ s we draw a fresh live sample (its faint member lines + bold blend)
   landing inside the fan. That narrowing fan is exactly what the funnel below
   summarizes (its bands use the same 5–95 / 25–75).

   Shares window.DIVERSIFICATION_DATA with the funnel. Original code, public
   data. Theme-aware; DPR-capped; pauses on hidden tab; honors reduced-motion.
   ========================================================================== */
(function () {
  var canvas = document.getElementById('div-spread-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  var D = window.DIVERSIFICATION_DATA;
  if (!D || !D.returns) return;

  function id(x) { return document.getElementById(x); }
  var elN = id('div-n'), elNv = id('div-n-val'), elNote = id('div-spread-note');
  var btnShuffle = id('div-spread-shuffle');

  var INITIAL = 10000, nInd = D.returns.length, nYr = D.years.length;
  var STEPS = nYr;                      // 30 returns -> 31 points (year 0..30)
  var CYCLE_MS = 650, FAN_SAMPLES = 320;
  var state = { N: 3, subset: [], fan: null };   // fan = per-year percentile band of the blend for this N
  var reduceMQ = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  function reduced() { return !!(reduceMQ && reduceMQ.matches); }

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
      band1:  light ? 'rgba(52,86,138,0.13)' : 'rgba(130,166,204,0.14)',   // 5–95 spread of the blend (matches funnel)
      band2:  light ? 'rgba(52,86,138,0.26)' : 'rgba(130,166,204,0.30)',   // 25–75
      single: light ? 'rgba(70,70,70,0.26)' : 'rgba(200,200,200,0.24)',    // faint member-industry lines
      panel:  light ? '#ffffff' : '#141414'
    };
  }

  // ---- precompute single-industry cumulative paths + static envelope -------
  var cum = [];                         // cum[i] = [v0..v30] for $10k buy-and-hold in industry i
  for (var i = 0; i < nInd; i++) {
    var arr = [INITIAL], v = INITIAL;
    for (var y = 0; y < nYr; y++) { v *= (1 + D.returns[i][y] / 100); arr.push(v); }
    cum.push(arr);
  }
  var envMin = [], envMax = [];
  for (var yy = 0; yy <= STEPS; yy++) {
    var mn = Infinity, mx = -Infinity;
    for (i = 0; i < nInd; i++) { var c0 = cum[i][yy]; if (c0 < mn) mn = c0; if (c0 > mx) mx = c0; }
    envMin.push(mn); envMax.push(mx);
  }
  var V_MIN = Infinity, V_MAX = -Infinity;
  for (yy = 0; yy <= STEPS; yy++) { if (envMin[yy] < V_MIN) V_MIN = envMin[yy]; if (envMax[yy] > V_MAX) V_MAX = envMax[yy]; }
  var L_MIN = Math.log(V_MIN * 0.9), L_MAX = Math.log(V_MAX * 1.06);

  function aggPath(subset) {
    var a = [INITIAL], val = INITIAL, n = subset.length;
    for (var y = 0; y < nYr; y++) {
      var sum = 0; for (var k = 0; k < n; k++) sum += D.returns[subset[k]][y];
      val *= (1 + (sum / n) / 100); a.push(val);
    }
    return a;
  }
  function pickSubset(N) {
    var pool = []; for (var a = 0; a < nInd; a++) pool.push(a);
    for (var p = 0; p < N; p++) { var j = p + Math.floor(Math.random() * (nInd - p)); var t = pool[p]; pool[p] = pool[j]; pool[j] = t; }
    return pool.slice(0, N);
  }
  // The variance of the BLEND for this N: sample many random N-subsets and take
  // per-year percentiles. Wide for small N, collapses to a line at N = all.
  function computeFan(N) {
    var y, m, f = { p5: [], p25: [], p50: [], p75: [], p95: [] };
    if (N >= nInd) {                                   // only one way to hold all → zero spread
      var all = []; for (var a = 0; a < nInd; a++) all.push(a);
      var path = aggPath(all);
      for (y = 0; y <= STEPS; y++) { var v = path[y]; f.p5.push(v); f.p25.push(v); f.p50.push(v); f.p75.push(v); f.p95.push(v); }
      return f;
    }
    var cols = []; for (y = 0; y <= STEPS; y++) cols.push(new Array(FAN_SAMPLES));
    for (m = 0; m < FAN_SAMPLES; m++) { var pth = aggPath(pickSubset(N)); for (y = 0; y <= STEPS; y++) cols[y][m] = pth[y]; }
    for (y = 0; y <= STEPS; y++) {
      cols[y].sort(function (q, z) { return q - z; });
      f.p5.push(pctOf(cols[y], 0.05)); f.p25.push(pctOf(cols[y], 0.25));
      f.p50.push(pctOf(cols[y], 0.50)); f.p75.push(pctOf(cols[y], 0.75)); f.p95.push(pctOf(cols[y], 0.95));
    }
    return f;
  }

  // ---- geometry ----------------------------------------------------------
  var W = 0, H = 0, M = { l: 58, r: 16, t: 16, b: 38 };
  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function xPx(yi) { return M.l + (yi / STEPS) * (W - M.l - M.r); }
  function yPx(val) { var f = (Math.log(val) - L_MIN) / (L_MAX - L_MIN); return (H - M.b) - f * (H - M.b - M.t); }
  function usdK(v) {
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(v < 1e7 ? 1 : 0) + 'M';
    if (v >= 1000) return '$' + Math.round(v / 1000) + 'k';
    return '$' + Math.round(v);
  }
  function usd(v) { return '$' + Math.round(v).toLocaleString('en-US'); }

  function strokePath(path, color, width, alpha) {
    ctx.globalAlpha = (alpha == null) ? 1 : alpha;
    ctx.beginPath();
    for (var k = 0; k < path.length; k++) { var x = xPx(k), y = yPx(path[k]); if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.globalAlpha = 1;
  }
  function fillBand(lo, hi, color) {
    ctx.beginPath();
    for (var i = 0; i <= STEPS; i++) { var x = xPx(i), y = yPx(hi[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    for (i = STEPS; i >= 0; i--) ctx.lineTo(xPx(i), yPx(lo[i]));
    ctx.closePath(); ctx.fillStyle = color; ctx.fill();
  }

  function draw() {
    if (!W || !H) resize();
    if (!W || !H) return;
    var c = palette();
    ctx.clearRect(0, 0, W, H);
    ctx.font = '12px "Source Sans 3", system-ui, sans-serif';

    // y gridlines + $ labels at nice log stops
    var stops = [2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000, 2000000, 5000000];
    ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    for (var gi = 0; gi < stops.length; gi++) {
      var sv = stops[gi]; if (sv < V_MIN * 0.9 || sv > V_MAX * 1.06) continue;
      var gy = yPx(sv);
      ctx.strokeStyle = c.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(M.l, gy); ctx.lineTo(W - M.r, gy); ctx.stroke();
      ctx.fillStyle = c.muted; ctx.fillText(usdK(sv), M.l - 8, gy);
    }
    // x gridlines + year labels
    ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    for (var xt = 0; xt <= STEPS; xt += 5) {
      var gx = xPx(xt);
      ctx.strokeStyle = c.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(gx, M.t); ctx.lineTo(gx, H - M.b); ctx.stroke();
      ctx.fillStyle = c.muted; ctx.fillText(xt, gx, H - M.b + 7);
    }

    // variance of the BLEND for this N — a fan that narrows as N grows
    if (state.fan) {
      fillBand(state.fan.p5, state.fan.p95, c.band1);
      fillBand(state.fan.p25, state.fan.p75, c.band2);
    }

    // $10k reference line
    var iy = yPx(INITIAL);
    ctx.setLineDash([4, 4]); ctx.strokeStyle = c.muted; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(M.l, iy); ctx.lineTo(W - M.r, iy); ctx.stroke(); ctx.setLineDash([]);

    // the N member industries in the current blend (faint), then the bold live blend sampling inside the fan
    for (var k = 0; k < state.subset.length; k++) strokePath(cum[state.subset[k]], c.single, 1, 0.85);
    if (state.subset.length) strokePath(aggPath(state.subset), c.accent, 2.8, 1);

    // axes
    ctx.strokeStyle = c.axis; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(M.l, M.t); ctx.lineTo(M.l, H - M.b); ctx.lineTo(W - M.r, H - M.b); ctx.stroke();
    ctx.fillStyle = c.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('Years held (1995–2024)', (M.l + (W - M.r)) / 2, H - 5);

    // corner labels
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = c.muted; ctx.font = '11px "Source Sans 3", system-ui, sans-serif';
    ctx.fillText('value of $10,000 — shaded band = where this blend could land', M.l + 4, M.t + 2);
    ctx.fillStyle = c.accent; ctx.font = '600 12px "Source Sans 3", system-ui, sans-serif';
    ctx.fillText('blend of ' + state.N + (state.N === 1 ? ' industry' : ' industries'), M.l + 4, M.t + 18);
  }

  function pctOf(sorted, q) { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]; }
  // note reads straight off the fan's final-year band (the shaded middle 90%)
  function updateNote() {
    if (!elNote || !state.fan) return;
    var lo = state.fan.p5[STEPS], hi = state.fan.p95[STEPS], word = state.N === 1 ? 'industry' : 'industries';
    elNote.innerHTML = 'Holding <strong>' + state.N + '</strong> ' + word
      + ', $10,000 over these 30 years lands somewhere in the shaded band &mdash; about <strong>' + usd(lo) + '</strong>–<strong>' + usd(hi)
      + '</strong> (middle 90%), depending on which ones you pick. Slide up and the band squeezes toward a single line: the variance falls while the typical outcome barely moves &mdash; the idea the chart below sums up.';
  }

  // ---- cycling -----------------------------------------------------------
  function reshuffle() {
    state.subset = pickSubset(state.N);   // a fresh live sample drawn inside the fan
    draw();
  }
  var timer = null;
  function startCycle() {
    if (reduced()) { if (!state.subset.length) reshuffle(); return; }
    if (timer || document.hidden) return;
    timer = setInterval(reshuffle, CYCLE_MS);
  }
  function stopCycle() { if (timer) { clearInterval(timer); timer = null; } }

  // ---- controls ----------------------------------------------------------
  if (elN) elN.addEventListener('input', function () {
    state.N = Math.max(1, Math.min(nInd, +elN.value));
    if (elNv) elNv.textContent = state.N;
    state.fan = computeFan(state.N);
    reshuffle(); updateNote();
  });
  if (btnShuffle) btnShuffle.addEventListener('click', reshuffle);

  var mo = new MutationObserver(draw);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (window.matchMedia) { try { window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', draw); } catch (e) {} }
  document.addEventListener('visibilitychange', function () { if (document.hidden) stopCycle(); else startCycle(); });
  var rt;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { resize(); draw(); }, 120); });

  // ---- init --------------------------------------------------------------
  if (elN) { elN.value = state.N; } if (elNv) elNv.textContent = state.N;
  state.fan = computeFan(state.N);
  resize();
  reshuffle();
  updateNote();
  startCycle();
})();
