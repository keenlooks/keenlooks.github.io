/* ==========================================================================
   mars-astro.js — pure astrodynamics for the Mission to Mars page (/mars/).
   --------------------------------------------------------------------------
   No DOM. Everything here is plain math so the same file runs in the browser
   (globalThis.MarsAstro) and under node for unit tests (module.exports).

   Units: distance in AU, time in DAYS, velocity in AU/day everywhere inside.
   km/s appears only at the delta-v / display boundary (KMS_PER_AUDAY).
   Angles: the JPL elements are published in degrees; they are converted to
   radians ONCE, at the ephemeris boundary (elementsRad). Radians everywhere
   else.

   Contents:
     - calendar date <-> Julian date (Fliegel-Van Flandern; JD = JDN - 0.5
       so a calendar date maps to 00:00 UTC)
     - JPL approximate planetary elements (Table 1, 1800-2050) + Kepler solver
       -> heliocentric ecliptic-J2000 position AND velocity, full 3D
     - Stumpff functions, universal-variable Lambert solver, universal-
       variable Kepler propagator
     - the mission delta-v model (LEO departure + capture burn at the target)
     - porkchop grid computation as a resumable job (step(budgetMs)) so the
       page can compute ~18k Lambert solves in ~20 ms slices
     - verifyEphemerides (the in-page self check) and clampShare (hostile
       share-hash input -> a valid grid cell)

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

  /* JPL approximate Keplerian elements, Table 1 (valid 1800-2050).
     el(T) = el0 + rate * T, T in Julian centuries from J2000.
     a in AU; e unitless; I, L (mean longitude), W (longitude of perihelion),
     O (longitude of ascending node) in DEGREES. "earth" is the EM barycenter. */
  var ELEMENTS = {
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
    venus: {
      a0: 0.72333566,  aR: 0.00000390,
      e0: 0.00677672,  eR: -0.00004107,
      I0: 3.39467605,  IR: -0.00078890,
      L0: 181.97909950, LR: 58517.81538729,
      W0: 131.60246718, WR: 0.00268329,
      O0: 76.67984255,  OR: -0.27769418
    }
  };

  /* Body GM (km^3/s^2) and radii (km) for the burn model. Departure is from
     a 300 km circular LEO; arrival captures into a 500 km circular orbit. */
  var BODIES = {
    earth: { muKm: 398600.4418, radiusKm: 6378.137, parkAltKm: 300 },
    mars:  { muKm: 42828.375,   radiusKm: 3396.19,  parkAltKm: 500 },
    venus: { muKm: 324858.592,  radiusKm: 6051.8,   parkAltKm: 500 }
  };

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
     bracketed bisection fallback makes it robust). */
  function propagateKepler(r0, v0, dt) {
    if (dt === 0) return { r: [r0[0], r0[1], r0[2]], v: [v0[0], v0[1], v0[2]] };
    var sqmu = Math.sqrt(MU_SUN);
    var r0n = norm3(r0);
    var v0n = norm3(v0);
    var rdotv = dot3(r0, v0);
    var alpha = 2 / r0n - v0n * v0n / MU_SUN;  /* 1/a */
    var sgn = dt >= 0 ? 1 : -1;
    var chi;
    if (alpha > 1e-6) {
      chi = sqmu * dt * alpha;
    } else if (alpha < -1e-6) {
      var am = -1 / alpha;
      var num = -2 * MU_SUN * alpha * dt;
      var den = rdotv + sgn * Math.sqrt(MU_SUN * am) * (1 - r0n * alpha);
      var argl = num / den;
      chi = (argl > 0) ? sgn * Math.sqrt(am) * Math.log(argl) : sqmu * dt / r0n;
    } else {
      var h = cross3(r0, v0);
      var p = dot3(h, h) / MU_SUN;
      var s = 0.5 * Math.atan(1 / (3 * Math.sqrt(MU_SUN / (p * p * p)) * dt));
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

  /* Core of the porkchop cell: precomputed Earth + target states -> dv. */
  function transferDv(eSt, tSt, tofDays, targetKey) {
    var sol = lambert(eSt.r, tSt.r, tofDays, true);
    if (!sol) return null;
    var vinf1 = KMS_PER_AUDAY * norm3(sub3(sol.v1, eSt.v));
    var vinf2 = KMS_PER_AUDAY * norm3(sub3(sol.v2, tSt.v));
    var E = BODIES.earth, T = BODIES[targetKey];
    var dv1 = dvFromVinf(vinf1, E.muKm, E.radiusKm + E.parkAltKm);
    var dv2 = dvFromVinf(vinf2, T.muKm, T.radiusKm + T.parkAltKm);
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
  function missionDv(depJD, tofDays, targetKey) {
    var eSt = planetState('earth', depJD);
    var tSt = planetState(targetKey, depJD + tofDays);
    var res = transferDv(eSt, tSt, tofDays, targetKey);
    if (!res) return null;
    res.depJD = depJD;
    res.tofDays = tofDays;
    res.rDep = eSt.r; res.vDep = eSt.v;
    res.rArr = tSt.r; res.vArr = tSt.v;
    return res;
  }

  /* ---------------- porkchop grid ---------------- */
  /* Departure: 240 points at 5-day spacing (about 1195 days of span, so the
     current and next synodic windows both show). TOF: Mars 75 points from 80
     to 450 days; Venus 49 points from 60 to 300 days. */
  function porkchopSpec(targetKey, jd0) {
    var venus = targetKey === 'venus';
    var tof0 = venus ? 60 : 80;
    var nTof = venus ? 49 : 75;
    return {
      target: targetKey, jd0: jd0,
      nDep: 240, depStep: 5,
      tof0: tof0, tofStep: 5, nTof: nTof,
      tofMax: tof0 + (nTof - 1) * 5,
      depMax: jd0 + 239 * 5
    };
  }

  /* Resumable computation: call job.step(budgetMs) until job.done. Cell
     (i, j) lives at index i * nTof + j; NaN marks a no-converge cell. */
  function makePorkchopJob(spec) {
    var n = spec.nDep, m = spec.nTof, cells = n * m;
    var total = new Float64Array(cells);
    for (var q = 0; q < cells; q++) total[q] = NaN;
    var idx = 0, bad = 0;
    var minDv = Infinity, minI = -1, minJ = -1;
    var eCol = -1, eSt = null;
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
          if (i !== eCol) { eCol = i; eSt = planetState('earth', dep); }
          var tSt = planetState(spec.target, dep + tof);
          var res = transferDv(eSt, tSt, tof, spec.target);
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

  /* ---------------- self checks + share clamping ---------------- */
  /* The known-anchor cases from the node tests, runnable in-page: Earth-Mars
     distance at the 2020-10-06 close approach and the 2018-07-27 opposition. */
  function verifyEphemerides() {
    var jdA = dateToJD(2020, 10, 6);
    var dA = norm3(sub3(planetState('mars', jdA).r, planetState('earth', jdA).r));
    var jdB = dateToJD(2018, 7, 27);
    var dB = norm3(sub3(planetState('mars', jdB).r, planetState('earth', jdB).r));
    var okA = Math.abs(dA - 0.4149) / 0.4149 <= 0.015;
    var okB = Math.abs(dB - 0.385) / 0.385 <= 0.02;
    return { ok: okA && okB, dist2020: dA, dist2018: dB };
  }

  /* Decoded share payloads are UNTRUSTED. Whatever comes in, the result is a
     valid cell of the given grid spec. */
  function clampShare(obj, spec) {
    var o = (obj && typeof obj === 'object') ? obj : {};
    var t = o.t === 'venus' ? 'venus' : 'mars';
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

  var MarsAstro = {
    AU_KM: AU_KM,
    KMS_PER_AUDAY: KMS_PER_AUDAY,
    MU_SUN: MU_SUN,
    ELEMENTS: ELEMENTS,
    BODIES: BODIES,
    dateToJD: dateToJD,
    jdToDate: jdToDate,
    solveKepler: solveKepler,
    stumpffC: stumpffC,
    stumpffS: stumpffS,
    elementsRad: elementsRad,
    planetState: planetState,
    orbitPoints: orbitPoints,
    lambert: lambert,
    propagateKepler: propagateKepler,
    dvFromVinf: dvFromVinf,
    missionDv: missionDv,
    porkchopSpec: porkchopSpec,
    makePorkchopJob: makePorkchopJob,
    verifyEphemerides: verifyEphemerides,
    clampShare: clampShare
  };

  global.MarsAstro = MarsAstro;
  if (typeof module !== 'undefined' && module.exports) module.exports = MarsAstro;
})(typeof globalThis !== 'undefined' ? globalThis
   : (typeof self !== 'undefined' ? self : this));
