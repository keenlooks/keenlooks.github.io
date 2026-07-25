/* ==========================================================================
   fourinarow.js — page runtime for /fourinarow/ (Four in a Row vs an
   AlphaZero-style net, with the search made visible).

   Requires (loaded before this, all defer): gadget-ui.js, share-hash.js,
   fourinarow-core.js, fourinarow-model.js. The search runs in a Web Worker
   (fourinarow-ai.js) with a main-thread chunked fallback; every worker reply
   carries {gameId, seq} and stale replies are dropped.

   The human is ALWAYS blue (the site accent); the AI is always gold. The
   win-probability bar is shown from blue's perspective (values from the net
   are for the side to move — converted once, at display time only).
   ========================================================================== */
(function () {
  'use strict';

  var canvas = document.getElementById('c4-canvas');
  if (!canvas || !window.C4Core || !window.C4_MODEL) return;
  var ctx = canvas.getContext('2d');
  var Core = window.C4Core;
  var NC = Core.W, NR = Core.H;

  /* ------------------------------ theme --------------------------------- */

  function effectiveTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t === 'light' || t === 'dark') return t;
    return (window.matchMedia &&
            window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }

  var THEMES = {
    dark: {
      bg: '#0e1014', text: '#d6d6d6', dim: 'rgba(214,214,214,0.55)',
      accent: '#82a6cc', accentSoft: 'rgba(130,166,204,0.35)',
      gold: '#c8a45c', goldSoft: 'rgba(200,164,92,0.35)',
      panel: 'rgba(127,127,127,0.10)', line: 'rgba(127,127,127,0.28)',
      hole: '#0e1014', light: false
    },
    light: {
      bg: '#f3f5f8', text: '#262626', dim: 'rgba(38,38,38,0.55)',
      accent: '#34568a', accentSoft: 'rgba(52,86,138,0.30)',
      gold: '#a07c2c', goldSoft: 'rgba(160,124,44,0.30)',
      panel: 'rgba(127,127,127,0.12)', line: 'rgba(127,127,127,0.35)',
      hole: '#f3f5f8', light: true
    }
  };
  var TH = THEMES[effectiveTheme()];

  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------ model --------------------------------- */

  var model = Core.loadModel(window.C4_MODEL);
  var verify = Core.checkTestVector(model);
  var SIMS = [0, 120, 600, 1600];
  var SIM_NAMES = ['Instinct', 'Quick', 'Strong', 'Max'];
  var SIM_HINTS = ['instant, no search', '~0.3 s of search',
                   '~1-2 s of search', 'up to 4 s of search'];

  /* ------------------------------ state --------------------------------- */

  var st = {
    moves: [],
    bd: Core.newBoard(),
    humanFirst: true,
    phase: 'human',            /* human | animating | thinking | over */
    gameId: 1,
    seq: 0,
    strength: 2,
    showThink: window.innerWidth >= 700,
    winLine: null,
    winT0: 0,
    result: null,              /* 'human' | 'ai' | 'draw' */
    lastAiMove: -1,
    hoverCol: -1,
    selCol: 3,                 /* keyboard cursor */
    usingKeys: false,
    anim: null,                /* {col,row,who,t0,dur} */
    snap: null,                /* latest thinking snapshot */
    snapFresh: false,
    seen: {},                  /* tree-node fade-in timestamps */
    disp: { pBlue: 0.5 },      /* smoothed win bar */
    instinct: null,            /* {col, value} while human thinks */
    workerAlive: false,
    replay: null               /* pending share replay: {moves, i} */
  };

  function humanColor() { return TH.accent; }
  function aiColor() { return TH.gold; }
  function humanPiece() { return st.humanFirst ? 1 : 2; }
  function aiPiece() { return st.humanFirst ? 2 : 1; }
  function isHumansTurn() { return Core.stm(st.bd) === humanPiece(); }

  /* pBlue from a value for the side to move in the position it was measured */
  function pBlueFrom(value, sideToMove) {
    var pMover = (value + 1) / 2;
    return sideToMove === humanPiece() ? pMover : 1 - pMover;
  }

  /* ------------------------------ worker -------------------------------- */

  var worker = null;
  var mainSearchTimer = null;

  function scriptUrls() {
    var el = document.querySelector('script[src*="fourinarow.js"]');
    var src = el ? el.getAttribute('src') : '/assets/js/fourinarow.js';
    var qi = src.indexOf('?');
    var q = qi >= 0 ? src.slice(qi) : '';
    var base = src.slice(0, src.lastIndexOf('/') + 1);
    return {
      ai: base + 'fourinarow-ai.js' + q,
      core: new URL(base + 'fourinarow-core.js' + q, location.href).href,
      model: new URL(base + 'fourinarow-model.js' + q, location.href).href
    };
  }

  function initWorker() {
    var urls = scriptUrls();
    try {
      worker = new Worker(urls.ai);
    } catch (e) { worker = null; return; }
    function workerDead() {
      clearTimeout(bootTimer);
      try { worker.terminate(); } catch (e) {}
      worker = null;
      st.workerAlive = false;
      /* if it died mid-think, recover on the main thread */
      if (st.phase === 'thinking') requestAiMove();
    }
    var booted = false;
    var bootTimer = setTimeout(function () {
      if (!booted && worker) workerDead();
    }, 4000);
    worker.onerror = function () { if (worker) workerDead(); };
    worker.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === 'ready') {
        booted = true;
        clearTimeout(bootTimer);
        st.workerAlive = true;
        return;
      }
      if (m.type === 'error') {
        /* importScripts failure (404 / parse) — the worker object is alive but
           useless; fall back or the game hangs at "Thinking" forever */
        if (worker) workerDead();
        return;
      }
      if (m.gameId !== st.gameId || m.seq !== st.seq) return;   /* stale */
      if (m.type === 'thinking') { st.snap = m; st.snapFresh = true; return; }
      if (m.type === 'move' && st.phase === 'thinking') {
        st.snap = m;
        aiPlays(m.col);
      }
    };
    worker.postMessage({ type: 'init', coreUrl: urls.core, modelUrl: urls.model });
  }

  function stopSearch() {
    if (worker) worker.postMessage({ type: 'stop' });
    if (mainSearchTimer) { clearTimeout(mainSearchTimer); mainSearchTimer = null; }
  }

  function requestAiMove() {
    st.phase = 'thinking';
    st.seq++;
    st.snap = null;
    st.seen = {};
    setStatus('Thinking…');
    var sims = SIMS[st.strength];
    /* messages queue behind 'init' in order, so posting while the worker is
       still booting is fine; only a null worker (failed boot) falls back */
    if (worker) {
      worker.postMessage({ type: 'search', gameId: st.gameId, seq: st.seq,
                           moves: st.moves.slice(), sims: sims, capMs: 4000 });
      return;
    }
    /* main-thread fallback: same pump shape, capped effort */
    var search = new Core.Search(model, st.bd);
    var target = Math.min(sims || 0, 300);
    var t0 = Date.now(), mySeq = st.seq, lastSnap = 0;
    function tick() {
      mainSearchTimer = null;
      if (st.seq !== mySeq || st.phase !== 'thinking') return;
      if (search.totalVisits() >= target || Date.now() - t0 > 3000) {
        var col = search.bestMove();
        st.snap = search.snapshot();
        aiPlays(col);
        return;
      }
      search.run(12);
      var now = Date.now();
      if (now - lastSnap >= 80) { lastSnap = now; st.snap = search.snapshot(); }
      mainSearchTimer = setTimeout(tick, 0);
    }
    mainSearchTimer = setTimeout(tick, 0);
  }

  /* ------------------------------ game flow ------------------------------ */

  var statusEl = document.getElementById('c4-status');
  function setStatus(txt) { if (statusEl) statusEl.textContent = txt; }

  function colName(c) { return String(c + 1); }

  function playMove(col, who) {
    var row = Core.makeMove(st.bd, col);
    st.moves.push(col);
    var win = Core.winAt(st.bd, col, row);
    st.anim = {
      col: col, row: row, who: who,
      t0: performance.now(),
      dur: reduceMotion ? 0 : 380,
      win: win
    };
    st.phase = 'animating';
    return win;
  }

  function afterAnimation() {
    var a = st.anim;
    st.anim = null;
    if (a.win) {
      st.winLine = a.win;
      st.winT0 = performance.now();
      st.result = (a.who === humanPiece()) ? 'human' : 'ai';
      st.phase = 'over';
      setStatus(st.result === 'human'
        ? 'You win! Column ' + colName(a.col) + ' did it.'
        : 'The AI wins with column ' + colName(a.col) + '.');
      return;
    }
    if (st.bd.count === Core.CELLS) {
      st.result = 'draw';
      st.phase = 'over';
      setStatus('Draw. The board is full.');
      return;
    }
    if (st.replay) {
      if (st.replay.i < st.replay.moves.length) { stepReplay(); return; }
      st.replay = null;
    }
    if (isHumansTurn()) {
      st.phase = 'human';
      st.instinct = null;
      setStatus('Your turn.');
    } else {
      requestAiMove();
    }
  }

  function humanPlays(col) {
    if (st.phase !== 'human' || !Core.canPlay(st.bd, col)) return;
    st.instinct = null;
    setStatus('You played column ' + colName(col) + '.');
    playMove(col, humanPiece());
    st.lastAiMove = -1;
  }

  function aiPlays(col) {
    if (!Core.canPlay(st.bd, col)) {   /* should never happen; recover */
      var legal = Core.legalMoves(st.bd);
      if (!legal.length) return;
      col = legal[0];
    }
    st.lastAiMove = col;
    setStatus('The AI plays column ' + colName(col) + '.');
    playMove(col, aiPiece());
  }

  function newGame(keepSides) {
    stopSearch();
    st.gameId++;
    st.seq++;
    st.moves = [];
    st.bd = Core.newBoard();
    st.winLine = null;
    st.result = null;
    st.lastAiMove = -1;
    st.anim = null;
    st.snap = null;
    st.seen = {};
    st.instinct = null;
    st.replay = null;
    st.disp.pBlue = 0.5;
    if (!keepSides) { /* sides already set by caller */ }
    if (isHumansTurn()) {
      st.phase = 'human';
      setStatus('New game. Your turn.');
    } else {
      requestAiMove();
    }
  }

  function undo() {
    if (st.moves.length === 0 || st.phase === 'animating') return;
    stopSearch();
    st.gameId++;      /* fresh tree — never reuse across an undo */
    st.seq++;
    /* remove plies until it is the human's turn again (usually 2, or 1 if
       the AI hadn't answered yet / game just ended) */
    var target = humanPiece();
    Core.unmakeMove(st.bd, st.moves.pop());
    while (st.moves.length && Core.stm(st.bd) !== target) {
      Core.unmakeMove(st.bd, st.moves.pop());
    }
    st.winLine = null;
    st.result = null;
    st.lastAiMove = -1;
    st.anim = null;
    st.snap = null;
    st.instinct = null;
    st.replay = null;
    if (isHumansTurn()) {
      st.phase = 'human';
      setStatus('Took that back. Your turn.');
    } else {
      /* human plays second and undid everything: the AI opens again */
      setStatus('Took that back.');
      requestAiMove();
    }
  }

  function stepReplay() {
    var r = st.replay;
    if (!r || r.i >= r.moves.length) {
      st.replay = null;
      return;
    }
    var col = r.moves[r.i];
    var who = 1 + (r.i & 1);
    r.i++;
    if (!Core.canPlay(st.bd, col)) { st.replay = null; return; }
    st.moves.push(col);
    var row = Core.makeMove(st.bd, col);
    st.anim = { col: col, row: row, who: who, t0: performance.now(),
                dur: reduceMotion ? 0 : 120, win: Core.winAt(st.bd, col, row) };
    st.phase = 'animating';
  }

  /* --------------------------- share / restore --------------------------- */

  function shareString() {
    return window.ShareHash.encode(1, {
      m: st.moves, s: st.strength, p: st.humanFirst ? 1 : 0
    });
  }

  function tryRestore() {
    if (!window.ShareHash) return false;
    var d = window.ShareHash.decode(window.ShareHash.readHash());
    if (!d || d.version !== 1) return false;
    var SH = window.ShareHash;
    var mv = SH.arr(d.obj.m, 42).map(function (v) { return SH.int(v, 0, 6, 0); });
    if (Core.boardFromMoves(mv) === null) return false;
    st.strength = SH.int(d.obj.s, 0, 3, 2);
    st.humanFirst = SH.int(d.obj.p, 0, 1, 1) === 1;
    st.replay = { moves: mv, i: 0 };
    syncControls();
    if (mv.length) { stepReplay(); } else { newGame(true); }
    return true;
  }

  /* ------------------------------ layout -------------------------------- */

  var CW = 0, CH = 0, DPR = 1;
  var geo = {};   /* board + think-view geometry, recomputed on resize */

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    CW = window.innerWidth;
    CH = window.innerHeight;
    canvas.width = Math.round(CW * DPR);
    canvas.height = Math.round(CH * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    layout();
  }

  function layout() {
    var topPad = Math.max(CH * 0.16, 76);
    /* keep the column-number labels above the fixed corner buttons (~78px band) */
    var botPad = 96;
    var think = st.showThink;
    /* the fixed control panel owns the top-right ~340px — never put the
       thinking view under it (it auto-collapses only below 600px wide) */
    var reserve = CW >= 600 ? 356 : 0;
    var twRight = CW - Math.max(reserve, CW * 0.02);
    var twWide = Math.min(430, twRight - CW * 0.52);
    var wide = think && CW >= 1000 && CW > CH * 0.9 && twWide >= 260;
    geo.wide = wide;
    geo.showTree = think && CW >= 700;
    var bx, bw, bh, by;
    if (wide) {
      geo.tw = twWide;
      geo.tx = twRight - twWide;
      bx = CW * 0.03; bw = geo.tx - 24 - bx;
      by = topPad; bh = CH - topPad - botPad;
    } else if (think) {
      bx = CW * 0.06; bw = CW * 0.88;
      by = topPad; bh = (CH - topPad - botPad) * 0.62;
    } else {
      bx = CW * 0.10; bw = CW * 0.80;
      by = topPad; bh = CH - topPad - botPad;
    }
    /* the 3px floor keeps ctx.arc radii positive on absurdly short viewports —
       a thrown draw would otherwise kill the rAF loop for good */
    var s = Math.max(3, Math.min(bw / NC, bh / (NR + 0.6)));
    var boardW = s * NC, boardH = s * NR;
    geo.s = s;
    geo.bx = bx + (bw - boardW) / 2;
    geo.by = by + (bh - boardH) / 2 + s * 0.3;
    geo.bw = boardW;
    geo.bh = boardH;
    if (wide) {
      geo.ty = topPad; geo.th = CH - topPad - botPad;
    } else if (think) {
      geo.tx = CW * 0.06;
      geo.tw = Math.min(CW * 0.88, twRight - geo.tx);
      geo.ty = geo.by + boardH + 28; geo.th = CH - (geo.by + boardH) - 60;
    }
  }

  function cellX(c) { return geo.bx + c * geo.s + geo.s / 2; }
  function cellY(r) { return geo.by + (NR - 1 - r) * geo.s + geo.s / 2; }
  function colAt(x, y) {
    if (x < geo.bx - geo.s * 0.2 || x > geo.bx + geo.bw + geo.s * 0.2) return -1;
    if (y < geo.by - geo.s * 1.5 || y > geo.by + geo.bh + geo.s * 0.5) return -1;
    var c = Math.floor((x - geo.bx) / geo.s);
    return (c >= 0 && c < NC) ? c : -1;
  }

  /* ------------------------------ drawing -------------------------------- */

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function disc(x, y, r, color, alpha) {
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    /* soft highlight so it reads as a piece, not a dot */
    var g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1,
                                     x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,' + (TH.light ? 0.35 : 0.22) + ')');
    g.addColorStop(0.55, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(0,0,0,' + (TH.light ? 0.08 : 0.25) + ')');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function pieceColor(who) { return who === humanPiece() ? humanColor() : aiColor(); }

  function drawBoard(now) {
    var s = geo.s, r = s * 0.42;

    /* frame */
    ctx.fillStyle = TH.panel;
    ctx.strokeStyle = TH.line;
    ctx.lineWidth = 1;
    roundRect(geo.bx - s * 0.22, geo.by - s * 0.22,
              geo.bw + s * 0.44, geo.bh + s * 0.44, s * 0.3);
    ctx.fill();
    ctx.stroke();

    /* hover / keyboard column highlight + ghost */
    var hc = st.hoverCol >= 0 ? st.hoverCol : (st.usingKeys ? st.selCol : -1);
    if (st.phase === 'human' && hc >= 0 && Core.canPlay(st.bd, hc)) {
      ctx.fillStyle = TH.light ? 'rgba(52,86,138,0.06)' : 'rgba(130,166,204,0.07)';
      ctx.fillRect(geo.bx + hc * s, geo.by - s * 0.22, s, geo.bh + s * 0.44);
      var gr = st.bd.heights[hc];
      disc(cellX(hc), cellY(gr), r, humanColor(), 0.35);
    }

    /* win capsule (under the discs) */
    if (st.winLine) {
      /* winAt lists [placed, forward…, backward…]; the true endpoints are the
         min/max cell index (monotonic along every win direction) */
      var cells = st.winLine.cells;
      var a = cells[0], b = cells[0];
      for (var wi = 1; wi < cells.length; wi++) {
        if (cells[wi] < a) a = cells[wi];
        if (cells[wi] > b) b = cells[wi];
      }
      var ax = cellX(a % NC), ay = cellY((a / NC) | 0);
      var bx2 = cellX(b % NC), by2 = cellY((b / NC) | 0);
      var t = (now - st.winT0) / 1400;
      var pulse = reduceMotion ? 0.5 : (t < 2 ? 0.35 + 0.3 * Math.abs(Math.sin(t * Math.PI * 2)) : 0.5);
      ctx.strokeStyle = st.result === 'human' ? humanColor() : aiColor();
      ctx.globalAlpha = pulse;
      ctx.lineWidth = s * 0.92;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx2, by2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineCap = 'butt';
    }

    /* settled pieces (skip the one still animating) */
    for (var c = 0; c < NC; c++) {
      for (var rw = 0; rw < st.bd.heights[c]; rw++) {
        if (st.anim && st.anim.col === c && st.anim.row === rw) continue;
        var who = st.bd.cells[rw * NC + c];
        disc(cellX(c), cellY(rw), r, pieceColor(who));
        if (!st.anim && st.lastAiMove === c && rw === st.bd.heights[c] - 1 &&
            who === aiPiece()) {
          ctx.strokeStyle = TH.dim;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(cellX(c), cellY(rw), r + 3, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    /* empty holes: subtle rings */
    ctx.strokeStyle = TH.line;
    ctx.lineWidth = 1;
    for (var c2 = 0; c2 < NC; c2++) {
      for (var r2 = st.bd.heights[c2]; r2 < NR; r2++) {
        if (st.anim && st.anim.col === c2 && st.anim.row === r2) continue;
        ctx.beginPath();
        ctx.arc(cellX(c2), cellY(r2), r * 0.94, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    /* falling disc */
    if (st.anim) {
      var A = st.anim;
      var u = A.dur === 0 ? 1 : Math.min(1, (now - A.t0) / A.dur);
      var y0 = geo.by - s * 0.9;
      var y1 = cellY(A.row);
      var y;
      if (u < 0.78) {
        var f = u / 0.78;
        y = y0 + (y1 - y0) * f * f;
      } else {
        var v = (u - 0.78) / 0.22;
        y = y1 - Math.sin(v * Math.PI) * s * 0.10;
      }
      disc(cellX(A.col), y, r, pieceColor(A.who));
      if (u >= 1) afterAnimation();
    }

    /* column numbers under the board */
    ctx.fillStyle = TH.dim;
    ctx.font = '500 ' + Math.max(11, s * 0.22) + 'px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (var c3 = 0; c3 < NC; c3++) {
      ctx.fillText(String(c3 + 1), cellX(c3), geo.by + geo.bh + s * 0.28);
    }
  }

  /* ------------------------- thinking view ------------------------------ */

  function drawWinBar(x, y, w, now) {
    var target;
    if (st.snap && (st.phase === 'thinking' || st.phase === 'animating' || st.phase === 'over')) {
      target = pBlueFrom(st.snap.value, aiPiece());
    } else if (st.instinct) {
      target = pBlueFrom(st.instinct.value, humanPiece());
    } else {
      target = st.disp.pBlue;
    }
    if (st.result === 'human') target = 1;
    else if (st.result === 'ai') target = 0;
    else if (st.result === 'draw') target = 0.5;
    var k = reduceMotion ? 1 : 1 - Math.exp(-(now - (st.disp.t || now)) / 200);
    st.disp.pBlue += (target - st.disp.pBlue) * k;
    st.disp.t = now;

    var h = 12, p = st.disp.pBlue;
    ctx.fillStyle = TH.text;
    ctx.font = '600 13px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('Win chances', x, y - 8);
    roundRect(x, y, w, h, h / 2);
    ctx.fillStyle = TH.goldSoft;
    ctx.fill();
    ctx.save();
    roundRect(x, y, w, h, h / 2);
    ctx.clip();
    ctx.fillStyle = TH.accent;
    ctx.fillRect(x, y, w * p, h);
    ctx.restore();
    ctx.strokeStyle = TH.line;
    ctx.lineWidth = 1;
    roundRect(x, y, w, h, h / 2);
    ctx.stroke();
    /* needle */
    ctx.fillStyle = TH.text;
    ctx.fillRect(x + w * p - 1, y - 2, 2, h + 4);

    ctx.font = '400 12px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = TH.accent;
    ctx.fillText('you', x, y + h + 16);
    ctx.textAlign = 'right';
    ctx.fillStyle = TH.gold;
    ctx.fillText('AI', x + w, y + h + 16);
    var lbl;
    var d = p - 0.5;
    if (Math.abs(d) < 0.08) lbl = 'about even';
    else if (d > 0) lbl = (d > 0.35 ? 'you are winning' : 'looking good for you');
    else lbl = (d < -0.35 ? 'the AI is winning' : 'the AI likes its position');
    ctx.textAlign = 'center';
    ctx.fillStyle = TH.dim;
    ctx.fillText(lbl, x + w / 2, y + h + 16);
    ctx.textAlign = 'left';
    return y + h + 30;
  }

  function drawColBars(x, y, w, h) {
    var snap = st.snap;
    var bw = w / NC;
    var maxV = 1;
    var visits = snap ? snap.visits : null;
    var priors = snap ? snap.priors : (st.instinct ? st.instinct.priors : null);
    var tot = 0;
    if (visits) { for (var i = 0; i < NC; i++) tot += visits[i]; }
    ctx.font = '600 13px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = TH.text;
    ctx.fillText(visits && tot > 0 ? 'Instinct vs search' : 'Instinct (net priors)', x, y - 6);
    var base = y + h;
    for (var c = 0; c < NC; c++) {
      var cx = x + c * bw + bw * 0.18;
      var cw = bw * 0.64;
      /* prior: outline */
      var pv = priors ? priors[c] : 0;
      var ph = Math.max(0, Math.min(1, pv)) * (h - 18);
      ctx.strokeStyle = TH.dim;
      ctx.lineWidth = 1;
      if (ph > 0.5) ctx.strokeRect(cx, base - 14 - ph, cw, ph);
      /* visits: filled */
      if (visits && tot > 0) {
        var vv = visits[c] / tot;
        var vh = vv * (h - 18);
        ctx.fillStyle = TH.accentSoft;
        if (vh > 0.5) ctx.fillRect(cx + 1, base - 14 - vh, cw - 2, vh);
      }
      ctx.fillStyle = (st.hoverCol === c) ? TH.text : TH.dim;
      ctx.font = '400 11px "Source Sans 3", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(c + 1), cx + cw / 2, base - 2);
      ctx.textAlign = 'left';
    }
    return base + 10;
  }

  function drawTree(x, y, w, h, now) {
    var snap = st.snap;
    ctx.font = '600 13px "Source Sans 3", system-ui, sans-serif';
    ctx.fillStyle = TH.text;
    ctx.textAlign = 'left';
    ctx.fillText('Search tree', x, y + 8);
    if (!snap || !snap.tree || !snap.tree.length) {
      ctx.fillStyle = TH.dim;
      ctx.font = '400 12px "Source Sans 3", system-ui, sans-serif';
      ctx.fillText(st.phase === 'thinking' ? 'growing…' :
                   'appears while the AI thinks', x, y + 30);
      return;
    }
    /* build the tree from the edge list */
    var rootN = { kids: {}, n: 0 };
    var maxN = 1;
    for (var i = 0; i < snap.tree.length; i++) {
      var e = snap.tree[i];
      var node = rootN;
      for (var d = 0; d < e.path.length; d++) {
        var c = e.path[d];
        if (!node.kids[c]) node.kids[c] = { kids: {}, n: 0, q: 0, col: c, key: e.path.slice(0, d + 1).join(',') };
        node = node.kids[c];
      }
      node.n = e.n;
      node.q = e.q;
      if (e.n > maxN) maxN = e.n;
    }
    var pv = snap.pv || [];
    var x0 = x + 16, colW = (w - 40) / 3;
    var top = y + 22, bot = y + h - 8;

    function place(node, y0, y1, depth) {
      node.x = x0 + depth * colW;
      node.y = (y0 + y1) / 2;
      var keys = Object.keys(node.kids);
      if (!keys.length) return;
      var kids = keys.map(function (k) { return node.kids[k]; });
      kids.sort(function (a, b) { return b.n - a.n; });
      var tot = 0;
      kids.forEach(function (k) { tot += Math.sqrt(k.n) + 0.4; });
      var yy = y0;
      kids.forEach(function (k) {
        var span = (y1 - y0) * (Math.sqrt(k.n) + 0.4) / tot;
        place(k, yy, yy + span, depth + 1);
        yy += span;
      });
    }
    rootN.x = x0; rootN.y = (top + bot) / 2;
    place(rootN, top, bot, 0);

    function isPv(node, depth) {
      if (depth > pv.length) return false;
      var parts = node.key.split(',');
      for (var i2 = 0; i2 < parts.length; i2++) {
        if (+parts[i2] !== pv[i2]) return false;
      }
      return true;
    }

    function drawNode(parent, node, depth) {
      var keyT = st.seen[node.key];
      if (!keyT) { keyT = st.seen[node.key] = now; }
      var alpha = reduceMotion ? 1 : Math.min(1, (now - keyT) / 150);
      var onPv = isPv(node, depth);
      var lw = 1 + 4.5 * Math.sqrt(node.n / maxN);
      ctx.strokeStyle = onPv ? TH.accent : TH.dim;
      ctx.globalAlpha = alpha * (onPv ? 0.95 : Math.max(0.18, 0.6 * Math.sqrt(node.n / maxN)));
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(parent.x + 5, parent.y);
      var mx = (parent.x + node.x) / 2;
      ctx.bezierCurveTo(mx, parent.y, mx, node.y, node.x - 5, node.y);
      ctx.stroke();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = onPv ? TH.accent : TH.dim;
      ctx.beginPath();
      ctx.arc(node.x, node.y, 2.5 + 2.5 * Math.sqrt(node.n / maxN), 0, Math.PI * 2);
      ctx.fill();
      /* labels only where they stay legible: shallow depths or strong lines */
      if (depth <= 2 || onPv || node.n / maxN > 0.2) {
        ctx.font = '400 10px "Source Sans 3", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = onPv ? TH.text : TH.dim;
        ctx.fillText(String(node.col + 1), node.x, node.y - 7 - 2.5 * Math.sqrt(node.n / maxN));
      }
      if (onPv && depth === 1) {
        ctx.font = '400 10px "Source Sans 3", system-ui, sans-serif';
        var q = node.q;
        ctx.fillText((q >= 0 ? '+' : '') + q.toFixed(2), node.x, node.y + 14);
      }
      ctx.globalAlpha = 1;
      var keys = Object.keys(node.kids);
      for (var i3 = 0; i3 < keys.length; i3++) {
        drawNode(node, node.kids[keys[i3]], depth + 1);
      }
    }
    /* root dot */
    ctx.fillStyle = TH.text;
    ctx.beginPath();
    ctx.arc(rootN.x, rootN.y, 4, 0, Math.PI * 2);
    ctx.fill();
    var rkeys = Object.keys(rootN.kids);
    for (var i4 = 0; i4 < rkeys.length; i4++) drawNode(rootN, rootN.kids[rkeys[i4]], 1);

    /* footer: nodes + pv */
    ctx.font = '400 11px "Source Sans 3", system-ui, sans-serif';
    ctx.fillStyle = TH.dim;
    ctx.textAlign = 'left';
    var pvTxt = pv.length ? 'best line: ' + pv.slice(0, 5).map(colName).join(' → ') : '';
    ctx.fillText((snap.nodes || 0) + ' positions examined   ' + pvTxt, x, y + h + 6);
  }

  function drawThink(now) {
    if (!st.showThink || !geo.tw) return;
    var x = geo.tx, w = geo.tw;
    var y = geo.ty + 22;
    y = drawWinBar(x, y, w, now);
    var barsH = Math.min(120, geo.th * 0.25);
    y = drawColBars(x, y + 12, w, barsH);
    if (geo.showTree) {
      var treeH = geo.ty + geo.th - y - 24;
      if (treeH > 90) drawTree(x, y + 4, w, treeH, now);
    }
    /* instinct hint while the human thinks */
    if (st.phase === 'human' && st.instinct) {
      ctx.font = '400 12px "Source Sans 3", system-ui, sans-serif';
      ctx.fillStyle = TH.dim;
      ctx.textAlign = 'left';
      ctx.fillText('the net’s instinct here: column ' + colName(st.instinct.col),
                   x, geo.ty + geo.th + 14);
    }
  }

  /* ------------------------------ main loop ------------------------------ */

  var needsInstinct = false;

  function frame(now) {
    ctx.fillStyle = TH.bg;
    ctx.fillRect(0, 0, CW, CH);
    drawBoard(now);
    drawThink(now);
    requestAnimationFrame(frame);
  }

  function computeInstinct() {
    if (st.phase !== 'human') { st.instinct = null; return; }
    var out = Core.forward(model, st.bd);
    var legal = Core.legalMoves(st.bd);
    var priors = Core.maskedPriors(out.logits, legal);
    var best = legal[0];
    for (var i = 1; i < legal.length; i++) {
      if (priors[legal[i]] > priors[best]) best = legal[i];
    }
    st.instinct = { col: best, value: out.value, priors: Array.prototype.slice.call(priors) };
  }

  /* ------------------------------ input ---------------------------------- */

  canvas.addEventListener('pointermove', function (e) {
    st.hoverCol = colAt(e.clientX, e.clientY);
    st.usingKeys = false;
  });
  canvas.addEventListener('pointerleave', function () { st.hoverCol = -1; });
  canvas.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    var c = colAt(e.clientX, e.clientY);
    if (c >= 0) humanPlays(c);
  });

  document.addEventListener('keydown', function (e) {
    if (window.GadgetUI && window.GadgetUI.isTyping(e)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key;
    if (k >= '1' && k <= '7') { humanPlays(k.charCodeAt(0) - 49); return; }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      st.usingKeys = true;
      st.hoverCol = -1;
      var dir = k === 'ArrowLeft' ? -1 : 1;
      var c = st.selCol;
      for (var i = 0; i < NC; i++) {
        c = (c + dir + NC) % NC;
        if (Core.canPlay(st.bd, c)) break;
      }
      st.selCol = c;
      e.preventDefault();
      return;
    }
    if (k === 'Enter' || k === ' ') {
      if (st.usingKeys && st.phase === 'human') {
        humanPlays(st.selCol);
        e.preventDefault();
      }
      return;
    }
    if (k === 'u' || k === 'U') { undo(); return; }
    if (k === 'n' || k === 'N') { newGame(true); return; }
  });

  /* ------------------------------ panel ---------------------------------- */

  function byId(id) { return document.getElementById(id); }

  var strengthInput = byId('c4-strength');
  var strengthVal = byId('c4-strength-val');
  var strengthHint = byId('c4-strength-hint');
  var showThinkBox = byId('c4-showthink');
  var sideFirst = byId('c4-side-first');
  var sideSecond = byId('c4-side-second');

  function syncControls() {
    if (strengthInput) strengthInput.value = String(st.strength);
    if (strengthVal) strengthVal.textContent = SIM_NAMES[st.strength];
    if (strengthHint) strengthHint.textContent = SIM_HINTS[st.strength];
    if (showThinkBox) showThinkBox.checked = st.showThink;
    if (sideFirst && sideSecond) {
      sideFirst.classList.toggle('c4-seg--on', st.humanFirst);
      sideSecond.classList.toggle('c4-seg--on', !st.humanFirst);
      sideFirst.setAttribute('aria-pressed', st.humanFirst ? 'true' : 'false');
      sideSecond.setAttribute('aria-pressed', st.humanFirst ? 'false' : 'true');
    }
  }

  if (strengthInput) {
    strengthInput.addEventListener('input', function () {
      st.strength = Math.max(0, Math.min(3, +strengthInput.value | 0));
      syncControls();
    });
  }
  if (showThinkBox) {
    showThinkBox.addEventListener('change', function () {
      st.showThink = showThinkBox.checked;
      layout();
    });
  }
  if (sideFirst) sideFirst.addEventListener('click', function () {
    if (st.humanFirst) return;
    st.humanFirst = true;
    newGame(true);
    syncControls();
  });
  if (sideSecond) sideSecond.addEventListener('click', function () {
    if (!st.humanFirst) return;
    st.humanFirst = false;
    newGame(true);
    syncControls();
  });
  var btnNew = byId('c4-new');
  if (btnNew) btnNew.addEventListener('click', function () { newGame(true); });
  var btnUndo = byId('c4-undo');
  if (btnUndo) btnUndo.addEventListener('click', undo);
  var btnShare = byId('c4-share');
  if (btnShare) btnShare.addEventListener('click', function () {
    window.ShareHash.copyLink(btnShare, shareString());
  });
  var btnSave = byId('c4-save');
  if (btnSave) btnSave.addEventListener('click', function () {
    window.ShareHash.savePng(canvas, {
      label: 'Four in a Row', file: 'four-in-a-row.png',
      light: TH.light, bg: TH.bg
    });
  });

  var verifyEl = byId('c4-verify');
  if (verifyEl) {
    if (verify.ok) {
      verifyEl.textContent = '✓ model verified in your browser (max diff ' +
        verify.maxDiff.toExponential(1) + ')';
    } else {
      verifyEl.textContent = '⚠ model check failed; play may be off';
    }
    var note = (window.C4_MODEL.meta && window.C4_MODEL.meta.note) || '';
    var noteEl = byId('c4-modelnote');
    if (noteEl && note) noteEl.textContent = note;
  }

  /* panel collapse + hint via GadgetUI */
  if (window.GadgetUI) {
    var hint = window.GadgetUI.firstRunHint('fourinarow',
      'Click a column to drop a piece. Watch the right side while the AI thinks.');
    window.GadgetUI.initPanel({
      panel: 'c4-panel', toggle: 'c4-collapse',
      collapsedClass: 'c4-panel--collapsed',
      help: 'c4-help', hint: hint
    });
  }

  /* theme switching */
  function retheme() { TH = THEMES[effectiveTheme()]; }
  new MutationObserver(retheme).observe(document.documentElement,
    { attributes: true, attributeFilter: ['data-theme'] });
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)')
      .addEventListener('change', retheme);
  }

  /* ------------------------------ boot ----------------------------------- */

  window.addEventListener('resize', resize);
  resize();
  initWorker();
  syncControls();

  /* instinct read is cheap but not free — refresh it on turn changes only */
  setInterval(function () {
    if (st.phase === 'human' && !st.instinct) computeInstinct();
  }, 250);

  /* test hook (read-only) */
  window.__c4 = {
    get workerAlive() { return st.workerAlive; },
    get verified() { return verify.ok; },
    get phase() { return st.phase; },
    get moves() { return st.moves.slice(); },
    get result() { return st.result; }
  };

  if (!tryRestore()) {
    newGame(true);
  }
  requestAnimationFrame(frame);
})();
