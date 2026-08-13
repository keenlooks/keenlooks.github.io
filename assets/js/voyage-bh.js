/* ==========================================================================
   voyage-bh.js -- Sagittarius A*: constants, the S-star cluster, the
   Schwarzschild geodesic lens, the accretion flow and the "fall in" phase
   table for Mission to Anywhere (/voyage/). Global: VoyageBH.
   --------------------------------------------------------------------------
   No DOM outside the two draw calls, no Math.random, no Date, no shadowBlur,
   zero per-frame allocation (every buffer below is module level or handed in
   by the caller), and every canvas gradient / arc / drawImage argument is
   isFinite-guarded at the call site: one NaN into a canvas call kills the
   page's rAF loop for good.

   HONESTY RULES THIS FILE OBEYS (from plan-voyage-blackhole.md):
     - every displayed number comes from the spec's DATA section or is
       derived here from those constants, with the derivation in a comment;
     - the disputed short-period stars (S62, S4711, S4714, S4716) are NOT
       in the table: GRAVITY 2021 disputes the identification and we do not
       draw disputed orbits;
     - the three figures the spec bans (the two popular horizon-to-centre
       durations from other visualizations, and the unverified "tides turn
       lethal a fraction of a second before the end" claim) appear nowhere,
       in any string or comment: research-sgra.md shows none of them matches
       the analytic result for the trajectory we depict, so every timing here
       is derived below instead, and the tidal caption stays qualitative;
     - the flow is drawn faint by default because the real Sgr A* is faint;
       the brighten control is the caller's, and the copy says it is drama.

   ==========================================================================
   API CONTRACT (finalized; voyage.js codes against exactly this)
   ==========================================================================

   VoyageBH.SGRA
     { massMsun, rsAu, rgAu, photonAu, iscoAu, bCritAu, bCritRs, gmC3Sec,
       tauHorizonSec, tauMaxSec, parkAu, parkRs, rsKm, rsRsun, r0Pc,
       fallYears }
     All derived in-file from GM/c^2 per solar mass; see DERIVED CONSTANTS.

   VoyageBH.SSTARS
     Array of 14 rows { name, aAu, e, iDeg, OmDeg, wDeg, Pyr, tPeriYr,
     periAu, kmag }, Gillessen et al. 2017 Table 3, verbatim.

   VoyageBH.starPos(idx, jd, out) -> out
     Writes { x, y, z } in AU, LOCAL Sgr A* frame: x = sky North, y = sky
     East, z = away from Earth. Zero allocations. Returns null on a bad idx.

   VoyageBH.orbitPath(idx, n, out) -> Float64Array (3 * n)
     n samples of the ellipse in the same frame, uniform in eccentric
     anomaly. Allocates only when out is missing or too small.

   VoyageBH.FRAME -> { n:[3], e:[3], l:[3] }
     The local frame's axes as unit vectors in the page's world frame
     (ecliptic J2000), built from the real Sol -> Sgr A* direction.
   VoyageBH.toWorld(x, y, z, out) -> out   local AU triple -> world AU triple
   VoyageBH.precessArcmin(idx)             Schwarzschild precession per orbit

   VoyageBH.buildLut(rRs, mode, N, outLut) -> lut
     CPU geodesic table at camera radius rRs (units of r_s), mode 'static'
     or 'raindrop'. Fills and returns
       { thetaIn: Float64Array(N),   view angle from the hole direction, rad
         thetaOut: Float64Array(N),  sky angle from the hole direction, rad,
                                     UNWRAPPED (may exceed pi or go negative)
         captured: Uint8Array(N),    1 = no sky along that direction
         shift: Float64Array(N),     received / emitted frequency ratio for a
                                     source at infinity (1 = no shift)
         rProf: Float32Array(N * PHI_N),  u = 1/r along each ray against the
                                     swept angle phi, in r_s, for the disk
                                     crossing lookup. Read it through
                                     lutRadiusAt / lutUAt, never raw.
         shadowRad, rRs, mode, n, beta, firstLive, seq, valid, ms, steps }
     Reuses outLut's arrays when they are the right length.

   VoyageBH.drawLensed(ctx2d, lut, skyCanvas, opts) -> { px, ms, scale, dark, gl }
     Remap of an equirect sky canvas through the LUT. opts:
       { w, h, fwd:[3], right:[3], up:[3], hole:[3], fovDeg,
         quality (0.08-1, default 0.5), maxPixels (ceiling, default 120000),
         budgetMs (default 12), auto (false pins the ceiling),
         gl (false pins the CPU path), doppler (default on in raindrop mode),
         dopplerPow/Min/Max, gain, bg:[r,g,b] for the shadow }
     fwd/right/up are the camera basis and hole is the unit direction from
     the camera to the black hole, all in the SKY texture's frame. The
     internal resolution self-governs against budgetMs unless auto is false.
     A WebGL fragment shader draws the frame when one is available (it reads
     the same table and reproduces the same picture); the 2D loop is the
     correctness contract and the fallback, and stat.gl says which ran.
   VoyageBH.skyUv(dx, dy, dz, out) -> out    the pinned equirect convention
     u = (atan2(y, x) + pi) / 2pi, v = (pi/2 - asin(z)) / pi. voyage.js MUST
     bake the equirect canvas with this mapping.
   VoyageBH.invalidateSky()
     The sky pixels are read once per canvas and cached. Re-baking INTO THE
     SAME canvas (a theme flip, a new departure point) must call this, or
     pass opts.skyDirty = true on the next drawLensed, or the lens keeps
     showing the old sky.

   VoyageBH.drawDisk(ctx2d, lut, opts) -> { px, ms, hits }
     The faint equatorial flow, its first photon-ring echo and the optional
     true-rate hot spot, composited over the lensed sky with 'lighter'. Same
     camera opts (its own quality 0.5 / maxPixels 90000 / budgetMs 6) plus
     { normal:[3] the disk axis, rInRs (default 3 = the ISCO), rOutRs,
       base, brighten, hotspot:true, hotPhase, hotRRs, hotWidth }.

   VoyageBH.PHASES        the bhfall phase table, [{ name, ms }]
   VoyageBH.TOTAL_MS      sum of the table
   VoyageBH.pose(tSec, timeScale) -> { phase, k, frac, rRs, rAu, tauSec,
       tauLeftSec, beta, inside, compressed, trueRate, caption, capIndex,
       done, ms }
     Pure, and it returns the SAME object every call (no per-frame garbage).
     tSec is the page's SCALED clock, the cruise convention. tauLeftSec is
     the proper time still to come and tauSec the proper time already spent
     falling. The interior segment runs 1:1 with proper time at timeScale 1,
     which is what trueRate reports.
   VoyageBH.CAPTIONS      the caption track, verbatim spec copy
   VoyageBH.captionAt(tSec, timeScale) -> entry or null

   VoyageBH.lutLookup(lut, alpha)      sky angle, or NaN where it is dark
   VoyageBH.lutRadiusAt(lut, row, phi) r in r_s along a ray, 0 = nothing
   VoyageBH.lutUAt(lut, rowFrac, phi)  the same in u, blended across rows
   VoyageBH.shadowAngle(rRs, mode)     the analytic dark-cone half angle
   VoyageBH.captionMs(ms, timeScale)   the 1.8 s reading floor
   VoyageBH.phaseStart(name)           ms offset of a beat
   VoyageBH.clampTimeScale(v)          the slider range, 0.4 to 2.5

   VoyageBH.__hooks = { lutProbe(rRs, alphaRad, mode), tau(rRs),
     tauRemainSec(rAu), fallTauYears(rAu), shadowAngle, diskG, keplerE,
     jdToYear, skyUv, lutRadiusAt, fastAcos, fastAtan2, auto(), resetAuto(),
     gl(), setGl(on), constants }
   ========================================================================== */
(function (global) {
  'use strict';

  var PI = Math.PI;
  var TWO_PI = PI * 2;
  var DEG = PI / 180;

  /* ---------------- guards ---------------- */
  function fin(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /* ==========================================================================
     DERIVED CONSTANTS

     Everything below comes from three pinned inputs and nothing else:
       M      = 4.297e6 M_sun   GRAVITY Collaboration (Abuter et al.) 2022,
                                A&A 657, L12
       GM_sun / c^2 = 1476.625 m                      (standard)
       c      = 299792458 m/s, 1 AU = 1.495978707e11 m (exact / IAU)
     The Keck value (3.984e6 M_sun, Do et al. 2019) is a real published ~7%
     inter-team discrepancy; the honesty panel says so. We use the newer
     interferometer number.
     ========================================================================== */
  var M_SUN = 4.297e6;                 /* solar masses */
  var RG_SUN_M = 1476.625;             /* GM_sun / c^2, metres */
  var C_MS = 299792458;                /* m/s, exact */
  var AU_M = 1.495978707e11;           /* metres, exact by IAU definition */
  var RSUN_M = 6.957e8;                /* nominal solar radius, metres (IAU) */

  var RG_M = RG_SUN_M * M_SUN;         /* r_g = GM/c^2  = 6.345e9 m */
  var RS_M = 2 * RG_M;                 /* r_s = 2GM/c^2 = 1.269e10 m */
  var GM_C3 = RG_M / C_MS;             /* GM/c^3 = 21.165 s */
  var B_CRIT_RS = 3 * Math.sqrt(3) / 2;  /* = 2.59808 r_s (3 sqrt(3) r_g) */

  var RS_AU = RS_M / AU_M;             /* 0.084828 AU */
  var RG_AU = RG_M / AU_M;             /* 0.042414 AU */
  var PARK_AU = 1000;                  /* the parked standoff the plunge starts from */

  /* Proper time along a radial fall, measured from the singularity, for the
     rest-at-infinity (E = 1) geodesic:
        (dr/dtau)^2 = r_s/r   =>   tau(r) = (4/3) (r/r_s)^{3/2} GM/c^3.
     At the horizon that is (4/3) GM/c^3 = 28.2 s: the number the HUD counts.
     The trajectory we actually depict starts at rest at 1000 AU = 11,789 r_s,
     where E = sqrt(1 - r_s/r_0) = 0.9999576, so it differs from E = 1 by
     4e-5 in the interior and the 28.2 s figure is exact to five digits.
     pi GM/c^3 = 66.5 s is the LONGEST any trajectory can last inside; it is
     quoted only as the "nobody gets more than about a minute" fact. */
  var TAU_HORIZON = (4 / 3) * GM_C3;   /* 28.22 s */
  var TAU_MAX = PI * GM_C3;            /* 66.49 s */

  /* Total fall from rest at r0 to the centre. For radial infall from rest the
     GR proper time equals the Newtonian free-fall time exactly:
        tau = (pi/2) sqrt(r0^3 / (2GM)),  GM = (GM/c^3) c^3.
     At r0 = 1000 AU that is 2.70 years, which is what the approach caption
     means by "almost three years". */
  var GM_M3S2 = GM_C3 * C_MS * C_MS * C_MS;   /* GM in m^3/s^2 */
  var YEAR_S = 31557600;                      /* Julian year */
  function fallTauSec(rAu) {
    var r = num(rAu, 0) * AU_M;
    if (!(r > 0)) return 0;
    return (PI / 2) * Math.sqrt(r * r * r / (2 * GM_M3S2));
  }
  var FALL_SEC = fallTauSec(PARK_AU);              /* 8.51e7 s */
  var FALL_YEARS = FALL_SEC / YEAR_S;              /* 2.70 yr */

  var SGRA = {
    massMsun: M_SUN,
    rgAu: RG_AU,
    rsAu: RS_AU,
    photonAu: 1.5 * RS_AU,
    iscoAu: 3 * RS_AU,
    bCritAu: B_CRIT_RS * RS_AU,
    bCritRs: B_CRIT_RS,
    gmC3Sec: GM_C3,
    tauHorizonSec: TAU_HORIZON,
    tauMaxSec: TAU_MAX,
    parkAu: PARK_AU,
    parkRs: PARK_AU / RS_AU,
    rsKm: RS_M / 1000,
    rsRsun: RS_M / RSUN_M,            /* 18.24 solar radii */
    r0Pc: 8178,                       /* GRAVITY 2022 distance, parsecs */
    fallYears: FALL_YEARS
  };

  /* ==========================================================================
     THE LOCAL SGR A* FRAME

     Element convention (Gillessen et al. 2017, Table 3; the astrometric
     visual-binary convention it inherits from Gillessen et al. 2009 via the
     Thiele-Innes formalism):
       i     inclination of the orbit plane to the plane of the sky
       Omega POSITION ANGLE of the ascending node, measured in the sky plane
             from North through East
       omega argument of pericenter, measured in the orbit plane from the
             ascending node in the direction of motion
       t_P   epoch of pericenter passage, years; sky frame epoch 2009.0
     The ascending node is the crossing where the star moves AWAY from Earth,
     so the line-of-sight axis is positive AWAY from Earth.

     Local axes used everywhere in this file:
       x = North (celestial J2000 north projected into the sky plane)
       y = East
       z = away from Earth (the Sol -> Sgr A* direction)
     Note (x, y, z) in that order is LEFT handed, which is exactly what the
     astrometric convention is: looking at the sky, North is up and East is
     to the left. Position from elements:
       x = r [ cos(w+nu) cosOm - sin(w+nu) sinOm cos i ]
       y = r [ cos(w+nu) sinOm + sin(w+nu) cosOm cos i ]
       z = r [ sin(w+nu) sin i ]
     which expands to the standard Thiele-Innes constants A, F / B, G / C, H.

     World mapping: the page's world frame is ecliptic J2000 (voyage.js and
     voyage-astro.js agree on that). l = the unit vector to Sgr A* from the
     Sun; e (East) = normalize(zPole x l); n (North) = l x e. Sgr A*'s
     position is the same J2000 radio position voyage.js uses for the
     galactic centre, so the cluster sits exactly where the catalogue puts
     the hole.
     ========================================================================== */
  var GC_RA_DEG = 266.40500, GC_DEC_DEG = -28.93617;   /* J2000, as voyage.js */
  var OBLIQ = 23.43928 * DEG;                          /* J2000 obliquity */

  function equToEclV(v, out) {
    var ce = Math.cos(OBLIQ), se = Math.sin(OBLIQ);
    out[0] = v[0];
    out[1] = ce * v[1] + se * v[2];
    out[2] = -se * v[1] + ce * v[2];
    return out;
  }
  var FRAME = (function () {
    var ra = GC_RA_DEG * DEG, dc = GC_DEC_DEG * DEG, cd = Math.cos(dc);
    var lEq = [cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dc)];
    /* East = zPole x l, normalised (direction of increasing right ascension) */
    var eEq = [-lEq[1], lEq[0], 0];
    var en = Math.sqrt(eEq[0] * eEq[0] + eEq[1] * eEq[1]) || 1;
    eEq[0] /= en; eEq[1] /= en;
    /* North = l x East (direction of increasing declination) */
    var nEq = [lEq[1] * eEq[2] - lEq[2] * eEq[1],
               lEq[2] * eEq[0] - lEq[0] * eEq[2],
               lEq[0] * eEq[1] - lEq[1] * eEq[0]];
    return {
      n: equToEclV(nEq, [0, 0, 0]),
      e: equToEclV(eEq, [0, 0, 0]),
      l: equToEclV(lEq, [0, 0, 0])
    };
  })();

  function toWorld(x, y, z, out) {
    var o = out || [0, 0, 0];
    var N = FRAME.n, E = FRAME.e, L = FRAME.l;
    o[0] = x * N[0] + y * E[0] + z * L[0];
    o[1] = x * N[1] + y * E[1] + z * L[1];
    o[2] = x * N[2] + y * E[2] + z * L[2];
    return o;
  }

  /* ==========================================================================
     S-STAR ORBITAL ELEMENTS

     Gillessen, S. et al. 2017, ApJ 837, 30, "An Update on Monitoring Stellar
     Orbits in the Galactic Center" (arXiv:1611.09144), Table 3, transcribed
     verbatim in research-sgra.md section 2. Semi-major axes were published in
     arcsec and converted with that paper's OWN adopted distance R0 = 8320 pc,
     so the table stays self-consistent with its own fit; periods come from
     the table too, so nothing here needs a mass constant. periAu = a (1 - e).

     EXCLUDED ON PURPOSE: S62, S4711, S4714 and S4716 (Peissker et al.
     2020-2022). GRAVITY Collaboration 2021 (A&A 645, A127) finds the object
     at the claimed position consistent with S29, not a new star. We do not
     draw disputed orbits and the card does not mention them.
     ========================================================================== */
  var SSTARS = [
    /* name    a("),  a(AU),  e,        i,       Omega,   omega,   P(yr),  t_P,      periAu, K   */
    { name: 'S1',  aAu: 4950, e: 0.556,  iDeg: 119.14, OmDeg: 342.04, wDeg: 122.3,  Pyr: 166.0, tPeriYr: 2001.80, periAu: 2198, kmag: 14.7 },
    /* S2: the anchor star. P = 16.00 yr, pericenter 121 AU, and its 2018
       pericenter passage is the one that produced the gravitational-redshift
       and Schwarzschild-precession detections. */
    { name: 'S2',  aAu: 1044, e: 0.8839, iDeg: 134.18, OmDeg: 226.94, wDeg: 65.51,  Pyr: 16.00, tPeriYr: 2002.33, periAu: 121,  kmag: 13.95 },
    { name: 'S4',  aAu: 2970, e: 0.3905, iDeg: 80.33,  OmDeg: 258.84, wDeg: 290.8,  Pyr: 77.0,  tPeriYr: 1957.4,  periAu: 1810, kmag: 14.4 },
    { name: 'S8',  aAu: 3367, e: 0.8031, iDeg: 74.37,  OmDeg: 315.43, wDeg: 346.70, Pyr: 92.9,  tPeriYr: 1983.64, periAu: 663,  kmag: 14.5 },
    { name: 'S9',  aAu: 2266, e: 0.644,  iDeg: 82.41,  OmDeg: 156.60, wDeg: 150.6,  Pyr: 51.3,  tPeriYr: 1976.71, periAu: 807,  kmag: 15.1 },
    { name: 'S12', aAu: 2485, e: 0.8883, iDeg: 33.56,  OmDeg: 230.1,  wDeg: 317.9,  Pyr: 58.9,  tPeriYr: 1995.59, periAu: 278,  kmag: 15.5 },
    { name: 'S13', aAu: 2197, e: 0.4250, iDeg: 24.70,  OmDeg: 74.5,   wDeg: 245.2,  Pyr: 49.00, tPeriYr: 2004.86, periAu: 1263, kmag: 15.8 },
    { name: 'S14', aAu: 2382, e: 0.9761, iDeg: 100.59, OmDeg: 226.38, wDeg: 334.59, Pyr: 55.3,  tPeriYr: 2000.12, periAu: 57,   kmag: 15.7 },
    { name: 'S17', aAu: 2961, e: 0.397,  iDeg: 96.83,  OmDeg: 191.62, wDeg: 326.0,  Pyr: 76.6,  tPeriYr: 1991.19, periAu: 1786, kmag: 15.3 },
    { name: 'S21', aAu: 1822, e: 0.764,  iDeg: 58.8,   OmDeg: 259.64, wDeg: 166.4,  Pyr: 37.00, tPeriYr: 2027.40, periAu: 430,  kmag: 16.9 },
    { name: 'S24', aAu: 7854, e: 0.8970, iDeg: 103.67, OmDeg: 7.93,   wDeg: 290,    Pyr: 331,   tPeriYr: 2024.50, periAu: 809,  kmag: 15.6 },
    { name: 'S29', aAu: 3561, e: 0.728,  iDeg: 105.8,  OmDeg: 161.96, wDeg: 346.5,  Pyr: 101.0, tPeriYr: 2025.96, periAu: 969,  kmag: 16.7 },
    { name: 'S38', aAu: 1178, e: 0.8201, iDeg: 171.1,  OmDeg: 101.06, wDeg: 17.99,  Pyr: 19.2,  tPeriYr: 2003.19, periAu: 212,  kmag: 17.0 },
    /* S55 is also catalogued as S0-102 (Keck naming). */
    { name: 'S55', aAu: 897,  e: 0.7209, iDeg: 150.1,  OmDeg: 325.5,  wDeg: 331.5,  Pyr: 12.80, tPeriYr: 2009.34, periAu: 250,  kmag: 17.5 }
  ];

  /* Thiele-Innes constants, cached once per row (zero allocation per call).
     Six numbers per star: A F B G C H, in AU. */
  var TI = new Float64Array(SSTARS.length * 6);
  (function buildTI() {
    for (var s = 0; s < SSTARS.length; s++) {
      var r = SSTARS[s];
      var a = r.aAu;
      var ci = Math.cos(r.iDeg * DEG);
      var cO = Math.cos(r.OmDeg * DEG), sO = Math.sin(r.OmDeg * DEG);
      var cw = Math.cos(r.wDeg * DEG), sw = Math.sin(r.wDeg * DEG);
      var k = s * 6;
      TI[k]     = a * (cw * cO - sw * sO * ci);       /* A: North  X term */
      TI[k + 1] = a * (-sw * cO - cw * sO * ci);      /* F: North  Y term */
      TI[k + 2] = a * (cw * sO + sw * cO * ci);       /* B: East   X term */
      TI[k + 3] = a * (-sw * sO + cw * cO * ci);      /* G: East   Y term */
      TI[k + 4] = a * (sw * Math.sin(r.iDeg * DEG));  /* C: LOS    X term */
      TI[k + 5] = a * (cw * Math.sin(r.iDeg * DEG));  /* H: LOS    Y term */
    }
  })();

  /* Kepler's equation, Newton with a Danby starter. Pure, node-tested. */
  function keplerE(M, e) {
    var m = M % TWO_PI;
    if (m > PI) m -= TWO_PI;
    if (m < -PI) m += TWO_PI;
    var E = m + e * Math.sin(m) * (1 + e * Math.cos(m));   /* Danby starter */
    for (var i = 0; i < 40; i++) {
      var s = Math.sin(E), c = Math.cos(E);
      var f = E - e * s - m;
      var fp = 1 - e * c;
      if (!(Math.abs(fp) > 1e-14)) fp = fp < 0 ? -1e-14 : 1e-14;
      var d = f / fp;
      /* Halley: dE = f / (f' - f f'' / (2 f')), f'' = e sin E. The near
         parabolic rows (S14 at e = 0.976) need it; the denominator is
         guarded and the step is clamped so a bad starter cannot run away. */
      var den = fp - 0.5 * d * e * s;
      if (Math.abs(den) > 1e-14) d = f / den;
      if (d > 1) d = 1; else if (d < -1) d = -1;
      E -= d;
      if (Math.abs(d) < 1e-14) break;
    }
    return E;
  }

  /* Julian date -> Julian year (2000.0 = JD 2451545.0). */
  function jdToYear(jd) { return 2000 + (num(jd, 2451545) - 2451545) / 365.25; }

  var POS_TMP = { x: 0, y: 0, z: 0 };
  function starPos(idx, jd, out) {
    var i = idx | 0;
    if (!(i >= 0 && i < SSTARS.length)) return null;
    var r = SSTARS[i];
    var o = out || POS_TMP;
    var yr = jdToYear(jd);
    var M = TWO_PI * (yr - r.tPeriYr) / r.Pyr;
    var E = keplerE(M, r.e);
    var X = Math.cos(E) - r.e;
    var Y = Math.sqrt(1 - r.e * r.e) * Math.sin(E);
    var k = i * 6;
    o.x = TI[k] * X + TI[k + 1] * Y;
    o.y = TI[k + 2] * X + TI[k + 3] * Y;
    o.z = TI[k + 4] * X + TI[k + 5] * Y;
    return o;
  }

  function orbitPath(idx, n, out) {
    var i = idx | 0;
    if (!(i >= 0 && i < SSTARS.length)) return null;
    var cnt = Math.max(3, Math.min(4096, num(n, 128) | 0));
    var arr = (out && out.length >= cnt * 3) ? out : new Float64Array(cnt * 3);
    var r = SSTARS[i], k = i * 6;
    var sq = Math.sqrt(1 - r.e * r.e);
    for (var j = 0; j < cnt; j++) {
      var E = TWO_PI * j / (cnt - 1);
      var X = Math.cos(E) - r.e;
      var Y = sq * Math.sin(E);
      arr[j * 3]     = TI[k] * X + TI[k + 1] * Y;
      arr[j * 3 + 1] = TI[k + 2] * X + TI[k + 3] * Y;
      arr[j * 3 + 2] = TI[k + 4] * X + TI[k + 5] * Y;
    }
    return arr;
  }

  /* Schwarzschild precession per orbit, Gillessen et al. 2017 Eq. 1:
     dw = 6 pi GM / (c^2 a (1 - e^2)). For S2 this returns 12.0 arcmin, which
     is the figure the GRAVITY 2020 detection is popularly quoted with. */
  function precessArcmin(idx) {
    var i = idx | 0;
    if (!(i >= 0 && i < SSTARS.length)) return NaN;
    var r = SSTARS[i];
    var rad = 6 * PI * RG_AU / (r.aAu * (1 - r.e * r.e));
    return rad * (180 / PI) * 60;
  }

  /* ==========================================================================
     THE GEODESIC LENS

     Null geodesics in Schwarzschild, in r_s = 1 units, as the orbit equation
     in u = 1/r against the swept angle phi:

         u'' + u = (3/2) u^2,      (du/dphi)^2 = 1/b^2 - u^2 + u^3

     b is the impact parameter (also in r_s), and the second form is the
     invariant that fixes |u'| at the start. This is a port of the validated
     prototype in .claude/plans/bh-lut-proto.js, with its two paid-for
     lessons kept verbatim:

       (1) NEVER grind the escape to u -> 0 on the phi grid. The asymptote
           quantizes at O(step) and poisons the anchors. Once the ray is
           outbound and b*u is small, stop and add the analytic flat-space
           tail asin(b*u). (The neglected term is O(b^3 u^4); at the switch
           threshold below that is under 1e-7 rad.)
       (2) The prototype's fixed h = 1e-3 costs about 19 ms for 384 rays.
           The step here is adaptive: it holds the fractional change in u per
           step under EPS_U and is capped at H_MAX, which is coarse where the
           dynamics are trivial and fine through pericenter. The anchors in
           the node suite are the regression net for that choice.

     Rays are traced BACKWARD from the camera: phi = 0 at the camera and
     grows along the backward path, so a ray we see coming from the hole
     direction starts with u increasing.

     Angles. thetaIn is the LOOK angle measured from the direction of the
     hole (0 = straight at it). thetaOut is where that line of sight lands on
     the distant sky, also measured from the hole direction, UNWRAPPED: with
     no hole thetaOut === thetaIn, weak lensing pushes thetaOut below thetaIn
     (images move away from the hole), and a ray that winds around gives
     thetaOut < 0, which is the fold that produces the photon ring and the
     higher-order images. The renderer rotates the hole direction by thetaOut
     inside the plane of the ray, so the winding needs no special case.

     Observer states. b is fixed by the look angle and the observer:
       static   b = r sin(a) / f,             f = sqrt(1 - 1/r)
       raindrop b = r sin(a) / (1 - B cos a), B = sqrt(1/r)
     The raindrop form is the free-fall (Gullstrand-Painleve) observer,
     derived in the river frame where the local radial basis vector is just
     d/dr; it is REGULAR at and inside the horizon, which is why the plunge
     uses it. It is also exactly the special-relativistic aberration of the
     static angle by v = sqrt(r_s/r), which is the identity the anchor test
     checks (7.27 deg static becomes 5.80 deg raindrop at r = 20 r_s).
     Received over emitted frequency for a source at infinity collapses to
       g = 1 / (1 - B cos a)
     for the raindrop observer (gravitational blueshift 1/f times the Doppler
     factor 1/(gamma (1 - B cos a)), with gamma = 1/f because B^2 = 1 - f^2),
     and to 1/f for a static one.
     ========================================================================== */
  var H_MAX = 0.03;          /* rad, coarse cap on the phi step */
  var H_MIN = 2e-6;
  var EPS_U = 0.05;          /* max fractional change in u per step */
  var U_FLOOR = 0.02;        /* keeps the step sane as u falls to 0 */
  var TAIL_BU = 0.02;        /* switch to the analytic tail below this b*u */
  var PHI_CAP = 8 * PI;      /* a ray that winds past this is dark for us */
  var STEP_CAP = 60000;

  /* The r(phi) profile grid shared by every ray in a LUT: the disk needs the
     radius at the two equatorial crossings, which sit at phi_c and
     phi_c + pi with phi_c in (0, pi], so the grid spans a little over 2 pi.

     It stores u = 1/r, NOT r, and that is load bearing. r runs to infinity
     along an escaping ray, so linear interpolation between samples 0.07 rad
     apart threw the crossing radius far enough off to drop whole regions of
     flow and leave a dithered dark lens around the shadow. u is bounded and
     smooth, and it needs no sentinel either: u = 0 is "infinitely far away"
     and u > 1 is "inside the horizon", and neither carries material. */
  var PHI_N = 96;
  var PHI_PROF_MAX = 2.2 * PI;
  var PHI_PROF_STEP = PHI_PROF_MAX / (PHI_N - 1);

  var RAY = { captured: false, phiTotal: 0, b: 0, steps: 0 };

  function accU(u) { return 1.5 * u * u - u; }

  /* Trace one backward ray. u0 = 1/r at the camera (r_s units), b its impact
     parameter, sgn the initial sign of du/dphi (+1 = toward the hole).
     prof/off, when given, receive the PHI_N-sample r(phi) profile in r_s
     (0 where the ray has ended). Writes RAY and returns it. */
  function traceRay(u0, b, sgn, prof, off) {
    var u = u0;
    var uCap = u0 > 1 ? u0 * (1 + 1e-9) : 1;
    var w = 1 / (b * b) - u * u + u * u * u;
    var du = (sgn >= 0 ? 1 : -1) * Math.sqrt(w > 0 ? w : 0);
    var phi = 0, steps = 0, captured = false;
    var gi = 0, gPhi = 0;
    if (prof) { prof[off] = u; gi = 1; gPhi = PHI_PROF_STEP; }
    var uPrev = u, phiPrev = 0;

    while (phi < PHI_CAP && steps < STEP_CAP) {
      var h = EPS_U * (u + U_FLOOR) / (Math.abs(du) + 1e-12);
      if (h > H_MAX) h = H_MAX;
      if (h < H_MIN) h = H_MIN;
      /* RK4 on (u, du) */
      var k1u = du,                 k1v = accU(u);
      var k2u = du + 0.5 * h * k1v, k2v = accU(u + 0.5 * h * k1u);
      var k3u = du + 0.5 * h * k2v, k3v = accU(u + 0.5 * h * k2u);
      var k4u = du + h * k3v,       k4v = accU(u + h * k3u);
      uPrev = u; phiPrev = phi;
      u  += (h / 6) * (k1u + 2 * k2u + 2 * k3u + k4u);
      du += (h / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
      phi += h;
      steps++;
      if (!(isFinite(u) && isFinite(du))) { captured = true; break; }

      /* profile samples crossed by this step, linear in phi */
      if (prof) {
        while (gi < PHI_N && gPhi <= phi) {
          var t = (phi > phiPrev) ? (gPhi - phiPrev) / (phi - phiPrev) : 0;
          prof[off + gi] = uPrev + (u - uPrev) * t;
          gi++; gPhi += PHI_PROF_STEP;
        }
      }

      /* inside the horizon and still heading in: no sky along this line */
      if (u >= uCap && du > 0) { captured = true; break; }
      /* outbound and effectively in flat space: analytic tail, lesson (1) */
      if (du < 0 && b * u < TAIL_BU) {
        phi += Math.asin(clamp(b * u, -1, 1));
        break;
      }
      if (u <= 0) { captured = false; break; }
    }
    if (phi >= PHI_CAP || steps >= STEP_CAP) captured = true;
    /* past the end of the ray: 2 (well inside the horizon) for a captured
       ray, 0 (infinitely far) for an escaped one. Both mean "no material" */
    if (prof) {
      var fillU = captured ? 2 : 0;
      while (gi < PHI_N) { prof[off + gi] = fillU; gi++; }
    }
    RAY.captured = captured;
    RAY.phiTotal = phi;
    RAY.b = b;
    RAY.steps = steps;
    return RAY;
  }

  /* look angle -> impact parameter and initial radial sign, per observer.
     Returns b = -1 when that direction cannot carry a photon at all (the
     forward cone inside the horizon, where 1 - B cos a turns negative). */
  var BSGN = { b: 0, sgn: 1, shift: 1 };
  function bOfAngle(rRs, alpha, beta, isStatic) {
    var sa = Math.sin(alpha), ca = Math.cos(alpha);
    if (isStatic) {
      var f2 = 1 - 1 / rRs;
      if (!(f2 > 0)) { BSGN.b = -1; return BSGN; }
      var f = Math.sqrt(f2);
      BSGN.b = rRs * sa / f;
      BSGN.sgn = ca >= 0 ? 1 : -1;
      BSGN.shift = 1 / f;
      return BSGN;
    }
    var den = 1 - beta * ca;
    if (!(den > 1e-12)) { BSGN.b = -1; return BSGN; }
    BSGN.b = rRs * sa / den;
    /* S = (cos a - B) / (1 - B cos a) is the static-frame radial cosine of
       the photon; the backward ray heads toward the hole when S > 0 */
    BSGN.sgn = (ca - beta) >= 0 ? 1 : -1;
    BSGN.shift = 1 / den;
    return BSGN;
  }

  /* Analytic dark-cone half angle. Solving b(alpha) = b_crit gives
     R sin(alpha + psi) = b_crit with R = hypot(r, b_crit B) and
     psi = atan2(b_crit B, r) for the raindrop observer, or plain
     sin(alpha) = b_crit f / r (Synge) for the static one. Outside the photon
     sphere the boundary is the SMALL root; inside it the escape cone hugs
     the outward direction and the boundary is the large one. */
  function shadowAngle(rRs, mode) {
    var r = num(rRs, 0);
    if (!(r > 0)) return PI;
    var isStatic = mode !== 'raindrop';
    var s, root1, root2;
    if (isStatic) {
      var f2 = 1 - 1 / r;
      if (!(f2 > 0)) return PI;          /* no static observer at or inside r_s */
      s = B_CRIT_RS * Math.sqrt(f2) / r;
      if (s > 1) s = 1;
      root1 = Math.asin(s); root2 = PI - root1;
    } else {
      var beta = Math.sqrt(1 / r);
      var R = Math.sqrt(r * r + B_CRIT_RS * B_CRIT_RS * beta * beta);
      var psi = Math.atan2(B_CRIT_RS * beta, r);
      s = B_CRIT_RS / R;
      if (s > 1) s = 1;
      root1 = Math.asin(s) - psi;
      root2 = PI - Math.asin(s) - psi;
    }
    var a = (r > 1.5) ? root1 : root2;
    return clamp(a, 0, PI);
  }

  /* -------------------------------------------------------------------- */
  function newLut(N) {
    return {
      thetaIn: new Float64Array(N),
      thetaOut: new Float64Array(N),
      captured: new Uint8Array(N),
      shift: new Float64Array(N),
      rProf: new Float32Array(N * PHI_N),
      shadowRad: 0, rRs: 0, mode: 'static', n: N, beta: 0, firstLive: 0,
      phiN: PHI_N, phiStep: PHI_PROF_STEP, valid: false, ms: 0, steps: 0, seq: 0
    };
  }
  var LUT_SEQ = 0;

  function nowMs() {
    return (typeof performance !== 'undefined' && performance && performance.now)
      ? performance.now() : Date.now();
  }

  function buildLut(rRs, mode, N, outLut) {
    /* a table is always built before the first frame that draws it, so this
       is where the shader gets its head start: the link is polled, never
       waited on, and the CPU path carries any frame that arrives first */
    if (!GLX.tried && GLX.on) glInit();
    var n = Math.max(16, Math.min(4096, num(N, 384) | 0));
    var r = num(rRs, 6);
    if (!(r > 1e-4)) r = 1e-4;
    var isStatic = mode !== 'raindrop';
    /* a static observer does not exist at or inside the horizon: fall back
       to the free-fall frame rather than emitting NaNs */
    if (isStatic && !(r > 1.0000001)) isStatic = false;
    var lut = outLut;
    if (!lut || !lut.thetaIn || lut.thetaIn.length !== n ||
        !lut.rProf || lut.rProf.length !== n * PHI_N) lut = newLut(n);
    var beta = Math.sqrt(1 / r);
    var u0 = 1 / r;
    var tIn = lut.thetaIn, tOut = lut.thetaOut, cap = lut.captured;
    var sh = lut.shift, prof = lut.rProf;
    var i, q, steps = 0;
    var t0 = nowMs();

    for (i = 0; i < n; i++) {
      var a = (i + 0.5) * PI / n;
      tIn[i] = a;
      var bs = bOfAngle(r, a, beta, isStatic);
      if (!(bs.b >= 0)) {
        cap[i] = 1; tOut[i] = 0; sh[i] = 1;
        for (q = 0; q < PHI_N; q++) prof[i * PHI_N + q] = 2;
        continue;
      }
      sh[i] = bs.shift;
      var res = traceRay(u0, Math.max(bs.b, 1e-9), bs.sgn, prof, i * PHI_N);
      steps += res.steps;
      cap[i] = res.captured ? 1 : 0;
      tOut[i] = res.captured ? 0 : (PI - res.phiTotal);
    }

    /* the dark-cone edge: analytic, then confirmed against the scan so a
       stepping change that broke the physics cannot pass silently */
    var edge = shadowAngle(r, isStatic ? 'static' : 'raindrop');
    var last = -1;
    for (i = 0; i < n; i++) { if (cap[i]) last = i; else if (last >= 0) break; }
    if (last >= 0) {
      var lo = tIn[last], hi = (last + 1 < n) ? tIn[last + 1] : PI;
      if (!(edge >= lo - PI / n && edge <= hi + PI / n)) edge = 0.5 * (lo + hi);
    }
    lut.shadowRad = edge;
    /* the first row that carries sky. The renderers test darkness against
       shadowRad (exact) and clamp their row index here, which puts the rim
       on the analytic angle instead of the nearest sampled row. */
    var fl = 0;
    while (fl < n && cap[fl]) fl++;
    lut.firstLive = fl;
    lut.seq = ++LUT_SEQ;
    lut.rRs = r;
    lut.mode = isStatic ? 'static' : 'raindrop';
    lut.n = n;
    lut.beta = isStatic ? 0 : beta;
    lut.phiN = PHI_N;
    lut.phiStep = PHI_PROF_STEP;
    lut.steps = steps;
    lut.ms = nowMs() - t0;
    lut.valid = true;
    return lut;
  }

  /* Sample the LUT at an arbitrary look angle. Returns the interpolated sky
     angle, or NaN when the direction is dark. Captured neighbours are never
     blended into a live sample: the fold at the edge is a discontinuity and
     interpolating across it would smear the shadow rim. */
  function lutLookup(lut, alpha) {
    if (!lut || !lut.valid) return NaN;
    var n = lut.n;
    var x = alpha * n / PI - 0.5;
    if (x < 0) x = 0;
    if (x > n - 1) x = n - 1;
    var i = x | 0, j = (i + 1 > n - 1) ? n - 1 : i + 1;
    var t = x - i;
    if (lut.captured[i] || lut.captured[j]) {
      var k = t < 0.5 ? i : j;
      return lut.captured[k] ? NaN : lut.thetaOut[k];
    }
    return lut.thetaOut[i] + (lut.thetaOut[j] - lut.thetaOut[i]) * t;
  }

  /* u = 1/r at swept angle phi along the ray of LUT row i (or of the
     fractional row rowF, blended, which is what the flow renderer wants:
     nearest-row lookup alone dithered the inner edge of the flow). */
  function lutUAt(lut, rowF, phi) {
    if (!lut || !lut.valid || !(phi >= 0)) return 2;
    var pn = lut.phiN;
    var x = phi / lut.phiStep;
    if (x > pn - 1) x = pn - 1;
    var k = x | 0, t = x - k;
    var k2 = (k + 1 < pn) ? k + 1 : k;
    var rf = rowF;
    if (rf < 0) rf = 0; else if (rf > lut.n - 1) rf = lut.n - 1;
    var i0 = rf | 0, i1 = (i0 + 1 > lut.n - 1) ? lut.n - 1 : i0 + 1;
    var s = rf - i0;
    var p = lut.rProf;
    var a = p[i0 * pn + k], b = p[i0 * pn + k2];
    var c = p[i1 * pn + k], d = p[i1 * pn + k2];
    var u0 = a + (b - a) * t, u1 = c + (d - c) * t;
    return u0 + (u1 - u0) * s;
  }
  /* r in r_s at swept angle phi along the ray of LUT row i. 0 means there is
     nothing there: either infinitely far away or inside the horizon. */
  function lutRadiusAt(lut, i, phi) {
    var u = lutUAt(lut, i, phi);
    if (!(u > 1e-9) || u > 1) return 0;
    return 1 / u;
  }

  /* ==========================================================================
     THE LENSED SKY (2D remap)

     The LUT makes this O(pixels) instead of O(pixels * integration): per
     output pixel we need one look angle, one table read and one texture
     fetch. The renderer works at a reduced internal resolution and is
     upscaled by the browser's own smoothing, which is what keeps the
     fallback affordable; the governor can push the internal resolution down
     further through opts.maxPixels.

     Equirect convention (PINNED; voyage.js bakes the sky with skyUv so the
     two can never drift):
       u = (atan2(y, x) + pi) / (2 pi)      v = (pi/2 - asin(z)) / pi
     i.e. v = 0 at +z of the sky frame, u wraps at -x.

     Doppler. For a source at infinity the raindrop observer receives
     g = 1/(1 - B cos a), which the LUT already carries per row. Bolometric
     intensity scales as g^4, a range no screen can hold (g reaches 10 near
     the horizon), so the brightness here uses a compressed exponent and is
     clamped; the tint is indicative rather than spectrally computed, and the
     page's honesty panel says so. Set opts.doppler = false to switch the
     whole effect off.
     ========================================================================== */
  var SKY_UV = [0, 0];
  function skyUv(dx, dy, dz, out) {
    var o = out || SKY_UV;
    var n = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(n > 0)) { o[0] = 0; o[1] = 0.5; return o; }
    var z = dz / n;
    if (z > 1) z = 1; else if (z < -1) z = -1;
    o[0] = (Math.atan2(dy / n, dx / n) + PI) / TWO_PI;
    o[1] = (PI / 2 - Math.asin(z)) / PI;
    return o;
  }

  /* module-level scratch: the internal-resolution buffer and the canvas it
     is blitted from. Both persist; nothing here allocates per frame. */
  var LB = { cv: null, ctx: null, img: null, w: 0, h: 0 };   /* lensed sky */
  var DB = { cv: null, ctx: null, img: null, w: 0, h: 0 };   /* the flow */
  var SKY = { src: null, w: 0, h: 0, data: null, cv: null, ctx: null };

  /* The two renderers keep SEPARATE buffers on purpose: they run at
     different internal resolutions in the same frame, and one shared buffer
     would be reallocated twice per frame, which is exactly the per-frame
     allocation this page forbids. */
  function ensureBuf(B, w, h) {
    if (B.w === w && B.h === h && B.img) return true;
    if (!B.cv) {
      if (typeof document === 'undefined' || !document.createElement) return false;
      B.cv = document.createElement('canvas');
      B.ctx = B.cv.getContext('2d');
    }
    if (!B.ctx) return false;
    B.cv.width = w; B.cv.height = h;
    B.img = B.ctx.createImageData(w, h);
    B.w = w; B.h = h;
    return true;
  }

  /* Pull the equirect pixels once per sky canvas. getImageData is the only
     way to sample a canvas per pixel, and it is the reason the sky is baked
     once at mode entry rather than every frame. */
  /* Re-baked the sky into the SAME canvas at the same size? Say so, or this
     cache will happily serve the old pixels forever. */
  function invalidateSky() {
    SKY.src = null; SKY.data = null;
    GLX.skySrc = null;                  /* the GPU copy is the same cache */
  }

  function ensureSky(skyCanvas) {
    if (!skyCanvas || !skyCanvas.width || !skyCanvas.height) return false;
    if (SKY.src === skyCanvas && SKY.w === skyCanvas.width &&
        SKY.h === skyCanvas.height && SKY.data) return true;
    var w = skyCanvas.width, h = skyCanvas.height;
    var ctx = null;
    try { ctx = skyCanvas.getContext('2d', { willReadFrequently: true }); }
    catch (e) { ctx = null; }
    if (!ctx) return false;
    var img = null;
    try { img = ctx.getImageData(0, 0, w, h); } catch (e2) { return false; }
    if (!img) return false;
    SKY.src = skyCanvas; SKY.w = w; SKY.h = h; SKY.data = img.data;
    return true;
  }

  /* ==========================================================================
     THE GL FAST PATH (BHF-2)

     The remap is the same physics either way: the CPU still integrates every
     geodesic and still owns the table, and the shader below only READS it.
     What changes is the per-pixel cost. Measured in the target browser, the
     JS loop under this comment costs about 160 ns per internal pixel, so a
     frame that covers a third of a 1280x820 canvas costs 60 ms and the
     internal-resolution governor has no choice but to shrink until the stars
     smear. The same arithmetic in a fragment shader is under a millisecond,
     which is what lets the plunge run at (or near) the canvas's own
     resolution. The 2D loop stays as the correctness contract and the
     fallback: no GL, a non-power-of-two sky, a shader that fails to link, a
     lost context or any throw at all hands the frame straight back to it.

     Everything the shader needs beyond the sky is four numbers per table row
     (the sine and cosine of the outgoing sky angle, the Doppler brightness
     and its tint), and it gets them through a tiny N x 2 texture, 16 bits
     per value: an 8-bit channel would band a smooth sky gradient, and the
     angle needs a good deal better than 1/256 of a radian.
     ========================================================================== */
  var GL_AMP_SCALE = 8, GL_TINT_SCALE = 2;   /* the encodings' fixed ranges */
  var GLX = {
    tried: false, dead: false, cv: null, gl: null, prog: null, ready: false,
    ext: null, frames: 0, u: null, skyTex: null, lutTex: null, buf: null,
    skySrc: null, skyW: 0, skyH: 0, lutSeq: -1, lutKey: '', lutN: 0,
    lutPix: null, w: 0, h: 0, on: true
  };

  var GL_VS =
    'attribute vec2 p;varying vec2 vuv;' +
    'void main(){vuv=p*0.5+0.5;gl_Position=vec4(p,0.0,1.0);}';
  var GL_FS = [
    'precision highp float;',
    'varying vec2 vuv;',
    'uniform vec3 uFwd,uRgt,uUp,uHole,uBg;',
    'uniform vec2 uTan;',
    /* n, firstLive, shadowRad, gain */
    'uniform vec4 uP;',
    'uniform float uHasSky;',
    'uniform sampler2D uSky,uLutT;',
    'const float PI=3.141592653589793;',
    'float d16(vec2 t){return (t.x*65280.0+t.y*255.0)/65535.0;}',
    'void main(){',
    '  vec2 s=(vuv*2.0-1.0)*uTan;',
    '  vec3 d=normalize(uFwd+uRgt*s.x+uUp*s.y);',
    '  float ca=clamp(dot(d,uHole),-1.0,1.0);',
    '  float alpha=acos(ca);',
    '  if(alpha<=uP.z){gl_FragColor=vec4(uBg,1.0);return;}',
    '  float n=uP.x;',
    '  float xi=clamp(alpha*n/PI-0.5,uP.y,n-1.0);',
    '  float i0=floor(xi);',
    '  float ft=xi-i0;',
    '  float i1=min(i0+1.0,n-1.0);',
    '  vec2 t0=vec2((i0+0.5)/n,0.25),t1=vec2((i1+0.5)/n,0.25);',
    '  vec4 A=texture2D(uLutT,t0),B=texture2D(uLutT,t1);',
    '  float cs=mix(d16(A.rg),d16(B.rg),ft)*2.0-1.0;',
    '  float sn=mix(d16(A.ba),d16(B.ba),ft)*2.0-1.0;',
    '  vec4 C=texture2D(uLutT,vec2(t0.x,0.75)),D=texture2D(uLutT,vec2(t1.x,0.75));',
    '  float amp=mix(d16(C.rg),d16(D.rg),ft)*' + GL_AMP_SCALE.toFixed(1) + ';',
    '  float tint=mix(d16(C.ba),d16(D.ba),ft)*' + GL_TINT_SCALE.toFixed(1) + ';',
    '  float tl=sqrt(max(1e-12,1.0-ca*ca));',
    '  vec3 w=uHole*cs+(d-ca*uHole)*(sn/tl);',
    '  vec3 c=vec3(0.0);',
    '  if(uHasSky>0.5){',
    '    float uu=(atan(w.y,w.x)+PI)*(0.5/PI);',
    '    float vv=acos(clamp(w.z,-1.0,1.0))/PI;',
    '    c=texture2D(uSky,vec2(uu,vv)).rgb;',
    '  }',
    '  if(tint>0.0){c.r/=tint;c.b*=tint;}',
    '  c*=amp*uP.w;',
    '  gl_FragColor=vec4(clamp(c,0.0,1.0),1.0);',
    '}'
  ].join('\n');

  function glShader(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  }
  function glInit() {
    if (GLX.tried) return;
    GLX.tried = true;
    if (typeof document === 'undefined' || !document.createElement) { GLX.dead = true; return; }
    try {
      var cv = document.createElement('canvas');
      cv.width = 2; cv.height = 2;
      var attr = { alpha: true, antialias: false, depth: false, stencil: false,
                   premultipliedAlpha: true, preserveDrawingBuffer: false,
                   powerPreference: 'high-performance' };
      var gl = cv.getContext('webgl', attr) || cv.getContext('experimental-webgl', attr);
      if (!gl) { GLX.dead = true; return; }
      cv.addEventListener('webglcontextlost', function (e) {
        e.preventDefault();
        GLX.dead = true; GLX.ready = false;
      });
      var pr = gl.createProgram();
      gl.attachShader(pr, glShader(gl, gl.VERTEX_SHADER, GL_VS));
      gl.attachShader(pr, glShader(gl, gl.FRAGMENT_SHADER, GL_FS));
      gl.bindAttribLocation(pr, 0, 'p');
      gl.linkProgram(pr);
      GLX.cv = cv; GLX.gl = gl; GLX.prog = pr;
      GLX.ext = gl.getExtension('KHR_parallel_shader_compile') || null;
    } catch (e) { GLX.dead = true; }
  }
  /* Never a synchronous LINK_STATUS read on the first frame (the wave-4
     lesson: it blocked for seconds mid-cinematic and read as a camera pop).
     With the extension we poll; without it we simply let a couple of frames
     go by on the CPU path first, which is the same idea more bluntly. */
  function glReady() {
    if (GLX.dead || !GLX.on) return false;
    if (GLX.ready) return true;
    if (!GLX.tried) glInit();
    if (GLX.dead || !GLX.gl || !GLX.prog) return false;
    var gl = GLX.gl;
    try {
      if (GLX.ext) {
        if (!gl.getProgramParameter(GLX.prog, GLX.ext.COMPLETION_STATUS_KHR)) return false;
      } else if (GLX.frames++ < 3) return false;
      if (!gl.getProgramParameter(GLX.prog, gl.LINK_STATUS)) { GLX.dead = true; return false; }
      gl.useProgram(GLX.prog);
      GLX.buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, GLX.buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      GLX.u = {};
      ['uFwd', 'uRgt', 'uUp', 'uHole', 'uBg', 'uTan', 'uP', 'uHasSky', 'uSky', 'uLutT']
        .forEach(function (k) { GLX.u[k] = gl.getUniformLocation(GLX.prog, k); });
      GLX.skyTex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, GLX.skyTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      GLX.lutTex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, GLX.lutTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.uniform1i(GLX.u.uSky, 0);
      gl.uniform1i(GLX.u.uLutT, 1);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      GLX.ready = true;
      return true;
    } catch (e2) { GLX.dead = true; return false; }
  }
  function pot(v) { return v > 0 && (v & (v - 1)) === 0; }
  function glSky(skyCanvas) {
    var gl = GLX.gl;
    if (!skyCanvas || !skyCanvas.width || !skyCanvas.height) return false;
    /* the u axis must WRAP, and WebGL1 only wraps powers of two. The page's
       own bake is 2048 or 1024 wide, so this only ever bites a caller that
       hands us something else, and that caller gets the CPU path. */
    if (!pot(skyCanvas.width) || !pot(skyCanvas.height)) return false;
    if (GLX.skySrc === skyCanvas && GLX.skyW === skyCanvas.width &&
        GLX.skyH === skyCanvas.height) return true;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, GLX.skyTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, skyCanvas);
    GLX.skySrc = skyCanvas; GLX.skyW = skyCanvas.width; GLX.skyH = skyCanvas.height;
    return true;
  }
  function enc16(arr, off, v) {
    var q = clamp01(v) * 65535;
    var hi = Math.floor(q / 256);
    if (hi > 255) hi = 255;
    var lo = Math.round(q - hi * 256);
    if (lo > 255) lo = 255;
    arr[off] = hi; arr[off + 1] = lo;
  }
  function glLut(lut, key) {
    var gl = GLX.gl, n = lut.n, i;
    if (GLX.lutSeq === lut.seq && GLX.lutKey === key && GLX.lutN === n) return;
    if (!GLX.lutPix || GLX.lutPix.length !== n * 8) GLX.lutPix = new Uint8Array(n * 8);
    var px = GLX.lutPix;
    for (i = 0; i < n; i++) {
      enc16(px, i * 4, (PREP.cosOut[i] + 1) * 0.5);
      enc16(px, i * 4 + 2, (PREP.sinOut[i] + 1) * 0.5);
      enc16(px, (n + i) * 4, PREP.amp[i] / GL_AMP_SCALE);
      enc16(px, (n + i) * 4 + 2, PREP.tint[i] / GL_TINT_SCALE);
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, GLX.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, n, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    GLX.lutSeq = lut.seq; GLX.lutKey = key; GLX.lutN = n;
  }
  /* Returns true when the frame was drawn on the GPU. Any failure at all
     leaves the caller's canvas untouched and returns false, so the 2D loop
     runs instead and the reader never sees a hole in the picture. */
  function glLensed(ctx2d, lut, skyCanvas, o, iw, ih, W, H, key) {
    if (!glReady()) return false;
    var gl = GLX.gl;
    try {
      if (GLX.w !== iw || GLX.h !== ih) {
        GLX.cv.width = iw; GLX.cv.height = ih;
        GLX.w = iw; GLX.h = ih;
        gl.viewport(0, 0, iw, ih);
      }
      var haveSky = glSky(skyCanvas) ? 1 : 0;
      glLut(lut, key);
      var u = GLX.u, fov = o.fov, aspect = W / H;
      gl.useProgram(GLX.prog);
      gl.uniform3f(u.uFwd, o.fwd[0], o.fwd[1], o.fwd[2]);
      gl.uniform3f(u.uRgt, o.rgt[0], o.rgt[1], o.rgt[2]);
      gl.uniform3f(u.uUp, o.up[0], o.up[1], o.up[2]);
      gl.uniform3f(u.uHole, o.hx, o.hy, o.hz);
      gl.uniform3f(u.uBg, o.bgR / 255, o.bgG / 255, o.bgB / 255);
      gl.uniform2f(u.uTan, fov * aspect, fov);
      /* every row captured means there is no sky at all from here: hand the
         shader a cone that covers the whole frame rather than a row index
         past the end of the table */
      var allDark = lut.firstLive >= lut.n;
      gl.uniform4f(u.uP, lut.n, allDark ? lut.n - 1 : lut.firstLive,
                   allDark ? PI : lut.shadowRad, o.gain);
      gl.uniform1f(u.uHasSky, haveSky);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      /* the blit rides in the SAME task as the draw: with no preserved
         drawing buffer, one yield to the compositor and this canvas is
         empty */
      var sm = ctx2d.imageSmoothingEnabled;
      ctx2d.imageSmoothingEnabled = true;
      ctx2d.drawImage(GLX.cv, 0, 0, iw, ih, 0, 0, W, H);
      ctx2d.imageSmoothingEnabled = sm;
      return true;
    } catch (e) { GLX.dead = true; return false; }
  }

  /* ---------------- fast trig for the per-pixel loops ----------------
     Measured in the target browser, Math.acos and Math.atan2 cost about 73
     and 83 ns each, and the lens loop needs three transcendentals per pixel;
     at 70,000 pixels that alone is 15 ms. These two approximations are the
     standard polynomial forms and their error is far below one texel:
       fastAcos  max error 7e-5 rad (a LUT row is 8e-3 rad wide)
       fastAtan2 max error 2e-4 rad (2048-wide equirect texel = 3e-3 rad)
     Nothing PHYSICAL uses them: the geodesics, the shadow angle and the
     tables are all exact double precision. These only place a texel. */
  function fastAcos(x) {
    var neg = x < 0;
    if (neg) x = -x;
    if (x > 1) x = 1;
    var r = ((-0.0187293 * x + 0.0742610) * x - 0.2121144) * x + 1.5707288;
    r *= Math.sqrt(1 - x);
    return neg ? (PI - r) : r;
  }
  function fastAtan2(y, x) {
    var ax = x < 0 ? -x : x, ay = y < 0 ? -y : y;
    if (ax === 0 && ay === 0) return 0;
    var a = (ax > ay) ? (ay / ax) : (ax / ay);
    var s = a * a;
    var r = ((-0.0464964749 * s + 0.15931422) * s - 0.327622764) * s * a + a;
    if (ay > ax) r = 1.57079632679489661923 - r;
    if (x < 0) r = PI - r;
    return y < 0 ? -r : r;
  }

  /* Per-LUT-row scratch. Everything that depends only on the row is computed
     once per frame here instead of once per pixel: the sine and cosine of
     the sky angle, and the Doppler brightness and tint (two Math.pow calls
     that cost more than the texture fetch when left in the pixel loop). */
  var PREP = { seq: -1, key: '', n: 0, cosOut: null, sinOut: null,
               amp: null, tint: null, itint: null };
  function prepRows(lut, dop, dpow, dLo, dHi) {
    var key = dop ? (dpow + '|' + dLo + '|' + dHi) : 'off';
    if (PREP.seq === lut.seq && PREP.key === key && PREP.n === lut.n) return;
    if (PREP.n !== lut.n || !PREP.cosOut) {
      PREP.cosOut = new Float64Array(lut.n);
      PREP.sinOut = new Float64Array(lut.n);
      PREP.amp = new Float64Array(lut.n);
      PREP.tint = new Float64Array(lut.n);
      PREP.itint = new Float64Array(lut.n);
      PREP.n = lut.n;
    }
    for (var i = 0; i < lut.n; i++) {
      var th = lut.thetaOut[i];
      if (!isFinite(th)) th = lut.thetaIn[i];
      PREP.cosOut[i] = Math.cos(th);
      PREP.sinOut[i] = Math.sin(th);
      var a = 1, t = 1;
      if (dop) {
        var g = lut.shift[i];
        if (!(g > 0) || !isFinite(g)) g = 1;
        /* A SOFT knee, not a clamp. Bolometric intensity really does scale
           as g^4 and g reaches 5 near the horizon, which is thousands of
           times more range than a screen holds; a hard clamp flattened the
           whole forward hemisphere to one flat colour and threw the
           gradient away. This saturates toward the ceiling instead, so the
           direction of the effect stays readable everywhere. */
        a = Math.pow(g, dpow);
        if (a > 1) a = 1 + (a - 1) / (1 + (a - 1) / (dHi - 1));
        if (a < dLo) a = dLo;
        t = Math.pow(g, 0.4);
        if (t > 1) t = 1 + (t - 1) / (1 + (t - 1) / 0.55);
        if (t < 0.62) t = 0.62;
      }
      PREP.amp[i] = a;
      PREP.tint[i] = t;
      PREP.itint[i] = 1 / t;
    }
    PREP.seq = lut.seq;
    PREP.key = key;
  }

  /* ---------------- the internal-resolution governor ----------------
     Both renderers are O(pixels), so the honest way to survive a slow
     machine is to draw fewer of them and let the upscale carry the rest.
     Each keeps its own pixel budget, nudged by the time its LAST frame
     actually took. opts.auto = false pins whatever the caller asked for,
     and opts.maxPixels is always the ceiling.

     BHF-2: it starts AT the ceiling and only ever gives ground, which is the
     page's own governor philosophy (wave 5) and the opposite of what shipped.
     Starting low and ramping up meant the first half of the plunge, the half
     with the whole sky still in frame, was the blurriest half. And a single
     slow frame is not evidence of a slow machine: a demotion needs two in a
     row, so a stray hitch cannot cost the rest of the cinematic its
     resolution. Recovery is gradual and the ceiling is never exceeded. */
  var AUTO_START = { lens: 900000, disk: 120000 };
  var AUTO = { lens: AUTO_START.lens, disk: AUTO_START.disk };
  var AUTO_OVER = { lens: 0, disk: 0 };
  var AUTO_MIN = 6000;
  function autoPick(kind, ceil) {
    var v = AUTO[kind];
    if (!(v > 0)) v = ceil;
    if (v > ceil) v = ceil;
    if (v < AUTO_MIN) v = AUTO_MIN;
    return v;
  }
  function autoFeed(kind, ms, budget, ceil) {
    var v = AUTO[kind];
    if (!(ms >= 0) || !(budget > 0)) return;
    if (ms > budget * 3) {
      /* not a hitch, a wall: a machine with no GL at all starts at a
         resolution its CPU cannot hold, and waiting two frames to admit that
         costs two more frames of it */
      v *= 0.5; AUTO_OVER[kind] = 0;
    } else if (ms > budget * 1.25) {
      AUTO_OVER[kind]++;
      if (AUTO_OVER[kind] >= 2) { v *= 0.72; AUTO_OVER[kind] = 0; }
    } else {
      AUTO_OVER[kind] = 0;
      if (ms < budget * 0.7) v *= 1.12;
    }
    if (v < AUTO_MIN) v = AUTO_MIN;
    if (v > ceil) v = ceil;
    AUTO[kind] = v;
  }

  var LSTAT = { px: 0, ms: 0, scale: 1, dark: 0, gl: false };
  /* the GL call's option block, filled in place: a cinematic frame allocates
     nothing */
  var GLO = { fwd: null, rgt: null, up: null, hx: 0, hy: 0, hz: 0,
              bgR: 0, bgG: 0, bgB: 0, gain: 1, fov: 1 };

  function drawLensed(ctx2d, lut, skyCanvas, opts) {
    var t0 = nowMs();
    LSTAT.px = 0; LSTAT.ms = 0; LSTAT.scale = 1; LSTAT.dark = 0; LSTAT.gl = false;
    var o = opts || {};
    if (!ctx2d || !lut || !lut.valid) return LSTAT;
    var W = Math.max(1, num(o.w, ctx2d.canvas ? ctx2d.canvas.width : 1) | 0);
    var H = Math.max(1, num(o.h, ctx2d.canvas ? ctx2d.canvas.height : 1) | 0);
    var fwd = o.fwd, rgt = o.right, up = o.up, hole = o.hole;
    if (!fwd || !rgt || !up || !hole) return LSTAT;
    if (!(fin(fwd[0]) && fin(rgt[0]) && fin(up[0]) && fin(hole[0]))) return LSTAT;
    if (o.skyDirty === true) invalidateSky();

    /* internal resolution: quality scales it, maxPixels caps it, and the
       governor picks inside that unless the caller pinned it. Quality may go
       ABOVE 1: w and h arrive in CSS pixels, so a 2x screen has to ask for
       two internal pixels per CSS pixel or the lens is the one soft layer on
       a sharp display. */
    var q = clamp(num(o.quality, 0.5), 0.08, 4);
    var ceil = Math.max(4000, num(o.maxPixels, 120000));
    var budget = clamp(num(o.budgetMs, 12), 2, 200);
    var maxPx = (o.auto === false) ? ceil : autoPick('lens', ceil);
    var iw = Math.max(2, Math.round(W * q)), ih = Math.max(2, Math.round(H * q));
    if (iw * ih > maxPx) {
      var s = Math.sqrt(maxPx / (iw * ih));
      iw = Math.max(2, Math.round(iw * s));
      ih = Math.max(2, Math.round(ih * s));
    }

    var fov = clamp(num(o.fovDeg, 70), 10, 160) * DEG;
    var tanH = Math.tan(fov / 2);
    var aspect = W / H;
    var bg = o.bg || null;
    var bgR = bg ? num(bg[0], 0) : 0, bgG = bg ? num(bg[1], 0) : 0,
        bgB = bg ? num(bg[2], 0) : 0;
    var dop = o.doppler !== false && lut.mode === 'raindrop';
    var dpow = clamp(num(o.dopplerPow, 3), 0, 6);
    var dLo = clamp(num(o.dopplerMin, 0.25), 0.01, 1);
    var dHi = clamp(num(o.dopplerMax, 4), 1, 40);
    var gain = clamp(num(o.gain, 1), 0.05, 8);
    var fx = fwd[0], fy = fwd[1], fz = fwd[2];
    var rx = rgt[0], ry = rgt[1], rz = rgt[2];
    var ux = up[0],  uy = up[1],  uz = up[2];
    var hx = hole[0], hy = hole[1], hz = hole[2];
    var hn = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1;
    hx /= hn; hy /= hn; hz /= hn;
    var nLut = lut.n, fl = lut.firstLive;
    prepRows(lut, dop, dpow, dLo, dHi);

    /* the GPU first, the loop below as the fallback and the contract */
    if (o.gl !== false) {
      GLO.fwd = fwd; GLO.rgt = rgt; GLO.up = up;
      GLO.hx = hx; GLO.hy = hy; GLO.hz = hz;
      GLO.bgR = bgR; GLO.bgG = bgG; GLO.bgB = bgB;
      GLO.gain = gain; GLO.fov = tanH;
      if (glLensed(ctx2d, lut, skyCanvas, GLO, iw, ih, W, H,
                   dop ? (dpow + '|' + dLo + '|' + dHi) : 'off')) {
        LSTAT.px = iw * ih;
        LSTAT.scale = iw / W;
        LSTAT.gl = true;
        LSTAT.ms = nowMs() - t0;
        if (o.auto !== false) autoFeed('lens', LSTAT.ms, budget, ceil);
        return LSTAT;
      }
    }
    var haveSky = ensureSky(skyCanvas);
    if (!ensureBuf(LB, iw, ih)) return LSTAT;
    LSTAT.scale = iw / W;
    var data = LB.img.data;
    var cosO = PREP.cosOut, sinO = PREP.sinOut;
    var ampA = PREP.amp, tintA = PREP.tint, itintA = PREP.itint;
    var shadow = lut.shadowRad;
    var rowK = nLut / PI;
    var allDark = fl >= nLut;
    var skyW = SKY.w, skyH = SKY.h, skyD = SKY.data;
    var dark = 0, p = 0, px = 0, py = 0;

    for (py = 0; py < ih; py++) {
      var sy = (1 - 2 * (py + 0.5) / ih) * tanH;
      for (px = 0; px < iw; px++) {
        var sx = (2 * (px + 0.5) / iw - 1) * tanH * aspect;
        var dx = fx + rx * sx + ux * sy;
        var dy = fy + ry * sx + uy * sy;
        var dz = fz + rz * sx + uz * sy;
        var dn = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
        dx *= dn; dy *= dn; dz *= dn;
        var ca = dx * hx + dy * hy + dz * hz;
        if (ca > 1) ca = 1; else if (ca < -1) ca = -1;
        var alpha = fastAcos(ca);
        /* the dark test is the ANALYTIC cone, so the rim lands on the exact
           angle instead of the nearest sampled row */
        if (allDark || alpha <= shadow) {
          data[p] = bgR; data[p + 1] = bgG; data[p + 2] = bgB; data[p + 3] = 255;
          p += 4; dark++;
          continue;
        }
        var xi = alpha * rowK - 0.5;
        if (xi < fl) xi = fl; else if (xi > nLut - 1) xi = nLut - 1;
        var i0 = xi | 0, i1 = (i0 + 1 > nLut - 1) ? nLut - 1 : i0 + 1;
        var ft = xi - i0;
        var cs = cosO[i0] + (cosO[i1] - cosO[i0]) * ft;
        var sn = sinO[i0] + (sinO[i1] - sinO[i0]) * ft;

        /* rotate the hole direction by thetaOut inside the plane of this ray.
           d is a unit vector and h is a unit vector, so the transverse part
           has length sqrt(1 - ca^2) exactly and the rotated result is
           already unit: two square roots and a normalise fall out. */
        var tl = Math.sqrt(1 - ca * ca);
        var wx, wy, wz;
        if (tl > 1e-9) {
          var it = 1 / tl;
          wx = hx * cs + (dx - ca * hx) * it * sn;
          wy = hy * cs + (dy - ca * hy) * it * sn;
          wz = hz * cs + (dz - ca * hz) * it * sn;
        } else {
          wx = hx * cs + rx * sn; wy = hy * cs + ry * sn; wz = hz * cs + rz * sn;
        }

        var r = 0, g = 0, b = 0;
        if (haveSky) {
          if (wz > 1) wz = 1; else if (wz < -1) wz = -1;
          var uu = (fastAtan2(wy, wx) + PI) * (1 / TWO_PI);
          var vv = fastAcos(wz) * (1 / PI);
          /* bilinear equirect fetch, wrapping in u and clamping in v */
          var fxs = uu * skyW - 0.5, fys = vv * skyH - 0.5;
          var X0 = Math.floor(fxs), Y0 = Math.floor(fys);
          var gx = fxs - X0, gy = fys - Y0;
          var X1 = X0 + 1, Y1 = Y0 + 1;
          X0 = X0 % skyW; if (X0 < 0) X0 += skyW;
          X1 = X1 % skyW; if (X1 < 0) X1 += skyW;
          if (Y0 < 0) Y0 = 0; else if (Y0 > skyH - 1) Y0 = skyH - 1;
          if (Y1 < 0) Y1 = 0; else if (Y1 > skyH - 1) Y1 = skyH - 1;
          var rowA = Y0 * skyW, rowB = Y1 * skyW;
          var qa = (rowA + X0) * 4, qb = (rowA + X1) * 4;
          var qc = (rowB + X0) * 4, qd = (rowB + X1) * 4;
          var w00 = (1 - gx) * (1 - gy), w10 = gx * (1 - gy);
          var w01 = (1 - gx) * gy, w11 = gx * gy;
          r = skyD[qa] * w00 + skyD[qb] * w10 + skyD[qc] * w01 + skyD[qd] * w11;
          g = skyD[qa + 1] * w00 + skyD[qb + 1] * w10 + skyD[qc + 1] * w01 + skyD[qd + 1] * w11;
          b = skyD[qa + 2] * w00 + skyD[qb + 2] * w10 + skyD[qc + 2] * w01 + skyD[qd + 2] * w11;
        }
        var amp = gain * (ampA[i0] + (ampA[i1] - ampA[i0]) * ft);
        if (dop) {
          var ti = itintA[i0] + (itintA[i1] - itintA[i0]) * ft;
          var tb = tintA[i0] + (tintA[i1] - tintA[i0]) * ft;
          r *= ti; b *= tb;
        }
        r *= amp; g *= amp; b *= amp;
        data[p]     = r > 255 ? 255 : (r < 0 ? 0 : r);
        data[p + 1] = g > 255 ? 255 : (g < 0 ? 0 : g);
        data[p + 2] = b > 255 ? 255 : (b < 0 ? 0 : b);
        data[p + 3] = 255;
        p += 4;
      }
    }
    LB.ctx.putImageData(LB.img, 0, 0);
    if (fin(W) && fin(H) && W > 0 && H > 0) {
      var sm = ctx2d.imageSmoothingEnabled;
      ctx2d.imageSmoothingEnabled = true;
      ctx2d.drawImage(LB.cv, 0, 0, iw, ih, 0, 0, W, H);
      ctx2d.imageSmoothingEnabled = sm;
    }
    LSTAT.px = iw * ih;
    LSTAT.dark = dark;
    LSTAT.ms = nowMs() - t0;
    if (o.auto !== false) autoFeed('lens', LSTAT.ms, budget, ceil);
    return LSTAT;
  }

  /* ==========================================================================
     THE ACCRETION FLOW

     An analytic equatorial annulus from the ISCO outward, sampled through the
     SAME LUT: each ray already carries r(phi), so the equatorial crossings
     are found geometrically. The point at swept angle phi along a ray sits in
     the direction cos(phi) * rHat + sin(phi) * tHat, so it lies in the disk
     plane when
        cos(phi) (rHat . nHat) + sin(phi) (tHat . nHat) = 0,
     which is one angle phi_c in [0, pi) and its partner phi_c + pi. The first
     crossing is the direct (n = 0) image, the second is the first photon-ring
     echo (n = 1). Higher orders are demagnified by about e^-pi each and are
     not drawn: they would be invented detail.

     Shading. For a Keplerian circular orbit at r (Schwarzschild),
        u^t = 1 / sqrt(1 - 3 r_g / r),   Omega = sqrt(GM / r^3)
     and the emitted-to-observed frequency ratio is
        g = g_obs / (u^t (1 - Omega L_z / E))
     with g_obs the observer factor the LUT carries and L_z / E the photon's
     angular momentum about the DISK axis, which is b times the cosine
     between the ray plane's normal and the disk normal. Bolometric intensity
     scales as g^4. The default brightness is deliberately faint: the real
     Sgr A* radiates under one hundred-millionth of its Eddington luminosity
     and there is no published visible-light brightness for it, so the
     brighten control is drama and the copy says so.
     ========================================================================== */
  var DSTAT = { px: 0, ms: 0, hits: 0 };

  /* How much a crossing at swept angle phi is demagnified, tabulated.

     Gralla / Lupsasca: an image order is demagnified by e^-gamma with
     gamma = pi for a non-spinning hole, so the first photon-ring echo comes
     in at about 4 percent of its parent and every order after that is
     invisible. Written as exp(-(phi - pi)) for phi past half a turn, that
     same rule is CONTINUOUS in phi: it hands the famous over-the-top arc
     (which is still the first crossing, just bent) its full brightness and
     fades a ray in smoothly as it winds. Indexing it by a hard image number
     instead put a factor-of-23 step exactly where phi crosses pi.

     The second factor is the near ramp, and it is deliberately NARROW. A
     geometrically thin disk is a singular object for a camera sitting IN its
     plane: every ray satisfies the crossing equation at phi = 0, its own
     position. Fading the first 0.06 rad removes that singular line; a wider
     ramp cut a visible dark wedge across the flow along the plane, which is
     exactly the direction that should be BRIGHTEST from inside it. */
  var DIM_N = 192;
  var DIM_TAB = new Float64Array(DIM_N + 1);
  (function () {
    for (var i = 0; i <= DIM_N; i++) {
      var phi = PHI_PROF_MAX * i / DIM_N;
      var near = clamp01(phi / 0.06);
      near = near * near * (3 - 2 * near);
      DIM_TAB[i] = near * Math.exp(-Math.max(0, phi - PI));
    }
  })();
  function dimAt(phi) {
    var x = phi * DIM_N / PHI_PROF_MAX;
    if (!(x > 0)) return 0;
    if (x >= DIM_N) return DIM_TAB[DIM_N];
    var k = x | 0;
    return DIM_TAB[k] + (DIM_TAB[k + 1] - DIM_TAB[k]) * (x - k);
  }

  /* the Keplerian redshift factor. rRs in r_s, lz = L_z/E about the disk
     axis in r_s, gObs the observer's own factor from the LUT. */
  function diskG(rRs, lz, gObs) {
    var r = num(rRs, 0);
    if (!(r > 1.5)) return 0;                 /* no circular orbits inside 3 r_g */
    var u_t = 1 / Math.sqrt(1 - 1.5 / r);     /* 1 - 3 r_g / r = 1 - 1.5 r_s / r */
    /* Omega in geometric units where r is in r_s: Omega = sqrt(r_g/r^3) c/r_s
       and L_z/E is in r_s, so the product Omega * L_z is dimensionless with
       Omega_rs = sqrt(0.5 / r^3). */
    var om = Math.sqrt(0.5 / (r * r * r));
    var den = u_t * (1 - om * lz);
    if (!(Math.abs(den) > 1e-6)) return 0;
    return num(gObs, 1) / den;
  }

  /* Per-row scratch for the flow: the impact parameter of every table row.
     It used to be two transcendentals per pixel per crossing inside the
     pixel loop, which was most of what the flow cost, and it depends on
     nothing but the row. */
  var DPREP = { seq: -1, n: 0, b: null };
  function prepDisk(lut) {
    if (DPREP.seq === lut.seq && DPREP.n === lut.n && DPREP.b) return;
    if (DPREP.n !== lut.n || !DPREP.b) {
      DPREP.b = new Float64Array(lut.n);
      DPREP.n = lut.n;
    }
    var stat = 1 / Math.sqrt(Math.max(1e-9, 1 - 1 / lut.rRs));
    for (var i = 0; i < lut.n; i++) {
      var a = lut.thetaIn[i];
      if (lut.beta > 0) {
        var den = 1 - lut.beta * Math.cos(a);
        DPREP.b[i] = (den > 1e-6) ? lut.rRs * Math.sin(a) / den : 0;
      } else {
        DPREP.b[i] = lut.rRs * Math.sin(a) * stat;
      }
    }
    DPREP.seq = lut.seq;
  }

  function drawDisk(ctx2d, lut, opts) {
    var t0 = nowMs();
    DSTAT.px = 0; DSTAT.ms = 0; DSTAT.hits = 0;
    var o = opts || {};
    if (!ctx2d || !lut || !lut.valid) return DSTAT;
    var W = Math.max(1, num(o.w, ctx2d.canvas ? ctx2d.canvas.width : 1) | 0);
    var H = Math.max(1, num(o.h, ctx2d.canvas ? ctx2d.canvas.height : 1) | 0);
    var fwd = o.fwd, rgt = o.right, up = o.up, hole = o.hole, nrm = o.normal;
    if (!fwd || !rgt || !up || !hole || !nrm) return DSTAT;
    if (!(fin(fwd[0]) && fin(rgt[0]) && fin(up[0]) && fin(hole[0]) && fin(nrm[0])))
      return DSTAT;

    var q = clamp(num(o.quality, 0.5), 0.05, 1);
    var ceil = Math.max(1500, num(o.maxPixels, 90000));
    var budget = clamp(num(o.budgetMs, 6), 1, 200);
    var maxPx = (o.auto === false) ? ceil : autoPick('disk', ceil);
    var iw = Math.max(2, Math.round(W * q)), ih = Math.max(2, Math.round(H * q));
    if (iw * ih > maxPx) {
      var s = Math.sqrt(maxPx / (iw * ih));
      iw = Math.max(2, Math.round(iw * s));
      ih = Math.max(2, Math.round(ih * s));
    }
    if (!ensureBuf(DB, iw, ih)) return DSTAT;

    var fov = clamp(num(o.fovDeg, 70), 10, 160) * DEG;
    var tanH = Math.tan(fov / 2), aspect = W / H;
    var rIn = clamp(num(o.rInRs, 3), 1.0, 1e4);          /* ISCO = 3 r_s */
    var rOut = clamp(num(o.rOutRs, 40), rIn + 0.5, 1e5);
    var uIn = 1 / rIn, uOut = 1 / rOut;   /* the annulus, in the profile's u */
    /* BHF-1: the annulus has FEATHERED edges, and that is what killed the
       stair-stepped wedge across the shadow. A hard cut at the ISCO puts a
       step discontinuity in the picture; drawn at a reduced internal
       resolution and blown back up, a step becomes a staircase, and the
       staircase sat right where the flow crosses in front of the shadow.
       Inside, the emission fades out over half a Schwarzschild radius as the
       gas gives up its circular orbit and starts falling; outside, the flow
       thins away over the last quarter of its span. Both are smoothstep
       ramps in u, which is what the profile is stored in. */
    var uInF = 1 / (rIn + 0.5);
    var uOutF = 1 / (rOut * 0.75);
    var kIn = (uIn > uInF) ? 1 / (uIn - uInF) : 0;
    var kOut = (uOutF > uOut) ? 1 / (uOutF - uOut) : 0;
    var bright = clamp(num(o.brighten, 1), 0.05, 40);
    /* the faint default: a thin flow that reads as a suggestion, not a lamp */
    var base = clamp(num(o.base, 0.11), 0.005, 1) * bright;
    var hotOn = o.hotspot === true;
    var hotPhase = num(o.hotPhase, 0);       /* radians; the caller advances it
                                                at the TRUE 45-minute period */
    var hotR = clamp(num(o.hotRRs, 4.5), rIn, rOut);   /* 9 r_g = 4.5 r_s */
    var hotW = clamp(num(o.hotWidth, 0.55), 0.05, PI);

    var data = DB.img.data;
    var fx = fwd[0], fy = fwd[1], fz = fwd[2];
    var rx = rgt[0], ry = rgt[1], rz = rgt[2];
    var ux = up[0], uy = up[1], uz = up[2];
    var hx = hole[0], hy = hole[1], hz = hole[2];
    var hnn = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1;
    hx /= hnn; hy /= hnn; hz /= hnn;
    var nx = nrm[0], ny = nrm[1], nz = nrm[2];
    var nnn = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= nnn; ny /= nnn; nz /= nnn;
    /* rHat points from the hole to the camera, which is -hole */
    var pr = -(hx * nx + hy * ny + hz * nz);
    var nLut = lut.n, shA = lut.shift;
    prepDisk(lut);
    var bA = DPREP.b;
    var hits = 0, p = 0, px, py, k;

    for (py = 0; py < ih; py++) {
      var sy = (1 - 2 * (py + 0.5) / ih) * tanH;
      for (px = 0; px < iw; px++) {
        var sx = (2 * (px + 0.5) / iw - 1) * tanH * aspect;
        var dx = fx + rx * sx + ux * sy;
        var dy = fy + ry * sx + uy * sy;
        var dz = fz + rz * sx + uz * sy;
        var dn = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        dx /= dn; dy /= dn; dz /= dn;
        var ca = dx * hx + dy * hy + dz * hz;
        if (ca > 1) ca = 1; else if (ca < -1) ca = -1;
        var alpha = fastAcos(ca);
        var xi = alpha * nLut / PI - 0.5;
        if (xi < 0) xi = 0; else if (xi > nLut - 1) xi = nLut - 1;
        /* the row's own quantities are INTERPOLATED, not snapped to the
           nearest row: snapping put a visible facet every table row across a
           smooth flow, which the low internal resolution then squared off */
        var ri0 = xi | 0, ri1 = (ri0 + 1 > nLut - 1) ? nLut - 1 : ri0 + 1;
        var rft = xi - ri0;

        var accR = 0, accG = 0, accB = 0;
        {
          /* Captured rows are sampled too, and on purpose: a ray that ends
             inside the horizon can still cross the disk plane on the way in,
             which is exactly how the flow is seen in FRONT of the shadow.
             Past the end of a ray the stored u says "inside the hole" or
             "infinitely far", and neither carries material. */
          /* transverse unit vector of this ray's plane */
          var tx = dx - ca * hx, ty = dy - ca * hy, tz = dz - ca * hz;
          var tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
          if (tl > 1e-9) {
            tx /= tl; ty /= tl; tz /= tl;
            var pt = tx * nx + ty * ny + tz * nz;
            /* cos(phi) pr + sin(phi) pt = 0, solved on (0, pi]. The lower
               bound is NOT decoration: phi = 0 is the camera's own position,
               and when the camera sits in the disk plane every single ray
               satisfies the equation there, which used to paint the whole
               frame with flow instead of a band. The real crossings along
               the ray are the first positive solution and its partner half a
               turn later. */
            var phiC = fastAtan2(-pr, pt);
            while (phiC <= 1e-4) phiC += PI;
            while (phiC > PI + 1e-4) phiC -= PI;
            /* the ray plane's normal, for the photon angular momentum sign.
               The backward trace sweeps rHat toward tHat, so the FORWARD
               photon carries angular momentum along tHat x rHat. */
            var rhx = -hx, rhy = -hy, rhz = -hz;
            var lx = ty * rhz - tz * rhy;
            var ly = tz * rhx - tx * rhz;
            var lz3 = tx * rhy - ty * rhx;
            var cosLN = lx * nx + ly * ny + lz3 * nz;
            var gObs = shA[ri0] + (shA[ri1] - shA[ri0]) * rft;
            /* impact parameter of this ray, from its LUT row: it is the
               photon's total L/E, and its component about the disk axis is
               what the orbiting gas Doppler-shifts against */
            var bb = bA[ri0] + (bA[ri1] - bA[ri0]) * rft;
            for (k = 0; k < 2; k++) {
              var phi = phiC + k * PI;
              /* blended across BOTH the phi grid and the neighbouring rows:
                 nearest-row sampling dithered the inner edge of the flow */
              var uu2 = lutUAt(lut, xi, phi);
              if (!(uu2 > uOut) || uu2 >= uIn) continue;
              /* the feathered edges (BHF-1) */
              var wEdge = 1, qe;
              if (uu2 > uInF) { qe = (uIn - uu2) * kIn; wEdge = qe * qe * (3 - 2 * qe); }
              if (uu2 < uOutF && kOut > 0) {
                qe = (uu2 - uOut) * kOut;
                wEdge *= qe * qe * (3 - 2 * qe);
              }
              if (!(wEdge > 0)) continue;
              var rr = 1 / uu2;
              var lzAx = bb * cosLN;
              var gg = diskG(rr, lzAx, gObs);
              if (!(gg > 0) || !isFinite(gg)) continue;
              /* Radial falloff of the flow (an illustrative r^-3/2 profile,
                 written as x sqrt(x) to keep Math.pow out of the pixel
                 loop), times the g^4 beaming, times the e^-pi
                 demagnification that separates the first photon-ring echo
                 from the direct image. The beaming ceiling is a SOFT knee
                 for the same reason the sky's is: a hard clamp flattened
                 whole regions to one value and drew a hard boundary around
                 them, which the upscale then turned into a staircase. */
              var xr = rIn / rr;
              var prof = xr * Math.sqrt(xr);
              var g4 = gg * gg * gg * gg;
              if (g4 > 3) g4 = 3 + (g4 - 3) / (1 + (g4 - 3) / 3);
              var amp = base * prof * g4 * dimAt(phi) * wEdge;
              if (hotOn) {
                /* one compact spot, near 9 gravitational radii. It advances
                   at its TRUE period, so it barely moves during a cinematic;
                   that is the honest choice. */
                var dR = (rr - hotR) / (0.6 * hotR);
                if (Math.abs(dR) < 1) {
                  var da = (phi - hotPhase) % TWO_PI;
                  if (da > PI) da -= TWO_PI; else if (da < -PI) da += TWO_PI;
                  if (Math.abs(da) < hotW) {
                    var fall = (1 - Math.abs(da) / hotW) * (1 - Math.abs(dR));
                    amp *= 1 + 2.2 * fall * fall;
                  }
                }
              }
              if (!(amp > 0)) continue;
              /* a warm flow, cooled or heated by the same g the shading uses */
              var tw = clamp(gg, 0.45, 2.2);
              accR += amp * 255 * clamp(1.0 / tw, 0.25, 1.6);
              accG += amp * 205 * clamp(1.0 / Math.sqrt(tw), 0.3, 1.5);
              accB += amp * 150 * clamp(tw, 0.3, 1.8);
              hits++;
            }
          }
        }
        data[p]     = accR > 255 ? 255 : (accR < 0 ? 0 : accR);
        data[p + 1] = accG > 255 ? 255 : (accG < 0 ? 0 : accG);
        data[p + 2] = accB > 255 ? 255 : (accB < 0 ? 0 : accB);
        data[p + 3] = 255;
        p += 4;
      }
    }
    DB.ctx.putImageData(DB.img, 0, 0);
    var op = ctx2d.globalCompositeOperation;
    var sm = ctx2d.imageSmoothingEnabled;
    ctx2d.globalCompositeOperation = 'lighter';
    ctx2d.imageSmoothingEnabled = true;
    ctx2d.drawImage(DB.cv, 0, 0, iw, ih, 0, 0, W, H);
    ctx2d.globalCompositeOperation = op;
    ctx2d.imageSmoothingEnabled = sm;
    DSTAT.px = iw * ih;
    DSTAT.hits = hits;
    DSTAT.ms = nowMs() - t0;
    if (o.auto !== false) autoFeed('disk', DSTAT.ms, budget, ceil);
    return DSTAT;
  }

  /* ==========================================================================
     THE bhfall PHASE TABLE

     Same shape as PURE.CRUISE_PHASES, and read the same way: tSec is the
     SCALED clock the page accumulates (tScaled += dtReal * timeScale), so a
     slider at 2.5 runs the whole thing in 20 s and 0.4 stretches it to 126 s.
     timeScale is passed in only so the caption reading floor and the
     "running true" flag can be honest about it.

     Radius. The depicted trajectory is a radial fall from REST at the parked
     standoff, r0 = 1000 AU = 11,789 r_s, which takes 2.70 years of proper
     time (the exact GR answer for infall from rest equals the Newtonian
     free-fall time, and that is where the caption's "almost three years"
     comes from). Approach and photon-sphere beats compress those years into
     seconds and the caption says so out loud. From the horizon inward the
     clock runs TRUE: the interior beat is (4/3) GM/c^3 = 28.2 s long and the
     radius is driven by proper time, r/r_s = (tau_left / tau_horizon)^(2/3),
     which is the exact E = 1 relation. Our trajectory differs from E = 1 by
     4e-5 at this r0 (the cycloid puts the horizon at 28.21 s against the
     pinned 28.22 s), which no readout can show.

     pi GM/c^3 = 66.5 s is the longest ANY trajectory survives inside; it is
     quoted only in the interior caption, as "nobody gets more than about a
     minute".
     ========================================================================== */
  var PARK_RS = PARK_AU / RS_AU;             /* 11,789 r_s */
  var PH_APPROACH_MS = 10000;
  var PH_PHOTON_MS = 5000;
  var PH_PLUNGE_MS = 3500;
  var PH_INTERIOR_MS = Math.round(TAU_HORIZON * 1000);   /* 28,220 ms, 1:1 */
  var PH_END_MS = 3500;

  var PHASES = [
    { name: 'approach', ms: PH_APPROACH_MS },   /* parked standoff to 30 r_s */
    { name: 'photon',   ms: PH_PHOTON_MS },     /* 30 r_s to the photon sphere */
    { name: 'plunge',   ms: PH_PLUNGE_MS },     /* 1.5 r_s to the horizon */
    { name: 'interior', ms: PH_INTERIOR_MS },   /* horizon to the end, true rate */
    { name: 'end',      ms: PH_END_MS }
  ];
  var TOTAL_MS = PH_APPROACH_MS + PH_PHOTON_MS + PH_PLUNGE_MS +
                 PH_INTERIOR_MS + PH_END_MS;
  var R_PHOTON_HANDOFF = 30;                  /* r_s where the approach ends */

  function phaseStart(name) {
    var acc = 0;
    for (var i = 0; i < PHASES.length; i++) {
      if (PHASES[i].name === name) return acc;
      acc += PHASES[i].ms;
    }
    return -1;
  }

  /* Proper time still to come, in seconds, for a fall that started from rest
     at PARK_AU. Cycloid solution: r = (r0/2)(1 + cos eta), and the time from
     r to the centre is sqrt(r0^3 / 8GM) (pi - eta - sin eta). */
  var T0_FALL = Math.sqrt(Math.pow(PARK_AU * AU_M, 3) / (8 * GM_M3S2));
  function tauRemainSec(rAu) {
    var r = num(rAu, 0);
    if (!(r > 0)) return 0;
    /* A fall from rest leaves r like sqrt(t), so the elapsed time near the
       release point is proportional to sqrt(r0 - r): the last few bits of
       floating point in r0 turn into whole SECONDS of apparent elapsed time.
       Snapping the top of the range keeps "we have not left yet" honest. */
    if (r > PARK_AU * (1 - 1e-9)) r = PARK_AU;
    var eta = Math.acos(clamp(2 * r / PARK_AU - 1, -1, 1));
    return T0_FALL * (PI - eta - Math.sin(eta));
  }
  /* the pinned rest-at-infinity form, which the node suite anchors on */
  function tauOfR(rRs) {
    var r = num(rRs, 0);
    if (!(r > 0)) return 0;
    return (4 / 3) * Math.pow(r, 1.5) * GM_C3;
  }
  function fallTauYears(rAu) { return tauRemainSec(rAu) / YEAR_S; }

  /* ---------------- captions: VERBATIM from the spec copy section ----------
     The alt rungs drop whole trailing sentences and never reword, so every
     string a reader can see is one the spec pinned. hudLine picks the
     longest rung that fits. */
  var CAPTIONS = [
    { t: 900, ms: 5200, phase: 'approach',
      text: 'Falling from this far takes almost three years. We play the years in seconds. The last half minute runs true.',
      two: ['Falling from this far takes almost three years.',
            'We play the years in seconds. The last half minute runs true.'],
      alt: ['Falling from this far takes almost three years. We play the years in seconds. The last half minute runs true.',
            'Falling from this far takes almost three years. We play the years in seconds.',
            'Falling from this far takes almost three years.'] },
    { t: 10400, ms: 4600, phase: 'photon',
      text: 'The dark circle is not a surface. It is the absence of paths light can take to your eye. The thin bright rim is the whole sky, bent around.',
      two: ['The dark circle is not a surface. It is the absence of paths light can take to your eye.',
            'The thin bright rim is the whole sky, bent around.'],
      alt: ['The dark circle is not a surface. It is the absence of paths light can take to your eye. The thin bright rim is the whole sky, bent around.',
            'The dark circle is not a surface. It is the absence of paths light can take to your eye.',
            'The dark circle is not a surface.'] },
    { t: 18600, ms: 4200, phase: 'interior',
      text: 'You just crossed the event horizon. Nothing marks it. Nothing snaps or flashes. The door simply closes behind you.',
      two: ['You just crossed the event horizon. Nothing marks it.',
            'Nothing snaps or flashes. The door simply closes behind you.'],
      alt: ['You just crossed the event horizon. Nothing marks it. Nothing snaps or flashes. The door simply closes behind you.',
            'You just crossed the event horizon. Nothing marks it. Nothing snaps or flashes.',
            'You just crossed the event horizon. Nothing marks it.',
            'You just crossed the event horizon.'] },
    { t: 23600, ms: 5600, phase: 'interior',
      text: 'The outside universe is still up there, dimmer and redder, and about 28 seconds remain on your clock. No engine can add to them. However you steer, nobody gets more than about a minute.',
      two: ['The outside universe is still up there, dimmer and redder, and about 28 seconds remain on your clock.',
            'No engine can add to them. However you steer, nobody gets more than about a minute.'],
      alt: ['The outside universe is still up there, dimmer and redder, and about 28 seconds remain on your clock. No engine can add to them. However you steer, nobody gets more than about a minute.',
            'The outside universe is still up there, dimmer and redder, and about 28 seconds remain on your clock. No engine can add to them.',
            'The outside universe is still up there, dimmer and redder, and about 28 seconds remain on your clock.'] },
    { t: 34500, ms: 5000, phase: 'interior',
      text: 'Gravity still pulls almost evenly across the ship. Only in the last instants does the difference grow enough to tear anything.',
      two: ['Gravity still pulls almost evenly across the ship.',
            'Only in the last instants does the difference grow enough to tear anything.'],
      alt: ['Gravity still pulls almost evenly across the ship. Only in the last instants does the difference grow enough to tear anything.',
            'Gravity still pulls almost evenly across the ship.'] },
    { t: 46900, ms: 3400, phase: 'end',
      text: 'This is as far as anyone can honestly draw. Your ship, of course, is still parked safely outside.',
      two: ['This is as far as anyone can honestly draw.',
            'Your ship, of course, is still parked safely outside.'],
      alt: ['This is as far as anyone can honestly draw. Your ship, of course, is still parked safely outside.',
            'This is as far as anyone can honestly draw.'] }
  ];

  var TS_MIN = 0.4, TS_MAX = 2.5;
  function clampTimeScale(v) {
    var n = num(v, 1);
    return n < TS_MIN ? TS_MIN : (n > TS_MAX ? TS_MAX : n);
  }
  /* the same reading floor voyage.js uses: a caption never gets less than
     1.8 real seconds on screen however fast the timeline runs */
  function captionMs(ms, scale) {
    return Math.max(1800, num(ms, 3200) / clampTimeScale(scale));
  }
  function captionAt(tSec, timeScale) {
    var m = num(tSec, 0) * 1000;
    var scale = clampTimeScale(timeScale);
    var best = null;
    for (var i = 0; i < CAPTIONS.length; i++) {
      var c = CAPTIONS[i];
      if (m >= c.t && m < c.t + c.ms * scale) best = c;
    }
    return best;
  }

  var POSE = {
    phase: 'approach', k: 0, frac: 0, rRs: PARK_RS, rAu: PARK_AU,
    tauSec: 0, tauLeftSec: 0, beta: 0, compressed: true, trueRate: false,
    caption: '', capIndex: -1, inside: false, done: false, ms: 0
  };

  function pose(tSec, timeScale) {
    var scale = clampTimeScale(timeScale);
    var m = num(tSec, 0) * 1000;
    if (m < 0) m = 0;
    var name = 'end', k = 1, acc = 0, i;
    var done = m >= TOTAL_MS;
    if (done) { name = 'end'; k = 1; }
    else {
      for (i = 0; i < PHASES.length; i++) {
        if (m < acc + PHASES[i].ms) { name = PHASES[i].name; k = (m - acc) / PHASES[i].ms; break; }
        acc += PHASES[i].ms;
      }
    }
    var rRs;
    if (name === 'approach') {
      /* geometric so the zoom rate reads as constant across four decades */
      rRs = PARK_RS * Math.pow(R_PHOTON_HANDOFF / PARK_RS, k);
    } else if (name === 'photon') {
      rRs = R_PHOTON_HANDOFF * Math.pow(1.5 / R_PHOTON_HANDOFF, k);
    } else if (name === 'plunge') {
      rRs = 1.5 * Math.pow(1 / 1.5, k);
    } else if (name === 'interior') {
      rRs = Math.pow(clamp01(1 - k), 2 / 3);
    } else {
      rRs = 0;
    }
    if (!(rRs >= 0)) rRs = 0;
    var rAu = rRs * RS_AU;
    var inside = rRs <= 1;
    /* Proper time still to come. Outside the horizon that is the cycloid for
       our own from-rest trajectory; inside it the beat IS the clock, so the
       readout comes straight off the beat and lands on the pinned 28.2 s. */
    var tauLeft;
    if (name === 'end') tauLeft = 0;
    else if (name === 'interior') tauLeft = TAU_HORIZON * clamp01(1 - k);
    else tauLeft = tauRemainSec(rAu);
    POSE.phase = name;
    POSE.k = clamp01(k);
    POSE.frac = clamp01(m / TOTAL_MS);
    POSE.rRs = rRs;
    POSE.rAu = rAu;
    POSE.ms = m;
    /* tauSec = proper time SINCE the release at 1000 AU (2.70 years for the
       whole fall), tauLeftSec = proper time still to come. The HUD wants the
       second one; the first is there so a readout can say how long the ship
       has been falling without redoing the cycloid. */
    POSE.tauLeftSec = tauLeft;
    POSE.tauSec = Math.max(0, FALL_SEC - tauLeft);
    POSE.beta = rRs > 0 ? Math.min(0.999, Math.sqrt(1 / Math.max(rRs, 1e-6))) : 0.999;
    POSE.inside = inside;
    POSE.compressed = (name === 'approach' || name === 'photon' || name === 'plunge');
    POSE.trueRate = (name === 'interior') && Math.abs(scale - 1) < 1e-6;
    POSE.done = done;
    var c = captionAt(m / 1000, scale);
    POSE.caption = c ? c.text : '';
    POSE.capIndex = c ? CAPTIONS.indexOf(c) : -1;
    return POSE;
  }

  /* ==========================================================================
     EXPORTS
     ========================================================================== */
  function lutProbe(rRs, alphaRad, mode) {
    var r = num(rRs, 6), a = num(alphaRad, 0.1);
    var isStatic = mode !== 'raindrop';
    if (isStatic && !(r > 1.0000001)) isStatic = false;
    var beta = Math.sqrt(1 / r);
    var bs = bOfAngle(r, a, beta, isStatic);
    if (!(bs.b >= 0)) {
      return { captured: true, thetaOut: NaN, b: -1, phiTotal: 0, steps: 0,
               shift: 1, mode: isStatic ? 'static' : 'raindrop' };
    }
    var res = traceRay(1 / r, Math.max(bs.b, 1e-9), bs.sgn, null, 0);
    return {
      captured: res.captured,
      thetaOut: res.captured ? NaN : (PI - res.phiTotal),
      phiTotal: res.phiTotal,
      b: bs.b,
      shift: bs.shift,
      steps: res.steps,
      mode: isStatic ? 'static' : 'raindrop'
    };
  }

  var VoyageBH = {
    SGRA: SGRA,
    SSTARS: SSTARS,
    FRAME: FRAME,
    toWorld: toWorld,
    starPos: starPos,
    orbitPath: orbitPath,
    precessArcmin: precessArcmin,

    buildLut: buildLut,
    lutLookup: lutLookup,
    lutRadiusAt: lutRadiusAt,
    lutUAt: lutUAt,
    shadowAngle: shadowAngle,
    skyUv: skyUv,
    drawLensed: drawLensed,
    drawDisk: drawDisk,
    invalidateSky: invalidateSky,

    PHASES: PHASES,
    TOTAL_MS: TOTAL_MS,
    CAPTIONS: CAPTIONS,
    pose: pose,
    captionAt: captionAt,
    captionMs: captionMs,
    phaseStart: phaseStart,
    clampTimeScale: clampTimeScale,

    __hooks: {
      lutProbe: lutProbe,
      tau: tauOfR,
      tauRemainSec: tauRemainSec,
      fallTauYears: fallTauYears,
      shadowAngle: shadowAngle,
      diskG: diskG,
      keplerE: keplerE,
      jdToYear: jdToYear,
      skyUv: skyUv,
      lutRadiusAt: lutRadiusAt,
      fastAcos: fastAcos,
      fastAtan2: fastAtan2,
      auto: function () { return { lens: AUTO.lens, disk: AUTO.disk }; },
      resetAuto: function () {
        AUTO.lens = AUTO_START.lens; AUTO.disk = AUTO_START.disk;
        AUTO_OVER.lens = 0; AUTO_OVER.disk = 0;
      },
      /* the GL fast path, for tests that need the CPU contract path or want
         to know which one drew the last frame */
      gl: function () {
        return { on: GLX.on, ready: GLX.ready, dead: GLX.dead, tried: GLX.tried };
      },
      setGl: function (v) {
        GLX.on = v !== false;
        if (GLX.on && !GLX.tried) glInit();
      },
      constants: {
        RS_M: RS_M, RG_M: RG_M, GM_M3S2: GM_M3S2, AU_M: AU_M,
        B_CRIT_RS: B_CRIT_RS, PARK_RS: PARK_RS, YEAR_S: YEAR_S,
        PHI_N: PHI_N, PHI_PROF_MAX: PHI_PROF_MAX, T0_FALL: T0_FALL
      }
    }
  };

  global.VoyageBH = VoyageBH;
  if (typeof module !== 'undefined' && module.exports) module.exports = VoyageBH;
})(typeof self !== 'undefined' ? self : globalThis);
