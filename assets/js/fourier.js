/* ==========================================================================
   Fourier Drawing Machine — epicycles retrace what you draw.
   --------------------------------------------------------------------------
   Draw a stroke anywhere on the canvas. On release the path is resampled to
   256 points at uniform arc length (so fast, sparse strokes don't distort),
   treated as a complex sequence, and run through a direct DFT (O(n^2) is
   instant at n=256). Coefficients are sorted by magnitude, DC first, and a
   chain of rotating circles — one per kept coefficient — retraces the shape:
   each circle's center rides the tip of the one before it, and the final tip
   draws the reconstruction in the site accent while a grey ghost of the
   original sits underneath. A "Circles" slider sets how many terms to keep.

   Original code. Theme-aware via effectiveTheme() + MutationObserver +
   matchMedia; Pointer Events + touch-action:none; DPR capped at 2 with all
   math in CSS pixels; rAF pauses on hidden tabs; honors
   prefers-reduced-motion (starts paused on a static reconstruction).
   ========================================================================== */
(function () {
  var canvas = document.getElementById('fx-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  function id(x) { return document.getElementById(x); }

  var elTerms = id('fx-terms'), elTermsV = id('fx-terms-val');
  var elSpeed = id('fx-speed'), elSpeedV = id('fx-speed-val');
  var elPreset = id('fx-preset');
  var btnPause = id('fx-pause'), btnClear = id('fx-clear');
  var elPanel = id('fx-panel'), elCollapse = id('fx-collapse');
  var elReadout = id('fx-readout'), elHint = id('fx-hint');

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var NSAMP = 256;                 /* uniform arc-length samples per drawing */
  var PERIOD = 8;                  /* seconds per full loop at speed 1 */
  var TRAIL_LOOPS = 1.5;           /* how much of the trace lingers, in loops */
  var TRAIL_CAP = 6000;

  var W = 0, H = 0, dpr = 1, raf = null, lastT = 0;
  var terms = 40, speed = 1, paused = reduced;
  var ghostPts = null;             /* the resampled drawing (grey underlay) */
  var coeffs = null;               /* DFT terms: DC first, rest by |c| desc */
  var trail = [], phase = 0;       /* phase counts whole loops (monotonic) */
  var stroke = null, activePtr = null, backup = null;
  var userTouched = false, needsDraw = true;

  /* ---- theme ---- */
  function effectiveTheme() {
    var f = document.documentElement.getAttribute('data-theme');
    if (f === 'light' || f === 'dark') return f;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }
  function bg() { return effectiveTheme() === 'light' ? '#f3f5f8' : '#0e1014'; }
  function accent() { return effectiveTheme() === 'light' ? '#34568a' : '#82a6cc'; }
  function grey(a) {
    return effectiveTheme() === 'light' ? 'rgba(94,94,94,' + a + ')' : 'rgba(160,160,160,' + a + ')';
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function rel(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  /* ---- math ---- */
  /* Resample a closed polyline to n points at uniform arc length. The closing
     segment (last point back to first) is part of the path, so the seam is
     covered smoothly. Returns null for degenerate input. */
  function resample(pts, n) {
    var m = pts.length;
    if (m < 2) return null;
    var starts = [], total = 0, i;
    for (i = 0; i < m; i++) {
      starts.push(total);
      var a = pts[i], b = pts[(i + 1) % m];
      total += Math.hypot(b.x - a.x, b.y - a.y);
    }
    if (total < 1e-6) return null;
    var out = [], seg = 0;
    for (i = 0; i < n; i++) {
      var s = total * i / n;
      while (seg < m - 1 && starts[seg + 1] <= s) seg++;
      var p = pts[seg], q = pts[(seg + 1) % m];
      var len = Math.hypot(q.x - p.x, q.y - p.y);
      var f = len > 1e-9 ? (s - starts[seg]) / len : 0;
      out.push({ x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f });
    }
    return out;
  }

  /* Direct DFT of the point sequence as complex numbers (x + iy), normalized
     by 1/n. Frequencies are mapped to the signed range so terms rotate both
     ways. DC (the drawing's centroid) stays first; the rest are sorted by
     magnitude descending so the biggest circles come first. */
  function dft(pts) {
    var n = pts.length, out = [], TWO_PI = 2 * Math.PI;
    for (var k = 0; k < n; k++) {
      var re = 0, im = 0;
      for (var j = 0; j < n; j++) {
        var ang = -TWO_PI * k * j / n;
        var c = Math.cos(ang), s = Math.sin(ang);
        re += pts[j].x * c - pts[j].y * s;
        im += pts[j].x * s + pts[j].y * c;
      }
      re /= n; im /= n;
      out.push({ f: (k <= n / 2) ? k : k - n, re: re, im: im, amp: Math.hypot(re, im) });
    }
    var dc = out.shift();
    out.sort(function (a, b) { return b.amp - a.amp; });
    out.unshift(dc);
    return out;
  }

  /* Position of the epicycle tip at loop-fraction t using the first `nTerms`
     rotating circles (plus DC as the fixed center). */
  function reconPoint(t, nTerms) {
    var x = coeffs[0].re, y = coeffs[0].im;
    var count = Math.min(nTerms, coeffs.length - 1), TWO_PI = 2 * Math.PI;
    for (var i = 1; i <= count; i++) {
      var c = coeffs[i], ang = TWO_PI * c.f * t;
      var cs = Math.cos(ang), sn = Math.sin(ang);
      x += c.re * cs - c.im * sn;
      y += c.re * sn + c.im * cs;
    }
    return { x: x, y: y };
  }

  /* ---- building a machine from a path ---- */
  function setPath(pts, preTrace) {
    var rs = resample(pts, NSAMP);
    if (!rs) return false;
    ghostPts = rs;
    coeffs = dft(rs);
    trail.length = 0; phase = 0;
    if (preTrace) {
      /* arrive already traced: seed the trail with 1.5 loops of the curve */
      var steps = 480;
      for (var j = 0; j <= steps; j++) {
        var c = TRAIL_LOOPS * j / steps;
        var p = reconPoint(c % 1, terms);
        trail.push({ x: p.x, y: p.y, c: c });
      }
      phase = TRAIL_LOOPS;
    }
    needsDraw = true;
    return true;
  }

  /* ---- presets (point lists in arbitrary units; fitted to the viewport) ---- */
  /* Big Dipper: the seven stars of the asterism (from real RA/Dec, projected).
     Handle: Alkaid, Mizar, Alioth, Megrez; bowl: Megrez, Dubhe, Merak, Phecda.
     The handle is traced out and back so the auto-closed path stays on the
     constellation lines instead of cutting across. */
  var SHAPES = {
    dipper: [
      [0, 12.45], [3.02, 6.82], [7.28, 5.79], [12.51, 4.72],       /* handle out */
      [22.32, 0], [22.56, 5.37], [15.45, 8.06],                    /* around the bowl */
      [12.51, 4.72], [7.28, 5.79], [3.02, 6.82]                    /* handle back */
    ],
    star: (function () {
      var p = [];
      for (var i = 0; i < 10; i++) {
        var a = -Math.PI / 2 + i * Math.PI / 5, r = (i % 2 === 0) ? 1 : 0.42;
        p.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
      return p;
    })(),
    heart: (function () {
      /* the classic parametric heart, y flipped for canvas coordinates */
      var p = [];
      for (var i = 0; i < 128; i++) {
        var t = i / 128 * 2 * Math.PI, st = Math.sin(t);
        p.push([16 * st * st * st,
                -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))]);
      }
      return p;
    })()
  };

  function loadPreset(name) {
    var raw = SHAPES[name];
    if (!raw) return;
    if (!W || !H) { resize(); if (!W || !H) return; }
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, i;
    for (i = 0; i < raw.length; i++) {
      if (raw[i][0] < minX) minX = raw[i][0];
      if (raw[i][0] > maxX) maxX = raw[i][0];
      if (raw[i][1] < minY) minY = raw[i][1];
      if (raw[i][1] > maxY) maxY = raw[i][1];
    }
    var sw = Math.max(1e-6, maxX - minX), sh = Math.max(1e-6, maxY - minY);
    var scale = Math.min(0.6 * W / sw, 0.6 * H / sh);
    var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    var pts = [];
    for (i = 0; i < raw.length; i++) {
      pts.push({ x: W / 2 + (raw[i][0] - cx) * scale, y: H * 0.54 + (raw[i][1] - cy) * scale });
    }
    hideHint();
    setPath(pts, true);
  }

  /* ---- hint ---- */
  function hideHint() { if (elHint) elHint.classList.add('fx-hint--hidden'); }
  function showHint() { if (elHint) elHint.classList.remove('fx-hint--hidden'); }

  /* ---- drawing ---- */
  function polyline(pts, color, width, close) {
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (close) ctx.closePath();
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  }

  function drawTrail() {
    if (trail.length < 2) return;
    var col = accent();
    ctx.strokeStyle = col; ctx.lineWidth = 2;
    for (var i = 1; i < trail.length; i++) {
      var a = 0.9 * (1 - (phase - trail[i].c) / TRAIL_LOOPS);
      if (a <= 0) continue;
      ctx.beginPath();
      ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
      ctx.lineTo(trail[i].x, trail[i].y);
      ctx.globalAlpha = a;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /* the whole reconstructed loop at once — used for the paused / static view */
  function drawFullRecon() {
    var M = 512;
    ctx.beginPath();
    for (var i = 0; i <= M; i++) {
      var p = reconPoint((i % M) / M, terms);
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.globalAlpha = 0.85; ctx.strokeStyle = accent(); ctx.lineWidth = 2; ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /* the stacked circles at loop-fraction t; returns the tip */
  function drawSkeleton(t) {
    var x = coeffs[0].re, y = coeffs[0].im;
    var count = Math.min(terms, coeffs.length - 1), TWO_PI = 2 * Math.PI;
    var circCol = grey(0.28), radCol = grey(0.5);
    for (var i = 1; i <= count; i++) {
      var c = coeffs[i], ang = TWO_PI * c.f * t;
      var cs = Math.cos(ang), sn = Math.sin(ang);
      var nx = x + c.re * cs - c.im * sn;
      var ny = y + c.re * sn + c.im * cs;
      if (c.amp > 0.6) {
        ctx.beginPath(); ctx.arc(x, y, c.amp, 0, 6.2832);
        ctx.strokeStyle = circCol; ctx.lineWidth = 1; ctx.stroke();
      }
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(nx, ny);
      ctx.strokeStyle = radCol; ctx.lineWidth = 1; ctx.stroke();
      x = nx; y = ny;
    }
    return { x: x, y: y };
  }

  function draw() {
    if (!W || !H) { resize(); if (!W || !H) return; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = bg(); ctx.fillRect(0, 0, W, H);
    if (stroke) {                      /* live stroke while the pointer is down */
      polyline(stroke, grey(0.7), 2, false);
      return;
    }
    if (ghostPts) polyline(ghostPts, grey(0.3), 1.5, true);
    if (coeffs) {
      if (paused && trail.length === 0) drawFullRecon();
      else drawTrail();
      var tip = drawSkeleton(phase % 1);
      ctx.beginPath(); ctx.arc(tip.x, tip.y, 3.5, 0, 6.2832);
      ctx.fillStyle = accent(); ctx.fill();
    }
  }

  function loop(t) {
    raf = requestAnimationFrame(loop);
    var dt = Math.min(0.05, (t - lastT) / 1000 || 0);
    lastT = t;
    if (!paused && coeffs && !stroke && speed > 0) {
      phase += dt * speed / PERIOD;
      var p = reconPoint(phase % 1, terms);
      var last = trail[trail.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.5) {
        trail.push({ x: p.x, y: p.y, c: phase });
      }
      while (trail.length && phase - trail[0].c > TRAIL_LOOPS) trail.shift();
      if (trail.length > TRAIL_CAP) trail.splice(0, trail.length - TRAIL_CAP);
      needsDraw = true;
    }
    if (needsDraw) { draw(); needsDraw = false; }
  }
  function start() { if (!raf) { lastT = 0; raf = requestAnimationFrame(loop); } }

  /* ---- draw a stroke ---- */
  canvas.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    userTouched = true; hideHint();
    if (activePtr !== null) return;
    activePtr = e.pointerId;
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    /* keep what was on screen in case this turns out to be a stray tap */
    backup = { ghost: ghostPts, coeffs: coeffs, phase: phase, trail: trail.slice() };
    stroke = [rel(e)];
    ghostPts = null; coeffs = null; trail.length = 0;
    needsDraw = true;
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', function (e) {
    if (activePtr === null || e.pointerId !== activePtr || !stroke) return;
    var p = rel(e), last = stroke[stroke.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) >= 1.5) { stroke.push(p); needsDraw = true; }
  });
  function endStroke(e) {
    if (activePtr === null || e.pointerId !== activePtr) return;
    activePtr = null;
    var s = stroke; stroke = null;
    var len = 0;
    if (s) for (var i = 1; i < s.length; i++) len += Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y);
    if (s && s.length > 2 && len > 12 && setPath(s, false)) {
      if (elPreset) elPreset.value = '';
      backup = null;
    } else if (backup) {
      ghostPts = backup.ghost; coeffs = backup.coeffs;
      phase = backup.phase; trail = backup.trail;
      backup = null;
      if (!coeffs && !ghostPts) showHint();
    } else if (!coeffs) {
      showHint();
    }
    needsDraw = true;
  }
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);

  /* ---- controls ---- */
  function updateReadout() {
    if (elTermsV) elTermsV.textContent = String(terms);
    if (elReadout) elReadout.textContent = terms + ' circles approximate your drawing';
  }
  if (elTerms) elTerms.addEventListener('input', function () {
    terms = Math.max(1, Math.round(+elTerms.value) || 1);
    /* while paused, show the static reconstruction at the new term count */
    if (paused) trail.length = 0;
    updateReadout(); needsDraw = true;
  });
  if (elSpeed) elSpeed.addEventListener('input', function () {
    speed = +elSpeed.value;
    if (elSpeedV) elSpeedV.textContent = speed.toFixed(2) + '×';
  });
  if (btnPause) btnPause.addEventListener('click', function () {
    paused = !paused;
    btnPause.textContent = paused ? 'Resume' : 'Pause';
    needsDraw = true;
  });
  if (btnClear) btnClear.addEventListener('click', function () {
    userTouched = true;
    ghostPts = null; coeffs = null; trail.length = 0;
    stroke = null; activePtr = null; backup = null; phase = 0;
    if (elPreset) elPreset.value = '';
    showHint(); needsDraw = true;
  });
  if (elPreset) elPreset.addEventListener('change', function () {
    userTouched = true;
    if (elPreset.value) loadPreset(elPreset.value);
  });

  /* collapse / expand the controls (starts collapsed on small screens) */
  if (elCollapse && elPanel) {
    var setCollapsed = function (c) {
      elPanel.classList.toggle('fx-panel--collapsed', c);
      elCollapse.textContent = c ? '+' : '–';
      elCollapse.setAttribute('aria-label', c ? 'Show controls' : 'Hide controls');
    };
    elCollapse.addEventListener('click', function () {
      setCollapsed(!elPanel.classList.contains('fx-panel--collapsed'));
    });
    if (window.innerWidth < 600) setCollapsed(true);
  }

  /* ---- theme + lifecycle ---- */
  if (window.MutationObserver) {
    new MutationObserver(function () { needsDraw = true; })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: light)');
    var onmq = function () { needsDraw = true; };
    if (mq.addEventListener) mq.addEventListener('change', onmq);
    else if (mq.addListener) mq.addListener(onmq);
  }
  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { resize(); needsDraw = true; }, 150);
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (raf) { cancelAnimationFrame(raf); raf = null; } }
    else start();
  });

  /* if the visitor hasn't drawn after a couple of seconds, trace the Big
     Dipper so the page is alive immediately */
  setTimeout(function () {
    if (!userTouched && !coeffs && !stroke) {
      loadPreset('dipper');
      if (elPreset) elPreset.value = 'dipper';
    }
  }, 2000);

  if (btnPause && paused) btnPause.textContent = 'Resume';
  if (elSpeedV) elSpeedV.textContent = speed.toFixed(2) + '×';
  updateReadout();
  resize();
  start();
})();
