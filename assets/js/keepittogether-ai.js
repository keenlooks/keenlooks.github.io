/* keepittogether-ai.js
 *
 * The Keep It Together Worker. It plays whole games off the main thread for the
 * cross play grid and for the gallery, through exactly the code path the page
 * uses: KeepCore.playEpisode with net agents. There is no second rules engine
 * and no second build policy in this file, which is the D5 3.8 single code path
 * law: a square of the grid is a game your browser played, or it is nothing.
 * The one other forward pass here is the READER's own head on a gallery play,
 * and it runs through KeepCore.discriminateBoard, which is the same call the
 * page's live bars make (SEAM C4-S1, and the intents block below).
 *
 * Five laws, each of which cost somebody real time before:
 *
 *  1. It attaches to self, never window. There is no window in a Worker, and a
 *     core or a model that reached for one would die on the first line.
 *  2. A failure inside importScripts posts a NORMAL message, not onerror. So
 *     every failure path in this file ends in a {type:'error'} message, and the
 *     page's own workerDead() ladder takes it from there. That is the four in a
 *     row law, restated because it once cost a permanent hang.
 *  3. It yields between EPISODES, not between cells. A cell is several whole
 *     games and can be 600 ms; one game is about 23 ms. The pump is self
 *     scheduled with setTimeout(0), because a while (!stopped) flag can NEVER
 *     change inside a Worker: messages are only delivered at the event loop.
 *  4. Every reply carries the jobId and the seq it was asked with, so the page
 *     drops a stale answer instead of painting it.
 *  5. It never invents a result. A net it cannot find gives an empty seat and
 *     says so on the cell; a game that throws gives ok false and no layout.
 *
 * Protocol (D5 section 8.3, with the additive fields named in INTERFACES):
 *
 *   -> {type:'init',  coreUrl, modelUrl, map, verify}
 *   <- {type:'ready', verified, netMax, tickOk, ...}
 *   -> {type:'grid',  jobId, seq, seed, rows:[key], cols:[key], episodes}
 *   <- {type:'cell',  jobId, seq, i, j, k, score, keepHp, layout, hp, ok, miss,
 *                       episodes, done, played, total}
 *   <- {type:'done',  jobId, seq, kind:'grid', cells, played, total}
 *   -> {type:'plays', jobId, seq, list:[{a, b, seed}], episodes}
 *   <- {type:'play',  jobId, seq, k, score, keepHp, layout, hp, ok, miss, episodes,
 *                       done, played, total, intents, intentsReason}
 *                       intents = one softmax per BUILD TICK from discriminateBoard
 *   <- {type:'done',  jobId, seq, kind:'plays', cells, played, total}
 *   -> {type:'row',   jobId, seq, seed, cols:[key], moves:[{cell, kind}], episodes}
 *   <- {type:'rowcell', jobId, seq, i:0, j, k, score, keepHp, layout, hp, ok, miss,
 *                       episodes, done, played, total, moves}
 *                       moves = how many of the visitor's pieces survived sanitising
 *   <- {type:'done',  jobId, seq, kind:'row', cells, played, total}
 *   -> {type:'cancel', jobId}           jobId omitted cancels whatever is running
 *   -> {type:'ping'}    <- {type:'pong', busy, ...}      liveness, and the proof
 *                                                        that the pump yields
 *   <- {type:'error', message, phase}   any death; the page runs workerDead()
 *
 * Every per cell message IS the progress message (spec v3 s7.15 ruling 4): it
 * carries `done` and `total` so the page paints a count it was told rather than
 * one it kept, and it carries the finished cell's thumbnail (`layout`, `hp`) and
 * that cell's own `keepHp`, so nothing on screen needs a game played here.
 */
'use strict';

(function (G) {

  /* ------------------------------------------------------------------ state */

  var CORE = null;          /* KeepCore, once importScripts has run */
  var model = null;         /* the loaded model handle */
  var CELLS = 0;            /* W * H of the active board */
  var booted = false;
  var job = null;           /* the ONE job in flight, or null */
  var pumpArmed = false;
  var netCache = null;      /* key -> {agent, ok}, resolved once per key */
  var counters = { episodes: 0, cells: 0, jobs: 0, errors: 0 };

  var SLICE = 0;            /* ms; 0 means exactly one episode per macrotask */

  function now() {
    return (typeof performance !== 'undefined' && performance && performance.now)
      ? performance.now() : Date.now();
  }

  function post(m, transfer) {
    try {
      if (transfer && transfer.length) G.postMessage(m, transfer);
      else G.postMessage(m);
    } catch (e) {
      /* a message that cannot be cloned must not take the worker down silently */
      try { G.postMessage({ type: 'error', phase: 'post', message: String((e && e.message) || e) }); }
      catch (e2) {}
    }
  }

  /* Law 2. Every death goes through here, and it is a normal message. */
  function die(phase, err) {
    counters.errors++;
    job = null;
    post({ type: 'error', phase: phase, message: String((err && err.message) || err || 'unknown') });
  }

  /* ------------------------------------------------------------------- init */

  function handleInit(m) {
    if (booted) { postReady(0, null); return; }
    var t0 = now();
    if (!m || !m.coreUrl) { die('init', 'init carried no coreUrl'); return; }

    /* importScripts throws SYNCHRONOUSLY on a 404 or a parse error and fires no
     * onerror at all. Both urls go in one call so a model that needs the core
     * global still sees it. */
    try {
      if (m.modelUrl) G.importScripts(m.coreUrl, m.modelUrl);
      else G.importScripts(m.coreUrl);
    } catch (e) { die('import', e); return; }

    CORE = G.KeepCore || null;
    if (!CORE) { die('import', 'the core script loaded but self.KeepCore is missing'); return; }
    if (typeof CORE.playEpisode !== 'function') {
      die('import', 'the core carries no playEpisode'); return;
    }

    if (m.map) {
      try { CORE.setMap(m.map); }
      catch (e) { die('init', 'unknown map ' + m.map); return; }
    }

    try {
      CELLS = (CORE.CONST.W | 0) * (CORE.CONST.H | 0);
    } catch (e) { die('init', 'the core carries no CONST'); return; }
    if (!(CELLS > 0)) { die('init', 'the board has no cells'); return; }

    var MODEL = G.KIT_MODEL || null;
    var loadErr = null;
    if (MODEL) {
      try { model = CORE.loadModel(MODEL); }
      catch (e) { model = null; loadErr = String((e && e.message) || e); }
    }
    netCache = {};

    /* the self check: one whole game with two empty seats, which exercises the
     * episode draw, the build phase, all three waves and the wave loop. It is
     * cheap and it is the honest answer to tickOk. */
    var tickOk = false, tickErr = null;
    try {
      var r = CORE.playEpisode({ seed: 12345, a: { kind: 'none' }, b: { kind: 'none' } });
      tickOk = !!r && isFinite(r.score);
    } catch (e) { tickOk = false; tickErr = String((e && e.message) || e); }

    booted = true;
    postReady(now() - t0, { loadErr: loadErr, tickErr: tickErr, tickOk: tickOk,
                            raw: MODEL, verify: m.verify !== false });
  }

  /* the grid axes are the NUMBERED nets, sp0..sp7 and ac0..ac7. 'spec' and
   * 'specDiv' also begin with sp and are not grid rows, so the match is on the
   * numbered form and never on a bare prefix. */
  var RE_SP = /^sp[0-9]+$/, RE_AC = /^ac[0-9]+$/;
  function netKeysOf(raw, re) {
    var out = [], k;
    var nets = (raw && raw.nets) || null;
    if (!nets) return out;
    for (k in nets) {
      if (!Object.prototype.hasOwnProperty.call(nets, k)) continue;
      if (!re || re.test(k)) out.push(k);
    }
    out.sort();
    return out;
  }

  function postReady(ms, extra) {
    extra = extra || {};
    var raw = extra.raw || (G.KIT_MODEL || null);
    var sp = netKeysOf(raw, RE_SP), ac = netKeysOf(raw, RE_AC), all = netKeysOf(raw, null);
    var meta = (raw && raw.meta) || {};
    var verified = false, verifyStatus = 'absent';
    if (extra.verify !== false && model && CORE && typeof CORE.checkTestVector === 'function') {
      try {
        var v = CORE.checkTestVector(model);
        verified = !!(v && v.ok === true);
        verifyStatus = (v && v.status) || 'absent';
      } catch (e) { verified = false; verifyStatus = 'error'; }
    }
    post({
      type: 'ready',
      verified: verified,
      verifyStatus: verifyStatus,
      netMax: sp.length,
      tickOk: !!extra.tickOk,
      tickError: extra.tickErr || null,
      modelError: extra.loadErr || null,
      map: (CORE && CORE.MAP) || null,
      cells: CELLS,
      tiles: (CORE && CORE.ARCH && CORE.ARCH.tiles) || 0,
      netKeys: all,
      netCounts: { sp: sp.length, ac: ac.length },
      placeholder: !!(meta.placeholder) || meta.trained === '',
      mock: !!meta.mock,
      bootMs: Math.round(ms)
    });
  }

  /* ------------------------------------------------------------------ agents */

  /* A net that is not in the file gives an EMPTY seat, exactly as the page's own
   * fallback does, and the cell says which side was empty. Nothing is
   * substituted for a missing engineer.
   *
   * SEAM C5-S1: the descriptor names no `extra`, and for an accommodator that is
   * now the RIGHT thing to write. Core reads the trunk width off the net's own W1
   * and recomputes the columns at every turn of that seat (KeepCore.accExtra), so
   * the grid and the gallery seat the same engineer the page's live act does and
   * the same one the trainer trained. A key's name decides nothing here. */
  function agentFor(key) {
    if (!key) return { agent: { kind: 'none' }, ok: false };
    if (netCache && Object.prototype.hasOwnProperty.call(netCache, key)) return netCache[key];
    var got = { agent: { kind: 'none' }, ok: false };
    if (model && CORE && typeof CORE.netFor === 'function') {
      var tries = [key, 'nets.' + key], i, net;
      for (i = 0; i < tries.length; i++) {
        net = null;
        try { net = CORE.netFor(model, tries[i]); } catch (e) { net = null; }
        if (net) { got = { agent: { kind: 'net', net: net }, ok: true }; break; }
      }
    }
    if (netCache) netCache[key] = got;
    return got;
  }

  /* ------------------------------------------------------------- the row job
   *
   * The visitor's own layout, played against every engineer in the column pool.
   * It is the same seat the page's your-turn act uses (core's `human` kind, a
   * queue of {cell, kind}), so a row square is a game your browser played by the
   * same runner every other square is, and it comes back with the same picture
   * bytes so the You row can be DRAWN rather than left as a number.
   *
   * Two things this seat needs that the grid does not:
   *
   *  1. core's humanTurn SHIFTS the queue, so the queue is consumed across the
   *     three build phases of one episode. A fresh copy is built per EPISODE, or
   *     the second episode of a cell would play an empty seat and the mean would
   *     be a lie.
   *  2. nothing is invented for a malformed move. An entry without an integer
   *     cell in range, or with a piece that is not a wall or a machine, is
   *     dropped here rather than guessed at, and `moves` on the message says how
   *     many survived so the page can tell the visitor the truth. */
  function normMoves(list) {
    var out = [], i, m, cell, kind;
    if (!list || !list.length) return out;
    for (i = 0; i < list.length; i++) {
      m = list[i];
      if (!m) continue;
      cell = (typeof m.cell === 'number' && isFinite(m.cell)) ? (m.cell | 0) : -1;
      kind = (typeof m.kind === 'number' && isFinite(m.kind)) ? (m.kind | 0) : 0;
      if (cell < 0 || (CELLS && cell >= CELLS)) continue;
      if (kind !== 1 && kind !== 2) continue;
      out.push({ cell: cell, kind: kind });
    }
    return out;
  }

  /* a fresh queue for one episode; core owns the legality of every entry */
  function humanSeat(moves) {
    var q = [], i;
    for (i = 0; i < moves.length; i++) q.push({ cell: moves[i].cell, kind: moves[i].kind });
    return { kind: 'human', queue: q };
  }

  /* the compact layout of D5 8.3: piece * 4 + (owner + 1), one byte per cell.
   * hp rides beside it as raw points, because the renderer draws damage and a
   * grid cell that showed every wall at full health would be a lie. */
  function encode(g) {
    var lay = new Uint8Array(CELLS), hp = new Uint16Array(CELLS);
    var st = g && g.struct, k;
    function put(v, cell) {
      cell = cell | 0;
      if (cell < 0 || cell >= CELLS || !v) return;
      var kind = (typeof v.kind === 'number') ? (v.kind | 0) : 1;
      var own = (typeof v.owner === 'number') ? (v.owner | 0) : -1;
      if (kind < 0) kind = 0; else if (kind > 2) kind = 2;
      if (own < -1) own = -1; else if (own > 2) own = 2;
      lay[cell] = (kind * 4) + (own + 1);
      var h = (typeof v.hp === 'number') ? Math.round(v.hp) : 0;
      hp[cell] = h < 0 ? 0 : (h > 65535 ? 65535 : h);
    }
    if (st && typeof st.forEach === 'function') st.forEach(function (v, cell) { put(v, cell); });
    else if (st) { for (k in st) { if (Object.prototype.hasOwnProperty.call(st, k)) put(st[k], +k); } }
    return { layout: lay, hp: hp };
  }

  function sameBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /* ------------------------------------------------------------- the intents
   *
   * SEAM C4-S1. A gallery play carries the reader's own belief about what its
   * partner is building, ONE distribution per build tick (D5 3.8), and every one
   * of them comes from KeepCore.discriminateBoard: the same encoder, the same
   * trunk and the same head the page's live bars use. There is no second summary
   * and nothing is rescaled, so there is no approximation to disclose.
   *
   * Three decisions are the worker's, because core cannot answer them:
   *
   *  1. WHOSE structures the summary reads. The accommodator reads its PARTNER,
   *     which is the whole of its job, so readSeat is the other chair.
   *  2. WHICH head reads. The seat whose net carries a summary trunk and a
   *     discriminator head, tested structurally and never by the key's name (the
   *     minified pdf-lib lesson: duck typing beats a name check). Seat A first
   *     when both could read, and the message says which one did.
   *  3. WHICH wave. The wave whose build phase the tick belongs to, which is
   *     exact rather than a choice, because the summary's wave one hot is a real
   *     input to the head.
   *
   * How the per tick states are reached without a second rules engine: the play
   * is recorded through the descriptors' own onPlace hook, then core's own
   * replayBuildPhase and runWave walk the SAME episode again teacher forced, and
   * the summary is read off that game after every placement. Nothing here decides
   * a move or resolves a hit. The replay then has to reproduce the play exactly,
   * keep hp and every layout and hp byte; if it does not, the intents are
   * withheld with a reason that says so, because a bar chart drawn from a game
   * that is not the game on screen is the failure this page is about not
   * committing.
   */

  function isReader(ag) {
    return !!(ag && ag.kind === 'net' && ag.net &&
              ag.net.Ws && ag.net.bs && ag.net.Wd && ag.net.bd);
  }

  function readerFor(pair) {
    if (isReader(pair.a)) return { net: pair.a.net, seat: 0, readSeat: 1, key: pair.aKey || null };
    if (isReader(pair.b)) return { net: pair.b.net, seat: 1, readSeat: 0, key: pair.bKey || null };
    return null;
  }

  function canReplay() {
    return !!(CORE && CORE.newGame && CORE.replayBuildPhase && CORE.runWave &&
              CORE.discriminateBoard);
  }

  /* a descriptor of the same agent that also reports its placements. The cached
   * agent object is never mutated: it is shared by every cell that uses that net. */
  function withRecorder(ag, on) {
    var d = { kind: (ag && ag.kind) || 'none', onPlace: on };
    if (ag && ag.net) d.net = ag.net;
    if (ag && ag.extra) d.extra = ag.extra;
    /* SEAM C5-S1: an accommodator seat is dynamic, and core decides that from the net's
     * own shape, so a descriptor that names no extra is seated the same way here as it is
     * on the page. The flag is carried when a caller set one so a deliberate opt out
     * survives the copy rather than being silently undone. */
    if (ag && ag.dynamic !== undefined) d.dynamic = ag.dynamic;
    return d;
  }

  function newRecorder() {
    var rec = { byWave: [[], [], []], n: 0 };
    rec.on = function (pick, side, wave) {
      var w = rec.byWave[wave];
      if (!w || !pick) return;
      w.push([side, pick.cell, pick.kind]);
      rec.n++;
    };
    return rec;
  }

  function intentsFor(res, reader, rec, first) {
    var out = { intents: null, reason: null };
    if (!rec.n) { out.reason = 'no piece was placed in this play'; return out; }
    var g = res && res.g, ep = res && res.ep;
    if (!g || !ep || !ep.budgets) { out.reason = 'the play carried no episode to replay'; return out; }

    var bars = [], waves = [], sides = [], mg = null, curWave = 0;
    function onPlaced(i, side) {
      var d = CORE.discriminateBoard(reader.net, mg, reader.readSeat, curWave);
      var row = [], k;
      for (k = 0; k < d.length; k++) row.push(d[k]);
      bars.push(row);
      waves.push(curWave);
      sides.push(side);
    }
    try {
      mg = CORE.newGame(ep, g.cfg);
      for (curWave = 0; curWave < 3; curWave++) {
        var buds = [Math.max(0, ep.budgets[curWave][0]), Math.max(0, ep.budgets[curWave][1])];
        CORE.replayBuildPhase(mg, null, rec.byWave[curWave], buds, curWave, onPlaced);
        CORE.runWave(mg, curWave);
        if (mg.keepHp <= 0) break;
      }
    } catch (e) {
      out.reason = 'the intent replay threw: ' + String((e && e.message) || e);
      return out;
    }

    /* the gate: this has to be the same game, or the numbers describe nothing */
    var mirror = null;
    try { mirror = encode(mg); } catch (e2) { mirror = null; }
    if (!mirror || !first || mg.keepHp !== g.keepHp ||
        !sameBytes(mirror.layout, first.layout) || !sameBytes(mirror.hp, first.hp)) {
      out.reason = 'the intent replay did not reproduce this game';
      return out;
    }
    if (!bars.length) { out.reason = 'no piece was placed in this play'; return out; }

    var argmax = [], flipTicks = [], i, k, lead;
    for (i = 0; i < bars.length; i++) {
      lead = 0;
      for (k = 1; k < bars[i].length; k++) if (bars[i][k] > bars[i][lead]) lead = k;
      argmax.push(lead);
      if (i > 0 && lead !== argmax[i - 1]) flipTicks.push(i);
    }
    out.intents = {
      bars: bars, argmax: argmax, changes: flipTicks.length, flipTicks: flipTicks,
      waves: waves, sides: sides, ticks: bars.length,
      seat: reader.seat, readSeat: reader.readSeat, net: reader.key
    };
    return out;
  }

  /* --------------------------------------------------------------- the jobs */

  function startJob(m, kind) {
    if (!booted) { die('job', 'a job arrived before init'); return; }
    /* a new job silently replaces whatever was running: the old job posts
     * nothing more, and its seq would have been dropped on arrival anyway */
    job = {
      kind: kind,
      jobId: m.jobId,
      seq: m.seq,
      seed: (m.seed >>> 0) || 0,
      rows: m.rows || [],
      cols: m.cols || [],
      list: m.list || [],
      moves: normMoves(m.moves),
      episodes: Math.max(1, Math.min(64, (m.episodes | 0) || 1)),
      total: 0,
      ci: 0,
      played: 0,
      e: 0,
      sum: 0,
      first: null,
      firstHp: null,
      miss: 0,
      bad: false,
      cancelled: false
    };
    job.total = (kind === 'grid') ? (job.rows.length * job.cols.length)
              : (kind === 'row') ? job.cols.length
              : job.list.length;
    counters.jobs++;
    if (!job.total) {
      post({ type: 'done', jobId: job.jobId, seq: job.seq, kind: kind, cells: 0 });
      job = null;
      return;
    }
    arm();
  }

  function arm() {
    if (pumpArmed || !job) return;
    pumpArmed = true;
    /* Law 3: setTimeout(0), never a loop on a flag. This is the ONLY thing that
     * lets a cancel message reach this worker before the whole job is over. */
    G.setTimeout(pump, 0);
  }

  function pump() {
    pumpArmed = false;
    if (!job || job.cancelled) return;
    var t0 = now();
    /* at least one episode, and only more if a slice budget was asked for */
    do {
      if (!stepEpisode()) return;
    } while (job && !job.cancelled && SLICE > 0 && (now() - t0) < SLICE);
    if (job && !job.cancelled) arm();
  }

  /* ONE episode. Returns false when the job is over or dead. */
  function stepEpisode() {
    var j = job;
    var pair = pairFor(j);
    if (!pair) { finish(j); return false; }

    if (j.e === 0) {
      j.sum = 0; j.first = null; j.firstHp = null; j.bad = false; j.miss = pair.miss;
      j.intents = null; j.intentsReason = null;
    }

    /* the gallery reads the accommodator's belief off the FIRST episode, the one
     * whose board the cell shows, so the bars and the picture are one game */
    var reader = null, rec = null, agA = pair.a, agB = pair.b;
    /* the gallery only. A row square's seat A is the visitor, so there is no
     * reader pairing to describe and the replay would be cost with nothing to
     * say; a grid square carries no reader head at all. */
    if (j.kind === 'plays' && j.e === 0) {
      reader = readerFor(pair);
      if (!reader) j.intentsReason = 'this model file carries no accommodator head for this pair';
      else if (!canReplay()) j.intentsReason = 'this core carries no discriminateBoard';
      else {
        rec = newRecorder();
        agA = withRecorder(pair.a, rec.on);
        agB = withRecorder(pair.b, rec.on);
      }
    }

    var res = null;
    try {
      res = CORE.playEpisode({ seed: (pair.seed + j.e) >>> 0, a: agA, b: agB });
    } catch (e) { res = null; }
    counters.episodes++;

    if (!res || !isFinite(res.score)) j.bad = true;
    else {
      j.sum += res.score;
      if (j.e === 0) {
        /* the keep hp of the game whose board the cell SHOWS. score is the mean
         * over the cell's episodes, and at more than one episode the two are
         * different numbers: a tint or a label drawn on this picture has to read
         * the picture's own game. */
        j.firstHp = res.score;
        try { j.first = encode(res.g); } catch (e2) { j.first = null; }
        if (rec) {
          if (!j.first) j.intentsReason = 'the play produced no board to read';
          else {
            var got = intentsFor(res, reader, rec, j.first);
            j.intents = got.intents;
            j.intentsReason = got.reason;
          }
        }
      }
    }

    j.e++;
    if (j.e >= j.episodes) {
      emit(j, pair);
      if (!j.bad && j.first) j.played++;
      j.ci++;
      j.e = 0;
      counters.cells++;
    }
    if (j.ci >= j.total) { finish(j); return false; }
    return true;
  }

  function pairFor(j) {
    if (j.ci >= j.total) return null;
    if (j.kind === 'grid') {
      var nc = j.cols.length;
      var i = (j.ci / nc) | 0, jj = j.ci % nc;
      var ra = agentFor(j.rows[i]), rb = agentFor(j.cols[jj]);
      return { i: i, j: jj, k: j.ci, seed: j.seed,
               a: ra.agent, b: rb.agent, aKey: j.rows[i], bKey: j.cols[jj],
               miss: (ra.ok ? 0 : 1) | (rb.ok ? 0 : 2) };
    }
    if (j.kind === 'row') {
      /* seat A is the visitor, so it can never be a missing net: bit 1 says the
       * visitor sent no move, which is a true thing about the row and not a
       * missing engineer */
      var rc = agentFor(j.cols[j.ci]);
      return { i: 0, j: j.ci, k: j.ci, seed: j.seed,
               a: humanSeat(j.moves), b: rc.agent,
               aKey: 'you', bKey: j.cols[j.ci],
               miss: (j.moves.length ? 0 : 1) | (rc.ok ? 0 : 2) };
    }
    var it = j.list[j.ci] || {};
    var pa = agentFor(it.a), pb = agentFor(it.b);
    return { i: 0, j: 0, k: j.ci,
             seed: (it.seed === undefined ? j.seed : (it.seed >>> 0)),
             a: pa.agent, b: pb.agent, aKey: it.a || null, bKey: it.b || null,
             miss: (pa.ok ? 0 : 1) | (pb.ok ? 0 : 2) };
  }

  var MSG_OF = { grid: 'cell', plays: 'play', row: 'rowcell' };

  function emit(j, pair) {
    var ok = !j.bad && !!j.first;
    var msg = {
      type: MSG_OF[j.kind] || 'cell',
      jobId: j.jobId, seq: j.seq,
      i: pair.i, j: pair.j, k: pair.k,
      score: ok ? (j.sum / j.episodes) : null,
      /* the picture's own game, so a tint or a number drawn on this thumbnail is
       * about the board beside it (spec v3 s7.15 ruling 4) */
      keepHp: ok ? j.firstHp : null,
      episodes: j.episodes,
      /* the progress the page paints: it is told, never counted, so a dropped or
       * a stale message cannot move a counter that says how many games ran.
       * `done` is cells FINISHED, which is what "playing 12 of 64" means, and
       * `played` is cells that really produced a game, which is what "12 of 64
       * games played" means. They are different numbers when a net is missing or
       * a game throws, and a caption that used the wrong one would be a claim
       * about games nobody played. */
      done: j.ci + 1,
      played: j.played + (ok ? 1 : 0),
      total: j.total,
      ok: ok,
      miss: pair.miss,
      layout: ok ? j.first.layout : null,
      hp: ok ? j.first.hp : null
    };
    if (j.kind === 'row') msg.moves = j.moves.length;
    /* intents ride the gallery message, one raw softmax per build tick, straight
     * out of KeepCore.discriminateBoard (SEAM C4-S1). When they cannot be produced
     * the field is null and the reason is the true one. Nothing is invented. */
    if (j.kind === 'plays') {
      msg.intents = ok ? (j.intents || null) : null;
      msg.intentsReason = msg.intents ? null
        : (ok ? (j.intentsReason || 'the play produced no board to read')
              : 'the game did not finish');
    }
    post(msg, ok ? [msg.layout.buffer, msg.hp.buffer] : []);
  }

  function finish(j) {
    if (!j || j.cancelled) return;
    post({ type: 'done', jobId: j.jobId, seq: j.seq, kind: j.kind,
           cells: j.ci, played: j.played, total: j.total });
    if (job === j) job = null;
  }

  function cancel(m) {
    if (!job) return;
    if (m && m.jobId !== undefined && m.jobId !== null && m.jobId !== job.jobId) return;
    job.cancelled = true;
    job = null;
  }

  /* --------------------------------------------------------------- messages */

  G.onmessage = function (e) {
    var m = (e && e.data) || {};
    try {
      switch (m.type) {
        case 'init': handleInit(m); break;
        case 'grid': startJob(m, 'grid'); break;
        case 'plays': startJob(m, 'plays'); break;
        case 'row': startJob(m, 'row'); break;
        case 'cancel': cancel(m); break;
        case 'ping':
          post({ type: 'pong', busy: !!job, booted: booted,
                 jobId: job ? job.jobId : null, seq: job ? job.seq : null,
                 kind: job ? job.kind : null,
                 done: job ? job.ci : 0, total: job ? job.total : 0,
                 counters: { episodes: counters.episodes, cells: counters.cells,
                             jobs: counters.jobs, errors: counters.errors } });
          break;
        default: break;   /* an unknown message is ignored, never fatal */
      }
    } catch (err) {
      /* Law 2 again: an uncaught throw here would reach the page as onerror,
       * which is the path that lies about what happened. */
      die(m && m.type ? String(m.type) : 'message', err);
    }
  };

  /* the page hears about a throw that escapes anyway, and hears it as a normal
   * message too, so both ends of the ladder agree */
  G.onerror = function (msg) {
    counters.errors++;
    try { post({ type: 'error', phase: 'onerror', message: String((msg && msg.message) || msg) }); }
    catch (e) {}
  };

  /* the node protocol suite drives this file against a stub self */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      counters: counters,
      state: function () { return { booted: booted, cells: CELLS, job: job, slice: SLICE }; }
    };
  }

}(typeof self !== 'undefined' ? self : globalThis));
