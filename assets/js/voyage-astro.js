/* ==========================================================================
   voyage-astro.js -- pure astrodynamics + relativity for Mission to Anywhere
   (/voyage/). Grown from mars-astro.js; the global is now VoyageAstro.
   --------------------------------------------------------------------------
   No DOM. Everything here is plain math so the same file runs in the browser
   (globalThis.VoyageAstro) and under node for unit tests (module.exports).

   Units: distance in AU, time in DAYS, velocity in AU/day everywhere inside
   the solar-system machinery. km/s appears only at the delta-v / display
   boundary (KMS_PER_AUDAY). The relativity block works in light-years and
   Julian years with c = 1 ly/yr.
   Angles: the JPL elements are published in degrees; they are converted to
   radians ONCE, at the ephemeris boundary (elementsRad). Radians everywhere
   else.

   Contents:
     - calendar date <-> Julian date (Fliegel-Van Flandern; JD = JDN - 0.5
       so a calendar date maps to 00:00 UTC)
     - JPL approximate planetary elements for ALL EIGHT planets (Table 1,
       fitted 1800-2050; Lambert grids and cruises may evaluate a little past
       2050 -- Table 1 is a linear fit and extrapolates gracefully, and
       verifyEphemerides samples through 2065 to cover that region)
       + Kepler solver -> heliocentric ecliptic-J2000 position AND velocity
     - Stumpff functions, universal-variable Lambert solver, universal-
       variable Kepler propagator
     - the mission delta-v model: departure from a circular parking orbit at
       the ORIGIN planet (Earth 300 km, everything else 500 km); circular
       capture at Mercury/Venus/Mars, elliptical capture (apoapsis = 100 rp)
       at the giants, the way real missions arrive
     - per-PAIR porkchop specs + the resumable grid job (step(budgetMs)).
       The origin is a parameter everywhere and defaults to 'earth', so every
       Earth-departure number (including the 5.65 km/s Mars 2026 anchor) is
       bit-identical to the single-origin version this grew from.
     - synodic period helper (synMonths)
     - special relativity: brachistochrone (constant-acceleration flip
       trips), voyageEnergy, coastTimes (fixed-speed comparison rows)
     - frames + star helpers: raDecToVec, equToEcl, starTempFromCi
       (Ballesteros), kelvinToRgb, starLumV, bcFromTeff, lumBol,
       starRadiusSun, spectWords, hzBand
     - verifyEphemerides / verifyRelativity (in-page self checks) and
       clampShare (hostile share-hash input -> a valid grid cell)

   Planetary elements from NASA/JPL's "Approximate Positions of the Planets"
   (Table 1). All code is original.
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------- constants ---------------- */
  var AU_KM = 149597870.7;
  var KMS_PER_AUDAY = AU_KM / 86400;      /* = 1731.45684... km/s per AU/day */
  var MU_SUN = 2.9591220828559093e-4;     /* Gaussian GM(Sun), AU^3/day^2 */
  var DEG = Math.PI / 180;
  var TWO_PI = Math.PI * 2;

  /* Relativity constants: computed from pinned constituents, never rounded
     literals. */
  var C_MS = 299792458;                   /* m/s, exact */
  var G_MS2 = 9.80665;                    /* standard gravity, m/s^2, exact */
  var YR_S = 31557600;                    /* Julian year, s (365.25 d) */
  var LY_M = 9460730472580800;            /* light-year, m, exact (= c * YR_S) */
  var LY_AU = LY_M / (AU_KM * 1000);      /* = 63241.077... AU per light-year */
  var A_LYYR2_PER_G = G_MS2 * YR_S * YR_S / LY_M;  /* 1 g = 1.0323... ly/yr^2 */
  var WORLD_ENERGY_J = 6.3e20;            /* world yearly primary energy, ~630 EJ (IEA) */

  /* JPL approximate Keplerian elements, Table 1 (fitted 1800-2050).
     el(T) = el0 + rate * T, T in Julian centuries from J2000.
     a in AU; e unitless; I, L (mean longitude), W (longitude of perihelion),
     O (longitude of ascending node) in DEGREES. "earth" is the EM barycenter. */
  var ELEMENTS = {
    mercury: {
      a0: 0.38709927,  aR: 0.00000037,
      e0: 0.20563593,  eR: 0.00001906,
      I0: 7.00497902,  IR: -0.00594749,
      L0: 252.25032350, LR: 149472.67411175,
      W0: 77.45779628,  WR: 0.16047689,
      O0: 48.33076593,  OR: -0.12534081
    },
    venus: {
      a0: 0.72333566,  aR: 0.00000390,
      e0: 0.00677672,  eR: -0.00004107,
      I0: 3.39467605,  IR: -0.00078890,
      L0: 181.97909950, LR: 58517.81538729,
      W0: 131.60246718, WR: 0.00268329,
      O0: 76.67984255,  OR: -0.27769418
    },
    earth: {
      a0: 1.00000261,  aR: 0.00000562,
      e0: 0.01671123,  eR: -0.00004392,
      I0: -0.00001531, IR: -0.01294668,
      L0: 100.46457166, LR: 35999.37244981,
      W0: 102.93768193, WR: 0.32327364,
      O0: 0.0,          OR: 0.0
    },
    mars: {
      a0: 1.52371034,  aR: 0.00001847,
      e0: 0.09339410,  eR: 0.00007882,
      I0: 1.84969142,  IR: -0.00813131,
      L0: -4.55343205, LR: 19140.30268499,
      W0: -23.94362959, WR: 0.44441088,
      O0: 49.55953891,  OR: -0.29257343
    },
    jupiter: {
      a0: 5.20288700,  aR: -0.00011607,
      e0: 0.04838624,  eR: -0.00013253,
      I0: 1.30439695,  IR: -0.00183714,
      L0: 34.39644051, LR: 3034.74612775,
      W0: 14.72847983, WR: 0.21252668,
      O0: 100.47390909, OR: 0.20469106
    },
    saturn: {
      a0: 9.53667594,  aR: -0.00125060,
      e0: 0.05386179,  eR: -0.00050991,
      I0: 2.48599187,  IR: 0.00193609,
      L0: 49.95424423, LR: 1222.49362201,
      W0: 92.59887831, WR: -0.41897216,
      O0: 113.66242448, OR: -0.28867794
    },
    uranus: {
      a0: 19.18916464, aR: -0.00196176,
      e0: 0.04725744,  eR: -0.00004397,
      I0: 0.77263783,  IR: -0.00242939,
      L0: 313.23810451, LR: 428.48202785,
      W0: 170.95427630, WR: 0.40805281,
      O0: 74.01692503,  OR: 0.04240589
    },
    neptune: {
      a0: 30.06992276, aR: 0.00026291,
      e0: 0.00859048,  eR: 0.00005105,
      I0: 1.77004347,  IR: 0.00035372,
      L0: -55.12002969, LR: 218.45945325,
      W0: 44.96476227,  WR: -0.32241464,
      O0: 131.78422574, OR: -0.00508664
    }
  };

  /* Order matters for UI lists. */
  var PLANETS = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn',
                 'uranus', 'neptune'];

  /* Body GM (km^3/s^2) and radii (km) for the burn model. Departure is from
     a 300 km circular LEO. Arrival: Mercury/Venus/Mars capture into a 500 km
     CIRCULAR orbit; the giants capture into a long ELLIPTICAL orbit
     (periapsis = radius + 500 km, apoapsis = 100 x periapsis) the way real
     missions arrive -- a circular low orbit at Jupiter would cost ~17 km/s
     and just read as a bug. */
  var BODIES = {
    mercury: { muKm: 22031.87,     radiusKm: 2439.7,   parkAltKm: 500, capture: 'circular' },
    venus:   { muKm: 324858.592,   radiusKm: 6051.8,   parkAltKm: 500, capture: 'circular' },
    earth:   { muKm: 398600.4418,  radiusKm: 6378.137, parkAltKm: 300, capture: 'circular' },
    mars:    { muKm: 42828.375,    radiusKm: 3396.19,  parkAltKm: 500, capture: 'circular' },
    jupiter: { muKm: 126686531.9,  radiusKm: 71492,    parkAltKm: 500, capture: 'elliptical' },
    saturn:  { muKm: 37931206.2,   radiusKm: 60268,    parkAltKm: 500, capture: 'elliptical' },
    uranus:  { muKm: 5793951.3,    radiusKm: 25559,    parkAltKm: 500, capture: 'elliptical' },
    neptune: { muKm: 6835100,      radiusKm: 24764,    parkAltKm: 500, capture: 'elliptical' }
  };

  /* EARTH-ORIGIN time-of-flight grids [loDays, hiDays, stepDays]. Hand-tuned
     and load-bearing: these ranges are what put the Mars 2026 minimum at
     5.65 km/s / 310 d off the grid edge, so they stay an override table for
     departures from Earth. Any other origin derives its window from the pair
     (tofWindow below). Neptune's hi clears the ~11,180-day Hohmann half-period
     so the minimum is not pinned to the grid edge. */
  var PORKCHOP_TOF = {
    mercury: [40, 260, 3],
    venus:   [60, 300, 5],
    mars:    [80, 450, 5],
    jupiter: [400, 1500, 15],
    saturn:  [900, 3000, 30],
    uranus:  [2200, 6500, 60],
    neptune: [3600, 12100, 110]
  };
  var DEP_SPAN_DAYS = 1200;   /* >= one synodic period of every planet */
  var DEP_STEP_DAYS = 5;

  /* Ship / acceleration presets for the trip card. */
  var SHIP_PRESETS = [
    { key: 'probe',      label: 'probe',           massKg: 1e3 },
    { key: 'crewed',     label: 'crewed ship',     massKg: 1e6 },
    { key: 'generation', label: 'generation ship', massKg: 1e9 }
  ];
  var ACCEL_PRESETS = [0.3, 1, 2];   /* g; 1 g is the default */

  /* ---------------- small vector helpers (arrays [x,y,z]) ---------------- */
  function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross3(a, b) {
    return [a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]];
  }
  function norm3(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); }
  function sub3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }

  /* ---------------- calendar <-> Julian date ---------------- */
  /* Fliegel-Van Flandern: Gregorian (y, m, d) -> Julian Day Number, which is
     12:00 UTC of that date. We return JD = JDN - 0.5 = 00:00 UTC. */
  function dateToJD(y, m, d) {
    var a = Math.floor((14 - m) / 12);
    var y2 = y + 4800 - a;
    var m2 = m + 12 * a - 3;
    var jdn = d + Math.floor((153 * m2 + 2) / 5) + 365 * y2 +
              Math.floor(y2 / 4) - Math.floor(y2 / 100) + Math.floor(y2 / 400) - 32045;
    return jdn - 0.5;
  }

  /* Inverse: JD (any fraction) -> the Gregorian calendar date it falls on
     (civil date of the 24h window starting at JDN - 0.5). */
  function jdToDate(jd) {
    var jdn = Math.floor(jd + 0.5);
    var a = jdn + 32044;
    var b = Math.floor((4 * a + 3) / 146097);
    var c = a - Math.floor(146097 * b / 4);
    var d2 = Math.floor((4 * c + 3) / 1461);
    var e = c - Math.floor(1461 * d2 / 4);
    var m2 = Math.floor((5 * e + 2) / 153);
    var day = e - Math.floor((153 * m2 + 2) / 5) + 1;
    var month = m2 + 3 - 12 * Math.floor(m2 / 10);
    var year = 100 * b + d2 - 4800 + Math.floor(m2 / 10);
    return { y: year, m: month, d: day };
  }

  /* ---------------- Kepler's equation ---------------- */
  /* Solve E - e*sinE = M by Newton. Start at E = M; 12 iterations; tol 1e-12. */
  function solveKepler(M, e) {
    var E = M;
    for (var i = 0; i < 12; i++) {
      var f = E - e * Math.sin(E) - M;
      var fp = 1 - e * Math.cos(E);
      var d = f / fp;
      E -= d;
      if (Math.abs(d) < 1e-12) break;
    }
    return E;
  }

  /* ---------------- ephemerides ---------------- */
  /* Elements at jd, angles converted degrees -> radians HERE and only here.
     M is normalized (in degrees first, for precision on large L) to (-pi, pi]. */
  function elementsRad(body, jd) {
    var el = ELEMENTS[body];
    if (!el) throw new Error('unknown body: ' + body);
    var T = (jd - 2451545.0) / 36525;
    var a = el.a0 + el.aR * T;
    var e = el.e0 + el.eR * T;
    var Ideg = el.I0 + el.IR * T;
    var Ldeg = el.L0 + el.LR * T;
    var Wdeg = el.W0 + el.WR * T;   /* longitude of perihelion */
    var Odeg = el.O0 + el.OR * T;   /* longitude of ascending node */
    var wdeg = Wdeg - Odeg;         /* argument of perihelion */
    var Mdeg = (Ldeg - Wdeg) % 360; /* mean anomaly, normalized in degrees */
    /* --- the one deg->rad boundary --- */
    var M = Mdeg * DEG;
    if (M > Math.PI) M -= TWO_PI;
    else if (M <= -Math.PI) M += TWO_PI;
    return { a: a, e: e, I: Ideg * DEG, w: wdeg * DEG, O: Odeg * DEG, M: M };
  }

  /* Perifocal -> ecliptic-J2000 rotation Rz(-O) Rx(-I) Rz(-w), written out
     longhand (only the first two columns matter; perifocal z' = 0). */
  function perifocalMatrix(w, I, O) {
    var cw = Math.cos(w), sw = Math.sin(w);
    var cO = Math.cos(O), sO = Math.sin(O);
    var cI = Math.cos(I), sI = Math.sin(I);
    return [
      cw * cO - sw * sO * cI,  -sw * cO - cw * sO * cI,
      cw * sO + sw * cO * cI,  -sw * sO + cw * cO * cI,
      sw * sI,                  cw * sI
    ];
  }

  /* Heliocentric position + velocity (AU, AU/day), ecliptic J2000, full 3D. */
  function planetState(body, jd) {
    var el = elementsRad(body, jd);
    var E = solveKepler(el.M, el.e);
    var cE = Math.cos(E), sE = Math.sin(E);
    var se = Math.sqrt(1 - el.e * el.e);
    var xp = el.a * (cE - el.e);
    var yp = el.a * se * sE;
    var r = el.a * (1 - el.e * cE);
    var k = Math.sqrt(MU_SUN * el.a) / r;
    var vxp = -k * sE;
    var vyp = k * se * cE;
    var R = perifocalMatrix(el.w, el.I, el.O);
    return {
      r: [R[0] * xp + R[1] * yp, R[2] * xp + R[3] * yp, R[4] * xp + R[5] * yp],
      v: [R[0] * vxp + R[1] * vyp, R[2] * vxp + R[3] * vyp, R[4] * vxp + R[5] * vyp]
    };
  }

  /* n points around the body's osculating ellipse at jd (for drawing orbits). */
  function orbitPoints(body, jd, n) {
    var el = elementsRad(body, jd);
    var R = perifocalMatrix(el.w, el.I, el.O);
    var se = Math.sqrt(1 - el.e * el.e);
    var pts = [];
    for (var kIdx = 0; kIdx <= n; kIdx++) {
      var E = kIdx / n * TWO_PI;
      var xp = el.a * (Math.cos(E) - el.e);
      var yp = el.a * se * Math.sin(E);
      pts.push([R[0] * xp + R[1] * yp, R[2] * xp + R[3] * yp, R[4] * xp + R[5] * yp]);
    }
    return pts;
  }

  /* Sidereal period of a planet in Julian years (Kepler's third law on the
     J2000 semi-major axis; good to ~1e-5 for the synodic sentence). */
  function periodYears(body) {
    var el = ELEMENTS[body];
    if (!el) throw new Error('unknown body: ' + body);
    var a = el.a0;
    return TWO_PI * Math.sqrt(a * a * a / MU_SUN) / 365.25;
  }

  /* Synodic period of a PAIR of planets, in MONTHS. The x12 is load-bearing:
     the bare reciprocal 1/|1/Ty_o - 1/Ty_t| is in YEARS.
     synMonths(originKey, targetKey) is the current form. The one-argument
     legacy form synMonths(targetKey) still means "against Earth", so every
     shipped Earth-departure caller keeps returning the same number. Same body
     twice has no lineup to wait for and returns Infinity; callers guard. */
  function synMonths(originKey, targetKey) {
    var o = originKey, t = targetKey;
    if (t === undefined || t === null) { t = o; o = 'earth'; }
    var to = periodYears(o);
    var tt = periodYears(t);
    return 12 / Math.abs(1 / to - 1 / tt);
  }

  /* Time-of-flight window [loDays, hiDays, stepDays] for one origin/target
     pair. Earth departures use the tuned override table above. Everything
     else is derived from the Hohmann half-period between the two orbits:
     the transfer ellipse has semi-major axis (a_o + a_t)/2, so its period is
     ((a_o + a_t)/2)^1.5 years and half of that is the reference transfer
     time. The window then spans 0.45x to 2.2x that time (fast direct arcs
     through to the slow side of the ellipse), floored at 20 days, in about
     90 steps so every pair costs the same grid as the shipped ones.
     Sanity, measured: applied to Earth, this window contains the shipped
     table's minimum-delta-v transfer for all seven targets. */
  function hohmannDays(aO, aT) {
    var aTr = 0.5 * (aO + aT);                     /* transfer semi-major axis, AU */
    return 0.5 * Math.pow(aTr, 1.5) * 365.25;      /* half the transfer period, days */
  }
  function tofWindow(originKey, targetKey) {
    var o = originKey || 'earth';
    if (o === targetKey) {
      throw new Error('porkchop origin and target are the same: ' + o);
    }
    var tab = PORKCHOP_TOF[targetKey];
    if (o === 'earth' && tab) return [tab[0], tab[1], tab[2]];
    var elO = ELEMENTS[o], elT = ELEMENTS[targetKey];
    if (!elO || !elT) {
      throw new Error('no porkchop spec for: ' + o + ' -> ' + targetKey);
    }
    /* whole days: the readout prints "N days" and a fractional TOF reads as
       a bug, so the pinned coefficients are applied and then rounded */
    var tHoh = hohmannDays(elO.a0, elT.a0);
    var lo = Math.max(20, Math.round(0.45 * tHoh));
    var hi = Math.round(2.2 * tHoh);
    var step = Math.max(3, Math.round((hi - lo) / 90));
    return [lo, hi, step];
  }

  /* ---------------- Stumpff functions ---------------- */
  function stumpffC(z) {
    if (z > 1e-6) return (1 - Math.cos(Math.sqrt(z))) / z;
    if (z < -1e-6) return (Math.cosh(Math.sqrt(-z)) - 1) / (-z);
    return 0.5 - z / 24 + z * z / 720;
  }
  function stumpffS(z) {
    var s;
    if (z > 1e-6) { s = Math.sqrt(z); return (s - Math.sin(s)) / (s * s * s); }
    if (z < -1e-6) { s = Math.sqrt(-z); return (Math.sinh(s) - s) / (s * s * s); }
    return 1 / 6 - z / 120 + z * z / 5040;
  }

  /* ---------------- Lambert solver (universal variables) ----------------
     Bate/Mueller/White formulation. r1, r2 in AU; dt in days; returns
     { v1, v2 } in AU/day or null (degenerate geometry / no convergence).
     Bisection on z in (-4pi^2, 4pi^2*(1 - 1e-9)) -- the upper endpoint stays
     shy of 4pi^2 where C(z) -> 0 makes y evaluate 0/0. */
  function lambert(r1, r2, dt, prograde) {
    if (!(dt > 0)) return null;
    var r1n = norm3(r1), r2n = norm3(r2);
    if (!(r1n > 0) || !(r2n > 0)) return null;
    var cosd = dot3(r1, r2) / (r1n * r2n);
    if (cosd > 1) cosd = 1; else if (cosd < -1) cosd = -1;
    var crossZ = r1[0] * r2[1] - r1[1] * r2[0];
    var tm = crossZ >= 0 ? 1 : -1;             /* prograde transfer direction */
    if (prograde === false) tm = -tm;
    var A = tm * Math.sqrt(r1n * r2n * (1 + cosd));
    /* transfer angle at exactly pi: A = 0, the geometry is degenerate */
    if (!(Math.abs(A) > 1e-10 * (r1n + r2n))) return null;

    var sqmu = Math.sqrt(MU_SUN);
    var yAtZ = 0;
    /* t(z). Returns NaN when y < 0 (below the valid region: bump z up) and
       +Infinity when C(z) underflows to 0 at the 4pi^2 multi-rev boundary
       (t genuinely diverges there, so Infinity keeps the bisection honest). */
    function tofAt(z) {
      var C = stumpffC(z), S = stumpffS(z);
      if (!(C > 0)) return Infinity;
      var y = r1n + r2n + A * (z * S - 1) / Math.sqrt(C);
      if (y < 0) return NaN;
      yAtZ = y;
      var chi = Math.sqrt(y / C);
      return (chi * chi * chi * S + A * Math.sqrt(y)) / sqmu;
    }

    var lo = -4 * Math.PI * Math.PI;
    var hi = 4 * Math.PI * Math.PI * (1 - 1e-9);
    var tlo = tofAt(lo), guard = 0;
    while (isNaN(tlo) && guard++ < 128) {      /* y < 0 at the bottom: raise lo */
      lo += (hi - lo) * 0.05;
      tlo = tofAt(lo);
    }
    if (!isFinite(tlo) || tlo > dt) return null;   /* dt shorter than the bracket allows */
    var thi = tofAt(hi);
    if (isNaN(thi) || thi < dt) return null;

    var z = 0, t = NaN, i;
    for (i = 0; i < 60; i++) {
      z = 0.5 * (lo + hi);
      t = tofAt(z);
      if (!isFinite(t)) { lo = z; continue; }
      if (t < dt) lo = z; else hi = z;
    }
    z = 0.5 * (lo + hi);
    t = tofAt(z);
    if (!isFinite(t) || Math.abs(t - dt) > 1e-6 * dt) return null;

    var y = yAtZ;
    var f = 1 - y / r1n;
    var g = A * Math.sqrt(y / MU_SUN);
    if (!isFinite(g) || g === 0) return null;
    var gd = 1 - y / r2n;
    var v1 = [(r2[0] - f * r1[0]) / g, (r2[1] - f * r1[1]) / g, (r2[2] - f * r1[2]) / g];
    var v2 = [(gd * r2[0] - r1[0]) / g, (gd * r2[1] - r1[1]) / g, (gd * r2[2] - r1[2]) / g];
    if (!isFinite(v1[0]) || !isFinite(v2[0])) return null;
    return { v1: v1, v2: v2 };
  }

  /* ---------------- universal-variable Kepler propagation ----------------
     Propagate (r0, v0) by dt days around the Sun. Same Stumpff machinery;
     Newton on the universal Kepler equation (F is monotone in chi, so a
     bracketed bisection fallback makes it robust).
     Two call forms, both supported for the life of the page:
       propagateKepler(r0, v0, dtDays)          -- heliocentric, mu = MU_SUN
       propagateKepler(r0, v0, mu, dtDays)      -- explicit gravitational
                                                   parameter (AU^3/day^2)
     The 3-argument form is the shipped one and is bit-identical (it takes the
     same MU_SUN through the same arithmetic). The 4-argument form exists so a
     caller that passes a mu can never have it silently read as a dt. */
  function propagateKepler(r0, v0, a3, a4) {
    var mu = MU_SUN, dt = a3;
    if (arguments.length >= 4 && typeof a4 === 'number') {
      mu = (typeof a3 === 'number' && isFinite(a3) && a3 > 0) ? a3 : MU_SUN;
      dt = a4;
    }
    if (!isFinite(dt)) dt = 0;
    if (dt === 0) return { r: [r0[0], r0[1], r0[2]], v: [v0[0], v0[1], v0[2]] };
    var sqmu = Math.sqrt(mu);
    var r0n = norm3(r0);
    var v0n = norm3(v0);
    var rdotv = dot3(r0, v0);
    var alpha = 2 / r0n - v0n * v0n / mu;  /* 1/a */
    var sgn = dt >= 0 ? 1 : -1;
    var chi;
    if (alpha > 1e-6) {
      chi = sqmu * dt * alpha;
    } else if (alpha < -1e-6) {
      var am = -1 / alpha;
      var num = -2 * mu * alpha * dt;
      var den = rdotv + sgn * Math.sqrt(mu * am) * (1 - r0n * alpha);
      var argl = num / den;
      chi = (argl > 0) ? sgn * Math.sqrt(am) * Math.log(argl) : sqmu * dt / r0n;
    } else {
      var h = cross3(r0, v0);
      var p = dot3(h, h) / mu;
      var s = 0.5 * Math.atan(1 / (3 * Math.sqrt(mu / (p * p * p)) * dt));
      var tw = Math.tan(s);
      var w = Math.atan(tw < 0 ? -Math.pow(-tw, 1 / 3) : Math.pow(tw, 1 / 3));
      chi = Math.sqrt(p) * 2 / Math.tan(2 * w);
    }
    if (!isFinite(chi)) chi = sqmu * dt / r0n;

    function fAt(x) {
      var z2 = alpha * x * x;
      var C2 = stumpffC(z2), S2 = stumpffS(z2);
      return rdotv / sqmu * x * x * C2 + (1 - alpha * r0n) * x * x * x * S2 + r0n * x - sqmu * dt;
    }
    var z, C, S, F, dF, step, i;
    for (i = 0; i < 80; i++) {
      z = alpha * chi * chi;
      C = stumpffC(z); S = stumpffS(z);
      F = rdotv / sqmu * chi * chi * C + (1 - alpha * r0n) * chi * chi * chi * S + r0n * chi - sqmu * dt;
      dF = rdotv / sqmu * chi * (1 - z * S) + (1 - alpha * r0n) * chi * chi * C + r0n;
      step = F / dF;
      chi -= step;
      if (Math.abs(step) < 1e-13 * (1 + Math.abs(chi))) break;
    }
    /* robustness: if Newton wandered, F(chi) is monotone -> bisect (dt > 0) */
    F = fAt(chi);
    if (dt > 0 && (!isFinite(F) || Math.abs(F) > 1e-10 * (sqmu * dt + 1))) {
      var blo = 0, bhi = Math.max(1e-6, Math.abs(chi)), k = 0;
      while (fAt(bhi) < 0 && k++ < 200) bhi *= 2;
      for (k = 0; k < 200; k++) {
        chi = 0.5 * (blo + bhi);
        if (fAt(chi) < 0) blo = chi; else bhi = chi;
      }
      chi = 0.5 * (blo + bhi);
    }

    z = alpha * chi * chi;
    C = stumpffC(z); S = stumpffS(z);
    var f = 1 - chi * chi * C / r0n;
    var g = dt - chi * chi * chi * S / sqmu;
    var rv = [f * r0[0] + g * v0[0], f * r0[1] + g * v0[1], f * r0[2] + g * v0[2]];
    var rn = norm3(rv);
    var fd = sqmu / (rn * r0n) * chi * (z * S - 1);
    var gd = 1 - chi * chi * C / rn;
    var vv = [fd * r0[0] + gd * v0[0], fd * r0[1] + gd * v0[1], fd * r0[2] + gd * v0[2]];
    return { r: rv, v: vv };
  }

  /* ---------------- delta-v model (km/s) ---------------- */
  /* Burn from a circular parking orbit of radius rp (km) onto the hyperbolic
     escape/capture asymptote with excess speed vinf (km/s). */
  function dvFromVinf(vinfKms, muKm, rpKm) {
    return Math.sqrt(vinfKms * vinfKms + 2 * muKm / rpKm) - Math.sqrt(muKm / rpKm);
  }

  /* Capture burn at the target. Circular targets: hyperbolic periapsis speed
     minus circular speed. Elliptical targets (the giants): capture into
     periapsis rp = radius + 500 km, apoapsis 100 rp, so a = 50.5 rp and
     dv2 = sqrt(vinf^2 + 2 mu/rp) - sqrt(2 mu/rp - mu/a). */
  function captureDv(vinfKms, body) {
    var rp = body.radiusKm + body.parkAltKm;
    if (body.capture === 'elliptical') {
      var a = 50.5 * rp;
      return Math.sqrt(vinfKms * vinfKms + 2 * body.muKm / rp) -
             Math.sqrt(2 * body.muKm / rp - body.muKm / a);
    }
    return dvFromVinf(vinfKms, body.muKm, rp);
  }

  /* Core of the porkchop cell: precomputed origin + target states -> dv.
     originKey defaults to 'earth', so the shipped four-argument call is
     numerically untouched. Departure is always modelled from the origin's
     CIRCULAR parking orbit (radiusKm + parkAltKm) even at the giants, which
     is why leaving low Jupiter orbit costs so much: that is real. */
  function transferDv(oSt, tSt, tofDays, targetKey, originKey) {
    var O = BODIES[originKey || 'earth'], T = BODIES[targetKey];
    if (!O || !T) return null;
    var sol = lambert(oSt.r, tSt.r, tofDays, true);
    if (!sol) return null;
    var vinf1 = KMS_PER_AUDAY * norm3(sub3(sol.v1, oSt.v));
    var vinf2 = KMS_PER_AUDAY * norm3(sub3(sol.v2, tSt.v));
    var dv1 = dvFromVinf(vinf1, O.muKm, O.radiusKm + O.parkAltKm);
    var dv2 = captureDv(vinf2, T);
    var total = dv1 + dv2;
    if (!isFinite(total)) return null;
    return {
      dv1: dv1, dv2: dv2, total: total,
      c3: vinf1 * vinf1, vinfArr: vinf2,
      v1: sol.v1, v2: sol.v2
    };
  }

  /* Full mission solution for one (departure JD, TOF) cell, with the states
     the page needs for the ghost arc and markers. Null when Lambert fails. */
  function missionDv(depJD, tofDays, targetKey, originKey) {
    var oKey = originKey || 'earth';
    var oSt = planetState(oKey, depJD);
    var tSt = planetState(targetKey, depJD + tofDays);
    var res = transferDv(oSt, tSt, tofDays, targetKey, oKey);
    if (!res) return null;
    res.depJD = depJD;
    res.tofDays = tofDays;
    res.origin = oKey;
    res.target = targetKey;
    res.rDep = oSt.r; res.vDep = oSt.v;
    res.rArr = tSt.r; res.vArr = tSt.v;
    return res;
  }

  /* ---------------- porkchop grid ---------------- */
  /* Departure: 240 points at 5-day spacing (1200 days of span, at least one
     synodic period of every planet). TOF from tofWindow(origin, target).
     originKey defaults to 'earth': porkchopSpec('mars', jd0) is unchanged. */
  function porkchopSpec(targetKey, jd0, originKey) {
    var origin = originKey || 'earth';
    var tof = tofWindow(origin, targetKey);
    var nDep = Math.round(DEP_SPAN_DAYS / DEP_STEP_DAYS);   /* 240 */
    var nTof = Math.floor((tof[1] - tof[0]) / tof[2]) + 1;
    return {
      target: targetKey, origin: origin, jd0: jd0,
      nDep: nDep, depStep: DEP_STEP_DAYS,
      tof0: tof[0], tofStep: tof[2], nTof: nTof,
      tofMax: tof[0] + (nTof - 1) * tof[2],
      depMax: jd0 + (nDep - 1) * DEP_STEP_DAYS
    };
  }

  /* Resumable computation: call job.step(budgetMs) until job.done. Cell
     (i, j) lives at index i * nTof + j; NaN marks a no-converge cell.
     Two call forms:
       makePorkchopJob(spec)                      -- the shipped one
       makePorkchopJob(targetKey, jd0, originKey) -- builds its own spec
     A spec made before this wave has no `origin` field and departs Earth. */
  function makePorkchopJob(specOrTarget, jd0, originKey) {
    var spec = (typeof specOrTarget === 'string')
      ? porkchopSpec(specOrTarget, jd0, originKey)
      : specOrTarget;
    var origin = spec.origin || 'earth';
    var n = spec.nDep, m = spec.nTof, cells = n * m;
    var total = new Float64Array(cells);
    for (var q = 0; q < cells; q++) total[q] = NaN;
    var idx = 0, bad = 0;
    var minDv = Infinity, minI = -1, minJ = -1;
    var oCol = -1, oSt = null;    /* the origin's state, cached per grid column */
    var job = {
      spec: spec, total: total, cells: cells,
      done: false, doneCount: 0, badCount: 0, progress: 0,
      minDv: Infinity, minI: -1, minJ: -1,
      step: function (budgetMs) {
        if (idx >= cells) { this.done = true; this.progress = 1; return 1; }
        var t0 = Date.now();
        while (idx < cells) {
          var i = (idx / m) | 0;
          var j = idx - i * m;
          var dep = spec.jd0 + i * spec.depStep;
          var tof = spec.tof0 + j * spec.tofStep;
          if (i !== oCol) { oCol = i; oSt = planetState(origin, dep); }
          var tSt = planetState(spec.target, dep + tof);
          var res = transferDv(oSt, tSt, tof, spec.target, origin);
          if (res) {
            total[idx] = res.total;
            if (res.total < minDv) { minDv = res.total; minI = i; minJ = j; }
          } else {
            bad++;
          }
          idx++;
          if ((idx & 31) === 0 && (Date.now() - t0) >= budgetMs) break;
        }
        this.doneCount = idx;
        this.badCount = bad;
        this.minDv = minDv; this.minI = minI; this.minJ = minJ;
        this.progress = idx / cells;
        if (idx >= cells) this.done = true;
        return this.progress;
      }
    };
    return job;
  }

  /* ---------------- special relativity ---------------- */
  /* Constant-acceleration flip trip: accelerate at gAccel (in g) to the
     midpoint, flip, decelerate. Work in ly/yr units where c = 1:
     a (ly/yr^2) = gAccel * 1.0323..., chi = a * d/2. Earth time
     t = 2 sqrt(chi^2 + 2 chi)/a; ship proper time tau = (2/a) acosh(1+chi);
     peak speed v = sqrt(1 - 1/(1+chi)^2) (fraction of c); peak gamma
     = 1 + chi. */
  function brachistochrone(dLy, gAccel) {
    var a = gAccel * A_LYYR2_PER_G;
    if (!(dLy > 0) || !(a > 0)) {
      return { earthYears: 0, shipYears: 0, vPeakC: 0, gammaPeak: 1 };
    }
    var chi = a * dLy / 2;
    var earthYears = 2 * Math.sqrt(chi * chi + 2 * chi) / a;
    var shipYears = 2 / a * Math.acosh(1 + chi);
    var gp = 1 + chi;
    var vPeakC = Math.sqrt(1 - 1 / (gp * gp));
    return { earthYears: earthYears, shipYears: shipYears, vPeakC: vPeakC, gammaPeak: gp };
  }

  /* Energy for the trip: kinetic energy at peak, spent twice (once to gain
     it, once to shed it): E = 2 (gammaPeak - 1) m c^2 joules. worldYears
     divides by the world's yearly primary energy use, ~630 EJ (IEA).
     massRatio is the perfect photon-rocket one-way mass ratio
     exp(2 acosh(gammaPeak)): fuel + ship per kg delivered. */
  function voyageEnergy(dLy, gAccel, massKg) {
    var b = brachistochrone(dLy, gAccel);
    var joules = 2 * (b.gammaPeak - 1) * massKg * C_MS * C_MS;
    return {
      joules: joules,
      worldYears: joules / WORLD_ENERGY_J,
      massRatio: Math.exp(2 * Math.acosh(b.gammaPeak)),
      gammaPeak: b.gammaPeak
    };
  }

  /* Fixed-speed comparison rows for the trip table. years = dLy / (v/c).
     None of these stop at the destination; the notes say so. */
  function coastTimes(dLy) {
    var cKms = C_MS / 1000;
    var rows = [
      { name: 'Voyager 1', v: 17 / cKms,
        note: 'chemical rockets and gravity assists, 17 km/s; does not stop' },
      { name: 'Ion drive', v: 100 / cKms,
        note: 'an optimistic future ion drive, 100 km/s; does not stop' },
      { name: 'Project Orion', v: 0.03,
        note: 'nuclear-pulse study from the 1960s, about 3% of light speed; flyby only' },
      { name: 'Daedalus', v: 0.12,
        note: 'fusion-rocket study from the 1970s, about 12% of light speed; flyby only' },
      { name: 'Starshot sail', v: 0.20,
        note: 'laser-sail concept, a gram-scale probe at 20% of light speed; flyby only' }
    ];
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      out.push({ name: rows[i].name, note: rows[i].note,
                 years: dLy / rows[i].v, stops: false });
    }
    return out;
  }

  /* ---------------- frames + star helpers ---------------- */
  var OBLIQUITY = 23.43928 * DEG;   /* mean obliquity of the ecliptic, J2000 */

  /* RA (hours), Dec (degrees), distance (any unit) -> equatorial J2000 xyz. */
  function raDecToVec(raHours, decDeg, dist) {
    var d = (typeof dist === 'number' && isFinite(dist)) ? dist : 1;
    var ra = raHours * 15 * DEG;
    var dec = decDeg * DEG;
    var cd = Math.cos(dec);
    return [d * cd * Math.cos(ra), d * cd * Math.sin(ra), d * Math.sin(dec)];
  }

  /* Equatorial J2000 -> ecliptic J2000 (rotation about the shared x axis). */
  function equToEcl(v) {
    var ce = Math.cos(OBLIQUITY), se = Math.sin(OBLIQUITY);
    return [v[0], ce * v[1] + se * v[2], -se * v[1] + ce * v[2]];
  }

  /* B-V color index -> effective temperature, Ballesteros (2012). Missing or
     junk ci defaults to 0.65 (sunlike). Clamped to [1000, 40000] K. */
  function starTempFromCi(ci) {
    var c = (typeof ci === 'number' && isFinite(ci)) ? ci : 0.65;
    var T = 4600 * (1 / (0.92 * c + 1.7) + 1 / (0.92 * c + 0.62));
    if (T < 1000) T = 1000;
    if (T > 40000) T = 40000;
    return T;
  }

  /* Blackbody temperature -> display RGB, the standard piecewise log
     approximation (Helland curve), implemented locally. Returns
     { r, g, b } in 0-255. */
  function kelvinToRgb(T) {
    var t = T;
    if (!(t > 1000)) t = 1000;
    if (t > 40000) t = 40000;
    t /= 100;
    var r, g, b;
    if (t <= 66) r = 255;
    else r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    if (t <= 66) g = 99.4708025861 * Math.log(t) - 161.1195681661;
    else g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    if (t >= 66) b = 255;
    else if (t <= 19) b = 0;
    else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    function cl(x) { return Math.round(Math.min(255, Math.max(0, x))); }
    return { r: cl(r), g: cl(g), b: cl(b) };
  }

  /* V-band luminosity in solar units (M_V(Sun) = 4.83). Used ONLY for the
     red dwarf vs red giant wording split; the habitable zone and star radius
     use BOLOMETRIC luminosity below. */
  function starLumV(absmag) {
    /* null/undefined must NOT coerce to 0 (a ~100 Lsun star): NaN propagates
       into the callers' isFinite gates instead */
    if (typeof absmag !== 'number' || !isFinite(absmag)) return NaN;
    return Math.pow(10, (4.83 - absmag) / 2.5);
  }

  /* Bolometric correction (V band) vs effective temperature: a piecewise
     linear fit in the spirit of Flower (1996). BC = 0 across 5000-7000 K
     keeps the Sun anchors true. NOTE (deliberate calibration, anchor-
     verified): the temperatures fed in here come from Ballesteros on B-V,
     which runs a few hundred K hot for M dwarfs, so the cool-end knots sit
     hotter and deeper than the textbook curve. With the literal textbook
     knots (-2 at 3000 K, -4 at 2600 K) Proxima's radius computes to
     0.044 R_sun and Proxima b lands outside the habitable zone; with these
     knots Proxima comes out at 0.12 R_sun (real: 0.15) and Proxima b and
     TRAPPIST-1e both sit in the zone, which is what the sky actually says.

     This table is the DWARF sequence. See BC_KNOTS_GIANT below for why a
     cool giant needs its own. */
  var BC_KNOTS = [
    [2600, -4.0], [3000, -3.9], [3500, -3.7], [4000, -1.2],
    [5000, 0], [7000, 0], [8000, -0.1], [15000, -1], [30000, -3]
  ];

  /* ---- the cool GIANT / SUPERGIANT branch (post-hoc fix round 2) ----
     Betelgeuse used to print "about 1968 times the Sun's width" (published
     764-887) and Antares 1902 (published ~680). Both errors come from
     applying the dwarf curve above to an evolved star, and both are the same
     defect seen twice:

       - B-V saturates on the red giant branch. An M giant's colour barely
         moves below about B-V 1.6 while its temperature keeps falling, and
         the catalog colours for the reddest supergiants carry interstellar
         reddening on top of that (AT-HYG has Betelgeuse at B-V 2.08 against
         a published 1.85). Ballesteros, a DWARF calibration, therefore hands
         this code roughly 3,100 K for a star that is really near 3,600 K, and
         the Stefan-Boltzmann (5772/T)^2 term inflates by about 1.36.
       - The dwarf BC at that temperature is a late-M-DWARF correction near
         -3.9. The published value for an M supergiant is about -1.6
         (Levesque et al. 2005 give BC_V = -1.61 for M2 I; Johnson 1966 and
         Buzzoni et al. 2010 put cool giants in the same band). Using -3.9
         inflates the luminosity by a further factor of about 2.8.

     So the knots below are stated against the temperature THIS code derives
     for an evolved star, not against a true effective temperature, and they
     are anchored on published radii rather than restating a textbook BC(T)
     curve at a temperature that is known to be low. Read across the row and
     the values are ordinary: -1.08 at 4,100 K, about -1.5 at 3,600 K, about
     -1.9 at 3,100 K, never past -2.6. Result on the marquee giants (estimate
     vs published radius in solar radii): Betelgeuse 788 vs 764-887, Antares
     790 vs 680, Aldebaran 63 vs 45, Scheat 114 vs 95, Menkar 144 vs 89,
     Enif 382 vs 185, Eltanin 92 vs 48. Mean absolute error over the eleven
     marquee cool giants falls from 0.52 dex (a factor of 3.3) to 0.22 dex
     (a factor of 1.7). Two get worse in the other direction (Gacrux 65 vs
     120, Rasalgethi 93 vs 284); the copy says "roughly" for that reason.

     WHICH branch a star takes is decided by luminosity, not by a label: at
     4,100 K the main sequence sits at M_V near +8, so nothing fainter-lined
     than +4 can be a dwarf. Cross-checked against the catalog's own
     published MK luminosity class -- of the 1,710 stars under 4,100 K that
     carry one, this test agrees with class I/II/III/IV for 1,688. The 22 it
     disagrees on are bad parses or bad parallaxes either way.

     Hosts with a measured archive luminosity never reach this code at all
     (starBolLum prefers st_lum), so no habitable-zone verdict moves: checked
     over all 387 catalog planets, zero host luminosities and zero HZ chips
     change. */
  var BC_KNOTS_GIANT = [
    [2600, -2.6], [3000, -1.95], [3400, -1.62], [3800, -1.25], [4100, -1.08]
  ];
  /* the temperature under which the giant branch applies, and the absolute
     magnitude above which a star that cool cannot be on the main sequence */
  var GIANT_T_MAX = 4100, GIANT_ABSMAG = 4.0;

  function bcInterp(k, T) {
    if (!(T > k[0][0])) return k[0][1];
    var last = k.length - 1;
    if (T >= k[last][0]) return k[last][1];
    for (var i = 1; i <= last; i++) {
      if (T <= k[i][0]) {
        var f = (T - k[i - 1][0]) / (k[i][0] - k[i - 1][0]);
        return k[i - 1][1] + f * (k[i][1] - k[i - 1][1]);
      }
    }
    return k[last][1];
  }
  /* absmag is OPTIONAL: without it every call keeps the dwarf sequence, so
     one-argument callers are byte-for-byte unchanged. */
  function bcFromTeff(T, absmag) {
    if (T < GIANT_T_MAX && typeof absmag === 'number' && isFinite(absmag) &&
        absmag < GIANT_ABSMAG) {
      return bcInterp(BC_KNOTS_GIANT, T);
    }
    return bcInterp(BC_KNOTS, T);
  }

  /* Bolometric luminosity in solar units from the V absolute magnitude and
     the temperature: M_bol = absmag + BC(T), M_bol(Sun) = 4.74. The absolute
     magnitude is handed on to bcFromTeff, which is what tells a red giant
     from a red dwarf. */
  function lumBol(absmag, T) {
    if (typeof absmag !== 'number' || !isFinite(absmag) || !isFinite(T)) return NaN;
    return Math.pow(10, (4.74 - (absmag + bcFromTeff(T, absmag))) / 2.5);
  }

  /* Best bolometric luminosity for a star: the archive's measured value when
     the catalog carries one (every exoplanet host with st_lum), else the
     absmag + BC(T) estimate. The HZ chips and the size line only ever apply
     to hosts, so the estimate path never decides a habitable-zone verdict
     for a star with real data. */
  function starBolLum(lumArchive, absmag, T) {
    if (typeof lumArchive === 'number' && isFinite(lumArchive) && lumArchive > 0) {
      return lumArchive;
    }
    return lumBol(absmag, T);
  }

  /* Stefan-Boltzmann radius in solar radii: R = sqrt(L_bol) (5772/T)^2. */
  function starRadiusSun(lumBolVal, T) {
    return Math.sqrt(lumBolVal) * Math.pow(5772 / T, 2);
  }

  /* Plain-language spectral description. lumV (V-band, solar units) splits
     red dwarfs from red giants. */
  function spectWords(letter, lumV) {
    var s = (typeof letter === 'string') ? letter.trim().charAt(0).toUpperCase() : '';
    switch (s) {
      case 'O': return 'a blazing blue star, rare and short-lived';
      case 'B': return 'a hot blue-white star';
      case 'A': return 'a white star, hotter than the Sun';
      case 'F': return 'a yellow-white star';
      case 'G': return 'a yellow star like the Sun';
      case 'K': return 'an orange star, cooler than the Sun';
      case 'M': if (!isFinite(lumV)) return 'a cool red star';
                return (lumV < 0.1) ? 'a red dwarf, small, cool and dim'
                                    : 'a red giant, cool but enormous';
      case 'W':
      case 'D': return 'the dense ember of a dead star';
      default:  return 'type unknown';
    }
  }

  /* Rough habitable-zone band (AU) from bolometric luminosity (solar units).
     A planet with rIn <= a <= rOut gets the "habitable zone (roughly)" chip. */
  /* Rough habitable zone: recent-Venus inner flux 1.1 Ssun to maximum-
     greenhouse outer 0.36 Ssun (the 0.53 "early Mars" bound missed textbook
     HZ planets like Kepler-62 f). Sun: about [0.95, 1.67] AU. */
  function hzBand(lumBolVal) {
    return { rIn: Math.sqrt(lumBolVal / 1.1), rOut: Math.sqrt(lumBolVal / 0.36) };
  }

  /* ---------------- self checks + share clamping ---------------- */
  /* In-page ephemeris self check: the Mars close-approach anchors, plus
     Jupiter and Saturn heliocentric-distance bands sampled through 2065
     (Lambert grids and cruises legitimately extrapolate a little past the
     1800-2050 fit; Table 1 is linear and degrades gracefully there). */
  function verifyEphemerides() {
    var jdA = dateToJD(2020, 10, 6);
    var dA = norm3(sub3(planetState('mars', jdA).r, planetState('earth', jdA).r));
    var jdB = dateToJD(2018, 7, 27);
    var dB = norm3(sub3(planetState('mars', jdB).r, planetState('earth', jdB).r));
    var okA = Math.abs(dA - 0.4149) / 0.4149 <= 0.015;
    var okB = Math.abs(dB - 0.385) / 0.385 <= 0.02;
    var jd1 = dateToJD(2000, 1, 1), jd2 = dateToJD(2065, 1, 1);
    var jMin = Infinity, jMax = 0, sMin = Infinity, sMax = 0;
    for (var jd = jd1; jd <= jd2; jd += 40) {
      var rj = norm3(planetState('jupiter', jd).r);
      var rs = norm3(planetState('saturn', jd).r);
      if (rj < jMin) jMin = rj; if (rj > jMax) jMax = rj;
      if (rs < sMin) sMin = rs; if (rs > sMax) sMax = rs;
    }
    var okJ = jMin >= 4.9 && jMax <= 5.5;
    var okS = sMin >= 9.0 && sMax <= 10.2;
    return {
      ok: okA && okB && okJ && okS,
      dist2020: dA, dist2018: dB,
      jupRange: [jMin, jMax], satRange: [sMin, sMax]
    };
  }

  /* In-page relativity self check: the Proxima 1 g brachistochrone anchor. */
  function verifyRelativity() {
    var b = brachistochrone(4.246, 1);
    var ok = Math.abs(b.shipYears - 3.54) <= 0.04 &&
             Math.abs(b.earthYears - 5.87) <= 0.04 &&
             Math.abs(b.vPeakC - 0.9497) <= 0.002;
    return { ok: ok, shipYears: b.shipYears, earthYears: b.earthYears, vPeakC: b.vPeakC };
  }

  /* Decoded share payloads are UNTRUSTED. Whatever comes in, the result is a
     valid cell of the given grid spec. The one planet that can never be the
     target is the one the ship is departing FROM (Earth for a spec built
     without an origin, so this is unchanged for every shipped share link);
     anything else unknown falls back to mars, or to earth when mars is the
     origin. */
  function clampShare(obj, spec) {
    var o = (obj && typeof obj === 'object') ? obj : {};
    var origin = (spec && spec.origin) || 'earth';
    var fallback = (origin === 'mars') ? 'earth' : 'mars';
    /* PLANETS.indexOf, not ELEMENTS[o.t]: "__proto__" is truthy on any
       object lookup and must not survive as a target key. */
    var t = (typeof o.t === 'string' && PLANETS.indexOf(o.t) >= 0 && o.t !== origin)
      ? o.t : fallback;
    var d = (typeof o.d === 'number') ? o.d : parseFloat(o.d);
    if (!isFinite(d)) d = spec.jd0;
    var i = Math.round((d - spec.jd0) / spec.depStep);
    if (!isFinite(i) || i < 0) i = 0;
    if (i > spec.nDep - 1) i = spec.nDep - 1;
    var f = (typeof o.f === 'number') ? o.f : parseFloat(o.f);
    if (!isFinite(f)) f = spec.tof0 + Math.round((spec.nTof - 1) / 2) * spec.tofStep;
    var j = Math.round((f - spec.tof0) / spec.tofStep);
    if (!isFinite(j) || j < 0) j = 0;
    if (j > spec.nTof - 1) j = spec.nTof - 1;
    return {
      t: t, i: i, j: j,
      depJD: spec.jd0 + i * spec.depStep,
      tofDays: spec.tof0 + j * spec.tofStep
    };
  }

  var VoyageAstro = {
    /* constants */
    AU_KM: AU_KM,
    KMS_PER_AUDAY: KMS_PER_AUDAY,
    MU_SUN: MU_SUN,
    C_MS: C_MS,
    G_MS2: G_MS2,
    YR_S: YR_S,
    LY_M: LY_M,
    LY_AU: LY_AU,
    A_LYYR2_PER_G: A_LYYR2_PER_G,
    WORLD_ENERGY_J: WORLD_ENERGY_J,
    ELEMENTS: ELEMENTS,
    BODIES: BODIES,
    PLANETS: PLANETS,
    PORKCHOP_TOF: PORKCHOP_TOF,
    SHIP_PRESETS: SHIP_PRESETS,
    ACCEL_PRESETS: ACCEL_PRESETS,
    /* time */
    dateToJD: dateToJD,
    jdToDate: jdToDate,
    /* solar system */
    solveKepler: solveKepler,
    stumpffC: stumpffC,
    stumpffS: stumpffS,
    elementsRad: elementsRad,
    planetState: planetState,
    orbitPoints: orbitPoints,
    periodYears: periodYears,
    synMonths: synMonths,
    hohmannDays: hohmannDays,
    tofWindow: tofWindow,
    lambert: lambert,
    propagateKepler: propagateKepler,
    dvFromVinf: dvFromVinf,
    captureDv: captureDv,
    transferDv: transferDv,
    missionDv: missionDv,
    porkchopSpec: porkchopSpec,
    makePorkchopJob: makePorkchopJob,
    /* relativity */
    brachistochrone: brachistochrone,
    voyageEnergy: voyageEnergy,
    coastTimes: coastTimes,
    /* frames + stars */
    raDecToVec: raDecToVec,
    equToEcl: equToEcl,
    starTempFromCi: starTempFromCi,
    kelvinToRgb: kelvinToRgb,
    starLumV: starLumV,
    bcFromTeff: bcFromTeff,
    lumBol: lumBol,
    starBolLum: starBolLum,
    starRadiusSun: starRadiusSun,
    spectWords: spectWords,
    hzBand: hzBand,
    /* self checks + share */
    verifyEphemerides: verifyEphemerides,
    verifyRelativity: verifyRelativity,
    clampShare: clampShare
  };

  global.VoyageAstro = VoyageAstro;
  if (typeof module !== 'undefined' && module.exports) module.exports = VoyageAstro;
})(typeof globalThis !== 'undefined' ? globalThis
   : (typeof self !== 'undefined' ? self : this));
