/*
 * The Observatory antenna.
 *
 * A small Cloudflare Worker that stands between keanelucas.com/observatory/ and four upstream
 * sources that a browser cannot reach directly (no CORS headers): adsb.lol, adsb.fi,
 * tfr.faa.gov and the FAA NOTAM API. It fetches on a cron, aggregates, and serves small
 * CORS-open JSON snapshots.
 *
 * Design rules, from the Act 1 spec:
 *   1. Every route handler and every piece of logic is a pure-ish function that takes an
 *      injected deps object { fetchFn, kv, nowMs, secrets, sleep }. The default export at the
 *      bottom is the only place that touches real bindings, so the whole file is testable in
 *      plain node with stubs.
 *   2. Upstream failures never 500 a route. The last KV value is served with stale: true and
 *      an age, or a 503 with offline: true when there is nothing at all.
 *   3. Free-plan budgets are respected: at most one KV write per key per cron, the TFR write
 *      is skipped when the payload is unchanged, and subrequests are counted.
 *   4. No side effects at module scope beyond constant and function declarations.
 *
 * Upstream politeness and licensing (see README.md for the full text):
 *   adsb.lol data is ODbL 1.0, adsb.fi is free for personal non-commercial use and requires a
 *   citation with a link. Both are volunteer feeder networks. Every upstream call carries the
 *   User-Agent below so the operators can see who we are.
 */

/* ------------------------------------------------------------------ constants */

export const VERSION = '1.0.0';
export const USER_AGENT = 'keanelucas.com-observatory-antenna (keenlooks@gmail.com)';

export const ADSB_LOL_BASE = 'https://api.adsb.lol/v2';
/* adsb.fi documents v3 as the endpoint to use for new integrations; their v2 lat/lon/dist
   route is deprecated. The tile parser accepts both response shapes (ac + total from v3 and
   readsb, aircraft + resultCount from v2) so either works. */
export const ADSB_FI_BASE = 'https://opendata.adsb.fi/api/v3';
export const TFR_LIST_URL = 'https://tfr.faa.gov/tfrapi/exportTfrList';
export const TFR_DETAIL_BASE = 'https://tfr.faa.gov/download/detail_';
export const FAA_NOTAM_URL = 'https://external-api.faa.gov/notamapi/v1/notams';

export const TILE_DIST_NM = 250;
export const TILE_SPACING_MS = 250;      /* serialized upstream calls; adsb.fi's own 1/s is SOURCE_MIN_SPACING_MS */
export const UPSTREAM_TIMEOUT_MS = 12000;
/*
 * 2026-10-11 (antenna-fix): the refusal breaker. From Cloudflare's shared egress adsb.lol
 * answers 429 and adsb.fi 403 to nearly every tile, and each refused tile cost two calls, so a
 * refused round spent 43 of the 44 and starved the TFR detail fetches. After this many
 * CONSECUTIVE 403 or 429 answers from one source in one cron, that source is skipped for the
 * rest of the cron. Only 403 and 429 count: a 5xx is an outage that may clear on the next tile.
 */
export const REFUSAL_STATUSES = [403, 429];
export const REFUSALS_TO_SKIP = 3;
/*
 * 2026-10-11 (antenna-fix, third pass): the least time between two calls to ONE source in a
 * cron, start to start. adsb.fi documents one request per second, and after an adsb.lol burst
 * trips the breaker every tile goes to adsb.fi at the 250 ms tile spacing, so its calls
 * (fallback or primary) wait for their own second. adsb.lol keeps the tile spacing. Waiting
 * costs wall time only (24 tiles at 1 s is about 24 s), never a subrequest.
 */
export const SOURCE_MIN_SPACING_MS = { 'adsb.lol': TILE_SPACING_MS, 'adsb.fi': 1000 };

/* A Workers invocation may make 50 subrequests on the free plan. Leave headroom. */
export const MAX_SUBREQUESTS = 44;
/*
 * TFR geometries enriched per cron (r12 item 16, raised from 4). The arithmetic on the
 * 44 call budget, worst case first: 24 tiles at up to 2 calls each is 48, which is already
 * over the cap, so collectTiles stops adding tiles once budget.left <= 2 and the tiles can
 * never leave less than 2. On a normal round the primary source answers first time, so the
 * tiles spend 24, the TFR list spends 1 and the GPS sweep spends at most 1: 18 calls are
 * left. The detail loop is gated on budget.left > 2 as well as on this ceiling, so 8 is the
 * most it will ever take and it takes fewer whenever the tiles had a bad round. At 8 per
 * 10 minute cron a list of 60 restrictions is fully enriched in about 75 minutes instead of
 * two and a half hours, which is the difference between tfr_active being a tour class on a
 * first visit and being one tomorrow.
 */
export const MAX_TFR_DETAIL_PER_CRON = 8;
export const TFR_FAIL_RETRY_MS = 6 * 3600 * 1000;
export const TFR_FAIL_MAX_TRIES = 3;

export const JAM_BIN_DEG = 2;
export const JAM_BUCKET_MS = 10 * 60 * 1000;
export const JAM_BUCKETS_1H = 6;
export const JAM_HOURS_24H = 24;
export const NACP_LOW_MAX = 6;           /* nac_p <= 6 counts as degraded position integrity */

export const GPS_SWEEP_INTERVAL_MS = 6 * 3600 * 1000;
export const GPS_SWEEP_POINTS_PER_RUN = 20;
export const GPS_SWEEP_RADIUS_NM = 100;
export const GPS_NOTAM_TTL_MS = 36 * 3600 * 1000;

/*
 * The 24 sample tiles, 250 nm radius each. Chosen for volunteer receiver density crossed with
 * the regions where GPS interference is actually reported. Every entry names its region.
 *
 * COUPLED: assets/js/obs-feeds.js OM_SITES is this list of centres, in this order. The winds
 * instrument compares an Open-Meteo forecast at those points against the aircraft sampled in
 * these tiles, so editing one side alone would quietly compare two different places. t-feeds
 * reads this array as text and asserts the two match, so an edit here fails that suite until
 * OM_SITES follows.
 */
export const TILES = [
  /* Europe (6) */
  { lat: 51.0, lon: 3.0, region: 'Benelux and the southern North Sea' },
  { lat: 55.0, lon: 20.5, region: 'Baltic Sea and Kaliningrad' },
  { lat: 44.0, lon: 33.0, region: 'Black Sea' },
  { lat: 37.5, lon: 25.0, region: 'Aegean and the eastern Mediterranean' },
  { lat: 65.0, lon: 25.0, region: 'Lapland and the Gulf of Bothnia' },
  { lat: 40.0, lon: -3.5, region: 'Iberia' },
  /* Middle East (3) */
  { lat: 33.5, lon: 35.0, region: 'Levant and Cyprus' },
  { lat: 33.3, lon: 44.4, region: 'Mesopotamia' },
  { lat: 26.0, lon: 52.0, region: 'Persian Gulf' },
  /* North America (6) */
  { lat: 41.0, lon: -74.0, region: 'United States northeast' },
  { lat: 33.5, lon: -84.5, region: 'United States southeast' },
  { lat: 41.9, lon: -87.6, region: 'United States midwest' },
  { lat: 32.8, lon: -96.8, region: 'Texas and the southern plains' },
  { lat: 36.5, lon: -119.5, region: 'California' },
  { lat: 47.6, lon: -122.3, region: 'Pacific northwest and southern British Columbia' },
  /* East and southeast Asia (4) */
  { lat: 37.5, lon: 127.0, region: 'Korean peninsula' },
  { lat: 35.7, lon: 139.7, region: 'Kanto and the Japanese coast' },
  { lat: 24.5, lon: 120.0, region: 'Taiwan Strait' },
  { lat: 1.35, lon: 103.8, region: 'Singapore and the Malacca Strait' },
  /* South America (2) */
  { lat: -23.5, lon: -46.6, region: 'southeast Brazil' },
  { lat: 4.7, lon: -74.1, region: 'northern Andes' },
  /* Oceania (2) */
  { lat: -33.9, lon: 151.2, region: 'southeast Australia' },
  { lat: -37.0, lon: 175.0, region: 'northern New Zealand' },
  /* Southern Africa (1) */
  { lat: -26.1, lon: 28.0, region: 'Highveld and Johannesburg' },
];

/*
 * Route table. kv is the key each route serves; staleAfterMs is when the served value starts
 * announcing itself as stale (the value is still served, honestly labelled).
 */
export const ROUTES = [
  { path: '/planes', kv: 'snap:planes', maxAge: 45, sMaxAge: 90, staleAfterMs: 15 * 60 * 1000 },
  { path: '/jam', kv: 'agg:jam', maxAge: 60, sMaxAge: 120, staleAfterMs: 30 * 60 * 1000 },
  { path: '/tfrs', kv: 'tfrs', maxAge: 300, sMaxAge: 600, staleAfterMs: 6 * 3600 * 1000 },
  { path: '/notams/gps', kv: 'notams:gps', maxAge: 450, sMaxAge: 900, staleAfterMs: 24 * 3600 * 1000 },
  { path: '/health', kv: null, maxAge: 0, sMaxAge: 0 },
];

/* TFR types worth a detail fetch (the list API carries no coordinates at all). */
export const TFR_ENRICH_PREFIXES = ['VIP', 'SECURITY', 'HAZARDS', 'SPACE'];

/*
 * State centroids, used only when a TFR detail fetch gives us no geometry. Every item built
 * from this table carries approx: true so the page can say so.
 */
export const STATE_CENTROIDS = {
  AL: [32.8067, -86.7911], AK: [61.3707, -152.4044], AZ: [33.7298, -111.4312],
  AR: [34.9697, -92.3731], CA: [36.1162, -119.6816], CO: [39.0598, -105.3111],
  CT: [41.5978, -72.7554], DE: [39.3185, -75.5071], FL: [27.7663, -81.6868],
  GA: [33.0406, -83.6431], HI: [21.0943, -157.4983], ID: [44.2405, -114.4788],
  IL: [40.3495, -88.9861], IN: [39.8494, -86.2583], IA: [42.0115, -93.2105],
  KS: [38.5266, -96.7265], KY: [37.6681, -84.6701], LA: [31.1695, -91.8678],
  ME: [44.6939, -69.3819], MD: [39.0639, -76.8021], MA: [42.2302, -71.5301],
  MI: [43.3266, -84.5361], MN: [45.6945, -93.9002], MS: [32.7416, -89.6787],
  MO: [38.4561, -92.2884], MT: [46.9219, -110.4544], NE: [41.1254, -98.2681],
  NV: [38.3135, -117.0554], NH: [43.4525, -71.5639], NJ: [40.2989, -74.5210],
  NM: [34.8405, -106.2485], NY: [42.1657, -74.9481], NC: [35.6301, -79.8064],
  ND: [47.5289, -99.7840], OH: [40.3888, -82.7649], OK: [35.5653, -96.9289],
  OR: [44.5720, -122.0709], PA: [40.5908, -77.2098], RI: [41.6809, -71.5118],
  SC: [33.8569, -80.9450], SD: [44.2998, -99.4388], TN: [35.7478, -86.6923],
  TX: [31.0545, -97.5635], UT: [40.1500, -111.8624], VT: [44.0459, -72.7107],
  VA: [37.7693, -78.1700], WA: [47.4009, -121.4905], WV: [38.4912, -80.9545],
  WI: [44.2685, -89.6165], WY: [42.7560, -107.3025],
  DC: [38.8974, -77.0268], PR: [18.2208, -66.5901], VI: [18.3358, -64.8963],
  GU: [13.4443, 144.7937], AS: [-14.2710, -170.1322], MP: [15.0979, 145.6739],
};

/*
 * GPS NOTAM sweep grid: coarse CONUS lattice plus three Alaska points. The FAA NOTAM API has
 * no free-text search, so the only way to find GPS test NOTAMs is to sweep FDC items by
 * location. 100 nm is the maximum locationRadius the API accepts. This lattice is coarser
 * than its own footprint, so coverage is partial by construction and the page says so.
 */
export const GPS_SWEEP_GRID = buildSweepGrid();

function buildSweepGrid() {
  const pts = [];
  for (let lat = 26; lat <= 47; lat += 3) {
    for (let lon = -122; lon <= -80; lon += 7) pts.push([lat, lon]);
  }
  pts.push([61.2, -149.9], [64.8, -147.7], [58.3, -134.4]);
  return pts;
}

/* ------------------------------------------------------------------ small helpers */

export function nowOf(deps) {
  const n = deps && deps.nowMs;
  if (typeof n === 'function') return n();
  if (typeof n === 'number' && isFinite(n)) return n;
  return Date.now();
}

export function num(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    const n = Number(v);
    return isFinite(n) ? n : null;
  }
  return null;
}

export function round(v, dp) {
  if (v === null || v === undefined) return null;
  const n = num(v);
  if (n === null) return null;
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

/*
 * adsb.lol and adsb.fi report alt_baro as the STRING "ground" for roughly a tenth of the
 * aircraft in a busy tile. Every numeric read has to survive that.
 */
export function isGroundAlt(v) {
  return typeof v === 'string' && v.trim().toLowerCase() === 'ground';
}

export function altFeet(v) {
  if (isGroundAlt(v)) return null;
  return num(v);
}

export function clampLat(v) { return Math.max(-90, Math.min(90, v)); }

/*
 * Arithmetic, never a loop. `while (x > 180) x -= 360` cannot terminate once the value is
 * large enough that subtracting 360 changes nothing (1e30 - 360 === 1e30), and an infinite
 * loop is not an exception, so the try/catch around the cron would never see it: the
 * invocation would burn its CPU limit and the jam ring, the TFRs and the NOTAM sweep would
 * all stop being written. Values already in range keep their exact bits.
 */
export function wrapLon(v) {
  if (typeof v !== 'number' || !isFinite(v)) return NaN;
  if (v >= -180 && v <= 180) return v;
  return ((v + 180) % 360 + 360) % 360 - 180;
}

/* ------------------------------------------------------------------ aircraft tiles */

/*
 * One row per aircraft, matching the spec order:
 * [lat, lon, alt_baro_ft, gs_kt, track_deg, tas_kt, mag_heading_deg, nac_p, nic, wd, ws]
 * Lat and lon keep 3 decimals (about 100 m, enough to bin and to draw); everything else keeps
 * 1 decimal. Aircraft on the ground, or with no usable position or altitude, are skipped and
 * counted separately so the tile totals stay honest.
 */
/*
 * The three transponder codes that mean an emergency: 7500 unlawful interference, 7600 lost
 * radio, 7700 general emergency. A code is a SETTING, not a confirmed emergency, and it is
 * often set by mistake and cleared seconds later; nothing downstream may say more than that.
 */
export const EMERGENCY_SQUAWKS = ['7500', '7600', '7700'];

export function squawkStr(v) {
  if (typeof v === 'number' && isFinite(v)) v = String(Math.round(v));
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return /^[0-7]{4}$/.test(s) ? s : null;
}

export function emergencyStr(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (!s || s === 'none') return null;          /* readsb writes "none" for the normal case */
  return s.length <= 16 ? s : null;
}

export function flightStr(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s.length <= 12 ? s : null;
}

/*
 * Is this row worth carrying a callsign and a squawk for? Only when something is flagged.
 * Three extra columns on every row would add roughly 30 KB to a snapshot that a visitor
 * downloads every cron, for a field only the emergency sight ever reads, so the columns are
 * present when they say something and ABSENT otherwise. A shorter row is not an error:
 * planeObj reads by index and hands back null for a column the relay did not send.
 */
export function planeFlagged(a) {
  return !!(emergencyStr(a && a.emergency) ||
            EMERGENCY_SQUAWKS.indexOf(squawkStr(a && a.squawk)) >= 0);
}

export function planeRow(a) {
  if (!a || typeof a !== 'object') return null;
  const lat = num(a.lat);
  const lon = num(a.lon);
  if (lat === null || lon === null) return null;
  /* An aircraft is somewhere on this planet. A row outside that is upstream corruption,
     and it is refused here so nothing downstream has to defend against it (round() on a
     huge value can also reach Infinity, which no consumer handles). */
  if (lat < -90 || lat > 90 || lon < -360 || lon > 360) return null;
  const alt = altFeet(a.alt_baro);
  if (alt === null) return null;
  const row = [
    round(lat, 3), round(lon, 3), round(alt, 1),
    round(a.gs, 1), round(a.track, 1),
    round(a.tas, 1), round(a.mag_heading, 1),
    num(a.nac_p), num(a.nic),
    round(a.wd, 1), round(a.ws, 1),
  ];
  if (planeFlagged(a)) {
    row.push(emergencyStr(a.emergency), squawkStr(a.squawk), flightStr(a.flight));
  }
  return row;
}

export function aircraftList(json) {
  if (!json || typeof json !== 'object') return null;
  if (Array.isArray(json.ac)) return json.ac;            /* adsb.lol v2, adsb.fi v3, readsb */
  if (Array.isArray(json.aircraft)) return json.aircraft; /* adsb.fi v2 */
  return null;
}

export function parseTile(json) {
  const list = aircraftList(json);
  if (!list) throw new Error('no aircraft array in upstream payload');
  const planes = [];
  let ground = 0;
  let skipped = 0;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a && isGroundAlt(a.alt_baro)) { ground++; continue; }
    const row = planeRow(a);
    if (row) planes.push(row); else skipped++;
  }
  const total = num(json.total);
  const count = total !== null ? total : (num(json.resultCount) !== null ? num(json.resultCount) : list.length);
  return { planes: planes, total: count, ground: ground, skipped: skipped };
}

export function tileUrl(base, lat, lon, distNm) {
  return base + '/lat/' + round(lat, 4) + '/lon/' + round(lon, 4) + '/dist/' + Math.round(distNm);
}

async function fetchUpstream(deps, url, init, budget) {
  if (budget) {
    if (budget.left <= 0) throw new Error('subrequest budget exhausted');
    budget.left -= 1;
    budget.used = (budget.used || 0) + 1;
  }
  const headers = Object.assign({
    'User-Agent': USER_AGENT,
    'Accept': (init && init.accept) || 'application/json',
  }, (init && init.headers) || {});
  const opts = { headers: headers, method: 'GET' };
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    opts.signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  }
  const res = await deps.fetchFn(url, opts);
  if (!res || !res.ok) {
    const err = new Error('upstream status ' + (res && res.status) + refusalHeaders(res) + ' for ' + url);
    err.status = res ? res.status : null;
    throw err;
  }
  return res;
}

/*
 * The headers that say WHY an upstream refused (2026-10-11): whether a rate limit names a wait,
 * whether a Cloudflare zone challenged or blocked the Worker, and who answered. Each value is
 * cut to 40 characters; a header that is absent adds nothing, and a response with no headers
 * object at all (a test stub) adds nothing either.
 */
function refusalHeaders(res) {
  const h = res && res.headers;
  if (!h || typeof h.get !== 'function') return '';
  let out = '';
  const names = ['retry-after', 'cf-mitigated', 'server'];
  for (let i = 0; i < names.length; i++) {
    let v = null;
    try { v = h.get(names[i]); } catch (e) { v = null; }
    if (v !== null && v !== undefined && String(v) !== '') out += ' ' + names[i] + '=' + String(v).slice(0, 40);
  }
  return out;
}

async function fetchUpstreamJson(deps, url, init, budget) {
  const res = await fetchUpstream(deps, url, init, budget);
  return await res.json();
}

async function fetchUpstreamText(deps, url, init, budget) {
  const res = await fetchUpstream(deps, url, Object.assign({ accept: 'application/xml' }, init || {}), budget);
  return await res.text();
}

/*
 * One tile: adsb.lol first, adsb.fi as the per-tile fallback. Any failure is caught here so a
 * single bad tile can never take the cron down; the tile is written with ok: false and the
 * client shows coverage honestly.
 */
export async function fetchTile(deps, tile, budget) {
  const out = { clat: tile.lat, clon: tile.lon, region: tile.region, ok: false, src: null, planes: [] };
  const lol = await trySource(deps, 'adsb.lol', tileUrl(ADSB_LOL_BASE, tile.lat, tile.lon, TILE_DIST_NM), budget);
  if (lol.parsed) {
    return Object.assign(out, { ok: true, src: 'adsb.lol', planes: lol.parsed.planes, total: lol.parsed.total, ground: lol.parsed.ground });
  }
  out.err = lol.err;
  if (lol.status !== null) out.status = lol.status;
  const fi = await trySource(deps, 'adsb.fi', tileUrl(ADSB_FI_BASE, tile.lat, tile.lon, TILE_DIST_NM), budget);
  if (fi.parsed) {
    return Object.assign(out, { ok: true, src: 'adsb.fi', planes: fi.parsed.planes, total: fi.parsed.total, ground: fi.parsed.ground });
  }
  out.err2 = fi.err;
  if (fi.status !== null) out.status2 = fi.status;
  return out;
}

/*
 * One source for one tile, behind the refusal breaker. The breaker's counts live on the
 * budget object, which is per cron, so a skipped source is asked again on the next cron. A
 * skipped source makes no call; its tile error still opens with the status that tripped the
 * breaker, so every failed tile says why in the same words a refused call does.
 */
async function trySource(deps, src, url, budget) {
  const br = budget ? (budget.refusals || (budget.refusals = {})) : null;
  const b = br ? (br[src] || (br[src] = { run: 0, last: null, skip: false })) : null;
  if (b && b.skip) {
    return { parsed: null, status: b.last,
             err: 'upstream status ' + b.last + ', ' + src + ' skipped for the rest of this cron after ' +
                  REFUSALS_TO_SKIP + ' refusals in a row' };
  }
  await spaceSource(deps, src, budget);
  try {
    const json = await fetchUpstreamJson(deps, url, null, budget);
    const parsed = parseTile(json);
    if (b) b.run = 0;
    return { parsed: parsed, status: null, err: null };
  } catch (e) {
    const status = (e && typeof e.status === 'number') ? e.status : null;
    if (b) {
      if (status !== null && REFUSAL_STATUSES.indexOf(status) >= 0) {
        b.run += 1;
        b.last = status;
        if (b.run >= REFUSALS_TO_SKIP) b.skip = true;
      } else {
        b.run = 0;
      }
    }
    return { parsed: null, status: status, err: String((e && e.message) || e) };
  }
}

/* Wait out the source's own minimum spacing since its previous call in this cron (the times live
   on the per-cron budget object, beside the breaker), then stamp this call's start. A round may
   carry its own table as budget.minSpacingMs (2026-10-11, second pass: the collector spaces
   adsb.lol at 1 s, because a runner is one address); the Worker's budget carries none. */
async function spaceSource(deps, src, budget) {
  if (!budget) return;
  const last = budget.lastCallMs || (budget.lastCallMs = {});
  const own = budget.minSpacingMs;
  const min = (own && typeof own[src] === 'number') ? own[src] : (SOURCE_MIN_SPACING_MS[src] || 0);
  if (typeof last[src] === 'number') {
    const wait = min - (nowOf(deps) - last[src]);
    if (wait > 0) await ((deps && deps.sleep) || defaultSleep)(wait);
  }
  last[src] = nowOf(deps);
}

export async function collectTiles(deps, budget) {
  const tiles = [];
  const sleep = (deps && deps.sleep) || defaultSleep;
  for (let i = 0; i < TILES.length; i++) {
    if (i > 0) await sleep(TILE_SPACING_MS);
    if (budget && budget.left <= 2) {
      tiles.push({ clat: TILES[i].lat, clon: TILES[i].lon, region: TILES[i].region, ok: false, err: 'subrequest budget exhausted', planes: [] });
      continue;
    }
    tiles.push(await fetchTile(deps, TILES[i], budget));
  }
  return tiles;
}

function defaultSleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

/* ------------------------------------------------------------------ jamming aggregation */

export function binIndex(lat, lon, deg) {
  const d = deg || JAM_BIN_DEG;
  /* Same rule as planeRow, repeated here because bins can also be rebuilt from a stored
     ring: a coordinate that is not on this planet gets no bin at all. Folding it would be
     arithmetically tidy and still a fabricated place. */
  if (typeof lat !== 'number' || !isFinite(lat) || lat < -90 || lat > 90) return null;
  if (typeof lon !== 'number' || !isFinite(lon) || lon < -360 || lon > 360) return null;
  const wl = wrapLon(lon);
  if (!isFinite(wl)) return null;
  const la = Math.floor((clampLat(lat) + 90) / d);
  const lo = Math.floor((wl + 180) / d);
  return [Math.min(la, Math.floor(180 / d) - 1), Math.min(lo, Math.floor(360 / d) - 1)];
}

/* null when the position cannot be binned; sampleBins skips those rows rather than
   inventing a "NaN:NaN" bin that would sit in KV forever. */
export function binKey(lat, lon, deg) {
  const ij = binIndex(lat, lon, deg);
  if (!ij) return null;
  return ij[0] + ':' + ij[1];
}

export function binCenter(key, deg) {
  const d = deg || JAM_BIN_DEG;
  const parts = String(key).split(':');
  const la = Number(parts[0]);
  const lo = Number(parts[1]);
  return [la * d - 90 + d / 2, lo * d - 180 + d / 2];
}

/*
 * One 5-minute sample: how many aircraft reported nac_p in each bin, and how many of those
 * reported a degraded value. Aircraft that do not report nac_p at all are not counted either
 * way, so the fraction stays meaningful.
 */
export function sampleBins(tiles, deg) {
  const bins = {};
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (!t || !t.ok || !Array.isArray(t.planes)) continue;
    for (let j = 0; j < t.planes.length; j++) {
      const p = t.planes[j];
      const nacp = p[7];
      if (nacp === null || nacp === undefined) continue;
      const k = binKey(p[0], p[1], deg);
      if (k === null) continue;
      const cur = bins[k] || (bins[k] = [0, 0]);
      cur[0] += 1;
      if (nacp <= NACP_LOW_MAX) cur[1] += 1;
    }
  }
  return bins;
}

function copyBins(bins) {
  const out = {};
  const keys = Object.keys(bins || {});
  for (let i = 0; i < keys.length; i++) out[keys[i]] = [bins[keys[i]][0], bins[keys[i]][1]];
  return out;
}

function mergeBins(into, from) {
  const keys = Object.keys(from);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const cur = into[k] || (into[k] = [0, 0]);
    cur[0] += from[k][0];
    cur[1] += from[k][1];
  }
  return into;
}

/*
 * Roll the ring buffers: twelve 5-minute buckets for the last hour, twenty four hourly
 * buckets for the last day. A repeated cron inside the same 5-minute slot merges into the
 * open bucket instead of creating a second one.
 */
export function rollJam(prev, sample, nowMs) {
  const binDeg = (prev && prev.binDeg) || JAM_BIN_DEG;
  const buckets = (prev && Array.isArray(prev.buckets)) ? prev.buckets.slice() : [];
  const daily = (prev && Array.isArray(prev.daily)) ? prev.daily.slice() : [];

  /* Never mutate the value handed in: the caller may still be holding the previous ring. */
  const bt = Math.floor(nowMs / JAM_BUCKET_MS) * JAM_BUCKET_MS;
  const last = buckets.length ? buckets[buckets.length - 1] : null;
  if (last && last.t === bt) {
    buckets[buckets.length - 1] = { t: bt, bins: mergeBins(copyBins(last.bins), sample) };
  } else {
    buckets.push({ t: bt, bins: copyBins(sample) });
  }

  const ht = Math.floor(nowMs / 3600000) * 3600000;
  const lastH = daily.length ? daily[daily.length - 1] : null;
  if (lastH && lastH.t === ht) {
    daily[daily.length - 1] = { t: ht, bins: mergeBins(copyBins(lastH.bins), sample) };
  } else {
    daily.push({ t: ht, bins: copyBins(sample) });
  }

  while (buckets.length > JAM_BUCKETS_1H) buckets.shift();
  while (daily.length > JAM_HOURS_24H) daily.shift();

  return { t: nowMs, binDeg: binDeg, buckets: buckets, daily: daily };
}

/*
 * The /jam payload: one row per bin, [latCenter, lonCenter, n1h, nLow1h, n24h, nLow24h].
 * The client decides what counts as bad; the antenna only counts.
 */
export function summarizeJam(agg, nowMs) {
  const binDeg = (agg && agg.binDeg) || JAM_BIN_DEG;
  const h1 = {};
  const h24 = {};
  const buckets = (agg && agg.buckets) || [];
  const daily = (agg && agg.daily) || [];
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i].t >= nowMs - 3600000 - JAM_BUCKET_MS) mergeBins(h1, buckets[i].bins);
  }
  for (let i = 0; i < daily.length; i++) {
    if (daily[i].t >= nowMs - 24 * 3600000) mergeBins(h24, daily[i].bins);
  }
  const keys = Object.keys(Object.assign({}, h1, h24));
  const rows = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const c = binCenter(k, binDeg);
    const a = h1[k] || [0, 0];
    const b = h24[k] || [0, 0];
    rows.push([round(c[0], 3), round(c[1], 3), a[0], a[1], b[0], b[1]]);
  }
  rows.sort(function (p, q) { return (q[2] - p[2]) || (q[4] - p[4]); });
  return {
    t: (agg && agg.t) || nowMs,
    binDeg: binDeg,
    buckets: buckets.length,
    hours: daily.length,
    bins: rows,
  };
}

/* ------------------------------------------------------------------ TFR list and geometry */

export function tfrDetailUrl(notamId) {
  return TFR_DETAIL_BASE + String(notamId).replace(/\//g, '_') + '.xml';
}

export function tfrNeedsGeometry(type) {
  const t = String(type || '').toUpperCase();
  for (let i = 0; i < TFR_ENRICH_PREFIXES.length; i++) {
    if (t.indexOf(TFR_ENRICH_PREFIXES[i]) === 0) return true;
  }
  return false;
}

/*
 * FAA coordinates in the TFR detail XML come as "39.95009188N" or "117.675W" (decimal degrees
 * with a hemisphere letter). Older records use packed degrees-minutes-seconds, "393000N" or
 * "0743000W", so both are handled. isLon decides how many leading digits are the degrees.
 */
export function parseGeoCoord(raw, isLon) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase();
  const m = s.match(/^([0-9.]+)\s*([NSEW])$/);
  if (!m) return null;
  const body = m[1];
  const sign = (m[2] === 'S' || m[2] === 'W') ? -1 : 1;
  let deg = null;
  if (/^\d{1,3}(\.\d+)?$/.test(body)) {
    deg = Number(body);
  } else if (/^\d{4,9}(\.\d+)?$/.test(body)) {
    const dLen = isLon ? 3 : 2;
    const intPart = body.split('.')[0];
    if (intPart.length < dLen + 2) return null;
    const d = Number(intPart.slice(0, dLen));
    const mi = Number(intPart.slice(dLen, dLen + 2));
    const rest = body.slice(dLen + 2);
    const se = rest ? Number(rest) : 0;
    if (!isFinite(d) || !isFinite(mi) || !isFinite(se)) return null;
    deg = d + mi / 60 + se / 3600;
  }
  if (deg === null || !isFinite(deg)) return null;
  const v = sign * deg;
  if (isLon ? (v < -180 || v > 180) : (v < -90 || v > 90)) return null;
  return v;
}

function xmlTag(xml, tag) {
  const m = xml.match(new RegExp('<' + tag + '>([^<]*)</' + tag + '>'));
  return m ? m[1].trim() : null;
}

function xmlBlocks(xml, tag) {
  const out = [];
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'g');
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/*
 * Parse one TFR detail document into shapes. Verified live 2026-08-15 against notam 6/5250
 * (polygon plus circle), 6/4583 (VIP, 112 vertices) and 6/5153 (polygon only).
 * Shapes come from <Abd> and <abdMergedArea> blocks; each <Avx> vertex is either a great
 * circle polygon point (codeType GRC and friends) or a circle (codeType CIR with
 * valRadiusArc). Duplicate shapes across blocks are dropped.
 */
export function parseTfrDetail(xml, opts) {
  if (typeof xml !== 'string' || xml.length < 20) throw new Error('empty TFR detail document');
  const maxPts = (opts && opts.maxPts) || 400;
  const blocks = xmlBlocks(xml, 'abdMergedArea').concat(xmlBlocks(xml, 'Abd'));
  const shapes = [];
  const seen = {};
  for (let b = 0; b < blocks.length; b++) {
    const verts = xmlBlocks(blocks[b], 'Avx');
    const poly = [];
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      const type = (xmlTag(v, 'codeType') || '').toUpperCase();
      const lat = parseGeoCoord(xmlTag(v, 'geoLat'), false);
      const lon = parseGeoCoord(xmlTag(v, 'geoLong'), true);
      if (lat === null || lon === null) continue;
      if (type === 'CIR') {
        const r = num(xmlTag(v, 'valRadiusArc'));
        const uom = (xmlTag(v, 'uomRadiusArc') || 'NM').toUpperCase();
        if (r === null || r <= 0) continue;
        const nm = uom === 'KM' ? r / 1.852 : (uom === 'M' ? r / 1852 : r);
        const shape = { kind: 'circle', lat: round(lat, 5), lon: round(lon, 5), radiusNm: round(nm, 2) };
        const key = 'c' + shape.lat + ',' + shape.lon + ',' + shape.radiusNm;
        if (!seen[key]) { seen[key] = 1; shapes.push(shape); }
      } else if (poly.length < maxPts) {
        poly.push([round(lat, 5), round(lon, 5)]);
      }
    }
    if (poly.length >= 3) {
      const key = 'p' + poly.length + ',' + poly[0][0] + ',' + poly[0][1] + ',' + poly[poly.length - 1][0];
      if (!seen[key]) { seen[key] = 1; shapes.push({ kind: 'poly', pts: poly }); }
    }
  }
  const center = shapeCenter(shapes[0]);
  return {
    shapes: shapes,
    center: center,
    approx: false,
    source: 'tfr.faa.gov detail',
    city: xmlTag(xml, 'txtNameCity'),
    state: xmlTag(xml, 'txtNameUSState'),
    purpose: xmlTag(xml, 'txtDescrPurpose'),
    effective: xmlTag(xml, 'dateEffective'),
    expire: xmlTag(xml, 'dateExpire'),
    tz: xmlTag(xml, 'codeTimeZone'),
    upperFt: num(xmlTag(xml, 'valDistVerUpper')),
  };
}

export function shapeCenter(shape) {
  if (!shape) return null;
  if (shape.kind === 'circle') return [shape.lat, shape.lon];
  if (shape.kind === 'poly' && shape.pts && shape.pts.length) {
    let la = 0;
    let lo = 0;
    for (let i = 0; i < shape.pts.length; i++) { la += shape.pts[i][0]; lo += shape.pts[i][1]; }
    return [round(la / shape.pts.length, 5), round(lo / shape.pts.length, 5)];
  }
  return null;
}

/* The fallback: a state centroid, always flagged approx so the page can say "somewhere in Nevada". */
export function centroidGeo(state) {
  const key = String(state || '').trim().toUpperCase();
  const c = STATE_CENTROIDS[key];
  if (!c) return { shapes: [], center: null, approx: true, source: 'unknown location' };
  return { shapes: [], center: [c[0], c[1]], approx: true, source: 'state centroid' };
}

export function mergeTfrItem(item, geo) {
  const g = geo || centroidGeo(item && item.state);
  return {
    id: item.notam_id,
    type: item.type,
    facility: item.facility,
    state: item.state,
    description: item.description,
    created: item.creation_date,
    center: g.center,
    shapes: g.shapes || [],
    approx: !!g.approx,
    geoSource: g.source || null,
    effective: g.effective || null,
    expire: g.expire || null,
    tz: g.tz || null,
    city: g.city || null,
    purpose: g.purpose || null,
  };
}

/* ------------------------------------------------------------------ GPS NOTAM sweep */

/* FAA NOTAM coordinates look like "2931N09816W" or "293115N0981600W". */
export function parseNotamCoord(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase().replace(/\s+/g, '');
  const m = s.match(/^(\d{4,6})([NS])(\d{5,7})([EW])$/);
  if (!m) return null;
  const lat = dmsPack(m[1], 2);
  const lon = dmsPack(m[3], 3);
  if (lat === null || lon === null) return null;
  const la = (m[2] === 'S' ? -1 : 1) * lat;
  const lo = (m[4] === 'W' ? -1 : 1) * lon;
  if (la < -90 || la > 90 || lo < -180 || lo > 180) return null;
  return [round(la, 5), round(lo, 5)];
}

function dmsPack(digits, degLen) {
  if (digits.length < degLen + 2) return null;
  const d = Number(digits.slice(0, degLen));
  const mi = Number(digits.slice(degLen, degLen + 2));
  const se = digits.length >= degLen + 4 ? Number(digits.slice(degLen + 2, degLen + 4)) : 0;
  if (!isFinite(d) || !isFinite(mi) || !isFinite(se) || mi >= 60 || se >= 60) return null;
  return d + mi / 60 + se / 3600;
}

export const GPS_TEXT_RE = /\b(GPS|GNSS|WAAS)\b/i;

/*
 * Walk a FAA NOTAM API response and pull out every notam object, whatever the wrapper looks
 * like. The response nests items under properties.coreNOTAMData.notam; walking defensively
 * means a wrapper change does not silently empty the layer.
 */
export function collectNotamObjects(node, out, depth) {
  const acc = out || [];
  const d = depth || 0;
  if (!node || typeof node !== 'object' || d > 8) return acc;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) collectNotamObjects(node[i], acc, d + 1);
    return acc;
  }
  if (typeof node.text === 'string' && (node.number || node.id)) {
    acc.push(node);
    return acc;
  }
  const keys = Object.keys(node);
  for (let i = 0; i < keys.length; i++) collectNotamObjects(node[keys[i]], acc, d + 1);
  return acc;
}

export function extractGpsNotams(json) {
  const found = collectNotamObjects(json, [], 0);
  const out = [];
  for (let i = 0; i < found.length; i++) {
    const n = found[i];
    if (!GPS_TEXT_RE.test(n.text)) continue;
    const pos = parseNotamCoord(n.coordinates);
    const radius = num(n.radius);
    out.push({
      number: String(n.number || n.id),
      classification: n.classification || null,
      location: n.location || n.icaoLocation || null,
      center: pos,
      radiusNm: radius,
      start: n.effectiveStart || null,
      end: n.effectiveEnd || null,
      text: String(n.text).slice(0, 600),
    });
  }
  return dedupeNotams(out);
}

export function dedupeNotams(items) {
  const seen = {};
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const k = items[i].number;
    if (!k || seen[k]) continue;
    seen[k] = 1;
    out.push(items[i]);
  }
  return out;
}

export function faaConfigured(deps) {
  const s = (deps && deps.secrets) || {};
  return !!(s.faaClientId && s.faaClientSecret);
}

export function notamQueryUrl(lat, lon, radiusNm) {
  const q = 'locationLatitude=' + round(lat, 4) +
    '&locationLongitude=' + round(lon, 4) +
    '&locationRadius=' + Math.round(radiusNm) +
    '&classification=FDC&pageSize=1000&pageNum=1';
  return FAA_NOTAM_URL + '?' + q;
}

/*
 * One sweep pass: a slice of the grid, rotated between runs so the whole lattice is covered
 * over a day without ever exceeding the subrequest budget of a single invocation.
 */
export async function sweepGpsNotams(deps, budget) {
  if (!faaConfigured(deps)) return { ok: false, offline: true, reason: 'FAA NOTAM credentials are not configured' };
  const t = nowOf(deps);
  const prev = await kvGetJson(deps.kv, 'notams:gps');
  const offset = (prev && num(prev.offset) !== null) ? num(prev.offset) : 0;
  const items = [];
  const errors = [];
  let done = 0;
  for (let i = 0; i < GPS_SWEEP_POINTS_PER_RUN; i++) {
    if (budget && budget.left <= 1) break;
    const pt = GPS_SWEEP_GRID[(offset + i) % GPS_SWEEP_GRID.length];
    try {
      const json = await fetchUpstreamJson(deps, notamQueryUrl(pt[0], pt[1], GPS_SWEEP_RADIUS_NM), {
        headers: { client_id: deps.secrets.faaClientId, client_secret: deps.secrets.faaClientSecret },
      }, budget);
      const got = extractGpsNotams(json);
      for (let j = 0; j < got.length; j++) items.push(got[j]);
      done++;
    } catch (e) {
      errors.push(String((e && e.message) || e));
    }
    if (deps.sleep) await deps.sleep(120);
  }
  const kept = [];
  const prevItems = (prev && Array.isArray(prev.items)) ? prev.items : [];
  for (let i = 0; i < prevItems.length; i++) {
    const p = prevItems[i];
    if (num(p.seen) !== null && t - num(p.seen) < GPS_NOTAM_TTL_MS) kept.push(p);
  }
  const merged = dedupeNotams(items.map(function (it) { return Object.assign({ seen: t }, it); }).concat(kept));
  const payload = {
    t: t,
    sweptPoints: done,
    gridSize: GPS_SWEEP_GRID.length,
    offset: (offset + GPS_SWEEP_POINTS_PER_RUN) % GPS_SWEEP_GRID.length,
    errors: errors.slice(0, 5),
    count: merged.length,
    items: merged,
  };
  await kvPutJson(deps.kv, 'notams:gps', payload);
  return { ok: true, count: merged.length, swept: done };
}

/* ------------------------------------------------------------------ KV helpers */

export async function kvGetJson(kv, key) {
  if (!kv) return null;
  try {
    const raw = await kv.get(key);
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'object') return raw;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

export async function kvPutJson(kv, key, value) {
  if (!kv) return false;
  await kv.put(key, JSON.stringify(value));
  return true;
}

/* ------------------------------------------------------------------ HTTP plumbing */

export function corsHeaders(extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Antenna-Version': VERSION,
  }, extra || {});
}

export function cacheControl(route) {
  if (!route || !route.sMaxAge) return 'no-store';
  return 'public, max-age=' + route.maxAge + ', s-maxage=' + route.sMaxAge;
}

export function jsonResponse(body, opts) {
  const o = opts || {};
  const headers = corsHeaders(Object.assign({ 'Cache-Control': o.cacheControl || 'no-store' }, o.headers || {}));
  return new Response(JSON.stringify(body), { status: o.status || 200, headers: headers });
}

export function routeFor(pathname) {
  let p = String(pathname || '/');
  if (p.length > 1 && p.charAt(p.length - 1) === '/') p = p.slice(0, -1);
  for (let i = 0; i < ROUTES.length; i++) if (ROUTES[i].path === p) return ROUTES[i];
  return null;
}

/*
 * Serve a KV-backed route. Missing value means the cron has not produced one yet, which is an
 * honest 503 with offline: true rather than a fake empty payload. A value older than the
 * route's staleAfterMs is still served, labelled stale with its age.
 */
async function serveKvRoute(route, deps, transform) {
  const t = nowOf(deps);
  const stored = await kvGetJson(deps.kv, route.kv);
  if (!stored) {
    return jsonResponse({
      ok: false, offline: true, route: route.path,
      reason: 'no snapshot has been written yet',
    }, { status: 503 });
  }
  const body = transform ? transform(stored, t) : stored;
  const age = Math.max(0, t - (num(body.t) !== null ? num(body.t) : t));
  const out = Object.assign({ ok: true }, body, { ageMs: age });
  if (age > route.staleAfterMs) out.stale = true;
  return jsonResponse(out, { cacheControl: cacheControl(route) });
}

export async function handlePlanes(deps, url) {
  const route = routeFor('/planes');
  const t = nowOf(deps);
  const snap = await kvGetJson(deps.kv, 'snap:planes');
  if (!snap) {
    return jsonResponse({ ok: false, offline: true, route: '/planes', reason: 'no snapshot has been written yet' }, { status: 503 });
  }
  /*
   * The snapshot only changes once per cron, so a client polling faster than that can send
   * ?since=<t of the copy it holds> and get a few bytes back instead of the whole tile set.
   * ?min_alt=<ft> trims the rows to the altitudes an instrument actually uses.
   */
  const since = url ? num(url.searchParams.get('since')) : null;
  if (since !== null && since === num(snap.t)) {
    return jsonResponse({ ok: true, t: snap.t, unchanged: true, ageMs: Math.max(0, t - snap.t) }, { cacheControl: cacheControl(route) });
  }
  let body = snap;
  const minAlt = url ? num(url.searchParams.get('min_alt')) : null;
  if (minAlt !== null) {
    body = Object.assign({}, snap, {
      minAlt: minAlt,
      tiles: (snap.tiles || []).map(function (tile) {
        if (!tile.planes) return tile;
        return Object.assign({}, tile, { planes: tile.planes.filter(function (p) { return p[2] !== null && p[2] >= minAlt; }) });
      }),
    });
  }
  const age = Math.max(0, t - (num(body.t) !== null ? num(body.t) : t));
  const out = Object.assign({ ok: true }, body, { ageMs: age });
  if (age > route.staleAfterMs) out.stale = true;
  return jsonResponse(out, { cacheControl: cacheControl(route) });
}

export async function handleJam(deps) {
  const route = routeFor('/jam');
  return serveKvRoute(route, deps, function (agg, t) { return summarizeJam(agg, t); });
}

export async function handleTfrs(deps) {
  return serveKvRoute(routeFor('/tfrs'), deps, null);
}

export async function handleNotamsGps(deps) {
  const route = routeFor('/notams/gps');
  if (!faaConfigured(deps)) {
    /*
     * 200, not 503 (r12 item 16). This is not a fault: it is a route that was never
     * switched on, and answering with an error status made every client poll print a
     * network error in the browser console for a state the payload already states
     * honestly. A route whose snapshot is merely missing still answers 503, because
     * that one IS a fault worth surfacing.
     */
    return jsonResponse({
      ok: false, offline: true, route: route.path, configured: false,
      reason: 'the FAA NOTAM API needs a client id and secret, and none are configured yet',
    });
  }
  const stored = await kvGetJson(deps.kv, route.kv);
  if (!stored) {
    return jsonResponse({
      ok: false, offline: true, route: route.path,
      reason: 'the NOTAM sweep has not run yet',
    }, { status: 503 });
  }
  return serveKvRoute(route, deps, null);
}

export async function handleHealth(deps) {
  const t = nowOf(deps);
  const out = { ok: true, t: t, version: VERSION, routes: [], notamsConfigured: faaConfigured(deps) };
  for (let i = 0; i < ROUTES.length; i++) {
    const r = ROUTES[i];
    if (!r.kv) continue;
    const v = await kvGetJson(deps.kv, r.kv);
    const vt = v ? num(v.t) : null;
    out.routes.push({
      path: r.path,
      key: r.kv,
      present: !!v,
      t: vt,
      ageMs: vt === null ? null : Math.max(0, t - vt),
      stale: vt === null ? null : (t - vt) > r.staleAfterMs,
    });
  }
  const snap = await kvGetJson(deps.kv, 'snap:planes');
  if (snap && Array.isArray(snap.tiles)) {
    let ok = 0;
    let planes = 0;
    for (let i = 0; i < snap.tiles.length; i++) {
      if (snap.tiles[i].ok) ok++;
      planes += (snap.tiles[i].planes || []).length;
    }
    out.tiles = { ok: ok, total: snap.tiles.length, planes: planes };
    /* 2026-10-11 (the collector): who wrote it, when a collector did (the Worker never names itself) */
    if (typeof snap.writer === 'string' && snap.writer) out.tiles.writer = snap.writer;
  }
  return jsonResponse(out, { cacheControl: 'no-store' });
}

export async function handleRequest(request, deps) {
  const method = (request && request.method) || 'GET';
  const url = new URL(request.url);
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders({ 'Cache-Control': 'no-store' }) });
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return jsonResponse({ ok: false, error: 'only GET is supported' }, { status: 405 });
  }
  const route = routeFor(url.pathname);
  if (!route) {
    return jsonResponse({
      ok: false, error: 'unknown route',
      routes: ROUTES.map(function (r) { return r.path; }),
    }, { status: 404 });
  }
  try {
    if (route.path === '/planes') return await handlePlanes(deps, url);
    if (route.path === '/jam') return await handleJam(deps);
    if (route.path === '/tfrs') return await handleTfrs(deps);
    if (route.path === '/notams/gps') return await handleNotamsGps(deps);
    return await handleHealth(deps);
  } catch (e) {
    /* A route never 500s on upstream or storage trouble: say what happened and stay up. */
    return jsonResponse({ ok: false, offline: true, route: route.path, reason: String((e && e.message) || e) }, { status: 503 });
  }
}

/* ------------------------------------------------------------------ cron */

export async function refreshTfrs(deps, budget) {
  const t = nowOf(deps);
  const list = await fetchUpstreamJson(deps, TFR_LIST_URL, null, budget);
  if (!Array.isArray(list)) throw new Error('TFR list was not an array');
  const prev = await kvGetJson(deps.kv, 'tfrs');
  const items = [];
  let fetched = 0;
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (!it || !it.notam_id) continue;
    const geoKey = 'tfrgeo:' + it.notam_id;
    let geo = await kvGetJson(deps.kv, geoKey);
    const failed = geo && geo.fail;
    const retryOk = failed && (t - (num(geo.t) || 0) > TFR_FAIL_RETRY_MS) && (num(geo.tries) || 0) < TFR_FAIL_MAX_TRIES;
    if ((!geo || retryOk) && tfrNeedsGeometry(it.type) &&
        fetched < MAX_TFR_DETAIL_PER_CRON && (!budget || budget.left > 2)) {
      fetched++;
      try {
        const xml = await fetchUpstreamText(deps, tfrDetailUrl(it.notam_id), null, budget);
        const parsed = parseTfrDetail(xml);
        if (parsed.shapes.length) {
          geo = parsed;
          await kvPutJson(deps.kv, geoKey, geo);
        } else {
          geo = { fail: true, t: t, tries: (num(geo && geo.tries) || 0) + 1, reason: 'no geometry in detail document' };
          await kvPutJson(deps.kv, geoKey, geo);
        }
      } catch (e) {
        geo = { fail: true, t: t, tries: (num(geo && geo.tries) || 0) + 1, reason: String((e && e.message) || e) };
        await kvPutJson(deps.kv, geoKey, geo);
      }
      if (deps.sleep) await deps.sleep(TILE_SPACING_MS);
    }
    const usable = (geo && !geo.fail) ? geo : centroidGeo(it.state);
    items.push(mergeTfrItem(it, usable));
  }
  /*
   * Write skip: the TFR list barely moves between crons, and the free plan allows a thousand
   * KV writes a day. If the enriched items are byte identical, leave the stored value alone.
   */
  const prevBody = prev && prev.items ? JSON.stringify(prev.items) : null;
  const nextBody = JSON.stringify(items);
  if (prevBody === nextBody) {
    return { written: false, count: items.length, detailFetched: fetched };
  }
  await kvPutJson(deps.kv, 'tfrs', { t: t, count: items.length, items: items });
  return { written: true, count: items.length, detailFetched: fetched };
}

/*
 * 2026-10-11 (the collector). adsb.lol answers 429 and adsb.fi 403 to Cloudflare's shared egress,
 * so the aircraft tiles are gathered OUTSIDE Cloudflare: antenna/collect.mjs, run by the GitHub
 * Actions workflow .github/workflows/collect-antenna.yml every ten minutes, runs
 * runAircraftPhase below (the very function runCron runs) and writes snap:planes and agg:jam
 * into this Worker's KV through the Cloudflare KV REST API. A collector's snapshot names its
 * writer; the Worker's own never does. While a collector snapshot is younger than
 * COLLECTOR_FRESH_MS, runCron leaves the aircraft to it and spends its calls on the TFRs; when
 * the stored snapshot is older, absent or the Worker's own, runCron runs its own round as before
 * (the fallback).
 */
export const COLLECTOR_FRESH_MS = 25 * 60 * 1000;
/* Second pass: a writer snapshot whose t is more than this far AHEAD of the cron's clock is a
   skewed clock, not a fresh collector: it is treated as absent (the Worker runs its round, and the
   newer-t guard does not protect it). Within it, the age is clamped at 0. */
export const COLLECTOR_SKEW_MS = 5 * 60 * 1000;
/* A round that reaches fewer than this share of the tiles is a DARK round (the page's
   K.RELAY_DARK_FRAC is the same quarter): the collector writes nothing from one, and the Worker
   never replaces a collector's snapshot with one. */
export const RELAY_DARK_FRAC = 0.25;
export function tilesNeeded(total) { return Math.ceil(total * RELAY_DARK_FRAC); }

/*
 * The fields ahead of `tiles` in the stored snapshot (t, distNm, tilesOk, tilesTotal, planes and a
 * collector's writer), read WITHOUT parsing the tile array: runCron reads it every cron, a free
 * plan cron has 10 ms of CPU, and a full snapshot is about 650 KB of JSON. Both writers put
 * `tiles` last, so the head is the text before the first ',"tiles":'. A value that does not cut
 * that way is parsed whole; a failed read or parse is null, as in kvGetJson.
 */
export async function snapHead(kv) {
  if (!kv) return null;
  let raw = null;
  try { raw = await kv.get('snap:planes'); } catch (e) { return null; }
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw;
  const s = String(raw);
  const cut = s.indexOf(',"tiles":');
  if (cut > 0) {
    try {
      const head = JSON.parse(s.slice(0, cut) + '}');
      if (head && typeof head === 'object') return head;
    } catch (e) { /* not cut where expected: parse it whole below */ }
  }
  try { return JSON.parse(s); } catch (e) { return null; }
}

/* The age in ms of a stored snapshot the Worker defers to, else null: it names a writer (only a
   collector does), carries a numeric t no more than COLLECTOR_SKEW_MS ahead of the clock, and is
   younger than COLLECTOR_FRESH_MS. The age is clamped at 0. */
export function collectorAgeMs(head, t) {
  if (!head || typeof head.writer !== 'string' || !head.writer) return null;
  const st = num(head.t);
  if (st === null) return null;
  const age = t - st;
  if (age < -COLLECTOR_SKEW_MS) return null;
  const a = Math.max(0, age);
  return a < COLLECTOR_FRESH_MS ? a : null;
}

/* Why a finished round must leave snap:planes (and with it agg:jam) alone, or null to write. */
async function aircraftWriteSkip(deps, t, ok, total, o) {
  if (typeof o.minTilesOk === 'number' && ok < o.minTilesOk) {
    return 'not written: the round reached ' + ok + ' of ' + total + ' tiles, fewer than ' + o.minTilesOk;
  }
  const head = await snapHead(deps.kv);
  const st = head ? num(head.t) : null;
  if (st !== null && st > t && st - t <= COLLECTOR_SKEW_MS) {
    return 'not written: a newer snapshot is stored (t ' + st + ', this round ' + t + ')';
  }
  if (o.yieldToCollector) {
    const age = collectorAgeMs(head, t);
    if (age !== null) {
      return 'not written: a collector snapshot landed during this round, age ' + Math.round(age / 1000) + ' s';
    }
  }
  /* Second pass: a dark round never replaces a collector's snapshot, whatever its age. The route
     serves that snapshot's age honestly; a dark overwrite would only erase good data. */
  if (o.keepWriterOverDark && ok < tilesNeeded(total) && head && typeof head.writer === 'string' && head.writer) {
    return 'not written: this round reached ' + ok + ' of ' + total + ' tiles, so the ' + head.writer +
      ' snapshot (age ' + (st === null ? '?' : Math.round(Math.max(0, t - st) / 1000)) + ' s) is kept';
  }
  return null;
}

/*
 * The aircraft phase: the 24 tiles (spacing, breaker and budget exactly as collectTiles has
 * them), the snap:planes write, then the agg:jam roll. runCron and antenna/collect.mjs both run
 * this one function, so a collector's snapshot has the Worker's shape by construction. t is the
 * round's start: the snapshot's t and the jam slot. opts, all optional (runCron passes only
 * yieldToCollector and keepWriterOverDark, so a healthy Worker round writes exactly the bytes it
 * always wrote):
 *   extra             fields set on the snapshot ahead of `tiles` (the collector's writer)
 *   minTilesOk        a round that reached fewer tiles writes nothing (the collector's rule, so
 *                     a refused collector never holds the Worker's own round off)
 *   yieldToCollector  also leave alone a fresh collector snapshot that landed during the round
 *   keepWriterOverDark  a round under a quarter of the tiles never replaces a snapshot that names
 *                     a writer, whatever its age (the Worker's rule, second pass)
 * The result: tiles { ok, total, planes } once reached, jam, errors, skipped (why nothing was
 * written) and tileList (the tiles themselves, which collect.mjs prints; runCron ignores it).
 * Whoever runs it, a stored snapshot with a NEWER t is never overwritten, and a round that
 * leaves the snapshot alone leaves the jam ring alone too (the newer writer rolled that slot).
 * KV is eventually consistent (a write can take about a minute to reach every location), so
 * these checks hold for writes more than about a minute apart, which a ten minute cadence is.
 */
export async function runAircraftPhase(deps, budget, t, opts) {
  const o = opts || {};
  const out = { tiles: null, jam: null, errors: [], skipped: null, tileList: null };
  try {
    const tiles = await collectTiles(deps, budget);
    out.tileList = tiles;
    let ok = 0;
    let planes = 0;
    for (let i = 0; i < tiles.length; i++) { if (tiles[i].ok) ok++; planes += (tiles[i].planes || []).length; }
    const skip = await aircraftWriteSkip(deps, t, ok, tiles.length, o);
    if (skip) {
      out.tiles = { ok: ok, total: tiles.length, planes: planes };
      out.skipped = skip;
      return out;
    }
    const snap = { t: t, distNm: TILE_DIST_NM, tilesOk: ok, tilesTotal: tiles.length, planes: planes };
    if (o.extra) Object.assign(snap, o.extra);
    snap.tiles = tiles;
    await kvPutJson(deps.kv, 'snap:planes', snap);
    out.tiles = { ok: ok, total: tiles.length, planes: planes };
    try {
      const prev = await kvGetJson(deps.kv, 'agg:jam');
      const agg = rollJam(prev, sampleBins(tiles, JAM_BIN_DEG), t);
      await kvPutJson(deps.kv, 'agg:jam', agg);
      out.jam = { buckets: agg.buckets.length, hours: agg.daily.length };
    } catch (e) {
      out.errors.push('jam: ' + String((e && e.message) || e));
    }
  } catch (e) {
    out.errors.push('tiles: ' + String((e && e.message) || e));
  }
  return out;
}

/*
 * The cron body. Each stage is isolated: a dead upstream in one stage leaves the others alone,
 * and every stage writes at most one KV key.
 */
export async function runCron(deps) {
  const t = nowOf(deps);
  const budget = { left: MAX_SUBREQUESTS, used: 0 };
  const result = { t: t, errors: [], tiles: null, jam: null, tfrs: null, notams: null };

  /* 2026-10-11 (the collector): a fresh collector snapshot means the tiles were gathered where
     the upstreams answer, so this cron leaves the aircraft to it (no tile call, no snapshot or
     jam write) and its whole budget goes to the TFRs. Otherwise its own round runs, as always. */
  const deferAge = collectorAgeMs(await snapHead(deps.kv), t);
  if (deferAge !== null) {
    result.aircraft = 'deferred to the collector, age ' + Math.round(deferAge / 1000) + ' s';
  } else {
    const air = await runAircraftPhase(deps, budget, t, { yieldToCollector: true, keepWriterOverDark: true });
    result.tiles = air.tiles;
    result.jam = air.jam;
    for (let i = 0; i < air.errors.length; i++) result.errors.push(air.errors[i]);
    if (air.skipped) result.aircraft = air.skipped;
  }

  try {
    result.tfrs = await refreshTfrs(deps, budget);
  } catch (e) {
    result.errors.push('tfrs: ' + String((e && e.message) || e));
  }

  try {
    if (faaConfigured(deps)) {
      const prev = await kvGetJson(deps.kv, 'notams:gps');
      const last = prev ? num(prev.t) : null;
      if (last === null || (t - last) >= GPS_SWEEP_INTERVAL_MS) {
        result.notams = await sweepGpsNotams(deps, budget);
      } else {
        result.notams = { skipped: true, nextInMs: GPS_SWEEP_INTERVAL_MS - (t - last) };
      }
    } else {
      result.notams = { offline: true };
    }
  } catch (e) {
    result.errors.push('notams: ' + String((e && e.message) || e));
  }

  result.subrequests = budget.used;
  return result;
}

/* ------------------------------------------------------------------ bindings */

export function makeDeps(env, over) {
  const e = env || {};
  const o = over || {};
  return {
    fetchFn: o.fetchFn || function (u, i) { return fetch(u, i); },
    kv: o.kv || e.OBS_KV || null,
    nowMs: o.nowMs || function () { return Date.now(); },
    sleep: o.sleep || defaultSleep,
    secrets: o.secrets || { faaClientId: e.FAA_CLIENT_ID || '', faaClientSecret: e.FAA_CLIENT_SECRET || '' },
  };
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, makeDeps(env, null));
  },
  async scheduled(event, env, ctx) {
    const p = runCron(makeDeps(env, null)).then(function (result) {
      /* 2026-10-11: one line per cron in Workers Logs ([observability] is on in
         wrangler.toml). The result carries no secret. */
      console.log(cronLogLine(result));
      return result;
    });
    if (ctx && ctx.waitUntil) ctx.waitUntil(p);
    await p;
  },
};

/* The cron's result as one JSON line: tiles reached, planes, calls used, TFR details fetched, and
   (2026-10-11) why the aircraft were left alone when they were, e.g. "deferred to the collector,
   age 312 s". */
export function cronLogLine(result) {
  const r = result || {};
  const tiles = r.tiles || {};
  const tfrs = r.tfrs || {};
  return JSON.stringify({
    cron: 'antenna', t: r.t, tilesOk: tiles.ok, tilesTotal: tiles.total, planes: tiles.planes,
    calls: r.subrequests, tfrDetails: tfrs.detailFetched, tfrs: tfrs.count,
    errors: r.errors || [],
    /* 2026-10-11: present only when this cron wrote no aircraft (deferred, or a newer snapshot) */
    aircraft: r.aircraft,
  });
}
