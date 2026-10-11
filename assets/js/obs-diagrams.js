/* obs-diagrams.js  --  window.ObsDiagrams
   ==========================================================================
   The two Observatory diagram explainers of plan-observatory-act1.md
   section 7, drawn on a plain 2D canvas:

     ObsDiagrams.quake(canvas, state)   a side cross-section of the planet:
             crust line, hypocenter star, the P and S wavefronts expanding
             at 6.0 and 3.5 km/s, the ionosphere band above with the
             expected acoustic arrival window, and the Wikipedia stopwatch
             strip underneath.
     ObsDiagrams.flare(canvas, state)   the Sun to Earth pipeline: three
             lanes with their own clocks (light, energetic particles,
             coronal mass ejection) and a mini day side absorption bloom
             tied to the D-RAP peak frequency.

   Contract, and the reasons for it:

     * ONE call paints ONE frame. There is no clock and no timer in this
       file: `state.now` and `state.t0` are injected, so the caller owns the
       rAF loop and the tests own time. Nothing here reads a wall clock,
       fetches anything, or calls a random number generator.
     * Nothing is invented. Every number drawn arrives in `state` or falls
       out of the two pinned wave speeds. A missing field means the label
       is dropped, never guessed. No damage claims, no tsunami claims.
     * `state.echoTitle` is the headline the rail is printing one row above
       this tile, when there is one. A header candidate character identical
       to it is skipped and the ladder falls to the next rung, so the tile
       adds a fact rather than repeating one (r19g (16)). The floor rung
       stands either way; the string is never rewritten, only passed over.
     * `state.reduced` renders the static variant: positions still track the
       injected time (the numbers stay live), but nothing that exists only
       to imply motion is drawn.
     * Theme fixed dark, both site themes, per the dark sky doctrine in
       section 8. Colors come from the section 3 palette. Gold #c8a45c is
       the finding color everywhere on this page, so the only gold here is
       the measured Wikipedia latency: the one quantity these diagrams
       derive rather than receive.
     * Zero per frame allocation beyond the label strings themselves:
       layout, lane descriptors, gradients and the star outline are module
       scratch, rebuilt only when their inputs change.
     * Every string drawn is recorded in a pooled box ledger (LAST.boxes,
       ObsDiagrams.__boxes()) tagged with the band it belongs to, so a test
       can assert what a reader can see: nothing sliced by the tile edge,
       nothing outside its own band, no two labels on the same pixels. The
       pool is module scratch as well, so reading it costs one array push.
     * Every value that reaches an arc radius, a gradient or a transform
       goes through num()/clamp() first. One non finite radius throws and
       kills the caller's rAF loop for good (the voyage lesson).

   The pure half (time to radius, the span ladders, clock and duration
   formatting, the lane state machine, the severity ladders) is exported as
   ObsDiagrams.PURE with its constants in PURE.C, and is covered by
   tests/node/t-diagrams.js.

   Sources for the physics that is drawn:
     * P and S speeds 6.0 and 3.5 km/s: the round crustal figures the
       narration templates in spec section 11 already use.
     * Sunlight travel time 8 min 20 s: 1 AU at c.
     * The 8 to 15 minute acoustic arrival at ionospheric heights is the
       published window for coseismic ionospheric disturbances; the rising
       dome that illustrates it is stylized, and the label says expected,
       never detected, because Act 1 has no instrument watching for it.
   ========================================================================== */
(function (global) {
  'use strict';

  /* ======================================================================
     constants (PURE.C -- the node suite reads these, and DIAG_BREAK=1
     flips one of them to prove the assertions bite, so every function
     below must read them off this object rather than capturing a local)
     ====================================================================== */
  var C = {
    P_SPEED_KMS: 6.0,
    S_SPEED_KMS: 3.5,
    SURFACE_HALF_KM: 20037.5,          /* half the equatorial circumference */
    SPAN_LADDER_KM: [100, 200, 500, 1000, 2000, 3000, 5000, 8000, 12000, 20000],
    SPAN_FILL: 0.72,                   /* the P front sits at this much of the half width */
    ACOUSTIC_OPEN_MS: 480000,          /* 8 min */
    ACOUSTIC_CLOSE_MS: 900000,         /* 15 min */
    TIMELINE_LADDER_MS: [120000, 300000, 900000, 1800000, 5400000],
    TIMELINE_FILL: 0.84,
    STOPWATCH_LIMIT_MS: 5400000,       /* 90 min, the spec's give up point */
    LIGHT_TRAVEL_MS: 500000,           /* 8 min 20 s */
    BLOOM_FULL_MHZ: 35,
    MAX_DPR: 2,
    PHI: 1.618033988749895
  };

  /* severity ladders, pinned verbatim in spec section 11 */
  var QUAKE_WORDS = [[8, 'great'], [7, 'major'], [6, 'strong'], [5.5, 'moderate']];

  /* r19i (10): the two forms that name the header clock. The long one rides
     in the header row itself; the short one goes in the tiny row directly
     under it when the header cannot hold the long one. Neither is ever
     shortened further: a clock with no name is not drawn. */
  var SINCE_HEAD = ' since the quake';
  var SINCE_TINY = 'since quake';

  /* ======================================================================
     palette (section 3)

     r19t (7): the tile is NOT sky. It is a picture inside the rail PLATE, and
     _pages/observatory.md's own r19 (14) law is "one surface per theme: the
     sky stays dark, because space does not invert, but every plate on it takes
     the panel's own light recipe". Until this round the tile ignored that, so
     the light page carried one near-black rectangle inside a white plate and a
     judge read it as a pasted in screenshot (r19s light N1, light-21). There
     are now two palettes with the same keys, and `COL` is whichever one the
     frame is drawn in. Every ink below comes from the page's own tokens:
     --obs-sky-ink #262626, --obs-sky-dim #595959, --obs-sky-accent #34568a,
     and the light gold #8a6a1f the rail already uses, because #c8a45c on white
     is a wash. Nothing else moves: the same shapes, the same strings, the same
     gold rule (the measured Wikipedia latency is still the one gold thing).
     ====================================================================== */
  var COL_D = {
    bg:        '#0f131a',
    sky:       '#0c1017',
    interior:  '#171c24',
    crust:     'rgba(214,214,214,0.42)',
    crustFill: 'rgba(214,214,214,0.09)',
    text:      '#d6d6d6',
    mute:      'rgba(214,214,214,0.58)',
    faint:     'rgba(214,214,214,0.32)',
    ghost:     'rgba(214,214,214,0.13)',
    rule:      'rgba(214,214,214,0.11)',
    accent:    '#82a6cc',
    accentSoft:'#a3c2e0',
    accentDim: 'rgba(130,166,204,0.34)',
    accentWash:'rgba(130,166,204,0.055)',
    ionoEdge:  'rgba(130,166,204,0.32)',
    gold:      '#c8a45c',
    goldDim:   'rgba(200,164,92,0.34)',
    brick:     'rgba(176,96,92,0.85)',
    brickSoft: 'rgba(176,96,92,0.30)',
    plate:     'rgba(12,16,23,0.74)',
    night:     '#141a23',
    /* r19t (7): the last inks that were still written into the drawing
       bodies as literals. They are palette keys now, so the light plate is
       inked by the same one switch as everything else and no dark theme
       accent survives on a white ground. `brickRGB` is the channel triple on
       its own, because the absorption bloom composes its own alpha. */
    strata:    'rgba(214,214,214,0.045)',
    ionoWashA: 'rgba(130,166,204,0.04)',
    ionoWashB: 'rgba(130,166,204,0.17)',
    frontGlow: 'rgba(130,166,204,0.18)',
    frontLive: 'rgba(130,166,204,0.5)',
    dayGlowA:  'rgba(130,166,204,0.52)',
    dayGlowB:  'rgba(130,166,204,0.20)',
    dayGlowC:  'rgba(130,166,204,0)',
    limb:      'rgba(130,166,204,0.45)',
    brickRGB:  '176,96,92'
  };

  /* The same keys, inked for the light plate. The ORDER of the three grounds
     is preserved rather than the values: in the dark tile the sky is the
     darkest of the three and solid earth the lightest, so here the sky is the
     lightest and solid earth the darkest, and a reader still reads rock as the
     more material of the two. */
  var COL_L = {
    bg:        '#f2f5f8',
    sky:       '#fbfcfe',
    interior:  '#e2e7ee',
    crust:     'rgba(38,38,38,0.42)',
    crustFill: 'rgba(38,38,38,0.07)',
    text:      '#262626',
    mute:      '#595959',
    faint:     'rgba(38,38,38,0.45)',
    ghost:     'rgba(38,38,38,0.15)',
    rule:      'rgba(38,38,38,0.14)',
    accent:    '#34568a',
    accentSoft:'#5b7fb0',
    accentDim: 'rgba(52,86,138,0.34)',
    accentWash:'rgba(52,86,138,0.06)',
    ionoEdge:  'rgba(52,86,138,0.30)',
    gold:      '#8a6a1f',
    goldDim:   'rgba(138,106,31,0.34)',
    brick:     'rgba(150,74,70,0.85)',
    brickSoft: 'rgba(150,74,70,0.26)',
    plate:     'rgba(255,255,255,0.80)',
    night:     '#dfe4ea',
    strata:    'rgba(38,38,38,0.05)',
    ionoWashA: 'rgba(52,86,138,0.05)',
    ionoWashB: 'rgba(52,86,138,0.16)',
    frontGlow: 'rgba(52,86,138,0.16)',
    frontLive: 'rgba(52,86,138,0.55)',
    dayGlowA:  'rgba(52,86,138,0.42)',
    dayGlowB:  'rgba(52,86,138,0.16)',
    dayGlowC:  'rgba(52,86,138,0)',
    limb:      'rgba(52,86,138,0.50)',
    brickRGB:  '150,74,70'
  };

  /* the palette THIS frame is drawn in, set once per draw by paletteFor() */
  var COL = COL_D;

  /* The page's own helper, by the page's own name (observatory.js
     effectiveTheme), guarded for a node context where there is no document.
     An injected `state.theme` wins, so a test never has to build a DOM. */
  function effectiveTheme(st) {
    var t = st && st.theme;
    if (t === 'light' || t === 'dark') return t;
    var d = global.document, el = d && d.documentElement;
    var a = el && typeof el.getAttribute === 'function' ? el.getAttribute('data-theme') : null;
    if (a === 'light' || a === 'dark') return a;
    if (typeof global.matchMedia === 'function') {
      try {
        if (global.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
      } catch (e) { /* a stub matchMedia is not a reason to fail a draw */ }
    }
    return 'dark';
  }
  function paletteFor(theme) { return theme === 'light' ? COL_L : COL_D; }

  var FONT_STACK = '"Source Sans 3", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

  /* ======================================================================
     tiny helpers
     ====================================================================== */
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /* font cache: weightIndex * 64 + px, so a warm cache allocates nothing */
  var FCACHE = new Array(160);
  function fontOf(px, weight) {
    px = Math.round(clamp(num(px, 10), 5, 58));
    var wi = weight === 600 ? 1 : 0;
    var k = wi * 64 + px;
    var f = FCACHE[k];
    if (!f) { f = (wi ? '600 ' : '400 ') + px + 'px ' + FONT_STACK; FCACHE[k] = f; }
    return f;
  }

  /* group thousands without toLocaleString (locale independent output) */
  function group(n) {
    n = Math.round(n);
    if (n < 1000) return '' + n;
    var s = '' + n, out = '', c = 0, i;
    for (i = s.length - 1; i >= 0; i--) {
      out = s.charAt(i) + out;
      if (++c === 3 && i > 0) { out = ',' + out; c = 0; }
    }
    return out;
  }

  function fmtKm(km) {
    km = num(km, 0);
    if (km < 10) return (Math.round(km * 10) / 10) + ' km';
    return group(km) + ' km';
  }

  /* r19i (14): the live P and S distances round the way the narration one row
     above the tile rounds them, to the nearest 10 km, so a reader is never
     shown 19,810 km in the sentence and 19,819 km on the drawing for the same
     front. The scale bar keeps fmtKm: its lengths come off a ladder of round
     numbers already. */
  function fmtKm10(km) {
    return group(Math.round(num(km, 0) / 10) * 10) + ' km';
  }

  /* r19i (10): the stopwatch's arming magnitude the way a reader writes it,
     M5.5 or M5, never M5.50. An absent or impossible threshold returns '' and
     the strip keeps the sentence it had. */
  function magWord(v) {
    var m = num(v, NaN);
    if (!isFinite(m) || m <= 0) return '';
    var r = Math.round(m * 10) / 10;
    return (r === Math.round(r)) ? ('' + Math.round(r)) : r.toFixed(1);
  }

  function two(n) { return n < 10 ? '0' + n : '' + n; }

  /* mm:ss below an hour, h:mm:ss above it */
  function clock(ms) {
    var s = Math.floor(clamp(num(ms, 0), 0, 359999999) / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return h > 0 ? (h + ':' + two(m) + ':' + two(ss)) : (two(m) + ':' + two(ss));
  }

  /* spoken duration: "45 s", "4 min 12 s", "1 h 5 min" */
  function durWords(ms) {
    var s = Math.round(clamp(num(ms, 0), 0, 359999999) / 1000);
    if (s < 60) return s + ' s';
    if (s < 3600) {
      var m = Math.floor(s / 60), r = s % 60;
      return r ? (m + ' min ' + r + ' s') : (m + ' min');
    }
    var h = Math.floor(s / 3600), mm = Math.round((s % 3600) / 60);
    if (mm === 60) { h++; mm = 0; }
    return mm ? (h + ' h ' + mm + ' min') : (h + ' h');
  }

  /* "15 s ago" / "3 min ago" / "1 h 5 min ago" */
  function agoWords(ms) {
    ms = num(ms, NaN);
    if (!isFinite(ms) || ms < 0) return '';
    if (ms < 45000) return Math.max(1, Math.round(ms / 1000)) + ' s ago';
    return durWords(ms) + ' ago';
  }

  /* ======================================================================
     PURE: the quake half
     ====================================================================== */

  /* how far a front of the given speed has travelled, capped at the
     antipode so the label can never claim more than a planet */
  function frontKm(elapsedMs, speedKmS) {
    var e = num(elapsedMs, 0), v = num(speedKmS, 0);
    if (e <= 0 || v <= 0) return 0;
    return clamp((e / 1000) * v, 0, C.SURFACE_HALF_KM);
  }

  /* the drawn half width in km: the smallest ladder rung that keeps the P
     front inside SPAN_FILL of it, so the fronts visibly expand inside a
     rung and the scale label steps rather than sliding */
  function spanKm(pKm) {
    var need = num(pKm, 0) / C.SPAN_FILL, L = C.SPAN_LADDER_KM, i;
    for (i = 0; i < L.length; i++) if (L[i] >= need) return L[i];
    return L[L.length - 1];
  }

  function kmToPx(km, span, halfPx) {
    var s = num(span, 0);
    if (!(s > 0)) return 0;
    return clamp(num(km, 0), 0, C.SURFACE_HALF_KM) * (num(halfPx, 0) / s);
  }

  /* the expected coseismic ionospheric window: before it opens, while it is
     open, after it has passed. frac is the rise toward the ionosphere before
     8 min, then the horizontal spread across the 8 to 15 min window. */
  function acoustic(elapsedMs, out) {
    out = out || ACO;
    var e = clamp(num(elapsedMs, 0), 0, 1e12);
    var o = C.ACOUSTIC_OPEN_MS, c = C.ACOUSTIC_CLOSE_MS;
    if (e < o) { out.phase = 'before'; out.rise = o > 0 ? e / o : 1; out.spread = 0; }
    else if (e < c) { out.phase = 'open'; out.rise = 1; out.spread = (e - o) / Math.max(1, c - o); }
    else { out.phase = 'passed'; out.rise = 1; out.spread = 1; }
    out.dueInMs = Math.max(0, o - e);
    return out;
  }
  var ACO = { phase: 'before', rise: 0, spread: 0, dueInMs: 0 };

  /* the stopwatch axis span: smallest rung that holds both the running
     clock and the landed edit */
  function timelineSpanMs(elapsedMs, editMs) {
    var need = Math.max(num(elapsedMs, 0), num(editMs, 0)) / C.TIMELINE_FILL;
    var L = C.TIMELINE_LADDER_MS, i;
    for (i = 0; i < L.length; i++) if (L[i] >= need) return L[i];
    return L[L.length - 1];
  }

  function quakeWord(mag) {
    var m = num(mag, NaN), i;
    if (!isFinite(m)) return '';
    for (i = 0; i < QUAKE_WORDS.length; i++) if (m >= QUAKE_WORDS[i][0]) return QUAKE_WORDS[i][1];
    return '';
  }

  /* ======================================================================
     PURE: the flare half
     ====================================================================== */

  /* GOES 0.1-0.8 nm flux in W/m2 to a class string, null below C1 */
  function classOf(flux) {
    var f = num(flux, NaN);
    if (!isFinite(f) || f < 1e-6) return null;
    var letter, base;
    if (f >= 1e-4) { letter = 'X'; base = 1e-4; }
    else if (f >= 1e-5) { letter = 'M'; base = 1e-5; }
    else { letter = 'C'; base = 1e-6; }
    var n = f / base;
    return letter + (n >= 10 ? Math.round(n) : (Math.round(n * 10) / 10));
  }

  /* the class string this state is about: an explicit cls wins, else flux */
  function classText(st) {
    if (!st) return null;
    if (typeof st.cls === 'string' && /^[A-Z]\d/.test(st.cls)) return st.cls;
    return classOf(st.flux);
  }

  /* r19r item 8: the same one ladder the rest of the page reads, lowercase
     because the header builds a noun phrase out of it ("Minor solar flare in
     progress"). ObsInstruments.PURE.FLARE_LADDER is the authority whenever the
     module is on the page; the rungs below are the SAME table for the case it
     is not, and a node test holds the two to each other. C carries no
     adjective now: it is the background an active sun sits at for hours, not a
     flare anything ranks. */
  function flareWord(cls) {
    if (typeof cls !== 'string' || !cls) return '';
    var I = global.ObsInstruments;
    if (I && I.PURE && typeof I.PURE.flareSeverity === 'function') {
      return I.PURE.flareSeverity(cls).toLowerCase();
    }
    var L = cls.charAt(0).toUpperCase(), n = parseFloat(cls.slice(1));
    if (!isFinite(n) || n <= 0) n = 1;
    if (L === 'X') return n >= 10 ? 'severe' : 'strong';
    if (L === 'M') return n >= 5 ? 'moderate' : 'minor';
    return '';
  }

  function bloomStrength(mhz) {
    return clamp(num(mhz, 0) / C.BLOOM_FULL_MHZ, 0, 1);
  }

  /* What a lane says when nothing is watching it. The quake diagram already set
     this rule for its ionosphere label (see the header): a lane with no instrument
     behind it describes the physics, it never reports a measurement. */
  var NOT_WATCHED = 'not monitored in this build';

  /* the three pipeline lanes. Copy is pinned by spec section 7 plus the r6 honesty
     ruling: light "arrived with detection"; particles "not detected" only when the
     caller declares protonMonitored, otherwise NOT_WATCHED; CME "watching" only
     when the caller declares cmeMonitored, otherwise NOT_WATCHED. */
  var LANES = [
    { key: 'light', label: '', short: '', travel: '', travelShort: '', status: '', statusShort: '', prog: 0, on: false },
    { key: 'particles', label: '', short: '', travel: '', travelShort: '', status: '', statusShort: '', prog: 0, on: false },
    { key: 'cme', label: '', short: '', travel: '', travelShort: '', status: '', statusShort: '', prog: 0, on: false }
  ];

  /* r19f (2): the shorter honest form of a lane's state, for a lane too narrow
     to hold the full one. Never a different claim, only fewer words: the long
     form is used whenever it fits, and a lane that holds neither says nothing
     rather than printing over its own label. */
  var NOT_WATCHED_SHORT = 'not monitored';

  function laneState(st, out) {
    out = out || LANES;
    st = st || {};
    var cls = classText(st);
    var flaring = !!cls;
    var now = num(st.now, NaN), t0 = num(st.t0, NaN);

    var a = out[0];
    a.label = 'Light and X-rays'; a.short = 'Light';
    a.travel = '8 min 20 s'; a.travelShort = '8m20s';
    a.on = flaring;
    a.status = flaring ? 'arrived with detection' : 'nothing detected';
    a.statusShort = flaring ? 'arrived' : 'nothing detected';
    a.prog = flaring ? 1 : 0;

    var p = st.proton, b = out[1];
    b.label = 'Energetic particles'; b.short = 'Particles';
    b.travel = 'tens of minutes'; b.travelShort = 'tens of min';
    var pOn = !!p, pLevel = (p && typeof p === 'object' && typeof p.level === 'string') ? p.level : '';
    var pAt = (p && typeof p === 'object') ? num(p.at, NaN) : NaN;
    if (pOn && isFinite(pAt) && isFinite(now) && isFinite(t0) && pAt > t0 && now < pAt) {
      b.on = true;
      b.prog = clamp((now - t0) / (pAt - t0), 0, 1);
      b.status = pLevel ? (pLevel + ' expected') : 'on the way';
      b.statusShort = b.status;
    } else if (pOn) {
      b.on = true; b.prog = 1;
      b.status = pLevel ? (pLevel + ' in progress') : 'detected';
      b.statusShort = pLevel || b.status;
    } else {
      /* "Not detected" is a measurement result, and it may only be printed when
         something is actually measuring. Act 1 has no proton feed, so the caller
         leaves protonMonitored off and the lane says what is true instead. */
      b.on = false; b.prog = 0;
      b.status = st.protonMonitored ? 'not detected' : NOT_WATCHED;
      b.statusShort = st.protonMonitored ? 'not detected' : NOT_WATCHED_SHORT;
    }

    var s = st.shock, c2 = out[2];
    c2.label = 'Coronal mass ejection'; c2.short = 'CME';
    c2.travel = '1 to 3 days, if Earth directed'; c2.travelShort = '1 to 3 days';
    var sOn = !!s;
    var sAt = (s && typeof s === 'object') ? num(s.at, NaN) : NaN;
    if (sOn && isFinite(sAt) && isFinite(now) && now < sAt) {
      c2.on = true;
      var eta = sAt - now;
      c2.prog = (isFinite(t0) && sAt > t0) ? clamp((now - t0) / (sAt - t0), 0, 1) : 0.5;
      c2.status = 'shock expected in ' + durWords(eta);
      c2.statusShort = 'shock in ' + durWords(eta);
    } else if (sOn) {
      c2.on = true; c2.prog = 1; c2.status = 'shock arrived';
      c2.statusShort = c2.status;
    } else {
      /* Same rule: "watching" claims an eye on it. Act 1 has no CME producer. */
      c2.on = false; c2.prog = 0;
      c2.status = st.cmeMonitored ? 'watching' : NOT_WATCHED;
      c2.statusShort = st.cmeMonitored ? 'watching' : NOT_WATCHED_SHORT;
    }
    return out;
  }

  /* ======================================================================
     r19t (7) ONE CLOCK PER SUBJECT, and the subject key

     Two judges caught the same class of defect from opposite ends. A light
     frame (r19s light-21/22) had the plate printing "13:22 since the quake"
     and this tile printing "13:21 since the quake" ten pixels below it, plus
     "Watching for the first Wikipedia edit" twice with two different seconds.
     A dark frame (dark-11/dark-13) had a strip frozen at 10:06 under a
     headline reading 12:10, and then that frozen strip rode into an unrelated
     Flood in Nepal card carrying an Alaska earthquake.

     The cause of the first is that the tile DERIVED its own age from
     `now - t0` at its own redraw moment while the plate derived the same age
     at its own, so the two disagreed for most of every second. The cause of
     the second is that nothing tied a painted tile to the subject it was
     painted for.

     So this file no longer owns the age. The director publishes ONE clock per
     subject and every surface reads it:

       state.subjectClock = { sid, sinceMs, text }

     `text` is the clock exactly as the plate prints it, and it is drawn
     VERBATIM whenever it has a clock's shape, so the two surfaces cannot
     disagree by a rounding or a format. `sinceMs` is the age the drawing is
     laid out from, so the picture and the number are the same moment. The
     field is the authority; `state.elapsedMs` and `now - t0` remain, in that
     order, as the honest failure direction for a caller that has not been
     wired yet, and `LAST.clockSrc` says which of the three ran so a test never
     has to guess.

     This file still reads NO wall clock. The standing source scan in
     t-diagrams.js forbids every wall clock call by name, and it must keep
     answering true: a tile that timed itself is exactly the defect above.

     The key: a tile is keyed by the subject id it was painted for. `tileSid`
     is the payload's own subject, `curSid` is the subject the director is on
     right now, and a tile whose sid is not the current one REFUSES to mount:
     the canvas is cleared, the stamp is dropped, and the draw returns null so
     the caller can hide the slot instead of framing last subject's picture.
     Missing ids mean no claim either way, so the frame is unchanged.
     ====================================================================== */

  /* mm:ss or h:mm:ss and nothing else. A director that hands over a sentence
     is not printed into a clock slot; its sinceMs is used instead, so the
     VALUE still comes from the director either way. */
  function clockShape(sTxt) {
    if (typeof sTxt !== 'string' || !sTxt) return false;
    var i, c, seg = 0, len = 0, n = sTxt.length;
    if (n > 12) return false;
    for (i = 0; i < n; i++) {
      c = sTxt.charAt(i);
      if (c === ':') {
        if (len < 1 || len > 2) return false;
        if (seg > 0 && len !== 2) return false;
        seg++; len = 0;
        if (seg > 2) return false;
      } else if (c >= '0' && c <= '9') {
        len++;
        if (len > 2) return false;
      } else return false;
    }
    return seg >= 1 && len === 2;
  }

  /* module scratch, like every other ledger here: read it, never keep it */
  var CLK = { sid: '', sinceMs: NaN, text: '', src: '' };

  /* The director as this file may see it: an injected `state.director` first,
     then the global module, and only for a `subjectClock` function it exposes.
     Nothing else on it is read, and a throw is swallowed: a director that
     cannot answer must not be able to kill a draw. */
  function dirClock(st, nowMs) {
    var d = (st && st.director) || global.ObsAutopilot || null;
    var f = d && typeof d.subjectClock === 'function' ? d.subjectClock : null;
    if (!f && d && d.PURE && typeof d.PURE.subjectClock === 'function') f = d.PURE.subjectClock;
    if (!f) return null;
    try {
      var o = f.call(d, nowMs);
      return (o && typeof o === 'object') ? o : null;
    } catch (e) { return null; }
  }

  /* Resolve the one clock for this frame into CLK. `fallbackMs` is what the
     old arithmetic would have produced, which is what a not yet wired caller
     still gets. */
  function resolveClock(st, fallbackMs, dirField) {
    var f = (st && st.subjectClock && typeof st.subjectClock === 'object') ? st.subjectClock : null;
    var src = 'field';
    if (!f && dirField && typeof dirField === 'object') { f = dirField; src = 'director'; }
    if (!f) src = 'derived';
    var gotMs = f ? num(f.sinceMs, NaN) : NaN;
    var gotTxt = (f && typeof f.text === 'string' && clockShape(f.text)) ? f.text : '';
    var sid = (f && typeof f.sid === 'string') ? f.sid : '';
    /* THE DIRECTOR MAY SAY THERE IS NO CLOCK, and that is an answer, not a
       gap. Its law: "an age is only a clock where the moment it counts from
       is known and already past", and it answers sinceMs NaN with text '' for
       every other case, never 00:00, because a zero would be a measurement
       this page does not have. A director that answered FOR THIS SUBJECT (it
       named one) and refused the clock is obeyed: the tile prints no clock
       either, rather than deriving one the plate is refusing to print. A
       field with no sid at all told us nothing, so the old arithmetic stands
       as the honest failure direction for a caller not yet wired. */
    var refused = !!(f && sid && !isNum(gotMs) && !gotTxt);
    if (f && !sid && !isNum(gotMs) && !gotTxt) src = 'derived';
    if (refused) {
      CLK.sid = sid; CLK.sinceMs = NaN; CLK.text = ''; CLK.src = 'refused';
      return CLK;
    }
    var ms = isNum(gotMs) ? Math.max(0, gotMs)
           : (isNum(fallbackMs) ? Math.max(0, fallbackMs) : NaN);
    var txt = gotTxt || clock(isNum(ms) ? ms : 0);
    CLK.sid = sid;
    CLK.sinceMs = ms;
    CLK.text = txt;
    CLK.src = src;
    return CLK;
  }

  /* THE INTERIM PATH, and it is written down because it is a weaker claim
     than the pinned one. While the director has no `subjectClock` yet, the
     subject the page is CURRENTLY on is read from `ObsAutopilot.state(now)`:
     its `evt.id` is the same string `subjectIdOf` tags every rail emission
     with. An injected `state.curSid` wins over it, a director that throws or
     answers nothing gives '', and no id is ever built out of what an event
     looks like. `LAST.sidSrc` says which of the two the frame's own sid came
     from, so a reader of the ledger never mistakes the interim for the pin. */
  function dirSubjectId(st, nowMs) {
    if (st && typeof st.curSid === 'string' && st.curSid) return st.curSid;
    var d = (st && st.director) || global.ObsAutopilot || null;
    if (!d || typeof d.state !== 'function') return '';
    try {
      var s = d.state(nowMs);
      var e = s && s.evt;
      return (e && e.id != null) ? String(e.id) : '';
    } catch (e2) { return ''; }
  }

  /* the subject a payload belongs to. `sid` is the r19t name; `subjectId` is
     the vocabulary the director already uses everywhere else, and both are
     accepted so neither side has to rename anything to be honest. */
  function tileSid(st) {
    if (!st) return '';
    if (typeof st.sid === 'string' && st.sid) return st.sid;
    if (typeof st.subjectId === 'string' && st.subjectId) return st.subjectId;
    return '';
  }

  /* The rail tags the row it prints WHILE FLYING to a stop with the stop's id
     behind a prefix, so "Heading to" cannot print over the stop itself. The
     director's own words for it: "The subject is recoverable (hopSubjectId),
     so a row on a hop plate is still provably about the stop being flown to."
     So `hop|X` and `X` name ONE subject here, and a tile refused during a hop
     would be a tile refused for the subject it is actually about. The prefix
     is obs-autopilot.js's `RAIL_HOP_ID`; it is not exported, so it is written
     down once here and a node assertion reads the other file to prove the two
     have not drifted. */
  var HOP_PREFIX = 'hop|';
  function bareSid(sid) {
    var s2 = (typeof sid === 'string') ? sid : '';
    return s2.indexOf(HOP_PREFIX) === 0 ? s2.slice(HOP_PREFIX.length) : s2;
  }

  /* A claim is only made where both ids exist. Two known ids that differ mean
     this tile is about a subject the page has left, and that is the one case
     that must not be drawn. */
  function mountable(tile, cur) {
    if (!tile || !cur) return true;
    return bareSid(tile) === bareSid(cur);
  }

  /* ======================================================================
     canvas plumbing
     ====================================================================== */

  /* Size the backing store for the device pixel ratio.
     A canvas with no CSS size takes its LAYOUT size from the width
     attribute, so writing the scaled size back would grow the element every
     frame. The guard below pins the CSS box exactly once, and only for that
     case: a canvas whose size comes from CSS (width: 100% and friends) does
     not move when the attribute changes, so it is left alone and stays
     responsive. */
  function fit(cv, st) {
    var dpr = clamp(num(st && st.dpr, num(global.devicePixelRatio, 1)), 0.5, C.MAX_DPR);
    var cssW = num(st && st.w, 0), cssH = num(st && st.h, 0);
    if (!(cssW > 0)) cssW = num(cv.clientWidth, 0) || num(cv.__obsW, 0) || num(cv.width, 220);
    if (!(cssH > 0)) cssH = num(cv.clientHeight, 0) || num(cv.__obsH, 0) || num(cv.height, 140);
    cssW = clamp(Math.round(cssW), 120, 4000);
    cssH = clamp(Math.round(cssH), 80, 4000);
    cv.__obsW = cssW; cv.__obsH = cssH;
    var bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
    if (cv.width !== bw || cv.height !== bh) {
      cv.width = bw; cv.height = bh;
      if (!cv.__obsPinned && cv.style && cv.clientWidth && Math.abs(cv.clientWidth - cssW) > 0.5) {
        cv.style.width = cssW + 'px';
        cv.style.height = cssH + 'px';
        cv.__obsPinned = 1;
      }
    }
    var g = cv.getContext('2d');
    if (!g) return null;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.textBaseline = 'alphabetic';
    g.lineJoin = 'round';
    g.lineCap = 'round';
    LAY.w = cssW; LAY.h = cssH; LAY.dpr = dpr; LAY.g = g;
    return g;
  }

  var LAY = { w: 0, h: 0, dpr: 1, g: null, s: 1, pad: 6, head: 16, headPx: 11, bodyPx: 9, tinyPx: 8 };

  function metrics() {
    var W = LAY.w, H = LAY.h;
    var s = clamp((W + H * 1.4) / (300 + 140 * 1.4), 0.85, 1.5);
    LAY.s = s;
    LAY.pad = clamp(Math.round(Math.min(W, H) * 0.05), 5, 13);
    LAY.headPx = clamp(Math.round(12.5 * s), 10, 17);
    LAY.bodyPx = clamp(Math.round(10.5 * s), 9, 14);
    LAY.tinyPx = clamp(Math.round(9 * s), 8, 12);
    LAY.head = LAY.headPx + Math.round(4 * s);
    LAY.gap = clamp(Math.round(4 * s), 3, 7);
    LAY.wide = W >= 340;
    LAY.tall = H >= 200;
  }

  /* ======================================================================
     the box ledger (r19f (2))

     Every string this file draws goes in, in CSS pixels, tagged with the
     band it belongs to. The band rects go in beside them, so a test never
     has to reconstruct the layout to know where a label was allowed to be.

     The line box is the pinned convention: ascent 0.80 of the font size
     above the baseline, descent 0.20 below it. That is a little taller than
     the ink of most strings, which is the safe direction for a containment
     test. The boxes are pooled, so a warm ledger allocates nothing.
     ====================================================================== */
  var BOX_ASC = 0.80, BOX_DESC = 0.20;
  var BAND_KEYS = ['head', 'cross', 'strip', 'pipe', 'bloom'];
  var BANDS = {
    head:  { x: 0, y: 0, w: 0, h: 0, on: false },
    cross: { x: 0, y: 0, w: 0, h: 0, on: false },
    strip: { x: 0, y: 0, w: 0, h: 0, on: false },
    pipe:  { x: 0, y: 0, w: 0, h: 0, on: false },
    bloom: { x: 0, y: 0, w: 0, h: 0, on: false }
  };
  var POOL = [], nBox = 0, curBand = '';

  function ledgerReset() {
    nBox = 0; curBand = '';
    for (var i = 0; i < BAND_KEYS.length; i++) BANDS[BAND_KEYS[i]].on = false;
  }

  /* open a band and make it the one the next boxes belong to */
  function band(key, x, y, w, h) {
    var b = BANDS[key];
    b.x = x; b.y = y; b.w = w; b.h = h; b.on = true;
    curBand = key;
    return b;
  }

  function noteBox(x, y, w, h, s) {
    var b = POOL[nBox];
    if (!b) { b = { x: 0, y: 0, w: 0, h: 0, text: '', band: '' }; POOL[nBox] = b; }
    b.x = x; b.y = y; b.w = w; b.h = h; b.text = s; b.band = curBand;
    nBox++;
  }

  function ledgerPublish() {
    var a = LAST.boxes, i;
    for (i = 0; i < nBox; i++) a[i] = POOL[i];
    a.length = nBox;
    LAST.bands = BANDS;
  }

  function txt(g, s, x, y, px, weight, color, align) {
    if (!s) return;
    g.font = fontOf(px, weight);
    g.fillStyle = color;
    g.textAlign = align || 'left';
    g.fillText(s, x, y);
    var w = g.measureText(s).width;
    noteBox(align === 'right' ? x - w : (align === 'center' ? x - w / 2 : x),
            y - px * BOX_ASC, w, px * (BOX_ASC + BOX_DESC), s);
  }

  /* longest candidate that fits, '' when even the shortest does not */
  function pick(g, cands, n, maxW, px, weight) {
    g.font = fontOf(px, weight);
    for (var i = 0; i < n; i++) {
      var s = cands[i];
      if (s && g.measureText(s).width <= maxW) return s;
    }
    return '';
  }
  var CAND = ['', '', '', '', ''];

  /* r19g (16): the rail prints its own headline one row above the tile, so a
     header that repeats it character for character tells the reader nothing
     it does not already have. Character identical after trimming the ends,
     and nothing looser: a tile that decided two differently worded strings
     were the same sentence would start hiding repeats instead of showing
     them. `state.echoTitle` is the rail headline; absent, nothing is skipped. */
  function echoesTitle(cand, echo) {
    if (typeof cand !== 'string' || typeof echo !== 'string') return false;
    var a = cand.trim(), b = echo.trim();
    return !!a && a === b;
  }

  /* the header ladder: the longest candidate that fits and does not echo the
     rail. The floor rung always stands, echo or not, because a header that
     says the word again beats a tile with no header at all. HEAD is module
     scratch for the tests (LAST.headText / headEcho / headSkipped). */
  var HEAD = { text: '', echo: '', skipped: 0 };
  function pickHead(g, cands, n, maxW, px, weight, echo) {
    var ec = (typeof echo === 'string') ? echo : '';
    HEAD.text = ''; HEAD.echo = ec; HEAD.skipped = 0;
    g.font = fontOf(px, weight);
    for (var i = 0; i < n; i++) {
      var s = cands[i];
      if (!s) continue;
      if (i < n - 1 && echoesTitle(s, ec)) { HEAD.skipped++; continue; }
      if (g.measureText(s).width <= maxW) { HEAD.text = s; return s; }
    }
    return '';
  }

  function widthOf(g, s, px, weight) {
    if (!s) return 0;
    g.font = fontOf(px, weight);
    return g.measureText(s).width;
  }

  function roundRect(g, x, y, w, h, r) {
    r = clamp(num(r, 0), 0, Math.min(w, h) / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y);
    g.arcTo(x + w, y, x + w, y + r, r);
    g.lineTo(x + w, y + h - r);
    g.arcTo(x + w, y + h, x + w - r, y + h, r);
    g.lineTo(x + r, y + h);
    g.arcTo(x, y + h, x, y + h - r, r);
    g.lineTo(x, y + r);
    g.arcTo(x, y, x + r, y, r);
    g.closePath();
  }

  /* a plate keeps small text legible where it crosses the wave field */
  function plate(g, x, y, w, h) {
    if (!(w > 0) || !(h > 0)) return;
    roundRect(g, x, y, w, h, Math.min(3, h / 2));
    g.fillStyle = COL.plate;
    g.fill();
  }

  /* a plate and the text on it are ONE box in the ledger: that is what a
     reader sees, and counting them apart would report every label as
     overlapping its own backing */
  function platedTxt(g, s, tx, base, px, weight, color, align, x, y, w, h) {
    plate(g, x, y, w, h);
    g.font = fontOf(px, weight);
    g.fillStyle = color;
    g.textAlign = align || 'left';
    g.fillText(s, tx, base);
    noteBox(x, y, w, h, s);
  }

  function line(g, x0, y0, x1, y1, color, wpx) {
    if (!isNum(x0) || !isNum(y0) || !isNum(x1) || !isNum(y1)) return;
    g.beginPath();
    g.moveTo(x0, y0); g.lineTo(x1, y1);
    g.strokeStyle = color; g.lineWidth = num(wpx, 1);
    g.stroke();
  }

  var DASH_2 = [2, 3], DASH_3 = [3, 4], DASH_NONE = [];
  function dash(g, arr) { if (g.setLineDash) g.setLineDash(arr || DASH_NONE); }

  /* unit five point star, module scratch */
  var STAR = (function () {
    var a = [], i, ang, r;
    for (i = 0; i < 10; i++) {
      ang = -Math.PI / 2 + i * Math.PI / 5;
      r = (i % 2 === 0) ? 1 : 0.42;
      a.push(Math.cos(ang) * r, Math.sin(ang) * r);
    }
    return a;
  })();

  function star(g, cx, cy, r, fill, edge) {
    if (!isNum(cx) || !isNum(cy) || !(r > 0)) return;
    g.beginPath();
    for (var i = 0; i < 10; i++) {
      var x = cx + STAR[i * 2] * r, y = cy + STAR[i * 2 + 1] * r;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
    if (edge) { g.strokeStyle = edge; g.lineWidth = 1.6; g.stroke(); }
    g.fillStyle = fill; g.fill();
  }

  /* gradient slots: rebuilt only when their inputs change. The two planets
     on the flare diagram get their own slots so a pair of different radii
     cannot thrash one cache twice a frame. */
  var GR = {
    iono: { k: 0, g: null }, sun: { k: 0, g: null },
    dayA: { k: 0, g: null }, bloomA: { k: 0, g: null },
    dayB: { k: 0, g: null }, bloomB: { k: 0, g: null }
  };
  function slotKey(a, b, c2) { return Math.round(a * 8) * 1000003 + Math.round(b * 64) * 1009 + Math.round(c2 * 100); }

  /* r19t (7): the palette is an INPUT to every gradient in GR now, and the
     geometry key cannot see it. So a palette change drops all six slots at the
     top of the frame that changes it. Without this a theme flip repainted the
     tile with the ink cached under the other theme, which is the stale picture
     defect this round is about, one layer down. */
  function dropGradients() {
    GR.iono.k = 0; GR.iono.g = null;
    GR.sun.k = 0; GR.sun.g = null; GR.sun.corona = null;
    GR.dayA.k = 0; GR.dayA.g = null; GR.bloomA.k = 0; GR.bloomA.g = null;
    GR.dayB.k = 0; GR.dayB.g = null; GR.bloomB.k = 0; GR.bloomB.g = null;
  }

  /* ======================================================================
     the quake diagram
     ====================================================================== */

  var QS = { ex: 0, crustY: 0, hypoY: 0, span: 0, pxPerKm: 0, pKm: 0, sKm: 0 };

  /* r19t (7): the palette, the one clock and the subject key, resolved once
     per frame before anything is painted. Returns false when this tile is
     about a subject the page has left, and the caller then paints nothing. */
  function openFrame(g, st, kind, fallbackMs) {
    var pal = paletteFor(effectiveTheme(st));
    if (pal !== COL) { COL = pal; dropGradients(); }
    LAST.theme = (COL === COL_L) ? 'light' : 'dark';
    var nowMs = num(st.now, NaN);
    resolveClock(st, fallbackMs, dirClock(st, nowMs));
    var mine = tileSid(st), cur = CLK.sid || dirSubjectId(st, nowMs);
    /* A payload with no id of its own is stamped with the subject that was
       current when these pixels were painted. That is not a second opinion
       about what the tile is about, so it can never disagree with `cur` and
       never refuses a frame; what it buys is a stamp that goes STALE the
       moment the page moves on, which is the frozen strip a judge watched
       ride into the next card. */
    LAST.sidSrc = mine ? 'payload' : (cur ? 'director' : '');
    if (!mine) mine = cur;
    /* the stamp names the SUBJECT, never the row the rail happens to be
       printing about it, so a hop and its arrival stamp the same string */
    mine = bareSid(mine);
    LAST.sid = mine; LAST.curSid = cur; LAST.clockSrc = CLK.src;
    if (mountable(mine, cur)) { LAST.refused = false; return true; }
    /* the whole point: last subject's picture never rides into this card */
    g.clearRect(0, 0, LAY.w, LAY.h);
    stampSid(g, '');
    LAST.refused = true; LAST.kind = ''; LAST.clockText = ''; LAST.sinceText = '';
    LAST.swText = ''; LAST.swPx = 0; LAST.elapsedMs = 0;
    /* the ledger is what a test reads for what a reader can see, so a frame
       that drew nothing publishes nothing. Leaving the last frame's boxes
       standing is the same lie one layer down. */
    ledgerPublish();
    return false;
  }

  /* the sid the pixels ON this canvas belong to, so the page can ask a mounted
     tile what it is showing instead of trusting that it was cleared */
  function stampSid(g, sid) {
    var cv = g && g.canvas;
    if (cv) cv.__obsSid = sid || '';
  }

  function quake(canvas, state) {
    var st = state || {};
    var g = fit(canvas, st);
    if (!g) return LAST;
    metrics();
    ledgerReset();
    var W = LAY.w, H = LAY.h, pad = LAY.pad, gap = LAY.gap;
    var reduced = !!st.reduced;

    var now = num(st.now, NaN), t0 = num(st.t0, NaN);
    var derived = isNum(st.elapsedMs) ? Math.max(0, st.elapsedMs)
                : ((isFinite(now) && isFinite(t0)) ? Math.max(0, now - t0) : 0);
    /* r19t (7): the director's clock outranks both, so the picture and the
       number are the same moment the plate is printing one row above. */
    if (!openFrame(g, st, 'quake', derived)) return null;
    var elapsed = isNum(CLK.sinceMs) ? CLK.sinceMs : derived;
    stampSid(g, LAST.sid);

    g.clearRect(0, 0, W, H);
    g.fillStyle = COL.bg;
    g.fillRect(0, 0, W, H);

    var x0 = pad, innerW = W - pad * 2;
    var contentY = pad + LAY.head + gap;
    var contentH = H - contentY - pad;
    /* a short tile drops the stopwatch title row, which buys the
       cross section the height it needs to read as a cross section */
    var swCompact = contentH < 130;
    var stopH = swCompact ? clamp(contentH * 0.28, 26, 42) : clamp(contentH * 0.34, 34, 64);
    var crossH = Math.max(30, contentH - stopH - gap);
    /* r19f (2): the cross section's floor can ask for more than the content
       box has. That is fine while both blocks stay on the canvas; past the
       canvas edge the strip takes what is left, and below a strip worth
       drawing there is no strip at all. Nothing is ever drawn off the tile. */
    var swY = contentY + crossH + gap;
    if (swY + stopH > H) stopH = H - swY;
    var hasStrip = stopH >= 16;

    /* ---------------- header ---------------- */
    band('head', x0, pad, innerW, LAY.head);
    var mag = num(st.mag, NaN);
    var word = quakeWord(mag);
    var place = (typeof st.place === 'string' && st.place) ? st.place : '';
    var magTxt = isFinite(mag) ? (Math.round(mag * 10) / 10).toFixed(1) : '';
    /* r19t (7): a clock is drawn only where the director published one. Its
       own text is the string; an empty one is a refusal, not a gap to fill. */
    var clockTxt = (elapsed > 0 && CLK.text) ? CLK.text : '';
    var clockW = clockTxt ? widthOf(g, clockTxt, LAY.bodyPx, 400) + 8 : 0;
    var headBase = pad + LAY.headPx;

    /* where it happened outranks the severity word once space is tight, and
       r19g (16): a rung that repeats the rail headline standing one row above
       the tile is skipped, so the reader gets a second fact instead of the
       same one twice. The floor rung stands either way. */
    var noun = word ? (word.charAt(0).toUpperCase() + word.slice(1) + ' earthquake') : 'Earthquake';
    var n = 0;
    if (magTxt && place) CAND[n++] = noun + ' · magnitude ' + magTxt + ' · ' + place;
    if (magTxt && place) CAND[n++] = 'M' + magTxt + ' · ' + place;
    if (magTxt) CAND[n++] = noun + ' · magnitude ' + magTxt;
    if (magTxt) CAND[n++] = 'M' + magTxt;
    CAND[n++] = 'Earthquake';

    /* r19i (10): a bare running clock over a strip saying the stopwatch is
       not armed reads as running and not running at once, so the clock says
       which clock it is. The named form rides in the header wherever the
       header still has a rung to stand beside it; otherwise the bare clock
       stays here and the tiny row under it carries the words. A clock neither
       form can name is not drawn at all: an unnamed number IS the defect. */
    var sinceTxt = '';
    var sinceW = clockTxt ? widthOf(g, SINCE_TINY, LAY.tinyPx, 400) : 0;
    if (clockTxt) {
      var longTxt = clockTxt + SINCE_HEAD;
      var longW = widthOf(g, longTxt, LAY.bodyPx, 400) + 8;
      if (pickHead(g, CAND, n, innerW - longW, LAY.headPx, 600, st.echoTitle)) {
        clockTxt = longTxt; clockW = longW;
      } else if (sinceW * 2 <= innerW) {
        sinceTxt = SINCE_TINY;
      } else {
        clockTxt = ''; clockW = 0;
      }
    }
    if (clockTxt) txt(g, clockTxt, x0 + innerW, headBase, LAY.bodyPx, 400, COL.mute, 'right');

    /* the probe above walked this same ladder, so the header ledger is
       cleared here and only the header actually DRAWN writes it. */
    HEAD.text = ''; HEAD.echo = ''; HEAD.skipped = 0;
    txt(g, pickHead(g, CAND, n, innerW - clockW, LAY.headPx, 600, st.echoTitle),
        x0, headBase, LAY.headPx, 600, COL.text, 'left');

    /* ---------------- cross section ----------------
       Two rows are reserved outright, one at the top for the ionosphere
       label and the speed legend and one at the bottom for the scale bar
       and the depth note, so no label ever lands on the wave field and
       nothing has to be plated over the drawing. What is left between them
       is the field: sky above the crust, solid earth below it. */
    var cy0 = contentY, ch = crossH;
    band('cross', x0, cy0, innerW, ch);
    var tiny = LAY.tinyPx;
    var labBase = cy0 + tiny;
    var hasFoot = ch >= 84;
    var fieldTop = cy0 + tiny + 4;
    var fieldBot = cy0 + ch - (hasFoot ? tiny + 9 : 1);
    /* r19f (2): the field's height is what the field ACTUALLY has. It used to
       be floored at 20 while the clip rect kept the real height, so on a
       short tile the crust and everything measured from it were computed
       against a taller field than the one being drawn into. */
    var fieldH = Math.max(1, fieldBot - fieldTop);
    var ionoH = clamp(fieldH * 0.22, 10, 30);
    var ionoTop = fieldTop + 1;
    var crustY = fieldTop + fieldH * 0.47;
    var interiorH = fieldBot - crustY;
    var ex = x0 + innerW / 2;
    /* On a short wide tile the full half width would flatten the fronts
       into near vertical lines. Capping the drawn half width against the
       depth of the ground keeps them recognizable as expanding fronts; the
       scale bar carries the mapping either way, so nothing is misstated. */
    var halfPx = clamp(Math.min(innerW / 2 - 3, interiorH * 2.6), 36, Math.max(36, innerW / 2 - 3));

    var pKm = frontKm(elapsed, C.P_SPEED_KMS);
    var sKm = frontKm(elapsed, C.S_SPEED_KMS);
    var span = spanKm(pKm);
    var pxPerKm = span > 0 ? halfPx / span : 0;
    QS.ex = ex; QS.crustY = crustY; QS.span = span; QS.pxPerKm = pxPerKm; QS.pKm = pKm; QS.sKm = sKm;

    var depthKm = num(st.depthKm, NaN);
    var depthFrac = isFinite(depthKm)
      ? clamp(Math.log(1 + Math.max(0, depthKm) / 6) / Math.log(1 + 700 / 6), 0.08, 0.9) : 0.22;
    var hypoY = crustY + clamp(interiorH * depthFrac, 3, interiorH * 0.82);
    QS.hypoY = hypoY;

    g.save();
    g.beginPath(); g.rect(x0, fieldTop, innerW, fieldBot - fieldTop); g.clip();

    /* sky and solid earth */
    g.fillStyle = COL.sky; g.fillRect(x0, fieldTop, innerW, crustY - fieldTop);
    g.fillStyle = COL.interior; g.fillRect(x0, crustY, innerW, interiorH);
    /* two faint strata so the ground reads as ground */
    line(g, x0, crustY + interiorH * 0.38, x0 + innerW, crustY + interiorH * 0.38, COL.strata, 1);
    line(g, x0, crustY + interiorH * 0.74, x0 + innerW, crustY + interiorH * 0.74, COL.strata, 1);

    /* ionosphere band */
    var ik = slotKey(ionoTop, ionoH, 1);
    if (GR.iono.k !== ik || !GR.iono.g) {
      var ig = g.createLinearGradient(0, ionoTop, 0, ionoTop + ionoH);
      ig.addColorStop(0, COL.ionoWashA);
      ig.addColorStop(0.5, COL.ionoWashB);
      ig.addColorStop(1, COL.ionoWashA);
      GR.iono.g = ig; GR.iono.k = ik;
    }
    g.fillStyle = GR.iono.g;
    g.fillRect(x0, ionoTop, innerW, ionoH);
    dash(g, DASH_2);
    line(g, x0, ionoTop, x0 + innerW, ionoTop, COL.ionoEdge, 1);
    line(g, x0, ionoTop + ionoH, x0 + innerW, ionoTop + ionoH, COL.ionoEdge, 1);
    dash(g, DASH_NONE);

    /* the wave field, clipped to the solid earth: the fronts travel in the
       rock, and where the circle meets the crust is where a seismometer
       would feel it */
    var pR = kmToPx(pKm, span, halfPx), sR = kmToPx(sKm, span, halfPx);
    g.save();
    g.beginPath(); g.rect(x0, crustY, innerW, interiorH); g.clip();
    if (pR > 0.6) {
      g.beginPath(); g.arc(ex, hypoY, pR, 0, Math.PI * 2);
      g.fillStyle = COL.accentWash; g.fill();
      if (!reduced) {
        g.beginPath(); g.arc(ex, hypoY, pR, 0, Math.PI * 2);
        g.strokeStyle = COL.frontGlow; g.lineWidth = 4.5; g.stroke();
      }
      g.beginPath(); g.arc(ex, hypoY, pR, 0, Math.PI * 2);
      g.strokeStyle = COL.accent; g.lineWidth = 1.7; g.stroke();
    }
    if (sR > 0.6) {
      g.beginPath(); g.arc(ex, hypoY, sR, 0, Math.PI * 2);
      g.strokeStyle = COL.accentSoft; g.lineWidth = 1.3; g.stroke();
    }
    g.restore();

    /* crust */
    g.fillStyle = COL.crustFill;
    g.fillRect(x0, crustY, innerW, Math.max(2, Math.round(2.5 * LAY.s)));
    line(g, x0, crustY, x0 + innerW, crustY, COL.crust, 1.2);

    /* the acoustic dome rising toward the ionosphere, then spreading */
    var ac = acoustic(elapsed);
    var ionoBot = ionoTop + ionoH;
    var domeMax = Math.max(6, crustY - ionoBot);
    if (elapsed > 0) {
      var rTop = ac.rise * domeMax;
      if (rTop > 2) {
        g.save();
        g.translate(ex, crustY);
        g.scale(1.9, 1);
        dash(g, DASH_3);
        g.beginPath();
        g.arc(0, 0, rTop, Math.PI, Math.PI * 2);
        g.strokeStyle = ac.phase === 'before' ? COL.accentDim : COL.frontLive;
        g.lineWidth = 1;
        g.stroke();
        if (!reduced && ac.phase === 'before' && rTop > 12) {
          g.beginPath();
          g.arc(0, 0, rTop * 0.62, Math.PI, Math.PI * 2);
          g.strokeStyle = COL.frontGlow; g.stroke();
        }
        dash(g, DASH_NONE);
        g.restore();
      }
      if (ac.phase !== 'before') {
        var sp = (0.12 + 0.88 * ac.spread) * halfPx;
        var midY = ionoTop + ionoH / 2;
        dash(g, DASH_3);
        line(g, ex - sp, midY, ex + sp, midY, ac.phase === 'open' ? COL.accent : COL.accentDim, 1.1);
        dash(g, DASH_NONE);
        var tick = Math.max(2, ionoH * 0.3);
        line(g, ex - sp, midY - tick, ex - sp, midY + tick, ac.phase === 'open' ? COL.accent : COL.accentDim, 1.1);
        line(g, ex + sp, midY - tick, ex + sp, midY + tick, ac.phase === 'open' ? COL.accent : COL.accentDim, 1.1);
      }
    }

    /* epicenter tick and the hypocenter star */
    line(g, ex, crustY - 5, ex, crustY + 3, COL.mute, 1);
    var starR = clamp(3.6 * LAY.s, 3, 6.5);
    star(g, ex, hypoY, starR, COL.accentSoft, COL.interior);

    /* ---- live front labels (r19f (2)) ----
       These used to be placed at the crust plus or minus a text row and drawn
       inside the field clip, so on a short tile the clip cut them in half and
       the stopwatch strip painted over what was left. They now take rows the
       field is KNOWN to hold: two rows when there is room for two, one shared
       plate when there is room for one, and when there is room for neither the
       numbers move up to the legend row and no plate is drawn. */
    var d = hypoY - crustY;
    var rowH = tiny + 5;
    var frontMode = fieldH >= rowH * 2 + 4 ? 2 : (fieldH >= rowH + 2 ? 1 : 0);
    frontPt(pR, d, ex, crustY, hypoY, FP1);
    frontPt(sR, d, ex, crustY, hypoY, FP2);
    if (pR > 1) frontTick(g, FP1, COL.accent);
    if (sR > 1) frontTick(g, FP2, COL.accentSoft);
    if (frontMode === 2) {
      var pTop = clamp(crustY - 5 - rowH, fieldTop + 1, fieldBot - 1 - rowH * 2 - 2);
      var sTop = clamp(crustY + 5, pTop + rowH + 2, fieldBot - 1 - rowH);
      if (pR > 1) frontLabel(g, 'P ' + fmtKm10(pKm), FP1.x, pTop, rowH, x0, innerW, COL.accent);
      if (sR > 1) frontLabel(g, 'S ' + fmtKm10(sKm), FP2.x, sTop, rowH, x0, innerW, COL.accentSoft);
    } else if (frontMode === 1 && pR > 1) {
      /* one row is all there is, so the two fronts share it. The letters name
         which number is which, so one colour carries both. */
      frontLabel(g, 'P ' + fmtKm10(pKm) + (sR > 1 ? ' · S ' + fmtKm10(sKm) : ''),
                 FP1.x, clamp(crustY - rowH / 2, fieldTop + 1, fieldBot - 1 - rowH),
                 rowH, x0, innerW, COL.accent);
    }

    g.restore();

    /* ---- reserved label row above the field ---- */
    var legRight = x0 + innerW, legW = 0;
    var legS, legP;
    if (frontMode === 0 && pKm > 0) {
      /* r19f (2): with no room for a plate in the field the live distances
         move up here and the two speeds stand down. The distance is what the
         tile is for; the speeds are constants the narration carries anyway. */
      legP = 'P ' + group(Math.round(pKm / 10) * 10);
      legS = 'S ' + fmtKm10(sKm);
    } else {
      legS = 'S ' + C.S_SPEED_KMS.toFixed(1) + ' km/s';
      legP = 'P ' + C.P_SPEED_KMS.toFixed(1);
    }
    /* r19i (10): when the header could not hold the named clock, this row
       names it, sitting directly under the clock itself. It is placed before
       the speed legend because the legend is two constants the narration
       carries anyway, while an unnamed running number is the defect. */
    if (sinceTxt) {
      txt(g, sinceTxt, legRight, labBase, tiny, 400, COL.faint, 'right');
      legW = sinceW + 6;
      legRight -= legW;
    }
    var wS = widthOf(g, legS, tiny, 600), wP = widthOf(g, legP, tiny, 600);
    if (innerW - legW - (wS + wP + 10) > 66) {
      txt(g, legS, legRight, labBase, tiny, 600, COL.accentSoft, 'right');
      txt(g, legP, legRight - wS - 7, labBase, tiny, 600, COL.accent, 'right');
      legW += wS + wP + 14;
    }

    /* honest wording: expected, never detected. Act 1 has no instrument
       watching the ionosphere, so this label describes physics, not a
       measurement. */
    n = 0;
    if (ac.phase === 'before') {
      CAND[n++] = 'ionosphere · acoustic wave expected 8 to 15 min';
      CAND[n++] = 'ionosphere · wave expected 8 to 15 min';
      CAND[n++] = 'ionosphere · expected 8 to 15 min';
      CAND[n++] = 'ionosphere';
    } else if (ac.phase === 'open') {
      CAND[n++] = 'ionosphere · expected arrival window open';
      CAND[n++] = 'ionosphere · expected window open';
      CAND[n++] = 'ionosphere';
    } else {
      CAND[n++] = 'ionosphere · expected arrival window passed';
      CAND[n++] = 'ionosphere · expected window passed';
      CAND[n++] = 'ionosphere';
    }
    txt(g, pick(g, CAND, n, innerW - legW, tiny, 400), x0, labBase, tiny, 400,
        ac.phase === 'open' ? COL.accentSoft : COL.mute, 'left');

    /* ---- reserved footer row below the field ---- */
    if (hasFoot) {
      var footBase = cy0 + ch - 2;
      var used = drawScaleBar(g, x0, footBase, halfPx, span, pxPerKm);
      n = 0;
      if (isFinite(depthKm)) {
        CAND[n++] = 'hypocenter ' + group(depthKm) + ' km deep, depth drawn exaggerated';
        CAND[n++] = 'hypocenter ' + group(depthKm) + ' km deep';
      }
      CAND[n++] = 'depth drawn exaggerated';
      CAND[n++] = 'depth exaggerated';
      txt(g, pick(g, CAND, n, innerW - used - 12, tiny, 400), x0 + innerW, footBase, tiny, 400, COL.faint, 'right');
    }

    /* ---------------- stopwatch strip ---------------- */
    SWRES.text = ''; SWRES.px = 0;
    if (hasStrip) {
      band('strip', x0, swY, innerW, stopH);
      drawStopwatch(g, x0, swY, innerW, stopH, st, elapsed, reduced, swCompact);
    }

    LAST.kind = 'quake'; LAST.w = W; LAST.h = H; LAST.pKm = pKm; LAST.sKm = sKm;
    LAST.spanKm = span; LAST.phase = ac.phase; LAST.elapsedMs = elapsed;
    LAST.frontMode = frontMode;
    LAST.headText = HEAD.text; LAST.headEcho = HEAD.echo; LAST.headSkipped = HEAD.skipped;
    /* r19i (10) */
    LAST.clockText = clockTxt; LAST.sinceText = sinceTxt;
    LAST.swText = SWRES.text; LAST.swPx = SWRES.px;
    ledgerPublish();
    return LAST;
  }

  /* where a front meets the crust, or its own leading point when it has not
     reached the surface yet */
  var FP1 = { x: 0, y: 0 }, FP2 = { x: 0, y: 0 };
  function frontPt(r, d, ex, crustY, hypoY, out) {
    if (r > Math.abs(d)) { out.x = ex + Math.sqrt(r * r - d * d); out.y = crustY; }
    else { out.x = ex + r; out.y = hypoY; }
    return out;
  }

  /* the tick that says which point on the drawing the number is about */
  function frontTick(g, p, color) {
    line(g, p.x, p.y - 4, p.x, p.y + 4, color, 1);
  }

  /* one front's number, on a row the caller has already proved the field
     holds. The plate sits beside the front and flips to its other side rather
     than run off the tile; one wider than the tile is not drawn at all. */
  function frontLabel(g, label, ax, top, rowH, x0, innerW, color) {
    var tiny = LAY.tinyPx;
    var w = widthOf(g, label, tiny, 600), pw = w + 6;
    if (!(pw <= innerW - 2)) return;
    var px = ax + 5;
    if (px + pw > x0 + innerW - 2) px = ax - 5 - pw;
    px = clamp(px, x0 + 1, x0 + innerW - 1 - pw);
    platedTxt(g, label, px + 3, top + rowH - 4, tiny, 600, color, 'left', px, top, pw, rowH);
  }

  /* the scale bar sits on the reserved footer row: a measured length, its
     end ticks, then the label beside it. Returns the width it consumed. */
  var BAR_LADDER = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
  function drawScaleBar(g, x, yBase, halfPx, span, pxPerKm) {
    if (!(pxPerKm > 0) || halfPx < 40) return 0;
    var want = span * 0.3, best = BAR_LADDER[0], i;
    for (i = 0; i < BAR_LADDER.length; i++) if (BAR_LADDER[i] <= want) best = BAR_LADDER[i];
    var w = best * pxPerKm;
    if (!(w > 14) || w > halfPx) return 0;
    var tiny = LAY.tinyPx;
    var midY = yBase - tiny * 0.34;
    line(g, x, midY, x + w, midY, COL.faint, 1);
    line(g, x, midY - 3, x, midY + 3, COL.faint, 1);
    line(g, x + w, midY - 3, x + w, midY + 3, COL.faint, 1);
    var lab = fmtKm(best);
    txt(g, lab, x + w + 5, yBase, tiny, 400, COL.faint, 'left');
    return w + 5 + widthOf(g, lab, tiny, 400);
  }

  /* r19i (10): the strip's result sentence and the size it was drawn at, so a
     test can ask whether the whole sentence survived. Module scratch, reset by
     the quake tile before the strip runs. */
  var SWRES = { text: '', px: 0 };

  function drawStopwatch(g, x, y, w, h, st, elapsed, reduced, compactStrip) {
    line(g, x, y, x + w, y, COL.rule, 1);

    var edit = st.edit && typeof st.edit === 'object' ? st.edit : null;
    /* the stopwatch records this as `latency`; `latencyMs` is the explicit
       name. Both are accepted so the two sides cannot drift apart silently. */
    var latency = edit ? num(edit.latencyMs, num(edit.latency, NaN)) : NaN;
    var timedOut = !!st.timedOut;
    var watching = st.watching !== false && !edit && !timedOut;

    var tiny = LAY.tinyPx, body = LAY.bodyPx;
    var span = timelineSpanMs(elapsed, latency);

    /* rows from the top: an optional title row, the axis, optional tick
       labels, then the result sentence pinned to the bottom */
    var titleH = compactStrip ? 0 : tiny + 5;
    var axisH = Math.max(11, 9 * LAY.s);
    var resH = body + 5;
    var tickH = (h - titleH - axisH - resH >= tiny + 2) ? tiny + 3 : 0;
    var axisY = y + titleH + axisH * 0.5;
    /* r19f (2): the sentence's descenders used to hang below the strip. The
       row is pinned by the same line box the ledger records. */
    var resBase = y + h - Math.max(2, Math.round(body * BOX_DESC));

    if (titleH) {
      var tinyY = y + tiny + 3;
      /* r19f (2): the two ends of this row are measured against each other, so
         a narrow strip drops the range rather than printing it over the name */
      var swRange = '0 to ' + durWords(span);
      var rangeW = widthOf(g, swRange, tiny, 400);
      var nn = 0;
      CAND[nn++] = 'Wikipedia stopwatch';
      CAND[nn++] = 'Stopwatch';
      var swName = pick(g, CAND, nn, w - rangeW - 8, tiny, 600);
      if (!swName) { swName = pick(g, CAND, nn, w, tiny, 600); rangeW = 0; }
      txt(g, swName, x, tinyY, tiny, 600, COL.mute, 'left');
      if (rangeW) txt(g, swRange, x + w, tinyY, tiny, 400, COL.faint, 'right');
    }

    /* axis */
    var ax0 = x + 2, ax1 = x + w - 2, aw = ax1 - ax0;
    line(g, ax0, axisY, ax1, axisY, COL.ghost, 1.2);
    var pos = function (ms) { return ax0 + clamp(num(ms, 0) / span, 0, 1) * aw; };

    /* minute ticks, labelled when the strip is tall enough to hold them.
       r19f (2): a label is printed only where one fits. On a narrow strip
       they are thinned out rather than stacked on each other, and one that
       cannot sit under its own tick without leaving the strip is dropped. */
    var step = span <= 300000 ? 60000 : (span <= 1800000 ? 300000 : 900000);
    var every = 1;
    if (tickH) {
      var wideLab = Math.round((Math.floor((span - 1) / step) * step) / 60000) + ' min';
      var spacing = (step / span) * aw;
      every = Math.max(1, Math.ceil((widthOf(g, wideLab, tiny, 400) + 6) / Math.max(1, spacing)));
    }
    var idx = 0;
    for (var t = step; t < span; t += step) {
      var tx0 = pos(t);
      idx++;
      line(g, tx0, axisY - 2.5, tx0, axisY + 2.5, COL.ghost, 1);
      if (!tickH || (idx % every)) continue;
      var lab = Math.round(t / 60000) + ' min';
      var lw = widthOf(g, lab, tiny, 400);
      if (tx0 - lw / 2 < x || tx0 + lw / 2 > x + w) continue;
      txt(g, lab, tx0, axisY + axisH * 0.5 + tiny, tiny, 400, COL.faint, 'center');
    }

    /* the rupture end of the axis */
    line(g, ax0, axisY - 5, ax0, axisY + 5, COL.mute, 1.2);

    /* the running clock */
    var nx = pos(elapsed);
    line(g, ax0, axisY, nx, axisY, COL.accentDim, 2.4);
    line(g, nx, axisY - 5, nx, axisY + 5, COL.accent, 1.4);
    if (!reduced && watching) {
      g.beginPath(); g.arc(nx, axisY, 2.6, 0, Math.PI * 2);
      g.fillStyle = COL.accent; g.fill();
    }

    /* the measured latency is the finding, so it is the one gold thing here */
    if (isFinite(latency)) {
      var fx = pos(latency);
      line(g, ax0, axisY, fx, axisY, COL.goldDim, 2.4);
      line(g, fx, axisY - 7, fx, axisY + 5, COL.gold, 1.4);
      g.beginPath();
      g.moveTo(fx, axisY - 7); g.lineTo(fx + 7, axisY - 4.5); g.lineTo(fx, axisY - 2);
      g.closePath(); g.fillStyle = COL.gold; g.fill();
    }

    /* result sentence */
    var n = 0, color = COL.mute, idleFull = '';
    if (edit) {
      var lat = durWords(latency);
      var lang = typeof edit.lang === 'string' ? edit.lang : '';
      var title = typeof edit.title === 'string' ? edit.title : '';
      if (lang && title) CAND[n++] = 'Wikipedia noticed in ' + lat + ' · ' + lang + ' · ' + title;
      if (lang) CAND[n++] = 'Wikipedia noticed in ' + lat + ' · ' + lang;
      CAND[n++] = 'Wikipedia noticed in ' + lat;
      CAND[n++] = 'noticed in ' + lat;
      color = COL.text;
    } else if (timedOut) {
      CAND[n++] = 'No Wikipedia edit found within 90 minutes';
      CAND[n++] = 'no edit within 90 minutes';
      CAND[n++] = 'no edit in 90 min';
    } else if (watching) {
      /* r19t (7): the plate prints this same sentence one row up, so the
         clock in it is the director's string, not a second formatting of a
         second reading of the age. */
      var swTail = CLK.text ? (' · ' + CLK.text) : '';
      CAND[n++] = 'Watching for the first Wikipedia edit' + swTail;
      CAND[n++] = 'Watching for the first edit' + swTail;
      CAND[n++] = 'watching' + swTail;
    } else {
      /* r19i (10): "The stopwatch arms on qualifying earthquakes" under a
         clock that is visibly ticking read as running and not running at the
         same moment. This says which quake it is about and what magnitude
         would have armed it. With no threshold passed it keeps the old
         sentence rather than inventing a number. */
      var thr = magWord(st.swThreshold);
      if (thr) {
        idleFull = 'Wikipedia stopwatch: not armed for this quake (it arms at M' + thr + ' and above).';
        CAND[n++] = idleFull;
        CAND[n++] = 'Wikipedia stopwatch: not armed for this quake.';
        CAND[n++] = 'not armed for this quake';
      } else {
        CAND[n++] = 'The stopwatch arms on qualifying earthquakes';
        CAND[n++] = 'stopwatch idle';
      }
      color = COL.faint;
    }
    var resPx = LAY.bodyPx;
    var res = pick(g, CAND, n, w, resPx, 400);
    /* r19i (10): naming the threshold makes this sentence long enough that a
       narrow strip can fail to hold it. The whole sentence is worth one point
       of type, so the size steps down toward the tiny size until it fits, and
       only below that does the ladder shorten what it says. */
    if (idleFull && res !== idleFull) {
      var p2 = LAY.bodyPx;
      while (p2 > LAY.tinyPx && widthOf(g, idleFull, p2, 400) > w) p2--;
      if (widthOf(g, idleFull, p2, 400) <= w) { res = idleFull; resPx = p2; }
    }
    SWRES.text = res; SWRES.px = res ? resPx : 0;
    txt(g, res, x, resBase, resPx, 400, color, 'left');
  }

  /* ======================================================================
     the flare diagram
     ====================================================================== */

  function flare(canvas, state) {
    var st = state || {};
    var g = fit(canvas, st);
    if (!g) return LAST;
    metrics();
    ledgerReset();
    var W = LAY.w, H = LAY.h, pad = LAY.pad, gap = LAY.gap;
    var reduced = !!st.reduced;

    var now = num(st.now, NaN), t0 = num(st.t0, NaN);
    var derived = isNum(st.elapsedMs) ? Math.max(0, st.elapsedMs)
                : ((isFinite(now) && isFinite(t0)) ? Math.max(0, now - t0) : NaN);
    /* r19t (7): same one clock, same subject key, same refusal */
    if (!openFrame(g, st, 'flare', derived)) return null;
    var elapsed = isNum(CLK.sinceMs) ? CLK.sinceMs : derived;
    stampSid(g, LAST.sid);

    g.clearRect(0, 0, W, H);
    g.fillStyle = COL.bg;
    g.fillRect(0, 0, W, H);

    var x0 = pad, innerW = W - pad * 2;
    var contentY = pad + LAY.head + gap;
    var contentH = H - contentY - pad;
    /* both blocks are capped: past a point extra height stops helping and
       the lanes drift away from the two bodies they connect */
    var bloomH = clamp(contentH * (1 - 1 / C.PHI), 34, 96);
    var pipeH = clamp(contentH - bloomH - gap, 36, 156);
    /* r19f (2): the two floors together ask for more than a short tile has
       (36 + 34 against a content box of 71 at the size the rail uses), and
       what used to give was the lane block, which grew past the pipe and
       printed its first lane over the header. The blocks now share what
       there IS: the space between them closes first, then the pipe keeps
       enough for three label rows and the bloom takes the rest of its own
       height. Text before decoration. */
    var blockGap = gap;
    if (pipeH + blockGap + bloomH > contentH) {
      blockGap = Math.max(2, Math.round(gap / 2));
      var avail = Math.max(0, contentH - blockGap);
      var pipeMin = Math.min(avail, 3 * (LAY.tinyPx + 1));
      bloomH = clamp(avail - pipeMin, 0, bloomH);
      pipeH = avail - bloomH;
    }
    var slack = Math.max(0, contentH - bloomH - blockGap - pipeH);

    var cls = classText(st);
    var word = flareWord(cls);

    /* ---------------- header ---------------- */
    band('head', x0, pad, innerW, LAY.head);
    var headBase = pad + LAY.headPx;
    var right = (cls && isFinite(elapsed) && CLK.text) ? ('+' + CLK.text) : '';
    var rw = right ? widthOf(g, right, LAY.bodyPx, 400) + 8 : 0;
    if (right) txt(g, right, x0 + innerW, headBase, LAY.bodyPx, 400, COL.mute, 'right');

    var n = 0;
    if (cls) {
      var noun = word ? (word.charAt(0).toUpperCase() + word.slice(1) + ' solar flare') : 'Solar flare';
      var fx = num(st.flux, NaN);
      if (isFinite(fx)) CAND[n++] = noun + ' in progress · ' + cls + ' · ' + fx.toExponential(1) + ' W/m2';
      CAND[n++] = noun + ' in progress · ' + cls;
      CAND[n++] = noun + ' · ' + cls;
      CAND[n++] = cls + ' flare';
      CAND[n++] = cls;
    } else {
      CAND[n++] = 'No flare in progress';
      CAND[n++] = 'Sun quiet';
    }
    /* r19g (16): same rule as the quake header, same reason */
    txt(g, pickHead(g, CAND, n, innerW - rw, LAY.headPx, 600, st.echoTitle),
        x0, headBase, LAY.headPx, 600, COL.text, 'left');

    /* ---------------- the pipeline ---------------- */
    var py = contentY + slack * 0.35, ph = pipeH;
    band('pipe', x0, py, innerW, ph);
    var midY = py + ph / 2;

    /* the two bodies. Both are drawn in full: a cropped limb at tile size
       reads as a smudge, and the lanes need two ends to run between. */
    var sunR = clamp(Math.min(ph * 0.30, innerW * 0.11), 9, 32);
    var sunCx = x0 + sunR + 1;
    var earthR = clamp(sunR * 0.62, 6, 19);
    var earthCx = x0 + innerW - earthR - 1;
    drawSun(g, sunCx, midY, sunR);
    drawEarth(g, earthCx, midY, earthR, 0, GR.dayA, GR.bloomA);

    var tx0 = sunCx + sunR + Math.max(5, 4 * LAY.s);
    var tx1 = earthCx - earthR - Math.max(5, 4 * LAY.s);
    var trackW = Math.max(18, tx1 - tx0);

    /* the lane block is kept near the two bodies rather than stretched over
       the whole pipe height, so the pipeline still reads as one figure */
    var lanes = laneState(st);
    var pairH = LAY.tinyPx + 6 + Math.max(2.5, 3 * LAY.s);
    /* r19f (2): the block never leaves the pipe. Its old lower bound was three
       full pairs whether or not the pipe was that tall, and clamp honours a
       lower bound above its upper one, so a short tile grew the block instead
       of compressing the lanes inside it. */
    var blockH = clamp(sunR * 3.2, Math.min(3 * pairH, ph), ph);
    var blockY = midY - blockH / 2;
    var laneH = blockH / 3;
    for (var i = 0; i < 3; i++) {
      drawLane(g, lanes[i], tx0, blockY + i * laneH, trackW, laneH, reduced);
    }

    /* ---------------- absorption bloom ---------------- */
    var by = contentY + slack * 0.85 + pipeH + blockGap;
    band('bloom', x0, by, innerW, bloomH);
    drawBloom(g, x0, by, innerW, bloomH, st, reduced);

    LAST.kind = 'flare'; LAST.w = W; LAST.h = H; LAST.cls = cls || '';
    LAST.mhz = num(st.drapPeakMHz, 0); LAST.elapsedMs = isFinite(elapsed) ? elapsed : 0;
    LAST.frontMode = -1;
    LAST.headText = HEAD.text; LAST.headEcho = HEAD.echo; LAST.headSkipped = HEAD.skipped;
    /* r19i (10): a flare frame carries no stopwatch strip, so it clears that
       reading rather than leaving a quake's on the ledger.
       r19t (7): it DOES carry a clock, in the header, and the ledger said it
       did not. The ledger is what a test reads for what a reader can see, so
       it now records the string the header drew, '+' and all. */
    LAST.clockText = right; LAST.sinceText = ''; LAST.swText = ''; LAST.swPx = 0;
    ledgerPublish();
    return LAST;
  }

  /* one lane: the label row and its track are a tight pair, and both stay
     inside the track box, so no text ever lands on the sun or the planet */
  function drawLane(g, L, x, y, w, h, reduced) {
    var tiny = LAY.tinyPx;
    var barH = Math.max(2.5, 3 * LAY.s);
    /* r19f (2): the pair fits the lane it was given. On a short tile the gap
       closes first and the track stands down last, so the label row, which is
       what a reader actually reads, always sits whole inside its own lane. */
    var gapPx = clamp(h - tiny - barH, 0, 6);
    var showBar = h >= tiny + barH;
    var pairH = showBar ? (tiny + gapPx + barH) : tiny;
    if (h < tiny) return;
    var top = y + Math.max(0, (h - pairH) / 2);
    var textBase = top + tiny * BOX_ASC;
    var trackY = top + tiny + gapPx;

    var n = 0;
    CAND[n++] = L.status;
    CAND[n++] = L.statusShort;
    var stat = pick(g, CAND, n, w, tiny, 600);
    var statW = stat ? widthOf(g, stat, tiny, 600) : 0;
    var avail = w - statW - (stat ? 8 : 0);
    n = 0;
    CAND[n++] = L.label + ' · ' + L.travel;
    CAND[n++] = L.label + ' · ' + L.travelShort;
    CAND[n++] = L.label;
    CAND[n++] = L.short + ' · ' + L.travelShort;
    CAND[n++] = L.short;
    var lab = pick(g, CAND, n, avail, tiny, 400);
    txt(g, lab, x, textBase, tiny, 400, L.on ? COL.text : COL.mute, 'left');
    txt(g, stat, x + w, textBase, tiny, 600, L.on ? COL.accentSoft : COL.faint, 'right');

    /* the track from the sun to the planet */
    if (!showBar) return;
    if (L.on) {
      roundRect(g, x, trackY, w, barH, barH / 2);
      g.fillStyle = COL.ghost; g.fill();
      var fw = clamp(L.prog, 0, 1) * w;
      if (fw > 1) {
        roundRect(g, x, trackY, fw, barH, barH / 2);
        g.fillStyle = COL.accent; g.fill();
      }
      if (!reduced && L.prog > 0.02 && L.prog < 0.995) {
        g.beginPath();
        g.arc(x + fw, trackY + barH / 2, barH * 1.15, 0, Math.PI * 2);
        g.fillStyle = COL.accentSoft; g.fill();
      }
    } else {
      dash(g, DASH_3);
      line(g, x, trackY + barH / 2, x + w, trackY + barH / 2, COL.ghost, 1.2);
      dash(g, DASH_NONE);
    }
  }

  /* the sun: a limb darkened neutral disc with a faint corona and a thin
     warm rim. The body is deliberately kept near white rather than warm
     gold: gold is the finding color on this page and a large gold disc
     would read as a claim. */
  function drawSun(g, cx, cy, r) {
    if (!isNum(cx) || !isNum(cy) || !(r > 1)) return;
    var k = slotKey(r, 0, 5);
    if (GR.sun.k !== k || !GR.sun.g) {
      var cg = g.createRadialGradient(0, 0, r * 0.92, 0, 0, r * 2.05);
      cg.addColorStop(0, 'rgba(206,200,192,0.20)');
      cg.addColorStop(1, 'rgba(206,200,192,0)');
      var dg = g.createRadialGradient(-r * 0.24, -r * 0.24, r * 0.08, 0, 0, r);
      dg.addColorStop(0, 'rgba(250,249,246,0.98)');
      dg.addColorStop(0.7, 'rgba(226,222,214,0.93)');
      dg.addColorStop(1, 'rgba(198,188,178,0.86)');
      GR.sun.g = dg; GR.sun.k = k; GR.sun.corona = cg;
    }
    g.save();
    g.translate(cx, cy);
    g.beginPath(); g.arc(0, 0, r * 2.05, 0, Math.PI * 2);
    g.fillStyle = GR.sun.corona; g.fill();
    g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2);
    g.fillStyle = GR.sun.g; g.fill();
    g.beginPath(); g.arc(0, 0, r - 0.6, 0, Math.PI * 2);
    g.strokeStyle = 'rgba(' + COL.brickRGB + ',0.45)'; g.lineWidth = 1.2; g.stroke();
    g.restore();
  }

  /* a small planet with the day side facing the sun on the left. When
     strength is above zero, the warm absorption bloom sits on that day
     side, sized and darkened by the injected D-RAP peak frequency. */
  function drawEarth(g, cx, cy, r, strength, daySlot, bloomSlot) {
    if (!isNum(cx) || !isNum(cy) || !(r > 1)) return;
    strength = clamp(num(strength, 0), 0, 1);
    g.save();
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.clip();
    g.fillStyle = COL.night; g.fillRect(cx - r, cy - r, r * 2, r * 2);
    var dk = slotKey(r, 0, 2);
    if (daySlot.k !== dk || !daySlot.g) {
      var dg = g.createRadialGradient(-r * 0.45, 0, r * 0.1, -r * 0.2, 0, r * 1.5);
      dg.addColorStop(0, COL.dayGlowA);
      dg.addColorStop(0.55, COL.dayGlowB);
      dg.addColorStop(1, COL.dayGlowC);
      daySlot.g = dg; daySlot.k = dk;
    }
    g.save();
    g.translate(cx, cy);
    g.fillStyle = daySlot.g;
    g.fillRect(-r, -r, r * 2, r * 2);
    if (strength > 0.01) {
      var bk = slotKey(r, strength, 3);
      if (bloomSlot.k !== bk || !bloomSlot.g) {
        var br = Math.max(2, r * (0.5 + 0.75 * strength));
        var bg = g.createRadialGradient(-r * 0.42, 0, r * 0.06, -r * 0.42, 0, br);
        bg.addColorStop(0, 'rgba(' + COL.brickRGB + ',' + (0.30 + 0.55 * strength).toFixed(3) + ')');
        bg.addColorStop(0.6, 'rgba(' + COL.brickRGB + ',' + (0.14 + 0.30 * strength).toFixed(3) + ')');
        bg.addColorStop(1, 'rgba(' + COL.brickRGB + ',0)');
        bloomSlot.g = bg; bloomSlot.k = bk;
      }
      g.fillStyle = bloomSlot.g;
      g.fillRect(-r, -r, r * 2, r * 2);
    }
    g.restore();
    g.restore();
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
    g.strokeStyle = COL.limb; g.lineWidth = 1; g.stroke();
  }

  /* the caption row, a real gap and the number row: what the bloom's text
     needs, so the flare layout can hand it that much before it draws */
  function bloomStackH() {
    return LAY.tinyPx + Math.max(2, Math.round(1.5 * LAY.s)) + LAY.bodyPx;
  }

  function drawBloom(g, x, y, w, h, st, reduced) {
    /* r19f (2): a band with no room for its own number is not a band. On a
       tile that short the pipeline keeps what there is and nothing is drawn
       here at all, rather than a line of text hanging off the edge. */
    if (!(h >= LAY.bodyPx + 2)) return;
    line(g, x, y, x + w, y, COL.rule, 1);
    var mhz = num(st.drapPeakMHz, NaN);
    var known = isFinite(mhz);
    var stre = bloomStrength(known ? mhz : 0);

    var r = clamp(h * 0.32, 11, 30);
    var cx = x + r + 2, cy = y + h * 0.52;
    drawEarth(g, cx, cy, r, stre, GR.dayB, GR.bloomB);

    var tx = cx + r + Math.max(7, 6 * LAY.s);
    var tw = x + w - tx;
    if (tw < 40) return;

    /* r19f (2): the caption and the number are a STACK with a real gap,
       measured from the same line box the ledger records, and the frequency
       scale is drawn only where the stack leaves room for it. They used to sit
       at fixed fractions of the band, which put the caption's descenders
       inside the number's row on a short tile. */
    var tiny = LAY.tinyPx, body = LAY.bodyPx;
    var stackH = bloomStackH();
    var rowGap = stackH - tiny - body;
    var barH = Math.max(3, 3.5 * LAY.s);
    var barY = y + h - Math.max(7, 8 * LAY.s);
    var labH = LAY.wide ? (tiny + 3) : 0;          /* the MHz label above the bar */
    var hasBar = tw >= 90 && (barY - 4 - y) >= stackH + 2 + labH;
    var avail = hasBar ? (barY - 4 - labH - y) : h;
    var oneRow = avail < stackH;
    if (avail < body) return;
    var top = y + Math.max(0, (avail - (oneRow ? body : stackH)) / 2);
    var l1Base = top + tiny * BOX_ASC;
    var l2Base = oneRow ? (top + body * BOX_ASC)
                        : (top + tiny + rowGap + body * BOX_ASC);

    var n = 0;
    if (!oneRow) {
      CAND[n++] = 'Shortwave absorption, day side';
      CAND[n++] = 'Shortwave absorption';
      CAND[n++] = 'Absorption';
      txt(g, pick(g, CAND, n, tw, tiny, 600), tx, l1Base, tiny, 600, COL.mute, 'left');
    }

    n = 0;
    if (!known) {
      CAND[n++] = 'no absorption number yet';
      CAND[n++] = 'no number yet';
    } else if (mhz < 1) {
      CAND[n++] = 'nothing absorbed above 1 MHz';
      CAND[n++] = 'below 1 MHz';
    } else {
      var v = mhz >= 10 ? Math.round(mhz) : (Math.round(mhz * 10) / 10);
      CAND[n++] = 'signals below about ' + v + ' MHz are being absorbed';
      CAND[n++] = 'absorbed below about ' + v + ' MHz';
      CAND[n++] = 'below ' + v + ' MHz';
    }
    txt(g, pick(g, CAND, n, tw, body, 400), tx, l2Base,
        body, 400, (known && mhz >= 1) ? COL.text : COL.faint, 'left');

    /* the frequency scale, when there is room for it to mean anything */
    if (!hasBar) return;
    roundRect(g, tx, barY, tw, barH, barH / 2);
    g.fillStyle = COL.ghost; g.fill();
    if (stre > 0.005) {
      roundRect(g, tx, barY, Math.max(2, tw * stre), barH, barH / 2);
      g.fillStyle = COL.brick; g.fill();
    }
    if (LAY.wide) {
      var ticks = [10, 20, 30], i;
      for (i = 0; i < ticks.length; i++) {
        var px = tx + tw * (ticks[i] / C.BLOOM_FULL_MHZ);
        line(g, px, barY - 1.5, px, barY + barH + 1.5, COL.ghost, 1);
      }
      txt(g, C.BLOOM_FULL_MHZ + ' MHz', tx + tw, barY - 3, LAY.tinyPx, 400, COL.faint, 'right');
    }
  }

  /* ======================================================================
     exports
     ====================================================================== */
  /* r19i (10): clockText is the header clock exactly as it was drawn ('' when
     no clock was drawn at all) and sinceText is the word the tiny row carried
     for it. Together they say which of the two naming forms this frame took. */
  var LAST = { kind: '', w: 0, h: 0, pKm: 0, sKm: 0, spanKm: 0, phase: '', cls: '', mhz: 0,
               elapsedMs: 0, frontMode: -1, headText: '', headEcho: '', headSkipped: 0,
               clockText: '', sinceText: '', swText: '', swPx: 0,
               /* r19t (7): who this tile is about (`sid`), who the page is on
                  (`curSid`), whether the two disagreed and the frame was
                  refused, which of the three clocks the frame read, and which
                  palette it was inked in. */
               sid: '', curSid: '', refused: false, clockSrc: '', sidSrc: '', theme: 'dark',
               boxes: [], bands: BANDS };

  var API = {
    version: 1,
    quake: quake,
    flare: flare,
    /* the last frame's numbers, module scratch: read it, never keep it */
    last: function () { return LAST; },
    /* r19f (2): every box the last frame drew a string into, and the bands
       they belong to. Module scratch as well, for the same reason. */
    __boxes: function () { return LAST.boxes; },
    __bands: function () { return BANDS; },
    /* r19t (7): the subject the pixels ON this canvas belong to, so the page
       can ask a mounted tile what it is showing rather than trust that it was
       cleared. '' means nothing this file painted is standing there. */
    sidOf: function (cv) {
      return (cv && typeof cv.__obsSid === 'string') ? cv.__obsSid : '';
    },
    /* the last frame's clock, as resolved. Module scratch like last(). */
    clock: function () { return CLK; },
    PURE: {
      C: C,
      BOX_ASC: BOX_ASC, BOX_DESC: BOX_DESC,
      num: num, clamp: clamp,
      group: group, fmtKm: fmtKm, fmtKm10: fmtKm10, magWord: magWord,
      SINCE_HEAD: SINCE_HEAD, SINCE_TINY: SINCE_TINY,
      clock: clock, durWords: durWords, agoWords: agoWords,
      /* r19t (7) */
      clockShape: clockShape, resolveClock: resolveClock, tileSid: tileSid,
      dirSubjectId: dirSubjectId, bareSid: bareSid, HOP_PREFIX: HOP_PREFIX,
      mountable: mountable, effectiveTheme: effectiveTheme, paletteFor: paletteFor,
      COL_D: COL_D, COL_L: COL_L,
      frontKm: frontKm, spanKm: spanKm, kmToPx: kmToPx, acoustic: acoustic,
      timelineSpanMs: timelineSpanMs, quakeWord: quakeWord,
      classOf: classOf, classText: classText, flareWord: flareWord, echoesTitle: echoesTitle,
      bloomStrength: bloomStrength, laneState: laneState, NOT_WATCHED: NOT_WATCHED
    }
  };

  global.ObsDiagrams = API;
  if (typeof module === 'object' && module && module.exports) module.exports = API;

})(typeof window !== 'undefined' ? window : globalThis);
