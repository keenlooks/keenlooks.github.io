/* ==========================================================================
   Timing-attack demo — recover a secret from response times alone
   --------------------------------------------------------------------------
   The page holds a random 8-character lowercase-hex token. Two comparison
   functions are implemented honestly:

     naiveCompare        loops characters, returns false at the FIRST mismatch,
                         and does one fixed chunk of arithmetic per matched
                         character. The more leading characters a guess gets
                         right, the more work runs before the reject, so the
                         response time is a function of how much of the secret
                         you already have. That is the leak.

     constantTimeCompare inspects every character, folds the differences
                         together with XOR, and does the same total work no
                         matter where (or whether) a mismatch occurs. Flat.

   The attack recovers the token one position at a time. For each position it
   tries all 16 hex candidates and times them INTERLEAVED (one batch per
   candidate per pass, candidate order reshuffled each pass), so slow drift in
   CPU frequency or scheduling is common-mode and cancels when candidates are
   compared. It keeps the candidate that is reliably the SLOWEST (the correct
   one runs one extra chunk of work). Against the constant-time compare nothing
   stands out, so after two rounds it gives up honestly.

   Disclosure baked into the copy: real servers leak at the nanosecond scale,
   far below what a (deliberately clamped) browser clock can see, so this demo
   AMPLIFIES the per-character cost to make the same leak visible at millisecond
   scale. The shape of the attack is real; only the magnitude is exaggerated.

   The pure core (compare functions, measurement, scoring, a synchronous
   recovery) is exported for Node testing; the DOM app below is skipped there.
   ========================================================================== */
(function () {
  'use strict';

  var HEX = '0123456789abcdef';
  var TOKEN_LEN = 8;
  var FILLER = '.';        /* not a hex digit, so it never matches the secret */

  /* Tunable knobs. WORK is the per-matched-character amplification described in
     the page copy. BATCH * WORK sets the size of the leak (it must clear the
     browser clock's clamp); PASSES / FAST_K clean the measurement; REL_FLOOR and
     Z_MIN decide when one candidate stands out enough to lock in. */
  var WORK       = 600;    /* integer-mix iterations charged per matched char   */
  var BATCH      = 1200;   /* comparisons per timing sample                     */
  var PASSES     = 14;     /* interleaved passes per candidate per round        */
  var WARMUP     = 2;      /* warm-up passes before the real measurement        */
  var FAST_K     = 5;      /* average the fastest K passes (the cleanest ones)  */
  var REL_FLOOR  = 0.09;   /* leader must lead the pack by this fraction of its
                              own time. This is the primary, machine-independent
                              discriminator: the correct naive candidate runs one
                              extra chunk of work, so it leads by ~1/(position+1),
                              i.e. at least ~12.5% at the last position, while a
                              constant-time compare leaves only a few % of noise.
                              (Measured window on this box: naive ~14%, const ~5%.) */
  var Z_MIN      = 2.5;    /* loose robustness floor so pure noise can't lock    */
  var MAX_ROUNDS = 2;      /* rounds with no clear winner before giving up      */

  var SINK = 0;            /* keeps the optimizer from deleting the work loop   */

  function now() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
  }

  /* One fixed chunk of arithmetic: a data-independent, constant-cost xorshift
     mix. This is the "work" that a matched character costs. */
  function chunk(seed) {
    var acc = (seed * 2654435761) >>> 0;
    for (var w = 0; w < WORK; w++) {
      acc = (acc ^ (acc << 13)) >>> 0;
      acc = (acc ^ (acc >>> 17)) >>> 0;
      acc = (acc ^ (acc << 5)) >>> 0;
      acc = (acc + 0x9e3779b9) >>> 0;
    }
    return acc;
  }

  /* Naive: bail out at the first mismatch, one chunk of work per matched char.
     k leading matches => k chunks of work => longer to reject. */
  function naiveCompare(guess, secret) {
    var n = secret.length;
    for (var i = 0; i < n; i++) {
      if (guess.charCodeAt(i) !== secret.charCodeAt(i)) return false;
      SINK ^= chunk(i);
    }
    return true;
  }

  /* Constant-time: touch every character, accumulate the difference, one chunk
     of work per position no matter what. Running time is independent of match. */
  function constantTimeCompare(guess, secret) {
    var n = secret.length, diff = 0;
    for (var i = 0; i < n; i++) {
      diff |= (guess.charCodeAt(i) ^ secret.charCodeAt(i));
      SINK ^= chunk(i);
    }
    return diff === 0;
  }

  function compareFor(mode) {
    return mode === 'constant' ? constantTimeCompare : naiveCompare;
  }

  /* Build a full-length guess: known prefix + candidate + non-hex filler, so a
     correct candidate mismatches exactly one position later (a clean one-chunk
     signal) rather than accidentally matching deeper into the secret. */
  function makeGuess(prefix, candidate) {
    var g = prefix + candidate;
    while (g.length < TOKEN_LEN) g += FILLER;
    return g.slice(0, TOKEN_LEN);
  }

  function shuffle16() {
    var a = [], i, j, t;
    for (i = 0; i < 16; i++) a.push(i);
    for (i = 15; i > 0; i--) { j = (Math.random() * (i + 1)) | 0; t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  function median(sorted) {
    var m = sorted.length >> 1;
    return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
  }

  /* A comparison can only be SLOWED by interference (preemption, garbage
     collection, CPU frequency drops), never sped up, so the fastest passes are
     the cleanest estimate of the true compute time. Average the fastest few. */
  function fastestMean(samples) {
    var a = samples.slice().sort(function (x, y) { return x - y; });
    var k = Math.min(FAST_K, a.length), sum = 0, i;
    for (i = 0; i < k; i++) sum += a[i];
    return sum / k;
  }

  /* One interleaved pass: time one batch for every candidate, in the given
     (shuffled) order, returning times indexed by candidate. Measuring all 16
     close together makes slow drift common-mode. */
  function timePass(compareFn, prefix, secret, batch, order) {
    var times = new Array(16), oi, ci, b, t0, g;
    for (oi = 0; oi < 16; oi++) {
      ci = order[oi];
      g = makeGuess(prefix, HEX[ci]);
      t0 = now();
      for (b = 0; b < batch; b++) compareFn(g, secret);
      times[ci] = now() - t0;
    }
    return times;
  }

  /* Median batch time per candidate over `passes` interleaved passes. */
  function measurePosition(compareFn, prefix, secret, batch, passes) {
    var acc = [], ci, p;
    for (ci = 0; ci < 16; ci++) acc.push([]);
    for (p = 0; p < passes; p++) {
      var times = timePass(compareFn, prefix, secret, batch, shuffle16());
      for (ci = 0; ci < 16; ci++) acc[ci].push(times[ci]);
    }
    var medians = new Array(16);
    for (ci = 0; ci < 16; ci++) medians[ci] = fastestMean(acc[ci]);
    return medians;
  }

  /* Given the 16 candidate medians, find the leader and decide whether it truly
     stands out. The gate is the RELATIVE lead over the pack's center (median +
     MAD, so one odd loser can't skew it): the correct naive candidate runs one
     extra chunk of work and so leads by a fixed structural fraction ~1/(pos+1)
     of its own time, which is machine-independent and never smaller than ~12.5%;
     a constant-time compare leaves only a few percent of noise. A loose robust
     z-floor is kept only so pure quantization noise can't sneak past. */
  function scorePosition(medians) {
    var n = medians.length, bestIdx = 0, i;
    for (i = 1; i < n; i++) if (medians[i] > medians[bestIdx]) bestIdx = i;
    var rest = [];
    for (i = 0; i < n; i++) if (i !== bestIdx) rest.push(medians[i]);
    rest.sort(function (a, c) { return a - c; });
    var med = median(rest);
    var dev = [];
    for (i = 0; i < rest.length; i++) dev.push(Math.abs(rest[i] - med));
    dev.sort(function (a, c) { return a - c; });
    var sigma = 1.4826 * median(dev);
    var gap = medians[bestIdx] - med;
    var z = gap / (sigma + 1e-4);
    var rel = medians[bestIdx] > 0 ? gap / medians[bestIdx] : 0;
    var significant = gap > 0 && rel > REL_FLOOR && z > Z_MIN;
    return { bestIdx: bestIdx, z: z, rel: rel, gap: gap, sigma: sigma, center: med, significant: significant };
  }

  /* Synchronous full recovery. Used by the Node test harness; the browser runs
     an incremental version of the same steps (below) so it can paint and pause.
     Adaptive: later rounds take more passes before conceding a position. */
  function recoverSync(secret, compareFn, hooks) {
    hooks = hooks || {};
    var w;
    for (w = 0; w < WARMUP; w++) timePass(compareFn, '', secret, BATCH, shuffle16());  /* warm up */
    var recovered = '';
    for (var pos = 0; pos < TOKEN_LEN; pos++) {
      var res = null, round;
      for (round = 1; round <= MAX_ROUNDS; round++) {
        var medians = measurePosition(compareFn, recovered, secret, BATCH, PASSES * round);
        res = scorePosition(medians);
        if (hooks.onPosition) hooks.onPosition(pos, HEX[res.bestIdx], res, medians, round);
        if (res.significant) break;
      }
      if (!res || !res.significant) return { recovered: recovered, gaveUp: true, pos: pos };
      recovered += HEX[res.bestIdx];
    }
    return { recovered: recovered, gaveUp: false, pos: TOKEN_LEN };
  }

  var CORE = {
    HEX: HEX, TOKEN_LEN: TOKEN_LEN, WORK: WORK, BATCH: BATCH, PASSES: PASSES,
    REL_FLOOR: REL_FLOOR, Z_MIN: Z_MIN, MAX_ROUNDS: MAX_ROUNDS,
    chunk: chunk, naiveCompare: naiveCompare, constantTimeCompare: constantTimeCompare,
    compareFor: compareFor, makeGuess: makeGuess, shuffle16: shuffle16,
    timePass: timePass, measurePosition: measurePosition,
    scorePosition: scorePosition, recoverSync: recoverSync
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = CORE;

  if (typeof document === 'undefined') return;   /* Node: skip the DOM app */

  /* ====================================================================== */
  /* DOM app                                                                */
  /* ====================================================================== */
  var canvas = document.getElementById('timing-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  function id(x) { return document.getElementById(x); }
  var modeSel   = id('timing-mode');
  var btnAttack = id('timing-attack');
  var btnReset  = id('timing-reset');
  var statusEl  = id('timing-status');
  var recEl     = id('timing-recovered');
  var logEl     = id('timing-log');
  var secretEl  = id('timing-secret');

  function randomToken() {
    var out = '', i;
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      var a = new Uint8Array(TOKEN_LEN);
      crypto.getRandomValues(a);
      for (i = 0; i < TOKEN_LEN; i++) out += HEX[a[i] & 15];
    } else {
      for (i = 0; i < TOKEN_LEN; i++) out += HEX[(Math.random() * 16) | 0];
    }
    return out;
  }
  var secret = randomToken();

  /* ---- theme + palette (matches the finance explainers) ---------------- */
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
      grid:   light ? 'rgba(0,0,0,0.09)' : 'rgba(255,255,255,0.09)',
      axis:   light ? 'rgba(0,0,0,0.40)' : 'rgba(255,255,255,0.38)',
      accent: light ? '#34568a' : '#82a6cc',
      bar:    light ? 'rgba(115,115,115,0.45)' : 'rgba(154,154,154,0.42)',
      barEdge:light ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.10)',
      panel:  light ? '#ffffff' : '#141414'
    };
  }

  /* ---- geometry / chart ------------------------------------------------ */
  var W = 0, H = 0, M = { l: 52, r: 16, t: 26, b: 34 };
  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* Chart display state (also used to redraw on theme change / resize). */
  var view = { medians: null, leader: -1, subtitle: 'Press Attack to begin.' };

  function drawChart() {
    if (!W || !H) resize();
    if (!W || !H) return;
    var c = palette();
    ctx.clearRect(0, 0, W, H);
    ctx.font = '12px "Source Sans 3", system-ui, sans-serif';

    var plotL = M.l, plotR = W - M.r, plotT = M.t, plotB = H - M.b;
    var meds = view.medians;
    var vmax = 0, i;
    if (meds) for (i = 0; i < 16; i++) if (isFinite(meds[i]) && meds[i] > vmax) vmax = meds[i];
    if (vmax <= 0) vmax = 1;
    var yScale = vmax * 1.15;

    /* y gridlines + tick labels (ms) */
    ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    for (i = 0; i <= 4; i++) {
      var val = (yScale / 4) * i;
      var gy = plotB - (val / yScale) * (plotB - plotT);
      ctx.strokeStyle = c.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(plotL, gy); ctx.lineTo(plotR, gy); ctx.stroke();
      ctx.fillStyle = c.muted; ctx.fillText(val.toFixed(1), plotL - 8, gy);
    }
    /* axes */
    ctx.strokeStyle = c.axis; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(plotL, plotT); ctx.lineTo(plotL, plotB); ctx.lineTo(plotR, plotB); ctx.stroke();

    /* y-axis title */
    ctx.save();
    ctx.translate(14, (plotT + plotB) / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = c.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('median batch time (ms)', 0, 0);
    ctx.restore();

    /* bars */
    var slot = (plotR - plotL) / 16;
    var bw = Math.min(slot * 0.62, 30);
    for (i = 0; i < 16; i++) {
      var cx = plotL + slot * (i + 0.5);
      var m = meds ? meds[i] : NaN;
      var isLeader = (i === view.leader);
      /* candidate label */
      ctx.fillStyle = isLeader ? c.accent : c.muted;
      ctx.font = (isLeader ? '600 ' : '') + '12px "Source Sans 3", system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(HEX[i], cx, plotB + 6);
      if (!isFinite(m)) {
        /* not measured yet: faint baseline tick */
        ctx.strokeStyle = c.grid; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cx - bw / 2, plotB); ctx.lineTo(cx + bw / 2, plotB); ctx.stroke();
        continue;
      }
      var bh = (m / yScale) * (plotB - plotT);
      var by = plotB - bh;
      ctx.fillStyle = isLeader ? c.accent : c.bar;
      ctx.fillRect(cx - bw / 2, by, bw, bh);
      ctx.strokeStyle = c.barEdge; ctx.lineWidth = 1;
      if (bh > 1) ctx.strokeRect(cx - bw / 2 + 0.5, by + 0.5, bw - 1, bh - 1);
      if (isLeader && bh > 6) {
        ctx.fillStyle = c.accent; ctx.font = '600 11px "Source Sans 3", system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(m.toFixed(1), cx, by - 3);
      }
    }

    /* headers */
    ctx.fillStyle = c.muted; ctx.font = '12px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText(view.subtitle, plotR, 6);
    ctx.textAlign = 'left';
    ctx.fillStyle = c.text; ctx.font = '600 12px "Source Sans 3", system-ui, sans-serif';
    ctx.fillText('time per hex candidate', plotL, 6);
  }

  /* ---- log + status + recovered readout -------------------------------- */
  function log(msg) {
    if (!logEl) return;
    var line = document.createElement('div');
    line.className = 'timing-log__line';
    line.textContent = msg;
    logEl.appendChild(line);
    while (logEl.childNodes.length > 60) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function fmtTrials(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + 'k';
    return String(n);
  }
  function renderRecovered(rec) {
    if (!recEl) return;
    var html = '', i;
    for (i = 0; i < TOKEN_LEN; i++) {
      if (i < rec.length) html += '<span class="timing-char timing-char--got">' + rec[i] + '</span>';
      else html += '<span class="timing-char">_</span>';
    }
    recEl.innerHTML = html;
  }
  function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }

  /* ---- attack state machine (incremental, rAF-driven) ------------------ */
  var atk = null;   /* running attack, or null */
  var raf = 0;

  function setRunning(running) {
    if (btnAttack) btnAttack.textContent = running ? 'Stop' : 'Attack';
    if (btnReset)  btnReset.disabled = running;
    if (modeSel)   modeSel.disabled = running;
  }

  /* per-candidate estimates from what has accumulated so far (for the live bars) */
  function partialMedians() {
    var meds = new Array(16), i;
    for (i = 0; i < 16; i++) meds[i] = atk.acc[i].length ? fastestMean(atk.acc[i]) : NaN;
    return meds;
  }
  function leaderOf(meds) {
    var best = -1, bestv = -Infinity, i;
    for (i = 0; i < 16; i++) if (isFinite(meds[i]) && meds[i] > bestv) { bestv = meds[i]; best = i; }
    return best;
  }

  function startRound(round) {
    atk.round = round;
    atk.passesTarget = PASSES * round;
    atk.pass = 0;
    atk.acc = [];
    for (var i = 0; i < 16; i++) atk.acc.push([]);
  }

  function elapsed() { return (now() - atk.t0 - atk.pausedMs) / 1000; }

  function updateStatus() {
    if (!atk) return;
    setStatus('Attacking position ' + (atk.pos + 1) + ' of ' + TOKEN_LEN +
      (atk.round > 1 ? ' (round ' + atk.round + ')' : '') +
      ' · pass ' + Math.min(atk.pass + 1, atk.passesTarget) + '/' + atk.passesTarget +
      ' · ' + fmtTrials(atk.trials) + ' comparisons' +
      ' · ' + elapsed().toFixed(1) + 's');
  }

  function startAttack() {
    if (atk) return;
    var mode = modeSel ? modeSel.value : 'naive';
    atk = {
      mode: mode, compareFn: compareFor(mode),
      pos: 0, recovered: '', trials: 0,
      warmedUp: false, done: false,
      t0: now(), pausedMs: 0, pausedAt: 0
    };
    startRound(1);
    setRunning(true);
    renderRecovered('');
    log('Attacking the ' + (mode === 'constant' ? 'constant-time' : 'naive') + ' compare.');
    view.medians = null; view.leader = -1;
    view.subtitle = 'warming up…';
    drawChart(); updateStatus();
    schedule();
  }

  function stopAttack(reason) {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (atk) { atk.done = true; atk = null; }
    setRunning(false);
    if (reason) setStatus(reason);
  }

  function finishSuccess() {
    var secs = elapsed().toFixed(1);
    var ok = (atk.recovered === secret);
    var rec = atk.recovered;
    view.subtitle = 'done';
    drawChart();
    log('Recovered "' + rec + '" in ' + secs + 's' +
        (ok ? ' — it matches the secret.' : ' — it does NOT match (unexpected).'));
    stopAttack('Recovered ' + rec + ' from timing alone in ' + secs + 's. Open "Reveal the secret" to check.');
  }

  function finishGiveUp() {
    view.subtitle = 'flat';
    drawChart();
    var msg = 'No timing signal. The constant-time compare does not leak.';
    log(msg);
    stopAttack(msg);
  }

  function schedule() { if (!raf) raf = requestAnimationFrame(step); }

  function step() {
    raf = 0;
    if (!atk || atk.done) return;

    /* Background tabs throttle timers, which would corrupt the samples, so we
       pause here and resume from the visibilitychange handler. */
    if (document.hidden) {
      if (!atk.pausedAt) {
        atk.pausedAt = now();
        setStatus('Paused: the tab is in the background (timers throttle there and would corrupt the samples). Return to this tab to continue.');
      }
      return;   /* do not reschedule; visibilitychange resumes us */
    }
    if (atk.pausedAt) {
      atk.pausedMs += now() - atk.pausedAt;
      atk.pausedAt = 0;
      log('Resumed after the tab returned to the foreground.');
    }

    if (!atk.warmedUp) {
      timePass(atk.compareFn, '', secret, BATCH, shuffle16());   /* warm the JIT */
      atk.warmedUp = true;
      view.subtitle = 'measuring…';
      updateStatus();
      schedule();
      return;
    }

    /* one interleaved pass per frame: keeps the UI painting and lets rAF pause
       the whole attack when the tab is hidden */
    var times = timePass(atk.compareFn, atk.recovered, secret, BATCH, shuffle16());
    for (var ci = 0; ci < 16; ci++) atk.acc[ci].push(times[ci]);
    atk.trials += BATCH * 16;
    atk.pass++;

    var meds = partialMedians();
    view.medians = meds; view.leader = leaderOf(meds);
    view.subtitle = 'position ' + (atk.pos + 1) + '/' + TOKEN_LEN + (atk.round > 1 ? ' · round ' + atk.round : '');
    drawChart(); updateStatus();

    if (atk.pass < atk.passesTarget) { schedule(); return; }

    /* round complete: decide */
    var res = scorePosition(meds);
    view.leader = res.bestIdx; drawChart();
    if (res.significant) {
      atk.recovered += HEX[res.bestIdx];
      renderRecovered(atk.recovered);
      log('Position ' + (atk.pos + 1) + ': locked "' + HEX[res.bestIdx] + '" — it was ' + (res.rel * 100).toFixed(0) + '% slower to reject (z = ' + res.z.toFixed(1) + ').');
      atk.pos++;
      if (atk.pos >= TOKEN_LEN) { finishSuccess(); return; }
      startRound(1);
      schedule();
    } else {
      log('Position ' + (atk.pos + 1) + ', round ' + atk.round + ': no candidate stands out (best lead ' + (res.rel * 100).toFixed(1) + '%, z = ' + res.z.toFixed(1) + ').');
      if (atk.round >= MAX_ROUNDS) { finishGiveUp(); return; }
      startRound(atk.round + 1);
      schedule();
    }
  }

  /* ---- controls -------------------------------------------------------- */
  if (btnAttack) btnAttack.addEventListener('click', function () {
    if (atk) stopAttack('Stopped.'); else startAttack();
  });
  if (btnReset) btnReset.addEventListener('click', function () {
    if (atk) return;
    secret = randomToken();
    if (secretEl) secretEl.textContent = secret;
    if (logEl) logEl.textContent = '';
    renderRecovered('');
    view.medians = null; view.leader = -1; view.subtitle = 'Press Attack to begin.';
    drawChart();
    setStatus('New secret generated. Press Attack to try to recover it.');
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && atk && !atk.done && !raf) schedule();
  });

  /* ---- theme + resize -------------------------------------------------- */
  var mo = new MutationObserver(drawChart);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (window.matchMedia) {
    try { window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', drawChart); } catch (e) {}
  }
  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt); rt = setTimeout(function () { resize(); drawChart(); }, 120);
  });

  /* ---- init ------------------------------------------------------------ */
  if (secretEl) secretEl.textContent = secret;
  renderRecovered('');
  resize();
  drawChart();
  setStatus('Idle. Pick a compare function and press Attack.');
})();
