/* ==========================================================================
   fourinarow-core.js — pure logic for the /fourinarow/ demo. No DOM.
   Runs in the page, inside the Web Worker (fourinarow-ai.js), and in node
   (export-guard below), so it attaches to self/globalThis — NEVER window.

   Contents: board ops (7x6, row 0 = bottom), incremental win check, the
   int8-dequantized conv-net forward pass (must match make_fourinarow_model.py's
   export within 1e-4 — checkTestVector verifies at load), and PUCT MCTS.

   MCTS sign discipline (canonical, keep in sync with the Python trainer):
   edge stats {N, W, P} live on the edge from the parent; W accumulates value
   from the perspective of the player to move at the PARENT, so selection is
   argmax over legal a of W(a)/max(1,N(a)) + c*P(a)*sqrt(sum N)/(1+N(a)).
   Leaf value v = net value for the side to move AT THE LEAF; a terminal leaf
   reached by a winning move has v = -1 (the side to move there has lost);
   draw v = 0. Backing up leaf->root, add v to the incoming edge with the sign
   flipped every ply (the edge into the leaf gets -v: its parent is the winner).
   ========================================================================== */
(function (root) {
  'use strict';
  if (root.C4Core) return;

  var W = 7, H = 6, CELLS = 42;
  var CPUCT = 1.5;

  /* ----------------------------- board ---------------------------------- */

  function newBoard() {
    return { cells: new Int8Array(CELLS), heights: new Int8Array(W), count: 0 };
  }

  function copyBoard(src) {
    var b = newBoard();
    b.cells.set(src.cells);
    b.heights.set(src.heights);
    b.count = src.count;
    return b;
  }

  function stm(bd) { return 1 + (bd.count & 1); }        /* 1 = first player  */

  function canPlay(bd, col) { return bd.heights[col] < H; }

  function legalMoves(bd) {
    var out = [];
    for (var c = 0; c < W; c++) if (bd.heights[c] < H) out.push(c);
    return out;
  }

  /* Drop a stone for the side to move. Returns the row it landed in.
     Caller must check canPlay first. */
  function makeMove(bd, col) {
    var row = bd.heights[col];
    bd.cells[row * W + col] = stm(bd);
    bd.heights[col] = row + 1;
    bd.count++;
    return row;
  }

  function unmakeMove(bd, col) {
    var row = bd.heights[col] - 1;
    bd.cells[row * W + col] = 0;
    bd.heights[col] = row;
    bd.count--;
  }

  /* Did the stone at (row, col) complete 4+? O(1): scan the 4 directions.
     Returns null or {cells: [idx...]} of the whole winning run (for the glow). */
  function winAt(bd, col, row) {
    var who = bd.cells[row * W + col];
    if (!who) return null;
    var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (var d = 0; d < 4; d++) {
      var dc = dirs[d][0], dr = dirs[d][1];
      var run = [row * W + col];
      var c, r;
      for (c = col + dc, r = row + dr;
           c >= 0 && c < W && r >= 0 && r < H && bd.cells[r * W + c] === who;
           c += dc, r += dr) run.push(r * W + c);
      for (c = col - dc, r = row - dr;
           c >= 0 && c < W && r >= 0 && r < H && bd.cells[r * W + c] === who;
           c -= dc, r -= dr) run.push(r * W + c);
      if (run.length >= 4) return { cells: run };
    }
    return null;
  }

  function isWin(bd, col, row) { return winAt(bd, col, row) !== null; }

  function boardFromMoves(moves) {
    var bd = newBoard();
    var last = null;
    for (var i = 0; i < moves.length; i++) {
      var c = moves[i] | 0;
      if (c < 0 || c >= W || !canPlay(bd, c)) return null;   /* hostile input */
      var r = makeMove(bd, c);
      last = { col: c, row: r };
    }
    bd.last = last;
    return bd;
  }

  /* ------------------------------ model --------------------------------- */

  function b64ToInt8(s) {
    var bin;
    if (typeof atob === 'function') {
      bin = atob(s);
      var out = new Int8Array(bin.length);
      for (var i = 0; i < bin.length; i++) {
        var v = bin.charCodeAt(i);
        out[i] = v > 127 ? v - 256 : v;
      }
      return out;
    }
    /* node */
    var buf = Buffer.from(s, 'base64');
    return new Int8Array(buf.buffer, buf.byteOffset, buf.length);
  }

  function dequant(t) {
    var q = b64ToInt8(t.b64), s = t.s;
    var out = new Float32Array(q.length);
    for (var i = 0; i < q.length; i++) out[i] = q[i] * s;
    return out;
  }

  /* Conv buffers are ZERO-PADDED (8 rows x 9 cols per channel, interior at
     (1..6, 1..7)) so the 3x3 taps become nine fixed offsets with no bounds
     checks in the hot loop — ~3x faster than the naive version. Borders are
     zeroed once at allocation and never written again. */
  var PW = 9, PCELLS = 72;   /* padded row stride / cells per channel */
  var OFF = [-10, -9, -8, -1, 0, 1, 8, 9, 10];  /* tap k=(di+1)*3+(dj+1) */

  /* Turn the exported global object into fast typed arrays + scratch buffers.
     Call once; the returned model is reused for every eval. */
  function loadModel(M) {
    var ch = M.ch;
    var m = {
      ch: ch,
      c1w: dequant(M.c1w), c1b: new Float32Array(M.c1b),
      c2w: dequant(M.c2w), c2b: new Float32Array(M.c2b),
      c3w: dequant(M.c3w), c3b: new Float32Array(M.c3b),
      pw: dequant(M.pw), pb: new Float32Array(M.pb),
      v1w: dequant(M.v1w), v1b: new Float32Array(M.v1b),
      v2w: dequant(M.v2w), v2b: new Float32Array(M.v2b),
      /* padded scratch (borders stay zero forever) */
      xp: new Float32Array(2 * PCELLS),
      a1p: new Float32Array(ch * PCELLS),
      a2p: new Float32Array(ch * PCELLS),
      a3p: new Float32Array(ch * PCELLS),
      a3: new Float32Array(ch * CELLS),
      av: new Float32Array(64),
      logits: new Float32Array(W),
      testVector: M.testVector || null,
      meta: M.meta || null
    };
    return m;
  }

  /* 3x3 pad-1 conv, padded-in -> padded-out, fused ReLU. Weight layout
     w[o, ci*9 + k] with tap order k = (di+1)*3 + (dj+1) — matches the trainer. */
  function conv(inp, cin, w, b, out, ch) {
    for (var o = 0; o < ch; o++) {
      var wo = o * cin * 9, oo = o * PCELLS, bo = b[o];
      for (var i = 0; i < H; i++) {
        var rowBase = (i + 1) * PW + 1;
        for (var j = 0; j < W; j++) {
          var acc = bo, p = rowBase + j;
          for (var ci = 0; ci < cin; ci++) {
            var wb = wo + ci * 9, ib = ci * PCELLS + p;
            acc += w[wb] * inp[ib - 10] + w[wb + 1] * inp[ib - 9] +
                   w[wb + 2] * inp[ib - 8] + w[wb + 3] * inp[ib - 1] +
                   w[wb + 4] * inp[ib] + w[wb + 5] * inp[ib + 1] +
                   w[wb + 6] * inp[ib + 8] + w[wb + 7] * inp[ib + 9] +
                   w[wb + 8] * inp[ib + 10];
          }
          out[oo + p] = acc > 0 ? acc : 0;   /* fused ReLU */
        }
      }
    }
  }

  /* Fill m.xp with the (2,6,7) planes (padded): plane 0 = side-to-move stones. */
  function fillPlanes(m, bd) {
    var me = stm(bd), x = m.xp;
    for (var i = 0; i < H; i++) {
      for (var j = 0; j < W; j++) {
        var v = bd.cells[i * W + j], p = (i + 1) * PW + 1 + j;
        x[p] = v === me ? 1 : 0;
        x[PCELLS + p] = (v !== 0 && v !== me) ? 1 : 0;
      }
    }
  }

  /* Copy the padded conv output into the flat (ch, 6, 7) layout the FC
     weights were exported against. */
  function unpad(m) {
    var ch = m.ch, src = m.a3p, dst = m.a3;
    for (var c = 0; c < ch; c++) {
      var sb = c * PCELLS, db = c * CELLS;
      for (var i = 0; i < H; i++) {
        var s = sb + (i + 1) * PW + 1, d = db + i * W;
        for (var j = 0; j < W; j++) dst[d + j] = src[s + j];
      }
    }
  }

  /* Forward pass. Returns {logits (Float32Array(7), RAW — mask at use time),
     value (number in [-1,1], for the side to move)}. */
  function forward(m, bd) {
    fillPlanes(m, bd);
    var ch = m.ch;
    conv(m.xp, 2, m.c1w, m.c1b, m.a1p, ch);
    conv(m.a1p, ch, m.c2w, m.c2b, m.a2p, ch);
    conv(m.a2p, ch, m.c3w, m.c3b, m.a3p, ch);
    unpad(m);
    var flat = m.a3, n = ch * CELLS, i, j, acc;
    for (j = 0; j < W; j++) {
      acc = m.pb[j];
      var pwj = j * n;
      for (i = 0; i < n; i++) acc += m.pw[pwj + i] * flat[i];
      m.logits[j] = acc;
    }
    for (j = 0; j < 64; j++) {
      acc = m.v1b[j];
      var vwj = j * n;
      for (i = 0; i < n; i++) acc += m.v1w[vwj + i] * flat[i];
      m.av[j] = acc > 0 ? acc : 0;
    }
    acc = m.v2b[0];
    for (j = 0; j < 64; j++) acc += m.v2w[j] * m.av[j];
    var e2 = Math.exp(2 * acc);
    var value = (e2 - 1) / (e2 + 1);
    return { logits: m.logits, value: value };
  }

  /* Softmax the logits over the legal moves only. Returns Float32Array(7)
     (illegal entries 0). */
  function maskedPriors(logits, legal) {
    var P = new Float32Array(W), mx = -Infinity, i, c;
    for (i = 0; i < legal.length; i++) if (logits[legal[i]] > mx) mx = logits[legal[i]];
    var sum = 0;
    for (i = 0; i < legal.length; i++) {
      c = legal[i];
      P[c] = Math.exp(logits[c] - mx);
      sum += P[c];
    }
    for (i = 0; i < legal.length; i++) P[legal[i]] /= sum;
    return P;
  }

  /* Verify the JS forward pass against the exported testVector. */
  function checkTestVector(m) {
    if (!m.testVector) return { ok: false, maxDiff: Infinity, reason: 'no testVector' };
    var maxDiff = 0;
    for (var t = 0; t < m.testVector.length; t++) {
      var tv = m.testVector[t];
      var bd = boardFromMoves(tv.moves);
      if (!bd) return { ok: false, maxDiff: Infinity, reason: 'bad moves' };
      var out = forward(m, bd);
      for (var j = 0; j < W; j++) {
        var d = Math.abs(out.logits[j] - tv.logits[j]);
        if (d > maxDiff) maxDiff = d;
      }
      var dv = Math.abs(out.value - tv.value);
      if (dv > maxDiff) maxDiff = dv;
    }
    return { ok: maxDiff < 1e-4, maxDiff: maxDiff };
  }

  /* ------------------------------ MCTS ---------------------------------- */

  function newNode(legal) {
    return {
      P: null,
      N: new Float64Array(W),
      W: new Float64Array(W),
      kids: [null, null, null, null, null, null, null],
      legal: legal,
      /* 0 unknown, 1 win-for-mover (playing this col ends the game), 2 draw */
      term: new Int8Array(W)
    };
  }

  /* A search over the position `bd` (copied). advance(col) follows a played
     move and keeps the subtree; anything else (undo, new game) = create a
     fresh Search. */
  function Search(model, bd) {
    this.model = model;
    this.base = copyBoard(bd);
    this.root = newNode(legalMoves(this.base));
    this.nodes = 1;
    this.scratch = newBoard();
    this._expandRoot();
  }

  Search.prototype._expandRoot = function () {
    if (this.root.P !== null) return;
    var out = forward(this.model, this.base);
    this.root.P = maskedPriors(out.logits, this.root.legal);
    this.rootValue = out.value;
  };

  /* One simulation: descend, evaluate/expand, back up. */
  Search.prototype.simulate = function () {
    var bd = this.scratch;
    bd.cells.set(this.base.cells);
    bd.heights.set(this.base.heights);
    bd.count = this.base.count;

    var node = this.root;
    var path = [];          /* [node, action, node, action, ...] */
    var v;                  /* value of the position AFTER the last edge,
                               from that position's side-to-move perspective */
    for (;;) {
      if (node.P === null) {
        var out = forward(this.model, bd);
        node.P = maskedPriors(out.logits, node.legal);
        v = out.value;
        break;
      }
      var sq = Math.sqrt(node.N[0] + node.N[1] + node.N[2] + node.N[3] +
                         node.N[4] + node.N[5] + node.N[6] + 1e-8);
      var bestA = -1, bestU = -Infinity;
      for (var i = 0; i < node.legal.length; i++) {
        var a = node.legal[i];
        if (node.term[a] === 1) { bestA = a; bestU = Infinity; break; }
        var q = node.N[a] > 0 ? node.W[a] / node.N[a] : 0;
        var u = q + CPUCT * node.P[a] * sq / (1 + node.N[a]);
        if (u > bestU) { bestU = u; bestA = a; }
      }
      var act = bestA;
      path.push(node, act);
      var row = makeMove(bd, act);
      if (node.term[act] === 0) {
        if (isWin(bd, act, row)) node.term[act] = 1;
        else if (bd.count === CELLS) node.term[act] = 2;
      }
      if (node.term[act] === 1) { v = -1; break; }   /* side to move at child lost */
      if (node.term[act] === 2) { v = 0; break; }
      if (node.kids[act] === null) {
        node.kids[act] = newNode(legalMoves(bd));
        this.nodes++;
      }
      node = node.kids[act];
    }
    /* back up: flip sign each ply; the edge into the leaf gets -v */
    for (var k = path.length - 2; k >= 0; k -= 2) {
      v = -v;
      var pn = path[k], pa = path[k + 1];
      pn.N[pa] += 1;
      pn.W[pa] += v;
    }
  };

  Search.prototype.run = function (nSims) {
    for (var i = 0; i < nSims; i++) this.simulate();
  };

  Search.prototype.totalVisits = function () {
    var n = this.root.N, s = 0;
    for (var i = 0; i < W; i++) s += n[i];
    return s;
  };

  /* Best move by visits; random tie-break. Instinct (0 sims): raw policy. */
  Search.prototype.bestMove = function () {
    var n = this.root.N, legal = this.root.legal, i;
    var tot = this.totalVisits();
    if (tot === 0) {
      var best = legal[0];
      for (i = 1; i < legal.length; i++) {
        if (this.root.P[legal[i]] > this.root.P[best]) best = legal[i];
      }
      return best;
    }
    var mx = -1, ties = [];
    for (i = 0; i < legal.length; i++) {
      var a = legal[i];
      if (n[a] > mx) { mx = n[a]; ties = [a]; }
      else if (n[a] === mx) ties.push(a);
    }
    return ties[(Math.random() * ties.length) | 0];
  };

  /* Root value estimate in [-1,1] for the side to move at the root:
     visit-weighted child Q (negated back to root perspective). */
  Search.prototype.rootQ = function () {
    var n = this.root.N, w = this.root.W, s = 0, wsum = 0;
    for (var i = 0; i < W; i++) { s += n[i]; wsum += w[i]; }
    if (s === 0) return this.rootValue || 0;
    return wsum / s;
  };

  /* Principal variation, up to maxLen columns. */
  Search.prototype.pv = function (maxLen) {
    var out = [], node = this.root;
    while (node && out.length < maxLen) {
      var bestA = -1, bestN = 0;
      for (var i = 0; i < node.legal.length; i++) {
        var a = node.legal[i];
        if (node.N[a] > bestN) { bestN = node.N[a]; bestA = a; }
      }
      if (bestA < 0) break;
      out.push(bestA);
      node = node.kids[bestA];
    }
    return out;
  };

  /* Top edges for the tree viz: BFS to depth<=maxDepth, keep the most-visited
     maxEdges. Each edge: {path: [cols...], n, q} where q is from the
     perspective of the player about to make the LAST move of the path. */
  Search.prototype.topEdges = function (maxDepth, maxEdges) {
    var edges = [];
    function walk(node, prefix, depth) {
      if (!node || depth >= maxDepth) return;
      for (var i = 0; i < node.legal.length; i++) {
        var a = node.legal[i];
        if (node.N[a] <= 0) continue;
        var p = prefix.concat(a);
        edges.push({ path: p, n: node.N[a], q: node.W[a] / node.N[a] });
        walk(node.kids[a], p, depth + 1);
      }
    }
    walk(this.root, [], 0);
    edges.sort(function (x, y) { return y.n - x.n; });
    return edges.slice(0, maxEdges);
  };

  /* Serializable snapshot for the thinking view. */
  Search.prototype.snapshot = function () {
    var n = this.root.N;
    var visits = [], priors = [];
    for (var i = 0; i < W; i++) {
      visits.push(n[i]);
      priors.push(this.root.P ? this.root.P[i] : 0);
    }
    return {
      visits: visits,
      priors: priors,
      value: this.rootQ(),
      netValue: this.rootValue || 0,
      pv: this.pv(8),
      nodes: this.nodes,
      tree: this.topEdges(3, 64)
    };
  };

  /* Follow a played move, keeping the subtree (forward one ply ONLY). */
  Search.prototype.advance = function (col) {
    if (!canPlay(this.base, col)) return false;
    makeMove(this.base, col);
    var kid = this.root.kids[col];
    this.root = kid !== null ? kid : newNode(legalMoves(this.base));
    if (this.root.P === null && this.base.count < CELLS) this._expandRoot();
    return true;
  };

  root.C4Core = {
    W: W, H: H, CELLS: CELLS, CPUCT: CPUCT,
    newBoard: newBoard, copyBoard: copyBoard, stm: stm,
    canPlay: canPlay, legalMoves: legalMoves,
    makeMove: makeMove, unmakeMove: unmakeMove,
    winAt: winAt, isWin: isWin, boardFromMoves: boardFromMoves,
    loadModel: loadModel, forward: forward, maskedPriors: maskedPriors,
    checkTestVector: checkTestVector,
    Search: Search
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.C4Core;
})(typeof self !== 'undefined' ? self : globalThis);
