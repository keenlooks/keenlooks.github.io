/* ==========================================================================
   voyage.js -- Mission to Anywhere (/voyage/).
   --------------------------------------------------------------------------
   Page runtime. All the math lives in voyage-astro.js (window.VoyageAstro);
   the star + exoplanet catalog is the generated voyage-data.js
   (window.VOYAGE_DATA, HYG CC BY-SA + NASA Exoplanet Archive). This file
   owns one full-screen canvas: a 3D solar system (real JPL positions for
   today), a real star field (true positions, distances and colors), a
   procedural galaxy backdrop (labeled an illustration), a search combobox,
   an info card for any body, porkchop transfer planning for planets (the
   Mission-to-Mars machinery, generalized to all seven targets), and honest
   relativistic trip math for stars with a cruise animation that shows the
   ship clock and the Earth clock running apart.

   Modes: 'intro' | 'explore' | 'porkchop' | 'cruise'. Esc walks back.
   World units: AU everywhere; star positions convert ly -> AU at load.
   Theme-aware, Pointer Events + touch-action:none, pauses on hidden tabs,
   honors prefers-reduced-motion (no intro, no drift, instant camera moves,
   Launch jumps to the arrival summary). Original code.

   The leading PURE section is DOM-free and exported for node tests.
   ========================================================================== */
(function () {
  'use strict';

  /* ======================================================================
     PURE: formatting + small math helpers, no DOM. module.exports in node.
     ====================================================================== */
  var PURE = {};
  (function (P) {

    function fmtInt(n) {
      n = Math.round(n);
      var neg = n < 0;
      var s = String(Math.abs(n)), out = '';
      while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
      return (neg ? '-' : '') + s + out;
    }

    function round3sig(v) {
      if (!isFinite(v) || v === 0) return 0;
      var p = Math.pow(10, Math.floor(Math.log(Math.abs(v)) / Math.LN10) - 2);
      return Math.round(v / p) * p;
    }

    function fmtYears(y) {
      if (!isFinite(y) || y < 0) return '?';
      if (y < 1) {
        var mo = Math.max(1, Math.round(y * 12));
        return mo + (mo === 1 ? ' month' : ' months');
      }
      if (y < 10) return (Math.round(y * 10) / 10) + ' years';
      if (y < 100) return 'about ' + Math.round(y) + ' years';
      return fmtInt(round3sig(y)) + ' years';
    }

    var SUP = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
                '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
                '-': '⁻' };
    function supInt(n) {
      var s = String(Math.round(n)), out = '', i;
      for (i = 0; i < s.length; i++) out += SUP[s.charAt(i)] || '';
      return out;
    }

    function fmtJoules(j) {
      if (!isFinite(j) || j <= 0) return '?';
      var e = Math.floor(Math.log(j) / Math.LN10);
      var m = Math.round(j / Math.pow(10, e) * 10) / 10;
      if (m >= 10) { m = 1; e += 1; }
      return m + '×10' + supInt(e) + ' J';
    }

    function energyPhrase(worldYears) {
      var tail = " of the world's entire energy production";
      if (!isFinite(worldYears)) return '?';
      if (worldYears >= 100) return 'about ' + fmtInt(round3sig(worldYears)) + ' years' + tail;
      if (worldYears >= 2) return 'about ' + Math.round(worldYears) + ' years' + tail;
      if (worldYears >= 1) return 'about ' + (Math.round(worldYears * 10) / 10) + ' years' + tail;
      var pct = worldYears * 100;
      if (pct >= 1) return 'about ' + Math.round(pct) + '% of one year' + tail;
      if (pct >= 0.01) return 'about ' + (Math.round(pct * 100) / 100) + '% of one year' + tail;
      return 'well under 0.01% of one year' + tail;
    }

    function fuelAmount(massRatio) {
      var f = massRatio - 1;
      if (!isFinite(f) || f <= 0) return null;
      if (f < 10) return String(Math.round(f * 10) / 10);
      if (f < 1000) return String(Math.round(f));
      if (f < 1e6) return fmtInt(round3sig(f));
      var e = Math.floor(Math.log(f) / Math.LN10);
      var m = Math.round(f / Math.pow(10, e));
      if (m >= 10) { m = 1; e += 1; }
      return m + '×10' + supInt(e);
    }

    function fmtSpeedC(v) {
      if (!isFinite(v) || v <= 0) return '0';
      if (v < 0.99) return v.toFixed(2);
      if (v < 0.9999) return v.toFixed(4);
      return v.toFixed(6);
    }

    function fmtGamma(g) {
      if (!isFinite(g)) return '?';
      if (g < 10) return String(Math.round(g * 10) / 10);
      if (g < 100) return String(Math.round(g));
      return fmtInt(round3sig(g));
    }

    /* apparent-magnitude words: the 4-5.5 band deliberately does not
       overstate faintness (a mag-4 star is an easy naked-eye object). */
    function magWords(mag) {
      if (!isFinite(mag)) return '';
      if (mag < 4) return 'is easily visible to the naked eye';
      if (mag <= 5.5) return 'is visible to the naked eye from a dark sky';
      return 'needs binoculars or a telescope';
    }

    function sizeVsSun(r) {
      if (!(r > 0) || !isFinite(r)) return null;
      var x = r >= 10 ? Math.round(r) : (r >= 1 ? Math.round(r * 10) / 10 : Math.round(r * 100) / 100);
      if (x > 0.93 && x < 1.08) return "about the Sun's width, roughly";
      return 'about ' + x + "× the Sun's width, roughly";
    }

    function distPhrase(ly) {
      if (!isFinite(ly)) return '?';
      if (ly < 10) return (Math.round(ly * 100) / 100) + ' light-years';
      if (ly < 100) return (Math.round(ly * 10) / 10) + ' light-years';
      return fmtInt(round3sig(ly)) + ' light-years';
    }

    function lightPhrase(ly, nowYear) {
      if (!isFinite(ly) || ly <= 0) return '';
      if (ly < 120) return 'the light you see left it in ' + Math.round(nowYear - ly);
      return 'the light you see left it about ' + fmtInt(round3sig(ly)) + ' years ago';
    }

    /* star sprite atlas coordinates: 3 size bands by apparent magnitude,
       16 color buckets by B-V index. */
    function bandOf(mag) {
      var m = (typeof mag === 'number' && isFinite(mag)) ? mag : 6;
      return m < 1.5 ? 0 : (m < 4 ? 1 : 2);
    }
    function bucketOf(ci) {
      var c = (typeof ci === 'number' && isFinite(ci)) ? ci : 0.65;
      var b = Math.floor((c + 0.4) / 2.4 * 16);
      return b < 0 ? 0 : (b > 15 ? 15 : b);
    }

    /* Scale bar: pick a nice 1/2/5 length that fits maxPx at the current
       zoom. Unit: AU below 0.1 ly, then ly, then kly. */
    function niceScale(auPerPx, maxPx, lyAU) {
      if (!(auPerPx > 0) || !(maxPx >= 40)) return null;
      var worldAU = maxPx * auPerPx;
      var unit, scaleAU;
      if (worldAU < 0.1 * lyAU) { unit = 'AU'; scaleAU = 1; }
      else if (worldAU < 1000 * lyAU) { unit = 'ly'; scaleAU = lyAU; }
      else { unit = 'kly'; scaleAU = lyAU * 1000; }
      var val = worldAU / scaleAU;
      var pow = Math.pow(10, Math.floor(Math.log(val) / Math.LN10));
      var nice = pow;
      if (5 * pow <= val) nice = 5 * pow;
      else if (2 * pow <= val) nice = 2 * pow;
      nice = Math.round(nice * 1e6) / 1e6;
      var lbl = (nice >= 1000 ? fmtInt(nice) : String(nice)) + ' ' + unit;
      return { px: nice * scaleAU / auPerPx, label: lbl, worldAU: nice * scaleAU };
    }

    /* Constant-acceleration flip trip, parameterized by SHIP proper time.
       Units: d in light-years, a in ly/yr^2, tau in years, c = 1.
       x(tau) = (cosh(a tau) - 1)/a, t(tau) = sinh(a tau)/a, decel mirrored. */
    function cruiseTotals(dLy, a) {
      if (!(dLy > 0) || !(a > 0)) return { tauHalf: 0, tauTotal: 0, tTotal: 0 };
      var chi = a * dLy / 2;
      var tauHalf = Math.acosh(1 + chi) / a;
      return { tauHalf: tauHalf, tauTotal: 2 * tauHalf,
               tTotal: 2 * Math.sqrt(chi * chi + 2 * chi) / a };
    }
    function cruisePoint(dLy, a, tau) {
      var tot = cruiseTotals(dLy, a);
      if (!(dLy > 0) || !(a > 0)) return { x: 0, t: 0, v: 0, g: 1, done: true };
      if (tau <= 0) return { x: 0, t: 0, v: 0, g: 1, done: false };
      if (tau >= tot.tauTotal) return { x: dLy, t: tot.tTotal, v: 0, g: 1, done: true };
      var h, x, t;
      if (tau <= tot.tauHalf) {
        h = a * tau;
        x = (Math.cosh(h) - 1) / a;
        t = Math.sinh(h) / a;
      } else {
        h = a * (tot.tauTotal - tau);
        x = dLy - (Math.cosh(h) - 1) / a;
        t = tot.tTotal - Math.sinh(h) / a;
      }
      return { x: x, t: t, v: Math.tanh(h), g: Math.cosh(h), done: false };
    }

    /* Share payload validation. The decoded hash is UNTRUSTED: everything
       here returns a safe shape or null (name resolution happens later and
       unknown names silently ignore the hash). */
    function normShare(o) {
      if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
      var t = o.t;
      if (!Array.isArray(t) || t.length !== 2) return null;
      var kind = t[0], name = t[1];
      if (kind !== 'p' && kind !== 's' && kind !== 'x') return null;
      if (typeof name !== 'string' || name.length === 0 || name.length > 100) return null;
      function cint(v, lo, hi, d) {
        if (typeof v !== 'number' || !isFinite(v)) return d;
        v = Math.round(v);
        return (v < lo || v > hi) ? d : v;
      }
      return {
        kind: kind, name: name,
        a: cint(o.a, 0, 2, 1), m: cint(o.m, 0, 2, 1),
        d: (typeof o.d === 'number' && isFinite(o.d)) ? o.d : null,
        f: (typeof o.f === 'number' && isFinite(o.f)) ? o.f : null
      };
    }

    /* Search index: planets first, then stars by brightness (plus HIP
       aliases), then exoplanets. Matching is prefix-first then substring. */
    function buildSearchEntries(data, planetNames) {
      var entries = [], i;
      for (i = 0; i < planetNames.length; i++) {
        entries.push({ label: planetNames[i], kind: 'p', idx: i,
                       lower: planetNames[i].toLowerCase() });
      }
      if (data && data.stars) {
        var st = data.stars, n = st.name.length;
        var order = [];
        for (i = 0; i < n; i++) order.push(i);
        order.sort(function (a, b) {
          var ma = (typeof st.mag[a] === 'number') ? st.mag[a] : 99;
          var mb = (typeof st.mag[b] === 'number') ? st.mag[b] : 99;
          return ma - mb;
        });
        for (var k = 0; k < n; k++) {
          i = order[k];
          var nm = st.name[i];
          entries.push({ label: nm, kind: 's', idx: i, lower: nm.toLowerCase() });
          if (st.hip[i]) {
            var alias = 'HIP ' + st.hip[i];
            if (alias !== nm) {
              entries.push({ label: alias, kind: 's', idx: i, lower: alias.toLowerCase() });
            }
          }
        }
        if (data.planets) {
          var pl = data.planets;
          for (i = 0; i < pl.name.length; i++) {
            entries.push({ label: pl.name[i], kind: 'x', idx: i,
                           lower: pl.name[i].toLowerCase() });
          }
        }
      }
      return entries;
    }

    function searchQuery(entries, q, max) {
      q = (q || '').trim().toLowerCase();
      var out = [];
      if (!q) return out;
      var i, e;
      for (i = 0; i < entries.length && out.length < max; i++) {
        e = entries[i];
        if (e.lower.lastIndexOf(q, 0) === 0) out.push(e);
      }
      if (out.length < max) {
        for (i = 0; i < entries.length && out.length < max; i++) {
          e = entries[i];
          if (e.lower.indexOf(q) > 0 && out.indexOf(e) < 0) out.push(e);
        }
      }
      return out;
    }

    function fmt2x(v) {
      if (!isFinite(v)) return '?';
      if (v >= 10) return String(Math.round(v));
      if (v >= 1) return String(Math.round(v * 10) / 10);
      return String(Math.round(v * 100) / 100);
    }

    function perPhrase(days) {
      if (!isFinite(days) || days <= 0) return null;
      if (days < 10) return (Math.round(days * 10) / 10) + ' days';
      if (days < 1200) return Math.round(days) + ' days';
      var y = days / 365.25;
      return (y < 10 ? Math.round(y * 10) / 10 : Math.round(y)) + ' years';
    }

    /* One-line exoplanet chip text, e.g.
       "1.1x Earth's size, 11-day year, habitable zone (roughly)". */
    function chipLine(p, inHz) {
      var parts = [];
      if (p.rade != null && isFinite(p.rade)) parts.push(fmt2x(p.rade) + "× Earth's size");
      if (p.per != null && isFinite(p.per) && p.per > 0) {
        if (p.per < 1200) {
          parts.push((p.per < 10 ? Math.round(p.per * 10) / 10 : Math.round(p.per)) + '-day year');
        } else {
          parts.push((Math.round(p.per / 365.25 * 10) / 10) + '-year orbit');
        }
      } else if (p.a != null && isFinite(p.a)) {
        parts.push(fmt2x(p.a) + ' AU out');
      }
      if (inHz) parts.push('habitable zone (roughly)');
      return parts.length ? parts.join(', ') : 'little is known about it';
    }

    function methodWords(m) {
      if (typeof m !== 'string' || !m) return '';
      return m.toLowerCase();
    }

    /* Expanded chip detail lines. Wording is load-bearing: "about" on
       masses, "assuming no atmosphere" on eq temps, "roughly" on the HZ. */
    function chipDetail(p, inHz) {
      var lines = [];
      var per = perPhrase(p.per);
      if (per) lines.push('A year there lasts ' + per + '.');
      if (p.a != null && isFinite(p.a)) lines.push('It orbits ' + fmt2x(p.a) + ' AU from its star.');
      if (p.rade != null && isFinite(p.rade)) lines.push('About ' + fmt2x(p.rade) + "× Earth's width.");
      if (p.masse != null && isFinite(p.masse)) {
        lines.push('About ' + fmt2x(p.masse) + "× Earth's mass (often a minimum estimate).");
      }
      if (p.eqt != null && isFinite(p.eqt)) {
        lines.push('Roughly ' + Math.round(p.eqt) + ' K, assuming no atmosphere.');
      }
      if (inHz) lines.push('It sits in the habitable zone, roughly.');
      if (p.year != null && isFinite(p.year)) {
        var m = methodWords(p.method);
        lines.push('Found in ' + Math.round(p.year) + (m ? ' by ' + m : '') + '.');
      }
      if (!lines.length) lines.push('Little is known about this one beyond its existence.');
      return lines;
    }

    /* Porkchop TOF axis tick spacing: smallest of 1/2/5*10^k giving <= ~5.5
       ticks over the span. */
    function tofTickFor(spanDays) {
      var p = Math.pow(10, Math.floor(Math.log(spanDays / 5.5) / Math.LN10));
      var cands = [p, 2 * p, 5 * p, 10 * p], i;
      for (i = 0; i < cands.length; i++) {
        if (spanDays / cands[i] <= 5.5) return cands[i];
      }
      return 10 * p;
    }

    P.fmtInt = fmtInt;
    P.round3sig = round3sig;
    P.fmtYears = fmtYears;
    P.supInt = supInt;
    P.fmtJoules = fmtJoules;
    P.energyPhrase = energyPhrase;
    P.fuelAmount = fuelAmount;
    P.fmtSpeedC = fmtSpeedC;
    P.fmtGamma = fmtGamma;
    P.magWords = magWords;
    P.sizeVsSun = sizeVsSun;
    P.distPhrase = distPhrase;
    P.lightPhrase = lightPhrase;
    P.bandOf = bandOf;
    P.bucketOf = bucketOf;
    P.niceScale = niceScale;
    P.cruiseTotals = cruiseTotals;
    P.cruisePoint = cruisePoint;
    P.normShare = normShare;
    P.buildSearchEntries = buildSearchEntries;
    P.searchQuery = searchQuery;
    P.fmt2x = fmt2x;
    P.perPhrase = perPhrase;
    P.chipLine = chipLine;
    P.chipDetail = chipDetail;
    P.tofTickFor = tofTickFor;
  })(PURE);

  if (typeof module !== 'undefined' && module.exports) { module.exports = PURE; return; }
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  /* ======================================================================
     Page runtime (browser only).
     ====================================================================== */
  var canvas = document.getElementById('voy-canvas');
  if (!canvas || !window.VoyageAstro) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  var A = window.VoyageAstro;
  var SD = window.VOYAGE_DATA || null;
  if (!SD) {
    /* belt and suspenders: a failed voyage-data.js fetch degrades to a
       solar-system-only page, never a blank screen */
    try { console.warn('voyage: VOYAGE_DATA missing; stars are unavailable.'); } catch (e0) {}
  }

  function id(x) { return document.getElementById(x); }
  var elPanel = id('voy-panel'), elCollapse = id('voy-collapse'), elHelp = id('voy-help');
  var elSearch = id('voy-search'), elList = id('voy-search-list');
  var elTarget = id('voy-target'), statusEl = id('voy-status'), verifyEl = id('voy-verify');
  var btnShare = id('voy-share'), btnSave = id('voy-save');
  var btnLaunch = id('voy-launch'), btnNext = id('voy-next'), btnBack = id('voy-back');
  var elPcRow = id('voy-pc-row');
  var elWinDetails = id('voy-window-details'), elWinSum = id('voy-window-sum'), elWinText = id('voy-window-text');
  var cardEl = id('voy-card');

  var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var W = 0, H = 0, dpr = 1, raf = null, lastT = 0;
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var FONT = '"Source Sans 3", system-ui, sans-serif';
  var DEG = Math.PI / 180;
  var LY_AU = A.LY_AU;
  var PLANET_KEYS = A.PLANETS;
  var PLANET_LABELS = ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];
  var PLANET_R = [2.6, 3.6, 4, 3, 5, 4.6, 4, 4];

  var nowD = new Date();
  var jdToday = A.dateToJD(nowD.getUTCFullYear(), nowD.getUTCMonth() + 1, nowD.getUTCDate());
  var jd0 = jdToday - 30;
  var thisYearFrac = nowD.getUTCFullYear() +
    (jdToday - A.dateToJD(nowD.getUTCFullYear(), 1, 1)) / 365.25;
  var JD_2050 = A.dateToJD(2050, 12, 31);
  var JD_EXTRAP = A.dateToJD(2051, 1, 1);

  /* ---------------- state ---------------- */
  var mode = 'explore';                 /* 'intro' | 'explore' | 'porkchop' | 'cruise' */
  var introSt = null;                   /* {t0} */
  var tagStart = null, tagKill = null;  /* tagline timing */
  var attract = !reduced;               /* gentle drift until first input */
  var viewJD = jdToday;
  var sel = null;                       /* {kind:'p'|'s', idx} */
  var selExo = -1;                      /* global exoplanet index or -1 */
  var hover = null;                     /* {kind, idx} (mouse only) */
  var lastTap = null;                   /* {name, t} for manual double-tap */
  var centeredStar = -1;                /* star index the camera is parked on */
  var cruiseSt = null;                  /* star cruise state */
  var panelUi = null;                   /* GadgetUI.initPanel handle */
  var arriveInfo = null;                /* arrival summary for the card */
  var starPulse = 0;                    /* arrival ring pulse t0 */
  var accelIdx = 1, shipIdx = 1;        /* trip controls (1 g, crewed ship) */
  var panelOpen = true;
  var sbRect = null;                    /* last scale-bar rect (test hook) */
  var camBefore = null;                 /* camera snapshot to restore on porkchop exit */

  /* porkchop state (ported from mars.js) */
  var pcTarget = null;                  /* planet key while in/after porkchop */
  var specs = {}, jobs = {}, pcSel = {};
  var readoutCache = {};
  var ghost = null;
  var pcCache = null, pcDirty = true, lastPcPaint = 0;
  var pcCruise = null;                  /* {info, t0, ms, trail} */
  var arrivedPulse = 0;
  var dragKind = null;                  /* 'pc' | 'tl' */
  var L = null;
  var ariaLast = 0, ariaPend = null;

  /* ---------------- theme ---------------- */
  function effectiveTheme() {
    var f = document.documentElement.getAttribute('data-theme');
    if (f === 'light' || f === 'dark') return f;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }
  function isLight() { return effectiveTheme() === 'light'; }
  function bg() { return isLight() ? '#f3f5f8' : '#0e1014'; }
  function accent() { return isLight() ? '#34568a' : '#82a6cc'; }
  function gold() { return isLight() ? '#a07c2c' : '#c8a45c'; }
  function textColor(a) { return isLight() ? 'rgba(38,38,38,' + a + ')' : 'rgba(214,214,214,' + a + ')'; }
  function panelFill() { return isLight() ? 'rgba(255,255,255,0.94)' : 'rgba(18,20,24,0.92)'; }

  var RAMP_DARK = [[4.5, 233, 239, 246], [7, 130, 166, 204], [10.5, 60, 78, 99], [14, 20, 20, 20]];
  var RAMP_LIGHT = [[4.5, 22, 42, 74], [7, 52, 86, 138], [10.5, 150, 172, 199], [14, 255, 255, 255]];
  function dvColor(dv, light) {
    var R = light ? RAMP_LIGHT : RAMP_DARK;
    if (dv <= R[0][0]) return [R[0][1], R[0][2], R[0][3]];
    var last = R[R.length - 1];
    if (dv >= last[0]) return [last[1], last[2], last[3]];
    for (var k = 1; k < R.length; k++) {
      if (dv <= R[k][0]) {
        var f = (dv - R[k - 1][0]) / (R[k][0] - R[k - 1][0]);
        return [
          Math.round(R[k - 1][1] + f * (R[k][1] - R[k - 1][1])),
          Math.round(R[k - 1][2] + f * (R[k][2] - R[k - 1][2])),
          Math.round(R[k - 1][3] + f * (R[k][3] - R[k - 1][3]))
        ];
      }
    }
    return [last[1], last[2], last[3]];
  }

  /* ---------------- misc helpers ---------------- */
  function clampN(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function ramp(v, lo, hi) { return v <= lo ? 0 : (v >= hi ? 1 : (v - lo) / (hi - lo)); }
  function easeInOutCubic(s) { return s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2; }
  function fmtDate(jd) {
    var d = A.jdToDate(jd);
    return d.d + ' ' + MON[d.m - 1] + ' ' + d.y;
  }
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function setStatus(t) { if (statusEl) statusEl.textContent = t; }
  function liveStatusText(txt) {
    var t = performance.now();
    if (t - ariaLast > 400) { ariaLast = t; setStatus(txt); ariaPend = null; }
    else ariaPend = txt;
  }

  /* ---------------- star catalog -> typed arrays ---------------- */
  var NS = SD && SD.stars ? SD.stars.name.length : 0;
  var starX = new Float64Array(NS), starY = new Float64Array(NS), starZ = new Float64Array(NS);
  var starLyD = new Float64Array(NS);
  var starCellX = new Int16Array(NS), starCellY = new Int16Array(NS);
  var scrX = new Float32Array(NS), scrY = new Float32Array(NS);
  var scrOk = new Uint8Array(NS);
  var starsVis = false;
  var bandLists = [[], [], []];
  var starPlanets = {};                 /* star index -> [exo indices] */
  (function loadStars() {
    if (!SD || !SD.stars) return;
    var st = SD.stars, i;
    for (i = 0; i < NS; i++) {
      starX[i] = st.x[i] * LY_AU;
      starY[i] = st.y[i] * LY_AU;
      starZ[i] = st.z[i] * LY_AU;
      starLyD[i] = Math.sqrt(st.x[i] * st.x[i] + st.y[i] * st.y[i] + st.z[i] * st.z[i]);
      var band = PURE.bandOf(st.mag[i]);
      var bucket = PURE.bucketOf(st.ci[i]);
      var row = (typeof st.mag[i] === 'number' && st.mag[i] < 0.5) ? 3 : band;
      starCellX[i] = bucket * 32;
      starCellY[i] = row * 32;
      bandLists[band].push(i);
    }
    for (i = 0; i < 3; i++) bandLists[i] = new Uint32Array(bandLists[i]);
    if (SD.planets) {
      var pl = SD.planets;
      for (i = 0; i < pl.name.length; i++) {
        var h = pl.host[i];
        if (!starPlanets[h]) starPlanets[h] = [];
        starPlanets[h].push(i);
      }
    }
  })();

  function starName(i) { return SD.stars.name[i]; }
  function starIndexByName(name) {
    if (!SD) return -1;
    var i;
    for (i = 0; i < NS; i++) if (SD.stars.name[i] === name) return i;
    var ln = String(name).toLowerCase();
    for (i = 0; i < NS; i++) if (SD.stars.name[i].toLowerCase() === ln) return i;
    return -1;
  }
  function exoIndexByName(name) {
    if (!SD || !SD.planets) return -1;
    var pl = SD.planets, i;
    for (i = 0; i < pl.name.length; i++) if (pl.name[i] === name) return i;
    var ln = String(name).toLowerCase();
    for (i = 0; i < pl.name.length; i++) if (pl.name[i].toLowerCase() === ln) return i;
    return -1;
  }
  function exoObj(j) {
    var pl = SD.planets;
    return { name: pl.name[j], host: pl.host[j], per: pl.per[j], a: pl.a[j],
             rade: pl.rade[j], masse: pl.masse[j], eqt: pl.eqt[j],
             year: pl.year[j], method: pl.method[j] };
  }
  /* Prefer the archive-measured teff/lum shipped for exoplanet hosts; fall
     back to the ci/absmag estimates for HYG-only stars. A star with neither
     ci nor teff has NO temperature (NaN) and the card must not invent one. */
  function starTempOf(i) {
    var tf = SD.stars.teff && SD.stars.teff[i];
    if (typeof tf === 'number' && isFinite(tf)) return tf;
    if (SD.stars.ci[i] == null) return NaN;
    return A.starTempFromCi(SD.stars.ci[i]);
  }
  function starBolLum(i) {
    var lm = SD.stars.lum && SD.stars.lum[i];
    return A.starBolLum(lm, SD.stars.absmag[i], starTempOf(i));
  }
  function exoInHz(j, starIdx) {
    var a = SD.planets.a[j];
    if (a == null || !isFinite(a)) return false;
    var hz = A.hzBand(starBolLum(starIdx));
    return a >= hz.rIn && a <= hz.rOut;
  }

  var searchEntries = PURE.buildSearchEntries(SD, PLANET_LABELS);

  /* ---------------- camera + projection ---------------- */
  var cam = {
    yaw: -0.9, pitch: 0.35, logD: Math.log(15) / Math.LN10,
    cx: 0, cy: 0, cz: 0,
    ppx: 0, ppy: 0                       /* principal point (screen center) */
  };
  var camAnim = null;                    /* {t0, ms, from, to} */
  var FOV_T = Math.tan(27.5 * DEG);      /* fov ~55 degrees */
  /* per-frame basis */
  var camD = 15, fpxV = 500, nearD = 1e-4;
  var camPX = 0, camPY = 0, camPZ = 0;   /* camera position, absolute AU */
  var fX = 0, fY = 0, fZ = 0, rX = 0, rY = 0, rZ = 0, uX = 0, uY = 0, uZ = 0;

  function explorePP() { return { x: W / 2, y: H * 0.5 }; }

  function updateCamBasis() {
    camD = Math.pow(10, cam.logD);
    fpxV = (H * 0.5) / FOV_T;
    nearD = Math.max(1e-6, camD * 1e-3);
    var cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    var cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    var dX = cp * cy, dY = cp * sy, dZ = sp;      /* center -> camera direction */
    camPX = cam.cx + camD * dX;
    camPY = cam.cy + camD * dY;
    camPZ = cam.cz + camD * dZ;
    fX = -dX; fY = -dY; fZ = -dZ;                 /* forward */
    /* right = normalize(cross(forward, worldUp z)) */
    var rx = fY * 1 - fZ * 0, ry = fZ * 0 - fX * 1, rz = 0;
    rx = fY; ry = -fX; rz = 0;
    var rn = Math.sqrt(rx * rx + ry * ry) || 1;
    rX = rx / rn; rY = ry / rn; rZ = 0;
    /* up = cross(right, forward) */
    uX = rY * fZ - rZ * fY;
    uY = rZ * fX - rX * fZ;
    uZ = rX * fY - rY * fX;
  }

  var PRJ = { x: 0, y: 0, z: 0 };        /* reusable projection result */
  function projectPt(x, y, z, out) {
    var px = x - camPX, py = y - camPY, pz = z - camPZ;
    var zc = px * fX + py * fY + pz * fZ;
    if (zc <= nearD) return false;
    var s = fpxV / zc;
    out.x = cam.ppx + (px * rX + py * rY + pz * rZ) * s;
    out.y = cam.ppy - (px * uX + py * uY + pz * uZ) * s;
    out.z = zc;
    return true;
  }
  function camZ(x, y, z) {
    return (x - camPX) * fX + (y - camPY) * fY + (z - camPZ) * fZ;
  }
  /* project a segment with near-plane clipping; returns false if fully behind */
  var SEGA = { x: 0, y: 0, z: 0 }, SEGB = { x: 0, y: 0, z: 0 };
  function projectSeg(ax, ay, az, bx, by, bz) {
    var za = camZ(ax, ay, az), zb = camZ(bx, by, bz);
    var lim = nearD * 1.01;
    if (za <= lim && zb <= lim) return false;
    var t;
    if (za <= lim) {
      t = (lim - za) / (zb - za);
      ax += (bx - ax) * t; ay += (by - ay) * t; az += (bz - az) * t;
    } else if (zb <= lim) {
      t = (lim - zb) / (za - zb);
      bx += (ax - bx) * t; by += (ay - by) * t; bz += (az - bz) * t;
    }
    return projectPt(ax, ay, az, SEGA) && projectPt(bx, by, bz, SEGB);
  }

  function camSnapshot() {
    return { yaw: cam.yaw, pitch: cam.pitch, logD: cam.logD,
             cx: cam.cx, cy: cam.cy, cz: cam.cz, ppx: cam.ppx, ppy: cam.ppy };
  }
  function camApply(s) {
    cam.yaw = s.yaw; cam.pitch = s.pitch; cam.logD = s.logD;
    cam.cx = s.cx; cam.cy = s.cy; cam.cz = s.cz;
    cam.ppx = s.ppx; cam.ppy = s.ppy;
  }
  function camGo(to, ms) {
    var full = {
      yaw: (to.yaw != null) ? to.yaw : cam.yaw,
      pitch: (to.pitch != null) ? to.pitch : cam.pitch,
      logD: (to.logD != null) ? clampN(to.logD, 0.5, 10.1) : cam.logD,
      cx: (to.cx != null) ? to.cx : cam.cx,
      cy: (to.cy != null) ? to.cy : cam.cy,
      cz: (to.cz != null) ? to.cz : cam.cz,
      ppx: (to.ppx != null) ? to.ppx : cam.ppx,
      ppy: (to.ppy != null) ? to.ppy : cam.ppy
    };
    if (reduced || ms === 0) { camApply(full); camAnim = null; return; }
    camAnim = { t0: performance.now(), ms: ms || 1200, from: camSnapshot(), to: full };
  }
  function camStep(now) {
    if (!camAnim) return;
    var k = clampN((now - camAnim.t0) / camAnim.ms, 0, 1);
    var e = easeInOutCubic(k);
    var f = camAnim.from, t = camAnim.to;
    cam.yaw = f.yaw + (t.yaw - f.yaw) * e;
    cam.pitch = f.pitch + (t.pitch - f.pitch) * e;
    cam.logD = f.logD + (t.logD - f.logD) * e;
    cam.cx = f.cx + (t.cx - f.cx) * e;
    cam.cy = f.cy + (t.cy - f.cy) * e;
    cam.cz = f.cz + (t.cz - f.cz) * e;
    cam.ppx = f.ppx + (t.ppx - f.ppx) * e;
    cam.ppy = f.ppy + (t.ppy - f.ppy) * e;
    if (k >= 1) camAnim = null;
  }

  function zoomTargetD(starIdx) {
    var list = starPlanets[starIdx];
    if (list && list.length) {
      var maxA = 0, j;
      for (j = 0; j < list.length; j++) {
        var a = SD.planets.a[list[j]];
        if (a == null || !isFinite(a)) {
          var per = SD.planets.per[list[j]];
          if (per != null && isFinite(per) && per > 0) a = Math.pow(per / 365.25, 2 / 3);
        }
        if (a != null && isFinite(a) && a > maxA) maxA = a;
      }
      if (maxA > 0) return clampN(22 * maxA, 0.6, 160);
    }
    return 3;
  }
  function flyToStar(i, instant) {
    centeredStar = i;
    var pp = explorePP();
    camGo({ cx: starX[i], cy: starY[i], cz: starZ[i],
            logD: Math.log(zoomTargetD(i)) / Math.LN10,
            ppx: pp.x, ppy: pp.y }, instant ? 0 : 1200);
  }
  function flyToPlanet(pi, instant) {
    centeredStar = -1;
    var st = A.planetState(PLANET_KEYS[pi], viewJD);
    var el = A.ELEMENTS[PLANET_KEYS[pi]];
    var pp = explorePP();
    camGo({ cx: st.r[0], cy: st.r[1], cz: st.r[2],
            logD: Math.log(Math.max(0.35, el.a0 * 0.4)) / Math.LN10,
            ppx: pp.x, ppy: pp.y }, instant ? 0 : 1200);
  }
  function flyHome(instant) {
    centeredStar = -1;
    var pp = explorePP();
    camGo({ cx: 0, cy: 0, cz: 0, logD: Math.log(15) / Math.LN10, ppx: pp.x, ppy: pp.y },
          instant ? 0 : 1200);
  }

  /* ---------------- sprites ---------------- */
  var atlas = { dark: null, light: null };
  var galaxy = { dark: null, light: null };
  var BAND_A = [1, 0.85, 0.6];
  var BAND_R = [3.3, 2.35, 1.65];

  function bucketRgb(b) {
    var ci = -0.4 + (b + 0.5) * 0.15;
    return A.kelvinToRgb(A.starTempFromCi(ci));
  }
  function ensureAtlas() {
    var key = isLight() ? 'light' : 'dark';
    if (atlas[key]) return atlas[key];
    var light = key === 'light';
    var cv = document.createElement('canvas');
    cv.width = 512; cv.height = 128;
    var g = cv.getContext('2d');
    var b, row;
    for (b = 0; b < 16; b++) {
      var c = bucketRgb(b);
      var cr = c.r, cg = c.g, cb = c.b;
      if (light) { cr = Math.round(cr * 0.52); cg = Math.round(cg * 0.52); cb = Math.round(cb * 0.55); }
      for (row = 0; row < 4; row++) {
        var rr = BAND_R[row === 3 ? 0 : row];
        var cx0 = b * 32 + 16, cy0 = row * 32 + 16;
        var grad = g.createRadialGradient(cx0, cy0, 0, cx0, cy0, rr * 2.6);
        var core = light ? 'rgba(' + Math.round(cr * 0.7) + ',' + Math.round(cg * 0.7) + ',' + Math.round(cb * 0.7) + ',1)'
                         : 'rgba(255,255,255,0.95)';
        grad.addColorStop(0, core);
        grad.addColorStop(0.3, 'rgba(' + cr + ',' + cg + ',' + cb + ',0.9)');
        grad.addColorStop(1, 'rgba(' + cr + ',' + cg + ',' + cb + ',0)');
        g.fillStyle = grad;
        g.beginPath(); g.arc(cx0, cy0, rr * 2.6, 0, 6.2832); g.fill();
        if (row === 3) {
          /* four tiny diffraction spikes, pre-rendered (mag < 0.5 stars) */
          g.strokeStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',0.6)';
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(cx0 - 14, cy0 + 0.5); g.lineTo(cx0 + 14, cy0 + 0.5);
          g.moveTo(cx0 + 0.5, cy0 - 14); g.lineTo(cx0 + 0.5, cy0 + 14);
          g.stroke();
        }
      }
    }
    atlas[key] = cv;
    return cv;
  }

  var SPR = 1400, R_SPR = 560, MARKER_R = 0.52 * R_SPR;
  function ensureGalaxy() {
    var key = isLight() ? 'light' : 'dark';
    if (galaxy[key]) return galaxy[key];
    var light = key === 'light';
    var cv = document.createElement('canvas');
    cv.width = SPR; cv.height = SPR;
    var g = cv.getContext('2d');
    var cx0 = SPR / 2, cy0 = SPR / 2;
    var rnd = mulberry32(20260726);
    /* halo */
    var halo = g.createRadialGradient(cx0, cy0, 0, cx0, cy0, R_SPR * 1.2);
    halo.addColorStop(0, light ? 'rgba(90,105,140,0.18)' : 'rgba(150,165,200,0.10)');
    halo.addColorStop(0.55, light ? 'rgba(90,105,140,0.07)' : 'rgba(150,165,200,0.045)');
    halo.addColorStop(1, 'rgba(150,165,200,0)');
    g.fillStyle = halo;
    g.fillRect(0, 0, SPR, SPR);
    /* central bar (rotated ellipse) + bulge, warm gold tint */
    g.save();
    g.translate(cx0, cy0);
    g.rotate(0.5);
    g.scale(1, 0.42);
    var barG = g.createRadialGradient(0, 0, 0, 0, 0, 170);
    barG.addColorStop(0, light ? 'rgba(160,124,44,0.55)' : 'rgba(200,164,92,0.5)');
    barG.addColorStop(1, 'rgba(200,164,92,0)');
    g.fillStyle = barG;
    g.beginPath(); g.arc(0, 0, 170, 0, 6.2832); g.fill();
    g.restore();
    var bulge = g.createRadialGradient(cx0, cy0, 0, cx0, cy0, 120);
    bulge.addColorStop(0, light ? 'rgba(160,124,44,0.6)' : 'rgba(232,214,178,0.6)');
    bulge.addColorStop(1, 'rgba(232,214,178,0)');
    g.fillStyle = bulge;
    g.beginPath(); g.arc(cx0, cy0, 120, 0, 6.2832); g.fill();
    /* four log-spiral arms of seeded points */
    var arm, i;
    for (arm = 0; arm < 4; arm++) {
      var th0 = 0.5 + arm * Math.PI / 2;
      for (i = 0; i < 2250; i++) {
        var t = i / 2250;
        var r = 55 * Math.pow(R_SPR / 55, Math.pow(t, 0.92));
        var th = th0 + t * 4.1;
        r *= 1 + (rnd() - 0.5) * 0.22;
        th += (rnd() - 0.5) * 0.24;
        var px = cx0 + r * Math.cos(th), py = cy0 + r * Math.sin(th) * 0.98;
        var al = (0.05 + rnd() * 0.22) * (1 - t * 0.45);
        g.fillStyle = light
          ? 'rgba(52,72,110,' + (al * 1.15).toFixed(3) + ')'
          : 'rgba(195,208,236,' + al.toFixed(3) + ')';
        var sz = rnd() < 0.12 ? 2 : 1;
        g.fillRect(px, py, sz, sz);
      }
    }
    /* dust lanes: dark arcs hugging the inner edge of the arms */
    g.strokeStyle = light ? 'rgba(243,245,248,0.5)' : 'rgba(8,10,14,0.32)';
    g.lineWidth = 9;
    for (arm = 0; arm < 4; arm++) {
      var th1 = 0.28 + arm * Math.PI / 2;
      g.beginPath();
      for (i = 0; i <= 60; i++) {
        var tt = i / 60;
        var rr2 = 70 * Math.pow((R_SPR * 0.8) / 70, tt);
        var a2 = th1 + tt * 3.7;
        var qx = cx0 + rr2 * Math.cos(a2), qy = cy0 + rr2 * Math.sin(a2) * 0.98;
        if (i === 0) g.moveTo(qx, qy); else g.lineTo(qx, qy);
      }
      g.globalAlpha = 0.5;
      g.stroke();
      g.globalAlpha = 1;
    }
    galaxy[key] = cv;
    return cv;
  }

  /* real direction of the galactic center (Sgr A*, RA 17h45.7m Dec -29.0),
     rotated to ecliptic once; 26,000 ly away */
  var GC = (function () {
    var v = A.equToEcl(A.raDecToVec(17.7611, -29.0078, 26000 * LY_AU));
    return { x: v[0], y: v[1], z: v[2] };
  })();
  var GAL_R_AU = 50000 * LY_AU;          /* drawn disc = 100 kly diameter */

  /* ---------------- layout (porkchop rects; ported from mars.js) -------- */
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!cam.ppx && !cam.ppy) { cam.ppx = W / 2; cam.ppy = H * 0.5; }
  }

  function chatClearance() {
    var el = document.getElementById('chat-widget');
    if (!el) return 16;
    var r = el.getBoundingClientRect();
    if (!r.height || r.top >= H) return 16;
    return Math.max(16, Math.round(H - r.top) + 8);
  }

  function cornerBand() {
    var els = [document.getElementById('theme-toggle'), document.getElementById('life-link')];
    var top = Infinity, bot = -Infinity;
    for (var i = 0; i < els.length; i++) {
      if (!els[i]) continue;
      var r = els[i].getBoundingClientRect();
      if (!r.height) continue;
      if (r.top < top) top = r.top;
      if (r.bottom > bot) bot = r.bottom;
    }
    if (!isFinite(top)) return { top: H - 110, bottom: H - 60 };
    return { top: top, bottom: bot };
  }

  function layout() {
    var mobile = W < 1000;
    var phone = W < 600 && H >= 560;
    var shortWide = !phone && H < 520 && W >= 520 && W < 1000;
    var panelReserve = (W >= 600 && panelOpen) ? 330 : 0;
    var botClear = chatClearance();
    var pc, plot, ro, tl;
    if (!mobile) {
      var pcW = Math.min(Math.round(W * 0.40), 460);
      var plotH = Math.round(pcW * 0.58);
      var roH = 92;
      var pcH = plotH + roH;
      pc = { x: W - pcW - panelReserve, y: H - pcH - botClear, w: pcW, h: pcH };
      ro = { x: pc.x, y: pc.y, w: pcW, h: roH };
      plot = { x: pc.x + 48, y: pc.y + roH + 4, w: pcW - 48 - 14, h: plotH - 4 - 26 };
      tl = { x0: 140, x1: Math.max(260, pc.x - 26), y: H - 26 };
    } else if (phone) {
      var band = cornerBand();
      var pcH3 = Math.round(H * 0.42);
      pc = { x: 6, y: H - pcH3 - Math.max(8, botClear - 8), w: W - 12, h: pcH3 };
      ro = { x: pc.x, y: pc.y + pc.h - 52, w: pc.w, h: 52 };
      var plotTop = pc.y + 8;
      var plotBot = Math.min(band.top - 30, ro.y - 26);
      plot = { x: pc.x + 44, y: plotTop, w: pc.w - 44 - 10, h: Math.max(90, plotBot - plotTop) };
      tl = { x0: 16, x1: W - 16, y: pc.y - 22 };
    } else if (shortWide) {
      var pcW2 = Math.round(Math.min(W * 0.56, W - panelReserve - 200));
      var pcX = Math.max(140, W - pcW2 - 8 - panelReserve);
      var top2 = 118;
      if (elPanel) {
        var pr = elPanel.getBoundingClientRect();
        if (pr.height && pr.right > pcX && pr.left < pcX + pcW2) {
          top2 = Math.min(Math.round(H * 0.45), Math.max(top2, Math.round(pr.bottom) + 6));
        }
      }
      pc = { x: pcX, y: top2, w: pcW2, h: H - top2 - 10 };
      ro = { x: pc.x, y: pc.y + pc.h - 46, w: pc.w, h: 46 };
      plot = { x: pc.x + 44, y: pc.y + 8, w: pc.w - 44 - 12, h: Math.max(60, pc.h - 8 - 46 - 22) };
      tl = { x0: 140, x1: Math.max(240, pc.x - 20), y: H - 26 };
    } else {
      /* Docked along the bottom. The plot starts at pc.x + 134 so taps never
         land on the fixed corner buttons (#theme-toggle, #life-link). */
      var pcH2 = Math.round(H * 0.38);
      pc = { x: 6, y: H - pcH2 - Math.max(8, botClear - 8), w: W - 12 - panelReserve, h: pcH2 };
      ro = { x: pc.x, y: pc.y, w: pc.w, h: 46 };
      plot = { x: pc.x + 134, y: pc.y + 50, w: pc.w - 134 - 10, h: pc.h - 50 - 24 };
      tl = { x0: 140, x1: W - 16 - panelReserve, y: pc.y - 22 };
    }
    L = { mobile: mobile, phone: phone, side: shortWide, reserve: panelReserve,
          pc: pc, plot: plot, ro: ro, tl: tl };
    if (mode === 'porkchop' && !camAnim) {
      var fit = fitPork();
      cam.logD = fit.logD; cam.ppx = fit.ppx; cam.ppy = fit.ppy;
    }
  }

  /* top-down camera fit for porkchop mode: the free area left of the panel
     and above the plot (the docked branch must also clear the panel) */
  function fitPork() {
    var elE = A.elementsRad('earth', jdToday);
    var elT = A.elementsRad(pcTarget, jdToday);
    var rFit = Math.max(elE.a * (1 + elE.e), elT.a * (1 + elT.e)) * 1.12;
    var x0 = 10;
    var x1 = (L.mobile && !L.side) ? Math.max(x0 + 60, W - 10 - L.reserve)
                                   : Math.max(x0 + 60, L.pc.x - 10);
    var y0 = Math.max(90, H * 0.16), y1 = L.tl.y - 30;
    if (y1 < y0 + 60) y1 = y0 + 60;
    var half = Math.max(40, Math.min(x1 - x0, y1 - y0) / 2);
    var fpx = (H * 0.5) / FOV_T;
    return {
      logD: Math.log(Math.max(1, fpx * rFit / half)) / Math.LN10,
      ppx: (x0 + x1) / 2, ppy: (y0 + y1) / 2
    };
  }

  /* ---------------- orbit caches ---------------- */
  var orbitPts = {};
  function orbitOf(key) {
    if (!orbitPts[key]) {
      var pts = A.orbitPoints(key, jdToday, 128);
      var flat = new Float64Array(pts.length * 3);
      for (var k = 0; k < pts.length; k++) {
        flat[k * 3] = pts[k][0]; flat[k * 3 + 1] = pts[k][1]; flat[k * 3 + 2] = pts[k][2];
      }
      orbitPts[key] = flat;
    }
    return orbitPts[key];
  }

  /* ---------------- porkchop machinery (ported from mars.js) ------------ */
  function specOf(key) {
    if (!specs[key]) specs[key] = A.porkchopSpec(key, jd0);
    return specs[key];
  }
  function tlRange() {
    var sp = specOf(pcTarget);
    return { min: sp.jd0, max: sp.depMax + sp.tofMax };
  }
  function selInfo() {
    var s = pcSel[pcTarget];
    if (!s) return null;
    var sp = specOf(pcTarget);
    var dep = sp.jd0 + s.i * sp.depStep;
    var tof = sp.tof0 + s.j * sp.tofStep;
    var key = pcTarget + ':' + s.i + ':' + s.j;
    if (!(key in readoutCache)) readoutCache[key] = A.missionDv(dep, tof, pcTarget);
    return { dep: dep, tof: tof, m: readoutCache[key] };
  }
  function updateGhost(info) {
    if (!info || !info.m) { ghost = null; return; }
    var NP = 72, pts = [];
    for (var k = 0; k <= NP; k++) {
      pts.push(A.propagateKepler(info.m.rDep, info.m.v1, info.tof * k / NP).r);
    }
    ghost = { pts: pts, dep: info.dep, arr: info.dep + info.tof, rDep: info.m.rDep, rArr: info.m.rArr };
  }
  function pcLiveStatus(info) {
    if (!info) return;
    var txt = info.m
      ? ('Depart ' + fmtDate(info.dep) + ' · ' + info.tof + ' days · ' + info.m.total.toFixed(1) + ' km/s total')
      : 'No transfer solution at this spot.';
    liveStatusText(txt);
  }
  function setPcSel(i, j, force) {
    var s = pcSel[pcTarget];
    if (s && s.i === i && s.j === j && !force) return;
    pcSel[pcTarget] = { i: i, j: j };
    cancelPcCruise();
    arrivedPulse = 0;
    if (btnLaunch) btnLaunch.textContent = 'Launch';
    var info = selInfo();
    if (info) {
      viewJD = info.dep;
      updateGhost(info);
      pcLiveStatus(info);
    }
  }
  function cancelPcCruise() {
    if (pcCruise) pcCruise = null;
  }
  function announceArrival(info) {
    setStatus('Arrived ' + fmtDate(info.dep + info.tof) + ' · ' + info.tof + ' days · ' +
              info.m.total.toFixed(1) + ' km/s total');
  }
  function pcLaunch() {
    var info = selInfo();
    if (!info) { setStatus('Pick a spot on the map first.'); return; }
    if (!info.m) { setStatus('No transfer solution here. Pick a brighter cell.'); return; }
    attract = false;
    arrivedPulse = 0;
    if (reduced) {
      cancelPcCruise();
      viewJD = info.dep + info.tof;
      announceArrival(info);
      if (btnLaunch) btnLaunch.textContent = 'Replay';
      return;
    }
    pcCruise = { info: info, t0: performance.now(), ms: 8000, trail: [] };
    setStatus('Cruising to ' + PLANET_LABELS[PLANET_KEYS.indexOf(pcTarget)] + '.');
    if (btnLaunch) btnLaunch.textContent = 'Launch';
  }
  function nextWindow() {
    var job = jobs[pcTarget];
    if (!job || !job.done) { setStatus('Still computing the map. One moment.'); return; }
    attract = false;
    var sp = specOf(pcTarget);
    var s = pcSel[pcTarget];
    var curDep = s ? sp.jd0 + s.i * sp.depStep : -Infinity;
    var limit = curDep + 200;
    var best = null, bestDv = Infinity, gbest = null, gbestDv = Infinity;
    for (var i = 0; i < sp.nDep; i++) {
      var dep = sp.jd0 + i * sp.depStep;
      for (var j = 0; j < sp.nTof; j++) {
        var dv = job.total[i * sp.nTof + j];
        if (!isFinite(dv)) continue;
        if (dv < gbestDv) { gbestDv = dv; gbest = { i: i, j: j }; }
        if (dep > limit && dv < bestDv) { bestDv = dv; best = { i: i, j: j }; }
      }
    }
    var pick = best || gbest;
    if (!pick) return;
    setPcSel(pick.i, pick.j, true);
    var name = PLANET_LABELS[PLANET_KEYS.indexOf(pcTarget)];
    var months = Math.round(A.synMonths(pcTarget));
    var info = selInfo();
    ariaLast = performance.now();
    ariaPend = null;
    setStatus('Earth and ' + name + ' line up like this about every ' + months + ' months.' +
      (info && info.m ? (' Depart ' + fmtDate(info.dep) + ' · ' + info.m.total.toFixed(1) + ' km/s total.') : ''));
  }

  function renderPcCache() {
    var job = jobs[pcTarget];
    if (!job || !L) return;
    var sp = job.spec, n = sp.nDep, m = sp.nTof;
    var cw = Math.max(2, Math.round(L.plot.w * dpr));
    var chh = Math.max(2, Math.round(L.plot.h * dpr));
    if (!pcCache) pcCache = document.createElement('canvas');
    if (pcCache.width !== cw || pcCache.height !== chh) { pcCache.width = cw; pcCache.height = chh; }
    var g = pcCache.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cw, chh);

    var light = isLight();
    var cell = document.createElement('canvas');
    cell.width = n; cell.height = m;
    var cg = cell.getContext('2d');
    var img = cg.createImageData(n, m);
    var i, j, idx;
    for (i = 0; i < n; i++) {
      for (j = 0; j < m; j++) {
        idx = i * m + j;
        if (idx >= job.doneCount) continue;
        var p = ((m - 1 - j) * n + i) * 4;
        var dv = job.total[idx];
        if (isNaN(dv)) {
          img.data[p] = 127; img.data[p + 1] = 127; img.data[p + 2] = 127;
          img.data[p + 3] = light ? 34 : 46;
        } else {
          var c = dvColor(dv, light);
          img.data[p] = c[0]; img.data[p + 1] = c[1]; img.data[p + 2] = c[2];
          img.data[p + 3] = 255;
        }
      }
    }
    cg.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(cell, 0, 0, n, m, 0, 0, cw, chh);
    cell.width = 0;

    var sx = cw / n, sy = chh / m;
    g.strokeStyle = light ? 'rgba(255,255,255,0.55)' : 'rgba(10,12,16,0.5)';
    g.lineWidth = Math.max(1, 0.7 * dpr);
    g.beginPath();
    function band(q) { var v = job.total[q]; return isNaN(v) ? -999 : Math.floor(Math.min(14, v)); }
    for (i = 0; i < n; i++) {
      for (j = 0; j < m; j++) {
        idx = i * m + j;
        if (idx >= job.doneCount) continue;
        var b0 = band(idx);
        if (b0 === -999) continue;
        if (i + 1 < n && (i + 1) * m + j < job.doneCount) {
          var b1 = band((i + 1) * m + j);
          if (b1 !== -999 && b1 !== b0) {
            var xv = (i + 1) * sx, yv = (m - 1 - j) * sy;
            g.moveTo(xv, yv); g.lineTo(xv, yv + sy);
          }
        }
        if (j + 1 < m && idx + 1 < job.doneCount) {
          var b2 = band(idx + 1);
          if (b2 !== -999 && b2 !== b0) {
            var yh = (m - 1 - j) * sy, xh = i * sx;
            g.moveTo(xh, yh); g.lineTo(xh + sx, yh);
          }
        }
      }
    }
    g.stroke();

    if (job.done && job.minI >= 0) {
      var mx = (job.minI + 0.5) * sx, my = (m - 1 - job.minJ + 0.5) * sy;
      g.strokeStyle = light ? 'rgba(38,38,38,0.9)' : 'rgba(233,239,246,0.95)';
      g.lineWidth = 1.4 * dpr;
      g.beginPath(); g.arc(mx, my, 5.5 * dpr, 0, 6.2832); g.stroke();
      g.font = (10.5 * dpr) + 'px ' + FONT;
      g.textBaseline = 'middle';
      var lbl = 'min ' + job.minDv.toFixed(1) + ' km/s';
      var onRight = mx < cw - 78 * dpr;
      g.textAlign = onRight ? 'left' : 'right';
      g.fillStyle = light ? 'rgba(38,38,38,0.85)' : 'rgba(233,239,246,0.9)';
      g.fillText(lbl, mx + (onRight ? 9 : -9) * dpr, my);
    }
    pcDirty = false;
  }

  /* ---------------- porkchop enter / exit ---------------- */
  function enterPorkchop(pi, instant) {
    var key = PLANET_KEYS[pi];
    if (key === 'earth') return;
    cancelStarCruise(true);
    closeCard();
    if (mode !== 'porkchop') camBefore = camSnapshot();
    pcTarget = key;
    sel = { kind: 'p', idx: pi };
    selExo = -1;
    centeredStar = -1;
    specOf(key);
    if (!jobs[key]) jobs[key] = A.makePorkchopJob(specs[key]);
    pcCache = null; pcDirty = true; lastPcPaint = 0;
    ghost = null;
    layout();                            /* mode flips after: no camera snap */
    var fit = fitPork();
    mode = 'porkchop';
    camGo({ pitch: 1.25, logD: fit.logD, cx: 0, cy: 0, cz: 0,
            ppx: fit.ppx, ppy: fit.ppy }, instant ? 0 : 1200);
    var s = pcSel[key];
    if (s) {
      var info = selInfo();
      if (info) { viewJD = info.dep; updateGhost(info); pcLiveStatus(info); }
    } else {
      var r = tlRange();
      viewJD = clampN(viewJD, r.min, Math.min(r.max, JD_2050));
      setStatus('Computing the ' + PLANET_LABELS[pi] + ' map.');
    }
    updatePanelMode();
    updateTargetLine();
  }
  function exitPorkchop() {
    if (mode !== 'porkchop') return;
    cancelPcCruise();
    mode = 'explore';
    viewJD = jdToday;   /* back to honest present-day positions */
    var pi = sel ? sel.idx : -1;
    if (camBefore) { camGo(camBefore, 1200); camBefore = null; }
    else flyHome(false);
    updatePanelMode();
    if (pi >= 0) openCardFor({ kind: 'p', idx: pi });
    setStatus('Back to the sky.');
  }
  function updatePanelMode() {
    var pk = mode === 'porkchop';
    if (elPcRow) elPcRow.hidden = !pk;
    if (elWinDetails) {
      elWinDetails.hidden = !pk;
      if (pk && pcTarget) {
        var pi = PLANET_KEYS.indexOf(pcTarget);
        var syn = Math.round(A.synMonths(pcTarget));
        var py = A.periodYears(pcTarget);
        var perTxt = (py * 12 <= 36) ? ('about ' + Math.round(py * 12) + ' months')
                                     : ('about ' + Math.round(py) + ' years');
        if (elWinSum) elWinSum.textContent = 'Why every ' + syn + ' months?';
        if (elWinText) {
          elWinText.textContent = 'Earth circles the Sun in about 12 months, ' +
            PLANET_LABELS[pi] + ' in ' + perTxt +
            '. The cheap transfer geometry only works when the two planets line up the right way, ' +
            'and that lineup repeats about every ' + syn + ' months (the synodic period). ' +
            'That is why missions leave in bunches.';
        }
      }
    }
  }

  /* ---------------- selection / cards ---------------- */
  function bodyLabel(s) {
    if (!s) return null;
    return s.kind === 'p' ? PLANET_LABELS[s.idx] : starName(s.idx);
  }
  function updateTargetLine() {
    if (!elTarget) return;
    if (mode === 'porkchop' && pcTarget) {
      elTarget.textContent = 'Trip: Earth to ' + PLANET_LABELS[PLANET_KEYS.indexOf(pcTarget)] + '.';
      return;
    }
    if (!sel) {
      elTarget.textContent = 'Pick a destination: tap a planet or a star, or search above.';
      return;
    }
    if (sel.kind === 'p') {
      elTarget.textContent = 'Selected: ' + PLANET_LABELS[sel.idx] + '.';
    } else {
      elTarget.textContent = 'Selected: ' + starName(sel.idx) + ' · ' +
        PURE.distPhrase(starLyD[sel.idx]) + '.';
    }
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function cardOpen() { return !!(cardEl && !cardEl.hidden); }
  function closeCard() {
    if (cardEl) { cardEl.hidden = true; cardEl.innerHTML = ''; }
    document.body.classList.remove('voy-sheet-open');
    arriveInfo = null;   /* the arrival banner is for the moment of arrival */
  }

  function deselect() {
    sel = null; selExo = -1;
    closeCard();
    updateTargetLine();
  }

  function selectBody(s, opts) {
    opts = opts || {};
    cancelStarCruise(true);
    if (arriveInfo && (s.kind !== 's' || arriveInfo.star !== s.idx)) arriveInfo = null;
    if (mode === 'porkchop') { /* mutual exclusion: no cards inside porkchop */
      return;
    }
    sel = { kind: s.kind, idx: s.idx };
    if (s.kind !== 's' || opts.keepExo !== true) selExo = -1;
    if (opts.exo != null) selExo = opts.exo;
    updateTargetLine();
    if (opts.fly) {
      if (s.kind === 'p') flyToPlanet(s.idx, !!opts.instant);
      else flyToStar(s.idx, !!opts.instant);
    }
    if (opts.openCard !== false) openCardFor(sel, opts);
    var lbl = bodyLabel(sel);
    if (s.kind === 's') {
      setStatus('Selected ' + lbl + ', ' + PURE.distPhrase(starLyD[s.idx]) + ' away.');
    } else {
      setStatus('Selected ' + lbl + '.');
    }
  }

  function zoomToBody(s) {
    if (s.kind === 'p') flyToPlanet(s.idx, false);
    else flyToStar(s.idx, false);
  }

  /* ---- card builders ---- */
  function cardHead(title, sub) {
    var head = el('div', 'voy-card__head');
    var twrap = el('div', 'voy-card__titles');
    twrap.appendChild(el('span', 'voy-card__title', title));
    if (sub) twrap.appendChild(el('span', 'voy-card__sub', sub));
    head.appendChild(twrap);
    var close = el('button', 'voy-card__close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', function () { closeCard(); });
    head.appendChild(close);
    return head;
  }

  function openCardFor(s, opts) {
    opts = opts || {};
    if (!cardEl) return;
    /* on phones the card is a full-width bottom sheet; an expanded panel
       would sit on top of it, so tuck the panel away first. The body class
       hides the corner buttons under the sheet (CSS is ≤768px-scoped). */
    if (W <= 768 && panelUi && !panelUi.collapsed()) panelUi.setCollapsed(true);
    document.body.classList.add('voy-sheet-open');
    cardEl.innerHTML = '';
    cardEl.hidden = false;
    if (s.kind === 'p') buildPlanetCard(s.idx);
    else buildStarCard(s.idx, opts);
    cardEl.setAttribute('aria-label', 'About ' + bodyLabel(s));
  }

  function buildPlanetCard(pi) {
    var key = PLANET_KEYS[pi], lbl = PLANET_LABELS[pi];
    cardEl.appendChild(cardHead(lbl, 'planet'));
    var body = el('div', 'voy-card__body');
    if (key === 'earth') {
      body.appendChild(el('p', 'voy-fact', 'You are here.'));
    } else {
      var rE = A.planetState('earth', jdToday).r;
      var rT = A.planetState(key, jdToday).r;
      var dAU = Math.sqrt(Math.pow(rT[0] - rE[0], 2) + Math.pow(rT[1] - rE[1], 2) + Math.pow(rT[2] - rE[2], 2));
      var kmM = dAU * A.AU_KM / 1e6;
      var kmTxt = kmM >= 1000 ? ('about ' + (Math.round(kmM / 100) / 10) + ' billion km')
                              : ('about ' + Math.round(kmM) + ' million km');
      body.appendChild(el('p', 'voy-fact',
        'Right now it is ' + (Math.round(dAU * 100) / 100) + ' AU from Earth, ' + kmTxt + '.'));
    }
    var py = A.periodYears(key);
    var perTxt = py * 365.25 < 800 ? (Math.round(py * 365.25) + ' days') :
      ((py < 10 ? Math.round(py * 10) / 10 : Math.round(py)) + ' years');
    body.appendChild(el('p', 'voy-fact', 'It orbits the Sun every ' + perTxt + '.'));
    var row = el('div', 'voy-actions');
    if (key !== 'earth') {
      var plan = el('button', 'voy-btn voy-btn--primary', 'Plan the trip');
      plan.type = 'button';
      plan.addEventListener('click', function () { enterPorkchop(pi, false); });
      row.appendChild(plan);
    }
    var zoom = el('button', 'voy-btn', 'Zoom to it');
    zoom.type = 'button';
    zoom.addEventListener('click', function () { flyToPlanet(pi, false); });
    row.appendChild(zoom);
    body.appendChild(row);
    cardEl.appendChild(body);
  }

  function buildStarCard(i, opts) {
    var st = SD.stars;
    var name = st.name[i];
    var sub = st.hip[i] && name !== 'HIP ' + st.hip[i] ? 'HIP ' + st.hip[i] : '';
    cardEl.appendChild(cardHead(name, sub));
    var body = el('div', 'voy-card__body');

    /* arrival summary (present only right after a cruise) */
    if (arriveInfo && arriveInfo.star === i) {
      var av = el('div', 'voy-arrive');
      av.appendChild(el('p', 'voy-arrive__line',
        'Arrived. On the ship: ' + PURE.fmtYears(arriveInfo.shipYears) +
        '. On Earth it is now ' + arriveInfo.earthYear + '.'));
      var arow = el('div', 'voy-actions');
      var rep = el('button', 'voy-btn', 'Replay');
      rep.type = 'button';
      rep.addEventListener('click', function () { startStarCruise(i); });
      var back = el('button', 'voy-btn', 'Back');
      back.type = 'button';
      back.addEventListener('click', function () {
        arriveInfo = null;
        openCardFor({ kind: 's', idx: i });
      });
      arow.appendChild(rep); arow.appendChild(back);
      av.appendChild(arow);
      body.appendChild(av);
    }

    var T = starTempOf(i);
    var lumV = A.starLumV(st.absmag[i]);
    var lb = starBolLum(i);
    var radius = A.starRadiusSun(lb, T);
    var words = A.spectWords(st.sp[i], lumV);
    body.appendChild(el('p', 'voy-fact',
      words + (st.sp[i] ? ' (type ' + st.sp[i] + ')' : '') + '.'));
    body.appendChild(el('p', 'voy-fact',
      PURE.distPhrase(starLyD[i]) + ' away; ' +
      PURE.lightPhrase(starLyD[i], thisYearFrac) + '.'));
    /* no invented facts: a star with no measured/derived temperature (the
       pulsar, brown dwarfs) simply has no temperature or size line */
    if (isFinite(T)) {
      var tline = el('p', 'voy-fact');
      var rgb = A.kelvinToRgb(T);
      var sw = el('span', 'voy-swatch');
      sw.style.background = 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';
      tline.appendChild(sw);
      tline.appendChild(document.createTextNode(
        ' Surface about ' + PURE.fmtInt(Math.round(T / 100) * 100) + ' K.'));
      body.appendChild(tline);
    }
    var sz = isFinite(radius) ? PURE.sizeVsSun(radius) : null;
    if (sz) body.appendChild(el('p', 'voy-fact', 'Its width: ' + sz + '.'));
    var mw = PURE.magWords(st.mag[i]);
    if (mw) body.appendChild(el('p', 'voy-fact', 'From Earth it ' + mw + '.'));

    /* exoplanet chips */
    var list = starPlanets[i];
    if (list && list.length) {
      body.appendChild(el('p', 'voy-fact voy-fact--chips',
        list.length === 1 ? 'One known planet:' : list.length + ' known planets:'));
      var chips = el('div', 'voy-chips');
      for (var k = 0; k < list.length; k++) {
        (function (j) {
          var p = exoObj(j);
          var inHz = exoInHz(j, i);
          var chip = el('button', 'voy-chip');
          chip.type = 'button';
          chip.id = 'voy-chip-' + j;
          chip.setAttribute('aria-expanded', 'false');
          chip.appendChild(el('span', 'voy-chip__name', p.name));
          chip.appendChild(el('span', 'voy-chip__line', PURE.chipLine(p, inHz)));
          var det = el('div', 'voy-chipbody');
          det.hidden = true;
          var lines = PURE.chipDetail(p, inHz);
          for (var q = 0; q < lines.length; q++) det.appendChild(el('p', null, lines[q]));
          chip.addEventListener('click', function () {
            var open = det.hidden;
            det.hidden = !open;
            chip.setAttribute('aria-expanded', open ? 'true' : 'false');
            selExo = open ? j : -1;
          });
          chips.appendChild(chip);
          chips.appendChild(det);
          if (opts && opts.exo === j) {
            det.hidden = false;
            chip.setAttribute('aria-expanded', 'true');
          }
        })(list[k]);
      }
      body.appendChild(chips);
      body.appendChild(el('p', 'voy-note',
        'Orbit sizes are real; positions on them are not.'));
    }

    var row = el('div', 'voy-actions');
    var plan = el('button', 'voy-btn voy-btn--primary', 'Plan the trip');
    plan.type = 'button';
    var zoom = el('button', 'voy-btn', 'Zoom to it');
    zoom.type = 'button';
    zoom.addEventListener('click', function () { flyToStar(i, false); });
    row.appendChild(plan); row.appendChild(zoom);
    body.appendChild(row);

    /* trip section, revealed by Plan the trip */
    var trip = buildTripSection(i);
    trip.hidden = true;
    body.appendChild(trip);
    plan.addEventListener('click', function () {
      trip.hidden = false;
      plan.disabled = true;
      updateTripLive(i);
      trip.scrollIntoView({ block: 'nearest' });
    });
    if (opts && opts.trip) {
      trip.hidden = false;
      plan.disabled = true;
      updateTripLive(i);
    }
    cardEl.appendChild(body);
  }

  var tripEls = null;                     /* live nodes of the open trip section */
  function buildTripSection(i) {
    var dLy = starLyD[i];
    var wrap = el('div', 'voy-trip');
    wrap.appendChild(el('p', 'voy-trip__title', 'Getting there'));
    var tbl = el('table', 'voy-trip__table');
    var thead = el('thead');
    var hr = el('tr');
    hr.appendChild(el('th', null, 'how'));
    hr.appendChild(el('th', null, 'travel time'));
    hr.appendChild(el('th', null, 'notes'));
    thead.appendChild(hr);
    tbl.appendChild(thead);
    var tb = el('tbody');
    var rows = A.coastTimes(dLy);
    for (var k = 0; k < rows.length; k++) {
      var tr = el('tr');
      tr.appendChild(el('td', null, rows[k].name));
      tr.appendChild(el('td', null, PURE.fmtYears(rows[k].years)));
      tr.appendChild(el('td', 'voy-trip__note', rows[k].note));
      tb.appendChild(tr);
    }
    var hlr = el('tr', 'voy-trip__row--hl');
    var hlName = el('td', null, 'Constant 1 g ship');
    var hlTime = el('td', null, '');
    hlr.appendChild(hlName);
    hlr.appendChild(hlTime);
    hlr.appendChild(el('td', 'voy-trip__note', 'accelerates halfway, flips, brakes; actually stops there'));
    tb.appendChild(hlr);
    tbl.appendChild(tb);
    wrap.appendChild(tbl);

    function seg(labels, cur, onPick, aria) {
      var g = el('div', 'voy-seg');
      g.setAttribute('role', 'group');
      g.setAttribute('aria-label', aria);
      var btns = [];
      for (var q = 0; q < labels.length; q++) {
        (function (qi) {
          var b = el('button', 'voy-seg__btn' + (qi === cur ? ' voy-seg__btn--on' : ''), labels[qi]);
          b.type = 'button';
          b.setAttribute('aria-pressed', qi === cur ? 'true' : 'false');
          b.addEventListener('click', function () {
            for (var w = 0; w < btns.length; w++) {
              btns[w].classList.toggle('voy-seg__btn--on', w === qi);
              btns[w].setAttribute('aria-pressed', w === qi ? 'true' : 'false');
            }
            onPick(qi);
          });
          btns.push(b);
          g.appendChild(b);
        })(q);
      }
      return g;
    }
    wrap.appendChild(seg(['0.3 g', '1 g', '2 g'], accelIdx, function (q) {
      accelIdx = q; updateTripLive(i);
    }, 'Acceleration'));
    wrap.appendChild(seg(['probe 1 t', 'crewed 1,000 t', 'generation 1,000,000 t'], shipIdx, function (q) {
      shipIdx = q; updateTripLive(i);
    }, 'Ship'));

    var peak = el('p', 'voy-live');
    var energy = el('p', 'voy-live');
    var photon = el('p', 'voy-live');
    wrap.appendChild(peak);
    wrap.appendChild(energy);
    wrap.appendChild(photon);
    wrap.appendChild(el('p', 'voy-warp',
      "The Alcubierre warp idea fits general relativity's equations but needs negative " +
      'energy nobody knows how to make, so it has no honest travel time.'));
    var launch = el('button', 'voy-btn voy-btn--primary', 'Launch');
    launch.type = 'button';
    launch.addEventListener('click', function () { startStarCruise(i); });
    wrap.appendChild(launch);
    tripEls = { name: hlName, time: hlTime, peak: peak, energy: energy, photon: photon, star: i };
    return wrap;
  }
  function updateTripLive(i) {
    if (!tripEls || tripEls.star !== i) return;
    var dLy = starLyD[i];
    var g = A.ACCEL_PRESETS[accelIdx];
    var b = A.brachistochrone(dLy, g);
    var en = A.voyageEnergy(dLy, g, A.SHIP_PRESETS[shipIdx].massKg);
    tripEls.name.textContent = 'Constant ' + g + ' g ship';
    tripEls.time.textContent = PURE.fmtYears(b.shipYears) + ' on the ship, ' +
      PURE.fmtYears(b.earthYears) + ' on Earth';
    tripEls.peak.textContent = 'Peak speed ' + PURE.fmtSpeedC(b.vPeakC) + 'c (γ = ' +
      PURE.fmtGamma(b.gammaPeak) + ').';
    tripEls.energy.textContent = 'Energy for the trip: ' + PURE.fmtJoules(en.joules) + ', ' +
      PURE.energyPhrase(en.worldYears) + '.';
    var fuel = PURE.fuelAmount(en.massRatio);
    tripEls.photon.textContent = fuel
      ? 'Even a perfect photon rocket would need about ' + fuel + ' kg of fuel for every kg that arrives.'
      : '';
  }

  /* ---------------- star cruise ---------------- */
  function startStarCruise(i) {
    var dLy = starLyD[i];
    if (!(dLy > 0)) return;
    arriveInfo = null;
    var g = A.ACCEL_PRESETS[accelIdx];
    var a = g * A.A_LYYR2_PER_G;
    var tot = PURE.cruiseTotals(dLy, a);
    var n = Math.sqrt(starX[i] * starX[i] + starY[i] * starY[i] + starZ[i] * starZ[i]) || 1;
    cruiseSt = {
      star: i, dLy: dLy, a: a, g: g,
      tauTotal: tot.tauTotal, tTotal: tot.tTotal,
      ux: starX[i] / n, uy: starY[i] / n, uz: starZ[i] / n,
      t0: performance.now(), ms: 10000, cp: null
    };
    closeCard();
    camAnim = null;
    mode = 'cruise';
    setStatus('Cruising to ' + starName(i) + '. Watch the two clocks.');
    if (reduced) { arriveStar(); return; }
  }
  function arriveStar() {
    if (!cruiseSt) return;
    var i = cruiseSt.star;
    arriveInfo = {
      star: i,
      shipYears: cruiseSt.tauTotal,
      earthYears: cruiseSt.tTotal,
      earthYear: Math.round(thisYearFrac + cruiseSt.tTotal)
    };
    cruiseSt = null;
    mode = 'explore';
    starPulse = performance.now();
    flyToStar(i, false);                /* settle into the close-up */
    openCardFor({ kind: 's', idx: i }, { trip: true });
    setStatus('Arrived at ' + starName(i) + '. On the ship: ' +
      PURE.fmtYears(arriveInfo.shipYears) + '. On Earth it is now ' + arriveInfo.earthYear + '.');
  }
  function cancelStarCruise(silent) {
    if (mode !== 'cruise' || !cruiseSt) { cruiseSt = null; return; }
    var i = cruiseSt.star;
    cruiseSt = null;
    mode = 'explore';
    if (silent) return;                 /* a follow-up action takes over */
    flyToStar(i, reduced);
    openCardFor({ kind: 's', idx: i }, { trip: true });
    setStatus('Cruise cancelled.');
  }

  /* ---------------- intro ---------------- */
  function startIntro() {
    mode = 'intro';
    introSt = { t0: performance.now() };
    cam.yaw = -0.9; cam.pitch = 0.35;
    cam.logD = Math.log(15) / Math.LN10;
    cam.cx = 0; cam.cy = 0; cam.cz = 0;
    var pp = explorePP();
    cam.ppx = pp.x; cam.ppy = pp.y;
    tagStart = null; tagKill = null;
  }
  function endIntro() {
    if (mode !== 'intro') return;
    mode = 'explore';
    introSt = null;
    viewJD = jdToday;   /* the intro tick is purely visual; explore shows TODAY */
    if (tagStart != null && tagKill == null) tagKill = performance.now();
  }
  function skipIntroTo(logD) {
    mode = 'explore';
    introSt = null;
    viewJD = jdToday;
    attract = false;
    tagStart = null;
    cam.yaw = -0.9; cam.pitch = 0.35;
    cam.logD = logD;
    cam.cx = 0; cam.cy = 0; cam.cz = 0;
    var pp = explorePP();
    cam.ppx = pp.x; cam.ppy = pp.y;
  }
  function introStep(now) {
    if (!introSt) return;
    var t = now - introSt.t0;
    if (t < 1200) {
      /* hold: planets tick along their real orbits */
    } else if (t < 7200) {
      var k = easeInOutCubic((t - 1200) / 6000);
      cam.logD = 1.176 + (6.3 - 1.176) * k;
      if (t >= 4200 && tagStart == null) tagStart = now;
    } else {
      cam.logD = 6.3;
      endIntro();
    }
  }
  function drawTagline(now) {
    if (tagStart == null) return;
    var t = now - tagStart;
    var a = Math.min(1, t / 600) * (1 - ramp(t, 3000, 3600));
    if (tagKill != null) a *= 1 - clampN((now - tagKill) / 400, 0, 1);
    if (a <= 0.01) {
      if (t > 3600 || tagKill != null) { tagStart = null; tagKill = null; }
      return;
    }
    ctx.font = '26px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = textColor(0.92 * a);
    ctx.fillText('Where do you want to go?', W / 2, H * 0.42);
    ctx.textAlign = 'left';
  }

  /* ---------------- drawing ---------------- */
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawGalaxy(ga) {
    var spr = ensureGalaxy();
    var O = { x: 0, y: 0, z: 0 }, C = { x: 0, y: 0, z: 0 };
    if (!projectPt(0, 0, 0, O) || !projectPt(GC.x, GC.y, GC.z, C)) return;
    var dx = O.x - C.x, dy = O.y - C.y;
    var distPx = Math.sqrt(dx * dx + dy * dy);
    if (!(distPx > 0.5)) return;
    var scale = distPx / MARKER_R;
    var ang = Math.atan2(dy, dx);
    ctx.save();
    ctx.globalAlpha = ga;
    ctx.translate(C.x, C.y);
    ctx.rotate(ang);
    ctx.scale(scale, scale);
    ctx.drawImage(spr, -SPR / 2, -SPR / 2);
    ctx.restore();
    ctx.globalAlpha = 1;
    /* "you are here": accent ring exactly on the solar system's projection */
    ctx.strokeStyle = accent();
    ctx.globalAlpha = 0.9 * ga;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(O.x, O.y, 6, 0, 6.2832); ctx.stroke();
    ctx.font = '12px ' + FONT;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = accent();
    var ly2 = Math.max(130, O.y);
    ctx.fillText('you are here', O.x + 12, ly2);
    ctx.globalAlpha = 1;
    /* the honest caption */
    if (ga > 0.4) {
      ctx.font = '12px ' + FONT;
      ctx.textAlign = 'center';
      ctx.fillStyle = textColor(0.6 * ga);
      ctx.fillText('The galaxy here is an illustration, roughly to scale. Every clickable star is real.',
        W / 2, H - 44);
      ctx.textAlign = 'left';
    }
  }

  function drawStars(sa) {
    var at = ensureAtlas();
    var b, k, i, n;
    var m = 16;                          /* offscreen margin */
    for (b = 0; b < 3; b++) {
      var list = bandLists[b];
      n = list.length;
      ctx.globalAlpha = sa * BAND_A[b];
      for (k = 0; k < n; k++) {
        i = list[k];
        var px = starX[i] - camPX, py = starY[i] - camPY, pz = starZ[i] - camPZ;
        var zc = px * fX + py * fY + pz * fZ;
        if (zc <= nearD) { scrOk[i] = 0; continue; }
        var s = fpxV / zc;
        var sx2 = cam.ppx + (px * rX + py * rY) * s;   /* rZ = 0 always */
        var sy2 = cam.ppy - (px * uX + py * uY + pz * uZ) * s;
        if (sx2 < -m || sx2 > W + m || sy2 < -m || sy2 > H + m) { scrOk[i] = 0; continue; }
        scrX[i] = sx2; scrY[i] = sy2; scrOk[i] = 1;
        ctx.drawImage(at, starCellX[i], starCellY[i], 32, 32, sx2 - 8, sy2 - 8, 16, 16);
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawSun(D) {
    var P = PRJ;
    if (!projectPt(0, 0, 0, P)) return null;
    var size = clampN(fpxV * 0.00465 / D, 2, 26);
    var glow = ctx.createRadialGradient(P.x, P.y, 0, P.x, P.y, size * 5);
    if (isLight()) {
      glow.addColorStop(0, 'rgba(160,124,44,0.5)'); glow.addColorStop(1, 'rgba(160,124,44,0)');
    } else {
      glow.addColorStop(0, 'rgba(245,238,216,0.5)'); glow.addColorStop(1, 'rgba(245,238,216,0)');
    }
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(P.x, P.y, size * 5, 0, 6.2832); ctx.fill();
    ctx.fillStyle = isLight() ? 'rgba(160,124,44,0.9)' : 'rgba(245,238,216,0.95)';
    ctx.beginPath(); ctx.arc(P.x, P.y, size, 0, 6.2832); ctx.fill();
    return { x: P.x, y: P.y };
  }

  var planetScr = [];                     /* per-frame planet screens */
  (function () { for (var i = 0; i < 8; i++) planetScr.push({ ok: false, x: 0, y: 0 }); })();

  function drawPolyline(flat, alpha, color, lw) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = lw || 1;
    ctx.beginPath();
    var open = false;
    var P = PRJ;
    for (var k = 0; k < flat.length; k += 3) {
      if (projectPt(flat[k], flat[k + 1], flat[k + 2], P)) {
        if (!open) { ctx.moveTo(P.x, P.y); open = true; }
        else ctx.lineTo(P.x, P.y);
      } else open = false;
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawSolar(pa, now) {
    var i;
    var labels = [];
    var inPork = mode === 'porkchop';
    for (i = 0; i < 8; i++) {
      var key = PLANET_KEYS[i];
      drawPolyline(orbitOf(key), 0.35 * pa, 'rgba(127,127,127,0.9)', 1);
    }
    /* ghost transfer arc + markers (porkchop) */
    if (inPork && ghost) {
      ctx.strokeStyle = accent();
      ctx.globalAlpha = 0.5 * pa;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      var open = false, P = PRJ;
      for (var k2 = 0; k2 < ghost.pts.length; k2++) {
        var gp = ghost.pts[k2];
        if (projectPt(gp[0], gp[1], gp[2], P)) {
          if (!open) { ctx.moveTo(P.x, P.y); open = true; } else ctx.lineTo(P.x, P.y);
        } else open = false;
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      if (projectPt(ghost.rDep[0], ghost.rDep[1], ghost.rDep[2], P)) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = accent();
        ctx.beginPath(); ctx.arc(P.x, P.y, 4.5, 0, 6.2832); ctx.stroke();
      }
      if (projectPt(ghost.rArr[0], ghost.rArr[1], ghost.rArr[2], P)) {
        ctx.strokeStyle = gold();
        ctx.beginPath(); ctx.arc(P.x, P.y, 4.5, 0, 6.2832); ctx.stroke();
      }
    }
    /* planets at viewJD */
    var selPlanet = (sel && sel.kind === 'p') ? sel.idx : -1;
    for (i = 0; i < 8; i++) {
      var st = A.planetState(PLANET_KEYS[i], viewJD);
      var P2 = planetScr[i];
      P2.ok = projectPt(st.r[0], st.r[1], st.r[2], PRJ);
      if (!P2.ok) continue;
      P2.x = PRJ.x; P2.y = PRJ.y;
      var isTgt = inPork && PLANET_KEYS[i] === pcTarget;
      var color = (i === 2) ? accent() : (isTgt || selPlanet === i ? gold() : 'rgba(127,127,127,0.95)');
      ctx.globalAlpha = pa;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(P2.x, P2.y, PLANET_R[i], 0, 6.2832); ctx.fill();
      if (selPlanet === i && !inPork) {
        ctx.strokeStyle = gold();
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(P2.x, P2.y, PLANET_R[i] + 4, 0, 6.2832); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      var wantLabel = camD < 60 || (inPork && (i === 2 || isTgt));
      if (wantLabel) {
        labels.push({ x: P2.x, y: P2.y, txt: PLANET_LABELS[i],
                      color: i === 2 ? accent() : (isTgt || selPlanet === i ? gold() : null) });
      }
    }
    /* greedy label placement: skip a label that collides with a placed one */
    ctx.font = '10.5px ' + FONT;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    var placed = [];
    for (i = 0; i < labels.length; i++) {
      var lb = labels[i];
      var ly3 = lb.y < H * 0.17 ? lb.y + 12 : lb.y - 9;
      var wpx = ctx.measureText(lb.txt).width;
      var rect = { x: lb.x + 8, y: ly3 - 7, w: wpx, h: 14 };
      var hit = false;
      for (var q = 0; q < placed.length; q++) {
        var o = placed[q];
        if (rect.x < o.x + o.w && rect.x + rect.w > o.x && rect.y < o.y + o.h && rect.y + rect.h > o.y) { hit = true; break; }
      }
      if (hit) continue;
      placed.push(rect);
      ctx.globalAlpha = 0.55 * pa + (lb.color ? 0.3 : 0);
      ctx.fillStyle = lb.color || textColor(0.8);
      ctx.fillText(lb.txt, lb.x + 8, ly3);
      ctx.globalAlpha = 1;
    }

    /* porkchop cruise ship + trail */
    if (inPork && pcCruise) {
      var t = viewJD - pcCruise.info.dep;
      var shipR = A.propagateKepler(pcCruise.info.m.rDep, pcCruise.info.m.v1, t).r;
      pcCruise.trail.push([shipR[0], shipR[1], shipR[2]]);
      if (pcCruise.trail.length > 110) pcCruise.trail.shift();
      ctx.lineWidth = 1.5;
      var P3 = SEGA, P4 = SEGB;
      for (var k3 = 1; k3 < pcCruise.trail.length; k3++) {
        var a3 = pcCruise.trail[k3 - 1], b3 = pcCruise.trail[k3];
        if (!projectSeg(a3[0], a3[1], a3[2], b3[0], b3[1], b3[2])) continue;
        ctx.globalAlpha = 0.5 * (k3 / pcCruise.trail.length);
        ctx.strokeStyle = accent();
        ctx.beginPath(); ctx.moveTo(P3.x, P3.y); ctx.lineTo(P4.x, P4.y); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (projectPt(shipR[0], shipR[1], shipR[2], PRJ)) {
        ctx.fillStyle = textColor(0.95);
        ctx.beginPath(); ctx.arc(PRJ.x, PRJ.y, 2.6, 0, 6.2832); ctx.fill();
      }
    }
    /* soft ring pulse on porkchop arrival */
    if (inPork && arrivedPulse && !reduced && pcTarget) {
      var kp = (now - arrivedPulse) / 1400;
      var pt = planetScr[PLANET_KEYS.indexOf(pcTarget)];
      if (kp < 1 && pt.ok) {
        ctx.strokeStyle = gold();
        ctx.globalAlpha = 0.7 * (1 - kp);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(pt.x, pt.y, 8 + kp * 26, 0, 6.2832); ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  /* exoplanet screens of the centered star, for taps */
  var exoScr = [];
  function drawCenteredStar(D, now) {
    exoScr.length = 0;
    var i = centeredStar;
    if (i < 0 || i >= NS) return;
    var fade = 1 - ramp(D, 150, 200);
    if (fade <= 0.01) return;
    var P = PRJ;
    if (!projectPt(starX[i], starY[i], starZ[i], P)) return;
    var T = starTempOf(i);
    /* unknown physicals (the pulsar, brown dwarfs): a small neutral disc,
       never NaN into createRadialGradient (it throws and kills the loop) */
    var rgb = isFinite(T) ? A.kelvinToRgb(T) : { r: 214, g: 218, b: 228 };
    var Rsun = A.starRadiusSun(starBolLum(i), T);
    var rpx = isFinite(Rsun)
      ? clampN(18 + 16 * Math.log(Math.max(1e-3, Rsun)) / Math.LN10, 6, 60)
      : 8;
    var cx0 = P.x, cy0 = P.y;
    var grad = ctx.createRadialGradient(cx0, cy0, 0, cx0, cy0, rpx * 2.2);
    grad.addColorStop(0, 'rgba(255,255,255,' + (0.95 * fade) + ')');
    grad.addColorStop(0.28, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + (0.9 * fade) + ')');
    grad.addColorStop(1, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(cx0, cy0, rpx * 2.2, 0, 6.2832); ctx.fill();
    /* arrival pulse */
    if (starPulse && !reduced) {
      var kp = (now - starPulse) / 1400;
      if (kp < 1) {
        ctx.strokeStyle = gold();
        ctx.globalAlpha = 0.7 * (1 - kp) * fade;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx0, cy0, rpx + kp * 40, 0, 6.2832); ctx.stroke();
        ctx.globalAlpha = 1;
      } else starPulse = 0;
    }
    /* known planets: real orbit sizes (a in AU), illustrative positions */
    var list = starPlanets[i];
    if (!list || !list.length) return;
    var tAnim = reduced ? 0 : now / 1000 / 600;   /* 600 s per Earth-year of sweep */
    for (var k = 0; k < list.length; k++) {
      var j = list[k];
      var a = SD.planets.a[j];
      var per = SD.planets.per[j];
      if ((a == null || !isFinite(a)) && per != null && isFinite(per) && per > 0) {
        a = Math.pow(per / 365.25, 2 / 3);
      }
      if (a == null || !isFinite(a) || a <= 0) continue;
      var pYr = (per != null && isFinite(per) && per > 0) ? per / 365.25 : Math.pow(a, 1.5);
      var ph = k * 2.399 + (reduced ? 0 : tAnim * 2 * Math.PI / Math.max(1e-4, pYr));
      /* orbit circle in the ecliptic plane around the star */
      ctx.strokeStyle = 'rgba(127,127,127,0.9)';
      ctx.globalAlpha = 0.35 * fade;
      ctx.lineWidth = 1;
      ctx.beginPath();
      var open = false;
      for (var q2 = 0; q2 <= 64; q2++) {
        var th = q2 / 64 * 2 * Math.PI;
        var wx2 = starX[i] + a * Math.cos(th), wy2 = starY[i] + a * Math.sin(th);
        if (projectPt(wx2, wy2, starZ[i], PRJ)) {
          if (!open) { ctx.moveTo(PRJ.x, PRJ.y); open = true; } else ctx.lineTo(PRJ.x, PRJ.y);
        } else open = false;
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      var wx3 = starX[i] + a * Math.cos(ph), wy3 = starY[i] + a * Math.sin(ph);
      if (projectPt(wx3, wy3, starZ[i], PRJ)) {
        var isSel = selExo === j;
        ctx.globalAlpha = fade;
        ctx.fillStyle = isSel ? gold() : textColor(0.85);
        ctx.beginPath(); ctx.arc(PRJ.x, PRJ.y, 3, 0, 6.2832); ctx.fill();
        if (isSel) {
          ctx.strokeStyle = gold();
          ctx.lineWidth = 1.4;
          ctx.beginPath(); ctx.arc(PRJ.x, PRJ.y, 7, 0, 6.2832); ctx.stroke();
        }
        ctx.globalAlpha = 1;
        exoScr.push({ j: j, x: PRJ.x, y: PRJ.y });
      } else {
        exoScr.push({ j: j, x: -9999, y: -9999 });
      }
    }
  }

  function drawTag(x, y, txt, color, ringR, faint) {
    if (y < 40) return;                       /* nav dead zone: skip entirely */
    ctx.strokeStyle = color;
    ctx.globalAlpha = faint ? 0.5 : 0.95;
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(x, y, ringR, 0, 6.2832); ctx.stroke();
    ctx.font = '12px ' + FONT;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = color;
    var ty = y < H * 0.17 ? y + ringR + 10 : y - ringR - 9;
    ctx.fillText(txt, x + ringR + 4, ty);
    ctx.globalAlpha = 1;
  }

  function drawSelectionRings() {
    if (hover && hover.kind === 's' && starsVis && scrOk[hover.idx] &&
        !(sel && sel.kind === 's' && sel.idx === hover.idx)) {
      drawTag(scrX[hover.idx], scrY[hover.idx], starName(hover.idx), textColor(0.75), 9, true);
    }
    if (sel && sel.kind === 's') {
      var i = sel.idx;
      if (starsVis && scrOk[i]) {
        drawTag(scrX[i], scrY[i], starName(i), gold(), 9, false);
      } else if (centeredStar === i && camD < 200) {
        var P = PRJ;
        if (projectPt(starX[i], starY[i], starZ[i], P)) {
          drawTag(P.x, P.y, starName(i), gold(), 14, false);
        }
      }
    }
  }

  function drawCruise(now) {
    if (!cruiseSt || !cruiseSt.cp) return;
    var cp = cruiseSt.cp;
    var i = cruiseSt.star;
    /* the route: a straight gold line Sun -> star */
    if (projectSeg(0, 0, 0, starX[i], starY[i], starZ[i])) {
      ctx.strokeStyle = gold();
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(SEGA.x, SEGA.y); ctx.lineTo(SEGB.x, SEGB.y); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    /* the ship spark + a short trail behind it */
    var xAU = cp.x * LY_AU;
    var sx3 = cruiseSt.ux * xAU, sy3 = cruiseSt.uy * xAU, sz3 = cruiseSt.uz * xAU;
    var trail = Math.min(xAU, camD * 1.4);
    var bx3 = sx3 - cruiseSt.ux * trail, by3 = sy3 - cruiseSt.uy * trail, bz3 = sz3 - cruiseSt.uz * trail;
    if (projectSeg(bx3, by3, bz3, sx3, sy3, sz3)) {
      var lg = ctx.createLinearGradient(SEGA.x, SEGA.y, SEGB.x, SEGB.y);
      lg.addColorStop(0, 'rgba(200,164,92,0)');
      lg.addColorStop(1, gold());
      ctx.strokeStyle = lg;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(SEGA.x, SEGA.y); ctx.lineTo(SEGB.x, SEGB.y); ctx.stroke();
    }
    if (projectPt(sx3, sy3, sz3, PRJ)) {
      var gl = ctx.createRadialGradient(PRJ.x, PRJ.y, 0, PRJ.x, PRJ.y, 10);
      gl.addColorStop(0, 'rgba(255,255,255,0.95)');
      gl.addColorStop(0.35, isLight() ? 'rgba(160,124,44,0.7)' : 'rgba(200,164,92,0.7)');
      gl.addColorStop(1, 'rgba(200,164,92,0)');
      ctx.fillStyle = gl;
      ctx.beginPath(); ctx.arc(PRJ.x, PRJ.y, 10, 0, 6.2832); ctx.fill();
    }
    /* the destination, drawn bright regardless of the star-field fade */
    if (projectPt(starX[i], starY[i], starZ[i], PRJ)) {
      var at = ensureAtlas();
      ctx.drawImage(at, starCellX[i], starCellY[i], 32, 32, PRJ.x - 12, PRJ.y - 12, 24, 24);
    }
    /* HUD: the two clocks running apart (kept below the nav vignette) */
    var hudY = Math.max(130, H * 0.16);
    var shipYr = Math.round(cp.tau * 10) / 10;
    var cal = Math.floor(thisYearFrac + cp.t);
    ctx.font = '600 15px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = textColor(0.92);
    ctx.fillText('Ship clock ' + shipYr + ' yr · Earth calendar ' + cal + ' · ' +
      PURE.fmtSpeedC(cp.v) + 'c · γ ' + PURE.fmtGamma(cp.g), W / 2, hudY);
    ctx.font = '12px ' + FONT;
    ctx.fillStyle = textColor(0.55);
    ctx.fillText('Esc or tap to cancel', W / 2, hudY + 22);
    ctx.textAlign = 'left';
  }

  function drawScaleBar(D) {
    sbRect = null;
    if (mode === 'porkchop' || mode === 'cruise') return;
    if (cardOpen() && W <= 768) return;      /* the sheet covers that region */
    var auPerPx = D / fpxV;
    var mobile = W <= 768;
    var maxPx = mobile ? Math.min(W * 0.5, W - 32) : Math.min(260, W - 280, W * 0.3);
    var ns = PURE.niceScale(auPerPx, maxPx, LY_AU);
    if (!ns) return;
    var y = mobile ? Math.max(40, cornerBand().top - 8) : H - 12;
    var x0 = (W - ns.px) / 2, x1 = x0 + ns.px;
    ctx.strokeStyle = textColor(0.6);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y); ctx.lineTo(x1, y);
    ctx.moveTo(x0, y - 4); ctx.lineTo(x0, y + 0.5);
    ctx.moveTo(x1, y - 4); ctx.lineTo(x1, y + 0.5);
    ctx.stroke();
    ctx.font = '11px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = textColor(0.65);
    ctx.fillText(ns.label, (x0 + x1) / 2, y - 5);
    sbRect = { x: x0, y: y - 20, w: ns.px, h: 22 };
    /* honesty whisper while a star disc is on screen */
    if (centeredStar >= 0 && D < 200) {
      ctx.font = '10px ' + FONT;
      ctx.fillStyle = textColor(0.45);
      ctx.fillText('star disc not to scale', (x0 + x1) / 2, y - 20);
    }
    ctx.textAlign = 'left';
  }

  function drawTimeline() {
    var tl = L.tl, r = tlRange();
    function jdToX(jd) { return tl.x0 + (jd - r.min) / (r.max - r.min) * (tl.x1 - tl.x0); }
    ctx.strokeStyle = 'rgba(127,127,127,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(tl.x0, tl.y); ctx.lineTo(tl.x1, tl.y); ctx.stroke();
    var info = selInfo();
    if (info) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = accent();
      var xd = jdToX(info.dep);
      ctx.beginPath(); ctx.moveTo(xd, tl.y - 5); ctx.lineTo(xd, tl.y + 5); ctx.stroke();
      ctx.strokeStyle = gold();
      var xa = jdToX(info.dep + info.tof);
      ctx.beginPath(); ctx.moveTo(xa, tl.y - 5); ctx.lineTo(xa, tl.y + 5); ctx.stroke();
    }
    var xh = clampN(jdToX(viewJD), tl.x0, tl.x1);
    ctx.fillStyle = accent();
    ctx.beginPath(); ctx.arc(xh, tl.y, 5.5, 0, 6.2832); ctx.fill();
    ctx.font = '13px ' + FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = textColor(0.85);
    ctx.fillText(fmtDate(viewJD), tl.x0, tl.y - 9);
  }

  function drawPorkchop() {
    var job = jobs[pcTarget], sp = specOf(pcTarget);
    var pc = L.pc, plot = L.plot;
    ctx.fillStyle = panelFill();
    ctx.strokeStyle = 'rgba(127,127,127,0.28)';
    ctx.lineWidth = 1;
    roundRect(pc.x, pc.y, pc.w, pc.h, 10);
    ctx.fill(); ctx.stroke();

    if (pcCache) ctx.drawImage(pcCache, plot.x, plot.y, plot.w, plot.h);
    ctx.strokeStyle = 'rgba(127,127,127,0.3)';
    ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w - 1, plot.h - 1);

    var n = sp.nDep, m = sp.nTof;
    ctx.font = '10.5px ' + FONT;
    ctx.fillStyle = textColor(0.65);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var stepMonths = L.mobile ? 12 : 6;
    var d0 = A.jdToDate(sp.jd0), dEnd = A.jdToDate(sp.depMax);
    var mm = d0.m, yy = d0.y;
    for (var guard = 0; guard < 45; guard++) {
      mm++; if (mm > 12) { mm = 1; yy++; }
      if (yy > dEnd.y || (yy === dEnd.y && mm > dEnd.m)) break;
      if (((yy * 12 + mm - 1) % stepMonths) !== 0) continue;
      var tj = A.dateToJD(yy, mm, 1);
      var tx = plot.x + ((tj - sp.jd0) / sp.depStep + 0.5) / n * plot.w;
      if (tx < plot.x + 14 || tx > plot.x + plot.w - 14) continue;
      ctx.strokeStyle = 'rgba(127,127,127,0.4)';
      ctx.beginPath(); ctx.moveTo(tx, plot.y + plot.h); ctx.lineTo(tx, plot.y + plot.h + 4); ctx.stroke();
      ctx.fillText(MON[mm - 1] + " '" + String(yy % 100 < 10 ? '0' + yy % 100 : yy % 100), tx, plot.y + plot.h + 6);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    var tofTick = PURE.tofTickFor(sp.tofMax - sp.tof0);
    for (var tv = Math.ceil(sp.tof0 / tofTick) * tofTick; tv <= sp.tofMax; tv += tofTick) {
      var ty = plot.y + plot.h - ((tv - sp.tof0) / sp.tofStep + 0.5) / m * plot.h;
      if (ty < plot.y + 6 || ty > plot.y + plot.h - 4) continue;
      ctx.strokeStyle = 'rgba(127,127,127,0.4)';
      ctx.beginPath(); ctx.moveTo(plot.x - 4, ty); ctx.lineTo(plot.x, ty); ctx.stroke();
      ctx.fillText(PURE.fmtInt(tv) + ' d', plot.x - 7, ty);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = textColor(0.6);
    ctx.fillText('total Δv, km/s', plot.x + plot.w - 5, plot.y + 4);

    if (job && !job.done) {
      ctx.fillStyle = accent();
      ctx.globalAlpha = 0.8;
      ctx.fillRect(plot.x, plot.y + plot.h - 3, plot.w * job.progress, 3);
      ctx.globalAlpha = 1;
    }

    var s = pcSel[pcTarget];
    if (s) {
      var cx2 = plot.x + (s.i + 0.5) / n * plot.w;
      var cy2 = plot.y + plot.h - (s.j + 0.5) / m * plot.h;
      ctx.strokeStyle = accent();
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plot.x, cy2); ctx.lineTo(plot.x + plot.w, cy2);
      ctx.moveTo(cx2, plot.y); ctx.lineTo(cx2, plot.y + plot.h);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.6;
      ctx.strokeRect(cx2 - 3.5, cy2 - 3.5, 7, 7);
    }

    drawReadout(job);
  }

  function drawReadout(job) {
    var ro = L.ro;
    var info = selInfo();
    var xL = ro.x + 14;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    if (!info || !job) {
      ctx.font = '13px ' + FONT;
      ctx.fillStyle = textColor(0.75);
      var msg = job && !job.done
        ? ('Computing the Δv map · ' + Math.round(job.progress * 100) + '%')
        : 'Pick a spot on the map.';
      ctx.fillText(msg, xL, ro.y + (L.mobile ? 24 : 34));
      return;
    }
    if (!info.m) {
      ctx.font = '13px ' + FONT;
      ctx.fillStyle = textColor(0.75);
      ctx.fillText('No transfer here. This geometry needs more than one arc.', xL, ro.y + (L.mobile ? 24 : 34));
      if (!L.mobile) {
        ctx.fillText('Depart ' + fmtDate(info.dep) + ' · ' + info.tof + ' days', xL, ro.y + 56);
      }
      return;
    }
    var m2 = info.m;
    var extrap = (info.dep + info.tof) > JD_EXTRAP;
    if (L.mobile) {
      ctx.font = '12.5px ' + FONT;
      ctx.fillStyle = textColor(0.85);
      ctx.fillText(fmtDate(info.dep) + ' · ' + info.tof + ' d · arrive ' + fmtDate(info.dep + info.tof), xL, ro.y + 19);
      ctx.font = '600 13px ' + FONT;
      ctx.fillText('Δv ' + m2.dv1.toFixed(2) + ' + ' + m2.dv2.toFixed(2) + ' = ' + m2.total.toFixed(2) + ' km/s total', xL, ro.y + 38);
      if (extrap) {
        ctx.font = '9.5px ' + FONT;
        ctx.fillStyle = textColor(0.55);
        ctx.fillText('Arrival past 2050: JPL elements extrapolated slightly beyond their fit.', xL, ro.y + 50);
      }
      return;
    }
    ctx.font = '13px ' + FONT;
    ctx.fillStyle = textColor(0.85);
    ctx.fillText('Depart ' + fmtDate(info.dep) + '  ·  Arrive ' + fmtDate(info.dep + info.tof), xL, ro.y + 24);
    ctx.font = '12.5px ' + FONT;
    ctx.fillStyle = textColor(0.7);
    ctx.fillText('Flight time ' + info.tof + ' days · C3 ' + m2.c3.toFixed(1) + ' km²/s² · v∞ arrival ' + m2.vinfArr.toFixed(2) + ' km/s', xL, ro.y + 45);
    ctx.fillStyle = textColor(0.85);
    ctx.fillText('Δv depart ' + m2.dv1.toFixed(2) + ' · Δv arrive ' + m2.dv2.toFixed(2), xL, ro.y + 68);
    if (extrap) {
      ctx.font = '10px ' + FONT;
      ctx.fillStyle = textColor(0.55);
      ctx.fillText('Arrival dates past 2050 extrapolate the JPL elements slightly beyond their fitted range.', xL, ro.y + 84);
    }
    ctx.font = '700 15px ' + FONT;
    ctx.textAlign = 'right';
    ctx.fillStyle = textColor(0.95);
    ctx.fillText('Total Δv ' + m2.total.toFixed(2) + ' km/s', ro.x + ro.w - 14, ro.y + 68);
    ctx.textAlign = 'left';
  }

  function draw(now) {
    if (!W || !H) { resize(); if (!W || !H) return; layout(); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = bg();
    ctx.fillRect(0, 0, W, H);
    updateCamBasis();
    var D = camD;
    var ga = ramp(D, 3e8, 2e9);
    var sa = ramp(D, 5e3, 3e4);
    if (mode === 'cruise') sa = Math.max(sa, 0.45);   /* the sky travels with you */
    var pa = 1 - ramp(D, 250, 400);
    if (ga > 0.004) drawGalaxy(ga);
    starsVis = sa > 0.004;
    if (starsVis) drawStars(sa);
    drawSun(D);
    if (pa > 0.01) drawSolar(pa, now);
    if (centeredStar >= 0 && D < 200 && mode !== 'porkchop') drawCenteredStar(D, now);
    else exoScr.length = 0;   /* stale exo dots must not stay tappable */
    drawSelectionRings();
    if (mode === 'cruise') drawCruise(now);
    if (mode === 'porkchop') { sbRect = null; drawTimeline(); drawPorkchop(); }
    else drawScaleBar(D);
    drawTagline(now);
  }

  /* ---------------- main loop ---------------- */
  function loop(t) {
    raf = requestAnimationFrame(loop);
    var dt = Math.min(0.1, (t - lastT) / 1000 || 0);
    lastT = t;
    var nowMs = performance.now();

    if (mode === 'intro') { introStep(nowMs); viewJD += dt * 10; }
    camStep(nowMs);

    var job = pcTarget ? jobs[pcTarget] : null;
    if (job && !job.done) {
      job.step(12);
      if (job.done) {
        pcDirty = true;
        if (!pcSel[pcTarget] && mode === 'porkchop') {
          setPcSel(job.minI, job.minJ, true);
          var info = selInfo();
          if (info && info.m) {
            ariaLast = nowMs; ariaPend = null;
            setStatus('Cheapest window: depart ' + fmtDate(info.dep) + ' · ' + info.tof +
                      ' days · ' + info.m.total.toFixed(1) + ' km/s total');
          }
        }
      } else if (nowMs - lastPcPaint > 150) {
        pcDirty = true;
      }
    }
    if (mode === 'porkchop' && pcDirty) { renderPcCache(); lastPcPaint = nowMs; }

    if (mode === 'porkchop' && pcCruise) {
      var s = (nowMs - pcCruise.t0) / pcCruise.ms;
      if (s >= 1) {
        viewJD = pcCruise.info.dep + pcCruise.info.tof;
        var ci = pcCruise.info;
        pcCruise = null;
        arrivedPulse = nowMs;
        announceArrival(ci);
        if (btnLaunch) btnLaunch.textContent = 'Replay';
      } else {
        viewJD = pcCruise.info.dep + easeInOutCubic(s) * pcCruise.info.tof;
      }
    } else if (mode === 'explore' && attract && !dragKind) {
      viewJD += dt * 4;
      cam.yaw += dt * 0.012;
    }

    if (mode === 'cruise' && cruiseSt) {
      var fr = (nowMs - cruiseSt.t0) / cruiseSt.ms;
      if (fr >= 1) { arriveStar(); }
      else {
        var tau = fr * cruiseSt.tauTotal;
        var cp = PURE.cruisePoint(cruiseSt.dLy, cruiseSt.a, tau);
        cp.tau = tau;
        cruiseSt.cp = cp;
        var xAU = cp.x * LY_AU;
        cam.cx = cruiseSt.ux * xAU; cam.cy = cruiseSt.uy * xAU; cam.cz = cruiseSt.uz * xAU;
        cam.logD = 1.5;
      }
    }

    if (ariaPend && nowMs - ariaLast > 400) {
      ariaLast = nowMs; setStatus(ariaPend); ariaPend = null;
    }
    draw(nowMs);
  }
  function start() { if (!raf) { lastT = 0; raf = requestAnimationFrame(loop); } }

  /* ---------------- pointer input ---------------- */
  var pointers = {};
  var orbitDrag = null;                 /* {x0, y0, yaw0, pitch0} */
  var pinchSt = null;                   /* {d} */
  var downSt = null;                    /* {x, y, t, type} pending tap */
  function rel(e) {
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function pointerCount() { var n = 0, k; for (k in pointers) n++; return n; }
  function pvals() { var a = [], k; for (k in pointers) a.push(pointers[k]); return a; }
  function pdist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function inPlot(p) {
    return p.x >= L.plot.x && p.x <= L.plot.x + L.plot.w &&
           p.y >= L.plot.y && p.y <= L.plot.y + L.plot.h;
  }
  function nearTl(p) {
    return Math.abs(p.y - L.tl.y) < 18 && p.x > L.tl.x0 - 12 && p.x < L.tl.x1 + 12;
  }
  function pcPick(p) {
    var sp = specOf(pcTarget);
    var i = clampN(Math.floor((p.x - L.plot.x) / L.plot.w * sp.nDep), 0, sp.nDep - 1);
    var j = clampN(Math.floor((L.plot.y + L.plot.h - p.y) / L.plot.h * sp.nTof), 0, sp.nTof - 1);
    setPcSel(i, j);
  }
  function tlPick(p) {
    var r = tlRange();
    var f = clampN((p.x - L.tl.x0) / (L.tl.x1 - L.tl.x0), 0, 1);
    /* the user-facing scrub clamps at 2050; grids and cruises may pass it */
    viewJD = clampN(r.min + f * (r.max - r.min), r.min, Math.min(r.max, JD_2050));
  }

  function pickBody(p, rad) {
    var best = null, bestD = rad * rad, i, dx, dy, d2;
    /* exoplanet dots of the centered star first */
    for (i = 0; i < exoScr.length; i++) {
      dx = exoScr[i].x - p.x; dy = exoScr[i].y - p.y; d2 = dx * dx + dy * dy;
      if (d2 < bestD) { bestD = d2; best = { kind: 'x', idx: exoScr[i].j }; }
    }
    if (best) return best;
    /* planets */
    if (camD < 400) {
      for (i = 0; i < 8; i++) {
        if (!planetScr[i].ok) continue;
        dx = planetScr[i].x - p.x; dy = planetScr[i].y - p.y; d2 = dx * dx + dy * dy;
        if (d2 < bestD) { bestD = d2; best = { kind: 'p', idx: i }; }
      }
      if (best) return best;
    }
    /* stars */
    if (starsVis) {
      for (i = 0; i < NS; i++) {
        if (!scrOk[i]) continue;
        dx = scrX[i] - p.x; dy = scrY[i] - p.y; d2 = dx * dx + dy * dy;
        if (d2 < bestD) { bestD = d2; best = { kind: 's', idx: i }; }
      }
    } else if (centeredStar >= 0 && camD < 200) {
      var P = PRJ;
      if (projectPt(starX[centeredStar], starY[centeredStar], starZ[centeredStar], P)) {
        dx = P.x - p.x; dy = P.y - p.y;
        if (dx * dx + dy * dy < Math.pow(rad + 24, 2)) best = { kind: 's', idx: centeredStar };
      }
    }
    return best;
  }

  function tapSelect(p, type) {
    var hit = pickBody(p, type === 'touch' ? 20 : 16);
    if (!hit) {
      if (sel || cardOpen()) deselect();
      return;
    }
    if (hit.kind === 'x') {
      var host = SD.planets.host[hit.idx];
      selectBody({ kind: 's', idx: host }, { openCard: true, exo: hit.idx });
      return;
    }
    var name = hit.kind === 'p' ? PLANET_LABELS[hit.idx] : starName(hit.idx);
    var now = performance.now();
    if (lastTap && lastTap.name === name && now - lastTap.t < 350) {
      lastTap = null;
      zoomToBody(hit);
      return;
    }
    lastTap = { name: name, t: now };
    selectBody(hit, { openCard: true, fly: false });
  }

  function userTouched() {
    if (attract) { attract = false; viewJD = jdToday; }
    if (mode === 'intro') endIntro();
  }

  canvas.addEventListener('pointerdown', function (e) {
    if (e.button === 2) return;
    userTouched();
    var p = rel(e);
    pointers[e.pointerId] = p;
    if (pointerCount() === 2) {
      /* a second finger during a porkchop plot/timeline drag must NOT
         cancel it into a pinch (pinned input model: pinch never engages
         from a gesture that began inside those rects) */
      if (dragKind === 'pc' || dragKind === 'tl') {
        delete pointers[e.pointerId];
        return;
      }
      orbitDrag = null; downSt = null; dragKind = null;
      var pts = pvals();
      pinchSt = { d: pdist(pts[0], pts[1]) };
      if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    /* pinned hit-test order: porkchop plot, then timeline, then orbit */
    if (mode === 'porkchop' && L) {
      if (inPlot(p)) {
        dragKind = 'pc';
        if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
        pcPick(p);
        e.preventDefault();
        return;
      }
      if (nearTl(p)) {
        dragKind = 'tl';
        if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
        cancelPcCruise();
        tlPick(p);
        e.preventDefault();
        return;
      }
    }
    if (mode === 'cruise') {
      downSt = { x: p.x, y: p.y, t: performance.now(), type: e.pointerType, cruise: true };
      return;
    }
    camAnim = null;                      /* grabbing the sky cancels a fly */
    orbitDrag = { x0: p.x, y0: p.y, yaw0: cam.yaw, pitch0: cam.pitch };
    downSt = { x: p.x, y: p.y, t: performance.now(), type: e.pointerType };
    if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', function (e) {
    var p = rel(e);
    if (pointers[e.pointerId]) pointers[e.pointerId] = p;
    if (pinchSt) {
      var pts = pvals();
      if (pts.length < 2) return;
      var nd = pdist(pts[0], pts[1]);
      if (pinchSt.d > 0 && nd > 0) {
        cam.logD = clampN(cam.logD - Math.log(nd / pinchSt.d) / Math.LN10, 0.5, 10.1);
      }
      pinchSt.d = nd;
      return;
    }
    if (dragKind === 'pc') { pcPick(p); return; }
    if (dragKind === 'tl') { tlPick(p); return; }
    if (orbitDrag) {
      var dx = p.x - orbitDrag.x0, dy = p.y - orbitDrag.y0;
      if (downSt && Math.abs(dx) + Math.abs(dy) > 6) downSt = null;
      if (!downSt) {
        cam.yaw = orbitDrag.yaw0 - dx * 0.005;
        cam.pitch = clampN(orbitDrag.pitch0 + dy * 0.005, -1.45, 1.45);
      }
      return;
    }
    /* hover (mouse, explore only) */
    if (mode === 'explore' && e.pointerType === 'mouse') {
      hover = pickBody(p, 14);
      canvas.style.cursor = hover ? 'pointer' : 'default';
    }
    if (mode === 'porkchop' && L) {
      canvas.style.cursor = inPlot(p) ? 'crosshair' : (nearTl(p) ? 'ew-resize' : 'default');
    }
  });

  function endPointer(e) {
    var p = pointers[e.pointerId] ? { x: pointers[e.pointerId].x, y: pointers[e.pointerId].y } : rel(e);
    delete pointers[e.pointerId];
    if (pinchSt) {
      if (pointerCount() < 2) pinchSt = null;
      return;                            /* ignore taps until both lift */
    }
    if (dragKind) {
      if (dragKind === 'pc' && ariaPend) {
        setStatus(ariaPend); ariaPend = null;
        ariaLast = performance.now();
      }
      dragKind = null;
      return;
    }
    if (downSt) {
      var dt2 = performance.now() - downSt.t;
      var moved = Math.abs(p.x - downSt.x) + Math.abs(p.y - downSt.y);
      if (dt2 < 350 && moved <= 6) {
        if (downSt.cruise) cancelStarCruise(false);
        else if (mode === 'explore') tapSelect(p, downSt.type);
      }
    }
    downSt = null;
    orbitDrag = null;
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', function (e) {
    delete pointers[e.pointerId];
    pinchSt = null; orbitDrag = null; downSt = null; dragKind = null;
  });

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    userTouched();
    var dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;         /* line-mode mice -> pixels */
    else if (e.deltaMode === 2) dy *= (H || 600);
    cam.logD = clampN(cam.logD + dy * 0.005 / Math.LN10, 0.5, 10.1);
  }, { passive: false });

  /* ---------------- keyboard (one consumer per key per mode) ------------ */
  function escLadder() {
    if (mode === 'cruise') { cancelStarCruise(false); return; }
    if (mode === 'porkchop') {
      if (pcCruise) { cancelPcCruise(); setStatus('Cruise cancelled.'); return; }
      exitPorkchop();
      return;
    }
    if (cardOpen()) { closeCard(); return; }
  }
  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (window.GadgetUI && GadgetUI.isTyping(e)) return;
    var tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'button' || tag === 'a' || tag === 'summary' || tag === 'label') return;
    var k = e.key;
    if (mode === 'intro') { endIntro(); if (k === 'Escape') return; }
    attract = false;
    if (k === 'Escape') { escLadder(); return; }
    if (mode === 'cruise') return;           /* everything else inert */
    if (k === '+' || k === '=') {
      cam.logD = clampN(cam.logD - 0.15, 0.5, 10.1);
      e.preventDefault();
      return;
    }
    if (k === '-' || k === '_') {
      cam.logD = clampN(cam.logD + 0.15, 0.5, 10.1);
      e.preventDefault();
      return;
    }
    if (mode === 'porkchop') {
      if (k === 'Enter') { e.preventDefault(); pcLaunch(); return; }
      var di = 0, dj = 0;
      if (k === 'ArrowLeft') di = -1;
      else if (k === 'ArrowRight') di = 1;
      else if (k === 'ArrowUp') dj = 1;
      else if (k === 'ArrowDown') dj = -1;
      else return;
      e.preventDefault();
      var stp = e.shiftKey ? 5 : 1;
      var sp = specOf(pcTarget);
      var s = pcSel[pcTarget] || { i: Math.round(sp.nDep / 2), j: Math.round(sp.nTof / 2) };
      setPcSel(clampN(s.i + di * stp, 0, sp.nDep - 1), clampN(s.j + dj * stp, 0, sp.nTof - 1));
      return;
    }
    /* explore */
    if (k === 'Enter') {
      if (sel && !cardOpen()) { openCardFor(sel); e.preventDefault(); }
      return;
    }
    if (k === 'ArrowLeft') { cam.yaw += 0.08; e.preventDefault(); }
    else if (k === 'ArrowRight') { cam.yaw -= 0.08; e.preventDefault(); }
    else if (k === 'ArrowUp') { cam.pitch = clampN(cam.pitch + 0.06, -1.45, 1.45); e.preventDefault(); }
    else if (k === 'ArrowDown') { cam.pitch = clampN(cam.pitch - 0.06, -1.45, 1.45); e.preventDefault(); }
  });

  /* ---------------- search combobox ---------------- */
  var searchHits = [], searchHi = -1;
  function closeSearchList() {
    if (!elList) return;
    elList.hidden = true;
    elList.innerHTML = '';
    searchHits = []; searchHi = -1;
    if (elSearch) {
      elSearch.setAttribute('aria-expanded', 'false');
      elSearch.removeAttribute('aria-activedescendant');
    }
  }
  function renderSearchList() {
    if (!elList) return;
    elList.innerHTML = '';
    if (!searchHits.length) { closeSearchList(); return; }
    elList.hidden = false;
    if (elSearch) elSearch.setAttribute('aria-expanded', 'true');
    for (var i = 0; i < searchHits.length; i++) {
      (function (qi) {
        var h = searchHits[qi];
        var li = el('li', 'voy-search__opt', '');
        li.id = 'voy-opt-' + qi;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', qi === searchHi ? 'true' : 'false');
        if (qi === searchHi) li.classList.add('voy-search__opt--hi');
        li.appendChild(el('span', null, h.label));
        li.appendChild(el('span', 'voy-search__kind',
          h.kind === 'p' ? 'planet' : (h.kind === 'x' ? 'exoplanet' : 'star')));
        li.addEventListener('pointerdown', function (ev) { ev.preventDefault(); });
        li.addEventListener('click', function () { chooseSearch(qi); });
        elList.appendChild(li);
      })(i);
    }
    if (elSearch) {
      if (searchHi >= 0) elSearch.setAttribute('aria-activedescendant', 'voy-opt-' + searchHi);
      else elSearch.removeAttribute('aria-activedescendant');
    }
  }
  function chooseSearch(qi) {
    var h = searchHits[qi];
    if (!h) return;
    closeSearchList();
    if (elSearch) elSearch.value = h.label;
    userTouched();   /* a search during the intro must end it, or introStep
                        keeps overriding the flyTo camera */
    if (mode === 'porkchop') exitPorkchop();
    cancelStarCruise(true);
    if (h.kind === 'p') {
      selectBody({ kind: 'p', idx: h.idx }, { openCard: true, fly: true });
    } else if (h.kind === 's') {
      selectBody({ kind: 's', idx: h.idx }, { openCard: true, fly: true });
    } else {
      var host = SD.planets.host[h.idx];
      selectBody({ kind: 's', idx: host }, { openCard: true, fly: true, exo: h.idx });
    }
  }
  if (elSearch) {
    elSearch.addEventListener('input', function () {
      searchHits = PURE.searchQuery(searchEntries, elSearch.value, 8);
      searchHi = searchHits.length ? 0 : -1;
      renderSearchList();
    });
    elSearch.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!elList.hidden) {
          closeSearchList();
          e.stopPropagation();             /* Esc closes the list ONLY */
          e.preventDefault();
        }
        return;
      }
      if (elList.hidden) {
        if (e.key === 'ArrowDown' && elSearch.value) {
          searchHits = PURE.searchQuery(searchEntries, elSearch.value, 8);
          searchHi = searchHits.length ? 0 : -1;
          renderSearchList();
          e.preventDefault();
        }
        if (e.key === 'Enter' && elSearch.value) {
          searchHits = PURE.searchQuery(searchEntries, elSearch.value, 8);
          if (searchHits.length) chooseSearch(0);
          e.preventDefault();
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        searchHi = (searchHi + 1) % searchHits.length;
        renderSearchList();
        e.preventDefault();
      } else if (e.key === 'ArrowUp') {
        searchHi = (searchHi - 1 + searchHits.length) % searchHits.length;
        renderSearchList();
        e.preventDefault();
      } else if (e.key === 'Enter') {
        if (searchHi >= 0) chooseSearch(searchHi);
        e.preventDefault();
      }
    });
    elSearch.addEventListener('blur', function () {
      setTimeout(closeSearchList, 150);
    });
  }

  /* ---------------- share / save ---------------- */
  function sharePayload() {
    if (!sel) return null;
    var o = { a: accelIdx, m: shipIdx };
    if (sel.kind === 'p') {
      o.t = ['p', PLANET_LABELS[sel.idx]];
      if (mode === 'porkchop' && pcSel[pcTarget]) {
        var info = selInfo();
        if (info) { o.d = info.dep; o.f = info.tof; }
      }
    } else if (selExo >= 0) {
      o.t = ['x', SD.planets.name[selExo]];
    } else {
      o.t = ['s', starName(sel.idx)];
    }
    return o;
  }
  if (btnShare) btnShare.addEventListener('click', function () {
    var o = sharePayload();
    if (!o) { setStatus('Pick a destination first.'); return; }
    if (window.ShareHash) ShareHash.copyLink(btnShare, ShareHash.encode(1, o));
  });
  if (btnSave) btnSave.addEventListener('click', function () {
    if (!window.ShareHash) return;
    var BAND = 46;
    var out = document.createElement('canvas');
    out.width = W; out.height = H + BAND;
    var g = out.getContext('2d');
    if (!g) return;
    g.fillStyle = bg();
    g.fillRect(0, 0, W, H + BAND);
    try { g.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, W, H); } catch (e2) { return; }
    var l1 = 'The solar system on ' + fmtDate(viewJD), l2 = '';
    if (mode === 'porkchop' && pcTarget) {
      var info = selInfo();
      l1 = 'Earth to ' + PLANET_LABELS[PLANET_KEYS.indexOf(pcTarget)];
      if (info && info.m) {
        l1 += ' · depart ' + fmtDate(info.dep) + ' · ' + info.tof + ' days';
        l2 = 'Total Δv ' + info.m.total.toFixed(2) + ' km/s';
      }
    } else if (sel && sel.kind === 's') {
      var i = sel.idx;
      var gg = A.ACCEL_PRESETS[accelIdx];
      var b = A.brachistochrone(starLyD[i], gg);
      l1 = starName(i) + ' · ' + PURE.distPhrase(starLyD[i]);
      l2 = 'Constant ' + gg + ' g: ' + PURE.fmtYears(b.shipYears) + ' on the ship, ' +
        PURE.fmtYears(b.earthYears) + ' on Earth · peak ' + PURE.fmtSpeedC(b.vPeakC) + 'c';
    } else if (sel && sel.kind === 'p') {
      l1 = PLANET_LABELS[sel.idx] + ' · the solar system on ' + fmtDate(viewJD);
    }
    g.font = '600 13px ' + FONT;
    g.textBaseline = 'middle';
    g.fillStyle = textColor(0.9);
    g.fillText(l1, 12, H + 15);
    g.font = '12px ' + FONT;
    g.fillStyle = textColor(0.7);
    if (l2) g.fillText(l2, 12, H + 33);
    ShareHash.savePng(out, {
      label: 'Mission to Anywhere', file: 'voyage.png',
      light: isLight(), bg: bg()
    });
  });

  function restoreFromHash() {
    if (!window.ShareHash) return false;
    var dec = ShareHash.decode(ShareHash.readHash());
    if (!dec || dec.version !== 1) return false;
    var res = PURE.normShare(dec.obj);
    if (!res) return false;
    accelIdx = res.a; shipIdx = res.m;
    if (res.kind === 'p') {
      var pi = -1;
      for (var q = 0; q < PLANET_LABELS.length; q++) {
        if (PLANET_LABELS[q].toLowerCase() === res.name.toLowerCase()) { pi = q; break; }
      }
      if (pi < 0 || PLANET_KEYS[pi] === 'earth') return false;
      if (res.d != null && res.f != null) {
        /* a shared PLANNED trip keeps its departure/TOF pick */
        skipIntroTo(6.3);
        enterPorkchop(pi, true);
        var cs = A.clampShare({ t: PLANET_KEYS[pi], d: res.d, f: res.f }, specOf(PLANET_KEYS[pi]));
        setPcSel(cs.i, cs.j, true);
        return true;
      }
      skipIntroTo(6.3);
      selectBody({ kind: 'p', idx: pi }, { openCard: true, fly: true, instant: true });
      return true;
    }
    if (res.kind === 's') {
      var si = starIndexByName(res.name);
      if (si < 0) return false;
      skipIntroTo(6.3);
      selectBody({ kind: 's', idx: si }, { openCard: true, fly: true, instant: true, trip: true });
      return true;
    }
    var xi = exoIndexByName(res.name);
    if (xi < 0) return false;
    skipIntroTo(6.3);
    selectBody({ kind: 's', idx: SD.planets.host[xi] },
               { openCard: true, fly: true, instant: true, exo: xi });
    return true;
  }

  /* ---------------- porkchop-row buttons ---------------- */
  if (btnLaunch) btnLaunch.addEventListener('click', pcLaunch);
  if (btnNext) btnNext.addEventListener('click', nextWindow);
  if (btnBack) btnBack.addEventListener('click', exitPorkchop);

  /* ---------------- theme + resize wiring ---------------- */
  function onThemeChange() {
    pcDirty = true;
    atlas.dark = null; atlas.light = null;
    /* galaxy sprites are cached per theme, no need to drop them */
  }
  if (window.MutationObserver) {
    new MutationObserver(onThemeChange).observe(document.documentElement,
      { attributes: true, attributeFilter: ['data-theme'] });
  }
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: light)');
    if (mq.addEventListener) mq.addEventListener('change', onThemeChange);
    else if (mq.addListener) mq.addListener(onThemeChange);
  }
  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () {
      var oldPp = mode !== 'porkchop';
      resize();
      layout();
      if (oldPp && !camAnim) { var pp = explorePP(); cam.ppx = pp.x; cam.ppy = pp.y; }
      pcCache = null; pcDirty = true;
    }, 150);
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (raf) { cancelAnimationFrame(raf); raf = null; } }
    else start();
  });

  /* ---------------- init ---------------- */
  try {
    var chk = A.verifyEphemerides();
    var chk2 = A.verifyRelativity();
    if (verifyEl) {
      var ok = chk.ok && chk2.ok;
      verifyEl.textContent = ok ? '✓ physics verified'
        : 'self-check failed, numbers may be off';
      verifyEl.title = 'Earth-Mars distance on 6 Oct 2020: ' + chk.dist2020.toFixed(4) +
        ' AU (published: 0.4149). Proxima at 1 g: ' + chk2.shipYears.toFixed(2) +
        ' ship years (expected 3.54).';
      if (!ok) verifyEl.classList.add('voy-verify--warn');
    }
  } catch (err) {
    if (verifyEl) verifyEl.textContent = 'self-check failed, numbers may be off';
  }
  if (!SD && statusEl) setStatus('Star catalog failed to load; planets still work.');

  resize();
  layout();

  if (window.GadgetUI) {
    var hint = GadgetUI.firstRunHint('voyage',
      'Tap any planet or star, or search for one, and plan the trip.');
    var pnl = GadgetUI.initPanel({
      panel: elPanel, toggle: elCollapse,
      collapsedClass: 'voy-panel--collapsed',
      help: elHelp, hint: hint,
      onToggle: function (c) {
        panelOpen = !c;
        if (L) { layout(); pcCache = null; pcDirty = true; }
      }
    });
    if (pnl && window.innerHeight < 520) pnl.setCollapsed(true);
    panelUi = pnl;
  }

  var restored = false;
  try { restored = restoreFromHash(); } catch (e3) { restored = false; }
  if (!restored) {
    if (reduced) skipIntroTo(6.3);
    else startIntro();
  }
  updatePanelMode();
  updateTargetLine();

  /* the corner buttons + chat bar this layout measures are created after
     this deferred script runs; re-layout when they land */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { layout(); });
  }
  (function watchChat() {
    var done = false;
    function again() {
      if (done) return;
      done = true;
      layout();
    }
    if (document.getElementById('chat-widget')) { return; }
    if (window.MutationObserver) {
      var mo = new MutationObserver(function () {
        if (document.getElementById('chat-widget')) { mo.disconnect(); again(); }
      });
      mo.observe(document.body, { childList: true });
      setTimeout(function () { mo.disconnect(); }, 8000);
    }
    setTimeout(again, 2500);
  })();

  /* ---------------- test hooks ---------------- */
  var hooks = {
    PURE: PURE,
    starsCount: NS,
    project: function (name) {
      updateCamBasis();
      var ln = String(name).toLowerCase();
      var P = { x: 0, y: 0, z: 0 };
      if (ln === 'sun') return projectPt(0, 0, 0, P) ? { x: P.x, y: P.y } : null;
      for (var q = 0; q < PLANET_LABELS.length; q++) {
        if (PLANET_LABELS[q].toLowerCase() === ln) {
          var st = A.planetState(PLANET_KEYS[q], viewJD);
          return projectPt(st.r[0], st.r[1], st.r[2], P) ? { x: P.x, y: P.y } : null;
        }
      }
      var i = starIndexByName(name);
      if (i < 0) return null;
      return projectPt(starX[i], starY[i], starZ[i], P) ? { x: P.x, y: P.y } : null;
    }
  };
  function rectOf(elm) {
    if (!elm || elm.hidden) return null;
    var r = elm.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  Object.defineProperties(hooks, {
    mode: { get: function () { return mode; } },
    selName: { get: function () { return sel ? bodyLabel(sel) : null; } },
    selExoName: { get: function () { return selExo >= 0 && SD ? SD.planets.name[selExo] : null; } },
    cam: { get: function () {
      return { yaw: cam.yaw, pitch: cam.pitch, logD: cam.logD,
               center: [cam.cx, cam.cy, cam.cz] };
    } },
    boxes: { get: function () {
      return {
        card: rectOf(cardEl),
        panel: rectOf(elPanel),
        plot: (L && mode === 'porkchop') ? L.plot : null,
        tl: (L && mode === 'porkchop') ? L.tl : null,
        ro: (L && mode === 'porkchop') ? L.ro : null,
        scalebar: sbRect,
        W: W, H: H
      };
    } }
  });
  window.__voy = hooks;

  start();
})();
