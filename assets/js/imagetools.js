/* ==========================================================================
   Image Studio — a private, in-browser image utility.
   --------------------------------------------------------------------------
   Resize an image down to a target file size (for those forms that demand
   "under 1 MB" or "max 100 KB"), crop, rotate, flip, convert format, and
   generate a full favicon pack as a .zip. EVERYTHING runs locally — the image
   never leaves your browser. Re-encoding through a canvas also drops EXIF
   metadata (camera, GPS, timestamps), so saved images are stripped clean.

   No external libraries: PNG/JPEG/WebP encoding is the browser's own, and the
   .zip is written by a tiny store-method ZIP writer below.
   ========================================================================== */
(function () {
  function id(x) { return document.getElementById(x); }
  var drop = id('it-drop'); if (!drop) return;
  var disp = id('it-canvas'), dctx = disp ? disp.getContext('2d') : null;

  /* full-resolution working image (edits are applied here); `orig` is the reset point */
  var work = document.createElement('canvas'), wctx = work.getContext('2d');
  var orig = document.createElement('canvas');
  var loaded = false;
  var fineAngle = 0;                 // live free-rotation preview (degrees), baked on release
  var history = [];                  // undo stack of prior `work` states

  /* ---------- undo ---------- */
  function snapshot() { var c = document.createElement('canvas'); c.width = work.width; c.height = work.height; c.getContext('2d').drawImage(work, 0, 0); return c; }
  function pushHistory() { history.push(snapshot()); if (history.length > 25) history.shift(); var u = id('it-undo'); if (u) u.disabled = false; }
  function restore(c) { work.width = c.width; work.height = c.height; wctx.setTransform(1, 0, 0, 1, 0, 0); wctx.clearRect(0, 0, c.width, c.height); wctx.drawImage(c, 0, 0); }
  function undo() {
    if (!history.length) return;
    restore(history.pop());
    fineAngle = 0;
    var u = id('it-undo'); if (u) u.disabled = history.length === 0;
    cropRect = null; setCropping(false); render(); updateInfo();
  }

  /* ---------- free rotation ---------- */
  function flattenedCanvas() {
    if (Math.abs(fineAngle) < 0.001) return work;
    var rad = fineAngle * Math.PI / 180, w = work.width, h = work.height;
    var cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
    var nw = Math.ceil(w * cos + h * sin), nh = Math.ceil(w * sin + h * cos);
    var c = document.createElement('canvas'); c.width = nw; c.height = nh;
    var x = c.getContext('2d');
    if (elFmt && elFmt.value !== 'png') { x.fillStyle = '#ffffff'; x.fillRect(0, 0, nw, nh); }  /* white corners for JPEG/WebP */
    x.translate(nw / 2, nh / 2); x.rotate(rad); x.imageSmoothingQuality = 'high'; x.drawImage(work, -w / 2, -h / 2);
    return c;
  }
  function bakeRotation() { if (Math.abs(fineAngle) < 0.001) return; restore(flattenedCanvas()); fineAngle = 0; }

  /* ---------- tiny CRC32 + store-only ZIP writer ---------- */
  var CRC = (function () { var t = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
  function crc32(buf) { var c = 0xFFFFFFFF; for (var i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zipStore(files) {
    var enc = new TextEncoder(), parts = [], central = [], offset = 0, i;
    for (i = 0; i < files.length; i++) {
      var name = enc.encode(files[i].name), data = files[i].data, crc = crc32(data);
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      var cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
      cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
      cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), name);
      offset += 30 + name.length + data.length;
    }
    var cdSize = 0; for (i = 0; i < central.length; i++) cdSize += central[i].length;
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]), { type: 'application/zip' });
  }

  /* ---------- helpers ---------- */
  function toBlob(canvas, type, q) { return new Promise(function (r) { canvas.toBlob(r, type, q); }); }
  function scaledCanvas(src, scale) {
    if (scale >= 0.999) return src;
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.width * scale)); c.height = Math.max(1, Math.round(src.height * scale));
    var x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  function fmtBytes(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB'; }

  /* ---------- load ---------- */
  function loadFile(file) {
    var st = id('it-status');
    if (!file || !/^image\//.test(file.type)) { if (st) st.textContent = 'That doesn’t look like an image file.'; return; }
    var url = URL.createObjectURL(file);
    var im = new Image();
    im.onerror = function () { URL.revokeObjectURL(url); if (st) st.textContent = 'Could not read that image (unsupported or corrupt).'; };
    im.onload = function () {
      work.width = im.naturalWidth; work.height = im.naturalHeight;
      wctx.drawImage(im, 0, 0);
      orig.width = work.width; orig.height = work.height;
      orig.getContext('2d').drawImage(work, 0, 0);
      URL.revokeObjectURL(url);
      loaded = true; cropRect = null; cropping = false; fineAngle = 0; history = [];
      var u = id('it-undo'); if (u) u.disabled = true;
      var rh = id('it-rot-hint'); if (rh) rh.textContent = '· drag the dot above the image to rotate';
      drop.classList.add('it-drop--has');
      requestAnimationFrame(function () { render(); updateInfo(); });   /* render after layout settles */
    };
    im.src = url;
  }
  drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('it-drop--over'); });
  drop.addEventListener('dragleave', function () { drop.classList.remove('it-drop--over'); });
  drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('it-drop--over'); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
  var fileInput = id('it-file');
  if (fileInput) fileInput.addEventListener('change', function () { if (fileInput.files[0]) loadFile(fileInput.files[0]); });
  drop.addEventListener('click', function (e) { if (!loaded && fileInput) fileInput.click(); });

  /* ---------- preview render (fit work canvas into the display) + crop overlay ---------- */
  var viewScale = 1, viewX = 0, viewY = 0;
  function render() {
    if (!dctx) return;
    var maxW = disp.clientWidth || 600, maxH = 420;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var bw = Math.round(maxW * dpr), bh = Math.round(maxH * dpr);
    /* only reallocate the backing store when the size actually changed (render runs every pointermove) */
    if (disp.width !== bw || disp.height !== bh) { disp.width = bw; disp.height = bh; }
    dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dctx.clearRect(0, 0, maxW, maxH);
    if (!loaded) return;
    var src = flattenedCanvas();          /* shows the live free-rotation preview */
    viewScale = Math.min(maxW / src.width, (maxH - 52) / src.height, 1);   /* leave room for the rotate handle */
    var w = src.width * viewScale, h = src.height * viewScale;
    viewX = (maxW - w) / 2; viewY = (maxH - h) / 2;
    /* checker so transparency is visible */
    dctx.fillStyle = 'rgba(127,127,127,0.10)'; dctx.fillRect(viewX, viewY, w, h);
    dctx.drawImage(src, viewX, viewY, w, h);
    if (cropRect) {
      dctx.fillStyle = 'rgba(0,0,0,0.45)';
      dctx.fillRect(viewX, viewY, w, h);
      var r = cropDisp();
      dctx.clearRect(r.x, r.y, r.w, r.h);
      dctx.drawImage(work, (r.x - viewX) / viewScale, (r.y - viewY) / viewScale, r.w / viewScale, r.h / viewScale, r.x, r.y, r.w, r.h);
      dctx.strokeStyle = '#82a6cc'; dctx.lineWidth = 1.5; dctx.strokeRect(r.x, r.y, r.w, r.h);
    }
    /* rotation gizmo: a handle above the image you drag to rotate freely */
    if (!cropping) {
      var cx = viewX + w / 2, cy = viewY + h / 2;
      centerPos = { x: cx, y: cy };
      var rr = Math.min(w, h) / 2 + 18;
      var rad = (-90 + fineAngle) * Math.PI / 180;
      var hx = cx + rr * Math.cos(rad), hy = cy + rr * Math.sin(rad);
      handlePos = { x: hx, y: hy };
      dctx.strokeStyle = 'rgba(130,166,204,0.85)'; dctx.lineWidth = 1.5;
      dctx.beginPath(); dctx.moveTo(cx, cy); dctx.lineTo(hx, hy); dctx.stroke();
      dctx.fillStyle = 'rgba(130,166,204,0.9)'; dctx.beginPath(); dctx.arc(cx, cy, 3, 0, 6.2832); dctx.fill();
      dctx.fillStyle = '#82a6cc'; dctx.strokeStyle = '#fff'; dctx.lineWidth = 1.5;
      dctx.beginPath(); dctx.arc(hx, hy, 7, 0, 6.2832); dctx.fill(); dctx.stroke();
      if (Math.abs(fineAngle) > 0.5) {
        dctx.fillStyle = 'rgba(127,127,127,0.95)'; dctx.font = '12px "Source Sans 3", system-ui, sans-serif';
        dctx.textAlign = 'left'; dctx.textBaseline = 'middle'; dctx.fillText(Math.round(fineAngle) + '°', hx + 11, hy);
      }
    } else { handlePos = null; }
  }
  window.addEventListener('resize', function () { if (loaded) render(); });

  /* ---------- crop ---------- */
  var cropRect = null, cropping = false, cdrag = null, rotating = false;
  var centerPos = null, handlePos = null;
  function cropDisp() { return { x: viewX + cropRect.x * viewScale, y: viewY + cropRect.y * viewScale, w: cropRect.w * viewScale, h: cropRect.h * viewScale }; }
  function dispToWork(px, py) { return { x: (px - viewX) / viewScale, y: (py - viewY) / viewScale }; }
  if (disp) {
    disp.addEventListener('pointerdown', function (e) {
      if (!loaded) return;
      var r = disp.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      if (cropping) {
        var p = dispToWork(px, py);
        cdrag = { x0: Math.max(0, Math.min(work.width, p.x)), y0: Math.max(0, Math.min(work.height, p.y)) };
        cropRect = { x: cdrag.x0, y: cdrag.y0, w: 0, h: 0 };
        try { disp.setPointerCapture(e.pointerId); } catch (er) {}
        e.preventDefault(); return;
      }
      if (handlePos && Math.hypot(px - handlePos.x, py - handlePos.y) < 18) {   /* grab the rotate handle */
        rotating = true; try { disp.setPointerCapture(e.pointerId); } catch (er2) {}
        e.preventDefault();
      }
    });
    disp.addEventListener('pointermove', function (e) {
      var r = disp.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      if (cdrag) {
        var p = dispToWork(px, py);
        var x1 = Math.max(0, Math.min(work.width, p.x)), y1 = Math.max(0, Math.min(work.height, p.y));
        cropRect = { x: Math.min(cdrag.x0, x1), y: Math.min(cdrag.y0, y1), w: Math.abs(x1 - cdrag.x0), h: Math.abs(y1 - cdrag.y0) };
        render();
      } else if (rotating && centerPos) {
        var a = Math.atan2(py - centerPos.y, px - centerPos.x) * 180 / Math.PI + 90;   /* handle straight up = 0° */
        while (a > 180) a -= 360; while (a < -180) a += 360;
        fineAngle = a; render();
      }
    });
    disp.addEventListener('pointerup', function () {
      cdrag = null;
      if (rotating) {
        rotating = false;
        if (Math.abs(fineAngle) > 0.001) { pushHistory(); bakeRotation(); }
        render(); updateInfo(); return;
      }
      /* crop applies immediately on release — no separate "apply" step (Undo reverts it) */
      if (cropping && cropRect && cropRect.w > 4 && cropRect.h > 4) {
        pushHistory();
        var c = document.createElement('canvas'); c.width = Math.round(cropRect.w); c.height = Math.round(cropRect.h);
        c.getContext('2d').drawImage(work, cropRect.x, cropRect.y, cropRect.w, cropRect.h, 0, 0, c.width, c.height);
        restore(c);
        setCropping(false); updateInfo();
      }
    });
    disp.addEventListener('pointermove', function (e) {   /* hover cursor over the handle */
      if (cropping || rotating || cdrag || !handlePos) return;
      var r = disp.getBoundingClientRect();
      disp.style.cursor = (Math.hypot(e.clientX - r.left - handlePos.x, e.clientY - r.top - handlePos.y) < 18) ? 'grab' : 'default';
    });
  }
  function setCropping(on) {
    cropping = on; if (disp) disp.style.cursor = on ? 'crosshair' : 'default';
    var cb = id('it-crop'); if (cb) cb.classList.toggle('it-btn--on', on);
    if (on) bakeRotation();          /* crop works on the un-rotated (baked) image */
    else cropRect = null;
    render();
  }
  id('it-crop').addEventListener('click', function () { if (loaded) setCropping(!cropping); });
  id('it-undo').addEventListener('click', undo);

  /* ---------- rotate / flip (90° + free-angle slider) ---------- */
  function rotate(dir) {
    if (!loaded) return; pushHistory(); bakeRotation();
    var c = document.createElement('canvas'); c.width = work.height; c.height = work.width;
    var x = c.getContext('2d'); x.translate(c.width / 2, c.height / 2); x.rotate(dir * Math.PI / 2);
    x.drawImage(work, -work.width / 2, -work.height / 2);
    restore(c); cropRect = null; render(); updateInfo();
  }
  function flip(h) {
    if (!loaded) return; pushHistory(); bakeRotation();
    var c = document.createElement('canvas'); c.width = work.width; c.height = work.height;
    var x = c.getContext('2d'); x.translate(h ? c.width : 0, h ? 0 : c.height); x.scale(h ? -1 : 1, h ? 1 : -1); x.drawImage(work, 0, 0);
    restore(c); cropRect = null; render();
  }
  /* free-angle rotation is done by dragging the on-image handle (see the pointer
     handlers above); the 90° buttons are still here for quick quarter turns. */
  window.addEventListener('keydown', function (e) { if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); } });
  id('it-rot-l').addEventListener('click', function () { rotate(-1); });
  id('it-rot-r').addEventListener('click', function () { rotate(1); });
  id('it-flip-h').addEventListener('click', function () { flip(true); });
  id('it-flip-v').addEventListener('click', function () { flip(false); });
  id('it-reset').addEventListener('click', function () {
    if (!loaded) return;
    pushHistory();
    work.width = orig.width; work.height = orig.height; wctx.setTransform(1, 0, 0, 1, 0, 0); wctx.clearRect(0, 0, orig.width, orig.height); wctx.drawImage(orig, 0, 0);
    fineAngle = 0;
    setCropping(false); render(); updateInfo();
  });

  /* ---------- export controls ---------- */
  var elFmt = id('it-format'), elMode = id('it-mode'), elQual = id('it-qual'), elQualV = id('it-qual-val');
  var elMax = id('it-maxdim'), elTarget = id('it-target'), elTargetV = id('it-target-val');
  var elQualRow = id('it-qual-row'), elTargetRow = id('it-target-row');
  function typeStr() { return elFmt.value === 'png' ? 'image/png' : elFmt.value === 'webp' ? 'image/webp' : 'image/jpeg'; }
  function syncModeUI() {
    var target = elMode.value === 'target';
    elTargetRow.style.display = target ? '' : 'none';
    elQualRow.style.display = (!target && elFmt.value !== 'png') ? '' : 'none';
  }
  if (elQual) elQual.addEventListener('input', function () { elQualV.textContent = (+elQual.value).toFixed(2); });
  if (elTarget) elTarget.addEventListener('input', function () { elTargetV.textContent = (+elTarget.value) + ' KB'; });
  if (elFmt) elFmt.addEventListener('change', syncModeUI);
  if (elMode) elMode.addEventListener('change', syncModeUI);

  function exportSource() {
    /* apply max-dimension cap (longest side) before encoding */
    var maxd = Math.max(1, parseInt(elMax.value, 10) || work.width);
    var longest = Math.max(work.width, work.height);
    var scale = longest > maxd ? maxd / longest : 1;
    var scaled = scaledCanvas(work, scale);
    if (typeStr() === 'image/png') return scaled;   /* png keeps alpha */
    /* JPEG/WebP: flatten transparency onto white (canvas composites transparent pixels to black otherwise) */
    var c = document.createElement('canvas'); c.width = scaled.width; c.height = scaled.height;
    var x = c.getContext('2d'); x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(scaled, 0, 0);
    return c;
  }
  async function encodeToTarget(src, type, targetBytes) {
    /* toBlob can return null (not throw) when the canvas is too big for the
       browser to encode — guard every result so one null doesn't crash the
       search or clobber an earlier usable blob. */
    var scale = 1, best = null;
    for (var attempt = 0; attempt < 7; attempt++) {
      var c = scaledCanvas(src, scale);
      if (type === 'image/png') {
        var p = await toBlob(c, type);                /* png: quality not adjustable → downscale only */
        if (p) { best = p; if (p.size <= targetBytes) return p; }
      } else {
        var lo = 0.25, hi = 0.95, b = await toBlob(c, type, hi);
        if (b && b.size <= targetBytes) return b;
        if (b) {
          for (var it = 0; it < 8; it++) { var mid = (lo + hi) / 2; b = await toBlob(c, type, mid); if (b && b.size <= targetBytes) { best = b; lo = mid; } else hi = mid; }
          if (best && best.size <= targetBytes) return best;
        }
      }
      scale *= 0.8;
    }
    return best;
  }
  async function buildExport() {
    var src = exportSource(), type = typeStr(), blob, encodeFailed = false;
    if (elMode.value === 'target') {
      blob = await encodeToTarget(src, type, (+elTarget.value) * 1024);
      /* Distinguish "couldn't reach the target size" from "the browser refused
         to encode this canvas at all" (typically an image beyond canvas limits):
         if a plain encode of the export canvas also yields null, it's the latter. */
      if (!blob) encodeFailed = (await toBlob(src, type, type === 'image/png' ? undefined : 0.8)) === null;
    } else {
      blob = await toBlob(src, type, type === 'image/png' ? undefined : +elQual.value);
      encodeFailed = !blob;
    }
    return { blob: blob, w: src.width, h: src.height, encodeFailed: encodeFailed };
  }
  id('it-download').addEventListener('click', async function () {
    if (!loaded) return;
    var st = id('it-status'); st.textContent = 'Encoding…';
    var r = await buildExport();
    if (!r.blob) {
      st.textContent = r.encodeFailed
        ? 'This image is too large for your browser to re-encode. Try the max-dimension setting in Advanced first.'
        : 'Could not reach that size even at lowest quality.';
      return;
    }
    var ext = elFmt.value === 'png' ? 'png' : elFmt.value === 'webp' ? 'webp' : 'jpg';
    downloadBlob(r.blob, 'image-' + r.w + 'x' + r.h + '.' + ext);
    st.textContent = 'Saved ' + r.w + '×' + r.h + ' · ' + fmtBytes(r.blob.size) + ' (metadata stripped).';
  });

  var infoSeq = 0;
  async function updateInfo() {
    if (!loaded) return;
    id('it-dims').textContent = work.width + ' × ' + work.height + ' px';
    /* live estimate of the export size — guard against overlapping async runs (slider drag) */
    var my = ++infoSeq;
    var r = await buildExport();
    if (my !== infoSeq) return;   /* a newer request superseded this one */
    if (r && r.blob) id('it-estimate').textContent = 'Output: ' + r.w + '×' + r.h + ' · ~' + fmtBytes(r.blob.size);
  }
  /* recompute the estimate when controls change */
  ['it-format', 'it-mode', 'it-qual', 'it-maxdim', 'it-target'].forEach(function (k) {
    var e = id(k); if (e) e.addEventListener('input', function () { if (loaded) updateInfo(); });
  });

  /* ---------- favicon pack ---------- */
  var FAV_PNG = [16, 32, 48, 96, 192, 512];
  var APPLE = [180];
  function squareSource() {
    /* center-crop the work canvas to a square so icons aren't distorted */
    var s = Math.min(work.width, work.height);
    var c = document.createElement('canvas'); c.width = s; c.height = s;
    c.getContext('2d').drawImage(work, (work.width - s) / 2, (work.height - s) / 2, s, s, 0, 0, s, s);
    return c;
  }
  async function iconBlob(square, size) {
    var c = document.createElement('canvas'); c.width = size; c.height = size;
    var x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(square, 0, 0, size, size);
    return await toBlob(c, 'image/png');
  }
  async function blobBytes(b) { return new Uint8Array(await b.arrayBuffer()); }
  id('it-favicon').addEventListener('click', async function () {
    if (!loaded) return;
    var st = id('it-status'); st.textContent = 'Building favicon pack…';
    var sq = squareSource(), files = [], i, b;
    for (i = 0; i < FAV_PNG.length; i++) { b = await iconBlob(sq, FAV_PNG[i]); files.push({ name: 'favicon-' + FAV_PNG[i] + 'x' + FAV_PNG[i] + '.png', data: await blobBytes(b) }); }
    for (i = 0; i < APPLE.length; i++) { b = await iconBlob(sq, APPLE[i]); files.push({ name: 'apple-touch-icon.png', data: await blobBytes(b) }); }
    var enc = new TextEncoder();
    var manifest = { name: 'My Site', icons: [{ src: '/favicon-192x192.png', sizes: '192x192', type: 'image/png' }, { src: '/favicon-512x512.png', sizes: '512x512', type: 'image/png' }] };
    files.push({ name: 'site.webmanifest', data: enc.encode(JSON.stringify(manifest, null, 2)) });
    var html = [
      '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">',
      '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">',
      '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">',
      '<link rel="icon" type="image/png" sizes="192x192" href="/favicon-192x192.png">',
      '<link rel="manifest" href="/site.webmanifest">'
    ].join('\n');
    files.push({ name: 'snippet.html', data: enc.encode(html) });
    downloadBlob(zipStore(files), 'favicon-pack.zip');
    st.textContent = 'Favicon pack saved: ' + files.length + ' files (PNGs, manifest, and the <link> snippet).';
  });

  function downloadBlob(blob, name) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  syncModeUI();
})();
