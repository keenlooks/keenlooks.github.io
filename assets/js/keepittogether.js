/* ==========================================================================
   keepittogether.js - the page runtime for /keepittogether/ (Keep It Together)
   --------------------------------------------------------------------------
   Owns: the acts state machine, layout, pointer and keyboard input, the
   presentation record (fx) handed to the renderer, the sound triggers, the
   share hash, the walkthrough shell and the worker plumbing.

   Owns nothing about the rules (keepittogether-core.js), the pixels
   (keepittogether-render.js), the weights (keepittogether-model.js) or the
   synthesis (keepittogether-audio.js). Every one of those is feature
   detected: a missing or half built module leaves the page honest and quiet
   rather than throwing, because one throw inside a rAF loop kills the page
   permanently.

   Two adapters live here and nowhere else, because the page is the only
   place that holds both sides: core's game object becomes the renderer's
   read only state, and the page's own event log becomes the renderer's fx
   record. Neither ever writes back into the game.

   Test hook: window.__kit (see _tests/twoengineers/INTERFACES.md, section P).
   ========================================================================== */
(function () {
  'use strict';

  var app = document.querySelector('.kit-app');
  if (!app) return;

  /* ----------------------------------------------------------------- modules */

  var GLOB = (typeof self !== 'undefined') ? self : window;
  var Core = GLOB.KeepCore || null;
  var MODEL = GLOB.KIT_MODEL || null;
  var Audio = window.KeepAudio || null;
  var RAPI = window.KeepRender || null;
  var R = null;
  try { if (RAPI && RAPI.create) R = RAPI.create({}); } catch (e) { R = null; }

  var model = null, modelErr = '';
  if (Core && MODEL && Core.loadModel) {
    try { model = Core.loadModel(MODEL); }
    catch (e) { model = null; modelErr = (e && e.message) ? String(e.message) : 'load failed'; }
  }

  /* ------------------------------------------------------- the verify state
     D5 section 5 gives this page one job here: never let the page claim a
     model is verified when it is not, and say the untrained case out loud.
     The branch order is pinned (SEAM F-S1b): an untrained or placeholder
     export FIRST, then the test mock, then the recorded-game check. It has
     to be that order, because the shipped placeholder's recorded episode
     REPLAYS perfectly (it is a real recording of a real game) and the check
     would print "verified" over weights that are every one a random draw.

     VERIFY.plate non-empty is the loud state: a plate on the canvas above
     the caption strip, the same sentence in the panel and through the live
     status mirror, and "unverified:" in front of every act caption. */
  var MSG_UNTRAINED = 'This page is running an untrained placeholder model.';
  var MSG_MOCK = 'This page is running stand-in weights, not the trained engineers.';
  var MSG_OK = 'Model verified: your browser replayed a recorded game and matched it move for move.';

  var VERIFY = classifyModel();

  /* Metadata only, so it costs nothing and holds from the first frame.
     The two loud claims are made BEFORE the loader is consulted on purpose:
     a stand-in whose tensors core refused is still a stand-in, and the
     visitor has to be told which one it is. A model file carrying no meta at
     all takes the untrained branch too, because the safe direction for a
     page whose whole point is an honesty claim is to under-claim. */
  function classifyModel() {
    var meta = (MODEL && MODEL.meta) || null;
    if (MODEL && (!meta || meta.placeholder === true || !meta.trained)) {
      return { kind: 'placeholder', line: MSG_UNTRAINED, plate: MSG_UNTRAINED };
    }
    if (meta && meta.mock) return { kind: 'mock', line: MSG_MOCK, plate: MSG_MOCK };
    if (!MODEL || !model) return { kind: 'missing', line: '', plate: '' };
    return { kind: 'pending', line: '', plate: '' };
  }

  var RC = (RAPI && RAPI.CONST) || null;
  var COLS = RC ? RC.COLS : 28, ROWS = RC ? RC.ROWS : 19;
  var CELLS = COLS * ROWS;
  var WAVES = 3;

  function cfgNum(name, dflt) {
    var c = (Core && Core.CFG) || null;
    var v = c ? c[name] : undefined;
    return (typeof v === 'number' && isFinite(v)) ? v : dflt;
  }
  var COST_WALL = cfgNum('wall_cost', 2);
  var COST_GUN = cfgNum('turret_cost', 10);
  /* s7.22 ruling 7: the price of the CHEAPEST piece, which is the number the
     budget caption turns on. A wall is 2 and a catapult is 10, so today this
     is the wall's price, but the clause is about "nothing left that can be
     built" and reading it off the two costs is what makes that true if either
     number ever moves in the export's own config. */
  function cheapestCost() { return Math.min(COST_WALL, COST_GUN); }
  var HP_KEEP = cfgNum('keep_hp', 100);
  var HP_WALL = cfgNum('wall_hp', 400);
  var HP_GUN = cfgNum('turret_hp', 400);
  var PIECE_WALL = 1, PIECE_GUN = 2;

  /* The machine winds up BEFORE it throws, so the shot record carries the
     wind-up and the flight and the renderer hangs its whole cycle off them.
     The three sounds ride the same clock, which is why what you hear lands
     with what you see. */
  var WIND_MS = 470;
  var FLIGHT = (RC && RC.FLIGHT) || 520;

  function cx(cell) { return cell % COLS; }
  function cy(cell) { return (cell / COLS) | 0; }
  function cellOf(x, y) { return y * COLS + x; }

  /* ------------------------------------------------------------------ theme */

  function effectiveTheme() {
    var f = document.documentElement.getAttribute('data-theme');
    if (f === 'light' || f === 'dark') return f;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)
      ? 'light' : 'dark';
  }
  function isLight() { return effectiveTheme() === 'light'; }
  function reducedMotion() {
    return !!(window.matchMedia &&
              window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function ink(a) { return isLight() ? 'rgba(38,38,38,' + a + ')' : 'rgba(214,214,214,' + a + ')'; }
  function plateCol(a) { return isLight() ? 'rgba(255,255,255,' + a + ')' : 'rgba(18,18,18,' + a + ')'; }
  function accent() { return isLight() ? '#34568a' : '#82a6cc'; }

  /* --------------------------------------------------------------- elements */

  var cv = document.getElementById('kit-canvas');
  var ctx = cv ? cv.getContext('2d') : null;
  var panel = document.getElementById('kit-panel');
  var statusEl = document.getElementById('kit-status');
  var statusSr = document.getElementById('kit-status-sr');
  var srGrid = document.getElementById('kit-sr-grid');
  var verifyEl = document.getElementById('kit-verify');
  var actbar = null, actbarSound = null;

  function byId(id) { return document.getElementById(id); }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  /* ---------------------------------------------------- the status line queue
     Build spec v3 s7.15 ruling 2. The ship-gate auditor counted 535 status
     changes in a three minute session with a MEDIAN LIFETIME OF 36 ms, every
     one a hard swap at full brightness: the walkthrough's own step text was
     buried 18 ms after it appeared, "You cannot build there." lived 140 ms,
     and the wave outcome lived 484 ms. So the line is a QUEUE with a minimum
     dwell, and there are three kinds of write:

       setStatus(text)                a sentence. It waits its turn and then
                                      holds the line for DWELL.
       setStatus(text, {force:true})  a sentence a USER ACTION just caused. It
                                      takes the line at once and drops whatever
                                      was waiting, because an answer to a click
                                      that arrives 1.5 s late is worse than no
                                      answer.
       setStatus(text, {progress:1})  a counter. It never displaces a sentence,
                                      it never queues behind another counter
                                      (the newest wins), and it repaints at
                                      most every PROG_MS.

     `sr` carries a longer form for the screen reader mirror when the visible
     slot is only two lines. `raw` is the loud plate's own announcement, which
     must not be prefixed with the loud plate. */
  /* s7.24 ruling 9: the progress counter GOES THROUGH THE DWELL QUEUE. It was
     the one line in the round 4 audit that changed at full brightness faster
     than a reader could take it in (273 ms), and it was a nit in round 3 too.
     PROG_MS is kept as the name of the counter's own hold and is now the same
     1.5 s every other sentence gets; the FIRST counter of a run still takes
     the line at once, because a user action caused it. */
  var DWELL = 1500, PROG_MS = 1500;
  var stQ = [], stProg = null, stAt = -1e9, stKind = 'msg', stTimer = 0;

  var stLog = [];

  function statusPaint(m) {
    var pre = (!m.raw && VERIFY.plate) ? 'unverified: ' : '';
    stAt = now();
    stKind = m.progress ? 'progress' : 'msg';
    stLog.push({ t: stAt, text: pre + m.text, kind: stKind, forced: !!m.forced });
    if (stLog.length > 400) stLog.shift();
    if (statusEl) statusEl.textContent = pre + m.text;
    if (statusSr) statusSr.textContent = pre + (m.sr || m.text);
    /* the phone caption card carries the same line the panel does (s7.17
       ruling 2), written by the same writer so the two can never disagree */
    if (capcardStatus) {
      capcardStatus.textContent = pre + m.text;
      /* a longer sentence takes room from the prose under it, so the card is
         re-cut to whole sentences for the room that is left (s7.24 ruling 4).
         It rebuilds from the panel's own prose, so a shorter line gives the
         dropped sentences back. */
      syncCapcardText();
    }
  }

  function statusHold() {
    return Math.max(0, (stKind === 'progress' ? PROG_MS : DWELL) - (now() - stAt));
  }

  function statusPump() {
    stTimer = 0;
    var wait = statusHold();
    if (wait > 0) {
      if (stQ.length || stProg) stTimer = setTimeout(statusPump, wait + 12);
      return;
    }
    if (stQ.length) statusPaint(stQ.shift());
    else if (stProg) { statusPaint(stProg); stProg = null; }
    else return;
    if (stQ.length || stProg) stTimer = setTimeout(statusPump, statusHold() + 12);
  }

  /* every ACCEPTED call, so setAct can tell whether the act it just started
     wrote its own line (s7.21 ruling 10: one status write per act press) */
  var stCalls = 0;

  function setStatus(txt, opts) {
    if (txt === undefined || txt === null) return;
    stCalls++;
    if (opts === true) opts = { raw: true };
    opts = opts || {};
    var m = { text: String(txt), sr: opts.sr || null,
              raw: !!opts.raw, progress: !!opts.progress };
    if (m.progress && opts.force) {
      /* the counter a user action started: it takes the line at once and the
         next counter may follow it after the SHORT hold, so the grid is seen
         to fill from the first cell rather than 1.5 s after it */
      stQ.length = 0; stProg = null;
      m.forced = true;
      statusPaint(m);
      if (stTimer) { clearTimeout(stTimer); stTimer = 0; }
      return;
    }
    if (m.progress) { stProg = m; }
    else if (opts.force) {
      stQ.length = 0; stProg = null;
      m.forced = true;
      statusPaint(m);
      if (stTimer) { clearTimeout(stTimer); stTimer = 0; }
      return;
    } else {
      /* an identical sentence already on the line or already waiting is not a
         second event, and repeating it would only restart its dwell */
      if (stQ.length && stQ[stQ.length - 1].text === m.text) return;
      if (!stQ.length && stKind === 'msg' && statusEl &&
          statusEl.textContent === (((!m.raw && VERIFY.plate) ? 'unverified: ' : '') + m.text)) return;
      if (stQ.length > 4) stQ.splice(0, stQ.length - 4);
      /* a sentence supersedes a pending counter: without this the last
         "playing N of M" repaints itself over the summary that follows it */
      stProg = null;
      stQ.push(m);
    }
    if (!stTimer) statusPump();
  }

  /* the line as a visitor really sees it, for the suites */
  function statusNow() { return statusEl ? statusEl.textContent : ''; }

  /* ------------------------------------------------------------- page state */

  var ACTS = ['watch', 'plans', 'strangers', 'reader', 'you', 'fine'];
  var ACT_NAME = {
    watch: 'Watch a wave', plans: 'Six plans', strangers: 'Strangers',
    reader: 'Reading the plan', you: 'Your turn', fine: 'Fine print'
  };

  var act = {
    name: 'watch', sub: 'idle', seq: 1,
    seed: ((Date.now() >>> 0) % 90000) + 1,
    pool: 'sp', bonusOnly: false, partner: 'sp', partnerN: 0,
    /* Build spec v3 s7.15 ruling 3: the picker must visibly change the act it
       is standing in. In Reading the plan the reader's seat is fixed (it is
       the reader) and the seat that MOVES is the one being read, so the picker
       owns that one there and its own selection is kept apart from the your
       turn partner. Two lanes switched partner in the reader act and watched
       the board, the bars and the score all stay exactly where they were. */
    readKey: 'spec', readN: -1
  };

  /* ------------------------------------------------------------ the numbers
     D4 section 2: every number the copy quotes is a {N} placeholder read from
     the model's own meta. An empty meta prints the placeholder WORDING and
     never a number, which is the whole point of the rule: the page cannot
     quote a measurement nobody made. LIVE numbers (keep health from a game
     this browser just played) are not placeholders and are not read here. */
  function metaOf(a, b) {
    var m = (MODEL && MODEL.meta) || null, v;
    if (!m) return null;
    v = m[a];
    if (v === undefined || v === null) return null;
    if (b === undefined) return v;
    if (typeof v !== 'object') return null;
    v = v[b];
    return (v === undefined || v === null) ? null : v;
  }
  function metaNum(a, b) {
    var v = metaOf(a, b);
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }

  /* The six plan names are a BUILD token: they are written by a person after
     training, by looking at what each hidden number actually builds. Until the
     trained export carries them, the plans are numbered and the act says so.
     Naming an untrained draw "The funnel" would be a claim about behaviour
     nobody has seen. */
  var PLAN_FALLBACK = ['Plan 1', 'Plan 2', 'Plan 3', 'Plan 4', 'Plan 5', 'Plan 6'];
  function planNames() {
    var got = metaOf('planNames'), out = [], i;
    if (got && got.length) {
      for (i = 0; i < 6; i++) {
        out.push(got[i] && got[i].short ? String(got[i].short) : PLAN_FALLBACK[i]);
      }
      return out;
    }
    return PLAN_FALLBACK.slice();
  }
  function planLongs() {
    var got = metaOf('planNames'), out = [], i;
    for (i = 0; i < 6; i++) {
      out.push({
        name: (got && got[i] && got[i].name) ? String(got[i].name) : PLAN_FALLBACK[i],
        line: (got && got[i] && got[i].line) ? String(got[i].line) : ''
      });
    }
    return out;
  }
  function haveNames() { var g = metaOf('planNames'); return !!(g && g.length); }

  /* ---- what the export MEASURED, and the sentences that quote it ----------
     Build spec v3 section 7.11 ruling 1. Every sentence on this page about the
     styles, the keeps and the reader is a TEMPLATE over the model file's own
     meta block, with an honest branch for every case an export can carry. The
     page never states a result the file does not carry, and it never prints
     the no-measurement wording on a file that does carry one. */

  var NUMWORD = ['none', 'one', 'two', 'three', 'four', 'five', 'six'];
  function numWord(n) { return (n >= 0 && n <= 6) ? NUMWORD[n] : String(n); }
  function capFirst(s) { return s ? (s.charAt(0).toUpperCase() + s.slice(1)) : s; }
  function fmtInt(n) {
    var s = String(Math.round(Math.abs(n))), out = '', i, c = 0;
    for (i = s.length - 1; i >= 0; i--) {
      out = s.charAt(i) + out;
      if ((++c % 3) === 0 && i > 0) out = ',' + out;
    }
    return out;
  }
  /* one decimal, always. An exact 86 printed as "86" beside "2.3" and "27.1" reads as a
     different kind of number, and every one of these is a measured mean (v3 s7.12 ruling
     6). The value is not changed, only its evenness. */
  function fmt1(n) {
    var v = Math.round(n * 10) / 10;
    return isFinite(v) ? v.toFixed(1) : String(v);
  }

  /* how many of the six intents the gate could tell apart, or null when the
     file carries no such measurement */
  function distinctStyles() {
    var n = metaNum('g0', 'distinctStyles');
    if (n === null) return null;
    n = Math.round(n);
    return (n < 0 || n > 6) ? null : n;
  }
  /* the per plan flag the export writes beside each name, or null when the
     names carry no flags at all */
  function planDistinct() {
    var got = metaOf('planNames'), out = [], i, seen = false, d;
    if (!got || !got.length) return null;
    for (i = 0; i < 6; i++) {
      d = got[i] ? got[i].distinct : undefined;
      if (d === true || d === false) seen = true;
      out.push(d === true);
    }
    return seen ? out : null;
  }

  /* ---- the pinned middle clause, COMPUTED ---------------------------------
     Build spec v3 s7.12 ruling 2 pins "and every one of the four still holds
     the keep" into the styles sentence, and s7.15 ruling 8 says it is carried
     ONLY when every distinct intent's keep HP clears meta.g0.bar085. It is
     never typed: this reads the export's own per intent keep health, checks
     each distinct one against the re-ruled bar, and returns '' when the file
     cannot support the claim (including when it carries no such numbers). */
  function distinctIntents() {
    var got = metaOf('g0', 'distinctIntents'), out = [], i, v;
    if (got && got.length) {
      for (i = 0; i < got.length; i++) {
        v = Math.round(got[i]);
        if (isFinite(v) && v >= 0 && v < 6) out.push(v);
      }
      return out.length ? out : null;
    }
    /* an export that flags the plans instead of listing the intents */
    var d = planDistinct();
    if (!d) return null;
    for (i = 0; i < 6; i++) if (d[i]) out.push(i);
    return out.length ? out : null;
  }

  function allDistinctHold() {
    var idx = distinctIntents(), hp = metaOf('g0', 'perIntentKeepHp');
    var bar = metaNum('g0', 'bar085') !== null ? metaNum('g0', 'bar085')
                                               : num2(metaOf('g0', 'bar085'), 'value');
    var i, v;
    if (!idx || !hp || !hp.length || bar === null || !isFinite(bar)) return false;
    for (i = 0; i < idx.length; i++) {
      v = hp[idx[i]];
      if (typeof v !== 'number' || !isFinite(v) || v < bar) return false;
    }
    return true;
  }

  /* Act 2's one claim about the six. The count is meta's; the wording is the
     only thing this page adds. */
  /* `opts.noHold` drops the G0 probe's own holds clause. The screen-reader
     table lists the SIX GAMES THIS BROWSER JUST PLAYED, and the light lane read
     "all four still held the keep" directly above rows of 0 and 8 as a
     contradiction (s7.24 ruling 10). Both numbers are true and they are
     different quantities, so the table says only the one it lists. */
  /* s7.32 addendum 2: meta.g0 measured the net its own rung names (the
     specializer's run). The diversity-only control is quoted from it only if
     that run IS the control's; otherwise the page says the export carries no
     such measurement for it. */
  function divStylesSentence(opts) {
    var rung = String(metaOf('g0', 'rung') || ''), run = String(metaOf('source', 'specDiv') || '').split(' ')[0];
    if (run && rung.indexOf(run) === 0) return stylesSentence(opts);
    return 'This build does not measure how far apart these six come out.';
  }
  function stylesSentence(opts) {
    var d = distinctStyles(), hold;
    var noHold = !!(opts && opts.noHold);
    if (d === null) {
      return 'How many of the six can be told apart is not measured in this ' +
             'build, so this page does not say.';
    }
    /* s7.19 ruling 5: the holds clause is SCOPED to the test that produced it.
       A judge read "every one of the four still holds the keep" directly above
       live tiles reading 32, 40 and 28 of 100 and called it a contradiction.
       Both numbers are true and they are different quantities: the clause is
       the G0 probe's own measurement, the tiles are six games this browser
       just played. Saying which is which costs six words. */
    hold = (allDistinctHold() && !noHold)
      ? (', and in the test that scored them all ' + numWord(d) + ' still held the keep') : '';
    if (d === 6) {
      return 'All six of its intents became styles you can tell apart' +
             ((allDistinctHold() && !noHold)
               ? ', and in the test that scored them all six still held the keep.' : '.');
    }
    if (d === 0) {
      return 'None of its six intents came out as a style you can tell apart ' +
             'from the others: they converge on the same plan.';
    }
    return capFirst(numWord(d)) + ' of its six intents became ' +
      (d === 1 ? 'a style' : 'styles') + ' you can tell apart' + hold + '; the other ' +
      numWord(6 - d) + ((6 - d) === 1 ? ' converges' : ' converge') +
      ' on the same plan.';
  }

  /* Which plan a converged plan looks like, measured on the six boards this
     browser just played, with the gate's own arithmetic: the share of the
     credits a layout spends on each (tile, piece), compared as total
     variation. meta says WHICH plans converge; this says which plan on screen
     each of them is nearest to, so a mark on a card is about the pictures
     beside it and not about a number nobody can see. */
  function planSig(st) {
    var sig = {}, tot = 0, k, p, c;
    if (!st || !st.piece) return null;
    for (k = 0; k < st.piece.length; k++) {
      p = st.piece[k];
      if (p !== PIECE_WALL && p !== PIECE_GUN) continue;
      c = (p === PIECE_GUN) ? COST_GUN : COST_WALL;
      sig[k * 2 + (p === PIECE_GUN ? 1 : 0)] = c;
      tot += c;
    }
    return tot > 0 ? { sig: sig, tot: tot } : null;
  }
  function tvDist(a, b) {
    var keys = {}, k, s = 0;
    for (k in a.sig) keys[k] = 1;
    for (k in b.sig) keys[k] = 1;
    for (k in keys) {
      s += Math.abs(((a.sig[k] || 0) / a.tot) - ((b.sig[k] || 0) / b.tot));
    }
    return s / 2;
  }
  var lastNear = null;         /* the newest measured map, for the picker */
  /* s7.25 ruling 2 (2026-09-12): ONE RELATION, AND IT IS SYMMETRIC.
     This was a nearest neighbour, which is not a symmetric relation: the
     round-4 critic read plan 1 tagged as converging with plan 5 while plan 6's
     own tag named plan 1, and i1p/names.js measured two such pairs in every
     gallery it read, in both themes. A visitor cannot hold that: "converges
     with" is a word about a pair.

     It is now a MATCHING, taken greedily from the closest pair outwards over
     the same style distance the page already used (`tvDist` over `planSig`),
     so i names j exactly when j names i. It is computed ONCE from the six
     games the export's own specializer just played and kept in `lastNear`, so
     the gallery tags, the picker tags and the screen-reader table are reading
     the same relation rather than three answers to the same question.
     Ties break on the lower index so two runs of the same six layouts give the
     same pairs. A plan that could not be played is left out of the matching
     and names nobody, which is the one honest way to be odd one out. */
  function convergeMap(cells) {
    var sigs = [], out = [null, null, null, null, null, null];
    var i, j, pairs = [], used = [false, false, false, false, false, false], k, p;
    for (i = 0; i < 6; i++) sigs.push(cells[i] ? planSig(cells[i].st) : null);
    for (i = 0; i < 6; i++) {
      if (!sigs[i]) continue;
      for (j = i + 1; j < 6; j++) {
        if (!sigs[j]) continue;
        pairs.push({ a: i, b: j, d: tvDist(sigs[i], sigs[j]) });
      }
    }
    pairs.sort(function (x, y) {
      return (x.d - y.d) || (x.a - y.a) || (x.b - y.b);
    });
    for (k = 0; k < pairs.length; k++) {
      p = pairs[k];
      if (used[p.a] || used[p.b]) continue;
      used[p.a] = true; used[p.b] = true;
      out[p.a] = { near: p.b, dist: p.d };
      out[p.b] = { near: p.a, dist: p.d };
    }
    return out;
  }
  /* ---- the reader's measured claim ---------------------------------------
     meta.zsc is the zero-shot metric of build spec v3 section 7.11 ruling 3
     and wins whenever an export carries it; meta.g1 is the sloppy-partner
     gate. The SENTENCE is chosen by the sign of the measured gap and not by
     the bar, because "it came in behind", "it came in ahead but short of the
     bar" and "it cleared the bar" are three different true sentences and only
     one of them can be printed on a given file. */
  function readerGap() {
    var out = null, ctl;
    if (metaNum('zsc', 'gap') !== null) {
      out = { src: 'zsc', gap: metaNum('zsc', 'gap'), bar: metaNum('zsc', 'bar'),
              n: metaNum('zsc', 'partners'), above: metaNum('zsc', 'above'),
              acc: metaNum('zsc', 'accommodator'), sp: metaNum('zsc', 'selfPlay'),
              ctl: null };
    } else if (metaNum('g1', 'gap') !== null) {
      ctl = metaOf('g1', 'controls');
      out = { src: 'g1', gap: metaNum('g1', 'gap'), bar: metaNum('g1', 'bar'),
              n: metaNum('g1', 'engineers'), above: metaNum('g1', 'helped'),
              acc: metaNum('g1', 'accommodator'), sp: metaNum('g1', 'selfPlay'),
              ctl: (ctl && typeof ctl === 'object') ? ctl : null };
    }
    return out;
  }

  function num2(o, a, b) {
    var v = (o && typeof o === 'object') ? o[a] : null;
    if (b !== undefined) v = (v && typeof v === 'object') ? v[b] : null;
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }

  /* the short form for the reader act, and the long form for the fine print */
  function readerSentence(long) {
    var g = readerGap(), part, none, cross, twin;
    if (!g) {
      return long
        ? ('The gap between the two partners is measured when the cast is exported, ' +
           'and this build carries no such measurement. Any one game you play is one ' +
           'game, and one game is noisy.')
        : '';
    }
    part = (g.src === 'zsc')
      ? ('the ' + (g.n !== null ? (fmtInt(g.n) + ' ') : '') + 'engineers it had never trained with')
      : (g.n !== null ? (fmtInt(g.n) + ' scripted partners that build sloppily on purpose')
                      : 'scripted partners that build sloppily on purpose');
    if (g.gap > 0) {
      if (!long) {
        return 'In our test the reader held the keep an average of ' + fmt1(g.gap) +
               ' points ahead of a plain engineer with the same partner, over ' +
               part + '.' +
               ((g.bar !== null && g.gap < g.bar)
                 ? (' That is short of the ' + fmt1(g.bar) + ' points the test asked for.')
                 : '');
      }
      return 'Across ' + part + ', the reader ends an average of ' + fmt1(g.gap) +
             ' points of keep health ahead of the self-play engineer' +
             ((g.acc !== null && g.sp !== null)
               ? (' (' + fmt1(g.acc) + ' against ' + fmt1(g.sp) + ')') : '') + '.' +
             ((g.bar !== null && g.gap < g.bar)
               ? (' The bar it was held to was ' + fmt1(g.bar) + ' points, so it did ' +
                  'not clear its own gate.') : '') +
             ' Any one game you play is one game, and one game is noisy.';
    }
    if (!long) {
      return 'In our test the reader did not hold the keep better than a plain ' +
             'engineer did with a stranger. The bars below are still its real output.';
    }
    none = num2(g.ctl, 'partnerBuildsNothing', 'acc');
    cross = num2(g.ctl, 'castCrossedPairs');
    twin = num2(g.ctl, 'castMatchedPairs');
    return 'Across ' + part + ', the reader ended an average of ' + fmt1(-g.gap) +
           ' points of keep health behind the self-play engineer' +
           ((g.acc !== null && g.sp !== null)
             ? (' (' + fmt1(g.acc) + ' against ' + fmt1(g.sp) + ')') : '') +
           ', so this build has no evidence that reading the partner helped there.' +
           ((none !== null || cross !== null || twin !== null)
             ? (' Both partner types sit near the floor of this map: ' +
                (none !== null ? ('about ' + fmt1(none) + ' points with a partner that ' +
                                  'builds nothing at all') : '') +
                (cross !== null ? ((none !== null ? ', ' : 'about ') + fmt1(cross) +
                                   ' with another trained engineer') : '') +
                (twin !== null ? ((none !== null || cross !== null ? ', and ' : 'about ') +
                                  fmt1(twin) + ' with a copy of themselves') : '') + '.')
             : '') +
           ' Any one game you play is one game, and one game is noisy.';
  }

  /* the mark under a card, and the same words in the picker */
  /* s7.19 ruling 5: the relation PRINTS SYMMETRICALLY, or it names which plan
     of the pair was kept. The nearest-neighbour relation is not symmetric by
     construction (near = [4,3,0,5,0,3], distinct = [F,T,T,T,T,F]), so plan 0
     said "converges with Centre mouth guns" while Centre mouth guns was itself
     marked distinct, and a judge read it three times trying to work out what
     they were missing. When the other plan of the pair is one the test KEPT,
     the tag says so; when both converged, it is a plain pair. */
  function convergeTag(i, near, shorts, dist) {
    return convergeTagForms(i, near, shorts, dist)[0];
  }

  /* s7.21 ruling 5: the converge caption FITS ITS TILE at every width.
     "converges with Centre shelf, which the test kept" began off the left of
     a 390 px phone and was clipped again at the card's right edge, and an
     ellipsis is not a fix for a caption whose whole job is to name a plan. So
     the tag has FORMS, longest first, and the tile takes the longest that
     fits. Every form keeps the two things the sentence has to carry: which
     plan this one converges with, and, when the pair is asymmetric, that the
     test kept the OTHER one (s7.19 ruling 5). */
  /* s7.25 ruling 2 (2026-09-12): THE ASYMMETRIC BRANCH IS DELETED. s7.19
     ruling 5 gave this tag a second set of forms ("converges with X, which the
     test kept") because the relation under it was a nearest neighbour and
     could name a plan that named somebody else; the tag then had to say which
     of the pair was the one the test kept. `convergeMap` is a symmetric
     matching now, so `near[n].near === i` holds for every tagged plan by
     construction and that branch was unreachable: it is gone rather than left
     as dead copy a later hand would have to reason about. `dist` stays in the
     signature because every call site passes it and because the CALLER still
     decides, from meta's own distinctness, whether a tile carries a tag at
     all; this function no longer reads it. */
  function convergeTagForms(i, near, shorts, dist) {
    var n = near && near[i] ? near[i].near : -1;
    if (!(n >= 0) || !shorts || !shorts[n]) {
      return ['converges with another plan', 'converges with another'];
    }
    var name = shorts[n];
    return ['converges with ' + name, 'same as ' + name];
  }

  /* The partner picker of build spec v2 section 5c. The four labels and their
     one-line honest notes are VERBATIM from that section, under the copy rule
     "trained to", never "paid to". */
  var PARTNERS = [
    /* s7.21 ruling 10: "Self-play, run N" read like an unsubstituted template,
       and every blurb was a subjectless lowercase fragment that only parsed if
       you read the dropdown label as its subject. Each one is a sentence now. */
    { key: 'sp', label: 'Self-play engineer, run N', short: 'Self-play', pick: 'Run', n: 8,
      note: 'This partner trained only with a copy of itself.' },
    { key: 'ac', label: 'Any-Play accommodator', short: 'Accommodator', pick: 'Run', n: 8,
      note: 'This partner trained with a partner that kept changing its style.' },
    { key: 'spec', label: 'Any-Play specializer, intent N', short: 'Specializer', pick: 'Intent', n: 6,
      note: 'This partner plays one of the six styles it was trained to make ' +
            'distinguishable from each other, and it plays that style and nothing else.' },
    { key: 'div', label: 'Diversity-only', short: 'Diversity-only', pick: 'Intent', n: 6,
      note: 'This partner trained for diverse styles but not to optimize the score, ' +
            'and it is the control the page keeps to show what the score term buys.' }
  ];
  function partnerDef(key) {
    var i;
    for (i = 0; i < PARTNERS.length; i++) if (PARTNERS[i].key === key) return PARTNERS[i];
    return PARTNERS[0];
  }

  /* ---- the labels carry their real number (s7.24 ruling 10) ---------------
     Two of the four partner labels end in a LITERAL "N", which is a template
     the page is supposed to fill: the picker printed "Self-play engineer,
     run N" beside a second select reading "Run 1" and the light lane read the
     pair as unfinished markup, and the ledger's own sentence stripped the "N"
     and printed "Self-play engineer, run: best 8 over 1 game.". One writer
     fills it everywhere, and a label with no index is left alone. */
  function partnerLabel(d, n) {
    if (!d || !d.label) return '';
    if (d.label.indexOf(' N') < 0) return d.label;
    if (typeof n === 'number' && isFinite(n) && n >= 0) {
      return d.label.replace(' N', ' ' + (Math.round(n) + 1));
    }
    return d.label.replace(/,\s*[A-Za-z]+ N$/, '');
  }

  /* the ledger row aggregates a partner TYPE, so it names every run it holds */
  function partnerLabelRuns(d, runs) {
    if (!d || !d.label || d.label.indexOf(' N') < 0) return d ? d.label : '';
    if (!runs || !runs.length) return partnerLabel(d, -1);
    if (runs.length === 1) return partnerLabel(d, runs[0]);
    var ns = [], i;
    for (i = 0; i < runs.length; i++) ns.push(runs[i] + 1);
    var last = ns.pop();
    return d.label.replace(/,\s*([A-Za-z]+) N$/, function (m, word) {
      return ', ' + word.toLowerCase() + 's ' + ns.join(', ') + ' and ' + last;
    });
  }

  /* ---- the per partner ledger (build spec v3 section 7.7 ruling 4d) --------
     This replaces D4 10.3's two round report, which the free partner picker of
     v2 5c made impossible: there are no longer two fixed rounds in a fixed
     order to compare. It is a ledger of THIS VISIT and nothing else: the best
     hold the visitor has managed, in keep health, with each partner type they
     have tried, rewritten the moment a game ends. It is held in memory and
     never stored, so a reload starts an empty table, and it quotes only games
     this browser has just played. */
  var LEDGER = {};          /* partner key -> { best, games, held } */

  function recordHold(key, hp, held, n) {
    var d = partnerDef(key), row = LEDGER[d.key];
    var v = Math.max(0, Math.round(typeof hp === 'number' ? hp : 0));
    if (!row) row = LEDGER[d.key] = { best: -1, games: 0, held: 0, runs: {} };
    if (!row.runs) row.runs = {};
    row.games++;
    if (held) row.held++;
    if (v > row.best) row.best = v;
    /* which run of this partner type the game was played with, so the sentence
       can name it instead of printing a bare "run:" (s7.24 ruling 10) */
    if (typeof n === 'number' && isFinite(n) && n >= 0) row.runs[Math.round(n)] = 1;
    writeLedger();
  }

  function ledgerRows() {
    var out = [], i, d, row;
    for (i = 0; i < PARTNERS.length; i++) {
      d = PARTNERS[i];
      row = LEDGER[d.key];
      if (!row) continue;
      var runs = [], rk;
      for (rk in (row.runs || {})) runs.push(Number(rk));
      runs.sort(function (a, b) { return a - b; });
      out.push({ key: d.key, label: d.label, short: d.short, runs: runs,
                 named: partnerLabelRuns(d, runs),
                 best: row.best, games: row.games, held: row.held,
                 live: d.key === act.partner });
    }
    return out;
  }

  function ledgerCell(v) { return v > 0 ? (String(v) + ' of ' + HP_KEEP) : 'fell'; }

  function writeLedger() {
    var box = byId('kit-ledger'), sr = byId('kit-sr-ledger');
    var rows = ledgerRows(), i, r, tbl, tr, th, td, p2;
    /* Build spec v3 s7.15 ruling 2: a "no game finished" sentence never
       shares the panel with a score. One judge read "The keep held at 92 of
       100." a few lines above "No game has finished yet." and called it a
       contradiction, which is exactly what it looks like. The whole group is
       out of the panel until there is a row for it, and the hint under it
       already says what fills it. */
    var grp = byId('kit-ledger-controls');
    if (grp && act.name === 'you') grp.style.display = rows.length ? '' : 'none';
    if (box) {
      while (box.firstChild) box.removeChild(box.firstChild);
      if (!rows.length) {
        p2 = document.createElement('p');
        p2.textContent = 'Finish a game and your best hold with each partner is listed here.';
        box.appendChild(p2);
      } else {
        tbl = document.createElement('table');
        tr = document.createElement('tr');
        ['Partner', 'Best hold', 'Games'].forEach(function (h, k) {
          var e = document.createElement('th');
          e.setAttribute('scope', 'col');
          if (k) e.className = 'kit-ledger__n';
          e.textContent = h;
          tr.appendChild(e);
        });
        tbl.appendChild(tr);
        for (i = 0; i < rows.length; i++) {
          r = rows[i];
          tr = document.createElement('tr');
          if (r.live) tr.className = 'kit-ledger__live';
          th = document.createElement('th');
          th.setAttribute('scope', 'row');
          th.textContent = r.short;
          tr.appendChild(th);
          td = document.createElement('td');
          td.className = 'kit-ledger__n';
          td.textContent = ledgerCell(r.best);
          tr.appendChild(td);
          td = document.createElement('td');
          td.className = 'kit-ledger__n';
          td.textContent = String(r.games);
          tr.appendChild(td);
          tbl.appendChild(tr);
        }
        box.appendChild(tbl);
      }
    }
    if (sr) sr.textContent = ledgerSentence(rows);
  }

  /* the same rows as sentences, because the visible table is a squeezed
     picture of them and carries aria-hidden */
  function ledgerSentence(rows) {
    var i, r, out;
    if (!rows.length) {
      /* s7.24 ruling 10, and s7.19 ruling 6 reasserted: this sentence sat in
         the page's text beside a real result from the landing act and the
         light lane read the pair as a contradiction. The ledger only ever
         holds games the VISITOR played, so it says which games it is counting
         and can no longer be read against a score from another act. */
      return 'Your best hold, by partner, this visit. You have not finished ' +
             'a game in Your turn yet.';
    }
    out = 'Your best hold, by partner, this visit, out of ' + HP_KEEP + '. ';
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      out += (r.named || r.label.replace(' N', '')) + ': ' +
             (r.best > 0 ? ('best ' + r.best) : 'the keep fell every time') +
             ' over ' + r.games + (r.games === 1 ? ' game. ' : ' games. ');
    }
    return out;
  }

  /* one live session: core's game plus the page's own presentation ledger */
  var S = null;
  var TICK_MS = 240;
  var lastTick = 0;
  var playing = false;

  /* The fx ledger, which is the record pinned in INTERFACES P.4 and the one
     the renderer normalizes. Nothing here is ever read back into the game. */
  var FX = {
    alpha: 1, t: 0, now: 0, theme: 'dark', light: false, seat: 'a',
    hpMax: null, act: 'watch', sub: 'idle', reduced: false,
    flashes: [], shots: [], drones: [],
    cursor: -1, hover: -1, ghost: null,
    caption: '', grid: null, focusMark: -1
  };

  var view = null, cssW = 0, cssH = 0, dpr = 1;
  var boxes = { panel: null, actbar: null, board: null, corner: null, chat: null, coach: null };

  /* --------------------------------------------------------- core adapters */

  function coreCfg() { return (Core && Core.CFG) || null; }

  function terrain() {
    if (!Core) return null;
    try { return Core.terrain ? Core.terrain() : null; } catch (e) { return null; }
  }

  /* core's netFor walks a dotted path, so the same key is tried at every
     place the two model layouts put it. A miss returns null and the caller
     leaves the board empty rather than substituting something */
  function netOf(key) {
    if (!Core || !model || !Core.netFor) return null;
    var tries = ['nets.' + key, key], i;
    for (i = 0; i < tries.length; i++) {
      try { return Core.netFor(model, tries[i]); } catch (e) {}
    }
    return null;
  }

  function netKeys(prefix, n) {
    var out = [], i, k;
    var nets = (MODEL && MODEL.nets) || null;
    if (nets) {
      for (k in nets) {
        if (!Object.prototype.hasOwnProperty.call(nets, k)) continue;
        if (k.indexOf(prefix) === 0) out.push(k);
      }
      out.sort();
    }
    out = out.slice(0, n);
    for (i = out.length; i < n; i++) out.push(prefix + i);   /* honest placeholder names */
    return out;
  }

  function agentFor(key) {
    var net = netOf(key);
    if (net) return { kind: 'net', net: net };
    /* no weights: an empty agent leaves the board EMPTY rather than
       pretending something played */
    return { kind: 'none' };
  }

  /* a whole session: episode, game, board, builder. Null when core is not
     loaded, and every caller copes with null. */
  function newSession(seed, agents) {
    if (!Core || !Core.makeEpisode || !Core.newGame) return null;
    var cfg = coreCfg(), terr = terrain(), ep, g, board = null, bld = null;
    try { ep = Core.makeEpisode(seed >>> 0, terr, cfg); } catch (e) { return null; }
    try { g = Core.newGame(ep, cfg); } catch (e) { return null; }
    try {
      if (Core.makeBoard) board = Core.makeBoard(terr, cfg);
      if (board && Core.makeBuilder) bld = Core.makeBuilder(board, ep, g);
    } catch (e) { board = null; bld = null; }
    return {
      ep: ep, g: g, board: board, bld: bld, cfg: cfg,
      wave: 0, phase: 'build', ws: null,
      agents: agents || [{ kind: 'none' }, { kind: 'none' }],
      reveal: [], shown: {}, over: false
    };
  }

  function budgetsFor(sess, wave) {
    var b = sess && sess.ep && sess.ep.budgets;
    if (b && b[wave]) return [b[wave][0], b[wave][1]];
    return [24, 24];
  }

  function structMap(sess) {
    var g = sess && sess.g;
    return (g && g.struct) ? g.struct : null;
  }

  function structCells(sess) {
    var m = structMap(sess), out = [], k;
    if (!m) return out;
    if (typeof m.forEach === 'function') m.forEach(function (v, key) { out.push(key); });
    else for (k in m) { if (Object.prototype.hasOwnProperty.call(m, k)) out.push(k | 0); }
    return out;
  }

  /* One whole build phase through core's own loop. The page never holds a
     second copy of the policy: SEAM P-S2 asks core for a one placement entry
     point, and until then the phase is replayed. */
  function runBuild(sess) {
    if (!sess || !Core || !Core.buildPhase || !sess.bld) return [];
    var before = {}, i, cells = structCells(sess);
    for (i = 0; i < cells.length; i++) before[cells[i]] = 1;
    try { Core.buildPhase(sess.g, sess.bld, sess.agents, budgetsFor(sess, sess.wave), sess.wave); }
    catch (e) { return []; }
    var after = structCells(sess), added = [];
    for (i = 0; i < after.length; i++) if (!before[after[i]]) added.push(after[i]);
    return added;
  }

  /* P-S8 is closed: core ships one seat's turn per call, and buildPhase is
     literally repairAll plus this step in a loop, so a turn metered build and
     a headless one cannot drift apart. A page driving the steps itself has to
     repair first, because buildPhase repairs once before its own loop. */
  function openBuild(sess) {
    if (!sess || !Core || !Core.newBuildState || !sess.board) return false;
    try {
      if (Core.repairAll) Core.repairAll(sess.g);
      sess.bstate = Core.newBuildState(sess.board);
    } catch (e) { sess.bstate = null; return false; }
    sess.budgets = budgetsFor(sess, sess.wave);
    sess.buildDone = false;
    return true;
  }

  /* one step of each seat: the visitor's queued piece, then one piece from the
     partner. That is the whole reason the act needs no countdown clock. */
  function stepBuild(sess, opts) {
    opts = opts || {};
    var mine = 0, theirs = 0, guard = 0, r;
    if (!sess || !sess.bstate || !Core.buildStep) return { mine: 0, theirs: 0 };
    while (guard++ < 400) {
      try {
        r = Core.buildStep(sess.g, sess.bld, sess.agents, sess.budgets,
                           sess.wave, sess.bstate, sess.board);
      } catch (e) { sess.buildDone = true; break; }
      if (!r) { sess.buildDone = true; break; }
      if (r.placed) { if (r.side === 0) mine++; else theirs++; }
      if (r.done) { sess.buildDone = true; break; }
      if (opts.one && r.placed) { sess.lastCell = r.placed.cell; break; }
      if (!opts.all && mine > 0 && r.side === 1) break;
    }
    return { mine: mine, theirs: theirs };
  }

  /* the tiles the visitor may really put this piece on, asked of core rather
     than re-derived here */
  function canPlace(sess, cell, piece) {
    if (!sess || !Core) return false;
    var x = cx(cell), y = cy(cell);
    try {
      if (piece === PIECE_GUN && sess.cfg && sess.cfg.mounted_guns) {
        return !!Core.canMount(sess.g, x, y);
      }
      return !!Core.canBuild(sess.g, x, y);
    } catch (e) { return false; }
  }

  function startWave(sess) {
    if (!sess || !Core || !Core.waveInit) return false;
    try { sess.ws = Core.waveInit(sess.g, sess.wave); } catch (e) { sess.ws = null; }
    if (!sess.ws) return false;
    sess.phase = 'resolve';
    /* s7.24 ruling 1 again, for every other way the VISITOR'S OWN wave begins
       (the keyboard, a restored share link, a wave the act starts for them).
       It is scoped to the act the visitor plays: in Watch a wave the waves
       arrive on their own clock, and shutting the controls a visitor opened
       while they are reading them would be the page fighting its own visitor,
       which is the defect this whole round is about. */
    if (act.name === 'you') collapseForPlay();
    return true;
  }

  function waveTick(sess) {
    if (!sess || !sess.ws || !Core || !Core.waveTick) return null;
    try { return Core.waveTick(sess.g, sess.ws); } catch (e) { return null; }
  }

  function waveFinish(sess) {
    if (!sess || !sess.ws || !Core || !Core.waveFinish) return 0;
    try { return Core.waveFinish(sess.g, sess.ws); } catch (e) { return 0; }
  }

  function keepHp(sess) {
    var g = sess && sess.g;
    return (g && typeof g.keepHp === 'number') ? g.keepHp : HP_KEEP;
  }

  function ready() { return !!(Core && R && model); }

  function missingList() {
    var m = [];
    if (!Core) m.push('the rules');
    if (!R) m.push('the artwork');
    if (!model) m.push('the engineers');
    return m;
  }

  function honestMissing() {
    var m = missingList();
    return m.length ? ('Not loaded yet: ' + m.join(', ') + '.') : 'Loading.';
  }

  /* The half of the verify state that costs something: the recorded game.
     It only runs on a TRAINED export, because that is the only branch the
     metadata could not already answer. Called once, from boot. */
  function resolveVerify() {
    if (VERIFY.kind === 'missing') {
      var m = missingList();
      VERIFY.line = m.length ? ('Not loaded yet: ' + m.join(', ') + '.') : '';
      return VERIFY;
    }
    if (VERIFY.kind !== 'pending') return VERIFY;
    if (!Core || !Core.checkTestVector) {
      var nc = 'This page could not check its own model. What you see below may be wrong.';
      VERIFY = { kind: 'nocheck', line: nc, plate: nc };
      return VERIFY;
    }
    var v = null;
    try { v = Core.checkTestVector(model); } catch (e) { v = null; }
    if (v && v.ok) {
      VERIFY = { kind: 'ok', line: MSG_OK, plate: '' };
      return VERIFY;
    }
    /* absent is not a mismatch and must not be reported as one */
    if (v && v.status === 'absent') {
      var ab = 'This page could not check its own model: it carries no recorded ' +
               'game to replay. What you see below may be wrong.';
      VERIFY = { kind: 'absent', line: ab, plate: ab };
      return VERIFY;
    }
    /* core reports the first bad entry as a sentence, so the tick is read out
       of it rather than invented; a forward-pass failure carries no tick and
       the sentence then says so without a number */
    var eb = (v && v.episode && v.episode.firstBad) ? String(v.episode.firstBad) : '';
    var mt = /\btick (\d+)/.exec(eb), me = /\bentry (\d+)/.exec(eb);
    var at = mt ? (' (mismatch at tick ' + mt[1] + ')')
           : me ? (' (mismatch at entry ' + me[1] + ')') : '';
    var msg = 'This page could not verify its own model' + at +
              '. What you see below may be wrong.';
    VERIFY = { kind: 'mismatch', line: msg, plate: msg };
    return VERIFY;
  }

  /* ---------------------------------------------------- the render adapter
     Core's game is a Map of structures plus a wave state; the renderer reads
     typed arrays and a walker list. This is the only place the two meet, and
     it produces a read only object the renderer never writes to. */

  var RS = {
    piece: new Uint8Array(CELLS), owner: new Int8Array(CELLS), hp: new Int16Array(CELLS),
    keepHp: HP_KEEP, walkers: [], phase: 'build', wave: 0, tick: 0, phaseTick: 0,
    budget: [0, 0]
  };

  function renderState(sess) {
    var i;
    RS.piece.fill(0); RS.owner.fill(-1); RS.hp.fill(0);
    RS.walkers.length = 0;
    if (!sess) { RS.keepHp = HP_KEEP; return RS; }
    var m = structMap(sess);
    if (m && typeof m.forEach === 'function') {
      m.forEach(function (v, cell) {
        if (cell < 0 || cell >= CELLS) return;
        if (!sess.shown[cell]) return;               /* not revealed on screen yet */
        var kind = (typeof v.kind === 'number') ? v.kind : (v.kind === 'turret' ? 2 : 1);
        RS.piece[cell] = kind === 2 ? PIECE_GUN : PIECE_WALL;
        RS.owner[cell] = (typeof v.owner === 'number') ? v.owner : -1;
        RS.hp[cell] = (typeof v.hp === 'number') ? v.hp : (kind === 2 ? HP_GUN : HP_WALL);
      });
    }
    RS.keepHp = keepHp(sess);
    RS.phase = sess.phase;
    RS.wave = sess.wave;
    /* SEAM R3-S1 TAKEN: the state names the board it is played on, so the
       renderer READS the terrain instead of falling back to whatever board the
       core happens to have active. `g.t` is the game's own terrain object.
       (It is also why RS.tick used to be wrong: it was reading the terrain.) */
    RS.terrain = (sess.g && sess.g.t) || null;
    var ws = sess.ws, list = ws && (ws.walkers || ws.live || ws.units);
    RS.tick = (ws && typeof ws.tick === 'number') ? ws.tick : 0;
    RS.phaseTick = RS.tick;
    if (list && list.length) {
      for (i = 0; i < list.length; i++) {
        var w = list[i];
        if (!w || (typeof w.hp === 'number' && w.hp <= 0)) continue;
        var cell = (typeof w.cell === 'number') ? w.cell
                 : (typeof w.x === 'number' ? cellOf(w.x, w.y) : -1);
        if (cell < 0 || cell >= CELLS) continue;
        RS.walkers.push({ id: (typeof w.wid === 'number') ? w.wid : (w.id | 0),
                          cell: cell, hp: w.hp, gate: w.gate || 0,
                          cool: w.cool || 0, atk: w.atk ? 1 : 0 });
      }
    }
    return RS;
  }

  /* the per frame fields, on the same object: the renderer derives everything
     else it needs from the state plus its own motion memory */
  function renderFx(t) {
    FX.t = t;
    FX.now = t;
    FX.alpha = TICK_MS > 0 ? Math.max(0, Math.min(1, (t - lastTick) / TICK_MS)) : 1;
    FX.hpMax = { wall: HP_WALL, gun: HP_GUN, keep: HP_KEEP };
    FX.theme = effectiveTheme();
    FX.light = isLight();
    FX.act = act.name;
    FX.sub = act.sub;
    FX.reduced = reducedMotion();
    /* SEAM P12-S1 is CLOSED (build spec v3 s7.19 ruling 8): the keep's health
       is shown once. The corner meter keeps the board's own instrument and
       drawKeepNumber names and numbers it; the mast bar over the castle, which
       two ship-gate judges counted as a second unlabelled bar, is left out of
       the live frame. A still (a fortress thumbnail) has no corner meter, so
       the renderer keeps the bar there and this word is about this frame only.
       Veto is one line: delete it and the mast bar comes back. */
    FX.keepBar = false;
    /* s7.32 ruling 5 (the 7.30 open ruling, option a): while the phone keeps
       the page's own keep plate for the whole framed wave (keepNumberGeom's
       wantOwn), the renderer's corner meter is left out of the frame, so the
       keep's health is shown once. Absent or true means ON. */
    /* s7.32 addendum 3 item 1: and on the desktop too. At S 1.5 the framed
       window's foot cuts through the meter's own well, which then stood on the
       frame's painted bottom band; while following, the page's plate is the
       readout on every device (wantOwn below) and the meter stays out */
    FX.keepMeter = !following();
    return FX;
  }

  function pushFlash(cell, kind, t) {
    FX.flashes.push({ cell: cell, kind: kind, t0: (t === undefined ? now() : t), ms: 420 });
    if (FX.flashes.length > 64) FX.flashes.shift();
  }

  function ageFlashes(t) {
    var i;
    for (i = FX.flashes.length - 1; i >= 0; i--) {
      if (t - FX.flashes[i].t0 > FX.flashes[i].ms + 900) FX.flashes.splice(i, 1);
    }
  }

  /* -------------------------------------------------------------- the sound */

  var audioOn = true, audioArmed = false, soundHint = null;
  /* the one task between the arming gesture and the built graph; see armAudio */
  var audioArming = false, armQ = [];
  var audioLog = [], loopsOn = {};

  try { if (localStorage.getItem('kit-sound') === 'off') audioOn = false; } catch (e) {}

  function audioCall(fn) {
    if (!Audio) return;
    /* a sound raised in the one task between the gesture and the graph waits
       for the graph rather than being dropped, so the click that arms the
       audio still sounds (armAudio explains why the graph is one task late) */
    if (audioArming) { if (armQ.length < 32) armQ.push(fn); return; }
    if (!audioArmed) return;
    try { fn(); } catch (e) {}
  }

  function flushArmQ() {
    var q = armQ, i;
    armQ = [];
    for (i = 0; i < q.length; i++) { try { q[i](); } catch (e) {} }
  }

  /* ------------------------------------------------------------ the batch
     Build spec v3 s7.15 ruling 9. The sound audit measured the consequence of
     calling play once per event: 0 coalesced and 577 cooldown drops over
     187 s, so a volley of three machines landed as two and the mixer's "+2 dB
     single instance" law was unreachable from the page. Every sound the frame
     produces now goes out as ONE batch through KeepAudio.playMany, which is
     what that law is written for. Sounds raised outside a frame (a button, a
     refusal) still play at once: an interface answer must not wait. */
  var sndQ = [], sndBatch = false;

  function playSound(name, opts) {
    if (!name) return;
    audioLog.push({ t: Date.now(), name: name, owner: opts && opts.owner });
    if (audioLog.length > 200) audioLog.shift();
    if (sndBatch) {
      var o = opts || {};
      sndQ.push({ v: name, owner: o.owner, x: o.x, y: o.y, gainDb: o.gainDb, params: o.param });
      return;
    }
    audioCall(function () { Audio.play(name, opts || {}); });
  }

  /* Build spec v3 s7.19 ruling 9, the page's half. The sound audit measured
     keep-fell sounding on 1 of 3 falls and wave-held on 18 of 27, because two
     keep-hits raised earlier in the same tick had already taken the class
     budget. The mixer gains a within-class priority (Z-A's half); the page
     hands it the ENDINGS FIRST, so the decision is made with the ending in
     front of the planner rather than behind a hit. The order inside each group
     is untouched, so nothing else about a tick changes. */
  var ENDING = { 'keep-fell': 1, 'wave-held': 1, 'wave-start': 1 };

  function endingsFirst(list) {
    var a = [], b = [], i;
    for (i = 0; i < list.length; i++) {
      if (ENDING[list[i].v]) a.push(list[i]); else b.push(list[i]);
    }
    return a.length ? a.concat(b) : list;
  }

  function flushSounds() {
    if (!sndQ.length) return;
    var list = endingsFirst(sndQ);
    sndQ = [];
    /* through audioCall, so a frame that lands in the arming task waits for
       the graph with everything else instead of being dropped */
    /* ONE clock read for the whole tick, which is what KeepAudio.playMany's
       second argument is for: every event without a `t` of its own takes it, so
       one tick's voices carry one timestamp instead of a handful of reads.
       KeepAudio's own default clock is this same performance.now, so the value
       is the one it would have read itself (INTERFACES, Z-A, ruling 9). */
    audioCall(function () {
      /* read inside the call, not outside it: a batch that lands in the arming
         task is played one task later, and a timestamp from before the mixer's
         own clock started reads as a negative gap in its cooldown */
      var tick = now();
      if (Audio.playMany) Audio.playMany(list, tick);
      else for (var i = 0; i < list.length; i++) {
        Audio.play(list[i].v, { owner: list[i].owner, x: list[i].x, y: list[i].y });
      }
    });
  }

  function startLoop(name, id, params) {
    if (!audioOn) return;              /* muted means no loop is started at all */
    loopsOn[id] = name;
    audioCall(function () { Audio.loop(name, id, params || {}); });
  }
  function stopLoop(id) {
    if (!loopsOn[id]) return;
    delete loopsOn[id];
    audioCall(function () { Audio.stopLoop(id); });
  }
  function stopAllLoops() {
    var id;
    for (id in loopsOn) { if (Object.prototype.hasOwnProperty.call(loopsOn, id)) delete loopsOn[id]; }
    audioCall(function () { if (Audio.stopAllLoops) Audio.stopAllLoops(); });
  }

  /* The AudioContext is created on the FIRST REAL gesture and never before:
     the browser autoplay law and the site's manners, in one rule. */
  function armAudio() {
    if (audioArmed || audioArming || !Audio) return;
    audioArming = true;
    /* Build spec v3 s7.15 ruling 4's long-task bar, measured at this call site
       rather than argued. SEAM A-S4 handed "the act change itself" to this
       zone as a 452 ms task; the act change is 5 to 7 ms cold (p9/cold.js) and
       3 to 21 ms warm (p9/actchange.js). What the visitor's FIRST click really
       costs is `KeepAudio.arm()`, which opens the AudioContext and builds the
       whole mixer graph: 200 and 231 ms of a 247 to 263 ms long task over two
       rounds, with the SECOND click raising no long task at all
       (p9/armcost.js, real clicks on the served page).

       So the graph is built in the NEXT task. The gesture still causes it and
       nothing is created before one, which is spec 4.1's law and the ship
       gate's verified bar ("no AudioContext exists before the first real
       gesture"): sticky activation survives the task that scheduled this, so
       the context still starts running and raises no autoplay warning.
       Sounds raised in the gap wait in armQ (see audioCall) and go out
       together, so the click that arms the audio still sounds. */
    setTimeout(function () {
      audioArming = false;
      audioArmed = true;
      try {
        Audio.init({});
        Audio.arm();
        Audio.setMuted(!audioOn);
        pushAudioView();
      } catch (e) {}
      syncSoundBtn();
      flushArmQ();
      if (audioOn && !soundHint) {
        /* deferred again so it never lands on the gesture that armed the audio */
        setTimeout(showSoundHint, 400);
      }
    }, 0);
  }

  /* The one-time sound notice (spec 4.1). Build spec v3 s7.15 ruling 2: it
     used to be a plate over the board, and a visitor who never touched the
     sound got it painted across the keep in the middle of a wave. A toast goes
     to the STATUS LINE, never over the board. */
  var soundHintTries = 0;
  /* ---- s7.29 ruling 5: THE SOUND LINE YIELDS TO THE GAME STATE LINE -------
     The light lane's first Step press answered them about sound: the press
     arms the audio, the one-time notice is queued behind the arming task, and
     the game's own sentence had already been written by the time it landed,
     so "Sound is on. The speaker button mutes it." replaced "Back to the
     start of the wave." A press that changes the game owns the status line;
     the notice waits, and it waits without spending a try, so a visitor who
     steps a whole wave still gets told about the sound afterwards. */
  var soundHintUntil = 0;
  function holdSoundHint() { soundHintUntil = now() + 4000; }

  function showSoundHint() {
    var K = 'hint-keepittogether-sound';
    if (soundHint) return;
    try { if (localStorage.getItem(K)) return; } catch (e) {}
    if (now() < soundHintUntil) {
      setTimeout(showSoundHint, (soundHintUntil - now()) + 60);
      return;
    }
    /* s7.19 ruling 10: it WAITS FOR the announcement of the button that was
       just pressed. The first click of a visit arms the audio and does
       something else at the same time, and the light lane heard this sentence
       read out in place of the act it had chosen. It is not urgent, so it goes
       after, or (five tries later, about 5 s of a visitor pressing things) not
       at all this visit. */
    if (soundHintTries < 5 && stKind === 'msg' && (now() - stAt) < DWELL) {
      soundHintTries++;
      setTimeout(showSoundHint, DWELL - (now() - stAt) + 60);
      return;
    }
    soundHint = true;
    try { localStorage.setItem(K, '1'); } catch (e) {}
    /* s7.19 ruling 10: it NEVER overwrites the announcement for the button the
       visitor just pressed. The first click of a visit both arms the audio and
       does something else, and the light lane heard "Sound is on" read out in
       place of the act they had just chosen. A plain queued write waits for the
       standing sentence's dwell; if a user action lands in the meantime it goes
       to the back of the queue behind that too, which is the whole point. */
    setStatus('Sound is on. The speaker button mutes it.',
              { sr: 'Sound is on. The speaker button mutes it.' });
  }

  function pushAudioView() {
    audioCall(function () {
      if (!Audio.setView) return;
      var f = !!(view && view.follow) || following();
      var w = (RC && RC.SRCW) ? RC.SRCW : 740;
      var x0 = 0, x1 = COLS;
      if (f && view && typeof view.fx0 === 'number' && view.fw) {
        x0 = COLS * (view.fx0 / w);
        x1 = COLS * ((view.fx0 + view.fw) / w);
      }
      Audio.setView({ boardW: COLS, camX0: x0, camX1: x1, follow: f });
    });
  }

  function setMuted(m) {
    audioOn = !m;
    try { localStorage.setItem('kit-sound', audioOn ? 'on' : 'off'); } catch (e) {}
    if (!audioOn) stopAllLoops();
    audioCall(function () { Audio.setMuted(m); });
    syncSoundBtn();
    setStatus(audioOn ? 'Sound on.' : 'Sound off.', { force: true });
  }

  function syncSoundBtn() {
    var els = [byId('kit-sound'), actbarSound], i, b;
    for (i = 0; i < els.length; i++) {
      b = els[i];
      if (!b) continue;
      b.textContent = audioOn ? 'Sound on' : 'Sound off';
      b.setAttribute('aria-pressed', audioOn ? 'true' : 'false');
      b.setAttribute('aria-label', audioOn ? 'Mute sound' : 'Unmute sound');
      b.setAttribute('title', audioOn ? 'Mute sound' : 'Unmute sound');
    }
  }

  /* ---- the ev to voice mapping, pure so a node test can drive it ---------
     ev is core's wave record. SEAM P-S4 is TAKEN: the three records C2 added
     (`ev.broke`, `ev.hurt`, `ev.keepFell`) and the two that were already there
     (`ev.killed` with a cell, `ev.shots[i].owner`) are read directly, and the
     page's own state-diff derivations are GONE. A voice core cannot report is
     not played: the page never invents an event it did not observe. */
  function soundsFor(ev, st, prev) {
    var out = [], i, e;
    if (!ev) return out;
    function push(name, cell, owner) {
      out.push({ name: name, owner: (typeof owner === 'number' ? owner : -1),
                 x: cell >= 0 ? cx(cell) : -1, y: cell >= 0 ? cy(cell) : -1 });
    }
    if (ev.placed) {
      for (i = 0; i < ev.placed.length; i++) {
        e = ev.placed[i];
        if (!e) continue;
        push(e.piece === PIECE_GUN ? 'build-gun' : 'build-wall', e.cell, e.owner);
      }
    }
    if (ev.shots) {
      for (i = 0; i < ev.shots.length; i++) {
        e = ev.shots[i];
        push('windup', typeof e.from === 'number' ? e.from : -1, e.owner);
      }
    }
    if (ev.hits) {
      for (i = 0; i < ev.hits.length; i++) push('wall-hit', ev.hits[i].cell, -1);
    }
    /* the breaking hits, lifted out by core, so a wall and a machine are two
       different sounds instead of one guess */
    if (ev.broke) {
      for (i = 0; i < ev.broke.length; i++) {
        e = ev.broke[i];
        push(e.piece === PIECE_GUN || e.piece === 'turret' ? 'gun-break' : 'wall-break',
             e.cell, e.owner);
      }
    } else if (ev.hits) {
      /* an older core: fall back to what the hit record can say */
      for (i = 0; i < ev.hits.length; i++) {
        if (ev.hits[i].broke) push('wall-break', ev.hits[i].cell, -1);
      }
    }
    /* bodies a volley damaged and did not kill. One record per body per tick,
       so two machines on one walker is one hiss, not two. */
    if (ev.hurt) {
      for (i = 0; i < ev.hurt.length; i++) push('creature-hurt', ev.hurt[i].cell, -1);
    }
    /* ev.killed carries the cell the body fell on; ev.kills is a list of ids
       and would pan every death to the centre of the board */
    if (ev.killed) {
      for (i = 0; i < ev.killed.length; i++) {
        e = ev.killed[i];
        push('creature-die', (typeof e.cell === 'number') ? e.cell : -1,
             (typeof e.owner === 'number') ? e.owner : -1);
      }
    } else if (ev.kills) {
      for (i = 0; i < ev.kills.length; i++) push('creature-die', -1, -1);
    }
    if (ev.arrivals && ev.arrivals.length) {
      push('breach', (typeof ev.arrivals[0].cell === 'number') ? ev.arrivals[0].cell : -1, -1);
    }
    if (ev.keepHit) push('keep-hit', -1, -1);
    if (ev.keepFell) push('keep-fell', -1, -1);
    else if (ev.keepFell === undefined &&
             st && typeof st.keepHp === 'number' && st.keepHp <= 0 &&
             prev && typeof prev.keepHp === 'number' && prev.keepHp > 0) {
      push('keep-fell', -1, -1);
    }
    return out;
  }

  function emitSounds(ev, sess, prevHp) {
    if (!audioArmed) return;
    var list = soundsFor(ev, { keepHp: keepHp(sess) }, { keepHp: prevHp }), i, s;
    for (i = 0; i < list.length; i++) {
      s = list[i];
      /* ruling 9 asks for one call per shot; the sound audit's minor 1 names
         `keep-fell` as "the same shape", 2 calls for 1 event with 1 played. The
         second call is the wave-finish branch, which is also the ONLY caller
         under reduced motion, so it cannot simply go: the session records that
         the tick already sounded the fall and the branch stands down. */
      if (s.name === 'keep-fell' && sess) sess.fellSounded = true;
      playSound(s.name, { owner: s.owner, x: s.x, y: s.y });
      /* the death beat is worth a camera move on the phone follow camera */
      if (s.name === 'creature-die' && s.x >= 0) panTo(cellOf(s.x, s.y));
    }
  }

  /* the texture loops, and the caps the page owns (spec 4.3 rule 3) */
  function syncLoops(sess) {
    if (!audioArmed || !audioOn || !sess || !sess.ws) { stopAllLoops(); return; }
    var st = renderState(sess), chewers = [], moving = 0, i, w, want = {};
    for (i = 0; i < st.walkers.length; i++) {
      w = st.walkers[i];
      if (w.atk) chewers.push(w); else moving++;
    }
    /* the keep sits at the bottom of the board, so nearest the keep is the
       largest row: the cap of 2 takes those two and no more */
    chewers.sort(function (a, b) { return cy(b.cell) - cy(a.cell); });
    for (i = 0; i < chewers.length && i < 2; i++) {
      var id = 'chew:' + chewers[i].id;
      want[id] = 1;
      startLoop('chew', id, { x: cx(chewers[i].cell), y: cy(chewers[i].cell),
                              distKeep: ROWS - 1 - cy(chewers[i].cell), rate: 1 });
    }
    for (i in loopsOn) {
      if (!Object.prototype.hasOwnProperty.call(loopsOn, i)) continue;
      if (String(i).indexOf('chew:') === 0 && !want[i]) stopLoop(i);
    }
    if (moving > 0) startLoop('swarm', 'swarm', { n: moving });
    else stopLoop('swarm');
  }

  /* ------------------------------------------------------------------ drones
     The delivery drone is presentation, so the page owns it. It is also what
     makes drone-pick, drone-hum, drone-turn and drone-drop real events rather
     than decoration bolted onto a sound. */

  var DRONE_MS = 700;

  /* the page flies them in GRID coordinates (px is a column, py is a row);
     the renderer turns that into source pixels and an altitude */
  function spawnDrone(owner, cell) {
    var d = { owner: owner, cell: cell, t0: now(),
              x0: owner === 1 ? COLS - 1 : 0, y0: 0,
              tx: cx(cell), ty: cy(cell),
              px: cx(cell), py: cy(cell),
              carrying: true, landed: false, heading: 0 };
    FX.drones.push(d);
    if (FX.drones.length > 6) FX.drones.shift();
    playSound('drone-pick', { owner: owner, x: cx(cell), y: cy(cell) });
    startLoop('drone-hum', 'drone:' + (owner === 1 ? 1 : 0),
              { x: cx(cell), y: cy(cell), owner: owner, speed: 1 });
  }

  function stepDrones(t) {
    var i, d, u, live = 0;
    for (i = FX.drones.length - 1; i >= 0; i--) {
      d = FX.drones[i];
      u = (t - d.t0) / DRONE_MS;
      if (u >= 1) {
        d.px = d.tx; d.py = d.ty;
        if (!d.landed) {
          d.landed = true; d.carrying = false;
          playSound('drone-drop', { owner: d.owner, x: d.tx, y: d.ty });
        }
        if (u > 1.7) FX.drones.splice(i, 1);
        continue;
      }
      live++;
      d.px = d.x0 + (d.tx - d.x0) * u;
      d.py = d.y0 + (d.ty - d.y0) * u;
      var h = Math.atan2(d.ty - d.py, d.tx - d.px);
      if (Math.abs(h - d.heading) > 0.6) {
        d.heading = h;
        playSound('drone-turn', { owner: d.owner, x: Math.round(d.px), y: Math.round(d.py) });
      }
    }
    if (!live) { stopLoop('drone:0'); stopLoop('drone:1'); }
  }

  /* --------------------------------------------------------------- the shots
     A shot is fired on a sim tick and the machine has to WIND UP for it, so
     the page hands the renderer a fire time in the future and hangs all three
     sounds on the same clock: wind up now, release at the fire time, impact
     when the pod lands. */

  function ownerOfCell(sess, cell) {
    var m = structMap(sess);
    if (!m || typeof m.get !== 'function') return -1;
    var v = m.get(cell);
    return (v && typeof v.owner === 'number') ? v.owner : -1;
  }

  function spawnShot(sess, sh, t) {
    var from = sh && sh.from, to = sh && sh.to;
    if (typeof from !== 'number' || typeof to !== 'number') return;
    var owner = ownerOfCell(sess, from);
    FX.shots.push({
      from: from, to: to, owner: owner, t0: t,
      windMs: WIND_MS, flyMs: FLIGHT, wid: sh.wid,
      hitKind: (sh.wid === undefined || sh.wid === null) ? 'ground' : 'creature',
      released: false, landed: false
    });
    if (FX.shots.length > 24) FX.shots.shift();
    /* the walkthrough's wave beat watches the machine that throws, so the
       throw itself plays inside the close up (build spec v3 s7.9 ruling 3c) */
    if (tourLoupeOn && tourOn && loupe.src === 'tour' && loupe.cell !== from) {
      openLoupe(from, 'tour');
    }
    /* ONE windup per shot (ruling 9). It used to be played here AND from
       soundsFor(ev.shots) through emitSounds: 460 calls for 230 shots, 227 of
       them cooldown-dropped. The batched one is the one that keeps, because
       it is the one the volley law can coalesce. */
  }

  /* is a live body standing on that tile right now */
  function bodyOnCell(sess, cell) {
    var ws = sess && sess.ws, list = ws && (ws.walkers || ws.live), i, w, c;
    if (!list || typeof cell !== 'number' || cell < 0) return false;
    for (i = 0; i < list.length; i++) {
      w = list[i];
      if (!w || (typeof w.hp === 'number' && w.hp <= 0)) continue;
      c = (typeof w.cell === 'number') ? w.cell
        : (typeof w.x === 'number' ? cellOf(w.x, w.y) : -1);
      if (c === cell) return true;
    }
    return false;
  }

  function stepShots(t) {
    var i, s;
    for (i = FX.shots.length - 1; i >= 0; i--) {
      s = FX.shots[i];
      if (!s.released && t >= s.t0 + s.windMs) {
        s.released = true;
        playSound('release', { owner: s.owner, x: cx(s.from), y: cy(s.from) });
      }
      if (!s.landed && t >= s.t0 + s.windMs + s.flyMs) {
        s.landed = true;
        /* SEAM P3-S1, and the reason `impact-ground` was never heard. Core
           never emits a shot without a walker id: `_turrets_fire` only ever
           names a body, so a voice picked from the LAUNCH record could only
           ever be `impact-creature` and the pinned ground voice had no live
           trigger at all. Spec 4.2 defines it as "pod lands on an empty tile",
           which is a fact about the TILE at the moment the pod arrives, not
           about the record that launched it: the pod is in the air for
           windMs + flyMs, and in that time the body it was thrown at can fall
           to that very shot or walk on. So the voice is resolved here, off the
           live board.
           The GEOMETRY is deliberately NOT touched. `hitKind` is fixed at
           spawn and the renderer reads it to place the impact point, so
           flipping it in flight would move where the pod is going and the shot
           would jump. Only the sound follows the tile. */
        s.onBody = s.hitKind === 'creature' && bodyOnCell(S, s.to);
        playSound(s.onBody ? 'impact-creature' : 'impact-ground',
                  { owner: s.owner, x: cx(s.to), y: cy(s.to) });
      }
      if (t > s.t0 + s.windMs + s.flyMs + 1800) FX.shots.splice(i, 1);
    }
  }

  /* ------------------------------------------------------------------ layout */

  function sizeNow() {
    return {
      w: document.documentElement.clientWidth || window.innerWidth,
      h: document.documentElement.clientHeight || window.innerHeight
    };
  }

  function cornerBandRect() {
    var els = [byId('theme-toggle'), byId('life-link')], i, r;
    var top = Infinity, left = Infinity, right = -Infinity, bottom = -Infinity;
    for (i = 0; i < els.length; i++) {
      if (!els[i]) continue;
      r = els[i].getBoundingClientRect();
      if (!r.height) continue;
      if (r.top < top) top = r.top;
      if (r.left < left) left = r.left;
      if (r.right > right) right = r.right;
      if (r.bottom > bottom) bottom = r.bottom;
    }
    if (!isFinite(top)) return null;
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  function rectOf(id) {
    var el = byId(id);
    if (!el) return null;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  var panelOpen = true;
  var layoutOpts = null;

  /* ------------------------------------------------------------ the camera
     Phones give up seeing the whole board during a wave and get legibility in
     exchange (D5 7.8): the renderer's own follow camera at desktop scale, with
     an overview inset in the corner that gives the rest back. Desktop never
     follows: the whole board already fits. */
  var cam = {
    x: (RC ? RC.SRCW : 740) / 2, y: (RC ? RC.SRCH : 356) / 2,
    tx: (RC ? RC.SRCW : 740) / 2, ty: (RC ? RC.SRCH : 356) / 2, hold: 0,
    /* Build spec v3 s7.15 ruling 5: a TAP never moves the camera, a DRAG does,
       and the overview inset carries a button that gives the follow camera
       back. While manual is set the follow camera stands down, so a visitor
       who dragged somewhere is not fought by the page. */
    manual: false
  };

  function phone() { return cssW < 700; }
  /* a device whose primary pointer is a finger, asked once: a tablet is not a
     phone by width and still cannot hover (the hint label, s7.20 round) */
  var coarseMemo = null;
  function touchFirst() {
    if (coarseMemo === null) {
      coarseMemo = false;
      try {
        coarseMemo = !!(window.matchMedia &&
                        window.matchMedia('(pointer: coarse)').matches);
      } catch (e) { coarseMemo = false; }
    }
    return phone() || coarseMemo;
  }

  /* s7.21 ruling 10: the desktop status told a visitor with a mouse to "Tap a
     tile". The verb follows the pointer, asked through the same test the hint
     label already uses, so a tablet keeps "Tap" and a 1440 px mouse gets
     "Click". */
  function tapWord() { return touchFirst() ? 'Tap' : 'Click'; }
  function tapWordLower() { return touchFirst() ? 'tap' : 'click'; }

  /* ---- the phone board at a real phone's pixel ratio (s7.17 ruling 1) ------
     Every phone number this project had was taken at deviceScaleFactor 1,
     which is the harness convention, and there one source pixel per DEVICE
     pixel draws the 740 x 356 board at 740 css px and the page crops it to the
     window. A real handset is dpr 2 or 3 (the page caps its own ratio at 2),
     and there the same floor draws the WHOLE board at 370 x 178 css px.
     The ruling: a whole-board act picks the largest INTEGER device scale whose
     board fits across the viewport, and only when no integer fits (dpr 1, a
     harness case) does the cropped view with its minimap remain. Pixel art
     never runs on a fractional scale. */
  var PHONE_MG = 8;                  /* the renderer's own phone margin */
  function srcWpx() { return (RC && RC.SRCW) ? RC.SRCW : 740; }

  /* the largest integer device scale whose whole board fits across the page,
     or 0 when none does (dpr 1 at 390 css px: 374 device px against 740) */
  function phoneIntS(d) {
    var k = d || dpr;
    return Math.max(0, Math.floor(((cssW - PHONE_MG * 2) * k) / srcWpx()));
  }

  /* whether what is on screen right now IS the whole board at a phone width */
  function phoneWhole() {
    return phone() && !!view && !view.fallback && !following() &&
           phoneIntS(view.dpr) >= 1 && (view.bw || 0) <= cssW + 0.5;
  }

  /* The renderer's ladder prefers a quarter step and falls back to an exact
     fit, so at some phone widths it lands on a FRACTIONAL scale. The page asks
     for the integer instead by reserving the surplus width, and phoneCentre
     then puts the board back in the middle of the page and drops the reserve
     again, so the reserve only ever NAMES the scale and is never a column
     anything is drawn in. At 390 x 844 dpr 2 the ladder already lands on
     S = 1, the reserve is the 4 px of surplus, and the finished view is
     byte-identical to the one before this ruling. */
  function phoneReserve(opts) {
    if (!phone() || opts.follow) return undefined;
    var n = phoneIntS(opts.dpr);
    if (n < 1) return undefined;
    var res = Math.round(cssW - PHONE_MG * 2 - (n * srcWpx()) / opts.dpr);
    return (res > 0 && res <= cssW - 200) ? res : undefined;
  }

  function phoneCentre(v, opts) {
    if (!v || v.fallback || !opts.reserveRight) return v;
    var d = Math.max(1, v.dpr || 1);
    var shift = Math.round((opts.reserveRight / 2) * d);
    v.ox += shift / d;
    if (v.dev) v.dev.ox += shift;
    if (v.board) v.board.x += shift / d;
    v.reserve = 0; v.panelX = cssW; v.panelW = 0;
    return v;
  }

  /* ---- the board sits under the chrome (s7.17 ruling 4, s7.15 ruling 5) ----
     The renderer centres the board between the pads and clamps EACH pad at
     half the viewport, and at 390 x 844 dpr 2 landing the board on its 36 px
     band wants a bottom pad of 443 against that clamp of 422, so landBias runs
     out of room and leaves 46 px above the board where the bar is 40. The page
     therefore slides the finished view up by the surplus, in whole DEVICE
     pixels so the blit stays on the pixel grid, and the board caption slides
     with it because it is the BOARD's caption. At dpr 1 the clamp is never
     reached and the lift is zero, so the cropped path is untouched. */
  var capLift = 0;
  /* the lift the RESTING (whole board) view asks for, kept so the caption can
     be eased between the two framings instead of teleporting (s7.21 ruling 2) */
  var capLiftRest = 0;
  /* and the bottom pad the RESTING view used, for the same reason on the
     desktop, where the lift is always 0 and the pad is what moves */
  var capPadRest = 0;
  /* and the RESTING picture's own foot, which is what the phone caption is
     dropped below (the follow view's height is the whole source at S = 3) */
  var picBotRest = 0;
  /* s7.26 ruling 5: the RESTING board FRAME's foot (bezel and all, which is
     what the keep's health meter is drawn inside), which the desktop caption
     row is placed below */
  var frameBotRest = 0;
  /* s7.28 ruling 6: and the RESTING frame's left edge, so the keep badge has
     ONE home per act instead of a home that travels with the framed wave */
  var frameLeftRest = 0;
  /* s7.29 ruling 1: the resting bezel's thickness in css px */
  var frameBezRest = 0;

  function phoneLift(v, opts) {
    var gal = galleryAct() && !opts.landAnyway;
    capLift = 0;
    if (!v || v.fallback || !phone() || opts.follow || gal) {
      if (!phone() || gal) { capLiftRest = 0; picBotRest = 0; }
      return v;
    }
    var lift = v.oy - (opts.topPad + LAND_BAND);
    /* (s7.24 ruling 4 was first blamed on this lift and it was not the cause:
       the dead band under the phone caption came from the caption being placed
       against landBias's own bottom pad rather than the room the page's chrome
       needs. The lift is unchanged; captionGeom's `layoutPadBot` is the fix.) */
    if (!(lift > 0.5)) { capLiftRest = 0; picBotRest = v.oy + (v.bh || 0); return v; }
    var d = Math.max(1, v.dpr || 1);
    var dev = Math.floor(lift * d);
    if (dev < 1) { capLiftRest = 0; picBotRest = v.oy + (v.bh || 0); return v; }
    capLift = dev / d;
    capLiftRest = capLift;
    picBotRest = (v.oy - capLift) + (v.bh || 0);
    v.oy -= capLift;
    if (v.dev) v.dev.oy -= dev;
    if (v.board) v.board.y -= capLift;
    return v;
  }

  /* The reader act is deliberately NOT followed: its whole point is the guess
     beside the wall, and a follow camera would take the wall away from it. */
  function following() { return follow.k > 0; }
  /* the inset, the recenter button and the pan gesture belong to the ENGAGED
     camera, not to the 300 ms it takes to get there (s7.19 ruling 4) */
  function followFull() { return follow.k >= 0.999; }
  function srcOfCell(cell) {
    var G = RAPI && RAPI.GEO;
    if (!G || cell < 0) return null;
    try { return { x: G.colX(cx(cell)), y: G.groundY(cy(cell)) }; } catch (e) { return null; }
  }
  /* a beat worth looking at (a body dying, a breach) takes the camera for
     900 ms; the standing target is the middle of the fight */
  function panTo(cell) {
    var p = srcOfCell(cell);
    if (!p || cam.manual) return;
    cam.tx = p.x; cam.ty = p.y; cam.hold = now() + 900;
  }
  function aimCamera(t) {
    if (!following() || cam.manual) return;
    /* s7.30 ruling 4: under reduced motion the camera has no beat to hold:
       it lands on the fight once per Step press (easeCamera snaps), and a
       held beat would only move it again, later, with no input */
    if (t < cam.hold && !reducedMotion()) return;
    var st = renderState(S), i, n = 0, sx = 0, sy = 0, p;
    for (i = 0; i < st.walkers.length; i++) {
      p = srcOfCell(st.walkers[i].cell);
      if (!p) continue;
      sx += p.x; sy += p.y; n++;
    }
    if (!n) return;
    cam.tx = sx / n; cam.ty = sy / n;
  }
  /* Build spec v3 s7.19 ruling 4: the follow camera's per-frame retarget is
     CAPPED AT 12 SCREEN PIXELS, with the easing kept. The auditor measured
     p95 29.3 px and a max of 53.7 px between two drawn frames on a phone whose
     frame interval was itself running long, so one retarget could throw the
     whole scene half a screen sideways. The cap is applied in SCREEN pixels
     (the thing a visitor sees) and converted back into the source pixels the
     camera is kept in, so it holds at every scale and ratio. */
  var CAM_MAX_STEP = 12;

  function easeCamera() {
    if (!isFinite(cam.tx)) return;
    /* s7.30 ruling 4: reduced motion snaps, the page's own law for the
       camera's engagement (stepFollow) applied to its pan: on a phone Step
       wave the window otherwise glided after every press for most of the hold */
    if (reducedMotion()) { cam.x = cam.tx; cam.y = cam.ty; return; }
    var dx = (cam.tx - cam.x) * 0.12, dy = (cam.ty - cam.y) * 0.12;
    var k = (view && view.S > 0 && view.dpr > 0) ? (view.S / view.dpr) : 1;
    var d = Math.sqrt(dx * dx + dy * dy) * k;
    if (d > CAM_MAX_STEP) {
      var f = CAM_MAX_STEP / d;
      dx *= f; dy *= f;
    }
    cam.x += dx;
    cam.y += dy;
  }

  /* s7.24 ruling 4: the act row sticks UNDER the head, so its own sticky
     offset is the head's measured height rather than a number in the sheet */
  var pinTopPx = -1;
  function syncPanelPin() {
    var head = document.querySelector('.kit-panel__head'), pin = byId('kit-panel-pin');
    if (!head || !pin) return;
    var h = Math.round(head.getBoundingClientRect().height);
    if (h > 0 && h !== pinTopPx) { pinTopPx = h; pin.style.top = h + 'px'; }
  }

  function layout() {
    var s = sizeNow();
    cssW = s.w; cssH = s.h;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv) {
      cv.style.width = cssW + 'px';
      cv.style.height = cssH + 'px';
      var pw = Math.max(1, Math.round(cssW * dpr)), ph = Math.max(1, Math.round(cssH * dpr));
      if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    }
    syncPanelPin();
    /* s7.27 ruling 1: a resize is the other way the row's home can change
       (the phone's act bar appears and disappears at 600 px, and the panel's
       own window grows and shrinks with the viewport). buildHome costs one
       parent check outside Your turn and nothing at all once it has settled. */
    buildHome();
    var band = cornerBandRect(), chat = rectOf('chat-widget'), p = rectOf('kit-panel');
    boxes.corner = band; boxes.chat = chat; boxes.panel = p;
    /* ---- s7.24 ruling 4: the strip is anchored BEFORE the card is placed ---
       The act strip's own bottom comes from the site chrome alone
       (stripBottomPx reads the corner band and the chat bar), so it does not
       depend on the card; the CARD rides above the strip, so it does. Placing
       the card first and the strip afterwards left the card sitting above a
       strip that was no longer there, and the bottom pad was then computed
       from that stale card: at 390x844 with the walkthrough up the pad ended
       53 px above the card, which is the dead band the light reduced-motion
       judge measured between the caption and the tour card. One line moved. */
    if (actbar) placeActbar(band, chat);
    /* the walkthrough strip is placed BEFORE the board is laid out, and the
       band it needs comes out of the board's own room, so the card and the
       board can never overlap (build spec v3 s7.15 ruling 1) */
    placeCoach();
    boxes.coach = (coachEl && !coachEl.hidden) ? rectOf('kit-coach') : null;

    var topPad = cssW < 700 ? 96 : 132;
    /* a collapsed panel over the board still pushes the top down: the phone
       hidden top row fix from /fourinarow/ */
    if (p && cssW < 600 && p.y < 260) topPad = Math.max(topPad, p.y + p.h + 10);

    var botPad = 24;
    if (band) botPad = Math.max(botPad, cssH - band.y + 10);
    if (chat) botPad = Math.max(botPad, cssH - chat.y + 10);
    /* the walkthrough card is placed ABOVE the strip, so its own contribution
       to the bottom pad moves with the strip and cannot be handed to the wrap
       decision as a fixed number: syncActbarWrap re-derives it per candidate
       from the card's height alone */
    var botPadNoCoach = botPad;
    /* how many rows the phone act strip takes is decided BEFORE the bar is
       measured, from probes that never read the bar's own position, so the
       decision cannot feed back into itself (build spec v3 s7.16 ruling 5).
       It reads the card's HEIGHT, which placeCoach does not change, so the
       stale placement above is safe to decide from; if the decision moves the
       strip, the card is put back before its rect is used for anything. */
    if (actbar && syncActbarWrap(topPad, botPadNoCoach, band, chat)) {
      /* s7.26 ruling 12: the row has just become a one line scroller (or
         stopped being one), so the act the visitor is IN has to be put back on
         screen in the new shape. Without this the ruling-6 refusal above left
         a phone reader looking at "Sound on / Watch a wave / Six plans / Stra"
         with their own act off the right hand end. */
      scrollActIntoView();
      if (coachEl && !coachEl.hidden) {
        placeCoach();
        boxes.coach = rectOf('kit-coach');
      }
    }
    if (boxes.coach) botPad = Math.max(botPad, cssH - boxes.coach.y + 12);
    boxes.actbar = actbar ? actbar.getBoundingClientRect() : null;
    if (actbar && boxes.actbar && boxes.actbar.height) {
      botPad = Math.max(botPad, cssH - boxes.actbar.top + 10);
    }
    /* s7.26 ruling 5: an act that draws a board keeps a caption row under it,
       ON TOP of whatever the chrome and the walkthrough card already ask for.
       Where `landBias` has slack it gives the row back anyway and this changes
       nothing (Watch a wave and Your turn settle at the same 190 px bottom pad
       either way, measured); where it has none, which is Reading the plan with
       its bar band, this is the room the row stands in. It is taken BEFORE the
       bars' band is sized, so the two cannot both claim it. Not applied to a
       gallery: those lay their own grid out in this room. */
    if (!galleryAct() && !phone()) botPad += CAP_ROW_H;
    topPad = Math.max(0, Math.min(topPad, cssH * 0.5));
    botPad = Math.max(0, Math.min(botPad, cssH * 0.5));

    layoutOpts = { dpr: dpr, panelOpen: panelOpen, topPad: topPad, botPad: botPad };
    applyView();
    /* view.board is the real tile plate: view.cell * ROWS overstates the
       height by about 1.6x because the rows are foreshortened (R1-S2) */
    boxes.board = view.board ||
      { x: view.ox, y: view.oy, w: view.bw || 0, h: view.bh || 0 };
    if (actbar) { placeActbar(band, chat); syncActbarOverflow(); }
    syncModalChrome();          /* s7.26 ruling 9 */
    syncPanelCue();
    if (recenterOn) placeRecenter();
    syncStepBtn();
    if (window.GadgetUI && GadgetUI.placeHints) GadgetUI.placeHints();
    pushAudioView();
  }

  /* The view is rebuilt from the cached pads whenever the camera moves, which
     is once a frame while a phone is following. Only the renderer's own
     arithmetic runs here: the DOM rects are measured in layout(), never per
     frame. */
  function viewFor(opts) {
    var v = null;
    if (R && R.layout) { try { v = R.layout(cssW, cssH, opts); } catch (e) { v = null; } }
    return v;
  }

  function applyView() {
    var o = layoutOpts || { dpr: dpr, panelOpen: panelOpen, topPad: 120, botPad: 96 };
    var opts = { dpr: o.dpr, panelOpen: o.panelOpen, topPad: o.topPad, botPad: o.botPad };
    if (following()) {
      opts.follow = true;
      opts.followX = cam.x;
      opts.followY = cam.y;
    }
    /* ---- the bar block's slot (build spec v3 s7.15 ruling 3) --------------
       The whole band a live act could ever need is reserved for the act, not
       for the moment the bars happen to exist, so switching partner inside
       Your turn cannot move the board under the visitor's hand. Between acts
       the band EASES rather than snapping: the audit measured a hard 91 px
       jump of the whole board in one frame, on a page where every other
       camera move eases. Reduced motion snaps, which is the right answer
       there. */
    barsBand.want = barsBandFor(o, opts);
    /* The band's ease is advanced ONCE PER ANIMATION FRAME, by stepBarsBand()
       in the loop, and never here: layout() and the frame loop both call
       applyView, and two advances inside one painted frame are exactly where
       the old 71 px first step came from (0.22 of the band, taken twice before
       anything was drawn). applyView only READS the band now. Reduced motion
       still snaps, which is the right answer there. */
    if (reducedMotion()) bandSnap();
    /* s7.21 ruling 10, MEASURED AND NOT TAKEN. Spending this band on the
       BOTTOM pad was tried, to hold the board's top edge at one value across
       acts: it does not work and the arithmetic says why. `landBias` spends
       slack by raising the bottom pad until the board sits LAND_BAND under the
       top pad, so with the bars above the board its top edge is
       `topPad + band + (BEZ + PLATE_TOP) * S`, and with the bars below it the
       room under the board at 1440x900 is the 190 px the caption and the page
       chrome already own. The two are equal only when the band is 36 px, which
       is a quarter of the smallest readable bar plate (BARS_MIN_H 124). Held
       here as the shipped arrangement, and reported as not met. */
    if (barsBand.h > 0) opts.topPad = o.topPad + barsBand.h;
    /* s7.17 ruling 1: the integer device scale is asked for BEFORE the view is
       built, so landBias and the lift both work on the scale that ships */
    opts.reserveRight = phoneReserve(opts);
    view = builtView(opts);
    /* ---- the follow camera's ENGAGEMENT (s7.19 ruling 4) -----------------
       The auditor caught the phone cutting to the follow camera in ONE FRAME
       at 5.7 s into the landing, with no input: the scale went 1 to 3, the
       caption plate teleported 163 px and the act's own prose card vanished
       mid sentence. The engagement is now a 300 ms ease, and it is built by
       LERPING BETWEEN THE TWO VIEWS THE RENDERER ITSELF RETURNS rather than by
       inventing a third layout: at k = 0 and k = 1 this is byte for byte the
       view that shipped, and in between the source window, the scale and the
       blit destination move together, so the hit test never disagrees with
       the picture. */
    if (follow.k > 0 && follow.k < 1) {
      var rest = { dpr: opts.dpr, panelOpen: opts.panelOpen, topPad: opts.topPad,
                   botPad: opts.botPad, reserveRight: opts.reserveRight };
      var vRest = builtView(rest);
      if (vRest && view && !vRest.fallback && !view.fallback) {
        view = lerpView(vRest, view, followEase(follow.k));
      }
    }
    /* s7.21 ruling 2: THE CAPTION PLATE NEVER TELEPORTS. The board's caption
       rides the phone lift, and the lift is 0 under the follow camera, so the
       frame the engagement REACHED its end moved the plate 153 px in one frame
       while every other thing on the page eased. It is eased with the same
       curve the two views are, so the plate travels with the picture it
       belongs to. */
    if (phone()) capLift = capLiftRest * (1 - followEase(follow.k));
    /* the bottom pad the caption is placed from when the camera is at rest */
    if (follow.k <= 0) capPadRest = capPadNow();
    /* s7.26 ruling 5: the caption ROW sits below the board's bottom edge, and
       the edge it is measured against is the RESTING picture's. Under the
       desktop framed wave (s7.21 ruling 9) the view is the whole source at
       S = 2 with most of it outside the viewport, so reading the live frame
       would swing the row by 80 px at the engage and back, which is the one
       thing s7.21 ruling 2 forbids the plate. */
    if (follow.k <= 0) {
      frameBotRest = (view.oy || 0) + (view.bh || 0);
      frameLeftRest = (view.ox || 0);            /* s7.28 ruling 6 */
      /* s7.29 ruling 1: and the RESTING bezel's own thickness, so the badge
         stands clear of the drawn frame instead of on it (s7.28 ruling 2's
         law, applied to the one control that lives inside the picture) */
      frameBezRest = (RC ? RC.BEZ : 6) * (view.S || 1) / Math.max(1, view.dpr || 1);
    }
    barsBand.on = barsBand.h >= BARS_MIN_H;
    barsBand.top = o.topPad;
    boxes.board = view.board ||
      { x: view.ox, y: view.oy, w: view.bw || 0, h: view.bh || 0 };
  }

  /* one view, through the whole ladder the page applies to every view */
  function builtView(opts) {
    var v = viewFor(opts) || fallbackView(opts.topPad, opts.botPad);
    /* ---- the landing band (build spec v3 s7.15 ruling 5) ------------------
       At 1440x900 the frame is WIDTH limited (the panel reserve takes a third
       of the page), so the renderer's centred fit left 91 px of empty page
       above the board and the same below: two lanes counted about 140 px of
       dead space above it and called the landing inert before anything had
       moved. The board cannot be made wider without running under the panel,
       so the slack is spent BELOW the board instead of split, which puts the
       gate mouths the attackers come through near the top of the stage where
       the eye lands, and leaves the room under the board for the caption and
       the walkthrough strip, which both live there. The board is never made
       smaller to buy this. */
    v = landBias(v, opts);
    v = phoneLift(v, opts);
    v = phoneCentre(v, opts);
    if (opts.follow && !phone()) v = framedView(v, opts);
    else if (opts.follow && phone()) v = phoneFramed(v, opts);
    return v;
  }

  /* ---- the board's top edge, for an act that draws no board ----------------
     Build spec v3 s7.22 ruling 3. The two galleries centred their picture in
     the stage and landed at 283 while Watch a wave and Your turn both put the
     board's top edge at 228, so an act change moved the horizon by 55 px for
     no reason a visitor could name. The galleries now START at that same edge
     whenever their own caption row leaves the room for it.

     The value cannot be read off `view` inside a gallery: landBias and
     phoneLift are the two steps that lift a live board onto its band and both
     of them stand down in a gallery act. So the page asks for the view it
     WOULD have laid out, through the same ladder, with the gallery exemption
     lifted, and caches it by the size it was computed at (this runs once per
     layout, never per frame). phoneLift writes three module values as a side
     effect of its real call, so the probe saves and restores them: a measuring
     call must not move the caption the painting call placed. */
  var topEdge = { key: '', y: null };

  function boardTopEdge() {
    if (!RC || !layoutOpts) return null;
    var o = layoutOpts;
    var key = [Math.round(cssW), Math.round(cssH), o.dpr, o.panelOpen ? 1 : 0,
               Math.round(o.topPad), Math.round(o.botPad)].join('|');
    if (topEdge.key === key) return topEdge.y;
    var opts = { dpr: o.dpr, panelOpen: o.panelOpen, topPad: o.topPad,
                 botPad: o.botPad, landAnyway: true };
    opts.reserveRight = phoneReserve(opts);
    var k0 = capLift, k1 = capLiftRest, k2 = picBotRest;
    var v = viewFor(opts), y = null;
    if (v && !v.fallback) {
      v = landBias(v, opts);
      v = phoneLift(v, opts);
      v = phoneCentre(v, opts);
      if (v && !v.fallback) {
        var b = v.board || { y: v.oy };
        y = Math.round(Math.max(v.oy || 0, b.y));
      }
    }
    capLift = k0; capLiftRest = k1; picBotRest = k2;
    topEdge.key = key; topEdge.y = y;
    return y;
  }

  /* ---- the desktop wave framing (build spec v3 s7.21 ruling 9) ------------
     The renderer's own follow branch is phone-only (`phone && opts.follow`),
     and it is not this zone's file, so the page frames the desktop wave with
     the SAME arithmetic `lerpView` already uses to build a view between two of
     the renderer's: one source window, one scale, and every derived field
     (dev, ox/oy, bw/bh, cell, depth, board) computed from that one set, so the
     hit test and the blit cannot disagree. SEAM P14-S1 offers it back to the
     renderer as an `opts.followS` on desktop.

     S is DEVICE pixels per source pixel, the renderer's own unit. */
  var DESK_FOLLOW_S = 2;

  /* ---- s7.28 ruling 6, widened by s7.29 ruling 1: THE BAND THE WINDOW MUST
     HOLD, IN SOURCE PIXELS -------------------------------------------------
     The keep is the score, so the framed wave may not cut it. Its footprint
     is the cells the renderer's own terrain calls keep cells, carried through
     the renderer's own tileX / yb / rowDepth, so a board that moved the
     castle moves this with it.

     s7.29 ruling 1 adds the WIDTH the window needs. A wave is always a fight
     between ONE gate and the keep, so the window has to be able to hold the
     keep together with whichever gate is furthest from it; anything narrower
     and a wave coming through that gate is watched with the score off screen
     or the gate off screen. Measured, not guessed: on this board the keep is
     source x 292 to 396 and the gates are 58 to 136, 344 to 422 and 604 to
     682, so the widest keep-and-one-gate span is 390 source px.
     Cached on the terrain's key. */
  var keepBand = null, keepBandKey = '';
  function keepSrcBand() {
    var key = (RC && RC.MAP_KEY) ? String(RC.MAP_KEY) : '-';
    if (keepBandKey === key && keepBand !== null) return keepBand;
    keepBandKey = key;
    keepBand = null;
    var G = RAPI && RAPI.GEO;
    if (!G || !G.keep || !G.yb || !G.rowDepth || !G.tileX || !RC) return null;
    var K = null;
    try { K = G.keep(); } catch (e) { K = null; }
    if (!K || !isFinite(K.r0) || !isFinite(K.r1)) return null;
    var t0 = G.yb(K.r0) + RC.BEZ;
    var t1 = G.yb(K.r1) + G.rowDepth(K.r1) + RC.BEZ;
    if (!isFinite(t0) || !isFinite(t1) || !(t1 > t0)) return null;
    var l0 = G.tileX(K.c0) + RC.BEZ;
    var l1 = G.tileX(K.c1) + RC.TW + RC.BEZ;
    if (!isFinite(l0) || !isFinite(l1) || !(l1 > l0)) return null;
    var wide = l1 - l0, gates = (RC.GATES || []), i, g, gl, gr;
    for (i = 0; i < gates.length; i++) {
      g = gates[i];
      if (!g || !isFinite(g.c0) || !isFinite(g.c1)) continue;
      gl = G.tileX(g.c0) + RC.BEZ;
      gr = G.tileX(g.c1) + RC.TW + RC.BEZ;
      if (!isFinite(gl) || !isFinite(gr)) continue;
      wide = Math.max(wide, Math.max(l1, gr) - Math.min(l0, gl));
    }
    keepBand = { top: t0, bot: t1, left: l0, right: l1, wide: wide };
    return keepBand;
  }

  /* ---- s7.29 ruling 1: THE FRAMED VIEW STAYS IN THE BOX --------------------
     Wave 1t let S stay at 2 and grew the framed WINDOW instead: at 1440x900
     the picture went from 506 px tall to 578 and moved 36 px up, so the fixed
     bottom row (the seat legend, the caption plate, the Budget chip) and the
     keep plate, all of which are placed against the RESTING picture, were
     drawn on live terrain with the board's own edge crossing them, and the
     crop took the frame off all four sides. Both visitor lanes called it
     broken on the frame the page most wants watched, and they were right.

     The destination rect IS the box handed in (the resting board's box on the
     desktop, the phone follow camera's own stage on a phone). The window and
     the scale are derived from that box and never the other way round, so a
     framed wave cannot move one pixel of page furniture. Where S0 cannot hold
     the band inside the box, S eases DOWN the renderer's own quarter step
     ladder until it can. */
  function refitFramed(v, box, S0, restS, opts) {
    if (!v || v.fallback || !RC || !box || !(box.w > 0) || !(box.h > 0)) return v;
    var d = Math.max(1, v.dpr || 1);
    var SW = RC.SRCW, SH = RC.SRCH, BEZ = RC.BEZ, TW = RC.TW;
    var PT = RC.PLATE_TOP, PB = RC.PLATE_BOT;
    var S = S0;
    var band = keepSrcBand();
    /* s7.32 addendum 3 item 1 (the round-9 critic's B1): the band starts at
       the top of the DRAWN FIGHT, the sky band over row 0 (source y BEZ),
       where the gates, the catapults' arms and pods, the walkers and the
       shots stand above their own cells. It started at the plate's first row
       (BEZ + PT), so at S 1.75 the fight at the gates was drawn above the
       picture's top edge in every framed wave. */
    var needTop = BEZ, needBot = band ? band.bot : (BEZ + PB);
    var needH = Math.max(60, needBot - needTop);
    var needW = Math.max(80, band ? band.wide : 0);
    /* the largest quarter step that holds the band in BOTH axes */
    if (band) {
      var qh = Math.floor((box.h / needH) * 4) / 4;
      var qw = Math.floor((box.w / needW) * 4) / 4;
      var q = Math.min(qh, qw);
      if (q < S) S = Math.max(1, q);
    }
    /* a framing that is no closer than the resting view is not a framing */
    if (!(S > (restS || 1) + 0.001)) return v;
    var fw = Math.max(80, Math.min(SW, Math.floor(box.w / S)));
    var fh = Math.max(60, Math.min(SH, Math.floor(box.h / S)));
    /* a window that already holds the whole source is not a framing */
    if (fw >= SW && fh >= SH) return v;
    var tx = isFinite(opts.followX) ? opts.followX : SW / 2;
    var ty = isFinite(opts.followY) ? opts.followY : SH / 2;
    var fx0 = Math.round(Math.max(0, Math.min(SW - fw, tx - fw / 2)));
    var fy0 = Math.round(Math.max(0, Math.min(SH - fh, ty - fh / 2)));
    /* ---- s7.28 ruling 6: and the window is placed so the keep is whole ----
       The window's own placement is clamped into the interval that holds the
       keep's footprint, on both axes since s7.29 ruling 1, and where the
       fight sits ABOVE that window the slack goes to the keep's side rather
       than above the band's own top (needTop: since s7.32 addendum 3 the sky
       band's top, where the gates and the walkers are drawn; nothing is drawn
       above it but the bezel), and the castle is drawn at the bottom of the
       last row. The mapping is continuous in the camera's own y, so this
       cannot add a step to the follow pan. */
    if (band) {
      var lo = Math.max(0, band.bot - fh);
      var hi = Math.min(SH - fh, band.top);
      if (hi < lo) hi = lo;                 /* the keep wins */
      var want = Math.max(lo, Math.min(hi, fy0));
      var floorTopRow = Math.min(hi, Math.max(lo, needTop));
      if (want < floorTopRow) want = floorTopRow;
      fy0 = Math.round(want);
      var xlo = Math.max(0, band.right - fw);
      var xhi = Math.min(SW - fw, band.left);
      if (xhi < xlo) xhi = xlo;             /* the keep wins here too */
      fx0 = Math.round(Math.max(xlo, Math.min(xhi, fx0)));
    }
    var wDev = Math.max(1, Math.round(fw * S)), hDev = Math.max(1, Math.round(fh * S));
    /* the picture is CENTRED IN THE BOX and never larger than it: the window
       is a whole number of source pixels, so up to S device pixels of the box
       are left over and they are split between the two edges */
    if (wDev > box.w) wDev = box.w;
    if (hDev > box.h) hDev = box.h;
    var oxDev = Math.round(box.ox + (box.w - wDev) / 2);
    var oyDev = Math.round(box.oy + (box.h - hDev) / 2);
    var out = {}, k;
    for (k in v) { if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = v[k]; }
    out.S = S; out.fw = fw; out.fh = fh; out.fx0 = fx0; out.fy0 = fy0;
    out.dev = { ox: oxDev, oy: oyDev, w: wDev, h: hDev };
    out.ox = oxDev / d; out.oy = oyDev / d;
    out.bw = wDev / d; out.bh = hDev / d;
    out.cell = TW * S / d;
    out.depth = 16 * S / d;
    out.board = { x: out.ox + (BEZ - fx0) * S / d,
                  y: out.oy + (BEZ + PT - fy0) * S / d,
                  w: COLS * TW * S / d,
                  h: (PB - PT) * S / d };
    return out;
  }

  /* the DESKTOP framing: the box is the resting board's own box, so the
     picture a framed wave draws stands exactly where the resting one does */
  function framedView(v, opts) {
    if (!v || v.fallback || !v.dev) return v;
    return refitFramed(v, v.dev, DESK_FOLLOW_S, v.S || 1, opts);
  }

  /* ---- s7.29 ruling 2: THE PHONE WAVE IS READABLE -------------------------
     The renderer's phone follow branch pins S = 3, and at 390x844 dpr 2 that
     is a 249 x 277 source window: the keep's own rows are 268 to 326, so the
     score sat below the window's foot in every frame of every wave, and both
     lanes said they could not tell whether they were winning. The phone takes
     the same law the desktop does, in the phone's own stage: the largest
     quarter step that holds the plate's first row down to the keep's last and
     the keep beside the furthest gate. On this board at 390x844 that is 1.75,
     which draws the WHOLE board height (the top and bottom of the frame come
     back with it) at 1.75 device pixels per source pixel against the resting
     1, with 426 of the 740 source columns on screen. */
  function phoneFramed(v, opts) {
    if (!v || v.fallback || !v.dev || !phone()) return v;
    var rest = Math.max(1, phoneIntS(v.dpr));
    return phoneCapClear(v, refitFramed(v, v.dev, v.S || 3, rest, opts), rest, opts);
  }

  /* ---- s7.30 ruling 1: THE PHONE PLATE CLEARS THE PICTURE IN EVERY ACT ----
     Ship gate round 8 (audit M1, verify M1): in Your turn the caption plate
     lay across the framed picture's foot and its bottom frame border in every
     framed frame, 26.2 px over with one line and 44.2 with two (plate top
     450.8 or 432.8 against a foot at 477). The stage handed to the framing ran
     down to the act strip, and under the follow camera the plate stands on the
     view's own bottom pad (captionGeom eases its drop to the picture's foot
     away there, which was written for the old S = 3 view that ran off the
     screen). Watch a wave cleared the foot by 19.5 px only because its strip
     is shorter, and a two line caption there would have kept 1.5 px.
     The framed picture's outer foot now stops where the caption's room
     begins: a two line plate standing on the same pad the plate is placed
     from, and CAP_FRAME_CLEAR above it. Where the picture has room in its
     stage it is only LIFTED by its overhang (Watch a wave: a few pixels), and
     only where it has none is the stage cut short (Your turn), in which case
     the framing law works inside the smaller stage exactly as before: the
     window loses rows, the cut bezel is painted back, and the scale comes
     down the quarter ladder only if the keep's band no longer fits. */
  var CAP_PLATE_2L = 2 * 18 + 2 * 7;       /* captionGeom: two lines of 18, pad 7 */
  function phoneCapClear(v, out, rest, opts) {
    if (!out || out === v || !out.dev || !v.dev) return out;
    var b = v.dev, d = Math.max(1, v.dpr || 1);
    var pad = isFinite(v.botPad) ? v.botPad : 0;
    /* the plate's own bottom edge is cssH - pad - 1 (captionGeom) */
    var maxB = Math.floor((cssH - pad - 1 - CAP_PLATE_2L - CAP_FRAME_CLEAR) * d);
    var foot = out.dev.oy + out.dev.h;
    if (!(foot > maxB)) return out;
    var box = (maxB - b.oy >= out.dev.h)
      ? { ox: b.ox, oy: b.oy, w: b.w, h: b.h - 2 * (foot - maxB) }
      : { ox: b.ox, oy: b.oy, w: b.w, h: maxB - b.oy };
    if (!(box.h > 0)) return out;
    return refitFramed(v, box, v.S || 3, rest, opts);
  }

  /* ---- the engagement's own clock ---------------------------------------
     `k` is 0 on the whole board and 1 on the follow camera. Reduced motion
     snaps, which is the right answer there and the same law the bar band
     already follows. */
  var FOLLOW_MS = 300;
  var follow = { k: 0, at: 0, moved: false };

  function followEase(p) { return p * p * (3 - 2 * p); }

  /* s7.21 ruling 9: the desktop follows the fight too. Everything a wave does
     happens in the top 80 px of a 432 px board while the keep and the canyon do
     nothing, and two judges independently called Watch a wave static for 14 s.
     Reduced motion keeps the whole board on the desktop, which is where the
     ruling puts it; the phone's own law is unchanged. */
  function followWanted() {
    if (!S || S.phase !== 'resolve') return false;
    if (!(act.name === 'watch' || act.name === 'you')) return false;
    if (!phone() && reducedMotion()) return false;
    /* ---- s7.24 ruling 3: THE COLD LANDING STAYS WHOLE BOARD ---------------
       s7.17 ruling 1 and Fable's own reading of the dpr 2 capture say the
       whole-board framing is the right one for a phone; the wave's follow
       camera is the exception it makes for the fight. On the very first beat
       of the walkthrough that exception took the landing: the wave starts
       about ten seconds in, the camera crops to S = 3, and the dark judge's
       first impression was a grey field with the castle sliced by the caption
       plate (its own measurement, board box x -348 w 1092, is this view). The
       landing beat keeps the whole board, so the keep, both gate mouths and
       every engineer are on screen while the first card is read. Every camera
       law the round 4 auditor measured is unchanged: the moment the visitor
       presses Next, or an act, the camera behaves exactly as it did. */
    if (phone() && tourOn && tourStep === 0) return false;
    return true;
  }

  /* s7.21 ruling 2: THE WAVE BOUNDARY DOES NOT BOUNCE. The build pause between
     waves is 237 to 747 ms, and the camera used to disengage and re-engage
     inside it: a full zoom out, a full relayout and a card fade, reversed, four
     to six times a session, with no input at all. The camera HOLDS through any
     pause shorter than FOLLOW_HOLD. A game that has ENDED is not a pause and
     releases at once. */
  var FOLLOW_HOLD = 1200;
  var followPauseAt = 0;

  function followHeld(want) {
    if (want) { followPauseAt = 0; return 1; }
    if (!(follow.k > 0)) { followPauseAt = 0; return 0; }
    /* only a build pause between waves is a pause */
    if (!S || S.over || S.phase === 'over' || S.phase !== 'build' ||
        !(act.name === 'watch' || act.name === 'you')) {
      followPauseAt = 0; return 0;
    }
    var t = now();
    if (!followPauseAt) followPauseAt = t;
    return (t - followPauseAt < FOLLOW_HOLD) ? 1 : 0;
  }

  function stepFollow(t) {
    var want = followHeld(followWanted() ? 1 : 0);
    if (reducedMotion()) { follow.k = want; follow.at = t; return; }
    var dt = (follow.at > 0 && t > follow.at) ? Math.min(80, t - follow.at) : 16;
    follow.at = t;
    var step = dt / FOLLOW_MS, was = follow.k;
    if (want > follow.k) follow.k = Math.min(1, follow.k + step);
    else if (want < follow.k) follow.k = Math.max(0, follow.k - step);
    /* the frame the ease REACHES an end still has to lay the view out once */
    if (follow.k !== was) follow.moved = true;
  }

  /* the numeric middle of two views the renderer built. Everything the blit
     and the hit test read is derived from ONE (S, fx0, fw, dev) set, so they
     cannot drift apart while the ease runs. */
  function lerpView(a, b, k) {
    function L(x, y) { return x + (y - x) * k; }
    var d = (b.dpr > 0) ? b.dpr : 1;
    var bez = RC ? RC.BEZ : 6, tw = RC ? RC.TW : 26;
    var pt = RC ? RC.PLATE_TOP : 36, pb = RC ? RC.PLATE_BOT : 340;
    var S = L(a.S, b.S);
    var fw = L(a.fw, b.fw), fh = L(a.fh, b.fh);
    var fx0 = L(a.fx0, b.fx0), fy0 = L(a.fy0, b.fy0);
    var da = a.dev || { ox: a.ox * d, oy: a.oy * d, w: a.bw * d, h: a.bh * d };
    var db = b.dev || { ox: b.ox * d, oy: b.oy * d, w: b.bw * d, h: b.bh * d };
    var v = {}, key;
    for (key in b) { if (Object.prototype.hasOwnProperty.call(b, key)) v[key] = b[key]; }
    v.S = S; v.fw = fw; v.fh = fh; v.fx0 = fx0; v.fy0 = fy0;
    v.dev = { ox: L(da.ox, db.ox), oy: L(da.oy, db.oy), w: fw * S, h: fh * S };
    v.ox = v.dev.ox / d; v.oy = v.dev.oy / d;
    v.bw = v.dev.w / d; v.bh = v.dev.h / d;
    v.cell = tw * S / d;
    v.depth = 16 * S / d;
    v.board = { x: v.ox + (bez - fx0) * S / d,
                y: v.oy + (bez + pt - fy0) * S / d,
                w: COLS * tw * S / d,
                h: (pb - pt) * S / d };
    return v;
  }

  var LAND_BAND = 36;      /* the ruling's bar is 40; this leaves a margin */

  function galleryAct() { return act.name === 'plans' || act.name === 'strangers'; }

  function landBias(v, opts) {
    /* opts.landAnyway is the gallery's own probe asking what the board's top
       edge WOULD be in an act that draws one (s7.22 ruling 3). It never runs
       for a view the page paints through. */
    if (!v || v.fallback || (galleryAct() && !opts.landAnyway)) return v;
    var slack = v.oy - opts.topPad;
    if (!(slack > LAND_BAND)) return v;
    var o2 = { dpr: opts.dpr, panelOpen: opts.panelOpen, topPad: opts.topPad,
               botPad: Math.min(cssH * 0.5, opts.botPad + (slack - LAND_BAND) * 2),
               reserveRight: opts.reserveRight };
    if (opts.follow) { o2.follow = true; o2.followX = opts.followX; o2.followY = opts.followY; }
    var v2 = viewFor(o2);
    /* never buy the framing with a smaller board */
    return (v2 && v2.bh >= v.bh - 1 && v2.bw >= v.bw - 1) ? v2 : v;
  }

  /* ---- the reader's plan bars own a band (build spec v3 s7.8 ruling 4a) ----
     At desktop widths the band is taken out of the top pad BEFORE the board is
     laid out, so the board frame starts under it and no bar is ever drawn on
     the board. The band is never bigger than the slack the board is not using,
     so reserving it costs the board nothing; if there is not enough slack for
     the smallest readable plate the band is refused and the bars fall back to
     the phone treatment rather than shrinking the board.
     On a phone there is no slack to take and the follow camera fills the
     screen, so the bars stay over the board and every pixel of their text
     stands on a plate, which is what the ruling asks for there. */
  var barsBand = { on: false, top: 0, h: 0, want: 0, from: 0, to: 0, p: 1 };

  /* ---- the band's own ease (build spec v3 s7.16 ruling 4) -----------------
     V1k measured the ease opening with a 71 px step, four fifths of the 91 px
     snap ruling 3 replaced, because a proportional step was taken inside
     applyView and applyView runs more than once in the frame an act changes
     in. The ease is now an ease-in-out advanced ONCE PER FRAME, and its length
     is counted in FRAMES rather than milliseconds: a 250 ms duration on a page
     whose wave frames run 50 to 70 ms would put 30 px into one of them, while
     a per-frame step of a smoothstep cannot exceed 1.5 x the mean step by
     construction. The total displacement is the band itself, unchanged. */
  var BAND_MIN_FRAMES = 15;  /* about 250 ms at 60 Hz */
  var BAND_MAX_STEP = 18;    /* the ruling's bar is 20 px; this keeps a margin */

  function bandEase(p) { return p * p * (3 - 2 * p); }

  function bandSnap() {
    barsBand.h = barsBand.want;
    barsBand.from = barsBand.want;
    barsBand.to = barsBand.want;
    barsBand.p = 1;
  }

  function stepBarsBand() {
    if (reducedMotion()) { bandSnap(); return; }
    if (barsBand.want !== barsBand.to) {
      /* a new target: re-aim from wherever the band stands, so an act change
         part way through an ease never jumps */
      barsBand.from = barsBand.h;
      barsBand.to = barsBand.want;
      barsBand.p = (Math.abs(barsBand.to - barsBand.from) < 0.8) ? 1 : 0;
    }
    if (barsBand.p >= 1) { barsBand.h = barsBand.to; return; }
    var delta = Math.abs(barsBand.to - barsBand.from);
    var frames = Math.max(BAND_MIN_FRAMES, Math.ceil(1.5 * delta / BAND_MAX_STEP));
    barsBand.p = Math.min(1, barsBand.p + 1 / frames);
    barsBand.h = barsBand.from + (barsBand.to - barsBand.from) * bandEase(barsBand.p);
    if (barsBand.p >= 1) barsBand.h = barsBand.to;
  }

  var barsDrawn = null;      /* the plate the last frame really painted */
  var barsHidden = false;    /* test hook: one frame with the bars suppressed */
  var BARS_MIN_H = 124;      /* 90 of bars plus the 34 the plate adds */
  var BARS_PAD = 16;         /* 8 css px of air above the plate and below it */

  /* Build spec v3 s7.15 ruling 3, and the honest shape of it. In READING THE
     PLAN the bars are the act, so the band is open from the first frame and
     the board never moves inside that act at all. In YOUR TURN only a reader
     partner has a guess to show, and holding the band open for a partner that
     has none would leave 182 px of empty page above the board in the one act
     the visitor plays. So there the band arrives and leaves as an EASE, which
     is the alternative the ruling names for the 91 px snap it was answering.
     Recorded as a deliberate reading, not an oversight. */
  function barsWanted() {
    if (!summaryOK()) return false;
    return act.name === 'reader' || (act.name === 'you' && partnerIsReader());
  }

  function barsPlateH() { return Math.min(190, Math.max(90, cssH * 0.26)) + 34; }

  function barsBandFor(o, opts) {
    /* s7.24 ruling 7: THE BAND SURVIVES THE FRAMED WAVE. It used to close when
       the desktop camera engaged (s7.21 ruling 9), which left the plate with
       no band to stand in: barsPlate's other branch then put it at
       `view.ox - w - 14`, clamped to x 8, which at S = 2 is ON the board. The
       panel critic measured it covering 30 to 45 k px of board and 100 percent
       of the keep readout's own box in 128 of 131 frames, in both themes. With
       the band held open the framed view is built under it, so the plate keeps
       its own room and the board's top edge stops travelling as well. */
    if (!barsWanted() || phone()) return 0;
    var probe = viewFor(opts);
    if (!probe) return 0;
    var slack = Math.floor(cssH - o.topPad - o.botPad - (probe.bh || 0));
    if (slack >= BARS_MIN_H + BARS_PAD) {
      return Math.min(barsPlateH() + BARS_PAD, slack);
    }
    /* ---- s7.26 ruling 6: THE TOUR NEVER EVICTS ITS SUBJECT ----------------
       The rule above never shrinks the board for the band, so whenever the
       page's furniture grows the band is refused and the act prints "Make the
       window taller to see the bars settle." The dark judge caught the worst
       case of that: the walkthrough's own step 4 points AT the bars, its card
       takes about 130 px of bottom pad, and the sentence under the board then
       contradicts the card at a standard 1440x900 laptop. Closing the card
       flips it back, so the card is the cause and the window is not.

       So when the slack is short the band is taken at its FLOOR and the board
       yields instead, down to a height a board is still worth drawing at. The
       bars are the act; a smaller keep for the length of one beat is the
       cheaper loss. Below that floor the band is still refused and the honest
       sentence is still what the act says. */
    var room = Math.floor(cssH - o.topPad - o.botPad - (BARS_MIN_H + BARS_PAD));
    if (room >= BOARD_MIN_H) return BARS_MIN_H + BARS_PAD;
    return 0;
  }
  /* the smallest board this page will draw to make room for the bars */
  var BOARD_MIN_H = 240;

  /* Only used before the renderer lands, or if its layout throws. Every value
     has a floor: a negative radius throws, and one throw in the rAF loop
     would cost the whole page. */
  function fallbackView(topPad, botPad) {
    var reserve = (panelOpen && cssW >= 600) ? 356 : 0;
    var bw = Math.max(40, cssW - reserve - 32);
    var bh = Math.max(40, cssH - topPad - botPad);
    var ox = Math.round(((cssW - reserve) - bw) / 2), oy = Math.round(topPad);
    return {
      w: cssW, h: cssH, dpr: dpr, reserve: reserve, S: 1,
      topPad: topPad, botPad: botPad, fx0: 0, fy0: 0, fw: bw, fh: bh,
      ox: ox, oy: oy, bw: Math.round(bw), bh: Math.round(bh),
      cell: Math.max(4, Math.floor(bw / COLS)), depth: 0,
      cols: COLS, rows: ROWS,
      board: { x: ox, y: oy, w: Math.round(bw), h: Math.round(bh) },
      fallback: true
    };
  }

  /* where the strip's bottom edge sits: above the chat bar and above the site
     corner buttons, both of which own the bottom of a phone screen */
  function stripBottomPx(band, chat) {
    var bottom = 8;
    if (chat) bottom = Math.max(bottom, cssH - chat.y + 8);
    if (band) bottom = Math.max(bottom, cssH - band.y + 8);
    return bottom;
  }

  function placeActbar(band, chat) {
    actbar.style.bottom = Math.round(stripBottomPx(band, chat)) + 'px';
  }

  /* ---- the phone act strip fills the room under the board (s7.16 r5) -------
     At 390x844 the renderer's scale ladder floors at one source pixel per
     device pixel, so the whole-board phone view is a fixed 356 css px tall
     however much room it is handed, and the layout was left with about 141 px
     it could not spend: 36 above the board, which is the landing band ruling 5
     asked for, and 105 px of empty page between the board caption and the act
     strip, which is what the light lane called a dead gap. RAISING the strip
     only moves that hole below it, because the site's corner buttons own the
     bottom 106 px of the screen and cannot be taken away, so the strip FILLS
     the room instead: the acts wrap into as many rows as the room allows and
     every act becomes reachable without scrolling, which is what ruling 5's
     own fade and arrow were a second best for. The wrap is refused whenever it
     would cost the board a pixel of height or push the board off its own top
     pad, and then the row stays a one line scroller with its affordance. */
  var wrapState = { key: '', on: false };

  function setActbarWrap(on) {
    var row = byId('kit-actbar-acts');
    if (row) row.classList.toggle('kit-actbar__row--wrap', !!on);
  }

  function padClamp(v) { return Math.max(0, Math.min(v, cssH * 0.5)); }

  /* the WHOLE BOARD view this width would get with these pads. No follow: the
     camera changes three times a game and the strip must not move with it. */
  function boardFor(topPad, botPad) {
    var o = { dpr: dpr, panelOpen: panelOpen,
              topPad: padClamp(topPad), botPad: padClamp(botPad) };
    o.reserveRight = phoneReserve(o);
    return viewFor(o);
  }

  /* returns true when it CHANGED the strip's height, so layout() can put the
     walkthrough card back above the strip before it uses the card's rect */
  function syncActbarWrap(topPad, botPadNoCoach, band, chat) {
    var row = byId('kit-actbar-acts'), was = wrapState.on;
    if (!row) return false;
    if (!phone()) {
      wrapState = { key: '', on: false };
      setActbarWrap(false);
      return was === true;
    }
    /* The walkthrough card rides ABOVE the strip (placeCoach), so a taller
       strip pushes the card up and takes its height out of the board's room
       twice over. Its contribution is therefore re-derived per candidate from
       the card's own height, which does not move: placeCoach puts the card
       8 px above the strip and layout() adds 12 below the card, so a strip h
       tall costs (sb + h + 20 + the card's height) whenever the card is up.
       Without this the wrap and the card together squeezed the board out of
       its box on a phone and the card came down onto the board, which ruling 1
       forbids. */
    var coachH = boxes.coach ? (boxes.coach.h + 10) : 0;
    var sb = stripBottomPx(band, chat);
    var padFor = function (h) {
      return Math.max(botPadNoCoach, sb + h + 10 + coachH);
    };
    var key = Math.round(cssW) + 'x' + Math.round(cssH) + '|' + (panelOpen ? 1 : 0) +
              '|' + act.name + '|' + row.children.length + '|' + Math.round(topPad) +
              '|' + Math.round(botPadNoCoach) + '|' + Math.round(coachH) +
              '|' + (capHugsPic() ? 1 : 0);
    if (key === wrapState.key) { setActbarWrap(wrapState.on); return false; }
    /* s7.26 ruling 6, the phone half again: the wrap is a CONVENIENCE (every
       act reachable without a sideways scroll; ruling 5's fade and arrow are
       its second best and are still there), and the bars are what the beat is
       about. At 390x844 on the real page the wrapped strip is 145 px tall
       against the 46 one row costs, and the site's own corner buttons hold the
       band under it, so the wrap is the whole difference between a slot the
       bars fit in and no slot at all: measured, card 454 to 577 with 35 px
       over it, and the act printing "Make the window taller" beside the card
       that had taken the room. While the walkthrough card is up AND the act's
       picture is asking for that room, the row stays a one line scroller. It
       wraps again the moment the card goes. */
    if (capHugsPic()) {
      wrapState = { key: key, on: false };
      setActbarWrap(false);
      return was === true;
    }
    var on = false, h0, h1, p0, p1, a, b;
    setActbarWrap(false);
    h0 = actbar.getBoundingClientRect().height;
    setActbarWrap(true);
    h1 = actbar.getBoundingClientRect().height;
    if (h1 > h0 + 1) {
      p0 = padFor(h0); p1 = padFor(h1);
      a = boardFor(topPad, p0);
      b = boardFor(topPad, p1);
      /* the same law landBias keeps: never buy the framing with a smaller
         board, never push the board off its own top pad, and never take the
         board out of the box it is supposed to sit in */
      on = !!(a && b && !a.fallback && !b.fallback && b.bh >= a.bh - 1 &&
              b.oy >= padClamp(topPad) - 0.5 &&
              b.oy + b.bh <= cssH - padClamp(p1) + 1);
    }
    wrapState = { key: key, on: on };
    setActbarWrap(on);
    return on !== was;
  }

  /* ------------------------------------------------------------ hit testing */

  function cellAtCss(x, y) {
    if (!view) return -1;
    if (RAPI && RAPI.cellAt && !view.fallback) {
      try {
        var got = RAPI.cellAt(view, x, y);
        if (typeof got === 'number' && got >= 0 && got < CELLS) return got;
      } catch (e) {}
      return -1;
    }
    var gx = Math.floor((x - view.ox) / view.cell);
    var gy = Math.floor((y - view.oy) / view.cell);
    if (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS) return -1;
    return cellOf(gx, gy);
  }

  /* ----------------------------------------------------------------- acts */

  function setAct(name, opts) {
    if (ACTS.indexOf(name) < 0) name = 'watch';
    /* any other input answers the New game question with "no" (s7.24 r4) */
    newSeedDisarm();
    /* Ruling 1: the walkthrough card DISMISSES on any act change. Leaving the
       act a beat is about is the visitor saying they are done with it, and a
       card that follows them into another act with the last beat's text still
       on it is what three lanes reported as broken. */
    if (tourOn && !tourApplying) { endTour('act'); }
    /* s7.21 ruling 10, twice over. (a) Where the visitor came FROM, so Escape
       or Close out of the fine print puts them back in their own act instead
       of dropping them in Watch a wave. (b) The Your turn session is STASHED
       rather than discarded: the critic built two walls, opened Six plans, came
       back and found moves 2 -> 0, and "Replay the walkthrough" wiped it too. */
    if (name !== act.name && act.name !== 'fine') prevAct = act.name;
    if (act.name === 'you') stashYou();
    act.name = name;
    act.sub = 'idle';
    act.seq++;
    cancelJobs();
    resetFx();
    playing = false;
    S = null;
    /* s7.22 ruling 2: every act starts at the top of its own panel. The panel
       really scrolls now (revealPartnerCard puts the partner portrait inside
       its window), and a scroll left behind by the last act is a scroll the
       browser will CLAMP the moment this act's controls change the content
       height: the prose then moved 89 px in Watch a wave with no text change of
       its own, which is the s7.15 ruling 2 law (measured, `ship-fixes`
       l19cap). Zeroing it here puts the move in the same task as the act's own
       prose write, where it belongs. */
    var pane0 = byId('kit-panel');
    if (pane0 && pane0.scrollTop) pane0.scrollTop = 0;
    syncActButtons();
    syncControlVisibility();
    syncBudget(true);
    syncRecenter();
    /* ---- s7.24 ruling 9's height clause, MEASURED AND NOT TAKEN -----------
       Snapping the bar band on the act's own cut frame was built here and
       reverted, and the arithmetic says why. The ruling asks the board's
       HEIGHT to ease when the reader's bars open. It cannot: the height is
       quantized by the integer sprite scale (s7.17 ruling 1 forbids a
       fractional S), so somewhere in the band's travel the board loses a whole
       scale step whatever the band does. The only choice is WHERE that step
       lands. Snapping put it on the act's own cut, which s7.22 ruling 3
       allows, and the board then travelled 146 px in one frame: `ship-fixes`
       lane_l22_tops measured it in both themes and it is a worse thing to look
       at than the 54 px the ruling is about, as well as a regression against
       s7.16 ruling 4's own 20 px bar, which the round 4 auditor recorded as
       met. The band keeps its ease; the height's one step is reported with its
       number as a disclosed residual. */
    layout();
    /* s7.21 ruling 10: the act's NAME used to be written here and replaced 20
       to 30 ms later by the act's own sentence, both forced, so every act press
       cost two status writes and two live-region mutations for a line nobody
       could read. The act starts first and the name is written only if the act
       said nothing of its own. */
    var writes0 = stCalls;
    if (name === 'watch') startWatch();
    else if (name === 'plans') startPlans();
    else if (name === 'strangers') startStrangers();
    else if (name === 'reader') startReader();
    else if (name === 'you') startYourTurn();
    else if (name === 'fine') startFine();
    if (!(opts && opts.quiet) && stCalls === writes0) {
      setStatus(ACT_NAME[name] + '.', { force: true });
    }
    /* s7.22 ruling 2: the reveal really scrolls the panel now, so it runs in
       the SAME task as the act's own prose write. Deferred alone, a 120 ms
       sampler can land between the new sentence and the scroll and read the
       panel moving with no text change, which is the motion law s7.15 ruling 2
       set (measured: 1 move in 6 over a three minute session). The deferred
       call stays for the layout that is not settled yet, and no-ops when the
       synchronous one already placed the card. */
    if (name === 'you' || name === 'reader') {
      revealPartnerCard();
      setTimeout(revealPartnerCard, 0);
    }
    /* s7.29 ruling 4: the reduced-motion disclosure is armed BEFORE the
       caption is forced, so it really is the act's first caption */
    rmLiveArm();
    /* an act change is a user action, so the caption takes the line at once
       rather than waiting out the last act's dwell (ruling 2) */
    capForce(captionWant());
    syncStepBtn();
  }

  function resetFx() {
    FX.flashes.length = 0; FX.shots.length = 0; FX.drones.length = 0;
    FX.ghost = null; FX.focusMark = -1; FX.grid = null;
    FX.cursor = -1; FX.hover = -1;
    planTapped = -1;                        /* s7.26 ruling 8 */
    /* ruling 2: the illegal marker clears on an act change as well as on
       pointerleave and at the end of a game */
    ghostBad = -1;
    resetEndMark();
    legalBand = null;
    /* the room under a gallery's picture belongs to the act that drew it: a
       stale anchor would place the phone caption card from the OTHER gallery
       for the one frame before this act's own draw runs */
    galleryBottom = 0;
    rmStepping = false;
    hintRingAt = 0;
    cam.manual = false;
    FX.plans = null; FX.bars = null;
    /* s7.20 ruling 7 (SEAM V1L-S2): the two drawing ledgers are written only
       inside their own act's draw, so without this they keep reporting the
       LAST grid or gallery the page drew. The wave verifier read the Strangers
       grid block while standing in Reading the plan, which sent its own first
       phone-band measurement wrong, and Z-P's invariant 5 tells later hands to
       measure a gallery act's overlap through exactly these hooks. */
    gridDrawn = null; plansDrawn = null;
    /* the same law, for the tile boxes the tap of s7.23 ruling 3 reads: a
       stale gallery geometry would answer a tap in another act */
    planCells = null;
    /* the same law as the two above (SEAM V1L-S2): drawBars is only CALLED
       when the act has bars, so without this the ledger kept reporting the
       reader's plate while standing in an act that draws none, and a probe
       measuring "does a bar plate stand on the board" read a plate from
       another act (found by this wave's own ruling 6 lane) */
    barsDrawn = null;
    /* SEAM V1M-S1, ruled by s7.22 ruling 7: the same law as the three above.
       drawKeepNumber is only CALLED on the non-gallery branch, so without this
       `__kit.keepNum()` kept reporting the last live act's readout box while
       standing in Six plans or Strangers, where no "Keep N of 100" run is
       painted at all. No ledger reports another act. */
    keepNumBox = null;
    /* the room under the board is measured by the frame, so a line that
       depends on "the bars could not be placed" must not be drawn from a
       measurement the new act has not taken yet (s7.22 ruling 7) */
    slotFrames = 0;
    closeLoupe();
    closeFine();
    cam.hold = 0;
    /* the act that is starting writes its own prose, so a help card standing
       open must not put the LAST act's paragraphs back when it closes */
    proseSaved = null;
    setProse(null);
    /* the renderer holds a derived motion memory of its own, and a body from
       the last act must not leave a husk in this one (R1-S3) */
    if (R && R.resetFx) { try { R.resetFx(); } catch (e) {} }
    stopAllLoops();
  }

  function syncActButtons() {
    var btns = document.querySelectorAll('[data-act]'), i, b;
    for (i = 0; i < btns.length; i++) {
      b = btns[i];
      var on = b.getAttribute('data-act') === act.name;
      b.classList.toggle('kit-act--on', on);
      if (on) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    }
    scrollActIntoView();
  }

  /* ---- s7.26 ruling 12: THE CURRENT ACT STAYS ON SCREEN -------------------
     The phone strip scrolls sideways, and the act a visitor is IN was often
     scrolled off it: the light judge was in Your turn looking at a row reading
     "Sound on / Watch a wave / Six plans / Str" with a fade and an arrow over
     the last of them. The strip is moved by the least that puts the current
     button whole inside it, and the arrow's own column is taken off the right
     edge first, so the button never comes to rest under it. */
  function scrollActIntoView() {
    var row = byId('kit-actbar-acts'), wrap = byId('kit-actbar-wrap');
    if (!row || !wrap || !row.clientWidth) return;
    var b = row.querySelector('[data-act="' + act.name + '"]');
    if (!b) return;
    var arrow = byId('kit-actbar-arrow');
    var x0 = b.offsetLeft, x1 = x0 + b.offsetWidth;
    var max = row.scrollWidth - row.clientWidth;
    /* TWO PASSES, and the second one is the whole point. The arrow is
       display:none until `kit-actbar__wrap--more` is on, and that class is a
       function of the scroll THIS routine sets, so on the frame a wrapped
       strip first becomes a one line scroller there is no arrow on screen to
       measure: pass one reserved 6 px, parked the current act's right edge at
       the strip's right edge, and syncActbarOverflow then revealed a 32 px
       arrow over the last 28 px of it (measured on the walkthrough's bars
       beat at 390 px: button 234 to 376, arrow 348 to 380, which is the
       light judge's own photograph). Pass two measures the arrow pass one
       revealed and moves the strip the rest of the way. Scrolling further
       right can only take the strip to its end, where `--more` goes off
       again, so the loop settles. */
    for (var pass = 0; pass < 2; pass++) {
      var pad = 6;
      if (arrow && wrap.classList.contains('kit-actbar__wrap--more')) {
        var aw = arrow.getBoundingClientRect().width;
        if (aw > 0) pad = Math.ceil(aw) + 6;
      }
      var lo = row.scrollLeft + 6, hi = row.scrollLeft + row.clientWidth - pad;
      var to = row.scrollLeft;
      if (x1 > hi) to = row.scrollLeft + (x1 - hi);
      else if (x0 < lo) to = row.scrollLeft - (lo - x0);
      to = Math.max(0, Math.min(max, Math.round(to)));
      if (to === row.scrollLeft) { syncActbarOverflow(); break; }
      row.scrollLeft = to;
      syncActbarOverflow();
    }
  }

  function show(el, on) { if (el) el.style.display = on ? '' : 'none'; }

  function syncControlVisibility() {
    show(byId('kit-build-controls'), act.name === 'you');
    /* s7.27 ruling 1: the row is shown first and then given its home, because
       buildRoomFor measures its height and a display:none row measures 0 */
    buildHome();
    show(byId('kit-partner-controls'), act.name === 'you' || act.name === 'reader');
    show(byId('kit-ledger-controls'), act.name === 'you' && ledgerRows().length > 0);
    show(byId('kit-strangers-controls'), act.name === 'strangers');
    /* ruling 4: the You row draws a fortress and a number, or the button does
       not offer itself. With nothing built there is nothing to play. */
    setDisabled(['kit-takerow'], !myMoves.length);
    var tr = byId('kit-takerow'), trw = byId('kit-takerow-why');
    /* s7.26 ruling 12: the button keeps its name and the reason is a hint
       beside it, so a greyed control reads as "not yet" and not as broken */
    if (tr && tr.textContent !== 'Take a row') tr.textContent = 'Take a row';
    if (trw) trw.hidden = !!myMoves.length || act.name !== 'strangers';
    show(byId('kit-plans-controls'), act.name === 'plans');
    show(byId('kit-actbar-build'), act.name === 'you');
    syncDoneGate();
  }

  /* s7.19 ruling 8: while the walkthrough card is open, DONE BUILDING is
     inert. A judge pressed the panel's Done to dismiss the card, and it ended
     their own build phase instead, unrecoverably. The card's own button is
     "Got it", so the two are no longer both called Done either. */
  /* s7.21 ruling 10: a finished game has nothing left to undo and nothing left
     to finish, so both buttons go with the two piece buttons that already
     grey out, and the budget readout stops quoting a number the visitor can no
     longer spend. */
  function gameOver() {
    return act.name === 'you' && !!S && !!(S.over || S.phase === 'over');
  }

  /* s7.25 ruling 3 (2026-09-12): WHILE A WAVE IS RUNNING THERE IS NOTHING TO
     FINISH AND NOTHING TO TAKE BACK. Done building and Undo stayed live all
     the way through a wave and answered a real tap with nothing at all: the
     integration hand measured a tap on Done building mid wave adding no status
     entry and leaving the phase where it was, while the two PIECE buttons
     beside them greyed out properly, which is exactly what made these two look
     pressable. They go with the pieces, and they say why the same way (the
     title, and the row's own hover through wireGreyReason). */
  function waveRunning() {
    return act.name === 'you' && !!S && !gameOver() &&
           (S.phase !== 'build' || !!S.buildDone);
  }
  var WAVE_WHY = 'The wave is running. You build again after it.';

  /* s7.21 ruling 1 (THE BLOCKER). This gate is SET while the walkthrough card
     is up and it was never UNSET when the card closed in place: placeCoach
     returned before reaching it and endTour only called layout(). The
     walkthrough's last beat is Your turn, so a real first visit ended with a
     caption naming a button the visitor could not press. Every path that can
     change either condition now runs this, and the title is cleared with the
     attributes rather than left standing. */
  function syncDoneGate() {
    var tour = coachShown(), over = gameOver(), wave = waveRunning();
    var ids = ['kit-done', 'kit-bar-done'], i, el;
    /* s7.26 ruling 7: the phone's own way back into a game, shown exactly
       when the rest of the row has nothing left to offer */
    var ng = byId('kit-bar-newseed');
    if (ng) ng.hidden = !(over && !tour);
    var why = tour ? 'Finish the walkthrough first'
                   : (over ? 'This game is finished' : (wave ? WAVE_WHY : ''));
    for (i = 0; i < ids.length; i++) {
      el = byId(ids[i]);
      if (!el) continue;
      if (tour || over || wave) {
        el.setAttribute('disabled', 'disabled');
        if (tour) el.setAttribute('inert', '');
        else el.removeAttribute('inert');
        el.setAttribute('title', why);
      } else {
        el.removeAttribute('disabled');
        el.removeAttribute('inert');
        el.removeAttribute('title');
      }
    }
    /* s7.25 ruling 3: Undo goes with it, and carries the same sentence */
    setDisabled(['kit-undo', 'kit-bar-undo'], over || wave);
    setTitles(['kit-undo', 'kit-bar-undo'],
      over ? 'This game is finished' : (wave ? WAVE_WHY : ''));
  }

  /* ---- the act's standing prose, in real DOM text --------------------------
     The canvas carries ONE short caption. Everything longer than that lives
     here: selectable, translatable, and in the accessibility tree. */
  var proseLast = null, proseSaved = null;

  function setProse(list) {
    var el = byId('kit-actprose'), i, p;
    proseLast = list || null;
    if (!el) return;
    /* s7.22 ruling 2 against the s7.15 ruling 2 motion law. The panel really
       scrolls now (revealPartnerCard puts the partner portrait inside its
       window), and emptying this element shrinks the panel's content below the
       scroll offset, so the browser clamps scrollTop and never puts it back:
       the prose then jumped by the whole scroll with no text change of its own,
       twice in a 70 s session (p15/probe7.js, measured while the reveal was
       still scrolling 342). The panel is put back where it was, in the same
       task, so nothing a visitor can see moves. */
    var pane = byId('kit-panel');
    var keep = pane ? pane.scrollTop : 0;
    while (el.firstChild) el.removeChild(el.firstChild);
    if (list) {
      for (i = 0; i < list.length; i++) {
        if (!list[i] || !list[i].text) continue;
        p = document.createElement('p');
        if (list[i].note) p.className = 'kit-prose--note';
        p.textContent = list[i].text;
        el.appendChild(p);
      }
    }
    if (pane && keep > 0 && pane.scrollTop !== keep) {
      pane.scrollTop = Math.min(keep, Math.max(0, pane.scrollHeight - pane.clientHeight));
    }
    syncCapcardText();
  }

  /* --- act 1: watch a wave ------------------------------------------------ */

  function startWatch() {
    var keys = netKeys('sp', 1);
    S = newSession(act.seed, [agentFor(keys[0]), agentFor(keys[0])]);
    /* s7.32 ruling 3: each engineer has its own budget per wave (core debits
       budgets[side]); the old line promised one pool, which is not the
       rule */
    FX.caption = 'One pair of engineers that trained together. They cannot talk, each has its own budget, and they build at the same time.';
    setProse([
      { text: 'One pair of engineers that trained together. They cannot talk, each ' +
              'has its own budget, and they build at the same time.' }
    ]);
    if (!S) { setStatus(honestMissing()); return; }
    S.reveal = runBuild(S);
    if (reducedMotion()) { revealAll(S); resolveInstantly(); return; }
    playing = true; lastTick = 0;
    setStatus('Building. Watch both sides at once.', { force: true });
  }

  function kindOf(sess, cell) {
    var m = structMap(sess), rec = (m && m.get) ? m.get(cell) : null;
    return (rec && rec.kind === 2) ? PIECE_GUN : PIECE_WALL;
  }

  function kindOwner(sess, cell) {
    var m = structMap(sess), rec = (m && m.get) ? m.get(cell) : null;
    return (rec && typeof rec.owner === 'number') ? rec.owner : -1;
  }

  function revealAll(sess) {
    var i, t = now(), cell;
    for (i = 0; i < sess.reveal.length; i++) {
      cell = sess.reveal[i];
      /* the ledger holds the KIND, not just a flag: when a structure falls,
         core's hit record does not say what it was, and wall-break and
         gun-break are different sounds */
      sess.shown[cell] = kindOf(sess, cell);
      pushFlash(cell, 'place', t);
    }
    sess.reveal.length = 0;
  }

  /* Reduced motion: the whole thing resolves at once, the settled board is
     drawn, and ONE summary sound plays instead of forty per event ones. */
  function resolveInstantly() {
    if (!S) return;
    var guard = 0;
    while (S.wave < WAVES && guard++ < 12) {
      if (!startWave(S)) break;
      var g2 = 0;
      while (waveTick(S) && g2++ < 4000) { /* run it out */ }
      waveFinish(S);
      S.wave++;
      if (keepHp(S) <= 0) break;
      if (S.wave < WAVES) { S.phase = 'build'; S.reveal = runBuild(S); revealAll(S); }
    }
    S.phase = 'over'; S.over = true; playing = false;
    S.resolved = true;
    endMarkAt = now();
    endMarkGone = false;
    var hp = keepHp(S);
    if (hp <= 0) S.fellSounded = true;        /* the one call for this game */
    playSound(hp > 0 ? 'wave-held' : 'keep-fell', {});
    setStatus(hp > 0 ? ('The keep held at ' + Math.round(hp) + ' of ' + HP_KEEP + '.')
                     : 'The keep fell.');
    if (act.name === 'you') recordHold(act.partner, hp, hp > 0, act.partnerN);
  }

  /* ---- reduced motion: a way to see it happen (s7.19 ruling 6) -------------
     Under reduced motion every act shows its END STATE as a still (s7.15
     ruling 5), which is right, and which left the light lane looking at a
     finished game with no explanation and an invitation ("tap a creature that
     has stopped") for an interaction this mode never reaches. The still now
     says so, and Step is the way through it: the first press plays the same
     game again from its own first move, one move per press, with nothing
     animating between presses. */
  var rmStepping = false;

  function rmStepAvailable() {
    return reducedMotion() && (act.name === 'watch' || act.name === 'you' ||
                               act.name === 'reader');
  }

  /* ---- s7.29 ruling 4, TAKEN ON THE MEASUREMENT, NOT ON ITS PREMISE -------
     The ruling says Reading the plan, Strangers and Your turn "play live games
     under reduced motion by necessity" and asks each of them to say so. The
     round-7 light lane had read 6 of 6 distinct frames over four seconds in
     those acts and called them fully animated. THEY ARE NOT, and this page
     may not print a sentence that is false about itself. Measured with no
     input at all, canvas screenshots hashed twice a second over five seconds
     at 1440x900 under real reduced motion (`i1u/r4-motion.js`):

       Watch a wave       over, 2 distinct frames of 10
       Reading the plan   over, 2 distinct frames of 10
       Strangers          no session, 1 distinct frame of 10
       Your turn          build phase (waiting for the visitor), 2 of 10
       Your turn, after a real Done building   over, 3 of 10

     `startReader` and the wave start both call `resolveInstantly` under
     reduced motion exactly as `startWatch` does, so every wave on this page is
     SHOWN FINISHED and the promise was never dropped. What was true is that
     two of the three acts said nothing about it at the moment a visitor asks:
     Strangers has no reduced-motion sentence at all, and Your turn's own
     sentence waits until the visitor has sent a build. Each act now opens with
     a sentence that is true OF THAT ACT, for five seconds, because it is a
     disclosure and not an instruction; Reading the plan needs none added, its
     standing sentence already says it from the first frame. The help card
     carries the whole of it for as long as the visitor wants it. */
  var RM_LIVE_MS = 5000;
  var rmLiveAt = -1e9, rmLiveAct = '';
  function rmLiveActs(n) { return n === 'strangers' || n === 'you'; }
  function rmLiveArm() {
    if (!reducedMotion() || !rmLiveActs(act.name)) { rmLiveAct = ''; return; }
    rmLiveAct = act.name; rmLiveAt = now();
  }
  function rmLiveLine(n) {
    if (!reducedMotion() || !rmLiveActs(n)) return '';
    if (n === 'strangers') {
      return 'Your browser asks for reduced motion. Every square here is a game ' +
             'played to the end, so nothing in this act animates.';
    }
    /* the narrow lane (320 css px) has room for two lines under the board and
       a three-line form rides up over the picture's foot there (i1t's own
       r2-frame row caught it). The Step clause is the part the help card and
       the chip itself both carry, so it is the part that yields. */
    if (cssW < 360) {
      return 'Your browser asks for reduced motion. Each wave you send is shown finished.';
    }
    return 'Your browser asks for reduced motion. Each wave you send is shown ' +
           'finished, and Step advances it a move at a time.';
  }

  function rmCaption() {
    if (rmLiveAct && rmLiveAct === act.name && (now() - rmLiveAt) < RM_LIVE_MS) {
      var live = rmLiveLine(act.name);
      if (live) return live;
    }
    if (!rmStepAvailable()) return '';
    if (rmStepping) return 'Stepping through this wave. Step advances it a move at a time.';
    if (!S || !(S.over || S.phase === 'over')) return '';
    return 'Your browser asks for reduced motion, so this wave is shown finished. ' +
           'Step advances it a move at a time.';
  }

  function rmStep() {
    holdSoundHint();          /* s7.29 ruling 5: the game line wins */
    if (!rmStepAvailable()) return false;
    if (!rmStepping) {
      /* start again from the top of the same game, and stop resolving it */
      var wasDone = !!S && (S.over || S.phase === 'over' || S.wave > 0);
      rmStepping = true;
      if (act.name === 'you') { rebuildYou(); }
      else if (act.name === 'watch') {
        var keys = netKeys('sp', 1);
        S = newSession(act.seed, [agentFor(keys[0]), agentFor(keys[0])]);
        if (S) S.reveal = runBuild(S);
      } else if (act.name === 'reader') { startReader({ step: true }); }
      resetEndMark();
      playing = false;
      /* s7.26 ruling 12: the first press REWINDS. Under reduced motion the
         board arrives finished, so a visitor who presses Step sees the keep go
         from 88 back to 100 with no word about why; the light judge read that
         as the page losing their game. The sentence says what happened. */
      setStatus((wasDone ? 'Back to the start of the wave. ' : '') +
                'Stepping through this wave. Press Step for the next move.',
                { force: true });
      syncStepBtn();
      return true;
    }
    if (!S) return false;
    tickOnce(now());
    syncStepBtn();
    return true;
  }

  function tickSession(t) {
    if (!playing || !S) return;
    if (t - lastTick < TICK_MS) return;
    tickOnce(t);
  }

  /* ONE unit of the session clock. The rAF loop meters it with TICK_MS; the
     reduced-motion Step control (s7.19 ruling 6) calls it once per press, and
     that is the only other caller. */
  function tickOnce(t) {
    if (!S) return;
    lastTick = t;
    if (S.reveal.length) {
      /* the build phase already ran through core's own loop; the page reveals
         it one piece per tick so the two sides read as simultaneous */
      var cell = S.reveal.shift();
      var m = structMap(S), rec = (m && m.get) ? m.get(cell) : null;
      var kind = (rec && rec.kind === 2) ? PIECE_GUN : PIECE_WALL;
      var owner = (rec && typeof rec.owner === 'number') ? rec.owner : -1;
      S.shown[cell] = kind;
      pushFlash(cell, 'place', t);
      spawnDrone(owner, cell);
      playSound(kind === PIECE_GUN ? 'build-gun' : 'build-wall',
                { owner: owner, x: cx(cell), y: cy(cell) });
      return;
    }
    if (S.phase === 'build') {
      /* the reader act steps its build one placement at a time and asks the
         reader after each one, so the board it read really grew by one piece
         between two answers */
      if (act.name === 'reader' && S.bstate && !S.buildDone) {
        var got = stepBuild(S, { one: true });
        if (got.mine || got.theirs) {
          var nc = S.lastCell;
          revealNew(S);
          if (typeof nc === 'number') {
            spawnDrone(kindOwner(S, nc), nc);
            playSound(kindOf(S, nc) === PIECE_GUN ? 'build-gun' : 'build-wall',
                      { owner: kindOwner(S, nc), x: cx(nc), y: cy(nc) });
            if (FX.bars) FX.bars.lastCell = nc;
          }
          pumpBars(S);
          return;
        }
      }
      if (!startWave(S)) { playing = false; return; }
      playSound('wave-start', {});
      setStatus('Wave ' + (S.wave + 1) + ' of ' + WAVES + '.');
      return;
    }
    var prevHp = keepHp(S);
    var ev = waveTick(S);
    if (!ev) {
      var ws = S.ws;
      waveFinish(S);
      S.wave++;
      stopAllLoops();
      var hp = keepHp(S);
      /* SEAM P-S4: the leftover clause in waveFinish is not a tick and carries
         no ev, so the outcome is read off the wave state core writes it on.
         `held` is null until waveFinish, so the fall back to the keep HP is
         only ever taken against an older core. */
      var held = (ws && ws.held !== undefined && ws.held !== null) ? !!ws.held : (hp > 0);
      var fell = (ws && ws.keepFell !== undefined) ? !!ws.keepFell : (hp <= 0);
      if (S.wave >= WAVES || fell) {
        playing = false; S.phase = 'over'; S.over = true;
        /* s7.19 ruling 6: this browser played it, so it may be announced */
        S.resolved = true;
        endMarkAt = now();
        endMarkGone = false;
        /* one call per event: the tick that took the keep to zero has already
           sounded the fall unless no tick reached the page (reduced motion
           resolves the whole game in one call), and `fellSounded` is how this
           branch knows which it is */
        if (held) playSound('wave-held', {});
        else if (!S.fellSounded) { S.fellSounded = true; playSound('keep-fell', {}); }
        setStatus(held ? ('The keep held at ' + Math.round(hp) + ' of ' + HP_KEEP + '.')
                       : ('The keep fell on wave ' + S.wave + '.'));
        if (act.name === 'you') recordHold(act.partner, hp, held, act.partnerN);
        if (act.name === 'reader') readerReport();
        if (held && act.name === 'watch') {
          setProse([
            { text: 'The wall held. Both of these engineers learned this plan ' +
                    'together, and each one built the half the other did not.' }
          ]);
        }
      } else if (act.name === 'you') {
        /* the visitor's turn comes back: the build phase is turn metered, so
           the page stops the clock and waits rather than playing on */
        playSound('wave-held', {});
        S.phase = 'build';
        playing = false;
        if (!openBuild(S)) { S.reveal = runBuild(S); revealAll(S); }
        /* s7.32 addendum 3 item 2 (the round-9 critic's B2): every build phase
           starts with the Wall armed. A catapult placed last stayed armed into
           a build whose budget could not pay for one: pressed and disabled,
           nothing lit, every hover red, under a caption saying to build. */
        if (selPiece !== PIECE_WALL) { selPiece = PIECE_WALL; legalBand = null; syncPieceButtons(); }
        syncBudget();
        /* s7.24 ruling 10: THE STATUS AGREES WITH THE CAPTION. This line was
           printed unconditionally, so at a budget below the price of a wall it
           told the visitor to build while the caption and the phase line, which
           s7.22 ruling 7 already re-cut, correctly said there was not enough
           left. All three round 4 judges reported it. One branch, the same
           threshold as phaseLine's. */
        /* s7.32 ruling 3: a later wave's budget is a fresh grant and what was
           not spent before it is gone, and nothing on the page said so */
        /* s7.32 addendum 3 item 3: the line is on screen now, in a fixed
           two-line slot, so the sentence is cut to what two lines hold (the
           caption under the board carries the instruction); the low branch
           keeps "Not enough left to build", the caption's own words */
        setStatus(budgetLeft() < cheapestCost()
          ? ('Not enough left to build. New budget ' + budgetWords(budgetLeft()) +
             '; what was not spent is gone.')
          : ('Wave held. Your new budget is ' + budgetWords(budgetLeft()) +
             '; what you did not spend is gone.'));
      } else if (act.name === 'reader') {
        playSound('wave-held', {});
        S.phase = 'build';
        if (!openBuild(S)) { S.reveal = runBuild(S); revealAll(S); }
        setStatus('Wave held. Repairing, then building again.');
      } else {
        playSound('wave-held', {});
        S.phase = 'build';
        S.reveal = runBuild(S);
        setStatus('Wave held. Repairing, then building again.');
      }
      return;
    }
    feedFx(ev, t);
    emitSounds(ev, S, prevHp);
    syncLoops(S);
  }

  /* the ONE place an event record turns into presentation */
  /* The ONE place an event record turns into presentation. Walker motion,
     the death beat and the husks are DERIVED by the renderer from the state
     it is handed, so the page keeps no second copy of them. */
  function feedFx(ev, t) {
    var i, e;
    if (!ev) return;
    if (ev.shots) for (i = 0; i < ev.shots.length; i++) spawnShot(S, ev.shots[i], t);
    if (ev.hits) {
      for (i = 0; i < ev.hits.length; i++) {
        e = ev.hits[i];
        pushFlash(e.cell, e.broke ? 'break' : 'hit', t);
        if (e.broke) {
          /* core's hit record does not say what fell, and the page does
             know: it is stamped on the record for the sound layer, which is
             the only other reader of it, before the ledger entry goes */
          e.piece = S.shown[e.cell] || PIECE_WALL;
          delete S.shown[e.cell];
        }
      }
    }
    if (ev.arrivals && ev.arrivals.length) pushFlash(-1, 'breach', t);
  }

  /* --- act 3: strangers, and the grid ------------------------------------- */

  var gridJob = null, gridCache = {}, gridOrder = [];

  function gridSize() {
    if (cssW < 480) return 4;
    if (cssW < 700) return 6;
    return 8;
  }

  function cacheGet(k) { return Object.prototype.hasOwnProperty.call(gridCache, k) ? gridCache[k] : null; }
  function cachePut(k, v) {
    if (!cacheGet(k)) {
      gridOrder.push(k);
      if (gridOrder.length > 256) delete gridCache[gridOrder.shift()];
    }
    gridCache[k] = v;
  }

  /* ONE game per grid cell (spec v3 section 7.7 ruling 4c), and it is a
     constant rather than a literal in two places because the caption "Every
     square is a game your browser just played" is only true while it is 1. The
     fallback path runs exactly one playEpisode per cell (runPairing), and the
     worker echoes what it was asked for on every cell message, which is what
     `__kit.gridEpisodes()` reports. */
  var GRID_EPISODES = 1;

  /* Ruling 4: the grid FILLS VISIBLY with a progress sentence. Two judges
     read the empty boxes as a broken page rather than as a gallery being
     played, and the counter that was there jumped and thrashed. It goes out
     on the low progress channel, so it can never bury a sentence. */
  function gridProgress() {
    var g = FX.grid;
    if (!g) return;
    if (g.done >= g.total) return;
    setStatus('Playing ' + (g.done + 1) + ' of ' + g.total + ' games.',
              { progress: true });
  }

  function startStrangers() {
    var n = gridSize();
    FX.grid = { rows: netKeys('sp', n), cols: netKeys(act.pool === 'ac' ? 'ac' : 'sp', n),
                n: n, cells: new Array(n * n), done: 0, total: n * n,
                episodes: GRID_EPISODES };
    FX.caption = 'Every square is a game your browser just played.';
    setProse(strangersProse());
    setStatus('Playing 1 of ' + (n * n) + ' games.', { force: true, progress: true });
    writeSrGrid();
    /* the worker when it is alive, the sliced main thread when it is not, and
       the fallback re-issues whatever was in flight if the worker dies.
       SEAM A-S3: while the worker is still BOOTING neither runner starts. The
       ready handler posts the job a moment later and the dead handler takes
       the fallback, so nothing is lost and no game is played on the main
       thread by a visitor who was simply early. */
    if (workerAlive && postCells()) return;
    if (!workerPending) startGridJob();
  }

  /* The grid's own prose, plus one sentence that only exists when the games in
     it really produced a reader's guess. It is rewritten as the counts move
     rather than promised in advance. */
  function strangersProse() {
    var note = intentNote();
    /* s7.21 ruling 10, and the critic's revision 5. With the crossed pool
       ticked the rows and the columns come from two different pools, so no
       square pairs an engineer with the partner it trained with and the page
       correctly draws no diagonal. The standing prose still described one. */
    var crossed = act.pool === 'ac';
    var list = [
      { text: crossed
          ? ('Each square is one final fortress, from one pairing. Every square ' +
             'here crosses the two pools, so no engineer is paired with the ' +
             'partner it trained with: they are all strangers.')
          : ('Each square is one final fortress, from one pairing. Down the ' +
             'diagonal, every engineer is paired with the partner it trained ' +
             'with. Everywhere else, they are strangers.') },
      { text: 'Neither of these engineers has met the other. Both of them won game ' +
              'after game in training. They are building different plans, and the ' +
              'wave finds the gap.' },
      { note: 1, text: 'Both pools are engineers I trained here, in this game. The ' +
              'version of this picture in the paper is on its own card in the fine ' +
              'print, and it is a different game with different numbers.' }
    ];
    var gapN = crossedGapNote();
    if (gapN) list.push({ note: 1, text: gapN });
    if (note) list.push({ note: 1, text: note });
    return list;
  }

  /* ---- s7.29 ruling 5: THE EMPTY COLUMN IS NAMED ---------------------------
     The light lane read a column that is zero in all eight rows, beside a row
     of the same name that is not, as a seat-assignment bug. It was PROBED
     (`i1u/r5-s5.js`, three seeds plus the same pair played both ways round
     through the page's own runner) and it is the honest result, not a defect:
     seat b is not handicapped (two columns hold in every row at seed 31598,
     and the diagonal cells hold at 100 and 96), and the asymmetry runs both
     ways per run (at seed 4242, run four holds 100 in the second seat and 0
     in the first, run two the reverse). One run is simply a stranger to the
     whole pool. That is this act's own claim, so the picture says it in one
     sentence instead of leaving a visitor to guess at a bug.

     Computed from the cells the grid really played, named by the label the
     axis really painted, and silent when no column is empty. */
  function gridDeadRunNote(opts) {
    var g = FX.grid;
    if (!g || !g.cells || g.done < g.total || !(g.n > 2)) return '';
    var n = g.n, i, j, c, hp, off, zero, dead = -1;
    var hpOf = function (cell) {
      if (!cell) return null;
      if (cell.st && typeof cell.st.keepHp === 'number') return cell.st.keepHp;
      return (typeof cell.hp === 'number') ? cell.hp : null;
    };
    for (j = 0; j < n && dead < 0; j++) {
      off = 0; zero = 0;
      for (i = 0; i < n; i++) {
        if (i === j && g.rows[i] === g.cols[j]) continue;   /* its own twin */
        c = g.cells[i * n + j];
        hp = hpOf(c);
        if (hp === null) { off = -1; break; }
        off++;
        if (!(hp > 0)) zero++;
      }
      if (off > 2 && zero === off) dead = j;
    }
    if (dead < 0) return '';
    var lab = poolTag(g.cols[dead]) + (dead + 1);
    var dh = (g.rows[dead] === g.cols[dead]) ? hpOf(g.cells[dead * n + dead]) : null;
    var s = 'Column ' + lab + ' never scores: ' +
      (dh !== null && dh > 0
        ? 'that run holds with its own twin and loses with every other partner here.'
        : 'that run loses with every partner here.');
    /* the caption under the picture carries the short form, because it is a
       board caption; the panel and the screen-reader table carry the reason */
    if (opts && opts.full) {
      s += ' A run can be a stranger to the whole pool, which is what this ' +
           'act is about.';
    }
    return s;
  }

  /* s7.21 ruling 10, the critic's revision 6: the crossed grid is the picture
     the page's own argument is about, and it handed the visitor 64 squares and
     no sentence. This names the measured gap and says plainly what a gap that
     size looks like, so nobody has to read the picture as the opposite of the
     claim. Every number comes from the export's own meta. */
  function crossedGapNote() {
    if (act.pool !== 'ac') return '';
    var g = readerGap();
    if (!g || g.gap === null || g.bar === null) return '';
    var sent;
    if (g.gap >= g.bar) {
      sent = 'The reader ended ' + fmt1(g.gap) + ' points ahead, which cleared the ' +
             fmt1(g.bar) + ' the test asked for.';
    } else if (g.gap > 0) {
      sent = 'The reader ended ' + fmt1(g.gap) + ' points ahead; the test asked for ' +
             fmt1(g.bar) + '.';
    } else {
      sent = 'The reader ended ' + fmt1(-g.gap) + ' points behind; the test asked for ' +
             fmt1(g.bar) + ' ahead.';
    }
    return sent + ' A gap that small is not something a grid of one-game squares ' +
           'can show on its own, and this one does not show it.';
  }

  /* ---- the gallery through the worker (SEAM A2-S1) ------------------------
     When the columns are accommodators there is a reader in every pairing, so
     the games go as a `plays` job and each one comes back carrying that
     reader's own belief, one raw softmax per build tick, out of the same
     KeepCore.discriminateBoard call the reader act draws. With two self-play
     engineers there is no reader head in the pairing at all, and the plain
     `grid` job is what the worker can honestly answer. Both paths play the
     same games from the same seed, so the pictures do not depend on which one
     ran. */
  function readerPool() {
    var n = netOf('ac0');
    return !!(n && n.Ws && n.bs && n.Wd && n.bd);
  }

  function postCells() {
    return (act.pool === 'ac' && readerPool()) ? postPlays() : postGrid();
  }

  function postPlays() {
    if (!worker || !FX.grid) return false;
    var g = FX.grid, list = [], i, j;
    for (i = 0; i < g.n; i++) {
      for (j = 0; j < g.n; j++) {
        list.push({ a: g.rows[i], b: g.cols[j], seed: act.seed >>> 0 });
      }
    }
    try {
      worker.postMessage({ type: 'plays', jobId: act.seq, seq: act.seq,
                           seed: act.seed >>> 0, list: list,
                           episodes: GRID_EPISODES });
    } catch (e) { return false; }
    g.intents = { got: 0, changed: 0, ticks: 0, net: null, missing: null,
                  settled: [0, 0, 0, 0, 0, 0] };
    return true;
  }

  /* A2-S1: `changes` and `flipTicks` on the wire are RAW argmax flips. The
     live act only calls it a change of mind when a new lead HOLDS for two
     build ticks, so the gallery runs the same rule over the same numbers and
     the two acts cannot report different amounts of mind changing for the same
     board. This is the display rule of pumpBars, in the same order. */
  function mindOf(argmax) {
    var i, lead = -1, holds = 0, first = -1, changed = false, at = -1;
    if (!argmax || !argmax.length) return null;
    for (i = 0; i < argmax.length; i++) {
      if (argmax[i] === lead) holds++;
      else { lead = argmax[i]; holds = 1; }
      if (holds === 2 && first >= 0 && lead !== first && !changed) { changed = true; at = i; }
      if (first < 0 && holds >= 1) first = lead;
    }
    return { first: first, settled: lead, changed: changed, at: at, ticks: argmax.length };
  }

  function takeIntents(m) {
    var g = FX.grid, it = m.intents, mind;
    if (!g || !g.intents) return;
    if (!it || !it.argmax || !it.argmax.length) {
      if (!g.intents.missing && m.intentsReason) g.intents.missing = String(m.intentsReason);
      return;
    }
    mind = mindOf(it.argmax);
    if (!mind) return;
    g.intents.got++;
    g.intents.ticks += mind.ticks;
    if (mind.changed) g.intents.changed++;
    if (mind.settled >= 0 && mind.settled < 6) g.intents.settled[mind.settled]++;
    if (!g.intents.net && it.net) g.intents.net = String(it.net);
  }

  /* the one sentence the grid earns from the intents, counted from the games
     that produced one and silent when none did */
  function intentNote() {
    var g = FX.grid, it = g ? g.intents : null, shorts = planNames(), i, top = -1;
    if (!it || !it.got) return '';
    for (i = 0; i < 6; i++) if (top < 0 || it.settled[i] > it.settled[top]) top = i;
    return 'The partner in every one of these games is a reader. It produced a guess ' +
      'in ' + fmtInt(it.got) + ' of them, it changed its mind in ' + fmtInt(it.changed) +
      ', and the plan it settled on most often was ' + shorts[top] + '. The guess is ' +
      'the same call the reading act draws, made on the board of the game in that ' +
      'square.';
  }

  function cancelJobs() {
    if (gridJob) { gridJob.cancelled = true; gridJob = null; }
    if (planJob) { planJob.cancelled = true; planJob = null; }
    if (rowJob) { rowJob.cancelled = true; rowJob = null; }
    pendingRow = false;        /* a row waiting on the boot dies with its act */
    /* SEAM A-S2 (Z-A, 2026-09-09). Every caller bumps `act.seq` BEFORE this
       runs, so a cancel naming `act.seq` named a job the worker was not
       running and the worker correctly ignored it: leaving Strangers left a 64
       game job running to completion, its replies dropped as stale. A cancel
       with NO jobId is the protocol's own "cancel whatever is running", and it
       cannot go stale. Z-A measured it stopping inside one game. */
    if (worker) { try { worker.postMessage({ type: 'cancel' }); } catch (e) {} }
  }

  /* The fallback path: the grid is computed on the main thread in slices, at
     most ONE cell painted per frame and at most one 6 ms slice of work per
     frame, so the page holds its frame rate whatever the model costs. The
     worker takes this over when it ships (SEAM P-S6). */
  function startGridJob() {
    var job = { cancelled: false, seq: act.seq, i: 0 };
    gridJob = job;
    function slice() {
      if (job.cancelled || job.seq !== act.seq || !FX.grid) return;
      var g = FX.grid, t0 = now(), made = 0;
      while (job.i < g.total && (now() - t0) < 6 && made < 1) {
        var i = (job.i / g.n) | 0, j = job.i % g.n;
        var key = g.rows[i] + '|' + g.cols[j] + '|' + act.seed;
        var got = cacheGet(key);
        if (!got) {
          got = runPairing(g.rows[i], g.cols[j], act.seed);
          if (got) cachePut(key, got);
        }
        g.cells[job.i] = got;
        if (got) g.done++;
        job.i++; made++;
      }
      writeSrGrid();
      gridProgress();
      if (job.i < g.total) requestAnimationFrame(slice);
      else {
        gridJob = null;
        if (!g.done) {
          FX.caption = 'No games could be played yet: ' + honestMissing();
          setStatus('No games could be played yet.');
        } else {
          if (act.name === 'strangers') setProse(strangersProse());
          var sum = gridSummary();
          setStatus(g.done + ' of ' + g.total + ' games played.' + (sum ? (' ' + sum) : ''));
        }
      }
    }
    requestAnimationFrame(slice);
  }

  /* One grid cell is one whole game, through core's own runner: the caption
     "every square is a game your browser just played" is only true while this
     is the only way a cell is ever produced. */
  function runPairing(keyA, keyB, seed) {
    if (!Core || !Core.playEpisode) return null;
    var res = null;
    try {
      res = Core.playEpisode({ seed: seed >>> 0, cfg: coreCfg(),
                               a: agentFor(keyA), b: agentFor(keyB) });
    } catch (e) { return null; }
    if (!res) return null;
    return { score: res.score, hp: res.score,
             st: res.g ? snapshotOf(res.g) : null };
  }

  /* a finished game frozen into the renderer's read only shape, so a grid
     cell and the gallery tile are drawn by the same R.fortress call */
  function snapshotOf(g) {
    var piece = new Uint8Array(CELLS), owner = new Int8Array(CELLS), hp = new Int16Array(CELLS);
    owner.fill(-1);
    if (g.struct && typeof g.struct.forEach === 'function') {
      g.struct.forEach(function (v, cell) {
        if (cell < 0 || cell >= CELLS) return;
        var kind = (typeof v.kind === 'number') ? v.kind : 1;
        piece[cell] = kind === 2 ? PIECE_GUN : PIECE_WALL;
        owner[cell] = (typeof v.owner === 'number') ? v.owner : -1;
        hp[cell] = (typeof v.hp === 'number') ? v.hp : HP_WALL;
      });
    }
    return { piece: piece, owner: owner, hp: hp, terrain: g.t || null,
             keepHp: (typeof g.keepHp === 'number') ? g.keepHp : HP_KEEP,
             walkers: [], phase: 'over', wave: WAVES, tick: 0, phaseTick: 0, budget: [0, 0] };
  }

  function writeSrGrid() {
    if (!srGrid || !FX.grid) return;
    var g = FX.grid, i, j, h = '';
    h += '<table><caption>The cross play grid, ' + g.n + ' by ' + g.n +
         ' games. Each cell is the keep health at the end of one pairing.</caption><tr><td></td>';
    for (j = 0; j < g.n; j++) h += '<th scope="col">Run ' + (j + 1) + '</th>';
    h += '</tr>';
    for (i = 0; i < g.n; i++) {
      h += '<tr><th scope="row">Run ' + (i + 1) + '</th>';
      for (j = 0; j < g.n; j++) {
        var c = g.cells[i * g.n + j];
        h += '<td>' + (c ? Math.round(c.score) : 'not played yet') + '</td>';
      }
      h += '</tr>';
    }
    if (g.row) {
      h += '<tr><th scope="row">You</th>';
      for (j = 0; j < g.n; j++) {
        h += '<td>' + (g.row[j] ? Math.round(g.row[j].score) : 'not played yet') + '</td>';
      }
      h += '</tr>';
    }
    /* s7.29 ruling 5: the same sentence the picture's caption carries, with
       the reason a table has the room for */
    var dn = gridDeadRunNote({ full: true });
    srGrid.innerHTML = h + '</table>' + (dn ? '<p>' + dn + '</p>' : '');
  }

  /* Live, from the games this browser just played, and only once every cell in
     the sample really landed. D4 8.2. */
  function gridSummary() {
    var g = FX.grid, i, j, dn = 0, ds = 0, on = 0, os = 0, c;
    if (!g || g.done < g.total) return '';
    for (i = 0; i < g.n; i++) {
      for (j = 0; j < g.n; j++) {
        c = g.cells[i * g.n + j];
        if (!c) continue;
        if (i === j && g.rows[i] === g.cols[j]) { ds += c.score; dn++; }
        else { os += c.score; on++; }
      }
    }
    /* s7.21 ruling 10, the critic's revision 6. With the crossed pool ticked
       there IS no diagonal, so the old law returned the empty string and the
       page's own argument ended in silence in front of 64 squares. It says
       what it measured instead. */
    /* s7.26 ruling 12: the crossed pool REPLACED the page's own headline
       number ("off the diagonal, 17" became "18") and the dark judge had to
       hold the old one in their head to see that nothing much had changed.
       The uncrossed reading is remembered as the page measures it and printed
       beside the crossed one, so the swap compares itself. */
    if (dn && on) offDiagMemo = Math.round(os / on);
    if (!dn && on) {
      var line = 'Across all ' + on + ' crossed games the keep averaged ' +
                 Math.round(os / on) + ' of ' + HP_KEEP + '.';
      if (offDiagMemo !== null) {
        line += ' Off the diagonal in the other grid it averaged ' +
                offDiagMemo + '.';
      }
      return line;
    }
    if (!dn || !on) return '';
    return 'Down the diagonal the keep averaged ' + Math.round(ds / dn) + ' of ' +
           HP_KEEP + '. Off it, ' + Math.round(os / on) + '.';
  }
  /* the off-diagonal average of the uncrossed grid, once this browser has
     really played one (s7.26 ruling 12) */
  var offDiagMemo = null;

  /* --- Take a row -----------------------------------------------------------
     Your own layout from the your-turn act, played against every engineer in
     the row pool. The layout is replayed through the same build phase every
     other game uses, so your row is one more row of the same measurement. */

  var rowJob = null;

  function cancelRow() {
    if (!rowJob) return;
    rowJob.cancelled = true;
    rowJob = null;
    setStatus('Take a row stopped.');
  }

  /* Build spec v3 s7.15 ruling 4. Take a row used to run the games on the main
     thread: the auditor measured 10 long tasks over 120 ms, worst 590 ms, and
     4,845 ms of blocked main thread while `workerAlive()` was true throughout,
     because the slicing was per EPISODE and one episode IS the long task. The
     games go to the Worker's own row job now (Z-A, `{type:'row'}`), which
     yields between episodes, and the main-thread path is only what is left
     when there is no worker at all. Either way the row comes back with its
     PICTURE, so the You row is drawn like every other row rather than left as
     eight blank boxes, which is what the one moment the visitor is in the
     picture looked like to three judges. */
  function rowMoves() {
    var q = [], i;
    for (i = 0; i < myMoves.length; i++) {
      q.push({ cell: myMoves[i].cell, kind: myMoves[i].piece });
    }
    return q;
  }

  function postRow() {
    if (!worker || !FX.grid) return false;
    try {
      worker.postMessage({ type: 'row', jobId: act.seq, seq: act.seq,
                           seed: act.seed >>> 0, cols: FX.grid.cols,
                           moves: rowMoves(), episodes: GRID_EPISODES });
    } catch (e) { return false; }
    return true;
  }

  function rowProgress(done, total) {
    setStatus('Playing ' + Math.min(done + 1, total) + ' of ' + total +
              ' games with your own layout.', { progress: true });
  }

  function rowFinished() {
    var g = FX.grid, s = 0, n = 0, i;
    if (!g || !g.row) return;
    for (i = 0; i < g.n; i++) if (g.row[i]) { s += g.row[i].score; n++; }
    setStatus(n ? ('Your row is on the grid. You averaged ' + Math.round(s / n) +
                   ' of ' + HP_KEEP + ' across ' + n + ' strangers.')
                : 'Your row could not be played.');
    writeSrGrid();
  }

  function takeRow() {
    if (act.name !== 'strangers') { setAct('strangers'); }
    if (!myMoves.length) {
      setStatus('Build something in Your turn first, and then your own layout ' +
                'can play the strangers.', { force: true });
      return;
    }
    if (!FX.grid) { setStatus(honestMissing(), { force: true }); return; }
    var g = FX.grid, k;
    g.row = [];
    for (k = 0; k < g.n; k++) g.row.push(null);
    writeSrGrid();
    setStatus('Playing 1 of ' + g.n + ' games with your own layout.',
              { force: true, progress: true });
    if (workerAlive && postRow()) return;
    /* SEAM A-S3: a row asked for during the boot waits for the worker rather
       than playing eight real games on the main thread (the auditor's MAJOR 4:
       10 long tasks over 120 ms, worst 590 ms, about 2 fps) */
    if (workerPending) { pendingRow = true; return; }
    if (!Core || !Core.playEpisode) { setStatus(honestMissing(), { force: true }); return; }
    startRowJob();
  }

  /* the fallback, kept honest about what it is: one episode is one task and
     nothing this page owns can chop it up, so it says so */
  function startRowJob() {
    var g = FX.grid;
    var job = { cancelled: false, seq: act.seq, i: 0 };
    rowJob = job;
    function slice() {
      if (job.cancelled || job.seq !== act.seq || !FX.grid || !FX.grid.row) return;
      g.row[job.i] = playMyRow(g.cols[job.i]);
      job.i++;
      writeSrGrid();
      if (job.i < g.n) { rowProgress(job.i, g.n); requestAnimationFrame(slice); }
      else { rowJob = null; rowFinished(); }
    }
    requestAnimationFrame(slice);
  }

  function playMyRow(key) {
    var q = [], i, res = null;
    for (i = 0; i < myMoves.length; i++) {
      q.push({ cell: myMoves[i].cell, kind: myMoves[i].piece,
               x: cx(myMoves[i].cell), y: cy(myMoves[i].cell) });
    }
    try {
      res = Core.playEpisode({ seed: act.seed >>> 0, cfg: coreCfg(),
                               a: { kind: 'human', queue: q }, b: agentFor(key) });
    } catch (e) { return null; }
    if (!res) return null;
    return { score: res.score, hp: res.score, st: res.g ? snapshotOf(res.g) : null };
  }

  /* --- act 2: six plans ---------------------------------------------------
     One network, six hidden numbers. Each tile is a whole game this browser
     just played with that number set, drawn by the same R.fortress the grid
     uses. The bonus-only toggle swaps the net for the run that was trained
     for the recognisable half and nothing else. */

  var planJob = null, planCache = {};

  function specNet() { return netOf(act.bonusOnly ? 'specDiv' : 'spec'); }

  function specAgent(z) {
    var net = specNet();
    if (!net || !Core || !Core.oneHot) return { kind: 'none' };
    return { kind: 'net', net: net, extra: Core.oneHot(z, 6) };
  }

  function startPlans() {
    /* s7.32 ruling 4: the export's style names and converge flags are the
       SPECIALIZER's, measured on that net. Under "Trained only to look
       different" another net plays (specDiv), so its six tiles, the table and
       the tap caption carry the page's own numbers and no converge tag. */
    var own = !act.bonusOnly;
    var names = own ? planLongs() : PLAN_FALLBACK.map(function (n) { return { name: n, line: '' }; });
    var i, cells = [];
    for (i = 0; i < 6; i++) cells.push(null);
    var dist = own ? planDistinct() : null;
    FX.plans = { cells: cells, done: 0, total: 6, names: names,
                 shorts: own ? planNames() : PLAN_FALLBACK.slice(),
                 dist: dist, near: null, numbered: !own };
    FX.caption = plansCaption(FX.plans, false);
    /* s7.32 addendum 2 (2026-10-10): under "Trained only to look different"
       the score was taken out, so "Winning still counted" is not said, and the
       styles clause quotes the export's measurement only for the net it was
       taken on (divStylesSentence) */
    var prose = [
      { text: 'Nobody designed these plans. One engineer was handed a secret number ' +
              'at the start of each game and trained to build in a way its partner ' +
              'could recognise. ' + (own ? 'Winning still counted for the same as it always did. ' +
              stylesSentence() : divStylesSentence()) },
      { note: 1, text: 'This is one network run six times, with a different hidden ' +
              'number each time. It is not six engineers.' },
      /* s7.19 ruling 5: the highlight is computed from the six layouts, so the
         page has to say what it means or it is just a colour */
      { note: 1, text: 'On each card, blocks no other plan built are tinted, and blocks ' +
              'all six built are dimmed. That is measured off these six layouts, not ' +
              'chosen: six identical plans would light nothing up.' }
    ];
    if (haveNames() && own) {
      prose.push({ note: 1, text: 'The names are read off where each style actually ' +
        'spends its credits, by the same measurement that scored them. The engineer ' +
        'was handed a number from one to six and no words at all.' });
      /* s7.32 ruling 4: what a style name means, with the count of games
         read off the export's own probe ("seeds 800000 to 800063") */
      var pg = /(\d+)\D+?(\d+)/.exec(String(metaOf('g0', 'probe') || '')), ng = 0;
      if (pg) ng = (+pg[2]) - (+pg[1]) + 1;
      prose.push({ note: 1, text: 'A style\'s name says what it builds more of than the ' +
        'other five' + (ng > 9 ? ' over ' + ng + ' test games' : '') +
        ', so one game can differ.' });
    } else if (own) {
      prose.push({ note: 1, text: 'The plans are numbered here because the names are ' +
        'read off a trained engineer\'s own layouts after training, and this build ' +
        'has none to read.' });
    }
    if (dist && dist.indexOf(false) >= 0) {
      prose.push({ note: 1, text: 'A card marked as converging is one the test could ' +
        'not tell apart from another plan. The name on the mark is the plan whose ' +
        'board these six games put it closest to.' });
    }
    if (act.bonusOnly) {
      prose.push({ text: 'With the game score taken out, the engineer is trained for ' +
        'one thing only: being recognisable. It still produces six layouts. ' +
        'Being different is easy, and being different ' +
        'while still winning is the part that took a paper. This is why the extra ' +
        'reward sits on top of the score instead of replacing it.' });
      prose.push({ note: 1, text: 'The name for this failure is not mine. Cui and ' +
        'colleagues called it out in ADVERSITY (2023): a diversity reward on its own ' +
        'can be satisfied by playing badly in a distinctive way.' });
    }
    setProse(prose);
    setStatus('Playing 1 of 6 plans.', { force: true, progress: true });
    writeSrPlans();
    startPlanJob();
  }

  /* The caption is COUNTED from the games this browser has actually finished,
     never a fixed string: it used to promise all six of them standing before a
     single game had run, and it was wrong in nearly a third of galleries
     (build spec v3 section 7.11 ruling 1b). */
  function plansCaption(p, finished) {
    var held = 0, played = 0, i, stand, low = null, sc;
    for (i = 0; i < 6; i++) {
      if (!p.cells[i]) continue;
      played++;
      sc = Math.max(0, Math.round(p.cells[i].score));
      if (sc > 0) { held++; if (low === null || sc < low) low = sc; }
    }
    if (!played) {
      return finished ? 'No plans could be played.'
                      : 'Six games, one network run six times. Playing them now.';
    }
    stand = (held === 0) ? 'No keeps standing'
          : (held === 1) ? 'One keep standing'
          : (capFirst(numWord(held)) + ' keeps standing');
    if (!finished) return 'Playing six games. ' + stand + ' so far.';
    /* s7.19 ruling 5, two forms the counted sentence needed. A judge read
       "the weakest at 100 of 100" and called it odd, because when every game
       scores the same there is no weakest; and under 25 the word "standing"
       needs the number beside it to stay honest. */
    var high = null;
    for (i = 0; i < 6; i++) {
      if (!p.cells[i]) continue;
      sc = Math.max(0, Math.round(p.cells[i].score));
      if (sc > 0 && (high === null || sc > high)) high = sc;
    }
    var lead = (played === 6 ? 'Six games. '
                             : (capFirst(numWord(played)) + ' of the six games could be played. '));
    if (held > 1 && low !== null && high === low) {
      return lead + (held === 6 ? ('All six at ' + low + ' of ' + HP_KEEP + '.')
                                : (stand + (held === 2 ? ', both at ' : ', all at ') +   /* s7.32 add. 3 item 7 */
                                   low + ' of ' + HP_KEEP + '.'));
    }
    if (held > 1 && low !== null && low < 25) {
      return lead + stand + ', one barely standing, at ' + low + ' of ' + HP_KEEP + '.';
    }
    /* Build spec v3 s7.15 ruling 8: the caption NAMES HOW the keeps held. A
       judge read "six keeps still standing" over tiles that said 8, 8 and 28
       of 100 and called it the one line on the page that read as spin. The
       count was literally true; what was missing was the weakest of them. */
    return (played === 6 ? 'Six games. '
                         : (capFirst(numWord(played)) + ' of the six games could be played. ')) +
           stand +
           ((low !== null && held > 1)
             ? (', the weakest at ' + low + ' of ' + HP_KEEP + '.') : '.');
  }

  /* Same scheduler law as the grid (D5 8.2): one tile painted per frame and at
     most one 6 ms slice of work, so a plan that costs more than a slice takes
     more frames rather than freezing one. */
  function startPlanJob() {
    var job = { cancelled: false, seq: act.seq, i: 0 };
    planJob = job;
    function slice() {
      if (job.cancelled || job.seq !== act.seq || !FX.plans) return;
      var p = FX.plans, t0 = now(), made = 0;
      while (job.i < p.total && (now() - t0) < 6 && made < 1) {
        var z = job.i;
        var key = (act.bonusOnly ? 'div' : 'spec') + '|' + z + '|' + act.seed;
        var got = cacheHas(planCache, key) ? planCache[key] : null;
        if (!got) {
          got = runPlan(z);
          if (got) planCache[key] = got;
        }
        p.cells[z] = got;
        if (got) p.done++;
        job.i++; made++;
      }
      FX.caption = plansCaption(p, false);
      writeSrPlans();
      if (p.done > 0 && p.done < 6) {
        setStatus('Playing ' + (p.done + 1) + ' of 6 plans.', { progress: true });
      }
      if (job.i < p.total) requestAnimationFrame(slice);
      else {
        planJob = null;
        p.near = convergeMap(p.cells);
        lastNear = p.near;
        FX.caption = plansCaption(p, true);
        syncPartnerUI();
        writeSrPlans();
        if (!p.done) {
          FX.caption = 'No plans could be played yet: ' + honestMissing();
          setStatus('No plans could be played yet.');
        } else if (act.bonusOnly) {
          var best = 0, i;
          for (i = 0; i < 6; i++) if (p.cells[i]) best = Math.max(best, p.cells[i].score);
          setStatus('Six plans played. The best of them kept ' + Math.round(best) +
                    ' of ' + HP_KEEP + '.');
        } else {
          setStatus(plansCaption(p, true));
        }
      }
    }
    requestAnimationFrame(slice);
  }

  function cacheHas(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function runPlan(z) {
    if (!Core || !Core.playEpisode) return null;
    var a = specAgent(z);
    if (a.kind === 'none') return null;
    var res = null;
    try {
      res = Core.playEpisode({ seed: act.seed >>> 0, cfg: coreCfg(), a: a, b: specAgent(z) });
    } catch (e) { return null; }
    if (!res) return null;
    return { score: res.score, hp: res.score,
             st: res.g ? snapshotOf(res.g) : null };
  }

  /* what the last frame really PAINTED under the cards, so a probe reads the
     drawing rather than the intention behind it */
  var plansDrawn = null;
  /* s7.23 ruling 3: the six tile boxes the last gallery frame really drew, so
     a tap can be answered by the plan it landed on. Written only inside
     drawPlans and cleared by resetFx, the same law as the ledgers above. */
  var planCells = null;

  /* 3 x 2 on a desktop, 2 x 3 on a phone (D5 7.8) */
  /* ------------------------------------------------------ the plans' diff
     Build spec v3 s7.19 ruling 5. Three judges, the critic and Fable all read
     the six tiles as one map with a few blocks moved. The difference IS there
     and it is small, so the page computes it and paints it: a block no other
     plan built is tinted in the accent, a block every plan built is dimmed.
     The highlight is derived from the six layouts and never typed, so with
     six identical plans nothing lights up, which is the honest picture.

     The painter is the RENDERER'S (PIN R-S3) when it is there, so the ink and
     the cell geometry match the board; the page keeps a fallback of the same
     design so the act does not depend on a build order. */
  function planDiffSets(p) {
    var i, c, count = [], built = [], n = 0;
    for (c = 0; c < CELLS; c++) count.push(0);
    for (i = 0; i < 6; i++) {
      var st = p.cells[i] ? p.cells[i].st : null;
      var b = new Uint8Array(CELLS);
      if (st && st.piece) {
        for (c = 0; c < CELLS; c++) if (st.piece[c]) { b[c] = 1; count[c]++; }
        n++;
      }
      built.push(b);
    }
    var out = [], tOnly = 0, tShared = 0;
    for (i = 0; i < 6; i++) {
      var only = new Uint8Array(CELLS), shared = new Uint8Array(CELLS), k = 0, sh = 0;
      for (c = 0; c < CELLS; c++) {
        if (!built[i][c]) continue;
        if (count[c] === 1) { only[c] = 1; k++; }
        else if (n > 1 && count[c] === n) { shared[c] = 1; sh++; }
      }
      tOnly += k; tShared += sh;
      out.push({ only: only, shared: shared, n: k, shared_n: sh });
    }
    /* the totals the page really computed, so a suite can tell an honest
       picture (six plans that share every block light nothing up) from a
       painter that stopped running */
    out.totals = { only: tOnly, shared: tShared, plans: n };
    return out;
  }

  /* the cell rects inside a tile, through the renderer's own mapping: the
     tile is R.fortress's fit of the whole source into the box, so a view
     shaped like the one layout() returns gives cellRect the right answer */
  function tileView(box) {
    var sw = RC ? RC.SRCW : 740, sh = RC ? RC.SRCH : 356;
    var s = Math.min(box.w / sw, box.h / sh);
    var dw = Math.max(1, Math.round(sw * s)), dh = Math.max(1, Math.round(sh * s));
    return { ox: Math.round(box.x + (box.w - dw) / 2),
             oy: Math.round(box.y + (box.h - dh) / 2),
             S: s, dpr: 1, fx0: 0, fy0: 0, fw: sw, fh: sh };
  }

  /* PIN R-S3, as the renderer really shipped it: planDiff(plans) computes the
     sets once for the whole gallery and paintPlanDiff(ctx, thumb, plans, index,
     {diff}) paints one tile from them. The page hands it the same array of
     snapshots it hands fortress(), so the highlight and the picture are the
     same six layouts by construction. */
  /* the totals, from whichever computation the page is really painting from */
  function planOnlyTotal(p) {
    var i, n = 0;
    if (p.rdiff && p.rdiff.counts) {
      for (i = 0; i < p.rdiff.counts.length; i++) n += p.rdiff.counts[i].unique || 0;
      return n;
    }
    return (p.diff && p.diff.totals) ? p.diff.totals.only : 0;
  }
  function planSharedTotal(p) {
    var i, n = 0;
    if (p.rdiff && p.rdiff.shared) {
      for (i = 0; i < p.rdiff.cells; i++) if (p.rdiff.shared[i]) n++;
      return n;
    }
    return (p.diff && p.diff.totals) ? p.diff.totals.shared : 0;
  }

  /* ---- the tile's own sentence (build spec v3 s7.21 ruling 5) -------------
     Three rounds and nine judges read the six tiles as one map with a few
     blocks moved. Z-R's half is the difference PICTURE; this half is a
     one-line descriptor COMPUTED FROM THE LAYOUT and never typed, so it
     cannot say something the tile does not show.

     The zones are the map's own landforms, read from core's terrain: the three
     gate mouths and the gorges behind them, the open crossing under them, the
     approach to the keep, and the keep's yard. If Z-R ships a descriptor
     helper with PIN R-S6 the page takes it instead (SEAM P14-S2 names the
     entry point), and this stays as the fallback. */
  var ZONE_MEM = null;

  function zoneOfCell(cell) {
    if (!ZONE_MEM) {
      var t = terrain(), i, s;
      var mid = function (list) {
        var n = 0, x = 0, j;
        for (j = 0; j < list.length; j++) { x += list[j][0]; n++; }
        return n ? (x / n) : -1;
      };
      ZONE_MEM = { ok: false };
      if (t && t.gateW && t.gateE) {
        ZONE_MEM = { ok: true, w: mid(t.gateW), c: (t.gateC && t.gateC.length) ? mid(t.gateC) : -1,
                     e: mid(t.gateE), mouthRow: 1, gorgeRow: 5, crossRow: 8, keepRow: 14 };
        s = t.keep && t.keep.length ? t.keep[0][1] : 15;
        ZONE_MEM.keepRow = Math.max(9, s - 1);
      }
    }
    var Z = ZONE_MEM;
    if (!Z.ok) return 'the board';
    var x = cx(cell), y = cy(cell), side = '', best = 1e9, d;
    var cands = [['west', Z.w], ['centre', Z.c], ['east', Z.e]];
    for (var k = 0; k < cands.length; k++) {
      if (cands[k][1] < 0) continue;
      d = Math.abs(x - cands[k][1]);
      if (d < best) { best = d; side = cands[k][0]; }
    }
    if (y <= Z.mouthRow) return 'the ' + side + ' gate';
    if (y <= Z.gorgeRow) return 'the ' + side + ' gorge';
    if (y <= Z.crossRow) return 'the ' + side + ' crossing';
    if (y <= Z.keepRow) return 'the ' + side + ' approach';
    return 'the keep yard';
  }

  /* "at the west gate" / "on the approach": a gate and a gorge are places you
     stand AT, the open ground is one you stand ON */
  function zonePrep(z) {
    return (z.indexOf('gate') >= 0 || z.indexOf('gorge') >= 0) ? 'at ' : 'on ';
  }

  function topZones(counts) {
    var keys = [], k, total = 0;
    for (k in counts) {
      if (!Object.prototype.hasOwnProperty.call(counts, k)) continue;
      keys.push(k); total += counts[k];
    }
    keys.sort(function (a, b) { return counts[b] - counts[a]; });
    return { keys: keys, total: total };
  }

  /* Every form of one plan's line, longest first, so the tile can take the
     longest that fits its own width at any viewport instead of being clipped
     (the same law the caption strip uses). */
  function planDescribeForms(st) {
    if (!st || !st.piece) return [''];
    var wc = {}, gc = {}, c, z, nw = 0, ng = 0;
    for (c = 0; c < CELLS; c++) {
      if (!st.piece[c]) continue;
      z = zoneOfCell(c);
      if (st.piece[c] === PIECE_GUN) { gc[z] = (gc[z] || 0) + 1; ng++; }
      else { wc[z] = (wc[z] || 0) + 1; nw++; }
    }
    if (!nw && !ng) return ['nothing built'];
    var w = topZones(wc), g = topZones(gc);
    var w1 = w.keys[0] || '', w2 = w.keys[1] || '', g1 = g.keys[0] || '';
    var bare = function (s) { return s.replace(/^the /, ''); };
    var two = nw && w2 && wc[w2] >= wc[w1] * 0.75;
    /* The COUNT rides with the place. Six plans of one engineer put their
       walls in the same few landforms often enough that the place alone said
       the same thing about all six, which is exactly the reading the ruling is
       trying to break; the number of pieces is the other half of what the
       picture shows and it is computed from the same cells. */
    var wn = numWord(nw) + (nw === 1 ? ' wall ' : ' walls ');
    var wallLong = nw ? (wn + zonePrep(w1) + w1 + (two ? (' and ' + w2) : '')) : '';
    var wallMid = nw ? (wn + zonePrep(w1) + w1) : '';
    var wallShort = nw ? (String(nw) + (nw === 1 ? ' wall ' : ' walls ') + bare(w1)) : '';
    var gunLong = ng ? (numWord(ng) + (ng === 1 ? ' catapult ' : ' catapults ') +
                        zonePrep(g1) + g1) : '';
    var gunShort = ng ? (String(ng) + (ng === 1 ? ' catapult ' : ' catapults ') +
                         bare(g1)) : '';
    var join = function (a, b) { return (a && b) ? (a + '; ' + b) : (a || b); };
    var out = [join(wallLong, gunLong)];
    if (two) out.push(join(wallMid, gunLong));
    out.push(join(wallShort, gunShort));
    if (nw && ng) out.push(wallShort);
    return out;
  }

  /* SEAM R2O-S3 TAKEN. The renderer owns the VOCABULARY, because the six plan
     names the export ships are written by `train/gates/g0.py`'s own row and
     column bands and `R.planWords` carries those tables verbatim: a tile
     titled "Centre shelf" with a line under it calling the same ground "the
     open crossing" is a new contradiction, not a new sentence. It also owns
     which facts are THIS plan's own (`ownWalled`, `ownOpen`, `ownGunPlaces`,
     `uniquePlaces`), because five of the six wall the west and centre gates
     and a descriptor built from "where most of its credits went" would print
     one sentence under six tiles. The page writes the sentence; the renderer
     decides what is true about the picture. */
  function sideGates(a) {
    if (!a || !a.length) return '';
    if (a.length === 1) return 'the ' + a[0] + ' gate';
    if (a.length === 2) return 'the ' + a[0] + ' and ' + a[1] + ' gates';
    return 'all three gates';
  }
  function pieceWord(kind, n) {
    if (kind === 'gun') return n === 1 ? 'catapult' : 'catapults';
    return n === 1 ? 'wall' : 'walls';
  }

  function planWordForms(plans, index, diff) {
    var W = null;
    if (!(R && R.planWords)) return null;
    try { W = R.planWords(plans, index, { diff: diff || null }); } catch (e) { W = null; }
    if (!W) return null;
    /* PIN R-S7 TAKEN (s7.22 rulings 5 and 7): the renderer now returns THE
       SENTENCE, long first and then the narrow-tile short form, because the
       six-of-six distinctness guarantee is a property of the SET and this call
       site only ever sees one tile. `forms` is what `planDescFit` walks, so a
       320 px tile takes the short form BEFORE it may ellipsise. The page's own
       construction below stays as the path for a renderer that has not landed
       the pin yet, and for one that has no planWords at all. */
    var pinned = [], pk;
    if (W.forms && typeof W.forms.length === 'number') {
      for (pk = 0; pk < W.forms.length; pk++) {
        if (typeof W.forms[pk] === 'string' && W.forms[pk]) pinned.push(W.forms[pk]);
      }
    } else {
      if (typeof W.phrase === 'string' && W.phrase) pinned.push(W.phrase);
      if (typeof W.phraseShort === 'string' && W.phraseShort &&
          W.phraseShort !== W.phrase) pinned.push(W.phraseShort);
    }
    if (pinned.length) return pinned;
    var head = '', headShort = '', u;
    if (W.ownWalled && W.ownWalled.length) {
      head = 'walls ' + sideGates(W.ownWalled);
      headShort = 'walls the ' + W.ownWalled[0] + ' gate';
    } else if (W.ownOpen && W.ownOpen.length) {
      head = 'leaves ' + sideGates(W.ownOpen) + ' open';
      headShort = 'the ' + W.ownOpen[0] + ' gate left open';
    } else if (W.uniquePlaces && W.uniquePlaces.length) {
      u = W.uniquePlaces[0];
      head = numWord(u.n) + ' ' + pieceWord(u.kind, u.n) + ' ' + u.words;
      headShort = head;
    } else if (W.walled && W.walled.length) {
      head = 'walls ' + sideGates(W.walled);
      headShort = 'walls the ' + W.walled[0] + ' gate';
    }
    var g = (W.ownGunPlaces && W.ownGunPlaces.length) ? W.ownGunPlaces[0]
          : ((W.gunPlaces && W.gunPlaces.length) ? W.gunPlaces[0] : null);
    var tail = g ? (numWord(g.n) + ' ' + pieceWord('gun', g.n) + ' ' + g.words) : '';
    if (!head && !tail) {
      return W.blocks ? [numWord(W.blocks) + ' blocks, all shared'] : ['nothing built'];
    }
    var join = function (a, b) { return (a && b) ? (a + '; ' + b) : (a || b); };
    var out = [join(head, tail)];
    if (headShort !== head) out.push(join(headShort, tail));
    if (head && tail) out.push(headShort || head);
    return out;
  }

  /* the longest form that really fits a tile this wide, WHOLE. s7.23 ruling 2:
     the LONG form is taken whenever it fits in two lines at the tile's width
     and a shorter one only when it does not, and the frame reports WHICH form
     it took (0 is the long sentence, the last index is the narrowest) and over
     how many lines. s7.23 ruling 3 removed the other end of the old ladder:
     nothing in this gallery is ever ellipsised, at any width, so when no form
     fits whole the fitter returns null and the tile carries no line at all. */
  function descFont(px) {
    ctx.font = '400 ' + px + 'px "Source Sans 3", system-ui, sans-serif';
  }

  /* a form split over two lines, greedy on words. s7.23 ruling 2 makes this
     the ordinary case rather than the narrow-tile one: at 1440x900 the long
     sentence is about 470 px of type against a 383 px tile, so two lines are
     what let a visitor read the WHOLE sentence the renderer computed instead
     of the clipped fragment a one-line strip could hold. */
  function wrapTwo(s, maxW) {
    var words = String(s).split(' '), a = '', b = '', k;
    for (k = 0; k < words.length; k++) {
      var t = a ? (a + ' ' + words[k]) : words[k];
      if (!a || ctx.measureText(t).width <= maxW) a = t;
      else break;
    }
    b = words.slice(k).join(' ');
    if (!b) return null;
    /* BOTH lines are measured, not just the second. The greedy fill takes the
       first word whatever it measures, so a single word wider than the tile
       would otherwise be reported as a fit and painted past the tile's edge.
       Under s7.23 ruling 3 the honest answer to that is the same as for a
       sentence that will not fit: this form does not fit, try a shorter one,
       and if none fits paint nothing. */
    return { a: a, b: b, fit: ctx.measureText(b).width <= maxW &&
                              ctx.measureText(a).width <= maxW };
  }

  /* s7.25 ruling 2 (2026-09-12): ONE NAMING SYSTEM, AND THE TILE SAYS WHAT
     EACH HALF OF IT IS.

     The six names on this page are the trained export's, and they name a
     STYLE: where that hidden number spends its credits across the test games.
     The sentence under a tile is computed from the six games THIS browser just
     played. Both are true and they are about different things, which is how a
     tile named for the east mouth could carry a line about the centre shelf
     and read as a mislabel (the round-4 critic, and i1p/names.js measured it
     on two tiles of six in the dark gallery and three in the light).

     So the tile says which is which: the head reads the name AS A STYLE ("East
     mouth style") and the line under it opens with "this game: ". Nothing is
     renamed and no second naming system reaches the screen, which is the
     ruling's own reason for keeping the export's names everywhere. The prefix
     is on the FORM, not on the painting, so the fitter measures what it draws,
     the screen-reader table and the tap caption carry the same words, and
     `planPhrases()` reports what the page was really offered. */
  var THIS_GAME = 'this game: ';
  function styleHead(name) {
    return name ? (String(name) + ' style') : '';
  }
  /* s7.32 ruling 4: a numbered plan is not a style, so it carries its bare
     number ("Plan 3"), never "Plan 3 style" */
  function planHead(p, i) {
    return (p && p.numbered) ? String(p.shorts[i]) : styleHead(p.shorts[i]);
  }
  /* every form PIN R-S7 offered this tile, longest first, with the page's own
     construction behind it for a renderer that has not landed the pin */
  function planFormsFor(p, i) {
    var st = (p && p.cells && p.cells[i]) ? p.cells[i].st : null;
    var forms = planWordForms(p && p.rstates, i, p && p.rdiff) || planDescribeForms(st);
    var out = [], k;
    for (k = 0; k < forms.length; k++) {
      out.push(forms[k] ? (THIS_GAME + forms[k]) : forms[k]);
    }
    return out;
  }

  /* s7.23 ruling 2's ladder, and nothing below it. Size is the outer step and
     the FORM is the inner one, so at a given size the long sentence is tried
     on one line and then on two before any shorter form is looked at: "the
     LONG form is taken whenever it fits in two lines at the tile's width; the
     short form only when it does not". A whole sentence one point smaller
     still reads, so 10 px is tried after 11.

     There is no rung below the shortest form. s7.23 ruling 3 forbids an
     ellipsis in this gallery at any width and forbids a third form, so when
     nothing fits whole this returns NULL and the caller paints no line: the
     sentence is then read by tapping the tile, which is the same ruling's own
     answer for a tile too narrow to carry it. */
  function planDescFit(p, i, maxW, sizes, lines) {
    var forms = planFormsFor(p, i);
    var k, si, wr;
    sizes = (sizes && sizes.length) ? sizes : [11];
    for (si = 0; si < sizes.length; si++) {
      descFont(sizes[si]);
      for (k = 0; k < forms.length; k++) {
        if (!forms[k]) continue;
        if (ctx.measureText(forms[k]).width <= maxW) {
          return { text: forms[k], lines: [forms[k]], fit: true, form: k,
                   forms: forms.length, size: sizes[si] };
        }
        if (lines > 1) {
          wr = wrapTwo(forms[k], maxW);
          if (wr && wr.fit) {
            return { text: wr.a + ' ' + wr.b, lines: [wr.a, wr.b], fit: true,
                     form: k, forms: forms.length, size: sizes[si] };
          }
        }
      }
    }
    return null;
  }

  function planStates(p) {
    var out = [], i;
    for (i = 0; i < 6; i++) out.push(p.cells[i] ? p.cells[i].st : null);
    return out;
  }

  /* PIN R-S3's highlight, kept as the FALLBACK for a renderer without PIN
     R-S6's `planTile` (SEAM R2O-S1, taken in drawPlans). */
  function paintPlanDiff(box, sets, p, index) {
    if (R && R.paintPlanDiff && p && p.rdiff) {
      try {
        R.paintPlanDiff(ctx, box, p.rstates, index, { diff: p.rdiff });
        var cnt = p.rdiff.counts && p.rdiff.counts[index];
        return cnt ? (cnt.unique || 0) : 0;
      } catch (e) { /* fall through to the page's own */ }
    }
    if (!sets) return 0;
    var v = tileView(box), c, r, n = 0;
    ctx.save();
    ctx.beginPath();
    for (c = 0; c < CELLS; c++) {
      if (!sets.shared[c]) continue;
      r = null;
      try { r = RAPI && RAPI.cellRect ? RAPI.cellRect(v, c) : null; } catch (e) { r = null; }
      if (!r || !isFinite(r.x)) continue;
      ctx.rect(r.x, r.y, Math.max(1, r.w), Math.max(1, r.h));
    }
    ctx.fillStyle = isLight() ? 'rgba(255,255,255,0.34)' : 'rgba(0,0,0,0.34)';
    ctx.fill();
    ctx.beginPath();
    for (c = 0; c < CELLS; c++) {
      if (!sets.only[c]) continue;
      r = null;
      try { r = RAPI && RAPI.cellRect ? RAPI.cellRect(v, c) : null; } catch (e) { r = null; }
      if (!r || !isFinite(r.x)) continue;
      ctx.rect(r.x, r.y, Math.max(1, r.w), Math.max(1, r.h));
      n++;
    }
    ctx.fillStyle = isLight() ? 'rgba(52,86,138,0.42)' : 'rgba(130,166,204,0.42)';
    ctx.fill();
    ctx.restore();
    return n;
  }

  function drawPlans() {
    /* s7.19 ruling 5: desktop shows the plans 2-UP. At three across the tile
       is 340 px and the six read as one picture; two across spends the width
       the panel leaves on the thing the act is about. */
    var p = FX.plans, cols = 2, rows = 3;
    var ar = (RC && RC.SRCH && RC.SRCW) ? (RC.SRCH / RC.SRCW) : 0.5;
    /* a third caption line only exists when meta flags a plan as converged */
    var tags = !!(p.dist && p.dist.indexOf(false) >= 0);
    /* Ruling 5 wants the tile at 500 px and the stage is three rows deep, so
       the label goes ON the tile, on a plate over its own bottom bezel, and
       every pixel the strip used to reserve is spent on the picture instead.
       At 1440x900 that is 348 px against 441; the ruling's own bar needs about
       a 950 px tall window and the act says which number it got. */
    /* 28 px is measured, not chosen: over the six plans this page plays it
       covers ZERO built cells of the board under it, where 30 px covers six of
       ninety (`_tests/twoengineers/p12/plateband.js`). The converge tag goes on
       its own plate at the TOP of the tile, in the sky band above the first
       row, where it can cover nothing at all. */
    /* s7.21 ruling 5: a one-line COMPUTED descriptor under each tile. It is a
       caption for the picture, so it lives OUTSIDE the tile (the label plate
       on the bottom bezel is already as much as may ride on the board without
       covering built cells: 28 px covers zero, 30 covers six of ninety). */
    var labH = 28, tagH = 16;
    /* s7.23 ruling 2: the descriptor strip is TWO lines of 11 px type at a
       12 px leading, which is 26 px of room (2 px of offset, the leading, the
       second line's own body and 1 px for its descenders). The row gap drops
       from 10 px to 8 px while the strip is up, because the strip itself is
       what separates one row of tiles from the next. */
    var CAP_H2 = 26, DESC_LH = 12;
    /* the tile width under which NO descriptor is painted at all (s7.23
       ruling 3). It is measured, not chosen: at 1440x900 the six sentences
       PIN R-S7 offers run 268 to 627 px of type, so two lines of a 300 px
       tile (588 px at 11 px, 2 x 294) is about where the shortest form of the
       longest tile stops fitting WHOLE. Below it the only ways to print a line
       are an ellipsis, which ruling 3 forbids at any width, or a third form,
       which the same ruling forbids by name, so the gallery prints nothing and
       the caption invites a tap instead. p16/probe2.js is the measurement:
       at the phone's 133 to 179 px tiles not one of the six forms of any tile
       fits two lines, and at 300 px and up every tile fits its LONG one. */
    var DESC_MIN_W = 300;
    var GAP1 = 10, GAP2 = 8;
    var availW = Math.max(120, stripW() - 32);
    /* s7.21 ruling 4: the gallery stops at the caption plate's own top edge
       (floorY already keeps 8 px clear of it) */
    var floorY = Math.min(cssH - (view.botPad || 0), capTopY || cssH) - 8;
    var availH = Math.max(120, floorY - (view.topPad || 0));
    /* the gap is charged (rows - 1) times, which is how many there are: the
       old form charged one per row and spent a whole gap of stage on nothing.
       That correction is what pays for the second descriptor line, so the
       tile keeps the width s7.22 ruling 4 pinned (383 px at 1440x900 against
       a 380 px bar, measured, where the one-line strip drew 385). */
    var fitW = function (cap, g, res) {
      return Math.max(60, Math.floor(Math.min(availW / cols,
        ((availH - res - (rows - 1) * g) / rows - cap) / ar)));
    };
    var w2 = fitW(CAP_H2, GAP2, 0), w0 = fitW(0, GAP1, 0);
    var descUnder = w2 >= DESC_MIN_W;
    var capH = descUnder ? CAP_H2 : 0;
    var gap = descUnder ? GAP2 : GAP1;
    var descLines = descUnder ? 2 : 0;
    var w = descUnder ? w2 : w0;
    /* s7.23 ruling 3: on a phone the sentence a tap asks for is shown in the
       CAPTION CARD, and that card lives in the room under the gallery, which
       `phoneSlot` measures from `galleryBottom` down to the caption plate. So
       the block RESERVES that room: CARD_MIN for the card's three lines, the
       two SLOT_PADs around it and the block's own trailing gap.

       At 390 x 844 dpr 2 the reserve costs the tile 1 px of 179, because the
       phone tile is limited by the width of the page and not by its height.
       At 320 it costs nothing while the caption is one line and up to 10 px of
       144 when the caption wraps, which is worth paying for a sentence a
       visitor can read; at a SHORT phone (360 x 740) it would cost a third of
       the tile, and there the card yields instead and the answer stays in the
       status line and the live region. The tenth-of-its-width law is the same
       one the old two-line strip used. */
    var CARD_ROOM = CARD_MIN + 2 * SLOT_PAD + GAP1, CARD_KEEP = 0.9;
    var reserve = 0, wR;
    if (phone() && actbar) {
      wR = fitW(capH, gap, CARD_ROOM);
      if (wR >= Math.floor(w * CARD_KEEP)) { reserve = CARD_ROOM; w = wR; }
    }
    var availBlock = Math.max(60, availH - reserve);
    var h = Math.max(30, Math.round(w * ar));
    var x0 = Math.round((stripW() - (w + gap) * cols) / 2);
    var contentH = rows * h + rows * capH + (rows - 1) * gap;
    var y0 = Math.round((view.topPad || 0) +
             Math.max(0, (availBlock - contentH) / 2));
    /* s7.22 ruling 3: the picture starts on the board's own top edge, which is
       where Watch a wave and Your turn put theirs, whenever the caption row
       this gallery stops at leaves the room for it. When it does not, the
       centred value stands and `plansDrawn` says which one the frame drew. */
    var edge = boardTopEdge(), alignTop = false;
    if (edge !== null && edge >= (view.topPad || 0) - 0.5 &&
        edge + contentH <= floorY - reserve + 0.5) {
      y0 = Math.round(edge);
      alignTop = true;
    }
    var i, shorts = p.shorts;
    /* the diff is derived once per set of finished games, not per frame */
    if (!p.diff || p.diffDone !== p.done) {
      p.diff = planDiffSets(p);
      p.diffDone = p.done;
      /* the renderer's own sets, computed ONCE for the six tiles (PIN R-S3) */
      p.rstates = planStates(p);
      p.rdiff = null;
      if (R && R.planDiff) {
        try { p.rdiff = R.planDiff(p.rstates); } catch (e) { p.rdiff = null; }
      }
      /* SEAM I1O-S1 CLOSED 2026-09-11 (the wave-1o integration hand), build
         spec v3 s7.23 ruling 3: the screen-reader table's "What it built"
         column is the text equivalent of the sentence under a tile, so the two
         must say the same thing. Both go through `planFormsFor`, which reads
         the `p.rstates` / `p.rdiff` built HERE, and the plan job writes the
         table from its own slice (`startPlanJob`), which runs BEFORE the draw
         that rebuilds them. The sixth game's slice therefore wrote the table
         from a FIVE-state snapshot and nothing rewrote it: measured on the
         served page, 1 to 2 of the six rows said something the picture did not
         (`i1o/srdiag.js`, 6 of 6 rows reproduced from a five-state
         recomputation). Rewriting it where the states change costs one call per
         change of `p.done` and keeps the two surfaces in step by construction. */
      writeSrPlans();
    }
    plansDrawn = { tags: [null, null, null, null, null, null], capH: capH,
                   cols: cols, tileW: w, tileH: h, labH: labH, diff: 0,
                   /* s7.28 ruling 7: the result line each tile really printed */
                   results: [null, null, null, null, null, null],
                   descs: [null, null, null, null, null, null],
                   /* s7.25 ruling 2: the head each tile really painted, so a
                      probe reads "East mouth style" off the frame rather than
                      inferring it from the name the gallery was handed */
                   heads: [null, null, null, null, null, null],
                   /* which of planWords' forms each tile took, and over how
                      many lines it was drawn (s7.22 r7) */
                   descForm: [null, null, null, null, null, null], descForms: 0,
                   descRows: [null, null, null, null, null, null],
                   /* s7.23 ruling 2: lines per tile (descRows) and the block's
                      own top (gridTop), plus the two widths the layout chose
                      between and the width under which no line is painted */
                   descLines: descLines, capTry: { w0: w0, w2: w2, capH: capH,
                                                   minW: DESC_MIN_W,
                                                   availH: Math.round(availH) },
                   descFit: true, descDrop: 0, tagFit: true,
                   descUnder: descUnder, descOn: descUnder,
                   /* s7.22 ruling 3: where the picture really started, the
                      board edge it was offered, and whether it took it */
                   gridTop: y0, boardTop: edge, alignedTop: alignTop,
                   cardRoom: reserve, capReserve: CARD_ROOM,
                   floorY: Math.round(floorY), contentH: Math.round(contentH),
                   only: planOnlyTotal(p), shared: planSharedTotal(p),
                   /* s7.29 ruling 3: which tile this frame really ringed */
                   ring: -1 };
    ctx.save();
    ctx.font = '600 12px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (i = 0; i < 6; i++) {
      var c = p.cells[i];
      var bx = x0 + (i % cols) * (w + gap);
      var by = y0 + ((i / cols) | 0) * (h + capH + gap);
      ctx.fillStyle = plateCol(0.35);
      ctx.fillRect(bx, by, w, h);
      if (c && c.st) {
        /* SEAM R2O-S1 TAKEN (PIN R-S6, s7.21 ruling 5): the tile is ONE
           DIFFERENCE PICTURE, baked and cached by the renderer, and it
           REPLACES the fortress + highlight pair rather than sitting on top of
           it. The shared map and the blocks all six built are dimmed to 25
           percent, the keep and the machines stay at full strength, and this
           plan's own blocks carry the accent. `planTile` returns where the
           accent really landed, so the ledger counts the drawing. */
        var rc = null;
        if (R && R.planTile && p.rstates) {
          try {
            rc = R.planTile(ctx, { x: bx, y: by, w: w, h: h }, p.rstates, i,
                            { diff: p.rdiff || null,
                              hpMax: { wall: HP_WALL, gun: HP_GUN, keep: HP_KEEP } });
          } catch (e) { rc = null; }
        }
        if (rc) plansDrawn.diff += (typeof rc.unique === 'number') ? rc.unique : 0;
        else if (R && R.fortress) {
          try {
            R.fortress(ctx, { x: bx, y: by, w: w, h: h }, c.st,
                       { hpMax: { wall: HP_WALL, gun: HP_GUN, keep: HP_KEEP } });
          } catch (e) {}
          plansDrawn.diff += paintPlanDiff({ x: bx, y: by, w: w, h: h },
                                           p.diff ? p.diff[i] : null, p, i);
        }
      }
      ctx.strokeStyle = ink(0.28);
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, h - 1);
      /* ---- s7.29 ruling 3: THE PICKED TILE IS RINGED ----------------------
         The sentence a press prints belongs to one of six pictures, and until
         this ruling nothing on screen said which. The ring is the accent, two
         pixels, drawn just outside the tile's own hairline so it cannot eat a
         row of the picture, and it is the same affordance the Strangers grid
         already uses for the diagonal. */
      if (i === planTapped && c && c.st) {
        ctx.strokeStyle = accent();
        ctx.lineWidth = 2;
        ctx.strokeRect(bx - 1, by - 1, w + 2, h + 2);
        ctx.lineWidth = 1;
        plansDrawn.ring = i;
      }
      /* the label rides ON the tile, on its own plate over the bottom bezel:
         the plate is the contrast, so the words read over any board */
      var ly2 = by + h - labH;
      ctx.fillStyle = plateCol(0.86);
      ctx.fillRect(bx + 1, ly2, w - 2, labH - 1);
      ctx.fillStyle = ink(0.94);
      /* s7.25 ruling 2: the head reads the name AS A STYLE, so the line under
         the tile ("this game: ...") is plainly a different fact about the same
         plan. The bare name is the fallback for a tile too narrow to carry the
         longer head, and the frame records which it took. */
      var headTxt = planHead(p, i);
      if (ctx.measureText(headTxt).width > w - 8) headTxt = shorts[i];
      plansDrawn.heads[i] = headTxt;
      ctx.fillText(headTxt, bx + w / 2, ly2 + 2);
      /* ---- s7.28 ruling 7: A FALLEN KEEP IS NOT A HELD KEEP ---------------
         The tile line read "Keep held 0 of 100" wherever the keep fell, and
         the light reduced-motion judge filed it against a page that says
         "The keep fell" everywhere else. The count is the same count the
         gallery's own caption uses for "standing" (plansCaption), so the two
         can never disagree about which games held. */
      var tileHp = c ? Math.max(0, Math.round(c.score)) : null;
      var scoreTxt = (tileHp === null) ? 'playing'
                   : (tileHp > 0 ? ('Keep held ' + tileHp + ' of ' + HP_KEEP)
                                 : 'The keep fell');
      var dd = null;
      if (c && c.st && descUnder) {
        /* the forms first, then one point of type: a whole sentence at 10 px
           reads and no sentence at all is better than a clipped one
           (s7.23 rulings 2 and 3) */
        dd = planDescFit(p, i, w - 6, w < 260 ? [10] : [11, 10], descLines);
        if (dd) {
          plansDrawn.descs[i] = dd.text;
          plansDrawn.descForm[i] = dd.form;
          plansDrawn.descForms = dd.forms;
          plansDrawn.descSize = dd.size;
          plansDrawn.descRows[i] = dd.lines ? dd.lines.length : 1;
        } else {
          /* the strip is up and this one tile still could not take a whole
             form. It prints nothing rather than an ellipsis, and the ledger
             counts it so a suite reads a dropped line as a dropped line. */
          plansDrawn.descFit = false;
          plansDrawn.descDrop++;
        }
      }
      ctx.font = '400 11px "Source Sans 3", system-ui, sans-serif';
      ctx.fillStyle = ink(0.68);
      plansDrawn.results[i] = scoreTxt;
      ctx.fillText(scoreTxt, bx + w / 2, ly2 + 15);
      /* the SKY BAND at the top of the tile, where nothing on the board is
         drawn: the converge tag */
      var tagTxt = (tags && p.dist && !p.dist[i])
        ? convergeTag(i, p.near, shorts, p.dist) : null;
      plansDrawn.tags[i] = tagTxt;
      if (tagTxt) {
        ctx.font = '400 10px "Source Sans 3", system-ui, sans-serif';
        ctx.fillStyle = plateCol(0.86);
        ctx.fillRect(bx + 1, by + 1, w - 2, tagH);
        ctx.fillStyle = ink(0.6);
        /* the longest form that really fits this tile (convergeTagForms) */
        var room = Math.max(24, w - 8);
        var forms = convergeTagForms(i, p.near, shorts, p.dist), fi, shown = null;
        for (fi = 0; fi < forms.length; fi++) {
          if (ctx.measureText(forms[fi]).width <= room) { shown = forms[fi]; break; }
        }
        /* s7.23 ruling 3: no ellipsis is painted in this gallery at any width,
           and that covers the converge tag too. A tag that will not fit in any
           of its forms is not printed, and the ledger says so. */
        if (shown === null) {
          plansDrawn.tagFit = false;
          plansDrawn.tags[i] = null;
        } else {
          /* the hook reports the form the frame really printed */
          plansDrawn.tags[i] = shown;
          ctx.fillText(shown, bx + w / 2, by + 4);
        }
      }
      if (descUnder && dd) {
        /* the size the fitter really settled on, so the line is drawn in the
           face it was measured in, and its one or two lines in the strip the
           layout reserved for them (s7.23 ruling 2) */
        descFont(dd.size || (w < 260 ? 10 : 11));
        ctx.fillStyle = ink(0.66);
        var dl = dd.lines || [dd.text], di;
        for (di = 0; di < dl.length; di++) {
          ctx.fillText(dl[di], bx + w / 2, by + h + 2 + di * DESC_LH);
        }
      }
      ctx.font = '600 12px "Source Sans 3", system-ui, sans-serif';
    }
    ctx.restore();
    galleryBottom = y0 + contentH + gap;
    /* s7.23 ruling 3: the six tiles are hit-testable, so a tap or a click can
       put the LONG sentence in the caption card. The geometry is recorded here
       rather than re-derived in the hit test, for the same reason `gridCells`
       is: two copies of a layout drift and the tap lands on the wrong plan. */
    planCells = { x0: x0, y0: y0, w: w, h: h, capH: capH, gap: gap,
                  cols: cols, rows: rows };
  }

  /* s7.23 ruling 3. Selecting a plan shows what it built, in the LONG form,
     in the caption card (the phone's `#kit-capcard` carries the status line,
     and on a desktop the panel's status slot is the same writer). It answers
     at every width, not only where the tiles are too narrow to carry a line:
     the sentence under a tile is the same sentence, and a visitor who taps a
     picture is asking about that picture. */
  function planTapAt(x, y) {
    var p = FX.plans, G = planCells;
    if (!p || !G || act.name !== 'plans') return false;
    var col = Math.floor((x - G.x0) / (G.w + G.gap));
    if (col < 0 || col >= G.cols) return false;
    if ((x - G.x0) - col * (G.w + G.gap) > G.w) return false;
    var pitch = G.h + G.capH + G.gap;
    var row = Math.floor((y - G.y0) / pitch);
    if (row < 0 || row >= G.rows) return false;
    if ((y - G.y0) - row * pitch > G.h) return false;
    var i = row * G.cols + col;
    if (i < 0 || i > 5) return false;
    var c = p.cells[i];
    if (!c || !c.st) {
      planTapped = -1; syncCapcardText();
      setStatus('That plan has not been played yet.', { force: true });
      return true;
    }
    var forms = planFormsFor(p, i), say = forms && forms[0] ? forms[0] : '';
    if (!say) return false;
    /* s7.29 ruling 3: a second press on the SAME tile lets it go, so the ring
       is a toggle a visitor can undo without hunting for empty board */
    if (i === planTapped) {
      planTapped = -1;
      setStatus(plansCaption(p, !planJob), { force: true });
      capForce(captionWant());
      syncCapcardText();
      return true;
    }
    /* s7.25 ruling 2: the same two halves the tile carries, in one sentence,
       for the widths where no line is painted under the tile at all */
    setStatus(planHead(p, i) + ', ' + say + '.', { force: true });
    /* s7.26 ruling 8: and the phone's card carries that one sentence. The
       caption row it takes is handed over in the SAME frame (capForce), not
       after the 1.5 s dwell, so the card is never drawn at the small size
       first and then re-laid out under the visitor's finger.
       s7.29 ruling 3: the desktop's caption is handed over in the same frame
       for the same reason, since it is the desktop's card. */
    planTapped = i;
    capForce(captionWant());
    syncCapcardText();
    return true;
  }

  /* s7.26 ruling 8: the plan a visitor last picked in THIS gallery, and the
     sentence the phone card shows for it. Cleared by resetFx with the rest of
     the per-act state, so a gallery never opens holding the last one's pick. */
  var planTapped = -1;
  function planTapLine() {
    var p = FX.plans, i = planTapped;
    if (!p || i < 0 || i > 5 || !p.cells[i] || !p.cells[i].st) return '';
    var forms = planFormsFor(p, i), say = forms && forms[0] ? forms[0] : '';
    if (!say) return '';
    return planHead(p, i) + ', ' + say + '.';
  }

  /* s7.23 ruling 3: where no line is painted under the tiles, the gallery's
     own caption says once how to read one. The verb follows the pointer
     through the page's existing touchFirst law, so a mouse is told to click. */
  function planTapInvite(t) {
    if (!t || !plansDrawn || plansDrawn.descUnder !== false) return t;
    if (!FX.plans || !FX.plans.done) return t;
    return t + ' ' + tapWord() + ' a plan to read what it built.';
  }

  function writeSrPlans() {
    var el = byId('kit-sr-plans'), p = FX.plans, i, h;
    if (!el) return;
    if (!p) { el.innerHTML = ''; return; }
    /* s7.24 ruling 10: the sentence over this table is computed from the rows
       under it. The styles clause keeps its distinctness count (that is a
       measurement of the export and not of these six games) and drops the
       probe's holds clause, and the second sentence is the gallery's own
       caption, which counts the keeps the table lists. */
    h = '<p>' + (p.numbered ? divStylesSentence({ noHold: true }) : stylesSentence({ noHold: true })) + '</p>' +
        '<p>' + plansCaption(p, !planJob) + '</p>' +
        '<table><caption>Six plans, one network run six times.</caption>' +
        '<tr><th scope="col">Plan</th><th scope="col">Keep health out of ' + HP_KEEP +
        '</th><th scope="col">What it built</th>' +
        '<th scope="col">Told apart from the others</th></tr>';
    for (i = 0; i < 6; i++) {
      /* s7.23 ruling 3 put the narrow-tile sentence behind a TAP on a canvas,
         which no keyboard and no screen reader can make. The same sentence,
         in its LONG form, is a column here, so the text equivalent carries
         everything the picture does at every width. */
      var sr = planFormsFor(p, i);
      h += '<tr><th scope="row">' + p.shorts[i] + '</th><td>' +
           (p.cells[i] ? Math.round(p.cells[i].score) : 'not played yet') + '</td><td>' +
           ((p.cells[i] && sr && sr[0]) ? capFirst(sr[0]) + '.' : 'not played yet') +
           '</td><td>' +
           (!p.dist ? 'not measured in this build'
                    : (p.dist[i] ? 'yes' : capFirst(convergeTag(i, p.near, p.shorts, p.dist)))) +
           '</td></tr>';
    }
    el.innerHTML = h + '</table>';
  }

  /* --- act 4: reading the plan --------------------------------------------
     One pairing played large with the reader's own guess beside it. The bars
     ARE the discriminator head's raw softmax: nothing rescales them, the
     announced number and the leading plan come from the raw vector, and only
     the drawn HEIGHT is eased so the bars do not strobe. */

  var BAR_EASE = 0.18;

  /* The 36-number board summary the trunk reads comes from core and from
     nowhere else (build spec v3 s7.10 ruling 4, SEAM C4-S2). The page used to
     carry a hand packed copy for the days before core had an encoder; it
     normalised two features differently and left five at zero, so a head fed
     those numbers would answer confidently about a board it had never been
     shown. It is DELETED: there is one arithmetic on this page, it is
     KeepCore's, and when core has no encoder the bars are withheld and the
     act says so rather than drawing a guess. */
  function summaryOK() {
    return (Core && Core.discriminateBoard) ? 'core' : '';
  }

  /* the reader's own output, never anything drawn on top of it afterwards */
  function readerProbs(sess, netKey, seat) {
    if (!sess || !summaryOK()) return null;
    var net = netOf(netKey);
    if (!net || !net.Ws || !net.Wd) return null;
    /* ONE call: core packs the summary, runs the trunk over it and returns the
       discriminator head's raw softmax. The page does not see the 36 numbers
       and cannot round, rescale or reorder them on the way past. `sess.bld` is
       only how a caller that already has a builder names the board without a
       lookup; the arithmetic does not read it. */
    try {
      return Core.discriminateBoard(net, sess.g, sess.bld || null, seat, sess.wave);
    } catch (e) { return null; }
  }

  function newBars(netKey, seat, header, past) {
    return { key: netKey, seat: seat, header: header, past: past || header, raw: null,
             eased: new Float64Array(6), lead: -1, holds: 0, flip: -1, flipPlan: -1,
             changed: false, shorts: planNames() };
  }

  /* ---- the heading is in the tense the numbers are (s7.24 ruling 7) --------
     While a wave runs nothing is being built and the bars do not move: the
     panel critic measured identical eased values across 131 frames under
     "What the reader thinks you are building". The numbers were honest and the
     tense was not, so the heading dates them to the build phase they were
     taken in and goes back to the present the moment building resumes. */
  var barsNoRoom = false;
  function barsHeader(b) {
    if (!b) return '';
    var over = !!S && (S.phase === 'resolve' || S.over || S.phase === 'over');
    return (over && b.past) ? b.past : b.header;
  }

  function pumpBars(sess) {
    var b = FX.bars;
    if (!b || !sess) return;
    var p = readerProbs(sess, b.key, b.seat);
    if (!p) return;
    b.raw = p;
    var i, lead = 0;
    for (i = 1; i < p.length; i++) if (p[i] > p[lead]) lead = i;
    if (lead === b.lead) b.holds++;
    else { b.lead = lead; b.holds = 1; }
    /* a flip counts once it HOLDS for two build ticks, so a single noisy
       placement is not reported as the reader changing its mind */
    if (b.holds === 2 && b.first !== undefined && lead !== b.first && b.flip < 0) {
      b.flip = b.lastCell === undefined ? -1 : b.lastCell;
      b.flipPlan = lead;
      b.changed = true;
    }
    if (b.first === undefined && b.holds >= 1) { b.first = lead; b.ref = lead; }
    /* s7.32 ruling 1: the line announces EVERY lead change that holds two
       build ticks (it used to say the first one and then stand while the lead
       moved on, so it named bars that read 0), at most one a BARS_SAY_MS */
    if (b.holds === 2 && b.ref !== undefined && lead !== b.ref) { b.ref = lead; barsSay(b); }
    barsSayCheck(b);
    writeSrBars();
  }

  /* One announcement per BARS_SAY_MS. A held change that lands inside the
     window waits for it and is said then only if it still leads; a line that
     stands while the bar it names has fallen to 0 percent is taken back to the
     act's own building line, so the status never names a bar that reads 0. */
  var BARS_SAY_MS = 3000;
  function barsLine(b, k) {
    return 'The reader now thinks its partner is building ' + b.shorts[k] + '.';
  }
  function barsSay(b) {
    var t = now(), wait = (b.saidAt === undefined) ? 0 : (b.saidAt + BARS_SAY_MS - t);
    if (wait > 0) {
      b.sayNext = b.ref;
      if (!b.sayTimer) {
        b.sayTimer = setTimeout(function () {
          b.sayTimer = 0;
          if (FX.bars !== b || b.sayNext === undefined) return;
          var k = b.sayNext; b.sayNext = undefined;
          if (k === b.lead && b.raw && Math.round(b.raw[k] * 100) > 0) barsSay(b);
        }, wait + 12);
      }
      return;
    }
    b.sayNext = undefined;
    b.saidAt = t; b.said = b.ref;
    setStatus(barsLine(b, b.ref));
  }
  function barsSayCheck(b) {
    if (b.said === undefined || !b.raw || Math.round(b.raw[b.said] * 100) > 0) return;
    var line = barsLine(b, b.said);
    b.said = undefined;
    if (statusNow().indexOf(line) >= 0 && phaseLine()) setStatus(phaseLine());
  }

  function easeBars() {
    var b = FX.bars, i;
    if (!b || !b.raw) return;
    for (i = 0; i < 6; i++) b.eased[i] += (b.raw[i] - b.eased[i]) * BAR_EASE;
  }

  function writeSrBars() {
    var el = byId('kit-sr-bars'), b = FX.bars, i, h;
    if (!el) return;
    if (!b || !b.raw) { el.innerHTML = ''; return; }
    h = '<p>' + barsHeader(b) + '</p><ul>';
    for (i = 0; i < 6; i++) {
      h += '<li>' + b.shorts[i] + ', ' + Math.round(b.raw[i] * 100) + ' percent.</li>';
    }
    h += '</ul>';
    if (act.name === 'reader' && readSame) h += '<p>' + readSame + '</p>';   /* s7.32 r2 */
    el.innerHTML = h;
  }

  /* The plate the bars stand on, in css pixels. It is WIDER than the bar
     column whenever the header is: the header is 244 css px at 12 px and the
     column can be 140, and a heading hanging off the end of its own plate onto
     board texture is the thing ruling 4a forbids on a phone. */
  /* ---- the bar block's own columns (build spec v3 s7.15 ruling 3) ---------
     All three visitor lanes and the panel reported the same defect on the
     page's flagship readout: the row labels were drawn at the plate's left
     edge and the track started 74 px in, so "West mouth guns 91%" printed
     itself across its own dark fill and was unreadable in both themes. The
     fix is columns, not colours: the label owns a FIXED LEFT COLUMN wide
     enough for the longest of the six names, the track owns the middle, and
     the percentage is right aligned in a column of its own OUTSIDE the fill.
     The plate is then sized from those three widths, so it can never be too
     narrow for what it has to carry. */
  var BAR_TRACK_MIN = 62, BAR_GAP = 8;

  function barCols(shorts) {
    var lw = 0, pw = 0, i;
    ctx.save();
    ctx.font = '400 11px "Source Sans 3", system-ui, sans-serif';
    for (i = 0; i < 6; i++) {
      try { lw = Math.max(lw, ctx.measureText(String(shorts[i] || '')).width); } catch (e) {}
    }
    try { pw = ctx.measureText('100%').width; } catch (e) { pw = 26; }
    ctx.restore();
    return { label: Math.ceil(lw) + 2, pct: Math.ceil(pw) + 2 };
  }

  function barsPlate(header, shorts) {
    /* s7.17 ruling 2: on a phone showing the whole board the bar block gets
       its own band in the room UNDER the board, never a plate on top of it */
    if (slotNow && slotNow.bars) {
      return { x: Math.round(slotNow.bars.x), y: Math.round(slotNow.bars.y),
               w: Math.round(slotNow.bars.w), h: Math.round(slotNow.bars.h) };
    }
    var strip = stripW();
    var c = barCols(shorts || planNames());
    var need = 0;
    ctx.save();
    ctx.font = '600 12px "Source Sans 3", system-ui, sans-serif';
    try { need = ctx.measureText(header || '').width; } catch (e) { need = 0; }
    ctx.restore();
    var want = c.label + BAR_GAP + BAR_TRACK_MIN + BAR_GAP + c.pct;
    var pw = Math.min(Math.max(want + 16, Math.ceil(need) + 16), Math.max(60, strip - 8));
    var ph = barsPlateH(), py;
    if (barsBand.on) {
      ph = Math.min(ph, Math.max(BARS_MIN_H, barsBand.h - BARS_PAD));
      py = barsBand.top + 8;
    } else {
      py = (view.topPad || 0) + 6;
    }
    var px = barsBand.on ? 10 : Math.round(Math.max(8, (view.ox || 10) - pw - 14));
    if (px + pw > strip - 4) px = Math.max(4, Math.round(strip - 4 - pw));
    /* whole css pixels: a plate on a fractional origin antialiases its own
       edge, and a soft edge is both a weaker plate and a row of paint outside
       the rect the page reports it drew */
    return { x: Math.round(px), y: Math.round(py),
             w: Math.round(pw), h: Math.round(ph) };
  }

  /* a label that will not fit its column is shortened with an ellipsis rather
     than allowed to run over the track */
  function fitLabel(s, w) {
    var t = String(s);
    if (ctx.measureText(t).width <= w) return t;
    while (t.length > 1 && ctx.measureText(t + '…').width > w) t = t.slice(0, -1);
    return t + '…';
  }

  function drawBars() {
    var b = FX.bars;
    barsDrawn = null;
    if (!b || !b.raw || !R || !R.bars || !view || barsHidden) return;
    /* s7.17 ruling 2. On a phone showing the whole board the bars belong in
       the room under it or nowhere: a plate over a 370 x 178 board leaves a
       sliver of the picture the bars are explaining, which is what the dpr 2
       capture found. Their words are in the panel prose and in the card. */
    /* s7.21 ruling 6 widens this from phoneWhole() to EVERY camera state: on a
       phone the bars stand below the board or they do not stand. Their words
       are in the panel prose and in the caption card either way. */
    if (phone() && !(slotNow && slotNow.bars)) return;
    var head = barsHeader(b);
    var p = barsPlate(head, b.shorts);
    /* s7.24 ruling 7: THE PLATE NEVER STANDS ON THE BOARD. Its band is held
       open through the framed wave now, so this is the guarantee rather than
       the arrangement: in a window too short to reserve a band the act says so
       through barsRoomLine instead of painting its own argument over the keep
       the visitor is watching. */
    if (rectOverlap(p, drawnBoardRect()) > 0 ||
        (keepNumBox && rectOverlap(p, keepNumBox) > 0)) {
      barsNoRoom = true;
      return;
    }
    barsNoRoom = false;
    var x = p.x + 8, y = p.y + 24, w = p.w - 16, h = p.h - 34;
    var c = barCols(b.shorts);
    /* the track never goes below its floor: the label column yields first */
    var lw = Math.min(c.label, Math.max(24, w - BAR_GAP * 2 - BAR_TRACK_MIN - c.pct));
    var tw = Math.max(10, w - lw - BAR_GAP * 2 - c.pct);
    var tx = x + lw + BAR_GAP;
    var px = x + w;                       /* the percentage column's RIGHT edge */
    barsDrawn = { x: p.x, y: p.y, w: p.w, h: p.h, band: barsBand.on,
                  label: { x: x, w: lw }, track: { x: tx, w: tw },
                  pct: { x: px - c.pct, w: c.pct } };
    ctx.save();
    ctx.font = '600 12px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    /* in its own band there is nothing under the plate, so it can stay light;
       standing on the board it is near opaque, because ruling 4a asks for a
       plate under the text and a plate you can read the board through is only
       half of one */
    ctx.fillStyle = plateCol(barsBand.on ? 0.82 : 0.96);
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.fillStyle = ink(0.92);
    ctx.fillText(fitLabel(head, w), x, y - 8);
    try {
      R.bars(ctx, { x: tx, y: y, w: tw, h: h }, b.eased, { pick: b.lead });
    } catch (e) {}
    ctx.font = '400 11px "Source Sans 3", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    var gap = Math.max(2, Math.round(h * 0.05));
    var bh = Math.max(3, Math.floor((h - gap * 5) / 6)), i, my;
    for (i = 0; i < 6; i++) {
      my = y + i * (bh + gap) + bh / 2;
      ctx.fillStyle = ink(i === b.lead ? 0.95 : 0.7);
      ctx.textAlign = 'left';
      ctx.fillText(fitLabel(b.shorts[i], lw), x, my);
      ctx.textAlign = 'right';
      ctx.fillText(Math.round(b.raw[i] * 100) + '%', px, my);
    }
    ctx.restore();
  }

  /* ---- s7.32 ruling 2: THE PICKER'S SAME-GAME DISCLOSURE ------------------
     Against this reader the shipped specializer often builds the same first
     wave for two intents, so picking the other one replays the same game and
     the picker looks dead. When the board at the end of build 1 is identical
     to the one the previous pick built (same partner, same seed), one sentence
     beside the picker says so. It is COMPUTED from the two boards, never
     typed: each board is core's own build phase on this seed, the same steps
     the live act takes one placement at a time. The export's distinct flags
     and the style names stay what the trainer measured over its own games, so
     this sentence (this game) and a tag (the style) may disagree honestly. */
  var readSame = '', readPrev = null, readSigs = {};
  function build1Sig(key, n) {
    var k = key + '|' + n + '|' + act.seed;
    if (cacheHas(readSigs, k)) return readSigs[k];
    var s2 = newSession(act.seed, [agentOf(key, n), agentFor(netKeys('ac', 1)[0])]);
    var sig = null, m, cells, i, rec;
    if (s2 && runBuild(s2) && (m = structMap(s2)) && m.get) {
      cells = structCells(s2).slice().sort(function (a, b) { return a - b; });
      sig = '';
      for (i = 0; i < cells.length; i++) {
        rec = m.get(cells[i]);
        sig += cells[i] + ':' + (rec ? rec.kind + '.' + rec.owner : '-') + ',';
      }
    }
    /* and the whole replayed game, so "the game is the same" is only ever
       printed when it is: the partner's intent also feeds its later builds,
       and where only the first wave matches the sentence says that instead */
    if (sig !== null && Core && Core.playEpisode) {
      var res = null, gm, gc;
      try {
        res = Core.playEpisode({ seed: act.seed >>> 0, cfg: coreCfg(),
                                 a: agentOf(key, n), b: agentFor(netKeys('ac', 1)[0]) });
      } catch (e) { res = null; }
      gm = (res && res.g) ? res.g.struct : null;
      if (!gm || !gm.get) sig = { b1: sig, all: null };
      else {
        gc = []; gm.forEach(function (v, c2) { gc.push(c2 + ':' + v.kind + '.' + v.owner + '.' + v.hp); });
        sig = { b1: sig, all: gc.sort().join(',') + '|' + Math.round(res.score) };
      }
    } else if (sig !== null) sig = { b1: sig, all: null };
    readSigs[k] = sig;
    return sig;
  }
  function readSameLine(d, n) {
    var prev = readPrev, out = '';
    readPrev = { key: d.key, n: n, seed: act.seed };
    if (!prev || prev.key !== d.key || prev.seed !== act.seed || prev.n === n) return '';
    var a = build1Sig(d.key, n), b = build1Sig(d.key, prev.n);
    var pk = d.pick.toLowerCase();
    if (a && b && a.b1 !== null && a.b1 === b.b1) {
      /* the same first wave; the whole game only when the replay says so,
         because the intent also feeds the partner's later builds */
      out = (a.all !== null && a.all === b.all)
        ? ('With this reader, ' + pk + ' ' + numWord(n + 1) + ' builds the same pieces as ' +
           pk + ' ' + numWord(prev.n + 1) + ', so the game is the same.')
        : ('With this reader, ' + pk + ' ' + numWord(n + 1) + ' builds the same first wave as ' +
           pk + ' ' + numWord(prev.n + 1) + ', so the game opens the same.');
    }
    return out;
  }

  function startReader(opts) {
    /* Build spec v3 s7.15 ruling 3: the seat the reader is READING comes from
       the picker, so changing it restarts the game and the board, the bars and
       the score all move. It used to be hard wired to a specializer intent
       chosen by the seed, and the control below it did nothing at all here. */
    var d = partnerDef(pickerKey());
    var partner = readAgent();
    readSame = readSameLine(d, pickerN());
    S = newSession(act.seed, [partner, agentFor(netKeys('ac', 1)[0])]);
    FX.caption = "One pairing, played large. The bars are the reader's own guess.";
    /* s7.32 ruling 1 (form b, decided by i1w's measurement): the seat argument
       is the seat WHOSE STRUCTURES ARE READ (core's discriminateBoard, the
       trainer's board_summary, the worker's readSeat). It was 1, the reader's
       own pieces, so the bars led "West mouth guns" in 153 of 156 games
       whoever the partner was. The partner sits in seat 0 here. */
    FX.bars = newBars(netKeys('ac', 1)[0], 0,
                      'What the reader thinks its partner is building',
                      'What the reader thought its partner was building');
    if (FX.bars && d.key === 'div') FX.bars.shorts = PLAN_FALLBACK.slice();   /* s7.32 r4 */
    syncPartnerUI();
    var prose = [
      { text: "One pairing, played large. The bars are the reader's own output, " +
              "not something drawn on top afterwards." },
      { note: 1, text: 'It never sees which plan its partner was given. It only sees ' +
              'what gets built.' },
      { note: 1, text: 'The partner it is reading here is the ' +
              partnerLabel(d, -1) + ', ' + d.pick.toLowerCase() + ' ' + (pickerN() + 1) +
              '. Change it and the game is replayed with that one instead.' }
    ];
    /* what the export measured this reader to be worth, in one sentence, with
       the branch chosen by the measurement (build spec v3 s7.11 ruling 1c) */
    if (readerSentence(false)) prose.push({ text: readerSentence(false) });
    /* Two different sentences, and neither of them is about the summary being
       approximated, because it is not: the numbers are core's own encoder,
       one code path, and the page has no second arithmetic to disclose. What
       is still worth saying is whose WEIGHTS are reading them. */
    if (!summaryOK()) {
      prose.push({ note: 1, text: 'The guess is not shown here: this build has no ' +
        'board summary for the reader to read, so there is nothing honest to draw.' });
      FX.bars = null;
    } else if (VERIFY.kind === 'placeholder' || VERIFY.kind === 'mock') {
      prose.push({ note: 1, text: 'This build ships an untrained placeholder, so the ' +
        'guess below is a real forward pass over the real board summary, through a ' +
        'head whose weights are random draws. It shows the mechanism and it means ' +
        'nothing about plans.' });
    }
    setProse(prose);
    if (!S) { setStatus(honestMissing()); return; }
    /* The build is STEPPED here, one placement per tick, and the reader is
       asked after each one. That is what makes the flip tick a measurement
       rather than a decoration: the board it read really did grow by one
       piece between two answers. */
    if (!openBuild(S)) { S.reveal = runBuild(S); revealAll(S); }
    if (reducedMotion() && !(opts && opts.step)) {
      stepBuild(S, { all: true });
      revealNew(S);
      pumpBars(S);
      resolveInstantly();
      return;
    }
    if (opts && opts.step) { playing = false; lastTick = 0; return; }
    playing = true; lastTick = 0;
    setStatus('Building. The bars settle as the first walls go up.', { force: true });
  }

  /* D4 9.2. Neither sentence claims anything the model did not output: the
     flip is only reported when the leading bar really changed and held. */
  function readerReport() {
    var b = FX.bars;
    if (!b || !b.raw) return;
    var prose = [
      { text: "One pairing, played large. The bars are the reader's own output, " +
              "not something drawn on top afterwards." },
      { note: 1, text: 'It never sees which plan its partner was given. It only sees ' +
              'what gets built.' }
    ];
    if (readerSentence(false)) prose.push({ text: readerSentence(false) });
    if (b.changed && b.flip >= 0) {
      prose.push({ text: 'The tick marks the placement that moved the reader guess to ' +
        'a different plan. Everything it built before that tick was built for the plan ' +
        'it had guessed first.' });
    } else {
      prose.push({ text: 'The reader had it from the first placement this time, and ' +
        'never changed its guess.' });
    }
    setProse(prose);
  }

  /* the one glyph the reader act draws on the board: a small tick on the tile
     whose placement moved the leading bar */
  function drawFlipTick() {
    var b = FX.bars;
    if (!b || b.flip < 0 || !RAPI || !RAPI.cellRect || !view || view.fallback) return;
    /* s7.19 ruling 2: the tag clears WITH THE RESULT. It described a moment in
       the build, and a judge watched it stand over the board past the end of
       the game beside a result banner it had nothing to do with. */
    if (S && (S.over || S.phase === 'over')) return;
    var r = null;
    try { r = RAPI.cellRect(view, b.flip); } catch (e) { r = null; }
    if (!r || !isFinite(r.x)) return;
    var cxp = r.x + r.w / 2, cyp = r.y + r.h / 2;
    ctx.save();
    ctx.strokeStyle = accent();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cxp - 6, cyp);
    ctx.lineTo(cxp - 1, cyp + 5);
    ctx.lineTo(cxp + 7, cyp - 6);
    ctx.stroke();
    ctx.font = '600 11px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = plateCol(0.8);
    var w = ctx.measureText('changed its mind').width + 10;
    ctx.fillRect(cxp - w / 2, cyp + 8, w, 15);
    ctx.fillStyle = ink(0.9);
    ctx.fillText('changed its mind', cxp, cyp + 10);
    ctx.restore();
  }

  /* --- act 6: fine print ---------------------------------------------------
     Real DOM text in its own scrolling card. Nothing about this act is drawn
     on the canvas except the one caption. */

  function fineEl() { return byId('kit-fine'); }

  /* m22: both cards move focus to their own close button when they open, and
     hiding a card that holds focus drops it to the page body. Each card
     remembers the control that opened it and hands focus back on close, but
     only when focus was still inside the card (a click on another act keeps
     the focus that click gave). */
  var fineOpener = null, helpOpener = null;
  function openerOf(card) {
    var a = document.activeElement;
    return (a && a !== document.body && !(card && card.contains(a))) ? a : null;
  }
  function giveBackFocus(op) {
    if (!op || !op.isConnected || !op.getClientRects().length) return;
    try { op.focus({ preventScroll: true }); } catch (e) {}
  }

  function startFine() {
    closeHelp();
    var el = fineEl();
    fineOpener = openerOf(el);
    FX.caption = 'What is measured here, what comes from the paper, and what is mine.';
    setProse([{ text: 'The fine print is open. Escape closes it.' }]);
    fillFineNumbers();
    if (!el) { setStatus('The fine print did not load.'); return; }
    el.hidden = false;
    el.scrollTop = 0;
    /* the walkthrough card hides while a modal is open (ruling 1) */
    placeCoach();
    syncModalChrome();          /* s7.26 ruling 9 */
    var close = byId('kit-fine-close');
    if (close) { try { close.focus({ preventScroll: true }); } catch (e) {} }
    /* s7.24 ruling 4: the line CUTS AT A SENTENCE. The panel's status slot is
       a fixed two lines and clamps what does not fit, so the old sentence
       ended in a literal ellipsis ("...and the...") in the one act whose job
       is to be trusted. The shorter sentence is whole in the slot. */
    setStatus('Fine print. How honest is this, and the numbers from the paper.',
              { force: true });
  }

  function closeFine() {
    var el = fineEl();
    if (el && !el.hidden) {
      var held = el.contains(document.activeElement);
      el.hidden = true; placeCoach(); syncModalChrome();
      if (held) giveBackFocus(fineOpener);
      fineOpener = null;
    }
  }

  /* s7.21 ruling 10: the fine print is a card you open FROM an act, so closing
     it returns to that act. It used to drop every visitor into Watch a wave,
     which is where the critic lost a build. */
  function leaveFine() {
    setAct(ACTS.indexOf(prevAct) >= 0 && prevAct !== 'fine' ? prevAct : 'watch');
  }

  /* The fine print's build-time numbers. Every one of them is read from the
     model file under the export's OWN key names (build spec v3 section 7.11
     ruling 1d, SEAM V1g-S1): there is no s1 block, no params and no modelKb in
     the shipped format, meta.g1 names its count `engineers`, and the one thing
     this function may never do is print the no-measurement wording on a file
     that carries the measurement. The size sentence counts the numbers this
     browser actually loaded, which is a measurement the page makes itself. */
  function fillFineNumbers() {
    var sz = byId('kit-fine-size'), gp = byId('kit-fine-gap'), mx = byId('kit-fine-matrix');
    var st = byId('kit-fine-styles'), wm = byId('kit-fine-warm'), s;
    var fl = byId('kit-fine-floor');
    if (sz) sz.textContent = sizeSentence();
    if (mx) mx.textContent = matrixSentence();
    if (gp) gp.textContent = readerSentence(true);
    if (st) st.textContent = stylesFine();
    if (fl) {
      s = floorFine();
      fl.textContent = s;
      fl.hidden = !s;
    }
    if (wm) {
      s = warmSentence();
      wm.textContent = s;
      wm.hidden = !s;
    }
  }

  /* The weights in the file this browser loaded, counted rather than quoted.
     It reads the RAW file and not core's loaded handle on purpose: core
     memoizes scratch arrays onto a net the first time it plays (__pre,
     __preBoard), so the loaded handle grows by about a quarter after one game
     and a sentence counted from it would drift while the visitor read it. A
     tensor in the file is either a plain array of numbers or a quantized block
     with its own shape, and both forms say how many numbers they are. */
  function tensorLen(t) {
    var i, n;
    if (!t) return 0;
    if (Object.prototype.toString.call(t) === '[object Array]') return t.length;
    if (t.shape && t.shape.length) {
      n = 1;
      for (i = 0; i < t.shape.length; i++) n *= (t.shape[i] | 0);
      return n;
    }
    return (typeof t.length === 'number') ? t.length : 0;
  }
  function modelCount() {
    var nets = (MODEL && MODEL.nets) || null, k, n, t, s;
    var cnt = 0, tot = 0, lo = Infinity, hi = 0;
    if (!nets) return null;
    for (k in nets) {
      if (!Object.prototype.hasOwnProperty.call(nets, k)) continue;
      n = nets[k]; s = 0;
      for (t in n) {
        if (!Object.prototype.hasOwnProperty.call(n, t)) continue;
        if (t.charAt(0) === '_') continue;
        s += tensorLen(n[t]);
      }
      if (!s) continue;
      cnt++; tot += s;
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    return cnt ? { nets: cnt, total: tot, lo: lo, hi: hi } : null;
  }

  var TAIL_SIZE = 'Nothing is sent anywhere. Every game you see is played in your ' +
                  'browser while you watch, which is also why your numbers will not ' +
                  'match the ones I saw.';

  function sizeSentence() {
    var c = modelCount();
    if (!c) {
      return 'The engineers are small networks, trained on my machine and shipped ' +
             'here as one file. ' + TAIL_SIZE;
    }
    return 'The engineers are small networks. This page loaded ' + fmtInt(c.nets) +
      ' of them out of one file, ' + fmtInt(c.total) + ' numbers in all, between ' +
      fmtInt(c.lo) + ' and ' + fmtInt(c.hi) + ' each, and they were trained on my ' +
      'machine. ' + TAIL_SIZE;
  }

  var HEAD_MATRIX = 'The grid of strangers is one game per square, which is enough ' +
                    'to see the shape and not enough to be a measurement.';

  /* the measured cross-play claim (spec v3 s7.7 ruling 4c, s7.9 ruling 4). The
     export writes the sentence it measured; the page quotes it and adds the
     cast's own numbers, and says plainly when there is nothing to quote. */
  function matrixSentence() {
    var cap = metaOf('gridCaption'), tags = metaOf('cast', 'tags');
    var drop = metaNum('cast', 'medianCrossedDrop'), out = HEAD_MATRIX;
    if (typeof cap === 'string' && cap) {
      out += ' The measured version is in the model file. ' + cap;
    }
    if (drop !== null) {
      out += ' Across the cast of ' + fmtInt(tags && tags.length ? tags.length : 8) +
             ', the median crossed pairing held ' + fmt1(drop) + ' points of keep ' +
             'health less than the weaker of the two engineers does with its own kind.';
    }
    if (typeof cap !== 'string' && drop === null) {
      out += ' The measured version is a matrix of twelve games for every pairing, ' +
             'written into the model file when the cast is exported, and this build ' +
             'carries no such matrix.';
    }
    /* Build spec v3 s7.19 ruling 7. The ship gate saw rows S7 and S8 read
       identical (0, 52, 92, 12, 0, 100, 100, 52) and asked whether two of the
       cast are twins or the pool indices repeat. Neither: the export names a
       different training run for every one of them, their layouts differ in
       every pairing, and the coincidence is the OUTCOME alphabet, because one
       square is one game and a game ends on a small set of numbers. The page
       says so where a reader who noticed it would look. */
    if (tags && tags.length) {
      var uniq = {}, i, n = 0;
      for (i = 0; i < tags.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(uniq, tags[i])) { uniq[tags[i]] = 1; n++; }
      }
      if (n === tags.length) {
        out += ' All ' + fmtInt(n) + ' are different training runs, so two rows that ' +
               'read the same are two engineers that happened to end on the same ' +
               'numbers, not the same engineer twice.';
      }
    }
    return out;
  }

  /* one of the two G0 bars, or null when the file does not carry it */
  function g0Bar(key) {
    var o = metaOf('g0', key);
    if (!o || typeof o !== 'object') return null;
    var v = num2(o, 'value');
    if (v === null) return null;
    /* the percentage comes out of the KEY, so the words and the number cannot
       disagree with each other: bar090 is 90 percent by construction. The
       DIGITS ARE ALREADY THE PERCENTAGE, so nothing is divided here: a /10
       printed both bars as "9 percent" and erased the very distinction the
       paragraph exists to make (v1k major 1, build spec v3 s7.16 ruling 1). */
    var pct = parseInt(String(key).replace(/[^0-9]/g, ''), 10);
    pct = isFinite(pct) ? pct : null;
    return { pct: pct, value: v, measured: num2(o, 'measured'), met: o.met === true };
  }

  /* Build spec v3 s7.15 ruling 8. The shipped specializer is the rung a MOVED
     bar selected, and the ship-gate verifier's first major was that the page
     printed neither bar: a visitor was told four of six styles came out
     distinct and nothing at all about the keep those four hold or the bar that
     was lowered to admit them. Both bars, their numbers and the worst style's
     share are in meta precisely so this paragraph can print them. */
  function barsFine() {
    var b9 = g0Bar('bar090'), b8 = g0Bar('bar085');
    var share = metaNum('g0', 'worstStyleShareOfC');
    var worst = (b9 && b9.measured !== null) ? b9.measured
              : ((b8 && b8.measured !== null) ? b8.measured
                                              : metaNum('g0', 'worstIntentKeepHp'));
    var out = '';
    if (b9) {
      out += 'The stricter bar, ' + (b9.pct === null ? 'the first one' : (b9.pct + ' percent')) +
             ' of the matched median (' + fmt1(b9.value) + ' keep health), was ' +
             (b9.met ? 'met' : 'not met') +
             ((worst !== null) ? (': the weakest style holds ' + fmt1(worst) + '.') : '.');
    }
    if (b8) {
      out += (out ? ' ' : '') + 'The re-ruled bar, ' +
             (b8.pct === null ? 'the second one' : (b8.pct + ' percent')) +
             ' of the ceiling (' + fmt1(b8.value) + '), was ' + (b8.met ? 'met' : 'not met') + '.';
    }
    if (share !== null) {
      out += (out ? ' ' : '') + 'That weakest style holds ' + Math.round(share * 100) +
             ' percent of what the same training reached with no pressure to build ' +
             'differently at all.';
    }
    return out;
  }

  /* how many of the six the gate could tell apart, and where the names came
     from, in the fine print's own voice */
  function stylesFine() {
    var d = distinctStyles(), out, bars;
    if (d === null) {
      out = 'How many of the six plans can be told apart is not measured in this build.';
    } else {
      out = 'In the test that scored them, ' +
            (d === 6 ? 'all six' : (numWord(d) + ' of the six')) +
            ' came out far enough apart to count as separate plans' +
            (d < 6 ? ('; the other ' + numWord(6 - d) + ' converge on a plan already ' +
                      'in the set.') : '.');
    }
    bars = barsFine();
    if (bars) out += ' ' + bars;
    if (haveNames()) {
      out += ' The names are read off where each style spends its credits, by the ' +
             'same code that measured them, so a name cannot claim a behaviour the ' +
             'numbers do not show.';
    }
    return out;
  }

  /* the sloppy-partner result, named in the export as a fact about this map
     and printed here as one (build spec v3 s7.15 ruling 8) */
  function floorFine() {
    var s = metaOf('g1', 'floorFinding');
    if (metaOf('g1', 'isFloorFinding') !== true) return '';
    if (typeof s !== 'string' || !s) return '';
    return plainMeta(s);
  }

  /* ---- no field name reaches a visitor (build spec v3 s7.24 ruling 10) -----
     The trained export's own floor-finding sentence ends "The gate is
     meta.zsc.", and the light lane read that dangling identifier in the one
     section whose whole job is to make the numbers trustworthy. The export is
     not this zone's to edit and its CLAIM is right, so the page renames the
     field to the thing it measures on the way to the screen: one substitution,
     no number and no claim touched. Any other meta path that reaches prose is
     caught by the second rule and named by its section rather than its key. */
  var META_WORDS = { 'meta.zsc': 'the stranger score',
                     'meta.g0': 'the styles gate', 'meta.g1': 'the reader gate' };
  function plainMeta(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/\bmeta\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*/g, function (m) {
        var k = m, cut;
        while (k && !META_WORDS[k]) {
          cut = k.lastIndexOf('.');
          if (cut <= 4) break;
          k = k.slice(0, cut);
        }
        return META_WORDS[k] || 'the measurement behind this page';
      });
  }

  /* the warm start, in the export's own words (spec v3 s7.9 ruling 4) */
  function warmSentence() {
    var w = metaOf('warmStart');
    if (typeof w !== 'string' || !w) return '';
    return 'The reader did not start from nothing: ' + w + '.';
  }

  /* --- act 5: your turn --------------------------------------------------- */

  var myMoves = [], selPiece = PIECE_WALL, cursorCell = -1;

  /* ---- the Your turn session survives a trip to another act (s7.21 r10) ----
     The whole session is `act.seed` plus the partner plus `myMoves`, so the
     stash is those three and nothing else: rebuildYou replays the moves through
     the same stepping driver a shared link uses, which is why this cannot
     drift from a fresh game. A game that has ENDED is not resumed (its result
     is the thing the visitor was left with); a build phase always is. */
  var youStash = null, prevAct = 'watch';

  function stashYou() {
    if (act.name !== 'you') return;
    if (!S || S.over || S.phase === 'over' || !myMoves.length) { youStash = null; return; }
    youStash = { seed: act.seed, partner: act.partner, partnerN: act.partnerN,
                 moves: myMoves.slice(), piece: selPiece };
  }

  function takeYouStash() {
    var s = youStash;
    youStash = null;
    if (!s || s.seed !== act.seed || s.partner !== act.partner ||
        s.partnerN !== act.partnerN) return null;
    return s;
  }

  /* whether the "which colour is whose" sentence has been said this visit */
  var coSaid = false;

  function startYourTurn() {
    var keep = takeYouStash();
    myMoves = keep ? keep.moves.slice() : [];
    selPiece = keep ? keep.piece : PIECE_WALL;
    FX.seat = 'a';
    /* s7.21 ruling 8: the sentence the visitor carried out of the walkthrough
       invited them to build on any tile at all, and most tiles answer no. The
       lit band IS the answer, so the caption names it. (s7.22 ruling 1 moved
       the live line into phaseLine, which is the surface this act really
       paints; this one stands for the phase where no line is due.) */
    FX.caption = 'Your turn. Build inside the lit area, and see which partner builds around you.';
    setProse([
      { text: tapWord() + ' a tile inside the lit area to place a wall, and use the Catapult button for ' +
              'a catapult. Your pieces are blue and your partner puts up gold ones. ' +
              'You each spend your own budget and build at the same time, so watch ' +
              'for pieces you did not place.' },
      { text: 'Changing partner keeps the same waves, the same budget and the same ' +
              'starting board, so the only thing that changed is the partner.' },
      /* s7.26 ruling 3 (the round-5 verifier's M2): through partnerLabel, which
         is the page's one writer for a label that carries an index. This call
         site used the RAW label, so every visitor who reached Your turn with
         the default partner read "Self-play engineer, run N." in the panel. */
      { note: 1, text: partnerLabel(partnerDef(act.partner), act.partnerN) + '. ' +
                       partnerDef(act.partner).note }
    ]);
    rebuildYou();
    syncPieceButtons();
    syncPartnerUI();
    /* same task as the prose write, then once more after layout (s7.22 r2) */
    revealPartnerCard();
    setTimeout(revealPartnerCard, 0);
    if (!S) { setStatus(honestMissing()); return; }
    if (cursorCell < 0) cursorCell = cellOf((COLS / 2) | 0, (ROWS / 2) | 0);
    /* s7.24 ruling 10: the phone's budget readout is on screen from the act's
       FIRST frame. setAct syncs the budget before this act has a session, so a
       landing game that had already ended left the strip's readout cleared and
       the light lane saw no budget at all until its first placement. A forced
       sync here is the act's own first state. */
    syncBudget(true);
    /* the button row the readout rides in is built per width, so the strip is
       re-measured with it: the row appears in this act and nowhere else */
    syncControlVisibility();
    setStatus(keep
      ? ('Your build is where you left it, ' + keep.moves.length +
         (keep.moves.length === 1 ? ' piece' : ' pieces') +
         ' in. Budget ' + budgetLeft() + '.')
      : ('Building. ' + tapWord() + ' a tile inside the lit area to place a wall. Budget ' +
         budgetLeft() + '.'),
              { force: true });
    /* ruling 8: one machine is ringed once, on the first build phase */
    armHintRing();
  }

  /* A fresh game with the visitor in seat A, then every move so far replayed
     through the same stepping driver. Undo and a shared link both come back
     through here, so there is one path and it is deterministic. */
  function rebuildYou() {
    var hq = [];
    S = newSession(act.seed, [{ kind: 'human', queue: hq }, partnerAgent()]);
    if (!S) return;
    S.hq = hq;
    FX.shots.length = 0;
    /* the bars belong to the accommodator and are shown only when it is the
       partner: a self-play engineer has no guess to show and the page must not
       draw one for it */
    FX.bars = (partnerIsReader() && summaryOK())
      ? newBars(netKeys('ac', 8)[act.partnerN] || 'ac0', 0,   /* s7.32 r1: you are seat 0 */
                'What the reader thinks you are building',
                'What the reader thought you were building')
      : null;
    /* the guess on the board as it stands, read once here: the band the layout
       reserves for the bars must never be an empty strip waiting for the
       visitor's first piece, and the reader's output on an empty board is a
       real forward pass like any other */
    if (FX.bars) pumpBars(S);
    if (!openBuild(S)) { S.reveal = runBuild(S); revealAll(S); return; }
    var i;
    for (i = 0; i < myMoves.length; i++) {
      hq.push({ cell: myMoves[i].cell, kind: myMoves[i].piece,
                x: cx(myMoves[i].cell), y: cy(myMoves[i].cell) });
      stepBuild(S);
    }
    revealNew(S);
    if (FX.bars) pumpBars(S);
  }

  /* whatever core has placed and the page has not shown yet */
  function revealNew(sess) {
    var cells = structCells(sess), i, t = now(), n = 0;
    for (i = 0; i < cells.length; i++) {
      if (sess.shown[cells[i]]) continue;
      sess.shown[cells[i]] = kindOf(sess, cells[i]);
      pushFlash(cells[i], 'place', t);
      n++;
    }
    return n;
  }

  function landed(cell) {
    var m = structMap(S);
    return !!(m && typeof m.get === 'function' && m.get(cell));
  }

  function placePiece(cell, piece) {
    holdSoundHint();          /* s7.29 ruling 5: the game line wins */
    if (!S || S.phase !== 'build') return false;
    if (S.buildDone) { refuse('Your build is finished. The wave is next.'); return false; }
    if (landed(cell)) { refuse('Something is already there.'); return false; }
    if (S.budgets && S.budgets[0] < (piece === PIECE_GUN ? COST_GUN : COST_WALL)) {
      refuse('Not enough budget for that.');
      return false;
    }
    if (!canPlace(S, cell, piece)) { refuse('You cannot build there.'); return false; }
    myMoves.push({ cell: cell, piece: piece });
    S.hq.push({ cell: cell, kind: piece, x: cx(cell), y: cy(cell) });
    var got = stepBuild(S);
    if (!landed(cell)) {
      /* core refused it after all: take the move back and say so rather than
         leaving a piece the visitor thinks they placed */
      myMoves.pop();
      rebuildYou();
      refuse('You cannot build there.');
      return false;
    }
    spawnDrone(0, cell);
    playSound(piece === PIECE_GUN ? 'build-gun' : 'build-wall',
              { owner: 0, x: cx(cell), y: cy(cell) });
    var theirs = revealNew(S) - 1;
    if (FX.bars) { FX.bars.lastCell = cell; pumpBars(S); }
    if (got.theirs) playSound('build-wall', { owner: 1 });
    var pname = (piece === PIECE_GUN ? 'Catapult' : 'Wall');
    var tail = (theirs > 0 ? ' Your partner placed one too.' : '');
    syncBudget();
    /* s7.21 ruling 8: the pieces are already two colours and at 1 css px per
       sprite pixel nothing on the page named them. The FIRST time the partner
       answers a placement, the status says which is which; after that the
       short form is enough and the legend row under the board carries it. */
    if (theirs > 0 && !coSaid) {
      coSaid = true;
      setStatus('Your ' + pname.toLowerCase() + ' (blue). Your partner placed one too (gold).',
                { force: true,
                  sr: 'Your ' + pname.toLowerCase() + ' in blue at column ' +
                      (cx(cell) + 1) + ', row ' + (cy(cell) + 1) +
                      '. Your partner placed one too, in gold. Budget ' +
                      budgetLeft() + ' left.' });
      return true;
    }
    /* the visible slot is two lines, so the column and row go to the screen
       reader mirror, which is where they were useful anyway (ruling 2) */
    setStatus(pname + ' placed. Budget ' + budgetLeft() + ' left.' + tail,
              { force: true,
                sr: pname + ' placed at column ' + (cx(cell) + 1) + ', row ' +
                    (cy(cell) + 1) + '. Budget ' + budgetLeft() + ' left.' + tail });
    return true;
  }

  /* ------------------------------------------------------------- the budget
     Build spec v3 s7.15 ruling 2. Core can carry a seat's budget past zero
     while it settles a phase, and the page printed that straight through as
     "Budget -1", which reads as an error rather than as "you are out". The
     readout is CLAMPED at zero, it lives beside the buttons that spend it in
     both the panel and the phone act bar, and a piece that costs more than is
     left has its button disabled rather than answering a click with a refusal
     the visitor never saw coming. */
  /* numbers under ten as words (the page's copy rule) */
  var BUDGET_WORD = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  function budgetWords(n) { return (n >= 0 && n < 10) ? BUDGET_WORD[n] : String(n); }
  function budgetLeft() {
    var v = (S && S.budgets && typeof S.budgets[0] === 'number') ? S.budgets[0] : 0;
    return Math.max(0, Math.round(v));
  }

  var budShown = -1, budPhase = '';

  /* ---- s7.26 ruling 2: THE BUDGET IS VISIBLE ------------------------------
     The dark judge played a whole turn without ever seeing what they had:
     entering Your turn scrolls the panel to reveal the partner portrait
     (s7.24 ruling 4) and at 1440x900 that parks "Budget N left" under the
     sticky act block, leaving a blank gap where the number should be. The
     ruling offers two answers and this is the second: during Your turn the
     line LIVES IN the pinned block, which is the one part of the panel no
     scroll can cover. It moves back the moment the act ends, so the pin is no
     taller than it has to be. One element, one writer, so the number cannot
     exist twice with two values. */
  function budgetHome(box, want) {
    var pin = byId('kit-panel-pin'), grp = byId('kit-build-controls');
    if (!pin || !grp) return;
    /* s7.27 ruling 1: the ROW the budget line came out of now joins the pin
       itself in Your turn, and the line is its first child there. The line is
       inside the pinned block either way, so it is only lifted out of the row
       while the row is still down in the panel's own flow. Lifting it while
       the row is pinned would put "Budget N left" UNDER the buttons that
       spend it, which is the opposite of what ruling 2 asked for. */
    var rowPinned = grp.parentNode === pin;
    var lift = want && !rowPinned;
    var inPin = box.parentNode === pin;
    if (lift && !inPin) { box.classList.add('kit-budget--pinned'); pin.appendChild(box); }
    else if (!lift && inPin) {
      box.classList.remove('kit-budget--pinned');
      if (grp.firstChild) grp.insertBefore(box, grp.firstChild);
      else grp.appendChild(box);
    }
  }

  /* ---- s7.27 ruling 1 (SEAM I1R-S1): THE BUILD ROW JOINS THE PIN ----------
     The integration hand of wave 1r found the major this answers by pressing
     Done building where a visitor presses it. On the desktop at window heights
     720 to 1000 a real press of "Your turn" left the whole of
     #kit-build-controls (Wall, Catapult, Undo, Done building) above the sticky
     pinned block and undrawn, while the board's caption said "press Done
     building"; a press at the button's own rect landed on an act button and
     took the visitor out of the act. It is arithmetic, not a race: at 1440x900
     the head and the pin take the first 303 px of the panel and leave a 417 px
     window, the reveal of the portrait with its blurb needs scrollTop >= 258,
     and the build row needs scrollTop <= 151. The two ranges do not meet.

     The answer is budgetHome's own precedent one element wider: during Your
     turn the ROW lives in the pinned block, which is the one part of the panel
     no scroll can cover, and goes back to its place in the panel's flow the
     moment the act ends. The reveal then has the room that remains and clamps
     to it (revealPartnerCard's s7.26 ruling 12 branch), so the portrait and
     its blurb are whole at 1440x900 and taller and the portrait alone below.

     The PHONE is not touched: its Done building lives in the bottom act bar,
     and while that bar exists the panel's copy is the duplicate markPanelDupes
     makes inert. `actbar` is therefore the gate, not a width.

     A comment node marks the row's home so the return lands where the markup
     put it; an empty element would be a flex item and would add the body's own
     0.7rem gap to a row that is not there. */
  var buildMark = null;
  var BUILD_PIN_GAP = 8;          /* .kit-group--pinned's own margin-top */
  var BUILD_PIN_FLOOR = 24;       /* never pin a block taller than its panel */

  /* the panel's own window if the row were pinned, measured the same way from
     either side so the answer cannot flap between the two states */
  function buildRoomFor(pin, grp) {
    var pane = byId('kit-panel'), head = document.querySelector('.kit-panel__head');
    if (!pane || !head) return 0;
    var room = pane.clientHeight - head.offsetHeight - pin.offsetHeight;
    if (grp.parentNode !== pin) room -= grp.offsetHeight + BUILD_PIN_GAP;
    return room;
  }

  /* ---- s7.32 addendum 3 item 3 (the round-9 critic's B3): THE STATUS LINE
     IS ON SCREEN IN YOUR TURN. Its fixed two-line slot sat under the act's
     prose, 573 px below the panel's window at 1440x900, so ruling 3's budget
     sentence, a refused click's answer and the call-the-shot hint were read
     only by screen readers. In Your turn the slot stands just under the build
     controls: inside the pinned block where the row is pinned, and right after
     the row in the panel's flow where it is not (the phone sheet). It is the
     same element with the same fixed height, so 7.15 ruling 2's no-jump law
     holds; it goes back to its own place the moment the act ends. */
  var statusMark = null;
  function statusHome() {
    var line = statusEl ? statusEl.parentNode : null, pin = byId('kit-panel-pin'),
        grp = byId('kit-build-controls'), body = byId('kit-panel-body');
    if (!line || !pin || !grp || !body) return;
    if (!statusMark) { statusMark = document.createComment('kit-status home'); line.parentNode.insertBefore(statusMark, line); }
    var want = act.name === 'you', pinned = grp.parentNode === pin;
    /* the pinned block's own lede ("Six short acts. ...") gives its two lines
       to the status slot while both would be pinned, so the window the partner
       reveal has (s7.22 ruling 2, s7.26 ruling 12) is not made smaller */
    var lede = pin.querySelector('.kit-lede');
    if (lede) lede.style.display = (want && pinned) ? 'none' : '';
    if (want && pinned) {
      if (line.parentNode !== pin || line.previousSibling !== grp) { line.style.order = ''; pin.insertBefore(line, grp.nextSibling); }
    } else if (want && actbar) {
      /* the phone sheet: the build controls there are the act bar's inert
         duplicate and the sheet rests scrolled to the partner's portrait, so
         the slot stands at the foot of the pinned act block instead */
      if (line.parentNode !== pin || line.nextSibling) { line.style.order = ''; pin.appendChild(line); }
    } else if (want) {
      if (line.parentNode !== grp.parentNode || line.previousSibling !== grp) { grp.parentNode.insertBefore(line, grp.nextSibling); }
      line.style.order = '0';
    } else if (statusMark.parentNode && line.previousSibling !== statusMark) {
      line.style.order = '';
      statusMark.parentNode.insertBefore(line, statusMark.nextSibling);
    } else line.style.order = '';
  }

  /* the row's home first, then the status slot under it (s7.32 add. 3) */
  function buildHome() { buildRowHome(); statusHome(); soundHome(); }

  /* ---- s7.32 addendum 3 item 5 (the sound audit's minor 2): THE SOUND
     TOGGLE AND NEW GAME ARE REACHABLE. The standing row sat under the pinned
     act block whenever the panel rested scrolled to the partner's portrait
     (Your turn, Reading the plan), 0 px visible. Where there is no phone act
     bar the toggle stands in the panel's sticky head, beside "?", in every
     act; on a phone the act bar carries its own and the row keeps it. And at
     a game's end the panel scrolls New game into its window once. */
  var soundMark = null;
  function soundHome() {
    var snd = byId('kit-sound'), head = document.querySelector('.kit-panel__head'), help = byId('kit-help');
    if (!snd || !head || !help) return;
    if (!soundMark) { soundMark = document.createComment('kit-sound home'); snd.parentNode.insertBefore(soundMark, snd); }
    var want = !actbar;
    if (want && snd.parentNode !== head) { snd.classList.add('kit-sound--head'); head.insertBefore(snd, help); }
    else if (!want && snd.parentNode === head && soundMark.parentNode) {
      snd.classList.remove('kit-sound--head');
      soundMark.parentNode.insertBefore(snd, soundMark.nextSibling);
    }
  }
  function revealNewGame() {
    var pane = byId('kit-panel'), ng = byId('kit-newseed');
    if (!pane || !ng || !panelOpen || actbar || !ng.offsetParent) return;
    var br = pane.getBoundingClientRect(), r = ng.getBoundingClientRect(), ceiling = panelCeiling(br);
    if (r.top < ceiling) pane.scrollTop -= Math.ceil(ceiling - r.top + 4);
    else if (r.bottom > br.bottom) pane.scrollTop += Math.ceil(r.bottom - br.bottom + 4);
  }
  function buildRowHome() {
    var pin = byId('kit-panel-pin'), grp = byId('kit-build-controls'),
        body = byId('kit-panel-body'), bud = byId('kit-budget');
    if (!pin || !grp || !body) return;
    var inPin = grp.parentNode === pin;
    /* once pinned the act keeps it pinned: re-measuring in the pinned state is
       what would let a window resize flap the row between the two homes */
    var want = (act.name === 'you') && !actbar &&
               (inPin || buildRoomFor(pin, grp) > BUILD_PIN_FLOOR);
    if (want === inPin) return;
    if (want) {
      if (!buildMark) {
        buildMark = document.createComment('kit-build-controls home');
        body.insertBefore(buildMark, grp);
      }
      /* the line rides back INSIDE the row, at its head, so the pinned block
         reads "Budget N left" and then the four buttons under it */
      if (bud && bud.parentNode !== grp) {
        bud.classList.remove('kit-budget--pinned');
        grp.insertBefore(bud, grp.firstChild);
      }
      grp.classList.add('kit-group--pinned');
      pin.appendChild(grp);
    } else {
      grp.classList.remove('kit-group--pinned');
      if (buildMark && buildMark.parentNode === body) body.insertBefore(grp, buildMark);
      else body.appendChild(grp);
    }
  }

  function syncBudget(force) {
    var live = !!(S && act.name === 'you');
    var v = live ? budgetLeft() : 0;
    var ph = live ? (S.phase + (S.buildDone ? '+' : '')) : 'none';
    if (!force && v === budShown && ph === budPhase) return;
    budShown = v; budPhase = ph;
    var n = byId('kit-budget-n'), box = byId('kit-budget'), bar = byId('kit-bar-budget');
    /* s7.21 ruling 10: "Budget 12 left" stood after the game had ended, beside
       an Undo and a Done building nobody could use. The readout clears with
       them rather than quoting a number that can no longer be spent. */
    var over = gameOver();
    if (n) n.textContent = String(v);
    if (box) {
      box.classList.toggle('kit-budget--low', live && !over && v < COST_WALL);
      box.hidden = over;
      budgetHome(box, live && !over);
    }
    /* s7.26 ruling 7: the chip HIDES rather than emptying. With only its text
       cleared the phone act bar kept drawing a grey box the size of a button
       beside three greyed buttons, which the light judge read as a fourth
       control that had lost its label. */
    if (bar) {
      bar.textContent = over ? '' : ('Budget ' + v);
      bar.hidden = over;
    }
    var building = live && !over && S.phase === 'build' && !S.buildDone;
    /* s7.32 addendum 3 item 2: an armed piece the budget can no longer pay for
       hands the arm back to the Wall when a Wall is affordable (no tick: the
       visitor did not press anything) */
    if (building && selPiece === PIECE_GUN && v < COST_GUN && v >= COST_WALL) {
      selPiece = PIECE_WALL; legalBand = null; syncPieceButtons();
    }
    setDisabled(['kit-piece-wall', 'kit-bar-wall'], !building || v < COST_WALL);
    setDisabled(['kit-piece-gun', 'kit-bar-gun'], !building || v < COST_GUN);
    /* s7.21 ruling 10: a greyed Catapult says WHY. A disabled button dispatches
       no pointer events, so the reason rides on the title AND on a hover its
       own row hears for it (wireGreyReason). */
    setTitles(['kit-piece-gun', 'kit-bar-gun'], greyReason(PIECE_GUN));
    setTitles(['kit-piece-wall', 'kit-bar-wall'], greyReason(PIECE_WALL));
    syncDoneGate();
  }

  function setTitles(ids, txt) {
    var i, el;
    for (i = 0; i < ids.length; i++) {
      el = byId(ids[i]);
      if (!el) continue;
      if (txt) el.setAttribute('title', txt);
      else el.removeAttribute('title');
    }
  }

  /* why a piece button is greyed, in one sentence, or '' when it is live */
  function greyReason(piece) {
    var cost = (piece === PIECE_GUN) ? COST_GUN : COST_WALL;
    var name = (piece === PIECE_GUN) ? 'A catapult' : 'A wall';
    if (act.name !== 'you' || !S) return '';
    if (gameOver()) return 'This game is finished.';
    if (S.phase !== 'build' || S.buildDone) {
      return 'The wave is running. You build again after it.';
    }
    if (budgetLeft() < cost) {
      return name + ' costs ' + cost + ' and you have ' + budgetLeft() + ' left.';
    }
    return '';
  }

  /* A disabled control is invisible to pointer events, so its ROW hears the
     hover for it and the page answers in the status line. One write per entry:
     the sentence is not repeated while the pointer sits still. */
  var greySaid = '';
  function wireGreyReason(el) {
    if (!el || el.getAttribute('data-greywired')) return;
    el.setAttribute('data-greywired', '1');
    el.addEventListener('pointermove', function (e) {
      /* s7.25 ruling 3: Done building and Undo grey out with the pieces now,
         so the row answers for all four rather than for two of them */
      var ids = ['kit-piece-gun', 'kit-bar-gun', 'kit-piece-wall', 'kit-bar-wall',
                 'kit-done', 'kit-bar-done', 'kit-undo', 'kit-bar-undo'];
      var i, b, r, why = '';
      for (i = 0; i < ids.length; i++) {
        b = byId(ids[i]);
        if (!b || !b.disabled) continue;
        r = b.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right &&
            e.clientY >= r.top && e.clientY <= r.bottom) {
          why = b.getAttribute('title') || '';
          break;
        }
      }
      if (!why) { greySaid = ''; return; }
      if (why === greySaid) return;
      greySaid = why;
      setStatus(why, { force: true });
    });
    el.addEventListener('pointerleave', function () { greySaid = ''; });
  }

  function setDisabled(ids, off) {
    var i, el;
    for (i = 0; i < ids.length; i++) {
      el = byId(ids[i]);
      if (!el) continue;
      if (off) el.setAttribute('disabled', 'disabled');
      else el.removeAttribute('disabled');
    }
  }

  function refuse(msg) {
    playSound('illegal', {});
    /* a refusal ANSWERS a click, so it takes the line at once (ruling 2) */
    setStatus(msg, { force: true });
  }

  function undoPlacement() {
    holdSoundHint();          /* s7.29 ruling 5: the game line wins */
    if (act.name !== 'you' || !myMoves.length) { refuse('Nothing to take back.'); return false; }
    myMoves.pop();
    rebuildYou();
    FX.flashes.length = 0;
    playSound('undo', {});
    setStatus('Took that back.', { force: true });
    syncBudget();
    return true;
  }

  function removeAt(cell) {
    if (act.name !== 'you' || !S || S.phase !== 'build') return;
    var i;
    for (i = myMoves.length - 1; i >= 0; i--) {
      if (myMoves[i].cell === cell) {
        myMoves.splice(i, 1);
        rebuildYou();
        FX.flashes.length = 0;
        playSound('undo', {});
        setStatus('Removed.', { force: true });
        syncBudget();
        return;
      }
    }
    refuse('That one is not yours.');
  }

  function doneBuilding() {
    holdSoundHint();          /* s7.29 ruling 5: the game line wins */
    if (!S || S.phase !== 'build') return;
    /* ruling 8: never while the walkthrough card is up, whichever Done fired */
    if (coachShown()) return;
    /* s7.24 ruling 1: the expanded phone panel stands over the whole board, so
       a visitor who pressed Done building from inside it watched a whole wave
       resolve behind it (the dark judge's first major). The controls stand
       down for the wave they just started, BEFORE the first wave frame. */
    collapseForPlay();
    /* the partner plays out the rest of the phase alone: one summary sound,
       never one per piece */
    if (S.bstate && !S.buildDone) {
      var got = stepBuild(S, { all: true });
      var shown = revealNew(S);
      if (got.theirs) playSound('build-wall', { owner: 1 });
      if (shown) setStatus('Your partner placed ' + got.theirs + ' more.', { force: true });
    }
    if (!startWave(S)) { setStatus(honestMissing()); return; }
    playing = !reducedMotion() && !rmStepping;
    lastTick = 0;
    playSound('wave-start', {});
    syncBudget();
    /* ruling 6: the tap-a-creature invitation is NOT printed under reduced
       motion, where the wave never runs long enough for anyone to accept it */
    setStatus('Wave ' + (S.wave + 1) + ' of ' + WAVES + '.' +
              (reducedMotion() ? '' : ' ' + tapWord() + ' a walker that has stopped to call the shot.'));
    if (reducedMotion() && !rmStepping) resolveInstantly();
  }

  /* The visitor's wave verb: tap a planted creature and your own machines in
     reach prefer it. It adds no credits, and the AI cast never marks. */
  function markFocus(cell) {
    if (!S || !S.ws) return false;
    var st = renderState(S), i, best = -1, bd = 3;
    for (i = 0; i < st.walkers.length; i++) {
      if (!st.walkers[i].atk) continue;
      var d = Math.abs(cx(st.walkers[i].cell) - cx(cell)) +
              Math.abs(cy(st.walkers[i].cell) - cy(cell));
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) return false;
    var id = st.walkers[best].id;
    FX.focusMark = id;
    if (Core && Core.setFocus) { try { Core.setFocus(S.g, S.ws, 0, id); } catch (e) {} }
    playSound('focus-mark', { x: cx(st.walkers[best].cell), y: cy(st.walkers[best].cell) });
    setStatus('Calling the shot on that one.', { force: true });
    return true;
  }

  /* ------------------------------------------------------------------ input */

  var pointerDown = false, dragPid = -1, dragged = {};
  /* the drag-to-pan gesture (ruling 5): where the pointer went down, how far
     it has travelled, and whether it has passed the slop that separates a tap
     from a drag. A tap can therefore never move the camera by construction. */
  var PAN_SLOP = 8;
  var dragFrom = null, dragLast = null, dragPan = false;

  function localPt(e) {
    var r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /* screen pixels to source pixels, the inverse of the view's own scale */
  function panBy(dx, dy) {
    if (!view || !view.S) return;
    var k = (view.dpr || 1) / view.S;
    var sw = (RC && RC.SRCW) ? RC.SRCW : 740, sh = (RC && RC.SRCH) ? RC.SRCH : 356;
    cam.manual = true;
    cam.hold = 0;
    cam.tx = Math.max(0, Math.min(sw, cam.tx - dx * k));
    cam.ty = Math.max(0, Math.min(sh, cam.ty - dy * k));
    cam.x = cam.tx; cam.y = cam.ty;
    syncRecenter();
  }

  function recenterCamera() {
    cam.manual = false;
    cam.hold = 0;
    setStatus('Camera back on the fight.', { force: true });
    syncRecenter();
  }

  var recenterEl = null, recenterOn = false;
  /* s7.29 ruling 2: the pill's measured height, taken once per appearance */
  var recenterH = 0;

  /* ---- s7.29 ruling 2: THE MINIMAP AND ITS PILL STAND INSIDE THE PICTURE --
     They were placed from `stripW()` and `view.topPad`, which are the page's
     own edges and not the board's: on a phone the pair ran to the viewport's
     right edge and sat in the band ABOVE the picture, and both lanes read the
     pill as clipped and the inset as something dropped on the board. ONE
     geometry, read by drawInset and by placeRecenter, so the two cannot drift
     apart: a corner of the PICTURE that covers no keep cell, tried top right,
     top left, bottom right, bottom left, with the whole block (inset, gap,
     pill) inside the picture and inside the viewport. */
  function keepScreenRect() {
    var band = keepSrcBand();
    if (!band || !view || view.fallback) return null;
    var d = Math.max(1, view.dpr || 1), k = (view.S || 1) / d;
    var fx0 = view.fx0 || 0, fy0 = view.fy0 || 0;
    return { x: view.ox + (band.left - fx0) * k, y: view.oy + (band.top - fy0) * k,
             w: (band.right - band.left) * k, h: (band.bot - band.top) * k };
  }

  var INSET_GAP = 12;
  function insetGeom() {
    if (!view || view.fallback) return null;
    var pic = { x: view.ox, y: view.oy, w: view.bw || 0, h: view.bh || 0 };
    if (!(pic.w > 40) || !(pic.h > 40)) return null;
    var d = Math.max(1, view.dpr || 1), bz = (RC ? RC.BEZ : 6) * (view.S || 1) / d;
    var pad = Math.round(bz) + 6;
    var w = Math.round(Math.min(150, Math.max(64, (pic.w - pad * 2) * 0.38)));
    var ar = (RC && RC.SRCH && RC.SRCW) ? (RC.SRCH / RC.SRCW) : 0.5;
    var h = Math.max(20, Math.round(w * ar));
    /* the pill's own height, MEASURED WHEN IT APPEARS and never inside the
       paint: this runs every frame of a phone wave and a getBoundingClientRect
       there is a forced synchronous layout per frame */
    var ph = recenterH || 36;
    var blockH = h + INSET_GAP + ph;
    var L = Math.round(pic.x + pad), Rr = Math.round(pic.x + pic.w - pad - w);
    var T = Math.round(pic.y + pad), B = Math.round(pic.y + pic.h - pad - blockH);
    if (Rr < L) Rr = L;
    if (B < T) B = T;
    var keep = keepScreenRect();
    var cand = [{ x: Rr, y: T }, { x: L, y: T }, { x: Rr, y: B }, { x: L, y: B }];
    var i, c, block, best = null;
    for (i = 0; i < cand.length; i++) {
      c = cand[i];
      block = { x: c.x, y: c.y, w: w, h: blockH };
      if (c.x < 2 || c.x + w > cssW - 2 || c.y < 2 || c.y + blockH > cssH - 2) continue;
      if (best === null) best = c;
      if (keep && rectOverlap(block, keep) > 0) continue;
      best = c; break;
    }
    if (!best) best = { x: Math.max(2, Math.min(cssW - 2 - w, Rr)),
                        y: Math.max(2, Math.min(cssH - 2 - blockH, T)) };
    return { x: best.x, y: best.y, w: w, h: h, ph: ph,
             pill: { x: best.x, y: best.y + h + INSET_GAP, w: w, h: ph } };
  }

  /* the button sits under the overview inset, which drawInset() places from
     the same geometry, so the two cannot drift apart */
  var recenterKey = '';
  function placeRecenter() {
    if (!recenterEl || !view) return;
    var g = insetGeom();
    if (!g) return;
    /* the picture moves every frame under a follow camera, so this is called
       from the paint too; only a pill that really MOVED costs a style write */
    var k = Math.round(g.pill.x) + ',' + Math.round(g.pill.y) + ',' + g.w;
    if (k === recenterKey) return;
    recenterKey = k;
    recenterEl.style.left = Math.round(g.pill.x) + 'px';
    recenterEl.style.top = Math.round(g.pill.y) + 'px';
    recenterEl.style.width = g.w + 'px';
  }

  /* ruling 6: the Step control, placed under the board's own top left corner
     so it reads as belonging to the picture rather than to the panel */
  var stepEl = null;
  /* s7.27 ruling 2, re-cut by s7.28 ruling 2: the gap the chip keeps from the
     drawn FRAME's outer edge when it has to stand above it (the phone). */
  var STEP_CLEAR = 4;
  /* s7.28 ruling 4: the slot the chip last really took, so a dialog cannot
     move it. Written only by this function. */
  var stepLast = null;

  function syncStepBtn() {
    if (!stepEl) return;
    /* s7.24 ruling 1 again: a board control may not stand on the open phone
       panel (see syncRecenter) */
    var want = rmStepAvailable() && !(phone() && panelOpen);
    stepEl.hidden = !want;
    if (!want) { stepLast = null; return; }
    /* ---- s7.28 ruling 4: THE CHIP HOLDS ITS SLOT UNDER A DIALOG -----------
       The caption row is not dealt while Fine print or help is open (the
       caption is not painted at all then, s7.19 ruling 2), so `capRowStep`
       was null and the placement fell through to the board's own corner: the
       light reduced-motion judge watched Step travel from (265, 779) to
       (46, 298), ON the board, and back when the dialog closed. A control
       that moves because a visitor opened a reading pane reads as a fault.
       The chip keeps the slot it last really took; it is placed again the
       moment the page owns its own caption row. */
    if (modalOpen()) {
      if (stepLast) {
        stepEl.style.left = stepLast.x + 'px';
        stepEl.style.top = stepLast.y + 'px';
        return;
      }
      stepEl.hidden = true;
      return;
    }
    /* ---- s7.24 ruling 7: THE STEP CONTROL SITS IN THE CAPTION ROW ----------
       It used to stand above the board's top left corner, in the band the
       landing leaves there. Ruling 7 holds the reader's bar band open through
       the framed wave, so that band is now the bar plate's, and the light
       reduced-motion judge photographed Step over the second row's label
       ("Centre shelf") and part of its bar. The caption row is the one strip
       under the board that is always the page's own, so the control rides
       beside the caption plate: left of it where there is room, right of it
       otherwise, and only then back to the old band. */
    var b = boxes.board || null;
    var r = null;
    try { r = stepEl.getBoundingClientRect(); } catch (e) { r = null; }
    var bw2 = (r && r.width) ? r.width : 56, bh2 = (r && r.height) ? r.height : 30;
    var cap = capDrawn, x = null, y = null;
    /* s7.26 ruling 5: the caption row DEALS the slots, so the control and the
       seat legend cannot both be given the room on the left of the plate */
    if (capRowStep) { x = capRowStep.x; y = capRowStep.y; }
    else if (cap && cap.w > 0) {
      y = Math.round(cap.y + (cap.h - bh2) / 2);
      if (cap.x - bw2 - 10 >= 8) x = Math.round(cap.x - bw2 - 10);
      else if (cap.x + cap.w + 10 + bw2 <= stripW() - 8) x = Math.round(cap.x + cap.w + 10);
    }
    if (x === null || y === null) {
      /* s7.28 ruling 2: measured against the DRAWN FRAME, which is what a
         visitor sees the chip standing on, not against the tile plate */
      var fr = frameRect();
      if (fr && fr.left) x = Math.round(fr.x + 8);
      else x = b ? Math.round(b.x + 8) : 12;
      /* ---- s7.28 ruling 2: THE CEILING IS THE FURNITURE, NOT THE PAD ------
         This guard read `view.topPad`, and on a phone that pad is the
         collapsed panel's own foot PLUS ten pixels of air (layout()). Asking
         the chip to clear the drawn frame rather than the tile plate moved it
         up by the twenty one pixels of bezel and sky band, which put its top
         four pixels inside that air, so the guard dropped it BELOW the board
         into the room the phone's caption row owns. The chip's real ceiling
         is the furniture above the board: the masthead's floor, the collapsed
         panel's foot and the walkthrough card's, each with four pixels of
         clearance of its own. */
      var top = phone() ? 96 : 132;
      if (boxes.panel && boxes.panel.h > 0 && boxes.panel.y < cssH * 0.4) {
        top = Math.max(top, boxes.panel.y + boxes.panel.h + 4);
      }
      if (boxes.coach && boxes.coach.h > 0 && boxes.coach.y < cssH * 0.4) {
        top = Math.max(top, boxes.coach.y + boxes.coach.h + 4);
      }
      /* ---- s7.27 ruling 2: THE PHONE STEP CHIP CLEARS THE FRAME ----------
         s7.26 ruling 5's "below the board's bottom edge" is the DESKTOP law:
         there the caption row deals this control a slot of its own. On the
         phone the row below the board belongs to the outcome plate, so the
         chip stands above the board, and it stood two pixels INTO it: the old
         offset was a flat 34 px against a chip that measures 36 tall at a real
         phone's ratio, so the bottom edge landed at b.y + 2 in all three acts
         and both themes (i1r/m4-step.json). The offset is now the chip's own
         height plus a clearance, so the arithmetic cannot drift with the font
         or the ratio again. */
      /* s7.28 ruling 2: the edge is the frame's OUTER top when the frame's
         top edge is really drawn, and the tile plate only when it is not
         (a crop that has cut the bezel away has no frame there to clear) */
      var edgeTop = (fr && fr.top) ? fr.y : (b ? b.y : 0);
      var edgeBot = (fr && fr.bottom) ? (fr.y + fr.h) : (b ? b.y + b.h : 0);
      /* floor and ceil, never round: a chip whose height lands on a half
         pixel would be rounded half a pixel TOWARDS the frame, and the bar
         is a clearance, so the rounding goes the way that keeps it */
      y = b ? Math.floor(edgeTop - bh2 - STEP_CLEAR) : 12;
      if (!b || y < top) y = b ? Math.ceil(edgeBot + STEP_CLEAR + 4) : 12;
      /* never on the bar plate, which owns the band above the board */
      if (barsDrawn && rectOverlap({ x: x, y: y, w: bw2, h: bh2 }, barsDrawn) > 0) {
        y = Math.round(barsDrawn.y + barsDrawn.h + 6);
      }
    }
    if (y > cssH - 60) y = Math.round(cssH - 60);
    x = Math.max(6, Math.min(Math.round(stripW() - bw2 - 6), x));
    stepEl.style.left = x + 'px';
    stepEl.style.top = y + 'px';
    stepLast = { x: x, y: y };
    stepEl.setAttribute('aria-label', rmStepping
      ? 'Step the wave forward one move'
      : 'Step: play this wave again one move at a time');
  }

  function syncRecenter() {
    if (!recenterEl) return;
    /* s7.24 ruling 1: these two belong to the BOARD, and on a phone the open
       panel stands in front of the board. An opaque panel with a floating
       board control painted across its prose is the same defect the mask is
       for, in the DOM instead of the canvas (money shot p17/shots/openwave).
       They come back the moment the controls stand down. */
    var want = followFull() && phone() && !panelOpen;
    if (want !== recenterOn) {
      recenterOn = want;
      recenterEl.hidden = !want;
      if (want) {
        /* the one measurement, outside the paint (s7.29 ruling 2) */
        try {
          var rr = recenterEl.getBoundingClientRect();
          if (rr && rr.height > 4) recenterH = Math.round(rr.height);
        } catch (e) {}
        placeRecenter();
      }
    }
  }

  function onDown(e) {
    if (e.button === 2) return;
    armAudio();
    /* any other input answers the New game question with "no" (s7.24 r4) */
    newSeedDisarm();
    /* ruling 2: the end-of-game mark dismisses on the NEXT INPUT */
    dismissEndMark();
    /* a focused panel control keeps Space bound to itself, which is how the
       site's double download bug happened */
    if (document.activeElement && document.activeElement !== cv && document.activeElement.blur) {
      try { document.activeElement.blur(); } catch (err) {}
    }
    try { cv.focus({ preventScroll: true }); } catch (err) { try { cv.focus(); } catch (e2) {} }
    /* s7.32 ruling 6 (i): a press INSIDE an open close up closes it and places
       nothing. It used to close the card and then build on the tile under it,
       which the visitor could not see. */
    var lp = localPt(e), lb = loupe.on ? loupe.box : null;
    if (lb && lp.x >= lb.x && lp.x <= lb.x + lb.w && lp.y >= lb.y && lp.y <= lb.y + lb.h) {
      closeLoupeLine(); e.preventDefault(); return;
    }
    pointerDown = true; dragPid = e.pointerId; dragged = {};
    dragFrom = { x: e.clientX, y: e.clientY };
    dragLast = { x: e.clientX, y: e.clientY };
    dragPan = false;
    var p = localPt(e), cell = cellAtCss(p.x, p.y);
    /* ruling 7: in Strangers the board is not what is on screen, the gallery
       is, and a tap on one of its squares reports that game */
    if (act.name === 'strangers') { if (gridTapAt(p.x, p.y)) e.preventDefault(); return; }
    /* s7.23 ruling 3: in Six plans the board is not what is on screen either,
       and a tap on one of the six cards reports what that plan built */
    if (act.name === 'plans') {
      if (planTapAt(p.x, p.y)) { e.preventDefault(); return; }
      /* s7.26 ruling 8: a press that lands on no tile lets the pick go, so the
         card stands down and the gallery's own caption comes back */
      if (planTapped >= 0) {
        planTapped = -1;
        capForce(captionWant());
        syncCapcardText();
      }
      return;
    }
    if (cell < 0) {
      /* s7.24 ruling 8, the half onDown never took. The machine's drawn body
         rises ABOVE its own foot cell, and on the board's top row that body is
         off the tile plate altogether, where `cellAtCss` answers -1. `onMove`
         hit tests the drawn machine BEFORE it trusts the cell (which is what
         that ruling is), and this path bailed first, so a top row catapult
         could be hovered, could be named by `machineAt`, and could never be
         tapped: measured at 320 css px, where the board is wider than the
         window and the top row is what a thumb reaches, `machineAt` named cell
         31 at (17, 213.5) and eight real taps there opened nothing. */
      var body = machineCellAt(p.x, p.y, -1);
      if (body >= 0 && tapMachine(body)) { e.preventDefault(); return; }
      if (loupe.src === 'tap') closeLoupeLine();   /* s7.32 addendum 3 item 6: a press off the board too */
      return;
    }
    e.preventDefault();
    cursorCell = cell;
    /* a tap on a machine is the loupe, on any device (build spec v3 s7.9
       ruling 3b). It takes the tap from the act's own cell verb, which on a
       machine tile was a refusal in the build phase anyway.
       s7.24 ruling 8: the machine's whole DRAWN body answers, not the foot
       cell alone (R.machineHit); a legal build tile keeps its own verb. */
    var mcell = machineCellAt(p.x, p.y, cell);
    if (mcell >= 0 && tapMachine(mcell)) { dragged[cell] = 1; return; }
    if (tapMachine(cell)) { dragged[cell] = 1; return; }
    /* s7.32 addendum 3 item 6: a press on another tile closes the card too;
       the cell's own verb speaks first, and only if it said nothing does the
       act's line take back the card's "again to close" */
    var saidOpen = (loupe.src === 'tap') ? loupe.said : '';
    if (loupe.src === 'tap') closeLoupe();
    handleCell(cell);
    lineAfterClose(saidOpen);
    dragged[cell] = 1;
  }

  function onMove(e) {
    var p = localPt(e), cell = cellAtCss(p.x, p.y);
    /* s7.24 ruling 8: THE HIT TARGET IS THE WHOLE DRAWN MACHINE. The sprite
       stands ABOVE its own foot cell, so a pointer on the machine's body
       resolved to the empty tile over it: the close up never opened (two of
       three round 4 judges never saw it at all) and the empty tile answered
       with the red refusal box instead, which is an error message about
       something the visitor never asked for. A legal build tile keeps its own
       verb, so nothing about building changes. */
    var mach = machineCellAt(p.x, p.y, cell);
    hoverMachine(mach >= 0 ? mach : cell, e.pointerType);
    setGhost(mach >= 0 ? -1 : cell);
    FX.hover = cell;
    if (!pointerDown || e.pointerId !== dragPid) return;
    /* the pan gesture. It only ever applies while the phone follow camera is
       up, and only past the slop, so a tap is never a pan (ruling 5). */
    if (followFull() && phone() && dragFrom) {
      if (!dragPan) {
        var far = Math.abs(e.clientX - dragFrom.x) + Math.abs(e.clientY - dragFrom.y);
        if (far > PAN_SLOP) dragPan = true;
      }
      if (dragPan) {
        panBy(e.clientX - dragLast.x, e.clientY - dragLast.y);
        dragLast = { x: e.clientX, y: e.clientY };
        return;
      }
    }
    dragLast = { x: e.clientX, y: e.clientY };
    if (cell < 0 || dragged[cell]) return;
    dragged[cell] = 1;
    if (act.name === 'you' && S && S.phase === 'build') handleCell(cell);
  }

  function onUp(e) {
    if (e.pointerId === dragPid) {
      pointerDown = false; dragPid = -1;
      dragFrom = null; dragLast = null; dragPan = false;
    }
    /* a finger that lifts is not hovering anything, and there is no
       pointerleave to say so (s7.21 ruling 10, the stranded ghost) */
    if (e && e.pointerType && e.pointerType !== 'mouse') {
      FX.ghost = null; ghostBad = -1; FX.hover = -1;
    }
  }

  /* ---- the build ghost (build spec v3 s7.15 ruling 2) ----------------------
     A visitor used to learn the buildable area by clicking: one panel judge
     spent 17 real clicks before the 18th landed, and the only feedback was a
     refusal that lived 140 ms. So while a build tool is armed the tile under
     the pointer carries a ghost that says in advance whether it will take the
     piece. The LEGAL ghost is the renderer's own (FX.ghost, its owner colour
     and its own weight, drawn inside frame()); the ILLEGAL one is
     R.paintGhost(ctx, tile, false), which is PIN R-S2's own refusal form: the
     warm ink with a BAR ACROSS THE TILE, so the refusal is answered by a
     picture and not by a hue alone. The page used to draw its own cross here
     in a hard-coded rgba, on the belief that the renderer had no illegal form
     to ask for; it has one, and this is SEAM R2L-S2's other half closed by
     the integration hand. The hand-drawn cross stays only as the fallback for
     a renderer without the painter. */
  var ghostBad = -1;

  function ghostKind(cell, piece) {
    if (act.name !== 'you' || !S || S.phase !== 'build' || S.buildDone) return 0;
    if (cell < 0 || cell >= CELLS) return 0;
    if (landed(cell)) return 2;
    if (budgetLeft() < (piece === PIECE_GUN ? COST_GUN : COST_WALL)) return 2;
    return canPlace(S, cell, piece) ? 1 : 2;
  }

  function setGhost(cell) {
    var k = ghostKind(cell, selPiece);
    if (k === 1) { FX.ghost = { cell: cell, piece: selPiece, a: 0.85 }; ghostBad = -1; }
    /* s7.21 ruling 10: a cell that already CARRIES a structure is answered by
       the close up, which opens on the same hover. Painting the refusal cross
       over it put information and an error on one tile. */
    else if (k === 2 && !landed(cell)) { FX.ghost = null; ghostBad = cell; }
    else { FX.ghost = null; ghostBad = -1; }
  }

  /* s7.21 ruling 10: the ghost is a HOVER, and a finger does not hover. It is
     dropped whenever the state that made it legal has moved on, which covers
     the lift of a touch, a phase boundary, an act change and a game ending in
     one place instead of four. */
  function syncGhost() {
    if (FX.ghost && ghostKind(FX.ghost.cell, FX.ghost.piece) !== 1) FX.ghost = null;
    if (ghostBad >= 0 && (ghostKind(ghostBad, selPiece) !== 2 || landed(ghostBad))) {
      ghostBad = -1;
    }
  }

  /* the warm cross that says "not here", drawn on the tile the renderer would
     have ghosted */
  /* ------------------------------------------------------ the legal band
     Build spec v3 s7.19 ruling 8. Judges needed 18 to 40 clicks to place two
     walls: the page showed a ghost under the pointer and nothing else, so
     finding the buildable tiles was a search. While a piece is ARMED every
     tile that piece may legally take is tinted faintly, which turns the search
     into a glance. The list is core's own answer (canPlace), asked once per
     board state rather than per frame, and it is drawn as ONE path so the
     whole band costs three 2D operations. */
  var legalBand = null;

  function legalKey() {
    if (!S || act.name !== 'you' || S.phase !== 'build' || S.buildDone) return '';
    return act.seq + '|' + S.wave + '|' + selPiece + '|' + budgetLeft() + '|' +
           myMoves.length + '|' + structCells(S).length;
  }

  function legalCells() {
    var k = legalKey();
    if (!k) { legalBand = null; return null; }
    if (legalBand && legalBand.key === k) return legalBand.cells;
    var out = [], c;
    for (c = 0; c < CELLS; c++) {
      if (ghostKind(c, selPiece) === 1) out.push(c);
    }
    legalBand = { key: k, cells: out };
    return out;
  }

  /* ---- s7.30 ruling 3: THE LIT AREA STAYS INSIDE THE PICTURE --------------
     Ship gate round 8 (verify M2): after every wave the keep survived in Your
     turn, while the follow camera held the framed view into the build phase
     (FOLLOW_HOLD and the ease out, 1,335 to 1,400 ms), the legal region's
     outline was painted unclipped, so its rectangles ran above the frame and
     off both sides of the board onto the page, just as the caption said
     "Build inside the lit area". The band is now painted through a canvas
     clip to the picture the frame really drew (the resting board's own box on
     the desktop, s7.29 ruling 1, and the phone's framed stage on a phone), in
     every camera state, and inside that picture's own frame band, so the
     border s7.29 ruling 1 paints back on a cut edge stays whole under it too.
     At rest no tile of the band reaches the frame band: a frame-by-frame A/B
     against the untouched build is identical (i1v/verify/ab-frames.js). */
  function drawLegalBand() {
    if (!view || view.fallback || !(view.bw > 0) || !(view.bh > 0)) { paintLegalBandIn(); return; }
    ctx.save();
    ctx.beginPath();
    var bz = (RC ? RC.BEZ : 6) * (view.S || 1) / Math.max(1, view.dpr || 1);
    ctx.rect(view.ox + bz, view.oy + bz, view.bw - 2 * bz, view.bh - 2 * bz);
    ctx.clip();
    try { paintLegalBandIn(); } finally { ctx.restore(); }
  }

  function paintLegalBandIn() {
    var cells = legalCells();
    if (!cells || !cells.length || !RAPI || !RAPI.cellRect || !view || view.fallback) return;
    /* PIN R-S4 is the renderer's half of this ruling: the page owns LEGALITY
       (budget, occupancy, reach) and the renderer owns the picture, so the
       band's ink is the seat's own colour rather than a second accent living
       on this side. The page keeps its own path below for a renderer without
       the pin, and both draw the same shape. */
    if (R && R.paintLegalBand) {
      /* s7.24 ruling 6, this zone's half: the page ASKS for the band that is
         visible AT REST. "Build on the lit tiles" was true of 231 of 336 cells
         and neither judge could see one lit tile in either theme, so the lit
         treatment is requested explicitly rather than taken from a default
         that a later hand could flip without either zone noticing. */
      /* s7.26 ruling 4, this zone's half (PIN R-S9). The per-tile outline of
         wave 1q covered about 95 percent of the map with pale boxes and the
         light judge read the headline act as a rendering fault. At rest the
         legal region is ONE soft boundary over a faint wash, and the per-tile
         outline is drawn for the HOVERED OR TOUCHED tile alone, which is the
         cell the page already knows (`FX.hover`, which a finger's lift
         clears). A renderer without the pin ignores the key and draws what it
         drew before. */
      bandDrawn = R.paintLegalBand(ctx, view, cells,
                                   { owner: 'a', lit: true,
                                     hover: (FX.hover >= 0 ? FX.hover : -1) }) || 0;
      return;
    }
    var i, r, n = 0;
    ctx.save();
    ctx.beginPath();
    for (i = 0; i < cells.length; i++) {
      r = null;
      try { r = RAPI.cellRect(view, cells[i]); } catch (e) { r = null; }
      if (!r || !isFinite(r.x) || r.w < 2 || r.h < 2) continue;
      if (r.x + r.w < 0 || r.x > cssW || r.y + r.h < 0 || r.y > cssH) continue;
      ctx.rect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
      n++;
    }
    if (n) {
      ctx.fillStyle = isLight() ? 'rgba(52,86,138,0.13)' : 'rgba(130,166,204,0.13)';
      ctx.fill();
    }
    ctx.restore();
    bandDrawn = n;
  }
  var bandDrawn = 0;

  /* ------------------------------------------------- the first wave's hint
     Ruling 8 again: the close up is the page's own remedy for a 15 x 20 px
     machine and two of three judges never found it. ONE machine is ringed
     ONCE, on the visitor's first build phase, and the ring goes as soon as any
     close up is opened or the phase ends. */
  var HINT_MS = 9000;
  var hintRingAt = 0, hintRingCell = -1, hintDone = false;
  /* the label plate the last frame really drew, for the hook */
  var hintLabBox = null;

  function armHintRing() {
    if (hintDone || hintRingAt || reducedMotion()) return;
    /* the visitor's board starts EMPTY, so there is no machine to ring when
       the act opens; the ring waits for the first one to exist and then marks
       it once for the whole visit */
    if (!S || act.name !== 'you' || S.over) return;
    /* ONE renderState for the whole search: the board at the moment the act
       opens is usually still empty, so this is retried per frame until the
       first machine really lands, and a per-cell renderState would be a
       hundred rebuilds a frame */
    var st = renderState(S), i, best = -1;
    for (i = 0; i < CELLS; i++) {
      if (st.piece[i] === PIECE_GUN) { best = i; break; }
    }
    if (best < 0) return;
    hintRingCell = best;
    hintRingAt = now();
  }

  function drawHintRing(t) {
    /* a frame that draws no label must not leave the last one's box standing */
    hintLabBox = null;
    /* the ring waits for a machine to exist: at the moment the act opens the
       board carries none, which is why arming it once at the start missed */
    if (!hintRingAt) armHintRing();
    if (!hintRingAt || hintRingCell < 0) return;
    if (loupe.on) { hintRingAt = 0; hintDone = true; return; }
    if (act.name !== 'you' || !S || S.over) { hintRingAt = 0; return; }
    /* s7.21 ruling 10: the ring and its label kept drawing over a live wave
       for 9 s after Done building. It belongs to the BUILD phase that armed it
       and clears at that phase's boundary. */
    if (S.phase !== 'build' || S.buildDone) { hintRingAt = 0; hintDone = true; return; }
    var age = now() - hintRingAt;
    if (age > HINT_MS) { hintRingAt = 0; hintDone = true; return; }
    var r = null;
    try { r = RAPI && RAPI.cellRect ? RAPI.cellRect(view, hintRingCell) : null; } catch (e) { r = null; }
    if (!r || !isFinite(r.x)) return;
    var pulse = reducedMotion() ? 0.6 : (0.45 + 0.25 * Math.sin(t / 380));
    ctx.save();
    ctx.strokeStyle = accent();
    ctx.globalAlpha = Math.max(0, Math.min(1, pulse)) * (1 - age / HINT_MS);
    ctx.lineWidth = 2;
    ctx.strokeRect(Math.round(r.x) + 1.5, Math.round(r.y) + 1.5,
                   Math.round(r.w) - 3, Math.round(r.h) - 3);
    ctx.globalAlpha = 1;
    ctx.font = '600 11px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    /* 2026-09-10, found on the dpr 2 phone while re-running the close-up lanes
       (s7.20 rulings 5 and 6). Two things were wrong with this label there.
       A finger cannot HOVER, and the page's own law is that a tap opens the
       close up on any device (s7.9 ruling 3b), so on a phone the label said to
       do the one thing that does not work. And the plate is centred on the
       cell, so a machine in the first column put it off the left edge of the
       screen: the money shot read "a catapult: hover it" with its start cut
       away. It now says what works on this device and is clamped inside the
       board. */
    var lab = touchFirst() ? 'a catapult: tap it' : 'a catapult: hover it';
    var w = ctx.measureText(lab).width + 12;
    var lx = r.x + r.w / 2 - w / 2;
    var lo = view ? view.ox : 0, hi = lo + (view ? (view.bw || 0) : 0);
    if (hi > lo + w) lx = Math.max(lo, Math.min(hi - w, lx));
    lx = Math.max(2, Math.min(Math.max(2, stripW() - w - 2), lx));
    /* s7.24 ruling 3: THE TAG NEVER DRAWS ON THE ART. Above its own cell is
       where the machine's own body stands (the sprite is two cells tall, which
       is the same fact ruling 8's hit target is about), and on a phone the
       ringed machine is usually at a gate mouth, so "above" was the gate wall
       itself: the dark judge photographed the tag over the wall art at the
       board's top left. It goes UNDER the cell, on the open ground the machine
       is standing on, and only goes back above when there is no room below. */
    var ly = Math.round(r.y + r.h + 3);
    var dr = drawnBoardRect();
    var botLim = dr ? (dr.y + dr.h - 16) : (cssH - 16);
    if (ly > botLim) ly = Math.round(r.y - 17);
    ctx.fillStyle = plateCol(0.88);
    ctx.fillRect(lx, ly, w, 15);
    ctx.fillStyle = ink(0.88);
    ctx.fillText(lab, lx + w / 2, ly + 12);
    ctx.restore();
    hintLabBox = { x: lx, y: ly, w: w, h: 15, text: lab };
  }

  /* ------------------------------------------------- the keep's health, once
     Ruling 8: two unlabelled bars for one keep. The renderer's meter is the
     board's own instrument and it stays; what it never had is a NAME and a
     NUMBER, so the page writes them beside it, mapped through the renderer's
     own source-to-screen arithmetic so the label cannot drift off the bar it
     labels. SEAM P12-S1 carries the second bar to the renderer. */
  /* ---- the keep readout (build spec v3 s7.21 ruling 6) --------------------
     It rendered as "eep 100 of 100" on a phone (its first letter off the LEFT
     edge of the page, because the only guard it had was board-relative and the
     board runs off the viewport), and where it did fit it sat ON the health
     meter it is the label for, with the Your turn status plate over the top.
     The geometry is MEASURED first and drawn last: the caption is measured in
     the same pass and lifts itself clear of this box, so nothing can be
     painted over the one number the game is scored on.

     ---- s7.22 ruling 6: THE READOUT RIDES WITH THE FRAME ------------------
     At the framed S = 2 wave the board's bottom bezel is outside the frame, so
     the renderer's meter, which is the number line this label names, was off
     screen while the label stood alone on the page background under the board.
     The pair is now ONE UNIT: while the meter is inside the drawn frame the
     label sits against it in a fixed CSS gap (a gap in SOURCE pixels grows
     with S, and at S = 2 it alone would break the 24 px bar), and when the
     meter is not drawn the page draws its OWN number line at the frame's
     bottom left with the label on the same plate. The keep's health is still
     shown once: the page's line exists only in the frames where the
     renderer's does not. */
  var KEEP_PAIR_GAP = 12;      /* css px between the label and its line */
  var KEEP_LINE_W = 104, KEEP_LINE_H = 10;
  var KEEP_PLATE_PAD = 6;

  /* the board pixels really on screen: the tile plate clipped to the blit */
  /* ---- s7.28 ruling 2: THE DRAWN FRAME, ASKED OF THE RENDERER -------------
     `boxes.board` is the tile plate and the frame is drawn OUTSIDE it, so a
     control cleared against the plate stands on the picture's own border (the
     phone Step chip was 17.5 px inside it in all three acts). The overhang is
     the renderer's bezel, so the renderer hands back the rect and the page
     never carries a constant of its own. Null when there is no view, and the
     caller then keeps the behaviour it had. */
  function frameRect() {
    if (!R || !R.frameRect || !view || view.fallback) return null;
    var f = null;
    try { f = R.frameRect(view); } catch (e) { f = null; }
    if (!f || !isFinite(f.x) || !isFinite(f.y) || !(f.w > 0) || !(f.h > 0)) return null;
    return f;
  }

  function drawnBoardRect() {
    var b = boxes.board;
    if (!b || !view) return null;
    var bx = view.ox, by = view.oy, bw = view.bw || 0, bh = view.bh || 0;
    var x0 = Math.max(b.x, bx), y0 = Math.max(b.y, by);
    var x1 = Math.min(b.x + b.w, bx + bw), y1 = Math.min(b.y + b.h, by + bh);
    if (!(x1 > x0 && y1 > y0)) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /* edge to edge, the larger of the two axis gaps: 0 when the two boxes touch
     or overlap, which is what "one unit" means for a probe */
  function boxGap(a, b) {
    if (!a || !b) return Infinity;
    var dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
    var dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
    return Math.max(dx, dy);
  }

  function keepNumberGeom(capBox) {
    /* an act that draws no readout has no handover to ease either: the clock
       is disarmed so re-entering one cannot fire a flight from a stale box */
    if (!S || !view || view.fallback || !RC) { keepEaseReset(); return null; }
    if (act.name === 'plans' || act.name === 'strangers' || act.name === 'fine') {
      keepEaseReset(); return null;
    }
    var bot = RC.PLATE_BOT, bez = RC.BEZ;
    if (!isFinite(bot)) return null;
    var night = !isLight();
    var bx = night ? 18 : 32, bw = night ? 132 : 128;
    var m0 = srcToCss(bez + bx, bez + bot - 16 - 3);
    var m1 = srcToCss(bez + bx + bw, bez + bot - 16 + 9);
    if (!m0 || !m1) return null;
    var hp = Math.max(0, Math.round(keepHp(S)));
    var txt = 'Keep ' + hp + ' of ' + HP_KEEP;
    var w;
    ctx.save();
    ctx.font = '600 12px "Source Sans 3", system-ui, sans-serif';
    w = Math.ceil(ctx.measureText(txt).width) + 12;
    ctx.restore();
    var h = 18;
    var meter = { x: m0.x, y: m0.y, w: Math.max(1, m1.x - m0.x),
                  h: Math.max(1, m1.y - m0.y) };
    var strip = Math.round(stripW());
    var lo = 8, hi = strip - 8 - w;
    if (hi < lo) hi = lo;
    var top = (view.topPad || 0) + 2;
    var dr = drawnBoardRect();
    /* is the renderer's own meter really painted where the visitor can see it?
       The blit is the drawn frame, so a meter outside it is a meter outside the
       source window the camera framed. */
    var onFrame = !!dr &&
      meter.x >= view.ox - 0.5 && meter.y >= view.oy - 0.5 &&
      meter.x + meter.w <= view.ox + (view.bw || 0) + 0.5 &&
      meter.y + meter.h <= view.oy + (view.bh || 0) + 0.5 &&
      meter.x >= -0.5 && meter.y >= -0.5 &&
      meter.x + meter.w <= strip + 0.5 && meter.y + meter.h <= cssH + 0.5;

    /* ---- the two resting places, both measured every frame ----------------
       s7.24 ruling 9. The readout used to CUT between them: 206 to 243 px on a
       desktop and 77 to 101 on a phone, in a single 13 to 31 ms frame, twice a
       game, on a page whose whole design language is ease-or-dwell (the round 4
       auditor's first nit, photographed). Both places are computed here so the
       frames in between can carry the readout from one to the other. */
    var x, y, line = null, plate = null, own = false;

    /* (a) beside the bar it labels, in a fixed CSS gap so the pair is as tight
       at S = 2 as it is at rest */
    var lx = Math.round(meter.x + meter.w + KEEP_PAIR_GAP);
    var ly = Math.round(meter.y + meter.h / 2 - h / 2);
    if (lx > hi) lx = hi;
    if (lx < lo) lx = lo;
    /* clear of the meter: if the viewport clamp slid the label back over the
       bar, it goes ABOVE the bar instead of on it, which keeps the pair
       adjacent on the other axis */
    if (lx < meter.x + meter.w + 2 && lx + w > meter.x &&
        ly < meter.y + meter.h && ly + h > meter.y) {
      lx = Math.max(lo, Math.min(hi, Math.round(meter.x)));
      ly = Math.round(meter.y - h - 4);
    }
    /* and clear of the CAPTION's own band, measured before this: the viewport
       clamp above is what used to park the readout under the caption during a
       framed wave, and the caption then lifted itself off it in one frame
       (s7.21 rulings 2, 6 and 9). The readout moves instead, which nobody
       sees, and the caption's own fallback lift then never fires. */
    if (capBox && lx < capBox.x + capBox.w && lx + w > capBox.x &&
        ly < capBox.y + capBox.h && ly + h > capBox.y) {
      ly = Math.round(capBox.y - h - 4);
    }
    if (ly < top) ly = top;
    if (ly + h > cssH - 4) ly = cssH - 4 - h;

    /* (b) the meter is off frame, so the pair stands together at the frame's
       bottom left, on one plate, inside the viewport and clear of the page's
       own bottom chrome (the corner buttons, the chat bar, the act strip and
       the bar block all live down there) */
    var pw = Math.max(w, KEEP_LINE_W + KEEP_PLATE_PAD * 2);
    var ph = KEEP_PLATE_PAD + h + 2 + KEEP_LINE_H + KEEP_PLATE_PAD;
    /* ---- s7.28 ruling 6: ONE HOME PER ACT ---------------------------------
       This home was built from the DRAWN board and from whatever else the
       frame happened to have painted, so it travelled: in Your turn with the
       reader's bars up, `barsDrawn` (a plate in the band ABOVE the board on a
       desktop) collapsed the floor to 134 px, the clamp then parked the
       readout at the top pad, and the dark judge watched "Keep 72 of 100"
       move from the board's bottom left corner to its top left and back,
       twice a game. A readout that appears in two corners reads as a glitch
       and not as a choice.

       The home is now the RESTING picture's own bottom left plus the page's
       own furniture, all of which hold still inside an act, so the framed
       wave cannot move it. Anything that would COVER it is answered by
       fading (`dim` below), never by moving, which is this ruling's own
       instruction. */
    var homeX = (frameLeftRest > 0) ? frameLeftRest : (dr ? dr.x : (view.ox || 0));
    /* s7.29 ruling 1: the badge clears the DRAWN frame rather than standing
       on it. The home was the picture's left edge plus eight, and the bezel
       is nine to eleven css pixels wide at the scales this page runs, so the
       plate was painted across the frame's own left band in every frame of
       every act; with the band put back during a framed wave it read as a
       plate cut by the border. Measured off the resting picture, which holds
       still inside an act, so s7.28 ruling 6's one home per act is kept. */
    var px = Math.round(Math.max(8, Math.min(strip - 8 - pw,
                                             homeX + Math.ceil(frameBezRest) + 6)));
    var floor = cssH - 8;
    if (boxes.corner) floor = Math.min(floor, boxes.corner.y - 8);
    if (boxes.chat) floor = Math.min(floor, boxes.chat.y - 8);
    if (boxes.actbar && boxes.actbar.height) floor = Math.min(floor, boxes.actbar.top - 8);
    var footRest = phone() ? picBotRest : frameBotRest;
    /* s7.29 ruling 1: and the same clearance at the foot, for the same reason */
    if (footRest > 0) floor = Math.min(floor, footRest - Math.ceil(frameBezRest) - 6);
    else if (dr) floor = Math.min(floor, dr.y + dr.h - 6);
    var py = Math.round(floor - ph);
    if (py < top) py = top;
    if (py + ph > cssH - 4) py = cssH - 4 - ph;

    /* ---- which one is standing, and the flight between them ---------------
       The FORM in flight is always the page's own plate, because the other
       form's number line IS the renderer's meter, which does not travel: a
       label easing away from a meter that stays put would break s7.22 ruling
       6's own bar (the pair within 24 px) for every frame of the ease. So the
       plate carries the pair across and the meter takes the label back at the
       far end, where the two agree about where the label goes. */
    /* ---- s7.30 ruling 2: THE READOUT STAYS PUT DURING A PHONE WAVE ---------
       Ship gate round 8 (audit M2, verify M3): on the phone the framed window
       (S 1.75 there, panning across the gates) carried the renderer's meter
       in and out of the picture as the fight moved, and this
       handover had no dwell, so the readout flew about 220 px between its
       home and the meter 10.3 to 20.8 times a minute, the shortest gap 116 ms,
       and the label rode the meter's pan in between (47 movement episodes in
       a 75 s ride against round 7's 3). Of the two remedies the ruling offers
       this is the smaller: while the phone's follow camera is engaged the
       readout keeps its own plate at its one home, so the only handovers are
       the engage and the release, which is what the desktop already reads
       (3 movement episodes in the same 75 s ride). A dwell would have kept the
       label riding the pan whenever the meter was in. */
    var wantOwn = !onFrame || following();   /* s7.32 addendum 3 item 1: every device */
    var anchorX = wantOwn ? px : (lx - KEEP_PLATE_PAD);
    var anchorY = wantOwn ? py : (ly - KEEP_PLATE_PAD);
    var fl = keepFlight(wantOwn, anchorX + KEEP_PLATE_PAD, anchorY + KEEP_PLATE_PAD);
    if (!wantOwn && !fl) {
      x = lx; y = ly; line = meter;
    } else {
      own = true;
      var ax = anchorX, ay = anchorY;
      if (fl) {
        ax = Math.round(Math.max(8, Math.min(strip - 8 - pw, anchorX + fl.dx)));
        ay = Math.round(Math.max(top, Math.min(cssH - 4 - ph, anchorY + fl.dy)));
      }
      plate = { x: ax, y: ay, w: pw, h: ph };
      x = ax + KEEP_PLATE_PAD;
      y = ay + KEEP_PLATE_PAD;
      line = { x: ax + KEEP_PLATE_PAD, y: y + h + 2,
               w: pw - KEEP_PLATE_PAD * 2, h: KEEP_LINE_H };
    }
    /* ---- s7.28 ruling 6: THE BADGE FADES, IT DOES NOT MOVE ----------------
       Where the home would be covered the readout dims to KEEP_DIM and comes
       back, which is a change a visitor reads as the page getting out of the
       way rather than as the number jumping corners. Only the page's own home
       is dimmed: the form beside the renderer's meter is part of the picture
       and is measured clear of the caption by captionClear already. */
    var dim = 1;
    if (own && plate) {
      if (barsDrawn && rectOverlap(plate, barsDrawn) > 0) dim = KEEP_DIM;
      else if (capBox && rectOverlap(plate, capBox) > 0) dim = KEEP_DIM;
    }
    return { x: x, y: y, w: w, h: h, txt: txt, hp: hp, meter: meter,
             line: line, own: own, plate: plate, flight: !!fl, dim: dim,
             /* the home itself, so a probe can assert it never moves */
             home: { x: px, y: py, w: pw, h: ph } };
  }

  /* s7.28 ruling 6: what a covered badge dims to */
  var KEEP_DIM = 0.35;

  /* the handover's own clock (s7.24 ruling 9). It is armed by the frame the
     renderer's meter leaves or re-enters the blit, and it measures the delta
     from the label box the LAST frame really drew, so an interrupted flight
     starts from wherever the readout actually is. */
  var KEEP_EASE_MS = 280;
  var keepEase = { own: null, dx: 0, dy: 0, at: -1e9 };
  function keepEaseReset() { keepEase.own = null; keepEase.at = -1e9; }
  /* s7.26 ruling 11: is the readout's handover in flight this frame */
  function keepFlightLive() { return (now() - keepEase.at) < KEEP_EASE_MS; }

  function keepFlight(wantOwn, destX, destY) {
    var t = now();
    if (keepEase.own === null) { keepEase.own = wantOwn; keepEase.at = -1e9; return null; }
    if (keepEase.own !== wantOwn) {
      keepEase.own = wantOwn;
      if (keepNumBox && !reducedMotion()) {
        keepEase.dx = keepNumBox.x - destX;
        keepEase.dy = keepNumBox.y - destY;
        keepEase.at = t;
      } else { keepEase.at = -1e9; }
    }
    var p = (t - keepEase.at) / KEEP_EASE_MS;
    if (!(p >= 0) || p >= 1) return null;
    var k = 1 - bandEase(p);
    if (Math.abs(keepEase.dx * k) < 0.5 && Math.abs(keepEase.dy * k) < 0.5) return null;
    return { dx: keepEase.dx * k, dy: keepEase.dy * k, p: p };
  }

  function drawKeepNumber(g) {
    /* the hook reports what a frame really drew, so a frame that draws nothing
       must not leave the last one's box standing */
    keepNumBox = null;
    if (!g) return;
    ctx.save();
    /* s7.28 ruling 6: a covered home dims rather than moving */
    if (g.dim && g.dim < 1) ctx.globalAlpha = g.dim;
    ctx.font = '600 12px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = plateCol(0.88);
    /* s7.29 ruling 2: the plate the frame really filled, whichever form the
       readout took, so a suite can assert the number is never grey text on
       live terrain (the dark lane's phone reading) */
    var back = g.plate ? g.plate : { x: g.x, y: g.y, w: g.w, h: g.h };
    ctx.fillRect(back.x, back.y, back.w, back.h);
    ctx.fillStyle = ink(0.92);
    ctx.fillText(g.txt, g.x + 6, g.y + g.h / 2);
    /* the page's own number line, drawn only in the frames where the
       renderer's meter is not on screen (s7.22 ruling 6). Monochrome, like
       every other instrument on this page: a track and the share of it the
       keep still has. */
    if (g.own && g.line) {
      var f = Math.max(0, Math.min(1, g.hp / HP_KEEP));
      ctx.fillStyle = ink(0.18);
      ctx.fillRect(g.line.x, g.line.y, g.line.w, g.line.h);
      ctx.fillStyle = ink(0.7);
      ctx.fillRect(g.line.x, g.line.y, Math.max(1, Math.round(g.line.w * f)), g.line.h);
    }
    ctx.restore();
    keepNumBox = { x: g.x, y: g.y, w: g.w, h: g.h, hp: g.hp, own: !!g.own,
                  /* s7.28 ruling 6: the home this act settled on, and the
                     dim a covered home is drawn at */
                  home: g.home || null, dim: (typeof g.dim === 'number') ? g.dim : 1,
                  line: g.line ? { x: g.line.x, y: g.line.y, w: g.line.w, h: g.line.h } : null,
                  plate: g.plate ? { x: g.plate.x, y: g.plate.y, w: g.plate.w, h: g.plate.h } : null,
                  /* s7.29 ruling 2 */
                  backing: { x: back.x, y: back.y, w: back.w, h: back.h },
                  gap: g.line ? Math.round(boxGap({ x: g.x, y: g.y, w: g.w, h: g.h }, g.line)) : null };
  }
  var keepNumBox = null;

  /* ---- who built what, in colour (build spec v3 s7.21 ruling 8) ------------
     The visitor's pieces are drawn in the accent and the partner's in the
     gold, which is the renderer's own P.own('a') / P.own('b') pair, and at the
     1.4 css px per sprite pixel the board runs at, nothing on the page said
     so. The row sits UNDER the board, in Your turn only, on its own plate so
     it reads over any scene. The two inks are the same literals the renderer
     emits, so the swatch and the piece cannot be different colours. */
  var seatLegBox = null;
  /* PIN R-S8 CONSUMED (build spec v3 s7.24 ruling 5, SEAM I1M-S1 closed from
     this side): the ink a legend swatch is drawn in is the RENDERER'S own
     record for this theme, so the swatch and the block it stands for cannot be
     different colours. The four literals below are the fallback for a renderer
     without the pin and are the same values `P.own` emits. */
  function seatInk(seat) {
    if (R && R.seatInk) {
      try {
        var rec = R.seatInk(seat);
        if (rec && rec.swatch) return rec.swatch;
        if (rec && rec.ink) return rec.ink;
      } catch (e) { /* fall through to the literals */ }
    }
    if (seat === 'a') return isLight() ? '#34568a' : '#82a6cc';
    return isLight() ? '#755a1e' : '#c8a45c';
  }
  /* the swatch is the renderer's own block in miniature (PIN R-S8), so the
     legend and the board are drawn by ONE piece of code; a renderer without
     the painter gets the flat square the page always drew */
  function drawSeatSwatch(box, seat) {
    if (R && R.paintSeatSwatch) {
      try {
        if (R.paintSeatSwatch(ctx, box, seat, {})) return;
      } catch (e) { /* fall through */ }
    }
    ctx.fillStyle = seatInk(seat);
    ctx.fillRect(box.x, box.y, box.w, box.h);
  }

  function seatLegendWanted() {
    return act.name === 'you' && !!S && !!view && !view.fallback && !modalOpen();
  }
  var SEAT_LEG_H = 18;
  /* s7.26 ruling 5: the swatches are >= 12 px. They were 11, and the light
     reduced-motion judge could not tell the two seats apart at 1x. */
  var SEAT_SW = 12;

  /* ---- s7.26 ruling 5: THE CAPTION ROW'S OWN SLOTS ------------------------
     Three things want the strip beside the caption plate: the Step control
     (reduced motion), the seat legend (Your turn) and, since ruling 2, the
     budget chip. Wave 1q gave the Step control and the legend the SAME answer
     ("the room the plate leaves on the left") and they were drawn on top of
     each other: the light judge photographed "[blue] you [gold] your" with the
     Step button standing on the rest of the word.

     So the row is DEALT once per frame, before anything in it is drawn, in one
     fixed order, and a claim that does not fit is refused rather than
     overlapped. The claims run inward out from the plate, so the control that
     belongs to the caption sits beside it and the legend sits outside that. */
  var capRow = null;
  var capRowStep = null, capRowLeg = null, capRowBud = null;

  function capRowClaimLeft(w, h) {
    if (!capRow || !(w > 0)) return null;
    var x = Math.round(capRow.lx - w);
    if (x < capRow.lmin) return null;
    capRow.lx = x - 10;
    return { x: x, y: Math.round(capRow.y + (capRow.h - h) / 2), w: w, h: h };
  }

  function capRowClaimRight(w, h) {
    if (!capRow || !(w > 0)) return null;
    var x = Math.round(capRow.rx);
    if (x + w > capRow.rmax) return null;
    capRow.rx = x + w + 10;
    return { x: x, y: Math.round(capRow.y + (capRow.h - h) / 2), w: w, h: h };
  }

  /* the legend's own width, measured from the same font it is drawn in */
  function seatLegendW() {
    ctx.save();
    ctx.font = '600 11px "Source Sans 3", system-ui, sans-serif';
    var w = 16 + SEAT_SW + 5 + ctx.measureText('you').width + 14 +
            SEAT_SW + 5 + ctx.measureText('your partner').width;
    ctx.restore();
    return Math.round(w);
  }

  function budgetChipText() {
    return 'Budget ' + budgetLeft();
  }
  function budgetChipWanted() {
    return !phone() && act.name === 'you' && !!S && !gameOver() &&
           !!view && !view.fallback && !modalOpen();
  }
  function budgetChipW() {
    ctx.save();
    ctx.font = '600 12px "Source Sans 3", system-ui, sans-serif';
    var w = Math.ceil(ctx.measureText(budgetChipText()).width) + 20;
    ctx.restore();
    return w;
  }

  function capRowPlan(capG) {
    capRow = null; capRowStep = null; capRowLeg = null; capRowBud = null;
    if (phone() || galleryAct() || !capG || !capG.box) return;
    var b = capG.box;
    capRow = { y: b.y, h: b.h, lx: b.x - 10, rx: b.x + b.w + 10,
               lmin: 6, rmax: Math.round(stripW() - 6) };
    if (stepEl && !stepEl.hidden) {
      var r = null;
      try { r = stepEl.getBoundingClientRect(); } catch (e) { r = null; }
      capRowStep = capRowClaimLeft(Math.round((r && r.width) ? r.width : 56),
                                   Math.round((r && r.height) ? r.height : 30));
    }
    if (seatLegendWanted()) capRowLeg = capRowClaimLeft(seatLegendW(), SEAT_LEG_H);
    /* s7.26 ruling 2: the board shows the budget on the desktop too. It takes
       the right of the row, so it can never be the thing that crowds the
       legend off its own slot. */
    if (budgetChipWanted()) capRowBud = capRowClaimRight(budgetChipW(), 22);
  }

  /* s7.26 ruling 2: "Budget N" on the board, the phone act bar's own chip in
     the desktop's caption row, because a visitor who cannot see the panel's
     line has no other way to know what they have left. */
  function drawBudgetChip() {
    if (!capRowBud) return;
    var r = capRowBud, low = budgetLeft() < COST_WALL;
    ctx.save();
    ctx.font = '600 12px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = plateCol(0.82);
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = low ? WARM : accent();
    ctx.fillRect(r.x, r.y, 3, r.h);
    ctx.fillStyle = ink(0.92);
    ctx.fillText(budgetChipText(), r.x + 11, r.y + r.h / 2 + 1);
    ctx.restore();
  }

  function drawSeatLegend(capG) {
    seatLegBox = null;
    if (!seatLegendWanted()) return;
    ctx.save();
    ctx.font = '600 11px "Source Sans 3", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    var a = 'you', bl = 'your partner';
    var sw = SEAT_SW, gap = 5, pad = 8, mid = 14;
    var w = pad * 2 + sw + gap + ctx.measureText(a).width + mid +
            sw + gap + ctx.measureText(bl).width;
    w = Math.round(w);
    var cap = capG && capG.box, b = boxes.board, x = -1, y = -1;
    if (slotNow && slotNow.legend) {
      /* a phone: the first row of the room under the board */
      y = slotNow.legend.y;
      x = Math.round(stripW() / 2 - w / 2);
    } else if (capRowLeg) {
      /* a desktop: the slot the caption row DEALT it (s7.26 ruling 5), which
         the Step control has already been kept out of */
      x = capRowLeg.x; y = capRowLeg.y; w = capRowLeg.w;
    } else if (cap && cap.x - w - 10 >= 8) {
      x = Math.round(cap.x - w - 10);
      y = Math.round(cap.y + (cap.h - SEAT_LEG_H) / 2);
    } else if (b) {
      var lo = b.y + b.h + 6;
      /* s7.30 ruling 1: under the phone's follow camera the row is measured
         from the drawn PICTURE's outer foot, not the tile plate's (the frame
         and the rows under the plate are drawn below it). Lifting the framed
         phone picture clear of the caption opened a gap the plate's foot said
         was free, and the legend was painted across the picture's bottom
         frame band in the framed frames of Your turn (i1v/verify/bandcap.js). */
      if (phone() && following() && view && !view.fallback) {
        lo = Math.max(lo, (view.oy || 0) + (view.bh || 0) + 6);
      }
      var hi = cap ? (cap.y - SEAT_LEG_H - 4) : (cssH - 30);
      if (hi >= lo) { y = Math.round(lo); x = Math.round(stripW() / 2 - w / 2); }
    }
    if (x < 0 || y < 0) { ctx.restore(); return; }
    if (x < 6) x = 6;
    if (x + w > stripW() - 6) x = Math.max(6, Math.round(stripW() - 6 - w));
    ctx.fillStyle = plateCol(0.82);
    ctx.fillRect(x, y, w, SEAT_LEG_H);
    var cx0 = x + pad, cy0 = y + SEAT_LEG_H / 2;
    drawSeatSwatch({ x: cx0, y: Math.round(cy0 - sw / 2), w: sw, h: sw }, 'a');
    ctx.fillStyle = ink(0.92);
    ctx.fillText(a, cx0 + sw + gap, cy0 + 1);
    cx0 += sw + gap + ctx.measureText(a).width + mid;
    drawSeatSwatch({ x: cx0, y: Math.round(cy0 - sw / 2), w: sw, h: sw }, 'b');
    ctx.fillStyle = ink(0.92);
    ctx.fillText(bl, cx0 + sw + gap, cy0 + 1);
    ctx.restore();
    seatLegBox = { x: x, y: y, w: w, h: SEAT_LEG_H };
  }

  function drawBadGhost() {
    if (ghostBad < 0) return;
    /* ruling 2 again, and this is the branch that covers a GAME ENDING under a
       parked pointer: the marker only means something while a build phase this
       visitor owns is live, so it clears itself the moment that stops. */
    if (ghostKind(ghostBad, selPiece) === 0) { ghostBad = -1; return; }
    if (!RAPI || !RAPI.cellRect || !view || view.fallback) return;
    var r = null;
    try { r = RAPI.cellRect(view, ghostBad); } catch (e) { r = null; }
    if (!r || !isFinite(r.x) || r.w < 2 || r.h < 2) return;
    if (R && R.paintGhost) { R.paintGhost(ctx, r, false); return; }
    var x = r.x + 2, y = r.y + 2, w = r.w - 4, h = r.h - 4, m = Math.min(w, h) * 0.32;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = 'rgba(196,87,74,0.20)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = WARM;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    ctx.beginPath();
    ctx.moveTo(x + w / 2 - m, y + h / 2 - m);
    ctx.lineTo(x + w / 2 + m, y + h / 2 + m);
    ctx.moveTo(x + w / 2 + m, y + h / 2 - m);
    ctx.lineTo(x + w / 2 - m, y + h / 2 + m);
    ctx.stroke();
    ctx.restore();
  }

  function handleCell(cell) {
    if (act.name !== 'you' || !S) return;
    if (S.phase === 'build') placePiece(cell, selPiece);
    /* s7.24 ruling 10: A MISSED CALL-THE-SHOT IS ANSWERED. markFocus returned
       false in silence when no attacking walker was within three cells, and
       three of three round 4 judges pressed the verb the page invites in every
       wave and got nothing back. A click during a wave is never answered with
       a budget error either: this branch is the only one a wave click reaches,
       and it cannot reach placePiece. */
    else if (!markFocus(cell) && !S.over && S.phase === 'resolve') {
      setStatus(tapWord() === 'Tap'
        ? 'Nothing to call the shot on there. Tap a walker that has stopped.'
        : 'Nothing to call the shot on there. Click a walker that has stopped.',
        { force: true });
    }
  }

  /* ----------------------------------------------------------- the keyboard */

  function moveCursor(dx, dy) {
    var c = cursorCell >= 0 ? cursorCell : 0;
    var x = Math.max(0, Math.min(COLS - 1, cx(c) + dx));
    var y = Math.max(0, Math.min(ROWS - 1, cy(c) + dy));
    cursorCell = cellOf(x, y);
  }

  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    dismissEndMark();
    /* Escape runs BEFORE the control early return below: clicking a button
       used to disarm Escape on /voyage/ */
    if (e.key === 'Escape') { escapeLadder(e); return; }
    /* A focused control owns only the keys it actually operates on: handing
       it every key left the page's letter hotkeys dead after one click on a
       button, which is the same bug the site sweep fixed on /fourinarow/. */
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    /* the fine print is a scrolling reading card: while the focus is inside
       it, the arrows belong to it and not to the board cursor */
    var fe = fineEl();
    if (fe && !fe.hidden && e.target && fe.contains(e.target)) return;
    if ((tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY' || tag === 'LABEL') &&
        (e.key === ' ' || e.key === 'Enter')) return;
    if (window.GadgetUI && GadgetUI.isTyping && GadgetUI.isTyping(e)) return;
    armAudio();
    var k = e.key;
    if (k === 'ArrowLeft') { moveCursor(-1, 0); e.preventDefault(); return; }
    if (k === 'ArrowRight') { moveCursor(1, 0); e.preventDefault(); return; }
    if (k === 'ArrowUp') { moveCursor(0, -1); e.preventDefault(); return; }
    if (k === 'ArrowDown') { moveCursor(0, 1); e.preventDefault(); return; }
    if (k === 'Enter') { handleCell(cursorCell); e.preventDefault(); return; }
    if (k === 'Backspace' || k === 'Delete') { removeAt(cursorCell); e.preventDefault(); return; }
    if (k === 'w' || k === 'W') { selectPiece(PIECE_WALL); return; }
    if (k === 't' || k === 'T' || k === 'm' || k === 'M') { selectPiece(PIECE_GUN); return; }
    if (k === 's' || k === 'S') { setMuted(audioOn); return; }
  }

  /* Staged, in this order (D5 7.1): cancel an in-flight placement gesture,
     then close the fine print card, then leave Take a row, then drop the act
     back to idle. The walkthrough is not a rung: its own card eats Escape at
     capture and the page never sees that press. */
  function escapeLadder(e) {
    if (pointerDown) { pointerDown = false; dragPid = -1; dragPan = false; e.preventDefault(); return; }
    if (closeHelp()) { e.preventDefault(); return; }
    if (tourOn) { endTour('skipped'); e.preventDefault(); return; }
    if (loupe.on && loupe.src !== 'tour') { closeLoupeLine(); e.preventDefault(); return; }
    if (FX.focusMark >= 0) { FX.focusMark = -1; e.preventDefault(); return; }
    if (act.name === 'fine') { leaveFine(); e.preventDefault(); return; }
    if (rowJob) { cancelRow(); e.preventDefault(); return; }
    if (act.sub !== 'idle') { act.sub = 'idle'; e.preventDefault(); }
  }

  function selectPiece(p) {
    holdSoundHint();          /* s7.29 ruling 5: the game line wins */
    selPiece = p;
    syncPieceButtons();
    playSound('ui-tick', {});
    legalBand = null;
    /* ruling 8: picking a piece CONFIRMS. Judges pressed Wall and nothing on
       the page changed, so they pressed it again. The cost rides with it
       because that is the number that decides whether the next tap can land. */
    var n = (p === PIECE_GUN) ? COST_GUN : COST_WALL;
    var name = (p === PIECE_GUN) ? 'Catapult' : 'Wall';
    /* s7.27 ruling 3 (SEAM R2R-S2): the sentence used to count the tiles
       ("231 tiles are lit for it."), and since s7.26 ruling 4 made the legal
       region ONE boundary nothing on the screen counts tiles any more. It
       names the area the boundary draws instead, which is what the visitor is
       looking at. */
    var band = legalCells();
    setStatus(name + ' armed, ' + n + ' each.' +
              (band && band.length ? ' The lit area shows where it may build.' : ''),
              { force: true });
  }

  function syncPieceButtons() {
    var pairs = [['kit-piece-wall', 'kit-piece-gun'], ['kit-bar-wall', 'kit-bar-gun']];
    var i, w, g;
    for (i = 0; i < pairs.length; i++) {
      w = byId(pairs[i][0]); g = byId(pairs[i][1]);
      if (w) {
        w.classList.toggle('kit-seg--on', selPiece === PIECE_WALL);
        w.setAttribute('aria-pressed', selPiece === PIECE_WALL ? 'true' : 'false');
        w.textContent = 'Wall, ' + COST_WALL;
      }
      if (g) {
        g.classList.toggle('kit-seg--on', selPiece === PIECE_GUN);
        g.setAttribute('aria-pressed', selPiece === PIECE_GUN ? 'true' : 'false');
        g.textContent = 'Catapult, ' + COST_GUN;
      }
    }
  }

  /* ------------------------------------------------------------ the drawing */

  /* ---- the text-run ledger (build spec v3 s7.21 ruling 4's instrument) -----
     The ruling asks for a suite that asserts NO TWO TEXT RUNS ON THE BOARD
     SHARE PIXELS, in any act and any walkthrough step. Auditing two dozen
     draw sites by hand would only prove that the sites somebody remembered are
     clear, so the page records what the CANVAS really painted: fillText and
     strokeText are wrapped while a probe asks for it, and every run is stored
     with the tight box its glyphs occupy (measureText's own actual bounding
     box, which already accounts for the current textAlign and textBaseline).
     It records the renderer's page-context text too, which is the point.
     Off by default; when it is off nothing is wrapped and nothing is stored. */
  var textRecOn = false, textRec = null, textLast = null, textOrig = null;

  /* ---- the open phone panel's rect, which no canvas text may enter ---------
     Build spec v3 s7.24 ruling 1. Both round 4 judges read the caption plate
     and the seat legend THROUGH the expanded phone panel: text under text. The
     panel is opaque now, and this is the other half the ruling names, because
     opacity is a property of a stylesheet and the bar is about what the canvas
     paints. It runs through the same wrapper the text ledger uses, so it covers
     the RENDERER's own runs as well as this page's without a renderer change,
     and it is installed only while the mask is really wanted (a phone with the
     panel expanded), which is the one state it costs anything in. */
  var hudMask = null;
  var hudMaskSkips = 0;

  function hudMaskRect() {
    if (!panelOpen || !phone()) return null;
    var p = boxes.panel || rectOf('kit-panel');
    if (!p || !(p.w > 0 && p.h > 0)) return null;
    return { x: p.x - 1, y: p.y - 1, w: p.w + 2, h: p.h + 2 };
  }

  function textWrap() {
    if (textOrig || !ctx) return;
    textOrig = { fill: ctx.fillText, stroke: ctx.strokeText };
    var grab = function (fn) {
      return function (s, x, y) {
        var box = null;
        if ((textRec || hudMask) && s !== null && s !== undefined && String(s) !== '') {
          try {
            var m = this.measureText(String(s));
            var l = isFinite(m.actualBoundingBoxLeft) ? m.actualBoundingBoxLeft : 0;
            var r = isFinite(m.actualBoundingBoxRight) ? m.actualBoundingBoxRight : m.width;
            var a = isFinite(m.actualBoundingBoxAscent) ? m.actualBoundingBoxAscent : 10;
            var d = isFinite(m.actualBoundingBoxDescent) ? m.actualBoundingBoxDescent : 3;
            if (l + r > 0 && a + d > 0) {
              box = { t: String(s), x: x - l, y: y - a, w: l + r, h: a + d,
                      font: this.font, act: act.name };
            }
          } catch (e) { /* a probe may never cost the page a frame */ }
        }
        if (box && hudMask && rectOverlap(box, hudMask) > 0) { hudMaskSkips++; return; }
        if (box && textRec) textRec.push(box);
        return fn.apply(this, arguments);
      };
    };
    ctx.fillText = grab(textOrig.fill);
    ctx.strokeText = grab(textOrig.stroke);
  }

  function paint(t) {
    if (!ctx || !cv || !view) return;
    /* ruling 1: the mask is decided once per frame, before anything is drawn */
    hudMask = hudMaskRect();
    if (hudMask) textWrap();
    if (textRecOn) textRec = [];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    /* the renderer's view is in CSS pixels and it paints through this
       transform, so it goes on BEFORE the frame, not after it */
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var gallery = (act.name === 'strangers' || act.name === 'plans');
    if (R && R.frame && S && !gallery && !view.fallback) {
      try { R.frame(ctx, view, renderState(S), renderFx(t), t); }
      catch (e) { lastErr = 'frame: ' + (e && e.message); }
      drawFrameEdges();
    }

    /* s7.21 ruling 4: the caption's dwell is advanced and its plate MEASURED
       before the galleries lay themselves out, because a gallery now stops at
       the caption's own top edge. Nothing in either measurement reads a
       gallery, so the dependency runs one way and cannot oscillate. The keep
       readout is measured first for the same reason: the caption lifts itself
       clear of it (ruling 6). */
    captionPump();
    /* the caption's NATURAL box first, then the readout measured clear of it,
       then the caption again with the readout's box as a fallback guard: the
       dependency runs one way and neither can chase the other (s7.21 r2/6/9) */
    var capNat = gallery ? null : captionGeom(null);
    var keepG = gallery ? null : keepNumberGeom(capNat && capNat.box);
    var capG = capNat ? captionClear(capNat, keepG) : captionGeom(null);
    capTopY = capG.box ? capG.box.y : (cssH - (view.botPad || 0) - 12);
    /* s7.26 ruling 5: the caption row's slots are dealt ONCE, here, before
       anything that stands in it is drawn or placed */
    capRowPlan(capG);

    if (act.name === 'strangers' && FX.grid) drawGrid();
    else if (act.name === 'plans' && FX.plans) drawPlans();
    if (act.name === 'reader') drawFlipTick();
    if (!gallery) {
      drawLegalBand();
      drawBadGhost();
      drawHintRing(t);
      drawKeepNumber(keepG);
      drawEndMark();
    }
    /* the caption strip and the honesty plate are MEASURED here and painted at
       the end, so the close up between them can be placed clear of both (s7.10
       ruling 4). Neither measurement reads the close up, so the dependency
       runs one way and the placement cannot oscillate frame to frame.
       s7.17 ruling 2 measures the room UNDER the caption in the same pass, and
       for the same reason: the bars and the close up are placed into it, so it
       has to be known before either of them is drawn. */
    plateRect = verifyPlateGeom(capG.top);
    plateAvoid = null;
    slotPlan(capG);
    /* this act has now measured the room under its own board at least once
       (s7.22 ruling 7); capped so a long session cannot overflow it */
    if (slotFrames < 8) slotFrames++;
    applyCapcard();
    if (FX.bars) drawBars(); else barsDrawn = null;
    if (!gallery && S) { drawLoupe(); drawInset(); tourLoupeAim(); drawMachineLoupe(); }
    else loupe.box = null;
    if (!R || (!S && !gallery)) overlayPlate(honestMissing());
    drawSeatLegend(capG);
    drawBudgetChip();
    drawCaption(capG);
    drawVerifyPlate(plateRect);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (textRecOn) { textLast = textRec; textRec = null; }
    /* s7.24 ruling 7: the Step control rides the caption plate, which this
       frame has just measured. Only a plate that really MOVED costs a style
       write, so a resting board writes nothing. */
    syncStepPlace();
  }

  var stepKey = '';
  function syncStepPlace() {
    if (!stepEl || stepEl.hidden) { stepKey = ''; return; }
    var c = capDrawn;
    var k = c ? (Math.round(c.x) + ',' + Math.round(c.y) + ',' + Math.round(c.w)) : '-';
    if (k === stepKey) return;
    stepKey = k;
    syncStepBtn();
  }

  /* ------------------------------------------------------------- phone views
     Two of them, and each answers one thing a small screen takes away.
     THE LOUPE, build phase only: the tile under the finger is 40 px across on
     a 390 px board, so the cursor cell and its neighbours are blitted at 3x in
     a corner, straight off the renderer's own source canvas. Nothing is
     redrawn, so the loupe cannot disagree with the board.
     THE INSET, wave only: the follow camera gives up the whole board, and the
     inset gives it back as the same R.fortress tile the grid uses, with the
     camera's own window marked on it. */

  function loupeOn() {
    return phone() && !!S && S.phase === 'build' && act.name === 'you' &&
           cursorCell >= 0 && !!R && !!R.source && !view.fallback &&
           phoneLoupeCell() >= 0;
  }

  /* Build spec v3 s7.19 ruling 4: the phone close-up SHOWS A MACHINE OR
     NOTHING. Two ship-gate lanes photographed it as "grey horizontal streaks
     with two white bracket shapes" and "an uncaptioned zoom of empty sand",
     because it magnified whatever tile the finger was over, which on a board
     of open ground is sand. It now takes the nearest machine to the cursor,
     and when there is no machine within reach it does not draw at all. */
  var PHONE_LOUPE_REACH = 6;

  function phoneLoupeCell() {
    if (!S || cursorCell < 0) return -1;
    var cells = structCells(S), i, c, d, best = -1, bd = 1e9;
    for (i = 0; i < cells.length; i++) {
      c = cells[i];
      if (pieceAtCell(c) !== PIECE_GUN) continue;
      d = Math.abs(cx(c) - cx(cursorCell)) + Math.abs(cy(c) - cy(cursorCell));
      if (d < bd) { bd = d; best = c; }
    }
    return (best >= 0 && bd <= PHONE_LOUPE_REACH) ? best : -1;
  }

  function drawLoupe() {
    if (!loupeOn()) return;
    /* s7.32 ruling 6 (ii): one card at a time. The machine card the visitor
       opened owns the close up; this one yields while it is up. */
    if (loupe.on) { phoneLoupeBox = null; return; }
    var G = RAPI && RAPI.GEO, srcCv = null;
    try { srcCv = R.source(); } catch (e) { srcCv = null; }
    if (!G || !srcCv) return;
    var subj = phoneLoupeCell();
    if (subj < 0) return;
    var p = srcOfCell(subj);
    if (!p) return;
    var K = 3, sw = 44, sh = 34;
    var sx = Math.max(0, Math.min(srcCv.width - sw, Math.round(p.x - sw / 2)));
    var sy = Math.max(0, Math.min(srcCv.height - sh, Math.round(p.y - sh * 0.72)));
    var dw = sw * K, dh = sh * K;
    var dx = Math.round(stripW() - dw - 10);
    var dy = Math.round((view.topPad || 0) + 8);
    /* s7.17 ruling 2: in Your turn the close up sits in the room UNDER the
       board. At dpr 2 it used to stand at topPad + 8 with its top 38 px on the
       empty page above a board that starts at y 197, and the box itself was
       over half the height of the whole board. */
    if (slotNow && slotNow.loupe) {
      dx = Math.round(slotNow.loupe.x + 3);
      dy = Math.round(slotNow.loupe.y + 3);
    }
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = plateCol(0.9);
    ctx.fillRect(dx - 3, dy - 3, dw + 6, dh + 17);
    try { ctx.drawImage(srcCv, sx, sy, sw, sh, dx, dy, dw, dh); } catch (e) {}
    ctx.strokeStyle = accent();
    ctx.lineWidth = 1;
    ctx.strokeRect(dx + 0.5, dy + 0.5, dw - 1, dh - 1);
    /* it says what it is a picture of: an unlabelled zoom read as a broken
       image to two ship-gate lanes (ruling 4) */
    ctx.font = '600 10px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = ink(0.85);
    ctx.fillText('A catapult, close up', dx + dw / 2, dy + dh + 2);
    ctx.restore();
    phoneLoupeBox = { x: dx - 3, y: dy - 3, w: dw + 6, h: dh + 17, cell: subj };
  }
  var phoneLoupeBox = null;

  /* ---- s7.29 ruling 1: THE FRAME BORDER IS PRESENT IN EVERY FRAME ---------
     The bezel is the outermost thing in the RENDERER's source (drawBezel
     fills [0, 0, SRCW, BEZ] and its three mirrors), so a framed wave whose
     window crops an edge has no border drawn there: the light lane watched
     the board "lose its frame and bleed to x = 0" and read the half-height
     plates below it as a page that had broken rather than as a camera that
     had moved.

     Every edge the crop cut takes the renderer's OWN bezel band back, blitted
     off `R.source()` at that edge of the picture. No colour is invented here
     and nothing is redrawn: these are the same pixels the uncropped edges
     show, at the same scale, so the alarm glow that lights the frame when the
     keep is bitten rides along for free. Drawn immediately after the board
     and before anything the page paints on top of it, because the frame is
     part of the picture and not a plate. */
  function drawFrameEdges() {
    /* the ledger reports what THIS frame did, so a frame that puts nothing
       back must not leave the last one's answer standing */
    frameEdgesDrawn = null;
    if (!R || !R.source || !RAPI || !RAPI.frameRect || !RC) return;
    if (!view || view.fallback) return;
    var fr = null;
    try { fr = RAPI.frameRect(view); } catch (e) { fr = null; }
    if (!fr) return;
    if (fr.top && fr.bottom && fr.left && fr.right) return;   /* nothing cut */
    var src = null;
    try { src = R.source(); } catch (e2) { src = null; }
    if (!src || !src.width || !src.height) return;
    var d = Math.max(1, view.dpr || 1), k = (view.S || 1) / d;
    if (!(k > 0)) return;
    var BEZ = RC.BEZ, SW = RC.SRCW, SH = RC.SRCH;
    var fx0 = view.fx0 || 0, fy0 = view.fy0 || 0;
    var fw = view.fw || SW, fh = view.fh || SH;
    var x = view.ox, y = view.oy, w = view.bw, h = view.bh;
    if (!(w > 0) || !(h > 0)) return;
    var bz = BEZ * k;
    var sm = ctx.imageSmoothingEnabled;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    try {
      if (!fr.top) ctx.drawImage(src, fx0, 0, fw, BEZ, x, y, w, bz);
      if (!fr.bottom) ctx.drawImage(src, fx0, SH - BEZ, fw, BEZ, x, y + h - bz, w, bz);
      if (!fr.left) ctx.drawImage(src, 0, fy0, BEZ, fh, x, y, bz, h);
      if (!fr.right) ctx.drawImage(src, SW - BEZ, fy0, BEZ, fh, x + w - bz, y, bz, h);
      frameEdgesDrawn = { top: !fr.top, bottom: !fr.bottom,
                          left: !fr.left, right: !fr.right };
    } catch (e3) { frameEdgesDrawn = null; }
    ctx.restore();
    ctx.imageSmoothingEnabled = sm;
  }
  /* which edges the last frame had to put back, for a suite to read */
  var frameEdgesDrawn = null;
  /* s7.29 ruling 2: the overview inset's own backing rect, as drawn */
  var insetDrawn = null;

  function drawInset() {
    /* s7.21 ruling 9: the overview inset, the Recenter button and the pan
       gesture belong to the PHONE's follow camera, which gives up the whole
       board. The desktop framing keeps the same chrome it always had. */
    /* the ledger says what THIS frame drew, so a frame that draws no inset
       must not leave the last one's rect standing (s7.29 ruling 2) */
    insetDrawn = null;
    if (!followFull() || !phone() || !R || !R.fortress || !view || view.fallback) return;
    var ig = insetGeom();
    if (!ig) { insetDrawn = null; return; }
    var w = ig.w, h = ig.h, x = ig.x, y = ig.y;
    insetDrawn = { x: x - 2, y: y - 2, w: w + 4, h: h + 4 };
    if (recenterOn) placeRecenter();
    ctx.save();
    ctx.fillStyle = plateCol(0.85);
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    try {
      R.fortress(ctx, { x: x, y: y, w: w, h: h }, renderState(S),
                 { hpMax: { wall: HP_WALL, gun: HP_GUN, keep: HP_KEEP } });
    } catch (e) {}
    /* the camera's own window, so the inset says where you are looking */
    var sw = (RC && RC.SRCW) ? RC.SRCW : 740, sh = (RC && RC.SRCH) ? RC.SRCH : 356;
    var rx = x + w * (view.fx0 / sw), ry = y + h * (view.fy0 / sh);
    var rw = w * (view.fw / sw), rh = h * (view.fh / sh);
    ctx.strokeStyle = accent();
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(rx) + 0.5, Math.round(ry) + 0.5,
                   Math.max(2, Math.round(rw)), Math.max(2, Math.round(rh)));
    ctx.strokeStyle = ink(0.3);
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.restore();
  }

  function stripW() { return Math.max(120, cssW - (view ? (view.reserve || 0) : 0)); }

  /* ------------------------------------------------------- THE MACHINE LOUPE
     Build spec v3 s7.9 ruling 3b, which answers SEAM R2f-S2. A machine is 26
     sprite pixels wide and the board runs at about 1.5 css pixels per sprite
     pixel, so on the page it is 39 px of dark shape: all three round 20 judges
     said, unprompted, that they could not tell a loaded machine from an idle
     one at that size. Hovering one for 300 ms, or tapping it on any device,
     opens a close up of THAT machine in a corner for as long as the pointer
     stays on it.

     It is blitted straight off the renderer's own source canvas every frame,
     so it follows the whole cycle (wind, throw, recoil, reset) for free and
     cannot disagree with the board. Nothing is redrawn here and no sprite
     changed. The window is the renderer's OWN hold frame crop, WEAPON.CONST.GC
     translated to the machine's column and row through GEO's tileX and yb,
     with a little air so the arm stays inside while it swings. */
  var LOUPE_DWELL = 300;
  /* s7.20 ruling 5 (SEAM P11-S1, ruled in the s7.17 addendum): on a PHONE a
     tap-summoned close up is a TRANSIENT. It is the one deliberate exception
     to s7.17.2's no-overlap bar, and being transient is the whole reason the
     exception is allowed, so it has to end on its own as well as on the next
     tap: the wave verifier found it still up after 6 s with no input, covering
     37 percent of the phone board. The lifetime is checked against the same
     clock the page's own frame loop runs on (stepLoupe), so a hidden tab does
     not burn it in the background and the close happens on a PAINTED frame.
     Desktop is untouched on purpose: there the box stands clear of the board
     in a corner, a pointer that leaves the machine already closes a hover and
     the click-opened one is judged behaviour the ruling does not reopen. */
  var LOUPE_HOLD = 4000;
  /* the air around the hold frame crop, measured off the renderer's own
     geometry rather than guessed (`_tests/twoengineers/p5/probe-arm.mjs`): over
     a whole cycle the arm tip reaches 17.7 sp above the crop and 2.8 sp past
     each side, so a tighter frame would cut the top off the whip, which is the
     one part of the throw worth watching large. */
  var LOUPE_PAD = { l: 6, r: 6, t: 22, b: 5 };
  var LOUPE_CAP_H = 17;
  var loupe = { on: false, cell: -1, owner: -1, piece: 0, src: '',
                box: null, cap: null, pic: null, capTop: false,
                cs: 0, win: null, caption: '', until: 0, said: '' };
  var hoverCell = -1, hoverTimer = 0;

  function pieceAtCell(cell) {
    if (!S || cell < 0 || cell >= CELLS) return 0;
    var st = renderState(S);
    return st.piece[cell] || 0;
  }

  /* the css point a source pixel lands on, the inverse of the renderer's own
     pick(); fx0/fy0 are in source space and so is sx/sy */
  function srcToCss(sx, sy) {
    if (!view) return null;
    var k = (view.S || 1) / (view.dpr || 1);
    return { x: view.ox + (sx - (view.fx0 || 0)) * k,
             y: view.oy + (sy - (view.fy0 || 0)) * k };
  }

  /* s7.19 ruling 8: a WALL opens a close up too. The walkthrough promises one
     ("A wall, close up"), two judges tried walls first and got nothing, and
     the machine is the hardest thing on the board to find in the first place.
     The wall's own window is a small box around its tile: its foot stands on
     the row's back line and it rises WALL_H above it, so the box is taken from
     the line up rather than centred on the tile. */
  var WALL_WIN = { w: 44, h: 34, up: 26 };

  function wallWindow(cell) {
    var G = RAPI && RAPI.GEO;
    if (!G || !G.tileX || !G.yb || cell < 0) return null;
    var bez = RC ? RC.BEZ : 6, tw = RC ? RC.TW : 26;
    var sw = RC ? RC.SRCW : 740, sh = RC ? RC.SRCH : 356;
    var x, y;
    try { x = G.tileX(cx(cell)) + tw / 2; y = G.yb(cy(cell)); }
    catch (e) { return null; }
    if (!isFinite(x) || !isFinite(y)) return null;
    var sx = Math.max(0, Math.min(sw - WALL_WIN.w, Math.round(x + bez - WALL_WIN.w / 2)));
    var sy = Math.max(0, Math.min(sh - WALL_WIN.h, Math.round(y + bez - WALL_WIN.up)));
    return { x: sx, y: sy, w: WALL_WIN.w, h: WALL_WIN.h };
  }

  /* SEAM R2M-S2 TAKEN (build spec v3 s7.21 ruling 10, PIN R-S5). The page had
     two source windows of its own, one 44 x 34 for a wall and one sized from
     the machine's hold frame, so the close up changed SHAPE as well as side
     between the two things it magnifies: 184 x 161 landscape for a wall and
     160 x 269 portrait for a machine, which two judges and the critic all
     filed. `R.closeUp` is the renderer's own window and it is ONE SIZE (64 x
     60 source px) for every piece, clamped inside the source canvas by the
     code that owns that canvas. The page's own windows stay as the fallback
     for a renderer without the pin. */
  function loupeWindow(cell, piece) {
    if (R && R.closeUp) {
      try {
        var w = R.closeUp(cell, piece);
        if (w && isFinite(w.x) && w.w > 0 && w.h > 0) return w;
      } catch (e) { /* the page's own below */ }
    }
    if (piece === PIECE_WALL) return wallWindow(cell);
    var W = RAPI && RAPI.WEAPON, G = RAPI && RAPI.GEO;
    var GC = (W && W.CONST) ? W.CONST.GC : null;
    if (!GC || !G || !G.tileX || !G.yb || cell < 0) return null;
    var x, y;
    try {
      x = G.tileX(cx(cell)) + (GC.x0 - G.tileX(GC.c));
      y = G.yb(cy(cell)) + (GC.y0 - G.yb(GC.r));
    } catch (e) { return null; }
    if (!isFinite(x) || !isFinite(y)) return null;
    var bez = RC ? RC.BEZ : 6;
    var sw = RC ? RC.SRCW : 740, sh = RC ? RC.SRCH : 356;
    var w = GC.w + LOUPE_PAD.l + LOUPE_PAD.r;
    var h = GC.h + LOUPE_PAD.t + LOUPE_PAD.b;
    var sx = Math.max(0, Math.min(sw - w, Math.round(x + bez - LOUPE_PAD.l)));
    var sy = Math.max(0, Math.min(sh - h, Math.round(y + bez - LOUPE_PAD.t)));
    return { x: sx, y: sy, w: w, h: h };
  }

  /* three times the size the machine is on the board, snapped to a whole
     number of DEVICE pixels per source pixel so the blit stays square, and
     never smaller than the tray card's own 4 css pixels per source pixel */
  function loupeScale() {
    var Sdev = (view && view.S > 0) ? view.S : 1;
    var d = (view && view.dpr > 0) ? view.dpr : 1;
    var s = Math.max(Math.round(3 * Sdev), Math.round(TRAY_CS * d));
    return Math.max(1, s) / d;
  }

  function openLoupe(cell, src) {
    var p = pieceAtCell(cell);
    if (!p) return false;
    if (!loupeWindow(cell, p)) return false;
    var st = renderState(S);
    loupe.on = true; loupe.cell = cell; loupe.src = src;
    loupe.piece = p; loupe.owner = st.owner[cell];
    /* ruling 5: the phone's tap-summoned close up carries its own deadline.
       A fresh tap on another machine re-arms it, because this runs again. */
    loupe.until = (src === 'tap' && phone()) ? now() + LOUPE_HOLD : 0;
    /* s7.26 ruling 12: each opening starts at the full scale and steps down
       only if its own placement cannot clear its subject */
    loupe.shrink = 0;
    return true;
  }

  /* s7.32 addendum 3 item 6: a close-up the visitor closes takes its "again
     to close" sentence with it, at once, as the self-dismiss path does
     (stepLoupe): the act's own line comes back if the tap's sentence is still
     the one standing */
  function closeLoupeLine() {
    var mine = !!loupe.said && statusNow().indexOf(loupe.said) >= 0;
    closeLoupe();
    if (mine) { var line = phaseLine(); if (line) setStatus(line, { force: true }); }
  }
  /* the same after a press whose own verb ran first: never over a sentence
     that verb wrote or queued, only over the card's own one still standing */
  function lineAfterClose(said) {
    if (!said || stQ.length || stProg || statusNow().indexOf(said) < 0) return;
    var line = phaseLine();
    if (line) setStatus(line, { force: true });
  }
  function closeLoupe() {
    loupe.on = false; loupe.cell = -1; loupe.src = '';
    loupe.box = null; loupe.cap = null; loupe.pic = null;
    loupe.capTop = false; loupe.win = null; loupe.caption = '';
    loupe.until = 0; loupe.said = '';
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
    hoverCell = -1;
  }

  /* ruling 5's other half, run once per frame: the deadline is a deadline. A
     close up the visitor is still working with never reaches it, because every
     input on a phone either closes this one (a tap on the same machine, a tap
     off the board, Escape) or opens another (a tap on a different machine),
     and both paths go through the two functions above. */
  function stepLoupe() {
    if (!loupe.on || !(loupe.until > 0)) return;
    if (now() < loupe.until) return;
    /* The sentence the tap wrote ends "Tap it again to close", and on a phone
       that sentence is what the caption card under the board is showing. A close
       up that dismissed ITSELF must not leave an instruction about something the
       visitor can no longer see, so the act's own standing line takes the slot
       back. Only while the tap's own sentence is still the line on screen: a
       placement or a phase since then owns it instead. It is not forced, so an
       identical line is deduped by the status queue and in the common case this
       writes nothing at all. */
    /* indexOf, not equality: statusPaint prepends "unverified: " when the page
       is running on a model file it could not verify */
    var mine = !!loupe.said && statusNow().indexOf(loupe.said) >= 0;
    closeLoupe();
    if (mine) {
      var line = phaseLine();
      if (line) setStatus(line);
    }
  }

  /* the dwell. A pointer that stops moving fires no more move events, so the
     300 ms is a timer armed on entering the machine and cleared on leaving. */
  function hoverMachine(cell, ptype) {
    if (ptype && ptype !== 'mouse') return;
    /* ruling 8: walls open one too, and the hover target is the WHOLE CELL the
       page's own hit test reports, not the machine's drawn body */
    var mach = pieceAtCell(cell) ? cell : -1;
    if (mach === hoverCell) return;
    hoverCell = mach;
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
    if (mach < 0) { if (loupe.src === 'hover') closeLoupe(); return; }
    if (loupe.on && loupe.cell === mach) return;
    hoverTimer = setTimeout(function () {
      hoverTimer = 0;
      /* a tap that landed while the dwell was running owns the loupe: the
         pointer moves before it presses, so every tap arms a dwell too */
      if (loupe.on && loupe.src === 'tap') return;
      if (hoverCell === mach) openLoupe(mach, 'hover');
    }, LOUPE_DWELL);
  }

  /* ---- the cell whose DRAWN machine is under this point (s7.24 ruling 8) ---
     `R.machineHit` is the renderer's own answer, because the renderer is what
     knows where a machine's body was painted. A tile the armed piece could
     legally take keeps its own verb, so this never steals a placement: the
     tiles it answers on are the ones that used to answer with the red refusal
     box. Without the pin the page falls back to the cell's own occupancy,
     which is exactly what shipped before. */
  function machineCellAt(px, py, cell) {
    if (cell >= 0 && ghostKind(cell, selPiece) === 1) return -1;
    if (R && R.machineHit && view && !view.fallback) {
      var got = -1;
      try { got = R.machineHit(view, px, py); } catch (e) { got = -1; }
      if (typeof got === 'number' && got >= 0 && got < CELLS && pieceAtCell(got)) return got;
    }
    return (cell >= 0 && pieceAtCell(cell)) ? cell : -1;
  }

  /* a tap on a machine, on any device: it opens the close up instead of the
     act's own cell verb, and a second tap on the same machine closes it */
  function tapMachine(cell) {
    if (!pieceAtCell(cell)) return false;
    /* in the visitor's own build phase a tap on an EMPTY tile is a placement,
       and a tap on a piece is the close up; a tap on a piece the visitor just
       placed is still the close up, which is how they see what they built */
    /* the move that carried the pointer here armed a dwell; the press is the
       decision, so the dwell is dropped either way */
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
    if (loupe.on && loupe.cell === cell && loupe.src === 'tap') { closeLoupeLine(); return true; }
    if (!openLoupe(cell, 'tap')) return false;
    /* a tap is deliberate and the close up is a picture, so the one thing a
       visitor who cannot see it would miss goes in the status line. A hover
       says nothing: it would write to the live region on every pass of the
       pointer. */
    var said = loupeCaption() + ', at column ' + (cx(cell) + 1) +
               ', row ' + (cy(cell) + 1) + '. ' + tapWord() + ' it again to close.';
    /* FORCED, because s7.15 ruling 2's own law says a sentence a user action
       just caused takes the line at once: "an answer to a click that arrives
       1.5 s late is worse than no answer". This was the one user-caused write
       in the file that queued, and mid-wave the progress counters held the
       line through its whole dwell: the r26.12 row read a status log with the
       wave's own sentences in it and no close-up sentence at all, in two runs
       of three. A visitor who cannot see the picture got nothing from the
       press that opened it. */
    setStatus(said, { force: true });
    /* what this tap put on the line, remembered rather than pattern matched, so
       a close up that dismisses ITSELF can hand the slot back only while its own
       sentence is still the one on screen (ruling 5, stepLoupe) */
    loupe.said = said;
    return true;
  }

  /* the copy rule: Catapult, never turret, and no claim about whose machine it
     is in an act where the visitor is not one of the two builders */
  function loupeCaption() {
    var what = loupe.piece === PIECE_GUN ? 'catapult' : 'wall';
    if (act.name === 'you') {
      if (loupe.owner === 0) return 'Your ' + what + ', close up';
      if (loupe.owner === 1) return 'Your partner\'s ' + what + ', close up';
    }
    return (what === 'catapult' ? 'A catapult' : 'A wall') + ', close up';
  }

  /* ---- the walkthrough's wave beat (build spec v3 s7.9 ruling 3c) ----------
     The beat plays inside the close up, and the tour step anchors its ring on
     the inset rather than on the whole canvas. The subject is a machine when
     the engineers built one, and when there is none the beat watches the piece
     the wave is about instead and the caption says which. A hover or a tap
     always wins over the beat's own pick. (The old note here quoted a catapult
     rate of about one game in twelve, measured on the untrained placeholder,
     which is not what ships now: the trained cast built a catapult in 60 of 60
     games, about three per game, measured by
     `_tests/twoengineers/p7/guns.js`. The no-machine branch is therefore all
     but unreachable on this model file and stays for one that behaves
     otherwise.) */
  var tourLoupeOn = false;

  function keepCentre() {
    var G = RAPI && RAPI.GEO, k = null;
    try { k = (G && G.keep) ? G.keep() : null; } catch (e) { k = null; }
    if (!k) return null;
    return { x: (k.c0 + k.c1) / 2, y: (k.r0 + k.r1) / 2 };
  }

  function pickLoupeSubject() {
    if (!S) return -1;
    var st = renderState(S), i, wall = -1, best = 1e9, d, kc = keepCentre();
    for (i = 0; i < st.piece.length; i++) {
      if (st.piece[i] === PIECE_GUN) return i;
      if (st.piece[i] === PIECE_WALL) {
        d = kc ? (Math.abs(cx(i) - kc.x) + Math.abs(cy(i) - kc.y)) : (st.piece.length - i);
        if (d < best) { best = d; wall = i; }
      }
    }
    return wall;
  }

  function tourLoupeAim() {
    if (!tourLoupeOn || !tourOn) { if (loupe.src === 'tour') closeLoupe(); return; }
    if (loupe.on && loupe.src !== 'tour' && pieceAtCell(loupe.cell)) return;
    if (loupe.src === 'tour' && loupe.cell >= 0 && pieceAtCell(loupe.cell)) return;
    var pick = pickLoupeSubject();
    if (pick >= 0) openLoupe(pick, 'tour');
    else if (loupe.src === 'tour') closeLoupe();
  }

  function rectOverlap(a, b) {
    if (!a || !b) return 0;
    var w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    var h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return (w > 0 && h > 0) ? w * h : 0;
  }

  /* the corners the other two insets already own, so three magnifiers never
     stack in the same place on a phone */
  function loupeTaken() {
    var out = [];
    if (slotNow && slotNow.loupe) out.push(slotNow.loupe);
    else if (slotNow && slotNow.card) out.push(slotNow.card);
    if (loupeOn() && !(slotNow && slotNow.loupe)) {
      out.push({ x: stripW() - 142, y: (view.topPad || 0) + 5, w: 142, h: 108 });
    }
    if (followFull()) {
      var w = Math.round(Math.min(150, stripW() * 0.38));
      out.push({ x: stripW() - w - 10, y: (view.topPad || 0) + 6, w: w + 4, h: w * 0.5 + 6 });
    }
    return out;
  }

  /* A corner, preferring one clear of the board frame and of the machine
     itself. At a desktop window the board fills the strip and no corner is
     clear of it, so the least covered corner wins and the plate is opaque.

     Build spec v3 s7.10 ruling 4b. The honesty plate is painted LAST and wins
     by z order, so on a phone with the control panel open (which shortens the
     strip and pulls both down) it was drawn straight across this inset's own
     caption: 87 percent of the caption strip covered, measured by V1f. The
     close up is the thing that moves. The plate's rect for this frame is
     already known when this runs, so it is scored like a taken corner AND the
     winning corner is then LIFTED clear of it, which is a guarantee rather
     than a preference. `stuck` says the lift found no room, and then the plate
     yields instead. */
  /* the DRAWN body of the machine or wall the close up is of, in css pixels */
  function loupeSubjectBox() {
    var b = null;
    if (R && R.machineBox && loupe.cell >= 0 && view && !view.fallback) {
      try { b = R.machineBox(view, loupe.cell); } catch (e) { b = null; }
    }
    if (!b && RAPI && RAPI.cellRect && loupe.cell >= 0 && view && !view.fallback) {
      try { b = RAPI.cellRect(view, loupe.cell); } catch (e) { b = null; }
    }
    if (!b || !isFinite(b.x) || !(b.w > 0) || !(b.h > 0)) return null;
    return { x: b.x, y: b.y, w: b.w, h: b.h };
  }

  /* ---- s7.28 ruling 5: THE CELLS THIS VISITOR JUST BUILT ON ----------------
     The close up's own law already refuses to cover its SUBJECT (s7.24 ruling
     8), and the renderer's `closeUpPlaceAt` has taken an `avoid` list since
     that ruling. The card the page really draws is placed by `loupePlace`
     here, so the list is wired in here: the cells holding the pieces THIS
     TURN put down. The light reduced-motion judge tapped a catapult at the
     east end and the card covered the two walls they had placed a moment
     before, which is the one part of the board they were looking at. The
     subject's own rect is still the hard refusal; these are walked off when
     a slot clear of them exists and kept, disclosed, when none does. */
  function loupeAvoid() {
    var out = [], i, m, b;
    if (act.name !== 'you' || !view || view.fallback || !R) return out;
    for (i = 0; i < myMoves.length; i++) {
      m = myMoves[i];
      if (!m || m.cell === loupe.cell) continue;   /* the subject has its own rule */
      b = null;
      if (m.piece === PIECE_GUN && R.machineBox) {
        try { b = R.machineBox(view, m.cell); } catch (e) { b = null; }
      }
      if (!b && RAPI && RAPI.cellRect) {
        try { b = RAPI.cellRect(view, m.cell); } catch (e) { b = null; }
      }
      if (b && isFinite(b.x) && b.w > 0 && b.h > 0) {
        out.push({ x: b.x, y: b.y, w: b.w, h: b.h, cell: m.cell });
      }
    }
    /* s7.32 ruling 6 (iii): in the build phase the LIT cells join the list,
       each as its centre point, so the card takes the slot covering the
       fewest of them; a lit cell in the gate mouths (the top 30 percent of
       the lit rows, the renderer's own mouth band law) weighs more than any
       number of the others, so the card never covers a mouth when a slot
       without one exists */
    var lit = legalCells(), r0 = ROWS, r1 = -1, c, q, mouthTo;
    if (lit && lit.length && RAPI && RAPI.cellRect) {
      for (i = 0; i < lit.length; i++) { c = lit[i]; r0 = Math.min(r0, cy(c)); r1 = Math.max(r1, cy(c)); }
      mouthTo = r0 + 0.30 * (r1 - r0);
      for (i = 0; i < lit.length; i++) {
        c = lit[i];
        if (c === loupe.cell) continue;
        try { q = RAPI.cellRect(view, c); } catch (e) { q = null; }
        if (!q || !isFinite(q.x)) continue;
        out.push({ x: q.x + q.w / 2, y: q.y + q.h / 2, w: 1, h: 1, cell: c,
                   lit: 1, mouth: cy(c) < mouthTo ? 1 : 0 });
      }
    }
    return out;
  }

  /* the keep's readout as the last frame drew it: the page's own box (its
     plate, or the label beside the meter) and, when the label stands beside
     it, the renderer's corner meter (keepNumberGeom's own formula) */
  function keepReadoutRects() {
    var out = [], kb = keepNumBox, m0, m1, night;
    if (!kb || !RC || !view || view.fallback) return out;
    out.push({ x: kb.x, y: kb.y, w: kb.w, h: kb.h });
    if (kb.backing) out.push(kb.backing);
    if (!kb.own) {
      night = !isLight();
      m0 = srcToCss(RC.BEZ + (night ? 18 : 32), RC.BEZ + RC.PLATE_BOT - 16 - 3);
      m1 = srcToCss(RC.BEZ + (night ? 18 : 32) + (night ? 132 : 128), RC.BEZ + RC.PLATE_BOT - 16 + 9);
      if (m0 && m1) out.push({ x: m0.x, y: m0.y, w: Math.max(1, m1.x - m0.x), h: Math.max(1, m1.y - m0.y) });
    }
    return out;
  }

  var loupeFit = null;
  function loupePlace(w, h) {
    var pad = 8;
    var x0 = pad, x1 = Math.max(pad, stripW() - pad - w);
    /* s7.26 ruling 12: the frame never OVERHANGS the board. The light judge
       measured it standing about 14 px past the board's right edge, which
       reads as a picture that missed its own frame. Where the drawn board is
       wide enough to hold the box the box stays inside it; where it is not
       (the 320 px lane, where the board itself is wider than the window) the
       viewport's own edges are still the tighter pair and nothing moves. */
    var dr0 = drawnBoardRect();
    if (dr0 && dr0.w >= w + 2) {
      x0 = Math.max(x0, Math.round(dr0.x));
      x1 = Math.min(x1, Math.round(dr0.x + dr0.w - w));
      if (x1 < x0) { x0 = pad; x1 = Math.max(pad, stripW() - pad - w); }
    }
    var y0 = (view.topPad || 0) + pad;
    var y1 = Math.max(y0, cssH - (view.botPad || 0) - pad - h);
    /* s7.32 ruling 6 (iii): INSIDE THE PICTURE. y0 was the stage's top pad,
       which put the card 28 px above the frame on every opening (the board
       stands lower than the pad); its top is now at or below the picture's
       top plus the pad and its foot at or above the picture's foot */
    if (dr0) {
      y0 = Math.max(y0, Math.round(dr0.y) + pad);
      y1 = Math.max(y0, Math.min(y1, Math.round(dr0.y + dr0.h) - pad - h));
      /* a card taller than the picture less its pads (at the scale floor of
         2) stands centred in it, the pads given up before the frame is */
      if (h > dr0.h - 2 * pad && h <= dr0.h) y0 = y1 = Math.round(dr0.y + (dr0.h - h) / 2);
    }
    var board = view ? { x: view.ox, y: view.oy, w: view.bw || 0, h: view.bh || 0 } : null;
    var taken = loupeTaken();
    var pr = plateRect;
    var subj = null, wn = loupe.win;
    if (wn) subj = srcToCss(wn.x + wn.w / 2, wn.y + wn.h / 2);
    /* s7.24 ruling 8: NEVER OVER THE THING IT MAGNIFIES. The panel critic
       measured the frame pinned at (8, 140) with a machine in the board's left
       quarter inside it, in both themes. The subject's own drawn body is asked
       of the renderer (R.machineBox) and every candidate that covers it is
       refused outright rather than merely penalised, so "beside its subject"
       is a guarantee and not a preference. */
    var subjBox = loupeSubjectBox();
    var avoid = loupeAvoid();        /* s7.28 ruling 5 */
    var keepRd = keepReadoutRects();
    /* the bottom corners carry the caption strip and the honesty plate, so
       they start behind the top two */
    var cands = [{ x: x0, y: y0, pen: 0 }, { x: x1, y: y0, pen: 0 },
                 { x: x0, y: y1, pen: 900 }, { x: x1, y: y1, pen: 900 }];
    /* s7.17 ruling 2: on a phone showing the whole board the room UNDER it is
       where a close up goes, so the two ends of that room are candidates and
       they start ahead of the corners, which on this layout are all on the
       board. They are offered only while the box really fits the room. */
    var fr = slotNow && slotNow.free;
    if (fr && w <= fr.w + 0.5 && h <= fr.h + 0.5) {
      cands.push({ x: fr.x, y: fr.y, pen: -400 },
                 { x: fr.x + fr.w - w, y: fr.y, pen: -400 });
    }
    var best = null, i, j, c, box, s, dx, dy;
    var litUnder = function (bx, by) {
      var q = { x: bx, y: by, w: w, h: h }, z, n = 0, mo = 0;
      for (z = 0; z < avoid.length; z++) {
        if (avoid[z].lit && rectOverlap(q, avoid[z]) > 0) { n++; if (avoid[z].mouth) mo++; }
      }
      return { n: n, mouth: mo };
    };
    var litMin = null, lu;
    for (i = 0; i < cands.length; i++) {
      lu = litUnder(cands[i].x, cands[i].y);
      if (!litMin || lu.n < litMin.n) litMin = { n: lu.n, mouth: lu.mouth, at: i };
    }
    for (i = 0; i < cands.length; i++) {
      c = cands[i];
      box = { x: c.x, y: c.y, w: w, h: h };
      s = rectOverlap(box, board) / 100 + c.pen;
      for (j = 0; j < taken.length; j++) s += rectOverlap(box, taken[j]) / 8;
      /* heavier than an inset, because an inset overlapping is untidy and the
         plate overlapping hides what the picture is of */
      if (pr) s += rectOverlap(box, pr) / 2;
      /* s7.21 ruling 10: THE SAME SIDE AS THE THING IT MAGNIFIES. This term
         used to SUBTRACT the distance to the subject, so the frame was pushed
         as far from the machine as the stage allowed: cell 31 on the left put
         it at x 916 and cell 51 on the right put it at x 8, which is the
         opposite of where a reader looks. A candidate on the subject's own
         horizontal half is preferred outright, and nearer wins among them. */
      if (subj) {
        var mid = stripW() / 2;
        var sameSide = ((c.x + w / 2) < mid) === (subj.x < mid);
        if (!sameSide) s += 500;
        dx = c.x + w / 2 - subj.x; dy = c.y + h / 2 - subj.y;
        s += Math.min(900, Math.sqrt(dx * dx + dy * dy)) / 6;
      }
      if (subjBox) s += rectOverlap(box, subjBox) * 40;
      /* s7.32 ruling 6 (iii): inside the picture the bottom corners reach the
         keep's own readout (the corner meter and its "Keep N of 100"), which
         is shown once in every frame (s7.19 ruling 8): as heavy as the
         subject */
      for (j = 0; j < keepRd.length; j++) s += rectOverlap(box, keepRd[j]) * 40;
      /* s7.28 ruling 5: heavier than an inset and lighter than the subject,
         so a card that must cover one of the two still covers the subject
         last */
      for (j = 0; j < avoid.length; j++) {
        if (avoid[j].lit) {   /* s7.32 ruling 6 (iii): counted by cell */
          if (rectOverlap(box, avoid[j]) > 0) s += avoid[j].mouth ? 1e6 : 2000;
        } else s += rectOverlap(box, avoid[j]) * 12;
      }
      if (!best || s < best.s) best = { x: c.x, y: c.y, s: s, box: box };
    }
    /* ---- s7.28 ruling 5: WALK OFF THE PIECES, THEN OFF THE SUBJECT --------
       The scoring above prefers a clear slot; this makes it a guarantee where
       one exists. Every candidate the placer already knows about is tried
       again, and the first that covers neither the subject nor any piece put
       down this turn wins. If none does, nothing moves and the placement
       keeps the answer it had, which is the disclosed case. */
    if (avoid.length && best) {
      var hits = function (bx, by) {
        var q = { x: bx, y: by, w: w, h: h }, z;
        if (subjBox && rectOverlap(q, subjBox) > 0) return true;
        for (z = 0; z < avoid.length; z++) if (!avoid[z].lit && rectOverlap(q, avoid[z]) > 0) return true;
        for (z = 0; z < keepRd.length; z++) if (rectOverlap(q, keepRd[z]) > 0) return true;   /* s7.32 r6 */
        return false;
      };
      if (hits(best.x, best.y)) {
        var order = cands.slice().sort(function (p, q2) { return p.pen - q2.pen; });
        for (i = 0; i < order.length; i++) {
          var ax = Math.max(x0, Math.min(x1, order[i].x));
          var ay = Math.max(y0, Math.min(y1, order[i].y));
          if (!hits(ax, ay)) { best.x = ax; best.y = ay; best.dodged = true; break; }
        }
      } else { best.dodged = true; }
      best.hits = hits;      /* re-asked at the end, after the plate's lift */
    }
    /* and if the winner still covers its own subject, it is walked off it:
       right of the body, then left, then below, then above, taking the first
       place that is inside the stage and clear (s7.24 ruling 8) */
    if (subjBox && rectOverlap({ x: best.x, y: best.y, w: w, h: h }, subjBox) > 0) {
      var tries = [
        { x: subjBox.x + subjBox.w + pad, y: best.y },
        { x: subjBox.x - pad - w, y: best.y },
        { x: best.x, y: subjBox.y + subjBox.h + pad },
        { x: best.x, y: subjBox.y - pad - h }
      ], q, bx2, by2;
      for (i = 0; i < tries.length; i++) {
        bx2 = Math.max(x0, Math.min(x1, tries[i].x));
        by2 = Math.max(y0, Math.min(y1, tries[i].y));
        q = { x: bx2, y: by2, w: w, h: h };
        if (rectOverlap(q, subjBox) === 0) { best.x = bx2; best.y = by2; best.walked = true; break; }
      }
    }
    best.stuck = false;
    if (pr && rectOverlap({ x: best.x, y: best.y, w: w, h: h }, pr) > 0) {
      /* above the plate first: below it is the act's own caption strip.
         s7.26 ruling 12: this lift runs AFTER the walk off above and used to
         undo it. At 320 css px the walk off put the frame below its machine at
         y 235 and this pulled it back to 167, on top of the machine, in 2 of 8
         real openings. "Never over the thing it magnifies" is s7.24 ruling 8's
         guarantee and the plate has an answer of its own (`plateAvoid` moves
         the plate, or the caption strip swaps ends), so a lift that would put
         the frame back on its own subject is refused and the plate yields. */
      var clearsSubj = function (y2) {
        return !subjBox ||
               rectOverlap({ x: best.x, y: y2, w: w, h: h }, subjBox) === 0;
      };
      var up = pr.y - pad - h, down = pr.y + pr.h + pad;
      if (up >= y0 && clearsSubj(up)) best.y = up;
      else if (down <= y1 && clearsSubj(down)) best.y = down;
      else best.stuck = true;
    }
    /* what the placement had to work with, for a probe that has to say WHY
       a frame ended where it did (s7.26 ruling 12's 320 px clause) */
    loupeFit = { x0: x0, y0: y0, x1: x1, y1: y1, w: w, h: h,
                 stuck: !!best.stuck, walked: !!best.walked,
                 /* s7.28 ruling 5: what the card was asked to keep off, and
                    whether it managed to */
                 avoid: avoid.filter(function (a) { return !a.lit; }).map(function (a) {
                   return { x: a.x, y: a.y, w: a.w, h: a.h, cell: a.cell }; }),
                 /* s7.32 ruling 6 (iii): the lit cells (centres) under the
                    card, and the fewest any first-pass slot offered */
                 lit: litUnder(best.x, best.y), litMin: litMin,
                 keepHit: keepRd.some(function (r) { return rectOverlap({ x: best.x, y: best.y, w: w, h: h }, r) > 0; }),
                 avoidHit: !!(best.hits && best.hits(best.x, best.y)),
                 dodged: !!best.dodged,
                 subj: subjBox ? { x: subjBox.x, y: subjBox.y, w: subjBox.w, h: subjBox.h } : null,
                 plate: pr ? { x: pr.x, y: pr.y, w: pr.w, h: pr.h } : null };
    best.box = { x: best.x, y: best.y, w: w, h: h };
    return best;
  }

  function drawMachineLoupe() {
    /* the box is what the walkthrough rings, so it is only ever the box a
       frame really painted */
    loupe.box = null; loupe.cap = null; loupe.pic = null; loupe.capTop = false;
    if (!loupe.on || !R || !R.source || !view || view.fallback) return;
    /* the piece can fall while the loupe is on it */
    var p = pieceAtCell(loupe.cell);
    if (!p) { if (loupe.src === 'tour') loupe.cell = -1; else closeLoupe(); return; }
    loupe.piece = p;
    var srcCv = null;
    try { srcCv = R.source(); } catch (e) { srcCv = null; }
    var win = loupeWindow(loupe.cell, p);
    if (!srcCv || !win) return;
    loupe.win = win;
    var cs = loupeScale();
    /* s7.26 ruling 12: at 320 px the frame is 296 css px wide in a 320 px
       window, so there is no position left that is not on the machine it
       magnifies (the round-5 verifier: 6 of 9 openings, always by the
       subject's full width). The frame is capped at four fifths of the stage,
       which at 390 and at 1440 is wider than the frame already is and changes
       nothing there (measured 296 against 312, and 392 against 867). */
    var capW = Math.floor(stripW() * 0.80) - 8;
    if (win.w > 0 && win.w * cs > capW) {
      cs = Math.max(2, Math.floor(capW / win.w));
    }
    /* s7.26 ruling 12, the same clause's other half. At 320 css px the act
       strip wraps to four rows and the corner buttons hold the band under it,
       so the stage a frame may stand in is 248 px tall (y 166 to 414) while
       the frame is 213: wherever it goes it lies across the board's top rows,
       which is where the machine it magnifies stands, and 2 of 8 real openings
       covered their own subject with no candidate left to walk to. A frame
       that cannot clear its subject steps DOWN one scale and tries again on
       the next frame, at most three times and never below 2, so there is
       somewhere to walk it to. At 390 and at 1440 the first placement clears
       and nothing steps, which is why this is keyed on the placement rather
       than on a width. */
    if (loupe.shrink) cs = Math.max(2, cs - loupe.shrink);
    /* s7.32 ruling 6 (iii): the card stands INSIDE the picture, so it is also
       capped to the picture's height less two pads (the phone's framed Your
       turn picture is 152 css px tall; the desktop's 506 changes nothing) */
    var drc = drawnBoardRect();
    if (drc && win.h > 0) {
      var capH = drc.h - 16 - LOUPE_CAP_H - 8;
      if (win.h * cs > capH) cs = Math.max(2, Math.min(cs, Math.floor(capH / win.h)));
    }
    var iw = Math.round(win.w * cs), ih = Math.round(win.h * cs);
    var cap = loupeCaption();
    ctx.save();
    ctx.font = '600 12px "Source Sans 3", system-ui, sans-serif';
    /* s7.21 ruling 10: ONE FIXED SIZE. The frame used to be as wide as
       whichever caption it happened to be carrying, so it changed shape
       between "Your wall, close up" and "A catapult, close up" as well as
       between the two source windows. The picture decides the frame and the
       caption is fitted to it. */
    var pw = iw, ph = ih + LOUPE_CAP_H;
    cap = fitLabel(cap, pw - 12);
    var at = loupePlace(pw + 8, ph + 8);
    if (loupeFit && loupeFit.subj && cs > 2 && (loupe.shrink || 0) < 3 &&
        rectOverlap(at.box, loupeFit.subj) > 0) {
      loupe.shrink = (loupe.shrink || 0) + 1;
    }
    var px = Math.round(at.x) + 4, py = Math.round(at.y) + 4;

    /* Which END of the frame the caption strip takes (s7.10 ruling 4b, the
       ruling's own first remedy: the caption strip moves). On a 390 x 844
       phone with the panel open the strip left over is 317 css px tall and the
       close up plus the honesty plate want 329, so the lift in loupePlace runs
       out of room and SOMETHING has to be covered. The caption is the thing
       that says what the picture is of, so it moves to the top of the frame,
       out from under the plate, and the plate ends up over the bottom few
       pixels of the machine's own ground instead. The plate itself only yields
       if BOTH ends are covered, which is the case where there is no honest
       arrangement left. */
    var capOnTop = false;
    if (plateRect) {
      var lo = { x: px, y: py + ih, w: pw, h: LOUPE_CAP_H };
      var hi = { x: px, y: py, w: pw, h: LOUPE_CAP_H };
      if (rectOverlap(lo, plateRect) > 0) {
        if (rectOverlap(hi, plateRect) === 0) capOnTop = true;
        else plateAvoid = { x: px - 4, y: py - 4, w: pw + 8, h: ph + 8 };
      }
    }
    var iy = capOnTop ? (py + LOUPE_CAP_H) : py;
    var cy0 = capOnTop ? py : (py + ih);

    ctx.fillStyle = plateCol(0.97);
    ctx.fillRect(px - 4, py - 4, pw + 8, ph + 8);
    ctx.imageSmoothingEnabled = false;
    var ix = px + Math.round((pw - iw) / 2);
    try { ctx.drawImage(srcCv, win.x, win.y, win.w, win.h, ix, iy, iw, ih); }
    catch (e) {}
    ctx.strokeStyle = accent();
    ctx.lineWidth = 1;
    ctx.strokeRect(px - 3.5, py - 3.5, pw + 7, ph + 7);
    ctx.fillStyle = ink(0.9);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(cap, px + pw / 2, cy0 + LOUPE_CAP_H / 2 + 1);
    ctx.restore();
    loupe.cs = cs;
    loupe.caption = cap;
    loupe.box = { x: px - 4, y: py - 4, w: pw + 8, h: ph + 8 };
    /* the caption STRIP on its own, because that is the rect ruling 4b is
       about and a probe should read what was painted, not re-derive it */
    loupe.cap = { x: px, y: cy0, w: pw, h: LOUPE_CAP_H };
    loupe.capTop = capOnTop;
    /* the picture, for the same reason */
    loupe.pic = { x: ix, y: iy, w: iw, h: ih };
  }

  function overlayPlate(msg) {
    ctx.save();
    ctx.font = '500 15px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var y = Math.max((view.topPad || 0) + 30, cssH * 0.45);
    var mid = stripW() / 2;
    var w = ctx.measureText(msg).width + 28;
    ctx.fillStyle = plateCol(0.72);
    ctx.fillRect(mid - w / 2, y - 17, w, 34);
    ctx.fillStyle = ink(0.85);
    ctx.fillText(msg, mid, y);
    ctx.restore();
  }

  /* A partly computed grid is drawn partly: computed cells as fortresses,
     pending cells as empty plates. It never claims 64 while 20 are drawn. */
  /* ==================================================== the strangers grid
     Build spec v3 s7.15 ruling 4. Two lanes, the no-context panel and Fable
     all reported the same thing: 64 near identical dark thumbnails, no axis
     labels, no legend, no readable numbers, and a keep that held at 65 looking
     exactly like one that fell at 30. This is the page's central proof and it
     was carrying none of it. So every cell now takes an OUTCOME TINT from one
     scale, the keep health is written in the cell at desktop, the eight
     engineers are named down and across, the diagonal says what it is, and a
     legend row says what the scale means. */
  var GRID_ACCENT = { dark: [130, 166, 204], light: [52, 86, 138] };
  var GRID_FELL = [196, 87, 74];          /* the art bible's one warm colour */

  /* one scale, fell to held, in the two inks this site already owns, so it
     reads the same way in both themes. THE CELLS THEMSELVES ARE PAINTED BY
     R.paintGridCell, whose scale is mix(P.warm, P.accent): P.warm is
     '#c4574a' and P.accent is '#82a6cc' at night and '#34568a' by day, which
     are exactly GRID_FELL and GRID_ACCENT below. So this function is now the
     LEGEND'S ramp and the renderer's fallback, and it must keep those two
     endpoints or the legend would describe a scale the cells do not use. */
  function gridTint(v, a) {
    var f = Math.max(0, Math.min(1, (v === null || v === undefined) ? 0 : v / HP_KEEP));
    var hi = isLight() ? GRID_ACCENT.light : GRID_ACCENT.dark, lo = GRID_FELL, i, out = [];
    for (i = 0; i < 3; i++) out.push(Math.round(lo[i] + (hi[i] - lo[i]) * f));
    return 'rgba(' + out[0] + ',' + out[1] + ',' + out[2] + ',' + a + ')';
  }

  function poolTag(key) {
    return (String(key).indexOf('ac') === 0) ? 'A' : 'S';
  }
  /* s7.19 ruling 7: the eight nets carry ONE NAME across the picker and the
     grid. The picker called them "Any-Play accommodator" and the grid called
     the same eight "engineers from the six-plan runs", and a visitor who met
     both had no way to know they were the same eight engineers. The picker's
     name wins because it is the one the visitor chooses by. */
  function poolWords(keys) {
    return (keys && keys.length && String(keys[0]).indexOf('ac') === 0)
      ? 'the Any-Play accommodators, trained with a partner that kept changing'
      : 'engineers that trained with a copy of themselves';
  }

  /* the diagonal exists only when a row and its column really are the same
     engineer. With the crossed pool ticked no pair trained together, so there
     is no diagonal to name (ruling 7; the ship-gate verifier's major). */
  function gridHasDiag(g) {
    var i;
    if (!g || !g.rows || !g.cols) return false;
    for (i = 0; i < g.n; i++) if (g.rows[i] === g.cols[i]) return true;
    return false;
  }

  var gridDrawn = null;
  /* the grid's own geometry as the last frame laid it out, so a tap can be
     turned into a cell without re-deriving anything (s7.19 ruling 7) */
  var gridCells = null;
  /* the y the act's own picture ENDS on, so the phone slot can start there
     instead of under a caption that sits at the foot of the page (ruling 10) */
  var galleryBottom = 0;

  /* Ruling 7: TAPPING A CELL SHOWS ITS NUMBER. On a phone the cells are below
     the renderer's 30 x 24 floor for an in-cell number, so the picture carries
     the tint and nothing else; a tap now says what that square was, in the
     caption card and in the status line, which is where a phone reads. */
  function gridTapAt(x, y) {
    var g = FX.grid, G = gridCells;
    if (!g || !G || act.name !== 'strangers') return false;
    var j = Math.floor((x - G.x0) / (G.w + G.gap));
    if (j < 0 || j >= G.n || (x - G.x0) - j * (G.w + G.gap) > G.w) return false;
    var i = Math.floor((y - G.y0) / (G.h + G.gap));
    var cell = null, who = '';
    if (i >= 0 && i < G.n && (y - G.y0) - i * (G.h + G.gap) <= G.h) {
      cell = g.cells[i * G.n + j];
      who = poolTag(g.rows[i]) + (i + 1) + ' with ' + poolTag(g.cols[j]) + (j + 1);
    } else if (G.rowY >= 0 && y >= G.rowY && y <= G.rowY + G.h && g.row) {
      cell = g.row[j];
      who = 'your own layout with ' + poolTag(g.cols[j]) + (j + 1);
    } else return false;
    if (!cell) {
      setStatus('That game has not been played yet.', { force: true });
      return true;
    }
    var hp = Math.max(0, Math.round((typeof cell.hp === 'number') ? cell.hp : cell.score));
    var same = (i >= 0 && i < G.n && g.rows[i] === g.cols[j]);
    setStatus(who + ': the keep ' +
              (hp > 0 ? ('held at ' + hp + ' of ' + HP_KEEP) : 'fell') + '.' +
              (same ? ' They trained together.' : ''), { force: true });
    return true;
  }

  function gridBox(g) {
    var n = g.n;
    var ar = (RC && RC.SRCH && RC.SRCW) ? (RC.SRCH / RC.SRCW) : 0.5;
    var gap = 4, wide = cssW >= 700;
    /* the left gutter carries the row labels AND the diagonal's own label, so
       it is sized for the wider of the two rather than for the numbers alone:
       a label clipped off the left edge of the page is not a label */
    var LA = wide ? 76 : 28;              /* the row labels down the left */
    /* the top gutter carries the column labels AND the line above them naming
       both pools. On a phone it was 20 px for both, and the two were drawn 4
       px apart in a 10 px face, so the headline ran straight through S1..S4
       at every pixel ratio (build spec v3 s7.17 ruling 3). The desktop gutter
       already cleared it and is untouched. */
    var TA = wide ? 32 : 34;              /* the column labels across the top */
    /* the legend row under the grid. On a phone it carries TWO lines since
       s7.19 ruling 7 keeps the same-partner entry there, so it is taller. */
    var LG = wide ? 34 : 42;
    var rows = n + (g.row ? 1 : 0);
    var availW = Math.max(60, stripW() - 32 - LA);
    /* s7.21 ruling 4: the block stops at the CAPTION's own top edge. On the
       walkthrough's Strangers beat the card raised the bottom pad, the caption
       rose with it, and the caption plate was painted straight through the
       legend line "same partner: they trained together" for the whole step.
       The caption is measured before any gallery draws, so this is the real
       plate and not an estimate. */
    var floorY = Math.min(cssH - (view.botPad || 0), capTopY || cssH) - 8;
    var availH = Math.max(60, floorY - (view.topPad || 0) - 20 - TA - LG);
    var w = Math.floor(Math.min(availW / n, (availH / rows) / ar)) - gap;
    w = Math.max(20, w);
    var h = Math.max(10, Math.round(w * ar));
    var gw = (w + gap) * n, gh = (h + gap) * rows;
    var x0 = Math.round(LA + Math.max(0, (stripW() - LA - gw) / 2));
    /* Build spec v3 s7.19 ruling 10: on a phone the block is ANCHORED TO THE
       TOP rather than centred in the stage. The grid is width limited there (4
       across a 330 px gutter), so centring it left roughly 100 px of empty page
       above the headline and 80 below the legend; anchored, the room lands in
       ONE band under the picture, and the phone caption card takes it with the
       act's own sentences, which is where s7.17 ruling 2 already puts them. */
    var y0 = Math.round((view.topPad || 0) + TA +
             (wide ? Math.max(0, (availH - gh) / 2) : 0));
    /* s7.22 ruling 3: the grid's own top edge is the board's, whenever the
       column labels above it and the legend row below it both still have their
       room. The labels live in the TA band ABOVE y0, so aligning the cells to
       the board edge is only honest if that band still fits under the top pad. */
    var edge = boardTopEdge(), alignTop = false;
    if (edge !== null && edge - TA >= (view.topPad || 0) - 0.5 &&
        edge + gh + LG <= floorY + 0.5) {
      y0 = Math.round(edge);
      alignTop = true;
    }
    return { n: n, w: w, h: h, gap: gap, x0: x0, y0: y0, LA: LA, TA: TA, LG: LG,
             wide: wide, gw: gw, gh: gh,
             boardTop: edge, alignedTop: alignTop, floorY: Math.round(floorY) };
  }

  /* Whether this cell is big enough to carry its number, which is EXACTLY the
     predicate R.paintGridCell applies inside itself (opts.number plus its own
     30 x 24 floor). The page computes it here rather than guessing, so the
     gridDrawn counter the suite reads counts numbers that were really
     printed. */
  /* s7.21 ruling 5: the phone's 4x4 cells are 78 x 38 css px, well over the
     renderer's own 30 x 24 floor, and they were dropping their numbers only
     because the page also asked for a DESKTOP. Both judges said the phone grid
     then rested on colour alone, which is the one thing the act must not do.
     The test is now the size, which is what the painter's own floor is. */
  /* SEAM R2O-S2 TAKEN: the floor is the renderer's own, asked for by name,
     rather than a second copy of the same two numbers living here. */
  function gridNumberShown(w, h) {
    if (R && R.gridNumberFits) {
      try { return !!R.gridNumberFits(w, h); } catch (e) {}
    }
    return w >= 30 && h >= 24;
  }

  /* one cell: the fortress, then the RENDERER'S OWN outcome tint and number
     over it (PIN R-S1; SEAM R2L-S2, closed by the integration hand). Until
     this hand the page drew its own wash and foot bar here, which was a second
     scale living beside the renderer's and, more to the point, carried the
     outcome in a HUE ALONE: the full-width bar was the same length whether the
     keep held at 100 or fell at 8. R.paintGridCell carries it as a LENGTH as
     well, which is what PIN R-S1 designed and what a reader who cannot
     separate the two hues actually reads. It paints on the PAGE context only,
     so no parity scene can see it and the board's own pixels cannot move. */
  function drawGridCell(bx, by, w, h, c, diag, wide) {
    var v = c ? ((typeof c.hp === 'number') ? c.hp : c.score) : null;
    ctx.fillStyle = plateCol(0.35);
    ctx.fillRect(bx, by, w, h);
    if (c && c.st && R && R.fortress) {
      try {
        R.fortress(ctx, { x: bx, y: by, w: w, h: h }, c.st,
                   { hpMax: { wall: HP_WALL, gun: HP_GUN, keep: HP_KEEP } });
      } catch (e) {}
    }
    var painted = false;
    if (R && R.paintGridCell) {
      R.paintGridCell(ctx, { x: bx, y: by, w: w, h: h },
                      (c && typeof v === 'number') ? v : null,
                      { hpMax: HP_KEEP, number: gridNumberShown(w, h, wide),
                        ring: !!diag });
      painted = !!(c && typeof v === 'number');
    } else if (c) {
      /* a renderer without the painter still gets a readable cell, with the
         outcome carried as a length here too */
      var bh = Math.max(2, Math.round(h * 0.11));
      ctx.fillStyle = gridTint(v, 0.38);
      ctx.fillRect(bx, by, w, h);
      ctx.fillStyle = gridTint(v, 0.95);
      ctx.fillRect(bx, by + h - bh,
                   Math.max(1, Math.round(w * Math.max(0, Math.min(1, (v || 0) / HP_KEEP)))),
                   bh);
      painted = true;
    }
    if (!diag) {
      ctx.strokeStyle = ink(0.25);
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, h - 1);
    }
    return painted ? 1 : 0;
  }

  function drawGrid() {
    var g = FX.grid, n = g.n, i, j;
    var G = gridBox(g), w = G.w, h = G.h, gap = G.gap, x0 = G.x0, y0 = G.y0;
    var tints = 0, nums = 0;
    var hasDiag = gridHasDiag(g);
    gridCells = { x0: x0, y0: y0, w: w, h: h, gap: gap, n: n, rowY: -1 };
    ctx.save();
    for (i = 0; i < n; i++) {
      for (j = 0; j < n; j++) {
        var c = g.cells[i * n + j];
        var t = drawGridCell(x0 + j * (w + gap), y0 + i * (h + gap), w, h, c,
                             i === j && g.rows[i] === g.cols[j], G.wide);
        tints += t;
        /* a number is only counted when the painter that prints it is there
           and the cell really cleared its size floor */
        if (t && R && R.paintGridCell && gridNumberShown(w, h, G.wide)) nums++;
      }
    }
    /* ---- the axes. Short labels, one letter for the pool and the run
       number, with a line above the grid naming both pools in words. */
    var lx0 = x0 - G.LA + 2;              /* the left edge of the whole block */
    var diagLab = 'same partner';
    ctx.font = '600 10px "Source Sans 3", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = ink(0.8);
    ctx.textAlign = 'center';
    for (j = 0; j < n; j++) {
      ctx.fillText(poolTag(g.cols[j]) + (j + 1), x0 + j * (w + gap) + w / 2, y0 - 8);
    }
    /* the two bands ruling 3 is about, as the frame really painted them: a
       10 px face on a middle baseline is 5 px either side of its own y */
    var colBand = { x: x0, y: y0 - 8 - 5, w: G.gw, h: 10 };
    ctx.textAlign = 'right';
    for (i = 0; i < n; i++) {
      ctx.fillText(poolTag(g.rows[i]) + (i + 1), x0 - 6, y0 + i * (h + gap) + h / 2);
    }
    ctx.font = '400 10px "Source Sans 3", system-ui, sans-serif';
    ctx.fillStyle = ink(0.62);
    ctx.textAlign = 'left';
    var headTxt = poolWords(g.rows) === poolWords(g.cols)
                   ? ('Down and across: ' + poolWords(g.rows) + '.')
                   : ('Down: ' + poolWords(g.rows) + '.   Across: ' + poolWords(g.cols) + '.');
    ctx.fillText(headTxt, lx0, y0 - G.TA + 8);
    var headBand = { x: lx0, y: y0 - G.TA + 8 - 5,
                     w: Math.ceil(ctx.measureText(headTxt).width), h: 10 };
    /* the diagonal, named in the corner it starts in, with a tick into the
       first cell it owns. Ruling 7: it is drawn only when the grid really HAS
       a diagonal, which is the same test the ring itself uses. */
    if (G.wide && hasDiag) {
      /* s7.24 ruling 10: THE WORDS LIVE IN THE LEGEND. The corner carried the
         label "same partner" on the column headers' own baseline, one cell to
         the left of "S1", and the dark judge read it as the name of that
         column. The corner keeps its TICK, which is a mark and not a claim,
         and the legend below the grid is where the phrase is explained
         ("same partner: they trained together") with the ringed swatch beside
         it. Nothing that names the diagonal is painted in the axis band. */
      ctx.strokeStyle = accent();
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0 - 5, y0 - 4);
      ctx.lineTo(x0 + 4, y0 + 5);
      ctx.stroke();
    }
    /* the visitor's own row, drawn under the grid once Take a row has run */
    var rows = n;
    if (g.row) {
      var ry = y0 + n * (h + gap);
      ctx.font = '700 11px "Source Sans 3", system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = ink(0.95);
      ctx.fillText('You', x0 - 6, ry + h / 2);
      for (j = 0; j < n; j++) {
        drawGridCell(x0 + j * (w + gap), ry, w, h, g.row[j], false, G.wide);
      }
      gridCells.rowY = ry;
      rows = n + 1;
    }
    /* ---- the legend. One ramp, both ends named, and the diagonal's ring.
       It is laid out left to right from the block's own left edge, so no part
       of it can be pushed off the page. */
    var ly = y0 + rows * (h + gap) + (G.wide ? 12 : 9);
    var rw = Math.max(56, Math.min(130, G.gw * 0.22)), k, steps = 24;
    var HELD = 'the keep held, ' + HP_KEEP + ' of ' + HP_KEEP;
    var DIAG = diagLab + ': they trained together';
    ctx.textBaseline = 'middle';
    ctx.font = '400 10px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = ink(0.75);
    var lx = lx0;
    ctx.fillText('the keep fell', lx, ly + 5);
    lx += ctx.measureText('the keep fell').width + 6;
    for (k = 0; k < steps; k++) {
      ctx.fillStyle = gridTint(HP_KEEP * (k / (steps - 1)), 0.95);
      ctx.fillRect(lx + Math.round(rw * k / steps), ly, Math.ceil(rw / steps) + 1, 10);
    }
    lx += rw + 6;
    ctx.fillStyle = ink(0.75);
    ctx.fillText(HELD, lx, ly + 5);
    lx += ctx.measureText(HELD).width + 18;
    /* Ruling 7, twice over. The entry is drawn only when a diagonal EXISTS (it
       explained a ring no cell wore in the crossed pool), and when it exists it
       is KEPT ON A PHONE: it used to be dropped whenever it did not fit on the
       ramp's own line, which is every phone, leaving the blue outlines
       unexplained on the smaller picture that needs the explaining most. It
       wraps to a second line instead. */
    var legendDiag = false;
    if (hasDiag) {
      var dw2 = 20 + ctx.measureText(DIAG).width;
      var dx2 = lx, dy2 = ly;
      if (lx + dw2 > stripW() - 6) { dx2 = lx0; dy2 = ly + 15; }
      ctx.strokeStyle = accent();
      ctx.lineWidth = 2;
      ctx.strokeRect(dx2 + 0.5, dy2 + 0.5, 13, 9);
      ctx.lineWidth = 1;
      ctx.fillStyle = ink(0.75);
      ctx.fillText(DIAG, dx2 + 19, dy2 + 5);
      legendDiag = true;
    }
    ctx.restore();
    /* what the room under the picture starts at, for slotPlan (ruling 10) */
    galleryBottom = ly + (legendDiag && dy2 > ly ? 30 : 15);
    gridDrawn = { tints: tints, numbers: nums, axis: n, legend: true,
                  legendDiag: legendDiag, hasDiag: hasDiag,
                  cornerDiag: !!(G.wide && hasDiag),
                  diag: diagLab, you: !!g.row, box: G,
                  /* s7.17 ruling 3: a probe reads the two bands the frame
                     really painted rather than re-deriving them from here */
                  head: headBand, colLab: colBand };
  }

  /* ------------------------------------------------- the live board caption
     Build spec v3 s7.15 ruling 2. The caption used to be written once when an
     act started and never again: all three ship-gate lanes watched it read
     "Your turn. Build..." with its superseded where-to-build clause through the
     whole attack and after the keep had fallen. It is now DRIVEN BY THE LIVE PHASE, so it changes at
     every phase boundary and the visitor is never told a thing that stopped
     being true. The act's own lead sentence is what shows before a game is
     under way, and it also lives in the panel prose, which is where the
     longer form belongs. */
  function phaseLine() {
    if (!S || act.name === 'plans' || act.name === 'strangers' || act.name === 'fine') return '';
    var hp = Math.max(0, Math.round(keepHp(S)));
    if (S.over || S.phase === 'over') {
      /* s7.19 ruling 6: a result is a thing the visitor's own browser did, so
         it is not printed until this page really finished the game. Nothing
         else sets `resolved`, so a board that arrived over some other way
         says what it is instead of announcing a score nobody watched. */
      if (!S.resolved) return '';
      /* s7.24 ruling 10: ONCE ON THE BOARD AND ONCE IN THE PANEL. The end mark
         is the board's own announcement of the result; while it is standing
         the caption under the board said the same thing in the same words, so
         a finished game was announced three times at once (the dark judge's
         nit: the mark, the plate, and the panel line). The caption takes the
         next true thing to say instead, and comes back to the result when the
         mark has been dismissed or has shrunk into the corner. */
      if (endMark && endMark.form === 'full') {
        return 'This game is finished. New game starts another.';
      }
      return hp > 0 ? ('The keep held at ' + hp + ' of ' + HP_KEEP + '.') : 'The keep fell.';
    }
    if (S.phase === 'build') {
      if (act.name === 'you') {
        if (S.buildDone) return 'Your build is finished. The wave is next.';
        /* s7.19 ruling 2 and the panel critic's revision 4: at zero the page
           was telling the visitor to build with both piece buttons disabled */
        if (budgetLeft() < cheapestCost()) {
          /* s7.21 ruling 10: the budget is base plus a small random offset, so
             ending a build phase with a few credits left is common, and "No
             budget left." then sat beside a panel reading "Budget 1 left". The
             caption says what is true of BOTH numbers.
             s7.22 ruling 7 re-cuts the threshold: the line prints when the
             budget is BELOW THE PRICE OF THE CHEAPEST PIECE, not "at 1 or 2".
             A wall costs 2, so at 2 left the visitor can still build and the
             page is right to say so; the ruling's "or 2" was a transcription
             of the critic's "at 1". */
          return 'Not enough left to build. Press Done building to start the wave.';
        }
        /* s7.22 ruling 1: the sentence a visitor carried out of the
           walkthrough invited them to build on any tile at all, and most tiles
           answer no. The replacement was set on FX.caption, which captionPump can never reach in this
           act because this function returns a line in every phase of it (0 of
           848 samples over two sessions). So the BUILD phase line owns it: the
           lit band IS the answer to "where", and the press that starts the
           wave is named in the same breath. */
        /* s7.26 ruling 4: the mark at rest is one boundary round the legal
           region, not a box per tile, so the sentence names the AREA */
        return 'Build inside the lit area, then press Done building.';
      }
      return (S.wave > 0) ? ('Wave held. Repairing, then building again.')
                          : 'Both engineers are building, at the same time.';
    }
    return 'Wave ' + Math.min(WAVES, S.wave + 1) + ' of ' + WAVES + '.';
  }

  /* ---- the act that cannot show its own instrument (s7.22 ruling 7) -------
     At 390 x 620 (a phone in a short window, or a landscape handset) the room
     under the board is smaller than the smallest readable bar plate, and the
     bars stand below the board or not at all (s7.21 ruling 6). The act then
     drew a board and said nothing about the six bars its whole copy is about.
     It says so now, in the one surface a phone always shows: the board
     caption. The reading is taken from the frame's OWN slot plan, and only
     after this act has really measured the room, so the line cannot flash
     during the frames an act change takes to lay itself out. */
  /* ---- s7.28 ruling 3: WHAT THE BARS SAY, IN ONE SENTENCE -----------------
     The plate is the act, and where a phone's room under the board will not
     hold it the act used to print an instruction nobody on a phone can
     follow. The reader's own leading guess is one short sentence, read out of
     the same array the plate draws from (never a typed number), so the act
     still says the thing it exists to say. */
  function barsLeadLine() {
    var b = FX.bars, i, best = -1, bv = -1;
    if (!b || !b.raw || !b.shorts) return '';
    for (i = 0; i < 6; i++) {
      if (typeof b.raw[i] === 'number' && b.raw[i] > bv) { bv = b.raw[i]; best = i; }
    }
    if (best < 0 || !(bv >= 0)) return '';
    return barsHeader(b) + ': ' + b.shorts[best] + ', ' +
           Math.round(bv * 100) + ' percent.';
  }

  function barsRoomLine() {
    if (act.name !== 'reader' || !FX.bars) return '';
    if (!barsWanted() || slotFrames < 2) return '';
    /* ---- s7.28 ruling 3: THE PHONE IS NEVER ASKED TO RESIZE ITSELF --------
       "Make the window taller to see the bars settle." is a true sentence and
       an impossible instruction on a phone, and the dark judge read it as one
       of the six acts being a dead end there. On a phone the act says what
       the reader thinks instead; the six numbers are in the screen-reader
       table either way. The desktop clause below is unchanged, because a
       desktop window CAN be made taller. */
    if (phone()) {
      if (slotNow && slotNow.bars) return '';
      return barsLeadLine();
    }
    /* s7.24 ruling 7: the same sentence answers the same thing on a desktop
       window too short to reserve the band, where the plate would otherwise
       have stood on the board */
    else if (!barsNoRoom) return '';
    return 'Make the window taller to see the bars settle.';
  }

  /* everything the board caption could say, in the order the page prefers it */
  function captionWant() {
    /* s7.26 ruling 8: on a phone the Six plans card IS the caption row once a
       plan has been tapped. The room between the gallery and the act strip
       holds 74 px, the tapped plan's own sentence needs about 92, and the card
       was cutting it behind an overflow: hidden. The caption's invitation has
       been taken by then ("Tap a plan to read what it built."), so the row goes
       to the answer, and the moment nothing is selected the caption is back.
       The act's own count sentence is still in the panel and in the
       screen-reader table, which is where a gallery's prose lives. */
    if (phone() && act.name === 'plans' && planTapLine()) return '';
    /* ---- s7.29 ruling 3: THE TILE CLICK ANSWERS ON THE DESKTOP TOO --------
       The caption promised "Click a plan to read what it built." and the
       answer went only to the panel's status slot and to the phone's caption
       card, which a desktop never builds (buildCapcard stands down at 600 px).
       The dark lane clicked tiles with a real mouse, diffed the tile region,
       got zero bytes and filed a dead affordance. On the desktop the board's
       own caption IS the card, so it carries the answer there. */
    if (!phone() && act.name === 'plans') {
      var pt = planTapLine();
      if (pt) return pt;
    }
    var t = rmCaption() || barsRoomLine() || phaseLine();
    if (t) return t;
    /* s7.29 ruling 5: an empty column is named under the picture that has it */
    if (act.name === 'strangers') {
      var dn = gridDeadRunNote();
      if (dn) return ((FX.caption || '') + ' ' + dn).replace(/^\s+/, '');
    }
    /* s7.23 ruling 3: the invitation rides the GALLERY'S OWN caption, and only
       the drawn one, so the sentence is said once on the surface a phone
       always shows and is not repeated into the status line */
    return planTapInvite(FX.caption || '') || '';
  }

  /* ------------------------------------------------- the caption's own dwell
     Build spec v3 s7.19 ruling 2. The ship-gate auditor measured the board
     caption being re-derived every frame with no dwell of its own: a wave
     boundary drew "Wave held. Repairing, then building again." for about 500
     ms before "Wave 3 of 3." took it, four times a session, and one caption in
     Six plans lived 91 ms. The panel's status line has had a 1.5 s queue since
     s7.15 ruling 2; the caption now goes through the same law, so the two
     surfaces cannot disagree by more than one dwell and nothing on the board
     is written faster than it can be read.

     `capWant` is what the live phase says right now, `capShown` is what the
     frame is allowed to draw, and a USER ACTION (an act change, a placement)
     replaces the line at once through capForce, because an answer to a click
     that arrives 1.5 s late is worse than no answer. */
  var CAP_DWELL = 1500;
  var capShown = '', capWant = '', capAt = -1e9, capLog = [];

  function capNote(txt, forced) {
    /* The forced flag is the same distinction the status queue makes: a line a
       USER ACTION replaced did not fail its dwell, it was answered by the page
       at once, which is what s7.15 ruling 2 asked for on the status line. */
    capLog.push({ t: now(), text: txt, forced: !!forced, act: act.name });
    if (capLog.length > 200) capLog.shift();
  }

  function capForce(txt) {
    capShown = txt || '';
    capWant = capShown;
    capAt = now();
    capNote(capShown, true);
  }

  /* one advance per PAINTED frame, from the live phase, exactly as the status
     queue advances from its own clock */
  function captionPump() {
    /* s7.24 ruling 4: the caption floor eases once per painted frame, here,
       so the two callers of captionGeom in one paint cannot advance it twice */
    stepCapPad();
    /* ruling 6: under reduced motion the still SAYS it is a still. The result
       itself is on the board mark and in the status line, so nothing is lost
       by giving the caption to the explanation. */
    var want = captionWant();
    if (want !== capWant) capWant = want;
    if (capWant === capShown) return;
    if (now() - capAt < CAP_DWELL) return;
    capShown = capWant;
    capAt = now();
    capNote(capShown);
  }

  /* Every act caption carries the prefix while the loud state holds (D5
     section 5). The prefix is added here, at the last moment, so nothing
     that reads FX.caption back gets a doctored string. */
  function captionText() {
    var t = capShown;
    if (!t) return '';
    return VERIFY.plate ? ('unverified: ' + t) : t;
  }

  /* ---------------------------------------------- the end-of-game moment
     Ruling 2 again: "the game ends with a visible board moment (a caption and
     a board-level mark)". Three lanes finished games and never once saw the
     result where they were looking. */
  /* s7.19 ruling 2: the mark dismisses on the next input, and if nobody
     touches anything it SHRINKS TO THE CORNER after 6 s rather than standing
     across the middle of the map for as long as the tab is open (a judge idled
     over a minute under it). The result itself never leaves: it is in the
     caption, in the status line and in the corner form. */
  var END_SHRINK_MS = 6000;
  var endMarkAt = 0, endMarkGone = false;

  function resetEndMark() {
    endMarkAt = 0; endMarkGone = false; endMark = null;
    endCorner = null;             /* s7.28 ruling 5's memo is the game's */
  }

  /* ---- s7.26 ruling 7: THE OUTCOME STAYS ON THE BOARD ---------------------
     The big plate used to vanish on the next input, which on a phone is the
     tap a visitor makes the moment the wave stops: the light judge finished a
     game there, got no outcome sentence at all and had to open the collapsed
     panel to learn that the keep had fallen. Dismissing now SHRINKS the mark
     to its corner form ("The keep fell, wave 3"), which is small, out of the
     picture's way, and the same sentence the desktop shows. It goes when the
     game does (`resetEndMark`), and never before. */
  function dismissEndMark() {
    if (endMarkAt && !endMarkGone) endMarkAt = now() - END_SHRINK_MS - 1;
  }

  function drawEndMark() {
    endMark = null;
    if (!S || !(S.over || S.phase === 'over') || !view) return;
    /* s7.19 ruling 6: never a result banner for a game this page did not play */
    if (!S.resolved || endMarkGone) return;
    var b = boxes.board || { x: view.ox, y: view.oy, w: view.bw || 0, h: view.bh || 0 };
    if (!b.w || !b.h) return;
    var hp = Math.max(0, Math.round(keepHp(S)));
    var held = hp > 0;
    var line = held ? 'The keep held' : 'The keep fell';
    var sub = held ? (hp + ' of ' + HP_KEEP) : ('wave ' + Math.max(1, Math.min(WAVES, S.wave)));
    if (endMarkAt && (now() - endMarkAt) > END_SHRINK_MS) {
      drawEndCorner(b, held, line, sub);
      return;
    }
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var big = Math.max(20, Math.min(40, Math.round(b.w * 0.035)));
    ctx.font = '700 ' + big + 'px "Source Sans 3", system-ui, sans-serif';
    var w1 = ctx.measureText(line).width;
    ctx.font = '400 ' + Math.round(big * 0.62) + 'px "Source Sans 3", system-ui, sans-serif';
    var w2 = ctx.measureText(sub).width;
    var pw = Math.round(Math.max(w1, w2) + 44), ph = Math.round(big * 2.5);
    var px = Math.round(b.x + (b.w - pw) / 2);
    var py = Math.round(b.y + b.h * 0.34 - ph / 2);
    ctx.fillStyle = plateCol(0.9);
    ctx.fillRect(px, py, pw, ph);
    ctx.fillStyle = held ? accent() : WARM;
    ctx.fillRect(px, py, pw, 3);
    ctx.fillStyle = ink(0.95);
    ctx.font = '700 ' + big + 'px "Source Sans 3", system-ui, sans-serif';
    ctx.fillText(line, px + pw / 2, py + ph * 0.40);
    ctx.fillStyle = ink(0.7);
    ctx.font = '400 ' + Math.round(big * 0.62) + 'px "Source Sans 3", system-ui, sans-serif';
    ctx.fillText(sub, px + pw / 2, py + ph * 0.74);
    ctx.restore();
    endMark = { x: px, y: py, w: pw, h: ph, held: held, hp: hp, form: 'full' };
  }

  /* ---- s7.28 ruling 5: THE CELLS A PLATE MAY NOT COVER --------------------
     The keep, the three gate mouths and every piece on the board: the castle
     the score is about, the doors the walkers come through, and the things a
     visitor just built. The keep and the gate cells are a property of the
     board, so they are cached on the renderer's own terrain key; the pieces
     come from the state the frame was drawn from, so the list is the frame's
     and never a remembered one. */
  var protCells = null, protKey = '';
  function protectedCells() {
    var G = RAPI && RAPI.GEO;
    var key = (RC && RC.MAP_KEY) ? String(RC.MAP_KEY) : '-';
    if (protKey !== key || !protCells) {
      protCells = [];
      protKey = key;
      if (G && G.isKeepCell && G.isGate) {
        for (var i = 0; i < CELLS; i++) {
          var c = i % COLS, r = (i / COLS) | 0;
          if (G.isKeepCell(c, r) || G.isGate(c, r)) protCells.push(i);
        }
      }
    }
    return protCells;
  }

  /* how many of those cells, plus how many pieces really on the board, the
     plate would cover. A machine is taller than its foot cell, so its own
     drawn body is what is asked for (s7.24 ruling 8's rect). */
  function plateCovers(box) {
    if (!box || !view || view.fallback || !R || !RAPI || !RAPI.cellRect) return 0;
    var list = protectedCells(), n = 0, i, cell, q;
    for (i = 0; i < list.length; i++) {
      q = RAPI.cellRect(view, list[i]);
      if (q && rectOverlap(box, q) > 0) n++;
    }
    for (cell = 0; cell < CELLS; cell++) {
      if (!RS.piece[cell]) continue;
      q = (RS.piece[cell] === PIECE_GUN && R.machineBox)
        ? R.machineBox(view, cell) : RAPI.cellRect(view, cell);
      if (q && rectOverlap(box, q) > 0) n++;
    }
    return n;
  }

  /* the same fact, small, in a corner of the board that covers nothing */
  function drawEndCorner(b, held, line, sub) {
    var txt = line + ', ' + sub;
    /* s7.26 ruling 7: the corner is the DRAWN board's, so under the framed
       desktop wave (or a phone's follow camera) the sentence stays on screen
       instead of riding a plate that is mostly outside the viewport */
    var dr = drawnBoardRect();
    if (dr && dr.w > 40 && dr.h > 40) b = dr;
    ctx.save();
    ctx.font = '600 12px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    var w = Math.ceil(ctx.measureText(txt).width) + 20, h = 24;
    /* ---- s7.28 ruling 5: A CORNER THAT COVERS NOTHING ---------------------
       The tag took the top right corner whatever was drawn there, and on
       this board that corner is the east gate: the light reduced-motion
       judge photographed "The keep held, 100 of 100" printed across the
       gate structures on the desktop and across the partner's own walls on
       the phone. The four corners are tried IN ORDER, today's first so that
       nothing moves on a board where it was already clear, and the first one
       covering no keep cell, no gate cell and no piece wins. Where every
       corner covers something the one covering the FEWEST wins, with the
       keep readout's own box as the tie break, because a tag over the number
       it repeats is the one collision a visitor would call a fault. */
    var pad = 8;
    /* the answer is a function of the drawn rect, the tag's own width and
       the pieces on the board, and by the time this tag is up none of the
       three is moving, so it is solved once and remembered: the scan is
       about five hundred cells and this runs every frame of a finished
       game. */
    var sig = Math.round(b.x) + ',' + Math.round(b.y) + ',' + Math.round(b.w) +
              ',' + Math.round(b.h) + ',' + w + ',' + pieceSig() +
              ',' + (keepNumBox ? Math.round(keepNumBox.x) + ':' + Math.round(keepNumBox.y) : '-');
    if (endCorner && endCorner.sig === sig) {
      var pick = endCorner.pick, pickCost = endCorner.cost;
    } else {
      var cands = [
        { x: b.x + b.w - w - pad, y: b.y + pad, key: 'tr' },
        { x: b.x + pad, y: b.y + pad, key: 'tl' },
        { x: b.x + b.w - w - pad, y: b.y + b.h - h - pad, key: 'br' },
        { x: b.x + pad, y: b.y + b.h - h - pad, key: 'bl' }
      ];
      pick = null; pickCost = Infinity;
      var ci, cand, box, cost;
      for (ci = 0; ci < cands.length; ci++) {
        cand = cands[ci];
        box = { x: Math.round(Math.max(b.x, Math.min(b.x + b.w - w, cand.x))),
                y: Math.round(Math.max(b.y, Math.min(b.y + b.h - h, cand.y))),
                w: w, h: h };
        cost = plateCovers(box);
        /* the readout is a tie break, not a veto: it is one box and the cells
           above are the picture */
        if (keepNumBox && rectOverlap(box, keepNumBox) > 0) cost += 0.5;
        if (cost < pickCost) { pickCost = cost; pick = { box: box, key: cand.key }; }
        if (cost === 0) break;
      }
      endCorner = { sig: sig, pick: pick, cost: pickCost };
    }
    var x = pick ? pick.box.x : Math.round(b.x + b.w - w - pad);
    var y = pick ? pick.box.y : Math.round(b.y + pad);
    if (x < b.x) { x = Math.round(b.x); }
    ctx.fillStyle = plateCol(0.9);
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = held ? accent() : WARM;
    ctx.fillRect(x, y, 3, h);
    ctx.fillStyle = ink(0.9);
    ctx.fillText(txt, x + 12, y + h / 2 + 1);
    ctx.restore();
    endMark = { x: x, y: y, w: w, h: h, held: held,
                hp: Math.max(0, Math.round(keepHp(S))), form: 'corner',
                /* s7.28 ruling 5: which corner the frame took and how many
                   keep, gate and piece cells it really covers */
                corner: pick ? pick.key : 'tr', covers: Math.floor(pickCost) };
  }
  var endMark = null;
  /* s7.28 ruling 5's memo: the corner, and the signature it was solved for */
  var endCorner = null;

  /* a cheap signature of the pieces the last frame drew, so the corner is
     re-solved when the board changes and not once a frame */
  function pieceSig() {
    var h = 2166136261, i;
    for (i = 0; i < CELLS; i++) {
      if (!RS.piece[i]) continue;
      h ^= i; h = Math.imul(h, 16777619);
      h ^= RS.piece[i]; h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  /* The caption strip's geometry WITHOUT drawing it. Build spec v3 s7.10
     ruling 4 needs the honesty plate's rect known before the close up is
     placed, and the plate hangs off the caption, so the caption is measured
     first too. `top` is the TOP of the caption box in CSS px whether a caption
     was drawn or not, which is what the plate sits above. */
  /* ---- the caption's floor, and which of the two it takes (s7.24 ruling 4) --
     There are two honest bottom pads on a phone. `view.botPad` is the one
     landBias spent to push the board UP the stage (s7.15 ruling 5), and the
     caption riding it keeps the sentence under the picture with the room below
     for the caption card, the legend and the bars (s7.17 ruling 2). The
     LAYOUT's own pad is the room the page's chrome really needs. They differ
     by whatever landBias spent, and while the walkthrough card is standing the
     caption card is suppressed by design, so that difference is an empty band
     between the caption and the card: 57 px, which is the dead space the light
     reduced-motion judge reported. So the caption takes the chrome's floor on
     exactly that beat and the board's floor everywhere else, and the change
     between them is EASED (about 2.6 px a frame) rather than cut, because the
     plate may never teleport (s7.21 ruling 2). */
  function layoutPadBot() {
    var vp = view ? (view.botPad || 0) : 0;
    var lo = (layoutOpts && isFinite(layoutOpts.botPad)) ? layoutOpts.botPad : null;
    return (lo === null) ? vp : Math.min(vp, lo);
  }

  var CAPPAD_MS = 300;
  var capPad = { k: 0, at: 0 };
  /* s7.28 ruling 2: the gap the phone's caption plate keeps below the drawn
     frame's outer bottom edge. The bar is four pixels; this is six. */
  var CAP_FRAME_CLEAR = 6;

  function capPadWant() { return (phone() && coachShown()) ? 1 : 0; }

  function stepCapPad() {
    var want = capPadWant(), t = now();
    var dt = (capPad.at > 0 && t > capPad.at) ? Math.min(80, t - capPad.at) : 16;
    capPad.at = t;
    /* reduced motion takes the cut, which is the right answer there */
    if (reducedMotion()) { capPad.k = want; return; }
    var step = dt / CAPPAD_MS;
    if (want > capPad.k) capPad.k = Math.min(1, capPad.k + step);
    else if (want < capPad.k) capPad.k = Math.max(0, capPad.k - step);
  }

  function capPadNow() {
    var high = view ? (view.botPad || 0) : 0;
    var low = layoutPadBot();
    if (!(capPad.k > 0)) return high;
    if (capPad.k >= 1) return low;
    return high + (low - high) * bandEase(capPad.k);
  }

  /* ---- s7.26 ruling 6, the PHONE half: the card sits below the bars -------
     The plate is placed from the bottom pad, and on a phone with the
     walkthrough card up that pad parks it about 150 px BELOW the board, in the
     middle of the room the act's own picture wants. `phoneSlot` measures the
     room from the plate's foot down to the card, so at the bars beat it
     measured 5 px, refused the bars and the act printed "Make the window
     taller to see the bars settle." beside the very card that had taken the
     room (measured at 390x844: plate top 520, slot null, the sentence up).

     The drop below only ever moves the plate DOWN to the picture's foot. When
     the card is up AND the act's picture is asking for that room, it moves the
     plate UP to the same line, so the order down the page is board, caption,
     bars, card, strip. Scoped to that case on purpose: outside the
     walkthrough, and in every act whose picture is not asking, the plate keeps
     the placement every earlier round measured. */
  function capHugsPic() {
    return coachShown() && barsWanted() && !!FX.bars;
  }

  function captionGeom(keepG) {
    /* capLift: on a phone the board is slid up off the renderer's centred fit
       (phoneLift), and the BOARD's caption goes with it, so the sentence stays
       under the picture it is about instead of floating in the room the
       caption card now uses (s7.17 ruling 2) */
    /* s7.21 ruling 9: "captions, plate and HUD are unaffected" by the desktop
       wave framing. `landBias` lays the follow view out against its own bottom
       pad, so reading `view.botPad` while the camera was engaged moved the
       caption 52 px and back. The RESTING pad is what the caption is placed
       from on a desktop; the phone's own lift (capLift) is what moves there,
       and it is eased. */
    /* ---- s7.24 ruling 4: the caption is placed from the ROOM THE CHROME
       NEEDS, not from the pad landBias spent. `landBias` raises the bottom pad
       to push the board up the stage (s7.15 ruling 5), so `view.botPad` is the
       board's arrangement and not the page's furniture: at 390x844 with the
       walkthrough card up it read 422 against the 381 the card and the strip
       really need, and the caption parked 53 px above the card with nothing in
       between. That band is what the light reduced-motion judge called dead
       space. The layout's own pad is the honest floor, and the phone's drop to
       the picture's foot still holds the plate under the board. */
    var padNow = capPadNow();
    var botPad = (follow.k > 0 && follow.k < 1 && capPadRest > 0)
      ? (capPadRest + (padNow - capPadRest) * followEase(follow.k))
      : padNow;
    var y = cssH - botPad - 12 - capLift;
    var txt = captionText();
    /* s7.19 ruling 2: no caption strip is painted while a full page panel is
       open. The critic found "What is" stranded at (356, 690) on an otherwise
       blank page behind the fine print, and the tour's Strangers beat printed
       the caption straight through the legend. */
    if (modalOpen()) return { top: y, box: null };
    if (!txt || y < (view.topPad || 0) + 30) return { top: y, box: null };
    /* s7.19 ruling 2: the plate has a FIXED WIDTH PER ACT and the text wraps
       inside it. The auditor watched it snap 97 px, 273 px and back inside
       half a second, twice, with no ease; a plate that changes shape every
       time the sentence does is a second animation nobody asked for. */
    var boxW = capPlateW();
    var maxW = boxW - 28;
    ctx.save();
    ctx.font = '400 14px "Source Sans 3", system-ui, sans-serif';
    var lines = wrap(txt, maxW);
    ctx.restore();
    /* s7.21 ruling 7: the plate sits ON its text. The box is derived from the
       text block it backs (n lines of lh, with the last line's baseline at y)
       and an equal pad above and below, so a one-line and a three-line caption
       are backed the same way. */
    var lh = 18, n = lines.length, pad = 7;
    var boxH = n * lh + pad * 2;
    var mid = stripW() / 2;
    var top = y + 4 - n * lh - pad;
    /* s7.21 rulings 6 and 7: the plate never draws over the keep readout. The
       caption is the thing that yields, because the readout is anchored to the
       meter it labels. */
    /* s7.17 ruling 2 and s7.21 ruling 6: on a phone the caption belongs UNDER
       the picture, not on its last rows. Its natural y comes from the bottom
       pad, and the pad and the lifted board do not have to agree: in Your turn
       the taller act strip put the plate 20 px inside the board. It is dropped
       to the picture's own foot, which is also what keeps the room under it
       (the legend row, the bars, the card) off the board. */
    /* ONLY while the whole board is on screen: under the follow camera the
       view's own height is the WHOLE source at S = 3, most of it outside the
       viewport, so "below the picture" would push the caption off the page and
       snap it back when the camera let go (found by this wave's ruling 2
       lane: a 153 px step at 42 s). */
    if (phone() && !galleryAct() && !view.fallback && picBotRest > 0) {
      /* the drop is EASED by the same curve the two views are (s7.21 ruling 2:
         the plate never teleports): at rest it is the whole drop, under the
         follow camera it is none, and in between it travels. It is measured
         from the RESTING picture, because the follow view's own height is the
         whole source at S = 3 with most of it outside the viewport. */
      var kk = 1 - followEase(follow.k);
      var wantTop = picBotRest + CAP_FRAME_CLEAR;
      /* s7.22 ruling 7: the drop never puts the plate into the act strip. At
         390x620 the picture's foot is BELOW the room the bottom pad leaves, so
         the plate printed its last 17 px behind the strip: measured in Watch a
         wave as well as in the reader act, so it is the caption's law and not
         one sentence's. The pad is what the strip's own rect already sets. */
      /* ---- s7.28 ruling 2: THE FLOOR IS THE CHROME'S, NOT landBias's -------
         This clamp read `botPad`, which on a phone is the pad landBias spent
         to push the board UP the stage (422 px at 390x844) rather than the
         room the strip and the corner buttons really need (372). The plate's
         own floor was therefore 50 px higher than the page's furniture asks,
         and the clamp pulled the plate back ONTO the picture: 4.5 px over the
         drawn frame's outer bottom edge in Watch a wave and in Reading the
         plan, in both themes, which is what the light lane photographed. The
         honest floor is the one layoutPadBot() already computes for exactly
         this question (s7.24 ruling 4), and it is measured from the strip's
         own rect, so ruling 7's guarantee is unchanged. On a window too short
         to hold both (390x620) the clamp still wins and the crossing is
         disclosed. */
      var floorTop = cssH - layoutPadBot() - boxH - 4;
      if (wantTop > floorTop) wantTop = floorTop;
      if (top < wantTop) {
        var dy = (wantTop - top) * kk;
        top += dy; y += dy;
      } else if (capHugsPic() && top > wantTop) {
        var du = (top - wantTop) * kk;
        top -= du; y -= du;
      }
    }
    /* ---- s7.26 ruling 5: THE CAPTION ROW IS BELOW THE BOARD -----------------
       On a desktop the plate is placed from the bottom pad, and in Watch a
       wave and Your turn `landBias` leaves the picture well above that pad, so
       the row lands 3 px under the board's foot and the light reduced-motion
       judge called that placement the law. In Reading the plan the bars take
       the slack out of the top pad, `landBias` has nothing left to spend and
       the picture reaches the pad line, so the plate and the Step control were
       drawn across the board's last rows, over the keep's health meter and its
       "Keep 84 of 100" label.

       The plate is centred and the page's chrome is in the corners, so the row
       may hang BELOW the chrome floor without touching anything: its real
       floor is the viewport. The board's own foot is the resting frame's, so
       the framed wave cannot move the row. */
    if (!phone() && !galleryAct() && view && !view.fallback && frameBotRest > 0) {
      var wantD = Math.round(frameBotRest + CAP_ROW_GAP);
      var floorD = Math.round(cssH - CAP_ROW_EDGE - boxH);
      if (wantD > floorD) wantD = floorD;
      if (top < wantD) { var dd = wantD - top; top += dd; y += dd; }
    }
    return captionClear({ top: top, y: y, lh: lh, mid: mid, lines: lines,
                          box: { x: Math.round(mid - boxW / 2), y: top,
                                 w: boxW, h: boxH } }, keepG);
  }

  /* s7.21 rulings 6 and 7: the plate never draws over the keep readout. The
     READOUT is measured clear of the caption's NATURAL box first (it is the
     one the viewport clamp was putting under the caption in the first place),
     so this lift is a fallback that in the ordinary case is ZERO. It has to
     be: a collision-avoidance offset that switches on and off part way through
     the camera's ease is a 51 px step in a picture where everything else
     glides, which is exactly what the ruling-2 and ruling-9 lanes measured. */
  function captionClear(g, keepG) {
    if (!g || !g.box || !keepG) return g;
    /* ---- s7.26 ruling 11: THE PLATE DOES NOT FLICK -------------------------
       The round-5 auditor measured the plate leaving its resting y for one or
       two frames at the desktop camera's engage, 51 to 54 px UP and onto the
       board, in 6 of 10 engages, always 16 to 40 ms after the readout's
       handover between the renderer's meter and the page's own line. That is
       this lift: for a frame or two mid-handover the readout's box is where
       the caption wants to be, the caption yields, and the next frame it does
       not. A single-frame jump nobody asked for is worse than a caption that
       sits still under a readout that is on its way somewhere: the lift waits
       for the handover to settle, which is at most 280 ms, and then places
       itself once. */
    if (keepFlightLive()) return g;
    var b = g.box;
    if (!(b.x < keepG.x + keepG.w && b.x + b.w > keepG.x &&
          b.y < keepG.y + keepG.h && b.y + b.h > keepG.y)) return g;
    var lift = Math.ceil(b.y + b.h - keepG.y) + 4;
    g.top -= lift; g.y -= lift; b.y -= lift;
    return g;
  }

  /* s7.26 ruling 5: the air between the board's foot and the caption row, and
     the air the row keeps above the viewport's own bottom edge. The gap is the
     3 px Watch a wave already had (board foot 674, plate top 677), which is
     the placement the ruling names as the law. */
  var CAP_ROW_GAP = 3;
  var CAP_ROW_EDGE = 8;
  /* and the room the board's own bottom pad gives up so the row has somewhere
     to be: a two line plate (50) plus the gap and a little air. A three line
     caption hangs into the chrome's own band, which is empty in the middle of
     the page where the plate is centred. */
  var CAP_ROW_H = 56;

  /* One number per act, and it only moves when the VIEWPORT does: three lines
     of the longest caption any act carries fit inside it at both sizes. */
  function capPlateW() {
    return Math.round(Math.max(220, Math.min(440, stripW() - 48)));
  }

  /* ---- the room under the board on a phone (s7.17 ruling 2) ---------------
     At a real phone's pixel ratio the whole board is 178 css px tall in an
     844 px page, and the layout left 171 px of empty page between the board
     caption and the act strip on the landing and in Reading the plan (125 in
     Your turn) while the reader's bar block was painted OVER that small board
     and the build close up stood over half its height. Everything an act shows
     beside the picture now lives HERE, between the board caption and the act
     strip, and nothing is drawn on the board.

     The plan is decided ONCE per frame, from the caption geometry and the
     strip's own measured rect, and it is what the bars, the build close up and
     the DOM caption card all read. It never reads its own tenants' positions,
     so it cannot oscillate. */
  var SLOT_PAD = 6;
  /* The card's own text is laid out on a FIXED 18 px line so the number of
     lines it shows can be made whole: a card sized to whatever the room had
     left over ends on half a line, which reads as a bug rather than as a card
     with more in it. A scrolling box clips at its PADDING edge, so what is
     visible before anyone scrolls is h - border - padding-TOP, and the snap is
     therefore spent on the top padding, not the bottom: bottom padding is
     inside the scrollable area and reserves nothing until you reach the end.
     CARD_LINE and CARD_PAD are in the page's sheet as well; change both. */
  var CARD_LINE = 18;
  var CARD_PAD = 9;                       /* the sheet's padding, both edges */
  var CARD_BORDER = 2;                    /* 1 px on the top and the bottom */
  var CARD_LINES_MIN = 3;
  var CARD_MIN = CARD_BORDER + CARD_PAD + CARD_LINE * CARD_LINES_MIN;
  var slotNow = null;
  /* how many frames this act has measured the room under the board. A caption
     that says "there is no room for the bars" must be drawn from a measurement
     the CURRENT act really took, not from the null slotNow an act starts with
     (s7.22 ruling 7). Reset by resetFx, counted in paint. */
  var slotFrames = 0;

  /* how many whole lines a card h tall really shows before it is scrolled */
  function cardLines(h) {
    return Math.floor((h - CARD_BORDER - CARD_PAD) / CARD_LINE);
  }
  /* the smallest h that shows that many, which is what a card must be worth */
  function cardH(h) {
    var k = cardLines(h);
    return k >= CARD_LINES_MIN ? (CARD_BORDER + CARD_PAD + k * CARD_LINE) : 0;
  }

  /* The close up's own frame, so the plan can reserve it before it is drawn.
     SEAM R2O-S4: PIN R-S5's window is ONE size now and it is the UNION of the
     two old ones, so the card is bigger than the two hard-coded numbers that
     used to stand here (they were the old wall window at 3x). The renderer
     hands back its own size, and the phone slot reserves what will really be
     drawn instead of a box the card no longer fits in. */
  function loupeFrame() {
    if (R && R.closeUpSize) {
      try {
        var s = R.closeUpSize(loupeScale(), 4);
        if (s && s.w > 0 && s.h > 0) return { w: Math.round(s.w), h: Math.round(s.h) };
      } catch (e) {}
    }
    var cs = loupeScale();
    return { w: Math.round(64 * cs) + 8, h: Math.round(60 * cs) + 8 };
  }
  function loupeBoxW() { return loupeFrame().w; }
  function loupeBoxH() { return loupeFrame().h + LOUPE_CAP_H; }

  function slotFloor() {
    var b = cssH - 8;
    if (boxes.coach) b = Math.min(b, boxes.coach.y - 8);
    else if (boxes.actbar && boxes.actbar.height) b = Math.min(b, boxes.actbar.top - 8);
    if (boxes.chat) b = Math.min(b, boxes.chat.y - 8);
    return b;
  }

  function phoneSlot(capG) {
    if (!actbar) return null;
    /* s7.23 ruling 3: `phoneWhole()` asks whether the BOARD fits across the
       page at an integer scale, which is the right question for the room under
       a board and the wrong one for a gallery act, where no board is drawn at
       all. At 320 css px dpr 2 no integer scale fits, so both galleries were
       losing their caption card for a reason that had nothing to do with them,
       and a tapped tile (this ruling) or a tapped Strangers cell (s7.19
       ruling 7) had nowhere on a 320 px phone to be read. The cropped-board
       path is untouched: outside a gallery the test still decides. */
    if (!galleryAct() && !phoneWhole()) return null;
    if (galleryAct() && !phone()) return null;
    var top, floor;
    if (galleryAct()) {
      /* ruling 10: in a gallery act the picture is at the TOP and the caption
         is at the foot of the page, so the room is between them */
      if (!(galleryBottom > 0)) return null;
      top = Math.round(galleryBottom + SLOT_PAD);
      floor = Math.round((capG && capG.box) ? (capG.box.y - SLOT_PAD) : slotFloor());
    } else {
      top = Math.round(((capG && capG.box) ? (capG.box.y + capG.box.h)
                                          : (capG ? capG.top : 0)) + SLOT_PAD);
      /* the room is under the PICTURE as well as under the caption: nothing
         placed in it may stand on the board (s7.17 ruling 2) */
      if (view && !view.fallback) {
        top = Math.max(top, Math.round((view.oy || 0) + (view.bh || 0) + SLOT_PAD));
      }
      floor = Math.round(slotFloor());
    }
    var h = floor - top;
    if (!(h >= CARD_MIN)) return null;
    return { x: 8, y: top, w: Math.max(80, Math.round(stripW()) - 16), h: h };
  }

  /* Who the room belongs to, this act. The act's own PICTURE is served first
     (the bar block in Reading the plan, the build close up in Your turn), and
     the card takes what is left, but only when what is left holds three whole
     lines: below that the picture takes the whole room instead, so the room is
     always full, the card never ends on half a line, and there is never a hole
     above the strip. That is also why a Your turn slot too small for the bars
     as well gives the BARS up rather than putting them back over the board:
     ruling 2 names the close up and the buttons for that act, and the reader's
     guess is the one tenant whose words are already in the panel. */
  function slotPlan(capG) {
    var s = phoneSlot(capG);
    slotNow = null;
    if (!s) return null;
    slotNow = { x: s.x, y: s.y, w: s.w, h: s.h, bars: null, loupe: null, card: null,
                legend: null };
    var colX = s.x, colW = s.w, restY = s.y, restH = s.h, lw, lh, want, ch;
    /* s7.21 ruling 8: on a phone the seat legend is the FIRST row of the room
       under the board, so it names the two colours without painting a pixel on
       the board (s7.17 ruling 2 still holds). */
    if (seatLegendWanted() && restH >= SEAT_LEG_H + 4 + CARD_MIN) {
      slotNow.legend = { x: colX, y: restY, w: colW, h: SEAT_LEG_H };
      restY += SEAT_LEG_H + 4; restH -= SEAT_LEG_H + 4;
    }
    if (loupeOn()) {
      lw = loupeBoxW(); lh = loupeBoxH();
      if (lw + 8 <= s.w && lh <= s.h) {
        slotNow.loupe = { x: s.x + s.w - lw, y: s.y, w: lw, h: lh };
        colW = s.w - lw - SLOT_PAD;
      }
    }
    if (barsWanted() && FX.bars && colW >= 160) {
      want = Math.round(Math.min(barsPlateH(), restH));
      if (cardH(restH - want - SLOT_PAD) <= 0) {
        /* nothing would be left for a card. In READING THE PLAN the bar block
           IS the act and ruling 2 names it for that room, so it takes all of
           it; in YOUR TURN the ruling names the close up and the buttons, and
           the card carries the sentences the collapsed panel hides, so THERE
           the bars are the tenant that yields. They yield to nothing rather
           than going back over a 370 x 178 board. */
        want = (act.name === 'reader') ? Math.round(restH) : 0;
      }
      if (want > 0) {
        slotNow.bars = { x: colX, y: restY, w: colW, h: want };
        restY += want + SLOT_PAD; restH -= want + SLOT_PAD;
      }
    }
    slotNow.free = { x: colX, y: restY, w: colW, h: restH };
    ch = colW >= 120 ? cardH(restH) : 0;
    if (ch > 0) {
      /* the card FILLS the room it was given, and the whole-line snap is spent
         as air ABOVE the first line, so neither a half line nor a hole over
         the strip is ever left over */
      restH = Math.round(restH);
      slotNow.card = { x: colX, y: restY, w: colW, h: restH,
                       lines: cardLines(restH),
                       pad: restH - CARD_BORDER - CARD_LINE * cardLines(restH) };
    }
    /* A machine close up is a thing the visitor asked for by tapping a
       machine, and the DOM card paints over the canvas, so the card yields the
       room to it for as long as it is up rather than leaving it nowhere to go
       but the board. */
    if (loupe.on) slotNow.card = null;
    return slotNow;
  }

  /* the caption plate the last frame really painted, so a probe can measure
     the room under the board instead of re-deriving it (s7.16 ruling 5) */
  var capDrawn = null;
  /* the y a gallery act must stop above, so the caption can never be painted
     through its legend or its tile captions (s7.21 ruling 4) */
  var capTopY = 0;

  /* ---- s7.24 ruling 9: the plate WAITS FOR THE CARD'S FADE ----------------
     On a phone the caption card fades out over 240 ms while the drawn plate
     eases down the same 17 px of screen, and for 7 to 9 frames of it the SAME
     SENTENCE stood twice, one above the other (the round 4 auditor's nit 2,
     photographed). The plate is the one that yields, because the card is on
     its way out: while the card is still on screen carrying that sentence the
     plate does not paint it. It costs the visitor nothing, because the words
     are on screen the whole time, in the card; and it is not a teleport,
     because the plate goes on easing underneath and simply appears where it
     already was when the card has gone. */
  function capcardEchoes(lines) {
    if (!capcard || capcard.hidden || !capcardStatus) return false;
    /* ONLY while the card is on its way out. In steady state the card and the
       plate carry different sentences (the card leads with the status line and
       the plate with the phase), and a rule that fired whenever they happened
       to agree would take the board caption away from a phone visitor, which
       s7.22 ruling 1 forbids. The fade is the 240 ms this is about. */
    if (!capcard.classList.contains('kit-capcard--out')) return false;
    var t = (capcardStatus.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) return false;
    var s = (lines || []).join(' ').replace(/\s+/g, ' ').trim();
    if (!s) return false;
    return t.indexOf(s) >= 0 || s.indexOf(t) >= 0;
  }

  function drawCaption(g) {
    if (!g || !g.box) { capDrawn = null; return; }
    if (phone() && capcardEchoes(g.lines)) { capDrawn = null; return; }
    var i;
    /* s7.21 ruling 7's bar is "the plate sits on its text", so the frame
       reports the LINES it drew as well as the plate it drew them on, and a
       probe measures the drawing instead of guessing which canvas text runs
       belong to the caption. */
    capDrawn = { x: g.box.x, y: g.box.y, w: g.box.w, h: g.box.h, lines: [] };
    ctx.save();
    ctx.font = '400 14px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (i = 0; i < g.lines.length; i++) {
      var lw = 0, m = null;
      try { m = ctx.measureText(g.lines[i]); } catch (e) { m = null; }
      lw = m ? m.width : 0;
      capDrawn.lines.push({ x: g.mid - lw / 2,
                            y: g.y - (g.lines.length - 1 - i) * g.lh - g.lh + 4,
                            w: lw, h: g.lh });
    }
    /* s7.21 ruling 7: in light theme a 0.75 white plate over the WHITE page is
       no plate at all, so a caption that straddles the board's bottom edge
       read as two different treatments: line one grey on the dark scene
       border, line two black on nothing. The plate is near opaque and carries
       a hairline, so it is one plate wherever it lands. */
    ctx.fillStyle = plateCol(0.94);
    ctx.fillRect(g.box.x, g.box.y, g.box.w, g.box.h);
    ctx.strokeStyle = ink(0.16);
    ctx.lineWidth = 1;
    ctx.strokeRect(g.box.x + 0.5, g.box.y + 0.5, g.box.w - 1, g.box.h - 1);
    ctx.fillStyle = ink(0.9);
    for (i = 0; i < g.lines.length; i++) {
      ctx.fillText(g.lines[i], g.mid, g.y - (g.lines.length - 1 - i) * g.lh);
    }
    ctx.restore();
  }

  /* The D5 section 5 plate: persistent, on the canvas, above the caption
     strip, in the one warm colour the art bible allows. The text itself is
     drawn in the body ink so it clears the contrast bar in both themes; the
     warm is the tint, the bar and the border, which is what makes it read as
     a warning rather than another caption. */
  var WARM = '#c4574a';      /* the art bible's one warm colour, both themes */
  var plateBox = null;
  /* where the plate WILL be this frame, measured before anything is drawn so
     the close up can be placed clear of it (s7.10 ruling 4) */
  var plateRect = null;
  /* and the one thing the plate itself yields to: a close up that could find
     no room clear of it. It is set only when the lift in loupePlace failed, so
     in the ordinary case the plate does not move at all. */
  var plateAvoid = null;
  /* test hook, the twin of hideBars: one frame with the plate suppressed, so a
     probe can diff two frames and get exactly the pixels the plate owns */
  var plateHidden = false;

  function verifyPlateGeom(bottomY) {
    if (!VERIFY.plate || !view) return null;
    ctx.save();
    ctx.font = '600 14px "Source Sans 3", system-ui, sans-serif';
    var maxW = Math.max(140, stripW() - 72);
    var lines = wrap(VERIFY.plate, maxW), i, w = 0;
    for (i = 0; i < lines.length; i++) w = Math.max(w, ctx.measureText(lines[i]).width);
    ctx.restore();
    var lh = 19, boxH = lines.length * lh + 14, mid = stripW() / 2;
    var top = Math.round(bottomY - 10 - boxH);
    var floor = (view.topPad || 0) + 6;
    if (top < floor) top = floor;
    var x0 = Math.round(mid - w / 2 - 18), bw = Math.round(w + 36);
    return { x: x0, y: top, w: bw, h: boxH,
             lines: lines, lh: lh, mid: mid, floor: floor };
  }

  function drawVerifyPlate(g) {
    plateBox = null;
    if (!g || plateHidden) return;
    var top = g.y, i;
    /* the plate yields only as a last resort, and only UPWARD: below it is the
       caption strip, and a warning that moved onto the caption would have
       traded one covered sentence for another */
    if (plateAvoid &&
        rectOverlap({ x: g.x, y: top, w: g.w, h: g.h }, plateAvoid) > 0) {
      top = Math.max(g.floor, Math.round(plateAvoid.y - 10 - g.h));
    }
    ctx.save();
    ctx.font = '600 14px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = plateCol(0.94);
    ctx.fillRect(g.x, top, g.w, g.h);
    ctx.fillStyle = isLight() ? 'rgba(196,87,74,0.14)' : 'rgba(196,87,74,0.22)';
    ctx.fillRect(g.x, top, g.w, g.h);
    ctx.fillStyle = WARM;
    ctx.fillRect(g.x, top, 4, g.h);
    ctx.strokeStyle = WARM;
    ctx.lineWidth = 1;
    ctx.strokeRect(g.x + 0.5, top + 0.5, g.w - 1, g.h - 1);
    ctx.fillStyle = ink(0.96);
    for (i = 0; i < g.lines.length; i++) {
      ctx.fillText(g.lines[i], g.mid + 2, top + 7 + i * g.lh + g.lh / 2);
    }
    ctx.restore();
    plateBox = { x: g.x, y: top, w: g.w, h: g.h };
  }

  function wrap(text, maxW) {
    var words = String(text).split(' '), lines = [], line = '', i, test;
    for (i = 0; i < words.length; i++) {
      test = line ? (line + ' ' + words[i]) : words[i];
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line); line = words[i];
        if (lines.length >= 3) break;
      } else line = test;
    }
    if (line && lines.length < 3) lines.push(line);
    return lines;
  }

  /* ---- s7.30 ruling 4: REDUCED MOTION, THE DECORATION STOPS --------------
     Ship gate round 8 (light-rm major 3): under prefers-reduced-motion the
     builder drones still flew on every placement (about 0.5 s, up to ~700
     px), and while Step held a game the gate walkers kept a two frame idle
     bob with no end and a catapult animated for a few seconds after a press.
     Measured on this build with the light-rm lane's frame-diff method
     (`i1v/verify/rm-diff.js`): the picture still changed 1.2 s after a
     placement and for the whole 3 s of a Step hold.
     The drone is the page's own (its flight is stepped from the clock) and
     the bob and the throw are drawn by the renderer FROM THE CLOCK THE PAGE
     HANDS IT (`i1v/verify/rclock.js`: at one held game state, two clocks 100
     ms apart repaint 2,606 device px of walkers and machines). So under
     reduced motion that clock no longer runs with the wall: it STANDS STILL,
     and it jumps ahead, 4 s a frame for three frames, whenever what is on the
     board really changes (an act, a new game, a placement, a Step press, the
     theme). Everything the change started (a drone, a placement's
     flash, a throw, the renderer's own catch-up) is therefore at its end the
     frame it is first drawn, and then nothing moves until the visitor acts
     again. The piece appears where it is placed, the step lands where it
     lands, and the result of a throw (a walker hurt or gone, a wall broken)
     is on the board; the throw itself is not drawn. Every sound still
     plays; the ones hung on a drone's or a throw's clock play together, on
     the frame the change lands. The follow camera snaps too (easeCamera).
     Without reduced motion this returns the wall clock, so nothing changes. */
  var RM_SETTLE = 4000, RM_SETTLE_FRAMES = 3;
  var rmClk = { t: 0, sig: '', sref: null, left: 0 };

  /* what the renderer draws from, as one string: the act, the session, every
     tile's piece, owner and health, every walker, the keep and the theme.
     Transient effects are left out on purpose: they are aged by this clock,
     and their removal must not count as a change. The pointer's own marks are
     left out too: the ghost and the hover outline are drawn the same at every
     clock (measured, i1v/verify/ghostclock.js), and counting them would turn
     every tile the pointer crosses into a jump of the walkers' pose. */
  function rmBoardSig() {
    var h = 0, i, w, st = S ? renderState(S) : null;
    if (st) {
      for (i = 0; i < CELLS; i++) h = (h * 31 + st.piece[i] * 7 + (st.owner[i] + 2) * 3 + st.hp[i]) | 0;
      for (i = 0; i < st.walkers.length; i++) {
        w = st.walkers[i];
        h = (h * 31 + w.id * 13 + w.cell * 5 + (w.hp | 0) + w.atk * 2 + (w.cool | 0)) | 0;
      }
    }
    return [act.name, act.sub, act.seq, st ? (st.phase + st.wave + ':' + st.tick + ':' + st.keepHp) : '-',
            h, effectiveTheme()].join('|');
  }

  function fxClock(t) {
    if (!reducedMotion()) { rmClk.t = 0; rmClk.sig = ''; rmClk.sref = null; rmClk.left = 0; return t; }
    var sig = rmBoardSig();
    if (sig !== rmClk.sig || S !== rmClk.sref) {
      rmClk.sig = sig; rmClk.sref = S; rmClk.left = RM_SETTLE_FRAMES;
    }
    if (rmClk.left > 0) {
      rmClk.t = Math.max(rmClk.t, t + RM_SETTLE * (RM_SETTLE_FRAMES - rmClk.left + 1));
      rmClk.left--;
    }
    return rmClk.t || t;
  }

  /* ------------------------------------------------------------- the loop */

  var rafId = 0, lastErr = '';
  function frame(t) {
    rafId = requestAnimationFrame(frame);
    try {
      /* every sound this frame raises goes out as one batch (ruling 9) */
      sndBatch = true;
      FX.cursor = (cursorCell >= 0 && act.name === 'you') ? cursorCell : -1;
      /* s7.30 ruling 4: the clock the decoration is drawn and aged from */
      var ft = fxClock(t);
      /* before anything paints, so the frame that expires the phone close up
         is also the frame that stops drawing it (ruling 5) */
      stepLoupe();
      /* s7.32 addendum 3 item 5: once per finished game */
      if (S && S.over && S.resolved && !S.ngShown) { S.ngShown = true; revealNewGame(); }
      stepShots(ft);
      stepDrones(ft);
      ageFlashes(ft);
      syncGhost();
      tickSession(t);
      stepFollow(t);
      easeBars();
      /* one advance of the bar band per PAINTED frame (s7.16 ruling 4) */
      var bandWas = barsBand.h;
      stepBarsBand();
      syncBudget();
      syncRecenter();
      if (following() || follow.moved) {
        aimCamera(t); easeCamera(); applyView();
        follow.moved = false;
      }
      /* s7.21 ruling 10: the frame the ease REACHES its target is the frame
         `h === want` first holds, and the old test skipped exactly that one,
         so the layout kept the second-to-last value of the band forever (2 px
         of top pad, and with it 2 px of board top, between Watch a wave and
         Your turn). The test is "did the band move", not "is it still moving". */
      else if (barsBand.h !== bandWas) applyView();
      paint(ft);
      sndBatch = false;
      flushSounds();
    } catch (e) {
      sndBatch = false;
      sndQ.length = 0;
      /* the loop reschedules at the TOP, so one bad frame costs a frame and
         not the whole page */
      lastErr = (e && e.message) ? String(e.message) : 'frame error';
    }
  }

  /* ------------------------------------------------------------ share, save */

  function shareState() {
    var i, y = [];
    for (i = 0; i < myMoves.length && i < 64; i++) {
      y.push(myMoves[i].cell * 2 + (myMoves[i].piece - 1));
    }
    var pk = 0, i;
    for (i = 0; i < PARTNERS.length; i++) if (PARTNERS[i].key === act.partner) pk = i;
    return { a: Math.max(0, ACTS.indexOf(act.name)), s: act.seed >>> 0,
             p: pk, n: act.partnerN | 0, b: act.bonusOnly ? 1 : 0, y: y };
  }

  /* ---- Share link says what happened (build spec v3 s7.24 ruling 10) -------
     The shared helper flashes "Copied" from the clipboard promise, which never
     settles while the document is unfocused: the light lane pressed it and saw
     no confirmation at all, and the round 4 verifier could only get the flash
     with the page focused. The page owns the confirmation now. It tries the
     clipboard, falls back to a selection copy, and says which of the two
     really happened on the button AND in the status line, so the answer is on
     a surface a phone visitor is already reading. It never says "Copied" for a
     copy that did not happen. */
  function doShare(btn) {
    if (!window.ShareHash) return;
    var s = ShareHash.encode(1, shareState());
    if (ShareHash.setHash) ShareHash.setHash(s);
    var url = location.origin + location.pathname + '#' + s;
    var done = false;
    var say = function (ok) {
      if (done) return;
      done = true;
      flashBtn(btn, ok ? 'Copied' : 'Link in the address bar');
      setStatus(ok ? 'Link copied. It carries this game and this partner.'
                   : 'The link is in the address bar. It carries this game and this partner.',
                { force: true });
    };
    var fallback = function () {
      var ok = false, ta;
      try {
        ta = document.createElement('textarea');
        ta.value = url;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (e) { ok = false; }
      say(ok);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        navigator.clipboard.writeText(url).then(function () { say(true); }, fallback);
      } catch (e) { fallback(); }
      /* a promise that never settles is the case the judges met: the button
         answers within a beat either way */
      setTimeout(function () { if (!done) fallback(); }, 700);
    } else { fallback(); }
  }

  /* one button label flash, restored to the label the markup shipped */
  function flashBtn(btn, txt) {
    if (!btn) return;
    if (!btn.getAttribute('data-kit-label')) {
      btn.setAttribute('data-kit-label', btn.textContent);
    }
    var orig = btn.getAttribute('data-kit-label');
    btn.textContent = txt;
    if (btn._kitFlash) clearTimeout(btn._kitFlash);
    btn._kitFlash = setTimeout(function () { btn.textContent = orig; }, 1400);
  }

  function restoreFromHash() {
    if (!window.ShareHash || !ShareHash.readHash) return false;
    var raw = ShareHash.readHash();
    if (!raw) return false;
    var got = null;
    try { got = ShareHash.decode(raw); } catch (e) { return false; }
    if (!got || got.version !== 1 || !got.obj) return false;
    var o = got.obj;
    act.seed = ShareHash.int(o.s, 1, 4294967295, act.seed) >>> 0;
    /* every field is CLAMPED on read: a hostile hash can make an odd game and
       never an illegal one */
    act.partner = PARTNERS[ShareHash.int(o.p, 0, PARTNERS.length - 1, 0)].key;
    act.partnerN = ShareHash.int(o.n, 0, partnerDef(act.partner).n - 1, 0);
    act.bonusOnly = !!ShareHash.int(o.b, 0, 1, 0);
    var ai = ShareHash.int(o.a, 0, ACTS.length - 1, 0);
    /* the layout is REPLAYED through core's own build phase, never written
       into the board: a hostile hash can make an odd game, never an illegal
       one, and one that overspends simply stops when the purse runs out */
    var packed = ShareHash.arr(o.y, 64), i, moves = [];
    for (i = 0; i < packed.length; i++) {
      var v = ShareHash.int(packed[i], 0, CELLS * 2 - 1, -1);
      if (v < 0) continue;
      moves.push({ cell: (v / 2) | 0, piece: (v % 2) + 1 });
    }
    syncPartnerUI();
    var bo = byId('kit-bonusonly');
    if (bo) bo.checked = act.bonusOnly;
    setAct(ACTS[ai], { quiet: true });
    if (ACTS[ai] === 'you' && moves.length) {
      myMoves = moves;
      rebuildYou();
      setStatus('Restored a shared board.');
    }
    return true;
  }

  /* the label names what is on screen, so a saved grid is never ambiguous
     about which pool produced it */
  function doSave() {
    if (!window.ShareHash || !ShareHash.savePng || !cv) return;
    var label = 'Keep It Together, ' + ACT_NAME[act.name];
    if (act.name === 'strangers') {
      label += ', strangers from the ' +
               (act.pool === 'ac' ? 'six-plan' : 'twin-trained') + ' runs';
    } else if (act.name === 'plans' && act.bonusOnly) {
      label += ', trained only to look different';
    } else if (act.name === 'you' || act.name === 'reader') {
      /* s7.26 ruling 3: one writer, here too */
      label += ', partner ' + partnerLabel(partnerDef(act.partner), act.partnerN);
    }
    ShareHash.savePng(cv, {
      label: label,
      file: 'keepittogether-' + act.name + '.png',
      light: isLight()
    });
    /* s7.21 ruling 10: Share link flashes "Copied" and Save image said nothing
       at all, so the download was the only signal it had worked. The button
       says so too, and the status line carries the file name. */
    var b = byId('kit-save');
    if (b && !b.getAttribute('data-said')) {
      var was = b.textContent;
      b.setAttribute('data-said', '1');
      b.textContent = 'Saved';
      setTimeout(function () {
        b.textContent = was;
        b.removeAttribute('data-said');
      }, 1400);
    }
    setStatus('Saved keepittogether-' + act.name + '.png.', { force: true });
  }

  /* --------------------------------------------------------- the walkthrough
     Build spec v3 s7.15 ruling 1, which is a rewrite and not a repair. Every
     ship-gate lane and the no-context panel named the walkthrough as the thing
     that most spoiled the visit: it advanced on a 7 to 20 s timer and dragged
     a reader off an act mid-sentence, its card covered the very thing it was
     explaining (the middle plan tile, the Strangers cells, a Fine print
     paragraph), it did not close on Done, and "?" restarted it and threw away
     the game the visitor was halfway through.

     So this page owns its own card now instead of borrowing gadget-tour.js's
     coach mark, and the rules are:

       NO TIMER.        Next is the only way forward. Nothing advances on its
                        own, at any speed, under any motion preference.
       FIXED STRIP.     The card is placed in a band that layout() reserves
                        BELOW the board, so "never overlaps the board, the
                        panel or a modal" is a property of the layout rather
                        than a placement search that can fail.
       HIDES UNDER A MODAL. The fine print and the help card are things the
                        visitor opened on purpose; the card gets out of the
                        way and comes back.
       DISMISS ON DONE AND ON ANY ACT CHANGE. Leaving the beat's act is the
                        visitor saying they are finished with it.

     The five captions are D4 section 4.2 under the copy rule "trained to",
     never "paid to", and they do not change. */
  var TOUR = [
    { act: 'watch', title: 'Watch a wave', loupe: true,
      caption: 'Two engineers. One wall. No talking.' },
    { act: 'plans', title: 'Six plans',
      caption: 'One engineer, six secret plans. It was trained to make them distinguishable from each other.' },
    { act: 'strangers', title: 'Strangers',
      /* s7.26 ruling 6: the beat said "the keep falls" beside a grid whose
         own squares include strangers holding at 92, and the light judge
         called it out ("the data is honest, the caption told me something the
         picture does not show"). It says what the grid shows instead: the
         comparison, not an outcome for any one square. */
      caption: 'Swap in an engineer from another training run. Strangers held the ' +
               'keep less often than the trained pairs.' },
    { act: 'reader', title: 'Reading the plan',
      /* s7.19 ruling 10: what the bars really do is SETTLE. The critic measured
         three distinct states in 48 s with the lead never changing, against a
         line that promised movement. */
      caption: "The guess, live. The bars are the reader's own output, and they settle as the first walls go up." },
    { act: 'you', title: 'Your turn',
      /* s7.22 ruling 1: the last beat is the one a first visitor acts on, and
         it used to send them off to build on any tile at all, at a board where
         only the lit band is legal. It now says the same thing the act's own
         build line says, in the same words. */
      /* s7.26 ruling 4: one boundary, so one area */
      caption: 'Your turn. Build inside the lit area, then press Done building.' }
  ];
  var TOUR_KEY = 'tour-keepittogether';
  var tourOn = false, tourStep = -1, tourApplying = false;
  var coachEl = null, coachText = null, coachDots = null, coachNext = null;
  var coachH = 0;

  function coachInit() {
    coachEl = byId('kit-coach');
    if (!coachEl) return;
    coachText = byId('kit-coach-text');
    coachDots = byId('kit-coach-dots');
    coachNext = byId('kit-coach-next');
    var i, d;
    if (coachDots && !coachDots.firstChild) {
      for (i = 0; i < TOUR.length; i++) {
        d = document.createElement('span');
        d.className = 'kit-coach__dot';
        coachDots.appendChild(d);
      }
    }
    if (coachNext) coachNext.addEventListener('click', function () { tourNext(); });
    var x = byId('kit-coach-x');
    if (x) x.addEventListener('click', function () { endTour('skipped'); });
  }

  /* a modal the visitor opened on purpose owns the screen */
  function modalOpen() { return !!modalEl(); }

  /* the dialog that is really up, which is the element that scrolls */
  function modalEl() {
    var f = fineEl(), h = byId('kit-helpcard');
    if (h && !h.hidden) return h;
    if (f && !f.hidden) return f;
    return null;
  }

  /* ---- s7.26 ruling 9: A DIALOG IS A DIALOG -------------------------------
     Two things the judges hit at once. On the phone the theme and back circles
     are fixed at the bottom left and they floated over the fine print's last
     visible paragraph (ph-19-fine.png), so a visitor read the page's own
     honesty text through two buttons; and a wheel anywhere but over the card
     scrolled the PANEL behind it, which is not the thing the visitor just
     opened. The corner buttons are hidden page-scoped while a dialog is up
     (the PDF page's precedent, and the owner may veto it), the panel and the
     phone act bar go inert so nothing behind the card takes a pointer or a
     tab, and a wheel outside the card is handed to the card. */
  function syncModalChrome() {
    var open = modalOpen(), i, el;
    /* the two ACT rows stay live: the Fine print is an act, it is reached from
       the act row and the row is pinned precisely so it is always where the
       visitor left it (s7.24 ruling 4). Everything else behind the card is
       inert, so nothing behind it takes a pointer or a tab. */
    var ids = ['kit-panel-body', 'kit-actbar-build'];
    for (i = 0; i < ids.length; i++) {
      el = byId(ids[i]);
      if (!el) continue;
      if (open) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
    }
    if (document.body) document.body.classList.toggle('kit-modal-open', open);
  }

  function wireModalWheel() {
    if (wireModalWheel.done) return;
    wireModalWheel.done = true;
    document.addEventListener('wheel', function (e) {
      var el = modalEl();
      if (!el) return;
      if (el.contains(e.target)) return;      /* the card already has it */
      var step = (e.deltaMode === 1) ? 16 : ((e.deltaMode === 2) ? el.clientHeight : 1);
      el.scrollTop += e.deltaY * step;
      e.preventDefault();
    }, { passive: false, capture: true });
  }

  function coachShown() { return tourOn && !modalOpen(); }

  /* the band the card needs, measured from the card itself, so a caption that
     wraps to three lines takes three lines of board and not a millimetre of
     overlap */
  function coachBand() {
    if (!coachShown() || !coachEl) return 0;
    var h = coachEl.offsetHeight || 0;
    return h ? (h + 14) : 0;
  }

  function placeCoach() {
    if (!coachEl) return;
    /* s7.21 ruling 1: the gate is synced on BOTH exits. It used to be reached
       only when the card was shown, so the card closing in place left it set. */
    if (!coachShown()) { coachEl.hidden = true; coachH = 0; syncDoneGate(); return; }
    coachEl.hidden = false;
    var reserve = (panelOpen && cssW >= 600)
      ? ((RC && RC.PANEL_RESERVE) ? RC.PANEL_RESERVE : 356) : 0;
    var strip = Math.max(160, cssW - reserve);
    var w = Math.round(Math.min(520, strip - 24));
    coachEl.style.width = w + 'px';
    coachEl.style.left = Math.round((strip - w) / 2) + 'px';
    var band = cornerBandRect(), chat = rectOf('chat-widget');
    var bottom = 10;
    if (band) bottom = Math.max(bottom, cssH - band.y + 8);
    if (chat) bottom = Math.max(bottom, cssH - chat.y + 8);
    if (actbar) {
      var ar = actbar.getBoundingClientRect();
      if (ar.height) bottom = Math.max(bottom, cssH - ar.top + 8);
    }
    /* a40: on a very short window (400 percent zoom) the bottom-anchored card
       rose above the viewport and its buttons sat under the masthead. Its top
       stays below the masthead; the card gives up its clearance of the corner
       buttons, the act bar and the chat first, and scrolls inside only when
       even that leaves too little room. */
    coachEl.style.maxHeight = '';
    coachEl.style.overflowY = '';
    var mh = document.querySelector('.masthead');
    var topMin = (mh ? Math.max(0, mh.getBoundingClientRect().bottom) : 0) + 8;
    var ch = coachEl.offsetHeight || 0;
    if (ch && cssH - bottom - ch < topMin) {
      bottom = Math.max(4, cssH - topMin - ch);
      if (cssH - bottom - ch < topMin) {
        coachEl.style.maxHeight = Math.max(60, Math.round(cssH - bottom - topMin)) + 'px';
        coachEl.style.overflowY = 'auto';
      }
    }
    coachEl.style.bottom = Math.round(bottom) + 'px';
    coachH = coachBand();
    syncDoneGate();
  }

  function showBeat(i) {
    tourStep = i;
    var b = TOUR[i], k;
    tourOn = true;
    tourApplying = true;
    setAct(b.act, { quiet: true });
    tourApplying = false;
    /* after setAct, which resets the presentation and closes any open loupe.
       Ruling 5: the close up never opens itself on a phone, where it covered
       roughly 45 percent of the screen on the very first paint. */
    tourLoupeOn = !!b.loupe && !phone();
    if (!tourLoupeOn && loupe.src === 'tour') closeLoupe();
    if (coachText) coachText.textContent = b.caption;
    if (coachNext) {
      /* s7.19 ruling 8: the walkthrough's last button is GOT IT, not Done.
         Two buttons called Done sat on the same screen and one of them skipped
         the visitor's own build phase unrecoverably. */
      coachNext.textContent = (i === TOUR.length - 1) ? 'Got it' : 'Next';
      coachNext.setAttribute('aria-label',
        (i === TOUR.length - 1) ? 'Finish the walkthrough' : 'Next step');
    }
    if (coachDots) {
      for (k = 0; k < coachDots.childNodes.length; k++) {
        coachDots.childNodes[k].className =
          'kit-coach__dot' + (k === i ? ' kit-coach__dot--on' : '');
      }
    }
    /* the step text lives in the card and nowhere else (ruling 2): it used to
       go to the status line and be overwritten 18 ms later by a counter */
    playSound('tour-chime', {});
    layout();
  }

  function tourNext() {
    if (!tourOn) return;
    if (tourStep < TOUR.length - 1) showBeat(tourStep + 1);
    else endTour('done');
  }

  /* a42: the control that started the walkthrough (Replay), so closing it
     hands keyboard focus back there; the auto-run falls back to the ? */
  var coachOpener = null;
  function startTour() {
    try { localStorage.setItem(TOUR_KEY, '1'); } catch (e) {}
    if (!tourOn) coachOpener = openerOf(coachEl);
    tourOn = true;
    showBeat(0);
    if (coachNext) { try { coachNext.focus({ preventScroll: true }); } catch (e) {} }
  }

  function endTour(why) {
    tourLoupeOn = false;
    if (loupe.src === 'tour') closeLoupe();
    if (!tourOn) { placeCoach(); return; }
    tourOn = false;
    if (coachEl) {
      var heldCoach = coachEl.contains(document.activeElement);
      coachEl.hidden = true;
      if (heldCoach) {
        var back = coachOpener;
        if (!back || !back.isConnected || !back.getClientRects().length ||
            back.closest('[inert]')) back = byId('kit-help');
        if (back && back.getClientRects().length && !back.closest('[inert]')) {
          giveBackFocus(back);
        } else {
          try { document.activeElement.blur(); } catch (e) {}
        }
      }
    }
    coachH = 0;
    /* s7.21 ruling 1: every dismiss path (Got it, the x, an act change) clears
       the gate here as well, so it cannot depend on placeCoach being reached */
    syncDoneGate();
    layout();
    syncDoneGate();
    if (why === 'done') setStatus('Walkthrough finished. Your turn.', { force: true });
    else if (why === 'act') setStatus('Walkthrough closed. Replay it from the panel.', { force: true });
    else setStatus('Walkthrough skipped. You can replay it from the panel.', { force: true });
  }

  function tourActive() { return tourOn; }

  /* -------------------------------------------------------------- the help
     Ruling 1: "?" opens a HELP card. It used to restart the walkthrough, which
     all three no-context judges pressed expecting help and all three lost
     their game to. "Replay the walkthrough" is the only restart. */
  function openHelp() {
    var el = byId('kit-helpcard');
    if (!el) return;
    if (el.hidden) helpOpener = openerOf(el);
    closeFine();
    /* s7.21 ruling 10: the panel line named the fine print while the HELP card
       was what stood open. It names whichever card is really up, and the act's
       own prose comes back when the card closes. */
    if (proseSaved === null) proseSaved = proseLast || [];
    setProse([{ text: 'The help card is open. Escape closes it.' }]);
    /* s7.29 ruling 4: the card carries the same disclosure the live acts'
       first caption does, for as long as the visitor wants to read it */
    var rmp = byId('kit-help-rm');
    if (rmp) rmp.hidden = !reducedMotion();
    el.hidden = false;
    el.scrollTop = 0;
    placeCoach();
    syncModalChrome();          /* s7.26 ruling 9 */
    layout();
    var b = byId('kit-helpcard-close');
    if (b) { try { b.focus({ preventScroll: true }); } catch (e) {} }
  }

  function closeHelp() {
    var el = byId('kit-helpcard');
    if (!el || el.hidden) return false;
    var held = el.contains(document.activeElement);
    el.hidden = true;
    if (proseSaved !== null) { setProse(proseSaved); proseSaved = null; }
    placeCoach();
    syncModalChrome();          /* s7.26 ruling 9 */
    layout();
    if (held) giveBackFocus(helpOpener);   /* m22 */
    helpOpener = null;
    return true;
  }

  /* ---------------------------------------------------------------- worker */

  /* SEAM A-S3 (Z-A, 2026-09-09), the other half of ruling 4's "the main thread
     never plays a game for the grid". `workerAlive` is false for the whole
     boot, so a visitor who reached Strangers or pressed Take a row in the first
     couple of seconds fell straight through to the main-thread runner and
     played real games there. `workerPending` is true from initWorker until the
     worker either says `ready` or dies, and the fallback is taken only when
     BOTH are false; the ready handler posts whatever was waiting. */
  var worker = null, workerAlive = false, workerPending = false;
  var pendingRow = false;

  function scriptUrls() {
    var el = document.querySelector('script[src*="keepittogether.js"]');
    var src = el ? el.getAttribute('src') : '/assets/js/keepittogether.js';
    var qi = src.indexOf('?');
    var q = qi >= 0 ? src.slice(qi) : '';
    var base = src.slice(0, src.lastIndexOf('/') + 1);
    return {
      ai: base + 'keepittogether-ai.js' + q,
      core: new URL(base + 'keepittogether-core.js' + q, location.href).href,
      model: new URL(base + 'keepittogether-model.js' + q, location.href).href
    };
  }

  /* The fourinarow law, restated because it cost a real hang: a worker that
     fails inside importScripts posts a NORMAL message, not onerror, so every
     death path runs the same workerDead(). The HEAD probe in front of it is
     because a 404 on new Worker() prints a console error and the smoke bar is
     zero console errors (SEAM P-S6). */
  /* The worker file SHIPS now (INTERFACES, the A pin), so the flag is true and
     the HEAD probe is kept: it costs one conditional request and it is what
     holds the zero console errors bar if the file is ever missing from a
     build. SEAM P-S6 is closed. */
  var WORKER_ENABLED = true;

  function initWorker() {
    if (!WORKER_ENABLED) { workerAlive = false; workerPending = false; return; }
    if (!window.Worker || !window.fetch) { workerAlive = false; workerPending = false; return; }
    workerPending = true;
    var urls = scriptUrls();
    /* A GET and not a HEAD. Chrome reports a bodyless HEAD as net::ERR_ABORTED
       even against a well formed response, which shows up as a failed request
       on a page whose bar is zero of them; a GET is served from the HTTP cache
       when `new Worker()` asks for the same URL a moment later, so the probe
       costs one cached fetch and no error. A 404 here is a normal response,
       not a console error, which is the whole point of probing first. */
    fetch(urls.ai, { method: 'GET', cache: 'force-cache' }).then(function (res) {
      if (!res || !res.ok) { workerAlive = false; workerBootFailed(); return; }
      bootWorker(urls);
    }, function () { workerAlive = false; workerBootFailed(); });
  }

  /* the worker will never arrive, so whatever was waiting for it takes the
     fallback now rather than sitting on a counter that never moves */
  function workerBootFailed() {
    if (!workerPending) return;
    workerPending = false;
    if (act.name !== 'strangers' || !FX.grid) { pendingRow = false; return; }
    if (FX.grid.done < FX.grid.total) startGridJob();
    if (pendingRow) {
      pendingRow = false;
      if (FX.grid.row && Core && Core.playEpisode) startRowJob();
      else if (FX.grid.row) setStatus(honestMissing(), { force: true });
    }
  }

  function bootWorker(urls) {
    try { worker = new Worker(urls.ai); }
    catch (e) { worker = null; workerAlive = false; workerPending = false; return; }
    var booted = false;
    /* A LATE worker is not a dead one. This timer used to terminate the worker
       and give up on it for the rest of the visit; measured on this machine
       with a second fleet holding it at 90 to 100 percent, a boot really does
       run past 4 s (ship-fixes.js lane_grid read workerAlive false in a full
       run and true in the same lane alone), and after that every grid and every
       Take a row goes back to the main thread, which is exactly the freeze
       ruling 4 is about. Terminating a worker mid importScripts also aborts its
       own requests, which shows up as failed requests in the console.
       So the timeout now only STOPS WAITING: the fallback runs, and if `ready`
       arrives later the ready handler adopts the worker and cancels the
       fallback. A worker that is really broken still posts an error message or
       fires onerror, and that path still terminates it. */
    var bootTimer = setTimeout(function () { if (!booted && worker) bootLate(); }, 4000);
    function bootLate() {
      workerPending = false;
      if (act.name === 'strangers' && FX.grid && FX.grid.done < FX.grid.total) startGridJob();
      if (pendingRow) {
        pendingRow = false;
        if (act.name === 'strangers' && FX.grid && FX.grid.row) {
          if (Core && Core.playEpisode) startRowJob();
          else setStatus(honestMissing(), { force: true });
        }
      }
    }
    function workerDead() {
      clearTimeout(bootTimer);
      try { worker.terminate(); } catch (e) {}
      worker = null;
      workerAlive = false;
      workerPending = false;
      /* whatever was in flight is re-issued on the fallback path */
      if (act.name === 'strangers' && FX.grid && FX.grid.done < FX.grid.total) startGridJob();
      /* including a row the visitor asked for while the worker was booting
         (SEAM A-S3): without this the counter stops at 1 of 8 forever */
      if (pendingRow) {
        pendingRow = false;
        if (act.name === 'strangers' && FX.grid && FX.grid.row) {
          if (Core && Core.playEpisode) startRowJob();
          else setStatus(honestMissing(), { force: true });
        }
      }
    }
    worker.onerror = function () { if (worker) workerDead(); };
    worker.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === 'ready') {
        booted = true; clearTimeout(bootTimer); workerAlive = true;
        workerPending = false;
        /* read BEFORE cancelJobs, which clears it: a row waiting on the boot
           would otherwise be dropped by the cancel that tidies up the grid's
           fallback, and the visitor's counter would stop at 1 of 8 */
        var wantRow = pendingRow;
        if (act.name === 'strangers' && FX.grid && FX.grid.done < FX.grid.total) {
          cancelJobs();
          postCells();
        }
        /* the row the visitor asked for while this was booting goes to the
           worker now, which is the whole point of holding it (SEAM A-S3) */
        if (wantRow) {
          pendingRow = false;
          if (act.name === 'strangers' && FX.grid && FX.grid.row && !postRow()) {
            if (Core && Core.playEpisode) startRowJob();
            else setStatus(honestMissing(), { force: true });
          }
        }
        return;
      }
      if (m.type === 'error') { if (worker) workerDead(); return; }
      if (m.seq !== act.seq) return;                    /* stale, dropped on arrival */
      if (m.type === 'cell' && FX.grid) {
        /* a cell the worker could not play is left blank and does NOT raise
           the count, exactly as a null from the fallback is */
        if (!m.ok) return;
        /* the worker echoes the episode count it actually played, so the
           caption's claim is checked against the worker and not against the
           page's own request */
        if (typeof m.episodes === 'number') FX.grid.episodes = m.episodes;
        var got = { score: m.score, hp: (typeof m.keepHp === 'number') ? m.keepHp : m.score,
                    st: fromLayout(m) };
        FX.grid.cells[m.i * FX.grid.n + m.j] = got;
        FX.grid.done++;
        cachePut(FX.grid.rows[m.i] + '|' + FX.grid.cols[m.j] + '|' + act.seed, got);
        gridProgress();
        writeSrGrid();
        return;
      }
      if (m.type === 'play' && FX.grid) {
        /* the gallery's own message: same cell, same picture, plus the
           reader's belief per build tick when the pairing carries a reader */
        if (!m.ok) return;
        if (typeof m.episodes === 'number') FX.grid.episodes = m.episodes;
        var gn = FX.grid.n, pi = (m.k / gn) | 0, pj = m.k % gn;
        if (pi < 0 || pj < 0 || pi >= gn || pj >= gn) return;
        var pgot = { score: m.score, hp: (typeof m.keepHp === 'number') ? m.keepHp : m.score,
                     st: fromLayout(m) };
        FX.grid.cells[pi * gn + pj] = pgot;
        FX.grid.done++;
        cachePut(FX.grid.rows[pi] + '|' + FX.grid.cols[pj] + '|' + act.seed, pgot);
        takeIntents(m);
        gridProgress();
        writeSrGrid();
        if (act.name === 'strangers' && (FX.grid.done % 8) === 0) setProse(strangersProse());
        return;
      }
      if (m.type === 'rowcell' && FX.grid && FX.grid.row) {
        var rj = m.j | 0;
        if (rj >= 0 && rj < FX.grid.n) {
          FX.grid.row[rj] = m.ok
            ? { score: m.score, hp: (typeof m.keepHp === 'number') ? m.keepHp : m.score,
                st: fromLayout(m) }
            : null;
        }
        rowProgress(typeof m.done === 'number' ? m.done : (rj + 1),
                    typeof m.total === 'number' ? m.total : FX.grid.n);
        writeSrGrid();
        return;
      }
      if (m.type === 'done' && m.kind === 'row') { rowFinished(); return; }
      if (m.type === 'done' && FX.grid) {
        if (act.name === 'strangers') setProse(strangersProse());
        var sum = gridSummary();
        setStatus(FX.grid.done + ' of ' + FX.grid.total + ' games played.' +
                  (sum ? (' ' + sum) : ''));
      }
    };
    try { worker.postMessage({ type: 'init', coreUrl: urls.core, modelUrl: urls.model }); }
    catch (e) { workerDead(); }
  }

  /* The worker's compact layout turned back into the shape R.fortress reads,
     which is the shape snapshotOf() already produces. `piece = v >> 2` and
     `owner = (v & 3) - 1`, so an empty cell is 0. */
  function fromLayout(m) {
    var piece = new Uint8Array(CELLS), owner = new Int8Array(CELLS), hp = new Int16Array(CELLS);
    owner.fill(-1);
    var L = m.layout, H = m.hp, i, v;
    if (!L) return null;
    for (i = 0; i < CELLS; i++) {
      v = L[i];
      if (!v) continue;
      piece[i] = v >> 2;
      owner[i] = (v & 3) - 1;
      hp[i] = H ? H[i] : 0;
    }
    return { piece: piece, owner: owner, hp: hp, terrain: null,
             keepHp: (typeof m.score === 'number') ? m.score : 0, walkers: [],
             phase: 'over', wave: WAVES, tick: 0, phaseTick: 0, budget: [0, 0] };
  }

  /* One episode per cell, deliberately (SEAM A-S2). C measured 12 episodes as
     the number that makes a cell's mean worth reading, and the worker serves
     either, but the caption on this act is "Every square is a game your
     browser just played" and it is quoted verbatim from the concept plan. A
     mean of twelve games is not a game, so taking the recommendation costs
     that sentence. It stays at one until Fable rules on the copy. */
  function postGrid() {
    if (!worker || !FX.grid) return false;
    try {
      worker.postMessage({ type: 'grid', jobId: act.seq, seq: act.seq,
                           seed: act.seed >>> 0, rows: FX.grid.rows,
                           cols: FX.grid.cols, episodes: GRID_EPISODES });
    } catch (e) { return false; }
    return true;
  }

  /* ------------------------------------------------------------------- wire */

  function on(id, fn) {
    var el = byId(id);
    if (el) el.addEventListener('click', fn);
  }

  function wireButtons() {
    var acts = document.querySelectorAll('#kit-acts [data-act]'), i;
    for (i = 0; i < acts.length; i++) {
      (function (b) {
        b.addEventListener('click', function () {
          armAudio(); playSound('ui-tick', {});
          setAct(b.getAttribute('data-act'));
        });
      })(acts[i]);
    }
    wireGreyReason(byId('kit-build-controls'));
    wirePanelSnap();           /* s7.25 ruling 3, re-cut by s7.26 ruling 1 */
    wireModalWheel();          /* s7.26 ruling 9 */
    on('kit-piece-wall', function () { armAudio(); selectPiece(PIECE_WALL); });
    on('kit-piece-gun', function () { armAudio(); selectPiece(PIECE_GUN); });
    on('kit-undo', function () { armAudio(); undoPlacement(); });
    on('kit-done', function () { armAudio(); doneBuilding(); });
    /* s7.26 ruling 7: newGamePress is module level so the phone act bar, which
       is built and dropped on every resize, can bind the same one press */
    on('kit-newseed', newGamePress);
    var psel = byId('kit-partner');
    if (psel) psel.addEventListener('change', function () {
      armAudio(); setPartner(psel.value, 0);
    });
    var pnum = byId('kit-partner-n');
    if (pnum) pnum.addEventListener('change', function () {
      /* ---- s7.28 ruling 1: THE PICKER KEEPS THE PARTNER --------------------
         This handler passed `act.partner`, the seat's own key. In Your turn
         the picker points AT the seat, so the two agree and nothing showed;
         in Reading the plan the picker points at `act.readKey`, so changing
         the Run or Intent number handed `setPartner` the SEAT's key and the
         reader's partner was silently reset to the self play engineer. The
         light reduced-motion judge asked for "Intent 3" four times and was
         given "Self-play engineer, run 3" four times, with the blurb and the
         reader bars re-running as if it had obeyed. `pickerKey()` is the one
         answer to "which seat is this picker moving", and it is already what
         syncPartnerUI and the hook read, so the control and the label now
         come from the same place. */
      armAudio(); setPartner(pickerKey(), parseInt(pnum.value, 10) || 0);
    });
    on('kit-takerow', function () { armAudio(); takeRow(); });
    on('kit-fine-close', function () { armAudio(); leaveFine(); });
    on('kit-tour', function () { armAudio(); startTour(); });
    on('kit-help', function () { armAudio(); openHelp(); });
    on('kit-helpcard-close', function () { armAudio(); closeHelp(); });
    on('kit-sound', function () { armAudio(); setMuted(audioOn); });
    var share = byId('kit-share');
    if (share) share.addEventListener('click', function () { armAudio(); doShare(share); });
    on('kit-save', function () { armAudio(); doSave(); });
    var pool = byId('kit-pool');
    if (pool) pool.addEventListener('change', function () {
      armAudio();
      act.pool = pool.checked ? 'ac' : 'sp';
      setStatus('Grid now shows strangers from the ' +
                (pool.checked ? 'six-plan' : 'twin-trained') + ' runs.');
      /* the pool decides which job the gallery goes out as, so the running one
         is stopped by its own id and the sequence moves on: an answer from the
         old pool arriving after the swap would be painted into the new grid,
         because the drop-on-arrival test is the sequence number */
      if (act.name === 'strangers') { cancelJobs(); act.seq++; startStrangers(); }
    });
    var bonus = byId('kit-bonusonly');
    if (bonus) bonus.addEventListener('change', function () {
      armAudio();
      act.bonusOnly = !!bonus.checked;
      setStatus(bonus.checked ? 'Trained only to look different. Replaying the six plans.'
                              : 'Back to the plans that also had to win.');
      /* the toggle changes which net played, so the six games are replayed
         rather than relabelled */
      if (act.name === 'plans') { cancelJobs(); startPlans(); }
    });
  }

  /* ------------------------------------------------------- the partner picker
     Build spec v2 section 5c. The four labels and their one-line notes are
     verbatim; the picker changes the partner net and the label and NEVER the
     world, so any two games a visitor compares are the same waves and the same
     budget with one thing different. That is what makes the per partner ledger
     a comparison rather than a scoreboard. */

  /* one seat from a picker choice, whichever picker asked */
  function agentOf(key, n) {
    var d = partnerDef(key);
    n = Math.max(0, Math.min(d.n - 1, n | 0));
    if (d.key === 'sp' || d.key === 'ac') {
      return agentFor(netKeys(d.key, 8)[n] || (d.key + n));
    }
    var net = netOf(d.key === 'div' ? 'specDiv' : 'spec');
    if (!net || !Core || !Core.oneHot) return { kind: 'none' };
    return { kind: 'net', net: net, extra: Core.oneHot(n, 6) };
  }

  function partnerAgent() { return agentOf(act.partner, act.partnerN); }

  /* which seat the picker is pointing at in this act */
  function pickerReads() { return act.name === 'reader'; }
  function pickerKey() { return pickerReads() ? act.readKey : act.partner; }
  function pickerN() {
    if (!pickerReads()) return act.partnerN;
    if (act.readN < 0) return act.seed % 6;      /* the act's own opening pick */
    return act.readN;
  }
  function readAgent() { return agentOf(act.readKey, pickerN()); }

  /* the bars belong to the accommodator, so they are shown only when it is the
     partner (v2 5c) */
  function partnerIsReader() { return act.partner === 'ac'; }

  function setPartner(p, n) {
    var d = partnerDef(p);
    var v = Math.max(0, Math.min(d.n - 1, (n === undefined ? 0 : n) | 0));
    if (pickerReads()) { act.readKey = d.key; act.readN = v; }
    else { act.partner = d.key; act.partnerN = v; }
    syncPartnerUI();
    /* the act RESTARTS with the new partner (build spec v3 s7.15 ruling 3), so
       it takes a new sequence number: anything still in flight for the old
       partner is stale and must not paint into the new game. */
    cancelJobs();
    act.seq++;
    /* the accommodator is the only partner that shows the bars, so the band
       has to be taken or given back before the act restarts */
    layout();
    playSound('ui-tick', {});
    if (act.name === 'you') startYourTurn();
    else if (act.name === 'reader') startReader();
  }

  /* ---- the picker's fairness line, COMPUTED ------------------------------
     The typed sentence this replaces ("Both partners are equally good with the
     partner they trained with.") was disproved by the page's own grid: the dark
     ship-gate lane read 76 on one diagonal cell and 100 one column over and
     said so. Ruling 4 now prints those numbers IN the cells, so the claim could
     not stay. `meta.zsc.twin` is the number the export really carries for the
     trained-together case, measured through the identical code as the stranger
     arm, and the export's own note says so; the sentence says that and then
     says what the difference between these two partners is measured on, which
     is the thing the picker needs a visitor to understand. No number, no
     sentence with a number in it. */
  function fairLine() {
    var twin = metaNum('zsc', 'twin');
    var tail = 'What separates these two is measured with an engineer they have ' +
               'never met, not with the one they trained with.';
    if (twin === null || !isFinite(twin)) return tail;
    /* s7.26 ruling 12: the sentence NAMES ITS SOURCE. It sat beside a live
       diagonal reading 86 in one session and 69 in another, and the dark judge
       asked which of the two was true. Both are: this one is the test that
       scored the engineers, and the grid is this browser's own games. */
    return 'Paired with a copy of itself an engineer holds ' + fmt1(twin) + ' of ' +
           HP_KEEP + ' in the test that scored them, and the grid on this page is ' +
           'your own browser playing, so its diagonal is its own number. ' + tail;
  }

  /* the run each partner type would be played at, so the picker's own options
     can print a real number for the three that are not standing */
  var pickMemo = { sp: 0, ac: 0, spec: 0, div: 0 };

  function syncPartnerUI() {
    var sel = byId('kit-partner'), num = byId('kit-partner-n');
    var note = byId('kit-partner-note'), lab = byId('kit-partner-nlabel');
    var d = partnerDef(pickerKey()), i, o, head = byId('kit-partner-head');
    var pn = pickerN();
    if (sel && sel.value !== d.key) sel.value = d.key;
    /* s7.24 ruling 10: the picker's own options carry the real number. The
       markup ships the template ("Self-play engineer, run N") and the page
       fills it with the number that partner would be played at, which for the
       standing one is its own pick and for the others is the run the picker
       opens on. */
    if (sel) {
      for (i = 0; i < sel.options.length; i++) {
        o = sel.options[i];
        var od = partnerDef(o.value);
        var on = (od.key === d.key) ? pn : (pickMemo[od.key] || 0);
        var txt = partnerLabel(od, on);
        if (o.textContent !== txt) o.textContent = txt;
      }
    }
    pickMemo[d.key] = pn;
    if (lab) lab.textContent = d.pick;
    /* the picker's own label says which seat it moves in this act */
    if (head) {
      head.textContent = pickerReads() ? 'The partner it is reading' : 'Your partner';
    }
    /* The six intents stay six. The ones the gate could not tell apart carry
       the measurement in their own label (build spec v3 s7.11 ruling 1e), and
       the label names the plan they converge with once the six plans have been
       played, because that name is measured on those boards and nowhere else. */
    var dist = (d.key === 'spec') ? planDistinct() : null;
    var shorts = planNames(), sig, k;
    if (num) {
      sig = d.key + '|' + (dist ? dist.join('') : '-') + '|';
      for (k = 0; k < 6; k++) {
        sig += (lastNear && lastNear[k]) ? String(lastNear[k].near) : '-';
      }
      sig += '|' + (pickerReads() ? 'r' : 'p');
      if (num.getAttribute('data-kind') !== sig) {
        num.setAttribute('data-kind', sig);
        while (num.firstChild) num.removeChild(num.firstChild);
        for (i = 0; i < d.n; i++) {
          o = document.createElement('option');
          o.value = String(i);
          /* s7.32 addendum 3 item 4: the option carries its number only (the
             converge note was 263 px of text in 206 px of box, cut mid word);
             the note under the select names the plan instead */
          o.textContent = d.pick + ' ' + (i + 1);
          num.appendChild(o);
        }
      }
      num.value = String(pn);
    }
    if (note) {
      note.textContent = d.note +
        ((dist && !dist[pn])
          ? ' In the test that scored them, this one was not distinguishable from ' +
            'another plan' + (function () {
              var tg = convergeTag(pn, lastNear, shorts, dist);
              return /another plan$/.test(tg) ? '.' : ('; it ' + tg + '.');
            })() : '') +
        ((pickerReads() && readSame) ? ' ' + readSame : '');   /* s7.32 ruling 2 */
    }
    var fair = byId('kit-partner-fair');
    if (fair) fair.textContent = fairLine();
    writeLedger();
    drawTrayCard();
  }

  /* s7.21 ruling 10: the partner portrait is never cut by the panel's edge.
     The panel is a scroll box, so "not cut" is a property of where it is
     scrolled to: when an act OPENS (never while the visitor is scrolling it
     themselves) the panel is moved by the minimum that puts the whole card
     inside its own viewport. */
  /* s7.22 ruling 2. This scrolled `#kit-panel-body`, which has no overflow of
     its own: `.kit-panel` is the element with `overflow: auto`, so the write
     was a no-op on an element 2,357 px tall inside a 720 px window, and the
     portrait stood 83 px below the panel's edge with its blurb cut. A probe
     measuring the card against the BODY's rect passes vacuously for the same
     reason, which is how this survived two rounds. Scroll the element that
     scrolls, and measure against its window. */
  /* the panel's own toggle pays this when the panel is opened after a press
     that arrived while it was collapsed (s7.24 ruling 4) */
  var revealPending = false;
  var panelUI = null;

  function revealPartnerCard() {
    var pane = byId('kit-panel'), i, els, r;
    if (!pane) return;
    if (!panelOpen) { revealPending = true; return; }
    revealPending = false;
    /* WHAT is revealed: the PORTRAIT and ITS BLURB, which is what the ruling
       names, not the whole partner card. The card also carries the fairness
       hint, 224 px of it, and revealing all of that costs a 342 px scroll that
       takes the act buttons and Done building out of the panel's window (all
       three measured, p15/probe9.js). The portrait and the blurb need 68. */
    var parts = [], tray = document.querySelector('#kit-tray canvas');
    var note = byId('kit-partner-note');
    if (tray && tray.offsetParent) parts.push(tray);
    if (note && note.offsetParent) parts.push(note);
    if (!parts.length) {
      els = document.querySelectorAll('.kit-partner__card');
      for (i = 0; i < els.length; i++) {
        if (els[i].offsetParent) { parts.push(els[i]); break; }
      }
    }
    if (!parts.length) return;
    var br = pane.getBoundingClientRect();
    var top = Infinity, bot = -Infinity;
    for (i = 0; i < parts.length; i++) {
      r = parts[i].getBoundingClientRect();
      if (!(r.height > 0)) continue;
      if (r.top < top) top = r.top;
      if (r.bottom > bot) bot = r.bottom;
    }
    /* the sticky head and act row cover the top of the scroll box, so the
       window a reveal may scroll INTO starts under them (s7.24 ruling 4) */
    var ceiling = panelCeiling(br);
    if (!isFinite(top)) return;
    /* s7.26 ruling 12: THE REVEAL CLAMPS TO THE ROOM IT HAS. At 390x620 the
       panel's scroll box is about 170 px and the portrait with its blurb is
       about 360, so the reveal used to give up and leave the panel at the top
       with the portrait 240 px below the fold. It cannot show both there, so
       it shows the PORTRAIT: the top of the revealed block is brought to the
       ceiling and the blurb is the part that is one short scroll away. */
    if (bot - top > br.bottom - ceiling) {
      if (top > ceiling + 2) pane.scrollTop += Math.ceil(top - ceiling - 2);
      else if (top < ceiling) pane.scrollTop -= Math.ceil(ceiling - top);
      return;
    }
    var over = bot - (br.bottom - 6);
    if (over > 0.5) pane.scrollTop += Math.ceil(over);
    else if (top < ceiling + 2) pane.scrollTop -= Math.ceil(ceiling + 2 - top);
    snapPanelToPin(parts);
  }

  /* s7.25 ruling 3 (2026-09-12): THE PINNED BLOCK RESERVES ITS HEIGHT.
     The head and the act row are sticky (s7.24 ruling 4), so the body scrolls
     UNDER them and a row can come to rest with its top half covered: wave 1p's
     own money shot has the piece row ("Wall, 2" / "Catapult, 10") frozen at
     half height right under the pin in both themes, which reads as clipped
     text rather than as "there is more here". When a scroll SETTLES the panel
     gives back whatever the pin is covering of the first row it cuts, so a row
     is drawn whole or not at all.

     `keep` is the list of elements a caller has just scrolled INTO view: the
     reveal of the partner portrait is a pinned ruling of its own, so the snap
     is reverted rather than allowed to push any of them out of the window. */
  function panelRows() {
    var body = byId('kit-panel-body'), out = [], i, j, ch, g;
    if (!body) return out;
    for (i = 0; i < body.children.length; i++) {
      ch = body.children[i];
      if (ch.hidden || !ch.offsetHeight) continue;
      if (ch.className && String(ch.className).indexOf('kit-group') >= 0) {
        for (j = 0; j < ch.children.length; j++) {
          g = ch.children[j];
          if (!g.hidden && g.offsetHeight) out.push(g);
        }
      } else out.push(ch);
    }
    return out;
  }

  function panelPartsWhole(parts, br, ceiling) {
    var i, r;
    for (i = 0; i < (parts ? parts.length : 0); i++) {
      r = parts[i].getBoundingClientRect();
      if (!(r.height > 0)) continue;
      if (r.top < ceiling - 0.5 || r.bottom > br.bottom + 0.5) return false;
    }
    return true;
  }

  function snapPanelToPin(keep) {
    var pane = byId('kit-panel');
    if (!pane || pane.classList.contains('kit-panel--collapsed')) return;
    if (pane.scrollTop <= 0) return;
    var br = pane.getBoundingClientRect();
    var line = panelCeiling(br);
    if (!(line > br.top + 0.5)) return;
    var rows = panelRows(), i, r, cut = 0;
    for (i = 0; i < rows.length; i++) {
      r = rows[i].getBoundingClientRect();
      if (!(r.height > 0)) continue;
      if (r.top < line - 0.5 && r.bottom > line + 0.5) { cut = line - r.top; break; }
    }
    if (cut <= 0.5) return;
    var was = pane.scrollTop, rect = rows[i].getBoundingClientRect();
    /* UP first, which gives the row back whole. When that would push something
       the caller just revealed out of the window, DOWN instead, which hides the
       cut row under the pin rather than leaving half of it drawn; the reveal
       only ever scrolls a part's BOTTOM to the window's edge, so scrolling on
       keeps it inside. When neither holds, the scroll is left where it was. */
    pane.scrollTop = Math.max(0, was - Math.ceil(cut));
    if (!keep || !keep.length ||
        panelPartsWhole(keep, pane.getBoundingClientRect(), panelCeiling(br))) return;
    pane.scrollTop = was + Math.ceil(rect.bottom - line);
    if (!panelPartsWhole(keep, pane.getBoundingClientRect(), panelCeiling(br))) {
      pane.scrollTop = was;
    }
  }

  /* ---- s7.26 ruling 1 (2026-09-12): THE PANEL NEVER FIGHTS A WHEEL --------
     Wave 1q armed this snap on the visitor's OWN scroll, 150 ms after the last
     wheel, touch or key event. The round-5 verifier measured what that costs:
     the snap only ever gives a row back UPWARDS, and from the settled position
     one wheel notch always lands somewhere a row is cut, so the panel returned
     to exactly where it was, forever. A real wheel could not pass about a
     quarter of the panel in any act (348 to 407 of 850 to 1,731), and in Your
     turn a long continuous gesture reached the end and then visibly sprang
     back about 355 px, taking the "Model verified" honesty line and the credit
     line off the screen again (ship5/verify probe6, probe7, probe9).

     So the snap runs ONCE after a scroll the PAGE made, and never after a
     gesture the visitor made: opening the panel (`:9508`) and the partner
     reveal (`revealPartnerCard`) are the two, and both are programmatic. The
     half-cut row s7.25 ruling 3 answered is still answered where the page put
     the panel; where the VISITOR put it, the scroll is theirs and the page
     does not take it back. `setProse`'s exact restore is still never snapped.

     `wirePanelSnap` is kept as the one place that says this, so the wiring
     cannot come back by accident. */
  function wirePanelSnap() {
    var pane = byId('kit-panel');
    if (!pane || pane.getAttribute('data-snapwired')) return;
    pane.setAttribute('data-snapwired', '1');
    /* deliberately no wheel / touchmove / keydown / scroll listener: see above */
  }

  /* the y the panel's scrollable window really starts at: under whichever of
     the two pinned blocks is on screen */
  function panelCeiling(br) {
    var y = br ? br.top : 0, i, el, r;
    var els = [document.querySelector('.kit-panel__head'), byId('kit-panel-pin')];
    for (i = 0; i < els.length; i++) {
      el = els[i];
      if (!el || !el.offsetParent) continue;
      r = el.getBoundingClientRect();
      if (r.height > 0 && r.bottom > y) y = r.bottom;
    }
    return y;
  }

  /* SEAM R2-S1 TAKEN: the picker shows the renderer's OWN machine plate, so
     the icon and the world sprite are the same drawing and cannot drift.

     Build spec v3 s7.9 ruling 3a: the card is that plate at TRAY_CS css pixels
     per source pixel, which is 104 x 136 for the renderer's 26 x 34 hold
     frame. It was 2x, and at that size all three round 20 judges read the
     machine as a plain block (SEAM R2f-S2). Nothing about the drawing changed:
     the card is still R.machineCard's own pixels, each one a TRAY_CS square,
     so a pixel probe can hold the two against each other. `image-rendering:
     pixelated` in the page style is what keeps the blocks square when the
     browser scales the element for a hi dpi screen. */
  var TRAY_CS = 4;
  /* the picker names the PARTNER, so the card is the partner's machine.
     s7.32 ruling 1 (form b): in Reading the plan the partner being read sits
     in seat 0 and is drawn in the 'a' colour, so the card and its caption take
     that seat's colour there; everywhere else the partner is seat 1, gold. */
  var TRAY_OWNER = 'b';
  function trayOwner() { return pickerReads() ? 'a' : TRAY_OWNER; }
  var trayCards = {};
  function trayPlate() {
    if (!R || !R.machineCard) return null;
    var theme = effectiveTheme(), owner = trayOwner();
    var key = theme + '|' + owner, plate = trayCards[key] || null;
    if (!plate) {
      try { plate = R.machineCard(owner); } catch (e) { plate = null; }
      if (plate) trayCards[key] = plate;
    }
    return plate;
  }
  function drawTrayCard() {
    var box = byId('kit-tray');
    if (!box) return;
    var tcap = byId('kit-tray-cap'), tword = trayOwner() === 'a' ? 'blue' : 'gold';
    if (tcap && tcap.getAttribute('data-word') !== tword) {
      tcap.setAttribute('data-word', tword);
      tcap.textContent = 'A catapult in the partner\'s ' + tword + ': a picture of the ' +
                         'pieces it puts up, not of the engineer.';
    }
    var plate = trayPlate();
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!plate) return;
    var out = document.createElement('canvas');
    out.width = plate.width * TRAY_CS; out.height = plate.height * TRAY_CS;
    out.style.width = out.width + 'px';
    out.style.height = out.height + 'px';
    out.className = 'kit-tray__card';
    var c2 = out.getContext('2d');
    c2.imageSmoothingEnabled = false;
    try { c2.drawImage(plate, 0, 0, plate.width, plate.height, 0, 0, out.width, out.height); }
    catch (e) {}
    box.appendChild(out);
  }

  /* ---- the phone caption card (build spec v3 s7.17 ruling 2) ---------------
     The panel auto-collapses under 600 px, and everything it carries goes with
     it: the act's own sentences and the status line, which on a desktop stand
     beside the board the whole time. At a real phone's pixel ratio the board
     is 178 css px tall and the room under it was 171 px of empty page, so the
     card puts that text back, in the room, in REAL DOM text that is
     selectable, translatable and in the accessibility tree (on a phone the
     panel copy is display:none and therefore in no tree at all).

     It is placed by applyCapcard from the frame's own slot plan, so it can
     never stand on the board, and it hides for a modal, for the walkthrough
     card and whenever the room is too small to hold a line. */
  var capcard = null, capcardProse = null, capcardStatus = null, capcardKey = '';
  /* the box SIZE the card was last cut to fit (s7.24 ruling 4) */
  var capcardFitKey = '';
  var capcardFade = 0;

  function buildCapcard() {
    if (capcard || sizeNow().w >= 600) return;
    capcard = document.createElement('div');
    capcard.className = 'kit-capcard';
    capcard.id = 'kit-capcard';
    capcard.hidden = true;
    /* The STATUS goes first here, where the panel puts it last. The panel's
       order answers a jump the status used to give the prose (s7.15 ruling 2)
       and this card cannot jump: its box is written by the page. What it can
       be is SHORT, and then the line worth having on screen is the live one. */
    capcardStatus = document.createElement('p');
    capcardStatus.className = 'kit-capcard__status';
    capcardStatus.id = 'kit-capcard-status';
    /* #kit-status-sr and GadgetUI's own live region already carry this
       sentence to a screen reader; a third copy would only repeat it */
    capcardStatus.setAttribute('aria-hidden', 'true');
    capcard.appendChild(capcardStatus);
    capcardProse = document.createElement('div');
    capcardProse.className = 'kit-capcard__prose';
    capcardProse.id = 'kit-capcard-prose';
    capcard.appendChild(capcardProse);
    app.appendChild(capcard);
    syncCapcardText();
  }

  function dropCapcard() {
    if (!capcard || sizeNow().w < 600) return;
    if (capcard.parentNode) capcard.parentNode.removeChild(capcard);
    capcard = null; capcardProse = null; capcardStatus = null; capcardKey = ''; capcardFitKey = '';
  }

  /* the same text the panel shows, copied from the same two writers */
  function syncCapcardText() {
    var src = byId('kit-actprose'), p;
    /* ---- s7.26 ruling 8: THE SIX PLANS CARD SAYS ONE THING ----------------
       In the gallery the card carried the act's prose AND the live status
       line, and the dark judge photographed it holding nothing but "Sound is
       on. The speaker button mutes it." between the plan grid and a caption it
       otherwise duplicated. A gallery has no live sentence of its own: what a
       visitor wants there is the plan they just tapped. So in Six plans the
       card carries THAT and nothing else, and where there is nothing tapped
       the card is not shown at all (capcardWanted). */
    if (act.name === 'plans') {
      if (capcardProse) {
        while (capcardProse.firstChild) capcardProse.removeChild(capcardProse.firstChild);
      }
      if (capcardStatus) capcardStatus.textContent = planTapLine();
      trimCapcard();
      return;
    }
    if (capcardProse && src) {
      while (capcardProse.firstChild) capcardProse.removeChild(capcardProse.firstChild);
      for (p = 0; p < src.childNodes.length; p++) {
        capcardProse.appendChild(src.childNodes[p].cloneNode(true));
      }
    }
    if (capcardStatus) capcardStatus.textContent = statusNow();
    trimCapcard();
  }

  /* ---- the card cuts at a SENTENCE (build spec v3 s7.24 ruling 4) ----------
     Both round 4 judges photographed this card ending "...your partner puts up
     gold" with a hairline scrollbar as the only cue: a sentence cut through
     the middle, which reads as broken rather than as "there is more". The card
     has no scrollbar now, so whatever it shows has to be whole. Trailing
     SENTENCES are dropped one at a time until the text fits the room the slot
     plan gave it, whole paragraphs go when a paragraph is emptied, and the
     site's fade cue says that something was left out. The full prose is in the
     panel, one tap away, and the status line at the top is never trimmed: it
     is the live sentence the card exists to carry.

     It reads the card's own height, which is a forced layout, so it runs only
     when the TEXT or the BOX changed, never per frame. */
  function trimCapcard() {
    if (!capcard || capcard.hidden || !capcardProse) return;
    var fits = function () { return capcard.scrollHeight <= capcard.clientHeight + 1; };
    /* the guard is the number of SENTENCES a phone act's prose can carry, not
       a safety net: each turn of this loop is one DOM write and one forced
       layout, and it runs only when the text or the card's SIZE changed */
    var cut = false, guard = 0, ps, last, parts;
    while (!fits() && guard++ < 24) {
      ps = capcardProse.querySelectorAll('p');
      if (!ps.length) break;
      last = ps[ps.length - 1];
      parts = splitSentences(last.textContent);
      if (parts.length > 1) {
        parts.pop();
        last.textContent = parts.join('');
      } else if (ps.length > 1) {
        last.parentNode.removeChild(last);
      } else {
        /* one paragraph of one sentence that still will not fit: the card
           keeps the status line and says so with the cue rather than cutting a
           sentence in half */
        last.parentNode.removeChild(last);
      }
      cut = true;
    }
    capcard.classList.toggle('kit-capcard--more', cut || !fits());
  }

  /* sentence boundaries, keeping the punctuation and the space with the
     sentence they close, so joining the kept ones is the original text */
  function splitSentences(s) {
    var out = String(s || '').match(/[^.!?]+[.!?]+[\s]*|[^.!?]+$/g);
    return out || [String(s || '')];
  }

  function capcardWanted() {
    /* the card exists to carry what the COLLAPSED panel hides (s7.17 ruling 2),
       so with the panel open it is a second copy of what is already on screen,
       and on a phone the open panel stands over the room it would use */
    if (panelOpen) return false;
    if (!(capcard && slotNow && slotNow.card && !coachShown() && !modalOpen())) return false;
    /* s7.26 ruling 8: in Six plans the card exists to hold the plan a visitor
       tapped. With nothing tapped it has nothing to say and is not drawn. */
    if (act.name === 'plans') return !!planTapLine();
    return true;
  }

  /* styles are WRITTEN, never read, and only when the box really moved: this
     runs inside paint() and a forced synchronous layout there would cost a
     frame every frame */
  function applyCapcard() {
    if (!capcard) return;
    var on = capcardWanted(), b = on ? slotNow.card : null;
    var key = on ? (Math.round(b.x) + ',' + Math.round(b.y) + ',' +
                    Math.round(b.w) + ',' + Math.round(b.h)) : '';
    if (key === capcardKey) return;
    capcardKey = key;
    /* s7.19 ruling 4: the card FADES rather than vanishing mid sentence. The
       auditor watched the follow camera take it away in the same frame the
       scale jumped, with the reader half way through its prose. Reduced motion
       gets the old instant swap, which is the right answer there. */
    if (!on) {
      if (reducedMotion() || capcard.hidden) { capcard.hidden = true; return; }
      capcard.classList.add('kit-capcard--out');
      if (capcardFade) clearTimeout(capcardFade);
      capcardFade = setTimeout(function () {
        capcardFade = 0;
        if (!capcardWanted()) capcard.hidden = true;
        capcard.classList.remove('kit-capcard--out');
      }, 240);
      return;
    }
    if (capcardFade) { clearTimeout(capcardFade); capcardFade = 0; }
    capcard.classList.remove('kit-capcard--out');
    capcard.style.left = Math.round(b.x) + 'px';
    capcard.style.top = Math.round(b.y) + 'px';
    capcard.style.width = Math.round(b.w) + 'px';
    /* s7.26 ruling 8: a card whose height is the whole room cuts its one
       sentence at a fixed 74 px with overflow hidden. In the gallery, where the
       card carries exactly one sentence, it takes the height that sentence
       needs and no more; every other act keeps the filled box, whose whole
       line arithmetic is what stops it ending on half a line. */
    if (act.name === 'plans') {
      capcard.style.height = 'auto';
      capcard.style.maxHeight = Math.round(b.h) + 'px';
      capcard.style.paddingTop = '';
    } else {
      capcard.style.height = Math.round(b.h) + 'px';
      capcard.style.maxHeight = '';
      capcard.style.paddingTop = b.pad + 'px';
    }
    var wasHidden = capcard.hidden;
    capcard.hidden = false;
    /* A CARD THAT WAS HIDDEN WHEN ITS TEXT LAST CHANGED WAS NEVER CUT TO FIT.
       trimCapcard returns at once on a hidden card (its height reads 0 and a
       forced layout there would be a lie), so every status write and every
       prose rebuild that lands while the card is away leaves the full prose in
       the node. The card then comes back at a size it already has a fitKey
       for, the fit is skipped, and overflow:hidden cuts a sentence in half.
       Measured on the served page, both themes: after a phone game ends in
       Your turn the card held 252 px of prose in a 63 px box and a visitor
       read "...and use the Catapult" with the rest gone. Coming back from
       hidden therefore always re-cuts. */
    if (wasHidden) capcardFitKey = '';
    /* the one READ, and only when the box's SIZE changed: the text is cut back
       to whole sentences for the room this box has, and the card carries the
       site's fade cue when anything was left out (s7.24 ruling 4). A box that
       only MOVED fits exactly as it did, and a camera ease moves it every
       frame, so the fit is keyed on the size alone. */
    var fitKey = Math.round(b.w) + 'x' + Math.round(b.h) + '|' + Math.round(b.pad);
    if (fitKey !== capcardFitKey) { capcardFitKey = fitKey; syncCapcardText(); }
  }

  /* the act selector moves out of the panel into a bottom bar on phones */
  function buildActbar() {
    if (actbar || sizeNow().w >= 600) return;
    actbar = document.createElement('div');
    actbar.className = 'kit-actbar';
    actbar.id = 'kit-actbar';
    var i, b, build;
    /* Build spec v3 s7.15 ruling 5: the row overflows (754 px of buttons in a
       374 px window) and mobile Chrome draws no scrollbar, so three of the six
       acts sat off screen with no affordance at all. The wrap carries a fade
       and an arrow, both shown only while the row really overflows. */
    var wrap = document.createElement('div');
    wrap.className = 'kit-actbar__wrap';
    wrap.id = 'kit-actbar-wrap';
    var row = document.createElement('div');
    row.className = 'kit-actbar__row';
    row.id = 'kit-actbar-acts';
    wrap.appendChild(row);
    var fade = document.createElement('div');
    fade.className = 'kit-actbar__fade';
    fade.setAttribute('aria-hidden', 'true');
    wrap.appendChild(fade);
    var arrow = document.createElement('button');
    arrow.type = 'button';
    arrow.className = 'kit-actbar__arrow';
    arrow.id = 'kit-actbar-arrow';
    arrow.textContent = '›';
    arrow.setAttribute('aria-label', 'Scroll the acts');
    arrow.addEventListener('click', function () {
      row.scrollLeft += Math.max(120, row.clientWidth * 0.7);
      setTimeout(syncActbarOverflow, 260);
    });
    row.addEventListener('scroll', syncActbarOverflow);
    wrap.appendChild(arrow);
    actbar.appendChild(wrap);
    /* the speaker is the FIRST thing in the first row (ruling 5): it used to
       be the seventh item, 279 px past the right edge */
    actbarSound = document.createElement('button');
    actbarSound.type = 'button';
    actbarSound.className = 'kit-btn';
    actbarSound.id = 'kit-actbar-sound';
    actbarSound.addEventListener('click', function () { armAudio(); setMuted(audioOn); });
    row.appendChild(actbarSound);
    for (i = 0; i < ACTS.length; i++) {
      b = document.createElement('button');
      b.type = 'button';
      b.className = 'kit-btn kit-act';
      b.setAttribute('data-act', ACTS[i]);
      b.textContent = ACT_NAME[ACTS[i]];
      (function (btn) {
        btn.addEventListener('click', function () {
          armAudio(); playSound('ui-tick', {});
          setAct(btn.getAttribute('data-act'));
        });
      })(b);
      row.appendChild(b);
    }
    /* The build controls belong on the phone too. The panel auto-collapses
       under 600 px, so with the acts moved out of it and nothing else in their
       place the visitor could not end a build phase without opening the panel
       first, which is the fourinarow lesson restated: a primary action a phone
       visitor has to go looking for is not reachable. */
    build = document.createElement('div');
    build.className = 'kit-actbar__row';
    build.id = 'kit-actbar-build';
    /* Build spec v3 s7.19 ruling 3: DONE BUILDING IS FIRST. At 390 x 844 it
       used to sit at x 367 of 390, a hundred pixels of it off the right edge,
       in a row that scrolls but whose only cue was a chevron drawn on another
       button's label, while the board caption told the visitor to press it.
       Both ship-gate visitor lanes called that blocking. First in the row is
       the one position that is fully visible at every phone width, and the
       budget goes LAST because it is a readout and not an action. */
    var defs = [
      ['kit-bar-done', 'Done building', function () { armAudio(); doneBuilding(); }],
      ['kit-bar-wall', 'Wall', function () { armAudio(); selectPiece(PIECE_WALL); }],
      ['kit-bar-gun', 'Catapult', function () { armAudio(); selectPiece(PIECE_GUN); }],
      ['kit-bar-undo', 'Undo', function () { armAudio(); undoPlacement(); }]
    ];
    for (i = 0; i < defs.length; i++) {
      b = document.createElement('button');
      b.type = 'button';
      b.className = 'kit-btn';
      b.id = defs[i][0];
      b.textContent = defs[i][1];
      b.addEventListener('click', defs[i][2]);
      build.appendChild(b);
    }
    /* the budget rides with the buttons that spend it here too (ruling 2) */
    var bud = document.createElement('span');
    bud.id = 'kit-bar-budget';
    bud.textContent = 'Budget 0';
    build.appendChild(bud);
    /* s7.26 ruling 7: once a game has ended the row's four controls are all
       greyed and the light judge had no way to play again: New game lives in
       the panel, and on a phone the panel is collapsed. It takes the place the
       greyed row leaves and is the only enabled thing in it. */
    var ng = document.createElement('button');
    ng.type = 'button';
    ng.className = 'kit-btn';
    ng.id = 'kit-bar-newseed';
    ng.textContent = 'New game';
    ng.hidden = true;
    ng.addEventListener('click', newGamePress);
    build.appendChild(ng);
    actbar.appendChild(build);
    wireGreyReason(build);
    app.appendChild(actbar);
    syncSoundBtn();
    syncActButtons();
    syncPieceButtons();
    syncControlVisibility();
    syncBudget(true);
    syncActbarOverflow();
  }

  /* the fade and the arrow appear only while the strip really has more to
     show, and go away at the end of the scroll. Ruling 3: the arrow must never
     paint over a label, so while it is shown the row carries its own trailing
     padding (the class is on the wrap and the padding rule is in the sheet). */
  function syncActbarOverflow() {
    var wrap = byId('kit-actbar-wrap'), row = byId('kit-actbar-acts');
    if (!wrap || !row) return;
    var more = (row.scrollWidth - row.clientWidth - row.scrollLeft) > 8;
    wrap.classList.toggle('kit-actbar__wrap--more', more);
  }

  /* ------------------------------------------------- one of everything, not two
     Build spec v3 s7.19 ruling 3. On a phone the panel holds a full copy of
     the acts and the build controls and so does the bottom bar; with the panel
     expanded a judge met twelve act buttons, six of them 0 x 0, and could not
     tell which set was the real one. The bar is the phone's controls; while
     the panel is EXPANDED the bar stands down, and while it is collapsed the
     panel's duplicates are inert and hidden rather than merely invisible. */
  function syncBarVsPanel() {
    if (!actbar) { markPanelDupes(false); return; }
    var hide = panelOpen;                 /* the expanded panel owns the screen */
    if (actbar.hidden !== hide) {
      actbar.hidden = hide;
      if (hide) actbar.setAttribute('inert', '');
      else actbar.removeAttribute('inert');
    }
    markPanelDupes(!hide);
  }

  /* ---- s7.24 ruling 1: the expanded phone panel stands down for play -------
     On a desktop the panel has its own reserved column and covers no board
     pixel, so nothing happens there. On a phone it IS the screen: the dark
     judge pressed Done building inside it and watched a whole wave resolve
     behind it. Collapsing hands the bottom bar back through the panel's own
     toggle, so the bar, the layout and the cue are all synchronised by the one
     path that already does it. */
  function collapseForPlay() {
    if (!panelOpen || !panelUI || !phone()) return false;
    panelUI.setCollapsed(true);
    return true;
  }

  /* ---- New game asks first (build spec v3 s7.24 ruling 4) -----------------
     A build worth asking about is one THIS visitor started and has not sent
     into a wave yet. The button carries the question, so it is answered in the
     place the press already happened, it needs no modal, and it disarms itself
     on any other input or after eight seconds. */
  var newSeedAt = 0, newSeedTimer = 0, NEWSEED_ASK_MS = 8000;

  function buildAtRisk() {
    return act.name === 'you' && !!S && S.phase === 'build' && !S.buildDone &&
           !S.over && myMoves.length > 0;
  }

  /* true when this press was the QUESTION rather than the answer */
  function newSeedArmed() {
    var b = byId('kit-newseed');
    if (!b) return false;
    if (newSeedAt && now() - newSeedAt < NEWSEED_ASK_MS) return false;   /* the answer */
    if (!buildAtRisk()) return false;
    newSeedAt = now();
    b.textContent = 'Discard the build?';
    /* a question nobody answered goes back to being a button */
    if (newSeedTimer) clearTimeout(newSeedTimer);
    newSeedTimer = setTimeout(newSeedDisarm, NEWSEED_ASK_MS + 40);
    setStatus('That would throw away the ' + unitCount(myMoves.length, 'piece') +
              ' you have placed. Press again to start a new game.', { force: true });
    return true;
  }

  function newSeedDisarm() {
    var b = byId('kit-newseed');
    newSeedAt = 0;
    if (newSeedTimer) { clearTimeout(newSeedTimer); newSeedTimer = 0; }
    if (b && b.textContent !== 'New game') b.textContent = 'New game';
  }

  /* s7.24 ruling 4: NEW GAME ASKS. The panel critic measured a click at a
     remembered position firing this and throwing a half-finished build away
     with no warning and no undo, which was the round's top defect. The button
     itself becomes the question, so the answer is one more press in the same
     place and nothing modal stands in the way; anything else the visitor does
     disarms it. It only ever asks when there is really something to lose: a
     build this visitor started and has not yet sent into a wave.
     s7.26 ruling 7: module level, because the phone's own New game button is
     rebuilt with the act bar on every resize and binds the same press. */
  function newGamePress() {
    armAudio();
    if (newSeedArmed()) return;
    newSeedDisarm();
    act.seed = (((act.seed * 1103515245 + 12345) >>> 0) % 90000) + 1;
    /* A NEW GAME IS A NEW GAME. setAct stashes the your-turn session on its
       way out (s7.21 ruling 10) and the stash is keyed on the seed, so
       pressing New game from inside Your turn stashed the build against the
       seed that had ALREADY been replaced and handed it straight back: the
       board changed and the visitor's own pieces came with it. Found by that
       ruling's own suite row, which is what the question in front of it is
       supposed to be protecting. */
    myMoves.length = 0;
    youStash = null;
    setAct(act.name);
  }

  /* one to nine as words, which is the page's own copy rule */
  var COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five',
                     'six', 'seven', 'eight', 'nine'];
  function unitCount(n, word) {
    var v = Math.max(0, Math.round(n));
    return (v < COUNT_WORDS.length ? COUNT_WORDS[v] : String(v)) +
           ' ' + word + (v === 1 ? '' : 's');
  }

  /* the panel's own copies: inert and hidden while the bar carries them */
  function markPanelDupes(off) {
    var panel = byId('kit-panel');
    if (!panel) return;
    var ids = ['kit-acts', 'kit-build-controls'], i, el;
    for (i = 0; i < ids.length; i++) {
      el = byId(ids[i]);
      if (!el) continue;
      if (off) { el.setAttribute('inert', ''); el.setAttribute('aria-hidden', 'true'); }
      else { el.removeAttribute('inert'); el.removeAttribute('aria-hidden'); }
    }
  }

  /* the site's scroll fade cue on the panel (ruling 3). The last line a
     collapsed-height panel shows was being cut through the middle of a word,
     which reads as clipped text rather than as "there is more here". */
  function syncPanelCue() {
    var panel = byId('kit-panel');
    if (!panel) return;
    var more = (panel.scrollHeight - panel.clientHeight - panel.scrollTop) > 8;
    panel.classList.toggle('kit-panel--more', more && !panel.classList.contains('kit-panel--collapsed'));
  }

  function dropActbar() {
    if (!actbar || sizeNow().w < 600) return;
    if (actbar.parentNode) actbar.parentNode.removeChild(actbar);
    actbar = null; actbarSound = null;
  }

  /* ------------------------------------------------------------------- boot */

  function retheme() {
    if (R && R.setTheme) { try { R.setTheme(effectiveTheme()); } catch (e) {} }
    drawTrayCard();
  }

  /* SEAM P14-S3 CLOSED by Z-R's wave 1m entry (s7.21 ruling 7). The two things
     the light-rm judge measured still moving on a resting board, the keep's
     pennant and the terrain shimmer, are painted inside R.frame from the
     renderer's own clock and were never this zone's to still. The renderer now
     reads `fx.reduced`, which this page has sent on every frame since wave 1k
     (`FX.reduced = reducedMotion()`), so the fix is live without a call; this
     pushes `R.setReducedMotion` as well, which is the entry point Z-R shipped
     for a caller with no fx, and covers the frames before the first paint.
     `__kit.reducedPushed()` reports both channels so a probe can tell "the
     page asked" from "nobody asked". */
  var rmPushed = null;
  function pushReduced() {
    var want = reducedMotion();
    if (R && R.setReducedMotion) {
      try { R.setReducedMotion(want); rmPushed = want; return true; } catch (e) {}
    }
    rmPushed = null;
    return false;
  }

  function boot() {
    if (!cv || !ctx) return;
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    /* the close up lasts as long as the pointer stays on its machine */
    cv.addEventListener('pointerleave', function (e) {
      hoverMachine(-1, e.pointerType);
      /* s7.19 ruling 2: the illegal marker is cleared when the pointer leaves
         the board. Two judges parked the pointer off the canvas after a
         refused click and found the warm cross still on that tile 10 s later. */
      ghostBad = -1;
      FX.ghost = null;
      FX.hover = -1;
    });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    cv.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      var p = localPt(e), c = cellAtCss(p.x, p.y);
      if (c >= 0) removeAt(c);
    });
    if (window.GadgetUI && GadgetUI.longPress) {
      GadgetUI.longPress(cv, function (e) {
        var p = localPt(e), c = cellAtCss(p.x, p.y);
        if (c >= 0) removeAt(c);
      });
    }
    document.addEventListener('keydown', onKey);
    /* the first REAL gesture anywhere is what may create the AudioContext */
    document.addEventListener('pointerdown', armAudio, true);
    document.addEventListener('keydown', armAudio, true);

    /* Ruling 1: the "?" button opens the HELP card, so no first-run hint is
       handed to initPanel and initPanel wires nothing to it. */
    if (window.GadgetUI && GadgetUI.initPanel && panel) {
      panelUI = GadgetUI.initPanel({
        panel: 'kit-panel', toggle: 'kit-collapse',
        collapsedClass: 'kit-panel--collapsed',
        onToggle: function (c) {
          panelOpen = !c;
          syncBarVsPanel(); layout(); syncPanelCue();
          /* s7.24 ruling 4: the reveal that could not run. On a phone the
             press that enters Your turn comes from the COLLAPSED act bar, so
             revealPartnerCard returned early on !panelOpen and the toggle
             never re-ran it: the portrait was drawn 30 px below the panel's
             fold and 39 px past the bottom of the screen (the round 4
             verifier's one major, ship4/verify/portrait-phone2.js). The press
             leaves the reveal pending and opening the controls pays it. */
          if (panelOpen && revealPending) { revealPending = false; revealPartnerCard(); }
          /* s7.25 ruling 3: a panel that opens on a scroll it kept from last
             time opens with a row half under the pin, which is the state wave
             1p photographed. Opening is a visitor's own gesture, so the snap
             runs on it with nothing to protect. */
          if (panelOpen) setTimeout(function () { snapPanelToPin(null); }, 0);
        }
      });
      panelOpen = !panel.classList.contains('kit-panel--collapsed');
      panel.addEventListener('scroll', syncPanelCue);
    }
    if (window.GadgetUI && GadgetUI.liveStatus) GadgetUI.liveStatus(statusEl);

    coachInit();
    wireButtons();
    writeLedger();          /* the empty state, so the region is never blank */
    buildActbar();
    buildCapcard();
    syncBarVsPanel();
    recenterEl = document.createElement('button');
    recenterEl.type = 'button';
    recenterEl.id = 'kit-recenter';
    recenterEl.className = 'kit-recenter';
    recenterEl.textContent = 'Recenter';
    recenterEl.hidden = true;
    recenterEl.addEventListener('click', function () { armAudio(); recenterCamera(); });
    app.appendChild(recenterEl);
    /* ruling 6: the Step control lives ON THE BOARD, beside the still it
       advances, and exists only in the mode that needs it */
    stepEl = document.createElement('button');
    stepEl.type = 'button';
    stepEl.id = 'kit-step';
    stepEl.className = 'kit-recenter kit-step';
    stepEl.textContent = 'Step';
    stepEl.hidden = true;
    stepEl.addEventListener('click', function () { armAudio(); rmStep(); });
    app.appendChild(stepEl);
    syncPieceButtons();
    syncPartnerUI();
    syncSoundBtn();
    retheme();
    layout();

    window.addEventListener('resize', function () {
      buildActbar(); dropActbar(); buildCapcard(); dropCapcard();
      syncBarVsPanel(); layout();
    });
    /* The chat widget injects its fixed bottom bar AFTER the page scripts run,
       so the first layout measures nothing and this watches for it.

       SEAM A-S5 (Z-A, 2026-09-09) profiled a REAL act click with the sound
       already armed and found `sizeNow` inside `layout` inside THIS observer
       holding 189 to 277 ms of self time, the heaviest frame in the page's own
       scripts. The cause is the subscription, not the work: it watches the
       whole body subtree for childList, and once the widget exists it ran a
       full layout for EVERY DOM write the page makes for the rest of the visit.
       Entering Strangers writes the screen-reader grid table once per arriving
       cell, so 64 cells meant 64 forced reflows, each one right after an
       innerHTML write on a 65 row table, which is the worst possible moment to
       read `clientWidth`.

       It only ever needed to fire ONCE, so it now disconnects the first time it
       sees the widget. Before that sighting the callback costs one
       getElementById per mutation, as it always did. The resize handler and the
       two timed layouts below are unchanged. */
    var chatObs = new MutationObserver(function () {
      if (!byId('chat-widget')) return;
      chatObs.disconnect();
      layout();
    });
    chatObs.observe(document.body, { childList: true, subtree: true });
    setTimeout(layout, 300);
    setTimeout(layout, 1500);

    new MutationObserver(retheme).observe(document.documentElement,
      { attributes: true, attributeFilter: ['data-theme'] });
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: light)');
      if (mq.addEventListener) mq.addEventListener('change', retheme);
      /* s7.21 ruling 7, SEAM P14-S3: the keep's pennant and the terrain
         shimmer are drawn inside the renderer's own frame from its own clock,
         so the page tells it what the visitor asked for at boot and again
         whenever the preference changes. */
      var rmq = window.matchMedia('(prefers-reduced-motion: reduce)');
      if (rmq.addEventListener) rmq.addEventListener('change', pushReduced);
    }
    pushReduced();
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopAllLoops();
    });

    /* the verification line is driven by the check actually running */
    resolveVerify();
    if (verifyEl) verifyEl.textContent = VERIFY.line;

    /* the worker is armed BEFORE the first act, because a share link that
       restores Strangers runs startStrangers() inside setAct and would find
       workerPending false and play 64 real games on the main thread
       (SEAM A-S3). initWorker only reads act.name from its own async
       callbacks, so arming it first changes nothing else. */
    initWorker();
    if (!restoreFromHash()) setAct('watch');
    /* the once-per-visitor auto-run, after the layout (corner buttons, the
       late chat bar) has settled. It never advances on its own from here. */
    var seen = true;
    try { seen = !!localStorage.getItem(TOUR_KEY); } catch (e) {}
    if (!seen) setTimeout(function () { if (!tourOn) startTour(); }, 900);
    if (modelErr) setStatus('The engineers did not load: ' + modelErr);
    /* The plate sentence goes through the live status mirror in its own task:
       two writes inside one task are one mutation to an aria-live region, and
       the act status written a moment ago would swallow it. */
    if (VERIFY.plate) setTimeout(function () { setStatus(VERIFY.plate, true); }, 0);
    rafId = requestAnimationFrame(frame);
    /* a38: the panel is wired, so its controls are offered from here on, and
       the static loading line goes once the first frame is up */
    if (panel) panel.removeAttribute('data-boot');
    requestAnimationFrame(function () {
      var ld = byId('kit-loading');
      if (ld && ld.parentNode) ld.parentNode.removeChild(ld);
    });
  }

  /* ------------------------------------------------------------- test hook */

  window.__kit = {
    act: function () {
      return { name: act.name, sub: act.sub, seq: act.seq, seed: act.seed,
               pool: act.pool, partner: act.partner, bonusOnly: act.bonusOnly };
    },
    setAct: function (n) { setAct(n); },
    session: function () { return S; },
    state: function () { return S ? renderState(S) : null; },
    view: function () { return view; },
    workerAlive: function () { return workerAlive; },
    /* SEAM A-S3: true from initWorker until the worker says ready or dies. A
       suite reads it to prove the grid waits for the worker instead of playing
       real games on the main thread while it boots. */
    workerPending: function () { return workerPending; },
    gridStats: function () {
      return FX.grid ? { done: FX.grid.done, total: FX.grid.total, cached: gridOrder.length } : null;
    },
    /* A.6: a browser suite cannot otherwise tell a worker painted cell from a
       fallback painted one. Read only. */
    grid: function () { return FX.grid; },
    /* s7.29 ruling 5: one pairing played on demand, so a probe can put the
       SAME two engineers in both seats and read the game rather than the
       picture. Read only; it plays through the page's own runner. */
    runPairing: function (a, b, seed) {
      var r = runPairing(String(a), String(b), (seed >>> 0) || 0);
      return r ? { hp: r.hp, score: r.score } : null;
    },
    audio: function () { return Audio; },
    audioReplay: function (fixture, opts) {
      if (!Audio || !Audio.replay) return null;
      try { return Audio.replay(fixture, opts || {}); } catch (e) { return null; }
    },
    audioLog: function () { return audioLog.slice(); },
    loops: function () { var o = {}, k; for (k in loopsOn) o[k] = loopsOn[k]; return o; },
    armed: function () { return audioArmed; },
    muted: function () { return !audioOn; },
    sounds: soundsFor,
    fx: function () { return FX; },
    caption: captionText,
    /* the caption plate as the last frame really drew it, in css px, so a
       probe measures the room under the board rather than re-deriving it from
       the pads (build spec v3 s7.16 ruling 5) */
    capBox: function () {
      return capDrawn ? { x: capDrawn.x, y: capDrawn.y, w: capDrawn.w, h: capDrawn.h,
                          lines: (capDrawn.lines || []).slice() } : null;
    },
    /* s7.17 ruling 1: the scale the page asked the renderer for, the one it
       got, and whether the whole board is on screen at this width and ratio */
    phoneFit: function () {
      return { phone: phone(), dpr: dpr, intS: phoneIntS(dpr),
               S: view ? view.S : null, whole: phoneWhole(),
               reserve: view ? view.reserve : null,
               follow: following(), lift: capLift };
    },
    /* s7.17 ruling 2: the room under the board and who it went to this frame */
    slot: function () {
      if (!slotNow) return null;
      var o = { x: slotNow.x, y: slotNow.y, w: slotNow.w, h: slotNow.h };
      o.bars = slotNow.bars; o.loupe = slotNow.loupe; o.card = slotNow.card;
      /* what is left of the room after its tenants, which is what a close up
         asks before it decides whether it can stand there */
      o.free = slotNow.free || null;
      return o;
    },
    /* the caption card as it really stands: its box, and the text in it */
    capcard: function () {
      if (!capcard) return null;
      var r = capcard.hidden ? null : capcard.getBoundingClientRect();
      return { on: !capcard.hidden,
               box: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null,
               prose: capcardProse ? capcardProse.textContent : '',
               status: capcardStatus ? capcardStatus.textContent : '' };
    },
    verify: function () {
      return { kind: VERIFY.kind, line: VERIFY.line, plate: VERIFY.plate,
               box: plateBox ? { x: plateBox.x, y: plateBox.y, w: plateBox.w, h: plateBox.h } : null };
    },
    boxes: function () { return boxes; },
    /* The board pixels really ON SCREEN: `boxes.board` is the whole tile plate
       in screen coordinates, and under a follow camera (the phone's, and since
       s7.21 ruling 9 the desktop's) most of that plate is outside the blit. A
       probe asking "does this card cover the board" means the drawn part. */
    /* ONE definition, shared with the readout's own "is the meter on screen"
       test (s7.22 ruling 6): two copies of this clip was how the readout and
       the hook could have disagreed about the same frame. */
    boardDrawn: drawnBoardRect,
    moves: function () { return myMoves.slice(); },
    place: function (cell, piece) { return placePiece(cell, piece || selPiece); },
    doneBuilding: doneBuilding,
    undo: undoPlacement,
    mark: markFocus,
    cellAt: cellAtCss,
    ready: ready,
    missing: missingList,
    lastError: function () { return lastErr; },
    tour: function () {
      var r = (coachEl && !coachEl.hidden) ? coachEl.getBoundingClientRect() : null;
      return { on: tourOn, step: tourStep, steps: TOUR.length,
               active: tourActive(),
               shown: !!(coachEl && !coachEl.hidden),
               text: coachText ? coachText.textContent : '',
               box: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null,
               captions: TOUR.map(function (b) { return b.caption; }) };
    },
    tourNext: tourNext,
    tourStart: startTour,
    helpOpen: function () { var e = byId('kit-helpcard'); return !!(e && !e.hidden); },
    openHelp: openHelp,
    closeHelp: closeHelp,
    status: statusNow,
    /* every paint of the line, so a suite can measure the dwell law over a
       real session instead of sampling it (ruling 2) */
    statusLog: function () { return stLog.slice(); },
    budget: function () {
      var w = byId('kit-piece-wall'), g = byId('kit-piece-gun');
      return { left: budgetLeft(), shown: byId('kit-budget-n') ? byId('kit-budget-n').textContent : '',
               bar: byId('kit-bar-budget') ? byId('kit-bar-budget').textContent : '',
               wallOff: !!(w && w.hasAttribute('disabled')),
               gunOff: !!(g && g.hasAttribute('disabled')) };
    },
    ghost: function () {
      return { ok: FX.ghost ? FX.ghost.cell : -1, bad: ghostBad };
    },
    endMark: function () { return endMark; },
    phaseLine: phaseLine,
    /* ---- s7.19's own hooks ------------------------------------------------
       Every one of these reports what a FRAME really did, never what the page
       would like to have done: the caption's paint log, the plate width it
       asked for, the tiles the legal band really lit, the engagement's own
       clock, and the two controls the rulings added. */
    capLog: function () { return capLog.slice(); },
    capPlateW: capPlateW,
    legal: function () {
      var c = legalCells();
      return { armed: selPiece, cells: c ? c.length : 0, drawn: bandDrawn,
               /* the tiles themselves, so a suite can aim a REAL click at one
                  the ARMED piece may take rather than re-deriving core's own
                  answer for a wall and hoping it holds for a catapult */
               list: c ? c.slice(0, 400) : [] };
    },
    hint: function () {
      return { cell: hintRingCell, on: hintRingAt > 0, done: hintDone,
               /* the label plate as a frame really drew it, so a probe reads
                  the drawing rather than re-deriving it (the plate used to run
                  off the left edge of a phone) */
               lab: hintLabBox ? { x: hintLabBox.x, y: hintLabBox.y,
                                   w: hintLabBox.w, h: hintLabBox.h,
                                   text: hintLabBox.text } : null };
    },
    keepNum: function () { return keepNumBox; },
    /* s7.29 rulings 1 and 2: the framed picture's own edges as the last frame
       drew them, the overview inset's backing rect and the keep's footprint
       on screen, so a suite reads the DRAWING and never re-derives it */
    frameEdges: function () {
      var fr = null;
      try { fr = (RAPI && RAPI.frameRect && view) ? RAPI.frameRect(view) : null; }
      catch (e) { fr = null; }
      return { put: frameEdgesDrawn,
               cut: fr ? { top: !fr.top, bottom: !fr.bottom,
                           left: !fr.left, right: !fr.right } : null,
               rect: fr ? { x: fr.x, y: fr.y, w: fr.w, h: fr.h } : null };
    },
    inset: function () { return insetDrawn; },
    keepRect: keepScreenRect,
    recenterBox: function () {
      if (!recenterEl || recenterEl.hidden) return null;
      var r = recenterEl.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    },
    /* s7.28 ruling 5: the pieces the LAST FRAME really drew, both seats, so a
       suite can ask what a plate covers instead of re-deriving the board */
    pieces: function () { return Array.prototype.slice.call(RS.piece); },
    /* s7.24 ruling 1 and ruling 9's instruments: the rect no canvas text may
       enter and how many runs the last frames refused, and whether the keep
       readout's handover is in flight this frame */
    hudMask: function () {
      return { rect: hudMask ? { x: hudMask.x, y: hudMask.y, w: hudMask.w, h: hudMask.h } : null,
               skipped: hudMaskSkips };
    },
    keepFlight: function () {
      return { own: keepEase.own, at: keepEase.at,
               dx: keepEase.dx, dy: keepEase.dy,
               live: (now() - keepEase.at) < KEEP_EASE_MS };
    },
    barsHeader: function () { return FX.bars ? barsHeader(FX.bars) : ''; },
    barsRoom: function () { return { noRoom: barsNoRoom, line: barsRoomLine() }; },
    newSeed: function () {
      var b = byId('kit-newseed');
      return { label: b ? b.textContent : '', armed: !!newSeedAt, risk: buildAtRisk() };
    },
    /* SEAM I1M-S2 TAKEN: the renderer INSTANCE the page really draws through.
       `window.KeepRender` is only the factory, so every probe trying to prove
       "the page calls the renderer's new entry point" read `undefined` off the
       factory or wrapped `create` in an init script to get at this object. */
    renderer: function () { return R; },
    /* s7.22 ruling 3: the board's top edge for the act that is standing, and
       the edge a gallery is offered (they are the same number; a gallery draws
       no board, so the second is computed through the same ladder) */
    topEdge: function () {
      var dr = drawnBoardRect();
      return { board: dr ? Math.round(dr.y) : null, offer: boardTopEdge(),
               act: act.name };
    },
    phoneLoupe: function () { return phoneLoupeBox; },
    follow: function () { return { k: follow.k, wanted: followWanted(), full: followFull() }; },
    step: function () {
      var r = (stepEl && !stepEl.hidden) ? stepEl.getBoundingClientRect() : null;
      return { on: !!(stepEl && !stepEl.hidden), stepping: rmStepping,
               box: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null };
    },
    doStep: rmStep,
    bar: function () {
      var b = byId('kit-actbar');
      return { exists: !!b, hidden: !!(b && b.hidden), panelOpen: panelOpen,
               dupes: document.querySelectorAll('#kit-panel .kit-act').length,
               dupesInert: !!(byId('kit-acts') && byId('kit-acts').hasAttribute('inert')) };
    },
    gridTapAt: gridTapAt,
    /* s7.23 ruling 3: the tile boxes the last gallery frame drew, so a suite
       can aim a REAL tap at a named plan and prove the caption card answered
       with that plan's own long sentence */
    planBoxes: function () {
      var G = planCells, out = [], i;
      if (!G) return null;
      for (i = 0; i < 6; i++) {
        out.push({ x: G.x0 + (i % G.cols) * (G.w + G.gap),
                   y: G.y0 + ((i / G.cols) | 0) * (G.h + G.capH + G.gap),
                   w: G.w, h: G.h });
      }
      return out;
    },
    partner: function () {
      var d = partnerDef(pickerKey());
      return { key: d.key, n: pickerN(), label: d.label, note: d.note,
               pick: d.pick, count: d.n, bars: !!FX.bars,
               reads: pickerReads(), seat: act.partner, seatN: act.partnerN };
    },
    setPartner: setPartner,
    /* s7.22 ruling 7: every form the page was OFFERED for each tile of the
       gallery that is standing (PIN R-S7's long sentence first, then its short
       one), so a narrow lane can prove the short form was taken before any
       ellipsis rather than inferring it from a truncated string. */
    planPhrases: function () {
      var p = FX.plans, out = [], i;
      if (!p) return null;
      /* s7.25 ruling 2: through `planFormsFor`, so the hook reports the forms
         the tile fitter really walks, "this game: " and all, rather than the
         renderer's vocabulary before the page labelled it */
      for (i = 0; i < 6; i++) out.push(planFormsFor(p, i));
      return out;
    },
    plans: function () {
      if (!FX.plans) return null;
      var out = [], tag = [], i, p = FX.plans;
      for (i = 0; i < 6; i++) {
        out.push(p.cells[i] ? Math.round(p.cells[i].score) : null);
        tag.push((p.dist && !p.dist[i]) ? convergeTag(i, p.near, p.shorts, p.dist) : null);
      }
      return { done: p.done, total: p.total,
               names: p.shorts.slice(), scores: out,
               dist: p.dist ? p.dist.slice() : null,
               near: p.near ? p.near.map(function (x) { return x ? x.near : -1; }) : null,
               tags: tag, caption: plansCaption(p, !planJob) };
    },
    /* the marks the last frame really painted under the six cards */
    /* s7.21 ruling 4: turn the text-run ledger on, and read the last painted
       frame's runs. `textRuns(true)` then one animation frame, then
       `textRuns()` returns what that frame really drew. */
    textRuns: function (on) {
      if (on === undefined) return textLast ? textLast.slice() : null;
      textRecOn = !!on;
      if (textRecOn) { textWrap(); textLast = null; }
      else { textRec = null; }
      return textRecOn;
    },
    seatLegend: function () { return seatLegBox; },
    /* s7.26 rulings 2 and 5: the caption row's own slots as the last frame
       dealt them, and the resting board foot the row is placed below */
    capRow: function () {
      var c = function (r) {
        return r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null;
      };
      return { step: c(capRowStep), legend: c(capRowLeg), budget: c(capRowBud),
               budgetText: capRowBud ? budgetChipText() : '',
               frameBot: Math.round(frameBotRest) };
    },
    /* SEAM P14-S3: what the page asked the renderer for, and whether the
       renderer has the entry point to be asked (s7.21 ruling 7) */
    reducedPushed: function () {
      return { want: reducedMotion(), pushed: rmPushed,
               has: !!(R && R.setReducedMotion),
               frame: !!FX.reduced };
    },
    plansDrawn: function () {
      if (!plansDrawn) return null;
      return { tags: plansDrawn.tags.slice(), capH: plansDrawn.capH,
               /* s7.28 ruling 7 */
               results: plansDrawn.results ? plansDrawn.results.slice() : null,
               /* s7.19 ruling 5: the columns the frame really used, the tile it
                  really drew, and how many blocks the diff highlight lit */
               cols: plansDrawn.cols, tileW: plansDrawn.tileW,
               tileH: plansDrawn.tileH, diff: plansDrawn.diff,
               /* s7.21 ruling 5: the COMPUTED descriptor each tile really
                  printed, and whether it and the converge tag fitted the tile
                  without being shortened */
               descs: plansDrawn.descs ? plansDrawn.descs.slice() : null,
               /* s7.25 ruling 2: the head the frame painted on each tile */
               heads: plansDrawn.heads ? plansDrawn.heads.slice() : null,
               descFit: plansDrawn.descFit !== false,
               tagFit: plansDrawn.tagFit !== false,
               descUnder: plansDrawn.descUnder !== false,
               /* s7.23 rulings 2 and 3: whether a line was painted under the
                  tiles at all, and how many tiles wanted one and could not
                  take it whole (never an ellipsis, so never a silent cut) */
               descOn: plansDrawn.descOn !== false,
               descDrop: plansDrawn.descDrop || 0,
               /* s7.22 ruling 7: WHICH of planWords' forms each tile took, so a
                  320 px lane can tell a short form from a truncation */
               descForm: plansDrawn.descForm ? plansDrawn.descForm.slice() : null,
               descForms: plansDrawn.descForms || 0,
               descSize: plansDrawn.descSize || 0,
               descRows: plansDrawn.descRows ? plansDrawn.descRows.slice() : null,
               /* the lines the STRIP has, which is 0 where s7.23 ruling 3
                  took the strip away: the ledger says nothing was drawn */
               descLines: (typeof plansDrawn.descLines === 'number')
                            ? plansDrawn.descLines : 1,
               capTry: plansDrawn.capTry || null,
               /* s7.22 ruling 3: where the picture really started, the board
                  edge it was offered, and whether it took it */
               gridTop: plansDrawn.gridTop, boardTop: plansDrawn.boardTop,
               alignedTop: !!plansDrawn.alignedTop,
               /* s7.23 ruling 3: the stage the block left for the phone's
                  caption card, which is where a tapped plan is read */
               cardRoom: plansDrawn.cardRoom || 0,
               floorY: plansDrawn.floorY, contentH: plansDrawn.contentH,
               only: plansDrawn.only, shared: plansDrawn.shared,
               /* s7.29 ruling 3 */
               ring: (typeof plansDrawn.ring === 'number') ? plansDrawn.ring : -1,
               tapped: planTapped };
    },
    /* everything the page says because meta says it, so a suite can read the
       branch that was taken rather than scrape the sentence out of a canvas */
    meta: function () {
      return { distinctStyles: distinctStyles(),
               planDistinct: planDistinct(),
               styles: stylesSentence(),
               reader: readerSentence(false),
               readerLong: readerSentence(true),
               size: sizeSentence(),
               matrix: matrixSentence(),
               stylesFine: stylesFine(),
               warm: warmSentence(),
               gap: readerGap(),
               near: lastNear ? lastNear.map(function (x) { return x ? x.near : -1; }) : null };
    },
    /* the gallery's intents, as counted from the worker's own play messages */
    intents: function () {
      var g = FX.grid;
      if (!g || !g.intents) return null;
      return { got: g.intents.got, changed: g.intents.changed, ticks: g.intents.ticks,
               net: g.intents.net, missing: g.intents.missing,
               settled: g.intents.settled.slice(), note: intentNote() };
    },
    mind: mindOf,
    plays: function () { return act.pool === 'ac' && readerPool(); },
    /* where the bars really landed last frame, and the band the layout took
       for them, so a probe reads the drawing rather than re-deriving it */
    barsBox: function () {
      return { plate: barsDrawn ? { x: barsDrawn.x, y: barsDrawn.y,
                                    w: barsDrawn.w, h: barsDrawn.h } : null,
               /* the three columns the last frame really laid out, so a suite
                  can assert the label and the percentage stand OUTSIDE the
                  fill rather than eyeball a screenshot (ruling 3) */
               cols: barsDrawn ? { label: barsDrawn.label, track: barsDrawn.track,
                                   pct: barsDrawn.pct } : null,
               band: { on: barsBand.on, top: barsBand.top, h: barsBand.h,
                       want: barsBand.want },
               wanted: barsWanted() };
    },
    /* test hook: suppress the bars so a pixel diff of two frames is exactly
       the set of pixels the bars own */
    hideBars: function (v) { barsHidden = !!v; return barsHidden; },
    /* test hook: suppress the honesty plate so a pixel diff of two frames is
       exactly the set of pixels the plate owns (s7.10 ruling 4b) */
    hidePlate: function (v) { plateHidden = !!v; return plateHidden; },
    /* test hook: repaint synchronously at a FIXED clock. Two frames taken back
       to back through this differ ONLY by what the caller changed between
       them; the rAF loop would age shots, drones and flashes in between and
       every pixel diff would carry that churn. */
    paintNow: function (t) {
      try { paint(typeof t === 'number' ? t : 0); } catch (e) {}
    },
    bars: function () {
      var b = FX.bars;
      if (!b) return null;
      return { raw: b.raw ? Array.prototype.slice.call(b.raw) : null,
               eased: Array.prototype.slice.call(b.eased),
               lead: b.lead, flip: b.flip, changed: b.changed,
               header: b.header, source: summaryOK() };
    },
    fineOpen: function () { var e = fineEl(); return !!(e && !e.hidden); },
    takeRow: takeRow,
    row: function () { return (FX.grid && FX.grid.row) ? FX.grid.row.slice() : null; },
    gridSummary: gridSummary,
    /* what the last frame really painted into the grid, so a suite reads the
       drawing instead of a screenshot (ruling 4) */
    gridDrawn: function () { return gridDrawn; },
    camera: function () {
      return { follow: following(), x: cam.x, y: cam.y,
               tx: cam.tx, ty: cam.ty, manual: cam.manual,
               fx0: view ? view.fx0 : 0, fy0: view ? view.fy0 : 0,
               loupe: loupeOn() };
    },
    recenter: recenterCamera,
    /* the machine close up: what it is on, where the frame really landed, and
       the source window it is magnifying, so a probe reads the drawing */
    /* s7.24 ruling 8: the cell whose drawn body is under a point, so a suite
       can aim at the MACHINE rather than at the tile it stands on */
    machineAt: function (x, y) { return machineCellAt(x, y, cellAtCss(x, y)); },
    loupe: function () {
      var sb = loupe.on ? loupeSubjectBox() : null;
      return { on: loupe.on, cell: loupe.cell, owner: loupe.owner,
               piece: loupe.piece, src: loupe.src, cs: loupe.cs,
               caption: loupe.caption,
               /* the thing it magnifies, which its own frame may never cover */
               subj: sb ? { x: sb.x, y: sb.y, w: sb.w, h: sb.h } : null,
               win: loupe.win ? { x: loupe.win.x, y: loupe.win.y,
                                  w: loupe.win.w, h: loupe.win.h } : null,
               box: loupe.box ? { x: loupe.box.x, y: loupe.box.y,
                                  w: loupe.box.w, h: loupe.box.h } : null,
               /* the caption strip the honesty plate must never cover, which
                  end of the frame it took, and the picture beside it */
               cap: loupe.cap ? { x: loupe.cap.x, y: loupe.cap.y,
                                  w: loupe.cap.w, h: loupe.cap.h } : null,
               capTop: loupe.capTop,
               pic: loupe.pic ? { x: loupe.pic.x, y: loupe.pic.y,
                                  w: loupe.pic.w, h: loupe.pic.h } : null,
               /* ruling 5: whether this close up is a transient, and how much
                  of its life is left, so a suite reads the page's own deadline
                  instead of timing a screenshot */
               hold: LOUPE_HOLD,
               transient: loupe.until > 0,
               left: loupe.until > 0 ? Math.max(0, Math.round(loupe.until - now())) : 0,
               tour: tourLoupeOn,
               /* s7.26 ruling 12: the room the placement really had */
               fit: loupeFit };
    },
    openLoupe: function (cell) { return openLoupe(cell, 'tap'); },
    closeLoupe: closeLoupe,
    /* the tray card as it was really drawn. The two canvases themselves come
       back through their own accessors, which a probe calls INSIDE the page so
       a pixel comparison never has to cross the wire. */
    tray: function () {
      var el = document.querySelector('#kit-tray canvas');
      var plate = trayPlate();
      var r = el ? el.getBoundingClientRect() : null;
      return { cs: TRAY_CS, owner: trayOwner(),   /* s7.32 addendum 2: the seat it is drawn in */
               w: el ? el.width : 0, h: el ? el.height : 0,
               cssW: r ? r.width : 0, cssH: r ? r.height : 0,
               plateW: plate ? plate.width : 0, plateH: plate ? plate.height : 0 };
    },
    trayCanvas: function () { return document.querySelector('#kit-tray canvas'); },
    trayPlate: trayPlate,
    prose: function () {
      var el = byId('kit-actprose');
      return el ? el.textContent : '';
    },
    ledger: ledgerRows,
    ledgerText: function () {
      var el = byId('kit-sr-ledger');
      return el ? el.textContent : '';
    },
    gridEpisodes: function () {
      return FX.grid && typeof FX.grid.episodes === 'number' ? FX.grid.episodes : GRID_EPISODES;
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
