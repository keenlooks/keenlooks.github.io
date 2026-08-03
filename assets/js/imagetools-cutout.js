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
     point count.)

     The tool feeds the engine SEQUENTIALLY: one call per stroke, carrying the
     previous mask forward, so in practice this is called with a single stroke
     and only the per-stroke cap of 8 binds. The total cap is still honoured
     because the same function draws the prompt dots for every stroke at once,
     and because a future caller that batches strokes must not be able to send
     an unbounded list. */
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

  /* ---- the brush swath -------------------------------------------------
     A stroke is not a hairline. The user sees a brush CIRCLE and reasonably
     expects everything under it to count, so anything that asks "did this
     stroke touch the mask" has to ask about the swath the circle painted,
     not about the centreline. These two helpers turn a sampled polyline into
     that swath, in normalized image coordinates.

     `rx` is the brush radius as a fraction of the image WIDTH (which is how a
     stroke stores it) and `ar` is the image's pixel aspect, width / height, so
     the same radius is `rx * ar` of the height. Perpendiculars are taken in
     PIXEL space and converted back, otherwise the flanks of a stroke on a
     non-square image lean the wrong way. */

  var SWATH_FRAC = 0.5;   /* how far out along the radius the flanks are probed */

  /* Perpendicular offsets, at the full brush radius, for every point of a
     polyline. Entries 0 and 1 are the stroke's two flanks and stay on the same
     side of it from point to point. A stroke with no length at all (a dab) has
     no tangent to be perpendicular to, so its swath is a disc and its
     candidates are the four axis directions instead. */
  function swathOffsets(pts, rx, ar) {
    var ry = rx * (ar > 0 ? ar : 1), n = pts.length, out = [], i;
    for (i = 0; i < n; i++) {
      var a = pts[i > 0 ? i - 1 : 0], b = pts[i + 1 < n ? i + 1 : n - 1];
      var u = (b.x - a.x) * (ar > 0 ? ar : 1), v = b.y - a.y;
      var len = Math.sqrt(u * u + v * v);
      if (!(len > 1e-9)) {
        out.push([{ ox: rx, oy: 0 }, { ox: -rx, oy: 0 }, { ox: 0, oy: ry }, { ox: 0, oy: -ry }]);
      } else {
        var px = -v / len, py = u / len;              /* unit perpendicular, pixel space */
        out.push([{ ox: rx * px, oy: ry * py }, { ox: -rx * px, oy: -ry * py }]);
      }
    }
    return out;
  }

  /* Does this stroke reach the region it is asking about, and where exactly?
     `inside(x, y)` answers "would a prompt point here mean anything": for a
     Remove stroke that is "inside the current cut", for a Keep stroke it is
     "outside it".

     Three outcomes:
       - the centreline already overlaps -> the points are handed back
         UNCHANGED, so a stroke that was working before behaves identically;
       - only the swath overlaps -> every point is shifted half a radius onto
         the flank that did the overlapping, so the model is prompted where the
         user could see paint;
       - neither -> hit is false and the caller may treat the stroke as asking
         for nothing.
     The number of points never changes, so the per-stroke cap of 8 and the
     total cap of 64 hold exactly as they did. */
  function swathPrompts(pts, rx, ar, inside, frac) {
    frac = frac == null ? SWATH_FRAC : frac;
    var i, j, n = pts.length;
    for (i = 0; i < n; i++) {
      if (inside(pts[i].x, pts[i].y)) return { hit: true, shifted: false, pts: pts.slice() };
    }
    if (!n || !(rx > 0)) return { hit: false, shifted: false, pts: pts.slice() };
    var offs = swathOffsets(pts, rx, ar), tally = [0, 0, 0, 0], best = -1, c;
    for (i = 0; i < n; i++) {
      for (j = 0; j < offs[i].length; j++) {
        c = offs[i][j];
        if (inside(clamp(pts[i].x + c.ox * frac, 0, 1), clamp(pts[i].y + c.oy * frac, 0, 1))) tally[j]++;
      }
    }
    for (j = 0; j < tally.length; j++) {
      if (tally[j] > 0 && (best < 0 || tally[j] > tally[best])) best = j;
    }
    if (best < 0) return { hit: false, shifted: false, pts: pts.slice() };
    var out = [];
    for (i = 0; i < n; i++) {
      c = offs[i][best] || offs[i][0];
      out.push({
        x: clamp(pts[i].x + c.ox * frac, 0, 1),
        y: clamp(pts[i].y + c.oy * frac, 0, 1),
        label: pts[i].label
      });
    }
    return { hit: true, shifted: true, pts: out };
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

  /* Scratch buffers for the guided filter. Every preview repaint builds four
     box filters plus their integral images, roughly 20 MB of throwaway typed
     arrays; a dozen strokes of that was enough garbage to earn a major
     collection, which showed up as a single 400 ms stall on the main thread
     while everything else was already off it. The buffers are reused instead.
     They are internal to the two functions below, which run synchronously and
     never overlap, and each is fully rewritten before it is read: the integral
     image's zero row and zero column are never written by anything and stay
     zero from the allocation onwards, which is what makes reuse safe. Keyed by
     length, so a call at a different size simply allocates. */
  var scratch = {};
  function scratchBuf(key, n, F) {
    var b = scratch[key];
    if (!b || b.length !== n) b = scratch[key] = new F(n);
    return b;
  }
  function releaseScratch() { scratch = {}; }

  /* Mean over a (2r+1)^2 window, clamped at the borders and normalized by
     the number of pixels actually inside, via an integral image. */
  function boxFilter(src, w, h, r) {
    var x, y, iw = w + 1;
    var sat = scratchBuf('sat', iw * (h + 1), Float64Array);
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
    var Ip = scratchBuf('Ip', n, Float32Array), II = scratchBuf('II', n, Float32Array);
    for (i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
    var mI = boxFilter(I, w, h, r), mP = boxFilter(p, w, h, r);
    var mIp = boxFilter(Ip, w, h, r), mII = boxFilter(II, w, h, r);
    var a = scratchBuf('a', n, Float32Array), b = scratchBuf('b', n, Float32Array);
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

  /* ---- engine-side maths (pure, so node can test it) -------------------
     These three live here rather than next to the engine because they are the
     parts most likely to be wrong in a way no screenshot would reveal. */

  var AREA_JUMP = 3;     /* ratio that counts as "the mask suddenly resized" */
  var IOU_SLACK = 0.15;  /* predicted score we will trade for continuity */

  /* Fraction of a logit map that is inside the mask. */
  function areaOf(data, off, n) {
    var c = 0;
    for (var i = 0; i < n; i++) if (data[off + i] > 0) c++;
    return c / n;
  }

  /* ---- the area-jump re-rank guard ------------------------------------
     SAM returns several candidate masks with a predicted-IoU score each, and
     the usual rule is "take the highest score". That head is small, and a
     perturbed image embedding can flip which candidate wins even when all the
     candidates are individually sensible: the model's accuracy report caught
     exactly this (a dog's mask jumping from 22% of the frame to 100% between
     two runs of the same prompt). A flip like that is invisible in the score
     but catastrophic on screen, so the engine treats a sudden change of mask
     SIZE as the tell.

     Exact rule, applied only when a previous mask exists (so never on the
     automatic first cut, which has nothing to be continuous with):
       1. pick = the normal choice (highest predicted IoU among the multimask
          candidates, or the single-mask head when refining);
       2. if area(pick) > 3 x area(previous) OR area(pick) x 3 < area(previous),
          the selection "jumped";
       3. on a jump, look at every candidate whose predicted IoU is within 0.15
          of the best score and whose area is above zero, and take the one whose
          area is closest to the previous mask's on a log scale;
       4. only accept that re-rank if it actually lands inside the 3x band;
          otherwise keep the original pick, because a genuine large edit (the
          user brushing in a whole new region) must still be allowed through.
     The 3x band is wide on purpose. One brush stroke legitimately doubles a
     mask; it does not legitimately turn a dog into the whole photograph.

     `dir` says which way the newest stroke ASKED the mask to move, and the
     guard is not allowed to fight it (PHASE-C: with prompts fed one stroke at
     a time, a Remove stroke over a centred subject legitimately takes the mask
     to nothing, and that is a 3x shrink every time. Guarding it would quietly
     restore the thing the user just brushed away, which is the exact bug this
     revision exists to fix).
       dir < 0  a Remove stroke: any shrink is intended, only growth is guarded
       dir > 0  a Keep stroke: any growth is intended, only shrinkage is guarded
       dir 0 / omitted: both directions guarded, the original behaviour. */
  function chooseCandidate(scores, areas, allowed, primary, prevArea, dir) {
    var i, k, best = primary;
    if (best == null) {
      best = allowed[0];
      for (i = 1; i < allowed.length; i++) if (scores[allowed[i]] > scores[best]) best = allowed[i];
    }
    if (!(prevArea > 0)) return { idx: best, reranked: false };
    var a = areas[best];
    var grew = a > AREA_JUMP * prevArea, shrank = a * AREA_JUMP < prevArea;
    if (dir < 0) shrank = false;
    if (dir > 0) grew = false;
    if (!grew && !shrank) return { idx: best, reranked: false };
    var topScore = scores[allowed[0]];
    for (i = 1; i < allowed.length; i++) if (scores[allowed[i]] > topScore) topScore = scores[allowed[i]];
    var pick = -1, pickErr = Infinity;
    for (i = 0; i < allowed.length; i++) {
      k = allowed[i];
      if (scores[k] < topScore - IOU_SLACK) continue;
      if (!(areas[k] > 0)) continue;
      var err = Math.abs(Math.log(areas[k] / prevArea));
      if (err < pickErr) { pickErr = err; pick = k; }
    }
    if (pick >= 0 && pick !== best && pickErr <= Math.log(AREA_JUMP)) {
      return { idx: pick, reranked: true };
    }
    return { idx: best, reranked: false };
  }

  /* Rebuild the decoder's mask_input (which lives on the model's PADDED square
     canvas) from a display-space mask (which has that padding cropped off).
     The image occupies the top-left cw x ch of a low x low grid; everything
     outside it is filled with `fill`, a confidently-outside logit. */
  function padMaskFrom(disp, dw, dh, cw, ch, low, fill) {
    var out = new Float32Array(low * low);
    var x, y, sx, sy;
    for (y = 0; y < low; y++) {
      if (y >= ch) { for (x = 0; x < low; x++) out[y * low + x] = fill; continue; }
      sy = (y + 0.5) * dh / ch - 0.5;
      for (x = 0; x < low; x++) {
        if (x >= cw) { out[y * low + x] = fill; continue; }
        sx = (x + 0.5) * dw / cw - 0.5;
        out[y * low + x] = sampleBilinearAt(disp, dw, dh, sx, sy);
      }
    }
    return out;
  }

  /* The deterministic test pattern behind the load-time model check, and the
     fixed sample positions taken from it. Integer maths only, so Python and
     JavaScript produce byte-identical pixels (both were hash-checked when the
     expected values were generated). */
  function patternRGB(size) {
    var arr = new Uint8Array(size * size * 3), i = 0, x, y;
    for (y = 0; y < size; y++) {
      for (x = 0; x < size; x++) {
        arr[i++] = (x * 7 + y * 13) & 255;
        arr[i++] = ((x * 3) ^ ((y * 5) & 255)) & 255;
        arr[i++] = ((x + y) * 11) & 255;
      }
    }
    return arr;
  }
  function gridPositions(res, n) {
    var step = Math.floor(res / n), pts = [], i, j;
    for (j = 0; j < n; j++) {
      for (i = 0; i < n; i++) pts.push([i * step + Math.floor(step / 2), j * step + Math.floor(step / 2)]);
    }
    return pts;
  }

  /* ---- is this cut worth warning about? -------------------------------
     The predicted-IoU head answers "how well does this mask match SOME object
     here", not "is this the object you wanted", and it is not calibrated for
     the second question: the bicycle photograph, where the automatic centre
     point lands on a brick wall and the cut is the whole wall, scores 0.98.
     Mask AREA is the honest proxy for that failure. A cut covering more than
     half the frame is usually the background; one under 2% is usually a
     speck. Either way the copy says so instead of claiming confidence. */
  var WEAK_IOU = 0.7, WEAK_BIG = 0.55, WEAK_SMALL = 0.02;
  function isWeakCut(iou, areaFrac) {
    if (!(iou >= WEAK_IOU)) return true;
    if (areaFrac == null || !(areaFrac >= 0)) return false;   /* area unknown: score alone */
    return areaFrac > WEAK_BIG || areaFrac < WEAK_SMALL;
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

  /* opts.prev is the mask this call refines: the SAME sequential contract the
     real decoder runs on (previous low-res logits in, newest stroke's points
     only). Without it the mock would answer a different question from the
     model and the deterministic suite would stop being evidence about the
     shipped tool. With a previous mask present a call carrying only negative
     points is meaningful (carve), so the centre point is injected only when
     there is genuinely nothing to refine. */
  function mockSegment(pix, w, h, prompts, opts) {
    opts = opts || {};
    var tol2 = opts.tol2 == null ? 0.02 : opts.tol2;
    var K = opts.K == null ? 8 : opts.K;
    var prev = opts.prev && opts.prev.length === w * h ? opts.prev : null;
    var n = w * h, i;
    var keep = new Uint8Array(n);
    if (prev) for (i = 0; i < n; i++) keep[i] = prev[i] > 0 ? 1 : 0;
    var pos = [], neg = [];
    for (i = 0; i < (prompts || []).length; i++) {
      (prompts[i].label ? pos : neg).push(prompts[i]);
    }
    if (!pos.length && !prev) pos = [{ x: 0.5, y: 0.5, label: 1 }];
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
    return { logits: logits, area: area, frac: frac, iou: iou };
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
    SWATH_FRAC: SWATH_FRAC,
    swathOffsets: swathOffsets,
    swathPrompts: swathPrompts,
    bilinearUpsample: bilinearUpsample,
    sampleBilinearAt: sampleBilinearAt,
    threshold: threshold,
    boxFilter: boxFilter,
    guidedCoeffs: guidedCoeffs,
    guidedFilter: guidedFilter,
    radiusFor: radiusFor,
    releaseScratch: releaseScratch,
    grayPlane: grayPlane,
    bakeHardRows: bakeHardRows,
    bakeGuidedRows: bakeGuidedRows,
    floodFrom: floodFrom,
    mockSegment: mockSegment,
    WEAK_IOU: WEAK_IOU,
    WEAK_BIG: WEAK_BIG,
    WEAK_SMALL: WEAK_SMALL,
    isWeakCut: isWeakCut,
    AREA_JUMP: AREA_JUMP,
    IOU_SLACK: IOU_SLACK,
    areaOf: areaOf,
    chooseCandidate: chooseCandidate,
    padMaskFrom: padMaskFrom,
    patternRGB: patternRGB,
    gridPositions: gridPositions
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PURE;
  if (typeof window === 'undefined') return;          /* node stops here */

  /* ======================================================================
     2. Engine seam
     ====================================================================== */

  /* ---- what actually ships ---------------------------------------------
     MobileSAM (Apache 2.0), encoder converted to float16 and the 4-mask
     decoder left at float32, plus the onnxruntime-web WebAssembly runtime.
     All of it is served from this origin out of assets/js/segmentlib/ (see
     that directory's VENDOR-LICENSES.md). The byte counts below are the real
     file sizes: they are what the progress bar counts and what the download
     note quotes, so the number a visitor reads is the number they pay. */
  var SEG_FILES = {
    ort: 'ort.wasm.min.js',
    /* onnxruntime's Emscripten glue, vendored under a .js name. Upstream ships
       it as ort-wasm-simd-threaded.mjs, and a plain static host (the Jekyll dev
       server, and not every CDN either) answers .mjs with
       application/octet-stream, which browsers refuse to run as a module. The
       file is byte-identical; only the extension changed, and wasmPaths below
       tells ort where it went. */
    mjs: 'ort-wasm-simd-threaded.mjs.js',
    wasm: 'ort-wasm-simd-threaded.wasm',
    enc: 'cutout-encoder.v1.onnx',
    dec: 'cutout-decoder.v1.onnx',
    expected: 'cutout-expected.v1.json'
  };
  /* Progress-tracked downloads (we stream these ourselves). */
  var SEG_BYTES = { wasm: 13479978, enc: 14254548, dec: 16496559 };
  /* The loader script and the Emscripten glue module it imports; small enough
     that they are not worth a progress bar, big enough to count in the note. */
  var SEG_SHELL = 50139 + 24180;
  var SEG_TOTAL = SEG_BYTES.wasm + SEG_BYTES.enc + SEG_BYTES.dec;
  var MODEL_MB = Math.round((SEG_TOTAL + SEG_SHELL) / 1048576);

  /* Where those files live, derived from this script's own URL so the site's
     baseurl is respected. ort MUST be pointed at this directory or it quietly
     fetches its WebAssembly from a CDN, which would break the promise that
     the photo never leaves the device (nothing would leave, but a third party
     would learn the tool was used). */
  var SEG_DIR = (function () {
    var s = document.currentScript;
    if (!s || !s.src) s = document.querySelector('script[src*="imagetools-cutout.js"]');
    var src = (s && s.src) || '';
    if (!src) return 'assets/js/segmentlib/';
    return src.replace(/[?#].*$/, '').replace(/[^/]*$/, '') + 'segmentlib/';
  })();

  var COPY = {
    download: 'The cutter is a one-time download of about ' + MODEL_MB + ' MB. It runs entirely in your browser and is cached for next time.',
    weak: 'This cut is uncertain, so brush what to keep and remove.',
    ready: 'Auto cut ready. Brush over anything it got wrong.',
    /* Honest about the device, not just about the median laptop: the encoder
       pass was measured at about 10 s on this desktop and phones are slower. */
    reading: 'Reading the photo. This takes about 10 seconds on a typical computer, longer on phones.',
    inline: 'This browser will not run it in the background, so the page pauses while it works.',
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
      /* Same sequential contract as the real engine: the previous low-res mask
         is what this call refines, and `prompts` is only the newest stroke. */
      segment: function (prompts, prevLowRes) {
        if (!pix) return Promise.reject(new Error('not encoded'));
        var m = mockSegment(pix, LOW, LOW, prompts, { prev: prevLowRes || null });
        var out = { maskLogitsLowRes: m.logits, w: LOW, h: LOW, bestIoU: m.iou, area: m.frac };
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

  /* ======================================================================
     2b. The real engine: MobileSAM on onnxruntime-web.

     Everything below the seam is model plumbing. The contract it honours is
     exactly the mock's: load(onProgress) / encode(canvas) / segment(prompts,
     prevLowRes) / dispose(), plus an optional verify() that the UI uses for
     the "model verified" tick.

     Preprocessing follows the export's own contract (verified against Acly's
     export script and a Python reference):
       encoder input  = RGB float32 HWC, RAW 0..255 values, aspect-preserving
                        resize with the LONGEST SIDE at 1024. Normalization and
                        the bottom/right zero-padding to 1024x1024 are baked
                        into the graph, so we must NOT do them here.
       point coords   = pixels in that resized (pre-padding) space.
       orig_im_size   = the size we want the mask back at; the graph crops its
                        own padding away using this value's aspect ratio, which
                        is why we ask for the image aspect and not a square.
     ====================================================================== */

  var RES = 1024;                  /* the model's input resolution */
  var PARITY_TOL = 0.25;           /* measured max cross-platform delta was 0.053 */
  var PAD_LOGIT = -8;              /* stand-in mask value outside the image */

  /* Module-level so a close/reopen re-initializes without re-downloading. The
     ort sessions are NOT cached here: they are disposed on close, as pinned. */
  var ortScriptP = null, ortConfigured = false;
  var weightCache = { wasm: null, enc: null, dec: null };
  var expectedCache = null;
  var parityResult = null;         /* { state: 'ok'|'warn', maxDelta } once run */
  var proxyState = 'unknown';      /* 'worker' | 'inline' once the sessions exist */
  var PROXY_TIMEOUT_MS = 60000;    /* a worker that boots but never answers */

  function segUrl(name) { return SEG_DIR + name; }

  /* ONE plain fetch per file, read through a ReadableStream so the progress is
     real. Deliberately no Range requests: GitHub Pages/Fastly mishandle a
     ranged request for a gzipped asset. `expect` is the file's real byte count
     and is used as the denominator, because with Content-Encoding in play the
     Content-Length header counts compressed bytes while the stream delivers
     decompressed ones. */
  function fetchBuf(url, expect, onBytes) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
      if (!res.body || typeof res.body.getReader !== 'function') {
        return res.arrayBuffer().then(function (b) { onBytes(b.byteLength); return b; });
      }
      var reader = res.body.getReader(), parts = [], got = 0;
      return new Promise(function (resolve, reject) {
        (function pump() {
          reader.read().then(function (r) {
            if (r.done) {
              var out = new Uint8Array(got), off = 0, i;
              for (i = 0; i < parts.length; i++) { out.set(parts[i], off); off += parts[i].length; }
              parts = null;
              resolve(out.buffer);
              return;
            }
            parts.push(r.value); got += r.value.length;
            onBytes(r.value.length);
            pump();
          }, reject);
        })();
      });
    });
  }

  function loadOrtScript() {
    if (window.ort) return Promise.resolve(window.ort);
    if (ortScriptP) return ortScriptP;
    ortScriptP = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = segUrl(SEG_FILES.ort);
      s.async = true;
      s.onload = function () {
        if (window.ort) resolve(window.ort);
        else reject(new Error('onnxruntime loaded but did not register'));
      };
      s.onerror = function () { reject(new Error('onnxruntime could not be fetched')); };
      document.head.appendChild(s);
    });
    return ortScriptP;
  }

  function makeRealEngine() {
    if (!window.fetch || !window.WebAssembly || typeof Promise === 'undefined') return null;

    var ort = null, encSess = null, decSess = null;
    var encIn = 'input_image', encOut = 'image_embeddings';
    var decOut = ['masks', 'iou_predictions', 'low_res_masks'];
    /* The image embedding is kept as raw data, not as a Tensor: in proxy mode
       ort posts input tensors to the worker in the TRANSFER list, so the
       buffer of anything handed to run() is detached afterwards. A cached
       Tensor would work exactly once and then throw on every later stroke, so
       a fresh copy is built per call (4 MB, about a millisecond). */
    var embData = null, embDims = null, embType = 'float32';
    var srcW = 0, srcH = 0, scale = 1;    /* the encoded image and its resize */
    var rw = 0, rh = 0;                   /* resized (pre-padding) pixel size */
    var outW = 0, outH = 0;               /* the low-res grid we hand the UI */
    var lastDisp = null, lastRaw = null;  /* display mask <-> its padded twin */
    var chain = Promise.resolve();        /* one model call at a time */
    var stats = {};                       /* last measured milliseconds, per step */
    function mark(k, t0) { stats[k] = Math.round(performance.now() - t0); }

    /* ort sessions are not safe to drive concurrently and the encoder run is
       long, so every call queues behind the last one. */
    function queue(fn) {
      var run = chain.then(fn, fn);
      chain = run.then(function () {}, function () {});
      return run;
    }

    function tensor(data, dims) { return new ort.Tensor('float32', data, dims); }
    function embTensor() { return new ort.Tensor(embType, embData.slice(0), embDims); }

    async function configure() {
      ort = await loadOrtScript();
      if (!ortConfigured) {
        /* Single-threaded: GitHub Pages cannot send the COOP/COEP headers that
           SharedArrayBuffer (and therefore multi-threaded wasm) requires. */
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.simd = true;
        /* Local only, and named file by file. Without this ort resolves its
           runtime against a CDN, which is exactly the promise this tool makes
           it must not do. Absolute URLs: a bare relative prefix breaks the
           dynamic import() ort does for the glue module. */
        ort.env.wasm.wasmPaths = {
          mjs: segUrl(SEG_FILES.mjs),
          wasm: segUrl(SEG_FILES.wasm)
        };
        /* Run the model in a worker: ort's proxy mode boots one from its own
           script URL and does every model call there, which is the difference
           between a tab that keeps painting through the ten-second encoder
           pass and a tab that is frozen for it. Whether it actually works is
           decided by makeSessions below, which falls back to the main thread
           on any failure. That fallback is clean because in proxy mode the
           main thread never initializes the WebAssembly runtime at all: the
           worker holds its own copy of ort, so a failure in there leaves
           nothing poisoned here. */
        ort.env.wasm.proxy = typeof Worker !== 'undefined';
        proxyState = ort.env.wasm.proxy ? 'worker' : 'inline';
        ort.env.logLevel = 'error';
        ortConfigured = true;
      }
    }

    async function download(onProgress) {
      var done = 0, last = 0, lastAt = 0;
      function bump(n) {
        done += n;
        var now = Date.now();
        if (done - last < 262144 && now - lastAt < 400 && done < SEG_TOTAL) return;
        last = done; lastAt = now;
        if (onProgress) onProgress(Math.min(done, SEG_TOTAL), SEG_TOTAL);
      }
      /* Anything already cached counts as delivered, so a reopen shows a full
         bar instead of a bar that never moves. */
      var need = [];
      if (!weightCache.wasm) need.push('wasm'); else done += SEG_BYTES.wasm;
      if (!weightCache.enc) need.push('enc'); else done += SEG_BYTES.enc;
      if (!weightCache.dec) need.push('dec'); else done += SEG_BYTES.dec;
      if (onProgress) onProgress(done, SEG_TOTAL);
      for (var i = 0; i < need.length; i++) {
        var k = need[i];
        weightCache[k] = await fetchBuf(segUrl(SEG_FILES[k]), SEG_BYTES[k], bump);
      }
      if (onProgress) onProgress(SEG_TOTAL, SEG_TOTAL);
    }

    async function makeSessions() {
      /* Hand ort a COPY of the cached bytes. Some paths transfer the buffer
         into the wasm worker, which would detach our cache and force a second
         30 MB download on the next open (the same class of bug as pdf.js
         detaching the ArrayBuffer it is given). */
      /* We already streamed the runtime for the progress bar, so hand ort the
         bytes instead of letting it fetch the same 13 MB a second time (and
         so the number in the download note is the number actually paid). */
      if (weightCache.wasm && weightCache.wasm.byteLength) ort.env.wasm.wasmBinary = weightCache.wasm;
      var opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
      /* WebGPU is not vendored: its onnxruntime bundle costs another 13 MB of
         WebAssembly, over the budget this feature was allowed. If it is ever
         added, try 'webgpu' here first and fall back to 'wasm' on throw. */
      function mk(bytes) { return ort.InferenceSession.create(new Uint8Array(bytes.slice(0)), opts); }
      async function pair() { return [await mk(weightCache.enc), await mk(weightCache.dec)]; }
      if (!ort.env.wasm.proxy) {
        var plain = await pair();
        encSess = plain[0]; decSess = plain[1];
      } else {
        /* The worker path is not assumed to work: it is tried, and any failure
           (no worker allowed, the script refused, or a worker that boots and
           then never answers) drops back to the main thread. The tab will
           freeze during the encoder pass then, which the status says out loud
           rather than letting it look like a hang. */
        var attempt = pair(), timer = 0;
        var guard = new Promise(function (_, rej) {
          timer = setTimeout(function () { rej(new Error('the model worker did not answer')); }, PROXY_TIMEOUT_MS);
        });
        try {
          var got = await Promise.race([attempt, guard]);
          clearTimeout(timer);
          encSess = got[0]; decSess = got[1];
        } catch (e) {
          clearTimeout(timer);
          /* if the worker finishes building after we gave up on it, release
             what it built instead of stranding two models in its memory */
          attempt.then(function (late) {
            try { if (late[0] && late[0].release) late[0].release(); } catch (e2) {}
            try { if (late[1] && late[1].release) late[1].release(); } catch (e2) {}
          }, function () {});
          ort.env.wasm.proxy = false;
          proxyState = 'inline';
          var back = await pair();
          encSess = back[0]; decSess = back[1];
        }
      }
      /* read the graph's own names rather than trusting the ones written down */
      if (encSess.inputNames && encSess.inputNames.length) encIn = encSess.inputNames[0];
      if (encSess.outputNames && encSess.outputNames.length) encOut = encSess.outputNames[0];
      if (decSess.outputNames && decSess.outputNames.length >= 2) decOut = decSess.outputNames;
    }

    /* The decoder's mask_input lives on the model's PADDED square canvas, so a
       display-space mask has to be put back into that frame. The exact one is
       kept alongside the mask we handed out; after an undo (which stores a
       copy) the copy no longer matches by identity and it is rebuilt instead. */
    function maskInputFor(prev) {
      if (!prev || !prev.length) return null;
      if (prev === lastDisp && lastRaw) return lastRaw;
      if (prev.length !== outW * outH) return null;   /* not this image any more */
      return padMaskFrom(prev, outW, outH, rw * LOW / RES, rh * LOW / RES, LOW, PAD_LOGIT);
    }

    /* One decoder pass. `multimask` picks between SAM's three "what did you
       mean?" candidates (used for the automatic first cut) and its single
       whole-object head (used once the user starts brushing, which is also
       when the previous mask starts being fed back in). */
    async function decode(prompts, maskIn, multimask, outw, outh, prev) {
      var n = prompts.length, i, hasPos = false, hasNeg = false;
      var pc = new Float32Array(n * 2), pl = new Float32Array(n);
      for (i = 0; i < n; i++) {
        pc[i * 2] = prompts[i].x * srcW * scale;
        pc[i * 2 + 1] = prompts[i].y * srcH * scale;
        pl[i] = prompts[i].label ? 1 : 0;
        if (prompts[i].label) hasPos = true; else hasNeg = true;
      }
      /* one stroke per call, so this is that stroke's Keep or Remove */
      var dir = hasPos && !hasNeg ? 1 : (hasNeg && !hasPos ? -1 : 0);
      var feeds = {
        image_embeddings: embTensor(),
        point_coords: tensor(pc, [1, n, 2]),
        point_labels: tensor(pl, [1, n]),
        mask_input: tensor(maskIn || new Float32Array(LOW * LOW), [1, 1, LOW, LOW]),
        has_mask_input: tensor(new Float32Array([maskIn ? 1 : 0]), [1]),
        orig_im_size: tensor(new Float32Array([outh, outw]), [2])
      };
      var t0 = performance.now();
      var out = await decSess.run(feeds);
      mark('decodeMs', t0);
      var masks = out[decOut[0]], ious = out[decOut[1]].data;
      var low = decOut.length > 2 ? out[decOut[2]] : null;
      var nc = masks.dims[1], plane = outw * outh, k;
      var areas = new Array(nc), scores = new Array(nc);
      for (k = 0; k < nc; k++) { areas[k] = areaOf(masks.data, k * plane, plane); scores[k] = ious[k]; }
      /* index 0 is the export's single whole-object head; 1..3 are the
         multimask alternatives (SAM's own slicing convention). */
      var allowed = [], primary = null;
      for (k = 0; k < nc; k++) allowed.push(k);
      if (multimask) { allowed = nc > 1 ? [1, 2, 3].filter(function (j) { return j < nc; }) : [0]; }
      else primary = 0;
      var pick = chooseCandidate(scores, areas, allowed, primary, prev, dir);
      var disp = masks.data.slice(pick.idx * plane, (pick.idx + 1) * plane);
      var raw = null;
      if (low && low.dims && low.dims[2] === LOW) {
        raw = low.data.slice(pick.idx * LOW * LOW, (pick.idx + 1) * LOW * LOW);
      }
      return { disp: disp, raw: raw, iou: scores[pick.idx], area: areas[pick.idx], reranked: pick.reranked };
    }

    return {
      name: 'mobilesam',

      load: function (onProgress) {
        return queue(async function () {
          var t0 = performance.now();
          await configure();
          await download(onProgress);
          mark('downloadMs', t0);
          var t1 = performance.now();
          if (!encSess) await makeSessions();
          mark('sessionMs', t1);
          return true;
        });
      },

      stats: function () { return stats; },

      /* Once per image edit-state; the UI keys this off Image Studio's edit
         counter, so a crop or a rotate re-encodes and nothing else does. */
      encode: function (canvas) {
        return queue(async function () {
          srcW = canvas.width; srcH = canvas.height;
          scale = RES / Math.max(srcW, srcH);
          rw = Math.max(1, Math.round(srcW * scale));
          rh = Math.max(1, Math.round(srcH * scale));
          /* The low-res grid handed back to the UI keeps the image's aspect
             with its long side at 256, which is the decoder's own mask
             resolution. Asking for a square here would hand back the model's
             zero padding as if it were part of the photo. */
          outW = Math.max(8, Math.round(rw * LOW / RES));
          outH = Math.max(8, Math.round(rh * LOW / RES));
          var c = document.createElement('canvas');
          c.width = rw; c.height = rh;
          var x = c.getContext('2d');
          x.imageSmoothingEnabled = true;
          x.imageSmoothingQuality = 'high';
          x.drawImage(canvas, 0, 0, rw, rh);
          var d = x.getImageData(0, 0, rw, rh).data;
          c.width = 0; c.height = 0;
          var n = rw * rh, data = new Float32Array(n * 3), i;
          for (i = 0; i < n; i++) {
            data[i * 3] = d[i * 4];
            data[i * 3 + 1] = d[i * 4 + 1];
            data[i * 3 + 2] = d[i * 4 + 2];
          }
          var feed = {};
          feed[encIn] = tensor(data, [rh, rw, 3]);
          var t0 = performance.now();
          var res = await encSess.run(feed);
          mark('encodeMs', t0);
          var et = res[encOut];
          embData = et.data; embDims = et.dims; embType = et.type || 'float32';
          lastDisp = null; lastRaw = null;
          return true;
        });
      },

      segment: function (prompts, prevLowRes) {
        return queue(async function () {
          if (!embData) throw new Error('not encoded');
          var maskIn = maskInputFor(prevLowRes);
          var multimask = !prevLowRes;
          /* measured from the mask actually being refined, so an undo that
             restores an older mask compares against that older mask */
          var prevA = prevLowRes && prevLowRes.length
            ? areaOf(prevLowRes, 0, prevLowRes.length) : 0;
          var r = await decode(prompts, maskIn, multimask, outW, outH, prevA);
          lastDisp = r.disp; lastRaw = r.raw;
          return {
            maskLogitsLowRes: r.disp, w: outW, h: outH,
            bestIoU: r.iou, area: r.area, reranked: r.reranked
          };
        });
      },

      /* The load-time tick: run a fixed synthetic image and a fixed prompt
         through the shipped files and compare 64 sampled logits against the
         values the Python reference produced from the same bytes. A mismatch
         means the browser is computing something different from what was
         measured, which the page says out loud instead of pretending. */
      verify: function () {
        if (parityResult) return Promise.resolve(parityResult);
        return queue(async function () {
          if (parityResult) return parityResult;
          var tv = performance.now();
          if (!expectedCache) {
            var r = await fetch(segUrl(SEG_FILES.expected));
            if (!r.ok) throw new Error('HTTP ' + r.status);
            expectedCache = await r.json();
          }
          var want = expectedCache.mobilesam.samples;
          var pat = patternRGB(RES);
          var n = RES * RES, data = new Float32Array(n * 3), i;
          for (i = 0; i < n * 3; i++) data[i] = pat[i];
          var ef = {};
          ef[encIn] = tensor(data, [RES, RES, 3]);
          var e = await encSess.run(ef);
          var out = await decSess.run({
            image_embeddings: e[encOut],
            point_coords: tensor(new Float32Array([RES / 2, RES / 2]), [1, 1, 2]),
            point_labels: tensor(new Float32Array([1]), [1, 1]),
            mask_input: tensor(new Float32Array(LOW * LOW), [1, 1, LOW, LOW]),
            has_mask_input: tensor(new Float32Array([0]), [1]),
            orig_im_size: tensor(new Float32Array([RES, RES]), [2])
          });
          var m = out[decOut[0]], W = m.dims[3];
          var pos = gridPositions(m.dims[2], 8), max = 0;
          for (i = 0; i < pos.length && i < want.length; i++) {
            var got = m.data[pos[i][1] * W + pos[i][0]];
            var dlt = Math.abs(got - want[i]);
            if (dlt > max) max = dlt;
          }
          mark('verifyMs', tv);
          parityResult = { state: max <= PARITY_TOL ? 'ok' : 'warn', maxDelta: max, tol: PARITY_TOL };
          return parityResult;
        });
      },

      proxied: function () { return proxyState; },

      dispose: function () {
        embData = null; embDims = null; lastDisp = null; lastRaw = null;
        try { if (encSess && encSess.release) encSess.release(); } catch (e) {}
        try { if (decSess && decSess.release) decSess.release(); } catch (e) {}
        encSess = null; decSess = null;
      }
    };
  }

  /* The real engine needs streaming fetch and WebAssembly; a browser without
     them keeps the button (and the model credit) out of the page rather than
     opening a workspace with nothing behind it. */
  function engineSupported() {
    return !!(window.fetch && window.WebAssembly && typeof Promise !== 'undefined');
  }
  function engineAvailable() {
    return window.__CUTOUT_MOCK === true || engineSupported();
  }
  function newEngine() {
    if (window.__CUTOUT_MOCK === true) return makeMockEngine();
    return engineSupported() ? makeRealEngine() : null;
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
  var elVerify = id('it-cut-verify'), elStart = id('it-cut-start');
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
  var strokes = [], promptCache = null;
  /* Per-stroke mask snapshots, ascending by `n` = how many strokes are folded
     into them. snaps[0] is always the automatic cut (n = 0) and is pinned, so
     "Start over" always has something to go back to; the rest are capped at
     UNDO_MAX. Undo restores a snapshot instead of re-running the model, which
     is what makes it instant and what makes taking a stroke back land on
     exactly the mask that was on screen before it. Each one is the engine's
     low-res grid: at most 256 x 256 floats, so the whole stack is under 7 MB. */
  var snaps = [];
  var logits = null, lastIoU = 0, lastArea = -1;
  /* The engine's low-res mask grid. The mock always answers LOW x LOW; the real
     engine answers at the image's aspect ratio (long side LOW), because SAM's
     decoder crops its own padding away for us. Both come back through the same
     seam, so everything downstream just reads these two numbers. */
  var logitsW = LOW, logitsH = LOW;
  var logitsFor = -1;                      /* strokes folded into the current mask; -1 = no cut yet */
  var brush = 1;                           /* 1 = keep, 0 = remove */
  var segSeq = 0, paintSeq = 0, busy = false;
  var lastFocus = null;
  var strokeT0 = 0, lastStrokeMs = 0;      /* brush release -> preview on screen */
  var rerankCount = 0, segCount = 0, shiftCount = 0;
  var verifyTimer = 0, verifyRunning = false, lastTouch = 0;
  var VERIFY_IDLE_MS = 6000;               /* quiet time the model check waits for */

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

  /* The "model verified" tick, the same idea as the transformer page: run a
     fixed input through the shipped model and check it against the numbers the
     reference implementation produced. A mismatch is reported, not hidden, and
     never blocks the tool. */
  function showVerify(v) {
    if (!elVerify) return;
    if (!v) { elVerify.hidden = true; return; }
    elVerify.hidden = false;
    elVerify.classList.toggle('it-cut__verify--warn', v.state !== 'ok');
    elVerify.textContent = v.state === 'ok'
      ? '✓ Model verified: it produced the reference numbers in this browser.'
      : 'This browser did not reproduce the reference numbers for the model, so cutouts may differ from the ones it was tested with. The tool still works.';
  }
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

  /* Wait for the browser to actually paint. The model runs on the main thread,
     so a status set immediately before it would otherwise never reach the
     screen: the work starts in the same task and the tab is frozen for the
     whole of it, leaving the PREVIOUS message showing for ten seconds. */
  function afterPaint() {
    return new Promise(function (r) {
      requestAnimationFrame(function () { setTimeout(r, 0); });
    });
  }

  /* The guided filter's GUIDE is the photograph in grey at the coefficient
     resolution, and the photograph does not change while the workspace is
     open. Building it costs a downscale plus a getImageData readback off the
     canvas, which measured at roughly 350 ms of the 800 ms a brush stroke was
     taking: by far the largest single cost in the pipeline, and paid again on
     every stroke for an answer that was identical every time. Cached per
     (source canvas, size); cleared whenever the workspace opens or closes. */
  var guideCache = { src: null, cw: 0, ch: 0, plane: null };
  function guidePlane(src, cw, ch) {
    if (guideCache.plane && guideCache.src === src && guideCache.cw === cw && guideCache.ch === ch) {
      return guideCache.plane;
    }
    var c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    /* one draw, one read: exactly the case willReadFrequently is for */
    var x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, 0, 0, cw, ch);
    var plane = grayPlane(x.getImageData(0, 0, cw, ch).data, cw * ch);
    c.width = 0; c.height = 0;
    guideCache = { src: src, cw: cw, ch: ch, plane: plane };
    return plane;
  }

  /* Guide + binary mask at the coefficient resolution. */
  function coeffInputs(src, W, H, lg, lw, lh) {
    var s = Math.min(1, GF_MAX / Math.max(W, H));
    var cw = Math.max(8, Math.round(W * s)), ch = Math.max(8, Math.round(H * s));
    var guide = guidePlane(src, cw, ch);
    var bin = threshold(bilinearUpsample(lg, lw, lh, cw, ch), 0);
    return { guide: guide, bin: bin, cw: cw, ch: ch };
  }

  /* Writes the mask into rgba's alpha channel, chunked so a big image never
     blocks a frame. Identical maths for the live preview and for Apply;
     `stop` lets a superseded run bail out mid-way. */
  async function paintAlpha(rgba, W, H, src, lg, lw, lh, feather, stop) {
    var band = Math.max(1, Math.round(120000 / Math.max(1, W)));
    var y = 0, a = null, b = null, cw = 0, ch = 0;
    if (feather > 0) {
      var ci = coeffInputs(src, W, H, lg, lw, lh);
      var co = guidedCoeffs(ci.guide, ci.bin, ci.cw, ci.ch, radiusFor(feather, ci.cw, ci.ch), GF_EPS);
      a = co.a; b = co.b; cw = ci.cw; ch = ci.ch;
    }
    while (y < H) {
      if (stop && stop()) return false;
      var y1 = Math.min(H, y + band);
      if (feather > 0) bakeGuidedRows(rgba, W, H, a, b, cw, ch, y, y1);
      else bakeHardRows(rgba, W, H, lg, lw, lh, y, y1);
      y = y1;
      if (y < H) await yieldNow();
    }
    return true;
  }

  var painting = 0;                          /* preview repaints in flight */
  var outBuf = null;                         /* reused preview scratch, see below */
  async function refreshPreview() {
    if (!logits || !baseData) return;
    var my = ++paintSeq;
    var stale = function () { return my !== paintSeq; };
    /* A fresh ImageData per repaint is another megabyte of garbage per stroke.
       It is reused, but ONLY when no other repaint is in flight: two runs
       sharing one buffer would let a superseded one write a band of stale
       alpha into the buffer the live one is about to show. */
    var reuse = painting === 0;
    painting++;
    try {
      if (reuse && (!outBuf || outBuf.width !== PW || outBuf.height !== PH)) {
        outBuf = pvx.createImageData(PW, PH);
      }
      var out = reuse ? outBuf : pvx.createImageData(PW, PH);
      out.data.set(baseData.data);
      var done = await paintAlpha(out.data, PW, PH, srcCanvas, logits, logitsW, logitsH, featherVal(), stale);
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
      /* The points the engine actually saw. Each stroke is sampled on its own,
         because that is exactly how it was fed: one call per stroke, so only
         the per-stroke cap of 8 ever binds. A stroke that has already gone to
         the model shows the exact points it was given (which the swath shift
         can move off the centreline); one still queued shows where it would be
         sampled today. Cached, since render runs on every pointermove and the
         sampling only changes when a stroke does. */
      if (!promptCache) {
        promptCache = [];
        for (i = 0; i < strokes.length; i++) {
          promptCache = promptCache.concat(strokes[i].fed || samplePrompts([strokes[i]]));
        }
      }
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
  /* The automatic first cut is a single centre point, and that is the ONLY
     thing it is used for. Every stroke after it is a separate call carrying
     just that stroke's own sampled points plus the previous mask's low-res
     logits as mask_input, which is the iterative-refinement path SAM was
     trained on. Two things follow, both of them the point of doing it this
     way: a Remove stroke can carve a centred subject away completely (there
     is no permanent positive point holding it in), and the decoder's cost
     does not climb with the number of strokes, because it never sees more
     than one stroke's worth of points. */
  var AUTO_PROMPT = { x: 0.5, y: 0.5, label: 1 };

  /* Record the mask after `n` strokes. A new result at `n` invalidates every
     snapshot at or above it (that branch of the history is gone). */
  function pushSnap(n, lg, lw, lh, iou, area) {
    while (snaps.length && snaps[snaps.length - 1].n >= n) snaps.pop();
    snaps.push({ n: n, logits: lg.slice(), lw: lw, lh: lh, iou: iou, area: area });
    /* Cap the stack, but never drop the automatic cut at index 0. */
    while (snaps.length > UNDO_MAX + 1) snaps.splice(1, 1);
  }

  /* Restore the newest snapshot at or below `n` strokes. Usually that is
     exactly `n`; it can be lower when the user brushed faster than the engine
     answered, or past the depth cap, and then the strokes above it are folded
     back in one at a time by the pump. */
  function restoreSnap(n) {
    while (snaps.length > 1 && snaps[snaps.length - 1].n > n) snaps.pop();
    var s = snaps.length ? snaps[snaps.length - 1] : null;
    if (!s) { logits = null; logitsFor = -1; return null; }
    logits = s.logits; logitsW = s.lw; logitsH = s.lh;
    lastIoU = s.iou; lastArea = s.area; logitsFor = s.n;
    return s;
  }

  /* The one-time model check holds the engine's queue for about ten seconds.
     If a stroke lands behind it, say so instead of leaving the tool looking
     stuck. */
  function updatingMsg() {
    return verifyRunning
      ? 'Updating the cut… finishing a one-time model check first.'
      : 'Updating the cut…';
  }

  /* Fold the next unfolded stroke in, if the engine is free. */
  function pumpSegment() {
    if (!engine || !engineReady || busy || !opened) return;
    if (logitsFor < 0 || logitsFor >= strokes.length) return;
    segment(false);
  }

  /* Is any of this stroke inside the cut? Is it asking for something the cut
     does not already say?

     A Remove stroke that touches nothing but background is asking for nothing.
     Sending it to the model anyway is not harmless: measured on the bicycle
     photograph, a Remove brushed over background that was ALREADY excluded
     took the whole remaining cut with it (0.06 of the frame to 0.00), because
     the model reads one lone negative point plus the previous mask as "none
     of this", not as "leave it as it is". So a stroke that asks for nothing is
     recorded and the cut is left alone. Keep strokes get no such shortcut:
     brushing Keep inside an over-large cut is a real instruction (it tells the
     model which object it should have picked), and it must reach the model.

     The question is asked of the SWATH the brush circle painted, not of the
     bare polyline. QA drew a 64 px Remove down the outside of a mug's edge:
     the circle plainly covered the mug, the centreline missed it by about one
     percent of the width (the brush was ten times that wide), and the stroke
     was swallowed. The tool was ignoring what the user could see it doing.
     When only the swath overlaps, the points fed to the model are shifted onto
     the overlapping flank, so the decoder is prompted where the paint actually
     landed. A stroke whose centreline already overlaps is fed exactly the
     points it always was. */
  function maskInside(x, y) {
    return sampleBilinearAt(logits, logitsW, logitsH, x * logitsW - 0.5, y * logitsH - 0.5) > 0;
  }
  function strokePrompts(st) {
    var pts = samplePrompts([st]);
    if (!pts.length || st.label || !logits) return { pts: pts, redundant: false };
    var ar = imgH > 0 ? imgW / imgH : 1;
    var res = swathPrompts(pts, st.r, ar, maskInside, SWATH_FRAC);
    return { pts: res.pts, redundant: !res.hit, shifted: res.shifted };
  }

  async function segment(auto) {
    if (!engine || !engineReady) return;
    var my = ++segSeq;
    var idx = auto ? -1 : logitsFor;        /* the one stroke this call folds in */
    if (!auto && (idx < 0 || idx >= strokes.length)) return;
    var sp = auto ? null : strokePrompts(strokes[idx]);
    if (!auto && sp.redundant) {
      logitsFor = idx + 1;
      pushSnap(logitsFor, logits, logitsW, logitsH, lastIoU, lastArea);
      setStatus(logitsFor < strokes.length ? updatingMsg()
        : 'That area was already out of the cut, so nothing changed.');
      if (strokeT0 && logitsFor >= strokes.length) {
        lastStrokeMs = Math.round(performance.now() - strokeT0); strokeT0 = 0;
      }
      updateButtons();
      pumpSegment();
      return;
    }
    var prompts = auto ? [AUTO_PROMPT] : sp.pts;
    /* Remember the points this stroke was actually fed, so the prompt dots
       show where the model was prompted rather than where the centreline ran
       (they differ exactly when the swath shift above fired). */
    if (!auto) {
      strokes[idx].fed = prompts;
      promptCache = null;
      if (sp.shifted) shiftCount++;      /* how often only the swath overlapped */
    }
    var prev = auto ? null : logits;
    busy = true;
    updateButtons();
    try {
      /* let "Updating the cut…" and the disabled Apply button reach the screen
         before the decoder takes the main thread for half a second */
      await afterPaint();
      if (my !== segSeq) return;
      var res = await engine.segment(prompts, prev);
      if (my !== segSeq) return;
      segCount++;
      logits = res.maskLogitsLowRes;
      logitsW = res.w || LOW; logitsH = res.h || LOW;
      logitsFor = auto ? 0 : idx + 1;
      if (res.reranked) rerankCount++;    /* how often the area-jump guard fired */
      lastIoU = res.bestIoU || 0;
      lastArea = res.area == null ? -1 : res.area;
      pushSnap(logitsFor, logits, logitsW, logitsH, lastIoU, lastArea);
      await refreshPreview();
      if (my !== segSeq) return;
      if (auto) setStatus(isWeakCut(lastIoU, lastArea) ? COPY.weak : COPY.ready);
      else if (logitsFor < strokes.length) setStatus(updatingMsg());
      else setStatus(strokes.length === 1 ? 'Updated from 1 brush stroke.'
        : 'Updated from ' + strokes.length + ' brush strokes.');
      if (!auto && strokeT0 && logitsFor >= strokes.length) {
        lastStrokeMs = Math.round(performance.now() - strokeT0); strokeT0 = 0;
      }
    } catch (e) {
      if (my === segSeq) setStatus('The cutter could not update that. Try another stroke.');
    } finally {
      if (my === segSeq) { busy = false; updateButtons(); pumpSegment(); }
    }
  }

  function updateButtons() {
    if (elUndo) elUndo.disabled = strokes.length === 0;
    if (elStart) elStart.disabled = strokes.length === 0;
    if (elKeep) { elKeep.classList.toggle('it-btn--on', brush === 1); elKeep.setAttribute('aria-pressed', brush === 1 ? 'true' : 'false'); }
    if (elRemove) { elRemove.classList.toggle('it-btn--on', brush === 0); elRemove.setAttribute('aria-pressed', brush === 0 ? 'true' : 'false'); }
    if (elApply) elApply.disabled = !logits || busy;
  }

  /* ---- strokes --------------------------------------------------------- */
  function undoStroke() {
    if (!strokes.length) return;
    lastTouch = performance.now();
    strokes.pop();
    promptCache = null;
    segSeq++;                                 /* drop any segmentation in flight */
    busy = false;
    restoreSnap(strokes.length);
    updateButtons();
    render();
    /* The exact snapshot can be missing: brushing faster than the engine
       answers means the stroke on top never got its own mask, and past the
       depth cap the oldest ones have been dropped. Fold whatever is left back
       in rather than showing a mask that disagrees with the strokes drawn. */
    if (logitsFor !== strokes.length) {
      setStatus(updatingMsg());
      pumpSegment();
      return;
    }
    setStatus(strokes.length
      ? 'Took back a stroke. ' + strokes.length + ' left.'
      : 'Back to the automatic cut.');
    refreshPreview();
  }

  /* Throw the brushwork away and go back to the automatic cut. Cheap, because
     that cut is snapshot 0 and never gets dropped. */
  function startOver() {
    if (!strokes.length) return;
    lastTouch = performance.now();
    strokes = [];
    promptCache = null;
    drawing = null;
    segSeq++;
    busy = false;
    snaps = snaps.length ? [snaps[0]] : [];
    restoreSnap(0);
    updateButtons();
    render();
    setStatus('Back to the automatic cut.');
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
    strokeT0 = performance.now();
    strokes.push({ label: st.label, r: st.r, pts: st.pts });
    promptCache = null;
    updateButtons();
    render();
    setStatus(updatingMsg());
    /* Brushing faster than the engine answers just queues: the pump folds the
       strokes in one at a time, in order, each one refining the last. */
    pumpSegment();
  }

  if (cv) {
    cv.addEventListener('pointerdown', function (e) {
      if (!srcCanvas || !engineReady || e.button === 2) return;
      lastTouch = performance.now();
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
  if (elStart) elStart.addEventListener('click', startOver);
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
      await afterPaint();
      if (!opened) return;
      var W = srcCanvas.width, H = srcCanvas.height;
      var out = document.createElement('canvas');
      out.width = W; out.height = H;
      var ox = out.getContext('2d');
      ox.drawImage(srcCanvas, 0, 0);
      var dat = ox.getImageData(0, 0, W, H);
      await paintAlpha(dat.data, W, H, srcCanvas, logits, logitsW, logitsH, featherVal(), null);
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
    if (verifyTimer) { clearInterval(verifyTimer); verifyTimer = 0; }
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('it-cut-open');
    strokes = []; snaps = []; promptCache = null; drawing = null; hover = null; logits = null; logitsFor = -1;
    lastArea = -1;
    logitsW = LOW; logitsH = LOW;
    baseData = null; PW = 0; PH = 0;
    guideCache = { src: null, cw: 0, ch: 0, plane: null };
    releaseScratch();                            /* the guided filter's reused buffers */
    outBuf = null;
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
    strokes = []; snaps = []; promptCache = null; logits = null; logitsFor = -1; drawing = null; hover = null;
    logitsW = LOW; logitsH = LOW; lastArea = -1;
    guideCache = { src: null, cw: 0, ch: 0, plane: null };
    brush = 1; busy = false; verifyRunning = false;
    lastTouch = performance.now();
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
    /* Every step below is long enough for the workspace to be closed underneath
       it (the download is tens of megabytes and the encoder pass is seconds), so
       each resumption re-checks that this is still the engine the workspace is
       using. Without that check an interrupted load would set engineReady on an
       engine that closeWorkspace had already thrown away, and the NEXT open
       would skip loading and then encode against sessions that do not exist. */
    var eng = engine;
    function stale() { return !opened || engine !== eng; }
    /* If the workspace was closed mid-load, the load still finishes and builds
       its sessions; they have to be released or that memory is stranded. */
    function bail() {
      if (eng && eng.dispose) { try { eng.dispose(); } catch (e) {} }
      return true;
    }
    try {
      if (!engineReady) {
        await eng.load(function (done, total) {
          if (stale()) return;
          if (total > 1) setStatus('Loading the cutter… ' + Math.round(done / 1048576) + ' of ' + Math.round(total / 1048576) + ' MB');
        });
        if (stale()) return bail() && undefined;
        engineReady = true;
      }
      /* Inference normally runs in a worker; when the browser would not give
         us one, the page freezes for the encoder pass, and the status says so
         rather than looking hung. */
      var inline = eng.proxied && eng.proxied() === 'inline';
      var edit = S.editCount ? S.editCount() : 0;
      if (encodedFor !== edit) {
        setStatus(COPY.reading + (inline ? ' ' + COPY.inline : ''));
        await afterPaint();
        if (stale()) return bail() && undefined;
        await eng.encode(srcCanvas);
        if (stale()) return bail() && undefined;
        encodedFor = edit;
      }
      setStatus('Finding the subject…');
      await afterPaint();
      if (stale()) return bail() && undefined;
      await segment(true);
      if (stale()) return bail() && undefined;
      scheduleVerify(eng, stale);
    } catch (e) {
      if (stale()) { bail(); return; }
      setStatus('The cutter could not start.');
    }
  }

  /* The model check costs a whole extra encoder pass, about ten seconds, and
     every engine call goes through one queue. So it runs AFTER the first cut
     is on screen (the tick appears when it lands, a mismatch shows the same
     warning it always did) and only into a genuine lull: no stroke drawn, the
     engine idle, and six quiet seconds since the cut appeared. Once the user
     starts brushing the check is dropped for this session rather than made to
     compete with them, and the tick simply does not appear, which claims
     nothing that was not actually checked. The residual case is real and
     deliberate: someone who studies the cut for six seconds and then brushes
     waits out the check, and the status says exactly that is what is
     happening. There is no way to interrupt a model run once it starts. */
  function scheduleVerify(eng, stale) {
    if (!eng.verify) return;
    if (parityResult) { showVerify(parityResult); return; }
    /* The quiet window is measured from the moment the first cut is on screen,
       not from the click that opened the workspace: everything before this is
       the user waiting, not the user idling. */
    lastTouch = performance.now();
    if (verifyTimer) clearInterval(verifyTimer);
    function stop() { clearInterval(verifyTimer); verifyTimer = 0; }
    verifyTimer = setInterval(function () {
      if (stale()) return stop();
      if (strokes.length) return stop();          /* they are working; leave them alone */
      if (busy || drawing || painting) return;
      if (performance.now() - lastTouch < VERIFY_IDLE_MS) return;
      stop();
      var before = elStatus ? elStatus.textContent : '';
      verifyRunning = true;
      setStatus('Checking the model in the background…');
      eng.verify().then(function (v) {
        verifyRunning = false;
        if (stale()) return;
        showVerify(v);
        if (!busy && !strokes.length) setStatus(before);
      }, function () {
        verifyRunning = false;
        if (stale()) return;
        showVerify({ state: 'warn' });
        if (!busy && !strokes.length) setStatus(before);
      });
    }, 1000);
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
      /* "ready" means every stroke drawn has been folded in, not merely that
         the engine is idle: the pump runs one segmentation per stroke. */
      ready: function () {
        return opened && engineReady && !!logits && !busy && painting === 0
          && logitsFor === strokes.length;
      },
      strokeCount: function () { return strokes.length; },
      undoDepth: function () { return strokes.length; },
      snapCount: function () { return snaps.length; },
      snapNs: function () { return snaps.map(function (s) { return s.n; }); },
      iou: function () { return lastIoU; },
      area: function () { return lastArea; },
      weak: function () { return isWeakCut(lastIoU, lastArea); },
      status: function () { return elStatus ? elStatus.textContent : ''; },
      brush: function () { return brush; },
      engineName: function () { return engine ? engine.name : ''; },
      proxied: function () { return engine && engine.proxied ? engine.proxied() : 'n/a'; },
      stats: function () {
        var s = engine && engine.stats ? engine.stats() : {};
        s.strokeToPreviewMs = lastStrokeMs;
        s.rerankCount = rerankCount;
        s.segCount = segCount;
        s.shiftCount = shiftCount;   /* strokes fed from the swath, not the centreline */
        return s;
      },
      logitSize: function () { return [logitsW, logitsH]; },
      verified: function () {
        if (!elVerify || elVerify.hidden) return 'none';
        return elVerify.classList.contains('it-cut__verify--warn') ? 'warn' : 'ok';
      },
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
