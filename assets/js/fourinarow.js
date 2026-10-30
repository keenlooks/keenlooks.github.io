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
    showThink: true,           /* phones get it too: board on top, read-out below */
    winLine: null,
    winT0: 0,
    result: null,              /* 'human' | 'ai' | 'draw' */
    lastAiMove: -1,
    hoverCol: -1,
    selCol: 3,                 /* keyboard cursor */
    usingKeys: false,
    anim: null,                /* {col,row,who,t0,dur} */
    snap: null,                /* latest thinking snapshot */
    seen: {},                  /* tree-node fade-in timestamps */
    disp: { pBlue: 0.5 },      /* smoothed win bar */
    instinct: null,            /* {col, value} while human thinks */
    workerAlive: false,
    replay: null,              /* pending share replay: {moves, i} */
    bubble: null,              /* {text, t0} the robot is saying */
    snapBaseMoves: null,       /* move list the current search started from */
    miniCache: {},             /* node key -> board, cleared per search */
    miniPix: {},               /* node key -> rendered chip, same lifetime */
    postHuman: null,           /* net value right after the human's move */
    resultT0: 0
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
  var undoWaitT = -1e9;   /* when an undo was refused mid-animation */

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
      if (m.type === 'thinking') { st.snap = m; return; }
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
    st.snapBaseMoves = st.moves.slice();
    st.miniCache = {};
    st.miniPix = {};
    st.postHuman = null;
    /* an undo refused a moment ago (piece still falling) keeps its note */
    var waitNote = (performance.now() - undoWaitT) < 1000;
    undoWaitT = -1e9;
    setStatus(waitNote ? 'Thinking… Wait for the move, then undo.' : 'Thinking…');
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
  var statusSr = document.getElementById('c4-status-sr');
  function setStatus(txt) {
    if (statusEl) statusEl.textContent = txt;
    /* the visible copy is inside the panel, which is display:none while
       collapsed; this mirror is always in the tree so it still announces */
    if (statusSr) statusSr.textContent = txt;
  }

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
      st.resultT0 = performance.now();
      st.phase = 'over';
      var line = say(pick(st.result === 'human' ? 'humanWin' : 'aiWin'));
      if (st.result === 'human') startFireworks(performance.now());
      setStatus((st.result === 'human'
        ? 'You win! Column ' + colName(a.col) + ' did it.'
        : 'The AI wins with column ' + colName(a.col) + '.') +
        ' The AI says: "' + line + '"');
      return;
    }
    if (st.bd.count === Core.CELLS) {
      st.result = 'draw';
      st.resultT0 = performance.now();
      st.phase = 'over';
      var dl = say(pick('draw'));
      setStatus('Draw. The board is full. The AI says: "' + dl + '"');
      return;
    }
    if (st.replay) {
      if (st.replay.i < st.replay.moves.length) { stepReplay(); return; }
      st.replay = null;
    }
    if (isHumansTurn()) {
      st.phase = 'human';
      st.instinct = null;
      computeInstinct();               /* ready before the human can move */
      setStatus('Your turn. The AI reads this as ' +
                confidenceLabel(st.instinct ? pBlueFrom(st.instinct.value, humanPiece())
                                            : st.disp.pBlue) + '.');
    } else {
      requestAiMove();
    }
  }

  function humanPlays(col) {
    if (st.phase !== 'human' || !Core.canPlay(st.bd, col)) return;
    var win = playMove(col, humanPiece());
    st.lastAiMove = -1;
    /* Comment on it while the piece is still falling (uses st.instinct, the
       read of the position BEFORE the move, so clear that afterwards). A
       game-ending move gets its own line from afterAnimation instead: the net
       has never seen a terminal position and would classify it at random. */
    var line = '';
    if (!st.replay && !win && st.bd.count < Core.CELLS) line = reactToHuman(col);
    st.instinct = null;
    setStatus('You played column ' + colName(col) + '.' +
              (line ? ' The AI says: "' + line + '"' : ''));
  }

  function aiPlays(col) {
    if (!Core.canPlay(st.bd, col)) {   /* should never happen; recover */
      var legal = Core.legalMoves(st.bd);
      if (!legal.length) return;
      col = legal[0];
    }
    st.lastAiMove = col;
    setStatus('The AI plays column ' + colName(col) + '.' +
      (st.snap ? ' It reads the position as: ' +
                 confidenceLabel(pBlueFrom(st.snap.value, aiPiece())) + '.' : ''));
    playMove(col, aiPiece());
  }

  function newGame(keepSides) {
    stopSearch();
    undoWaitT = -1e9;
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
    st.snapBaseMoves = null;
    st.miniCache = {};
    st.miniPix = {};
    st.postHuman = null;
    resetFx();
    if (!keepSides) { /* sides already set by caller */ }
    var op = say(pick('opening'));
    if (isHumansTurn()) {
      st.phase = 'human';
      computeInstinct();
      setStatus('New game. Your turn. The AI says: "' + op + '"');
    } else {
      requestAiMove();
    }
  }

  function undo() {
    if (st.moves.length === 0) return;
    if (st.phase === 'animating' || st.phase === 'thinking') {
      /* mid-move it would be a silent dead click; say why instead. The
         animating case is over in ~0.4 s, so remember it and let
         requestAiMove keep the note visible through the think. */
      if (st.phase === 'animating') undoWaitT = performance.now();
      setStatus('Wait for the move, then undo.');
      return;
    }
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
    st.postHuman = null;
    st.bubble = null;
    resetFx();                     /* no fireworks raining on a resumed game */
    if (isHumansTurn()) {
      st.phase = 'human';
      computeInstinct();
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

  /* The fixed #theme-toggle / #life-link buttons float over the bottom-left of
     every .life-app page. Their union is what the board and the column numbers
     under it have to stay clear of. They are created on DOMContentLoaded, i.e.
     possibly after this deferred script's first layout, so this returns null
     until they exist and cornerBandHeight falls back to a measured band. */
  function cornerBandRect() {
    var els = [document.getElementById('theme-toggle'), document.getElementById('life-link')];
    var top = Infinity, left = Infinity, right = -Infinity;
    for (var i = 0; i < els.length; i++) {
      if (!els[i]) continue;
      var r = els[i].getBoundingClientRect();
      if (!r.height) continue;
      if (r.top < top) top = r.top;
      if (r.left < left) left = r.left;
      if (r.right > right) right = r.right;
    }
    if (!isFinite(top)) return null;
    return { x: left, y: top, w: right - left };
  }

  function cornerBandHeight() {
    var band = cornerBandRect();
    if (!band) return CW <= 768 ? 116 : 96;
    return Math.max(40, Math.round(CH - band.y) + 10);
  }

  function layout() {
    /* The top vignette hides canvas text behind the nav; phones get a slightly
       tighter reserve because vertical space is precious there. */
    var topPad = CW < 700 ? Math.max(CH * 0.11, 72) : Math.max(CH * 0.16, 76);
    var botPad = cornerBandHeight();
    var think = st.showThink;
    /* The control panel overlays the top-right. While it is expanded nothing we
       draw may go under it; collapsed, it is only a header and the space is
       ours again (it collapses itself under 600px and on short screens). */
    var panelEl = document.getElementById('c4-panel');
    if (panelEl) {
      var pr = panelEl.getBoundingClientRect();
      geo.panel = { x: pr.left, y: pr.top, w: pr.width, h: pr.height };
    }
    var panelOpen = !(panelCtl && panelCtl.collapsed());
    var reserve = (panelOpen && CW >= 600) ? 356 : 0;
    var twRight = CW - Math.max(reserve, CW * 0.02);
    var shortScreen = CH < 560;
    var twWide = Math.min(430, twRight - CW * (shortScreen ? 0.34 : 0.52));
    /* a37: 250, not 260: at 1,280 px with the panel open the column is 258
       px, and the stacked fallback halved the board for 2 px. Below about
       250 the column's own headings start to run into each other. */
    var wide = think && twWide >= (shortScreen ? 190 : 250) &&
               ((CW >= 1000 && CW > CH * 0.9) || (shortScreen && CW >= 620));
    geo.wide = wide;
    geo.showTree = think && CW >= 700;
    var bx, bw, bh, by;
    /* Horizontal extents first: they do not depend on the top reserve, and the
       panel test below has to know where the board is really going to sit. */
    if (wide) {
      geo.tw = twWide;
      geo.tx = twRight - twWide;
      bx = CW * 0.03; bw = geo.tx - 24 - bx;
    } else if (think) {
      bx = CW * 0.06; bw = CW * 0.88;
    } else {
      /* thinking hidden: the board would otherwise fill the height and leave
         the robot nowhere to stand but on top of it, so keep a row free */
      bx = CW * 0.10; bw = CW * 0.80;
    }
    /* The stacked branches must respect the panel too: between 600 and 1000px
       wide with the panel open (a tablet in portrait), an unclamped board runs
       under it and those columns become unclickable. */
    if (!wide) bw = Math.min(bw, twRight - bx);
    /* Collapsed, the panel is a header floating over the top-right corner and
       nothing was reserved beside the board for it (under 600px there is no
       room to reserve). Where the two overlap it covers the board's top row:
       those cells are hidden and their taps land on the panel instead of the
       canvas, which is exactly what a phone in portrait gets. Start the board
       below it. The height guard leaves an expanded panel alone, since covering
       the board while it is open is accepted and clearing a full-height panel
       would squeeze the board to nothing. */
    var pnl = geo.panel;
    if (!reserve && pnl && pnl.h < CH * 0.5 && pnl.x < bx + bw && pnl.x + pnl.w > bx) {
      topPad = Math.max(topPad, pnl.y + pnl.h + 10);
    }
    by = topPad;
    bh = wide ? (CH - topPad - botPad)
       : think ? (CH - topPad - botPad) * 0.52
               : (CH - topPad - botPad - 58);
    /* the 3px floor keeps ctx.arc radii positive on absurdly short viewports —
       a thrown draw would otherwise kill the rAF loop for good */
    var s = Math.max(3, Math.min(bw / NC, bh / (NR + 0.6)));
    var boardW = s * NC, boardH = s * NR;
    geo.s = s;
    geo.botPad = botPad;
    geo.bx = bx + (bw - boardW) / 2;
    geo.by = by + (bh - boardH) / 2 + s * 0.3;
    /* The column numbers run in a row under the board and the corner buttons
       float over the bottom left, so where the board reaches that far left the
       "1" ends up behind them. The board is centred in its band with room to
       spare above, so lift it by the overlap rather than making it smaller. */
    var band = cornerBandRect();
    if (band) {
      var labelRoom = s * 0.28 + Math.max(11, s * 0.22) * 1.3;
      var labL = geo.bx + s * 0.5 - 10, labR = geo.bx + boardW - s * 0.5 + 10;
      if (labL < band.x + band.w && labR > band.x) {
        var over = (geo.by + boardH + labelRoom) - band.y;
        if (over > 0) geo.by -= Math.min(over, Math.max(0, geo.by - by));
      }
    }
    geo.bw = boardW;
    geo.bh = boardH;
    if (wide) {
      geo.ty = topPad; geo.th = CH - topPad - botPad;
      /* On a short screen the panel is collapsed to a header sitting over the
         top-right, which is exactly where this column starts. Begin below it so
         the robot (now at the AI end, on the right) is never hidden under it. */
      var pn = geo.panel;
      if (pn && pn.h < CH * 0.4 && pn.x < geo.tx + geo.tw && pn.x + pn.w > geo.tx) {
        var push = pn.y + pn.h + 8;
        if (push > geo.ty && push < CH - botPad - 90) {
          geo.th -= (push - geo.ty);
          geo.ty = push;
        }
      }
    } else if (think) {
      geo.tx = CW * 0.06;
      geo.tw = Math.min(CW * 0.88, twRight - geo.tx);
      geo.ty = geo.by + boardH + 22;
      /* stop short of the corner-button band, not the viewport edge */
      geo.th = (CH - botPad) - geo.ty;
    }
  }

  /* the drawn board includes a frame that overhangs the cell area */
  function boardRect() {
    var pad = geo.s * 0.25;
    return { x: geo.bx - pad, y: geo.by - pad, w: geo.bw + pad * 2, h: geo.bh + pad * 2 };
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

  /* Pieces are drawn from pre-rendered sprites: building a radial gradient per
     disc per frame (up to 43 of them) allocated constantly on a static board. */
  var discPix = {};

  function discSprite(color, r) {
    var k = color + '|' + Math.round(r * 2) + '|' + (TH.light ? 'l' : 'd');
    var hit = discPix[k];
    if (hit) return hit;
    var pad = 1, size = Math.ceil((r + pad) * 2);
    var cv = document.createElement('canvas');
    cv.width = Math.ceil(size * DPR);
    cv.height = Math.ceil(size * DPR);
    var g = cv.getContext('2d');
    if (!g) return null;
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    var c = size / 2;
    g.fillStyle = color;
    g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2); g.fill();
    /* soft highlight so it reads as a piece, not a dot */
    var grad = g.createRadialGradient(c - r * 0.35, c - r * 0.4, r * 0.1, c, c, r);
    grad.addColorStop(0, 'rgba(255,255,255,' + (TH.light ? 0.35 : 0.22) + ')');
    grad.addColorStop(0.55, 'rgba(255,255,255,0)');
    grad.addColorStop(1, 'rgba(0,0,0,' + (TH.light ? 0.08 : 0.25) + ')');
    g.fillStyle = grad;
    g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2); g.fill();
    hit = { cv: cv, size: size };
    discPix[k] = hit;
    return hit;
  }

  function disc(x, y, r, color, alpha) {
    var sp = discSprite(color, r);
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    if (sp) {
      ctx.drawImage(sp.cv, x - sp.size / 2, y - sp.size / 2, sp.size, sp.size);
    } else {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
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

  /* --------------------- the AI's little commentator --------------------- */

  /* Lines are grouped by what just happened. pick() never repeats the line it
     gave last time for that group, so a long game keeps feeling varied. */
  var LINES = {
    strong: ['Oof. That was a good one.', 'I did not want you to play there.',
             'That hurt.', 'Fine, that was strong.', 'You found it.',
             'That is a real problem for me.', 'Nicely done. I have to rethink.'],
    blunder: ['Thank you for that.', 'Ha. Now I have you.',
              'That helps me quite a bit.', 'I was hoping for that.',
              'Oh, that opens things up.', 'I will take it.',
              'That one I can work with.'],
    /* chosen from the network's raw hunch, so the wording stays hunch language
       rather than claiming the search looked somewhere */
    unexpected: ['Huh. My hunch did not point there.', 'Did not see that coming.',
                 'That was low on my list.', 'Unusual. Give me a second.',
                 'Interesting. Not what I expected.',
                 'Nobody plays that. Let me look again.'],
    neutral: ['Reasonable.', 'Fine move.', 'Okay, noted.', 'Solid enough.',
              'Sure, that works.', 'Fair.', 'Makes sense.'],
    aiWinning: ['I think this one is mine.', 'I like my chances here.',
                'This is going well for me.', 'I can see the finish from here.'],
    aiLosing: ['This is not going my way.', 'I may be in trouble here.',
               'You are ahead. I am looking for something.',
               'I need you to slip up now.'],
    opening: ['Let us see how you play.', 'Off we go.', 'Your move sets the tone.',
              'A fresh board. I like this part.'],
    humanWin: ['You got me. Well played.', 'That is four. Nicely done.',
               'Good game. You saw it before I did.', 'Beaten fair and square.'],
    aiWin: ['Four in a row. Good game!', 'Got it. Thanks for the game.',
            'That is four. Rematch?', 'There it is. That was fun.'],
    draw: ['A draw. Neither of us blinked.', 'Full board, no winner. Fair enough.',
           'Dead even. I will take it.']
  };
  var lastLine = {};

  function pick(group) {
    var arr = LINES[group];
    if (!arr || !arr.length) return '';
    if (arr.length === 1) return arr[0];
    var i, tries = 0;
    do { i = (Math.random() * arr.length) | 0; tries++; }
    while (arr[i] === lastLine[group] && tries < 8);
    lastLine[group] = arr[i];
    return arr[i];
  }

  /* Show a line in the robot's speech bubble (and in the aria-live status, so
     it reaches screen readers too). */
  function say(text) {
    if (!text) return '';
    st.bubble = { text: text, t0: performance.now() };
    return text;                      /* callers put it in the status line too */
  }

  /* React to the move the human just played: compare the net's read of the
     position before and after, and whether it saw the move coming at all. */
  function reactToHuman(col) {
    var pre = st.instinct;
    var out = Core.forward(model, st.bd);
    var pAfter = pBlueFrom(out.value, aiPiece());
    var pBefore = pre ? pBlueFrom(pre.value, humanPiece()) : pAfter;
    var d = pAfter - pBefore;
    /* "unexpected" should mean genuinely off the AI's radar, not just second
       choice: a confident net puts most of its mass on one column, so rank the
       move as well as reading its raw prior. */
    var prior = (pre && pre.priors) ? pre.priors[col] : 0.15;
    var rank = 0;
    if (pre && pre.priors) {
      for (var i = 0; i < NC; i++) if (pre.priors[i] > prior) rank++;
    }
    /* Gate the swing buckets on where the position ACTUALLY ended up, or the
       robot gloats ("Now I have you") while the bar still says you are winning. */
    var group;
    if (d >= 0.14 && pAfter > 0.30) group = 'strong';
    else if (d <= -0.14 && pAfter < 0.70) group = 'blunder';
    else if (rank >= 3 && prior < 0.06) group = 'unexpected';
    else if (pAfter < 0.12) group = 'aiWinning';
    else if (pAfter > 0.88) group = 'aiLosing';
    else group = 'neutral';
    /* keep the freshest read for the win bar; the AI's own search replaces it */
    st.postHuman = out.value;
    return say(pick(group));
  }

  /* ------------------------------ the robot ------------------------------ */

  /* moods: idle | thinking | smug | worried | happy | beaten */
  var CELEBRATE_MS = 5000;           /* then it settles: no endless dancing */

  function celebrating(now) {
    return st.resultT0 && (now - st.resultT0) < CELEBRATE_MS;
  }

  function robotMood() {
    if (st.result === 'ai') return celebrating(performance.now()) ? 'happy' : 'smug';
    if (st.result === 'human') return 'beaten';
    if (st.phase === 'thinking') return 'thinking';
    var p = st.disp.pBlue;
    if (p < 0.32) return 'smug';
    if (p > 0.68) return 'worried';
    return 'idle';
  }

  function drawRobot(cx, cy, size, mood, t) {
    var u = size / 34;                       /* everything is drawn at 34px */
    var bob = 0, tilt = 0, armUp = 0;
    if (!reduceMotion) {
      if (mood === 'happy') {
        /* the dance: hop, sway, arms up */
        var ph = t / 260;
        bob = -Math.abs(Math.sin(ph)) * 6 * u;
        tilt = Math.sin(ph / 2) * 0.22;
        armUp = 1;
      } else if (mood === 'thinking') {
        bob = Math.sin(t / 420) * 1.2 * u;
      } else if (mood === 'beaten') {
        bob = 2 * u;
      } else {
        bob = Math.sin(t / 900) * 1.4 * u;
      }
    }
    ctx.save();
    ctx.translate(cx, cy + bob);
    ctx.rotate(tilt);
    var line = TH.gold, fill = TH.light ? 'rgba(160,124,44,0.14)' : 'rgba(200,164,92,0.16)';

    /* antenna */
    ctx.strokeStyle = line;
    ctx.lineWidth = 1.6 * u;
    ctx.beginPath();
    var antX = mood === 'beaten' ? 5 * u : 0;
    ctx.moveTo(0, -10 * u);
    ctx.quadraticCurveTo(antX * 0.5, -15 * u, antX, -17 * u);
    ctx.stroke();
    var blip = (mood === 'thinking' && !reduceMotion)
      ? 2.2 + Math.sin(t / 150) * 1.1 : 2.4;
    ctx.fillStyle = line;
    ctx.beginPath();
    ctx.arc(antX, -17 * u, blip * u, 0, Math.PI * 2);
    ctx.fill();

    /* head */
    ctx.fillStyle = fill;
    ctx.strokeStyle = line;
    ctx.lineWidth = 1.5 * u;
    roundRect(-11 * u, -10 * u, 22 * u, 17 * u, 5 * u);
    ctx.fill();
    ctx.stroke();

    /* eyes */
    ctx.fillStyle = line;
    ctx.strokeStyle = line;
    var ex = 4.6 * u, ey = -2.4 * u;
    if (mood === 'beaten') {
      ctx.lineWidth = 1.5 * u;                /* ^ ^ */
      ctx.beginPath();
      ctx.moveTo(-ex - 2.2 * u, ey + 1.4 * u); ctx.lineTo(-ex, ey - 1.4 * u);
      ctx.lineTo(-ex + 2.2 * u, ey + 1.4 * u);
      ctx.moveTo(ex - 2.2 * u, ey + 1.4 * u); ctx.lineTo(ex, ey - 1.4 * u);
      ctx.lineTo(ex + 2.2 * u, ey + 1.4 * u);
      ctx.stroke();
    } else if (mood === 'happy') {
      ctx.lineWidth = 1.5 * u;                /* ^ ^ inverted = smiling eyes */
      ctx.beginPath();
      ctx.arc(-ex, ey + 1 * u, 2.4 * u, Math.PI, 0);
      ctx.moveTo(ex + 2.4 * u, ey + 1 * u);
      ctx.arc(ex, ey + 1 * u, 2.4 * u, 0, Math.PI, true);
      ctx.stroke();
    } else {
      var scan = (mood === 'thinking' && !reduceMotion) ? Math.sin(t / 300) * 1.3 * u : 0;
      var r = mood === 'worried' ? 1.5 * u : 2.1 * u;
      ctx.beginPath(); ctx.arc(-ex + scan, ey, r, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(ex + scan, ey, r, 0, Math.PI * 2); ctx.fill();
    }
    /* mouth */
    ctx.lineWidth = 1.4 * u;
    ctx.beginPath();
    if (mood === 'happy' || mood === 'smug') {
      ctx.arc(0, 1.6 * u, 3.4 * u, 0.15 * Math.PI, 0.85 * Math.PI);
    } else if (mood === 'worried' || mood === 'beaten') {
      ctx.arc(0, 6 * u, 3.4 * u, 1.15 * Math.PI, 1.85 * Math.PI);
    } else {
      ctx.moveTo(-3 * u, 3.4 * u); ctx.lineTo(3 * u, 3.4 * u);
    }
    ctx.stroke();

    /* body + arms */
    ctx.lineWidth = 1.5 * u;
    roundRect(-8 * u, 8 * u, 16 * u, 10 * u, 3 * u);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    if (armUp) {
      ctx.moveTo(-8 * u, 11 * u); ctx.lineTo(-13 * u, 5 * u);
      ctx.moveTo(8 * u, 11 * u); ctx.lineTo(13 * u, 5 * u);
    } else {
      ctx.moveTo(-8 * u, 11 * u); ctx.lineTo(-12 * u, 15 * u);
      ctx.moveTo(8 * u, 11 * u); ctx.lineTo(12 * u, 15 * u);
    }
    ctx.stroke();
    ctx.restore();
  }

  /* Speech bubble beside the robot. It is placed from the robot's OWN edge
     (half its drawn width) plus a gap, on whichever side has room, so it can
     never end up over the robot's face. */
  function drawBubble(cx, cy, half, now) {
    if (!st.bubble) return;
    var age = now - st.bubble.t0;
    if (age > 6000) { st.bubble = null; st.bubbleBox = null; return; }
    var a = reduceMotion ? 1 : Math.min(1, age / 180) * Math.min(1, (6000 - age) / 500);
    ctx.font = '400 12.5px "Source Sans 3", system-ui, sans-serif';
    var pad = 8, maxW = Math.min(190, CW - 40);
    /* wrap once per bubble (measureText forces shaping; nothing here changes
       between frames unless the viewport does) */
    if (!st.bubble.lines || st.bubble.wrapW !== maxW) {
      var words = st.bubble.text.split(' '), ls = [], cur = '';
      for (var i = 0; i < words.length; i++) {
        var t2 = cur ? cur + ' ' + words[i] : words[i];
        if (ctx.measureText(t2).width > maxW - pad * 2 && cur) { ls.push(cur); cur = words[i]; }
        else cur = t2;
      }
      if (cur) ls.push(cur);
      var wb = 0;
      for (var j = 0; j < ls.length; j++) wb = Math.max(wb, ctx.measureText(ls[j]).width);
      st.bubble.lines = ls;
      st.bubble.boxW = wb + pad * 2;
      st.bubble.wrapW = maxW;
    }
    var lines = st.bubble.lines, wBox = st.bubble.boxW;
    var hBox = lines.length * 16 + pad * 2 - 4;
    var by = cy - hBox / 2;
    if (by < 4) by = 4;
    /* the control panel is a DOM element painted OVER the canvas, so the bubble
       has to stop at its edge rather than slide underneath it */
    var right = CW - 8, left = 6;
    var p = geo.panel;
    if (p && by < p.y + p.h && by + hBox > p.y) right = Math.min(right, p.x - 8);
    /* Try beside, then below, then above, and take the first placement that is
       on screen and clear of BOTH the robot and the board. Whichever it picks,
       the tail below points at the robot. */
    var GAP = 10;
    var rightEdge = cx + half, leftEdge = cx - half;
    var board = boardRect();
    var robot = { x: leftEdge, y: cy - half * 1.5, w: half * 2, h: half * 3 };
    var cands = [
      { x: rightEdge + GAP, y: by, flip: false },
      { x: leftEdge - GAP - wBox, y: by, flip: true },
      { x: cx - wBox / 2, y: cy + half + 10, flip: false },
      { x: cx - wBox / 2, y: cy - half - 10 - hBox, flip: false }
    ];
    function hits(a, b, tol) {
      return a.x < b.x + b.w - tol && a.x + a.w - tol > b.x &&
             a.y < b.y + b.h - tol && a.y + a.h - tol > b.y;
    }
    var bx = cands[0].x, flip = false, chosen = null;
    for (var ci = 0; ci < cands.length; ci++) {
      var c = cands[ci];
      var box = { x: c.x, y: c.y, w: wBox, h: hBox };
      if (box.x < left || box.x + box.w > right) continue;
      if (box.y < 4 || box.y + box.h > CH - 4) continue;
      if (hits(box, robot, 1)) continue;
      if (hits(box, board, 2)) continue;
      chosen = c;
      break;
    }
    if (!chosen) {
      /* nothing clean: keep it on screen and off the robot at least */
      chosen = { x: Math.max(left, Math.min(cx - wBox / 2, right - wBox)),
                 y: Math.min(CH - 4 - hBox, cy + half + 10), flip: false };
    }
    bx = chosen.x; by = chosen.y; flip = chosen.flip;
    st.bubbleBox = { x: bx, y: by, w: wBox, h: hBox };
    ctx.globalAlpha = a;
    ctx.fillStyle = TH.light ? 'rgba(255,255,255,0.96)' : 'rgba(30,32,38,0.96)';
    ctx.strokeStyle = TH.line;
    ctx.lineWidth = 1;
    roundRect(bx, by, wBox, hBox, 8);
    ctx.fill();
    ctx.stroke();
    /* tail, pointing back at the robot (only when the bubble is beside it) */
    ctx.beginPath();
    var tipX = flip ? bx + wBox : bx;
    var dir = flip ? 1 : -1;
    var tipY = Math.max(by + 8, Math.min(cy, by + hBox - 8));
    ctx.moveTo(tipX, tipY - 5);
    ctx.lineTo(tipX + dir * 7, tipY);
    ctx.lineTo(tipX, tipY + 5);
    ctx.closePath();
    ctx.fillStyle = TH.light ? 'rgba(255,255,255,0.96)' : 'rgba(30,32,38,0.96)';
    ctx.fill();
    ctx.fillStyle = TH.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    for (var k = 0; k < lines.length; k++) {
      ctx.fillText(lines[k], bx + pad, by + pad + 12 + k * 16);
    }
    ctx.globalAlpha = 1;
  }

  /* ----------------------------- fireworks ------------------------------- */

  var fx = { parts: [], bursts: 0, next: 0, last: 0, flash: 0 };

  function resetFx() { fx.parts = []; fx.bursts = 0; fx.flash = 0; }

  function startFireworks(now) {
    if (reduceMotion) return;
    fx.parts = [];
    fx.bursts = 7;
    fx.next = now;
    fx.last = now;
    fx.flash = 0;
  }

  function burstAt(x, y) {
    var colors = [TH.accent, TH.gold, TH.text, TH.accent];
    var n = 44 + ((Math.random() * 16) | 0);
    /* a ring plus scatter reads more like a shell than a random puff */
    for (var i = 0; i < n; i++) {
      var ring = i < n * 0.6;
      var a = ring ? (i / (n * 0.6)) * Math.PI * 2 + Math.random() * 0.12
                   : Math.random() * Math.PI * 2;
      var sp = ring ? 130 + Math.random() * 40 : 40 + Math.random() * 170;
      fx.parts.push({
        x: x, y: y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 45,
        life: 0, ttl: 1000 + Math.random() * 900,
        c: colors[(Math.random() * colors.length) | 0],
        r: 1.6 + Math.random() * 2.4
      });
    }
    fx.flashX = x; fx.flashY = y; fx.flash = 1;
  }

  /* A few slow gold sparks around the robot while it is celebrating. */
  function sparkle(x, y, now) {
    if (reduceMotion) return;
    if (now - (fx.spark || 0) < 190) return;
    fx.spark = now;
    for (var i = 0; i < 3; i++) {
      var a = Math.random() * Math.PI * 2;
      fx.parts.push({
        x: x + Math.cos(a) * 16, y: y + Math.sin(a) * 16,
        vx: Math.cos(a) * 26, vy: Math.sin(a) * 26 - 26,
        life: 0, ttl: 700 + Math.random() * 500,
        c: TH.gold, r: 1 + Math.random() * 1.2
      });
    }
  }

  function drawFireworks(now) {
    var dt = Math.min(64, now - (fx.last || now));
    fx.last = now;
    if (fx.bursts > 0 && now >= fx.next) {
      fx.bursts--;
      fx.next = now + 300;
      burstAt(geo.bx + geo.bw * (0.15 + Math.random() * 0.7),
              geo.by + geo.bh * (0.08 + Math.random() * 0.55));
    }
    if (fx.flash > 0) {                      /* the shell's initial pop */
      fx.flash = Math.max(0, fx.flash - dt / 220);
      var g = ctx.createRadialGradient(fx.flashX, fx.flashY, 0, fx.flashX, fx.flashY, 70);
      g.addColorStop(0, 'rgba(255,255,255,' + (0.30 * fx.flash) + ')');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(fx.flashX - 70, fx.flashY - 70, 140, 140);
    }
    if (!fx.parts.length) return;
    var alive = [];
    for (var i = 0; i < fx.parts.length; i++) {
      var p = fx.parts[i];
      p.life += dt;
      if (p.life >= p.ttl) continue;
      var s = dt / 1000;
      p.x += p.vx * s;
      p.y += p.vy * s;
      p.vy += 210 * s;                       /* gravity */
      p.vx *= 0.99;
      var a = 1 - p.life / p.ttl;
      ctx.globalAlpha = a * a;
      ctx.fillStyle = p.c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (0.4 + a), 0, Math.PI * 2);
      ctx.fill();
      alive.push(p);
    }
    ctx.globalAlpha = 1;
    fx.parts = alive;
  }

  /* --------------------------- mini board chips -------------------------- */

  /* The tree's node keys are move paths from the search root, so any node's
     position is just the root move list plus that path. */
  function nodeBoard(key) {
    if (!st.snapBaseMoves) return null;
    if (Object.prototype.hasOwnProperty.call(st.miniCache, key)) return st.miniCache[key];
    var path = key.split(',');
    var mv = st.snapBaseMoves.slice();
    for (var i = 0; i < path.length; i++) mv.push(+path[i]);
    var bd = Core.boardFromMoves(mv);
    st.miniCache[key] = bd;
    return bd;
  }

  /* A node's position never changes, so each chip is rasterized once into a
     small offscreen canvas and blitted after that: the tree can hold ~50 of
     them and redrawing 42 cells apiece every frame was the page's most
     expensive paint. Cached alongside st.miniCache (reset per search). */
  function miniSprite(key, bd, cell, lastCol, glow) {
    var k = key + '|' + Math.round(cell * 2) + '|' + (TH.light ? 'l' : 'd') +
            '|' + lastCol + '|' + (glow ? 1 : 0);
    var hit = st.miniPix[k];
    if (hit) return hit;
    var w = cell * NC, h = cell * NR, pad = 3;
    var dpr = DPR;
    var cv = document.createElement('canvas');
    cv.width = Math.ceil((w + pad * 2) * dpr);
    cv.height = Math.ceil((h + pad * 2) * dpr);
    var g = cv.getContext('2d');
    if (!g) return null;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    var x = pad, y = pad;
    g.fillStyle = TH.light ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.09)';
    g.beginPath();
    var r0 = 2.5;
    g.moveTo(x - 1.5 + r0, y - 1.5);
    g.arcTo(x + w + 1.5, y - 1.5, x + w + 1.5, y + h + 1.5, r0);
    g.arcTo(x + w + 1.5, y + h + 1.5, x - 1.5, y + h + 1.5, r0);
    g.arcTo(x - 1.5, y + h + 1.5, x - 1.5, y - 1.5, r0);
    g.arcTo(x - 1.5, y - 1.5, x + w + 1.5, y - 1.5, r0);
    g.closePath();
    g.fill();
    if (glow) { g.strokeStyle = TH.accent; g.lineWidth = 1; g.stroke(); }
    var rr = cell * 0.42;
    for (var c = 0; c < NC; c++) {
      for (var rw = 0; rw < NR; rw++) {
        var who = bd.cells[rw * NC + c];
        if (!who) continue;
        g.fillStyle = who === humanPiece() ? TH.accent : TH.gold;
        g.beginPath();
        g.arc(x + c * cell + cell / 2, y + (NR - 1 - rw) * cell + cell / 2, rr, 0, Math.PI * 2);
        g.fill();
      }
    }
    if (lastCol >= 0 && bd.heights[lastCol] > 0) {
      var lr = bd.heights[lastCol] - 1;
      g.strokeStyle = TH.text;
      g.lineWidth = 0.8;
      g.beginPath();
      g.arc(x + lastCol * cell + cell / 2, y + (NR - 1 - lr) * cell + cell / 2,
            rr + 1.2, 0, Math.PI * 2);
      g.stroke();
    }
    hit = { cv: cv, w: w + pad * 2, h: h + pad * 2 };
    st.miniPix[k] = hit;
    return hit;
  }

  function drawMiniBoard(bd, cx, cy, cell, lastCol, glow, key) {
    if (!bd) return;
    var sp = miniSprite(key || '', bd, cell, lastCol, glow);
    if (!sp) return;
    ctx.drawImage(sp.cv, cx - sp.w / 2, cy - sp.h / 2, sp.w, sp.h);
  }

  /* ------------------------- thinking view ------------------------------ */

  function drawWinBar(x, y, w, now) {
    var target;
    /* right after the human moves, the freshest read is the one reactToHuman
       already computed; the AI's own search supersedes it moments later */
    if (st.postHuman !== null && st.phase === 'animating') {
      target = pBlueFrom(st.postHuman, aiPiece());
    } else if (st.snap && (st.phase === 'thinking' || st.phase === 'animating' || st.phase === 'over')) {
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
    ctx.textAlign = 'center';
    ctx.fillStyle = TH.dim;
    ctx.fillText(confidenceLabel(p), x + w / 2, y + h + 16);
    ctx.textAlign = 'left';
    return y + h + 30;
  }

  /* How the AI reads the position, in plain words. p is the human's win share,
     so the ladder runs from "the AI expects to lose" up to "the AI has it won". */
  function confidenceLabel(p) {
    if (st.result === 'human') return 'you won';
    if (st.result === 'ai') return 'the AI won';
    if (st.result === 'draw') return 'a draw';
    if (p >= 0.97) return 'the AI expects to lose';
    if (p >= 0.90) return 'the AI is in real trouble';
    if (p >= 0.78) return 'you are clearly ahead';
    if (p >= 0.64) return 'you are ahead';
    if (p >= 0.56) return 'you are a little ahead';
    if (p > 0.44) return 'about even';
    if (p > 0.36) return 'the AI is a little ahead';
    if (p > 0.22) return 'the AI is ahead';
    if (p > 0.10) return 'the AI is confident';
    if (p > 0.03) return 'the AI expects to win';
    return 'the AI has this won';
  }

  /* One bar pair per BOARD COLUMN: the hollow bar is the network's instant
     hunch, the filled bar is where the search actually spent its time. The
     numbers match the column numbers printed under the board. */
  function drawColBars(x, y, w, h) {
    /* On the human's turn the AI's snapshot is two plies stale, so the chart
       switches to the net's read of the position actually on the board and
       says so; only while the AI thinks (or just moved) is it about the AI. */
    var live = (st.phase === 'human');
    var snap = live ? null : st.snap;
    var bw = w / NC;
    var visits = snap ? snap.visits : null;
    var priors = snap ? snap.priors : (st.instinct ? st.instinct.priors : null);
    var tot = 0, i;
    if (visits) { for (i = 0; i < NC; i++) tot += visits[i]; }
    var searched = !!(visits && tot > 0);

    ctx.font = '600 13px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = TH.text;
    ctx.fillText(live ? 'Which column, in your seat?'
                      : (st.phase === 'thinking' ? 'Which column?' : 'Which column it chose'),
                 x, y - 6);

    /* legend, right-aligned on the title line, so the two bars are named */
    var lgY = y - 10, lx = x + w;
    ctx.font = '400 10.5px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'right';
    if (searched) {
      ctx.fillStyle = TH.dim;
      ctx.fillText('after searching', lx, lgY + 8);
      var w1 = ctx.measureText('after searching').width;
      ctx.fillStyle = TH.accentSoft;
      ctx.fillRect(lx - w1 - 13, lgY, 9, 9);
      lx -= w1 + 20;
    }
    ctx.fillStyle = TH.dim;
    var hunchLbl = live ? 'its hunch for you' : 'hunch';
    ctx.fillText(hunchLbl, lx, lgY + 8);
    var w2 = ctx.measureText(hunchLbl).width;
    ctx.strokeStyle = TH.dim;
    ctx.lineWidth = 1;
    ctx.strokeRect(lx - w2 - 12.5, lgY + 0.5, 8, 8);

    var base = y + h;
    var top = y + 4;
    var maxBar = base - 16 - top;
    var lead = -1, leadV = 0;
    if (searched) { for (i = 0; i < NC; i++) if (visits[i] > leadV) { leadV = visits[i]; lead = i; } }
    for (var c = 0; c < NC; c++) {
      var cx = x + c * bw + bw * 0.18;
      var cw = bw * 0.64;
      var pv = priors ? priors[c] : 0;
      var ph = Math.max(0, Math.min(1, pv)) * maxBar;
      ctx.strokeStyle = TH.dim;
      ctx.lineWidth = 1;
      if (ph > 0.5) ctx.strokeRect(cx + 0.5, base - 16 - ph + 0.5, cw - 1, ph);
      if (searched) {
        var vh = (visits[c] / tot) * maxBar;
        ctx.fillStyle = (c === lead) ? TH.accent : TH.accentSoft;
        if (vh > 0.5) ctx.fillRect(cx + 1.5, base - 16 - vh, cw - 3, vh);
      }
      var isHot = (st.hoverCol === c) || (c === lead);
      ctx.fillStyle = isHot ? TH.text : TH.dim;
      ctx.font = (c === lead ? '600 ' : '400 ') + '11px "Source Sans 3", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(c + 1), cx + cw / 2, base - 4);
    }
    ctx.font = '400 10.5px "Source Sans 3", system-ui, sans-serif';
    ctx.fillStyle = TH.dim;
    ctx.textAlign = 'center';
    ctx.fillText('board column', x + w / 2, base + 8);
    ctx.textAlign = 'left';
    return base + 16;
  }

  function drawTree(x, y, w, h, now) {
    var snap = st.snap;
    ctx.font = '600 13px "Source Sans 3", system-ui, sans-serif';
    ctx.fillStyle = TH.text;
    ctx.textAlign = 'left';
    ctx.fillText('Search tree', x, y + 8);
    ctx.font = '400 10.5px "Source Sans 3", system-ui, sans-serif';
    ctx.fillStyle = TH.dim;
    ctx.textAlign = 'right';
    ctx.fillText('each node is a position it considered', x + w, y + 8);
    ctx.textAlign = 'left';
    if (!snap || !snap.tree || !snap.tree.length) {
      ctx.fillStyle = TH.dim;
      ctx.font = '400 12px "Source Sans 3", system-ui, sans-serif';
      ctx.fillText(st.phase === 'thinking' ? 'growing…' :
                   'appears while the AI thinks', x, y + 30);
      return;
    }
    /* Build + lay out the tree ONCE per snapshot+geometry. The worker replaces
       the snapshot object ~16x/s while searching; rebuilding it every frame
       (with a keys/map/sort per node) was pure waste, and it kept running long
       after the search finished because the snapshot is kept on screen. */
    var geoKey = Math.round(x) + ',' + Math.round(y) + ',' + Math.round(w) + ',' + Math.round(h);
    var rootN, maxN;
    if (snap._rootN && snap._geoKey === geoKey) {
      rootN = snap._rootN;
      maxN = snap._maxN;
    } else {
      rootN = { kids: {}, n: 0 };
      maxN = 1;
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
      snap._rootN = rootN;
      snap._maxN = maxN;
      snap._geoKey = geoKey;
      snap._placed = false;
    }
    var pv = snap.pv || [];
    var x0 = x + 20, colW = (w - 44) / 3;
    var top = y + 22, bot = y + h - 8;
    /* mini boards need the move list the search started from */
    var miniOk = !!st.snapBaseMoves && colW > 34;

    function place(node, y0, y1, depth) {
      node.x = x0 + depth * colW;
      node.y = (y0 + y1) / 2;
      node.span = y1 - y0;
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
    if (!snap._placed) {
      rootN.x = x0; rootN.y = (top + bot) / 2;
      place(rootN, top, bot, 0);
      snap._placed = true;
    }

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
      /* A node IS a position, so draw the actual board there when the slot is
         tall enough; crowded deep nodes fall back to a dot. */
      var cell = Math.min(colW * 0.19, (node.span - 8) / (NR + 0.6));
      var showMini = miniOk && depth <= 2 && cell >= 2.4;
      if (showMini) {
        cell = Math.min(cell, 7);
        drawMiniBoard(nodeBoard(node.key), node.x, node.y, cell, node.col, onPv, node.key);
        node.half = cell * NR / 2 + 3;
      } else {
        ctx.fillStyle = onPv ? TH.accent : TH.dim;
        ctx.beginPath();
        ctx.arc(node.x, node.y, 2.5 + 2.5 * Math.sqrt(node.n / maxN), 0, Math.PI * 2);
        ctx.fill();
        node.half = 2.5 + 2.5 * Math.sqrt(node.n / maxN);
      }
      /* labels only where they stay legible: shallow depths or strong lines */
      if (depth <= 2 || onPv || node.n / maxN > 0.2) {
        ctx.font = '400 10px "Source Sans 3", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = onPv ? TH.text : TH.dim;
        ctx.fillText(String(node.col + 1), node.x, node.y - node.half - 3);
      }
      if (onPv && depth === 1) {
        ctx.font = '400 10px "Source Sans 3", system-ui, sans-serif';
        var q = node.q;
        ctx.fillText((q >= 0 ? '+' : '') + q.toFixed(2), node.x, node.y + node.half + 10);
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

  /* Compact stand-in for the tree on narrow screens: the principal variation
     drawn as a row of positions, which is the part people actually read. */
  function drawPvStrip(x, y, w, h) {
    var snap = st.snap;
    ctx.font = '600 13px "Source Sans 3", system-ui, sans-serif';
    ctx.fillStyle = TH.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('The line it expects', x, y + 8);
    if (!snap || !snap.pv || !snap.pv.length || !st.snapBaseMoves) {
      ctx.font = '400 12px "Source Sans 3", system-ui, sans-serif';
      ctx.fillStyle = TH.dim;
      ctx.fillText(st.phase === 'thinking' ? 'working on it…'
                                           : 'appears while the AI thinks', x, y + 28);
      return;
    }
    var pv = snap.pv.slice(0, 4);
    var gap = 10;
    var avail = Math.max(0, h - 34);
    var cell = Math.min((w - gap * (pv.length - 1)) / pv.length / NC, avail / NR, 9);
    if (cell < 2.5) return;
    var bw = cell * NC;
    var total = bw * pv.length + gap * (pv.length - 1);
    var sx = x + Math.max(0, (w - total) / 2) + bw / 2;
    var cy = y + 24 + (cell * NR) / 2;
    for (var i = 0; i < pv.length; i++) {
      var key = pv.slice(0, i + 1).join(',');
      drawMiniBoard(nodeBoard(key), sx + i * (bw + gap), cy, cell, pv[i], i === 0, 'pv' + key);
      ctx.font = '400 10.5px "Source Sans 3", system-ui, sans-serif';
      ctx.fillStyle = i === 0 ? TH.text : TH.dim;
      ctx.textAlign = 'center';
      ctx.fillText((i % 2 === 0 ? 'AI ' : 'you ') + colName(pv[i]),
                   sx + i * (bw + gap), cy + cell * NR / 2 + 14);
    }
    ctx.textAlign = 'left';
  }

  /* The robot lives at the top of the thinking column; with thinking hidden it
     sits under the board so its commentary is never lost. */
  function drawRobotArea(now) {
    var size, rx, ry;
    if (st.showThink && geo.tw) {
      /* the AI end of the win bar: the robot IS the gold side, so it belongs
         over the "AI" label, not over "you" */
      size = Math.min(44, Math.max(30, geo.tw * 0.13));
      rx = geo.tx + geo.tw - size * 0.55;
      ry = geo.ty + size * 0.62;
    } else {
      /* thinking hidden: under the board's RIGHT end, below the column labels
         and above the fixed corner buttons. If the board is tall enough that
         there is no room below it, tuck the robot into the margin beside it
         rather than letting it sit on the board. */
      size = 40;
      var labelBot = geo.by + geo.bh + geo.s * 0.28 + 14;
      var floor = CH - (geo.botPad || 96) - size * 0.2;
      var br = boardRect();
      var boardRight = br.x + br.w;
      var rightLimit = (geo.panel && geo.panel.y < CH * 0.6) ? geo.panel.x - 8 : CW - 8;
      if (labelBot + size * 0.62 <= floor) {
        rx = boardRight - size * 0.6;
        ry = labelBot + size * 0.62;
      } else if (rightLimit - boardRight >= size * 1.05) {
        rx = boardRight + Math.min(rightLimit - boardRight - size * 0.5, size * 0.85);
        ry = Math.min(br.y + br.h - size * 0.7, floor);
      } else {
        rx = boardRight - size * 0.6;
        ry = Math.min(labelBot + size * 0.62, floor);
      }
    }
    var mood = robotMood();
    if (mood === 'happy' && celebrating(now)) sparkle(rx, ry, now);
    drawRobot(rx, ry, size, mood, now);
    /* half-width of the drawn robot: the arms reach +/-13 units of 34 */
    var half = size * 0.42;
    st.robotBox = { x: rx - half, y: ry - size * 0.62, w: half * 2, h: size * 1.24 };
    drawBubble(rx, ry, half, now);
    return ry + size * 0.62;
  }

  function drawThink(now) {
    if (!st.showThink || !geo.tw) return;
    var x = geo.tx, w = geo.tw;
    var size = Math.min(44, Math.max(30, geo.tw * 0.13));
    var bottom = geo.ty + geo.th;
    var y = geo.ty + size * 1.24 + 26;        /* clears the robot header */
    y = drawWinBar(x, y, w, now);
    /* each section only draws if it actually fits: a short landscape phone gets
       the robot and the win bar, and nothing squeezed or clipped */
    var barsH = Math.min(112, Math.max(CW < 700 ? 54 : 64, geo.th * 0.22));
    if (bottom - y >= barsH + 30) {
      y = drawColBars(x, y + 14, w, barsH);
    }
    if (geo.showTree) {
      var treeH = bottom - y - 24;
      if (treeH > 90) drawTree(x, y + 6, w, treeH, now);
    } else if (bottom - y >= 60) {   /* drawPvStrip bails itself if cells get tiny */
      /* no room for the tree (phones): show the line it expects as a strip of
         boards instead, so the "each node is a position" idea still lands */
      drawPvStrip(x, y + 10, w, bottom - y - 14);
    }
    /* instinct hint while the human thinks */
    if (st.phase === 'human' && st.instinct && geo.showTree) {
      ctx.font = '400 12px "Source Sans 3", system-ui, sans-serif';
      ctx.fillStyle = TH.dim;
      ctx.textAlign = 'left';
      ctx.fillText('in your seat it would play column ' + colName(st.instinct.col),
                   x, geo.ty + geo.th - 2);
    }
  }

  /* ------------------------------ main loop ------------------------------ */

  var needsInstinct = false;

  function frame(now) {
    ctx.fillStyle = TH.bg;
    ctx.fillRect(0, 0, CW, CH);
    drawBoard(now);
    drawThink(now);
    drawRobotArea(now);
    drawFireworks(now);          /* celebration paints over everything */
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
  canvas.addEventListener('pointerdown', function () { st.usingKeys = false; });
  canvas.addEventListener('pointerleave', function () { st.hoverCol = -1; });
  canvas.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    var c = colAt(e.clientX, e.clientY);
    if (c >= 0) humanPlays(c);
  });

  document.addEventListener('keydown', function (e) {
    if (window.GadgetUI && window.GadgetUI.isTyping(e)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var tag = ((e.target && e.target.tagName) || '').toUpperCase();
    var k = e.key;
    /* a focused button/link owns Enter and Space (activation), and a focused
       slider or checkbox owns Enter, Space and the arrows; every other key
       stays live for the board, so 1-7/u/n keep working after a button click */
    if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY' || tag === 'LABEL') {
      if (k === 'Enter' || k === ' ') return;
    } else if (tag === 'INPUT' || tag === 'SELECT') {
      if (k === 'Enter' || k === ' ' ||
          k === 'ArrowLeft' || k === 'ArrowRight' ||
          k === 'ArrowUp' || k === 'ArrowDown' ||
          k === 'Home' || k === 'End' || k === 'PageUp' || k === 'PageDown') return;
    }
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
  var panelCtl = null;
  if (window.GadgetUI) {
    var hint = window.GadgetUI.firstRunHint('fourinarow',
      'Click a column to drop a piece. Watch the AI think while it answers.');
    panelCtl = window.GadgetUI.initPanel({
      panel: 'c4-panel', toggle: 'c4-collapse',
      collapsedClass: 'c4-panel--collapsed',
      help: 'c4-help', hint: hint,
      onToggle: function () { if (CW) layout(); }
    });
    /* a short screen (landscape phone) has no room for a full-height panel */
    if (panelCtl && window.innerHeight < 560) panelCtl.setCollapsed(true);
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
  /* the floating corner buttons are created by another deferred script, so the
     first layout may have measured nothing; re-measure once they exist */
  setTimeout(layout, 300);
  setTimeout(layout, 1500);
  initWorker();
  syncControls();

  /* (the instinct read happens on every turn change, not on a timer) */

  /* test hook (read-only) */
  window.__c4 = {
    get workerAlive() { return st.workerAlive; },
    get verified() { return verify.ok; },
    get phase() { return st.phase; },
    get moves() { return st.moves.slice(); },
    get result() { return st.result; },
    get geo() { return { bx: geo.bx, by: geo.by, bw: geo.bw, bh: geo.bh, s: geo.s }; },
    /* laid-out boxes so overlap can be asserted in tests rather than eyeballed */
    get boxes() {
      return { robot: st.robotBox || null, bubble: st.bubbleBox || null,
               panel: geo.panel || null, board: geo.s ? boardRect() : null,
               band: cornerBandRect(), think: geo.tw
                 ? { x: geo.tx, y: geo.ty, w: geo.tw, h: geo.th } : null };
    },
    say: function (t) { say(String(t || '')); }
  };

  if (!tryRestore()) {
    newGame(true);
  }
  requestAnimationFrame(frame);
})();

/* ---- guided first-run tour (design pass F3) --------------------------------
   Registered from OUTSIDE the page module on purpose: targets come from the
   read-only window.__c4 hooks, so the pinned game code above stays untouched.
   gadget-tour.js also reroutes the ? button here (see its firstRunHint shim). */
(function () {
  if (!window.GadgetUI || !window.GadgetUI.tour) return;
  function box(name) {
    try {
      var b = window.__c4 && window.__c4.boxes;
      return b ? b[name] : null;
    } catch (e) { return null; }
  }
  /* a117: "Click" on a fine pointer */
  var tapC4 = (window.GadgetUI.coarse && window.GadgetUI.coarse()) ? 'Tap' : 'Click';
  window.GadgetUI.tour('fourinarow', [
    { text: 'You are blue. ' + tapC4 + ' a column to drop a disc.',
      rect: function () { return box('board'); }, side: 'right' },
    { text: 'The gold robot shows what it is thinking while it plays.',
      rect: function () { return box('think') || box('robot') || box('board'); },
      side: 'top' },
    { text: 'The panel sets how hard it thinks.',
      rect: '#c4-panel', side: 'left' }
  ], { avoid: ['#c4-panel'] });
})();
