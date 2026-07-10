/* ==========================================================================
   Epidemic — a stochastic SIR outbreak on a grid you can poke.
   --------------------------------------------------------------------------
   Every pixel-cell is a person: Susceptible (faint), Infected (warm red — the
   reserved "bad" color), or Recovered/immune (site accent). Each step, every
   infected cell tries to infect each susceptible neighbor (8-neighborhood)
   with the Transmission probability, and recovers after "days infectious"
   steps. Click / drag anywhere to start infections. A live epidemic curve
   (infected per day) draws along the bottom — the curve everyone was trying
   to flatten.

   The Vaccinated slider pre-immunizes that share of the grid (applied on
   Restart): push it up and watch outbreaks sputter out before reaching most
   people — herd immunity, visible. Original code; theme-aware; budget-driven
   grid; Pointer Events + touch-action:none; pauses on hidden tabs; honors
   prefers-reduced-motion (starts paused).
   ========================================================================== */
(function () {
  var canvas = document.getElementById('epi-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  function id(x) { return document.getElementById(x); }

  var elTrans = id('epi-trans'), elTransV = id('epi-trans-val');
  var elDur = id('epi-dur'), elDurV = id('epi-dur-val');
  var elVax = id('epi-vax'), elVaxV = id('epi-vax-val');
  var btnPause = id('epi-pause'), btnRestart = id('epi-restart');
  var elPanel = id('epi-panel'), elCollapse = id('epi-collapse');
  var status = id('epi-status');

  var MAX_CELLS = 60000, CELL_FLOOR = 6;
  var STEP_MS = 95;                 // one "day" per step
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var pTrans = 0.10, durDays = 10, vaxPct = 0;
  var cols = 0, rows = 0, cell = CELL_FLOOR;
  var grid = null;                  // Int16: 0=S, -1=R, -2=V, >0 infected days left
  var W = 0, H = 0, dpr = 1, raf = null, lastStep = 0;
  var paused = reduced, over = false;
  var counts = { s: 0, i: 0, r: 0, v: 0 };
  var history = [];                 // infected count per day, for the curve
  var HIST_MAX = 480;
  var painting = null;             // {erase} while a pointer is down
  var paintMode = 'infect';        // what a left-drag does: 'infect' | 'vaccinate'

  function effectiveTheme() {
    var f = document.documentElement.getAttribute('data-theme');
    if (f === 'light' || f === 'dark') return f;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }
  function bg() { return effectiveTheme() === 'light' ? '#f3f5f8' : '#101216'; }
  function cInfected() { return '#c4574a'; }                       // reserved warm red = harm
  function cRecovered() { return effectiveTheme() === 'light' ? 'rgba(52,86,138,0.55)' : 'rgba(130,166,204,0.50)'; }
  function cVax() { return effectiveTheme() === 'light' ? 'rgba(52,86,138,0.22)' : 'rgba(130,166,204,0.20)'; }
  function cSus() { return 'rgba(127,127,127,0.10)'; }
  function textColor(a) { return effectiveTheme() === 'light' ? 'rgba(38,38,38,' + a + ')' : 'rgba(214,214,214,' + a + ')'; }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function initGrid() {
    cell = CELL_FLOOR;
    while (Math.ceil(W / cell) * Math.ceil(H / cell) > MAX_CELLS) cell++;
    cols = Math.ceil(W / cell); rows = Math.ceil(H / cell);
    grid = new Int16Array(cols * rows);
    var n = cols * rows, vaxN = Math.round(n * vaxPct / 100);
    for (var k = 0; k < vaxN; k++) {                 // sprinkle the vaccinated randomly
      var i = Math.floor(Math.random() * n);
      if (grid[i] === 0) grid[i] = -2; else k--;
    }
    // seed one infection in the middle so something happens immediately
    var c0 = Math.floor(rows / 2) * cols + Math.floor(cols / 2);
    grid[c0] = durDays;
    history = [];
    over = false;
  }

  function stepSim() {
    var c = cols, r = rows, i, x, y;
    var newly = [];
    for (y = 0; y < r; y++) {
      for (x = 0; x < c; x++) {
        i = y * c + x;
        var v = grid[i];
        if (v <= 0) continue;                        // only infected cells act
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            var nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= c || ny >= r) continue;
            var ni = ny * c + nx;
            if (grid[ni] === 0 && Math.random() < pTrans) newly.push(ni);
          }
        }
        grid[i] = (v === 1) ? -1 : v - 1;            // last infectious day → recovered
      }
    }
    for (i = 0; i < newly.length; i++) if (grid[newly[i]] === 0) grid[newly[i]] = durDays;
    recount();
    history.push(counts.i);
    if (history.length > HIST_MAX) history.shift();
    if (counts.i === 0) over = true;
  }

  function recount() {
    var s = 0, inf = 0, rec = 0, vax = 0;
    for (var i = 0; i < grid.length; i++) {
      var v = grid[i];
      if (v === 0) s++; else if (v === -1) rec++; else if (v === -2) vax++; else inf++;
    }
    counts = { s: s, i: inf, r: rec, v: vax };
  }

  function draw() {
    if (!W || !H) { resize(); if (!W || !H) return; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = bg(); ctx.fillRect(0, 0, W, H);
    var i, x, y;

    ctx.fillStyle = cSus(); ctx.fillRect(0, 0, cols * cell, rows * cell);
    for (y = 0; y < rows; y++) {
      for (x = 0; x < cols; x++) {
        var v = grid[y * cols + x];
        if (v === 0) continue;
        if (v > 0) ctx.fillStyle = cInfected();
        else if (v === -1) ctx.fillStyle = cRecovered();
        else ctx.fillStyle = cVax();
        ctx.fillRect(x * cell, y * cell, cell - 1, cell - 1);
      }
    }

    /* the epidemic curve: infected per day, along the bottom */
    if (history.length > 1) {
      var ch = Math.min(110, H * 0.16), cb = H - 14;
      var peak = 1;
      for (i = 0; i < history.length; i++) if (history[i] > peak) peak = history[i];
      var dxs = Math.min(4, (W - 30) / history.length);
      ctx.beginPath();
      ctx.moveTo(15, cb);
      for (i = 0; i < history.length; i++) ctx.lineTo(15 + i * dxs, cb - (history[i] / peak) * ch);
      ctx.lineTo(15 + (history.length - 1) * dxs, cb);
      ctx.closePath();
      ctx.fillStyle = 'rgba(196,87,74,0.30)'; ctx.fill();
      ctx.beginPath();
      for (i = 0; i < history.length; i++) {
        var px = 15 + i * dxs, py = cb - (history[i] / peak) * ch;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = cInfected(); ctx.lineWidth = 1.5; ctx.stroke();
      ctx.font = '12px "Source Sans 3", system-ui, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillStyle = textColor(0.55);
      ctx.fillText('infected over time →', 15, cb - ch - 4);
    }

    if (status) {
      var n = cols * rows;
      var everPct = (((counts.r + counts.i) / Math.max(1, n - counts.v)) * 100).toFixed(0);
      status.textContent = over
        ? 'Outbreak over — ' + everPct + '% of the unvaccinated ever infected. Click to reignite.'
        : counts.i + ' infected · ' + counts.r + ' recovered · ' + counts.s + ' susceptible';
    }
  }

  function loop(t) {
    raf = requestAnimationFrame(loop);
    if (!paused && !over && t - lastStep >= STEP_MS) {
      lastStep = t;
      stepSim();
    }
    draw();
  }
  function start() { if (!raf) raf = requestAnimationFrame(loop); }

  /* ---- click / drag to paint (infect, vaccinate, or right-drag to clear) ---- */
  function paintAt(clientX, clientY, erase) {
    var doErase = erase || paintMode === 'erase';    // right-drag always erases; the Erase mode makes left-drag/touch erase too
    var r = canvas.getBoundingClientRect();
    var cx = Math.floor((clientX - r.left) / cell), cy = Math.floor((clientY - r.top) / cell);
    var rad = (paintMode !== 'infect' || doErase) ? 2 : 1;    // a bigger brush for painting regions
    for (var dy = -rad; dy <= rad; dy++) {
      for (var dx = -rad; dx <= rad; dx++) {
        var x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
        var i = y * cols + x, v = grid[i];
        if (doErase) { grid[i] = 0; }                // back to plain susceptible
        else if (paintMode === 'vaccinate') { if (v === 0) grid[i] = -2; }
        else { if (v === 0) grid[i] = durDays; }     // infect (only susceptible cells)
      }
    }
    over = false;
  }
  canvas.addEventListener('pointerdown', function (e) {
    painting = { erase: e.button === 2 };
    paintAt(e.clientX, e.clientY, painting.erase);
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', function (e) { if (painting) paintAt(e.clientX, e.clientY, painting.erase); });
  canvas.addEventListener('pointerup', function () { painting = null; });
  canvas.addEventListener('pointercancel', function () { painting = null; });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  /* Bring the live vaccinated count to a target fraction of the whole grid, by
     flipping random susceptible<->vaccinated cells. Lets the slider work mid-run. */
  function applyVaxLive(targetPct) {
    var n = grid.length, want = Math.round(n * targetPct / 100);
    var sIdx = [], vIdx = [], i;
    for (i = 0; i < n; i++) { if (grid[i] === 0) sIdx.push(i); else if (grid[i] === -2) vIdx.push(i); }
    var diff = want - vIdx.length;
    if (diff > 0) {                                  // vaccinate random susceptibles
      for (i = 0; i < diff && sIdx.length; i++) {
        var k = Math.floor(Math.random() * sIdx.length);
        grid[sIdx[k]] = -2; sIdx.splice(k, 1);
      }
    } else if (diff < 0) {                           // un-vaccinate random vaccinated
      for (i = 0; i < -diff && vIdx.length; i++) {
        var j = Math.floor(Math.random() * vIdx.length);
        grid[vIdx[j]] = 0; vIdx.splice(j, 1);
      }
    }
    recount();
  }

  /* Rough R0 from the model's REAL parameters. Each infected cell has 8 fixed
     grid neighbors, and a given susceptible neighbor is EVENTUALLY infected
     with probability 1 − (1−p)^days (the daily trials saturate — a naive
     p × 8 × days would badly overcount, since a neighbor can only be
     infected once). "Rough" because edge cells have fewer neighbors and
     neighbors are shared with other infected cells. */
  var elR0 = id('epi-r0');
  function updateR0() {
    if (!elR0) return;
    var per = 1 - Math.pow(1 - pTrans, durDays);
    elR0.textContent = 'Rough R₀ ≈ 8 neighbors × ' + per.toFixed(2) + ' chance each ≈ ' + (8 * per).toFixed(1);
  }

  /* ---- controls ---- */
  if (elTrans) elTrans.addEventListener('input', function () { pTrans = +elTrans.value / 100; if (elTransV) elTransV.textContent = elTrans.value + '%'; updateR0(); });
  if (elDur) elDur.addEventListener('input', function () { durDays = +elDur.value; if (elDurV) elDurV.textContent = elDur.value; updateR0(); });
  if (elVax) elVax.addEventListener('input', function () { vaxPct = +elVax.value; if (elVaxV) elVaxV.textContent = elVax.value + '%'; applyVaxLive(vaxPct); });
  var modeBtns = document.querySelectorAll('.epi-mode');
  Array.prototype.forEach.call(modeBtns, function (b) {
    b.addEventListener('click', function () {
      paintMode = b.getAttribute('data-mode');
      Array.prototype.forEach.call(modeBtns, function (o) { o.classList.toggle('epi-mode--on', o === b); });
    });
  });
  function togglePause() { paused = !paused; if (btnPause) btnPause.textContent = paused ? 'Play' : 'Pause'; }
  function restart() { initGrid(); recount(); }
  if (btnPause) btnPause.addEventListener('click', togglePause);
  if (btnRestart) btnRestart.addEventListener('click', restart);

  /* ---- share link + PNG snapshot (shared codec in share-hash.js) ----
     The grid is randomly seeded on restart, so sharing the PARAMETERS is the
     whole state: restoring applies the sliders and then restarts. */
  var SH = window.ShareHash;
  var btnShare = id('epi-share'), btnSnap = id('epi-snap');
  function shareState() { return { t: Math.round(pTrans * 100), d: durDays, v: vaxPct }; }
  function applyShared() {
    var d = SH.decode(SH.readHash());
    if (!d || d.version !== 1) return false;
    var o = d.obj;
    pTrans = SH.int(o.t, 1, 50, 10) / 100;
    durDays = SH.int(o.d, 2, 30, 10);
    vaxPct = SH.int(o.v, 0, 95, 0);
    if (elTrans) { elTrans.value = Math.round(pTrans * 100); if (elTransV) elTransV.textContent = Math.round(pTrans * 100) + '%'; }
    if (elDur) { elDur.value = durDays; if (elDurV) elDurV.textContent = String(durDays); }
    if (elVax) { elVax.value = vaxPct; if (elVaxV) elVaxV.textContent = vaxPct + '%'; }
    return true;
  }
  if (btnShare && SH) btnShare.addEventListener('click', function () {
    SH.copyLink(btnShare, SH.encode(1, shareState()));
  });
  if (btnSnap && SH) btnSnap.addEventListener('click', function () {
    draw();
    SH.savePng(canvas, {
      label: 'Epidemic', file: 'epidemic.png',
      light: effectiveTheme() === 'light', bg: bg()
    });
  });

  /* panel collapse + first-run hint (shared helper) */
  if (window.GadgetUI) {
    var hint = GadgetUI.firstRunHint('epidemic', 'Click or drag to infect.');
    GadgetUI.initPanel({
      panel: elPanel, toggle: elCollapse,
      collapsedClass: 'epi-panel--collapsed',
      help: id('epi-help'), hint: hint
    });
    /* touch parity: press and hold, then drag, to erase (right-drag on a mouse) */
    GadgetUI.longPress(canvas, function (pt) {
      if (!painting) return;
      painting.erase = true;
      paintAt(pt.clientX, pt.clientY, true);
    });
  }

  /* keyboard: Space = pause/resume, R = restart (ignored while typing) */
  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (window.GadgetUI && GadgetUI.isTyping(e)) return;
    if (e.key === ' ') {
      /* a focused button already activates on Space — don't double-toggle */
      if (e.target && (e.target.tagName || '').toLowerCase() === 'button') return;
      e.preventDefault(); togglePause();
    }
    else if (e.key === 'r' || e.key === 'R') restart();
  });

  if (btnPause && paused) btnPause.textContent = 'Play';

  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () {
      resize();
      /* only rebuild (losing the outbreak) if the grid dimensions actually changed —
         mobile fires resize on URL-bar show/hide and on-screen keyboard */
      var c = CELL_FLOOR;
      while (Math.ceil(W / c) * Math.ceil(H / c) > MAX_CELLS) c++;
      if (Math.ceil(W / c) !== cols || Math.ceil(H / c) !== rows) { initGrid(); recount(); }
    }, 150);
  });
  document.addEventListener('visibilitychange', function () { if (document.hidden) { if (raf) { cancelAnimationFrame(raf); raf = null; } } else start(); });

  resize();
  if (SH) applyShared();   // shared parameters in the URL apply before the first seed
  initGrid();
  recount();
  updateR0();
  start();
})();
