#!/usr/bin/env node
'use strict';

/*
 * smoke.js [siteDir]   (default: _site)
 *
 * Serves the built site on :8080 and opens each page in ci/pages.json with
 * headless Chromium. For each page it waits SETTLE_MS, collecting:
 *   - pageerror events (uncaught exceptions)  -> FAIL
 *   - console errors (minus a benign allowlist) -> reported, not fatal
 *   - a blank-canvas heuristic on the largest canvas -> WARN, not fatal
 *
 * Requires (installed by the workflow, not saved to package.json):
 *   npm i --no-save playwright http-server
 *   npx playwright install --with-deps chromium
 */

const fs = require('fs');
const path = require('path');

const siteDir = path.resolve(process.cwd(), process.argv[2] || '_site');
const pagesFile = path.join(__dirname, 'pages.json');

const PORT = 8080;
const HOST = '127.0.0.1';
const SETTLE_MS = 4000;
const NAV_TIMEOUT_MS = 30000;

/* Benign console-error substrings (matched case-insensitively). Keep this
 * list tight: a generic entry like "failed to load resource" would mask real
 * 404s of the site's own assets. */
const CONSOLE_ALLOW = [
  'favicon',
  'gtag',
  'google-analytics',
  'googletagmanager',
  'analytics',
  'chrome-extension',
];

if (!fs.existsSync(siteDir) || !fs.statSync(siteDir).isDirectory()) {
  console.error(`smoke: site directory not found: ${siteDir}`);
  process.exit(2);
}

const pages = JSON.parse(fs.readFileSync(pagesFile, 'utf8'));

/* In-page blank-canvas heuristic: sample a grid of pixels from the largest
 * canvas and compute the variance across all RGBA samples. A never-drawn
 * (all transparent) or single-flat-color canvas has ~zero variance. */
function canvasProbe() {
  const list = Array.from(document.querySelectorAll('canvas'))
    .filter(c => c.width > 4 && c.height > 4);
  if (!list.length) return '';
  list.sort((a, b) => (b.width * b.height) - (a.width * a.height));
  const c = list[0];
  let ctx = null;
  try { ctx = c.getContext('2d'); } catch (e) { /* non-2d canvas */ }
  if (!ctx) return 'largest canvas is not 2d; blank check skipped';
  const vals = [];
  try {
    const COLS = 8, ROWS = 6;
    for (let r = 0; r < ROWS; r++) {
      for (let q = 0; q < COLS; q++) {
        const x = Math.min(c.width - 1, Math.floor((q + 0.5) * c.width / COLS));
        const y = Math.min(c.height - 1, Math.floor((r + 0.5) * c.height / ROWS));
        const d = ctx.getImageData(x, y, 1, 1).data;
        vals.push(d[0], d[1], d[2], d[3]);
      }
    }
  } catch (e) {
    return 'canvas read failed (' + e.message + '); blank check skipped';
  }
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const variance = vals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / vals.length;
  if (variance < 1) {
    return 'canvas appears blank (pixel variance ' + variance.toFixed(3) +
      ' over ' + (vals.length / 4) + ' samples on a ' + c.width + 'x' + c.height + ' canvas)';
  }
  return '';
}

(async () => {
  const httpServer = require('http-server');
  const { chromium } = require('playwright');

  const server = httpServer.createServer({ root: siteDir, cache: -1 });
  await new Promise(resolve => server.listen(PORT, HOST, resolve));
  console.log(`smoke: serving ${siteDir} at http://${HOST}:${PORT}`);

  const browser = await chromium.launch();
  const results = [];
  let anyFail = false;

  for (const p of pages) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', err => pageErrors.push(String((err && err.message) || err)));
    page.on('console', msg => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      const low = text.toLowerCase();
      if (CONSOLE_ALLOW.some(s => low.includes(s))) return;
      consoleErrors.push(text);
    });

    let navError = null;
    let canvasNote = '';
    try {
      const resp = await page.goto(`http://${HOST}:${PORT}${p}`, {
        waitUntil: 'load',
        timeout: NAV_TIMEOUT_MS,
      });
      if (!resp) navError = 'no response';
      else if (!resp.ok()) navError = `HTTP ${resp.status()}`;
    } catch (e) {
      navError = String((e && e.message) || e);
    }

    if (!navError) {
      await page.waitForTimeout(SETTLE_MS);
      try {
        canvasNote = await page.evaluate(canvasProbe);
      } catch (e) {
        canvasNote = 'canvas probe errored: ' + String((e && e.message) || e);
      }
    }
    await page.close();

    const failed = Boolean(navError) || pageErrors.length > 0;
    if (failed) anyFail = true;
    results.push({ path: p, navError, pageErrors, consoleErrors, canvasNote, failed });
  }

  await browser.close();
  server.close();

  console.log('\nsmoke: per-page summary\n');
  for (const r of results) {
    const status = r.failed ? 'FAIL' : (r.canvasNote || r.consoleErrors.length ? 'WARN' : 'PASS');
    console.log(`  ${status}  ${r.path}`);
    if (r.navError) console.log(`        navigation: ${r.navError}`);
    for (const e of r.pageErrors) console.log(`        pageerror: ${e}`);
    for (const e of r.consoleErrors) console.log(`        console error (non-fatal): ${e}`);
    if (r.canvasNote) console.log(`        canvas (non-fatal): ${r.canvasNote}`);
  }

  const failedCount = results.filter(r => r.failed).length;
  console.log(`\nsmoke: ${results.length - failedCount}/${results.length} pages passed` +
    (failedCount ? `, ${failedCount} FAILED (uncaught page error or navigation failure)` : ''));

  process.exit(anyFail ? 1 : 0);
})().catch(err => {
  console.error('smoke: fatal error:', err);
  process.exit(2);
});
