/* ==========================================================================
   voyage-galaxy.js -- the painted Milky Way for Mission to Anywhere
   (/voyage/). Global: VoyageGalaxy.
   --------------------------------------------------------------------------
   Three offscreen layers are BAKED once (seeded, chunked, theme-keyed) and
   then projected every frame through the page's own projector, so the
   painting is a world-anchored object in the galactic plane and not a
   billboard: drag the camera and the arms swing with the star field because
   they are literally at the same world coordinates.

     core   warm bulge + boxy bar + nucleus + the bar's leading dust lanes
     arms   exponential disc, four log-spiral arms, dust lanes carved along
            their inner edges, blue-white OB clumps, pink HII flecks
     halo   a very faint extended envelope, smooth on purpose

   The spiral model is the SAME model the 22.6k-point cloud in voyage.js
   uses (four arms, pitch 4.3 per decade of radius, bar at 0.44 rad, arms
   from 3200 ly out, Sun 26,000 ly from the centre). That is deliberate: the
   cloud is drawn on top of the painting, and if the two disagreed about
   where an arm is the composite would read as a double exposure.

   Ownership boundaries this file obeys:
     - the projector is PASSED IN (project(x, y, z, out) -> bool) and the
       camera basis is PASSED IN (camState). Neither is ever re-derived.
     - the galactic basis is PASSED IN (opts.basis = PURE.galBasis()).
     - nothing here reads window.__voy, window.VoyageAstro or the DOM beyond
       the offscreen canvases it allocates itself.
     - no Math.random, no Date.now, no new Date: every random number comes
       from mulberry32 or an integer hash seeded by the caller's seed.
     - no shadowBlur anywhere; no per-frame allocation in draw().
     - every gradient / transform / drawImage argument is isFinite-guarded
       before it is used (one NaN into a canvas call kills the page's rAF
       loop for good).

   How voyage.js drives it:

     GAL().bake(seed, { theme: effectiveTheme() }, onDone)   once, and again
                                                            after a theme flip
     GAL().bakeStep()            only if you want to pump it yourself
     GAL().invalidateTheme(t)    from onThemeChange; without the argument the
                                 next draw() supplies the theme and starts it
     GAL().draw(ctx, projectPt, camSnapshotForGalaxy, ga, {
       theme: effectiveTheme(), basis: PURE.galBasis(), mesh: MESH_N,
       layers: { core: true, arms: true, halo: galLod >= 2 },
       W: W, H: H                       // optional; CSS-pixel viewport
     })                          -> true if it painted, false if the point
                                    cloud has to carry the frame alone

   `camState` needs `.D` (the camera distance in AU) because the painted
   layers' own fade-in, gp = ramp(D, 8e8, 3e9), is applied here on top of
   the `ga` the caller passes as `alpha`. The rest of camState is accepted
   and reserved; the projection itself goes entirely through `project`.

   `opts.basis` is the EQUATORIAL galactic basis PURE.galBasis() returns, and
   the world frame the projector works in is ecliptic, so the pinned J2000
   obliquity (identical to VoyageAstro.equToEcl, which this file may not
   reach into) is applied here. Pass `frame: 'ecl'` if you ever hand over an
   already-ecliptic basis. A node test pins the result against
   VoyageAstro.equToEcl(PURE.galToEqu(...)) so the two can never drift.
   ========================================================================== */
(function (global) {
  'use strict';

  var PI = Math.PI, TWO_PI = PI * 2, LN10 = Math.LN10, DEG = PI / 180;

  /* ---------------- guards + tiny numerics ---------------- */

  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function fin(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function ramp(v, lo, hi) { return v <= lo ? 0 : (v >= hi ? 1 : (v - lo) / (hi - lo)); }
  function smooth(x) {
    if (!(x > 0)) return 0;
    if (x >= 1) return 1;
    return x * x * (3 - 2 * x);
  }
  function lerp(a, b, f) { return a + (b - a) * f; }
  function asinh(x) { return Math.log(x + Math.sqrt(x * x + 1)); }

  /* mulberry32 -- the site's standard seeded generator. Bake time only. */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* integer lattice hash -> [0,1). Stable across machines. */
  function ihash(x, y, s) {
    var n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^
            Math.imul(s | 0, 2246822519);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  }
  function vnoise(x, y, s) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    var a = ihash(xi, yi, s), b = ihash(xi + 1, yi, s);
    var c = ihash(xi, yi + 1, s), d = ihash(xi + 1, yi + 1, s);
    var t = a + (b - a) * u;
    return t + ((c + (d - c) * u) - t) * v;
  }
  /* Each octave is rotated by a fixed angle. Value noise creases along its
     own axis-aligned lattice, and the ridged variant turns that into a
     visible rectangular crackle across the whole layer; rotating the
     octaves scatters the lattices and the crackle disappears. */
  var ROT_C = [1, 0.6967, -0.0292, -0.7361, -0.9991, -0.6558, 0.0875, 0.7739];
  var ROT_S = [0, 0.7174, 0.9996, 0.6769, 0.0416, -0.7550, 0.9962, 0.6333];
  function fbm(x, y, s, oct) {
    var t = 0, amp = 0.5, f = 1, nrm = 0, i, c, sn, rx, ry;
    for (i = 0; i < oct; i++) {
      c = ROT_C[i & 7]; sn = ROT_S[i & 7];
      rx = x * c - y * sn; ry = x * sn + y * c;
      t += amp * vnoise(rx * f, ry * f, s + i * 101);
      nrm += amp; amp *= 0.5; f *= 2.03;
    }
    return nrm > 0 ? t / nrm : 0.5;
  }
  /* ridged fBm -- filaments, which is what dust looks like */
  function rfbm(x, y, s, oct) {
    var t = 0, amp = 0.5, f = 1, nrm = 0, i, v, c, sn, rx, ry;
    for (i = 0; i < oct; i++) {
      c = ROT_C[i & 7]; sn = ROT_S[i & 7];
      rx = x * c - y * sn; ry = x * sn + y * c;
      v = vnoise(rx * f, ry * f, s + i * 131);
      v = 1 - Math.abs(v * 2 - 1);
      t += amp * v * v;
      nrm += amp; amp *= 0.52; f *= 2.11;
    }
    return nrm > 0 ? t / nrm : 0.5;
  }

  /* ---------------- pinned physical / model constants ----------------
     The unit constant is rebuilt from the same exact constituents
     voyage-astro.js uses so the two agree bit for bit; opts.lyAu overrides
     it if the caller would rather hand it over. */
  var AU_KM = 149597870.7;
  var LY_M = 9460730472580800;
  var LY_AU_DEF = LY_M / (AU_KM * 1000);      /* 63241.077... AU per ly */
  var OBLIQUITY = 23.43928 * DEG;             /* J2000, matches voyage-astro */

  /* Structure, matched to the point cloud in voyage.js. */
  var GAL_R0_LY = 26000;      /* Sun -> galactic centre */
  var ARM_N = 4;              /* four arms */
  var ARM_R_IN = 3200;        /* arms start here */
  var ARM_PITCH = 4.3;        /* radians per DECADE of radius */
  var BAR_ANG = 0.44;         /* the bar leads the Sun-centre line */

  /* Layer half-extents, ly. Each layer is a square of the galactic plane
     centred on the galactic centre. */
  var EXT = { core: 13000, arms: 54000, halo: 60000 };

  /* Backing-store sides, pinned by the spec. */
  var SIDE_DESK = { core: 1024, arms: 2048, halo: 1024 };   /* 24 MB */
  var SIDE_MOB = { core: 512, arms: 1024, halo: 512 };      /*  6 MB */
  /* The smooth field is synthesised at a lower resolution and upscaled: the
     diffuse light of a galaxy genuinely is smooth, and the crisp structure
     comes from the full-resolution stamp passes on top. */
  var FIELD_DESK = { core: 336, arms: 424, halo: 208 };
  var FIELD_MOB = { core: 208, arms: 288, halo: 144 };

  /* Alpha schedule. The painting only reaches full strength once the camera
     has left the disc; inside that the point cloud carries the detail. */
  var GP_LO = 8e8, GP_HI = 3e9;
  /* Per-layer composite alpha. Light theme is source-over ink and is capped
     at 0.5 per layer by the spec. */
  var LAY_A_D = { core: 0.94, arms: 0.98, halo: 0.52 };
  var LAY_A_L = { core: 0.42, arms: 0.50, halo: 0.26 };

  var MESH_MIN = 2, MESH_MAX = 24;
  var SEAM_PX = 3;      /* source-rect margin, screen px (see 'seams' below) */
  var SLICE_MS = 12;
  var JOB_MS0 = 3;      /* starting reserve for the slice budget, ms */

  /* ---------------- palettes ----------------
     Dark: emissive colour, composited 'lighter'.
     Light: dark ink in the GAL_TINT_L family, composited 'source-over'. */
  var PAL_D = {
    nucleus: [255, 247, 226],
    warmIn: [255, 222, 158],
    warmOut: [248, 214, 162],
    neutral: [226, 226, 220],
    armBlue: [150, 188, 255],
    armHot: [206, 230, 255],
    hii: [255, 136, 168],
    halo: [150, 166, 198],
    dustGlow: [198, 136, 100]
  };
  var PAL_L = {
    nucleus: [92, 78, 52],
    warmIn: [150, 116, 44],
    warmOut: [140, 112, 58],
    neutral: [112, 110, 112],
    armBlue: [60, 84, 128],
    armHot: [44, 64, 104],
    hii: [138, 62, 88],
    halo: [96, 112, 140],
    dustGlow: [126, 100, 74]
  };

  /* ---------------- module state ---------------- */
  var st = {
    ready: false,
    key: '',
    seed: 0,
    theme: 'dark',
    sizeClass: 'desktop',
    layers: null,          /* { core:{canvas, side, half}, arms:.., halo:.. } */
    order: ['halo', 'arms', 'core'],
    jobs: null,
    ji: 0,
    baking: false,
    pending: null,         /* scheduler handle kind */
    onDone: null,
    bakeMs: 0,
    digest: 2166136261,
    reason: '',
    lastOpts: null,
    px: 0,
    bytes: 0,
    nLayers: 0,
    themeStale: false,
    sprites: null,
    jobMax: 3
  };

  /* per-frame scratch, allocated once */
  var MAXC = (MESH_MAX + 1) * (MESH_MAX + 1);
  var cxA = new Float64Array(MAXC), cyA = new Float64Array(MAXC),
      czA = new Float64Array(MAXC);
  var cOk = new Uint8Array(MAXC);
  var cellIdx = new Int32Array(MESH_MAX * MESH_MAX);
  var cellZ = new Float64Array(MESH_MAX * MESH_MAX);
  var PRJ = { x: 0, y: 0, z: 0 };
  var W3 = [0, 0, 0];
  var lastDraw = { cells: 0, tris: 0, layers: 0, gp: 0, alpha: 0, reason: '' };

  /* world frame cache: rebuilt only when the passed-in basis changes */
  var frame = {
    sig: '',
    ux: 0, uy: 0, uz: 0,     /* galactic +x (toward the centre), ecliptic unit */
    vx: 0, vy: 0, vz: 0,     /* galactic +y */
    nx: 0, ny: 0, nz: 0,     /* galactic +z (plane normal) */
    lyAu: LY_AU_DEF
  };

  /* ---------------- canvases ---------------- */
  function mkCanvas(w, h) {
    var d = (typeof document !== 'undefined' && document) ? document : null;
    if (!d || typeof d.createElement !== 'function') return null;
    var c = d.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  function freeCanvas(c) {
    if (!c) return;
    try { c.width = 0; c.height = 0; } catch (e) { /* detached */ }
  }

  /* ==================================================================
     The galaxy model. Everything below is a pure function of (X, Y) in
     galactocentric light-years plus the seeded noise grids.
     ================================================================== */

  /* A coarse noise grid, sampled bilinearly. Low-frequency terms cost
     almost nothing this way; only the dust turbulence needs full field
     resolution. */
  /* (a0 + a1*A) * (b0 + b1*B), precomputed so the field loop needs one
     lookup instead of two */
  function mixGrid(A, B, a0, a1, b0, b1) {
    var i, n = A.length;
    for (i = 0; i < n; i++) A[i] = (a0 + a1 * A[i]) * (b0 + b1 * B[i]);
    return A;
  }
  function noiseRows(g, n, freq, seed, oct, ridged, j0, j1) {
    var i, j, x, y;
    for (j = j0; j < j1; j++) {
      y = (j / n) * freq;
      for (i = 0; i < n; i++) {
        x = (i / n) * freq;
        g[j * n + i] = ridged ? rfbm(x, y, seed, oct) : fbm(x, y, seed, oct);
      }
    }
    return g;
  }
  /* u, v in [0,1]. The interpolation weights are smoothstepped: plain
     bilinear on a coarse grid leaves a visible diamond quilt once it is
     magnified onto a 2048 px layer. */
  function gsamp(g, n, u, v) {
    var x = u * (n - 1), y = v * (n - 1);
    if (!(x >= 0)) x = 0; else if (x > n - 1.0001) x = n - 1.0001;
    if (!(y >= 0)) y = 0; else if (y > n - 1.0001) y = n - 1.0001;
    var xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    var o = yi * n + xi;
    var a = g[o], b = g[o + 1], c = g[o + n], d = g[o + n + 1];
    var t = a + (b - a) * fx;
    return t + ((c + (d - c) * fx) - t) * fy;
  }

  /* ---- tone curve: an asinh stretch, the same move an astrophotographer
     makes to show a disc whose centre is 300x brighter than its edge ---- */
  var STRETCH_A = 34;
  var STRETCH_N = asinh(STRETCH_A);
  /* Baked alpha. On dark this is emissive strength; on light it is INK
     COVERAGE, and ink has to be far heavier than light to read at all
     against #f3f5f8 once the per-layer 0.5 cap is applied. */
  var INK_K = 2.75;
  /* Ordered dither on the alpha byte. A smooth 1/255 ramp spread over a
     whole layer shows as concentric bands, and on the near-white light
     background they are obvious; a deterministic 4x4 dither removes them
     and costs one table lookup. */
  var BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  function alphaByte(va, i, j) {
    var v = bakeAlpha(va) * 255 + BAYER[((j & 3) << 2) | (i & 3)] * 0.0625 - 0.46875;
    if (!(v > 0)) return 0;
    return v > 255 ? 255 : (v + 0.5) | 0;
  }
  function bakeAlpha(va) {
    if (st.theme === 'light') {
      var v = va * INK_K;
      return v > 0.95 ? 0.95 : (v > 0 ? v : 0);
    }
    return va > 1 ? 1 : (va > 0 ? va : 0);
  }
  function stretch(L) {
    if (!(L > 0)) return 0;
    var v = asinh(L * STRETCH_A) / STRETCH_N;
    return v > 1 ? 1 : v;
  }

  /* ==================================================================
     Bake
     ================================================================== */

  function digestNum(v) {
    /* FNV-1a over a quantised number, so a bake has a stable fingerprint */
    var q = Math.round((fin(v) ? v : 0) * 4096) | 0;
    var h = st.digest;
    h ^= q & 255; h = Math.imul(h, 16777619);
    h ^= (q >>> 8) & 255; h = Math.imul(h, 16777619);
    h ^= (q >>> 16) & 255; h = Math.imul(h, 16777619);
    h ^= (q >>> 24) & 255; h = Math.imul(h, 16777619);
    st.digest = h >>> 0;
  }

  function isMobile(o) {
    if (o && typeof o.mobile === 'boolean') return o.mobile;
    var iw = (global && fin(global.innerWidth)) ? global.innerWidth : 0;
    var dp = (global && fin(global.devicePixelRatio)) ? global.devicePixelRatio : 2;
    if (iw && iw <= 768) return true;
    if (iw && dp < 2 && iw <= 900) return true;
    return false;
  }

  function pal() { return st.theme === 'light' ? PAL_L : PAL_D; }
  function stampOp() { return st.theme === 'light' ? 'source-over' : 'lighter'; }

  /* soft radial sprites, one per palette colour, rebuilt per theme */
  function buildSprites() {
    var P = pal();
    var names = ['nucleus', 'warmIn', 'warmOut', 'neutral', 'armBlue',
                 'armHot', 'hii', 'halo', 'dustGlow'];
    var out = {}, i, k, c, g, cc;
    for (i = 0; i < names.length; i++) {
      k = names[i];
      c = mkCanvas(32, 32);
      if (!c) return null;
      cc = c.getContext('2d');
      if (!cc) return null;
      g = cc.createRadialGradient(16, 16, 0, 16, 16, 16);
      var rgb = P[k];
      g.addColorStop(0, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',1)');
      g.addColorStop(0.34, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0.52)');
      g.addColorStop(0.72, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0.12)');
      g.addColorStop(1, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0)');
      cc.fillStyle = g;
      cc.fillRect(0, 0, 32, 32);
      out[k] = c;
    }
    return out;
  }

  /* ---- ARMS ---- */

  /* A noise grid, built in row slices so no single bake job can blow past
     the 12 ms slice ceiling (one 320^2 four-octave ridged grid is about
     40 ms in one go). `done` receives the finished array. */
  function gridJobs(jobs, tag, n, freq, seed, oct, ridged, done) {
    var g = new Float32Array(n * n);
    var rows = Math.max(2, Math.floor(2600 / n));
    var j;
    for (j = 0; j < n; j += rows) {
      (function (a, b) {
        jobs.push(named(tag, function () {
          noiseRows(g, n, freq, seed, oct, ridged, a, Math.min(b, n));
        }));
      })(j, j + rows);
    }
    jobs.push(named(tag, function () { done(g); }));
  }

  function armsNoiseJobs(jobs, L) {
    var s = L.seed, n = L.field, tag = 'arms:noise';
    var tmp = {};
    jobs.push(named(tag, function () { L.g = {}; L.gn = {}; }));
    gridJobs(jobs, tag, 160, 3.1, s + 11, 3, false, function (g) { L.g.w1 = g; L.gn.w1 = 160; });
    gridJobs(jobs, tag, 160, 3.1, s + 29, 3, false, function (g) { L.g.w2 = g; L.gn.w2 = 160; });
    /* one lookup carries both the patchiness and the along-arm breakup */
    gridJobs(jobs, tag, 288, 13.0, s + 47, 4, false, function (g) { tmp.a = g; });
    gridJobs(jobs, tag, 288, 6.4, s + 71, 3, false, function (g) { tmp.b = g; });
    jobs.push(named(tag, function () {
      L.g.str = mixGrid(tmp.a, tmp.b, 0.16, 1.34, 0.42, 0.92);
      L.gn.str = 288; tmp.a = null; tmp.b = null;
    }));
    /* spurs: the short feathers that branch off the inside of a real arm */
    gridJobs(jobs, tag, 256, 26.0, s + 113, 3, false, function (g) { L.g.spur = g; L.gn.spur = 256; });
    /* the dust turbulence is the one term that has to be sharp */
    var dn1 = Math.min(n, 320), dn2 = Math.max(64, (n >> 2) * 3 >> 1);
    gridJobs(jobs, tag, dn1, 34.0, s + 151, 4, true, function (g) { L.dust = g; L.dn1 = dn1; });
    gridJobs(jobs, tag, dn2, 11.0, s + 173, 3, true, function (g) { L.dust2 = g; L.dn2 = dn2; });
    jobs.push(named(tag, function () {
      L.img = L.fctx.createImageData(n, n);
      L.lum = new Float32Array(n * n);
      L.amp = new Float32Array(n * n);
      L.trn = new Float32Array(n * n);
    }));
  }

  /* pinned arm geometry */
  function armOffset(R, phi) {
    /* signed angular distance to the nearest of ARM_N log-spiral ridges */
    var base = BAR_ANG + ARM_PITCH * Math.log(R / ARM_R_IN) / LN10;
    var sp = TWO_PI / ARM_N;
    var d = phi - base;
    d = d - Math.round(d / sp) * sp;
    return d;
  }
  function armWidth(R) { return 1050 + 0.072 * R; }

  var DISC_SCALE = 11000;
  var ARM_K = 1.30, DISC_K = 0.26;
  var WARP_BASE = 900, WARP_K = 0.085;
  var DUST_ARM = 3.5, DUST_OFF = 0.62, DUST_WK = 0.40;
  var DUST_SCALE = 17000, DUST_GEN = 1.55;

  function armsFieldRows(L, j0, j1) {
    var n = L.field, half = L.half, d = L.img.data, P = pal();
    var g = L.g, gn = L.gn;
    var j, i, u, v, X, Y, R0, wamp, wx, wy, R, phi, dd, sly, w, A, spr;
    var innerFade, disc, Lv, warm, armFrac, dl, dw, Ad, turb, tau, T, ext;
    var r, gg, b, o, va, c0, c1, mix, outer, As, dg;
    for (j = j0; j < j1; j++) {
      v = (j + 0.5) / n;
      Y = (1 - 2 * v) * half;
      for (i = 0; i < n; i++) {
        u = (i + 0.5) / n;
        X = (2 * u - 1) * half;
        R0 = Math.sqrt(X * X + Y * Y);
        o = (j * n + i) * 4;
        if (R0 > 58000) {                    /* outside the painted disc */
          d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; d[o + 3] = 0;
          L.lum[j * n + i] = 0; L.amp[j * n + i] = 0; L.trn[j * n + i] = 1;
          continue;
        }
        wamp = WARP_BASE + WARP_K * R0;
        wx = X + (gsamp(g.w1, gn.w1, u, v) - 0.5) * wamp * 2;
        wy = Y + (gsamp(g.w2, gn.w2, u, v) - 0.5) * wamp * 2;
        R = Math.sqrt(wx * wx + wy * wy);
        if (R < 1) R = 1;
        phi = Math.atan2(wy, wx);
        dd = armOffset(R, phi);
        sly = dd * R;
        w = armWidth(R);
        A = Math.exp(-0.5 * (sly / w) * (sly / w));
        /* a narrow bright ridge riding inside the broad arm */
        A = 0.68 * A + 0.62 * Math.exp(-0.5 * (sly / (0.36 * w)) * (sly / (0.36 * w)));
        A *= gsamp(g.str, gn.str, u, v);
        /* spurs: high-frequency feathers, only near an arm and only outside
           the inner disc, which is what gives a real arm its ragged edge */
        spr = gsamp(g.spur, gn.spur, u, v);
        As = Math.exp(-0.5 * (sly / (2.1 * w)) * (sly / (2.1 * w)));
        A += 0.55 * As * spr * spr * spr * smooth((R - 6000) / 6000);
        innerFade = smooth((R - 2400) / 2400);
        /* the disc must reach zero BEFORE the layer's square edge, or the
           edge itself shows as a faint rectangle around the galaxy */
        outer = 1 - smooth((R - 39000) / 13000);
        disc = Math.exp(-R / DISC_SCALE);
        Lv = (ARM_K * A * innerFade + DISC_K) * disc * outer;

        /* dust: a lane hugging the inner edge of each arm, broken up by
           ridged turbulence, plus a filamentary haze over the whole disc */
        dl = sly + DUST_OFF * w;
        dw = DUST_WK * w;
        Ad = Math.exp(-0.5 * (dl / dw) * (dl / dw));
        turb = gsamp(L.dust, L.dn1, u, v);
        tau = DUST_ARM * Ad * (0.10 + 1.25 * turb) * Math.exp(-R / DUST_SCALE) *
              innerFade * outer;
        dg = gsamp(L.dust2, L.dn2, u, v);
        tau += DUST_GEN * dg * dg * Math.sqrt(dg) *
               Math.exp(-R / 13000) * innerFade * outer;
        tau += 0.55 * turb * turb * Math.exp(-R / 9000) * innerFade;
        T = Math.exp(-tau);
        ext = 1 - T;

        va = stretch(Lv * T);

        /* colour: warm inside and between the arms, blue on the ridges */
        armFrac = A / (A + 0.30);
        warm = clamp(0.98 * Math.exp(-R / 14000) + 0.06, 0, 1) * (1 - 0.88 * armFrac);
        c0 = R < 12000 ? P.warmIn : P.warmOut;
        c1 = P.armBlue;
        mix = clamp(warm, 0, 1);
        r = lerp(c1[0], c0[0], mix);
        gg = lerp(c1[1], c0[1], mix);
        b = lerp(c1[2], c0[2], mix);
        /* reddening through the dust */
        gg *= (1 - 0.30 * ext);
        b *= (1 - 0.60 * ext);

        d[o] = r | 0; d[o + 1] = gg | 0; d[o + 2] = b | 0;
        d[o + 3] = alphaByte(va, i, j);
        L.lum[j * n + i] = va;
        /* "amp" is how much of the DISPLAYED light here is the arm, so the
           clumps and HII knots thin out with the disc instead of trailing
           off into isolated sparkles where there is no diffuse light left */
        L.amp[j * n + i] = va * clamp(ARM_K * A / (ARM_K * A + DISC_K), 0, 1) *
                           innerFade;
        L.trn[j * n + i] = T;
      }
    }
  }

  /* ---- CORE ---- */

  var BAR_A = 5200, BAR_B = 1750;
  var SER_RE = 2050, SER_N = 2.6, SER_B = 2 * 2.6 - 1 / 3;
  var LANE_OFF = 760, LANE_W = 330, LANE_SHEAR = 0.085;

  function coreNoiseJobs(jobs, L) {
    var s = L.seed, n = L.field, tag = 'core:noise';
    jobs.push(named(tag, function () { L.g = {}; L.gn = {}; }));
    gridJobs(jobs, tag, 288, 11.0, s + 211, 4, false, function (g) { L.g.floc = g; L.gn.floc = 288; });
    gridJobs(jobs, tag, 160, 2.6, s + 233, 2, false, function (g) { L.g.w1 = g; L.gn.w1 = 160; });
    gridJobs(jobs, tag, 160, 2.6, s + 251, 2, false, function (g) { L.g.w2 = g; L.gn.w2 = 160; });
    var dn1 = Math.min(n, 288);
    gridJobs(jobs, tag, dn1, 26.0, s + 277, 4, true, function (g) { L.dust = g; L.dn1 = dn1; });
    jobs.push(named(tag, function () {
      L.img = L.fctx.createImageData(n, n);
      L.lum = new Float32Array(n * n);
      L.amp = new Float32Array(n * n);
      L.trn = new Float32Array(n * n);
    }));
  }

  function coreFieldRows(L, j0, j1) {
    var n = L.field, half = L.half, d = L.img.data, P = pal();
    var cb = Math.cos(BAR_ANG), sb = Math.sin(BAR_ANG);
    var j, i, u, v, X, Y, wx, wy, rb, bx, by, boxy, Ibar, Ibul, Inuc, Lv;
    var fl, lane, tau, T, ext, va, mix, r, gg, b, o, turb, ax, ay, bar01;
    for (j = j0; j < j1; j++) {
      v = (j + 0.5) / n;
      Y = (1 - 2 * v) * half;
      for (i = 0; i < n; i++) {
        u = (i + 0.5) / n;
        X = (2 * u - 1) * half;
        o = (j * n + i) * 4;
        if (X * X + Y * Y > 11200 * 11200) {
          d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; d[o + 3] = 0;
          L.lum[j * n + i] = 0; L.amp[j * n + i] = 0; L.trn[j * n + i] = 1;
          continue;
        }
        wx = X + (gsamp(L.g.w1, L.gn.w1, u, v) - 0.5) * 420;
        wy = Y + (gsamp(L.g.w2, L.gn.w2, u, v) - 0.5) * 420;
        rb = Math.sqrt(wx * wx + wy * wy);
        bx = wx * cb + wy * sb;
        by = -wx * sb + wy * cb;
        /* boxy (c = 2.5) bar profile, written with sqrt instead of pow:
           x^2.5 = x*x*sqrt(x) and the 1/2.5 root is one sqrt of a 1/1.25
           power, which V8 evaluates far faster than two Math.pow calls */
        ax = Math.abs(bx) / BAR_A; ay = Math.abs(by) / BAR_B;
        boxy = ax * ax * Math.sqrt(ax) + ay * ay * Math.sqrt(ay);
        boxy = Math.sqrt(Math.sqrt(boxy));         /* (ax^2.5 + ay^2.5)^0.25 */
        Ibar = Math.exp(-1.32 * boxy * boxy * boxy);
        var sr = (rb + 60) / SER_RE;
        Ibul = Math.exp(-SER_B * (Math.sqrt(Math.sqrt(sr)) * Math.pow(sr, 0.1346) - 1));
        var nq = (rb + 20) / 300;
        Inuc = 2.6 * Math.exp(-nq * Math.sqrt(Math.sqrt(Math.sqrt(nq))));
        Lv = 0.52 * Ibul + 0.44 * Ibar + Inuc;
        fl = gsamp(L.g.floc, L.gn.floc, u, v);
        Lv *= (0.74 + 0.52 * fl);
        Lv *= 1 - smooth((rb - 6600) / 3600);

        /* the bar's two leading dust lanes, plus general inner dust */
        turb = gsamp(L.dust, L.dn1, u, v);
        var bq = Math.abs(bx) / (BAR_A * 1.06);
        bar01 = Math.exp(-bq * bq * bq);
        var q1 = (Math.abs(by - LANE_SHEAR * bx) - LANE_OFF) / LANE_W;
        var q2 = (Math.abs(by + LANE_SHEAR * bx) - LANE_OFF) / LANE_W;
        lane = Math.exp(-0.5 * q1 * q1) * bar01;
        lane += Math.exp(-0.5 * q2 * q2) * bar01 * 0.7;
        tau = 2.30 * lane * (0.34 + 0.95 * turb);
        tau += 0.42 * turb * turb * Math.exp(-rb / 6000);
        tau *= smooth((rb - 340) / 900);
        T = Math.exp(-tau);
        ext = 1 - T;

        va = stretch(Lv * T * 1.15);
        mix = clamp(1 - 0.55 * smooth((rb - 1200) / 6000), 0, 1);
        r = lerp(P.warmIn[0], P.nucleus[0], mix * (rb < 1400 ? 1 : 0.35));
        gg = lerp(P.warmIn[1], P.nucleus[1], mix * (rb < 1400 ? 1 : 0.35));
        b = lerp(P.warmIn[2], P.nucleus[2], mix * (rb < 1400 ? 1 : 0.35));
        gg *= (1 - 0.24 * ext);
        b *= (1 - 0.46 * ext);

        d[o] = r | 0; d[o + 1] = gg | 0; d[o + 2] = b | 0;
        d[o + 3] = alphaByte(va, i, j);
        L.lum[j * n + i] = va;
        L.amp[j * n + i] = clamp(Lv, 0, 1) * T;
        L.trn[j * n + i] = T;
      }
    }
  }

  /* ---- HALO ---- */

  function haloNoiseJobs(jobs, L) {
    var s = L.seed, n = L.field, tag = 'halo:noise';
    jobs.push(named(tag, function () { L.g = {}; L.gn = {}; }));
    gridJobs(jobs, tag, 160, 5.0, s + 311, 3, false, function (g) { L.g.floc = g; L.gn.floc = 160; });
    jobs.push(named(tag, function () {
      L.img = L.fctx.createImageData(n, n);
      L.lum = new Float32Array(n * n);
      L.amp = new Float32Array(n * n);
      L.trn = new Float32Array(n * n);
    }));
  }
  function haloFieldRows(L, j0, j1) {
    var n = L.field, half = L.half, d = L.img.data, P = pal();
    var j, i, u, v, X, Y, rb, Lv, va, o, fl;
    for (j = j0; j < j1; j++) {
      v = (j + 0.5) / n;
      Y = (1 - 2 * v) * half;
      for (i = 0; i < n; i++) {
        u = (i + 0.5) / n;
        X = (2 * u - 1) * half;
        rb = Math.sqrt(X * X + Y * Y);
        o = (j * n + i) * 4;
        if (rb > 60000) {
          d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; d[o + 3] = 0;
          L.lum[j * n + i] = 0; L.amp[j * n + i] = 0; L.trn[j * n + i] = 1;
          continue;
        }
        Lv = 0.30 * Math.exp(-Math.pow((rb + 500) / 5200, 0.56));
        Lv *= 1 - smooth((rb - 44000) / 14000);
        fl = gsamp(L.g.floc, L.gn.floc, u, v);
        Lv *= (0.80 + 0.40 * fl);
        va = stretch(Lv) * 0.62;
        d[o] = P.halo[0]; d[o + 1] = P.halo[1]; d[o + 2] = P.halo[2];
        d[o + 3] = alphaByte(va > 0.85 ? 0.85 : va, i, j);
        L.lum[j * n + i] = va;
        L.amp[j * n + i] = va;
        L.trn[j * n + i] = 1;
      }
    }
  }

  /* Fold a stride sample of the baked field into the digest, so the
     fingerprint covers the PAINTING (and therefore the theme and the tone
     curve), not only where the stamps landed. */
  function digestField(L, j0, j1) {
    var n = L.field, d = L.img.data, j, i, o;
    for (j = j0; j < j1; j += 3) {
      for (i = 0; i < n; i += 13) {
        o = (j * n + i) * 4;
        digestNum(d[o] + d[o + 1] * 256 + d[o + 2] * 65536 + d[o + 3] * 16777216);
      }
    }
  }

  /* ---- shared: push the field onto the layer ---- */
  function fieldFlush(L) {
    L.fctx.putImageData(L.img, 0, 0);
    var c = L.ctx;
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    if ('imageSmoothingEnabled' in c) c.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in c) c.imageSmoothingQuality = 'high';
    c.drawImage(L.fcan, 0, 0, L.field, L.field, 0, 0, L.side, L.side);
    L.img = null;
  }

  /* ---- stamp passes ---- */

  function fsamp(arr, n, u, v) {
    var x = u * (n - 1), y = v * (n - 1);
    if (!(x >= 0)) x = 0; else if (x > n - 1.0001) x = n - 1.0001;
    if (!(y >= 0)) y = 0; else if (y > n - 1.0001) y = n - 1.0001;
    var xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi;
    var o = yi * n + xi;
    var a = arr[o], b = arr[o + 1], c = arr[o + n], d = arr[o + n + 1];
    var t = a + (b - a) * fx;
    return t + ((c + (d - c) * fx) - t) * fy;
  }

  /* Importance sampling. Rejection sampling against a field that is mostly
     dark burned most of the bake budget, so each (field, exponent) pair gets
     one cumulative table built in a single pass and every stamp after that
     is a binary search. */
  function cdfKey(which, pw) { return which + '|' + pw; }
  function cdfEntry(L, which, pw) {
    if (!L.cdf) L.cdf = {};
    var key = cdfKey(which, pw);
    if (!L.cdf[key]) {
      L.cdf[key] = { c: new Float64Array(L.field * L.field), total: 0,
                     n: L.field, which: which, pw: pw };
    }
    return L.cdf[key];
  }
  function cdfWeights(L, t, i0, i1) {
    var arr = t.which === 'amp' ? L.amp : L.lum, i, v;
    for (i = i0; i < i1; i++) {
      v = arr[i];
      t.c[i] = v > 0 ? Math.pow(v, t.pw) : 0;
    }
  }
  function cdfSum(t) {
    var c = t.c, N = c.length, i, sum = 0;
    for (i = 0; i < N; i++) { sum += c[i]; c[i] = sum; }
    t.total = sum;
  }
  /* Falls back to building the whole table in one go, which only happens if
     a caller stamps without the planner having queued the jobs. */
  function cdfFor(L, which, pw) {
    var t = cdfEntry(L, which, pw);
    if (!(t.total > 0)) {
      cdfWeights(L, t, 0, t.c.length);
      cdfSum(t);
    }
    return t;
  }
  function cdfJobs(jobs, tag, L, which, pw) {
    var N = L.field * L.field, chunk = 40000, i;
    jobs.push(named(tag, function () { cdfEntry(L, which, pw); }));
    for (i = 0; i < N; i += chunk) {
      (function (a, b) {
        jobs.push(named(tag, function () {
          cdfWeights(L, cdfEntry(L, which, pw), a, Math.min(b, N));
        }));
      })(i, i + chunk);
    }
    jobs.push(named(tag, function () { cdfSum(cdfEntry(L, which, pw)); }));
  }
  function cdfPick(t, r) {
    var lo = 0, hi = t.c.length - 1, mid, x = r * t.total;
    while (lo < hi) {
      mid = (lo + hi) >> 1;
      if (t.c[mid] < x) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function stampBatch(L, spec, count) {
    var c = L.ctx, S = L.side, n = L.field, rnd = L.rnd, sp = L.sprites;
    var k, u, v, size, a, img, tint, hi, idx;
    var t = cdfFor(L, spec.field, spec.pow);
    if (!(t.total > 0)) return;
    c.globalCompositeOperation = stampOp();
    for (k = 0; k < count; k++) {
      idx = cdfPick(t, rnd());
      u = ((idx % n) + rnd()) / n;
      v = (((idx / n) | 0) + rnd()) / n;
      if (spec.rMin || spec.rMax) {
        var X = (2 * u - 1) * L.half, Y = (1 - 2 * v) * L.half;
        var R = Math.sqrt(X * X + Y * Y);
        if (spec.rMin && R < spec.rMin) continue;
        if (spec.rMax && R > spec.rMax) continue;
      }
      hi = fsamp(L.lum, n, u, v);
      tint = spec.tint;
      if (spec.tintAlt && rnd() < spec.tintAltP) tint = spec.tintAlt;
      img = sp[tint];
      if (!img) continue;
      size = spec.sMin + (spec.sMax - spec.sMin) * Math.pow(rnd(), spec.sPow || 1);
      size *= S / 2048;
      if (size < 0.7) size = 0.7;
      a = spec.aMin + (spec.aMax - spec.aMin) * rnd();
      if (spec.lumPow) a *= clamp(Math.pow(clamp(hi, 0, 1), spec.lumPow) * 1.35, 0, 1.35);
      a *= fsamp(L.trn, n, u, v);
      a = clamp(a, 0, 1);
      if (a < 0.006) continue;
      c.globalAlpha = a;
      var px = u * S, py = v * S;
      c.drawImage(img, px - size, py - size, size * 2, size * 2);
      digestNum(px); digestNum(py); digestNum(size); digestNum(a);
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }

  /* Bright HII knots get a second, tighter core so they read as points at
     small scale and as nebulae up close. */
  function stampHii(L, count) {
    var c = L.ctx, S = L.side, n = L.field, rnd = L.rnd, sp = L.sprites;
    var t = cdfFor(L, 'amp', 2.4), m;
    if (!(t.total > 0)) return;
    c.globalCompositeOperation = stampOp();
    for (m = 0; m < count; m++) {
      var idx = cdfPick(t, rnd());
      var u = ((idx % n) + rnd()) / n;
      var v = (((idx / n) | 0) + rnd()) / n;
      var X = (2 * u - 1) * L.half, Y = (1 - 2 * v) * L.half;
      var R = Math.sqrt(X * X + Y * Y);
      if (R < 4200 || R > 50000) continue;
      var k = S / 2048;
      var halo = (7 + rnd() * 13) * k, core = (1.5 + rnd() * 2.4) * k;
      var tr = fsamp(L.trn, n, u, v);
      var px = u * S, py = v * S;
      c.globalAlpha = clamp(0.10 + rnd() * 0.16, 0, 1) * tr;
      c.drawImage(sp.hii, px - halo, py - halo, halo * 2, halo * 2);
      c.globalAlpha = clamp(0.42 + rnd() * 0.40, 0, 1) * tr;
      c.drawImage(sp.hii, px - core, py - core, core * 2, core * 2);
      digestNum(px); digestNum(py); digestNum(halo);
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }

  /* The sprite atlas is shared by all three layers, so it is released once,
     by its own job, rather than by whichever layer finishes last. */
  function freeSprites(sp) {
    if (!sp) return;
    for (var k in sp) {
      if (Object.prototype.hasOwnProperty.call(sp, k)) freeCanvas(sp[k]);
    }
  }

  function freeFieldTemps(L) {
    if (!L) return;
    /* the occupancy map has to be built while the field is still alive */
    if (L.lum && !L.occ) buildOcc(L);
    freeCanvas(L.fcan);
    L.fcan = null; L.fctx = null;
    L.g = null; L.dust = null; L.dust2 = null; L.img = null;
    L.lum = null; L.amp = null; L.trn = null; L.sprites = null; L.cdf = null;
  }

  /* Which 40x40 blocks of a layer hold paint. The galaxy is a disc inscribed
     in a square, so the corners are empty and the draw pass can skip them. */
  function buildOcc(L) {
    var gn = 40, g = new Uint8Array(gn * gn), n = L.field, i, j, u, v;
    for (j = 0; j < gn; j++) {
      for (i = 0; i < gn; i++) {
        u = (i + 0.5) / gn; v = (j + 0.5) / gn;
        g[j * gn + i] = fsamp(L.lum, n, u, v) > 0.004 ? 1 : 0;
      }
    }
    /* dilate by one so a block bordering paint is never dropped */
    var h = new Uint8Array(gn * gn), a, b, on, xx, yy;
    for (j = 0; j < gn; j++) {
      for (i = 0; i < gn; i++) {
        on = 0;
        for (b = -1; b <= 1 && !on; b++) {
          for (a = -1; a <= 1; a++) {
            xx = i + a; yy = j + b;
            if (xx < 0 || yy < 0 || xx >= gn || yy >= gn) continue;
            if (g[yy * gn + xx]) { on = 1; break; }
          }
        }
        h[j * gn + i] = on;
      }
    }
    L.occ = h; L.occN = gn;
  }

  /* ---------------- job planning ---------------- */

  function mkLayer(name, side, field, seed) {
    var can = mkCanvas(side, side);
    if (!can) return null;
    var ctx = can.getContext('2d');
    if (!ctx) return null;
    var fcan = mkCanvas(field, field);
    if (!fcan) return null;
    var fctx = fcan.getContext('2d');
    if (!fctx) return null;
    return {
      name: name, canvas: can, ctx: ctx, side: side,
      fcan: fcan, fctx: fctx, field: field,
      half: EXT[name], seed: seed, rnd: mulberry32(seed ^ 0x9e3779b9),
      sprites: null, mask: {}
    };
  }

  function planBake(seed, opts) {
    var mob = isMobile(opts);
    var SIDES = mob ? SIDE_MOB : SIDE_DESK;
    var FIELDS = mob ? FIELD_MOB : FIELD_DESK;
    var scale = mob ? 0.42 : 1;
    var jobs = [];
    var layers = {};
    var names = ['core', 'arms', 'halo'];
    var i, ok = true;
    for (i = 0; i < names.length; i++) {
      var L = mkLayer(names[i], SIDES[names[i]], FIELDS[names[i]],
                      (seed + i * 7919) | 0);
      if (!L) { ok = false; break; }
      layers[names[i]] = L;
    }
    if (!ok) {
      for (i = 0; i < names.length; i++) {
        if (layers[names[i]]) { freeCanvas(layers[names[i]].canvas); freeCanvas(layers[names[i]].fcan); }
      }
      return null;
    }

    var sprites = buildSprites();
    if (!sprites) {
      for (i = 0; i < names.length; i++) {
        if (layers[names[i]]) { freeCanvas(layers[names[i]].canvas); freeCanvas(layers[names[i]].fcan); }
      }
      return null;
    }
    layers.core.sprites = sprites;
    layers.arms.sprites = sprites;
    layers.halo.sprites = sprites;

    function rowJobs(L, emitNoise, rows, step) {
      emitNoise(jobs, L);
      var j;
      for (j = 0; j < L.field; j += step) {
        (function (a, b) {
          jobs.push(named(L.name + ':field', function () {
            var b2 = Math.min(b, L.field);
            rows(L, a, b2);
            digestField(L, a, b2);
          }));
        })(j, j + step);
      }
      jobs.push(named(L.name + ':flush', function () { fieldFlush(L); }));
    }

    /* --- arms --- */
    var A = layers.arms;
    rowJobs(A, armsNoiseJobs, armsFieldRows, Math.max(3, Math.round(A.field / 140)));
    var nCloud = Math.round(5600 * scale), nGrain = Math.round(11000 * scale);
    var nOb = Math.round(1250 * scale), nHii = Math.round(440 * scale);
    pushStamps(jobs, A, {
      field: 'lum', pow: 1.55, tint: 'neutral', tintAlt: 'armBlue', tintAltP: 0.6,
      sMin: 4, sMax: 17, sPow: 2.0, aMin: 0.026, aMax: 0.082, lumPow: 0.9
    }, nCloud, 80);
    pushStamps(jobs, A, {
      field: 'lum', pow: 1.35, tint: 'neutral', tintAlt: 'armHot', tintAltP: 0.45,
      sMin: 0.8, sMax: 2.3, sPow: 2.2, aMin: 0.10, aMax: 0.34, lumPow: 1.25
    }, nGrain, 220);
    pushStamps(jobs, A, {
      field: 'amp', pow: 2.2, tint: 'armHot', tintAlt: 'armBlue', tintAltP: 0.5,
      sMin: 1.8, sMax: 8, sPow: 2.1, aMin: 0.16, aMax: 0.46, rMin: 4200
    }, nOb, 140);
    cdfJobs(jobs, 'arms:cdf', A, 'amp', 2.4);
    (function () {
      var leftH = nHii, kH;
      while (leftH > 0) {
        kH = Math.min(35, leftH);
        (function (cnt) { jobs.push(named('arms:hii', function () { stampHii(A, cnt); })); })(kH);
        leftH -= kH;
      }
    })();

    /* --- core --- */
    var C = layers.core;
    rowJobs(C, coreNoiseJobs, coreFieldRows, Math.max(3, Math.round(C.field / 90)));
    pushStamps(jobs, C, {
      field: 'lum', pow: 1.6, tint: 'warmIn', tintAlt: 'nucleus', tintAltP: 0.35,
      sMin: 3, sMax: 16, sPow: 1.9, aMin: 0.020, aMax: 0.062, lumPow: 1.0
    }, Math.round(1700 * scale), 140);
    pushStamps(jobs, C, {
      field: 'lum', pow: 1.25, tint: 'warmIn', tintAlt: 'nucleus', tintAltP: 0.4,
      sMin: 0.8, sMax: 2.4, sPow: 2.1, aMin: 0.10, aMax: 0.34, lumPow: 1.2
    }, Math.round(5000 * scale), 220);

    /* --- halo --- */
    var Hl = layers.halo;
    rowJobs(Hl, haloNoiseJobs, haloFieldRows, Math.max(3, Math.round(Hl.field / 40)));
    /* No globular stamps here. The halo layer is a single affine (it is
       centred and near-circular, per the spec), and a single affine cannot
       carry the perspective when the camera is closer than the layer is
       wide: point-like stamps smeared into comet trails across the empty
       sky at logD 9.6 (see wave4/G/diag-0.png). A smooth wash has no
       features to smear, and voyage.js's own point cloud already carries
       600 real halo points, so stamping more here only double-drew them. */

    /* --- teardown --- */
    jobs.push(named('free', function () { freeFieldTemps(A); }));
    jobs.push(named('free', function () { freeFieldTemps(C); }));
    jobs.push(named('free', function () { freeFieldTemps(Hl); }));
    jobs.push(named('free', function () { freeSprites(sprites); }));

    return { jobs: jobs, layers: layers, mob: mob, sprites: sprites };
  }

  function named(n, fn) { fn.jn = n; return fn; }

  function pushStamps(jobs, L, spec, total, per) {
    var left = total, k;
    cdfJobs(jobs, L.name + ':cdf', L, spec.field, spec.pow);
    while (left > 0) {
      k = Math.min(per, left);
      (function (cnt) {
        jobs.push(named(L.name + ':stamp', function () { stampBatch(L, spec, cnt); }));
      })(k);
      left -= k;
    }
  }

  /* ---------------- bake driver ---------------- */

  function nowMs() {
    var p = global && global.performance;
    return (p && typeof p.now === 'function') ? p.now() : NaN;
  }

  function bakeKey(seed, theme, mob) {
    return (seed | 0) + '|' + theme + '|' + (mob ? 'm' : 'd');
  }

  function startBake(seed, opts) {
    var o = opts || {};
    var theme = (o.theme === 'light') ? 'light' : 'dark';
    var mob = isMobile(o);
    var key = bakeKey(seed, theme, mob);
    disposeLayers();
    st.seed = seed | 0;
    st.theme = theme;
    st.sizeClass = mob ? 'mobile' : 'desktop';
    st.key = key;
    st.digest = 2166136261;
    st.themeStale = false;
    st.lastOpts = { theme: theme, mobile: mob, lyAu: o.lyAu };
    var plan = planBake(st.seed, { mobile: mob });
    if (!plan) {
      st.reason = 'no canvas';
      st.jobs = null; st.baking = false;
      return false;
    }
    st.layers = plan.layers;
    st.sprites = plan.sprites;
    st.jobs = plan.jobs;
    st.ji = 0;
    st.baking = true;
    st.ready = false;
    st.bakeMs = 0;
    st.jobMax = JOB_MS0;
    st.reason = 'baking';
    return true;
  }

  function finishBake() {
    st.baking = false;
    st.jobs = null;
    st.ready = !!st.layers;
    st.reason = st.ready ? '' : 'bake failed';
    var px = 0, n = 0, k;
    for (k in st.layers) {
      if (!Object.prototype.hasOwnProperty.call(st.layers, k)) continue;
      px += st.layers[k].side * st.layers[k].side;
      n++;
    }
    st.px = px;
    st.bytes = px * 4;
    st.nLayers = n;
    var cb = st.onDone;
    st.onDone = null;
    if (typeof cb === 'function') cb(stats());
  }

  /* Runs one slice of the bake (<= SLICE_MS). Returns true while work
     remains. Without a clock it runs exactly one job per call, which is why
     every job is sized to fit inside a slice on its own. */
  function bakeStep() {
    if (!st.baking || !st.jobs) return false;
    var t0 = nowMs(), timed = fin(t0), el = 0, ran = 0, tj, dt;
    while (st.ji < st.jobs.length) {
      if (timed && ran > 0) {
        el = nowMs() - t0;
        /* Reserve the longest job seen so far before starting another one.
           Checking AFTER a job instead lets a slice overshoot by that job's
           whole duration, which is how a 12 ms budget turned into 133 ms
           measured. The reserve decays so one slow outlier does not shrink
           every later slice to a single job. */
        if (!fin(el) || el + st.jobMax >= SLICE_MS) break;
      }
      tj = timed ? nowMs() : 0;
      try { st.jobs[st.ji](); } catch (e) { st.reason = 'bake error: ' + (e && e.message); }
      if (timed) {
        dt = nowMs() - tj;
        if (fin(dt)) {
          st.jobMax = Math.max(dt, st.jobMax * 0.995, JOB_MS0);
          if (st.jobMax > SLICE_MS - 1) st.jobMax = SLICE_MS - 1;
        }
      }
      ran++;
      st.ji++;
      if (!timed) break;
    }
    if (timed) {
      el = nowMs() - t0;
      if (fin(el)) st.bakeMs += el;
    }
    if (st.ji >= st.jobs.length) { finishBake(); return false; }
    return true;
  }

  function schedule(fn) {
    if (global && typeof global.requestIdleCallback === 'function') {
      st.pending = global.requestIdleCallback(fn, { timeout: 60 });
      return true;
    }
    if (global && typeof global.setTimeout === 'function') {
      st.pending = global.setTimeout(fn, 0);
      return true;
    }
    return false;
  }
  function pump() {
    st.pending = null;
    if (!st.baking) return;
    var more = bakeStep();
    if (more) schedule(pump);
  }

  function bake(seed, opts, onDone) {
    var o = opts || {};
    var theme = (o.theme === 'light') ? 'light' : 'dark';
    var mob = isMobile(o);
    var key = bakeKey(num(seed, 0) | 0, theme, mob);
    if (st.ready && st.key === key) {
      if (typeof onDone === 'function') onDone(stats());
      return true;
    }
    if (st.baking && st.key === key) {
      if (typeof onDone === 'function') st.onDone = onDone;
      return true;
    }
    if (!startBake(num(seed, 0) | 0, o)) {
      if (typeof onDone === 'function') onDone(stats());
      return false;
    }
    st.onDone = (typeof onDone === 'function') ? onDone : null;
    if (!schedule(pump)) {
      /* no scheduler (node): the caller must pump bakeStep or use bakeSync */
      st.reason = 'no scheduler';
    }
    return true;
  }

  /* Synchronous bake for node / the dom-stub: identical work, no timers. */
  function bakeSync(seed, opts) {
    var o = opts || {};
    var theme = (o.theme === 'light') ? 'light' : 'dark';
    var mob = isMobile(o);
    var key = bakeKey(num(seed, 0) | 0, theme, mob);
    if (st.ready && st.key === key) return stats();
    if (!startBake(num(seed, 0) | 0, o)) return stats();
    var guard = 0, prof = o.profile ? {} : null, t0, t1, nm;
    while (st.baking && st.jobs && st.ji < st.jobs.length) {
      t0 = prof ? nowMs() : 0;
      try { st.jobs[st.ji](); } catch (e) { st.reason = 'bake error: ' + (e && e.message); }
      if (prof) {
        t1 = nowMs();
        nm = st.jobs[st.ji].jn || '?';
        var dt = fin(t1 - t0) ? t1 - t0 : 0;
        prof[nm] = (prof[nm] || 0) + dt;
        if (!prof.__max) prof.__max = {};
        if (dt > (prof.__max[nm] || 0)) prof.__max[nm] = Math.round(dt * 100) / 100;
      }
      st.ji++;
      if (++guard > 100000) break;
    }
    st.prof = prof;
    finishBake();
    return stats();
  }

  function disposeLayers() {
    freeSprites(st.sprites);
    st.sprites = null;
    if (st.layers) {
      var k;
      for (k in st.layers) {
        if (!Object.prototype.hasOwnProperty.call(st.layers, k)) continue;
        freeFieldTemps(st.layers[k]);
        freeCanvas(st.layers[k].canvas);
      }
    }
    st.layers = null;
    st.ready = false;
    st.px = 0; st.bytes = 0; st.nLayers = 0;
  }

  function dispose() {
    if (st.pending != null) {
      if (global && typeof global.cancelIdleCallback === 'function' &&
          typeof global.requestIdleCallback === 'function') {
        try { global.cancelIdleCallback(st.pending); } catch (e) { /* ignore */ }
      } else if (global && typeof global.clearTimeout === 'function') {
        try { global.clearTimeout(st.pending); } catch (e2) { /* ignore */ }
      }
      st.pending = null;
    }
    st.baking = false;
    st.jobs = null;
    st.ji = 0;
    st.onDone = null;
    st.key = '';
    st.reason = 'disposed';
    disposeLayers();
  }

  /* The theme flipped: the bake is theme-keyed, so the layers are dead.
     A theme string (or an opts object) starts the re-bake immediately;
     without one the next draw() supplies the theme and starts it. */
  function invalidateTheme(hint) {
    var theme = null;
    if (typeof hint === 'string') theme = (hint === 'light') ? 'light' : 'dark';
    else if (hint && typeof hint === 'object' && hint.theme) {
      theme = (hint.theme === 'light') ? 'light' : 'dark';
    }
    var seed = st.seed;
    var prev = st.lastOpts || {};
    disposeLayers();
    st.baking = false;
    st.jobs = null;
    st.key = '';
    st.themeStale = true;
    st.reason = 'theme changed';
    if (theme) {
      st.themeStale = false;
      bake(seed, { theme: theme, mobile: prev.mobile, lyAu: prev.lyAu }, null);
    }
    return true;
  }

  function ready() { return !!st.ready; }

  function stats() {
    return {
      px: st.px,
      bytes: st.bytes,
      layers: st.nLayers,
      theme: st.theme,
      seed: st.seed,
      sizeClass: st.sizeClass,
      ready: st.ready,
      baking: st.baking,
      bakeMs: Math.round(st.bakeMs * 100) / 100,
      prof: st.prof || null,
      digest: st.digest >>> 0,
      reason: st.reason
    };
  }

  /* ==================================================================
     Draw
     ================================================================== */

  /* equatorial -> ecliptic, the pinned J2000 obliquity (identical to
     VoyageAstro.equToEcl, which this file may not reach into). Only used
     when the caller hands over the equatorial galactic basis, which is what
     PURE.galBasis() returns; pass opts.frame === 'ecl' to skip it. */
  function toEcl(v, out) {
    var ce = Math.cos(OBLIQUITY), se = Math.sin(OBLIQUITY);
    out[0] = v[0];
    out[1] = ce * v[1] + se * v[2];
    out[2] = -se * v[1] + ce * v[2];
    return out;
  }
  function vecOk(v) {
    return v && v.length >= 3 && fin(v[0]) && fin(v[1]) && fin(v[2]);
  }

  function setFrame(opts) {
    var b = opts && opts.basis;
    if (!b || !vecOk(b.x) || !vecOk(b.y) || !vecOk(b.z)) return false;
    var lyAu = num(opts.lyAu, LY_AU_DEF);
    var ecl = (opts.frame === 'ecl');
    var sig = b.x[0] + ',' + b.x[1] + ',' + b.x[2] + ';' +
              b.y[0] + ',' + b.y[1] + ',' + b.y[2] + ';' +
              b.z[0] + ',' + b.z[1] + ',' + b.z[2] + ';' + lyAu + ';' + (ecl ? 1 : 0);
    if (sig === frame.sig) return true;
    var t = [0, 0, 0];
    if (ecl) { t[0] = b.x[0]; t[1] = b.x[1]; t[2] = b.x[2]; } else toEcl(b.x, t);
    frame.ux = t[0]; frame.uy = t[1]; frame.uz = t[2];
    if (ecl) { t[0] = b.y[0]; t[1] = b.y[1]; t[2] = b.y[2]; } else toEcl(b.y, t);
    frame.vx = t[0]; frame.vy = t[1]; frame.vz = t[2];
    if (ecl) { t[0] = b.z[0]; t[1] = b.z[1]; t[2] = b.z[2]; } else toEcl(b.z, t);
    frame.nx = t[0]; frame.ny = t[1]; frame.nz = t[2];
    frame.lyAu = lyAu;
    frame.sig = sig;
    return true;
  }

  /* galactocentric plane point (ly) -> world ecliptic AU */
  function planeWorld(X, Y, out) {
    var a = (GAL_R0_LY + X) * frame.lyAu, b = Y * frame.lyAu;
    out[0] = frame.ux * a + frame.vx * b;
    out[1] = frame.uy * a + frame.vy * b;
    out[2] = frame.uz * a + frame.vz * b;
    return out;
  }

  /* Normalised layer coords -> world AU. Exported so the rigid-rotation QA
     can pick an anchor on the painting and project it itself. */
  function anchor(layer, u, v, out, opts) {
    var half = EXT[layer];
    if (!fin(half)) return null;
    var o = out || [0, 0, 0];
    if (opts && opts.basis) setFrame(opts);
    if (!frame.sig) return null;
    return planeWorld((2 * num(u, 0.5) - 1) * half, (1 - 2 * num(v, 0.5)) * half, o);
  }

  /* Which cells of an N x N mesh actually hold paint. The galaxy is a disc
     inscribed in a square, so about a fifth of the cells are empty. */
  function cellMask(L, N) {
    if (L.mask[N]) return L.mask[N];
    var m = new Uint8Array(N * N);
    var g = L.occ, gn = L.occN;
    var i, j, a, b, any, x, y;
    if (!g) { m.fill(1); L.mask[N] = m; return m; }
    for (j = 0; j < N; j++) {
      for (i = 0; i < N; i++) {
        any = 0;
        for (b = 0; b <= 4 && !any; b++) {
          for (a = 0; a <= 4; a++) {
            x = Math.min(gn - 1, Math.floor(((i + a / 4) / N) * gn));
            y = Math.min(gn - 1, Math.floor(((j + b / 4) / N) * gn));
            if (g[y * gn + x]) { any = 1; break; }
          }
        }
        m[j * N + i] = any;
      }
    }
    L.mask[N] = m;
    return m;
  }

  function layerAlpha(name) {
    return (st.theme === 'light' ? LAY_A_L : LAY_A_D)[name] || 0;
  }

  /* Compose (never replace) the caller's transform: voyage.js keeps a dpr
     scale on the main context, and setTransform would throw it away. */
  function applyTransform(ctx, a, b, c, d, e, f) {
    if (typeof ctx.transform === 'function') ctx.transform(a, b, c, d, e, f);
    else ctx.setTransform(a, b, c, d, e, f);
  }

  /* Single-affine layer (core, halo). Three projected basis points are
     enough because the layer is centred and near-circular. */
  function drawAffineLayer(ctx, project, L, alpha, cw, ch) {
    var half = L.half, S = L.side;
    planeWorld(0, 0, W3);
    if (!project(W3[0], W3[1], W3[2], PRJ)) return false;
    var ox = PRJ.x, oy = PRJ.y;
    if (!fin(ox) || !fin(oy)) return false;

    /* try +axis, fall back to -axis if that corner is behind the camera */
    var ux = 0, uy = 0, vx = 0, vy = 0, got;
    planeWorld(half, 0, W3);
    got = project(W3[0], W3[1], W3[2], PRJ);
    if (got) { ux = PRJ.x - ox; uy = PRJ.y - oy; }
    else {
      planeWorld(-half, 0, W3);
      if (!project(W3[0], W3[1], W3[2], PRJ)) return false;
      ux = ox - PRJ.x; uy = oy - PRJ.y;
    }
    planeWorld(0, half, W3);
    got = project(W3[0], W3[1], W3[2], PRJ);
    if (got) { vx = PRJ.x - ox; vy = PRJ.y - oy; }
    else {
      planeWorld(0, -half, W3);
      if (!project(W3[0], W3[1], W3[2], PRJ)) return false;
      vx = ox - PRJ.x; vy = oy - PRJ.y;
    }
    if (!fin(ux) || !fin(uy) || !fin(vx) || !fin(vy)) return false;

    /* layer pixel (x, y) -> screen. x = 0 is X = -half, y = 0 is Y = +half */
    var a = 2 * ux / S, b = 2 * uy / S;
    var c = -2 * vx / S, d = -2 * vy / S;
    var e = ox - ux + vx, f = oy - uy + vy;
    var det = a * d - b * c;
    if (!fin(det) || Math.abs(det) < 1e-12) return false;
    /* too small to see, or so degenerate it is a line */
    var sizeX = Math.sqrt(ux * ux + uy * uy), sizeY = Math.sqrt(vx * vx + vy * vy);
    if (sizeX < 1.2 || sizeY < 1.2) return false;
    /* off screen */
    var m = Math.max(sizeX, sizeY) + 8;
    if (ox < -m || oy < -m || ox > cw + m || oy > ch + m) return false;

    ctx.save();
    ctx.globalCompositeOperation = st.theme === 'light' ? 'source-over' : 'lighter';
    ctx.globalAlpha = alpha;
    applyTransform(ctx, a, b, c, d, e, f);
    ctx.drawImage(L.canvas, 0, 0);
    ctx.restore();
    return true;
  }

  /* ---- seams ----
     Measured, not assumed (see wave4/G/seamlab-*.png). The hairline grid
     that a naive mesh leaves comes from the ANTIALIASED EDGE OF THE
     DESTINATION RECT, not from the clip: drawImage with a source sub-rect
     antialiases the rect it lands in, and that edge sits exactly on the
     cell boundary. Two fixes together remove it completely:
       1. two triangles per cell, so the paint is continuous across every
          shared edge (a single 3-corner affine misses the fourth corner and
          leaves shifted tiles at oblique angles);
       2. a source rect expanded far enough that its antialiased edge lands
          several screen pixels OUTSIDE the clipped triangle.
     With those, the clip's own antialiasing is complementary along a shared
     edge and sums correctly, so no scratch buffer and no overlap is needed.
     Overlapping the clips instead makes it worse: alpha accumulates and the
     grid comes back bright. */

  /* Clip to a triangle. The three vertices are the same three the affine
     was fitted to, which is what makes the painting continuous across a
     shared edge: both neighbours are pinned by the same two points. */
  function clipTri(g, x0, y0, x1, y1, x2, y2) {
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.lineTo(x2, y2);
    g.closePath();
    g.clip();
  }

  /* Meshed layer (arms): a grid of projected quads, each with its own
     affine and its own clip, drawn back to front. */
  function drawMeshLayer(ctx, project, L, alpha, N, cw, ch) {
    var half = L.half, S = L.side;
    var i, j, o, u, v, X, Y, okAny = 0;
    var stride = N + 1;
    for (j = 0; j <= N; j++) {
      v = j / N;
      Y = (1 - 2 * v) * half;
      for (i = 0; i <= N; i++) {
        u = i / N;
        X = (2 * u - 1) * half;
        planeWorld(X, Y, W3);
        o = j * stride + i;
        if (project(W3[0], W3[1], W3[2], PRJ) && fin(PRJ.x) && fin(PRJ.y)) {
          cxA[o] = PRJ.x; cyA[o] = PRJ.y; czA[o] = PRJ.z; cOk[o] = 1; okAny = 1;
        } else {
          cOk[o] = 0;
        }
      }
    }
    if (!okAny) return false;

    var mask = cellMask(L, N);
    var cw2 = S / N, nVis = 0;
    var i0, i1, i2, i3, bx0, bx1, by0, by1, k;
    for (j = 0; j < N; j++) {
      for (i = 0; i < N; i++) {
        if (!mask[j * N + i]) continue;
        i0 = j * stride + i; i1 = i0 + 1; i2 = i0 + stride; i3 = i2 + 1;
        if (!cOk[i0] || !cOk[i1] || !cOk[i2] || !cOk[i3]) continue;
        bx0 = Math.min(Math.min(cxA[i0], cxA[i1]), Math.min(cxA[i2], cxA[i3]));
        bx1 = Math.max(Math.max(cxA[i0], cxA[i1]), Math.max(cxA[i2], cxA[i3]));
        by0 = Math.min(Math.min(cyA[i0], cyA[i1]), Math.min(cyA[i2], cyA[i3]));
        by1 = Math.max(Math.max(cyA[i0], cyA[i1]), Math.max(cyA[i2], cyA[i3]));
        if (bx1 < -8 || by1 < -8 || bx0 > cw + 8 || by0 > ch + 8) continue;
        if (bx1 - bx0 < 0.35 && by1 - by0 < 0.35) continue;
        cellIdx[nVis] = j * N + i;
        cellZ[nVis] = (czA[i0] + czA[i1] + czA[i2] + czA[i3]) * 0.25;
        nVis++;
      }
    }
    if (!nVis) return false;

    /* back to front (insertion sort: nVis is about 80) */
    for (k = 1; k < nVis; k++) {
      var kz = cellZ[k], ki = cellIdx[k], p = k - 1;
      while (p >= 0 && cellZ[p] < kz) { cellZ[p + 1] = cellZ[p]; cellIdx[p + 1] = cellIdx[p]; p--; }
      cellZ[p + 1] = kz; cellIdx[p + 1] = ki;
    }

    var op = st.theme === 'light' ? 'source-over' : 'lighter';
    var g = ctx;
    var drawn = 0;
    for (k = 0; k < nVis; k++) {
      j = (cellIdx[k] / N) | 0; i = cellIdx[k] - j * N;
      i0 = j * stride + i; i1 = i0 + 1; i2 = i0 + stride; i3 = i2 + 1;
      var x0 = i * cw2, y0 = j * cw2, x1 = x0 + cw2, y1 = y0 + cw2;

      /* TWO triangles, not one quad. A single affine fitted to three of the
         four corners misses the fourth by the quad's perspective error, and
         at an oblique angle that mismatch shows up as a shifted-tile grid
         across the whole galaxy (measured, not theoretical). Two triangles
         share the diagonal, and along any shared edge both affines are
         pinned by the same two vertices, so the paint is continuous. */
      var a = (cxA[i1] - cxA[i0]) / cw2, b = (cyA[i1] - cyA[i0]) / cw2;
      var c = (cxA[i2] - cxA[i0]) / cw2, d = (cyA[i2] - cyA[i0]) / cw2;
      var det = a * d - b * c;

      /* Source margin, in LAYER pixels, sized so the destination rect's
         antialiased edge lands at least SEAM_PX screen pixels outside the
         clipped triangle. sc is screen px per layer px. */
      var sc = Math.sqrt(Math.abs(det));
      var spad = SEAM_PX / (sc > 1e-4 ? sc : 1e-4);
      var spadMax = cw2 * 0.6;
      if (!(spad >= 2)) spad = 2;
      if (spad > spadMax) spad = spadMax;
      var sx = x0 - spad, sy = y0 - spad, sw = cw2 + spad * 2, sh = cw2 + spad * 2;
      if (sx < 0) { sw += sx; sx = 0; }
      if (sy < 0) { sh += sy; sy = 0; }
      if (sx + sw > S) sw = S - sx;
      if (sy + sh > S) sh = S - sy;
      if (!(sw > 0) || !(sh > 0)) continue;
      if (fin(det) && Math.abs(det) > 1e-12) {
        var e = cxA[i0] - a * x0 - c * y0, f = cyA[i0] - b * x0 - d * y0;
        if (fin(e) && fin(f)) {
          g.save();
          clipTri(g, cxA[i0], cyA[i0], cxA[i1], cyA[i1], cxA[i2], cyA[i2]);
          g.globalCompositeOperation = op;
          g.globalAlpha = alpha;
          applyTransform(g, a, b, c, d, e, f);
          g.drawImage(L.canvas, sx, sy, sw, sh, sx, sy, sw, sh);
          g.restore();
          drawn++;
        }
      }
      var a2 = (cxA[i3] - cxA[i2]) / cw2, b2 = (cyA[i3] - cyA[i2]) / cw2;
      var c2 = (cxA[i3] - cxA[i1]) / cw2, d2 = (cyA[i3] - cyA[i1]) / cw2;
      var det2 = a2 * d2 - b2 * c2;
      if (fin(det2) && Math.abs(det2) > 1e-12) {
        var e2 = cxA[i3] - a2 * x1 - c2 * y1, f2 = cyA[i3] - b2 * x1 - d2 * y1;
        if (fin(e2) && fin(f2)) {
          g.save();
          clipTri(g, cxA[i3], cyA[i3], cxA[i2], cyA[i2], cxA[i1], cyA[i1]);
          g.globalCompositeOperation = op;
          g.globalAlpha = alpha;
          applyTransform(g, a2, b2, c2, d2, e2, f2);
          g.drawImage(L.canvas, sx, sy, sw, sh, sx, sy, sw, sh);
          g.restore();
          drawn++;
        }
      }
    }
    lastDraw.cells += nVis;
    lastDraw.tris += drawn;
    return drawn > 0;
  }

  function draw(ctx, project, camState, alpha, opts) {
    lastDraw.cells = 0; lastDraw.tris = 0; lastDraw.layers = 0; lastDraw.gp = 0;
    lastDraw.alpha = 0; lastDraw.reason = '';
    if (!ctx || typeof project !== 'function' || !camState) {
      lastDraw.reason = 'bad args';
      return false;
    }
    var o = opts || {};
    var theme = (o.theme === 'light') ? 'light' : 'dark';
    if (!st.ready) {
      lastDraw.reason = st.baking ? 'baking' : (st.reason || 'not ready');
      if (st.themeStale && !st.baking) {
        st.themeStale = false;
        bake(st.seed, { theme: theme, mobile: st.lastOpts && st.lastOpts.mobile }, null);
      }
      return false;
    }
    if (theme !== st.theme) {
      /* self-heal: the page flipped theme without telling us */
      lastDraw.reason = 'theme mismatch';
      invalidateTheme(theme);
      return false;
    }
    var a0 = num(alpha, 1);
    if (!(a0 > 0)) { lastDraw.reason = 'alpha 0'; return false; }
    if (a0 > 1) a0 = 1;
    var D = num(camState.D, NaN);
    if (!fin(D)) { lastDraw.reason = 'no camState.D'; return false; }
    var gp = ramp(D, GP_LO, GP_HI);
    lastDraw.gp = gp;
    var a = a0 * gp;
    lastDraw.alpha = a;
    if (!(a > 0.004)) { lastDraw.reason = 'faded out'; return false; }
    if (!setFrame(o)) { lastDraw.reason = 'no basis'; return false; }

    var N = Math.round(num(o.mesh, 10));
    if (!(N >= MESH_MIN)) N = MESH_MIN;
    if (N > MESH_MAX) N = MESH_MAX;
    var want = o.layers || { core: true, arms: true, halo: true };

    /* Culling bound. Device pixels are always >= CSS pixels, so using the
       backing-store size is conservative: it can never cull something that
       is actually on screen. */
    var cw = num(o.W, 0), ch = num(o.H, 0);
    if (!(cw > 0) || !(ch > 0)) {
      var cv = ctx.canvas;
      cw = (cv && fin(cv.width) && cv.width > 0) ? cv.width : 4096;
      ch = (cv && fin(cv.height) && cv.height > 0) ? cv.height : 4096;
    }

    var any = false, k, name, L;
    for (k = 0; k < st.order.length; k++) {
      name = st.order[k];
      if (want[name] === false) continue;
      L = st.layers ? st.layers[name] : null;
      if (!L || !L.canvas || !(L.canvas.width > 0)) continue;
      var la = a * layerAlpha(name);
      if (!(la > 0.003)) continue;
      if (la > 1) la = 1;
      var ok;
      if (name === 'arms') ok = drawMeshLayer(ctx, project, L, la, N, cw, ch);
      else ok = drawAffineLayer(ctx, project, L, la, cw, ch);
      if (ok) { any = true; lastDraw.layers++; }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    return any;
  }

  /* ---------------- export ---------------- */

  var VoyageGalaxy = {
    bake: bake,
    bakeSync: bakeSync,
    bakeStep: bakeStep,
    ready: ready,
    stats: stats,
    invalidateTheme: invalidateTheme,
    draw: draw,
    dispose: dispose,
    /* extras for integration + QA (additive; nothing above changes) */
    anchor: anchor,
    gp: function (D) { return ramp(num(D, 0), GP_LO, GP_HI); },
    lastDraw: function () {
      return { cells: lastDraw.cells, tris: lastDraw.tris,
               layers: lastDraw.layers, gp: lastDraw.gp,
               alpha: lastDraw.alpha, reason: lastDraw.reason };
    },
    layerCanvas: function (n) {
      return (st.layers && st.layers[n]) ? st.layers[n].canvas : null;
    },
    EXT: EXT,
    GP_LO: GP_LO,
    GP_HI: GP_HI,
    MESH_DEFAULT: 10,
    __model: {
      armOffset: armOffset, armWidth: armWidth, stretch: stretch,
      planeWorld: function (X, Y, out) { return planeWorld(X, Y, out || [0, 0, 0]); },
      setFrame: setFrame, R0: GAL_R0_LY, LY_AU: LY_AU_DEF
    }
  };

  global.VoyageGalaxy = VoyageGalaxy;
  if (typeof module !== 'undefined' && module.exports) module.exports = VoyageGalaxy;
})(typeof self !== 'undefined' ? self : globalThis);
