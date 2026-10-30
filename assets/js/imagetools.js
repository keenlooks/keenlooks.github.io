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
  /* Bumped every time the working image changes (load, crop, rotate, flip,
     reset, undo, or an applyEdit from another module). The cutout tool keys
     its cached image embedding on it, so any edit invalidates that cache. */
  var editSeq = 0;
  /* A module that edits the image can also have to change the export format as
     part of that edit (the cutout switches JPEG to PNG, since JPEG cannot hold
     transparency). It records the switch against the history step it just
     added, so taking that step back takes the format with it and leaves a
     manual choice alone. */
  var fmtSwitch = null;              /* { depth: history.length at that step, from: 'jpeg' } */

  /* ---------- undo ---------- */
  function snapshot() { var c = document.createElement('canvas'); c.width = work.width; c.height = work.height; c.getContext('2d').drawImage(work, 0, 0); return c; }
  function pushHistory() {
    history.push(snapshot());
    /* the oldest step drops off the cap, and the recorded format switch moves
       down with it (or goes, if it was the one that fell off) */
    if (history.length > 25) { history.shift(); if (fmtSwitch && --fmtSwitch.depth <= 0) fmtSwitch = null; }
    var u = id('it-undo'); if (u) u.disabled = false;
  }
  function restore(c) { work.width = c.width; work.height = c.height; wctx.setTransform(1, 0, 0, 1, 0, 0); wctx.clearRect(0, 0, c.width, c.height); wctx.drawImage(c, 0, 0); editSeq++; }
  function undo() {
    /* a keyboard turn still being previewed is not a history step yet: Undo drops it */
    if (keyRotTimer) { clearTimeout(keyRotTimer); keyRotTimer = 0; fineAngle = 0; render(); return; }
    if (!history.length) return;
    if (fmtSwitch && fmtSwitch.depth === history.length) {
      if (elFmt) { elFmt.value = fmtSwitch.from; syncModeUI(); }
      fmtSwitch = null;
    }
    restore(history.pop());
    fineAngle = 0;
    var u = id('it-undo'); if (u) u.disabled = history.length === 0;
    cropRect = null; setCropping(false); render(); updateInfo();
    var st = id('it-status'); if (st) st.textContent = 'Took back the last change.';
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
  /* MS-DOS time and date of "now" in local time, as unzip expects (a zero
     date lists as 1980-00-00 and extracts as 1979/1980) */
  function dosStamp(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }
  function zipStore(files) {
    var enc = new TextEncoder(), parts = [], central = [], offset = 0, i, ds = dosStamp(new Date());
    for (i = 0; i < files.length; i++) {
      var name = enc.encode(files[i].name), data = files[i].data, crc = crc32(data);
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true);
      lh.setUint16(10, ds.time, true); lh.setUint16(12, ds.date, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      var cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
      cd.setUint16(12, ds.time, true); cd.setUint16(14, ds.date, true);
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
  /* KB and MB are 1,000 and 1,000,000 bytes, the unit Finder and most upload
     forms use; the target slider means the same unit (see buildExport) */
  /* Readouts follow the visitor's locale through Intl ("1,234.5 KB" in en-US,
     "1.234,5 KB" in de-DE); pixel sizes are never grouped ("4000×4000"). */
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
  var NF_INT = nf({ maximumFractionDigits: 0 }), NF_PX = nf({ maximumFractionDigits: 0, useGrouping: false });
  var NF_D1 = nf({ minimumFractionDigits: 1, maximumFractionDigits: 1 }), NF_D2 = nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 });
  /* Arabic-Indic digits (ar-SA) inside an English sentence get reordered by the
     bidi algorithm ("1200×800" shows as "800×1200"): wrap them in an isolate */
  function iso(t) { return /[\u0600-\u06FF\u200F\u061C]/.test(t) ? '\u2066' + t + '\u2069' : t; }
  /* digits given: rounded by toFixed first (Intl would round "135.95" up where toFixed rounds the binary value) */
  function fmtN(f, v, digits) { return iso(f ? f.format(digits == null ? v : +v.toFixed(digits)) : (digits == null ? String(v) : v.toFixed(digits))); }
  function px(v) { return fmtN(NF_PX, v); }
  function wxh(w, h, sep) { return px(w) + (sep || '×') + px(h); }
  function fmtBytes(n) { return n < 1000 ? fmtN(NF_INT, n) + ' B' : n < 1e6 ? fmtN(NF_D1, n / 1000, 1) + ' KB' : fmtN(NF_D2, n / 1e6, 2) + ' MB'; }
  /* "Scan of receipt (2).JPG" -> "Scan of receipt (2)", safe as a file name base
     (the same rule PDF Toolbench uses) */
  function baseName(name) {
    var b = String(name || '').replace(/\.[^.]*$/, '');
    b = b.replace(/[\/\\:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim();
    var chars = Array.from(b);
    if (chars.length > 60) b = chars.slice(0, 60).join('').trim();
    return b || 'image';
  }

  /* ---------- load ---------- */
  /* Pixel size from the file header (PNG IHDR, JPEG SOF, GIF, WebP VP8X), read
     before decoding: a valid image past the browser's canvas limit fails to
     decode, and "corrupt" would be the wrong thing to tell the visitor. */
  function headerDims(u) {
    function be16(i) { return (u[i] << 8) | u[i + 1]; }
    function le24(i) { return u[i] | (u[i + 1] << 8) | (u[i + 2] << 16); }
    if (u.length >= 24 && u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4E && u[3] === 0x47) {
      return { w: ((u[16] << 24) >>> 0) + (u[17] << 16) + be16(18), h: ((u[20] << 24) >>> 0) + (u[21] << 16) + be16(22) };
    }
    if (u.length >= 10 && u[0] === 0x47 && u[1] === 0x49 && u[2] === 0x46) return { w: u[6] | (u[7] << 8), h: u[8] | (u[9] << 8) };
    if (u.length >= 30 && u[0] === 0x52 && u[8] === 0x57 && u[12] === 0x56 && u[13] === 0x50 && u[14] === 0x38 && u[15] === 0x58) {
      return { w: 1 + le24(24), h: 1 + le24(27) };
    }
    if (u.length >= 4 && u[0] === 0xFF && u[1] === 0xD8) {
      var i = 2;
      while (i + 9 < u.length) {
        if (u[i] !== 0xFF) return null;
        var m = u[i + 1];
        if (m === 0xFF) { i++; continue; }
        if (m === 0x01 || (m >= 0xD0 && m <= 0xD8)) { i += 2; continue; }
        if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { w: be16(i + 7), h: be16(i + 5) };
        i += 2 + be16(i + 2);
      }
    }
    return null;
  }
  /* Chrome's and Safari's canvas cap (Firefox's is about the same): 32,767 px
     a side, 268 million pixels in all */
  function tooBig(d) { return !!d && (d.w > 32767 || d.h > 32767 || d.w * d.h > 268435456); }
  function tooBigLine(d) { return 'This image is ' + wxh(d.w, d.h, ' × ') + ' px, larger than your browser can open. Resize it first.'; }
  var srcName = '';                  /* the loaded file's name, for the export name */
  function loadFile(file) {
    var st = id('it-status');
    var fname = (file && file.name) || '';
    /* some systems give HEIC/AVIF files an empty type; let the extension vouch for them */
    if (!file || !(/^image\//.test(file.type) || /\.(heic|heif|avif)$/i.test(fname))) { if (st) st.textContent = 'That doesn’t look like an image file.'; return; }
    /* the first 512 KB holds the header even behind a large EXIF block */
    var head = file.slice(0, 524288);
    (head.arrayBuffer ? head.arrayBuffer() : Promise.reject())
      .then(function (ab) { return headerDims(new Uint8Array(ab)); }, function () { return null; })
      .then(function (d) {
        if (tooBig(d)) { if (st) st.textContent = tooBigLine(d); return; }
        decodeFile(file, d);
      });
  }
  function decodeFile(file, hdr) {
    var st = id('it-status');
    var fname = (file && file.name) || '';
    var isHeic = /\.(heic|heif)$/i.test(fname) || /heic|heif/i.test((file && file.type) || '');
    var url = URL.createObjectURL(file);
    var im = new Image();
    im.onerror = function () {
      URL.revokeObjectURL(url);
      if (st) st.textContent = isHeic
        ? 'This browser cannot open HEIC photos (Safari can). Save the photo as a JPEG first, then choose that.'
        /* a valid header with a big pixel count: the decoder ran out of room, the file is fine */
        : (hdr && hdr.w * hdr.h > 100e6) ? tooBigLine(hdr)
        : 'Could not read that image (unsupported or corrupt).';
    };
    im.onload = function () {
      /* An SVG with HTML inside (foreignObject) taints any canvas it is drawn
         on, and a tainted canvas can never be exported: every save would hang.
         Probe on a scratch canvas first so the current image stays intact. */
      try {
        var probe = document.createElement('canvas'); probe.width = 1; probe.height = 1;
        var pctx = probe.getContext('2d'); pctx.drawImage(im, 0, 0, 1, 1); pctx.getImageData(0, 0, 1, 1);
      } catch (taint) {
        URL.revokeObjectURL(url);
        if (st) st.textContent = /svg/i.test(file.type) || /\.svg$/i.test(fname)
          ? 'This SVG embeds HTML content the browser will not let a page re-save; export it as PNG first.'
          : 'Your browser will not let this page re-save that image.';
        return;
      }
      work.width = im.naturalWidth; work.height = im.naturalHeight;
      wctx.drawImage(im, 0, 0);
      orig.width = work.width; orig.height = work.height;
      orig.getContext('2d').drawImage(work, 0, 0);
      URL.revokeObjectURL(url);
      loaded = true; cropRect = null; cropping = false; fineAngle = 0; history = []; fmtSwitch = null; editSeq++;
      srcName = fname;
      if (disp) disp.classList.remove('it-canvas--crop');
      var cbt = id('it-crop'); if (cbt) { cbt.classList.remove('it-btn--on'); cbt.setAttribute('aria-pressed', 'false'); }
      if (cropRow) cropRow.hidden = true;
      /* after a load the preview is focusable, so the arrow keys can rotate it (see keyRotate) */
      if (disp) { disp.tabIndex = 0; disp.setAttribute('aria-label', 'Image preview. The left and right arrow keys rotate it by 1 degree, or 10 with Shift.'); }
      if (st) st.textContent = '';
      var ch = id('it-choose'); if (ch) ch.textContent = 'Choose another image';
      /* the drop zone is a "choose a file" button only while it is empty; after
         a load the canvas inside it is for cropping and rotating, and the
         Choose another image button takes over */
      var hadFocus = document.activeElement === drop;
      drop.removeAttribute('role'); drop.removeAttribute('tabindex'); drop.removeAttribute('aria-label');
      if (hadFocus && ch) ch.focus();
      var u = id('it-undo'); if (u) u.disabled = true;
      var cb = id('it-cutout'); if (cb) cb.disabled = false;
      var db = id('it-download'); if (db) { db.disabled = false; db.removeAttribute('title'); }
      var fb = id('it-favicon'); if (fb) { fb.disabled = false; fb.removeAttribute('title'); }
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
  /* clear the value afterwards so choosing the same file again still fires */
  if (fileInput) fileInput.addEventListener('change', function () { if (fileInput.files[0]) loadFile(fileInput.files[0]); fileInput.value = ''; });
  drop.addEventListener('click', function (e) { if (!loaded && fileInput) fileInput.click(); });
  /* keyboard path in: the empty drop zone is a button (role, tabindex and label in the markup) */
  drop.addEventListener('keydown', function (e) {
    if (loaded || !fileInput || e.target !== drop) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  var chooseBtn = id('it-choose');
  if (chooseBtn) chooseBtn.addEventListener('click', function () { if (fileInput) fileInput.click(); });
  /* "tap" on touch screens, "click" otherwise */
  var verb = drop.querySelector('.it-drop__verb');
  if (verb && window.matchMedia && window.matchMedia('(pointer: coarse)').matches) verb.textContent = 'tap';

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
      /* Distance out to the handle. This used Math.min(w, h), the SHORT side,
         which on a portrait photo dropped the handle inside the picture. `w`/`h`
         are the ROTATED bounding box, so measure from the un-rotated drawn
         height instead: that is the centre-to-top-edge distance of the image
         itself at any angle, so the handle clears the top edge by 18px for every
         aspect ratio and every rotation. */
      var rr = (work.height * viewScale) / 2 + 18;
      var rad = (-90 + fineAngle) * Math.PI / 180;
      var hx = cx + rr * Math.cos(rad), hy = cy + rr * Math.sin(rad);
      /* keep it on the canvas (a wide image swung near 90° would push it off) */
      hx = Math.max(8, Math.min(maxW - 8, hx)); hy = Math.max(8, Math.min(maxH - 8, hy));
      handlePos = { x: hx, y: hy };
      dctx.strokeStyle = 'rgba(130,166,204,0.85)'; dctx.lineWidth = 1.5;
      dctx.beginPath(); dctx.moveTo(cx, cy); dctx.lineTo(hx, hy); dctx.stroke();
      dctx.fillStyle = 'rgba(130,166,204,0.9)'; dctx.beginPath(); dctx.arc(cx, cy, 3, 0, 6.2832); dctx.fill();
      dctx.fillStyle = '#82a6cc'; dctx.strokeStyle = '#fff'; dctx.lineWidth = 1.5;
      dctx.beginPath(); dctx.arc(hx, hy, 7, 0, 6.2832); dctx.fill(); dctx.stroke();
      if (Math.abs(fineAngle) > 0.5) {
        dctx.fillStyle = 'rgba(127,127,127,0.95)'; dctx.font = '12px "Source Sans 3", system-ui, sans-serif';
        var flip = hx > maxW - 46;   /* keep the readout on the canvas */
        dctx.textAlign = flip ? 'right' : 'left'; dctx.textBaseline = 'middle';
        dctx.fillText(px(Math.round(fineAngle)) + '°', hx + (flip ? -11 : 11), hy);
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
      if (handlePos && Math.hypot(px - handlePos.x, py - handlePos.y) < (e.pointerType === 'touch' ? 24 : 18)) {   /* grab the rotate handle */
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
        fieldsFromRect(cropRect); render();
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
      if (cropping && cropRect && cropRect.w > 4 && cropRect.h > 4) applyCrop(cropRect);
    });
    disp.addEventListener('pointercancel', function () {
      cdrag = null;
      if (rotating) { rotating = false; fineAngle = 0; }
      if (cropping) cropRect = null;
      render();
    });
    /* The canvas lets a finger scroll the page (touch-action: pan-y) except
       while cropping (.it-canvas--crop sets none). A touch that starts on the
       rotate handle is a rotation, so it cancels the scroll here; a
       non-passive touchstart is the only way to do that once the gesture began. */
    disp.addEventListener('touchstart', function (e) {
      if (!loaded || cropping || !handlePos || !e.touches || e.touches.length !== 1) return;
      var r = disp.getBoundingClientRect(), t = e.touches[0];
      if (Math.hypot(t.clientX - r.left - handlePos.x, t.clientY - r.top - handlePos.y) < 24) e.preventDefault();
    }, { passive: false });
    disp.addEventListener('pointermove', function (e) {   /* hover cursor over the handle */
      if (cropping || rotating || cdrag || !handlePos) return;
      var r = disp.getBoundingClientRect();
      disp.style.cursor = (Math.hypot(e.clientX - r.left - handlePos.x, e.clientY - r.top - handlePos.y) < 18) ? 'grab' : 'default';
    });
  }
  function applyCrop(r) {
    pushHistory();
    var c = document.createElement('canvas'); c.width = Math.round(r.w); c.height = Math.round(r.h);
    c.getContext('2d').drawImage(work, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
    restore(c);
    setCropping(false); updateInfo();
  }
  function setCropping(on) {
    cropping = on; if (disp) { disp.style.cursor = on ? 'crosshair' : 'default'; disp.classList.toggle('it-canvas--crop', on); }
    var cb = id('it-crop'); if (cb) { cb.classList.toggle('it-btn--on', on); cb.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    if (on && keyRotTimer) commitKeyRotation();   /* a pending keyboard turn becomes its own undo step */
    if (on) bakeRotation();          /* crop works on the un-rotated (baked) image */
    else cropRect = null;
    if (cropRow) {
      cropRow.hidden = !on;
      if (on) {
        fieldsFromRect({ x: 0, y: 0, w: work.width, h: work.height });
        cropF[0].max = cropF[2].max = work.width; cropF[1].max = cropF[3].max = work.height;
      }
    }
    render();
  }
  /* Crop by numbers, the keyboard path: while Crop is on, Left / Top / Width /
     Height fields (image pixels) follow the dragged box and can be typed
     instead; the box previews as they change, and Apply crop or Enter in a
     field crops. Escape leaves crop mode. */
  var cropRow = id('it-crop-row'), cropF = ['x', 'y', 'w', 'h'].map(function (k) { return id('it-crop-' + k); });
  if (!cropF[0] || !cropF[1] || !cropF[2] || !cropF[3]) cropRow = null;
  function fieldsFromRect(r) { if (!cropRow) return; [r.x, r.y, r.w, r.h].forEach(function (v, i) { cropF[i].value = Math.round(v); }); }
  function rectFromFields() {
    var W = work.width, H = work.height;
    function num(el, d) { var n = Math.round(parseFloat(el.value)); return isFinite(n) ? n : d; }
    var x = Math.max(0, Math.min(W - 1, num(cropF[0], 0))), y = Math.max(0, Math.min(H - 1, num(cropF[1], 0)));
    return { x: x, y: y, w: Math.max(1, Math.min(W - x, num(cropF[2], W - x))), h: Math.max(1, Math.min(H - y, num(cropF[3], H - y))) };
  }
  function applyCropFields() {
    if (!loaded || !cropping || !cropRow) return;
    var r = rectFromFields(), cb = id('it-crop'), st = id('it-status');
    if (r.x === 0 && r.y === 0 && r.w === work.width && r.h === work.height) { setCropping(false); if (cb) cb.focus(); return; }
    applyCrop(r);
    if (cb) cb.focus();
    if (st) st.textContent = 'Cropped to ' + wxh(work.width, work.height, ' × ') + ' px.';
  }
  if (cropRow) {
    cropF.forEach(function (el) {
      el.addEventListener('input', function () { if (cropping) { cropRect = rectFromFields(); render(); } });
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); applyCropFields(); }
        else if (e.key === 'Escape') { e.preventDefault(); setCropping(false); var cb = id('it-crop'); if (cb) cb.focus(); }
      });
    });
    var applyBtn = id('it-crop-apply'); if (applyBtn) applyBtn.addEventListener('click', applyCropFields);
  }
  id('it-crop').addEventListener('click', function (e) {
    if (!loaded) return;
    setCropping(!cropping);
    /* turned on from the keyboard (a click with no pointer behind it): go to the fields */
    if (cropping && e.detail === 0 && cropRow) cropF[0].focus();
  });
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
  /* The keyboard path to the same rotation: with the preview focused, Left and
     Right turn it 1° (10° with Shift), previewed live like a drag; the turn is
     baked as ONE undo step once the keys rest for 700 ms or focus leaves, so a
     held key does not resample the image on every repeat. */
  var keyRotTimer = 0;
  function commitKeyRotation() {
    clearTimeout(keyRotTimer); keyRotTimer = 0;
    if (!loaded || Math.abs(fineAngle) < 0.001) return;
    var a = Math.round(fineAngle);
    pushHistory(); bakeRotation(); render(); updateInfo();
    var st = id('it-status'); if (st) st.textContent = 'Rotated ' + px(a) + '°.';
  }
  if (disp) {
    disp.addEventListener('keydown', function (e) {
      if (!loaded || cropping || rotating || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      var a = fineAngle + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1);
      while (a > 180) a -= 360; while (a < -180) a += 360;
      fineAngle = a; render();
      clearTimeout(keyRotTimer); keyRotTimer = setTimeout(commitKeyRotation, 700);
    });
    disp.addEventListener('blur', function () { if (keyRotTimer) commitKeyRotation(); });
  }
  window.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey) || (e.key !== 'z' && e.key !== 'Z')) return;
    /* inside a field, Ctrl+Z belongs to the field's own text undo */
    var t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault(); undo();
  });
  id('it-rot-l').addEventListener('click', function () { rotate(-1); });
  id('it-rot-r').addEventListener('click', function () { rotate(1); });
  id('it-flip-h').addEventListener('click', function () { flip(true); });
  id('it-flip-v').addEventListener('click', function () { flip(false); });
  id('it-reset').addEventListener('click', function () {
    if (!loaded) return;
    pushHistory();
    work.width = orig.width; work.height = orig.height; wctx.setTransform(1, 0, 0, 1, 0, 0); wctx.clearRect(0, 0, orig.width, orig.height); wctx.drawImage(orig, 0, 0);
    fineAngle = 0; editSeq++;
    setCropping(false); render(); updateInfo();
  });

  /* ---------- cut out background (assets/js/imagetools-cutout.js) ---------- */
  var cutBtn = id('it-cutout');
  if (cutBtn) cutBtn.addEventListener('click', function () {
    if (!loaded || !window.ImageCutout) return;
    setCropping(false);          /* the cutout works on the whole image */
    window.ImageCutout.open();
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
  if (elQual) elQual.addEventListener('input', function () { elQualV.textContent = fmtN(NF_D2, +elQual.value, 2); });
  if (elTarget) elTarget.addEventListener('input', function () { elTargetV.textContent = fmtN(NF_INT, +elTarget.value) + ' KB'; });
  /* picking a format by hand is the user's own choice, so Undo leaves it alone
     from here on (setFormat sets the value directly and does not fire this) */
  if (elFmt) elFmt.addEventListener('change', function () { fmtSwitch = null; syncModeUI(); });
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
  /* Smallest longest side the size search will shrink to before it reports
     that a target cannot be reached. */
  var MIN_SIDE = 64;
  async function encodeToTarget(src, type, targetBytes, live) {
    /* toBlob can return null (not throw) when the canvas is too big for the
       browser to encode — guard every result so one null doesn't crash the
       search or clobber an earlier usable blob. */
    /* Returns { blob, w, h }: the size of the canvas actually encoded, which
       is smaller than the source whenever the search had to downscale.
       `live` (optional) is asked between encodes; once it says the request was
       superseded the search stops and returns { stale: true }. */
    /* JPEG/WebP: when even the lowest quality is over the target, the next
       scale comes from the measured size (file size goes roughly with the
       pixel count), so a 12 MP photo can still reach 20 KB; it gives up only
       once the longest side is down to MIN_SIDE pixels. PNG keeps its seven
       0.8 steps (down to about a quarter): shrinking a photo to a thumbnail to
       make PNG fit is worse than saying plainly that JPEG or WebP would. */
    var longest = Math.max(src.width, src.height);
    var floor = Math.min(1, MIN_SIDE / longest);
    var scale = 1, best = null, smallest;
    function gone() { return live && !live(); }
    for (var attempt = 0; attempt < 16; attempt++) {
      if (gone()) return { stale: true };
      var c = scaledCanvas(src, scale);
      if (type === 'image/png') {
        var p = await toBlob(c, type);                /* png: quality not adjustable → downscale only */
        if (p) { best = { blob: p, w: c.width, h: c.height }; if (p.size <= targetBytes) return best; }
        if (attempt >= 6) return best;
        scale *= 0.8; continue;
      } else {
        /* a null blob means this canvas is too big to encode: step down and retry */
        var lo = 0.25, hi = 0.95, b = await toBlob(c, type, hi);
        if (!b) { scale *= 0.8; continue; }
        if (b.size <= targetBytes) return { blob: b, w: c.width, h: c.height };
        if (gone()) return { stale: true };
        var low = await toBlob(c, type, lo);           /* lowest quality first: no point searching if it is over */
        if (!low) { scale *= 0.8; continue; }
        if (low.size <= targetBytes) {
          best = { blob: low, w: c.width, h: c.height };
          for (var it = 0; it < 7; it++) {
            if (gone()) return { stale: true };
            var mid = (lo + hi) / 2; b = await toBlob(c, type, mid);
            if (b && b.size <= targetBytes) { best = { blob: b, w: c.width, h: c.height }; lo = mid; } else hi = mid;
          }
          return best;
        }
        smallest = low.size;
      }
      if (scale <= floor + 1e-9) break;               /* already at the smallest size allowed */
      scale = Math.max(floor, scale * Math.min(0.8, Math.sqrt(targetBytes / smallest) * 0.9));
    }
    return null;
  }
  async function buildExport(live) {
    var src = exportSource(), type = typeStr(), blob = null, w = src.width, h = src.height, encodeFailed = false, targetBytes = 0;
    if (elMode.value === 'target') {
      targetBytes = (+elTarget.value) * 1000;   /* 1 KB = 1,000 bytes: passes a "max 100 KB" check either way */
      var hit = await encodeToTarget(src, type, targetBytes, live);
      if (hit && hit.stale) return { stale: true };
      if (hit) { blob = hit.blob; w = hit.w; h = hit.h; }
      /* Distinguish "couldn't reach the target size" from "the browser refused
         to encode this canvas at all" (typically an image beyond canvas limits):
         if a plain encode of the export canvas also yields null, it's the latter. */
      if (!blob) encodeFailed = (await toBlob(src, type, type === 'image/png' ? undefined : 0.8)) === null;
    } else {
      blob = await toBlob(src, type, type === 'image/png' ? undefined : +elQual.value);
      encodeFailed = !blob;
    }
    return { blob: blob, w: w, h: h, encodeFailed: encodeFailed, missed: !!(blob && targetBytes && blob.size > targetBytes) };
  }
  /* PNG cannot trade quality for size, so a photo can stay over the target
     even after the search shrinks it; say that instead of a plain "Saved". */
  function missLine(r, saved) {
    return 'PNG cannot get this image under ' + fmtN(NF_INT, +elTarget.value) + ' KB; ' + (saved ? 'it was saved' : 'it would be saved') +
      ' at ' + fmtBytes(r.blob.size) + ' and ' + wxh(r.w, r.h) + '. Try JPEG or WebP.';
  }
  /* nothing to export until an image loads — start both buttons disabled like
     Undo and Cut out, so they say so instead of silently doing nothing */
  [id('it-download'), id('it-favicon')].forEach(function (b) {
    if (b && !loaded) { b.disabled = true; b.title = 'Drop an image in first'; }
  });
  id('it-download').addEventListener('click', async function () {
    if (!loaded) return;
    var st = id('it-status'); st.textContent = 'Encoding…';
    var r;
    try { r = await buildExport(); }
    catch (err) { st.textContent = 'Your browser could not re-encode this image.'; return; }
    if (!r.blob) {
      st.textContent = r.encodeFailed
        ? 'This image is too large for your browser to re-encode. Try the max-dimension setting in Advanced first.'
        : 'Could not reach that size even at lowest quality.';
      return;
    }
    var ext = elFmt.value === 'png' ? 'png' : elFmt.value === 'webp' ? 'webp' : 'jpg';
    downloadBlob(r.blob, baseName(srcName) + '-' + r.w + 'x' + r.h + '.' + ext);
    st.textContent = r.missed ? missLine(r, true) + ' (Metadata stripped.)'
      : 'Saved ' + wxh(r.w, r.h) + ' · ' + fmtBytes(r.blob.size) + ' (metadata stripped).';
  });

  var infoSeq = 0, infoTimer = 0;
  async function updateInfo() {
    if (!loaded) return;
    clearTimeout(infoTimer);
    id('it-dims').textContent = wxh(work.width, work.height, ' × ') + ' px';
    /* live estimate of the export size — guard against overlapping async runs (slider drag);
       a superseded run also stops encoding between attempts instead of finishing its search */
    var my = ++infoSeq;
    var r;
    try { r = await buildExport(function () { return my === infoSeq; }); } catch (err) { r = null; }
    if (my !== infoSeq || (r && r.stale)) return;   /* a newer request superseded this one */
    /* a failed encode must overwrite the line too — a stale estimate from the
       previous settings reads as if the current target were reachable */
    if (r && r.blob) id('it-estimate').textContent = r.missed ? missLine(r, false) : 'Output: ' + wxh(r.w, r.h) + ' · ~' + fmtBytes(r.blob.size);
    else id('it-estimate').textContent = !r ? 'Your browser could not re-encode this image.'
      : r.encodeFailed ? 'This image is too large for your browser to re-encode.'
      : 'Cannot reach ' + fmtN(NF_INT, +elTarget.value) + ' KB even at lowest quality.';
  }
  /* recompute the estimate when controls change, once the control rests for
     250 ms: a slider drag fires dozens of input events, and each estimate is a
     full encode search. Bumping infoSeq right away stops the run in flight. */
  function scheduleInfo() {
    if (!loaded) return;
    infoSeq++; clearTimeout(infoTimer);
    infoTimer = setTimeout(updateInfo, 250);
  }
  ['it-format', 'it-mode', 'it-qual', 'it-maxdim', 'it-target'].forEach(function (k) {
    var e = id(k); if (e) e.addEventListener('input', scheduleInfo);
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
  /* favicon.ico, the file browsers and crawlers still ask the site root for:
     an ICO directory whose entries are the 16, 32 and 48 px PNGs as they are
     (PNG-in-ICO, read by every current browser and Windows since Vista) */
  function icoFrom(imgs) {
    var head = 6 + 16 * imgs.length, total = head, i;
    for (i = 0; i < imgs.length; i++) total += imgs[i].data.length;
    var out = new Uint8Array(total), dv = new DataView(out.buffer), off = head;
    dv.setUint16(0, 0, true); dv.setUint16(2, 1, true); dv.setUint16(4, imgs.length, true);
    for (i = 0; i < imgs.length; i++) {
      var e = 6 + 16 * i, sz = imgs[i].size >= 256 ? 0 : imgs[i].size;
      out[e] = sz; out[e + 1] = sz;                  /* width, height; color count and reserved stay 0 */
      dv.setUint16(e + 4, 1, true); dv.setUint16(e + 6, 32, true);
      dv.setUint32(e + 8, imgs[i].data.length, true); dv.setUint32(e + 12, off, true);
      out.set(imgs[i].data, off); off += imgs[i].data.length;
    }
    return out;
  }
  id('it-favicon').addEventListener('click', async function () {
    if (!loaded) return;
    var st = id('it-status'); st.textContent = 'Building favicon pack…';
    var sq = squareSource(), files = [], i, b;
    var ico = [];
    for (i = 0; i < FAV_PNG.length; i++) {
      b = await iconBlob(sq, FAV_PNG[i]); var d = await blobBytes(b);
      files.push({ name: 'favicon-' + FAV_PNG[i] + 'x' + FAV_PNG[i] + '.png', data: d });
      if (FAV_PNG[i] <= 48) ico.push({ size: FAV_PNG[i], data: d });
    }
    files.push({ name: 'favicon.ico', data: icoFrom(ico) });
    for (i = 0; i < APPLE.length; i++) { b = await iconBlob(sq, APPLE[i]); files.push({ name: 'apple-touch-icon.png', data: await blobBytes(b) }); }
    var enc = new TextEncoder();
    var manifest = { name: 'My Site', icons: [{ src: '/favicon-192x192.png', sizes: '192x192', type: 'image/png' }, { src: '/favicon-512x512.png', sizes: '512x512', type: 'image/png' }] };
    files.push({ name: 'site.webmanifest', data: enc.encode(JSON.stringify(manifest, null, 2)) });
    var html = [
      '<link rel="icon" href="/favicon.ico" sizes="any">',
      '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">',
      '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">',
      '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">',
      '<link rel="icon" type="image/png" sizes="192x192" href="/favicon-192x192.png">',
      '<link rel="manifest" href="/site.webmanifest">'
    ].join('\n');
    files.push({ name: 'snippet.html', data: enc.encode(html) });
    downloadBlob(zipStore(files), 'favicon-pack.zip');
    st.textContent = 'Favicon pack saved: ' + files.length + ' files (PNGs, favicon.ico, manifest, and the <link> snippet).';
  });

  function downloadBlob(blob, name) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ---------- small API for page modules that edit the image ----------
     Kept deliberately thin: another module hands back a finished canvas and
     it lands as ONE step in the same 25-deep undo history everything else
     uses, so Undo and Reset keep working exactly as before. */
  window.ImageStudio = {
    getWorkCanvas: function () { return loaded ? work : null; },
    isLoaded: function () { return loaded; },
    editCount: function () { return editSeq; },
    applyEdit: function (canvas, label) {
      if (!loaded || !canvas || !canvas.width || !canvas.height) return false;
      pushHistory();
      restore(canvas);
      fineAngle = 0; cropRect = null;
      setCropping(false); render(); updateInfo();
      if (label) { var st = id('it-status'); if (st) st.textContent = label; }
      return true;
    },
    getFormat: function () { return elFmt ? elFmt.value : ''; },
    /* `revertOnUndo` ties the change to the history step that was just pushed,
       so Undo puts the old format back along with the pixels. */
    setFormat: function (v, revertOnUndo) {
      if (!elFmt) return;
      var was = elFmt.value;
      elFmt.value = v; syncModeUI(); if (loaded) updateInfo();
      if (revertOnUndo && was !== v) fmtSwitch = { depth: history.length, from: was };
    },
    setStatus: function (msg) { var st = id('it-status'); if (st) st.textContent = msg; }
  };

  syncModeUI();
})();
