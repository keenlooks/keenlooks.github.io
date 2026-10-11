/*
 * Local antenna without workerd.
 *
 * Runs the REAL worker.js route handlers and cron in plain node (18+), with an
 * in-memory KV, bound to 127.0.0.1 only. Exists because `wrangler dev` depends on
 * the workerd binary, which can crash on some Windows setups; this shim has no
 * native dependency at all.
 *
 *   node antenna/dev-server.mjs            serves http://127.0.0.1:8788
 *
 * It runs one cron at boot (about a minute: 24 aircraft tiles fetched politely,
 * plus the TFR list) and again every 10 minutes, matching production cadence.
 * Point the page at it with /observatory/?antenna=http://127.0.0.1:8788
 * Nothing is persisted: stop the process and the data is gone.
 */

import http from 'node:http';
import { handleRequest, runCron, makeDeps } from './worker.js';

const PORT = 8788;
const store = new Map();
const kv = {
  get: async (key) => (store.has(key) ? store.get(key) : null),
  put: async (key, value) => { store.set(key, String(value)); },
};

const deps = makeDeps(null, { kv });
let cronRuns = 0;

async function cron() {
  const started = Date.now();
  process.stdout.write('[antenna-dev] cron run ' + (cronRuns + 1) + ' starting...\n');
  try {
    await runCron(deps);
    cronRuns += 1;
    process.stdout.write('[antenna-dev] cron done in ' + Math.round((Date.now() - started) / 1000) + 's; keys: ' + Array.from(store.keys()).join(', ') + '\n');
  } catch (err) {
    process.stdout.write('[antenna-dev] cron failed: ' + (err && err.message ? err.message : String(err)) + '\n');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const request = new Request('http://127.0.0.1:' + PORT + req.url, {
      method: req.method,
      headers: req.headers,
    });
    const response = await handleRequest(request, deps);
    const headers = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(response.status, headers);
    const body = Buffer.from(await response.arrayBuffer());
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ error: String(err && err.message ? err.message : err) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write('[antenna-dev] serving http://127.0.0.1:' + PORT + ' (local only)\n');
  cron();
  setInterval(cron, 10 * 60 * 1000);
});
