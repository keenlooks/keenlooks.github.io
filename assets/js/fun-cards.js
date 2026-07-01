/* ==========================================================================
   Fun hub — live card thumbnails.
   --------------------------------------------------------------------------
   Each card's art box (.xp-card__art[data-thumb="..."]) gets a small canvas
   running a stripped-down preview of the gadget inside: a real Game of Life,
   a real orbiting pair, a real mini double pendulum, and so on. Each preview
   is ~20 lines and throttled; an IntersectionObserver pauses anything
   off-screen, and prefers-reduced-motion keeps the static SVG icons instead.
   Theme-aware via the usual data-theme observer + matchMedia listener.
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
      init: function (s) { s.t = 0; },
      draw: function (s, ctx, w, h, t) {
        var gp = h * 0.82, padX = w * 0.5;
        /* glowing pad + ground */
        var grn = light() ? '#3f7d57' : '#6fce97';
        ctx.strokeStyle = grey(0.35); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, gp); ctx.lineTo(w, gp); ctx.stroke();
        ctx.strokeStyle = grn; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(padX - 13, gp); ctx.lineTo(padX + 13, gp); ctx.stroke();
        /* descending rocket (feet land on the pad, then loops) */
        s.t += 0.016; var cyc = (s.t % 3.2) / 3.2;
        var feetY = h * 0.16 + (gp - h * 0.16) * Math.min(1, cyc * 1.18);
        var firing = cyc > 0.45 && cyc < 0.98;
        var S = 8;
        ctx.save(); ctx.translate(padX, feetY);
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
        ctx.restore();
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
    }, { rootMargin: '60px' });
    states.forEach(function (s) { io.observe(s.art); });
  } else {
    states.forEach(function (s) { s.visible = true; });
  }

  function frame(t) {
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
  requestAnimationFrame(frame);

  var rt;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { states.forEach(sizeOne); }, 150); });
  try {
    new MutationObserver(function () { states.forEach(function (s) { s.last = 0; }); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  } catch (e) {}
})();
