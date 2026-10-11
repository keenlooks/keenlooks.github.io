"""Generate the per-gadget Open Graph link-preview cards (images/og/<slug>.png).

Each covered page is POSED live in system Chrome against the RUNNING dev server
(http://localhost:4010, `docker compose up`), screenshotted, and composed onto a
1200x630 navy card in the favicon's visual language (Big Dipper motif, gold on
navy) with the page title and keanelucas.com. A page whose pose fails falls back
to the branded title-only card. Rerunning is idempotent: it overwrites the same
images/og/<slug>.png files.

Re-run after design tweaks (the dev server must be up first):

    python make_og_cards.py              # all cards
    python make_og_cards.py voyage qr    # just these slugs

Requires Pillow (pip install pillow), node on PATH, playwright-core (override:
OG_NODE_PATH) and system Chrome. On the Mac mini: playwright-core from
_tests/node_modules, scratch in $TMPDIR/designpass/F5/, and HEADFUL slugs (the
WebGL globe) pose in a visible Chrome window; on Windows: playwright-core at
%LOCALAPPDATA%/Temp/pushreview/node_modules, scratch in
%LOCALAPPDATA%/Temp/designpass/F5/. The Playwright stager script and all scratch
(screenshots, sample images) are written there at runtime; only this python
file lives in the repo. Fonts follow make_favicons.py: local Segoe UI (Arial on
the Mac) stands in for Source Sans 3, which is fine because the rendered PNGs
are what gets committed. The og_image front matter on each covered page
points at the output; _includes/seo.html turns that into og:image /
twitter:image.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

from PIL import Image, ImageDraw, ImageStat

from make_favicons import (DIPPER, FONTS_BOLD, FONTS_REGULAR, GOLD, GOLD_DIM,
                           LINES, NAVY_BOTTOM, NAVY_TOP, POLARIS,
                           four_point_star, load_font)

REPO = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(REPO, "images", "og")
BASE_URL = "http://localhost:4010"
if sys.platform == "win32":  # the Windows laptop the cards were first made on
    TEMP = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")),
                        "Temp", "designpass", "F5")
    CHROME = r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
    NODE_DEFAULT = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Temp",
                                "pushreview", "node_modules")
else:  # the Mac mini (since 2026-09-24): $TMPDIR scratch, the pinned _tests deps
    TEMP = os.path.join(tempfile.gettempdir(), "designpass", "F5")
    CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    NODE_DEFAULT = os.path.join(REPO, "_tests", "node_modules")
SHOTS = os.path.join(TEMP, "shots")
NODE_PATH = os.environ.get("OG_NODE_PATH", NODE_DEFAULT)
# WebGL pages: headless Chrome on the Mac cannot start WebGL (the globe falls
# back to a flat map), so these are posed in a separate, visible browser.
HEADFUL = {"observatory"}
# Extra query per slug (the Observatory reads its live layers from the local
# antenna dev server, `node antenna/dev-server.mjs`; override: OG_ANTENNA).
QUERY = {"observatory": "?antenna=" + os.environ.get("OG_ANTENNA",
                                                     "http://127.0.0.1:8788")}
# Per-slug viewport where the standard one hides the money shot (at 1120 wide
# the Observatory panel covers the globe; at 1440x900 the whole disc sits
# clear between the plate and the panel).
VIEWPORTS = {"observatory": {"width": 1440, "height": 900}}

VIEW_W, VIEW_H = 1120, 960
CROP_TOP = 70          # masthead strip removed from viewport shots
CARD_W, CARD_H = 1200, 630
SIZE_CAP = 250 * 1024  # bytes

TEXT_BRIGHT = (238, 241, 246)
BORDER = (86, 100, 124)

# slug -> (url path, display title, shot mode, element selector or None).
# Display titles are the page titles; the three marked ones are shortened to
# their Fun-hub card names because the SEO-length page title does not fit a
# card (deviation noted in the build report).
PAGES = [
    ("life", "/life/", "Conway's Game of Life", "viewport", None),
    ("gravity", "/gravity/", "Gravity Sandbox", "viewport", None),
    ("magnets", "/magnets/", "Magnetic Field Visualizer", "viewport", None),
    ("pendulum", "/pendulum/", "Double Pendulum", "viewport", None),
    ("epidemic", "/epidemic/", "Epidemic", "viewport", None),
    ("hash", "/hash/", "Hash Avalanche", "viewport", None),
    ("adversarial", "/adversarial/", "Fool a Neural Network", "viewport", None),
    ("lander", "/lander/", "Rocket Lander", "viewport", None),
    ("transformer", "/transformer/", "Tiny Transformer", "viewport", None),
    ("fourier", "/fourier/", "Fourier Drawing Machine", "viewport", None),
    ("bayes", "/bayes/", "When a 99% Accurate Test Is Usually Wrong",
     "viewport", None),
    ("timing", "/timing/", "Recovering a Secret From Timing Alone",
     "element", "#timing-canvas"),
    ("fourinarow", "/fourinarow/", "Four in a Row", "viewport", None),
    ("keepittogether", "/keepittogether/", "Keep It Together", "viewport", None),
    ("creatures", "/creatures/", "Evolving Creatures", "viewport", None),
    ("computer", "/computer/", "The Visible Computer", "viewport", None),
    ("voyage", "/voyage/", "Mission to Anywhere", "viewport", None),
    ("observatory", "/observatory/", "The Observatory", "viewport", None),
    ("bonds", "/bonds/", "Why Bond Prices Fall When Rates Rise",
     "element", "#bond-canvas"),
    ("loans", "/loans/", "Where Your Loan Payments Actually Go",
     "element", "#loan-canvas"),
    ("diversification", "/diversification/", "Diversification & Risk",  # short
     "element", "#div-spread-canvas"),
    ("imagetools", "/imagetools/", "Image Studio", "viewport", None),   # short
    ("pdftools", "/pdftools/", "PDF Toolbench", "viewport", None),      # short
    ("qr", "/qr/", "QR Studio", "viewport", None),
    ("diff", "/diff/", "Diff Checker", "viewport", None),
]

DIFF_A = ("The quick brown fox\njumps over the lazy dog.\n"
          "Rockets land on pads.\nHashes avalanche.\nOrbits stay closed.\n")
DIFF_B = ("The quick brown fox\nleaps over the lazy dog.\n"
          "Rockets land on barges.\nHashes avalanche.\nOrbits stay closed.\n"
          "Pendulums diverge.\n")

# ---------------------------------------------------------------- stager (JS)

STAGER_JS = r"""/* OG-card pose stager. Written by make_og_cards.py; do not edit by hand.
   Usage: node stager.js jobs.json  (NODE_PATH must reach playwright-core). */
'use strict';
const fs = require('fs');
const { chromium } = require('playwright-core');

const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function opt(promise, what) {
  try { await promise; } catch (e) {
    console.log('    (skipped ' + what + ': ' + String(e.message || e).split('\n')[0] + ')');
  }
}

async function drawHeart(page, W, H) {
  /* Fallback pose for /fourier/: trace a heart with the mouse. */
  const cx = W * 0.44, cy = H * 0.46, s = 9;
  const pt = (t) => [
    cx + s * 16 * Math.pow(Math.sin(t), 3),
    cy - s * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)),
  ];
  const p0 = pt(0);
  await page.mouse.move(p0[0], p0[1]);
  await page.mouse.down();
  for (let i = 1; i <= 56; i++) {
    const p = pt((i / 56) * Math.PI * 2);
    await page.mouse.move(p[0], p[1]);
    await sleep(8);
  }
  await page.mouse.up();
}

async function pose(page, job) {
  const W = cfg.viewport.width, H = cfg.viewport.height;
  const extra = job.attempt > 1 ? 4000 : 0;
  const S = job.slug;
  if (S === 'life') { await sleep(2800 + extra); }
  else if (S === 'gravity') {
    await opt(page.check('#grav-trails', { timeout: 3000 }), 'trace orbits');
    await opt(page.click('#grav-preset', { timeout: 4000 }), 'solar preset');
    await sleep(6000 + extra);
  }
  else if (S === 'magnets') {
    await opt(page.click('#mag-preset', { timeout: 4000 }), 'two-magnets preset');
    await sleep(2200 + extra);
  }
  else if (S === 'pendulum') { await sleep(3600 + extra); }
  else if (S === 'epidemic') {
    await sleep(1200);
    await opt(page.mouse.click(W * 0.5, H * 0.45), 'infect click');
    await sleep(5200 + extra);
  }
  else if (S === 'hash') {
    /* The page lands on the Collisions view; the avalanche bit grid is the
       page's namesake visual, so switch to it and flip one character. */
    await sleep(1500);
    await opt(page.click('button:has-text("Avalanche")', { timeout: 3000 }), 'avalanche view');
    await sleep(900);
    await opt(page.click('#hash-flip', { timeout: 3000 }), 'flip a char');
    await sleep(700 + extra);
  }
  else if (S === 'adversarial') { await sleep(4200 + extra); }
  else if (S === 'lander') { await sleep(3300 + extra); /* mid-descent */ }
  else if (S === 'transformer') {
    await sleep(2600);
    await opt(page.click('#tt-go', { timeout: 3500 }), 'generate');
    await sleep(4200 + extra);
  }
  else if (S === 'fourier') {
    await sleep(1200);
    let ok = false;
    try {
      await page.selectOption('#fx-preset', { label: 'Heart' }, { timeout: 2500 });
      ok = true;
    } catch (e) { /* no such select; draw by hand */ }
    if (!ok) {
      try {
        await page.selectOption('.fx-panel select', { index: 1 }, { timeout: 1500 });
        ok = true;
      } catch (e) { /* still nothing; draw */ }
    }
    if (!ok) await drawHeart(page, W, H);
    await sleep(5200 + extra);
  }
  else if (S === 'bayes') {
    /* The headline (You tested positive ... 33%) carries the message, so
       frame it with the grid: run the test, then scroll it into the shot. */
    await sleep(1200);
    await opt(page.click('#bayes-run', { timeout: 4000 }), 'test everyone');
    await sleep(1600);
    await opt(page.mouse.wheel(0, -4000), 'scroll to top');
    await sleep(300);
    await opt(page.mouse.wheel(0, 280), 'frame headline and grid');
    await sleep(500 + extra);
  }
  else if (S === 'timing') {
    await sleep(1000);
    await opt(page.click('#timing-attack', { timeout: 4000 }), 'attack');
    await sleep(6500 + extra);
  }
  else if (S === 'fourinarow') {
    await sleep(3200);
    await page.keyboard.press('Escape'); /* dismiss the first-run tour */
    await sleep(400);
    await opt(page.mouse.click(W * 0.30, H * 0.55), 'drop disc 1');
    await sleep(3800 + extra);
    await opt(page.mouse.click(W * 0.37, H * 0.55), 'drop disc 2');
    await sleep(3200);
  }
  else if (S === 'creatures') {
    /* The build-mode landing (an editable body, dots and springs) is the
       page's own opening view and its boldest visual; just drop the tour. */
    await sleep(1800);
    await page.keyboard.press('Escape');
    await sleep(600 + extra);
  }
  else if (S === 'computer') {
    /* Swap the auto-booted Bouncing pixel for the Sierpinski demo, whose
       output actually fills the 32x32 screen; fall back to the boot demo. */
    await sleep(2500);
    await page.keyboard.press('Escape'); /* dismiss the first-run tour */
    await sleep(300);
    try {
      const val = await page.locator('#comp-examples option').evaluateAll((os) => {
        const o = os.find((x) => /sierpinski/i.test(x.textContent || ''));
        return o ? o.value : null;
      });
      if (val !== null) {
        await page.selectOption('#comp-examples', val);
        await sleep(400);
        await page.click('#comp-assemble', { timeout: 3000 });
      }
    } catch (e) {
      console.log('    (kept the boot demo: ' + String(e.message || e).split('\n')[0] + ')');
    }
    await sleep(7500 + extra); /* let the triangle fill in */
  }
  else if (S === 'voyage') {
    /* Aim: the parked-at-TRAPPIST-1-e view (search, launch, Esc-skip, close
       card). Any failed step degrades to the system overview by design. */
    await sleep(2600);
    try {
      await page.fill('#voy-search', 'TRAPPIST-1 e', { timeout: 6000 });
      await sleep(1200);
      await page.press('#voy-search', 'ArrowDown');
      await sleep(300);
      await page.press('#voy-search', 'Enter');
      await sleep(4500);
      await opt(page.click('button:has-text("Plan the trip")', { timeout: 3500 }), 'plan the trip');
      await sleep(1800);
      let launched = false;
      try {
        /* The docked action-row Launch lives inside the card, not #voy-launch
           (that one belongs to the porkchop planner). */
        await page.click('#voy-card button:has-text("Launch")', { timeout: 3500 });
        launched = true;
      } catch (e) {
        try {
          await page.click('button:has-text("Launch")', { timeout: 2000 });
          launched = true;
        } catch (e2) { console.log('    (no Launch; keeping system overview)'); }
      }
      if (launched) {
        await sleep(2800);
        await page.keyboard.press('Escape'); /* skip cruise: ship arrives */
        await sleep(4200);
        await page.keyboard.press('Escape'); /* close the arrival card */
        await sleep(1600 + extra);
      }
    } catch (e) {
      console.log('    (voyage pose fell back: ' + String(e.message || e).split('\n')[0] + ')');
      await sleep(2000);
    }
  }
  else if (S === 'observatory') {
    /* The whole WebGL globe with the plate and its key, shot inside the boot
       tour: it holds the home view until about 13 s, then the autopilot flies
       to its first event (measured 2026-10-09), so no retry padding here. */
    await sleep(11000);
    const s = await page.evaluate(() => {
      try {
        const a = window.__obs.ap();
        return 'gl=' + window.ObsGlobe.glReady() + ' ap=' + a.state + ' boot=' + !!(a.boot && a.boot.active);
      } catch (e) { return 'hooks unavailable'; }
    });
    console.log('    (' + s + ')');
  }
  else if (S === 'bonds') { await sleep(1800 + extra); }
  else if (S === 'loans') { await sleep(1800 + extra); }
  else if (S === 'diversification') { await sleep(3400 + extra); }
  else if (S === 'imagetools') {
    await opt(page.setInputFiles('#it-file', cfg.sampleA, { timeout: 6000 }), 'sample image');
    await sleep(2400 + extra);
  }
  else if (S === 'pdftools') {
    await opt(page.setInputFiles('#pt-file', [cfg.sampleA, cfg.sampleB, cfg.sampleC],
                                 { timeout: 6000 }), 'sample pages');
    await sleep(3800 + extra);
    await opt(page.mouse.wheel(0, 300), 'scroll to the page grid');
    await sleep(500);
  }
  else if (S === 'qr') {
    await opt(page.fill('#qs-url', 'https://keanelucas.com', { timeout: 5000 }), 'url');
    await sleep(1000 + extra);
  }
  else if (S === 'diff') {
    await opt(page.fill('#df-text-a', cfg.diffA, { timeout: 5000 }), 'text a');
    await opt(page.fill('#df-text-b', cfg.diffB, { timeout: 5000 }), 'text b');
    await opt(page.click('#df-compare', { timeout: 4000 }), 'compare');
    await sleep(1200 + extra);
  }
  else { await sleep(3000 + extra); }
}

(async () => {
  const browser = await chromium.launch({
    executablePath: cfg.chrome,
    headless: cfg.headless !== false,
    args: ['--enable-unsafe-swiftshader', '--hide-scrollbars', '--force-color-profile=srgb'],
  });
  const context = await browser.newContext({
    viewport: cfg.viewport,
    deviceScaleFactor: 1,
    colorScheme: 'dark',
  });
  await context.addInitScript(() => {
    try { localStorage.setItem('theme', 'dark'); } catch (e) { /* ok */ }
  });
  for (const job of cfg.jobs) {
    const out = cfg.shots + '/' + job.slug + '.png';
    const vp = job.viewport || cfg.viewport;
    console.log('  posing ' + job.slug + ' (' + job.url + ')');
    const page = await context.newPage();
    if (job.viewport) await page.setViewportSize(vp);
    page.on('dialog', (d) => { d.accept().catch(() => {}); });
    try {
      await page.goto(cfg.base + job.url, { waitUntil: 'load', timeout: 45000 });
      await page.addStyleTag({
        content: '#chat-widget,#theme-toggle,#life-link,#life-egg,.gadget-hint{display:none!important}',
      });
      await pose(page, job);
      if (job.shot === 'element') {
        await page.locator(job.sel).first().screenshot({ path: out, timeout: 15000 });
      } else {
        await page.screenshot({
          path: out,
          clip: { x: 0, y: cfg.cropTop, width: vp.width, height: vp.height - cfg.cropTop },
        });
      }
      console.log('    shot -> ' + out);
    } catch (e) {
      console.log('    FAILED ' + job.slug + ': ' + String(e.message || e).split('\n')[0]);
    }
    await page.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
"""

# --------------------------------------------------------------- sample photos


def make_sample_images():
    """Three small abstract 'photos' for the Image Studio / PDF Toolbench
    poses: dusk gradients with a gold sun and dark hills, in the site's own
    palette so the staged thumbnails look native."""
    paths = []
    scenes = [
        ((58, 76, 104), (18, 26, 42), 0.30, 0.34),
        ((84, 96, 116), (22, 28, 40), 0.68, 0.30),
        ((44, 66, 96), (14, 20, 34), 0.50, 0.26),
    ]
    for i, (top, bottom, sun_x, sun_y) in enumerate(scenes):
        w, h = 1200, 800
        img = Image.new("RGB", (w, h))
        d = ImageDraw.Draw(img, "RGBA")
        for y in range(h):
            t = y / (h - 1)
            col = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
            d.line([(0, y), (w, y)], fill=col)
        cx, cy = sun_x * w, sun_y * h
        for mult, alpha in ((3.0, 24), (2.0, 40), (1.4, 60)):
            r = 46 * mult
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GOLD + (alpha,))
        d.ellipse([cx - 46, cy - 46, cx + 46, cy + 46], fill=GOLD + (255,))
        hills = [(0, h)]
        import math
        for x in range(0, w + 1, 24):
            y = h * 0.72 + 60 * math.sin(x / 180.0 + i * 2.1) + 26 * math.sin(x / 63.0 + i)
            hills.append((x, y))
        hills.append((w, h))
        d.polygon(hills, fill=(16, 19, 27))
        p = os.path.join(TEMP, "sample-%s.jpg" % "abc"[i])
        img.save(p, quality=88)
        paths.append(p)
    return paths


# ------------------------------------------------------------------ dev server


def poll_steady(url, timeout=90):
    """200 + two consecutive identical bodies (other agents edit concurrently;
    wait for the rebuild to settle before shooting)."""
    last = None
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(url, timeout=10) as r:
                body = r.read()
                if r.status == 200:
                    import hashlib
                    h = hashlib.md5(body).hexdigest()
                    if h == last:
                        return True
                    last = h
        except Exception:
            last = None
        time.sleep(1.5)
    return False


# ----------------------------------------------------------------- composition


def gradient_bg(d, w, h):
    for y in range(h):
        t = y / (h - 1)
        col = tuple(round(a + (b - a) * t) for a, b in zip(NAVY_TOP, NAVY_BOTTOM))
        d.line([(0, y), (w, y)], fill=col)


def draw_dipper(d, x0, y0, bw, bh, star_r, line_w):
    pts = [(x0 + x * bw, y0 + y * bh) for x, y in DIPPER]
    for a, b in LINES:
        d.line([pts[a], pts[b]], fill=GOLD_DIM, width=line_w)
    for cx, cy in pts:
        d.ellipse([cx - star_r, cy - star_r, cx + star_r, cy + star_r],
                  fill=GOLD + (255,))


def wrap_text(d, text, font, max_w):
    words = text.split()
    lines, cur = [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if d.textlength(trial, font=font) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def fit_title(d, text, max_w, sizes, max_lines):
    for size in sizes:
        font = load_font(FONTS_BOLD, size)
        lines = wrap_text(d, text, font, max_w)
        if len(lines) <= max_lines and \
           all(d.textlength(ln, font=font) <= max_w for ln in lines):
            return font, lines, size
    return font, lines, sizes[-1]


def compose_card(slug, title, shot_path):
    ss = 2
    W, H = CARD_W * ss, CARD_H * ss
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img, "RGBA")
    gradient_bg(d, W, H)

    if shot_path and os.path.exists(shot_path):
        shot = Image.open(shot_path).convert("RGB")
        box_x0, box_y0 = 452 * ss, 44 * ss
        box_w, box_h = (1152 - 452) * ss, (586 - 44) * ss
        scale = min(box_w / shot.width, box_h / shot.height)
        sw, sh = max(1, round(shot.width * scale)), max(1, round(shot.height * scale))
        shot = shot.resize((sw, sh), Image.LANCZOS)
        px = box_x0 + (box_w - sw) // 2
        py = box_y0 + (box_h - sh) // 2
        img.paste(shot, (px, py))
        d.rectangle([px - 1, py - 1, px + sw, py + sh],
                    outline=BORDER + (255,), width=ss)

        # Left column: dipper motif, title, domain.
        draw_dipper(d, 56 * ss, 60 * ss, 250 * ss, 84 * ss,
                    round(0.0055 * W), max(round(0.0022 * W), 2))
        font, lines, size = fit_title(
            d, title, 360 * ss,
            [s * ss for s in (54, 48, 44, 40, 36, 32)], 5)
        line_h = round(size * 1.18)
        block_h = line_h * len(lines)
        ty = round((210 * ss + 520 * ss) / 2 - block_h / 2)
        for ln in lines:
            d.text((56 * ss, ty), ln, font=font, fill=TEXT_BRIGHT)
            ty += line_h
        site_font = load_font(FONTS_REGULAR, 26 * ss)
        d.text((56 * ss, 556 * ss), "keanelucas.com", font=site_font, fill=GOLD)
    else:
        # Branded fallback: default-card layout with the page title.
        bx, by, bw, bh = 0.03 * W, 0.46 * H, 0.60 * W, 0.58 * H
        pts = [(bx + x * bw, by + y * bh) for x, y in DIPPER]
        lw = max(round(0.0035 * W), 2)
        for a, b in LINES:
            d.line([pts[a], pts[b]], fill=GOLD_DIM, width=lw)
        r = 0.008 * W
        for cx, cy in pts:
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GOLD + (255,))
        cx, cy = 0.865 * W, 0.20 * H
        r_long = 0.030 * W
        for mult, alpha in ((2.1, 10), (1.6, 14), (1.2, 18)):
            rg = r_long * mult
            d.ellipse([cx - rg, cy - rg, cx + rg, cy + rg], fill=GOLD + (alpha,))
        d.polygon(four_point_star(cx, cy, r_long, r_long * 0.36),
                  fill=GOLD + (255,))
        font, lines, size = fit_title(
            d, title, 980 * ss, [s * ss for s in (76, 64, 56, 48)], 3)
        line_h = round(size * 1.16)
        ty = round(H * 0.42 - line_h * len(lines) / 2)
        for ln in lines:
            lw_px = d.textlength(ln, font=font)
            d.text(((W - lw_px) / 2, ty), ln, font=font, fill=TEXT_BRIGHT)
            ty += line_h
        site_font = load_font(FONTS_REGULAR, 30 * ss)
        sw = d.textlength("keanelucas.com", font=site_font)
        d.text(((W - sw) / 2, ty + 18 * ss), "keanelucas.com",
               font=site_font, fill=GOLD)

    return img.resize((CARD_W, CARD_H), Image.LANCZOS)


def save_capped(img, path):
    img.save(path, optimize=True)
    if os.path.getsize(path) <= SIZE_CAP:
        return os.path.getsize(path)
    for colors in (256, 192, 128, 96, 64):
        q = img.quantize(colors=colors, method=Image.MEDIANCUT,
                         dither=Image.FLOYDSTEINBERG)
        q.save(path, optimize=True)
        if os.path.getsize(path) <= SIZE_CAP:
            break
    return os.path.getsize(path)


# ------------------------------------------------------------------------ main


def shot_is_blank(path):
    if not os.path.exists(path):
        return True
    g = Image.open(path).convert("L")
    return ImageStat.Stat(g).stddev[0] < 3.5


def run_stager(pages, attempt):
    """Headless batch first, then any HEADFUL pages in a visible browser."""
    for headless in (True, False):
        group = [p for p in pages if (p[0] not in HEADFUL) == headless]
        if group:
            run_stager_batch(group, attempt, headless)


def run_stager_batch(pages, attempt, headless):
    jobs = [{"slug": s, "url": u + QUERY.get(s, ""), "shot": mode, "sel": sel,
             "attempt": attempt, "viewport": VIEWPORTS.get(s)}
            for (s, u, _t, mode, sel) in pages]
    sample_paths = make_sample_images()
    cfg = {
        "base": BASE_URL, "chrome": CHROME, "headless": headless,
        "shots": SHOTS.replace("\\", "/"),
        "viewport": {"width": VIEW_W, "height": VIEW_H}, "cropTop": CROP_TOP,
        "jobs": jobs, "diffA": DIFF_A, "diffB": DIFF_B,
        "sampleA": sample_paths[0], "sampleB": sample_paths[1],
        "sampleC": sample_paths[2],
    }
    stager = os.path.join(TEMP, "stager.js")
    jobs_file = os.path.join(TEMP, "jobs.json")
    with open(stager, "w", encoding="ascii") as f:
        f.write(STAGER_JS)
    with open(jobs_file, "w", encoding="ascii") as f:
        json.dump(cfg, f)
    env = dict(os.environ)
    env["NODE_PATH"] = NODE_PATH
    subprocess.run(["node", stager, jobs_file], env=env, check=True,
                   cwd=TEMP, shell=False)


def main():
    wanted = set(sys.argv[1:])
    pages = [p for p in PAGES if not wanted or p[0] in wanted]
    if not pages:
        print("no matching slugs; known: " + ", ".join(p[0] for p in PAGES))
        return 1
    os.makedirs(SHOTS, exist_ok=True)
    os.makedirs(OUT_DIR, exist_ok=True)

    print("waiting for the dev server to be steady on each page...")
    for slug, url, _t, _m, _s in pages:
        ok = poll_steady(BASE_URL + url)
        print(("  %-16s %s" % (slug, "steady" if ok else
                               "NOT steady (continuing anyway)")))

    print("posing pages in Chrome...")
    run_stager(pages, attempt=1)
    retry = [p for p in pages
             if shot_is_blank(os.path.join(SHOTS, p[0] + ".png"))]
    if retry:
        print("re-shooting %d blank/failed page(s): %s" %
              (len(retry), ", ".join(p[0] for p in retry)))
        time.sleep(4)
        run_stager(retry, attempt=2)

    print("composing cards...")
    for slug, _url, title, _mode, _sel in pages:
        shot = os.path.join(SHOTS, slug + ".png")
        if shot_is_blank(shot):
            print("  %-16s using branded fallback (no usable shot)" % slug)
            shot = None
        card = compose_card(slug, title, shot)
        out = os.path.join(OUT_DIR, slug + ".png")
        size = save_capped(card, out)
        print("  %-16s -> %s (%d KB)" % (slug, os.path.relpath(out, REPO),
                                         size // 1024))
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
