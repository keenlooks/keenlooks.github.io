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
  var elPanel = id('hash-panel'), elCollapse = id('hash-collapse');

  var BITS = 256, COLS = 16;
  var bits = new Uint8Array(BITS);
  var flips = new Array(BITS);
  var hexDigest = '';
  var prevText = null;
  var changedCount = -1;
  var view = 'collide';                   // 'collide' | 'result' (Collisions is the default — it's the fun one)
  var elBlurb = id('hash-blurb'), elHint = id('hash-hint');
  var BLURBS = {
    result: 'Change one letter of the message and about half of SHA-256’s 256 output bits flip. That is the avalanche effect: from two hashes you cannot tell how similar the inputs were. Click the grid (or the button) to change a character.',
    collide: 'A good hash makes it infeasible to find two inputs with the same output. CRC32, a real checksum used everywhere (ZIP, PNG, Ethernet), is only 32 bits and was never built to resist that, so a birthday search turns up two inputs with the same checksum in a fraction of a second.'
  };
  var HINTS = {
    result: 'Each square is one output bit. Changed bits flash as you edit.',
    collide: 'Each dot is one input’s 32-bit CRC. Press “Find a collision” to search.'
  };
  function setText() {
    if (elBlurb) elBlurb.textContent = BLURBS[view];
    if (elHint) elHint.textContent = HINTS[view];
  }
  var W = 0, H = 0, dpr = 1, raf = null;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
  /* keep the scatter clear of the top nav, the top-right controls panel, and the bottom result text */
  function plotBounds() { return { x0: 24, x1: (W > 700 ? W - 360 : W - 24), y0: 180, y1: H - 132 }; }
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
      if (shown.length > 46) shown = shown.slice(0, 46) + '…';
      elPrev.textContent = 'previous: ' + shown;
    }
    prevText = text;
    var my = ++seq;
    crypto.subtle.digest('SHA-256', enc.encode(text)).then(function (b) { if (my === seq) setDigest(b); });
  }
  function flipOneChar() {
    if (!elText) return;
    var t = elText.value, ab = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    var c = ab[Math.floor(Math.random() * ab.length)];
    if (!t.length) elText.value = c;
    else { var i = Math.floor(Math.random() * t.length); while (c === t[i]) c = ab[Math.floor(Math.random() * ab.length)]; elText.value = t.slice(0, i) + c + t.slice(i + 1); }
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
      ctx.fillText('SHA-256 — 256 bits', W / 2, gy + side + side * 0.05 + fs * 3.1);
    }
  }

  function drawCollide(now) {
    /* the scatter of every CRC32 we've seen (low 16 bits → x, high 16 → y) */
    if (acc) ctx.drawImage(acc, 0, 0, W, H);
    ctx.font = '600 ' + Math.max(15, Math.min(22, W / 34)) + 'px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = textColor(0.75);
    var head = found
      ? 'Collision found after ' + found.tries.toLocaleString() + ' inputs'
      : (searching ? 'Searching… ' + tries.toLocaleString() + ' distinct inputs tried' : 'CRC32 collision search');
    ctx.fillText(head, W / 2, 146);                 /* clear of the top nav / vignette */

    /* live ticker: the input being hashed right now and the value it maps to */
    if (searching && lastTried) {
      ctx.font = Math.max(12, Math.min(16, W / 60)) + 'px ui-monospace, SFMono-Regular, Consolas, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = textColor(0.6);
      ctx.fillText('hashing  "' + lastTried.s + '"  →  0x' + hex32(lastTried.c), W / 2, 172);
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
      var bxp = Math.min(W - bxw - 8, px + 14), byp = Math.max(8, py - 34);
      ctx.strokeStyle = badColor(); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(bxp + 8, byp + bxh); ctx.stroke();
      ctx.fillStyle = badColor(); roundRect(bxp, byp, bxw, bxh, 6); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(lbl, bxp + 8, byp + bxh / 2);

      ctx.font = Math.max(13, Math.min(18, W / 42)) + 'px ui-monospace, SFMono-Regular, Consolas, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillStyle = textColor(0.85);
      var yb = H - 104;                              /* lifted up so it isn't crammed at the very bottom */
      ctx.fillText('CRC32("' + found.a + '")  =  CRC32("' + found.b + '")', W / 2, yb);
      ctx.fillStyle = badColor();
      ctx.fillText('=  0x' + hex32(found.crc), W / 2, yb + 24);
      ctx.font = Math.max(12, W / 70) + 'px "Source Sans 3", system-ui, sans-serif';
      ctx.fillStyle = textColor(0.5);
      ctx.fillText('two different inputs, identical checksum', W / 2, yb + 46);
    } else if (!searching && tries === 0) {
      ctx.font = Math.max(13, W / 64) + 'px "Source Sans 3", system-ui, sans-serif';
      ctx.fillStyle = textColor(0.55); ctx.textBaseline = 'top';
      ctx.fillText('Press “Find a collision” — each dot is one input’s 32-bit CRC.', W / 2, 160);
    }
  }

  function draw(now) {
    raf = requestAnimationFrame(draw);
    if (!W || !H) { resize(); if (!W || !H) return; }
    if (view === 'collide') searchStep();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = bg(); ctx.fillRect(0, 0, W, H);
    if (view === 'collide') drawCollide(now); else drawResult(now);
  }

  canvas.addEventListener('pointerdown', function (e) { if (view === 'result') { flipOneChar(); e.preventDefault(); } });
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
