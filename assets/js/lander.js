/* ==========================================================================
   Rocket Lander — a trained RL policy you can throw curveballs at.
   --------------------------------------------------------------------------
   A small policy network (6→16→4 tanh MLP, trained with a vectorized
   Cross-Entropy Method under domain randomization by make_lander_model.py,
   shipped int8-quantized in
   lander-model.js) flies a rocket down to a pad. You change the world — gravity,
   wind, where the pad is, or grab the rocket and fling it — and watch the agent
   cope (or fail, when you push past what it ever trained on). A live "brain"
   panel shows the network deciding each instant.

   The environment is ORIGINAL code (own simple physics, not Box2D). The task,
   four-action layout, and reward shaping are inspired by the classic LunarLander
   environment from OpenAI Gym, now maintained by the Farama Foundation as
   Gymnasium — credited on the page. The physics + observation scaling here MUST
   match make_lander_model.py exactly.

   Theme-aware; Pointer Events + touch-action:none; pauses on hidden tabs.
   ========================================================================== */
(function () {
  var canvas = document.getElementById('land-canvas');
  if (!canvas || !window.LANDER_MODEL) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  function id(x) { return document.getElementById(x); }

  /* ---- physics constants (MUST match make_lander_model.py) ---- */
  var DT = 0.02, TM = 0.95, TT = 4.5, GROUND_Y = 0.05, PAD_HALF = 0.03;

  /* ---- decode the policy ---- */
  var M = window.LANDER_MODEL, HID = M.hidden;
  function b64(s) { var bin = atob(s), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
  function deq(s, sc) { var q = new Int8Array(b64(s).buffer), f = new Float32Array(q.length); for (var i = 0; i < q.length; i++) f[i] = q[i] * sc; return f; }
  var W1 = deq(M.w1, M.s1), W2 = deq(M.w2, M.s2), B1 = new Float32Array(M.b1), B2 = new Float32Array(M.b2);

  function obs(s, padX) {
    return [(s.x - padX) * 1.6, (s.y - GROUND_Y) * 2.0, s.vx * 2.5, s.vy * 2.5, s.th * 1.2, s.w * 0.5];
  }
  var lastH = new Float32Array(HID), lastP = new Float32Array(4), lastO = [0,0,0,0,0,0];
  function policy(o) {
    var h = lastH, p = lastP, i, j, sm;
    for (j = 0; j < HID; j++) { sm = B1[j]; for (i = 0; i < 6; i++) sm += o[i] * W1[i * HID + j]; h[j] = Math.tanh(sm); }
    var mx = -1e9;
    for (j = 0; j < 4; j++) { sm = B2[j]; for (i = 0; i < HID; i++) sm += h[i] * W2[i * 4 + j]; p[j] = sm; if (sm > mx) mx = sm; }
    var tot = 0; for (j = 0; j < 4; j++) { p[j] = Math.exp(p[j] - mx); tot += p[j]; }
    for (j = 0; j < 4; j++) p[j] /= tot;
    var b = 0; for (j = 1; j < 4; j++) if (p[j] > p[b]) b = j;
    return b;
  }

  /* ---- state ---- */
  var g = 0.22, wind = 0, padX = 0.5, autopilot = true, showBrain = true;
  var s, action = 0, status = 'fly', statusT = 0, fuel = 0;
  var W = 0, H = 0, dpr = 1, raf = null, acc = 0, lastT = 0;
  var drag = null, padDrag = false;

  function reset() {
    s = { x: 0.5 + (Math.random() - 0.5) * 0.4, y: 0.92, vx: (Math.random() - 0.5) * 0.2, vy: -0.05, th: (Math.random() - 0.5) * 0.3, w: 0 };
    status = 'fly'; statusT = 0; fuel = 0; action = 0;
  }
  function step() {
    if (status !== 'fly') return;
    var o = obs(s, padX); lastO = o;
    var a = policy(o);              /* always run the net so the brain panel reflects the current input */
    if (autopilot) action = a;      /* manual mode keeps `action` from the arrow keys */
    var ax = wind, ay = -g;
    if (action === 2) { ax += TM * Math.sin(s.th); ay += TM * Math.cos(s.th); fuel += DT; }
    else if (action === 1) { s.w += TT * DT; }
    else if (action === 3) { s.w -= TT * DT; }
    s.vx += ax * DT; s.vy += ay * DT; s.x += s.vx * DT; s.y += s.vy * DT; s.th += s.w * DT;
    if (s.x < 0 || s.x > 1 || s.y > 1.12) { status = 'lost'; statusT = performance.now(); return; }
    if (s.y <= GROUND_Y) {
      s.y = GROUND_Y;
      var ok = Math.abs(s.x - padX) < 0.03 && Math.abs(s.vx) < 0.17 && Math.abs(s.vy) < 0.20 && Math.abs(s.th) < 0.28 && Math.abs(s.w) < 0.85;
      status = ok ? 'landed' : 'crashed'; statusT = performance.now();
    }
  }

  /* ---- theme / scene helpers ---- */
  function effTheme() { var f = document.documentElement.getAttribute('data-theme'); if (f === 'light' || f === 'dark') return f; return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark'; }
  function light() { return effTheme() === 'light'; }
  function accent() { return light() ? '#34568a' : '#82a6cc'; }
  function gold() { return light() ? '#c0892e' : '#e0b24a'; }
  function bad() { return '#c4574a'; }
  function good() { return light() ? '#3f7d57' : '#6fce97'; }
  function txt(a) { return light() ? 'rgba(38,38,38,' + a + ')' : 'rgba(214,214,214,' + a + ')'; }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  /* world→screen: the rocket's FEET sit at the ground line when s.y == GROUND_Y,
     so a touchdown happens exactly where the ground is drawn (not floating above). */
  function groundPix() { return H * 0.84; }
  function topPix() { return H * 0.10; }
  function sx(x) { return x * W; }
  function sy(y) { return groundPix() - (y - GROUND_Y) / (1 - GROUND_Y) * (groundPix() - topPix()); }
  function rocketScale() { return Math.max(12, Math.min(22, Math.min(W, H) * 0.025)); }  /* ~60% of the previous size */

  /* ---- exhaust particles (screen space) ---- */
  var particles = [];
  var hills = null, starSeed = null;
  function emitExhaust(nx, ny, th, strong) {
    var ux = -Math.sin(th), uy = Math.cos(th);        // exhaust shoots opposite the thrust (down the nozzle)
    var n = strong ? 4 : 1;
    for (var i = 0; i < n; i++) {
      var sp = (strong ? 3.0 : 1.4) + Math.random() * 2.0;
      var spread = (Math.random() - 0.5) * 0.8;
      var vx = ux * sp + uy * spread, vy = uy * sp - ux * spread;
      particles.push({ x: nx, y: ny, vx: vx, vy: vy, life: 1, r: 2.5 + Math.random() * 2.5 });
    }
    if (particles.length > 180) particles.splice(0, particles.length - 180);
  }
  function drawParticles() {
    var gp = groundPix();
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.x += p.vx; p.y += p.vy; p.vy += 0.05; p.life -= 0.04;
      if (p.life <= 0 || p.y > gp) { particles.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, p.life) * 0.7;
      ctx.fillStyle = p.life > 0.55 ? gold() : (light() ? 'rgba(150,150,150,1)' : 'rgba(120,120,120,1)');
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.5 + p.life), 0, 6.2832); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* ---- the rocket — bigger & detailed, pivoting about its feet (origin at the
     contact point, body extending UP in -y). ---- */
  function drawRocket(x, y, th, firingMain, firingL, firingR, crashed) {
    var S = rocketScale(), t = performance.now();
    ctx.save(); ctx.translate(x, y); ctx.rotate(th);
    var bw = S * 0.6, legH = S * 0.36, bh = S * 1.5, noseH = S * 0.66;
    var baseY = -legH, topY = baseY - bh, noseTip = topY - noseH;

    /* main flame (teardrop out the nozzle at baseY) */
    if (firingMain && !crashed) {
      var fl = S * 1.0 + (Math.sin(t / 32) + 1) * S * 0.3 + Math.random() * S * 0.25;
      var fg = ctx.createLinearGradient(0, baseY, 0, baseY + fl);
      fg.addColorStop(0, 'rgba(255,240,190,0.98)');
      fg.addColorStop(0.45, light() ? 'rgba(224,178,74,0.95)' : 'rgba(255,196,90,0.95)');
      fg.addColorStop(1, 'rgba(196,87,74,0)');
      ctx.fillStyle = fg;
      ctx.beginPath(); ctx.moveTo(-bw * 0.5, baseY); ctx.quadraticCurveTo(-bw * 0.2, baseY + fl * 0.5, 0, baseY + fl); ctx.quadraticCurveTo(bw * 0.2, baseY + fl * 0.5, bw * 0.5, baseY); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath(); ctx.moveTo(-bw * 0.2, baseY); ctx.lineTo(0, baseY + fl * 0.55); ctx.lineTo(bw * 0.2, baseY); ctx.closePath(); ctx.fill();
    }
    /* side RCS jets near the top */
    if (firingL && !crashed) { ctx.fillStyle = gold(); ctx.globalAlpha = 0.9; ctx.beginPath(); ctx.moveTo(bw, topY + bh * 0.22); ctx.lineTo(bw + S * 0.55 + Math.random() * S * 0.2, topY + bh * 0.3); ctx.lineTo(bw, topY + bh * 0.38); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1; }
    if (firingR && !crashed) { ctx.fillStyle = gold(); ctx.globalAlpha = 0.9; ctx.beginPath(); ctx.moveTo(-bw, topY + bh * 0.22); ctx.lineTo(-bw - S * 0.55 - Math.random() * S * 0.2, topY + bh * 0.3); ctx.lineTo(-bw, topY + bh * 0.38); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1; }

    /* fins (behind body) */
    ctx.fillStyle = crashed ? '#a8443a' : (light() ? '#7f8aa3' : '#65718a');
    ctx.beginPath(); ctx.moveTo(-bw, baseY - bh * 0.02); ctx.lineTo(-bw - S * 0.5, baseY + S * 0.16); ctx.lineTo(-bw, baseY - bh * 0.42); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(bw, baseY - bh * 0.02); ctx.lineTo(bw + S * 0.5, baseY + S * 0.16); ctx.lineTo(bw, baseY - bh * 0.42); ctx.closePath(); ctx.fill();

    /* legs splaying from the body base to the feet at y=0 */
    ctx.strokeStyle = light() ? '#8a93a6' : '#9aa6bd'; ctx.lineWidth = Math.max(2, S * 0.1); ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-bw * 0.7, baseY); ctx.lineTo(-bw * 1.2, 0);
    ctx.moveTo(bw * 0.7, baseY); ctx.lineTo(bw * 1.2, 0);
    ctx.stroke();

    /* body */
    var bgrad = ctx.createLinearGradient(-bw, 0, bw, 0);
    if (crashed) { bgrad.addColorStop(0, '#b04a3f'); bgrad.addColorStop(1, bad()); }
    else { bgrad.addColorStop(0, light() ? '#ffffff' : '#eef2f8'); bgrad.addColorStop(0.5, light() ? '#d7deea' : '#c7d2e4'); bgrad.addColorStop(1, light() ? '#9aa6bd' : '#7f8ca6'); }
    ctx.fillStyle = bgrad;
    ctx.beginPath();
    ctx.moveTo(-bw, baseY);
    ctx.lineTo(-bw, topY);
    ctx.quadraticCurveTo(-bw, noseTip + noseH * 0.35, 0, noseTip);
    ctx.quadraticCurveTo(bw, noseTip + noseH * 0.35, bw, topY);
    ctx.lineTo(bw, baseY);
    ctx.closePath(); ctx.fill();

    /* nose cone accent + window + band */
    ctx.fillStyle = crashed ? bad() : accent(); ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.moveTo(0, noseTip); ctx.quadraticCurveTo(bw, noseTip + noseH * 0.35, bw, topY); ctx.lineTo(-bw, topY); ctx.quadraticCurveTo(-bw, noseTip + noseH * 0.35, 0, noseTip); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
    ctx.fillStyle = light() ? '#243349' : '#16202e'; ctx.beginPath(); ctx.arc(0, topY + bh * 0.3, bw * 0.34, 0, 6.2832); ctx.fill();
    ctx.fillStyle = accent(); ctx.beginPath(); ctx.arc(-bw * 0.1, topY + bh * 0.26, bw * 0.15, 0, 6.2832); ctx.fill();
    ctx.fillStyle = 'rgba(127,127,127,0.30)'; ctx.fillRect(-bw, baseY - bh * 0.2, bw * 2, Math.max(2, S * 0.07));
    ctx.restore();
  }

  function buildBackdrop() {
    /* deterministic hills + stars so they don't jitter each frame */
    hills = []; var hx = 0;
    while (hx < W + 60) { hills.push({ x: hx, r: 30 + (Math.sin(hx * 0.7) + 1) * 40 }); hx += 70 + (hx * 13 % 40); }
    starSeed = [];
    for (var i = 0; i < 70; i++) starSeed.push({ x: (i * 137.5) % W, y: ((i * 311) % Math.max(40, Math.round(H * 0.7))), a: 0.15 + ((i * 37) % 10) / 12, ph: i });
  }

  function drawScene(now) {
    if (!hills) buildBackdrop();
    var gp = groundPix();
    /* sky */
    var grad = ctx.createLinearGradient(0, 0, 0, gp);
    if (light()) { grad.addColorStop(0, '#cfe0f3'); grad.addColorStop(0.7, '#e7eef7'); grad.addColorStop(1, '#eef2f7'); }
    else { grad.addColorStop(0, '#070b16'); grad.addColorStop(0.7, '#0c1120'); grad.addColorStop(1, '#121a2b'); }
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, gp);
    /* stars (dark) with a slow twinkle */
    if (!light()) {
      for (var i = 0; i < starSeed.length; i++) { var st = starSeed[i]; ctx.globalAlpha = st.a * (0.6 + 0.4 * Math.sin(now / 900 + st.ph)); ctx.fillStyle = '#fff'; ctx.fillRect(st.x, st.y, 1.6, 1.6); }
      ctx.globalAlpha = 1;
    }
    /* distant hills */
    ctx.fillStyle = light() ? 'rgba(150,165,150,0.45)' : 'rgba(40,52,72,0.7)';
    ctx.beginPath(); ctx.moveTo(0, gp);
    for (var k = 0; k < hills.length; k++) { var hsx = hills[k].x; ctx.lineTo(hsx, gp - hills[k].r * 0.5); ctx.lineTo(hsx + 35, gp); }
    ctx.lineTo(W, gp); ctx.closePath(); ctx.fill();
    /* ground */
    var ggrad = ctx.createLinearGradient(0, gp, 0, H);
    if (light()) { ggrad.addColorStop(0, '#cfd6c2'); ggrad.addColorStop(1, '#c2c9b3'); }
    else { ggrad.addColorStop(0, '#1d2533'); ggrad.addColorStop(1, '#161d28'); }
    ctx.fillStyle = ggrad; ctx.fillRect(0, gp, W, H - gp);
    ctx.strokeStyle = txt(0.25); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, gp); ctx.lineTo(W, gp); ctx.stroke();

    /* landing pad: glowing target with a soft beam + chevrons */
    var pL = sx(padX - PAD_HALF), pR = sx(padX + PAD_HALF), pc = sx(padX);
    var beam = ctx.createLinearGradient(0, gp - H * 0.5, 0, gp);
    beam.addColorStop(0, 'rgba(111,206,151,0)'); beam.addColorStop(1, light() ? 'rgba(63,125,87,0.10)' : 'rgba(111,206,151,0.12)');
    ctx.fillStyle = beam; ctx.fillRect(pL, gp - H * 0.5, pR - pL, H * 0.5);
    ctx.strokeStyle = good(); ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(pL, gp); ctx.lineTo(pR, gp); ctx.stroke();
    ctx.fillStyle = good();
    ctx.beginPath(); ctx.moveTo(pL, gp); ctx.lineTo(pL, gp - 11); ctx.lineTo(pL + 5, gp - 11); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(pR, gp); ctx.lineTo(pR, gp - 11); ctx.lineTo(pR - 5, gp - 11); ctx.closePath(); ctx.fill();
    var ch = (now / 600) % 1;                          /* animated descent chevrons */
    ctx.strokeStyle = good(); ctx.lineWidth = 2; ctx.globalAlpha = 0.5;
    for (var c = 0; c < 2; c++) { var cy = gp - 22 - ((ch + c * 0.5) % 1) * 26; ctx.beginPath(); ctx.moveTo(pc - 6, cy); ctx.lineTo(pc, cy + 5); ctx.lineTo(pc + 6, cy); ctx.stroke(); }
    ctx.globalAlpha = 1;

    /* rocket shadow on the ground (tighter as it nears) */
    var rx = sx(s.x), ry = sy(s.y), S = rocketScale();
    var hgt = Math.max(0, (s.y - GROUND_Y));
    ctx.fillStyle = light() ? 'rgba(0,0,0,0.10)' : 'rgba(0,0,0,0.28)';
    ctx.globalAlpha = Math.max(0.1, 1 - hgt); ctx.beginPath();
    ctx.ellipse(rx, gp + 2, S * 0.7 * (1 - hgt * 0.4), 2.6, 0, 0, 6.2832); ctx.fill(); ctx.globalAlpha = 1;

    /* exhaust: emit at the nozzle (body base), then update + draw behind the rocket */
    if (status === 'fly' && action === 2) {
      var legH = S * 0.36;
      var nx = rx + legH * Math.sin(s.th), ny = ry - legH * Math.cos(s.th);
      emitExhaust(nx, ny, s.th, true);
    }
    drawParticles();

    drawRocket(rx, ry, s.th, status === 'fly' && action === 2, status === 'fly' && action === 1, status === 'fly' && action === 3, status === 'crashed');

    /* status banner — kept clear of the top nav / vignette */
    if (status !== 'fly') {
      ctx.font = '700 ' + Math.max(22, W / 32) + 'px "Source Sans 3", system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = status === 'landed' ? good() : bad();
      var msg = status === 'landed' ? 'Landed' : (status === 'lost' ? 'Flew off' : 'Crashed');
      ctx.fillText(msg, W / 2, H * 0.17);
    }
  }

  /* ---- the "brain": live node-link of the policy ---- */
  var IN_LABELS = ['Δx to pad', 'height', 'side speed', 'fall speed', 'tilt', 'spin'];
  /* action 1 increases the angle (nose tips right); action 3 decreases it (nose left) */
  var ACT_LABELS = ['idle', 'spin ▶', 'thrust ▲', 'spin ◀'];
  function drawBrain() {
    var bw = Math.min(320, W < 600 ? W * 0.74 : W * 0.33), bh = Math.min(220, H * 0.36);
    /* sit the brain so its BOTTOM is just above the ground line — keeps the pad/landing
       visible (and clear of the bottom-left back/theme buttons) even for a far-left pad */
    var bx = 14, by = Math.max(92, groundPix() - bh - 78);
    /* backing */
    ctx.fillStyle = light() ? 'rgba(255,255,255,0.82)' : 'rgba(16,20,28,0.78)';
    ctx.strokeStyle = txt(0.18); ctx.lineWidth = 1;
    roundRect(bx, by, bw, bh, 10); ctx.fill(); ctx.stroke();
    var padT = 26, padB = 22, padL = 78, padR = 64;
    var xIn = bx + padL, xHid = bx + bw * 0.52, xOut = bx + bw - padR;
    var top = by + padT, bot = by + bh - padB;
    var ac = accent(), nc = gold(), o = lastO, h = lastH, p = lastP;
    function iy(i) { return top + (i + 0.5) / 6 * (bot - top); }
    function hyf(i) { return top + (i + 0.5) / HID * (bot - top); }
    function oyf(i) { return top + (i + 0.5) / 4 * (bot - top); }
    var maxH = 1e-6, i, j; for (i = 0; i < HID; i++) if (Math.abs(h[i]) > maxH) maxH = Math.abs(h[i]);
    var maxIn = 1e-6; for (i = 0; i < 6; i++) if (Math.abs(o[i]) > maxIn) maxIn = Math.abs(o[i]);
    var maxW1 = 1e-6; for (i = 0; i < W1.length; i++) if (Math.abs(W1[i]) > maxW1) maxW1 = Math.abs(W1[i]);
    var maxW2 = 1e-6; for (i = 0; i < W2.length; i++) if (Math.abs(W2[i]) > maxW2) maxW2 = Math.abs(W2[i]);

    /* input → hidden */
    for (i = 0; i < 6; i++) {
      var ina = Math.min(1, Math.abs(o[i]) / maxIn);
      if (ina < 0.04) continue;
      for (j = 0; j < HID; j++) {
        var w1 = W1[i * HID + j];
        ctx.strokeStyle = ac; ctx.globalAlpha = (0.015 + 0.25 * ina) * Math.min(1, Math.abs(w1) / maxW1 + 0.1);
        ctx.lineWidth = 0.2 + 1.3 * Math.abs(w1) / maxW1;
        ctx.beginPath(); ctx.moveTo(xIn, iy(i)); ctx.lineTo(xHid, hyf(j)); ctx.stroke();
      }
    }
    /* hidden → output */
    for (i = 0; i < HID; i++) {
      var ha = Math.abs(h[i]) / maxH;
      if (ha < 0.05) continue;
      for (j = 0; j < 4; j++) {
        var w2 = W2[i * 4 + j];
        ctx.strokeStyle = ac; ctx.globalAlpha = (0.02 + 0.5 * ha) * Math.min(1, Math.abs(w2) / maxW2 + 0.12);
        ctx.lineWidth = 0.2 + 1.8 * Math.abs(w2) / maxW2;
        ctx.beginPath(); ctx.moveTo(xHid, hyf(i)); ctx.lineTo(xOut, oyf(j)); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    /* input nodes + labels */
    ctx.font = '10px "Source Sans 3", system-ui, sans-serif'; ctx.textBaseline = 'middle';
    for (i = 0; i < 6; i++) {
      ctx.beginPath(); ctx.arc(xIn, iy(i), 3, 0, 6.2832); ctx.fillStyle = nc; ctx.globalAlpha = 0.25 + 0.75 * Math.min(1, Math.abs(o[i]) / maxIn); ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillStyle = txt(0.55); ctx.textAlign = 'right'; ctx.fillText(IN_LABELS[i], xIn - 7, iy(i));
    }
    /* hidden nodes */
    for (i = 0; i < HID; i++) { ctx.beginPath(); ctx.arc(xHid, hyf(i), 2, 0, 6.2832); ctx.fillStyle = nc; ctx.globalAlpha = 0.2 + 0.8 * Math.abs(h[i]) / maxH; ctx.fill(); }
    ctx.globalAlpha = 1;
    /* output nodes + labels (highlight chosen action) */
    ctx.font = '11px "Source Sans 3", system-ui, sans-serif';
    for (j = 0; j < 4; j++) {
      var chosen = (j === action && status === 'fly');
      ctx.beginPath(); ctx.arc(xOut, oyf(j), 5.5, 0, 6.2832);
      ctx.fillStyle = chosen ? good() : nc; ctx.globalAlpha = 0.2 + 0.8 * p[j]; ctx.fill(); ctx.globalAlpha = 1;
      if (chosen) { ctx.strokeStyle = good(); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(xOut, oyf(j), 8, 0, 6.2832); ctx.stroke(); }
      ctx.fillStyle = chosen ? good() : txt(0.55); ctx.textAlign = 'left'; ctx.fillText(ACT_LABELS[j], xOut + 11, oyf(j));
    }
    /* title */
    ctx.font = '600 11px "Source Sans 3", system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = txt(0.7); ctx.fillText("the agent's brain (live)", bx + 12, by + 8);
  }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  /* ---- loop ---- */
  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (!W || !H) { resize(); if (!W || !H) return; }
    var dtR = Math.min(0.05, (t - lastT) / 1000 || 0); lastT = t;
    if (!drag) { acc += dtR; var guard = 0; while (acc >= DT && guard < 4) { step(); acc -= DT; guard++; } }
    else { policy(obs(s, padX)); }   /* keep the brain live while dragging */
    /* auto-respawn a moment after the episode ends */
    if (status !== 'fly' && performance.now() - statusT > 1600 && !drag) reset();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawScene(t);
    if (showBrain) drawBrain();
  }
  function start() { if (!raf) { lastT = 0; raf = requestAnimationFrame(frame); } }

  /* ---- interaction: drag the rocket (fling) or the pad ---- */
  function rel(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function wyFromScreen(py) { return GROUND_Y + (groundPix() - py) / (groundPix() - topPix()) * (1 - GROUND_Y); }
  function rocketHit(px, py) {
    var S = rocketScale(), cx = sx(s.x), cy = sy(s.y) - S * 1.1;   // rough body centre
    return Math.abs(px - cx) < S * 1.4 && Math.abs(py - cy) < S * 1.7;  // generous grab box covering the whole rocket
  }
  canvas.addEventListener('pointerdown', function (e) {
    var p = rel(e);
    if (rocketHit(p.x, p.y)) {
      drag = { kind: 'rocket', lx: p.x, ly: p.y, vx: 0, vy: 0 };
      status = 'fly'; statusT = 0; s.vx = 0; s.vy = 0; s.w = 0;
    } else if (p.y > groundPix() - 30) {                  // anywhere near/below the ground line moves the pad
      padDrag = true; padX = Math.min(0.80, Math.max(0.20, p.x / W)); var pe = id('land-pad'); if (pe) pe.value = Math.round(padX * 100);
    } else return;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', function (e) {
    var p = rel(e);
    if (drag && drag.kind === 'rocket') {
      drag.vx = (p.x - drag.lx); drag.vy = (p.y - drag.ly); drag.lx = p.x; drag.ly = p.y;
      s.x = Math.min(1, Math.max(0, p.x / W));
      s.y = Math.min(1.15, Math.max(GROUND_Y, wyFromScreen(p.y)));
      s.th = 0; s.w = 0;
    } else if (padDrag) { padX = Math.min(0.80, Math.max(0.20, p.x / W)); var pe2 = id('land-pad'); if (pe2) pe2.value = Math.round(padX * 100); }
  });
  function endDrag() {
    if (drag && drag.kind === 'rocket') {
      s.vx = drag.vx / W * 1.2;                                  /* screen px/move → world vel */
      s.vy = -drag.vy / (groundPix() - topPix()) * 1.2;          /* screen-down is world-down (−y) */
      status = 'fly'; statusT = 0;
    }
    drag = null; padDrag = false;
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  /* ---- controls ---- */
  var elG = id('land-grav'), elGV = id('land-grav-val'), elWind = id('land-wind'), elWindV = id('land-wind-val');
  var elPad = id('land-pad'), elPadV = id('land-pad-val');
  var btnReset = id('land-reset'), elAuto = id('land-auto'), elBrain = id('land-brain');
  var elPanel = id('land-panel'), elCollapse = id('land-collapse');
  function fmtWind(v) { return (v > 0 ? '→ ' : v < 0 ? '← ' : '') + Math.abs(v).toFixed(2); }
  if (elG) elG.addEventListener('input', function () { g = +elG.value; if (elGV) elGV.textContent = g.toFixed(2); });
  if (elWind) elWind.addEventListener('input', function () { wind = +elWind.value; if (elWindV) elWindV.textContent = fmtWind(wind); });
  if (elPad) elPad.addEventListener('input', function () { padX = +elPad.value / 100; if (elPadV) elPadV.textContent = (padX).toFixed(2); });
  if (btnReset) btnReset.addEventListener('click', reset);
  if (elAuto) elAuto.addEventListener('change', function () { autopilot = elAuto.checked; updateTouchControls(); });
  if (elBrain) elBrain.addEventListener('change', function () { showBrain = elBrain.checked; });

  /* panel collapse + first-run hint (shared helper) */
  if (window.GadgetUI) {
    var frHint = GadgetUI.firstRunHint('lander', 'Fling the rocket and watch it recover.');
    GadgetUI.initPanel({
      panel: elPanel, toggle: elCollapse,
      collapsedClass: 'land-panel--collapsed',
      help: id('land-help'), hint: frHint
    });
  }

  /* manual flight (when autopilot off): track which keys are held so releasing one
     (e.g. a spin key) doesn't cut thrust that's still held. Thrust takes priority. */
  var held = { up: false, left: false, right: false };
  function keySlot(k) {
    if (k === 'ArrowUp' || k === 'w') return 'up';
    if (k === 'ArrowLeft' || k === 'a') return 'left';
    if (k === 'ArrowRight' || k === 'd') return 'right';
    return null;
  }
  function recomputeAction() {
    if (autopilot) return;
    action = held.up ? 2 : held.left ? 3 : held.right ? 1 : 0;   /* left → nose left (3), right → nose right (1) */
  }
  window.addEventListener('keydown', function (e) {
    if (window.GadgetUI && GadgetUI.isTyping(e)) return;   /* don't steer while typing a slider value */
    var s = keySlot(e.key); if (s) { held[s] = true; recomputeAction(); }
  });
  window.addEventListener('keyup', function (e) { var s = keySlot(e.key); if (s) { held[s] = false; recomputeAction(); } });

  /* ---- on-screen touch controls: manual flight on coarse-pointer devices ----
     Three translucent buttons bottom-center (rotate left / thrust / rotate right)
     driving the same held-key flags as the arrow keys. Shown only when autopilot
     is OFF and the primary pointer is coarse. Sits at bottom:4.8rem so it clears
     the mobile full-width chat bar and the bottom-left back/theme buttons. */
  var touchWrap = null;
  var coarse = window.matchMedia ? window.matchMedia('(pointer: coarse)') : null;
  function buildTouchControls() {
    if (touchWrap) return;
    var st = document.createElement('style');
    st.textContent = '.land-touch{position:fixed;left:50%;bottom:4.8rem;transform:translateX(-50%);' +
      'display:flex;gap:16px;z-index:25;}' +
      '.land-touch button{width:56px;height:56px;border-radius:50%;padding:0;cursor:pointer;' +
      'border:1px solid rgba(127,127,127,0.45);background:rgba(127,127,127,0.18);color:inherit;' +
      'touch-action:none;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);' +
      'display:flex;align-items:center;justify-content:center;-webkit-user-select:none;user-select:none;}' +
      '.land-touch button:active{background:rgba(127,127,127,0.38);}' +
      '.land-touch svg{width:26px;height:26px;display:block;}';
    document.head.appendChild(st);
    touchWrap = document.createElement('div');
    touchWrap.className = 'land-touch';
    touchWrap.style.display = 'none';
    function mk(slot, aria, path) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', aria);
      b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
      b.addEventListener('pointerdown', function (e) { e.preventDefault(); held[slot] = true; recomputeAction(); });
      function release() { held[slot] = false; recomputeAction(); }
      b.addEventListener('pointerup', release);
      b.addEventListener('pointercancel', release);
      b.addEventListener('pointerleave', release);
      b.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      touchWrap.appendChild(b);
    }
    mk('left', 'Rotate left', '<path d="M19 12H6"/><path d="M11 6l-6 6 6 6"/>');
    mk('up', 'Thrust', '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>');
    mk('right', 'Rotate right', '<path d="M5 12h13"/><path d="M13 6l6 6-6 6"/>');
    document.body.appendChild(touchWrap);
  }
  function updateTouchControls() {
    var want = !autopilot && coarse && coarse.matches;
    if (want) buildTouchControls();
    if (touchWrap) touchWrap.style.display = want ? 'flex' : 'none';
    if (!want) { held.up = held.left = held.right = false; recomputeAction(); }
  }
  if (coarse) {
    if (coarse.addEventListener) coarse.addEventListener('change', updateTouchControls);
    else if (coarse.addListener) coarse.addListener(updateTouchControls);
  }
  updateTouchControls();

  var rt; window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(resize, 150); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) { if (raf) { cancelAnimationFrame(raf); raf = null; } } else start(); });

  if (elGV) elGV.textContent = g.toFixed(2);
  if (elWindV) elWindV.textContent = fmtWind(wind);
  if (elPadV) elPadV.textContent = padX.toFixed(2);
  resize(); reset(); start();
})();
