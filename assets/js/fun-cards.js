/* ==========================================================================
   Fun hub — live card thumbnails.
   --------------------------------------------------------------------------
   Each card's art box (.xp-card__art[data-thumb="..."]) gets a small canvas
   running a stripped-down preview of the gadget inside: a real Game of Life,
   a real orbiting pair, a real mini double pendulum, and so on. Each preview
   is ~20 lines and throttled; an IntersectionObserver pauses anything
   off-screen (the rAF loop stops entirely when every card is off-screen),
   and prefers-reduced-motion keeps the static SVG icons instead.
   Theme-aware via the usual data-theme observer + matchMedia listener.
   Also loaded by the homepage (_pages/about.md), whose compact .home-strip
   cards reuse the same .xp-card__art[data-thumb] markup — the selector below
   is document-wide on purpose.
   ========================================================================== */
(function () {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var arts = document.querySelectorAll('.xp-card__art[data-thumb]');
  if (!arts.length) return;

  function effectiveTheme() {
    var f = document.documentElement.getAttribute('data-theme');
    if (f === 'light' || f === 'dark') return f;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }
  function light() { return effectiveTheme() === 'light'; }
  function accent() { return light() ? '#34568a' : '#82a6cc'; }
  function grey(a) { return 'rgba(127,127,127,' + a + ')'; }
  function cellColor() { return light() ? '#5e5e5e' : '#a0a0a0'; }
  var RED = '#c4574a';

  /* ---------- the previews: name -> { fps, init(s), draw(s, ctx, w, h, t) } ---------- */
  var THUMBS = {

    life: {
      fps: 5,
      init: function (s) {
        s.c = Math.ceil(s.w / 7); s.r = Math.ceil(s.h / 7);
        s.g = new Uint8Array(s.c * s.r); s.n = new Uint8Array(s.c * s.r);
        for (var i = 0; i < s.g.length; i++) s.g[i] = Math.random() < 0.25 ? 1 : 0;
        s.h1 = -1; s.h2 = -1; s.calm = 0;
      },
      draw: function (s, ctx, w, h) {
        var c = s.c, r = s.r, x, y;
        for (y = 0; y < r; y++) for (x = 0; x < c; x++) {
          var n = 0;
          for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            var nx = (x + dx + c) % c, ny = (y + dy + r) % r;
            n += s.g[ny * c + nx];
          }
          var i = y * c + x;
          s.n[i] = s.g[i] ? (n === 2 || n === 3 ? 1 : 0) : (n === 3 ? 1 : 0);
        }
        var t = s.g; s.g = s.n; s.n = t;
        /* stability check: period-1/2 endstate for a while -> reseed the soup */
        var hs = 0;
        for (var k = 0; k < s.g.length; k++) if (s.g[k]) hs = (hs * 33 + k + 1) >>> 0;
        if (hs === s.h1 || hs === s.h2) { if (++s.calm > 25) { THUMBS.life.init(s); return; } }
        else s.calm = 0;
        s.h2 = s.h1; s.h1 = hs;
        ctx.fillStyle = cellColor(); ctx.globalAlpha = 0.7;
        for (y = 0; y < r; y++) for (x = 0; x < c; x++) if (s.g[y * c + x]) ctx.fillRect(x * 7, y * 7, 6, 6);
        ctx.globalAlpha = 1;
      }
    },

    bonds: {
      fps: 30,
      draw: function (s, ctx, w, h, t) {
        var rate = 0.55 + 0.4 * Math.sin(t / 1600);          // pivot the discount curve
        var px = w * 0.86, py = h * 0.2, x0 = w * 0.12;      // fixed future payout (top right)
        var y0 = py + (h * 0.62) * rate;                     // today's price falls as rate rises
        ctx.strokeStyle = accent(); ctx.lineWidth = 2; ctx.beginPath();
        for (var i = 0; i <= 24; i++) {
          var f = i / 24, x = x0 + (px - x0) * f;
          var y = y0 + (py - y0) * (Math.pow(1 + rate, f * 4) - 1) / (Math.pow(1 + rate, 4) - 1);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.fillStyle = grey(0.8); ctx.beginPath(); ctx.arc(px, py, 4, 0, 6.2832); ctx.fill();
        ctx.fillStyle = accent(); ctx.beginPath(); ctx.arc(x0, y0, 4.5, 0, 6.2832); ctx.fill();
        ctx.strokeStyle = grey(0.35); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(w * 0.08, h * 0.88); ctx.lineTo(w * 0.92, h * 0.88);
        ctx.moveTo(w * 0.08, h * 0.88); ctx.lineTo(w * 0.08, h * 0.12); ctx.stroke();
      }
    },

    loans: {
      fps: 30,
      draw: function (s, ctx, w, h, t) {
        var n = 11, prog = (t % 3600) / 3600 * n;            // a payment sweeps across the term
        for (var i = 0; i < n; i++) {
          var x = w * 0.1 + i * (w * 0.8 / n), bw = (w * 0.8 / n) * 0.62;
          var frac = i / (n - 1), bh = h * 0.6;
          var interest = bh * (1 - frac) * 0.75;             // early payments are mostly interest
          var on = i <= prog;
          ctx.globalAlpha = on ? 1 : 0.25;
          ctx.fillStyle = RED; ctx.fillRect(x, h * 0.82 - interest, bw, interest);
          ctx.fillStyle = accent(); ctx.fillRect(x, h * 0.82 - bh, bw, bh - interest);
          ctx.globalAlpha = 1;
        }
      }
    },

    diversification: {
      fps: 30,
      draw: function (s, ctx, w, h, t) {
        var k = 0.5 + 0.5 * Math.sin(t / 2400);              // N grows → the fan narrows
        var spread = 0.42 - 0.3 * k;
        var x0 = w * 0.1, x1 = w * 0.92, ym = h * 0.5;
        function fan(f, sp) { return ym - h * 0.16 * f + h * sp * f; }
        ctx.fillStyle = light() ? 'rgba(52,86,138,0.16)' : 'rgba(130,166,204,0.16)';
        ctx.beginPath(); ctx.moveTo(x0, ym);
        ctx.lineTo(x1, fan(1, spread)); ctx.lineTo(x1, fan(1, -spread)); ctx.closePath(); ctx.fill();
        ctx.fillStyle = light() ? 'rgba(52,86,138,0.20)' : 'rgba(130,166,204,0.20)';
        ctx.beginPath(); ctx.moveTo(x0, ym);
        ctx.lineTo(x1, fan(1, spread * 0.45)); ctx.lineTo(x1, fan(1, -spread * 0.45)); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = accent(); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x0, ym); ctx.lineTo(x1, ym - h * 0.16); ctx.stroke();
      }
    },

    gravity: {
      fps: 60,
      init: function (s) { s.trail = []; },
      draw: function (s, ctx, w, h, t) {
        var cx = w / 2, cy = h / 2;
        ctx.fillStyle = grey(0.9); ctx.beginPath(); ctx.arc(cx, cy, 6, 0, 6.2832); ctx.fill();
        var a1 = t / 900, r1 = h * 0.33;
        var a2 = -t / 2100, r2 = h * 0.46;
        var p1 = [cx + Math.cos(a1) * r1 * 1.6, cy + Math.sin(a1) * r1];
        var p2 = [cx + Math.cos(a2) * r2 * 1.8, cy + Math.sin(a2) * r2 * 0.8];
        s.trail.push([p1[0], p1[1]]); if (s.trail.length > 46) s.trail.shift();
        ctx.strokeStyle = accent(); ctx.globalAlpha = 0.45; ctx.lineWidth = 1.4; ctx.beginPath();
        for (var i = 0; i < s.trail.length; i++) { if (i === 0) ctx.moveTo(s.trail[i][0], s.trail[i][1]); else ctx.lineTo(s.trail[i][0], s.trail[i][1]); }
        ctx.stroke(); ctx.globalAlpha = 1;
        ctx.fillStyle = accent(); ctx.beginPath(); ctx.arc(p1[0], p1[1], 4, 0, 6.2832); ctx.fill();
        ctx.fillStyle = grey(0.75); ctx.beginPath(); ctx.arc(p2[0], p2[1], 3, 0, 6.2832); ctx.fill();
      }
    },

    magnets: {
      fps: 30,
      draw: function (s, ctx, w, h, t) {
        var cx = w / 2, cy = h / 2, ang = t / 4000;
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang);
        ctx.strokeStyle = grey(0.55); ctx.lineWidth = 1.2;
        for (var k = 1; k <= 3; k++) {                       // dipole field lines: r = r0·sin²θ
          var r0 = 14 + k * 13;
          for (var side = 0; side < 2; side++) {
            ctx.beginPath();
            for (var i = 0; i <= 40; i++) {
              var th = i / 40 * Math.PI;
              var r = r0 * Math.sin(th) * Math.sin(th);
              var x = Math.cos(th) * r, y = Math.sin(th) * r * (side ? 1 : -1);
              if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke();
          }
        }
        ctx.fillStyle = '#4a7be0'; ctx.fillRect(-16, -5, 16, 10);
        ctx.fillStyle = RED; ctx.fillRect(0, -5, 16, 10);
        ctx.restore();
      }
    },

    hash: {
      fps: 30,
      init: function (s) {
        s.c = 18; s.r = Math.max(6, Math.floor(s.h / 13));
        s.bits = []; s.flash = [];
        for (var i = 0; i < s.c * s.r; i++) { s.bits.push(Math.random() < 0.5); s.flash.push(0); }
        s.next = 0;
      },
      draw: function (s, ctx, w, h, t) {
        if (t > s.next) {                                    // a new "message": ~half the bits flip
          s.next = t + 1500;
          for (var i = 0; i < s.bits.length; i++) if (Math.random() < 0.5) { s.bits[i] = !s.bits[i]; s.flash[i] = t + Math.random() * 420; }
        }
        var cw = w / s.c, chh = h / s.r;
        for (var k = 0; k < s.bits.length; k++) {
          var x = (k % s.c) * cw, y = Math.floor(k / s.c) * chh;
          var f = (s.flash[k] && t > s.flash[k] && t < s.flash[k] + 380);
          ctx.fillStyle = f ? accent() : (s.bits[k] ? cellColor() : grey(0.12));
          ctx.globalAlpha = s.bits[k] || f ? 0.75 : 1;
          ctx.fillRect(x + 1, y + 1, cw - 2, chh - 2);
          ctx.globalAlpha = 1;
        }
      }
    },

    pendulum: {
      fps: 60,
      init: function (s) { s.st = [2.0, 0, 2.6, 0]; s.trail = []; },
      draw: function (s, ctx, w, h) {
        var G = 9.81, st = s.st;
        for (var k = 0; k < 4; k++) {                        // a few Euler-ish substeps per frame
          var d = st[0] - st[2], cd = Math.cos(d), sd = Math.sin(d), den = 3 - Math.cos(2 * d);
          var a1 = (-3 * G * Math.sin(st[0]) - G * Math.sin(st[0] - 2 * st[2]) - 2 * sd * (st[3] * st[3] + st[1] * st[1] * cd)) / den;
          var a2 = (2 * sd * (2 * st[1] * st[1] + 2 * G * Math.cos(st[0]) + st[3] * st[3] * cd)) / den;
          st[1] += a1 / 150; st[3] += a2 / 150; st[0] += st[1] / 150; st[2] += st[3] / 150;
        }
        var ax = w / 2, ay = h * 0.3, L = h * 0.26;
        var x1 = ax + Math.sin(st[0]) * L, y1 = ay + Math.cos(st[0]) * L;
        var x2 = x1 + Math.sin(st[2]) * L, y2 = y1 + Math.cos(st[2]) * L;
        s.trail.push([x2, y2]); if (s.trail.length > 70) s.trail.shift();
        ctx.strokeStyle = accent(); ctx.globalAlpha = 0.4; ctx.lineWidth = 1.3; ctx.beginPath();
        for (var i = 0; i < s.trail.length; i++) { if (i === 0) ctx.moveTo(s.trail[i][0], s.trail[i][1]); else ctx.lineTo(s.trail[i][0], s.trail[i][1]); }
        ctx.stroke(); ctx.globalAlpha = 1;
        ctx.strokeStyle = grey(0.85); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        ctx.fillStyle = grey(0.9); ctx.beginPath(); ctx.arc(x1, y1, 3.6, 0, 6.2832); ctx.fill();
        ctx.fillStyle = accent(); ctx.beginPath(); ctx.arc(x2, y2, 4.6, 0, 6.2832); ctx.fill();
      }
    },

    epidemic: {
      fps: 12,
      init: function (s) {
        s.c = Math.ceil(s.w / 7); s.r = Math.ceil(s.h / 7);
        s.g = new Int8Array(s.c * s.r);                      // 0=S, 1..4 infected, -1=R
        s.g[Math.floor(s.r / 2) * s.c + Math.floor(s.c / 2)] = 4;
      },
      draw: function (s, ctx, w, h) {
        var c = s.c, r = s.r, born = [], any = false, x, y;
        for (y = 0; y < r; y++) for (x = 0; x < c; x++) {
          var i = y * c + x, v = s.g[i];
          if (v <= 0) continue;
          any = true;
          for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            var nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= c || ny >= r) continue;
            if (s.g[ny * c + nx] === 0 && Math.random() < 0.16) born.push(ny * c + nx);
          }
          s.g[i] = (v === 1) ? -1 : v - 1;
        }
        for (var b = 0; b < born.length; b++) if (s.g[born[b]] === 0) s.g[born[b]] = 4;
        if (!any) THUMBS.epidemic.init(s);                   // outbreak over → restart
        for (y = 0; y < r; y++) for (x = 0; x < c; x++) {
          var v2 = s.g[y * c + x];
          if (v2 === 0) continue;
          ctx.fillStyle = v2 > 0 ? RED : (light() ? 'rgba(52,86,138,0.40)' : 'rgba(130,166,204,0.38)');
          ctx.fillRect(x * 7, y * 7, 6, 6);
        }
      }
    },

    lander: {
      fps: 60,
      init: function (s) {
        /* fixed tiny-net weights (seeded so every load looks the same) */
        var seed = 42, rnd = function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; };
        s.W1 = []; s.W2 = [];
        for (var i = 0; i < 20; i++) s.W1.push(rnd());
        for (i = 0; i < 15; i++) s.W2.push(rnd());
        s.side = Math.random() < 0.5 ? 1 : -1;
        s.reset = function () {
          s.side = -s.side;                                  // alternate sides → visibly flies back and forth
          s.x = s.side * (0.14 + Math.random() * 0.07);      // lateral offset from the pad (fraction of w)
          s.vx = (Math.random() - 0.5) * 0.03;
          s.alt = 1; s.vy = 0.04; s.rest = 0;
        };
        s.reset();
      },
      draw: function (s, ctx, w, h, t) {
        var dt = 1 / 60, padX = w * 0.33, gp = h * 0.82, skyY = h * 0.15;
        /* the "policy": steer back over the pad, brake the descent near the ground */
        var u = 0, main = 0;
        if (s.rest > 0) {
          s.rest -= dt; if (s.rest <= 0) s.reset();
        } else {
          u = Math.max(-1, Math.min(1, -(3.2 * s.x + 3.6 * s.vx)));
          main = s.vy > 0.045 + 0.34 * s.alt ? 1 : 0;        // bang-bang engine → pulsing flame
          s.vy += (0.30 - main * 0.55) * dt; if (s.vy < 0.02) s.vy = 0.02;
          s.alt -= s.vy * dt;
          s.vx += u * 0.35 * dt; s.x += s.vx * dt;
          if (s.alt <= 0) { s.alt = 0; s.rest = 0.9; u = 0; main = 0; }
        }
        /* glowing pad + ground */
        var grn = light() ? '#3f7d57' : '#6fce97';
        ctx.strokeStyle = grey(0.35); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, gp); ctx.lineTo(w * 0.55, gp); ctx.stroke();
        ctx.strokeStyle = grn; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(padX - 13, gp); ctx.lineTo(padX + 13, gp); ctx.stroke();
        var feetY = skyY + (gp - skyY) * (1 - s.alt);
        var firing = main > 0;
        var S = 8;
        ctx.save(); ctx.translate(padX + s.x * w, feetY); ctx.rotate(-u * 0.3);
        var bw = S * 0.6, legH = S * 0.36, bh = S * 1.5, baseY = -legH, topY = baseY - bh, noseTip = topY - S * 0.66;
        if (firing) {
          ctx.fillStyle = (light() ? '#e0b24a' : '#ffc45a'); ctx.globalAlpha = 0.95;
          var fl = S + Math.random() * S * 0.4;
          ctx.beginPath(); ctx.moveTo(-bw * 0.5, baseY); ctx.lineTo(0, baseY + fl); ctx.lineTo(bw * 0.5, baseY); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = light() ? '#8a93a6' : '#9aa6bd'; ctx.lineWidth = 1.4; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(-bw * 0.7, baseY); ctx.lineTo(-bw * 1.2, 0); ctx.moveTo(bw * 0.7, baseY); ctx.lineTo(bw * 1.2, 0); ctx.stroke();
        ctx.fillStyle = light() ? '#cdd6e4' : '#c7d2e4';
        ctx.beginPath(); ctx.moveTo(-bw, baseY); ctx.lineTo(-bw, topY); ctx.quadraticCurveTo(-bw, noseTip + 2, 0, noseTip); ctx.quadraticCurveTo(bw, noseTip + 2, bw, topY); ctx.lineTo(bw, baseY); ctx.closePath(); ctx.fill();
        ctx.fillStyle = accent(); ctx.globalAlpha = 0.85; ctx.beginPath(); ctx.moveTo(0, noseTip); ctx.quadraticCurveTo(bw, noseTip + 2, bw, topY); ctx.lineTo(-bw, topY); ctx.quadraticCurveTo(-bw, noseTip + 2, 0, noseTip); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
        ctx.fillStyle = light() ? '#243349' : '#16202e'; ctx.beginPath(); ctx.arc(0, topY + bh * 0.3, bw * 0.34, 0, 6.2832); ctx.fill();
        if (Math.abs(u) > 0.3) {                             /* RCS puff at the nose, opposite the push */
          var pd = u > 0 ? -1 : 1;
          ctx.fillStyle = light() ? '#e0b24a' : '#ffc45a'; ctx.globalAlpha = 0.8;
          var pl = S * (0.5 + Math.abs(u) * 0.5);
          ctx.beginPath(); ctx.moveTo(pd * bw, topY + bh * 0.12); ctx.lineTo(pd * (bw + pl), topY + bh * 0.3); ctx.lineTo(pd * bw, topY + bh * 0.48);
          ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
        }
        ctx.restore();
        /* the policy net, computed live from the flight state: inputs → tanh hidden → thrusters */
        var inp = [
          Math.max(-1, Math.min(1, s.x * 5)),
          Math.max(-1, Math.min(1, s.vx * 9)),
          s.alt * 2 - 1,
          Math.max(-1, Math.min(1, s.vy * 3.5))
        ];
        var hid = [], i2, j, k;
        for (j = 0; j < 5; j++) {
          var a2 = 0;
          for (i2 = 0; i2 < 4; i2++) a2 += s.W1[j * 4 + i2] * inp[i2];
          hid.push(Math.tanh(1.6 * a2));
        }
        var out = [Math.max(0, -u), main, Math.max(0, u)];   /* ◄ thruster, main engine, ► thruster */
        var xi = w * 0.62, xh = w * 0.78, xo = w * 0.93;
        function iy(i) { return h * (0.24 + i * 0.18); }
        function hy(j) { return h * (0.17 + j * 0.16); }
        function oy(k) { return h * (0.30 + k * 0.20); }
        ctx.lineWidth = 1;
        for (j = 0; j < 5; j++) for (i2 = 0; i2 < 4; i2++) {
          ctx.strokeStyle = grey(0.9);
          ctx.globalAlpha = 0.05 + 0.30 * Math.abs(inp[i2] * s.W1[j * 4 + i2]);
          ctx.beginPath(); ctx.moveTo(xi, iy(i2)); ctx.lineTo(xh, hy(j)); ctx.stroke();
        }
        for (k = 0; k < 3; k++) for (j = 0; j < 5; j++) {
          ctx.strokeStyle = out[k] > 0.2 ? accent() : grey(0.9);
          ctx.globalAlpha = 0.04 + 0.45 * Math.abs(hid[j] * s.W2[k * 5 + j]) * (0.25 + 0.75 * out[k]);
          ctx.beginPath(); ctx.moveTo(xh, hy(j)); ctx.lineTo(xo, oy(k)); ctx.stroke();
        }
        var rn = Math.max(2.2, h * 0.032);
        for (i2 = 0; i2 < 4; i2++) {
          ctx.fillStyle = grey(1); ctx.globalAlpha = 0.3 + 0.55 * Math.abs(inp[i2]);
          ctx.beginPath(); ctx.arc(xi, iy(i2), rn * 0.9, 0, 6.2832); ctx.fill();
        }
        for (j = 0; j < 5; j++) {
          ctx.fillStyle = accent(); ctx.globalAlpha = 0.18 + 0.72 * Math.abs(hid[j]);
          ctx.beginPath(); ctx.arc(xh, hy(j), rn, 0, 6.2832); ctx.fill();
        }
        for (k = 0; k < 3; k++) {
          ctx.fillStyle = accent(); ctx.globalAlpha = 0.15 + 0.85 * Math.min(1, out[k]);
          ctx.beginPath(); ctx.arc(xo, oy(k), rn, 0, 6.2832); ctx.fill();
          if (out[k] > 0.25) {                               /* ring the thruster that's firing */
            ctx.globalAlpha = 0.9; ctx.strokeStyle = accent(); ctx.lineWidth = 1.2;
            ctx.beginPath(); ctx.arc(xo, oy(k), rn + 2, 0, 6.2832); ctx.stroke();
            ctx.lineWidth = 1;
          }
        }
        ctx.globalAlpha = 1;
      }
    },

    adversarial: {
      fps: 30,
      init: function (s) {
        /* a chunky pixel "7" */
        s.rows = ['11111111', '00000011', '00000110', '00001100', '00011000', '00011000', '00110000', '00110000'];
        s.noise = [];
        for (var i = 0; i < 64; i++) s.noise.push(Math.random() < 0.5 ? 1 : -1);
      },
      draw: function (s, ctx, w, h, t) {
        var attacked = (t % 3000) > 1500;
        var px = Math.min(w, h) * 0.085, x0 = w / 2 - px * 4, y0 = h / 2 - px * 4 - 4;
        for (var y = 0; y < 8; y++) for (var x = 0; x < 8; x++) {
          var on = s.rows[y][x] === '1';
          var ni = y * 8 + x;
          ctx.fillStyle = on ? cellColor() : grey(0.07);
          ctx.fillRect(x0 + x * px, y0 + y * px, px - 1, px - 1);
          if (attacked) {                                    // the ±ε speckle fades in
            ctx.fillStyle = s.noise[ni] > 0 ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.22)';
            ctx.fillRect(x0 + x * px, y0 + y * px, px - 1, px - 1);
          }
        }
        ctx.font = '600 13px "Source Sans 3", system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillStyle = attacked ? RED : grey(0.85);
        ctx.fillText(attacked ? 'model sees “3”' : 'model sees “7”', w / 2, y0 + px * 8 + 5);
      }
    },

    transformer: {
      fps: 7,
      init: function (s) {
        /* abstract glyph slots laid out in lines, with word-ish gaps */
        s.slots = [];
        var gw = 7, gh = 9, lh = 15, y = 10, x;
        while (y + gh < s.h - 24) {
          x = 10;
          while (x + gw < s.w - 10) {
            if (Math.random() < 0.16) { x += gw; continue; }   // a space
            s.slots.push([x, y]);
            x += gw;
          }
          y += lh;
        }
        s.k = 0; s.hold = 0;
      },
      draw: function (s, ctx, w, h, t) {
        if (s.hold) { if (--s.hold === 0) s.k = 0; }           // pause at the end, then rewrite
        else if (s.k < s.slots.length) s.k++;
        else s.hold = 9;
        ctx.fillStyle = cellColor(); ctx.globalAlpha = 0.4;
        for (var i = 0; i < s.k; i++) ctx.fillRect(s.slots[i][0], s.slots[i][1], 5, 9);
        ctx.globalAlpha = 1;
        if (s.k < s.slots.length && !s.hold) {                 // soft accent cursor on the next slot
          ctx.fillStyle = accent(); ctx.globalAlpha = 0.55 + 0.25 * Math.sin(t / 260);
          ctx.fillRect(s.slots[s.k][0], s.slots[s.k][1], 5, 9);
          ctx.globalAlpha = 1;
        }
        var n = 4, cw = 11, y0 = h - 16, x0 = w / 2 - (n * (cw + 4) - 4) / 2;
        for (var j = 0; j < n; j++) {                          // a faint attention row that shifts
          var a = Math.sin((s.k * 0.6 + j) * 1.7);
          ctx.fillStyle = accent(); ctx.globalAlpha = 0.08 + 0.3 * a * a;
          ctx.fillRect(x0 + j * (cw + 4), y0, cw, 7);
        }
        ctx.globalAlpha = 1;
      }
    },

    fourier: {
      fps: 30,
      init: function (s) { s.trail = []; },
      draw: function (s, ctx, w, h, t) {
        var cx = w * 0.4, cy = h * 0.5, r1 = h * 0.26;
        var a1 = t / 1500, a2 = -3 * a1, a3 = 5 * a1;          // integer ratios → a closed curve
        var r2 = r1 * 0.5, r3 = r1 * 0.24;
        var x1 = cx + Math.cos(a1) * r1, y1 = cy + Math.sin(a1) * r1;
        var x2 = x1 + Math.cos(a2) * r2, y2 = y1 + Math.sin(a2) * r2;
        var x3 = x2 + Math.cos(a3) * r3, y3 = y2 + Math.sin(a3) * r3;
        ctx.strokeStyle = grey(0.35); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(cx, cy, r1, 0, 6.2832); ctx.stroke();
        ctx.beginPath(); ctx.arc(x1, y1, r2, 0, 6.2832); ctx.stroke();
        ctx.beginPath(); ctx.arc(x2, y2, r3, 0, 6.2832); ctx.stroke();
        ctx.strokeStyle = grey(0.7);
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.stroke();
        s.trail.push([x3, y3]); if (s.trail.length > 110) s.trail.shift();
        ctx.strokeStyle = accent(); ctx.lineWidth = 1.6;
        for (var i = 1; i < s.trail.length; i++) {             // the traced curve fades with age
          ctx.globalAlpha = 0.65 * (i / s.trail.length);
          ctx.beginPath(); ctx.moveTo(s.trail[i - 1][0], s.trail[i - 1][1]); ctx.lineTo(s.trail[i][0], s.trail[i][1]); ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = accent(); ctx.beginPath(); ctx.arc(x3, y3, 3, 0, 6.2832); ctx.fill();
      }
    },

    bayes: {
      fps: 20,
      init: function (s) {
        var sp = 10;
        s.cols = Math.max(4, Math.floor((s.w - 14) / sp));
        s.rows = Math.max(3, Math.floor((s.h - 14) / sp));
        s.n = s.cols * s.rows;
        s.mark = new Int8Array(s.n);                           // 0 healthy, 1 false alarm, 2 sick
        var sick = 1 + (Math.random() < 0.5 ? 1 : 0), i;
        for (i = 0; i < sick; i++) s.mark[Math.floor(Math.random() * s.n)] = 2;
        for (i = 0; i < s.n; i++) if (!s.mark[i] && Math.random() < 0.06) s.mark[i] = 1;
        s.k = 0;
      },
      draw: function (s, ctx, w, h) {
        s.k += Math.max(1, s.n / 50);                          // the test sweeps the crowd
        if (s.k > s.n * 1.45) THUMBS.bayes.init(s);            // linger, then a fresh crowd
        var sp = 10, x0 = (w - s.cols * sp) / 2 + sp / 2, y0 = (h - s.rows * sp) / 2 + sp / 2;
        for (var i = 0; i < s.n; i++) {
          var x = x0 + (i % s.cols) * sp, y = y0 + Math.floor(i / s.cols) * sp;
          var tested = i < s.k, m = s.mark[i];
          ctx.globalAlpha = 1;
          if (!tested || !m) { ctx.fillStyle = grey(tested ? 0.5 : 0.25); }
          else if (m === 2) { ctx.fillStyle = RED; }
          else { ctx.fillStyle = accent(); ctx.globalAlpha = 0.85; }
          ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 6.2832); ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    },

    timing: {
      fps: 30,
      init: function (s) { s.win = 2; s.start = 0; },
      draw: function (s, ctx, w, h, t) {
        if (!s.start) s.start = t;
        var ph = t - s.start, cycle = 3400;
        if (ph >= cycle) { s.start = t; s.win = Math.floor(Math.random() * 6); ph = 0; }
        var n = 6, gap = 6, bw = (w * 0.72 - gap * (n - 1)) / n, x0 = w * 0.14, base = h * 0.84;
        var grow = Math.min(1, ph / 2600);
        ctx.strokeStyle = grey(0.3); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(w * 0.08, base); ctx.lineTo(w * 0.92, base); ctx.stroke();
        for (var i = 0; i < n; i++) {
          var jit = 1.5 * Math.sin(t / 420 + i * 2.3);         // measurement noise
          var bh = h * 0.16 + jit;
          if (i === s.win) bh = h * 0.16 + grow * h * 0.4 + jit; // one guess takes longer to reject
          var flash = i === s.win && grow >= 1;
          ctx.fillStyle = flash ? accent() : grey(0.5);
          ctx.globalAlpha = flash ? 0.75 + 0.25 * Math.sin(t / 140) : 0.8;
          ctx.fillRect(x0 + i * (bw + gap), base - bh, bw, bh);
        }
        ctx.globalAlpha = 1;
      }
    }
  };

  /* ---------- wiring: one canvas per card, paused off-screen ---------- */
  var states = [];
  arts.forEach ? null : (arts = Array.prototype.slice.call(arts));
  Array.prototype.forEach.call(arts, function (art) {
    var kind = art.getAttribute('data-thumb');
    var thumb = THUMBS[kind];
    if (!thumb) return;
    var cv = document.createElement('canvas');
    cv.className = 'xp-card__live';
    cv.setAttribute('aria-hidden', 'true');
    art.appendChild(cv);
    art.classList.add('xp-card__art--live');
    states.push({ art: art, cv: cv, ctx: cv.getContext('2d'), thumb: thumb, visible: false, last: 0, w: 0, h: 0 });
  });
  if (!states.length) return;

  function sizeOne(s) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = s.art.clientWidth, h = s.art.clientHeight;
    if (!w || !h) return;
    s.w = w; s.h = h;
    s.cv.width = Math.round(w * dpr); s.cv.height = Math.round(h * dpr);
    s.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (s.thumb.init) s.thumb.init(s);
  }
  states.forEach(sizeOne);

  var io = null;
  if ('IntersectionObserver' in window) {
    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        for (var i = 0; i < states.length; i++) if (states[i].art === en.target) states[i].visible = en.isIntersecting;
      });
      if (anyVisible()) ensureRunning();       // a card scrolled back in → wake the loop
    }, { rootMargin: '60px' });
    states.forEach(function (s) { io.observe(s.art); });
  } else {
    states.forEach(function (s) { s.visible = true; });
  }

  /* The rAF loop stops itself when every card is off-screen and is restarted by
     the IntersectionObserver above, so nothing spins while all cards are paused. */
  var running = false;
  function anyVisible() {
    for (var i = 0; i < states.length; i++) if (states[i].visible) return true;
    return false;
  }
  function ensureRunning() {
    if (running) return;
    running = true;
    requestAnimationFrame(frame);
  }
  function frame(t) {
    if (!anyVisible()) { running = false; return; }
    requestAnimationFrame(frame);
    for (var i = 0; i < states.length; i++) {
      var s = states[i];
      if (!s.visible || !s.w) continue;
      if (t - s.last < 1000 / s.thumb.fps) continue;
      s.last = t;
      s.ctx.clearRect(0, 0, s.w, s.h);
      s.thumb.draw(s, s.ctx, s.w, s.h, t);
    }
  }
  ensureRunning();

  var rt;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { states.forEach(sizeOne); }, 150); });
  try {
    new MutationObserver(function () { states.forEach(function (s) { s.last = 0; }); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  } catch (e) {}
})();
