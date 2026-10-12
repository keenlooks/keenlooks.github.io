/*
 * The Observatory - feed modules (Act 1).
 *
 * One manifest plus one pure parser per live source, per the kernel contract in
 * obs-core.js. Nothing here touches the DOM or the renderer, and no parser calls
 * Date.now or fetch: time arrives as ctx.now and bytes arrive as raw. The fetchers
 * (the only impure parts) are the small functions that do the network for the odd
 * cases: two URLs in one module, an image, a query built at call time.
 *
 * Everything is exported on window.ObsFeeds (globalThis in node) so the parsers can
 * be tested headless without the kernel. Registration happens only when ObsCore is
 * already loaded, which the script order in observatory.md guarantees.
 *
 * Sources and licences (full credit block lives on the page):
 *   NOAA SWPC (US public domain): GOES X-ray flux, D-RAP, planetary K index,
 *     propagated solar wind, OVATION aurora.
 *   NOAA NESDIS STAR (US public domain): GOES ABI GEOCOLOR full-disc imagery.
 *   USGS (US public domain) and EMSC seismicportal: earthquakes.
 *   WSPR.live and the WSPRnet volunteer network: shortwave beacon reception.
 *   Wikimedia Foundation: EventStreams and the REST pageviews API.
 *   Open-Meteo (CC BY 4.0): pressure level wind forecast. Weather data by Open-Meteo.com
 *   adsb.lol (ODbL 1.0) and adsb.fi volunteer feeders, through the antenna Worker.
 *
 * Endpoint facts measured from this machine on 2026-08-16 and pinned in the code below:
 *   xrays-1-hour.json is HTTP 404 today. xrays-6-hour.json is 163 KB raw, 26 KB gzipped.
 *     xrays-1-day.json is 656 KB. The boot probe therefore STARTS at the 6-hour file:
 *     probing a variant SWPC no longer serves put a network error in every visitor's
 *     console at boot. The 1-hour rung is kept as an upgrade probe (probeXrayUpgrade)
 *     that nothing calls at boot, so restoring it later is one call, not a rewrite.
 *   The grouped WSPR query returns 7,607 rows, 237 KB raw, 55 KB on the wire (gzip is
 *     served), well inside the 1.5 MB ceiling.
 *   Both cloud discs exist at 678x678 (GOES19 337 KB, GOES18 317 KB) with CORS *.
 *   OVATION is 924 KB raw, 150 KB gzipped, 65,160 grid points.
 *   The pageviews API has no hourly granularity for per-article: it answers 400 with
 *     "granularity should be equal to one of the allowed values: [daily, monthly]".
 *
 * Re-verified live on 2026-08-25 for the three feeds the tour reads (r10 item 4), each
 * probed with an Origin header:
 *   NASA EONET v3 answers ACAO * and X-RateLimit-Limit 60 an hour. The four-category
 *     7 day query is 35,906 bytes and is NOT gzipped; the same query without `days`
 *     is 4.9 MB, so the window is not optional. 600 s spends 6 of the 60.
 *   Launch Library 2 answers ACAO * and gzips: upcoming limit 12 plus previous limit 6
 *     in mode=normal are 16,541 and 9,435 bytes on the wire. mode=list is smaller but
 *     carries no pad coordinates at all. Anonymous clients get 15 requests an hour and
 *     each refresh spends 2, hence the localStorage cache.
 *   SWPC alerts.json answers ACAO * with 46,600 bytes raw, 5,017 gzipped, 77 bulletins.
 *   Added together at their cadences these three cost about 0.35 MB an hour.
 *
 * Sources added in that round: NASA EONET (US public domain), Launch Library 2 by The
 * Space Devs (free to use, attribution required), NOAA SWPC alerts (US public domain).
 */
(function (global) {
  'use strict';

  var VER = 1;

  /* Wikimedia asks browser clients to identify themselves with this header. A CORS
     preflight for it answered 405 on 2026-08-16, which would block the request
     entirely, so wmFetch tries with the header and falls back to a plain request. */
  var WM_UA = 'keanelucas.com-observatory (keenlooks@gmail.com)';

  /* ================================================================== helpers */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /* An array or a typed array, never a string: a truthy .length on a string is how a
     malformed body sneaks past a shape check. */
  function isArr(v) { return !!v && typeof v === 'object' && typeof v.length === 'number'; }

  function num(v, dflt) {
    if (typeof v === 'number') return isFinite(v) ? v : dflt;
    if (typeof v === 'string' && v !== '') {
      var n = parseFloat(v);
      if (isFinite(n)) return n;
    }
    return dflt;
  }

  /*
   * Arithmetic, never a loop. A `while (x > 180) x -= 360` cannot terminate once the value
   * is large enough that subtracting 360 changes nothing (9e99 - 360 === 9e99), and every
   * caller here is fed by a third party, so one malformed row would freeze the page inside
   * the parser with no error to catch. Values already inside the range are returned
   * untouched so an honest longitude keeps its exact bits (and 180 stays 180); anything
   * outside is folded arithmetically in constant time.
   */
  function wrapLon(v) {
    if (!isNum(v)) return v;
    if (v >= -180 && v <= 180) return v;
    return posMod(v + 180, 360) - 180;
  }

  function posMod(a, n) { return ((a % n) + n) % n; }

  /* SWPC writes "2026-08-16T05:57:00Z", "2026-08-16 05:54 UTC" and "2026-08-16T04:57:00"
     in different products, and a bare timestamp with no zone means UTC in all of them. */
  function parseIsoMs(s) {
    if (typeof s !== 'string' || !s) return NaN;
    var t = s.trim().replace(' UTC', 'Z').replace(' ', 'T');
    if (!/(Z|[+-]\d{2}:?\d{2})$/.test(t)) t += 'Z';
    var ms = Date.parse(t);
    return isFinite(ms) ? ms : NaN;
  }

  function median(list) {
    if (!list || !list.length) return NaN;
    var a = list.slice().sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return (a.length % 2) ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function jsonOf(raw, what) {
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw !== 'string' || !raw) throw new Error(what + ': empty response');
    return JSON.parse(raw);
  }

  /* The flare ladder, same thresholds as ObsCore.PURE.flareClass. The duplicate exists
     so this file loads with no kernel at all; t-feeds asserts the two agree. */
  var FLARE_BASES = [1e-8, 1e-7, 1e-6, 1e-5, 1e-4];
  var FLARE_LETTERS = ['A', 'B', 'C', 'M', 'X'];

  function flareClass(flux) {
    if (!isFinite(flux) || flux <= 0) return null;
    var i = 4;
    while (i > 0 && flux < FLARE_BASES[i]) i--;
    var scaled = flux / FLARE_BASES[i];
    if (i === 4 && scaled >= 10) scaled = Math.min(scaled, 999);
    return { letter: FLARE_LETTERS[i], scaled: scaled, text: FLARE_LETTERS[i] + (Math.round(scaled * 10) / 10).toFixed(1) };
  }

  /* Below C1 the sun is quiet as far as this page is concerned (spec 6.1). */
  function flareState(flux) {
    if (!isFinite(flux) || flux < 1e-6) return 'quiet';
    if (flux >= 1e-4) return 'X';
    if (flux >= 1e-5) return 'M';
    return 'C';
  }

  /* The kernel injects its own fetch for tests; the fetchers below are the only
     network code in this file, so they go through this one seam. */
  var injectedFetch = null;

  function setFetch(fn) { injectedFetch = (typeof fn === 'function') ? fn : null; return injectedFetch; }

  /*
   * Every request this file makes carries a deadline (r12 item 15). The kernel's
   * own watchdog would eventually rescue a hung feed, but only this seam can close
   * the socket, and a fetcher that makes several requests (the X-ray ladder, the
   * cloud discs) needs each one bounded rather than the batch. `opts.timeoutMs`
   * overrides for the slow origins; the value is not passed on to fetch itself.
   */
  var FETCH_TIMEOUT_MS = 30000;
  var FETCH_TIMEOUT_SLOW_MS = 90000;

  function httpFetch(url, opts) {
    var f = injectedFetch || global.fetch;
    if (typeof f !== 'function') return Promise.reject(new Error('no fetch available'));
    var ms = num(opts && opts.timeoutMs, FETCH_TIMEOUT_MS);
    var AC = global.AbortController;
    var pass = opts, ac = null, killer = null;
    if (opts && typeof opts.timeoutMs !== 'undefined') {
      pass = {};
      for (var k in opts) if (k !== 'timeoutMs') pass[k] = opts[k];
    }
    /* No AbortController in this environment means no abort, not no fetch: the
       kernel watchdog still bounds the poll. */
    if (typeof AC === 'function' && !(pass && pass.signal)) {
      try { ac = new AC(); } catch (e) { ac = null; }
    }
    if (ac) {
      pass = pass ? shallowCopy(pass) : {};
      pass.signal = ac.signal;
      killer = global.setTimeout(function () {
        try { ac.abort(); } catch (e) { /* already settled */ }
      }, ms);
    }
    function done(v) { if (killer !== null) { global.clearTimeout(killer); killer = null; } return v; }
    return Promise.resolve(f(url, pass)).then(done, function (e) { done(); throw e; });
  }

  function shallowCopy(o) {
    var out = {};
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
    return out;
  }

  /*
   * r19 item 8. A server that answered 429 has told us WHY it said no and,
   * often, for how long. That is a different fact from a request that failed,
   * and the page words it differently, so the cause travels on the error
   * rather than being guessed from a message string. `retryAtMs` is filled in
   * from Retry-After when the server sent one; without it the kernel uses the
   * feed's own cadence, which is the next time this page would ask anyway.
   */
  function rateLimitErr(res, url) {
    var err = new Error('http 429 for ' + url);
    err.rateLimited = true;
    var ra = null;
    try { ra = res.headers && res.headers.get ? res.headers.get('Retry-After') : null; }
    catch (e) { ra = null; }
    var secs = ra !== null && ra !== '' ? Number(ra) : NaN;
    if (isNum(secs) && secs >= 0 && secs < 86400) err.retryAtMs = clockNow() + secs * 1000;
    return err;
  }

  function okOrThrow(res, url) {
    if (res && res.status === 429) throw rateLimitErr(res, url);
    if (!res || !res.ok) throw new Error('http ' + (res ? res.status : '?') + ' for ' + url);
    return res;
  }

  function fetchText(url, opts) {
    return httpFetch(url, opts).then(function (res) {
      okOrThrow(res, url);
      return res.text();
    });
  }

  /* ================================================================== 1. GOES X-ray */

  var XRAY_BASE = 'https://services.swpc.noaa.gov/json/goes/primary/';
  /* Smallest first. Cadence for the last entry is slower because it is 656 KB.
     Index 0 (the 1-hour file) is NOT part of the boot probe: it answers 404 today,
     and a boot probe for it logged a network error on every page load. */
  var XRAY_LADDER = [
    { url: XRAY_BASE + 'xrays-1-hour.json', cadenceMs: 120000, hours: 1 },
    { url: XRAY_BASE + 'xrays-6-hour.json', cadenceMs: 120000, hours: 6 },
    { url: XRAY_BASE + 'xrays-1-day.json', cadenceMs: 300000, hours: 24 }
  ];
  /* The rungs the boot probe walks, in order. The 6-hour file is the one measured
     live, so it is first and normally answers on the first try. */
  var XRAY_BOOT_RUNGS = [1, 2];
  var XRAY_UPGRADE_RUNG = 0;
  var XRAY_BAND = '0.1-0.8nm';

  var xrayPick = null;       /* the ladder entry the boot probe settled on */
  var xrayProbe = null;      /* in-flight probe promise */

  /* HEAD is a simple CORS method, so this needs no preflight. A rung that answers
     anything but 200 is skipped; if every probe fails we keep the 6-hour rung,
     which is the one verified to exist. */
  function probeXray(headFn, rungs) {
    if (xrayPick) return Promise.resolve(xrayPick);
    if (xrayProbe) return xrayProbe;
    var order = rungs || XRAY_BOOT_RUNGS;
    var head = headFn || function (url) {
      return httpFetch(url, { method: 'HEAD' }).then(function (res) { return !!(res && res.ok); },
        function () { return false; });
    };
    var i = 0;
    function step() {
      if (i >= order.length) { xrayPick = XRAY_LADDER[1]; return xrayPick; }
      var entry = XRAY_LADDER[order[i++]];
      return Promise.resolve(head(entry.url)).then(function (ok) {
        if (ok) { xrayPick = entry; return entry; }
        return step();
      }, function () { return step(); });
    }
    xrayProbe = Promise.resolve(step()).then(function (e) { xrayProbe = null; return e; });
    return xrayProbe;
  }

  /*
   * The optional upgrade probe: if SWPC ever restores the small 1-hour file, one call
   * to this switches every later poll onto it. Nothing calls it at boot on purpose,
   * because a 404 there costs every visitor a console error for a 26 KB saving.
   */
  function probeXrayUpgrade(headFn) {
    var head = headFn || function (url) {
      return httpFetch(url, { method: 'HEAD' }).then(function (res) { return !!(res && res.ok); },
        function () { return false; });
    };
    var entry = XRAY_LADDER[XRAY_UPGRADE_RUNG];
    return Promise.resolve(head(entry.url)).then(function (ok) {
      if (ok) xrayPick = entry;
      return xrayPick || XRAY_LADDER[1];
    }, function () { return xrayPick || XRAY_LADDER[1]; });
  }

  function fetchXray() {
    return probeXray().then(function (entry) {
      return fetchText(entry.url).then(function (text) {
        var out = jsonOf(text, 'goes_xray');
        if (out && typeof out === 'object') {
          try { Object.defineProperty(out, 'byteLength', { value: text.length, enumerable: false }); }
          catch (e) { /* frozen or exotic, byte accounting is not worth a failure */ }
        }
        return out;
      });
    });
  }

  /*
   * Keeps only the 0.1-0.8 nm band (the entries interleave two energies) and reduces to
   * the current flux, its class, and the series for the sparkline tile.
   */
  function parseXray(raw, ctx) {
    var arr = jsonOf(raw, 'goes_xray');
    if (!isArr(arr)) throw new Error('goes_xray: expected an array');
    var ts = [], fx = [], sats = {}, contaminated = 0, kept = 0;
    for (var i = 0; i < arr.length; i++) {
      var e = arr[i];
      if (!e || e.energy !== XRAY_BAND) continue;
      var t = parseIsoMs(e.time_tag);
      var f = num(e.flux, NaN);
      if (!isFinite(t) || !isFinite(f) || f <= 0) continue;
      ts.push(t); fx.push(f); kept++;
      if (e.electron_contaminaton === true || e.electron_contamination === true) contaminated++;
      if (isNum(e.satellite)) sats[e.satellite] = (sats[e.satellite] || 0) + 1;
    }
    if (!kept) throw new Error('goes_xray: no ' + XRAY_BAND + ' samples');

    var idx = [];
    for (i = 0; i < ts.length; i++) idx.push(i);
    idx.sort(function (a, b) { return ts[a] - ts[b]; });

    var series = new Float64Array(kept * 2);
    var peakF = -Infinity, peakT = 0;
    for (i = 0; i < idx.length; i++) {
      var k = idx[i];
      series[i * 2] = ts[k];
      series[i * 2 + 1] = fx[k];
      if (fx[k] > peakF) { peakF = fx[k]; peakT = ts[k]; }
    }
    var lastT = series[(kept - 1) * 2];
    var lastF = series[(kept - 1) * 2 + 1];
    var sat = null, best = -1;
    for (var s in sats) { if (sats[s] > best) { best = sats[s]; sat = num(s, null); } }

    return {
      t: lastT,
      flux: lastF,
      cls: flareClass(lastF),
      state: flareState(lastF),
      label: flareClass(lastF) ? flareClass(lastF).text : null,
      peak: { t: peakT, flux: peakF, cls: flareClass(peakF) },
      series: series,
      n: kept,
      band: XRAY_BAND,
      satellite: sat,
      contaminated: contaminated,
      spanMs: lastT - series[0],
      source: xrayPick ? xrayPick.url : XRAY_LADDER[1].url,
      fetchedAt: ctx && isNum(ctx.now) ? ctx.now : lastT
    };
  }

  /* ================================================================== 2. D-RAP */

  var DRAP_URL = 'https://services.swpc.noaa.gov/text/drap_global_frequencies.txt';

  /*
   * The product is a fixed table: a longitude header row, then one row per latitude
   * "  89 |  1.7  1.7 ...". Verified 2026-08-16: 90 rows (lat 89 down to -89 step 2)
   * by 90 columns (lon -178 to 178 step 4), values in MHz, header carries the valid time.
   */
  function parseDrap(raw, ctx) {
    if (typeof raw !== 'string' || raw.length < 200) throw new Error('drap: empty response');
    var lines = raw.split(/\r?\n/);
    var validAt = NaN, validText = '', lons = null, lats = [], rows = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      if (line.charAt(0) === '#') {
        var m = /Product Valid At\s*:\s*(.+?)\s*$/.exec(line);
        if (m) { validText = m[1]; validAt = parseIsoMs(m[1]); }
        continue;
      }
      var bar = line.indexOf('|');
      if (bar < 0) {
        if (lons === null && /^\s*-?\d/.test(line) && line.indexOf('---') < 0) {
          var hv = line.trim().split(/\s+/).map(parseFloat);
          var okHeader = hv.length > 8;
          for (var h = 0; h < hv.length; h++) if (!isFinite(hv[h])) okHeader = false;
          if (okHeader) lons = hv;
        }
        continue;
      }
      var lat = parseFloat(line.slice(0, bar));
      if (!isFinite(lat)) continue;
      var vals = line.slice(bar + 1).trim().split(/\s+/);
      var row = new Float32Array(vals.length);
      for (var c = 0; c < vals.length; c++) {
        var v = parseFloat(vals[c]);
        row[c] = isFinite(v) ? v : 0;
      }
      lats.push(lat);
      rows.push(row);
    }
    if (!lons || lons.length < 2) throw new Error('drap: no longitude header');
    if (rows.length < 2) throw new Error('drap: no data rows');
    var cols = lons.length;
    for (i = 0; i < rows.length; i++) {
      if (rows[i].length !== cols) throw new Error('drap: row ' + i + ' has ' + rows[i].length + ' of ' + cols + ' columns');
    }
    var values = new Float32Array(rows.length * cols), maxV = 0, maxI = 0;
    for (i = 0; i < rows.length; i++) {
      for (c = 0; c < cols; c++) {
        var val = rows[i][c];
        values[i * cols + c] = val;
        if (val > maxV) { maxV = val; maxI = i * cols + c; }
      }
    }
    var dLat = lats[1] - lats[0];
    var dLon = lons[1] - lons[0];
    var t = isFinite(validAt) ? validAt : (ctx && isNum(ctx.now) ? ctx.now : NaN);
    if (!isFinite(t)) throw new Error('drap: no valid time');
    return {
      t: t,
      validText: validText,
      rows: rows.length,
      cols: cols,
      lat0: lats[0],
      lon0: lons[0],
      dLat: dLat,
      dLon: dLon,
      values: values,
      maxMHz: maxV,
      peak: { mhz: maxV, lat: lats[0] + Math.floor(maxI / cols) * dLat, lon: lons[0] + (maxI % cols) * dLon },
      units: 'MHz'
    };
  }

  /* Nearest cell. Longitude wraps; latitude clamps at the poles. */
  function drapValueAt(grid, lat, lon) {
    if (!grid || !grid.values) return NaN;
    if (!isFinite(lat) || !isFinite(lon)) return NaN;
    var i = Math.round((lat - grid.lat0) / grid.dLat);
    if (i < 0) i = 0;
    if (i > grid.rows - 1) i = grid.rows - 1;
    var span = grid.cols * Math.abs(grid.dLon);
    var d = wrapLon(lon) - grid.lon0;
    if (span >= 359) d = posMod(d, 360);
    var j = Math.round(d / grid.dLon);
    if (span >= 359) j = posMod(j, grid.cols);
    else if (j < 0 || j > grid.cols - 1) return NaN;
    return grid.values[i * grid.cols + j];
  }

  /* ================================================================== 3. Kp and solar wind */

  var KP_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
  var RTSW_URL = 'https://services.swpc.noaa.gov/products/geospace/propagated-solar-wind-1-hour.json';

  /* A shock is a step up in speed or a jump in density between the last few minutes
     and the half hour before it. These two constants are what t-feeds asserts on. */
  var SHOCK_DSPEED_KMS = 30;
  var SHOCK_DENS_RATIO = 2;

  function fetchKpRtsw() {
    return Promise.all([fetchText(KP_URL), fetchText(RTSW_URL)]).then(function (parts) {
      var out = { kp: parts[0], rtsw: parts[1] };
      try {
        Object.defineProperty(out, 'byteLength', {
          value: parts[0].length + parts[1].length, enumerable: false
        });
      } catch (e) { /* byte accounting only */ }
      return out;
    });
  }

  /* SWPC "products" files are arrays of arrays whose first row is the column names.
     Some of the same products also appear as arrays of objects, so both are accepted. */
  function rowsToObjects(arr, what) {
    if (!isArr(arr) || !arr.length) throw new Error(what + ': empty');
    if (!Array.isArray(arr[0])) return arr;
    var names = arr[0], out = [];
    for (var i = 1; i < arr.length; i++) {
      var row = arr[i], o = {};
      if (!isArr(row)) continue;
      for (var c = 0; c < names.length; c++) o[names[c]] = row[c];
      out.push(o);
    }
    return out;
  }

  function parseKpRtsw(raw, ctx) {
    if (!raw || typeof raw !== 'object') throw new Error('kp_rtsw: expected the two payloads');
    var kpArr = rowsToObjects(jsonOf(raw.kp, 'kp'), 'kp');
    var swArr = rowsToObjects(jsonOf(raw.rtsw, 'rtsw'), 'rtsw');

    var kpSeries = [], i, o, t, v;
    for (i = 0; i < kpArr.length; i++) {
      o = kpArr[i];
      t = parseIsoMs(o.time_tag);
      v = num(o.Kp, num(o.kp_index, NaN));
      if (isFinite(t) && isFinite(v)) kpSeries.push({ t: t, kp: v });
    }
    if (!kpSeries.length) throw new Error('kp_rtsw: no Kp samples');
    kpSeries.sort(function (a, b) { return a.t - b.t; });
    var kpNow = kpSeries[kpSeries.length - 1];

    var wind = [];
    for (i = 0; i < swArr.length; i++) {
      o = swArr[i];
      t = parseIsoMs(o.time_tag);
      var pt = parseIsoMs(o.propagated_time_tag);
      var speed = num(o.speed, NaN);
      if (!isFinite(t) || !isFinite(speed)) continue;
      wind.push({
        t: t,
        arrivesAt: isFinite(pt) ? pt : t,
        speed: speed,
        density: num(o.density, NaN),
        bt: num(o.bt, NaN),
        bz: num(o.bz, NaN),
        temperature: num(o.temperature, NaN)
      });
    }
    wind.sort(function (a, b) { return a.t - b.t; });

    var shock = { detected: false, dSpeedKms: NaN, densRatio: NaN, t: NaN };
    if (wind.length >= 20) {
      var tail = wind.slice(-5), prior = wind.slice(-30, -10);
      var sNow = median(tail.map(function (w) { return w.speed; }));
      var sPrior = median(prior.map(function (w) { return w.speed; }));
      var dNow = median(tail.map(function (w) { return w.density; }).filter(isFinite));
      var dPrior = median(prior.map(function (w) { return w.density; }).filter(isFinite));
      var dSpeed = sNow - sPrior;
      var ratio = (isFinite(dNow) && isFinite(dPrior) && dPrior > 0) ? dNow / dPrior : NaN;
      shock.dSpeedKms = dSpeed;
      shock.densRatio = ratio;
      shock.t = wind[wind.length - 1].arrivesAt;
      shock.detected = (isFinite(dSpeed) && dSpeed >= SHOCK_DSPEED_KMS) ||
        (isFinite(ratio) && ratio >= SHOCK_DENS_RATIO && isFinite(dSpeed) && dSpeed >= 10);
    }
    /* The last shock survives across polls so an instrument can ask how long ago it was. */
    var st = (ctx && ctx.state) ? ctx.state : {};
    if (shock.detected && isFinite(shock.t)) st.lastShockMs = shock.t;
    var lastShockMs = isNum(st.lastShockMs) ? st.lastShockMs : NaN;

    var latest = wind.length ? wind[wind.length - 1] : null;
    return {
      t: latest ? latest.arrivesAt : kpNow.t,
      kp: kpNow.kp,
      kpAt: kpNow.t,
      kpSeries: kpSeries,
      storm: kpNow.kp >= 5,
      wind: latest,
      windSeries: wind,
      shock: shock,
      lastShockMs: lastShockMs
    };
  }

  /* ================================================================== 4. OVATION aurora */

  var OVATION_URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
  var OVATION_CHUNK = 4096;

  /*
   * 65,160 [lon, lat, probability] triples. Returned as an iterator so the kernel can
   * slice the fill loop across tasks; runParse drives it to completion for tests and
   * for anyone calling the parser directly.
   */
  function parseOvation(raw, ctx) {
    var j = jsonOf(raw, 'ovation');
    var co = j && j.coordinates;
    if (!isArr(co) || co.length < 100) throw new Error('ovation: no coordinates');
    var t = parseIsoMs(j['Observation Time']);
    if (!isFinite(t)) t = (ctx && isNum(ctx.now)) ? ctx.now : NaN;
    if (!isFinite(t)) throw new Error('ovation: no observation time');
    var rows = 181, cols = 360;
    var values = new Float32Array(rows * cols);
    var i = 0, n = co.length, maxV = 0, maxLat = 0, maxLon = 0, bad = 0;
    var out = {
      t: t,
      forecastT: parseIsoMs(j['Forecast Time']),
      rows: rows, cols: cols,
      lat0: -90, dLat: 1, lon0: 0, dLon: 1,
      values: values,
      maxProb: 0,
      peak: { lat: 0, lon: 0, prob: 0 },
      n: n,
      units: 'percent'
    };
    return {
      next: function () {
        if (i >= n) {
          out.maxProb = maxV;
          out.peak = { lat: maxLat, lon: wrapLon(maxLon), prob: maxV };
          out.dropped = bad;
          if (bad === n) throw new Error('ovation: every point was unusable');
          return { done: true, value: out };
        }
        var end = Math.min(n, i + OVATION_CHUNK);
        for (; i < end; i++) {
          var p = co[i];
          if (!p || p.length < 3) { bad++; continue; }
          var lon = num(p[0], NaN), lat = num(p[1], NaN), v = num(p[2], NaN);
          if (!isFinite(lon) || !isFinite(lat) || !isFinite(v)) { bad++; continue; }
          var ri = Math.round(lat) + 90;
          var ci = posMod(Math.round(lon), 360);
          if (ri < 0 || ri >= rows) { bad++; continue; }
          values[ri * cols + ci] = v;
          if (v > maxV) { maxV = v; maxLat = lat; maxLon = lon; }
        }
        return { done: false, value: null };
      }
    };
  }

  /* ================================================================== 5. Cloud discs */

  var CLOUD_BASE = 'https://cdn.star.nesdis.noaa.gov/';
  /* The geostationary horizon, the physical fact, carried in the payload so the
     card can say what the satellite can actually see. */
  var CLOUD_HORIZON_DEG = 81.3;
  /* What we let the renderer SAMPLE. The last degrees before the horizon are the
     limb, foreshortened to nothing and carrying the CDN's own branding band, so we
     stop at 65 degrees (the A1 seam note asked for 62 to 70). */
  var CLOUD_COVERAGE_DEG = 65;
  var CLOUD_SATS = [
    { id: 'GOES19', name: 'GOES East', satLon: -75.2 },
    { id: 'GOES18', name: 'GOES West', satLon: -137 }
  ];
  var CLOUD_SIZES = [678, 339];
  var cloudSize = {};   /* satellite id -> the size that answered 200 */

  function cloudUrl(satId, px) {
    return CLOUD_BASE + satId + '/ABI/FD/GEOCOLOR/' + px + 'x' + px + '.jpg';
  }

  /*
   * NOAA bakes its own branding into these JPEGs. Measured on the live 2026-08-16
   * frames, identical in the GOES19 and GOES18 copies (which is how they were told
   * apart from weather): a white caption strip across the FULL width in the bottom
   * 16 rows (y 662 to 677 of 678, y 325 to 338 of 339, so its height is fixed in
   * pixels, not a fraction), and a 40 px agency logo at x 12 to 51, y 621 to 660.
   * The strip crosses the disc near the south limb and drew as mirrored text on the
   * planet. Both are painted out below before the texture is handed to the renderer.
   */
  var CLOUD_BANNER_PX = 18;      /* bottom rows removed: the 16 row strip plus margin */
  var CLOUD_LOGO_W_FRAC = 0.15;  /* the logo box, generous: it sits outside the disc */
  var CLOUD_LOGO_H_FRAC = 0.14;

  /*
   * Paints the branding out of a decoded disc. Geometry is preserved exactly (same
   * width and height, same centre), because the renderer maps this image by its own
   * centre and half angle: a real crop would move the sub satellite point. Painted
   * black reads as luminance zero, which the cloud shader treats as no cloud.
   * Returns the canvas, or the original image when there is no canvas to draw on.
   */
  function maskCloudBranding(img, w, h) {
    var doc = global.document;
    if (!doc || typeof doc.createElement !== 'function') return img;
    var cv;
    try {
      cv = doc.createElement('canvas');
      cv.width = w; cv.height = h;
      var cx = cv.getContext('2d');
      if (!cx) return img;
      cx.drawImage(img, 0, 0, w, h);
      cx.fillStyle = '#000';
      cx.fillRect(0, h - CLOUD_BANNER_PX, w, CLOUD_BANNER_PX);
      cx.fillRect(0, Math.round(h * (1 - CLOUD_LOGO_H_FRAC)),
                  Math.round(w * CLOUD_LOGO_W_FRAC), Math.round(h * CLOUD_LOGO_H_FRAC));
    } catch (e) {
      return img;
    }
    if (img && typeof img.close === 'function') { try { img.close(); } catch (e2) { /* bitmap already gone */ } }
    return cv;
  }

  function toBitmap(blob) {
    if (typeof global.createImageBitmap === 'function') return global.createImageBitmap(blob);
    return new Promise(function (resolve, reject) {
      var url = global.URL && global.URL.createObjectURL ? global.URL.createObjectURL(blob) : null;
      if (!url || typeof global.Image !== 'function') { reject(new Error('no image decoder')); return; }
      var img = new global.Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('image decode failed')); };
      img.src = url;
    });
  }

  function fetchOneDisc(sat) {
    var sizes = cloudSize[sat.id] ? [cloudSize[sat.id]] : CLOUD_SIZES;
    var i = 0;
    function step() {
      if (i >= sizes.length) return null;
      var px = sizes[i++];
      return httpFetch(cloudUrl(sat.id, px), { timeoutMs: FETCH_TIMEOUT_SLOW_MS }).then(function (res) {
        if (!res || !res.ok) return step();
        var lm = (res.headers && res.headers.get) ? res.headers.get('last-modified') : null;
        return res.blob().then(function (blob) {
          return toBitmap(blob).then(function (img) {
            cloudSize[sat.id] = px;
            var w = num(img.width, px), h = num(img.height, px);
            return {
              sat: sat.id,
              name: sat.name,
              satLon: sat.satLon,
              coverageDeg: CLOUD_COVERAGE_DEG,
              horizonDeg: CLOUD_HORIZON_DEG,
              px: px,
              bytes: blob.size || 0,
              t: lm ? Date.parse(lm) : NaN,
              img: maskCloudBranding(img, w, h)
            };
          });
        });
      }, function () { return step(); });
    }
    return Promise.resolve(step()).then(null, function () { return null; });
  }

  function fetchClouds() {
    return Promise.all(CLOUD_SATS.map(fetchOneDisc)).then(function (discs) {
      var out = { discs: [] }, bytes = 0;
      for (var i = 0; i < discs.length; i++) {
        if (discs[i]) { out.discs.push(discs[i]); bytes += discs[i].bytes || 0; }
      }
      try { Object.defineProperty(out, 'byteLength', { value: bytes, enumerable: false }); }
      catch (e) { /* byte accounting only */ }
      return out;
    });
  }

  function parseClouds(raw, ctx) {
    if (!raw || typeof raw !== 'object' || !isArr(raw.discs) || !raw.discs.length) {
      throw new Error('clouds: no disc images');
    }
    var discs = [], newest = NaN;
    for (var i = 0; i < raw.discs.length; i++) {
      var d = raw.discs[i];
      if (!d || !d.img) continue;
      var w = num(d.img.width, num(d.px, NaN));
      var h = num(d.img.height, num(d.px, NaN));
      if (!isFinite(w) || !isFinite(h) || w < 2 || h < 2) continue;
      if (!isFinite(num(d.satLon, NaN))) continue;
      discs.push({
        sat: d.sat, name: d.name, satLon: d.satLon,
        coverageDeg: num(d.coverageDeg, CLOUD_COVERAGE_DEG),
        horizonDeg: num(d.horizonDeg, CLOUD_HORIZON_DEG),
        tex: d.img, w: w, h: h, px: num(d.px, w), t: num(d.t, NaN)
      });
      if (isFinite(d.t) && (!isFinite(newest) || d.t > newest)) newest = d.t;
    }
    if (!discs.length) throw new Error('clouds: no usable disc images');
    var t = isFinite(newest) ? newest : (ctx && isNum(ctx.now) ? ctx.now : NaN);
    if (!isFinite(t)) throw new Error('clouds: no image time');
    return { t: t, discs: discs, n: discs.length };
  }

  /* ================================================================== 6. WSPR */

  var WSPR_URL = 'https://db1.wspr.live/';
  var WSPR_WINDOW_MIN = 15;
  var WSPR_MIN_COUNT = 2;
  var WSPR_RING_MS = 3600000;   /* the rolling hour of polls the instrument reasons over */
  var WSPR_MAX_POLLS = 24;
  var WSPR_MAX_KEYS = 60000;

  /*
   * Band code (integer MHz as WSPR.live reports it) to the band's nominal frequency.
   * This is the table spec 6.1 pins plus 60 m (band code 5, 5.3644 MHz), added by
   * spec revision r5 ruling 2 after the live query returned 139 paths on it.
   *
   * THIS IS THE ONE COPY. obs-instruments.js reads it through ObsFeeds rather than
   * keeping its own literal, so a new band is one line here (r5 ruling 2, C1 punch
   * list item 5). Codes outside it (13 shows up occasionally) are dropped rather
   * than guessed at, and the count is reported as droppedBand.
   */
  var BAND_MHZ = {
    1: 1.8, 3: 3.5, 5: 5.3644, 7: 7, 10: 10.1, 14: 14, 18: 18.1, 21: 21, 24: 24.9, 28: 28
  };

  /* Display names for the same codes, used by the instrument's band readout. */
  var BAND_NAME = {
    1: '160m', 3: '80m', 5: '60m', 7: '40m', 10: '30m', 14: '20m',
    18: '17m', 21: '15m', 24: '12m', 28: '10m'
  };

  var WSPR_QUERY = 'SELECT band, substring(tx_loc,1,4) AS t4, substring(rx_loc,1,4) AS r4,' +
    ' count() AS c, max(snr) AS s FROM wspr.rx' +
    ' WHERE time > subtractMinutes(now(),' + WSPR_WINDOW_MIN + ') AND band BETWEEN 1 AND 28' +
    ' GROUP BY band, t4, r4 HAVING c >= ' + WSPR_MIN_COUNT + ' FORMAT JSONCompact';

  function wsprUrl() { return WSPR_URL + '?query=' + encodeURIComponent(WSPR_QUERY); }

  function fetchWspr() {
    return fetchText(wsprUrl()).then(function (text) {
      var out = jsonOf(text, 'wspr');
      try { Object.defineProperty(out, 'byteLength', { value: text.length, enumerable: false }); }
      catch (e) { /* byte accounting only */ }
      return out;
    });
  }

  var GRID4 = /^[A-Ra-r]{2}[0-9]{2}$/;

  function pathKey(band, t4, r4) { return band + '|' + t4 + '|' + r4; }

  /*
   * JSONCompact: meta names the columns, data holds arrays in that order. Keeps a ring
   * of the last hour of polls in ctx.state so the instrument can build its baseline
   * without the feed deciding anything about what a baseline is.
   */
  function parseWspr(raw, ctx) {
    var j = jsonOf(raw, 'wspr');
    if (!j || !isArr(j.meta) || !isArr(j.data)) {
      throw new Error('wspr: expected JSONCompact meta and data');
    }
    var col = {};
    for (var i = 0; i < j.meta.length; i++) col[j.meta[i].name] = i;
    var need = ['band', 't4', 'r4', 'c'];
    for (i = 0; i < need.length; i++) {
      if (!(need[i] in col)) throw new Error('wspr: missing column ' + need[i]);
    }
    var hasSnr = ('s' in col);
    var now = (ctx && isNum(ctx.now)) ? ctx.now : NaN;
    if (!isFinite(now)) throw new Error('wspr: no clock');

    var paths = [], keys = {}, droppedBand = 0, droppedGrid = 0;
    for (i = 0; i < j.data.length; i++) {
      var row = j.data[i];
      if (!isArr(row)) continue;
      var band = num(row[col.band], NaN);
      var mhz = BAND_MHZ[band];
      if (!mhz) { droppedBand++; continue; }
      var t4 = row[col.t4], r4 = row[col.r4];
      if (typeof t4 !== 'string' || typeof r4 !== 'string' || !GRID4.test(t4) || !GRID4.test(r4)) {
        droppedGrid++;
        continue;
      }
      t4 = t4.toUpperCase(); r4 = r4.toUpperCase();
      var c = num(row[col.c], 0);
      var key = pathKey(band, t4, r4);
      paths.push({
        key: key, band: band, mhz: mhz, t4: t4, r4: r4,
        c: c, snr: hasSnr ? num(row[col.s], NaN) : NaN
      });
      keys[key] = c;
    }
    if (!paths.length && j.data.length) throw new Error('wspr: no usable rows in ' + j.data.length);

    var st = (ctx && ctx.state) ? ctx.state : {};
    var polls = st.polls && st.polls.slice ? st.polls : [];
    polls = polls.filter(function (p) { return now - p.t <= WSPR_RING_MS; });
    polls.push({ t: now, keys: keys, n: paths.length });
    while (polls.length > WSPR_MAX_POLLS) polls.shift();
    /* A pathological day of churn must not grow without bound. */
    var total = 0;
    for (i = polls.length - 1; i >= 0; i--) {
      total += polls[i].n;
      if (total > WSPR_MAX_KEYS && i > 0) { polls = polls.slice(i); break; }
    }
    st.polls = polls;

    return {
      t: now,
      paths: paths,
      n: paths.length,
      polls: polls,
      windowMin: WSPR_WINDOW_MIN,
      minCount: WSPR_MIN_COUNT,
      droppedBand: droppedBand,
      droppedGrid: droppedGrid,
      rowsIn: j.data.length,
      queryRows: num(j.rows, NaN)
    };
  }

  /* How many of the polls inside [now-fromMs, now-toMs] carried each path. The
     instrument decides what threshold makes a baseline. */
  function pollKeyCounts(polls, nowMs, fromMs, toMs) {
    var out = {};
    if (!polls) return out;
    for (var i = 0; i < polls.length; i++) {
      var age = nowMs - polls[i].t;
      if (age > fromMs || age < toMs) continue;
      for (var k in polls[i].keys) out[k] = (out[k] || 0) + 1;
    }
    return out;
  }

  /* ================================================================== 7. USGS quakes */

  /* The DAY summary, not the hour one (H2). The hour feed is seven to a dozen
     quakes, which is an honest number and a nearly empty planet; the day feed
     is the same rows over 24 hours, which is what the ambient layer fades out
     by age. Measured against the live endpoint on 2026-08-17: 138,914 bytes
     raw (18,017 gzipped) for 193 quakes, against 5,311 bytes for 7. At the
     300 s cadence below that is 1.67 MB an hour uncompressed, inside the 2 MB
     an hour this page allows itself for one feed; if USGS ever grows the day
     payload past that, the cadence goes to 600 s, not the window back to an
     hour. The parser is unchanged: the two summaries are the same shape. */
  var USGS_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
  var USGS_WINDOW_MS = 24 * 3600000;

  function normQuake(o) {
    return {
      id: o.id, src: o.src, t: o.t, lat: o.lat, lon: o.lon,
      depthKm: o.depthKm, mag: o.mag, magType: o.magType || null,
      place: o.place || '', url: o.url || null, tsunami: !!o.tsunami,
      evtype: o.evtype || null
    };
  }

  function parseUsgs(raw, ctx) {
    var j = jsonOf(raw, 'usgs_quakes');
    if (!j || !isArr(j.features)) {
      throw new Error('usgs_quakes: expected a FeatureCollection');
    }
    var quakes = [], dropped = 0;
    for (var i = 0; i < j.features.length; i++) {
      var f = j.features[i];
      var p = f && f.properties;
      var g = f && f.geometry && f.geometry.coordinates;
      if (!p || !g || g.length < 2) { dropped++; continue; }
      var lon = num(g[0], NaN), lat = num(g[1], NaN);
      var t = num(p.time, NaN), mag = num(p.mag, NaN);
      /* Longitude is wrapped, latitude cannot be: 8000 aliases through sin/cos to a
         believable 80N, so an unchecked row draws a marker at a place nothing happened.
         The row is refused rather than clamped, and it lands in dropped where it shows. */
      if (!isFinite(lat) || !isFinite(lon) || !isFinite(t)) { dropped++; continue; }
      if (lat < -90 || lat > 90) { dropped++; continue; }
      quakes.push(normQuake({
        id: 'usgs:' + f.id, src: 'usgs', t: t, lat: lat, lon: wrapLon(lon),
        depthKm: num(g[2], NaN), mag: mag, magType: p.magType,
        place: p.place || p.title || '', url: p.url, tsunami: p.tsunami,
        evtype: p.type
      }));
    }
    quakes.sort(function (a, b) { return b.t - a.t; });
    var t0 = (j.metadata && num(j.metadata.generated, NaN));
    if (!isFinite(t0)) t0 = (ctx && isNum(ctx.now)) ? ctx.now : (quakes.length ? quakes[0].t : NaN);
    if (!isFinite(t0)) throw new Error('usgs_quakes: no generation time');
    return { t: t0, quakes: quakes, count: quakes.length, dropped: dropped, source: 'usgs' };
  }

  /* ================================================================== 8. EMSC websocket */

  var EMSC_WS = 'wss://www.seismicportal.eu/standing_order/websocket';

  function emscFeature(f) {
    var p = f && f.properties ? f.properties : f;
    if (!p) return null;
    var g = f && f.geometry && f.geometry.coordinates;
    var lat = num(p.lat, g ? num(g[1], NaN) : NaN);
    var lon = num(p.lon, g ? num(g[0], NaN) : NaN);
    var t = parseIsoMs(p.time);
    var id = p.unid || p.source_id || (f && f.id);
    if (!isFinite(lat) || !isFinite(lon) || !isFinite(t) || !id) return null;
    if (lat < -90 || lat > 90) return null;   /* same rule as parseUsgs, see the note there */
    return normQuake({
      id: 'emsc:' + id, src: 'emsc', t: t, lat: lat, lon: wrapLon(lon),
      depthKm: num(p.depth, NaN), mag: num(p.mag, NaN), magType: p.magtype,
      place: p.flynn_region || '', url: null, tsunami: false, evtype: p.evtype
    });
  }

  /*
   * The standing_order socket wraps each event as {action, data: <GeoJSON feature>}.
   * A bare feature and a FeatureCollection (the shape their REST endpoint returns, which
   * is what the fixture holds) are accepted too, so one parser covers both.
   */
  function parseEmsc(raw, ctx) {
    var j = jsonOf(raw, 'emsc_ws');
    var action = null, feats = null;
    if (j && j.data && (j.data.properties || j.data.type === 'Feature')) {
      action = typeof j.action === 'string' ? j.action : null;
      feats = [j.data];
    } else if (j && j.type === 'FeatureCollection' && isArr(j.features)) {
      feats = j.features;
    } else if (j && (j.type === 'Feature' || j.properties)) {
      feats = [j];
    }
    if (!isArr(feats) || !feats.length) throw new Error('emsc_ws: no event in the message');
    var quakes = [];
    for (var i = 0; i < feats.length; i++) {
      var q = emscFeature(feats[i]);
      if (q) quakes.push(q);
    }
    if (!quakes.length) throw new Error('emsc_ws: no usable event fields');
    quakes.sort(function (a, b) { return b.t - a.t; });
    return {
      t: (ctx && isNum(ctx.now)) ? ctx.now : quakes[0].t,
      action: action,
      quake: quakes[0],
      quakes: quakes,
      count: quakes.length,
      source: 'emsc'
    };
  }

  /* Quake dedupe against the other network. The coarse key is only a pre-filter:
     sameQuake is the real test (spec 4: within 60 s and 1 degree). */
  function quakeDedupeKey(q, dtMs, dDeg) {
    var dt = isNum(dtMs) ? dtMs : 60000;
    var dd = isNum(dDeg) ? dDeg : 1;
    return Math.round(q.t / dt) + ':' + Math.round(q.lat / dd) + ':' + Math.round(wrapLon(q.lon) / dd);
  }

  function sameQuake(a, b, opts) {
    if (!a || !b) return false;
    var dt = (opts && isNum(opts.dtMs)) ? opts.dtMs : 60000;
    var dd = (opts && isNum(opts.dDeg)) ? opts.dDeg : 1;
    if (Math.abs(a.t - b.t) > dt) return false;
    if (Math.abs(a.lat - b.lat) > dd) return false;
    var dl = wrapLon(a.lon) - wrapLon(b.lon);
    if (dl > 180) dl -= 360;
    if (dl < -180) dl += 360;
    return Math.abs(dl) <= dd;
  }

  /* First occurrence wins, later reports of the same shock are recorded as alsoSeenBy
     so the page can say both networks have it without listing it twice. */
  function dedupeQuakes(list, opts) {
    var out = [];
    if (!list) return out;
    for (var i = 0; i < list.length; i++) {
      var q = list[i];
      if (!q) continue;
      var hit = null;
      for (var k = 0; k < out.length; k++) {
        if (sameQuake(out[k], q, opts)) { hit = out[k]; break; }
      }
      if (hit) {
        if (hit.src !== q.src) {
          hit.alsoSeenBy = hit.alsoSeenBy || [];
          if (hit.alsoSeenBy.indexOf(q.src) < 0) hit.alsoSeenBy.push(q.src);
        }
        continue;
      }
      out.push(q);
    }
    return out;
  }

  var QUAKE_WORDS = [
    { m: 8, w: 'great' }, { m: 7, w: 'major' }, { m: 6, w: 'strong' }, { m: 5.5, w: 'moderate' }
  ];

  function quakeWord(mag) {
    for (var i = 0; i < QUAKE_WORDS.length; i++) if (mag >= QUAKE_WORDS[i].m) return QUAKE_WORDS[i].w;
    return '';
  }

  /* A normalized planet event per spec 2.3, ready for ObsCore.emitEvent. */
  function quakeEvent(q) {
    if (!q || !isFinite(q.t) || !isFinite(q.lat) || !isFinite(q.lon)) return null;
    var magText = isFinite(q.mag) ? ('M' + (Math.round(q.mag * 10) / 10).toFixed(1)) : 'M?';
    var place = q.place || 'unnamed region';
    return {
      id: q.id,
      cls: 'quake',
      t: q.t,
      lat: q.lat,
      lon: q.lon,
      mag: isFinite(q.mag) ? q.mag : null,
      label: magText + ' ' + place,
      meta: {
        place: place, depthKm: q.depthKm, magType: q.magType, src: q.src,
        url: q.url || null, word: quakeWord(q.mag)
      }
    };
  }

  function flareEvent(x) {
    if (!x || !isFinite(x.t) || !isFinite(x.flux)) return null;
    var cls = flareClass(x.flux);
    return {
      id: 'flare:' + Math.round(x.t / 60000),
      cls: 'flare',
      t: x.t,
      lat: isNum(x.lat) ? x.lat : 0,
      lon: isNum(x.lon) ? x.lon : 0,
      mag: x.flux,
      label: (cls ? cls.text : 'flare') + ' solar flare',
      meta: { cls: cls ? cls.text : null, band: XRAY_BAND, satellite: x.satellite || null }
    };
  }

  /* ================================================================== 9. Wikimedia edits */

  var WM_SSE_URL = 'https://stream.wikimedia.org/v2/stream/recentchange';

  /*
   * Two ways to watch Wikipedia notice something, and they cost wildly different amounts.
   *
   * The firehose (wm_edits) is every edit on every wiki, about 40 messages a second, which
   * measured at 160 to 200 MB an hour. It is the only way to time a notice to the second,
   * so a live stopwatch streams for its first 15 minutes (deviation r6 in the plan) and
   * then falls back to asking the MediaWiki APIs once a minute for pages matching the
   * quake's own words. Polling cannot see an edit land the moment it lands, so anything
   * measured that way is honest only to about a minute, and the mode travels with every
   * row so the result line can say which one measured it.
   */
  var EDIT_MODE = { stream: 'stream', poll: 'poll' };
  var EDIT_FEED = { stream: 'wm_edits', poll: 'wm_search' };
  var EDIT_RESOLUTION_MS = { stream: 1000, poll: 60000 };
  var WM_STREAM_MAX_MS = 15 * 60000;

  /*
   * One message is one recent change. Anything outside the article namespace, and
   * anything that is not an edit or a page creation, returns null: the kernel treats
   * that as "nothing to report" and never wakes an instrument for it. At about 40
   * messages a second that filter is most of the cost of having this stream open.
   */
  function parseWmEdit(raw, ctx) {
    var j = jsonOf(raw, 'wm_edits');
    if (!j || typeof j !== 'object') throw new Error('wm_edits: not an object');
    if (typeof j.title !== 'string' && typeof j.type !== 'string') {
      throw new Error('wm_edits: message has no type or title');
    }
    if (j.type !== 'edit' && j.type !== 'new') return null;
    if (num(j.namespace, -1) !== 0) return null;
    var server = j.server_name || (j.meta && j.meta.domain) || '';
    var t = num(j.timestamp, NaN);
    t = isFinite(t) ? t * 1000 : parseIsoMs(j.meta && j.meta.dt);
    if (!isFinite(t)) t = (ctx && isNum(ctx.now)) ? ctx.now : NaN;
    if (!isFinite(t)) throw new Error('wm_edits: no timestamp');
    return {
      t: t,
      mode: EDIT_MODE.stream,
      via: 'stream',
      id: (j.meta && j.meta.id) || String(j.id || ''),
      type: j.type,
      isNew: j.type === 'new',
      title: j.title || '',
      comment: typeof j.comment === 'string' ? j.comment : '',
      user: j.user || '',
      bot: !!j.bot,
      wiki: j.wiki || '',
      server: server,
      lang: server ? String(server).split('.')[0] : '',
      url: j.title_url || (j.meta && j.meta.uri) || null
    };
  }

  /* ============================================ 9b. The same watch, without the firehose */

  var WM_POLL_CADENCE_MS = 60000;
  var WM_POLL_LANGS = ['en', 'es', 'de', 'fr', 'ja'];
  var WM_POLL_RC_LIMIT = 30;
  var WM_POLL_SEARCH_LIMIT = 10;
  var WM_POLL_MAX_LANGS = 8;
  var editTarget = null;

  /*
   * The caller (the stopwatch) owns the words to look for and may narrow the wikis: an
   * earthquake in Chile is noticed in Spanish first, so passing langs is cheaper AND
   * better than the default top-five list. Every field is validated here because this
   * string goes into a URL.
   */
  function setEditSearch(target) {
    if (!target) { editTarget = null; return null; }
    var toks = [];
    var src = isArr(target.tokens) ? target.tokens : [];
    for (var i = 0; i < src.length; i++) {
      var tk = typeof src[i] === 'string' ? src[i].trim() : '';
      if (tk) toks.push(tk);
    }
    if (!toks.length) throw new Error('edit search needs at least one token');
    var langs = [];
    var ls = isArr(target.langs) ? target.langs : WM_POLL_LANGS;
    for (var k = 0; k < ls.length && langs.length < WM_POLL_MAX_LANGS; k++) {
      var lg = typeof ls[k] === 'string' ? ls[k].trim().toLowerCase() : '';
      if (/^[a-z]{2,3}(-[a-z]{2,8})?$/.test(lg) && langs.indexOf(lg) < 0) langs.push(lg);
    }
    if (!langs.length) langs = WM_POLL_LANGS.slice();
    editTarget = {
      tokens: toks,
      langs: langs,
      sinceMs: isNum(target.sinceMs) ? target.sinceMs : null,
      eventId: target.eventId || null
    };
    return editTarget;
  }

  function editSearch() { return editTarget; }

  /*
   * One request per wiki carries both halves of the watch: `search` finds pages whose text
   * matches the quake's words, newest creations first, and `recentchanges` is the coarse
   * pass over what the wiki has just touched. formatversion=2 keeps the rows flat and
   * origin=* is what makes an anonymous cross-origin read legal.
   */
  function wmSearchUrl(lang, target) {
    var q = (target && isArr(target.tokens)) ? target.tokens.join(' ') : '';
    return 'https://' + lang + '.wikipedia.org/w/api.php' +
      '?action=query&format=json&formatversion=2&origin=*' +
      '&list=search%7Crecentchanges' +
      '&srsearch=' + encodeURIComponent(q) +
      '&srnamespace=0&srlimit=' + WM_POLL_SEARCH_LIMIT +
      '&srsort=create_timestamp_desc&srprop=timestamp' +
      '&rcnamespace=0&rctype=new%7Cedit&rcshow=%21redirect' +
      '&rclimit=' + WM_POLL_RC_LIMIT +
      '&rcprop=title%7Ctimestamp%7Ccomment%7Cuser%7Cflags%7Cids';
  }

  function fetchWmSearch() {
    var target = editTarget;
    if (!target) return Promise.resolve({ idle: true });
    var langs = target.langs;
    var jobs = [];
    for (var i = 0; i < langs.length; i++) {
      jobs.push((function (lang) {
        var url = wmSearchUrl(lang, target);
        /* The rejection handler is CHAINED, never a sibling: a wiki that answers 500
           throws inside the fulfilment handler, which a sibling handler would not see,
           and one bad wiki must never take the other four down with it. */
        return wmFetch(url).then(function (res) {
          okOrThrow(res, url);
          return res.text().then(function (text) {
            return { lang: lang, ok: true, bytes: text.length, body: jsonOf(text, 'wm_search') };
          });
        }).then(null, function (err) {
          return { lang: lang, ok: false, error: String((err && err.message) || err) };
        });
      })(langs[i]));
    }
    return Promise.all(jobs).then(function (wikis) {
      var bytes = 0, live = 0;
      for (var j = 0; j < wikis.length; j++) {
        if (wikis[j].ok) { live++; bytes += wikis[j].bytes || 0; }
      }
      if (!live) throw new Error('wm_search: every wiki refused the query');
      var out = { wikis: wikis, tokens: target.tokens.slice(), eventId: target.eventId };
      try { Object.defineProperty(out, 'byteLength', { value: bytes, enumerable: false }); }
      catch (e) { /* byte accounting only */ }
      return out;
    });
  }

  /*
   * A search row's timestamp is the page's LAST edit, not the moment of the edit that
   * matched, and a search row cannot say whether the page was created for this event, so
   * isNew stays null there rather than guessing. Recentchanges rows do know both.
   */
  function pollEditRow(lang, r, via, ctx) {
    if (!r || typeof r !== 'object') return null;
    var title = typeof r.title === 'string' ? r.title.trim() : '';
    if (!title) return null;
    var t = parseIsoMs(r.timestamp);
    if (!isFinite(t)) t = (ctx && isNum(ctx.now)) ? ctx.now : NaN;
    if (!isFinite(t)) return null;
    var server = lang + '.wikipedia.org';
    var key = (r.rcid !== undefined && r.rcid !== null) ? String(r.rcid)
      : (r.pageid !== undefined && r.pageid !== null) ? String(r.pageid) : title;
    return {
      t: t,
      mode: EDIT_MODE.poll,
      via: via,
      id: via + ':' + lang + ':' + key + ':' + Math.round(t / 1000),
      type: r.type === 'new' ? 'new' : 'edit',
      isNew: via === 'recentchanges' ? (r.type === 'new') : null,
      title: title,
      comment: typeof r.comment === 'string' ? r.comment : '',
      user: typeof r.user === 'string' ? r.user : '',
      bot: !!r.bot,
      wiki: lang + 'wiki',
      server: server,
      lang: lang,
      url: 'https://' + server + '/wiki/' + encodeURIComponent(title.replace(/ /g, '_'))
    };
  }

  function parseWmSearch(raw, ctx) {
    var nowMs = (ctx && isNum(ctx.now)) ? ctx.now : NaN;
    if (raw && raw.idle) {
      return {
        t: nowMs, mode: EDIT_MODE.poll, idle: true, edits: [], count: 0,
        wikis: [], offline: [], resolutionMs: EDIT_RESOLUTION_MS.poll
      };
    }
    var j = jsonOf(raw, 'wm_search');
    if (!j || !isArr(j.wikis)) throw new Error('wm_search: no wiki results');
    var edits = [], seen = {}, wikis = [], offline = [];
    for (var i = 0; i < j.wikis.length; i++) {
      var w = j.wikis[i];
      if (!w || !w.lang) continue;
      if (!w.ok) { offline.push(w.lang); continue; }
      wikis.push(w.lang);
      var qy = w.body && w.body.query;
      if (!qy) continue;
      var groups = [['search', 'search'], ['recentchanges', 'recentchanges']];
      for (var g = 0; g < groups.length; g++) {
        var rows = qy[groups[g][0]];
        if (!isArr(rows)) continue;
        for (var r = 0; r < rows.length; r++) {
          var row = pollEditRow(w.lang, rows[r], groups[g][1], ctx);
          if (!row || seen[row.id]) continue;
          seen[row.id] = 1;
          edits.push(row);
        }
      }
    }
    if (!wikis.length) throw new Error('wm_search: every wiki refused the query');
    edits.sort(function (a, b) { return b.t - a.t; });
    if (!isFinite(nowMs)) nowMs = edits.length ? edits[0].t : NaN;
    if (!isFinite(nowMs)) throw new Error('wm_search: no usable timestamp');
    return {
      t: nowMs,
      mode: EDIT_MODE.poll,
      edits: edits,
      count: edits.length,
      wikis: wikis,
      offline: offline,
      tokens: isArr(j.tokens) ? j.tokens.slice() : [],
      eventId: j.eventId || null,
      resolutionMs: EDIT_RESOLUTION_MS.poll
    };
  }

  /*
   * Who gets the expensive mode. Saving data is an explicit request not to spend it, and a
   * small coarse-pointer screen is a phone, where a few megabytes a minute is somebody's
   * plan. Both go straight to polling; everybody else streams the first 15 minutes.
   */
  function streamAllowed(envIn) {
    var e = envIn || {};
    if (e.saveData) return false;
    if (e.coarsePointer && isNum(e.viewportMin) && e.viewportMin < 768) return false;
    return true;
  }

  function editMode(elapsedMs, opts) {
    var o = opts || {};
    if (o.streamOk === false) return EDIT_MODE.poll;
    if (!isNum(elapsedMs) || elapsedMs < 0) return EDIT_MODE.poll;
    var win = isNum(o.streamMaxMs) ? o.streamMaxMs : WM_STREAM_MAX_MS;
    return elapsedMs < win ? EDIT_MODE.stream : EDIT_MODE.poll;
  }

  function editFeedFor(mode) {
    return mode === EDIT_MODE.stream ? EDIT_FEED.stream : EDIT_FEED.poll;
  }

  /* The browser reading of streamAllowed's inputs, kept in one place so the page and the
     stopwatch cannot disagree about what counts as a phone. */
  function streamEnv() {
    var out = { saveData: false, coarsePointer: false, viewportMin: NaN };
    try {
      var c = global.navigator && global.navigator.connection;
      out.saveData = !!(c && c.saveData);
      if (typeof global.matchMedia === 'function') {
        out.coarsePointer = !!global.matchMedia('(pointer: coarse)').matches;
      }
      if (isNum(global.innerWidth) && isNum(global.innerHeight)) {
        out.viewportMin = Math.min(global.innerWidth, global.innerHeight);
      }
    } catch (e) { /* no window, defaults stand */ }
    return out;
  }

  /* ================================================================== 10. Pageviews */

  var WM_PV_BASE = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/';
  var pvTarget = null;
  var wmUaWorks = null;    /* null unknown, true header accepted, false fell back */

  function setPageviewTarget(target) {
    if (!target) { pvTarget = null; return null; }
    var article = target.article;
    if (typeof article !== 'string' || !article) throw new Error('pageview target needs an article');
    pvTarget = {
      project: target.project || 'en.wikipedia',
      article: article,
      fromDay: target.fromDay || null,
      toDay: target.toDay || null,
      sinceMs: isNum(target.sinceMs) ? target.sinceMs : null
    };
    return pvTarget;
  }

  function pageviewTarget() { return pvTarget; }

  function dayStamp(ms) {
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate());
  }

  function pageviewUrl(target, nowMs) {
    var to = target.toDay || dayStamp(nowMs);
    var from = target.fromDay || dayStamp(nowMs - 30 * 86400000);
    return WM_PV_BASE + encodeURIComponent(target.project) + '/all-access/all-agents/' +
      encodeURIComponent(target.article.replace(/ /g, '_')) + '/daily/' + from + '00/' + to + '00';
  }

  /*
   * Wikimedia asks browser clients for an Api-User-Agent header. A CORS preflight for it
   * answered 405 when measured, which would block the request outright, so the header is
   * tried first and a failure retries without it. Which path worked is reported by
   * ObsFeeds.wmUaState so a browser test can record the truth rather than guess.
   */
  function wmFetch(url) {
    function plain() {
      return httpFetch(url).then(function (res) { wmUaWorks = false; return res; });
    }
    if (wmUaWorks === false) return plain();
    return httpFetch(url, { headers: { 'Api-User-Agent': WM_UA } }).then(function (res) {
      wmUaWorks = true;
      return res;
    }, function () { return plain(); });
  }

  function fetchPageviews() {
    var target = pvTarget;
    if (!target) return Promise.resolve({ idle: true });
    var url = pageviewUrl(target, Date.now());
    return wmFetch(url).then(function (res) {
      if (res && res.status === 404) return { nodata: true, article: target.article, project: target.project };
      okOrThrow(res, url);
      return res.text().then(function (text) {
        var out = jsonOf(text, 'wm_pageviews');
        out.__article = target.article;
        out.__project = target.project;
        try { Object.defineProperty(out, 'byteLength', { value: text.length, enumerable: false }); }
        catch (e) { /* byte accounting only */ }
        return out;
      });
    });
  }

  /*
   * Daily granularity is all this API offers for a single article (hourly is refused with
   * an explicit allowed-values error), so the surge number here is a day against the
   * median of the days before it, and it can only land once the day is counted.
   */
  function parsePageviews(raw, ctx) {
    var now = (ctx && isNum(ctx.now)) ? ctx.now : NaN;
    if (raw && raw.idle) return { t: now, idle: true, article: null, days: [], granularity: 'daily' };
    if (raw && raw.nodata) {
      return {
        t: now, nodata: true, article: raw.article || null, project: raw.project || null,
        days: [], granularity: 'daily'
      };
    }
    var j = jsonOf(raw, 'wm_pageviews');
    if (!j || !isArr(j.items)) throw new Error('wm_pageviews: no items');
    var days = [], article = j.__article || null, project = j.__project || null;
    for (var i = 0; i < j.items.length; i++) {
      var it = j.items[i];
      if (!it) continue;
      var stamp = String(it.timestamp || '');
      if (stamp.length < 8) continue;
      var ms = Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8));
      var v = num(it.views, NaN);
      if (!isFinite(ms) || !isFinite(v)) continue;
      days.push({ day: stamp.slice(0, 8), t: ms, views: v });
      if (!article && it.article) article = it.article;
      if (!project && it.project) project = it.project;
    }
    if (!days.length) throw new Error('wm_pageviews: no usable day rows');
    days.sort(function (a, b) { return a.t - b.t; });
    var latest = days[days.length - 1];
    var prior = days.slice(0, -1).map(function (d) { return d.views; });
    var med = prior.length ? median(prior) : NaN;
    return {
      t: isFinite(now) ? now : latest.t,
      article: article,
      project: project,
      days: days,
      latest: latest,
      medianPrior: med,
      ratio: (isFinite(med) && med > 0) ? latest.views / med : NaN,
      granularity: 'daily'
    };
  }

  /* ================================================================== 11-14. Antenna routes */

  /*
   * Row layout written by antenna/worker.js planeRow. Fixed order, so read it through
   * these names rather than counting commas.
   */
  var PLANE_IDX = {
    lat: 0, lon: 1, altFt: 2, gsKt: 3, trackDeg: 4,
    tasKt: 5, magHdgDeg: 6, nacP: 7, nic: 8, wdDeg: 9, wsKt: 10,
    /* r12: present only on a row the relay flagged (an emergency string, or one of
       the three emergency squawk codes). A row of the old eleven columns is normal
       and not an error; these come back null. */
    emergency: 11, squawk: 12, flight: 13
  };

  /* The three codes the antenna flags. A code is a SETTING, not a confirmed
     emergency; every sentence about one has to say so. */
  var EMERGENCY_SQUAWKS = ['7500', '7600', '7700'];
  var SQUAWK_MEANING = {
    '7500': 'unlawful interference',
    '7600': 'lost radio',
    '7700': 'general emergency'
  };

  /* The winds instrument only looks above this altitude, and asking the antenna to trim
     the rows is the difference between about 250 KB and about 90 KB per poll. */
  var PLANES_MIN_ALT_FT = 27000;

  function planeObj(row) {
    if (!isArr(row)) return null;
    var alt = num(row[PLANE_IDX.altFt], NaN);
    if (!isFinite(alt)) return null;     /* alt_baro was the string "ground", or missing */
    var lat = num(row[PLANE_IDX.lat], NaN), lon = num(row[PLANE_IDX.lon], NaN);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    if (lat < -90 || lat > 90) return null;
    return {
      lat: lat, lon: wrapLon(lon), altFt: alt,
      gsKt: num(row[PLANE_IDX.gsKt], NaN),
      trackDeg: num(row[PLANE_IDX.trackDeg], NaN),
      tasKt: num(row[PLANE_IDX.tasKt], NaN),
      magHdgDeg: num(row[PLANE_IDX.magHdgDeg], NaN),
      nacP: num(row[PLANE_IDX.nacP], NaN),
      nic: num(row[PLANE_IDX.nic], NaN),
      wdDeg: num(row[PLANE_IDX.wdDeg], NaN),
      wsKt: num(row[PLANE_IDX.wsKt], NaN),
      emergency: strOrNull(row[PLANE_IDX.emergency]),
      squawk: strOrNull(row[PLANE_IDX.squawk]),
      flight: strOrNull(row[PLANE_IDX.flight])
    };
  }

  function strOrNull(v) {
    return (typeof v === 'string' && v) ? v : null;
  }

  function planesUrl(base) {
    var url = base + '?min_alt=' + PLANES_MIN_ALT_FT;
    var core = global.ObsCore;
    var prev = (core && typeof core.data === 'function') ? core.data('planes') : null;
    if (prev && isNum(prev.t)) url += '&since=' + prev.t;
    return url;
  }

  function fetchPlanes(url) {
    return fetchText(planesUrl(url)).then(function (text) {
      var out = jsonOf(text, 'planes');
      try { Object.defineProperty(out, 'byteLength', { value: text.length, enumerable: false }); }
      catch (e) { /* byte accounting only */ }
      return out;
    });
  }

  /* 2026-10-12 (antenna-ondemand): the antenna asked its collector for a fresh aircraft sample that has
     not landed yet (/planes and /jam carry `refresh: {requestedAt, snapshotT}` while it is in flight).
     The antenna's own clock at its answer (the snapshot's t plus the age it served) is kept beside the
     moment this page read it, so obs-instruments.js measures how long ago the sample was asked for
     without setting this machine's clock against the antenna's. Null when the answer carries none,
     which is how a landed sample, an expired request and an older antenna all read. */
  function refreshOf(j, now) {
    var r = j && j.refresh;
    if (!r || typeof r !== 'object' || !isNum(r.requestedAt)) return null;
    return {
      requestedAt: r.requestedAt,
      snapshotT: isNum(r.snapshotT) ? r.snapshotT : NaN,
      serverNow: (isNum(j.t) && isNum(j.ageMs)) ? j.t + j.ageMs : NaN,
      checkedAt: isNum(now) ? now : NaN
    };
  }

  function parsePlanes(raw, ctx) {
    var j = jsonOf(raw, 'planes');
    if (!j || typeof j !== 'object') throw new Error('planes: not an object');
    var now = (ctx && isNum(ctx.now)) ? ctx.now : NaN;
    /* The snapshot only changes once per cron, so an unchanged answer keeps what we hold. */
    if (j.unchanged && ctx && ctx.prev && ctx.prev.tiles) {
      var keep = {};
      for (var f in ctx.prev) keep[f] = ctx.prev[f];
      keep.ageMs = num(j.ageMs, keep.ageMs);
      keep.checkedAt = now;
      /* antenna-ondemand: the short answer says whether a fresh sample is on its way, every time */
      keep.refresh = refreshOf(j, now);
      return keep;
    }
    if (!isArr(j.tiles)) throw new Error('planes: no tiles');
    var t = num(j.t, NaN);
    if (!isFinite(t)) throw new Error('planes: no snapshot time');
    var tiles = [], samples = [], ok = 0, ground = 0, dropped = 0;
    for (var i = 0; i < j.tiles.length; i++) {
      var tile = j.tiles[i];
      if (!tile) continue;
      var rows = isArr(tile.planes) ? tile.planes : [];
      var planes = [];
      for (var k = 0; k < rows.length; k++) {
        var p = planeObj(rows[k]);
        if (!p) { dropped++; continue; }
        p.tile = i;
        planes.push(p);
        samples.push(p);
      }
      if (tile.ok) ok++;
      ground += num(tile.ground, 0);
      tiles.push({
        clat: num(tile.clat, NaN), clon: num(tile.clon, NaN),
        region: tile.region || '', ok: !!tile.ok, src: tile.src || null,
        err: tile.err || tile.err2 || null,
        /* 2026-10-11 (antenna-fix): the FALLBACK source's error too, and the
           status numbers a newer antenna stores beside them, so whoever reads
           the snapshot can tell a refusal (403, 429) from an outage.
           obs-instruments.js relayReach reads all four. */
        err2: tile.err2 || null,
        status: isNum(tile.status) ? tile.status : null,
        status2: isNum(tile.status2) ? tile.status2 : null,
        total: num(tile.total, NaN), ground: num(tile.ground, 0),
        planes: planes
      });
    }
    return {
      t: t,
      checkedAt: now,
      ageMs: num(j.ageMs, NaN),
      stale: !!j.stale,
      distNm: num(j.distNm, NaN),
      tilesOk: num(j.tilesOk, ok),
      tilesTotal: num(j.tilesTotal, tiles.length),
      minAltFt: num(j.minAlt, NaN),
      tiles: tiles,
      samples: samples,
      count: samples.length,
      ground: ground,
      dropped: dropped,
      refresh: refreshOf(j, now)
    };
  }

  function parseJam(raw, ctx) {
    var j = jsonOf(raw, 'jam');
    if (!j || !isArr(j.bins)) throw new Error('jam: no bins');
    var t = num(j.t, NaN);
    if (!isFinite(t)) throw new Error('jam: no aggregate time');
    var bins = [], n1 = 0, low1 = 0;
    for (var i = 0; i < j.bins.length; i++) {
      var b = j.bins[i];
      if (!b || b.length < 6) continue;
      var lat = num(b[0], NaN), lon = num(b[1], NaN);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      var n = num(b[2], 0), low = num(b[3], 0);
      bins.push({
        lat: lat, lon: wrapLon(lon),
        n1h: n, nLow1h: low,
        n24h: num(b[4], 0), nLow24h: num(b[5], 0),
        badFrac1h: n > 0 ? low / n : NaN,
        badFrac24h: num(b[4], 0) > 0 ? num(b[5], 0) / num(b[4], 0) : NaN
      });
      n1 += n; low1 += low;
    }
    return {
      t: t,
      ageMs: num(j.ageMs, NaN),
      stale: !!j.stale,
      binDeg: num(j.binDeg, 2),
      buckets: num(j.buckets, 0),
      hours: num(j.hours, 0),
      bins: bins,
      planes1h: n1,
      low1h: low1,
      checkedAt: (ctx && isNum(ctx.now)) ? ctx.now : NaN,
      refresh: refreshOf(j, (ctx && isNum(ctx.now)) ? ctx.now : NaN)
    };
  }

  function parseTfrs(raw, ctx) {
    var j = jsonOf(raw, 'tfrs');
    if (!j || !isArr(j.items)) throw new Error('tfrs: no items');
    var t = num(j.t, NaN);
    if (!isFinite(t)) throw new Error('tfrs: no list time');
    var items = [], byId = {};
    for (var i = 0; i < j.items.length; i++) {
      var it = j.items[i];
      if (!it || !it.id) continue;
      var c = it.center;
      var lat = (c && isNum(c[0])) ? c[0] : NaN;
      var lon = (c && isNum(c[1])) ? wrapLon(c[1]) : NaN;
      var shapes = [];
      var raws = isArr(it.shapes) ? it.shapes : [];
      for (var k = 0; k < raws.length; k++) {
        var s = raws[k];
        if (!s) continue;
        if (s.kind === 'poly' && s.pts && s.pts.length > 2) {
          var pts = [];
          for (var v = 0; v < s.pts.length; v++) {
            var pt = s.pts[v];
            if (pt && isNum(pt[0]) && isNum(pt[1])) pts.push([pt[0], wrapLon(pt[1])]);
          }
          if (pts.length > 2) shapes.push({ kind: 'poly', pts: pts });
        } else if (s.kind === 'circle' && isNum(s.lat) && isNum(s.lon) && isNum(s.radiusNm)) {
          shapes.push({ kind: 'circle', lat: s.lat, lon: wrapLon(s.lon), radiusNm: s.radiusNm });
        }
      }
      items.push({
        id: it.id, type: it.type || '', facility: it.facility || '', state: it.state || '',
        description: it.description || '', created: it.created || null,
        lat: lat, lon: lon, shapes: shapes, approx: !!it.approx,
        geoSource: it.geoSource || null, effective: it.effective || null,
        expire: it.expire || null, city: it.city || null, purpose: it.purpose || null
      });
      byId[it.id] = 1;
    }
    var newIds = [];
    if (ctx && ctx.prev && ctx.prev.items) {
      var had = {};
      for (i = 0; i < ctx.prev.items.length; i++) had[ctx.prev.items[i].id] = 1;
      for (i = 0; i < items.length; i++) if (!had[items[i].id]) newIds.push(items[i].id);
    }
    return {
      t: t,
      ageMs: num(j.ageMs, NaN),
      stale: !!j.stale,
      items: items,
      count: items.length,
      newIds: newIds,
      first: !(ctx && ctx.prev)
    };
  }

  /* Normalized tfr_new event. Only a TFR we can place is worth flying to. */
  function tfrEvent(item, nowMs) {
    if (!item || !isFinite(item.lat) || !isFinite(item.lon)) return null;
    var t = isNum(nowMs) ? nowMs : NaN;
    var eff = item.effective ? parseIsoMs(item.effective) : NaN;
    if (isFinite(eff)) t = eff;
    if (!isFinite(t)) return null;
    var where = item.city || item.state || 'the United States';
    return {
      id: 'tfr:' + item.id,
      cls: 'tfr_new',
      t: t,
      lat: item.lat,
      lon: item.lon,
      mag: null,
      label: (item.type || 'Airspace') + ' restriction ' + where,
      meta: {
        type: item.type || '', state: item.state || '', approx: !!item.approx,
        purpose: item.purpose || null, expire: item.expire || null, notam: item.id
      }
    };
  }

  function parseNotams(raw, ctx) {
    var j = jsonOf(raw, 'gps_notams');
    if (!j || typeof j !== 'object') throw new Error('gps_notams: not an object');
    if (j.offline) return { t: (ctx && isNum(ctx.now)) ? ctx.now : NaN, offline: true, items: [], count: 0 };
    if (!isArr(j.items)) throw new Error('gps_notams: no items');
    var t = num(j.t, NaN);
    if (!isFinite(t)) throw new Error('gps_notams: no sweep time');
    var items = [];
    for (var i = 0; i < j.items.length; i++) {
      var it = j.items[i];
      if (!it) continue;
      var c = it.center;
      items.push({
        number: it.number || '', classification: it.classification || '',
        location: it.location || '',
        lat: (c && isNum(c[0])) ? c[0] : NaN,
        lon: (c && isNum(c[1])) ? wrapLon(c[1]) : NaN,
        radiusNm: num(it.radiusNm, NaN),
        start: it.start || null, end: it.end || null,
        startMs: parseIsoMs(it.start), endMs: parseIsoMs(it.end),
        text: it.text || ''
      });
    }
    return {
      t: t, offline: false, ageMs: num(j.ageMs, NaN), stale: !!j.stale,
      items: items, count: items.length,
      sweptPoints: num(j.sweptPoints, NaN), gridSize: num(j.gridSize, NaN)
    };
  }

  /* ================================================================== 15. Open-Meteo */

  var OM_URL = 'https://api.open-meteo.com/v1/forecast';
  var OM_LEVELS = [300, 250, 200];
  /*
   * The same sample centres the antenna flies over, so one batched request covers every
   * tile the winds instrument can have data for. Copied from antenna/worker.js TILES; if
   * that list changes, this one has to change with it. 2026-10-11 (antenna-hourly): the
   * antenna dropped Lapland (65, 25), Mesopotamia (33.3, 44.4) and northern Andes (4.7, -74.1),
   * and so does this list.
   */
  var OM_SITES = [
    [51, 3], [55, 20.5], [44, 33], [37.5, 25], [40, -3.5],
    [33.5, 35], [26, 52],
    [41, -74], [33.5, -84.5], [41.9, -87.6], [32.8, -96.8], [36.5, -119.5], [47.6, -122.3],
    [37.5, 127], [35.7, 139.7], [24.5, 120], [1.35, 103.8],
    [-23.5, -46.6],
    [-33.9, 151.2], [-37, 175],
    [-26.1, 28]
  ];

  function openMeteoUrl(sites) {
    var list = sites || OM_SITES;
    var lat = [], lon = [], vars = [];
    for (var i = 0; i < list.length; i++) { lat.push(list[i][0]); lon.push(list[i][1]); }
    for (i = 0; i < OM_LEVELS.length; i++) {
      vars.push('wind_speed_' + OM_LEVELS[i] + 'hPa');
      vars.push('wind_direction_' + OM_LEVELS[i] + 'hPa');
    }
    return OM_URL + '?latitude=' + lat.join(',') + '&longitude=' + lon.join(',') +
      '&hourly=' + vars.join(',') + '&forecast_days=2&timezone=GMT';
  }

  /* ---- r27b, SEAM C-R27B-6: the OTHER arm of the fixture switch ----------

     PIN Z3-R27-FIX arms a recorded GRID, and C measured what my own note
     claimed was nothing: a harness lane with the grid armed still sent one
     request to the forecast service, for the sample centres this feed reads
     (24 then, OM_SITES' 21 since 2026-10-11). A few dozen locations against
     the grid's 576 is the smaller part by far, but it is not zero, and a
     round whose lanes are supposed to cost the address's daily allowance
     nothing cannot leave it spending them every lane.

     The same law as the grid's arm, for the same reasons: only an init script
     can set it (nothing the served page does reaches it), the recording is
     the API's own answer and is never shifted in time, and `omSitesFixture()`
     publishes that a recording is what was read so no surface can print it as
     a live reading. With nothing armed this is the byte the network path
     always was. */
  var sitesFixture = null;
  function setOmSitesFixture(x) {
    sitesFixture = x || null;
    return !!sitesFixture;
  }
  function sitesFixtureNow() {
    if (sitesFixture) return sitesFixture;
    var g = null;
    try { g = global.__OBS_OM_FIX || null; } catch (e) { g = null; }
    return g;
  }
  function omSitesFixture() { return !!sitesFixtureNow(); }

  function fetchOpenMeteo() {
    var fix = sitesFixtureNow();
    if (fix) {
      /* a recording, handed over whole. A string is the recorded body; an
         array or an object is the parsed answer. */
      return Promise.resolve(typeof fix === 'string' ? jsonOf(fix, 'openmeteo') : fix);
    }
    return fetchText(openMeteoUrl()).then(function (text) {
      var out = jsonOf(text, 'openmeteo');
      if (out && typeof out === 'object') {
        try { Object.defineProperty(out, 'byteLength', { value: text.length, enumerable: false }); }
        catch (e) { /* byte accounting only */ }
      }
      return out;
    });
  }

  var KMH_PER_KT = 1.852;

  /*
   * Meteorological direction is where the wind comes FROM, so the vector it carries points
   * the other way: u east, v north, both in knots.
   */
  function windUv(speedKt, fromDeg) {
    var r = fromDeg * Math.PI / 180;
    return { u: -speedKt * Math.sin(r), v: -speedKt * Math.cos(r) };
  }

  function parseOpenMeteo(raw, ctx) {
    var j = jsonOf(raw, 'openmeteo');
    var list = isArr(j) ? j : [j];
    if (!list.length || !list[0]) throw new Error('openmeteo: empty response');
    var sites = [], now = (ctx && isNum(ctx.now)) ? ctx.now : NaN;
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var h = s && s.hourly;
      if (!h || !h.time || !h.time.length) continue;
      var times = new Float64Array(h.time.length);
      for (var k = 0; k < h.time.length; k++) times[k] = parseIsoMs(h.time[k]);
      var levels = {};
      for (var L = 0; L < OM_LEVELS.length; L++) {
        var hPa = OM_LEVELS[L];
        var sp = h['wind_speed_' + hPa + 'hPa'];
        var di = h['wind_direction_' + hPa + 'hPa'];
        if (!sp || !di) continue;
        var kt = new Float32Array(sp.length), deg = new Float32Array(di.length);
        for (k = 0; k < sp.length; k++) kt[k] = num(sp[k], NaN) / KMH_PER_KT;
        for (k = 0; k < di.length; k++) deg[k] = num(di[k], NaN);
        levels[hPa] = { kt: kt, deg: deg };
      }
      sites.push({
        index: isNum(s.location_id) ? s.location_id : i,
        lat: num(s.latitude, NaN), lon: wrapLon(num(s.longitude, NaN)),
        times: times, levels: levels
      });
    }
    if (!sites.length) throw new Error('openmeteo: no site had hourly winds');
    var t0 = sites[0].times.length ? sites[0].times[0] : now;
    return {
      t: isFinite(now) ? now : t0,
      issuedAt: t0,
      sites: sites,
      levels: OM_LEVELS.slice(),
      attribution: 'Weather data by Open-Meteo.com'
    };
  }

  /* Nearest hour, no interpolation: the forecast itself is hourly. */
  function omSample(site, hPa, tMs) {
    if (!site || !site.levels || !site.levels[hPa]) return null;
    var lv = site.levels[hPa], times = site.times;
    if (!times || !times.length) return null;
    var best = 0, bestD = Infinity;
    for (var i = 0; i < times.length; i++) {
      var d = Math.abs(times[i] - tMs);
      if (d < bestD) { bestD = d; best = i; }
    }
    var kt = lv.kt[best], deg = lv.deg[best];
    if (!isFinite(kt) || !isFinite(deg)) return null;
    var uv = windUv(kt, deg);
    return { t: times[best], speedKt: kt, fromDeg: deg, u: uv.u, v: uv.v, ageMs: bestD };
  }

  function nearestSite(data, lat, lon) {
    if (!data || !data.sites) return null;
    var best = null, bestD = Infinity;
    for (var i = 0; i < data.sites.length; i++) {
      var s = data.sites[i];
      var dLat = s.lat - lat;
      var dLon = wrapLon(s.lon - lon);
      var d = dLat * dLat + dLon * dLon * Math.cos(lat * Math.PI / 180) * Math.cos(lat * Math.PI / 180);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }


  /* ============================================ 15b. r27 (9): THE WIND LAYER'S
     GRID, FETCHED ONCE

     r26 (20) gave the layer its own sampling and it worked: a regular lattice
     of 200 or more cells is a field a streamline can curve through, where the
     residual cells (14 to 46 of them, scattered over one continent) were the
     three straight bars six panel rounds complained about.

     What it cost was the quota. That law refetched on every camera settlement
     and kept twelve framings for ten minutes, about 1,270 weighted calls an
     hour by this zone's own probe, and Open-Meteo answered 429 "Daily API
     request limit exceeded" to every request from this address for a day. A
     page that spends a shared free allowance in eight hours shows its second
     visitor no data, so the law was wrong and not the API.

     THE WEIGHT RULE, recorded from the API's own documentation (open-meteo.com
     /en/pricing, read 2026-09-19): "Typically, one API call corresponds to one
     HTTP API request", and "Requests for data covering more than 10 weather
     variables or extending over a period of more than 2 weeks for a single
     location are considered multiple API calls", counted fractionally (their
     example: 2 weeks of data with 15 variables is 1.5 calls). The free tier is
     600 calls a minute, 5,000 an hour, 10,000 a day, 300,000 a month. What the
     documentation does NOT publish is the weight of a MULTI-LOCATION request,
     so this file takes the conservative reading and counts EVERY LOCATION as
     one call. Two variables and one day are both inside the free allowances,
     so the weight of this page's whole wind layer is its location count.

     THE LAW (r27 ruling (9)). One fetch per page load of a ONE DAY HOURLY field
     at 250 hPa for a FIXED GLOBAL grid of 576 cells, interpolated in time for
     the rest of the session, never refetched while the tab lives, and cached in
     localStorage for three hours so a reload does not re-spend. 576 weighted
     calls a load, under the ruling's 600, and about 17 loads a day from one
     address before the daily allowance is gone (the cache makes a reload free,
     so that is 17 COLD loads). On a 429 nothing is drawn and the row says the
     allowance is spent, which is the honest state and not a defect.

     MEASURED against the real API before this was written, every arm with an
     Origin header (_tests/observatory/r27/z3/probe/om-probe27.json, 2026-09-19):

       3 locations, 24 hourly steps        200    2,490 B   1,624 ms  url   200 ch
       50 locations, 24 hourly steps       200   41,543 B     423 ms  url   859 ch
       192 locations, 24 hourly steps      200  161,214 B     782 ms  url 2,831 ch
       576 locations, 24 hourly steps      200  478,811 B   1,469 ms  url 7,795 ch

     So the whole grid is answered in ONE request in 1.5 s. It is asked for in
     six chunks of 96 anyway, for two measured reasons: a 7,795 character URL is
     close enough to the 8 KB request line limit that some proxies keep to risk
     a visitor getting a 414, and one chunk is one PARSE TASK, which is 11.6 ms
     at 96 locations against 28.2 at 192 and 85 for the lot. Chunking does not
     change the weight: the weight is the location count either way. The wire is
     deflate compressed by the server (the byte counts above are the decoded
     bodies).

     WHY A FIXED GLOBAL GRID rather than one that follows the camera: a grid
     that follows the camera is a grid that is fetched again every time the
     camera moves, which is the law that spent the quota. The cost of the fixed
     one is honest and visible: 10 degrees is coarse, so a close framing holds
     fewer cells than a far one (236 cells inside the horizon at the landing
     altitude, 56 at a 40 degree framing, 20 at 25 degrees). The page draws the
     cells it has and the note says one line per patch of sky. Nothing is
     interpolated ACROSS the grid to manufacture cells that were never fetched.
                                                                              */

  /* The grid law, unchanged from PIN Z3-S8 except that the step is now FIXED:
     a regular global lattice aligned so bi = floor((lat + 90) / step) and
     bj = floor((lon + 180) / step), the cell centre at (-90 + (bi + 0.5) * step,
     -180 + (bj + 0.5) * step), which is what binIndex and binCenter already do
     at 2.5 degrees. 10 degrees divides 360 exactly, so the longitude lattice
     tiles the planet and the cell at bj 0 is a neighbour of the last one. */
  var OM_GRID_STEP = 10;       /* r27 (9): the one step, chosen by the quota */
  var GRID_LAT_MAX = 84;       /* a lat/lon lattice degenerates past this */
  var GRID_HOURS = 24;         /* ruling (9): a one day hourly field */
  var GRID_MIN = 200;          /* the floor the bar names, on the visible hemisphere */
  var GRID_WEIGHT_CAP = 600;   /* ruling (9): weighted calls per page load */
  var OM_CHUNK = 96;           /* six requests, each URL about 1.4 KB */
  var GRID_LEVEL = 250;        /* the one level the page draws and every sentence names */
  /* The field is hourly, so the drawn instant moves in five minute steps: a
     step small enough that no reader sees the field jump and large enough that
     the renderer's cached band is rebuilt twelve times an hour rather than once
     a frame. A per second clock term in a band key is what r24 measured as a
     parked page rebuilding every band once a second. */
  var GRID_SLOT_MS = 300000;
  var GRID_CACHE_KEY = 'obs-wind-grid-v2';
  var GRID_CACHE_MS = 10800000;   /* ruling (9): three hours across reloads */
  /* Written when a wave is about to leave, like the launch feed's quota stamp,
     so a reload storm cannot re-spend the allowance while the first wave is
     still in flight or has just failed. */
  var GRID_TRY_KEY = 'obs-wind-try-v2';
  var GRID_TRY_MS = 600000;
  /* A 429 stands the whole layer down, across reloads, until Retry-After says
     otherwise or an hour has passed. An hour rather than a day: the allowance
     resets on the service's own clock and a page that refuses to ask again for
     a whole day would keep saying "spent" long after it was not. */
  var GRID_SPENT_KEY = 'obs-wind-spent-v2';
  var GRID_BACKOFF_MS = 3600000;

  /* the level index the grid's cells carry, inside the OM_LEVELS list the
     primitive publishes, so the renderer's own level pick lands on it without a
     special case */
  function gridLevelIdx() {
    var i = OM_LEVELS.indexOf(GRID_LEVEL);
    return i < 0 ? 0 : i;
  }

  /* The angular distance from a centre, in degrees, on the sphere. */
  function gridAngDeg(lat0, lon0, lat, lon) {
    var d = Math.PI / 180;
    var s = Math.sin(lat0 * d) * Math.sin(lat * d) +
            Math.cos(lat0 * d) * Math.cos(lat * d) * Math.cos((lon - lon0) * d);
    if (s > 1) s = 1; if (s < -1) s = -1;
    return Math.acos(s) * 180 / Math.PI;
  }

  /*
   * globalGrid(step, latMax) -> { step, n, pts, lat, lon, bi, bj, nBinI, nBinJ, key }
   *
   * The whole planet at one step, poles dropped. Pure: no clock, no network, no
   * module state, no view. The view is gone on purpose (ruling (9)): a plan that
   * depends on the camera is a plan that is fetched again when the camera moves.
   */
  function globalGrid(step, latMax) {
    var st = isNum(step) && step > 0 ? step : OM_GRID_STEP;
    var mx = isNum(latMax) ? latMax : GRID_LAT_MAX;
    var rows = Math.round(180 / st), cols = Math.round(360 / st);
    var lat = [], lon = [], bi = [], bj = [], i, j, la;
    for (i = 0; i < rows; i++) {
      la = -90 + (i + 0.5) * st;
      if (la > mx || la < -mx) continue;
      for (j = 0; j < cols; j++) {
        lat.push(la); lon.push(-180 + (j + 0.5) * st); bi.push(i); bj.push(j);
      }
    }
    var n = lat.length, pts = new Float32Array(n * 2);
    for (i = 0; i < n; i++) { pts[i * 2] = lat[i]; pts[i * 2 + 1] = lon[i]; }
    return { step: st, n: n, pts: pts, lat: lat, lon: lon, bi: bi, bj: bj,
             nBinI: rows, nBinJ: cols,
             key: 'g' + st + '|' + mx + '|' + n };
  }

  /*
   * capCount(plan, lat, lon, radiusDeg) -> how many of the plan's cells lie
   * inside that cap. The bar ruling (9) sets is on the VISIBLE hemisphere, and
   * this is what measures it. Pure.
   */
  function capCount(plan, lat, lon, radiusDeg) {
    if (!plan || !plan.n) return 0;
    var r = isNum(radiusDeg) ? radiusDeg : 90, n = 0, i;
    for (i = 0; i < plan.n; i++) {
      if (gridAngDeg(lat, lon, plan.pts[i * 2], plan.pts[i * 2 + 1]) <= r) n++;
    }
    return n;
  }

  /* The request for ONE chunk of the plan: one level, two variables, a day of
     hours, unix seconds because they are shorter on the wire than ISO strings
     and there is no timezone to get wrong. */
  function omGridUrl(lat, lon, hours) {
    var h = isNum(hours) ? hours : GRID_HOURS;
    return OM_URL + '?latitude=' + lat.join(',') + '&longitude=' + lon.join(',') +
      '&hourly=wind_speed_' + GRID_LEVEL + 'hPa,wind_direction_' + GRID_LEVEL + 'hPa' +
      '&forecast_hours=' + h + '&timeformat=unixtime&timezone=GMT';
  }

  /*
   * parseOmGrid(raw, ctx) -> { n, H, lat, lon, times, kt, deg, ok, dropped }
   *
   * One chunk's response into flat arrays, in the chunk's own order. The whole
   * hourly SERIES is kept, location major (`i * H + h`), because ruling (9)
   * interpolates it in time for the rest of the session rather than asking
   * again. `times` is the hour grid in ms, taken from the first record that
   * carries one; a record whose own grid is a different length is dropped and
   * counted rather than lined up against the wrong hours.
   *
   * Pure: `ctx.now` is the clock and `raw` is the text or the parsed object.
   */
  function parseOmGrid(raw, ctx) {
    var j = (typeof raw === 'string') ? jsonOf(raw, 'om_grid') : raw;
    var list = isArr(j) ? j : [j];
    var out = { n: 0, H: 0, lat: null, lon: null, times: null,
                kt: null, deg: null, ok: false, dropped: 0 };
    var sp = 'wind_speed_' + GRID_LEVEL + 'hPa';
    var di = 'wind_direction_' + GRID_LEVEL + 'hPa';
    var i, k, s, h, t, tm, H = 0, v, w, bad;
    /* The rows are collected as typed arrays and joined once. Growing four
       plain arrays a value at a time cost 29 ms for 192 locations of a day
       each, measured, which is most of a long task for nothing: the shape is
       known as soon as the first record's hour grid is. */
    var rows = [], lats = [], lons = [], kt, deg;
    for (i = 0; i < list.length; i++) {
      s = list[i]; h = s && s.hourly;
      if (!h || !isArr(h.time) || !h.time.length || !h[sp] || !h[di]) { out.dropped++; continue; }
      if (!out.times) {
        t = [];
        for (k = 0; k < h.time.length; k++) {
          tm = h.time[k];
          /* unixtime seconds, and an ISO string if the request shape ever
             changes back, so the parser reads both rather than one */
          tm = (typeof tm === 'number') ? tm * 1000 : parseIsoMs(tm);
          if (!isNum(tm)) { t = null; break; }
          t.push(tm);
        }
        if (!t || !t.length) { out.dropped++; continue; }
        out.times = t;
        H = t.length;
      }
      if (h.time.length !== H) { out.dropped++; continue; }
      /* the two series are hoisted out of the hour loop: reading `h[sp]` by a
         computed key once per VALUE cost a quarter of this parser's time (37.9
         ms for 192 locations of a day against 28.2 with them hoisted, measured
         on the recorded answer; 96 locations parse in 11.6, which is why the
         chunk is 96 and not the whole grid) */
      var SP = h[sp], DI = h[di];
      if (!isArr(SP) || !isArr(DI) || SP.length < H || DI.length < H) { out.dropped++; continue; }
      kt = new Float32Array(H); deg = new Float32Array(H); bad = false;
      for (k = 0; k < H; k++) {
        v = num(SP[k], NaN); w = num(DI[k], NaN);
        if (!isNum(v) || !isNum(w)) { bad = true; break; }
        kt[k] = v / KMH_PER_KT; deg[k] = w;
      }
      if (bad) { out.dropped++; continue; }
      rows.push(kt); rows.push(deg);
      lats.push(num(s.latitude, NaN));
      lons.push(wrapLon(num(s.longitude, NaN)));
      out.n++;
    }
    out.H = H;
    if (out.n && H) {
      out.lat = new Float32Array(lats);
      out.lon = new Float32Array(lons);
      out.kt = new Float32Array(out.n * H);
      out.deg = new Float32Array(out.n * H);
      for (i = 0; i < out.n; i++) {
        out.kt.set(rows[i * 2], i * H);
        out.deg.set(rows[i * 2 + 1], i * H);
      }
    }
    out.ok = out.n > 0 && H > 0;
    return out;
  }

  /*
   * fieldAt(field, tMs) -> { u, v, kt, at, clamped, slot }
   *
   * The field's hourly series read at one instant, linearly between the two
   * hours that bracket it. The interpolation is on the VECTOR (u and v), not on
   * the speed and the bearing: a bearing crossing north would run the long way
   * round between 350 and 10 degrees, and the speed that comes back out of the
   * vector is the speed of the interpolated wind rather than an average of two
   * speeds. An instant outside the field is CLAMPED to its end and says so, so
   * a session that outlives its forecast draws the last hour it was given and
   * the readout's age says how old that is.
   *
   * Pure.
   */
  function fieldAt(field, tMs) {
    if (!field || !field.n || !field.H) return null;
    var H = field.H, n = field.n, ts = field.times;
    var t = isNum(tMs) ? tMs : ts[0];
    var h0 = 0, f = 0, clamped = 0, k;
    if (t <= ts[0]) { h0 = 0; f = 0; clamped = t < ts[0] ? -1 : 0; }
    else if (t >= ts[H - 1]) { h0 = H - 1; f = 0; clamped = t > ts[H - 1] ? 1 : 0; }
    else {
      for (k = 0; k < H - 1; k++) {
        if (t >= ts[k] && t < ts[k + 1]) {
          h0 = k;
          f = (ts[k + 1] - ts[k]) > 0 ? (t - ts[k]) / (ts[k + 1] - ts[k]) : 0;
          break;
        }
      }
    }
    var h1 = (h0 + 1 < H) ? h0 + 1 : h0;
    var u = new Float32Array(n), v = new Float32Array(n), kt = new Float32Array(n);
    var i, a, b, uu, vv;
    for (i = 0; i < n; i++) {
      a = i * H + h0; b = i * H + h1;
      uu = field.u[a] + (field.u[b] - field.u[a]) * f;
      vv = field.v[a] + (field.v[b] - field.v[a]) * f;
      u[i] = uu; v[i] = vv; kt[i] = Math.sqrt(uu * uu + vv * vv);
    }
    var at = ts[h0] + (ts[h1] - ts[h0]) * f;
    return { u: u, v: v, kt: kt, at: at, clamped: clamped,
             slot: Math.floor(at / GRID_SLOT_MS) };
  }

  /* ---- the service: one plan, one wave, one field, many instants -------- */

  var GRID = {
    plan: null,                /* the fixed global plan, built once */
    view: null,                /* the last framing the page handed over, recorded only */
    field: null,               /* the hourly field, the whole session's data */
    grid: null,                /* the instant the layer is drawing, published */
    slot: NaN,                 /* the five minute slot `grid` was built for */
    source: '',                /* 'live', 'cache' or 'fixture' */
    started: false,            /* windGridOnce has run */
    inFlight: false,
    waves: 0,                  /* fetch waves this page load: 1 is the law, 2 is a bug */
    calls: 0,                  /* http requests made */
    weighted: 0,               /* locations asked for, which is the weight */
    spentUntil: 0,             /* a 429 stands the layer down until this clock */
    err: '',                   /* the last failure's text, for classHealth */
    quota: false,              /* the failure was the allowance, not the network */
    tried: false,
    hadData: false,
    timer: null,
    cbs: []
  };

  /* the kernel's clock where there is one, and this module's own injected clock
     first, because the cache, the stand-down and the interpolation are all time
     laws and a suite has to be able to drive them */
  function gridNow() {
    if (injectedClock) return injectedClock();
    var c = global.ObsCore;
    return (c && typeof c.now === 'function') ? c.now() : Date.now();
  }

  function onWindGrid(fn) {
    if (typeof fn === 'function' && GRID.cbs.indexOf(fn) < 0) GRID.cbs.push(fn);
  }

  function gridPlanNow() {
    if (!GRID.plan) GRID.plan = globalGrid(OM_GRID_STEP, GRID_LAT_MAX);
    return GRID.plan;
  }

  function windGridData() {
    /* a reader asking between slots gets the instant that is drawn, and asking
       never starts a fetch: ruling (9)'s one wave is started by windGridOnce */
    if (GRID.field) publishSlot(gridNow(), false);
    return GRID.grid;
  }

  /* The shape classHealth reads, so a class whose input is this grid is
     answered in the same four fields a kernel feed answers with. `quota` is the
     fifth: ruling (9) gives the spent allowance its own sentence, and a
     surface may not invent that cause from an error string. */
  function windGridState() {
    var t = gridNow();
    var spent = GRID.quota && GRID.spentUntil > t;
    return { health: GRID.hadData ? 'live' : ((GRID.err || spent) ? 'offline' : 'idle'),
             reason: spent ? 'quota' : (GRID.err ? 'error' : ''),
             errText: GRID.err || (spent ? 'http 429 daily request limit' : ''),
             hadData: !!GRID.hadData,
             quota: !!spent,
             source: GRID.source,
             backoff: spent };
  }

  /* What the bar counts: one wave, 576 weighted calls, no refetch. */
  function windGridStats() {
    return { waves: GRID.waves, calls: GRID.calls, weighted: GRID.weighted,
             cap: GRID_WEIGHT_CAP, source: GRID.source,
             n: GRID.field ? GRID.field.n : 0,
             hours: GRID.field ? GRID.field.H : 0,
             started: GRID.started, inFlight: GRID.inFlight,
             quota: !!GRID.quota, spentUntil: GRID.spentUntil };
  }

  /* ---- the localStorage half: a reload inside three hours costs nothing --- */

  function gridCacheRead(now) {
    var s = storeOf();
    if (!s) return null;
    var txt;
    try { txt = s.getItem(GRID_CACHE_KEY); } catch (e) { return null; }
    if (typeof txt !== 'string' || !txt) return null;
    var o;
    try { o = JSON.parse(txt); } catch (e) { return null; }
    if (!o || !isNum(o.at) || !isNum(o.n) || !isArr(o.times) || !isArr(o.u)) return null;
    /* a clock that moved backwards must not pin a stale field in place */
    var age = now - o.at;
    if (!(age >= 0 && age < GRID_CACHE_MS)) return null;
    if (o.step !== OM_GRID_STEP || o.level !== GRID_LEVEL) return null;
    var H = o.times.length, n = o.n;
    if (!(n > 0) || !(H > 0) || o.u.length !== n * H || o.v.length !== n * H) return null;
    return { n: n, H: H, step: o.step,
             times: o.times.slice(),
             lat: new Float32Array(o.lat), lon: new Float32Array(o.lon),
             bi: new Int16Array(o.bi), bj: new Int16Array(o.bj),
             u: new Float32Array(o.u), v: new Float32Array(o.v),
             nBinI: o.nBinI, nBinJ: o.nBinJ,
             fetchedAt: o.at, chunks: o.chunks, failedChunks: o.failedChunks };
  }

  /* u and v are stored to a tenth of a knot. That is a storage precision and
     not a reading: a tenth of a knot is four thousandths of a pixel at this
     page's scale, and it keeps the whole field inside about 180 KB of a store
     that is allowed five megabytes. A store that refuses the write (full,
     private, blocked) costs the reload and nothing else. */
  function gridCacheWrite(field, now) {
    var s = storeOf();
    if (!s || typeof s.setItem !== 'function' || !field) return false;
    var u = [], v = [], i, N = field.n * field.H;
    for (i = 0; i < N; i++) {
      u.push(Math.round(field.u[i] * 10) / 10);
      v.push(Math.round(field.v[i] * 10) / 10);
    }
    var body = { at: now, n: field.n, step: field.step, level: GRID_LEVEL,
                 times: [].slice.call(field.times),
                 lat: [].slice.call(field.lat), lon: [].slice.call(field.lon),
                 bi: [].slice.call(field.bi), bj: [].slice.call(field.bj),
                 u: u, v: v, nBinI: field.nBinI, nBinJ: field.nBinJ,
                 chunks: field.chunks, failedChunks: field.failedChunks };
    try { s.setItem(GRID_CACHE_KEY, JSON.stringify(body)); }
    catch (e) { return false; }
    return true;
  }

  function gridStampRead(key, now) {
    var s = storeOf();
    if (!s) return NaN;
    var txt;
    try { txt = s.getItem(key); } catch (e) { return NaN; }
    if (typeof txt !== 'string' || !txt) return NaN;
    var t = +txt;
    if (!isNum(t)) return NaN;
    return t;
  }
  function gridStampWrite(key, t) {
    var s = storeOf();
    if (!s || typeof s.setItem !== 'function') return false;
    try { s.setItem(key, String(t)); } catch (e) { return false; }
    return true;
  }

  /* ---- publishing one instant ------------------------------------------ */

  function publishGrid(grid) {
    GRID.grid = grid;
    for (var i = 0; i < GRID.cbs.length; i++) {
      try { GRID.cbs[i](grid); } catch (e) { /* a consumer's throw is its own */ }
    }
  }

  /*
   * The field read at `t` and handed on, at most once per five minute slot.
   * `force` publishes even inside the slot, which is what a field landing does.
   */
  function publishSlot(t, force) {
    var field = GRID.field;
    if (!field) return false;
    var slot = Math.floor(t / GRID_SLOT_MS);
    if (!force && slot === GRID.slot && GRID.grid) return false;
    var cut = fieldAt(field, t);
    if (!cut) return false;
    GRID.slot = slot;
    var plan = gridPlanNow();
    var grid = { n: field.n, step: field.step,
                 level: String(GRID_LEVEL), lvi: gridLevelIdx(),
                 levels: OM_LEVELS.slice(),
                 lat: field.lat, lon: field.lon,
                 u: cut.u, v: cut.v, kt: cut.kt,
                 bi: field.bi, bj: field.bj,
                 nBinI: field.nBinI || plan.nBinI,
                 nBinJ: field.nBinJ || plan.nBinJ,
                 short: field.n < GRID_MIN,
                 chunks: field.chunks, failedChunks: field.failedChunks,
                 /* `t` is the instant DRAWN, so the readout's age is the age of
                    the reading and not the age of the request */
                 t: cut.at, fetchedAt: field.fetchedAt,
                 clamped: cut.clamped, slot: slot,
                 hours: field.H, source: GRID.source,
                 fixture: GRID.source === 'fixture',
                 key: plan.key + '|' + slot };
    publishGrid(grid);
    return true;
  }

  /* One timer, no network: the drawn instant walks forward with the session. */
  function startSlotTimer() {
    if (GRID.timer || typeof global.setInterval !== 'function') return;
    GRID.timer = global.setInterval(function () {
      if (!GRID.field) return;
      publishSlot(gridNow(), false);
    }, GRID_SLOT_MS);
    /* a node suite must not be held open by a five minute timer; browsers have
       no unref and are unaffected */
    if (GRID.timer && typeof GRID.timer.unref === 'function') GRID.timer.unref();
  }

  function holdField(field, source, now) {
    if (!field || !field.n) return false;
    GRID.field = field;
    GRID.source = source;
    GRID.hadData = true;
    GRID.err = '';
    GRID.quota = false;
    startSlotTimer();
    publishSlot(now, true);
    return true;
  }

  /* ---- the fixture switch, PIN Z3-R27-FIX ------------------------------- */

  /*
   * setWindFixture(x) arms a RECORDED grid in place of the network, so the drawn
   * form can be measured when the allowance is spent. `x` is the API's own
   * response (an array of records, or an object with `records`), or a URL
   * string the service fetches instead of Open-Meteo, or null to disarm. The
   * harness may also set `window.__OBS_WIND_FIX` before boot.
   *
   * The field it builds is a real recording, not a synthesis, and it is never
   * shifted in time: the readout's `source` says `fixture` and its age says how
   * old the recording is, so nothing on the page can read it as live.
   */
  var gridFixture = null;
  function setWindFixture(x) {
    gridFixture = x || null;
    return !!gridFixture;
  }
  function fixtureNow() {
    if (gridFixture) return gridFixture;
    var g = null;
    try { g = global.__OBS_WIND_FIX || null; } catch (e) { g = null; }
    return g;
  }

  /* ---- the one wave ----------------------------------------------------- */

  /*
   * windGridOnce() -> true when it holds a field or started the one wave.
   *
   * Ruling (9)'s whole law in one entry point, called when the layer is armed.
   * The ladder, in this order: a field already held; a fixture a harness armed
   * (before the cache, so a recorded grid is never quietly replaced by a stored
   * live one); the localStorage cache; a spent allowance remembered across
   * reloads; a wave that already left this page load or this address; then, and
   * only then, the network.
   */
  function windGridOnce() {
    var t = gridNow();
    /* a field already in hand is HANDED OVER AGAIN, because the call comes
       from the layer being armed and an instrument that was disarmed and armed
       again has lost the grid it was pushed. Waiting for the next five minute
       slot would leave it drawing nothing for up to five minutes, which is
       what the first fixture arm measured. */
    if (GRID.field) { publishSlot(t, true); return true; }
    if (GRID.inFlight) return true;
    var fix = fixtureNow();
    if (fix) return armFixture(fix, t);
    var cached = gridCacheRead(t);
    if (cached) {
      cached.step = cached.step || OM_GRID_STEP;
      GRID.started = true;
      return holdField(cached, 'cache', t);
    }
    /* the allowance, remembered across reloads so a refused page does not ask
       again on every visit inside the hour */
    var spent = gridStampRead(GRID_SPENT_KEY, t);
    if (isNum(spent) && spent > t && (spent - t) <= (GRID_BACKOFF_MS * 24)) {
      GRID.spentUntil = spent; GRID.quota = true; GRID.tried = true;
      GRID.started = true;
      return false;
    }
    if (GRID.started) return false;     /* one wave per page load, whatever happens */
    var last = gridStampRead(GRID_TRY_KEY, t);
    if (isNum(last) && (t - last) >= 0 && (t - last) < GRID_TRY_MS) {
      GRID.started = true;
      return false;
    }
    GRID.started = true;
    fetchWindGrid(gridPlanNow());
    return true;
  }

  function armFixture(fix, t) {
    GRID.started = true;
    if (typeof fix === 'string') {
      GRID.inFlight = true;
      fetchText(fix).then(function (text) {
        GRID.inFlight = false;
        takeFixture(text, gridNow());
      }, function (err) {
        GRID.inFlight = false;
        GRID.err = (err && err.message) ? String(err.message) : String(err || 'failed');
      });
      return true;
    }
    return takeFixture(fix, t);
  }

  function takeFixture(x, t) {
    var recs = isArr(x) ? x : (x && isArr(x.records) ? x.records : null);
    if (!recs && typeof x === 'string') {
      var j = null;
      try { j = JSON.parse(x); } catch (e) { j = null; }
      recs = isArr(j) ? j : (j && isArr(j.records) ? j.records : null);
    }
    if (!recs) { GRID.err = 'the wind fixture is not a recorded response'; return false; }
    var parsed = parseOmGrid(recs, { now: t });
    if (!parsed.ok) { GRID.err = 'the wind fixture carried no hourly field'; return false; }
    var plan = gridPlanNow();
    var field = fieldFrom([{ p: parsed, at: 0 }], plan, 1, 0, t);
    if (!field) { GRID.err = 'the wind fixture carried no hourly field'; return false; }
    return holdField(field, 'fixture', t);
  }

  /*
   * The parsed chunks into the session's field. `bi` and `bj` come from the
   * PLAN slot each cell was asked for (`bins`, or the answer's own order when
   * there is none), and `lat` and `lon` from the ANSWER (the model's own
   * nearest grid point, up to a twentieth of a degree from the centre asked
   * for), which is where the reading actually is.
   */
  function fieldFrom(parts, plan, chunks, failed, now) {
    var list = isArr(parts) ? parts : [], H = 0, n = 0, times = null, pi, p;
    for (pi = 0; pi < list.length; pi++) {
      p = list[pi] && list[pi].p;
      if (!p || !p.ok) continue;
      if (!times) { times = p.times; H = p.H; }
      if (p.H !== H) continue;
      n += p.n;
    }
    if (!n || !H) return null;
    var u = new Float32Array(n * H), v = new Float32Array(n * H);
    var lat = new Float32Array(n), lon = new Float32Array(n);
    var bi = new Int16Array(n), bj = new Int16Array(n);
    var w = 0, i, k, uv, at, base;
    for (pi = 0; pi < list.length; pi++) {
      p = list[pi] && list[pi].p;
      if (!p || !p.ok || p.H !== H) continue;
      base = isNum(list[pi].at) ? list[pi].at : 0;
      for (i = 0; i < p.n; i++) {
        lat[w] = p.lat[i]; lon[w] = p.lon[i];
        /* the lattice slot this answer was asked for. A chunk that answers
           short is matched by index from its own start, which is the order the
           API answers in. */
        at = base + i;
        bi[w] = (at < plan.n) ? plan.bi[at] : 0;
        bj[w] = (at < plan.n) ? plan.bj[at] : 0;
        for (k = 0; k < H; k++) {
          uv = windUv(p.kt[i * H + k], p.deg[i * H + k]);
          u[w * H + k] = uv.u; v[w * H + k] = uv.v;
        }
        w++;
      }
    }
    return { n: n, H: H, step: plan.step, times: [].slice.call(times),
             lat: lat, lon: lon, bi: bi, bj: bj, u: u, v: v,
             nBinI: plan.nBinI, nBinJ: plan.nBinJ,
             fetchedAt: now, chunks: chunks, failedChunks: failed };
  }

  function fetchWindGrid(plan) {
    var t0 = gridNow();
    GRID.inFlight = true;
    GRID.tried = true;
    GRID.waves++;
    gridStampWrite(GRID_TRY_KEY, t0);
    var nCh = Math.ceil(plan.n / OM_CHUNK), ci = 0, failed = 0, finished = false;
    /* the parsed chunks, each kept in the parser's own typed shape and joined
       ONCE when the wave is in. Copying value by value as each chunk landed
       cost 29 ms of a 37 ms parse task for 192 locations, measured. */
    var parts = [];

    function finish() {
      if (finished) return;
      finished = true;
      GRID.inFlight = false;
      var now = gridNow();
      var field = fieldFrom(parts, plan, nCh, failed, now);
      if (!field) {
        /* nothing landed: the row says no data about the input that failed and
           this page load does not ask again */
        return;
      }
      holdField(field, 'live', now);
      /* the cache write is a TASK OF ITS OWN: rounding 27,648 values and
         stringifying 145 KB is about 24 ms, measured, and the reader already
         has the field. Nothing waits for it. */
      later(function () { gridCacheWrite(field, now); });
    }

    function pump() {
      if (ci >= nCh) { finish(); return; }
      var a = ci * OM_CHUNK, b = Math.min(plan.n, a + OM_CHUNK);
      ci++;
      var la = [], lo = [], i;
      for (i = a; i < b; i++) { la.push(plan.pts[i * 2]); lo.push(plan.pts[i * 2 + 1]); }
      GRID.calls++;
      GRID.weighted += (b - a);
      fetchText(omGridUrl(la, lo, GRID_HOURS)).then(function (text) {
        /* one chunk, one parse, one task: the next chunk's parse is a separate
           turn of the event loop, which is ruling (13)'s long task clause */
        var parsed;
        try { parsed = parseOmGrid(text, { now: gridNow() }); } catch (e) { parsed = null; }
        if (parsed && parsed.ok) parts.push({ p: parsed, at: a }); else failed++;
        later(pump);
      }, function (err) {
        var msg = (err && err.message) ? String(err.message) : String(err || 'failed');
        failed++;
        /* ruling (9): a 429 is the ALLOWANCE and it stands the whole layer down,
           across reloads, so one refused chunk does not become three and a
           reload does not become six. Nothing here logs: the browser writes its
           own line for a refused request and no JavaScript can catch that one,
           so the only honest quiet is to stop asking. */
        if ((err && err.rateLimited) || /429|too many requests|daily .*limit/i.test(msg)) {
          GRID.quota = true;
          GRID.spentUntil = (err && isNum(err.retryAtMs)) ? err.retryAtMs
                                                          : (gridNow() + GRID_BACKOFF_MS);
          gridStampWrite(GRID_SPENT_KEY, GRID.spentUntil);
          ci = nCh;
        }
        if (!GRID.hadData) GRID.err = msg;
        later(pump);
      });
    }

    function later(fn) {
      var s = (typeof global.setTimeout === 'function') ? global.setTimeout : null;
      if (s) s(fn, 0); else fn();
    }

    pump();
    return true;
  }

  /*
   * setWindView(view) is kept and does NOTHING but remember the framing.
   *
   * Ruling (9) took the camera out of the fetch law: the grid is global, it is
   * fetched once, and a settled camera is no longer a reason to ask for
   * anything. The export stays so the page's own settlement handler cannot
   * throw, and it returns false because nothing was fetched.
   */
  function setWindView(view) {
    GRID.view = view || null;
    return false;
  }

  /* test seam: forget everything this service holds */
  function resetWindGrid() {
    if (GRID.timer && typeof global.clearInterval === 'function') {
      global.clearInterval(GRID.timer);
    }
    GRID.plan = null; GRID.view = null; GRID.field = null; GRID.grid = null;
    GRID.slot = NaN; GRID.source = ''; GRID.started = false; GRID.inFlight = false;
    GRID.waves = 0; GRID.calls = 0; GRID.weighted = 0; GRID.spentUntil = 0;
    GRID.err = ''; GRID.quota = false; GRID.tried = false; GRID.hadData = false;
    GRID.timer = null;
  }

  /* ================================================================== 16. NASA EONET

     Curated natural events. Measured live from this machine on 2026-08-25, every
     request carrying an Origin header:

       ?status=open&days=7                              95,244 bytes, 31 events
       ?status=open&category=<the four below>&days=7    35,906 bytes, what ships
       ?status=open  (no days at all)                4,926,454 bytes, never fetch

     Access-Control-Allow-Origin: *, and X-RateLimit-Limit: 60 an hour. One poll
     every 600 s spends 6 of those. Asking for gzip returns the same 35,906 bytes,
     so 36 KB really is the cost on the wire, and 0.21 MB an hour is what this feed
     adds to a visitor's budget.

     The four categories are the ones the tour narrates. seaLakeIce is deliberately
     left out: its events carry the longest tracks in the whole feed (62 daily
     points on one of them today) for the least the page could say about them.
     Volcanoes are usually EMPTY inside a 7 day window (none today, 4 inside 90
     days). That is the honest state of the feed on most days, and the card says so
     rather than widening the window until something turns up.                    */

  var EONET_BASE = 'https://eonet.gsfc.nasa.gov/api/v3/events';
  /*
   * r12 item 14. seaLakeIce is now IN: its events carry the longest tracks in the
   * feed, which used to be the reason to leave it out, and are the reason to want it
   * now that a track is decimated, measured and drawn. Measured live 2026-08-26 with
   * an Origin header: 98,416 bytes for 31 events (18 fires, 7 icebergs, 6 storms),
   * no gzip offered, so at the 600 s cadence this feed costs 0.59 MB an hour.
   */
  var EONET_CATS = ['wildfires', 'severeStorms', 'floods', 'seaLakeIce'];
  var EONET_DAYS = 7;
  var EONET_URL = EONET_BASE + '?status=open&category=' + EONET_CATS.join(',') +
                  '&days=' + EONET_DAYS;
  /*
   * Volcanoes are usually EMPTY inside a 7 day window and are not empty inside 90
   * (3 open today, 2,049 bytes). They get their own query at a low rate rather than
   * widening the main window, which would multiply every other category's payload.
   * One request per 30 minutes, so on the 600 s cadence five polls in six reuse the
   * answer and the feed's byte line stays honest.
   */
  var EONET_VOLC_CATS = ['volcanoes'];
  var EONET_VOLC_DAYS = 90;
  var EONET_VOLC_URL = EONET_BASE + '?status=open&category=' + EONET_VOLC_CATS.join(',') +
                       '&days=' + EONET_VOLC_DAYS;
  var EONET_VOLC_CADENCE_MS = 1800000;
  /* category id -> the class word the instrument, the markers and the tour use */
  var EONET_CLASS = {
    wildfires: 'fire', severeStorms: 'storm', volcanoes: 'volcano', floods: 'flood',
    seaLakeIce: 'ice'
  };
  var EONET_CAP = 120;          /* bound on a backfilled day */
  /* Track points kept per event. An iceberg carries 62 daily reports today; drawing
     all of them costs the renderer more than the shape is worth, and the travelled
     distance is measured over the FULL list before this decimation, never over the
     kept subset. */
  var EONET_TRACK_MAX = 30;
  /* The window "this week" means, measured back from the event's own newest report
     rather than from the wall clock, so a feed that paused for a day does not shrink
     the answer. */
  var EONET_RECENT_MS = 7 * 86400000;

  /*
   * The same great-circle distance ObsCore.PURE.haversineKm computes, on the same
   * radius. It is duplicated here rather than reached for, because a parser runs
   * before any instrument does and must not depend on the kernel being loaded.
   * t-feeds asserts the two agree; if one changes the other has to.
   */
  var EARTH_R_KM = 6371.0088;
  function haversineKm(lat1, lon1, lat2, lon2) {
    var D = Math.PI / 180;
    var p1 = lat1 * D, p2 = lat2 * D;
    var dp = (lat2 - lat1) * D, dl = (lon2 - lon1) * D;
    var s1 = Math.sin(dp / 2), s2 = Math.sin(dl / 2);
    var a = s1 * s1 + Math.cos(p1) * Math.cos(p2) * s2 * s2;
    return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /*
   * Every placeable geometry entry, oldest first, walked once: the distance is summed
   * over all of them and the kept points are an even stride through the list with the
   * first and the last always kept. Returns a flat [lat, lon, lat, lon, ...] array,
   * which is the shape the arcs primitive wants.
   */
  function eonetTrack(geoms, maxPts) {
    var pts = [], times = [], i, p;
    for (i = 0; i < geoms.length; i++) {
      p = eonetPoint(geoms[i]);
      if (!p) continue;
      pts.push(p);
      times.push(parseIsoMs(geoms[i].date));
    }
    /* Two distances, because they answer two questions. An iceberg tracked since
       2022 has travelled thousands of km over its whole life and a few hundred this
       week, and "has drifted N km this week" is the sentence the page wants; a storm
       that formed on Tuesday has only the one number and they agree. */
    var km = 0, recentKm = 0, recentPts = 0;
    var tLast = NaN;
    for (i = times.length - 1; i >= 0; i--) { if (isFinite(times[i])) { tLast = times[i]; break; } }
    var cut = isFinite(tLast) ? tLast - EONET_RECENT_MS : NaN;
    for (i = 1; i < pts.length; i++) {
      var seg = haversineKm(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
      km += seg;
      if (isFinite(cut) && isFinite(times[i]) && times[i] >= cut) { recentKm += seg; recentPts++; }
    }
    var cap = Math.max(2, maxPts | 0);
    var keep = [];
    if (pts.length <= cap) {
      for (i = 0; i < pts.length; i++) keep.push(pts[i].lat, pts[i].lon);
    } else {
      var step = (pts.length - 1) / (cap - 1);
      for (i = 0; i < cap; i++) {
        p = pts[Math.min(pts.length - 1, Math.round(i * step))];
        keep.push(p.lat, p.lon);
      }
    }
    var t0 = NaN, t1 = NaN;
    for (i = 0; i < times.length; i++) {
      if (!isFinite(times[i])) continue;
      if (!isFinite(t0)) t0 = times[i];
      t1 = times[i];
    }
    return {
      track: keep, points: pts.length, km: km,
      recentKm: recentKm, recentPoints: recentPts, recentMs: EONET_RECENT_MS,
      spanMs: (isFinite(t0) && isFinite(t1)) ? Math.max(0, t1 - t0) : NaN
    };
  }

  /*
   * One representative point per geometry entry. EONET writes GeoJSON coordinate
   * order, longitude first. A polygon is reduced to the mean of its ring, with the
   * longitudes folded relative to the FIRST vertex so a ring straddling the date
   * line averages to itself instead of to the far side of the planet.
   */
  function eonetPoint(g) {
    if (!g) return null;
    var c = g.coordinates;
    if (!isArr(c)) return null;
    if (g.type === 'Point') {
      if (!isNum(c[0]) || !isNum(c[1])) return null;
      if (c[1] < -90 || c[1] > 90) return null;
      return { lat: c[1], lon: wrapLon(c[0]), geom: 'point' };
    }
    var ring = c;
    /* Polygon is [ring], MultiPolygon is [[ring]]: walk down to the first ring */
    while (isArr(ring) && ring.length && isArr(ring[0]) && isArr(ring[0][0])) ring = ring[0];
    if (!isArr(ring) || !ring.length) return null;
    /* A GeoJSON ring closes on its first vertex, so the mean would count that
       corner twice and pull the point towards it. */
    var last = ring.length - 1;
    if (last > 0 && isArr(ring[0]) && isArr(ring[last]) &&
        ring[0][0] === ring[last][0] && ring[0][1] === ring[last][1]) last--;
    var lon0 = NaN, sLat = 0, sLon = 0, n = 0;
    for (var i = 0; i <= last; i++) {
      var p = ring[i];
      if (!isArr(p) || !isNum(p[0]) || !isNum(p[1])) continue;
      if (p[1] < -90 || p[1] > 90) continue;
      if (!isFinite(lon0)) lon0 = wrapLon(p[0]);
      sLat += p[1];
      sLon += lon0 + wrapLon(wrapLon(p[0]) - lon0);
      n++;
    }
    if (!n) return null;
    return { lat: sLat / n, lon: wrapLon(sLon / n), geom: 'polygon' };
  }

  /*
   * `t` is the time this LIST was retrieved, not the newest report in it. The
   * kernel measures staleness from t, and a wildfire whose last report is a day
   * old is a current open event, not a dead feed. The newest report time rides
   * alongside as `latest`, and each event carries its own.
   */
  /*
   * The volcano query is fetched at its own low rate and its answer held here, so a
   * poll that is not due one costs nothing. `volcAt` is a clock reading, so a clock
   * that moves backwards refetches rather than pinning a stale answer for ever.
   */
  var volcRaw = null, volcAt = NaN;

  function fetchEonet() {
    var now = clockNow();
    var dueVolc = !volcRaw || !isFinite(volcAt) || now < volcAt ||
                  (now - volcAt) >= EONET_VOLC_CADENCE_MS;
    var jobs = [fetchText(EONET_URL)];
    /* A volcano query that fails is not a reason to lose the main list: the whole
       feed would go stale over the least urgent quarter of it. */
    jobs.push(dueVolc ? fetchText(EONET_VOLC_URL).then(null, function () { return null; })
                      : Promise.resolve(null));
    return Promise.all(jobs).then(function (parts) {
      if (dueVolc && parts[1] !== null) { volcRaw = parts[1]; volcAt = clockNow(); }
      var out = { main: parts[0], volc: volcRaw,
                  volcAgeMs: isFinite(volcAt) ? (clockNow() - volcAt) : NaN };
      var bytes = parts[0].length + ((dueVolc && parts[1]) ? parts[1].length : 0);
      try { Object.defineProperty(out, 'byteLength', { value: bytes, enumerable: false }); }
      catch (e) { /* byte accounting only */ }
      return out;
    });
  }

  /* Test seam: the volcano cache is module state, and a suite that wants a cold one
     says so rather than reaching in. */
  function resetEonetVolcCache() { volcRaw = null; volcAt = NaN; }

  function eonetEventList(raw) {
    /* Two documents (the 7 day list and the 90 day volcano list) or one, because a
       direct caller and every fixture still hand over a single body. */
    if (raw && typeof raw === 'object' && !isArr(raw) &&
        (typeof raw.main === 'string' || typeof raw.volc === 'string')) {
      var a = raw.main ? jsonOf(raw.main, 'eonet') : null;
      var b = raw.volc ? jsonOf(raw.volc, 'eonet volcanoes') : null;
      var list = [];
      if (a && isArr(a.events)) list = list.concat(a.events);
      if (b && isArr(b.events)) list = list.concat(b.events);
      if (!a && !b) throw new Error('eonet: no events');
      return { events: list, volcAgeMs: num(raw.volcAgeMs, NaN) };
    }
    var j = jsonOf(raw, 'eonet');
    if (!j || !isArr(j.events)) throw new Error('eonet: no events');
    return { events: j.events, volcAgeMs: NaN };
  }

  function parseEonet(raw, ctx) {
    var j = eonetEventList(raw);
    var now = (ctx && isNum(ctx.now)) ? ctx.now : NaN;
    var out = [], latest = NaN, byClass = {}, skipped = 0, i, k;
    var seenId = {};
    for (i = 0; i < j.events.length && out.length < EONET_CAP; i++) {
      var e = j.events[i];
      /* The two queries overlap on nothing today, but an id that appeared in both
         would otherwise be two events in the same place. */
      if (e && e.id && seenId[e.id]) { skipped++; continue; }
      if (e && e.id) seenId[e.id] = 1;
      if (!e || typeof e.id !== 'string' || !e.id) { skipped++; continue; }
      if (e.closed) { skipped++; continue; }
      var cats = isArr(e.categories) ? e.categories : [];
      var cat = cats.length ? cats[0] : null;
      var catId = (cat && cat.id) ? String(cat.id) : '';
      /* The newest geometry entry we can place is where the event IS now: the
         array is a track, oldest first, one entry per report. */
      var geoms = isArr(e.geometry) ? e.geometry : [];
      var pt = null, gt = NaN, magV = NaN, magU = null;
      for (k = geoms.length - 1; k >= 0; k--) {
        pt = eonetPoint(geoms[k]);
        if (!pt) continue;
        gt = parseIsoMs(geoms[k].date);
        magV = num(geoms[k].magnitudeValue, NaN);
        magU = geoms[k].magnitudeUnit || null;
        break;
      }
      if (!pt) { skipped++; continue; }
      /* the FIRST report is when EONET started tracking this, which is a
         different sentence from when it last heard about it */
      var t0 = NaN;
      for (k = 0; k < geoms.length; k++) {
        t0 = parseIsoMs(geoms[k].date);
        if (isFinite(t0)) break;
      }
      var src = (isArr(e.sources) && e.sources[0]) ? e.sources[0] : null;
      var cls = EONET_CLASS[catId] || 'other';
      if (isFinite(gt) && (!isFinite(latest) || gt > latest)) latest = gt;
      byClass[cls] = (byClass[cls] || 0) + 1;
      var tr = eonetTrack(geoms, EONET_TRACK_MAX);
      out.push({
        id: e.id,
        title: e.title || '',
        cls: cls,
        catId: catId,
        catTitle: (cat && cat.title) ? cat.title : '',
        lat: pt.lat, lon: pt.lon, geom: pt.geom,
        /* `track` was the REPORT COUNT before r12 and still is, so nothing that
           already read it changes meaning; the path itself is trackPath. */
        track: geoms.length,
        trackPath: tr.track,
        trackPoints: tr.points,
        trackKm: tr.km,
        trackRecentKm: tr.recentKm,
        trackRecentPoints: tr.recentPoints,
        trackSpanMs: tr.spanMs,
        t: gt,
        t0: isFinite(t0) ? t0 : NaN,
        magValue: magV, magUnit: magU,
        source: src ? String(src.id || '') : '',
        sourceUrl: src ? (src.url || '') : '',
        link: e.link || ''
      });
    }
    /* newest report first, so a cap anywhere downstream keeps the live ones */
    out.sort(function (a, b) {
      var at = isFinite(a.t) ? a.t : -Infinity, bt = isFinite(b.t) ? b.t : -Infinity;
      return bt - at;
    });
    return {
      t: isFinite(now) ? now : latest,
      latest: latest,
      windowDays: EONET_DAYS,
      volcanoWindowDays: EONET_VOLC_DAYS,
      volcanoAgeMs: j.volcAgeMs,
      categories: EONET_CATS.concat(EONET_VOLC_CATS),
      events: out,
      count: out.length,
      byClass: byClass,
      skipped: skipped
    };
  }

  /* ================================================================== 17. Launch Library 2

     Measured live 2026-08-25 with an Origin header. access-control-allow-origin: *
     on both routes. mode=list is small but carries NO pad coordinates, provider or
     mission, so it cannot place a launch on the planet; mode=normal does, and the
     server gzips it:

       upcoming/?limit=12&mode=normal   121,559 raw   16,541 on the wire
       previous/?limit=6&mode=normal     68,175 raw    9,435 on the wire

     26 KB a refresh at 1200 s is 78 KB an hour. The Space Devs throttle anonymous
     clients at 15 requests an hour and each refresh spends 2 of them, so a visitor
     reloading the page repeatedly would burn the budget for everyone behind the
     same address. The cache below is what stops that: the raw bodies are kept in
     localStorage for exactly one cadence, so a reload inside 20 minutes re-parses
     what is already on the machine and makes no request at all.                  */

  var LL2_BASE = 'https://ll.thespacedevs.com/2.3.0/launches/';
  var LL2_UPCOMING_URL = LL2_BASE + 'upcoming/?limit=12&mode=normal';
  var LL2_PREVIOUS_URL = LL2_BASE + 'previous/?limit=6&mode=normal';
  var LL2_CACHE_KEY = 'obs-launches-v1';
  var LL2_CACHE_MS = 1200000;        /* one cadence, and no longer */
  /* r18 item 10: the stamp that makes the cadence a QUOTA rather than a cache.
     The body cache already spared a reload inside twenty minutes, but only
     when the last request SUCCEEDED: a 429 stored nothing, so every reload
     after it went straight back to the API and spent two more of the fifteen
     requests an hour this origin is allowed. The stamp is written when a
     request is about to leave, so the first request after a reload is gated
     too, and it lives in localStorage, which is per origin, so a visitor and
     a test run behind the same address share one budget. */
  var LL2_TRY_KEY = 'obs-launches-try-v1';
  /* status id -> a plain word. The API's own abbrev is the fallback. */
  var LL2_STATUS = {
    1: 'go', 2: 'to be determined', 3: 'successful', 4: 'failed',
    5: 'on hold', 6: 'in flight', 7: 'partly failed', 8: 'to be confirmed'
  };

  /*
   * Two seams the node suites drive: a clock (the cache law is a time law) and a
   * store. Reading global.localStorage can THROW rather than return null in a
   * locked-down browser profile, so every access is wrapped.
   */
  var injectedClock = null;
  function setClock(fn) { injectedClock = (typeof fn === 'function') ? fn : null; return injectedClock; }
  function clockNow() { return injectedClock ? injectedClock() : Date.now(); }

  var injectedStore = null;
  function setStore(s) { injectedStore = (s && typeof s.getItem === 'function') ? s : null; return injectedStore; }
  function storeOf() {
    if (injectedStore) return injectedStore;
    try { return global.localStorage || null; } catch (e) { return null; }
  }

  function launchCacheRead(now, maxAgeMs) {
    var s = storeOf();
    if (!s) return null;
    var txt;
    try { txt = s.getItem(LL2_CACHE_KEY); } catch (e) { return null; }
    if (typeof txt !== 'string' || !txt) return null;
    var o;
    try { o = JSON.parse(txt); } catch (e) { return null; }
    if (!o || !isNum(o.at)) return null;
    if (typeof o.upcoming !== 'string' || typeof o.previous !== 'string') return null;
    /* A clock that moved backwards must not pin a stale body in place for ever,
       so a negative age is refused as loudly as an expired one. */
    var age = now - o.at;
    var cap = isNum(maxAgeMs) ? maxAgeMs : LL2_CACHE_MS;
    if (!(age >= 0 && age < cap)) return null;
    return o;
  }

  function launchCacheWrite(now, up, prev) {
    var s = storeOf();
    if (!s || typeof s.setItem !== 'function') return false;
    try { s.setItem(LL2_CACHE_KEY, JSON.stringify({ at: now, upcoming: up, previous: prev })); }
    catch (e) { return false; }   /* full or blocked: the fetch still worked */
    return true;
  }

  /* r18 item 10: when this origin last let a launch request leave, and how
     long is left on its quota. A clock that moved backwards is refused the
     same way the body cache refuses it, so a wrong clock can never lock the
     feed out for ever. A store that is missing or throws answers "no lock",
     which leaves the feed behaving exactly as it did before the quota. */
  function launchTryRead(now) {
    var s = storeOf();
    if (!s) return NaN;
    var txt;
    try { txt = s.getItem(LL2_TRY_KEY); } catch (e) { return NaN; }
    if (typeof txt !== 'string' || !txt) return NaN;
    var t = +txt;
    if (!isNum(t) || !(now - t >= 0)) return NaN;
    return t;
  }
  function launchTryWrite(now) {
    var s = storeOf();
    if (!s || typeof s.setItem !== 'function') return false;
    try { s.setItem(LL2_TRY_KEY, String(now)); } catch (e) { return false; }
    return true;
  }
  function launchQuotaLeftMs(now) {
    var t = launchTryRead(now);
    if (!isNum(t)) return 0;
    var left = LL2_CACHE_MS - (now - t);
    return left > 0 ? left : 0;
  }

  /* A cache hit costs zero bytes, and says so, so the budget line stays true. */
  function launchRaw(up, prev, at, cached, stale) {
    var out = { upcoming: up, previous: prev, cachedAt: at,
                fromCache: !!cached, cacheStale: !!stale };
    try {
      Object.defineProperty(out, 'byteLength', {
        value: cached ? 0 : (up.length + prev.length), enumerable: false
      });
    } catch (e) { /* byte accounting only */ }
    return out;
  }

  /*
   * The API answers 429 to an anonymous client that has spent its 15 requests,
   * and the schedule it serves changes by the hour rather than the minute. So a
   * failed refresh falls back to the last body this browser stored, up to
   * LL2_STALE_MS old, rather than reporting the launch schedule as offline: a
   * three hour old list of upcoming launches is still true. The result says
   * cacheStale so the readout can name its age, and once the body is older than
   * that the failure IS reported and the kernel backs off.
   */
  var LL2_STALE_MS = 6 * 3600000;

  function fetchLaunches() {
    var now = clockNow();
    var hit = launchCacheRead(now, LL2_CACHE_MS);
    if (hit) return Promise.resolve(launchRaw(hit.upcoming, hit.previous, hit.at, true, false));
    /* r18 item 10. One request per cadence per origin, whatever the last one
       answered. A successful refresh never reaches here (its body is younger
       than the stamp, so the cache above serves it), so this gate only bites
       after a failure, which is exactly the case that used to spend the
       budget on every reload. The stale fallback below is untouched: a
       schedule a few hours old is still true, and it still says so. */
    if (launchQuotaLeftMs(now) > 0) {
      var held = launchCacheRead(now, LL2_STALE_MS);
      if (held) return Promise.resolve(launchRaw(held.upcoming, held.previous, held.at, true, true));
      /* r19 item 8: this is a rate limit we imposed on ourselves to keep the
         API's, and it knows exactly when it lifts, so it says so rather than
         reaching the page as an unexplained failure. */
      var qErr = new Error(
        'launches: this browser has already spent its launch request for this ' +
        Math.round(LL2_CACHE_MS / 60000) + ' minute window');
      qErr.rateLimited = true;
      qErr.retryAtMs = now + launchQuotaLeftMs(now);
      return Promise.reject(qErr);
    }
    launchTryWrite(now);
    return Promise.all([fetchText(LL2_UPCOMING_URL), fetchText(LL2_PREVIOUS_URL)])
      .then(function (parts) {
        var at = clockNow();
        launchCacheWrite(at, parts[0], parts[1]);
        return launchRaw(parts[0], parts[1], at, false, false);
      }, function (err) {
        var old = launchCacheRead(clockNow(), LL2_STALE_MS);
        if (!old) throw err;
        return launchRaw(old.upcoming, old.previous, old.at, true, true);
      });
  }

  function ll2Rows(raw, what) {
    if (raw === null || raw === undefined || raw === '') return [];
    var j = jsonOf(raw, what);
    if (isArr(j) && !j.results) return j;
    if (j && isArr(j.results)) return j.results;
    return [];
  }

  function launchRow(r) {
    if (!r || typeof r.id !== 'string' || !r.id) return null;
    var pad = r.pad || null;
    var loc = (pad && pad.location) ? pad.location : null;
    var lat = pad ? num(pad.latitude, NaN) : NaN;
    var lon = pad ? num(pad.longitude, NaN) : NaN;
    var placed = isNum(lat) && isNum(lon) && lat >= -90 && lat <= 90;
    var st = r.status || null;
    var sid = st ? num(st.id, NaN) : NaN;
    var lsp = r.launch_service_provider || null;
    var mis = r.mission || null;
    var cfg = (r.rocket && r.rocket.configuration) ? r.rocket.configuration : null;
    /* pad.country is an object in 2.3.0 and a bare code in older payloads */
    var ctry = '';
    if (pad && pad.country) ctry = (typeof pad.country === 'string') ? pad.country : (pad.country.name || '');
    return {
      id: r.id,
      name: r.name || '',
      net: parseIsoMs(r.net),
      netPrecision: (r.net_precision && r.net_precision.abbrev) ? r.net_precision.abbrev : null,
      windowStart: parseIsoMs(r.window_start),
      windowEnd: parseIsoMs(r.window_end),
      lastUpdated: parseIsoMs(r.last_updated),
      status: (isFinite(sid) && LL2_STATUS[sid]) ? LL2_STATUS[sid]
            : ((st && st.abbrev) ? String(st.abbrev).toLowerCase() : ''),
      statusId: isFinite(sid) ? sid : NaN,
      lat: placed ? lat : NaN,
      lon: placed ? wrapLon(lon) : NaN,
      placed: placed,
      pad: pad ? (pad.name || '') : '',
      place: loc ? (loc.name || '') : '',
      country: ctry,
      provider: lsp ? (lsp.abbrev || lsp.name || '') : '',
      providerName: lsp ? (lsp.name || '') : '',
      mission: mis ? (mis.name || '') : '',
      missionType: mis ? (mis.type || '') : '',
      orbit: (mis && mis.orbit) ? (mis.orbit.abbrev || mis.orbit.name || '') : '',
      rocket: cfg ? (cfg.full_name || cfg.name || '') : ''
    };
  }

  /*
   * The two routes OVERLAP: a launch that flew an hour ago is the first row of
   * both. Merged by id, first hit wins, and whether a row is upcoming is decided
   * by its own T-0 against the clock rather than by which list it arrived in.
   */
  function parseLaunches(raw, ctx) {
    var now = (ctx && isNum(ctx.now)) ? ctx.now : NaN;
    var up = [], prev = [], cachedAt = NaN, fromCache = false, cacheStale = false;
    if (raw && typeof raw === 'object' && (raw.upcoming !== undefined || raw.previous !== undefined)) {
      up = ll2Rows(raw.upcoming, 'launches');
      prev = ll2Rows(raw.previous, 'launches');
      cachedAt = num(raw.cachedAt, NaN);
      fromCache = !!raw.fromCache;
      cacheStale = !!raw.cacheStale;
    } else {
      up = ll2Rows(raw, 'launches');
    }
    if (!up.length && !prev.length) throw new Error('launches: no results');
    var seen = {}, out = [], dropped = 0, i;
    var all = up.concat(prev);
    for (i = 0; i < all.length; i++) {
      var row = launchRow(all[i]);
      if (!row) { dropped++; continue; }
      if (seen[row.id]) continue;
      seen[row.id] = 1;
      row.upcoming = isFinite(row.net) && isFinite(now) ? (row.net >= now) : false;
      out.push(row);
    }
    out.sort(function (a, b) {
      var at = isFinite(a.net) ? a.net : Infinity, bt = isFinite(b.net) ? b.net : Infinity;
      return at - bt;
    });
    var nUp = 0, nPlaced = 0;
    for (i = 0; i < out.length; i++) { if (out[i].upcoming) nUp++; if (out[i].placed) nPlaced++; }
    return {
      t: isFinite(now) ? now : cachedAt,
      cachedAt: cachedAt,
      fromCache: fromCache,
      cacheStale: cacheStale,
      cacheAgeMs: (isFinite(now) && isFinite(cachedAt)) ? (now - cachedAt) : NaN,
      launches: out,
      count: out.length,
      nUpcoming: nUp,
      nRecent: out.length - nUp,
      nPlaced: nPlaced,
      dropped: dropped
    };
  }

  /* ================================================================== 18. NOAA SWPC alerts

     services.swpc.noaa.gov/products/alerts.json, measured live 2026-08-25:
     46,600 bytes raw, 5,017 on the wire, Access-Control-Allow-Origin: *. 77
     bulletins, the oldest a few weeks back. At 300 s that is 60 KB an hour.

     A bulletin is a fixed-shape teleprinter message, not prose, and the visitor
     never sees it. What the page shows is a sentence DERIVED from the message
     code (ALTK05, WATA20, WARPX1 and friends), which is the part of the bulletin
     that is a controlled vocabulary. The structured NOAA Scale line is read as a
     second source when a code is not in the table, and a code neither the table
     nor that line can explain gets no sentence at all rather than a guess.      */

  var SWPC_ALERTS_URL = 'https://services.swpc.noaa.gov/products/alerts.json';
  var SWPC_ALERT_CAP = 80;

  var SWPC_KIND = { ALT: 'alert', WAR: 'warning', WAT: 'watch', SUM: 'summary' };

  /*
   * The subject half of the message code, as structured facts rather than text.
   * Kp 5 to 9 map onto G1 to G5, which is where the storm words come from.
   */
  var SWPC_SUBJECT = {
    K04: { category: 'geomagnetic', kp: 4 },
    K05: { category: 'geomagnetic', kp: 5 },
    K06: { category: 'geomagnetic', kp: 6 },
    K07: { category: 'geomagnetic', kp: 7 },
    K08: { category: 'geomagnetic', kp: 8 },
    K09: { category: 'geomagnetic', kp: 9 },
    A20: { category: 'geomagnetic', g: 1 },
    A30: { category: 'geomagnetic', g: 2 },
    A50: { category: 'geomagnetic', g: 3 },
    SUD: { category: 'geomagnetic', sudden: true },
    PX1: { category: 'proton', mev: 10, pfu: 10 },
    PX2: { category: 'proton', mev: 10, pfu: 100 },
    PX3: { category: 'proton', mev: 10, pfu: 1000 },
    PC0: { category: 'proton', mev: 100, pfu: 1 },
    XMF: { category: 'radio blackout', xray: 'M5' },
    XM5: { category: 'radio blackout', xray: 'M5' },
    XX1: { category: 'radio blackout', xray: 'X1' },
    XX2: { category: 'radio blackout', xray: 'X2' },
    TP2: { category: 'radio burst', radioType: 'II' },
    TP4: { category: 'radio burst', radioType: 'IV' },
    '10R': { category: 'radio burst', burstCm: 10 },
    EF3: { category: 'electron', mev: 2, pfu: 1000 }
  };

  var SWPC_SCALE_CAT = { G: 'geomagnetic', S: 'proton', R: 'radio blackout' };
  var SWPC_SCALE_NOUN = { G: 'geomagnetic storm', S: 'solar radiation storm', R: 'radio blackout' };
  var STORM_WORD = ['', 'minor', 'moderate', 'strong', 'severe', 'extreme'];

  var SWPC_MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
                      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  /* "2026 Aug 18 2042 UTC", the only time format inside a bulletin body. */
  function swpcTimeMs(s) {
    if (typeof s !== 'string' || !s) return NaN;
    var m = /^\s*(\d{4})\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2})(\d{2})(?:\s*UTC)?\s*$/.exec(s);
    if (!m) return parseIsoMs(s);
    var mo = SWPC_MONTHS[m[2].toLowerCase()];
    if (mo === undefined) return NaN;
    return Date.UTC(+m[1], mo, +m[3], +m[4], +m[5]);
  }

  var SWPC_FIELDS = {};
  function swpcField(msg, name) {
    var re = SWPC_FIELDS[name] ||
             (SWPC_FIELDS[name] = new RegExp('^[ \\t]*' + name + '[ \\t]*:[ \\t]*(.+)$', 'im'));
    var m = re.exec(msg);
    return m ? m[1].trim() : '';
  }

  function swpcScale(msg) {
    var v = swpcField(msg, 'Noaa Scale');
    if (!v) return null;
    var m = /^([GSR])\s*(\d)\s*(?:-\s*(.+))?$/.exec(v);
    if (!m) return null;
    return { letter: m[1], level: +m[2], word: m[3] ? m[3].trim().toLowerCase() : '' };
  }

  function stormWord(level) {
    return (level >= 1 && level <= 5) ? STORM_WORD[level] : '';
  }

  /*
   * ONE sentence, built from the structured facts above. Never the bulletin.
   * Returns null when nothing in the message is understood well enough to say
   * something true, and the instrument then leaves that bulletin alone.
   */
  function swpcSummary(kind, subj, scale) {
    var expects = (kind === 'warning' || kind === 'watch');
    var g, w;
    if (subj && isNum(subj.kp)) {
      g = subj.kp - 4;
      w = stormWord(g);
      if (g >= 1) {
        return expects
          ? 'NOAA expects the planetary K index to reach ' + subj.kp + ', a G' + g + ' ' + w + ' geomagnetic storm.'
          : 'The planetary K index reached ' + subj.kp + ', a G' + g + ' ' + w + ' geomagnetic storm.';
      }
      return expects
        ? 'NOAA expects the planetary K index to reach ' + subj.kp + ', active but still below storm level.'
        : 'The planetary K index reached ' + subj.kp + ', active but still below storm level.';
    }
    if (subj && isNum(subj.g)) {
      w = stormWord(subj.g);
      return 'NOAA forecasters expect a G' + subj.g + ' ' + w + ' geomagnetic storm.';
    }
    if (subj && subj.sudden) {
      return expects
        ? 'NOAA expects a sudden jolt in the Earth\'s magnetic field as a solar wind shock arrives.'
        : 'A sudden jolt in the Earth\'s magnetic field was measured, which is usually a solar wind shock arriving.';
    }
    if (subj && subj.category === 'proton') {
      return (expects ? 'NOAA expects solar protons above ' : 'Solar protons above ') + subj.mev +
             ' MeV to pass ' + subj.pfu + ' particle flux units, which can black out radio over the poles.';
    }
    if (subj && subj.category === 'radio blackout' && subj.xray) {
      return expects
        ? 'NOAA expects X-ray flux to pass ' + subj.xray + ', enough to black out shortwave radio on the day side.'
        : 'X-ray flux passed ' + subj.xray + ', enough to black out shortwave radio on the day side.';
    }
    if (subj && subj.radioType) {
      return 'A type ' + subj.radioType + ' radio burst was recorded, which is the signature of a shock wave leaving the sun.';
    }
    if (subj && isNum(subj.burstCm)) {
      return 'A ' + subj.burstCm + ' cm radio burst was recorded, which can add noise to radar and satellite reception.';
    }
    if (subj && subj.category === 'electron') {
      return 'The ' + subj.mev + ' MeV electron flux passed ' + subj.pfu +
             ' particle flux units, which is a charging risk for satellites.';
    }
    if (scale && SWPC_SCALE_NOUN[scale.letter]) {
      w = scale.word || stormWord(scale.level);
      return 'NOAA rated this a ' + scale.letter + scale.level + (w ? ' ' + w : '') + ' ' +
             SWPC_SCALE_NOUN[scale.letter] + '.';
    }
    return null;
  }

  function swpcAlert(a) {
    if (!a || typeof a.message !== 'string' || !a.message) return null;
    var msg = a.message;
    var mc = /Space Weather Message Code:\s*([A-Z0-9]+)/i.exec(msg);
    var code = mc ? mc[1].toUpperCase() : '';
    var kind = code ? (SWPC_KIND[code.slice(0, 3)] || '') : '';
    var subj = code ? (SWPC_SUBJECT[code.slice(3)] || null) : null;
    var scale = swpcScale(msg);

    /* The one line that classifies the bulletin, kept for the card's list and
       for the CANCEL check. It is never the visitor-facing sentence. */
    var lines = msg.split(/\r?\n/), headline = '', variant = null, i;
    for (i = 0; i < lines.length; i++) {
      var L = lines[i].trim();
      if (/^(ALERT|WARNING|WATCH|SUMMARY|CONTINUED|EXTENDED|CANCEL|CORRECTED)\b/i.test(L)) { headline = L; break; }
    }
    var vm = /^(CONTINUED|EXTENDED|CANCEL|CORRECTED)\b/i.exec(headline);
    if (vm) variant = vm[1].toLowerCase();

    var serial = swpcField(msg, 'Serial Number');
    var issued = parseIsoMs(a.issue_datetime);
    if (!isFinite(issued)) issued = swpcTimeMs(swpcField(msg, 'Issue Time'));
    var validFrom = swpcTimeMs(swpcField(msg, 'Valid From'));
    var validTo = swpcTimeMs(swpcField(msg, 'Valid To'));
    var begin = swpcTimeMs(swpcField(msg, 'Begin Time'));

    var category = (subj && subj.category) ||
                   (scale ? (SWPC_SCALE_CAT[scale.letter] || 'other') : 'other');
    return {
      id: 'swpc:' + (code || String(a.product_id || '?')) + ':' + (serial || String(issued)),
      code: code,
      productId: a.product_id ? String(a.product_id) : '',
      serial: serial,
      kind: kind || 'alert',
      variant: variant,
      cancelled: variant === 'cancel',
      category: category,
      known: !!subj,
      summary: swpcSummary(kind || 'alert', subj, scale),
      scale: scale ? (scale.letter + scale.level) : null,
      scaleWord: scale ? scale.word : '',
      issued: issued,
      begin: begin,
      validFrom: validFrom,
      validTo: validTo,
      headline: headline
    };
  }

  /*
   * Is this bulletin speaking about now? Its own window when it has one, and
   * otherwise a bounded age from when it was issued, because a bulletin with no
   * "Valid To" is not a licence to keep announcing it for ever.
   */
  function swpcActive(rec, nowMs, maxAgeMs) {
    if (!rec || !isNum(nowMs)) return false;
    if (rec.cancelled) return false;
    var from = isFinite(rec.validFrom) ? rec.validFrom
             : (isFinite(rec.begin) ? rec.begin : rec.issued);
    if (isFinite(from) && nowMs < from) return false;
    if (isFinite(rec.validTo)) return nowMs <= rec.validTo;
    if (!isFinite(rec.issued)) return false;
    return (nowMs - rec.issued) <= num(maxAgeMs, 86400000);
  }

  function parseSwpcAlerts(raw, ctx) {
    var j = jsonOf(raw, 'swpc_alerts');
    if (!isArr(j)) throw new Error('swpc_alerts: expected an array');
    var now = (ctx && isNum(ctx.now)) ? ctx.now : NaN;
    var out = [], latest = NaN, unknown = 0, i;
    for (i = 0; i < j.length; i++) {
      var rec = swpcAlert(j[i]);
      if (!rec) continue;
      if (!rec.known) unknown++;
      if (isFinite(rec.issued) && (!isFinite(latest) || rec.issued > latest)) latest = rec.issued;
      out.push(rec);
    }
    if (!out.length) throw new Error('swpc_alerts: nothing parsed');
    out.sort(function (p, q) {
      var pt = isFinite(p.issued) ? p.issued : -Infinity;
      var qt = isFinite(q.issued) ? q.issued : -Infinity;
      return qt - pt;
    });
    if (out.length > SWPC_ALERT_CAP) out.length = SWPC_ALERT_CAP;
    return {
      t: isFinite(now) ? now : latest,
      latest: latest,
      alerts: out,
      count: out.length,
      unknown: unknown
    };
  }

  /* ================================================================== 19. SondeHub

     Weather balloons, live. Measured live 2026-08-26 with an Origin header:
     access-control-allow-origin: *, 23,367 bytes raw and 4,534 on the wire once
     gzipped, for 38 balloons. At the 300 s cadence that is 0.05 MB an hour.

     Licence: the SondeHub API wiki states Creative Commons BY-SA 2.0, and their
     documentation asks clients not to poll the telemetry route hard. The `?last=`
     route is the cheap one and 300 s is well inside what they ask for. The
     attribution string below is the one the card prints; it is not optional.

     The response is an OBJECT keyed by serial, one latest frame per balloon, so
     there is no history here and no way to say where a balloon has been. Every
     state below is derived from the single frame it carries, and the card says so. */

  var SONDEHUB_URL = 'https://api.v2.sondehub.org/sondes?last=3600';
  var SONDEHUB_WINDOW_S = 3600;
  var SONDEHUB_ATTRIB = 'SondeHub and the volunteer radiosonde receivers, CC BY-SA 2.0';
  var SONDEHUB_CAP = 200;

  /* Thresholds for the four states. A balloon climbs at 4 to 6 m/s and falls under
     its parachute at 5 to 10, so a metre a second is comfortably outside the noise
     on a good frame and is the line between climbing and drifting. */
  var SONDE_RISE_MS = 1;
  var SONDE_APOGEE_M = 20000;    /* below this, a still balloon is drifting, not at its top */
  var SONDE_LAND_M = 5000;

  function sondeState(altM, velV) {
    if (!isFinite(velV)) return 'unknown';
    if (velV >= SONDE_RISE_MS) return 'rising';
    if (velV <= -SONDE_RISE_MS) {
      return (isFinite(altM) && altM < SONDE_LAND_M) ? 'landing' : 'falling';
    }
    /* Neither climbing nor falling. High up that is the top of the flight, which is
       where the balloon bursts; low down it is a balloon on the ground or a frame
       with no useful vertical rate, and neither is worth a word. */
    return (isFinite(altM) && altM >= SONDE_APOGEE_M) ? 'bursting' : 'unknown';
  }

  function parseSondehub(raw, ctx) {
    var j = jsonOf(raw, 'sondehub');
    if (!j || typeof j !== 'object' || isArr(j)) throw new Error('sondehub: not an object');
    var now = (ctx && isNum(ctx.now)) ? ctx.now : NaN;
    var out = [], dropped = 0;
    var byState = { rising: 0, bursting: 0, falling: 0, landing: 0, unknown: 0 };
    var highest = null, fastest = null, newest = NaN;
    for (var serial in j) {
      if (!Object.prototype.hasOwnProperty.call(j, serial)) continue;
      if (out.length >= SONDEHUB_CAP) break;
      var f = j[serial];
      if (!f || typeof f !== 'object') { dropped++; continue; }
      var lat = num(f.lat, NaN), lon = num(f.lon, NaN), alt = num(f.alt, NaN);
      if (!isFinite(lat) || !isFinite(lon) || !isFinite(alt)) { dropped++; continue; }
      if (lat < -90 || lat > 90) { dropped++; continue; }
      var velV = num(f.vel_v, NaN);
      var tMs = parseIsoMs(f.datetime);
      if (!isFinite(tMs)) tMs = parseIsoMs(f.time_received);
      if (isFinite(tMs) && (!isFinite(newest) || tMs > newest)) newest = tMs;
      /* 65535 is the "no burst timer" sentinel the RS41 transmits. */
      var burst = num(f.burst_timer, NaN);
      if (!isFinite(burst) || burst >= 65535 || burst < 0) burst = NaN;
      var st = sondeState(alt, velV);
      byState[st]++;
      var s = {
        serial: String(f.serial || serial),
        lat: lat, lon: wrapLon(lon), altM: alt,
        velVMs: velV, velHMs: num(f.vel_h, NaN),
        tempC: num(f.temp, NaN), pressureHPa: num(f.pressure, NaN),
        burstTimerS: burst,
        type: f.type ? String(f.type) : '',
        manufacturer: f.manufacturer ? String(f.manufacturer) : '',
        freqMHz: num(f.frequency, NaN),
        tMs: tMs, state: st
      };
      /* The upstream names as well as ours, because the autopilot reads
         `alt`, `vel_v` and `temp` straight off these rows (r12 INTERFACES,
         zone K3). Same numbers, two spellings, one source of truth. */
      s.alt = alt; s.vel_v = velV; s.temp = s.tempC;
      out.push(s);
      if (!highest || s.altM > highest.altM) highest = s;
      if (isFinite(s.velVMs) && (!fastest || s.velVMs > fastest.velVMs)) fastest = s;
    }
    if (fastest && !(fastest.velVMs >= SONDE_RISE_MS)) fastest = null;
    return {
      t: isFinite(now) ? now : newest,
      newest: newest,
      windowS: SONDEHUB_WINDOW_S,
      sondes: out,
      count: out.length,
      byState: byState,
      highest: highest,
      fastestRise: fastest,
      dropped: dropped,
      attribution: SONDEHUB_ATTRIB
    };
  }

  /* ================================================================== 20. GDACS

     The Global Disaster Alert and Coordination System event list, run jointly by the
     European Commission's Joint Research Centre and UN OCHA. Measured live
     2026-08-26 with an Origin header: access-control-allow-origin: *, 14,829 bytes
     for a three-day window (98 events over the unbounded default, at 139 KB, for the
     same three current ones). At the 900 s cadence the windowed form costs 0.06 MB
     an hour. No gzip is offered, so the raw figure is the wire figure.

     HONESTY, and it rides with every sentence: the GDACS alert level is a MODELLED
     estimate of likely humanitarian impact, not an observation of one. Green, Orange
     and Red are what a model expects, and the page must never present one as a
     measured severity.

     `iscurrent` arrives as the STRING "true" or "false" and most of the list is
     false: the window has closed on those events, which is exactly why they are
     filtered out rather than narrated in the present tense. */

  var GDACS_URL = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH';
  var GDACS_WINDOW_DAYS = 7;
  var GDACS_CAP = 120;
  var GDACS_TYPE = {
    EQ: { cls: 'quake', name: 'Earthquake' },
    TC: { cls: 'storm', name: 'Tropical cyclone' },
    FL: { cls: 'flood', name: 'Flood' },
    WF: { cls: 'fire', name: 'Wildfire' },
    DR: { cls: 'drought', name: 'Drought' },
    VO: { cls: 'volcano', name: 'Volcano' }
  };
  var GDACS_LEVELS = ['Green', 'Orange', 'Red'];

  function ymd(ms) {
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
  }

  function gdacsUrl(nowMs) {
    var now = isNum(nowMs) ? nowMs : clockNow();
    return GDACS_URL + '?fromDate=' + ymd(now - GDACS_WINDOW_DAYS * 86400000) +
           '&toDate=' + ymd(now + 86400000);
  }

  function fetchGdacs() {
    var url = gdacsUrl(clockNow());
    return fetchText(url).then(function (text) {
      var out = jsonOf(text, 'gdacs');
      try { Object.defineProperty(out, 'byteLength', { value: text.length, enumerable: false }); }
      catch (e) { /* byte accounting only */ }
      return out;
    });
  }

  /* GDACS writes its dates without a zone. They are UTC; parseIsoMs already treats a
     bare stamp that way, which is the one place this file's parser and the feed agree
     by design rather than by luck. */
  function parseGdacs(raw, ctx) {
    var j = jsonOf(raw, 'gdacs');
    if (!j || !isArr(j.features)) throw new Error('gdacs: no features');
    var now = (ctx && isNum(ctx.now)) ? ctx.now : NaN;
    var out = [], nCurrent = 0, skipped = 0;
    var byLevel = {}, byType = {};
    for (var i = 0; i < j.features.length && out.length < GDACS_CAP; i++) {
      var f = j.features[i];
      var p = f && f.properties;
      if (!p) { skipped++; continue; }
      var g = f.geometry && f.geometry.coordinates;
      var lon = isArr(g) ? num(g[0], NaN) : NaN;
      var lat = isArr(g) ? num(g[1], NaN) : NaN;
      if (!isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90) { skipped++; continue; }
      var type = String(p.eventtype || '').toUpperCase();
      var meta = GDACS_TYPE[type];
      if (!meta) { skipped++; continue; }
      var level = String(p.alertlevel || '');
      if (GDACS_LEVELS.indexOf(level) < 0) level = '';
      /* the string, not a boolean: see the note above */
      var current = String(p.iscurrent) === 'true';
      var sev = p.severitydata || {};
      var countries = [];
      if (isArr(p.affectedcountries)) {
        for (var k = 0; k < p.affectedcountries.length && countries.length < 8; k++) {
          var c = p.affectedcountries[k];
          if (c && c.countryname) countries.push(String(c.countryname));
        }
      }
      if (current) nCurrent++;
      byLevel[level || 'unknown'] = (byLevel[level || 'unknown'] || 0) + 1;
      byType[type] = (byType[type] || 0) + 1;
      out.push({
        id: 'gdacs:' + type + ':' + String(p.eventid),
        eventId: String(p.eventid),
        episodeId: (p.episodeid === null || typeof p.episodeid === 'undefined')
          ? null : String(p.episodeid),
        type: type,
        typeName: meta.name,
        cls: meta.cls,
        name: p.eventname ? String(p.eventname) : '',
        title: p.name ? String(p.name) : (p.description ? String(p.description) : ''),
        lat: lat, lon: wrapLon(lon),
        alertLevel: level,
        alertScore: num(p.alertscore, NaN),
        severity: num(sev.severity, NaN),
        severityText: sev.severitytext ? String(sev.severitytext).trim() : '',
        severityUnit: sev.severityunit ? String(sev.severityunit) : '',
        countries: countries,
        country: p.country ? String(p.country) : '',
        current: current,
        fromMs: parseIsoMs(p.fromdate),
        toMs: parseIsoMs(p.todate),
        modifiedMs: parseIsoMs(p.datemodified),
        reportUrl: (p.url && p.url.report) ? String(p.url.report) : ''
      });
    }
    return {
      t: isFinite(now) ? now : NaN,
      events: out,
      count: out.length,
      nCurrent: nCurrent,
      byLevel: byLevel,
      byType: byType,
      windowDays: GDACS_WINDOW_DAYS,
      skipped: skipped
    };
  }

  /* ================================================================== 21. NWS alerts

     Active severe weather warnings from the United States National Weather Service.
     Measured live 2026-08-26 with an Origin header: access-control-allow-origin: *,
     10,203 bytes raw and 2,087 on the wire for two alerts on a quiet morning. The
     polygons are almost all of the payload; a busy afternoon has been measured at
     119 KB raw, which gzips to about 24 KB, so 0.03 to 0.3 MB an hour at 300 s.

     US ONLY, and every sentence has to say so: this is one country's warning service,
     not a global one, and a page that draws it without the qualifier implies the rest
     of the planet is calm.

     Public domain (US government work). The query asks for actual alerts that are
     immediate and severe or extreme, which is the subset worth interrupting a tour
     for; the full active list is several hundred rows of routine advisories. */

  var NWS_URL = 'https://api.weather.gov/alerts/active' +
                '?status=actual&message_type=alert&urgency=Immediate&severity=Severe,Extreme';
  var NWS_CAP = 60;

  /*
   * A centroid, not the polygon. The page places one marker per alert and the outline
   * would be the whole byte cost of drawing it, so the ring is averaged with the
   * longitudes folded relative to the first vertex, the same rule eonetPoint uses for
   * a ring that straddles the date line.
   */
  function nwsCentroid(geom) {
    if (!geom || !isArr(geom.coordinates)) return null;
    var rings = [];
    if (geom.type === 'Polygon') rings = [geom.coordinates[0]];
    else if (geom.type === 'MultiPolygon') {
      for (var m = 0; m < geom.coordinates.length; m++) {
        if (isArr(geom.coordinates[m])) rings.push(geom.coordinates[m][0]);
      }
    } else if (geom.type === 'Point') {
      var c = geom.coordinates;
      if (!isNum(c[0]) || !isNum(c[1]) || c[1] < -90 || c[1] > 90) return null;
      return { lat: c[1], lon: wrapLon(c[0]) };
    }
    var lon0 = NaN, sLat = 0, sLon = 0, n = 0;
    for (var r = 0; r < rings.length; r++) {
      var ring = rings[r];
      if (!isArr(ring)) continue;
      var last = ring.length - 1;
      if (last > 0 && isArr(ring[0]) && isArr(ring[last]) &&
          ring[0][0] === ring[last][0] && ring[0][1] === ring[last][1]) last--;
      for (var i = 0; i <= last; i++) {
        var pt = ring[i];
        if (!isArr(pt) || !isNum(pt[0]) || !isNum(pt[1])) continue;
        if (pt[1] < -90 || pt[1] > 90) continue;
        if (!isFinite(lon0)) lon0 = wrapLon(pt[0]);
        sLat += pt[1];
        sLon += lon0 + wrapLon(wrapLon(pt[0]) - lon0);
        n++;
      }
    }
    if (!n) return null;
    return { lat: sLat / n, lon: wrapLon(sLon / n) };
  }

  function parseNwsAlerts(raw, ctx) {
    var j = jsonOf(raw, 'nws_alerts');
    if (!j || !isArr(j.features)) throw new Error('nws_alerts: no features');
    var now = (ctx && isNum(ctx.now)) ? ctx.now : NaN;
    var out = [], noGeom = 0, byEvent = {};
    for (var i = 0; i < j.features.length && out.length < NWS_CAP; i++) {
      var f = j.features[i];
      var p = f && f.properties;
      if (!p || !p.event) continue;
      /*
       * An alert with no polygon is not placed and not turned into a stop. The
       * affected-zone fallback would cost one extra request per zone, which is
       * outside this page's byte budget, and a zone code is not a coordinate: the
       * only alternative would be to invent one. It is counted instead, and the
       * status line names the count.
       */
      var c = nwsCentroid(f.geometry);
      if (!c) { noGeom++; continue; }
      var ev = String(p.event);
      byEvent[ev] = (byEvent[ev] || 0) + 1;
      out.push({
        id: String(p.id || f.id || ev + ':' + i),
        event: ev,
        severity: p.severity ? String(p.severity) : '',
        certainty: p.certainty ? String(p.certainty) : '',
        urgency: p.urgency ? String(p.urgency) : '',
        headline: p.headline ? String(p.headline) : '',
        areaDesc: p.areaDesc ? String(p.areaDesc) : '',
        senderName: p.senderName ? String(p.senderName) : '',
        lat: c.lat, lon: c.lon,
        sentMs: parseIsoMs(p.sent),
        effectiveMs: parseIsoMs(p.effective),
        expiresMs: parseIsoMs(p.expires),
        nZones: isArr(p.affectedZones) ? p.affectedZones.length : 0
      });
    }
    return {
      t: isFinite(now) ? now : parseIsoMs(j.updated),
      updatedMs: parseIsoMs(j.updated),
      alerts: out,
      count: out.length + noGeom,
      nPlaced: out.length,
      nNoGeometry: noGeom,
      byEvent: byEvent,
      usOnly: true
    };
  }

  /* ================================================================== 22. ISS

     Where the International Space Station is right now. Measured live 2026-08-26:
     access-control-allow-origin: *, 309 bytes, no-cache. At the 60 s cadence that is
     0.02 MB an hour, which is the cheapest feed on the page by a wide margin.

     The service documents a rate limit of roughly one request a second and publishes
     no licence statement at all; the card says exactly that rather than implying a
     permission nobody granted. What it serves is a propagation of the publicly
     published orbital elements, which is why the page credits the service for the
     propagation and not for the orbit.

     `visibility` is the station's own daylight state ("daylight", "eclipsed",
     "visible"), which is a fact about the station, not about whether anyone on the
     ground could see it. Nothing here may turn it into a sighting. */

  var ISS_URL = 'https://api.wheretheiss.at/v1/satellites/25544';

  function parseIss(raw, ctx) {
    var j = jsonOf(raw, 'iss');
    if (!j || typeof j !== 'object') throw new Error('iss: not an object');
    var lat = num(j.latitude, NaN), lon = num(j.longitude, NaN);
    if (!isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90) {
      throw new Error('iss: no position');
    }
    var now = (ctx && isNum(ctx.now)) ? ctx.now : NaN;
    var stamp = num(j.timestamp, NaN);
    var vis = j.visibility ? String(j.visibility) : '';
    return {
      t: isFinite(now) ? now : (isFinite(stamp) ? stamp * 1000 : NaN),
      reportedMs: isFinite(stamp) ? stamp * 1000 : NaN,
      lat: lat, lon: wrapLon(lon),
      /* the upstream spellings alongside ours, for the same reason the sonde
         rows carry both (r12 INTERFACES, zone K3) */
      latitude: lat, longitude: wrapLon(lon),
      altitude: num(j.altitude, NaN),
      velocity: num(j.velocity, NaN),
      altKm: num(j.altitude, NaN),
      velocityKmh: num(j.velocity, NaN),
      footprintKm: num(j.footprint, NaN),
      visibility: vis,
      daylight: vis === 'daylight' || vis === 'visible',
      solarLat: num(j.solar_lat, NaN),
      solarLon: num(j.solar_lon, NaN)
    };
  }

  /* ================================================================== manifests */

  var SWPC = { text: 'NOAA SWPC', href: 'https://www.swpc.noaa.gov/' };
  var PD = 'US public domain';

  var MANIFESTS = {
    goes_xray: {
      id: 'goes_xray',
      name: 'GOES X-ray flux',
      attribution: SWPC,
      license: PD,
      kind: 'poll',
      url: XRAY_LADDER[1].url,
      cadenceMs: 120000,
      staleAfterMs: 300000,
      lazy: false,
      fetcher: fetchXray,
      parse: parseXray
    },
    drap: {
      id: 'drap',
      name: 'D-RAP shortwave absorption',
      attribution: SWPC,
      license: PD,
      kind: 'poll',
      url: DRAP_URL,
      cadenceMs: 300000,
      staleAfterMs: 750000,
      lazy: false,
      responseType: 'text',
      parse: parseDrap
    },
    kp_rtsw: {
      id: 'kp_rtsw',
      name: 'Planetary K index and solar wind',
      attribution: SWPC,
      license: PD,
      kind: 'poll',
      url: KP_URL,
      cadenceMs: 300000,
      staleAfterMs: 750000,
      lazy: false,
      fetcher: fetchKpRtsw,
      parse: parseKpRtsw
    },
    ovation: {
      id: 'ovation',
      name: 'OVATION aurora model',
      attribution: SWPC,
      license: PD,
      kind: 'poll',
      url: OVATION_URL,
      cadenceMs: 1800000,
      staleAfterMs: 4500000,
      /* 1.3 MB of JSON from a slow origin: the kernel's 30 s default would abort a
         request that was going to answer (r12 item 15). */
      timeoutMs: 90000,
      lazy: false,
      responseType: 'text',   /* text so the kernel can measure and slice the payload */
      parse: parseOvation
    },
    clouds: {
      id: 'clouds',
      name: 'GOES cloud imagery',
      attribution: { text: 'NOAA NESDIS STAR', href: 'https://www.star.nesdis.noaa.gov/GOES/' },
      license: PD,
      kind: 'poll',
      url: cloudUrl('GOES19', 678),
      cadenceMs: 1200000,
      staleAfterMs: 3000000,
      timeoutMs: 90000,        /* two full-disc images; see the ovation note */
      lazy: false,
      fetcher: fetchClouds,
      parse: parseClouds
    },
    wspr: {
      id: 'wspr',
      name: 'WSPR beacon reports',
      attribution: { text: 'WSPR.live and the WSPRnet volunteers', href: 'https://wspr.live/' },
      license: 'Community data, used under the WSPR.live fair use policy',
      kind: 'poll',
      url: WSPR_URL,
      cadenceMs: 300000,
      staleAfterMs: 750000,
      lazy: true,
      fetcher: fetchWspr,
      parse: parseWspr
    },
    usgs_quakes: {
      id: 'usgs_quakes',
      name: 'USGS earthquakes, past day',
      attribution: { text: 'USGS', href: 'https://earthquake.usgs.gov/' },
      license: PD,
      kind: 'poll',
      url: USGS_URL,
      /* 300 s, not the 120 s the hour feed used: the payload is 26 times
         bigger and a quake that has just been located is still on the map
         inside five minutes. The byte arithmetic is at USGS_URL. */
      /* all_day is ~140-290 KB; 600 s keeps it near 1 MB/h (EMSC pushes fresh quakes) */
      cadenceMs: 600000,
      staleAfterMs: 1500000,
      lazy: false,
      responseType: 'text',   /* text so the kernel can measure and slice the payload */
      parse: parseUsgs
    },
    emsc_ws: {
      id: 'emsc_ws',
      name: 'EMSC seismic portal push',
      attribution: { text: 'EMSC seismicportal.eu', href: 'https://www.seismicportal.eu/' },
      license: 'Free for non commercial use, credit required',
      kind: 'ws',
      url: EMSC_WS,
      cadenceMs: 5000,      /* streams never poll; this is the reconnect backoff base */
      staleAfterMs: 0,      /* a quiet minute on this socket is normal, not stale */
      lazy: false,
      parse: parseEmsc
    },
    wm_edits: {
      id: 'wm_edits',
      name: 'Wikipedia edit stream',
      attribution: { text: 'Wikimedia EventStreams', href: 'https://stream.wikimedia.org/' },
      license: 'CC BY-SA / public data',
      kind: 'sse',
      url: WM_SSE_URL,
      cadenceMs: 5000,      /* reconnect backoff base, this stream is never polled */
      staleAfterMs: 300000,
      lazy: true,
      parse: parseWmEdit
    },
    /* The cheap half of the same watch (deviation r6). Lazy like the stream, so it costs
       nothing until a stopwatch asks for it, and the url here is nominal: the fetcher
       builds one query per wiki from the search target. */
    wm_search: {
      id: 'wm_search',
      name: 'Wikipedia article search and recent changes',
      attribution: { text: 'MediaWiki Action API', href: 'https://www.mediawiki.org/wiki/API:Main_page' },
      license: 'CC BY-SA / public data',
      kind: 'poll',
      url: 'https://en.wikipedia.org/w/api.php',
      cadenceMs: WM_POLL_CADENCE_MS,
      staleAfterMs: 150000,
      lazy: true,
      fetcher: fetchWmSearch,
      parse: parseWmSearch
    },
    wm_pageviews: {
      id: 'wm_pageviews',
      name: 'Wikipedia pageviews',
      attribution: { text: 'Wikimedia REST API', href: 'https://wikimedia.org/api/rest_v1/' },
      license: 'CC0 pageview data',
      kind: 'poll',
      url: WM_PV_BASE,
      cadenceMs: 600000,
      staleAfterMs: 0,
      lazy: true,
      fetcher: fetchPageviews,
      parse: parsePageviews
    },
    planes: {
      id: 'planes',
      name: 'Aircraft samples, through the antenna',
      attribution: { text: 'adsb.lol and adsb.fi volunteer feeders', href: 'https://adsb.lol/' },
      license: 'ODbL 1.0 (adsb.lol), adsb.fi terms require the credit link',
      kind: 'antenna',
      /* r19d item 8. An antenna feed does not read a source: it reads the
         relay's snapshot, and the window that decides "past it" has to be the
         antenna's own staleAfterMs for this route (antenna/worker.js ROUTES).
         A shorter window rings a snapshot stale that the antenna itself still
         calls fresh. 2026-10-11 (antenna-hourly, Keane: "Let's make the pull
         be every 60 mins"): the collector rewrites the snapshot once an hour,
         started by the antenna when the stored one is 50 minutes old, and
         GitHub's queue and the round add a minute or two, so the copy we hold
         is at worst about an hour plus that delay plus one cadence old, and
         the window is 75 minutes on both sides (it was 15 at a ten minute
         cron). 2026-10-12 (antenna-ondemand, Keane: "change the update
         frequency to every 30 mins then, but yes also make it on demand"):
         while this page is open its polls start the collector whenever the
         snapshot is 25 minutes old, so the window is 45 minutes on both sides
         (the half hour plus the queue, the round and one poll), and after a
         quiet spell the first poll asks for a fresh sample and says so (the
         answer's `refresh`, refreshOf above). Two numbers, one rule:
         cadence + 30 min + the queue and round must stay inside the window.
         The three minute cadence stays: the polls are nearly free because
         planesUrl sends ?since= and an unchanged snapshot answers in about
         eighty bytes, and a new snapshot reaches the page within three
         minutes of landing. This is one of
         exactly three exceptions to the r19 item 7 ratio (this feed, jam
         below, and gps_notams). The age the page prints is the snapshot's own
         age throughout: the parse keeps the snapshot's t and the kernel dates
         the feed from it, never from the poll. */
      url: '/planes',
      cadenceMs: 180000,
      staleAfterMs: 2700000,
      lazy: true,
      fetcher: fetchPlanes,
      parse: parsePlanes
    },
    jam: {
      id: 'jam',
      name: 'GPS integrity bins, through the antenna',
      attribution: { text: 'adsb.lol and adsb.fi volunteer feeders', href: 'https://adsb.lol/' },
      license: 'ODbL 1.0 (adsb.lol), adsb.fi terms require the credit link',
      kind: 'antenna',
      url: '/jam',
      cadenceMs: 300000,
      /* r19d item 8, the same exception as planes above and for the same
         reason: this is the relay's aggregate, rolled by the same writer in
         the same round as the snapshot, so since the hourly collector
         (2026-10-11) it is rewritten once an hour and the antenna calls it
         stale at 75 minutes (antenna/worker.js ROUTES), as this window does.
         At the old 30 minutes the kernel would call an aggregate that is on
         time stale for half of every hour. Five minutes plus the hour
         plus the delay is inside it: this route has no ?since= and every poll
         costs the whole aggregate, so the cadence stays where it was.
         2026-10-12 (antenna-ondemand): rewritten every half hour while this
         page is open, so 45 minutes, the antenna's own /jam window; five
         minutes plus the half hour plus the delay is inside it. */
      staleAfterMs: 2700000,
      lazy: false,
      responseType: 'text',   /* text so the kernel can measure and slice the payload */
      parse: parseJam
    },
    gps_notams: {
      id: 'gps_notams',
      name: 'Announced GPS test windows',
      attribution: { text: 'FAA NOTAM API', href: 'https://api.faa.gov/s/' },
      license: PD,
      kind: 'antenna',
      url: '/notams/gps',
      cadenceMs: 900000,
      /* r19 item 7 exception, the first of exactly three (r19d item 8 added
         the two antenna readings, planes and jam above). Every other polled
         feed goes stale at 2.5 cadences, because a missed poll there means the
         number on the screen is out of date. A NOTAM list is not a reading: it
         is a set of windows that are valid for hours, so an 18 hour window is
         what "this list is past it" honestly means for this feed. */
      staleAfterMs: 64800000,
      lazy: false,
      responseType: 'text',   /* text so the kernel can measure and slice the payload */
      parse: parseNotams
    },
    tfrs: {
      id: 'tfrs',
      name: 'Temporary flight restrictions',
      attribution: { text: 'FAA TFR list', href: 'https://tfr.faa.gov/' },
      license: PD,
      kind: 'antenna',
      url: '/tfrs',
      cadenceMs: 600000,
      staleAfterMs: 1500000,
      lazy: false,
      responseType: 'text',   /* text so the kernel can measure and slice the payload */
      parse: parseTfrs
    },
    openmeteo: {
      id: 'openmeteo',
      name: 'Open-Meteo winds aloft forecast',
      attribution: { text: 'Weather data by Open-Meteo.com', href: 'https://open-meteo.com/' },
      license: 'CC BY 4.0',
      kind: 'poll',
      url: OM_URL,
      cadenceMs: 3600000,
      staleAfterMs: 9000000,
      lazy: true,
      fetcher: fetchOpenMeteo,
      parse: parseOpenMeteo
    },
    eonet: {
      id: 'eonet',
      name: 'NASA EONET natural events',
      attribution: { text: 'NASA EONET', href: 'https://eonet.gsfc.nasa.gov/' },
      license: PD,
      kind: 'poll',
      url: EONET_URL,
      cadenceMs: 600000,
      staleAfterMs: 1500000,
      lazy: false,
      fetcher: fetchEonet,
      parse: parseEonet
    },
    launches: {
      id: 'launches',
      name: 'Launch schedule',
      attribution: { text: 'Launch Library 2 by The Space Devs', href: 'https://thespacedevs.com/llapi' },
      license: 'free to use, attribution required by The Space Devs',
      kind: 'poll',
      url: LL2_UPCOMING_URL,
      cadenceMs: 1200000,
      staleAfterMs: 3000000,
      lazy: false,
      fetcher: fetchLaunches,
      parse: parseLaunches
    },
    sondehub: {
      id: 'sondehub',
      name: 'Weather balloons aloft',
      attribution: { text: 'SondeHub and the volunteer radiosonde receivers',
                     href: 'https://sondehub.org/' },
      license: 'CC BY-SA 2.0',
      kind: 'poll',
      url: SONDEHUB_URL,
      cadenceMs: 300000,
      staleAfterMs: 750000,
      lazy: false,
      responseType: 'text',   /* text so the kernel can measure the payload */
      parse: parseSondehub
    },
    gdacs: {
      id: 'gdacs',
      name: 'GDACS disaster alerts',
      attribution: { text: 'GDACS, run by the European Commission Joint Research Centre and UN OCHA',
                     href: 'https://www.gdacs.org/' },
      license: 'Free reuse with attribution to JRC and UN OCHA',
      kind: 'poll',
      cadenceMs: 900000,
      staleAfterMs: 2250000,
      lazy: false,
      url: GDACS_URL,         /* the fetcher adds the date window, which moves */
      fetcher: fetchGdacs,
      parse: parseGdacs
    },
    nws_alerts: {
      id: 'nws_alerts',
      name: 'US severe weather warnings',
      attribution: { text: 'US National Weather Service', href: 'https://www.weather.gov/' },
      license: PD,
      kind: 'poll',
      url: NWS_URL,
      cadenceMs: 300000,
      staleAfterMs: 750000,
      lazy: false,
      responseType: 'text',   /* text so the kernel can measure the payload */
      parse: parseNwsAlerts
    },
    iss: {
      id: 'iss',
      name: 'Space station position',
      attribution: { text: 'wheretheiss.at', href: 'https://wheretheiss.at/w/developer' },
      license: 'No licence stated by the publisher; see the card',
      kind: 'poll',
      url: ISS_URL,
      cadenceMs: 60000,
      staleAfterMs: 150000,
      lazy: false,
      responseType: 'text',
      parse: parseIss
    },
    swpc_alerts: {
      id: 'swpc_alerts',
      name: 'NOAA space weather alerts',
      attribution: SWPC,
      license: PD,
      kind: 'poll',
      url: SWPC_ALERTS_URL,
      cadenceMs: 300000,
      staleAfterMs: 750000,
      lazy: false,
      responseType: 'text',   /* text so the kernel can measure the payload */
      parse: parseSwpcAlerts
    }
  };

  var ORDER = [
    'goes_xray', 'drap', 'kp_rtsw', 'ovation', 'clouds', 'wspr',
    'usgs_quakes', 'emsc_ws', 'wm_edits', 'wm_search', 'wm_pageviews',
    'planes', 'jam', 'gps_notams', 'tfrs', 'openmeteo',
    'eonet', 'launches', 'swpc_alerts',
    'sondehub', 'gdacs', 'nws_alerts', 'iss'
  ];

  /* ================================================================== registration */

  var registered = [];

  function register(core) {
    var c = core || global.ObsCore;
    if (!c || typeof c.registerFeed !== 'function') return [];
    var done = [];
    for (var i = 0; i < ORDER.length; i++) {
      var id = ORDER[i];
      if (typeof c.feed === 'function' && c.feed(id)) continue;
      c.registerFeed(MANIFESTS[id]);
      done.push(id);
    }
    registered = registered.concat(done);
    return done;
  }

  /* Drives a parser that returns an iterator (ovation) to completion. The kernel does
     this in slices; tests and any direct caller use this. */
  function runParse(id, raw, ctx) {
    var m = MANIFESTS[id];
    if (!m) throw new Error('unknown feed ' + id);
    var out = m.parse(raw, ctx || { id: id, now: NaN, prev: null, state: {} });
    if (out && typeof out.next === 'function') {
      for (var guard = 0; guard < 1e7; guard++) {
        var step = out.next();
        if (step && step.done) return step.value;
      }
      throw new Error(id + ': parse iterator did not finish');
    }
    return out;
  }

  var ObsFeeds = {
    ver: VER,
    manifests: MANIFESTS,
    order: ORDER,
    register: register,
    registered: function () { return registered.slice(); },
    runParse: runParse,

    /* r27 (9), PIN Z3-R27-GRID: the wind layer's forecast grid, fetched ONCE.
       obs-instruments.js calls windGridOnce when the layer is armed and
       subscribes through onWindGrid. Everything impure about the grid is behind
       these. `setWindView` is kept and does nothing (the fetch no longer
       follows the camera). */
    windGridOnce: windGridOnce,
    setWindView: setWindView,
    windView: function () { return GRID.view; },
    windGridPlan: function () { return gridPlanNow(); },
    windGridData: windGridData,
    windGridState: windGridState,
    windGridStats: windGridStats,
    setWindFixture: setWindFixture,
    /* r27b, SEAM C-R27B-6: the sample centres' own arm (OM_SITES), so a harness lane
       can cost the forecast service's daily allowance nothing at all */
    setOmSitesFixture: setOmSitesFixture,
    omSitesFixture: omSitesFixture,
    onWindGrid: onWindGrid,
    resetWindGrid: resetWindGrid,

    parse: {
      goes_xray: parseXray,
      drap: parseDrap,
      kp_rtsw: parseKpRtsw,
      ovation: parseOvation,
      clouds: parseClouds,
      wspr: parseWspr,
      usgs_quakes: parseUsgs,
      emsc_ws: parseEmsc,
      wm_edits: parseWmEdit,
      wm_search: parseWmSearch,
      wm_pageviews: parsePageviews,
      planes: parsePlanes,
      jam: parseJam,
      gps_notams: parseNotams,
      tfrs: parseTfrs,
      openmeteo: parseOpenMeteo,
      eonet: parseEonet,
      launches: parseLaunches,
      swpc_alerts: parseSwpcAlerts,
      sondehub: parseSondehub,
      gdacs: parseGdacs,
      nws_alerts: parseNwsAlerts,
      iss: parseIss
    },

    PURE: {
      flareClass: flareClass,
      flareState: flareState,
      drapValueAt: drapValueAt,
      pathKey: pathKey,
      pollKeyCounts: pollKeyCounts,
      quakeDedupeKey: quakeDedupeKey,
      sameQuake: sameQuake,
      dedupeQuakes: dedupeQuakes,
      /* r19 */
      rateLimitErr: rateLimitErr,
      quakeWord: quakeWord,
      quakeEvent: quakeEvent,
      flareEvent: flareEvent,
      tfrEvent: tfrEvent,
      planeObj: planeObj,
      omSample: omSample,
      nearestSite: nearestSite,
      windUv: windUv,
      openMeteoUrl: openMeteoUrl,
      pageviewUrl: pageviewUrl,
      wmSearchUrl: wmSearchUrl,
      pollEditRow: pollEditRow,
      streamAllowed: streamAllowed,
      editMode: editMode,
      editFeedFor: editFeedFor,
      wsprUrl: wsprUrl,
      cloudUrl: cloudUrl,
      parseIsoMs: parseIsoMs,
      median: median,
      wrapLon: wrapLon,
      eonetPoint: eonetPoint,
      eonetTrack: eonetTrack,
      haversineKm: haversineKm,
      launchRow: launchRow,
      launchCacheRead: launchCacheRead,
      launchCacheWrite: launchCacheWrite,
      launchTryRead: launchTryRead,
      launchTryWrite: launchTryWrite,
      launchQuotaLeftMs: launchQuotaLeftMs,
      swpcAlert: swpcAlert,
      swpcSummary: swpcSummary,
      swpcTimeMs: swpcTimeMs,
      swpcField: swpcField,
      swpcScale: swpcScale,
      swpcActive: swpcActive,
      stormWord: stormWord,
      sondeState: sondeState,
      gdacsUrl: gdacsUrl,
      nwsCentroid: nwsCentroid,
      ymd: ymd,
      /* r27 (9), PIN Z3-R27-GRID. `gridPlan` (the view-following plan) left
         with the law that fetched on every camera settlement. */
      globalGrid: globalGrid,
      capCount: capCount,
      fieldAt: fieldAt,
      gridAngDeg: gridAngDeg,
      omGridUrl: omGridUrl,
      parseOmGrid: parseOmGrid,
      gridLevelIdx: gridLevelIdx
    },

    /* constants other modules and the tests read rather than retyping */
    BAND_MHZ: BAND_MHZ,
    BAND_NAME: BAND_NAME,
    PLANE_IDX: PLANE_IDX,
    PLANES_MIN_ALT_FT: PLANES_MIN_ALT_FT,
    USGS_URL: USGS_URL,
    USGS_WINDOW_MS: USGS_WINDOW_MS,
    XRAY_BAND: XRAY_BAND,
    XRAY_LADDER: XRAY_LADDER,
    XRAY_BOOT_RUNGS: XRAY_BOOT_RUNGS,
    CLOUD_SATS: CLOUD_SATS,
    CLOUD_SIZES: CLOUD_SIZES,
    CLOUD_COVERAGE_DEG: CLOUD_COVERAGE_DEG,
    CLOUD_HORIZON_DEG: CLOUD_HORIZON_DEG,
    CLOUD_BANNER_PX: CLOUD_BANNER_PX,
    OM_LEVELS: OM_LEVELS,
    OM_SITES: OM_SITES,
    /* r27 (9): the wind layer's grid, fetched once */
    OM_GRID_STEP: OM_GRID_STEP,
    OM_CHUNK: OM_CHUNK,
    GRID_MIN: GRID_MIN,
    GRID_HOURS: GRID_HOURS,
    GRID_LAT_MAX: GRID_LAT_MAX,
    GRID_WEIGHT_CAP: GRID_WEIGHT_CAP,
    GRID_SLOT_MS: GRID_SLOT_MS,
    GRID_CACHE_MS: GRID_CACHE_MS,
    GRID_CACHE_KEY: GRID_CACHE_KEY,
    GRID_TRY_MS: GRID_TRY_MS,
    GRID_BACKOFF_MS: GRID_BACKOFF_MS,
    GRID_LEVEL: GRID_LEVEL,
    WSPR_QUERY: WSPR_QUERY,
    WSPR_RING_MS: WSPR_RING_MS,
    WM_UA: WM_UA,
    EDIT_MODE: EDIT_MODE,
    EDIT_FEED: EDIT_FEED,
    EDIT_RESOLUTION_MS: EDIT_RESOLUTION_MS,
    WM_STREAM_MAX_MS: WM_STREAM_MAX_MS,
    WM_POLL_CADENCE_MS: WM_POLL_CADENCE_MS,
    WM_POLL_LANGS: WM_POLL_LANGS,
    SHOCK_DSPEED_KMS: SHOCK_DSPEED_KMS,
    SHOCK_DENS_RATIO: SHOCK_DENS_RATIO,
    OVATION_CHUNK: OVATION_CHUNK,
    EONET_URL: EONET_URL,
    EONET_CATS: EONET_CATS,
    EONET_DAYS: EONET_DAYS,
    EONET_VOLC_URL: EONET_VOLC_URL,
    EONET_VOLC_CATS: EONET_VOLC_CATS,
    EONET_VOLC_DAYS: EONET_VOLC_DAYS,
    EONET_VOLC_CADENCE_MS: EONET_VOLC_CADENCE_MS,
    EONET_TRACK_MAX: EONET_TRACK_MAX,
    EONET_RECENT_MS: EONET_RECENT_MS,
    EMERGENCY_SQUAWKS: EMERGENCY_SQUAWKS,
    SQUAWK_MEANING: SQUAWK_MEANING,
    EONET_CLASS: EONET_CLASS,
    EONET_CAP: EONET_CAP,
    LL2_UPCOMING_URL: LL2_UPCOMING_URL,
    LL2_PREVIOUS_URL: LL2_PREVIOUS_URL,
    LL2_CACHE_KEY: LL2_CACHE_KEY,
    LL2_TRY_KEY: LL2_TRY_KEY,
    LL2_CACHE_MS: LL2_CACHE_MS,
    LL2_STALE_MS: LL2_STALE_MS,
    LL2_STATUS: LL2_STATUS,
    SWPC_ALERTS_URL: SWPC_ALERTS_URL,
    SWPC_ALERT_CAP: SWPC_ALERT_CAP,
    SWPC_KIND: SWPC_KIND,
    SWPC_SUBJECT: SWPC_SUBJECT,
    SONDEHUB_URL: SONDEHUB_URL,
    SONDEHUB_WINDOW_S: SONDEHUB_WINDOW_S,
    SONDEHUB_ATTRIB: SONDEHUB_ATTRIB,
    SONDE_RISE_MS: SONDE_RISE_MS,
    SONDE_APOGEE_M: SONDE_APOGEE_M,
    SONDE_LAND_M: SONDE_LAND_M,
    GDACS_URL: GDACS_URL,
    GDACS_TYPE: GDACS_TYPE,
    GDACS_LEVELS: GDACS_LEVELS,
    GDACS_WINDOW_DAYS: GDACS_WINDOW_DAYS,
    NWS_URL: NWS_URL,
    ISS_URL: ISS_URL,

    /* runtime seams the page and the browser tests read */
    setFetch: setFetch,
    setClock: setClock,
    clockFn: function () { return injectedClock; },
    setStore: setStore,
    storeFn: function () { return injectedStore; },
    fetchFn: function () { return injectedFetch; },
    probeXray: probeXray,
    resetEonetVolcCache: resetEonetVolcCache,
    probeXrayUpgrade: probeXrayUpgrade,
    maskCloudBranding: maskCloudBranding,
    xrayPick: function () { return xrayPick; },
    setPageviewTarget: setPageviewTarget,
    pageviewTarget: pageviewTarget,
    setEditSearch: setEditSearch,
    editSearch: editSearch,
    streamEnv: streamEnv,
    wmUaState: function () { return wmUaWorks; },
    cloudSizes: function () {
      var out = {};
      for (var k in cloudSize) out[k] = cloudSize[k];
      return out;
    }
  };

  global.ObsFeeds = ObsFeeds;
  if (typeof module !== 'undefined' && module.exports) module.exports = ObsFeeds;

  if (global.ObsCore && typeof global.ObsCore.registerFeed === 'function') register(global.ObsCore);
})(typeof globalThis !== 'undefined' ? globalThis
   : (typeof self !== 'undefined' ? self : this));
