/* ==========================================================================
   Gravity Sandbox — an original 2D n-body gravity playground.
   --------------------------------------------------------------------------
   Newtonian gravity between every pair of bodies (F = G·m₁·m₂ / r², with a
   small softening so close passes don't explode). Bodies that touch MERGE,
   conserving mass and momentum. Original code; physics is public-domain.

   Controls:
     - Pick a MASS on the slider, then CLICK empty space to drop a body at rest;
       or DRAG and release to fling it (the drag is the velocity arrow). (touch:
       one finger)
     - CLICK an existing body to edit ITS velocity: drag to set a new velocity
       vector, or release without dragging to STOP it (zero velocity). The body
       freezes while you aim.
     - Right-click a body to delete it; right-drag empty space to pan.
     - Mouse wheel zooms toward the cursor; two-finger pinch zooms on touch.
     - Speed slider; trails toggle (long paths in each body's colour); "wells"
       toggle; pause / clear / solar-system / accretion-disk.
     - G is a fixed constant — orbits are the fun part, and those want a steady G.

   Smooth: fixed-substep integration inside requestAnimationFrame; auto-pauses
   on hidden tab. Theme-aware. Pointer Events + touch-action:none for touch.
   ========================================================================== */
(function () {
  var canvas = document.getElementById('grav-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  function id(x) { return document.getElementById(x); }

  var elSpeed = id('grav-speed'), elSpeedV = id('grav-speed-val');
  var elMass = id('grav-mass'), elMassV = id('grav-mass-val');
  var elTrails = id('grav-trails'), elWells = id('grav-wells');
  var btnPause = id('grav-pause'), btnClear = id('grav-clear'), btnPreset = id('grav-preset'), btnAccrete = id('grav-accrete');
  var elPanel = id('grav-panel'), elCollapse = id('grav-collapse');
  var status = id('grav-status');

  // ---- state -------------------------------------------------------------
  var bodies = [];                 // {x,y,vx,vy,m,color,hue,trail:[]}
  var cam = { cx: 0, cy: 0, scale: 1 };   // (cx,cy) world point at screen centre
  var speed = 1, trails = false, wells = false, paused = false;
  var G = 4;                       // fixed gravitational constant (orbits want a steady G)
  var spawnMass = 400;             // the Mass slider sets this; a plain click drops a body of this mass
  var MAX_BODIES = 160, SOFT = 5, DT = 0.12, THROW_K = 0.1, TRAIL_MAX = 2400;
  var MIN_MASS = 5, MAX_MASS = 4000;

  var W = 0, H = 0, dpr = 1;
  var pointers = {};               // active pointers by id
  var create = null;               // {wx,wy, sx,sy, cx,cy(screen now), mass}
  var vdrag = null;                // editing an existing body's velocity: {body, cx,cy}
  var rmouse = null;               // {sx,sy, moved}
  var pinch = null;                // {dist, mx, my}
  var raf = null, lastT = 0;

  function effectiveTheme() {
    var f = document.documentElement.getAttribute('data-theme');
    if (f === 'light' || f === 'dark') return f;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }
  function bg() { return effectiveTheme() === 'light' ? '#eef1f5' : '#0c0e13'; }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function sx(wx) { return (wx - cam.cx) * cam.scale + W / 2; }
  function sy(wy) { return (wy - cam.cy) * cam.scale + H / 2; }
  function wx(px) { return (px - W / 2) / cam.scale + cam.cx; }
  function wy(py) { return (py - H / 2) / cam.scale + cam.cy; }
  function radius(m) { return Math.cbrt(m) * 1.7 + 1.5; }   // world units

  // ---- bodies ------------------------------------------------------------
  function addBody(x, y, vx, vy, m, hue) {
    if (hue == null) hue = Math.random() * 360;
    bodies.push({ x: x, y: y, vx: vx, vy: vy, m: m, hue: hue, color: 'hsl(' + hue.toFixed(0) + ',72%,62%)', trail: [] });
  }
  function physics(dt) {
    var n = bodies.length, i, j, b, o, dx, dy, r2, inv, a;
    for (i = 0; i < n; i++) {
      b = bodies[i]; var ax = 0, ay = 0;
      for (j = 0; j < n; j++) {
        if (i === j) continue;
        o = bodies[j];
        dx = o.x - b.x; dy = o.y - b.y;
        r2 = dx * dx + dy * dy + SOFT * SOFT;
        inv = 1 / Math.sqrt(r2);
        a = G * o.m * inv * inv;       // |accel| = G·m / r²
        ax += a * dx * inv; ay += a * dy * inv;
      }
      b.ax = ax; b.ay = ay;
    }
    for (i = 0; i < n; i++) { b = bodies[i]; if (b.frozen) continue; b.vx += b.ax * dt; b.vy += b.ay * dt; b.x += b.vx * dt; b.y += b.vy * dt; }
    mergeOverlaps();
  }
  function mergeOverlaps() {
    for (var i = 0; i < bodies.length; i++) {
      for (var j = i + 1; j < bodies.length; j++) {
        var a = bodies[i], b = bodies[j];
        var dx = a.x - b.x, dy = a.y - b.y, d = Math.sqrt(dx * dx + dy * dy);
        if (d < radius(a.m) + radius(b.m)) {
          var m = a.m + b.m;
          a.x = (a.x * a.m + b.x * b.m) / m;
          a.y = (a.y * a.m + b.y * b.m) / m;
          a.vx = (a.vx * a.m + b.vx * b.m) / m;
          a.vy = (a.vy * a.m + b.vy * b.m) / m;
          // blend hue toward the bigger contributor
          var w = b.m / m; a.hue = a.hue + ((((b.hue - a.hue + 540) % 360) - 180)) * w;
          a.hue = (a.hue + 360) % 360; a.color = 'hsl(' + a.hue.toFixed(0) + ',72%,62%)';
          a.m = m; a.flash = 1;
          bodies.splice(j, 1); j--;
        }
      }
    }
  }

  // ---- drawing -----------------------------------------------------------
  function draw() {
    if (!W || !H) resize();
    if (!W || !H) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = bg(); ctx.fillRect(0, 0, W, H);
    var i, b, r;

    if (wells) {
      ctx.globalCompositeOperation = 'lighter';
      for (i = 0; i < bodies.length; i++) {
        b = bodies[i];
        var gr = (radius(b.m) * 6 + Math.sqrt(b.m) * 8) * cam.scale;
        var px = sx(b.x), py = sy(b.y);
        if (px < -gr || px > W + gr || py < -gr || py > H + gr) continue;
        var grad = ctx.createRadialGradient(px, py, 0, px, py, gr);
        var warm = G < 0;
        grad.addColorStop(0, warm ? 'rgba(220,120,90,0.28)' : 'rgba(110,150,210,0.28)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(px, py, gr, 0, 6.2832); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    if (trails) {
      for (i = 0; i < bodies.length; i++) {
        b = bodies[i]; if (b.trail.length < 2) continue;
        ctx.beginPath();
        for (var k = 0; k < b.trail.length; k++) { var p = b.trail[k]; if (k === 0) ctx.moveTo(sx(p[0]), sy(p[1])); else ctx.lineTo(sx(p[0]), sy(p[1])); }
        ctx.strokeStyle = b.color; ctx.globalAlpha = 0.5; ctx.lineWidth = 1.5; ctx.stroke(); ctx.globalAlpha = 1;
      }
    }

    for (i = 0; i < bodies.length; i++) {
      b = bodies[i]; r = radius(b.m) * cam.scale;
      var px2 = sx(b.x), py2 = sy(b.y);
      if (px2 < -r || px2 > W + r || py2 < -r || py2 > H + r) continue;
      if (b.flash) { ctx.beginPath(); ctx.arc(px2, py2, r + 8 * b.flash, 0, 6.2832); ctx.fillStyle = 'rgba(255,255,255,' + (0.4 * b.flash) + ')'; ctx.fill(); b.flash *= 0.85; if (b.flash < 0.05) b.flash = 0; }
      ctx.beginPath(); ctx.arc(px2, py2, Math.max(1.5, r), 0, 6.2832); ctx.fillStyle = b.color; ctx.fill();
    }

    // create preview (growing ball + throw arrow)
    if (create) {
      var cpx = sx(create.wx), cpy = sy(create.wy), cr = radius(create.mass) * cam.scale;
      ctx.beginPath(); ctx.arc(cpx, cpy, Math.max(2, cr), 0, 6.2832);
      ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1; ctx.stroke();
      if (create.cx != null) {
        ctx.beginPath(); ctx.moveTo(cpx, cpy); ctx.lineTo(create.cx, create.cy);
        ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 2; ctx.stroke();
      }
    }

    // velocity-edit preview: ring the selected body + draw its new velocity arrow
    if (vdrag && bodies.indexOf(vdrag.body) >= 0) {
      var vb = vdrag.body, vbx = sx(vb.x), vby = sy(vb.y);
      ctx.beginPath(); ctx.arc(vbx, vby, Math.max(7, radius(vb.m) * cam.scale + 5), 0, 6.2832);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.5; ctx.stroke();
      if (vdrag.cx != null) {
        ctx.beginPath(); ctx.moveTo(vbx, vby); ctx.lineTo(vdrag.cx, vdrag.cy);
        ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 2; ctx.stroke();
      }
    }
    if (status) status.textContent = bodies.length + (bodies.length === 1 ? ' body' : ' bodies');
  }

  // ---- loop --------------------------------------------------------------
  function step(t) {
    raf = requestAnimationFrame(step);
    if (!paused && speed > 0) {
      var subs = Math.max(1, Math.min(10, Math.round(speed * 4)));
      var dt = DT * speed / subs;
      for (var s = 0; s < subs; s++) physics(dt);
      if (trails) for (var i = 0; i < bodies.length; i++) { var b = bodies[i]; b.trail.push([b.x, b.y]); if (b.trail.length > TRAIL_MAX) b.trail.shift(); }
    }
    draw();
  }
  function start() { if (!raf) raf = requestAnimationFrame(step); }

  // ---- camera ------------------------------------------------------------
  function zoomAt(px, py, factor) {
    var bx = wx(px), by = wy(py);
    cam.scale = Math.max(0.05, Math.min(20, cam.scale * factor));
    cam.cx = bx - (px - W / 2) / cam.scale;
    cam.cy = by - (py - H / 2) / cam.scale;
  }

  // ---- pointer helpers ---------------------------------------------------
  function rel(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function bodyAt(px, py) {
    for (var i = bodies.length - 1; i >= 0; i--) { var b = bodies[i]; var dx = sx(b.x) - px, dy = sy(b.y) - py; if (dx * dx + dy * dy <= Math.pow(Math.max(8, radius(b.m) * cam.scale + 4), 2)) return i; }
    return -1;
  }
  function pointerCount() { var n = 0; for (var k in pointers) n++; return n; }

  canvas.addEventListener('pointerdown', function (e) {
    var p = rel(e); pointers[e.pointerId] = { x: p.x, y: p.y };
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    if (pointerCount() === 2) {        // start pinch
      create = null; var pts = vals(); pinch = { dist: dist(pts[0], pts[1]), mx: (pts[0].x + pts[1].x) / 2, my: (pts[0].y + pts[1].y) / 2 };
      return;
    }
    if (e.button === 2) { rmouse = { sx: p.x, sy: p.y, moved: false }; e.preventDefault(); return; }
    // left / touch: on an existing body → edit its velocity; on empty space → spawn a new one
    var hit = bodyAt(p.x, p.y);
    if (hit >= 0) {
      vdrag = { body: bodies[hit], cx: null, cy: null };
      vdrag.body.frozen = true;            // hold it still while you aim (release without a drag = stopped)
    } else {
      create = { wx: wx(p.x), wy: wy(p.y), sx: p.x, sy: p.y, cx: null, cy: null, mass: spawnMass };
    }
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!pointers[e.pointerId]) return;
    var p = rel(e); pointers[e.pointerId] = { x: p.x, y: p.y };
    if (pinch) {
      var pts = vals(); if (pts.length < 2) return;
      var nd = dist(pts[0], pts[1]), nm = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      if (pinch.dist > 0) zoomAt(nm.x, nm.y, nd / pinch.dist);
      cam.cx -= (nm.x - pinch.mx) / cam.scale; cam.cy -= (nm.y - pinch.my) / cam.scale;
      pinch.dist = nd; pinch.mx = nm.x; pinch.my = nm.y; return;
    }
    if (rmouse) { if (Math.abs(p.x - rmouse.sx) > 3 || Math.abs(p.y - rmouse.sy) > 3) rmouse.moved = true; if (rmouse.moved) { cam.cx -= (p.x - rmouse.sx) / cam.scale; cam.cy -= (p.y - rmouse.sy) / cam.scale; rmouse.sx = p.x; rmouse.sy = p.y; } return; }
    if (vdrag) { vdrag.cx = p.x; vdrag.cy = p.y; return; }
    if (create) { create.cx = p.x; create.cy = p.y; }
  });
  function endPointer(e) {
    var p = pointers[e.pointerId] ? { x: pointers[e.pointerId].x, y: pointers[e.pointerId].y } : rel(e);
    delete pointers[e.pointerId];
    if (pinch) { if (pointerCount() < 2) pinch = null; return; }
    if (rmouse) { if (!rmouse.moved) { var bi = bodyAt(p.x, p.y); if (bi >= 0) bodies.splice(bi, 1); } rmouse = null; return; }
    if (vdrag) {
      var vb = vdrag.body; vb.frozen = false;
      if (bodies.indexOf(vb) >= 0) {
        if (vdrag.cx != null) { vb.vx = (wx(vdrag.cx) - vb.x) * THROW_K; vb.vy = (wy(vdrag.cy) - vb.y) * THROW_K; }
        else { vb.vx = 0; vb.vy = 0; }        // clicked without dragging → stop the body
      }
      vdrag = null; return;
    }
    if (create) {
      if (bodies.length < MAX_BODIES) {
        var vxv = 0, vyv = 0;
        if (create.cx != null) { vxv = (wx(create.cx) - create.wx) * THROW_K; vyv = (wy(create.cy) - create.wy) * THROW_K; }
        addBody(create.wx, create.wy, vxv, vyv, create.mass);
      }
      create = null;
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', function (e) { delete pointers[e.pointerId]; if (vdrag) { vdrag.body.frozen = false; vdrag = null; } create = null; rmouse = null; pinch = null; });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault(); var p = rel(e);
    var dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;        // some mice report wheel in lines, not px → normalize
    else if (e.deltaMode === 2) dy *= (H || 600);
    zoomAt(p.x, p.y, Math.exp(-dy * 0.005));  // ~3.5× faster than before
  }, { passive: false });
  function vals() { var a = []; for (var k in pointers) a.push(pointers[k]); return a; }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  // ---- presets / controls ------------------------------------------------
  function solarSystem() {
    bodies = [];
    var star = 2600; addBody(0, 0, 0, 0, star, 50);
    var n = 6;
    for (var i = 0; i < n; i++) {
      var r = 70 + i * 55 + Math.random() * 20;
      var v = Math.sqrt(Math.max(0.0001, G) * star / r);
      var ang = Math.random() * 6.2832;
      addBody(Math.cos(ang) * r, Math.sin(ang) * r, -Math.sin(ang) * v, Math.cos(ang) * v, 8 + Math.random() * 40);
    }
    cam.cx = 0; cam.cy = 0; cam.scale = 1.1;
  }
  // A rotating cloud of small bodies that swirl, collide, and coalesce into an
  // accretion-disk-like structure around the mass that builds up at the centre.
  function accretionDisk() {
    bodies = [];
    var center = 1400; addBody(0, 0, 0, 0, center, 45);    // central seed the disk forms around
    var n = 110;
    for (var i = 0; i < n; i++) {
      var r = 70 + Math.random() * 380;
      var ang = Math.random() * 6.2832;
      var v = Math.sqrt(G * center / r) * (0.85 + Math.random() * 0.3);  // ~orbital + scatter → crossing orbits merge
      var m = 4 + Math.random() * 26;
      var x = Math.cos(ang) * r, y = Math.sin(ang) * r;
      addBody(x, y, -Math.sin(ang) * v + (Math.random() - 0.5) * 0.8,    // shared spin (counter-clockwise)
                    Math.cos(ang) * v + (Math.random() - 0.5) * 0.8, m);
    }
    cam.cx = 0; cam.cy = 0; cam.scale = 0.8;
  }

  if (elSpeed) elSpeed.addEventListener('input', function () { speed = +elSpeed.value; if (elSpeedV) elSpeedV.textContent = speed.toFixed(2) + '×'; });
  if (elMass) elMass.addEventListener('input', function () { spawnMass = +elMass.value; if (elMassV) elMassV.textContent = Math.round(spawnMass); });
  if (elTrails) elTrails.addEventListener('change', function () { trails = elTrails.checked; if (!trails) for (var i = 0; i < bodies.length; i++) bodies[i].trail = []; });
  if (elWells) elWells.addEventListener('change', function () { wells = elWells.checked; });
  if (btnPause) btnPause.addEventListener('click', function () { paused = !paused; btnPause.textContent = paused ? 'Play' : 'Pause'; });
  if (btnClear) btnClear.addEventListener('click', function () { bodies = []; });
  if (btnPreset) btnPreset.addEventListener('click', solarSystem);
  if (btnAccrete) btnAccrete.addEventListener('click', accretionDisk);
  if (elCollapse && elPanel) elCollapse.addEventListener('click', function () { elPanel.classList.toggle('grav-panel--collapsed'); });

  // ---- theme + resize + visibility --------------------------------------
  var rt;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { resize(); }, 150); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) { if (raf) { cancelAnimationFrame(raf); raf = null; } } else start(); });

  // ---- init --------------------------------------------------------------
  if (elSpeedV) elSpeedV.textContent = speed.toFixed(2) + '×';
  if (elMassV) elMassV.textContent = Math.round(spawnMass);
  resize();
  start();
})();
