/* ==========================================================================
   Double Pendulum — chaos you can grab.
   --------------------------------------------------------------------------
   A classic double pendulum (two equal masses, two equal rods) integrated
   with RK4 on the standard textbook equations of motion. The headline trick:
   a "twin" pendulum started just 0.001 radians away, drawn in grey, with the
   real one in the site accent. The two tip-paths stay together for a few
   swings and then diverge completely — sensitive dependence on initial
   conditions in one image. A status line reports how long that took.

   Drag either bob to repose the pendulum (it freezes while held; release to
   let it swing — the twin re-syncs to the new pose + the tiny offset).
   Original code; the physics is public-domain. Theme-aware; Pointer Events +
   touch-action:none; pauses on hidden tabs; honors prefers-reduced-motion
   (starts paused).
   ========================================================================== */
(function () {
  var canvas = document.getElementById('pend-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  function id(x) { return document.getElementById(x); }

  var elSpeed = id('pend-speed'), elSpeedV = id('pend-speed-val');
  var elTwin = id('pend-twin'), elTrails = id('pend-trails');
  var btnPause = id('pend-pause'), btnReset = id('pend-reset');
  var elPanel = id('pend-panel'), elCollapse = id('pend-collapse');
  var status = id('pend-status');

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var W = 0, H = 0, dpr = 1, raf = null, lastT = 0;
  var speed = 1, showTwin = true, trails = true, paused = reduced;
  var GRAV = 9.81, SUB = 1 / 240;          // physics in unit lengths; rendering scales to px
  var EPS = 0.001;                          // the twin's initial offset (radians)
  var TRAIL_MAX = 900, DIVERGE_PX = 40;

  // state vectors [th1, w1, th2, w2]; lengths/masses equal (1, 1)
  var main = [2.1, 0, 2.5, 0];
  var twin = [2.1 + EPS, 0, 2.5, 0];
  var trailA = [], trailB = [];
  var runTime = 0, divergedAt = -1;
  var divHist = [];                         // {t, d} tip-separation over time (the divergence plot)
  var DIVHIST_MAX = 1400;
  var drag = null;                          // {bob: 1|2}

  function effectiveTheme() {
    var f = document.documentElement.getAttribute('data-theme');
    if (f === 'light' || f === 'dark') return f;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }
  function bg() { return effectiveTheme() === 'light' ? '#f3f5f8' : '#0e1014'; }
  function accent() { return effectiveTheme() === 'light' ? '#34568a' : '#82a6cc'; }
  function greyColor() { return effectiveTheme() === 'light' ? 'rgba(94,94,94,0.85)' : 'rgba(160,160,160,0.85)'; }
  function textColor(a) { return effectiveTheme() === 'light' ? 'rgba(38,38,38,' + a + ')' : 'rgba(214,214,214,' + a + ')'; }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function anchor() { return { x: W / 2, y: H * 0.34 }; }
  function rodLen() { return Math.min(W, H) * 0.16; }     // px per unit rod

  // standard equal-mass, equal-length double-pendulum accelerations
  function deriv(s) {
    var t1 = s[0], w1 = s[1], t2 = s[2], w2 = s[3];
    var d = t1 - t2, cd = Math.cos(d), sd = Math.sin(d);
    var den = 3 - Math.cos(2 * d);          // 2*m1 + m2 - m2*cos(2Δ) with m1=m2=1
    var a1 = (-3 * GRAV * Math.sin(t1) - GRAV * Math.sin(t1 - 2 * t2) - 2 * sd * (w2 * w2 + w1 * w1 * cd)) / den;
    var a2 = (2 * sd * (2 * w1 * w1 + 2 * GRAV * Math.cos(t1) + w2 * w2 * cd)) / den;
    return [w1, a1, w2, a2];
  }
  function rk4(s, h) {
    var k1 = deriv(s);
    var k2 = deriv([s[0] + k1[0] * h / 2, s[1] + k1[1] * h / 2, s[2] + k1[2] * h / 2, s[3] + k1[3] * h / 2]);
    var k3 = deriv([s[0] + k2[0] * h / 2, s[1] + k2[1] * h / 2, s[2] + k2[2] * h / 2, s[3] + k2[3] * h / 2]);
    var k4 = deriv([s[0] + k3[0] * h, s[1] + k3[1] * h, s[2] + k3[2] * h, s[3] + k3[3] * h]);
    for (var i = 0; i < 4; i++) s[i] += h / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  }

  function tip(s) {
    var a = anchor(), L = rodLen();
    var x1 = a.x + Math.sin(s[0]) * L, y1 = a.y + Math.cos(s[0]) * L;
    return { x1: x1, y1: y1, x2: x1 + Math.sin(s[2]) * L, y2: y1 + Math.cos(s[2]) * L };
  }

  function resetTimers() {
    runTime = 0; divergedAt = -1;
    trailA.length = 0; trailB.length = 0;
    divHist.length = 0;
  }
  function syncTwin() {
    twin[0] = main[0] + EPS; twin[1] = main[1];
    twin[2] = main[2]; twin[3] = main[3];
    resetTimers();
  }
  function reset() {
    main = [2.1, 0, 2.5, 0];
    syncTwin();
  }

  function physics(dt) {
    var steps = Math.min(40, Math.max(1, Math.round(dt * speed / SUB)));
    for (var i = 0; i < steps; i++) {
      rk4(main, SUB);
      if (showTwin) rk4(twin, SUB);
      runTime += SUB;
    }
    var p = tip(main);
    trailA.push([p.x2, p.y2]); if (trailA.length > TRAIL_MAX) trailA.shift();
    if (showTwin) {
      var q = tip(twin);
      trailB.push([q.x2, q.y2]); if (trailB.length > TRAIL_MAX) trailB.shift();
      var sep = Math.hypot(p.x2 - q.x2, p.y2 - q.y2);
      if (divergedAt < 0 && sep > DIVERGE_PX) divergedAt = runTime;
      divHist.push([runTime, sep]); if (divHist.length > DIVHIST_MAX) divHist.shift();
    }
  }

  function drawTrail(t, color) {
    if (t.length < 2) return;
    for (var i = 1; i < t.length; i++) {
      ctx.beginPath();
      ctx.moveTo(t[i - 1][0], t[i - 1][1]); ctx.lineTo(t[i][0], t[i][1]);
      ctx.globalAlpha = 0.55 * (i / t.length);
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  function drawPend(s, color, faint) {
    var a = anchor(), p = tip(s);
    ctx.globalAlpha = faint ? 0.55 : 1;
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(p.x1, p.y1); ctx.lineTo(p.x2, p.y2); ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(p.x1, p.y1, 9, 0, 6.2832); ctx.fill();
    ctx.beginPath(); ctx.arc(p.x2, p.y2, 11, 0, 6.2832); ctx.fill();
    ctx.globalAlpha = 1;
  }

  // The separation-vs-time plot along the bottom. On a linear axis the tip gap
  // sits near zero, then shoots up to the saturation value at a different moment
  // each run — the visible "boom" of sensitive dependence on initial conditions.
  function drawDivergence() {
    if (divHist.length < 2) return;
    /* sit the plot ABOVE the bottom chrome: the chat bar/back button/theme toggle
       live at the very bottom (and the chat bar is full-width on mobile), so reserve
       more room there. Still spans most of the width. */
    var reserve = (W < 768) ? 122 : 92;
    var ph = Math.min(82, H * 0.12), pb = H - reserve;
    var x0 = (W < 768) ? 16 : 46, x1 = W - x0;
    var tEnd = divHist[divHist.length - 1][0], tSpan = Math.max(6, tEnd);
    var cap = rodLen() * 3.4;                 // max meaningful tip separation (~ full swing apart)
    function px(t) { return x0 + (x1 - x0) * (t / tSpan); }
    function py(d) { return pb - ph * Math.min(1, d / cap); }
    ctx.strokeStyle = 'rgba(127,127,127,0.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, pb); ctx.lineTo(x1, pb); ctx.stroke();
    if (divergedAt > 0) {                      // mark the moment the twins "split"
      var mx = px(divergedAt);
      ctx.strokeStyle = 'rgba(127,127,127,0.5)'; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(mx, pb); ctx.lineTo(mx, pb - ph); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.beginPath();
    for (var i = 0; i < divHist.length; i++) {
      var x = px(divHist[i][0]), y = py(divHist[i][1]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = accent(); ctx.lineWidth = 1.6; ctx.stroke();
    ctx.font = '12px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = textColor(0.5);
    ctx.fillText('how far apart the two tips are, over time', x0, pb - ph - 4);
  }

  function draw() {
    if (!W || !H) { resize(); if (!W || !H) return; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = bg(); ctx.fillRect(0, 0, W, H);
    var a = anchor();
    ctx.fillStyle = 'rgba(127,127,127,0.6)';
    ctx.beginPath(); ctx.arc(a.x, a.y, 4, 0, 6.2832); ctx.fill();
    if (trails) {
      if (showTwin) drawTrail(trailB, greyColor());
      drawTrail(trailA, accent());
    }
    if (showTwin) drawPend(twin, greyColor(), true);
    drawPend(main, accent(), false);
    if (showTwin) drawDivergence();
    if (status) {
      if (!showTwin) status.textContent = 't = ' + runTime.toFixed(1) + ' s';
      else if (divergedAt < 0) status.textContent = 't = ' + runTime.toFixed(1) + ' s — twins still together (offset 0.001 rad)';
      else status.textContent = 'twins diverged after ' + divergedAt.toFixed(1) + ' s';
    }
  }

  function loop(t) {
    raf = requestAnimationFrame(loop);
    var dt = Math.min(0.05, (t - lastT) / 1000 || 0);
    lastT = t;
    if (!paused && !drag && speed > 0) physics(dt);
    draw();
  }
  function start() { if (!raf) { lastT = 0; raf = requestAnimationFrame(loop); } }

  /* ---- drag a bob to repose ---- */
  function rel(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  canvas.addEventListener('pointerdown', function (e) {
    var p = rel(e), t = tip(main);
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    if (Math.hypot(p.x - t.x2, p.y - t.y2) < 26) drag = { bob: 2 };
    else if (Math.hypot(p.x - t.x1, p.y - t.y1) < 24) drag = { bob: 1 };
    else return;
    main[1] = 0; main[3] = 0;
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var p = rel(e), a = anchor(), t = tip(main);
    if (drag.bob === 1) main[0] = Math.atan2(p.x - a.x, p.y - a.y);
    else main[2] = Math.atan2(p.x - t.x1, p.y - t.y1);
    main[1] = 0; main[3] = 0;
  });
  function endDrag() { if (drag) { drag = null; syncTwin(); } }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  /* ---- controls ---- */
  if (elSpeed) elSpeed.addEventListener('input', function () { speed = +elSpeed.value; if (elSpeedV) elSpeedV.textContent = speed.toFixed(2) + '×'; });
  if (elTwin) elTwin.addEventListener('change', function () { showTwin = elTwin.checked; syncTwin(); });
  if (elTrails) elTrails.addEventListener('change', function () { trails = elTrails.checked; if (!trails) { trailA.length = 0; trailB.length = 0; } });
  if (btnPause) btnPause.addEventListener('click', function () { paused = !paused; btnPause.textContent = paused ? 'Play' : 'Pause'; });
  if (btnReset) btnReset.addEventListener('click', reset);
  if (elCollapse && elPanel) {
    elCollapse.addEventListener('click', function () { elPanel.classList.toggle('pend-panel--collapsed'); });
    if (window.innerWidth < 600) elPanel.classList.add('pend-panel--collapsed');
  }
  if (btnPause && paused) btnPause.textContent = 'Play';

  var rt;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { resize(); resetTimers(); }, 150); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) { if (raf) { cancelAnimationFrame(raf); raf = null; } } else start(); });

  if (elSpeedV) elSpeedV.textContent = speed.toFixed(2) + '×';
  resize();
  start();
})();
