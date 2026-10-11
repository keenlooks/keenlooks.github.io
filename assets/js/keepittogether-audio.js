/* Keep It Together: sound.
   Every voice is synthesised at runtime from oscillators, deterministic noise
   buffers and filters. No audio files, no third party samples, no network.

   Two halves:
     KeepAudio.PURE   pure scheduling decisions (caps, cooldown, coalescing,
                      ducking arithmetic, loop selection, reduced motion).
                      No WebAudio, no DOM, no Math.random, node testable.
     KeepAudio.*      the WebAudio graph that applies those decisions.

   Graph: voices -> class bus P0..P4 -> solo gate -> master (0.7) -> limiter
   -> safety soft clip -> destination.

   No AudioContext is created until arm() runs inside a real user gesture.
   Spec: .claude/plans/plan-anyplay-keep-build-v3.md section 4.
   Pinned surface: _tests/twoengineers/INTERFACES.md (PIN: AU).

   The one place priority runs INSIDE a class is the ending law (s7.19 ruling
   9), written out in full above ENDING_VOICES below. The short version: the
   keep falling, a wave held and a wave beginning may take a P0 slot from a
   keep-hit, because those three are the sentence the moment has to say. The
   page hands endings over first in a tick (INTERFACES A-S6), and `plan` orders
   them first inside one timestamp anyway. */

(function (root) {
  'use strict';

  /* Seconds added to the context clock when scheduling, so a voice is always
     scheduled slightly ahead of the audio thread rather than in its past. */
  var LOOKAHEAD_DEFAULT = 0.03;

  /* =============================================================== PURE */

  /* Class column of the vocabulary table. P0 the keep and the wave, P1 a
     structure falling and the visitor's own shots landing, P2 the AI's shots
     and kills and building, P3 the texture, P4 the interface. */
  var NCLASS = 5;

  /* name -> {
       cls      class when owner is 0 (visitor) or null (neutral)
       clsAi    class when owner is 1 (the AI). null means owner does not move it
       cap      starts allowed inside a trailing 400 ms window, per (voice, class)
       band     [lo, hi] Hz the measured spectral centroid must sit inside
       declared true when the table gave no numbers and this band is our design
       cent     the design centroid target the synth is tuned to
       dur      nominal seconds, used for the concurrency budget
       kind     'one' or 'loop'
       loopCap  concurrent loops of this kind
     } */
  var VOICES = {
    'windup':          { cls:1, clsAi:2, cap:3, band:[400,1600],  cent:720,  dur:0.38, kind:'one' },
    'release':         { cls:1, clsAi:2, cap:3, band:[150,6000],  cent:1750, dur:0.32, kind:'one' },
    'impact-ground':   { cls:3, clsAi:3, cap:2, band:[60,200],    cent:150,  dur:0.30, kind:'one' },
    'impact-creature': { cls:1, clsAi:2, cap:3, band:[200,3000],  cent:880,  dur:0.30, kind:'one' },
    'discharge':       { cls:1, clsAi:2, cap:3, band:[3000,8000], cent:4200, dur:0.11, kind:'one' },
    'creature-hurt':   { cls:3, clsAi:3, cap:3, band:[1000,3000], cent:2000, dur:0.16, kind:'one' },
    'creature-die':    { cls:2, clsAi:2, cap:3, band:[600,2000],  cent:1080, dur:0.44, kind:'one' },
    'wall-hit':        { cls:3, clsAi:3, cap:2, band:[1000,4000], cent:2900, dur:0.10, kind:'one' },
    'wall-break':      { cls:1, clsAi:1, cap:2, band:[40,3000],   cent:620,  dur:0.92, kind:'one' },
    'gun-break':       { cls:1, clsAi:1, cap:2, band:[300,4000],  cent:2500, dur:0.72, kind:'one', declared:true },
    'breach':          { cls:1, clsAi:1, cap:1, band:[40,1500],   cent:330,  dur:0.85, kind:'one', declared:true },
    'build-wall':      { cls:2, clsAi:2, cap:2, band:[100,300],   cent:200,  dur:0.32, kind:'one' },
    'build-gun':       { cls:2, clsAi:2, cap:2, band:[300,2000],  cent:1350, dur:0.58, kind:'one' },
    'undo':            { cls:4, clsAi:4, cap:1, band:[400,2500],  cent:1250, dur:0.22, kind:'one', declared:true },
    'illegal':         { cls:4, clsAi:4, cap:1, band:[150,900],   cent:420,  dur:0.18, kind:'one', declared:true },
    'drone-turn':      { cls:3, clsAi:3, cap:2, band:[700,3000],  cent:2400, dur:0.26, kind:'one', declared:true },
    'drone-pick':      { cls:3, clsAi:3, cap:2, band:[2000,6000], cent:4200, dur:0.09, kind:'one', declared:true },
    'drone-drop':      { cls:3, clsAi:3, cap:2, band:[1500,5000], cent:3450, dur:0.12, kind:'one', declared:true },
    'keep-hit':        { cls:0, clsAi:0, cap:1, band:[110,900],   cent:380,  dur:1.20, kind:'one' },
    'keep-fell':       { cls:0, clsAi:0, cap:1, band:[50,200],    cent:120,  dur:1.60, kind:'one' },
    'wave-start':      { cls:0, clsAi:0, cap:1, band:[150,1200],  cent:620,  dur:1.20, kind:'one', declared:true },
    'wave-held':       { cls:0, clsAi:0, cap:1, band:[200,1600],  cent:950,  dur:1.50, kind:'one', declared:true },
    'focus-mark':      { cls:4, clsAi:4, cap:1, band:[400,1800],  cent:900,  dur:0.30, kind:'one', declared:true },
    'ui-tick':         { cls:4, clsAi:4, cap:1, band:[2000,4000], cent:2700, dur:0.07, kind:'one' },
    'tour-chime':      { cls:4, clsAi:4, cap:1, band:[2000,4000], cent:2100, dur:0.55, kind:'one' },
    'sound-on':        { cls:4, clsAi:4, cap:1, band:[2000,4000], cent:3400, dur:0.30, kind:'one' },
    'chew':            { cls:3, clsAi:3, cap:2, band:[150,600],   cent:330,  dur:0,    kind:'loop', loopCap:2 },
    'swarm':           { cls:3, clsAi:3, cap:1, band:[800,2500],  cent:1600, dur:0,    kind:'loop', loopCap:1 },
    'drone-hum':       { cls:3, clsAi:3, cap:2, band:[900,1400],  cent:1080, dur:0,    kind:'loop', loopCap:2 }
  };

  var VOICE_NAMES = Object.keys(VOICES);

  /* Reduced motion resolves a wave instantly, so per-event wave sounds would
     be forty voices in one frame. These are the ones that still play. */
  var REDUCED_KEEP = {
    'build-wall':1, 'build-gun':1, 'undo':1, 'illegal':1, 'focus-mark':1,
    'ui-tick':1, 'tour-chime':1, 'sound-on':1,
    'wave-start':1, 'wave-held':1, 'keep-fell':1
  };
  var WAVE_VOICES = {};
  for (var vi = 0; vi < VOICE_NAMES.length; vi++) {
    if (!REDUCED_KEEP[VOICE_NAMES[vi]]) WAVE_VOICES[VOICE_NAMES[vi]] = 1;
  }

  /* --------------------------------------------- the ending law (A-S6)

     Spec v3 s7.19 ruling 9. P0 holds two things that are not the same kind of
     statement. `keep-hit` says the keep is being HURT, and it is the sound a
     losing visitor hears over and over. `keep-fell`, `wave-held` and
     `wave-start` say how it ENDED, and each of them is the one sentence its
     moment has to say.

     Before this law the class had no order inside itself. A keep falls by
     being hit twice in the second before it falls, `keep-hit` is accounted a
     1.20 s occupancy, and `CLASS_BUDGET[0]` is 2, so the fall arrived at a
     full class and was refused: the ship gate round 2 audit measured the keep
     falling AUDIBLY once in three real falls and a wave being held 18 times in
     27, every loss on that budget.

     THE LAW. When an ENDING voice would be refused for want of budget (its
     class budget or the global node budget) and a live P0 voice in EVICTABLE
     is holding a slot, the OLDEST such voice is evicted: it leaves the live
     ledger, the graph fades it out over EVICT_FADE_MS, and the ending plays.
     Only as many are evicted as the refusal needs, never more. An ending never
     evicts another ending, and nothing but an ending evicts anything. If no
     evictable voice is live the ending is still honestly refused, so the
     budget is a real budget and not a suggestion.

     Cap and cooldown are NOT eviction grounds. A second `wave-held` inside 400
     ms is a duplicate of the same sentence, and repeating it is not the point.

     THE ORDERING THE PAGE MUST USE. Endings go FIRST in a tick's event list,
     before the `keep-hit` that caused them, so the hit is the one refused on
     its own cap rather than the ending having to cut a ringing bell short.
     `plan` sorts events at the SAME timestamp that way itself, so the law
     holds whatever order arrives, but the page hands them over in that order
     too (INTERFACES A-S6). */
  var ENDING_VOICES = { 'keep-fell': 1, 'wave-held': 1, 'wave-start': 1 };
  var EVICTABLE     = { 'keep-hit': 1 };
  var EVICT_FADE_MS = 90;

  /* Mixer law constants. */
  var COOLDOWN_MS   = 60;
  var COALESCE_MS   = 30;
  var COALESCE_DB   = 2;
  var COALESCE_MAX  = 4;
  var WINDOW_MS     = 400;
  var DUCK_MAX_DB   = 12;
  var PAN_MAX       = 0.35;
  var EDGE_DB       = -6;
  var NODE_BUDGET   = 24;
  var CLASS_BUDGET  = [2, 4, 4, 6, 2];

  /* Static bus trim in dB, on top of which the ducking automation is written.
     The mixer law these numbers serve is A2: the important sound comes
     through. P3 is texture and sits well under everything, which is what makes
     a wall falling audible over two chew loops, a swarm and six machines. */
  var CLASS_TRIM_DB = [4, 4, -8, -15, -2];
  var MASTER_GAIN   = 5.2;
  var masterGain    = MASTER_GAIN;

  var DUCK_P0 = { db: 9, attackMs: 20, holdMs: 0,   releaseMs: 500 };
  var DUCK_P1 = { db: 5, attackMs: 20, holdMs: 120, releaseMs: 160 };

  function classOf(name, owner, ride) {
    if (ride && VOICES[ride]) return classOf(ride, owner);
    var v = VOICES[name];
    if (!v) return -1;
    return (owner === 1 && v.clsAi != null) ? v.clsAi : v.cls;
  }

  /* Only the four voices the table splits by owner carry the owner timbre.
     Everything else sounds the same whoever it belongs to, which is what the
     table says (one class, no owner column) and, just as important, is what the
     A3 separation measurement renders. A voice whose pitch moved with an owner
     the table does not split would sit 19 percent away from where it was
     measured, and could land on top of a neighbour in its class. */
  function ownerSplit(name) {
    var v = VOICES[name];
    return !!(v && v.clsAi != null && v.clsAi !== v.cls);
  }

  function normOwner(o) {
    if (o === 0 || o === 1) return o;
    if (o === 'you' || o === 'visitor') return 0;
    if (o === 'ai' || o === 'partner') return 1;
    return null;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* Stereo pan from board x. Flat level on desktop; on the phone follow
     camera the level falls to -6 dB at the frame edge. */
  function panFor(x, view) {
    if (x == null || !view) return 0;
    var w = (view && view.boardW) || 0;
    if (!(w > 1)) return 0;
    var f;
    if (view.follow && view.camX1 > view.camX0) {
      f = (x - view.camX0) / (view.camX1 - view.camX0);
    } else {
      f = x / (w - 1);
    }
    return clamp((f - 0.5) * 2, -1, 1) * PAN_MAX;
  }

  function levelDbFor(x, view) {
    if (x == null || !view || !view.follow) return 0;
    if (!(view.camX1 > view.camX0)) return 0;
    var f = (x - view.camX0) / (view.camX1 - view.camX0);
    var d = Math.abs(clamp(f, -1, 2) - 0.5) * 2;   /* 0 centre, 1 at the edge */
    return EDGE_DB * clamp(d, 0, 1.6);
  }

  /* Sum of every duck active on class `cls` at time tMs, clamped to 12 dB. */
  function duckDbAt(ducks, cls, tMs) {
    var total = 0;
    for (var i = 0; i < ducks.length; i++) {
      var d = ducks[i];
      if (d.targets.indexOf(cls) < 0) continue;
      var dt = tMs - d.t;
      if (dt < 0) continue;
      var a = d.attackMs, h = d.holdMs, r = d.releaseMs;
      var amt;
      if (dt < a) amt = d.db * (dt / a);
      else if (dt < a + h) amt = d.db;
      else if (dt < a + h + r) amt = d.db * (1 - (dt - a - h) / r);
      else continue;
      total += amt;
    }
    return Math.min(total, DUCK_MAX_DB);
  }

  /* Which loops of one kind live, when more candidates than slots exist.
     Chew picks the planted walkers nearest the keep, or nearest the camera
     centre when the phone follow camera is on. Lower rank wins. */
  function loopRank(kind, cand, view) {
    if (kind === 'chew') {
      if (view && view.follow && view.camX1 > view.camX0) {
        var mid = (view.camX0 + view.camX1) / 2;
        return Math.abs((cand.x == null ? mid : cand.x) - mid);
      }
      return cand.distKeep == null ? 1e9 : cand.distKeep;
    }
    if (kind === 'drone-hum') {
      return -(cand.speed == null ? 0 : cand.speed);
    }
    return cand.rank == null ? 0 : cand.rank;
  }

  function chooseLoops(kind, candidates, view, limit) {
    var lim = limit == null ? (VOICES[kind] ? VOICES[kind].loopCap : 1) : limit;
    var arr = candidates.slice();
    for (var i = 0; i < arr.length; i++) arr[i]._r = loopRank(kind, arr[i], view);
    arr.sort(function (a, b) {
      if (a._r !== b._r) return a._r - b._r;
      return String(a.id) < String(b.id) ? -1 : 1;
    });
    var out = [];
    for (var j = 0; j < arr.length && j < lim; j++) out.push(arr[j].id);
    return out;
  }

  function newState(opts) {
    opts = opts || {};
    return {
      muted:   !!opts.muted,
      reduced: !!opts.reduced,
      view:    opts.view || null,
      /* recent starts, key "voice|cls" -> array of ms, trimmed to the window */
      recent:  opts.recent || {},
      /* planned intervals for the concurrency budget: [{t0, t1, cls}] */
      live:    opts.live || [],
      /* active loops: id -> {kind, id, params} */
      loops:   opts.loops || {},
      ducks:   opts.ducks || [],
      seq:     opts.seq || 0
    };
  }

  function cloneState(s) {
    var r = {}, k;
    for (k in s.recent) if (s.recent.hasOwnProperty(k)) r[k] = s.recent[k].slice();
    var lp = {};
    for (k in s.loops) if (s.loops.hasOwnProperty(k)) lp[k] = s.loops[k];
    return {
      muted: s.muted, reduced: s.reduced, view: s.view,
      recent: r, live: s.live.slice(), loops: lp,
      ducks: s.ducks.slice(), seq: s.seq
    };
  }

  function trim(s, tMs) {
    var k, a, out;
    for (k in s.recent) {
      if (!s.recent.hasOwnProperty(k)) continue;
      a = s.recent[k]; out = [];
      for (var i = 0; i < a.length; i++) if (tMs - a[i] < WINDOW_MS) out.push(a[i]);
      if (out.length) s.recent[k] = out; else delete s.recent[k];
    }
    out = [];
    for (var j = 0; j < s.live.length; j++) if (s.live[j].t1 > tMs) out.push(s.live[j]);
    s.live = out;
    out = [];
    for (var m = 0; m < s.ducks.length; m++) {
      var d = s.ducks[m];
      if (tMs - d.t < d.attackMs + d.holdMs + d.releaseMs + 50) out.push(d);
    }
    s.ducks = out;
  }

  function concurrent(s, tMs, cls) {
    var n = 0;
    for (var i = 0; i < s.live.length; i++) {
      var L = s.live[i];
      if (L.t0 <= tMs && L.t1 > tMs && (cls == null || L.cls === cls)) n++;
    }
    return n;
  }

  function isEnding(name) { return !!ENDING_VOICES[name]; }

  /* Ordering rank inside one timestamp: an ending play event comes first, so
     the hit that caused it is the one refused on its own cap rather than the
     ending having to cut a ringing bell short. Everything else keeps the order
     it arrived in (Array.prototype.sort is stable). */
  function tickRank(e) {
    return ((e.op || 'play') === 'play' && ENDING_VOICES[e.v]) ? 0 : 1;
  }

  /* Which live P0 voices this ending must evict to fit, oldest first, and
     never more than the refusal needs. null means the law does not apply here
     (not an ending, not P0, nothing evictable live) or cannot make room even
     after evicting everything it is allowed to, in which case the caller
     refuses the ending honestly. */
  function evictFor(s, tMs, name, cls) {
    if (cls !== 0 || !ENDING_VOICES[name]) return null;
    var cand = [], i;
    for (i = 0; i < s.live.length; i++) {
      var L = s.live[i];
      if (L.cls === cls && L.t0 <= tMs && L.t1 > tMs && EVICTABLE[L.v]) cand.push(L);
    }
    if (!cand.length) return null;
    cand.sort(function (a, b) {
      if (a.t0 !== b.t0) return a.t0 - b.t0;
      return (a.seq || 0) - (b.seq || 0);
    });
    var nCls = concurrent(s, tMs, cls), nAll = concurrent(s, tMs, null), freed = [];
    for (i = 0; i < cand.length; i++) {
      if (nCls < CLASS_BUDGET[cls] && nAll < NODE_BUDGET) break;
      freed.push(cand[i]); nCls--; nAll--;
    }
    if (!freed.length) return null;
    if (nCls >= CLASS_BUDGET[cls] || nAll >= NODE_BUDGET) return null;
    return freed;
  }

  /* Two loop parameter sets that mean the same running loop. `t` is the page
     clock the call was made at and never changes what is heard, so it is not
     part of the comparison. */
  function sameLoopParams(a, b) {
    a = a || {}; b = b || {};
    var k;
    for (k in a) {
      if (!a.hasOwnProperty(k) || k === 't') continue;
      if (b[k] !== a[k]) return false;
    }
    for (k in b) {
      if (!b.hasOwnProperty(k) || k === 't') continue;
      if (a[k] !== b[k]) return false;
    }
    return true;
  }

  /* The scheduler. Pure: state is never mutated, the next state comes back. */
  function plan(events, state) {
    var s = cloneState(state || newState({}));
    var play = [], drop = [], ducks = [], skip = [];
    var evs = (events || []).slice().sort(function (a, b) {
      var d = (a.t || 0) - (b.t || 0);
      if (d) return d;
      return tickRank(a) - tickRank(b);
    });

    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      var t = e.t || 0;
      var op = e.op || 'play';
      trim(s, t);

      if (op === 'stopLoop') {
        if (s.loops[e.id]) { delete s.loops[e.id]; play.push({ t: t, op: 'stopLoop', id: e.id }); }
        continue;
      }
      if (op === 'setLoopParam') {
        if (s.loops[e.id]) {
          s.loops[e.id] = { kind: s.loops[e.id].kind, id: e.id, params: e.params || {} };
          play.push({ t: t, op: 'setLoopParam', id: e.id, params: e.params || {} });
        }
        continue;
      }

      var name = e.v;
      var V = VOICES[name];
      if (!V) { drop.push({ t: t, v: name, cls: -1, reason: 'unknown-voice' }); continue; }
      var owner = normOwner(e.owner);
      var cls = classOf(name, owner, e.ride);

      if (s.muted) { drop.push({ t: t, v: name, cls: cls, reason: 'muted' }); continue; }
      if (s.reduced && WAVE_VOICES[name]) {
        drop.push({ t: t, v: name, cls: cls, reason: 'reduced' }); continue;
      }

      if (op === 'loop') {
        if (V.kind !== 'loop') { drop.push({ t: t, v: name, cls: cls, reason: 'unknown-voice' }); continue; }
        var params = e.params || {};
        if (s.loops[e.id]) {
          /* A re-issue that changes nothing is not work. The page syncs its
             texture loops every tick, and the ship gate round 2 audit measured
             660 of 796 loop calls in 195 s repeating the previous parameters
             exactly. Skipped, not dropped: the loop is live and correct, so
             nothing was lost and the drop counters must not say it was. */
          if (sameLoopParams(s.loops[e.id].params, params)) {
            skip.push({ t: t, op: 'loop', v: name, id: e.id, reason: 'no-change' });
            continue;
          }
          s.loops[e.id] = { kind: name, id: e.id, params: params };
          play.push({ t: t, op: 'setLoopParam', id: e.id, v: name, params: params });
          continue;
        }
        var cands = [], key;
        for (key in s.loops) {
          if (s.loops.hasOwnProperty(key) && s.loops[key].kind === name) {
            cands.push({ id: key, x: s.loops[key].params.x,
                         distKeep: s.loops[key].params.distKeep,
                         speed: s.loops[key].params.speed });
          }
        }
        cands.push({ id: e.id, x: params.x, distKeep: params.distKeep, speed: params.speed });
        var keepIds = chooseLoops(name, cands, s.view, V.loopCap);
        if (keepIds.indexOf(e.id) < 0) {
          drop.push({ t: t, v: name, cls: cls, reason: 'loop-cap' });
          continue;
        }
        for (var ci = 0; ci < cands.length; ci++) {
          var cid = cands[ci].id;
          if (cid !== e.id && keepIds.indexOf(cid) < 0 && s.loops[cid]) {
            delete s.loops[cid];
            play.push({ t: t, op: 'stopLoop', id: cid, reason: 'loop-cap' });
          }
        }
        s.loops[e.id] = { kind: name, id: e.id, params: params };
        play.push({ t: t, op: 'loop', v: name, id: e.id, cls: cls, params: params,
                    pan: panFor(params.x, s.view), levelDb: levelDbFor(params.x, s.view) });
        continue;
      }

      /* one shot */
      var ck = name + '|' + cls;
      var rec = s.recent[ck] || [];
      var last = rec.length ? rec[rec.length - 1] : -1e9;
      var dt = t - last;

      if (dt < COALESCE_MS) {
        var target = null;
        for (var p = play.length - 1; p >= 0; p--) {
          if (play[p].v === name && play[p].cls === cls && play[p].op === 'play') { target = play[p]; break; }
        }
        if (target) {
          target.coalesced = (target.coalesced || 0) + 1;
          target.gainDb = Math.min((target.gainDb || 0) + COALESCE_DB,
                                   (target.baseDb || 0) + COALESCE_MAX);
          drop.push({ t: t, v: name, cls: cls, reason: 'coalesce' });
          continue;
        }
      }
      if (dt < COOLDOWN_MS) { drop.push({ t: t, v: name, cls: cls, reason: 'cooldown' }); continue; }
      if (rec.length >= V.cap) { drop.push({ t: t, v: name, cls: cls, reason: 'cap' }); continue; }
      if (concurrent(s, t, cls) >= CLASS_BUDGET[cls] ||
          concurrent(s, t, null) >= NODE_BUDGET) {
        /* The ending law. Only an ending may take a slot that is already
           held, only from a keep-hit, oldest first, and only as many as it
           needs. Anything else is refused as it always was. */
        var freed = evictFor(s, t, name, cls);
        if (!freed) { drop.push({ t: t, v: name, cls: cls, reason: 'budget' }); continue; }
        var keepLive = [];
        for (var li = 0; li < s.live.length; li++) {
          if (freed.indexOf(s.live[li]) < 0) keepLive.push(s.live[li]);
        }
        s.live = keepLive;
        for (var fi = 0; fi < freed.length; fi++) {
          play.push({ t: t, op: 'stopVoice', seq: freed[fi].seq, v: freed[fi].v,
                      cls: freed[fi].cls, reason: 'evicted', by: name });
        }
      }

      var baseDb = e.gainDb == null ? 0 : clamp(e.gainDb, -12, 6);
      var entry = {
        t: t, op: 'play', v: name, owner: owner, cls: cls, ride: e.ride || null,
        x: (e.x == null ? null : e.x), y: (e.y == null ? null : e.y),
        pan: panFor(e.x, s.view), levelDb: levelDbFor(e.x, s.view),
        baseDb: baseDb, gainDb: baseDb, coalesced: 0,
        params: e.params || null, seq: s.seq++
      };
      play.push(entry);
      rec.push(t); s.recent[ck] = rec;
      /* `v` and `seq` are what makes a live entry EVICTABLE by name and
         stoppable by the graph. Never drop them from this record. */
      s.live.push({ t0: t, t1: t + V.dur * 1000, cls: cls, v: name, seq: entry.seq });

      if (cls === 0) {
        var d0 = { t: t, cls: 0, targets: [1, 2, 3, 4], db: DUCK_P0.db,
                   attackMs: DUCK_P0.attackMs, holdMs: DUCK_P0.holdMs, releaseMs: DUCK_P0.releaseMs };
        ducks.push(d0); s.ducks.push(d0);
      } else if (cls === 1) {
        var d1 = { t: t, cls: 1, targets: [2, 3, 4], db: DUCK_P1.db,
                   attackMs: DUCK_P1.attackMs, holdMs: DUCK_P1.holdMs, releaseMs: DUCK_P1.releaseMs };
        ducks.push(d1); s.ducks.push(d1);
      }
    }

    return { play: play, drop: drop, ducks: ducks, skip: skip, state: s };
  }

  var PURE = {
    VOICES: VOICES,
    VOICE_NAMES: VOICE_NAMES,
    WAVE_VOICES: WAVE_VOICES,
    REDUCED_KEEP: REDUCED_KEEP,
    CLASS_BUDGET: CLASS_BUDGET,
    CLASS_TRIM_DB: CLASS_TRIM_DB,
    NODE_BUDGET: NODE_BUDGET,
    ENDING_VOICES: ENDING_VOICES,
    EVICTABLE: EVICTABLE,
    EVICT_FADE_MS: EVICT_FADE_MS,
    COOLDOWN_MS: COOLDOWN_MS,
    COALESCE_MS: COALESCE_MS,
    COALESCE_DB: COALESCE_DB,
    COALESCE_MAX: COALESCE_MAX,
    WINDOW_MS: WINDOW_MS,
    DUCK_MAX_DB: DUCK_MAX_DB,
    DUCK_P0: DUCK_P0,
    DUCK_P1: DUCK_P1,
    PAN_MAX: PAN_MAX,
    classOf: classOf,
    isEnding: isEnding,
    evictFor: evictFor,
    sameLoopParams: sameLoopParams,
    ownerSplit: ownerSplit,
    normOwner: normOwner,
    panFor: panFor,
    levelDbFor: levelDbFor,
    duckDbAt: duckDbAt,
    chooseLoops: chooseLoops,
    loopRank: loopRank,
    newState: newState,
    plan: plan
  };

  /* ============================================================== GRAPH */

  var M = {
    ctx: null,
    PURE: PURE,
    VOICES: VOICES
  };

  var cfg = null;
  var planState = null;
  var nodes = null;          /* {busses, solos, master, limiter, safety} */
  var loops = {};            /* id -> live loop record */
  var liveVoices = {};       /* plan seq -> {lvl, panner, end} for one shots,
                                so the ending law can actually stop one */
  var anchorPage = 0, anchorCtx = 0;
  var stats = null;
  var muted = false;
  var view = { boardW: 28, camX0: 0, camX1: 27, follow: false };
  var solo = null;
  var bufCache = null;       /* per context caches, keyed by a tag on the ctx */
  var voiceSeed = 0;
  var visBound = false;

  function defaults() {
    return {
      ctxFactory: function () {
        var C = (typeof window !== 'undefined') &&
                (window.AudioContext || window.webkitAudioContext);
        return C ? new C() : null;
      },
      now: function () {
        return (typeof performance !== 'undefined' && performance.now)
          ? performance.now() : Date.now();
      },
      storage: (typeof window !== 'undefined' && window.localStorage) ? window.localStorage : null,
      storageKey: 'kit-sound',
      reduced: function () {
        return (typeof window !== 'undefined' && window.matchMedia)
          ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;
      },
      offline: false,
      lookahead: LOOKAHEAD_DEFAULT,
      onWarn: null
    };
  }

  function warn(code, detail) {
    if (cfg && typeof cfg.onWarn === 'function') {
      try { cfg.onWarn(code, detail); } catch (err) { /* the page must never die on a sound */ }
    }
  }

  function resetStats() {
    stats = {
      started: 0, dropped: 0, coalesced: 0, evicted: 0, loopSkipped: 0,
      byClass: [0, 0, 0, 0, 0],
      byVoice: {},
      dropByReason: {},
      live: 0, peakLive: 0,
      log: []
    };
  }

  M.resetStats = resetStats;
  M.stats = function () { return stats; };

  /* init() is a full reset, so the audit can render one fixture after another
     through the same module with a fresh OfflineAudioContext each time. The
     page calls it exactly once, at boot. */
  M.init = function (opts) {
    M.ctx = null;
    nodes = null;
    loops = {};
    liveVoices = {};
    duckLog = [];
    bufCache = null;
    solo = null;
    anchorPage = 0; anchorCtx = 0;
    cfg = defaults();
    opts = opts || {};
    for (var k in opts) if (opts.hasOwnProperty(k) && opts[k] !== undefined) cfg[k] = opts[k];
    resetStats();
    masterGain = MASTER_GAIN;
    muted = false;
    if (cfg.storage && !cfg.offline) {
      try {
        var v = cfg.storage.getItem(cfg.storageKey);
        if (v === 'off') muted = true;
      } catch (err) { /* private mode throws on read */ }
    }
    planState = PURE.newState({ muted: muted, reduced: readReduced(), view: view });
    return M;
  };

  function readReduced() {
    if (!cfg) return false;
    try { return !!cfg.reduced(); } catch (err) { return false; }
  }

  M.armed = function () { return !!M.ctx; };

  M.arm = function () {
    if (M.ctx) {
      if (!cfg.offline && M.ctx.state === 'suspended' && M.ctx.resume) {
        try { M.ctx.resume(); } catch (err) { /* a suspended context is not fatal */ }
      }
      return M.ctx;
    }
    if (!cfg) M.init({});
    var ctx = null;
    try { ctx = cfg.ctxFactory(); } catch (err) { warn('ctx-failed', String(err)); return null; }
    if (!ctx) { warn('ctx-missing', ''); return null; }
    M.ctx = ctx;
    buildGraph(ctx);
    anchorCtx = ctx.currentTime;
    anchorPage = cfg.now();
    if (!cfg.offline) bindVisibility(ctx);
    applyMuteGain(0);
    return ctx;
  };

  function bindVisibility(ctx) {
    if (visBound || typeof document === 'undefined') return;
    visBound = true;
    document.addEventListener('visibilitychange', function () {
      if (!M.ctx) return;
      try {
        if (document.hidden) { if (M.ctx.suspend) M.ctx.suspend(); }
        else if (M.ctx.resume) M.ctx.resume();
      } catch (err) { /* browsers differ on suspend during a render */ }
    });
  }

  function buildGraph(ctx) {
    var limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 2;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;

    var safety = ctx.createWaveShaper();
    safety.curve = softClipCurve();
    safety.oversample = '4x';

    var master = ctx.createGain();
    master.gain.value = masterGain;

    master.connect(limiter);
    limiter.connect(safety);
    safety.connect(ctx.destination);

    var busses = [], solos = [];
    for (var c = 0; c < NCLASS; c++) {
      var bus = ctx.createGain(); bus.gain.value = trimGain(c);
      var sg = ctx.createGain();  sg.gain.value = 1;
      bus.connect(sg); sg.connect(master);
      busses.push(bus); solos.push(sg);
    }
    nodes = { busses: busses, solos: solos, master: master, limiter: limiter, safety: safety, muteAt: 1 };
  }

  function trimGain(cls) { return Math.pow(10, CLASS_TRIM_DB[cls] / 20); }

  /* Linear to 0.60, then a soft knee with a 0.82 asymptote, so the sample peak
     can never exceed -1.7 dBFS and the inter sample peak stays inside -1 dBFS. */
  function softClipCurve() {
    var n = 2049, c = new Float32Array(n), lin = 0.60, top = 0.82;
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1;
      var a = Math.abs(x), y;
      if (a <= lin) y = a;
      else y = lin + (top - lin) * (1 - Math.exp(-(a - lin) / (top - lin)));
      c[i] = (x < 0 ? -y : y);
    }
    return c;
  }

  /* ------------------------------------------------- deterministic noise */

  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5;  s >>>= 0;
      return (s / 4294967296) * 2 - 1;
    };
  }

  function bufs(ctx) {
    if (bufCache && bufCache.ctx === ctx) return bufCache;
    var sr = ctx.sampleRate, n = Math.floor(sr * 2);
    var white = ctx.createBuffer(1, n, sr);
    var wd = white.getChannelData(0);
    var r = rng(0x9E3779B9);
    for (var i = 0; i < n; i++) wd[i] = r();

    var pink = ctx.createBuffer(1, n, sr);
    var pd = pink.getChannelData(0);
    var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    var r2 = rng(0x1234567);
    for (var j = 0; j < n; j++) {
      var w = r2();
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      pd[j] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }

    /* Skitter: band limited grains, the swarm's own texture, rendered once. */
    var skit = ctx.createBuffer(1, n, sr);
    var sd = skit.getChannelData(0);
    var r3 = rng(0x5EED01);
    var g = 0, gl = 0, amp = 0;
    for (var k = 0; k < n; k++) {
      if (gl <= 0) { gl = Math.floor(sr * (0.004 + 0.010 * Math.abs(r3()))); amp = 0.25 + 0.75 * Math.abs(r3()); g = 0; }
      var env = Math.exp(-g / (sr * 0.004));
      sd[k] = r3() * env * amp;
      g++; gl--;
    }
    bufCache = { ctx: ctx, white: white, pink: pink, skit: skit };
    return bufCache;
  }

  /* --------------------------------------------------------- voice rigs */

  function Rig(ctx, dest, t, o) {
    this.ctx = ctx; this.dest = dest; this.t = t; this.o = o || {};
    this.q = []; this.end = t;
    this.seed = (voiceSeed = (voiceSeed + 1) % 997);
  }
  Rig.prototype.gain = function (v) { var g = this.ctx.createGain(); g.gain.value = v; return g; };
  Rig.prototype.osc = function (type, f) {
    var s = this.ctx.createOscillator(); s.type = type; s.frequency.value = f; return s;
  };
  Rig.prototype.noise = function (kind, rate) {
    var s = this.ctx.createBufferSource();
    s.buffer = bufs(this.ctx)[kind || 'white'];
    s.loop = true;
    s.playbackRate.value = rate || 1;
    return s;
  };
  Rig.prototype.filt = function (type, f, q) {
    var b = this.ctx.createBiquadFilter(); b.type = type; b.frequency.value = f;
    if (q != null) b.Q.value = q;
    return b;
  };
  Rig.prototype.run = function (src, t0, t1) {
    this.q.push([src, t0, t1]);
    if (t1 > this.end) this.end = t1;
    return src;
  };
  /* Deterministic per instance offset into the 2 s noise buffers. */
  Rig.prototype.off = function () { return ((this.seed * 0.6180339887) % 1) * 1.8; };
  Rig.prototype.go = function () {
    for (var i = 0; i < this.q.length; i++) {
      var e = this.q[i];
      try {
        if (e[0].buffer !== undefined && e[0].buffer) e[0].start(e[1], this.off());
        else e[0].start(e[1]);
        e[0].stop(e[2]);
      } catch (err) { /* a source started twice must not kill the frame */ }
    }
    return this.end;
  };

  function envAD(p, t, peak, atk, dur, floorV) {
    var f = floorV || 0.00008;
    var a = Math.max(atk, 0.0008), d = Math.max(dur, a + 0.01);
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(Math.max(peak, f * 2), t + a);
    p.exponentialRampToValueAtTime(f, t + d);
    p.setValueAtTime(0, t + d + 0.002);
  }

  function pitchMul(owner) {
    /* the visitor's machines sit +3 semitones above the AI's */
    if (owner === 0) return 1.1892;
    return 1;
  }
  function briteMul(owner) {
    if (owner === 0) return 1.30;   /* brighter */
    if (owner === 1) return 0.82;   /* rounder */
    return 1;
  }

  /* Each synth takes (rig, t, owner) and wires itself to rig.dest.
     Peak gains are held equal across the two owner timbres, so the owner is
     audible in colour and never in level (the 2 dB law). */
  var SYNTH = {};

  SYNTH['windup'] = function (R, t, ow) {
    var pm = pitchMul(ow), bm = briteMul(ow);
    var o = R.osc('triangle', 340 * pm);
    o.frequency.setValueAtTime(330 * pm, t);
    o.frequency.exponentialRampToValueAtTime(1180 * pm, t + 0.30);
    /* The band must TRACK the tone, not the owner. Scaling this filter by the
       owner brightness as well as the pitch detuned the AI wind-up off its own
       sweep and cost it 5.8 dB, which broke the law that the two owners differ
       in colour and not in level. The brightness lives in the ratchet below. */
    var bp = R.filt('bandpass', 700 * pm, 2.0);
    bp.frequency.setValueAtTime(600 * pm, t);
    bp.frequency.exponentialRampToValueAtTime(1700 * pm, t + 0.30);
    var g = R.gain(0);
    envAD(g.gain, t, 0.27, 0.10, 0.34);
    o.connect(bp); bp.connect(g); g.connect(R.dest);
    R.run(o, t, t + 0.36);

    /* faint ratchet: eight short clicks that accelerate */
    var rg = R.gain(0);
    var rb = R.filt('bandpass', 1400 * bm, 6);
    var rl = R.filt('lowpass', 2400 * bm, 0.8);
    var nz = R.noise('white', 1);
    nz.connect(rb); rb.connect(rl); rl.connect(rg); rg.connect(R.dest);
    var tt = t;
    for (var i = 0; i < 8; i++) {
      var step = 0.055 - i * 0.005;
      rg.gain.setValueAtTime(0.0001, tt);
      rg.gain.linearRampToValueAtTime(0.05, tt + 0.003);
      rg.gain.exponentialRampToValueAtTime(0.0001, tt + 0.020);
      tt += step;
    }
    R.run(nz, t, t + 0.36);
  };

  SYNTH['release'] = function (R, t, ow) {
    var pm = pitchMul(ow), bm = briteMul(ow);
    /* thump */
    var o = R.osc('sine', 190 * pm);
    o.frequency.setValueAtTime(210 * pm, t);
    o.frequency.exponentialRampToValueAtTime(105 * pm, t + 0.13);
    var g = R.gain(0);
    envAD(g.gain, t, 0.11, 0.005, 0.20);
    o.connect(g); g.connect(R.dest);
    R.run(o, t, t + 0.24);
    /* whip: the sound of the sling, and the band this voice lives in */
    var nz = R.noise('white', 1);
    var bp = R.filt('bandpass', 2600 * bm, 1.1);
    bp.frequency.setValueAtTime(2600 * bm, t);
    bp.frequency.exponentialRampToValueAtTime(7200 * bm, t + 0.10);
    var bp2 = R.filt('bandpass', 2600 * bm, 1.1);
    bp2.frequency.setValueAtTime(2600 * bm, t);
    bp2.frequency.exponentialRampToValueAtTime(7200 * bm, t + 0.10);
    var hp = R.filt('highpass', 1500 * bm, 0.7);
    var g2 = R.gain(0);
    envAD(g2.gain, t + 0.004, 0.52, 0.010, 0.21);
    nz.connect(bp); bp.connect(bp2); bp2.connect(hp); hp.connect(g2); g2.connect(R.dest);
    R.run(nz, t, t + 0.26);
  };

  SYNTH['impact-ground'] = function (R, t) {
    var o = R.osc('sine', 120);
    o.frequency.setValueAtTime(126, t);
    o.frequency.exponentialRampToValueAtTime(52, t + 0.11);
    var g = R.gain(0);
    envAD(g.gain, t, 0.30, 0.014, 0.20);
    o.connect(g); g.connect(R.dest);
    R.run(o, t, t + 0.24);
    /* gravel, twice filtered, so the thud keeps the voice low and dry */
    var nz = R.noise('pink', 1);
    var lp = R.filt('lowpass', 200, 0.8);
    var lp2 = R.filt('lowpass', 200, 0.8);
    var g2 = R.gain(0);
    envAD(g2.gain, t, 0.055, 0.010, 0.16);
    nz.connect(lp); lp.connect(lp2); lp2.connect(g2); g2.connect(R.dest);
    R.run(nz, t, t + 0.20);
  };

  SYNTH['impact-creature'] = function (R, t, ow) {
    var pm = pitchMul(ow), bm = briteMul(ow);
    /* crunch */
    var nz = R.noise('white', 1);
    var bp = R.filt('bandpass', 520 * pm, 1.1);
    bp.frequency.setValueAtTime(900 * pm, t);
    bp.frequency.exponentialRampToValueAtTime(400 * pm, t + 0.12);
    var g = R.gain(0);
    envAD(g.gain, t, 0.46, 0.004, 0.21);
    nz.connect(bp); bp.connect(g); g.connect(R.dest);
    R.run(nz, t, t + 0.24);
    /* squashed body */
    var o = R.osc('triangle', 230 * pm);
    o.frequency.setValueAtTime(250 * pm, t);
    o.frequency.exponentialRampToValueAtTime(130 * pm, t + 0.10);
    var g3 = R.gain(0);
    envAD(g3.gain, t, 0.12, 0.005, 0.17);
    o.connect(g3); g3.connect(R.dest);
    R.run(o, t, t + 0.20);
    /* chitter */
    var nz2 = R.noise('white', 1);
    var bp2 = R.filt('bandpass', 1900 * bm, 5);
    var lp2 = R.filt('lowpass', 3200 * bm, 0.8);
    var g2 = R.gain(0);
    nz2.connect(bp2); bp2.connect(lp2); lp2.connect(g2); g2.connect(R.dest);
    var tt = t + 0.02;
    for (var i = 0; i < 3; i++) {
      g2.gain.setValueAtTime(0.0001, tt);
      g2.gain.linearRampToValueAtTime(0.135, tt + 0.003);
      g2.gain.exponentialRampToValueAtTime(0.0001, tt + 0.022);
      tt += 0.045;
    }
    R.run(nz2, t, t + 0.22);
  };

  SYNTH['discharge'] = function (R, t, ow) {
    var bm = briteMul(ow);
    var nz = R.noise('white', 1);
    var hp = R.filt('highpass', 2800 * bm, 0.8);
    var bp = R.filt('bandpass', 4600 * bm, 1.1);
    var g = R.gain(0);
    nz.connect(hp); hp.connect(bp); bp.connect(g); g.connect(R.dest);
    var tt = t;
    for (var i = 0; i < 7; i++) {
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.linearRampToValueAtTime(0.42 * (1 - i * 0.10), tt + 0.0015);
      g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.012);
      tt += 0.012;
    }
    R.run(nz, t, t + 0.11);
  };

  SYNTH['creature-hurt'] = function (R, t) {
    var nz = R.noise('white', 1);
    var bp = R.filt('bandpass', 1700, 1.6);
    bp.frequency.setValueAtTime(1900, t);
    bp.frequency.exponentialRampToValueAtTime(1300, t + 0.12);
    var lp = R.filt('lowpass', 2600, 0.8);
    var g = R.gain(0);
    envAD(g.gain, t, 0.18, 0.004, 0.13);
    nz.connect(bp); bp.connect(lp); lp.connect(g); g.connect(R.dest);
    R.run(nz, t, t + 0.15);
  };

  SYNTH['creature-die'] = function (R, t, ow) {
    var pm = pitchMul(ow);
    var o = R.osc('sawtooth', 1300 * pm);
    o.frequency.setValueAtTime(1350 * pm, t);
    o.frequency.exponentialRampToValueAtTime(620 * pm, t + 0.26);
    var bp = R.filt('bandpass', 1150 * pm, 3.2);
    var g = R.gain(0);
    envAD(g.gain, t, 0.26, 0.006, 0.28);
    o.connect(bp); bp.connect(g); g.connect(R.dest);
    R.run(o, t, t + 0.32);
    /* the body dropping */
    var o2 = R.osc('sine', 210);
    o2.frequency.setValueAtTime(215, t + 0.05);
    o2.frequency.exponentialRampToValueAtTime(72, t + 0.34);
    var g2 = R.gain(0);
    envAD(g2.gain, t + 0.05, 0.085, 0.010, 0.30);
    o2.connect(g2); g2.connect(R.dest);
    R.run(o2, t + 0.05, t + 0.44);
  };

  SYNTH['wall-hit'] = function (R, t) {
    var nz = R.noise('white', 1);
    var bp = R.filt('bandpass', 3250, 5.5);
    var g = R.gain(0);
    envAD(g.gain, t, 0.20, 0.0015, 0.055);
    nz.connect(bp); bp.connect(g); g.connect(R.dest);
    R.run(nz, t, t + 0.08);
    var o = R.osc('triangle', 3500);
    var g2 = R.gain(0);
    envAD(g2.gain, t, 0.09, 0.0015, 0.030);
    o.connect(g2); g2.connect(R.dest);
    R.run(o, t, t + 0.05);
  };

  SYNTH['wall-break'] = function (R, t) {
    /* rumble */
    var o = R.osc('sine', 70);
    o.frequency.setValueAtTime(78, t);
    o.frequency.exponentialRampToValueAtTime(41, t + 0.50);
    var g = R.gain(0);
    envAD(g.gain, t, 0.24, 0.012, 0.62);
    o.connect(g); g.connect(R.dest);
    R.run(o, t, t + 0.70);
    /* one warm crack */
    var nzc = R.noise('white', 1);
    var bpc = R.filt('bandpass', 820, 2.4);
    var gc = R.gain(0);
    envAD(gc.gain, t, 0.26, 0.002, 0.10);
    nzc.connect(bpc); bpc.connect(gc); gc.connect(R.dest);
    R.run(nzc, t, t + 0.13);
    /* rubble, falling in pitch, granular */
    var nz = R.noise('pink', 1);
    var bp = R.filt('bandpass', 1200, 1.0);
    bp.frequency.setValueAtTime(1500, t + 0.02);
    bp.frequency.exponentialRampToValueAtTime(430, t + 0.62);
    var g2 = R.gain(0);
    nz.connect(bp); bp.connect(g2); g2.connect(R.dest);
    var tt = t + 0.03, amp = 0.16;
    for (var i = 0; i < 9; i++) {
      g2.gain.setValueAtTime(0.0001, tt);
      g2.gain.linearRampToValueAtTime(amp, tt + 0.004);
      g2.gain.exponentialRampToValueAtTime(0.0001, tt + 0.055);
      tt += 0.062; amp *= 0.86;
    }
    R.run(nz, t, t + 0.90);
  };

  SYNTH['gun-break'] = function (R, t, ow) {
    var bm = briteMul(ow);
    /* metallic collapse: inharmonic partials falling together */
    var ratios = [1, 1.51, 2.31, 3.17, 4.42];
    var base = 380;
    for (var i = 0; i < ratios.length; i++) {
      var o = R.osc('triangle', base * ratios[i]);
      o.frequency.setValueAtTime(base * ratios[i], t);
      o.frequency.exponentialRampToValueAtTime(base * ratios[i] * 0.62, t + 0.42);
      var g = R.gain(0);
      envAD(g.gain, t + i * 0.012, 0.115 / (1 + i * 0.45), 0.003, 0.30 + i * 0.03);
      o.connect(g); g.connect(R.dest);
      R.run(o, t, t + 0.50);
    }
    /* coil fizzle */
    var nz = R.noise('white', 1);
    var bp = R.filt('bandpass', 3100 * bm, 1.6);
    bp.frequency.setValueAtTime(3600 * bm, t + 0.05);
    bp.frequency.exponentialRampToValueAtTime(1900 * bm, t + 0.62);
    var lpf = R.filt('lowpass', 5200 * bm, 0.8);
    var g2 = R.gain(0);
    envAD(g2.gain, t + 0.05, 0.05, 0.02, 0.60);
    nz.connect(bp); bp.connect(lpf); lpf.connect(g2); g2.connect(R.dest);
    R.run(nz, t + 0.05, t + 0.70);
  };

  SYNTH['breach'] = function (R, t) {
    /* crack */
    var nz = R.noise('white', 1);
    var bp = R.filt('bandpass', 1050, 1.8);
    var g = R.gain(0);
    envAD(g.gain, t, 0.42, 0.002, 0.090);
    nz.connect(bp); bp.connect(g); g.connect(R.dest);
    R.run(nz, t, t + 0.12);
    /* low boom */
    var o = R.osc('sine', 92);
    o.frequency.setValueAtTime(102, t + 0.01);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.55);
    var g2 = R.gain(0);
    envAD(g2.gain, t + 0.01, 0.26, 0.008, 0.70);
    o.connect(g2); g2.connect(R.dest);
    R.run(o, t, t + 0.82);
    var o2 = R.osc('triangle', 138);
    o2.frequency.setValueAtTime(150, t + 0.01);
    o2.frequency.exponentialRampToValueAtTime(66, t + 0.45);
    var g3 = R.gain(0);
    envAD(g3.gain, t + 0.01, 0.20, 0.008, 0.40);
    o2.connect(g3); g3.connect(R.dest);
    R.run(o2, t, t + 0.50);
  };

  SYNTH['build-wall'] = function (R, t) {
    var stages = [[255, 150, 0.0, 0.075, 0.30], [196, 104, 0.085, 0.135, 0.34]];
    for (var i = 0; i < stages.length; i++) {
      var s = stages[i];
      var o = R.osc('sine', s[0]);
      o.frequency.setValueAtTime(s[0], t + s[2]);
      o.frequency.exponentialRampToValueAtTime(s[1], t + s[2] + s[3]);
      var g = R.gain(0);
      envAD(g.gain, t + s[2], s[4], 0.003, s[3] + 0.05);
      o.connect(g); g.connect(R.dest);
      R.run(o, t + s[2], t + s[2] + s[3] + 0.08);
    }
    var nz = R.noise('pink', 1);
    var lp = R.filt('lowpass', 260, 1.0);
    var g2 = R.gain(0);
    envAD(g2.gain, t, 0.10, 0.003, 0.09);
    nz.connect(lp); lp.connect(g2); g2.connect(R.dest);
    R.run(nz, t, t + 0.12);
  };

  SYNTH['build-gun'] = function (R, t) {
    /* clank */
    var nz = R.noise('white', 1);
    var bp = R.filt('bandpass', 1900, 3.0);
    var lpc = R.filt('lowpass', 3600, 0.8);
    var g = R.gain(0);
    envAD(g.gain, t, 0.30, 0.0015, 0.14);
    nz.connect(bp); bp.connect(lpc); lpc.connect(g); g.connect(R.dest);
    R.run(nz, t, t + 0.17);
    var rat = [1, 1.63, 2.44];
    for (var i = 0; i < rat.length; i++) {
      var o = R.osc('triangle', 1500 * rat[i]);
      var go = R.gain(0);
      envAD(go.gain, t, 0.14 / (1 + i), 0.001, 0.16 + i * 0.02);
      o.connect(go); go.connect(R.dest);
      R.run(o, t, t + 0.22);
    }
    /* power up hum */
    var o2 = R.osc('triangle', 300);
    o2.frequency.setValueAtTime(300, t + 0.05);
    o2.frequency.exponentialRampToValueAtTime(900, t + 0.42);
    var lp = R.filt('lowpass', 1500, 1.0);
    var g2 = R.gain(0);
    envAD(g2.gain, t + 0.05, 0.050, 0.10, 0.48);
    o2.connect(lp); lp.connect(g2); g2.connect(R.dest);
    R.run(o2, t + 0.05, t + 0.58);
  };

  SYNTH['undo'] = function (R, t) {
    /* a reverse tick: the swell runs backwards into a small stop */
    var o = R.osc('triangle', 900);
    o.frequency.setValueAtTime(700, t);
    o.frequency.exponentialRampToValueAtTime(1500, t + 0.13);
    var bp = R.filt('bandpass', 1250, 2.0);
    var g = R.gain(0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.125);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.165);
    o.connect(bp); bp.connect(g); g.connect(R.dest);
    R.run(o, t, t + 0.20);
  };

  SYNTH['illegal'] = function (R, t) {
    var o = R.osc('triangle', 300);
    o.frequency.setValueAtTime(300, t);
    o.frequency.exponentialRampToValueAtTime(210, t + 0.09);
    var lp = R.filt('lowpass', 700, 1.0);
    var g = R.gain(0);
    envAD(g.gain, t, 0.20, 0.004, 0.12);
    o.connect(lp); lp.connect(g); g.connect(R.dest);
    R.run(o, t, t + 0.15);
    var nz = R.noise('pink', 1);
    var bp = R.filt('bandpass', 480, 2.0);
    var g2 = R.gain(0);
    envAD(g2.gain, t, 0.09, 0.003, 0.07);
    nz.connect(bp); bp.connect(g2); g2.connect(R.dest);
    R.run(nz, t, t + 0.10);
  };

  SYNTH['drone-turn'] = function (R, t, ow) {
    var bm = briteMul(ow);
    /* rotor dip */
    var o = R.osc('triangle', 1150);
    o.frequency.setValueAtTime(1150, t);
    o.frequency.exponentialRampToValueAtTime(820, t + 0.09);
    o.frequency.exponentialRampToValueAtTime(1150, t + 0.22);
    var g = R.gain(0);
    envAD(g.gain, t, 0.045, 0.02, 0.24);
    o.connect(g); g.connect(R.dest);
    R.run(o, t, t + 0.26);
    /* servo */
    var nz = R.noise('white', 1);
    var bp = R.filt('bandpass', 2050 * bm, 5.0);
    bp.frequency.setValueAtTime(1800 * bm, t + 0.01);
    bp.frequency.linearRampToValueAtTime(2450 * bm, t + 0.13);
    var lps = R.filt('lowpass', 3100 * bm, 0.8);
    var g2 = R.gain(0);
    envAD(g2.gain, t + 0.01, 0.19, 0.010, 0.16);
    nz.connect(bp); bp.connect(lps); lps.connect(g2); g2.connect(R.dest);
    R.run(nz, t, t + 0.20);
  };

  SYNTH['drone-pick'] = function (R, t) {
    var nz = R.noise('white', 1);
    var bp = R.filt('bandpass', 4200, 4.0);
    var g = R.gain(0);
    envAD(g.gain, t, 0.16, 0.0008, 0.035);
    nz.connect(bp); bp.connect(g); g.connect(R.dest);
    R.run(nz, t, t + 0.06);
    var o = R.osc('triangle', 4600);
    var g2 = R.gain(0);
    envAD(g2.gain, t, 0.06, 0.0008, 0.018);
    o.connect(g2); g2.connect(R.dest);
    R.run(o, t, t + 0.04);
  };

  SYNTH['drone-drop'] = function (R, t) {
    var nz = R.noise('white', 1);
    var bp = R.filt('bandpass', 3100, 2.6);
    var lpd = R.filt('lowpass', 4400, 0.8);
    var g = R.gain(0);
    envAD(g.gain, t, 0.17, 0.0015, 0.055);
    nz.connect(bp); bp.connect(lpd); lpd.connect(g); g.connect(R.dest);
    R.run(nz, t, t + 0.08);
    var o = R.osc('triangle', 640);
    o.frequency.setValueAtTime(680, t);
    o.frequency.exponentialRampToValueAtTime(430, t + 0.06);
    var g2 = R.gain(0);
    envAD(g2.gain, t, 0.020, 0.0020, 0.06);
    o.connect(g2); g2.connect(R.dest);
    R.run(o, t, t + 0.09);
  };

  SYNTH['keep-hit'] = function (R, t) {
    /* a bell: one low fundamental with inharmonic partials above it */
    var parts = [[146, 0.21, 1.10], [219, 0.15, 0.85], [402, 0.22, 0.62], [604, 0.15, 0.45], [905, 0.075, 0.30]];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var o = R.osc('sine', p[0]);
      var g = R.gain(0);
      envAD(g.gain, t, p[1], 0.004, p[2]);
      o.connect(g); g.connect(R.dest);
      R.run(o, t, t + p[2] + 0.06);
    }
    var nz = R.noise('white', 1);
    var bp = R.filt('bandpass', 900, 1.6);
    var g2 = R.gain(0);
    envAD(g2.gain, t, 0.13, 0.001, 0.055);
    nz.connect(bp); bp.connect(g2); g2.connect(R.dest);
    R.run(nz, t, t + 0.08);
  };

  SYNTH['keep-fell'] = function (R, t) {
    var o = R.osc('sine', 200);
    o.frequency.setValueAtTime(205, t);
    o.frequency.exponentialRampToValueAtTime(95, t + 0.30);
    o.frequency.exponentialRampToValueAtTime(46, t + 1.25);
    var g = R.gain(0);
    envAD(g.gain, t, 0.27, 0.02, 1.45);
    o.connect(g); g.connect(R.dest);
    R.run(o, t, t + 1.55);
    var o2 = R.osc('triangle', 100);
    o2.frequency.setValueAtTime(103, t);
    o2.frequency.exponentialRampToValueAtTime(25, t + 1.20);
    var g2 = R.gain(0);
    envAD(g2.gain, t, 0.16, 0.03, 1.30);
    o2.connect(g2); g2.connect(R.dest);
    R.run(o2, t, t + 1.40);
    var nz = R.noise('pink', 1);
    var lp = R.filt('lowpass', 170, 0.8);
    var g3 = R.gain(0);
    envAD(g3.gain, t, 0.09, 0.03, 0.85);
    nz.connect(lp); lp.connect(g3); g3.connect(R.dest);
    R.run(nz, t, t + 0.95);
  };

  SYNTH['wave-start'] = function (R, t) {
    /* a horn swell: a fifth, opening */
    var f = [196, 294, 392];
    for (var i = 0; i < f.length; i++) {
      var o = R.osc('sawtooth', f[i]);
      o.detune.setValueAtTime(i === 1 ? 4 : -3, t);
      var lp = R.filt('lowpass', 700, 1.0);
      lp.frequency.setValueAtTime(430, t);
      lp.frequency.exponentialRampToValueAtTime(1750, t + 0.55);
      var g = R.gain(0);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.10 / (1 + i * 0.35), t + 0.42);
      g.gain.setValueAtTime(0.10 / (1 + i * 0.35), t + 0.70);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.10);
      o.connect(lp); lp.connect(g); g.connect(R.dest);
      R.run(o, t, t + 1.15);
    }
  };

  SYNTH['wave-held'] = function (R, t) {
    /* a soft resolved chord */
    var f = [494, 587, 740, 988];
    for (var i = 0; i < f.length; i++) {
      var o = R.osc('triangle', f[i]);
      var g = R.gain(0);
      g.gain.setValueAtTime(0.0001, t + i * 0.035);
      g.gain.exponentialRampToValueAtTime(0.105 / (1 + i * 0.20), t + i * 0.035 + 0.10);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.30);
      var lp = R.filt('lowpass', 3200, 0.8);
      o.connect(lp); lp.connect(g); g.connect(R.dest);
      R.run(o, t, t + 1.40);
    }
  };

  SYNTH['focus-mark'] = function (R, t) {
    var f = [660, 990];
    for (var i = 0; i < f.length; i++) {
      var o = R.osc('triangle', f[i]);
      var g = R.gain(0);
      envAD(g.gain, t + i * 0.075, 0.15, 0.004, 0.11);
      o.connect(g); g.connect(R.dest);
      R.run(o, t + i * 0.075, t + i * 0.075 + 0.15);
    }
  };

  SYNTH['ui-tick'] = function (R, t) {
    var o = R.osc('triangle', 2700);
    var g = R.gain(0);
    envAD(g.gain, t, 0.10, 0.001, 0.035);
    var bp = R.filt('bandpass', 2700, 2.5);
    o.connect(bp); bp.connect(g); g.connect(R.dest);
    R.run(o, t, t + 0.05);
  };

  SYNTH['tour-chime'] = function (R, t) {
    var f = [1865, 2489];
    for (var i = 0; i < f.length; i++) {
      var o = R.osc('sine', f[i]);
      var g = R.gain(0);
      envAD(g.gain, t + i * 0.055, 0.10 / (1 + i * 0.8), 0.004, 0.34);
      o.connect(g); g.connect(R.dest);
      R.run(o, t + i * 0.055, t + i * 0.055 + 0.40);
    }
  };

  SYNTH['sound-on'] = function (R, t) {
    var f = [3136, 3951];
    for (var i = 0; i < f.length; i++) {
      var o = R.osc('sine', f[i]);
      var g = R.gain(0);
      envAD(g.gain, t + i * 0.070, 0.095, 0.003, 0.14);
      o.connect(g); g.connect(R.dest);
      R.run(o, t + i * 0.070, t + i * 0.070 + 0.18);
    }
  };

  /* ------------------------------------------------------------- loops */

  function startLoop(ctx, dest, name, id, params, t) {
    var R = new Rig(ctx, dest, t, {});
    var out = ctx.createGain(); out.gain.value = 0.0001;
    out.connect(dest);
    var rec = { name: name, id: id, out: out, srcs: [], params: params || {}, mods: {} };

    if (name === 'chew') {
      var nz = R.noise('white', 1);
      var bp = R.filt('bandpass', 360, 1.8);
      var lp = R.filt('lowpass', 900, 0.8);
      var vca = ctx.createGain(); vca.gain.value = 0;
      var lfo = ctx.createOscillator(); lfo.type = 'sawtooth';
      lfo.frequency.value = 5.4 * (params.rate || 1);
      var lfoAmp = ctx.createGain(); lfoAmp.gain.value = -0.5;
      lfo.connect(lfoAmp); lfoAmp.connect(vca.gain);
      var off = null;
      if (ctx.createConstantSource) {
        off = ctx.createConstantSource(); off.offset.value = 0.5;
        off.connect(vca.gain);
      } else {
        vca.gain.value = 0.5;   /* fallback: the offset lives on the param */
      }
      nz.connect(bp); bp.connect(lp); lp.connect(vca); vca.connect(out);
      var low = R.osc('triangle', 96);
      var lg = ctx.createGain(); lg.gain.value = 0.055;
      low.connect(lg); lg.connect(vca);
      rec.srcs = off ? [nz, lfo, off, low] : [nz, lfo, low];
      rec.mods = { lfo: lfo, bp: bp };
    } else if (name === 'swarm') {
      var sk = R.noise('skit', 1);
      var sbp = R.filt('bandpass', 1580, 0.9);
      var shp = R.filt('highpass', 700, 0.7);
      var slp = R.filt('lowpass', 2100, 0.8);
      var slp2 = R.filt('lowpass', 2100, 0.8);
      sk.connect(sbp); sbp.connect(shp); shp.connect(slp); slp.connect(slp2);
      slp2.connect(out);
      rec.srcs = [sk];
      rec.mods = { bp: sbp };
    } else if (name === 'drone-hum') {
      var base = 1050 * (params.owner === 0 ? 1.10 : 1);
      var o1 = R.osc('triangle', base);
      var o2 = R.osc('triangle', base * 1.005);
      var bpd = R.filt('bandpass', base * 1.05, 3.0);
      var wob = ctx.createOscillator(); wob.type = 'sine'; wob.frequency.value = 6.5;
      var wobAmp = ctx.createGain(); wobAmp.gain.value = 9;
      wob.connect(wobAmp); wobAmp.connect(o1.detune);
      var hg = ctx.createGain(); hg.gain.value = 0.55;
      o1.connect(bpd); o2.connect(bpd); bpd.connect(hg); hg.connect(out);
      var nzd = R.noise('white', 1);
      var bpn = R.filt('bandpass', 1250, 1.4);
      var ng = ctx.createGain(); ng.gain.value = 0.045;
      nzd.connect(bpn); bpn.connect(ng); ng.connect(out);
      rec.srcs = [o1, o2, wob, nzd];
      rec.mods = { o1: o1, o2: o2, bp: bpd, base: base };
    }

    for (var i = 0; i < rec.srcs.length; i++) {
      try { rec.srcs[i].start(t); } catch (err) { /* already started */ }
    }
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(loopGain(name, params), t + 0.12);
    return rec;
  }

  function loopGain(name, p) {
    p = p || {};
    if (name === 'swarm') {
      var n = p.n == null ? 1 : p.n;
      return Math.max(0.0002, 0.020 + 0.085 * Math.min(1, n / 18));
    }
    if (name === 'drone-hum') return 0.055;
    return 0.16;   /* chew */
  }

  function updateLoop(rec, params, t) {
    var p = rec.params;
    for (var k in params) if (params.hasOwnProperty(k)) p[k] = params[k];
    var g = loopGain(rec.name, p);
    try {
      rec.out.gain.cancelScheduledValues(t);
      rec.out.gain.setValueAtTime(Math.max(rec.out.gain.value, 0.0001), t);
      rec.out.gain.exponentialRampToValueAtTime(Math.max(g, 0.0001), t + 0.08);
    } catch (err) { /* an offline context can refuse a past time */ }
    if (rec.name === 'drone-hum' && rec.mods.o1) {
      var sp = p.speed == null ? 0.5 : p.speed;
      var f = rec.mods.base * (0.86 + 0.34 * sp);
      try {
        rec.mods.o1.frequency.linearRampToValueAtTime(f, t + 0.08);
        rec.mods.o2.frequency.linearRampToValueAtTime(f * 1.005, t + 0.08);
        rec.mods.bp.frequency.linearRampToValueAtTime(f * 1.05, t + 0.08);
      } catch (err) { /* ditto */ }
    }
    if (rec.name === 'chew' && rec.mods.lfo) {
      try { rec.mods.lfo.frequency.linearRampToValueAtTime(5.4 * (p.rate || 1), t + 0.08); }
      catch (err) { /* ditto */ }
    }
  }

  function killLoop(rec, t, fade) {
    var f = fade == null ? 0.06 : fade;
    try {
      rec.out.gain.cancelScheduledValues(t);
      rec.out.gain.setValueAtTime(Math.max(rec.out.gain.value, 0.0001), t);
      rec.out.gain.exponentialRampToValueAtTime(0.00005, t + f);
    } catch (err) { /* ignore */ }
    for (var i = 0; i < rec.srcs.length; i++) {
      try { rec.srcs[i].stop(t + f + 0.01); } catch (err) { /* ignore */ }
    }
    setTimeoutSafe(function () {
      try { rec.out.disconnect(); } catch (err) { /* ignore */ }
    }, (f + 0.05) * 1000);
  }

  function setTimeoutSafe(fn, ms) {
    if (cfg && cfg.offline) return;
    if (typeof setTimeout === 'function') setTimeout(fn, ms);
  }

  /* ------------------------------------------------------- ducking bus */

  var duckLog = [];

  function duckEnd(d) { return d.t + d.attackMs + d.holdMs + d.releaseMs; }

  function applyDucks(ds) {
    if (!nodes || !ds.length) return;
    var i, t0 = ds[0].t;
    for (i = 1; i < ds.length; i++) if (ds[i].t < t0) t0 = ds[i].t;
    /* A duck that finished before this batch begins can no longer shape it.
       Anything still running MUST stay, or the merged envelope would be
       rewritten as if it had never happened. */
    var keep = [];
    for (i = 0; i < duckLog.length; i++) if (duckEnd(duckLog[i]) >= t0) keep.push(duckLog[i]);
    duckLog = keep.concat(ds);

    for (var c = 1; c < NCLASS; c++) {
      var t1 = t0, touched = false;
      for (i = 0; i < duckLog.length; i++) {
        if (duckLog[i].targets.indexOf(c) < 0) continue;
        touched = true;
        var e = duckEnd(duckLog[i]);
        if (e > t1) t1 = e;
      }
      if (touched) writeDuck(c, t0, t1);
    }
  }

  /* A 10 ms grid with linear ramps between the points, so a 9 dB duck opens
     over its 20 ms attack instead of stepping (a step would click). Runs of
     equal value collapse to their two ends, so a quiet stretch costs 2 points. */
  function writeDuck(cls, t0Ms, t1Ms) {
    var p = nodes.busses[cls].gain;
    var step = 10, pts = [], t, g;
    for (t = t0Ms; t <= t1Ms + step; t += step) {
      pts.push([t, trimGain(cls) * Math.pow(10, -duckDbAt(duckLog, cls, t) / 20)]);
    }
    pts.push([t1Ms + step * 2, trimGain(cls)]);
    var out = [];
    for (var i = 0; i < pts.length; i++) {
      var prevSame = i > 0 && pts[i - 1][1] === pts[i][1];
      var nextSame = i < pts.length - 1 && pts[i + 1][1] === pts[i][1];
      if (prevSame && nextSame) continue;
      out.push(pts[i]);
    }
    try { p.cancelScheduledValues(ctxTime(t0Ms)); } catch (err) { /* ignore */ }
    for (var j = 0; j < out.length; j++) {
      g = out[j][1];
      try {
        if (j === 0) p.setValueAtTime(g, ctxTime(out[j][0]));
        else p.linearRampToValueAtTime(g, ctxTime(out[j][0]));
      } catch (err2) { /* a context can refuse a time in its past */ }
    }
  }

  /* -------------------------------------------------------- scheduling */

  function ctxTime(pageMs) {
    return anchorCtx + (pageMs - anchorPage) / 1000 + cfg.lookahead;
  }

  function reanchor() {
    if (!M.ctx || cfg.offline) return;
    var expect = anchorCtx + (cfg.now() - anchorPage) / 1000;
    if (Math.abs(expect - M.ctx.currentTime) > 0.12) {
      anchorCtx = M.ctx.currentTime;
      anchorPage = cfg.now();
    }
  }

  function dbToGain(db) { return Math.pow(10, db / 20); }

  /* Fade a live one shot out and forget it. The ending law's other half: the
     scheduler decided the slot was needed, this is what taking it sounds like.
     A 90 ms exponential fade on the voice's own level gain, which is the only
     node between the rig and the bus, so nothing else is touched. The sources
     keep their own stop times and run out into silence. */
  function stopVoice(seq, tCtx, fadeMs) {
    var rec = liveVoices[seq];
    if (!rec) return false;
    var f = (fadeMs == null ? EVICT_FADE_MS : fadeMs) / 1000;
    try {
      var p = rec.lvl.gain;
      p.cancelScheduledValues(tCtx);
      p.setValueAtTime(Math.max(p.value, 0.0001), tCtx);
      p.exponentialRampToValueAtTime(0.00005, tCtx + f);
    } catch (err) { /* a context can refuse a time in its past */ }
    delete liveVoices[seq];
    stats.evicted++;
    return true;
  }

  /* Offline there is no setTimeout to clear the registry, and online the
     timeout can only ever run late, so every fire also forgets whatever has
     already finished. A voice that has stopped can never be evicted. */
  function pruneVoices(tCtx) {
    for (var k in liveVoices) {
      if (liveVoices.hasOwnProperty(k) && liveVoices[k].end <= tCtx) delete liveVoices[k];
    }
  }

  function fire(entry) {
    var ctx = M.ctx;
    if (!ctx || !nodes) return;
    var synth = SYNTH[entry.v];
    if (!synth) return;
    var t = ctxTime(entry.t);
    if (!cfg.offline && t < ctx.currentTime + 0.005) t = ctx.currentTime + 0.005;

    var panner = null, head;
    var lvl = ctx.createGain();
    lvl.gain.value = dbToGain((entry.gainDb || 0) + (entry.levelDb || 0));
    if (entry.pan && ctx.createStereoPanner) {
      panner = ctx.createStereoPanner();
      panner.pan.value = entry.pan;
      lvl.connect(panner);
      panner.connect(nodes.busses[entry.cls]);
    } else {
      lvl.connect(nodes.busses[entry.cls]);
    }
    head = lvl;

    var R = new Rig(ctx, head, t, {});
    synth(R, t, ownerSplit(entry.v) ? entry.owner : null);
    var end = R.go();

    stats.started++;
    stats.byClass[entry.cls]++;
    stats.byVoice[entry.v] = (stats.byVoice[entry.v] || 0) + 1;
    if (entry.coalesced) stats.coalesced += entry.coalesced;
    stats.log.push({
      name: entry.v, cls: entry.cls, owner: entry.owner,
      t0: t, t1: end, gainDb: (entry.gainDb || 0) + (entry.levelDb || 0),
      pan: entry.pan || 0
    });
    pruneVoices(t);
    if (entry.seq != null) liveVoices[entry.seq] = { lvl: lvl, panner: panner, end: end };
    var seqKey = entry.seq;
    setTimeoutSafe(function () {
      if (seqKey != null) delete liveVoices[seqKey];
      try { lvl.disconnect(); if (panner) panner.disconnect(); } catch (err) { /* ignore */ }
    }, (end - t) * 1000 + 260);
  }

  function runPlan(res) {
    for (var i = 0; i < res.drop.length; i++) {
      stats.dropped++;
      var r = res.drop[i].reason;
      stats.dropByReason[r] = (stats.dropByReason[r] || 0) + 1;
    }
    if (res.skip && res.skip.length) stats.loopSkipped += res.skip.length;
    if (res.ducks.length) applyDucks(res.ducks);
    for (var j = 0; j < res.play.length; j++) {
      var e = res.play[j];
      if (e.op === 'play') { fire(e); continue; }
      var t = ctxTime(e.t);
      if (!cfg.offline && M.ctx && t < M.ctx.currentTime + 0.005) t = M.ctx.currentTime + 0.005;
      if (e.op === 'stopVoice') {
        stopVoice(e.seq, t);
      } else if (e.op === 'loop') {
        if (loops[e.id]) { updateLoop(loops[e.id], e.params || {}, t); continue; }
        var dest = nodes.busses[e.cls == null ? 3 : e.cls];
        loops[e.id] = startLoop(M.ctx, dest, e.v, e.id, e.params || {}, t);
        stats.byVoice[e.v] = (stats.byVoice[e.v] || 0) + 1;
      } else if (e.op === 'setLoopParam') {
        if (loops[e.id]) updateLoop(loops[e.id], e.params || {}, t);
      } else if (e.op === 'stopLoop') {
        if (loops[e.id]) { killLoop(loops[e.id], t); delete loops[e.id]; }
      }
    }
    planState = res.state;
  }

  function submit(evs) {
    if (!cfg) M.init({});
    planState.muted = muted;
    planState.reduced = readReduced();
    planState.view = view;
    var res = PURE.plan(evs, planState);
    if (!M.ctx) { planState = res.state; return res; }
    reanchor();
    runPlan(res);
    return res;
  }

  /* ------------------------------------------------------- public play */

  M.play = function (name, opts) {
    opts = opts || {};
    var t = opts.t == null ? (cfg ? cfg.now() : 0) : opts.t;
    var evs = [{ t: t, op: 'play', v: name, owner: opts.owner, x: opts.x, y: opts.y,
                 gainDb: opts.gainDb, params: opts.param }];
    /* the discharge rides with every impact, in the impact's own class */
    if (name === 'impact-creature' || name === 'impact-ground') {
      evs.push({ t: t + 18, op: 'play', v: 'discharge', owner: opts.owner,
                 x: opts.x, y: opts.y, ride: name });
    }
    var res = submit(evs);
    for (var i = 0; i < res.play.length; i++) {
      if (res.play[i].op === 'play' && res.play[i].v === name) return true;
    }
    return false;
  };

  /* One batch, so identical voices inside 30 ms can coalesce instead of being
     suppressed by the cooldown. The page calls this ONCE PER TICK with that
     tick's whole event list (build spec v3 s7.15 ruling 9): coalescing can only
     ever happen inside one call, because by the time a second call arrives the
     first voice is already scheduled.

     `t` is optional and is the tick's own page clock time. Every event without
     its own `t` takes it, so one tick's voices carry ONE timestamp rather than
     a handful of clock reads a fraction of a millisecond apart. Left out, each
     event falls back to the clock exactly as before.

     `e.name` is accepted beside `e.v` so the page can hand this the list its own
     ev to voice mapping already produces, with no second shape to keep in step.
     A voice with neither is dropped by PURE.plan as an unknown voice, counted,
     and never guessed at. */
  M.playMany = function (events, t) {
    var evs = [], et, tick = (t == null) ? null : t;
    for (var i = 0; i < (events || []).length; i++) {
      var e = events[i];
      if (!e) continue;
      var v = (e.v == null) ? e.name : e.v;
      et = e.t == null ? (tick == null ? (cfg ? cfg.now() : 0) : tick) : e.t;
      evs.push({ t: et, op: e.op || 'play', v: v, id: e.id, owner: e.owner,
                 x: e.x, y: e.y, gainDb: e.gainDb, params: e.params });
      if ((e.op || 'play') === 'play' && (v === 'impact-creature' || v === 'impact-ground')) {
        evs.push({ t: et + 18, op: 'play', v: 'discharge', owner: e.owner,
                   x: e.x, y: e.y, ride: v });
      }
    }
    return submit(evs);
  };

  M.loop = function (name, id, params) {
    var p = params || {};
    var t = p.t == null ? (cfg ? cfg.now() : 0) : p.t;
    var res = submit([{ t: t, op: 'loop', v: name, id: id, params: p }]);
    for (var i = 0; i < res.play.length; i++) {
      if (res.play[i].id === id && (res.play[i].op === 'loop' || res.play[i].op === 'setLoopParam')) return true;
    }
    /* A re-issue that changed nothing did no work and lost nothing: the loop
       is live and already carries these parameters, so this is true. */
    for (var j = 0; res.skip && j < res.skip.length; j++) {
      if (res.skip[j].id === id) return true;
    }
    return false;
  };

  M.setLoopParam = function (id, params) {
    var p = params || {};
    var t = p.t == null ? (cfg ? cfg.now() : 0) : p.t;
    submit([{ t: t, op: 'setLoopParam', id: id, params: p }]);
  };

  M.stopLoop = function (id, atMs) {
    submit([{ t: atMs == null ? (cfg ? cfg.now() : 0) : atMs, op: 'stopLoop', id: id }]);
  };

  M.stopAllLoops = function (atMs) {
    var ids = [], k;
    for (k in loops) if (loops.hasOwnProperty(k)) ids.push(k);
    for (var i = 0; i < ids.length; i++) M.stopLoop(ids[i], atMs);
    if (planState) { for (k in planState.loops) if (planState.loops.hasOwnProperty(k)) delete planState.loops[k]; }
  };

  M.setView = function (v) {
    v = v || {};
    view = {
      boardW: v.boardW == null ? view.boardW : v.boardW,
      camX0:  v.camX0  == null ? view.camX0  : v.camX0,
      camX1:  v.camX1  == null ? view.camX1  : v.camX1,
      follow: !!v.follow
    };
    if (planState) planState.view = view;
  };

  function applyMuteGain(fadeMs, atMs) {
    if (!nodes || !M.ctx) return;
    var t = (atMs == null) ? M.ctx.currentTime : ctxTime(atMs) - cfg.lookahead;
    var target = muted ? 0.0001 : masterGain;
    var p = nodes.master.gain;
    try {
      p.cancelScheduledValues(t);
      p.setValueAtTime(Math.max(p.value, 0.0001), t);
      if (fadeMs > 0) p.exponentialRampToValueAtTime(target, t + fadeMs / 1000);
      else p.setValueAtTime(target, t);
    } catch (err) { /* ignore */ }
  }

  /* `atMs` is optional and is a PAGE clock time. The page never passes it; the
     audit does, so an offline render can schedule the mute at a known instant
     and measure exactly how long the sound takes to stop. */
  M.setMuted = function (on, atMs) {
    var was = muted;
    muted = !!on;
    if (planState) planState.muted = muted;
    if (cfg && cfg.storage && !cfg.offline) {
      try { cfg.storage.setItem(cfg.storageKey, muted ? 'off' : 'on'); } catch (err) { /* ignore */ }
    }
    if (muted) {
      M.stopAllLoops(atMs);
      applyMuteGain(20, atMs);
    } else {
      applyMuteGain(20, atMs);
      if (was && M.ctx) M.play('sound-on', atMs == null ? {} : { t: atMs });
    }
    return muted;
  };

  M.muted = function () { return muted; };

  /* Read only views, for the page status line and for the audit. */
  M.loopIds = function () {
    var out = [];
    for (var k in loops) if (loops.hasOwnProperty(k)) out.push(k);
    return out;
  };

  M.mixState = function () {
    if (!nodes) return { master: null, busses: null, muted: muted, armed: !!M.ctx };
    var b = [];
    for (var c = 0; c < NCLASS; c++) b.push(nodes.busses[c].gain.value);
    return { master: nodes.master.gain.value, busses: b, muted: muted,
             armed: !!M.ctx, state: M.ctx ? M.ctx.state : null };
  };

  /* The output level. The page never calls this; the audit does, so the two
     owner timbres can be compared with no limiter in the way. */
  M.setMasterGain = function (g) {
    masterGain = (g == null) ? MASTER_GAIN : Math.max(0, Math.min(8, g));
    if (nodes && !muted) nodes.master.gain.value = masterGain;
    return masterGain;
  };

  M.setBusSolo = function (cls) {
    solo = (cls == null ? null : cls);
    if (!nodes) return;
    for (var c = 0; c < NCLASS; c++) {
      nodes.solos[c].gain.value = (solo == null || solo === c) ? 1 : 0;
    }
  };

  /* --------------------------------------------------------- replay */

  M.replay = function (fixture, opts) {
    opts = opts || {};
    var fx = fixture || { events: [] };
    if (fx.boardW) M.setView({ boardW: fx.boardW, follow: !!fx.follow,
                               camX0: fx.camX0 == null ? 0 : fx.camX0,
                               camX1: fx.camX1 == null ? fx.boardW - 1 : fx.camX1 });
    var t0 = opts.t0 == null ? (cfg ? cfg.now() : 0) : opts.t0;
    if (cfg && cfg.offline) { anchorPage = t0; anchorCtx = 0; }
    if (opts.solo !== undefined) M.setBusSolo(opts.solo);

    /* How the fixture is handed to the mixer. This is the difference the volley
       law lives or dies on, so it is a knob the audit can turn rather than an
       assumption baked into the harness:

         'batch' (default)  one submit for the whole fixture. What every earlier
                            audit measured, and the most coalescing there is.
         'tick'             one submit per distinct event time, which is what the
                            page does when it hands a tick to playMany.
         'each'             one submit per event, which is what calling play per
                            event does: identical voices inside 30 ms are
                            cooldown DROPPED instead of coalescing.

       Nothing else changes between the three, so the drop reasons are a straight
       comparison. */
    var mode = opts.mode || 'batch';
    var groups = [], evs = [], lastT = null;
    for (var i = 0; i < fx.events.length; i++) {
      var e = fx.events[i];
      if (opts.voiceSolo && e.v !== opts.voiceSolo && e.op !== 'stopLoop') continue;
      var c = { t: t0 + (e.t || 0), op: e.op || 'play', v: e.v, id: e.id,
                owner: e.owner, x: e.x, y: e.y, gainDb: e.gainDb, params: e.params };
      if (mode === 'each') { groups.push([c]); }
      else if (mode === 'tick') {
        if (lastT === null || c.t !== lastT) { evs = []; groups.push(evs); lastT = c.t; }
        evs.push(c);
      } else {
        if (!groups.length) groups.push(evs);
        evs.push(c);
      }
      if (!opts.noRide && (c.op === 'play') && (c.v === 'impact-creature' || c.v === 'impact-ground')) {
        groups[groups.length - 1].push({ t: c.t + 18, op: 'play', v: 'discharge',
                                         owner: c.owner, x: c.x, y: c.y, ride: c.v });
      }
    }
    if (!groups.length) groups.push([]);
    var all = { play: [], drop: [], ducks: [], skip: [], state: null };
    for (var gi = 0; gi < groups.length; gi++) {
      var res = submit(groups[gi]);
      all.play = all.play.concat(res.play);
      all.drop = all.drop.concat(res.drop);
      all.ducks = all.ducks.concat(res.ducks);
      all.skip = all.skip.concat(res.skip || []);
      all.state = res.state;
    }
    all.calls = groups.length;
    all.mode = mode;
    return Promise.resolve({ stats: stats, plan: all });
  };

  M.VOICE_NAMES = VOICE_NAMES;
  M.CLASS_BUDGET = CLASS_BUDGET;

  root.KeepAudio = M;
  if (typeof module !== 'undefined' && module.exports) module.exports = M;

}(typeof window !== 'undefined' ? window
  : (typeof self !== 'undefined' ? self : globalThis)));
