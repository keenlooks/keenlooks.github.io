/* ==========================================================================
   Magnetic Field Visualizer — an original 2D bar-magnet sandbox.
   --------------------------------------------------------------------------
   Each magnet is modelled as two point poles (N = +q, S = −q) a short distance
   apart. The field is the sum of the poles' inverse-square monopole fields —
   which reproduces the classic bar-magnet field-line pattern — and the force /
   torque on each magnet is the sum of Coulomb-like pole–pole interactions, so
   magnets attract & align (opposite poles) or repel (like poles), and opposite
   poles that touch SNAP together into a stronger magnet. Original code; the
   physics is public-domain.

   Controls: left-click empty space to drop a magnet; drag its middle to move,
   drag an end to rotate; right-click to delete; scroll over a magnet to change
   its strength. A "field lines" slider sets how many lines each magnet shows
   (0 = off); an iron-filings toggle; and a "magnets move & rotate" toggle that
   lets you freeze the dynamics (so you can study a static field) — when off,
   magnets stay where you put them and don't attract, repel, or snap.
   Smooth rAF; theme-aware; Pointer Events + touch-action:none.
   ========================================================================== */
(function () {
  var canvas = document.getElementById('mag-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  function id(x) { return document.getElementById(x); }

  var elStrength = id('mag-strength'), elStrengthV = id('mag-strength-val');
  var elLines = id('mag-lines'), elLinesV = id('mag-lines-val');
  var elFilings = id('mag-filings'), elPhysics = id('mag-physics');
  var btnClear = id('mag-clear'), btnPreset = id('mag-preset');
  var elPanel = id('mag-panel'), elCollapse = id('mag-collapse');
  var status = id('mag-status');

  var magnets = [];               // {x,y,angle,strength,vx,vy,va}
  var compass = { x: 0, y: 0, ang: -1.5708, show: true, R: 22 };  // a draggable field probe
  var newStrength = 3, lineCount = 12, showFilings = false, dynamics = true;
  var MAX = 14, RED = '#e0564a', BLUE = '#4a7be0';
  var W = 0, H = 0, dpr = 1, raf = null;
  var pointers = {}, gesture = null;   // gesture: {mode:'move'|'rotate', idx, ox, oy}
  var filings = [];

  function effectiveTheme() {
    var f = document.documentElement.getAttribute('data-theme');
    if (f === 'light' || f === 'dark') return f;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }
  function bg() { return effectiveTheme() === 'light' ? '#f3f5f8' : '#0e1016'; }
  function lineColor(a) { return effectiveTheme() === 'light' ? 'rgba(40,50,70,' + a + ')' : 'rgba(180,200,230,' + a + ')'; }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!compass.x) { compass.x = W * 0.22; compass.y = H * 0.62; }
    compass.x = Math.min(Math.max(compass.x, compass.R), W - compass.R);
    compass.y = Math.min(Math.max(compass.y, compass.R), H - compass.R);
    seedFilings();
  }
  function halfLen(m) { return 12 + m.strength * 3.2; }
  function poles(m) {
    var c = Math.cos(m.angle), s = Math.sin(m.angle), L = halfLen(m);
    return [{ x: m.x + c * L, y: m.y + s * L, q: m.strength },     // N (+)
            { x: m.x - c * L, y: m.y - s * L, q: -m.strength }];    // S (−)
  }
  // field at a point = sum of pole monopole fields (softened)
  function field(x, y) {
    var bx = 0, by = 0;
    for (var i = 0; i < magnets.length; i++) {
      var ps = poles(magnets[i]);
      for (var k = 0; k < 2; k++) {
        var p = ps[k], dx = x - p.x, dy = y - p.y, r2 = dx * dx + dy * dy + 36, inv = 1 / Math.sqrt(r2);
        var f = p.q * inv * inv;
        bx += f * dx * inv; by += f * dy * inv;
      }
    }
    return { bx: bx, by: by };
  }

  // ---- physics: pole-pole Coulomb forces + torque, damping, snap ---------
  function physics() {
    if (!dynamics) return;          // "magnets move & rotate" unchecked → fully static (no force, torque, or snap)
    var i, j, k, l;
    for (i = 0; i < magnets.length; i++) {
      var m = magnets[i];
      if (gesture && gesture.idx === i) continue;   // the magnet you're holding is controlled
      var ps = poles(m), fxN = 0, fyN = 0, fxS = 0, fyS = 0;
      for (j = 0; j < magnets.length; j++) {
        if (j === i) continue;
        var os = poles(magnets[j]);
        for (k = 0; k < 2; k++) for (l = 0; l < 2; l++) {
          var dx = ps[k].x - os[l].x, dy = ps[k].y - os[l].y, r2 = dx * dx + dy * dy + 64, inv = 1 / Math.sqrt(r2);
          var fall = 1 / (1 + r2 * r2 / 2.0e7);              // short-range cutoff: magnets placed far apart stay put; they only pull/push when brought close
          var f = 70 * ps[k].q * os[l].q * inv * inv * inv * fall;   // repulsive for like signs
          if (k === 0) { fxN += f * dx; fyN += f * dy; } else { fxS += f * dx; fyS += f * dy; }
        }
      }
      var mass = Math.max(0.5, m.strength);
      m.vx += (fxN + fxS) / mass; m.vy += (fyN + fyS) / mass;
      // torque from the two pole forces about the centre
      var L = halfLen(m), c = Math.cos(m.angle), s = Math.sin(m.angle);
      var torque = (c * L) * fyN - (s * L) * fxN + (-c * L) * fyS - (-s * L) * fxS;
      m.va += torque / (mass * L * 8);
      m.vx *= 0.82; m.vy *= 0.82; m.va *= 0.82;
      var sp = Math.hypot(m.vx, m.vy); if (sp > 9) { m.vx *= 9 / sp; m.vy *= 9 / sp; }
      m.x += m.vx; m.y += m.vy; m.angle += m.va;
      if (m.x < 6) { m.x = 6; m.vx = 0; } if (m.x > W - 6) { m.x = W - 6; m.vx = 0; }
      if (m.y < 6) { m.y = 6; m.vy = 0; } if (m.y > H - 6) { m.y = H - 6; m.vy = 0; }
    }
    snap();
  }
  function snap() {
    for (var i = 0; i < magnets.length; i++) for (var j = i + 1; j < magnets.length; j++) {
      if (gesture && (gesture.idx === i || gesture.idx === j)) continue;
      var a = poles(magnets[i]), b = poles(magnets[j]);
      // opposite poles within snap distance -> merge into a stronger magnet
      for (var k = 0; k < 2; k++) for (var l = 0; l < 2; l++) {
        if (a[k].q * b[l].q < 0 && Math.hypot(a[k].x - b[l].x, a[k].y - b[l].y) < 16) {
          var A = magnets[i], B = magnets[j], sA = A.strength, sB = B.strength, st = sA + sB;
          A.x = (A.x * sA + B.x * sB) / st; A.y = (A.y * sA + B.y * sB) / st;
          A.angle = Math.atan2(Math.sin(A.angle) * sA + Math.sin(B.angle) * sB, Math.cos(A.angle) * sA + Math.cos(B.angle) * sB);
          A.strength = Math.min(9, st); A.vx = A.vy = A.va = 0;
          magnets.splice(j, 1); return;
        }
      }
    }
  }

  // ---- field lines + filings --------------------------------------------
  function traceLine(x, y, dir) {
    var pts = [[x, y]];
    for (var i = 0; i < 150; i++) {
      var b = field(x, y), mag = Math.hypot(b.bx, b.by);
      if (mag < 1e-7) break;
      x += dir * b.bx / mag * 5; y += dir * b.by / mag * 5;
      pts.push([x, y]);
      if (x < -60 || x > W + 60 || y < -60 || y > H + 60) break;
      // stop near an S pole (field sink)
      var stop = false;
      for (var m = 0; m < magnets.length; m++) { var s = poles(magnets[m])[1]; if (Math.hypot(x - s.x, y - s.y) < 7) { stop = true; break; } }
      if (stop) break;
    }
    return pts;
  }
  function drawLines() {
    ctx.strokeStyle = lineColor(0.5); ctx.lineWidth = 1;
    for (var i = 0; i < magnets.length; i++) {
      var m = magnets[i], N = poles(m)[0], nL = lineCount;
      for (var k = 0; k < nL; k++) {
        var ang = (k / nL) * 6.2832, sx = N.x + Math.cos(ang) * 7, sy = N.y + Math.sin(ang) * 7;
        var pts = traceLine(sx, sy, 1);
        ctx.beginPath();
        for (var p = 0; p < pts.length; p++) { if (p === 0) ctx.moveTo(pts[p][0], pts[p][1]); else ctx.lineTo(pts[p][0], pts[p][1]); }
        ctx.stroke();
      }
    }
  }
  function seedFilings() { filings = []; for (var i = 0; i < 260; i++) filings.push({ x: Math.random() * W, y: Math.random() * H, life: Math.random() * 60 }); }
  function drawFilings() {
    ctx.strokeStyle = lineColor(0.55); ctx.lineWidth = 1.4;
    for (var i = 0; i < filings.length; i++) {
      var f = filings[i], b = field(f.x, f.y), mag = Math.hypot(b.bx, b.by);
      if (mag < 1e-5 || f.life <= 0 || f.x < 0 || f.x > W || f.y < 0 || f.y > H) { f.x = Math.random() * W; f.y = Math.random() * H; f.life = 40 + Math.random() * 50; continue; }
      var ux = b.bx / mag, uy = b.by / mag;
      ctx.beginPath(); ctx.moveTo(f.x - ux * 4, f.y - uy * 4); ctx.lineTo(f.x + ux * 4, f.y + uy * 4); ctx.stroke();
      f.x += ux * 1.6; f.y += uy * 1.6; f.life -= 1;
    }
  }

  function drawMagnet(m) {
    var L = halfLen(m), w = Math.max(7, L * 0.5);
    ctx.save(); ctx.translate(m.x, m.y); ctx.rotate(m.angle);
    ctx.fillStyle = BLUE; roundRect(-L, -w / 2, L, w, 4); ctx.fill();   // S half (−x)
    ctx.fillStyle = RED; roundRect(0, -w / 2, L, w, 4); ctx.fill();     // N half (+x)
    ctx.fillStyle = '#fff'; ctx.font = '700 ' + Math.round(w * 0.7) + 'px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', L * 0.5, 0); ctx.fillText('S', -L * 0.5, 0);
    ctx.restore();
  }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  // A compass needle settles along the local field direction (its red end is a
  // tiny north pole, so it points the way B points — into nearby south poles).
  function updateCompass() {
    if (!compass.show) return;
    var b = field(compass.x, compass.y), mag = Math.hypot(b.bx, b.by);
    compass.mag = mag;
    if (mag < 1e-7) return;                       // no field → keep the last heading
    var target = Math.atan2(b.by, b.bx);
    var d = (target - compass.ang + Math.PI * 3) % (Math.PI * 2) - Math.PI;
    compass.ang += d * 0.22;                      // ease toward the field (needle inertia)
  }
  function drawCompass() {
    var R = compass.R, light = effectiveTheme() === 'light';
    ctx.save(); ctx.translate(compass.x, compass.y);
    ctx.beginPath(); ctx.arc(0, 0, R, 0, 6.2832);
    ctx.fillStyle = light ? 'rgba(255,255,255,0.78)' : 'rgba(20,24,34,0.78)';
    ctx.fill();
    ctx.strokeStyle = lineColor(0.8); ctx.lineWidth = 1.5; ctx.stroke();
    ctx.strokeStyle = lineColor(0.45); ctx.lineWidth = 1;
    for (var k = 0; k < 4; k++) {                 // cardinal ticks
      var a = k * Math.PI / 2;
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * (R - 4), Math.sin(a) * (R - 4));
      ctx.lineTo(Math.cos(a) * (R - 1), Math.sin(a) * (R - 1)); ctx.stroke();
    }
    ctx.rotate(compass.ang);
    ctx.globalAlpha = (compass.mag > 1e-7) ? 1 : 0.45;  // dim when there's nothing to read
    ctx.fillStyle = RED;                          // north end → along the field
    ctx.beginPath(); ctx.moveTo(R - 6, 0); ctx.lineTo(-3, 4.5); ctx.lineTo(-3, -4.5); ctx.closePath(); ctx.fill();
    ctx.fillStyle = lineColor(0.75);              // tail
    ctx.beginPath(); ctx.moveTo(-(R - 6), 0); ctx.lineTo(3, 3.5); ctx.lineTo(3, -3.5); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(0, 0, 2.2, 0, 6.2832); ctx.fillStyle = lineColor(0.9); ctx.fill();
    ctx.restore();
  }

  function draw() {
    if (!W || !H) resize(); if (!W || !H) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = bg(); ctx.fillRect(0, 0, W, H);
    if (lineCount > 0) drawLines();
    if (showFilings) drawFilings();
    for (var i = 0; i < magnets.length; i++) drawMagnet(magnets[i]);
    if (compass.show) drawCompass();
    if (status) status.textContent = magnets.length + (magnets.length === 1 ? ' magnet' : ' magnets');
  }
  function loop() { raf = requestAnimationFrame(loop); physics(); updateCompass(); draw(); }
  function start() { if (!raf) raf = requestAnimationFrame(loop); }

  // ---- interaction -------------------------------------------------------
  function rel(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function magnetAt(x, y) {
    for (var i = magnets.length - 1; i >= 0; i--) { var m = magnets[i]; if (Math.hypot(x - m.x, y - m.y) <= halfLen(m) + 8) return i; }
    return -1;
  }
  canvas.addEventListener('pointerdown', function (e) {
    var p = rel(e); pointers[e.pointerId] = p;
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    // the compass is on top: grab it before anything else (left button only)
    if (compass.show && e.button !== 2 && Math.hypot(p.x - compass.x, p.y - compass.y) <= compass.R + 6) {
      gesture = { mode: 'compass', ox: p.x - compass.x, oy: p.y - compass.y };
      e.preventDefault(); return;
    }
    var i = magnetAt(p.x, p.y);
    if (e.button === 2) { if (i >= 0) magnets.splice(i, 1); e.preventDefault(); return; }
    if (i >= 0) {
      var m = magnets[i], d = Math.hypot(p.x - m.x, p.y - m.y);
      if (d < halfLen(m) * 0.55) gesture = { mode: 'move', idx: i, ox: p.x - m.x, oy: p.y - m.y };
      else gesture = { mode: 'rotate', idx: i };
      m.vx = m.vy = m.va = 0;
    } else if (magnets.length < MAX) {
      magnets.push({ x: p.x, y: p.y, angle: 0, strength: newStrength, vx: 0, vy: 0, va: 0 });
      gesture = { mode: 'move', idx: magnets.length - 1, ox: 0, oy: 0 };
    }
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!gesture) return;
    var p = rel(e);
    if (gesture.mode === 'compass') {
      compass.x = Math.min(Math.max(p.x - gesture.ox, compass.R), W - compass.R);
      compass.y = Math.min(Math.max(p.y - gesture.oy, compass.R), H - compass.R);
      return;
    }
    var m = magnets[gesture.idx]; if (!m) { gesture = null; return; }
    if (gesture.mode === 'move') { m.x = p.x - gesture.ox; m.y = p.y - gesture.oy; }
    else { m.angle = Math.atan2(p.y - m.y, p.x - m.x); }
    m.vx = m.vy = m.va = 0;
  });
  function endP(e) { delete pointers[e.pointerId]; gesture = null; }
  canvas.addEventListener('pointerup', endP);
  canvas.addEventListener('pointercancel', endP);
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  canvas.addEventListener('wheel', function (e) {
    var p = rel(e), i = magnetAt(p.x, p.y);
    if (i >= 0) { e.preventDefault(); magnets[i].strength = Math.max(1, Math.min(9, magnets[i].strength - Math.sign(e.deltaY) * 0.5)); }
  }, { passive: false });

  // ---- controls ----------------------------------------------------------
  if (elStrength) elStrength.addEventListener('input', function () { newStrength = +elStrength.value; if (elStrengthV) elStrengthV.textContent = newStrength.toFixed(1); });
  if (elLines) elLines.addEventListener('input', function () { lineCount = Math.round(+elLines.value); if (elLinesV) elLinesV.textContent = lineCount; });
  if (elFilings) elFilings.addEventListener('change', function () { showFilings = elFilings.checked; });
  if (elPhysics) elPhysics.addEventListener('change', function () { dynamics = elPhysics.checked; if (!dynamics) for (var i = 0; i < magnets.length; i++) { magnets[i].vx = magnets[i].vy = magnets[i].va = 0; } });
  var elCompass = id('mag-compass');
  if (elCompass) elCompass.addEventListener('change', function () { compass.show = elCompass.checked; });
  if (elCollapse && elPanel) elCollapse.addEventListener('click', function () { elPanel.classList.toggle('mag-panel--collapsed'); });
  if (btnClear) btnClear.addEventListener('click', function () { magnets = []; });
  if (btnPreset) btnPreset.addEventListener('click', function () {
    magnets = [];
    magnets.push({ x: W * 0.4, y: H * 0.5, angle: 0, strength: 4, vx: 0, vy: 0, va: 0 });
    magnets.push({ x: W * 0.6, y: H * 0.5, angle: Math.PI, strength: 4, vx: 0, vy: 0, va: 0 });
  });

  var rt;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(resize, 150); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) { if (raf) { cancelAnimationFrame(raf); raf = null; } } else start(); });

  if (elStrengthV) elStrengthV.textContent = newStrength.toFixed(1);
  if (elLinesV) elLinesV.textContent = lineCount;
  resize();
  start();
})();
