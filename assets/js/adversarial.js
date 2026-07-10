/* ==========================================================================
   Fool a Neural Network — FGSM adversarial examples, live in the browser.
   --------------------------------------------------------------------------
   Two small MNIST classifiers (784->64->10 MLPs, trained offline by
   make_adversarial_model.py, shipped int8-quantized in adversarial-model.js):
   a STANDARD model and an ADVERSARIALLY-TRAINED one. This file runs each
   model's forward pass AND the gradient of the loss w.r.t. the input. That
   gradient is the whole trick — the Fast Gradient Sign Method (Goodfellow et
   al., 2014) nudges every pixel by ±ε in whichever direction hurts the model
   most:

       x_adv = clip( x + ε · sign(∇ₓ loss), 0, 1 )       (untargeted)
       x_adv = clip( x − ε · sign(∇ₓ loss_t), 0, 1 )     (toward a chosen class t)

   The noise is always computed against the CURRENTLY ACTIVE model, so toggling
   adversarial training re-aims the attack. Click a confidence bar to aim the
   attack at that digit. The hidden-activation grids show how the perturbation
   reshapes the network's internal representation.

   ADVANCED MODE adds: iterative PGD (steps of alpha = 1.5*eps/steps, each
   projected back into the L-inf eps-ball around the original and clipped to
   [0,1]); an accuracy-vs-epsilon robustness curve for both models over the 60
   bundled digits; and a transfer readout (craft on one model, test on both).
   Heavy computations run chunked on setTimeout slices and cache per
   (model, method) so the main rAF loop never stalls. With the Advanced box
   unchecked, every code path is identical to the original FGSM-only demo.

   Original code; theme-aware; Pointer Events + touch-action:none.
   ========================================================================== */
(function () {
  var canvas = document.getElementById('adv-canvas');
  if (!canvas || !window.ADV_MODEL) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  function id(x) { return document.getElementById(x); }

  var elEps = id('adv-eps'), elEpsV = id('adv-eps-val');
  var btnNext = id('adv-next'), btnPrev = id('adv-prev'), btnClear = id('adv-clear');
  var elRobust = id('adv-robust');
  var elPanel = id('adv-panel'), elCollapse = id('adv-collapse');
  var status = id('adv-status');
  /* advanced-mode elements (all optional; the page may not ship them) */
  var elAdv = id('adv-advanced'), elSec = id('adv-adv-sec');
  var btnFgsm = id('adv-m-fgsm'), btnPgd = id('adv-m-pgd');
  var elSteps = id('adv-steps'), elStepsV = id('adv-steps-val'), stepsRow = id('adv-steps-row');
  var curveCanvas = id('adv-curve'), curveNote = id('adv-curve-note');
  var txGrid = id('adv-transfer'), txNote = id('adv-transfer-note');

  /* ---- decode the models ---- */
  var M = window.ADV_MODEL, HID = M.hidden;
  function b64bytes(s) {
    var bin = atob(s), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  function dequant(b64, scale) {
    var q = new Int8Array(b64bytes(b64).buffer), f = new Float32Array(q.length);
    for (var i = 0; i < q.length; i++) f[i] = q[i] * scale;
    return f;
  }
  function decode(spec) {
    var W2 = dequant(spec.w2, spec.s2);
    var maxW2 = 1e-6;
    for (var i = 0; i < W2.length; i++) if (Math.abs(W2[i]) > maxW2) maxW2 = Math.abs(W2[i]);
    return {
      W1: dequant(spec.w1, spec.s1),   // 784×HID
      W2: W2,                          // HID×10
      B1: new Float32Array(spec.b1),
      B2: new Float32Array(spec.b2),
      maxW2: maxW2
    };
  }
  var STD = decode(M.standard), ROB = decode(M.robust);
  var net = STD;                       // active model
  var IMGS = b64bytes(M.images);       // n × 784 uint8

  /* ---- the network (model defaults to the active one) ---- */
  function forward(x, model) {
    var m = model || net;
    var h = new Float32Array(HID), p = new Float32Array(10), i, j, s;
    for (j = 0; j < HID; j++) {
      s = m.B1[j];
      for (i = 0; i < 784; i++) s += x[i] * m.W1[i * HID + j];
      h[j] = s > 0 ? s : 0;
    }
    var mx = -1e9;
    for (j = 0; j < 10; j++) {
      s = m.B2[j];
      for (i = 0; i < HID; i++) s += h[i] * m.W2[i * 10 + j];
      p[j] = s; if (s > mx) mx = s;
    }
    var sum = 0;
    for (j = 0; j < 10; j++) { p[j] = Math.exp(p[j] - mx); sum += p[j]; }
    for (j = 0; j < 10; j++) p[j] /= sum;
    return { h: h, p: p };
  }
  /* d(cross-entropy(label)) / d(input) — backprop through both layers */
  function inputGrad(x, label, model) {
    var m = model || net;
    var f = forward(x, m), d = new Float32Array(10), i, j;
    for (j = 0; j < 10; j++) d[j] = f.p[j] - (j === label ? 1 : 0);
    var dh = new Float32Array(HID);
    for (i = 0; i < HID; i++) {
      if (f.h[i] <= 0) continue;
      var s = 0;
      for (j = 0; j < 10; j++) s += m.W2[i * 10 + j] * d[j];
      dh[i] = s;
    }
    var dx = new Float32Array(784);
    for (i = 0; i < 784; i++) {
      var s2 = 0;
      for (j = 0; j < HID; j++) s2 += m.W1[i * HID + j] * dh[j];
      dx[i] = s2;
    }
    return dx;
  }
  function argmax(p) { var b = 0; for (var i = 1; i < 10; i++) if (p[i] > p[b]) b = i; return b; }

  /* ---- state ---- */
  var eps = 0.10;
  var img = new Float32Array(784);     // the (paintable) clean image
  var trueLabel = null;                // null once the user draws from blank
  var target = null;                   // chosen attack target class, or null = untargeted
  var demoIdx = -1;
  var cleanP = null, advP = null, cleanH = null, advH = null;
  var gsign = new Float32Array(784), adv = new Float32Array(784);
  var dirty = true;
  var W = 0, H = 0, dpr = 1, raf = null;
  var paint = null;
  var barHit = [];                     // {d, x, y, w, h} per confidence-bar group, for click-targeting

  /* ---- advanced-mode state ---- */
  var advOn = false;                   // the Advanced checkbox
  var method = 'fgsm';                 // 'fgsm' | 'pgd' (only matters while advOn)
  var pgdSteps = 10;                   // 1..20
  var pgdJob = null, pgdProgress = ''; // chunked main-attack job + "step k/N" text
  var EPS_N = 13;                      // curve grid: eps = 0..0.30 step 0.025
  function epsAt(i) { return i * 0.025; }
  var curveCache = {};                 // methodKey -> {std:[acc], rob:[acc]}
  var curveJob = null, curveDeb = null;
  var digitTx = null, digitTxTimer = null;   // 2x2 booleans for the current digit
  var aggTx = null, aggJob = null, aggTimer = null, aggCache = {}; // 2x2 flip % over the demo digits
  var demoScratch = new Float32Array(784), scratchAdv = new Float32Array(784), scratchSg = new Float32Array(784);
  var CURVE_IDLE = 'White-box attack on each model, over the 60 demo digits.';

  function useMethod() { return (advOn && method === 'pgd') ? 'pgd' : 'fgsm'; }
  function methodKey() { return useMethod() === 'pgd' ? ('pgd' + pgdSteps) : 'fgsm'; }
  function demoImage(d) { for (var i = 0; i < 784; i++) demoScratch[i] = IMGS[d * 784 + i] / 255; return demoScratch; }

  function loadDemo(step) {
    demoIdx = (demoIdx + step + M.n) % M.n;
    for (var i = 0; i < 784; i++) img[i] = IMGS[demoIdx * 784 + i] / 255;
    trueLabel = M.labels[demoIdx];
    target = null;
    dirty = true;
  }
  function recompute() {
    var f = forward(img);
    cleanP = f.p; cleanH = f.h;
    var label, dir;
    if (target != null) { label = target; dir = -1; }      // descend the target's loss → predict it
    else { label = (trueLabel != null) ? trueLabel : argmax(cleanP); dir = 1; }
    if (useMethod() === 'pgd' && eps > 0) {
      startPGD(label, dir);
    } else {
      /* the original FGSM path, byte-for-byte (also used for PGD at eps = 0,
         where the two methods coincide and the sign panel stays informative) */
      cancelPGD();
      var g = inputGrad(img, label);
      for (var i = 0; i < 784; i++) gsign[i] = dir * (g[i] > 0 ? 1 : (g[i] < 0 ? -1 : 0));
      applyEps();
    }
    if (advOn) scheduleDigitTx();
  }
  function applyEps() {
    for (var i = 0; i < 784; i++) {
      var v = img[i] + eps * gsign[i];
      adv[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
    }
    var f = forward(adv);
    advP = f.p; advH = f.h;
  }

  /* ==================== advanced mode: PGD ==================== */
  function cancelPGD() {
    if (pgdJob && pgdJob.timer) clearTimeout(pgdJob.timer);
    pgdJob = null; pgdProgress = '';
  }
  /* Iterative attack on the ACTIVE model for the main display. Chunked on a
     time budget so 20 steps cannot jank a weak phone; partial results are
     published as they land (each intermediate iterate is a valid image). */
  function startPGD(label, dir) {
    cancelPGD();
    var m = net, e0 = eps, steps = pgdSteps;
    var alpha = 1.5 * e0 / steps;
    var job = { x: new Float32Array(img), x0: new Float32Array(img), k: 0, timer: null };
    pgdJob = job;
    function publish() {
      adv.set(job.x);
      var f = forward(adv, m);
      advP = f.p; advH = f.h;
      /* the middle panel shows the accumulated perturbation, scaled to ±eps */
      for (var i = 0; i < 784; i++) {
        var v = (adv[i] - job.x0[i]) / e0;
        gsign[i] = v < -1 ? -1 : (v > 1 ? 1 : v);
      }
    }
    function slice() {
      if (pgdJob !== job) return;                    /* superseded */
      var t0 = performance.now();
      while (job.k < steps && performance.now() - t0 < 8) {
        var g = inputGrad(job.x, label, m);
        for (var i = 0; i < 784; i++) {
          var v = job.x[i] + dir * alpha * (g[i] > 0 ? 1 : (g[i] < 0 ? -1 : 0));
          var lo = job.x0[i] - e0, hi = job.x0[i] + e0;   /* project into the eps-ball */
          if (v < lo) v = lo; else if (v > hi) v = hi;
          job.x[i] = v < 0 ? 0 : (v > 1 ? 1 : v);         /* then into [0,1] */
        }
        job.k++;
      }
      publish();
      if (job.k < steps) {
        pgdProgress = 'step ' + job.k + '/' + steps;
        job.timer = setTimeout(slice, 0);
      } else {
        pgdProgress = '';
        pgdJob = null;
      }
    }
    slice();
  }

  /* One untargeted attack, on any model, for the batch machinery. */
  function craft(x0, label, m, epsA, mth, steps) {
    var x = new Float32Array(x0), i, k, v;
    if (epsA <= 0) return x;
    if (mth === 'fgsm') {
      var g = inputGrad(x, label, m);
      for (i = 0; i < 784; i++) {
        v = x[i] + epsA * (g[i] > 0 ? 1 : (g[i] < 0 ? -1 : 0));
        x[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
      }
      return x;
    }
    var alpha = 1.5 * epsA / steps;
    for (k = 0; k < steps; k++) {
      var g2 = inputGrad(x, label, m);
      for (i = 0; i < 784; i++) {
        v = x[i] + alpha * (g2[i] > 0 ? 1 : (g2[i] < 0 ? -1 : 0));
        var lo = x0[i] - epsA, hi = x0[i] + epsA;
        if (v < lo) v = lo; else if (v > hi) v = hi;
        x[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
      }
    }
    return x;
  }

  /* ==================== advanced mode: robustness curve ==================== */
  function curveHits(x0, label, m, mth, steps, hits) {
    var i, e;
    if (mth === 'fgsm') {
      /* one gradient serves every eps: the sign never changes */
      var g = inputGrad(x0, label, m);
      for (i = 0; i < 784; i++) scratchSg[i] = g[i] > 0 ? 1 : (g[i] < 0 ? -1 : 0);
      for (e = 0; e < EPS_N; e++) {
        var ep = epsAt(e);
        for (i = 0; i < 784; i++) {
          var v = x0[i] + ep * scratchSg[i];
          scratchAdv[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
        }
        if (argmax(forward(scratchAdv, m).p) === label) hits[e]++;
      }
    } else {
      for (e = 0; e < EPS_N; e++) {
        var a = craft(x0, label, m, epsAt(e), 'pgd', steps);
        if (argmax(forward(a, m).p) === label) hits[e]++;
      }
    }
  }
  function ensureCurve() {
    if (!advOn) return;
    var key = methodKey();
    if (curveCache[key]) {
      if (curveJob && curveJob.timer) clearTimeout(curveJob.timer);
      curveJob = null;
      if (curveNote) curveNote.textContent = CURVE_IDLE;
      drawCurve();
      return;
    }
    startCurveJob(key);
  }
  function startCurveJob(key) {
    if (curveJob && curveJob.timer) clearTimeout(curveJob.timer);
    var job = { key: key, mth: useMethod(), steps: pgdSteps, d: 0,
                hits: [new Float32Array(EPS_N), new Float32Array(EPS_N)], timer: null };
    curveJob = job;
    if (curveNote) curveNote.textContent = 'computing 0%';
    drawCurve();
    function slice() {
      if (curveJob !== job || !advOn) return;
      var t0 = performance.now();
      while (job.d < M.n && performance.now() - t0 < 12) {
        var x0 = demoImage(job.d), label = M.labels[job.d];
        curveHits(x0, label, STD, job.mth, job.steps, job.hits[0]);
        curveHits(x0, label, ROB, job.mth, job.steps, job.hits[1]);
        job.d++;
      }
      if (job.d < M.n) {
        if (curveNote) curveNote.textContent = 'computing ' + Math.round(job.d * 100 / M.n) + '%';
        job.timer = setTimeout(slice, 0);
      } else {
        var out = { std: [], rob: [] };
        for (var i = 0; i < EPS_N; i++) { out.std.push(job.hits[0][i] / M.n); out.rob.push(job.hits[1][i] / M.n); }
        curveCache[job.key] = out;
        curveJob = null;
        if (curveNote) curveNote.textContent = CURVE_IDLE;
        drawCurve();
      }
    }
    job.timer = setTimeout(slice, 0);
  }
  function drawCurve() {
    if (!curveCanvas || !advOn || !elSec || elSec.hidden) return;
    var cw = curveCanvas.clientWidth, ch = curveCanvas.clientHeight;
    if (!cw || !ch) return;
    var d = Math.min(window.devicePixelRatio || 1, 2);
    curveCanvas.width = Math.round(cw * d);
    curveCanvas.height = Math.round(ch * d);
    var g = curveCanvas.getContext('2d');
    if (!g) return;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, cw, ch);
    var ml = 34, mr = 10, mt = 8, mb = 16;
    var pw = cw - ml - mr, ph = ch - mt - mb;
    function X(e) { return ml + (e / 0.30) * pw; }
    function Y(a) { return mt + (1 - a) * ph; }
    g.font = '10px "Source Sans 3", system-ui, sans-serif';
    g.strokeStyle = 'rgba(127,127,127,0.25)'; g.lineWidth = 1;
    g.fillStyle = textColor(0.55);
    g.textAlign = 'right'; g.textBaseline = 'middle';
    var yv = [0, 0.5, 1], i;
    for (i = 0; i < yv.length; i++) {
      var yy = Y(yv[i]);
      g.beginPath(); g.moveTo(ml, yy); g.lineTo(cw - mr, yy); g.stroke();
      g.fillText(Math.round(yv[i] * 100) + '%', ml - 4, yy);
    }
    g.textAlign = 'center'; g.textBaseline = 'top';
    var xv = [0, 0.1, 0.2, 0.3];
    for (i = 0; i < xv.length; i++) g.fillText(String(xv[i]), X(xv[i]), mt + ph + 4);
    /* the current eps, as a dashed vertical tick */
    var ex = X(Math.max(0, Math.min(eps, 0.30)));
    g.strokeStyle = textColor(0.45);
    g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(ex, mt); g.lineTo(ex, mt + ph); g.stroke();
    g.setLineDash([]);
    var data = curveCache[methodKey()];
    if (!data) return;
    function line(arr, col) {
      g.strokeStyle = col; g.lineWidth = 2; g.beginPath();
      for (var k = 0; k < arr.length; k++) {
        var px = X(epsAt(k)), py = Y(arr[k]);
        if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.stroke();
    }
    line(data.std, accent());
    line(data.rob, 'rgba(127,127,127,0.95)');
  }

  /* ==================== advanced mode: transfer ==================== */
  function scheduleDigitTx() {
    if (!advOn) return;
    clearTimeout(digitTxTimer);
    digitTxTimer = setTimeout(computeDigitTx, 140);
  }
  function computeDigitTx() {
    if (!advOn) return;
    var mth = useMethod(), models = [STD, ROB], out = [], s, t;
    for (s = 0; s < 2; s++) {
      var src = models[s];
      var lab = (trueLabel != null) ? trueLabel : argmax(forward(img, src).p);
      var a = craft(img, lab, src, eps, mth, pgdSteps);
      var row = [];
      for (t = 0; t < 2; t++) {
        var m2 = models[t];
        row.push(argmax(forward(a, m2).p) !== argmax(forward(img, m2).p));
      }
      out.push(row);
    }
    digitTx = out;
    renderTransfer();
  }
  function scheduleAggTx() {
    if (!advOn) return;
    clearTimeout(aggTimer);
    aggTimer = setTimeout(ensureAggTx, 300);
  }
  function ensureAggTx() {
    if (!advOn) return;
    var key = methodKey() + '|' + eps.toFixed(3);
    if (aggCache[key]) {
      if (aggJob && aggJob.timer) clearTimeout(aggJob.timer);
      aggJob = null;
      aggTx = aggCache[key];
      if (txNote) txNote.textContent = '';
      renderTransfer();
      return;
    }
    startAggJob(key);
  }
  function startAggJob(key) {
    if (aggJob && aggJob.timer) clearTimeout(aggJob.timer);
    var job = { key: key, mth: useMethod(), steps: pgdSteps, eps: eps, d: 0,
                flips: [[0, 0], [0, 0]], timer: null };
    aggJob = job;
    aggTx = null;
    renderTransfer();
    function slice() {
      if (aggJob !== job || !advOn) return;
      var t0 = performance.now();
      while (job.d < M.n && performance.now() - t0 < 12) {
        var x0 = demoImage(job.d), label = M.labels[job.d];
        for (var s = 0; s < 2; s++) {
          var a = craft(x0, label, s === 0 ? STD : ROB, job.eps, job.mth, job.steps);
          for (var t = 0; t < 2; t++) {
            var mm = t === 0 ? STD : ROB;
            if (argmax(forward(a, mm).p) !== argmax(forward(x0, mm).p)) job.flips[s][t]++;
          }
        }
        job.d++;
      }
      if (job.d < M.n) {
        if (txNote) txNote.textContent = 'measuring transfer ' + Math.round(job.d * 100 / M.n) + '%';
        job.timer = setTimeout(slice, 0);
      } else {
        var out = [[0, 0], [0, 0]];
        for (var s2 = 0; s2 < 2; s2++) for (var t2 = 0; t2 < 2; t2++) out[s2][t2] = Math.round(job.flips[s2][t2] * 100 / M.n);
        aggCache[job.key] = out;
        aggTx = out;
        aggJob = null;
        if (txNote) txNote.textContent = '';
        renderTransfer();
      }
    }
    job.timer = setTimeout(slice, 0);
  }
  function renderTransfer() {
    if (!txGrid || !advOn) return;
    var names = ['standard', 'adv-trained'];
    var act = (net === ROB) ? 1 : 0;
    var h = '<span></span><span class="adv-tx__h">standard</span><span class="adv-tx__h">adv-trained</span>';
    for (var s = 0; s < 2; s++) {
      h += '<span class="adv-tx__h' + (s === act ? ' adv-tx__h--on' : '') + '">from ' + names[s] + '</span>';
      for (var t = 0; t < 2; t++) {
        var cur = digitTx ? (digitTx[s][t] ? '<b class="adv-tx__yes">flips</b>' : '<span class="adv-tx__no">holds</span>') : '&hellip;';
        var agg = aggTx ? ' &middot; ' + aggTx[s][t] + '%' : '';
        h += '<span>' + cur + agg + '</span>';
      }
    }
    txGrid.innerHTML = h;
  }
  function stopAdvancedJobs() {
    cancelPGD();
    if (curveJob && curveJob.timer) clearTimeout(curveJob.timer);
    curveJob = null;
    if (aggJob && aggJob.timer) clearTimeout(aggJob.timer);
    aggJob = null;
    clearTimeout(digitTxTimer); clearTimeout(aggTimer); clearTimeout(curveDeb);
  }

  /* ---- rendering helpers ---- */
  function effectiveTheme() {
    var f = document.documentElement.getAttribute('data-theme');
    if (f === 'light' || f === 'dark') return f;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }
  function bg() { return effectiveTheme() === 'light' ? '#f3f5f8' : '#0e1014'; }
  function accent() { return effectiveTheme() === 'light' ? '#34568a' : '#82a6cc'; }
  function nodeColor() { return effectiveTheme() === 'light' ? '#c0892e' : '#e0b24a'; } /* gold (ties to the site favicon); distinct from the blue connection lines */
  function badColor() { return '#c4574a'; }
  function textColor(a) { return effectiveTheme() === 'light' ? 'rgba(38,38,38,' + a + ')' : 'rgba(214,214,214,' + a + ')'; }

  var off = document.createElement('canvas'); off.width = 28; off.height = 28;
  var offCtx = off.getContext('2d');
  var pix = offCtx.createImageData(28, 28);
  function blit(data, mode) {
    var lightT = effectiveTheme() === 'light';
    for (var i = 0; i < 784; i++) {
      var v, r, g2, b;
      if (mode === 'sign') { v = Math.round(127 + data[i] * 110); r = g2 = b = v; }
      else {
        v = Math.round(data[i] * 255);
        if (lightT) { r = g2 = b = 255 - v; } else { r = g2 = b = v; }
      }
      pix.data[i * 4] = r; pix.data[i * 4 + 1] = g2; pix.data[i * 4 + 2] = b; pix.data[i * 4 + 3] = 255;
    }
    offCtx.putImageData(pix, 0, 0);
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* panel geometry — center the row in the space LEFT of the controls panel */
  function layout() {
    var avail = W;
    if (W > 860 && elPanel && !elPanel.classList.contains('adv-panel--collapsed')) {
      avail = W - elPanel.offsetWidth - 56;
    }
    var S = Math.min(H * 0.30, (avail - 130) / 3);
    S = Math.max(78, S);
    var gap = Math.max(28, S * 0.2);
    var total = S * 3 + gap * 2;
    var x0 = Math.max(12, (avail - total) / 2), y0 = Math.max(82, H * 0.32 - S / 2);
    return { S: S, gap: gap, cx: x0 + total / 2, x: [x0, x0 + S + gap, x0 + (S + gap) * 2], y: y0 };
  }

  function drawPanel(data, mode, x, y, S, caption, captionColor) {
    blit(data, mode);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, x, y, S, S);
    ctx.imageSmoothingEnabled = true;
    ctx.strokeStyle = 'rgba(127,127,127,0.45)'; ctx.lineWidth = 1;
    ctx.strokeRect(x - 0.5, y - 0.5, S + 1, S + 1);
    ctx.font = Math.max(12, S * 0.1) + 'px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = captionColor || textColor(0.85);
    ctx.fillText(caption, x + S / 2, y + S + 9);
  }

  // A live node-link diagram of the forward pass on the attacked image:
  //   input image → 64 hidden units → 10 outputs.
  // Line WIDTH encodes the network weight; line BRIGHTNESS encodes the activation
  // flowing through it (so only the active sub-network "lights up"); node color
  // encodes activation. Dead ReLU units (activation 0) contribute nothing, so we
  // skip their lines — which keeps the picture clean and honest.
  function drawNetwork(L, top, bot, hAct, p, predIdx, fooled) {
    var netW = Math.min(L.cx * 2 - 56, 560);
    var imgR = Math.min(42, (bot - top) * 0.26);
    var xImg = L.cx - netW / 2 + imgR;
    var xHid = L.cx - netW * 0.16;        // hidden layer sits left, near the image: the
    var xOut = L.cx + netW / 2 - 16;       // simple image→hidden fan is compact, the complex
    var yImg = (top + bot) / 2;            // hidden→output fan gets most of the width
    var ac = accent(), nc = nodeColor(), maxAct = 1e-6, i, o;
    for (i = 0; i < HID; i++) if (hAct[i] > maxAct) maxAct = hAct[i];
    function hy(h) { return top + (h + 0.5) / HID * (bot - top); }
    function oy(d) { return top + (d + 0.7) / 10 * (bot - top); }

    /* input image → hidden (faint fan, only to active units) */
    for (i = 0; i < HID; i++) {
      var a = hAct[i] / maxAct;
      if (a < 0.02) continue;
      ctx.strokeStyle = ac; ctx.globalAlpha = 0.03 + 0.22 * a; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(xImg + imgR, yImg); ctx.lineTo(xHid, hy(i)); ctx.stroke();
    }
    /* hidden → output (width = |weight|, brightness = source activation) */
    for (i = 0; i < HID; i++) {
      var act = hAct[i] / maxAct;
      if (act < 0.02) continue;                 // dead unit: no contribution
      for (o = 0; o < 10; o++) {
        var w = net.W2[i * 10 + o];
        ctx.strokeStyle = ac;
        ctx.globalAlpha = (0.02 + 0.5 * act) * Math.min(1, Math.abs(w) / net.maxW2 + 0.15);
        ctx.lineWidth = 0.2 + 2.0 * Math.abs(w) / net.maxW2;
        ctx.beginPath(); ctx.moveTo(xHid, hy(i)); ctx.lineTo(xOut, oy(o)); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    /* input image */
    blit(adv, 'img');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, xImg - imgR, yImg - imgR, imgR * 2, imgR * 2);
    ctx.imageSmoothingEnabled = true;
    ctx.strokeStyle = 'rgba(127,127,127,0.45)'; ctx.lineWidth = 1;
    ctx.strokeRect(xImg - imgR - 0.5, yImg - imgR - 0.5, imgR * 2 + 1, imgR * 2 + 1);

    /* hidden nodes (gold) */
    for (i = 0; i < HID; i++) {
      var an = hAct[i] / maxAct;
      ctx.beginPath(); ctx.arc(xHid, hy(i), 2.2, 0, 6.2832);
      ctx.fillStyle = nc; ctx.globalAlpha = 0.22 + 0.78 * an; ctx.fill();
    }
    ctx.globalAlpha = 1;

    /* output nodes (gold; opacity = probability ≈ the summed input) + labels */
    ctx.font = '600 12px "Source Sans 3", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (o = 0; o < 10; o++) {
      var y = oy(o), isPred = (o === predIdx);
      ctx.beginPath(); ctx.arc(xOut, y, 6, 0, 6.2832);
      ctx.fillStyle = (fooled && isPred) ? badColor() : nc;
      ctx.globalAlpha = 0.2 + 0.8 * p[o]; ctx.fill(); ctx.globalAlpha = 1;
      if (isPred) { ctx.strokeStyle = (fooled ? badColor() : nc); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(xOut, y, 8.5, 0, 6.2832); ctx.stroke(); }
      ctx.fillStyle = isPred ? (fooled ? badColor() : textColor(0.95)) : textColor(0.5);
      ctx.textAlign = 'left'; ctx.fillText(o, xOut + 13, y);
    }

    /* layer captions */
    ctx.font = '11px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = textColor(0.5);
    ctx.fillText('attacked image', xImg, yImg + imgR + 6);
    ctx.fillText('64 hidden units', xHid, bot + 4);
    ctx.fillText('output', xOut, bot + 4);
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = textColor(0.6);
    ctx.fillText('inside the network: blue = connections (width = weight), gold = neuron activity', L.cx, top - 8);
  }

  function draw() {
    raf = requestAnimationFrame(draw);
    if (!W || !H) { resize(); if (!W || !H) return; }
    if (dirty) { recompute(); dirty = false; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = bg(); ctx.fillRect(0, 0, W, H);

    var L = layout(), S = L.S, y = L.y;
    var ci = argmax(cleanP), ai = argmax(advP);
    var fooled = ai !== ci;

    drawPanel(img, 'img', L.x[0], y, S, 'model sees ' + ci + ' · ' + (cleanP[ci] * 100).toFixed(1) + '%');
    var noiseCap = 'ε · sign(∇ₓ loss)';
    if (useMethod() === 'pgd' && eps > 0) {
      noiseCap = pgdProgress ? ('PGD · ' + pgdProgress)
        : ('PGD noise · ' + pgdSteps + (pgdSteps === 1 ? ' step' : ' steps'));
    }
    drawPanel(gsign, 'sign', L.x[1], y, S, noiseCap, textColor(0.6));
    drawPanel(adv, 'img', L.x[2], y, S,
      'model sees ' + ai + ' · ' + (advP[ai] * 100).toFixed(1) + '%',
      fooled ? badColor() : textColor(0.85));

    ctx.font = '300 ' + S * 0.32 + 'px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = textColor(0.6);
    ctx.fillText('+', L.x[0] + S + L.gap / 2, y + S / 2);
    ctx.fillText('=', L.x[1] + S + L.gap / 2, y + S / 2);

    /* grouped confidence bars (clickable to aim the attack) */
    var bw = Math.min(24, (L.cx * 2 - 80) / 34), bgap = bw * 0.5, gw = bw * 2 + 3;
    var bx0 = L.cx - (gw * 10 + bgap * 9) / 2;
    var bh = Math.min(78, H * 0.12), by = y + S + S * 0.26 + bh;
    var labelFs = Math.max(11, bw * 0.6);
    ctx.font = labelFs + 'px "Source Sans 3", system-ui, sans-serif';
    barHit = [];
    for (var d2 = 0; d2 < 10; d2++) {
      var gx = bx0 + d2 * (gw + bgap);
      if (target === d2) {                 // highlight the aimed-at digit
        ctx.fillStyle = 'rgba(196,87,74,0.12)';
        ctx.fillRect(gx - bgap / 2, by - bh - 6, gw + bgap, bh + labelFs + 12);
      }
      ctx.fillStyle = accent();
      ctx.fillRect(gx, by - bh * cleanP[d2], bw, bh * cleanP[d2]);
      ctx.fillStyle = (fooled && d2 === ai) ? badColor() : 'rgba(127,127,127,0.55)';
      ctx.fillRect(gx + bw + 3, by - bh * advP[d2], bw, bh * advP[d2]);
      ctx.fillStyle = (target === d2) ? badColor() : textColor(d2 === ci || d2 === ai ? 0.9 : 0.45);
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(d2, gx + gw / 2, by + 5);
      barHit.push({ d: d2, x: gx - bgap / 2, y: by - bh - 6, w: gw + bgap, h: bh + labelFs + 12 });
    }
    ctx.fillStyle = textColor(0.5);
    ctx.textAlign = 'center';
    var legend = 'confidence — original (blue) vs adversarial (grey). Click a bar to aim the attack at that digit.';
    ctx.fillText(legend, L.cx, by + 5 + labelFs + 5);

    /* live node-link view of the forward pass on the attacked image */
    var netTop = by + labelFs + 50, netBottom = H - 26;
    if (netBottom - netTop > 70) drawNetwork(L, netTop, netBottom, advH, advP, ai, fooled);

    if (status) {
      var modelName = (net === ROB) ? 'adversarially-trained model' : 'standard model';
      var aim = (target != null) ? (' (aimed at ' + target + ')') : '';
      if (fooled) status.textContent = 'Fooled the ' + modelName + aim + ': "' + ci + '" became "' + ai + '" with at most ' + Math.round(eps * 100) + '% per-pixel change.';
      else if (eps === 0) status.textContent = 'Slide ε up to start attacking the ' + modelName + '.';
      else status.textContent = 'The ' + modelName + ' is holding at ε = ' + eps.toFixed(2) + aim + '. Keep sliding, or aim at a digit.';
    }
  }

  /* ---- painting on the left panel + clicking bars to target ---- */
  function rel(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function paintAt(p, erase) {
    var L = layout(), S = L.S;
    var fx = (p.x - L.x[0]) / S * 28, fy = (p.y - L.y) / S * 28;
    if (fx < -2 || fy < -2 || fx > 30 || fy > 30) return false;
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        var x = Math.round(fx + dx), y = Math.round(fy + dy);
        if (x < 0 || y < 0 || x > 27 || y > 27) continue;
        var w = (dx === 0 && dy === 0) ? 1 : 0.45;
        var i = y * 28 + x;
        img[i] = erase ? Math.max(0, img[i] - w) : Math.min(1, img[i] + w * 0.9);
      }
    }
    dirty = true;
    return true;
  }
  canvas.addEventListener('pointerdown', function (e) {
    var p = rel(e), L = layout();
    /* left image → paint */
    if (p.x >= L.x[0] - 8 && p.x <= L.x[0] + L.S + 8 && p.y >= L.y - 8 && p.y <= L.y + L.S + 8) {
      paint = { erase: e.button === 2 };
      paintAt(p, paint.erase);
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
      return;
    }
    /* confidence bar → aim the attack (toggle off if the same digit) */
    for (var i = 0; i < barHit.length; i++) {
      var b = barHit[i];
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
        target = (target === b.d) ? null : b.d;
        dirty = true;
        e.preventDefault();
        return;
      }
    }
  });
  canvas.addEventListener('pointermove', function (e) { if (paint) paintAt(rel(e), paint.erase); });
  canvas.addEventListener('pointerup', function () { paint = null; });
  canvas.addEventListener('pointercancel', function () { paint = null; });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  /* ---- controls ---- */
  if (elEps) elEps.addEventListener('input', function () {
    eps = +elEps.value;
    if (elEpsV) elEpsV.textContent = eps.toFixed(2);
    if (useMethod() === 'pgd') dirty = true;   /* PGD must re-run; the path depends on eps */
    else applyEps();
    if (advOn) { drawCurve(); scheduleDigitTx(); scheduleAggTx(); }
  });
  if (btnNext) btnNext.addEventListener('click', function () { loadDemo(1); });
  if (btnPrev) btnPrev.addEventListener('click', function () { loadDemo(-1); });
  if (btnClear) btnClear.addEventListener('click', function () { img.fill(0); trueLabel = null; target = null; dirty = true; });
  if (elRobust) elRobust.addEventListener('change', function () {
    net = elRobust.checked ? ROB : STD; dirty = true;
    if (advOn) renderTransfer();               /* the "from …" row marker follows the active model */
  });
  /* panel collapse + first-run hint (shared helper) */
  if (window.GadgetUI) {
    var frHint = GadgetUI.firstRunHint('adversarial', 'Paint a digit, then raise ε. Press and hold to erase.');
    GadgetUI.initPanel({
      panel: elPanel, toggle: elCollapse,
      collapsedClass: 'adv-panel--collapsed',
      help: id('adv-help'), hint: frHint,
      onToggle: function (c) {
        /* the curve canvas has zero size while collapsed, so repaint on expand */
        if (!c && advOn) drawCurve();
      }
    });
    /* touch parity: press and hold on the drawing panel, then drag, to erase
       (a mouse right-drag does the same) */
    GadgetUI.longPress(canvas, function (pt) {
      if (!paint) return;
      paint.erase = true;
      paintAt(rel(pt), true);
    });
  }

  /* ---- advanced-mode controls ---- */
  function syncAdvanced() {
    advOn = !!(elAdv && elAdv.checked);
    if (elSec) elSec.hidden = !advOn;
    dirty = true;                              /* re-run the attack with or without PGD */
    if (advOn) {
      renderTransfer();
      ensureCurve();                           /* lazy: computes on first open, cached after */
      scheduleDigitTx();
      ensureAggTx();
    } else {
      stopAdvancedJobs();
    }
  }
  function setMethod(mth) {
    if (method === mth) return;
    method = mth;
    if (btnFgsm) { btnFgsm.classList.toggle('adv-seg__btn--on', mth === 'fgsm'); btnFgsm.setAttribute('aria-pressed', mth === 'fgsm' ? 'true' : 'false'); }
    if (btnPgd) { btnPgd.classList.toggle('adv-seg__btn--on', mth === 'pgd'); btnPgd.setAttribute('aria-pressed', mth === 'pgd' ? 'true' : 'false'); }
    if (stepsRow) stepsRow.hidden = (mth !== 'pgd');
    dirty = true;
    if (advOn) { ensureCurve(); scheduleDigitTx(); scheduleAggTx(); }
  }
  if (elAdv) {
    elAdv.addEventListener('change', syncAdvanced);
    if (elAdv.checked) syncAdvanced();         /* browsers restore checkbox state on reload */
  }
  if (btnFgsm) btnFgsm.addEventListener('click', function () { setMethod('fgsm'); });
  if (btnPgd) btnPgd.addEventListener('click', function () { setMethod('pgd'); });
  if (elSteps) {
    var readSteps = function () {
      var v = Math.round(+elSteps.value);
      if (!(v >= 1)) v = 1; else if (v > 20) v = 20;
      pgdSteps = v;
      if (elStepsV) elStepsV.textContent = String(v);
    };
    readSteps();
    elSteps.addEventListener('input', function () {
      readSteps();
      if (method !== 'pgd') return;
      dirty = true;
      if (advOn) {
        clearTimeout(curveDeb);
        curveDeb = setTimeout(ensureCurve, 350);  /* don't recompute the curve on every tick of a drag */
        scheduleDigitTx();
        scheduleAggTx();
      }
    });
  }

  /* ---- share link + PNG snapshot (shared codec in share-hash.js) ----
     Shares the settings + the selected demo digit, NOT a painted canvas. */
  var SH = window.ShareHash;
  var btnShare = id('adv-share'), btnSnap = id('adv-snap');
  function shareState() {
    return { e: Math.round(eps * 100) / 100, d: demoIdx, m: (net === ROB) ? 1 : 0,
             a: advOn ? 1 : 0, pg: (method === 'pgd') ? 1 : 0, st: pgdSteps };
  }
  /* Restore shared settings (untrusted hash: clamp everything). Returns the
     demo-digit index to load, or null when there is nothing to restore. */
  function applyShared() {
    var d = SH.decode(SH.readHash());
    if (!d || d.version !== 1) return null;
    var o = d.obj;
    eps = SH.num(o.e, 0, 0.3, 0.10);
    if (elEps) elEps.value = eps;
    if (elEpsV) elEpsV.textContent = eps.toFixed(2);
    if (o.m && elRobust) { elRobust.checked = true; net = ROB; }
    pgdSteps = SH.int(o.st, 1, 20, 10);
    if (elSteps) elSteps.value = pgdSteps;
    if (elStepsV) elStepsV.textContent = String(pgdSteps);
    if (o.pg) setMethod('pgd');
    if (o.a && elAdv) { elAdv.checked = true; syncAdvanced(); }
    return SH.int(o.d, 0, M.n - 1, 0);
  }
  if (btnShare && SH) btnShare.addEventListener('click', function () {
    SH.copyLink(btnShare, SH.encode(1, shareState()));
  });
  if (btnSnap && SH) btnSnap.addEventListener('click', function () {
    /* the rAF loop keeps the canvas fresh; capture it as-is */
    SH.savePng(canvas, {
      label: 'Fool a neural network', file: 'adversarial-example.png',
      light: effectiveTheme() === 'light', bg: bg()
    });
  });

  var rt;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { resize(); drawCurve(); }, 150); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (raf) { cancelAnimationFrame(raf); raf = null; } }
    else if (!raf) raf = requestAnimationFrame(draw);
  });
  try {
    new MutationObserver(function () { dirty = true; drawCurve(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  } catch (e) {}
  try {
    var mql = window.matchMedia('(prefers-color-scheme: light)');
    var onScheme = function () { dirty = true; drawCurve(); };
    if (mql.addEventListener) mql.addEventListener('change', onScheme);
    else if (mql.addListener) mql.addListener(onScheme);
  } catch (e) {}

  if (elEpsV) elEpsV.textContent = eps.toFixed(2);
  resize();
  var sharedIdx = SH ? applyShared() : null;   /* shared settings in the URL replace the defaults */
  /* demoIdx starts at -1, so stepping by idx+1 lands exactly on idx */
  loadDemo(sharedIdx != null ? sharedIdx + 1 : 1 + Math.floor(Math.random() * M.n));
  raf = requestAnimationFrame(draw);
})();
