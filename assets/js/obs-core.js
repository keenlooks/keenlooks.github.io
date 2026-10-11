/* ==========================================================================
   obs-core.js -- the Observatory kernel (/observatory/).

   No DOM, no rendering, no page glue. The file parses and runs standalone in
   node (module.exports guard at the bottom, every browser global reached
   through the injected environment), which is what makes feeds and
   instruments testable headlessly.

   Three registries plus a bus:
     - feeds        (poll / sse / ws / antenna) with health, backoff, lazy
                    connection, chunked parsing and a byte counter
     - instruments  pure compute(data, state, nowMs) recomputed on input
                    updates, rate limited to once per second each
     - events       a 72 h ring, deduped by id, ranked by the pinned table

   ObsCore.PURE holds the shared math instruments and the page both need:
   event ranking, the solar sub-point (declination plus equation of time),
   WMM2025 declination evaluated from the OBS_EARTH.wmm rows, plus small
   geometry and formatting helpers. Everything in PURE is deterministic and
   allocation-light (module level scratch), because winds_residual calls the
   declination path once per aircraft sample.

   Injected environment: ObsCore.configure({now, setTimeout, clearTimeout,
   fetch, EventSource, WebSocket, random}). Real timers and real fetch are the
   defaults; the node suites hand in a fake clock and a stub fetch.

   Sources for the math in PURE:
     - Solar position: NOAA General Solar Position Calculations (the same
       formulation as the NOAA solar calculator, after Meeus, Astronomical
       Algorithms ch. 25 and 28). Accuracy is far better than the 0.3 deg the
       terminator needs.
     - Magnetic declination: NOAA NCEI World Magnetic Model 2025, Schmidt
       semi-normalized spherical harmonics to degree 12, geodetic to
       geocentric conversion on WGS84, verified against the official
       WMM2025 test values.
   ========================================================================== */
(function (global) {
  'use strict';

  /* ======================================================================
     0. Injected environment
     ====================================================================== */

  var env = {
    now: function () { return Date.now(); },
    setTimeout: function (fn, ms) { return global.setTimeout(fn, ms); },
    clearTimeout: function (h) { return global.clearTimeout(h); },
    fetch: null,          /* null => use global.fetch at call time */
    EventSource: null,
    WebSocket: null,
    random: Math.random
  };

  var ENV_KEYS = ['now', 'setTimeout', 'clearTimeout', 'fetch', 'EventSource', 'WebSocket', 'random'];

  function configure(opts) {
    if (!opts) return;
    for (var i = 0; i < ENV_KEYS.length; i++) {
      var k = ENV_KEYS[i];
      if (typeof opts[k] !== 'undefined' && opts[k] !== null) env[k] = opts[k];
    }
  }

  function now() { return env.now(); }
  function later(fn, ms) { return env.setTimeout(fn, ms); }
  function cancel(h) { if (h !== null && typeof h !== 'undefined') env.clearTimeout(h); }

  /* ======================================================================
     1. Small pure helpers (shared by instruments)
     ====================================================================== */

  var DEG = Math.PI / 180;
  var RAD = 180 / Math.PI;
  var EARTH_R_KM = 6371.0088;

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, dflt) { return (typeof v === 'number' && isFinite(v)) ? v : dflt; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* longitude folded into [-180, 180) */
  function wrapLon(lon) {
    if (!isFinite(lon)) return NaN;
    var x = (lon + 180) % 360;
    if (x < 0) x += 360;
    return x - 180;
  }

  /* smallest signed difference a - b in degrees, in [-180, 180) */
  function angDelta(a, b) { return wrapLon(a - b); }

  function haversineKm(lat1, lon1, lat2, lon2) {
    var p1 = lat1 * DEG, p2 = lat2 * DEG;
    var dp = (lat2 - lat1) * DEG, dl = (lon2 - lon1) * DEG;
    var s1 = Math.sin(dp / 2), s2 = Math.sin(dl / 2);
    var a = s1 * s1 + Math.cos(p1) * Math.cos(p2) * s2 * s2;
    return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /* Point a fraction f along the great circle from 1 to 2 (spherical slerp).
     Writes into out ([lat, lon]) when given, so hot loops allocate nothing. */
  function gcInterp(lat1, lon1, lat2, lon2, f, out) {
    out = out || [0, 0];
    var p1 = lat1 * DEG, l1 = lon1 * DEG, p2 = lat2 * DEG, l2 = lon2 * DEG;
    var cp1 = Math.cos(p1), cp2 = Math.cos(p2);
    var x1 = cp1 * Math.cos(l1), y1 = cp1 * Math.sin(l1), z1 = Math.sin(p1);
    var x2 = cp2 * Math.cos(l2), y2 = cp2 * Math.sin(l2), z2 = Math.sin(p2);
    var dot = clamp(x1 * x2 + y1 * y2 + z1 * z2, -1, 1);
    var d = Math.acos(dot);
    var A, B;
    if (d < 1e-9) { A = 1 - f; B = f; }
    else {
      var sd = Math.sin(d);
      A = Math.sin((1 - f) * d) / sd;
      B = Math.sin(f * d) / sd;
    }
    var x = A * x1 + B * x2, y = A * y1 + B * y2, z = A * z1 + B * z2;
    var hyp = Math.sqrt(x * x + y * y);
    out[0] = Math.atan2(z, hyp) * RAD;
    out[1] = (hyp < 1e-12) ? wrapLon(lon1) : Math.atan2(y, x) * RAD;
    return out;
  }

  /* The 1/4, 1/2, 3/4 samples the flare shadow takes along a path. */
  var SAMPLE_F = [0.25, 0.5, 0.75];
  function gcSamples(lat1, lon1, lat2, lon2, out) {
    out = out || [[0, 0], [0, 0], [0, 0]];
    for (var i = 0; i < SAMPLE_F.length; i++) gcInterp(lat1, lon1, lat2, lon2, SAMPLE_F[i], out[i]);
    return out;
  }

  /* median of a numeric array; ignores non-finite entries; NaN when empty */
  var medScratch = [];
  function median(arr) {
    medScratch.length = 0;
    for (var i = 0; i < arr.length; i++) if (isFinite(arr[i])) medScratch.push(arr[i]);
    var n = medScratch.length;
    if (!n) return NaN;
    medScratch.sort(function (a, b) { return a - b; });
    var h = n >> 1;
    return (n & 1) ? medScratch[h] : (medScratch[h - 1] + medScratch[h]) / 2;
  }

  function pad2(v) { return v < 10 ? '0' + v : '' + v; }

  function hhmmssUTC(ms) {
    if (!isFinite(ms)) return '';
    var d = new Date(ms);
    return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
  }

  /* "48N 30E" style fallback label. Region data lives in OBS_EARTH; this is
     the code path the spec pins for cells with no named box. */
  function coordLabel(lat, lon) {
    if (!isFinite(lat) || !isFinite(lon)) return '';
    var la = Math.round(Math.abs(lat)), lo = Math.round(Math.abs(wrapLon(lon)));
    return la + (lat >= 0 ? 'N ' : 'S ') + lo + (wrapLon(lon) >= 0 ? 'E' : 'W');
  }

  /*
   * Name a point from the OBS_EARTH.regions boxes. FIRST hit wins, which is the
   * canonical rule for that table: the generator orders it specific first and
   * enforces that no box precedes a box it contains, so the first hit IS the
   * most specific one. This used to pick the smallest containing box instead;
   * the two agreed on the shipped table, but two rules for one question is how
   * two different names for one place eventually reach a visitor, so there is
   * now one (C1 punch list item 10). ObsInstruments.PURE.regionAt is the same
   * rule reading the same table.
   */
  function regionName(regions, lat, lon) {
    if (!isFinite(lat) || !isFinite(lon)) return '';
    var L = wrapLon(lon);
    if (regions && regions.length) {
      for (var i = 0; i < regions.length; i++) {
        var r = regions[i];
        if (!r || lat < r.latMin || lat > r.latMax) continue;
        var lo = wrapLon(r.lonMin), hi = wrapLon(r.lonMax);
        var inLon = (lo <= hi) ? (L >= lo && L <= hi) : (L >= lo || L <= hi);
        if (inLon) return r.name;
      }
    }
    return coordLabel(lat, lon);
  }

  /* ======================================================================
     2. Flare classes and severity words (pinned copy, shared with narration)
     ====================================================================== */

  /* GOES 0.1-0.8 nm flux (W/m^2) to the letter class plus scaled number. */
  function flareClass(flux) {
    if (!isFinite(flux) || flux <= 0) return null;
    var letters = ['A', 'B', 'C', 'M', 'X'];
    var bases = [1e-8, 1e-7, 1e-6, 1e-5, 1e-4];
    var i = 4;
    while (i > 0 && flux < bases[i]) i--;
    var scaled = flux / bases[i];
    if (i === 4 && scaled >= 10) scaled = Math.min(scaled, 999);
    return { letter: letters[i], scaled: scaled, text: letters[i] + (Math.round(scaled * 10) / 10).toFixed(1) };
  }

  /* "M2.1" back to W/m^2; returns NaN on anything unparsable. */
  function fluxFromClass(text) {
    if (typeof text !== 'string') return NaN;
    var m = /^\s*([ABCMX])\s*([0-9]+(?:\.[0-9]+)?)?\s*$/i.exec(text);
    if (!m) return NaN;
    var base = { a: 1e-8, b: 1e-7, c: 1e-6, m: 1e-5, x: 1e-4 }[m[1].toLowerCase()];
    var mult = m[2] ? parseFloat(m[2]) : 1;
    if (!isFinite(mult) || mult <= 0) return NaN;
    return base * mult;
  }

  /* Severity ladder, pinned in the spec copy block. */
  function quakeWord(mag) {
    if (!isFinite(mag)) return '';
    if (mag >= 8) return 'Great';
    if (mag >= 7) return 'Major';
    if (mag >= 6) return 'Strong';
    if (mag >= 5.5) return 'Moderate';
    return 'Light';
  }

  /* r19r item 8: ONE flare ladder, and it lives in obs-instruments
     (PURE.FLARE_LADDER, NOAA's R scale). This vocabulary and the class word
     used to be two scales, so at M2.1 the headline said "Moderate solar flare
     in progress" beside a vitals sentence reading "minor flare". The
     instrument's ladder is the authority whenever it is on the page; the rungs
     below are the SAME table, kept here for the case this kernel runs alone,
     and a node test holds the two to each other. Below M there is no flare to
     rank and no adjective for one: C is the background an active sun sits at
     for hours between flares. */
  function flareWord(flux) {
    var c = flareClass(flux);
    if (!c) return '';
    var I = global.ObsInstruments;
    if (I && I.PURE && typeof I.PURE.flareSeverity === 'function') {
      return I.PURE.flareSeverity(c);
    }
    if (c.letter === 'X') return c.scaled >= 10 ? 'Severe' : 'Strong';
    if (c.letter === 'M') return c.scaled >= 5 ? 'Moderate' : 'Minor';
    return '';
  }

  /* ======================================================================
     3. Event ranking (spec 2.3, node anchored in t-rank)
     ====================================================================== */

  var QUAKE_ANCHORS = [[5.0, 0.35], [5.5, 0.45], [6.0, 0.62], [6.5, 0.75], [7.0, 0.88], [8.0, 1.0]];
  /* flare anchors in log10 flux: C5, M1, M5, X1, X10 */
  var FLARE_ANCHORS = [
    [Math.log(5e-6) / Math.LN10, 0.15],
    [-5, 0.5],
    [Math.log(5e-5) / Math.LN10, 0.68],
    [-4, 0.82],
    [-3, 1.0]
  ];

  /* piecewise linear through anchors; below the first anchor the first
     segment's slope continues (floored at 0), above the last it clamps */
  function interpAnchors(anchors, x, extendLow) {
    var n = anchors.length;
    if (!isFinite(x)) return 0;
    if (x <= anchors[0][0]) {
      if (!extendLow) return anchors[0][1];
      var slope = (anchors[1][1] - anchors[0][1]) / (anchors[1][0] - anchors[0][0]);
      return Math.max(0, anchors[0][1] + (x - anchors[0][0]) * slope);
    }
    if (x >= anchors[n - 1][0]) return anchors[n - 1][1];
    for (var i = 1; i < n; i++) {
      if (x <= anchors[i][0]) {
        var a = anchors[i - 1], b = anchors[i];
        var f = (x - a[0]) / (b[0] - a[0]);
        return a[1] + f * (b[1] - a[1]);
      }
    }
    return anchors[n - 1][1];
  }

  function rankBase(cls, mag, meta) {
    if (cls === 'quake') return clamp(interpAnchors(QUAKE_ANCHORS, num(mag, NaN), true), 0, 1);
    if (cls === 'flare') {
      var flux = num(mag, NaN);
      if (!(flux > 0) && meta && typeof meta.cls === 'string') flux = fluxFromClass(meta.cls);
      if (!(flux > 0)) return 0;
      return clamp(interpAnchors(FLARE_ANCHORS, Math.log(flux) / Math.LN10, false), 0, 1);
    }
    if (cls === 'jam_new') return 0.55;
    if (cls === 'tfr_new') {
      var type = (meta && typeof meta.type === 'string') ? meta.type : '';
      return /vip|space/i.test(type) ? 0.35 : 0.2;
    }
    return 0;
  }

  var FRESH_FULL_MS = 30 * 60000;

  function freshness(cls, ageMs) {
    var zero = (cls === 'flare') ? 6 * 3600000 : 3 * 3600000;
    if (!isFinite(ageMs) || ageMs <= 0) return 1;
    if (ageMs <= FRESH_FULL_MS) return 1 - 0.6 * (ageMs / FRESH_FULL_MS);
    if (ageMs >= zero) return 0;
    return 0.4 * (1 - (ageMs - FRESH_FULL_MS) / (zero - FRESH_FULL_MS));
  }

  function rankEvent(evt, nowMs) {
    if (!evt) return 0;
    var base = rankBase(evt.cls, evt.mag, evt.meta);
    if (!(base > 0)) return 0;
    return clamp(base * freshness(evt.cls, num(nowMs, 0) - num(evt.t, 0)), 0, 1);
  }

  /* USGS versus EMSC style near duplicate: same class, within dtMs and dDeg. */
  function nearDuplicate(evt, list, opts) {
    if (!evt || !list) return null;
    var dt = (opts && isNum(opts.dtMs)) ? opts.dtMs : 60000;
    var dd = (opts && isNum(opts.dDeg)) ? opts.dDeg : 1;
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (!o || o.cls !== evt.cls || o.id === evt.id) continue;
      if (Math.abs(o.t - evt.t) > dt) continue;
      if (Math.abs(o.lat - evt.lat) > dd) continue;
      if (Math.abs(angDelta(o.lon, evt.lon)) > dd) continue;
      return o;
    }
    return null;
  }

  /* ======================================================================
     4. Solar sub-point (terminator)
     ====================================================================== */

  var J1970 = 2440587.5;

  function julianDay(ms) { return ms / 86400000 + J1970; }

  function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0); }

  /* Decimal year the way the WMM software does it: whole year plus the
     fraction of that year already elapsed. */
  function decimalYear(ms) {
    var d = new Date(ms);
    var y = d.getUTCFullYear();
    var start = Date.UTC(y, 0, 1);
    var end = Date.UTC(y + 1, 0, 1);
    return y + (ms - start) / (end - start);
  }

  /* Solar declination and the equation of time (minutes), NOAA formulation. */
  function solarPosition(ms) {
    var T = (julianDay(ms) - 2451545.0) / 36525;
    var L0 = 280.46646 + T * (36000.76983 + T * 0.0003032);
    L0 = L0 % 360; if (L0 < 0) L0 += 360;
    var M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
    var e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
    var Mr = M * DEG;
    var C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
            Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) +
            Math.sin(3 * Mr) * 0.000289;
    var trueLong = L0 + C;
    var omega = 125.04 - 1934.136 * T;
    var appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * DEG);
    var e0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
    var obliq = e0 + 0.00256 * Math.cos(omega * DEG);
    var decl = Math.asin(Math.sin(obliq * DEG) * Math.sin(appLong * DEG)) * RAD;
    var y = Math.tan(obliq * DEG / 2); y = y * y;
    var eq = y * Math.sin(2 * L0 * DEG)
           - 2 * e * Math.sin(Mr)
           + 4 * e * y * Math.sin(Mr) * Math.cos(2 * L0 * DEG)
           - 0.5 * y * y * Math.sin(4 * L0 * DEG)
           - 1.25 * e * e * Math.sin(2 * Mr);
    return { decl: decl, eqTimeMin: eq * 4 * RAD, appLong: appLong, obliq: obliq };
  }

  function solarDeclination(ms) { return solarPosition(ms).decl; }
  function equationOfTime(ms) { return solarPosition(ms).eqTimeMin; }

  /* Sub-solar point: the latitude is the declination, the longitude is where
     apparent solar noon is happening right now. */
  function sunSubpoint(ms) {
    var p = solarPosition(ms);
    var utcMin = (ms / 60000) % 1440;
    if (utcMin < 0) utcMin += 1440;
    var lon = wrapLon(-(utcMin + p.eqTimeMin - 720) / 4);
    return { lat: p.decl, lon: lon, decl: p.decl, eqTimeMin: p.eqTimeMin };
  }

  /* ======================================================================
     5. WMM2025 declination
     ====================================================================== */

  var WMM_A_KM = 6371.2;            /* geomagnetic reference radius */
  var WGS84_A = 6378.137;
  var WGS84_F = 1 / 298.257223563;
  var WGS84_E2 = WGS84_F * (2 - WGS84_F);

  var wmmN = 0;                     /* scratch sized for the current nMax */
  var wmmP = null, wmmDP = null, wmmS = null, wmmCosM = null, wmmSinM = null;
  var wmmCache = { src: null, year: NaN, g: null, h: null, nMax: 0 };

  function idxNM(n, m) { return (n * (n + 1) >> 1) + m; }

  function wmmScratch(nMax) {
    if (nMax === wmmN && wmmP) return;
    var size = ((nMax + 1) * (nMax + 2)) >> 1;
    wmmP = new Float64Array(size);
    wmmDP = new Float64Array(size);
    wmmS = new Float64Array(size);
    wmmCosM = new Float64Array(nMax + 1);
    wmmSinM = new Float64Array(nMax + 1);
    /* Schmidt quasi-normalization factors, computed once per nMax. */
    wmmS[0] = 1;
    for (var n = 1; n <= nMax; n++) {
      wmmS[idxNM(n, 0)] = wmmS[idxNM(n - 1, 0)] * (2 * n - 1) / n;
      for (var m = 1; m <= n; m++) {
        wmmS[idxNM(n, m)] = wmmS[idxNM(n, m - 1)] *
          Math.sqrt((n - m + 1) * (m === 1 ? 2 : 1) / (n + m));
      }
    }
    wmmN = nMax;
  }

  /* Time-adjusted coefficients, cached on (rows object, decimal year). */
  function wmmCoeffs(wmm, yearFrac) {
    if (wmmCache.src === wmm && wmmCache.year === yearFrac) return wmmCache;
    var rows = wmm && wmm.rows;
    if (!rows || !rows.length) return null;
    var nMax = num(wmm.nMax, 0);
    if (!nMax) { for (var i = 0; i < rows.length; i++) if (rows[i][0] > nMax) nMax = rows[i][0]; }
    var size = ((nMax + 1) * (nMax + 2)) >> 1;
    var g = new Float64Array(size), h = new Float64Array(size);
    var dt = yearFrac - num(wmm.epoch, 2025);
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var n = row[0] | 0, m = row[1] | 0;
      if (n < 1 || n > nMax || m < 0 || m > n) continue;
      var k = idxNM(n, m);
      g[k] = num(row[2], 0) + dt * num(row[4], 0);
      h[k] = num(row[3], 0) + dt * num(row[5], 0);
    }
    wmmCache.src = wmm; wmmCache.year = yearFrac;
    wmmCache.g = g; wmmCache.h = h; wmmCache.nMax = nMax;
    return wmmCache;
  }

  /* Schmidt semi-normalized associated Legendre functions and their
     derivatives with respect to latitude, from the Gauss-normalized
     recursion (the formulation NOAA's own geomagnetism library uses). */
  function wmmLegendre(nMax, sinLat) {
    var x = sinLat;
    var z = Math.sqrt((1 - x) * (1 + x));
    var P = wmmP, dP = wmmDP;
    P[0] = 1; dP[0] = 0;
    for (var n = 1; n <= nMax; n++) {
      for (var m = 0; m <= n; m++) {
        var i = idxNM(n, m);
        if (n === m) {
          var ia = idxNM(n - 1, m - 1);
          P[i] = z * P[ia];
          dP[i] = z * dP[ia] + x * P[ia];
        } else if (n === 1 && m === 0) {
          var ib = idxNM(0, 0);
          P[i] = x * P[ib];
          dP[i] = x * dP[ib] - z * P[ib];
        } else if (m > n - 2) {
          var ic = idxNM(n - 1, m);
          P[i] = x * P[ic];
          dP[i] = x * dP[ic] - z * P[ic];
        } else {
          var i1 = idxNM(n - 2, m), i2 = idxNM(n - 1, m);
          var k = ((n - 1) * (n - 1) - m * m) / ((2 * n - 1) * (2 * n - 3));
          P[i] = x * P[i2] - k * P[i1];
          dP[i] = x * dP[i2] - z * P[i2] - k * dP[i1];
        }
      }
    }
    var size = ((nMax + 1) * (nMax + 2)) >> 1;
    for (var j = 0; j < size; j++) {
      P[j] *= wmmS[j];
      dP[j] = -dP[j] * wmmS[j];   /* derivative with respect to latitude */
    }
  }

  var wmmOut = { x: 0, y: 0, z: 0, h: 0, f: 0, decl: NaN, incl: NaN };

  /* Full field at geodetic (lat, lon, altitude above the ellipsoid in km) for
     a decimal year. Returns the shared scratch object; copy what you keep. */
  function wmmField(wmm, latDeg, lonDeg, altKm, yearFrac, out) {
    out = out || wmmOut;
    out.x = out.y = out.z = out.h = out.f = 0;
    out.decl = out.incl = NaN;
    var alt = (altKm === undefined || altKm === null) ? 0 : num(altKm, NaN);
    if (!isNum(latDeg) || !isNum(lonDeg) || !isNum(alt) || !isNum(yearFrac)) return out;
    var co = wmmCoeffs(wmm, yearFrac);
    if (!co) return out;
    var nMax = co.nMax;
    wmmScratch(nMax);

    var lat = clamp(latDeg, -89.9999, 89.9999) * DEG;
    var lon = wrapLon(lonDeg) * DEG;

    /* geodetic to geocentric spherical on WGS84 */
    var sinLat = Math.sin(lat), cosLat = Math.cos(lat);
    var rc = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    var p = (rc + alt) * cosLat;
    var zc = (rc * (1 - WGS84_E2) + alt) * sinLat;
    var r = Math.sqrt(p * p + zc * zc);
    var latP = Math.asin(zc / r);
    var sinLatP = Math.sin(latP), cosLatP = Math.cos(latP);

    wmmLegendre(nMax, sinLatP);

    wmmCosM[0] = 1; wmmSinM[0] = 0;
    if (nMax >= 1) { wmmCosM[1] = Math.cos(lon); wmmSinM[1] = Math.sin(lon); }
    for (var m = 2; m <= nMax; m++) {
      wmmCosM[m] = wmmCosM[m - 1] * wmmCosM[1] - wmmSinM[m - 1] * wmmSinM[1];
      wmmSinM[m] = wmmSinM[m - 1] * wmmCosM[1] + wmmCosM[m - 1] * wmmSinM[1];
    }

    var rr = WMM_A_KM / r;
    var pw = rr * rr;
    var bx = 0, by = 0, bz = 0;
    var g = co.g, hh = co.h, P = wmmP, dP = wmmDP;
    for (var n = 1; n <= nMax; n++) {
      pw *= rr;                        /* (a/r)^(n+2) */
      for (var mm = 0; mm <= n; mm++) {
        var i = idxNM(n, mm);
        var gc = g[i] * wmmCosM[mm] + hh[i] * wmmSinM[mm];
        var gs = g[i] * wmmSinM[mm] - hh[i] * wmmCosM[mm];
        bz -= pw * gc * (n + 1) * P[i];
        bx -= pw * gc * dP[i];
        if (mm > 0) by += pw * gs * mm * P[i] / cosLatP;
      }
    }

    /* rotate the geocentric components into the geodetic frame */
    var psi = latP - lat;
    var cps = Math.cos(psi), sps = Math.sin(psi);
    var X = bx * cps - bz * sps;
    var Z = bx * sps + bz * cps;
    var Y = by;
    out.x = X; out.y = Y; out.z = Z;
    out.h = Math.sqrt(X * X + Y * Y);
    out.f = Math.sqrt(out.h * out.h + Z * Z);
    out.decl = Math.atan2(Y, X) * RAD;
    out.incl = Math.atan2(Z, out.h) * RAD;
    return out;
  }

  /* Magnetic declination in degrees, east positive. NaN when the model or
     the inputs are missing, so callers can drop the sample honestly. */
  function wmmDeclination(wmm, latDeg, lonDeg, altKm, yearFrac) {
    return wmmField(wmm, latDeg, lonDeg, altKm, yearFrac, wmmOut).decl;
  }

  /* ======================================================================
     6. Event bus
     ====================================================================== */

  var listeners = {};

  function on(topic, fn) {
    if (typeof fn !== 'function') return function () {};
    (listeners[topic] || (listeners[topic] = [])).push(fn);
    return function () { off(topic, fn); };
  }

  function off(topic, fn) {
    var a = listeners[topic];
    if (!a) return;
    var i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }

  var busErrors = 0;

  function emit(topic, payload) {
    var a = listeners[topic];
    if (!a || !a.length) return;
    var copy = a.slice();
    for (var i = 0; i < copy.length; i++) {
      try { copy[i](payload, topic); }
      catch (e) { busErrors++; logErr('bus listener for ' + topic, e); }
    }
  }

  function logErr(what, e) {
    if (global.console && global.console.warn) {
      try { global.console.warn('[ObsCore] ' + what + ': ' + (e && e.message ? e.message : e)); }
      catch (ignored) { /* console can be hostile in odd embeds */ }
    }
  }

  /* ======================================================================
     7. Antenna base
     ====================================================================== */

  var ANTENNA_DEFAULT = 'https://obs-antenna.keenlooks-cloudflare.workers.dev';
  /* OWNER-CONFIG: confirm the deployed host, then edit this one list. */
  var ANTENNA_ALLOW = ['obs-antenna.keenlooks-cloudflare.workers.dev'];
  var antennaBase = ANTENNA_DEFAULT;

  function isLocalHost(h) {
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  }

  /* Returns the cleaned base, or null when the candidate is not allowed.
     Dev override may only reach localhost; anything else must be https on a
     host in the allow list. Credentials, query and hash are refused. */
  function validAntennaBase(url) {
    if (typeof url !== 'string' || !url) return null;
    var u;
    try { u = new URL(url); } catch (e) { return null; }
    if (u.username || u.password) return null;
    if (u.search || u.hash) return null;
    var host = (u.hostname || '').toLowerCase();
    if (isLocalHost(host)) {
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    } else {
      if (u.protocol !== 'https:') return null;
      if (ANTENNA_ALLOW.indexOf(host) < 0) return null;
    }
    var base = u.origin + u.pathname;
    return base.replace(/\/+$/, '');
  }

  function setAntennaBase(url) {
    var v = validAntennaBase(url);
    if (!v) return false;
    antennaBase = v;
    return true;
  }

  function getAntennaBase() { return antennaBase; }

  /* "?antenna=http://127.0.0.1:8788" dev override. Pure enough to test. */
  function antennaFromSearch(search) {
    if (typeof search !== 'string' || search.indexOf('antenna=') < 0) return null;
    var m = /[?&]antenna=([^&]+)/.exec(search);
    if (!m) return null;
    var raw;
    try { raw = decodeURIComponent(m[1]); } catch (e) { return null; }
    return validAntennaBase(raw);
  }

  function applyAntennaOverride(search) {
    var v = antennaFromSearch(search);
    if (v) { antennaBase = v; return v; }
    return null;
  }

  /* ======================================================================
     8. Feed registry and net layer
     ====================================================================== */

  var CHUNK_BYTES = 256 * 1024;     /* parse yields above this */
  var PARSE_SLICE_MS = 4;           /* spec 9: no parse slice over 4 ms */
  var BACKOFF_CAP_MS = 15 * 60000;
  /*
   * A fetch that never settles is worse than one that fails: the feed stays on
   * whatever it last held, the health map keeps saying "live", and the poll timer
   * is never rearmed, so the feed is silently dead for the rest of the session.
   * Two mechanisms, because there are two kinds of fetcher (r12 item 15):
   *   * defaultFetch aborts its own request on the deadline, which closes the socket;
   *   * pollNow arms a watchdog for every poll, including the feeds that bring their
   *     own fetcher, so a hung request becomes an honest offline state either way.
   * The watchdog fires slightly after the abort deadline so an abort that works
   * reports itself as an abort rather than as a watchdog trip.
   */
  var FETCH_TIMEOUT_MS = 30000;
  var FETCH_TIMEOUT_SLOW_MS = 90000;   /* ovation and clouds: big payloads, slow origins */
  var WATCHDOG_GRACE_MS = 2000;
  var SSE_HARD_MS = 14 * 60000;     /* EventStreams drops around 15 minutes */
  var LAZY_LINGER_MS = 60000;
  /* r13 item 12: how many handshakes a socket that has NEVER opened gets before
     this page stops asking. Five, so a slow or flapping network still gets
     several chances at the backoff cadence before the feed stands down. */
  var WS_GIVE_UP = 5;
  var STREAM_UPDATE_MS = 250;       /* coalesce feed:update for push feeds */
  var DEBOUNCE_MS = 1000;

  var feeds = {};
  var feedOrder = [];
  var started = false;
  var stats = { fetches: 0, errors: 0, bytes: 0, computes: 0, parses: 0, timeouts: 0 };

  var VALID_KINDS = { poll: 1, sse: 1, ws: 1, antenna: 1 };

  function registerFeed(m) {
    if (!m || typeof m.id !== 'string' || !m.id) throw new Error('feed needs an id');
    if (feeds[m.id]) throw new Error('duplicate feed id: ' + m.id);
    if (!VALID_KINDS[m.kind]) throw new Error('feed ' + m.id + ' has an unknown kind: ' + m.kind);
    if (typeof m.parse !== 'function') throw new Error('feed ' + m.id + ' needs a parse function');
    if (typeof m.url !== 'string' && typeof m.fetcher !== 'function') {
      throw new Error('feed ' + m.id + ' needs a url or a fetcher');
    }
    var rec = {
      id: m.id,
      m: m,
      health: 'idle',
      data: null,
      t: 0,
      lastOkMs: 0,
      fails: 0,
      seq: 0,
      timer: null,
      staleTimer: null,
      lingerTimer: null,
      hardTimer: null,
      streamTimer: null,
      conn: null,
      connected: false,
      consumers: 0,
      holds: 0,
      lastEventId: '',
      lastErr: null,
      /* r19 item 8: WHY this feed is where it is, and when it will be asked
         again. '' while nothing has failed; 'rate-limited' when the server (or
         our own quota) said so and named a window; 'stale-body' when the
         fetcher served a stored body rather than a fresh one; 'offline' when
         the relay answered that it is not switched on; 'error' otherwise. */
      reason: '',
      retryAtMs: NaN,
      bytes: 0,
      msgs: 0,
      pstate: {},
      offlineFlag: false,
      /* r13 item 12. A socket that has never once opened is a different fact
         from a socket that dropped: the first is an endpoint this visitor
         cannot reach, and retrying it for ever writes a browser network error
         into the console on a fixed cadence for the whole visit. wsEverOpen is
         set on the first successful handshake and never cleared, so an
         ordinary outage on a socket that HAS worked still reconnects for ever. */
      wsTries: 0,
      wsEverOpen: false,
      wsGaveUp: false
    };
    feeds[m.id] = rec;
    feedOrder.push(m.id);
    return m.id;
  }

  function feedRec(id) { return feeds[id] || null; }
  function feedData(id) { var r = feeds[id]; return r ? r.data : null; }
  function feedHealth(id) { var r = feeds[id]; return r ? r.health : 'offline'; }

  function healthMap() {
    var out = {};
    for (var i = 0; i < feedOrder.length; i++) out[feedOrder[i]] = feeds[feedOrder[i]].health;
    return out;
  }

  function setHealth(rec, h) {
    if (rec.health === h) return;
    var prev = rec.health;
    rec.health = h;
    /* r19 item 8: the cause travels with the word, so a listener never has to
       ask a second question to write one honest sentence. */
    emit('feed:health', { id: rec.id, health: h, prev: prev,
                          reason: rec.reason, retryAtMs: rec.retryAtMs });
  }

  /* r19 item 8: one feed's whole state, for the page. Everything the page used
     to reach into the record for, under names the record and the events agree
     with. Null for a feed that was never registered. */
  function feedState(id) {
    var r = feeds[id];
    if (!r) return null;
    return { id: r.id, health: r.health, reason: r.reason, retryAtMs: r.retryAtMs,
             fails: r.fails, hadData: !!(r.data || r.lastOkMs), connected: !!r.connected,
             antenna: r.m.kind === 'antenna',
             errText: (r.lastErr && r.lastErr.message) ? r.lastErr.message : '',
             cacheStale: !!(r.data && r.data.cacheStale) };
  }

  function feedUrl(rec) {
    var u = rec.m.url;
    if (rec.m.kind === 'antenna') {
      if (typeof u !== 'string') return null;
      return antennaBase + (u.charAt(0) === '/' ? u : '/' + u);
    }
    return typeof u === 'string' ? u : null;
  }

  function rawSize(raw) {
    if (raw == null) return 0;
    if (typeof raw === 'string') return raw.length;
    if (typeof raw.byteLength === 'number') return raw.byteLength;
    if (typeof raw.length === 'number') return raw.length;
    return 0;
  }

  /* The deadline this feed's request gets. A manifest may name its own. */
  function timeoutFor(rec) {
    var t = num(rec.m.timeoutMs, NaN);
    return isNum(t) && t > 0 ? t : FETCH_TIMEOUT_MS;
  }

  /* Default fetcher. A 503 carrying {offline:true} is a known state, not a
     failure to retry harder against (the NOTAM route while unconfigured). Since
     r12 a 200 carrying the same body means the same thing: a relay that is
     deliberately not switched on answers honestly without making every poll
     print a network error in the console. */
  function offlineBody(text) {
    var off = false;
    try { off = !!JSON.parse(text).offline; } catch (e) { off = false; }
    return off;
  }

  function offlineErr() {
    var err = new Error('relay offline');
    err.offline = true;
    return err;
  }

  function defaultFetch(url, rec) {
    var f = env.fetch || global.fetch;
    if (typeof f !== 'function') return Promise.reject(new Error('no fetch available'));
    var opts = rec.m.fetchOpts || undefined;
    /* An AbortController the environment does not have is not a reason to skip the
       fetch: the pollNow watchdog still bounds it, this only closes the socket. */
    var ac = null, killer = null;
    var AC = global.AbortController;
    if (typeof AC === 'function' && !(opts && opts.signal)) {
      try { ac = new AC(); } catch (e) { ac = null; }
    }
    if (ac) {
      opts = opts ? shallow(opts) : {};
      opts.signal = ac.signal;
      killer = later(function () {
        try { ac.abort(); } catch (e) { /* already settled */ }
      }, timeoutFor(rec));
    }
    function done(v) { if (killer !== null) { cancel(killer); killer = null; } return v; }
    return f(url, opts).then(function (res) {
      if (!res.ok) {
        /* r19 item 8. A rate limit is a named state with a time on it, not one
           more failed request: the page says "it is asked again at HH:MM" and
           it can only say that if the cause survives the throw. Retry-After
           when the server sent one, this feed's own cadence otherwise, which
           is when the page would have asked anyway. */
        if (res.status === 429) {
          var rl = new Error('http 429');
          rl.rateLimited = true;
          var ra = null;
          try { ra = res.headers && res.headers.get ? res.headers.get('Retry-After') : null; }
          catch (e2) { ra = null; }
          var secs = (ra !== null && ra !== '') ? Number(ra) : NaN;
          rl.retryAtMs = (isNum(secs) && secs >= 0 && secs < 86400)
            ? now() + secs * 1000
            : now() + num(rec.m.cadenceMs, 60000);
          throw rl;
        }
        if (res.status === 503 && typeof res.text === 'function') {
          return res.text().then(function (body) {
            var err = new Error('http 503');
            err.offline = offlineBody(body);
            throw err;
          });
        }
        throw new Error('http ' + res.status);
      }
      var type = rec.m.responseType || 'text';
      if (type === 'arrayBuffer') return res.arrayBuffer();
      if (type === 'json') {
        return res.json().then(function (j) {
          if (j && j.offline === true) throw offlineErr();
          return j;
        });
      }
      return res.text().then(function (text) {
        /* An honest offline answer, served with a 200 so the browser stays quiet. */
        if (text && text.length < 512 && text.charAt(0) === '{' && offlineBody(text)) {
          throw offlineErr();
        }
        return text;
      });
    }).then(done, function (e) { done(); throw e; });
  }

  function shallow(o) {
    var out = {};
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
    return out;
  }

  /*
   * Backoff must never retry FASTER than the healthy cadence. Three feeds poll more slowly
   * than the 15 minute cap (ovation 30 min, clouds 20 min, openmeteo 60 min), so capping
   * alone turned an outage into more traffic than working service, which is both the
   * opposite of backing off and impolite to the upstream. The cap is therefore floored at
   * the feed's own cadence. Harmless for the 5 s stream reconnect bases, which are already
   * far below the cap.
   */
  function backoffDelay(rec) {
    var base = num(rec.m.cadenceMs, 60000);
    if (rec.fails <= 0) return base;
    var d = base * Math.pow(2, Math.min(rec.fails, 20));
    d = Math.max(base, Math.min(d, BACKOFF_CAP_MS));
    var j = 0.8 + 0.4 * env.random();
    return Math.max(base, Math.round(d * j));   /* jitter may not undercut it either */
  }

  function schedulePoll(rec, ms) {
    cancel(rec.timer);
    rec.timer = later(function () { pollNow(rec); }, Math.max(0, ms));
  }

  function pollNow(rec) {
    rec.timer = null;
    if (!rec.connected) return;
    var url = feedUrl(rec);
    if (!url && typeof rec.m.fetcher !== 'function') { failFeed(rec, new Error('no url')); return; }
    var seq = ++rec.seq;
    var p;
    stats.fetches++;
    try {
      p = (typeof rec.m.fetcher === 'function') ? rec.m.fetcher(url, rec.id) : defaultFetch(url, rec);
    } catch (e) { failFeed(rec, e); return; }
    /*
     * The watchdog. A feed that brings its own fetcher (the X-ray ladder, the cloud
     * discs, the launch pair) is not covered by defaultFetch's abort, and a promise
     * that never settles would leave this feed with no timer to poll on again. When
     * the deadline passes the sequence is bumped, which makes the late answer a
     * no-op, and the feed goes through the normal failure path with an honest reason.
     */
    var wd = later(function () {
      wd = null;
      if (seq !== rec.seq || !rec.connected) return;
      rec.seq++;
      stats.timeouts++;
      failFeed(rec, new Error('no answer within ' + Math.round(timeoutFor(rec) / 1000) + ' s'));
    }, timeoutFor(rec) + WATCHDOG_GRACE_MS);
    function stopWd() { if (wd !== null) { cancel(wd); wd = null; } }
    Promise.resolve(p).then(function (raw) {
      stopWd();
      if (seq !== rec.seq || !rec.connected) return;
      handleRaw(rec, raw, true);
    }, function (err) {
      stopWd();
      if (seq !== rec.seq || !rec.connected) return;
      failFeed(rec, err);
    });
  }

  /* raw -> parse (chunked when big) -> data */
  function handleRaw(rec, raw, reschedule) {
    var size = rawSize(raw);
    rec.bytes += size; stats.bytes += size;
    if (size > CHUNK_BYTES) {
      later(function () { if (rec.connected) runParse(rec, raw, reschedule); }, 0);
    } else {
      runParse(rec, raw, reschedule);
    }
  }

  function parseCtx(rec) {
    return { id: rec.id, now: now(), prev: rec.data, state: rec.pstate };
  }

  /* A parse may return the payload directly, or an iterator: the kernel then
     drives it in slices of PARSE_SLICE_MS, yielding between slices, and the
     iterator's final value is the payload. That is how a feed keeps a big
     document off the animation frame. */
  function runParse(rec, raw, reschedule) {
    var out;
    stats.parses++;
    try { out = rec.m.parse(raw, parseCtx(rec)); }
    catch (e) { failFeed(rec, e, reschedule); return; }
    if (out && typeof out.next === 'function') driveParse(rec, out, reschedule);
    else finishParse(rec, out, reschedule);
  }

  function driveParse(rec, it, reschedule) {
    var t0 = now();
    for (;;) {
      var step;
      try { step = it.next(); }
      catch (e) { failFeed(rec, e, reschedule); return; }
      if (step && step.done) { finishParse(rec, step.value, reschedule); return; }
      if (now() - t0 >= PARSE_SLICE_MS) {
        later(function () { if (rec.connected) driveParse(rec, it, reschedule); }, 0);
        return;
      }
    }
  }

  function finishParse(rec, parsed, reschedule) {
    if (!parsed || typeof parsed !== 'object') {
      failFeed(rec, new Error('parse produced nothing'), reschedule);
      return;
    }
    rec.data = parsed;
    rec.t = isNum(parsed.t) ? parsed.t : now();
    rec.lastOkMs = now();
    rec.fails = 0;
    rec.offlineFlag = false;
    /* r19 item 8. A fetcher that fell back to a body this browser stored (the
       launch schedule does, when the API rate limits it) has served something
       true and out of date, which is exactly what 'stale' means. Calling it
       live would date the sentence above it wrongly, and calling it offline
       would deny a schedule the reader can see. */
    if (parsed.cacheStale) {
      rec.reason = 'stale-body';
      setHealth(rec, 'stale');
    } else {
      rec.reason = '';
      rec.retryAtMs = NaN;
      setHealth(rec, 'live');
    }
    armStale(rec);
    emit('feed:update', { id: rec.id, t: rec.t });
    markDirtyForFeed(rec.id);
    if (reschedule && isPollKind(rec)) schedulePoll(rec, num(rec.m.cadenceMs, 60000));
  }

  function isPollKind(rec) { return rec.m.kind === 'poll' || rec.m.kind === 'antenna'; }

  function armStale(rec) {
    cancel(rec.staleTimer); rec.staleTimer = null;
    var after = num(rec.m.staleAfterMs, 0);
    if (!(after > 0)) return;
    var due = rec.t + after - now();
    if (due <= 0) { setHealth(rec, 'stale'); return; }
    rec.staleTimer = later(function () {
      rec.staleTimer = null;
      if (rec.connected && rec.health === 'live') setHealth(rec, 'stale');
    }, due);
  }

  /* r19 item 8: one place decides the cause and the next attempt, so the
     record, the events and feedState can never disagree about them. */
  function noteFailure(rec, err, delayMs) {
    rec.reason = (err && err.rateLimited) ? 'rate-limited'
               : ((err && err.offline) ? 'offline' : 'error');
    rec.retryAtMs = (err && isNum(err.retryAtMs)) ? err.retryAtMs
                  : (isNum(delayMs) ? now() + delayMs : NaN);
  }

  function failFeed(rec, err, reschedule) {
    stats.errors++;
    rec.lastErr = err;
    if (err && err.offline) {
      rec.offlineFlag = true;
      rec.fails = 0;
      noteFailure(rec, err, num(rec.m.cadenceMs, 60000));
      setHealth(rec, 'offline');
      emit('feed:error', { id: rec.id, offline: true, message: errMsg(err),
                           reason: rec.reason, retryAtMs: rec.retryAtMs });
      if (reschedule !== false && isPollKind(rec)) schedulePoll(rec, num(rec.m.cadenceMs, 60000));
      return;
    }
    rec.fails++;
    noteFailure(rec, err, backoffDelay(rec));
    /* r19 item 8. A feed holding data gets three chances before the page calls
       it offline, because the numbers on the screen are still real meanwhile.
       A feed holding NOTHING has no such cover: its request failed and there
       is nothing to show, so it is offline from the first failure. Leaving it
       at 'idle' is what kept "Connecting to the launch schedule" on the page
       for as long as anyone watched. */
    if (rec.fails >= 3 || !rec.data) setHealth(rec, 'offline');
    else setHealth(rec, 'stale');
    emit('feed:error', { id: rec.id, fails: rec.fails, message: errMsg(err),
                         reason: rec.reason, retryAtMs: rec.retryAtMs });
    if (reschedule !== false && isPollKind(rec)) schedulePoll(rec, backoffDelay(rec));
  }

  function errMsg(e) { return (e && e.message) ? e.message : String(e); }

  /* ---- streams ---- */

  function openSse(rec) {
    var ES = env.EventSource || global.EventSource;
    if (typeof ES !== 'function') { failFeed(rec, new Error('EventSource unavailable'), false); return; }
    var url = feedUrl(rec);
    if (typeof rec.m.sseUrl === 'function') url = rec.m.sseUrl(url, rec.lastEventId);
    var es;
    try { es = new ES(url); } catch (e) { failFeed(rec, e, false); return; }
    rec.conn = es;
    es.onopen = function () { rec.fails = 0; setHealth(rec, 'live'); };
    es.onmessage = function (ev) {
      if (ev && ev.lastEventId) rec.lastEventId = ev.lastEventId;
      onStreamMessage(rec, ev ? ev.data : null);
    };
    es.onerror = function (e) { streamError(rec, e); };
    cancel(rec.hardTimer);
    rec.hardTimer = later(function () { hardReconnect(rec); }, SSE_HARD_MS);
  }

  function hardReconnect(rec) {
    rec.hardTimer = null;
    if (!rec.connected) return;
    closeConn(rec);
    openSse(rec);
  }

  function openWs(rec) {
    var WS = env.WebSocket || global.WebSocket;
    if (typeof WS !== 'function') { failFeed(rec, new Error('WebSocket unavailable'), false); return; }
    var ws;
    try { ws = new WS(feedUrl(rec)); } catch (e) { wsRetry(rec, e); return; }
    rec.conn = ws;
    ws.onopen = function () {
      rec.fails = 0;
      rec.wsTries = 0;
      rec.wsEverOpen = true;
      setHealth(rec, 'live');
    };
    ws.onmessage = function (ev) { onStreamMessage(rec, ev ? ev.data : null); };
    ws.onerror = function () { /* close follows; handled there */ };
    ws.onclose = function () {
      if (!rec.connected) return;
      rec.conn = null;
      wsRetry(rec, new Error('socket closed'));
    };
  }

  function wsRetry(rec, err) {
    rec.fails++;
    rec.wsTries++;
    if (rec.fails >= 3) setHealth(rec, 'offline');
    else if (rec.data) setHealth(rec, 'stale');
    rec.lastErr = err;
    stats.errors++;
    /*
     * r13 item 12. The browser writes its own network error to the console for
     * every failed handshake, and nothing in this file can catch that one. So
     * an endpoint a visitor genuinely cannot reach is stopped rather than
     * retried on a cadence for the whole visit: WS_GIVE_UP handshakes with no
     * successful open, and the feed stands down as offline. Everything that
     * reads it already has a polled path (the seismic socket is the extra on
     * top of USGS polling), and the health it reports is the truth. A tab
     * return calls disconnectFeed then connectFeed, which is a deliberate
     * fresh attempt and clears this.
     */
    var giveUp = !rec.wsEverOpen && rec.wsTries >= WS_GIVE_UP;
    if (giveUp) {
      rec.wsGaveUp = true;
      setHealth(rec, 'offline');
      emit('feed:error', { id: rec.id, fails: rec.fails, gaveUp: true, message: errMsg(err) });
      return;
    }
    emit('feed:error', { id: rec.id, fails: rec.fails, message: errMsg(err) });
    cancel(rec.timer);
    rec.timer = later(function () {
      rec.timer = null;
      if (rec.connected) openWs(rec);
    }, backoffDelay(rec));
  }

  function streamError(rec, e) {
    /* The browser reconnects an EventSource on its own; we only track health
       so a permanently dead stream shows as offline instead of pretending. */
    rec.fails++;
    stats.errors++;
    rec.lastErr = e;
    if (rec.fails >= 3) setHealth(rec, 'offline');
    else if (rec.data) setHealth(rec, 'stale');
    emit('feed:error', { id: rec.id, fails: rec.fails, message: 'stream error' });
  }

  function onStreamMessage(rec, raw) {
    var size = rawSize(raw);
    rec.bytes += size; stats.bytes += size;
    rec.msgs++;
    var parsed;
    try { parsed = rec.m.parse(raw, parseCtx(rec)); }
    catch (e) {
      /* parse errors count toward health but never drop the connection */
      failFeed(rec, e, false);
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    rec.fails = 0;
    rec.data = parsed;
    rec.t = isNum(parsed.t) ? parsed.t : now();
    rec.lastOkMs = now();
    setHealth(rec, 'live');
    armStale(rec);
    emit('feed:message', { id: rec.id, value: parsed });
    if (rec.streamTimer === null) {
      rec.streamTimer = later(function () {
        rec.streamTimer = null;
        emit('feed:update', { id: rec.id, t: rec.t });
        markDirtyForFeed(rec.id);
      }, STREAM_UPDATE_MS);
    }
  }

  function closeConn(rec) {
    var c = rec.conn;
    rec.conn = null;
    if (!c) return;
    try {
      if (typeof c.close === 'function') c.close();
    } catch (e) { logErr('closing ' + rec.id, e); }
    c.onmessage = c.onerror = c.onopen = c.onclose = null;
  }

  /* ---- connect / disconnect ---- */

  /*
   * Reconnecting is not a reason to refetch. A tab return disconnects and reconnects every
   * feed, and polling immediately re-pulled the 924 KB aurora grid and both GOES discs when
   * they still had twenty minutes of validity left. disconnectFeed keeps rec.data and
   * rec.lastOkMs, so a feed whose last good pull is still inside its cadence resumes on the
   * remainder of its own clock instead. Anything stale, failed or never fetched polls at
   * once, which is what the visibility contract is actually for.
   */
  function pollDelayOnConnect(rec) {
    if (!rec.data || !rec.lastOkMs || rec.fails > 0) return 0;
    var cad = num(rec.m.cadenceMs, 0);
    if (!(cad > 0)) return 0;
    var age = now() - rec.lastOkMs;
    if (!(age >= 0) || age >= cad) return 0;
    return cad - age;
  }

  function connectFeed(rec) {
    if (rec.connected) return;
    rec.connected = true;
    rec.seq++;
    cancel(rec.lingerTimer); rec.lingerTimer = null;
    if (rec.m.kind === 'sse') openSse(rec);
    else if (rec.m.kind === 'ws') {
      /* a deliberate fresh attempt: a tab return, or a lazy socket wanted
         again, is worth the handshakes r13 item 12 stopped */
      rec.wsTries = 0;
      rec.wsGaveUp = false;
      openWs(rec);
    }
    else {
      var wait = pollDelayOnConnect(rec);
      if (wait > 0) { setHealth(rec, 'live'); armStale(rec); schedulePoll(rec, wait); }
      else pollNow(rec);
    }
  }

  function disconnectFeed(rec) {
    if (!rec.connected) return;
    rec.connected = false;
    rec.seq++;
    cancel(rec.timer); rec.timer = null;
    cancel(rec.staleTimer); rec.staleTimer = null;
    cancel(rec.hardTimer); rec.hardTimer = null;
    cancel(rec.streamTimer); rec.streamTimer = null;
    cancel(rec.lingerTimer); rec.lingerTimer = null;
    closeConn(rec);
    rec.fails = 0;
    setHealth(rec, 'idle');
  }

  function wanted(rec) { return rec.consumers > 0 || rec.holds > 0; }

  function refresh(rec) {
    if (!started) return;
    if (rec.m.lazy) {
      if (wanted(rec)) {
        cancel(rec.lingerTimer); rec.lingerTimer = null;
        connectFeed(rec);
      } else if (rec.connected && rec.lingerTimer === null) {
        rec.lingerTimer = later(function () {
          rec.lingerTimer = null;
          if (!wanted(rec)) disconnectFeed(rec);
        }, LAZY_LINGER_MS);
      }
    } else if (!rec.connected) {
      connectFeed(rec);
    }
  }

  function addConsumer(id, delta) {
    var rec = feeds[id];
    if (!rec) return;
    rec.consumers = Math.max(0, rec.consumers + delta);
    refresh(rec);
  }

  /* Explicit keep-alive, ref counted: the stopwatch holds wm_edits open while
     a clock is running even if nothing else wants it. */
  function holdFeed(id, on) {
    var rec = feeds[id];
    if (!rec) return false;
    rec.holds = Math.max(0, rec.holds + (on ? 1 : -1));
    refresh(rec);
    return true;
  }

  function start() {
    if (started) return;
    started = true;
    var stagger = 0;
    for (var i = 0; i < feedOrder.length; i++) {
      var rec = feeds[feedOrder[i]];
      if (rec.m.lazy && !wanted(rec)) continue;
      (function (r, d) { later(function () { if (started) connectFeed(r); }, d); })(rec, stagger);
      stagger += 100;
    }
  }

  function stop() {
    started = false;
    for (var i = 0; i < feedOrder.length; i++) disconnectFeed(feeds[feedOrder[i]]);
    /* r26 (13): the compute queue and its one timer */
    computeQ.length = 0;
    cancel(pumpTimer); pumpTimer = null;
    for (var j = 0; j < instOrder.length; j++) instruments[instOrder[j]].dueAt = NaN;
  }

  /* ======================================================================
     9. Instrument registry
     ====================================================================== */

  var instruments = {};
  var instOrder = [];

  function registerInstrument(m) {
    if (!m || typeof m.id !== 'string' || !m.id) throw new Error('instrument needs an id');
    if (instruments[m.id]) throw new Error('duplicate instrument id: ' + m.id);
    if (typeof m.compute !== 'function') throw new Error('instrument ' + m.id + ' needs compute');
    var rec = {
      id: m.id,
      m: m,
      inputs: (m.inputs && m.inputs.slice) ? m.inputs.slice() : [],
      armed: false,
      state: (m.initialState && typeof m.initialState === 'object') ? m.initialState : {},
      out: null,
      timer: null,
      lastComputeMs: 0,
      computes: 0,
      /* r26 (13): when this record's debounce window closes. NaN when it is
         not in the compute queue. */
      dueAt: NaN,
      dataArg: {}
    };
    instruments[m.id] = rec;
    instOrder.push(m.id);
    if (m.always) arm(m.id);
    return m.id;
  }

  function instRec(id) { return instruments[id] || null; }

  function arm(id) {
    var rec = instruments[id];
    if (!rec || rec.armed) return false;
    rec.armed = true;
    for (var i = 0; i < rec.inputs.length; i++) addConsumer(rec.inputs[i], 1);
    emit('instrument:arm', { id: id });
    scheduleCompute(rec, 0);
    return true;
  }

  function disarm(id) {
    var rec = instruments[id];
    if (!rec || !rec.armed) return false;
    if (rec.m.always) return false;
    rec.armed = false;
    for (var i = 0; i < rec.inputs.length; i++) addConsumer(rec.inputs[i], -1);
    /* r26 (13): out of the queue, not off a timer of its own */
    unqueue(rec);
    emit('instrument:disarm', { id: id });
    return true;
  }

  function armedList() {
    var out = [];
    for (var i = 0; i < instOrder.length; i++) if (instruments[instOrder[i]].armed) out.push(instOrder[i]);
    return out;
  }

  function markDirtyForFeed(feedId) {
    for (var i = 0; i < instOrder.length; i++) {
      var rec = instruments[instOrder[i]];
      if (!rec.armed) continue;
      if (rec.inputs.indexOf(feedId) < 0) continue;
      scheduleCompute(rec, DEBOUNCE_MS);
    }
  }

  /* ---- r26 ruling (13): ONE COMPUTE PER TASK ---------------------------
     One compute per instrument per second at most: a queued instrument
     swallows everything that arrives inside its window.

     Until r26 each dirty instrument got its OWN timer at the same
     DEBOUNCE_MS, so every timer fell due in the same millisecond and the
     renderer ran them in ONE event-loop task. Three computes that each met
     the 50 ms bar therefore made one 136 ms task (r25 INTEGRATION 3.4,
     measured: compute ambient 40.6 + compute ambient 41.6 + compute
     winds_residual 19.5). The queue below is a SERIALISER: one pending timer
     for the whole registry, one compute per task, and the next task posted at
     0 ms from inside the previous one, so the event loop gets a turn between
     every pair.

     Nothing about WHAT is computed moves. compute is pure over (data, state,
     t), the debounce window is unchanged, and the order is the order the
     instruments went dirty. */
  var computeQ = [];            /* instrument records waiting for a task */
  var pumpTimer = null;         /* the ONE timer the queue runs on */

  function queuedAt(rec) {
    for (var i = 0; i < computeQ.length; i++) if (computeQ[i] === rec) return i;
    return -1;
  }

  function unqueue(rec) {
    var i = queuedAt(rec);
    if (i >= 0) computeQ.splice(i, 1);
    rec.dueAt = NaN;
  }

  /* The next record whose debounce window has closed, or null. */
  function nextDue(t) {
    var best = -1, bestDue = Infinity, i, d;
    for (i = 0; i < computeQ.length; i++) {
      d = computeQ[i].dueAt;
      if (!(typeof d === 'number' && isFinite(d))) d = t;
      if (d <= t) { best = i; bestDue = d; break; }
      if (d < bestDue) { bestDue = d; }
    }
    if (best >= 0) return { idx: best, wait: 0 };
    if (!computeQ.length) return null;
    return { idx: -1, wait: Math.max(0, bestDue - t) };
  }

  function pump() {
    if (pumpTimer !== null) return;
    var t = now();
    var nx = nextDue(t);
    if (!nx) return;
    pumpTimer = later(function () {
      pumpTimer = null;
      var t2 = now();
      var n2 = nextDue(t2);
      if (n2 && n2.idx >= 0) {
        var rec = computeQ.splice(n2.idx, 1)[0];
        rec.dueAt = NaN;
        /* ONE compute, then hand the loop back. A throw inside runCompute is
           caught there; a throw anywhere else must still leave the queue
           pumping, or one bad instrument stops every other one. */
        try { if (rec.armed) runCompute(rec); } catch (e) { logErr('pump', e); }
      }
      if (computeQ.length) pump();
    }, nx.idx >= 0 ? 0 : nx.wait);
  }

  function scheduleCompute(rec, delay) {
    if (!rec.armed) return;
    if (queuedAt(rec) >= 0) return;
    rec.dueAt = now() + Math.max(0, num(delay, 0));
    computeQ.push(rec);
    pump();
  }

  var OFFLINE_OUT_LINE = 'This instrument stopped computing. Nothing here is being claimed right now.';

  /* The data argument is one reused object per instrument (no allocation on
     the recompute path). compute is pure and must not hold on to it. */
  function runCompute(rec) {
    if (!rec.armed) return;
    var data = rec.dataArg;
    for (var i = 0; i < rec.inputs.length; i++) data[rec.inputs[i]] = feedData(rec.inputs[i]);
    var t = now();
    var out = null, threw = null;
    try { out = rec.m.compute(data, rec.state, t); }
    catch (e) { threw = e; }
    stats.computes++;
    rec.computes++;
    rec.lastComputeMs = t;
    if (threw) {
      logErr('compute ' + rec.id, threw);
      emit('instrument:error', { id: rec.id, message: errMsg(threw) });
      rec.out = { primitives: [], readout: {}, status: 'offline', statusLine: OFFLINE_OUT_LINE, t: t };
      emit('instrument:update', { id: rec.id, out: rec.out });
      return;
    }
    out = out || {};
    rec.out = {
      primitives: Array.isArray(out.primitives) ? out.primitives : [],
      readout: (out.readout && typeof out.readout === 'object') ? out.readout : {},
      status: typeof out.status === 'string' ? out.status : 'ok',
      statusLine: typeof out.statusLine === 'string' ? out.statusLine : '',
      t: t
    };
    /* r19 item 7: the feed ids the status line was computed from travel with
       the line, so the rack footer can date the sentence it is showing rather
       than the stalest input the layer happens to declare. An instrument that
       does not publish them leaves the field off, and the page falls back to
       all measured inputs, which is exactly what it did before. */
    if (out.lineInputs && out.lineInputs.length !== undefined &&
        typeof out.lineInputs !== 'string') {
      rec.out.lineInputs = [].slice.call(out.lineInputs);
    }
    /* compute stays pure: events it wants to raise ride out on the result. */
    if (Array.isArray(out.events)) {
      for (var e = 0; e < out.events.length; e++) emitEvent(out.events[e]);
    }
    emit('instrument:update', { id: rec.id, out: rec.out });
  }

  /* Force a compute now (page boot, test seams). Bypasses the debounce. */
  function recompute(id) {
    var rec = instruments[id];
    if (!rec || !rec.armed) return false;
    /* r26 (13): a forced compute takes the record OUT of the queue, so the
       pump cannot run it a second time for the same dirty mark. */
    unqueue(rec);
    runCompute(rec);
    return true;
  }

  function instrumentOut(id) { var r = instruments[id]; return r ? r.out : null; }

  function instrumentCard(id) { var r = instruments[id]; return (r && r.m.card) ? r.m.card : null; }

  /* The autopilot and the ticker ask an instrument to describe an event.
     A missing or silent narrator returns null, which callers must handle. */
  function narrate(id, evt, readout) {
    var r = instruments[id];
    if (!r || typeof r.m.narrate !== 'function') return null;
    var out;
    try { out = r.m.narrate(evt, readout || (r.out ? r.out.readout : {})); }
    catch (e) { logErr('narrate ' + id, e); return null; }
    return (typeof out === 'string' && out) ? out : null;
  }

  /* ======================================================================
     10. Event ring
     ====================================================================== */

  var RING_MS = 72 * 3600000;
  var RING_MAX = 2000;
  var ring = [];
  var ringById = {};

  function pruneRing(nowMs) {
    var cut = nowMs - RING_MS;
    var kept = [];
    for (var i = 0; i < ring.length; i++) {
      if (ring[i].t >= cut) kept.push(ring[i]);
      else delete ringById[ring[i].id];
    }
    if (kept.length > RING_MAX) {
      kept.sort(function (a, b) { return b.t - a.t; });
      for (var j = RING_MAX; j < kept.length; j++) delete ringById[kept[j].id];
      kept.length = RING_MAX;
    }
    ring = kept;
  }

    /* r10: the happenings instrument's tour candidate classes are events too. */
var VALID_CLS = { quake: 1, flare: 1, jam_new: 1, tfr_new: 1, hazard_fire: true, hazard_storm: true, hazard_volcano: true, hazard_flood: true, launch_upcoming: true, launch_recent: true, swpc_alert: true, jam_standing: true, tfr_active: true };

  function emitEvent(evt, opts) {
    if (!evt || typeof evt.id !== 'string' || !evt.id) return null;
    if (!VALID_CLS[evt.cls]) return null;
    var t = num(evt.t, NaN);
    var lat = num(evt.lat, NaN), lon = num(evt.lon, NaN);
    if (!isFinite(t) || !isFinite(lat) || !isFinite(lon)) return null;
    if (lat < -90 || lat > 90) return null;
    var nowMs = now();
    /* Already older than the ring: refuse it rather than announce something
       the autopilot would find gone a moment later. */
    if (nowMs - t > RING_MS) return null;
    var existing = ringById[evt.id];
    if (existing) {
      existing.t = t;
      existing.lat = lat;
      existing.lon = wrapLon(lon);
      if (isNum(evt.mag)) existing.mag = evt.mag;
      if (typeof evt.label === 'string') existing.label = evt.label;
      if (evt.meta && typeof evt.meta === 'object') existing.meta = evt.meta;
      existing.seen++;
      emit('event:update', { id: existing.id, event: existing });
      return existing;
    }
    var rec = {
      id: evt.id,
      cls: evt.cls,
      t: t,
      lat: lat,
      lon: wrapLon(lon),
      mag: isNum(evt.mag) ? evt.mag : null,
      label: typeof evt.label === 'string' ? evt.label : '',
      meta: (evt.meta && typeof evt.meta === 'object') ? evt.meta : {},
      first: nowMs,
      seen: 1
    };
    if (opts && opts.dedupeNear) {
      var twin = nearDuplicate(rec, ring, opts);
      if (twin) {
        if (isNum(rec.mag) && (!isNum(twin.mag) || rec.mag > twin.mag)) twin.mag = rec.mag;
        if (!twin.label && rec.label) twin.label = rec.label;
        twin.seen++;
        emit('event:update', { id: twin.id, event: twin, mergedFrom: rec.id });
        return twin;
      }
    }
    ring.push(rec);
    ringById[rec.id] = rec;
    pruneRing(nowMs);
    emit('event:new', { id: rec.id, event: rec, rank: rankEvent(rec, nowMs) });
    return rec;
  }

  function events() {
    var out = ring.slice();
    out.sort(function (a, b) { return b.t - a.t; });
    return out;
  }

  function eventById(id) { return ringById[id] || null; }

  /* Ranked live list, newest and most significant first. */
  function rankedEvents(nowMs, minRank) {
    var t = isNum(nowMs) ? nowMs : now();
    var lo = isNum(minRank) ? minRank : 0;
    var out = [];
    for (var i = 0; i < ring.length; i++) {
      var r = rankEvent(ring[i], t);
      if (r >= lo) out.push({ event: ring[i], rank: r });
    }
    out.sort(function (a, b) { return b.rank - a.rank || b.event.t - a.event.t; });
    return out;
  }

  function topEvent(nowMs, minRank) {
    var l = rankedEvents(nowMs, minRank);
    return l.length ? l[0] : null;
  }

  /* ======================================================================
     11. Reset (tests and hot reload)
     ====================================================================== */

  function reset() {
    stop();
    feeds = {}; feedOrder = [];
    instruments = {}; instOrder = [];
    ring = []; ringById = {};
    listeners = {};
    stats = { fetches: 0, errors: 0, bytes: 0, computes: 0, parses: 0, timeouts: 0 };
    antennaBase = ANTENNA_DEFAULT;
    busErrors = 0;
  }

  /* ======================================================================
     12. Public API
     ====================================================================== */

  var PURE = {
    /* numbers and geometry */
    isNum: isNum, num: num, clamp: clamp, wrapLon: wrapLon, angDelta: angDelta,
    haversineKm: haversineKm, gcInterp: gcInterp, gcSamples: gcSamples, median: median,
    /* labels */
    coordLabel: coordLabel, regionName: regionName, hhmmssUTC: hhmmssUTC,
    /* flares and severity words */
    flareClass: flareClass, fluxFromClass: fluxFromClass,
    quakeWord: quakeWord, flareWord: flareWord,
    /* ranking */
    rankBase: rankBase, freshness: freshness, rankEvent: rankEvent,
    nearDuplicate: nearDuplicate,
    QUAKE_ANCHORS: QUAKE_ANCHORS, FLARE_ANCHORS: FLARE_ANCHORS,
    /* time and sun */
    julianDay: julianDay, decimalYear: decimalYear, isLeap: isLeap,
    solarPosition: solarPosition, solarDeclination: solarDeclination,
    equationOfTime: equationOfTime, sunSubpoint: sunSubpoint,
    /* magnetic field */
    wmmField: wmmField, wmmDeclination: wmmDeclination,
    /* antenna url policy */
    validAntennaBase: validAntennaBase, antennaFromSearch: antennaFromSearch,
    /* constants other modules should not re-derive */
    EARTH_R_KM: EARTH_R_KM, DEBOUNCE_MS: DEBOUNCE_MS, RING_MS: RING_MS,
    LAZY_LINGER_MS: LAZY_LINGER_MS, BACKOFF_CAP_MS: BACKOFF_CAP_MS,
    WS_GIVE_UP: WS_GIVE_UP,
    SSE_HARD_MS: SSE_HARD_MS, CHUNK_BYTES: CHUNK_BYTES,
    FETCH_TIMEOUT_MS: FETCH_TIMEOUT_MS, FETCH_TIMEOUT_SLOW_MS: FETCH_TIMEOUT_SLOW_MS,
    WATCHDOG_GRACE_MS: WATCHDOG_GRACE_MS
  };

  var ObsCore = {
    PURE: PURE,

    /* environment */
    configure: configure,
    now: now,
    reset: reset,

    /* feeds */
    registerFeed: registerFeed,
    feed: feedRec,
    feedIds: function () { return feedOrder.slice(); },
    data: feedData,
    health: feedHealth,
    healthMap: healthMap,
    feedState: feedState,
    dataAge: function (id, nowMs) {
      var r = feeds[id];
      if (!r || !r.data) return Infinity;
      return (isNum(nowMs) ? nowMs : now()) - r.t;
    },
    holdFeed: holdFeed,
    /* How many keep-alives a feed is under, and whether it is actually connected. The
       stopwatch swaps its hold from the edit stream to the polling feed partway through a
       clock and has to be able to see which one is really carrying it. */
    holds: function (id) { var r = feeds[id]; return r ? r.holds : 0; },
    connected: function (id) { var r = feeds[id]; return !!(r && r.connected); },
    start: start,
    stop: stop,
    started: function () { return started; },

    /* instruments */
    registerInstrument: registerInstrument,
    instrument: instRec,
    instrumentIds: function () { return instOrder.slice(); },
    arm: arm,
    disarm: disarm,
    armed: armedList,
    isArmed: function (id) { var r = instruments[id]; return !!(r && r.armed); },
    recompute: recompute,
    out: instrumentOut,
    card: instrumentCard,
    narrate: narrate,
    state: function (id) { var r = instruments[id]; return r ? r.state : null; },

    /* events */
    emitEvent: emitEvent,
    events: events,
    event: eventById,
    rankedEvents: rankedEvents,
    topEvent: topEvent,

    /* bus */
    on: on,
    off: off,
    emit: emit,

    /* antenna */
    setAntennaBase: setAntennaBase,
    antennaBase: getAntennaBase,
    applyAntennaOverride: applyAntennaOverride,
    ANTENNA_DEFAULT: ANTENNA_DEFAULT,

    /* diagnostics */
    stats: function () {
      return {
        feeds: feedOrder.length,
        instruments: instOrder.length,
        armed: armedList().length,
        events: ring.length,
        fetches: stats.fetches,
        errors: stats.errors,
        bytes: stats.bytes,
        computes: stats.computes,
        parses: stats.parses,
        timeouts: stats.timeouts,
        busErrors: busErrors,
        /* r26 (13): how many instruments are waiting for a task of their own */
        computeQueue: computeQ.length
      };
    }
  };

  /* Dev override, page context only. Never throws in node. */
  try {
    if (global.location && typeof global.location.search === 'string') {
      applyAntennaOverride(global.location.search);
    }
  } catch (e) { /* no location, nothing to override */ }

  global.ObsCore = ObsCore;
  if (typeof module !== 'undefined' && module.exports) module.exports = ObsCore;
})(typeof globalThis !== 'undefined' ? globalThis
   : (typeof self !== 'undefined' ? self : this));
