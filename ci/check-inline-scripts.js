#!/usr/bin/env node
'use strict';

/*
 * check-inline-scripts.js [siteDir]   (default: _site)
 *
 * Walks every .html file in the built site, extracts each inline <script>
 * block (skipping <script src=...> and non-JS types like application/ld+json)
 * and runs `node --check` on it. Fails listing the page and the first line of
 * any script that does not parse.
 *
 * Why: GitHub Pages builds with JEKYLL_ENV=production, which activates the
 * compress layout and strips newlines. An inline `//` line comment then
 * comments out the REST of the script ("Unexpected end of input") and the
 * script silently fails on the live site only. This has bitten the repo
 * repeatedly; see CLAUDE.md gotcha #1. Use external .js files or block
 * comments in inline scripts.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const siteDir = path.resolve(process.cwd(), process.argv[2] || '_site');

/* Top-level dirs of the site to skip. `ci` guards against the checker
 * recursing into its own copied helper files / fixtures if the ci/ dir ever
 * ends up in the built site. */
const SKIP_TOP_DIRS = new Set(['ci']);

/* Inline script types that are JavaScript. '' covers a missing type attr. */
const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module']);

if (!fs.existsSync(siteDir) || !fs.statSync(siteDir).isDirectory()) {
  console.error(`check-inline-scripts: site directory not found: ${siteDir}`);
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

function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue; /* external script, never compressed */
    let type = '';
    const t = attrs.match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
    if (t) type = (t[1] || t[2] || t[3] || '').trim().toLowerCase();
    if (!JS_TYPES.has(type)) continue; /* ld+json, templates, etc. */
    if (!body.trim()) continue;
    out.push({ body, module: type === 'module' });
  }
  return out;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inline-script-check-'));
let pages = 0;
let checked = 0;
const failures = [];

try {
  for (const file of htmlFiles(siteDir, true)) {
    pages++;
    const rel = path.relative(siteDir, file).split(path.sep).join('/');
    const scripts = inlineScripts(fs.readFileSync(file, 'utf8'));
    scripts.forEach((s, i) => {
      checked++;
      const tmp = path.join(tmpDir, `s${checked}${s.module ? '.mjs' : '.js'}`);
      fs.writeFileSync(tmp, s.body);
      const res = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
      if (res.status !== 0) {
        const firstLine = s.body.trim().split('\n')[0].slice(0, 160);
        const errLine =
          ((res.stderr || '').match(/^\w*(?:Syntax)?Error:.*$/m) || [])[0] ||
          (res.stderr || '').trim().split('\n').pop() ||
          'did not parse';
        failures.push({ page: rel, n: i + 1, firstLine, errLine });
      }
    });
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`check-inline-scripts: ${checked} inline script(s) across ${pages} page(s) in ${siteDir}`);

if (failures.length) {
  console.error(`\n${failures.length} inline script(s) FAILED to parse:\n`);
  for (const f of failures) {
    console.error(`  ${f.page}  (inline script #${f.n})`);
    console.error(`    ${f.errLine}`);
    console.error(`    first line: ${f.firstLine}\n`);
  }
  console.error(
    'Likely cause: production HTML compression strips newlines, so a `//` line\n' +
    'comment swallows the rest of the script. Use /* */ comments in inline\n' +
    'scripts, or move the code to an external .js file (CLAUDE.md gotcha #1).');
  process.exit(1);
}

console.log('check-inline-scripts: OK');
