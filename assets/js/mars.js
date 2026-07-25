/* ==========================================================================
   Mission to Mars — porkchop plots and real transfer windows (/mars/).
   --------------------------------------------------------------------------
   Page runtime. All the math lives in mars-astro.js (window.MarsAstro); this
   file owns the full-screen canvas: a solar-system view (Sun, Earth, and the
   active target moving on their JPL-element orbits), a porkchop inset where
   every departure-date x flight-time cell is colored by total mission dv
   (thousands of Lambert solves, computed in ~12 ms slices so the page never
   freezes), a draggable crosshair with live readouts, a date timeline, and a
   Launch cruise animation that flies the chosen arc with the universal-
   variable propagator while the planets move in step.

   Theme-aware (dark default, light override), Pointer Events +
   touch-action:none, pauses on hidden tabs, honors prefers-reduced-motion
   (no cruise animation; Launch steps straight to arrival). Original code.
   ========================================================================== */
(function () {
  var canvas = document.getElementById('mars-canvas');
  if (!canvas || !window.MarsAstro) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  var A = window.MarsAstro;
  function id(x) { return document.getElementById(x); }

  var elPanel = id('mars-panel'), elCollapse = id('mars-collapse'), elHelp = id('mars-help');
  var btnLaunch = id('mars-launch'), btnNext = id('mars-next');
  var btnShare = id('mars-share'), btnSave = id('mars-save');
  var btnMars = id('mars-target-mars'), btnVenus = id('mars-target-venus');
  var statusEl = id('mars-status'), verifyEl = id('mars-verify');

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var W = 0, H = 0, dpr = 1, raf = null, lastT = 0;
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var FONT = '"Source Sans 3", system-ui, sans-serif';

  /* the grid start is fixed at page load: today - 30 days */
  var nowD = new Date();
  var jdToday = A.dateToJD(nowD.getUTCFullYear(), nowD.getUTCMonth() + 1, nowD.getUTCDate());
  var jd0 = jdToday - 30;

  var target = 'mars';
  var specs = { mars: A.porkchopSpec('mars', jd0), venus: A.porkchopSpec('venus', jd0) };
  var jobs = { mars: null, venus: null };
  var sel = { mars: null, venus: null };     // selected cell {i, j} per target
  var viewJD = jdToday;                       // the date the system view shows
  var mode = 'idle';                          // 'idle' | 'cruising'
  var cruise = null;                          // {info, t0, ms, trail:[worldPts]}
  var arrivedPulse = 0;                       // performance.now() at arrival
  var attract = !reduced;                     // gentle planet drift until first interaction
  var readoutCache = {};                      // 'target:i:j' -> missionDv result (or null)
  var ghost = null;                           // {pts, dep, arr, rDep, rArr}
  var pcCache = null, pcDirty = true, lastPcPaint = 0;
  var ariaLast = 0, ariaPend = null;
  var dragKind = null;                        // 'pc' | 'tl'
  var stars = null, orbCache = null;
  var L = null;                               // layout rects

  /* ---------------- theme ---------------- */
  function effectiveTheme() {
    var f = document.documentElement.getAttribute('data-theme');
    if (f === 'light' || f === 'dark') return f;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }
  function isLight() { return effectiveTheme() === 'light'; }
  function bg() { return isLight() ? '#f3f5f8' : '#0e1014'; }
  function accent() { return isLight() ? '#34568a' : '#82a6cc'; }
  function gold() { return isLight() ? '#a07c2c' : '#c8a45c'; }
  function textColor(a) { return isLight() ? 'rgba(38,38,38,' + a + ')' : 'rgba(214,214,214,' + a + ')'; }
  function panelFill() { return isLight() ? 'rgba(255,255,255,0.94)' : 'rgba(18,20,24,0.92)'; }

  /* sequential dv ramp (single navy/accent hue family, theme-aware):
     dark theme  <=4.5 near-white -> ~7 accent -> desaturated navy -> >=14 bg
     light theme <=4.5 deep navy  -> ~7 accent -> soft navy grey  -> >=14 white */
  var RAMP_DARK = [[4.5, 233, 239, 246], [7, 130, 166, 204], [10.5, 60, 78, 99], [14, 20, 20, 20]];
  var RAMP_LIGHT = [[4.5, 22, 42, 74], [7, 52, 86, 138], [10.5, 150, 172, 199], [14, 255, 255, 255]];
  function dvColor(dv, light) {
    var R = light ? RAMP_LIGHT : RAMP_DARK;
    if (dv <= R[0][0]) return [R[0][1], R[0][2], R[0][3]];
    var last = R[R.length - 1];
    if (dv >= last[0]) return [last[1], last[2], last[3]];
    for (var k = 1; k < R.length; k++) {
      if (dv <= R[k][0]) {
        var f = (dv - R[k - 1][0]) / (R[k][0] - R[k - 1][0]);
        return [
          Math.round(R[k - 1][1] + f * (R[k][1] - R[k - 1][1])),
          Math.round(R[k - 1][2] + f * (R[k][2] - R[k - 1][2])),
          Math.round(R[k - 1][3] + f * (R[k][3] - R[k - 1][3]))
        ];
      }
    }
    return [last[1], last[2], last[3]];
  }

  /* ---------------- formatting ---------------- */
  function fmtDate(jd) {
    var d = A.jdToDate(jd);
    return d.d + ' ' + MON[d.m - 1] + ' ' + d.y;
  }
  function targetName() { return target === 'venus' ? 'Venus' : 'Mars'; }
  function clampN(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* ---------------- layout ---------------- */
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* The chat widget is a fixed bottom-RIGHT bar (~400x48 on desktop, hidden on
     these full-screen pages at <=768px). The porkchop is the only bottom-right
     thing we draw, so measure the widget and lift the panel above it rather
     than guessing a margin. */
  function chatClearance() {
    var el = document.getElementById('chat-widget');
    if (!el) return 16;
    var r = el.getBoundingClientRect();
    if (!r.height || r.top >= H) return 16;
    return Math.max(16, Math.round(H - r.top) + 8);
  }

  function layout() {
    /* the fixed control panel owns the top-right ~330px and runs nearly full
       height, so the corner-inset porkchop only works on wide screens; below
       1000px it docks along the bottom instead (still clear of the panel,
       which auto-collapses only under 600px). Measured clearances: the two
       bottom-left buttons span to x~130, the panel starts at W-318. */
    var mobile = W < 1000;
    var panelReserve = W >= 600 ? 330 : 0;
    var botClear = chatClearance();
    var pc, plot, ro, tl;
    if (!mobile) {
      var pcW = Math.min(Math.round(W * 0.40), 460);
      var plotH = Math.round(pcW * 0.58);
      var roH = 92;
      var pcH = plotH + roH;
      pc = { x: W - pcW - panelReserve, y: H - pcH - botClear, w: pcW, h: pcH };
      ro = { x: pc.x, y: pc.y, w: pcW, h: roH };
      plot = { x: pc.x + 48, y: pc.y + roH + 4, w: pcW - 48 - 14, h: plotH - 4 - 26 };
      /* timeline along the bottom: starts right of BOTH corner buttons */
      tl = { x0: 140, x1: Math.max(260, pc.x - 26), y: H - 26 };
    } else {
      /* Docked along the bottom. The fixed corner buttons (#theme-toggle,
         #life-link) float ABOVE this canvas and span x 20..130, so the plot
         must start right of them or taps land on the buttons instead of the
         crosshair (worst case: #life-link navigates away mid-session). */
      var pcH2 = Math.round(H * 0.38);
      pc = { x: 6, y: H - pcH2 - Math.max(8, botClear - 8), w: W - 12 - panelReserve, h: pcH2 };
      ro = { x: pc.x, y: pc.y, w: pc.w, h: 46 };
      plot = { x: pc.x + 134, y: pc.y + 50, w: pc.w - 134 - 10, h: pc.h - 50 - 24 };
      tl = { x0: 140, x1: W - 16 - panelReserve, y: pc.y - 22 };
    }
    L = { mobile: mobile, reserve: panelReserve, pc: pc, plot: plot, ro: ro, tl: tl, sys: null };
    fitView();
  }

  function fitView() {
    if (!L) return;
    var elE = A.elementsRad('earth', jdToday);
    var elT = A.elementsRad(target, jdToday);
    var rFit = Math.max(elE.a * (1 + elE.e), elT.a * (1 + elT.e)) * 1.12;
    /* the docked branch must also clear the control panel, or the target orbit
       and the cruising ship pass behind it in the 600-1000px band */
    var x0 = 10;
    var x1 = L.mobile ? Math.max(x0 + 60, W - 10 - L.reserve)
                      : Math.max(x0 + 60, L.pc.x - 10);
    var y0 = Math.max(90, H * 0.16), y1 = L.tl.y - 30;
    if (y1 < y0 + 60) y1 = y0 + 60;
    var scale = Math.min(x1 - x0, y1 - y0) / 2 / rFit;
    L.sys = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, scale: scale };
  }
  function w2s(p) { return [L.sys.cx + p[0] * L.sys.scale, L.sys.cy - p[1] * L.sys.scale]; }

  function makeStars() {
    var s = 987654321;
    function rnd() { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }
    stars = [];
    for (var i = 0; i < 90; i++) {
      stars.push({ x: rnd(), y: rnd(), r: 0.4 + rnd() * 0.9, a: 0.08 + rnd() * 0.32 });
    }
  }

  /* ---------------- selection / readout ---------------- */
  function tlRange() {
    var sp = specs[target];
    return { min: sp.jd0, max: sp.depMax + sp.tofMax };
  }
  function selInfo() {
    var s = sel[target];
    if (!s) return null;
    var sp = specs[target];
    var dep = sp.jd0 + s.i * sp.depStep;
    var tof = sp.tof0 + s.j * sp.tofStep;
    var key = target + ':' + s.i + ':' + s.j;
    if (!(key in readoutCache)) readoutCache[key] = A.missionDv(dep, tof, target);
    return { dep: dep, tof: tof, m: readoutCache[key] };
  }

  function updateGhost(info) {
    if (!info || !info.m) { ghost = null; return; }
    var NP = 72, pts = [];
    for (var k = 0; k <= NP; k++) {
      pts.push(A.propagateKepler(info.m.rDep, info.m.v1, info.tof * k / NP).r);
    }
    ghost = { pts: pts, dep: info.dep, arr: info.dep + info.tof, rDep: info.m.rDep, rArr: info.m.rArr };
  }

  function setStatus(t) { if (statusEl) statusEl.textContent = t; }
  function liveStatus(info) {
    if (!info) return;
    var txt = info.m
      ? ('Depart ' + fmtDate(info.dep) + ' · ' + info.tof + ' days · ' + info.m.total.toFixed(1) + ' km/s total')
      : 'No transfer solution at this spot.';
    var t = performance.now();
    if (t - ariaLast > 400) { ariaLast = t; setStatus(txt); ariaPend = null; }
    else ariaPend = txt;
  }

  function setSel(i, j, force) {
    var s = sel[target];
    if (s && s.i === i && s.j === j && !force) return;
    sel[target] = { i: i, j: j };
    cancelCruise();
    arrivedPulse = 0;
    if (btnLaunch) btnLaunch.textContent = 'Launch';
    var info = selInfo();
    if (info) {
      viewJD = info.dep;
      updateGhost(info);
      liveStatus(info);
    }
  }

  /* ---------------- cruise ---------------- */
  function easeInOutCubic(s) { return s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2; }
  function cancelCruise() {
    if (mode === 'cruising') { mode = 'idle'; cruise = null; }
  }
  function announceArrival(info) {
    setStatus('Arrived ' + fmtDate(info.dep + info.tof) + ' · ' + info.tof + ' days · ' +
              info.m.total.toFixed(1) + ' km/s total');
  }
  function startLaunch() {
    var info = selInfo();
    if (!info) { setStatus('Pick a spot on the map first.'); return; }
    if (!info.m) { setStatus('No transfer solution here. Pick a brighter cell.'); return; }
    attract = false;
    arrivedPulse = 0;
    if (reduced) {
      cancelCruise();
      viewJD = info.dep + info.tof;
      announceArrival(info);
      if (btnLaunch) btnLaunch.textContent = 'Replay';
      return;
    }
    mode = 'cruising';
    cruise = { info: info, t0: performance.now(), ms: 8000, trail: [] };
    setStatus('Cruising to ' + targetName() + '.');
    if (btnLaunch) btnLaunch.textContent = 'Launch';
  }

  function nextWindow() {
    var job = jobs[target];
    if (!job || !job.done) { setStatus('Still computing the map. One moment.'); return; }
    attract = false;
    var sp = specs[target];
    var s = sel[target];
    var curDep = s ? sp.jd0 + s.i * sp.depStep : -Infinity;
    var limit = curDep + 200;
    var best = null, bestDv = Infinity, gbest = null, gbestDv = Infinity;
    for (var i = 0; i < sp.nDep; i++) {
      var dep = sp.jd0 + i * sp.depStep;
      for (var j = 0; j < sp.nTof; j++) {
        var dv = job.total[i * sp.nTof + j];
        if (!isFinite(dv)) continue;
        if (dv < gbestDv) { gbestDv = dv; gbest = { i: i, j: j }; }
        if (dep > limit && dv < bestDv) { bestDv = dv; best = { i: i, j: j }; }
      }
    }
    var pick = best || gbest;
    if (!pick) return;
    setSel(pick.i, pick.j, true);
    var months = target === 'venus' ? 19 : 26;
    var info = selInfo();
    ariaLast = performance.now();
    ariaPend = null;
    setStatus('Earth and ' + targetName() + ' line up like this about every ' + months + ' months.' +
      (info && info.m ? (' Depart ' + fmtDate(info.dep) + ' · ' + info.m.total.toFixed(1) + ' km/s total.') : ''));
  }

  /* ---------------- target switch ---------------- */
  function setTarget(t) {
    if (target === t) return;
    cancelCruise();
    target = t;
    if (btnMars) { btnMars.classList.toggle('mars-seg__btn--on', t === 'mars'); btnMars.setAttribute('aria-pressed', t === 'mars' ? 'true' : 'false'); }
    if (btnVenus) { btnVenus.classList.toggle('mars-seg__btn--on', t === 'venus'); btnVenus.setAttribute('aria-pressed', t === 'venus' ? 'true' : 'false'); }
    if (!jobs[t]) jobs[t] = A.makePorkchopJob(specs[t]);
    pcCache = null; pcDirty = true; lastPcPaint = 0;
    orbCache = null;
    fitView();
    var s = sel[t];
    if (s) {
      var info = selInfo();
      if (info) { viewJD = info.dep; updateGhost(info); liveStatus(info); }
    } else {
      ghost = null;
      var r = tlRange();
      viewJD = clampN(viewJD, r.min, r.max);
      setStatus('Computing the ' + targetName() + ' map.');
    }
  }

  /* ---------------- porkchop cache ---------------- */
  function renderPcCache() {
    var job = jobs[target];
    if (!job || !L) return;
    var sp = job.spec, n = sp.nDep, m = sp.nTof;
    var cw = Math.max(2, Math.round(L.plot.w * dpr));
    var chh = Math.max(2, Math.round(L.plot.h * dpr));
    if (!pcCache) pcCache = document.createElement('canvas');
    if (pcCache.width !== cw || pcCache.height !== chh) { pcCache.width = cw; pcCache.height = chh; }
    var g = pcCache.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cw, chh);

    var light = isLight();
    var cell = document.createElement('canvas');
    cell.width = n; cell.height = m;
    var cg = cell.getContext('2d');
    var img = cg.createImageData(n, m);
    var i, j, idx;
    for (i = 0; i < n; i++) {
      for (j = 0; j < m; j++) {
        idx = i * m + j;
        if (idx >= job.doneCount) continue;               /* not computed yet */
        var p = ((m - 1 - j) * n + i) * 4;                /* TOF increases upward */
        var dv = job.total[idx];
        if (isNaN(dv)) {
          img.data[p] = 127; img.data[p + 1] = 127; img.data[p + 2] = 127;
          img.data[p + 3] = light ? 34 : 46;
        } else {
          var c = dvColor(dv, light);
          img.data[p] = c[0]; img.data[p + 1] = c[1]; img.data[p + 2] = c[2];
          img.data[p + 3] = 255;
        }
      }
    }
    cg.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(cell, 0, 0, n, m, 0, 0, cw, chh);
    cell.width = 0;                                       /* free the one-shot canvas */

    /* contour lines every 1 km/s: darker borders where the band index changes */
    var sx = cw / n, sy = chh / m;
    g.strokeStyle = light ? 'rgba(255,255,255,0.55)' : 'rgba(10,12,16,0.5)';
    g.lineWidth = Math.max(1, 0.7 * dpr);
    g.beginPath();
    function band(q) { var v = job.total[q]; return isNaN(v) ? -999 : Math.floor(Math.min(14, v)); }
    for (i = 0; i < n; i++) {
      for (j = 0; j < m; j++) {
        idx = i * m + j;
        if (idx >= job.doneCount) continue;
        var b0 = band(idx);
        if (b0 === -999) continue;
        if (i + 1 < n && (i + 1) * m + j < job.doneCount) {
          var b1 = band((i + 1) * m + j);
          if (b1 !== -999 && b1 !== b0) {
            var xv = (i + 1) * sx, yv = (m - 1 - j) * sy;
            g.moveTo(xv, yv); g.lineTo(xv, yv + sy);
          }
        }
        if (j + 1 < m && idx + 1 < job.doneCount) {
          var b2 = band(idx + 1);
          if (b2 !== -999 && b2 !== b0) {
            var yh = (m - 1 - j) * sy, xh = i * sx;
            g.moveTo(xh, yh); g.lineTo(xh + sx, yh);
          }
        }
      }
    }
    g.stroke();

    /* global-minimum marker: small ring + label */
    if (job.done && job.minI >= 0) {
      var mx = (job.minI + 0.5) * sx, my = (m - 1 - job.minJ + 0.5) * sy;
      g.strokeStyle = light ? 'rgba(38,38,38,0.9)' : 'rgba(233,239,246,0.95)';
      g.lineWidth = 1.4 * dpr;
      g.beginPath(); g.arc(mx, my, 5.5 * dpr, 0, 6.2832); g.stroke();
      g.font = (10.5 * dpr) + 'px ' + FONT;
      g.textBaseline = 'middle';
      var lbl = 'min ' + job.minDv.toFixed(1) + ' km/s';
      var onRight = mx < cw - 78 * dpr;
      g.textAlign = onRight ? 'left' : 'right';
      g.fillStyle = light ? 'rgba(38,38,38,0.85)' : 'rgba(233,239,246,0.9)';
      g.fillText(lbl, mx + (onRight ? 9 : -9) * dpr, my);
    }
    pcDirty = false;
  }

  /* ---------------- drawing ---------------- */
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawSystem() {
    if (!isLight() && stars) {
      ctx.fillStyle = '#d6dce6';
      for (var i = 0; i < stars.length; i++) {
        var st = stars[i];
        ctx.globalAlpha = st.a;
        ctx.beginPath(); ctx.arc(st.x * W, st.y * H, st.r, 0, 6.2832); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    if (!orbCache) {
      orbCache = {
        earth: A.orbitPoints('earth', jdToday, 180),
        tgt: A.orbitPoints(target, jdToday, 180)
      };
    }
    ctx.strokeStyle = 'rgba(127,127,127,0.35)';
    ctx.lineWidth = 1;
    ['earth', 'tgt'].forEach(function (kk) {
      var pts = orbCache[kk];
      ctx.beginPath();
      for (var k = 0; k < pts.length; k++) {
        var q = w2s(pts[k]);
        if (k === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
      }
      ctx.stroke();
    });

    /* Sun: muted warm disc + faint glow */
    var sc = w2s([0, 0, 0]);
    var glow = ctx.createRadialGradient(sc[0], sc[1], 1, sc[0], sc[1], 26);
    if (isLight()) {
      glow.addColorStop(0, 'rgba(160,124,44,0.30)'); glow.addColorStop(1, 'rgba(160,124,44,0)');
    } else {
      glow.addColorStop(0, 'rgba(245,238,216,0.28)'); glow.addColorStop(1, 'rgba(245,238,216,0)');
    }
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(sc[0], sc[1], 26, 0, 6.2832); ctx.fill();
    ctx.fillStyle = isLight() ? 'rgba(160,124,44,0.85)' : 'rgba(245,238,216,0.95)';
    ctx.beginPath(); ctx.arc(sc[0], sc[1], 5, 0, 6.2832); ctx.fill();

    /* ghost transfer arc + departure/arrival markers */
    if (ghost) {
      ctx.strokeStyle = accent();
      ctx.globalAlpha = 0.5;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (var k2 = 0; k2 < ghost.pts.length; k2++) {
        var q2 = w2s(ghost.pts[k2]);
        if (k2 === 0) ctx.moveTo(q2[0], q2[1]); else ctx.lineTo(q2[0], q2[1]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      var md = w2s(ghost.rDep), ma = w2s(ghost.rArr);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = accent();
      ctx.beginPath(); ctx.arc(md[0], md[1], 4.5, 0, 6.2832); ctx.stroke();
      ctx.strokeStyle = gold();
      ctx.beginPath(); ctx.arc(ma[0], ma[1], 4.5, 0, 6.2832); ctx.stroke();
    }

    /* planets at viewJD (Earth = accent, active target = gold) */
    var pe = w2s(A.planetState('earth', viewJD).r);
    var pt = w2s(A.planetState(target, viewJD).r);
    ctx.fillStyle = accent();
    ctx.beginPath(); ctx.arc(pe[0], pe[1], 5, 0, 6.2832); ctx.fill();
    ctx.fillStyle = gold();
    ctx.beginPath(); ctx.arc(pt[0], pt[1], 4.5, 0, 6.2832); ctx.fill();
    ctx.font = '10.5px ' + FONT;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    var eLblY = pe[1] < H * 0.17 ? pe[1] + 12 : pe[1] - 9;
    var tLblY = pt[1] < H * 0.17 ? pt[1] + 12 : pt[1] - 9;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = accent();
    ctx.fillText('Earth', pe[0] + 8, eLblY);
    ctx.fillStyle = gold();
    ctx.fillText(targetName(), pt[0] + 8, tLblY);
    ctx.globalAlpha = 1;

    /* ship + trail during the cruise */
    if (mode === 'cruising' && cruise) {
      var t = viewJD - cruise.info.dep;
      var shipR = A.propagateKepler(cruise.info.m.rDep, cruise.info.m.v1, t).r;
      cruise.trail.push([shipR[0], shipR[1], shipR[2]]);
      if (cruise.trail.length > 110) cruise.trail.shift();
      ctx.lineWidth = 1.5;
      for (var k3 = 1; k3 < cruise.trail.length; k3++) {
        var q3 = w2s(cruise.trail[k3 - 1]), q4 = w2s(cruise.trail[k3]);
        ctx.globalAlpha = 0.5 * (k3 / cruise.trail.length);
        ctx.strokeStyle = accent();
        ctx.beginPath(); ctx.moveTo(q3[0], q3[1]); ctx.lineTo(q4[0], q4[1]); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      var sp2 = w2s(shipR);
      ctx.fillStyle = textColor(0.95);
      ctx.beginPath(); ctx.arc(sp2[0], sp2[1], 2.6, 0, 6.2832); ctx.fill();
    }

    /* soft ring pulse on arrival */
    if (arrivedPulse && !reduced) {
      var kp = (performance.now() - arrivedPulse) / 1400;
      if (kp < 1) {
        ctx.strokeStyle = gold();
        ctx.globalAlpha = 0.7 * (1 - kp);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(pt[0], pt[1], 8 + kp * 26, 0, 6.2832); ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawTimeline() {
    var tl = L.tl, r = tlRange();
    function jdToX(jd) { return tl.x0 + (jd - r.min) / (r.max - r.min) * (tl.x1 - tl.x0); }
    ctx.strokeStyle = 'rgba(127,127,127,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(tl.x0, tl.y); ctx.lineTo(tl.x1, tl.y); ctx.stroke();
    var info = selInfo();
    if (info) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = accent();
      var xd = jdToX(info.dep);
      ctx.beginPath(); ctx.moveTo(xd, tl.y - 5); ctx.lineTo(xd, tl.y + 5); ctx.stroke();
      ctx.strokeStyle = gold();
      var xa = jdToX(info.dep + info.tof);
      ctx.beginPath(); ctx.moveTo(xa, tl.y - 5); ctx.lineTo(xa, tl.y + 5); ctx.stroke();
    }
    var xh = clampN(jdToX(viewJD), tl.x0, tl.x1);
    ctx.fillStyle = accent();
    ctx.beginPath(); ctx.arc(xh, tl.y, 5.5, 0, 6.2832); ctx.fill();
    ctx.font = '13px ' + FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = textColor(0.85);
    ctx.fillText(fmtDate(viewJD), tl.x0, tl.y - 9);
  }

  function drawPorkchop() {
    var job = jobs[target], sp = specs[target];
    var pc = L.pc, plot = L.plot;
    ctx.fillStyle = panelFill();
    ctx.strokeStyle = 'rgba(127,127,127,0.28)';
    ctx.lineWidth = 1;
    roundRect(pc.x, pc.y, pc.w, pc.h, 10);
    ctx.fill(); ctx.stroke();

    if (pcCache) ctx.drawImage(pcCache, plot.x, plot.y, plot.w, plot.h);
    ctx.strokeStyle = 'rgba(127,127,127,0.3)';
    ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w - 1, plot.h - 1);

    /* axes: departure dates along the bottom, TOF up the left */
    var n = sp.nDep, m = sp.nTof;
    ctx.font = '10.5px ' + FONT;
    ctx.fillStyle = textColor(0.65);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var stepMonths = L.mobile ? 12 : 6;
    var d0 = A.jdToDate(sp.jd0), dEnd = A.jdToDate(sp.depMax);
    var mm = d0.m, yy = d0.y;
    for (var guard = 0; guard < 45; guard++) {
      mm++; if (mm > 12) { mm = 1; yy++; }
      if (yy > dEnd.y || (yy === dEnd.y && mm > dEnd.m)) break;
      if (((yy * 12 + mm - 1) % stepMonths) !== 0) continue;
      var tj = A.dateToJD(yy, mm, 1);
      var tx = plot.x + ((tj - sp.jd0) / sp.depStep + 0.5) / n * plot.w;
      if (tx < plot.x + 14 || tx > plot.x + plot.w - 14) continue;
      ctx.strokeStyle = 'rgba(127,127,127,0.4)';
      ctx.beginPath(); ctx.moveTo(tx, plot.y + plot.h); ctx.lineTo(tx, plot.y + plot.h + 4); ctx.stroke();
      ctx.fillText(MON[mm - 1] + " '" + String(yy % 100 < 10 ? '0' + yy % 100 : yy % 100), tx, plot.y + plot.h + 6);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    var tofTick = target === 'venus' ? 60 : 100;
    for (var tv = Math.ceil(sp.tof0 / tofTick) * tofTick; tv <= sp.tofMax; tv += tofTick) {
      var ty = plot.y + plot.h - ((tv - sp.tof0) / sp.tofStep + 0.5) / m * plot.h;
      ctx.strokeStyle = 'rgba(127,127,127,0.4)';
      ctx.beginPath(); ctx.moveTo(plot.x - 4, ty); ctx.lineTo(plot.x, ty); ctx.stroke();
      ctx.fillText(tv + ' d', plot.x - 7, ty);
    }
    /* quiet unit label inside the plot's top-right corner */
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = textColor(0.6);
    ctx.fillText('total Δv, km/s', plot.x + plot.w - 5, plot.y + 4);

    /* progress bar while the grid computes */
    if (job && !job.done) {
      ctx.fillStyle = accent();
      ctx.globalAlpha = 0.8;
      ctx.fillRect(plot.x, plot.y + plot.h - 3, plot.w * job.progress, 3);
      ctx.globalAlpha = 1;
    }

    /* crosshair on the selected cell */
    var s = sel[target];
    if (s) {
      var cx2 = plot.x + (s.i + 0.5) / n * plot.w;
      var cy2 = plot.y + plot.h - (s.j + 0.5) / m * plot.h;
      ctx.strokeStyle = accent();
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plot.x, cy2); ctx.lineTo(plot.x + plot.w, cy2);
      ctx.moveTo(cx2, plot.y); ctx.lineTo(cx2, plot.y + plot.h);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.6;
      ctx.strokeRect(cx2 - 3.5, cy2 - 3.5, 7, 7);
    }

    drawReadout(job);
  }

  function drawReadout(job) {
    var ro = L.ro;
    var info = selInfo();
    var xL = ro.x + 14;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    if (!info || !job) {
      ctx.font = '13px ' + FONT;
      ctx.fillStyle = textColor(0.75);
      var msg = job && !job.done
        ? ('Computing the Δv map · ' + Math.round(job.progress * 100) + '%')
        : 'Pick a spot on the map.';
      ctx.fillText(msg, xL, ro.y + (L.mobile ? 24 : 34));
      return;
    }
    if (!info.m) {
      ctx.font = '13px ' + FONT;
      ctx.fillStyle = textColor(0.75);
      ctx.fillText('No transfer here. This geometry needs more than one arc.', xL, ro.y + (L.mobile ? 24 : 34));
      if (!L.mobile) {
        ctx.fillText('Depart ' + fmtDate(info.dep) + ' · ' + info.tof + ' days', xL, ro.y + 56);
      }
      return;
    }
    var m2 = info.m;
    if (L.mobile) {
      ctx.font = '12.5px ' + FONT;
      ctx.fillStyle = textColor(0.85);
      ctx.fillText(fmtDate(info.dep) + ' · ' + info.tof + ' d · arrive ' + fmtDate(info.dep + info.tof), xL, ro.y + 19);
      ctx.font = '600 13px ' + FONT;
      ctx.fillText('Δv ' + m2.dv1.toFixed(2) + ' + ' + m2.dv2.toFixed(2) + ' = ' + m2.total.toFixed(2) + ' km/s total', xL, ro.y + 38);
      return;
    }
    ctx.font = '13px ' + FONT;
    ctx.fillStyle = textColor(0.85);
    ctx.fillText('Depart ' + fmtDate(info.dep) + '  ·  Arrive ' + fmtDate(info.dep + info.tof), xL, ro.y + 24);
    ctx.font = '12.5px ' + FONT;
    ctx.fillStyle = textColor(0.7);
    ctx.fillText('Flight time ' + info.tof + ' days · C3 ' + m2.c3.toFixed(1) + ' km²/s² · v∞ arrival ' + m2.vinfArr.toFixed(2) + ' km/s', xL, ro.y + 45);
    ctx.fillStyle = textColor(0.85);
    ctx.fillText('Δv depart ' + m2.dv1.toFixed(2) + ' · Δv arrive ' + m2.dv2.toFixed(2), xL, ro.y + 68);
    ctx.font = '700 15px ' + FONT;
    ctx.textAlign = 'right';
    ctx.fillStyle = textColor(0.95);
    ctx.fillText('Total Δv ' + m2.total.toFixed(2) + ' km/s', ro.x + ro.w - 14, ro.y + 68);
    ctx.textAlign = 'left';
  }

  function draw() {
    if (!W || !H) { resize(); if (!W || !H) return; layout(); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = bg();
    ctx.fillRect(0, 0, W, H);
    drawSystem();
    drawTimeline();
    drawPorkchop();
  }

  /* ---------------- main loop ---------------- */
  function loop(t) {
    raf = requestAnimationFrame(loop);
    var dt = Math.min(0.1, (t - lastT) / 1000 || 0);
    lastT = t;
    var nowMs = performance.now();

    var job = jobs[target];
    if (job && !job.done) {
      job.step(12);
      if (job.done) {
        pcDirty = true;
        if (!sel[target]) {
          setSel(job.minI, job.minJ, true);
          var info = selInfo();
          if (info && info.m) {
            ariaLast = nowMs; ariaPend = null;
            setStatus('Cheapest window: depart ' + fmtDate(info.dep) + ' · ' + info.tof +
                      ' days · ' + info.m.total.toFixed(1) + ' km/s total');
          }
        }
      } else if (nowMs - lastPcPaint > 150) {
        pcDirty = true;
      }
    }
    if (pcDirty) { renderPcCache(); lastPcPaint = nowMs; }

    if (mode === 'cruising' && cruise) {
      var s = (nowMs - cruise.t0) / cruise.ms;
      if (s >= 1) {
        viewJD = cruise.info.dep + cruise.info.tof;
        var ci = cruise.info;
        mode = 'idle'; cruise = null;
        arrivedPulse = nowMs;
        announceArrival(ci);
        if (btnLaunch) btnLaunch.textContent = 'Replay';
      } else {
        viewJD = cruise.info.dep + easeInOutCubic(s) * cruise.info.tof;
      }
    } else if (mode === 'idle' && attract && !dragKind) {
      var r = tlRange();
      viewJD += dt * 6;                       /* gentle drift until first interaction */
      if (viewJD > r.max) viewJD = r.min;
    }

    if (ariaPend && nowMs - ariaLast > 400) {
      ariaLast = nowMs; setStatus(ariaPend); ariaPend = null;
    }
    draw();
  }
  function start() { if (!raf) { lastT = 0; raf = requestAnimationFrame(loop); } }

  /* ---------------- pointer input ---------------- */
  function rel(e) {
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function inPlot(p) {
    return p.x >= L.plot.x && p.x <= L.plot.x + L.plot.w &&
           p.y >= L.plot.y && p.y <= L.plot.y + L.plot.h;
  }
  function nearTl(p) {
    return Math.abs(p.y - L.tl.y) < 18 && p.x > L.tl.x0 - 12 && p.x < L.tl.x1 + 12;
  }
  function pcPick(p) {
    var sp = specs[target];
    var i = clampN(Math.floor((p.x - L.plot.x) / L.plot.w * sp.nDep), 0, sp.nDep - 1);
    var j = clampN(Math.floor((L.plot.y + L.plot.h - p.y) / L.plot.h * sp.nTof), 0, sp.nTof - 1);
    setSel(i, j);
  }
  function tlPick(p) {
    var r = tlRange();
    var f = clampN((p.x - L.tl.x0) / (L.tl.x1 - L.tl.x0), 0, 1);
    viewJD = r.min + f * (r.max - r.min);
  }
  canvas.addEventListener('pointerdown', function (e) {
    if (e.button === 2) return;
    attract = false;
    var p = rel(e);
    if (inPlot(p)) {
      dragKind = 'pc';
      if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
      pcPick(p);
      e.preventDefault();
      return;
    }
    if (nearTl(p)) {
      dragKind = 'tl';
      if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
      cancelCruise();
      tlPick(p);
      e.preventDefault();
    }
  });
  canvas.addEventListener('pointermove', function (e) {
    var p = rel(e);
    if (dragKind === 'pc') { pcPick(p); return; }
    if (dragKind === 'tl') { tlPick(p); return; }
    canvas.style.cursor = inPlot(p) ? 'crosshair' : (nearTl(p) ? 'ew-resize' : 'default');
  });
  function endDrag() {
    if (dragKind === 'pc' && ariaPend) {      /* flush the throttled readout */
      setStatus(ariaPend); ariaPend = null;
      ariaLast = performance.now();
    }
    dragKind = null;
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  /* ---------------- keyboard ---------------- */
  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (window.GadgetUI && GadgetUI.isTyping(e)) return;
    var k = e.key;
    if (k === 'Escape') {
      if (mode === 'cruising') { cancelCruise(); setStatus('Cruise cancelled.'); }
      return;
    }
    var tag = (e.target && e.target.tagName || '').toLowerCase();
    if (k === 'Enter') {
      /* anything Enter already activates keeps it: buttons, the details
         summary ("Why every 26 months?"), links */
      if (tag === 'button' || tag === 'summary' || tag === 'a') return;
      e.preventDefault();
      startLaunch();
      return;
    }
    var di = 0, dj = 0;
    if (k === 'ArrowLeft') di = -1;
    else if (k === 'ArrowRight') di = 1;
    else if (k === 'ArrowUp') dj = 1;
    else if (k === 'ArrowDown') dj = -1;
    else return;
    e.preventDefault();
    attract = false;
    var stp = e.shiftKey ? 5 : 1;
    var sp = specs[target];
    var s = sel[target] || { i: Math.round(sp.nDep / 2), j: Math.round(sp.nTof / 2) };
    setSel(clampN(s.i + di * stp, 0, sp.nDep - 1), clampN(s.j + dj * stp, 0, sp.nTof - 1));
  });

  /* ---------------- buttons ---------------- */
  if (btnLaunch) btnLaunch.addEventListener('click', startLaunch);
  if (btnNext) btnNext.addEventListener('click', nextWindow);
  if (btnMars) btnMars.addEventListener('click', function () { setTarget('mars'); });
  if (btnVenus) btnVenus.addEventListener('click', function () { setTarget('venus'); });
  if (btnShare) btnShare.addEventListener('click', function () {
    var info = selInfo();
    if (!info || !window.ShareHash) return;
    ShareHash.copyLink(btnShare, ShareHash.encode(1, { t: target, d: info.dep, f: info.tof }));
  });
  if (btnSave) btnSave.addEventListener('click', function () {
    if (!window.ShareHash) return;
    ShareHash.savePng(canvas, {
      label: 'Mission to Mars', file: 'mars-mission.png',
      light: isLight(), bg: bg()
    });
  });

  /* ---------------- theme + resize wiring ---------------- */
  function onThemeChange() { pcDirty = true; }
  if (window.MutationObserver) {
    new MutationObserver(onThemeChange).observe(document.documentElement,
      { attributes: true, attributeFilter: ['data-theme'] });
  }
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: light)');
    if (mq.addEventListener) mq.addEventListener('change', onThemeChange);
    else if (mq.addListener) mq.addListener(onThemeChange);
  }
  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () {
      resize(); layout(); makeStars();
      pcCache = null; pcDirty = true;
    }, 150);
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (raf) { cancelAnimationFrame(raf); raf = null; } }
    else start();
  });

  /* ---------------- init ---------------- */
  try {
    var chk = A.verifyEphemerides();
    if (verifyEl) {
      verifyEl.textContent = chk.ok ? '✓ ephemerides verified'
        : 'ephemeris self-check failed, positions may be off';
      verifyEl.title = 'Earth-Mars distance on 6 Oct 2020: ' + chk.dist2020.toFixed(4) +
        ' AU (published close approach: 0.4149 AU)';
      if (!chk.ok) verifyEl.classList.add('mars-verify--warn');
    }
  } catch (err) {
    if (verifyEl) verifyEl.textContent = 'ephemeris self-check failed, positions may be off';
  }

  /* restore a shared mission (decoded hash is untrusted; clamp everything) */
  if (window.ShareHash) {
    var dec = ShareHash.decode(ShareHash.readHash());
    if (dec && dec.version === 1) {
      var t0 = (dec.obj && dec.obj.t === 'venus') ? 'venus' : 'mars';
      var cs = A.clampShare(dec.obj, specs[t0]);
      target = t0;
      if (btnMars) { btnMars.classList.toggle('mars-seg__btn--on', t0 === 'mars'); btnMars.setAttribute('aria-pressed', t0 === 'mars' ? 'true' : 'false'); }
      if (btnVenus) { btnVenus.classList.toggle('mars-seg__btn--on', t0 === 'venus'); btnVenus.setAttribute('aria-pressed', t0 === 'venus' ? 'true' : 'false'); }
      sel[target] = { i: cs.i, j: cs.j };
      attract = false;
    }
  }

  jobs[target] = A.makePorkchopJob(specs[target]);

  if (window.GadgetUI) {
    var hint = GadgetUI.firstRunHint('mars', 'Drag the crosshair on the map, then press Launch.');
    GadgetUI.initPanel({
      panel: elPanel, toggle: elCollapse,
      collapsedClass: 'mars-panel--collapsed',
      help: elHelp, hint: hint
    });
  }

  resize();
  layout();
  makeStars();
  /* chat-widget.js injects its bar after this script runs, so the first layout
     measures no widget; re-layout once it lands (and once more as a fallback
     in case it is disabled or renamed) */
  (function watchChat() {
    var done = false;
    function again() {
      if (done) return;
      done = true;
      layout();
    }
    if (document.getElementById('chat-widget')) { return; }
    if (window.MutationObserver) {
      var mo = new MutationObserver(function () {
        if (document.getElementById('chat-widget')) { mo.disconnect(); again(); }
      });
      mo.observe(document.body, { childList: true });
      setTimeout(function () { mo.disconnect(); }, 8000);
    }
    setTimeout(again, 2500);
  })();
  var restored = selInfo();
  if (restored) {
    viewJD = restored.dep;
    updateGhost(restored);
    liveStatus(restored);
  }
  start();
})();
