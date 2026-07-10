/* ==========================================================================
   Why bond prices fall when rates rise — interactive explainer
   --------------------------------------------------------------------------
   SINGLE PAYOUT ("growth line"): one fixed future payout (FV) at maturity. You
   pay price P today; that money grows at the market rate up to FV. Raise the
   rate -> steeper curve, but it must still end at the fixed FV -> it starts
   lower -> today's price drops.

   COUPON BOND: a freely-editable set of payouts (a coupon each year + the face
   value at maturity by default). Shown as ONE line — the bond's value over time
   (= present value of the payouts not yet paid): it drops by each payout when
   it's paid, ending at $0. Price today = sum of the payouts' present values.
   Click a year to add a payout; click a payout to edit its amount (or × / 0 to
   delete); DRAG a payout to a different time. Face/coupon-rate/term sliders
   rebuild the standard bond; the market-rate slider just re-prices.

   linear = simple interest (approximate); exponential = compound (exact).
   Theme-aware; responsive (DPR-capped); honors prefers-reduced-motion; touch ok.
   ========================================================================== */
(function () {
  var canvas = document.getElementById('bond-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  function id(x) { return document.getElementById(x); }

  var rateInput = id('bond-rate'), rateVal = id('bond-rate-val');
  var yearsInput = id('bond-years'), yearsVal = id('bond-years-val');
  var curveToggle = id('bond-mode');
  var raiseBtn = id('bond-raise'), cutBtn = id('bond-cut'), resetBtn = id('bond-reset');
  var rSingle = id('bond-view-single'), rCoupon = id('bond-view-coupon');
  var couponBox = id('bond-coupon-controls');
  var faceInput = id('bond-face'), faceVal = id('bond-face-val');
  var couponInput = id('bond-coupon'), couponVal = id('bond-coupon-val');
  var clearBtn = id('bond-clear');
  var caption = id('bond-caption');

  var SINGLE_FV = 1000;
  var DEF = { rate: 0.03, years: 10, curve: 'linear', face: 1000, coupon: 0.05 };
  var s = { view: 'single', rate: DEF.rate, years: DEF.years, curve: DEF.curve, face: DEF.face, coupon: DEF.coupon, payouts: [] };
  var displayRate = s.rate, raf = null, DEFAULT_PAY = 100, drag = null;
  var overlay = window.makeNumberOverlay ? window.makeNumberOverlay(canvas) : null;
  s.startYearCal = null;        // calendar year for year 0 (null = "years from today"); set by clicking an x-axis tick
  function tickLabel(yr) { return s.startYearCal != null ? String(s.startYearCal + yr) : String(yr); }
  var reduceMQ = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  function reduced() { return !!(reduceMQ && reduceMQ.matches); }

  function effectiveTheme() {
    var f = document.documentElement.getAttribute('data-theme');
    if (f === 'light' || f === 'dark') return f;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }
  function palette() {
    var light = effectiveTheme() === 'light';
    return {
      text:   light ? '#262626' : '#d6d6d6',
      muted:  light ? '#737373' : '#9a9a9a',
      grid:   light ? 'rgba(0,0,0,0.09)'  : 'rgba(255,255,255,0.09)',
      axis:   light ? 'rgba(0,0,0,0.40)'  : 'rgba(255,255,255,0.38)',
      accent: light ? '#34568a' : '#82a6cc',
      fill:   light ? 'rgba(52,86,138,0.10)' : 'rgba(130,166,204,0.12)',
      panel:  light ? '#ffffff' : '#141414'
    };
  }

  function df(t, r) { return s.curve === 'exp' ? 1 / Math.pow(1 + r, t) : 1 / (1 + r * t); }

  // single-payout helpers
  function singlePrice(r) { return SINGLE_FV * df(s.years, r); }
  function singleValueAt(t, r) { var p = singlePrice(r); return s.curve === 'exp' ? p * Math.pow(1 + r, t) : p * (1 + r * t); }

  // coupon helpers (freeform payout list)
  function rebuildStandard() {
    s.payouts = [];
    var c = s.face * s.coupon;
    for (var y = 1; y < s.years; y++) s.payouts.push({ t: y, amt: c });
    s.payouts.push({ t: s.years, amt: c + s.face });   // final coupon + face value
  }
  // bond value at time t = present value of payouts not yet paid
  function bondValueAt(t, r) { var v = 0; for (var i = 0; i < s.payouts.length; i++) { var p = s.payouts[i]; if (p.t > t + 1e-9) v += p.amt * df(p.t - t, r); } return v; }
  function couponPrice(r) { return bondValueAt(0, r); }

  function fmtUSD(n) { return '$' + Math.round(n).toLocaleString('en-US'); }

  // ---- geometry ----------------------------------------------------------
  var W = 0, H = 0, M = { l: 64, r: 74, t: 30, b: 46 }, yMax = 1;
  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function xPx(t) { return M.l + (t / s.years) * (W - M.l - M.r); }
  function yPx(v) { return (H - M.b) - (v / yMax) * (H - M.b - M.t); }
  function pxToYear(px) { return (px - M.l) / (W - M.l - M.r) * s.years; }

  function xTicks() {
    var y = s.years, step = y <= 6 ? 1 : (y <= 12 ? 2 : 5), t = [], k;
    for (k = 0; k < y; k += step) t.push(k);
    t.push(y);
    return t;
  }
  function drawGrid(c, yLabelFn) {
    ctx.font = '12px "Source Sans 3", system-ui, sans-serif';
    ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    for (var i = 0; i <= 4; i++) {
      var v = (yMax / 4) * i, gy = yPx(v);
      ctx.strokeStyle = c.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(M.l, gy); ctx.lineTo(W - M.r, gy); ctx.stroke();
      ctx.fillStyle = c.muted; ctx.fillText(yLabelFn(v), M.l - 8, gy);
    }
    ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    var ticks = xTicks();
    for (var k = 0; k < ticks.length; k++) {
      var gx = xPx(ticks[k]);
      ctx.strokeStyle = c.grid; ctx.beginPath(); ctx.moveTo(gx, M.t); ctx.lineTo(gx, H - M.b); ctx.stroke();
      ctx.fillStyle = c.muted; ctx.fillText(tickLabel(ticks[k]), gx, H - M.b + 8);
    }
    ctx.strokeStyle = c.axis; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(M.l, M.t); ctx.lineTo(M.l, H - M.b); ctx.lineTo(W - M.r, H - M.b); ctx.stroke();
    ctx.fillStyle = c.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(s.startYearCal != null ? 'Year' : 'Years from today', (M.l + (W - M.r)) / 2, H - 8);
  }

  // ---- single-payout view -----------------------------------------------
  function drawSingle(c) {
    yMax = SINGLE_FV * 1.10;
    drawGrid(c, fmtUSD);
    var p = singlePrice(displayRate), steps = s.curve === 'exp' ? 48 : 1, k;
    ctx.beginPath(); ctx.moveTo(xPx(0), yPx(singleValueAt(0, displayRate)));
    for (k = 1; k <= steps; k++) { var tt = (k / steps) * s.years; ctx.lineTo(xPx(tt), yPx(singleValueAt(tt, displayRate))); }
    ctx.lineTo(xPx(s.years), H - M.b); ctx.lineTo(xPx(0), H - M.b); ctx.closePath();
    ctx.fillStyle = c.fill; ctx.fill();
    ctx.beginPath(); ctx.moveTo(xPx(0), yPx(singleValueAt(0, displayRate)));
    for (k = 1; k <= steps; k++) { var t2 = (k / steps) * s.years; ctx.lineTo(xPx(t2), yPx(singleValueAt(t2, displayRate))); }
    ctx.strokeStyle = c.accent; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();
    var midT = s.years * 0.5;
    ctx.fillStyle = c.accent; ctx.font = '600 12px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText((displayRate * 100).toFixed(1) + '% / yr', xPx(midT) + 6, yPx(singleValueAt(midT, displayRate)) - 6);
    var fx = xPx(s.years), fy = yPx(SINGLE_FV);
    dot(fx, fy, c.accent, c.panel);
    ctx.fillStyle = c.text; ctx.font = '600 13px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(fmtUSD(SINGLE_FV) + ' payout', fx - 4, fy - 8);
    ctx.fillStyle = c.muted; ctx.font = '11px "Source Sans 3", system-ui, sans-serif'; ctx.textBaseline = 'top'; ctx.fillText('fixed', fx - 4, fy + 8);
    var pxp = xPx(0), pyp = yPx(p);
    dot(pxp, pyp, c.accent, c.panel);
    ctx.fillStyle = c.text; ctx.font = '700 14px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText('Price today: ' + fmtUSD(p), pxp + 12, pyp);
  }
  function dot(x, y, fill, ring) {
    ctx.beginPath(); ctx.arc(x, y, 6.5, 0, Math.PI * 2); ctx.fillStyle = ring; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
  }

  // ---- coupon-bond view (one value line, freeform payouts) --------------
  function drawCoupon(c) {
    var ps = s.payouts.slice().sort(function (a, b) { return a.t - b.t; });
    var pts = [], prev = 0, maxV = 0, i, k;
    function addRange(t0, t1) {
      if (t1 <= t0) return;
      var steps = Math.max(2, Math.round((t1 - t0) * 16));
      for (var j = 0; j <= steps; j++) { var t = t0 + (t1 - t0) * j / steps, v = bondValueAt(t, displayRate); pts.push([t, v]); if (v > maxV) maxV = v; }
    }
    for (i = 0; i < ps.length; i++) {
      addRange(prev, ps[i].t - 1e-4);
      pts.push([ps[i].t, bondValueAt(ps[i].t - 1e-4, displayRate)]);   // top of drop
      pts.push([ps[i].t, bondValueAt(ps[i].t, displayRate)]);          // bottom of drop
      prev = ps[i].t;
    }
    if (prev < s.years) pts.push([s.years, 0]);                        // flat at $0 to maturity
    var price = bondValueAt(0, displayRate);
    if (price > maxV) maxV = price;
    yMax = Math.max(maxV, 100) * 1.18;
    drawGrid(c, fmtUSD);

    if (pts.length) {
      ctx.beginPath();
      for (k = 0; k < pts.length; k++) { var Xa = xPx(pts[k][0]), Ya = yPx(pts[k][1]); if (k === 0) ctx.moveTo(Xa, Ya); else ctx.lineTo(Xa, Ya); }
      ctx.lineTo(xPx(pts[pts.length - 1][0]), H - M.b); ctx.lineTo(xPx(pts[0][0]), H - M.b); ctx.closePath();
      ctx.fillStyle = c.fill; ctx.fill();
      ctx.beginPath();
      for (k = 0; k < pts.length; k++) { var X = xPx(pts[k][0]), Y = yPx(pts[k][1]); if (k === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y); }
      ctx.strokeStyle = c.accent; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();
    }

    // marker + amount label per payout (s.payouts order, for stable click indices)
    for (i = 0; i < s.payouts.length; i++) {
      var p = s.payouts[i], vb = bondValueAt(p.t - 1e-4, displayRate);
      ctx.beginPath(); ctx.arc(xPx(p.t), yPx(vb), 4, 0, Math.PI * 2); ctx.fillStyle = c.accent; ctx.fill();
      ctx.fillStyle = c.text; ctx.font = '11px "Source Sans 3", system-ui, sans-serif';
      ctx.textAlign = (p.t >= s.years - 0.01) ? 'right' : 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText('↓ ' + fmtUSD(p.amt), xPx(p.t) + (p.t >= s.years - 0.01 ? 6 : 0), yPx(vb) - 8);
    }
    // drag tooltip
    if (drag && drag.moved && s.payouts[drag.idx]) {
      var dp = s.payouts[drag.idx];
      ctx.fillStyle = c.muted; ctx.font = '600 11px "Source Sans 3", system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(s.startYearCal != null ? ('~' + (s.startYearCal + dp.t).toFixed(1)) : ('Year ' + dp.t.toFixed(1)), xPx(dp.t), 26);
    }
    // price label (top-left) + hint (bottom-left)
    ctx.fillStyle = c.text; ctx.font = '700 15px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('Price today: ' + (s.curve === 'linear' ? '~' : '') + fmtUSD(price), M.l + 8, M.t + 4);
    ctx.fillStyle = c.muted; ctx.font = '11px "Source Sans 3", system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText("click a year to add a payout · click one to edit · drag to move it", M.l + 8, H - M.b - 8);
  }

  // ---- caption -----------------------------------------------------------
  function curveNote() { return s.curve === 'exp' ? 'Compound interest — the real discount curve.' : 'Simplified: simple interest, so the price is approximate.'; }
  function updateCaption() {
    if (!caption) return;
    var r = displayRate, approx = s.curve === 'linear', tilde = approx ? '~' : '';
    if (s.view === 'single') {
      caption.innerHTML = "You'll receive <strong>" + fmtUSD(SINGLE_FV) + "</strong> in <strong>" + s.years
        + "</strong> years. At an interest rate of <strong>" + (r * 100).toFixed(1) + "%</strong>, that future payout is worth <strong>"
        + tilde + fmtUSD(singlePrice(r)) + "</strong> today &mdash; the bond's price. <span class=\"bond-note\">(" + curveNote() + ")</span>";
    } else {
      var coupon = s.face * s.coupon, price = couponPrice(r);
      var lead = "A coupon bond paying a <strong>" + (s.coupon * 100).toFixed(1) + "%</strong> coupon (<strong>"
        + fmtUSD(coupon) + "/yr</strong>) plus its <strong>" + fmtUSD(s.face) + "</strong> face value at maturity. At a market rate of <strong>"
        + (r * 100).toFixed(1) + "%</strong>, ";
      if (approx) {
        caption.innerHTML = lead + "its price today is about <strong>~" + fmtUSD(price)
          + "</strong>. <span class=\"bond-note\">(Simplified: simple interest &mdash; toggle &ldquo;more realistic&rdquo; for the exact price and whether it's at a discount or premium.)</span>";
      } else {
        var tag = 'at par', diff = price - s.face;
        if (diff > s.face * 0.005) tag = 'at a premium (its coupon beats the market)';
        else if (diff < -s.face * 0.005) tag = 'at a discount (the market pays more elsewhere)';
        caption.innerHTML = lead + "its price today is <strong>" + fmtUSD(price) + "</strong> &mdash; trading <strong>" + tag
          + "</strong>. <span class=\"bond-note\">(" + curveNote() + ")</span>";
      }
    }
  }

  // ---- draw + sync -------------------------------------------------------
  function draw() {
    if (!W || !H) resize();
    if (!W || !H) return;
    var c = palette();
    ctx.clearRect(0, 0, W, H);
    if (s.view === 'single') drawSingle(c); else drawCoupon(c);
    syncControls();
    updateCaption();
  }
  function syncControls() {
    if (rateVal) rateVal.textContent = (displayRate * 100).toFixed(1) + '%';
    if (yearsVal) yearsVal.textContent = s.years;
    if (faceVal) faceVal.textContent = fmtUSD(s.face);
    if (couponVal) couponVal.textContent = (s.coupon * 100).toFixed(1) + '%';
    if (rateInput && document.activeElement !== rateInput) rateInput.value = (displayRate * 100).toFixed(1);
  }

  // ---- rate animation (Fed scenarios) -----------------------------------
  function tick() {
    var d = s.rate - displayRate;
    if (reduced() || Math.abs(d) < 0.00008) { displayRate = s.rate; draw(); raf = null; return; }
    displayRate += d * 0.16; draw(); raf = requestAnimationFrame(tick);
  }
  function animateToRate() { if (!raf) raf = requestAnimationFrame(tick); }
  function jumpToRate() { if (raf) { cancelAnimationFrame(raf); raf = null; } displayRate = s.rate; draw(); }
  function setRate(r, animate) { s.rate = Math.max(0, Math.min(0.12, r)); if (animate && !reduced()) animateToRate(); else jumpToRate(); }

  // ---- view toggle -------------------------------------------------------
  function setView(v) {
    s.view = v;
    if (v === 'coupon' && s.payouts.length === 0) rebuildStandard();
    if (couponBox) couponBox.hidden = (v !== 'coupon');
    if (clearBtn) clearBtn.hidden = (v !== 'coupon');
    if (explainer()) explainer().classList.toggle('coupon-mode', v === 'coupon');
    jumpToRate();
  }
  function explainer() { return canvas.closest ? canvas.closest('.bond-explainer') : canvas.parentNode; }

  // ---- chart interaction (coupon mode): add / edit / drag / delete -------
  function nearestPayout(x) {
    var best = -1, bd = 16;
    for (var i = 0; i < s.payouts.length; i++) { var d = Math.abs(xPx(s.payouts[i].t) - x); if (d < bd) { bd = d; best = i; } }
    return best;
  }
  function openPayoutEditor(idx) {
    if (!overlay || !s.payouts[idx]) return;
    var p = s.payouts[idx], vb = bondValueAt(p.t - 1e-4, displayRate);
    overlay.open({
      x: xPx(p.t), y: yPx(vb) - 20, value: Math.round(p.amt), width: 80,
      onCommit: function (v) { if (v == null || v <= 0) s.payouts.splice(idx, 1); else p.amt = v; draw(); },
      onDelete: function () { s.payouts.splice(idx, 1); draw(); }
    });
  }
  function nearestTick(x) {
    var ticks = xTicks(), best = ticks[0], bd = 1e9;
    for (var i = 0; i < ticks.length; i++) { var d = Math.abs(xPx(ticks[i]) - x); if (d < bd) { bd = d; best = ticks[i]; } }
    return best;
  }
  // click an x-axis tick to anchor the timeline to a calendar year (ticks then show real years; small number reverts)
  function openDateEditor(yr) {
    if (!overlay) return;
    var def = (s.startYearCal != null ? s.startYearCal : new Date().getFullYear()) + yr;
    overlay.open({
      x: xPx(yr), y: H - M.b + 14, value: def, width: 72,
      onCommit: function (v) { if (v != null) { s.startYearCal = (v >= 1900) ? (Math.round(v) - yr) : null; } draw(); }
    });
  }
  canvas.addEventListener('pointerdown', function (e) {
    if (!W || !H) return;
    if (overlay && overlay.isOpen()) return;
    var rect = canvas.getBoundingClientRect();
    var x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (x < M.l - 16 || x > W - M.r + 16) return;
    // click the x-axis tick row -> anchor the timeline to a calendar year (works in both views)
    if (y >= H - M.b + 2 && y <= H - M.b + 26) { e.preventDefault(); openDateEditor(nearestTick(x)); return; }
    if (s.view !== 'coupon') return;
    if (y < M.t || y > H - M.b + 6) return;
    var hit = nearestPayout(x);
    if (hit >= 0) { drag = { idx: hit, startX: x, moved: false }; e.preventDefault(); return; }
    e.preventDefault();
    var t = Math.max(0.1, Math.min(s.years, Math.round(pxToYear(x) * 10) / 10));   // land where clicked
    s.payouts.push({ t: t, amt: DEFAULT_PAY });
    draw();
    openPayoutEditor(s.payouts.length - 1);
  });
  window.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var rect = canvas.getBoundingClientRect(), x = e.clientX - rect.left;
    if (!drag.moved && Math.abs(x - drag.startX) < 4) return;
    drag.moved = true;
    if (s.payouts[drag.idx]) { s.payouts[drag.idx].t = Math.max(0.1, Math.min(s.years, Math.round(pxToYear(x) * 10) / 10)); draw(); }
  });
  window.addEventListener('pointerup', function () {
    if (!drag) return;
    if (!drag.moved) openPayoutEditor(drag.idx);
    drag = null; draw();
  });

  // ---- controls ----------------------------------------------------------
  if (rateInput) rateInput.addEventListener('input', function () { setRate(parseFloat(rateInput.value) / 100, false); });
  if (yearsInput) yearsInput.addEventListener('input', function () { s.years = parseInt(yearsInput.value, 10); if (s.view === 'coupon') rebuildStandard(); jumpToRate(); });
  if (curveToggle) curveToggle.addEventListener('change', function () { s.curve = curveToggle.checked ? 'exp' : 'linear'; jumpToRate(); });
  if (faceInput) faceInput.addEventListener('input', function () { s.face = +faceInput.value; rebuildStandard(); jumpToRate(); });
  if (couponInput) couponInput.addEventListener('input', function () { s.coupon = (+couponInput.value) / 100; rebuildStandard(); jumpToRate(); });
  if (rSingle) rSingle.addEventListener('change', function () { if (rSingle.checked) setView('single'); });
  if (rCoupon) rCoupon.addEventListener('change', function () { if (rCoupon.checked) setView('coupon'); });
  if (raiseBtn) raiseBtn.addEventListener('click', function () { setRate(s.rate + 0.02, true); });
  if (cutBtn) cutBtn.addEventListener('click', function () { setRate(s.rate - 0.02, true); });
  if (clearBtn) clearBtn.addEventListener('click', function () { rebuildStandard(); draw(); });
  if (resetBtn) resetBtn.addEventListener('click', function () {
    s.years = DEF.years; s.curve = DEF.curve; s.face = DEF.face; s.coupon = DEF.coupon; s.startYearCal = null; rebuildStandard();
    if (yearsInput) yearsInput.value = DEF.years;
    if (curveToggle) curveToggle.checked = false;
    if (faceInput) faceInput.value = DEF.face;
    if (couponInput) couponInput.value = DEF.coupon * 100;
    setRate(DEF.rate, true);
  });

  // ---- share link + PNG snapshot (shared codec in share-hash.js) ----------
  var SH = window.ShareHash;
  var btnShare = id('bond-share'), btnSnap = id('bond-snap');
  function shareState() {
    var o = {
      m: s.view === 'coupon' ? 1 : 0, r: Math.round(s.rate * 1000) / 10,
      y: s.years, x: s.curve === 'exp' ? 1 : 0,
      f: s.face, cr: Math.round(s.coupon * 1000) / 10
    };
    if (s.view === 'coupon') o.po = s.payouts.map(function (p) { return [Math.round(p.t * 10) / 10, Math.round(p.amt)]; });
    if (s.startYearCal != null) o.c = s.startYearCal;
    return o;
  }
  // Restore a shared bond from the URL hash (untrusted: clamp every field).
  function applyShared() {
    var d = SH.decode(SH.readHash());
    if (!d || d.version !== 1) return false;
    var o = d.obj;
    s.years = SH.int(o.y, 1, 30, DEF.years);
    s.curve = o.x ? 'exp' : 'linear';
    s.face = SH.int(o.f, 100, 10000, DEF.face);
    s.coupon = SH.num(o.cr, 0, 12, DEF.coupon * 100) / 100;
    s.startYearCal = (o.c == null) ? null : SH.int(o.c, 1000, 9999, null);
    s.rate = SH.num(o.r, 0, 12, DEF.rate * 100) / 100;
    var view = o.m ? 'coupon' : 'single';
    if (view === 'coupon') {
      s.payouts = [];
      var pa = SH.arr(o.po, 100);
      for (var i = 0; i < pa.length; i++) {
        var it = pa[i];
        if (!Array.isArray(it)) continue;
        var t = SH.num(it[0], 0.1, s.years, 0), a = SH.num(it[1], 1, 1e7, 0);
        if (t >= 0.1 && a > 0) s.payouts.push({ t: Math.round(t * 10) / 10, amt: a });
      }
      if (!s.payouts.length) rebuildStandard();
    }
    if (yearsInput) yearsInput.value = s.years;
    if (curveToggle) curveToggle.checked = s.curve === 'exp';
    if (faceInput) faceInput.value = s.face;
    if (couponInput) couponInput.value = s.coupon * 100;
    if (rSingle) rSingle.checked = view === 'single';
    if (rCoupon) rCoupon.checked = view === 'coupon';
    displayRate = s.rate;
    setView(view);   // shows/hides the coupon controls and draws
    return true;
  }
  if (btnShare && SH) btnShare.addEventListener('click', function () {
    SH.copyLink(btnShare, SH.encode(1, shareState()));
  });
  if (btnSnap && SH) btnSnap.addEventListener('click', function () {
    jumpToRate();   // settle any rate animation and force a fresh render
    SH.savePng(canvas, {
      label: 'Bond pricing', file: 'bond-pricing.png',
      light: effectiveTheme() === 'light'
    });
  });

  // ---- theme + resize ----------------------------------------------------
  var mo = new MutationObserver(function () { draw(); });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (window.matchMedia) { try { window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', draw); } catch (e) {} }
  var rt;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { resize(); draw(); }, 120); });

  // ---- init --------------------------------------------------------------
  rebuildStandard();
  resize();
  if (!(SH && applyShared())) draw();   // a shared bond in the URL replaces the defaults
})();
