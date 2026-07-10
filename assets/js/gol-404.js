/* gol-404.js
   Game of Life for the 404 page. The grid is seeded with the digits "404"
   (rasterized from an offscreen canvas), holds for a moment, then evolves
   under B3/S23 and dissolves. Clicking the canvas re-seeds it.
   Theme-aware, pauses on hidden tabs, and stays frozen for
   prefers-reduced-motion. */
(function () {
  'use strict';

  var CELL = 5;         /* CSS px per cell */
  var HOLD_MS = 1500;   /* how long the 404 holds before evolving */
  var STEP_MS = 110;    /* ms per generation */

  var canvas, ctx, dpr = 1, cols = 0, rows = 0, grid, nextGrid;
  var cellColor = 'rgba(160, 160, 160, 0.9)';
  var holdUntil = 0, lastStep = 0, frozen = false;
  var hash1 = -1, hash2 = -2;
  var lastW = 0, lastH = 0;
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function effectiveTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t === 'light' || t === 'dark') { return t; }
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function recolor() {
    cellColor = effectiveTheme() === 'light'
      ? 'rgba(94, 94, 94, 0.9)'
      : 'rgba(160, 160, 160, 0.9)';
    draw();
  }

  function resize() {
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    lastW = w;
    lastH = h;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.max(8, Math.floor(w / CELL));
    rows = Math.max(8, Math.floor(h / CELL));
  }

  function fontFor(size) {
    return '900 ' + size + 'px "Source Sans 3", "Segoe UI", Arial, sans-serif';
  }

  function seed() {
    grid = new Uint8Array(cols * rows);
    nextGrid = new Uint8Array(cols * rows);

    /* Rasterize "404" onto an offscreen canvas, one pixel per cell, then
       sample the alpha channel into the grid. */
    var off = document.createElement('canvas');
    off.width = cols;
    off.height = rows;
    var octx = off.getContext('2d', { willReadFrequently: true });
    var size = Math.floor(rows * 0.62);
    octx.font = fontFor(size);
    while (size > 8 && octx.measureText('404').width > cols * 0.82) {
      size -= 1;
      octx.font = fontFor(size);
    }
    octx.textAlign = 'center';
    octx.textBaseline = 'middle';
    octx.fillStyle = '#fff';
    octx.fillText('404', cols / 2, rows / 2);

    var data = octx.getImageData(0, 0, cols, rows).data;
    for (var i = 0; i < cols * rows; i++) {
      if (data[i * 4 + 3] > 120) { grid[i] = 1; }
    }

    holdUntil = performance.now() + HOLD_MS;
    lastStep = 0;
    frozen = false;
    hash1 = -1;
    hash2 = -2;
  }

  function step() {
    var changed = false;
    var hash = 0;
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        var i = y * cols + x;
        var n = 0;
        /* Cells beyond the border count as dead, so the pattern can
           dissolve off the edges. */
        for (var dy = -1; dy <= 1; dy++) {
          var yy = y + dy;
          if (yy < 0 || yy >= rows) { continue; }
          for (var dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) { continue; }
            var xx = x + dx;
            if (xx < 0 || xx >= cols) { continue; }
            n += grid[yy * cols + xx];
          }
        }
        var alive = grid[i] ? (n === 2 || n === 3) : (n === 3);
        nextGrid[i] = alive ? 1 : 0;
        if (alive) { hash = ((hash * 31) + i) | 0; }
        if (nextGrid[i] !== grid[i]) { changed = true; }
      }
    }
    var tmp = grid;
    grid = nextGrid;
    nextGrid = tmp;
    /* Auto-freeze on a still life, an empty grid, or a period-2
       oscillation (blinkers), so we stop burning cycles once settled. */
    if (!changed || hash === hash2) { frozen = true; }
    hash2 = hash1;
    hash1 = hash;
  }

  function draw() {
    if (!ctx || !grid) { return; }
    var w = canvas.width / dpr;
    var h = canvas.height / dpr;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = cellColor;
    var ox = (w - cols * CELL) / 2;
    var oy = (h - rows * CELL) / 2;
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        if (grid[y * cols + x]) {
          ctx.fillRect(ox + x * CELL, oy + y * CELL, CELL - 1, CELL - 1);
        }
      }
    }
  }

  function frame(ts) {
    window.requestAnimationFrame(frame);
    if (frozen || reducedMotion.matches) { return; }
    if (ts < holdUntil) { return; }
    if (ts - lastStep < STEP_MS) { return; }
    lastStep = ts;
    step();
    draw();
  }

  function onMedia(mq, fn) {
    if (mq.addEventListener) { mq.addEventListener('change', fn); }
    else if (mq.addListener) { mq.addListener(fn); }
  }

  function init() {
    canvas = document.getElementById('gol404-canvas');
    if (!canvas || !canvas.getContext) { return; }
    ctx = canvas.getContext('2d');

    resize();
    recolor();
    seed();
    draw();

    /* A click (or tap) re-seeds the 404. */
    canvas.addEventListener('pointerdown', function () {
      seed();
      draw();
    });

    /* If the webfont arrives while the 404 is still holding, re-rasterize
       with the real glyphs. */
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        if (performance.now() < holdUntil) {
          seed();
          draw();
        }
      });
    }

    window.addEventListener('resize', function () {
      var rect = canvas.getBoundingClientRect();
      if (Math.round(rect.width) === lastW && Math.round(rect.height) === lastH) { return; }
      resize();
      seed();
      draw();
    });

    /* rAF already pauses on hidden tabs; on return, avoid an instant step. */
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { lastStep = performance.now(); }
    });

    new MutationObserver(recolor).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });
    onMedia(window.matchMedia('(prefers-color-scheme: light)'), recolor);
    onMedia(reducedMotion, function () {
      /* Coming back from reduced motion, give the pattern a fresh hold. */
      if (!reducedMotion.matches && !frozen) {
        holdUntil = performance.now() + HOLD_MS;
      }
    });

    window.requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
