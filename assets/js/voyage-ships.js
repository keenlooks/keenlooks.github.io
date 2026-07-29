/* voyage-ships.js
   Nine parametric starships for /voyage/, drawn as stacked lathed cross sections
   so a yaw turntable reads as a real 3D object.

   Nine, because a ship is a DRIVE composed with a HULL and there are three of
   each. The drives are the page's existing acceleration row (ion 0.3 g, fusion
   1 g, antimatter 2 g) and the hulls are its existing mass row (probe, crewed
   ship, generation ship). Nothing about the trip maths, the energy line or the
   share hash changes: this file only draws the pair.

   Everything here is deterministic: the only time input is `t` (seconds) and every
   wobble comes from a hashed value-noise, never Math.random. No shadowBlur.
   Every gradient and arc argument is guarded, because one NaN into
   createRadialGradient throws and kills the page's animation loop for good.

   Contract (pinned in .claude/plans/plan-voyage-v2.md, extended by v3 section D6
   and by v4 section E1):
     VoyageShips.SHIPS                       ordered [ion, fusion, anti]
     VoyageShips.HULLS                       ordered [probe, crewed, generation]
     VoyageShips.CARDS                       nine {name,line}, keyed hull+'/'+drive
     VoyageShips.drawShip(ctx,x,y,px,yaw,opts)
     VoyageShips.drawChemPlume(ctx,x,y,px,ang,power,t)
     VoyageShips.drawShipTurntable(canvas2d,key,t,opts)
     VoyageShips.profileOf(key,hull)         same for rigsOf / emitOf / halfHeightOf
     VoyageShips.shipByKey(driveKey)         VoyageShips.hullByKey(hullKey)
     VoyageShips.shipCardOf(hull,drive)      -> { name, line }
     VoyageShips.__demo(canvas)

   SHIPS keeps its three drive rows and its three keys: the hull is a second,
   independent axis, never a fourth SHIPS entry. Every accessor takes the hull
   as an OPTIONAL trailing argument defaulting to 'crewed'.

   v2 opts (all optional): { key, thrust, t, quality, flip, light }
   v3 adds two, both with pinned defaults so an un-upgraded caller is unaffected:
     bank      roll about the ship's long axis, radians, default 0.
               Positive = right wing down. A surface of revolution does not
               change under roll, so bank moves only the things that sit off
               the axis: the radiator panels, the beacons, and every surface
               feature (seams, greebles, markings).
     lightDir  screen angle in radians pointing TOWARD the light, exactly the
               convention VoyageArt.drawPlanet uses. Default Math.PI, lit from
               screen left. Drives the hull shading gradient, the specular
               streak and the greeble shading.
   v4 adds two more, same rule:
     hull      'probe' | 'crewed' | 'generation'. Its PINNED DEFAULT is the
               whole wave-4 render: the crewed geometry, section for section
               and rig for rig, drawn with the wave-4 nav light and no gimbal.
               Anything that is not one of the three names (undefined, null,
               NaN, a typo) is that default, so a caller who never heard of
               hulls gets the ship it already had, to the pixel. Naming a hull
               selects it AND turns the wave-5 moving parts on, which is why
               `{}` and `{hull:'crewed'}` are deliberately not the same call:
               the geometry is identical, the motion is not.
     dishAim   where the probe's high-gain dish points, radians from the nose.
               Default Math.PI - 0.30, which is back along the route.

   Moving parts, all pure functions of `t` and all frozen at t = 0, which is the
   reduced-motion render (drawShipTurntable takes { still: true } for that):
     the generation ship's habitat ring turns, with spokes, modules and lit
     windows to make the turning visible; the probe's dish hunts a fraction of a
     degree around its aim; the engine bell gimbals with thrust and swings its
     own plume; radiators and accelerator grids brighten with thrust; the nav
     beacons blink on a 2.1 s period with a hashed per-beacon phase.

   Detail is procedural and scales with the drawn length O.L, so zooming the
   cruise rig in really does reveal more ship rather than a bigger blur:
     L <  14   a legible dart
     L >= 14   the lathed hull
     L >= 40   silhouette outlines
     L >= 56   quality 1 passes
     L >= 88   tier 1: panel seams, joint occlusion, specular streak
     L >= 150  tier 2: greebles, markings, radiator fins, hull emissives
     L >= 240  tier 3: fasteners, portholes, micro fins, seam highlights
*/
(function () {
  'use strict';

  var ROOT = (typeof self !== 'undefined' ? self : globalThis);
  var TAU = Math.PI * 2;
  var K_ARC = 0.5522847498307936;

  /* ------------------------------------------------------------------ *
   * numeric safety                                                      *
   * ------------------------------------------------------------------ */
  function fin(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function clamp(v, lo, hi) { v = num(v, lo); return v < lo ? lo : (v > hi ? hi : v); }
  function rad(v) { v = num(v, 0); return v > 0.001 ? v : 0.001; }
  function smooth(f) { f = clamp(f, 0, 1); return f * f * (3 - 2 * f); }

  function lgrad(ctx, x0, y0, x1, y1) {
    if (!fin(x0) || !fin(y0) || !fin(x1) || !fin(y1)) return null;
    if (Math.abs(x1 - x0) < 1e-6 && Math.abs(y1 - y0) < 1e-6) return null;
    return ctx.createLinearGradient(x0, y0, x1, y1);
  }
  function rgrad(ctx, x0, y0, r0, x1, y1, r1) {
    if (!fin(x0) || !fin(y0) || !fin(r0) || !fin(x1) || !fin(y1) || !fin(r1)) return null;
    if (r0 < 0 || !(r1 > 0) || r1 < r0) return null;
    return ctx.createRadialGradient(x0, y0, r0, x1, y1, r1);
  }
  function rgba(r, g, b, a) {
    return 'rgba(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ',' + clamp(a, 0, 1).toFixed(3) + ')';
  }
  function alpha(ctx, a) { ctx.globalAlpha = clamp(a, 0, 1); }

  /* hashed value noise: deterministic, allocation free, no Math.random */
  function h1(n) {
    if (!fin(n)) return 0.5;
    var s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
    s = s - Math.floor(s);
    return fin(s) ? s : 0.5;
  }
  function vnoise(x) {
    if (!fin(x)) return 0.5;
    var i = Math.floor(x), f = x - i;
    var u = f * f * (3 - 2 * f);
    var a = h1(i), b = h1(i + 1);
    return a + (b - a) * u;
  }
  function frac(x) { x = num(x, 0); return x - Math.floor(x); }

  /* two dimensional hash, for per-ship per-item procedural placement. Same
     mulberry-flavoured determinism as h1: a pure function of its integers. */
  function h2(i, j) { return h1(num(i, 0) * 127.1 + num(j, 0) * 311.7 + 13.7); }
  /* a tiny seeded stream so a detail pass can pull as many values as it needs
     without carrying an index around */
  function seq(seed) {
    var n = num(seed, 0);
    return function () { n += 1; return h1(n * 0.6180339887 + 7.31); };
  }

  /* ------------------------------------------------------------------ *
   * surface parametrization.                                            *
   * A point on the hull is (a, r, th): a along the axis, r the local     *
   * radius, th the azimuth measured from the ship's up vector. With the  *
   * camera yawing about the ship's vertical, the 3D normal at azimuth th *
   * is (sin th * sin yaw, cos th, sin th * cos yaw), so:                 *
   *   screen offset from the axis = r * L * (sin th * sy, -cos th)       *
   *   depth (positive = toward the camera) = r * sin th * cy             *
   * Roll about the long axis is just th += bank, which is why a lathe    *
   * silhouette is unaffected by bank and everything sitting on it is not.*
   * ------------------------------------------------------------------ */
  function SPX(O, a, r, th) {
    return O.x + O.L * (num(a, 0) * O.cy + num(r, 0) * Math.sin(num(th, 0)) * O.sy);
  }
  function SPY(O, r, th) {
    return O.y - O.L * num(r, 0) * Math.cos(num(th, 0));
  }
  /* > 0 when the point faces the camera */
  function facing(O, th) { return Math.sin(num(th, 0)) * O.cy; }

  /* the hull radius at an arbitrary a inside one lathe group */
  function hullR(secs, i0, i1, a) {
    if (a >= secs[i0][1]) return secs[i0][2];
    for (var i = i0; i < i1; i++) {
      var aA = secs[i][1], aB = secs[i + 1][1];
      if (a <= aA && a >= aB) {
        var d = aA - aB;
        if (!(d > 1e-9)) return secs[i][2];
        var f = (aA - a) / d;
        return secs[i][2] + (secs[i + 1][2] - secs[i][2]) * f;
      }
    }
    return secs[i1][2];
  }

  /* The near half of a cross section ellipse. side = +1 draws the right half.
     Assume nothing about the context: ctx.ellipse is the fast path, two beziers
     the next, and a short polyline the floor. (The node dom-stub really does
     ship ellipse without bezierCurveTo, and an unguarded call there took the
     whole page's animation loop down.) */
  function halfEllipsePath(ctx, x, y, rx, ry, side) {
    x = num(x, 0); y = num(y, 0); rx = rad(rx); ry = rad(ry);
    var s = (num(side, 1) < 0) ? -1 : 1;
    var HALF = Math.PI / 2;
    if (typeof ctx.ellipse === 'function') {
      ctx.moveTo(x, y - ry);
      ctx.ellipse(x, y, rx, ry, 0, -HALF, HALF, s < 0);
      return;
    }
    if (typeof ctx.bezierCurveTo === 'function') {
      var ox = rx * K_ARC * s, oy = ry * K_ARC;
      ctx.moveTo(x, y - ry);
      ctx.bezierCurveTo(x + ox, y - ry, x + rx * s, y - oy, x + rx * s, y);
      ctx.bezierCurveTo(x + rx * s, y + oy, x + ox, y + ry, x, y + ry);
      return;
    }
    var n = 12, i;
    ctx.moveTo(x, y - ry);
    for (i = 1; i <= n; i++) {
      var a = -HALF + Math.PI * (i / n);
      ctx.lineTo(x + rx * s * Math.cos(a), y + ry * Math.sin(a));
    }
  }
  /* which x side of the axis the near half of a cross section falls on */
  function nearSide(O) { return (O.sy * O.cy >= 0) ? 1 : -1; }

  /* screen-space light direction. A pure axial light would flatten the hull
     into one tone, so a soft fill from screen up is always mixed in; that also
     keeps the default (lightDir = PI) close to the lit-from-above look the
     hull shading had before this parameter existed. */
  function lightVec(O) {
    var lx = Math.cos(O.ld), ly = Math.sin(O.ld) - 0.85;
    var m = Math.sqrt(lx * lx + ly * ly);
    if (!(m > 1e-6)) { O.lx = 0; O.ly = -1; return; }
    O.lx = lx / m; O.ly = ly / m;
  }

  /* ------------------------------------------------------------------ *
   * tiny path helpers (ctx.ellipse is not assumed to exist)              *
   * ------------------------------------------------------------------ */
  function ellipsePath(ctx, x, y, rx, ry) {
    x = num(x, 0); y = num(y, 0); rx = rad(rx); ry = rad(ry);
    if (typeof ctx.ellipse === 'function') { ctx.moveTo(x + rx, y); ctx.ellipse(x, y, rx, ry, 0, 0, TAU); return; }
    if (typeof ctx.bezierCurveTo === 'function') {
      var ox = rx * K_ARC, oy = ry * K_ARC;
      ctx.moveTo(x - rx, y);
      ctx.bezierCurveTo(x - rx, y - oy, x - ox, y - ry, x, y - ry);
      ctx.bezierCurveTo(x + ox, y - ry, x + rx, y - oy, x + rx, y);
      ctx.bezierCurveTo(x + rx, y + oy, x + ox, y + ry, x, y + ry);
      ctx.bezierCurveTo(x - ox, y + ry, x - rx, y + oy, x - rx, y);
      ctx.closePath();
      return;
    }
    /* neither ellipse nor beziers: a polyline still beats throwing, which would
       take the page's animation loop down for good */
    var n = 24, i;
    ctx.moveTo(x + rx, y);
    for (i = 1; i <= n; i++) {
      var a = TAU * (i / n);
      ctx.lineTo(x + rx * Math.cos(a), y + ry * Math.sin(a));
    }
    ctx.closePath();
  }
  function fillEllipse(ctx, x, y, rx, ry, style) {
    ctx.beginPath(); ellipsePath(ctx, x, y, rx, ry); ctx.fillStyle = style; ctx.fill();
  }
  function strokeEllipse(ctx, x, y, rx, ry, style, lw) {
    ctx.beginPath(); ellipsePath(ctx, x, y, rx, ry);
    ctx.strokeStyle = style; ctx.lineWidth = Math.max(0.4, num(lw, 1)); ctx.stroke();
  }
  function line(ctx, x0, y0, x1, y1) {
    if (!fin(x0) || !fin(y0) || !fin(x1) || !fin(y1)) return;
    ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
  }
  function quad(ctx, x0, y0, x1, y1, x2, y2, x3, y3) {
    ctx.beginPath();
    ctx.moveTo(num(x0, 0), num(y0, 0));
    ctx.lineTo(num(x1, 0), num(y1, 0));
    ctx.lineTo(num(x2, 0), num(y2, 0));
    ctx.lineTo(num(x3, 0), num(y3, 0));
    ctx.closePath();
  }

  /* ------------------------------------------------------------------ *
   * materials. Hull metal is naturalistic grey; gold is trim only.       *
   * tone order: [highlight, body, shade, deep]                           *
   * ------------------------------------------------------------------ */
  var GOLD = '#c8a45c';
  var GOLD_DK = '#a07c2c';
  var MATS = {
    cool:     ['#eef3fa', '#c2ccda', '#7f8b9c', '#39414d'],
    steel:    ['#e6ebf2', '#b4bdca', '#727c8c', '#333b46'],
    graphite: ['#d4dae2', '#98a2af', '#5f6976', '#2b323b'],
    engine:   ['#ece6da', '#b8ad99', '#79705e', '#33302a'],
    shield:   ['#f2f2ef', '#cbcbc3', '#87887e', '#3a3b36'],
    panelUp:  ['#c9d2de', '#9aa4b2', '#6b7481', '#333a44'],
    panelDn:  ['#9aa4b2', '#78828f', '#4d555f', '#262c34']
  };

  function mat(name) { return MATS[name] || MATS.steel; }

  /* the same tone ladders as numbers, so procedural detail can be shaded by a
     real normal-dot-light instead of picking one of four fixed swatches */
  function hexRgb(h) {
    var n = parseInt(String(h).slice(1), 16);
    if (!fin(n)) return [128, 128, 128];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  var MATS_RGB = {};
  (function () {
    for (var k in MATS) {
      if (!Object.prototype.hasOwnProperty.call(MATS, k)) continue;
      MATS_RGB[k] = [hexRgb(MATS[k][0]), hexRgb(MATS[k][1]), hexRgb(MATS[k][2]), hexRgb(MATS[k][3])];
    }
  })();
  function matRgb(name) { return MATS_RGB[name] || MATS_RGB.steel; }
  /* u = 0 is the deepest shadow tone, u = 1 the highlight */
  function toneMix(T, u) {
    u = clamp(u, 0, 1) * 3;
    var i = Math.floor(u); if (i > 2) i = 2;
    var f = u - i;
    var A = T[3 - i], B = T[2 - i];
    return [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f, A[2] + (B[2] - A[2]) * f];
  }
  function rgbaOf(c, a) { return rgba(c[0], c[1], c[2], a); }
  function angWrap(d) {
    d = num(d, 0);
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    return d;
  }

  /* ------------------------------------------------------------------ *
   * ship definitions                                                    *
   * a runs +0.5 at the nose to -0.5 at the tail; r and every offset are  *
   * fractions of the ship LENGTH.                                       *
   *                                                                     *
   * A drawn ship is a DRIVE composed with a HULL.                        *
   *   drive   ion | fusion | anti          the engine, its tail, its     *
   *           plume, and on the antimatter ship the standoff shield that *
   *           sits ahead of everything else.                             *
   *   hull    probe | crewed | generation  what the ship carries,        *
   *           between the nose and the drive's joint.                    *
   * Three drives times three hulls is the nine ships the page offers,    *
   * and they are exactly the existing accel index times the existing     *
   * mass index: nothing about the trip maths changes here.               *
   *                                                                     *
   * The crewed hull reproduces the wave-4 ship section for section, rig  *
   * for rig, emissive for emissive, in the same order, so a caller that  *
   * passes no hull gets the design it already had. Its procedural seed   *
   * is keyed on the DRIVE name alone for that reason: the seed decides   *
   * where every greeble, seam and fastener lands.                        *
   * ------------------------------------------------------------------ */
  var SHIPS = [
    {
      key: 'ion',
      g: 0.3,
      name: 'Plasma liner',
      line: 'A magnetoplasma liner. Big radiators, thin truss, gentle thrust held for months. 0.3 g is already generous for any plasma drive we can sketch.'
    },
    {
      key: 'fusion',
      g: 1,
      name: 'Fusion torch',
      line: 'A fusion torch ship in the Daedalus tradition. The engine is most of the ship; the crew ring hides behind the shadow shield.'
    },
    {
      key: 'anti',
      g: 2,
      name: 'Antimatter torch',
      line: 'An antimatter torch. A tiny payload on a long boom, a mirror bell to survive its own exhaust, and shielding you could mistake for a small moon.'
    }
  ];

  /* the mass classes, in the order the page's mass control already uses */
  var HULL_LIST = [
    { key: 'probe', label: 'probe' },
    { key: 'crewed', label: 'crewed ship' },
    { key: 'generation', label: 'generation ship' }
  ];

  /* The nine card strings, keyed hull + '/' + drive. The three crewed lines
     are the shipped ones, unchanged; the other six are new. Nothing here
     claims an acceleration or a crew the chosen combination does not have. */
  var CARDS = {
    'probe/ion': {
      name: 'Ion probe',
      line: 'A one tonne probe on an electric drive. Most of it is the dish and the instruments, and the push is gentle enough to hold for years.'
    },
    'probe/fusion': {
      name: 'Fusion probe',
      line: 'A small uncrewed probe with a torch engine behind it. The engine weighs far more than anything it carries, which is the usual bargain for arriving sooner.'
    },
    'probe/anti': {
      name: 'Antimatter probe',
      line: 'A probe on an antimatter drive. The shield at the front is there because the engine behind it is the dangerous part.'
    },
    'crewed/ion': { name: SHIPS[0].name, line: SHIPS[0].line },
    'crewed/fusion': { name: SHIPS[1].name, line: SHIPS[1].line },
    'crewed/anti': { name: SHIPS[2].name, line: SHIPS[2].line },
    'generation/ion': {
      name: 'Ion generation ship',
      line: 'A habitat ring on an electric drive. The ring turns so there is something to stand on, and the engine pushes gently and never stops.'
    },
    'generation/fusion': {
      name: 'Fusion generation ship',
      line: 'A million tonnes of habitat behind a fusion torch. The ring turns for gravity, and the shadow shield keeps the engine off the people living in it.'
    },
    'generation/anti': {
      name: 'Antimatter generation ship',
      line: 'A habitat ring pushed by an antimatter drive. Most of the mass is the ring and the shielding between it and the engine.'
    }
  };

  function cardKey(hull, drive) {
    var h = HULL_SET[hull] ? hull : 'crewed';
    var d = DRIVES[drive] ? drive : 'fusion';
    return h + '/' + d;
  }
  function shipCardOf(hull, drive) {
    var c = CARDS[cardKey(hull, drive)];
    return c ? { name: c.name, line: c.line } : { name: '', line: '' };
  }

  /* sections: [group, a, r, cap] */
  var DRIVES = {
    ion: {
      key: 'ion',
      aNose: 0.500,
      gap: 0.004,
      /* where the hull's payload ends and the drive begins, per hull:
         [a, the radius the hull should meet the drive with] */
      join: { probe: [0.132, 0.020], crewed: [0.132, 0.024], generation: [0.132, 0.032] },
      genRingR: 0.300,
      genRingU: 0.700,
      nose: [],
      noseRigs: [],
      aft: [
        ['truss', 0.128, 0.022, 0],
        ['truss', -0.150, 0.020, 1],
        ['aft', -0.156, 0.040, 0],
        ['aft', -0.200, 0.054, 1],
        ['aft', -0.300, 0.056, 0],
        ['aft', -0.340, 0.048, 1],
        ['aft', -0.372, 0.032, 0],
        ['aft', -0.400, 0.030, 1],
        ['aft', -0.428, 0.048, 0],
        ['aft', -0.470, 0.050, 1],
        ['aft', -0.500, 0.044, 1]
      ],
      aftRigs: [
        { type: 'panel', a0: 0.112, a1: -0.148, i0: 0.030, o0: 0.215, i1: 0.030, o1: 0.275, sign: 1, thick: 0.006 },
        { type: 'panel', a0: 0.112, a1: -0.148, i0: 0.030, o0: 0.215, i1: 0.030, o1: 0.275, sign: -1, thick: 0.006 },
        { type: 'ring', a: -0.200, R: 0.062, tube: 0.008, m: 'gold' }
      ],
      mats: { aft: 'steel' },
      ribs: null,
      emit: [
        { type: 'grid', a: -0.498, u: -0.030, R: 0.021, col: [186, 222, 255], idle: 0.12 },
        { type: 'grid', a: -0.498, u: 0.000, R: 0.021, col: [186, 222, 255], idle: 0.12 },
        { type: 'grid', a: -0.498, u: 0.030, R: 0.021, col: [186, 222, 255], idle: 0.12 }
      ],
      beacons: [{ a: -0.318, up: 0.060, th: Math.PI, ph: 0.63, col: 'gold' }],
      nozzles: [-0.030, 0.000, 0.030],
      tailA: -0.500,
      tailR: 0.046,
      halfH: 0.295,
      gimA: -0.150
    },

    fusion: {
      key: 'fusion',
      aNose: 0.500,
      gap: 0.002,
      join: { probe: [0.300, 0.026], crewed: [0.300, 0.038], generation: [0.300, 0.040] },
      genRingR: 0.276,
      genRingU: 0.700,
      nose: [],
      noseRigs: [],
      aft: [
        ['spine', 0.298, 0.026, 0],
        ['spine', -0.130, 0.028, 1],
        ['engine', -0.136, 0.070, 0],
        ['engine', -0.180, 0.096, 1],
        ['engine', -0.238, 0.108, 0],
        ['engine', -0.288, 0.112, 1],
        ['engine', -0.322, 0.078, 0],
        ['engine', -0.358, 0.122, 0],
        ['engine', -0.414, 0.180, 1],
        ['engine', -0.462, 0.224, 0],
        ['engine', -0.500, 0.252, 1]
      ],
      aftRigs: [
        { type: 'disc', a: 0.256, R: 0.118, thick: 0.016, m: 'shield' },
        { type: 'sphere', a: 0.205, R: 0.076, m: 'cool' },
        { type: 'sphere', a: 0.070, R: 0.076, m: 'cool' },
        { type: 'sphere', a: -0.065, R: 0.076, m: 'cool' },
        { type: 'ring', a: -0.205, R: 0.116, tube: 0.013, m: 'gold' },
        { type: 'ring', a: -0.266, R: 0.120, tube: 0.013, m: 'gold' },
        { type: 'mouth', a: -0.500, R: 0.252, glow: [255, 246, 226] }
      ],
      mats: { spine: 'graphite', engine: 'engine' },
      ribs: { engine: 1 },
      emit: [
        { type: 'radiator', g: 'engine', a0: -0.150, a1: -0.300, th0: 0.18, wrap: 1,
          w: 0.009, col: [255, 148, 72], idle: 0.05 },
        { type: 'radiator', g: 'engine', a0: -0.500, a1: -0.376, th0: 0.42, wrap: 1,
          w: 0.007, col: [255, 178, 98], idle: 0.03 }
      ],
      beacons: [{ a: -0.152, up: 0.086, th: Math.PI, ph: 0.29, col: 'gold' }],
      nozzles: [0],
      tailA: -0.500,
      tailR: 0.130,
      halfH: 0.270,
      gimA: -0.130
    },

    anti: {
      key: 'anti',
      aNose: 0.446,
      gap: 0.004,
      join: { probe: [0.322, 0.014], crewed: [0.322, 0.018], generation: [0.100, 0.022] },
      genRingR: 0.180,
      genRingU: 0.500,
      nose: [
        ['shield', 0.500, 0.022, 0],
        ['shield', 0.494, 0.092, 0],
        ['shield', 0.486, 0.152, 0],
        ['shield', 0.475, 0.204, 0],
        ['shield', 0.462, 0.235, 1],
        ['shield', 0.448, 0.232, 1]
      ],
      noseRigs: [
        { type: 'ring', a: 0.455, R: 0.236, tube: 0.010, m: 'gold' }
      ],
      aft: [
        ['boom', 0.318, 0.011, 0],
        ['boom', -0.208, 0.011, 1],
        ['mirror', -0.214, 0.028, 1],
        ['mirror', -0.250, 0.050, 0],
        ['mirror', -0.292, 0.078, 0],
        ['mirror', -0.340, 0.110, 1],
        ['mirror', -0.392, 0.146, 0],
        ['mirror', -0.446, 0.182, 0],
        ['mirror', -0.500, 0.212, 1]
      ],
      aftRigs: [
        { type: 'sphere', a: -0.232, R: 0.030, m: 'glow' },
        { type: 'ring', a: -0.300, R: 0.096, tube: 0.011, m: 'gold' },
        { type: 'ring', a: -0.392, R: 0.158, tube: 0.011, m: 'gold' },
        { type: 'ring', a: -0.478, R: 0.204, tube: 0.011, m: 'gold' },
        { type: 'mouth', a: -0.500, R: 0.212, glow: [232, 210, 255] }
      ],
      mats: { shield: 'shield', mirror: 'graphite' },
      ribs: { mirror: 1 },
      emit: [
        { type: 'radiator', g: 'mirror', a0: -0.500, a1: -0.300, th0: 0.26, wrap: 1,
          w: 0.008, col: [255, 146, 84], idle: 0.06 }
      ],
      beacons: [{ a: -0.256, up: 0.062, th: Math.PI, ph: 0.41, col: 'gold' }],
      nozzles: [0],
      tailA: -0.480,
      tailR: 0.030,
      halfH: 0.250,
      gimA: -0.212
    }
  };

  /* ------------------------------------------------------------------ *
   * hulls. Each returns the payload section run between the drive's     *
   * nose contribution and its joint, plus whatever rides on it.          *
   * ------------------------------------------------------------------ */

  /* the crewed hull IS the wave-4 forward structure, per drive, verbatim */
  var CREWED_FORE = {
    ion: {
      sections: [
        ['fore', 0.500, 0.004, 0],
        ['fore', 0.480, 0.012, 0],
        ['fore', 0.462, 0.020, 1],
        ['fore', 0.440, 0.024, 0],
        ['fore', 0.418, 0.026, 1],
        ['fore', 0.398, 0.052, 0],
        ['fore', 0.360, 0.070, 1],
        ['fore', 0.220, 0.072, 0],
        ['fore', 0.176, 0.064, 1],
        ['fore', 0.150, 0.030, 0],
        ['fore', 0.132, 0.024, 1]
      ],
      rigs: [{ type: 'ring', a: 0.176, R: 0.070, tube: 0.007, m: 'gold' }],
      mats: { fore: 'cool' },
      emit: [],
      beacons: [
        { a: 0.300, up: 0.078, th: 0, ph: 0.00, col: 'gold' },
        { a: 0.412, up: 0.032, th: Math.PI, ph: 0.47, col: 'white' }
      ],
      halfH: 0.086
    },
    fusion: {
      sections: [
        ['fore', 0.500, 0.005, 0],
        ['fore', 0.486, 0.014, 1],
        ['fore', 0.466, 0.026, 0],
        ['fore', 0.440, 0.030, 1],
        ['fore', 0.418, 0.024, 0],
        ['fore', 0.400, 0.021, 1],
        ['hub', 0.396, 0.038, 1],
        ['hub', 0.300, 0.038, 1]
      ],
      rigs: [{ type: 'ring', a: 0.348, R: 0.134, tube: 0.030, m: 'steel' }],
      mats: { fore: 'cool', hub: 'steel' },
      emit: [],
      beacons: [
        { a: 0.348, up: 0.142, th: 0, ph: 0.00, col: 'gold' },
        { a: 0.452, up: 0.034, th: Math.PI, ph: 0.52, col: 'white' }
      ],
      halfH: 0.164
    },
    anti: {
      sections: [
        ['pod', 0.446, 0.016, 0],
        ['pod', 0.432, 0.048, 1],
        ['pod', 0.392, 0.056, 0],
        ['pod', 0.352, 0.048, 1],
        ['pod', 0.336, 0.024, 0],
        ['pod', 0.322, 0.018, 1]
      ],
      rigs: [],
      mats: { pod: 'cool' },
      emit: [
        { type: 'radiator', g: 'pod', a0: 0.430, a1: 0.330, th0: 0.85, wrap: 1,
          w: 0.006, col: [255, 176, 108], idle: 0.03 }
      ],
      beacons: [
        { a: 0.400, up: 0.064, th: 0, ph: 0.00, col: 'gold' },
        { a: 0.360, up: 0.056, th: Math.PI, ph: 0.55, col: 'white' }
      ],
      halfH: 0.064
    }
  };

  var HULLS = {
    /* an uncrewed flyby craft: an instrument bus, booms, and a high-gain
       dish that spends the whole trip aimed back the way it came */
    probe: {
      key: 'probe',
      gimK: 0.022,
      fore: function (d, aJ, rJ) {
        var aN = d.aNose, S = aN - aJ;
        function A(u) { return aJ + S * clamp(u, 0, 1); }
        return {
          sections: [
            ['bus', A(1.000), 0.005, 0],
            ['bus', A(0.962), 0.018, 1],
            ['bus', A(0.928), 0.027, 0],
            ['bus', A(0.780), 0.034, 0],
            ['bus', A(0.700), 0.036, 1],
            ['bus', A(0.540), 0.033, 0],
            ['bus', A(0.492), 0.019, 1],
            ['instr', A(0.462), 0.016, 0],
            ['instr', A(0.300), 0.015, 1],
            ['instr', A(0.190), 0.026, 0],
            ['instr', A(0.080), 0.028, 1],
            ['instr', A(0.000), rJ, 1]
          ],
          rigs: [
            { type: 'ring', a: A(0.905), R: 0.030, tube: 0.005, m: 'gold' },
            { type: 'dish', a: A(0.845), R: 0.118, depth: 0.044, mount: 0.052, m: 'shield', sid: 11 },
            { type: 'mast', a: A(0.660), r0: 0.034, len: 0.150, th: 0, tip: 0.026, m: 'graphite' },
            { type: 'sphere', a: A(0.600), R: 0.026, m: 'cool' },
            { type: 'mast', a: A(0.560), r0: 0.030, len: 0.098, th: Math.PI, tip: 0.018, m: 'graphite' },
            { type: 'mast', a: A(0.330), r0: 0.024, len: 0.118, th: Math.PI * 0.5, tip: 0.021, m: 'graphite' }
          ],
          mats: { bus: 'cool', instr: 'steel' },
          emit: [
            { type: 'radiator', g: 'bus', a0: A(0.760), a1: A(0.520), th0: 0.92, wrap: 1,
              w: 0.006, col: [255, 168, 96], idle: 0.03 }
          ],
          beacons: [
            { a: A(0.790), up: 0.042, th: 0, ph: 0.13, col: 'gold' },
            { a: A(0.360), up: 0.032, th: Math.PI, ph: 0.58, col: 'white' }
          ],
          halfH: 0.238
        };
      }
    },

    crewed: {
      key: 'crewed',
      gimK: 0.018,
      fore: function (d) {
        return CREWED_FORE[d.key] || CREWED_FORE.fusion;
      }
    },

    /* a habitat ring that turns for gravity, storage drums, and radiator
       wings big enough for a town */
    generation: {
      key: 'generation',
      gimK: 0.011,
      fore: function (d, aJ, rJ) {
        var aN = d.aNose, S = aN - aJ;
        function A(u) { return aJ + S * clamp(u, 0, 1); }
        var R = num(d.genRingR, 0.28);
        return {
          sections: [
            ['gcap', A(1.000), 0.016, 0],
            ['gcap', A(0.990), 0.078, 0],
            ['gcap', A(0.976), 0.126, 0],
            ['gcap', A(0.958), 0.146, 1],
            ['gcap', A(0.942), 0.142, 1],
            ['gspine', A(0.936), 0.026, 0],
            ['gspine', A(0.870), 0.033, 1],
            ['gspine', A(0.520), 0.035, 1],
            ['gdrum', A(0.500), 0.084, 0],
            ['gdrum', A(0.350), 0.094, 1],
            ['gdrum', A(0.200), 0.090, 0],
            ['gdrum', A(0.100), 0.062, 1],
            ['gdrum', A(0.000), rJ, 1]
          ],
          /* No radiator wings on this hull. The ring is the thing worth
             looking at, and a pair of flat panels at anything near its radius
             reads as one confused disc; the waste heat comes off the drum
             strips below instead, and the ion drive brings wings of its own. */
          rigs: [
            { type: 'ring', a: A(0.912), R: 0.040, tube: 0.006, m: 'gold' },
            { type: 'habring', a: A(num(d.genRingU, 0.700)), R: R, tube: 0.030, hub: 0.054,
              spokes: 6, mods: 12, spin: 0.26, m: 'steel', sid: 29 },
            { type: 'disc', a: A(0.548), R: 0.122, thick: 0.014, m: 'shield' },
            { type: 'sphere', a: A(0.270), R: 0.050, m: 'cool' }
          ],
          mats: { gcap: 'shield', gspine: 'graphite', gdrum: 'cool' },
          emit: [
            { type: 'radiator', g: 'gdrum', a0: A(0.470), a1: A(0.120), th0: 0.55, wrap: 1,
              w: 0.011, col: [255, 162, 90], idle: 0.05 }
          ],
          beacons: [
            { a: A(0.955), up: 0.150, th: 0, ph: 0.08, col: 'gold' },
            { a: A(num(d.genRingU, 0.700)), up: R + 0.036, th: Math.PI, ph: 0.44, col: 'white' },
            { a: A(0.280), up: 0.098, th: Math.PI * 0.5, ph: 0.81, col: 'gold' }
          ],
          halfH: R + 0.052
        };
      }
    }
  };

  var HULL_SET = { probe: 1, crewed: 1, generation: 1 };

  /* build the draw item list once per ship: lathe groups and rigs, sorted
     nose to tail so the depth order is a plain forward or backward walk. */
  function prep(s, seedKey) {
    var items = [], secs = s.sections, i, run = null;
    for (i = 0; i < secs.length; i++) {
      var g = secs[i][0];
      if (!run || run.g !== g) {
        run = { kind: 'group', g: g, i0: i, i1: i, m: (s.mats && s.mats[g]) || 'steel' };
        items.push(run);
      } else run.i1 = i;
    }
    for (i = 0; i < items.length; i++) {
      var aFore = secs[items[i].i0][1], aAft = secs[items[i].i1][1];
      items[i].a = (aFore + aAft) * 0.5;
      items[i].type = (items[i].g === 'truss') ? 'truss' : (items[i].g === 'boom' ? 'boom' : 'lathe');
    }
    for (i = 0; i < s.rigs.length; i++) {
      var rg = s.rigs[i];
      var it = { kind: 'rig', rig: rg, type: rg.type };
      it.a = (rg.type === 'panel') ? (rg.a0 + rg.a1) * 0.5 : rg.a;
      items.push(it);
    }
    items.sort(function (p, q) { return q.a - p.a; });
    /* a stable per-item seed: the procedural detail must land in the same place
       every frame, and a different place on every group of every ship */
    var kh = 0;
    for (i = 0; i < seedKey.length; i++) kh = (kh * 31 + seedKey.charCodeAt(i)) % 100003;
    for (i = 0; i < items.length; i++) items[i].sid = kh * 17 + i * 101 + 7;
    s._items = items;
    s._key = seedKey;
    return s;
  }

  function compose(hullKey, driveKey) {
    var d = DRIVES[driveKey], H = HULLS[hullKey];
    var jn = d.join[hullKey] || d.join.crewed;
    var fore = H.fore(d, jn[0], jn[1]) || {};
    var secs = [], i, k;
    for (i = 0; i < d.nose.length; i++) secs.push(d.nose[i]);
    var fs = fore.sections || [];
    for (i = 0; i < fs.length; i++) secs.push(fs[i]);
    for (i = 0; i < d.aft.length; i++) {
      var row = d.aft[i].slice();
      if (i === 0) row[1] = jn[0] - d.gap;
      secs.push(row);
    }
    var mats = {};
    for (k in d.mats) if (Object.prototype.hasOwnProperty.call(d.mats, k)) mats[k] = d.mats[k];
    if (fore.mats) for (k in fore.mats) if (Object.prototype.hasOwnProperty.call(fore.mats, k)) mats[k] = fore.mats[k];
    return {
      sections: secs,
      rigs: d.noseRigs.concat(fore.rigs || [], d.aftRigs),
      mats: mats,
      ribs: d.ribs,
      emit: (d.emit || []).concat(fore.emit || []),
      beacons: (fore.beacons || []).concat(d.beacons || []),
      nozzles: d.nozzles,
      tailA: d.tailA,
      tailR: d.tailR,
      gimA: d.gimA,
      gimK: H.gimK,
      halfH: Math.max(d.halfH, num(fore.halfH, 0)),
      drive: driveKey,
      hull: hullKey
    };
  }

  var SPEC_CACHE = {};
  function specOf(driveKey, hullKey) {
    var dk = DRIVES[driveKey] ? driveKey : 'fusion';
    var hk = HULL_SET[hullKey] ? hullKey : 'crewed';
    var ck = hk + '/' + dk;
    var s = SPEC_CACHE[ck];
    if (!s) {
      s = compose(hk, dk);
      /* the crewed hull keeps the wave-4 seed so its procedural detail lands
         exactly where it always did */
      prep(s, hk === 'crewed' ? dk : ck);
      SPEC_CACHE[ck] = s;
    }
    return s;
  }
  specOf('ion', 'crewed'); specOf('fusion', 'crewed'); specOf('anti', 'crewed');

  function profileOf(key, hull) {
    var s = specOf(key, hull);
    var out = [], i;
    for (i = 0; i < s.sections.length; i++) {
      var q = s.sections[i];
      out.push({ group: q[0], a: q[1], r: q[2], cap: !!q[3] });
    }
    return out;
  }
  function rigsOf(key, hull) {
    var s = specOf(key, hull), out = [], i;
    for (i = 0; i < s.rigs.length; i++) {
      var r = s.rigs[i], c = {};
      for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k)) c[k] = r[k];
      out.push(c);
    }
    return out;
  }
  /* the hull emissives (radiator strips, accelerator grids) as a defensive copy */
  function emitOf(key, hull) {
    var s = specOf(key, hull), out = [], i;
    var em = s.emit || [];
    for (i = 0; i < em.length; i++) {
      var e = em[i], c = {};
      for (var k in e) if (Object.prototype.hasOwnProperty.call(e, k)) {
        c[k] = (Object.prototype.toString.call(e[k]) === '[object Array]') ? e[k].slice() : e[k];
      }
      out.push(c);
    }
    return out;
  }
  /* the drawn half-height as a fraction of px, so callers can fit a ship into a
     box: total height is about 2 * halfHeightOf(key, hull) * px */
  function halfHeightOf(key, hull) {
    return specOf(key, hull).halfH || 0.3;
  }
  function shipByKey(key) {
    for (var i = 0; i < SHIPS.length; i++) if (SHIPS[i].key === key) return SHIPS[i];
    return null;
  }
  function hullByKey(key) {
    for (var i = 0; i < HULL_LIST.length; i++) if (HULL_LIST[i].key === key) return HULL_LIST[i];
    return null;
  }

  /* ------------------------------------------------------------------ *
   * projection. The ship yaws about its own vertical axis only, so the   *
   * screen mapping is: along-axis foreshortens by cos(yaw), across-axis  *
   * (the ship's up) never foreshortens, and a circular cross section     *
   * projects to an ellipse of half width r*|sin(yaw)|.                   *
   * ------------------------------------------------------------------ */
  function SX(O, a) { return O.x + num(a, 0) * O.L * O.cy; }
  function SY(O, up) { return O.y - num(up, 0) * O.L; }

  /* The same projection for a free vector in ship space (f = along the axis
     toward the nose, u = the ship's up, s = the ship's right). SPX/SPY are
     the (a, r, th) special case of these; the dish and the habitat ring need
     the general form because their geometry does not lie on a lathe.
       screen x = f*cy + s*sy      screen y = -u      depth = s*cy - f*sy
     Depth is positive toward the camera, which matches `facing`. */
  function P3X(O, f, u, s) { return O.x + O.L * (num(f, 0) * O.cy + num(s, 0) * O.sy); }
  function P3Y(O, f, u, s) { return O.y - O.L * num(u, 0); }
  function P3D(O, f, u, s) { return num(s, 0) * O.cy - num(f, 0) * O.sy; }

  /* ------------------------------------------------------------------ *
   * hull pieces                                                         *
   * ------------------------------------------------------------------ */
  /* Directional shading of a surface of revolution, as a VERTICAL gradient.
     The gradient has to be vertical: the ship's axis projects horizontally, so
     any horizontal component in the gradient would shade the hull along its
     length, which is not a thing light does to a cylinder.

     On the visible half the azimuth is pinned by the screen height, so the
     Lambert term is a real function of the vertical position alone:
       v  = dy / r          (-1 at the top edge, +1 at the bottom edge)
       nx = sign(cy) * sqrt(1 - v*v) * sy      (the near half faces this way)
       I  = nx * lx + v * ly
     A little ambient, an edge falloff and a specular ridge at the Lambert
     maximum turn that into the metal ladder the hull had before lightDir
     existed; at the default light this reproduces the lit-from-above look. */
  var GRAD_STOPS = 9;
  function bodyGrad(ctx, O, rmax, tones) {
    var R = rmax * O.L;
    var top = O.y - R, bot = O.y + R;
    var g = lgrad(ctx, 0, top, 0, bot);
    if (!g) return tones[1];
    var T = O.T || MATS_RGB.steel;
    var sgn = (O.cy >= 0) ? 1 : -1;
    var i, v, nx, I;
    /* the Lambert maximum over the visible half, for the specular ridge */
    var mx = sgn * O.sy * O.lx, my = O.ly;
    var Imax = Math.sqrt(mx * mx + my * my);
    if (!(Imax > 0.02)) Imax = 0.02;
    for (i = 0; i <= GRAD_STOPS; i++) {
      var f = i / GRAD_STOPS;
      v = 2 * f - 1;
      nx = sgn * Math.sqrt(Math.max(0, 1 - v * v)) * O.sy;
      I = nx * O.lx + v * O.ly;
      var u = 0.20 + 0.74 * clamp(I, 0, 1);
      /* a thin hot ridge where the surface points straight at the light */
      u += 0.34 * Math.exp(-Math.pow((I - Imax) / 0.26, 2));
      /* grazing edges roll off, which is what gives a lathe its round read */
      u *= 1 - 0.52 * Math.pow(Math.abs(v), 5);
      g.addColorStop(f, rgbaOf(toneMix(T, u), 1));
    }
    return g;
  }

  function lathePath(ctx, O, secs, item) {
    var i;
    ctx.beginPath();
    ctx.moveTo(SX(O, secs[item.i0][1]), SY(O, secs[item.i0][2]));
    for (i = item.i0 + 1; i <= item.i1; i++) ctx.lineTo(SX(O, secs[i][1]), SY(O, secs[i][2]));
    for (i = item.i1; i >= item.i0; i--) ctx.lineTo(SX(O, secs[i][1]), SY(O, -secs[i][2]));
    ctx.closePath();
  }

  function drawLathe(ctx, O, spec, item) {
    var secs = spec.sections, i, rmax = 0;
    for (i = item.i0; i <= item.i1; i++) if (secs[i][2] > rmax) rmax = secs[i][2];
    if (rmax <= 0) rmax = 0.004;
    var tones = mat(item.m);

    /* silhouette of the surface of revolution */
    lathePath(ctx, O, secs, item);
    O.T = matRgb(item.m);
    ctx.fillStyle = bodyGrad(ctx, O, rmax, tones);
    ctx.fill();
    if (O.L > 40) {
      ctx.strokeStyle = rgba(18, 22, 28, 0.5);
      ctx.lineWidth = Math.max(0.5, O.L * 0.0035);
      ctx.stroke();
    }

    /* everything procedural lives inside the silhouette, so one clip serves
       the whole detail stack and nothing can bleed past the hull edge */
    if (O.det > 0 && rmax * O.L > 3) {
      ctx.save();
      lathePath(ctx, O, secs, item);
      ctx.clip();
      surfaceDetail(ctx, O, spec, item, secs, rmax);
      ctx.restore();
    }

    /* cross section caps. Edge on they vanish, tail on they are the ship. */
    var asy = Math.abs(O.sy);
    if (asy > 0.05) {
      var step = (O.q ? 1 : 2), fwd = O.sy > 0;
      var from = fwd ? item.i0 : item.i1, to = fwd ? item.i1 : item.i0, d = fwd ? step : -step;
      for (i = from; fwd ? (i <= to) : (i >= to); i += d) {
        if (!secs[i][3]) continue;
        var r = secs[i][2];
        if (r * O.L < 1.2) continue;
        var cx = SX(O, secs[i][1]);
        var rx = r * O.L * asy, ry = r * O.L;
        var g = lgrad(ctx, cx + rx * O.lx, O.y + ry * O.ly, cx - rx * O.lx, O.y - ry * O.ly);
        if (g) {
          g.addColorStop(0, tones[0]);
          g.addColorStop(0.46, tones[1]);
          g.addColorStop(1, tones[3]);
          ctx.fillStyle = g;
        } else ctx.fillStyle = tones[1];
        alpha(ctx, 0.92);
        ctx.beginPath(); ellipsePath(ctx, cx, O.y, rx, ry); ctx.fill();
        alpha(ctx, 1);
        /* a bulkhead this size is a structure, not a blank lid. Only the end
           caps of a group get it: the interior ones are almost entirely hidden
           behind the next section and would cost a full pass to show a sliver. */
        if (O.det > 0 && r * O.L > 26 && rx > 7 && (i === item.i0 || i === item.i1)) {
          capFace(ctx, O, cx, rx, ry, item.sid + i);
        }
      }
    }

    /* thin specular line along the upper third */
    if (O.q && O.L > 70) {
      contour(ctx, O, secs, item, 0.44, rgba(255, 255, 255, 0.42), Math.max(0.6, O.L * 0.004));
    }
    /* structural contours on the big curved shells (bell, mirror) */
    if (O.q && O.L > 80 && spec.ribs && spec.ribs[item.g]) {
      contour(ctx, O, secs, item, 0.74, rgba(28, 32, 38, 0.30), Math.max(0.5, O.L * 0.003));
      contour(ctx, O, secs, item, -0.42, rgba(28, 32, 38, 0.26), Math.max(0.5, O.L * 0.003));
      contour(ctx, O, secs, item, -0.76, rgba(28, 32, 38, 0.30), Math.max(0.5, O.L * 0.003));
    }
  }

  /* the face of a big bulkhead or shield: radial ribs, stiffener rings and a
     couple of hatch pads, all clipped to the disc so the plating cannot spill
     onto the hull behind it. */
  function capFace(ctx, O, cx, rx, ry, sid) {
    var i, f;
    var big = Math.max(rx, ry);
    /* no clip: every feature below is placed at a radius fraction below 1, so
       it is inside the disc by construction and a clip would only cost time */
    /* a soft dome so the plate reads as slightly convex under the light */
    var dg = rgrad(ctx, cx + rx * O.lx * 0.45, O.y + ry * O.ly * 0.45, 0, cx, O.y, big * 1.20);
    if (dg) {
      dg.addColorStop(0, rgba(255, 255, 255, 0.13));
      dg.addColorStop(0.42, rgba(120, 130, 146, 0.10));
      dg.addColorStop(1, rgba(8, 10, 14, 0.58));
      ctx.fillStyle = dg;
      ctx.beginPath(); ellipsePath(ctx, cx, O.y, rx, ry); ctx.fill();
    }
    /* ribs stop well short of the middle: a hub, not a moire of converging
       lines, is what a real stiffened plate looks like */
    var nR = O.det >= 3 ? 18 : (O.det >= 2 ? 12 : 8);
    ctx.beginPath();
    for (i = 0; i < nR; i++) {
      var an = (i / nR) * TAU + O.bank;
      ctx.moveTo(cx + rx * 0.34 * Math.cos(an), O.y + ry * 0.34 * Math.sin(an));
      ctx.lineTo(cx + rx * 0.99 * Math.cos(an), O.y + ry * 0.99 * Math.sin(an));
    }
    ctx.strokeStyle = rgba(16, 20, 26, 0.20);
    ctx.lineWidth = Math.max(0.35, O.L * 0.0020);
    ctx.stroke();
    strokeEllipse(ctx, cx, O.y, rx * 0.34, ry * 0.34, rgba(16, 20, 26, 0.24), Math.max(0.4, O.L * 0.0026));
    for (i = 1; i <= (O.det >= 2 ? 3 : 2); i++) {
      f = 0.34 + (0.99 - 0.34) * (i / ((O.det >= 2 ? 3 : 2) + 1));
      strokeEllipse(ctx, cx, O.y, rx * f, ry * f, rgba(16, 20, 26, 0.16), Math.max(0.35, O.L * 0.0016));
    }
    if (O.det >= 2) {
      var rnd = seq(sid * 2.9 + 47.1);
      for (i = 0; i < 5; i++) {
        var aa = rnd() * TAU, rr = 0.42 + 0.46 * rnd();
        var px = cx + rx * rr * Math.cos(aa), py = O.y + ry * rr * Math.sin(aa);
        var pr = big * (0.030 + 0.038 * rnd());
        fillEllipse(ctx, px, py, pr * (rx / big), pr, rgba(20, 24, 30, 0.36));
        strokeEllipse(ctx, px, py, pr * (rx / big), pr, rgba(222, 232, 246, 0.24),
          Math.max(0.3, O.L * 0.0014));
      }
      /* one bright hub fitting so the eye has somewhere to land */
      fillEllipse(ctx, cx, O.y, rx * 0.13, ry * 0.13, rgba(180, 190, 206, 0.55));
      strokeEllipse(ctx, cx, O.y, rx * 0.13, ry * 0.13, rgba(238, 246, 255, 0.28),
        Math.max(0.35, O.L * 0.0018));
    }
  }

  function contour(ctx, O, secs, item, f, style, lw) {
    ctx.beginPath();
    for (var i = item.i0; i <= item.i1; i++) {
      var xx = SX(O, secs[i][1]), yy = SY(O, secs[i][2] * f);
      if (i === item.i0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
    }
    ctx.strokeStyle = style;
    ctx.lineWidth = lw;
    ctx.stroke();
  }

  /* the same walk but at a real azimuth on the surface, so the line slides
     around the hull as the ship yaws or banks instead of staying pinned to the
     screen vertical */
  function contourAt(ctx, O, secs, item, th, rk, style, lw) {
    ctx.beginPath();
    for (var i = item.i0; i <= item.i1; i++) {
      var r = secs[i][2] * rk;
      var xx = SPX(O, secs[i][1], r, th), yy = SPY(O, r, th);
      if (i === item.i0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
    }
    ctx.strokeStyle = style;
    ctx.lineWidth = Math.max(0.35, num(lw, 1));
    ctx.stroke();
  }

  /* ------------------------------------------------------------------ *
   * procedural surface detail. Everything below is called inside a clip *
   * of the hull silhouette and is gated on O.det, so the cost is zero   *
   * until the ship is actually large on screen.                         *
   * ------------------------------------------------------------------ */

  /* a generous quad covering the whole item, used as the fill target for the
     axial gradients (joint occlusion, aft rim light). The clip does the shape. */
  function itemBox(ctx, O, aF, aA, rmax) {
    var pad = rmax * O.L * 1.35 + O.L * 0.02;
    var xF = SX(O, aF), xA = SX(O, aA);
    var lo = Math.min(xF, xA) - pad, hi = Math.max(xF, xA) + pad;
    quad(ctx, lo, O.y - pad - rmax * O.L, hi, O.y - pad - rmax * O.L,
         hi, O.y + pad + rmax * O.L, lo, O.y + pad + rmax * O.L);
  }

  /* darken where a hull group butts into its neighbours: cheap contact shadow
     that does more for the read of "assembled from parts" than any line does */
  function jointPass(ctx, O, aF, aA, rmax) {
    var xF = SX(O, aF), xA = SX(O, aA);
    if (Math.abs(xF - xA) < 6) return;
    var g = lgrad(ctx, xF, O.y, xA, O.y);
    if (!g) return;
    g.addColorStop(0, rgba(9, 12, 16, 0.34));
    g.addColorStop(0.11, rgba(9, 12, 16, 0));
    g.addColorStop(0.89, rgba(9, 12, 16, 0));
    g.addColorStop(1, rgba(9, 12, 16, 0.34));
    ctx.fillStyle = g;
    itemBox(ctx, O, aF, aA, rmax);
    ctx.fill();
  }

  /* engraved plating: circumferential seams on the section stations plus a set
     of longitudinal seams that ride around the hull with yaw and bank */
  function seamPass(ctx, O, secs, item, rmax) {
    var i, k;
    var side = nearSide(O), asy = Math.abs(O.sy);
    var lwD = Math.max(0.4, O.L * 0.0022);
    var dark = rgba(16, 20, 26, O.det >= 3 ? 0.34 : 0.26);

    /* circumferential: one per station, plus a midpoint fill-in when the bay is
       long enough to look bare. All of them go into one path and one stroke. */
    var xs = [], rs = [];
    for (i = item.i0; i <= item.i1; i++) { xs.push(secs[i][1]); rs.push(secs[i][2]); }
    var rings = 0;
    ctx.beginPath();
    for (i = 0; i < xs.length; i++) {
      if (i + 1 < xs.length && O.det >= 2) {
        var gapPx = Math.abs((xs[i] - xs[i + 1]) * O.L * O.cy);
        var extra = Math.min(3, Math.floor(gapPx / (O.L * 0.055)));
        for (k = 1; k <= extra; k++) {
          var f = k / (extra + 1);
          rings += seamRing(ctx, O, xs[i] + (xs[i + 1] - xs[i]) * f,
            rs[i] + (rs[i + 1] - rs[i]) * f, side, asy);
        }
      }
      if (i === 0 || i === xs.length - 1) continue;
      rings += seamRing(ctx, O, xs[i], rs[i], side, asy);
    }
    if (rings) {
      ctx.lineWidth = lwD;
      ctx.strokeStyle = dark;
      ctx.stroke();
    }

    /* longitudinal: evenly spaced azimuths, jittered so no two ships plate the
       same way, drawn only where the surface faces the camera. Batched into two
       alpha buckets so a hull costs two strokes instead of one per line. */
    var nLon = O.det >= 3 ? 9 : (O.det >= 2 ? 7 : 5);
    var rnd = seq(item.sid * 7.7 + 3.1);
    var strong = [], weak = [];
    for (k = 0; k < nLon; k++) {
      var th = O.bank + (k / nLon) * TAU + (rnd() - 0.5) * (TAU / nLon) * 0.55;
      var fc = facing(O, th);
      if (fc <= 0.07) continue;
      (fc > 0.34 ? strong : weak).push(th);
    }
    ctx.lineWidth = lwD;
    strokeContours(ctx, O, secs, item, strong, 0, rgba(16, 20, 26, 0.30));
    strokeContours(ctx, O, secs, item, weak, 0, rgba(16, 20, 26, 0.15));
    if (O.det >= 3) {
      ctx.lineWidth = Math.max(0.35, lwD * 0.8);
      strokeContours(ctx, O, secs, item, strong, 0.055, rgba(236, 244, 254, 0.11));
    }
  }

  /* many azimuth contours as one path and one stroke */
  function strokeContours(ctx, O, secs, item, ths, off, style) {
    if (!ths.length) return;
    var j, i;
    ctx.beginPath();
    for (j = 0; j < ths.length; j++) {
      var th = ths[j] + off;
      for (i = item.i0; i <= item.i1; i++) {
        var r = secs[i][2];
        var xx = SPX(O, secs[i][1], r, th), yy = SPY(O, r, th);
        if (i === item.i0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
      }
    }
    ctx.strokeStyle = style;
    ctx.stroke();
  }

  /* appends one near-half cross section to the CURRENT path; returns 1 when it
     drew anything so the caller knows whether the batched stroke is worth it */
  function seamRing(ctx, O, a, r, side, asy) {
    if (!(r > 0)) return 0;
    var rr = r * O.L;
    if (rr < 2.2) return 0;
    halfEllipsePath(ctx, SX(O, a), O.y, Math.max(0.35, rr * asy), rr, side);
    return 1;
  }

  /* small hardware bolted to the hull: boxes, pipe runs, sensor pads. Each is a
     parallelogram built from the local surface tangents, so it foreshortens
     correctly and slides around the hull with bank. */
  function greeblePass(ctx, O, secs, item, rmax) {
    var T = matRgb(item.m);
    var aF = secs[item.i0][1], aA = secs[item.i1][1];
    var spanA = aF - aA;
    if (!(spanA > 0.004)) return;
    var spanPx = Math.abs(spanA * O.L * O.cy) + rmax * O.L * Math.abs(O.sy) * 1.4;
    var n = clamp(Math.round(spanPx * (O.det >= 3 ? 0.105 : 0.070)), 3, O.det >= 3 ? 20 : 12);
    var rnd = seq(item.sid * 3.3 + 11.9);
    var i, b;
    /* Collected first, then drawn in batches: the skirts all share one colour
       and the lit faces quantize into four tone buckets, so a hull full of
       hardware costs five fills instead of two fills per greeble. */
    var skirt = [], faces = [[], [], [], []], masts = [], crowns = [];
    for (i = 0; i < n; i++) {
      var u0 = rnd(), u1 = rnd(), u2 = rnd(), u3 = rnd(), u4 = rnd();
      var a = aA + spanA * (0.06 + 0.88 * u0);
      var th = O.bank + u1 * TAU;
      var fc = facing(O, th);
      if (fc <= 0.12) continue;
      var r = hullR(secs, item.i0, item.i1, a);
      if (!(r * O.L > 2.5)) continue;
      var kind = u4 < 0.30 ? 0 : (u4 < 0.62 ? 1 : (u4 < 0.86 ? 2 : 3));
      var da = spanA * (kind === 1 ? (0.10 + 0.16 * u2) : (0.012 + 0.030 * u2));
      var dth = kind === 1 ? (0.10 + 0.10 * u3) : (0.16 + 0.30 * u3);
      var h = (kind === 2 ? 0.02 : (kind === 3 ? 0.16 : 0.09)) * (0.6 + 0.8 * u2);
      var rTop = r * (1 + h);
      /* Lambert from the screen-space normal at this azimuth */
      var nl = Math.sin(th) * O.sy * O.lx - Math.cos(th) * O.ly;
      var lit = clamp(0.30 + 0.62 * (nl * 0.5 + 0.5), 0, 1);
      skirt.push([a - da, a + da, th - dth, th + dth, r * (1 + h * 0.18)]);
      b = Math.min(3, Math.floor(lit * 4));
      faces[b].push([a - da * 0.86, a + da * 0.86, th - dth * 0.84, th + dth * 0.84, rTop]);
      if (O.det >= 3 && kind === 1) crowns.push([a - da * 0.86, a + da * 0.86, rTop, th]);
      if (O.det >= 3 && kind === 3) masts.push([a, rTop, r * (1 + h * 2.6), th]);
    }
    if (skirt.length) {
      ctx.fillStyle = rgbaOf(toneMix(T, 0.12), 0.52);
      ctx.beginPath();
      for (i = 0; i < skirt.length; i++) gQuadPath(ctx, O, skirt[i]);
      ctx.fill();
    }
    for (b = 0; b < 4; b++) {
      if (!faces[b].length) continue;
      ctx.fillStyle = rgbaOf(toneMix(T, (b + 0.5) / 4), 0.88);
      ctx.beginPath();
      for (i = 0; i < faces[b].length; i++) gQuadPath(ctx, O, faces[b][i]);
      ctx.fill();
    }
    if (crowns.length) {
      /* pipe runs get a bright crown line */
      ctx.strokeStyle = rgba(238, 246, 255, 0.22);
      ctx.lineWidth = Math.max(0.35, O.L * 0.0018);
      ctx.beginPath();
      for (i = 0; i < crowns.length; i++) {
        var cq = crowns[i];
        ctx.moveTo(SPX(O, cq[0], cq[2], cq[3]), SPY(O, cq[2], cq[3]));
        ctx.lineTo(SPX(O, cq[1], cq[2], cq[3]), SPY(O, cq[2], cq[3]));
      }
      ctx.stroke();
    }
    if (masts.length) {
      /* stubby masts, which is what makes a hull read as machinery */
      ctx.strokeStyle = rgbaOf(toneMix(T, 0.55), 0.72);
      ctx.lineWidth = Math.max(0.5, O.L * 0.0026);
      ctx.beginPath();
      for (i = 0; i < masts.length; i++) {
        var mq = masts[i];
        ctx.moveTo(SPX(O, mq[0], mq[1], mq[3]), SPY(O, mq[1], mq[3]));
        ctx.lineTo(SPX(O, mq[0], mq[2], mq[3]), SPY(O, mq[2], mq[3]));
      }
      ctx.stroke();
    }
  }

  /* one greeble quad appended to the current path */
  function gQuadPath(ctx, O, q) {
    var a0 = q[0], a1 = q[1], t0 = q[2], t1 = q[3], r = q[4];
    ctx.moveTo(SPX(O, a0, r, t0), SPY(O, r, t0));
    ctx.lineTo(SPX(O, a1, r, t0), SPY(O, r, t0));
    ctx.lineTo(SPX(O, a1, r, t1), SPY(O, r, t1));
    ctx.lineTo(SPX(O, a0, r, t1), SPY(O, r, t1));
    ctx.closePath();
  }

  function gQuad(ctx, O, a0, a1, t0, t1, r) {
    ctx.beginPath();
    ctx.moveTo(SPX(O, a0, r, t0), SPY(O, r, t0));
    ctx.lineTo(SPX(O, a1, r, t0), SPY(O, r, t0));
    ctx.lineTo(SPX(O, a1, r, t1), SPY(O, r, t1));
    ctx.lineTo(SPX(O, a0, r, t1), SPY(O, r, t1));
    ctx.closePath();
  }

  /* painted markings. One accent stripe everywhere, plus a group-appropriate
     mark: hazard chevrons on the engine end, a roundel and a registry plate on
     the crew end. */
  function markPass(ctx, O, secs, item, rmax) {
    var aF = secs[item.i0][1], aA = secs[item.i1][1], spanA = aF - aA;
    if (!(spanA > 0.02)) return;
    var rnd = seq(item.sid * 5.1 + 29.3);
    var g = item.g;
    var hot = (g === 'engine' || g === 'mirror' || g === 'aft');
    var crew = (g === 'fore' || g === 'hub' || g === 'pod' || g === 'shield');

    /* accent stripe, gold only, running along the hull */
    var thS = O.bank + (0.35 + 0.30 * rnd()) * TAU;
    if (facing(O, thS) > 0.10) {
      contourAt(ctx, O, secs, item, thS, 1.0, rgba(200, 164, 92, 0.52), Math.max(0.7, O.L * 0.0045));
      contourAt(ctx, O, secs, item, thS + 0.03, 1.0, rgba(255, 240, 205, 0.18), Math.max(0.4, O.L * 0.0018));
    }

    if (hot) {
      var thC = O.bank + (rnd() - 0.5) * 0.9;
      if (facing(O, thC) > 0.12) {
        var nC = 6, i;
        var a0 = aA + spanA * 0.14, aw = spanA * 0.46 / nC;
        for (i = 0; i < nC; i++) {
          var aa = a0 + i * aw;
          var rr = hullR(secs, item.i0, item.i1, aa) * 1.004;
          ctx.fillStyle = (i % 2) ? rgba(212, 176, 100, 0.55) : rgba(24, 27, 32, 0.55);
          ctx.beginPath();
          ctx.moveTo(SPX(O, aa, rr, thC - 0.22), SPY(O, rr, thC - 0.22));
          ctx.lineTo(SPX(O, aa + aw, rr, thC), SPY(O, rr, thC));
          ctx.lineTo(SPX(O, aa, rr, thC + 0.22), SPY(O, rr, thC + 0.22));
          ctx.lineTo(SPX(O, aa - aw * 0.4, rr, thC), SPY(O, rr, thC));
          ctx.closePath();
          ctx.fill();
        }
      }
    }
    if (crew) {
      var thR = O.bank + (rnd() - 0.5) * 1.4;
      if (facing(O, thR) > 0.16) {
        var aR = aA + spanA * (0.45 + 0.25 * rnd());
        var rR = hullR(secs, item.i0, item.i1, aR) * 1.005;
        var dA = spanA * 0.055, dT = 0.30;
        ctx.fillStyle = rgba(20, 24, 30, 0.42);
        gQuad(ctx, O, aR - dA, aR + dA, thR - dT, thR + dT, rR);
        ctx.fill();
        ctx.strokeStyle = rgba(214, 224, 238, 0.32);
        ctx.lineWidth = Math.max(0.4, O.L * 0.0022);
        ctx.stroke();
        if (O.det >= 3) {
          /* fine tick block: reads as a registry plate without inventing text */
          ctx.beginPath();
          for (var q = 1; q < 6; q++) {
            var tq = thR - dT + (2 * dT) * (q / 6);
            ctx.moveTo(SPX(O, aR - dA * 0.6, rR, tq), SPY(O, rR, tq));
            ctx.lineTo(SPX(O, aR + dA * 0.6, rR, tq), SPY(O, rR, tq));
          }
          ctx.strokeStyle = rgba(226, 236, 250, 0.20);
          ctx.lineWidth = Math.max(0.3, O.L * 0.0013);
          ctx.stroke();
        }
      }
    }
  }

  /* rows of fasteners along the plating seams: one path, one fill */
  function fastenerPass(ctx, O, secs, item, rmax) {
    var i, k, drew = 0;
    var d = Math.max(0.5, O.L * 0.0022);
    ctx.beginPath();
    for (i = item.i0 + 1; i < item.i1; i++) {
      var r = secs[i][2];
      if (!(r * O.L > 6)) continue;
      var a = secs[i][1];
      for (k = 0; k < 10; k++) {
        var th = O.bank + (k / 10) * TAU;
        if (facing(O, th) <= 0.18) continue;
        var px = SPX(O, a, r * 1.004, th), py = SPY(O, r * 1.004, th);
        if (!fin(px) || !fin(py)) continue;
        ctx.rect(px - d * 0.5, py - d * 0.5, d, d);
        drew++;
      }
    }
    if (!drew) return;
    ctx.fillStyle = rgba(232, 240, 250, 0.16);
    ctx.fill();
  }

  /* lit portholes on the pressurized groups */
  function portPass(ctx, O, secs, item) {
    var g = item.g;
    if (g !== 'fore' && g !== 'hub' && g !== 'pod') return;
    var aF = secs[item.i0][1], aA = secs[item.i1][1], spanA = aF - aA;
    if (!(spanA > 0.03)) return;
    var th = O.bank + 0.62;
    if (facing(O, th) <= 0.20) th = O.bank - 0.62;
    if (facing(O, th) <= 0.20) return;
    var n = clamp(Math.round(Math.abs(spanA * O.L * O.cy) / (O.L * 0.024)), 3, 12);
    var d = Math.max(0.8, O.L * 0.0045);
    var i, drew = 0;
    ctx.beginPath();
    for (i = 0; i < n; i++) {
      var a = aA + spanA * (0.18 + 0.64 * (i / Math.max(1, n - 1)));
      var r = hullR(secs, item.i0, item.i1, a) * 1.004;
      if (!(r * O.L > 4)) continue;
      var px = SPX(O, a, r, th), py = SPY(O, r, th);
      if (!fin(px) || !fin(py)) continue;
      ctx.rect(px - d * 0.5, py - d * 0.5, d, d * 0.8);
      drew++;
    }
    if (!drew) return;
    ctx.fillStyle = rgba(255, 246, 216, 0.72);
    ctx.fill();
  }

  /* the specular streak. The brightest azimuth is the one whose screen normal
     points at the light; it is nudged a little toward the camera so the
     highlight lands on the surface instead of hugging the outline. */
  function specPass(ctx, O, secs, item, rmax) {
    var mx = O.sy * O.lx, my = -O.ly;
    var mag = Math.sqrt(mx * mx + my * my);
    if (!(mag > 0.02)) return;
    var thStar = Math.atan2(mx, my);
    var thNear = (O.cy >= 0) ? Math.PI / 2 : -Math.PI / 2;
    var ths = thStar + 0.38 * angWrap(thNear - thStar);
    if (facing(O, ths) <= 0.05) return;
    var k = clamp(0.42 + 0.58 * mag, 0, 1);
    contourAt(ctx, O, secs, item, ths, 1.0, rgba(255, 255, 255, 0.16 * k), Math.max(1, O.L * 0.014));
    contourAt(ctx, O, secs, item, ths, 1.0, rgba(255, 255, 255, 0.46 * k), Math.max(0.6, O.L * 0.004));
  }

  /* the drive lights the hull it is bolted to. Warm or cold per drive, only
     while the engine is running, and it obeys the light-theme rule: additive on
     dark, plain alpha on white. */
  function aftRimPass(ctx, O, secs, item, rmax) {
    if (O.th <= 0.02) return;
    if (Math.abs(O.cy) < 0.08) return;
    var aA = secs[item.i1][1], aF = secs[item.i0][1];
    var xA = SX(O, aA);
    var reach = O.L * (0.10 + 0.16 * O.th) * Math.abs(O.cy);
    var dirx = (O.cy >= 0) ? 1 : -1;
    var g = lgrad(ctx, xA, O.y, xA + dirx * reach, O.y);
    if (!g) return;
    var c = O.plumeCol;
    var k = clamp(0.42 * O.th, 0, 1);
    g.addColorStop(0, rgba(c[0], c[1], c[2], k));
    g.addColorStop(0.45, rgba(c[0], c[1], c[2], k * 0.34));
    g.addColorStop(1, rgba(c[0], c[1], c[2], 0));
    emissiveOn(ctx, O);
    ctx.fillStyle = g;
    itemBox(ctx, O, aF, aA, rmax);
    ctx.fill();
    emissiveOff(ctx);
  }

  function surfaceDetail(ctx, O, spec, item, secs, rmax) {
    var aF = secs[item.i0][1], aA = secs[item.i1][1];
    jointPass(ctx, O, aF, aA, rmax);
    seamPass(ctx, O, secs, item, rmax);
    if (O.det >= 2) {
      greeblePass(ctx, O, secs, item, rmax);
      markPass(ctx, O, secs, item, rmax);
    }
    if (O.det >= 3) {
      fastenerPass(ctx, O, secs, item, rmax);
      portPass(ctx, O, secs, item);
    }
    specPass(ctx, O, secs, item, rmax);
    radiatorPass(ctx, O, spec, item, secs);
    aftRimPass(ctx, O, secs, item, rmax);
  }

  /* the open throat of a bell or a magnetic mirror: a dark interior with a hot
     centre, so a tail-on view reads as an engine and not as a solid egg */
  function drawMouth(ctx, O, rg) {
    var asy = Math.abs(O.sy);
    if (asy < 0.06) return;
    var cx = SX(O, rg.a);
    var rx = Math.max(0.4, rg.R * O.L * asy), ry = rg.R * O.L;
    var i, f;
    var g = rgrad(ctx, cx, O.y, 0, cx, O.y, Math.max(rx, ry));
    if (g) {
      g.addColorStop(0, rgba(12, 14, 18, 0.95));
      g.addColorStop(0.62, rgba(26, 30, 36, 0.9));
      g.addColorStop(1, rgba(70, 76, 86, 0.55));
      ctx.fillStyle = g;
    } else ctx.fillStyle = rgba(20, 24, 30, 0.9);
    ctx.beginPath(); ellipsePath(ctx, cx, O.y, rx * 0.9, ry * 0.9); ctx.fill();

    var c = rg.glow || [255, 246, 226];
    var k = 0.22 + 0.78 * O.th;

    /* the inside of a bell is not a flat hole: cooling channels run from the
       lip down to the throat, and they are what tells the eye how deep it is.
       No clip is needed, every feature sits at a radius fraction below the one
       the dark interior fill already covers. */
    if (O.q && O.L > 70 && rx * ry > 40) {
      var nCh = O.det >= 2 ? 22 : 14;
      ctx.lineWidth = Math.max(0.4, O.L * 0.0022);
      ctx.beginPath();
      for (i = 0; i < nCh; i++) {
        var an = (i / nCh) * TAU;
        var ca = Math.cos(an), sa = Math.sin(an);
        ctx.moveTo(cx + rx * 0.90 * ca, O.y + ry * 0.90 * sa);
        ctx.lineTo(cx + rx * 0.10 * ca, O.y + ry * 0.10 * sa);
      }
      ctx.strokeStyle = rgba(148, 158, 174, 0.13);
      ctx.stroke();
      /* concentric stiffener rings, tighter as they approach the throat */
      for (i = 1; i <= 4; i++) {
        f = Math.pow(i / 5, 1.45);
        strokeEllipse(ctx, cx, O.y, rx * 0.9 * f, ry * 0.9 * f,
          rgba(142, 152, 168, 0.11), Math.max(0.35, O.L * 0.0018));
      }
      /* the lip catches the light from outside; the far wall stays black */
      var lg = lgrad(ctx, cx + rx * O.lx, O.y + ry * O.ly, cx - rx * O.lx, O.y - ry * O.ly);
      if (lg) {
        lg.addColorStop(0, rgba(226, 234, 246, 0.14));
        lg.addColorStop(0.30, rgba(10, 12, 16, 0.26));
        lg.addColorStop(1, rgba(0, 0, 0, 0.62));
        ctx.fillStyle = lg;
        ctx.beginPath(); ellipsePath(ctx, cx, O.y, rx * 0.9, ry * 0.9); ctx.fill();
      }
    }

    var hr = Math.max(rx, ry) * 0.62;
    var hg = rgrad(ctx, cx, O.y, 0, cx, O.y, hr);
    if (hg) {
      hg.addColorStop(0, rgba(255, 255, 255, 0.98 * k));
      hg.addColorStop(0.16, rgba(255, 255, 255, 0.92 * k));
      hg.addColorStop(0.34, rgba(c[0], c[1], c[2], 0.62 * k));
      hg.addColorStop(0.66, rgba(c[0], c[1], c[2], 0.20 * k));
      hg.addColorStop(1, rgba(c[0], c[1], c[2], 0));
      ctx.fillStyle = hg;
      ctx.beginPath(); ellipsePath(ctx, cx, O.y, rx * 0.62, ry * 0.62); ctx.fill();
    }
    /* the throat itself stays a hard bright point */
    fillEllipse(ctx, cx, O.y, Math.max(0.5, rx * 0.16), Math.max(0.5, ry * 0.16),
      rgba(255, 255, 255, 0.55 + 0.45 * O.th));
    /* at thrust the whole throat washes the bell interior */
    if (O.th > 0.02) {
      emissiveOn(ctx, O);
      var bl = rgrad(ctx, cx, O.y, 0, cx, O.y, Math.max(rx, ry) * 1.15);
      if (bl) {
        bl.addColorStop(0, rgba(c[0], c[1], c[2], clamp(0.42 * O.th, 0, 1)));
        bl.addColorStop(0.42, rgba(c[0], c[1], c[2], clamp(0.16 * O.th, 0, 1)));
        bl.addColorStop(1, rgba(c[0], c[1], c[2], 0));
        ctx.fillStyle = bl;
        ctx.beginPath();
        ellipsePath(ctx, cx, O.y, rx * 1.15, ry * 1.15);
        ctx.fill();
      }
      emissiveOff(ctx);
    }
    if (O.q && O.L > 70) {
      strokeEllipse(ctx, cx, O.y, rx * 0.9, ry * 0.9, rgba(220, 228, 240, 0.28), Math.max(0.5, O.L * 0.003));
    }
  }

  function drawTruss(ctx, O, spec, item) {
    var secs = spec.sections;
    var a0 = secs[item.i0][1], a1 = secs[item.i1][1];
    var r0 = secs[item.i0][2], r1 = secs[item.i1][2];
    var x0 = SX(O, a0), x1 = SX(O, a1);
    var span = Math.abs(x1 - x0);
    var tones = mat('graphite');
    ctx.strokeStyle = tones[2];
    ctx.lineWidth = Math.max(0.7, O.L * 0.006);
    if (span < 4) {
      ctx.fillStyle = tones[1];
      quad(ctx, x0 - 1, SY(O, r0), x0 + 1, SY(O, r0), x0 + 1, SY(O, -r0), x0 - 1, SY(O, -r0));
      ctx.fill();
      return;
    }
    ctx.beginPath();
    line(ctx, x0, SY(O, r0), x1, SY(O, r1));
    line(ctx, x0, SY(O, -r0), x1, SY(O, -r1));
    ctx.stroke();
    if (!O.q && span < 60) return;
    var n = Math.max(2, Math.min(16, Math.round(span / 16)));
    ctx.beginPath();
    for (var k = 0; k <= n; k++) {
      var f = k / n, xa = x0 + (x1 - x0) * f, ra = r0 + (r1 - r0) * f;
      line(ctx, xa, SY(O, ra), xa, SY(O, -ra));
      if (k < n) {
        var f2 = (k + 1) / n, xb = x0 + (x1 - x0) * f2, rb = r0 + (r1 - r0) * f2;
        if (k % 2 === 0) line(ctx, xa, SY(O, ra), xb, SY(O, -rb));
        else line(ctx, xa, SY(O, -ra), xb, SY(O, rb));
      }
    }
    ctx.lineWidth = Math.max(0.5, O.L * 0.0035);
    ctx.strokeStyle = tones[2];
    ctx.stroke();
  }

  function drawBoom(ctx, O, spec, item) {
    var secs = spec.sections;
    var a0 = secs[item.i0][1], a1 = secs[item.i1][1], r = secs[item.i0][2];
    var x0 = SX(O, a0), x1 = SX(O, a1);
    var tones = mat('graphite');
    var g = lgrad(ctx, 0, SY(O, r), 0, SY(O, -r));
    if (g) { g.addColorStop(0, tones[0]); g.addColorStop(0.5, tones[1]); g.addColorStop(1, tones[3]); }
    ctx.fillStyle = g || tones[1];
    quad(ctx, x0, SY(O, r), x1, SY(O, r), x1, SY(O, -r), x0, SY(O, -r));
    ctx.fill();
    var span = Math.abs(x1 - x0);
    if (!O.q || span < 30) return;
    /* collar nodes plus the engineering break that says the boom is drawn short */
    ctx.strokeStyle = tones[2];
    ctx.lineWidth = Math.max(0.5, O.L * 0.003);
    ctx.beginPath();
    var n = Math.max(2, Math.min(10, Math.round(span / 26)));
    for (var k = 1; k < n; k++) {
      var xa = x0 + (x1 - x0) * (k / n);
      line(ctx, xa, SY(O, r * 1.7), xa, SY(O, -r * 1.7));
    }
    ctx.stroke();
    var xm = (x0 + x1) * 0.5, w = Math.max(2, O.L * 0.012), h = r * O.L * 2.4;
    ctx.strokeStyle = rgba(210, 218, 228, 0.55);
    ctx.beginPath();
    line(ctx, xm - w, O.y + h, xm + w * 0.2, O.y - h);
    line(ctx, xm - w * 0.2, O.y + h, xm + w, O.y - h);
    ctx.stroke();
  }

  function drawDisc(ctx, O, rg) {
    var half = rg.thick * 0.5;
    var xF = SX(O, rg.a + half), xB = SX(O, rg.a - half);
    var ry = rg.R * O.L, rx = Math.max(0.4, rg.R * O.L * Math.abs(O.sy));
    var tones = mat(rg.m);
    var nearFront = (rg.a + half) * O.sy < (rg.a - half) * O.sy;
    var xNear = nearFront ? xF : xB, xFar = nearFront ? xB : xF;

    /* far face, then the rim band, then the near face */
    fillEllipse(ctx, xFar, O.y, rx, ry, tones[3]);
    var g = lgrad(ctx, 0, O.y - ry, 0, O.y + ry);
    if (g) { g.addColorStop(0, tones[2]); g.addColorStop(0.35, tones[1]); g.addColorStop(1, tones[3]); }
    ctx.fillStyle = g || tones[2];
    quad(ctx, xFar, O.y - ry, xNear, O.y - ry, xNear, O.y + ry, xFar, O.y + ry);
    ctx.fill();

    var gf = lgrad(ctx, xNear + rx * O.lx, O.y + ry * O.ly, xNear - rx * O.lx, O.y - ry * O.ly);
    if (gf) { gf.addColorStop(0, tones[0]); gf.addColorStop(0.5, tones[1]); gf.addColorStop(1, tones[2]); }
    fillEllipse(ctx, xNear, O.y, rx, ry, gf || tones[1]);
    if (O.L > 45) {
      strokeEllipse(ctx, xNear, O.y, rx, ry, rgba(30, 34, 40, 0.55), Math.max(0.5, O.L * 0.003));
      if (O.q && Math.abs(O.sy) > 0.12) {
        var fr = [0.72, 0.46, 0.24];
        for (var i = 0; i < fr.length; i++) {
          strokeEllipse(ctx, xNear, O.y, rx * fr[i], ry * fr[i], rgba(60, 66, 74, 0.35), Math.max(0.4, O.L * 0.002));
        }
      } else if (O.q) {
        ctx.strokeStyle = rgba(60, 66, 74, 0.30);
        ctx.lineWidth = Math.max(0.4, O.L * 0.002);
        ctx.beginPath();
        line(ctx, xNear - rx, O.y - ry * 0.55, xNear + rx, O.y - ry * 0.55);
        line(ctx, xNear - rx, O.y + ry * 0.55, xNear + rx, O.y + ry * 0.55);
        ctx.stroke();
      }
    }
  }

  function drawRing(ctx, O, rg) {
    var cx = SX(O, rg.a);
    var ry = rg.R * O.L, rx = Math.max(0.35, rg.R * O.L * Math.abs(O.sy));
    var lw = Math.max(1, rg.tube * 2 * O.L);
    var gold = rg.m === 'gold';
    var tones = gold ? [GOLD, GOLD_DK, '#6f5722'] : [mat(rg.m)[0], mat(rg.m)[1], mat(rg.m)[3]];
    var span = ry + lw;
    var g = lgrad(ctx, cx + rx * O.lx, O.y + span * O.ly, cx - rx * O.lx, O.y - span * O.ly);
    if (g) { g.addColorStop(0, tones[0]); g.addColorStop(0.34, tones[0]); g.addColorStop(0.66, tones[1]); g.addColorStop(1, tones[2]); }
    strokeEllipse(ctx, cx, O.y, rx, ry, g || tones[1], lw);
    if (O.q && O.L > 60) {
      strokeEllipse(ctx, cx, O.y, rx, ry - lw * 0.22, rgba(255, 255, 255, 0.28), Math.max(0.4, lw * 0.18));
    }
  }

  function drawSphere(ctx, O, rg) {
    var cx = SX(O, rg.a), r = rad(rg.R * O.L);
    if (rg.m === 'glow') {
      var pulse = 0.55 + 0.45 * O.th;
      var gg = rgrad(ctx, cx, O.y, 0, cx, O.y, r * 3.2);
      if (gg) {
        gg.addColorStop(0, rgba(238, 226, 255, 0.85 * pulse));
        gg.addColorStop(0.35, rgba(186, 150, 250, 0.34 * pulse));
        gg.addColorStop(1, rgba(140, 110, 220, 0));
        ctx.fillStyle = gg;
        ctx.beginPath(); ellipsePath(ctx, cx, O.y, r * 3.2, r * 3.2); ctx.fill();
      }
      fillEllipse(ctx, cx, O.y, r, r, rgba(250, 246, 255, 0.95));
      return;
    }
    var tones = mat(rg.m);
    var g = rgrad(ctx, cx + r * 0.47 * O.lx, O.y + r * 0.60 * O.ly, r * 0.04, cx, O.y, r);
    if (g) {
      g.addColorStop(0, tones[0]);
      g.addColorStop(0.42, tones[1]);
      g.addColorStop(0.82, tones[2]);
      g.addColorStop(1, tones[3]);
    }
    fillEllipse(ctx, cx, O.y, r, r, g || tones[1]);
    if (O.q && r > 6) {
      ctx.beginPath(); ellipsePath(ctx, cx, O.y, r, r);
      ctx.strokeStyle = rgba(215, 225, 240, 0.30);
      ctx.lineWidth = Math.max(0.5, r * 0.06);
      ctx.stroke();
      strokeEllipse(ctx, cx, O.y, Math.max(0.4, r * Math.abs(O.sy) * 0.55), r * 0.86, rgba(40, 46, 54, 0.25), Math.max(0.4, r * 0.05));
    }
  }

  function drawPanel(ctx, O, rg) {
    /* the plate lies along one azimuth, so bank swings it around the hull and
       the vertical foreshortening is cos(bank) exactly */
    var s = rg.sign, th = O.bank;
    var x0i = SPX(O, rg.a0, s * rg.i0, th), x0o = SPX(O, rg.a0, s * rg.o0, th);
    var x1i = SPX(O, rg.a1, s * rg.i1, th), x1o = SPX(O, rg.a1, s * rg.o1, th);
    var yi0 = SPY(O, s * rg.i0, th), yo0 = SPY(O, s * rg.o0, th);
    var yi1 = SPY(O, s * rg.i1, th), yo1 = SPY(O, s * rg.o1, th);
    var span = Math.abs(x1i - x0i);
    var tones = mat(s > 0 ? 'panelUp' : 'panelDn');

    if (span < 2.5) {
      /* edge on: the plate is a thin bar of its own thickness */
      var w = Math.max(1.1, rg.thick * O.L * Math.abs(O.sy));
      var xm = (x0i + x1i) * 0.5;
      ctx.fillStyle = tones[2];
      quad(ctx, xm - w, yi0, xm + w, yi0, xm + w, yo1, xm - w, yo1);
      ctx.fill();
      return;
    }
    var g = lgrad(ctx, (x0i + x1i) * 0.5, (yi0 + yi1) * 0.5, (x0o + x1o) * 0.5, (yo0 + yo1) * 0.5);
    if (g) {
      g.addColorStop(0, s > 0 ? '#7c6a5e' : '#5d5048');
      g.addColorStop(0.18, tones[2]);
      g.addColorStop(0.55, tones[1]);
      g.addColorStop(1, tones[0]);
    }
    ctx.fillStyle = g || tones[1];
    quad(ctx, x0i, yi0, x1i, yi1, x1o, yo1, x0o, yo0);
    ctx.fill();
    ctx.strokeStyle = rgba(24, 28, 34, 0.55);
    ctx.lineWidth = Math.max(0.5, O.L * 0.003);
    ctx.stroke();
    if (!O.q || span < 26) return;
    /* ribs at constant a: they crowd together as the panel turns away */
    var n = Math.max(2, Math.min(18, Math.round(span / 12)));
    var k, f;
    ctx.beginPath();
    for (k = 1; k < n; k++) {
      f = k / n;
      line(ctx, x0i + (x1i - x0i) * f, yi0 + (yi1 - yi0) * f, x0o + (x1o - x0o) * f, yo0 + (yo1 - yo0) * f);
    }
    ctx.strokeStyle = rgba(28, 33, 40, 0.30);
    ctx.lineWidth = Math.max(0.4, O.L * 0.002);
    ctx.stroke();
    ctx.beginPath();
    line(ctx, (x0i + x0o) * 0.5, (yi0 + yo0) * 0.5, (x1i + x1o) * 0.5, (yi1 + yo1) * 0.5);
    ctx.strokeStyle = rgba(230, 238, 248, 0.22);
    ctx.stroke();
    if (O.det < 2 || span < 44) return;
    /* micro fins across the plate, and the header pipe along its root */
    var m = Math.max(4, Math.min(46, Math.round(span / 5)));
    ctx.beginPath();
    for (k = 1; k < m; k++) {
      f = k / m;
      var xa = x0i + (x1i - x0i) * f, ya = yi0 + (yi1 - yi0) * f;
      var xb = x0o + (x1o - x0o) * f, yb = yo0 + (yo1 - yo0) * f;
      line(ctx, xa + (xb - xa) * 0.12, ya + (yb - ya) * 0.12, xa + (xb - xa) * 0.94, ya + (yb - ya) * 0.94);
    }
    ctx.strokeStyle = rgba(24, 29, 36, 0.16);
    ctx.lineWidth = Math.max(0.3, O.L * 0.0012);
    ctx.stroke();
    ctx.beginPath();
    line(ctx, x0i + (x0o - x0i) * 0.07, yi0 + (yo0 - yi0) * 0.07,
         x1i + (x1o - x1i) * 0.07, yi1 + (yo1 - yi1) * 0.07);
    ctx.strokeStyle = rgba(196, 206, 220, 0.34);
    ctx.lineWidth = Math.max(0.5, O.L * 0.004);
    ctx.stroke();
  }

  /* ------------------------------------------------------------------ *
   * moving parts. Every phase below is a pure function of O.t, so t = 0  *
   * is one fixed frame and a reduced-motion caller simply passes it.     *
   * ------------------------------------------------------------------ */

  /* a boom: an instrument or a magnetometer on the end of a stick. It sits
     at an azimuth on the hull, so bank swings it around with everything
     else, and it foreshortens through the same surface parametrization. */
  function drawMast(ctx, O, rg) {
    var th = O.bank + num(rg.th, 0);
    var r0 = num(rg.r0, 0.03), r1 = r0 + Math.max(0.004, num(rg.len, 0.1));
    var x0 = SPX(O, rg.a, r0, th), y0 = SPY(O, r0, th);
    var x1 = SPX(O, rg.a, r1, th), y1 = SPY(O, r1, th);
    if (!fin(x0) || !fin(y0) || !fin(x1) || !fin(y1)) return;
    var T = matRgb(rg.m || 'graphite');
    var fc = facing(O, th);
    var lit = clamp(0.30 + 0.50 * (fc * 0.5 + 0.5), 0, 1);
    var k, n, xa, ya;
    alpha(ctx, fc < -0.30 ? 0.66 : 1);
    /* the boom itself: a tapering three sided truss, not a hairline. Two
       rails a little apart plus their cross bracing is enough at this size. */
    var wOut = Math.max(1.3, O.L * 0.0095), wIn = Math.max(2, O.L * 0.017);
    var ux = (x1 - x0), uy = (y1 - y0);
    var ul = Math.sqrt(ux * ux + uy * uy);
    if (!(ul > 0.5)) { alpha(ctx, 1); return; }
    var px = -uy / ul, py = ux / ul;
    quad(ctx, x0 + px * wIn, y0 + py * wIn, x1 + px * wOut, y1 + py * wOut,
         x1 - px * wOut, y1 - py * wOut, x0 - px * wIn, y0 - py * wIn);
    ctx.fillStyle = rgbaOf(toneMix(T, lit * 0.55), 0.55);
    ctx.fill();
    ctx.strokeStyle = rgbaOf(toneMix(T, lit), 0.95);
    ctx.lineWidth = Math.max(0.6, O.L * 0.0030);
    ctx.beginPath();
    line(ctx, x0 + px * wIn, y0 + py * wIn, x1 + px * wOut, y1 + py * wOut);
    line(ctx, x0 - px * wIn, y0 - py * wIn, x1 - px * wOut, y1 - py * wOut);
    ctx.stroke();
    if (O.q && O.L > 60) {
      n = clamp(Math.round((r1 - r0) / 0.022), 3, 10);
      ctx.beginPath();
      for (k = 0; k <= n; k++) {
        var f = k / n, w = wIn + (wOut - wIn) * f;
        xa = x0 + ux * f; ya = y0 + uy * f;
        line(ctx, xa + px * w, ya + py * w, xa - px * w, ya - py * w);
        if (k < n) {
          var f2 = (k + 1) / n, w2 = wIn + (wOut - wIn) * f2;
          var xb = x0 + ux * f2, yb = y0 + uy * f2;
          if (k % 2 === 0) line(ctx, xa + px * w, ya + py * w, xb - px * w2, yb - py * w2);
          else line(ctx, xa - px * w, ya - py * w, xb + px * w2, yb + py * w2);
        }
      }
      ctx.strokeStyle = rgbaOf(toneMix(T, lit * 0.8), 0.62);
      ctx.lineWidth = Math.max(0.4, O.L * 0.0020);
      ctx.stroke();
    }
    /* the instrument at the end of it, as a box in the (station, radius)
       plane: sized through gQuad it collapses to nothing, because a few
       hundredths of a radian at this radius is three pixels of arc */
    var tp = num(rg.tip, 0);
    if (tp > 0.001) {
      var bx = function (da, dr) {
        return [SPX(O, rg.a + da, r1 + dr, th), SPY(O, r1 + dr, th)];
      };
      var c0 = bx(-tp, -tp * 0.62), c1 = bx(tp, -tp * 0.62);
      var c2 = bx(tp, tp * 0.62), c3 = bx(-tp, tp * 0.62);
      quad(ctx, c0[0], c0[1], c1[0], c1[1], c2[0], c2[1], c3[0], c3[1]);
      var bg = lgrad(ctx, c3[0], c3[1], c0[0], c0[1]);
      if (bg) {
        bg.addColorStop(0, rgbaOf(toneMix(T, clamp(lit + 0.30, 0, 1)), 1));
        bg.addColorStop(1, rgbaOf(toneMix(T, clamp(lit - 0.16, 0, 1)), 1));
        ctx.fillStyle = bg;
      } else ctx.fillStyle = rgbaOf(toneMix(T, clamp(lit + 0.2, 0, 1)), 0.96);
      ctx.fill();
      ctx.strokeStyle = rgba(20, 24, 30, 0.6);
      ctx.lineWidth = Math.max(0.4, O.L * 0.0024);
      ctx.stroke();
      if (O.det >= 1) {
        var d0 = bx(-tp * 0.55, tp * 0.10), d1 = bx(tp * 0.55, tp * 0.10);
        var d2 = bx(tp * 0.55, tp * 0.44), d3 = bx(-tp * 0.55, tp * 0.44);
        quad(ctx, d0[0], d0[1], d1[0], d1[1], d2[0], d2[1], d3[0], d3[1]);
        ctx.fillStyle = rgba(236, 244, 254, 0.32);
        ctx.fill();
      }
    }
    alpha(ctx, 1);
  }

  /* The probe's high-gain antenna. It is aimed BACKWARD along the route
     because it is talking to the place it left, and it hunts by a fraction
     of a degree the whole time, which is the moving part.
     The rim is a real circle in the plane normal to the aim, so the dish
     turns into a line edge on and into a full disc face on. */
  var DISH_N = 30;
  function dishBasis(O, rg) {
    var wob = num(rg.wob, 0.085);
    var sd = num(rg.sid, 7);
    var phi = O.aim + wob * Math.sin(O.t * 0.21 + h1(sd) * TAU)
                    + wob * 0.4 * Math.sin(O.t * 0.53 + h1(sd + 3) * TAU);
    var chi = O.bank + 0.30 * Math.sin(O.t * 0.13 + h1(sd + 7) * TAU);
    var cp = Math.cos(phi), sp = Math.sin(phi), cc = Math.cos(chi), sc = Math.sin(chi);
    return {
      nf: cp, nu: sp * cc, ns: sp * sc,
      t1f: -sp, t1u: cp * cc, t1s: cp * sc,
      t2f: 0, t2u: -sc, t2s: cc,
      mf: rg.a, mu: num(rg.mount, 0) * cc, ms: num(rg.mount, 0) * sc
    };
  }
  function drawDish(ctx, O, rg) {
    var B = dishBasis(O, rg);
    var R = Math.max(0.01, num(rg.R, 0.1));
    var dep = num(rg.depth, R * 0.36);
    if (!fin(B.nf) || !fin(B.nu) || !fin(B.ns)) return;
    var i, x, yy;
    /* the pylon that holds it off the bus */
    var px0 = P3X(O, rg.a, 0, 0), py0 = P3Y(O, rg.a, 0, 0);
    var px1 = P3X(O, B.mf, B.mu, B.ms), py1 = P3Y(O, B.mf, B.mu, B.ms);
    if (fin(px0) && fin(py0) && fin(px1) && fin(py1)) {
      ctx.strokeStyle = mat('graphite')[2];
      ctx.lineWidth = Math.max(0.7, O.L * 0.006);
      ctx.beginPath(); line(ctx, px0, py0, px1, py1); ctx.stroke();
    }
    /* the rim, as a polygon: an ellipse in general position */
    var xs = new Array(DISH_N), ys = new Array(DISH_N), okAll = true;
    for (i = 0; i < DISH_N; i++) {
      var ps2 = (i / DISH_N) * TAU;
      var cw = Math.cos(ps2) * R, sw = Math.sin(ps2) * R;
      x = P3X(O, B.mf + cw * B.t1f + sw * B.t2f, B.mu + cw * B.t1u + sw * B.t2u,
              B.ms + cw * B.t1s + sw * B.t2s);
      yy = P3Y(O, 0, B.mu + cw * B.t1u + sw * B.t2u, 0);
      if (!fin(x) || !fin(yy)) { okAll = false; break; }
      xs[i] = x; ys[i] = yy;
    }
    if (!okAll) return;
    /* which face are we looking at */
    var nd = P3D(O, B.nf, B.nu, B.ns);
    var conc = nd > 0;
    var lo = xs[0], hi = xs[0], ylo = ys[0], yhi = ys[0];
    for (i = 1; i < DISH_N; i++) {
      if (xs[i] < lo) lo = xs[i]; if (xs[i] > hi) hi = xs[i];
      if (ys[i] < ylo) ylo = ys[i]; if (ys[i] > yhi) yhi = ys[i];
    }
    var cx = (lo + hi) * 0.5, cy2 = (ylo + yhi) * 0.5;
    var span = Math.max(1.2, Math.max(hi - lo, yhi - ylo) * 0.5);
    ctx.beginPath();
    ctx.moveTo(xs[0], ys[0]);
    for (i = 1; i < DISH_N; i++) ctx.lineTo(xs[i], ys[i]);
    ctx.closePath();
    var T = matRgb(rg.m || 'shield');
    var g;
    if (conc) {
      /* the bowl: dark at the rim, brighter toward the middle */
      g = rgrad(ctx, cx, cy2, 0, cx, cy2, span * 1.05);
      if (g) {
        g.addColorStop(0, rgbaOf(toneMix(T, 0.78), 1));
        g.addColorStop(0.55, rgbaOf(toneMix(T, 0.46), 1));
        g.addColorStop(1, rgbaOf(toneMix(T, 0.10), 1));
      }
    } else {
      g = lgrad(ctx, cx + span * O.lx, cy2 + span * O.ly, cx - span * O.lx, cy2 - span * O.ly);
      if (g) {
        g.addColorStop(0, rgbaOf(toneMix(T, 0.88), 1));
        g.addColorStop(0.5, rgbaOf(toneMix(T, 0.48), 1));
        g.addColorStop(1, rgbaOf(toneMix(T, 0.14), 1));
      }
    }
    ctx.fillStyle = g || rgbaOf(toneMix(T, 0.5), 1);
    ctx.fill();
    if (O.L > 40) {
      /* the rim lip: a thick bright edge is most of what says "dish" at a
         glance, and it survives every angle the aim can take */
      ctx.strokeStyle = rgbaOf(toneMix(T, conc ? 0.95 : 0.55), 0.95);
      ctx.lineWidth = Math.max(1, O.L * 0.0075);
      ctx.stroke();
      ctx.strokeStyle = rgba(18, 22, 28, 0.6);
      ctx.lineWidth = Math.max(0.4, O.L * 0.0026);
      ctx.stroke();
    }
    if (!O.q || span < 6) return;
    /* reflector panels: concentric rings plus radial seams, drawn inside the
       rim by construction so no clip is needed */
    var rings = O.det >= 2 ? 4 : 2, k;
    ctx.lineWidth = Math.max(0.35, O.L * 0.0018);
    ctx.beginPath();
    for (k = 1; k <= rings; k++) {
      var f = k / (rings + 1);
      for (i = 0; i <= DISH_N; i++) {
        var pa = (i % DISH_N) / DISH_N * TAU;
        var cw2 = Math.cos(pa) * R * f, sw2 = Math.sin(pa) * R * f;
        var xx = P3X(O, B.mf + cw2 * B.t1f + sw2 * B.t2f, 0, B.ms + cw2 * B.t1s + sw2 * B.t2s);
        var yy2 = P3Y(O, 0, B.mu + cw2 * B.t1u + sw2 * B.t2u, 0);
        if (i === 0) ctx.moveTo(xx, yy2); else ctx.lineTo(xx, yy2);
      }
    }
    ctx.strokeStyle = rgba(18, 22, 28, conc ? 0.24 : 0.34);
    ctx.stroke();
    var nSeam = O.det >= 2 ? 12 : 8;
    ctx.beginPath();
    for (k = 0; k < nSeam; k++) {
      var pb = (k / nSeam) * TAU;
      var cw3 = Math.cos(pb), sw3 = Math.sin(pb);
      ctx.moveTo(P3X(O, B.mf, 0, B.ms), P3Y(O, 0, B.mu, 0));
      ctx.lineTo(P3X(O, B.mf + cw3 * R * B.t1f + sw3 * R * B.t2f, 0, B.ms + cw3 * R * B.t1s + sw3 * R * B.t2s),
                 P3Y(O, 0, B.mu + cw3 * R * B.t1u + sw3 * R * B.t2u, 0));
    }
    ctx.strokeStyle = rgba(18, 22, 28, conc ? 0.20 : 0.28);
    ctx.stroke();
    /* the feed horn on its tripod, out at the focus, only when we can see
       into the dish */
    if (conc && O.det >= 1) {
      var ff = B.mf + B.nf * dep * 1.5, fu = B.mu + B.nu * dep * 1.5, fsd = B.ms + B.ns * dep * 1.5;
      var fx = P3X(O, ff, fu, fsd), fy = P3Y(O, 0, fu, 0);
      if (fin(fx) && fin(fy)) {
        ctx.strokeStyle = rgba(206, 216, 230, 0.55);
        ctx.lineWidth = Math.max(0.4, O.L * 0.0022);
        ctx.beginPath();
        for (k = 0; k < 3; k++) {
          var pc = (k / 3) * TAU + 0.4;
          var cw4 = Math.cos(pc) * R * 0.86, sw4 = Math.sin(pc) * R * 0.86;
          line(ctx, fx, fy,
            P3X(O, B.mf + cw4 * B.t1f + sw4 * B.t2f, 0, B.ms + cw4 * B.t1s + sw4 * B.t2s),
            P3Y(O, 0, B.mu + cw4 * B.t1u + sw4 * B.t2u, 0));
        }
        ctx.stroke();
        var fr = Math.max(0.8, R * O.L * 0.13);
        fillEllipse(ctx, fx, fy, fr, fr, rgbaOf(toneMix(T, 0.9), 1));
        strokeEllipse(ctx, fx, fy, fr, fr, rgba(22, 26, 32, 0.6), Math.max(0.4, O.L * 0.002));
      }
    }
  }

  /* The generation ship's habitat ring. It turns, continuously and slowly,
     and the spokes and the modules bolted to it are what makes the turning
     visible: a bare torus of revolution looks identical at every angle.
     Drawn far half, hub, near half, so it reads as a ring around a hub
     rather than a flat hoop.

     A point on the ring at azimuth ps is (a, R cos ps, R sin ps) in the
     (forward, up, side) frame, so its depth is R sin ps * cy and the near
     half is the one whose sign matches nearSide(O). */
  function drawHabRing(ctx, O, rg) {
    var R = Math.max(0.02, num(rg.R, 0.28));
    var tube = Math.max(0.004, num(rg.tube, 0.028));
    var hub = Math.max(0.008, num(rg.hub, 0.05));
    var a = num(rg.a, 0);
    var spin = O.t * num(rg.spin, 0.26) + h1(num(rg.sid, 3)) * TAU;
    var nSp = clamp(Math.round(num(rg.spokes, 6)), 3, 10);
    var nMod = clamp(Math.round(num(rg.mods, 10)), 4, 16);
    var cx = SX(O, a), ry = R * O.L, rx = Math.max(0.35, R * O.L * Math.abs(O.sy));
    if (!fin(cx) || !(ry > 0)) return;
    var lw = Math.max(1, tube * 2 * O.L);
    var T = matRgb(rg.m || 'steel');
    var tones = mat(rg.m || 'steel');
    var side = nearSide(O);
    /* the axial offset that puts a face toward the camera */
    var nearA = (O.sy >= 0) ? -1 : 1;
    /* the modules are beads strung ON the tube, not paddles sticking out of
       it: they wrap it radially and cover most of their own arc, so the
       ring reads as a segmented habitat rather than a circular saw */
    var mw = (TAU / nMod) * 0.40, mh = tube * 1.10, ma = tube * 1.15;
    var big = ry > 26;

    /* one torus half, as a stroked half ellipse */
    function halfTorus(sd, lit) {
      var g = lgrad(ctx, cx, O.y - (ry + lw), cx, O.y + (ry + lw));
      if (g) {
        g.addColorStop(0, tones[lit ? 0 : 2]);
        g.addColorStop(0.44, tones[lit ? 1 : 3]);
        g.addColorStop(1, tones[3]);
        ctx.strokeStyle = g;
      } else ctx.strokeStyle = tones[lit ? 1 : 3];
      ctx.lineWidth = lw;
      ctx.beginPath();
      halfEllipsePath(ctx, cx, O.y, rx, ry, sd);
      ctx.stroke();
      if (!lit || !O.q || !big) return;
      /* a bright edge along one side of the tube, which is what makes it read
         as a tube instead of a painted band */
      var k = Math.max(0.05, 1 - lw * 0.30 / ry);
      ctx.lineWidth = Math.max(0.4, lw * 0.17);
      ctx.strokeStyle = rgba(255, 255, 255, 0.24);
      ctx.beginPath();
      halfEllipsePath(ctx, cx, O.y, rx * k, ry * k, sd);
      ctx.stroke();
    }
    /* spokes: a strut per bay plus its bracing, so they read as structure */
    function spokes(near) {
      var k, ps, d, c0, s0;
      ctx.strokeStyle = rgbaOf(toneMix(T, near ? 0.60 : 0.18), 0.92);
      ctx.lineWidth = Math.max(0.7, O.L * 0.0052);
      ctx.beginPath();
      for (k = 0; k < nSp; k++) {
        ps = spin + (k / nSp) * TAU;
        d = Math.sin(ps) * O.cy;
        if ((d > 0) !== near) continue;
        c0 = Math.cos(ps); s0 = Math.sin(ps);
        line(ctx, P3X(O, a, hub * c0, hub * s0), P3Y(O, 0, hub * c0, 0),
                  P3X(O, a, R * c0, R * s0), P3Y(O, 0, R * c0, 0));
      }
      ctx.stroke();
      if (!O.q || !big) return;
      ctx.strokeStyle = rgbaOf(toneMix(T, near ? 0.36 : 0.12), 0.7);
      ctx.lineWidth = Math.max(0.4, O.L * 0.0022);
      ctx.beginPath();
      for (k = 0; k < nSp; k++) {
        ps = spin + (k / nSp) * TAU;
        d = Math.sin(ps) * O.cy;
        if ((d > 0) !== near) continue;
        var pn = ps + TAU / nSp, rm = hub + (R - hub) * 0.55;
        line(ctx, P3X(O, a, rm * Math.cos(ps), rm * Math.sin(ps)), P3Y(O, 0, rm * Math.cos(ps), 0),
                  P3X(O, a, R * Math.cos(pn), R * Math.sin(pn)), P3Y(O, 0, R * Math.cos(pn), 0));
      }
      ctx.stroke();
    }
    /* The habitat modules: blocks straddling the ring, drawn as a shadowed
       plate at the far station and a lit one at the near station. All four
       corners of a plate sit at ONE station, which is what keeps them boxes
       instead of the twisted ribbons a mixed-station quad gives. */
    function plate(ps, rIn, rOut, at) {
      var c0 = Math.cos(ps - mw), s0 = Math.sin(ps - mw);
      var c1 = Math.cos(ps + mw), s1 = Math.sin(ps + mw);
      ctx.moveTo(P3X(O, at, rIn * c0, rIn * s0), P3Y(O, 0, rIn * c0, 0));
      ctx.lineTo(P3X(O, at, rOut * c0, rOut * s0), P3Y(O, 0, rOut * c0, 0));
      ctx.lineTo(P3X(O, at, rOut * c1, rOut * s1), P3Y(O, 0, rOut * c1, 0));
      ctx.lineTo(P3X(O, at, rIn * c1, rIn * s1), P3Y(O, 0, rIn * c1, 0));
      ctx.closePath();
    }
    function modules(near) {
      var k, ps, d, drew = 0, lit = [];
      var rIn = R - tube * 1.10, rOut = R + mh;
      ctx.beginPath();
      for (k = 0; k < nMod; k++) {
        ps = spin + 0.31 + (k / nMod) * TAU;
        d = Math.sin(ps) * O.cy;
        if ((d > 0) !== near) continue;
        plate(ps, rIn, rOut, a - ma * nearA);
        drew++;
      }
      if (!drew) return;
      ctx.fillStyle = rgbaOf(toneMix(T, near ? 0.28 : 0.09), 1);
      ctx.fill();
      /* the outward face of each box, which is what turns two flat plates into
         a solid: it spans both stations at the outer radius */
      ctx.beginPath();
      for (k = 0; k < nMod; k++) {
        ps = spin + 0.31 + (k / nMod) * TAU;
        d = Math.sin(ps) * O.cy;
        if ((d > 0) !== near) continue;
        var e0 = Math.cos(ps - mw), f0 = Math.sin(ps - mw);
        var e1 = Math.cos(ps + mw), f1 = Math.sin(ps + mw);
        ctx.moveTo(P3X(O, a - ma, rOut * e0, rOut * f0), P3Y(O, 0, rOut * e0, 0));
        ctx.lineTo(P3X(O, a + ma, rOut * e0, rOut * f0), P3Y(O, 0, rOut * e0, 0));
        ctx.lineTo(P3X(O, a + ma, rOut * e1, rOut * f1), P3Y(O, 0, rOut * e1, 0));
        ctx.lineTo(P3X(O, a - ma, rOut * e1, rOut * f1), P3Y(O, 0, rOut * e1, 0));
        ctx.closePath();
      }
      ctx.fillStyle = rgbaOf(toneMix(T, near ? 0.46 : 0.14), 1);
      ctx.fill();
      ctx.beginPath();
      for (k = 0; k < nMod; k++) {
        ps = spin + 0.31 + (k / nMod) * TAU;
        d = Math.sin(ps) * O.cy;
        if ((d > 0) !== near) continue;
        plate(ps, rIn, rOut, a + ma * nearA);
        if (near) lit.push(ps);
      }
      var g = lgrad(ctx, 0, O.y - ry - lw, 0, O.y + ry + lw);
      if (g) {
        g.addColorStop(0, rgbaOf(toneMix(T, near ? 0.92 : 0.34), 1));
        g.addColorStop(0.46, rgbaOf(toneMix(T, near ? 0.62 : 0.22), 1));
        g.addColorStop(1, rgbaOf(toneMix(T, near ? 0.24 : 0.08), 1));
        ctx.fillStyle = g;
      } else ctx.fillStyle = rgbaOf(toneMix(T, near ? 0.6 : 0.2), 1);
      ctx.fill();
      if (O.L > 60) {
        ctx.strokeStyle = rgba(18, 22, 28, 0.55);
        ctx.lineWidth = Math.max(0.4, O.L * 0.0022);
        ctx.stroke();
      }
      /* lit windows, the only reason to draw a habitat at all */
      if (!near || O.det < 1 || !lit.length || !big) return;
      var wr = Math.max(0.8, O.L * 0.0042), rw = R + mh * 0.62;
      ctx.beginPath();
      for (k = 0; k < lit.length; k++) {
        var j;
        for (j = -1; j <= 1; j++) {
          var pj = lit[k] + j * mw * 0.56;
          var cw = Math.cos(pj), sw = Math.sin(pj);
          var wx = P3X(O, a + ma * nearA, rw * cw, rw * sw), wy = P3Y(O, 0, rw * cw, 0);
          if (!fin(wx) || !fin(wy)) continue;
          ctx.rect(wx - wr, wy - wr * 0.66, wr * 2, wr * 1.32);
        }
      }
      ctx.fillStyle = rgba(255, 240, 196, 0.95);
      ctx.fill();
    }

    halfTorus(-side, false);
    spokes(false);
    modules(false);
    /* the hub the spokes land on */
    var hy = hub * O.L, hx = Math.max(0.4, hub * O.L * Math.abs(O.sy));
    var hg = lgrad(ctx, cx + hx * O.lx, O.y + hy * O.ly, cx - hx * O.lx, O.y - hy * O.ly);
    if (hg) { hg.addColorStop(0, tones[0]); hg.addColorStop(0.5, tones[1]); hg.addColorStop(1, tones[3]); }
    fillEllipse(ctx, cx, O.y, hx, hy, hg || tones[1]);
    if (O.L > 50) strokeEllipse(ctx, cx, O.y, hx, hy, rgba(24, 28, 34, 0.5), Math.max(0.4, O.L * 0.0026));
    spokes(true);
    halfTorus(side, true);
    modules(true);
    /* the gold trim the rest of the ship carries */
    if (O.L > 60) {
      ctx.lineWidth = Math.max(0.4, lw * 0.14);
      ctx.strokeStyle = rgba(200, 164, 92, 0.5);
      ctx.beginPath();
      halfEllipsePath(ctx, cx, O.y, rx, ry + lw * 0.36, side);
      ctx.stroke();
    }
  }

  /* ------------------------------------------------------------------ *
   * exhausts. Drawn behind the hull; length collapses as the ship turns  *
   * tail on, where a nozzle glow (drawn after the hull) takes over.      *
   * ------------------------------------------------------------------ */
  function plumeDir(O) { return -O.cy; }

  /* On the light theme the sky is nearly white and a pale exhaust disappears
     into it. Every plume lays a soft dark taper down first, so the beam has
     something to sit on, and skips the additive pass that would just saturate
     to white. Dark theme: no backing, and the core goes on additively. */
  function plumeShade(ctx, O, x0, y0, dlen, w0, w1) {
    if (!O.light || O.th <= 0.001) return;
    /* three nested tapers instead of one: a single quad leaves a hard grey
       edge that reads as a paper triangle over a white sky */
    var pads = [1.22, 0.96, 0.70], alps = [0.11, 0.13, 0.15], k;
    for (k = 0; k < pads.length; k++) {
      var e = 0.94 - k * 0.06;
      var g = lgrad(ctx, x0, y0, x0 + dlen * e, y0);
      if (g) {
        g.addColorStop(0, rgba(18, 24, 42, alps[k] * O.th));
        g.addColorStop(0.45, rgba(18, 24, 42, alps[k] * 0.52 * O.th));
        g.addColorStop(1, rgba(18, 24, 42, 0));
        ctx.fillStyle = g;
      } else ctx.fillStyle = rgba(18, 24, 42, alps[k] * 0.6 * O.th);
      var wa = w0 * pads[k], wb = w1 * pads[k];
      quad(ctx, x0, y0 - wa, x0 + dlen * e, y0 - wb,
           x0 + dlen * e, y0 + wb, x0, y0 + wa);
      ctx.fill();
    }
  }
  /* additive only where it helps: over a white sky "lighter" is a no-op */
  function emissiveOn(ctx, O) {
    if (!O.light) ctx.globalCompositeOperation = 'lighter';
  }
  function emissiveOff(ctx) { ctx.globalCompositeOperation = 'source-over'; }

  /* seeded particle streaks riding the beam. Deterministic in t: each streak's
     position is a fractional part of its own phase plus t, so it cycles down
     the plume forever without any stored state. */
  function plumeStreaks(ctx, O, tx, ty, d, len, wAt, col, n, seed, gain) {
    var i;
    for (i = 0; i < n; i++) {
      var ph = h1(seed + i * 3.137);
      var sp = 0.24 + 0.62 * h1(seed + i * 7.71);
      var s = frac(ph + O.t * sp);
      var w = wAt(s);
      var off = (h1(seed + i * 11.33) - 0.5) * 1.7 * w;
      var ll = len * (0.055 + 0.180 * h1(seed + i * 5.19));
      var x0 = tx + d * len * s;
      var x1 = x0 + d * ll;
      var yy = ty + off;
      var a = clamp(Math.pow(1 - s, 1.5) * gain * O.th, 0, 1);
      if (a < 0.012) continue;
      var hh = Math.max(0.3, w * 0.085);
      var g = lgrad(ctx, x0, yy, x1, yy);
      if (g) {
        g.addColorStop(0, rgba(col[0], col[1], col[2], a));
        g.addColorStop(1, rgba(col[0], col[1], col[2], 0));
        ctx.fillStyle = g;
      } else ctx.fillStyle = rgba(col[0], col[1], col[2], a * 0.6);
      quad(ctx, x0, yy - hh, x1, yy - hh * 0.4, x1, yy + hh * 0.4, x0, yy + hh);
      ctx.fill();
    }
  }

  /* ion: a thin, faint, very long blue lance. Almost no flare, because an
     electrostatic drive throws a very small mass very fast and there is
     nothing luminous to see except the neutralized beam itself. */
  function drawIonPlume(ctx, O, spec) {
    var th = O.th; if (th <= 0.001) return;
    var d = plumeDir(O), L = O.L;
    var len = L * (1.0 + 3.4 * th);
    var noz = spec.nozzles, i, k;
    var COL = [172, 212, 255];
    for (i = 0; i < noz.length; i++) {
      var oy = SPY(O, noz[i], O.bank);
      var ox = SPX(O, spec.tailA, noz[i], O.bank);
      var w0 = L * 0.0058 * (0.55 + 0.45 * th);
      var w1 = L * 0.0175 * (0.55 + 0.45 * th);
      plumeShade(ctx, O, ox, oy, d * len, w0 * 2.4, w1 * 1.5);
      emissiveOn(ctx, O);
      /* three nested passes: a wide, almost invisible haze, the beam itself,
         and a hard thread. An electrostatic beam is genuinely faint, so the
         width does the work and the alpha stays low. */
      var lift = O.light ? 1.5 : 1;
      var lay = [[3.6, 0.055 * lift, 96, 146, 236], [1.0, 0.24 * lift, 150, 198, 252],
                 [0.34, 0.62 * lift, 236, 248, 255]];
      for (k = 0; k < lay.length; k++) {
        var q0 = w0 * lay[k][0], q1 = w1 * lay[k][0];
        var reach = k === 2 ? 0.55 : 1;
        var col = lay[k];
        var g = lgrad(ctx, ox, oy, ox + d * len * reach, oy);
        if (g) {
          g.addColorStop(0, rgba(col[2], col[3], col[4], clamp(lay[k][1] * th * 1.25, 0, 1)));
          g.addColorStop(0.10, rgba(col[2], col[3], col[4], clamp(lay[k][1] * th, 0, 1)));
          g.addColorStop(0.48, rgba(col[2], col[3], col[4], clamp(lay[k][1] * th * 0.42, 0, 1)));
          g.addColorStop(1, rgba(col[2], col[3], col[4], 0));
          ctx.fillStyle = g;
        } else ctx.fillStyle = rgba(col[2], col[3], col[4], clamp(lay[k][1] * th * 0.6, 0, 1));
        var e2 = ox + d * len * reach;
        var qe = q0 + (q1 - q0) * reach;
        quad(ctx, ox, oy - q0, e2, oy - qe, e2, oy + qe, ox, oy + q0);
        ctx.fill();
      }
      /* faint standing diamonds, packed close to the grid where the beam is
         still dense enough to glow */
      if (!O.q || Math.abs(d) < 0.12) { emissiveOff(ctx); continue; }
      for (k = 0; k < 5; k++) {
        var s = 0.016 + k * 0.026;
        var br = (1 - k * 0.18) * (0.55 + 0.25 * Math.sin(O.t * 2.1 + k * 1.7));
        var dx = ox + d * len * s;
        var hw = Math.max(0.6, L * 0.010 * Math.abs(d));
        var hh = (w0 + (w1 - w0) * s) * 1.35;
        ctx.beginPath();
        ctx.moveTo(dx - hw, oy); ctx.lineTo(dx, oy - hh); ctx.lineTo(dx + hw, oy); ctx.lineTo(dx, oy + hh);
        ctx.closePath();
        ctx.fillStyle = rgba(235, 246, 255, clamp(0.34 * br * th, 0, 1));
        ctx.fill();
      }
      if (O.det >= 1) {
        plumeStreaks(ctx, O, ox, oy, d, len,
          (function (a0, a1) { return function (s) { return (a0 + (a1 - a0) * s) * 0.55; }; })(w0, w1),
          COL, 5, 101 + i * 13, 0.16);
      }
      emissiveOff(ctx);
    }
  }

  /* one tapered cone from the nozzle, as a polygon. Used by the layered fusion
     plume; the layers stack additively so the cross section falls off smoothly
     instead of ending in the hard polygon edge a single fill would leave. */
  function conePoly(ctx, tx, ty, d, len, wAt, k, n) {
    var i, s;
    ctx.beginPath();
    for (i = 0; i <= n; i++) {
      s = i / n;
      ctx.lineTo(tx + d * len * s, ty - wAt(s) * k);
    }
    for (i = n; i >= 0; i--) {
      s = i / n;
      ctx.lineTo(tx + d * len * s, ty + wAt(s) * k);
    }
    ctx.closePath();
  }

  /* fusion: a brilliant white-blue cone, dense enough to read as a wall of
     plasma, with the standing shock pattern a real over-expanded nozzle leaves
     and the magnetic coils squeezing it at the throat. */
  function drawFusionPlume(ctx, O, spec) {
    var th = O.th; if (th <= 0.001) return;
    var d = plumeDir(O), L = O.L;
    var flick = 0.9 + 0.16 * (vnoise(O.t * 6.3) - 0.5) * 2;
    var len = L * (0.52 + 1.10 * th) * flick;
    var tx = SX(O, spec.tailA), ty = O.y;
    var w0 = L * 0.104 * (0.5 + 0.5 * th);
    var n = O.q ? 22 : 8, i;
    /* the width profile is sampled once and then interpolated: it is asked for
       hundreds of times per frame across the nested cones, and each raw
       evaluation costs two exponentials and a noise lookup */
    var WN = 32, prof = new Array(WN + 1), pi;
    for (pi = 0; pi <= WN; pi++) {
      var ps = pi / WN;
      var pinch = 1
        - 0.34 * Math.exp(-Math.pow((ps - 0.055) / 0.045, 2))
        - 0.22 * Math.exp(-Math.pow((ps - 0.135) / 0.06, 2));
      var wob = 1 + 0.07 * (vnoise(ps * 5 + O.t * 4.1) - 0.5);
      prof[pi] = w0 * pinch * (0.52 + 0.66 * ps) * wob;
    }
    function widthAt(s) {
      var f = clamp(s, 0, 1) * WN;
      var j = Math.floor(f); if (j >= WN) return prof[WN];
      return prof[j] + (prof[j + 1] - prof[j]) * (f - j);
    }
    plumeShade(ctx, O, tx, ty, d * len, widthAt(0) * 1.5, widthAt(1) * 1.5);
    emissiveOn(ctx, O);

    /* nested cones: outermost is a wide faint blue haze, innermost a hard
       white core. Six of them at low alpha give a soft edge for free. */
    /* the light theme cannot composite additively, so the falloff has to come
       from more, finer layers or the cone shows its polygon steps */
    var NL = O.q ? 9 : 2;
    var COLS = [[92, 136, 220], [126, 172, 246], [162, 204, 255],
                [206, 232, 255], [238, 249, 255], [255, 255, 252]];
    for (i = 0; i < NL; i++) {
      var f = NL > 1 ? i / (NL - 1) : 1;
      var wk = (1.34 - 1.02 * f) * (O.light ? 0.82 : 1);
      var reach = 1 - 0.42 * f * f;
      var col = COLS[Math.round(f * (COLS.length - 1))];
      var aPk = (0.07 + 0.60 * Math.pow(f, 1.7)) * th * (O.light ? 1.55 : 1);
      var gg = lgrad(ctx, tx, ty, tx + d * len * reach, ty);
      if (gg) {
        gg.addColorStop(0, rgba(col[0], col[1], col[2], clamp(aPk, 0, 1)));
        gg.addColorStop(0.16, rgba(col[0], col[1], col[2], clamp(aPk * 0.82, 0, 1)));
        gg.addColorStop(0.52, rgba(col[0], col[1], col[2], clamp(aPk * 0.34, 0, 1)));
        gg.addColorStop(1, rgba(col[0], col[1], col[2], 0));
        ctx.fillStyle = gg;
      } else ctx.fillStyle = rgba(col[0], col[1], col[2], clamp(aPk * 0.6, 0, 1));
      conePoly(ctx, tx, ty, d, len * reach, widthAt, wk, n);
      ctx.fill();
    }

    if (Math.abs(d) < 0.1) { emissiveOff(ctx); return; }

    /* shock diamonds. A real torch exhaust leaves the nozzle over- or
       under-expanded and the standing wave pattern repeats down the plume with
       a spacing that grows as the jet spreads and weakens. Each node is sized
       from the local beam width so it always sits inside the cone. */
    var sd = 0.030, gap = 0.050;
    for (i = 0; i < 8; i++) {
      var br = Math.pow(1 - sd, 2.6) * (0.74 + 0.20 * Math.sin(O.t * 5.3 + i * 1.31));
      if (br <= 0.02 || sd > 0.62) break;
      var dx = tx + d * len * sd;
      var hh = widthAt(sd) * 0.40;
      var hw = Math.max(0.7, hh * 1.35 * Math.abs(d));
      var ng = rgrad(ctx, dx, ty, 0, dx, ty, Math.max(hw, hh));
      if (ng) {
        ng.addColorStop(0, rgba(255, 254, 248, clamp(0.60 * br * th, 0, 1)));
        ng.addColorStop(0.42, rgba(226, 242, 255, clamp(0.26 * br * th, 0, 1)));
        ng.addColorStop(1, rgba(178, 214, 255, 0));
        ctx.fillStyle = ng;
        ctx.beginPath(); ellipsePath(ctx, dx, ty, hw, hh); ctx.fill();
      }
      sd += gap;
      gap *= 1.26;
    }
    if (O.det >= 1) {
      plumeStreaks(ctx, O, tx, ty, d, len, widthAt, [222, 240, 255], 16, 233, 0.26);
    }
    /* the magnetic coils, tight on the throat where the field actually pinches
       the beam. Kept thin and translucent so they read as field hardware and
       not as hoops floating in the exhaust. */
    for (i = 0; i < 3; i++) {
      var sr = 0.012 + i * 0.026;
      var ry2 = widthAt(sr) * 1.32;
      var rx2 = Math.max(0.5, ry2 * Math.abs(O.sy) * 0.85 + O.L * 0.006);
      strokeEllipse(ctx, tx + d * len * sr, ty, rx2, ry2,
        rgba(206, 234, 255, clamp((0.52 - i * 0.13) * th, 0, 1)),
        Math.max(0.8, L * 0.008));
    }
    emissiveOff(ctx);
  }

  /* anti: a blinding pink-white pencil. The pion shower does not reach a
     material wall, so the beam forms at a standoff point clear of the mirror
     and that standoff is the brightest thing on the ship. */
  function drawAntiPlume(ctx, O, spec) {
    var th = O.th;
    var d = plumeDir(O), L = O.L;
    var k0 = 0.25 + 0.75 * th;
    /* gamma bloom around the mirror survives even at idle */
    var bx = SX(O, -0.36), br = L * 0.36;
    var bg = rgrad(ctx, bx, O.y, 0, bx, O.y, br);
    if (bg) {
      bg.addColorStop(0, rgba(246, 216, 248, 0.20 * k0));
      bg.addColorStop(0.45, rgba(206, 156, 236, 0.10 * k0));
      bg.addColorStop(1, rgba(168, 124, 224, 0));
      ctx.fillStyle = bg;
      ctx.beginPath(); ellipsePath(ctx, bx, O.y, br, br); ctx.fill();
    }
    if (th <= 0.001) return;
    var len = L * (1.4 + 3.6 * th);
    var tx = SX(O, spec.tailA), ty = O.y;
    var w = L * 0.0090 * (0.55 + 0.45 * th);
    var ex = tx + d * len;
    plumeShade(ctx, O, tx, ty, d * len, w * 3.0, w * 1.2);
    emissiveOn(ctx, O);

    /* the standoff: a hard, small, blinding node just aft of the throat */
    var sx = tx + d * L * 0.055;
    var sr = L * (0.030 + 0.052 * th);
    var sg = rgrad(ctx, sx, ty, 0, sx, ty, sr);
    if (sg) {
      sg.addColorStop(0, rgba(255, 255, 255, clamp(0.98 * th, 0, 1)));
      sg.addColorStop(0.20, rgba(255, 238, 252, clamp(0.72 * th, 0, 1)));
      sg.addColorStop(0.46, rgba(255, 186, 236, clamp(0.30 * th, 0, 1)));
      sg.addColorStop(1, rgba(240, 150, 220, 0));
      ctx.fillStyle = sg;
      ctx.beginPath(); ellipsePath(ctx, sx, ty, sr, sr); ctx.fill();
    }

    var g = lgrad(ctx, tx, ty, ex, ty);
    if (g) {
      g.addColorStop(0, rgba(255, 250, 254, 1 * th));
      g.addColorStop(0.10, rgba(255, 220, 246, 0.72 * th));
      g.addColorStop(0.44, rgba(248, 176, 232, 0.30 * th));
      g.addColorStop(1, rgba(226, 146, 220, 0));
      ctx.fillStyle = g;
    } else ctx.fillStyle = rgba(255, 214, 244, 0.5 * th);
    quad(ctx, tx, ty - w * 1.8, ex, ty - w * 0.42, ex, ty + w * 0.42, tx, ty + w * 1.8);
    ctx.fill();
    /* the needle core, kept nearly white so it reads as too bright to look at */
    var ng = lgrad(ctx, tx, ty, tx + d * len * 0.86, ty);
    if (ng) {
      ng.addColorStop(0, rgba(255, 255, 255, clamp(0.96 * th, 0, 1)));
      ng.addColorStop(0.55, rgba(255, 246, 253, clamp(0.72 * th, 0, 1)));
      ng.addColorStop(1, rgba(255, 232, 250, 0));
      ctx.fillStyle = ng;
    } else ctx.fillStyle = rgba(255, 255, 255, 0.9 * th);
    quad(ctx, tx, ty - w * 0.50, tx + d * len * 0.86, ty - w * 0.13,
         tx + d * len * 0.86, ty + w * 0.13, tx, ty + w * 0.50);
    ctx.fill();
    if (O.det >= 1 && Math.abs(d) > 0.1) {
      plumeStreaks(ctx, O, tx, ty, d, len,
        (function (ww) { return function (s) { return ww * (1.8 - 1.35 * s); }; })(w),
        [255, 206, 242], 7, 577, 0.26);
    }
    emissiveOff(ctx);
  }

  function drawExhaust(ctx, O, spec, key) {
    ctx.save();
    if (key === 'ion') drawIonPlume(ctx, O, spec);
    else if (key === 'anti') drawAntiPlume(ctx, O, spec);
    else drawFusionPlume(ctx, O, spec);
    ctx.restore();
  }

  /* when the tail points at the camera the beam has nowhere to go, so the
     nozzle itself glows. Drawn after the hull because it is in front of it. */
  function drawTailGlow(ctx, O, spec, key) {
    var th = O.th;
    if (th <= 0.001) return;
    var face = 1 - Math.abs(O.cy);
    if (face < 0.55) return;
    if (O.sy < 0) return;
    var cx = SX(O, spec.tailA), r = Math.max(1.5, spec.tailR * O.L * (0.9 + 0.6 * th)) * 1.7;
    var col = key === 'ion' ? [186, 219, 255] : (key === 'anti' ? [255, 214, 244] : [255, 250, 240]);
    var g = rgrad(ctx, cx, O.y, 0, cx, O.y, r);
    var k = clamp((face - 0.55) / 0.45, 0, 1) * th;
    if (g) {
      g.addColorStop(0, rgba(255, 255, 255, 0.75 * k));
      g.addColorStop(0.3, rgba(col[0], col[1], col[2], 0.32 * k));
      g.addColorStop(1, rgba(col[0], col[1], col[2], 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ellipsePath(ctx, cx, O.y, r, r); ctx.fill();
    }
  }

  /* Navigation beacons. One period for the whole fleet, a per-beacon phase
     out of the same hashed noise everything else uses, so no two lights on a
     ship blink together and nothing here needs Math.random or stored state.
     At t = 0 this is one fixed frame, which is the reduced-motion render. */
  var BEACON_PERIOD = 2.1;
  var BEACON_COL = {
    gold: [[200, 164, 92], [232, 200, 130]],
    white: [[176, 190, 208], [236, 244, 255]]
  };
  /* The wave-4 single nav light, kept verbatim for a caller that has not
     opted into hulls. It is the whole reason `hull: undefined` and
     `hull: 'crewed'` are not the same call: the geometry is identical, the
     wave-5 moving parts are not, and an un-upgraded caller gets the render it
     already had, to the pixel. */
  function drawNavLegacy(ctx, O, spec) {
    var nav = spec.beacons && spec.beacons[0];
    if (!nav) return;
    var ph = frac(O.t * 0.62);
    var on = (ph < 0.07) || (ph > 0.13 && ph < 0.19);
    var x = SPX(O, nav.a, nav.up, O.bank), y = SPY(O, nav.up, O.bank);
    var r = Math.max(0.8, O.L * 0.008);
    var far = facing(O, O.bank) < 0;
    alpha(ctx, far ? 0.42 : 1);
    ctx.fillStyle = on ? GOLD : GOLD_DK;
    ctx.beginPath(); ellipsePath(ctx, x, y, r, r); ctx.fill();
    if (!on || O.L < 40) { alpha(ctx, 1); return; }
    var g = rgrad(ctx, x, y, 0, x, y, r * 5);
    if (g) {
      g.addColorStop(0, rgba(232, 200, 130, 0.55));
      g.addColorStop(1, rgba(200, 164, 92, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ellipsePath(ctx, x, y, r * 5, r * 5); ctx.fill();
    }
    alpha(ctx, 1);
  }
  function drawBeacons(ctx, O, spec) {
    var bs = spec.beacons;
    if (!bs || !bs.length) return;
    var i, r = Math.max(0.8, O.L * 0.008);
    for (i = 0; i < bs.length; i++) {
      var b = bs[i];
      var ph = frac(O.t / BEACON_PERIOD + num(b.ph, 0));
      var on = (ph < 0.055) || (ph > 0.100 && ph < 0.155);
      var th = O.bank + num(b.th, 0);
      var x = SPX(O, b.a, b.up, th), y = SPY(O, b.up, th);
      if (!fin(x) || !fin(y)) continue;
      var pair = BEACON_COL[b.col] || BEACON_COL.gold;
      var c = on ? pair[1] : pair[0];
      /* a beacon on the far side of the hull still shows, just dimmer */
      var far = facing(O, th) < 0;
      alpha(ctx, far ? 0.42 : 1);
      ctx.fillStyle = on ? rgba(c[0], c[1], c[2], 1) : rgba(pair[0][0], pair[0][1], pair[0][2], 0.85);
      ctx.beginPath(); ellipsePath(ctx, x, y, r, r); ctx.fill();
      if (on && O.L >= 40) {
        var g = rgrad(ctx, x, y, 0, x, y, r * 5);
        if (g) {
          g.addColorStop(0, rgba(c[0], c[1], c[2], 0.55));
          g.addColorStop(1, rgba(pair[0][0], pair[0][1], pair[0][2], 0));
          ctx.fillStyle = g;
          ctx.beginPath(); ellipsePath(ctx, x, y, r * 5, r * 5); ctx.fill();
        }
      }
      alpha(ctx, 1);
    }
  }

  /* ------------------------------------------------------------------ *
   * hull emissives. Waste heat on the torch ships, an accelerator grid   *
   * on the plasma liner. Both scale with thrust and both go through the  *
   * light-theme emissive rule.                                           *
   * ------------------------------------------------------------------ */
  /* Waste heat on the torch ships. Drawn inside the hull clip and following the
     real profile radius, so the strips are painted ON the structure instead of
     floating past its edge, and hotter where the drive is. */
  function radiatorPass(ctx, O, spec, item, secs) {
    var em = spec.emit;
    if (!em || !em.length) return;
    var i, k, s;
    for (i = 0; i < em.length; i++) {
      var e = em[i];
      if (e.type !== 'radiator' || e.g !== item.g) continue;
      var heat = clamp(e.idle + (1 - e.idle) * O.th, 0, 1);
      if (heat <= 0.02) continue;
      var c = e.col;
      var n = O.det >= 3 ? 10 : (O.det >= 2 ? 7 : 4);
      var steps = 4;
      /* one gradient for the whole set: every strip runs the same way along the
         axis, so they can share it, and the fins batch into three alpha buckets
         instead of costing a gradient and a stroke each */
      var buck = [[], [], []];
      for (k = 0; k < n; k++) {
        var th = O.bank + e.th0 + (k / n) * TAU * e.wrap;
        var fc = facing(O, th);
        if (fc <= 0.06) continue;
        buck[fc > 0.55 ? 2 : (fc > 0.26 ? 1 : 0)].push(th);
      }
      var xA = SX(O, e.a0), xB = SX(O, e.a1);
      var base = clamp(heat * 0.80, 0, 1);
      var bAlp = [0.30, 0.70, 1];
      emissiveOn(ctx, O);
      ctx.lineWidth = Math.max(0.6, O.L * e.w);
      for (var bi = 0; bi < 3; bi++) {
        if (!buck[bi].length) continue;
        var aK = clamp(base * bAlp[bi], 0, 1);
        if (aK < 0.02) continue;
        var g = lgrad(ctx, xA, O.y, xB, O.y);
        if (g) {
          g.addColorStop(0, rgba(c[0], c[1], c[2], aK));
          g.addColorStop(0.6, rgba(c[0], c[1], c[2], aK * 0.40));
          g.addColorStop(1, rgba(c[0], c[1], c[2], 0));
          ctx.strokeStyle = g;
        } else ctx.strokeStyle = rgba(c[0], c[1], c[2], aK * 0.55);
        ctx.beginPath();
        for (k = 0; k < buck[bi].length; k++) {
          for (s = 0; s <= steps; s++) {
            var a = e.a0 + (e.a1 - e.a0) * (s / steps);
            var r = hullR(secs, item.i0, item.i1, a) * 1.006;
            var xx = SPX(O, a, r, buck[bi][k]), yy = SPY(O, r, buck[bi][k]);
            if (s === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
          }
        }
        ctx.stroke();
      }
      emissiveOff(ctx);
    }
  }

  function drawGrids(ctx, O, spec) {
    var em = spec.emit;
    if (!em || !em.length) return;
    var i, k;
    for (i = 0; i < em.length; i++) {
      var e = em[i];
      if (e.type !== 'grid') continue;
      var lit = clamp(e.idle + (1 - e.idle) * O.th, 0, 1);
      if (lit <= 0.02) continue;
      var c = e.col;
      var asy = Math.abs(O.sy);
      var u = num(e.u, 0);
      var cx = SPX(O, e.a, u, O.bank), cyG = SPY(O, u, O.bank);
      var ry = e.R * O.L, rx = Math.max(0.4, ry * asy);
      if (ry < 1) continue;
      emissiveOn(ctx, O);
      var g = rgrad(ctx, cx, cyG, 0, cx, cyG, Math.max(rx, ry) * 1.9);
      if (g) {
        g.addColorStop(0, rgba(255, 255, 255, 0.72 * lit));
        g.addColorStop(0.34, rgba(c[0], c[1], c[2], 0.42 * lit));
        g.addColorStop(1, rgba(c[0], c[1], c[2], 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ellipsePath(ctx, cx, cyG, rx * 1.9, ry * 1.9); ctx.fill();
      }
      /* the grid itself: concentric apertures, visible only when we are not
         looking straight along the beam */
      if (O.det >= 1 && asy > 0.10) {
        for (k = 1; k <= 3; k++) {
          strokeEllipse(ctx, cx, cyG, rx * (k / 3.4), ry * (k / 3.4),
            rgba(c[0], c[1], c[2], clamp(0.55 * lit, 0, 1)), Math.max(0.4, O.L * 0.003));
        }
      }
      emissiveOff(ctx);
    }
  }

  /* far away the ship is a few pixels: a legible dart beats a lost silhouette */
  function drawTiny(ctx, O, spec, key) {
    var half = O.L * 0.5, hx = half * O.cy;
    var hh = Math.max(1.3, O.L * 0.15);
    if (O.th > 0.01) {
      var d = plumeDir(O), len = O.L * (0.45 + 0.9 * O.th);
      var col = key === 'ion' ? [170, 210, 255] : (key === 'anti' ? [255, 214, 244] : [235, 244, 255]);
      var g = lgrad(ctx, O.x - hx, O.y, O.x - hx + d * len, O.y);
      if (g) {
        g.addColorStop(0, rgba(col[0], col[1], col[2], 0.85 * O.th));
        g.addColorStop(1, rgba(col[0], col[1], col[2], 0));
        ctx.fillStyle = g;
      } else ctx.fillStyle = rgba(col[0], col[1], col[2], 0.6 * O.th);
      quad(ctx, O.x - hx, O.y - hh * 0.5, O.x - hx + d * len, O.y - hh * 0.22,
        O.x - hx + d * len, O.y + hh * 0.22, O.x - hx, O.y + hh * 0.5);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.moveTo(O.x + hx, O.y);
    ctx.lineTo(O.x + hx * 0.1, O.y - hh);
    ctx.lineTo(O.x - hx, O.y - hh * 0.55);
    ctx.lineTo(O.x - hx, O.y + hh * 0.55);
    ctx.lineTo(O.x + hx * 0.1, O.y + hh);
    ctx.closePath();
    var bg = lgrad(ctx, 0, O.y - hh, 0, O.y + hh);
    if (bg) { bg.addColorStop(0, '#dfe6f0'); bg.addColorStop(0.5, '#b0bac7'); bg.addColorStop(1, '#4d545e'); }
    ctx.fillStyle = bg || '#b0bac7';
    ctx.fill();
  }

  /* ------------------------------------------------------------------ *
   * the public draw                                                     *
   * ------------------------------------------------------------------ */
  function keyFromOpts(opts) {
    if (!opts) return 'fusion';
    if (typeof opts === 'string') return DRIVES[opts] ? opts : 'fusion';
    var k = opts.key || opts.ship || opts.kind;
    if (typeof k === 'string' && DRIVES[k]) return k;
    var i = opts.index;
    if (!fin(i)) i = opts.i;
    if (fin(i)) {
      i = Math.round(i);
      if (i >= 0 && i < SHIPS.length) return SHIPS[i].key;
    }
    return 'fusion';
  }
  /* The mass class, and the wave-4 opt out.
     Exactly as `bank` and `lightDir` did in v3, `hull` has a pinned default
     that leaves an un-upgraded caller alone, and here that default is the
     whole wave-4 render: crewed geometry AND the wave-4 nav light, with the
     gimbal off. Naming one of the three hulls (or a valid hullIndex) selects
     a hull and turns the wave-5 moving parts on. Anything else at all,
     undefined, null, NaN, a typo, is the pinned default. */
  function hullFromOpts(opts) {
    if (!opts || typeof opts === 'string') return null;
    var h = opts.hull;
    if (typeof h === 'string' && HULL_SET[h]) return h;
    var i = opts.hullIndex;
    if (fin(i)) {
      i = Math.round(i);
      if (i >= 0 && i < HULL_LIST.length) return HULL_LIST[i].key;
    }
    return null;
  }

  /* the engine gimbal, as a screen rotation about the joint it swings on */
  function gimPush(ctx, gx, gy, ang) {
    ctx.save();
    ctx.translate(gx, gy);
    ctx.rotate(ang);
    ctx.translate(-gx, -gy);
  }

  /* the colour the drive throws on its own hull */
  var DRIVE_COL = {
    ion: [168, 208, 255],
    fusion: [226, 240, 255],
    anti: [255, 208, 242]
  };

  function drawShip(ctx, x, y, px, yaw, opts) {
    if (!ctx || typeof ctx.beginPath !== 'function') return;
    if (typeof opts === 'string') opts = { key: opts };
    opts = opts || {};
    var key = keyFromOpts(opts);
    var asked = hullFromOpts(opts);
    var hull = asked || 'crewed';
    var spec = specOf(key, hull);
    var L = clamp(px, 4, 900);
    var flip = clamp(opts.flip, 0, 1);
    var yw = num(yaw, 0) + Math.PI * smooth(flip);
    var q = (opts.quality === 0 || L < 56) ? 0 : 1;
    var O = {
      x: num(x, 0), y: num(y, 0), L: L,
      cy: Math.cos(yw), sy: Math.sin(yw),
      t: num(opts.t, 0),
      q: q,
      th: clamp(opts.thrust, 0, 1),
      light: !!opts.light,
      /* v3: roll about the long axis, radians, positive = right wing down */
      bank: clamp(num(opts.bank, 0), -Math.PI, Math.PI),
      /* v3: screen angle pointing TOWARD the light, VoyageArt's convention */
      ld: num(opts.lightDir, Math.PI),
      /* v4: where the probe's high-gain dish is pointed, measured from the
         nose. The default is back the way the ship came, because that is
         where whoever launched it is. */
      aim: num(opts.dishAim, Math.PI - 0.30),
      hull: hull,
      plumeCol: DRIVE_COL[key] || DRIVE_COL.fusion,
      lx: 0, ly: -1,
      /* procedural detail tier: cheap when small, rich when close */
      det: q ? (L >= 240 ? 3 : (L >= 150 ? 2 : (L >= 88 ? 1 : 0))) : 0
    };
    if (!fin(O.cy) || !fin(O.sy)) return;
    lightVec(O);

    /* The engine gimbals while it is running: under a degree, slow, and it
       swings the plume with it. Scaled by |cy| because this is a screen
       rotation standing in for a pitch, and tail on there is no pitch to
       see. A million tonne ship moves its bell less than a probe does.
       Only for a caller that asked for a hull, so the wave-4 render is
       untouched. */
    var gimA = num(spec.gimA, -0.2);
    var gim = !asked ? 0 : num(spec.gimK, 0.04) * O.th * Math.abs(O.cy) *
      (0.72 * Math.sin(O.t * 0.61 + h1(gimA * 37 + 5) * TAU) +
       0.28 * Math.sin(O.t * 0.29 + h1(gimA * 91 + 11) * TAU));
    if (!fin(gim) || Math.abs(gim) < 1e-4) gim = 0;
    var gimX = SX(O, gimA), gimY = O.y;
    if (!fin(gimX) || !fin(gimY)) gim = 0;

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    alpha(ctx, 1);

    /* Below about 14 px the lathed hull is mush and a legible dart reads
       better; above it the real ship is drawn, however small the marker. */
    if (L < 14) { drawTiny(ctx, O, spec, key); ctx.restore(); return; }

    if (gim) gimPush(ctx, gimX, gimY, gim);
    drawExhaust(ctx, O, spec, key);
    if (gim) ctx.restore();

    var items = spec._items, i;
    var fwd = O.sy >= 0;
    for (i = 0; i < items.length; i++) {
      var it = items[fwd ? i : (items.length - 1 - i)];
      var swung = gim && it.a < gimA;
      if (swung) gimPush(ctx, gimX, gimY, gim);
      ctx.save();
      if (it.kind === 'group') {
        if (it.type === 'truss') drawTruss(ctx, O, spec, it);
        else if (it.type === 'boom') drawBoom(ctx, O, spec, it);
        else drawLathe(ctx, O, spec, it);
      } else {
        var rg = it.rig;
        if (rg.type === 'disc') drawDisc(ctx, O, rg);
        else if (rg.type === 'ring') drawRing(ctx, O, rg);
        else if (rg.type === 'sphere') drawSphere(ctx, O, rg);
        else if (rg.type === 'panel') drawPanel(ctx, O, rg);
        else if (rg.type === 'mouth') drawMouth(ctx, O, rg);
        else if (rg.type === 'dish') drawDish(ctx, O, rg);
        else if (rg.type === 'mast') drawMast(ctx, O, rg);
        else if (rg.type === 'habring') drawHabRing(ctx, O, rg);
      }
      alpha(ctx, 1);
      ctx.restore();
      if (swung) ctx.restore();
    }

    if (gim) gimPush(ctx, gimX, gimY, gim);
    drawGrids(ctx, O, spec);
    drawTailGlow(ctx, O, spec, key);
    if (gim) ctx.restore();
    if (asked) drawBeacons(ctx, O, spec);
    else drawNavLegacy(ctx, O, spec);
    ctx.restore();
  }

  /* ------------------------------------------------------------------ *
   * chemical burn plume for the interplanetary departure and capture     *
   * ------------------------------------------------------------------ */
  function drawChemPlume(ctx, x, y, px, ang, power, t, opts) {
    if (!ctx || typeof ctx.beginPath !== 'function') return;
    var p = clamp(power, 0, 1);
    if (p <= 0.002) return;
    var light = !!(opts && opts.light);
    var L = clamp(px, 4, 900);
    var a = num(ang, 0);
    var tt = num(t, 0);
    var len = L * (0.35 + 0.85 * p);
    var wid = L * 0.10 * (0.5 + 0.7 * p);
    ctx.save();
    ctx.translate(num(x, 0), num(y, 0));
    ctx.rotate(a);
    /* Over a dark sky the puffs go on additively, which is what turns a stack
       of thin translucent oranges into flame instead of the brown smear that
       plain alpha compositing produced. Over the light theme "lighter" would
       just saturate to white, so it stays source-over with fuller alphas and a
       soft dark backing behind the whole plume. */
    if (light) {
      var sh = rgrad(ctx, 0, 0, 0, len * 0.45, 0, len * 1.05);
      if (sh) {
        sh.addColorStop(0, rgba(60, 28, 14, 0.30 * p));
        sh.addColorStop(1, rgba(60, 28, 14, 0));
        ctx.fillStyle = sh;
        ctx.beginPath(); ellipsePath(ctx, len * 0.45, 0, len * 0.62, wid * 2.1); ctx.fill();
      }
    } else {
      ctx.globalCompositeOperation = 'lighter';
    }
    var n = 7, i;
    for (i = 0; i < n; i++) {
      var s = (i + 0.4) / n;
      var jit = 0.85 + 0.3 * vnoise(i * 3.7 + tt * 3.2);
      var bx = s * len;
      var br = rad(wid * (0.42 + 1.35 * Math.pow(s, 0.7)) * jit);
      var al = Math.pow(1 - s, 1.2) * (light ? 0.78 : 0.62) * p;
      var g = rgrad(ctx, bx - br * 0.2, 0, 0, bx, 0, br);
      if (g) {
        g.addColorStop(0, rgba(255, 250, 232, clamp(al * 1.25, 0, 1)));
        g.addColorStop(0.30, rgba(255, 206, 128, al));
        g.addColorStop(0.66, rgba(248, 146, 62, al * 0.72));
        g.addColorStop(1, rgba(226, 104, 44, 0));
        ctx.fillStyle = g;
      } else ctx.fillStyle = rgba(255, 200, 120, al);
      ctx.beginPath(); ellipsePath(ctx, bx, 0, br, br * 0.92); ctx.fill();
    }
    /* hot core near the nozzle */
    var cw = wid * 0.62 * (0.8 + 0.2 * vnoise(tt * 5.1));
    var cg = lgrad(ctx, 0, 0, len * 0.55, 0);
    if (cg) {
      cg.addColorStop(0, rgba(255, 255, 248, clamp(1 * p, 0, 1)));
      cg.addColorStop(0.35, rgba(255, 238, 190, 0.85 * p));
      cg.addColorStop(0.72, rgba(255, 196, 108, 0.45 * p));
      cg.addColorStop(1, rgba(255, 170, 80, 0));
      ctx.fillStyle = cg;
    } else ctx.fillStyle = rgba(255, 235, 190, 0.8 * p);
    ctx.beginPath();
    ctx.moveTo(0, -cw);
    ctx.quadraticCurveTo(len * 0.30, -cw * 0.55, len * 0.62, 0);
    ctx.quadraticCurveTo(len * 0.30, cw * 0.55, 0, cw);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /* ------------------------------------------------------------------ *
   * DOM preview turntable                                               *
   * ------------------------------------------------------------------ */
  function ctxOf(target) {
    if (!target) return null;
    if (typeof target.getContext === 'function') return target.getContext('2d');
    if (target.canvas && typeof target.beginPath === 'function') return target;
    return null;
  }
  function canvasOf(target, ctx) {
    if (target && typeof target.getContext === 'function') return target;
    return ctx && ctx.canvas ? ctx.canvas : null;
  }

  /* opts (all optional): { hull, light, still }.
     `still` is the reduced-motion render: one frame at t = 0 held at a three
     quarter view, which freezes the turntable, the habitat ring, the tracking
     dish, the gimbal and the beacons together. */
  function drawShipTurntable(target, key, t, opts) {
    var ctx = ctxOf(target);
    if (!ctx) return;
    var canvas = canvasOf(target, ctx);
    var w = 0, h = 0;
    if (canvas) {
      w = num(canvas.clientWidth, 0) || num(canvas.width, 0);
      h = num(canvas.clientHeight, 0) || num(canvas.height, 0);
    }
    if (!(w > 0) || !(h > 0)) return;
    ctx.save();
    if (typeof ctx.setTransform === 'function') ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, num(canvas.width, w) || w, num(canvas.height, h) || h);
    ctx.restore();
    opts = opts || {};
    var still = !!opts.still;
    /* naming the hull is what opts into the wave-5 moving parts, so a three
       argument call keeps drawing exactly what it always drew */
    var hk = HULL_SET[opts.hull] ? opts.hull : null;
    var tt = still ? 0 : num(t, 0);
    var hh = halfHeightOf(key, hk || 'crewed');
    var px = clamp(Math.min(w * 0.80, (h * 0.44) / hh), 12, 420);
    var thrust = 0.22 + 0.07 * (0.5 + 0.5 * Math.sin(tt * 1.6));
    drawShip(ctx, w * 0.54, h * 0.5, px, still ? 0.62 : tt * 0.5, {
      key: key, hull: hk, thrust: thrust, t: tt, quality: (w < 150 ? 0 : 1), flip: 0,
      light: !!opts.light
    });
  }

  /* ------------------------------------------------------------------ *
   * console demo: three ships, thrust ramps, one chemical burn           *
   * ------------------------------------------------------------------ */
  function __demo(canvas) {
    var ctx = ctxOf(canvas);
    if (!ctx) return null;
    var cv = canvasOf(canvas, ctx);
    var stopped = false, t0 = 0;
    function frame(ms) {
      if (stopped) return;
      if (!t0) t0 = ms;
      var t = (ms - t0) / 1000;
      var w = num(cv.clientWidth, 0) || num(cv.width, 300);
      var h = num(cv.clientHeight, 0) || num(cv.height, 200);
      ctx.save();
      if (typeof ctx.setTransform === 'function') ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, num(cv.width, w), num(cv.height, h));
      ctx.restore();
      ctx.fillStyle = '#0b0e14';
      ctx.fillRect(0, 0, w, h);
      var n = Math.floor(t / 5);
      var idx = n % SHIPS.length;
      var hix = Math.floor(n / SHIPS.length) % HULL_LIST.length;
      var ph = (t / 5) % 1;
      var thrust = ph < 0.2 ? ph / 0.2 : (ph > 0.85 ? (1 - ph) / 0.15 : 1);
      drawShip(ctx, w * 0.5, h * 0.42, Math.min(w * 0.7, 360), t * 0.6, {
        key: SHIPS[idx].key, hull: HULL_LIST[hix].key, thrust: thrust, t: t, quality: 1, flip: 0
      });
      drawChemPlume(ctx, w * 0.22, h * 0.86, 120, Math.PI, 0.5 + 0.5 * Math.sin(t * 2), t);
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(frame);
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(frame);
    return { stop: function () { stopped = true; } };
  }

  var API = {
    version: 2,
    SHIPS: SHIPS,
    HULLS: HULL_LIST,
    CARDS: CARDS,
    drawShip: drawShip,
    drawChemPlume: drawChemPlume,
    drawShipTurntable: drawShipTurntable,
    profileOf: profileOf,
    rigsOf: rigsOf,
    emitOf: emitOf,
    halfHeightOf: halfHeightOf,
    shipByKey: shipByKey,
    hullByKey: hullByKey,
    shipCardOf: shipCardOf,
    __demo: __demo
  };

  ROOT.VoyageShips = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
