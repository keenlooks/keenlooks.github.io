/* ==========================================================================
   computer.js — page runtime for The Visible Computer (/computer/).
   Wires the 3-pane app: editor + assembler errors, the circuit-board
   datapath canvas (chips, gold traces, byte sparks) with a plain-language
   narrator strip, 32x32 screen with keyboard capture + D-pad, memory
   inspector with a bespoke hex edit overlay, run controls, instruction
   reference slide-over, share/save. Machine logic lives in computer-core.js.
   ========================================================================== */
(function () {
  'use strict';

  /* ======================================================================
     narrate(ph, ctx) — a PURE function turning one micro-trace phase into
     a sentence a non-programmer can follow. No DOM, no cpu access: the
     ctx carries everything (exported for node tests as module.exports).
     ctx = {
       mnemonic,                      instruction name ('LDA', 'STA', ...)
       fetchStage, irNew, byteIndex,  opcode byte vs operand byte
       prevFlags: {z, n, c},          display flags BEFORE this phase
       vm,                            display values BEFORE this phase
                                      (vm.A/vm.X are '$21'-style strings)
       symbolsByAddr,                 inverted symbols, addr -> label name
       resA, resX                     cpu.A / cpu.X at apply time (the plan:
                                      "result from cpu.A, which IS the
                                      result at apply time")
     }
     Returns a string, or null when no template matches (the caller then
     falls back to the technical phase string).
     ====================================================================== */
  function nh2(v) { return ('0' + (v & 0xFF).toString(16).toUpperCase()).slice(-2); }
  function nh4(v) { return ('000' + (v & 0xFFFF).toString(16).toUpperCase()).slice(-4); }
  /* parse '$21' / '#$21' / '$0012' -> number, else null */
  function npnum(s) {
    var m = /^#?\$([0-9A-Fa-f]{1,4})$/.exec(String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''));
    return m ? parseInt(m[1], 16) : null;
  }
  function chipForAddr(a) {
    if (a >= 0x1000 && a < 0x1400) return 'VID';
    if (a >= 0x1400 && a <= 0x1402) return 'IO';
    return 'RAM';
  }
  /* one plain clause per mnemonic (all of them) for the DECODE sentence */
  var NARR_VERBS = {
    NOP: 'do nothing',
    LDA: 'load memory into A', LDX: 'load memory into X',
    STA: 'store the A register into memory', STX: 'store the X register into memory',
    TAX: 'copy A into X', TXA: 'copy X into A',
    ADD: 'add to A', SUB: 'subtract from A',
    AND: 'bitwise AND into A', ORA: 'bitwise OR into A', EOR: 'bitwise exclusive-OR into A',
    SHL: 'shift A left one bit', SHR: 'shift A right one bit',
    CMP: 'compare A with a value', CPX: 'compare X with a value',
    INX: 'add 1 to X', DEX: 'subtract 1 from X',
    INC: 'add 1 to a memory byte', DEC: 'subtract 1 from a memory byte',
    JMP: 'jump',
    JEQ: 'jump if the zero flag is set', JNE: 'jump if the zero flag is clear',
    JCS: 'jump if the carry flag is set', JCC: 'jump if the carry flag is clear',
    JMI: 'jump if the negative flag is set',
    JSR: 'call a subroutine', RTS: 'return from the subroutine',
    PHA: 'push A onto the stack', PLA: 'pull A from the stack',
    WAIT: 'wait for the next screen frame', HLT: 'stop the program'
  };
  /* branch mnemonics: [flag letter, state (1 = set) that takes the jump] */
  var NARR_BRANCH = { JEQ: ['Z', 1], JNE: ['Z', 0], JCS: ['C', 1], JCC: ['C', 0], JMI: ['N', 1] };

  function narrate(ph, ctx) {
    if (!ph) return null;
    ctx = ctx || {};
    var mn = ctx.mnemonic || '';
    var vm = ctx.vm || {};
    var lbl = ph.label || '';

    /* ---- flag phases ---- */
    if (ph.kind === 'flag') {
      if (ph.flags) {
        var f = ph.flags;
        var p = ctx.prevFlags || { z: 0, n: 0, c: 0 };
        if (f.z !== p.z) {
          return f.z ? 'The result was zero, so the Z flag switches on.'
                     : 'The result was not zero, so the Z flag switches off.';
        }
        if (f.c !== p.c) {
          if (mn === 'ADD') return f.c ? 'The sum went past 255, so the carry flag switches on.'
                                       : 'No overflow this time, so the carry flag switches off.';
          if (mn === 'SUB' || mn === 'CMP' || mn === 'CPX') {
            return f.c ? 'There was no borrow, so the carry flag switches on.'
                       : 'It went below zero, so the carry flag switches off.';
          }
          if (mn === 'SHL' || mn === 'SHR') {
            return f.c ? 'A 1 bit fell off the end, so the carry flag switches on.'
                       : 'A 0 bit fell off the end, so the carry flag switches off.';
          }
          return f.c ? 'The carry flag switches on.' : 'The carry flag switches off.';
        }
        if (f.n !== p.n) {
          return f.n ? 'The top bit of the result is 1, so the N flag switches on.'
                     : 'The top bit of the result is 0, so the N flag switches off.';
        }
        return f.z ? 'The result was zero again, so the Z flag stays on.'
                   : 'The result was not zero, so the Z flag stays off.';
      }
      /* branch condition check (label: 'Z=1 ? yes, jump' / '... no, continue') */
      if (NARR_BRANCH[mn]) {
        var b = NARR_BRANCH[mn];
        var taken = /yes/.test(lbl);
        if (!taken) return b[0] + ' is ' + (b[1] ? 'clear' : 'set') + ', so no jump; carry on.';
        return b[0] + ' is ' + (b[1] ? 'set' : 'clear') + ', so the jump goes ahead.';
      }
      if (/^waiting/.test(lbl)) return 'Waiting for the next screen frame. This is how it paces itself.';
      if (lbl === 'halted') return 'The program stops here. Press Reset, then Run to start it again.';
      return null; /* bad opcode etc: technical fallback */
    }

    /* ---- ALU phases ---- */
    if (ph.kind === 'alu') {
      var mq;
      if ((mq = /^([AX])\s*(<<|>>|[+\-&|^])\s*(\S+)\s*(\?)?$/.exec(lbl))) {
        var reg = mq[1], op = mq[2], rhs = mq[3];
        var before = (reg === 'A' ? vm.A : vm.X) || reg;
        if (mq[4]) {
          /* compare: no result is stored, only flags */
          return 'The ALU compares ' + reg + ' (' + before + ') with ' + rhs + ' to set the flags.';
        }
        var res = (reg === 'A') ? ctx.resA : ctx.resX;
        if (res == null) return 'The ALU computes ' + before + ' ' + op + ' ' + rhs + '.';
        return 'The ALU computes ' + before + ' ' + op + ' ' + rhs + ' = $' + nh2(res) + '.';
      }
      if (/\+ X$/.test(lbl)) {
        return 'The ALU adds X (' + (vm.X || 'X') + ') to ' + lbl.replace(/\s*\+ X$/, '') +
               ' to make the final address.';
      }
      return null;
    }

    /* ---- moves ---- */
    if (ph.kind !== 'move') return null;
    var from = ph.from, to = ph.to;

    /* fetch: the program counter points at the next instruction */
    if (from === 'PC' && to === 'MAR' && ctx.fetchStage !== false) {
      return 'The program counter says the next instruction is at ' + lbl + '.';
    }

    /* fetch: memory hands bytes to the instruction register */
    if (from === 'RAM' && to === 'IR') {
      if (ctx.irNew !== false) {
        return 'Memory sends back ' + lbl + '. That is an instruction byte.';
      }
      /* operand byte(s). Two bytes arrive LOW BYTE FIRST ('$E3 $10' means
         $10E3) - never join the label text naively. */
      var bm = /^\$([0-9A-Fa-f]{2})(?:\s+\$([0-9A-Fa-f]{2}))?$/.exec(lbl);
      if (bm) {
        var opv = parseInt(bm[1], 16) | (bm[2] ? parseInt(bm[2], 16) << 8 : 0);
        var hex = bm[2] ? nh4(opv) : nh2(opv);
        return 'The instruction needs more: memory sends the operand $' + hex + '.';
      }
      return 'The instruction needs more: memory sends the operand ' + lbl + '.';
    }

    /* decode */
    if (to === 'DECODE') {
      var dmn = mn || (lbl.split(/\s+/)[0] || '');
      var clause = NARR_VERBS[dmn];
      if (clause) return 'Decoded: ' + dmn + ', ' + clause + '.';
      return null;
    }

    /* jumps and calls land in the PC */
    if (to === 'PC' && from === 'IR') {
      var ta = npnum(lbl);
      var sym = (ctx.symbolsByAddr && ta != null) ? ctx.symbolsByAddr[ta] : null;
      var tgt = sym ? (sym + ' (' + lbl + ')') : lbl;
      if (mn === 'JSR') return 'The program calls the subroutine ' + tgt + '.';
      if (NARR_BRANCH[mn]) {
        var bb = NARR_BRANCH[mn];
        return bb[0] + ' is ' + (bb[1] ? 'set' : 'clear') + ', so the program jumps to ' + tgt + '.';
      }
      return 'The program jumps to ' + tgt + '.';
    }

    /* writes into memory (the RAM endpoint may really be video or I/O) */
    if (to === 'RAM' && ph.addr !== undefined) {
      if (from === 'PC') {
        var ra = npnum(lbl.replace(/^push\s+/, ''));
        return 'The return address (' + (ra != null ? '$' + nh4(ra) : lbl) + ') is saved on the stack.';
      }
      var who = (from === 'A') ? 'A' : (from === 'X') ? 'X' : 'The result';
      if (chipForAddr(ph.addr) === 'VID') {
        var vo = ph.addr - 0x1000;
        return who + ' (' + lbl + ') is written into video memory. Pixel (' +
               (vo & 31) + ', ' + (vo >> 5) + ') changes color.';
      }
      if (mn === 'PHA') return 'A (' + lbl + ') is pushed onto the stack.';
      return who + ' (' + lbl + ') is stored at address $' + nh4(ph.addr) + '.';
    }

    /* reads out of memory */
    if (from === 'RAM' && ph.addr !== undefined) {
      if (ph.addr === 0x1400) return 'The program checks the keyboard.';
      if (ph.addr === 0x1401) return 'The program asks for a random number and gets ' + lbl + '.';
      if (ph.addr === 0x1402) return 'The program reads the frame counter (' + lbl + ').';
      if (to === 'PC') return 'The saved address (' + lbl + ') comes off the stack. The program returns there.';
      if (to === 'MAR') return 'Memory hands over a pointer: it says look at ' + lbl + '.';
      if (chipForAddr(ph.addr) === 'VID') {
        var ro = ph.addr - 0x1000;
        return 'The pixel at (' + (ro & 31) + ', ' + (ro >> 5) + ') reads back ' + lbl + '.';
      }
      if (mn === 'PLA' && to === 'A') return 'A gets ' + lbl + ' back from the stack.';
      if (to === 'ALU') return 'The value at $' + nh4(ph.addr) + ' (' + lbl + ') goes to the ALU.';
      return 'The value at $' + nh4(ph.addr) + ' (' + lbl + ') is loaded into ' + to + '.';
    }

    /* register-to-register and immediate moves */
    if (from === 'IR' && (to === 'A' || to === 'X')) {
      return 'The value ' + lbl.replace(/^#/, '') + ' goes straight into ' + to + '.';
    }
    if (from === 'IR' && to === 'ALU') return 'The value ' + lbl.replace(/^#/, '') + ' goes to the ALU.';
    if (from === 'IR' && to === 'MAR') return 'Memory is pointed at address ' + lbl + '.';
    if (from === 'ALU' && to === 'MAR') return 'Memory is pointed at the computed address ' + lbl + '.';
    if (from === 'SP' && to === 'MAR') return 'The stack pointer picks the top of the stack (' + lbl + ').';
    if (from === 'A' && to === 'X') return 'A (' + lbl + ') is copied into X.';
    if (from === 'X' && to === 'A') return 'X (' + lbl + ') is copied into A.';
    if (from === 'ALU' && (to === 'A' || to === 'X')) return 'The result (' + lbl + ') lands in ' + to + '.';
    return null;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { narrate: narrate, chipForAddr: chipForAddr };
  }
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
    if (GU && GU.liveStatus) GU.liveStatus(errBox);
    var assembleBtn = $('comp-assemble'), exampleSel = $('comp-examples'), refBtn = $('comp-ref-btn');
    var dpWrap = $('comp-dpwrap'), dpCanvas = $('comp-datapath'), phaseEl = $('comp-phase');
    var narMain = $('comp-narrate-main'), narSr = $('comp-narrate-sr'), byteChipBtn = $('comp-bytechip');
    var scrCanvas = $('comp-screen'), capNote = $('comp-capnote'), dpad = $('comp-dpad');
    var resetBtn = $('comp-reset'), microBtn = $('comp-micro'), stepBtn = $('comp-step'), runBtn = $('comp-run');
    var speedSl = $('comp-speed'), speedVal = $('comp-speedval');
    var countEl = $('comp-count'), statusEl = $('comp-status');
    if (GU && GU.liveStatus) GU.liveStatus(statusEl);
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
    /* The first-run hint is bottom-anchored on a short landscape window (see
       computer.md), where the bottom belongs to the chat widget on the right
       and the corner buttons on the left. chat-widget.js appends its bar a
       second or two AFTER page scripts run, so the first measurement sees
       nothing: publish the floor as a CSS variable and refresh it when the
       widget turns up. */
    function fitHintBottom() {
      var ids = ['chat-widget', 'theme-toggle', 'life-link'], floor = 0, i, el, r;
      for (i = 0; i < ids.length; i++) {
        el = document.getElementById(ids[i]);
        if (!el) continue;
        r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (window.innerHeight - r.top > floor) floor = window.innerHeight - r.top;
      }
      document.documentElement.style.setProperty('--comp-hint-bottom',
        Math.round(floor + 14) + 'px');
    }
    (function watchChat() {
      fitHintBottom();
      if (document.getElementById('chat-widget')) return;
      var tries = 0, iv = setInterval(function () {
        if (document.getElementById('chat-widget') || ++tries > 12) {
          clearInterval(iv);
          fitHintBottom();
        }
      }, 400);
      try {
        var mo = new MutationObserver(function () {
          if (!document.getElementById('chat-widget')) return;
          mo.disconnect();
          clearInterval(iv);
          fitHintBottom();
        });
        mo.observe(document.body, { childList: true });
      } catch (e) {}
    })();

    window.addEventListener('resize', function () { applyCols(); fitHintBottom(); });

    /* ---------- canvases: sizing ---------- */
    var DPR = Math.min(window.devicePixelRatio || 1, 2);
    var dpCtx = dpCanvas.getContext('2d');
    var scrCtx = scrCanvas.getContext('2d');
    var memCtx = memCanvas.getContext('2d');
    var dpScrolled = false;

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
      /* datapath: fill its wrapper. The board used to claim a 560px minimum on
         the single-column (phone) layout and pan inside a ~344px pane, which
         cut BOTH edges: the chip titles and the whole row-label column landed
         off-screen. It scales down to the pane instead, with a hard floor at
         280px (below that layoutBoard's chip stack overlaps the bus channels,
         because rowH bottoms out at 13px) where the wrapper still pans. */
      if (dpWrap && dpWrap.clientWidth > 0) {
        var w = Math.max(dpWrap.clientWidth, oneCol ? 280 : 0);
        var h = Math.max(200, dpWrap.clientHeight);
        sizeOne(dpCanvas, w, h);
        ensureBoard(w, h);
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
    /* Drain the display dirty list ONCE per frame, UNCONDITIONALLY, into the
       offscreen 32x32 — the VID chip's mini screen must keep updating even
       when the Screen pane is hidden (2-col view, 1-col Machine tab). Both
       consumers (mini blit + big blit) feed from this single drain, because
       drainDirty() clears the list. Returns true when pixels changed. */
    function updateOffscreen() {
      var d = cpu.drainDirty();
      if (screenAll) { d = 'all'; screenAll = false; }
      if (!d) return false;
      if (d === 'all') { for (var i = 0; i < 1024; i++) paintPixel(i); }
      else { for (var j = 0; j < d.length; j++) paintPixel(d[j]); }
      offCtx.putImageData(img, 0, 0);
      return true;
    }
    /* video-write cause-and-effect: a ~500 ms highlight ring on the pixel a
       traced STA just wrote, on BOTH the big screen and the VID mini screen.
       The core's dirty bookkeeping is frozen (a same-value write never
       dirties anything), so ring create/expire force the existing
       full-repaint path (screenAll) and the ring is drawn AFTER the blit. */
    var lastVidWrite = null, ringWas = false;
    function vidRingOn(t) { return !!(lastVidWrite && (t - lastVidWrite.t) < 500); }
    function blitScreen(changed, t) {
      var ringOn = vidRingOn(t);
      if (ringOn && !ringWas) changed = true;          /* first ring frame */
      if (!ringOn && ringWas) screenAll = true;        /* erase it next frame */
      ringWas = ringOn;
      if (changed) {
        scrCtx.setTransform(1, 0, 0, 1, 0, 0);
        scrCtx.imageSmoothingEnabled = false;
        scrCtx.clearRect(0, 0, scrCanvas.width, scrCanvas.height);
        scrCtx.drawImage(off, 0, 0, scrCanvas.width, scrCanvas.height);
      }
      if (ringOn && changed) {
        var cell = scrCanvas.width / 32;
        scrCtx.strokeStyle = THEME.accentHi;
        scrCtx.lineWidth = Math.max(2, DPR * 1.5);
        scrCtx.strokeRect(lastVidWrite.x * cell + 1, lastVidWrite.y * cell + 1, cell - 2, cell - 2);
      }
    }

    /* ---------- keyboard capture (canvas has tabindex=0) ---------- */
    var KEYBITS = { ArrowUp: 1, ArrowDown: 2, ArrowLeft: 4, ArrowRight: 8, ' ': 16 };
    scrCanvas.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { scrCanvas.blur(); return; }
      var b = KEYBITS[e.key];
      if (b) { kbBits |= b; needDp = true; e.preventDefault(); }
    });
    scrCanvas.addEventListener('keyup', function (e) {
      var b = KEYBITS[e.key];
      if (b) { kbBits &= ~b; needDp = true; e.preventDefault(); }
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
            needDp = true;
            btn.classList.add('comp-dbtn--on');
          });
          function release() {
            dpadBits &= ~bit;
            needDp = true;
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
    /* focus the textarea after the swap so the next keystroke types into the
       source instead of falling on <body> (where "/" opens the site palette) */
    srcView.addEventListener('click', function () {
      stopMachine('Edited: machine stopped.');
      if (srcTa && !srcTa.hidden) srcTa.focus();
    });
    srcView.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        stopMachine('Edited: machine stopped.');
        if (srcTa && !srcTa.hidden) srcTa.focus();
      }
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
      lastVidWrite = null;
      animQ.length = 0; animCur = null; microCredit = 0;
      symbolsByAddr = {};
      if (r.symbols) { for (var sy in r.symbols) symbolsByAddr[r.symbols[sy]] = sy; }
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
      lastVidWrite = null;
      memFlash = {};
      resetVm();
      stopMachine('Reset. The screen and registers are cleared.');
      needDp = true; needMem = true;
    }

    /* ---------- view model + phase animation ---------- */
    var vm = {}, heat = {}, aluFlash = 0;
    var animQ = [], animCur = null, microCredit = 0, playMode = 'auto';
    var fetchStage = true, irNew = true;
    var curMn = '';                  /* mnemonic of the instruction in animQ */
    var symbolsByAddr = {};          /* addr -> label name, for the narrator */
    var acc = 0;
    var needDp = true, needMem = true;

    /* ---------- narrator strip ----------
       The visible strip is #comp-narrate-main (plain words) over #comp-phase
       (the small grey technical line). Screen readers get a separate
       visually-hidden mirror throttled to one announcement per 2 s. */
    var lastNarr = '', srPending = '', srLastTxt = '', srLastT = -1e9;
    function setNarration(main, tech) {
      lastNarr = main || '';
      if (narMain && narMain.textContent !== lastNarr) narMain.textContent = lastNarr;
      if (phaseEl) phaseEl.textContent = (tech == null ? '' : tech);
      srPending = lastNarr;
    }
    function narrateWait(tech) {
      setNarration('Waiting for the next screen frame. This is how it paces itself.',
        tech || ('WAIT: display frame ' + cpu.frameCount + ' ticked'));
    }
    var lastFastNarT = -1e9;
    function narrateFastLine() {
      if (lastT - lastFastNarT < 1000) return;
      lastFastNarT = lastT;
      var rate = Math.round(hzNow);
      setNarration(rate > 0
        ? 'Running fast: about ' + rate.toLocaleString() + ' instructions per second. ' +
          'Slow it down or press Step to watch one at a time.'
        : 'Running fast. Slow it down or press Step to watch one at a time.',
        'running at about ' + fmtHz(hzNow));
    }

    function resetVm() {
      vm = {
        PC: '$' + hx4(cpu.PC), SP: '$' + hx2(cpu.SP), A: '$' + hx2(cpu.A), X: '$' + hx2(cpu.X),
        MAR: '----', RAMa: null, RAMv: null, RAMchip: 'RAM', ramR: null, vidR: null,
        IR: '--', DEC: 'ready', ALU: '',
        Z: cpu.Z, N: cpu.N, C: cpu.C
      };
      heat = {}; aluFlash = 0;
      setNarration('', '');
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

    function applyPhase(ph, mn) {
      /* narrate FIRST: ctx.vm / prevFlags must be the pre-phase display
         state, while cpu.* already holds the post-instruction values (the
         ALU "result" reads exactly that, at apply time) */
      var sentence = null;
      try {
        sentence = narrate(ph, {
          mnemonic: mn || curMn,
          fetchStage: fetchStage, irNew: irNew, byteIndex: irNew ? 0 : 1,
          prevFlags: { z: vm.Z, n: vm.N, c: vm.C },
          vm: vm,
          symbolsByAddr: symbolsByAddr,
          resA: cpu.A, resX: cpu.X
        });
      } catch (e) { sentence = null; }

      /* every memory phase is named RAM in the trace; route the visual to
         the chip the ADDRESS really belongs to (RAM / VID / IO) */
      var chip = (ph.addr !== undefined) ? chipForAddr(ph.addr) : null;
      bump(ph.to === 'RAM' && chip ? chip : ph.to);
      if (ph.kind === 'alu') { vm.ALU = ph.op || ''; aluFlash = 1; bump('ALU'); }
      else if (ph.kind === 'flag') {
        if (ph.flags) { vm.Z = ph.flags.z; vm.N = ph.flags.n; vm.C = ph.flags.c; }
        bump('FLAGS');
      } else {
        if (ph.to === 'MAR') vm.MAR = ph.label;
        if (ph.addr !== undefined) {
          vm.RAMa = ph.addr; vm.RAMv = cpu.peek(ph.addr); vm.RAMchip = chip;
          if (chip === 'RAM') { vm.ramR = { a: ph.addr, v: vm.RAMv }; bump('RAM'); }
          else if (chip === 'VID') { vm.vidR = { a: ph.addr, v: vm.RAMv }; bump('VID'); }
          else { bump('IO'); bump('IO' + (ph.addr - 0x1400)); }
        }
        if (ph.to === 'IR') { vm.IR = irNew ? ph.label : vm.IR + ' ' + ph.label; irNew = false; }
        if (ph.to === 'DECODE') { vm.DEC = ph.label; fetchStage = false; }
        if (ph.to === 'A') vm.A = '$' + hx2(cpu.A);
        if (ph.to === 'X') vm.X = '$' + hx2(cpu.X);
        if (ph.to === 'PC') vm.PC = ph.label;
        if (ph.from === 'PC' && ph.to === 'MAR') vm.PC = ph.label;
        if (ph.from === 'SP' || ph.to === 'SP') { vm.SP = '$' + hx2(cpu.SP); bump('SP'); }
      }

      /* the code did that: ring the just-written pixel for ~500 ms */
      if (ph.kind === 'move' && ph.to === 'RAM' && ph.addr !== undefined &&
          ph.addr >= 0x1000 && ph.addr < 0x1400) {
        lastVidWrite = { x: (ph.addr - 0x1000) & 31, y: (ph.addr - 0x1000) >> 5, t: lastT };
        screenAll = true;   /* ring created: force the full-repaint path */
      }

      /* narrator update policy: per phase when stepping; once per
         instruction (the DECODE sentence) in pulse-mode Run, which already
         executes ~25 phases/s - per-phase prose would be an unreadable blur */
      var tech = phaseText(ph);
      if (mode !== 'run') setNarration(sentence || tech, tech);
      else if (speedHz() <= 30) {
        if (ph.kind === 'move' && ph.to === 'DECODE') setNarration(sentence || tech, tech);
        else if (phaseEl) phaseEl.textContent = tech;
      }
      needDp = true;
    }

    function beginTrace(tr, perPhase) {
      if (tr.line) highlightLine(tr.line);
      fetchStage = true; irNew = true;
      curMn = (tr.text || '').split(/\s+/)[0] || '';
      for (var i = 0; i < tr.phases.length; i++) {
        animQ.push({ ph: tr.phases[i], dur: perPhase, mn: curMn });
      }
    }
    function flushAnim() {
      if (animCur) { applyPhase(animCur.ph, animCur.mn); animCur = null; }
      while (animQ.length) { var q = animQ.shift(); applyPhase(q.ph, q.mn); }
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
        if (nx.dur <= 0) { applyPhase(nx.ph, nx.mn); if (!animQ.length) syncVmEnd(); return; }
        animCur = { ph: nx.ph, t0: now, dur: nx.dur, mn: nx.mn, pts: routeFor(nx.ph) };
      }
      if (animCur && now - animCur.t0 >= animCur.dur) {
        applyPhase(animCur.ph, animCur.mn);
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
        /* the strip must never keep claiming "Running fast..." while paused */
        setNarration('Paused. Step runs one instruction; Micro-step moves one byte.', '');
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
        narrateWait();
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
          narrateWait();
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
      /* crossing pulse -> fast mid-run: queued pulse phases would keep
         overwriting the live register values with stale labels */
      if (mode === 'run' && speedHz() > 30) flushAnim();
    });

    /* "Watch it byte by byte": one honest click from the fast boot into the
       pulses-and-sentences view. Note pulse-mode Run throughput is bounded
       at ~4 instructions/s by the 40 ms per-phase clamp, whatever the
       slider says below 30 Hz - never promise per-pixel motion here. */
    var byteChipUsed = false;
    if (byteChipBtn) byteChipBtn.addEventListener('click', function () {
      byteChipUsed = true;
      byteChipBtn.hidden = true;
      if (!ensureMachine()) return;
      speedSl.value = '0';                 /* 2 Hz: pulse mode */
      if (speedVal) speedVal.textContent = speedLabel();
      flushAnim();
      if (cpu.halted) { setStatus('Halted. Press Reset, then Run.'); return; }
      mode = 'run'; playMode = 'auto';
      runBtn.textContent = 'Pause';
      setStatus('Slowed to 2 Hz. Every byte now travels the board.');
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
      vm.RAMchip = 'RAM';
      vm.ramR = { a: cpu.PC, v: vm.RAMv };
      bump('PC'); bump('RAM'); bump('IR'); bump('DECODE'); bump('MAR');
      if (cpu.A !== pA) { bump('A'); bump('ALU'); aluFlash = Math.max(aluFlash, 0.6); }
      if (cpu.X !== pX) bump('X');
      if (cpu.Z !== pZ || cpu.N !== pN || cpu.C !== pC) bump('FLAGS');
      narrateFastLine();
      needDp = true;
    }

    var lastT = 0;
    var frameDeltasArr = [];         /* rolling last ~120 rAF deltas (test hook) */
    function loop(t) {
      requestAnimationFrame(loop);
      var dt = lastT ? Math.min(100, t - lastT) : 16.7;
      lastT = t;
      frameDeltasArr.push(dt);
      if (frameDeltasArr.length > 120) frameDeltasArr.shift();
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
              narrateWait('WAIT: waiting for the next display frame');
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
          setNarration('The program stops here. Press Reset, then Run to start it again.', 'HLT');
        }
      }

      animTick(t);

      /* one-time byte-by-byte chip: only offered while running fast */
      if (byteChipBtn) {
        var showChip = (mode === 'run' && !cpu.halted && speedHz() > 30 && !byteChipUsed);
        if (byteChipBtn.hidden !== !showChip) byteChipBtn.hidden = !showChip;
      }
      /* screen-reader mirror, throttled to one announcement per 2 s */
      if (narSr && srPending !== srLastTxt && t - srLastT >= 2000) {
        narSr.textContent = srPending;
        srLastTxt = srPending; srLastT = t;
      }

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

      /* drain the display dirty list exactly once per frame, whether or not
         the Screen pane is visible (the VID mini screen feeds from this) */
      var offChanged = updateOffscreen();

      if ((needDp || hot || animCur || running) && visible(paneMachine)) {
        drawDatapath(t);
        needDp = false;
      }
      if (visible(paneScreen)) {
        blitScreen(offChanged, t);
        if (needMem || running || hasFlash(t)) { drawMem(t); needMem = false; }
      }
    }

    function hasFlash(t) {
      for (var a in memFlash) { if (t - memFlash[a].t < 650) return true; }
      return false;
    }

    /* ---------- circuit board: layout ----------
       layoutBoard(w, h) receives the CANVAS CSS size and computes every
       chip rect, row rect, pin point, and riser x; everything else reads
       its output. Five chip packages group the logical blocks (the block
       NAMES stay exactly what the vm/heat/routing machinery uses):
         CTRL "CONTROL"          rows PC, SP, IR, DECODE
         CPU  "ALU + REGISTERS"  rows A, X, ALU, FLAGS
         RAM  "RAM 4 KB"         rows MAR + the addressed byte
         VID  "VIDEO"            live mini copy of the 32x32 screen
         IO   "I/O"              rows KEYS, RND, FRAME
       All sizes are floored (review invariant: a negative rect throws in
       ctx.arc and one throw kills the rAF loop permanently). */
    function clampN(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

    function layoutBoard(w, h) {
      /* cap the board height and float it centered: on a tall pane a
         full-height board leaves a dead zone between the chips and the
         bottom bus channels */
      var bh = clampN(h - 24, 90, 560);
      var bd = { x: 12, y: Math.max(12, Math.round((h - bh) / 2)), w: Math.max(120, w - 24), h: bh };
      var pad = 14;
      var chanA = bd.y + bd.h - 42;      /* address channel y */
      var chanD = chanA + 9;             /* data channel y */
      var chipTop = bd.y + 14;
      var chipBot = Math.max(chipTop + 70, chanA - 16);
      var innerW = bd.w - pad * 2;
      var gap = Math.max(26, innerW * 0.06);
      var colW = Math.max(60, (innerW - 2 * gap) / 3);
      var lx = bd.x + pad, cxx = lx + colW + gap, rxx = cxx + colW + gap;
      var HH = 17, PB = 7, CGAP = 12;
      var avail = chipBot - chipTop;
      var rowH = clampN((avail - CGAP - 2 * (HH + PB)) / 8, 13, 22);

      var chips = {}, rows = {}, pins = {};
      function chip(name, x, y, cw, chh, label) {
        chips[name] = { rect: { x: x, y: y, w: cw, h: chh }, label: label, rows: [] };
      }
      function row(name, chipName, y, rh) {
        var c = chips[chipName].rect;
        rows[name] = { x: c.x + 5, y: y, w: c.w - 10, h: rh, chip: chipName };
        chips[chipName].rows.push(name);
      }

      var i, names;
      chip('CTRL', lx, chipTop, colW, HH + 4 * rowH + PB, 'CONTROL');
      names = ['PC', 'SP', 'IR', 'DECODE'];
      for (i = 0; i < 4; i++) row(names[i], 'CTRL', chipTop + HH + i * rowH, rowH);
      var cpuY = chipTop + chips.CTRL.rect.h + CGAP;
      chip('CPU', lx, cpuY, colW, HH + 4 * rowH + PB, 'ALU + REGISTERS');
      names = ['A', 'X', 'ALU', 'FLAGS'];
      for (i = 0; i < 4; i++) row(names[i], 'CPU', cpuY + HH + i * rowH, rowH);

      var ramH = clampN(avail * 0.62, HH + 2 * rowH + PB, avail);
      chip('RAM', cxx, chipTop, colW, ramH, 'RAM 4 KB');
      row('MAR', 'RAM', chipTop + HH, rowH);
      row('RAMBYTE', 'RAM', chipTop + HH + rowH, rowH);

      var ioH = HH + 3 * rowH + PB;
      var mini = Math.round(clampN(
        Math.min(colW - 20, avail - CGAP - ioH - (HH + rowH + PB) - 4), 24, 64));
      var vidH = HH + mini + 4 + rowH + PB;
      chip('VID', rxx, chipTop, colW, vidH, 'VIDEO');
      var miniRect = { x: Math.round(rxx + (colW - mini) / 2), y: chipTop + HH + 2, w: mini, h: mini };
      row('VIDB', 'VID', miniRect.y + mini + 2, rowH);
      var ioY = chipTop + vidH + CGAP;
      chip('IO', rxx, ioY, colW, ioH, 'I/O');
      names = ['KEYS', 'RND', 'FRAME'];
      for (i = 0; i < 3; i++) row(names[i], 'IO', ioY + HH + i * rowH, rowH);

      /* pins + risers: left-column pins exit RIGHT into the left gap; RAM
         pins exit LEFT into the same gap's riser ladder; VID/IO pins exit
         LEFT into the center gap's ladder. Staggered riser x per pin. */
      var spL = clampN((gap - 10) / 10, 1.8, 4.5);
      var gL0 = lx + colW + 5;
      var order = ['PC', 'SP', 'IR', 'DECODE', 'A', 'X', 'ALU', 'FLAGS', 'MAR', 'RAMBYTE'];
      for (i = 0; i < order.length; i++) {
        var rr = rows[order[i]], cRect = chips[rr.chip].rect;
        pins[order[i]] = {
          x: (rr.chip === 'RAM') ? cRect.x : cRect.x + cRect.w,
          y: rr.y + rr.h / 2,
          rx: gL0 + i * spL,
          chip: rr.chip
        };
      }
      var spC = clampN((gap - 10) / 5, 2.5, 6);
      var gC0 = cxx + colW + 5;
      order = ['VIDB', 'KEYS', 'RND', 'FRAME'];
      for (i = 0; i < order.length; i++) {
        var rr2 = rows[order[i]];
        pins[order[i]] = {
          x: chips[rr2.chip].rect.x, y: rr2.y + rr2.h / 2,
          rx: gC0 + i * spC, chip: rr2.chip
        };
      }

      return {
        w: w, h: h, bd: bd, pad: pad, chips: chips, rows: rows, pins: pins,
        chanA: chanA, chanD: chanD, mini: miniRect, rowH: rowH,
        spanX0: bd.x + pad, spanX1: bd.x + bd.w - pad
      };
    }

    /* which heat key lights a given row */
    function rowHeatKey(rn) {
      if (rn === 'RAMBYTE') return 'RAM';
      if (rn === 'VIDB') return 'VID';
      if (rn === 'KEYS') return 'IO0';
      if (rn === 'RND') return 'IO1';
      if (rn === 'FRAME') return 'IO2';
      return rn;
    }

    /* classic PCB corners: cut every interior vertex of an orthogonal
       polyline into two 45-degree segments */
    function chamfer(pts, c) {
      if (!pts || pts.length < 3) return pts;
      var out = [pts[0]];
      for (var i = 1; i < pts.length - 1; i++) {
        var p = pts[i - 1], v = pts[i], n = pts[i + 1];
        var d1 = Math.abs(v.x - p.x) + Math.abs(v.y - p.y);
        var d2 = Math.abs(n.x - v.x) + Math.abs(n.y - v.y);
        if (d1 < 0.5 || d2 < 0.5) { out.push(v); continue; }
        var c1 = Math.min(c, d1 / 2), c2 = Math.min(c, d2 / 2);
        out.push({ x: v.x + (p.x - v.x) * (c1 / d1), y: v.y + (p.y - v.y) * (c1 / d1) });
        out.push({ x: v.x + (n.x - v.x) * (c2 / d2), y: v.y + (n.y - v.y) * (c2 / d2) });
      }
      out.push(pts[pts.length - 1]);
      return out;
    }

    /* address-based chip routing: every memory access is named RAM in the
       trace, so the endpoint is overridden by ph.addr - video addresses
       route to the VID chip, the I/O registers to their IO rows. Without
       this no pulse would ever reach VID or IO. Page-side only. */
    function endpointFor(name, addr) {
      if (name !== 'RAM') return name;
      if (addr === undefined) return 'RAMBYTE';
      var c = chipForAddr(addr);
      if (c === 'VID') return 'VIDB';
      if (c === 'IO') {
        return addr === 0x1400 ? 'KEYS' : (addr === 0x1401 ? 'RND' : 'FRAME');
      }
      return 'RAMBYTE';
    }

    function routeFor(ph) {
      if (!L || ph.kind === 'flag') return null;
      var fn = endpointFor(ph.from, ph.addr);
      var tn = endpointFor(ph.to, ph.addr);
      if (fn === tn) return null;
      var pf = L.pins[fn], pt2 = L.pins[tn];
      if (!pf || !pt2) return null;
      /* address-type moves (anything INTO the MAR) ride the address
         channel; everything else rides the data channel */
      var chanY = (ph.to === 'MAR') ? L.chanA : L.chanD;
      var ortho;
      if (pf.chip === pt2.chip) {
        /* short jog just outside the shared chip edge */
        ortho = [
          { x: pf.x, y: pf.y }, { x: pf.rx, y: pf.y },
          { x: pf.rx, y: pt2.y }, { x: pt2.x, y: pt2.y }
        ];
      } else {
        ortho = [
          { x: pf.x, y: pf.y }, { x: pf.rx, y: pf.y }, { x: pf.rx, y: chanY },
          { x: pt2.rx, y: chanY }, { x: pt2.rx, y: pt2.y }, { x: pt2.x, y: pt2.y }
        ];
      }
      return chamfer(ortho, 5);
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

    /* ---------- circuit board: static layer ----------
       boardLayer holds the PCB itself (substrate, silkscreen, chips, pins,
       idle traces) and is redrawn ONLY on resize / theme change, keyed on
       (canvas CSS size, theme). Every layout path funnels through
       sizeCanvases -> ensureBoard; drawDatapath also calls ensureBoard so a
       theme flip (which changes the key via rebuildTheme) rebuilds too. */
    var L = null, boardLayer = null, boardKey = '';
    function ensureBoard(w, h) {
      var key = Math.round(w) + 'x' + Math.round(h) + (THEME.light ? 'L' : 'D');
      if (L && boardLayer && key === boardKey) return;
      boardKey = key;
      L = layoutBoard(w, h);
      buildBoardLayer(w, h);
      needDp = true;
    }

    function chanLines(g, y) {
      g.beginPath();
      g.moveTo(L.spanX0, y - 2.5); g.lineTo(L.spanX1, y - 2.5);
      g.moveTo(L.spanX0, y); g.lineTo(L.spanX1, y);
      g.moveTo(L.spanX0, y + 2.5); g.lineTo(L.spanX1, y + 2.5);
      g.stroke();
    }

    function buildBoardLayer(w, h) {
      if (!boardLayer) boardLayer = document.createElement('canvas');
      boardLayer.width = Math.max(1, Math.round(w * DPR));
      boardLayer.height = Math.max(1, Math.round(h * DPR));
      var g = boardLayer.getContext('2d');
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
      g.clearRect(0, 0, w, h);
      var bd = L.bd, light = THEME.light;
      var name, i;

      /* substrate (navy-tinted charcoal; no green - slate/navy/gold only) */
      rrect(g, bd.x, bd.y, bd.w, bd.h, 10);
      g.fillStyle = light ? '#e7ebf1' : '#12161c';
      g.fill();
      rrect(g, bd.x, bd.y, bd.w, bd.h, 10);
      g.strokeStyle = 'rgba(127,127,127,0.35)';
      g.lineWidth = 1;
      g.stroke();

      /* faint 12 px fiberglass grid, clipped to the board */
      g.save();
      rrect(g, bd.x, bd.y, bd.w, bd.h, 10);
      g.clip();
      g.strokeStyle = 'rgba(127,127,127,0.05)';
      g.lineWidth = 1;
      g.beginPath();
      for (var gx = bd.x + 12; gx < bd.x + bd.w; gx += 12) { g.moveTo(gx, bd.y); g.lineTo(gx, bd.y + bd.h); }
      for (var gy = bd.y + 12; gy < bd.y + bd.h; gy += 12) { g.moveTo(bd.x, gy); g.lineTo(bd.x + bd.w, gy); }
      g.stroke();

      /* four corner mounting holes (decoration) */
      g.strokeStyle = 'rgba(127,127,127,0.25)';
      g.lineWidth = 1.5;
      var hxs = [bd.x + 11, bd.x + bd.w - 11], hys = [bd.y + 11, bd.y + bd.h - 11];
      for (i = 0; i < 4; i++) {
        g.beginPath();
        g.arc(hxs[i & 1], hys[i >> 1], 4, 0, Math.PI * 2);
        g.stroke();
      }

      /* silkscreen title in the bottom margin of the board */
      g.fillStyle = THEME.muted;
      g.globalAlpha = 0.5;
      g.font = '600 9px "Source Sans 3", system-ui, sans-serif';
      g.textAlign = 'right';
      g.fillText('KL-8 · 8-bit computer', bd.x + bd.w - 24, bd.y + bd.h - 8);
      g.globalAlpha = 1;
      g.textAlign = 'left';

      /* idle bus channels: two gold 3-line bundles + channel names */
      g.strokeStyle = THEME.gold;
      g.globalAlpha = 0.30;
      g.lineWidth = 1;
      chanLines(g, L.chanA);
      chanLines(g, L.chanD);
      g.globalAlpha = 0.4;
      g.fillStyle = THEME.gold;
      g.font = '7px "Source Sans 3", system-ui, sans-serif';
      g.fillText('ADDR', L.spanX0 + 1, L.chanA - 4.5);
      g.fillText('DATA', L.spanX0 + 1, L.chanD + 10);
      g.globalAlpha = 1;

      /* idle risers: every pin drops to its usual channel (PC and MAR are
         the address pair and get a 3-line bundle; the rest are data spurs) */
      g.strokeStyle = THEME.gold;
      g.globalAlpha = 0.30;
      g.lineWidth = 1;
      for (name in L.pins) {
        var pn = L.pins[name];
        var cy = (name === 'PC' || name === 'MAR') ? L.chanA : L.chanD;
        busLine(g, chamfer([{ x: pn.x, y: pn.y }, { x: pn.rx, y: pn.y }, { x: pn.rx, y: cy }], 5));
        if (name === 'PC' || name === 'MAR') {
          busLine(g, [{ x: pn.rx - 2.5, y: pn.y + 8 }, { x: pn.rx - 2.5, y: cy }]);
          busLine(g, [{ x: pn.rx + 2.5, y: pn.y + 8 }, { x: pn.rx + 2.5, y: cy }]);
        }
      }
      /* vias where risers meet their channel */
      g.globalAlpha = 0.35;
      g.fillStyle = THEME.gold;
      for (name in L.pins) {
        var pv = L.pins[name];
        var vy = (name === 'PC' || name === 'MAR') ? L.chanA : L.chanD;
        g.beginPath();
        g.arc(pv.rx, vy, 1.6, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;

      /* a few decorative stub traces + vias (sparse, alpha 0.12) */
      g.strokeStyle = THEME.gold;
      g.fillStyle = THEME.gold;
      g.globalAlpha = 0.12;
      g.lineWidth = 1;
      var dy0 = bd.y + bd.h - 52;
      var deco = [
        [{ x: bd.x + 22, y: dy0 }, { x: bd.x + 40, y: dy0 }, { x: bd.x + 48, y: dy0 - 8 }],
        [{ x: bd.x + 22, y: dy0 + 7 }, { x: bd.x + 52, y: dy0 + 7 }],
        [{ x: bd.x + bd.w - 22, y: bd.y + 24 }, { x: bd.x + bd.w - 38, y: bd.y + 24 }, { x: bd.x + bd.w - 46, y: bd.y + 32 }],
        [{ x: bd.x + bd.w - 22, y: bd.y + 38 }, { x: bd.x + bd.w - 42, y: bd.y + 38 }]
      ];
      for (i = 0; i < deco.length; i++) {
        busLine(g, deco[i]);
        var dl = deco[i][deco[i].length - 1];
        g.beginPath();
        g.arc(dl.x, dl.y, 1.6, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;

      /* chip packages */
      for (name in L.chips) {
        var cc = L.chips[name], r = cc.rect;
        rrect(g, r.x, r.y, r.w, r.h, 5);
        g.fillStyle = light ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.35)';
        g.fill();
        rrect(g, r.x, r.y, r.w, r.h, 5);
        g.strokeStyle = 'rgba(127,127,127,0.5)';
        g.lineWidth = 1;
        g.stroke();
        /* pin-1 dot + silkscreen label */
        g.fillStyle = THEME.muted;
        g.globalAlpha = 0.45;
        g.beginPath();
        g.arc(r.x + r.w - 8, r.y + 8, 1.5, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 0.85;
        g.font = '600 8.5px "Source Sans 3", system-ui, sans-serif';
        g.fillText(cc.label, r.x + 7, r.y + 11);
        g.globalAlpha = 1;
      }

      /* gold pin stubs (chip legs) where traces leave the packages */
      g.fillStyle = THEME.gold;
      g.globalAlpha = 0.55;
      for (name in L.pins) {
        var pp = L.pins[name];
        var leftEdge = (pp.chip === 'RAM' || pp.chip === 'VID' || pp.chip === 'IO');
        g.fillRect(leftEdge ? pp.x - 4 : pp.x, pp.y - 1.5, 4, 3);
      }
      g.globalAlpha = 1;

      /* row insets + silkscreen row labels. On a phone-width board the Z/N/C
         lamps reach the left edge of their row, so the FLAGS name is dropped
         there rather than printed under them: the lamps carry their own
         letters, so nothing is lost. */
      var LBL = { RAMBYTE: '', VIDB: '' };
      var lampR = Math.min(6, L.rowH * 0.34);
      if (L.rows.FLAGS && L.rows.FLAGS.w < 3 * (lampR * 2 + 7) + 42) LBL.FLAGS = '';
      for (name in L.rows) {
        var rw = L.rows[name];
        g.fillStyle = 'rgba(127,127,127,0.07)';
        g.fillRect(rw.x, rw.y + 1, rw.w, rw.h - 2);
        var lb = (LBL[name] !== undefined) ? LBL[name] : name;
        if (lb) {
          g.fillStyle = THEME.muted;
          g.font = '600 8.5px "Source Sans 3", system-ui, sans-serif';
          g.fillText(lb, rw.x + 4, rw.y + rw.h / 2 + 3);
        }
      }

      /* RAM body doodle: a faint memory-cell array under its rows */
      var ram = L.chips.RAM.rect;
      var doTop = L.rows.RAMBYTE.y + L.rows.RAMBYTE.h + 5;
      if (ram.y + ram.h - 8 - doTop > 10) {
        g.fillStyle = 'rgba(127,127,127,0.14)';
        for (var my = doTop; my < ram.y + ram.h - 8; my += 7) {
          for (var mx = ram.x + 8; mx < ram.x + ram.w - 10; mx += 9) {
            g.fillRect(mx, my, 5, 3.5);
          }
        }
      }

      /* mini screen bezel */
      g.fillStyle = light ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.5)';
      g.fillRect(L.mini.x - 2, L.mini.y - 2, L.mini.w + 4, L.mini.h + 4);
      g.strokeStyle = 'rgba(127,127,127,0.4)';
      g.lineWidth = 1;
      g.strokeRect(L.mini.x - 2.5, L.mini.y - 2.5, L.mini.w + 5, L.mini.h + 5);
      g.restore();
    }

    /* ---------- circuit board: per-frame drawing ---------- */
    function rowValue(rn) {
      switch (rn) {
        case 'PC': return vm.PC;
        case 'SP': return vm.SP;
        case 'A': return vm.A;
        case 'X': return vm.X;
        case 'MAR': return vm.MAR;
        case 'IR': return vm.IR;
        case 'DECODE': return vm.DEC;
        case 'RAMBYTE': return vm.ramR ? '[$' + hx4(vm.ramR.a) + '] = $' + hx2(vm.ramR.v || 0) : '';
        case 'VIDB': return vm.vidR ? '[$' + hx4(vm.vidR.a) + '] = $' + hx2(vm.vidR.v || 0) : '';
        case 'RND': return '$' + hx2(cpu.peek(0x1401));
        case 'FRAME': return String(cpu.frameCount);
        default: return '';
      }
    }

    function drawDatapath(t) {
      var w = dpCanvas.width / DPR, h = dpCanvas.height / DPR;
      ensureBoard(w, h);
      var g = dpCtx;
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
      g.clearRect(0, 0, w, h);
      if (boardLayer) g.drawImage(boardLayer, 0, 0, w, h);
      var rn, i;

      /* fast mode: pulses are off, so the bus channels shimmer instead.
         t is the rAF timestamp in MILLISECONDS - the /1000 matters, 13
         rad/ms would alias into per-frame noise. */
      var fast = (mode === 'run' && speedHz() > 30);
      if (fast) {
        g.strokeStyle = THEME.gold;
        g.globalAlpha = reduced ? 0.2 : Math.max(0, 0.15 + 0.1 * Math.sin((t / 1000) * 13));
        g.lineWidth = 1.2;
        chanLines(g, L.chanA);
        chanLines(g, L.chanD);
        g.globalAlpha = 1;
      }

      /* chip glow: max of the package's row heat, alpha capped at 0.10 */
      for (var cn in L.chips) {
        var cc = L.chips[cn], hmax = heat[cn] || 0;
        for (i = 0; i < cc.rows.length; i++) {
          var hk = heat[rowHeatKey(cc.rows[i])] || 0;
          if (hk > hmax) hmax = hk;
        }
        if (cn === 'CPU' && aluFlash > hmax) hmax = aluFlash;
        if (hmax > 0.02) {
          rrect(g, cc.rect.x, cc.rect.y, cc.rect.w, cc.rect.h, 5);
          g.globalAlpha = Math.min(0.10, hmax * 0.10);
          g.fillStyle = THEME.accent;
          g.fill();
          g.globalAlpha = 1;
        }
      }

      /* rows: heat tint + live values */
      var valFont = '11px ui-monospace, Consolas, monospace';
      for (rn in L.rows) {
        var r = L.rows[rn];
        var hv = heat[rowHeatKey(rn)] || 0;
        if (rn === 'ALU' && aluFlash > 0.02) {
          g.globalAlpha = aluFlash * 0.3;
          g.fillStyle = THEME.gold;
          g.fillRect(r.x, r.y + 1, r.w, r.h - 2);
          g.globalAlpha = 1;
        } else if (hv > 0.02) {
          g.globalAlpha = 0.25 * hv;
          g.fillStyle = THEME.accent;
          g.fillRect(r.x, r.y + 1, r.w, r.h - 2);
          g.globalAlpha = 1;
        }
        var baseY = r.y + r.h / 2 + 3.5;
        if (rn === 'FLAGS') {
          var lam = ['Z', 'N', 'C'], vals = [vm.Z, vm.N, vm.C];
          var rad = Math.min(6, r.h * 0.34);
          for (i = 0; i < 3; i++) {
            var lcx = r.x + r.w - (3 - i) * (rad * 2 + 7) + rad;
            var lcy = r.y + r.h / 2;
            g.beginPath();
            g.arc(lcx, lcy, rad, 0, Math.PI * 2);
            if (vals[i]) { g.fillStyle = THEME.accent; g.fill(); }
            else { g.strokeStyle = 'rgba(127,127,127,0.5)'; g.lineWidth = 1.2; g.stroke(); }
            g.fillStyle = vals[i] ? (THEME.light ? '#ffffff' : '#141414') : THEME.muted;
            g.font = '600 8px "Source Sans 3", system-ui, sans-serif';
            g.textAlign = 'center';
            g.fillText(lam[i], lcx, lcy + 2.8);
          }
          g.textAlign = 'left';
        } else if (rn === 'ALU') {
          g.fillStyle = aluFlash > 0.05 ? THEME.gold : THEME.ink;
          g.font = '700 14px ui-monospace, Consolas, monospace';
          g.textAlign = 'right';
          g.fillText(vm.ALU || '·', r.x + r.w - 5, baseY + 1);
          g.textAlign = 'left';
        } else if (rn === 'KEYS') {
          var bits = (kbBits | dpadBits);
          var glyphs = ['↑', '↓', '←', '→', '␣'];
          var masks = [1, 2, 4, 8, 16];
          g.font = '10px ui-monospace, Consolas, monospace';
          g.textAlign = 'right';
          for (i = 4; i >= 0; i--) {
            var kx = r.x + r.w - 5 - (4 - i) * 12;
            g.fillStyle = (bits & masks[i]) ? THEME.accent : THEME.muted;
            g.globalAlpha = (bits & masks[i]) ? 1 : 0.45;
            g.fillText(glyphs[i], kx, baseY);
          }
          g.globalAlpha = 1;
          g.textAlign = 'left';
        } else if (rn === 'RAMBYTE' || rn === 'VIDB') {
          var vtx = rowValue(rn);
          if (vtx) {
            g.fillStyle = THEME.ink;
            g.font = valFont;
            g.textAlign = 'center';
            var maxc = Math.floor((r.w - 6) / 6.2);
            if (vtx.length > maxc) vtx = vtx.slice(0, maxc);
            g.fillText(vtx, r.x + r.w / 2, baseY);
            g.textAlign = 'left';
          }
        } else {
          var val = rowValue(rn);
          if (val) {
            g.fillStyle = THEME.ink;
            g.font = valFont;
            g.textAlign = 'right';
            var maxc2 = Math.floor((r.w - (rn === 'DECODE' ? 42 : 30)) / 6.2);
            if (val.length > maxc2) val = val.slice(0, Math.max(2, maxc2));
            g.fillText(val, r.x + r.w - 5, baseY);
            g.textAlign = 'left';
          }
        }
      }

      /* the VID chip's live mini screen (cheap: one drawImage of the
         existing offscreen 32x32; it must never trigger full repaints) */
      g.imageSmoothingEnabled = false;
      g.drawImage(off, L.mini.x, L.mini.y, L.mini.w, L.mini.h);
      g.imageSmoothingEnabled = true;
      if (vidRingOn(t)) {
        var mc = L.mini.w / 32;
        g.strokeStyle = THEME.accentHi;
        g.lineWidth = 1.2;
        g.strokeRect(L.mini.x + lastVidWrite.x * mc, L.mini.y + lastVidWrite.y * mc, mc, mc);
      }

      /* in-flight byte: light the whole route, then the spark + tail
         (two arcs, never shadowBlur in the per-frame path) */
      if (animCur && animCur.pts) {
        var pts = animCur.pts;
        g.strokeStyle = THEME.gold;
        g.globalAlpha = 0.65;
        g.lineWidth = 2;
        busLine(g, pts);
        g.globalAlpha = 1;
        var p = (t - animCur.t0) / animCur.dur;
        if (p < 0) p = 0; if (p > 1) p = 1;
        p = p * p * (3 - 2 * p);
        var col = animCur.ph.kind === 'alu' ? THEME.gold : THEME.accentHi;
        g.fillStyle = col;
        for (var k = 3; k >= 1; k--) {
          var tp = p - 0.04 * k;
          if (tp <= 0) continue;
          var gp = ptAlong(pts, tp);
          g.globalAlpha = 0.28 - k * 0.07;
          g.beginPath();
          g.arc(gp.x, gp.y, Math.max(0.5, 3 - k * 0.5), 0, Math.PI * 2);
          g.fill();
        }
        var pos = ptAlong(pts, p);
        g.globalAlpha = 0.18;
        g.beginPath();
        g.arc(pos.x, pos.y, 8, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
        g.beginPath();
        g.arc(pos.x, pos.y, 3, 0, Math.PI * 2);
        g.fill();
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
    /* The "How to use" paragraph names where the panes are, which depends on
       the layout: three columns (code left, board middle, screen right), two
       columns (code left, Machine/Screen tabs on the right) or the tabbed
       phone layout. Same visibility test as the tour's m40 fix (paneOr()):
       a tab button that is laid out means that pane lives behind a tab.
       Rebuilt on every open, so a rotation or resize is picked up. */
    function howToUse() {
      function shown(el) { return !!(el && el.offsetWidth && el.offsetHeight); }
      var codeTab = shown(document.querySelector('.comp-tab[data-tab="code"]'));
      var machTab = shown(document.querySelector('.comp-tab[data-tab="machine"]'));
      var codeWhere = codeTab ? 'in the Code tab' : 'on the left';
      var boardWhere = machTab ? 'in the Machine tab' : 'in the middle pane';
      var screenWhere = machTab ? ' in the Screen tab' : '';
      return 'Write KL-8 assembly ' + codeWhere + ', then press <strong>Assemble &#9656; Run</strong>. ' +
           'Watch values pulse between the registers, memory, and the ALU ' + boardWhere + ' while ' +
           'your program draws on the 32&#215;32 screen' + screenWhere + '. Use <strong>Step</strong> to execute one ' +
           'instruction at a time, or <strong>Micro-step</strong> to walk through the fetch, decode, ' +
           'and execute phases one bus transfer at a time. The speed slider runs the clock from 2 Hz ' +
           'up to 200 kHz. Load an example from the menu to see the machine put through its paces.';
    }
    function buildReference() {
      var syn = { imp: '', imm: ' #v', abs: ' addr', abx: ' addr,X', ind: ' (addr)' };
      var h = '';
      h += '<h3>How to use</h3>';
      h += '<p class="comp-ref-how">' + howToUse() + '</p>';
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
    function refreshHow() {
      var how = refBody.querySelector('.comp-ref-how');
      if (how) how.innerHTML = howToUse();
    }
    /* a rotation or resize while the reference is open moves the panes; this
       listener is added after applyCols' own, so it reads the new layout */
    window.addEventListener('resize', function () { if (refOpen()) refreshHow(); });
    function openRef() {
      refreshHow();
      refPanel.classList.add('comp-ref--open');
      refPanel.setAttribute('aria-hidden', 'false');
      refPanel.removeAttribute('inert');
      /* m6: the page CSS hides the floating theme and back buttons while this
         class is on, so they cannot cover the table or take a stray tap */
      document.body.classList.add('comp-ref-open');
      if (refClose) refClose.focus();
    }
    function closeRef() {
      refPanel.classList.remove('comp-ref--open');
      refPanel.setAttribute('aria-hidden', 'true');
      /* the closed panel is only translated off-screen, so its buttons stay
         tabbable (and focusable content inside aria-hidden is an ARIA
         violation); inert removes them from the tab order where supported */
      refPanel.inert = true;
      document.body.classList.remove('comp-ref-open');
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

    /* ---------- boot alive ----------
       The board should be moving from the first frame: load the bouncing
       pixel demo through the same path a user selection takes (so the
       examples select legitimately shows it - placeholder invariant kept),
       assemble, and RUN at the existing default slider value (60 -> 2 kHz).
       WAIT paces the program to the display, so the pixel bounces smoothly
       and the chips glow with activity heat. Do NOT boot into pulse mode:
       pulse-mode Run is bounded at ~4 instructions/s by the 40 ms phase
       clamp, so the Bounce demo would move one pixel every ~13 s - the
       byte-by-byte chip in the narrator is the honest one-click way down. */
    function bootAlive() {
      var ex = null;
      for (var i = 0; i < K.EXAMPLES.length; i++) {
        if (K.EXAMPLES[i].id === 'bounce') ex = K.EXAMPLES[i];
      }
      if (!ex) return;
      srcTa.value = ex.src;
      lastLoaded = ex.src;
      appliedExample = ex.id;
      exampleSel.value = ex.id;
      var r = assembleNow();
      if (!r) return;
      loadProgram(r);
      enterMachineView();
      if (reduced) {
        /* reduced motion: same example, assembled but PAUSED */
        mode = 'ready';
        setStatus('Press Run to start.');
        return;
      }
      mode = 'run';
      playMode = 'auto';
      runBtn.textContent = 'Pause';
      if (app.getAttribute('data-cols') === '1') setTab('screen');
    }

    /* ---------- test hooks ---------- */
    window.__comp = {
      narrate: narrate,
      lastNarration: function () { return lastNarr; },
      frameDeltas: function () { return frameDeltasArr.slice(); },
      boardPx: function (name) {
        if (!L) return null;
        var r = L.rows[name] || (L.chips[name] && L.chips[name].rect) || null;
        if (!r) return null;
        var cr = dpCanvas.getBoundingClientRect();
        return { left: cr.left + r.x, top: cr.top + r.y, width: r.w, height: r.h };
      }
    };

    /* ---------- init ---------- */
    rebuildTheme();
    buildReference();
    srcTa.value = K.EXAMPLES[0].src;
    lastLoaded = srcTa.value;
    exampleSel.value = K.EXAMPLES[0].id;
    /* restore a shared program from the URL hash (untrusted: clamp).
       A share-hash load must NOT auto-run (people share half-written
       code), so it also skips the boot-alive path. */
    var sharedLoad = false;
    if (SH) {
      var dec = SH.decode(SH.readHash());
      if (dec && dec.version === 1 && dec.obj && typeof dec.obj.s === 'string' && dec.obj.s.length) {
        var shared = dec.obj.s.slice(0, 6000);
        srcTa.value = shared;
        lastLoaded = shared;
        sharedLoad = true;   /* even if it does not assemble, keep the source */
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
    if (!sharedLoad) bootAlive();
    if (GU) GU.firstRunHint('computer', 'This is a whole small computer. The gold lines carry bytes between the chips. Try Micro-step to watch one move at a time.');
    requestAnimationFrame(loop);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

/* ---- guided first-run tour (design pass F3) --------------------------------
   Registered from OUTSIDE the page module: targets are the page's own DOM
   panes, so the pinned machine code above stays untouched. On the 1-column
   phone layout a pane can be display:none behind a tab, so each target falls
   back to its tab button. The ? button here opens the instruction reference
   (pinned behavior), so the tour's re-run entry is a small button at the top
   of that reference instead. */
(function () {
  function reg() {
    if (!window.GadgetUI || !window.GadgetUI.tour) return;
    function vis(el) { return !!(el && el.offsetWidth && el.offsetHeight); }
    function rectOf(el) { return vis(el) ? el.getBoundingClientRect() : null; }
    function paneOr(id, tab) {
      return rectOf(document.getElementById(id)) ||
        rectOf(document.querySelector('.comp-tab[data-tab="' + tab + '"]'));
    }
    var t = window.GadgetUI.tour('computer', [
      { get text() {
          /* m40: the same visibility test paneOr() uses; on the tabbed phone
             layout the code lives behind the Code tab, not on the left */
          var tabbed = vis(document.querySelector('.comp-tab[data-tab="code"]'));
          return (!tabbed && vis(document.getElementById('pane-code'))) ?
            'A real, tiny computer. The panel on the left holds the program it runs.' :
            'A real, tiny computer. The Code tab holds the program it runs.';
        },
        rect: function () { return paneOr('pane-code', 'code'); }, side: 'right' },
      { text: 'The board lights up as it works. Slow the speed down to watch each step.',
        rect: function () { return paneOr('pane-machine', 'machine'); }, side: 'bottom' },
      { text: 'Try the examples, or change the code and press Assemble.',
        rect: function () {
          return rectOf(document.querySelector('.comp-codebar')) ||
            paneOr('pane-code', 'code');
        }, side: 'bottom' }
    ]);
    var refBody = document.getElementById('comp-ref-body');
    if (t && refBody) {
      var p = document.createElement('p');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'comp-btn';
      b.textContent = 'Show the quick tour';
      b.addEventListener('click', function () {
        var x = document.getElementById('comp-ref-close');
        if (x) x.click();
        t.start(true);
      });
      p.appendChild(b);
      refBody.insertBefore(p, refBody.firstChild);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reg);
  } else {
    reg();
  }
})();
