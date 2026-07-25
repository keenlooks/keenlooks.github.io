/* ==========================================================================
   computer.js — page runtime for The Visible Computer (/computer/).
   Wires the 3-pane app: editor + assembler errors, animated datapath
   canvas, 32x32 screen with keyboard capture + D-pad, memory inspector
   with a bespoke hex edit overlay, run controls, instruction reference
   slide-over, share/save. All machine logic lives in computer-core.js.
   ========================================================================== */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  function boot() {
    var K = window.KL8, GU = window.GadgetUI, SH = window.ShareHash;
    if (!K) return;
    function $(id) { return document.getElementById(id); }
    var hx2 = K.hx2, hx4 = K.hx4;

    /* ---------- elements ---------- */
    var app = $('comp-app');
    if (!app) return;
    var tabsBar = $('comp-tabs');
    var srcTa = $('comp-src'), srcView = $('comp-srcview'), edWrap = $('comp-edwrap');
    var errBox = $('comp-errors');
    var assembleBtn = $('comp-assemble'), exampleSel = $('comp-examples'), refBtn = $('comp-ref-btn');
    var dpWrap = $('comp-dpwrap'), dpCanvas = $('comp-datapath'), phaseEl = $('comp-phase');
    var scrCanvas = $('comp-screen'), capNote = $('comp-capnote'), dpad = $('comp-dpad');
    var resetBtn = $('comp-reset'), microBtn = $('comp-micro'), stepBtn = $('comp-step'), runBtn = $('comp-run');
    var speedSl = $('comp-speed'), speedVal = $('comp-speedval');
    var countEl = $('comp-count'), statusEl = $('comp-status');
    var shareBtn = $('comp-share'), saveBtn = $('comp-save');
    var memWrap = $('comp-mem'), memCanvas = $('comp-memcanvas');
    var regionSel = $('comp-region'), memPage = $('comp-mempage'), memPageVal = $('comp-mempageval');
    var refPanel = $('comp-ref'), refBody = $('comp-ref-body'), refClose = $('comp-ref-close');

    /* ---------- theme ---------- */
    var THEME = {}, PAL = [], reduced = false;
    try {
      reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) { reduced = false; }

    function effTheme() {
      var t = document.documentElement.getAttribute('data-theme');
      if (t === 'light' || t === 'dark') return t;
      try {
        return (matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
      } catch (e) { return 'dark'; }
    }
    function hexRgb(h) {
      return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    }
    function mix(a, b, t) {
      var A = hexRgb(a), B = hexRgb(b), o = [0, 0, 0];
      for (var i = 0; i < 3; i++) o[i] = Math.round(A[i] + (B[i] - A[i]) * t);
      return 'rgb(' + o[0] + ',' + o[1] + ',' + o[2] + ')';
    }
    function rebuildTheme() {
      var light = effTheme() === 'light';
      THEME = {
        light: light,
        bg: light ? '#ffffff' : '#141414',
        panel: light ? '#f5f5f5' : '#1d1d1d',
        ink: light ? '#262626' : '#d6d6d6',
        muted: 'rgba(127,127,127,0.75)',
        faint: 'rgba(127,127,127,0.35)',
        accent: light ? '#34568a' : '#82a6cc',
        accentHi: light ? '#25406b' : '#a3c2e0',
        gold: light ? '#a07c2c' : '#c8a45c'
      };
      var base = [
        THEME.bg, THEME.ink, THEME.accent, THEME.gold,
        light ? '#d8d8d8' : '#3c3c3c',
        light ? '#b0b0b0' : '#5c5c5c',
        '#8a8a8a',
        light ? '#565656' : '#b4b4b4'
      ];
      PAL = [];
      var i;
      for (i = 0; i < 8; i++) PAL.push(base[i]);
      for (i = 0; i < 8; i++) PAL.push(mix(base[i].charAt(0) === '#' ? base[i] : '#8a8a8a', THEME.bg, 0.5));
      /* precompute rgb triplets for the screen ImageData */
      PAL.rgb = [];
      for (i = 0; i < 16; i++) {
        var c = PAL[i];
        if (c.charAt(0) === '#') PAL.rgb.push(hexRgb(c));
        else {
          var mrgb = /rgb\((\d+),(\d+),(\d+)\)/.exec(c);
          PAL.rgb.push([+mrgb[1], +mrgb[2], +mrgb[3]]);
        }
      }
    }

    /* ---------- machine ---------- */
    var kbBits = 0, dpadBits = 0;
    var cpu = new K.CPU({ readKeys: function () { return (kbBits | dpadBits) & 0xFF; } });
    var mode = 'edit';               /* 'edit' | 'ready' | 'run' */
    var lastLoaded = '';             /* example-source tracking */
    var curLine = -1;
    var screenAll = true;            /* force full screen repaint */
    var memFlash = {};               /* addr -> {t, w} for inspector flashes */
    var hzNow = 0;                   /* smoothed effective speed */
    var lastCount = 0, lastCountT = 0;

    function speedHz() {
      var v = +speedSl.value;        /* 0..100 -> 2 Hz .. 200 kHz (log) */
      return 2 * Math.pow(10, v / 20);
    }
    function speedLabel() {
      var hz = speedHz();
      if (hz >= 1000) return Math.round(hz / 1000) + ' kHz';
      if (hz >= 100) return Math.round(hz) + ' Hz';
      return (Math.round(hz * 10) / 10) + ' Hz';
    }
    function setStatus(msg) { if (statusEl) statusEl.textContent = msg || ''; }

    /* ---------- layout: columns + tabs ---------- */
    function colsFor() {
      var w = window.innerWidth;
      return w >= 1000 ? 3 : (w >= 700 ? 2 : 1);
    }
    function setTab(t) {
      app.setAttribute('data-tab', t);
      var btns = tabsBar ? tabsBar.querySelectorAll('.comp-tab') : [];
      for (var i = 0; i < btns.length; i++) {
        var on = btns[i].getAttribute('data-tab') === t;
        btns[i].classList.toggle('comp-tab--on', on);
        btns[i].setAttribute('aria-selected', on ? 'true' : 'false');
      }
      sizeCanvases();
    }
    function applyCols() {
      var c = colsFor();
      app.setAttribute('data-cols', String(c));
      var t = app.getAttribute('data-tab') || 'code';
      if (c === 2 && t === 'code') setTab('machine');
      else setTab(t);
    }
    if (tabsBar) {
      tabsBar.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.comp-tab') : null;
        if (b) setTab(b.getAttribute('data-tab'));
      });
    }
    window.addEventListener('resize', function () { applyCols(); });

    /* ---------- canvases: sizing ---------- */
    var DPR = Math.min(window.devicePixelRatio || 1, 2);
    var dpCtx = dpCanvas.getContext('2d');
    var scrCtx = scrCanvas.getContext('2d');
    var memCtx = memCanvas.getContext('2d');
    var DP_W = 620, DP_H = 352;      /* datapath design space */
    var dpScale = 1, dpOffX = 0, dpOffY = 0, dpScrolled = false;

    function sizeOne(canvas, cssW, cssH) {
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
      var pw = Math.max(1, Math.round(cssW * DPR));
      var ph = Math.max(1, Math.round(cssH * DPR));
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw; canvas.height = ph;
      }
    }
    function sizeCanvases() {
      var oneCol = app.getAttribute('data-cols') === '1';
      /* datapath: fill its wrapper, keep aspect. On the single-column (phone)
         layout, fitting 620x352 into a ~344px pane would shrink the block
         labels to about 6px, so the canvas keeps a legible minimum width and
         the wrapper pans horizontally instead (CSS: overflow-x auto). */
      if (dpWrap && dpWrap.clientWidth > 0) {
        var w = Math.max(dpWrap.clientWidth, oneCol ? 560 : 0);
        var h = Math.max(200, dpWrap.clientHeight);
        sizeOne(dpCanvas, w, h);
        dpScale = Math.min(w / DP_W, h / DP_H);
        dpOffX = (w - DP_W * dpScale) / 2;
        dpOffY = Math.max(0, (h - DP_H * dpScale) / 2);
        /* start the pan in the middle once, so BOTH edges read as cut off and
           the diagram is obviously wider than the window (never fight a pan
           the reader has already made) */
        if (oneCol && !dpScrolled && dpWrap.scrollWidth > dpWrap.clientWidth) {
          dpWrap.scrollLeft = Math.round((dpWrap.scrollWidth - dpWrap.clientWidth) / 2);
          dpScrolled = true;
        }
      }
      /* screen: square, CSS-driven width (a phone gets the whole pane) */
      if (scrCanvas.parentElement && scrCanvas.parentElement.clientWidth > 0) {
        var sw = Math.min(oneCol ? 340 : 272, scrCanvas.parentElement.clientWidth - 4);
        sizeOne(scrCanvas, sw, sw);
        screenAll = true;
      }
      /* memory: width-driven, fixed aspect */
      if (memWrap && memWrap.clientWidth > 0) {
        var mw = memWrap.clientWidth;
        sizeOne(memCanvas, mw, Math.round(mw * 252 / 296));
      }
      needDp = true; needMem = true;
    }

    /* ---------- 32x32 screen ---------- */
    var off = document.createElement('canvas');
    off.width = 32; off.height = 32;
    var offCtx = off.getContext('2d');
    var img = offCtx.createImageData(32, 32);

    function paintPixel(i) {
      var c = PAL.rgb[cpu.disp[i] & 0x0F];
      var o = i * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
    }
    function drawScreen() {
      var d = cpu.drainDirty();
      if (screenAll) { d = 'all'; screenAll = false; }
      if (!d) return;
      if (d === 'all') { for (var i = 0; i < 1024; i++) paintPixel(i); }
      else { for (var j = 0; j < d.length; j++) paintPixel(d[j]); }
      offCtx.putImageData(img, 0, 0);
      scrCtx.imageSmoothingEnabled = false;
      scrCtx.clearRect(0, 0, scrCanvas.width, scrCanvas.height);
      scrCtx.drawImage(off, 0, 0, scrCanvas.width, scrCanvas.height);
    }

    /* ---------- keyboard capture (canvas has tabindex=0) ---------- */
    var KEYBITS = { ArrowUp: 1, ArrowDown: 2, ArrowLeft: 4, ArrowRight: 8, ' ': 16 };
    scrCanvas.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { scrCanvas.blur(); return; }
      var b = KEYBITS[e.key];
      if (b) { kbBits |= b; e.preventDefault(); }
    });
    scrCanvas.addEventListener('keyup', function (e) {
      var b = KEYBITS[e.key];
      if (b) { kbBits &= ~b; e.preventDefault(); }
    });
    scrCanvas.addEventListener('pointerdown', function () { scrCanvas.focus(); });
    scrCanvas.addEventListener('focus', function () {
      if (capNote) capNote.hidden = false;
      scrCanvas.classList.add('comp-screen--cap');
    });
    scrCanvas.addEventListener('blur', function () {
      kbBits = 0;
      if (capNote) capNote.hidden = true;
      scrCanvas.classList.remove('comp-screen--cap');
    });
    /* Alt-tabbing away does not blur the canvas, so the keyup for a held arrow
       never arrives and the program keeps "moving" on return. */
    window.addEventListener('blur', function () { kbBits = 0; });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) kbBits = 0;
    });

    /* ---------- on-screen D-pad ---------- */
    if (dpad) {
      dpad.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      var dbtns = dpad.querySelectorAll('.comp-dbtn');
      for (var db = 0; db < dbtns.length; db++) {
        (function (btn) {
          var bit = +btn.getAttribute('data-bit');
          btn.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            try { btn.setPointerCapture(e.pointerId); } catch (err) {}
            dpadBits |= bit;
            btn.classList.add('comp-dbtn--on');
          });
          function release() {
            dpadBits &= ~bit;
            btn.classList.remove('comp-dbtn--on');
          }
          btn.addEventListener('pointerup', release);
          btn.addEventListener('pointercancel', release);
          btn.addEventListener('lostpointercapture', release);
        })(dbtns[db]);
      }
    }

    /* ---------- editor: textarea <-> read-only view swap ---------- */
    var machineView = false;

    function buildSrcView() {
      while (srcView.firstChild) srcView.removeChild(srcView.firstChild);
      var lines = srcTa.value.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var d = document.createElement('div');
        d.className = 'comp-srcline';
        d.textContent = lines[i] === '' ? ' ' : lines[i];
        srcView.appendChild(d);
      }
      curLine = -1;
    }
    function enterMachineView() {
      if (machineView) return;
      buildSrcView();
      machineView = true;
      srcTa.hidden = true;
      srcView.hidden = false;
      srcView.scrollTop = srcTa.scrollTop;
    }
    function exitMachineView() {
      if (!machineView) return;
      machineView = false;
      srcTa.hidden = false;
      srcView.hidden = true;
      srcTa.scrollTop = srcView.scrollTop;
    }
    function highlightLine(n) {
      if (!machineView || n === curLine) return;
      var kids = srcView.children;
      if (curLine >= 1 && curLine <= kids.length) kids[curLine - 1].classList.remove('comp-srcline--cur');
      curLine = (typeof n === 'number' && n >= 1) ? n : -1;
      if (curLine >= 1 && curLine <= kids.length) {
        var el = kids[curLine - 1];
        el.classList.add('comp-srcline--cur');
        var top = el.offsetTop - srcView.offsetTop;
        if (top < srcView.scrollTop + 8 || top > srcView.scrollTop + srcView.clientHeight - 30) {
          srcView.scrollTop = Math.max(0, top - srcView.clientHeight * 0.4);
        }
      }
    }
    srcView.addEventListener('click', function () { stopMachine('Edited: machine stopped.'); });
    srcView.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); stopMachine('Edited: machine stopped.'); }
    });

    /* Tab inserts two spaces (documented in the reference) */
    srcTa.addEventListener('keydown', function (e) {
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        var s = srcTa.selectionStart, t = srcTa.selectionEnd;
        srcTa.value = srcTa.value.slice(0, s) + '  ' + srcTa.value.slice(t);
        srcTa.selectionStart = srcTa.selectionEnd = s + 2;
      }
    });

    /* ---------- errors ---------- */
    function showErrors(errs) {
      while (errBox.firstChild) errBox.removeChild(errBox.firstChild);
      if (!errs || !errs.length) { errBox.hidden = true; return; }
      errBox.hidden = false;
      for (var i = 0; i < Math.min(errs.length, 12); i++) {
        (function (er) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'comp-err';
          b.textContent = 'line ' + er.line + ': ' + er.msg;
          b.addEventListener('click', function () { gotoLine(er.line); });
          errBox.appendChild(b);
        })(errs[i]);
      }
      if (errs.length > 12) {
        var more = document.createElement('div');
        more.className = 'comp-err comp-err--more';
        more.textContent = '(' + (errs.length - 12) + ' more)';
        errBox.appendChild(more);
      }
    }
    function gotoLine(n) {
      stopMachine();
      var lines = srcTa.value.split('\n');
      var pos = 0;
      for (var i = 0; i < n - 1 && i < lines.length; i++) pos += lines[i].length + 1;
      srcTa.focus();
      var end = pos + (lines[n - 1] ? lines[n - 1].length : 0);
      try { srcTa.setSelectionRange(pos, end); } catch (e) {}
      var lh = srcTa.scrollHeight / Math.max(1, lines.length);
      srcTa.scrollTop = Math.max(0, (n - 1) * lh - srcTa.clientHeight * 0.4);
    }

    /* ---------- examples ---------- */
    (function fillExamples() {
      var ph = document.createElement('option');
      ph.value = '';
      ph.textContent = 'Your own program';
      exampleSel.appendChild(ph);
      for (var i = 0; i < K.EXAMPLES.length; i++) {
        var o = document.createElement('option');
        o.value = K.EXAMPLES[i].id;
        o.textContent = K.EXAMPLES[i].name;
        exampleSel.appendChild(o);
      }
    })();
    /* the select must always mirror what is actually in the editor: on a
       declined confirm (or after a share-hash restore) it would otherwise show
       an example that is not loaded, and re-picking it fires no change event */
    var appliedExample = exampleSel.value;
    exampleSel.addEventListener('change', function () {
      var ex = null;
      for (var i = 0; i < K.EXAMPLES.length; i++) if (K.EXAMPLES[i].id === exampleSel.value) ex = K.EXAMPLES[i];
      if (!ex) { exampleSel.value = appliedExample; return; }
      var dirty = srcTa.value !== lastLoaded && srcTa.value.replace(/\s+/g, '') !== '';
      if (dirty && !window.confirm('Replace your code with the "' + ex.name + '" example?')) {
        exampleSel.value = appliedExample;
        return;
      }
      stopMachine();
      srcTa.value = ex.src;
      lastLoaded = ex.src;
      appliedExample = ex.id;
      showErrors(null);
      setStatus('Loaded ' + ex.name + '. Press Assemble ▸ Run.');
    });

    /* ---------- assemble / reset / stop ---------- */
    function assembleNow() {
      var r = K.assemble(srcTa.value);
      if (r.errors.length) {
        showErrors(r.errors);
        setStatus(r.errors.length + (r.errors.length === 1 ? ' error.' : ' errors.'));
        return null;
      }
      showErrors(null);
      return r;
    }
    function loadProgram(r) {
      cpu.load(r);
      cpu.memLog = [];
      memFlash = {};
      screenAll = true;
      animQ.length = 0; animCur = null; microCredit = 0;
      resetVm();
      lastCount = 0; hzNow = 0;
      setStatus('Assembled: ' + r.bytes.length + ' bytes at $' + hx4(r.origin) + '.');
    }
    function stopMachine(msg) {
      mode = 'edit';
      runBtn.textContent = 'Run';
      exitMachineView();
      highlightLine(-1);
      if (msg) setStatus(msg);
    }
    function resetMachine() {
      cpu.reset();
      animQ.length = 0; animCur = null; microCredit = 0;
      screenAll = true;
      memFlash = {};
      resetVm();
      stopMachine('Reset. The screen and registers are cleared.');
      needDp = true; needMem = true;
    }

    /* ---------- view model + phase animation ---------- */
    var vm = {}, heat = {}, aluFlash = 0;
    var animQ = [], animCur = null, microCredit = 0, playMode = 'auto';
    var fetchStage = true, irNew = true;
    var acc = 0;
    var needDp = true, needMem = true;

    function resetVm() {
      vm = {
        PC: '$' + hx4(cpu.PC), SP: '$' + hx2(cpu.SP), A: '$' + hx2(cpu.A), X: '$' + hx2(cpu.X),
        MAR: '----', RAMa: null, RAMv: null, IR: '--', DEC: 'ready', ALU: '',
        Z: cpu.Z, N: cpu.N, C: cpu.C
      };
      heat = {}; aluFlash = 0;
      if (phaseEl) phaseEl.textContent = '';
      needDp = true;
    }
    function bump(b) { heat[b] = 1; }

    function phaseText(ph) {
      var stage = fetchStage ? 'FETCH' : 'EXEC';
      if (ph.kind === 'alu') return 'EXEC: ALU  ' + ph.label;
      if (ph.kind === 'flag') return (ph.flags ? 'FLAGS: ' : 'EXEC: ') + ph.label;
      var src = ph.from + (ph.addr !== undefined && ph.from === 'RAM' ? '[$' + hx4(ph.addr) + ']' : '');
      var dst = ph.to + (ph.addr !== undefined && ph.to === 'RAM' ? '[$' + hx4(ph.addr) + ']' : '');
      return stage + ': ' + src + ' → ' + dst + '   ' + ph.label;
    }

    function applyPhase(ph) {
      bump(ph.to);
      if (ph.kind === 'alu') { vm.ALU = ph.op || ''; aluFlash = 1; bump('ALU'); }
      else if (ph.kind === 'flag') {
        if (ph.flags) { vm.Z = ph.flags.z; vm.N = ph.flags.n; vm.C = ph.flags.c; }
        bump('FLAGS');
      } else {
        if (ph.to === 'MAR') vm.MAR = ph.label;
        if (ph.addr !== undefined) { vm.RAMa = ph.addr; vm.RAMv = cpu.peek(ph.addr); bump('RAM'); }
        if (ph.to === 'IR') { vm.IR = irNew ? ph.label : vm.IR + ' ' + ph.label; irNew = false; }
        if (ph.to === 'DECODE') { vm.DEC = ph.label; fetchStage = false; }
        if (ph.to === 'A') vm.A = '$' + hx2(cpu.A);
        if (ph.to === 'X') vm.X = '$' + hx2(cpu.X);
        if (ph.to === 'PC') vm.PC = ph.label;
        if (ph.from === 'PC' && ph.to === 'MAR') vm.PC = ph.label;
        if (ph.from === 'SP' || ph.to === 'SP') { vm.SP = '$' + hx2(cpu.SP); bump('SP'); }
      }
      if (phaseEl) phaseEl.textContent = phaseText(ph);
      needDp = true;
    }

    function beginTrace(tr, perPhase) {
      if (tr.line) highlightLine(tr.line);
      fetchStage = true; irNew = true;
      for (var i = 0; i < tr.phases.length; i++) {
        animQ.push({ ph: tr.phases[i], dur: perPhase });
      }
    }
    function flushAnim() {
      if (animCur) { applyPhase(animCur.ph); animCur = null; }
      while (animQ.length) applyPhase(animQ.shift().ph);
      syncVmEnd();
    }
    function syncVmEnd() {
      /* after an instruction fully lands, registers show the CPU's state */
      vm.PC = '$' + hx4(cpu.PC); vm.SP = '$' + hx2(cpu.SP);
      vm.A = '$' + hx2(cpu.A); vm.X = '$' + hx2(cpu.X);
      vm.Z = cpu.Z; vm.N = cpu.N; vm.C = cpu.C;
      needDp = true;
    }
    function animTick(now) {
      if (reduced) {
        if (animQ.length || animCur) { flushAnim(); }
        return;
      }
      if (!animCur && animQ.length && (playMode === 'auto' || microCredit > 0)) {
        var nx = animQ.shift();
        if (microCredit > 0) microCredit--;
        if (nx.dur <= 0) { applyPhase(nx.ph); if (!animQ.length) syncVmEnd(); return; }
        animCur = { ph: nx.ph, t0: now, dur: nx.dur, pts: routeFor(nx.ph) };
      }
      if (animCur && now - animCur.t0 >= animCur.dur) {
        applyPhase(animCur.ph);
        animCur = null;
        if (!animQ.length) syncVmEnd();
      }
    }

    /* ---------- run controls ---------- */
    function ensureMachine() {
      if (mode !== 'edit') return true;
      var r = assembleNow();
      if (!r) return false;
      loadProgram(r);
      enterMachineView();
      mode = 'ready';
      return true;
    }
    /* The >30 Hz fast path nulls memLog for speed. Traced execution (Step /
       Micro-step) must re-arm it, or the inspector's read/write flashes stay
       dead after any fast run, which is exactly when they teach the most. */
    function armMemLog() { if (cpu && !cpu.memLog) cpu.memLog = []; }
    assembleBtn.addEventListener('click', function () {
      var r = assembleNow();
      if (!r) return;
      loadProgram(r);
      enterMachineView();
      mode = 'run'; playMode = 'auto';
      runBtn.textContent = 'Pause';
      /* on the single-pane layout, show the screen so the run is visible */
      if (app.getAttribute('data-cols') === '1') setTab('screen');
    });
    runBtn.addEventListener('click', function () {
      if (mode === 'run') {
        mode = 'ready'; runBtn.textContent = 'Run'; setStatus('Paused.');
        return;
      }
      if (!ensureMachine()) return;
      if (cpu.halted) { setStatus('Halted. Press Reset, then Run to start over.'); return; }
      /* drop any queued micro-step phases: they would keep overwriting the
         live register values with stale labels for seconds into the run */
      flushAnim();
      mode = 'run'; playMode = 'auto';
      runBtn.textContent = 'Pause';
      setStatus('');
    });
    stepBtn.addEventListener('click', function () {
      if (!ensureMachine()) return;
      if (mode === 'run') { mode = 'ready'; runBtn.textContent = 'Run'; }
      armMemLog();
      flushAnim();
      if (cpu.halted) { setStatus('Halted.'); return; }
      playMode = 'auto';
      if (cpu.waiting) {
        cpu.frame();
        if (phaseEl) phaseEl.textContent = 'WAIT: display frame ' + cpu.frameCount + ' ticked';
        setStatus('WAIT released by a display frame.');
        return;
      }
      setStatus('');
      beginTrace(cpu.step(), reduced ? 0 : 240);
    });
    microBtn.addEventListener('click', function () {
      if (!ensureMachine()) return;
      if (mode === 'run') { mode = 'ready'; runBtn.textContent = 'Run'; }
      armMemLog();
      playMode = 'manual';
      if (animCur) { applyPhase(animCur.ph); animCur = null; if (!animQ.length) syncVmEnd(); return; }
      if (!animQ.length) {
        if (cpu.halted) { setStatus('Halted.'); return; }
        if (cpu.waiting) {
          cpu.frame();
          if (phaseEl) phaseEl.textContent = 'WAIT: display frame ' + cpu.frameCount + ' ticked';
          return;
        }
        setStatus('');
        beginTrace(cpu.step(), reduced ? 0 : 300);
      }
      microCredit = 1;
    });
    resetBtn.addEventListener('click', resetMachine);
    speedSl.addEventListener('input', function () {
      if (speedVal) speedVal.textContent = speedLabel();
    });

    /* ---------- main loop ---------- */
    var paneMachine = $('pane-machine'), paneScreen = $('pane-screen');
    function visible(el) { return !!el && el.clientWidth > 0; }
    function fmtHz(h) {
      if (h >= 1000) return (h / 1000).toFixed(h >= 10000 ? 0 : 1) + ' kHz';
      return Math.round(h) + ' Hz';
    }
    function syncVmFast(pA, pX, pZ, pN, pC) {
      vm.PC = '$' + hx4(cpu.PC); vm.SP = '$' + hx2(cpu.SP);
      vm.A = '$' + hx2(cpu.A); vm.X = '$' + hx2(cpu.X);
      vm.Z = cpu.Z; vm.N = cpu.N; vm.C = cpu.C;
      vm.DEC = cpu.halted ? 'halted' : (cpu.waiting ? 'waiting' : cpu.disasm(cpu.PC));
      vm.IR = '$' + hx2(cpu.peek(cpu.PC));
      vm.MAR = '$' + hx4(cpu.PC);
      vm.RAMa = cpu.PC; vm.RAMv = cpu.peek(cpu.PC);
      bump('PC'); bump('RAM'); bump('IR'); bump('DECODE'); bump('MAR');
      if (cpu.A !== pA) { bump('A'); bump('ALU'); aluFlash = Math.max(aluFlash, 0.6); }
      if (cpu.X !== pX) bump('X');
      if (cpu.Z !== pZ || cpu.N !== pN || cpu.C !== pC) bump('FLAGS');
      if (phaseEl) phaseEl.textContent = 'running at about ' + fmtHz(hzNow);
      needDp = true;
    }

    var lastT = 0;
    function loop(t) {
      requestAnimationFrame(loop);
      var dt = lastT ? Math.min(100, t - lastT) : 16.7;
      lastT = t;
      var running = (mode === 'run');

      if (running && !cpu.halted) {
        cpu.frame();               /* exactly once per display frame */
        var hz = speedHz();
        if (hz > 30) {
          if (cpu.memLog) cpu.memLog = null;
          var want = Math.min(Math.ceil(hz * dt / 1000), 500000);
          var pA = cpu.A, pX = cpu.X, pZ = cpu.Z, pN = cpu.N, pC = cpu.C;
          var n = cpu.run(want, 6);
          if (n > 0) syncVmFast(pA, pX, pZ, pN, pC);
        } else {
          if (!cpu.memLog) cpu.memLog = [];
          acc += hz * dt / 1000;
          if (acc > 2) acc = 2;
          if (!animCur && !animQ.length && acc >= 1) {
            acc -= 1;
            if (cpu.waiting) {
              if (phaseEl) phaseEl.textContent = 'WAIT: waiting for the next display frame';
            } else {
              playMode = 'auto';
              var tr = cpu.step();
              var per = Math.min(280, Math.max(40, (1000 / hz) * 0.9 / Math.max(1, tr.phases.length)));
              beginTrace(tr, reduced ? 0 : per);
            }
          }
        }
        if (cpu.halted) {
          mode = 'ready';
          runBtn.textContent = 'Run';
          setStatus('Halted after ' + cpu.instrCount.toLocaleString() + ' instructions.');
        }
      }

      animTick(t);

      /* heat decay */
      var hot = false, k;
      for (k in heat) {
        heat[k] *= Math.exp(-dt / 300);
        if (heat[k] < 0.03) delete heat[k]; else hot = true;
      }
      if (aluFlash > 0) { aluFlash *= Math.exp(-dt / 300); if (aluFlash < 0.03) aluFlash = 0; hot = true; }

      /* memory access flashes */
      if (cpu.memLog && cpu.memLog.length) {
        for (var i = 0; i < cpu.memLog.length; i++) {
          var en = cpu.memLog[i];
          memFlash[en & 0xFFFF] = { t: t, w: (en & 0x10000) ? 1 : 0 };
        }
        cpu.memLog.length = 0;
        needMem = true;
      }

      /* counters, twice a second */
      if (t - lastCountT > 500) {
        var dc = cpu.instrCount - lastCount;
        hzNow = dc * 1000 / Math.max(1, t - lastCountT);
        lastCount = cpu.instrCount; lastCountT = t;
        if (countEl) {
          countEl.textContent = cpu.instrCount.toLocaleString() + ' instructions' +
            (running && hzNow > 0 ? ' · ' + fmtHz(hzNow) : '');
        }
        if (running && machineView && speedHz() > 30) highlightLine(cpu.lineAt(cpu.PC) || -1);
      }

      if ((needDp || hot || animCur || running) && visible(paneMachine)) {
        drawDatapath(t);
        needDp = false;
      }
      if (visible(paneScreen)) {
        drawScreen();
        if (needMem || running || hasFlash(t)) { drawMem(t); needMem = false; }
      }
    }

    function hasFlash(t) {
      for (var a in memFlash) { if (t - memFlash[a].t < 650) return true; }
      return false;
    }

    /* ---------- datapath geometry ---------- */
    var BLOCKS = {
      PC:     { x: 24,  y: 36,  w: 112, h: 44,  col: 0 },
      SP:     { x: 24,  y: 102, w: 112, h: 44,  col: 0 },
      FLAGS:  { x: 24,  y: 168, w: 112, h: 56,  col: 0 },
      MAR:    { x: 250, y: 24,  w: 130, h: 40,  col: 1 },
      RAM:    { x: 250, y: 86,  w: 130, h: 96,  col: 1 },
      IR:     { x: 250, y: 204, w: 130, h: 52,  col: 1 },
      DECODE: { x: 250, y: 278, w: 130, h: 42,  col: 1 },
      A:      { x: 478, y: 36,  w: 112, h: 44,  col: 2 },
      X:      { x: 478, y: 102, w: 112, h: 44,  col: 2 },
      ALU:    { x: 464, y: 196, w: 140, h: 84,  col: 2 }
    };
    var CH01 = 200, CH12 = 425;

    function routeFor(ph) {
      if (ph.kind === 'flag') return null;
      var f = BLOCKS[ph.from], to = BLOCKS[ph.to];
      if (!f || !to || ph.from === ph.to) return null;
      if (f.col === to.col) {
        var upper = f.y < to.y ? f : to, lower = f.y < to.y ? to : f;
        var p1 = { x: upper.x + upper.w / 2, y: upper.y + upper.h };
        var p2 = { x: lower.x + lower.w / 2, y: lower.y };
        return f.y < to.y ? [p1, p2] : [p2, p1];
      }
      var cx = (f.col === 0 || to.col === 0) ? CH01 : CH12;
      /* start and end on the block edges facing the channel */
      var s = { x: (cx > f.x + f.w / 2) ? f.x + f.w : f.x, y: f.y + f.h / 2 };
      var d = { x: (cx > to.x + to.w / 2) ? to.x + to.w : to.x, y: to.y + to.h / 2 };
      return [s, { x: cx, y: s.y }, { x: cx, y: d.y }, d];
    }

    /* ---------- datapath drawing ---------- */
    function rrect(g, x, y, w, h, r) {
      g.beginPath();
      g.moveTo(x + r, y);
      g.arcTo(x + w, y, x + w, y + h, r);
      g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r);
      g.arcTo(x, y, x + w, y, r);
      g.closePath();
    }
    function busLine(g, pts) {
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (var i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
      g.stroke();
    }
    function ptAlong(pts, t) {
      var total = 0, segs = [], i;
      for (i = 1; i < pts.length; i++) {
        var L = Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
        segs.push(L); total += L;
      }
      if (total <= 0) return pts[0];
      var d = t * total;
      for (i = 0; i < segs.length; i++) {
        if (d <= segs[i] || i === segs.length - 1) {
          var f = segs[i] ? d / segs[i] : 0;
          if (f > 1) f = 1;
          return {
            x: pts[i].x + (pts[i + 1].x - pts[i].x) * f,
            y: pts[i].y + (pts[i + 1].y - pts[i].y) * f
          };
        }
        d -= segs[i];
      }
      return pts[pts.length - 1];
    }

    function blockValue(name) {
      switch (name) {
        case 'PC': return vm.PC;
        case 'SP': return vm.SP;
        case 'A': return vm.A;
        case 'X': return vm.X;
        case 'MAR': return vm.MAR;
        case 'IR': return vm.IR;
        case 'DECODE': return vm.DEC;
        default: return '';
      }
    }

    function drawDatapath(t) {
      var g = dpCtx;
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
      g.clearRect(0, 0, dpCanvas.width / DPR, dpCanvas.height / DPR);
      g.translate(dpOffX, dpOffY);
      g.scale(dpScale, dpScale);
      g.lineWidth = 1.5;

      /* static buses */
      g.strokeStyle = THEME.faint;
      g.lineWidth = 2;
      busLine(g, [{ x: CH01, y: 40 }, { x: CH01, y: 300 }]);
      busLine(g, [{ x: CH12, y: 40 }, { x: CH12, y: 300 }]);
      g.lineWidth = 1.2;
      var stubs = [
        ['PC', CH01], ['SP', CH01], ['FLAGS', CH01],
        ['MAR', CH01], ['RAM', CH01], ['IR', CH01], ['DECODE', CH01],
        ['MAR', CH12], ['RAM', CH12], ['IR', CH12],
        ['A', CH12], ['X', CH12], ['ALU', CH12]
      ];
      for (var s = 0; s < stubs.length; s++) {
        var b0 = BLOCKS[stubs[s][0]], chx = stubs[s][1];
        var ex = chx > b0.x + b0.w / 2 ? b0.x + b0.w : b0.x;
        busLine(g, [{ x: ex, y: b0.y + b0.h / 2 }, { x: chx, y: b0.y + b0.h / 2 }]);
      }
      /* bus captions */
      g.fillStyle = THEME.muted;
      g.font = '10px "Source Sans 3", system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText('address bus', CH01, 34);
      g.fillText('data bus', CH12, 34);

      /* blocks */
      for (var name in BLOCKS) {
        var b = BLOCKS[name], h = heat[name] || 0;
        rrect(g, b.x, b.y, b.w, b.h, 7);
        g.fillStyle = 'rgba(127,127,127,0.10)';
        g.fill();
        if (h > 0.02) {
          rrect(g, b.x, b.y, b.w, b.h, 7);
          g.globalAlpha = h * (name === 'ALU' && aluFlash > 0.05 ? 0 : 0.22);
          g.fillStyle = THEME.accent;
          g.fill();
          g.globalAlpha = 1;
        }
        if (name === 'ALU' && aluFlash > 0.02) {
          rrect(g, b.x, b.y, b.w, b.h, 7);
          g.globalAlpha = aluFlash * 0.3;
          g.fillStyle = THEME.gold;
          g.fill();
          g.globalAlpha = 1;
        }
        rrect(g, b.x, b.y, b.w, b.h, 7);
        g.strokeStyle = h > 0.02 ? THEME.accent : 'rgba(127,127,127,0.45)';
        g.globalAlpha = h > 0.02 ? 0.45 + 0.55 * h : 1;
        g.lineWidth = 1.5;
        g.stroke();
        g.globalAlpha = 1;

        g.fillStyle = THEME.muted;
        g.font = '600 10px "Source Sans 3", system-ui, sans-serif';
        g.textAlign = 'left';
        g.fillText(name === 'DECODE' ? 'DECODE' : name, b.x + 8, b.y + 13);

        if (name === 'FLAGS') {
          var lam = ['Z', 'N', 'C'], vals = [vm.Z, vm.N, vm.C];
          for (var L = 0; L < 3; L++) {
            var lx = b.x + 26 + L * 30, ly = b.y + 34;
            g.beginPath();
            g.arc(lx, ly, 8, 0, Math.PI * 2);
            if (vals[L]) { g.fillStyle = THEME.accent; g.fill(); }
            else { g.strokeStyle = 'rgba(127,127,127,0.5)'; g.lineWidth = 1.2; g.stroke(); }
            g.fillStyle = vals[L] ? (THEME.light ? '#ffffff' : '#141414') : THEME.muted;
            g.font = '600 10px "Source Sans 3", system-ui, sans-serif';
            g.textAlign = 'center';
            g.fillText(lam[L], lx, ly + 3.5);
          }
          g.textAlign = 'left';
        } else if (name === 'ALU') {
          g.fillStyle = aluFlash > 0.05 ? THEME.gold : THEME.ink;
          g.font = '700 24px ui-monospace, Consolas, monospace';
          g.textAlign = 'center';
          g.fillText(vm.ALU || '·', b.x + b.w / 2, b.y + b.h / 2 + 14);
          g.textAlign = 'left';
        } else if (name === 'RAM') {
          g.fillStyle = THEME.ink;
          g.font = '13px ui-monospace, Consolas, monospace';
          g.textAlign = 'center';
          if (vm.RAMa === null) {
            g.fillText('4 KB', b.x + b.w / 2, b.y + b.h / 2 + 8);
          } else {
            g.fillText('[$' + hx4(vm.RAMa) + ']', b.x + b.w / 2, b.y + b.h / 2 + 2);
            g.fillText('$' + hx2(vm.RAMv || 0), b.x + b.w / 2, b.y + b.h / 2 + 20);
          }
          g.textAlign = 'left';
        } else {
          g.fillStyle = THEME.ink;
          g.font = '13px ui-monospace, Consolas, monospace';
          g.textAlign = 'center';
          var val = blockValue(name);
          if (val && val.length > 14) val = val.slice(0, 14);
          g.fillText(val, b.x + b.w / 2, b.y + b.h - 12);
          g.textAlign = 'left';
        }
      }

      /* traveling pulse */
      if (animCur && animCur.pts) {
        var p = (t - animCur.t0) / animCur.dur;
        if (p < 0) p = 0; if (p > 1) p = 1;
        p = p * p * (3 - 2 * p);
        var pos = ptAlong(animCur.pts, p);
        g.save();
        g.shadowColor = animCur.ph.kind === 'alu' ? THEME.gold : THEME.accent;
        g.shadowBlur = 10;
        g.fillStyle = animCur.ph.kind === 'alu' ? THEME.gold : THEME.accentHi;
        g.beginPath();
        g.arc(pos.x, pos.y, 4.5, 0, Math.PI * 2);
        g.fill();
        g.restore();
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
    }

    /* ---------- memory inspector ---------- */
    var REGIONS = [
      { id: 'prog',  name: 'Program',        base: 0x0000, pages: 15 },
      { id: 'stack', name: 'Stack $0F00',    base: 0x0F00, pages: 1 },
      { id: 'disp',  name: 'Display $1000',  base: 0x1000, pages: 4 },
      { id: 'io',    name: 'I-O $1400',      base: 0x1400, pages: 1 }
    ];
    var MEM_W = 296, MEM_H = 252, GUT = 42, CW = 15.4, RH = 15, TOPPAD = 10;

    function curRegion() {
      for (var i = 0; i < REGIONS.length; i++) if (REGIONS[i].id === regionSel.value) return REGIONS[i];
      return REGIONS[0];
    }
    function memBase() {
      var r = curRegion();
      var p = Math.min(+memPage.value || 0, r.pages - 1);
      return r.base + p * 256;
    }
    function syncMemControls() {
      var r = curRegion();
      memPage.max = String(r.pages - 1);
      if (+memPage.value > r.pages - 1) memPage.value = '0';
      memPage.disabled = r.pages <= 1;
      if (memPageVal) memPageVal.textContent = '$' + hx4(memBase());
      needMem = true;
    }
    regionSel.addEventListener('change', function () { memPage.value = '0'; syncMemControls(); });
    memPage.addEventListener('input', syncMemControls);

    function drawMem(t) {
      var g = memCtx;
      var sc = memCanvas.width / DPR / MEM_W;
      /* clear in DEVICE space: the design-space height is cssH/sc, which the
         old MEM_H/sc + 40 undershoots once the pane is wider than ~350px, and
         the 0.45-alpha flash rects then pile up into stuck blocks */
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, memCanvas.width, memCanvas.height);
      g.setTransform(DPR * sc, 0, 0, DPR * sc, 0, 0);
      var base = memBase();
      g.font = '10.5px ui-monospace, Consolas, monospace';
      for (var row = 0; row < 16; row++) {
        var y = TOPPAD + row * RH + 10;
        g.fillStyle = THEME.muted;
        g.textAlign = 'left';
        g.fillText('$' + hx4(base + row * 16), 2, y);
        for (var col = 0; col < 16; col++) {
          var a = base + row * 16 + col;
          var x = GUT + col * CW;
          var fl = memFlash[a];
          if (fl && t - fl.t < 650) {
            var al = 1 - (t - fl.t) / 650;
            g.globalAlpha = al * 0.45;
            g.fillStyle = fl.w ? THEME.accent : THEME.gold;
            g.fillRect(x - 1.5, y - 9, CW - 0.6, 12.4);
            g.globalAlpha = 1;
          }
          if (a === cpu.PC && mode !== 'edit') {
            g.strokeStyle = THEME.accent;
            g.lineWidth = 1;
            g.strokeRect(x - 1.5, y - 9, CW - 0.6, 12.4);
          }
          var v = cpu.peek(a);
          g.fillStyle = v ? THEME.ink : THEME.muted;
          g.fillText(hx2(v), x, y);
        }
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
    }

    /* click-to-edit (paused only): a bespoke overlay input that takes hex */
    var memEdit = null;
    memCanvas.addEventListener('pointerdown', function (e) {
      if (mode === 'run') { setStatus('Pause the machine to edit memory.'); return; }
      if (memEdit) return;
      var rect = memCanvas.getBoundingClientRect();
      var sc = rect.width / MEM_W;
      var mx = (e.clientX - rect.left) / sc, my = (e.clientY - rect.top) / sc;
      var col = Math.floor((mx - GUT) / CW);
      var row = Math.floor((my - TOPPAD + 2) / RH);
      if (col < 0 || col > 15 || row < 0 || row > 15) return;
      var addr = memBase() + row * 16 + col;
      if (addr >= 0x1400) { setStatus('The I-O registers ($1400+) are read-only.'); return; }
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'comp-memedit';
      inp.value = '$' + hx2(cpu.peek(addr));
      inp.setAttribute('aria-label', 'Edit byte at $' + hx4(addr));
      inp.style.left = (rect.left - memWrap.getBoundingClientRect().left + (GUT + col * CW - 2) * sc) + 'px';
      inp.style.top = (rect.top - memWrap.getBoundingClientRect().top + (TOPPAD + row * RH - 1) * sc) + 'px';
      memWrap.appendChild(inp);
      memEdit = { inp: inp, addr: addr };
      var done = false;
      function close(commit) {
        if (done) return;
        done = true;
        if (commit) {
          var txt = inp.value.replace(/\s+/g, '');
          var v = null, m;
          if ((m = /^\$([0-9a-fA-F]{1,2})$/.exec(txt))) v = parseInt(m[1], 16);
          else if ((m = /^0x([0-9a-fA-F]{1,2})$/.exec(txt))) v = parseInt(m[1], 16);
          else if (/^[0-9]{1,3}$/.test(txt)) v = Math.min(255, parseInt(txt, 10));
          if (v !== null && !isNaN(v)) {
            cpu.write(addr, v);
            memFlash[addr] = { t: lastT, w: 1 };
            setStatus('Wrote $' + hx2(v & (addr >= 0x1000 ? 0x0F : 0xFF)) + ' to $' + hx4(addr) + '.');
          }
        }
        if (inp.parentNode) inp.parentNode.removeChild(inp);
        memEdit = null;
        needMem = true;
      }
      inp.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); close(true); }
        else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(false); }
      });
      inp.addEventListener('blur', function () { close(true); });
      /* focus after the click's default actions finish (documented gotcha) */
      setTimeout(function () { inp.focus(); inp.select(); }, 0);
    });

    /* ---------- instruction reference slide-over ---------- */
    function buildReference() {
      var syn = { imp: '', imm: ' #v', abs: ' addr', abx: ' addr,X', ind: ' (addr)' };
      var h = '';
      h += '<h3>How to use</h3>';
      h += '<p>Write KL-8 assembly on the left, then press <strong>Assemble &#9656; Run</strong>. ' +
           'Watch values pulse between the registers, memory, and the ALU in the middle pane while ' +
           'your program draws on the 32&#215;32 screen. Use <strong>Step</strong> to execute one ' +
           'instruction at a time, or <strong>Micro-step</strong> to walk through the fetch, decode, ' +
           'and execute phases one bus transfer at a time. The speed slider runs the clock from 2 Hz ' +
           'up to 200 kHz. Load an example from the menu to see the machine put through its paces.</p>';
      h += '<h3>Instruction set</h3>';
      h += '<table class="comp-ref-table"><thead><tr><th>Syntax</th><th>Op</th><th>Flags</th><th>Effect</th></tr></thead><tbody>';
      for (var i = 0; i < K.ISA.length; i++) {
        var e = K.ISA[i];
        h += '<tr><td><code>' + e.mn + syn[e.mode] + '</code></td><td><code>$' + hx2(e.op) +
             '</code></td><td>' + (e.f ? e.f.split('').join(' ') : '&#8211;') + '</td><td>' + e.d + '</td></tr>';
      }
      h += '</tbody></table>';
      h += '<h3>Memory map</h3><ul>' +
           '<li><code>$0000-$0FFF</code> RAM (4 KB). Programs start at <code>$0000</code>.</li>' +
           '<li><code>$0F00-$0FFF</code> the stack page (JSR/RTS/PHA/PLA; SP starts at $FF).</li>' +
           '<li><code>$1000-$13FF</code> the screen: 32&#215;32 pixels, one byte each, ' +
             '<code>addr = $1000 + y*32 + x</code>, colors 0-15 (writes keep only the low 4 bits). Readable.</li>' +
           '<li><code>$1400</code> KEYS (read-only): bit 0 up, 1 down, 2 left, 3 right, 4 space.</li>' +
           '<li><code>$1401</code> RND (read-only): a new pseudo-random byte on every read.</li>' +
           '<li><code>$1402</code> FRAME (read-only): counts display frames, wraps at 256.</li></ul>';
      h += '<h3>Assembler</h3><ul>' +
           '<li>One instruction per line; <code>label:</code> in front; <code>;</code> starts a comment.</li>' +
           '<li>Numbers: <code>$1F</code> hex, <code>31</code> decimal, <code>&#39;A&#39;</code> character. ' +
             'Immediates take <code>#</code>: <code>LDA #$1F</code>.</li>' +
           '<li>Addresses may be a label, optionally <code>label+n</code> or <code>label-n</code> (n decimal).</li>' +
           '<li>Directives: <code>.org $addr</code>, <code>.byte v, v</code>, <code>.word v, v</code>.</li>' +
           '<li>The Tab key inserts two spaces in the editor.</li></ul>';
      h += '<h3>Notes</h3><ul>' +
           '<li>ADD and SUB have no carry-in; C is the carry out (ADD) or 1-if-no-borrow (SUB and the compares).</li>' +
           '<li><strong>WAIT syncs to the screen, not the clock</strong>: it pauses until the next display ' +
             'frame (about 60 per second), whatever the speed slider says.</li>' +
           '<li>Convention: keep variables and pointers in <code>$E0-$FF</code>; the examples do.</li>' +
           '<li>Click the screen to give it your keyboard (arrows + space). Esc or clicking elsewhere releases it.</li>' +
           '<li>Click a byte in the memory inspector while paused to edit it ($ hex or decimal).</li></ul>';
      h += '<p class="comp-ref-credit">In the spirit of Ben Eater&#39;s breadboard computer videos. ' +
           'The KL-8 is an original design; all code here is original.</p>';
      refBody.innerHTML = h;
    }
    function refOpen() { return refPanel.classList.contains('comp-ref--open'); }
    function openRef() {
      refPanel.classList.add('comp-ref--open');
      refPanel.setAttribute('aria-hidden', 'false');
      refPanel.removeAttribute('inert');
      if (refClose) refClose.focus();
    }
    function closeRef() {
      refPanel.classList.remove('comp-ref--open');
      refPanel.setAttribute('aria-hidden', 'true');
      /* the closed panel is only translated off-screen, so its buttons stay
         tabbable (and focusable content inside aria-hidden is an ARIA
         violation); inert removes them from the tab order where supported */
      refPanel.inert = true;
      if (refBtn) refBtn.focus();
    }
    refPanel.inert = true;
    if (refBtn) refBtn.addEventListener('click', function () { if (refOpen()) closeRef(); else openRef(); });
    if (refClose) refClose.addEventListener('click', closeRef);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && refOpen()) { e.preventDefault(); closeRef(); }
    });

    /* ---------- share link + save image ---------- */
    if (shareBtn) shareBtn.addEventListener('click', function () {
      var src = srcTa.value;
      if (src.length > 6000) {
        setStatus('This program is too long to share as a link (over 6000 characters).');
        return;
      }
      if (SH) SH.copyLink(shareBtn, SH.encode(1, { s: src, sp: +speedSl.value }));
    });
    if (saveBtn) saveBtn.addEventListener('click', function () {
      var dw = dpCanvas.clientWidth || 620, dh = dpCanvas.clientHeight || 352;
      var sw = scrCanvas.clientWidth || 272;
      var pad = 16;
      var tmp = document.createElement('canvas');
      tmp.width = dw + sw + pad * 3;
      tmp.height = Math.max(dh, sw) + pad * 2;
      var g = tmp.getContext('2d');
      g.fillStyle = THEME.bg;
      g.fillRect(0, 0, tmp.width, tmp.height);
      try {
        g.drawImage(dpCanvas, pad, pad, dw, dh);
        g.imageSmoothingEnabled = false;
        g.drawImage(off, dw + pad * 2, pad, sw, sw);
      } catch (err) {}
      g.strokeStyle = 'rgba(127,127,127,0.4)';
      g.strokeRect(dw + pad * 2 - 0.5, pad - 0.5, sw + 1, sw + 1);
      if (SH) SH.savePng(tmp, {
        label: 'The Visible Computer (KL-8)', file: 'kl8-computer.png',
        light: THEME.light, bg: THEME.bg
      });
    });

    /* ---------- theme observers ---------- */
    function onThemeChange() {
      rebuildTheme();
      screenAll = true; needDp = true; needMem = true;
    }
    try {
      new MutationObserver(onThemeChange).observe(document.documentElement,
        { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}
    try {
      var mq = matchMedia('(prefers-color-scheme: light)');
      if (mq.addEventListener) mq.addEventListener('change', onThemeChange);
      else if (mq.addListener) mq.addListener(onThemeChange);
      var rq = matchMedia('(prefers-reduced-motion: reduce)');
      var onRq = function () { reduced = rq.matches; };
      if (rq.addEventListener) rq.addEventListener('change', onRq);
      else if (rq.addListener) rq.addListener(onRq);
    } catch (e) {}

    /* ---------- init ---------- */
    rebuildTheme();
    buildReference();
    srcTa.value = K.EXAMPLES[0].src;
    lastLoaded = srcTa.value;
    exampleSel.value = K.EXAMPLES[0].id;
    /* restore a shared program from the URL hash (untrusted: clamp) */
    if (SH) {
      var dec = SH.decode(SH.readHash());
      if (dec && dec.version === 1 && dec.obj && typeof dec.obj.s === 'string' && dec.obj.s.length) {
        var shared = dec.obj.s.slice(0, 6000);
        srcTa.value = shared;
        lastLoaded = shared;
        /* the editor no longer holds an example: park the select on the
           placeholder so picking any real entry still fires change */
        exampleSel.value = '';
        appliedExample = '';
        if (dec.obj.sp != null) speedSl.value = String(SH.int(dec.obj.sp, 0, 100, +speedSl.value));
        var rr = assembleNow();
        if (rr) {
          loadProgram(rr);
          setStatus('Loaded a shared program (' + rr.bytes.length + ' bytes). Press Run to start it.');
        }
      }
    }
    if (speedVal) speedVal.textContent = speedLabel();
    syncMemControls();
    resetVm();
    applyCols();
    if (GU) GU.firstRunHint('computer', 'Press Assemble ▸ Run, then try Step to watch one instruction at a time.');
    requestAnimationFrame(loop);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
