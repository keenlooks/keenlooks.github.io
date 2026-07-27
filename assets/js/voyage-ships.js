/* voyage-ships.js
   Three parametric starships for /voyage/: a plasma liner (0.3 g), a fusion torch
   (1 g) and an antimatter torch (2 g), drawn as stacked lathed cross sections so a
   yaw turntable reads as a real 3D object.

   Everything here is deterministic: the only time input is `t` (seconds) and every
   wobble comes from a hashed value-noise, never Math.random. No shadowBlur.
   Every gradient and arc argument is guarded, because one NaN into
   createRadialGradient throws and kills the page's animation loop for good.

   Contract (pinned in .claude/plans/plan-voyage-v2.md):
     VoyageShips.SHIPS                       ordered [ion, fusion, anti]
     VoyageShips.drawShip(ctx,x,y,px,yaw,opts)
     VoyageShips.drawChemPlume(ctx,x,y,px,ang,power,t)
     VoyageShips.drawShipTurntable(canvas2d,key,t)
     VoyageShips.profileOf(key)
     VoyageShips.__demo(canvas)
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

  /* ------------------------------------------------------------------ *
   * tiny path helpers (ctx.ellipse is not assumed to exist)              *
   * ------------------------------------------------------------------ */
  function ellipsePath(ctx, x, y, rx, ry) {
    x = num(x, 0); y = num(y, 0); rx = rad(rx); ry = rad(ry);
    if (typeof ctx.ellipse === 'function') { ctx.moveTo(x + rx, y); ctx.ellipse(x, y, rx, ry, 0, 0, TAU); return; }
    var ox = rx * K_ARC, oy = ry * K_ARC;
    ctx.moveTo(x - rx, y);
    ctx.bezierCurveTo(x - rx, y - oy, x - ox, y - ry, x, y - ry);
    ctx.bezierCurveTo(x + ox, y - ry, x + rx, y - oy, x + rx, y);
    ctx.bezierCurveTo(x + rx, y + oy, x + ox, y + ry, x, y + ry);
    ctx.bezierCurveTo(x - ox, y + ry, x - rx, y + oy, x - rx, y);
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

  /* ------------------------------------------------------------------ *
   * ship definitions                                                    *
   * a runs +0.5 at the nose to -0.5 at the tail; r and every offset are  *
   * fractions of the ship LENGTH.                                       *
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

  /* sections: [group, a, r, cap] */
  var SPEC = {
    ion: {
      mats: { fore: 'cool', aft: 'steel' },
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
        ['fore', 0.132, 0.024, 1],
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
      rigs: [
        { type: 'panel', a0: 0.112, a1: -0.148, i0: 0.030, o0: 0.215, i1: 0.030, o1: 0.275, sign: 1, thick: 0.006 },
        { type: 'panel', a0: 0.112, a1: -0.148, i0: 0.030, o0: 0.215, i1: 0.030, o1: 0.275, sign: -1, thick: 0.006 },
        { type: 'ring', a: -0.200, R: 0.062, tube: 0.008, m: 'gold' },
        { type: 'ring', a: 0.176, R: 0.070, tube: 0.007, m: 'gold' }
      ],
      nav: { a: 0.300, up: 0.078 },
      nozzles: [-0.030, 0.000, 0.030],
      tailA: -0.500,
      tailR: 0.046,
      halfH: 0.295
    },

    fusion: {
      mats: { fore: 'cool', hub: 'steel', spine: 'graphite', engine: 'engine' },
      ribs: { engine: 1 },
      sections: [
        ['fore', 0.500, 0.005, 0],
        ['fore', 0.486, 0.014, 1],
        ['fore', 0.466, 0.026, 0],
        ['fore', 0.440, 0.030, 1],
        ['fore', 0.418, 0.024, 0],
        ['fore', 0.400, 0.021, 1],
        ['hub', 0.396, 0.038, 1],
        ['hub', 0.300, 0.038, 1],
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
      rigs: [
        { type: 'ring', a: 0.348, R: 0.134, tube: 0.030, m: 'steel' },
        { type: 'disc', a: 0.256, R: 0.118, thick: 0.016, m: 'shield' },
        { type: 'sphere', a: 0.205, R: 0.076, m: 'cool' },
        { type: 'sphere', a: 0.070, R: 0.076, m: 'cool' },
        { type: 'sphere', a: -0.065, R: 0.076, m: 'cool' },
        { type: 'ring', a: -0.205, R: 0.116, tube: 0.013, m: 'gold' },
        { type: 'ring', a: -0.266, R: 0.120, tube: 0.013, m: 'gold' },
        { type: 'mouth', a: -0.500, R: 0.252, glow: [255, 246, 226] }
      ],
      nav: { a: 0.348, up: 0.142 },
      nozzles: [0],
      tailA: -0.500,
      tailR: 0.130,
      halfH: 0.270
    },

    anti: {
      mats: { shield: 'shield', pod: 'cool', mirror: 'graphite' },
      ribs: { mirror: 1 },
      sections: [
        ['shield', 0.500, 0.022, 0],
        ['shield', 0.494, 0.092, 0],
        ['shield', 0.486, 0.152, 0],
        ['shield', 0.475, 0.204, 0],
        ['shield', 0.462, 0.235, 1],
        ['shield', 0.448, 0.232, 1],
        ['pod', 0.446, 0.016, 0],
        ['pod', 0.432, 0.048, 1],
        ['pod', 0.392, 0.056, 0],
        ['pod', 0.352, 0.048, 1],
        ['pod', 0.336, 0.024, 0],
        ['pod', 0.322, 0.018, 1],
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
      rigs: [
        { type: 'ring', a: 0.455, R: 0.236, tube: 0.010, m: 'gold' },
        { type: 'sphere', a: -0.232, R: 0.030, m: 'glow' },
        { type: 'ring', a: -0.300, R: 0.096, tube: 0.011, m: 'gold' },
        { type: 'ring', a: -0.392, R: 0.158, tube: 0.011, m: 'gold' },
        { type: 'ring', a: -0.478, R: 0.204, tube: 0.011, m: 'gold' },
        { type: 'mouth', a: -0.500, R: 0.212, glow: [232, 210, 255] }
      ],
      nav: { a: 0.400, up: 0.064 },
      nozzles: [0],
      tailA: -0.480,
      tailR: 0.030,
      halfH: 0.250
    }
  };

  /* build the draw item list once per ship: lathe groups and rigs, sorted
     nose to tail so the depth order is a plain forward or backward walk. */
  function prep(key) {
    var s = SPEC[key];
    if (!s || s._items) return s;
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
    s._items = items;
    s._key = key;
    return s;
  }
  prep('ion'); prep('fusion'); prep('anti');

  function profileOf(key) {
    var s = SPEC[key] || SPEC.fusion;
    var out = [], i;
    for (i = 0; i < s.sections.length; i++) {
      var q = s.sections[i];
      out.push({ group: q[0], a: q[1], r: q[2], cap: !!q[3] });
    }
    return out;
  }
  function rigsOf(key) {
    var s = SPEC[key] || SPEC.fusion, out = [], i;
    for (i = 0; i < s.rigs.length; i++) {
      var r = s.rigs[i], c = {};
      for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k)) c[k] = r[k];
      out.push(c);
    }
    return out;
  }
  /* the drawn half-height as a fraction of px, so callers can fit a ship into a
     box: total height is about 2 * halfHeightOf(key) * px */
  function halfHeightOf(key) {
    var s = SPEC[key] || SPEC.fusion;
    return s.halfH || 0.3;
  }
  function shipByKey(key) {
    for (var i = 0; i < SHIPS.length; i++) if (SHIPS[i].key === key) return SHIPS[i];
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

  /* ------------------------------------------------------------------ *
   * hull pieces                                                         *
   * ------------------------------------------------------------------ */
  function bodyGrad(ctx, O, rmax, tones) {
    var top = O.y - rmax * O.L, bot = O.y + rmax * O.L;
    var g = lgrad(ctx, 0, top, 0, bot);
    if (!g) return tones[1];
    g.addColorStop(0, tones[3]);
    g.addColorStop(0.13, tones[2]);
    g.addColorStop(0.30, tones[0]);
    g.addColorStop(0.47, tones[1]);
    g.addColorStop(0.79, tones[2]);
    g.addColorStop(1, tones[3]);
    return g;
  }

  function drawLathe(ctx, O, spec, item) {
    var secs = spec.sections, i, rmax = 0;
    for (i = item.i0; i <= item.i1; i++) if (secs[i][2] > rmax) rmax = secs[i][2];
    if (rmax <= 0) rmax = 0.004;
    var tones = mat(item.m);

    /* silhouette of the surface of revolution */
    ctx.beginPath();
    ctx.moveTo(SX(O, secs[item.i0][1]), SY(O, secs[item.i0][2]));
    for (i = item.i0 + 1; i <= item.i1; i++) ctx.lineTo(SX(O, secs[i][1]), SY(O, secs[i][2]));
    for (i = item.i1; i >= item.i0; i--) ctx.lineTo(SX(O, secs[i][1]), SY(O, -secs[i][2]));
    ctx.closePath();
    ctx.fillStyle = bodyGrad(ctx, O, rmax, tones);
    ctx.fill();
    if (O.L > 40) {
      ctx.strokeStyle = rgba(18, 22, 28, 0.5);
      ctx.lineWidth = Math.max(0.5, O.L * 0.0035);
      ctx.stroke();
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
        var g = lgrad(ctx, cx - rx, 0, cx + rx, 0);
        if (g) {
          g.addColorStop(0, tones[2]);
          g.addColorStop(0.42, tones[0]);
          g.addColorStop(1, tones[3]);
          ctx.fillStyle = g;
        } else ctx.fillStyle = tones[1];
        alpha(ctx, 0.92);
        ctx.beginPath(); ellipsePath(ctx, cx, O.y, rx, ry); ctx.fill();
        alpha(ctx, 1);
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

  /* the open throat of a bell or a magnetic mirror: a dark interior with a hot
     centre, so a tail-on view reads as an engine and not as a solid egg */
  function drawMouth(ctx, O, rg) {
    var asy = Math.abs(O.sy);
    if (asy < 0.06) return;
    var cx = SX(O, rg.a);
    var rx = Math.max(0.4, rg.R * O.L * asy), ry = rg.R * O.L;
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

    var gf = lgrad(ctx, xNear - rx, O.y - ry * 0.7, xNear + rx, O.y + ry * 0.7);
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
    var g = lgrad(ctx, 0, O.y - ry - lw, 0, O.y + ry + lw);
    if (g) { g.addColorStop(0, tones[2]); g.addColorStop(0.32, tones[0]); g.addColorStop(0.62, tones[1]); g.addColorStop(1, tones[2]); }
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
    var g = rgrad(ctx, cx - r * 0.36, O.y - r * 0.4, r * 0.04, cx, O.y, r);
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
    var x0 = SX(O, rg.a0), x1 = SX(O, rg.a1);
    var s = rg.sign;
    var yi0 = SY(O, s * rg.i0), yo0 = SY(O, s * rg.o0);
    var yi1 = SY(O, s * rg.i1), yo1 = SY(O, s * rg.o1);
    var span = Math.abs(x1 - x0);
    var tones = mat(s > 0 ? 'panelUp' : 'panelDn');

    if (span < 2.5) {
      /* edge on: the plate is a thin bar of its own thickness */
      var w = Math.max(1.1, rg.thick * O.L * Math.abs(O.sy));
      var xm = (x0 + x1) * 0.5;
      ctx.fillStyle = tones[2];
      quad(ctx, xm - w, yi0, xm + w, yi0, xm + w, yo1, xm - w, yo1);
      ctx.fill();
      return;
    }
    var g = lgrad(ctx, 0, (yi0 + yi1) * 0.5, 0, (yo0 + yo1) * 0.5);
    if (g) {
      g.addColorStop(0, s > 0 ? '#7c6a5e' : '#5d5048');
      g.addColorStop(0.18, tones[2]);
      g.addColorStop(0.55, tones[1]);
      g.addColorStop(1, tones[0]);
    }
    ctx.fillStyle = g || tones[1];
    quad(ctx, x0, yi0, x1, yi1, x1, yo1, x0, yo0);
    ctx.fill();
    ctx.strokeStyle = rgba(24, 28, 34, 0.55);
    ctx.lineWidth = Math.max(0.5, O.L * 0.003);
    ctx.stroke();
    if (!O.q || span < 26) return;
    /* ribs at constant a: they crowd together as the panel turns away */
    var n = Math.max(2, Math.min(18, Math.round(span / 12)));
    ctx.beginPath();
    for (var k = 1; k < n; k++) {
      var f = k / n;
      line(ctx, x0 + (x1 - x0) * f, yi0 + (yi1 - yi0) * f, x0 + (x1 - x0) * f, yo0 + (yo1 - yo0) * f);
    }
    ctx.strokeStyle = rgba(28, 33, 40, 0.30);
    ctx.lineWidth = Math.max(0.4, O.L * 0.002);
    ctx.stroke();
    ctx.beginPath();
    line(ctx, x0, (yi0 + yo0) * 0.5, x1, (yi1 + yo1) * 0.5);
    ctx.strokeStyle = rgba(230, 238, 248, 0.22);
    ctx.stroke();
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
    var g = lgrad(ctx, x0, y0, x0 + dlen, y0);
    if (g) {
      g.addColorStop(0, rgba(18, 24, 42, 0.40 * O.th));
      g.addColorStop(0.55, rgba(18, 24, 42, 0.20 * O.th));
      g.addColorStop(1, rgba(18, 24, 42, 0));
      ctx.fillStyle = g;
    } else ctx.fillStyle = rgba(18, 24, 42, 0.24 * O.th);
    var pad = 1.5, e = 0.92;
    quad(ctx, x0, y0 - w0 * pad, x0 + dlen * e, y0 - w1 * pad,
         x0 + dlen * e, y0 + w1 * pad, x0, y0 + w0 * pad);
    ctx.fill();
  }
  /* additive only where it helps: over a white sky "lighter" is a no-op */
  function emissiveOn(ctx, O) {
    if (!O.light) ctx.globalCompositeOperation = 'lighter';
  }
  function emissiveOff(ctx) { ctx.globalCompositeOperation = 'source-over'; }

  function drawIonPlume(ctx, O, spec) {
    var th = O.th; if (th <= 0.001) return;
    var d = plumeDir(O), L = O.L;
    var len = L * (0.45 + 0.85 * th);
    var tx = SX(O, spec.tailA);
    var noz = spec.nozzles, i, k;
    for (i = 0; i < noz.length; i++) {
      var oy = O.y - noz[i] * L;
      var w0 = L * 0.011 * (0.5 + 0.5 * th);
      var w1 = L * 0.019 * (0.5 + 0.5 * th);
      var ex = tx + d * len;
      plumeShade(ctx, O, tx, oy, d * len, w0 * 1.6, w1 * 1.6);
      emissiveOn(ctx, O);
      var g = lgrad(ctx, tx, oy, ex, oy);
      if (g) {
        g.addColorStop(0, rgba(238, 248, 255, 0.95 * th));
        g.addColorStop(0.18, rgba(162, 210, 255, 0.68 * th));
        g.addColorStop(0.62, rgba(126, 176, 248, 0.32 * th));
        g.addColorStop(1, rgba(110, 160, 240, 0));
        ctx.fillStyle = g;
      } else ctx.fillStyle = rgba(150, 200, 255, 0.45 * th);
      quad(ctx, tx, oy - w0, ex, oy - w1, ex, oy + w1, tx, oy + w0);
      ctx.fill();
      /* standing diamonds: fixed positions, gentle breathing only */
      if (!O.q || Math.abs(d) < 0.12) { emissiveOff(ctx); continue; }
      for (k = 0; k < 5; k++) {
        var s = 0.10 + k * 0.165;
        var br = (1 - s) * (0.55 + 0.25 * Math.sin(O.t * 2.1 + k * 1.7));
        var dx = tx + d * len * s;
        var hw = Math.max(0.8, L * 0.016 * Math.abs(d));
        var hh = w1 * (1.15 - s * 0.4);
        ctx.beginPath();
        ctx.moveTo(dx - hw, oy); ctx.lineTo(dx, oy - hh); ctx.lineTo(dx + hw, oy); ctx.lineTo(dx, oy + hh);
        ctx.closePath();
        ctx.fillStyle = rgba(235, 246, 255, clamp(0.55 * br * th, 0, 1));
        ctx.fill();
      }
      emissiveOff(ctx);
    }
  }

  function drawFusionPlume(ctx, O, spec) {
    var th = O.th; if (th <= 0.001) return;
    var d = plumeDir(O), L = O.L;
    var flick = 0.9 + 0.16 * (vnoise(O.t * 6.3) - 0.5) * 2;
    var len = L * (0.5 + 0.95 * th) * flick;
    var tx = SX(O, spec.tailA), ty = O.y;
    var w0 = L * 0.115 * (0.5 + 0.5 * th);
    var n = O.q ? 16 : 8, i;
    function widthAt(s) {
      var pinch = 1
        - 0.34 * Math.exp(-Math.pow((s - 0.055) / 0.045, 2))
        - 0.22 * Math.exp(-Math.pow((s - 0.135) / 0.06, 2));
      var wob = 1 + 0.07 * (vnoise(s * 5 + O.t * 4.1) - 0.5);
      return w0 * pinch * (0.55 + 0.55 * s) * wob;
    }
    plumeShade(ctx, O, tx, ty, d * len, widthAt(0), widthAt(1));
    /* outer blue envelope */
    emissiveOn(ctx, O);
    ctx.beginPath();
    for (i = 0; i <= n; i++) {
      var s = i / n, xx = tx + d * len * s, yy = ty - widthAt(s);
      if (i === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
    }
    for (i = n; i >= 0; i--) {
      var s2 = i / n;
      ctx.lineTo(tx + d * len * s2, ty + widthAt(s2));
    }
    ctx.closePath();
    var g = lgrad(ctx, tx, ty, tx + d * len, ty);
    if (g) {
      g.addColorStop(0, rgba(255, 255, 255, 0.95 * th));
      g.addColorStop(0.10, rgba(214, 236, 255, 0.78 * th));
      g.addColorStop(0.30, rgba(158, 200, 255, 0.44 * th));
      g.addColorStop(0.60, rgba(120, 170, 244, 0.18 * th));
      g.addColorStop(1, rgba(96, 140, 220, 0));
      ctx.fillStyle = g;
    } else ctx.fillStyle = rgba(170, 205, 250, 0.4 * th);
    ctx.fill();
    /* white core */
    ctx.beginPath();
    var cl = len * 0.62;
    for (i = 0; i <= n; i++) {
      var sc = i / n, xc = tx + d * cl * sc, yc = ty - widthAt(sc * 0.62) * 0.42;
      if (i === 0) ctx.moveTo(xc, yc); else ctx.lineTo(xc, yc);
    }
    for (i = n; i >= 0; i--) {
      var sc2 = i / n;
      ctx.lineTo(tx + d * cl * sc2, ty + widthAt(sc2 * 0.62) * 0.42);
    }
    ctx.closePath();
    var g2 = lgrad(ctx, tx, ty, tx + d * cl, ty);
    if (g2) {
      g2.addColorStop(0, rgba(255, 255, 252, 1 * th));
      g2.addColorStop(0.45, rgba(246, 252, 255, 0.82 * th));
      g2.addColorStop(0.78, rgba(214, 236, 255, 0.34 * th));
      g2.addColorStop(1, rgba(198, 226, 255, 0));
      ctx.fillStyle = g2;
    } else ctx.fillStyle = rgba(255, 255, 250, 0.7 * th);
    ctx.fill();
    /* magnetic nozzle rings pinching the throat. At chase scale these are the
       detail that says "magnetic nozzle" rather than "blue smear", so they get
       a real line weight. */
    if (Math.abs(d) < 0.1) { emissiveOff(ctx); return; }
    for (i = 0; i < 3; i++) {
      /* the first two sit ON the pinches in widthAt, which is what makes them
         read as a nozzle squeezing the beam rather than as stray hoops */
      var sr = 0.055 + i * 0.08;
      var ry = widthAt(sr) * 1.6;
      var rx = Math.max(0.5, ry * Math.abs(O.sy) * 0.9 + O.L * 0.010);
      strokeEllipse(ctx, tx + d * len * sr, ty, rx, ry,
        rgba(214, 238, 255, clamp((0.9 - i * 0.18) * th, 0, 1)),
        Math.max(1, L * 0.016));
    }
    emissiveOff(ctx);
  }

  function drawAntiPlume(ctx, O, spec) {
    var th = O.th;
    var d = plumeDir(O), L = O.L;
    /* gamma bloom around the mirror survives even at idle */
    var bx = SX(O, -0.36), br = L * 0.36;
    var bg = rgrad(ctx, bx, O.y, 0, bx, O.y, br);
    if (bg) {
      bg.addColorStop(0, rgba(226, 208, 255, 0.20 * (0.25 + 0.75 * th)));
      bg.addColorStop(0.45, rgba(178, 150, 245, 0.10 * (0.25 + 0.75 * th)));
      bg.addColorStop(1, rgba(150, 120, 230, 0));
      ctx.fillStyle = bg;
      ctx.beginPath(); ellipsePath(ctx, bx, O.y, br, br); ctx.fill();
    }
    if (th <= 0.001) return;
    var len = L * (1.1 + 2.8 * th);
    var tx = SX(O, spec.tailA), ty = O.y;
    var w = L * 0.011 * (0.55 + 0.45 * th);
    var ex = tx + d * len;
    plumeShade(ctx, O, tx, ty, d * len, w * 2.4, w * 1.2);
    emissiveOn(ctx, O);
    var g = lgrad(ctx, tx, ty, ex, ty);
    if (g) {
      g.addColorStop(0, rgba(255, 252, 255, 1 * th));
      g.addColorStop(0.12, rgba(232, 210, 255, 0.75 * th));
      g.addColorStop(0.55, rgba(196, 166, 252, 0.34 * th));
      g.addColorStop(1, rgba(170, 140, 240, 0));
      ctx.fillStyle = g;
    } else ctx.fillStyle = rgba(220, 196, 255, 0.5 * th);
    quad(ctx, tx, ty - w * 1.7, ex, ty - w * 0.5, ex, ty + w * 0.5, tx, ty + w * 1.7);
    ctx.fill();
    /* the needle core */
    ctx.fillStyle = rgba(255, 255, 255, 0.92 * th);
    quad(ctx, tx, ty - w * 0.55, tx + d * len * 0.8, ty - w * 0.16, tx + d * len * 0.8, ty + w * 0.16, tx, ty + w * 0.55);
    ctx.fill();
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
    var col = key === 'ion' ? [186, 219, 255] : (key === 'anti' ? [226, 206, 255] : [255, 250, 240]);
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

  function drawNavLight(ctx, O, spec) {
    var nav = spec.nav;
    var ph = frac(O.t * 0.62);
    var on = (ph < 0.07) || (ph > 0.13 && ph < 0.19);
    var x = SX(O, nav.a), y = SY(O, nav.up);
    var r = Math.max(0.8, O.L * 0.008);
    ctx.fillStyle = on ? GOLD : GOLD_DK;
    ctx.beginPath(); ellipsePath(ctx, x, y, r, r); ctx.fill();
    if (!on || O.L < 40) return;
    var g = rgrad(ctx, x, y, 0, x, y, r * 5);
    if (g) {
      g.addColorStop(0, rgba(232, 200, 130, 0.55));
      g.addColorStop(1, rgba(200, 164, 92, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ellipsePath(ctx, x, y, r * 5, r * 5); ctx.fill();
    }
  }

  /* far away the ship is a few pixels: a legible dart beats a lost silhouette */
  function drawTiny(ctx, O, spec, key) {
    var half = O.L * 0.5, hx = half * O.cy;
    var hh = Math.max(1.3, O.L * 0.15);
    if (O.th > 0.01) {
      var d = plumeDir(O), len = O.L * (0.45 + 0.9 * O.th);
      var col = key === 'ion' ? [170, 210, 255] : (key === 'anti' ? [226, 206, 255] : [235, 244, 255]);
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
    if (typeof opts === 'string') return SPEC[opts] ? opts : 'fusion';
    var k = opts.key || opts.ship || opts.kind;
    if (typeof k === 'string' && SPEC[k]) return k;
    var i = opts.index;
    if (!fin(i)) i = opts.i;
    if (fin(i)) {
      i = Math.round(i);
      if (i >= 0 && i < SHIPS.length) return SHIPS[i].key;
    }
    return 'fusion';
  }

  function drawShip(ctx, x, y, px, yaw, opts) {
    if (!ctx || typeof ctx.beginPath !== 'function') return;
    if (typeof opts === 'string') opts = { key: opts };
    opts = opts || {};
    var key = keyFromOpts(opts);
    var spec = prep(key);
    var L = clamp(px, 4, 900);
    var flip = clamp(opts.flip, 0, 1);
    var yw = num(yaw, 0) + Math.PI * smooth(flip);
    var O = {
      x: num(x, 0), y: num(y, 0), L: L,
      cy: Math.cos(yw), sy: Math.sin(yw),
      t: num(opts.t, 0),
      q: (opts.quality === 0 || L < 56) ? 0 : 1,
      th: clamp(opts.thrust, 0, 1),
      light: !!opts.light
    };
    if (!fin(O.cy) || !fin(O.sy)) return;

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    alpha(ctx, 1);

    /* Below about 14 px the lathed hull is mush and a legible dart reads
       better; above it the real ship is drawn, however small the marker. */
    if (L < 14) { drawTiny(ctx, O, spec, key); ctx.restore(); return; }

    drawExhaust(ctx, O, spec, key);

    var items = spec._items, i;
    var fwd = O.sy >= 0;
    for (i = 0; i < items.length; i++) {
      var it = items[fwd ? i : (items.length - 1 - i)];
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
      }
      alpha(ctx, 1);
      ctx.restore();
    }

    drawTailGlow(ctx, O, spec, key);
    drawNavLight(ctx, O, spec);
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

  function drawShipTurntable(target, key, t) {
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
    var tt = num(t, 0);
    var hh = (SPEC[key] && SPEC[key].halfH) || 0.3;
    var px = clamp(Math.min(w * 0.80, (h * 0.44) / hh), 12, 420);
    var thrust = 0.22 + 0.07 * (0.5 + 0.5 * Math.sin(tt * 1.6));
    drawShip(ctx, w * 0.54, h * 0.5, px, tt * 0.5, {
      key: key, thrust: thrust, t: tt, quality: (w < 150 ? 0 : 1), flip: 0
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
      var idx = Math.floor(t / 5) % SHIPS.length;
      var ph = (t / 5) % 1;
      var thrust = ph < 0.2 ? ph / 0.2 : (ph > 0.85 ? (1 - ph) / 0.15 : 1);
      drawShip(ctx, w * 0.5, h * 0.42, Math.min(w * 0.7, 360), t * 0.6, {
        key: SHIPS[idx].key, thrust: thrust, t: t, quality: 1, flip: 0
      });
      drawChemPlume(ctx, w * 0.22, h * 0.86, 120, Math.PI, 0.5 + 0.5 * Math.sin(t * 2), t);
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(frame);
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(frame);
    return { stop: function () { stopped = true; } };
  }

  var API = {
    version: 1,
    SHIPS: SHIPS,
    drawShip: drawShip,
    drawChemPlume: drawChemPlume,
    drawShipTurntable: drawShipTurntable,
    profileOf: profileOf,
    rigsOf: rigsOf,
    halfHeightOf: halfHeightOf,
    shipByKey: shipByKey,
    __demo: __demo
  };

  ROOT.VoyageShips = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
