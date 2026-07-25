/* ==========================================================================
   creatures.js — page runtime for Evolving Creatures (/creatures/).
   --------------------------------------------------------------------------
   All simulation + evolution logic lives in creatures-core.js (pure, node-
   tested); this file owns rendering, the camera, the fitness chart HUD, the
   control panel, share links, and champion replay. Champion replays and
   shared creatures step through the SAME stepCreature() path as evolution.

   Pacing is timestamp-accumulated with a fixed dt = 1/240 s: speed only adds
   substeps per frame (capped at 96 — an overloaded device stretches wall
   clock, the trajectory stays bit-identical). Theme-aware via the
   effectiveTheme() pattern; Pointer Events; pauses on hidden tabs; honors
   prefers-reduced-motion (starts paused on a drawn first frame).
   ========================================================================== */
(function () {
  var canvas = document.getElementById('cre-canvas');
  if (!canvas || !window.CreaturesCore || !window.ShareHash) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  var C = window.CreaturesCore;
  function id(x) { return document.getElementById(x); }

  var chart = id('cre-chart');
  var chctx = chart ? chart.getContext('2d') : null;
  var elPreset = id('cre-preset');
  var elPop = id('cre-pop'), elPopV = id('cre-pop-val');
  var elMut = id('cre-mut'), elMutV = id('cre-mut-val');
  var elSpeed = id('cre-speed'), elSpeedV = id('cre-speed-val');
  var btnPause = id('cre-pause'), btnRestart = id('cre-restart');
  var btnReplay = id('cre-replay'), btnShare = id('cre-share'), btnSave = id('cre-save');
  var status = id('cre-status');

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var W = 0, H = 0, dpr = 1, raf = null, lastT = 0;
  var PX_PER_M = 70;
  var SPEEDS = [1, 4, 16];
  var CHART_W = 260, CHART_H = 150;
  /* chart draw cache: the y-scale and point stride only change when the
     history does, so they are not recomputed every frame */
  var chartHist = null, chartLen = -1, chartYmax = 1, chartStride = 1;

  var run = null;                 /* the evolution run (CreaturesCore.makeRun) */
  var mode = 'evolve';            /* 'evolve' | 'replay' | 'shared' */
  var solo = null;                /* { c, substep, genome, morph, gen, label } */
  var shared = null;              /* validated share payload, while relevant */
  var shareBannerEl = null;

  var paused = reduced, started = !reduced;
  var speed = 1, pending = 0;
  var cam = { x: 0, v: 0 };
  var camMax = 0, camEase = null; /* {from, t0} 400 ms ease back to 0 */
  var pendingBreed = false, freezeUntil = 0, bannerUntil = 0, bannerStart = 0, bannerText = '';
  var lastStatus = '';
  var comBuf = [];                /* per-frame comX cache, evolve mode */

  /* ------------------------------ theme ---------------------------------- */

  function effectiveTheme() {
    var f = document.documentElement.getAttribute('data-theme');
    if (f === 'light' || f === 'dark') return f;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }
  function bg() { return effectiveTheme() === 'light' ? '#f3f5f8' : '#0e1014'; }
  function accent() { return effectiveTheme() === 'light' ? '#34568a' : '#82a6cc'; }
  function greyColor(a) { return effectiveTheme() === 'light' ? 'rgba(94,94,94,' + a + ')' : 'rgba(160,160,160,' + a + ')'; }
  function textColor(a) { return effectiveTheme() === 'light' ? 'rgba(38,38,38,' + a + ')' : 'rgba(214,214,214,' + a + ')'; }

  /* ------------------------------ layout --------------------------------- */

  /* The chart is a fixed HUD. On a phone it moves to the bottom-right (CSS) and
     has to shrink so the corner buttons, which reach x~130, never sit on it. */
  function chartBox() {
    if (W >= 620) return [260, 150];
    var w = Math.max(150, Math.min(230, W - 150));
    return [w, Math.round(w * 150 / 260)];
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    if (chart) {
      var cb = chartBox();
      CHART_W = cb[0]; CHART_H = cb[1];
      chart.style.width = CHART_W + 'px';
      chart.style.height = CHART_H + 'px';
      chart.width = Math.round(CHART_W * dpr);
      chart.height = Math.round(CHART_H * dpr);
      chartLen = -1;                /* the cached stride depends on the width */
    }
  }
  function groundY() { return H * 0.78; }
  function morphOf() { return mode === 'evolve' ? (run && run.morph) : (solo && solo.morph); }
  function scalePx() {
    var m = morphOf(), top = 1.0;
    if (m) {
      var maxY = 0, minY = Infinity, i;
      for (i = 0; i < m.nodes.length; i++) {
        if (m.nodes[i][1] > maxY) maxY = m.nodes[i][1];
        if (m.nodes[i][1] < minY) minY = m.nodes[i][1];
      }
      top = (maxY - minY) + C.NODE_R * 2;
    }
    /* auto-shrink so tall creatures fit; never zoom in past 1 */
    return PX_PER_M * Math.min(1, (H * 0.35) / (PX_PER_M * (top + 0.4)));
  }
  function sx(wx, S) { return W * 0.40 + (wx - cam.x) * S; }
  function sy(wy, S) { return groundY() - wy * S; }

  /* ------------------------------- runs ---------------------------------- */

  function newSeed() { return (Math.random() * 4294967296) >>> 0; }  /* UI-only randomness */
  function popVal() { return elPop ? +elPop.value : C.POP_DEF; }
  function mutVal() { return elMut ? 0.3 * Math.pow(10, +elMut.value) : 1; }

  function resetCamera() { cam.x = 0; cam.v = 0; camMax = 0; camEase = null; }

  function newRun(opts) {
    opts = opts || {};
    run = C.makeRun({
      seed: newSeed(),
      preset: elPreset ? +elPreset.value : 0,
      pop: popVal(),
      mutScale: mutVal(),
      morph: opts.morph || null,
      seedGenome: opts.seedGenome || null
    });
    mode = 'evolve';
    solo = null;
    pending = 0;
    pendingBreed = false;
    bannerUntil = 0;
    resetCamera();
    hideShareBanner();
    updateShareBtn();
  }

  function makeSolo(morph, genome, gen, label) {
    return { c: C.makeCreature(morph, genome), substep: 0, morph: morph, genome: genome, gen: gen, label: label };
  }
  function respawnSolo() {
    solo.c = C.makeCreature(solo.morph, solo.genome);
    solo.substep = 0;
    camMax = 0;
    startCamEase();
  }

  function startReplay() {
    if (!run || !run.champion) return;
    solo = makeSolo(run.morph, run.champion.genome, run.champion.gen, 'champion');
    mode = 'replay';
    pending = 0;
    bannerUntil = 0;
    resetCamera();
  }
  function exitSolo() {
    if (mode === 'evolve') return;
    if (mode === 'shared') { hideShareBanner(); if (!run) { newRun(); return; } }
    mode = 'evolve';
    solo = null;
    pending = 0;
    /* jump the camera to the run's current front-runner */
    var lead = 0, i;
    if (run) {
      for (i = 0; i < run.pop; i++) {
        if (!run.creatures[i].dead) lead = Math.max(lead, C.comX(run.creatures[i]));
      }
    }
    cam.x = Math.max(0, lead); cam.v = 0; camMax = cam.x; camEase = null;
  }

  /* ------------------------------ camera --------------------------------- */

  function easeInOut(p) { return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; }
  function startCamEase() {
    if (reduced) { cam.x = 0; cam.v = 0; camEase = null; return; }
    camEase = { from: cam.x, t0: performance.now() };
  }
  function updateCamera(now, dt) {
    if (camEase) {
      var p = Math.min(1, (now - camEase.t0) / 400);
      cam.x = camEase.from * (1 - easeInOut(p));
      cam.v = 0;
      if (p >= 1) camEase = null;
      return;
    }
    /* critically damped spring toward the never-backward target */
    var k = 3.5;
    var a = k * k * (camMax - cam.x) - 2 * k * cam.v;
    cam.v += a * dt;
    cam.x += cam.v * dt;
  }

  /* ---------------------------- sim pacing ------------------------------- */

  function onGenEnd() {
    var h = run.hist[run.hist.length - 1];
    var prev = run.hist.length > 1 ? run.hist[run.hist.length - 2].best : null;
    var delta = (prev === null) ? '' :
      ' (' + (h.best - prev >= 0 ? '+' : '') + (h.best - prev).toFixed(1) + ')';
    bannerText = 'Generation ' + run.gen + ' · best ' + h.best.toFixed(1) + ' m' + delta;
    var now = performance.now();
    var freezeS = reduced ? 0 : (speed >= 16 ? 0 : (speed >= 4 ? 0.25 : 0.6));
    var bannerS = reduced ? 0.9 : Math.max(freezeS, 0.45);
    bannerStart = now;
    freezeUntil = now + freezeS * 1000;
    bannerUntil = now + bannerS * 1000;
    pendingBreed = true;
    pending = 0;
    updateShareBtn();
  }

  function advance(now, dtSec) {
    if (paused) return;
    /* Only the evolve view freezes at a generation end. A replay started during
       the freeze window must still step (gating the whole function on
       pendingBreed used to leave the replay permanently frozen), and breeding
       stays deferred until the user returns to the population. */
    if (pendingBreed && mode === 'evolve') {
      if (now >= freezeUntil) {
        C.breedNext(run);
        pendingBreed = false;
        camMax = 0;
        startCamEase();
      }
      return;
    }
    var spd = (mode === 'evolve') ? speed : 1;
    /* canonical pacing: fixed dt, more substeps, hard per-frame cap */
    pending += Math.min(dtSec, 0.1) * 240 * spd;
    var n = Math.min(Math.floor(pending), 96);
    pending -= n;
    if (n <= 0) return;
    if (mode === 'evolve') {
      C.stepRun(run, n);
      if (run.genDone) onGenEnd();
    } else if (solo) {
      for (var i = 0; i < n; i++) {
        C.stepCreature(solo.c, solo.substep);
        solo.substep++;
        if (solo.substep >= C.GEN_SUBSTEPS || solo.c.dead) { respawnSolo(); break; }
      }
    }
  }

  /* ----------------------------- backdrop -------------------------------- */

  var STARS = (function () {
    var r = C.mulberry32(99), out = [], i;
    for (i = 0; i < 44; i++) out.push([r(), r() * 0.5, 0.6 + r() * 0.9]);
    return out;
  })();

  function hillRidge(wx, far) {
    return far
      ? Math.max(0.05, 1.15 + 0.85 * Math.sin(wx * 0.09 + 2.0) + 0.35 * Math.sin(wx * 0.23 + 0.8))
      : Math.max(0.03, 0.52 + 0.38 * Math.sin(wx * 0.13 + 4.0) + 0.18 * Math.sin(wx * 0.31 + 1.6));
  }
  function drawHills(S, far) {
    var fac = far ? 0.25 : 0.55;
    ctx.beginPath();
    ctx.moveTo(0, groundY());
    for (var px = 0; px <= W + 12; px += 12) {
      var wx = (px - W * 0.40) / S + cam.x * fac;
      ctx.lineTo(px, groundY() - hillRidge(wx, far) * S);
    }
    ctx.lineTo(W, groundY());
    ctx.closePath();
    ctx.fillStyle = far ? 'rgba(127,127,127,0.08)' : 'rgba(127,127,127,0.12)';
    ctx.fill();
  }

  function drawGround(S) {
    var gy = groundY();
    ctx.strokeStyle = 'rgba(127,127,127,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, gy + 0.5); ctx.lineTo(W, gy + 0.5); ctx.stroke();

    var left = Math.ceil((0 - W * 0.40) / S + cam.x);
    var right = Math.floor((W - W * 0.40) / S + cam.x) + 1;
    ctx.font = '11px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (var m = left; m <= right; m++) {
      var x = sx(m, S);
      var five = (m % 5 === 0) && m > 0;
      ctx.strokeStyle = 'rgba(127,127,127,' + (five ? 0.4 : 0.22) + ')';
      ctx.beginPath(); ctx.moveTo(x, gy); ctx.lineTo(x, gy + (five ? 7 : 4)); ctx.stroke();
      if (five) {
        ctx.fillStyle = textColor(0.45);
        ctx.fillText(m + ' m', x, gy + 10);
      }
    }
    /* faint start line at x = 0 */
    var x0 = sx(0, S);
    if (x0 > -4 && x0 < W + 4) {
      ctx.strokeStyle = 'rgba(127,127,127,0.12)';
      ctx.beginPath(); ctx.moveTo(x0, gy); ctx.lineTo(x0, H * 0.30); ctx.stroke();
    }
  }

  /* ---------------------------- creatures -------------------------------- */

  /* alphaMul: base alpha; col: stroke/fill color. Muscle lines are thicker
     and their alpha is modulated +-20% by the live activation so you can
     see them pump. */
  function drawCreature(c, S, col, alphaMul, thick, t) {
    var i, s;
    ctx.lineCap = 'round';
    ctx.strokeStyle = col;
    /* structural springs first */
    ctx.globalAlpha = alphaMul;
    ctx.lineWidth = thick ? 2 : 1.4;
    ctx.beginPath();
    for (s = 0; s < c.s; s++) {
      if (c.mus[s]) continue;
      ctx.moveTo(sx(c.x[c.si[s]], S), sy(c.y[c.si[s]], S));
      ctx.lineTo(sx(c.x[c.sj[s]], S), sy(c.y[c.sj[s]], S));
    }
    ctx.stroke();
    /* muscles, one by one (per-muscle alpha) */
    var w = Math.PI * 2 * c.f * t;
    ctx.lineWidth = thick ? 3 : 2.2;
    for (var m = 0; m < c.m; m++) {
      s = c.mIdx[m];
      var act = Math.sin(w + c.mPhi[m]);
      ctx.globalAlpha = Math.max(0.03, Math.min(1, alphaMul * (1 + 0.2 * act)));
      ctx.beginPath();
      ctx.moveTo(sx(c.x[c.si[s]], S), sy(c.y[c.si[s]], S));
      ctx.lineTo(sx(c.x[c.sj[s]], S), sy(c.y[c.sj[s]], S));
      ctx.stroke();
    }
    /* nodes */
    ctx.globalAlpha = alphaMul;
    ctx.fillStyle = col;
    var r = Math.max(2.5, C.NODE_R * S);
    for (i = 0; i < c.n; i++) {
      ctx.beginPath();
      ctx.arc(sx(c.x[i], S), sy(c.y[i], S), r, 0, 6.2832);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawLeaderTag(c, S, dist) {
    var minY = Infinity, i;
    for (i = 0; i < c.n; i++) if (sy(c.y[i], S) < minY) minY = sy(c.y[i], S);
    var tx = sx(C.comX(c), S);
    var ty = Math.max(H * 0.16 + 14, minY - 16);
    ctx.font = '600 13px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = accent();
    ctx.fillText('▸ ' + dist.toFixed(1) + ' m', tx, ty);
  }

  function drawWorld(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = bg();
    ctx.fillRect(0, 0, W, H);
    var S = scalePx(), i;

    if (effectiveTheme() === 'dark') {
      ctx.fillStyle = 'rgba(214,214,214,0.18)';
      for (i = 0; i < STARS.length; i++) {
        ctx.beginPath();
        ctx.arc(STARS[i][0] * W, STARS[i][1] * H, STARS[i][2], 0, 6.2832);
        ctx.fill();
      }
    }
    drawHills(S, true);
    drawHills(S, false);
    drawGround(S);

    if (mode === 'evolve' && run) {
      var t = run.substep * C.DT;
      /* rank alive creatures by comX for leader styling */
      comBuf.length = 0;
      for (i = 0; i < run.pop; i++) {
        var c = run.creatures[i];
        comBuf.push([c.dead ? -Infinity : C.comX(c), i]);
      }
      comBuf.sort(function (a, b) { return b[0] - a[0]; });
      var lead = comBuf.length && isFinite(comBuf[0][0]) ? comBuf[0][1] : -1;
      var second = comBuf.length > 1 && isFinite(comBuf[1][0]) ? comBuf[1][1] : -1;
      var third = comBuf.length > 2 && isFinite(comBuf[2][0]) ? comBuf[2][1] : -1;
      if (lead >= 0 && !pendingBreed) camMax = Math.max(camMax, comBuf[0][0]);

      for (i = 0; i < run.pop; i++) {
        if (i === lead || i === second || i === third) continue;
        var cc = run.creatures[i];
        drawCreature(cc, S, greyColor(1), cc.dead ? 0.10 : 0.22, false, t);
      }
      if (third >= 0) drawCreature(run.creatures[third], S, greyColor(1), 0.45, false, t);
      if (second >= 0) drawCreature(run.creatures[second], S, greyColor(1), 0.45, false, t);
      if (lead >= 0) {
        drawCreature(run.creatures[lead], S, accent(), 1, true, t);
        drawLeaderTag(run.creatures[lead], S, comBuf[0][0]);
      }
    } else if (solo) {
      var ts = solo.substep * C.DT;
      camMax = Math.max(camMax, C.comX(solo.c));
      drawCreature(solo.c, S, accent(), 1, true, ts);
      drawLeaderTag(solo.c, S, C.comX(solo.c));
    }

    /* generation banner (canvas text kept out of the top 16%) */
    if (bannerUntil > now && bannerText) {
      var a = 1;
      if (!reduced) {
        var span = bannerUntil - bannerStart;
        var p = (now - bannerStart) / span;
        a = Math.min(1, Math.min(p / 0.2, (1 - p) / 0.3));
        a = Math.max(0, a);
      }
      ctx.globalAlpha = a;
      ctx.font = '600 17px "Source Sans 3", system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = textColor(0.92);
      ctx.fillText(bannerText, W / 2, H * 0.20);
      ctx.globalAlpha = 1;
    }
  }

  /* ------------------------------ chart ---------------------------------- */

  function drawChart() {
    if (!chctx || !chart.clientWidth) return;   /* hidden on landscape phones */
    chctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    chctx.clearRect(0, 0, CHART_W, CHART_H);
    var head;
    if (mode === 'evolve' && run) {
      var remain = Math.max(0, (C.GEN_SUBSTEPS - run.substep) / 240);
      head = 'gen ' + run.gen + ' · ' + remain.toFixed(1) + ' s';
    } else if (mode === 'replay' && solo) {
      head = 'champion replay · gen ' + solo.gen;
    } else if (solo) {
      head = 'shared creature · gen ' + solo.gen;
    } else head = '';
    chctx.font = '600 12px "Source Sans 3", system-ui, sans-serif';
    chctx.textAlign = 'left'; chctx.textBaseline = 'top';
    chctx.fillStyle = textColor(0.75);
    chctx.fillText(head, 0, 2);

    /* panel */
    var top = 20, x0 = 30, x1 = CHART_W - 6, y1 = CHART_H - 16, y0 = top + 6;
    chctx.fillStyle = 'rgba(127,127,127,0.10)';
    chctx.fillRect(0, top, CHART_W, CHART_H - top);
    chctx.strokeStyle = 'rgba(127,127,127,0.25)';
    chctx.lineWidth = 1;
    chctx.strokeRect(0.5, top + 0.5, CHART_W - 1, CHART_H - top - 1);

    var hist = run ? run.hist : [];
    var i;
    /* The history only grows (a long 16x session accumulates thousands of
       generations), so cache the y-scale and draw at most ~2 points per pixel
       instead of rescanning and stroking every entry each frame. */
    if (hist !== chartHist || hist.length !== chartLen) {
      chartHist = hist; chartLen = hist.length;
      var mx = 1;
      for (i = 0; i < hist.length; i++) if (hist[i].best > mx) mx = hist[i].best;
      chartYmax = mx * 1.1;
      chartStride = Math.max(1, Math.ceil(hist.length / Math.max(1, (x1 - x0) * 2)));
    }
    var ymax = chartYmax, stride = chartStride;
    function gx(g) { return hist.length < 2 ? (x0 + x1) / 2 : x0 + (x1 - x0) * g / (hist.length - 1); }
    function gy(v) { return y1 - (y1 - y0) * (v / ymax); }
    /* one bucket per drawn point; the best line takes the bucket MAX so record
       generations never disappear into a gap */
    function bucketBest(from) {
      var v = hist[from].best, end = Math.min(hist.length, from + stride);
      for (var k = from + 1; k < end; k++) if (hist[k].best > v) v = hist[k].best;
      return v;
    }

    /* axes labels */
    chctx.font = '10px "Source Sans 3", system-ui, sans-serif';
    chctx.fillStyle = textColor(0.5);
    chctx.textAlign = 'right'; chctx.textBaseline = 'middle';
    chctx.fillText(ymax.toFixed(ymax < 3 ? 1 : 0) + ' m', x0 - 3, y0);
    chctx.fillText('0', x0 - 3, y1);
    chctx.textAlign = 'center'; chctx.textBaseline = 'top';
    chctx.fillText('generation', (x0 + x1) / 2, y1 + 3);
    chctx.strokeStyle = 'rgba(127,127,127,0.3)';
    chctx.beginPath(); chctx.moveTo(x0 + 0.5, y0); chctx.lineTo(x0 + 0.5, y1 + 0.5); chctx.lineTo(x1, y1 + 0.5); chctx.stroke();

    if (hist.length === 1) {
      chctx.fillStyle = accent();
      chctx.beginPath(); chctx.arc(gx(0), gy(hist[0].best), 2.5, 0, 6.2832); chctx.fill();
      chctx.fillStyle = greyColor(0.8);
      chctx.beginPath(); chctx.arc(gx(0), gy(hist[0].median), 2, 0, 6.2832); chctx.fill();
    } else if (hist.length > 1) {
      var last = hist.length - 1, first = true;
      chctx.strokeStyle = greyColor(0.8);
      chctx.lineWidth = 1.2;
      chctx.setLineDash([3, 3]);
      chctx.beginPath();
      for (i = 0; i < hist.length; i += stride) {
        if (first) { chctx.moveTo(gx(i), gy(hist[i].median)); first = false; }
        else chctx.lineTo(gx(i), gy(hist[i].median));
      }
      chctx.lineTo(gx(last), gy(hist[last].median));
      chctx.stroke();
      chctx.setLineDash([]);
      chctx.strokeStyle = accent();
      chctx.lineWidth = 1.6;
      chctx.beginPath();
      first = true;
      for (i = 0; i < hist.length; i += stride) {
        if (first) { chctx.moveTo(gx(i), gy(bucketBest(i))); first = false; }
        else chctx.lineTo(gx(i), gy(bucketBest(i)));
      }
      chctx.lineTo(gx(last), gy(hist[last].best));
      chctx.stroke();
    }
  }

  /* ------------------------------ status --------------------------------- */

  function updateStatus() {
    if (!status) return;
    var txt;
    if (!started && paused) txt = 'Press play to start evolving.';
    else if (mode === 'replay' && solo) txt = 'replaying the champion from generation ' + solo.gen;
    else if (mode === 'shared' && solo) txt = 'watching a shared creature';
    else if (run) {
      txt = 'generation ' + run.gen +
        (run.champion ? ' · best ' + run.champion.fitness.toFixed(1) + ' m' : '');
      if (paused) txt = 'paused · ' + txt;
    } else txt = '';
    if (txt !== lastStatus) { status.textContent = txt; lastStatus = txt; }
  }

  function updateShareBtn() {
    var can = !!(run && run.champion);
    if (btnShare) btnShare.disabled = !can;
    if (btnReplay) btnReplay.disabled = !can;
  }

  /* ---------------------------- main loop -------------------------------- */

  function loop(t) {
    raf = requestAnimationFrame(loop);
    if (!W || !H) resize();
    var dt = Math.min(0.1, (t - lastT) / 1000 || 0);
    lastT = t;
    advance(t, dt);
    if (!paused) updateCamera(t, dt);
    drawWorld(t);
    drawChart();
    updateStatus();
  }
  function start() { if (!raf) { lastT = 0; raf = requestAnimationFrame(loop); } }

  /* ------------------------------ share ---------------------------------- */

  function hideShareBanner() {
    if (shareBannerEl && shareBannerEl.parentNode) {
      /* removing the banner while one of its buttons has focus would drop the
         keyboard user back to <body>; hand focus to the panel instead */
      if (shareBannerEl.contains(document.activeElement)) {
        var refocus = btnPause || btnRestart || id('cre-collapse');
        if (refocus) refocus.focus();
      }
      shareBannerEl.parentNode.removeChild(shareBannerEl);
    }
    shareBannerEl = null;
  }

  function showShareBanner(gen) {
    hideShareBanner();
    var div = document.createElement('div');
    div.className = 'cre-banner';
    var p = document.createElement('p');
    p.textContent = 'A shared creature, evolved for ' + gen + (gen === 1 ? ' generation.' : ' generations.');
    div.appendChild(p);
    var row = document.createElement('div');
    row.className = 'cre-banner__row';
    var b1 = document.createElement('button');
    b1.type = 'button'; b1.className = 'cre-btn'; b1.textContent = 'Evolve from it';
    b1.addEventListener('click', function () {
      if (!shared) return;
      if (elPreset) elPreset.value = String(shared.preset);
      newRun({ morph: shared.morph, seedGenome: shared.genome });
    });
    var b2 = document.createElement('button');
    b2.type = 'button'; b2.className = 'cre-btn'; b2.textContent = 'Start fresh';
    b2.addEventListener('click', function () { newRun(); });
    row.appendChild(b1); row.appendChild(b2);
    div.appendChild(row);
    document.body.appendChild(div);
    shareBannerEl = div;
  }

  function tryLoadShare() {
    var h = ShareHash.readHash();
    if (!h) return false;
    var d = ShareHash.decode(h);
    if (!d || d.version !== 1) return false;
    var sh = C.validateShare(d.obj);
    if (!sh) return false;
    shared = sh;
    var morph = sh.morph || C.morphForPreset(sh.preset, null);
    if (elPreset) elPreset.value = String(sh.preset);
    solo = makeSolo(morph, sh.genome, sh.gen, 'shared');
    mode = 'shared';
    resetCamera();
    showShareBanner(sh.gen);
    return true;
  }

  /* ----------------------------- controls -------------------------------- */

  function togglePause() {
    paused = !paused;
    if (!paused) started = true;
    pending = 0;
    if (btnPause) btnPause.textContent = paused ? 'Play' : 'Pause';
  }
  if (btnPause) btnPause.addEventListener('click', togglePause);
  if (btnRestart) btnRestart.addEventListener('click', function () { newRun(); });
  if (btnReplay) btnReplay.addEventListener('click', function () {
    if (mode === 'replay') exitSolo(); else startReplay();
  });
  if (btnShare) btnShare.addEventListener('click', function () {
    if (!run || !run.champion) return;
    var payload = C.buildShare(run);
    if (!payload) return;
    ShareHash.copyLink(btnShare, ShareHash.encode(1, payload));
  });
  if (btnSave) btnSave.addEventListener('click', function () {
    ShareHash.savePng(canvas, {
      label: 'Evolving Creatures', file: 'creatures.png',
      light: effectiveTheme() === 'light', bg: bg()
    });
  });

  if (elPreset) elPreset.addEventListener('change', function () { newRun(); });
  if (elPop) {
    elPop.addEventListener('input', function () { if (elPopV) elPopV.textContent = elPop.value; });
    elPop.addEventListener('change', function () { newRun(); });
  }
  if (elMut) elMut.addEventListener('input', function () {
    var v = mutVal();
    if (elMutV) elMutV.textContent = v.toFixed(v < 1 ? 2 : 1) + '×';
    if (run) run.mutScale = Math.min(3, Math.max(0.3, v));
  });
  if (elSpeed) elSpeed.addEventListener('input', function () {
    speed = SPEEDS[+elSpeed.value] || 1;
    pending = 0;
    if (elSpeedV) elSpeedV.textContent = speed + '×';
  });

  canvas.addEventListener('pointerdown', function () {
    if (mode === 'replay') exitSolo();
  });

  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (window.GadgetUI && GadgetUI.isTyping(e)) return;
    if (e.key === ' ') {
      if (e.target && (e.target.tagName || '').toLowerCase() === 'button') return;
      e.preventDefault();
      togglePause();
    } else if (e.key === 'r' || e.key === 'R') {
      newRun();
    } else if (e.key === 'c' || e.key === 'C') {
      if (mode === 'replay') exitSolo(); else startReplay();
    }
  });

  if (window.GadgetUI) {
    var hint = GadgetUI.firstRunHint('creatures',
      'Watch the population learn to run. The blue one is the current best.');
    var pnl = GadgetUI.initPanel({
      panel: id('cre-panel'), toggle: id('cre-collapse'),
      collapsedClass: 'cre-panel--collapsed',
      help: id('cre-help'), hint: hint
    });
    /* a landscape phone is wide enough that initPanel leaves the panel open,
       but it would cover half the runners */
    if (pnl && window.innerHeight < 520) pnl.setCollapsed(true);
  }

  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(resize, 150);
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (raf) { cancelAnimationFrame(raf); raf = null; }
    } else start();
  });

  /* ------------------------------- init ---------------------------------- */

  if (btnPause && paused) btnPause.textContent = 'Play';
  if (elPopV && elPop) elPopV.textContent = elPop.value;
  if (elMutV) elMutV.textContent = mutVal().toFixed(1) + '×';
  if (elSpeedV) elSpeedV.textContent = speed + '×';
  resize();
  if (!tryLoadShare()) newRun();
  updateShareBtn();
  start();
})();
