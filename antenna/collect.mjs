/*
 * The Observatory antenna's aircraft collector (2026-10-11).
 *
 * Why it exists: adsb.lol answers 429 and adsb.fi answers 403 to Cloudflare's shared egress
 * addresses, so the Worker's own cron reaches 0 or 1 of its 24 aircraft tiles, while the same
 * request from outside Cloudflare gets 200 from both. This script runs the antenna's aircraft
 * phase OUTSIDE Cloudflare and writes the result into the Worker's KV, where the Worker serves
 * it. It imports runAircraftPhase from worker.js, the very function the Worker's cron runs (the
 * 24 tiles with the same spacing and the same refusal breaker, then the agg:jam roll), so the
 * snapshot has the Worker's shape by construction. It adds one field, `writer`, and the Worker
 * defers to a snapshot that names a writer while it is younger than 25 minutes.
 *
 *   node antenna/collect.mjs          real upstreams, writes snap:planes and agg:jam to OBS_KV
 *   node antenna/collect.mjs --dry    real upstreams, an in-memory KV, nothing written anywhere
 *
 * Node 20 or newer, no dependencies. Run by .github/workflows/collect-antenna.yml every ten
 * minutes. Environment (not needed for --dry):
 *   CLOUDFLARE_API_TOKEN    the deploy's repository secret (needs Workers KV Storage: Edit)
 *   CLOUDFLARE_ACCOUNT_ID   the deploy's repository secret
 *   OBS_KV_ID               optional: the namespace id; otherwise the namespace titled OBS_KV is
 *                           looked up, as deploy-antenna.yml does
 *
 * Exit status: 0 the snapshot and the jam ring were written, or a REFUSED round: fewer than a
 * quarter of the tiles came back, nothing was written, and a `::warning::` line names the tile
 * count and the statuses seen (a refused runner is an upstream's choice, not a fault, and would
 * otherwise make 144 red runs a day, each emailed); the Worker's own round takes over once the
 * last collector snapshot is 25 minutes old, and never replaces it with a dark round of its own.
 * 2 configuration or KV trouble, a real fault (the message says what was and was not written).
 *
 * Politeness: a runner is ONE address, and adsb.lol refuses one address from about the fourth call
 * at the Worker's 250 ms spacing, so the collector spaces adsb.lol calls 1,000 ms apart
 * (COLLECTOR_SPACING_MS, carried on the round's budget); the Worker's own spacing is unchanged.
 *
 * The token is only ever sent to api.cloudflare.com and never printed. --kv-api <url> points the
 * KV calls at a local stub for tests and accepts nothing but an http://127.0.0.1 address.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAircraftPhase, makeDeps, nowOf, kvGetJson, summarizeJam, TILES, RELAY_DARK_FRAC, tilesNeeded,
         SOURCE_MIN_SPACING_MS } from './worker.js';

export const CF_API = 'https://api.cloudflare.com/client/v4';
export const KV_TITLE = 'OBS_KV';
export const KV_TIMEOUT_MS = 20000;
/* A round that reaches fewer than this share of the tiles writes nothing (worker.js's dark share). */
export const MIN_TILES_FRAC = RELAY_DARK_FRAC;
/* Off Cloudflare there is no 50 call cap, so every tile may try both sources:
   collectTiles keeps 2 calls back, hence 2 per tile plus 2. The breaker still applies. */
export const COLLECTOR_BUDGET = 2 * TILES.length + 2;
/* The Worker's per-source spacing, with adsb.lol slowed to one call a second (see the header). */
export const COLLECTOR_SPACING_MS = Object.assign({}, SOURCE_MIN_SPACING_MS, { 'adsb.lol': 1000 });

export function writerName(env) {
  return (env && env.GITHUB_ACTIONS === 'true') ? 'github-actions' : 'collect.mjs';
}

export function minTilesOk(total) {
  return tilesNeeded(total);
}

/* Cloudflare's own error codes and messages, never a header or a URL. */
function cfErrors(body) {
  const errs = body && Array.isArray(body.errors) ? body.errors : [];
  if (!errs.length) return '';
  return ' ' + JSON.stringify(errs.map(function (e) { return { code: e && e.code, message: e && e.message }; })).slice(0, 300);
}

function kvInit(token, extra) {
  const e = extra || {};
  const init = { method: e.method || 'GET', headers: Object.assign({ Authorization: 'Bearer ' + token }, e.headers || {}) };
  if (e.body !== undefined) init.body = e.body;
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(KV_TIMEOUT_MS);
  return init;
}

function nsRoot(api, account) {
  return api + '/accounts/' + encodeURIComponent(account) + '/storage/kv/namespaces';
}

/* The id of the namespace titled OBS_KV, the same lookup deploy-antenna.yml makes. */
export async function findNamespaceId(o) {
  const r = await o.fetchFn(nsRoot(o.api, o.account) + '?per_page=100', kvInit(o.token));
  let body = null;
  try { body = await r.json(); } catch (e) { body = null; }
  if (!r.ok || !body || body.success !== true || !Array.isArray(body.result)) {
    throw new Error('could not list the KV namespaces (HTTP ' + r.status + ')' + cfErrors(body) +
      '; the token needs the Workers KV Storage: Edit permission');
  }
  const hit = body.result.filter(function (n) { return n && n.title === KV_TITLE; })[0];
  if (!hit || !hit.id) throw new Error('no KV namespace titled ' + KV_TITLE + ' in this account (the antenna deploy creates it)');
  return hit.id;
}

/*
 * The Worker's KV binding, over the Cloudflare KV REST API: get(key) is the raw text, or null on
 * a 404; put(key, value) stores the string. kvGetJson in worker.js turns a failed read into null
 * (right for the Worker, where a read rarely fails), and rollJam would then start the jam ring
 * from nothing, so a key whose read FAILED in this run is never written: the put throws instead.
 */
export function restKv(o) {
  const root = nsRoot(o.api, o.account) + '/' + encodeURIComponent(o.ns) + '/values/';
  const failed = new Set();
  const log = [];
  return {
    log: log,
    async get(key) {
      let r;
      try {
        r = await o.fetchFn(root + encodeURIComponent(key), kvInit(o.token));
      } catch (e) {
        failed.add(key);
        log.push('GET ' + key + ' failed: ' + String((e && e.message) || e));
        throw e;
      }
      log.push('GET ' + key + ' ' + r.status);
      if (r.status === 404) return null;
      if (!r.ok) {
        failed.add(key);
        throw new Error('KV read of ' + key + ' answered HTTP ' + r.status);
      }
      try {
        return await r.text();
      } catch (e) {
        /* a 200 whose body never arrived (a reset, or the timeout mid-body) is a failed read too */
        failed.add(key);
        log.push('GET ' + key + ' body failed: ' + String((e && e.message) || e));
        throw e;
      }
    },
    async put(key, value) {
      if (failed.has(key)) {
        throw new Error('KV write of ' + key + ' withheld: reading it failed in this run, and a value built ' +
          'from nothing must not replace what is stored');
      }
      const body = String(value);
      const r = await o.fetchFn(root + encodeURIComponent(key), kvInit(o.token, {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: body,
      }));
      let j = null;
      try { j = await r.json(); } catch (e) { j = null; }
      log.push('PUT ' + key + ' ' + r.status + ' ' + Buffer.byteLength(body) + ' B');
      if (!r.ok || (j && j.success === false)) {
        throw new Error('KV write of ' + key + ' answered HTTP ' + r.status + cfErrors(j));
      }
    },
  };
}

/* The dry run's KV: a Map holding strings, exactly as antenna/dev-server.mjs keeps it. */
export function memKv() {
  const store = new Map();
  return {
    store: store,
    get: async function (k) { return store.has(k) ? store.get(k) : null; },
    put: async function (k, v) { store.set(k, String(v)); },
  };
}

function tileLine(i, t) {
  const where = (String(i).padStart(2) + ' ' + String(t.region || '')).padEnd(52);
  if (t.ok) {
    /* a tile the fallback carried still says why the primary did not */
    return where + ' ' + String(t.src).padEnd(9) + ' ' + String((t.planes || []).length).padStart(5) + ' aircraft' +
      (t.err ? '  (adsb.lol: ' + String(t.err).slice(0, 90) + ')' : '');
  }
  const why = [t.err, t.err2].filter(Boolean).map(function (s) { return String(s).slice(0, 90); }).join(' | ');
  return where + ' FAILED    ' + why;
}

/*
 * One collection. o: { env, dry, api, fetchFn (upstreams), kvFetchFn (Cloudflare), nowMs, sleep,
 * log }. Returns { code, summary }; never throws for an expected failure.
 */
export async function collect(o) {
  const opts = o || {};
  const env = opts.env || {};
  const log = opts.log || function (s) { process.stdout.write(s + '\n'); };
  const api = opts.api || CF_API;
  const wall0 = Date.now();
  const writer = writerName(env);
  const done = function (code, summary) {
    log('collect: ' + JSON.stringify(summary));
    return { code: code, summary: summary };
  };

  let kv;
  let rest = null;
  let nsFrom = null;
  if (opts.dry) {
    kv = memKv();
  } else {
    const token = String(env.CLOUDFLARE_API_TOKEN || '').trim();
    const account = String(env.CLOUDFLARE_ACCOUNT_ID || '').trim();
    if (!token) return done(2, { error: 'CLOUDFLARE_API_TOKEN is not set; nothing was fetched or written' });
    if (!account) return done(2, { error: 'CLOUDFLARE_ACCOUNT_ID is not set; nothing was fetched or written' });
    const kvFetch = opts.kvFetchFn || function (u, i) { return fetch(u, i); };
    let ns = String(env.OBS_KV_ID || '').trim();
    nsFrom = ns ? 'OBS_KV_ID' : 'title ' + KV_TITLE;
    if (!ns) {
      try {
        ns = await findNamespaceId({ api: api, account: account, token: token, fetchFn: kvFetch });
      } catch (e) {
        return done(2, { error: String((e && e.message) || e) + '; nothing was fetched or written' });
      }
    }
    rest = restKv({ api: api, account: account, token: token, ns: ns, fetchFn: kvFetch });
    kv = rest;
  }

  const deps = makeDeps(null, { kv: kv, fetchFn: opts.fetchFn, nowMs: opts.nowMs, sleep: opts.sleep });
  const t = nowOf(deps);
  const budget = { left: COLLECTOR_BUDGET, used: 0, minSpacingMs: COLLECTOR_SPACING_MS };
  const need = minTilesOk(TILES.length);
  log('collect.mjs: ' + (opts.dry ? 'DRY RUN (in-memory KV, nothing written anywhere)' : 'writing to the KV namespace found by ' + nsFrom) +
      ', writer ' + writer + ', ' + TILES.length + ' tiles, ' + need + ' needed');

  const air = await runAircraftPhase(deps, budget, t, { extra: { writer: writer }, minTilesOk: need });
  const list = air.tileList || [];
  for (let i = 0; i < list.length; i++) log(tileLine(i, list[i]));

  const summary = {
    dry: !!opts.dry, t: t, writer: writer,
    tilesOk: air.tiles ? air.tiles.ok : null, tilesTotal: air.tiles ? air.tiles.total : TILES.length,
    planes: air.tiles ? air.tiles.planes : null, calls: budget.used,
    written: !air.skipped && !air.errors.length && !!air.jam,
    jam: air.jam,
  };
  if (air.skipped) summary.skipped = air.skipped;
  if (air.errors.length) summary.errors = air.errors;
  if (opts.dry) {
    const agg = await kvGetJson(kv, 'agg:jam');
    if (agg) {
      const s = summarizeJam(agg, t);
      let n = 0;
      let low = 0;
      for (let i = 0; i < s.bins.length; i++) { n += s.bins[i][2]; low += s.bins[i][3]; }
      summary.jam = { buckets: s.buckets, hours: s.hours, bins: s.bins.length, withNacp: n, low: low };
    }
    summary.written = false;
  }
  if (rest) summary.kv = rest.log;
  summary.wallMs = Date.now() - wall0;

  let code = 0;
  if (air.tiles && air.tiles.ok < need) {
    /* refused, not broken: exit 0 with one annotation that says how far the round got and why */
    summary.warning = 'reached ' + air.tiles.ok + ' of ' + air.tiles.total + ' tiles (fewer than ' + need +
      '), so nothing was written; statuses seen: ' + statusesSeen(list);
    log('::warning::collect.mjs ' + summary.warning);
  } else if (air.errors.length || !air.tiles) {
    code = 2;
  }
  return done(code, summary);
}

/* "adsb.lol 429 x24, adsb.fi 403 x24": per source, each status the failed tiles recorded and on how
   many tiles ("no status" for a timeout or a lost connection). */
export function statusesSeen(tiles) {
  const counts = {};
  const order = [];
  const add = function (k) { if (!(k in counts)) { counts[k] = 0; order.push(k); } counts[k] += 1; };
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (!t || t.ok) continue;
    if (t.err) add('adsb.lol ' + (typeof t.status === 'number' ? t.status : 'no status'));
    if (t.err2) add('adsb.fi ' + (typeof t.status2 === 'number' ? t.status2 : 'no status'));
    if (!t.err && !t.err2) add('not tried');
  }
  return order.length ? order.map(function (k) { return k + ' x' + counts[k]; }).join(', ') : 'none';
}

function argValue(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1] || '';
    if (argv[i].indexOf(name + '=') === 0) return argv[i].slice(name.length + 1);
  }
  return null;
}

async function main(argv) {
  let api = CF_API;
  const stub = argValue(argv, '--kv-api');
  if (stub !== null) {
    let u = null;
    try { u = new URL(stub); } catch (e) { u = null; }
    if (!u || u.protocol !== 'http:' || u.hostname !== '127.0.0.1') {
      process.stdout.write('collect: {"error":"--kv-api accepts only an http://127.0.0.1 stub address"}\n');
      process.exitCode = 2;
      return;
    }
    api = stub.replace(/\/+$/, '');
  }
  const r = await collect({ env: process.env, dry: argv.indexOf('--dry') >= 0, api: api });
  if (r.code && process.env.GITHUB_ACTIONS === 'true') {
    /* one annotation, so the run's summary page says why it is red */
    const s = r.summary || {};
    process.stdout.write('::error::collect.mjs exit ' + r.code + ': ' +
      (s.error || s.skipped || (s.errors || []).join('; ') || 'see the log') + '\n');
  }
  process.exitCode = r.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(function (e) {
    process.stdout.write('collect: ' + JSON.stringify({ error: String((e && e.message) || e) }) + '\n');
    process.exitCode = 2;
  });
}
