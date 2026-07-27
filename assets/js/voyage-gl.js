/* voyage-gl.js -- window.VoyageGL
   ==========================================================================
   A WebGL1 renderer for the star and planet ORBS on /voyage/. Raw GL, no
   libraries, one shared context on one internal offscreen canvas; the orb is
   rendered there and blitted into the page's 2D canvas with a single
   drawImage in the same rAF task.

   What this file is NOT: a source of physical truth. Every colour, limb
   term, spot layout, flare gate and ring geometry comes from VoyageArt
   (starLook / planetLook / flareUniforms). If a number is missing here, that
   is a VoyageArt bug, not a licence to duplicate a formula.

   The composition contract (D1 of plan-voyage-v3.md) is:
     1. VoyageArt.drawStarBack   -- corona, 'lighter'
     2. the GL blit              -- disc, limb, hot core, chromosphere,
                                    prominences, and nothing else
     3. VoyageArt.drawStarFront  -- flare bloom, 'lighter'
   so the glow around a GL orb is literally the same code as the glow around
   a fallback orb.

   Every entry point returns a boolean. false means "I did not draw
   anything", and the caller falls back to VoyageArt. It is never a partial
   draw: all the eligibility checks and the GL render happen before the first
   2D pass touches the page canvas.

   No Math.random, no Date.now, no wall clock anywhere in a draw path: the
   only clock is the tSec the caller passes in, so two runs with the same
   inputs produce the same pixels.
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------- pinned constants (D1) ---------------- */

  var K_GL = 1.60;             /* footprint half-extent, in star radii      */
  var GL_MIN_R = 40;           /* CSS px; smaller orbs stay on VoyageArt    */
  var GL_MAX_BLITS = 2;        /* GL blits per frame                        */
  var GL_REDRAW_MS = 50;       /* shader re-render interval (20 Hz)         */
  var SURF_ROT = 0.0233;       /* rad/s carried by the blit between renders */
  var TARGET_DESK = 1024;      /* device px, one square target, never resized */
  var TARGET_MOB = 512;
  var OCT_HI = 5, OCT_LO = 3;
  var GRAN_F0 = 9.0;
  var LACUNARITY = 2.02;
  var GAIN = 0.50;
  var WARP1_AMP = 0.55, WARP2_AMP = 0.22;
  var SPOT_MAX = 5;            /* VoyageArt.SPOT_MAX                        */
  var FLARE_SLOTS = 6;         /* VoyageArt.FLARE_SLOTS                     */
  var TWO_PI = Math.PI * 2;
  var SLOT_HOLD = 1.0;         /* seconds a slot survives without a draw    */

  /* Every type string VoyageArt.planetParams / exoParams can emit. A type
     outside this table makes drawPlanet return false rather than guess.
     `eyeball` is carried as its own id because the spec pins the enum that
     way; exoParams reaches it through the `eyeball` flag on a temperate or
     ice world, and both routes land on the same shading. */
  var TYPE_ID = {
    mercury: 0, venus: 1, earth: 2, mars: 3,
    jupiter: 4, saturn: 5, uranus: 6, neptune: 7,
    lava: 8, temperate: 9, eyeball: 10, hotjup: 11,
    neptunian: 12, ice: 13, rock: 14, gas: 15
  };

  /* ---------------- small helpers ---------------- */

  function num(v, d) {
    return (typeof v === 'number' && isFinite(v)) ? v : d;
  }
  function fin(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function finArr(a, n) {
    if (!a || a.length < n) return false;
    for (var i = 0; i < n; i++) if (!fin(a[i])) return false;
    return true;
  }
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function ART() {
    var A = global.VoyageArt;
    return (A && A.starLook && A.planetLook) ? A : null;
  }

  /* ---------------- device profile ---------------- */

  function isMobile() {
    if (typeof global.innerWidth !== 'number') return false;
    return global.innerWidth <= 768;
  }
  function dprOf(o) {
    var mob = isMobile();
    var cap = num(o && o.dprCap, mob ? 1.5 : 2);
    var dpr = num(global.devicePixelRatio, 1);
    return clamp(Math.min(dpr, cap), 0.5, 4);
  }
  /* The clock. Missing is zero, like VoyageArt; NaN or Infinity is null,
     which makes the entry point return false rather than draw a frozen orb
     at a substituted time. Reduced motion pins it at zero. */
  function timeOf(t, reduced) {
    if (t === undefined || t === null) return 0;
    if (typeof t !== 'number' || !isFinite(t)) return null;
    return reduced ? 0 : t;
  }

  function reducedMotion() {
    try {
      if (global.matchMedia) {
        return !!global.matchMedia('(prefers-reduced-motion: reduce)').matches;
      }
    } catch (e) { /* no matchMedia: treat as motion allowed */ }
    return false;
  }

  /* ==========================================================================
     SHADERS
     ========================================================================== */

  var VERT = [
    'attribute vec2 aPos;',
    'varying vec2 vP;',
    'uniform float uK;',
    'void main() {',
    /* +y down, so the blitted image lands in canvas orientation */
    '  vP = vec2(aPos.x, -aPos.y) * uK;',
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}'
  ].join('\n');

  var PRESENT_VERT = [
    'attribute vec2 aPos;',
    'varying vec2 vT;',
    'uniform vec4 uSrc;',
    'void main() {',
    '  vT = uSrc.xy + (aPos * 0.5 + 0.5) * uSrc.zw;',
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}'
  ].join('\n');

  var PRESENT_FRAG = [
    'precision mediump float;',
    'varying vec2 vT;',
    'uniform sampler2D uTex;',
    'void main() { gl_FragColor = texture2D(uTex, vT); }'
  ].join('\n');

  /* The precision block and the lattice wrap are pinned: the hash inputs
     are rescaled (the lattice index is wrapped at PW, 64 under mediump) so
     |p| stays small before the sin, which is the documented mitigation for
     banding and repeat artifacts on low-end mobile GPUs.

     The wrapped index is then divided by PW, so what reaches sin() is in
     [0, 513) rather than [0, 131000). That last step is not optional and it
     is not a mobile-only concern: a GPU's sin() has a finite range
     reduction, and at 1e5 it returns wide horizontal streaks instead of
     noise. It was visible on desktop Chromium as a smeared, banded disc,
     and it is why the rescale is applied under highp too. */
  var COMMON = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#define PW 256.0',
    '#define INV_PW 0.00390625',
    '#else',
    'precision mediump float;',
    '#define PW 64.0',
    '#define INV_PW 0.015625',
    '#endif',
    '#define LAC 2.02',
    '#define GAIN 0.50',
    '#define TAU 6.283185307179586',
    'varying vec2 vP;',
    '',
    'float hash3(vec3 p) {',
    '  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);',
    '}',
    'float value3(vec3 p) {',
    '  vec3 i = floor(p);',
    '  vec3 f = p - i;',
    '  f = f * f * (3.0 - 2.0 * f);',
    '  vec3 a = mod(i, PW) * INV_PW;',
    '  vec3 b = mod(i + 1.0, PW) * INV_PW;',
    '  float n000 = hash3(vec3(a.x, a.y, a.z));',
    '  float n100 = hash3(vec3(b.x, a.y, a.z));',
    '  float n010 = hash3(vec3(a.x, b.y, a.z));',
    '  float n110 = hash3(vec3(b.x, b.y, a.z));',
    '  float n001 = hash3(vec3(a.x, a.y, b.z));',
    '  float n101 = hash3(vec3(b.x, a.y, b.z));',
    '  float n011 = hash3(vec3(a.x, b.y, b.z));',
    '  float n111 = hash3(vec3(b.x, b.y, b.z));',
    '  float x00 = mix(n000, n100, f.x);',
    '  float x10 = mix(n010, n110, f.x);',
    '  float x01 = mix(n001, n101, f.x);',
    '  float x11 = mix(n011, n111, f.x);',
    '  return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);',
    '}',
    /* An octave whose lattice cell has shrunk under about two device pixels
       is replaced by its own mean instead of being sampled. The sum keeps
       the pinned scale exactly (mix(0.5, v, 1.0) == v), so wherever the
       detail is resolvable this is the pinned recipe verbatim; where it is
       not, the sub-pixel fizz that would otherwise alias into grain is gone
       and the orb simply gets smoother as it gets smaller. */
    'float oFade(float fpx) { return smoothstep(1.1, 2.4, fpx); }',
    'float fbm2(vec3 p, float fpx) {',
    '  float s = 0.0, a = 1.0, sc = 1.0;',
    '  for (int i = 0; i < 2; i++) {',
    '    s += a * mix(0.5, value3(p * sc), oFade(fpx / sc));',
    '    a *= GAIN; sc *= LAC;',
    '  }',
    '  return s;',
    '}',
    'float fbm3(vec3 p, float fpx) {',
    '  float s = 0.0, a = 1.0, sc = 1.0;',
    '  for (int i = 0; i < 3; i++) {',
    '    s += a * mix(0.5, value3(p * sc), oFade(fpx / sc));',
    '    a *= GAIN; sc *= LAC;',
    '  }',
    '  return s;',
    '}',
    'float fbmM(vec3 p, float fpx) {',
    '  float s = 0.0, a = 1.0, sc = 1.0;',
    '  for (int i = 0; i < OCT; i++) {',
    '    s += a * mix(0.5, value3(p * sc), oFade(fpx / sc));',
    '    a *= GAIN; sc *= LAC;',
    '  }',
    '  return s;',
    '}',
    '#define N2 1.5',
    '#define N3 1.75',
    'vec3 spherePt(float lon, float sLat) {',
    '  float cLat = sqrt(max(0.0, 1.0 - sLat * sLat));',
    '  return vec3(cLat * cos(lon), sLat, cLat * sin(lon));',
    '}',
    'float wrapPi(float a) {',
    '  return a - TAU * floor((a + 3.14159265358979) / TAU);',
    '}'
  ].join('\n');

  /* ---- the star ----
     Everything here is drawn from starLook + flareUniforms. The corona and
     the flare bloom are deliberately absent: VoyageArt draws those around
     the blit so the two paths cannot drift apart. */
  var FRAG_STAR = [
    COMMON,
    'uniform vec3 uHot, uCool, uLimb, uProm, uSeedOff;',
    'uniform vec4 uSpots[5];',   /* u, sinLat, cos(angular radius), amp */
    'uniform vec4 uFlare[6];',   /* amp, angle, span, height             */
    'uniform vec4 uGeom;',       /* rDevPx, pixel, spin, tSec            */
    'uniform vec4 uMisc;',       /* limbExp, activity, bright, frequency */
    'uniform float uSpotN;',
    '',
    /* the limb profile is the shipped 2D gradient, stop for stop, so the
       same limbExp scalar darkens the same way in both renderers */
    'float ldProfile(float s) {',
    '  if (s < 0.55) return mix(0.0, 0.16, s / 0.55);',
    '  if (s < 0.82) return mix(0.16, 0.50, (s - 0.55) / 0.27);',
    '  if (s < 0.96) return mix(0.50, 0.92, (s - 0.82) / 0.14);',
    '  return mix(0.92, 1.0, (s - 0.96) / 0.04);',
    '}',
    '',
    'void main() {',
    '  float rdev = uGeom.x, pix = uGeom.y, spin = uGeom.z, tt = uGeom.w;',
    '  float ldExp = uMisc.x, act = uMisc.y, bright = uMisc.z, freq = uMisc.w;',
    '  vec2 P = vP;',
    '  float d = length(P);',
    /* the quad's corners fall outside the footprint circle: a fifth of the
       target, and nothing is ever drawn there */
    '  if (d > 1.60) { gl_FragColor = vec4(0.0); return; }',
    '  float aa = max(pix * 0.9, 0.0015);',
    '  float disc = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);',
    '  vec3 col = vec3(0.0);',
    '',
    '  if (disc > 0.002) {',
    '    vec2 q = (d > 0.99998) ? P * (0.99998 / d) : P;',
    '    float nz = sqrt(max(1e-6, 1.0 - dot(q, q)));',
    '    float sLat = -q.y;',
    '    float lon0 = atan(q.x, nz) + spin;',
    '    vec3 sp0 = spherePt(lon0, sLat);',
    /* large-scale magnetic shear: a low frequency field plus a
       latitude-dependent differential rotation twist the granulation
       domain, which is what makes the surface read as churning rather
       than as a noise texture pasted on a ball */
    '    float sw = 0.0;',
    /* a radiative envelope has no solar-type convection to shear: below the
       activity floor none of the surface noise is worth evaluating, and the
       star comes out as the smooth disc it should be */
    '    if (act > 0.05) {',
    '      float fLow = freq * 0.020;',
    '      sw = fbm3(sp0 * fLow + uSeedOff, rdev / fLow) / N3 - 0.5;',
    '    }',
    /* No differential-rotation term here. It is real, but it winds up
       without bound, and tSec is page uptime: after ten minutes a
       latitude-proportional shear has torn the surface into bands. The
       twist comes from the low frequency shear field instead, which is
       bounded by construction. */
    '    float lon = lon0 + sw * 0.30 * act;',
    '    vec3 sph = spherePt(lon, sLat);',
    '',
    /* --- the pinned granulation recipe --- */
    '    vec3 p = sph * freq + uSeedOff;',
    '    p.z += tt * 0.035;',
    '    float fpx = rdev / freq;',
    '    vec3 qw = p;',
    '    float g = 0.5, gCell = 0.5, gMid = 0.5;',
    '    if (act > 0.05) {',
    '      float w1 = ' + WARP1_AMP.toFixed(4) + ' * act;',
    '      qw = p + w1 * vec3(fbm3(p, fpx),',
    '                         fbm3(p + vec3(5.2, 1.3, 9.1), fpx),',
    '                         fbm3(p + vec3(1.7, 9.2, 3.4), fpx));',
    '      float w2 = ' + WARP2_AMP.toFixed(4) + ' * act;',
    '      float f2 = fpx / 2.1;',
    '      qw = qw + w2 * vec3(fbm2(qw * 2.1 + vec3(2.8, 7.1, 4.3), f2),',
    '                          fbm2(qw * 2.1 + vec3(8.3, 2.9, 1.1), f2),',
    '                          fbm2(qw * 2.1 + vec3(4.4, 5.6, 7.7), f2));',
    '      g = fbmM(qw, fpx) / FBM_NORM;',
    '      float fCell = freq * 0.14;',
    '      float fMid = freq * 0.45;',
    '      vec3 pCell = sph * fCell + uSeedOff * 1.7; pCell.z += tt * 0.006;',
    '      vec3 pMid = sph * fMid + uSeedOff * 2.6; pMid.z += tt * 0.018;',
    '      gCell = fbm3(pCell, rdev / fCell) / N3;',
    '      gMid = fbm3(pMid, rdev / fMid) / N3;',
    '    }',
    '',
    /* Three bands of the same machinery. The pinned recipe is the finest
       one; two lower bands carry the cell network the eye actually reads as
       a boiling surface. Every band fades out on its own as the orb
       shrinks, so a small orb goes smooth instead of turning into scribble. */
    /* each band is squashed so that most of its area is a broad bright cell
       and only the deepest minima survive as narrow darker lanes, which is
       the shape of a granulation network; the whole deviation is scaled by
       the activity row, so a hot star's disc stays flat */
    /* the pinned fine layer IS the granulation and carries most of the
       contrast; the two lower bands are slow mottling and the bright
       faculae network, all of it scaled by the activity row so a hot star's
       disc stays flat */
    '    float facula = pow(smoothstep(0.60, 0.92, gCell), 2.0);',
    /* faculae stand out near the limb, where you look along the hot walls
       of the magnetic flux tubes rather than down into them */
    '    facula *= 0.55 + 0.85 * smoothstep(0.45, 0.97, d);',
    '    float b = 1.0 + (gCell - 0.5) * 0.14 * act',
    '                  + (gMid - 0.5) * 0.24 * act',
    '                  + (g - 0.5) * 0.20 * act',
    '                  + pow(smoothstep(0.56, 0.86, g), 2.0) * 0.10 * act',
    '                  + facula * 0.11 * act;',
    '    float lane = pow(clamp((0.50 - gMid) / 0.50, 0.0, 1.0), 1.3) * act',
    '               + pow(clamp((0.42 - g) / 0.42, 0.0, 1.0), 2.2) * act * 0.35;',
    /* Exposure. The palette's hot tone is already at the top of the range,
       so painting the disc at full strength clips the red channel first and
       every granule boundary turns into a hard white contour. Sitting the
       surface at 0.78 leaves headroom for the hot core, the faculae and the
       flare brightening, and it is the difference between a marbled ball
       and a photosphere. A quiet star has no granulation contrast to
       protect, so it keeps nearly all of its brightness. */
    '    col = mix(uHot * b, uCool * 0.58, clamp(lane * 0.85, 0.0, 1.0))',
    '        * mix(0.93, 0.78, act);',
    '',
    /* starspots: the same angular-distance test the 2D strip runs, on the
       same seeded layout, so a star's spots sit where they always sat */
    '    float dark = 0.0;',
    '    float cLat = sqrt(max(0.0, 1.0 - sLat * sLat));',
    '    for (int k = 0; k < 5; k++) {',
    '      if (float(k) < uSpotN) {',
    '        vec4 S = uSpots[k];',
    '        float cosd = sLat * S.y',
    '          + cLat * sqrt(max(0.0, 1.0 - S.y * S.y)) * cos(lon - S.x * TAU);',
    '        if (cosd > S.z) {',
    '          float f = (cosd - S.z) / max(1e-6, 1.0 - S.z);',
    '          float dd = S.w * (0.45 * smoothstep(0.0, 1.0, clamp(f * 1.6, 0.0, 1.0))',
    '                          + 0.55 * smoothstep(0.0, 1.0, clamp((f - 0.35) / 0.65, 0.0, 1.0)));',
    '          dark = max(dark, dd);',
    '        }',
    '      }',
    '    }',
    /* the granulation field frays the spot edge into something closer to a
       penumbra than a painted ellipse */
    '    dark *= 0.80 + 0.40 * g;',
    '    float sm = smoothstep(0.0, 0.03, dark);',
    '    col = mix(col, (1.0 - dark) * mix(col, uCool, 0.55), sm);',
    /* faculae: the bright network that rings a real spot group */
    '    float plage = smoothstep(0.02, 0.30, dark) * (1.0 - smoothstep(0.30, 0.85, dark));',
    '    col *= 1.0 + 0.12 * plage * act;',
    '',
    '    float s = clamp((d - 0.10) / 0.90, 0.0, 1.0);',
    '    col = mix(col, uLimb, clamp(ldProfile(s) * ldExp, 0.0, 1.0));',
    '',
    /* the hot core. The 2D pass paints this at 0.30 over a texture that is
       already washed out by its own blur; per fragment that much additive
       white erases the granulation across the middle third of the disc, so
       it is carried at a little over half strength here and the corona
       (unchanged, VoyageArt's) does the rest of the glow. */
    '    float hd = length(P - vec2(-0.12, -0.12)) / 0.92;',
    '    if (hd < 1.0) {',
    '      float ha = (hd < 0.5) ? mix(0.17, 0.05, hd / 0.5)',
    '                            : mix(0.05, 0.0, (hd - 0.5) / 0.5);',
    '      col += vec3(1.0, 0.980, 0.930) * (ha * bright);',
    '    }',
    '  }',
    '',
    /* --- emission: chromosphere, spicules, prominences --- */
    '  vec3 emit = vec3(0.0);',
    '  float th = atan(P.y, P.x);',
    /* an annulus starting AT the limb and fading outward, never a stroke
       sitting on the disc: a bright ring inside the edge reads as an
       outline and contradicts the limb darkening under it */
    '  if (d > 0.94) {',
    '    float ck = clamp((d - 1.0) / 0.20, 0.0, 1.0);',
    '    float ca = (ck < 0.35) ? mix(0.26, 0.12, ck / 0.35)',
    '                           : mix(0.12, 0.0, (ck - 0.35) / 0.65);',
    '    float spF = 26.0 + 40.0 * act;',
    '    float spN = fbm2(vec3(cos(th), sin(th), tt * 0.05) * spF + uSeedOff,',
    '                     rdev / spF) / N2;',
    '    ca *= (0.80 + 0.40 * spN) * (1.0 - disc);',
    '    emit += uProm * ca;',
    '  }',
    '  float anyF = uFlare[0].x + uFlare[1].x + uFlare[2].x',
    '             + uFlare[3].x + uFlare[4].x + uFlare[5].x;',
    '  float turb = 0.0;',
    '  if (anyF > 0.02) {',
    '    turb = fbm2(vec3(cos(th) * 2.0, sin(th) * 2.0, tt * 0.08) * 3.0',
    '                + uSeedOff * 0.5, rdev * 0.3) / N2 - 0.5;',
    '  }',
    '  for (int k = 0; k < 6; k++) {',
    '    vec4 F = uFlare[k];',
    '    if (F.x > 0.02) {',
    '      float sN = wrapPi(th - F.y) / max(0.02, F.z);',
    '      if (abs(sN) < 1.35) {',
    '        float h = F.w * F.x;',
    '        float arch = 1.0 - sN * sN;',
    '        float R = 1.0 + h * arch * (1.0 + 0.42 * turb);',
    '        float dist = abs(d - R);',
    '        float foot = smoothstep(1.35, 0.95, abs(sN));',
    /* the loop is thinner where the same turbulence pinches it, so the
       strands read as plasma rather than as tubing */
    '        float wob = 1.0 / (1.0 + 0.75 * turb * turb + 0.55 * turb);',
    '        float core = exp(-dist * dist * wob / 0.00151);',
    '        float sh = exp(-dist * dist * wob / 0.00673);',
    '        emit += uProm * ((core * 0.75 + sh * 0.28) * F.x * foot);',
    '      }',
    '    }',
    '  }',
    '',
    /* Premultiplied output with alpha = COVERAGE ONLY. Emission (the
       chromosphere, the prominences, the atmosphere ring, the emissive
       halo) carries colour with no alpha, so source-over evaluates to
       dst + emit: additive, exactly like the 2D passes it replaces.
       Giving that light an alpha instead multiplies the corona underneath
       by (1 - a) and leaves a dark ring at the limb. */
    '  float a = clamp(disc, 0.0, 1.0);',
    '  vec3 pm = clamp(col * disc + emit, 0.0, 1.0);',
    '  gl_FragColor = vec4(pm, a);',
    '}'
  ].join('\n');

  /* ---- planets and exoplanets ----
     The band / continent / crust recipes are ports of the ones VoyageArt
     bakes into its texture strips, evaluated per fragment instead of per
     texel, so the palette and the shape language are the same world at any
     zoom. Rings are NOT here: they stay with VoyageArt's ring split, which
     owns the occlusion order. */
  var FRAG_PLANET = [
    COMMON,
    'uniform vec3 uPal[5];',
    'uniform vec3 uNight, uAtmC, uEmisC, uTint, uSpotC, uSeedOff, uLight;',
    'uniform vec4 uSpot;',    /* lon, sinLat, w, h                          */
    'uniform vec4 uFlagA;',   /* banded, watery, emissive, eyeball          */
    'uniform vec4 uFlagB;',   /* clouds, poles, paletteCount, atmosphere    */
    'uniform vec4 uGeom;',    /* rDevPx, pixel, spin, tSec                  */
    'uniform vec4 uFreq;',    /* freqA, freqB, freqPole, seaLevel           */
    'uniform vec4 uMisc;',    /* maxDark, typeId, bands, craterCount        */
    '',
    'float sstep(float x) { return smoothstep(0.0, 1.0, clamp(x, 0.0, 1.0)); }',
    '',
    /* craters, stamped in the same (longitude, sin latitude) strip the 2D
       texture uses, so the profile and the distortion both match */
    'float craterField(vec2 uv, float count, float fpx) {',
    '  float gx = max(2.0, floor(sqrt(count * 2.0) + 0.5));',
    '  vec2 g = vec2(gx, max(1.0, floor(gx * 0.5 + 0.5)));',
    '  vec2 pp = uv * g;',
    '  vec2 ip = floor(pp);',
    '  float acc = 0.0;',
    '  for (int oy = -1; oy <= 1; oy++) {',
    '    for (int ox = -1; ox <= 1; ox++) {',
    '      vec2 cell = ip + vec2(float(ox), float(oy));',
    '      vec2 wc = vec2(mod(cell.x, gx), cell.y);',
    '      float h1 = hash3(vec3(wc, 1.7));',
    '      float h2 = hash3(vec3(wc, 5.3));',
    '      float h3 = hash3(vec3(wc, 9.1));',
    '      vec2 c = cell + vec2(0.16 + h1 * 0.68, 0.16 + h2 * 0.68);',
    '      float rad = 0.14 + h3 * h3 * h3 * 0.66;',
    /* the strip is 2:1, and the 2D stamp is `rad` wide by 0.92 rad tall in
       strip fractions, so in cell space the vertical half-axis is 0.46 */
    '      vec2 dp = pp - c;',
    '      vec2 dv = vec2(dp.x, dp.y / 0.46) / max(0.02, rad);',
    '      float dd = length(dv);',
    '      if (dd < 1.0) {',
    '        float f;',
    '        if (dd < 0.70) f = -0.20 * (1.0 - dd / 0.70) - 0.05;',
    '        else if (dd < 0.92) f = 0.22 * sstep((dd - 0.70) / 0.22);',
    '        else f = 0.22 * (1.0 - sstep((dd - 0.92) / 0.08)) - 0.04;',
    /* a crater narrower than a couple of device pixels fades out instead of
       turning into speckle */
    '        acc += (f - 0.05 * dv.y) * smoothstep(1.0, 3.0, 4.0 * fpx * rad / gx);',
    '      }',
    '    }',
    '  }',
    '  return acc;',
    '}',
    '',
    'void main() {',
    '  float rdev = uGeom.x, pix = uGeom.y, spin = uGeom.z, tt = uGeom.w;',
    '  float banded = uFlagA.x, watery = uFlagA.y, emissive = uFlagA.z, eyeball = uFlagA.w;',
    '  float clouds = uFlagB.x, poles = uFlagB.y, palN = uFlagB.z, atmos = uFlagB.w;',
    '  float maxDark = uMisc.x, T = uMisc.y, nb = uMisc.z, craters = uMisc.w;',
    '  vec2 P = vP;',
    '  float d = length(P);',
    '  if (d > 1.60) { gl_FragColor = vec4(0.0); return; }',
    '  float aa = max(pix * 0.9, 0.0015);',
    '  float disc = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);',
    '  vec3 col = vec3(0.0);',
    '  vec3 emit = vec3(0.0);',
    '',
    '  if (disc > 0.002) {',
    '    vec2 q = (d > 0.99998) ? P * (0.99998 / d) : P;',
    '    float nz = sqrt(max(1e-6, 1.0 - dot(q, q)));',
    '    vec3 n = vec3(q.x, q.y, nz);',
    '    float sLat = -q.y;',
    '    float absL = abs(sLat);',
    '    float lon = atan(q.x, nz) + spin;',
    '    float u = fract(lon / TAU);',
    '    vec3 sph = spherePt(lon, sLat);',
    '    float fA = uFreq.x, fB = uFreq.y, fP = uFreq.z, sea0 = uFreq.w;',
    '    vec3 sA = sph * fA + uSeedOff;',
    '    vec3 sB = sph * fB + uSeedOff * 1.31;',
    '    float pxA = rdev / fA, pxB = rdev / fB;',
    /* Solid surfaces get a domain warp before the height field is summed.
       Plain fBm makes round blobs; the warp is what turns them into
       coastlines with bays and peninsulas, and it is the same two-level
       trick the star surface uses. Gas giants skip it: their shapes come
       from the zonal flow instead. */
    '    vec3 sAw = sA;',
    '    if (banded < 0.5) {',
    '      float wpx = pxA / 1.7;',
    '      sAw = sA + 0.30 * vec3(fbm2(sA * 1.7, wpx),',
    '                             fbm2(sA * 1.7 + vec3(5.2, 1.3, 9.1), wpx),',
    '                             fbm2(sA * 1.7 + vec3(1.7, 9.2, 3.4), wpx));',
    '    }',
    '    vec3 c = uPal[0];',
    '    float glowF = 0.0;',
    '    vec3 glowC = vec3(0.0);',
    '',
    '    if (banded > 0.5) {',
    /* zonal flow: latitude bands warped by a wrapping noise field, so the
       band edges curl the way real jets do */
    '      vec3 sJ = sA; sJ.z += tt * 0.004;',
    '      float warp = fbm3(sJ, pxA) / N3 - 0.5;',
    '      float fine = fbm2(sB, pxB) / N2;',
    /* eddies: the jets curl where the finer field pushes them, so the band
       edges break up instead of reading as painted stripes */
    '      float curl = fbm2(sB * 0.45 + vec3(11.3, 4.7, 2.9), pxB / 0.45) / N2 - 0.5;',
    /* zonal turbulence: the noise domain is squashed in latitude, so the
       filaments it makes stretch along the jets the way real belt and zone
       structure does, and the band edges grow ragged at every scale */
    '      vec3 sZ = vec3(sph.x, sph.y * 3.2, sph.z);',
    '      float turb = fbm3(sZ * (fB * 2.2) + uSeedOff * 1.9, pxB / 2.2) / N3 - 0.5;',
    '      float sv = 0.5 + 0.5 * sin((sLat * nb + warp * 1.5 + curl * 0.5 + turb * 0.85) * 3.14159265);',
    '      float fs = sstep(sv);',
    '      float f2 = sstep((sv - 0.72) / 0.28) * 0.7;',
    '      float shade = (T > 5.5 && T < 6.5) ? (0.98 + fine * 0.04) : (0.93 + fine * 0.14);',
    '      shade *= 0.95 + 0.10 * (fbm2(sZ * (fB * 5.3) + uSeedOff * 3.1, pxB / 5.3) / N2);',
    '      vec3 c1 = mix(uPal[1], uPal[0], fs);',
    '      c = mix(c1, uPal[2], f2) * shade;',
    '      if (palN > 3.5) {',
    '        c = mix(c, uPal[3], sstep((0.30 - sv) / 0.30) * 0.5);',
    '      }',
    '      if (uSpot.z > 0.0) {',
    '        float du = u - uSpot.x; du -= floor(du + 0.5);',
    '        float dv2 = (sLat - uSpot.y);',
    '        float od = sqrt((du / uSpot.z) * (du / uSpot.z) + (dv2 / uSpot.w) * (dv2 / uSpot.w));',
    '        if (od < 1.25) {',
    '          float ov = 1.0 - sstep((od - 0.45) / 0.80);',
    '          float swirl = 0.85 + 0.3 * (fbm2(sB * 9.0, pxB / 9.0) / N2);',
    /* the storm turns inside its own oval */
    '          c = mix(c, uSpotC * swirl, ov);',
    '        }',
    '      }',
    '      if (absL > 0.86) {',
    '        float pf = sstep((absL - 0.86) / 0.14) * 0.35;',
    '        c -= c * vec3(0.18, 0.16, 0.10) * pf;',
    '      }',
    '    } else if (T > 0.5 && T < 1.5) {',
    /* venus: the V, streaks sheared toward the poles */
    '      float bias = 0.55 * pow(absL, 1.5) * (sLat >= 0.0 ? 1.0 : -1.0);',
    '      vec3 sh1 = spherePt(lon + bias * TAU, sLat) * fA + uSeedOff;',
    '      vec3 sh2 = spherePt(lon + bias * TAU, sLat) * fB + uSeedOff * 1.31;',
    '      float st = fbm3(sh1, pxA) / N3;',
    '      float st2 = fbm2(sh2, pxB) / N2;',
    '      float vsh = 0.94 + st * 0.09 + st2 * 0.04;',
    '      float vf = sstep(st * 1.2);',
    '      float vg = sstep((absL - 0.55) / 0.45) * 0.5;',
    '      vec3 v1 = mix(uPal[1], uPal[0], vf);',
    '      c = mix(v1, uPal[2], vg) * vsh;',
    '    } else if (watery > 0.5) {',
    '      float e = fbmM(sAw, pxA) / FBM_NORM;',
    '      float det = fbmM(sB, pxB) / FBM_NORM;',
    '      e = e * 0.82 + det * 0.18;',
    '      float sea = sea0;',
    '      float sub = 0.0;',
    '      if (eyeball > 0.5) {',
    /* tidally locked: open water only around the substellar point */
    '        float dl = u - 0.5; dl -= floor(dl + 0.5);',
    '        sub = sqrt(dl * dl * 3.4 + sLat * sLat * 0.85);',
    '        sea = 0.515 + sstep((sub - 0.16) / 0.34) * 0.42;',
    '      }',
    '      if (e < sea) {',
    '        c = mix(uPal[1], uPal[0], sstep((sea - e) / 0.22));',
    /* a wet world catches the star: a narrow specular lobe on the ocean */
    '        vec3 hv = normalize(uLight + vec3(0.0, 0.0, 1.0));',
    '        float spec = pow(max(0.0, dot(n, hv)), 90.0) * 0.30',
    '                   * smoothstep(0.0, 0.30, dot(n, uLight));',
    '        c += vec3(1.0, 0.99, 0.95) * spec;',
    '      } else {',
    '        float h = sstep((e - sea) / 0.30);',
    '        float hl = sstep((h - 0.30) / 0.55);',
    '        vec3 lc = mix(uPal[2], uPal[3], (palN > 3.5) ? hl : 0.0);',
    '        if (h > 0.72 && palN > 4.5) {',
    '          lc = mix(lc, uPal[4], sstep((h - 0.72) / 0.28) * 0.8);',
    '        }',
    '        c = lc * (0.90 + det * 0.20);',
    '      }',
    '      if (eyeball > 0.5) {',
    '        c = mix(c, vec3(0.886, 0.925, 0.965), sstep((sub - 0.30) / 0.26));',
    '      }',
    '    } else if (T > 2.5 && T < 3.5) {',
    /* mars */
    '      float mv = fbmM(sAw, pxA) / FBM_NORM;',
    '      float mdn = fbmM(sB, pxB) / FBM_NORM;',
    '      c = mix(uPal[0], uPal[1], sstep((0.52 - mv) / 0.30)) * (0.90 + mdn * 0.22);',
    '    } else if (T > 12.5 && T < 13.5) {',
    /* ice: a ridged fracture network over a mottled crust */
    '      float rv = fbmM(sAw, pxA) / FBM_NORM;',
    '      float fis = 1.0 - abs(2.0 * rv - 1.0);',
    '      float iv = sstep(fbm2(sB, pxB) / N2);',
    '      vec3 ic = mix(uPal[0], uPal[2], iv);',
    '      c = mix(ic, uPal[1], sstep((fis - 0.62) / 0.24) * 0.85);',
    '    } else if (T > 7.5 && T < 8.5) {',
    /* lava: dark crust cracked open over the glow */
    '      float rv = fbmM(sAw, pxA) / FBM_NORM;',
    '      float cr = 1.0 - abs(2.0 * rv - 1.0);',
    '      float cru = sstep(fbm2(sB, pxB) / N2);',
    '      float hotf = sstep((cr - 0.70) / 0.26);',
    '      float hf2 = sstep((cr - 0.86) / 0.14);',
    '      vec3 hc = mix(uPal[2], (palN > 3.5) ? uPal[3] : uPal[2], hf2);',
    '      vec3 kc = mix(uPal[0], uPal[1], cru);',
    '      c = mix(kc, hc, hotf);',
    '      glowF = hotf; glowC = hc;',
    '    } else {',
    /* mercury and the generic rock */
    '      float rv = fbmM(sAw, pxA) / FBM_NORM;',
    '      float rd = fbm2(sB, pxB) / N2;',
    '      vec3 rc = mix(uPal[1], uPal[0], sstep(rv));',
    '      c = mix(rc, uPal[2], sstep((rv - 0.70) / 0.30) * 0.6) * (0.88 + rd * 0.26);',
    '    }',
    '',
    '    if (craters > 0.5) {',
    '      c *= 1.0 + craterField(vec2(u, 0.5 - sLat * 0.5), craters, rdev);',
    '    }',
    '    if (poles > 0.5 && absL > 0.80) {',
    '      float cap = sstep((absL - 0.80) / 0.15) *',
    '                  (0.55 + (fbm2(sph * fP + uSeedOff * 2.9, rdev / fP) / N2) * 0.7);',
    '      c = mix(c, vec3(0.973, 0.980, 0.988), clamp(cap, 0.0, 1.0));',
    '    }',
    '    if (uTint.x >= 0.0) {',
    '      c = mix(c, c * uTint, 0.45);',
    '    }',
    '    if (clouds > 0.5) {',
    '      vec3 cp = vec3(sph.x, sph.y * 0.84, sph.z);',
    /* The deck runs at a higher base frequency than the 2D strip's. On a
       unit sphere the lowest octave of a 1.1-frequency field is nearly one
       blob, so whether a world came out overcast or clear was down to the
       seed; at 2.4 there are enough cells for the coverage to be stable. */
    '      float cN = fbmM(cp * 2.4 + uSeedOff * 2.3 + vec3(tt * 0.006, 0.0, 0.0), rdev / 2.4) / FBM_NORM;',
    '      float dN = fbm2(cp * 6.2 + uSeedOff * 3.7, rdev / 6.2) / N2;',
    '      float v = cN * 0.72 + dN * 0.28 + 0.06 * sin(sLat * 3.14159265 * 3.2);',
    '      float ca = sstep((v - 0.52) / 0.17) * (0.86 - 0.30 * abs(sLat * sLat * sLat));',
    '      c = mix(c, vec3(0.980, 0.988, 1.0), clamp(ca, 0.0, 1.0) * 0.92);',
    '    }',
    '',
    /* day / night. shadeSphere approximates this with a radial gradient;
       per fragment it is just the Lambert term, with the same darkness cap */
    '    float lam = clamp(dot(n, uLight), 0.0, 1.0);',
    '    col = mix(c, uNight, clamp(1.0 - lam, 0.0, 1.0) * maxDark);',
    '    if (emissive > 0.5) {',
    '      col += glowC * (glowF * 0.90);',
    '    }',
    '  }',
    '',
    '  if (atmos > 0.5) {',
    '    float ak = clamp((d - 0.90) / 0.22, 0.0, 1.0);',
    '    float av = (ak < 0.55) ? mix(0.0, 0.18, ak / 0.55) : mix(0.18, 0.0, (ak - 0.55) / 0.45);',
    '    float th = atan(P.y, P.x);',
    '    float dth = wrapPi(th - atan(uLight.y, uLight.x));',
    /* an atmosphere is lit, not self-luminous: the ring dims around the
       night limb instead of ringing the whole planet in grey fog */
    '    av *= 0.20 + 0.80 * (0.5 + 0.5 * cos(dth));',
    '    if (abs(dth) < 1.25) {',
    '      float e = (d - 0.985) / 0.0185;',
    '      av += 0.30 * exp(-e * e) * (1.0 - smoothstep(0.9, 1.25, abs(dth)));',
    '    }',
    '    emit += uAtmC * av;',
    '  }',
    '  if (uFlagA.z > 0.5) {',
    /* the warm halo an emissive world keeps on its night side. The 2D pass
       runs to 1.7r; the shader footprint stops at 1.55r, inside K_GL. */
    '    float ek = clamp((d - 0.85) / 0.70, 0.0, 1.0);',
    '    emit += uEmisC * (0.22 * (1.0 - ek));',
    '  }',
    '',
    /* Premultiplied output with alpha = COVERAGE ONLY. Emission (the
       chromosphere, the prominences, the atmosphere ring, the emissive
       halo) carries colour with no alpha, so source-over evaluates to
       dst + emit: additive, exactly like the 2D passes it replaces.
       Giving that light an alpha instead multiplies the corona underneath
       by (1 - a) and leaves a dark ring at the limb. */
    '  float a = clamp(disc, 0.0, 1.0);',
    '  vec3 pm = clamp(col * disc + emit, 0.0, 1.0);',
    '  gl_FragColor = vec4(pm, a);',
    '}'
  ].join('\n');

  /* ==========================================================================
     GL STATE
     ========================================================================== */

  var st = {
    tried: false,
    ok: false,
    dead: false,          /* a compile failure is permanent for the session */
    disabled: false,
    lost: false,
    reason: 'not-initialised',
    gl: null,
    canvas: null,
    target: 0,
    oct: OCT_HI,
    quad: null,
    fbo: null,
    fboTex: null,
    present: null,
    progs: {},
    blits: 0,
    renders: 0,
    frameT: NaN,
    idle: 0,
    timer: 0,
    slots: null,
    cache2d: [],
    handlers: null,
    par: null,            /* KHR_parallel_shader_compile, when the driver has it */
    hold: 0               /* while > 0 the idle timer may not dispose */
  };

  function GLATTRS() {
    return {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power'
    };
  }

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      st.reason = 'shader: ' + String(gl.getShaderInfoLog(sh) || '').slice(0, 160);
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  /* ONE rule about reading a link result, and it cost a three second freeze
     to learn: gl.getProgramParameter(p, LINK_STATUS) BLOCKS the main thread
     until the driver has finished translating the program. On ANGLE/D3D11
     the procedural orb shader takes seconds to translate, and because the
     orb programs compile on first use, that block landed INSIDE the cruise
     (measured: 3.3 s in one frame, which then threw the ship 115 px across
     the screen when the clock caught up).

     So when the driver exposes KHR_parallel_shader_compile the link is left
     PENDING: every frame asks the non-blocking COMPLETION_STATUS_KHR, and
     until it answers true the caller simply draws VoyageArt's 2D orb, which
     is the same fallback a machine without WebGL gets. Only once the driver
     says it is done is LINK_STATUS read, and by then it is free.
     Without the extension the old blocking check stands. */
  function link(gl, vsSrc, fsSrc, async) {
    var vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
    if (!vs) return null;
    var fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    if (!fs) { gl.deleteShader(vs); return null; }
    var pr = gl.createProgram();
    if (!pr) { gl.deleteShader(vs); gl.deleteShader(fs); return null; }
    gl.attachShader(pr, vs);
    gl.attachShader(pr, fs);
    gl.bindAttribLocation(pr, 0, 'aPos');
    gl.linkProgram(pr);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (async && st.par) return { p: pr, u: {}, pending: true };
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) {
      st.reason = 'link: ' + String(gl.getProgramInfoLog(pr) || '').slice(0, 160);
      gl.deleteProgram(pr);
      return null;
    }
    return { p: pr, u: {} };
  }

  /* false while the driver is still translating; never blocks */
  function progReady(prog) {
    if (!prog) return false;
    if (!prog.pending) return true;
    var gl = st.gl;
    if (!gl) return false;
    if (st.par && !gl.getProgramParameter(prog.p, st.par.COMPLETION_STATUS_KHR)) return false;
    if (!gl.getProgramParameter(prog.p, gl.LINK_STATUS)) {
      st.reason = 'link: ' + String(gl.getProgramInfoLog(prog.p) || '').slice(0, 160);
      gl.deleteProgram(prog.p);
      prog.p = null;
      st.dead = true;
      st.ok = false;
      return false;
    }
    prog.pending = false;
    return true;
  }

  function uloc(prog, name) {
    if (!Object.prototype.hasOwnProperty.call(prog.u, name)) {
      prog.u[name] = st.gl.getUniformLocation(prog.p, name);
    }
    return prog.u[name];
  }

  /* The orb programs compile on first use so a session that never opens a
     close-up never pays for them. */
  function orbProgram(kind, oct) {
    var key = kind + oct;
    var have = st.progs[key];
    if (have) return progReady(have) ? have : null;
    if (st.dead) return null;
    var norm = (1 - Math.pow(GAIN, oct)) / (1 - GAIN);
    var head = '#define OCT ' + oct + '\n#define FBM_NORM ' + norm.toFixed(6) + '\n';
    var src = (kind === 'star') ? FRAG_STAR : FRAG_PLANET;
    var pr = link(st.gl, VERT, head + src, true);
    if (!pr) { st.dead = true; st.ok = false; return null; }
    st.progs[key] = pr;
    return progReady(pr) ? pr : null;
  }

  /* Start both orb programs translating the moment the context exists, so
     the wait is spent while the first close-up is still zooming in and not
     the first time the OTHER kind of body is drawn (which, before this, was
     the departure planet in the middle of a cruise). Only ever kicked off
     when the link can be left pending; a blocking driver keeps the old
     compile-on-first-use behaviour so a session that never opens a close-up
     still pays nothing. */
  function warmPrograms() {
    if (!st.par || !st.ok || st.dead) return;
    orbProgram('star', st.oct);
    orbProgram('planet', st.oct);
  }

  function init() {
    st.tried = true;
    st.progs = {};
    if (typeof document === 'undefined' || !document || !document.createElement) {
      st.reason = 'no-document';
      return;
    }
    /* the same canvas is reused after a context restore: its lost/restored
       listeners are already attached, and a fresh one would orphan them */
    var cv = st.canvas;
    if (!cv) {
      try { cv = document.createElement('canvas'); } catch (e) { cv = null; }
    }
    if (!cv || typeof cv.getContext !== 'function') { st.reason = 'no-canvas'; return; }
    var target = isMobile() ? TARGET_MOB : TARGET_DESK;
    cv.width = target;
    cv.height = target;
    var gl = null;
    try {
      gl = cv.getContext('webgl', GLATTRS()) || cv.getContext('experimental-webgl', GLATTRS());
    } catch (e) { gl = null; }
    /* a real method, not context truthiness: the node dom-stub hands back
       null for every kind but '2d', and a half-built object would sail
       through a plain if (gl) */
    if (!gl || typeof gl.createShader !== 'function' || typeof gl.getParameter !== 'function') {
      st.reason = 'no-webgl';
      return;
    }
    var maxU = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) | 0;
    if (maxU < 32) { st.reason = 'uniform-vectors:' + maxU; return; }
    var hi = false;
    try {
      if (gl.getShaderPrecisionFormat) {
        var f = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
        hi = !!(f && f.precision > 0);
      }
    } catch (e) { hi = false; }

    st.gl = gl;
    st.canvas = cv;
    st.target = target;
    st.oct = (isMobile() || !hi) ? OCT_LO : OCT_HI;
    st.par = null;
    try {
      if (gl.getExtension) st.par = gl.getExtension('KHR_parallel_shader_compile') || null;
    } catch (ep) { st.par = null; }

    /* the trivial program link that proves the context really works */
    var pres = link(gl, PRESENT_VERT, PRESENT_FRAG);
    if (!pres) { st.dead = true; st.gl = null; st.canvas = null; return; }
    st.present = pres;

    var quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER,
                  new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    st.quad = quad;

    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, target, target, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    var okFb = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!okFb) {
      st.reason = 'framebuffer-incomplete';
      st.dead = true;
      return;
    }
    st.fbo = fbo;
    st.fboTex = tex;

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    gl.enableVertexAttribArray(0);

    /* `phase` staggers the two slots' redraw grids by half the interval, so
       two big orbs never run their shaders in the same frame */
    st.slots = [
      { key: null, side: 0, x: 0, y: 0, tRend: -1e9, ok: false, lastT: -1e9,
        phase: 0, bucket: NaN },
      { key: null, side: 0, x: target >> 1, y: 0, tRend: -1e9, ok: false, lastT: -1e9,
        phase: GL_REDRAW_MS * 0.5, bucket: NaN }
    ];
    st.cache2d = [];
    bindEvents();
    st.ok = true;
    st.lost = false;
    st.reason = 'ok';
    warmPrograms();
  }

  function bindEvents() {
    if (st.handlers || !st.canvas || !st.canvas.addEventListener) return;
    var onLost = function (e) {
      if (e && e.preventDefault) e.preventDefault();
      st.lost = true;
      st.ok = false;
      st.reason = 'context-lost';
      st.progs = {};
      st.present = null;
      st.cache2d = [];
    };
    var onRestored = function () {
      st.lost = false;
      st.tried = false;
      st.reason = 'context-restored';
    };
    st.canvas.addEventListener('webglcontextlost', onLost, false);
    st.canvas.addEventListener('webglcontextrestored', onRestored, false);
    var onVis = null;
    if (typeof document !== 'undefined' && document.addEventListener) {
      onVis = function () { if (document.hidden) dispose(); };
      document.addEventListener('visibilitychange', onVis, false);
    }
    /* idle release: two ticks with no orb drawn is ten seconds. Counting
       ticks instead of reading a clock keeps every draw path clock-free. */
    if (typeof global.setInterval === 'function') {
      st.timer = global.setInterval(function () {
        if (!st.ok) return;
        /* held open while the page says a cinematic is running: the cruise
           legitimately goes ten seconds with no orb big enough to draw, and
           disposing there only buys a context re-creation (and, on a driver
           with no parallel compile, a re-link) in the middle of the flight */
        if (st.hold > 0) { st.idle = 0; return; }
        st.idle++;
        if (st.idle >= 2) dispose();
      }, 5000);
      if (st.timer && st.timer.unref) st.timer.unref();
    }
    st.handlers = { lost: onLost, restored: onRestored, vis: onVis };
  }

  function ensure() {
    if (st.disabled) { st.reason = 'disabled'; return false; }
    if (st.ok) return true;
    if (st.dead) return false;
    if (st.lost) return false;
    if (st.tried) return false;
    init();
    return st.ok;
  }

  function dispose() {
    var gl = st.gl;
    if (gl) {
      try {
        if (st.quad) gl.deleteBuffer(st.quad);
        if (st.fboTex) gl.deleteTexture(st.fboTex);
        if (st.fbo) gl.deleteFramebuffer(st.fbo);
        var k;
        for (k in st.progs) {
          if (Object.prototype.hasOwnProperty.call(st.progs, k) && st.progs[k]) {
            gl.deleteProgram(st.progs[k].p);
          }
        }
        if (st.present) gl.deleteProgram(st.present.p);
      } catch (e) { /* a lost context throws on delete; nothing to salvage */ }
    }
    if (st.timer && typeof global.clearInterval === 'function') {
      global.clearInterval(st.timer);
    }
    if (st.handlers && st.handlers.vis && typeof document !== 'undefined' &&
        document.removeEventListener) {
      document.removeEventListener('visibilitychange', st.handlers.vis, false);
    }
    if (st.canvas) {
      st.canvas.width = 1;
      st.canvas.height = 1;
    }
    st.timer = 0;
    st.handlers = null;
    st.gl = null;
    st.canvas = null;
    st.par = null;
    st.quad = null;
    st.fbo = null;
    st.fboTex = null;
    st.present = null;
    st.progs = {};
    st.slots = null;
    st.cache2d = [];
    st.ok = false;
    st.tried = false;
    st.blits = 0;
    st.idle = 0;
    if (!st.dead && !st.disabled) st.reason = 'disposed';
  }

  /* ---------------- per-frame budget ---------------- */

  function frameSync(t) {
    if (t !== st.frameT) {
      st.frameT = t;
      st.blits = 0;
    }
  }

  /* ---------------- slots ----------------
     One target, allocated once. Each orb owns a scissored sub-rect of it.
     A single orb may use the whole square; two live orbs get half each. */

  function slotFor(key, t) {
    var s = st.slots, i, other;
    for (i = 0; i < s.length; i++) {
      if (s[i].key === key) { s[i].lastT = t; return s[i]; }
    }
    /* release a slot that has not been drawn for a while, so a lone orb can
       grow back to the full target after a two-orb scene */
    for (i = 0; i < s.length; i++) {
      if (s[i].key !== null && t - s[i].lastT > SLOT_HOLD) {
        s[i].key = null; s[i].ok = false;
      }
    }
    for (i = 0; i < s.length; i++) {
      if (s[i].key === null) {
        s[i].key = key; s[i].ok = false; s[i].side = 0; s[i].lastT = t;
        other = s[1 - i];
        /* the survivor may be holding more than half the target */
        if (other.key !== null && other.side > (st.target >> 1)) other.ok = false;
        return s[i];
      }
    }
    /* both busy: evict the one drawn least recently */
    var lru = (s[0].lastT <= s[1].lastT) ? s[0] : s[1];
    lru.key = key; lru.ok = false; lru.side = 0; lru.lastT = t;
    return lru;
  }

  function sideFor(slot, r, dprEff) {
    var other = (st.slots[0] === slot) ? st.slots[1] : st.slots[0];
    var cap = (other.key !== null) ? (st.target >> 1) : st.target;
    var want = 2 * K_GL * r * dprEff;
    var side = Math.ceil(want / 64) * 64;
    if (side < 64) side = 64;
    if (side > cap) side = cap;
    return side;
  }

  /* ---------------- render + present ---------------- */

  function renderOrb(prog, slot, side, setUniforms) {
    var gl = st.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, st.fbo);
    gl.viewport(slot.x, slot.y, side, side);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(slot.x, slot.y, side, side);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, st.quad);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1f(uloc(prog, 'uK'), K_GL);
    setUniforms(gl, prog);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /* Copy the cached slot into the visible drawing buffer, at 1:1. GL's y
     axis points up, so the viewport row range [T - side, T) is the canvas's
     TOP-left square and every drawImage of it reads from (0, 0).
     This is the only thing that touches the default framebuffer, and it
     always runs in the same task as the drawImage that reads it back. */
  function present(slot, side) {
    var gl = st.gl, T = st.target;
    var pr = st.present;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, T - side, side, side);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, T - side, side, side);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(pr.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, st.quad);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, st.fboTex);
    gl.uniform1i(uloc(pr, 'uTex'), 0);
    gl.uniform4f(uloc(pr, 'uSrc'), slot.x / T, slot.y / T, side / T, side / T);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.SCISSOR_TEST);
  }

  /* ---------------- the 2D blit ---------------- */

  function blit(ctx, src, sx, sy, side, x, y, r, alpha, spinDelta) {
    var half = K_GL * r;
    var prev = clamp(num(ctx.globalAlpha, 1), 0, 1);
    ctx.globalAlpha = clamp(alpha, 0, 1) * prev;
    var rot = fin(spinDelta) ? spinDelta : 0;
    if (rot !== 0) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.drawImage(src, sx, sy, side, side, -half, -half, half * 2, half * 2);
      ctx.restore();
    } else {
      ctx.drawImage(src, sx, sy, side, side, x - half, y - half, half * 2, half * 2);
    }
    ctx.globalAlpha = prev;
  }

  /* Reduced motion renders once per (key, side) into a plain 2D canvas and
     blits that thereafter; the shader never runs again. */
  function cache2dGet(key, side) {
    var i;
    for (i = 0; i < st.cache2d.length; i++) {
      if (st.cache2d[i].key === key && st.cache2d[i].side === side) return st.cache2d[i];
    }
    return null;
  }
  function cache2dPut(key, side) {
    var cv;
    try { cv = document.createElement('canvas'); } catch (e) { return null; }
    if (!cv) return null;
    cv.width = side;
    cv.height = side;
    var g = cv.getContext ? cv.getContext('2d') : null;
    if (!g) return null;
    g.drawImage(st.canvas, 0, 0, side, side, 0, 0, side, side);
    var e = { key: key, side: side, cv: cv };
    st.cache2d.push(e);
    while (st.cache2d.length > 4) {
      var d = st.cache2d.shift();
      if (d && d.cv) { d.cv.width = 1; d.cv.height = 1; }
    }
    return e;
  }

  /* ==========================================================================
     STARS
     ========================================================================== */

  var flareBuf = new Float32Array(FLARE_SLOTS * 4);
  var spotBuf = new Float32Array(SPOT_MAX * 4);
  var seedBuf = new Float32Array(3);

  function seedOffset(seed, out) {
    var rnd = mulberry32((seed | 0) ^ 0x5BF03635);
    out[0] = rnd() * 61.7;
    out[1] = rnd() * 61.7;
    out[2] = rnd() * 61.7;
    return out;
  }

  /* Activity gate. The same per-class row that gates the flares gates the
     domain warp and the granulation contrast, so an A1V like Sirius comes
     out as a smooth disc: it has a radiative envelope and no solar-type
     granulation, and painting one roiling would be an invented fact about a
     named star. G and cooler saturate at 1. */
  function activityOf(look) {
    return clamp(num(look.spotAmp, 0) / 0.11, 0, 1);
  }

  function drawStar(ctx, x, y, r, sp, tSec, opts) {
    if (!ctx || typeof ctx.drawImage !== 'function') return false;
    if (!sp || typeof sp !== 'object') return false;
    /* the special cases stay with VoyageArt: the pulsar lighthouse and the
       white dwarf are already right, and a star with no measured
       temperature must keep its neutral grey orb rather than be handed an
       invented blackbody colour */
    if (sp.kind !== 'star') return false;
    if (!fin(sp.teff)) return false;
    var cx = num(x, NaN), cy = num(y, NaN), rr = num(r, NaN);
    if (!fin(cx) || !fin(cy) || !fin(rr)) return false;
    if (!(rr >= GL_MIN_R)) return false;
    var A = ART();
    if (!A || !A.flareUniforms || !A.drawStarBack || !A.drawStarFront) return false;
    if (!ensure()) return false;

    var o = opts || {};
    var reduced = reducedMotion();
    var t = timeOf(tSec, reduced);
    /* a non-finite clock is not silently substituted with zero: the caller
       falls back and VoyageArt applies its own default */
    if (t === null) return false;
    var alpha = clamp(num(o.alpha, 1), 0, 1);
    if (alpha <= 0.004) return false;

    var look = A.starLook(sp);
    if (!look || !finArr(look.rgb, 3) || !fin(look.limbExp)) return false;
    var gran = num(look.granuleScale, NaN);
    if (!fin(gran) || !(gran > 0.01)) return false;
    if (!fin(look.spotAmp)) return false;
    if (!finArr(look.hot, 3) || !finArr(look.cool, 3) ||
        !finArr(look.limb, 3) || !finArr(look.prom, 3)) return false;

    var U = A.flareUniforms(sp, t, flareBuf);
    if (!finArr(U, FLARE_SLOTS * 4)) return false;

    var q = (o.quality === 0) ? 0 : 1;
    var oct = q ? st.oct : Math.min(st.oct, OCT_LO);
    var seed = (look.seed | 0) || (sp.seed | 0) || 1;
    var key = 'S|' + seed + '|' + oct + '|' + Math.round(gran * 1000) +
              '|' + Math.round(num(look.spotAmp, 0) * 1000) +
              '|' + Math.round(num(look.limbExp, 0) * 1000);

    frameSync(t);
    if (st.blits >= GL_MAX_BLITS) return false;
    var slot = slotFor(key, t);
    var dprEff = dprOf(o);
    var side = sideFor(slot, rr, dprEff);

    /* reduced motion: one static frame, then a plain 2D blit forever */
    var c2 = reduced ? cache2dGet(key, side) : null;
    if (c2) {
      st.blits++;
      A.drawStarBack(ctx, cx, cy, rr, sp, t, o);
      blit(ctx, c2.cv, 0, 0, side, cx, cy, rr, alpha, 0);
      A.drawStarFront(ctx, cx, cy, rr, sp, t, o);
      st.idle = 0;
      return true;
    }

    var bucket = reduced ? 0 : Math.floor((t * 1000 + slot.phase) / GL_REDRAW_MS);
    var stale = !slot.ok || slot.side !== side || bucket !== slot.bucket;
    if (stale) {
      var prog = orbProgram('star', oct);
      if (!prog) return false;
      var bright = 1 + 0.12 * clamp(num(A.flareGlow ? A.flareGlow(seed, t, num(sp.flareRate, 0)) : 0, 0), 0, 1);
      var act = activityOf(look);
      var freq = GRAN_F0 / gran;
      var rdev = rr * dprEff;
      var spin = t * TWO_PI / 45;
      var spots = look.spots || [];
      var ns = Math.min(SPOT_MAX, spots.length | 0);
      var i;
      for (i = 0; i < SPOT_MAX; i++) {
        var s4 = i * 4;
        if (i < ns && fin(spots[i].u) && fin(spots[i].v) && fin(spots[i].r) && fin(spots[i].amp)) {
          spotBuf[s4] = spots[i].u;
          spotBuf[s4 + 1] = spots[i].v;
          spotBuf[s4 + 2] = Math.cos(spots[i].r);
          spotBuf[s4 + 3] = spots[i].amp;
        } else {
          if (i < ns) ns = i;
          spotBuf[s4] = 0; spotBuf[s4 + 1] = 0; spotBuf[s4 + 2] = 2; spotBuf[s4 + 3] = 0;
        }
      }
      if (!fin(freq) || !fin(rdev) || !fin(spin) || !fin(act) || !fin(bright)) return false;
      seedOffset(seed, seedBuf);
      var pixU = (2 * K_GL) / side;

      renderOrb(prog, slot, side, function (gl, pr) {
        gl.uniform3f(uloc(pr, 'uHot'), look.hot[0] / 255, look.hot[1] / 255, look.hot[2] / 255);
        gl.uniform3f(uloc(pr, 'uCool'), look.cool[0] / 255, look.cool[1] / 255, look.cool[2] / 255);
        gl.uniform3f(uloc(pr, 'uLimb'), look.limb[0] / 255, look.limb[1] / 255, look.limb[2] / 255);
        gl.uniform3f(uloc(pr, 'uProm'), look.prom[0] / 255, look.prom[1] / 255, look.prom[2] / 255);
        gl.uniform3f(uloc(pr, 'uSeedOff'), seedBuf[0], seedBuf[1], seedBuf[2]);
        gl.uniform4fv(uloc(pr, 'uSpots[0]'), spotBuf);
        gl.uniform4fv(uloc(pr, 'uFlare[0]'), U);
        gl.uniform1f(uloc(pr, 'uSpotN'), ns);
        gl.uniform4f(uloc(pr, 'uGeom'), rdev, pixU, spin, t);
        gl.uniform4f(uloc(pr, 'uMisc'), look.limbExp, act, bright, freq);
      });
      slot.ok = true;
      slot.side = side;
      slot.tRend = t;
      slot.bucket = bucket;
      st.renders++;
    }

    st.blits++;
    /* 1 - corona (VoyageArt, additive) */
    A.drawStarBack(ctx, cx, cy, rr, sp, t, o);
    /* 2 - the GL blit, one drawImage, in the same task as the render */
    present(slot, side);
    var dSpin = reduced ? 0 : (t - slot.tRend) * SURF_ROT;
    blit(ctx, st.canvas, 0, 0, side, cx, cy, rr, alpha, dSpin);
    if (reduced) cache2dPut(key, side);
    /* 3 - flare bloom (VoyageArt, additive) */
    A.drawStarFront(ctx, cx, cy, rr, sp, t, o);
    st.idle = 0;
    return true;
  }

  /* ==========================================================================
     PLANETS AND EXOPLANETS
     ========================================================================== */

  var palBuf = new Float32Array(5 * 3);

  /* the 2D texture strip's field frequencies, converted from cycles around
     the equator to cycles per unit on the sphere (fx / 2pi) */
  function freqsFor(look) {
    var t = look.type;
    if (look.banded) return [6 / TWO_PI, 26 / TWO_PI];
    if (t === 'venus') return [9 / TWO_PI, 22 / TWO_PI];
    if (look.watery) return [8 / TWO_PI, 26 / TWO_PI];
    if (t === 'mars') return [8 / TWO_PI, 26 / TWO_PI];
    if (t === 'ice') return [14 / TWO_PI, 8 / TWO_PI];
    if (t === 'lava') return [11 / TWO_PI, 26 / TWO_PI];
    return [8 / TWO_PI, 26 / TWO_PI];
  }

  function drawPlanet(ctx, x, y, r, pp, tSec, opts) {
    if (!ctx || typeof ctx.drawImage !== 'function') return false;
    if (!pp || typeof pp !== 'object') return false;
    var cx = num(x, NaN), cy = num(y, NaN), rr = num(r, NaN);
    if (!fin(cx) || !fin(cy) || !fin(rr)) return false;
    if (!(rr >= GL_MIN_R)) return false;
    var A = ART();
    if (!A) return false;
    var look = A.planetLook(pp);
    if (!look) return false;
    /* an eyeball world reaches the shader as its own base type plus the
       eyeball flag, which is the route exoParams takes; the enum still
       carries `eyeball` because the spec pins the 16 entries */
    var typeName = look.type;
    if (!Object.prototype.hasOwnProperty.call(TYPE_ID, typeName)) return false;
    /* rings need the 2D split around the blit, so they need those entry
       points to exist; without them Saturn stays entirely on VoyageArt */
    var rings = look.rings || null;
    if (rings && !(A.drawRingsBack && A.drawRingsFront && A.drawRingShadow)) return false;
    if (!ensure()) return false;

    var o = opts || {};
    var reduced = reducedMotion();
    var t = timeOf(tSec, reduced);
    if (t === null) return false;
    var alpha = clamp(num(o.alpha, 1), 0, 1);
    if (alpha <= 0.004) return false;
    var L = num(o.lightDir, Math.PI);
    var phase = clamp(num(o.phase, 0.92), 0, 1);

    var pal = look.palette;
    if (!pal || !pal.length || !finArr(pal[0], 3)) return false;
    var palN = Math.min(5, pal.length | 0);
    var i, j;
    for (i = 0; i < 5; i++) {
      var src = (i < palN && finArr(pal[i], 3)) ? pal[i] : pal[0];
      palBuf[i * 3] = src[0] / 255;
      palBuf[i * 3 + 1] = src[1] / 255;
      palBuf[i * 3 + 2] = src[2] / 255;
    }
    if (!fin(look.limbExp) || !finArr(look.night, 3)) return false;

    /* rotation: exactly VoyageArt's rule, so a locked world keeps the same
       face to its star in both renderers */
    var spin;
    if (fin(o.phaseAngle)) spin = o.phaseAngle;
    else if (look.locked) {
      var sinA0 = Math.sqrt(Math.max(0, 1 - (2 * phase - 1) * (2 * phase - 1)));
      spin = Math.PI - Math.asin(clamp(sinA0 * Math.cos(L), -1, 1));
    } else spin = t * TWO_PI / 30;
    if (!fin(spin)) spin = 0;

    var cosA = 2 * phase - 1;
    var sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    var lx = sinA * Math.cos(L), ly = sinA * Math.sin(L), lz = cosA;
    if (!fin(lx) || !fin(ly) || !fin(lz)) return false;

    var q = (o.quality === 0) ? 0 : 1;
    var oct = q ? st.oct : Math.min(st.oct, OCT_LO);
    var seed = (look.seed | 0) || 1;
    var typeId = TYPE_ID[typeName];
    /* the key is the world's identity only. Spin and light angle move with
       every frame; they ride the same 50 ms re-render the surface does, so
       putting them in the key would thrash the slot table and defeat the
       whole amortization. */
    var key = 'P|' + typeName + '|' + seed + '|' + oct + '|' + (look.eyeball ? 1 : 0) +
              '|' + (look.tint ? Math.round(look.tint[0]) + '_' + Math.round(look.tint[2]) : 'n');

    frameSync(t);
    if (st.blits >= GL_MAX_BLITS) return false;
    var slot = slotFor(key, t);
    var dprEff = dprOf(o);
    var side = sideFor(slot, rr, dprEff);

    var c2 = reduced ? cache2dGet(key, side) : null;
    if (c2) {
      st.blits++;
      if (rings) A.drawRingsBack(ctx, cx, cy, rr, rings, o);
      blit(ctx, c2.cv, 0, 0, side, cx, cy, rr, alpha, 0);
      if (rings) {
        ringShadow(ctx, A, cx, cy, rr, rings, L, alpha, q);
        A.drawRingsFront(ctx, cx, cy, rr, rings, o);
      }
      st.idle = 0;
      return true;
    }

    var bucket = reduced ? 0 : Math.floor((t * 1000 + slot.phase) / GL_REDRAW_MS);
    var stale = !slot.ok || slot.side !== side || bucket !== slot.bucket;
    if (stale) {
      var prog = orbProgram('planet', oct);
      if (!prog) return false;
      var f = freqsFor(look);
      var fA = f[0], fB = f[1], fP = 18 / TWO_PI;
      var sea0 = (look.type === 'temperate') ? 0.545 : 0.515;
      var rdev = rr * dprEff;
      var craters = num(look.craters, 0);
      var bands = num(look.bands, 0);
      var spot = look.spot;
      var tint = look.tint;
      var atmC = look.atmC || [0, 0, 0];
      var emisC = look.emisC || [0, 0, 0];
      if (!fin(fA) || !fin(fB) || !fin(rdev) || !fin(bands) || !fin(craters)) return false;
      if (!finArr(atmC, 3) || !finArr(emisC, 3)) return false;
      if (spot && !(fin(spot.lon) && fin(spot.sinLat) && fin(spot.w) && fin(spot.h) &&
                    finArr(spot.rgb, 3))) spot = null;
      if (tint && !finArr(tint, 3)) tint = null;
      seedOffset(seed, seedBuf);
      var pixU = (2 * K_GL) / side;

      renderOrb(prog, slot, side, function (gl, pr) {
        gl.uniform3fv(uloc(pr, 'uPal[0]'), palBuf);
        gl.uniform3f(uloc(pr, 'uNight'),
                     look.night[0] / 255, look.night[1] / 255, look.night[2] / 255);
        gl.uniform3f(uloc(pr, 'uAtmC'), atmC[0] / 255, atmC[1] / 255, atmC[2] / 255);
        gl.uniform3f(uloc(pr, 'uEmisC'), emisC[0] / 255, emisC[1] / 255, emisC[2] / 255);
        gl.uniform3f(uloc(pr, 'uTint'),
                     tint ? tint[0] / 235 : -1, tint ? tint[1] / 235 : -1, tint ? tint[2] / 235 : -1);
        gl.uniform3f(uloc(pr, 'uSpotC'),
                     spot ? spot.rgb[0] / 255 : 0,
                     spot ? spot.rgb[1] / 255 : 0,
                     spot ? spot.rgb[2] / 255 : 0);
        gl.uniform3f(uloc(pr, 'uSeedOff'), seedBuf[0], seedBuf[1], seedBuf[2]);
        gl.uniform3f(uloc(pr, 'uLight'), lx, ly, lz);
        gl.uniform4f(uloc(pr, 'uSpot'),
                     spot ? spot.lon : 0, spot ? spot.sinLat : 0,
                     spot ? spot.w : 0, spot ? spot.h : 1);
        gl.uniform4f(uloc(pr, 'uFlagA'),
                     look.banded ? 1 : 0, look.watery ? 1 : 0,
                     look.emissive ? 1 : 0, look.eyeball ? 1 : 0);
        gl.uniform4f(uloc(pr, 'uFlagB'),
                     look.clouds ? 1 : 0, look.poles ? 1 : 0, palN, look.atmos ? 1 : 0);
        gl.uniform4f(uloc(pr, 'uGeom'), rdev, pixU, spin, t);
        gl.uniform4f(uloc(pr, 'uFreq'), fA, fB, fP, sea0);
        gl.uniform4f(uloc(pr, 'uMisc'), look.limbExp, typeId, bands, craters);
      });
      slot.ok = true;
      slot.side = side;
      slot.tRend = t;
      slot.bucket = bucket;
      st.renders++;
    }

    st.blits++;
    if (rings) A.drawRingsBack(ctx, cx, cy, rr, rings, o);
    present(slot, side);
    blit(ctx, st.canvas, 0, 0, side, cx, cy, rr, alpha, 0);
    if (reduced) cache2dPut(key, side);
    if (rings) {
      ringShadow(ctx, A, cx, cy, rr, rings, L, alpha, q);
      A.drawRingsFront(ctx, cx, cy, rr, rings, o);
    }
    st.idle = 0;
    return true;
  }

  /* the ring plane's shadow belongs ON the globe, so it is clipped to the
     disc exactly the way VoyageArt clips it */
  function ringShadow(ctx, A, x, y, r, rings, L, alpha, q) {
    if (!q) return;
    var prev = clamp(num(ctx.globalAlpha, 1), 0, 1);
    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1) * prev;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TWO_PI);
    ctx.clip();
    A.drawRingShadow(ctx, x, y, r, rings, L);
    ctx.restore();
    ctx.globalAlpha = prev;
  }

  /* ==========================================================================
     hooks
     ========================================================================== */

  function info() {
    return {
      supported: !!st.ok,
      active: !!(st.ok && !st.disabled && !st.lost),
      reason: st.disabled ? 'disabled' : st.reason,
      octaves: st.ok ? st.oct : 0,
      targetPx: st.ok ? st.target : 0,
      blits: st.blits | 0,
      renders: st.renders | 0
    };
  }

  function disable() {
    st.disabled = true;
    st.reason = 'disabled';
    dispose();
    st.disabled = true;
  }

  function memBytes() {
    var n = 0;
    if (st.ok && st.target) n += st.target * st.target * 4 * 2;   /* target + drawing buffer */
    for (var i = 0; i < st.cache2d.length; i++) {
      n += st.cache2d[i].side * st.cache2d[i].side * 4;
    }
    return n;
  }

  var VoyageGL = {
    ensure: ensure,
    drawStar: drawStar,
    drawPlanet: drawPlanet,
    dispose: dispose,
    /* hooks the page wires into __voy */
    info: info,
    stats: info,
    disable: disable,
    disabled: function () { return !!st.disabled; },
    blits: function () { return st.blits | 0; },
    memBytes: memBytes,
    beginFrame: function (t) { frameSync(num(t, NaN)); },
    /* additive: the page holds the context open across a cinematic */
    setHold: function (v) { st.hold = v ? 1 : 0; if (v) st.idle = 0; },
    /* additive, test-only: is a program still being translated? */
    pending: function () {
      var k, n = 0;
      for (k in st.progs) {
        if (Object.prototype.hasOwnProperty.call(st.progs, k) &&
            st.progs[k] && st.progs[k].pending) n++;
      }
      return n;
    },
    /* pinned numbers, exported for the tests */
    K_GL: K_GL,
    GL_MIN_R: GL_MIN_R,
    GL_MAX_BLITS: GL_MAX_BLITS,
    GL_REDRAW_MS: GL_REDRAW_MS,
    SURF_ROT: SURF_ROT,
    GRAN_F0: GRAN_F0,
    LACUNARITY: LACUNARITY,
    GAIN: GAIN,
    WARP1_AMP: WARP1_AMP,
    WARP2_AMP: WARP2_AMP,
    TYPES: TYPE_ID,
    __src: { vert: VERT, star: FRAG_STAR, planet: FRAG_PLANET, present: PRESENT_FRAG }
  };

  global.VoyageGL = VoyageGL;
  if (typeof module !== 'undefined' && module.exports) module.exports = VoyageGL;
})(typeof self !== 'undefined' ? self : globalThis);
