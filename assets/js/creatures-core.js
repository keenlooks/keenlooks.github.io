/* ==========================================================================
   creatures-core.js — pure logic for the Evolving Creatures page (/creatures/).
   No DOM. Runs in the page and in node (export-guard below), so it attaches
   to self/globalThis — never window.

   Contents: a position-Verlet soft-body physics step (mass points + springs +
   oscillating muscles), the genome operators for a small genetic algorithm
   (tournament selection, per-muscle crossover, gaussian mutation), the fixed
   morphology presets, a seeded random-morphology generator, and the share
   payload builder/validator. Champion replays and shared creatures step
   through the exact same stepCreature() path as evolution — no separate
   playback physics — which is what keeps replays and shares honest.

   Physics constants below are canonical (plan-reviewed). dt is FIXED at
   1/240 s; playback speed only adds substeps per frame, so a trajectory is
   bit-identical at any speed. Tuning locomotion happens in preset GEOMETRY,
   never in these constants.

   Per-substep operation order (fixed; any reimplementation must match):
     1. update muscle rest lengths from t = substepIndex * dt
     2. Verlet-integrate all nodes (x' = x + (x - px)*DAMP + a*dt^2)
     3. ITERS spring-relaxation passes over springs in array order
     4. ground contact + friction per node (then py = max(py, y) exactly,
        which cancels the Verlet "trampoline" artifact)
     5. per-node displacement clamp + non-finite check (dead => frozen)
   ========================================================================== */
(function (root) {
  'use strict';
  if (root.CreaturesCore) return;

  /* ------------------------- fixed constants ---------------------------- */

  var DT = 1 / 240;            /* s, physics substep — NEVER scaled */
  var DAMP = 0.998;            /* per-substep Verlet damping */
  var GRAV = 9.8;              /* m/s^2 downward */
  var STIFF = 0.8;             /* spring relaxation stiffness */
  var ITERS = 3;               /* relaxation iterations per substep */
  var FRICK = 0.5;             /* kinetic ground friction */
  var STATIC_EPS = 0.0004;     /* m/substep — slower than this sticks (static) */
  var NODE_R = 0.09;           /* m, node radius (also min ground height) */
  var CLAMP_D = 0.06;          /* m, max per-substep displacement */
  var GEN_SUBSTEPS = 2880;     /* 12 s * 240 — a generation, in SIM time */
  var TWO_PI = Math.PI * 2;

  var F_MIN = 0.5, F_MAX = 2.2;   /* Hz, per-creature shared muscle frequency */
  var A_MAX = 0.32;               /* max amplitude, fraction of rest length */
  var SIG_A = 0.05, SIG_PHI = 0.45, SIG_F = 0.1;  /* mutation sigmas (x slider) */
  var POP_MIN = 16, POP_MAX = 80, POP_DEF = 40;

  /* Build-your-own editor limits (v2). Custom bodies (preset 5) may use up
     to 10 nodes / 26 springs; v1 Random shares (preset 4) keep 8 / 20 so old
     links decode byte-identically. BUILD_XMAX/BUILD_YMAX bound the editable
     region (x in +-1.6 m, y in [NODE_R, 1.7 m]); BUILD_SNAP is the placement
     grid. */
  var BUILD_NODES = 10, BUILD_SPRINGS = 26;
  var V1_NODES = 8, V1_SPRINGS = 20;
  var BUILD_XMAX = 1.6, BUILD_YMAX = 1.7, BUILD_SNAP = 0.02;

  /* ------------------------------ RNG ----------------------------------- */

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Box-Muller gaussian; consumes 2 draws (the u=0 reroll is a 1-in-2^32
     event and still deterministic for a given seed). */
  function gauss(rng) {
    var u = rng();
    while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * rng());
  }

  /* --------------------------- genome ops ------------------------------- */

  function wrapPhi(v) {
    v = v % TWO_PI;
    if (v < 0) v += TWO_PI;
    return v;
  }
  function clampVal(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function randomGenome(rng, M) {
    var muscles = [];
    for (var m = 0; m < M; m++) {
      muscles.push({ A: rng() * A_MAX, phi: rng() * TWO_PI });
    }
    return { f: F_MIN + rng() * (F_MAX - F_MIN), muscles: muscles };
  }

  function copyGenome(g) {
    var muscles = [];
    for (var m = 0; m < g.muscles.length; m++) {
      muscles.push({ A: g.muscles[m].A, phi: g.muscles[m].phi });
    }
    return { f: g.f, muscles: muscles };
  }

  /* Each muscle param mutates with prob 0.25 (gaussian jitter), f with prob
     0.5; `scale` is the Mutation slider (0.3–3), multiplying every sigma. */
  function mutateGenome(g, rng, scale) {
    var out = copyGenome(g);
    if (rng() < 0.5) out.f = clampVal(out.f + gauss(rng) * SIG_F * scale, F_MIN, F_MAX);
    for (var m = 0; m < out.muscles.length; m++) {
      if (rng() < 0.25) out.muscles[m].A = clampVal(out.muscles[m].A + gauss(rng) * SIG_A * scale, 0, A_MAX);
      if (rng() < 0.25) out.muscles[m].phi = wrapPhi(out.muscles[m].phi + gauss(rng) * SIG_PHI * scale);
    }
    return out;
  }

  /* Uniform per-muscle crossover (the {A, phi} pair travels together);
     the shared f comes from one parent via a single 50/50 draw. */
  function crossover(a, b, rng) {
    var muscles = [];
    for (var m = 0; m < a.muscles.length; m++) {
      var src = (rng() < 0.5) ? a.muscles[m] : b.muscles[m];
      muscles.push({ A: src.A, phi: src.phi });
    }
    return { f: (rng() < 0.5) ? a.f : b.f, muscles: muscles };
  }

  /* --------------------------- morphologies ----------------------------- */
  /* springs are [i, j, isMuscle] index triples; muscle order (for genome
     indexing) is the order muscles appear in the springs array. */

  function wheelPreset() {
    var nodes = [[0, 0.48]], springs = [], k, a;
    for (k = 0; k < 6; k++) {
      a = (90 + 60 * k) * Math.PI / 180;
      nodes.push([0.4 * Math.cos(a), 0.48 + 0.4 * Math.sin(a)]);
      springs.push([0, k + 1, 1]);                       /* spoke, muscle */
    }
    for (k = 1; k <= 6; k++) springs.push([k, k === 6 ? 1 : k + 1, 0]);  /* rim */
    return { name: 'Wheel', nodes: nodes, springs: springs };
  }

  var PRESETS = [
    { name: 'Sprinter',
      nodes: [[0.00, 0.95], [-0.28, 0.65], [0.28, 0.65], [-0.22, 0.09], [0.22, 0.09]],
      springs: [[0, 1, 0], [0, 2, 0], [1, 2, 0],
                [1, 3, 1], [2, 4, 1], [1, 4, 1], [2, 3, 1]] },
    { name: 'Quadruped',
      nodes: [[-0.45, 0.75], [0.45, 0.75], [-0.45, 0.45], [0.45, 0.45],
              [-0.55, 0.09], [-0.20, 0.09], [0.20, 0.09], [0.55, 0.09]],
      springs: [[0, 1, 0], [2, 3, 0], [0, 2, 0], [1, 3, 0], [0, 3, 0], [1, 2, 0],
                [2, 4, 1], [2, 5, 1], [3, 6, 1], [3, 7, 1], [4, 5, 0], [6, 7, 0]] },
    { name: 'Worm',
      nodes: [[-0.5, 0.42], [0, 0.42], [0.5, 0.42], [-0.5, 0.09], [0, 0.09], [0.5, 0.09]],
      springs: [[0, 1, 0], [1, 2, 0], [3, 4, 0], [4, 5, 0],
                [0, 3, 1], [1, 4, 1], [2, 5, 1], [0, 4, 1], [1, 5, 1], [1, 3, 0], [2, 4, 0]] },
    wheelPreset()
  ];

  function copyMorph(m) {
    var nodes = [], springs = [], i;
    for (i = 0; i < m.nodes.length; i++) nodes.push([m.nodes[i][0], m.nodes[i][1]]);
    for (i = 0; i < m.springs.length; i++) springs.push([m.springs[i][0], m.springs[i][1], m.springs[i][2]]);
    return { name: m.name, nodes: nodes, springs: springs };
  }

  function muscleCount(morph) {
    var n = 0;
    for (var s = 0; s < morph.springs.length; s++) if (morph.springs[s][2]) n++;
    return n;
  }

  /* Random morphology: 5–8 nodes rejection-sampled in a 1.1 x 0.9 m box at
     min pairwise distance 0.28; springs between all pairs closer than 0.62;
     connected via union-find (closest bridging pairs added if not); springs
     longer than 0.34 are muscles. Rejects < 3 muscles or > 20 springs (the
     share-decode cap). Fully driven by the run rng => reproducible. */
  function randomMorph(rng) {
    for (var attempt = 0; attempt < 500; attempt++) {
      var N = 5 + Math.floor(rng() * 4);
      var pts = [], ok = true, i, j;
      for (i = 0; i < N; i++) {
        var placed = false;
        for (var tries = 0; tries < 300; tries++) {
          var x = (rng() - 0.5) * 1.1, y = rng() * 0.9, good = true;
          for (j = 0; j < pts.length; j++) {
            var ddx = pts[j][0] - x, ddy = pts[j][1] - y;
            if (ddx * ddx + ddy * ddy < 0.28 * 0.28) { good = false; break; }
          }
          if (good) { pts.push([x, y]); placed = true; break; }
        }
        if (!placed) { ok = false; break; }
      }
      if (!ok) continue;

      var springs = [];
      for (i = 0; i < N; i++) {
        for (j = i + 1; j < N; j++) {
          var d = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
          if (d < 0.62) springs.push([i, j, d > 0.34 ? 1 : 0]);
        }
      }

      /* union-find connectivity; bridge components with the closest pairs */
      var parent = [];
      for (i = 0; i < N; i++) parent.push(i);
      function find(v) { while (parent[v] !== v) { parent[v] = parent[parent[v]]; v = parent[v]; } return v; }
      function union(a, b) { parent[find(a)] = find(b); }
      for (i = 0; i < springs.length; i++) union(springs[i][0], springs[i][1]);
      for (;;) {
        var comps = 0;
        for (i = 0; i < N; i++) if (find(i) === i) comps++;
        if (comps <= 1) break;
        var bi = -1, bj = -1, bd = Infinity;
        for (i = 0; i < N; i++) {
          for (j = i + 1; j < N; j++) {
            if (find(i) === find(j)) continue;
            var d2 = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
            if (d2 < bd) { bd = d2; bi = i; bj = j; }
          }
        }
        springs.push([bi, bj, bd > 0.34 ? 1 : 0]);
        union(bi, bj);
      }

      var mc = 0;
      for (i = 0; i < springs.length; i++) if (springs[i][2]) mc++;
      if (mc < 3) continue;
      if (springs.length > 20) continue;
      return { name: 'Random', nodes: pts, springs: springs };
    }
    /* effectively unreachable; a deterministic safe fallback */
    return copyMorph(PRESETS[2]);
  }

  /* idx 0..3 = fixed presets (no rng draws); idx 4 = random (draws from rng);
     idx 5 = custom (makeRun requires opts.morph; never comes here) */
  function morphForPreset(idx, rng) {
    if (idx === 4) return randomMorph(rng);
    return copyMorph(PRESETS[idx]);
  }

  /* ------------------------- morph validation ---------------------------- */

  /* Single source of truth for "can this morphology evolve": the editor's
     Evolve button and share-decode both call it. Returns { ok: true,
     muscles: n } or { ok: false, reason: 'few-nodes' | 'many-nodes' |
     'many-springs' | 'disconnected' | 'no-muscle' | 'bad-coord' }.
     Checks in order: nodes an array of finite [x, y] pairs within [-3, 3],
     3..10 of them; springs an array of [i, j, isMuscle] with valid integer
     indices, no self-edges, no duplicates (i-j unordered), 2..26 of them;
     graph connected (union-find); at least one muscle. Malformed spring
     entries report 'bad-coord' (a bad node index is a bad coordinate). */
  function validateMorph(morph) {
    if (!morph || typeof morph !== 'object' || Array.isArray(morph)) {
      return { ok: false, reason: 'few-nodes' };
    }
    var n = morph.nodes, s = morph.springs, i;
    if (!Array.isArray(n) || n.length < 3) return { ok: false, reason: 'few-nodes' };
    if (n.length > BUILD_NODES) return { ok: false, reason: 'many-nodes' };
    for (i = 0; i < n.length; i++) {
      var pt = n[i];
      if (!Array.isArray(pt) ||
          typeof pt[0] !== 'number' || !isFinite(pt[0]) || pt[0] < -3 || pt[0] > 3 ||
          typeof pt[1] !== 'number' || !isFinite(pt[1]) || pt[1] < -3 || pt[1] > 3) {
        return { ok: false, reason: 'bad-coord' };
      }
    }
    if (!Array.isArray(s) || s.length < 2) return { ok: false, reason: 'disconnected' };
    if (s.length > BUILD_SPRINGS) return { ok: false, reason: 'many-springs' };
    var parent = [], seen = {}, muscles = 0;
    for (i = 0; i < n.length; i++) parent.push(i);
    function find(v) { while (parent[v] !== v) { parent[v] = parent[parent[v]]; v = parent[v]; } return v; }
    for (i = 0; i < s.length; i++) {
      var sp = s[i];
      if (!Array.isArray(sp)) return { ok: false, reason: 'bad-coord' };
      var a = sp[0], b = sp[1];
      if (typeof a !== 'number' || typeof b !== 'number' ||
          a !== Math.round(a) || b !== Math.round(b) ||
          a < 0 || a >= n.length || b < 0 || b >= n.length || a === b) {
        return { ok: false, reason: 'bad-coord' };
      }
      var key = Math.min(a, b) + '-' + Math.max(a, b);
      if (seen[key]) return { ok: false, reason: 'bad-coord' };
      seen[key] = 1;
      if (sp[2]) muscles++;
      parent[find(a)] = find(b);
    }
    for (i = 1; i < n.length; i++) {
      if (find(i) !== find(0)) return { ok: false, reason: 'disconnected' };
    }
    if (!muscles) return { ok: false, reason: 'no-muscle' };
    return { ok: true, muscles: muscles };
  }

  /* ------------------------- editor mutation ops ------------------------- */

  /* Pure, node-testable mutations the build editor applies to a morph
     in place. Every op enforces the snap (BUILD_SNAP), the coordinate
     clamps (x within +-BUILD_XMAX, y in [NODE_R, BUILD_YMAX]) and the caps
     (BUILD_NODES nodes / BUILD_SPRINGS springs), and returns false when it
     refuses. addNode returns the NEW NODE INDEX on success (which can be 0,
     so callers must compare against false, not truthiness). */
  function snapCoord(v) { return Math.round(v / BUILD_SNAP) * BUILD_SNAP; }
  function buildClampX(x) { return clampVal(snapCoord(x), -BUILD_XMAX, BUILD_XMAX); }
  function buildClampY(y) { return clampVal(snapCoord(y), NODE_R, BUILD_YMAX); }

  var BuildOps = {
    addNode: function (morph, x, y) {
      if (morph.nodes.length >= BUILD_NODES) return false;
      if (!isFinite(x) || !isFinite(y)) return false;
      morph.nodes.push([buildClampX(x), buildClampY(y)]);
      return morph.nodes.length - 1;
    },
    moveNode: function (morph, i, x, y) {
      if (i !== Math.round(i) || i < 0 || i >= morph.nodes.length) return false;
      if (!isFinite(x) || !isFinite(y)) return false;
      morph.nodes[i][0] = buildClampX(x);
      morph.nodes[i][1] = buildClampY(y);
      return true;
    },
    deleteNode: function (morph, i) {
      if (i !== Math.round(i) || i < 0 || i >= morph.nodes.length) return false;
      morph.nodes.splice(i, 1);
      var out = [], k;
      for (k = 0; k < morph.springs.length; k++) {
        var sp = morph.springs[k];
        if (sp[0] === i || sp[1] === i) continue;
        out.push([sp[0] > i ? sp[0] - 1 : sp[0], sp[1] > i ? sp[1] - 1 : sp[1], sp[2]]);
      }
      morph.springs = out;
      return true;
    },
    /* absent edge -> add as MUSCLE (false at the spring cap); present -> remove */
    toggleEdge: function (morph, i, j) {
      var N = morph.nodes.length;
      if (i !== Math.round(i) || j !== Math.round(j) ||
          i < 0 || j < 0 || i >= N || j >= N || i === j) return false;
      for (var k = 0; k < morph.springs.length; k++) {
        var sp = morph.springs[k];
        if ((sp[0] === i && sp[1] === j) || (sp[0] === j && sp[1] === i)) {
          morph.springs.splice(k, 1);
          return true;
        }
      }
      if (morph.springs.length >= BUILD_SPRINGS) return false;
      morph.springs.push([Math.min(i, j), Math.max(i, j), 1]);
      return true;
    },
    /* spring k cycles muscle -> structural -> deleted */
    cycleEdge: function (morph, k) {
      if (k !== Math.round(k) || k < 0 || k >= morph.springs.length) return false;
      if (morph.springs[k][2]) morph.springs[k][2] = 0;
      else morph.springs.splice(k, 1);
      return true;
    },
    /* clamp an imported morph (share, preset) into the editable region;
       spawn normalization makes the shift harmless to evolution */
    clampMorph: function (morph) {
      for (var i = 0; i < morph.nodes.length; i++) {
        morph.nodes[i][0] = clampVal(morph.nodes[i][0], -BUILD_XMAX, BUILD_XMAX);
        morph.nodes[i][1] = clampVal(morph.nodes[i][1], NODE_R, BUILD_YMAX);
      }
      return morph;
    }
  };

  /* ----------------------------- creature ------------------------------- */

  /* Build a creature from a morphology + genome. Rest lengths come from the
     raw preset coordinates (translation-invariant), then spawn ALWAYS
     normalizes: translate so min(y) = NODE_R and mean(x) = 0, at rest. */
  function makeCreature(morph, genome) {
    var N = morph.nodes.length, S = morph.springs.length, i, s;
    var x = new Float64Array(N), y = new Float64Array(N);
    var px = new Float64Array(N), py = new Float64Array(N);
    var si = new Int32Array(S), sj = new Int32Array(S), mus = new Uint8Array(S);
    var L0 = new Float64Array(S), restL = new Float64Array(S);

    for (i = 0; i < N; i++) { x[i] = morph.nodes[i][0]; y[i] = morph.nodes[i][1]; }
    var M = 0;
    for (s = 0; s < S; s++) {
      si[s] = morph.springs[s][0]; sj[s] = morph.springs[s][1];
      mus[s] = morph.springs[s][2] ? 1 : 0;
      if (mus[s]) M++;
      L0[s] = Math.hypot(x[sj[s]] - x[si[s]], y[sj[s]] - y[si[s]]);
      restL[s] = L0[s];
    }
    var mIdx = new Int32Array(M), mA = new Float64Array(M), mPhi = new Float64Array(M);
    var k = 0;
    for (s = 0; s < S; s++) {
      if (!mus[s]) continue;
      mIdx[k] = s;
      if (genome.muscles[k]) {
        mA[k] = clampVal(genome.muscles[k].A, 0, A_MAX);
        mPhi[k] = wrapPhi(genome.muscles[k].phi);
      }
      k++;
    }

    /* spawn normalization: mean(x) = 0, min(y) = NODE_R */
    var mx = 0, minY = Infinity;
    for (i = 0; i < N; i++) { mx += x[i]; if (y[i] < minY) minY = y[i]; }
    mx /= N;
    var dy = NODE_R - minY;
    for (i = 0; i < N; i++) {
      x[i] -= mx; y[i] += dy;
      px[i] = x[i]; py[i] = y[i];
    }

    return {
      n: N, s: S, x: x, y: y, px: px, py: py,
      si: si, sj: sj, mus: mus, L0: L0, restL: restL,
      m: M, mIdx: mIdx, mA: mA, mPhi: mPhi,
      f: clampVal(genome.f, F_MIN, F_MAX),
      genome: genome, dead: false, startX: 0
    };
  }

  function comX(c) {
    var sum = 0;
    for (var i = 0; i < c.n; i++) sum += c.x[i];
    return sum / c.n;
  }

  /* One physics substep. k is the substep index (t = k * DT). Dead creatures
     are frozen (returns immediately). */
  function stepCreature(c, k) {
    if (c.dead) return;
    var N = c.n, S = c.s, i, s;
    var x = c.x, y = c.y, px = c.px, py = c.py;
    var restL = c.restL, si = c.si, sj = c.sj;

    /* 1. muscle rest lengths from t = k * DT */
    var w = TWO_PI * c.f * (k * DT);
    for (var m = 0; m < c.m; m++) {
      s = c.mIdx[m];
      restL[s] = c.L0[s] * (1 + c.mA[m] * Math.sin(w + c.mPhi[m]));
    }

    /* 2. Verlet integration (gravity only) */
    var g2 = GRAV * DT * DT;
    for (i = 0; i < N; i++) {
      var nx = x[i] + (x[i] - px[i]) * DAMP;
      var ny = y[i] + (y[i] - py[i]) * DAMP - g2;
      px[i] = x[i]; py[i] = y[i];
      x[i] = nx; y[i] = ny;
    }

    /* 3. spring relaxation, ITERS passes in array order */
    for (var it = 0; it < ITERS; it++) {
      for (s = 0; s < S; s++) {
        var a = si[s], b = sj[s];
        var dx = x[b] - x[a], dyy = y[b] - y[a];
        var dist = Math.sqrt(dx * dx + dyy * dyy);
        if (dist < 1e-9) continue;
        var corr = 0.5 * STIFF * (dist - restL[s]) / dist;
        var cx = dx * corr, cy = dyy * corr;
        x[a] += cx; y[a] += cy;
        x[b] -= cx; y[b] -= cy;
      }
    }

    /* 4. ground contact + friction; py = max(py, y) kills the trampoline */
    for (i = 0; i < N; i++) {
      if (y[i] < NODE_R) {
        y[i] = NODE_R;
        var vx = x[i] - px[i];
        if (vx < STATIC_EPS && vx > -STATIC_EPS) px[i] = x[i];
        else px[i] = x[i] - vx * (1 - FRICK);
        if (py[i] < y[i]) py[i] = y[i];
      }
    }

    /* 5. displacement clamp + non-finite check */
    var bad = false;
    for (i = 0; i < N; i++) {
      var ddx = x[i] - px[i], ddy = y[i] - py[i];
      var d2 = ddx * ddx + ddy * ddy;
      if (d2 > CLAMP_D * CLAMP_D) {
        var dd = Math.sqrt(d2);
        x[i] = px[i] + ddx * CLAMP_D / dd;
        y[i] = py[i] + ddy * CLAMP_D / dd;
      }
      if (!isFinite(x[i]) || !isFinite(y[i]) || !isFinite(px[i]) || !isFinite(py[i])) bad = true;
    }
    if (bad) c.dead = true;
  }

  /* ------------------------------- run ----------------------------------- */

  /* A run owns the rng, the morphology (fixed for the run), the population,
     and the generation counters. opts: { seed, preset, pop, mutScale,
     morph (override, e.g. a shared random body), seedGenome (seed the
     population from a shared champion: 30% copies, 60% mutants, 10% random) }. */
  function makeRun(opts) {
    opts = opts || {};
    var seed = (opts.seed == null ? 1 : opts.seed) >>> 0;
    var rng = mulberry32(seed);
    var presetIdx = Math.min(5, Math.max(0, opts.preset | 0));
    /* preset 5 = a custom-built body: the morph override is REQUIRED
       (callers guarantee it; PRESETS[5] does not exist) */
    if (presetIdx === 5 && !opts.morph) {
      throw new Error('CreaturesCore.makeRun: preset 5 requires opts.morph');
    }
    var pop = Math.round(clampVal(opts.pop == null ? POP_DEF : opts.pop, POP_MIN, POP_MAX));
    var morph = opts.morph ? copyMorph(opts.morph) : morphForPreset(presetIdx, rng);
    var M = muscleCount(morph);
    var run = {
      seed: seed, rng: rng, presetIdx: presetIdx, morph: morph, M: M,
      pop: pop, mutScale: clampVal(opts.mutScale == null ? 1 : opts.mutScale, 0.3, 3),
      genomes: [], creatures: [], substep: 0, gen: 1, genDone: false,
      hist: [], champion: null, fits: null, ranked: null
    };
    var i;
    if (opts.seedGenome && opts.seedGenome.muscles && opts.seedGenome.muscles.length === M) {
      var copies = Math.round(0.3 * pop), freshN = Math.round(0.1 * pop);
      var mutants = pop - copies - freshN;
      for (i = 0; i < copies; i++) run.genomes.push(copyGenome(opts.seedGenome));
      for (i = 0; i < mutants; i++) run.genomes.push(mutateGenome(opts.seedGenome, rng, run.mutScale));
      for (i = 0; i < freshN; i++) run.genomes.push(randomGenome(rng, M));
    } else {
      for (i = 0; i < pop; i++) run.genomes.push(randomGenome(rng, M));
    }
    for (i = 0; i < pop; i++) run.creatures.push(makeCreature(morph, run.genomes[i]));
    return run;
  }

  function endGeneration(run) {
    var P = run.pop, i;
    var fits = new Array(P);
    for (i = 0; i < P; i++) {
      var c = run.creatures[i];
      fits[i] = c.dead ? 0 : Math.max(0, comX(c) - c.startX);
    }
    var ranked = new Array(P);
    for (i = 0; i < P; i++) ranked[i] = i;
    ranked.sort(function (a, b) { return (fits[b] - fits[a]) || (a - b); });
    var sorted = fits.slice().sort(function (a, b) { return a - b; });
    var median = (P % 2) ? sorted[(P - 1) / 2] : (sorted[P / 2 - 1] + sorted[P / 2]) / 2;
    var best = fits[ranked[0]];
    run.hist.push({ best: best, median: median });
    if (!run.champion || best > run.champion.fitness) {
      run.champion = { genome: copyGenome(run.genomes[ranked[0]]), fitness: best, gen: run.gen };
    }
    run.fits = fits;
    run.ranked = ranked;
    run.genDone = true;
  }

  /* Advance up to n substeps; stops early when the generation completes
     (exactly at substep GEN_SUBSTEPS of sim time). Returns substeps run. */
  function stepRun(run, n) {
    var done = 0;
    while (done < n && !run.genDone) {
      var k = run.substep;
      for (var i = 0; i < run.pop; i++) stepCreature(run.creatures[i], k);
      run.substep++;
      done++;
      if (run.substep >= GEN_SUBSTEPS) endGeneration(run);
    }
    return done;
  }

  function tournament(fits, rng) {
    var P = fits.length;
    var best = Math.floor(rng() * P);
    for (var t = 1; t < 3; t++) {
      var c = Math.floor(rng() * P);
      if (fits[c] > fits[best]) best = c;
    }
    return best;
  }

  /* Breed the next generation (call after genDone). Deterministic counts:
     elites = max(1, round(0.2 P)) copied unchanged; fresh = round(0.1 (P -
     elites)) brand-new; the rest bred by tournament-of-3 + crossover + mutate. */
  function breedNext(run) {
    var P = run.pop, rng = run.rng, scale = run.mutScale, i;
    var elites = Math.max(1, Math.round(0.2 * P));
    var fresh = Math.round(0.1 * (P - elites));
    var next = [];
    for (i = 0; i < elites; i++) next.push(copyGenome(run.genomes[run.ranked[i]]));
    for (i = 0; i < fresh; i++) next.push(randomGenome(rng, run.M));
    while (next.length < P) {
      var pa = tournament(run.fits, rng), pb = tournament(run.fits, rng);
      next.push(mutateGenome(crossover(run.genomes[pa], run.genomes[pb], rng), rng, scale));
    }
    run.genomes = next;
    run.creatures = [];
    for (i = 0; i < P; i++) run.creatures.push(makeCreature(run.morph, next[i]));
    run.substep = 0;
    run.gen++;
    run.genDone = false;
    run.fits = null;
    run.ranked = null;
  }

  /* ------------------------------- share --------------------------------- */

  /* Payload v1: { p, s, g, f, m: [[A, phi]…], morph?: { n, s } } — morph for
     the Random preset (p = 4) and custom-built bodies (p = 5). Numbers get
     rounded to 3 decimals by ShareHash.encode; the ranges survive that
     rounding. The schema is a superset of v1, so the ShareHash version
     stays 1. */
  function buildShare(run) {
    if (!run || !run.champion) return null;
    var ch = run.champion, i;
    var m = [];
    for (i = 0; i < ch.genome.muscles.length; i++) {
      m.push([ch.genome.muscles[i].A, ch.genome.muscles[i].phi]);
    }
    var o = { p: run.presetIdx, s: run.seed, g: ch.gen, f: ch.genome.f, m: m };
    if (run.presetIdx >= 4) {
      var n = [], ss = [];
      for (i = 0; i < run.morph.nodes.length; i++) n.push([run.morph.nodes[i][0], run.morph.nodes[i][1]]);
      for (i = 0; i < run.morph.springs.length; i++) {
        ss.push([run.morph.springs[i][0], run.morph.springs[i][1], run.morph.springs[i][2] ? 1 : 0]);
      }
      o.morph = { n: n, s: ss };
    }
    return o;
  }

  function shNum(v, lo, hi, def) {
    if (typeof v !== 'number' || !isFinite(v)) return def;
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /* Validate a DECODED (untrusted) share payload object. Returns
     { preset, seed, gen, genome, morph|null } or null. Every number is
     clamped into its range; the payload is rejected outright when the
     muscle list length does not match the morphology's muscle count.

     Caps are preset-dependent (v2): p = 4 keeps the v1 caps (8 nodes /
     20 springs / 20 muscles) so old links decode byte-identically; p = 5
     (custom-built bodies) allows 10 / 26 / 26 — note the o.m muscle-array
     cap widens too, since the editor adds every new edge as a muscle. For
     p >= 4 the morph is REQUIRED (never fall through to PRESETS[5], which
     does not exist), and the reconstructed morph must pass validateMorph
     (connectivity + at-least-one-muscle; presets were trusted, user bodies
     are not — this holds for p = 4 too, since randomMorph always bridges
     components, verified by the recorded-v1-payload regression test). */
  function validateShare(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    var p = shNum(o.p, 0, 5, NaN);
    if (!isFinite(p)) return null;
    p = Math.round(p);
    var seed = shNum(o.s, 0, 4294967295, 1) >>> 0;
    var gen = Math.round(shNum(o.g, 1, 1000000, 1));
    var f = shNum(o.f, F_MIN, F_MAX, (F_MIN + F_MAX) / 2);
    var mCap = (p === 5) ? BUILD_SPRINGS : V1_SPRINGS;
    if (!Array.isArray(o.m) || o.m.length < 1 || o.m.length > mCap) return null;
    var muscles = [], i;
    for (i = 0; i < o.m.length; i++) {
      var e = o.m[i];
      if (!Array.isArray(e)) return null;
      muscles.push({ A: shNum(e[0], 0, A_MAX, 0), phi: wrapPhi(shNum(e[1], -1000, 1000, 0)) });
    }
    var morph = null;
    if (p >= 4) {
      var nodeCap = (p === 5) ? BUILD_NODES : V1_NODES;
      var springCap = (p === 5) ? BUILD_SPRINGS : V1_SPRINGS;
      var mo = o.morph;
      if (!mo || typeof mo !== 'object' || Array.isArray(mo)) return null;
      if (!Array.isArray(mo.n) || mo.n.length < 3 || mo.n.length > nodeCap) return null;
      if (!Array.isArray(mo.s) || mo.s.length < 1 || mo.s.length > springCap) return null;
      var nodes = [], springs = [], seen = {};
      for (i = 0; i < mo.n.length; i++) {
        if (!Array.isArray(mo.n[i])) return null;
        var vx = mo.n[i][0], vy = mo.n[i][1];
        if (typeof vx !== 'number' || !isFinite(vx) ||
            typeof vy !== 'number' || !isFinite(vy)) return null;
        nodes.push([clampVal(vx, -3, 3), clampVal(vy, -3, 3)]);
      }
      for (i = 0; i < mo.s.length; i++) {
        var sp = mo.s[i];
        if (!Array.isArray(sp)) return null;
        var a = shNum(sp[0], 0, nodes.length - 1, NaN);
        var b = shNum(sp[1], 0, nodes.length - 1, NaN);
        if (!isFinite(a) || !isFinite(b)) continue;
        a = Math.round(a); b = Math.round(b);
        if (a === b) continue;
        var key = Math.min(a, b) + '-' + Math.max(a, b);
        if (seen[key]) continue;
        seen[key] = 1;
        springs.push([a, b, sp[2] ? 1 : 0]);
      }
      if (!springs.length) return null;
      morph = { name: 'Shared', nodes: nodes, springs: springs };
      if (!validateMorph(morph).ok) return null;
    }
    var mc = morph ? muscleCount(morph) : muscleCount(PRESETS[p]);
    if (mc !== muscles.length) return null;
    return { preset: p, seed: seed, gen: gen, genome: { f: f, muscles: muscles }, morph: morph };
  }

  /* ------------------------------ export --------------------------------- */

  root.CreaturesCore = {
    DT: DT, DAMP: DAMP, GRAV: GRAV, STIFF: STIFF, ITERS: ITERS,
    FRICK: FRICK, STATIC_EPS: STATIC_EPS, NODE_R: NODE_R, CLAMP_D: CLAMP_D,
    GEN_SUBSTEPS: GEN_SUBSTEPS,
    F_MIN: F_MIN, F_MAX: F_MAX, A_MAX: A_MAX,
    POP_MIN: POP_MIN, POP_MAX: POP_MAX, POP_DEF: POP_DEF,
    BUILD_NODES: BUILD_NODES, BUILD_SPRINGS: BUILD_SPRINGS,
    BUILD_XMAX: BUILD_XMAX, BUILD_YMAX: BUILD_YMAX, BUILD_SNAP: BUILD_SNAP,
    mulberry32: mulberry32, gauss: gauss,
    PRESETS: PRESETS, morphForPreset: morphForPreset, randomMorph: randomMorph,
    copyMorph: copyMorph, muscleCount: muscleCount,
    validateMorph: validateMorph, BuildOps: BuildOps,
    randomGenome: randomGenome, copyGenome: copyGenome,
    mutateGenome: mutateGenome, crossover: crossover,
    makeCreature: makeCreature, stepCreature: stepCreature, comX: comX,
    makeRun: makeRun, stepRun: stepRun, breedNext: breedNext,
    buildShare: buildShare, validateShare: validateShare
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.CreaturesCore;
})(typeof self !== 'undefined' ? self : globalThis);
