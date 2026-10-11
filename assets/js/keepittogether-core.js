/* keepittogether-core.js
 *
 * Pure rules for "Keep It Together". No DOM, no timers, no canvas, no Math.random.
 * The environment is integers only, which is what makes the Python and JS state comparison
 * exact rather than tolerance based. The only floats are the seeded generator's random()
 * and the per tile scorer's forward pass.
 *
 * This is an integer for integer port of _tests/twoengineers/proto/env.py, of the doctrines
 * of proto/doctrines.py, and of the feature encoder and build loop of proto/train_smoke.py.
 * It carries TWO boards: map v5, the shipped world (build spec v3 section 7.4 ruling 1),
 * and map v4, kept because every fixture, dump and art reference recorded before
 * 2026-09-06 is a v4 recording. KeepCore.MAP names the active one and KeepCore.setMap
 * switches it; nothing outside the map block hard codes either board. Where the Python leans on a language detail (dict insertion order,
 * list order, tuple comparison, the order float sums accumulate in) the port reproduces the
 * detail rather than the intent, because the parity fixtures compare hashes and not vibes.
 *
 * Attaches to self / globalThis, never window: this file runs inside a Web Worker where
 * window is undefined and an assignment there is a silent boot failure.
 */
(function (root) {
  'use strict';

  var KeepCore = {};
  KeepCore.VERSION = 1;

  var INF = 1073741824;              /* 1 << 30, the same INF env.py uses */
  KeepCore.INF = INF;

  /* ------------------------------------------------------------------ CPython random
   *
   * env.Episode draws its whole episode from random.Random(seed * 7919 + 13). Reproducing
   * CPython's Mersenne Twister and its exact randint / shuffle / choice / choices algorithms
   * is the only way a JS episode equals a Python episode, so the port is literal. See the
   * PyRandom entry in _tests/twoengineers/INTERFACES.md.
   */

  var N_MT = 624, M_MT = 397, MATRIX_A = 0x9908b0df;
  var UPPER_MASK = 0x80000000, LOWER_MASK = 0x7fffffff;

  function PyRandom(seed) {
    this.mt = new Uint32Array(N_MT);
    this.mti = N_MT + 1;
    this.seed(seed);
  }

  PyRandom.prototype._initGenrand = function (s) {
    var mt = this.mt;
    mt[0] = s >>> 0;
    for (var i = 1; i < N_MT; i++) {
      var prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
    this.mti = N_MT;
  };

  PyRandom.prototype._initByArray = function (key) {
    this._initGenrand(19650218);
    var mt = this.mt;
    var i = 1, j = 0;
    var k = N_MT > key.length ? N_MT : key.length;
    for (; k; k--) {
      var p = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (((mt[i] ^ Math.imul(p, 1664525)) >>> 0) + key[j] + j) >>> 0;
      i++; j++;
      if (i >= N_MT) { mt[0] = mt[N_MT - 1]; i = 1; }
      if (j >= key.length) j = 0;
    }
    for (k = N_MT - 1; k; k--) {
      var q = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (((mt[i] ^ Math.imul(q, 1566083941)) >>> 0) - i) >>> 0;
      i++;
      if (i >= N_MT) { mt[0] = mt[N_MT - 1]; i = 1; }
    }
    mt[0] = 0x80000000;
  };

  /* CPython random_seed: for an integer argument it takes abs(n), splits it into 32 bit
   * words least significant first, and calls init_by_array. A zero gives the key [0]. */
  function keyFromInt(n) {
    n = Math.abs(n);
    if (!isFinite(n)) throw new Error('PyRandom: seed must be finite');
    n = Math.floor(n);
    if (n === 0) return [0];
    var key = [];
    while (n > 0) {
      key.push((n % 4294967296) >>> 0);
      n = Math.floor(n / 4294967296);
    }
    return key;
  }

  PyRandom.prototype.seed = function (n) { this._initByArray(keyFromInt(n)); };

  PyRandom.prototype.genrand = function () {
    var mt = this.mt, y, kk;
    if (this.mti >= N_MT) {
      for (kk = 0; kk < N_MT - M_MT; kk++) {
        y = ((mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK)) >>> 0;
        mt[kk] = (mt[kk + M_MT] ^ (y >>> 1) ^ ((y & 1) ? MATRIX_A : 0)) >>> 0;
      }
      for (; kk < N_MT - 1; kk++) {
        y = ((mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK)) >>> 0;
        mt[kk] = (mt[kk + (M_MT - N_MT)] ^ (y >>> 1) ^ ((y & 1) ? MATRIX_A : 0)) >>> 0;
      }
      y = ((mt[N_MT - 1] & UPPER_MASK) | (mt[0] & LOWER_MASK)) >>> 0;
      mt[N_MT - 1] = (mt[M_MT - 1] ^ (y >>> 1) ^ ((y & 1) ? MATRIX_A : 0)) >>> 0;
      this.mti = 0;
    }
    y = mt[this.mti++];
    y ^= y >>> 11;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    y ^= y >>> 18;
    return y >>> 0;
  };

  PyRandom.prototype.random = function () {
    var a = this.genrand() >>> 5, b = this.genrand() >>> 6;
    return (a * 67108864 + b) * (1.0 / 9007199254740992.0);
  };

  PyRandom.prototype.getrandbits = function (k) {
    if (k <= 0) throw new Error('getrandbits: k must be positive');
    if (k <= 32) return this.genrand() >>> (32 - k);
    /* CPython fills 32 bit words least significant first, masking the top word. */
    var words = [], left = k;
    while (left > 0) {
      var take = left > 32 ? 32 : left;
      words.push(this.genrand() >>> (32 - take));
      left -= take;
    }
    var out = 0;
    for (var i = words.length - 1; i >= 0; i--) out = out * 4294967296 + words[i];
    return out;
  };

  function bitLength(n) {
    if (n <= 0) return 0;
    if (n < 4294967296) return 32 - Math.clz32(n);
    var b = 0;
    while (n > 0) { n = Math.floor(n / 2); b++; }
    return b;
  }

  PyRandom.prototype._randbelow = function (n) {
    if (n <= 0) return 0;
    var k = bitLength(n);
    var r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  };

  PyRandom.prototype.randint = function (a, b) { return a + this._randbelow(b + 1 - a); };
  PyRandom.prototype.choice = function (seq) { return seq[this._randbelow(seq.length)]; };

  PyRandom.prototype.shuffle = function (x) {
    for (var i = x.length - 1; i >= 1; i--) {
      var j = this._randbelow(i + 1);
      var tmp = x[i]; x[i] = x[j]; x[j] = tmp;
    }
    return x;
  };

  /* bisect.bisect_right(a, v, lo, hi) */
  function bisectRight(a, v, lo, hi) {
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (v < a[mid]) hi = mid; else lo = mid + 1;
    }
    return lo;
  }

  PyRandom.prototype.choices = function (pop, weights) {
    var n = pop.length, cum = new Array(n), acc = 0;
    for (var i = 0; i < n; i++) { acc = acc + weights[i]; cum[i] = acc; }
    var total = cum[n - 1] + 0.0;
    return pop[bisectRight(cum, this.random() * total, 0, n - 1)];
  };

  KeepCore.PyRandom = PyRandom;
  KeepCore.bisectRight = bisectRight;

  /* ------------------------------------------------------------------ config */

  var DEFAULT_CFG = {
    keep_hp: 100,
    dig_cost: 6,
    wall_cost: 2,
    wall_hp: 190,
    turret_cost: 8,
    turret_hp: 40,
    turret_range: 3.2,
    turret_period: 2,
    turret_damage: 5,
    gun_needs_stall: 0,
    walker_hp: 30,
    walker_move_period: 2,
    walker_attack: 5,
    walker_keep_damage: 8,
    wave_walkers: [4, 7, 11],
    wave_walker_jitter: 1,
    gate_weights: [0.7, 0.15, 0.15],
    gate_weights3: [0.55, 0.06, 0.06, 0.06, 0.09, 0.09, 0.09],
    spawn_gap: 4,
    budgets: [18, 12, 12],
    budget_jitter: 2,
    n_rubble: 5,
    n_ruins: 3,
    wave_max_ticks: 600,
    mounted_guns: false,
    focus_fire: 0,
    focus_seats: [0, 0],
    focus_mode: 'smart',
    focus_scope: 'own',
    focus_tier: 'mark'
  };

  function copyCfg(src) {
    var out = {}, k;
    for (k in src) if (Object.prototype.hasOwnProperty.call(src, k)) {
      out[k] = Array.isArray(src[k]) ? src[k].slice() : src[k];
    }
    return out;
  }

  /* doctrines.B_CFG, the winning world of the rule B round */
  var B_CFG = copyCfg(DEFAULT_CFG);
  B_CFG.gun_needs_stall = 1;
  B_CFG.turret_range = 2.0;
  B_CFG.wall_cost = 2;
  B_CFG.turret_cost = 10;
  B_CFG.wall_hp = 400;
  B_CFG.turret_hp = 400;
  B_CFG.turret_damage = 10;
  B_CFG.walker_keep_damage = 5;
  B_CFG.budgets = [22, 1, 1];

  /* The shipped world: B_CFG plus the map v4 overrides of W4-map section 6, and the
   * front loaded 24 / 1 / 1 budget, which is 26 credits per engineer against a 44 credit
   * plan. Nothing outside this object hard codes any of these numbers. */
  var CFG = copyCfg(B_CFG);
  CFG.walker_keep_damage = 4;
  CFG.wave_walkers = [8, 15, 23];
  CFG.budgets = [24, 1, 1];
  CFG.focus_scope = 'own';        /* a mark steers only the marking seat's own guns */
  CFG.focus_tier = 'door';        /* doorstep first: the threshold outranks the mark */

  KeepCore.DEFAULT_CFG = DEFAULT_CFG;
  KeepCore.B_CFG = B_CFG;
  KeepCore.CFG = CFG;
  KeepCore.DOCTRINE_TARGET = 44;
  KeepCore.copyCfg = copyCfg;

  /* INTERFACES T1 pin 1: the same numbers under the names the trainer and the page use.
   * Derived from CFG and from the ACTIVE MAP so there is exactly one source of truth.
   * KeepCore.CONST is rebuilt by applyMap below, so MAP, BUILDABLE_TILES, MIN_CUT and
   * PLAN_COST always describe the board the core is actually playing. */
  function makeConst(mapName) {
    var terr = KeepCore.terrain(mapName);
    var three = terr.gateC.length > 0;
    var yb = [], xb = [], k;
    for (k = 0; k < 5; k++) yb.push((k + 0.5) * terr.h / 5.0);
    for (k = 0; k < 5; k++) xb.push((k + 0.5) * terr.w / 5.0);
    return Object.freeze({
      MAP: mapName, W: terr.w, H: terr.h, BUILDABLE_TILES: terr.buildable.length,
      MIN_CUT: MIN_CUT[mapName], PLAN_COST: TARGETS[mapName],
      GATE_W: terr.gateW.length, GATE_C: terr.gateC.length, GATE_E: terr.gateE.length,
      KEEP_HP: CFG.keep_hp,
      DIG_COST: CFG.dig_cost,
      WALL_COST: CFG.wall_cost, WALL_HP: CFG.wall_hp,
      TURRET_COST: CFG.turret_cost, TURRET_HP: CFG.turret_hp,
      TURRET_RANGE: CFG.turret_range, TURRET_R2: CFG.turret_range * CFG.turret_range,
      TURRET_PERIOD: CFG.turret_period, TURRET_DAMAGE: CFG.turret_damage,
      GUN_NEEDS_STALL: CFG.gun_needs_stall,
      WALKER_HP: CFG.walker_hp, WALKER_MOVE_PERIOD: CFG.walker_move_period,
      WALKER_ATTACK: CFG.walker_attack, WALKER_KEEP_DAMAGE: CFG.walker_keep_damage,
      WAVE_WALKERS: CFG.wave_walkers.slice(), WAVE_WALKER_JITTER: CFG.wave_walker_jitter,
      GATE_WEIGHTS3: CFG.gate_weights3.slice(),
      SPAWN_GAP: CFG.spawn_gap,
      BUDGETS: CFG.budgets.slice(), BUDGET_JITTER: CFG.budget_jitter,
      N_RUBBLE: CFG.n_rubble, N_RUINS: CFG.n_ruins,
      WAVE_MAX_TICKS: CFG.wave_max_ticks,
      MOUNTED_GUNS: CFG.mounted_guns,
      FOCUS_SCOPE: CFG.focus_scope, FOCUS_TIER: CFG.focus_tier, FOCUS_MODE: CFG.focus_mode,
      /* the same expressions makeBoard uses, so CONST and the feature encoder cannot
         disagree about a normaliser on a board neither of them has seen yet */
      DNORM: terr.w + terr.h, ROWMAX: rowMaxOf(terr),
      BNORM: three ? CFG.budgets[0] : 18.0,
      CNORM: three ? (CFG.budgets[0] / CFG.wall_cost) : 12.0,
      DNORM_LIVE: DNORM,
      YSIG: three ? (terr.h / 8.0) : 1.0, XSIG: three ? (terr.w / 8.0) : 1.5,
      YB: three ? yb : YB.slice(), XB: three ? xb : XB.slice()
    });
  }

  KeepCore.makeCfg = function (over) {
    var c = copyCfg(CFG), k;
    if (over) for (k in over) if (Object.prototype.hasOwnProperty.call(over, k)) {
      c[k] = Array.isArray(over[k]) ? over[k].slice() : over[k];
    }
    return c;
  };

  /* ------------------------------------------------------------------ the maps
   *
   * Written as spans, exactly as env._spans_v4 writes it, because every iteration of the
   * design moved rock by one tile and a miscounted row of 28 characters is a silent bug.
   * '#' rock, '.' ground, 'W' west gate, 'C' centre gate, 'E' east gate, 'K' keep.
   *
   * Two boards ship. v5 is the DEFAULT and is the world the trained cast is trained on
   * (build spec v3 section 7.4 ruling 1): map v4 with the CENTRE gorge narrowed from four
   * tiles to three, so all three gorges are the same width. Only rows 0, 1, 3, 4 and 5 of
   * the centre column differ; row 2 and everything below row 5 is v4 tile for tile. The
   * spans below are copied integer for integer from make_keepittogether_model.py MAP_V5
   * and _tests/twoengineers/train/mapv5.py, which are the two authoritative definitions.
   *
   * v4 is kept, exported and fully playable, because every fixture, doctrine dump and art
   * reference recorded before 2026-09-06 is a v4 recording and those regressions must keep
   * running.
   */
  var SPANS_V4 = [
    [['W', 2, 4], ['C', 12, 15], ['E', 23, 25]],
    [['.', 2, 4], ['.', 12, 15], ['.', 23, 25]],
    [['.', 2, 5], ['.', 12, 15], ['.', 22, 25]],
    [['.', 2, 5], ['.', 11, 15], ['.', 23, 25]],
    [['.', 1, 4], ['.', 12, 16], ['.', 23, 26]],
    [['.', 2, 4], ['.', 12, 15], ['.', 23, 25]],
    [['.', 2, 25]],
    [['.', 2, 25]],
    [['.', 2, 25]],
    [['.', 4, 5], ['.', 7, 20], ['.', 22, 23]],
    [['.', 7, 8], ['.', 11, 20]],
    [['.', 7, 8], ['.', 11, 20]],
    [['.', 7, 20]],
    [['.', 7, 20]],
    [['.', 7, 20]],
    [['.', 7, 10], ['K', 11, 14], ['.', 15, 20]],
    [['.', 7, 10], ['K', 11, 14], ['.', 15, 20]],
    [['.', 7, 10], ['K', 11, 14], ['.', 15, 20]]
  ];

  function rowsFromSpans(w, h, spans) {
    var grid = [], y, x, i, row;
    for (y = 0; y < h; y++) {
      row = [];
      for (x = 0; x < w; x++) row.push('#');
      grid.push(row);
    }
    for (y = 0; y < spans.length; y++) {
      for (i = 0; i < spans[y].length; i++) {
        var s = spans[y][i];
        for (x = s[1]; x <= s[2]; x++) grid[y][x] = s[0];
      }
    }
    var out = [];
    for (y = 0; y < h; y++) out.push(grid[y].join(''));
    return out;
  }

  /* Map v5: v4 with the centre gate at x 13 to 15 (three tiles, as west is 2 to 4 and east
   * is 23 to 25), one alcove west on rows 2 and 4 and one alcove east on row 3, which is
   * the same alcove budget the other two gorges carry. 239 buildable tiles. */
  var SPANS_V5 = [
    [['W', 2, 4], ['C', 13, 15], ['E', 23, 25]],
    [['.', 2, 4], ['.', 13, 15], ['.', 23, 25]],
    [['.', 2, 5], ['.', 12, 15], ['.', 22, 25]],
    [['.', 2, 5], ['.', 13, 16], ['.', 23, 25]],
    [['.', 1, 4], ['.', 12, 15], ['.', 23, 26]],
    [['.', 2, 4], ['.', 13, 15], ['.', 23, 25]],
    [['.', 2, 25]],
    [['.', 2, 25]],
    [['.', 2, 25]],
    [['.', 4, 5], ['.', 7, 20], ['.', 22, 23]],
    [['.', 7, 8], ['.', 11, 20]],
    [['.', 7, 8], ['.', 11, 20]],
    [['.', 7, 20]],
    [['.', 7, 20]],
    [['.', 7, 20]],
    [['.', 7, 10], ['K', 11, 14], ['.', 15, 20]],
    [['.', 7, 10], ['K', 11, 14], ['.', 15, 20]],
    [['.', 7, 10], ['K', 11, 14], ['.', 15, 20]]
  ];

  var MAP_V4 = rowsFromSpans(28, 19, SPANS_V4);
  var MAP_V5 = rowsFromSpans(28, 19, SPANS_V5);
  KeepCore.MAPS = { v4: MAP_V4, v5: MAP_V5 };
  KeepCore.SPANS = { v4: SPANS_V4, v5: SPANS_V5 };
  KeepCore.rowsFromSpans = rowsFromSpans;

  /* The doctrine price and the minimum vertex cut are properties of the board, not of the
   * config. Measured, not assumed: train/W5-map.md section 1b measures the minimum vertex
   * cut with two independent implementations (proto/diversity.py unit weights and
   * train/gates_v5.py max flow) on BOTH boards and gets NINE on each. The audited doctrines
   * are a different quantity: v4's eight are ten tile cuts at 44 credits and v5's are nine
   * tile cuts at 42 (three guns at 10, the rest walls at 2 on both boards), because v4's
   * nine tile cut leans on the butte, needs a fourth gun and prices at 50, so 44 stays its
   * cheapest complete plan. The ten that used to sit in the v4 slot here was the Menger
   * UPPER bound from v4's ten gate tiles, not an achieved cut. */
  var TARGETS = { v4: 44, v5: 42 };
  var MIN_CUT = { v4: 9, v5: 9 };
  KeepCore.TARGETS = TARGETS;
  KeepCore.MIN_CUT = MIN_CUT;

  /* The active map. Everything that used to say v4 now asks for this. */
  var DEFAULT_MAP = 'v5';
  var ACTIVE_MAP = DEFAULT_MAP;
  KeepCore.DEFAULT_MAP = DEFAULT_MAP;

  function mapRows(name) {
    var rows = KeepCore.MAPS[name];
    if (!rows) throw new Error('unknown map ' + name + '; known: ' +
      Object.keys(KeepCore.MAPS).join(' '));
    return rows;
  }
  KeepCore.mapRows = mapRows;

  /* Which map a terrain is, by its own rows. Used so a caller that passes a terrain never
   * has to also pass a name, and so a mismatch is impossible rather than merely unlikely. */
  function mapNameOf(terrain) {
    if (!terrain || !terrain.rows) return null;
    var joined = terrain.rows.join('\n'), k;
    for (k in KeepCore.MAPS) {
      if (Object.prototype.hasOwnProperty.call(KeepCore.MAPS, k) &&
        KeepCore.MAPS[k].join('\n') === joined) return k;
    }
    return null;
  }
  KeepCore.mapNameOf = mapNameOf;

  function rowMaxOf(terr) {
    var counts = new Float64Array(terr.h), i, m = 1.0;
    for (i = 0; i < terr.buildable.length; i++) counts[terr.buildable[i][1]] += 1;
    for (i = 0; i < terr.h; i++) if (counts[i] > m) m = counts[i];
    return m;
  }

  var PIECE = { NONE: 0, WALL: 1, TURRET: 2 };
  var OWNER = { NONE: -1, A: 0, B: 1, RUIN: 2 };
  KeepCore.PIECE = PIECE;
  KeepCore.OWNER = OWNER;
  var WALL = PIECE.WALL, TURRET = PIECE.TURRET;

  var NEIGH = [[0, -1], [-1, 0], [1, 0], [0, 1]];
  KeepCore.NEIGH = NEIGH;

  /* ------------------------------------------------------------------ terrain */

  function makeTerrain(rows) {
    var t = {};
    t.rows = rows.slice();
    t.h = rows.length;
    t.w = rows[0].length;
    var y, x, i, c, k, k2;
    for (i = 0; i < rows.length; i++) {
      if (rows[i].length !== t.w) throw new Error('ragged map row ' + i);
    }
    t.cell = [];
    for (y = 0; y < t.h; y++) t.cell.push(rows[y].split(''));
    t.keep = []; t.gateW = []; t.gateE = []; t.gateC = []; t.buildable = [];
    for (y = 0; y < t.h; y++) for (x = 0; x < t.w; x++) {
      c = t.cell[y][x];
      if (c === 'K') t.keep.push([x, y]);
      else if (c === 'W') t.gateW.push([x, y]);
      else if (c === 'E') t.gateE.push([x, y]);
      else if (c === 'C') t.gateC.push([x, y]);
      else if (c === '.') t.buildable.push([x, y]);
    }
    if (!t.keep.length || !t.gateW.length || !t.gateE.length) {
      throw new Error('map needs a keep and a west and an east gate');
    }
    t.passableAt = function (px, py) {
      if (px < 0 || py < 0 || px >= t.w || py >= t.h) return false;
      var ch = t.cell[py][px];
      return ch === '.' || ch === 'W' || ch === 'E' || ch === 'C';
    };
    var n = t.w * t.h;
    t.n = n;
    t.pass = new Uint8Array(n);
    t.isKeep = new Uint8Array(n);
    t.isGround = new Uint8Array(n);
    for (y = 0; y < t.h; y++) for (x = 0; x < t.w; x++) {
      i = y * t.w + x;
      c = t.cell[y][x];
      t.pass[i] = t.passableAt(x, y) ? 1 : 0;
      t.isKeep[i] = (c === 'K') ? 1 : 0;
      t.isGround[i] = (c === '.') ? 1 : 0;
    }
    /* passable neighbours of every passable-or-keep tile, in NEIGH order
       (env.Terrain._build_pnbrs) */
    t.pnbrs = new Array(n);
    for (y = 0; y < t.h; y++) for (x = 0; x < t.w; x++) {
      i = y * t.w + x;
      if (!(t.pass[i] || t.isKeep[i])) { t.pnbrs[i] = null; continue; }
      var list = [];
      for (k = 0; k < 4; k++) {
        var nx = x + NEIGH[k][0], ny = y + NEIGH[k][1];
        if (nx < 0 || ny < 0 || nx >= t.w || ny >= t.h) continue;
        if (t.pass[ny * t.w + nx]) list.push(ny * t.w + nx);
      }
      t.pnbrs[i] = list;
    }
    /* in bounds neighbours in NEIGH order, which the dig fallback walks (it also
       considers the keep, which is not passable) */
    t.nbrs = new Array(n);
    for (y = 0; y < t.h; y++) for (x = 0; x < t.w; x++) {
      i = y * t.w + x;
      var l2 = [];
      for (k2 = 0; k2 < 4; k2++) {
        var mx = x + NEIGH[k2][0], my = y + NEIGH[k2][1];
        if (mx < 0 || my < 0 || mx >= t.w || my >= t.h) continue;
        l2.push(my * t.w + mx);
      }
      t.nbrs[i] = l2;
    }
    t.keepIdx = t.keep.map(function (p) { return p[1] * t.w + p[0]; });
    t.gateTiles = t.gateW.concat(t.gateE).concat(t.gateC);
    t.buildableIdx = t.buildable.map(function (p) { return p[1] * t.w + p[0]; });
    return t;
  }
  KeepCore.makeTerrain = makeTerrain;

  /* One memoized terrain per map. terrain() with no argument is the ACTIVE map, which is
   * what every existing caller wants; terrain('v4') is how a v4 regression asks for the
   * old board without moving the active one. */
  var _terrains = {};
  KeepCore.terrain = function (name) {
    name = name || ACTIVE_MAP;
    if (!_terrains[name]) _terrains[name] = makeTerrain(mapRows(name));
    return _terrains[name];
  };

  /* ------------------------------------------------------------------ episode (law D1)
   *
   * Randomized per episode: which gates are live in each wave and how the wave splits
   * between them, wave size, five rubble tiles, three ruined wall stubs, and the per
   * engineer per wave budget jitter. The map itself never moves.
   */

  /* Python's round() is round half to even and returns an int. int(round(x)) is that. */
  function pyRound(x) {
    var f = Math.floor(x);
    var diff = x - f;
    if (diff > 0.5) return f + 1;
    if (diff < 0.5) return f;
    return (f % 2 === 0) ? f : f + 1;
  }
  KeepCore.pyRound = pyRound;

  function indexOfMax(a) {
    var bi = 0, i;
    for (i = 1; i < a.length; i++) if (a[i] > a[bi]) bi = i;
    return bi;
  }
  function indexOfMin(a) {
    var bi = 0, i;
    for (i = 1; i < a.length; i++) if (a[i] < a[bi]) bi = i;
    return bi;
  }
  function sumOf(a) {
    var s = 0, i;
    for (i = 0; i < a.length; i++) s += a[i];
    return s;
  }

  /* CPython 3.12 and later sum() floats with NEUMAIER compensated summation, so a plain
   * left to right loop disagrees with it: sum([0.4, 0.2, 0.6]) is 1.2 in python and
   * 1.2000000000000002 in a naive JS loop, and that one bit moved a whole wave's split
   * between the gates on 25 of 2,000 seeds. The int seed (0) plus the first float is a
   * plain add, then the remaining items are compensated, which is exactly what
   * builtin_sum_impl does. */
  function pySumFloat(a) {
    if (!a.length) return 0;
    var f = a[0], c = 0.0;
    for (var i = 1; i < a.length; i++) {
      var x = a[i];
      var t = f + x;
      if (Math.abs(f) >= Math.abs(x)) c += (f - t) + x;
      else c += (x - t) + f;
      f = t;
    }
    return f + c;
  }
  KeepCore.pySumFloat = pySumFloat;

  var SPLIT3_MODES = ['all', 'west', 'centre', 'east', 'wc', 'ce', 'we'];
  var SPLIT3_LIVE = { all: 'wce', west: 'w', centre: 'c', east: 'e', wc: 'wc', ce: 'ce', we: 'we' };
  var SHARE_CHOICES = [0.2, 0.3, 0.4, 0.5, 0.6];

  function split3(rng, n, cfg) {
    var mode = rng.choices(SPLIT3_MODES, cfg.gate_weights3);
    var live = SPLIT3_LIVE[mode];
    var shares = [], i;
    for (i = 0; i < live.length; i++) shares.push(rng.choice(SHARE_CHOICES));
    var tot = pySumFloat(shares);
    var counts = [];
    for (i = 0; i < shares.length; i++) counts.push(Math.max(1, pyRound(n * shares[i] / tot)));
    while (sumOf(counts) > n && Math.max.apply(null, counts) > 1) counts[indexOfMax(counts)] -= 1;
    while (sumOf(counts) < n) counts[indexOfMin(counts)] += 1;
    var out = { w: 0, c: 0, e: 0 };
    for (i = 0; i < live.length; i++) out[live.charAt(i)] = counts[i];
    return { west: out.w, centre: out.c, east: out.e, mode: mode };
  }

  var TWO_GATE_MODES = ['both', 'west', 'east'];

  function makeEpisode(seed, terrain, cfg) {
    terrain = terrain || KeepCore.terrain();
    cfg = cfg || CFG;
    var rng = new PyRandom(seed * 7919 + 13);
    var w = terrain.w;

    var pool = terrain.buildable.slice();
    rng.shuffle(pool);
    var rubble = pool.slice(0, cfg.n_rubble);
    var ruins = pool.slice(cfg.n_rubble, cfg.n_rubble + cfg.n_ruins);

    var three = terrain.gateC.length > 0;
    var waves = [], wi, i;
    for (wi = 0; wi < 3; wi++) {
      var n = cfg.wave_walkers[wi];
      n += rng.randint(-cfg.wave_walker_jitter, cfg.wave_walker_jitter);
      if (n < 2) n = 2;
      var nw, nc, ne, mode;
      if (three) {
        var sp = split3(rng, n, cfg);
        nw = sp.west; nc = sp.centre; ne = sp.east; mode = sp.mode;
      } else {
        nc = 0;
        mode = rng.choices(TWO_GATE_MODES, cfg.gate_weights);
        if (mode === 'both') {
          var share = rng.choice(SHARE_CHOICES);
          nw = Math.max(1, Math.min(n - 1, pyRound(n * share)));
          ne = n - nw;
        } else if (mode === 'west') { nw = n; ne = 0; } else { nw = 0; ne = n; }
      }
      var gap = cfg.spawn_gap + rng.randint(-1, 1);
      waves.push({
        mode: mode, west: nw, centre: nc, east: ne,
        gap: Math.max(2, gap), offset: rng.randint(0, 3)
      });
    }

    var budgets = [];
    for (wi = 0; wi < 3; wi++) {
      var base = cfg.budgets[wi], j = cfg.budget_jitter;
      budgets.push([base + rng.randint(-j, j), base + rng.randint(-j, j)]);
    }

    var ep = {
      seed: seed,
      terrain: terrain,
      cfg: cfg,
      rubble: rubble.map(function (p) { return p[1] * w + p[0]; }),
      ruins: ruins.map(function (p) { return p[1] * w + p[0]; }),
      rubbleXY: rubble,
      ruinsXY: ruins,
      waves: waves,
      budgets: budgets
    };
    ep.rubbleSet = new Set(ep.rubble);
    ep.ruinSet = new Set(ep.ruins);
    return ep;
  }
  KeepCore.makeEpisode = makeEpisode;

  /* A fixture episode, already resolved. INTERFACES T1 pin 5: parity never depends on the
   * generator, so both parity fixtures carry their episode fully drawn and the replay
   * loads it rather than redrawing it. (makeEpisode reproduces CPython exactly anyway,
   * verified over 2,000 seeds, but a fixture must not lean on that.) */
  function episodeFromRecord(rec, terrain, cfg) {
    terrain = terrain || KeepCore.terrain();
    cfg = cfg || CFG;
    var w = terrain.w;
    function flat(p) { return Array.isArray(p) ? p[1] * w + p[0] : p; }
    var ep = {
      seed: rec.seed,
      terrain: terrain,
      cfg: cfg,
      rubble: rec.rubble.map(flat),
      ruins: rec.ruins.map(flat),
      rubbleXY: rec.rubble.map(function (p) { return Array.isArray(p) ? p : [p % w, (p / w) | 0]; }),
      ruinsXY: rec.ruins.map(function (p) { return Array.isArray(p) ? p : [p % w, (p / w) | 0]; }),
      waves: rec.waves.map(function (v) {
        return {
          mode: v.mode, west: v.west, centre: v.centre, east: v.east,
          gap: v.gap, offset: v.offset
        };
      }),
      budgets: rec.budgets.map(function (b) { return [b[0], b[1]]; })
    };
    ep.rubbleSet = new Set(ep.rubble);
    ep.ruinSet = new Set(ep.ruins);
    return ep;
  }
  KeepCore.episodeFromRecord = episodeFromRecord;

  /* An episode with nothing scattered on it. Cut geometry and the static feature block are
   * properties of the map and not of the episode, so both use this. */
  function emptyEpisode(terrain, cfg) {
    return {
      seed: 0, terrain: terrain, cfg: cfg,
      rubble: [], ruins: [], rubbleXY: [], ruinsXY: [],
      rubbleSet: new Set(), ruinSet: new Set(),
      waves: [], budgets: []
    };
  }
  KeepCore.emptyEpisode = emptyEpisode;

  /* ------------------------------------------------------------------ focus fire
   *
   * Rule variant C, the visitor's call the shot verb. A mark only reorders the preference
   * inside a gun's existing target set: it adds no credits, changes no reach, and never
   * makes an illegal target legal. Shipped pins: scope 'own', tier 'door'.
   */

  function FocusPolicy(seats, mode, scope, tier) {
    this.seats = [!!seats[0], !!seats[1]];
    this.mode = mode || 'smart';
    this.scope = scope || 'own';
    this.tier = tier || 'mark';
    this.mark = [null, null];
    this.taps = [0, 0];
    this.drops = [0, 0];
    if (this.scope === 'all' && this.seats[0] && this.seats[1]) {
      throw new Error("focus_scope 'all' is ambiguous with both seats on");
    }
  }

  FocusPolicy.prototype.markFor = function (owner) {
    if (owner !== 0 && owner !== 1) return null;
    if (this.scope === 'all') {
      for (var side = 0; side < 2; side++) if (this.seats[side]) return this.mark[side];
      return null;
    }
    if (!this.seats[owner]) return null;
    return this.mark[owner];
  };

  /* the sort key a gun uses for one candidate walker; lower wins */
  FocusPolicy.prototype.key = function (wk, mark, dd) {
    if (this.tier === 'door') {
      if (dd <= 1) return [0, dd, wk.wid];
      return [wk.wid === mark ? 1 : 2, dd, wk.wid];
    }
    return [wk.wid === mark ? 0 : 1, dd, wk.wid];
  };

  FocusPolicy.prototype.update = function (g, walkers, d, rng2) {
    var live = new Map(), i, side, wk;
    for (i = 0; i < walkers.length; i++) if (walkers[i].hp > 0) live.set(walkers[i].wid, walkers[i]);
    var need = false;
    for (side = 0; side < 2; side++) {
      if (!this.seats[side]) continue;
      var cur = this.mark[side];
      if (cur !== null) {
        wk = live.get(cur);
        if (wk !== undefined && wk.atk) continue;
        this.mark[side] = null;
        this.drops[side] += 1;
      }
      need = true;
    }
    if (!need) return;
    var cand = this._planted(g, walkers, d, rng2);
    if (!cand.length) return;
    for (side = 0; side < 2; side++) {
      if (!this.seats[side] || this.mark[side] !== null) continue;
      var pick = this._pick(side, cand);
      if (pick !== null) { this.mark[side] = pick; this.taps[side] += 1; }
    }
  };

  FocusPolicy.prototype._planted = function (g, walkers, d, rng2) {
    var guns = [], out = [], i;
    g.struct.forEach(function (s, cell) {
      if (s.kind === TURRET && (s.owner === 0 || s.owner === 1)) {
        guns.push([cell % g.t.w, (cell / g.t.w) | 0, s.owner]);
      }
    });
    for (i = 0; i < walkers.length; i++) {
      var wk = walkers[i];
      if (wk.hp <= 0 || !wk.atk) continue;
      var g0 = 0, g1 = 0;
      for (var k = 0; k < guns.length; k++) {
        var dx = wk.x - guns[k][0], dy = wk.y - guns[k][1];
        if (dx * dx + dy * dy > rng2) continue;
        if (guns[k][2]) g1 += 1; else g0 += 1;
      }
      out.push([wk.wid, wk.hp, d[wk.cell], g0, g1]);
    }
    return out;
  };

  function tupleLess(a, b) {
    for (var i = 0; i < a.length && i < b.length; i++) {
      if (a[i] < b[i]) return true;
      if (a[i] > b[i]) return false;
    }
    return a.length < b.length;
  }
  KeepCore.tupleLess = tupleLess;

  FocusPolicy.prototype._pick = function (side, cand) {
    var best = null, bestkey = null;
    for (var i = 0; i < cand.length; i++) {
      var wid = cand[i][0], hp = cand[i][1], dd = cand[i][2], g0 = cand[i][3], g1 = cand[i][4];
      var reach = (this.scope === 'all') ? (g0 + g1) : (side ? g1 : g0);
      var key;
      if (this.mode === 'smart') {
        if (reach <= 0) continue;
        key = [-reach, hp, wid];
      } else if (this.mode === 'naive') {
        key = [dd, wid];
      } else {
        key = [-dd, -hp, wid];
      }
      if (bestkey === null || tupleLess(key, bestkey)) { bestkey = key; best = wid; }
    }
    return best;
  };

  KeepCore.FocusPolicy = FocusPolicy;

  /* The page's entry point for the visitor's call the shot verb (SEAM P-S7). A tap marks
   * ONE walker that is currently planted; the mark steers only that seat's own guns and is
   * outranked by a walker already on the keep's doorstep. Returns true when the mark was
   * taken. It adds no credits, changes no reach and makes no illegal target legal. */
  KeepCore.setFocus = function (g, ws, seat, wid) {
    if (seat !== 0 && seat !== 1) return false;
    if (!g.focus) {
      var seats = [0, 0];
      seats[seat] = 1;
      g.focus = new FocusPolicy(seats, g.cfg.focus_mode || 'smart',
        g.cfg.focus_scope || 'own', g.cfg.focus_tier || 'door');
    }
    if (!g.focus.seats[seat]) return false;
    if (wid === null || wid === undefined) { g.focus.mark[seat] = null; return true; }
    var wk = null;
    if (ws) for (var i = 0; i < ws.walkers.length; i++) {
      if (ws.walkers[i].wid === wid) { wk = ws.walkers[i]; break; }
    }
    if (!wk || wk.hp <= 0 || !wk.atk) return false;    /* a mover is never a legal mark */
    g.focus.mark[seat] = wid;
    g.focus.taps[seat] += 1;
    return true;
  };

  /* The mark drops the moment its walker dies or starts walking again. The page can call
   * this each tick; the firing loop also drops it on its own. */
  KeepCore.pruneFocus = function (g, ws) {
    if (!g.focus) return;
    for (var seat = 0; seat < 2; seat++) {
      var cur = g.focus.mark[seat];
      if (cur === null) continue;
      var live = null;
      if (ws) for (var i = 0; i < ws.walkers.length; i++) {
        if (ws.walkers[i].wid === cur) { live = ws.walkers[i]; break; }
      }
      if (!live || live.hp <= 0 || !live.atk) {
        g.focus.mark[seat] = null;
        g.focus.drops[seat] += 1;
      }
    }
  };

  KeepCore.focusMark = function (g, seat) {
    return (g.focus && g.focus.mark[seat] !== undefined) ? g.focus.mark[seat] : null;
  };

  function makeFocus(cfg) {
    if (!cfg.focus_fire) return null;
    var seats = cfg.focus_seats || [0, 0];
    if (!(seats[0] || seats[1])) return null;
    return new FocusPolicy(seats, cfg.focus_mode, cfg.focus_scope, cfg.focus_tier);
  }

  /* ------------------------------------------------------------------ game */

  function newGame(ep, cfg) {
    cfg = cfg || ep.cfg || CFG;
    var g = {
      ep: ep,
      cfg: cfg,
      t: ep.terrain,
      keepHp: cfg.keep_hp,
      struct: new Map(),
      spent: [0, 0],
      /* INTERFACES SEAM T2a-S1, line 1 of 3: structures of each seat destroyed in the
       * wave that is running (or in the wave that just ran, between waves). Bookkeeping
       * only: nothing in the sim, the RNG or hashState reads it, and boardSummary
       * feature 34 is its one consumer. */
      lost: [0, 0],
      leaks: 0,
      log: [],
      _dist: null,
      _dig: null,
      _turretList: null,
      focus: makeFocus(cfg)
    };
    /* the ruined stubs nobody paid for */
    for (var i = 0; i < ep.ruins.length; i++) {
      g.struct.set(ep.ruins[i], {
        kind: WALL, hp: cfg.wall_hp, max: cfg.wall_hp, owner: OWNER.RUIN
      });
    }
    return g;
  }
  KeepCore.newGame = newGame;

  /* SEAM P-S1: one call that starts a fresh state without going through playEpisode.
   *
   *   newState(ep)                  an already drawn episode
   *   newState(seed)                a seed, on the ACTIVE map
   *   newState(seed, 'v4')          a seed, on a named map
   *   newState(seed, {map, cfg, terrain})
   *   newState({seed, map, cfg})
   *
   * The optional map name is the whole point of the second argument: the page and the
   * strangers grid ask for the active board and get it, and a v4 regression asks for v4
   * by name without moving the active map for anyone else.
   */
  function newState(a, b) {
    var opts = (typeof b === 'string') ? { map: b } : (b || {});
    var seed = a, ep = null;
    if (a && typeof a === 'object') {
      if (a.terrain && a.waves) ep = a;             /* an episode record already resolved */
      else {
        seed = a.seed;
        if (a.map !== undefined && opts.map === undefined) opts.map = a.map;
        if (a.cfg !== undefined && opts.cfg === undefined) opts.cfg = a.cfg;
        if (a.terrain !== undefined && opts.terrain === undefined) opts.terrain = a.terrain;
      }
    }
    var cfg = opts.cfg || (ep && ep.cfg) || CFG;
    if (!ep) {
      var terrain = opts.terrain || KeepCore.terrain(opts.map);
      if (seed === undefined || seed === null) {
        throw new Error('newState needs an episode or a seed');
      }
      ep = makeEpisode(seed, terrain, cfg);
    }
    return newGame(ep, cfg);
  }
  KeepCore.newState = newState;

  function canBuild(g, x, y) {
    var t = g.t;
    if (x < 0 || y < 0 || x >= t.w || y >= t.h) return false;
    var i = y * t.w + x;
    if (!t.isGround[i]) return false;
    if (g.ep.rubbleSet.has(i)) return false;
    if (g.struct.has(i)) return false;
    return true;
  }
  KeepCore.canBuild = canBuild;

  /* rule variant A, off in the shipped world: a gun mounts only on a standing wall an
   * engineer paid for. */
  function canMount(g, x, y) {
    var t = g.t;
    if (x < 0 || y < 0 || x >= t.w || y >= t.h) return false;
    var s = g.struct.get(y * t.w + x);
    if (s === undefined || s.kind !== WALL) return false;
    return s.owner === 0 || s.owner === 1;
  }
  KeepCore.canMount = canMount;

  function place(g, x, y, kind, owner) {
    var i = y * g.t.w + x;
    var prev = g.struct.get(i);
    var maxhp = (kind === WALL) ? g.cfg.wall_hp : g.cfg.turret_hp;
    var s = { kind: kind, hp: maxhp, max: maxhp, owner: owner };
    if (prev !== undefined && prev.kind === WALL && kind === TURRET) s.wallOwner = prev.owner;
    g.struct.set(i, s);
    g._dist = null;
    g._dig = null;
    g._turretList = null;
    return s;
  }
  KeepCore.place = place;

  /* Between waves the crews patch what still stands, for free. Destroyed structures are
   * gone and must be paid for again. */
  function repairAll(g) {
    g.struct.forEach(function (s) { s.hp = s.max; });
  }
  KeepCore.repairAll = repairAll;

  function openTile(g, x, y) {
    var t = g.t;
    if (x < 0 || y < 0 || x >= t.w || y >= t.h) return false;
    var i = y * t.w + x;
    return t.pass[i] === 1 && !g.struct.has(i);
  }
  KeepCore.openTile = openTile;

  /* dist: BFS from the keep over OPEN tiles only (structures block while standing).
   * A walker with a finite dist walks down that gradient and never attacks anything. */
  function dist(g) {
    if (g._dist !== null) return g._dist;
    var t = g.t, n = t.n, d = new Int32Array(n), i;
    for (i = 0; i < n; i++) d[i] = INF;
    var q = new Int32Array(n), head = 0, tail = 0;
    for (i = 0; i < t.keepIdx.length; i++) { d[t.keepIdx[i]] = 0; q[tail++] = t.keepIdx[i]; }
    var struct = g.struct;
    while (head < tail) {
      var c = q[head++], nd = d[c] + 1, list = t.pnbrs[c];
      for (var k = 0; k < list.length; k++) {
        var nb = list[k];
        if (d[nb] > nd && !struct.has(nb)) { d[nb] = nd; q[tail++] = nb; }
      }
    }
    g._dist = d;
    return d;
  }
  KeepCore.dist = dist;

  /* dig: Dijkstra from the keep over all non rock tiles, cost 1 to enter an open tile and
   * dig_cost to enter a structure tile. A boxed in walker follows this gradient and
   * attacks the first structure on it. */
  function dig(g) {
    if (g._dig !== null) return g._dig;
    var t = g.t, n = t.n, d = new Int32Array(n), i;
    for (i = 0; i < n; i++) d[i] = INF;
    var cost = g.cfg.dig_cost, struct = g.struct;
    /* binary heap of [d, cell]; only the settled distances are read, and they are unique,
     * so the tie order inside the heap cannot change the answer */
    var hd = [], hc = [];
    function push(dv, c) {
      hd.push(dv); hc.push(c);
      var i2 = hd.length - 1;
      while (i2 > 0) {
        var p = (i2 - 1) >> 1;
        if (hd[p] <= hd[i2]) break;
        var td = hd[p]; hd[p] = hd[i2]; hd[i2] = td;
        var tc = hc[p]; hc[p] = hc[i2]; hc[i2] = tc;
        i2 = p;
      }
    }
    function pop() {
      var topD = hd[0], topC = hc[0], last = hd.length - 1;
      hd[0] = hd[last]; hc[0] = hc[last]; hd.pop(); hc.pop();
      var i2 = 0, len = hd.length;
      for (;;) {
        var l = 2 * i2 + 1, r = l + 1, m = i2;
        if (l < len && hd[l] < hd[m]) m = l;
        if (r < len && hd[r] < hd[m]) m = r;
        if (m === i2) break;
        var td = hd[m]; hd[m] = hd[i2]; hd[i2] = td;
        var tc = hc[m]; hc[m] = hc[i2]; hc[i2] = tc;
        i2 = m;
      }
      return [topD, topC];
    }
    for (i = 0; i < t.keepIdx.length; i++) { d[t.keepIdx[i]] = 0; push(0, t.keepIdx[i]); }
    while (hd.length) {
      var top = pop(), cur = top[0], c = top[1];
      if (cur > d[c]) continue;
      var list = t.pnbrs[c];
      for (var k = 0; k < list.length; k++) {
        var nb = list[k];
        var nd = cur + (struct.has(nb) ? cost : 1);
        if (nd < d[nb]) { d[nb] = nd; push(nd, nb); }
      }
    }
    g._dig = d;
    return d;
  }
  KeepCore.dig = dig;

  /* ------------------------------------------------------------------ the wave
   *
   * env.Game.run_wave, split into an init, a per tick step and a finish so the page can
   * animate the same loop the headless runner walks. runWave below is that loop, so there
   * is exactly one set of rules and no second code path.
   */

  function emptyEv(tick) {
    return {
      tick: tick, shots: [], kills: [], hits: [], moves: [], spawns: [],
      arrivals: [], chews: [], keepHit: 0,
      /* SEAM P-S4: the sound layer needs to know WHOSE gun fired, WHAT fell and WHERE a
       * body died. All three are additive: killed sits beside kills, which keeps its
       * pinned shape, and the two owner fields ride on records that already existed. */
      killed: [],
      /* SEAM P-S4, second pass. broke is the breaking hits lifted out of hits, in the same
       * order, so the page reads a list instead of scanning for a flag; hurt is the bodies
       * a volley damaged and did not kill, which no other field carries; keepFell is true
       * on the one tick that takes the keep to zero. Every one of them is what the page
       * already derives, computed where the fact happens instead of by diffing after it.
       * A wind-up is NOT here: core has no wind-up phase, so emitting one would be an
       * invention rather than a record. */
      broke: [], hurt: [], keepFell: false
    };
  }

  /* Returned when a caller asked for no event record. It is never written to, and it lets
   * waveTick keep its pinned contract: null means the wave loop ended, anything else means
   * a tick body ran. */
  var NO_EV = emptyEv(-1);
  KeepCore.NO_EV = NO_EV;

  /* SEAM P-S4: the bodies a volley damaged and did not kill. It runs AFTER the removal
   * loop, so a walker the shots list names and the walker list no longer holds is dead and
   * belongs to kills, not here. One record per body in the order the shots were fired,
   * carrying the total damage it took this tick, so two guns on one walker are one sound. */
  function collectHurt(ev, walkers) {
    var shots = ev.shots, i, j, wid, at, vic;
    for (i = 0; i < shots.length; i++) {
      wid = shots[i].wid;
      vic = null;
      for (j = 0; j < walkers.length; j++) {
        if (walkers[j].wid === wid) { vic = walkers[j]; break; }
      }
      if (vic === null) continue;
      at = -1;
      for (j = 0; j < ev.hurt.length; j++) if (ev.hurt[j].wid === wid) { at = j; break; }
      if (at >= 0) ev.hurt[at].dmg += shots[i].dmg;
      else ev.hurt.push({ wid: wid, cell: vic.cell, hp: vic.hp, dmg: shots[i].dmg });
    }
  }

  function turretList(g) {
    if (g._turretList !== null && g._turretList !== undefined) return g._turretList;
    var out = [];
    var it = g.struct.entries(), r;
    while (!(r = it.next()).done) {
      if (r.value[1].kind === TURRET) out.push(r.value[0]);
    }
    g._turretList = out;
    return out;
  }

  function breakStruct(g, cell) {
    /* SEAM T2a-S1, line 3 of 3: the trainer counts the loss where the structure is
     * deleted, and this is the only place core deletes one. Ruins (owner 2) are nobody's
     * loss, which is why the owner is tested rather than assumed. */
    var gone = g.struct.get(cell);
    if (gone !== undefined && (gone.owner === 0 || gone.owner === 1)) g.lost[gone.owner] += 1;
    g.struct.delete(cell);
    g._dist = null;
    g._dig = null;
    g._turretList = null;
  }

  function waveInit(g, waveIndex) {
    var t = g.t, w = g.ep.waves[waveIndex], i;
    /* SEAM T2a-S1, line 2 of 3: env.run_wave clears the ledger at the top of the wave,
     * right after the wave index is set, so a summary taken during a build phase reports
     * what the PREVIOUS wave destroyed. waveInit is core's top of the wave. */
    g.lost = [0, 0];
    var queue = [], wid = 0;
    var west = t.gateW, east = t.gateE, centre = t.gateC;
    for (i = 0; i < w.west; i++) {
      var tw = west[(i + w.offset) % west.length];
      queue.push([w.offset + i * w.gap, tw[0], tw[1], wid]); wid++;
    }
    for (i = 0; i < w.east; i++) {
      var te = east[(i + w.offset) % east.length];
      queue.push([w.offset + i * w.gap, te[0], te[1], wid]); wid++;
    }
    for (i = 0; i < (w.centre || 0); i++) {
      var tc = centre[(i + w.offset) % centre.length];
      queue.push([w.offset + i * w.gap, tc[0], tc[1], wid]); wid++;
    }
    /* python sorts the tuples (time, (x, y), wid) */
    queue.sort(function (a, b) {
      if (a[0] !== b[0]) return a[0] - b[0];
      if (a[1] !== b[1]) return a[1] - b[1];
      if (a[2] !== b[2]) return a[2] - b[2];
      return a[3] - b[3];
    });
    return {
      wave: waveIndex, queue: queue, qi: 0, walkers: [], occupied: new Map(),
      tick: 0, arrived: 0, killed: 0, done: false, finished: false,
      /* SEAM P-S4: keepFell is true once the keep reached zero during THIS wave, whether
       * that happened on a tick or on the leftover clause in waveFinish; held is null
       * until waveFinish decides it. Neither is hashed: hashState reads the walker list
       * and nothing else off the wave state. */
      keepFell: false, held: null
    };
  }
  KeepCore.waveInit = waveInit;

  function turretsFire(g, walkers, ev) {
    var cfg = g.cfg;
    var rng2 = cfg.turret_range * cfg.turret_range;
    var d = dist(g), dg = dig(g);
    var stallOnly = cfg.gun_needs_stall;
    var focus = g.focus;
    if (focus !== null) focus.update(g, walkers, d, rng2);
    var guns = turretList(g), w = g.t.w;
    for (var gi = 0; gi < guns.length; gi++) {
      var cell = guns[gi], s = g.struct.get(cell);
      var tx = cell % w, ty = (cell / w) | 0;
      var mark = (focus === null) ? null : focus.markFor(s.owner);
      var best = null, bestkey = null;
      for (var i = 0; i < walkers.length; i++) {
        var wk = walkers[i];
        if (wk.hp <= 0) continue;
        if (stallOnly && !(wk.atk || d[wk.cell] <= 1)) continue;
        var dx = wk.x - tx, dy = wk.y - ty;
        if (dx * dx + dy * dy > rng2) continue;
        var dd = d[wk.cell];
        if (dd >= INF) dd = INF + dg[wk.cell];
        var key = (mark === null) ? [dd, wk.wid] : focus.key(wk, mark, dd);
        if (bestkey === null || tupleLess(key, bestkey)) { bestkey = key; best = wk; }
      }
      if (best !== null) {
        best.hp -= cfg.turret_damage;
        if (ev) ev.shots.push({ from: cell, to: best.cell, wid: best.wid, dmg: cfg.turret_damage,
          owner: s.owner });
      }
    }
  }

  function stepDown(g, wk, d, cur, occupied, ev) {
    var t = g.t, w = t.w;
    var rot = wk.wid % 4;
    var forward = [], lateral = [];
    for (var k = 0; k < 4; k++) {
      var nd = NEIGH[(rot + k) % 4];
      var nx = wk.x + nd[0], ny = wk.y + nd[1];
      if (!openTile(g, nx, ny)) continue;
      var cell = ny * w + nx, v = d[cell];
      if (v === cur - 1) forward.push(cell);
      else if (v === cur) lateral.push(cell);
    }
    var i;
    for (i = 0; i < forward.length; i++) {
      if (!occupied.has(forward[i])) { moveWalker(g, wk, forward[i], occupied, ev); wk.stuck = 0; return null; }
    }
    wk.stuck += 1;
    if (wk.stuck >= 3) {
      for (i = 0; i < lateral.length; i++) {
        if (!occupied.has(lateral[i])) { moveWalker(g, wk, lateral[i], occupied, ev); wk.stuck = 0; return null; }
      }
    }
    return null;
  }

  function moveWalker(g, wk, cell, occupied, ev) {
    occupied.delete(wk.cell);
    var from = wk.cell;
    wk.cell = cell;
    wk.x = cell % g.t.w;
    wk.y = (cell / g.t.w) | 0;
    occupied.set(cell, wk);
    if (ev) ev.moves.push({ wid: wk.wid, from: from, to: cell });
  }

  function walkerAct(g, wk, tick, occupied, ev) {
    var cfg = g.cfg, t = g.t;
    var d = dist(g);
    var cur = d[wk.cell];
    if (cur < INF) {
      wk.atk = false;
      if (tick % cfg.walker_move_period !== wk.phase) return null;
      if (cur <= 1) {
        g.keepHp = Math.max(0, g.keepHp - cfg.walker_keep_damage);
        if (ev) {
          ev.arrivals.push({ wid: wk.wid, cell: wk.cell, dmg: cfg.walker_keep_damage });
          ev.keepHit += cfg.walker_keep_damage;
        }
        return 'arrive';
      }
      return stepDown(g, wk, d, cur, occupied, ev);
    }
    /* boxed in: follow the dig gradient and chew the first structure on it */
    var dg = dig(g);
    var best = -1, bestv = INF;
    var list = t.nbrs[wk.cell];
    for (var k = 0; k < list.length; k++) {
      var nb = list[k];
      if (!t.pass[nb] && !t.isKeep[nb]) continue;
      var v = dg[nb];
      if (v < bestv) { bestv = v; best = nb; }
    }
    if (best < 0) { wk.atk = false; return null; }
    if (g.struct.has(best)) {
      wk.atk = true;
      var s = g.struct.get(best);
      s.hp -= cfg.walker_attack;
      var broke = s.hp <= 0;
      if (ev) {
        ev.hits.push({ cell: best, dmg: cfg.walker_attack, broke: broke, wid: wk.wid,
          piece: s.kind, owner: s.owner });
        ev.chews.push(wk.wid);
        /* read off the same structure record, before breakStruct removes it */
        if (broke) ev.broke.push({ cell: best, piece: s.kind, owner: s.owner, wid: wk.wid });
      }
      if (broke) breakStruct(g, best);
      return null;
    }
    wk.atk = false;
    if (tick % cfg.walker_move_period !== wk.phase) return null;
    if (t.isKeep[best]) {
      g.keepHp = Math.max(0, g.keepHp - cfg.walker_keep_damage);
      if (ev) {
        ev.arrivals.push({ wid: wk.wid, cell: wk.cell, dmg: cfg.walker_keep_damage });
        ev.keepHit += cfg.walker_keep_damage;
      }
      return 'arrive';
    }
    if (occupied.has(best)) return null;
    moveWalker(g, wk, best, occupied, ev);
    return null;
  }

  /* One iteration of the run_wave while body. Returns an ev record, or null when the loop
   * has ended (which sets ws.done). The ev is for the renderer and the sound layer and is
   * never read back into the state. */
  function waveTick(g, ws, wantEv) {
    if (ws.done) return null;
    var cfg = g.cfg, t = g.t;
    if (ws.tick >= cfg.wave_max_ticks) { ws.done = true; return null; }
    var ev = (wantEv === false) ? null : emptyEv(ws.tick);
    var walkers = ws.walkers, occupied = ws.occupied, queue = ws.queue;
    var keepBefore = g.keepHp;

    /* spawn */
    while (ws.qi < queue.length && queue[ws.qi][0] <= ws.tick) {
      var q = queue[ws.qi];
      var cell = q[2] * t.w + q[1];
      if (occupied.has(cell)) break;                 /* gate blocked this tick, retry */
      var wk = {
        wid: q[3], x: q[1], y: q[2], cell: cell, hp: cfg.walker_hp,
        phase: q[3] % cfg.walker_move_period, stuck: 0, atk: false
      };
      walkers.push(wk);
      occupied.set(cell, wk);
      ws.qi += 1;
      if (ev) ev.spawns.push({ wid: wk.wid, cell: cell });
    }

    if (walkers.length === 0 && ws.qi >= queue.length) { ws.done = true; return null; }

    /* turrets */
    if (ws.tick % cfg.turret_period === 0 && walkers.length) {
      turretsFire(g, walkers, ev);
      for (var i = walkers.length - 1; i >= 0; i--) {
        var dwk = walkers[i];
        if (dwk.hp > 0) continue;
        if (occupied.get(dwk.cell) === dwk) occupied.delete(dwk.cell);
        walkers.splice(i, 1);
        ws.killed += 1;
        if (ev) { ev.kills.push(dwk.wid); ev.killed.push({ wid: dwk.wid, cell: dwk.cell }); }
      }
      if (ev && ev.shots.length) collectHurt(ev, walkers);
    }

    /* walkers. python iterates a snapshot and removes the arrivals afterwards, so a
     * walker that reaches the keep still holds its tile for the rest of this tick. */
    var snap = walkers.slice();
    var gone = [];
    for (var j = 0; j < snap.length; j++) {
      if (walkerAct(g, snap[j], ws.tick, occupied, ev) === 'arrive') {
        gone.push(snap[j]);
        ws.arrived += 1;
      }
    }
    for (var m = 0; m < gone.length; m++) {
      var gw = gone[m];
      if (occupied.get(gw.cell) === gw) occupied.delete(gw.cell);
      var at = walkers.indexOf(gw);
      if (at >= 0) walkers.splice(at, 1);
    }

    if (g.keepHp <= 0 && keepBefore > 0) {
      ws.keepFell = true;
      if (ev) ev.keepFell = true;
    }
    if (g.keepHp <= 0) { ws.done = true; return ev || NO_EV; }
    ws.tick += 1;
    return ev || NO_EV;
  }
  KeepCore.waveTick = waveTick;

  /* Anything still standing at the tick cap eventually gets through. */
  function waveFinish(g, ws) {
    if (ws.finished) return ws.arrived;
    var cfg = g.cfg;
    for (var i = 0; i < ws.walkers.length; i++) {
      g.keepHp -= cfg.walker_keep_damage;
      ws.arrived += 1;
    }
    g.keepHp = Math.max(0, g.keepHp);
    g.leaks += ws.arrived;
    g.log.push({ wave: ws.wave, ticks: ws.tick, arrived: ws.arrived, killed: ws.killed, keep: g.keepHp });
    /* the leftovers got through, so the wave holds nobody once it is finished */
    ws.walkers.length = 0;
    ws.occupied.clear();
    ws.finished = true;
    ws.done = true;
    /* SEAM P-S4: the leftover clause is not a tick and carries no ev, so the wave state is
     * where the page reads the outcome. held is the same test the page already runs on the
     * keep after the finish, written where the number settles. */
    if (g.keepHp <= 0) ws.keepFell = true;
    ws.held = (g.keepHp > 0);
    return ws.arrived;
  }
  KeepCore.waveFinish = waveFinish;

  function runWave(g, waveIndex, onEv) {
    var ws = waveInit(g, waveIndex);
    while (!ws.done) {
      var ev = waveTick(g, ws, !!onEv);
      if (ev === null) break;
      if (onEv) onEv(ev, ws);
    }
    return waveFinish(g, ws);
  }
  KeepCore.runWave = runWave;

  /* ------------------------------------------------------------------ cut algebra
   *
   * doctrines.py. A cut is a hand written list of tiles that seals the map; the guns are
   * not hand written, they come out of a greedy set cover over the tiles a stopped walker
   * can stand on. Ties break west to east so the choice is deterministic.
   */

  function cutGeometry(terrain, cfg, cut) {
    var g = newGame(emptyEpisode(terrain, cfg), cfg);
    var w = terrain.w, i, x, y;
    for (i = 0; i < cut.length; i++) place(g, cut[i] % w, (cut[i] / w) | 0, WALL, 0);
    var d = dist(g);
    var cutset = new Set(cut);
    var outside = [];
    for (y = 0; y < terrain.h; y++) for (x = 0; x < terrain.w; x++) {
      var c = y * w + x;
      if (!terrain.pass[c] || cutset.has(c)) continue;
      if (d[c] < INF) continue;
      var list = terrain.nbrs[c], touches = false;
      for (var k = 0; k < list.length; k++) if (cutset.has(list[k])) { touches = true; break; }
      if (touches) outside.push(c);
    }
    var sealed = true;
    for (i = 0; i < terrain.gateTiles.length; i++) {
      var gt = terrain.gateTiles[i];
      if (d[gt[1] * w + gt[0]] < INF) { sealed = false; break; }
    }
    return { attack: outside, sealed: sealed };
  }
  KeepCore.cutGeometry = cutGeometry;

  function covers(gunCell, tiles, reach2, w) {
    var gx = gunCell % w, gy = (gunCell / w) | 0, out = [];
    tiles.forEach(function (c) {
      var dx = (c % w) - gx, dy = ((c / w) | 0) - gy;
      if (dx * dx + dy * dy <= reach2) out.push(c);
    });
    return out;
  }

  function pickGuns(terrain, cfg, cut, extra) {
    extra = extra || 0;
    var w = terrain.w;
    var reach2 = cfg.turret_range * cfg.turret_range;
    var geo = cutGeometry(terrain, cfg, cut);
    var attack = geo.attack;
    var todo = new Set(attack);
    var guns = [];
    var pool = cut.slice().sort(function (a, b) {
      var ax = a % w, bx = b % w;
      if (ax !== bx) return ax - bx;
      return ((a / w) | 0) - ((b / w) | 0);
    });
    var i, j;
    while (todo.size) {
      var best = null, bestcov = [];
      for (i = 0; i < pool.length; i++) {
        if (guns.indexOf(pool[i]) >= 0) continue;
        var cov = covers(pool[i], todo, reach2, w);
        if (cov.length > bestcov.length) { bestcov = cov; best = pool[i]; }
      }
      if (best === null || !bestcov.length) break;
      guns.push(best);
      for (j = 0; j < bestcov.length; j++) todo.delete(bestcov[j]);
    }
    /* Extra guns reinforce the THINNEST part of the line, not the fattest: it is the
     * once seen attacker tiles that decide the plan. */
    var attackSet = new Set(attack);
    for (var e = 0; e < extra; e++) {
      var mult = new Map();
      for (i = 0; i < attack.length; i++) {
        var a = attack[i], ax = a % w, ay = (a / w) | 0, cnt = 0;
        for (j = 0; j < guns.length; j++) {
          var gx = guns[j] % w, gy = (guns[j] / w) | 0;
          if ((ax - gx) * (ax - gx) + (ay - gy) * (ay - gy) <= reach2) cnt++;
        }
        mult.set(a, cnt);
      }
      var low = INF;
      mult.forEach(function (v) { if (v < low) low = v; });
      if (!mult.size) low = 0;
      var bestT = null, bestKey = null;
      for (i = 0; i < pool.length; i++) {
        if (guns.indexOf(pool[i]) >= 0) continue;
        var cv = covers(pool[i], attackSet, reach2, w);
        var lowCount = 0;
        for (j = 0; j < cv.length; j++) if (mult.get(cv[j]) === low) lowCount++;
        var key = [lowCount, cv.length];
        if (bestKey === null || tupleLess(bestKey, key)) { bestKey = key; bestT = pool[i]; }
      }
      if (bestT === null) break;
      guns.push(bestT);
    }
    return { guns: guns, attack: attack, sealed: geo.sealed };
  }
  KeepCore.pickGuns = pickGuns;

  /* Neighbours of a cut tile that still seal the map when substituted for it. Covered
   * alternates come first: a jog that seals but leaves its own attacker tiles unshot is a
   * bad jog, and one of those cost a whole doctrine its score in the audit. */
  function alternates(terrain, cfg, cut, guns, tile) {
    var w = terrain.w;
    var reach2 = cfg.turret_range * cfg.turret_range;
    var good = [], poor = [];
    var cutset = new Set(cut);
    var list = terrain.nbrs[tile];
    for (var k = 0; k < list.length; k++) {
      var nb = list[k];
      if (!terrain.isGround[nb] || cutset.has(nb)) continue;
      var alt = [];
      for (var i = 0; i < cut.length; i++) if (cut[i] !== tile) alt.push(cut[i]);
      alt.push(nb);
      var geo = cutGeometry(terrain, cfg, alt);
      if (!geo.sealed) continue;
      var ng = guns.map(function (gg) { return gg === tile ? nb : gg; });
      var covered = true;
      for (i = 0; i < geo.attack.length; i++) {
        var a = geo.attack[i], ax = a % w, ay = (a / w) | 0, any = false;
        for (var j = 0; j < ng.length; j++) {
          var gx = ng[j] % w, gy = (ng[j] / w) | 0;
          if ((ax - gx) * (ax - gx) + (ay - gy) * (ay - gy) <= reach2) { any = true; break; }
        }
        if (!any) { covered = false; break; }
      }
      (covered ? good : poor).push(nb);
    }
    return good.concat(poor);
  }
  KeepCore.alternates = alternates;

  /* Order inside one phase: pure west to east, which is the pinned law. */
  function orderEW(items, w) {
    return items.slice().sort(function (a, b) {
      var ax = a.tiles[0] % w, bx = b.tiles[0] % w;
      if (ax !== bx) return ax - bx;
      return ((a.tiles[0] / w) | 0) - ((b.tiles[0] / w) | 0);
    });
  }

  function Doctrine(key, name, blurb, phases, w) {
    this.key = key;
    this.name = name;
    this.blurb = blurb;
    this.phases = phases.map(function (p) { return orderEW(p, w); });
    this.core = [];
    for (var i = 0; i < this.phases.length - 1; i++) {
      this.core = this.core.concat(this.phases[i]);
    }
    this.extras = this.phases[this.phases.length - 1].slice();
    this.cut = [];
    this.guns = [];
    this.attack = [];
    this.sealed = true;
  }
  Doctrine.prototype.orderForward = function () {
    var out = [];
    for (var i = 0; i < this.phases.length; i++) out = out.concat(this.phases[i]);
    return out;
  };
  Doctrine.prototype.orderBackward = function () {
    var out = [];
    for (var i = 0; i < this.phases.length; i++) out = out.concat(this.phases[i].slice().reverse());
    return out;
  };
  Doctrine.prototype.orderEven = function () {
    var a = [], b = [], i, j;
    for (i = 0; i < this.phases.length; i++) for (j = 0; j < this.phases[i].length; j += 2) a.push(this.phases[i][j]);
    for (i = 0; i < this.phases.length; i++) for (j = 1; j < this.phases[i].length; j += 2) b.push(this.phases[i][j]);
    return a.concat(b);
  };
  Doctrine.prototype.orderOdd = function () {
    var a = [], b = [], i, j;
    for (i = 0; i < this.phases.length; i++) for (j = 1; j < this.phases[i].length; j += 2) a.push(this.phases[i][j]);
    for (i = 0; i < this.phases.length; i++) for (j = 0; j < this.phases[i].length; j += 2) b.push(this.phases[i][j]);
    return a.concat(b);
  };
  Doctrine.prototype.cost = function (cfg) {
    function c(items) {
      var s = 0;
      for (var i = 0; i < items.length; i++) s += (items[i].kind === WALL) ? cfg.wall_cost : cfg.turret_cost;
      return s;
    }
    return [c(this.core), c(this.extras)];
  };
  KeepCore.Doctrine = Doctrine;

  function fromCut(key, name, blurb, terrain, cfg, cut, target, depth, gunsfirst) {
    target = (target === undefined) ? KeepCore.DOCTRINE_TARGET : target;
    depth = (depth === undefined) ? 2 : depth;
    gunsfirst = (gunsfirst === undefined) ? true : gunsfirst;
    var w = terrain.w;
    var wallC = cfg.wall_cost, gunC = cfg.turret_cost;
    var pg = pickGuns(terrain, cfg, cut);
    var guns = pg.guns, attack = pg.attack, sealed = pg.sealed;
    var n = cut.length;
    function coreCost(gn) { return (n - gn) * wallC + gn * gunC; }
    var extra = 0;
    while ((guns.length + extra + 1) <= n && coreCost(guns.length + extra + 1) <= target) extra += 1;
    if (extra) {
      pg = pickGuns(terrain, cfg, cut, extra);
      guns = pg.guns; attack = pg.attack; sealed = pg.sealed;
    }
    var gset = new Set(guns);
    var core = [];
    var sortedCut = cut.slice().sort(function (a, b) {
      var ax = a % w, bx = b % w;
      if (ax !== bx) return ax - bx;
      return ((a / w) | 0) - ((b / w) | 0);
    });
    for (var i = 0; i < sortedCut.length; i++) {
      var tile = sortedCut[i];
      var alts = alternates(terrain, cfg, cut, guns, tile);
      core.push({ kind: gset.has(tile) ? TURRET : WALL, tiles: [tile].concat(alts) });
    }
    /* Depth is MORE GUNS ON THE LINE, never more wall: a wall the guns do not cover moves
     * the fight one row forward into tiles no gun can reach. */
    var more = pickGuns(terrain, cfg, cut, extra + depth).guns;
    var ext = [];
    for (i = guns.length; i < more.length; i++) ext.push({ kind: TURRET, tiles: [more[i]] });

    var phases;
    if (gunsfirst) {
      phases = [
        core.filter(function (it) { return it.kind === TURRET; }),
        core.filter(function (it) { return it.kind === WALL; }),
        ext
      ];
    } else {
      phases = [core, ext];
    }
    var d = new Doctrine(key, name, blurb, phases, w);
    d.cut = cut.slice();
    d.guns = guns.slice();
    d.attack = attack.slice();
    d.sealed = sealed;
    return d;
  }
  KeepCore.fromCut = fromCut;

  /* Map v4's cuts. Each is a complete seal of ten tiles the world prices at 44 credits:
   * three guns by the greedy cover, seven walls. The jogged tiles are gun bays, and the
   * whole price structure of this map rests on them. */
  var CUTS_V4 = [
    ['gates', 'Three plugs at the gates',
      'Stop each column in the mouth of its own gate.',
      [[2, 1], [3, 1], [4, 1], [12, 2], [13, 1], [14, 1], [15, 1], [23, 1], [24, 1], [25, 1]]],
    ['gorges', 'Three plugs down in the gorges',
      'The same three columns, stopped two rows lower, past the alcoves.',
      [[2, 3], [3, 3], [4, 2], [12, 2], [13, 2], [14, 3], [15, 3], [23, 3], [24, 3], [25, 2]]],
    ['mouths', 'Three plugs at the gorge mouths',
      'Hold each gorge where it opens into the gallery.',
      [[2, 6], [3, 5], [4, 6], [12, 6], [13, 6], [14, 5], [15, 5], [23, 6], [24, 5], [25, 5]]],
    ['bars', 'A plug in the middle, a bar each side',
      'Cut the gallery itself: a bar across it west and east, the centre gorge plugged where it comes out.',
      [[6, 6], [6, 7], [6, 8], [12, 6], [13, 6], [14, 5], [15, 5], [20, 6], [20, 7], [20, 8]]],
    ['eastbar', 'Two plugs and a bar in the east gallery',
      'West and centre stopped in their gorges, the east column met out in the gallery instead.',
      [[2, 5], [3, 4], [4, 4], [12, 4], [13, 4], [14, 5], [15, 5], [22, 6], [22, 7], [23, 8]]],
    ['westbar', 'A bar in the west gallery, two plugs east',
      'The mirror of it: the west column met in the gallery, the other two stopped high.',
      [[4, 7], [4, 8], [5, 6], [12, 2], [13, 2], [14, 3], [15, 3], [22, 6], [22, 7], [22, 8]]],
    ['latebar', 'Two plugs late, a bar in the far east',
      'Everything held one row later, and the east bar pushed out to the far side of the gallery.',
      [[2, 5], [3, 6], [4, 6], [12, 5], [13, 5], [14, 5], [15, 6], [21, 8], [22, 6], [22, 7]]],
    ['highbar', 'A bar in the near west, two plugs high',
      'The west column met just outside its own gorge, the centre held deep in the gorge, the east stopped highest of all.',
      [[6, 8], [7, 6], [7, 7], [12, 5], [13, 4], [14, 4], [15, 4], [23, 4], [24, 4], [25, 3]]],
    ['slant', 'A slant across the bowl onto the keep\'s shoulder',
      'Give up the map: run a line from the canyon\'s west wall down across the bowl and finish against the castle\'s east side.',
      [[7, 13], [8, 12], [10, 12], [11, 13], [12, 13], [13, 13], [14, 14], [15, 15], [15, 16], [15, 17]]],
    ['ring', 'The ring on the keep\'s own doorstep',
      'Wall the castle\'s own threshold. Measured and not shipped in the audited eight: its attacker face is twelve tiles against every other plan\'s ten.',
      [[10, 15], [10, 16], [10, 17], [11, 14], [12, 13], [13, 14], [14, 14], [15, 15], [15, 16], [15, 17]]]
  ];
  var SHIP_V4 = ['gates', 'gorges', 'mouths', 'bars', 'eastbar', 'westbar', 'latebar', 'highbar'];
  KeepCore.CUTS_V4 = CUTS_V4;
  KeepCore.SHIP_V4 = SHIP_V4;

  /* Map v5's cuts, copied tile for tile from _tests/twoengineers/train/mapv5.py cuts_v5(),
   * which is where they were designed and where train/gates_v5.py checks every one for a
   * real seal and for its price. Each is NINE tiles, which is v5's minimum vertex cut
   * (3 + 3 + 3 gate tiles, by Menger): three guns by the greedy cover and six walls, 42
   * credits. The v4 eight with the centre plug moved onto the narrower gorge; slant and
   * ring are v4-only measurements and are not defined on this board. */
  var CUTS_V5 = [
    ['gates', 'Three plugs at the gates',
      'Stop each column in the mouth of its own gate.',
      [[2, 1], [3, 1], [4, 1], [13, 1], [14, 1], [15, 1], [23, 1], [24, 1], [25, 1]]],
    ['gorges', 'Three plugs down in the gorges',
      'The same three columns, stopped two rows lower, past the alcoves.',
      [[2, 3], [3, 3], [4, 2], [13, 3], [14, 3], [15, 2], [23, 3], [24, 3], [25, 2]]],
    ['mouths', 'Three plugs at the gorge mouths',
      'Hold each gorge where it opens into the gallery.',
      [[2, 6], [3, 5], [4, 6], [13, 6], [14, 5], [15, 5], [23, 6], [24, 5], [25, 5]]],
    ['bars', 'A plug in the middle, a bar each side',
      'Cut the gallery itself: a bar across it west and east, the centre gorge plugged where it comes out.',
      [[6, 6], [6, 7], [6, 8], [13, 6], [14, 5], [15, 5], [20, 6], [20, 7], [20, 8]]],
    ['eastbar', 'Two plugs and a bar in the east gallery',
      'West and centre stopped in their gorges, the east column met out in the gallery instead.',
      [[2, 5], [3, 4], [4, 4], [13, 4], [14, 4], [15, 4], [22, 6], [22, 7], [23, 8]]],
    ['westbar', 'A bar in the west gallery, two plugs east',
      'The mirror of it: the west column met in the gallery, the other two stopped high.',
      [[4, 7], [4, 8], [5, 6], [13, 3], [14, 3], [15, 2], [22, 6], [22, 7], [22, 8]]],
    ['latebar', 'Two plugs late, a bar in the far east',
      'Everything held one row later, and the east bar pushed out to the far side of the gallery.',
      [[2, 5], [3, 6], [4, 6], [13, 5], [14, 5], [15, 5], [21, 8], [22, 6], [22, 7]]],
    ['highbar', 'A bar in the near west, two plugs high',
      'The west column met just outside its own gorge, the centre held deep in the gorge, the east stopped highest of all.',
      [[6, 8], [7, 6], [7, 7], [13, 4], [14, 4], [15, 4], [23, 4], [24, 4], [25, 3]]]
  ];
  var SHIP_V5 = ['gates', 'gorges', 'mouths', 'bars', 'eastbar', 'westbar', 'latebar', 'highbar'];
  KeepCore.CUTS_V5 = CUTS_V5;
  KeepCore.SHIP_V5 = SHIP_V5;

  var CUTS_BY_MAP = { v4: CUTS_V4, v5: CUTS_V5 };
  var SHIP_BY_MAP = { v4: SHIP_V4, v5: SHIP_V5 };

  KeepCore.cutsFor = function (name) {
    var c = CUTS_BY_MAP[name || ACTIVE_MAP];
    if (!c) throw new Error('no cuts for map ' + name);
    return c;
  };
  KeepCore.shipFor = function (name) {
    var s = SHIP_BY_MAP[name || ACTIVE_MAP];
    if (!s) throw new Error('no shipped doctrine list for map ' + name);
    return s.slice();
  };
  KeepCore.targetFor = function (name) {
    var v = TARGETS[name || ACTIVE_MAP];
    if (v === undefined) throw new Error('no doctrine target for map ' + name);
    return v;
  };

  function buildDoctrines(cfg, opts) {
    cfg = cfg || CFG;
    opts = opts || {};
    var terrain = opts.terrain || KeepCore.terrain(opts.map);
    /* the map the caller actually handed us wins over the active one, so a v4 regression
     * that passes terrain('v4') gets the v4 cuts and the v4 price without saying so twice */
    var mapName = opts.map || mapNameOf(terrain) || ACTIVE_MAP;
    var target = (opts.target === undefined) ? KeepCore.targetFor(mapName) : opts.target;
    var keys = opts.keys || KeepCore.shipFor(mapName);
    var cuts = KeepCore.cutsFor(mapName);
    var w = terrain.w;
    var order = {}, i;
    for (i = 0; i < keys.length; i++) order[keys[i]] = i;
    var spec = cuts.filter(function (s) { return order[s[0]] !== undefined; });
    if (spec.length !== keys.length) {
      var have = {};
      for (i = 0; i < cuts.length; i++) have[cuts[i][0]] = 1;
      var missing = keys.filter(function (k) { return !have[k]; });
      throw new Error('map ' + mapName + ' has no cut named ' + missing.join(', ') +
        '; it carries ' + Object.keys(have).join(' '));
    }
    spec.sort(function (a, b) { return order[a[0]] - order[b[0]]; });
    return spec.map(function (s) {
      var cells = s[3].map(function (p) { return p[1] * w + p[0]; });
      return fromCut(s[0], s[1], s[2], terrain, cfg, cells, target,
        (opts.depth === undefined ? 2 : opts.depth),
        (opts.gunsfirst === undefined ? true : opts.gunsfirst));
    });
  }
  KeepCore.buildDoctrines = buildDoctrines;

  /* ------------------------------------------------------------------ build items */

  function firstOption(g, item) {
    var w = g.t.w, i;
    if (item.kind === TURRET && g.cfg.mounted_guns) {
      for (i = 0; i < item.tiles.length; i++) {
        var c = item.tiles[i];
        if (canMount(g, c % w, (c / w) | 0)) return c;
      }
      return -1;
    }
    for (i = 0; i < item.tiles.length; i++) {
      var c2 = item.tiles[i];
      if (canBuild(g, c2 % w, (c2 / w) | 0)) return c2;
    }
    return -1;
  }
  KeepCore.firstOption = firstOption;

  /* A gun item is satisfied only by a gun: a wall on one of its tiles is not a substitute.
   * A wall item is satisfied by any structure on any of its tiles, including a free ruin
   * and including a gun, because all three block and the line is what a wall item is for. */
  function alreadyDone(g, item) {
    var i;
    if (item.kind === TURRET) {
      for (i = 0; i < item.tiles.length; i++) {
        var s = g.struct.get(item.tiles[i]);
        if (s !== undefined && s.kind === TURRET) return true;
      }
      return false;
    }
    for (i = 0; i < item.tiles.length; i++) if (g.struct.has(item.tiles[i])) return true;
    return false;
  }
  KeepCore.alreadyDone = alreadyDone;

  /* ------------------------------------------------------------------ the per tile scorer
   *
   * train_smoke.py. The policy is a per tile SCORER, not a categorical head over the map:
   * on its turn an engineer scores every legal affordable (tile, kind) pair with one shared
   * little MLP and places the argmax. Weights are shared across tiles, so the parameter
   * count does not grow with the map.
   *
   * Feature block, per candidate tile. Static (computed once per terrain):
   *   0 bias, 1 nx, 2 ny, 3 distance to the keep on an empty board, 4 traffic on an empty
   *   board (log compressed), 5 to 9 y bumps, 10 to 14 x bumps, 15 row width,
   *   16 distance to the west gate, 17 distance to the east gate, 26 distance to the
   *   centre gate (three gate maps only).
   * Dynamic (recomputed every build turn):
   *   18 live distance, 19 live traffic, 20 horizontal neighbours occupied,
   *   21 vertical neighbours occupied, 22 neighbours built by me, 23 by my partner,
   *   24 guns already covering this tile, 25 neighbours that are free ruins.
   * Global, broadcast to every tile: budget left, wave one hot (3), seat bit,
   *   my structures, partner structures, turn index.
   */

  var N_LOCAL = 26, N_GLOBAL = 8, DNORM = 24.0;
  var YB = [1.0, 3.0, 5.0, 6.5, 8.0];
  var XB = [1.5, 4.0, 6.5, 9.0, 11.5];
  KeepCore.N_LOCAL = N_LOCAL;
  KeepCore.N_GLOBAL = N_GLOBAL;
  KeepCore.DNORM = DNORM;

  var INF20 = 1 << 20;

  function multiBfs(terrain, sources) {
    var n = terrain.n, d = new Int32Array(n), i;
    for (i = 0; i < n; i++) d[i] = INF20;
    var q = new Int32Array(n), head = 0, tail = 0;
    for (i = 0; i < sources.length; i++) {
      var c = sources[i][1] * terrain.w + sources[i][0];
      d[c] = 0; q[tail++] = c;
    }
    while (head < tail) {
      var cur = q[head++], nd = d[cur] + 1, list = terrain.nbrs[cur];
      for (var k = 0; k < list.length; k++) {
        var nb = list[k];
        if (!terrain.pass[nb]) continue;
        if (d[nb] > nd) { d[nb] = nd; q[tail++] = nb; }
      }
    }
    return d;
  }
  KeepCore.multiBfs = multiBfs;

  /* Expected walker traffic per tile: unit mass leaves each gate tile and flows down the
   * dist gradient, splitting evenly between forward neighbours. Same gradient rule the
   * walkers use, ignoring collisions.
   *
   * The sum order is part of the contract, not an implementation detail: float addition is
   * not associative, and the static block uses this order while the per turn block uses
   * fastFlow's. Both are ported as written. */
  function flowField(terrain, d, wshare, eshare, cshare) {
    var w = terrain.w, h = terrain.h, n = terrain.n;
    var flow = new Float64Array(n), i, k;
    var src = [];
    if (terrain.gateW.length && wshare > 0) {
      for (i = 0; i < terrain.gateW.length; i++) {
        src.push([terrain.gateW[i][0], terrain.gateW[i][1], wshare / terrain.gateW.length]);
      }
    }
    if (terrain.gateE.length && eshare > 0) {
      for (i = 0; i < terrain.gateE.length; i++) {
        src.push([terrain.gateE[i][0], terrain.gateE[i][1], eshare / terrain.gateE.length]);
      }
    }
    if (terrain.gateC.length && cshare > 0) {
      for (i = 0; i < terrain.gateC.length; i++) {
        src.push([terrain.gateC[i][0], terrain.gateC[i][1], cshare / terrain.gateC.length]);
      }
    }
    var order = [];
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      if (d[y * w + x] < INF) order.push([d[y * w + x], x, y]);
    }
    /* python order.sort(reverse=True) on the tuples (dist, x, y) */
    order.sort(function (a, b) {
      if (a[0] !== b[0]) return b[0] - a[0];
      if (a[1] !== b[1]) return b[1] - a[1];
      return b[2] - a[2];
    });
    for (i = 0; i < src.length; i++) {
      var sc = src[i][1] * w + src[i][0];
      if (d[sc] < INF) flow[sc] += src[i][2];
    }
    for (i = 0; i < order.length; i++) {
      var dv = order[i][0], ox = order[i][1], oy = order[i][2];
      var cell = oy * w + ox;
      var m = flow[cell];
      if (m <= 0.0 || dv <= 1) continue;
      var list = terrain.nbrs[cell], fwd = [];
      for (k = 0; k < list.length; k++) if (d[list[k]] === dv - 1) fwd.push(list[k]);
      if (!fwd.length) continue;
      var share = m / fwd.length;
      for (k = 0; k < fwd.length; k++) flow[fwd[k]] += share;
    }
    return flow;
  }
  KeepCore.flowField = flowField;

  /* flowField with the neighbour lists precomputed and a bucket sort instead of a full
   * sort. train_smoke calls this one every build turn. */
  function fastFlow(board, d) {
    var t = board.t, w = t.w, h = t.h, n = t.n;
    var flow = new Float64Array(n), i, k;
    var buckets = new Map();
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var v = d[y * w + x];
      if (v < INF) {
        var b = buckets.get(v);
        if (b === undefined) { b = []; buckets.set(v, b); }
        b.push(y * w + x);
      }
    }
    for (i = 0; i < board.gateSrc.length; i++) {
      var gs = board.gateSrc[i], gc = gs[1] * w + gs[0];
      if (d[gc] < INF) flow[gc] += gs[2];
    }
    var keys = [];
    buckets.forEach(function (v, key) { keys.push(key); });
    keys.sort(function (a, b) { return b - a; });
    for (var ki = 0; ki < keys.length; ki++) {
      var v2 = keys[ki];
      if (v2 <= 1) continue;
      var want = v2 - 1;
      var bucket = buckets.get(v2);
      for (i = 0; i < bucket.length; i++) {
        var cell = bucket[i], m = flow[cell];
        if (m <= 0.0) continue;
        var list = t.pnbrs[cell], fwd = [];
        for (k = 0; k < list.length; k++) if (d[list[k]] === want) fwd.push(list[k]);
        if (!fwd.length) continue;
        var share = m / fwd.length;
        for (k = 0; k < fwd.length; k++) flow[fwd[k]] += share;
      }
    }
    return flow;
  }
  KeepCore.fastFlow = fastFlow;

  /* Everything about a terrain that never changes between episodes. */
  function makeBoard(terrain, cfg) {
    terrain = terrain || KeepCore.terrain();
    cfg = cfg || CFG;
    var b = {};
    b.t = terrain;
    b.cfg = cfg;
    b.w = terrain.w;
    b.h = terrain.h;
    b.tiles = terrain.buildable.slice();
    b.n = b.tiles.length;
    b.flat = new Int32Array(b.n);
    b.idx = new Map();
    var i, k, x, y;
    for (i = 0; i < b.n; i++) {
      b.flat[i] = b.tiles[i][1] * b.w + b.tiles[i][0];
      b.idx.set(b.flat[i], i);
    }
    b.three = terrain.gateC.length > 0;
    b.nLocal = b.three ? (N_LOCAL + 1) : N_LOCAL;
    b.nIn = b.nLocal + N_GLOBAL;

    var g0 = newGame(emptyEpisode(terrain, cfg), cfg);
    var d0 = dist(g0);
    var f0 = b.three ? flowField(terrain, d0, 1 / 3.0, 1 / 3.0, 1 / 3.0)
      : flowField(terrain, d0, 0.5, 0.5, 0.0);

    var rowcount = new Float64Array(b.h);
    for (i = 0; i < b.n; i++) rowcount[b.tiles[i][1]] += 1;
    var rowmax = 1.0;
    for (i = 0; i < b.h; i++) if (rowcount[i] > rowmax) rowmax = rowcount[i];

    b.dnorm = b.w + b.h;
    b.rowmax = rowmax;
    b.bnorm = b.three ? cfg.budgets[0] : 18.0;
    b.cnorm = b.three ? (cfg.budgets[0] / cfg.wall_cost) : 12.0;

    var yb, xb, ysig, xsig;
    if (b.three) {
      yb = []; xb = [];
      for (k = 0; k < 5; k++) yb.push((k + 0.5) * b.h / 5.0);
      for (k = 0; k < 5; k++) xb.push((k + 0.5) * b.w / 5.0);
      ysig = b.h / 8.0;
      xsig = b.w / 8.0;
    } else {
      yb = YB; xb = XB; ysig = 1.0; xsig = 1.5;
    }

    var dw = multiBfs(terrain, terrain.gateW);
    var de = multiBfs(terrain, terrain.gateE);
    var dc = b.three ? multiBfs(terrain, terrain.gateC) : null;

    var S = new Float64Array(b.n * b.nLocal);
    for (i = 0; i < b.n; i++) {
      x = b.tiles[i][0]; y = b.tiles[i][1];
      var c = b.flat[i], o = i * b.nLocal;
      S[o + 0] = 1.0;
      S[o + 1] = x / (b.w - 1);
      S[o + 2] = y / (b.h - 1);
      S[o + 3] = Math.min(d0[c], b.dnorm) / b.dnorm;
      S[o + 4] = Math.log1p(f0[c]) / 2.0;
      for (k = 0; k < 5; k++) S[o + 5 + k] = Math.exp(-0.5 * Math.pow((y - yb[k]) / ysig, 2));
      for (k = 0; k < 5; k++) S[o + 10 + k] = Math.exp(-0.5 * Math.pow((x - xb[k]) / xsig, 2));
      S[o + 15] = rowcount[y] / b.rowmax;
      S[o + 16] = Math.min(dw[c], b.dnorm) / b.dnorm;
      S[o + 17] = Math.min(de[c], b.dnorm) / b.dnorm;
      if (b.three) S[o + N_LOCAL] = Math.min(dc[c], b.dnorm) / b.dnorm;
    }
    b.staticF = S;

    /* 4 neighbour index table over candidate tiles, order (-1,0) (1,0) (0,-1) (0,1) */
    var NBD = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    b.nb = new Int32Array(b.n * 4);
    for (i = 0; i < b.n; i++) {
      x = b.tiles[i][0]; y = b.tiles[i][1];
      for (k = 0; k < 4; k++) {
        var nx = x + NBD[k][0], ny = y + NBD[k][1];
        var got = (nx < 0 || ny < 0 || nx >= b.w || ny >= b.h) ? undefined : b.idx.get(ny * b.w + nx);
        b.nb[i * 4 + k] = (got === undefined) ? -1 : got;
      }
    }

    /* tiles within turret range of each tile */
    var r2 = cfg.turret_range * cfg.turret_range;
    b.cov = [];
    for (i = 0; i < b.n; i++) {
      var list = [];
      for (var j = 0; j < b.n; j++) {
        var ddx = b.tiles[j][0] - b.tiles[i][0], ddy = b.tiles[j][1] - b.tiles[i][1];
        if (ddx * ddx + ddy * ddy <= r2) list.push(j);
      }
      b.cov.push(list);
    }

    b.gateBase = new Map();
    for (i = 0; i < terrain.gateTiles.length; i++) {
      var gt = terrain.gateTiles[i];
      b.gateBase.set(gt[1] * b.w + gt[0], d0[gt[1] * b.w + gt[0]]);
    }

    var share = b.three ? (1 / 3.0) : 0.5;
    b.gateSrc = [];
    for (i = 0; i < terrain.gateW.length; i++) {
      b.gateSrc.push([terrain.gateW[i][0], terrain.gateW[i][1], share / terrain.gateW.length]);
    }
    for (i = 0; i < terrain.gateE.length; i++) {
      b.gateSrc.push([terrain.gateE[i][0], terrain.gateE[i][1], share / terrain.gateE.length]);
    }
    if (b.three) {
      for (i = 0; i < terrain.gateC.length; i++) {
        b.gateSrc.push([terrain.gateC[i][0], terrain.gateC[i][1], share / terrain.gateC.length]);
      }
    }
    return b;
  }
  KeepCore.makeBoard = makeBoard;

  /* One memoized board per map, invalidated when a caller hands in a different cfg object
   * (which is how the doctrine audits and the perf harness ask for a variant world). */
  var _boards = {};
  KeepCore.board = function (cfg, name) {
    name = name || ACTIVE_MAP;
    var cur = _boards[name];
    if (!cur || (cfg && cfg !== cur.cfg)) {
      cur = makeBoard(KeepCore.terrain(name), cfg || CFG);
      _boards[name] = cur;
    }
    return cur;
  };

  /* ------------------------------------------------------------------ the active map
   *
   * applyMap is the ONE place the map-shaped exports are written, so a consumer that reads
   * KeepCore.MAP, .MAP_ROWS, .CONST, .ARCH, .CUTS, .SHIP or .DOCTRINE_TARGET can never see
   * two maps at once. It is called at load with the default and by setMap afterwards.
   * The memoized terrains and boards are keyed by map and are NOT thrown away, so
   * switching back and forth costs nothing.
   */
  function applyMap(name) {
    mapRows(name);                       /* throws on an unknown name, before anything moves */
    ACTIVE_MAP = name;
    KeepCore.MAP = name;
    KeepCore.MAP_ROWS = KeepCore.MAPS[name];
    KeepCore.CONST = makeConst(name);
    KeepCore.CUTS = KeepCore.cutsFor(name);
    KeepCore.SHIP = KeepCore.shipFor(name);
    KeepCore.DOCTRINE_TARGET = TARGETS[name];
    KeepCore.ARCH = archFor(name);
    return name;
  }

  /* The architecture the model file's `arch` block describes, for the ACTIVE map unless a
   * map is named. tiles is the number the guard in loadModel compares against: 239 on v5,
   * 243 on v4. It is read off the TERRAIN, by the same two rules makeBoard uses (one entry
   * per buildable tile, one extra local column on a three gate map), so that a page can
   * read KeepCore.ARCH at boot without paying for the board's BFS and coverage tables; the
   * suite asserts ARCH.tiles and ARCH.nIn against the real board on both maps, so the two
   * cannot drift apart quietly. S, H1, C and N are the D2 section 4 shapes the trainer
   * starts from; a model file may carry different ones and core reads the real widths out
   * of each net's own tensors (T1 pin 8). */
  function archFor(name) {
    name = name || ACTIVE_MAP;
    var terr = KeepCore.terrain(name);
    var nLocal = (terr.gateC.length > 0) ? (N_LOCAL + 1) : N_LOCAL;
    return Object.freeze({
      map: name, W: terr.w, H: terr.h, tiles: terr.buildable.length,
      L: nLocal, G: N_GLOBAL, nIn: nLocal + N_GLOBAL,
      S: 36, H1: 48, C: 32, N: 6
    });
  }
  KeepCore.archFor = archFor;

  KeepCore.setMap = function (name) { return applyMap(name); };
  applyMap(DEFAULT_MAP);

  /* Per episode state the policy reads: what is on the board right now. */
  function makeBuilder(board, ep, g) {
    var bld = {};
    bld.b = board;
    bld.ep = ep;
    bld.g = g;
    var n = board.n, i;
    bld.free = new Uint8Array(n);
    for (i = 0; i < n; i++) bld.free[i] = 1;
    bld.owner = new Int8Array(n);        /* 0 none, 1 A, 2 B, 3 ruin */
    bld.occ = new Uint8Array(n);
    bld.turretCov = new Float64Array(n);
    for (i = 0; i < ep.rubble.length; i++) {
      var ri = board.idx.get(ep.rubble[i]);
      if (ri !== undefined) bld.free[ri] = 0;
    }
    for (i = 0; i < ep.ruins.length; i++) {
      var si = board.idx.get(ep.ruins[i]);
      if (si !== undefined) { bld.free[si] = 0; bld.occ[si] = 1; bld.owner[si] = 3; }
    }
    bld.counts = [0, 0];
    bld.mounted = !!g.cfg.mounted_guns;
    bld.mount = new Uint8Array(n);
    bld.X = new Float64Array(n * board.nIn);
    return bld;
  }
  KeepCore.makeBuilder = makeBuilder;

  function notePlace(bld, cell, kind, side) {
    var i = bld.b.idx.get(cell);
    if (i === undefined) return;
    bld.free[i] = 0;
    bld.occ[i] = 1;
    bld.owner[i] = 1 + side;
    bld.counts[side] += 1;
    if (kind === TURRET) {
      var cov = bld.b.cov[i];
      for (var k = 0; k < cov.length; k++) bld.turretCov[cov[k]] += 1.0;
      bld.mount[i] = 0;
    } else if (bld.mounted) {
      bld.mount[i] = 1;
    }
  }
  KeepCore.notePlace = notePlace;

  function features(bld, side, budget, wave, turn) {
    var b = bld.b, n = b.n, nIn = b.nIn, L = b.nLocal;
    var X = bld.X;
    var d = dist(bld.g);
    var f = fastFlow(b, d);
    var nb = b.nb, occ = bld.occ, own = bld.owner;
    var i, k, o, so;
    for (i = 0; i < n; i++) {
      o = i * nIn;
      so = i * L;
      for (k = 0; k < 18; k++) X[o + k] = b.staticF[so + k];
      var cell = b.flat[i];
      var dv = d[cell];
      X[o + 18] = Math.min(dv, DNORM) / DNORM;
      X[o + 19] = Math.log1p(f[cell]) / 2.0;
      var i0 = nb[i * 4], i1 = nb[i * 4 + 1], i2 = nb[i * 4 + 2], i3 = nb[i * 4 + 3];
      var o0 = i0 < 0 ? 0 : occ[i0], o1 = i1 < 0 ? 0 : occ[i1];
      var o2 = i2 < 0 ? 0 : occ[i2], o3 = i3 < 0 ? 0 : occ[i3];
      X[o + 20] = (o0 + o1) / 2.0;
      X[o + 21] = (o2 + o3) / 2.0;
      var w0 = i0 < 0 ? 0 : own[i0], w1 = i1 < 0 ? 0 : own[i1];
      var w2 = i2 < 0 ? 0 : own[i2], w3 = i3 < 0 ? 0 : own[i3];
      var na = (w0 === 1 ? 1 : 0) + (w1 === 1 ? 1 : 0) + (w2 === 1 ? 1 : 0) + (w3 === 1 ? 1 : 0);
      var nbp = (w0 === 2 ? 1 : 0) + (w1 === 2 ? 1 : 0) + (w2 === 2 ? 1 : 0) + (w3 === 2 ? 1 : 0);
      var nr = (w0 === 3 ? 1 : 0) + (w1 === 3 ? 1 : 0) + (w2 === 3 ? 1 : 0) + (w3 === 3 ? 1 : 0);
      X[o + 22] = (side === 0 ? na : nbp) / 4.0;
      X[o + 23] = (side === 0 ? nbp : na) / 4.0;
      X[o + 24] = Math.min(bld.turretCov[i], 3.0) / 3.0;
      X[o + 25] = nr / 4.0;
      if (L > N_LOCAL) X[o + N_LOCAL] = b.staticF[so + N_LOCAL];
      X[o + L + 0] = budget / b.bnorm;
      X[o + L + 1] = wave === 0 ? 1.0 : 0.0;
      X[o + L + 2] = wave === 1 ? 1.0 : 0.0;
      X[o + L + 3] = wave === 2 ? 1.0 : 0.0;
      X[o + L + 4] = side;
      X[o + L + 5] = bld.counts[side] / b.cnorm;
      X[o + L + 6] = bld.counts[1 - side] / b.cnorm;
      X[o + L + 7] = turn / b.cnorm;
    }
    return X;
  }
  KeepCore.features = features;

  /* tanh(X W1 + b1) W2 + b2, row major, two scores per tile: wall then gun.
   *
   * The k loop is the OUTER one over inputs and the j loop the inner one over hidden
   * units, so both X and W1 are walked contiguously. The accumulation order over k is
   * unchanged (ascending), which is what keeps the result bit for bit the same as the
   * straightforward version and therefore the same as the trainer's. This is the page's
   * hot loop: it is about 90 percent of the cost of one game. */
  var _hbufs = new Map();
  function hbufFor(hidden) {
    var b = _hbufs.get(hidden);
    if (b === undefined) { b = new Float64Array(hidden); _hbufs.set(hidden, b); }
    return b;
  }

  /* The first 18 feature columns are STATIC: they never change during an episode, so
   * b1 + sum over k < 18 of X[k] * W1[k] is a per tile constant. Precomputing it is bit
   * for bit identical, because the accumulation order over k is unchanged and the prefix
   * is exactly the same sequence of additions; it halves the cost of the hot loop.
   * Only a caller whose X carries the board's own static columns may pass a prefix, so
   * the probe path never does. */
  var PRE_K = 18;
  KeepCore.PRE_K = PRE_K;

  function staticPrefix(net, board) {
    if (net.__preBoard === board && net.__pre) return net.__pre;
    var hidden = net.b1.length, n = board.n, nIn = board.nIn;
    var pre = new Float64Array(n * hidden);
    var i, j, k, so, po, xv, base;
    for (i = 0; i < n; i++) {
      so = i * board.nLocal;
      po = i * hidden;
      for (j = 0; j < hidden; j++) pre[po + j] = net.b1[j];
      for (k = 0; k < PRE_K; k++) {
        xv = board.staticF[so + k];
        if (xv === 0) continue;
        base = k * hidden;
        for (j = 0; j < hidden; j++) pre[po + j] += xv * net.W1[base + j];
      }
    }
    net.__preBoard = board;
    net.__pre = pre;
    return pre;
  }
  KeepCore.staticPrefix = staticPrefix;

  function scoreTiles(net, X, n, nIn, out, pre, extra) {
    var W1 = net.W1, b1 = net.b1, W2 = net.W2, b2 = net.b2;
    var hidden = b1.length;
    if (!out || out.length < n * 2) out = new Float64Array(n * 2);
    var h = hbufFor(hidden);
    var i, j, k, o, base, xv, s0, s1, po;
    var k0 = pre ? PRE_K : 0;
    var nExtra = extra ? extra.length : 0;
    for (i = 0; i < n; i++) {
      o = i * nIn;
      if (pre) { po = i * hidden; for (j = 0; j < hidden; j++) h[j] = pre[po + j]; }
      else { for (j = 0; j < hidden; j++) h[j] = b1[j]; }
      for (k = k0; k < nIn; k++) {
        xv = X[o + k];
        if (xv === 0) continue;
        base = k * hidden;
        for (j = 0; j < hidden; j++) h[j] += xv * W1[base + j];
      }
      /* the specializer reads [X | one hot z] and the accommodator [X | trunk h], both
       * broadcast to every tile, so W1 has nIn + extra.length rows */
      for (k = 0; k < nExtra; k++) {
        xv = extra[k];
        if (xv === 0) continue;
        base = (nIn + k) * hidden;
        for (j = 0; j < hidden; j++) h[j] += xv * W1[base + j];
      }
      s0 = b2[0]; s1 = b2[1];
      for (j = 0; j < hidden; j++) {
        var hv = Math.tanh(h[j]);
        s0 += hv * W2[j * 2];
        s1 += hv * W2[j * 2 + 1];
      }
      out[i * 2] = s0;
      out[i * 2 + 1] = s1;
    }
    return out;
  }
  KeepCore.scoreTiles = scoreTiles;

  /* ------------------------------------------------------------------ the build phase
   *
   * One loop, byte identical to env.build_phase (both seats scripted),
   * train_smoke.net_build_phase (both seats nets) and train_smoke._mixed_phase (one of
   * each). Both engineers place at the same time, alternating, each seeing the other's
   * placements land. Seat A moves first.
   */

  function netTurn(g, bld, board, net, side, budget, wave, turn, scratch, extra) {
    var cfg = g.cfg, cw = cfg.wall_cost, ct = cfg.turret_cost;
    var wallOk = bld.free, gunOk = bld.mounted ? bld.mount : bld.free;
    var n = board.n, i;
    var anyWall = false, anyGun = false;
    for (i = 0; i < n; i++) { if (wallOk[i]) { anyWall = true; break; } }
    for (i = 0; i < n; i++) { if (gunOk[i]) { anyGun = true; break; } }
    var canW = budget >= cw && anyWall;
    var canG = budget >= ct && anyGun;
    if (!(canW || canG)) return null;
    var X = features(bld, side, budget, wave, turn);
    var sc = scoreTiles(net, X, n, board.nIn, scratch, staticPrefix(net, board), extra);
    for (i = 0; i < n; i++) {
      if (!canW) sc[i * 2] = -1e9;
      else if (!wallOk[i]) sc[i * 2] = -1e9;
      if (!canG) sc[i * 2 + 1] = -1e9;
      else if (!gunOk[i]) sc[i * 2 + 1] = -1e9;
    }
    var bestK = 0, bestV = sc[0];
    for (i = 1; i < n * 2; i++) if (sc[i] > bestV) { bestV = sc[i]; bestK = i; }
    /* the runner up, so a caller can see how close the choice was. A parity fixture's
     * minMargin is what tells an honest near tie from a real divergence. */
    var second = -Infinity;
    for (i = 0; i < n * 2; i++) if (i !== bestK && sc[i] > second) second = sc[i];
    var tileI = bestK >> 1, kindI = bestK & 1;
    return {
      cell: board.flat[tileI], kind: kindI === 0 ? WALL : TURRET,
      tileIndex: tileI, k: bestK, margin: bestV - second
    };
  }

  /* ------------------------------------------- the accommodator's extra columns
   *
   * SEAM C5-S1, closed. `stageb.py` build_phase_b is the law, and it is quoted here
   * because a paraphrase of it is what the defect was: the specializer reads
   * [X | one hot z] and the accommodator reads [X | h], where
   *
   *     S = board_summary(board, g, partner_seat, wave)   the PARTNER's seat, live board
   *     h = tanh(S . Ws + bs)                             this net's OWN trunk
   *
   * taken at the START of each accommodator turn and recomputed on EVERY accommodator
   * turn, which is what makes its belief move during a build phase. The specializer's z
   * is one number for a whole game, so a STATIC extra still covers it; an accommodator's
   * columns move, so its seat is marked dynamic and this runs once per turn.
   *
   * `accExtra` is the ONE code path. The page's live act, the Worker's gallery and plays
   * jobs, checkEpisodeVector's replay and the node suites all reach the trunk through it,
   * and it reaches the summary through `boardSummary`, the same encoder
   * `discriminateBoard` uses for the reader's bars. There is no second encoder and no
   * second law.
   */

  /* How many extra input columns this net's own shape says it reads as a trunk, and 0
   * when it reads none. Structural, never by a key's name (the minified pdf-lib lesson):
   * an accommodator carries Ws and bs and its W1 has exactly nIn + bs.length rows. A self
   * play engineer has nIn rows and no trunk, and a specializer has intent rows and no
   * trunk, so both answer 0 and neither is touched by any of this. */
  function accTrunkRows(net, nIn) {
    if (!net || !net.Ws || !net.bs || !net.W1 || !net.b1) return 0;
    var hid = net.b1.length, c = net.bs.length;
    if (!(hid > 0) || !(c > 0) || !(nIn >= 0)) return 0;
    if (net.W1.length !== (nIn + c) * hid) return 0;
    return c;
  }
  KeepCore.accTrunkRows = accTrunkRows;

  /* accExtra(g, bld, partnerSeat, wave, net) -> Float64Array(C), this turn's h.
   * accExtra(g, partnerSeat, wave, net) is the same for a caller holding no builder,
   * which is the second form boardSummary already accepts. */
  function accExtra(g, bld, partnerSeat, wave, net) {
    if (typeof bld === 'number') { net = wave; wave = partnerSeat; partnerSeat = bld; bld = null; }
    return trunk(net, boardSummary(g, bld, partnerSeat, wave));
  }
  KeepCore.accExtra = accExtra;

  /* This seat's extra columns for THIS turn. A static extra wins, because that is the
   * specializer's intent one hot and it is the caller's own decision; a seat marked
   * dynamic 'none' opts out explicitly, which is how a test stands the old behaviour up;
   * otherwise an accommodator seat recomputes and everything else gets nothing. */
  function extraForTurn(ag, g, bld, board, side, wave) {
    if (!ag || ag.kind !== 'net') return null;
    if (ag.extra) return ag.extra;
    if (ag.dynamic === 'none') return null;
    if (!accTrunkRows(ag.net, board ? board.nIn : -1)) return null;
    return accExtra(g, bld, side ^ 1, wave, ag.net);
  }
  KeepCore.extraForTurn = extraForTurn;

  /* Teacher forced replay of a recorded build phase: apply the placements in the order the
   * fixture recorded them, never the page's own policy. This is what P2 replays. */
  function replayBuildPhase(g, bld, placements, budgets, wave, onPlaced) {
    repairAll(g);
    var cfg = g.cfg, w = g.t.w;
    for (var i = 0; i < placements.length; i++) {
      var side = placements[i][0];
      var cell = placements[i][1];
      var kind = placements[i][2];
      var cost = (kind === WALL) ? cfg.wall_cost : cfg.turret_cost;
      place(g, cell % w, (cell / w) | 0, kind, side);
      budgets[side] -= cost;
      g.spent[side] += cost;
      if (bld) notePlace(bld, cell, kind, side);
      if (onPlaced) onPlaced(i, side, cell, kind);
    }
    return budgets;
  }
  KeepCore.replayBuildPhase = replayBuildPhase;

  function orderTurn(g, order, budget) {
    var cfg = g.cfg;
    for (var i = 0; i < order.length; i++) {
      var item = order[i];
      var cost = (item.kind === WALL) ? cfg.wall_cost : cfg.turret_cost;
      if (cost > budget) continue;
      if (alreadyDone(g, item)) continue;
      var cell = firstOption(g, item);
      if (cell < 0) continue;
      return { cell: cell, kind: item.kind };
    }
    return null;
  }

  /* The turn metered form: one seat's turn per call, so the page can run a build phase a
   * piece at a time while the visitor watches. buildPhase below is this in a loop, so there
   * is one implementation and an animated build cannot drift from a headless one.
   * newBuildState does NOT repair: buildPhase repairs once before the loop, exactly where
   * env.build_phase does. */
  function newBuildState(board) {
    return {
      side: 0, done: [false, false], turn: [0, 0],
      scratch: board ? new Float64Array(board.n * 2) : null
    };
  }
  KeepCore.newBuildState = newBuildState;

  function buildStep(g, bld, agents, budgets, wave, st, board) {
    board = board || (bld ? bld.b : null);
    if (st.done[0] && st.done[1]) return { done: true, placed: null, side: st.side };
    var side = st.side;
    if (st.done[side]) { st.side ^= 1; return { done: false, placed: null, side: side }; }
    var cfg = g.cfg, w = g.t.w;
    var ag = agents[side], pick = null;
    if (ag.kind === 'net') {
      /* the accommodator's columns are recomputed HERE, once per turn, because that is
       * where the trainer takes them (SEAM C5-S1) */
      pick = netTurn(g, bld, board, ag.net, side, budgets[side], wave, st.turn[side], st.scratch,
                     extraForTurn(ag, g, bld, board, side, wave));
    } else if (ag.kind === 'order') {
      pick = orderTurn(g, ag.order, budgets[side]);
    } else if (ag.kind === 'human') {
      pick = humanTurn(g, ag, budgets[side]);
    } else if (ag.kind === 'random') {
      pick = randomTurn(g, ag.rng, budgets[side]);
    }
    if (pick === null) {
      st.done[side] = true;
      st.side ^= 1;
      return { done: st.done[0] && st.done[1], placed: null, side: side };
    }
    var cost = (pick.kind === WALL) ? cfg.wall_cost : cfg.turret_cost;
    place(g, pick.cell % w, (pick.cell / w) | 0, pick.kind, side);
    budgets[side] -= cost;
    g.spent[side] += cost;
    if (bld) notePlace(bld, pick.cell, pick.kind, side);
    st.turn[side] += 1;
    if (ag.onPlace) ag.onPlace(pick, side, wave);
    st.side ^= 1;
    return { done: st.done[0] && st.done[1], placed: pick, side: side };
  }
  KeepCore.buildStep = buildStep;

  function buildPhase(g, bld, agents, budgets, wave, board) {
    repairAll(g);
    board = board || (bld ? bld.b : null);
    var st = newBuildState(board);
    var guard = 0;
    while (!(st.done[0] && st.done[1])) {
      if (guard++ > 100000) throw new Error('buildPhase did not terminate');
      buildStep(g, bld, agents, budgets, wave, st, board);
    }
    return budgets;
  }
  KeepCore.buildPhase = buildPhase;

  /* The visitor's seat: the page pushes one {cell, kind} per placement, so the visitor's
   * game is the same function call as the engineers'. */
  function humanTurn(g, ag, budget) {
    var cfg = g.cfg, w = g.t.w;
    while (ag.queue && ag.queue.length) {
      var q = ag.queue.shift();
      var cost = (q.kind === WALL) ? cfg.wall_cost : cfg.turret_cost;
      if (cost > budget) continue;
      var ok = (q.kind === TURRET && cfg.mounted_guns)
        ? canMount(g, q.cell % w, (q.cell / w) | 0)
        : canBuild(g, q.cell % w, (q.cell / w) | 0);
      if (!ok) continue;
      return { cell: q.cell, kind: q.kind };
    }
    return null;
  }

  /* The random control the world audit uses. Its generator is passed in: core never calls
   * Math.random. */
  function randomTurn(g, rng, budget) {
    var cfg = g.cfg, t = g.t, i;
    var kinds = [];
    if (budget >= cfg.wall_cost) kinds.push(WALL);
    if (budget >= cfg.turret_cost) kinds.push(TURRET);
    if (!kinds.length) return null;
    var kind = kinds.length === 1 ? kinds[0] : rng.choice(kinds);
    var pool = [];
    for (i = 0; i < t.buildableIdx.length; i++) {
      var c = t.buildableIdx[i];
      if (kind === TURRET && cfg.mounted_guns) {
        if (canMount(g, c % t.w, (c / t.w) | 0)) pool.push(c);
      } else if (canBuild(g, c % t.w, (c / t.w) | 0)) pool.push(c);
    }
    if (!pool.length) return null;
    return { cell: rng.choice(pool), kind: kind };
  }

  /* ------------------------------------------------------------------ hashing
   *
   * FNV-1a over a stream of int32 values, each fed as four little endian bytes. The field
   * order is pinned in _tests/twoengineers/INTERFACES.md because the Python side computes
   * the same hash and a reordering turns every recorded episode into a false failure.
   *
   * Structures are hashed in ASCENDING CELL ORDER, not in insertion order: the ruined
   * stubs enter the Python dict from a set, whose iteration order is hash based and not
   * reproducible in JS. Nothing in the sim reads that order (a ruin is a wall and the only
   * order sensitive loop skips walls), so a canonical order costs nothing and removes the
   * one field that could not be matched.
   */

  function fnvInit() { return 2166136261 >>> 0; }
  function fnvInt(h, v) {
    v = v | 0;
    for (var i = 0; i < 4; i++) {
      h = (h ^ ((v >>> (i * 8)) & 0xff)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }
  KeepCore.fnvInit = fnvInit;
  KeepCore.fnvInt = fnvInt;

  var PHASE = { BUILD: 0, RESOLVE: 1, OVER: 2 };
  KeepCore.PHASE = PHASE;

  /* hashState(g, ctx), in the field order of INTERFACES T1 pin 2. ctx supplies what the
   * game object does not carry on its own: which wave and which tick this is, and (for a
   * live wave) the wave state whose walkers are hashed. */
  function hashState(g, ctx) {
    /* ctx = {wave, tick, ws}. A ctx.phase is accepted and ignored: T1's pinned order has no
     * phase field, and a build phase is simply hashed with tick 0 and no walkers. */
    ctx = ctx || {};
    var ws = ctx.ws || null;
    var W = g.t.w;
    var h = fnvInit();
    h = fnvInt(h, 0x4B495431);                 /* the tag "KIT1" */
    h = fnvInt(h, g.keepHp);
    h = fnvInt(h, ctx.tick === undefined ? (ws ? ws.tick : 0) : ctx.tick);
    h = fnvInt(h, ctx.wave === undefined ? 0 : ctx.wave);
    h = fnvInt(h, g.leaks);
    h = fnvInt(h, g.spent[0]);
    h = fnvInt(h, g.spent[1]);
    var cells = [];
    g.struct.forEach(function (s, cell) { cells.push(cell); });
    cells.sort(function (a, b) { return a - b; });
    h = fnvInt(h, cells.length);
    for (var i = 0; i < cells.length; i++) {
      var st = g.struct.get(cells[i]);
      h = fnvInt(h, cells[i] % W);
      h = fnvInt(h, (cells[i] / W) | 0);
      h = fnvInt(h, st.kind - 1);              /* 0 wall, 1 gun */
      h = fnvInt(h, st.hp);
      h = fnvInt(h, st.owner);                 /* 0 seat A, 1 seat B, 2 ruin */
    }
    var live = [];
    if (ws) {
      for (var j = 0; j < ws.walkers.length; j++) if (ws.walkers[j].hp > 0) live.push(ws.walkers[j]);
      live.sort(function (a, b) { return a.wid - b.wid; });
    }
    h = fnvInt(h, live.length);
    for (var k = 0; k < live.length; k++) {
      var wk = live[k];
      h = fnvInt(h, wk.wid);
      h = fnvInt(h, wk.x);
      h = fnvInt(h, wk.y);
      h = fnvInt(h, wk.hp);
      h = fnvInt(h, wk.phase);
      h = fnvInt(h, wk.stuck);
      h = fnvInt(h, wk.atk ? 1 : 0);
    }
    var mk = g.focus ? g.focus.mark : [null, null];
    h = fnvInt(h, mk[0] === null || mk[0] === undefined ? 0xFFFFFFFF : mk[0]);
    h = fnvInt(h, mk[1] === null || mk[1] === undefined ? 0xFFFFFFFF : mk[1]);
    return h >>> 0;
  }
  KeepCore.hashState = hashState;

  /* ------------------------------------------------------------------ coverage and render */

  /* Cost weighted fraction of a doctrine's core line that is standing. */
  function coverage(g, core) {
    var total = 0, have = 0;
    for (var i = 0; i < core.length; i++) {
      var c = (core[i].kind === WALL) ? g.cfg.wall_cost : g.cfg.turret_cost;
      total += c;
      if (alreadyDone(g, core[i])) have += c;
    }
    return total ? have / total : 1.0;
  }
  KeepCore.coverage = coverage;

  /* ASCII dump of a board, for eyeballing one episode in a test. The renderer is a
   * separate module and this is never used on the page. */
  function renderAscii(g, ep) {
    var t = g.t, out = [], y, x;
    for (y = 0; y < t.h; y++) {
      var row = '';
      for (x = 0; x < t.w; x++) {
        var c = y * t.w + x;
        var s = g.struct.get(c);
        if (s !== undefined) row += (s.owner === OWNER.RUIN) ? 'r' : (s.kind === TURRET ? 'O' : '=');
        else if (ep && ep.rubbleSet.has(c)) row += ',';
        else row += t.cell[y][x];
      }
      out.push(row);
    }
    return out.join('\n');
  }
  KeepCore.renderAscii = renderAscii;

  /* ------------------------------------------------------------------ playEpisode
   *
   * THE LAW: the gallery, the cross play grid, the reader act, the walkthrough and the
   * your turn act all call this. Nothing computes a fortress any other way, which is what
   * keeps the caption "every square is a game your browser just played" true.
   */

  function agentFor(desc, seat, ctx) {
    var out = agentBody(desc, seat, ctx);
    if (desc && desc.onPlace) out.onPlace = desc.onPlace;   /* the page watches placements */
    return out;
  }

  function agentBody(desc, seat, ctx) {
    if (!desc || desc.kind === 'none' || desc.kind === 'nothing') return { kind: 'none' };
    if (desc.kind === 'doctrine') {
      var docs = ctx.doctrines;
      var d = null, i;
      for (i = 0; i < docs.length; i++) if (docs[i].key === desc.key) d = docs[i];
      if (!d) throw new Error('unknown doctrine ' + desc.key);
      var order;
      if (desc.split === 'comb') order = (seat === 0) ? d.orderEven() : d.orderOdd();
      else order = (seat === 0) ? d.orderForward() : d.orderBackward();
      return { kind: 'order', order: order, doctrine: d };
    }
    if (desc.kind === 'order') return { kind: 'order', order: desc.order };
    if (desc.kind === 'net') {
      /* SEAM C5-S1: an accommodator seat is marked DYNAMIC here, so a reader of the
       * agent can see which seat recomputes without playing a turn. buildStep re-derives
       * the same fact from the net's own shape, so an agent a caller built by hand (the
       * page's live act hands its own descriptors straight to buildStep) is seated the
       * same way. A static extra, which is the specializer's one hot, is left alone. */
      var a = { kind: 'net', net: desc.net, extra: desc.extra || null };
      if (desc.dynamic !== undefined) a.dynamic = desc.dynamic;
      else if (!a.extra && ctx && ctx.board && accTrunkRows(desc.net, ctx.board.nIn)) a.dynamic = 'acc';
      return a;
    }
    if (desc.kind === 'human') return { kind: 'human', queue: desc.queue || [] };
    if (desc.kind === 'random') return { kind: 'random', rng: desc.rng };
    throw new Error('unknown engineer kind ' + desc.kind);
  }

  function playEpisode(opts) {
    var cfg = opts.cfg || CFG;
    var terrain = opts.terrain || (opts.ep && opts.ep.terrain) || KeepCore.terrain(opts.map);
    var ep = opts.ep || makeEpisode(opts.seed, terrain, cfg);
    var g = newGame(ep, cfg);
    var needBoard = (opts.a && opts.a.kind === 'net') || (opts.b && opts.b.kind === 'net') || opts.board;
    /* the board must be the board of the terrain being played, not of the active map: a v4
     * regression hands in a v4 terrain and must get the v4 static feature block with it */
    var board = needBoard
      ? (opts.board || KeepCore.board(cfg, opts.map || mapNameOf(terrain) || undefined))
      : null;
    var bld = board ? makeBuilder(board, ep, g) : null;
    var ctx = { doctrines: opts.doctrines || null, board: board };
    var agents = [agentFor(opts.a, 0, ctx), agentFor(opts.b, 1, ctx)];
    var hashes = opts.hashes ? [] : null;
    /* The hash trail has the same shape and the same conventions as the parity fixtures:
     * one entry after every build placement, one at the END of every wave tick labelled
     * with the tick that just ran, one at the end of every wave, and one final entry whose
     * wave index is the last wave played (3 only when all three resolved with the keep
     * still standing). */
    var hashWave = 0;
    if (hashes) {
      for (var ai = 0; ai < 2; ai++) {
        (function (a) {
          var prev = a.onPlace;
          a.onPlace = function (pick, side, wave) {
            if (prev) prev(pick, side, wave);
            hashes.push(hashState(g, { wave: hashWave, phase: PHASE.BUILD, tick: 0, ws: null }));
          };
        }(agents[ai]));
      }
    }
    var covA = 0, covB = 0;
    var lastWave = 0;
    for (var wi = 0; wi < 3; wi++) {
      hashWave = wi;
      lastWave = wi;
      var ba = ep.budgets[wi][0], bb = ep.budgets[wi][1];
      if (opts.solo) bb = 0;
      var budgets = [Math.max(0, ba), Math.max(0, bb)];
      buildPhase(g, bld, agents, budgets, wi, board);
      if (agents[0].doctrine) covA = coverage(g, agents[0].doctrine.core);
      if (agents[1].doctrine) covB = coverage(g, agents[1].doctrine.core);
      var ws = waveInit(g, wi);
      while (!ws.done) {
        var ran = ws.tick;
        var ev = waveTick(g, ws, !!opts.onEvent);
        if (ev === null) break;                 /* the loop ended, no tick body ran */
        if (opts.onEvent) opts.onEvent(ev, ws, wi);
        if (hashes) hashes.push(hashState(g, { wave: wi, phase: PHASE.RESOLVE, tick: ran, ws: ws }));
      }
      waveFinish(g, ws);
      if (hashes) hashes.push(hashState(g, { wave: wi, phase: PHASE.RESOLVE, tick: ws.tick, ws: ws }));
      if (g.keepHp <= 0) break;
    }
    if (hashes) {
      /* the closing entry uses the LAST WAVE PLAYED, never 3. env.Game.wave_index is only
       * ever set to the wave it is running, so the trainer's own final hash is taken at 2
       * on a game the keep survived; the v4 fixtures had no survivor and could not tell the
       * two rules apart, and rollout 700180 of the v5 set does. Corrected 2026-09-06 (C3). */
      hashes.push(hashState(g, { wave: lastWave, phase: PHASE.OVER, tick: 0, ws: null }));
    }
    return {
      score: g.keepHp,
      leaks: g.leaks,
      covA: covA,
      covB: covB,
      spent: g.spent.slice(),
      log: g.log,
      g: g,
      ep: ep,
      hashes: hashes ? Uint32Array.from(hashes) : null
    };
  }
  KeepCore.playEpisode = playEpisode;

  /* ------------------------------------------------------------------ the model file
   *
   * Manifest driven: every tensor carries its own shape, the loader asserts that the
   * product of the shape equals the decoded length, and it REFUSES to run on a mismatch
   * instead of silently mis-striding. Fail loudly, never substitute a default.
   */

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B64REV = null;
  function b64ToBytes(s) {
    if (B64REV === null) {
      B64REV = new Int16Array(256);
      for (var i = 0; i < 256; i++) B64REV[i] = -1;
      for (i = 0; i < 64; i++) B64REV[B64.charCodeAt(i)] = i;
    }
    var clean = s.replace(/[^A-Za-z0-9+/]/g, '');
    /* the bit accumulator already drops the leftover bits of a padded group, so there is
     * nothing further to subtract for the padding; doing it anyway cost one byte off the
     * end of every weight vector. */
    var out = new Uint8Array(Math.floor(clean.length * 3 / 4));
    var oi = 0, acc = 0, bits = 0;
    for (i = 0; i < clean.length; i++) {
      var v = B64REV[clean.charCodeAt(i)];
      if (v < 0) throw new Error('bad base64 in model file');
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[oi++] = (acc >> bits) & 0xff;
      }
    }
    return out.subarray(0, oi);
  }
  KeepCore.b64ToBytes = b64ToBytes;

  function prod(shape) {
    var p = 1;
    for (var i = 0; i < shape.length; i++) p *= shape[i];
    return p;
  }

  function isTensor(v) {
    return v && typeof v === 'object' && Array.isArray(v.shape) &&
      (typeof v.b64 === 'string' || Array.isArray(v.data) || ArrayBuffer.isView(v.data));
  }

  function loadTensor(name, v) {
    var want = prod(v.shape), i, out;
    if (typeof v.b64 === 'string') {
      var bytes = b64ToBytes(v.b64);
      if (bytes.length !== want) {
        throw new Error('model tensor ' + name + ': shape ' + v.shape.join('x') +
          ' wants ' + want + ' values, decoded ' + bytes.length);
      }
      var scale = (v.s !== undefined) ? v.s : v.scale;   /* T1 pin 4 names it s */
      if (typeof scale !== 'number' || !isFinite(scale) || scale <= 0) {
        throw new Error('model tensor ' + name + ': scale must be finite and positive');
      }
      out = new Float64Array(want);
      for (i = 0; i < want; i++) {
        var q = bytes[i];
        if (q > 127) q -= 256;
        if (q < -127) throw new Error('model tensor ' + name + ': int8 out of range');
        out[i] = q * scale;
      }
      return out;
    }
    var src = v.data;
    if (src.length !== want) {
      throw new Error('model tensor ' + name + ': shape ' + v.shape.join('x') +
        ' wants ' + want + ' values, got ' + src.length);
    }
    out = new Float64Array(want);
    for (i = 0; i < want; i++) out[i] = src[i];
    return out;
  }

  function walkTensors(name, node, out) {
    if (isTensor(node)) { out[name] = loadTensor(name, node); return out[name]; }
    if (Array.isArray(node) && node.length && typeof node[0] === 'number') {
      return Float64Array.from(node);          /* a plain bias vector */
    }
    if (Array.isArray(node)) {
      var arr = [];
      for (var i = 0; i < node.length; i++) arr.push(walkTensors(name + '[' + i + ']', node[i], out));
      return arr;
    }
    if (node && typeof node === 'object') {
      var o = {}, k;
      for (k in node) if (Object.prototype.hasOwnProperty.call(node, k)) {
        o[k] = walkTensors(name ? (name + '.' + k) : k, node[k], out);
      }
      return o;
    }
    return node;
  }

  function loadModel(M) {
    if (!M || typeof M !== 'object') throw new Error('loadModel: no model');
    var flat = {};
    var m = walkTensors('', M, flat);
    m.tensors = flat;
    m.raw = M;
    m.mapName = KeepCore.MAP;
    m.mapMismatch = false;
    if (M.arch) {
      var nIn = M.arch.nIn !== undefined ? M.arch.nIn : M.arch.n_in;
      var b = KeepCore.board(CFG);
      if (nIn !== undefined && nIn !== b.nIn) {
        throw new Error('model arch nIn ' + nIn + ' does not match the board nIn ' + b.nIn);
      }
      /* The model may name the board it was trained on. Its tile count is checked against
       * THAT board, so an honest v4 file reports an honest v4 number; the map itself is
       * then compared with the active one. A TRAINED cast on the wrong board is a refusal,
       * because its weights were fitted to gorges that are not the gorges on screen. A
       * placeholder or a mock loads with mapMismatch set, so the page can say so on the
       * verify plate rather than the file simply failing to load. */
      var mock = !!(M.meta && M.meta.mock === true);
      var modelMap = (typeof M.arch.map === 'string' && KeepCore.MAPS[M.arch.map])
        ? M.arch.map : KeepCore.MAP;
      m.mapName = mock ? KeepCore.MAP : modelMap;
      m.mapMismatch = (m.mapName !== KeepCore.MAP);
      var mb = (m.mapName === KeepCore.MAP) ? b : KeepCore.board(CFG, m.mapName);
      /* A MOCK is exempt from the board guard, exactly as it is exempt from the
       * featureNames guard (P-S9): its tensors are sized from KeepCore.ARCH, so its own
       * arch block is a label rather than a claim, and a stand-in whose label says v4
       * while its shapes say v5 must still load or the page cannot show the loud stand-in
       * plate the visitor is owed. Every other file is held to its own arch. */
      if (!mock && M.arch.tiles !== undefined && M.arch.tiles !== mb.n) {
        throw new Error('model arch tiles ' + M.arch.tiles + ' does not match map ' +
          m.mapName + ', which has ' + mb.n);
      }
      var trained = M.meta && typeof M.meta.trained === 'string' && M.meta.trained.length > 0;
      var placeholder = !!(M.meta && (M.meta.placeholder === true || mock));
      if (m.mapMismatch && trained && !placeholder) {
        throw new Error('this model was trained on map ' + modelMap +
          ' and the core is playing map ' + KeepCore.MAP +
          '; a trained cast is not portable between boards');
      }
    }
    /* featureNames is a GUARD, not a comment: core builds its own list from its own
     * packing code and compares it element by element, so a reordering fails loudly at load
     * instead of quietly playing worse. */
    if (M.featureNames && !(M.meta && M.meta.mock === true)) {
      var mine = KeepCore.FEATURE_NAMES;
      var theirs = (M.featureNames.local || []).concat(M.featureNames.global || []);
      if (theirs.length && theirs.length !== mine.length) {
        throw new Error('model featureNames has ' + theirs.length + ' entries, core packs ' + mine.length);
      }
      for (var fi = 0; fi < theirs.length; fi++) {
        if (theirs[fi] !== mine[fi]) {
          throw new Error('model featureNames[' + fi + '] is ' + theirs[fi] + ', core packs ' + mine[fi]);
        }
      }
    }
    return m;
  }
  KeepCore.loadModel = loadModel;

  /* A net is any object carrying W1, b1, W2, b2. netFor walks a dotted path so a page can
   * ask for 'selfplay[3]' or 'accommodator[0]' without the core knowing the layout. */
  function netFor(m, key) {
    if (!key) throw new Error('netFor: no key');
    if (m.nets && m.nets[key]) {
      var direct = m.nets[key];
      if (!direct.W1 || !direct.b1 || !direct.W2 || !direct.b2) {
        throw new Error('netFor: ' + key + ' is not a scorer net');
      }
      return direct;
    }
    var parts = String(key).split('.');
    var node = m;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i], br = p.indexOf('[');
      if (br >= 0) {
        var base = p.slice(0, br);
        var idx = parseInt(p.slice(br + 1), 10);
        node = node[base];
        if (node === undefined) throw new Error('netFor: no such net ' + key);
        node = node[idx];
      } else {
        node = node[p];
      }
      if (node === undefined) throw new Error('netFor: no such net ' + key);
    }
    if (!node.W1 || !node.b1 || !node.W2 || !node.b2) {
      throw new Error('netFor: ' + key + ' is not a scorer net');
    }
    return node;
  }
  KeepCore.netFor = netFor;

  /* P1 probes: the model file carries pre computed scores for a fixed feature matrix, and
   * this recomputes them. A failure names the probe, so one bad head is identifiable. */
  function checkProbes(m, tol) {
    tol = tol === undefined ? 1e-4 : tol;
    var probes = probesOf(m);
    if (!probes || !probes.length) return { ok: false, reason: 'no probes in the model file', max: 0, n: 0 };
    var worst = 0, bad = null;
    for (var i = 0; i < probes.length; i++) {
      var p = probes[i];
      var net = netFor(m, p.net);
      var arch = (m.raw && m.raw.arch) || m.arch || null;
      var nIn = p.nIn || (arch && (arch.nIn || arch.n_in));
      var rows = p.rows || (p.X.length / nIn);
      var X = Float64Array.from(p.X);
      var sc = scoreTiles(net, X, rows, nIn, null);
      for (var j = 0; j < p.out.length; j++) {
        var dd = Math.abs(sc[j] - p.out[j]);
        if (dd > worst) { worst = dd; if (dd > tol) bad = p.net + ' index ' + j; }
      }
    }
    return { ok: worst <= tol, max: worst, n: probes.length, reason: bad };
  }
  KeepCore.checkProbes = checkProbes;

  /* ---------------------------------------------------------------- the test vector
   *
   * SEAM V1-S1. The model file carries its own proof and this runs it in the browser, so
   * the line the page prints is a measurement rather than a promise. Two halves, reported
   * separately because they prove different things:
   *
   *   probes   P1. A fixed feature matrix and the scores the trainer computed for it. This
   *            catches a dequantisation, stride or accumulation order fault in the forward
   *            pass, and it names the head that is off.
   *   episode  P2. ONE recorded three wave game (T1 pin 4's testVector.episode, in the
   *            shape of fixtures/episode-random.json), replayed two ways:
   *              env    the recorded placements are teacher forced and hashState is
   *                     compared against every recorded entry, so the whole environment is
   *                     proved tick by tick;
   *              moves  the same episode is played FREELY through playEpisode with the
   *                     recorded net and every placement is compared with the recording,
   *                     which is what lets the page say the browser matched it move for
   *                     move. It runs only when the recording names a net this file can
   *                     resolve, and movesProved says whether it did.
   *
   * It never throws and it never substitutes a default. A model carrying no vector comes
   * back status 'absent', which is not the same thing as a model that failed one.
   */

  function testVectorOf(m) {
    if (!m) return null;
    if (m.raw && m.raw.testVector) return m.raw.testVector;
    if (m.testVector) return m.testVector;
    return null;
  }
  KeepCore.testVectorOf = testVectorOf;

  /* Where a model file may keep its probes: T1 pin 4 puts them inside testVector, the
   * earlier fixtures put them at the top level. Both are read, neither is invented. */
  function probesOf(m) {
    if (!m) return null;
    if (m.raw && m.raw.probes && m.raw.probes.length) return m.raw.probes;
    var tv = testVectorOf(m);
    if (tv && tv.probes && tv.probes.length) return tv.probes;
    if (m.probes && m.probes.length) return m.probes;
    return null;
  }

  /* The fixture's own weight form: base64 of a little endian float32 vector packed
   * W1[nIn, hidden], b1[hidden], W2[hidden, 2], b2[2]. A trained export names a net key
   * instead, and both are accepted. */
  function netFromTheta(b64, nIn, hidden) {
    var bytes = b64ToBytes(b64);
    var total = bytes.length >> 2;
    if (total * 4 !== bytes.length) throw new Error('theta is not a whole float32 vector');
    var want = nIn * hidden + hidden + hidden * 2 + 2;
    if (total !== want) {
      throw new Error('theta holds ' + total + ' floats, the shape ' + nIn + 'x' + hidden +
        ' wants ' + want);
    }
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var th = new Float64Array(total), i;
    for (i = 0; i < total; i++) th[i] = dv.getFloat32(i * 4, true);
    var o = 0;
    var W1 = th.slice(o, o + nIn * hidden); o += nIn * hidden;
    var b1 = th.slice(o, o + hidden); o += hidden;
    var W2 = th.slice(o, o + hidden * 2); o += hidden * 2;
    var b2 = th.slice(o, o + 2);
    return { W1: W1, b1: b1, W2: W2, b2: b2 };
  }
  KeepCore.netFromTheta = netFromTheta;

  /* SEAM T2b-S3. A recording may name EXTRA input columns per seat: the values that are
   * broadcast to every tile alongside the board's own features, exactly as buildStep hands
   * them to scoreTiles. That is what lets a specializer recording (the board inputs then a
   * six wide intent one hot) replay move for move beside the matched self play one. Three
   * forms are read and nothing else:
   *
   *   [numbers]  the columns themselves, in order
   *   <integer>  a one hot of that index, width from the model file's own arch.N
   *   null       no extra columns, which is every recording written before this
   *
   * An accommodator is NOT covered by a static extra: its columns are a trunk over the
   * partner's board summary and change every turn. Since SEAM C5-S1 was closed such a
   * seat is played by `extraForTurn`, which recomputes them, and a recording says so
   * either by naming a net this file resolves to one (the shape is read off W1) or by
   * writing the word 'acc' where a static extra would go. Both reach the same path;
   * `isDynamicExtra` below is the only place that word is read. */
  /* The word a recording may write where a static extra would go, to say that this seat
   * recomputes its columns every turn. It resolves to NO static extra: the seat's own W1
   * shape is what buildStep reads, and this only stops the word being taken for a form
   * tvExtra does not know. */
  function isDynamicExtra(spec) {
    return spec === 'acc' || spec === 'trunk' || spec === 'dynamic' || spec === 'accommodator';
  }
  KeepCore.isDynamicExtra = isDynamicExtra;

  function tvExtra(m, spec, what) {
    if (spec === undefined || spec === null || isDynamicExtra(spec)) return null;
    if (typeof spec === 'number') {
      var n = (m && m.raw && m.raw.arch && m.raw.arch.N) ? (m.raw.arch.N | 0) : 0;
      if (!(n > 0)) {
        throw new Error(what + ' names intent ' + spec +
          ' but the model file carries no arch.N to size the one hot');
      }
      if (!(spec >= 0 && spec < n && (spec | 0) === spec)) {
        throw new Error(what + ' names intent ' + spec + ', outside the ' + n +
          ' this file carries');
      }
      return oneHot(spec | 0, n);
    }
    if (Array.isArray(spec) || ArrayBuffer.isView(spec)) {
      var v = new Float64Array(spec.length), i;
      for (i = 0; i < spec.length; i++) {
        v[i] = +spec[i];
        if (!isFinite(v[i])) throw new Error(what + ' column ' + i + ' is not a finite number');
      }
      return v;
    }
    throw new Error(what + ' is in no form this core reads');
  }
  KeepCore.tvExtra = tvExtra;

  function tvNet(m, rec, which, extraSpec) {
    var n = (which === undefined) ? rec.net : which;
    if (n === undefined || n === null) return null;
    var ex = tvExtra(m, extraSpec, (which === undefined)
      ? 'the recorded extra' : 'the recorded extraB');
    if (typeof n === 'string') {
      return { net: netFor(m, n), how: 'the model net ' + n, extra: ex };
    }
    if (typeof n === 'object' && typeof n.theta === 'string') {
      var hidden = (n.hidden !== undefined) ? n.hidden : rec.hidden;
      var nIn = (n.nIn !== undefined) ? n.nIn : rec.nIn;
      if (!hidden || !nIn) throw new Error('the recorded weights carry no shape');
      return { net: netFromTheta(n.theta, nIn, hidden), how: 'the recorded weights', extra: ex };
    }
    if (n.W1 && n.b1 && n.W2 && n.b2) return { net: n, how: 'an inline net', extra: ex };
    throw new Error('the recorded net is in no form this core reads');
  }

  function checkEpisodeVector(m, rec, opts) {
    var res = {
      ran: false, ok: false, entries: 0, checked: 0, firstBad: null,
      keepHp: null, wantKeepHp: null, finalHash: null,
      moves: { ran: false, ok: false, failed: false, n: 0, diverged: 0, firstBad: null, how: null,
        dynamic: false, dynamicB: false }
    };
    if (!rec || !rec.episode || !rec.phases || !rec.ticks || !rec.ticks.length) {
      res.firstBad = 'the recorded episode is missing its episode, phases or ticks';
      return res;
    }
    var cfg = opts.cfg || CFG;
    var terr = opts.terrain || KeepCore.terrain(opts.map || (rec.arch && rec.arch.map) || undefined);
    var board = KeepCore.board(cfg, opts.map || mapNameOf(terr) || undefined);
    var ep = episodeFromRecord(rec.episode, terr, cfg);
    var trail = rec.ticks;
    var bad = 0, ti = 0, ws = null, wi, pi;
    res.entries = trail.length;

    /* ---- the env half: teacher forced, hashed at every recorded entry ---- */
    var g = newGame(ep, cfg);
    var bld = makeBuilder(board, ep, g);

    function check(kind, wave, tick) {
      if (ti >= trail.length) {
        bad++;
        if (res.firstBad === null) res.firstBad = 'the replay ran past the end of the recording';
        ti++;
        return;
      }
      var wnt = trail[ti];
      var h = hashState(g, { wave: wave, tick: tick, ws: (kind === 'b') ? null : ws }) >>> 0;
      if (wnt.kind !== kind || wnt.wave !== wave) {
        bad++;
        if (res.firstBad === null) {
          res.firstBad = 'entry ' + ti + ': the recording is at ' + wnt.kind + ' wave ' +
            wnt.wave + ', the replay is at ' + kind + ' wave ' + wave;
        }
      } else if (h !== (wnt.h >>> 0)) {
        bad++;
        if (res.firstBad === null) {
          res.firstBad = 'entry ' + ti + ' (' + kind + ' wave ' + wave + ' tick ' + tick +
            '): this browser hashed ' + h + ', the recording has ' + (wnt.h >>> 0);
        }
      } else {
        res.checked++;
      }
      ti++;
    }

    var lastWave = 0;
    for (wi = 0; wi < 3; wi++) {
      lastWave = wi;
      var budgets = [Math.max(0, ep.budgets[wi][0]), Math.max(0, ep.budgets[wi][1])];
      var ph = rec.phases[wi] || [];
      var placements = [];
      for (pi = 0; pi < ph.length; pi++) {
        placements.push([ph[pi][0] | 0, board.flat[ph[pi][1] | 0],
          (ph[pi][2] | 0) === 0 ? WALL : TURRET]);
      }
      ws = null;
      replayBuildPhase(g, bld, placements, budgets, wi, (function (w) {
        return function () { check('b', w, 0); };
      }(wi)));
      ws = waveInit(g, wi);
      while (!ws.done) {
        /* the hash is taken at the END of a tick body but is LABELLED with the tick that
         * just ran, so capture it before waveTick advances the counter (C pin, fixtures) */
        var ran = ws.tick;
        if (waveTick(g, ws, false) === null) break;
        check('t', wi, ran);
      }
      waveFinish(g, ws);
      check('w', wi, ws.tick);
      if (g.keepHp <= 0) break;
    }
    res.ran = true;
    if (ti !== trail.length) {
      bad++;
      if (res.firstBad === null) {
        res.firstBad = 'the replay consumed ' + ti + ' of the ' + trail.length +
          ' recorded entries';
      }
    }
    res.keepHp = g.keepHp;
    if (rec.keepHp !== undefined) {
      res.wantKeepHp = rec.keepHp;
      if (g.keepHp !== rec.keepHp) {
        bad++;
        if (res.firstBad === null) {
          res.firstBad = 'the game ended on keep ' + g.keepHp + ', the recording ends on ' +
            rec.keepHp;
        }
      }
    }
    if (rec.finalHash !== undefined) {
      /* waveIndex is the LAST WAVE PLAYED, and it is never 3: the trainer hashes with
       * game.wave_index, which is only ever set to the wave being run. A recorded episode
       * whose keep SURVIVES therefore closes at 2, and the old rule would have failed the
       * page's own verify plate on exactly the models worth shipping. */
      var fh = hashState(g, { wave: lastWave, tick: 0, ws: null }) >>> 0;
      res.finalHash = (fh === (rec.finalHash >>> 0));
      if (!res.finalHash) {
        bad++;
        if (res.firstBad === null) {
          res.firstBad = 'the final hash is ' + fh + ', the recording has ' +
            (rec.finalHash >>> 0);
        }
      }
    }
    res.ok = (bad === 0 && res.checked === trail.length);

    /* ---- the moves half: the same episode played freely, placement by placement ---- */
    if (opts.moves === false) return res;
    var packA = null, packB = null;
    /* opts wins over the recording, so a caller can replay one recording at several
     * intents without rewriting the file */
    /* SEAM T2d-S1 names the two fields extraSeatA and extraSeatB; the earlier recordings
     * name them extra and extraB. Both are read, in that order, so one recording shape
     * does not have to be rewritten to be replayed by the other's reader. */
    var recA = (rec.extra !== undefined) ? rec.extra : rec.extraSeatA;
    var recB = (rec.extraB !== undefined) ? rec.extraB : rec.extraSeatB;
    var exA = (opts.extra !== undefined) ? opts.extra : recA;
    var hasB = !(rec.netB === undefined || rec.netB === null);
    var exB;
    if (opts.extraB !== undefined) exB = opts.extraB;
    else if (recB !== undefined) exB = recB;
    else exB = hasB ? null : exA;   /* one agent in both seats keeps one extra */
    try {
      packA = tvNet(m, rec, undefined, exA);
      packB = (!hasB && exB === exA) ? packA
        : tvNet(m, rec, hasB ? rec.netB : rec.net, exB);
    } catch (err) {
      /* a recording that NAMES a net this file cannot resolve is a broken vector, not
       * a half that politely did not run, so it fails rather than passing quietly */
      res.moves.firstBad = (err && err.message) ? err.message : String(err);
      res.moves.failed = true;
      return res;
    }
    if (packA === null) return res;
    /* The policy's first weight matrix has one row per input column, so a net with more
     * rows than the replay offers is being played with part of itself switched off. That
     * would replay as a quietly wrong answer instead of a loud one, which is the whole
     * thing this file exists to prevent, so it fails here and says what is missing. */
    function rowGuard(pack, seat) {
      if (!pack || !pack.net || !pack.net.W1 || !pack.net.b1) return true;
      var hid = pack.net.b1.length;
      var nEx = pack.extra ? pack.extra.length : 0;
      /* SEAM C5-S1: a seat naming no static extra whose net carries a trunk of the right
       * width is an ACCOMMODATOR, and buildStep will hand it one recomputed vector per
       * turn. Counting those columns here is what lets the guard read the shape the
       * replay will actually play, instead of failing an honest recording. */
      var dyn = 0;
      if (!nEx) { dyn = accTrunkRows(pack.net, board.nIn); nEx = dyn; }
      pack.dynamic = dyn > 0;
      var want = board.nIn + nEx;
      if (!hid || pack.net.W1.length !== want * hid) {
        var rows = hid ? (pack.net.W1.length / hid) : 0;
        res.moves.firstBad = 'seat ' + seat + ': the recorded net has ' + rows +
          ' input rows and this replay offers ' + want + ' columns (' + board.nIn +
          ' board inputs' + (nEx ? (' plus ' + nEx + (dyn ? ' trunk' : ' extra')) : ' and no extra') +
          '), so the recording does not say what the missing columns hold';
        res.moves.failed = true;
        return false;
      }
      return true;
    }
    if (!rowGuard(packA, 'A') || !rowGuard(packB, 'B')) return res;
    res.moves.ran = true;
    res.moves.how = packA.how;
    res.moves.extra = packA.extra ? packA.extra.length : (packA.dynamic ? accTrunkRows(packA.net, board.nIn) : 0);
    res.moves.extraB = (packB && packB.extra) ? packB.extra.length
      : ((packB && packB.dynamic) ? accTrunkRows(packB.net, board.nIn) : 0);
    /* which seats recompute, so a caller can tell a trunk from a one hot in the result */
    res.moves.dynamic = !!packA.dynamic;
    res.moves.dynamicB = !!(packB && packB.dynamic);
    var wantList = [];
    for (wi = 0; wi < 3; wi++) {
      var pw = rec.phases[wi] || [];
      for (pi = 0; pi < pw.length; pi++) {
        wantList.push([wi, pw[pi][0] | 0, pw[pi][1] | 0, pw[pi][2] | 0]);
      }
    }
    var got = 0, div = 0;
    function watch(pick, side, wave) {
      var wnt = wantList[got];
      var kindIdx = (pick.kind === WALL) ? 0 : 1;
      var same = (wnt !== undefined) && wnt[0] === wave && wnt[1] === side &&
        wnt[2] === pick.tileIndex && wnt[3] === kindIdx;
      if (wnt === undefined) {
        div++;
        if (res.moves.firstBad === null) {
          res.moves.firstBad = 'the policy placed more pieces than the recording holds';
        }
      } else if (!same) {
        div++;
        if (res.moves.firstBad === null) {
          res.moves.firstBad = 'placement ' + got + ': this browser played wave ' + wave +
            ' seat ' + side + ' tile ' + pick.tileIndex + ' ' +
            (kindIdx === 0 ? 'wall' : 'gun') + ', the recording has wave ' + wnt[0] +
            ' seat ' + wnt[1] + ' tile ' + wnt[2] + ' ' + (wnt[3] === 0 ? 'wall' : 'gun');
        }
      }
      got++;
    }
    playEpisode({
      ep: ep, cfg: cfg, terrain: terr, board: board,
      a: { kind: 'net', net: packA.net, extra: packA.extra || null, onPlace: watch },
      b: { kind: 'net', net: packB.net, extra: packB.extra || null, onPlace: watch }
    });
    res.moves.n = got;
    if (got !== wantList.length) {
      div++;
      if (res.moves.firstBad === null) {
        res.moves.firstBad = 'the policy placed ' + got + ' pieces, the recording holds ' +
          wantList.length;
      }
    }
    res.moves.diverged = div;
    res.moves.ok = (div === 0);
    return res;
  }

  /* Exported so ONE recording can be checked on its own, which is what a fixture that is
   * not yet inside a model file's testVector needs (SEAM T2d-S1's accommodator episode).
   * checkTestVector below is this in a loop over the file's own list. */
  KeepCore.checkEpisodeVector = checkEpisodeVector;

  /* checkTestVector(m, opts) -> {ok, status, present, reason, probes, episode, movesProved}
   * opts: {tol, probes:false, episode:false, moves:false, cfg, terrain}
   * status is 'ok' | 'mismatch' | 'absent' | 'error'. ok is true only when every half that
   * ran passed and at least one half ran. */
  function checkTestVector(m, opts) {
    opts = opts || {};
    var out = {
      ok: false, status: 'absent', present: false, reason: null,
      probes: null, episode: null, movesProved: false
    };
    if (!m || typeof m !== 'object') {
      out.status = 'error';
      out.reason = 'no model was handed to checkTestVector';
      return out;
    }
    var ran = 0, failed = 0;
    try {
      var tv = testVectorOf(m);
      var pr = probesOf(m);
      /* One recording, or a list of them. D2 section 10 asks for two (a matched pair and
       * a crossed one) and the field that carries the second is `episodes`; a file with
       * one keeps writing `episode` and reads exactly as it always did. */
      var recs = null;
      if (tv && Array.isArray(tv.episodes) && tv.episodes.length) recs = tv.episodes.slice();
      else {
        var one = tv ? (tv.episode || tv.recorded || null) : null;
        if (one) recs = [one];
      }
      out.present = !!(pr || (recs && recs.length));
      if (opts.probes !== false && pr) {
        ran++;
        var p = checkProbes(m, opts.tol);
        out.probes = { ran: true, ok: p.ok, n: p.n, max: p.max, reason: p.reason || null };
        if (!p.ok) {
          failed++;
          if (out.reason === null) {
            out.reason = 'a probe is off by ' + p.max +
              (p.reason ? (' (' + p.reason + ')') : '');
          }
        }
      }
      if (opts.episode !== false && recs) {
        ran++;
        /* the recorded episode replays on the board the model file names, so a v4 file's
         * own recording is still checked honestly while the core is playing v5 */
        var eopts = opts;
        if (opts.map === undefined && opts.terrain === undefined && m.mapName) {
          eopts = {};
          for (var ok2 in opts) if (Object.prototype.hasOwnProperty.call(opts, ok2)) eopts[ok2] = opts[ok2];
          eopts.map = m.mapName;
        }
        out.episodes = [];
        var allMoves = true, anyBad = false;
        for (var ri = 0; ri < recs.length; ri++) {
          var e = checkEpisodeVector(m, recs[ri], eopts);
          out.episodes.push(e);
          if (ri === 0) out.episode = e;
          if (!(e.moves.ran && e.moves.ok)) allMoves = false;
          if (!(e.ran && e.ok && !e.moves.failed && (!e.moves.ran || e.moves.ok))) {
            anyBad = true;
            if (out.reason === null) {
              out.reason = (recs.length > 1 ? 'recording ' + ri + ': ' : '') +
                (e.firstBad || e.moves.firstBad);
            }
          }
        }
        out.movesProved = allMoves;
        if (anyBad) failed++;
      }
    } catch (err) {
      out.status = 'error';
      out.reason = (err && err.message) ? err.message : String(err);
      return out;
    }
    if (ran === 0) {
      out.status = out.present ? 'error' : 'absent';
      out.reason = out.present
        ? 'the test vector was present but no half of it ran'
        : 'this model file carries no test vector';
      return out;
    }
    out.ok = (failed === 0);
    out.status = out.ok ? 'ok' : 'mismatch';
    if (!out.ok && out.reason === null) out.reason = 'the recorded game did not replay';
    return out;
  }
  KeepCore.checkTestVector = checkTestVector;


  /* INTERFACES T1 pin 3: the feature order, listed from the packing code above so the
   * model file's featureNames can be compared against it element by element. */
  KeepCore.FEATURE_NAMES = [
    'bias', 'nx', 'ny', 'd0', 'flow0',
    'ybump0', 'ybump1', 'ybump2', 'ybump3', 'ybump4',
    'xbump0', 'xbump1', 'xbump2', 'xbump3', 'xbump4',
    'rowwidth', 'dwest', 'deast',
    'livedist', 'liveflow', 'adj_h', 'adj_v', 'adj_mine', 'adj_partner',
    'turret_cov', 'adj_ruin', 'dcentre',
    'budget', 'wave0', 'wave1', 'wave2', 'seat', 'mine', 'partner', 'turn'
  ];

  function oneHot(z, n) {
    var v = new Float64Array(n);
    if (z >= 0 && z < n) v[z] = 1.0;
    return v;
  }
  KeepCore.oneHot = oneHot;

  /* h = tanh(S . Ws + bs), the accommodator's trunk over the partner board summary */
  function trunk(net, S) {
    if (!net.Ws || !net.bs) throw new Error('trunk: this net has no summary trunk');
    var hid = net.bs.length, sIn = S.length, i, k, acc;
    var h = new Float64Array(hid);
    for (i = 0; i < hid; i++) {
      acc = 0;
      for (k = 0; k < sIn; k++) acc += S[k] * net.Ws[k * hid + i];
      h[i] = Math.tanh(acc + net.bs[i]);
    }
    return h;
  }
  KeepCore.trunk = trunk;

  /* softmax(h . Wd + bd): the discriminator head's RAW output, which is what the page
   * shows. Easing a bar's height for display is allowed; the announced number, the argmax
   * and the change count all come from this. */
  function discriminate(net, h) {
    if (!net.Wd || !net.bd) throw new Error('discriminate: this net has no discriminator head');
    var n = net.bd.length, hid = h.length, i, k, acc;
    var z = new Float64Array(n), mx = -Infinity;
    for (i = 0; i < n; i++) {
      acc = 0;
      for (k = 0; k < hid; k++) acc += h[k] * net.Wd[k * n + i];
      z[i] = acc + net.bd[i];
      if (z[i] > mx) mx = z[i];
    }
    var sum = 0;
    for (i = 0; i < n; i++) { z[i] = Math.exp(z[i] - mx); sum += z[i]; }
    for (i = 0; i < n; i++) z[i] /= sum;
    return z;
  }
  KeepCore.discriminate = discriminate;

  /* ------------------------------------------------- the S = 36 board summary
   *
   * SEAM T2a-S1, ported line for line from the trainer's `board_summary`. It is the
   * discriminator's input: what ONE seat has on the board right now, read off the board
   * and never off its actions, so nothing in it knows a plan. That is the sentence the
   * page's honesty card makes, and it is only true because this encoder reads geometry
   * and bookkeeping and nothing else.
   *
   * D2 section 3.3 wrote the table for a 14 x 10 board ("10 rows", "7 bands of 2
   * columns"). The shipped board is 28 x 19, so both blocks are BANDS over the buildable
   * tiles' own bounding box, which lands on v4 (243 tiles) and v5 (239) with no constant
   * naming a board.
   */

  var N_SUMMARY = 36;
  var S_ROWS = 10;                 /* row bands, features 3 to 12 */
  var S_COLS = 7;                  /* column bands, features 13 to 19 */
  var S_DNORM = 24.0;
  var S_WALL_NORM = 12.0;
  var S_GUN_NORM = 8.0;
  var S_RUN_NORM = 8.0;
  var S_LOST_NORM = 6.0;

  /* The pinned strings, in the pinned order. These are the ones the model file carries
   * (the trainer holds two lists in the same order and this is the shadowing one). */
  var SUMMARY_NAMES = [
    'p_walls', 'p_guns', 'p_wallshare',
    'row0', 'row1', 'row2', 'row3', 'row4',
    'row5', 'row6', 'row7', 'row8', 'row9',
    'band0', 'band1', 'band2', 'band3', 'band4', 'band5', 'band6',
    'p_walldist', 'p_gundist', 'p_contig', 'p_runh',
    'p_west', 'p_valleys', 'p_frontage', 'p_traffic', 'p_guncover',
    'p_unspent', 's_wave0', 's_wave1', 's_wave2', 'p_seat', 'p_lost', 's_bias'
  ];
  KeepCore.SUMMARY_NAMES = SUMMARY_NAMES;
  KeepCore.SUMMARY_CONST = Object.freeze({
    S: N_SUMMARY, ROWS: S_ROWS, COLS: S_COLS, DNORM: S_DNORM,
    WALL_NORM: S_WALL_NORM, GUN_NORM: S_GUN_NORM, RUN_NORM: S_RUN_NORM,
    LOST_NORM: S_LOST_NORM
  });

  function clip01(v) {
    if (v < 0.0) return 0.0;
    if (v > 1.0) return 1.0;
    return v;
  }

  /* The terrain derived tables the summary reads, computed once per board and cached on
   * it. ygal is the GALLERY row: the first row, scanning y up from 0, whose buildable
   * tiles form ONE contiguous run. Every row above it is cut into separate corridors, so
   * `y < ygal` is exactly the three gorges (row 6 on v4 and on v5). Derived from the
   * terrain, never written down, so a new board needs no new constant. */
  function summaryTables(board) {
    if (board._sumtab) return board._sumtab;
    var t = board.t, n = board.n, tiles = board.tiles, i, k, x, y;
    var xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (i = 0; i < n; i++) {
      x = tiles[i][0]; y = tiles[i][1];
      if (x < xmin) xmin = x;
      if (x > xmax) xmax = x;
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }
    var rows = new Map();
    for (i = 0; i < n; i++) {
      y = tiles[i][1];
      var bucket = rows.get(y);
      if (!bucket) { bucket = []; rows.set(y, bucket); }
      bucket.push(tiles[i][0]);
    }
    var ygal = ymax + 1;
    for (y = 0; y < t.h; y++) {
      var row = rows.get(y);
      if (!row) continue;
      row = row.slice().sort(function (a, b) { return a - b; });
      var runs = 1;
      for (k = 1; k < row.length; k++) if (row[k] !== row[k - 1] + 1) runs += 1;
      if (runs === 1) { ygal = y; break; }
    }
    /* the empty board distance field, which is what the trainer's Board.dist0 is */
    var d0 = dist(newGame(emptyEpisode(t, board.cfg), board.cfg));
    var rowband = new Int32Array(n), colband = new Int32Array(n);
    var west = new Float64Array(n), valley = new Float64Array(n), front = new Float64Array(n);
    var dst = new Float64Array(n), flow = new Float64Array(n);
    var NB = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (i = 0; i < n; i++) {
      x = tiles[i][0]; y = tiles[i][1];
      rowband[i] = (((y - ymin) * S_ROWS) / (ymax - ymin + 1)) | 0;
      colband[i] = (((x - xmin) * S_COLS) / (xmax - xmin + 1)) | 0;
      west[i] = (2 * x < t.w) ? 1.0 : 0.0;
      valley[i] = (y < ygal) ? 1.0 : 0.0;
      var f = 0.0;
      for (k = 0; k < 4; k++) {
        var nx = x + NB[k][0], ny = y + NB[k][1];
        if (nx < 0 || ny < 0 || nx >= t.w || ny >= t.h) continue;
        if (t.isKeep[ny * t.w + nx]) { f = 1.0; break; }
      }
      front[i] = f;
      var dv = d0[y * t.w + x];
      dst[i] = (dv > S_DNORM ? S_DNORM : dv) / S_DNORM;
      /* the STATIC traffic feature, log1p(flow0) / 2, which is local feature 4 */
      flow[i] = board.staticF[i * board.nLocal + 4];
    }
    board._sumtab = {
      rowband: rowband, colband: colband, west: west, valley: valley, front: front,
      dist: dst, flow: flow, ygal: ygal,
      xmin: xmin, xmax: xmax, ymin: ymin, ymax: ymax
    };
    return board._sumtab;
  }
  KeepCore.summaryTables = summaryTables;

  /* S, the 36 wide summary of what `seat` has on the board right now.
   *
   *   boardSummary(g, bld, seat, wave)      the pinned signature
   *   boardSummary(g, seat, wave)           the same, for a caller with no builder
   *
   * `bld` is not read by the arithmetic; it is how a caller that already has one names
   * the board without a lookup. `seat` is the seat WHOSE STRUCTURES ARE READ, which from
   * the accommodator's chair is its partner.
   *
   * The scan order is part of the pin: the encoder walks board.tiles in INDEX order
   * (y ascending, then x) and takes the tiles holding one of this seat's structures. It
   * does NOT walk g.struct, because float addition is not associative and the two
   * languages insert into that map in different orders; an encoder that iterated the
   * structure map would drift in the last bits.
   *
   * Live structures only. What a wave destroyed is gone from features 0 to 28 and shows
   * up in feature 34; the placement ledgers (bld.counts) are deliberately not read.
   */
  function boardSummary(g, bld, seat, wave) {
    if (typeof bld === 'number') { wave = seat; seat = bld; bld = null; }
    var board = (bld && bld.b) || KeepCore.board(g.cfg, mapNameOf(g.t) || undefined);
    var tb = summaryTables(board);
    var S = new Float64Array(N_SUMMARY);
    var cfg = g.cfg, w = board.w;
    var wallCost = cfg.wall_cost, gunCost = cfg.turret_cost;
    var tiles = board.tiles, n = board.n, struct = g.struct;
    var i, k, x, y;

    var walls = 0, guns = 0;
    var cred = 0.0, wallCred = 0.0, wallD = 0.0, gunD = 0.0, flowSum = 0.0, nstruct = 0;
    var row = new Float64Array(S_ROWS), col = new Float64Array(S_COLS);
    var westC = 0.0, valleyC = 0.0, frontC = 0.0;
    var isWall = new Uint8Array(n), mine = new Uint8Array(n);
    var gunIdx = [];
    var wset = new Set();

    for (i = 0; i < n; i++) {
      var cell = board.flat[i];
      var s = struct.get(cell);
      if (s === undefined || s.owner !== seat) continue;
      var c = (s.kind === WALL) ? wallCost : gunCost;
      mine[i] = 1;
      nstruct += 1;
      cred += c;
      row[tb.rowband[i]] += c;
      col[tb.colband[i]] += c;
      westC += c * tb.west[i];
      valleyC += c * tb.valley[i];
      frontC += c * tb.front[i];
      flowSum += tb.flow[i];
      if (s.kind === WALL) {
        walls += 1;
        wallCred += c;
        wallD += tb.dist[i];
        isWall[i] = 1;
        wset.add(cell);
      } else {
        guns += 1;
        gunD += tb.dist[i];
        gunIdx.push(i);
      }
    }

    S[0] = clip01(walls / S_WALL_NORM);
    S[1] = clip01(guns / S_GUN_NORM);
    S[2] = (cred > 0.0) ? (wallCred / cred) : 0.0;
    if (cred > 0.0) {
      for (k = 0; k < S_ROWS; k++) S[3 + k] = row[k] / cred;
      for (k = 0; k < S_COLS; k++) S[13 + k] = col[k] / cred;
      S[24] = westC / cred;
      S[25] = valleyC / cred;
      S[26] = frontC / cred;
    }
    S[20] = walls ? (wallD / walls) : 0.0;
    S[21] = guns ? (gunD / guns) : 0.0;

    /* contiguity: the share of this seat's walls with a 4 neighbour tile that this seat
     * also built, wall or gun */
    var touch = 0;
    if (walls) {
      var nb = board.nb;
      for (i = 0; i < n; i++) {
        if (!isWall[i]) continue;
        for (k = 0; k < 4; k++) {
          var j = nb[i * 4 + k];
          if (j >= 0 && mine[j]) { touch += 1; break; }
        }
      }
    }
    S[22] = walls ? (touch / walls) : 0.0;

    /* longest horizontal run of this seat's walls: start at every wall whose left
     * neighbour is not one, and walk right */
    var best = 0;
    for (i = 0; i < n; i++) {
      if (!isWall[i]) continue;
      x = tiles[i][0]; y = tiles[i][1];
      if (x > 0 && wset.has(y * w + (x - 1))) continue;
      var run = 1;
      while (x + run < w && wset.has(y * w + x + run)) run += 1;
      if (run > best) best = run;
    }
    S[23] = clip01(best / S_RUN_NORM);

    S[27] = nstruct ? (flowSum / nstruct) : 0.0;

    var covering = 0;
    for (k = 0; k < gunIdx.length; k++) {
      var cov = board.cov[gunIdx[k]];
      for (i = 0; i < cov.length; i++) {
        if (isWall[cov[i]]) { covering += 1; break; }
      }
    }
    S[28] = guns ? (covering / guns) : 0.0;

    var granted = 0.0;
    var buds = g.ep ? g.ep.budgets : null;
    if (buds && buds.length) {
      var top = Math.min(wave + 1, buds.length);
      for (i = 0; i < top; i++) {
        var bv = buds[i][seat];
        granted += (bv > 0) ? bv : 0;
      }
    }
    S[29] = clip01((granted - g.spent[seat]) / board.bnorm);

    S[30] = (wave === 0) ? 1.0 : 0.0;
    S[31] = (wave === 1) ? 1.0 : 0.0;
    S[32] = (wave === 2) ? 1.0 : 0.0;
    S[33] = seat;
    S[34] = clip01(g.lost[seat] / S_LOST_NORM);
    S[35] = 1.0;
    return S;
  }
  KeepCore.boardSummary = boardSummary;

  /* One call for the reader's bars: the summary, the accommodator's trunk over it, and
   * the discriminator head's raw softmax. The page and the worker both want exactly this
   * and nothing in between, so neither has to know the order of the three steps.
   * Argument order matches boardSummary after the net, and the three argument form
   * (net, g, seat, wave) is accepted the same way. */
  function discriminateBoard(net, g, bld, seat, wave) {
    if (typeof bld === 'number') { wave = seat; seat = bld; bld = null; }
    return discriminate(net, trunk(net, boardSummary(g, bld, seat, wave)));
  }
  KeepCore.discriminateBoard = discriminateBoard;

  /* ------------------------------------------------------------------ exports */

  KeepCore.PURE = {
    pyRound: pyRound,
    bisectRight: bisectRight,
    pySumFloat: pySumFloat,
    tupleLess: tupleLess,
    rowsFromSpans: rowsFromSpans,
    split3: split3,
    flowField: flowField,
    fastFlow: fastFlow,
    multiBfs: multiBfs,
    coverage: coverage,
    cutGeometry: cutGeometry,
    pickGuns: pickGuns,
    alternates: alternates,
    fnvInit: fnvInit,
    fnvInt: fnvInt,
    b64ToBytes: b64ToBytes
  };

  root.KeepCore = KeepCore;
  if (typeof module !== 'undefined' && module.exports) module.exports = KeepCore;

}(typeof self !== 'undefined' ? self : globalThis));
