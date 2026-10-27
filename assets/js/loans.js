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
  var drag = null;              // {idx, startX, moved, maxMonth} while dragging a placed payment
  var notice = null, noticeT;   // transient on-canvas message {text, x, y, until}
  function showNotice(text, x, y) {
    notice = { text: text, x: x, y: y, until: Date.now() + 2400 };
    update();
    clearTimeout(noticeT);
    noticeT = setTimeout(function () { notice = null; update(); }, 2450);
  }
  s.startYearCal = null;        // calendar year for year 0 (null = show "years from today")
  function tickLabel(yr) { return s.startYearCal != null ? num(s.startYearCal + yr) : num(yr); }

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
  // Numbers follow the visitor's locale through Intl ("$30,000" and "6.0%" in
  // en-US, "30.000 $" and "6,0 %" in de-DE); the amounts stay in US dollars.
  /* Digits stay Latin (0-9) in these English sentences whatever the visitor's numbering
     system (ar-SA would print Arabic-Indic digits, bn-BD Bengali ones); the visitor's
     separators stay. Right-to-left languages take en-US outright: their Latin-digit forms
     still carry hidden direction marks, "US$" and an Arabic percent sign. */
  var NUM_LOC = (function () {
    try {
      var l = new Intl.NumberFormat().resolvedOptions().locale;
      if (/^(ar|fa|ur|he|iw|yi|ps|sd|ug|ckb|dv|ks|syr)(-|$)/i.test(l)) return 'en-US';
      return l.replace(/-u-.*$/i, '') + '-u-nu-latn';
    } catch (e) { return undefined; }
  })();
  function nf(o) { try { return new Intl.NumberFormat(NUM_LOC, o); } catch (e) { return null; } }
  var NF_USD0 = nf({ style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  var NF_USD1 = nf({ style: 'currency', currency: 'USD', minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var NF_PCT1 = nf({ style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var NF_INT = nf({ maximumFractionDigits: 0, useGrouping: false });     // years, counts
  var NF_DEC1 = nf({ minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false });
  // Arabic-Indic digits (ar-SA) or a right-to-left mark (he, ar currency) inside an
  // English sentence get reordered by the bidi algorithm ("1200×800" shows as
  // "800×1200"): such a number is wrapped in a left-to-right isolate.
  function iso(t) { return /[\u0600-\u06FF\u200F\u061C]/.test(t) ? '\u2066' + t + '\u2069' : t; }
  function num(v) { return iso(NF_INT ? NF_INT.format(v) : String(v)); }
  function dec1(v) { return iso(NF_DEC1 ? NF_DEC1.format(+v.toFixed(1)) : v.toFixed(1)); }   // toFixed's rounding, Intl's marks
  function pct(p) { var r = +p.toFixed(1); return iso(NF_PCT1 ? NF_PCT1.format(r / 100) : r.toFixed(1) + '%'); }   // p in percent
  function usd(n) {
    var v = Math.round(n); if (v === 0) v = 0;                            // no "-$0"
    return iso(NF_USD0 ? NF_USD0.format(v) : '$' + v.toLocaleString('en-US'));
  }
  function usdK(n) {
    if (n >= 1000) {
      var k = n / 1000, f = k % 1 === 0 ? NF_USD0 : NF_USD1;
      if (k % 1 !== 0) k = +k.toFixed(1);                                 // toFixed's rounding, as before
      if (!f || !f.formatToParts) return '$' + (k % 1 === 0 ? k : k.toFixed(1)) + 'k';
      // "$7.5k" / "7,5k $": the k goes right after the number, wherever the locale puts the $
      var parts = f.formatToParts(k), out = '', last = -1, i;
      for (i = 0; i < parts.length; i++) if (/^(integer|group|decimal|fraction)$/.test(parts[i].type)) last = i;
      for (i = 0; i < parts.length; i++) out += parts[i].value + (i === last ? 'k' : '');
      return iso(out);
    }
    return usd(n);
  }
  function dur(months) {
    var y = Math.floor(months / 12), mo = months % 12;
    if (y && mo) return num(y) + ' yr ' + num(mo) + ' mo';
    if (y) return num(y) + ' yr';
    return num(mo) + ' mo';
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

    // the left margin grows to fit the widest dollar label ("33,8k US$" in some
    // locales); en-US labels fit the 58 px default
    var lw = 0;
    for (var j = 0; j <= 4; j++) lw = Math.max(lw, ctx.measureText(usdK((s.principal / 4) * j)).width);
    M.l = Math.max(58, Math.ceil(lw) + 14);
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

    // one-time payment markers (placed by clicking). Dragging can no longer
    // strand one past payoff, but a slider change (e.g. raising the extra
    // payment) still can: those are greyed and tagged so the chart never shows
    // an accent marker the numbers ignore.
    for (var li = 0; li < s.lumps.length; li++) {
      var lx = xPx(s.lumps[li].month / 12);
      var inert = s.lumps[li].month >= payoffWithout(li);
      ctx.strokeStyle = inert ? c.grid : c.guide; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(lx, M.t); ctx.lineTo(lx, H - M.b); ctx.stroke();
      ctx.setLineDash([]);
      // downward triangle at top
      ctx.fillStyle = inert ? c.muted : c.accent;
      ctx.beginPath(); ctx.moveTo(lx - 5, M.t - 9); ctx.lineTo(lx + 5, M.t - 9); ctx.lineTo(lx, M.t - 1); ctx.closePath(); ctx.fill();
      // amount label in the top margin
      ctx.fillStyle = inert ? c.muted : c.text; ctx.font = '600 11px "Source Sans 3", system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(usdK(s.lumps[li].amount) + (inert ? ' (no effect)' : ''), lx, 10);
      ctx.font = '12px "Source Sans 3", system-ui, sans-serif';
    }

    // live time tooltip while dragging a payment
    if (drag && drag.moved && s.lumps[drag.idx]) {
      var dm = s.lumps[drag.idx].month, dlx = xPx(dm / 12);
      ctx.fillStyle = c.text; ctx.font = '600 11px "Source Sans 3", system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(s.startYearCal != null ? ('~' + dec1(s.startYearCal + dm / 12)) : ('Year ' + dec1(dm / 12)), dlx, 26);
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

    // Legend. It used to sit at the top LEFT, which is exactly where both balance
    // lines start, so the swatches and text were drawn on top of the data. Both
    // lines fall left to right, so the top RIGHT of the plot is the empty corner:
    // right-align the block against the plot's right edge.
    ctx.font = '12px "Source Sans 3", system-ui, sans-serif'; ctx.textBaseline = 'middle';
    var lg = ['Standard payments', 'With extra payments'];
    var lgW = Math.max(ctx.measureText(lg[0]).width, ctx.measureText(lg[1]).width);
    // gy2 sits far enough below M.t that the live "Year 9.0" drag tooltip (drawn
    // at y=26 while a payment is dragged near the right edge) cannot touch it.
    var gx2 = Math.max(M.l + 10, (W - M.r) - 6 - lgW - 28), gy2 = M.t + 18;
    ctx.strokeStyle = c.baseline; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(gx2, gy2); ctx.lineTo(gx2 + 22, gy2); ctx.stroke();
    ctx.fillStyle = c.muted; ctx.textAlign = 'left'; ctx.fillText(lg[0], gx2 + 28, gy2);
    ctx.strokeStyle = c.accent; ctx.lineWidth = 2.6;
    ctx.beginPath(); ctx.moveTo(gx2, gy2 + 18); ctx.lineTo(gx2 + 22, gy2 + 18); ctx.stroke();
    ctx.fillStyle = c.text; ctx.fillText(lg[1], gx2 + 28, gy2 + 18);

    // transient notice (e.g. a click past the payoff point), drawn last so it
    // sits on top; cleared by a timeout in showNotice
    if (notice && Date.now() < notice.until) {
      ctx.font = '600 12px "Source Sans 3", system-ui, sans-serif';
      var ntw = ctx.measureText(notice.text).width;
      var nx = Math.max(M.l + ntw / 2 + 8, Math.min(W - M.r - ntw / 2 - 8, notice.x));
      var ny = Math.max(M.t + 26, Math.min(H - M.b - 16, notice.y));
      ctx.globalAlpha = 0.93; ctx.fillStyle = c.panel;
      ctx.fillRect(nx - ntw / 2 - 7, ny - 12, ntw + 14, 24);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = c.axis; ctx.lineWidth = 1;
      ctx.strokeRect(nx - ntw / 2 - 7, ny - 12, ntw + 14, 24);
      ctx.fillStyle = c.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(notice.text, nx, ny);
    }
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
    if (roSavedInt) roSavedInt.textContent = usd(hasExtra() ? savedInt : 0);
    if (roSavedTime) roSavedTime.textContent = hasExtra() && savedMonths > 0 ? '(' + dur(savedMonths) + ' sooner)' : '';

    if (roTiming) {
      if (!hasExtra()) {
        roTiming.textContent = 'Add an extra monthly payment, or click the chart to drop a one-time payment, to see how much interest you would save.';
      } else if (s.extra > 0 && startMonth > 0) {
        var deltaInt = scn.totalInterest - now.totalInterest;   // extra interest from delaying the recurring payments
        var deltaMonths = scn.payoffMonths - now.payoffMonths;
        roTiming.textContent = 'Waiting until year ' + num(s.startYear) + ' to start the recurring extra payments costs about '
          + usd(deltaInt) + ' more interest and finishes ' + dur(Math.max(0, deltaMonths)) + ' later than starting now.';
      } else {
        roTiming.textContent = 'Earlier payments save more: the same dollars erase more interest the sooner they land, so try placing a one-time payment earlier on the timeline.';
      }
    }
  }

  // ---- chart click: place / remove one-time payments ---------------------
  function openLumpEditor(idx, isNew) {
    if (!overlay || !s.lumps[idx]) return;
    overlay.open({
      x: xPx(s.lumps[idx].month / 12), y: 10, value: Math.round(s.lumps[idx].amount), width: 80,
      onCommit: function (v) {
        if (v == null || v <= 0) s.lumps.splice(idx, 1);   // 0/blank removes it
        else s.lumps[idx].amount = v;
        update();
      },
      onDelete: function () { s.lumps.splice(idx, 1); update(); },
      // Escape on a JUST-ADDED payment removes it again (a misclick should not
      // leave a stray $1k payment behind); editing an existing one keeps it.
      onCancel: isNew ? function () { s.lumps.splice(idx, 1); update(); } : null
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
  // A payment does something only if it lands before the month the loan pays
  // off WITHOUT it (at or past that month the balance is already $0). This is
  // the exact test: the scenario payoff moves with the payment, so testing
  // against it mislabels a payment that itself finishes the loan.
  function payoffWithout(idx) {
    var others = s.lumps.filter(function (l, i) { return i !== idx; });
    return simulate(s.extra, Math.round(s.startYear * 12), others).payoffMonths;
  }
  // last month a dragged payment can land on and still count
  function dragMaxMonth(idx) { return Math.max(1, payoffWithout(idx) - 1); }

  // On a touch screen the browser decides only AFTER pointerdown whether a finger
  // is a tap or a page scroll (touch-action pan-y). Acting on pointerdown would
  // add a payment (and open its editor) under every scroll that starts on the
  // chart, so a touch tap is held until pointerup and dropped if the browser
  // cancels the pointer for a scroll or the finger travels more than a few px.
  // A mouse click still acts at once.
  var tap = null;
  function onTap(e, run) {
    e.preventDefault();                                 // no compat mousedown to blur the editor
    if (e.pointerType && e.pointerType !== 'mouse') { tap = { id: e.pointerId, cx: e.clientX, cy: e.clientY, run: run }; return; }
    run();
  }
  canvas.addEventListener('pointerdown', function (e) {
    tap = null;
    if (!W || !H) return;
    if (overlay && overlay.isOpen()) return;            // a click-away commits the open editor
    var rect = canvas.getBoundingClientRect();
    var x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (x < M.l - 14 || x > W - M.r + 14) return;
    // click the x-axis tick row -> set a start date (ticks become calendar years)
    if (y >= H - M.b + 2 && y <= H - M.b + 26) { onTap(e, function () { openDateEditor(nearestTick(x)); }); return; }
    // click near an existing payment -> begin a drag (a click without dragging edits its amount)
    for (var k = 0; k < s.lumps.length; k++) {
      if (Math.abs(xPx(s.lumps[k].month / 12) - x) < 14) { drag = { idx: k, startX: x, moved: false, maxMonth: dragMaxMonth(k) }; e.preventDefault(); return; }
    }
    if (y < M.t - 12 || y > H - M.b + 4) return;
    onTap(e, function () {
      var month = clampMonth(pxToMonth(x));
      // a payment past the payoff point does nothing: say so instead of silently ignoring the click
      if (month >= simulate(s.extra, Math.round(s.startYear * 12), s.lumps).payoffMonths) {
        showNotice('The loan is already paid off by then.', x, y);
        return;
      }
      s.lumps.push({ month: month, amount: DEFAULT_LUMP });
      update();
      openLumpEditor(s.lumps.length - 1, true);         // immediately type the amount (Esc removes it again)
    });
  });
  window.addEventListener('pointermove', function (e) {
    if (tap && e.pointerId === tap.id && (Math.abs(e.clientX - tap.cx) > 8 || Math.abs(e.clientY - tap.cy) > 8)) tap = null;
    if (!drag) return;
    var rect = canvas.getBoundingClientRect(), x = e.clientX - rect.left;
    if (!drag.moved && Math.abs(x - drag.startX) < 4) return;   // tiny move = still a click
    drag.moved = true;
    if (s.lumps[drag.idx]) {
      var m = clampMonth(pxToMonth(x));
      // the drag stops at payoff: a payment can't land after the loan is gone,
      // so the chart never shows a marker the numbers ignore
      if (m > drag.maxMonth) {
        m = drag.maxMonth;
        // drawn below the legend block so the two never overlap mid-drag
        showNotice('The loan is paid off by then, so it stops here.', xPx(m / 12), M.t + 88);
      }
      s.lumps[drag.idx].month = m;
      update();
    }
  });
  window.addEventListener('pointerup', function (e) {
    if (tap) { var t = tap; tap = null; if (e.pointerId === t.id) t.run(); }
    if (!drag) return;
    if (!drag.moved) openLumpEditor(drag.idx);          // it was a click, not a drag -> edit amount
    drag = null; update();
  });
  // a vertical swipe that started on the chart becomes a page scroll (touch-action
  // pan-y): the browser cancels the pointer, so drop the held tap and any half-started drag
  window.addEventListener('pointercancel', function () { tap = null; if (drag) { drag = null; update(); } });

  // ---- controls ----------------------------------------------------------
  function syncStartMax() {
    if (!elS) return;
    elS.max = s.years;
    if (s.startYear > s.years) { s.startYear = s.years; elS.value = s.years; }
  }
  function labels() {
    if (elPv) elPv.textContent = usd(s.principal);
    if (elRv) elRv.textContent = pct(s.apr * 100);
    if (elYv) elYv.textContent = num(s.years);
    if (elEv) elEv.textContent = usd(s.extra) + '/mo';
    if (elSv) elSv.textContent = s.startYear === 0 ? 'now' : 'year ' + num(s.startYear);
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

  // ---- share link + PNG snapshot (shared codec in share-hash.js) ----------
  var SH = window.ShareHash;
  var btnShare = id('loan-share'), btnSnap = id('loan-snap');
  function shareState() {
    var o = {
      p: s.principal, r: Math.round(s.apr * 1000) / 10, y: s.years,
      e: s.extra, sy: s.startYear,
      l: s.lumps.map(function (l) { return [l.month, Math.round(l.amount)]; })
    };
    if (s.startYearCal != null) o.c = s.startYearCal;
    return o;
  }
  // Restore a shared scenario from the URL hash. The hash is untrusted input:
  // every field is clamped to the slider ranges / sane bounds.
  function applyShared() {
    var d = SH.decode(SH.readHash());
    if (!d || d.version !== 1) return false;
    var o = d.obj;
    s.principal = SH.int(o.p, 1000, 100000, DEF.principal);
    s.apr = SH.num(o.r, 0, 12, DEF.apr * 100) / 100;
    s.years = SH.int(o.y, 2, 30, DEF.years);
    s.extra = SH.int(o.e, 0, 1000, DEF.extra);
    s.startYear = SH.int(o.sy, 0, s.years, DEF.startYear);
    s.startYearCal = (o.c == null) ? null : SH.int(o.c, 1000, 9999, null);
    s.lumps = [];
    var la = SH.arr(o.l, 120);
    for (var i = 0; i < la.length; i++) {
      var it = la[i];
      if (!Array.isArray(it)) continue;
      var m = SH.int(it[0], 1, s.years * 12, 0), a = SH.num(it[1], 1, 1e7, 0);
      if (m >= 1 && a > 0) s.lumps.push({ month: m, amount: a });
    }
    if (elP) elP.value = s.principal;
    if (elR) elR.value = s.apr * 100;
    if (elY) elY.value = s.years;
    if (elE) elE.value = s.extra;
    syncStartMax();
    if (elS) elS.value = s.startYear;
    return true;
  }
  if (btnShare && SH) btnShare.addEventListener('click', function () {
    SH.copyLink(btnShare, SH.encode(1, shareState()));
  });
  if (btnSnap && SH) btnSnap.addEventListener('click', function () {
    update();   // this chart renders on demand: force a fresh frame first
    SH.savePng(canvas, {
      label: 'Loan payoff', file: 'loan-payoff.png',
      light: effectiveTheme() === 'light'
    });
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
  if (SH) applyShared();   // a shared scenario in the URL replaces the defaults
  refresh();
})();
