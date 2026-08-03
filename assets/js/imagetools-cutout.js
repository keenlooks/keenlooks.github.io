/* ==========================================================================
   imagetools-cutout.js — "Cut out background" for Image Studio.
   --------------------------------------------------------------------------
   One extra mode inside /imagetools/: an automatic first cut, then the user
   brushes Keep / Remove and the mask re-optimizes. Everything runs locally.

   Structure:
     1. PURE  — plain-array maths with no DOM: stroke -> prompt sampling,
                bilinear upsample, threshold, box filter, guided filter
                (He/Sun/Tang 2010), the alpha bakers, and the deterministic
                MOCK segmenter. Exported for node at the end of the block so
                the whole mask pipeline is testable without a browser.
     2. Engine seam — engineLoad / engineEncode / engineSegment. The real
                SAM 2 + onnxruntime-web engine lands in the engine phase and
                only has to fill in makeRealEngine(); no UI code above the
                seam learns which engine it is talking to. Setting
                window.__CUTOUT_MOCK = true before open() swaps in the mock,
                which is what the browser test suite drives.
     3. UI    — the workspace overlay: checkerboard preview, brushes,
                per-stroke undo, feather, Apply / Cancel.

   The mask pipeline is identical for the live preview and for Apply; only
   the target resolution differs, so what you see is what gets baked.
   ========================================================================== */
(function () {
  'use strict';

  /* ======================================================================
     1. PURE helpers — no DOM, no globals, deterministic.
     ====================================================================== */

  var LOW = 256;               /* the engine's low-res mask grid (SAM ships 256x256) */
  var MAX_PTS_PER_STROKE = 8;  /* pinned in the spec */
  var MAX_PROMPTS = 64;        /* pinned in the spec */
  var PROMPT_GRID = 64;        /* scribble map: cells across the normalized image */
  var GF_EPS = 1e-3;           /* guided filter regularization */

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* ---- scribble map -> prompt points ---------------------------------- */

  /* Quantize a scribble polyline onto a grid and keep the first point that
     lands in each cell, in stroke order. This is the "scribble map": a long
     slow drag and a quick flick over the same pixels give the same cells. */
  function dedupeByGrid(pts, n) {
    var seen = {}, out = [], i, k, cx, cy;
    for (i = 0; i < pts.length; i++) {
      cx = clamp(Math.floor(pts[i].x * n), 0, n - 1);
      cy = clamp(Math.floor(pts[i].y * n), 0, n - 1);
      k = cy * n + cx;
      if (seen[k]) continue;
      seen[k] = 1;
      out.push({ x: pts[i].x, y: pts[i].y });
    }
    return out;
  }

  /* k evenly spaced picks, both ends included; k === 1 takes the middle (a
     single point in the middle of a scribble is the most representative one,
     and it is what a stroke thinned to its last point should keep). */
  function pickEven(arr, k) {
    if (k <= 0 || !arr.length) return [];
    if (k >= arr.length) return arr.slice();
    if (k === 1) return [arr[Math.floor((arr.length - 1) / 2)]];
    var out = [], i;
    for (i = 0; i < k; i++) out.push(arr[Math.round(i * (arr.length - 1) / (k - 1))]);
    return out;
  }

  /* strokes: [{ label: 0|1, pts: [{x,y}] }] in normalized image coords.
     Caps: at most 8 points per stroke, at most 64 in total. Over the total
     cap the OLDEST strokes are thinned first and every stroke keeps at least
     one point, so nothing a user brushed is ever silently dropped. (With
     more than 64 strokes the total is exceeded rather than a stroke being
     dropped; that is the deliberate trade, and a decoder takes an arbitrary
     point count.) */
  function samplePrompts(strokes, opts) {
    opts = opts || {};
    var grid = opts.grid || PROMPT_GRID;
    var perCap = opts.perStroke || MAX_PTS_PER_STROKE;
    var total = opts.total || MAX_PROMPTS;
    var cells = [], budget = [], i, j, sum = 0;
    for (i = 0; i < strokes.length; i++) {
      var c = dedupeByGrid(strokes[i].pts || [], grid);
      cells.push(c);
      var b = c.length ? Math.min(perCap, c.length) : 0;
      budget.push(b);
      sum += b;
    }
    var guard = 0;
    while (sum > total && guard++ < 100000) {
      var moved = false;
      for (i = 0; i < budget.length; i++) {
        if (budget[i] > 1) { budget[i]--; sum--; moved = true; break; }
      }
      if (!moved) break;                     /* every stroke is down to one point */
    }
    var out = [];
    for (i = 0; i < strokes.length; i++) {
      var pick = pickEven(cells[i], budget[i]);
      for (j = 0; j < pick.length; j++) {
        out.push({ x: pick[j].x, y: pick[j].y, label: strokes[i].label });
      }
    }
    return out;
  }

  /* ---- resampling ------------------------------------------------------ */

  /* Bilinear resample with half-pixel centres (the usual align_corners=false
     convention), edges clamped. */
  function bilinearUpsample(src, sw, sh, dw, dh, out) {
    out = out || new Float32Array(dw * dh);
    var x, y, sx, sy, x0, x1, y0, y1, fx, fy, r0, r1, top, bot;
    for (y = 0; y < dh; y++) {
      sy = clamp((y + 0.5) * sh / dh - 0.5, 0, sh - 1);
      y0 = Math.floor(sy); y1 = y0 + 1 < sh ? y0 + 1 : sh - 1; fy = sy - y0;
      r0 = y0 * sw; r1 = y1 * sw;
      for (x = 0; x < dw; x++) {
        sx = clamp((x + 0.5) * sw / dw - 0.5, 0, sw - 1);
        x0 = Math.floor(sx); x1 = x0 + 1 < sw ? x0 + 1 : sw - 1; fx = sx - x0;
        top = src[r0 + x0] + (src[r0 + x1] - src[r0 + x0]) * fx;
        bot = src[r1 + x0] + (src[r1 + x1] - src[r1 + x0]) * fx;
        out[y * dw + x] = top + (bot - top) * fy;
      }
    }
    return out;
  }

  /* One bilinear sample in SOURCE coordinates, so the row bakers below never
     have to allocate a full-resolution intermediate plane. */
  function sampleBilinearAt(src, sw, sh, sx, sy) {
    sx = clamp(sx, 0, sw - 1); sy = clamp(sy, 0, sh - 1);
    var x0 = Math.floor(sx), y0 = Math.floor(sy);
    var x1 = x0 + 1 < sw ? x0 + 1 : sw - 1, y1 = y0 + 1 < sh ? y0 + 1 : sh - 1;
    var fx = sx - x0, fy = sy - y0, r0 = y0 * sw, r1 = y1 * sw;
    var top = src[r0 + x0] + (src[r0 + x1] - src[r0 + x0]) * fx;
    var bot = src[r1 + x0] + (src[r1 + x1] - src[r1 + x0]) * fx;
    return top + (bot - top) * fy;
  }

  /* logits -> 1 inside / 0 outside */
  function threshold(src, t, out) {
    var n = src.length;
    out = out || new Float32Array(n);
    for (var i = 0; i < n; i++) out[i] = src[i] > t ? 1 : 0;
    return out;
  }

  /* ---- guided filter (He, Sun, Tang 2010) ------------------------------ */

  /* Mean over a (2r+1)^2 window, clamped at the borders and normalized by
     the number of pixels actually inside, via an integral image. */
  function boxFilter(src, w, h, r) {
    var x, y, iw = w + 1;
    var sat = new Float64Array(iw * (h + 1));
    for (y = 0; y < h; y++) {
      var row = 0;
      for (x = 0; x < w; x++) {
        row += src[y * w + x];
        sat[(y + 1) * iw + (x + 1)] = sat[y * iw + (x + 1)] + row;
      }
    }
    var out = new Float32Array(w * h);
    for (y = 0; y < h; y++) {
      var y0 = y - r < 0 ? 0 : y - r, y1 = y + r + 1 > h ? h : y + r + 1;
      for (x = 0; x < w; x++) {
        var x0 = x - r < 0 ? 0 : x - r, x1 = x + r + 1 > w ? w : x + r + 1;
        var s = sat[y1 * iw + x1] - sat[y0 * iw + x1] - sat[y1 * iw + x0] + sat[y0 * iw + x0];
        out[y * w + x] = s / ((y1 - y0) * (x1 - x0));
      }
    }
    return out;
  }

  /* Per-pixel linear coefficients a, b such that q = a*I + b is the filtered
     mask. Returned separately so the fast path can compute them on a small
     guide and apply them against the full-resolution image (He & Sun 2015). */
  function guidedCoeffs(I, p, w, h, r, eps) {
    var n = w * h, i;
    var Ip = new Float32Array(n), II = new Float32Array(n);
    for (i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
    var mI = boxFilter(I, w, h, r), mP = boxFilter(p, w, h, r);
    var mIp = boxFilter(Ip, w, h, r), mII = boxFilter(II, w, h, r);
    var a = new Float32Array(n), b = new Float32Array(n);
    for (i = 0; i < n; i++) {
      var cov = mIp[i] - mI[i] * mP[i];
      var vr = mII[i] - mI[i] * mI[i];
      var av = cov / (vr + eps);
      a[i] = av;
      b[i] = mP[i] - av * mI[i];
    }
    return { a: boxFilter(a, w, h, r), b: boxFilter(b, w, h, r) };
  }

  /* The full guided filter at one resolution (q = meanA*I + meanB). */
  function guidedFilter(I, p, w, h, r, eps) {
    var c = guidedCoeffs(I, p, w, h, r, eps);
    var n = w * h, q = new Float32Array(n);
    for (var i = 0; i < n; i++) q[i] = clamp(c.a[i] * I[i] + c.b[i], 0, 1);
    return q;
  }

  /* Feather slider (0-20) -> box radius, in pixels of the buffer being
     filtered. Scaled by the buffer size so the live preview and the applied
     result feather by the same FRACTION of the image. */
  function radiusFor(feather, w, h) {
    if (!(feather > 0)) return 0;
    return Math.max(1, Math.round(feather * Math.max(w, h) / 700));
  }

  /* ---- alpha bakers ---------------------------------------------------- */

  function grayPlane(rgba, n, out) {
    out = out || new Float32Array(n);
    for (var i = 0; i < n; i++) {
      out[i] = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) / 255;
    }
    return out;
  }

  /* Feather 0: a hard threshold of the bilinearly upsampled logits, fused so
     no full-resolution plane is allocated. Keeps any alpha the source
     already had. Rows [y0, y1) so callers can chunk. */
  function bakeHardRows(rgba, W, H, logits, lw, lh, y0, y1) {
    var x, y, i, sy, sx, v;
    for (y = y0; y < y1; y++) {
      sy = (y + 0.5) * lh / H - 0.5;
      for (x = 0; x < W; x++) {
        sx = (x + 0.5) * lw / W - 0.5;
        v = sampleBilinearAt(logits, lw, lh, sx, sy);
        i = (y * W + x) * 4 + 3;
        if (v <= 0) rgba[i] = 0;
      }
    }
  }

  /* Feather > 0: q = a*I + b, with a and b sampled bilinearly from the
     coefficient-resolution grids and I read from the full-resolution pixel. */
  function bakeGuidedRows(rgba, W, H, a, b, cw, ch, y0, y1) {
    var x, y, i, sy, sx, g, q;
    for (y = y0; y < y1; y++) {
      sy = (y + 0.5) * ch / H - 0.5;
      for (x = 0; x < W; x++) {
        sx = (x + 0.5) * cw / W - 0.5;
        i = (y * W + x) * 4;
        g = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) / 255;
        q = sampleBilinearAt(a, cw, ch, sx, sy) * g + sampleBilinearAt(b, cw, ch, sx, sy);
        q = q < 0 ? 0 : q > 1 ? 1 : q;
        rgba[i + 3] = Math.round(rgba[i + 3] * q);
      }
    }
  }

  /* ---- the MOCK segmenter ---------------------------------------------
     Deterministic colour-similarity region growing on the downscaled image:
     positive prompts flood and union, negative prompts flood and carve. It
     returns the same shape the real engine will (a LOW x LOW float logit
     grid, positive inside), so every pixel of UI downstream of the seam is
     exercised by the tests exactly as it will be in production. */
  function floodFrom(pix, w, h, seed, tol2, out, val) {
    var n = w * h;
    if (seed < 0 || seed >= n) return 0;
    var seen = new Uint8Array(n), stack = new Int32Array(n), sp = 0, count = 0;
    var sr = pix[seed * 3], sg = pix[seed * 3 + 1], sb = pix[seed * 3 + 2];
    stack[sp++] = seed; seen[seed] = 1;
    while (sp > 0) {
      var p = stack[--sp];
      out[p] = val; count++;
      var x = p % w, y = (p - x) / w, q, dr, dg, db, k;
      for (k = 0; k < 4; k++) {
        if (k === 0) { if (x === 0) continue; q = p - 1; }
        else if (k === 1) { if (x === w - 1) continue; q = p + 1; }
        else if (k === 2) { if (y === 0) continue; q = p - w; }
        else { if (y === h - 1) continue; q = p + w; }
        if (seen[q]) continue;
        dr = pix[q * 3] - sr; dg = pix[q * 3 + 1] - sg; db = pix[q * 3 + 2] - sb;
        if (dr * dr + dg * dg + db * db > tol2) continue;
        seen[q] = 1; stack[sp++] = q;
      }
    }
    return count;
  }

  function mockSegment(pix, w, h, prompts, opts) {
    opts = opts || {};
    var tol2 = opts.tol2 == null ? 0.02 : opts.tol2;
    var K = opts.K == null ? 8 : opts.K;
    var n = w * h, i;
    var keep = new Uint8Array(n);
    var pos = [], neg = [];
    for (i = 0; i < (prompts || []).length; i++) {
      (prompts[i].label ? pos : neg).push(prompts[i]);
    }
    if (!pos.length) pos = [{ x: 0.5, y: 0.5, label: 1 }];
    function idxOf(p) {
      var cx = clamp(Math.round(p.x * w - 0.5), 0, w - 1);
      var cy = clamp(Math.round(p.y * h - 0.5), 0, h - 1);
      return cy * w + cx;
    }
    for (i = 0; i < pos.length; i++) floodFrom(pix, w, h, idxOf(pos[i]), tol2, keep, 1);
    for (i = 0; i < neg.length; i++) floodFrom(pix, w, h, idxOf(neg[i]), tol2, keep, 0);
    var area = 0;
    var logits = new Float32Array(n);
    for (i = 0; i < n; i++) { if (keep[i]) area++; logits[i] = keep[i] ? K : -K; }
    /* A stand-in for the model's predicted IoU: confident around a
       subject-sized region, weak for a sliver or for most of the frame. It
       drives the same "this cut is uncertain" copy the real score will. */
    var frac = area / n;
    var iou = clamp(0.92 - 1.6 * Math.abs(frac - 0.30), 0.3, 0.95);
    return { logits: logits, area: area, iou: iou };
  }

  var PURE = {
    LOW: LOW,
    MAX_PTS_PER_STROKE: MAX_PTS_PER_STROKE,
    MAX_PROMPTS: MAX_PROMPTS,
    PROMPT_GRID: PROMPT_GRID,
    GF_EPS: GF_EPS,
    clamp: clamp,
    dedupeByGrid: dedupeByGrid,
    pickEven: pickEven,
    samplePrompts: samplePrompts,
    bilinearUpsample: bilinearUpsample,
    sampleBilinearAt: sampleBilinearAt,
    threshold: threshold,
    boxFilter: boxFilter,
    guidedCoeffs: guidedCoeffs,
    guidedFilter: guidedFilter,
    radiusFor: radiusFor,
    grayPlane: grayPlane,
    bakeHardRows: bakeHardRows,
    bakeGuidedRows: bakeGuidedRows,
    floodFrom: floodFrom,
    mockSegment: mockSegment
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PURE;
  if (typeof window === 'undefined') return;          /* node stops here */

  /* ======================================================================
     2. Engine seam
     ====================================================================== */

  /* PLACEHOLDER: the engine phase measures the real bundle and sets this. It
     is the single source of the number in the download note. */
  var MODEL_MB = 40;

  var COPY = {
    download: 'The cutter is a one-time download of about ' + MODEL_MB + ' MB. It runs entirely in your browser and is cached for next time.',
    weak: 'This cut is uncertain, so brush what to keep and remove.',
    ready: 'Auto cut ready. Brush over anything it got wrong.',
    jpeg: 'Export format switched to PNG, since JPEG cannot store transparency.'
  };

  /* The mock: a deterministic stand-in with the same three calls the real
     engine exposes, so no UI code above the seam knows the difference. */
  function makeMockEngine() {
    var pix = null;
    return {
      name: 'mock',
      load: function (onProgress) {
        if (onProgress) onProgress(1, 1);
        return Promise.resolve(true);
      },
      encode: function (canvas) {
        var c = document.createElement('canvas');
        c.width = LOW; c.height = LOW;
        var x = c.getContext('2d');
        x.imageSmoothingQuality = 'high';
        x.drawImage(canvas, 0, 0, LOW, LOW);
        var d = x.getImageData(0, 0, LOW, LOW).data;
        pix = new Float32Array(LOW * LOW * 3);
        for (var i = 0; i < LOW * LOW; i++) {
          pix[i * 3] = d[i * 4] / 255;
          pix[i * 3 + 1] = d[i * 4 + 1] / 255;
          pix[i * 3 + 2] = d[i * 4 + 2] / 255;
        }
        c.width = 0; c.height = 0;
        return Promise.resolve(true);
      },
      segment: function (prompts) {
        if (!pix) return Promise.reject(new Error('not encoded'));
        var m = mockSegment(pix, LOW, LOW, prompts);
        var out = { maskLogitsLowRes: m.logits, w: LOW, h: LOW, bestIoU: m.iou };
        /* the tests set __CUTOUT_MOCK_DELAY to stand in for a real decoder's
           latency, which is how the brush-faster-than-the-engine paths get
           exercised deterministically */
        var d = +window.__CUTOUT_MOCK_DELAY || 0;
        if (d > 0) return new Promise(function (r) { setTimeout(function () { r(out); }, d); });
        return Promise.resolve(out);
      },
      dispose: function () { pix = null; }
    };
  }

  /* The real SAM 2 + onnxruntime-web engine lands in the engine phase; it
     only has to return an object with the same load / encode / segment /
     dispose. Returning null keeps the button out of the page until then. */
  function makeRealEngine() {
    return null;
  }

  function engineAvailable() {
    return window.__CUTOUT_MOCK === true || !!makeRealEngine();
  }
  function newEngine() {
    return window.__CUTOUT_MOCK === true ? makeMockEngine() : makeRealEngine();
  }

  /* ======================================================================
     3. UI
     ====================================================================== */

  function id(x) { return document.getElementById(x); }

  var root = id('it-cut');
  if (!root) return;

  var elStage = id('it-cut-stage'), cv = id('it-cut-canvas');
  var ctx = cv ? cv.getContext('2d') : null;
  var elStatus = id('it-cut-status'), elDl = id('it-cut-dl');
  var elKeep = id('it-cut-keep'), elRemove = id('it-cut-remove');
  var elUndo = id('it-cut-undo'), elDots = id('it-cut-dots');
  var elRad = id('it-cut-radius'), elRadV = id('it-cut-radius-val');
  var elFeather = id('it-cut-feather'), elFeatherV = id('it-cut-feather-val');
  var elApply = id('it-cut-apply'), elCancel = id('it-cut-cancel'), elClose = id('it-cut-close');
  var openBtn = id('it-cutout');

  /* The overlay is position:fixed. A nested stacking context anywhere above
     it in the page would trap it under the masthead, so hoist it to <body>
     (the same fix the PDF Toolbench needed). */
  if (root.parentNode !== document.body) document.body.appendChild(root);

  if (elDl) elDl.textContent = COPY.download;

  var GF_MAX = 1024;            /* guided-filter coefficients are computed at most this big */
  var PREVIEW_MAX = 1400;       /* preview buffer cap (backing pixels on the long side) */
  var UNDO_MAX = 25;

  var opened = false;
  var engine = null, engineReady = false, encodedFor = -1;
  var srcCanvas = null;                    /* Image Studio's working canvas */
  var strokes = [], undoStack = [], promptCache = null;
  var logits = null, lastIoU = 0;
  var logitsFor = -1;                      /* stroke count the current mask was computed from */
  var brush = 1;                           /* 1 = keep, 0 = remove */
  var segSeq = 0, paintSeq = 0, busy = false;
  var lastFocus = null;

  /* preview buffers */
  var pv = document.createElement('canvas');
  var pvx = pv.getContext('2d');
  var baseData = null;                     /* pristine RGBA at preview resolution */
  var PW = 0, PH = 0;
  var imgX = 0, imgY = 0, imgW = 1, imgH = 1, dpr = 1;

  var drawing = null, hover = null;        /* live stroke + brush cursor */

  function effectiveTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t === 'light' || t === 'dark') return t;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }
  function isLight() { return effectiveTheme() === 'light'; }
  function accent() { return isLight() ? '#34568a' : '#82a6cc'; }
  function setStatus(msg) { if (elStatus) elStatus.textContent = msg || ''; }
  function featherVal() { return elFeather ? +elFeather.value : 0; }
  function radiusPx() { return elRad ? +elRad.value : 24; }

  /* ---- checkerboard ---------------------------------------------------- */
  var checkPat = null, checkTheme = null;
  function checker() {
    var th = effectiveTheme();
    if (checkPat && checkTheme === th) return checkPat;
    var c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    var x = c.getContext('2d');
    x.fillStyle = th === 'light' ? '#ffffff' : '#1c1c1c';
    x.fillRect(0, 0, 16, 16);
    x.fillStyle = th === 'light' ? '#e4e4e4' : '#2b2b2b';
    x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
    checkPat = ctx.createPattern(c, 'repeat');
    checkTheme = th;
    return checkPat;
  }

  /* ---- layout ---------------------------------------------------------- */
  function sizeCanvas() {
    if (!cv || !elStage) return;
    var w = Math.max(120, elStage.clientWidth || 320);
    var h = Math.max(120, elStage.clientHeight || 240);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    var bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
    if (!srcCanvas) return;
    var s = Math.min(w / srcCanvas.width, h / srcCanvas.height);
    imgW = Math.max(1, srcCanvas.width * s); imgH = Math.max(1, srcCanvas.height * s);
    imgX = (w - imgW) / 2; imgY = (h - imgH) / 2;
  }

  /* Build (or rebuild) the preview-resolution copy of the source image. */
  function buildPreview() {
    if (!srcCanvas) return;
    var cap = Math.min(PREVIEW_MAX, Math.max(240, Math.max(imgW, imgH) * dpr));
    var s = Math.min(1, cap / Math.max(srcCanvas.width, srcCanvas.height));
    var w = Math.max(1, Math.round(srcCanvas.width * s));
    var h = Math.max(1, Math.round(srcCanvas.height * s));
    if (PW === w && PH === h && baseData) return;
    PW = w; PH = h;
    pv.width = PW; pv.height = PH;
    pvx.imageSmoothingQuality = 'high';
    pvx.clearRect(0, 0, PW, PH);
    pvx.drawImage(srcCanvas, 0, 0, PW, PH);
    baseData = pvx.getImageData(0, 0, PW, PH);
  }

  /* ---- the mask pipeline (shared by the preview and by Apply) ----------- */

  function yieldNow() { return new Promise(function (r) { setTimeout(r, 0); }); }

  /* Guide + binary mask at the coefficient resolution. */
  function coeffInputs(src, W, H, lg) {
    var s = Math.min(1, GF_MAX / Math.max(W, H));
    var cw = Math.max(8, Math.round(W * s)), ch = Math.max(8, Math.round(H * s));
    var c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    var x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, 0, 0, cw, ch);
    var guide = grayPlane(x.getImageData(0, 0, cw, ch).data, cw * ch);
    c.width = 0; c.height = 0;
    var bin = threshold(bilinearUpsample(lg, LOW, LOW, cw, ch), 0);
    return { guide: guide, bin: bin, cw: cw, ch: ch };
  }

  /* Writes the mask into rgba's alpha channel, chunked so a big image never
     blocks a frame. Identical maths for the live preview and for Apply;
     `stop` lets a superseded run bail out mid-way. */
  async function paintAlpha(rgba, W, H, src, lg, feather, stop) {
    var band = Math.max(1, Math.round(120000 / Math.max(1, W)));
    var y = 0, a = null, b = null, cw = 0, ch = 0;
    if (feather > 0) {
      var ci = coeffInputs(src, W, H, lg);
      var co = guidedCoeffs(ci.guide, ci.bin, ci.cw, ci.ch, radiusFor(feather, ci.cw, ci.ch), GF_EPS);
      a = co.a; b = co.b; cw = ci.cw; ch = ci.ch;
    }
    while (y < H) {
      if (stop && stop()) return false;
      var y1 = Math.min(H, y + band);
      if (feather > 0) bakeGuidedRows(rgba, W, H, a, b, cw, ch, y, y1);
      else bakeHardRows(rgba, W, H, lg, LOW, LOW, y, y1);
      y = y1;
      if (y < H) await yieldNow();
    }
    return true;
  }

  var painting = 0;                          /* preview repaints in flight */
  async function refreshPreview() {
    if (!logits || !baseData) return;
    var my = ++paintSeq;
    var stale = function () { return my !== paintSeq; };
    painting++;
    try {
      var out = pvx.createImageData(PW, PH);
      out.data.set(baseData.data);
      var done = await paintAlpha(out.data, PW, PH, srcCanvas, logits, featherVal(), stale);
      if (!done || stale()) return;          /* superseded by a newer request */
      pvx.clearRect(0, 0, PW, PH);
      pvx.putImageData(out, 0, 0);
      render();
    } finally { painting--; }
  }

  /* ---- drawing --------------------------------------------------------- */
  function withAlpha(hex, a) {
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function strokePath(st) {
    ctx.beginPath();
    for (var i = 0; i < st.pts.length; i++) {
      var x = imgX + st.pts[i].x * imgW, y = imgY + st.pts[i].y * imgH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    if (st.pts.length === 1) ctx.lineTo(imgX + st.pts[0].x * imgW + 0.01, imgY + st.pts[0].y * imgH);
  }
  function paintStroke(st, alpha) {
    strokePath(st);
    ctx.strokeStyle = st.label ? withAlpha(accent(), alpha) : 'rgba(150,150,150,' + alpha + ')';
    ctx.lineWidth = Math.max(2, st.r * imgW * 2);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.stroke();
  }
  function render() {
    if (!ctx || !cv) return;
    var w = cv.width / dpr, h = cv.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!srcCanvas) return;
    ctx.fillStyle = checker();
    ctx.fillRect(imgX, imgY, imgW, imgH);
    if (PW) ctx.drawImage(pv, imgX, imgY, imgW, imgH);
    ctx.strokeStyle = 'rgba(127,127,127,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(imgX + 0.5, imgY + 0.5, imgW - 1, imgH - 1);

    if (!elDots || elDots.checked) {
      var i;
      for (i = 0; i < strokes.length; i++) paintStroke(strokes[i], 0.3);
      /* the points the engine actually sees (cached: render runs on every
         pointermove, and the sampling only changes when a stroke does) */
      if (!promptCache) promptCache = samplePrompts(strokes, { total: MAX_PROMPTS - 1 });
      var pts = promptCache;
      for (i = 0; i < pts.length; i++) {
        ctx.beginPath();
        ctx.arc(imgX + pts[i].x * imgW, imgY + pts[i].y * imgH, 3.5, 0, 6.2832);
        ctx.fillStyle = pts[i].label ? accent() : 'rgba(150,150,150,0.95)';
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = isLight() ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.55)';
        ctx.stroke();
      }
    }
    if (drawing) paintStroke(drawing, 0.5);
    if (hover) {
      ctx.beginPath();
      ctx.arc(hover.x, hover.y, radiusPx(), 0, 6.2832);
      ctx.strokeStyle = brush ? accent() : 'rgba(150,150,150,0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  /* ---- segmentation ---------------------------------------------------- */
  /* The automatic first cut is a single centre point. It stays at the head
     of the prompt list afterwards, so a brush stroke REFINES that cut
     instead of replacing it (brushing one part of a subject should not drop
     the rest). A Remove stroke over the centre still carves it back out,
     because negative prompts are applied after the positives. */
  var AUTO_PROMPT = { x: 0.5, y: 0.5, label: 1 };

  async function segment(auto) {
    if (!engine || !engineReady) return;
    var my = ++segSeq;
    var prompts = auto ? [AUTO_PROMPT]
      : [AUTO_PROMPT].concat(samplePrompts(strokes, { total: MAX_PROMPTS - 1 }));
    busy = true;
    updateButtons();
    try {
      var res = await engine.segment(prompts, auto ? null : logits);
      if (my !== segSeq) return;
      logits = res.maskLogitsLowRes;
      logitsFor = auto ? 0 : strokes.length;
      lastIoU = res.bestIoU || 0;
      await refreshPreview();
      if (my !== segSeq) return;
      if (auto) setStatus(lastIoU < 0.7 ? COPY.weak : COPY.ready);
      else setStatus(strokes.length === 1 ? 'Updated from 1 brush stroke.'
        : 'Updated from ' + strokes.length + ' brush strokes.');
    } catch (e) {
      if (my === segSeq) setStatus('The cutter could not update that. Try another stroke.');
    } finally {
      if (my === segSeq) { busy = false; updateButtons(); }
    }
  }

  function updateButtons() {
    if (elUndo) elUndo.disabled = undoStack.length === 0;
    if (elKeep) { elKeep.classList.toggle('it-btn--on', brush === 1); elKeep.setAttribute('aria-pressed', brush === 1 ? 'true' : 'false'); }
    if (elRemove) { elRemove.classList.toggle('it-btn--on', brush === 0); elRemove.setAttribute('aria-pressed', brush === 0 ? 'true' : 'false'); }
    if (elApply) elApply.disabled = !logits || busy;
  }

  /* ---- strokes --------------------------------------------------------- */
  function pushUndo() {
    undoStack.push({ strokes: strokes.slice(), logits: logits ? logits.slice() : null, logitsFor: logitsFor });
    if (undoStack.length > UNDO_MAX) undoStack.shift();
  }
  function undoStroke() {
    if (!undoStack.length) return;
    var s = undoStack.pop();
    strokes = s.strokes;
    promptCache = null;
    logits = s.logits;
    logitsFor = s.logitsFor;
    segSeq++;                                 /* drop any segmentation in flight */
    busy = false;
    updateButtons();
    /* Brushing faster than the engine can answer means a snapshot can hold a
       mask that predates its own stroke list; recompute rather than show a
       mask that does not match the strokes on screen. */
    if (logitsFor !== strokes.length) {
      setStatus('Updating the cut…');
      segment(false);
      return;
    }
    setStatus(strokes.length
      ? 'Took back a stroke. ' + strokes.length + ' left.'
      : 'Back to the automatic cut.');
    refreshPreview();
  }

  function localPt(e) {
    var r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function toImage(p) {
    return { x: clamp((p.x - imgX) / imgW, 0, 1), y: clamp((p.y - imgY) / imgH, 0, 1) };
  }
  function endStroke(e) {
    if (!drawing || drawing.pid !== e.pointerId) return;
    var st = drawing;
    drawing = null;
    pushUndo();
    strokes.push({ label: st.label, r: st.r, pts: st.pts });
    promptCache = null;
    updateButtons();
    render();
    setStatus('Updating the cut…');
    segment(false);
  }

  if (cv) {
    cv.addEventListener('pointerdown', function (e) {
      if (!srcCanvas || !engineReady || e.button === 2) return;
      var p = localPt(e);
      drawing = { label: brush, r: radiusPx() / Math.max(1, imgW), pts: [toImage(p)], pid: e.pointerId };
      hover = p;
      try { cv.setPointerCapture(e.pointerId); } catch (er) {}
      e.preventDefault();
      render();
    });
    cv.addEventListener('pointermove', function (e) {
      hover = localPt(e);
      if (drawing && drawing.pid === e.pointerId) {
        var q = toImage(hover), last = drawing.pts[drawing.pts.length - 1];
        if (Math.abs(q.x - last.x) * imgW > 1.5 || Math.abs(q.y - last.y) * imgH > 1.5) drawing.pts.push(q);
        e.preventDefault();
      }
      render();
    });
    cv.addEventListener('pointerup', endStroke);
    cv.addEventListener('pointerleave', function () { hover = null; render(); });
    cv.addEventListener('pointercancel', function (e) {
      if (drawing && drawing.pid === e.pointerId) { drawing = null; render(); }
    });
    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  /* ---- controls -------------------------------------------------------- */
  if (elKeep) elKeep.addEventListener('click', function () { brush = 1; updateButtons(); render(); });
  if (elRemove) elRemove.addEventListener('click', function () { brush = 0; updateButtons(); render(); });
  if (elUndo) elUndo.addEventListener('click', undoStroke);
  if (elDots) elDots.addEventListener('change', render);
  if (elRad) elRad.addEventListener('input', function () { elRadV.textContent = elRad.value + ' px'; render(); });
  if (elFeather) elFeather.addEventListener('input', function () { elFeatherV.textContent = elFeather.value; refreshPreview(); });
  if (elCancel) elCancel.addEventListener('click', function () { closeWorkspace(true); });
  if (elClose) elClose.addEventListener('click', function () { closeWorkspace(true); });
  if (elApply) elApply.addEventListener('click', apply);

  /* ---- apply / cancel -------------------------------------------------- */
  async function apply() {
    var S = window.ImageStudio;
    if (!logits || !srcCanvas || busy || !S) return;
    busy = true;
    updateButtons();
    /* the bake yields between row bands, so the workspace must not be
       closable underneath it (a cancel mid-bake would otherwise still land
       the edit) */
    if (elCancel) elCancel.disabled = true;
    if (elClose) elClose.disabled = true;
    setStatus('Applying the cutout…');
    try {
      var W = srcCanvas.width, H = srcCanvas.height;
      var out = document.createElement('canvas');
      out.width = W; out.height = H;
      var ox = out.getContext('2d');
      ox.drawImage(srcCanvas, 0, 0);
      var dat = ox.getImageData(0, 0, W, H);
      await paintAlpha(dat.data, W, H, srcCanvas, logits, featherVal(), null);
      if (!opened) return;                       /* closed while the bake ran */
      ox.clearRect(0, 0, W, H);
      ox.putImageData(dat, 0, 0);
      S.applyEdit(out, 'Background cut out.');
      /* JPEG has no alpha channel, so a cutout would silently come back with
         a black or white background on export. */
      if (S.getFormat && S.getFormat() === 'jpeg' && S.setFormat) {
        S.setFormat('png');
        if (S.setStatus) S.setStatus('Background cut out. ' + COPY.jpeg);
      }
      closeWorkspace(false);
    } catch (e) {
      setStatus('Could not apply the cutout.');
    } finally {
      if (opened) {
        busy = false;
        if (elCancel) elCancel.disabled = false;
        if (elClose) elClose.disabled = false;
        updateButtons();
      }
    }
  }

  function closeWorkspace(confirmFirst) {
    if (!opened) return;
    if (confirmFirst && strokes.length) {
      var n = strokes.length;
      if (!window.confirm('Discard this cutout and the ' + n + ' stroke' + (n === 1 ? '' : 's') + ' you brushed?')) return;
    }
    opened = false;
    segSeq++; paintSeq++;
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('it-cut-open');
    strokes = []; undoStack = []; promptCache = null; drawing = null; hover = null; logits = null; logitsFor = -1;
    baseData = null; PW = 0; PH = 0;
    pv.width = 0; pv.height = 0;                 /* free the preview buffer */
    busy = false;
    if (elCancel) elCancel.disabled = false;     /* re-arm for the next open */
    if (elClose) elClose.disabled = false;
    /* The sessions and the image embedding go on close, as pinned. The
       engine implementation should hold its downloaded weights in a
       module-level cache so re-opening re-initializes rather than
       re-downloads, and `encodedFor` (the Image Studio edit counter) is what
       lets it skip re-encoding an image that has not changed. */
    if (engine && engine.dispose) engine.dispose();
    engine = null; engineReady = false; encodedFor = -1;
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
  }

  /* ---- open ------------------------------------------------------------ */
  async function openWorkspace() {
    var S = window.ImageStudio;
    if (opened || !S || !S.getWorkCanvas) return;
    srcCanvas = S.getWorkCanvas();
    if (!srcCanvas) return;
    lastFocus = document.activeElement;
    opened = true;
    strokes = []; undoStack = []; promptCache = null; logits = null; logitsFor = -1; drawing = null; hover = null;
    brush = 1; busy = false;
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('it-cut-open');
    updateButtons();
    setStatus('Getting the cutter ready…');
    /* the overlay has to be laid out before the stage can be measured */
    await new Promise(function (r) { requestAnimationFrame(function () { r(); }); });
    if (!opened) return;
    sizeCanvas();
    buildPreview();
    render();
    if (elClose) elClose.focus();
    if (!engine) engine = newEngine();
    if (!engine) { setStatus('The background cutter is not available in this build yet.'); return; }
    try {
      if (!engineReady) {
        await engine.load(function (done, total) {
          if (total > 1) setStatus('Loading the cutter… ' + Math.round(done / 1048576) + ' of ' + Math.round(total / 1048576) + ' MB');
        });
        engineReady = true;
      }
      if (!opened) return;
      var edit = S.editCount ? S.editCount() : 0;
      if (encodedFor !== edit) {
        setStatus('Reading the photo…');
        await engine.encode(srcCanvas);
        encodedFor = edit;
      }
      if (!opened) return;
      setStatus('Finding the subject…');
      await segment(true);
    } catch (e) {
      setStatus('The cutter could not start.');
    }
  }

  /* ---- keyboard: Escape ladder, Tab trap, per-stroke undo -------------- */
  function focusables() {
    var all = root.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])');
    var out = [], i, e;
    for (i = 0; i < all.length; i++) {
      e = all[i];
      if (e.disabled || e.hidden) continue;
      if (!e.offsetWidth && !e.offsetHeight) continue;
      out.push(e);
    }
    return out;
  }
  document.addEventListener('keydown', function (e) {
    if (!opened) return;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (drawing) { drawing = null; render(); setStatus('Stroke cancelled.'); return; }
      closeWorkspace(true);
      return;
    }
    if (e.key === 'Tab') {
      var f = focusables();
      if (!f.length) return;
      e.preventDefault();
      var i = f.indexOf(document.activeElement);
      var n = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i < 0 || i === f.length - 1 ? 0 : i + 1);
      f[n].focus();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      /* the workspace owns undo while it is open, so Image Studio's own
         window-level Ctrl+Z must not also fire */
      e.preventDefault(); e.stopPropagation();
      undoStroke();
    }
  }, true);

  window.addEventListener('resize', function () {
    if (!opened) return;
    sizeCanvas();
    buildPreview();
    refreshPreview();
  });

  /* theme changes recolor the checkerboard and the brush marks */
  new MutationObserver(function () { checkPat = null; if (opened) render(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: light)');
    if (mq.addEventListener) mq.addEventListener('change', function () { checkPat = null; if (opened) render(); });
  }

  /* ---- wiring ---------------------------------------------------------- */
  if (elRad && elRadV) elRadV.textContent = elRad.value + ' px';
  if (elFeather && elFeatherV) elFeatherV.textContent = elFeather.value;

  /* Until the engine phase lands a real model the button would open a
     workspace with nothing behind it, so it stays out of the page unless an
     engine exists (or the deterministic mock is switched on). The vendored
     library credit is shown on the same condition, so the page never credits
     a model it is not actually running. */
  var elCredit = id('it-cut-credit');
  if (engineAvailable()) {
    if (elCredit) elCredit.hidden = false;
  } else if (openBtn) {
    openBtn.style.display = 'none';
    openBtn.setAttribute('aria-hidden', 'true');
    openBtn.tabIndex = -1;
  }

  window.ImageCutout = {
    open: openWorkspace,
    close: function () { closeWorkspace(false); },
    isOpen: function () { return opened; },
    available: engineAvailable,
    PURE: PURE,
    /* test hooks: the browser suite drives the UI through real input and
       reads state back through these (the pattern __c4 / __voy use). */
    __test: {
      ready: function () { return opened && engineReady && !!logits && !busy && painting === 0; },
      strokeCount: function () { return strokes.length; },
      undoDepth: function () { return undoStack.length; },
      iou: function () { return lastIoU; },
      status: function () { return elStatus ? elStatus.textContent : ''; },
      brush: function () { return brush; },
      /* preview alpha at normalized image coordinates */
      alphaAt: function (nx, ny) {
        if (!PW) return -1;
        var x = clamp(Math.round(nx * PW), 0, PW - 1), y = clamp(Math.round(ny * PH), 0, PH - 1);
        return pvx.getImageData(x, y, 1, 1).data[3];
      },
      /* where the image sits on screen, so tests can aim real input at it */
      imageRect: function () {
        var r = cv.getBoundingClientRect();
        return { x: r.left + imgX, y: r.top + imgY, w: imgW, h: imgH };
      }
    }
  };
})();
