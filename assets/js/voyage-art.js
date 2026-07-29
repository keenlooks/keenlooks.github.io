/* ==========================================================================
   voyage-art.js -- procedural star / planet / exoplanet orb renderer for
   Mission to Anywhere (/voyage/). Global: VoyageArt.
   --------------------------------------------------------------------------
   Everything here is deterministic in (params, t). There is no Math.random
   anywhere in the file: all procedural noise comes from an integer hash
   (mulberry32 for the handful of per-body placements) and is BAKED ONCE into
   an offscreen texture strip that lives in a small LRU cache. Per-frame work
   is a handful of drawImage slabs plus two gradients and some arcs.

   Safety rules this file obeys (a NaN into createRadialGradient throws, and
   one throw inside the page's rAF loop kills it permanently):
     - every gradient and arc argument is isFinite-guarded at the call site
       (see rgrad / lgrad / circle);
     - drawStar / drawPlanet sanitize cx, cy, rPx and bail out early on junk;
     - a star with no measured temperature gets a neutral grey orb, never an
       invented color.

   Texture geometry: the strips are cylindrical in longitude (x wraps) and
   EQUAL-AREA in latitude (row y is linear in sin(latitude)). That second
   choice is what lets the sphere mapping be a stack of plain drawImage
   slabs: on a projected sphere the screen y of a latitude is exactly
   r*sin(lat), so the vertical map is linear and only the horizontal map
   (longitude = asin(x/r)) needs slicing.

   Reads window.VoyageAstro when present (kelvinToRgb / starTempFromCi /
   starBolLum / starRadiusSun). If it is missing the art degrades to neutral
   colors rather than duplicating that library's math here.

   This file is the single source of truth for a body's LOOK. starLook(),
   planetLook() and flareUniforms() hand out the colors, the limb term, the
   starspot layout and the prominence placement that the 2D renderer below
   uses, so a second renderer (the WebGL orb path) can draw the same body
   without re-deriving a single number. drawStar is additionally split into
   three passes that can be called separately -- drawStarBack (backing glow),
   drawStarMid (the disc itself) and drawStarFront (the flare bloom) -- so the
   corona and the bloom around a GL-rendered disc are literally the same code
   that draws them around the 2D one. drawStar itself is unchanged: it is
   those three passes back to back.
   ========================================================================== */
(function (global) {
  'use strict';

  var TWO_PI = Math.PI * 2;

  /* ---------------- tiny numeric helpers + guards ---------------- */

  function num(v, d) {
    return (typeof v === 'number' && isFinite(v)) ? v : d;
  }
  function fin(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function smooth(x) {
    if (!(x > 0)) return 0;
    if (x >= 1) return 1;
    return x * x * (3 - 2 * x);
  }
  function lerp(a, b, f) { return a + (b - a) * f; }

  /* ---------------- deterministic hashing / noise ---------------- */

  /* mulberry32: used ONLY at texture build time (spot and crater placement). */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* FNV-ish string hash -> uint32. Stable across sessions and machines. */
  function hashStr(s) {
    var str = (typeof s === 'string' && s.length) ? s : 'voyage';
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= h >>> 15;
    return h >>> 0;
  }

  /* Two-integer hash -> uint32 (draw-time safe: no allocation). */
  function hash2(a, b) {
    var n = Math.imul(a | 0, 1836311903) ^ Math.imul(b | 0, 2971215073);
    n = Math.imul(n ^ (n >>> 15), 2246822519);
    n = Math.imul(n ^ (n >>> 13), 3266489917);
    return (n ^ (n >>> 16)) >>> 0;
  }
  function unit2(a, b) { return hash2(a, b) / 4294967296; }

  /* Lattice value noise that WRAPS in x with integer period `per`.
     The lattice values come from a fixed 4096-entry table (built once, from
     mulberry32, at load) indexed by a cheap mix of the cell coordinates and
     the body seed. A table lookup is about twice as fast as re-hashing per
     sample, which is what keeps a full 512x256 strip inside its build
     budget; different seeds walk the table differently, so bodies still look
     unrelated. */
  var TAB_SIZE = 4096, TAB_MASK = TAB_SIZE - 1;
  var TAB = (function () {
    var a = new Float64Array(TAB_SIZE);
    var r = mulberry32(0x9E3779B9);
    for (var i = 0; i < TAB_SIZE; i++) a[i] = r();
    return a;
  })();
  function nz(xi, yi, seed) {
    return TAB[(Math.imul(xi | 0, 73856093) ^ Math.imul(yi | 0, 19349663) ^ (seed | 0)) & TAB_MASK];
  }
  function vn(x, y, per, seed) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var fx = x - xi, fy = y - yi;
    var u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    var p = per > 1 ? per : 1;
    var x0 = xi % p; if (x0 < 0) x0 += p;
    var x1 = x0 + 1; if (x1 >= p) x1 -= p;
    var a = nz(x0, yi, seed), b = nz(x1, yi, seed);
    var c = nz(x0, yi + 1, seed), d = nz(x1, yi + 1, seed);
    var ab = a + (b - a) * u, cd = c + (d - c) * u;
    return ab + (cd - ab) * v;
  }
  /* Fractal sum. `per` doubles per octave so the x wrap survives. */
  function fbm(x, y, per, seed, oct, gain) {
    var s = 0, amp = 1, tot = 0, p = per | 0, xx = x, yy = y, i;
    if (p < 1) p = 1;
    for (i = 0; i < oct; i++) {
      s += amp * vn(xx, yy, p, seed + i * 1013);
      tot += amp;
      amp *= gain;
      xx *= 2; yy *= 2; p *= 2;
    }
    return tot > 0 ? s / tot : 0;
  }
  /* Ridged noise: 1 at the zero crossings, so thresholds give line networks. */
  function ridge(x, y, per, seed, oct) {
    var s = 0, amp = 1, tot = 0, p = per | 0, xx = x, yy = y, i, v;
    if (p < 1) p = 1;
    for (i = 0; i < oct; i++) {
      v = vn(xx, yy, p, seed + i * 7717);
      v = 1 - Math.abs(2 * v - 1);
      s += amp * v * v;
      tot += amp;
      amp *= 0.5;
      xx *= 2; yy *= 2; p *= 2;
    }
    return tot > 0 ? s / tot : 0;
  }

  /* --- noise FIELDS ---
     Evaluating multi-octave noise at each of a strip's 131k pixels is the
     most expensive thing in a texture build, and most of it is wasted: the
     field is far smoother than the pixel grid. Each field is evaluated on a
     grid `div` times coarser and read back with a wrapping bilinear sample.
     That costs about a third as much and is visually identical. */
  function field(TW, TH, div, fx, fy, per, seed, oct, gain, isRidge) {
    var d = Math.max(1, div | 0);
    var fw = Math.max(2, Math.ceil(TW / d));
    var fh = Math.max(2, Math.ceil(TH / d) + 2);
    var f = new Float32Array(fw * fh);
    var i = 0, x, y;
    for (y = 0; y < fh; y++) {
      var yy = (y * d + 0.5) / TH * fy;
      for (x = 0; x < fw; x++) {
        var xx = (x / fw) * fx;
        f[i++] = isRidge ? ridge(xx, yy, per, seed, oct)
                         : fbm(xx, yy, per, seed, oct, gain);
      }
    }
    return { f: f, fw: fw, fh: fh, div: d };
  }
  /* u is a longitude fraction (any real; it wraps), y is a pixel row. */
  function smp(F, u, y) {
    var fw = F.fw, f = F.f;
    var uu = u - Math.floor(u);
    var gx = uu * fw;
    var xi = gx | 0;
    if (xi >= fw) xi = fw - 1;
    var tx = gx - xi;
    var x1 = xi + 1; if (x1 >= fw) x1 = 0;
    var gy = y / F.div;
    var yi = gy | 0;
    if (yi > F.fh - 2) yi = F.fh - 2;
    var ty = gy - yi;
    var i0 = yi * fw, i1 = i0 + fw;
    var a = f[i0 + xi], b = f[i0 + x1], c = f[i1 + xi], d = f[i1 + x1];
    var ab = a + (b - a) * tx, cd = c + (d - c) * tx;
    return ab + (cd - ab) * ty;
  }

  /* ---------------- color ---------------- */

  var A_LIB = null;
  function astro() {
    if (!A_LIB) A_LIB = global.VoyageAstro || null;
    return A_LIB;
  }

  var NEUTRAL = { r: 214, g: 218, b: 228 };

  /* Blackbody color. Single source of truth is VoyageAstro.kelvinToRgb; if
     that library is absent we return a neutral tone rather than shipping a
     second copy of the curve that could drift out of sync. */
  function kelvinRgb(T) {
    var lib = astro();
    if (fin(T) && lib && lib.kelvinToRgb) return lib.kelvinToRgb(T);
    return { r: NEUTRAL.r, g: NEUTRAL.g, b: NEUTRAL.b };
  }
  function mixC(a, b, f) {
    return [Math.round(lerp(a[0], b[0], f)),
            Math.round(lerp(a[1], b[1], f)),
            Math.round(lerp(a[2], b[2], f))];
  }
  function rgba(c, a) {
    return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' +
           (fin(a) ? clamp(a, 0, 1) : 1) + ')';
  }
  /* Deepen a tint along its own vector away from white: the hue and the
     brightest channel are untouched, only the chroma moves. k = 0 is a
     no-op, which is what every star above 6,000 K gets. */
  function deepen(c, k) {
    if (!(k > 0)) return [c[0], c[1], c[2]];
    return [clamp(Math.round(c[0] + (c[0] - 255) * k), 0, 255),
            clamp(Math.round(c[1] + (c[1] - 255) * k), 0, 255),
            clamp(Math.round(c[2] + (c[2] - 255) * k), 0, 255)];
  }
  /* the same, taking and returning the {r,g,b} form kelvinRgb hands back */
  function deepRgb(o, k) {
    if (!(k > 0)) return o;
    var d = deepen([o.r, o.g, o.b], 0.35 * k);
    return { r: d[0], g: d[1], b: d[2] };
  }

  /* ---------------- canvas helpers (all NaN-guarded) ---------------- */

  function makeCanvas(w, h) {
    var W = Math.max(1, Math.round(num(w, 1)));
    var H = Math.max(1, Math.round(num(h, 1)));
    var c = null;
    try {
      if (typeof document !== 'undefined' && document && document.createElement) {
        c = document.createElement('canvas');
      } else if (typeof OffscreenCanvas !== 'undefined') {
        c = new OffscreenCanvas(W, H);
      }
    } catch (e) { c = null; }
    if (!c) return null;
    c.width = W; c.height = H;
    return c;
  }

  function ctx2d(canvas) {
    if (!canvas || !canvas.getContext) return null;
    var c = null;
    try { c = canvas.getContext('2d'); } catch (e) { c = null; }
    return c || null;
  }

  /* createRadialGradient with every argument checked. Returns null on junk,
     and every caller treats null as "skip this layer". */
  function rgrad(ctx, x0, y0, r0, x1, y1, r1) {
    if (!ctx || !ctx.createRadialGradient) return null;
    if (!fin(x0) || !fin(y0) || !fin(r0) || !fin(x1) || !fin(y1) || !fin(r1)) return null;
    if (r0 < 0 || r1 < 0) return null;
    return ctx.createRadialGradient(x0, y0, r0, x1, y1, r1);
  }
  function lgrad(ctx, x0, y0, x1, y1) {
    if (!ctx || !ctx.createLinearGradient) return null;
    if (!fin(x0) || !fin(y0) || !fin(x1) || !fin(y1)) return null;
    return ctx.createLinearGradient(x0, y0, x1, y1);
  }
  function circle(ctx, x, y, r) {
    if (!fin(x) || !fin(y) || !fin(r) || r <= 0) return false;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TWO_PI);
    return true;
  }
  function stop(g, at, color) {
    if (!g) return;
    g.addColorStop(clamp(num(at, 0), 0, 1), color);
  }

  /* ---------------- LRU texture cache ---------------- */

  var TEX_MAX = 8;
  var texKeys = [];          /* most-recent last */
  var texMap = {};

  function texGet(key, build) {
    if (Object.prototype.hasOwnProperty.call(texMap, key)) {
      var at = texKeys.indexOf(key);
      if (at >= 0) { texKeys.splice(at, 1); texKeys.push(key); }
      return texMap[key];
    }
    var made = null;
    try { made = build(); } catch (e) { made = null; }
    var entry = made || { tex: null, aux: null };
    texMap[key] = entry;
    texKeys.push(key);
    while (texKeys.length > TEX_MAX) {
      var drop = texKeys.shift();
      var old = texMap[drop];
      if (old) {
        /* free the backing store on the way out */
        if (old.tex) { try { old.tex.width = 0; old.tex.height = 0; } catch (e2) {} }
        if (old.aux) { try { old.aux.width = 0; old.aux.height = 0; } catch (e3) {} }
      }
      delete texMap[drop];
    }
    return entry;
  }
  function texCacheSize() { return texKeys.length; }
  function clearTexCache() {
    for (var i = 0; i < texKeys.length; i++) {
      var e = texMap[texKeys[i]];
      if (e) {
        if (e.tex) { try { e.tex.width = 0; e.tex.height = 0; } catch (er) {} }
        if (e.aux) { try { e.aux.width = 0; e.aux.height = 0; } catch (er2) {} }
      }
    }
    texKeys.length = 0;
    texMap = {};
  }

  /* Texture sizes. quality 0 is the card-preview tier (half res). */
  function texW(q) { return q ? 512 : 256; }
  function texH(q) { return q ? 256 : 128; }
  function slabCount(q) { return q ? 34 : 18; }

  /* ---------------- sphere mapping ----------------
     Paint a cylindrical strip onto a disc as vertical slabs. Longitude at a
     screen offset x is asin(x/r) (+ the spin), which is why the slab source
     rects get wider toward the limb: that IS the foreshortening. */
  function drawSphere(ctx, cx, cy, r, tex, spin, slabs) {
    if (!tex || !ctx || !ctx.drawImage) return false;
    var TW = tex.width, TH = tex.height;
    if (!(TW > 0) || !(TH > 0)) return false;
    if (!fin(cx) || !fin(cy) || !fin(r) || r <= 0) return false;
    /* Slab count grows with the drawn radius: at r = 300 a fixed 34 slabs are
       18 px wide each and the foreshortening inside one slab starts to show. */
    var n = Math.max(6, slabs | 0);
    var want = Math.round(r / 5);
    if (want > n) n = Math.min(96, want);
    var u0 = num(spin, 0) / TWO_PI;
    u0 = u0 - Math.floor(u0);
    var dy = Math.round(cy - r), dh = Math.max(1, Math.round(cy + r) - dy);
    /* Destination edges are snapped to whole pixels and SHARED between
       neighbours. A fractional destination rect leaves a partly covered column
       at each edge, and two of those side by side never sum back to opaque:
       that is the vertical comb this used to draw at large radii. Adjacent
       slabs sample the same longitude at the shared edge, so the seam is gone
       without any overlap fudge. */
    var left = cx - r, span = 2 * r;
    var xPrev = Math.round(left);
    for (var i = 0; i < n; i++) {
      var f0 = i / n, f1 = (i + 1) / n;
      var xNext = Math.round(left + f1 * span);
      var dw = xNext - xPrev;
      if (dw <= 0) { xPrev = xNext; continue; }
      var l0 = Math.asin(clamp(2 * f0 - 1, -1, 1));
      var l1 = Math.asin(clamp(2 * f1 - 1, -1, 1));
      var s0 = u0 + l0 / TWO_PI;
      var s1 = u0 + l1 / TWO_PI;
      var sw = (s1 - s0) * TW;
      if (!(sw > 0.0001)) { xPrev = xNext; continue; }
      var sx = (s0 - Math.floor(s0)) * TW;
      if (!fin(sx) || !fin(sw)) { xPrev = xNext; continue; }
      if (sx + sw <= TW) {
        ctx.drawImage(tex, sx, 0, sw, TH, xPrev, dy, dw, dh);
      } else {
        /* the slab straddles the seam of the cylindrical strip: split it, and
           split the DESTINATION on a whole pixel too */
        var wA = TW - sx;
        var fA = wA / sw;
        var xMid = xPrev + Math.round(dw * fA);
        if (xMid > xPrev) ctx.drawImage(tex, sx, 0, wA, TH, xPrev, dy, xMid - xPrev, dh);
        if (xNext > xMid) ctx.drawImage(tex, 0, 0, sw - wA, TH, xMid, dy, xNext - xMid, dh);
      }
      xPrev = xNext;
    }
    return true;
  }

  /* Sphere shading. The gradient is centered on the sub-solar point and its
     stops are the EXACT Lambert brightness sampled along the principal axis
     (n.s with n the sphere normal), so at full phase this is textbook limb
     darkening and at half phase the terminator lands on the disc center. */
  function shadeSphere(ctx, cx, cy, r, lightDir, phase, maxDark, nightRgb) {
    var L = num(lightDir, Math.PI);
    var k = clamp(num(phase, 0.92), 0, 1);
    var cosA = 2 * k - 1;
    var sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    var sx = cx + r * sinA * Math.cos(L);
    var sy = cy + r * sinA * Math.sin(L);
    var r1 = r * (1 + sinA * 0.99) + 0.001;
    var g = rgrad(ctx, sx, sy, 0, sx, sy, r1);
    if (!g) return;
    var night = nightRgb || [0, 0, 0];
    var cap = num(maxDark, 0.95);
    for (var i = 0; i <= 10; i++) {
      var tt = i / 10;
      var d = tt * r1;
      var p = clamp((r * sinA - d) / r, -1, 1);
      var z = Math.sqrt(Math.max(0, 1 - p * p));
      var b = sinA * p + cosA * z;
      var a = clamp(1 - clamp(b, 0, 1), 0, 1);
      stop(g, tt, rgba(night, a * cap));
    }
    ctx.fillStyle = g;
    if (circle(ctx, cx, cy, r)) ctx.fill();
  }

  /* ==========================================================================
     STARS
     ========================================================================== */

  var STAR_CLASSES = 'OBAFGKMLTY';

  /* Spectral class from temperature, used when the catalog has no sp string
     but does have a color index. Returns '' for an unknown temperature: the
     renderer must not invent a class it does not have. */
  function classFromTeff(T) {
    if (!fin(T)) return '';
    if (T >= 30000) return 'O';
    if (T >= 10000) return 'B';
    if (T >= 7500) return 'A';
    if (T >= 6000) return 'F';
    if (T >= 5200) return 'G';
    if (T >= 3700) return 'K';
    if (T >= 2400) return 'M';
    return 'L';
  }

  /* Per-class activity. M dwarfs are the flare stars; the ordering here is
     the real one (flare rate and spot coverage both rise toward the cool
     end, granulation gets finer toward the hot end). flareRate is in events
     per second of wall clock; granuleScale is the granule cell size as a
     fraction of the disc, so SMALLER means finer. */
  var ACTIVITY = {
    O: { flareRate: 0.000, spotAmp: 0.00, granuleScale: 0.038 },
    B: { flareRate: 0.000, spotAmp: 0.01, granuleScale: 0.045 },
    A: { flareRate: 0.004, spotAmp: 0.02, granuleScale: 0.058 },
    F: { flareRate: 0.020, spotAmp: 0.06, granuleScale: 0.075 },
    G: { flareRate: 0.020, spotAmp: 0.11, granuleScale: 0.090 },
    K: { flareRate: 0.060, spotAmp: 0.20, granuleScale: 0.115 },
    M: { flareRate: 0.250, spotAmp: 0.34, granuleScale: 0.140 },
    L: { flareRate: 0.250, spotAmp: 0.30, granuleScale: 0.150 },
    T: { flareRate: 0.220, spotAmp: 0.28, granuleScale: 0.160 },
    Y: { flareRate: 0.200, spotAmp: 0.26, granuleScale: 0.170 },
    D: { flareRate: 0.000, spotAmp: 0.00, granuleScale: 0.000 },
    N: { flareRate: 0.000, spotAmp: 0.00, granuleScale: 0.000 },
    '': { flareRate: 0.020, spotAmp: 0.10, granuleScale: 0.090 }
  };

  /* Catalog row -> everything the renderer needs. Pure; NaN propagates from
     missing inputs exactly the way VoyageAstro's helpers intend. */
  function starParams(o) {
    var s = (o && typeof o === 'object') ? o : {};
    var name = (typeof s.name === 'string') ? s.name : '';
    var sp = (typeof s.sp === 'string') ? s.sp.replace(/^\s+/, '') : '';
    var spc = sp ? sp.charAt(0).toUpperCase() : '';
    var trimmed = name.replace(/^\s+/, '');

    var kind = 'star';
    if (trimmed.slice(0, 3).toUpperCase() === 'PSR') kind = 'ns';
    else if (spc === 'D' || spc === 'W') kind = 'wd';

    var lib = astro();
    var teff = NaN, rSun = NaN;
    if (kind !== 'ns') {
      if (fin(s.teff) && s.teff > 0) {
        teff = s.teff;
      } else if (fin(s.ci) && lib && lib.starTempFromCi) {
        teff = lib.starTempFromCi(s.ci);
      }
      if (lib && lib.starBolLum && lib.starRadiusSun) {
        var lb = lib.starBolLum(s.lum, s.absmag, teff);
        rSun = lib.starRadiusSun(lb, teff);
      }
      if (!fin(rSun)) rSun = NaN;
    }

    var cls;
    if (kind === 'ns') cls = 'N';
    else if (kind === 'wd') cls = 'D';
    else if (spc && STAR_CLASSES.indexOf(spc) >= 0) cls = spc;
    else cls = classFromTeff(teff);

    var act = ACTIVITY[cls] || ACTIVITY[''];
    return {
      kind: kind,
      teff: teff,
      rSun: rSun,
      cls: cls,
      seed: hashStr(name || sp || 'star'),
      flareRate: act.flareRate,
      spotAmp: act.spotAmp,
      granuleScale: act.granuleScale
    };
  }

  /* The Sun. The look-back during a cruise has to draw the star you left
     even when the camera is nowhere near it, so the origin body always has
     params; every field here is what starParams() would produce for Sol with
     its measured effective temperature and its radius by definition. */
  var SOL_PARAMS = {
    kind: 'star',
    teff: 5772,
    rSun: 1,
    cls: 'G',
    seed: hashStr('Sol'),
    flareRate: ACTIVITY.G.flareRate,
    spotAmp: ACTIVITY.G.spotAmp,
    granuleScale: ACTIVITY.G.granuleScale
  };

  /* ---- starspot layout ----
     Two to five spots, seeded, hugging low latitudes. Lifted out of the
     texture baker so the GL renderer bakes the SAME spots into its own
     surface: u is a longitude fraction, v is sin(latitude), r is the angular
     radius in radians and amp is the darkening depth. */
  var SPOT_MAX = 5;
  function starSpots(seed, spotAmp) {
    var out = [];
    if (!(spotAmp > 0.02)) return out;
    var rnd = mulberry32((seed | 0) ^ 0x9E3779B9);
    var n = 2 + Math.floor(rnd() * 4);
    for (var i = 0; i < n; i++) {
      var u = rnd();
      var v = (rnd() * 2 - 1) * 0.72;
      var rad = 0.10 + rnd() * 0.16;
      out.push({ u: u, v: v, r: rad, amp: spotAmp });
    }
    return out;
  }

  /* ---- starLook(params) ----
     Everything about how a star looks, in one place: the blackbody color, the
     derived tints the 2D passes paint with, the limb-darkening term, the
     granulation scale, the spot layout. A star with no measured temperature
     comes back `neutral` with the grey tone this file has always used for
     that case, and never an invented color.

     Returns a FRESH object every call; treat it as read-only. */
  function starLook(params) {
    var p = (params && typeof params === 'object') ? params : starParams(null);
    var hasT = fin(p.teff);
    var base = hasT ? kelvinRgb(p.teff) : NEUTRAL;
    var bc0 = [base.r, base.g, base.b];    /* the catalog colour, untouched */
    var bc = bc0;
    /* Chroma, not hue (wave-5 fix). The blackbody-to-sRGB curve normalises
       to the brightest channel, so 3,100 K comes back (255, 180, 117) --
       a pale apricot. Physically that is the right hue, but it renders a
       red supergiant as peach: the verifier scored Betelgeuse ~5/10 on
       colour against its class, and Proxima and Capella with it.
       `deepen` pulls the tint AWAY from white along its own blackbody
       vector, so the hue is untouched and only the chroma moves, and the
       amount tapers to zero by 6,000 K -- every A/F star, and both halves
       of the GL/2D palette pair, render exactly as they did. */
    var coolK = hasT ? clamp((6500 - p.teff) / 3000, 0, 1) : 0;
    if (coolK > 0) bc = deepen(bc0, 0.35 * coolK);
    var seed = (p.seed | 0) || 1;
    var spotAmp = clamp(num(p.spotAmp, 0), 0, 0.6);
    /* Local temperature contrast. A convecting photosphere is not one
       colour: the granule cores are the tops of rising hot gas and the lanes
       between them are cooler gas on its way back down. The swing is taken
       through the SAME blackbody curve the base tone comes from, so a K star
       roils deep red against orange and an F star white against cream, and
       nothing here invents a hue the temperature does not imply.
       The amplitude rides the activity row: a radiative envelope has no
       solar-type convection, so a hot star's swing collapses to nothing. */
    var act = clamp(spotAmp / 0.11, 0, 1);
    var dT = 0.040 + 0.040 * act;
    var hotT = hasT ? deepRgb(kelvinRgb(p.teff * (1 + dT)), coolK) : base;
    var coolT = hasT ? deepRgb(kelvinRgb(p.teff * (1 - dT)), coolK) : base;
    /* A sunspot umbra is a real temperature, not a grey wash: about 0.70 of
       the photosphere, which is why umbrae photograph orange-red rather than
       black. The penumbra sits between the two. */
    var umbT = hasT ? deepRgb(kelvinRgb(Math.max(1200, p.teff * 0.70)), coolK) : base;
    var penT = hasT ? deepRgb(kelvinRgb(Math.max(1400, p.teff * 0.86)), coolK) : base;
    /* The white mix is what makes a photosphere read as a lit surface
       rather than a flat swatch, but a flat 0.28 is wrong at the cool end:
       it was adding peach on top of an already pale apricot. It now tapers
       out with the same temperature ramp, so hot stars keep it exactly and
       cool ones keep their colour. */
    var whiteMix = hasT ? 0.28 * (1 - coolK) : 0.40;
    return {
      /* `rgb` stays the plain blackbody the catalog implies -- it is the
         value the colour chip on the card shows and the one other renderers
         check against VoyageAstro.kelvinToRgb. The deepening lives in the
         painted tints below, which is where the eye reads colour. */
      rgb: bc0,
      neutral: !hasT,
      /* the limb term drawStar paints with: cooler stars darken harder */
      limbExp: clamp(0.30 + (hasT ? clamp((6500 - p.teff) / 9000, -0.10, 0.34) : 0.10), 0.16, 0.68),
      granuleScale: num(p.granuleScale, 0.09),
      spotAmp: spotAmp,
      spots: starSpots(seed, spotAmp),
      seed: seed,
      /* the derived tints, so no second renderer has to guess at them */
      hot: mixC(bc, [255, 255, 255], whiteMix),
      cool: mixC(bc, [92, 30, 14], hasT ? 0.42 : 0.26),
      glow: mixC(bc, [255, 255, 255], 0.25),
      limb: mixC(bc, [70, 22, 10], hasT ? 0.55 : 0.42),
      prom: mixC(bc, [255, 130, 80], hasT ? 0.55 : 0.25),
      /* the convection ramp, anchored to `hot` the same way so the three
         stops are one continuous blackbody sweep and their mean is the base */
      tempAmp: dT,
      activity: act,
      granHot: mixC([hotT.r, hotT.g, hotT.b], [255, 255, 255], whiteMix),
      granCool: mixC([coolT.r, coolT.g, coolT.b], [255, 255, 255], whiteMix),
      /* The bright middle of the disc. It is the star's own light seen
         straight down through the least atmosphere, so it carries the
         star's own colour: painting it white made every cool star read
         cream at the one place the eye looks first. */
      /* the second whitening tapers with the first, or the middle of a red
         supergiant's disc -- the one place the eye lands -- stays cream */
      core: mixC(mixC([hotT.r, hotT.g, hotT.b], [255, 255, 255], whiteMix),
                 [255, 252, 244], 0.35 - 0.21 * coolK),
      umbra: mixC([umbT.r, umbT.g, umbT.b], [255, 255, 255], whiteMix * 0.5),
      penumbra: mixC([penT.r, penT.g, penT.b], [255, 255, 255], whiteMix * 0.7)
    };
  }

  /* ---- flare / prominence gates ----
     Slot k of a star is a sine gate: it opens for `dur` seconds around each
     peak of sin(phase + t*w). Deterministic in (seed, k, t), which is what
     makes replays and screenshots reproducible. Rate 0 (hot stars) means the
     slot never opens: A/B/O stars get no prominences, which is honest. */
  var FLARE_SLOTS = 6;

  function flareAmp(seed, t, rate, k) {
    if (!(rate > 0.0005) || !fin(t)) return 0;
    var h = hash2(seed | 0, k * 2654435761);
    var phase = (h & 1023) / 1023 * TWO_PI;
    var phi = 0.65 + ((h >>> 10) & 255) / 255 * 1.15;
    var dur = 3 + ((h >>> 18) & 63) / 63 * 5;          /* 3 - 8 s */
    var w = rate * phi;
    var half = 0.5 * w * dur;
    if (half > 2.2) half = 2.2;                        /* never latched open */
    if (!(half > 1e-4)) return 0;
    var ph = phase + t * w;
    var d = ((ph - Math.PI / 2 + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
    if (Math.abs(d) > half) return 0;
    var u = d / half;
    /* fast rise, slow decay */
    return u < 0 ? Math.pow(1 + u, 0.45) : Math.pow(1 - u, 1.6);
  }

  /* Whole-disc brightening (the flare proper), about 1 s long. */
  function flareGlow(seed, t, rate) {
    if (!(rate > 0.05) || !fin(t)) return 0;
    var h = hash2(seed | 0, 990001);
    var phase = (h & 2047) / 2047 * TWO_PI;
    var w = rate * 0.55;
    var half = clamp(0.5 * w * 1.2, 1e-4, 1.6);
    var ph = phase + t * w;
    var d = ((ph - Math.PI / 2 + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
    if (Math.abs(d) > half) return 0;
    var u = Math.abs(d) / half;
    return Math.pow(1 - u, 1.3);
  }

  /* Read-only view of the gate values, for tests and for the page. */
  function flareState(params, t, out) {
    var p = params || {};
    var arr = out && out.length === FLARE_SLOTS ? out : new Array(FLARE_SLOTS);
    for (var k = 0; k < FLARE_SLOTS; k++) {
      arr[k] = flareAmp(p.seed | 0, num(t, 0), num(p.flareRate, 0), k);
    }
    return arr;
  }

  /* ---- prominence placement ----
     Four numbers per slot: [amp, ang, span, hgt].
       amp  0..1 gate value, 0 when the slot is shut (nothing is drawn)
       ang  screen angle of the loop's apex, radians
       span half-width of the loop's footprint on the limb, radians
       hgt  apex height as a FRACTION of the star's radius BEFORE the gate;
            the drawn apex sits at r * (1 + hgt * amp), so the maximum reach
            is r * 1.46 at hgt 0.46 and amp 1.
     This is the one place the placement is computed. drawProminences reads
     it, and so does the GL renderer, which is why the loops line up between
     the two paths. The math runs in float64 (the drawn geometry is float64
     everywhere else, and quantizing it here would move the 2D loops by a
     fraction of a pixel for nothing); flareUniforms below is the float32
     view of the same numbers, sized for a GPU uniform upload. */
  var PROM_SCRATCH = new Float64Array(FLARE_SLOTS * 4);

  function flareSlots(params, t, out) {
    var p = (params && typeof params === 'object') ? params : {};
    var arr = (out && out.length >= FLARE_SLOTS * 4) ? out : new Float64Array(FLARE_SLOTS * 4);
    var seed = p.seed | 0;
    var rate = num(p.flareRate, 0);
    var tt = num(t, 0);
    for (var k = 0; k < FLARE_SLOTS; k++) {
      var i = k * 4;
      var a = flareAmp(seed, tt, rate, k);
      if (a <= 0.02) { arr[i] = 0; arr[i + 1] = 0; arr[i + 2] = 0; arr[i + 3] = 0; continue; }
      var h = hash2(seed, k * 40503 + 17);
      arr[i] = a;
      arr[i + 1] = (h & 4095) / 4095 * TWO_PI + tt * 0.03;
      arr[i + 2] = 0.16 + ((h >>> 12) & 127) / 127 * 0.30;
      arr[i + 3] = 0.16 + ((h >>> 19) & 63) / 63 * 0.30;
    }
    return arr;
  }

  /* Float32 copy of flareSlots, for uploading straight into a shader. `out`
     is reused when it is big enough, so a per-frame call allocates nothing. */
  function flareUniforms(params, t, out) {
    var src = flareSlots(params, t, PROM_SCRATCH);
    var n = FLARE_SLOTS * 4;
    var arr = (out && out.length >= n) ? out : new Float32Array(n);
    for (var i = 0; i < n; i++) arr[i] = src[i];
    return arr;
  }

  /* ---- star surface texture ----
     Granulation (value noise with a darker lane network) plus 2 to 5 baked
     starspots, in an equal-area strip so the spots rotate with the surface. */
  function buildStarTex(params, q) {
    var TW = texW(q), TH = texH(q);
    var cv = makeCanvas(TW, TH);
    var tc = ctx2d(cv);
    if (!cv || !tc || !tc.createImageData || !tc.putImageData) return null;
    var img = tc.createImageData(TW, TH);
    var dat = img.data;
    var look = starLook(params);
    var seed = look.seed;
    var gs = look.granuleScale;
    var spotAmp = look.spotAmp;
    var nGran = clamp(Math.round(6 / Math.max(0.02, gs)), 12, 128);
    var nSup = Math.max(4, Math.round(nGran / 5));

    var bc = look.rgb;
    /* the visible disc is hotter than the catalog color: push toward white */
    var hot = look.hot;
    var cool = look.cool;
    var hotR = hot[0], hotG = hot[1], hotB = hot[2];
    var coolR = cool[0], coolG = cool[1], coolB = cool[2];

    /* starspot placement comes from starLook, so the strip and any other
       renderer of this star put the spots in the same places */
    var spots = look.spots;
    var nSpots = spots.length;
    var spU = [], spSin = [], spCos = [], spLim = [], spInv = [];
    var si;
    for (si = 0; si < nSpots; si++) {
      spU.push(spots[si].u);
      var sl = spots[si].v;                            /* spots hug low lats */
      spSin.push(sl);
      spCos.push(Math.sqrt(Math.max(0, 1 - sl * sl)));
      /* the cosine of the angular radius, precomputed: calling Math.cos on
         it inside the pixel loop cost more than all the noise put together */
      var lim = Math.cos(spots[si].r);
      spLim.push(lim);
      spInv.push(1 / Math.max(1e-6, 1 - lim));
    }
    /* per-spot cos(delta longitude) per column, so the pixel loop stays cheap */
    var cosDl = [];
    for (si = 0; si < nSpots; si++) {
      var row = new Float32Array(TW);
      for (var x2 = 0; x2 < TW; x2++) {
        row[x2] = Math.cos(((x2 + 0.5) / TW - spU[si]) * TWO_PI);
      }
      cosDl.push(row);
    }

    /* granulation, the intergranular lane network, and the slow
       supergranulation mottling */
    var F_G = field(TW, TH, 2, nGran, nGran * 0.5, nGran, seed, 2, 0.5, false);
    var F_L = field(TW, TH, 2, nGran * 1.15, nGran * 0.575, nGran, seed + 77, 2, 0.5, true);
    var F_S = field(TW, TH, 4, nSup, nSup * 0.5, nSup, seed + 313, 1, 0.5, false);

    var i = 0, x, y;
    for (y = 0; y < TH; y++) {
      var sinLat = 1 - 2 * (y + 0.5) / TH;
      var cosLat = Math.sqrt(Math.max(0, 1 - sinLat * sinLat));
      for (x = 0; x < TW; x++) {
        var u = (x + 0.5) / TW;
        var g = smp(F_G, u, y);
        var lane = smp(F_L, u, y);
        var sup = smp(F_S, u, y);
        /* +/- 8 percent granulation, plus dark intergranular lanes */
        var b = 1 + (g - 0.5) * 0.16 + (sup - 0.5) * 0.07 - lane * lane * lane * 0.10;

        var dark = 0;
        for (si = 0; si < nSpots; si++) {
          var lim = spLim[si];
          var cosd = sinLat * spSin[si] + cosLat * spCos[si] * cosDl[si][x];
          if (cosd > lim) {
            var f = (cosd - lim) * spInv[si];
            /* umbra core plus a softer penumbra */
            var dd = spotAmp * (0.45 * smooth(f * 1.6) + 0.55 * smooth((f - 0.35) / 0.65));
            if (dd > dark) dark = dd;
          }
        }

        var r0 = hotR * b, g0 = hotG * b, b0 = hotB * b;
        if (dark > 0) {
          var m = 1 - dark;
          r0 = r0 * m + (coolR * m - r0 * m) * 0.55;
          g0 = g0 * m + (coolG * m - g0 * m) * 0.55;
          b0 = b0 * m + (coolB * m - b0 * m) * 0.55;
        }
        /* Uint8ClampedArray clamps and rounds on assignment: an extra clamp()
           here is three function calls per pixel for nothing */
        dat[i] = r0;
        dat[i + 1] = g0;
        dat[i + 2] = b0;
        dat[i + 3] = 255;
        i += 4;
      }
    }
    tc.putImageData(img, 0, 0);
    return { tex: cv, aux: null, rgb: bc, hot: hot, cool: cool };
  }

  function starTexKey(p, q) {
    return 'S|' + (p.seed | 0) + '|' + (fin(p.teff) ? Math.round(p.teff / 40) : 'n') +
           '|' + Math.round(num(p.granuleScale, 0) * 1000) +
           '|' + Math.round(num(p.spotAmp, 0) * 100) + '|' + (q ? 1 : 0);
  }

  /* ---- prominences: bezier loops standing off the limb ---- */
  function drawProminences(ctx, cx, cy, r, params, t, tint) {
    var rate = num(params.flareRate, 0);
    if (!(rate > 0.0005)) return;
    /* placement comes from flareSlots so the 2D loops and the GL ones are
       the same loops; the scratch buffer keeps this allocation-free */
    var U = flareSlots(params, t, PROM_SCRATCH);
    var lw = Math.max(0.8, r * 0.055);
    for (var k = 0; k < FLARE_SLOTS; k++) {
      var u = k * 4;
      var a = U[u];
      if (a <= 0.02) continue;
      var ang = U[u + 1];
      var span = U[u + 2];
      var hgt = r * U[u + 3] * a;
      var a0 = ang - span, a1 = ang + span;
      var x0 = cx + Math.cos(a0) * r * 0.97, y0 = cy + Math.sin(a0) * r * 0.97;
      var x1 = cx + Math.cos(a1) * r * 0.97, y1 = cy + Math.sin(a1) * r * 0.97;
      var apx = cx + Math.cos(ang) * (r + hgt);
      var apy = cy + Math.sin(ang) * (r + hgt);
      if (!fin(x0) || !fin(y0) || !fin(x1) || !fin(y1) || !fin(apx) || !fin(apy)) continue;
      /* two strands: a bright core and a wider, fainter sheath */
      var strands = 2;
      for (var s = 0; s < strands; s++) {
        var wob = s === 0 ? 0 : 0.35;
        var mx = apx + (x1 - x0) * 0.10 * wob;
        var my = apy + (y1 - y0) * 0.10 * wob;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.quadraticCurveTo(mx, my, x1, y1);
        ctx.lineWidth = s === 0 ? lw : lw * 2.1;
        ctx.strokeStyle = rgba(tint, a * (s === 0 ? 0.75 : 0.28));
        ctx.stroke();
      }
    }
    ctx.lineWidth = 1;
  }

  /* ---- the neutron star: a point plus a lighthouse ---- */
  function drawPulsar(ctx, cx, cy, r, params, t, q) {
    var core = Math.max(1.2, Math.min(r * 0.30, 3.5));
    var beamL = Math.max(48, r * 7);
    var spin = num(t, 0) * TWO_PI * 1.6;               /* 1.6 Hz, slowed way down */
    var tint = [188, 214, 255];
    var prev = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';

    /* the two opposed cones */
    var half = 0.085;
    for (var s = 0; s < 2; s++) {
      var ang = spin + s * Math.PI;
      var ca = Math.cos(ang), sa = Math.sin(ang);
      var tipx = cx + ca * beamL, tipy = cy + sa * beamL;
      var nx = -sa, ny = ca;
      var wid = beamL * Math.tan(half);
      if (!fin(tipx) || !fin(tipy) || !fin(wid)) continue;
      /* a beam swinging toward the viewer reads as a flash */
      var face = 0.42 + 0.58 * Math.pow(Math.abs(Math.cos(ang)), 6);
      var g = lgrad(ctx, cx, cy, tipx, tipy);
      if (g) {
        stop(g, 0, rgba(tint, 0.55 * face));
        stop(g, 0.35, rgba(tint, 0.20 * face));
        stop(g, 1, rgba(tint, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(tipx + nx * wid, tipy + ny * wid);
        ctx.lineTo(tipx - nx * wid, tipy - ny * wid);
        ctx.closePath();
        ctx.fill();
      }
    }
    /* magnetosphere hint: two faint field loops, only at full quality */
    if (q) {
      ctx.strokeStyle = rgba(tint, 0.12);
      ctx.lineWidth = 1;
      for (var f = 0; f < 2; f++) {
        var rr = core * (5 + f * 3.5);
        var ry = rr * 0.34;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(spin);
        ctx.scale(1, Math.max(0.02, ry / rr));
        if (circle(ctx, 0, 0, rr)) ctx.stroke();
        ctx.restore();
      }
    }
    /* the star itself */
    var gg = rgrad(ctx, cx, cy, 0, cx, cy, core * 6);
    if (gg) {
      stop(gg, 0, 'rgba(255,255,255,0.95)');
      stop(gg, 0.14, rgba(tint, 0.55));
      stop(gg, 1, rgba(tint, 0));
      ctx.fillStyle = gg;
      if (circle(ctx, cx, cy, core * 6)) ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,255,255,1)';
    if (circle(ctx, cx, cy, core)) ctx.fill();
    ctx.globalCompositeOperation = prev;
  }

  /* ---- the white dwarf: tiny, sharp, featureless ---- */
  function drawWhiteDwarf(ctx, cx, cy, r) {
    var tint = [206, 224, 255];
    var prev = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';
    var gh = rgrad(ctx, cx, cy, r * 0.6, cx, cy, r * 4.2);
    if (gh) {
      stop(gh, 0, rgba(tint, 0.30));
      stop(gh, 1, rgba(tint, 0));
      ctx.fillStyle = gh;
      if (circle(ctx, cx, cy, r * 4.2)) ctx.fill();
    }
    ctx.globalCompositeOperation = prev;
    var g = rgrad(ctx, cx - r * 0.2, cy - r * 0.2, 0, cx, cy, r);
    if (g) {
      stop(g, 0, 'rgba(255,255,255,1)');
      stop(g, 0.62, rgba(tint, 1));
      stop(g, 0.94, rgba(mixC(tint, [120, 160, 220], 0.5), 1));
      stop(g, 1, rgba(mixC(tint, [80, 118, 180], 0.6), 1));
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = rgba(tint, 1);
    }
    if (circle(ctx, cx, cy, r)) ctx.fill();
  }

  /* ---- the three star passes ----
     drawStar is pass 1 + pass 2 + pass 3, in that order, and that is the only
     way it is ever assembled. A renderer that draws the DISC some other way
     (the GL orb) calls pass 1, blits its disc, then calls pass 3, and the
     glow around it is the same glow, drawn by the same code.
     None of the three touches globalAlpha; the public entry points do. */

  /* pass 1: the corona. Additive, and it puts the composite mode back. */
  function starBackPass(ctx, x, y, r, look, bright, q) {
    var prevOp = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';
    var cg = rgrad(ctx, x, y, r * 0.72, x, y, r * (q ? 3.1 : 2.4));
    if (cg) {
      stop(cg, 0, rgba(look.glow, 0.42 * bright));
      stop(cg, 0.24, rgba(look.glow, 0.17 * bright));
      stop(cg, 0.62, rgba(look.rgb, 0.055 * bright));
      stop(cg, 1, rgba(look.rgb, 0));
      ctx.fillStyle = cg;
      if (circle(ctx, x, y, r * (q ? 3.1 : 2.4))) ctx.fill();
    }
    ctx.globalCompositeOperation = prevOp;
  }

  /* pass 2: the disc, the limb, the chromosphere and the prominences. Leaves
     the composite mode on 'lighter' -- everything after it is emission. */
  function starMidPass(ctx, x, y, r, p, look, tt, q, bright) {
    /* 2. the disc: flat base first so a missing texture still reads as a star */
    ctx.fillStyle = rgba(look.hot, 1);
    if (circle(ctx, x, y, r)) ctx.fill();

    /* 3. granulation strip, masked to the disc */
    var entry = texGet(starTexKey(p, q), function () { return buildStarTex(p, q); });
    if (entry && entry.tex) {
      ctx.save();
      if (circle(ctx, x, y, r)) {
        ctx.clip();
        drawSphere(ctx, x, y, r, entry.tex, tt * TWO_PI / 45, slabCount(q));
      }
      ctx.restore();
    }

    /* 4. limb darkening (cooler stars darken harder) and a hot core */
    var limbC = look.limb;
    var ld = look.limbExp;
    var lg = rgrad(ctx, x, y, r * 0.10, x, y, r);
    if (lg) {
      stop(lg, 0, rgba(limbC, 0));
      stop(lg, 0.55, rgba(limbC, ld * 0.16));
      stop(lg, 0.82, rgba(limbC, ld * 0.50));
      stop(lg, 0.96, rgba(limbC, ld * 0.92));
      stop(lg, 1, rgba(limbC, ld));
      ctx.fillStyle = lg;
      if (circle(ctx, x, y, r)) ctx.fill();
    }
    ctx.globalCompositeOperation = 'lighter';
    var hg = rgrad(ctx, x - r * 0.12, y - r * 0.12, 0, x, y, r * 0.92);
    if (hg) {
      var coreC = look.core || look.hot;
      stop(hg, 0, rgba(coreC, clamp(0.30 * bright, 0, 1)));
      stop(hg, 0.5, rgba(coreC, clamp(0.09 * bright, 0, 1)));
      stop(hg, 1, rgba(coreC, 0));
      ctx.fillStyle = hg;
      if (circle(ctx, x, y, r * 0.92)) ctx.fill();
    }

    /* 5. chromosphere. The composite operation is deliberately left on
       'lighter' from the hot core above: this, the prominences and the flare
       brightening are all emission and belong on top additively.
       It is drawn as an ANNULUS starting AT the limb and fading outward, never
       as a stroke sitting on the disc: a bright ring on the edge reads as an
       outline and contradicts the limb darkening underneath it. */
    var promC = look.prom;
    var chOut = r * 1.20;
    var chg = rgrad(ctx, x, y, r, x, y, chOut);
    if (chg && r > 0.5) {
      stop(chg, 0, rgba(promC, 0.26));
      stop(chg, 0.35, rgba(promC, 0.12));
      stop(chg, 1, rgba(promC, 0));
      ctx.fillStyle = chg;
      ctx.beginPath();
      ctx.arc(x, y, chOut, 0, TWO_PI);
      ctx.arc(x, y, r, 0, TWO_PI, true);   /* reversed: leaves the disc alone */
      ctx.fill();
    }

    /* 6. prominences (full quality only) */
    if (q) drawProminences(ctx, x, y, r, p, tt, promC);
  }

  /* pass 3: the whole-disc flare bloom. `manageOp` is false when drawStar
     calls it (the composite mode is already additive at that point and the
     caller restores it), true for the standalone entry point. */
  function starFrontPass(ctx, x, y, r, look, glow, manageOp) {
    if (!(glow > 0.01)) return;
    var prevOp;
    if (manageOp) {
      prevOp = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = 'lighter';
    }
    var fg = rgrad(ctx, x, y, 0, x, y, r * 1.9);
    if (fg) {
      stop(fg, 0, 'rgba(255,250,238,' + clamp(0.34 * glow, 0, 1) + ')');
      stop(fg, 0.5, rgba(look.glow, 0.16 * glow));
      stop(fg, 1, rgba(look.glow, 0));
      ctx.fillStyle = fg;
      if (circle(ctx, x, y, r * 1.9)) ctx.fill();
    }
    if (manageOp) ctx.globalCompositeOperation = prevOp;
  }

  /* Shared argument sanitizing for the four star entry points. Returns null
     when there is nothing to draw, so a junk call is a no-op, never a throw. */
  function starArgs(ctx, cx, cy, rPx, params, t, opts) {
    if (!ctx || !ctx.beginPath) return null;
    var o = opts || {};
    /* compose with whatever fade the caller already had on the context, and
       put it back untouched on the way out */
    var prevAlpha = clamp(num(ctx.globalAlpha, 1), 0, 1);
    var alpha = clamp(num(o.alpha, 1), 0, 1) * prevAlpha;
    var x = num(cx, NaN), y = num(cy, NaN), r = num(rPx, NaN);
    if (!fin(x) || !fin(y) || !fin(r) || r <= 0 || alpha <= 0.004) return null;
    if (r > 4000) r = 4000;
    return {
      p: (params && typeof params === 'object') ? params : starParams(null),
      q: o.quality === 0 ? 0 : 1,
      x: x, y: y, r: r, t: num(t, 0),
      alpha: alpha, prevAlpha: prevAlpha
    };
  }

  function starGlow(p, tt) {
    return flareGlow(p.seed | 0, tt, num(p.flareRate, 0));
  }

  /* ---- drawStar(ctx, cx, cy, rPx, params, t, opts) ----
     params comes from starParams(). t is seconds. opts:
       quality: 1 (default) full art, 0 card preview (half-res strip, no
                prominences, no ring bands)
       alpha:   0..1 overall fade, for the page's distance ramps (default 1)
     Nothing here reads or writes any state outside the texture cache, and
     the call is a no-op on junk geometry rather than a throw. */
  function drawStar(ctx, cx, cy, rPx, params, t, opts) {
    var A = starArgs(ctx, cx, cy, rPx, params, t, opts);
    if (!A) return;
    var p = A.p, x = A.x, y = A.y, r = A.r, tt = A.t, q = A.q;

    /* the fade lives on the context and nowhere else, so every layer below
       carries its own opacity only and the overall fade stays linear */
    ctx.globalAlpha = A.alpha;
    if (p.kind === 'ns') {
      drawPulsar(ctx, x, y, r, p, tt, q);
      ctx.globalAlpha = A.prevAlpha;
      return;
    }
    if (p.kind === 'wd') {
      drawWhiteDwarf(ctx, x, y, r);
      ctx.globalAlpha = A.prevAlpha;
      return;
    }

    var look = starLook(p);
    var glow = starGlow(p, tt);
    var bright = 1 + 0.12 * glow;
    var prevOp = ctx.globalCompositeOperation;

    starBackPass(ctx, x, y, r, look, bright, q);
    starMidPass(ctx, x, y, r, p, look, tt, q, bright);
    starFrontPass(ctx, x, y, r, look, glow, false);

    ctx.globalCompositeOperation = prevOp;
    ctx.globalAlpha = A.prevAlpha;
  }

  /* ---- the passes as public entry points ----
     Same arguments as drawStar. Back and front are no-ops for the pulsar and
     the white dwarf: those two are drawn whole by drawStarMid (and by
     drawStar), because their look is not a disc with a corona around it. */
  function drawStarBack(ctx, cx, cy, rPx, params, t, opts) {
    var A = starArgs(ctx, cx, cy, rPx, params, t, opts);
    if (!A) return;
    var p = A.p;
    if (p.kind === 'ns' || p.kind === 'wd') return;
    var look = starLook(p);
    var bright = 1 + 0.12 * starGlow(p, A.t);
    ctx.globalAlpha = A.alpha;
    starBackPass(ctx, A.x, A.y, A.r, look, bright, A.q);
    ctx.globalAlpha = A.prevAlpha;
  }

  function drawStarMid(ctx, cx, cy, rPx, params, t, opts) {
    var A = starArgs(ctx, cx, cy, rPx, params, t, opts);
    if (!A) return;
    var p = A.p;
    ctx.globalAlpha = A.alpha;
    if (p.kind === 'ns') {
      drawPulsar(ctx, A.x, A.y, A.r, p, A.t, A.q);
      ctx.globalAlpha = A.prevAlpha;
      return;
    }
    if (p.kind === 'wd') {
      drawWhiteDwarf(ctx, A.x, A.y, A.r);
      ctx.globalAlpha = A.prevAlpha;
      return;
    }
    var look = starLook(p);
    var bright = 1 + 0.12 * starGlow(p, A.t);
    var prevOp = ctx.globalCompositeOperation;
    starMidPass(ctx, A.x, A.y, A.r, p, look, A.t, A.q, bright);
    ctx.globalCompositeOperation = prevOp;
    ctx.globalAlpha = A.prevAlpha;
  }

  function drawStarFront(ctx, cx, cy, rPx, params, t, opts) {
    var A = starArgs(ctx, cx, cy, rPx, params, t, opts);
    if (!A) return;
    var p = A.p;
    if (p.kind === 'ns' || p.kind === 'wd') return;
    var glow = starGlow(p, A.t);
    if (!(glow > 0.01)) return;
    ctx.globalAlpha = A.alpha;
    starFrontPass(ctx, A.x, A.y, A.r, starLook(p), glow, true);
    ctx.globalAlpha = A.prevAlpha;
  }

  /* ==========================================================================
     PLANETS AND EXOPLANETS
     ========================================================================== */

  /* The eight solar planets. Colors are data, not chrome: these are the
     naturalistic palettes of well-photographed worlds. */
  var SOLAR = {
    mercury: {
      type: 'mercury', bands: 0, clouds: false, poles: false, craters: 120,
      palette: [[126, 116, 106], [88, 80, 74], [166, 156, 144]]
    },
    venus: {
      type: 'venus', bands: 3, clouds: false, poles: false,
      palette: [[236, 220, 176], [210, 188, 138], [252, 246, 224]]
    },
    earth: {
      type: 'earth', bands: 0, clouds: true, poles: true,
      palette: [[10, 38, 78], [30, 86, 134], [56, 100, 54], [148, 130, 94], [248, 250, 252]]
    },
    mars: {
      type: 'mars', bands: 0, clouds: false, poles: true, craters: 70,
      palette: [[176, 96, 58], [118, 68, 46], [240, 240, 238]]
    },
    jupiter: {
      type: 'jupiter', bands: 11, clouds: false, poles: false,
      palette: [[216, 194, 162], [170, 136, 102], [242, 230, 210], [118, 90, 72]],
      spot: { lon: 0.35, sinLat: -0.36, w: 0.055, h: 0.085, rgb: [190, 104, 74] }
    },
    saturn: {
      type: 'saturn', bands: 8, clouds: false, poles: false,
      palette: [[228, 208, 162], [198, 174, 126], [246, 234, 206]],
      rings: { inner: 1.24, outer: 2.27, tilt: 0.4665 }
    },
    uranus: {
      type: 'uranus', bands: 2, clouds: false, poles: false,
      palette: [[174, 220, 224], [156, 206, 212], [198, 234, 236]]
    },
    neptune: {
      type: 'neptune', bands: 4, clouds: false, poles: false,
      palette: [[50, 84, 166], [36, 64, 138], [92, 124, 196]],
      spot: { lon: 0.62, sinLat: 0.30, w: 0.052, h: 0.062, rgb: [24, 36, 82] }
    }
  };

  function planetParams(key) {
    var k = (typeof key === 'string') ? key.toLowerCase() : '';
    if (!Object.prototype.hasOwnProperty.call(SOLAR, k)) return null;
    var src = SOLAR[k];
    var out = {
      type: src.type,
      palette: src.palette,
      bands: src.bands,
      clouds: src.clouds,
      poles: src.poles,
      seed: hashStr('solar:' + k)
    };
    if (src.craters) out.craters = src.craters;
    if (src.spot) out.spot = src.spot;
    if (src.rings) out.rings = { inner: src.rings.inner, outer: src.rings.outer, tilt: src.rings.tilt };
    return out;
  }

  /* Exoplanet type mapping. Honest and pinned: everything is derived from the
     measured radius, mass and equilibrium temperature, and a planet with no
     measurements at all falls all the way back to a plain rock. */
  var EXO_PAL = {
    gas: [[212, 190, 158], [166, 132, 100], [238, 226, 206], [116, 88, 70]],
    hotjup: [[122, 74, 66], [58, 36, 44], [166, 108, 84], [40, 26, 32]],
    neptunian: [[126, 152, 184], [92, 118, 152], [166, 190, 214]],
    lava: [[26, 22, 24], [12, 10, 12], [255, 138, 44], [255, 208, 120]],
    temperate: [[16, 52, 96], [34, 92, 136], [62, 104, 62], [150, 134, 100], [246, 250, 252]],
    ice: [[206, 220, 234], [176, 198, 220], [242, 248, 252]],
    rock: [[132, 120, 106], [96, 86, 76], [168, 156, 138]]
  };

  function exoParams(o) {
    var s = (o && typeof o === 'object') ? o : {};
    var rade = fin(s.rade) ? s.rade : NaN;
    var masse = fin(s.masse) ? s.masse : NaN;
    var eqt = fin(s.eqt) ? s.eqt : NaN;
    var a = fin(s.a) ? s.a : NaN;
    var hostTeff = fin(s.hostTeff) ? s.hostTeff : NaN;
    var inHz = !!s.inHz;

    var type;
    var big = false, mid = false;
    if (fin(rade)) {
      if (rade >= 6) big = true;
      else if (rade >= 1.8) mid = true;
    } else if (fin(masse)) {
      /* no radius measured: fall back to mass, same three tiers */
      if (masse >= 50) big = true;
      else if (masse >= 10) mid = true;
    }

    if (big) {
      type = (fin(eqt) && eqt > 900) ? 'hotjup' : 'gas';
    } else if (mid) {
      type = 'neptunian';
    } else if (fin(eqt) && eqt > 1200) {
      type = 'lava';
    } else if ((fin(eqt) && eqt >= 180 && eqt <= 330) || inHz) {
      type = 'temperate';
    } else if (fin(eqt) && eqt < 180) {
      type = 'ice';
    } else {
      type = 'rock';
    }

    var locked = fin(a) && a < 0.1 && fin(hostTeff) && hostTeff < 4000;
    var eyeball = locked && (type === 'temperate' || type === 'ice');

    var seed;
    if (fin(s.seed)) seed = (s.seed | 0) >>> 0;
    else seed = hashStr('exo:' + type + ':' + rade + ':' + masse + ':' + eqt + ':' + a);
    if (!seed) seed = 1;

    /* The host's light tints a temperate world's daylight: a red dwarf's
       planet really would look ruddier than Earth. The raw blackbody color
       is mixed halfway to white first. Reflected light literally is albedo
       times the star's spectrum, so a 2600 K host would leave almost no
       blue at all, and a world rendered that way reads as a broken image
       rather than as a planet. Half strength keeps the honest direction of
       the shift without pretending the oceans are gone. */
    var tint = null;
    if (fin(hostTeff) && (type === 'temperate' || type === 'ice')) {
      var c = kelvinRgb(hostTeff);
      tint = mixC([c.r, c.g, c.b], [255, 255, 255], 0.5);
    }

    var out = {
      type: type,
      palette: EXO_PAL[type] || EXO_PAL.rock,
      bands: (type === 'gas' || type === 'hotjup') ? 9 : (type === 'neptunian' ? 5 : 0),
      clouds: (type === 'temperate'),
      poles: (type === 'temperate' && !eyeball),
      seed: seed,
      locked: locked,
      eyeball: eyeball,
      emissive: (type === 'lava' || type === 'hotjup'),
      tint: tint,
      eqt: eqt,
      rade: rade
    };
    if (type === 'rock' || type === 'ice') out.craters = (type === 'rock') ? 90 : 30;
    if (type === 'gas' || type === 'hotjup') {
      out.spot = { lon: 0.42, sinLat: -0.28, w: 0.05, h: 0.07,
                   rgb: type === 'hotjup' ? [96, 52, 52] : [186, 118, 88] };
    }
    return out;
  }

  /* ---- planetLook(params) ----
     The planet side of starLook: one object holding the type, the palette and
     every derived tint the renderer paints with, so a second renderer draws
     the same world. params comes from planetParams() or exoParams().

     `limbExp` is the terminator darkness cap this file feeds to shadeSphere.
     A planet is shaded by a Lambert term, not by a stellar limb-darkening
     exponent, so the field carries the number that actually exists rather
     than an invented exponent; emissive worlds cap lower because their night
     side glows.

     Returns a FRESH object every call; treat it as read-only. */
  function planetLook(params) {
    var p = (params && typeof params === 'object') ? params : {};
    var type = p.type || 'rock';
    var pal = p.palette || EXO_PAL.rock;
    var emissive = !!p.emissive;
    var rings = p.rings || null;
    var atmos = (type === 'earth' || type === 'temperate' || type === 'venus' ||
                 type === 'gas' || type === 'hotjup' || type === 'neptunian' ||
                 type === 'jupiter' || type === 'saturn' || type === 'uranus' ||
                 type === 'neptune');
    var banded = (type === 'jupiter' || type === 'saturn' || type === 'uranus' ||
                  type === 'neptune' || type === 'gas' || type === 'hotjup' ||
                  type === 'neptunian');
    return {
      type: type,
      palette: pal,
      bands: num(p.bands, 0),
      clouds: !!p.clouds,
      poles: !!p.poles,
      craters: num(p.craters, 0),
      limbExp: emissive ? 0.86 : 0.95,
      rings: rings,
      /* the rest is what the 2D passes below actually paint with */
      seed: p.seed | 0,
      locked: !!p.locked,
      eyeball: !!p.eyeball,
      emissive: emissive,
      banded: banded,
      watery: (type === 'earth' || type === 'temperate'),
      atmos: atmos,
      tint: p.tint || null,
      spot: p.spot || null,
      night: emissive ? [12, 6, 6] : [2, 3, 6],
      atmC: atmos
        ? ((type === 'earth' || type === 'temperate')
            ? [150, 196, 246]
            : mixC(pal[0], [255, 255, 255], 0.45))
        : null,
      emisC: emissive ? (type === 'lava' ? [255, 132, 46] : [214, 108, 78]) : null,
      ringTint: rings ? mixC(pal[0], [255, 250, 236], 0.55) : null
    };
  }

  /* ---- planet texture strips ---- */

  function stampCraters(dat, TW, TH, rnd, count) {
    var c, y, x;
    for (c = 0; c < count; c++) {
      var cu = rnd();
      var cs = rnd() * 2 - 1;
      var rad = 0.010 + Math.pow(rnd(), 3) * 0.055;
      var cxp = cu * TW, cyp = (0.5 - cs * 0.5) * TH;
      var rx = Math.max(1.2, rad * TW), ry = Math.max(1.0, rad * TH * 0.92);
      var y0 = Math.max(0, Math.floor(cyp - ry)), y1 = Math.min(TH - 1, Math.ceil(cyp + ry));
      var x0 = Math.floor(cxp - rx), x1 = Math.ceil(cxp + rx);
      for (y = y0; y <= y1; y++) {
        var dy = (y + 0.5 - cyp) / ry;
        for (x = x0; x <= x1; x++) {
          var dx = (x + 0.5 - cxp) / rx;
          var d = Math.sqrt(dx * dx + dy * dy);
          if (d > 1) continue;
          var xw = x % TW; if (xw < 0) xw += TW;
          var f;
          if (d < 0.70) f = -0.20 * (1 - d / 0.70) - 0.05;
          else if (d < 0.92) f = 0.22 * smooth((d - 0.70) / 0.22);
          else f = 0.22 * (1 - smooth((d - 0.92) / 0.08)) - 0.04;
          /* a touch of relief: the northern rim catches more light */
          f += -0.05 * dy;
          var i = (y * TW + xw) * 4;
          var k = 1 + f;
          dat[i] = dat[i] * k;
          dat[i + 1] = dat[i + 1] * k;
          dat[i + 2] = dat[i + 2] * k;
        }
      }
    }
  }

  /* Oval feature (Great Red Spot, Neptune's dark oval, gas-giant storms). */
  function ovalAt(u, sinLat, spot) {
    var du = u - spot.lon;
    du -= Math.round(du);
    var dv = (sinLat - spot.sinLat);
    var d = Math.sqrt((du / spot.w) * (du / spot.w) + (dv / spot.h) * (dv / spot.h));
    if (d > 1.25) return 0;
    return 1 - smooth((d - 0.45) / 0.80);
  }

  function buildPlanetTex(params, q) {
    var TW = texW(q), TH = texH(q);
    var cv = makeCanvas(TW, TH);
    var tc = ctx2d(cv);
    if (!cv || !tc || !tc.createImageData || !tc.putImageData) return null;
    var img = tc.createImageData(TW, TH);
    var dat = img.data;
    var seed = (params.seed | 0) || 1;
    var type = params.type;
    var pal = params.palette || EXO_PAL.rock;
    var nb = Math.max(0, num(params.bands, 0));
    var eyeball = !!params.eyeball;
    var tint = params.tint;

    var banded = (type === 'jupiter' || type === 'saturn' || type === 'uranus' ||
                  type === 'neptune' || type === 'gas' || type === 'hotjup' ||
                  type === 'neptunian');
    var watery = (type === 'earth' || type === 'temperate');
    var base = 8;                       /* continental / band noise period */
    var nF = 26;                        /* fine detail period */
    var i = 0, x, y;
    var glowRows = params.emissive && type === 'lava';
    var glowDat = null, glowCv = null, glowCtx = null, glowImg = null;
    if (glowRows) {
      glowCv = makeCanvas(TW, TH);
      glowCtx = ctx2d(glowCv);
      if (glowCtx && glowCtx.createImageData) {
        glowImg = glowCtx.createImageData(TW, TH);
        glowDat = glowImg.data;
      }
    }

    /* Palette channels are pulled out as scalars: the pixel loop runs 131k
       times and must not allocate a single array. */
    var P0 = pal[0] || [128, 128, 128];
    var P1 = pal[1] || P0, P2 = pal[2] || P0, P3 = pal[3] || null, P4 = pal[4] || P2;
    var p0r = P0[0], p0g = P0[1], p0b = P0[2];
    var p1r = P1[0], p1g = P1[1], p1b = P1[2];
    var p2r = P2[0], p2g = P2[1], p2b = P2[2];
    var p3r = P3 ? P3[0] : 0, p3g = P3 ? P3[1] : 0, p3b = P3 ? P3[2] : 0;
    var p4r = P4[0], p4g = P4[1], p4b = P4[2];
    var spot = params.spot || null;
    var spr = spot ? spot.rgb[0] : 0, spg = spot ? spot.rgb[1] : 0, spb = spot ? spot.rgb[2] : 0;
    var isUranus = (type === 'uranus');
    var tintR = tint ? tint[0] / 235 : 1;
    var tintG = tint ? tint[1] / 235 : 1;
    var tintB = tint ? tint[2] / 235 : 1;
    var sea0 = (type === 'temperate') ? 0.545 : 0.515;

    /* Only the fields this type actually reads get built. */
    var F_A = null, F_B = null, F_P = null;
    if (banded) {
      F_A = field(TW, TH, 3, 6, 3, 6, seed + 11, 2, 0.5, false);
      F_B = field(TW, TH, 2, nF, 9, nF, seed + 41, 2, 0.55, false);
    } else if (type === 'venus') {
      F_A = field(TW, TH, 2, 9, 5, 9, seed + 3, 2, 0.55, false);
      F_B = field(TW, TH, 2, 22, 12, 22, seed + 9, 2, 0.5, false);
    } else if (watery) {
      F_A = field(TW, TH, 2, base, base * 0.5, base, seed, 4, 0.52, false);
      F_B = field(TW, TH, 2, nF, nF * 0.5, nF, seed + 61, 2, 0.5, false);
    } else if (type === 'mars') {
      F_A = field(TW, TH, 2, base, base * 0.5, base, seed, 3, 0.55, false);
      F_B = field(TW, TH, 2, nF, nF * 0.5, nF, seed + 23, 2, 0.5, false);
    } else if (type === 'ice') {
      F_A = field(TW, TH, 2, 14, 8, 14, seed + 7, 2, 0.5, true);
      F_B = field(TW, TH, 2, base, base * 0.5, base, seed + 2, 2, 0.5, false);
    } else if (type === 'lava') {
      F_A = field(TW, TH, 2, 11, 6, 11, seed + 13, 3, 0.5, true);
      F_B = field(TW, TH, 2, nF, nF * 0.5, nF, seed + 29, 2, 0.5, false);
    } else {
      F_A = field(TW, TH, 2, base, base * 0.5, base, seed, 3, 0.55, false);
      F_B = field(TW, TH, 2, nF, nF * 0.5, nF, seed + 17, 2, 0.5, false);
    }
    if (params.poles) F_P = field(TW, TH, 4, 18, 9, 18, seed + 91, 1, 0.5, false);

    for (y = 0; y < TH; y++) {
      var sinLat = 1 - 2 * (y + 0.5) / TH;
      var absL = Math.abs(sinLat);
      var latSq = sinLat * sinLat;
      var shearBias = 0.55 * Math.pow(absL, 1.5) * (sinLat >= 0 ? 1 : -1);
      for (x = 0; x < TW; x++) {
        var u = (x + 0.5) / TW;
        var r, g, b;

        if (banded) {
          /* zonal flow: latitude bands warped by a wrapping noise field, so
             the band edges curl the way real jets do */
          var warp = smp(F_A, u, y) - 0.5;
          var sv = 0.5 + 0.5 * Math.sin((sinLat * nb + warp * 1.5) * Math.PI);
          var fine = smp(F_B, u, y);
          var fs = smooth(sv);
          var f2 = smooth((sv - 0.72) / 0.28) * 0.7;
          var shade = isUranus ? (0.98 + fine * 0.04) : (0.93 + fine * 0.14);
          var c1r = p1r + (p0r - p1r) * fs;
          var c1g = p1g + (p0g - p1g) * fs;
          var c1b = p1b + (p0b - p1b) * fs;
          r = (c1r + (p2r - c1r) * f2) * shade;
          g = (c1g + (p2g - c1g) * f2) * shade;
          b = (c1b + (p2b - c1b) * f2) * shade;
          if (P3) {
            var dk = smooth((0.30 - sv) / 0.30) * 0.5;
            r += (p3r - r) * dk; g += (p3g - g) * dk; b += (p3b - b) * dk;
          }
          if (spot) {
            var ov = ovalAt(u, sinLat, spot);
            if (ov > 0) {
              /* the storm covers a few thousand pixels, so this one stays a
                 direct evaluation rather than a whole extra field */
              var swirl = 0.85 + 0.3 * fbm(u * 40, (y + 0.5) / TH * 40, 40, seed + 5, 2, 0.5);
              r += (spr * swirl - r) * ov;
              g += (spg * swirl - g) * ov;
              b += (spb * swirl - b) * ov;
            }
          }
          /* polar hoods on the giants */
          if (absL > 0.86) {
            var pf = smooth((absL - 0.86) / 0.14) * 0.35;
            r -= r * 0.18 * pf; g -= g * 0.16 * pf; b -= b * 0.10 * pf;
          }
        } else if (type === 'venus') {
          /* the V: streaks sheared toward the poles */
          var shear = u + shearBias;
          var st = smp(F_A, shear, y);
          var st2 = smp(F_B, shear, y);
          var vsh = 0.94 + st * 0.09 + st2 * 0.04;
          var vf = smooth(st * 1.2), vg2 = smooth((absL - 0.55) / 0.45) * 0.5;
          var vr = p1r + (p0r - p1r) * vf;
          var vgg = p1g + (p0g - p1g) * vf;
          var vb = p1b + (p0b - p1b) * vf;
          r = (vr + (p2r - vr) * vg2) * vsh;
          g = (vgg + (p2g - vgg) * vg2) * vsh;
          b = (vb + (p2b - vb) * vg2) * vsh;
        } else if (watery) {
          var e = smp(F_A, u, y);
          var det = smp(F_B, u, y);
          e = e * 0.82 + det * 0.18;
          var sea = sea0;
          var sub = 0;
          if (eyeball) {
            /* tidally locked: open water only around the substellar point
               (longitude 0.5), ice everywhere else */
            var dlon = u - 0.5; dlon -= Math.round(dlon);
            sub = Math.sqrt(dlon * dlon * 3.4 + latSq * 0.85);
            sea = 0.515 + smooth((sub - 0.16) / 0.34) * 0.42;
          }
          if (e < sea) {
            var dep = smooth((sea - e) / 0.22);
            r = p1r + (p0r - p1r) * dep;
            g = p1g + (p0g - p1g) * dep;
            b = p1b + (p0b - p1b) * dep;
          } else {
            var h = smooth((e - sea) / 0.30);
            var hl = smooth((h - 0.30) / 0.55);
            var lr = p2r + (p3r - p2r) * hl;
            var lg = p2g + (p3g - p2g) * hl;
            var lb = p2b + (p3b - p2b) * hl;
            if (h > 0.72) {
              var sn = smooth((h - 0.72) / 0.28) * 0.8;
              lr += (p4r - lr) * sn; lg += (p4g - lg) * sn; lb += (p4b - lb) * sn;
            }
            var lsh = 0.90 + det * 0.20;
            r = lr * lsh; g = lg * lsh; b = lb * lsh;
          }
          if (eyeball) {
            var ice = smooth((sub - 0.30) / 0.26);
            r += (226 - r) * ice; g += (236 - g) * ice; b += (246 - b) * ice;
          }
        } else if (type === 'mars') {
          var mv = smp(F_A, u, y);
          var mdn = smp(F_B, u, y);
          var mf = smooth((0.52 - mv) / 0.30);
          var msh = 0.90 + mdn * 0.22;
          r = (p0r + (p1r - p0r) * mf) * msh;
          g = (p0g + (p1g - p0g) * mf) * msh;
          b = (p0b + (p1b - p0b) * mf) * msh;
        } else if (type === 'ice') {
          var fis = smp(F_A, u, y);
          var iv = smooth(smp(F_B, u, y));
          var crack = smooth((fis - 0.62) / 0.24) * 0.85;
          var icr = p0r + (p2r - p0r) * iv;
          var icg = p0g + (p2g - p0g) * iv;
          var icb = p0b + (p2b - p0b) * iv;
          r = icr + (p1r - icr) * crack;
          g = icg + (p1g - icg) * crack;
          b = icb + (p1b - icb) * crack;
        } else if (type === 'lava') {
          var cr = smp(F_A, u, y);
          var cru = smooth(smp(F_B, u, y));
          var hotf = smooth((cr - 0.70) / 0.26);
          var hf2 = smooth((cr - 0.86) / 0.14);
          var hcr = p2r + (p3r - p2r) * hf2;
          var hcg = p2g + (p3g - p2g) * hf2;
          var hcb = p2b + (p3b - p2b) * hf2;
          var kcr = p0r + (p1r - p0r) * cru;
          var kcg = p0g + (p1g - p0g) * cru;
          var kcb = p0b + (p1b - p0b) * cru;
          r = kcr + (hcr - kcr) * hotf;
          g = kcg + (hcg - kcg) * hotf;
          b = kcb + (hcb - kcb) * hotf;
          if (glowDat) {
            glowDat[i] = hcr; glowDat[i + 1] = hcg; glowDat[i + 2] = hcb;
            glowDat[i + 3] = hotf * 1.05 * 235;
          }
        } else {
          /* mercury and the generic rock */
          var rv = smp(F_A, u, y);
          var rd = smp(F_B, u, y);
          var rf = smooth(rv), rf2 = smooth((rv - 0.70) / 0.30) * 0.6;
          var rcr = p1r + (p0r - p1r) * rf;
          var rcg = p1g + (p0g - p1g) * rf;
          var rcb = p1b + (p0b - p1b) * rf;
          var rsh = 0.88 + rd * 0.26;
          r = (rcr + (p2r - rcr) * rf2) * rsh;
          g = (rcg + (p2g - rcg) * rf2) * rsh;
          b = (rcb + (p2b - rcb) * rf2) * rsh;
        }

        /* polar caps for the worlds that have them */
        if (params.poles && absL > 0.80) {
          var cap = smooth((absL - 0.80) / 0.15) *
                    (0.55 + smp(F_P, u, y) * 0.7);
          if (cap > 0) {
            if (cap > 1) cap = 1;
            r += (248 - r) * cap; g += (250 - g) * cap; b += (252 - b) * cap;
          }
        }
        /* host-light tint: a red dwarf's world really is ruddier */
        if (tint) {
          r += (r * tintR - r) * 0.45;
          g += (g * tintG - g) * 0.45;
          b += (b * tintB - b) * 0.45;
        }

        /* Uint8ClampedArray clamps and rounds on assignment */
        dat[i] = r;
        dat[i + 1] = g;
        dat[i + 2] = b;
        dat[i + 3] = 255;
        i += 4;
      }
    }

    if (params.craters) {
      stampCraters(dat, TW, TH, mulberry32(seed ^ 0x51ED2701), params.craters | 0);
    }
    tc.putImageData(img, 0, 0);

    var out = { tex: cv, aux: null, glow: null };
    if (glowDat && glowCtx && glowCv) {
      glowCtx.putImageData(glowImg, 0, 0);
      out.glow = glowCv;
      out.aux = glowCv;
    } else if (params.clouds) {
      out.aux = buildCloudTex(params, q);
    }
    return out;
  }

  /* Cloud deck: its own translucent strip, scrolled at a different rate. */
  function buildCloudTex(params, q) {
    var TW = Math.round(texW(q) * 0.6), TH = Math.round(texH(q) * 0.6);
    var cv = makeCanvas(TW, TH);
    var tc = ctx2d(cv);
    if (!cv || !tc || !tc.createImageData || !tc.putImageData) return null;
    var img = tc.createImageData(TW, TH);
    var dat = img.data;
    var seed = ((params.seed | 0) ^ 0x2C1B3C6D) || 7;
    var per = 7;
    var F_C = field(TW, TH, 2, per, per * 0.42, per, seed, 3, 0.55, false);
    var F_D = field(TW, TH, 2, per * 3, per * 1.3, per * 3, seed + 5, 2, 0.5, false);
    var i = 0, x, y;
    for (y = 0; y < TH; y++) {
      var sinLat = 1 - 2 * (y + 0.5) / TH;
      /* clouds band along latitude the way trade winds do */
      var latBias = 0.06 * Math.sin(sinLat * Math.PI * 3.2);
      var polarFade = 0.86 - 0.30 * Math.abs(sinLat * sinLat * sinLat);
      for (x = 0; x < TW; x++) {
        var u = (x + 0.5) / TW;
        var c = smp(F_C, u, y);
        var d = smp(F_D, u, y);
        var v = c * 0.72 + d * 0.28 + latBias;
        var a = smooth((v - 0.48) / 0.16) * polarFade;
        dat[i] = 250; dat[i + 1] = 252; dat[i + 2] = 255;
        dat[i + 3] = a * 235;
        i += 4;
      }
    }
    tc.putImageData(img, 0, 0);
    return cv;
  }

  function planetTexKey(p, q) {
    return 'P|' + p.type + '|' + (p.seed | 0) + '|' + (p.eyeball ? 1 : 0) +
           '|' + (p.tint ? (p.tint[0] + '_' + p.tint[2]) : 'n') + '|' + (q ? 1 : 0);
  }

  /* ---- rings ---- */
  /* Real Saturn proportions in planet radii: C 1.24-1.53, B 1.53-1.95,
     Cassini division 1.95-2.03, A 2.03-2.27. */
  var RING_BANDS = [
    [1.24, 1.53, 0.20], [1.53, 1.72, 0.62], [1.72, 1.86, 0.72],
    [1.86, 1.95, 0.55], [1.95, 2.03, 0.07], [2.03, 2.18, 0.48],
    [2.18, 2.27, 0.30]
  ];

  function ringAlphaAt(f) {
    for (var i = 0; i < RING_BANDS.length; i++) {
      if (f >= RING_BANDS[i][0] && f < RING_BANDS[i][1]) return RING_BANDS[i][2];
    }
    return 0;
  }

  function drawRingHalf(ctx, cx, cy, r, rings, tint, half, q) {
    var inner = num(rings.inner, 1.24), outer = num(rings.outer, 2.27);
    var tilt = clamp(num(rings.tilt, 0.4665), 0.02, Math.PI / 2 - 0.02);
    if (!(outer > inner) || !fin(r) || r <= 0) return;
    var squash = Math.max(0.03, Math.sin(tilt));
    var R = r * outer;
    ctx.save();
    /* half = -1 draws the far side (behind the planet), +1 the near side */
    ctx.beginPath();
    if (half < 0) ctx.rect(cx - R * 1.2, cy - R * 1.2, R * 2.4, R * 1.2);
    else ctx.rect(cx - R * 1.2, cy, R * 2.4, R * 1.2);
    ctx.clip();
    ctx.translate(cx, cy);
    ctx.scale(1, squash);
    var steps = q ? 34 : 14;
    for (var i = 0; i < steps; i++) {
      var f0 = inner + (outer - inner) * (i / steps);
      var f1 = inner + (outer - inner) * ((i + 1) / steps);
      var a = ringAlphaAt((f0 + f1) * 0.5);
      if (a <= 0.001) continue;
      var rr = r * (f0 + f1) * 0.5;
      var lw = r * (f1 - f0) + 0.4;
      /* fine structure without any per-frame randomness */
      var jitter = 0.86 + 0.28 * unit2((i * 2654435761) | 0, 4242);
      ctx.strokeStyle = rgba(tint, clamp(a * jitter, 0, 1));
      ctx.lineWidth = lw;
      if (circle(ctx, 0, 0, rr)) ctx.stroke();
    }
    ctx.restore();
    ctx.lineWidth = 1;
  }

  /* The ring tint: the planet's own base color pushed toward ice white. Pass
     opts.tint to override it, or opts.palette to derive it from another
     world; with neither, Saturn's own palette is the default. */
  function ringTintOf(o) {
    var t = o && o.tint;
    if (t && t.length >= 3) return [t[0], t[1], t[2]];
    var pal = (o && o.palette) || SOLAR.saturn.palette;
    return mixC(pal[0] || SOLAR.saturn.palette[0], [255, 250, 236], 0.55);
  }

  /* drawRingsBack / drawRingsFront(ctx, cx, cy, rPx, rings, opts) --
     the far half (behind the planet) and the near half (over it). `rings` is
     {inner, outer, tilt} in planet radii; opts is
     { quality, alpha, tint, palette }. A renderer that draws the globe some
     other way sandwiches its disc between these two calls, which is exactly
     what drawPlanet does below. */
  function ringsEntry(ctx, cx, cy, rPx, rings, opts, half) {
    if (!ctx || !ctx.beginPath) return;
    if (!rings || typeof rings !== 'object') return;
    var o = opts || {};
    var prevAlpha = clamp(num(ctx.globalAlpha, 1), 0, 1);
    var alpha = clamp(num(o.alpha, 1), 0, 1) * prevAlpha;
    var x = num(cx, NaN), y = num(cy, NaN), r = num(rPx, NaN);
    if (!fin(x) || !fin(y) || !fin(r) || r <= 0 || alpha <= 0.004) return;
    if (r > 4000) r = 4000;
    ctx.globalAlpha = alpha;
    drawRingHalf(ctx, x, y, r, rings, ringTintOf(o), half, o.quality === 0 ? 0 : 1);
    ctx.globalAlpha = prevAlpha;
  }
  function drawRingsBack(ctx, cx, cy, rPx, rings, opts) {
    ringsEntry(ctx, cx, cy, rPx, rings, opts, -1);
  }
  function drawRingsFront(ctx, cx, cy, rPx, rings, opts) {
    ringsEntry(ctx, cx, cy, rPx, rings, opts, 1);
  }

  /* A soft shadow of the ring plane across the planet, drawn inside the disc
     clip. Cheap, and it is the detail that makes Saturn read as Saturn.
     Public, because a GL-drawn globe needs the same shadow on it. */
  function drawRingShadow(ctx, cx, cy, r, rings, lightDir) {
    if (!ctx || !ctx.beginPath) return;
    if (!rings || typeof rings !== 'object') return;
    if (!fin(num(cx, NaN)) || !fin(num(cy, NaN)) || !fin(num(r, NaN)) || !(r > 0)) return;
    var tilt = clamp(num(rings.tilt, 0.4665), 0.02, Math.PI / 2 - 0.02);
    var squash = Math.max(0.03, Math.sin(tilt));
    var off = -Math.sin(num(lightDir, Math.PI)) * r * 0.22;
    if (!fin(off)) off = 0;
    ctx.save();
    ctx.translate(cx, cy + off);
    ctx.scale(1, squash);
    var inner = num(rings.inner, 1.24), outer = num(rings.outer, 2.27);
    var steps = 12;
    for (var i = 0; i < steps; i++) {
      var f0 = inner + (outer - inner) * (i / steps);
      var f1 = inner + (outer - inner) * ((i + 1) / steps);
      var a = ringAlphaAt((f0 + f1) * 0.5);
      if (a <= 0.001) continue;
      ctx.strokeStyle = 'rgba(20,16,12,' + clamp(a * 0.55, 0, 1) + ')';
      ctx.lineWidth = r * (f1 - f0) + 0.4;
      if (circle(ctx, 0, 0, r * (f0 + f1) * 0.5)) ctx.stroke();
    }
    ctx.restore();
    ctx.lineWidth = 1;
  }

  /* ---- drawPlanet(ctx, cx, cy, rPx, params, t, opts) ----
     params comes from planetParams() or exoParams(). opts:
       quality:    1 (default) or 0 (card preview)
       lightDir:   screen angle in radians pointing TOWARD the light, so
                   Math.PI (the default) lights the world from the left.
                   For a solar planet this is atan2(sunScreenY - planetY,
                   sunScreenX - planetX); for an exoplanet, the direction of
                   its host on screen.
       phase:      illuminated fraction, 0 (new) to 1 (full). Default 0.92,
                   which keeps a sliver of terminator so the disc reads as a
                   sphere. The shading gradient is exact along the light
                   axis, so 0.5 really does put the terminator on the disc
                   center.
       phaseAngle: optional explicit rotation of the surface in radians. Left
                   out, unlocked worlds turn once per 30 s and tidally locked
                   ones keep their day side toward the light.
       alpha:      0..1 overall fade (default 1). */
  function drawPlanet(ctx, cx, cy, rPx, params, t, opts) {
    if (!ctx || !ctx.beginPath) return;
    if (!params || typeof params !== 'object') return;
    var o = opts || {};
    var q = o.quality === 0 ? 0 : 1;
    var prevAlpha = clamp(num(ctx.globalAlpha, 1), 0, 1);
    var alpha = clamp(num(o.alpha, 1), 0, 1) * prevAlpha;
    var x = num(cx, NaN), y = num(cy, NaN), r = num(rPx, NaN);
    if (!fin(x) || !fin(y) || !fin(r) || r <= 0 || alpha <= 0.004) return;
    if (r > 4000) r = 4000;
    var tt = num(t, 0);
    var L = num(o.lightDir, Math.PI);
    var look = planetLook(params);
    var type = look.type;
    var pal = look.palette;
    var atmos = look.atmos;

    /* rotation: locked worlds keep one face to their star */
    var spin;
    if (fin(o.phaseAngle)) spin = o.phaseAngle;
    else if (look.locked) {
      var kk = clamp(num(o.phase, 0.92), 0, 1);
      var sinA0 = Math.sqrt(Math.max(0, 1 - (2 * kk - 1) * (2 * kk - 1)));
      spin = Math.PI - Math.asin(clamp(sinA0 * Math.cos(L), -1, 1));
    } else {
      spin = tt * TWO_PI / 30;
    }
    if (!fin(spin)) spin = 0;

    var entry = texGet(planetTexKey(params, q), function () { return buildPlanetTex(params, q); });
    var prevOp = ctx.globalCompositeOperation;
    ctx.globalAlpha = alpha;

    /* rings, far half first so the planet occludes it */
    var rings = look.rings;
    if (rings) {
      drawRingHalf(ctx, x, y, r, rings, look.ringTint, -1, q);
    }

    /* flat base under the texture: a missing strip still reads as a world */
    ctx.fillStyle = rgba(pal[0], 1);
    if (circle(ctx, x, y, r)) ctx.fill();

    ctx.save();
    if (circle(ctx, x, y, r)) {
      ctx.clip();
      if (entry && entry.tex) drawSphere(ctx, x, y, r, entry.tex, spin, slabCount(q));
      /* cloud deck, scrolled a little faster than the ground */
      if (look.clouds && entry && entry.aux && entry.aux !== entry.glow) {
        drawSphere(ctx, x, y, r * 1.004, entry.aux,
                   look.locked ? spin : spin * 1.18 + 0.7, slabCount(q));
      }
      if (rings && q) drawRingShadow(ctx, x, y, r, rings, L);
      /* day / night */
      shadeSphere(ctx, x, y, r, L, num(o.phase, 0.92), look.limbExp, look.night);
      /* lava and hot Jupiters glow through their own night side */
      if (look.emissive && entry && entry.glow) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = alpha * 0.85;
        drawSphere(ctx, x, y, r, entry.glow, spin, slabCount(q));
        ctx.globalAlpha = alpha;
        ctx.globalCompositeOperation = prevOp;
      }
    }
    ctx.restore();
    ctx.globalAlpha = alpha;

    /* atmosphere: a rim ring plus a brighter crescent on the lit limb */
    if (atmos) {
      var atmC = look.atmC;
      ctx.globalCompositeOperation = 'lighter';
      var ag = rgrad(ctx, x, y, r * 0.90, x, y, r * 1.12);
      if (ag) {
        stop(ag, 0, rgba(atmC, 0));
        stop(ag, 0.55, rgba(atmC, 0.18));
        stop(ag, 1, rgba(atmC, 0));
        ctx.fillStyle = ag;
        if (circle(ctx, x, y, r * 1.12)) ctx.fill();
      }
      var a0 = L - 1.25, a1 = L + 1.25;
      if (fin(a0) && fin(a1)) {
        ctx.strokeStyle = rgba(atmC, 0.30);
        ctx.lineWidth = Math.max(0.7, r * 0.035);
        ctx.beginPath();
        ctx.arc(x, y, r * 0.985, a0, a1);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      ctx.globalCompositeOperation = prevOp;
    }

    /* emissive worlds keep a warm halo even on the night side */
    if (look.emissive) {
      ctx.globalCompositeOperation = 'lighter';
      var eg = rgrad(ctx, x, y, r * 0.85, x, y, r * 1.7);
      if (eg) {
        var ec = look.emisC;
        stop(eg, 0, rgba(ec, 0.22));
        stop(eg, 1, rgba(ec, 0));
        ctx.fillStyle = eg;
        if (circle(ctx, x, y, r * 1.7)) ctx.fill();
      }
      ctx.globalCompositeOperation = prevOp;
    }

    /* rings, near half over the planet */
    if (rings) {
      drawRingHalf(ctx, x, y, r, rings, look.ringTint, 1, q);
    }

    ctx.globalCompositeOperation = prevOp;
    ctx.globalAlpha = prevAlpha;
  }

  /* ==========================================================================
     demo hook (console eyeballing; never used by the page)
     ========================================================================== */

  var DEMO = ['sun', 'mdwarf', 'bluegiant', 'unknown', 'wd', 'ns', 'earth',
              'mars', 'jupiter', 'saturn', 'neptune', 'lava', 'eyeball',
              'hotjup', 'ice'];

  function demoBody(which) {
    switch (which) {
      case 'sun': return { star: starParams({ name: 'Sol', sp: 'G2V', ci: 0.65, absmag: 4.83 }) };
      case 'mdwarf': return { star: starParams({ name: 'Proxima Centauri', sp: 'M5', ci: 1.9, absmag: 15.5 }) };
      case 'bluegiant': return { star: starParams({ name: 'Rigel', sp: 'B8', ci: -0.03, absmag: -7 }) };
      case 'unknown': return { star: starParams({ name: 'Unknown star' }) };
      case 'wd': return { star: starParams({ name: 'Sirius B', sp: 'DA2', ci: -0.03, absmag: 11.2 }) };
      case 'ns': return { star: starParams({ name: 'PSR B1257+12' }) };
      case 'lava': return { planet: exoParams({ rade: 1.2, eqt: 2000, a: 0.02, hostTeff: 5500 }) };
      case 'eyeball': return { planet: exoParams({ rade: 0.92, eqt: 250, a: 0.029, hostTeff: 2566, inHz: true }) };
      case 'hotjup': return { planet: exoParams({ rade: 13, eqt: 1400, a: 0.05, hostTeff: 6000 }) };
      case 'ice': return { planet: exoParams({ rade: 1.1, eqt: 90, a: 5, hostTeff: 5000 }) };
      default: return { planet: planetParams(which) };
    }
  }

  function __demo(canvas, which) {
    var ctx = ctx2d(canvas);
    if (!ctx) return function () {};
    var idx = 0;
    var stopped = false;
    var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    var list = which ? [which] : DEMO;
    function frame() {
      if (stopped) return;
      var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      var t = (now - t0) / 1000;
      if (!which) idx = Math.floor(t / 4) % list.length;
      var W = canvas.width, H = canvas.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#0a0c10';
      ctx.fillRect(0, 0, W, H);
      var body = demoBody(list[idx]);
      var r = Math.min(W, H) * 0.30;
      if (body.star) drawStar(ctx, W / 2, H / 2, r, body.star, t, { quality: 1 });
      else if (body.planet) drawPlanet(ctx, W / 2, H / 2, r, body.planet, t, { quality: 1, lightDir: Math.PI * 0.85 });
      ctx.fillStyle = '#d6d6d6';
      ctx.font = '14px "Source Sans 3", system-ui, sans-serif';
      ctx.fillText(list[idx], 12, 22);
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(frame);
    }
    frame();
    return function () { stopped = true; };
  }

  /* ---------------- export ---------------- */

  var VoyageArt = {
    starParams: starParams,
    drawStar: drawStar,
    planetParams: planetParams,
    exoParams: exoParams,
    drawPlanet: drawPlanet,
    texCacheSize: texCacheSize,
    clearTexCache: clearTexCache,
    flareState: flareState,
    flareAmp: flareAmp,
    flareGlow: flareGlow,
    classFromTeff: classFromTeff,
    hashStr: hashStr,
    mulberry32: mulberry32,
    FLARE_SLOTS: FLARE_SLOTS,
    TEX_MAX: TEX_MAX,
    SOLAR_KEYS: ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'],
    /* the look / pass API a second renderer draws from */
    starLook: starLook,
    flareUniforms: flareUniforms,
    drawStarBack: drawStarBack,
    drawStarMid: drawStarMid,
    drawStarFront: drawStarFront,
    planetLook: planetLook,
    drawRingsBack: drawRingsBack,
    drawRingsFront: drawRingsFront,
    drawRingShadow: drawRingShadow,
    SOL_PARAMS: SOL_PARAMS,
    SPOT_MAX: SPOT_MAX,
    __demo: __demo
  };

  global.VoyageArt = VoyageArt;
  if (typeof module !== 'undefined' && module.exports) module.exports = VoyageArt;
})(typeof self !== 'undefined' ? self : globalThis);
