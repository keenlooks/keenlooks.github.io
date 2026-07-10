#!/usr/bin/env node
'use strict';

/*
 * check-links.js [siteDir]   (default: _site)
 *
 * Walks every .html file in the built site, collects internal href/src
 * references (root-relative, page-relative, and absolute URLs on the site's
 * own domain), and checks each resolves to a file in the built output.
 * Query strings (?v=... cache busters) and fragments are stripped; a path is
 * satisfied by the file itself, path/index.html, or path.html. Fails with a
 * list of missing targets.
 */

const fs = require('fs');
const path = require('path');

const siteDir = path.resolve(process.cwd(), process.argv[2] || '_site');

/* Known dynamic paths (no file in _site) that should not fail the check.
 * Entries match the URL path exactly or as a prefix. */
const ALLOWLIST = [];

/* Absolute URLs on the site's own domain are treated as internal (the real
 * production config sets url: https://keanelucas.com, so absolute_url links
 * look like this). */
const SITE_ORIGIN_RE = /^https?:\/\/(?:www\.)?keanelucas\.com(?=\/|$)/i;

/* Top-level dirs of the site to skip (see check-inline-scripts.js). */
const SKIP_TOP_DIRS = new Set(['ci']);

if (!fs.existsSync(siteDir) || !fs.statSync(siteDir).isDirectory()) {
  console.error(`check-links: site directory not found: ${siteDir}`);
  process.exit(2);
}

function* htmlFiles(dir, top) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (top && SKIP_TOP_DIRS.has(entry.name)) continue;
      yield* htmlFiles(full, false);
    } else if (entry.isFile() && /\.x?html?$/i.test(entry.name)) {
      yield full;
    }
  }
}

/* Pull href/src attribute values out of real tags only. Script/style bodies
 * are blanked (keeping the opening tag so <script src=...> still counts) so
 * JS string literals like `el.src = '/assets/js/' + name` are not mistaken
 * for document references. */
function extractRefs(html) {
  let h = html.replace(/<!--[\s\S]*?-->/g, ' ');
  h = h.replace(/(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi, '$1</script>');
  h = h.replace(/(<style\b[^>]*>)[\s\S]*?<\/style\s*>/gi, '$1</style>');
  const refs = [];
  const tagRe = /<[a-zA-Z][^>]*>/g;
  let t;
  while ((t = tagRe.exec(h)) !== null) {
    const attrRe = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let a;
    while ((a = attrRe.exec(t[0])) !== null) {
      refs.push((a[1] !== undefined ? a[1] : a[2]).trim());
    }
  }
  return refs;
}

function isFile(p) { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }

function targetExists(htmlFile, urlPath) {
  const base = urlPath.startsWith('/')
    ? path.join(siteDir, urlPath)
    : path.resolve(path.dirname(htmlFile), urlPath);
  const p = base.replace(/[\\/]+$/, ''); /* trailing slash: try index.html below */
  if (isFile(p)) return true;
  if (isDir(p) && isFile(path.join(p, 'index.html'))) return true;
  if (isFile(p + '.html')) return true;
  return false;
}

let pages = 0;
let checked = 0;
const missing = new Map(); /* url -> Set of referencing pages */

for (const file of htmlFiles(siteDir, true)) {
  pages++;
  const rel = path.relative(siteDir, file).split(path.sep).join('/');
  for (const raw of extractRefs(fs.readFileSync(file, 'utf8'))) {
    let u = raw.replace(/&amp;/g, '&').replace(/&#38;/g, '&').trim();
    if (!u) continue;
    if (SITE_ORIGIN_RE.test(u)) u = u.replace(SITE_ORIGIN_RE, '') || '/';
    if (/^(?:https?:)?\/\//i.test(u)) continue; /* external / protocol-relative */
    if (/^(?:mailto|tel|javascript|data|blob|about):/i.test(u)) continue;
    if (u.startsWith('#')) continue;
    u = u.split('#')[0].split('?')[0]; /* strip fragment + query */
    if (!u) continue;
    try { u = decodeURI(u); } catch (e) { /* leave undecodable refs as-is */ }
    if (ALLOWLIST.some(a => u === a || u.startsWith(a))) continue;
    checked++;
    if (!targetExists(file, u)) {
      if (!missing.has(u)) missing.set(u, new Set());
      missing.get(u).add(rel);
    }
  }
}

console.log(`check-links: ${checked} internal reference(s) across ${pages} page(s) in ${siteDir}`);

if (missing.size) {
  console.error(`\n${missing.size} internal reference(s) have NO target in the built site:\n`);
  for (const [u, sources] of [...missing.entries()].sort()) {
    const from = [...sources].slice(0, 4).join(', ') + (sources.size > 4 ? `, +${sources.size - 4} more` : '');
    console.error(`  ${u}\n    referenced from: ${from}`);
  }
  console.error('\nFix the link, add the missing file, or (for a genuinely dynamic\npath) add it to the ALLOWLIST array in ci/check-links.js.');
  process.exit(1);
}

console.log('check-links: OK');
