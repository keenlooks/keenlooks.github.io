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
 *      is skipped when the payload is unchanged (since the fourth pass, an unchanged list still
 *      rewrites its `checked` time once per cron), and subrequests are counted.
 *   4. No side effects at module scope beyond constant and function declarations. (2026-10-20: one
 *      constant object, ISOLATE_MEMO, is written by the request path at run time, never at load; only
 *      the Workers fetch handler passes it in, so every test and the dev server run without it.
 *      2026-10-29: the same holds for ANSWER_CACHE, the isolate's answer cache; see "politeness".
 *      Its helper ANSWER_SLOT (the last answer jsonResponse built, emptied by handleRequest) changes
 *      no answer.)
 *
 * Upstream politeness and licensing (see README.md for the full text):
 *   adsb.lol data is ODbL 1.0, adsb.fi is free for personal non-commercial use and requires a
 *   citation with a link. Both are volunteer feeder networks. Every upstream call carries the
 *   User-Agent below so the operators can see who we are.
 *
 * 2026-10-11: with the secret GH_DISPATCH_TOKEN the cron also started the GitHub Actions aircraft
 * collector, one POST to api.github.com when the collector was late (the cron's stage was removed in
 * the fourth pass of 2026-10-12: only a /planes request starts it now).
 * The hourly pass ran the collector once an hour (a workflow_dispatch when the stored snapshot was
 * 50 minutes old); the on-demand pass below supersedes it. The Worker's own ten minute cron keeps the TFRs.
 *
 * 2026-10-12 (antenna-ondemand, Keane: "Let's change the update frequency to every 30 mins then, but
 * yes also make it on demand"): a /planes request (the page's poll) records KV visit:last and, when
 * the snapshot is 25 minutes old and the last dispatch is too, starts the collector itself, in the
 * background (planesOnDemand); the cron's dispatch ran only while someone visited in the last 20
 * minutes (35 in the first pass; Fable's ruling, second pass) until the fourth pass removed it, and
 * /planes and /jam carry `refresh` while a requested sample has not landed yet (never cached).
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
/* 2026-10-11 (the dispatch): the repository whose collector workflow this Worker starts, and the one
   GitHub endpoint it calls. GH_DISPATCH_TOKEN is sent to this URL and nowhere else. Hourly pass: the
   endpoint is the workflow's own workflow_dispatch (the workflow file and the ref it runs on are the
   next two constants), because Keane's token carries Actions: Read and write and no Contents
   permission, which this endpoint accepts and the repository dispatch endpoint refuses. */
export const GH_REPO = 'keenlooks/keenlooks.github.io';
export const GH_WORKFLOW = 'collect-antenna.yml';
export const GH_REF = 'master';
export const GH_DISPATCH_URL = 'https://api.github.com/repos/' + GH_REPO + '/actions/workflows/' + GH_WORKFLOW + '/dispatches';

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
 * costs wall time only (the 21 tiles at 1 s is about 21 s), never a subrequest.
 */
export const SOURCE_MIN_SPACING_MS = { 'adsb.lol': TILE_SPACING_MS, 'adsb.fi': 1000 };

/* A Workers invocation may make 50 subrequests on the free plan. Leave headroom. */
export const MAX_SUBREQUESTS = 44;
/*
 * TFR geometries enriched per cron (r12 item 16, raised from 4). The arithmetic on the
 * 44 call budget, worst case first: the tiles take up to 2 calls each, and collectTiles stops
 * adding tiles once budget.left <= 2. Since the hourly pass trimmed TILES to 21, the worst round
 * spends 42 and leaves 2 (with 24 tiles it was 48, over the cap, and a tile started with 3 left
 * could leave 1). On a normal round the primary source answers first time, so the tiles spend
 * one call each (21), the TFR list spends 1 and the GPS sweep spends at most 1: 21 calls are
 * left. (2026-10-11: the collector dispatch, only with GH_DISPATCH_TOKEN, goes last and spends
 * 1 of what the stages before it left; the tiles leave at least 2, the TFR list takes 1 and the
 * sweep stops with 1 left, so the trimmed list always leaves it its call.) The detail loop is
 * gated on budget.left > 2 as well as on this ceiling, so
 * 8 is the most it will ever take and it takes fewer whenever the tiles had a bad round. At 8 per
 * 10 minute cron a list of 60 restrictions is fully enriched in about 75 minutes instead of
 * two and a half hours, which is the difference between tfr_active being a tour class on a
 * first visit and being one tomorrow.
 */
export const MAX_TFR_DETAIL_PER_CRON = 8;
/* fourth pass (2026-10-12, Fable's ruling on the live test): the stored list carries `checked`, the time
   of the last cron that fetched the FAA list, beside `t`, the time its content last changed. An
   unchanged list used to be left alone (the write skip), so its t stayed hours old and the page called
   a list the cron had just confirmed stale. An unchanged list now rewrites the same value with a new
   `checked` at most once per TFR_CHECK_GAP_MS (shorter than the ten minute cron, so once per cron; a
   second invocation inside it writes nothing). Why a field and not a key of its own: either costs one
   write per cron, but a `tfrs:checked` key would take a second write on every cron whose list changed
   and a second KV read on every /tfrs and /health request; the field rides the one write and the one
   read there already are. */
export const TFR_CHECK_GAP_MS = 5 * 60 * 1000;
export const TFR_FAIL_RETRY_MS = 6 * 3600 * 1000;
export const TFR_FAIL_MAX_TRIES = 3;

export const JAM_BIN_DEG = 2;
export const JAM_BUCKET_MS = 10 * 60 * 1000;
export const JAM_BUCKETS_1H = 6;
/* antenna-hourly second pass (2026-10-12): the /jam "1h" column is the NEWEST sample only: the
   buckets written within this span before the aggregate's own t, which is the one bucket holding
   that t (each bucket is one sample, rollJam replaces a repeated write within a slot). It is under
   an hour on purpose, so one hourly sample is the hour, and the column no longer ages on the
   request clock: the stale windows (ROUTES, the page's feeds; 75 minutes then, 45 since the on-demand
   pass) do the ageing. */
export const JAM_LATEST_SPAN_MS = JAM_BUCKET_MS;
export const JAM_HOURS_24H = 24;
export const NACP_LOW_MAX = 6;           /* nac_p <= 6 counts as degraded position integrity */

export const GPS_SWEEP_INTERVAL_MS = 6 * 3600 * 1000;
export const GPS_SWEEP_POINTS_PER_RUN = 20;
export const GPS_SWEEP_RADIUS_NM = 100;
export const GPS_NOTAM_TTL_MS = 36 * 3600 * 1000;

/*
 * The sample tiles, 250 nm radius each. Chosen for volunteer receiver density crossed with
 * the regions where GPS interference is actually reported. Every entry names its region.
 *
 * Hourly pass (2026-10-11, Keane: "remove tiles that aren't important"): three of the original 24
 * were dropped by measurement, each under 2 percent of the aircraft, feeding no judged GPS cell
 * and fewer than 3 winds cells in every sample taken (tile table and samples in
 * _tests/observatory/antenna-hourly-2026-10-11/README.md): Lapland and the Gulf of Bothnia
 * (65, 25), Mesopotamia (33.3, 44.4) and northern Andes (4.7, -74.1). The collector and the
 * Worker's fallback both read this one list, and the snapshot carries its own tilesTotal.
 *
 * COUPLED: assets/js/obs-feeds.js OM_SITES is this list of centres, in this order. The winds
 * instrument compares an Open-Meteo forecast at those points against the aircraft sampled in
 * these tiles, so editing one side alone would quietly compare two different places. t-feeds
 * reads this array as text and asserts the two match, so an edit here fails that suite until
 * OM_SITES follows.
 */
export const TILES = [
  /* Europe (5) */
  { lat: 51.0, lon: 3.0, region: 'Benelux and the southern North Sea' },
  { lat: 55.0, lon: 20.5, region: 'Baltic Sea and Kaliningrad' },
  { lat: 44.0, lon: 33.0, region: 'Black Sea' },
  { lat: 37.5, lon: 25.0, region: 'Aegean and the eastern Mediterranean' },
  { lat: 40.0, lon: -3.5, region: 'Iberia' },
  /* Middle East (2) */
  { lat: 33.5, lon: 35.0, region: 'Levant and Cyprus' },
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
  /* South America (1) */
  { lat: -23.5, lon: -46.6, region: 'southeast Brazil' },
  /* Oceania (2) */
  { lat: -33.9, lon: 151.2, region: 'southeast Australia' },
  { lat: -37.0, lon: 175.0, region: 'northern New Zealand' },
  /* Southern Africa (1) */
  { lat: -26.1, lon: 28.0, region: 'Highveld and Johannesburg' },
];

/*
 * Route table. kv is the key each route serves; staleAfterMs is when the served value starts
 * announcing itself as stale (the value is still served, honestly labelled). Hourly pass: the
 * collector rewrites snap:planes and agg:jam once an hour, so both are stale at 75 minutes (the
 * hour, the queue before a runner starts, and the round itself), the same window as
 * COLLECTOR_FRESH_MS and the page's planes and jam feeds. At 15 and 30 minutes they would call a
 * snapshot that is on time stale for most of every hour. On-demand pass (2026-10-12): while someone
 * is watching, the collector runs every half hour, so both are stale at 45 minutes (the half hour
 * plus the queue, the round and the poll that notices it), the same window as COLLECTOR_FRESH_MS and
 * the page's two feeds. A snapshot older than that is served as stale, which after a quiet spell is
 * the honest state until the sample the visit asked for lands.
 */
export const ROUTES = [
  { path: '/planes', kv: 'snap:planes', maxAge: 45, sMaxAge: 90, staleAfterMs: 45 * 60 * 1000 },
  { path: '/jam', kv: 'agg:jam', maxAge: 60, sMaxAge: 120, staleAfterMs: 45 * 60 * 1000 },
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
 * One sample (one snapshot): how many aircraft reported nac_p in each bin, and how many of those
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
 * Roll the ring buffers: JAM_BUCKETS_1H buckets of JAM_BUCKET_MS (six of ten minutes), twenty four
 * hourly buckets for the last day. Hourly pass: the collector writes once an hour, so each sample
 * opens its own ten minute bucket and the six buckets hold the last six samples. Second pass
 * (2026-10-12): a repeated write inside the same ten minute slot REPLACES that bucket, so a bucket is
 * always one sample and summarizeJam's newest-sample column never sums two (it used to merge, which
 * at the hourly cadence put a hand run and a scheduled run minutes apart into one count). The hourly
 * bucket still sums every sample of its hour: the 24 hour column is a count over the day.
 */
export function rollJam(prev, sample, nowMs) {
  const binDeg = (prev && prev.binDeg) || JAM_BIN_DEG;
  const buckets = (prev && Array.isArray(prev.buckets)) ? prev.buckets.slice() : [];
  const daily = (prev && Array.isArray(prev.daily)) ? prev.daily.slice() : [];

  /* Never mutate the value handed in: the caller may still be holding the previous ring. */
  const bt = Math.floor(nowMs / JAM_BUCKET_MS) * JAM_BUCKET_MS;
  const last = buckets.length ? buckets[buckets.length - 1] : null;
  if (last && last.t === bt) {
    buckets[buckets.length - 1] = { t: bt, bins: copyBins(sample) };
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
 * Second pass (2026-10-12, the review's two STANDS): n1h and nLow1h are the NEWEST sample, the
 * buckets within JAM_LATEST_SPAN_MS before the aggregate's own t. On the request clock (buckets
 * within 70 minutes of now) an hourly sample left the column at its cron plus 70 minutes while /jam
 * and the page still called it fresh until 75, so every bin read 0 and the page said no cell had
 * five aircraft; and from a new sample's landing until then the column summed two samples an hour
 * apart, which made clusters neither sample had. The 24 hour column stays on the request clock.
 */
export function summarizeJam(agg, nowMs) {
  const binDeg = (agg && agg.binDeg) || JAM_BIN_DEG;
  const h1 = {};
  const h24 = {};
  const buckets = (agg && agg.buckets) || [];
  const daily = (agg && agg.daily) || [];
  const aggT = agg ? num(agg.t) : null;
  for (let i = 0; i < buckets.length; i++) {
    const newest = aggT !== null ? buckets[i].t > aggT - JAM_LATEST_SPAN_MS : i === buckets.length - 1;
    if (newest) mergeBins(h1, buckets[i].bins);
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

/* fourth pass (2026-10-12): an answer that carries `refresh` is never cached. While a requested sample
   is on its way the page polls every 30 s (obs-feeds.js loadingPollMs), and a browser holding the
   route's 45 or 60 second copy would hand the page the old answer in place of every other poll. */
export function loadingCache(route, refresh) {
  return refresh ? 'no-store' : cacheControl(route);
}

export function jsonResponse(body, opts) {
  const o = opts || {};
  const headers = corsHeaders(Object.assign({ 'Cache-Control': o.cacheControl || 'no-store' }, o.headers || {}));
  const text = JSON.stringify(body);
  const res = new Response(text, { status: o.status || 200, headers: headers });
  /* 2026-10-29 (audit item 77, repair): the answer cache reads the body and its text from here instead
     of cloning and re-parsing the Response; handleRequest empties the slot as soon as its answer is
     back. A slot, not a WeakMap keyed by the Response: a WeakMap key gets an identity hash, which
     stops V8 from dropping the Response wrapper (and its native copy of the body) in a young
     collection; measured under workerd, that held about 40 MB more per 64 misses until a full GC. */
  ANSWER_SLOT.res = res; ANSWER_SLOT.body = body; ANSWER_SLOT.text = text;
  return res;
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
/* fourth pass (2026-10-12): the time a stored value is current as of: its `checked` (the TFR list's
   last check) when that is a number no older than its t, else its t; null when neither is a number. */
export function currentAt(v) {
  if (!v || typeof v !== 'object') return null;
  const vt = num(v.t);
  const vc = num(v.checked);
  if (vc !== null && (vt === null || vc >= vt)) return vc;
  return vt;
}

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
  /* fourth pass: a value that carries `checked` (the TFR list) is as current as its last check */
  const at = currentAt(body);
  const age = Math.max(0, t - (at !== null ? at : t));
  const out = Object.assign({ ok: true }, body, { ageMs: age });
  if (age > route.staleAfterMs) out.stale = true;
  return jsonResponse(out, { cacheControl: cacheControl(route) });
}

export async function handlePlanes(deps, url) {
  const route = routeFor('/planes');
  const t = nowOf(deps);
  const snap = await kvGetJson(deps.kv, 'snap:planes');
  /* 2026-10-12 (antenna-ondemand): this poll is a visit, and may start the collector (in the
     background, never delaying this answer); `refresh` says a requested sample is on its way.
     Fifth pass: a poll carrying ?loading=1 (the page's 30 s poll while it knows a sample is loading)
     only reads (planesOnDemand's loadingPoll). */
  const od = await planesOnDemand(deps, snap, t, { loadingPoll: isLoadingPoll(url) });
  if (!snap) {
    const off = { ok: false, offline: true, route: '/planes', reason: 'no snapshot has been written yet' };
    if (od.refresh) off.refresh = od.refresh;
    return jsonResponse(off, { status: 503 });
  }
  /*
   * The snapshot only changes once per cron, so a client polling faster than that can send
   * ?since=<t of the copy it holds> and get a few bytes back instead of the whole tile set.
   * ?min_alt=<ft> trims the rows to the altitudes an instrument actually uses.
   */
  const since = url ? num(url.searchParams.get('since')) : null;
  if (since !== null && since === num(snap.t)) {
    const same = { ok: true, t: snap.t, unchanged: true, ageMs: Math.max(0, t - snap.t) };
    if (od.refresh) same.refresh = od.refresh;
    return jsonResponse(same, { cacheControl: loadingCache(route, od.refresh) });
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
  if (od.refresh) out.refresh = od.refresh;
  return jsonResponse(out, { cacheControl: loadingCache(route, od.refresh) });
}

/* fifth pass (2026-10-12, Fable's ruling on the review): ?loading=1 marks a poll the page makes because
   an answer told it a requested sample is loading (obs-feeds.js soonerQuery, every 30 s). On /planes it
   never dispatches and records no visit; on /jam it changes nothing (/jam never does either). */
export function isLoadingPoll(url) {
  return !!(url && url.searchParams && url.searchParams.get('loading') === '1');
}

/* 2026-10-12 (antenna-ondemand): serveKvRoute's answer for agg:jam, plus `refresh` while a requested
   sample is on its way (judged against the aggregate's own t, the round's t). Byte-equal to
   serveKvRoute when there is no refresh to report. /jam records no visit and starts nothing. */
export async function handleJam(deps) {
  const route = routeFor('/jam');
  const t = nowOf(deps);
  const stored = await kvGetJson(deps.kv, route.kv);
  const refresh = await relayRefresh(deps, stored ? num(stored.t) : null, t);
  if (!stored) {
    const off = { ok: false, offline: true, route: route.path, reason: 'no snapshot has been written yet' };
    if (refresh) off.refresh = refresh;
    return jsonResponse(off, { status: 503 });
  }
  const body = summarizeJam(stored, t);
  const age = Math.max(0, t - (num(body.t) !== null ? num(body.t) : t));
  const out = Object.assign({ ok: true }, body, { ageMs: age });
  if (age > route.staleAfterMs) out.stale = true;
  if (refresh) out.refresh = refresh;
  return jsonResponse(out, { cacheControl: loadingCache(route, refresh) });
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
    /* fourth pass: the age and the stale flag from the value's last check when it carries one
       (the TFR list), and the check time itself beside t */
    const va = v ? currentAt(v) : null;
    const entry = {
      path: r.path,
      key: r.kv,
      present: !!v,
      t: vt,
      ageMs: va === null ? null : Math.max(0, t - va),
      stale: va === null ? null : (t - va) > r.staleAfterMs,
    };
    if (v && num(v.checked) !== null) entry.checked = num(v.checked);
    out.routes.push(entry);
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
  /* 2026-10-11 (the dispatch): when this Worker last started the collector, and GitHub's status */
  const dl = await kvGetJson(deps.kv, 'dispatch:last');
  if (dl && typeof dl === 'object') {
    out.dispatch = { t: num(dl.t), status: num(dl.status) };
    /* 2026-10-12 (antenna-ondemand): which path sent it, 'visit' (a /planes request) or 'cron' (the cron's
       stage, removed in the fourth pass; an old record can still say it) */
    if (typeof dl.why === 'string' && dl.why) out.dispatch.why = dl.why;
  }
  /* 2026-10-12 (antenna-ondemand): when the page last polled /planes (written at most once per
     VISIT_WRITE_GAP_MS, 10 minutes since the third pass) */
  const vl = await kvGetJson(deps.kv, 'visit:last');
  if (vl && typeof vl === 'object') out.visit = { t: num(vl.t) };
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
  /* 2026-10-29 (site audit item 77): the isolate's answer cache and the per address limit, both only
     when the Workers fetch handler passes them (deps.answers, deps.limiter); see "Politeness" below. */
  const ckey = (method === 'GET') ? answerKey(route, url) : null;
  const hit = cachedAnswer(deps, route, ckey, url);
  if (hit) return hit;
  const limited = await rateLimited(deps, request, route);
  if (limited) return limited;
  const res = await routeAnswer(route, deps, url);
  /* the slot is this answer's only when nothing else answered in between (else: simply not kept) */
  const src = (ANSWER_SLOT.res === res) ? { body: ANSWER_SLOT.body, text: ANSWER_SLOT.text } : null;
  ANSWER_SLOT.res = null; ANSWER_SLOT.body = null; ANSWER_SLOT.text = null;
  keepAnswer(deps, route, ckey, res, src);
  return res;
}

async function routeAnswer(route, deps, url) {
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

/* ------------------------------------------------------------------ politeness (2026-10-29) */

/*
 * Site audit 2026-10-29, item 77. The routes declare s-maxage, but Cloudflare's Cache API and edge
 * cache do not apply to a *.workers.dev Worker (the Cache API is documented as functional on custom
 * domains only, and two GETs of /tfrs came back with no cf-cache-status), and every route was open to
 * any client at any rate. A request loop could therefore spend the free plan's 100,000 KV reads a day,
 * which the chat Worker shares (/planes reads up to 3 keys a request, /health 7). Two guards, both
 * only in the Workers fetch handler (deps.answers, deps.limiter), so the node dev server, the
 * collector and every test harness that builds its own deps behave exactly as before:
 *
 * 1. ANSWER_CACHE: the isolate keeps each cacheable 200 answer (Cache-Control public, so never an
 *    answer that carries `refresh`, never /health, never a 503) for the route's sMaxAge, keyed by the
 *    path alone, or for /planes the path plus min_alt, so a junk parameter cannot bust it. An entry is
 *    the answer's JSON text without its trailing ageMs (and stale), plus the snapshot's t: a hit adds
 *    ageMs (the kept age plus the time since it was kept) and recomputes `stale`, so the age the page
 *    reads stays true, with no KV read, no clone and no parse. On /planes, `since` is answered from
 *    the entry: since equal to its t gets the few-byte `unchanged` answer, since newer than its t (a
 *    copy another isolate read) goes to KV, anything else gets the kept full answer, exactly as the
 *    handler would. `since` is never part of the key, so junk values cannot multiply the entries
 *    (repair of 2026-10-29: keyed on since, 64 junk values held 64 full ~650 KB snapshots, about
 *    125 MB of heap against the 128 MB isolate limit). The cache is bounded twice: ANSWER_CACHE_MAX
 *    keys and ANSWER_CACHE_MAX_BYTES characters of kept text in all. When full, a new answer is
 *    simply not kept (nothing is evicted for it, so junk keys cannot churn kept snapshots into
 *    old-generation garbage); entries leave when they expire. A /planes poll carrying loading=1 never reads or fills it (it asks whether
 *    the requested sample has landed). Like the s-maxage the routes always declared, a /planes hit
 *    records no visit and starts no dispatch: the next request that misses (at most 90 s later while
 *    others poll; a lone visitor's next poll, 180 s apart) does. Best effort: one copy per isolate.
 * 2. The Workers Rate Limiting binding ANTENNA_LIMIT (wrangler.toml, RATE_LIMIT_PER_MIN per address
 *    per minute, counted per Cloudflare location) in front of every route on a cache miss. Over it the
 *    answer is 429 with Retry-After (exposed to the page, whose fetcher reads it: obs-core.js r19 item
 *    8). No binding, no address, or a limiter error: the request goes through (fail open).
 */
export const RATE_LIMIT_PER_MIN = 60;
export const RATE_LIMIT_RETRY_S = 60;
export const ANSWER_CACHE_MAX = 64;
export const ANSWER_CACHE_MAX_BYTES = 3000000;
export const ANSWER_CACHE = new Map();
const ANSWER_SLOT = { res: null, body: null, text: null };

/* The cache key of a GET on a cacheable route, or null: the path, and for /planes min_alt normalised
   through num() (since is answered from the entry, never keyed). Pure. */
export function answerKey(route, url) {
  if (!route || !route.sMaxAge) return null;
  if (route.path !== '/planes') return route.path;
  if (isLoadingPoll(url)) return null;
  const sp = url && url.searchParams;
  const minAlt = sp ? num(sp.get('min_alt')) : null;
  return '/planes?min_alt=' + (minAlt === null ? '' : String(minAlt));
}

/* A kept answer for key as a Response, or null. Drops an expired entry. */
function cachedAnswer(deps, route, key, url) {
  const store = deps && deps.answers;
  if (!key || !store || typeof store.get !== 'function') return null;
  const e = store.get(key);
  if (!e) return null;
  const t = nowOf(deps);
  if (!(t >= e.at) || t >= e.exp) { store.delete(key); return null; }
  if (route.path === '/planes') {
    const since = (url && url.searchParams) ? num(url.searchParams.get('since')) : null;
    if (since !== null && e.t !== null && since === e.t) {
      return jsonResponse({ ok: true, t: e.tRaw, unchanged: true, ageMs: Math.max(0, t - e.t) },
        { cacheControl: e.cc, headers: { 'X-Antenna-Cache': 'hit' } });
    }
    /* the page holds a newer snapshot than this copy (another isolate read it): ask KV */
    if (since !== null && e.t !== null && since > e.t && since <= t) return null;
  }
  if (e.head === null) return null;
  const age = e.ageMs + (t - e.at);
  const stale = !!(route.staleAfterMs && age > route.staleAfterMs);
  return new Response(e.head + ',"ageMs":' + age + (stale ? ',"stale":true' : '') + '}',
    { status: 200, headers: corsHeaders({ 'Cache-Control': e.cc, 'X-Antenna-Cache': 'hit' }) });
}

/* Keeps a cacheable 200 answer under key for the route's sMaxAge, while the cache has room within
   ANSWER_CACHE_MAX keys and ANSWER_CACHE_MAX_BYTES characters (entries leave only when they expire or
   their key gets a newer answer). An answer whose text does not end in its own ageMs (and stale)
   is not kept, so a hit can never print a wrong age. Never throws. */
function keepAnswer(deps, route, key, res, src) {
  const store = deps && deps.answers;
  if (!key || !store || typeof store.set !== 'function' || !res || res.status !== 200) return;
  try {
    const cc = res.headers.get('Cache-Control') || '';
    if (cc.indexOf('public') !== 0) return;
    const body = src && src.body;
    if (!body || typeof body !== 'object' || body.refresh || typeof src.text !== 'string') return;
    const t = nowOf(deps);
    const bt = num(body.t);
    const entry = { t: bt, tRaw: body.t, head: null, ageMs: 0, bytes: 0, cc: cc, at: t, exp: t + route.sMaxAge * 1000 };
    let tail = null;
    if (body.unchanged === true) {
      if (route.path !== '/planes' || bt === null) return;
    } else {
      const ks = Object.keys(body);
      const last = ks[ks.length - 1];
      const withStale = last === 'stale';
      if (ks[withStale ? ks.length - 2 : ks.length - 1] !== 'ageMs' || typeof body.ageMs !== 'number') return;
      if (withStale ? body.stale !== true : ks.indexOf('stale') >= 0) return;
      tail = ',"ageMs":' + JSON.stringify(body.ageMs) + (withStale ? ',"stale":true' : '') + '}';
      if (src.text.length <= tail.length || !src.text.endsWith(tail)) return;
      entry.ageMs = body.ageMs;
      entry.bytes = src.text.length;
    }
    if (entry.bytes > ANSWER_CACHE_MAX_BYTES) return;
    const old = store.get(key);
    if (old && t >= old.at && t < old.exp) {
      if (old.t !== null && entry.t !== null && old.t > entry.t) return;
      if (old.t === entry.t && old.head !== null && entry.head === null) return;
    }
    store.delete(key);
    let total = 0;
    store.forEach(function (v, k) { if (!(t >= v.at) || t >= v.exp) store.delete(k); else total += v.bytes; });
    /* full: the new answer is not kept, and no live entry is pushed out for it. Evicting would turn
       every kept snapshot (by then in the old generation) into garbage that waits for a full GC, so a
       stream of junk min_alt values would pile up tens of MB; refusing keeps the cache's footprint at
       its bound and lets a refused answer die young, as it did before the cache. */
    if (store.size >= ANSWER_CACHE_MAX || total + entry.bytes > ANSWER_CACHE_MAX_BYTES) return;
    if (tail !== null) entry.head = src.text.slice(0, src.text.length - tail.length);
    store.set(key, entry);
  } catch (e) { /* an answer that cannot be kept is simply not kept */ }
}

/* The 429 answer when deps.limiter refuses this address, else null. Fails open. */
async function rateLimited(deps, request, route) {
  const lim = deps && deps.limiter;
  if (!lim || typeof lim.limit !== 'function') return null;
  const ip = request && request.headers && typeof request.headers.get === 'function'
    ? request.headers.get('CF-Connecting-IP') : null;
  if (!ip) return null;
  let ok = true;
  try { const r = await lim.limit({ key: ip }); ok = !(r && r.success === false); } catch (e) { ok = true; }
  if (ok) return null;
  return jsonResponse({
    ok: false, offline: true, route: route.path, rateLimited: true,
    reason: 'too many requests from this address; asked again in a minute',
  }, { status: 429, headers: { 'Retry-After': String(RATE_LIMIT_RETRY_S), 'Access-Control-Expose-Headers': 'Retry-After' } });
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
   * KV writes a day. If the enriched items are byte identical, the list's t stays as it was.
   * Fourth pass: the value is rewritten with a new `checked` (this cron's time) unless the stored
   * one is under TFR_CHECK_GAP_MS old, so the page can tell a list confirmed a minute ago from one
   * nobody has fetched for hours. One write per cron at most, as before.
   */
  const prevBody = prev && prev.items ? JSON.stringify(prev.items) : null;
  const nextBody = JSON.stringify(items);
  if (prevBody === nextBody) {
    const pt = num(prev.t);
    const pc = num(prev.checked);
    const lastCheck = (pc !== null && (pt === null || pc >= pt)) ? pc : pt;
    if (lastCheck !== null && t - lastCheck >= -COLLECTOR_SKEW_MS && t - lastCheck < TFR_CHECK_GAP_MS) {
      return { written: false, count: items.length, detailFetched: fetched };
    }
    await kvPutJson(deps.kv, 'tfrs', { t: pt !== null ? pt : t, checked: t, count: items.length, items: items });
    return { written: false, checked: true, count: items.length, detailFetched: fetched };
  }
  await kvPutJson(deps.kv, 'tfrs', { t: t, checked: t, count: items.length, items: items });
  return { written: true, count: items.length, detailFetched: fetched };
}

/*
 * 2026-10-11 (the collector). adsb.lol answers 429 and adsb.fi 403 to Cloudflare's shared egress,
 * so the aircraft tiles are gathered OUTSIDE Cloudflare: antenna/collect.mjs, run by the GitHub
 * Actions workflow .github/workflows/collect-antenna.yml (every half hour while someone is watching,
 * and on demand, since 2026-10-12), runs
 * runAircraftPhase below (the very function runCron runs) and writes snap:planes and agg:jam
 * into this Worker's KV through the Cloudflare KV REST API. A collector's snapshot names its
 * writer; the Worker's own never does. While a collector snapshot is younger than
 * COLLECTOR_FRESH_MS, runCron leaves the aircraft to it and spends its calls on the TFRs; when
 * the stored snapshot is older, absent or the Worker's own, runCron runs its own round as before
 * (the fallback). Hourly pass: 75 minutes, the hour plus the queue and the round, so the Worker
 * falls back only once an hourly run has really been missed. On-demand pass (2026-10-12): 45
 * minutes, the half hour plus the queue and the round. With GH_DISPATCH_TOKEN set the fallback round
 * also waits for a visit (fallbackHold below): a collector snapshot older than this is the normal
 * state of a quiet night now, not a missed run.
 */
export const COLLECTOR_FRESH_MS = 45 * 60 * 1000;
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
 * The aircraft phase: the TILES (spacing, breaker and budget exactly as collectTiles has
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
 * these checks hold for writes more than about a minute apart, which the hourly collector and
 * the ten minute cron are.
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
 * 2026-10-11 (the dispatch). GitHub did not fire the collector's schedule once in five hours, while
 * this Worker's own cron fires every ten minutes, so this cron IS the collector's scheduler (the
 * schedule trigger is gone from collect-antenna.yml; a schedule that started firing would double
 * every run). With the secret GH_DISPATCH_TOKEN (Keane's fine-grained token on this repository only,
 * Actions: Read and write and nothing else; deploy-antenna.yml pushes it when the repository has it)
 * a cron sends ONE workflow_dispatch of collect-antenna.yml on GH_REF to GH_DISPATCH_URL when
 *   the stored snapshot is absent, the Worker's own, or a collector's at least DISPATCH_STALE_MS old
 *   (read through the deferral's own collectorAgeMs, so a snapshot the cron does not defer to counts
 *   as late too), and
 *   KV dispatch:last {t, status} is absent or at least DISPATCH_GAP_MS old (a t more than
 *   COLLECTOR_SKEW_MS in the future is a skewed clock and counts as absent).
 * In the hourly pass both were 50 minutes (superseded by the on-demand pass below; Keane: "Let's make the
 * pull be every 60 mins"): the round a
 * dispatch starts carries a t from a minute or more after the cron (the TFR stage, GitHub's queue,
 * the runner's boot), so the cron 50 minutes on finds it under 50 minutes old and skips, and the cron
 * 60 minutes on finds it 60 minutes less that delay old and sends: one run an hour while the delay
 * is under about ten minutes, and the 50 minute gap holds a second dispatch off whatever the snapshot
 * says. Every call is recorded in dispatch:last whatever GitHub answers, so a broken token costs one
 * call per 50 minutes and no more; t is the cron's own start, the clock the next cron compares. The
 * call counts in the subrequest budget and goes LAST in the cron, so no other stage ever loses a call
 * to it: it spends one the stages before it left (the TFR details stop at 2 left, the sweep at 1, and
 * the trimmed tiles leave at least 2), and with no call left it skips with "no subrequest left". The
 * answer is one line, never the token or a header: "sent, status 204", "sent, status 401, body <its
 * first 120 characters>" (no body clause when the answer had none), "tried, no answer: <error>", or
 * "skipped, <why>".
 * Without the token nothing here runs: no call, no read, no write, and the cron's result has no
 * dispatch field, so it is byte-equal to the Worker before this trigger.
 * Fourth pass (2026-10-12, Fable's ruling on the live test): THE CRON NO LONGER DISPATCHES. Everything
 * above about the cron sending is history; the POST, the gap, dispatch:last and the redaction are
 * unchanged and are now sent only from the request path below (planesOnDemand). With a tab open the
 * tab refreshes itself (the live test: the cron never sent while a tab was open), so the cron's only
 * remaining sends were the runs after a visitor had left, which fetched for nobody (a third of the
 * day's runs in the simulation). dispatchCollector, dispatchLogLine and the cron's second log line
 * are gone with it.
 *
 * On-demand pass (2026-10-12, Keane: "change the update frequency to every 30 mins then, but yes also
 * make it on demand ... My website gets only about 20 visitors a day"). Three changes, the token, the
 * endpoint and every guard above unchanged:
 *   1. VISITS. A /planes request (the page polls it every three minutes while it is open) records KV
 *      visit:last {t}, written only when the stored one is absent, skewed, or VISIT_WRITE_GAP_MS old,
 *      so a watching tab costs one write per 10 minutes (planesOnDemand; 5 before the third pass).
 *   2. ON DEMAND. The same request sends the dispatch itself, from the request path, when the stored
 *      snapshot is absent or DISPATCH_STALE_MS old (the cron's own collectorAgeMs) and dispatch:last is
 *      absent or DISPATCH_GAP_MS old. The answer is not delayed: the call and its dispatch:last write
 *      {t, status, why: 'visit'} run in the background (ctx.waitUntil, or a promise with a catch where
 *      there is none, the node dev server). The answer carries refresh {requestedAt, snapshotT}.
 *   3. THE CRON waited for a visit (VISIT_WATCH_MS, then also VISIT_SELF_MS); since the fourth pass it
 *      sends nothing at all, and visit:last is kept for the fallback hold (VISIT_RECENT_MS) and /health.
 *      An open tab is refreshed every half hour by its own polls; a quiet night costs nothing.
 * Both are 25 minutes now: an open tab's poll finds the snapshot 25 minutes old and asks, the sample
 * lands a few minutes later, so a watched page is never shown one much older than half an hour.
 * `refresh` is on /planes and /jam while a dispatch is in flight: dispatch:last younger than
 * REFRESH_INFLIGHT_MS, answered 204, and no snapshot newer than it (refreshInFlight).
 */
export const DISPATCH_STALE_MS = 25 * 60 * 1000;
export const DISPATCH_GAP_MS = 25 * 60 * 1000;
export const DISPATCH_BODY_HEAD = 120;
/* 2026-10-12 (antenna-ondemand): visit:last is rewritten at most this often. Third pass (Fable's ruling
   on the review): 10 minutes, it was 5. KV caps writes per day for the namespace, and every Cloudflare
   location a tab polls from writes its own (the review's P8: five always-open tabs in five locations read
   up to about 1,080 writes a day at 5 minutes); a tab polling every three minutes now writes about every
   twelve. */
export const VISIT_WRITE_GAP_MS = 10 * 60 * 1000;
/* fourth pass (Fable's ruling on the live test): with the token, the Worker's own aircraft round (the
   fallback) runs only while someone visited this recently. VISIT_WATCH_MS (20 minutes, the cron's
   dispatch gate) and VISIT_SELF_MS (13, the third pass's self window) went with the cron's dispatch;
   visit:last is still written by the request path and read here and by /health. */
export const VISIT_RECENT_MS = 25 * 60 * 1000;
/* a dispatch younger than this, answered 204, with no snapshot newer than it, is "in flight" */
export const REFRESH_INFLIGHT_MS = 4 * 60 * 1000;

/* 2026-10-20 (site audit m31): dispatch:last is the only record of a dispatch, and it is a KV write. Once
   the namespace's daily write cap (1,000 on the free plan) is hit, that write fails, nothing records the
   dispatch, and every /planes poll sent another one. The isolate now remembers, in memory, when it last
   decided to send (lastDispatchMs) and when a KV write of the request path last failed (kvWriteFailedAt:
   the visit:last or the dispatch:last write), and planesOnDemand sends nothing for MEMO_HOLD_MS after
   either. Best effort: each Cloudflare isolate holds its own copy, which is lost when the isolate is
   recycled, so a capped day costs at most one dispatch per isolate per MEMO_HOLD_MS instead of one per
   poll. While the cap holds, the collector's own KV writes fail too, so a dispatch then fetches for
   nobody; the hold lifts MEMO_HOLD_MS after the last failed write once writes work again. Only the
   Workers fetch handler passes ISOLATE_MEMO (deps.memo); deps without a memo (every test harness, the
   node dev server, the collector) behave exactly as before. */
export const MEMO_HOLD_MS = 25 * 60 * 1000;
export const ISOLATE_MEMO = { lastDispatchMs: null, kvWriteFailedAt: null };

/* Why the memo holds a dispatch at t, or null. A remembered time more than COLLECTOR_SKEW_MS ahead of
   the clock holds nothing (as keptTime). Pure. */
export function memoHold(memo, t) {
  if (!memo || typeof memo !== 'object') return null;
  const recent = function (v) {
    return typeof v === 'number' && isFinite(v) && t - v >= -COLLECTOR_SKEW_MS && t - v < MEMO_HOLD_MS;
  };
  if (recent(memo.kvWriteFailedAt)) {
    return 'a KV write failed ' + Math.round(Math.max(0, t - memo.kvWriteFailedAt) / 1000) + ' s ago';
  }
  if (recent(memo.lastDispatchMs)) {
    return 'this isolate dispatched ' + Math.round(Math.max(0, t - memo.lastDispatchMs) / 1000) + ' s ago';
  }
  return null;
}

/* Records a failed KV write of the request path in deps.memo, when there is one. Never throws. */
function memoKvFailed(deps, t) {
  const m = deps && deps.memo;
  if (m && typeof m === 'object') m.kvWriteFailedAt = t;
}

export function dispatchConfigured(deps) {
  const s = (deps && deps.secrets) || {};
  return !!s.ghDispatchToken;
}

/* GitHub's answer or an error as one short line. The token is replaced FIRST, whole and then each of
   its whitespace-separated pieces of 4 or more characters (an error can echo a token with an inner
   newline, raw or escaped), and only then is whitespace folded and the line cut to
   DISPATCH_BODY_HEAD characters (second pass: folding first turned the newline into a space and the
   whole token no longer matched). */
function dispatchHead(text, token) {
  let s = String(text === null || text === undefined ? '' : text);
  if (token) {
    const parts = [token].concat(String(token).split(/\s+/).filter(function (p) { return p.length >= 4; }));
    for (let i = 0; i < parts.length; i++) s = s.split(parts[i]).join('[token]');
  }
  return s.replace(/\s+/g, ' ').trim().slice(0, DISPATCH_BODY_HEAD);
}

/* 2026-10-12 (antenna-ondemand): a stored time read the way dispatch:last is read: null when absent or
   not a number, and null when more than COLLECTOR_SKEW_MS ahead of the clock (a skewed clock holds
   nothing off). */
function keptTime(v, t) {
  const vt = (v && typeof v === 'object') ? num(v.t) : null;
  if (vt === null) return null;
  return (t - vt < -COLLECTOR_SKEW_MS) ? null : vt;
}

/* The refresh a /planes or /jam answer carries, or null: dispatch:last younger than
   REFRESH_INFLIGHT_MS (a t ahead of the clock inside the skew allowance counts as just sent), answered
   204 (a refused or unanswered dispatch is not on its way), and no stored snapshot newer than it
   (snapT is the snapshot's, or the jam aggregate's, own t; the collector's round t is after its
   dispatch). Pure. */
export function refreshInFlight(last, snapT, t) {
  const lt = keptTime(last, t);
  if (lt === null || num(last.status) !== 204) return null;
  if (t - lt >= REFRESH_INFLIGHT_MS) return null;
  if (snapT !== null && snapT !== undefined && snapT > lt) return null;
  return { requestedAt: lt, snapshotT: (snapT === undefined) ? null : snapT };
}

/* refreshInFlight from KV, for a route that does not dispatch (/jam). Without the token nothing is
   read. Never throws. */
export async function relayRefresh(deps, snapT, t) {
  if (!dispatchConfigured(deps)) return null;
  try { return refreshInFlight(await kvGetJson(deps.kv, 'dispatch:last'), snapT, t); } catch (e) { return null; }
}

/* The one POST and its dispatch:last record {t, status, why}. Returns the log line text after
   "dispatch: ". The caller has decided to send. Shared by the cron and the request path until the
   fourth pass; the request path (why 'visit') is its only caller now. */
async function sendDispatch(deps, t, why) {
  const token = String((deps && deps.secrets && deps.secrets.ghDispatchToken) || '');
  const init = {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
    },
    /* workflow_dispatch: the ref the workflow runs on, and nothing else (it declares no inputs) */
    body: JSON.stringify({ ref: GH_REF }),
    /* second pass: never follow a redirect (a renamed repository or workflow answers 301, and a
       followed POST becomes a GET elsewhere); a 3xx is recorded like any other answer that is not 204 */
    redirect: 'manual',
  };
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    init.signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  }
  let status = null;
  let line;
  try {
    const res = await deps.fetchFn(GH_DISPATCH_URL, init);
    status = (res && typeof res.status === 'number') ? res.status : null;
    line = 'sent, status ' + status;
    if (status !== 204) {
      let body = '';
      try { body = (res && typeof res.text === 'function') ? await res.text() : ''; } catch (e) { body = ''; }
      const head = dispatchHead(body, token);
      if (head) line += ', body ' + head;
    }
  } catch (e) {
    line = 'tried, no answer: ' + dispatchHead((e && e.message) || e, token);
  }
  /* recorded whatever GitHub answered, so a refused token is asked again only after DISPATCH_GAP_MS */
  try {
    await kvPutJson(deps.kv, 'dispatch:last', { t: t, status: status, why: why });
  } catch (e) {
    memoKvFailed(deps, t);
    line += '; dispatch:last not written: ' + dispatchHead((e && e.message) || e, token);
  }
  return line;
}

/*
 * 2026-10-12 (antenna-ondemand): the on-demand stage of one /planes request. snap is the stored
 * snapshot (or null), t the request's clock. With the token (and only with it: without it this reads
 * and writes nothing, so the answer is byte-equal to the Worker before) it
 *   - writes visit:last {t} when the stored one is absent, skewed or VISIT_WRITE_GAP_MS old, and (fourth
 *     pass) no requested sample is in flight,
 *   - sends ONE dispatch (why 'visit') when the snapshot is absent or DISPATCH_STALE_MS old by the
 *     cron's own collectorAgeMs, and dispatch:last is absent, skewed, or DISPATCH_GAP_MS old,
 * both in the BACKGROUND: deps.waitUntil (the Workers ctx) when there is one, else a promise left to
 * run with a catch (the node dev server), so the answer never waits for GitHub or a KV write.
 * Returns { refresh, visit, dispatch, job }: refresh {requestedAt, snapshotT} when this request sent a
 * dispatch or one is in flight (refreshInFlight), else null; job the background promise (null when
 * there is none; it never rejects). Never throws.
 * Fifth pass (2026-10-12, Fable's ruling on the review): opts.loadingPoll (the request carried
 * ?loading=1, the page's 30 s poll while it knows a sample is loading) sends NO dispatch and writes no
 * visit, whatever KV shows; it still answers refresh when one is in flight. The review's probe-lag30: at
 * 30 s that poll can read a KV that has not yet seen the first request's dispatch:last (another
 * location; KV propagates in about 60 s) and, with the snapshot still old, sent a second dispatch.
 */
export async function planesOnDemand(deps, snap, t, opts) {
  const out = { refresh: null, visit: null, dispatch: null, job: null };
  const loadingPoll = !!(opts && opts.loadingPoll);
  if (!dispatchConfigured(deps)) return out;
  const jobs = [];
  try {
    const vt = keptTime(await kvGetJson(deps.kv, 'visit:last'), t);
    const snapT = snap ? num(snap.t) : null;
    const age = collectorAgeMs(snap, t);
    const last = await kvGetJson(deps.kv, 'dispatch:last');
    const lt = keptTime(last, t);
    /* fourth pass: a poll while a requested sample is in flight writes no visit, so the 30 s polls the
       page makes then (obs-feeds.js loadingPollMs) only read; the request that sent the dispatch was the
       visit, and the fallback round is held while it is in flight anyway. (The day sim reads the same
       counts with and without this: the 10 minute gap already keeps most of them from writing.) */
    if (refreshInFlight(last, snapT, t)) {
      out.visit = 'held, a requested sample is in flight';
    } else if (loadingPoll) {
      out.visit = 'held, a loading poll';
    } else if (vt === null || t - vt >= VISIT_WRITE_GAP_MS) {
      out.visit = 'written';
      jobs.push(function () {
        return kvPutJson(deps.kv, 'visit:last', { t: t }).catch(function () { memoKvFailed(deps, t); return null; });
      });
    } else {
      out.visit = 'held, the last was written ' + Math.round(Math.max(0, t - vt) / 1000) + ' s ago';
    }
    if (age !== null && age < DISPATCH_STALE_MS) {
      out.dispatch = 'skipped, the collector snapshot is ' + Math.round(age / 1000) + ' s old';
    } else if (loadingPoll) {
      out.dispatch = 'skipped, a loading poll';
    } else if (lt !== null && t - lt < DISPATCH_GAP_MS) {
      out.dispatch = 'skipped, the last dispatch was ' + Math.round(Math.max(0, t - lt) / 1000) + ' s ago';
    } else if (memoHold(deps.memo, t)) {
      /* 2026-10-20 (m31): dispatch:last may be unwritable (the KV cap); no refresh is announced from memory */
      out.dispatch = 'skipped, ' + memoHold(deps.memo, t);
    } else {
      out.dispatch = 'sending';
      if (deps.memo && typeof deps.memo === 'object') deps.memo.lastDispatchMs = t;
      /* third pass (Fable's ruling on the review's P2): announced at once only when the previous
         dispatch:last is absent or was answered 204. After a refused or unanswered one this one is most
         likely refused too, and the page must never say "loading" for a sample nobody is fetching; if it
         is accepted, the next poll reads it in flight. */
      if (!last || num(last.status) === 204) out.refresh = { requestedAt: t, snapshotT: snapT };
      jobs.push(function () {
        return sendDispatch(deps, t, 'visit').then(function (line) {
          if (typeof deps.log === 'function') deps.log('dispatch: ' + line + ' (on a visit)');
          return line;
        });
      });
    }
    if (!out.refresh) out.refresh = refreshInFlight(last, snapT, t);
  } catch (e) {
    out.dispatch = out.dispatch || ('failed, ' + dispatchHead((e && e.message) || e,
      String((deps && deps.secrets && deps.secrets.ghDispatchToken) || '')));
  }
  if (jobs.length) {
    const job = Promise.all(jobs.map(function (fn) {
      return Promise.resolve().then(fn).catch(function () { return null; });
    }));
    out.job = job;
    if (typeof deps.waitUntil === 'function') deps.waitUntil(job);
    else job.catch(function () {});
  }
  return out;
}

/*
 * 2026-10-12 (antenna-ondemand): why a cron, with the token set and no collector snapshot to defer
 * to, leaves its own aircraft round out, or null to run it. A collector snapshot older than
 * COLLECTOR_FRESH_MS is the normal state of a quiet night now, and without this the Worker's fallback
 * round would call the two volunteer feeds every ten minutes all night (from Cloudflare's egress they
 * refuse it, which still costs them a call per source per tile until the breaker trips). So it runs
 * only while someone visited in the last VISIT_RECENT_MS (25 minutes since the fourth pass; it was the
 * cron's 20 minute VISIT_WATCH_MS), and not while a dispatch is in flight (the collector is on its
 * way). Without the token the fallback is the only aircraft source and runs as before. Never throws.
 */
export async function fallbackHold(deps, snapT, t) {
  if (!dispatchConfigured(deps)) return null;
  try {
    const vt = keptTime(await kvGetJson(deps.kv, 'visit:last'), t);
    if (vt === null || t - vt >= VISIT_RECENT_MS) {
      return 'held: no visit in the last ' + Math.round(VISIT_RECENT_MS / 60000) + ' minutes, so no aircraft round';
    }
    const inflight = refreshInFlight(await kvGetJson(deps.kv, 'dispatch:last'), snapT, t);
    if (inflight) {
      return 'held: the collector was asked ' + Math.round(Math.max(0, t - inflight.requestedAt) / 1000) + ' s ago';
    }
  } catch (e) { return null; }
  return null;
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
  const head = await snapHead(deps.kv);
  const deferAge = collectorAgeMs(head, t);
  /* 2026-10-12 (antenna-ondemand): with the token, the fallback round waits for a visit too */
  const hold = deferAge === null ? await fallbackHold(deps, head ? num(head.t) : null, t) : null;
  if (deferAge !== null) {
    result.aircraft = 'deferred to the collector, age ' + Math.round(deferAge / 1000) + ' s';
  } else if (hold) {
    result.aircraft = hold;
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

  /* 2026-10-11 to 12: the cron's dispatch stage stood here (dispatchCollector). Fourth pass: removed;
     only a /planes request starts the collector now (planesOnDemand). */

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
    secrets: o.secrets || { faaClientId: e.FAA_CLIENT_ID || '', faaClientSecret: e.FAA_CLIENT_SECRET || '',
                            ghDispatchToken: String(e.GH_DISPATCH_TOKEN || '').trim() },
    /* 2026-10-12 (antenna-ondemand): the request path's background work and its one log line */
    waitUntil: o.waitUntil || null,
    log: o.log || null,
    /* 2026-10-20 (m31): the isolate's dispatch memory; only the fetch handler passes one */
    memo: o.memo || null,
    /* 2026-10-29 (audit item 77): the isolate's answer cache and the per address limit; only the fetch
       handler passes them (an env binding is never picked up here, so harnesses stay unlimited) */
    answers: o.answers || null,
    limiter: o.limiter || null,
  };
}

export default {
  async fetch(request, env, ctx) {
    /* 2026-10-12 (antenna-ondemand): the dispatch a /planes request may start runs after the answer */
    const bg = (ctx && typeof ctx.waitUntil === 'function') ? function (p) { ctx.waitUntil(p); } : null;
    return handleRequest(request, makeDeps(env, { waitUntil: bg, log: function (s) { console.log(s); }, memo: ISOLATE_MEMO,
      answers: ANSWER_CACHE, limiter: (env && env.ANTENNA_LIMIT) || null }));
  },
  async scheduled(event, env, ctx) {
    const p = runCron(makeDeps(env, null)).then(function (result) {
      /* 2026-10-11: one line per cron in Workers Logs ([observability] is on in
         wrangler.toml). The result carries no secret. */
      console.log(cronLogLine(result));
      /* fourth pass: the second line ("dispatch: ...") went with the cron's dispatch stage; a /planes
         request logs its own "dispatch: sent, status N (on a visit)" */
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
