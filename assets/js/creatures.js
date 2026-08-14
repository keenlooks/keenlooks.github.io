/* ==========================================================================
   creatures.js — page runtime for Evolving Creatures (/creatures/).
   --------------------------------------------------------------------------
   All simulation + evolution logic lives in creatures-core.js (pure, node-
   tested); this file owns rendering, the camera, the fitness chart HUD, the
   control panel, share links, champion replay, and the build-your-own
   editor (mode 'build': place dots, connect edges, mark muscles, then
   evolve the body — the default landing experience). Champion replays and
   shared creatures step through the SAME stepCreature() path as evolution.
   Physics never runs in build mode, and entering the editor does not
   destroy a live run.

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
  if (window.GadgetUI) GadgetUI.liveStatus(status);
  var buildbar = id('cre-buildbar'), buildMsg = id('cre-buildmsg');
  var btnEvolve = id('cre-evolve'), btnBUndo = id('cre-undo'), btnBClear = id('cre-clear');
  var btnEdit = id('cre-edit');

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var W = 0, H = 0, dpr = 1, raf = null, lastT = 0;
  var PX_PER_M = 70;
  var SPEEDS = [1, 4, 16];
  var CHART_W = 260, CHART_H = 150;
  /* chart draw cache: the y-scale and point stride only change when the
     history does, so they are not recomputed every frame */
  var chartHist = null, chartLen = -1, chartYmax = 1, chartStride = 1;

  var run = null;                 /* the evolution run (CreaturesCore.makeRun) */
  var panelUi = null;             /* GadgetUI.initPanel handle */
  var mode = 'evolve';            /* 'evolve' | 'replay' | 'shared' | 'build' */
  var solo = null;                /* { c, substep, genome, morph, gen, label } */
  var shared = null;              /* validated share payload, while relevant */
  var shareBannerEl = null;

  /* ----- build-mode state (the editor; physics never runs here) -----
     bm.morph is in WORLD meters (same space as presets). Entering build
     does NOT destroy `run`: it merely stops stepping, so the champion,
     history and Share button survive an accidental tap. */
  var coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  var bm = { morph: null, sel: -1, undo: [] };
  var UNDO_CAP = 60;
  /* one in-flight pointer gesture; a second pointer is ignored */
  var bp = { id: null, dragI: -1, downX: 0, downY: 0, moved: false,
             dragSnap: null, undoPushed: false, consumed: false, lpTimer: null };
  var hover = { x: 0, y: 0, on: false };
  var buildStatus = '';           /* one-shot status line text for build mode */
  var buildMsgFlash = null;       /* timeout restoring the validity note */
  var hintBuild = null, hintEvolve = null;  /* lazy GadgetUI first-run hints */
  var barReserve = 0;             /* px of screen bottom owned by the build bar */

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
    layoutBuildBar();
  }
  /* In build mode the bar owns the bottom of the screen, so the ground line
     (and therefore the whole creature, whose feet sit ON it) has to end above
     it: otherwise the feet are drawn UNDER the bar and every drag aimed at
     them lands on the bar instead of the canvas. barReserve is measured, not
     assumed, because the bar wraps to two or three rows on narrow screens. */
  function groundY() {
    var gy = H * 0.78;
    if (mode === 'build') gy = Math.max(H * 0.34, Math.min(gy, H - barReserve));
    return gy;
  }
  function morphOf() { return mode === 'evolve' ? (run && run.morph) : (solo && solo.morph); }
  /* build mode anchors x at mid-screen (the evolve anchor W*0.40 would clip
     ~10% of the +-1.6 m editable region off the left edge) */
  function anchorX() { return W * (mode === 'build' ? 0.50 : 0.40); }
  function scalePx() {
    if (mode === 'build') {
      /* fit the 3.4 m x 1.8 m editable region into what is left between the
         ground line and the top nav zone, independent of the morph */
      var vSpace = Math.max(70, groundY() - H * 0.20);
      return Math.min((W * 0.94) / 3.4, vSpace / 1.8);
    }
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
  function sx(wx, S) { return anchorX() + (wx - cam.x) * S; }
  function sy(wy, S) { return groundY() - wy * S; }

  /* how much of the screen bottom the build bar covers, plus a margin so the
     lowest dots keep a visible gap above it (read-only; safe per frame) */
  function measureBar() {
    if (mode !== 'build' || !buildbar || buildbar.hidden) { barReserve = 0; return; }
    var r = buildbar.getBoundingClientRect();
    barReserve = r.height ? Math.max(0, Math.round(H - r.top) + 18) : 0;
  }

  function fixedRect(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return (r.width < 2 || r.height < 2) ? null : r;
  }

  /* Wide screens center the bar by CSS, but three pieces of fixed furniture
     can share that band: the corner buttons bottom-left, the chat widget
     bottom-right (injected a second or two after load, so it has to be
     measured, never assumed), and the control panel when it is open on a
     short window. All three paint OVER the bar, which clipped its readout
     mid-word. Re-center the bar in whatever room is actually left.
     Limits only tighten within a call, so it settles instead of oscillating. */
  function layoutBuildBar() {
    if (!buildbar) return;
    if (buildbar.hidden || window.innerWidth <= 768) {
      /* <=768px: CSS pins the bar beside the corner buttons and the chat
         widget is hidden on .life-app pages */
      buildbar.style.left = ''; buildbar.style.right = '';
      buildbar.style.transform = ''; buildbar.style.maxWidth = '';
      measureBar();
      return;
    }
    buildbar.style.left = ''; buildbar.style.right = '';
    buildbar.style.transform = ''; buildbar.style.maxWidth = '';
    var vw = window.innerWidth, lo = 12, hi = vw - 12, pass, i, r;
    var lefts = [id('theme-toggle'), id('life-link')];
    var rights = [id('chat-widget'), id('cre-panel')];
    for (pass = 0; pass < 3; pass++) {
      var br = buildbar.getBoundingClientRect();
      var top = br.top - 8, bot = br.bottom + 8, lo0 = lo, hi0 = hi;
      for (i = 0; i < lefts.length; i++) {
        r = fixedRect(lefts[i]);
        if (r && r.bottom > top && r.top < bot && r.right > br.left - 8) lo = Math.max(lo, r.right + 12);
      }
      for (i = 0; i < rights.length; i++) {
        r = fixedRect(rights[i]);
        if (r && r.bottom > top && r.top < bot && r.left < br.right + 8) hi = Math.min(hi, r.left - 12);
      }
      if (lo === lo0 && hi === hi0) break;
      if (hi - lo < 200) {
        /* nowhere sensible left: fall back to the CSS centering rather than
           squeeze the bar into a column */
        buildbar.style.left = ''; buildbar.style.right = '';
        buildbar.style.transform = ''; buildbar.style.maxWidth = '';
        break;
      }
      buildbar.style.left = Math.round((lo + hi) / 2) + 'px';
      buildbar.style.right = 'auto';
      buildbar.style.transform = 'translateX(-50%)';
      buildbar.style.maxWidth = Math.round(Math.min(hi - lo, 544)) + 'px';
    }
    measureBar();
  }

  /* ------------------------------- runs ---------------------------------- */

  function newSeed() { return (Math.random() * 4294967296) >>> 0; }  /* UI-only randomness */
  function popVal() { return elPop ? +elPop.value : C.POP_DEF; }
  function mutVal() { return elMut ? 0.3 * Math.pow(10, +elMut.value) : 1; }

  function resetCamera() { cam.x = 0; cam.v = 0; camMax = 0; camEase = null; }

  /* opts.preset overrides the DOM select (the Evolve-it and share paths
     must never derive the preset from the select). Preset 5 = custom body:
     it REQUIRES a morph, so with none available (e.g. Restart pressed while
     the select still reads "Custom body" but no custom run exists) we fall
     back rather than throw. The select is synced afterwards so the panel
     always reads honestly. */
  function newRun(opts) {
    opts = opts || {};
    var preset = (opts.preset != null) ? (+opts.preset | 0) : (elPreset ? +elPreset.value : 0);
    var morph = opts.morph || null;
    if (preset === 5 && !morph) {
      if (run && run.presetIdx === 5) morph = run.morph;
      else preset = 0;
    }
    run = C.makeRun({
      seed: newSeed(),
      preset: preset,
      pop: popVal(),
      mutScale: mutVal(),
      morph: morph,
      seedGenome: opts.seedGenome || null
    });
    if (elPreset) elPreset.value = String(run.presetIdx);
    mode = 'evolve';
    solo = null;
    pending = 0;
    pendingBreed = false;
    bannerUntil = 0;
    resetCamera();
    hideShareBanner();
    updateShareBtn();
    ensureEvolveHint();
    syncModeUI();
  }

  /* ------------------------------ build mode ----------------------------- */

  function ensureBuildHint() {
    if (!hintBuild && window.GadgetUI) {
      hintBuild = GadgetUI.firstRunHint('creatures-build',
        'Drag the dots. Tap one dot, then another, to connect them. ' +
        'Tap an edge to change it. Then press Evolve.');
    }
    return hintBuild;
  }
  function ensureEvolveHint() {
    if (!hintEvolve && window.GadgetUI) {
      hintEvolve = GadgetUI.firstRunHint('creatures',
        'Watch the population learn to run. The blue one is the current best.');
    }
    return hintEvolve;
  }

  function capUndo() { if (bm.undo.length > UNDO_CAP) bm.undo.shift(); }
  function pushUndo() { bm.undo.push(C.copyMorph(bm.morph)); capUndo(); }

  function abortGesture() {
    if (bp.lpTimer) { clearTimeout(bp.lpTimer); bp.lpTimer = null; }
    bp.id = null; bp.dragI = -1; bp.moved = false;
    bp.dragSnap = null; bp.undoPushed = false; bp.consumed = false;
  }

  /* Enter the editor with a COPY of `morph`. `run` stays alive (advance()
     early-returns in build mode); it is replaced only when Evolve it
     actually creates a new one. */
  function enterBuild(morph) {
    var m = C.copyMorph(morph || { name: 'Custom', nodes: [], springs: [] });
    C.BuildOps.clampMorph(m);
    m.name = 'Custom';
    bm.morph = m;
    bm.sel = -1;
    bm.undo = [];
    abortGesture();
    hover.on = false;
    buildStatus = '';
    mode = 'build';
    solo = null;
    pending = 0;
    hideShareBanner();
    resetCamera();
    /* the select reads "Custom body" while editing, so picking ANY preset
       (including the one just loaded) always fires a change event */
    if (elPreset) elPreset.value = '5';
    /* on short windows the expanded panel reaches down over the build bar */
    if (panelUi && window.innerHeight < 660) panelUi.setCollapsed(true);
    ensureBuildHint();
    syncModeUI();
    updateBuildUI();
  }

  function doUndo() {
    if (mode !== 'build') return;
    /* one press = one level: if a moved drag is in flight, cancelling THAT
       drag is this press's undo (restore its captured pre-state and do not
       also pop the stack, which holds the PREVIOUS edit's pre-state) */
    if (bp.id !== null && bp.moved && bp.dragSnap) {
      bm.morph = bp.dragSnap;
      abortGesture();
      if (bm.sel >= bm.morph.nodes.length) bm.sel = -1;
      updateBuildUI();
      return;
    }
    if (!bm.undo.length) return;
    /* a Ctrl+Z mid-gesture must not leave stale indices; abort first */
    abortGesture();
    bm.morph = bm.undo.pop();
    if (bm.sel >= bm.morph.nodes.length) bm.sel = -1;
    updateBuildUI();
  }

  function flashBuildMsg(txt) {
    if (!buildMsg) return;
    buildMsg.textContent = txt;
    clearTimeout(buildMsgFlash);
    buildMsgFlash = setTimeout(function () {
      buildMsgFlash = null;
      lastBuildMsg = '';               /* force the validity note to repaint */
      updateBuildUI();
    }, 1800);
  }

  var lastBuildMsg = '';
  function updateBuildUI() {
    if (mode !== 'build' || !bm.morph) return;
    var v = C.validateMorph(bm.morph);
    var msg;
    if (v.ok) {
      msg = bm.morph.nodes.length + ' dots, ' + v.muscles +
        (v.muscles === 1 ? ' muscle' : ' muscles') + '. Ready.';
    } else if (v.reason === 'few-nodes') msg = 'add at least 3 dots';
    else if (v.reason === 'disconnected') msg = 'connect all the dots first';
    else if (v.reason === 'no-muscle') msg = 'make at least one edge a muscle (tap an edge)';
    else msg = 'this body will not work yet';
    if (buildMsg && !buildMsgFlash && msg !== lastBuildMsg) {
      buildMsg.textContent = msg;
      lastBuildMsg = msg;
      layoutBuildBar();          /* a longer note can wrap the bar to a new row */
    }
    if (btnEvolve) btnEvolve.disabled = !v.ok;
    if (btnBUndo) btnBUndo.disabled = !bm.undo.length;
    if (btnBClear) btnBClear.disabled = !bm.morph.nodes.length;
  }

  function syncModeUI() {
    if (buildbar) buildbar.hidden = (mode !== 'build');
    if (chart) chart.hidden = (mode === 'build');
    if (btnEdit) btnEdit.hidden = !(mode === 'evolve' || mode === 'replay');
    if (mode === 'build') { lastBuildMsg = ''; updateBuildUI(); }
    layoutBuildBar();
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
    syncModeUI();
  }
  function exitSolo() {
    if (mode === 'evolve' || mode === 'build') return;
    if (mode === 'shared') { hideShareBanner(); if (!run) { newRun(); return; } }
    mode = 'evolve';
    solo = null;
    pending = 0;
    syncModeUI();
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
    if (mode === 'build') return;   /* physics never runs in the editor */
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
      var wx = (px - anchorX()) / S + cam.x * fac;
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

    var left = Math.ceil((0 - anchorX()) / S + cam.x);
    var right = Math.floor((W - anchorX()) / S + cam.x) + 1;
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

  /* ------------------------- build-mode rendering ------------------------ */

  function muscleTint(a) {
    return effectiveTheme() === 'light'
      ? 'rgba(52,86,138,' + a + ')' : 'rgba(130,166,204,' + a + ')';
  }

  function drawBuild(now, S) {
    var m = bm.morph, i, k;
    if (!m) return;
    /* faint placement grid every 0.1 m over the editable region */
    ctx.fillStyle = textColor(0.08);
    for (var gxm = -16; gxm <= 16; gxm++) {
      var gpx = sx(gxm * 0.1, S);
      for (var gym = 1; gym <= 17; gym++) {
        ctx.fillRect(gpx - 1, sy(gym * 0.1, S) - 1, 2, 2);
      }
    }
    /* edges: muscles thick + accent-tinted with a slow cosmetic pulse
       (wall time, NOT physics); structural thin neutral grey */
    var pulse = 0.8 + 0.2 * Math.sin(now * 0.004);
    ctx.lineCap = 'round';
    for (k = 0; k < m.springs.length; k++) {
      var sp = m.springs[k];
      var ax = sx(m.nodes[sp[0]][0], S), ay = sy(m.nodes[sp[0]][1], S);
      var bx = sx(m.nodes[sp[1]][0], S), by = sy(m.nodes[sp[1]][1], S);
      if (sp[2]) { ctx.strokeStyle = muscleTint(pulse); ctx.lineWidth = 4; }
      else { ctx.strokeStyle = 'rgba(127,127,127,0.55)'; ctx.lineWidth = 2; }
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }
    /* dashed preview line from the selected node to the pointer (desktop
       hover only; coarse pointers skip it) */
    if (bm.sel >= 0 && hover.on && !coarse && bp.dragI < 0) {
      ctx.strokeStyle = muscleTint(0.5);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(sx(m.nodes[bm.sel][0], S), sy(m.nodes[bm.sel][1], S));
      ctx.lineTo(hover.x, hover.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    /* nodes */
    var r = coarse ? 10 : 7;
    for (i = 0; i < m.nodes.length; i++) {
      var nx = sx(m.nodes[i][0], S), ny = sy(m.nodes[i][1], S);
      ctx.fillStyle = textColor(0.9);
      ctx.beginPath(); ctx.arc(nx, ny, r, 0, 6.2832); ctx.fill();
      if (i === bm.sel) {
        ctx.save();
        ctx.shadowColor = accent();
        ctx.shadowBlur = 9;
        ctx.strokeStyle = accent();
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(nx, ny, r + 3.5, 0, 6.2832); ctx.stroke();
        ctx.restore();
      }
    }
    /* empty-canvas caption (kept out of the top 16% of the screen) */
    if (!m.nodes.length) {
      ctx.font = '400 16px "Source Sans 3", system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = textColor(0.5);
      ctx.fillText('tap anywhere to add a dot', W / 2, H * 0.18);
    }
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

    if (mode === 'build') {
      drawBuild(now, S);
    } else if (mode === 'evolve' && run) {
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

  /* The chart is a transparent HUD canvas laid over the running swarm, so its
     labels sat on whatever creature happened to be behind them. Back each one
     with a small theme-toned plate (page background, not a new color). */
  function labelPlate(g, x, y, w, h) {
    g.fillStyle = effectiveTheme() === 'light'
      ? 'rgba(243,245,248,0.86)' : 'rgba(14,16,20,0.82)';
    var r = 3;
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
    g.fill();
  }

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
    if (head) labelPlate(chctx, 0, 0, Math.min(CHART_W, chctx.measureText(head).width + 8), 17);
    chctx.fillStyle = textColor(0.75);
    chctx.fillText(head, 3, 2);

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
    chctx.textAlign = 'right'; chctx.textBaseline = 'middle';
    var ymaxTxt = ymax.toFixed(ymax < 3 ? 1 : 0) + ' m';
    labelPlate(chctx, Math.max(0, x0 - 5 - chctx.measureText(ymaxTxt).width - 3), y0 - 7,
               Math.min(x0 - 1, chctx.measureText(ymaxTxt).width + 8), 14);
    labelPlate(chctx, Math.max(0, x0 - 5 - chctx.measureText('0').width - 3), y1 - 7,
               chctx.measureText('0').width + 8, 14);
    chctx.fillStyle = textColor(0.5);
    chctx.fillText(ymaxTxt, x0 - 3, y0);
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
    /* build mode stays quiet: the aria-live validity note (#cre-buildmsg)
       already announces counts, so this line must not repeat every dot add */
    if (mode === 'build') txt = buildStatus || 'building a creature';
    else if (!started && paused) txt = 'Press play to start evolving.';
    else if (mode === 'replay' && solo) txt = 'replaying the champion from generation ' + solo.gen;
    else if (mode === 'shared' && solo) txt = 'watching a shared creature';
    else if (run) {
      if (run.presetIdx === 5 && !run.champion) txt = 'generation ' + run.gen + ' · evolving your creature';
      else txt = 'generation ' + run.gen +
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
    measureBar();
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

  function showShareBanner(gen, custom) {
    hideShareBanner();
    var div = document.createElement('div');
    div.className = 'cre-banner';
    var p = document.createElement('p');
    var tail = ' for ' + gen + (gen === 1 ? ' generation.' : ' generations.');
    p.textContent = custom
      ? 'A creature someone built themselves, evolved' + tail
      : 'A shared creature, evolved' + tail;
    div.appendChild(p);
    var row = document.createElement('div');
    row.className = 'cre-banner__row';
    var b1 = document.createElement('button');
    b1.type = 'button'; b1.className = 'cre-btn'; b1.textContent = 'Evolve from it';
    b1.addEventListener('click', function () {
      if (!shared) return;
      /* the preset is passed explicitly: a p=5 payload must seed a run with
         the CUSTOM morph + preset 5, never the select's reading */
      newRun({ morph: shared.morph, seedGenome: shared.genome, preset: shared.preset });
    });
    var b2 = document.createElement('button');
    b2.type = 'button'; b2.className = 'cre-btn'; b2.textContent = 'Start fresh';
    b2.addEventListener('click', function () {
      if (elPreset && elPreset.value === '5') elPreset.value = '0';
      newRun();
    });
    var b3 = document.createElement('button');
    b3.type = 'button'; b3.className = 'cre-btn'; b3.textContent = 'Edit this body';
    b3.addEventListener('click', function () {
      if (solo && solo.morph) enterBuild(solo.morph);
    });
    row.appendChild(b1); row.appendChild(b2); row.appendChild(b3);
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
    showShareBanner(sh.gen, sh.preset === 5);
    ensureEvolveHint();
    syncModeUI();
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
  if (btnRestart) btnRestart.addEventListener('click', function () {
    /* one stray click must not destroy the body being built (same rationale
       as the R hotkey gate and the Population-slider gate) */
    if (mode === 'build') return;
    newRun();
  });
  if (btnReplay) btnReplay.addEventListener('click', function () {
    if (mode === 'build') return;
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

  if (elPreset) elPreset.addEventListener('change', function () {
    /* build-mode re-entrancy: loading a preset into the editor must not fire
       the evolve-mode restart path */
    if (mode === 'build') {
      var v = +elPreset.value;
      if (v === 5 || !(v >= 0 && v <= 4)) return;
      pushUndo();
      var m = (v === 4) ? C.randomMorph(C.mulberry32(newSeed())) : C.copyMorph(C.PRESETS[v]);
      C.BuildOps.clampMorph(m);
      var loadedName = (v === 4) ? 'a random' : 'the ' + m.name;
      m.name = 'Custom';
      bm.morph = m;
      bm.sel = -1;
      abortGesture();
      buildStatus = 'Loaded ' + loadedName + ' body. Change it, then evolve.';
      updateBuildUI();
      /* park the select on "Custom body" so re-picking the SAME preset
         fires a change event and reloads clean geometry (documented
         select-state bug class, computer.js invariant) */
      elPreset.value = '5';
      return;
    }
    /* value 5 is unreachable by user selection (hidden option), but a share
       restore writes it programmatically */
    if (+elPreset.value === 5) return;
    newRun();
  });
  if (elPop) {
    elPop.addEventListener('input', function () { if (elPopV) elPopV.textContent = elPop.value; });
    elPop.addEventListener('change', function () {
      /* in build mode the new population simply applies to the next run;
         restarting here would silently destroy the body being built */
      if (mode === 'build') return;
      newRun();
    });
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

  /* --------------------- build-mode buttons + editing -------------------- */

  if (btnEvolve) btnEvolve.addEventListener('click', function () {
    if (mode !== 'build' || !bm.morph) return;
    if (!C.validateMorph(bm.morph).ok) { updateBuildUI(); return; }
    newRun({ morph: bm.morph, preset: 5 });
    /* an explicit request to animate: unpause even under reduced motion */
    paused = false; started = true;
    if (btnPause) btnPause.textContent = 'Pause';
  });
  if (btnBUndo) btnBUndo.addEventListener('click', doUndo);
  if (btnBClear) btnBClear.addEventListener('click', function () {
    if (mode !== 'build' || !bm.morph || !bm.morph.nodes.length) return;
    pushUndo();
    bm.morph.nodes = [];
    bm.morph.springs = [];
    bm.sel = -1;
    abortGesture();
    updateBuildUI();
  });
  if (btnEdit) btnEdit.addEventListener('click', function () {
    if (run && (mode === 'evolve' || mode === 'replay')) enterBuild(run.morph);
  });

  /* needed for right-click delete; without it every right-click also pops
     the browser menu (same as gravity/magnets) */
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  function hitRad() { return coarse ? 24 : 18; }
  function edgeRad() { return coarse ? 16 : 12; }
  function toWorldX(ex) { return (ex - anchorX()) / scalePx(); }
  function toWorldY(ey) { return (groundY() - ey) / scalePx(); }

  /* hit-testing in screen px; nodes win over edges */
  function nodeAtPx(ex, ey) {
    var S = scalePx(), best = -1, bd = hitRad();
    for (var i = 0; i < bm.morph.nodes.length; i++) {
      var d = Math.hypot(sx(bm.morph.nodes[i][0], S) - ex, sy(bm.morph.nodes[i][1], S) - ey);
      if (d <= bd) { bd = d; best = i; }
    }
    return best;
  }
  function edgeAtPx(ex, ey) {
    var S = scalePx(), best = -1, bd = edgeRad(), m = bm.morph;
    for (var k = 0; k < m.springs.length; k++) {
      var sp = m.springs[k];
      var ax = sx(m.nodes[sp[0]][0], S), ay = sy(m.nodes[sp[0]][1], S);
      var bx = sx(m.nodes[sp[1]][0], S), by = sy(m.nodes[sp[1]][1], S);
      var vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
      var t = L2 > 0 ? Math.max(0, Math.min(1, ((ex - ax) * vx + (ey - ay) * vy) / L2)) : 0;
      var d = Math.hypot(ax + vx * t - ex, ay + vy * t - ey);
      if (d <= bd) { bd = d; best = k; }
    }
    return best;
  }

  function cancelLP() { if (bp.lpTimer) { clearTimeout(bp.lpTimer); bp.lpTimer = null; } }

  /* delete node i and its springs; preSnap is the pre-op morph copy */
  function deleteNodeAt(i, preSnap) {
    bm.undo.push(preSnap || C.copyMorph(bm.morph)); capUndo();
    C.BuildOps.deleteNode(bm.morph, i);
    if (bm.sel === i) bm.sel = -1;
    else if (bm.sel > i) bm.sel--;
    updateBuildUI();
  }

  canvas.addEventListener('pointerdown', function (e) {
    if (mode !== 'build' || !bm.morph) return;
    if (bp.id !== null) { cancelLP(); return; }   /* second finger: cancel the long-press, ignore */
    if (e.button === 2) {
      /* right-click deletes a node or an edge (desktop convention) */
      var rn = nodeAtPx(e.clientX, e.clientY);
      if (rn >= 0) { deleteNodeAt(rn, null); return; }
      var re = edgeAtPx(e.clientX, e.clientY);
      if (re >= 0) {
        pushUndo();
        var rsp = bm.morph.springs[re];
        C.BuildOps.toggleEdge(bm.morph, rsp[0], rsp[1]);  /* present -> remove */
        updateBuildUI();
      }
      return;
    }
    if (e.button !== 0) return;
    bp.id = e.pointerId; bp.downX = e.clientX; bp.downY = e.clientY;
    bp.moved = false; bp.consumed = false; bp.undoPushed = false;
    bp.dragSnap = null; bp.dragI = -1;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    var ni = nodeAtPx(e.clientX, e.clientY);
    if (ni >= 0) {
      bp.dragI = ni;
      bp.dragSnap = C.copyMorph(bm.morph);
      /* manual long-press delete: 500 ms, cancelled the moment the drag
         activates (movement > 6 px), on pointerup, or on a second pointer,
         so a slow touch drag can never delete mid-drag */
      bp.lpTimer = setTimeout(function () {
        bp.lpTimer = null;
        if (bp.id === null || bp.dragI !== ni || bp.moved || bp.consumed) return;
        deleteNodeAt(ni, bp.dragSnap);
        bp.consumed = true;
        bp.dragI = -1;
      }, 500);
      return;
    }
    var ek = edgeAtPx(e.clientX, e.clientY);
    if (ek >= 0) {
      /* an edge tap while a node is selected deselects only (protects the
         connect gesture, consistent with tap-empty) */
      if (bm.sel >= 0) { bm.sel = -1; }
      else { pushUndo(); C.BuildOps.cycleEdge(bm.morph, ek); updateBuildUI(); }
      bp.consumed = true;
      return;
    }
    /* empty space: with a selection, deselect only (prevents accidental
       dots while connecting); else add a dot and let the same gesture drag
       it into place */
    if (bm.sel >= 0) { bm.sel = -1; bp.consumed = true; return; }
    var pre = C.copyMorph(bm.morph);
    var idx = C.BuildOps.addNode(bm.morph, toWorldX(e.clientX), toWorldY(e.clientY));
    if (idx === false) {
      flashBuildMsg('10 dots is the limit.');
      bp.consumed = true;
      return;
    }
    bm.undo.push(pre); capUndo();
    bm.sel = idx;
    bp.dragI = idx;
    bp.undoPushed = true;   /* the add already owns this gesture's undo entry */
    updateBuildUI();
  });

  canvas.addEventListener('pointermove', function (e) {
    if (mode !== 'build' || !bm.morph) return;
    if (e.pointerType === 'mouse') { hover.x = e.clientX; hover.y = e.clientY; hover.on = true; }
    if (e.pointerId !== bp.id || bp.dragI < 0 || bp.consumed) return;
    if (!bp.moved) {
      var ddx = e.clientX - bp.downX, ddy = e.clientY - bp.downY;
      if (ddx * ddx + ddy * ddy > 36) { bp.moved = true; cancelLP(); }
    }
    if (bp.moved) {
      C.BuildOps.moveNode(bm.morph, bp.dragI, toWorldX(e.clientX), toWorldY(e.clientY));
    }
  });
  canvas.addEventListener('pointerleave', function () { hover.on = false; });

  canvas.addEventListener('pointerup', function (e) {
    if (mode !== 'build' || e.pointerId !== bp.id) return;
    cancelLP();
    if (!bp.consumed && bp.dragI >= 0) {
      if (bp.moved) {
        /* capture-then-commit: push the PRE-drag copy only now (a pointerup-
           time copy would be the post-drag state and Ctrl+Z would restore
           nothing); the add gesture already pushed its own entry */
        if (!bp.undoPushed && bp.dragSnap) { bm.undo.push(bp.dragSnap); capUndo(); }
        updateBuildUI();
      } else if (!bp.undoPushed) {
        var ni = bp.dragI;
        if (bm.sel === -1) bm.sel = ni;              /* tap a node: select */
        else if (bm.sel === ni) bm.sel = -1;         /* tap it again: deselect */
        else {
          /* second node while one is selected: toggle the edge between them,
             keep the SECOND selected (tap-tap-tap chains a path) */
          var pre = C.copyMorph(bm.morph);
          var r = C.BuildOps.toggleEdge(bm.morph, bm.sel, ni);
          if (r === false) flashBuildMsg('26 edges is the limit.');
          else { bm.undo.push(pre); capUndo(); bm.sel = ni; updateBuildUI(); }
        }
      }
    }
    bp.id = null; bp.dragI = -1; bp.moved = false;
    bp.dragSnap = null; bp.undoPushed = false; bp.consumed = false;
  });

  canvas.addEventListener('pointercancel', function (e) {
    if (mode !== 'build' || e.pointerId !== bp.id) return;
    cancelLP();
    /* gesture aborted by the browser: restore the pre-gesture morph */
    if (bp.undoPushed && bm.undo.length) bm.morph = bm.undo.pop();
    else if (bp.moved && bp.dragSnap) bm.morph = bp.dragSnap;
    if (bm.sel >= bm.morph.nodes.length) bm.sel = -1;
    abortGesture();
    updateBuildUI();
  });

  window.addEventListener('keydown', function (e) {
    if (window.GadgetUI && GadgetUI.isTyping(e)) return;
    var tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'button' || tag === 'a' || tag === 'summary' || tag === 'label') return;
    /* the undo combo is the ONE modifier chord handled here; everything else
       with ctrl/meta/alt passes through to the browser untouched */
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      if (mode === 'build') { e.preventDefault(); doUndo(); }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (mode === 'build') {
      /* R / C / Space are gated out here: a stray R must NOT fire newRun and
         destroy the body being built */
      if (e.key === 'Escape') { bm.sel = -1; return; }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (bm.sel >= 0) {
          e.preventDefault();
          /* restructuring the morph mid-gesture leaves bp.dragI and the
             armed long-press timer pointing at stale indices */
          if (bp.id !== null) abortGesture();
          deleteNodeAt(bm.sel, null);
        }
        return;
      }
      var st = e.shiftKey ? 0.1 : 0.02;
      var kx = e.key === 'ArrowLeft' ? -st : (e.key === 'ArrowRight' ? st : 0);
      var ky = e.key === 'ArrowDown' ? -st : (e.key === 'ArrowUp' ? st : 0);
      if ((kx || ky) && bm.sel >= 0) {
        e.preventDefault();
        /* auto-repeat coalesces into the first press's snapshot, and a
           clamp-refused move must not burn an undo level */
        var nd = bm.morph.nodes[bm.sel];
        var tx = nd[0] + kx, ty = nd[1] + ky;
        var before = e.repeat ? null : C.copyMorph(bm.morph);
        if (C.BuildOps.moveNode(bm.morph, bm.sel, tx, ty) !== false) {
          var nd2 = bm.morph.nodes[bm.sel];
          if (before && (nd2[0] !== before.nodes[bm.sel][0] ||
                         nd2[1] !== before.nodes[bm.sel][1])) {
            bm.undo.push(before);
            capUndo();
          }
        }
        updateBuildUI();
      }
      if (e.key === ' ') e.preventDefault();
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      togglePause();
    } else if (e.key === 'r' || e.key === 'R') {
      newRun();
    } else if (e.key === 'c' || e.key === 'C') {
      if (mode === 'replay') exitSolo(); else startReplay();
    }
  });

  /* headless test hooks (real screen coordinates for aiming clicks) */
  window.__cre = {
    mode: function () { return mode; },
    nodeCount: function () { return bm.morph ? bm.morph.nodes.length : 0; },
    springCount: function () { return bm.morph ? bm.morph.springs.length : 0; },
    sel: function () { return bm.sel; },
    undoDepth: function () { return bm.undo.length; },
    gen: function () { return run ? run.gen : 0; },
    nodePx: function (i) {
      var S = scalePx(), n = bm.morph.nodes[i];
      return [sx(n[0], S), sy(n[1], S)];
    },
    edgePx: function (k) {
      var S = scalePx(), sp = bm.morph.springs[k];
      var a = bm.morph.nodes[sp[0]], b = bm.morph.nodes[sp[1]];
      return [(sx(a[0], S) + sx(b[0], S)) / 2, (sy(a[1], S) + sy(b[1], S)) / 2];
    }
  };

  if (window.GadgetUI) {
    /* hints are created lazily per mode (see ensureBuildHint/ensureEvolveHint),
       so the ? button re-shows the hint for the CURRENT mode */
    var pnl = GadgetUI.initPanel({
      panel: id('cre-panel'), toggle: id('cre-collapse'),
      collapsedClass: 'cre-panel--collapsed',
      /* an open panel on a short window reaches down into the build bar's
         band, so the bar has to be re-fitted whenever it opens or closes */
      onToggle: layoutBuildBar
    });
    var helpBtn = id('cre-help');
    if (helpBtn) helpBtn.addEventListener('click', function () {
      var h = (mode === 'build') ? ensureBuildHint() : ensureEvolveHint();
      if (h) h.show();
    });
    /* a landscape phone is wide enough that initPanel leaves the panel open,
       but it would cover half the runners */
    if (pnl && window.innerHeight < 520) pnl.setCollapsed(true);
    panelUi = pnl;
    /* the default landing enters build before this init ran */
    if (mode === 'build' && pnl && window.innerHeight < 660) pnl.setCollapsed(true);
  }

  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(resize, 150);
  });
  /* chat-widget.js appends its fixed bottom bar a second or two after load, so
     the first layout measures nothing; re-fit the build bar when it turns up */
  (function watchChat() {
    if (id('chat-widget')) { layoutBuildBar(); return; }
    var tries = 0, iv = setInterval(function () {
      if (id('chat-widget') || ++tries > 12) {
        clearInterval(iv);
        layoutBuildBar();
      }
    }, 400);
    try {
      var mo = new MutationObserver(function () {
        if (!id('chat-widget')) return;
        mo.disconnect();
        clearInterval(iv);
        layoutBuildBar();
      });
      mo.observe(document.body, { childList: true });
    } catch (e) {}
  })();
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
  if (!tryLoadShare()) {
    /* default landing: the editor, with the Sprinter body preloaded. Show at
       most one hint this visit (the build hint), so mark the evolve hint as
       seen before it can ever be created. */
    try { localStorage.setItem('hint-creatures', '1'); } catch (e) {}
    enterBuild(C.PRESETS[0]);
  }
  updateShareBtn();
  syncModeUI();
  start();
})();

/* ---- guided first-run tour (design pass F3) --------------------------------
   Registered from OUTSIDE the page module: targets come from the read-only
   window.__cre hooks, so the pinned build/evolve code above stays untouched.
   The `when` gate keeps the tour to build mode; in evolve mode the ? button
   falls back to the original evolve hint (gadget-tour.js firstRunHint shim). */
(function () {
  if (!window.GadgetUI || !window.GadgetUI.tour || !window.__cre) return;
  var cre = window.__cre;
  function bodyBox() {
    var n = cre.nodeCount();
    if (!n) return null;
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (var i = 0; i < n; i++) {
      var p = cre.nodePx(i);
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
    return { x: x0 - 16, y: y0 - 16, w: (x1 - x0) + 32, h: (y1 - y0) + 32 };
  }
  function edgeBox() {
    if (!cre.springCount()) return bodyBox();
    var p = cre.edgePx(0);
    return { x: p[0] - 26, y: p[1] - 26, w: 52, h: 52 };
  }
  window.GadgetUI.tour('creatures', [
    { text: 'Tap to add a dot. Tap two dots to connect them.',
      rect: bodyBox, side: 'top' },
    { text: 'Tap a line to cycle it: muscle, bone, gone.',
      rect: edgeBox, side: 'top' },
    { text: 'Press Evolve and watch generations learn to walk.',
      rect: '#cre-evolve', side: 'top' }
  ], { when: function () { return cre.mode() === 'build'; },
       avoid: ['#cre-panel', '#cre-buildbar'] });
})();
