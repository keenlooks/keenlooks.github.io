/* ==========================================================================
   fourinarow-ai.js — Web Worker for the /fourinarow/ search.

   Protocol (all messages carry gameId; stale replies are dropped by the page):
     -> {type:'init', coreUrl, modelUrl}
     <- {type:'ready', verified, maxDiff}
     -> {type:'search', gameId, seq, moves:[cols...], sims, capMs}
     <- {type:'thinking', gameId, seq, ...snapshot}   (every ~60ms)
     <- {type:'move', gameId, seq, col, ...snapshot}
     -> {type:'stop'}                                  (abort current search)

   The search is a self-scheduled pump (setTimeout(0) between chunks), never a
   synchronous loop: a Worker only delivers incoming messages when it returns
   to its event loop, so a while(!stopped) flag could never change. The pump
   yield is what lets 'stop' and follow-up 'search' messages land mid-think.
   ========================================================================== */
'use strict';

var core = null, model = null;
var cur = null;          /* {gameId, seq, search, moves} — reused across plies */
var pump = null;         /* active pump state or null */

self.onmessage = function (e) {
  var msg = e.data || {};
  if (msg.type === 'init') {
    try {
      importScripts(msg.coreUrl, msg.modelUrl);
      core = self.C4Core;
      model = core.loadModel(self.C4_MODEL);
      var chk = core.checkTestVector(model);
      self.postMessage({ type: 'ready', verified: chk.ok, maxDiff: chk.maxDiff });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
    return;
  }
  if (msg.type === 'stop') {
    if (pump) pump.stopped = true;
    return;
  }
  if (msg.type === 'search') {
    if (pump) pump.stopped = true;      /* the new request supersedes */
    startSearch(msg);
  }
};

function sameGameOneMoveLater(moves) {
  if (!cur || !cur.search) return false;
  if (moves.length !== cur.moves.length + 1) return false;
  for (var i = 0; i < cur.moves.length; i++) {
    if (moves[i] !== cur.moves[i]) return false;
  }
  return true;
}

function startSearch(msg) {
  if (!core || !model) {
    self.postMessage({ type: 'error', message: 'worker not initialized' });
    return;
  }
  var bd = core.boardFromMoves(msg.moves);
  if (!bd) {
    self.postMessage({ type: 'error', message: 'bad move list' });
    return;
  }
  var search;
  if (msg.gameId === (cur && cur.gameId) && sameGameOneMoveLater(msg.moves)) {
    /* forward one ply: keep the subtree */
    cur.search.advance(msg.moves[msg.moves.length - 1]);
    search = cur.search;
  } else {
    search = new core.Search(model, bd);
  }
  cur = { gameId: msg.gameId, seq: msg.seq, search: search, moves: msg.moves.slice() };

  var target = Math.max(0, msg.sims | 0);
  var capMs = msg.capMs || 4000;
  var t0 = Date.now(), lastSnap = 0;
  var me = { stopped: false };
  pump = me;

  function finish() {
    if (pump === me) pump = null;
    if (me.stopped) return;                    /* superseded or aborted: silent */
    var col = search.bestMove();
    var snap = search.snapshot();
    snap.type = 'move';
    snap.gameId = msg.gameId;
    snap.seq = msg.seq;
    snap.col = col;
    snap.elapsed = Date.now() - t0;
    self.postMessage(snap);
    /* remember our own reply so the NEXT search (opponent's reply appended)
       can reuse the subtree via sameGameOneMoveLater */
    cur.search.advance(col);
    cur.moves.push(col);
  }

  function tick() {
    if (me.stopped) { if (pump === me) pump = null; return; }
    var done = search.totalVisits();
    if (done >= target || Date.now() - t0 > capMs) { finish(); return; }
    var chunk = Math.min(16, target - done);
    search.run(chunk);
    var now = Date.now();
    if (now - lastSnap >= 60) {
      lastSnap = now;
      var snap = search.snapshot();
      snap.type = 'thinking';
      snap.gameId = msg.gameId;
      snap.seq = msg.seq;
      snap.elapsed = now - t0;
      self.postMessage(snap);
    }
    setTimeout(tick, 0);   /* yield: lets stop / new-search messages land */
  }

  if (target === 0) { finish(); return; }      /* Instinct: raw policy move */
  setTimeout(tick, 0);
}
