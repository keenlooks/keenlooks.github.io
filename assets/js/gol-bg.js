/* ==========================================================================
   Conway's Game of Life — subtle animated background
   --------------------------------------------------------------------------
   A faint, theme-aware Game of Life simulation painted on a fixed canvas
   behind all page content. Designed to be cheap:
     - coarse cells (CELL px), so the grid is small
     - steps ~6x/second (not every animation frame)
     - freezes when the board stabilizes; only re-seeds if it dies out
     - requestAnimationFrame auto-pauses when the tab is hidden
     - honors prefers-reduced-motion (renders one static frame, no animation)
   Random seed on every load.
   ========================================================================== */
(function () {
  if (!document.body) return;
  // Don't run the ambient background on the interactive Game of Life page.
  if (document.querySelector('.life-app')) return;

  var CELL = 6;         // px per cell — coarse keeps the grid (and cost) small
  var STEP_MS = 320;    // ~3 generations per second — calm, ambient motion
  var DENSITY = 0.18;   // fraction of cells alive at seed

  var canvas = document.createElement('canvas');
  canvas.id = 'gol-bg';
  canvas.setAttribute('aria-hidden', 'true');
  var st = canvas.style;
  st.position = 'fixed';
  st.top = '0';
  st.left = '0';
  st.width = '100%';
  st.height = '100%';
  st.zIndex = '-1';        // behind content, above the page background color
  st.pointerEvents = 'none';
  st.opacity = '0';                       // faded in after load (see bottom)
  st.transition = 'opacity 2.5s ease';
  // Vignette mask: keep the center (the reading column) clean; life only shows
  // toward the margins/corners, so it's ambient rather than distracting.
  var MASK = 'radial-gradient(ellipse 80% 78% at 50% 42%, transparent 34%, rgba(0,0,0,0.55) 66%, black 95%)';
  st.webkitMaskImage = MASK;
  st.maskImage = MASK;
  document.body.insertBefore(canvas, document.body.firstChild);

  var ctx = canvas.getContext('2d');
  if (!ctx) { canvas.remove(); return; }

  var cols, rows, grid, next, raf = null, last = 0;
  var cellColor = 'rgba(255,255,255,0.07)';

  function effectiveTheme() {
    var forced = document.documentElement.getAttribute('data-theme');
    if (forced === 'light' || forced === 'dark') return forced;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }

  function setColor() {
    cellColor = effectiveTheme() === 'light' ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.05)';
  }

  function seed() {
    grid = new Uint8Array(cols * rows);
    next = new Uint8Array(cols * rows);
    for (var i = 0; i < grid.length; i++) grid[i] = Math.random() < DENSITY ? 1 : 0;
  }

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = window.innerWidth, h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(w / CELL) + 1;
    rows = Math.ceil(h / CELL) + 1;
    seed();
  }

  // Advances one generation. Returns false only when the board is fully static
  // (so the caller can stop animating). Re-seeds if the board dies out.
  function step() {
    var changed = false, pop = 0, idx, n, nx, ny, x, y, dx, dy;
    for (y = 0; y < rows; y++) {
      for (x = 0; x < cols; x++) {
        n = 0;
        for (dy = -1; dy <= 1; dy++) {
          for (dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            nx = x + dx; ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            n += grid[ny * cols + nx];
          }
        }
        idx = y * cols + x;
        next[idx] = (grid[idx] ? (n === 2 || n === 3) : (n === 3)) ? 1 : 0;
        pop += next[idx];
        if (next[idx] !== grid[idx]) changed = true;
      }
    }
    var tmp = grid; grid = next; next = tmp;
    if (pop === 0) { seed(); return true; }
    return changed;
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = cellColor;
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        if (grid[y * cols + x]) ctx.fillRect(x * CELL, y * CELL, CELL - 1, CELL - 1);
      }
    }
  }

  function loop(t) {
    raf = requestAnimationFrame(loop);
    if (t - last < STEP_MS) return;
    last = t;
    setColor();
    var alive = step();
    draw();
    if (!alive) stop(); // fully stabilized — freeze to save compute
  }

  function start() { if (!raf) { last = 0; raf = requestAnimationFrame(loop); } }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }

  // Recolor (and nudge back to life) when the theme changes.
  function recolor() { setColor(); draw(); }
  var mo = new MutationObserver(recolor);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (window.matchMedia) {
    try { window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', recolor); } catch (e) {}
  }

  var rt, lastW = window.innerWidth, lastH = window.innerHeight;
  window.addEventListener('resize', function () {
    var w = window.innerWidth, h = window.innerHeight;
    // Ignore minor height-only changes (e.g. the mobile address bar showing/
    // hiding on scroll) so the simulation doesn't reseed while scrolling.
    if (w === lastW && Math.abs(h - lastH) < 140) return;
    lastW = w; lastH = h;
    clearTimeout(rt);
    rt = setTimeout(function () { resize(); setColor(); draw(); start(); }, 200);
  });

  resize();
  setColor();
  draw();

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    canvas.style.transition = 'none';
    canvas.style.opacity = '1';
  } else {
    setTimeout(function () { canvas.style.opacity = '1'; }, 40); // gentle fade-in
    start();
  }
})();
