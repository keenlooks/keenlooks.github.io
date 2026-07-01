/* ==========================================================================
   Conway's Game of Life — full-screen interactive playground (/life/ only)
   --------------------------------------------------------------------------
   The simulation runs on a persistent "world" grid that is sized to the
   viewport at the SMALLEST cell size. The cell-size slider then acts like a
   zoom: larger cells show fewer of the world's cells (the rest stay off-screen
   but keep evolving), so shrinking the cells again brings them back to life.
   Cells use the site's monochrome theme color (like the page background), and
   you can draw on the whole page with mouse or touch.
   ========================================================================== */
(function () {
  var canvas = document.getElementById('life-canvas');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');

  var MAX_CELLS = 130000;       // compute budget: the most cells we'll simulate at once
  var MIN_CELL_FLOOR = 3;       // never shrink cells below this (aesthetics / touch)
  var minCell = MIN_CELL_FLOOR; // smallest cell size that tiles the whole screen within budget

  var CELL = 6;                             // current render size (cell-size slider)
  var fps = 8;                              // generations per second (speed slider)
  var born = { 3: true };
  var survive = { 2: true, 3: true };

  var worldCols = 0, worldRows = 0, grid = null, next = null, dpr = 1;
  var running = true, raf = null, lastStep = 0;

  function cellColor() {
    // Monochrome, but a gentler contrast than the body text so it's easy on the eyes.
    var forced = document.documentElement.getAttribute('data-theme');
    var light = (forced === 'light') ||
      (!forced && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
    return light ? '#5e5e5e' : '#a0a0a0';
  }

  // Smallest cell size that still tiles the whole viewport without exceeding the
  // compute budget — this becomes the slider's minimum, so the densest setting
  // fills the entire screen.
  function computeMinCell() {
    var vw = window.innerWidth, vh = window.innerHeight, c = MIN_CELL_FLOOR;
    while (c < 64 && Math.ceil(vw / c) * Math.ceil(vh / c) > MAX_CELLS) c++;
    return c;
  }

  function refreshMinCell() {
    minCell = computeMinCell();
    if (size) {
      size.min = minCell;
      if (+size.value < minCell) {
        size.value = minCell;
        if (sizeVal) sizeVal.textContent = minCell;
        CELL = minCell;
      }
    }
  }

  function neededWorld() {
    return {
      c: Math.ceil(window.innerWidth / minCell) + 1,
      r: Math.ceil(window.innerHeight / minCell) + 1
    };
  }

  function initWorld() {
    var n = neededWorld();
    worldCols = n.c; worldRows = n.r;
    grid = new Uint8Array(worldCols * worldRows);
    next = new Uint8Array(worldCols * worldRows);
  }

  // Grow the world (never shrink) so off-screen cells survive viewport changes.
  function growWorldIfNeeded() {
    var n = neededWorld();
    if (n.c <= worldCols && n.r <= worldRows) return;
    var nc = Math.max(worldCols, n.c), nr = Math.max(worldRows, n.r);
    var g = new Uint8Array(nc * nr);
    for (var y = 0; y < worldRows; y++) {
      for (var x = 0; x < worldCols; x++) g[y * nc + x] = grid[y * worldCols + x];
    }
    grid = g;
    next = new Uint8Array(nc * nr);
    worldCols = nc; worldRows = nr;
  }

  function resizeCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function randomize() {
    for (var i = 0; i < grid.length; i++) grid[i] = Math.random() < 0.28 ? 1 : 0;
    draw();
  }
  function clearBoard() { grid.fill(0); draw(); }

  function step() {
    var c = worldCols, r = worldRows;
    for (var y = 0; y < r; y++) {
      for (var x = 0; x < c; x++) {
        var n = 0;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            var nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= c || ny >= r) continue;
            n += grid[ny * c + nx];
          }
        }
        var idx = y * c + x;
        next[idx] = grid[idx] ? (survive[n] ? 1 : 0) : (born[n] ? 1 : 0);
      }
    }
    var tmp = grid; grid = next; next = tmp;
  }

  function draw() {
    var vw = window.innerWidth, vh = window.innerHeight;
    ctx.clearRect(0, 0, vw, vh);
    ctx.fillStyle = cellColor();
    var visCols = Math.min(worldCols, Math.ceil(vw / CELL) + 1);
    var visRows = Math.min(worldRows, Math.ceil(vh / CELL) + 1);
    for (var y = 0; y < visRows; y++) {
      for (var x = 0; x < visCols; x++) {
        if (grid[y * worldCols + x]) ctx.fillRect(x * CELL, y * CELL, CELL - 1, CELL - 1);
      }
    }
  }

  function loop(t) {
    raf = requestAnimationFrame(loop);
    if (!running) return;
    if (t - lastStep < 1000 / fps) return;
    lastStep = t;
    step();
    draw();
  }

  /* ---- draw on the grid (mouse + touch via pointer events) ---- */
  var painting = false, paintVal = 1;
  function cellAt(clientX, clientY) {
    var rect = canvas.getBoundingClientRect();
    var x = Math.floor((clientX - rect.left) / CELL);
    var y = Math.floor((clientY - rect.top) / CELL);
    if (x < 0 || y < 0 || x >= worldCols || y >= worldRows) return -1;
    return y * worldCols + x;
  }
  canvas.addEventListener('pointerdown', function (e) {
    var idx = cellAt(e.clientX, e.clientY);
    if (idx < 0) return;
    painting = true;
    paintVal = grid[idx] ? 0 : 1;
    grid[idx] = paintVal;
    draw();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!painting) return;
    var idx = cellAt(e.clientX, e.clientY);
    if (idx < 0) return;
    grid[idx] = paintVal;
    draw();
  });
  function endPaint() { painting = false; }
  canvas.addEventListener('pointerup', endPaint);
  canvas.addEventListener('pointercancel', endPaint);

  /* ---- controls ---- */
  var playBtn = document.getElementById('life-play');
  function setRunning(v) { running = v; playBtn.textContent = running ? 'Pause' : 'Play'; }
  playBtn.addEventListener('click', function () { setRunning(!running); });
  document.getElementById('life-rand').addEventListener('click', randomize);
  document.getElementById('life-clear').addEventListener('click', function () { clearBoard(); setRunning(false); });
  document.getElementById('life-step').addEventListener('click', function () { setRunning(false); step(); draw(); });

  var speed = document.getElementById('life-speed'), speedVal = document.getElementById('life-speed-val');
  speed.addEventListener('input', function () { fps = +speed.value; speedVal.textContent = speed.value; });

  // Cell size = zoom only; the persistent world is untouched, so off-screen
  // cells keep evolving and reappear when you shrink the cells again.
  var size = document.getElementById('life-size'), sizeVal = document.getElementById('life-size-val');
  size.addEventListener('input', function () { CELL = +size.value; sizeVal.textContent = size.value; draw(); });

  /* ---- rule editor (Born / Survives, 0..8) ---- */
  function buildToggles(containerId, set) {
    var c = document.getElementById(containerId);
    for (var i = 0; i <= 8; i++) {
      (function (i) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'life-toggle' + (set[i] ? ' on' : '');
        b.textContent = i;
        b.addEventListener('click', function () {
          if (set[i]) { delete set[i]; b.classList.remove('on'); }
          else { set[i] = true; b.classList.add('on'); }
          updateRuleString();
        });
        c.appendChild(b);
      })(i);
    }
  }
  function sortedKeys(o) {
    return Object.keys(o).map(Number).sort(function (a, b) { return a - b; }).join('');
  }
  function updateRuleString() {
    document.getElementById('life-rulestring').textContent = 'B' + sortedKeys(born) + '/S' + sortedKeys(survive);
  }
  function refreshToggles(containerId, set) {
    var c = document.getElementById(containerId);
    Array.prototype.forEach.call(c.children, function (b, i) {
      if (set[i]) b.classList.add('on'); else b.classList.remove('on');
    });
  }
  function applyRule(str) {
    var m = /B([0-8]*)\/S([0-8]*)/i.exec(str);
    if (!m) return;
    born = {}; survive = {};
    m[1].split('').forEach(function (d) { born[+d] = true; });
    m[2].split('').forEach(function (d) { survive[+d] = true; });
    refreshToggles('life-born', born);
    refreshToggles('life-survive', survive);
    updateRuleString();
  }
  buildToggles('life-born', born);
  buildToggles('life-survive', survive);
  updateRuleString();
  Array.prototype.forEach.call(document.querySelectorAll('.life-preset'), function (b) {
    b.addEventListener('click', function () { applyRule(b.getAttribute('data-rule')); });
  });

  /* ---- patterns (classic Conway constructions, stored as standard RLE) ---- */
  var PATTERNS = {
    'glider-gun': '24bo$22bobo$12b2o6b2o12b2o$11bo3bo4b2o12b2o$2o8bo5bo3b2o$2o8bo3bob2o4bobo$10bo5bo7bo$11bo3bo$12b2o!',
    'pulsar': '2b3o3b3o2b2$o4bobo4bo$o4bobo4bo$o4bobo4bo$2b3o3b3o2b2$2b3o3b3o2b$o4bobo4bo$o4bobo4bo$o4bobo4bo2$2b3o3b3o!',
    'lwss': 'o2bo$4bo$o3bo$b4o!'
  };

  // Decode run-length-encoded Life patterns ("b" dead, "o" alive, "$" row end).
  function parseRLE(str) {
    var cells = [], x = 0, y = 0, w = 0, count = '';
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
      if (ch >= '0' && ch <= '9') { count += ch; continue; }
      var n = count ? parseInt(count, 10) : 1;
      count = '';
      if (ch === 'b') { x += n; }
      else if (ch === 'o') { for (var k = 0; k < n; k++) cells.push([x++, y]); }
      else if (ch === '$') { w = Math.max(w, x); x = 0; y += n; }
      else if (ch === '!') break;
    }
    w = Math.max(w, x);
    return { w: w, h: y + 1, cells: cells };
  }

  // Stamp a pattern into the world, centered in the visible viewport.
  function stampCentered(rle) {
    var p = parseRLE(rle);
    var visCols = Math.min(worldCols, Math.ceil(window.innerWidth / CELL));
    var visRows = Math.min(worldRows, Math.ceil(window.innerHeight / CELL));
    var ox = Math.max(0, Math.floor((visCols - p.w) / 2));
    var oy = Math.max(0, Math.floor((visRows - p.h) / 2));
    for (var i = 0; i < p.cells.length; i++) {
      var x = ox + p.cells[i][0], y = oy + p.cells[i][1];
      if (x < worldCols && y < worldRows) grid[y * worldCols + x] = 1;
    }
    draw();
  }

  Array.prototype.forEach.call(document.querySelectorAll('.life-pattern'), function (b) {
    b.addEventListener('click', function () {
      var rle = PATTERNS[b.getAttribute('data-pattern')];
      if (!rle) return;
      applyRule('B3/S23'); /* these constructions only work under Conway rules */
      clearBoard();
      stampCentered(rle);
      setRunning(true);
    });
  });

  /* ---- shareable URLs: encode the live cells (bounding box, RLE) in the hash ---- */
  function serializeGrid() {
    var minX = worldCols, minY = worldRows, maxX = -1, maxY = -1, x, y;
    for (y = 0; y < worldRows; y++) {
      for (x = 0; x < worldCols; x++) {
        if (grid[y * worldCols + x]) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null; /* empty board */
    var out = '', run = 0, runCh = '';
    function flush() {
      if (!run) return;
      out += (run > 1 ? run : '') + runCh;
      run = 0;
    }
    for (y = minY; y <= maxY; y++) {
      for (x = minX; x <= maxX; x++) {
        var ch = grid[y * worldCols + x] ? 'o' : 'b';
        if (ch === runCh) { run++; } else { flush(); runCh = ch; run = 1; }
      }
      if (runCh === 'b') run = 0; /* trailing dead cells in a row are implicit */
      flush();
      runCh = '$'; run = 1;
      if (y === maxY) run = 0;
      flush();
      runCh = '';
    }
    return out + '!';
  }

  var shareBtn = document.getElementById('life-share');
  if (shareBtn) {
    shareBtn.addEventListener('click', function () {
      var rle = serializeGrid();
      var old = 'Share';
      if (!rle) { shareBtn.textContent = 'Board is empty'; }
      else if (rle.length > 8000) { shareBtn.textContent = 'Too big to share'; }
      else {
        var rule = 'B' + sortedKeys(born) + 'S' + sortedKeys(survive);
        var hash = '#r=' + rule + ';p=' + rle;
        var url = location.origin + location.pathname + hash;
        try { history.replaceState(null, '', hash); } catch (e) {}
        var done = function () { shareBtn.textContent = 'Link copied!'; };
        var fail = function () { shareBtn.textContent = 'URL updated — copy it'; };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(done, fail);
        } else { fail(); }
      }
      setTimeout(function () { shareBtn.textContent = old; }, 1800);
    });
  }

  function loadFromHash() {
    var m = /[#;]r=B([0-8]*)S([0-8]*)/.exec(location.hash);
    var pm = /[#;]p=([0-9bo$]+!)/.exec(location.hash);
    if (!pm) return false;
    if (m) applyRule('B' + m[1] + '/S' + m[2]);
    grid.fill(0);
    stampCentered(pm[1]);
    return true;
  }

  /* collapse / expand the controls (starts collapsed on small screens) */
  var collapseBtn = document.getElementById('life-collapse');
  var panel = document.getElementById('life-panel');
  if (collapseBtn && panel) {
    function setCollapsed(c) {
      panel.classList.toggle('life-panel--collapsed', c);
      collapseBtn.textContent = c ? '+' : '–';
      collapseBtn.setAttribute('aria-label', c ? 'Show controls' : 'Hide controls');
    }
    collapseBtn.addEventListener('click', function () {
      setCollapsed(!panel.classList.contains('life-panel--collapsed'));
    });
    if (window.innerWidth < 600) setCollapsed(true);
  }

  /* recolor cells when the site theme changes */
  try {
    new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  } catch (e) {}

  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { refreshMinCell(); growWorldIfNeeded(); resizeCanvas(); draw(); }, 150);
  });

  refreshMinCell();
  initWorld();
  resizeCanvas();
  if (!loadFromHash()) randomize(); /* a shared pattern in the URL replaces the soup */
  raf = requestAnimationFrame(loop);
})();
