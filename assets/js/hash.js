/* ==========================================================================
   Hash — two properties of hash functions, shown live.
   --------------------------------------------------------------------------
   "Avalanche"  — SHA-256's final 256-bit digest as a 16×16 grid (WebCrypto).
                  Changing the message flips ~half the bits; changed bits flash.
   "Collisions" — a live birthday search for a CRC32 collision. CRC32 is a real,
                  ubiquitous checksum (ZIP, PNG, Ethernet) built to catch
                  *accidental* errors, not to resist attackers. Because its
                  output is only 32 bits, two different inputs that share a CRC32
                  turn up after ~2¹⁶–2¹⁷ tries — which the browser finds in well
                  under a second. (A real cryptographic hash makes this
                  infeasible; see the note on the page for the researchers who
                  nonetheless broke MD5 and SHA-1.)

   Original code; theme-aware; reduced-motion aware.
   ========================================================================== */
(function () {
  var canvas = document.getElementById('hash-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  function id(x) { return document.getElementById(x); }

  var elText = id('hash-text'), elFlip = id('hash-flip'), elFind = id('hash-find');
  var elChanged = id('hash-changed'), elPrev = id('hash-prev');
  if (window.GadgetUI) GadgetUI.liveStatus(elChanged);
  var elPanel = id('hash-panel'), elCollapse = id('hash-collapse');

  var BITS = 256, COLS = 16;
  var bits = new Uint8Array(BITS);
  var flips = new Array(BITS);
  var hexDigest = '';
  var prevText = null;
  var changedCount = -1;
  var view = 'collide';                   // 'collide' | 'result' (Collisions is the default — it's the fun one)
  var elBlurb = id('hash-blurb'), elHint = id('hash-hint'), elTitle = id('hash-title');
  var TITLES = { result: 'Hash Avalanche', collide: 'Hash Collisions' };
  var BLURBS = {
    result: 'Change one letter of the message and about half of SHA-256’s 256 output bits flip. That is the avalanche effect: from two hashes you cannot tell how similar the inputs were. ' +
      ((window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ? 'Tap' : 'Click') +
      ' the grid (or the button) to change a character.',
    collide: 'A good hash makes it infeasible to find two inputs with the same output. CRC32, a real checksum used everywhere (ZIP, PNG, Ethernet), is only 32 bits and was never built to resist that, so a birthday search turns up two inputs with the same checksum in a fraction of a second.'
  };
  var HINTS = {
    result: 'Each square is one output bit. Changed bits flash as you edit.',
    collide: 'Each dot is one input’s 32-bit CRC. Press “Find a collision” to search.'
  };
  /* the canvas's accessible name describes the view actually drawn */
  var LABELS = {
    result: 'A 16 by 16 grid showing the 256 bits of the message\u2019s SHA-256 digest; changed bits flash when the message changes.',
    collide: 'A live CRC32 collision search: each dot is one input\u2019s 32-bit checksum, plotted until two different inputs share one.'
  };
  function setText() {
    if (elTitle) elTitle.textContent = TITLES[view];   /* the panel names the view you're in */
    canvas.setAttribute('aria-label', LABELS[view]);
    if (elBlurb) elBlurb.textContent = BLURBS[view];
    if (elHint) elHint.textContent = HINTS[view];
  }
  var W = 0, H = 0, dpr = 1, raf = null;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /* Under a coarse pointer the panel's collapse toggle is touch-sized (40px),
     so the collapsed panel ends near y 145 instead of 132. The collide view's
     header, ticker and scatter top all drop by TOP_DROP there to keep a gap
     below it (the header stays well clear of the nav, gotcha 6). */
  var TOP_DROP = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ? 12 : 0;
  var HEAD_Y = 146 + TOP_DROP, TICK_Y = 172 + TOP_DROP;
  var seq = 0;

  /* ===== CRC32 (standard table-based) ===== */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
  })();
  var enc = new TextEncoder();
  function crc32(str) {
    var c = 0xFFFFFFFF, b = enc.encode(str);
    for (var i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function hex32(n) { return ('00000000' + n.toString(16)).slice(-8); }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  /* collision-search state */
  var seen = null, tries = 0, found = null, searching = false;
  var acc = null, accCtx = null;           // offscreen point accumulation
  function resetSearch() {
    seen = new Map(); tries = 0; found = null;
    if (acc) { accCtx.clearRect(0, 0, acc.width, acc.height); }
  }
  function ensureAcc() {
    if (!acc) { acc = document.createElement('canvas'); accCtx = acc.getContext('2d'); }
    if (acc.width !== Math.round(W * dpr) || acc.height !== Math.round(H * dpr)) {
      acc.width = Math.round(W * dpr); acc.height = Math.round(H * dpr);
      accCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }
  var lastTried = null;

  /* The fixed corner buttons (#theme-toggle / #life-link) float over the canvas
     in the bottom-left, and sit higher on phones. Measure them so the drawn text
     can stay above them. They are created on DOMContentLoaded, which can land
     AFTER the first animation frame, so the measurement is refreshed from the
     draw loop rather than taken once, and until it lands we fall back to the
     height the stylesheet gives them (2.6rem tall at bottom 1.25rem, raised to
     bottom 4rem at <= 768px, in _sass/_color-scheme-light.scss). Getting that
     first value right matters here: the scatter accumulates into an offscreen
     buffer, so a point plotted under a stale band would stay there. */
  function fallbackBand() {
    var rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return (window.innerWidth <= 768 ? 6.6 : 3.85) * rem;
  }
  var cornerBand = fallbackBand(), lastMeasure = -1e9;
  function measureChrome() {
    var b = 0, ids = ['theme-toggle', 'life-link'], k, el, r;
    for (k = 0; k < ids.length; k++) {
      el = document.getElementById(ids[k]);
      if (!el) continue;
      r = el.getBoundingClientRect();
      if (r.height) b = Math.max(b, window.innerHeight - r.top);
    }
    cornerBand = b || fallbackBand();
  }

  /* Baseline of the first result line: above the corner buttons, with the
     scatter ending above it so the two never stack. */
  function resultTop() { return H - Math.max(104, cornerBand + 58); }
  /* keep the scatter clear of the top nav, the top-right controls panel, and the bottom result text */
  /* The live ticker is drawn at y 172 (up to 16 px tall), so the scatter
     starts below it, at y 196, instead of under it (all plus TOP_DROP). On a short screen (a
     phone in landscape) that would leave no plot at all, so there the ticker
     is dropped and the plot keeps the old top, and it never inverts. */
  /* Wide and short (a phone in landscape): the result lines would leave the
     scatter a 14 to 75 px band, so they move to a column right of the plot and
     the plot runs down to just above the corner buttons. */
  function sideMode() { return W >= 600 && H < 500; }
  function plotBottom() { return sideMode() ? H - cornerBand - 14 : resultTop() - 36; }
  function tickerRoom() { return plotBottom() - (196 + TOP_DROP) >= 100; }
  function plotBounds() {
    var y1 = plotBottom(), y0 = (tickerRoom() ? 196 : 180) + TOP_DROP;
    var x1 = sideMode() ? side.x1 : (W > 700 ? W - 360 : W - 24);
    return { x0: 24, x1: x1, y0: y0, y1: Math.max(y0 + 12, y1) };
  }
  /* The side column ends at the right edge, or left of the controls panel
     when the panel is open and reaches down beside the column (it used to be
     drawn under the open panel, and on a phone the re-run button lives in that
     panel). The plot gives up width so the column fits, using a smaller font
     first. Measured once per frame, not per plotted point. */
  var side = { x1: 0, r: 0, mono: 16, wrap: false };
  var SIDE_WIDEST = '=  CRC32("wwwwwwwww")', SIDE_CAP = 'two different inputs, identical checksum';
  function updateSide() {
    if (!W || !H) return;
    var half = Math.round(W * 0.5) - 12;
    if (!sideMode()) { side.x1 = half; side.r = W; return; }
    var r = W, y0 = (tickerRoom() ? 196 : 180) + TOP_DROP;
    if (elPanel) {
      var pr = elPanel.getBoundingClientRect(), cr = canvas.getBoundingClientRect();
      if (pr.width && pr.height && pr.bottom - cr.top > y0 + 8 && pr.left - cr.left < W)
        r = Math.round(pr.left - cr.left) - 12;
    }
    var mono = 16, x1 = half, w;
    for (; mono >= 13; mono--) {
      ctx.font = mono + 'px ui-monospace, SFMono-Regular, Consolas, monospace';
      w = ctx.measureText(SIDE_WIDEST).width;
      x1 = Math.min(half, Math.floor(r - w - 24));
      if (x1 >= 120) break;
    }
    side.mono = Math.max(13, mono);
    side.x1 = Math.max(120, x1);
    side.r = r;
    ctx.font = '13px "Source Sans 3", system-ui, sans-serif';
    side.wrap = ctx.measureText(SIDE_CAP).width > r - side.x1 - 16;
  }
  /* The scatter lives in an offscreen buffer in plot coordinates, so when the
     plot rectangle changes (the panel opened or closed, the corner buttons
     measured, a resize after a find) it is redrawn from the inputs seen so far
     instead of keeping dots at their old places. */
  var accKey = '';
  function syncAcc() {
    var b = plotBounds(), key = [W, H, b.x0, b.x1, b.y0, b.y1].join(',');
    if (key === accKey) return;
    accKey = key;
    if (!acc || !seen) return;
    ensureAcc();
    accCtx.clearRect(0, 0, W, H);
    accCtx.fillStyle = (effectiveTheme() === 'light') ? 'rgba(52,86,138,0.5)' : 'rgba(130,166,204,0.5)';
    seen.forEach(function (s, c) { accCtx.fillRect(ptX(c) - 1, ptY(c) - 1, 2, 2); });
  }
  function ptX(crc) { var b = plotBounds(); return b.x0 + (crc & 0xffff) / 0xffff * (b.x1 - b.x0); }
  function ptY(crc) { var b = plotBounds(); return b.y0 + ((crc >>> 16) & 0xffff) / 0xffff * (b.y1 - b.y0); }
  var SALT = 'abcdefghijklmnopqrstuvwxyz0123456789';
  function randStr() {
    /* random inputs so CRC32 outputs are ~uniform — a birthday collision then
       turns up near 2^16. (Structured/sequential inputs don't collide: CRC32 is
       linear, so it stays effectively injective over a low-entropy input family.) */
    var n = 5 + ((Math.random() * 5) | 0), s = '';
    for (var k = 0; k < n; k++) s += SALT[(Math.random() * 36) | 0];
    return s;
  }
  function searchStep() {
    if (!searching || found) return;
    ensureAcc();
    accCtx.fillStyle = (effectiveTheme() === 'light') ? 'rgba(52,86,138,0.5)' : 'rgba(130,166,204,0.5)';
    var batch = reduced ? 400 : 2200;
    for (var i = 0; i < batch; i++) {
      var s = randStr();
      var c = crc32(s);
      lastTried = { s: s, c: c };
      var prev = seen.get(c);
      if (prev !== undefined && prev !== s) { found = { a: prev, b: s, crc: c, tries: tries }; searching = false; break; }
      if (prev === s) continue;                     // same random string drawn twice: not a collision
      seen.set(c, s);
      tries++;
      accCtx.fillRect(ptX(c) - 1, ptY(c) - 1, 2, 2);
    }
  }

  function effectiveTheme() {
    var f = document.documentElement.getAttribute('data-theme');
    if (f === 'light' || f === 'dark') return f;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }
  function bg() { return effectiveTheme() === 'light' ? '#f3f5f8' : '#101216'; }
  function onColor() { return effectiveTheme() === 'light' ? '#5e5e5e' : '#a0a0a0'; }
  function offColor() { return 'rgba(127,127,127,0.13)'; }
  function accent() { return effectiveTheme() === 'light' ? '#34568a' : '#82a6cc'; }
  function badColor() { return '#c4574a'; }
  function textColor(a) { return effectiveTheme() === 'light' ? 'rgba(38,38,38,' + a + ')' : 'rgba(214,214,214,' + a + ')'; }

  function resize() {
    var ow = W, oh = H;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    /* dimension guard (epidemic-style): mobile fires resize on URL-bar
       show/hide — a height-only nudge must not wipe the running search.
       A real resize still restarts it (point coords depend on the size). */
    if (W === ow && Math.abs(H - oh) < 120) return;
    if (view === 'collide' && !found) resetSearch();   // keep a found collision
  }

  /* ===== Avalanche (SHA-256) ===== */
  function setDigest(buf) {
    var bytes = new Uint8Array(buf), i;
    var nb = new Uint8Array(BITS), hex = '';
    for (i = 0; i < 32; i++) {
      hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
      for (var k = 0; k < 8; k++) nb[i * 8 + k] = (bytes[i] >> (7 - k)) & 1;
    }
    var changed = 0, now = performance.now(), first = (changedCount === -1);
    for (i = 0; i < BITS; i++) {
      if (nb[i] !== bits[i]) { changed++; if (!first) flips[i] = { t0: now + (reduced ? 0 : Math.random() * 450), dur: reduced ? 1 : 550 }; }
      bits[i] = nb[i];
    }
    hexDigest = hex;
    if (!first) { changedCount = changed; if (elChanged) elChanged.textContent = changed + ' / 256 bits flipped (' + (changed / 2.56).toFixed(1) + '%)'; }
    else { changedCount = 0; if (elChanged) elChanged.textContent = 'Edit the message to see the avalanche.'; }
  }
  function rehash() {
    if (view !== 'result') return;
    if (!(window.crypto && crypto.subtle)) { if (elChanged) elChanged.textContent = 'WebCrypto unavailable in this browser.'; return; }
    var text = elText ? elText.value : '';
    if (prevText !== null && elPrev) {
      var shown = prevText === '' ? '(empty)' : prevText;
      var cps = Array.from(shown);
      if (cps.length > 46) shown = cps.slice(0, 46).join('') + '…';
      elPrev.textContent = 'previous: ' + shown;
    }
    prevText = text;
    var my = ++seq;
    crypto.subtle.digest('SHA-256', enc.encode(text)).then(function (b) { if (my === seq) setDigest(b); });
  }
  var MARK_RE = null;
  try { MARK_RE = new RegExp('^\\p{M}$', 'u'); } catch (e) {}
  function isMark(ch) { return MARK_RE ? MARK_RE.test(ch) : /^[\u0300-\u036f]$/.test(ch); }
  function flipOneChar() {
    if (!elText) return;
    var ab = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    /* whole code points, so an emoji or a rare CJK character is replaced, never split into a
       lone surrogate; a combining accent is skipped when the message has anything else */
    var t = Array.from(elText.value), c = ab[Math.floor(Math.random() * ab.length)], picks = [], k;
    for (k = 0; k < t.length; k++) if (!isMark(t[k])) picks.push(k);
    if (!picks.length) for (k = 0; k < t.length; k++) picks.push(k);
    if (!t.length) elText.value = c;
    else {
      var i = picks[Math.floor(Math.random() * picks.length)];
      while (c === t[i]) c = ab[Math.floor(Math.random() * ab.length)];
      t[i] = c; elText.value = t.join('');
    }
    rehash();
  }

  /* ===== drawing ===== */
  function drawResult(now) {
    var side = Math.min(W * 0.86, H * 0.62);
    var cell = side / COLS, gap = Math.max(1.5, cell * 0.14);
    var gx = (W - side) / 2, gy = Math.max(86, (H - side) / 2 - H * 0.04);
    for (var i = 0; i < BITS; i++) {
      var x = gx + (i % COLS) * cell, y = gy + Math.floor(i / COLS) * cell, w = cell - gap;
      var f = flips[i], k = 0;
      if (f) { var p = (now - f.t0) / f.dur; if (p >= 1) flips[i] = null; else k = p < 0 ? 0 : 1 - p; }
      if (bits[i]) { ctx.fillStyle = k > 0.02 ? accent() : onColor(); ctx.globalAlpha = 0.7; ctx.fillRect(x, y, w, w); }
      else { ctx.fillStyle = k > 0.02 ? accent() : offColor(); ctx.globalAlpha = k > 0.02 ? 0.45 : 1; ctx.fillRect(x, y, w, w); }
      ctx.globalAlpha = 1;
    }
    if (hexDigest) {
      var fs = Math.max(11, Math.min(19, side / 34));
      ctx.font = fs + 'px ui-monospace, SFMono-Regular, Consolas, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = textColor(0.75);
      ctx.fillText(hexDigest.slice(0, 32), W / 2, gy + side + side * 0.05);
      ctx.fillText(hexDigest.slice(32), W / 2, gy + side + side * 0.05 + fs * 1.45);
      ctx.font = (fs * 0.78) + 'px "Source Sans 3", system-ui, sans-serif';
      ctx.fillStyle = textColor(0.45);
      ctx.fillText('SHA-256, 256 bits', W / 2, gy + side + side * 0.05 + fs * 3.1);
    }
  }

  function drawCollide(now) {
    /* The scatter of every CRC32 we've seen (low 16 bits → x, high 16 → y).
       The buffer is only cleared when it is resized, so it can still hold points
       plotted under earlier bounds; clip the blit to the current plot rectangle
       so the scatter can never spill onto the result text below it. */
    if (acc) {
      var pb = plotBounds();
      ctx.save();
      ctx.beginPath();
      ctx.rect(pb.x0 - 3, pb.y0 - 3, (pb.x1 - pb.x0) + 6, (pb.y1 - pb.y0) + 6);
      ctx.clip();
      ctx.drawImage(acc, 0, 0, W, H);
      ctx.restore();
    }
    var headFs = Math.max(15, Math.min(22, W / 34));
    ctx.font = '600 ' + headFs + 'px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = textColor(0.75);
    var head = found
      ? 'Collision found after ' + found.tries.toLocaleString() + ' inputs'
      : (searching ? 'Searching… ' + tries.toLocaleString() + ' distinct inputs tried' : 'CRC32 collision search');
    /* beside an open panel (phone landscape) the header and ticker centre in
       the strip left of it, shrinking to fit, instead of running under it */
    var hx = W / 2, strip = W;
    if (sideMode() && side.r < W - 12) {
      strip = side.r; hx = strip / 2 + 6;
      var hw = ctx.measureText(head).width;
      if (hw > strip - 16) {
        headFs = Math.max(12, headFs * (strip - 16) / hw);
        ctx.font = '600 ' + headFs + 'px "Source Sans 3", system-ui, sans-serif';
      }
    }
    ctx.fillText(head, hx, HEAD_Y);                 /* clear of the top nav / vignette */

    /* live ticker: the input being hashed right now and the value it maps to */
    if (searching && lastTried && tickerRoom()) {
      ctx.font = Math.max(12, Math.min(16, W / 60)) + 'px ui-monospace, SFMono-Regular, Consolas, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = textColor(0.6);
      ctx.fillText('hashing  "' + lastTried.s + '"  →  0x' + hex32(lastTried.c), hx, TICK_Y);
    }

    if (found) {
      /* flash the shared point both inputs map to, and label it with the value */
      var px = ptX(found.crc), py = ptY(found.crc);
      var pulse = reduced ? 6 : 6 + 4 * Math.sin(now / 200);
      ctx.beginPath(); ctx.arc(px, py, pulse + 6, 0, 6.2832);
      ctx.strokeStyle = badColor(); ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.arc(px, py, 3.5, 0, 6.2832); ctx.fillStyle = badColor(); ctx.fill();
      /* callout box with the shared hash, clamped on-screen */
      var lbl = '0x' + hex32(found.crc);
      ctx.font = '600 14px ui-monospace, SFMono-Regular, Consolas, monospace';
      var tw = ctx.measureText(lbl).width, bxw = tw + 16, bxh = 24;
      /* keep the badge off the header line (it goes below the point when the
         point is near the top) and out of the result column and the panel's
         column: it never reaches past the plot's right edge */
      var xLim = plotBounds().x1 + 8;
      var bxp = px + 14;
      if (bxp + bxw > xLim) bxp = px - 14 - bxw;
      bxp = Math.max(8, Math.min(W - bxw - 8, bxp));
      var byp = py - 34, below = byp < HEAD_Y + headFs + 6, beside = false;
      if (below) byp = Math.min(H - bxh - 8, py + 16);
      /* a short plot (phone landscape) leaves no room below the point above
         the corner buttons: sit the badge beside the point instead */
      if (below && byp + bxh > H - cornerBand - 6) { byp = py - bxh / 2; beside = true; }
      byp = Math.max(8, byp);
      ctx.strokeStyle = badColor(); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, py);
      if (beside) ctx.lineTo(bxp < px ? bxp + bxw : bxp, byp + bxh / 2);
      else ctx.lineTo(bxp + 8, below ? byp : byp + bxh);
      ctx.stroke();
      ctx.fillStyle = badColor(); roundRect(bxp, byp, bxw, bxh, 6); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(lbl, bxp + 8, byp + bxh / 2);

      ctx.font = Math.max(13, Math.min(18, W / 42)) + 'px ui-monospace, SFMono-Regular, Consolas, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillStyle = textColor(0.85);
      if (sideMode()) {
        /* stacked in the column right of the plot (left of an open panel) */
        var cx = (side.x1 + 12 + side.r) / 2, ys = plotBounds().y0 + 30, lh = side.mono + 8;
        ctx.font = side.mono + 'px ui-monospace, SFMono-Regular, Consolas, monospace';
        ctx.fillText('CRC32("' + found.a + '")', cx, ys);
        ctx.fillText('=  CRC32("' + found.b + '")', cx, ys + lh);
        ctx.fillStyle = badColor();
        ctx.fillText('=  0x' + hex32(found.crc), cx, ys + 2 * lh);
        ctx.font = '13px "Source Sans 3", system-ui, sans-serif';
        ctx.fillStyle = textColor(0.5);
        if (side.wrap) {
          ctx.fillText('two different inputs,', cx, ys + 2 * lh + 22);
          ctx.fillText('identical checksum', cx, ys + 2 * lh + 39);
        } else {
          ctx.fillText(SIDE_CAP, cx, ys + 2 * lh + 22);
        }
      } else {
        var yb = resultTop();
        ctx.fillText('CRC32("' + found.a + '")  =  CRC32("' + found.b + '")', W / 2, yb);
        ctx.fillStyle = badColor();
        ctx.fillText('=  0x' + hex32(found.crc), W / 2, yb + 24);
        ctx.font = Math.max(12, W / 70) + 'px "Source Sans 3", system-ui, sans-serif';
        ctx.fillStyle = textColor(0.5);
        ctx.fillText('two different inputs, identical checksum', W / 2, yb + 46);
      }
    } else if (!searching && tries === 0) {
      /* idle landing (reduced-motion visitors see this first): sit the
         instruction fully below the header line, never overlapping it */
      /* in the strip left of an open panel it shrinks to fit, and splits into
         two lines when even 11 px would not fit (it never runs off the left) */
      var idle = ['Press “Find a collision”: each dot is one input’s 32-bit CRC.'];
      var ifs = Math.max(13, W / 64), room = strip - 16, iw;
      ctx.font = ifs + 'px "Source Sans 3", system-ui, sans-serif';
      iw = ctx.measureText(idle[0]).width;
      if (iw > room) {
        if (ifs * room / iw < 11) {
          idle = ['Press “Find a collision”:', 'each dot is one input’s 32-bit CRC.'];
          iw = Math.max(ctx.measureText(idle[0]).width, ctx.measureText(idle[1]).width);
        }
        if (iw > room) ifs = Math.max(11, ifs * room / iw);
        ctx.font = ifs + 'px "Source Sans 3", system-ui, sans-serif';
      }
      ctx.fillStyle = textColor(0.55); ctx.textBaseline = 'top';
      for (var il = 0; il < idle.length; il++) ctx.fillText(idle[il], hx, HEAD_Y + headFs * 1.6 + il * ifs * 1.3);
    }
  }

  function draw(now) {
    raf = requestAnimationFrame(draw);
    if (now - lastMeasure > 400) { lastMeasure = now; measureChrome(); }
    if (!W || !H) { resize(); if (!W || !H) return; }
    if (view === 'collide') { updateSide(); syncAcc(); searchStep(); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = bg(); ctx.fillRect(0, 0, W, H);
    if (view === 'collide') drawCollide(now); else drawResult(now);
  }

  canvas.addEventListener('pointerdown', function (e) {
    /* take focus off any panel control so hotkeys (R) work after a canvas
       click even when preventDefault suppresses the focus transfer */
    if (document.activeElement && document.activeElement !== document.body &&
        document.activeElement.blur) document.activeElement.blur();
    if (view === 'result') { flipOneChar(); e.preventDefault(); }
  });
  if (elFlip) elFlip.addEventListener('click', flipOneChar);
  if (elFind) elFind.addEventListener('click', function () { resetSearch(); searching = true; });
  if (elText) elText.addEventListener('input', rehash);
  var viewBtns = document.querySelectorAll('.hash-view');
  Array.prototype.forEach.call(viewBtns, function (b) {
    b.addEventListener('click', function () {
      view = b.getAttribute('data-view');
      Array.prototype.forEach.call(viewBtns, function (o) { o.classList.toggle('hash-view--on', o === b); });
      if (elFlip) elFlip.style.display = (view === 'result') ? '' : 'none';
      if (elFind) elFind.style.display = (view === 'collide') ? '' : 'none';
      var resultOnly = document.querySelectorAll('.hash-result-only');
      Array.prototype.forEach.call(resultOnly, function (el) { el.style.display = (view === 'result') ? '' : 'none'; });
      setText();
      if (view === 'collide') { resetSearch(); searching = true; } else { rehash(); }
    });
  });
  /* panel collapse + first-run hint (shared helper) */
  if (window.GadgetUI) {
    var frHint = GadgetUI.firstRunHint('hash', 'Watch the collision search, or switch to Avalanche and type.');
    GadgetUI.initPanel({
      panel: elPanel, toggle: elCollapse,
      collapsedClass: 'hash-panel--collapsed',
      help: id('hash-help'), hint: frHint
    });
  }

  /* keyboard: R = re-run the collision search (ignored while typing in the message box) */
  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (window.GadgetUI && GadgetUI.isTyping(e)) return;
    if ((e.key === 'r' || e.key === 'R') && view === 'collide') { resetSearch(); searching = true; }
  });

  var rt;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(resize, 150); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (raf) { cancelAnimationFrame(raf); raf = null; } }
    else if (!raf) raf = requestAnimationFrame(draw);
  });

  /* default view is Collisions: hide the message box, show Find, start searching */
  setText();
  if (elFlip) elFlip.style.display = 'none';
  Array.prototype.forEach.call(document.querySelectorAll('.hash-result-only'), function (el) { el.style.display = 'none'; });
  resize();
  rehash();              /* still primes the SHA-256 result grid for when you switch to Avalanche */
  searching = !reduced;  /* kick off the collision search immediately (reduced-motion: wait for the Find button) */
  raf = requestAnimationFrame(draw);
})();
