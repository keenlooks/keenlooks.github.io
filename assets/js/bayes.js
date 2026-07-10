/* ==========================================================================
   Base rates & Bayes — why a positive result on an accurate test is usually
   wrong when the condition is rare.
   --------------------------------------------------------------------------
   A 100x100 grid of 10,000 dots, one per person (or per network event in the
   security framing). Sliders set prevalence (log scale, 0.01%..10%), test
   sensitivity, and specificity. "Test everyone" sweeps a wave across the grid
   resolving each dot: true positive (filled accent), false positive (muted
   red), false negative (hollow accent), true negative (near-invisible grey).

   The headline is the positive predictive value,
     PPV = sens*prev / (sens*prev + (1-spec)*(1-prev)).
   Counts are quantized to whole people (prevalence snaps to at least 1 in
   10,000) so the grid, the counts line, and the headline stay coherent.

   Prevalence click-to-type goes through a hidden proxy range input
   (#bayes-prev-num) because editable-values.js writes the typed number
   straight into its data-range target: the proxy holds the LINEAR value
   (percent in medical mode, count-per-10k in security mode) and our input
   handler converts it to the visible slider's log position.

   Theme-aware (effectiveTheme + MutationObserver + matchMedia), DPR-capped
   at 2 but sized in CSS pixels, Pointer Events for the hover probe, honors
   prefers-reduced-motion (dots resolve instantly, no wave). Rendering uses
   five pre-rendered dot sprites so a full 10k-dot redraw stays cheap during
   the 1.2 s wave; there is no idle animation loop.
   ========================================================================== */
(function () {
  'use strict';
  var canvas = document.getElementById('bayes-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  function id(x) { return document.getElementById(x); }

  var COLS = 100, ROWS = 100, N = COLS * ROWS;
  // status codes double as sprite indices
  var TN = 0, FP = 1, FN = 2, TP = 3, UNTESTED = 4;

  var elPrev = id('bayes-prev'), elPrevVal = id('bayes-prev-val'),
      elPrevNum = id('bayes-prev-num'), elPrevUnit = id('bayes-prev-unit'),
      elPrevLabel = id('bayes-prev-label'), elPrevHint = id('bayes-prev-hint');
  var elSens = id('bayes-sens'), elSensVal = id('bayes-sens-val'),
      elSensLabel = id('bayes-sens-label'), elSensHint = id('bayes-sens-hint');
  var elSpec = id('bayes-spec'), elSpecVal = id('bayes-spec-val'),
      elSpecLabel = id('bayes-spec-label'), elSpecHint = id('bayes-spec-hint');
  var btnRun = id('bayes-run');
  var btnMed = id('bayes-mode-med'), btnSec = id('bayes-mode-sec');
  var roQ1 = id('bayes-q1'), roQ2 = id('bayes-q2'), roPpv = id('bayes-ppv'),
      roCounts = id('bayes-counts');
  var probe = id('bayes-probe'), socNote = id('bayes-soc');
  var keyTp = id('bayes-key-tp'), keyFp = id('bayes-key-fp'),
      keyFn = id('bayes-key-fn'), keyTn = id('bayes-key-tn');

  // state (defaults read from the DOM sliders below, in init)
  var s = { logPrev: Math.log10(0.5), sens: 0.99, spec: 0.99, mode: 'medical' };
  // derived whole-person counts
  var d = { sick: 50, tp: 50, fn: 0, fp: 100, tn: 9850 };

  var status = new Uint8Array(N);
  // one fixed random permutation: perm[0..sick-1] are the sick dots, so
  // changing prevalence adds/removes sick dots without reshuffling the rest
  var perm = new Uint32Array(N);
  (function shuffle() {
    var i, j, t;
    for (i = 0; i < N; i++) perm[i] = i;
    for (i = N - 1; i > 0; i--) {
      j = Math.floor(Math.random() * (i + 1));
      t = perm[i]; perm[i] = perm[j]; perm[j] = t;
    }
  })();

  // ---- theme ---------------------------------------------------------------
  function effectiveTheme() {
    var f = document.documentElement.getAttribute('data-theme');
    if (f === 'light' || f === 'dark') return f;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }
  function palette() {
    var light = effectiveTheme() === 'light';
    return {
      accent:   light ? '#34568a' : '#82a6cc',                 // true positives
      fp:       light ? 'rgba(180,69,47,0.88)' : 'rgba(217,139,118,0.88)', // muted red, matches the loans "cost" red
      fnRing:   light ? 'rgba(52,86,138,0.60)' : 'rgba(130,166,204,0.60)',
      tn:       light ? 'rgba(0,0,0,0.09)'     : 'rgba(255,255,255,0.09)',
      untested: light ? 'rgba(0,0,0,0.20)'     : 'rgba(255,255,255,0.20)',
      front0:   light ? 'rgba(52,86,138,0)'    : 'rgba(130,166,204,0)',
      front1:   light ? 'rgba(52,86,138,0.35)' : 'rgba(130,166,204,0.40)'
    };
  }
  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // ---- math ----------------------------------------------------------------
  function computeDerived() {
    var pct = Math.pow(10, s.logPrev);                       // percent of the population
    var sick = Math.max(1, Math.min(N, Math.round(pct * 100)));
    d.sick = sick;
    d.tp = Math.max(0, Math.min(sick, Math.round(s.sens * sick)));
    d.fn = sick - d.tp;
    var healthy = N - sick;
    d.fp = Math.max(0, Math.min(healthy, Math.round((1 - s.spec) * healthy)));
    d.tn = healthy - d.fp;
  }
  function assignStatuses() {
    var a = d.sick, b = d.tp, c = a + d.fp;
    for (var k = 0; k < N; k++) {
      status[perm[k]] = (k < b) ? TP : (k < a) ? FN : (k < c) ? FP : TN;
    }
  }
  function ppv() {
    var p = d.sick / N;
    var num = s.sens * p;
    return num / (num + (1 - s.spec) * (1 - p));
  }

  // ---- formatting ------------------------------------------------------------
  function fmtN(n) { return n.toLocaleString('en-US'); }
  function fmtPct(x) { return String(+x.toFixed(2)) + '%'; }
  function fmtPpv(f) {
    var p = f * 100;
    if (p < 1) return p.toFixed(2) + '%';
    if (p < 10) return p.toFixed(1) + '%';
    return Math.round(p) + '%';
  }

  // ---- per-mode copy ---------------------------------------------------------
  var TXT = {
    medical: {
      q1: 'You tested positive.',
      q2: 'The chance you actually have it:',
      prevLabel: 'Prevalence',
      prevUnit: '',
      prevHint: 'how common the condition is',
      sensLabel: 'Test sensitivity',
      sensHint: 'share of sick people the test catches',
      specLabel: 'Test specificity',
      specHint: 'share of healthy people the test correctly clears',
      run: 'Test everyone',
      keyTp: 'Sick and tests positive',
      keyFp: 'Healthy but tests positive (false alarm)',
      keyFn: 'Sick but the test misses it',
      keyTn: 'Healthy and tests negative',
      probeDefault: "Hover over a dot to see one person's result.",
      probeUntested: 'This person has not been tested yet.',
      probeTp: 'Sick, and the test caught it.',
      probeFp: 'Healthy, but flagged positive anyway.',
      probeFn: 'Sick, but the test missed it.',
      probeTn: 'Healthy, and correctly cleared.'
    },
    security: {
      q1: 'An alert fired.',
      q2: 'The chance it is a real intrusion:',
      prevLabel: 'Intrusion rate',
      prevUnit: ' per 10,000 events',
      prevHint: 'how many events are real intrusions',
      sensLabel: 'Detection rate',
      sensHint: 'share of real intrusions that raise an alert',
      specLabel: 'Specificity',
      specHint: 'share of benign events the detector correctly ignores',
      run: 'Scan all events',
      keyTp: 'Real intrusion, alert fires',
      keyFp: 'Benign event, alert fires (false alarm)',
      keyFn: 'Real intrusion, no alert',
      keyTn: 'Benign event, no alert',
      probeDefault: "Hover over a dot to see one event's outcome.",
      probeUntested: 'This event has not been scanned yet.',
      probeTp: 'A real intrusion, and the alert fired.',
      probeFp: 'A benign event that still raised an alert.',
      probeFn: 'A real intrusion that raised no alert.',
      probeTn: 'A benign event, no alert.'
    }
  };
  function countsHtml() {
    var a = d.sick, b = d.tp, c = d.fp;
    if (s.mode === 'security') {
      return 'Out of 10,000 events: <strong>' + fmtN(a) + '</strong> ' +
        (a === 1 ? 'is a real intrusion' : 'are real intrusions') +
        ' and <strong>' + fmtN(b) + '</strong> of them ' +
        (b === 1 ? 'raises an alert' : 'raise alerts') +
        '. <strong>' + fmtN(c) + '</strong> benign ' +
        (c === 1 ? 'event' : 'events') + ' <em>also</em> ' +
        (c === 1 ? 'raises an alert' : 'raise alerts') + '.';
    }
    return 'Out of 10,000 people: <strong>' + fmtN(a) + '</strong> ' +
      (a === 1 ? 'is' : 'are') + ' sick and <strong>' + fmtN(b) + '</strong> of them ' +
      (b === 1 ? 'tests' : 'test') + ' positive. <strong>' + fmtN(c) + '</strong> healthy ' +
      (c === 1 ? 'person' : 'people') + ' <em>also</em> ' +
      (c === 1 ? 'tests' : 'test') + ' positive.';
  }

  function updateDom() {
    if (s.mode === 'security') {
      elPrevVal.textContent = fmtN(d.sick);
      elPrevNum.value = d.sick;
    } else {
      elPrevVal.textContent = fmtPct(d.sick / 100);
      elPrevNum.value = d.sick / 100;
    }
    elSensVal.textContent = String(+(s.sens * 100).toFixed(1)) + '%';
    elSpecVal.textContent = String(+(s.spec * 100).toFixed(1)) + '%';
    roPpv.textContent = fmtPpv(ppv());
    roCounts.innerHTML = countsHtml();
  }

  function applyMode(mode) {
    s.mode = mode;
    var T = TXT[mode], med = mode === 'medical';
    btnMed.classList.toggle('is-active', med);
    btnSec.classList.toggle('is-active', !med);
    btnMed.setAttribute('aria-pressed', med ? 'true' : 'false');
    btnSec.setAttribute('aria-pressed', med ? 'false' : 'true');
    roQ1.textContent = T.q1;
    roQ2.textContent = T.q2;
    elPrevLabel.textContent = T.prevLabel;
    elPrevUnit.textContent = T.prevUnit;
    elPrevHint.textContent = T.prevHint;
    elSensLabel.textContent = T.sensLabel;
    elSensHint.textContent = T.sensHint;
    elSpecLabel.textContent = T.specLabel;
    elSpecHint.textContent = T.specHint;
    btnRun.textContent = T.run;
    keyTp.textContent = T.keyTp;
    keyFp.textContent = T.keyFp;
    keyFn.textContent = T.keyFn;
    keyTn.textContent = T.keyTn;
    probe.textContent = T.probeDefault;
    // proxy bounds: percent in medical mode, count-per-10k in security mode
    if (med) { elPrevNum.min = '0.01'; elPrevNum.max = '10'; elPrevNum.step = '0.001'; }
    else     { elPrevNum.min = '1';    elPrevNum.max = '1000'; elPrevNum.step = '1'; }
    socNote.hidden = med;
    updateDom();
  }

  // ---- rendering -------------------------------------------------------------
  var W = 0, H = 0, cell = 0, sprites = null;
  function buildSprites() {
    if (!cell) return;
    var pal = palette();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var sz = Math.max(2, Math.ceil(cell * dpr));
    var defs = [
      { fill: pal.tn,       r: 0.20 },  // TN: near-invisible
      { fill: pal.fp,       r: 0.34 },  // FP: muted red, filled
      { ring: pal.fnRing,   r: 0.26 },  // FN: hollow accent
      { fill: pal.accent,   r: 0.34 },  // TP: accent, filled
      { fill: pal.untested, r: 0.23 }   // untested: mid grey
    ];
    sprites = [];
    for (var k = 0; k < defs.length; k++) {
      var c = document.createElement('canvas');
      c.width = sz; c.height = sz;
      var g = c.getContext('2d');
      var r = Math.max(0.7, defs[k].r * sz);
      g.beginPath();
      g.arc(sz / 2, sz / 2, r, 0, Math.PI * 2);
      if (defs[k].ring) {
        g.lineWidth = Math.max(1, 0.11 * sz);
        g.strokeStyle = defs[k].ring;
        g.stroke();
      } else {
        g.fillStyle = defs[k].fill;
        g.fill();
      }
      sprites[k] = c;
    }
  }
  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cell = W / COLS;
    buildSprites();
  }

  var front = 0;   // columns resolved so far (0..COLS); dots right of it are untested
  function redraw() {
    if (!W || !H) { resize(); if (!W || !H) return; }
    if (!sprites) return;
    ctx.clearRect(0, 0, W, H);
    var ch = H / ROWS, f = front;
    for (var i = 0; i < N; i++) {
      var col = i % COLS, row = (i / COLS) | 0;
      var cat = col < f ? status[i] : UNTESTED;
      ctx.drawImage(sprites[cat], col * cell, row * ch, cell, ch);
    }
    if (waving && f > 0 && f < COLS) {
      var x = (f / COLS) * W;
      var pal = palette();
      var g2 = ctx.createLinearGradient(x - 16, 0, x, 0);
      g2.addColorStop(0, pal.front0);
      g2.addColorStop(1, pal.front1);
      ctx.fillStyle = g2;
      ctx.fillRect(x - 16, 0, 16, H);
    }
  }
  var redrawQueued = false;
  function requestRedraw() {
    if (redrawQueued) return;
    redrawQueued = true;
    requestAnimationFrame(function () { redrawQueued = false; redraw(); });
  }

  // ---- the wave ---------------------------------------------------------------
  var waving = false, waveStart = 0, WAVE_MS = 1200;
  function startWave() {
    if (reducedMotion()) { waving = false; front = COLS; requestRedraw(); return; }
    waveStart = performance.now();
    front = 0;
    if (!waving) { waving = true; requestAnimationFrame(waveTick); }
  }
  function waveTick(now) {
    if (!waving) return;
    var t = (now - waveStart) / WAVE_MS;
    if (t >= 1) { waving = false; front = COLS; redraw(); return; }
    front = t * COLS;
    redraw();
    requestAnimationFrame(waveTick);
  }

  // ---- state changes ------------------------------------------------------------
  // Numbers update on every input tick; the wave replays only on release
  // (slider 'change') or after typing settles, and only if the dots changed.
  var lastSig = '', waveTimer = 0;
  function refresh(mayWave) {
    computeDerived();
    var sig = d.sick + '/' + d.tp + '/' + d.fp;
    var changed = sig !== lastSig;
    if (changed) { lastSig = sig; assignStatuses(); }
    updateDom();
    requestRedraw();
    if (changed && mayWave) scheduleWave(550);
  }
  function scheduleWave(ms) {
    clearTimeout(waveTimer);
    waveTimer = setTimeout(startWave, ms);
  }
  function waveNow() {
    clearTimeout(waveTimer);
    startWave();
  }

  elPrev.addEventListener('input', function () {
    s.logPrev = parseFloat(elPrev.value);
    refresh(true);
  });
  elPrevNum.addEventListener('input', function () {
    var v = parseFloat(elPrevNum.value);
    if (!isFinite(v)) { updateDom(); return; }
    var pct = s.mode === 'security' ? v / 100 : v;
    pct = Math.min(10, Math.max(0.01, pct));
    s.logPrev = Math.log10(pct);
    elPrev.value = s.logPrev;
    refresh(true);
  });
  elSens.addEventListener('input', function () {
    s.sens = parseFloat(elSens.value) / 100;
    refresh(true);
  });
  elSpec.addEventListener('input', function () {
    s.spec = parseFloat(elSpec.value) / 100;
    refresh(true);
  });
  // 'change' = drag released (or a keyboard step); tighten the pending wave
  function onRelease() { scheduleWave(200); }
  elPrev.addEventListener('change', onRelease);
  elSens.addEventListener('change', onRelease);
  elSpec.addEventListener('change', onRelease);

  btnRun.addEventListener('click', waveNow);
  btnMed.addEventListener('click', function () { if (s.mode !== 'medical') applyMode('medical'); });
  btnSec.addEventListener('click', function () { if (s.mode !== 'security') applyMode('security'); });

  // ---- hover / tap probe ----------------------------------------------------------
  function probeText(i) {
    var T = TXT[s.mode];
    if ((i % COLS) >= front) return T.probeUntested;
    switch (status[i]) {
      case TP: return T.probeTp;
      case FP: return T.probeFp;
      case FN: return T.probeFn;
      default: return T.probeTn;
    }
  }
  function onProbe(e) {
    var r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var col = Math.floor((e.clientX - r.left) / r.width * COLS);
    var row = Math.floor((e.clientY - r.top) / r.height * ROWS);
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return;
    probe.textContent = probeText(row * COLS + col);
  }
  canvas.addEventListener('pointermove', onProbe);
  canvas.addEventListener('pointerdown', onProbe);
  canvas.addEventListener('pointerleave', function () {
    probe.textContent = TXT[s.mode].probeDefault;
  });

  // ---- environment listeners --------------------------------------------------------
  function onThemeChange() { buildSprites(); requestRedraw(); }
  if (window.MutationObserver) {
    new MutationObserver(onThemeChange)
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  if (mq) {
    if (mq.addEventListener) mq.addEventListener('change', onThemeChange);
    else if (mq.addListener) mq.addListener(onThemeChange);
  }
  window.addEventListener('resize', function () { resize(); requestRedraw(); });

  // ---- init -----------------------------------------------------------------------
  s.logPrev = parseFloat(elPrev.value);
  s.sens = parseFloat(elSens.value) / 100;
  s.spec = parseFloat(elSpec.value) / 100;
  resize();
  computeDerived();
  lastSig = d.sick + '/' + d.tp + '/' + d.fp;
  assignStatuses();
  applyMode('medical');
  redraw();                       // everyone untested, then the first sweep
  setTimeout(startWave, 450);
})();
