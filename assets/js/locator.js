/* Located by Light (/locator/): your browser estimates where you are from nothing but
   how long light takes to reach cloud servers and come back.

   One file, plain JS, no libraries. The PURE section (no DOM) is exposed as
   window.LOCATOR_PURE in the browser and as module.exports under node, so the
   test suite in _tests/locator/node/ runs the exact code the page runs. The DOM
   wiring below it only runs when a document exists.

   Nothing is sent to this site. The page times small GET requests to public
   cloud health URLs (AWS DynamoDB /ping and Google Cloud Run /api/ping, listed in
   locator-endpoints.js); no cookies, no storage, no URL state.

   External file (never HTML-compressed), so // comments are fine here. */
(function () {
  'use strict';

  /* ==================================================================================
     PURE: physics, the solver, geometry, the first-hop rules and the simulations
     ================================================================================== */
  var P = {};

  var C_KM_S = 299792.458;            // speed of light in vacuum
  var N_FIBRE = 1.468;                // refractive index of fibre glass
  var V_F_KM_S = C_KM_S / N_FIBRE;    // light in glass: about 204,218 km/s
  var R_EARTH = 6371.0088;            // mean Earth radius (IUGG), km
  var C_KM_MS = C_KM_S / 1000;        // km per ms in vacuum
  var VF_KM_MS = V_F_KM_S / 1000;     // km per ms in glass
  var K_MIN = 1.0, K_MAX = 2.5;       // route factor bounds
  var MIN_ANSWERS = 8;
  var PROVIDER_WEIGHT = { aws: 1.0, gcp: 0.7 };
  var D2R = Math.PI / 180, R2D = 180 / Math.PI;
  // ms of fibre round trip per radian of great circle at k = 1: 2 * R * angle / v_f
  var A_PER_RAD = 2 * R_EARTH / VF_KM_MS;

  P.CONST = {
    C_KM_S: C_KM_S, N_FIBRE: N_FIBRE, V_F_KM_S: V_F_KM_S, R_EARTH: R_EARTH,
    C_KM_MS: C_KM_MS, VF_KM_MS: VF_KM_MS, K_MIN: K_MIN, K_MAX: K_MAX,
    MIN_ANSWERS: MIN_ANSWERS, PROVIDER_WEIGHT: PROVIDER_WEIGHT,
    COARSE_STEP: 1, REFINE_STEP: 0.1, REFINE_N: 20, MIN_RADIUS_KM: 50,
    // Calibrated 2026-10-20 on real round trips (this page's real run from a Mac in
    // California and the cloudping.co matrix between 33 AWS regions); the spec's first
    // values (all regions, power 1, 0.3) left the Mac 1,348 km off in the Pacific and
    // covered the truth in 18 of 33 AWS cases. See _tests/locator/node/bench-solvers.cjs.
    FIT_NEAREST: 16,        // only the 16 fastest regions enter the least squares (0 = all)
    NEAR_POW: 2,            // nearness weight (20 / max(rtt, 20)) ^ NEAR_POW
    REGION_C: 1.0           // likely region: cost <= min + max(1, REGION_C * min)
  };

  /* ---- geometry ---- */

  // Great-circle distance in km by the haversine formula.
  P.haversine = function (lat1, lon1, lat2, lon2) {
    var p1 = lat1 * D2R, p2 = lat2 * D2R;
    var dp = (lat2 - lat1) * D2R, dl = (lon2 - lon1) * D2R;
    var s1 = Math.sin(dp / 2), s2 = Math.sin(dl / 2);
    var h = s1 * s1 + Math.cos(p1) * Math.cos(p2) * s2 * s2;
    if (h > 1) h = 1;
    return 2 * R_EARTH * Math.asin(Math.sqrt(h));
  };

  // Unit vector; the grid uses vectors because one dot product per pair is cheap.
  // Same great circle as the haversine (the node suite checks they agree).
  P.vec = function (lat, lon) {
    var p = lat * D2R, l = lon * D2R, c = Math.cos(p);
    return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)];
  };

  function angleBetween(x1, y1, z1, x2, y2, z2) {
    // atan2 form: accurate at all separations (acos loses digits near 0 and pi)
    var cx = y1 * z2 - z1 * y2, cy = z1 * x2 - x1 * z2, cz = x1 * y2 - y1 * x2;
    return Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), x1 * x2 + y1 * y2 + z1 * z2);
  }

  P.wrapLon = function (lon) {
    var l = ((lon + 180) % 360 + 360) % 360 - 180;
    return l === -180 && lon > 0 ? 180 : l;
  };

  // Point reached from (lat, lon) going distKm along the initial bearing (degrees).
  P.destination = function (lat, lon, bearingDeg, distKm) {
    var d = distKm / R_EARTH, t = bearingDeg * D2R, p1 = lat * D2R, l1 = lon * D2R;
    var sp2 = Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t);
    if (sp2 > 1) sp2 = 1; if (sp2 < -1) sp2 = -1;
    var p2 = Math.asin(sp2);
    var l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * sp2);
    return [p2 * R2D, P.wrapLon(l2 * R2D)];
  };

  // A geodesic circle as polylines of [lat, lon] in the equirectangular plane, split
  // where it crosses the antimeridian so no segment jumps across the map. Returns []
  // when the radius is zero or covers the whole globe.
  P.circlePolylines = function (lat, lon, rKm, nPts) {
    if (!(rKm > 0) || rKm >= Math.PI * R_EARTH * 0.999) return [];
    var n = nPts || 180, pts = [], i;
    for (i = 0; i <= n; i++) pts.push(P.destination(lat, lon, (i % n) * 360 / n, rKm));
    var lines = [], cur = [pts[0]], split = false;
    for (i = 1; i < pts.length; i++) {
      var p = pts[i - 1], q = pts[i], dl = q[1] - p[1];
      if (Math.abs(dl) > 180) {
        split = true;
        var edge = p[1] > 0 ? 180 : -180;
        var qlon = q[1] + (edge > 0 ? 360 : -360);
        var t = (edge - p[1]) / (qlon - p[1]);
        var latX = p[0] + t * (q[0] - p[0]);
        cur.push([latX, edge]);
        lines.push(cur);
        cur = [[latX, -edge], q];
      } else {
        cur.push(q);
      }
    }
    lines.push(cur);
    if (split && lines.length > 1) {
      // the loop's first point sits in the middle of the first piece: join last + first
      var last = lines.pop();
      lines[0] = last.concat(lines[0].slice(1));
    }
    return lines;
  };

  // The great-circle path between two points as polylines (split at the antimeridian).
  P.greatCirclePath = function (lat1, lon1, lat2, lon2, nPts) {
    var n = nPts || 64, a = P.vec(lat1, lon1), b = P.vec(lat2, lon2);
    var om = angleBetween(a[0], a[1], a[2], b[0], b[1], b[2]);
    if (om < 1e-9) return [[[lat1, lon1], [lat2, lon2]]];
    var so = Math.sin(om), pts = [], i;
    for (i = 0; i <= n; i++) {
      var t = i / n, wa = Math.sin((1 - t) * om) / so, wb = Math.sin(t * om) / so;
      var x = wa * a[0] + wb * b[0], y = wa * a[1] + wb * b[1], z = wa * a[2] + wb * b[2];
      pts.push([Math.atan2(z, Math.sqrt(x * x + y * y)) * R2D, Math.atan2(y, x) * R2D]);
    }
    var lines = [], cur = [pts[0]];
    for (i = 1; i < pts.length; i++) {
      var p = pts[i - 1], q = pts[i];
      if (Math.abs(q[1] - p[1]) > 180) {
        var edge = p[1] > 0 ? 180 : -180, ql = q[1] + (edge > 0 ? 360 : -360);
        var tt = (edge - p[1]) / (ql - p[1]), lx = p[0] + tt * (q[0] - p[0]);
        cur.push([lx, edge]); lines.push(cur); cur = [[lx, -edge], q];
      } else cur.push(q);
    }
    lines.push(cur);
    return lines;
  };

  /* ---- measurement summary and weights ---- */

  P.median = function (a) {
    if (!a.length) return NaN;
    var s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  // rtt = the fastest of the samples; jitter = median minus fastest.
  P.summarize = function (samples) {
    var ok = (samples || []).filter(function (v) { return isFinite(v) && v >= 0; });
    if (!ok.length) return null;
    var mn = Math.min.apply(null, ok);
    return { rtt: mn, jitter: P.median(ok) - mn, n: ok.length };
  };

  // Provider weight * jitter penalty * nearness (near endpoints carry the most information).
  P.weight = function (provider, rtt, jitter, nearPow) {
    var pw = PROVIDER_WEIGHT[provider] != null ? PROVIDER_WEIGHT[provider] : 0.7;
    return pw * (1 / (1 + jitter / 5)) * Math.pow(20 / Math.max(rtt, 20), nearPow || P.CONST.NEAR_POW);
  };

  P.hardBoundKm = function (rtt, slackMs) { return C_KM_MS * (rtt + (slackMs || 0)) / 2; };
  P.fibreBoundKm = function (rtt, b) { return VF_KM_MS * Math.max(0, rtt / 2 - (b || 0)); };
  // The model's round trip for a great-circle distance g km.
  P.modelRtt = function (g, k, b) { return 2 * k * g / VF_KM_MS + 2 * b; };

  /* ---- the (k, b) solve ----
     Model: rtt_i = k * a_i + B with a_i = 2 g_i / v_f (ms) and B = 2 b.
     Weighted least squares over the sums; k in [1, 2.5], b >= 0. The objective is a
     convex quadratic, so if the free optimum breaks a bound the constrained optimum
     lies on an edge, and each edge is a one-unknown problem solved and clamped. */
  function costOf(S, k, B) {
    var c = S.rr - 2 * k * S.ar - 2 * B * S.r + k * k * S.aa + 2 * k * B * S.a + B * B * S.w;
    return Math.max(0, c / S.w);
  }

  P.solveSums = function (S) {
    var det = S.aa * S.w - S.a * S.a;
    if (det > 1e-12 * S.aa * S.w) {
      var k0 = (S.ar * S.w - S.a * S.r) / det;
      var B0 = (S.aa * S.r - S.a * S.ar) / det;
      if (k0 >= K_MIN && k0 <= K_MAX && B0 >= 0) return { k: k0, b: B0 / 2, cost: costOf(S, k0, B0), clipped: false };
    }
    var best = null, cands = [], kk;
    // edge k = K_MIN and k = K_MAX: B free, clamped at 0
    cands.push([K_MIN, Math.max(0, (S.r - K_MIN * S.a) / S.w)]);
    cands.push([K_MAX, Math.max(0, (S.r - K_MAX * S.a) / S.w)]);
    // edge B = 0: k free, clamped to the box
    kk = S.aa > 0 ? S.ar / S.aa : K_MIN;
    cands.push([Math.min(K_MAX, Math.max(K_MIN, kk)), 0]);
    for (var i = 0; i < cands.length; i++) {
      var c = costOf(S, cands[i][0], cands[i][1]);
      if (!best || c < best.cost) best = { k: cands[i][0], b: cands[i][1] / 2, cost: c, clipped: true };
    }
    return best;
  };

  P.sums = function (a, r, w) {
    var S = { w: 0, a: 0, aa: 0, r: 0, ar: 0, rr: 0 };
    for (var i = 0; i < a.length; i++) {
      var wi = w ? w[i] : 1;
      S.w += wi; S.a += wi * a[i]; S.aa += wi * a[i] * a[i];
      S.r += wi * r[i]; S.ar += wi * a[i] * r[i]; S.rr += wi * r[i] * r[i];
    }
    return S;
  };

  // a: fibre round trips at k = 1 (ms), r: measured round trips (ms), w: weights.
  P.solveKB = function (a, r, w) { return P.solveSums(P.sums(a, r, w)); };

  // A land mask on a step-degree grid from closed rings of [lat, lon, ...] (Natural Earth),
  // filled row by row (even-odd), then grown by `grow` cells so coastal cities stay in.
  P.landMask = function (rings, step, grow) {
    var st = step || 0.25, nLat = Math.round(180 / st), nLon = Math.round(360 / st);
    var g = new Uint8Array(nLat * nLon), i, j, r;
    for (i = 0; i < nLat; i++) {
      var la = -90 + (i + 0.5) * st, xs = [];
      for (r = 0; r < rings.length; r++) {
        var ring = rings[r], n = ring.length / 2;
        for (var a = 0, b = n - 1; a < n; b = a++) {
          var ya = ring[2 * a], xa = ring[2 * a + 1], yb = ring[2 * b], xb = ring[2 * b + 1];
          if ((ya > la) !== (yb > la)) xs.push(xa + (la - ya) / (yb - ya) * (xb - xa));
        }
      }
      xs.sort(function (u, v) { return u - v; });
      for (var t = 0; t + 1 < xs.length; t += 2) {
        var j0 = Math.max(0, Math.ceil((xs[t] + 180) / st - 0.5)), j1 = Math.min(nLon - 1, Math.floor((xs[t + 1] + 180) / st - 0.5));
        for (j = j0; j <= j1; j++) g[i * nLon + j] = 1;
      }
    }
    for (var k = 0; k < (grow == null ? 1 : grow); k++) {
      var h = g.slice();
      for (i = 0; i < nLat; i++) for (j = 0; j < nLon; j++) {
        if (g[i * nLon + j]) continue;
        for (var di = -1; di <= 1; di++) for (var dj = -1; dj <= 1; dj++) {
          var ii = i + di, jj = (j + dj + nLon) % nLon;
          if (ii >= 0 && ii < nLat && g[ii * nLon + jj]) { h[i * nLon + j] = 1; di = 2; break; }
        }
      }
      g = h;
    }
    return { step: st, nLat: nLat, nLon: nLon, grid: g };
  };
  P.isLand = function (mask, lat, lon) {
    var i = Math.floor((lat + 90) / mask.step), j = Math.floor((P.wrapLon(lon) + 180) / mask.step);
    if (i < 0) i = 0; if (i >= mask.nLat) i = mask.nLat - 1; if (j >= mask.nLon) j = mask.nLon - 1;
    return mask.grid[i * mask.nLon + j] === 1;
  };

  P.regionThreshold = function (costMin, c) { return costMin + Math.max(1.0, (c != null ? c : P.CONST.REGION_C) * costMin); };

  /* ---- the grid fit ---- */

  // Compile the answered endpoints into flat arrays for the grid loops. Every answered
  // endpoint enforces its hard bound; with nearest = K only the K fastest enter the
  // least-squares fit (fit set first, so a candidate is rejected cheaply).
  P.prepare = function (eps, meas, slackMs, nearest, nearPow) {
    var m = { idx: [], x: [], y: [], z: [], r: [], w: [], hardAng: [], inFit: [], nearPow: nearPow };
    var ok = [];
    for (var i = 0; i < eps.length; i++) {
      var q = meas[i];
      if (q && isFinite(q.rtt) && q.rtt > 0) ok.push(i);
    }
    ok.sort(function (u, v) { return meas[u].rtt - meas[v].rtt; });
    var nFit = nearest ? Math.min(ok.length, nearest) : ok.length;
    for (var t = 0; t < ok.length; t++) {
      var j = ok[t], qq = meas[j], v = P.vec(eps[j].lat, eps[j].lon);
      m.idx.push(j); m.x.push(v[0]); m.y.push(v[1]); m.z.push(v[2]);
      m.r.push(qq.rtt);
      m.w.push(P.weight(eps[j].provider, qq.rtt, isFinite(qq.jitter) ? qq.jitter : 0, m.nearPow));
      m.hardAng.push(P.hardBoundKm(qq.rtt, slackMs) / R_EARTH);
      m.inFit.push(t < nFit);
    }
    m.n = m.idx.length;
    m.nFit = nFit;
    return m;
  };

  // Least-squares (k, b) and cost at one candidate point; cost = Infinity if any
  // hard bound (light in vacuum) is broken.
  P.evalAt = function (m, lat, lon) {
    var p = lat * D2R, l = lon * D2R, cp = Math.cos(p);
    var x = cp * Math.cos(l), y = cp * Math.sin(l), z = Math.sin(p);
    var Sw = 0, Sa = 0, Saa = 0, Sr = 0, Sar = 0, Srr = 0;
    for (var i = 0; i < m.n; i++) {
      var ang = angleBetween(x, y, z, m.x[i], m.y[i], m.z[i]);
      if (ang > m.hardAng[i]) return { k: NaN, b: NaN, cost: Infinity };
      if (i >= m.nFit) continue;
      var a = ang * A_PER_RAD, w = m.w[i], r = m.r[i];
      Sw += w; Sa += w * a; Saa += w * a * a; Sr += w * r; Sar += w * a * r; Srr += w * r * r;
    }
    return P.solveSums({ w: Sw, a: Sa, aa: Saa, r: Sr, ar: Sar, rr: Srr });
  };

  // Area-weighted radius around (lat, lon) that covers 90 percent of the cells' area.
  P.radius90 = function (cells, lat, lon) {
    if (!cells.length) return 0;
    var arr = cells.map(function (c) { return [P.haversine(lat, lon, c.lat, c.lon), c.area]; });
    arr.sort(function (u, v) { return u[0] - v[0]; });
    var tot = 0, i;
    for (i = 0; i < arr.length; i++) tot += arr[i][1];
    var acc = 0;
    for (i = 0; i < arr.length; i++) { acc += arr[i][1]; if (acc >= 0.9 * tot) return arr[i][0]; }
    return arr[arr.length - 1][0];
  };

  P.nearestEndpoint = function (eps, lat, lon, filter) {
    var best = null;
    for (var i = 0; i < eps.length; i++) {
      if (filter && !filter(eps[i], i)) continue;
      var d = P.haversine(lat, lon, eps[i].lat, eps[i].lon);
      if (!best || d < best.km) best = { i: i, ep: eps[i], km: d };
    }
    return best;
  };

  // eps: endpoint list; meas: parallel array of {rtt, jitter} or null (no answer).
  // opts: { slackMs } (timer resolution added to every hard bound).
  P.fit = function (eps, meas, opts) {
    opts = opts || {};
    var m = P.prepare(eps, meas, opts.slackMs || 0, opts.nearest != null ? opts.nearest : P.CONST.FIT_NEAREST, opts.nearPow);
    if (m.n < MIN_ANSWERS) return { ok: false, reason: 'few', answered: m.n };
    var NLAT = 180, NLON = 360, costs = new Float64Array(NLAT * NLON), a, o, ev;
    var evals = 0;
    for (a = 0; a < NLAT; a++) {
      for (o = 0; o < NLON; o++) {
        ev = P.evalAt(m, -89.5 + a, -179.5 + o);
        costs[a * NLON + o] = ev.cost; evals++;
      }
    }
    var order = [];
    for (a = 0; a < costs.length; a++) if (isFinite(costs[a])) order.push(a);
    if (!order.length) return { ok: false, reason: 'none', answered: m.n };
    order.sort(function (u, v) { return costs[u] - costs[v]; });
    var top = order.slice(0, P.CONST.REFINE_N);
    var best = null, i, j;
    for (var t = 0; t < top.length; t++) {
      var clat = -89.5 + Math.floor(top[t] / NLON), clon = -179.5 + (top[t] % NLON);
      for (i = -5; i <= 5; i++) {
        var la = clat + i * P.CONST.REFINE_STEP;
        if (la > 90 || la < -90) continue;
        for (j = -5; j <= 5; j++) {
          var lo = clon + j * P.CONST.REFINE_STEP;
          ev = P.evalAt(m, la, lo); evals++;
          if (isFinite(ev.cost) && (!best || ev.cost < best.cost)) best = { lat: la, lon: P.wrapLon(lo), k: ev.k, b: ev.b, cost: ev.cost };
        }
      }
    }
    var thr = P.regionThreshold(best.cost, opts.regionC);

    // Bounding box (longitudes unwrapped around the best point) of the coarse cells
    // inside the threshold, then a finer grid over that box for the drawn region.
    var dLatLo = -1.5, dLatHi = 1.5, dLonLo = -1.5, dLonHi = 1.5;
    for (a = 0; a < order.length && costs[order[a]] <= thr; a++) {
      var cl = -89.5 + Math.floor(order[a] / NLON), co = -179.5 + (order[a] % NLON);
      var dla = cl - best.lat, dlo = P.wrapLon(co - best.lon);
      if (dla - 0.5 < dLatLo) dLatLo = dla - 0.5; if (dla + 0.5 > dLatHi) dLatHi = dla + 0.5;
      if (dlo - 0.5 < dLonLo) dLonLo = dlo - 0.5; if (dlo + 0.5 > dLonHi) dLonHi = dlo + 0.5;
    }
    var latLo = Math.max(-90, best.lat + dLatLo - 1), latHi = Math.min(90, best.lat + dLatHi + 1);
    var lonLo = best.lon + dLonLo - 1, lonHi = best.lon + dLonHi + 1;
    if (lonHi - lonLo >= 358) { lonLo = best.lon - 180; lonHi = best.lon + 180; }
    var steps = [0.1, 0.2, 0.25, 0.5, 1], step = 1;
    for (i = 0; i < steps.length; i++) {
      if (((latHi - latLo) / steps[i]) * ((lonHi - lonLo) / steps[i]) <= 90000) { step = steps[i]; break; }
    }
    var nLat = Math.max(1, Math.ceil((latHi - latLo) / step)), nLon = Math.max(1, Math.ceil((lonHi - lonLo) / step));
    var alpha, cells, bestLand;
    // The likely region keeps only land when a land mask is given (visitors are on land);
    // if no land cell fits at all, the sea is shaded too.
    function scan(useLand) {
      alpha = new Float32Array(nLat * nLon); cells = []; bestLand = null;
      for (var ii = 0; ii < nLat; ii++) {
        var glat = latLo + (ii + 0.5) * step;
        if (glat > 90) continue;
        var area = Math.cos(glat * D2R) * step * step;
        for (var jj = 0; jj < nLon; jj++) {
          var glon = lonLo + (jj + 0.5) * step;
          if (useLand && !P.isLand(opts.land, glat, glon)) continue;
          var e2 = P.evalAt(m, glat, glon); evals++;
          if (e2.cost <= thr) {
            // deeper inside the region = more opaque (0.45 at the edge, 1 at the minimum)
            alpha[ii * nLon + jj] = 1 - 0.55 * Math.min(1, (e2.cost - best.cost) / (thr - best.cost));
            cells.push({ lat: glat, lon: P.wrapLon(glon), area: area });
            if (!bestLand || e2.cost < bestLand.cost) bestLand = { lat: glat, lon: P.wrapLon(glon), k: e2.k, b: e2.b, cost: e2.cost };
          }
        }
      }
    }
    var landUsed = !!opts.land;
    scan(landUsed);
    if (landUsed && !cells.length) { landUsed = false; scan(false); }
    // On land, the best point is the best land point (the sea minimum is kept as bestSea).
    var bestSea = null;
    if (landUsed && !P.isLand(opts.land, best.lat, best.lon) && bestLand) { bestSea = best; best = bestLand; }
    if (!cells.length) cells.push({ lat: best.lat, lon: best.lon, area: step * step });
    var r90 = P.radius90(cells, best.lat, best.lon);

    // residuals at the best point
    var inFit = eps.map(function () { return false; });
    for (i = 0; i < m.n; i++) if (m.inFit[i]) inFit[m.idx[i]] = true;
    var res = [], ss = 0, nn = 0;
    for (i = 0; i < eps.length; i++) {
      var q = meas[i];
      if (!q || !isFinite(q.rtt) || q.rtt <= 0) { res.push(null); continue; }
      var g = P.haversine(best.lat, best.lon, eps[i].lat, eps[i].lon);
      var mod = P.modelRtt(g, best.k, best.b);
      res.push({ g: g, model: mod, residual: q.rtt - mod });
      if (inFit[i]) { ss += (q.rtt - mod) * (q.rtt - mod); nn++; }     // spread of the fitted set
    }
    var near = P.nearestEndpoint(eps, best.lat, best.lon);
    return {
      ok: true, answered: m.n, fitted: m.nFit, inFit: inFit, best: best, threshold: thr,
      region: { latLo: latLo, lonLo: lonLo, step: step, nLat: nLat, nLon: nLon, alpha: alpha, cells: cells.length, land: landUsed },
      bestSea: bestSea, costMin: bestSea ? bestSea.cost : best.cost,
      radiusKm: r90, near: near, residuals: res, rmsResidual: Math.sqrt(ss / Math.max(1, nn)),
      evals: evals, slackMs: opts.slackMs || 0
    };
  };

  // Is (lat, lon) inside the fitted region grid?
  P.inRegion = function (fit, lat, lon) {
    var R = fit.region, dlo = ((lon - R.lonLo) % 360 + 360) % 360;
    var i = Math.floor((lat - R.latLo) / R.step), j = Math.floor(dlo / R.step);
    if (i < 0 || j < 0 || i >= R.nLat || j >= R.nLon) return false;
    return R.alpha[i * R.nLon + j] > 0;
  };

  /* ---- first-hop classification (section 6 of the spec) ---- */

  // Hours between the device's UTC offset and the solar offset lon / 15, on a 24 h clock.
  P.tzDisagreement = function (devOffsetHours, lon) {
    var d = Math.abs(devOffsetHours - lon / 15) % 24;
    return Math.min(d, 24 - d);
  };

  // The jitter the first hop adds is shared by every path, while each path adds its own on
  // top, so the quietest quarter of the regions shows the shared part: the lower quartile.
  P.quantile = function (a, q) {
    if (!a.length) return NaN;
    var s = a.slice().sort(function (x, y) { return x - y; }), pos = (s.length - 1) * q, lo = Math.floor(pos);
    return lo + 1 < s.length ? s[lo] + (pos - lo) * (s[lo + 1] - s[lo]) : s[lo];
  };
  P.firstHopJitter = function (jitters) { return P.quantile(jitters, 0.25); };

  // inp: { b, medJitter (the first-hop jitter: lower quartile), minRtt, devOffsetHours,
  // estLon }. Rules in priority order; every rule that fires is reported, the first one
  // is the verdict.
  P.classify = function (inp) {
    var b = inp.b, j = inp.medJitter, mn = inp.minRtt;
    var fired = [];
    var tz = (isFinite(inp.devOffsetHours) && isFinite(inp.estLon)) ? P.tzDisagreement(inp.devOffsetHours, inp.estLon) : NaN;
    if (mn > 450) fired.push({ kind: 'geo', rule: 'the fastest round trip is above 450 ms' });
    if (tz > 3) fired.push({ kind: 'vpn', rule: 'your device clock is ' + P.fmtFixed(tz, 1) + ' hours away from the time zone the estimate implies (more than 3)' });
    else if (b > 25 && j < 3) fired.push({ kind: 'vpn', rule: 'the shared delay is above 25 ms while the jitter is below 3 ms (a tunnel adds a steady delay, a radio adds a jittery one)' });
    if (b >= 20 && b <= 70 && j >= 5 && j <= 25 && mn > 25) fired.push({ kind: 'leo', rule: 'the shared delay is between 20 and 70 ms, the jitter between 5 and 25 ms, and the fastest round trip above 25 ms' });
    if ((b >= 15 && b <= 90) || (j >= 8 && b >= 10)) fired.push({ kind: 'cell', rule: (b >= 15 && b <= 90) ? 'the shared delay is between 15 and 90 ms' : 'the jitter is 8 ms or more with a shared delay of 10 ms or more' });
    if (b < 15 && j < 4) fired.push({ kind: 'wired', rule: 'the shared delay is under 15 ms and the jitter under 4 ms' });
    var VERDICT = {
      wired: 'This looks like a wired or Wi-Fi connection',
      cell: 'This looks like a cellular connection',
      leo: 'This looks like a satellite link',
      geo: 'This looks like a satellite link',
      vpn: 'Your clock disagrees with the light: a VPN or relay is likely',
      unclear: 'The numbers fit none of the patterns cleanly'
    };
    var first = fired[0] || { kind: 'unclear', rule: 'no rule fired' };
    var verdict = VERDICT[first.kind];
    if (first.kind === 'vpn' && !(tz > 3)) verdict = 'This looks like a VPN or relay: the shared delay is long but steady';
    if (first.kind === 'geo') verdict = 'This looks like a geostationary satellite link';
    if (first.kind === 'leo') verdict = 'This looks like a low-orbit satellite link';
    var alts = fired.slice(1).filter(function (f) { return f.kind !== first.kind; }).map(function (f) { return f.kind; });
    return { kind: first.kind, verdict: verdict, rule: first.rule, fired: fired, alternatives: alts, tzHours: tz };
  };

  /* ---- simulations (section 5): transform every measured sample, then refit ---- */

  // Small seeded generator so a chip gives the same answer every time it is tapped.
  P.rng = function (seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  P.gauss = function (rnd) {
    var u = 0, v = 0;
    while (u === 0) u = rnd();
    v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  var GEO_KM = 35786;
  P.GEO_PROPAGATION_MS = 2 * GEO_KM / C_KM_MS * 2;   // up and down, twice per round trip: about 477 ms

  // The chips. Numbers here are the model; the page prints them on the card.
  P.SIMS = {
    'vpn-frankfurt': { kind: 'vpn', label: 'VPN exit in Frankfurt', exit: { name: 'Frankfurt', lat: 50.11, lon: 8.68 } },
    'vpn-ashburn': { kind: 'vpn', label: 'VPN exit in Ashburn', exit: { name: 'Ashburn, Virginia', lat: 39.04, lon: -77.49 } },
    'vpn-singapore': { kind: 'vpn', label: 'VPN exit in Singapore', exit: { name: 'Singapore', lat: 1.35, lon: 103.82 } },
    'vpn-saopaulo': { kind: 'vpn', label: 'VPN exit in S\u00e3o Paulo', exit: { name: 'S\u00e3o Paulo', lat: -23.55, lon: -46.63 } },
    'vpn-nearest': { kind: 'vpn', label: 'VPN exit nearest to me', exit: null },
    'cell': { kind: 'cell', label: 'Cellular (4G/5G)', mean: 35, sd: 12, floor: 15 },
    'hotspot': { kind: 'cell', label: 'Wi-Fi hotspot on a phone', mean: 35, sd: 12, floor: 15, extra: 5 },
    'leo': { kind: 'leo', label: 'Low-orbit satellite (Starlink)', mean: 30, sd: 10, floor: 5 },
    'geo': { kind: 'geo', label: 'Geostationary satellite', processing: 60, sd: 20, floor: 20 },
    'relay': { kind: 'relay', label: 'Private Relay (two hops)', lo: 5, hi: 15 }
  };
  P.EXIT_FIRST_HOP_MS = 1;   // the exit's own first hop, each way

  function seedOf(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  // samples: per endpoint an array of ms (null for no answer); real: the real fit.
  // Returns { samples, exit } with every sample transformed by the chip's model.
  P.simulate = function (id, eps, samples, real) {
    var sim = P.SIMS[id];
    if (!sim) throw new Error('unknown simulation ' + id);
    var rnd = P.rng(seedOf(id));
    var out = [], exit = null, i, j;
    var k = real.best.k, b = real.best.b;
    if (sim.kind === 'vpn' || sim.kind === 'relay') {
      if (sim.exit) exit = { name: sim.exit.name, lat: sim.exit.lat, lon: sim.exit.lon };
      else {
        var nr = P.nearestEndpoint(eps, real.best.lat, real.best.lon);
        exit = { name: nr.ep.metro, lat: nr.ep.lat, lon: nr.ep.lon };
      }
      var youToExit = P.modelRtt(P.haversine(real.best.lat, real.best.lon, exit.lat, exit.lon), k, b);
      for (i = 0; i < eps.length; i++) {
        var s = samples[i];
        if (!s || !s.length) { out.push(null); continue; }
        var mn = Math.min.apply(null, s);
        var exitToI = P.modelRtt(P.haversine(exit.lat, exit.lon, eps[i].lat, eps[i].lon), k, P.EXIT_FIRST_HOP_MS);
        var row = [];
        for (j = 0; j < s.length; j++) {
          var v = s[j] - mn + youToExit + exitToI;
          if (sim.kind === 'relay') v += sim.lo + (sim.hi - sim.lo) * rnd();
          row.push(v);
        }
        out.push(row);
      }
      return { samples: out, exit: exit, youToExitMs: youToExit };
    }
    for (i = 0; i < eps.length; i++) {
      var t = samples[i];
      if (!t || !t.length) { out.push(null); continue; }
      var r2 = [];
      for (j = 0; j < t.length; j++) {
        var add;
        if (sim.kind === 'cell') add = Math.max(sim.floor, sim.mean + sim.sd * P.gauss(rnd)) + (sim.extra || 0);
        else if (sim.kind === 'leo') add = Math.max(sim.floor, sim.mean + sim.sd * P.gauss(rnd));
        else add = P.GEO_PROPAGATION_MS + Math.max(sim.floor, sim.processing + sim.sd * P.gauss(rnd));
        r2.push(t[j] + add);
      }
      out.push(r2);
    }
    return { samples: out, exit: null };
  };

  /* ---- words for the three largest residuals ---- */

  var CONTINENT = {
    'United States': 'NA', 'Canada': 'NA', 'Mexico': 'NA', 'Brazil': 'SA', 'Chile': 'SA',
    'Ireland': 'EU', 'United Kingdom': 'EU', 'France': 'EU', 'Germany': 'EU', 'Switzerland': 'EU',
    'Italy': 'EU', 'Spain': 'EU', 'Sweden': 'EU', 'Finland': 'EU', 'Poland': 'EU', 'Belgium': 'EU',
    'Netherlands': 'EU', 'Israel': 'ME', 'Bahrain': 'ME', 'United Arab Emirates': 'ME', 'Qatar': 'ME',
    'Saudi Arabia': 'ME', 'South Africa': 'AF', 'India': 'AS', 'Singapore': 'AS', 'Indonesia': 'AS',
    'Malaysia': 'AS', 'Thailand': 'AS', 'Hong Kong': 'AS', 'Taiwan': 'AS', 'Japan': 'AS',
    'South Korea': 'AS', 'Australia': 'OC', 'New Zealand': 'OC'
  };
  P.continentOf = function (country) { return CONTINENT[country] || ''; };

  var DETOUR = {
    SA: 'routes into South America funnel through a few cable landings',
    AF: 'routes to Africa often pass through Europe',
    ME: 'routes to the Middle East often pass through Europe or India',
    AS: 'routes across Asia rarely follow the great circle',
    OC: 'routes to Australia and New Zealand follow a few long undersea cables',
    EU: 'routes into Europe follow the transatlantic cables, not the great circle',
    NA: 'routes into North America follow the cables, not the great circle'
  };

  // A misfit smaller than this many ms, or (for a slower answer) than twice the region's
  // own measured jitter, is called timing noise and given no cause: a cause read into
  // noise would be invented. Queueing only ever adds delay, so jitter cannot explain a
  // region answering faster than the model; only the floor applies to those.
  // (Twice the fit's residual spread was tried and rejected: on real links that spread is
  // route variation, about 8 ms, which would have called real 17 ms detours noise.)
  P.CONST.NOISE_FLOOR_MS = 3;
  // The far regions' line calls them faster or slower only past this share of the
  // model's round trip (a route factor fitted 2 percent low makes +4 ms at 200 ms).
  P.CONST.FAR_REL = 0.05;
  P.providerName = function (p) { return p === 'aws' ? 'AWS' : 'Google'; };

  // The three largest |residual|s among the fitted regions, one line each, then one line
  // on the regions outside the fit (only their hard bounds were used). meas (optional):
  // the per-region {rtt, jitter} the fit used, for the timing-noise test.
  P.explainResiduals = function (eps, fit, nTop, meas) {
    var rows = [], out = [], far = [];
    fit.residuals.forEach(function (r, i) {
      if (!r) return;
      if (!fit.inFit || fit.inFit[i]) rows.push({ i: i, r: r.residual });
      else far.push({ ms: r.residual, rel: r.model > 0 ? r.residual / r.model : 0 });
    });
    rows.sort(function (u, v) { return Math.abs(v.r) - Math.abs(u.r); });
    var home = P.continentOf(fit.near.ep.country);
    rows.slice(0, nTop || 3).forEach(function (row) {
      var e = eps[row.i], ms = P.fmtFixed(Math.abs(row.r), Math.abs(row.r) < 10 ? 1 : 0), why;
      var name = e.metro + ' (' + P.providerName(e.provider) + ')';
      var q = meas && meas[row.i], noise = Math.max(P.CONST.NOISE_FLOOR_MS, row.r > 0 && q && isFinite(q.jitter) ? 2 * q.jitter : 0);
      if (Math.abs(row.r) < noise) {
        out.push({ i: row.i, ms: row.r, noise: true, text: name + ' answered ' + ms + ' ms ' + (row.r > 0 ? 'slower' : 'faster') +
          ' than the model expects, which is within the timing noise of this fit.' });
      } else if (row.r > 0) {
        var cont = P.continentOf(e.country);
        why = (cont && cont !== home) ? DETOUR[cont] : 'its route is longer than the fitted route factor allows';
        if (e.provider === 'gcp') why += ', and Google\'s front end adds backbone time';
        out.push({ i: row.i, ms: row.r, text: name + ' answered ' + ms + ' ms slower than the model expects; ' + why + '.' });
      } else {
        out.push({ i: row.i, ms: row.r, text: name + ' answered ' + ms + ' ms faster than the model expects; its route is straighter than the average route.' });
      }
    });
    if (far.length) {
      var faster = far.filter(function (v) { return v.ms < 0; }).length;
      var med = P.median(far.map(function (v) { return v.ms; })), medRel = P.median(far.map(function (v) { return v.rel; }));
      var medTxt = (med > 0 ? '+' : '') + P.fmtFixed(med, Math.abs(med) < 10 ? 1 : 0) + ' ms, ' + P.fmtInt(Math.abs(medRel) * 100) + ' percent of the expected round trip';
      var lead = 'The ' + P.fmtInt(far.length) + ' farther regions only set hard limits. Against the model fitted near you, ';
      var tail;
      if (medRel <= -P.CONST.FAR_REL) tail = P.fmtInt(faster) + ' of them answered faster than expected (median ' + medTxt + '): long-distance cables run straighter than the tangle of short routes near you.';
      else if (medRel >= P.CONST.FAR_REL) tail = P.fmtInt(far.length - faster) + ' of them answered slower than expected (median ' + medTxt + '): long routes to them detour more than the short ones near you.';
      else tail = 'they answered about as expected (median ' + medTxt + '), so one route factor fits near and far alike here.';
      out.push({ i: -1, ms: med, rel: medRel, text: lead + tail });
    }
    return out;
  };

  /* ---- words for the place (the headline of every result) ---- */

  // A likely region wider than this names no place: the headline says so instead.
  P.CONST.USEFUL_KM = 5000;
  // "near <metro>" only when the metro is within max(NEAR_MIN_KM, min(R, NEAR_CAP_KM)) of
  // the best point: a wide region must not make a metro thousands of km away read as "near".
  P.CONST.NEAR_MIN_KM = 100;
  P.CONST.NEAR_CAP_KM = 300;
  // Numbers in the visitor's locale through Intl ("1,234 km" and "12.5 ms" in en-US,
  // "1.234 km" and "12,5 ms" in de-DE); node (the test harness) uses its own locale.
  /* Digits stay Latin (0-9) in these English sentences whatever the visitor's numbering
     system (ar-SA would print Arabic-Indic digits, bn-BD Bengali ones); the visitor's
     separators stay. Right-to-left languages take en-US outright: their Latin-digit forms
     still carry hidden direction marks, "US$" and an Arabic percent sign. */
  P.NUM_LOC = (function () {
    try {
      var l = new Intl.NumberFormat().resolvedOptions().locale;
      if (/^(ar|fa|ur|he|iw|yi|ps|sd|ug|ckb|dv|ks|syr)(-|$)/i.test(l)) return 'en-US';
      return l.replace(/-u-.*$/i, '') + '-u-nu-latn';
    } catch (e) { return undefined; }
  })();
  P.nf = (function () {
    var cache = {};
    return function (digits, group) {
      var key = digits + (group ? 'g' : '');
      if (!(key in cache)) {
        try { cache[key] = new Intl.NumberFormat(P.NUM_LOC, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: !!group }); }
        catch (e) { cache[key] = null; }
      }
      return cache[key];
    };
  })();
  // Arabic-Indic digits (ar-SA) or a right-to-left mark (he, ar currency) inside an
  // English sentence get reordered by the bidi algorithm ("1200×800" shows as
  // "800×1200"): such a number is wrapped in a left-to-right isolate.
  P.iso = function (t) { return /[\u0600-\u06FF\u200F\u061C]/.test(t) ? '\u2066' + t + '\u2069' : t; };
  // v.toFixed(digits) in the visitor's locale: rounded by toFixed first, because Intl
  // rounds the shortest decimal ("119.35" -> 119.4) where toFixed rounds the binary
  // value (119.349999... -> 119.3); no "-0"
  P.fmtFixed = function (v, digits, group) {
    if (isFinite(v)) v = +v.toFixed(digits);
    if (v === 0) v = 0;
    var f = P.nf(digits, group);
    return P.iso(f ? f.format(v) : v.toFixed(digits));
  };
  P.fmtInt = function (v) {
    var r = Math.round(v); if (r === 0) r = 0;
    var f = P.nf(0, true);
    return P.iso(f ? f.format(r) : r.toLocaleString('en-US'));
  };
  P.roundKm = function (v) {
    if (v < 100) return Math.max(5, Math.round(v / 5) * 5);
    if (v < 1000) return Math.round(v / 10) * 10;
    return Math.round(v / 100) * 100;
  };
  // The radius as quoted: never below MIN_RADIUS_KM (regions are metros, not buildings).
  P.radiusShownKm = function (r) { return P.roundKm(Math.max(P.CONST.MIN_RADIUS_KM, r)); };
  P.latlon = function (lat, lon) {
    return P.fmtFixed(Math.abs(lat), 1) + (lat >= 0 ? ' N' : ' S') + ', ' + P.fmtFixed(Math.abs(lon), 1) + (lon >= 0 ? ' E' : ' W');
  };
  // Initial great-circle bearing from point 1 to point 2, degrees clockwise from north.
  P.bearing = function (lat1, lon1, lat2, lon2) {
    var p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
    var y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(y, x) * R2D + 360) % 360;
  };
  P.compass = function (deg) {
    return ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  };
  // The headline phrase for a fit, lower case (the page capitalises it where it leads).
  //   none: the likely region is wider than USEFUL_KM (or the caller says so: the
  //         geostationary simulation), so no place is named;
  //   near: the best point is within max(100 km, min(R, 300 km)) of its nearest region's
  //         metro (P.nearOk), so a wide region never stretches "near" past 300 km;
  //   off:  otherwise the point itself, with its distance and direction from that metro,
  //         so a far metro is never read as the centre of the quoted radius.
  P.nearOk = function (km, R) { return km <= Math.max(P.CONST.NEAR_MIN_KM, Math.min(R, P.CONST.NEAR_CAP_KM)); };
  P.place = function (fit, noPlace) {
    var R = P.radiusShownKm(fit.radiusKm), near = fit.near;
    if (noPlace || fit.radiusKm > P.CONST.USEFUL_KM) {
      return { kind: 'none', R: R, text: 'no useful place: the likely region reaches about ' + P.fmtInt(R) + ' km from its best point' };
    }
    if (P.nearOk(near.km, R)) {
      return { kind: 'near', R: R, text: 'most likely near ' + near.ep.metro + ', within about ' + P.fmtInt(R) + ' km' };
    }
    var dir = P.compass(P.bearing(near.ep.lat, near.ep.lon, fit.best.lat, fit.best.lon));
    return { kind: 'off', R: R, dir: dir, text: 'most likely within about ' + P.fmtInt(R) + ' km of ' + P.latlon(fit.best.lat, fit.best.lon) +
      ', about ' + P.fmtInt(P.roundKm(near.km)) + ' km ' + dir + ' of ' + near.ep.metro };
  };
  P.cap = function (s) { return s.charAt(0).toUpperCase() + s.slice(1); };

  if (typeof document === 'undefined') {
    // node (test harness): export the pure core and stop; everything below needs a DOM
    if (typeof module !== 'undefined' && module.exports) module.exports = P;
    if (typeof window !== 'undefined') window.LOCATOR_PURE = P;
    return;
  }
  window.LOCATOR_PURE = P;

  /* ==================================================================================
     DOM wiring
     ================================================================================== */
  var $ = function (id) { return document.getElementById(id); };
  var EPS = (window.LOCATOR_ENDPOINTS || []).slice();
  var N = EPS.length;
  var mapEl = $('loc-map');
  if (!mapEl || !N) return;
  var runBtn = $('loc-run'), progEl = $('loc-progress'), liveEl = $('loc-live');

  var mq = function (q) { return window.matchMedia ? window.matchMedia(q) : { matches: false, addEventListener: function () {} }; };
  var reduceMQ = mq('(prefers-reduced-motion: reduce)'), coarseMQ = mq('(pointer: coarse)'), lightMQ = mq('(prefers-color-scheme: light)');
  function reducedMotion() { return !!reduceMQ.matches; }
  function coarse() { return !!coarseMQ.matches; }
  function effectiveTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t === 'light' || t === 'dark') return t;
    return lightMQ.matches ? 'light' : 'dark';
  }
  var PALETTES = {
    dark: { ocean: '#191c21', land: '#2c3036', landEdge: '#454a51', grat: 'rgba(255,255,255,0.06)', text: '#d6d6d6',
      muted: '#9a9a9a', accent: '#82a6cc', accentRGB: [130, 166, 204], sim: '#cf9f55', simRGB: [207, 159, 85], surface: '#141414' },
    light: { ocean: '#f3f5f8', land: '#dce1e7', landEdge: '#bfc6cf', grat: 'rgba(0,0,0,0.06)', text: '#262626',
      muted: '#6b6b6b', accent: '#34568a', accentRGB: [52, 86, 138], sim: '#916315', simRGB: [145, 99, 21], surface: '#ffffff' }
  };
  var pal = PALETTES[effectiveTheme()];
  var landMask = null;
  function fitOpts() {
    if (!landMask && window.OBS_EARTH) landMask = P.landMask(window.OBS_EARTH.landRings(), 0.25, 1);
    return { slackMs: S.slackMs, land: landMask };
  }

  var S = {
    status: fill('idle'), samples: fill(null), meas: fill(null), opaque: fill(false), litAt: fill(0),
    fit: null, sim: null, simId: null, runState: 'none', view: 'world', hover: -1, pinned: -1, geo: null,
    run: null, slackMs: 0.1, coarseTimer: false, sortKey: 'rtt', sortDir: 1, hasRun: false, animFrames: 0
  };
  function fill(v) { var a = new Array(N); for (var i = 0; i < N; i++) a[i] = v; return a; }

  /* ---- formatting ---- */
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var fmtInt = P.fmtInt, roundKm = P.roundKm, latlon = P.latlon;
  function fmt1(v) { var r = Math.round(v * 10) / 10; if (r === 0) r = 0; return P.fmtFixed(r, 1); }
  function fmt2(v) { var r = Math.round(v * 100) / 100; if (r === 0) r = 0; return P.fmtFixed(r, 2); }
  var C_TXT = P.fmtFixed(299.792, 3), VF_TXT = P.fmtFixed(204.218, 3);   // km per ms in vacuum and in glass, as printed
  function signed(v) { var s = fmt1(v); return v > 0.05 ? '+' + s : s; }
  function radiusShown(r) { return fmtInt(P.radiusShownKm(r)); }
  var provName = P.providerName;
  // provider and region id as HTML, kept away from page translators (the table cells already are)
  function codeHtml(e) { return '<span class="notranslate" translate="no">' + provName(e.provider) + ' ' + esc(e.region) + '</span>'; }
  // The geostationary simulation names no place whatever its radius (its lesson is that
  // location by light is hopeless there); every other fit follows P.place's rule.
  function placeOf(fit, simId) { return P.place(fit, !!simId && P.SIMS[simId].kind === 'geo'); }
  // Is the fitted shared delay longer than half the fastest round trip? Then b cannot be
  // a measured first hop (it is a least-squares intercept), and no glass distance is
  // printed for a region whose half round trip it swallows.
  function underB(rtt, b) { return rtt / 2 <= b; }
  function hardText(km) { return km >= Math.PI * P.CONST.R_EARTH ? 'anywhere on Earth' : fmtInt(km) + ' km'; }
  function utc(h) {
    var r = Math.round(h * 10) / 10;
    if (r === 0) return 'UTC';
    return 'UTC' + (r > 0 ? '+' : '-') + P.fmtFixed(Math.abs(r), Math.abs(r) % 1 === 0 ? 0 : 1);
  }
  function live(msg) { if (liveEl) liveEl.textContent = msg; }

  /* ---- the map ---- */
  var ctx = mapEl.getContext('2d');
  var W = 0, H = 0, DPR = 1;
  var base = document.createElement('canvas'), baseKey = '';
  var WORLD = { lon0: -180, lon1: 180, lat0: -90, lat1: 90 };
  var view = WORLD;
  var rings = null;

  function px(lon, lat) {
    return [(lon - view.lon0) / (view.lon1 - view.lon0) * W, (view.lat1 - lat) / (view.lat1 - view.lat0) * H];
  }
  function offsets() {
    var o = [0];
    if (view.lon0 < -180) o.push(-360);
    if (view.lon1 > 180) o.push(360);
    return o;
  }
  function sizeCanvas() {
    var w = Math.round(mapEl.clientWidth || mapEl.parentNode.clientWidth || 600), h = Math.round(w / 2);
    DPR = Math.min(2, window.devicePixelRatio || 1);
    var bw = Math.round(w * DPR), bh = Math.round(h * DPR);
    if (mapEl.width !== bw || mapEl.height !== bh) { mapEl.width = bw; mapEl.height = bh; }
    if (w !== W || h !== H) { W = w; H = h; baseKey = ''; }
  }

  function drawBase() {
    var key = W + 'x' + H + '@' + DPR + ':' + effectiveTheme() + ':' + [view.lon0, view.lon1, view.lat0, view.lat1].join(',');
    if (key === baseKey) return;
    baseKey = key;
    base.width = mapEl.width; base.height = mapEl.height;
    var b = base.getContext('2d');
    b.setTransform(DPR, 0, 0, DPR, 0, 0);
    b.fillStyle = pal.ocean; b.fillRect(0, 0, W, H);
    var span = view.lon1 - view.lon0, g = span > 120 ? 30 : span > 40 ? 10 : 5, v;
    b.strokeStyle = pal.grat; b.lineWidth = 1; b.beginPath();
    for (v = Math.ceil(view.lon0 / g) * g; v <= view.lon1; v += g) { var x = Math.round(px(v, 0)[0]) + 0.5; b.moveTo(x, 0); b.lineTo(x, H); }
    for (v = Math.ceil(view.lat0 / g) * g; v <= view.lat1; v += g) { var y = Math.round(px(0, v)[1]) + 0.5; b.moveTo(0, y); b.lineTo(W, y); }
    b.stroke();
    if (!rings && window.OBS_EARTH) rings = window.OBS_EARTH.landRings();
    if (!rings) return;
    b.fillStyle = pal.land; b.strokeStyle = pal.landEdge; b.lineWidth = 0.6; b.lineJoin = 'round';
    offsets().forEach(function (o) {
      b.beginPath();
      for (var r = 0; r < rings.length; r++) {
        var ring = rings[r];
        for (var j = 0; j < ring.length; j += 2) {
          var p = px(ring[j + 1] + o, ring[j]);
          if (j === 0) b.moveTo(p[0], p[1]); else b.lineTo(p[0], p[1]);
        }
        b.closePath();
      }
      b.fill('evenodd'); b.stroke();
    });
  }

  function regionImage(fit, rgb) {
    var key = rgb.join(',');
    if (fit._img && fit._imgKey === key) return fit._img;
    // The region's cells, padded by PAD cells and box-blurred three times (close to a
    // gaussian), so the shaded area has soft edges at every zoom.
    var R = fit.region, PAD = 3, w = R.nLon + 2 * PAD, h = R.nLat + 2 * PAD, i, j, t;
    var A = new Float32Array(w * h), B = new Float32Array(w * h);
    for (i = 0; i < R.nLat; i++) for (j = 0; j < R.nLon; j++) A[(i + PAD) * w + j + PAD] = R.alpha[i * R.nLon + j];
    for (var pass = 0; pass < 3; pass++) {
      for (i = 0; i < h; i++) for (j = 0; j < w; j++) {
        t = A[i * w + j] + (j > 0 ? A[i * w + j - 1] : 0) + (j < w - 1 ? A[i * w + j + 1] : 0); B[i * w + j] = t / 3;
      }
      for (i = 0; i < h; i++) for (j = 0; j < w; j++) {
        t = B[i * w + j] + (i > 0 ? B[(i - 1) * w + j] : 0) + (i < h - 1 ? B[(i + 1) * w + j] : 0); A[i * w + j] = t / 3;
      }
    }
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d'), img = g.createImageData(w, h), d = img.data;
    for (i = 0; i < h; i++) {
      var row = h - 1 - i;
      for (j = 0; j < w; j++) {
        var p = (row * w + j) * 4;
        d[p] = rgb[0]; d[p + 1] = rgb[1]; d[p + 2] = rgb[2]; d[p + 3] = Math.round(Math.min(1, A[i * w + j]) * 255);
      }
    }
    g.putImageData(img, 0, 0);
    fit._img = c; fit._imgKey = key; fit._pad = PAD;
    return c;
  }
  function drawRegion(fit, rgb, alpha) {
    var R = fit.region, img = regionImage(fit, rgb), pd = fit._pad * R.step;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = true;
    [-360, 0, 360].forEach(function (o) {
      var p0 = px(R.lonLo - pd + o, R.latLo + R.nLat * R.step + pd), p1 = px(R.lonLo + R.nLon * R.step + pd + o, R.latLo - pd);
      if (p1[0] < 0 || p0[0] > W) return;
      ctx.drawImage(img, p0[0], p0[1], p1[0] - p0[0], p1[1] - p0[1]);
    });
    ctx.restore();
  }

  function strokeLines(lines) {
    offsets().forEach(function (o) {
      ctx.beginPath();
      for (var l = 0; l < lines.length; l++) {
        var line = lines[l];
        for (var j = 0; j < line.length; j++) {
          var p = px(line[j][1] + o, line[j][0]);
          if (j === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
        }
      }
      ctx.stroke();
    });
  }
  var circCache = {};
  function circle(lat, lon, r, cache) {
    var key = lat + ',' + lon + ',' + Math.round(r);
    if (cache && circCache[key]) return circCache[key];
    var lines = P.circlePolylines(lat, lon, r, r > 2500 ? 160 : 90);
    if (cache) circCache[key] = lines;
    return lines;
  }

  var GROW_MS = 450;
  function growFactor(i, now) {
    if (reducedMotion() || !S.litAt[i]) return 1;
    var t = (now - S.litAt[i]) / GROW_MS;
    if (t >= 1) return 1;
    return 1 - Math.pow(1 - Math.max(0, t), 3);
  }

  // indices of answered endpoints, nearest (fastest) first
  function answeredOrder(meas) {
    var idx = [];
    for (var i = 0; i < N; i++) if (meas[i]) idx.push(i);
    idx.sort(function (a, b) { return meas[a].rtt - meas[b].rtt; });
    return idx;
  }

  function drawCircles(meas, b, rgbColor, dashed, fade, now) {
    var order = answeredOrder(meas), animating = false;
    for (var n = 0; n < order.length; n++) {
      var i = order[n], e = EPS[i], m = meas[i];
      var gf = now ? growFactor(i, now) : 1;
      if (gf < 1) animating = true;
      var hl = (i === S.hover || i === S.pinned);
      // faint outer circle: light in vacuum (real measurement only)
      if (!dashed) {
        var hard = P.hardBoundKm(m.rtt, S.slackMs) * gf;
        var hl1 = circle(e.lat, e.lon, hard, gf === 1);
        if (hl1.length) {
          ctx.strokeStyle = rgbColor; ctx.globalAlpha = (hl ? 0.7 : (n < 6 ? 0.3 : 0.08)) * fade; ctx.lineWidth = hl ? 1.5 : 1;
          ctx.setLineDash([2, 3]); strokeLines(hl1); ctx.setLineDash([]);
        }
      }
      var fib = P.fibreBoundKm(m.rtt, b) * gf;
      var lines = circle(e.lat, e.lon, fib, gf === 1);
      if (!lines.length) continue;
      ctx.strokeStyle = rgbColor;
      ctx.globalAlpha = (hl ? 1 : (n < 6 ? 0.65 : 0.11)) * fade;
      ctx.lineWidth = hl ? 2 : (n < 6 ? 1.5 : 1);
      if (dashed) ctx.setLineDash([5, 3]);
      strokeLines(lines);
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
    return animating;
  }

  // AWS and Google share a metro in many cities: draw such pairs side by side (screen
  // space only, AWS left and Google right) so neither hides the other.
  var dotShift = EPS.map(function (e, i) {
    for (var j = 0; j < N; j++) if (j !== i && Math.abs(EPS[j].lat - e.lat) < 0.05 && Math.abs(EPS[j].lon - e.lon) < 0.05) return e.provider === 'aws' ? -5 : 5;
    return 0;
  });
  function dotXY(i, o) { var p = px(EPS[i].lon + o, EPS[i].lat); return [p[0] + dotShift[i], p[1]]; }
  function dotPath(i, p) {
    if (EPS[i].provider === 'aws') ctx.arc(p[0], p[1], 4, 0, Math.PI * 2);
    else ctx.rect(p[0] - 3.75, p[1] - 3.75, 7.5, 7.5);
  }
  function drawDots() {
    var os = offsets();
    for (var i = 0; i < N; i++) {
      var st = S.status[i];
      for (var k = 0; k < os.length; k++) {
        var p = dotXY(i, os[k]);
        if (p[0] < -10 || p[0] > W + 10 || p[1] < -10 || p[1] > H + 10) continue;
        ctx.beginPath(); dotPath(i, p);
        if (st === 'ok') {
          ctx.fillStyle = pal.accent; ctx.fill();
          ctx.strokeStyle = pal.surface; ctx.lineWidth = 1; ctx.stroke();
        } else if (st === 'pending') {
          ctx.strokeStyle = pal.accent; ctx.lineWidth = 1.6; ctx.stroke();
        } else {
          ctx.globalAlpha = st === 'none' ? 0.5 : 0.9;
          ctx.strokeStyle = pal.muted; ctx.lineWidth = 1.2; ctx.stroke();
          ctx.globalAlpha = 1;
        }
        if (i === S.hover || i === S.pinned) {
          ctx.beginPath(); ctx.arc(p[0], p[1], 8, 0, Math.PI * 2);
          ctx.strokeStyle = pal.text; ctx.lineWidth = 1.5; ctx.stroke();
        }
      }
    }
  }

  function drawMarker(lat, lon, color, diamond, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    offsets().forEach(function (o) {
      var p = px(lon + o, lat);
      ctx.beginPath();
      if (diamond) { ctx.moveTo(p[0], p[1] - 9); ctx.lineTo(p[0] + 9, p[1]); ctx.lineTo(p[0], p[1] + 9); ctx.lineTo(p[0] - 9, p[1]); ctx.closePath(); }
      else ctx.arc(p[0], p[1], 7, 0, Math.PI * 2);
      ctx.strokeStyle = pal.surface; ctx.lineWidth = 5; ctx.stroke();
      ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.beginPath(); ctx.arc(p[0], p[1], 2.2, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    });
    ctx.restore();
  }
  function drawDevice(lat, lon) {
    offsets().forEach(function (o) {
      var p = px(lon + o, lat);
      ctx.lineCap = 'round';
      [[pal.surface, 5], [pal.text, 2]].forEach(function (s) {
        ctx.strokeStyle = s[0]; ctx.lineWidth = s[1]; ctx.beginPath();
        ctx.moveTo(p[0] - 7, p[1] - 7); ctx.lineTo(p[0] + 7, p[1] + 7); ctx.moveTo(p[0] + 7, p[1] - 7); ctx.lineTo(p[0] - 7, p[1] + 7); ctx.stroke();
      });
      ctx.font = '600 12px "Source Sans 3", system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      var tx = p[0] + 11 + 64 > W ? p[0] - 11 - ctx.measureText('your device').width : p[0] + 11;
      ctx.lineWidth = 3; ctx.strokeStyle = pal.surface; ctx.strokeText('your device', tx, p[1]);
      ctx.fillStyle = pal.text; ctx.fillText('your device', tx, p[1]);
    });
  }

  var drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(draw);
  }
  function draw() {
    drawQueued = false;
    sizeCanvas();
    if (!W) return;
    drawBase();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(base, 0, 0);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    var now = performance.now(), anim = false;
    var fit = S.fit && S.fit.ok ? S.fit : null, sim = S.sim && S.sim.fit && S.sim.fit.ok ? S.sim : null;
    var fade = sim ? 0.35 : 1;
    if (fit) drawRegion(fit, pal.accentRGB, 0.55 * fade);
    anim = drawCircles(S.meas, fit ? fit.best.b : 0, pal.accent, false, fade, now) || anim;
    if (sim) {
      drawRegion(sim.fit, pal.simRGB, 0.6);
      drawCircles(sim.meas, sim.fit.best.b, pal.sim, true, 0.9, 0);
      if (sim.exit && fit) {
        ctx.strokeStyle = pal.sim; ctx.lineWidth = 2; ctx.setLineDash([7, 4]); ctx.globalAlpha = 0.95;
        strokeLines(P.greatCirclePath(fit.best.lat, fit.best.lon, sim.exit.lat, sim.exit.lon, 96));
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      }
    }
    drawDots();
    // a fit that names no place marks no point either (its best point is not an answer)
    if (fit && placeOf(fit).kind !== 'none') drawMarker(fit.best.lat, fit.best.lon, pal.text, false, sim ? 0.6 : 1);
    if (sim && placeOf(sim.fit, sim.id).kind !== 'none') drawMarker(sim.fit.best.lat, sim.fit.best.lon, pal.sim, true, 1);
    if (S.geo) drawDevice(S.geo.lat, S.geo.lon);
    if (anim) { S.animFrames++; requestDraw(); }
  }

  // S.view is what the visitor asked for; the buttons show what the map draws. A fit too
  // wide for a region view (regionView() gives WORLD) draws the world, so World is pressed;
  // the request is kept, and a later, narrower fit (back from a simulation) zooms again.
  function syncView() {
    view = S.view === 'region' ? regionView() : WORLD;
    baseKey = '';
    var zoomed = S.view === 'region' && view !== WORLD;
    $('loc-view-world').setAttribute('aria-pressed', zoomed ? 'false' : 'true');
    $('loc-view-region').setAttribute('aria-pressed', zoomed ? 'true' : 'false');
    return zoomed;
  }
  function setView(which) {
    S.view = which;
    if (!syncView() && which === 'region') live('The likely region spans nearly the whole world, so the map stays on the world view.');
    requestDraw();
  }
  function regionView() {
    var fit = S.fit && S.fit.ok ? S.fit : null;
    if (!fit) return WORLD;
    var act = S.sim && S.sim.fit && S.sim.fit.ok ? S.sim.fit : fit;
    var c = fit.best, la0 = c.lat, la1 = c.lat, d0 = 0, d1 = 0;
    function add(lat, lon) {
      var d = P.wrapLon(lon - c.lon);
      if (lat < la0) la0 = lat; if (lat > la1) la1 = lat; if (d < d0) d0 = d; if (d > d1) d1 = d;
    }
    [fit, act].forEach(function (f) {
      var R = f.region;
      for (var i = 0; i < R.nLat; i++) for (var j = 0; j < R.nLon; j++) {
        if (R.alpha[i * R.nLon + j] > 0) add(R.latLo + (i + 0.5) * R.step, R.lonLo + (j + 0.5) * R.step);
      }
      add(f.best.lat, f.best.lon);
    });
    if (S.sim && S.sim.exit) add(S.sim.exit.lat, S.sim.exit.lon);
    if (S.geo) add(S.geo.lat, S.geo.lon);
    var latSpan = Math.max(la1 - la0, 6) * 1.35 + 3, lonSpan = Math.max(d1 - d0, 12) * 1.35 + 6;
    lonSpan = Math.max(lonSpan, latSpan * 2);
    if (lonSpan >= 330) return WORLD;
    latSpan = lonSpan / 2;
    var latC = (la0 + la1) / 2, lonC = c.lon + (d0 + d1) / 2;
    var lat0 = latC - latSpan / 2, lat1 = latC + latSpan / 2;
    if (lat1 > 90) { lat0 -= lat1 - 90; lat1 = 90; }
    if (lat0 < -90) { lat1 += -90 - lat0; lat0 = -90; }
    return { lon0: lonC - lonSpan / 2, lon1: lonC + lonSpan / 2, lat0: lat0, lat1: lat1 };
  }

  /* ---- hover, tap and the caption ---- */
  function hitTest(x, y) {
    var best = -1, bd = coarse() ? 22 : 12, os = offsets();
    for (var i = 0; i < N; i++) for (var k = 0; k < os.length; k++) {
      var p = dotXY(i, os[k]), d = Math.hypot(p[0] - x, p[1] - y);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  function pointIn(ev) { var r = mapEl.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; }
  mapEl.addEventListener('pointermove', function (ev) {
    if (ev.pointerType && ev.pointerType !== 'mouse') return;
    var p = pointIn(ev), i = hitTest(p[0], p[1]);
    mapEl.style.cursor = i >= 0 ? 'pointer' : 'default';
    if (i !== S.hover) { S.hover = i; updateCaption(); requestDraw(); }
  });
  mapEl.addEventListener('pointerleave', function () {
    if (S.hover !== -1) { S.hover = -1; updateCaption(); requestDraw(); }
  });
  mapEl.addEventListener('click', function (ev) {
    var p = pointIn(ev), i = hitTest(p[0], p[1]);
    S.pinned = (i === S.pinned) ? -1 : i;
    updateCaption(); requestDraw(); renderTable();
  });

  function defaultCaption() {
    var how = coarse() ? 'Tap a dot to read its numbers' : 'Point at a dot, or click it, to read its numbers';
    return 'Each dot is a cloud region. ' + how + '; the Measurements table below lists them all.';
  }
  function describe(i) {
    var e = EPS[i], m = S.meas[i], st = S.status[i];
    var head = e.metro + ', ' + e.country + ' (' + provName(e.provider) + ' ' + e.region + ')';
    if (st === 'idle') return head + ': not measured yet.';
    if (st === 'pending') return head + ': measuring.';
    if (st === 'none') return head + ': no answer.';
    var fit = S.fit && S.fit.ok ? S.fit : null, b = fit ? fit.best.b : 0;
    var s = head + ': fastest round trip ' + fmt1(m.rtt) + ' ms, jitter ' + fmt1(m.jitter) + ' ms. Light in vacuum could reach ' +
      hardText(P.hardBoundKm(m.rtt, S.slackMs));
    if (!fit) s += '; light in glass, before subtracting your first hop, ' + hardText(P.fibreBoundKm(m.rtt, 0)) + '.';
    else if (underB(m.rtt, b)) s += '; its round trip is no longer than your fitted first hop alone (b = ' + fmt1(b) + ' ms each way), so it is very close to the estimate, within the timing noise.';
    else s += '; light in glass covers about ' + hardText(P.fibreBoundKm(m.rtt, b)) + ' after your fitted first hop.';
    if (fit && fit.residuals[i]) s += ' It is ' + fmtInt(fit.residuals[i].g) + ' km from the estimate; residual ' + signed(fit.residuals[i].residual) + ' ms.';
    if (S.opaque[i]) s += ' Timed without CORS.';
    return s;
  }
  function updateCaption() {
    var i = S.hover >= 0 ? S.hover : S.pinned;
    $('loc-caption').textContent = i >= 0 ? describe(i) : defaultCaption();
  }

  /* ---- the measurements table ---- */
  function rowData(i) {
    var e = EPS[i], m = S.meas[i], fit = S.fit && S.fit.ok ? S.fit : null, r = fit ? fit.residuals[i] : null;
    return {
      i: i, metro: e.metro, provider: provName(e.provider), code: e.region, st: S.status[i],
      rtt: m ? m.rtt : null, jitter: m ? m.jitter : null,
      hard: m ? P.hardBoundKm(m.rtt, S.slackMs) : null,
      fibre: m ? P.fibreBoundKm(m.rtt, fit ? fit.best.b : 0) : null,
      underB: !!(m && fit && underB(m.rtt, fit.best.b)),
      dist: r ? r.g : null, resid: r ? r.residual : null,
      role: fit ? (fit.inFit[i] ? 'fitted' : 'bound only') : ''
    };
  }
  var tbody = $('loc-tbody');
  // numbers and region codes are marked translate="no" so a page translator leaves them alone
  function cell(tr, text, num, keep) {
    var td = document.createElement('td');
    if (num) td.className = 'num';
    if ((num && /[0-9\u0660-\u0669]/.test(text)) || keep) td.setAttribute('translate', 'no');   // "no answer" stays translatable
    td.textContent = text; tr.appendChild(td);
  }
  function renderTable() {
    var rows = [];
    for (var i = 0; i < N; i++) rows.push(rowData(i));
    var key = S.sortKey, dir = S.sortDir;
    var numeric = ['rtt', 'jitter', 'hard', 'fibre', 'dist', 'resid'].indexOf(key) >= 0;
    rows.sort(function (a, b) {
      var aa = a.rtt != null, bb = b.rtt != null;
      if (aa !== bb) return aa ? -1 : 1;                       // unanswered at the bottom
      if (numeric) {
        var x = a[key], y = b[key];
        if (x == null && y == null) return a.metro < b.metro ? -1 : 1;
        if (x == null) return 1; if (y == null) return -1;
        return (x - y) * dir || (a.metro < b.metro ? -1 : 1);
      }
      var s = String(a[key]).localeCompare(String(b[key]));
      return s * dir || (a.rtt != null ? a.rtt - b.rtt : 0);
    });
    var frag = document.createDocumentFragment();
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      if (r.st === 'none') tr.className = 'loc-row--none';
      if (r.i === S.pinned || r.i === S.hover) tr.className += ' loc-row--hl';
      tr.setAttribute('data-i', r.i);
      cell(tr, r.metro); cell(tr, r.provider + (S.opaque[r.i] ? ' (no CORS)' : '')); cell(tr, r.code, false, true);
      var rttText = r.rtt != null ? fmt1(r.rtt) : r.st === 'none' ? 'no answer' : r.st === 'pending' ? 'measuring' : '';
      cell(tr, rttText, true);
      cell(tr, r.jitter != null ? fmt1(r.jitter) : '', true);
      cell(tr, r.hard != null ? (r.hard >= Math.PI * P.CONST.R_EARTH ? 'any' : fmtInt(r.hard)) : '', true);
      cell(tr, r.underB ? 'under b' : r.fibre != null ? (r.fibre >= Math.PI * P.CONST.R_EARTH ? 'any' : fmtInt(r.fibre)) : '', true);
      cell(tr, r.dist != null ? fmtInt(r.dist) : '', true);
      cell(tr, r.resid != null ? signed(r.resid) : '', true);
      cell(tr, r.role);
      frag.appendChild(tr);
    });
    tbody.textContent = '';
    tbody.appendChild(frag);
    var answered = S.status.filter(function (s) { return s === 'ok'; }).length;
    $('loc-table-cap').textContent = 'Measurements per cloud region. ' + (S.hasRun ? fmtInt(answered) + ' of ' + fmtInt(N) + ' answered.' : 'Not measured yet.');
    Array.prototype.forEach.call(document.querySelectorAll('#loc-table th'), function (th) {
      th.setAttribute('aria-sort', th.getAttribute('data-key') === S.sortKey ? (S.sortDir > 0 ? 'ascending' : 'descending') : 'none');
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('#loc-table th button'), function (btn) {
    btn.addEventListener('click', function () {
      var k = btn.parentNode.getAttribute('data-key');
      if (S.sortKey === k) S.sortDir = -S.sortDir; else { S.sortKey = k; S.sortDir = 1; }
      renderTable();
    });
  });

  /* ---- result card, math, connection, what if ---- */
  function fastest() {
    var o = answeredOrder(S.meas);
    return o.length ? o[0] : -1;
  }
  function allJitters() {
    var js = [];
    for (var i = 0; i < N; i++) if (S.meas[i]) js.push(S.meas[i].jitter);
    return js;
  }
  function hopJitter() { return P.firstHopJitter(allJitters()); }
  function devOffsetHours() { return -new Date().getTimezoneOffset() / 60; }
  function zoneName() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'an unnamed zone'; } catch (e) { return 'an unnamed zone'; }
  }
  function classification() {
    var fit = S.fit, i0 = fastest();
    return P.classify({ b: fit.best.b, medJitter: hopJitter(), minRtt: S.meas[i0].rtt, devOffsetHours: devOffsetHours(), estLon: fit.best.lon });
  }
  var KIND_WORDS = { wired: 'a wired or Wi-Fi connection', cell: 'a cellular connection', leo: 'a low-orbit satellite link',
    geo: 'a geostationary satellite link', vpn: 'a VPN or relay' };

  function evidenceLine(c) {
    var fit = S.fit, i0 = fastest();
    var s = 'Evidence: shared delay b = ' + fmt1(fit.best.b) + ' ms, jitter ' + fmt1(hopJitter()) + ' ms (the quietest quarter of the regions), fastest round trip ' +
      fmt1(S.meas[i0].rtt) + ' ms, residual spread ' + fmt1(fit.rmsResidual) + ' ms (root mean square over the fitted regions)';
    if (isFinite(c.tzHours)) s += ', device clock ' + fmt1(c.tzHours) + ' h from the estimate\'s solar time';
    return s + '.';
  }

  // The card's line on the shared delay b. When 2b is longer than the fastest round trip,
  // b cannot be a measured first hop, so the line says what it is instead.
  function hopLine(fit) {
    var b = fit.best.b, mn = S.meas[fastest()].rtt;
    if (2 * b <= mn) {
      return 'Your first hop, with the servers\' own time to answer, costs about ' + fmt1(b) + ' ms each way (' + fmt1(2 * b) +
        ' ms per round trip), which was subtracted from every measurement.';
    }
    return 'The fit\'s shared delay b = ' + fmt2(b) + ' ms each way is more than half your fastest round trip (' + fmt2(mn) + ' ms, so ' + fmt2(mn / 2) +
      ' ms each way), so it is not a measured first hop: it is a model term that also absorbs the servers\' time to answer and how much more the short routes near you zigzag. It was subtracted from every measurement in the fit.';
  }
  function realCardHtml() {
    var fit = S.fit, near = fit.near, c = classification(), pl = placeOf(fit);
    var h = esc(P.cap(pl.text));
    var body = '<p>The best point is ' + latlon(fit.best.lat, fit.best.lon) + ', about ' + fmtInt(roundKm(near.km)) + ' km from the cloud region at ' +
      esc(near.ep.metro) + ' (' + codeHtml(near.ep) + '). ' + fmtInt(fit.answered) + ' of ' + fmtInt(N) + ' regions answered.' +
      (pl.kind === 'none' ? ' The likely region is too wide to name a place, so the map marks no point.' : '') + '</p>' +
      '<ul><li>' + esc(hopLine(fit)) + '</li>' +
      '<li>Routes to your ' + fmtInt(fit.fitted) + ' nearest regions ran about ' + fmt2(fit.best.k) + ' times longer than straight lines.</li>' +
      '<li>' + esc(c.verdict) + ', because ' + esc(c.rule) + '. ' + esc(evidenceLine(c)) +
      (c.alternatives.length ? ' Another pattern also fits: ' + c.alternatives.map(function (k) { return KIND_WORDS[k]; }).join(', ') + '.' : '') + '</li></ul>';
    var ex = P.explainResiduals(EPS, fit, 3, S.meas);
    if (ex.length) body += '<p class="loc-small">Largest misfits among the ' + fmtInt(fit.fitted) + ' fitted regions:</p><ul class="loc-small">' + ex.map(function (x) { return '<li>' + esc(x.text).replace(/\((AWS|Google)\)/, '(<span class="notranslate" translate="no">$1</span>)') + '</li>'; }).join('') + '</ul>';
    return { kicker: 'Result', h: h, body: body };
  }

  // mv: how far the simulated best point moved from the real one, km.
  function simText(sim, mv) {
    var def = P.SIMS[sim.id], k = S.fit.best.k, b = S.fit.best.b;
    var model = '', lesson = '', caveat = '';
    if (def.kind === 'vpn' || def.kind === 'relay') {
      var g = P.haversine(S.fit.best.lat, S.fit.best.lon, sim.exit.lat, sim.exit.lon);
      model = 'Every round trip became the trip to the exit plus the exit\'s own trip onward. You to ' + esc(sim.exit.name) + ': 2 &times; ' + fmt2(k) +
        ' &times; ' + fmtInt(g) + ' km / ' + VF_TXT + ' km per ms + 2 &times; ' + fmt1(b) + ' ms = ' + fmt1(sim.youToExitMs) + ' ms. Exit to each region: 2 &times; ' +
        fmt2(k) + ' &times; distance / ' + VF_TXT + ' km per ms + 2 &times; 1 ms for the exit\'s own first hop.';
      if (def.kind === 'relay') {
        model = 'Like a VPN to the egress nearest your estimate (placed here at the ' + esc(sim.exit.name) + ' cloud region, standing in for the egress servers Apple\'s partners run in large cities), plus a second hop of 5 to 15 ms drawn for each sample. ' + model;
        // the lesson states the move instead of promising the answer stays near: far from
        // every cloud region the stand-in egress is far too, and the answer goes there
        lesson = 'Private Relay chooses an egress in your region on purpose, and the fit lands near that egress, as it does on a VPN exit, blurred by the extra hop\'s 5 to 15 ms of varying delay. Here the stand-in egress, the ' +
          esc(sim.exit.name) + ' cloud region, is about ' + fmtInt(roundKm(g)) + ' km from your estimate, and the best point moved about ' + fmtInt(roundKm(mv)) +
          ' km. The extra hop shows up as a larger, slightly jittery first hop.';
      } else {
        lesson = 'A VPN does not blur the answer; it relocates it. The fit lands on the exit, and the only trace of you is a larger first-hop delay.';
      }
      caveat = 'The simulated routes onward from the exit follow the fitted route factor exactly, so the shaded region here is tighter than a real ' +
        (def.kind === 'relay' ? 'relay' : 'VPN') + '\'s would be.';
    } else if (def.kind === 'cell') {
      model = 'Each sample gained a radio delay drawn from a normal distribution with mean 35 ms and standard deviation 12 ms, never below 15 ms' +
        (def.extra ? ', plus 5 ms for the phone\'s own Wi-Fi hop' : '') + '. Typical 4G user-plane round trips are 30 to 50 ms; 5G, 10 to 20 ms.';
      lesson = 'The first hop and the jitter both grow. A cellular link widens the answer more than it moves it.';
    } else if (def.kind === 'leo') {
      model = 'Each sample gained a delay drawn from a normal distribution with mean 30 ms and standard deviation 10 ms (never below 5 ms): up to a satellite, down to a ground station, and one or two hops behind it.';
      lesson = 'This keeps your position and adds only the delay. A real dish would be placed near its ground station and point of presence, often a few hundred km away, because the user terminal talks to a gateway, not to the nearest cable.';
    } else {
      model = 'Each sample gained ' + fmtInt(P.GEO_PROPAGATION_MS) + ' ms of propagation (2 &times; ' + fmtInt(35786) + ' km / c, up and down twice per round trip) plus about 60 ms of processing, which this page assumes varies by 20 ms from packet to packet (never below 20 ms).';
      lesson = 'Location by light is hopeless here by the hard bounds alone: above 500 ms, light in vacuum could have reached any point on Earth, so no circle rules anything out. What is left is the pattern of differences between regions, which the satellite\'s own variation smears out; real links that vary more lose even that.';
      caveat = 'Like the low-orbit model, this keeps your position and adds only the delay. A real geostationary link leaves the satellite network at a ground station (a teleport), which can be thousands of km from the dish, so a real fit would point there, if anywhere.';
    }
    return { model: model, lesson: lesson, caveat: caveat };
  }

  function simCardHtml() {
    var sim = S.sim, def = P.SIMS[sim.id], f = sim.fit;
    var pill = '<span class="loc-pill">Simulated</span>modeled, not measured';
    if (!f.ok) {
      return { kicker: pill, h: 'Simulated: ' + esc(def.label) + '. No place on Earth fits', body: '<p>' + simText(sim).model + '</p>' + backBtn() };
    }
    var mv = P.haversine(S.fit.best.lat, S.fit.best.lon, f.best.lat, f.best.lon), t = simText(sim, mv), pl = placeOf(f, sim.id);
    var h = 'Simulated: ' + esc(def.label) + '. ' + esc(P.cap(pl.text));
    var body = '<p>' + t.model + '</p><ul>' +
      '<li>Shared delay b: ' + fmt1(S.fit.best.b) + ' ms fitted to your measurement, ' + fmt1(f.best.b) + ' ms fitted to the simulation (each way).</li>' +
      '<li>The best point moved ' + fmtInt(mv) + ' km, to ' + latlon(f.best.lat, f.best.lon) + ', about ' + fmtInt(roundKm(f.near.km)) + ' km from the cloud region at ' +
      esc(f.near.ep.metro) + '; the likely region\'s radius went from about ' + radiusShown(S.fit.radiusKm) + ' to about ' + radiusShown(f.radiusKm) + ' km.' +
      (pl.kind === 'none' ? ' That is too wide to name a place, so the map shades the likely land and marks no point.' : '') + '</li>' +
      '<li>Route factor: ' + fmt2(S.fit.best.k) + ' measured, ' + fmt2(f.best.k) + ' simulated.</li></ul>' +
      '<p class="loc-lesson">' + t.lesson + '</p>' + (t.caveat ? '<p class="loc-small">' + t.caveat + '</p>' : '') + backBtn();
    return { kicker: pill, h: h, body: body };
  }
  function backBtn() { return '<p><button type="button" class="loc-btn" data-back="1">Back to my real measurement</button></p>'; }

  function renderResult() {
    var card = $('loc-result');
    if (!S.hasRun) { card.hidden = true; return; }
    card.hidden = false;
    var out;
    if (S.runState === 'hidden') {
      out = { kicker: 'Paused', h: 'Paused because the tab was hidden',
        body: '<p>Browsers slow down timers and network work in a hidden tab, which would spoil the timing, so the run stopped and nothing was fitted. Press Run again to measure again.</p>' };
    } else if (!S.fit || !S.fit.ok) {
      var n = S.fit ? S.fit.answered : 0;
      out = { kicker: 'Result', h: S.fit && S.fit.reason === 'none' ? 'No place on Earth fits these timings' : 'Too few answers to locate',
        body: '<p>' + (S.fit && S.fit.reason === 'none' ? 'Every candidate point broke at least one hard bound, which usually means the clock or the network misbehaved during the run.' :
          'Only ' + fmtInt(n) + ' of ' + fmtInt(N) + ' regions answered, and at least ' + fmtInt(P.CONST.MIN_ANSWERS) + ' are needed. A firewall, an ad or tracker blocker, or a network that blocks cloud hosts may be stopping the requests.') + ' Press Run again to try again.</p>' };
    } else if (S.sim) {
      out = simCardHtml();
    } else {
      out = realCardHtml();
    }
    card.classList.toggle('loc-card--sim', !!S.sim && S.runState === 'done');
    $('loc-result-kicker').innerHTML = out.kicker;
    $('loc-result-h').innerHTML = out.h;
    $('loc-result-body').innerHTML = out.body;
  }

  function setLive(id, html) { var el = $(id); if (el) el.innerHTML = html || ''; }
  function renderMath() {
    var i0 = fastest(), fit = S.fit && S.fit.ok ? S.fit : null;
    if (i0 < 0) { ['lm-hard', 'lm-fibre', 'lm-solve', 'lm-region'].forEach(function (id) { setLive(id, ''); }); $('lm-example').hidden = true; return; }
    var e = EPS[i0], m = S.meas[i0], name = esc(e.metro) + ' (' + codeHtml(e) + ')';
    var hard = P.hardBoundKm(m.rtt, S.slackMs), b = fit ? fit.best.b : 0;
    setLive('lm-hard', 'Your nearest region by time was ' + name + ': fastest round trip ' + fmt1(m.rtt) + ' ms, so it is at most ' + hardText(hard) + ' away' +
      (S.slackMs >= 0.9 ? ' (your browser\'s timer ticks in whole milliseconds, so each light-in-vacuum bound was widened by 1 ms of round trip, about 150 km)' : '') + '.');
    var fibreTxt;
    if (!fit) fibreTxt = 'With b = 0, ' + name + ' is at most ' + hardText(P.fibreBoundKm(m.rtt, 0)) + ' away through glass.';
    else if (underB(m.rtt, b)) {
      var r0 = fit.residuals[i0];
      fibreTxt = 'With your fitted b = ' + fmt2(b) + ' ms: ' + name + ' answered in ' + fmt1(m.rtt) + ' ms at best, so half its round trip, ' + fmt2(m.rtt / 2) +
        ' ms, is no more than b. Its round trip is no longer than your fitted first hop alone, so the model places it very close to you, within the timing noise, and its glass circle shrinks to nothing' +
        (r0 ? ' (residual ' + signed(r0.residual) + ' ms)' : '') + '. This can happen because b is fitted over your ' + fmtInt(fit.fitted) +
        ' nearest regions, not measured: it also absorbs the servers\' time to answer and how much more the short routes near you zigzag.';
    } else {
      fibreTxt = 'With your fitted b = ' + fmt2(b) + ' ms, half of ' + name + '\'s round trip leaves ' + fmt2(m.rtt / 2 - b) + ' ms of travel each way, which light in glass covers in about ' +
        hardText(P.fibreBoundKm(m.rtt, b)) + '. That is an estimate at the fitted b, not a limit.';
    }
    setLive('lm-fibre', fibreTxt);
    if (!fit) { setLive('lm-solve', ''); setLive('lm-region', ''); $('lm-example').hidden = true; return; }
    setLive('lm-solve', 'This run: ' + fmtInt(fit.answered) + ' regions answered, the ' + fmtInt(fit.fitted) + ' fastest entered the fit, and ' + fmtInt(fit.evals) + ' candidate points were tried. The least cost was ' + fmt2(fit.best.cost) +
      ' ms<sup>2</sup> at ' + latlon(fit.best.lat, fit.best.lon) + ', with k = ' + fmt2(fit.best.k) + ' and b = ' + fmt1(fit.best.b) + ' ms.');
    setLive('lm-region', 'Here that means a cost of at most ' + fmt2(fit.costMin) + ' + ' + fmt2(fit.threshold - fit.costMin) + ' = ' + fmt2(fit.threshold) +
      ' ms<sup>2</sup>' + (fit.region.land ? ', on land' : ' (no land fitted, so the sea is shaded too)') + '. ' +
      (fit.bestSea ? 'The lowest cost of all, ' + fmt2(fit.bestSea.cost) + ' ms<sup>2</sup>, was at sea (' + latlon(fit.bestSea.lat, fit.bestSea.lon) + '); the best point shown is the best one on land. ' : '') +
      '90 percent of the shaded area lies within ' + fmtInt(fit.radiusKm) + ' km of the best point, quoted as about ' + radiusShown(fit.radiusKm) + ' km.');
    // the worked example uses the fastest region whose glass distance is still positive
    var order = answeredOrder(S.meas), ie = i0, skipped = 0;
    for (var t = 0; t < order.length; t++) { if (S.meas[order[t]].rtt / 2 > b) { ie = order[t]; break; } skipped++; }
    e = EPS[ie]; m = S.meas[ie]; name = esc(e.metro) + ' (' + codeHtml(e) + ')'; hard = P.hardBoundKm(m.rtt, S.slackMs);
    var r = fit.residuals[ie], half = m.rtt / 2;
    var ex = $('lm-example');
    ex.innerHTML = '<strong>One region worked through.</strong> Light covers ' + C_TXT + ' km per millisecond in vacuum and ' + VF_TXT + ' km per millisecond in glass. ' +
      name + ' answered in ' + fmt1(m.rtt) + ' ms at best, so half the round trip is ' + fmt2(half) + ' ms. Hard bound, allowing half of the timer\'s ' + fmt1(S.slackMs) +
      ' ms tick: ' + C_TXT + ' &times; (' + fmt2(half) + ' + ' + fmt2(S.slackMs / 2) + ') = ' + hardText(hard) + '. Light in glass at the fitted b: ' + VF_TXT + ' &times; (' + fmt2(half) + ' &minus; ' + fmt2(b) + ') = ' + hardText(P.fibreBoundKm(m.rtt, b)) +
      '. The best point is ' + fmtInt(r.g) + ' km from it, so the model expects 2 &times; ' + fmt2(fit.best.k) + ' &times; ' + fmtInt(r.g) + ' / ' + VF_TXT + ' + 2 &times; ' +
      fmt2(b) + ' = ' + fmt1(r.model) + ' ms. It answered in ' + fmt1(m.rtt) + ' ms: a residual of ' + signed(r.residual) + ' ms.' +
      (skipped ? ' (This skips the ' + (skipped === 1 ? 'one faster region, whose' : skipped + ' faster regions, whose') + ' half round trip is no longer than b.)' : '');
    ex.hidden = false;
  }

  function renderConn() {
    var out = $('loc-conn-out'), tz = $('loc-tz'), fig = $('loc-jfig');
    if (!S.fit || !S.fit.ok) { out.innerHTML = ''; tz.textContent = ''; fig.hidden = true; return; }
    var c = classification();
    out.innerHTML = '<p class="loc-p"><strong>' + esc(c.verdict) + '.</strong> The rule that fired: ' + esc(c.rule) + '. ' + esc(evidenceLine(c)) +
      (c.alternatives.length ? ' Another pattern also fits: ' + c.alternatives.map(function (k) { return KIND_WORDS[k]; }).join(', ') + '. The rules cannot tell these apart, so neither is certain.' : '') + '</p>';
    var off = devOffsetHours(), sol = S.fit.best.lon / 15, d = P.tzDisagreement(off, S.fit.best.lon);
    tz.textContent = 'Time zone check: your device says ' + zoneName() + ' (' + utc(off) + '). The estimate\'s longitude, ' +
      P.fmtFixed(Math.abs(S.fit.best.lon), 1) + (S.fit.best.lon >= 0 ? ' E' : ' W') + ', implies a solar time of about ' + utc(sol) + '. They are ' + fmt1(d) +
      ' hours apart' + (d > 3 ? ', more than the 3 hours the rule allows, which points to a VPN or relay.' : ', within the 3 hours the rule allows.');
    fig.hidden = false;
    renderJitter();
  }

  function niceCeil(v) {
    var p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  }
  function renderJitter() {
    var host = $('loc-jitter'), order = answeredOrder(S.meas);
    if (!order.length) { host.innerHTML = ''; return; }
    var Wc = Math.max(280, Math.round(host.clientWidth || 600)), Hc = 176, pl = 44, pr = 10, pt = 28, pb = 26;
    var vals = order.map(function (i) { return S.meas[i].jitter; });
    var srt = vals.slice().sort(function (a, b) { return a - b; });
    var q95 = srt[Math.floor(0.95 * (srt.length - 1))], ymax = niceCeil(Math.max(1, q95 * 1.15));
    var med = P.firstHopJitter(vals), iw = Wc - pl - pr, ih = Hc - pt - pb, bw = iw / order.length, barW = Math.max(1.5, bw - 2);
    var y = function (v) { return pt + ih - Math.min(v, ymax) / ymax * ih; };
    var medLabel = 'lower quartile ' + fmt1(med) + ' ms (used by the rules)', medW = medLabel.length * 6.2;
    var s = '<svg viewBox="0 0 ' + Wc + ' ' + Hc + '" width="' + Wc + '" height="' + Hc + '" role="img" aria-label="Jitter per region, lower quartile ' + fmt1(med) + ' ms; the Measurements table lists every value." style="font: 12px \'Source Sans 3\', system-ui, sans-serif">';
    [0, ymax / 2, ymax].forEach(function (v) {
      s += '<line x1="' + pl + '" x2="' + (Wc - pr) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="' + pal.muted + '" stroke-opacity="0.35" stroke-width="1"/>' +
        '<text x="' + (pl - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end" fill="' + pal.muted + '">' + (v === 0 ? P.fmtFixed(0, 0) : (v < 1 ? P.fmtFixed(v, 2) : P.fmtFixed(+v.toFixed(1), (+v.toFixed(1)) % 1 === 0 ? 0 : 1))) + ' ms</text>';
    });
    order.forEach(function (i, n) {
      var v = S.meas[i].jitter, x = pl + n * bw + (bw - barW) / 2, top = y(v), h = Math.max(1, pt + ih - top);
      s += '<rect x="' + x.toFixed(2) + '" y="' + (pt + ih - h).toFixed(2) + '" width="' + barW.toFixed(2) + '" height="' + h.toFixed(2) + '" rx="' + Math.min(2, barW / 2).toFixed(2) + '" fill="' + pal.accent + '">' +
        '<title>' + esc(EPS[i].metro) + ' (' + provName(EPS[i].provider) + '): fastest ' + fmt1(S.meas[i].rtt) + ' ms, median ' + fmt1(S.meas[i].rtt + v) + ' ms, jitter ' + fmt1(v) + ' ms</title></rect>';
      if (v > ymax) s += '<path d="M' + (x + barW / 2 - 4) + ' ' + (pt - 2) + 'l4 -6 4 6z" fill="' + pal.text + '"><title>' + esc(EPS[i].metro) + ': ' + fmt1(v) + ' ms, above the scale</title></path>';
    });
    s += '<line x1="' + pl + '" x2="' + (Wc - pr) + '" y1="' + y(med) + '" y2="' + y(med) + '" stroke="' + pal.text + '" stroke-dasharray="4 3" stroke-width="1.5"/>' +
      '<line x1="' + (Wc - pr - medW - 30) + '" x2="' + (Wc - pr - medW - 6) + '" y1="' + (pt - 11) + '" y2="' + (pt - 11) + '" stroke="' + pal.text + '" stroke-dasharray="4 3" stroke-width="1.5"/>' +
      '<text x="' + (Wc - pr) + '" y="' + (pt - 7) + '" text-anchor="end" fill="' + pal.text + '">' + medLabel + '</text>' +
      '<text x="' + pl + '" y="' + (Hc - 6) + '" fill="' + pal.muted + '">nearest</text>' +
      '<text x="' + (Wc - pr) + '" y="' + (Hc - 6) + '" text-anchor="end" fill="' + pal.muted + '">farthest</text></svg>';
    host.innerHTML = s;
  }

  var chips = Array.prototype.slice.call(document.querySelectorAll('#loc-sims [data-sim]'));
  function renderSimOut() {
    var out = $('loc-sim-out');
    chips.forEach(function (c) {
      c.disabled = !(S.fit && S.fit.ok);
      c.setAttribute('aria-pressed', S.sim && S.sim.id === c.getAttribute('data-sim') ? 'true' : 'false');
    });
    if (!(S.fit && S.fit.ok)) { out.innerHTML = '<p class="loc-p loc-muted">Run the measurement first; the simulations reuse its samples.</p>'; return; }
    if (!S.sim) { out.innerHTML = '<p class="loc-p loc-muted">Showing your real measurement. Pick a button to see what would change.</p>'; return; }
    var f = S.sim.fit, def = P.SIMS[S.sim.id], s = '<p class="loc-p"><span class="loc-pill">Simulated</span>' + esc(def.label) + ' (modeled, not measured): ';
    if (f.ok) {
      var mv = P.haversine(S.fit.best.lat, S.fit.best.lon, f.best.lat, f.best.lon), t = simText(S.sim, mv), pl = placeOf(f, S.sim.id);
      var b = 'shared delay b ' + fmt1(S.fit.best.b) + ' ms on your measurement, ' + fmt1(f.best.b) + ' ms simulated.';
      // the lesson is said here too, where the visitor pressed the button (the card is far above)
      s += pl.kind === 'none' ? 'no useful place. </p><p class="loc-p loc-lesson">' + t.lesson + '</p><p class="loc-p">' + esc(P.cap(pl.text.replace(/^no useful place: /, ''))) + '; ' + b + '</p>' :
        esc(pl.text) + '; ' + b + '</p><p class="loc-p loc-lesson">' + t.lesson + '</p>';
      if (t.caveat) s += '<p class="loc-p loc-small">' + t.caveat + '</p>';
      s += '<p class="loc-p loc-muted">The result card above has the model\'s numbers.</p>';
    } else s += 'no place on Earth fits.</p>';
    out.innerHTML = s + '<p><button type="button" class="loc-btn" data-showmap="1">Show on the map</button> <button type="button" class="loc-btn" data-back="1">Back to my real measurement</button></p>';
  }
  function runSim(id) {
    if (!(S.fit && S.fit.ok)) return;
    if (S.sim && S.sim.id === id) { backToReal(); return; }
    var r = P.simulate(id, EPS, S.samples, S.fit);
    var meas = r.samples.map(function (s) { return s ? P.summarize(s) : null; });
    S.sim = { id: id, meas: meas, exit: r.exit, youToExitMs: r.youToExitMs, fit: P.fit(EPS, meas, fitOpts()) };
    syncView();
    renderAll();
    live('Simulated ' + P.SIMS[id].label + '. ' + $('loc-result-h').textContent + '.');
  }
  function backToReal() {
    S.sim = null;
    syncView();
    renderAll();
    live('Back to your real measurement.');
  }
  chips.forEach(function (c) { c.addEventListener('click', function () { runSim(c.getAttribute('data-sim')); }); });
  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-back],[data-showmap]') : null;
    if (!t || !document.querySelector('.loc-wrap').contains(t)) return;
    if (t.hasAttribute('data-back')) backToReal();
    else mapEl.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
  });

  /* ---- check the answer ---- */
  var geoBtn = $('loc-geo'), geoOut = $('loc-geo-out');
  function renderGeo() {
    geoBtn.disabled = !(S.fit && S.fit.ok);
    if (!S.geo) return;
    var fit = S.fit && S.fit.ok ? S.fit : null;
    var s = 'Your device puts you at ' + latlon(S.geo.lat, S.geo.lon) + (isFinite(S.geo.acc) && S.geo.acc >= 1 ? ' (to within about ' + fmtInt(S.geo.acc) + ' m)' : '') + '. ';
    if (fit) {
      var err = P.haversine(S.geo.lat, S.geo.lon, fit.best.lat, fit.best.lon);
      s += 'The light estimate\'s best point is ' + fmtInt(err) + ' km away, ' + (P.inRegion(fit, S.geo.lat, S.geo.lon) ? 'inside' : 'outside') +
        ' the shaded region (radius about ' + radiusShown(fit.radiusKm) + ' km). The map marks your device with a cross.';
    }
    geoOut.textContent = s;
  }
  geoBtn.addEventListener('click', function () {
    if (!navigator.geolocation) { geoOut.textContent = 'This browser cannot report a device location, so there is nothing to compare.'; return; }
    geoOut.textContent = 'Asking your browser for the device location...';
    navigator.geolocation.getCurrentPosition(function (pos) {
      S.geo = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy };
      renderGeo();
      syncView();
      requestDraw();
    }, function (err) {
      geoOut.textContent = err && err.code === 1 ? 'Permission was denied, so there is nothing to compare. The estimate above stands on its own.' :
        'Your browser could not work out a position' + (err && err.code === 3 ? ' in time' : '') + ', so there is nothing to compare.';
    }, { enableHighAccuracy: false, timeout: 20000, maximumAge: 300000 });
  });

  /* ---- measuring ---- */
  function timerStep() {
    var a = performance.now(), end = a + 25, best = Infinity, b, guard = 0;
    while ((b = performance.now()) < end && guard++ < 3000000) { var d = b - a; if (d > 0 && d < best) best = d; a = b; }
    return best;
  }
  function timedFetch(url, mode, run) {
    var ac = new AbortController();
    run.ctls.add(ac);
    var timer = setTimeout(function () { ac.abort(); }, 4000);
    var t0 = performance.now();
    return fetch(url, { cache: 'no-store', mode: mode, credentials: 'omit', referrerPolicy: 'no-referrer', signal: ac.signal })
      .then(function (r) {
        var t1 = performance.now();
        if (mode === 'cors' && !r.ok) throw new Error('HTTP ' + r.status);
        return r.text().then(function () { return t1 - t0; });     // read the body so the connection is reused
      })
      .then(function (ms) { clearTimeout(timer); run.ctls.delete(ac); return ms; },
        function (e) { clearTimeout(timer); run.ctls.delete(ac); throw e; });
  }
  function measureOne(i, run) {
    var url = EPS[i].url, samples = [];
    S.status[i] = 'pending'; requestDraw();
    return timedFetch(url, 'cors', run).then(function () { return 'cors'; }, function (e) {
      if (run.aborted) throw e;
      return timedFetch(url, 'no-cors', run).then(function () { return 'no-cors'; });   // opaque: the timing still works
    }).then(function (mode) {
      if (mode === 'no-cors') S.opaque[i] = true;
      var k = 0;
      function next() {
        if (k >= 5 || run.aborted) return samples;
        k++;
        return timedFetch(url, mode, run).then(function (ms) { samples.push(ms); return next(); }, function () { return next(); });
      }
      return next();
    }).then(function () { finishOne(i, samples, run); }, function () { finishOne(i, samples, run); });
  }
  function finishOne(i, samples, run) {
    if (samples.length >= 3) {
      S.samples[i] = samples; S.meas[i] = P.summarize(samples); S.status[i] = 'ok'; S.litAt[i] = performance.now();
      run.answered++;
    } else {
      S.status[i] = 'none';
    }
    run.done++;
    progEl.textContent = 'Measuring: ' + fmtInt(run.answered) + ' of ' + fmtInt(N) + ' regions answered.';
    if (!S.run || S.run === run) { renderTable(); renderMath(); requestDraw(); if (S.hover === i || S.pinned === i) updateCaption(); }
  }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function abortRun(run, why) {
    if (run.aborted) return;
    run.aborted = true; run.reason = why;
    run.ctls.forEach(function (c) { c.abort(); });
  }
  function startRun() {
    if (S.run) return;
    if (!window.fetch || !window.AbortController || !window.performance) {
      progEl.textContent = 'This browser lacks the timing tools this page needs (fetch with AbortController).';
      return;
    }
    for (var i = 0; i < N; i++) { S.status[i] = 'idle'; S.samples[i] = null; S.meas[i] = null; S.opaque[i] = false; S.litAt[i] = 0; }
    S.fit = null; S.sim = null; S.hasRun = false; S.runState = 'running'; S.pinned = -1;
    circCache = {};
    var step = timerStep();
    S.coarseTimer = step >= 0.9;
    S.slackMs = Math.min(1, Math.max(0.1, isFinite(step) ? step : 1));
    setView('world');
    $('loc-view-region').disabled = true;
    var run = S.run = { aborted: false, reason: '', ctls: new Set(), answered: 0, done: 0 };
    runBtn.disabled = true; runBtn.textContent = 'Measuring...';
    progEl.textContent = 'Measuring: 0 of ' + N + ' regions answered.';
    live('Measuring started. This takes about 20 seconds.');
    renderAll();
    var queue = shuffle(EPS.map(function (e, k) { return k; }));
    run.timer = setTimeout(function () { abortRun(run, 'budget'); }, 25000);
    function worker() {
      if (run.aborted || !queue.length) return Promise.resolve();
      return measureOne(queue.shift(), run).then(worker);
    }
    var ws = [];
    for (var w = 0; w < 6; w++) ws.push(worker());
    Promise.all(ws).then(function () { finishRun(run); });
  }
  function finishRun(run) {
    clearTimeout(run.timer);
    S.run = null;
    for (var i = 0; i < N; i++) if (S.status[i] !== 'ok') S.status[i] = 'none';
    S.hasRun = true;
    runBtn.disabled = false; runBtn.textContent = 'Run again';
    if (run.reason === 'hidden') {
      S.runState = 'hidden'; S.fit = null;
      progEl.textContent = 'Paused because the tab was hidden.';
      renderAll();
      live('Paused because the tab was hidden.');
      return;
    }
    progEl.textContent = fmtInt(run.answered) + ' of ' + fmtInt(N) + ' regions answered' + (run.reason === 'budget' ? ' within the 25 second limit' : '') + '. Fitting...';
    setTimeout(function () {
      S.fit = P.fit(EPS, S.meas, fitOpts());
      S.runState = 'done';
      progEl.textContent = fmtInt(run.answered) + ' of ' + fmtInt(N) + ' regions answered' + (run.reason === 'budget' ? ' within the 25 second limit' : '') + '.';
      $('loc-view-region').disabled = !(S.fit && S.fit.ok);
      renderAll();
      live(progEl.textContent + ' ' + $('loc-result-h').textContent + '.');
      revealResult();
    }, 40);
  }
  // Focus the result heading and make sure it can be read: on a phone the card goes to the
  // top of the screen (the theme toggle and the chat bar cover the bottom); elsewhere the
  // page scrolls only when the heading is hidden or covered.
  function revealResult() {
    var h = $('loc-result-h'), card = $('loc-result');
    try { h.focus({ preventScroll: true }); } catch (e) { h.focus(); }
    var r = h.getBoundingClientRect(), vh = window.innerHeight, clearBottom = vh;
    ['chat-widget', 'theme-toggle'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      var q = el.getBoundingClientRect();
      if (q.width > 0 && q.height > 0 && q.top > vh * 0.4 && q.left < r.right && q.right > r.left) clearBottom = Math.min(clearBottom, q.top);
    });
    if (window.innerWidth <= 768) { card.scrollIntoView({ block: 'start', behavior: 'auto' }); return; }
    if (r.top >= 8 && r.bottom <= clearBottom - 8) return;
    window.scrollBy(0, Math.round(r.top - Math.min(vh * 0.3, clearBottom - r.height - 120)));
  }
  document.addEventListener('visibilitychange', function () { if (document.hidden && S.run) abortRun(S.run, 'hidden'); });
  window.addEventListener('pagehide', function () { if (S.run) abortRun(S.run, 'hidden'); });

  function renderAll() {
    renderResult(); renderTable(); renderMath(); renderConn(); renderSimOut(); renderGeo(); updateCaption();
    var fit = S.fit && S.fit.ok ? S.fit : null;
    mapEl.setAttribute('aria-label', fit ? 'World map of the cloud regions timed. ' + $('loc-result-h').textContent + '. ' + fmtInt(fit.answered) + ' of ' + fmtInt(N) +
      ' regions answered. The Measurements table below lists every region.' : 'World map of the ' + N + ' cloud regions this page can time. No result yet.');
    requestDraw();
  }

  /* ---- start-up ---- */
  runBtn.addEventListener('click', startRun);
  $('loc-view-world').addEventListener('click', function () { setView('world'); });
  $('loc-view-region').addEventListener('click', function () { if (S.fit && S.fit.ok) setView('region'); });
  var nEl = $('loc-n-eps'); if (nEl) nEl.textContent = String(N);
  function hint() { var h = $('loc-sort-hint'); if (h) h.textContent = (coarse() ? 'Tap' : 'Click') + ' a column heading to sort.'; updateCaption(); }
  function onTheme() { pal = PALETTES[effectiveTheme()]; baseKey = ''; requestDraw(); if (S.fit && S.fit.ok) renderJitter(); }
  new MutationObserver(onTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (lightMQ.addEventListener) lightMQ.addEventListener('change', onTheme);
  if (coarseMQ.addEventListener) coarseMQ.addEventListener('change', hint);
  var resizeT = 0;
  function onResize() { clearTimeout(resizeT); resizeT = setTimeout(function () { requestDraw(); if (S.fit && S.fit.ok) renderJitter(); }, 60); }
  if (window.ResizeObserver) new ResizeObserver(onResize).observe(mapEl); else window.addEventListener('resize', onResize);
  hint();
  renderAll();
  runBtn.disabled = false; runBtn.textContent = 'Find me by light';
  S.project = function (lat, lon) { return px(lon, lat); };   // CSS-pixel projection of the current view
  S.dotPos = function (i) { return dotXY(i, 0); };             // where endpoint i's dot is drawn
  window.__LOCATOR_STATE = S;   // read-only hook for the test suites
}());
