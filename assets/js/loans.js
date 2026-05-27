/* ==========================================================================
   Loan amortization explainer — interest vs principal, and extra payments
   --------------------------------------------------------------------------
   A loan (e.g. a student loan) of `principal` at annual rate `apr`, repaid in
   fixed monthly payments over `years`. Each month: interest = balance * apr/12,
   the rest of the payment chips at principal. Early on a payment is mostly
   interest; only later does it mostly reduce principal.

   Extra payments come in two flavours, which combine:
     - a recurring extra $/month, optionally starting after some year, and
     - one-time lump payments the visitor PLACES on the timeline by clicking the
       chart (click again on a marker to remove it).
   Earlier extra dollars kill more interest than the same dollars paid later.

   Reserved palette rule: red = cost/loss, so INTEREST is red, PRINCIPAL is the
   accent blue. Theme-aware; responsive (DPR-capped); no paid data needed.
   ========================================================================== */
(function () {
  var canvas = document.getElementById('loan-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  function id(x) { return document.getElementById(x); }

  // sliders + their value labels
  var elP = id('loan-principal'), elPv = id('loan-principal-val');
  var elR = id('loan-rate'),      elRv = id('loan-rate-val');
  var elY = id('loan-years'),     elYv = id('loan-years-val');
  var elE = id('loan-extra'),     elEv = id('loan-extra-val');
  var elS = id('loan-start'),     elSv = id('loan-start-val');
  var elL = id('loan-lump'),      elLv = id('loan-lump-val');
  // buttons
  var btnNow = id('loan-now'), btnLater = id('loan-later'), btnClear = id('loan-clear'), btnReset = id('loan-reset');
  // readouts
  var roPayment = id('loan-payment'), roSavedInt = id('loan-saved-interest'),
      roSavedTime = id('loan-saved-time'), roTiming = id('loan-timing');
  // principal/interest comparison bars
  var barBase = id('bar-base'), barBaseP = id('bar-base-p'), barBaseI = id('bar-base-i'), barBaseT = id('bar-base-total');
  var barExtra = id('bar-extra'), barExtraP = id('bar-extra-p'), barExtraI = id('bar-extra-i'), barExtraT = id('bar-extra-total');

  var DEF = { principal: 30000, apr: 0.06, years: 10, extra: 100, startYear: 0, lumpAmount: 1000 };
  var s = { principal: DEF.principal, apr: DEF.apr, years: DEF.years, extra: DEF.extra,
            startYear: DEF.startYear, lumpAmount: DEF.lumpAmount, lumps: [] };
  var DEFAULT_LUMP = 1000;
  var overlay = window.makeNumberOverlay ? window.makeNumberOverlay(canvas) : null;
  var drag = null;              // {idx, startX, moved} while dragging a placed payment
  s.startYearCal = null;        // calendar year for year 0 (null = show "years from today")
  function tickLabel(yr) { return s.startYearCal != null ? String(s.startYearCal + yr) : String(yr); }

  function effectiveTheme() {
    var f = document.documentElement.getAttribute('data-theme');
    if (f === 'light' || f === 'dark') return f;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }
  function palette() {
    var light = effectiveTheme() === 'light';
    return {
      text:      light ? '#262626' : '#d6d6d6',
      muted:     light ? '#737373' : '#9a9a9a',
      grid:      light ? 'rgba(0,0,0,0.09)'  : 'rgba(255,255,255,0.09)',
      axis:      light ? 'rgba(0,0,0,0.40)'  : 'rgba(255,255,255,0.38)',
      accent:    light ? '#34568a' : '#82a6cc',   // principal / "with extra" line / lump markers
      baseline:  light ? '#8a8a8a' : '#8f8f8f',   // standard-payment balance line
      accentFill:light ? 'rgba(52,86,138,0.10)' : 'rgba(130,166,204,0.12)',
      guide:     light ? 'rgba(52,86,138,0.40)' : 'rgba(130,166,204,0.45)',
      panel:     light ? '#ffffff' : '#141414'
    };
  }

  // ---- amortization ------------------------------------------------------
  function basePayment() {
    var i = s.apr / 12, n = s.years * 12;
    if (i <= 0) return s.principal / n;
    return s.principal * i / (1 - Math.pow(1 + i, -n));
  }

  // Simulate month-by-month. Adds the recurring `extra` once month >= startMonth,
  // plus any one-time `lumps` ({month, amount}) scheduled for that month.
  function simulate(extra, startMonth, lumps) {
    var i = s.apr / 12, n = s.years * 12, M = basePayment();
    var bal = s.principal, totInt = 0, series = [bal], m = 0;
    while (bal > 0.005 && m < n) {
      m++;
      var pay = M + (m >= startMonth ? extra : 0);
      if (lumps) for (var k = 0; k < lumps.length; k++) if (lumps[k].month === m) pay += lumps[k].amount;
      var interest = bal * i;
      var princ = pay - interest;
      totInt += interest;
      if (princ >= bal) { bal = 0; } else { bal -= princ; }
      series.push(bal);
    }
    return { series: series, totalInterest: totInt, payoffMonths: m, payment: M };
  }

  // ---- formatting --------------------------------------------------------
  function usd(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function usdK(n) {
    if (n >= 1000) { var k = n / 1000; return '$' + (k % 1 === 0 ? k : k.toFixed(1)) + 'k'; }
    return '$' + Math.round(n);
  }
  function dur(months) {
    var y = Math.floor(months / 12), mo = months % 12;
    if (y && mo) return y + ' yr ' + mo + ' mo';
    if (y) return y + ' yr';
    return mo + ' mo';
  }

  // ---- geometry / chart --------------------------------------------------
  var W = 0, H = 0, M = { l: 58, r: 18, t: 26, b: 40 };
  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function xPx(yr)  { return M.l + (yr / s.years) * (W - M.l - M.r); }
  function yPx(bal) { var yMax = s.principal * 1.04; return (H - M.b) - (bal / yMax) * (H - M.b - M.t); }
  function pxToMonth(px) {
    var yr = ((px - M.l) / (W - M.l - M.r)) * s.years;
    return Math.round(yr * 12);
  }

  function xTicks() {
    var y = s.years, step = y <= 6 ? 1 : (y <= 12 ? 2 : 5), t = [], k;
    for (k = 0; k < y; k += step) t.push(k);
    t.push(y);
    return t;
  }

  function lineFor(series, color, width, fill) {
    ctx.beginPath();
    var k;
    for (k = 0; k < series.length; k++) {
      var x = xPx(k / 12), y = yPx(series[k]);
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    if (fill) {
      ctx.lineTo(xPx((series.length - 1) / 12), H - M.b);
      ctx.lineTo(xPx(0), H - M.b);
      ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();
      ctx.beginPath();
      for (k = 0; k < series.length; k++) {
        var xx = xPx(k / 12), yy = yPx(series[k]);
        if (k === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
      }
    }
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round';
    ctx.stroke();
  }

  function drawChart(base, scn) {
    if (!W || !H) resize();
    if (!W || !H) return;
    var c = palette();
    ctx.clearRect(0, 0, W, H);
    ctx.font = '12px "Source Sans 3", system-ui, sans-serif';

    // horizontal $ gridlines
    ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    for (var i = 0; i <= 4; i++) {
      var dollars = (s.principal / 4) * i, gy = yPx(dollars);
      ctx.strokeStyle = c.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(M.l, gy); ctx.lineTo(W - M.r, gy); ctx.stroke();
      ctx.fillStyle = c.muted; ctx.fillText(usdK(dollars), M.l - 8, gy);
    }
    // vertical year gridlines
    ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    var ticks = xTicks();
    for (var t = 0; t < ticks.length; t++) {
      var gx = xPx(ticks[t]);
      ctx.strokeStyle = c.grid; ctx.beginPath(); ctx.moveTo(gx, M.t); ctx.lineTo(gx, H - M.b); ctx.stroke();
      ctx.fillStyle = c.muted; ctx.fillText(tickLabel(ticks[t]), gx, H - M.b + 7);
    }
    // axes
    ctx.strokeStyle = c.axis; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(M.l, M.t); ctx.lineTo(M.l, H - M.b); ctx.lineTo(W - M.r, H - M.b); ctx.stroke();
    ctx.fillStyle = c.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(s.startYearCal != null ? 'Year' : 'Years from today', (M.l + (W - M.r)) / 2, H - 6);

    // balance lines
    lineFor(base.series, c.baseline, 2, null);
    lineFor(scn.series, c.accent, 2.6, c.accentFill);

    // one-time payment markers (placed by clicking)
    for (var li = 0; li < s.lumps.length; li++) {
      var lx = xPx(s.lumps[li].month / 12);
      ctx.strokeStyle = c.guide; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(lx, M.t); ctx.lineTo(lx, H - M.b); ctx.stroke();
      ctx.setLineDash([]);
      // downward triangle at top
      ctx.fillStyle = c.accent;
      ctx.beginPath(); ctx.moveTo(lx - 5, M.t - 9); ctx.lineTo(lx + 5, M.t - 9); ctx.lineTo(lx, M.t - 1); ctx.closePath(); ctx.fill();
      // amount label in the top margin
      ctx.fillStyle = c.text; ctx.font = '600 11px "Source Sans 3", system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(usdK(s.lumps[li].amount), lx, 10);
      ctx.font = '12px "Source Sans 3", system-ui, sans-serif';
    }

    // live time tooltip while dragging a payment
    if (drag && drag.moved && s.lumps[drag.idx]) {
      var dm = s.lumps[drag.idx].month, dlx = xPx(dm / 12);
      ctx.fillStyle = c.text; ctx.font = '600 11px "Source Sans 3", system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(s.startYearCal != null ? ('~' + (s.startYearCal + dm / 12).toFixed(1)) : ('Year ' + (dm / 12).toFixed(1)), dlx, 26);
    }

    // payoff marker for the scenario
    if (scn.payoffMonths < base.payoffMonths) {
      var px = xPx(scn.payoffMonths / 12), py = yPx(0);
      ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fillStyle = c.panel; ctx.fill();
      ctx.beginPath(); ctx.arc(px, py, 4.5, 0, Math.PI * 2); ctx.fillStyle = c.accent; ctx.fill();
      ctx.fillStyle = c.text; ctx.font = '600 12px "Source Sans 3", system-ui, sans-serif';
      ctx.textAlign = px > W - 120 ? 'right' : 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText('Paid off: ' + dur(scn.payoffMonths), px + (px > W - 120 ? -8 : 8), py - 8);
    }

    // legend
    ctx.font = '12px "Source Sans 3", system-ui, sans-serif'; ctx.textBaseline = 'middle';
    var gx2 = M.l + 10, gy2 = M.t + 8;
    ctx.strokeStyle = c.baseline; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(gx2, gy2); ctx.lineTo(gx2 + 22, gy2); ctx.stroke();
    ctx.fillStyle = c.muted; ctx.textAlign = 'left'; ctx.fillText('Standard payments', gx2 + 28, gy2);
    ctx.strokeStyle = c.accent; ctx.lineWidth = 2.6;
    ctx.beginPath(); ctx.moveTo(gx2, gy2 + 18); ctx.lineTo(gx2 + 22, gy2 + 18); ctx.stroke();
    ctx.fillStyle = c.text; ctx.fillText('With extra payments', gx2 + 28, gy2 + 18);
  }

  // ---- principal/interest comparison bars (HTML) -------------------------
  function setBar(wrap, pSeg, iSeg, tSeg, principal, interest, maxTotal) {
    var total = principal + interest;
    wrap.style.width = (maxTotal > 0 ? (total / maxTotal) * 100 : 0) + '%';
    pSeg.style.width = (total > 0 ? (principal / total) * 100 : 0) + '%';
    iSeg.style.width = (total > 0 ? (interest / total) * 100 : 0) + '%';
    tSeg.textContent = usd(total);
  }

  function hasExtra() { return s.extra > 0 || s.lumps.length > 0; }

  // ---- update ------------------------------------------------------------
  function update() {
    var startMonth = Math.round(s.startYear * 12);
    var base = simulate(0, 0, []);
    var scn  = simulate(s.extra, startMonth, s.lumps);
    var now  = simulate(s.extra, 0, s.lumps);   // same payments, recurring started now

    drawChart(base, scn);

    var maxTotal = s.principal + base.totalInterest;   // baseline is always the longest bar
    setBar(barBase, barBaseP, barBaseI, barBaseT, s.principal, base.totalInterest, maxTotal);
    setBar(barExtra, barExtraP, barExtraI, barExtraT, s.principal, scn.totalInterest, maxTotal);

    if (roPayment) roPayment.textContent = usd(base.payment) + '/mo';
    var savedInt = base.totalInterest - scn.totalInterest;
    var savedMonths = base.payoffMonths - scn.payoffMonths;
    if (roSavedInt) roSavedInt.textContent = hasExtra() ? usd(savedInt) : '$0';
    if (roSavedTime) roSavedTime.textContent = hasExtra() && savedMonths > 0 ? '(' + dur(savedMonths) + ' sooner)' : '';

    if (roTiming) {
      if (!hasExtra()) {
        roTiming.textContent = 'Add an extra monthly payment, or click the chart to drop a one-time payment, to see how much interest you would save.';
      } else if (s.extra > 0 && startMonth > 0) {
        var deltaInt = scn.totalInterest - now.totalInterest;   // extra interest from delaying the recurring payments
        var deltaMonths = scn.payoffMonths - now.payoffMonths;
        roTiming.textContent = 'Waiting until year ' + s.startYear + ' to start the recurring extra payments costs about '
          + usd(deltaInt) + ' more interest and finishes ' + dur(Math.max(0, deltaMonths)) + ' later than starting now.';
      } else {
        roTiming.textContent = 'Earlier payments save more: the same dollars erase more interest the sooner they land — try placing a one-time payment earlier on the timeline.';
      }
    }
  }

  // ---- chart click: place / remove one-time payments ---------------------
  function openLumpEditor(idx) {
    if (!overlay || !s.lumps[idx]) return;
    overlay.open({
      x: xPx(s.lumps[idx].month / 12), y: 10, value: Math.round(s.lumps[idx].amount), width: 80,
      onCommit: function (v) {
        if (v == null || v <= 0) s.lumps.splice(idx, 1);   // 0/blank removes it
        else s.lumps[idx].amount = v;
        update();
      },
      onDelete: function () { s.lumps.splice(idx, 1); update(); }
    });
  }
  // Click an x-axis tick to anchor the timeline to a calendar year; ticks then
  // show real years. Enter a 4-digit year; enter a small number to revert.
  function openDateEditor(yr) {
    if (!overlay) return;
    var def = (s.startYearCal != null ? s.startYearCal : new Date().getFullYear()) + yr;
    overlay.open({
      x: xPx(yr), y: H - M.b + 14, value: def, width: 72,
      onCommit: function (v) {
        if (v != null) { s.startYearCal = (v >= 1900) ? (Math.round(v) - yr) : null; }
        update();
      }
    });
  }
  function nearestTick(x) {
    var ticks = xTicks(), best = ticks[0], bd = 1e9;
    for (var i = 0; i < ticks.length; i++) { var d = Math.abs(xPx(ticks[i]) - x); if (d < bd) { bd = d; best = ticks[i]; } }
    return best;
  }
  function clampMonth(m) { return Math.max(1, Math.min(s.years * 12, m)); }

  canvas.addEventListener('pointerdown', function (e) {
    if (!W || !H) return;
    if (overlay && overlay.isOpen()) return;            // a click-away commits the open editor
    var rect = canvas.getBoundingClientRect();
    var x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (x < M.l - 14 || x > W - M.r + 14) return;
    // click the x-axis tick row -> set a start date (ticks become calendar years)
    if (y >= H - M.b + 2 && y <= H - M.b + 26) { e.preventDefault(); openDateEditor(nearestTick(x)); return; }
    // click near an existing payment -> begin a drag (a click without dragging edits its amount)
    for (var k = 0; k < s.lumps.length; k++) {
      if (Math.abs(xPx(s.lumps[k].month / 12) - x) < 14) { drag = { idx: k, startX: x, moved: false }; e.preventDefault(); return; }
    }
    if (y < M.t - 12 || y > H - M.b + 4) return;
    var month = clampMonth(pxToMonth(x));
    // ignore clicks past the point the loan is already paid off — a payment then does nothing
    if (month >= simulate(s.extra, Math.round(s.startYear * 12), s.lumps).payoffMonths) return;
    e.preventDefault();
    s.lumps.push({ month: month, amount: DEFAULT_LUMP });
    update();
    openLumpEditor(s.lumps.length - 1);                 // immediately type the amount
  });
  window.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var rect = canvas.getBoundingClientRect(), x = e.clientX - rect.left;
    if (!drag.moved && Math.abs(x - drag.startX) < 4) return;   // tiny move = still a click
    drag.moved = true;
    if (s.lumps[drag.idx]) { s.lumps[drag.idx].month = clampMonth(pxToMonth(x)); update(); }
  });
  window.addEventListener('pointerup', function () {
    if (!drag) return;
    if (!drag.moved) openLumpEditor(drag.idx);          // it was a click, not a drag -> edit amount
    drag = null; update();
  });

  // ---- controls ----------------------------------------------------------
  function syncStartMax() {
    if (!elS) return;
    elS.max = s.years;
    if (s.startYear > s.years) { s.startYear = s.years; elS.value = s.years; }
  }
  function labels() {
    if (elPv) elPv.textContent = usd(s.principal);
    if (elRv) elRv.textContent = (s.apr * 100).toFixed(1) + '%';
    if (elYv) elYv.textContent = s.years;
    if (elEv) elEv.textContent = usd(s.extra) + '/mo';
    if (elSv) elSv.textContent = s.startYear === 0 ? 'now' : 'year ' + s.startYear;
    if (elLv) elLv.textContent = usd(s.lumpAmount);
  }
  function refresh() { labels(); update(); }

  if (elP) elP.addEventListener('input', function () { s.principal = +elP.value; refresh(); });
  if (elR) elR.addEventListener('input', function () { s.apr = (+elR.value) / 100; refresh(); });
  if (elY) elY.addEventListener('input', function () {
    s.years = +elY.value;
    s.lumps = s.lumps.filter(function (l) { return l.month <= s.years * 12; });  // drop lumps past the new term
    syncStartMax(); refresh();
  });
  if (elE) elE.addEventListener('input', function () { s.extra = +elE.value; refresh(); });
  if (elS) elS.addEventListener('input', function () { s.startYear = +elS.value; refresh(); });
  if (elL) elL.addEventListener('input', function () { s.lumpAmount = +elL.value; labels(); });

  if (btnNow) btnNow.addEventListener('click', function () {
    if (s.extra <= 0) { s.extra = 100; if (elE) elE.value = 100; }
    s.startYear = 0; if (elS) elS.value = 0; refresh();
  });
  if (btnLater) btnLater.addEventListener('click', function () {
    if (s.extra <= 0) { s.extra = 100; if (elE) elE.value = 100; }
    s.startYear = Math.min(5, s.years); if (elS) elS.value = s.startYear; refresh();
  });
  if (btnClear) btnClear.addEventListener('click', function () { s.lumps = []; update(); });
  if (btnReset) btnReset.addEventListener('click', function () {
    s.principal = DEF.principal; s.apr = DEF.apr; s.years = DEF.years; s.extra = DEF.extra;
    s.startYear = DEF.startYear; s.lumpAmount = DEF.lumpAmount; s.lumps = []; s.startYearCal = null;
    if (elP) elP.value = DEF.principal;
    if (elR) elR.value = DEF.apr * 100;
    if (elY) elY.value = DEF.years;
    if (elE) elE.value = DEF.extra;
    if (elL) elL.value = DEF.lumpAmount;
    syncStartMax();
    if (elS) elS.value = DEF.startYear;
    refresh();
  });

  // ---- theme + resize ----------------------------------------------------
  var mo = new MutationObserver(update);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (window.matchMedia) {
    try { window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', update); } catch (e) {}
  }
  var rt;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { resize(); update(); }, 120); });

  // ---- init --------------------------------------------------------------
  syncStartMax();
  resize();
  refresh();
})();
