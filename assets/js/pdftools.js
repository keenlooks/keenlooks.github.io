/* PDF Toolbench (/pdftools/) — fully client-side. Nothing is uploaded; this file makes
   no network requests with your PDF. Rendering uses pdf.js (Apache-2.0, Mozilla); editing
   uses pdf-lib (MIT). Both are vendored locally under assets/js/pdflib/. OCR (lazy-loaded
   on first use) is tesseract.js (Apache-2.0) under assets/js/tesseractlib/; encryption is
   qpdf compiled to wasm (Apache-2.0) under assets/js/qpdflib/.

   External file (never HTML-compressed) so // comments are fine here. */
(function () {
  'use strict';

  /* ==================================================================================
     PURE helpers — no DOM, no pdf.js. Exposed as window.__PT_PURE in the browser and
     as module.exports under node so the test harness can exercise the exact same code.
     ================================================================================== */
  var PURE = {};

  // "1-5, 9, 12-" -> array of 0-based page indices (deduped, in the order given),
  // or null if the string is invalid for a document with `total` pages.
  PURE.parsePageRange = function (str, total) {
    if (str == null || !total) return null;
    var s = String(str).trim();
    if (!s) return null;
    var out = [], seen = {}, parts = s.split(',');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (!p) return null;
      var m = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(p);
      if (!m) return null;
      var a = m[1] ? parseInt(m[1], 10) : null;
      var dash = !!m[2];
      var b = m[3] ? parseInt(m[3], 10) : null;
      if (a == null && b == null) return null;           // "-" or garbage
      if (!dash) { if (a == null) return null; b = a; }  // single number
      if (a == null) a = 1;                              // "-5" == "1-5"
      if (b == null) b = total;                          // "12-" == "12-last"
      if (a < 1 || b > total || a > b) return null;
      for (var n = a; n <= b; n++) { if (!seen[n]) { seen[n] = 1; out.push(n - 1); } }
    }
    return out.length ? out : null;
  };

  // "Scan of lease (final).PDF" -> "Scan of lease (final)" (safe as a filename base)
  PURE.sanitizeBaseName = function (name) {
    var b = String(name || '').replace(/\.[^.]*$/, '');
    b = b.replace(/[\/\\:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (b.length > 60) b = b.slice(0, 60).trim();
    return b || 'document';
  };

  // export filename derived from the first source file
  PURE.deriveExportName = function (firstName, nDocs, kind) {
    var b = PURE.sanitizeBaseName(firstName);
    switch (kind) {
      case 'download':   return nDocs > 1 ? b + '-merged.pdf' : b + '.pdf';
      case 'extract':    return b + '-extract.pdf';
      case 'compressed': return b + '-compressed.pdf';
      case 'split':      return b + '-pages.zip';
      case 'protected':  return b + '-protected.pdf';
      case 'images':     return b + '-images.zip';
      default:           return b + '.pdf';
    }
  };

  // deep-enough page clone for the undo stack: identity + small mutable bits are copied,
  // large immutable byte arrays (raster png, signature pngs) are shared by reference
  // (they are replaced wholesale, never mutated in place).
  PURE.clonePage = function (pg) {
    return {
      docIndex: pg.docIndex, pageIndex: pg.pageIndex,
      rot: pg.rot || 0, sel: !!pg.sel,
      raster: pg.raster || null,
      blank: pg.blank ? { wPt: pg.blank.wPt, hPt: pg.blank.hPt } : null,
      redacted: !!pg.redacted, ocr: !!pg.ocr,
      sigs: (pg.sigs || []).map(function (s) { return { png: s.png, x: s.x, y: s.y, w: s.w, h: s.h }; }),
      texts: (pg.texts || []).map(function (t) { return { x: t.x, y: t.y, text: t.text, size: t.size, font: t.font, color: t.color }; }),
      wms: (pg.wms || []).map(function (w) { return { text: w.text, pos: w.pos, opacity: w.opacity, size: w.size }; }),
      ocrWords: pg.ocrWords ? pg.ocrWords.slice() : null
    };
  };

  // bounded LIFO used for undo
  PURE.makeUndoStack = function (limit) {
    var stack = [];
    return {
      push: function (e) { stack.push(e); if (stack.length > limit) stack.shift(); },
      pop: function () { return stack.length ? stack.pop() : null; },
      peek: function () { return stack.length ? stack[stack.length - 1] : null; },
      size: function () { return stack.length; },
      clear: function () { stack.length = 0; }
    };
  };

  // strip characters the pdf-lib standard fonts (WinAnsi) can't encode
  PURE.sanitizeWinAnsi = function (s) {
    if (!s) return '';
    return String(s).replace(/[^\x20-\x7E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026]/g, '').trim();
  };

  // watermark text placement + draw (P = the PDFLib namespace). Rotation-0 math: pages
  // are flattened upright before a watermark is applied.
  PURE.drawWatermark = function (P, page, font, wm, W, H) {
    var text = String(wm.text || '');
    if (!text) return;
    var size = wm.size || 48;
    var op = wm.opacity == null ? 0.15 : wm.opacity;
    var col = P.rgb(0.5, 0.5, 0.5);
    var tw = font.widthOfTextAtSize(text, size);
    if (wm.pos === 'foot') {
      page.drawText(text, { x: W / 2 - tw / 2, y: 34, size: size, font: font, color: col, opacity: op });
      return;
    }
    // diagonal: centered on the page, rotated along the page diagonal
    var rad = Math.atan2(H, W);
    var deg = rad * 180 / Math.PI;
    var x = W / 2 - (tw / 2) * Math.cos(rad) + 0.35 * size * Math.sin(rad);
    var y = H / 2 - (tw / 2) * Math.sin(rad) - 0.35 * size * Math.cos(rad);
    page.drawText(text, { x: x, y: y, size: size, font: font, color: col, opacity: op, rotate: P.degrees(deg) });
  };

  // page-number label for output page i (0-based) of `total`, or null to skip
  PURE.pageNumText = function (cfg, i, total) {
    if (cfg.skipFirst && i === 0) return null;
    var start = cfg.start || 1;
    var n = start + i - (cfg.skipFirst ? 1 : 0);
    var m = start + total - (cfg.skipFirst ? 1 : 0) - 1;
    return cfg.fmt === 'nofm' ? (n + ' of ' + m) : String(n);
  };

  PURE.drawPageNum = function (P, page, font, cfg, i, total, W, H) {
    var text = PURE.pageNumText(cfg, i, total);
    if (text == null) return;
    var size = cfg.size || 10;
    var tw = font.widthOfTextAtSize(text, size);
    var x = cfg.pos === 'br' ? (W - 36 - tw) : (W / 2 - tw / 2);
    page.drawText(text, { x: x, y: 22, size: size, font: font, color: P.rgb(0.24, 0.24, 0.24) });
  };

  // invisible OCR text layer: words carry normalized bboxes {text, x0, y0, x1, y1}
  // (fractions of page width/height, y down from the top). Font size is chosen so the
  // drawn word width matches the recognized box, which makes selection/search line up.
  PURE.drawOcrWords = function (P, page, font, words, W, H) {
    var drawn = 0;
    (words || []).forEach(function (w) {
      var text = PURE.sanitizeWinAnsi(w.text);
      if (!text) return;
      var bw = (w.x1 - w.x0) * W, bh = (w.y1 - w.y0) * H;
      if (!(bw > 0) || !(bh > 0)) return;
      var w1;
      try { w1 = font.widthOfTextAtSize(text, 1); } catch (e) { return; }
      if (!(w1 > 0)) return;
      var size = Math.max(1, Math.min(bw / w1, bh * 1.6, 200));
      try {
        page.drawText(text, { x: w.x0 * W, y: H - w.y1 * H + bh * 0.18, size: size, font: font, opacity: 0 });
        drawn++;
      } catch (e2) { /* one unencodable word must not break the page */ }
    });
    return drawn;
  };

  if (typeof window === 'undefined') {
    // node (test harness): export the pure helpers and stop — everything below needs a DOM
    if (typeof module !== 'undefined' && module.exports) module.exports = PURE;
    return;
  }
  window.__PT_PURE = PURE;

  /* ==================================================================================
     Browser app
     ================================================================================== */
  var $ = function (id) { return document.getElementById(id); };
  if (!window.PDFLib || !window.pdfjsLib) {
    var s0 = $('pt-status'); if (s0) s0.textContent = 'Could not load the PDF engine.';
    return;
  }
  var PDFLib = window.PDFLib, pdfjsLib = window.pdfjsLib;

  // The MINIFIED pdf-lib mangles class names, so constructor.name is useless — detect
  // form-field types by instanceof against the exported classes, with a duck-typing fallback.
  function fieldType(f) {
    if (PDFLib.PDFTextField && f instanceof PDFLib.PDFTextField) return 'text';
    if (PDFLib.PDFCheckBox && f instanceof PDFLib.PDFCheckBox) return 'checkbox';
    if (PDFLib.PDFDropdown && f instanceof PDFLib.PDFDropdown) return 'select';
    if (PDFLib.PDFOptionList && f instanceof PDFLib.PDFOptionList) return 'select';
    if (PDFLib.PDFRadioGroup && f instanceof PDFLib.PDFRadioGroup) return 'radio';
    if (typeof f.setText === 'function') return 'text';
    if (typeof f.check === 'function' && typeof f.isChecked === 'function') return 'checkbox';
    if (typeof f.getOptions === 'function' && typeof f.select === 'function') return 'select';
    return null;
  }

  // point pdf.js at its LOCAL worker (derive the path from this page's pdf.js <script>)
  var pj = document.querySelector('script[src*="pdfjs/pdf.min.js"]');
  pdfjsLib.GlobalWorkerOptions.workerSrc = pj
    ? pj.src.replace('pdf.min.js', 'pdf.worker.min.js')
    : '/assets/js/pdflib/pdfjs/pdf.worker.min.js';

  // base path of assets/js/ (for lazy-loading the OCR + encryption engines)
  var jsBase = (function () {
    var s = document.querySelector('script[src*="pdftools.js"]');
    return s ? s.src.replace(/pdftools\.js.*$/, '') : '/assets/js/';
  })();

  // ---- state ----
  var docs = [];             // { name, bytes:Uint8Array (for pdf-lib), js:pdfjsDoc (for rendering), formValues }
  var pages = [];            // page model — see newPage()
  var pageNums = null;       // { fmt:'n'|'nofm', pos:'bc'|'br', start, skipFirst, size } or null
  var lastFlattened = 0;     // how many pages the last build had to rasterize (encrypted/damaged sources)
  var busy = false;          // one long operation at a time
  var undoStack = PURE.makeUndoStack(25);
  var lastSelIdx = -1;       // shift-click anchor
  var engineNote = $('pt-engine');

  function newPage(docIndex, pageIndex) {
    return {
      docIndex: docIndex, pageIndex: pageIndex, rot: 0, sel: false,
      raster: null, blank: null, redacted: false, ocr: false,
      sigs: [], texts: [], wms: [], ocrWords: null
    };
  }

  // ---- elements ----
  var drop = $('pt-drop'), grid = $('pt-grid'), fileInput = $('pt-file'), toolbar = $('pt-toolbar');
  var statusEl = $('pt-status'), countEl = $('pt-count');
  var btnAdd = $('pt-add'), btnSelAll = $('pt-selall'), btnRotate = $('pt-rotate'), btnRotCcw = $('pt-rotccw'),
      btnDup = $('pt-dup'), btnBlank = $('pt-blank'), btnDelete = $('pt-delete'), btnUndo = $('pt-undo'),
      btnShrink = $('pt-shrink'), btnExtract = $('pt-extract'), btnSplit = $('pt-split'), btnDownload = $('pt-download'),
      chkStrip = $('pt-stripmeta');
  var rangeInput = $('pt-range'), rangeInfo = $('pt-range-info');
  var progWrap = $('pt-progress'), progFill = $('pt-progress-fill');

  function setStatus(msg) { if (statusEl) statusEl.textContent = msg || ''; }

  // ---------- progress / busy ----------
  // resolves after the browser has had a chance to PAINT (rAF fires before paint, the
  // timeout queued from it runs after; falls back to a plain timeout in hidden tabs
  // where rAF never fires)
  function nextFrame() {
    return new Promise(function (res) {
      if (document.hidden) { setTimeout(res, 0); return; }
      requestAnimationFrame(function () { setTimeout(res, 0); });
    });
  }
  function progress(done, total, msg) {
    if (progWrap) {
      progWrap.hidden = false;
      var pct = total ? Math.max(0, Math.min(100, Math.round(done / total * 100))) : 0;
      progFill.style.width = pct + '%';
      progWrap.setAttribute('aria-valuenow', String(pct));
    }
    if (msg != null) setStatus(msg);
    return nextFrame();
  }
  function progressDone() {
    if (progWrap) { progWrap.hidden = true; progFill.style.width = '0%'; }
  }
  function setBusy(b) {
    busy = b;
    if (toolbar) toolbar.classList.toggle('pt-busy', b);
    if (drop) drop.classList.toggle('pt-busy', b);
    if (!b) { progressDone(); updateToolbar(); }
  }

  // ---------- undo ----------
  function snapshot(label) {
    undoStack.push({
      label: label,
      pages: pages.map(PURE.clonePage),
      pageNums: pageNums ? {
        fmt: pageNums.fmt, pos: pageNums.pos, start: pageNums.start,
        skipFirst: pageNums.skipFirst, size: pageNums.size
      } : null
    });
    updateToolbar();
  }
  function dropSnapshot() { undoStack.pop(); updateToolbar(); }
  function undo() {
    if (busy) return;
    var e = undoStack.pop();
    if (!e) return;
    pages = e.pages;
    pageNums = e.pageNums;
    lastSelIdx = -1;
    renderGrid(); updateToolbar();
    setStatus('Undid: ' + e.label + '.');
  }

  function modalOpen() { return !!document.querySelector('.pt-modal:not([hidden])'); }
  function openDialog(el) {
    if (!el || busy || modalOpen()) return false;
    el.hidden = false;
    return true;
  }

  // ---------- loading source PDFs / images ----------
  var IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
  function isImage(f) { return /^image\//.test(f.type) || IMG_RE.test(f.name); }
  function isPdf(f) { return f.type === 'application/pdf' || /\.pdf$/i.test(f.name); }

  function addFiles(fileList) {
    if (busy) return;
    var arr = Array.prototype.slice.call(fileList).filter(function (f) { return isPdf(f) || isImage(f); });
    var rejectedTypes = Array.prototype.slice.call(fileList).length - arr.length;
    if (!arr.length) { if (rejectedTypes) setStatus('Those files aren’t PDFs or images.'); return; }
    setBusy(true);
    var beforeLen = pages.length;
    snapshot('add ' + arr.length + ' file' + (arr.length > 1 ? 's' : ''));
    var failed = [], skipped = [];
    var chain = Promise.resolve();
    arr.forEach(function (f, fi) {
      chain = chain.then(function () {
        return progress(fi, arr.length, 'Reading ' + f.name + ' (' + (fi + 1) + ' of ' + arr.length + ')…');
      }).then(function () {
        var nm = f.name;
        var bytesP = isImage(f) ? imageToPdfBytes(f) : f.arrayBuffer().then(function (b) { return new Uint8Array(b); });
        // one bad file must not abort the rest — isolate each with its own catch
        return bytesP.then(function (bytes) { return addPdfBytes(bytes, nm); })
          .catch(function (e) {
            if (e && e.__ptSkip) skipped.push(nm); else failed.push(nm);
            if (window.console) console.warn('pdftools: could not add ' + nm, e);
          })
          .then(function () {
            // show what we have so far — skeleton thumbnails fill in as pdf.js renders
            renderGrid(); updateToolbar();
            return progress(fi + 1, arr.length);
          });
      });
    });
    chain.then(function () {
      if (pages.length === beforeLen) dropSnapshot();   // nothing was actually added
      setBusy(false);
      renderGrid(); updateToolbar();
      var msg = [];
      var added = pages.length - beforeLen;
      if (added > 0) msg.push('Added ' + added + ' page' + (added > 1 ? 's' : '') + '.');
      if (failed.length) msg.push('Couldn’t read: ' + failed.join(', ') + ' (the file may be corrupted or an unsupported format).');
      if (skipped.length) msg.push('Skipped (password not provided): ' + skipped.join(', ') + '.');
      setStatus(msg.join(' '));
    });
  }

  function addPdfBytes(bytes, name) {
    // pdf.js detaches the buffer it's given, so hand it a COPY and keep `bytes` for pdf-lib.
    // Retry with a password from the styled modal if the PDF is password-protected.
    function attempt(password) {
      return pdfjsLib.getDocument({ data: bytes.slice(0), password: password }).promise.then(function (jsDoc) {
        var docIndex = docs.length;
        docs.push({ name: name, bytes: bytes, js: jsDoc, formValues: null });
        for (var i = 0; i < jsDoc.numPages; i++) pages.push(newPage(docIndex, i));
      }).catch(function (e) {
        var needsPw = e && (e.name === 'PasswordException' || /password/i.test(e.message || ''));
        if (needsPw) {
          return askPassword(name, password != null).then(function (pw) {
            if (pw == null) { var skip = new Error('password required'); skip.__ptSkip = true; throw skip; }
            return attempt(pw);
          });
        }
        throw e;
      });
    }
    return attempt(undefined);
  }

  // ---------- password modal (replaces window.prompt) ----------
  var passDialog = $('pt-pass-dialog'), passMsg = $('pt-pass-msg'), passInput = $('pt-pass-input');
  var passResolve = null;
  function askPassword(name, again) {
    if (!passDialog) return Promise.resolve(null);
    return new Promise(function (res) {
      passResolve = res;
      if (passMsg) passMsg.textContent = (again ? 'That password didn’t work. ' : '') +
        '“' + name + '” is password-protected. Enter its password to open it, or cancel to skip this file.';
      if (passInput) passInput.value = '';
      passDialog.hidden = false;
      setTimeout(function () { if (passInput) passInput.focus(); }, 0);
    });
  }
  function passDone(val) {
    if (!passResolve) return;
    passDialog.hidden = true;
    var r = passResolve; passResolve = null;
    r(val);
  }
  if (passDialog) {
    $('pt-pass-go').addEventListener('click', function () { passDone(passInput.value); });
    $('pt-pass-cancel').addEventListener('click', function () { passDone(null); });
    passInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); passDone(passInput.value); }
      else if (e.key === 'Escape') { e.preventDefault(); passDone(null); }
    });
    passDialog.addEventListener('click', function (e) { if (e.target === passDialog) passDone(null); });
  }

  // wrap an image file in a single-page PDF (so it flows through the same pipeline)
  function imageToPdfBytes(file) {
    return file.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);
      return PDFLib.PDFDocument.create().then(function (doc) {
        function place(img) {
          var W = img.width, H = img.height, maxSide = 1100, s = Math.min(1, maxSide / Math.max(W, H));
          var pw = Math.max(1, Math.round(W * s)), ph = Math.max(1, Math.round(H * s));
          doc.addPage([pw, ph]).drawImage(img, { x: 0, y: 0, width: pw, height: ph });
          return doc.save();
        }
        if (/png$/i.test(file.type) || /\.png$/i.test(file.name)) return doc.embedPng(bytes).then(place);
        if (/jpe?g$/i.test(file.type) || /\.jpe?g$/i.test(file.name)) return doc.embedJpg(bytes).then(place);
        return blobToPngBytes(file).then(function (png) { return doc.embedPng(png).then(place); });   // webp/gif/bmp via canvas
      });
    });
  }
  function blobToPngBytes(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), im = new Image();
      im.onload = function () { URL.revokeObjectURL(url); var c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; c.getContext('2d').drawImage(im, 0, 0); canvasToBytes(c, 'image/png').then(res); };
      im.onerror = function () { URL.revokeObjectURL(url); rej(new Error('could not decode image')); };
      im.src = url;
    });
  }

  // ---------- thumbnails ----------
  function totalRotation(jsPage, extra) { return ((jsPage.rotate || 0) + (extra || 0)) % 360; }

  // object URL that revokes itself once the image has loaded
  function pngUrlInto(img, bytes) {
    var url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    var prevLoad = img.onload, prevErr = img.onerror;
    img.onload = function () { URL.revokeObjectURL(url); if (prevLoad) prevLoad.apply(this, arguments); };
    img.onerror = function () { URL.revokeObjectURL(url); if (prevErr) prevErr.apply(this, arguments); };
    img.src = url;
  }

  // draw a raster page (stored PNG) into a fresh canvas at targetW CSS px, honoring pg.rot
  function rasterToCanvas(pg, targetW) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.onload = function () {
        var rot = ((pg.rot || 0) % 360 + 360) % 360;
        var swap = rot === 90 || rot === 270;
        var effW = swap ? im.height : im.width, effH = swap ? im.width : im.height;
        var s = targetW / effW;
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(effW * s)); c.height = Math.max(1, Math.round(effH * s));
        var cx = c.getContext('2d');
        cx.translate(c.width / 2, c.height / 2);
        cx.rotate(rot * Math.PI / 180);
        cx.scale(s, s);
        cx.drawImage(im, -im.width / 2, -im.height / 2);
        res(c);
      };
      im.onerror = function () { rej(new Error('could not load page image')); };
      pngUrlInto(im, pg.raster.png);
    });
  }

  function renderThumbInto(canvas, pg, gridIdx, done) {
    function finish(Wpt, Hpt) {
      drawThumbOverlays(canvas.getContext('2d'), pg, canvas.width, canvas.height, Wpt, Hpt, gridIdx);
      if (done) done();
    }
    if (pg.blank) {
      var sw = (pg.rot % 180) !== 0;
      var bw = sw ? pg.blank.hPt : pg.blank.wPt, bh = sw ? pg.blank.wPt : pg.blank.hPt;
      canvas.width = 150; canvas.height = Math.max(1, Math.round(150 * bh / bw));
      var bx = canvas.getContext('2d'); bx.fillStyle = '#fff'; bx.fillRect(0, 0, canvas.width, canvas.height);
      finish(bw, bh);
      return;
    }
    if (pg.raster) {
      rasterToCanvas(pg, 150).then(function (c) {
        canvas.width = c.width; canvas.height = c.height;
        canvas.getContext('2d').drawImage(c, 0, 0);
        var sw2 = (pg.rot % 180) !== 0;
        finish(sw2 ? pg.raster.hPt : pg.raster.wPt, sw2 ? pg.raster.wPt : pg.raster.hPt);
      }).catch(function () { if (done) done(); });
      return;
    }
    docs[pg.docIndex].js.getPage(pg.pageIndex + 1).then(function (page) {
      var rot = totalRotation(page, pg.rot);
      var base = page.getViewport({ scale: 1, rotation: rot });
      var scale = 150 / base.width;
      var vp = page.getViewport({ scale: scale, rotation: rot });
      canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
      page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise.then(function () {
        finish(base.width, base.height);
      }, function () { if (done) done(); });
    }).catch(function () { if (done) done(); });
  }

  // signature/text annotations + watermarks + page numbers on a thumbnail or preview canvas.
  // The placement math mirrors the export math in drawOverlays/PURE.draw*.
  function drawThumbOverlays(ctx, pg, tw, th, Wpt, Hpt, gridIdx) {
    drawMarks(ctx, pg, tw, th, Wpt, Hpt, gridIdx);
    (pg.texts || []).forEach(function (t) {
      var px = Math.max(3, t.size * tw / Wpt);
      ctx.fillStyle = t.color || '#111'; ctx.font = px + 'px ' + (t.font || 'Helvetica'); ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      (t.text || '').split('\n').forEach(function (line, i) { ctx.fillText(line, t.x * tw, t.y * th + i * px * 1.2); });
    });
    (pg.sigs || []).forEach(function (s) {
      var im = new Image();
      im.onload = function () { ctx.drawImage(im, s.x * tw, s.y * th, s.w * tw, s.h * th); };
      pngUrlInto(im, s.png);
    });
  }

  // watermarks + page numbers only (also used by the editor preview, which shows
  // texts/sigs as live DOM elements instead)
  function drawMarks(ctx, pg, tw, th, Wpt, Hpt, gridIdx) {
    var s = tw / Wpt;
    (pg.wms || []).forEach(function (wm) {
      ctx.save();
      ctx.globalAlpha = wm.opacity == null ? 0.15 : wm.opacity;
      ctx.fillStyle = '#7f7f7f';
      ctx.font = ((wm.size || 48) * s) + 'px Arial, Helvetica, sans-serif';
      if (wm.pos === 'foot') {
        ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(wm.text, tw / 2, th - 34 * s);
      } else {
        ctx.translate(tw / 2, th / 2);
        ctx.rotate(-Math.atan2(Hpt, Wpt));
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(wm.text, 0, 0);
      }
      ctx.restore();
    });
    if (pageNums && gridIdx != null) {
      var txt = PURE.pageNumText(pageNums, gridIdx, pages.length);
      if (txt != null) {
        ctx.save();
        ctx.fillStyle = '#3d3d3d';
        ctx.font = ((pageNums.size || 10) * s) + 'px Arial, Helvetica, sans-serif';
        ctx.textBaseline = 'alphabetic';
        if (pageNums.pos === 'br') { ctx.textAlign = 'right'; ctx.fillText(txt, tw - 36 * s, th - 22 * s); }
        else { ctx.textAlign = 'center'; ctx.fillText(txt, tw / 2, th - 22 * s); }
        ctx.restore();
      }
    }
  }

  function markDirty(pg) { pg._tdirty = true; }
  function markAllDirty() { pages.forEach(function (p) { p._tdirty = true; }); }
  // page numbers are drawn from the grid position, so any order change invalidates them
  function orderChanged() { if (pageNums) markAllDirty(); }

  var thumbEls = [];
  function renderGrid() {
    grid.innerHTML = '';
    thumbEls = [];
    drop.classList.toggle('pt-drop--has', pages.length > 0);
    pages.forEach(function (pg, idx) {
      var t = document.createElement('div');
      t.className = 'pt-thumb' + (pg.sel ? ' pt-sel' : '');
      t.dataset.idx = idx;

      var c = pg._tc;
      if (!c) { c = pg._tc = document.createElement('canvas'); c.width = 150; c.height = 194; pg._tdirty = true; }
      c.className = 'pt-thumb__canvas';
      t.appendChild(c);
      if (pg._tdirty) {
        pg._tdirty = false;
        t.classList.add('pt-thumb--loading');
        renderThumbInto(c, pg, idx, function () { t.classList.remove('pt-thumb--loading'); });
      }

      var bar = document.createElement('div');
      bar.className = 'pt-thumb__bar';
      bar.innerHTML = '<span class="pt-thumb__num">' + (idx + 1) +
        (pg.redacted ? ' <span class="pt-thumb__redacted" title="Redacted &amp; flattened">▮</span>' : '') +
        (pg.sigs && pg.sigs.length ? ' <span class="pt-thumb__signed" title="Signed">✎</span>' : '') +
        (pg.ocr ? ' <span class="pt-thumb__ocr" title="Searchable text layer added">abc</span>' : '') + '</span>';
      var acts = document.createElement('div');
      acts.className = 'pt-thumb__acts';
      var eb = document.createElement('button'); eb.className = 'pt-thumb__act'; eb.type = 'button'; eb.title = 'Edit page (text, signature, redact, form)'; eb.textContent = '✎';
      eb.addEventListener('click', function (e) { e.stopPropagation(); if (!busy && window.__PT.openEditor) window.__PT.openEditor(idx); });
      var rb = document.createElement('button'); rb.className = 'pt-thumb__act'; rb.type = 'button'; rb.title = 'Rotate 90°'; rb.textContent = '⟳';
      rb.addEventListener('click', function (e) {
        e.stopPropagation(); if (busy) return;
        snapshot('rotate page ' + (idx + 1));
        pg.rot = (pg.rot + 90) % 360; markDirty(pg); renderGrid();
      });
      var db = document.createElement('button'); db.className = 'pt-thumb__act'; db.type = 'button'; db.title = 'Delete page'; db.textContent = '×';
      db.addEventListener('click', function (e) {
        e.stopPropagation(); if (busy) return;
        snapshot('delete page ' + (idx + 1));
        pages.splice(idx, 1); orderChanged(); renderGrid(); updateToolbar();
      });
      acts.appendChild(eb); acts.appendChild(rb); acts.appendChild(db);
      bar.appendChild(acts);
      t.appendChild(bar);

      // click selects (shift-click selects a range); double-click opens the editor
      t.addEventListener('click', function (ev) {
        if (suppressClick) { suppressClick = false; return; }
        if (busy) return;
        if (ev.shiftKey && lastSelIdx >= 0 && lastSelIdx < pages.length) {
          var a = Math.min(lastSelIdx, idx), b = Math.max(lastSelIdx, idx);
          for (var i = a; i <= b; i++) pages[i].sel = true;
        } else {
          pg.sel = !pg.sel;
          lastSelIdx = idx;
        }
        refreshSel();
      });
      t.addEventListener('dblclick', function (e) { e.preventDefault(); if (!busy && window.__PT.openEditor) window.__PT.openEditor(idx); });

      // pointer-based drag to reorder (mouse + touch; long-press on touch)
      t.addEventListener('pointerdown', function (e) { thumbPointerDown(e, t, idx); });

      grid.appendChild(t);
      thumbEls.push(t);
    });
  }

  // light-weight selection refresh (no thumbnail re-render)
  function refreshSel() {
    thumbEls.forEach(function (t, i) { if (pages[i]) t.classList.toggle('pt-sel', !!pages[i].sel); });
    updateToolbar();
  }

  // ---------- pointer-events thumbnail reorder ----------
  var suppressClick = false, dragActive = false;
  // block page scroll while a touch drag is in flight (touch-action can't change mid-gesture)
  document.addEventListener('touchmove', function (e) { if (dragActive) e.preventDefault(); }, { passive: false });
  // a text selection elsewhere on the page (say the intro copy, or Ctrl+A) would turn a
  // thumb drag into a NATIVE drag of that selection — the browser fires pointercancel and
  // the reorder silently dies. Never let a native drag start inside the grid.
  grid.addEventListener('dragstart', function (e) { e.preventDefault(); });

  function thumbPointerDown(e, t, idx) {
    if (busy) return;
    if (e.button != null && e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('.pt-thumb__act')) return;
    var coarse = e.pointerType === 'touch' || e.pointerType === 'pen';
    var pid = e.pointerId, sx = e.clientX, sy = e.clientY;
    var engaged = false, timer = 0, curOver = null, insBefore = false;

    function engage() {
      engaged = true; dragActive = true; suppressClick = true;
      t.classList.add('pt-thumb--drag');
      try { t.setPointerCapture(pid); } catch (er) {}
    }
    if (coarse) timer = setTimeout(engage, 350);   // long-press to drag, so scrolling still works

    function clearOver() {
      if (curOver) { curOver.classList.remove('pt-thumb--before'); curOver.classList.remove('pt-thumb--after'); curOver = null; }
    }
    function cleanup() {
      clearTimeout(timer); clearOver(); dragActive = false;
      t.classList.remove('pt-thumb--drag');
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    }
    function mv(ev) {
      if (ev.pointerId !== pid) return;
      var dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!engaged) {
        if (coarse) { if (Math.abs(dx) + Math.abs(dy) > 10) cleanup(); return; }   // it's a scroll
        if (Math.abs(dx) + Math.abs(dy) > 6) engage(); else return;
      }
      if (ev.cancelable) ev.preventDefault();
      var el = document.elementFromPoint(ev.clientX, ev.clientY);
      var over = el && el.closest ? el.closest('.pt-thumb') : null;
      clearOver();
      if (over && over !== t) {
        var r = over.getBoundingClientRect();
        insBefore = (ev.clientX - r.left) < r.width / 2;
        over.classList.add(insBefore ? 'pt-thumb--before' : 'pt-thumb--after');
        curOver = over;
      }
    }
    function up(ev) {
      if (ev.pointerId !== pid) return;
      var target = curOver, before = insBefore, was = engaged;
      cleanup();
      // a click (if the browser fires one) runs before timeouts, so this only clears
      // a stuck flag when NO click follows the drag
      if (was) setTimeout(function () { suppressClick = false; }, 0);
      if (!was || !target) return;
      var from = idx, to = parseInt(target.dataset.idx, 10) + (before ? 0 : 1);
      if (isNaN(to) || to === from || to === from + 1) return;
      snapshot('move page ' + (from + 1));
      var moved = pages.splice(from, 1)[0];
      pages.splice(from < to ? to - 1 : to, 0, moved);
      lastSelIdx = -1;
      orderChanged(); renderGrid(); updateToolbar();
    }
    function cancel(ev) { if (ev.pointerId !== pid) return; cleanup(); }
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }

  function selectedIdx() {
    var out = []; pages.forEach(function (p, i) { if (p.sel) out.push(i); }); return out;
  }

  // ---------- page-range input ----------
  function rangeState() {
    var v = rangeInput ? rangeInput.value.trim() : '';
    if (!v) return { empty: true, idx: null };
    return { empty: false, idx: PURE.parsePageRange(v, pages.length) };
  }
  function updateRangeInfo() {
    if (!rangeInfo) return;
    var st = rangeState();
    if (st.empty) { rangeInfo.textContent = ''; rangeInfo.classList.remove('pt-range-info--bad'); }
    else if (st.idx) { rangeInfo.textContent = '→ ' + st.idx.length + ' page' + (st.idx.length > 1 ? 's' : ''); rangeInfo.classList.remove('pt-range-info--bad'); }
    else { rangeInfo.textContent = 'invalid'; rangeInfo.classList.add('pt-range-info--bad'); }
  }
  if (rangeInput) rangeInput.addEventListener('input', function () { updateRangeInfo(); updateToolbar(); });

  function updateToolbar() {
    var has = pages.length > 0, sel = selectedIdx().length;
    if (toolbar) toolbar.hidden = !has && docs.length === 0;
    if (has && toolbar) toolbar.hidden = false;
    if (countEl) countEl.textContent = has ? (pages.length + ' page' + (pages.length > 1 ? 's' : '') + (sel ? ', ' + sel + ' selected' : '')) : '';
    if (btnRotate) btnRotate.disabled = sel === 0;
    if (btnRotCcw) btnRotCcw.disabled = sel === 0;
    if (btnDup) btnDup.disabled = sel === 0;
    if (btnDelete) btnDelete.disabled = sel === 0;
    if (btnBlank) btnBlank.disabled = false;
    if (btnUndo) {
      btnUndo.disabled = undoStack.size() === 0;
      var top = undoStack.peek();
      btnUndo.title = top ? ('Undo: ' + top.label + ' (Ctrl+Z)') : 'Undo (Ctrl+Z)';
    }
    var st = rangeState();
    if (btnExtract) btnExtract.disabled = st.empty ? sel === 0 : !(st.idx && st.idx.length);
    if (btnSplit) btnSplit.disabled = !has || (!st.empty && !st.idx);
    if (btnDownload) btnDownload.disabled = !has;
    if (btnSelAll) btnSelAll.textContent = (sel === pages.length && pages.length > 0) ? 'Select none' : 'Select all';
    Array.prototype.forEach.call(document.querySelectorAll('[data-pt-needs-pages]'), function (b) { b.disabled = !has; });
  }

  // ---------- toolbar actions ----------
  btnAdd.addEventListener('click', function () { if (!busy) fileInput.click(); });
  fileInput.addEventListener('change', function () { addFiles(fileInput.files); fileInput.value = ''; });

  drop.addEventListener('click', function (e) { if (busy) return; if (pages.length === 0 && e.target === drop || e.target.classList.contains('pt-drop__hint') || (e.target.parentNode && e.target.parentNode.classList && e.target.parentNode.classList.contains('pt-drop__hint'))) fileInput.click(); });
  ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); if (e.dataTransfer && Array.prototype.some.call(e.dataTransfer.types || [], function (t) { return t === 'Files'; })) drop.classList.add('pt-drop--over'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { if (ev === 'dragleave' && e.target !== drop) return; drop.classList.remove('pt-drop--over'); }); });
  drop.addEventListener('drop', function (e) { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });

  btnSelAll.addEventListener('click', function () {
    if (busy) return;
    var all = selectedIdx().length === pages.length && pages.length > 0;
    pages.forEach(function (p) { p.sel = !all; });
    refreshSel();
  });
  function rotateSelected(delta, label) {
    if (busy) return;
    var sel = selectedIdx(); if (!sel.length) return;
    snapshot(label + ' ' + sel.length + ' page' + (sel.length > 1 ? 's' : ''));
    sel.forEach(function (i) { pages[i].rot = (pages[i].rot + delta) % 360; markDirty(pages[i]); });
    renderGrid();
  }
  btnRotate.addEventListener('click', function () { rotateSelected(90, 'rotate'); });
  if (btnRotCcw) btnRotCcw.addEventListener('click', function () { rotateSelected(270, 'rotate'); });
  btnDelete.addEventListener('click', function () {
    if (busy) return;
    var n = selectedIdx().length; if (!n) return;
    snapshot('delete ' + n + ' page' + (n > 1 ? 's' : ''));
    pages = pages.filter(function (p) { return !p.sel; });
    lastSelIdx = -1;
    orderChanged(); renderGrid(); updateToolbar();
  });
  if (btnDup) btnDup.addEventListener('click', function () {
    if (busy) return;
    var sel = selectedIdx(); if (!sel.length) return;
    snapshot('duplicate ' + sel.length + ' page' + (sel.length > 1 ? 's' : ''));
    for (var k = sel.length - 1; k >= 0; k--) {
      var i = sel[k];
      var copy = PURE.clonePage(pages[i]);
      copy.sel = false;
      pages.splice(i + 1, 0, copy);
    }
    lastSelIdx = -1;
    orderChanged(); renderGrid(); updateToolbar();
    setStatus('Duplicated ' + sel.length + ' page' + (sel.length > 1 ? 's' : '') + '.');
  });
  if (btnBlank) btnBlank.addEventListener('click', function () {
    if (busy) return;
    var sel = selectedIdx();
    var sizeP = sel.length ? effPointSize(pages[sel[0]]) : Promise.resolve({ w: 595.28, h: 841.89 });   // A4 default
    sizeP.then(function (sz) {
      snapshot('insert blank page');
      var pg = newPage(-1, -1);
      pg.blank = { wPt: sz.w, hPt: sz.h };
      var at = sel.length ? sel[sel.length - 1] + 1 : pages.length;
      pages.splice(at, 0, pg);
      lastSelIdx = -1;
      orderChanged(); renderGrid(); updateToolbar();
      setStatus('Inserted a blank page at position ' + (at + 1) + '.');
    });
  });
  if (btnUndo) btnUndo.addEventListener('click', undo);

  // Ctrl/Cmd+Z anywhere on the page (outside the editor, inputs, and dialogs)
  document.addEventListener('keydown', function (e) {
    if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      var ed = $('pt-ed'); if (ed && !ed.hidden) return;
      if (modalOpen()) return;
      var a = document.activeElement;
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
      if (busy || !undoStack.size()) return;
      e.preventDefault();
      undo();
    } else if (e.key === 'Escape') {
      if (passResolve) { passDone(null); return; }
      var ed2 = $('pt-ed'); if (ed2 && !ed2.hidden) return;   // the editor handles its own Escape
      var m = document.querySelector('.pt-modal:not([hidden])');
      if (m) m.hidden = true;
    }
  });

  // ---------- build / download ----------
  function getLibDoc(cache, docIndex) {
    if (cache[docIndex]) return cache[docIndex];
    var d = docs[docIndex];
    cache[docIndex] = PDFLib.PDFDocument.load(d.bytes, { ignoreEncryption: true }).then(function (doc) {
      // apply any filled form values, then flatten so the values bake into page content
      if (d.formValues && Object.keys(d.formValues).length) {
        try {
          var form = doc.getForm();
          Object.keys(d.formValues).forEach(function (name) {
            var val = d.formValues[name];
            try {
              var f = form.getField(name); var ty = fieldType(f);
              if (ty === 'text') f.setText(val == null ? '' : String(val));
              else if (ty === 'checkbox') { if (val) f.check(); else f.uncheck(); }
              else if ((ty === 'select' || ty === 'radio') && val != null && val !== '') {
                /* pdf.js reports a radio widget's appearance-state name (a bare index
                   like "1" for /Opt-based groups, e.g. ones created by pdf-lib), while
                   pdf-lib select() wants the export value ("chocolate") — when a direct
                   select fails, map an integer state through getOptions() */
                var sv = String(val);
                try { f.select(sv); }
                catch (e3) {
                  var opts = (typeof f.getOptions === 'function') ? f.getOptions() : null;
                  var oi = parseInt(sv, 10);
                  if (opts && oi >= 0 && oi < opts.length && String(oi) === sv) f.select(String(opts[oi]));
                }
              }
            } catch (e2) {}
          });
          form.flatten();
        } catch (e) {}
      }
      return doc;
    });
    return cache[docIndex];
  }

  // standard fonts offered by the text tool (built into pdf-lib, no embedding needed)
  var STD_FONTS = {
    'Helvetica': PDFLib.StandardFonts.Helvetica, 'Times': PDFLib.StandardFonts.TimesRoman,
    'Courier': PDFLib.StandardFonts.Courier
  };
  function hexToRgb(h) {
    h = (h || '#111111').replace('#', ''); if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 };
  }

  // draw a page's watermarks, signature images, text annotations, invisible OCR words,
  // and page number on the just-added output page. Rotation-0 math — pages that carry
  // overlays are always made effective-rotation-0 first (ensureUpright / bake).
  function drawOverlays(out, info, pg, fontCache, outIdx, outTotal) {
    var chain = Promise.resolve();
    function helv() {
      return Promise.resolve(fontCache.Helvetica || (fontCache.Helvetica = out.embedFont(PDFLib.StandardFonts.Helvetica)));
    }
    (pg.wms || []).forEach(function (wm) {
      chain = chain.then(function () {
        return helv().then(function (font) { PURE.drawWatermark(PDFLib, info.page, font, wm, info.w, info.h); })
          .catch(function (e) { if (window.console) console.warn('pdftools: a watermark could not be drawn.', e); });
      });
    });
    (pg.sigs || []).forEach(function (sig) {
      chain = chain.then(function () {
        return out.embedPng(sig.png).then(function (img) {
          info.page.drawImage(img, { x: sig.x * info.w, y: info.h - (sig.y + sig.h) * info.h, width: sig.w * info.w, height: sig.h * info.h });
        }).catch(function (e) { if (window.console) console.warn('pdftools: a signature could not be drawn.', e); });
      });
    });
    (pg.texts || []).forEach(function (t) {
      chain = chain.then(function () {
        var key = t.font || 'Helvetica';
        var fp = fontCache[key] || (fontCache[key] = out.embedFont(STD_FONTS[key] || PDFLib.StandardFonts.Helvetica));
        return Promise.resolve(fp).then(function (font) {
          var c = hexToRgb(t.color), col = PDFLib.rgb(c.r, c.g, c.b);
          (t.text || '').split('\n').forEach(function (line, i) {
            if (!line) return;
            info.page.drawText(line, { x: t.x * info.w, y: info.h - t.y * info.h - t.size * 0.82 - i * t.size * 1.2, size: t.size, font: font, color: col });
          });
        }).catch(function (e) { if (window.console) console.warn('pdftools: a text box could not be drawn.', e); });
      });
    });
    if (pg.ocrWords && pg.ocrWords.length) {
      chain = chain.then(function () {
        return helv().then(function (font) { PURE.drawOcrWords(PDFLib, info.page, font, pg.ocrWords, info.w, info.h); })
          .catch(function (e) { if (window.console) console.warn('pdftools: the OCR text layer could not be drawn.', e); });
      });
    }
    if (pageNums) {
      chain = chain.then(function () {
        return helv().then(function (font) { PURE.drawPageNum(PDFLib, info.page, font, pageNums, outIdx, outTotal, info.w, info.h); })
          .catch(function (e) { if (window.console) console.warn('pdftools: a page number could not be drawn.', e); });
      });
    }
    return chain;
  }

  // last-resort: render a page to an image and add it as an image-only page, so a page
  // pdf-lib can't copy (odd/edge-case source PDFs) still makes it into the output
  function rasterFallback(out, pg) {
    return effPointSize(pg).then(function (sz) {
      return renderPageCanvas(pg, Math.max(1, sz.w * 150 / 72)).then(function (r) {
        var c = document.createElement('canvas'); c.width = r.canvas.width; c.height = r.canvas.height;
        var cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height); cx.drawImage(r.canvas, 0, 0);
        return canvasToBytes(c, 'image/jpeg', 0.85).then(function (jpg) {
          return out.embedJpg(jpg).then(function (img) {
            var p = out.addPage([sz.w, sz.h]); p.drawImage(img, { x: 0, y: 0, width: sz.w, height: sz.h });
            return { page: p, w: sz.w, h: sz.h };
          });
        });
      });
    });
  }

  // onTick(done, total) is awaited after each page so the progress bar can paint
  function buildPdf(pageList, onTick) {
    var cache = {}, fontCache = {}, failures = 0;
    lastFlattened = 0;
    return PDFLib.PDFDocument.create().then(function (out) {
      var chain = Promise.resolve();
      pageList.forEach(function (pg, i) {
        chain = chain.then(function () {
          var added;
          if (pg.blank) {
            var sw = (pg.rot % 180) !== 0;
            var bw = sw ? pg.blank.hPt : pg.blank.wPt, bh = sw ? pg.blank.wPt : pg.blank.hPt;
            var bp = out.addPage([bw, bh]);
            added = Promise.resolve({ page: bp, w: bw, h: bh });
          } else if (pg.raster) {
            added = out.embedPng(pg.raster.png).then(function (img) {
              var p = out.addPage([pg.raster.wPt, pg.raster.hPt]);
              p.drawImage(img, { x: 0, y: 0, width: pg.raster.wPt, height: pg.raster.hPt });
              if (pg.rot) { try { p.setRotation(PDFLib.degrees(((pg.rot % 360) + 360) % 360)); } catch (e) {} }
              return { page: p, w: pg.raster.wPt, h: pg.raster.hPt };
            });
          } else {
            added = Promise.resolve(getLibDoc(cache, pg.docIndex)).then(function (src) {
              // pdf-lib loads encrypted PDFs (ignoreEncryption) but does NOT decrypt their streams,
              // so copyPages would copy encrypted garbage → blank/corrupt pages. pdf.js decrypts and
              // renders fine, so route encrypted sources through the rasterize fallback instead.
              if (src && src.isEncrypted) throw new Error('encrypted source PDF; rasterizing to preserve content');
              return out.copyPages(src, [pg.pageIndex]).then(function (cps) {
                var cp = cps && cps[0];
                if (!cp) throw new Error('copyPages returned no page');
                if (pg.rot) {
                  var base = (cp.getRotation && cp.getRotation().angle) || 0;
                  cp.setRotation(PDFLib.degrees((base + pg.rot) % 360));
                }
                out.addPage(cp);
                var sz = cp.getSize();
                return { page: cp, w: sz.width, h: sz.height };
              });
            }).catch(function (e) {
              if (window.console) console.warn('pdftools: could not copy a page, rasterizing it instead.', e);
              lastFlattened++;
              return rasterFallback(out, pg);
            });
          }
          return added.then(function (info) { return drawOverlays(out, info, pg, fontCache, i, pageList.length); })
            .catch(function (e) { failures++; if (window.console) console.warn('pdftools: a page failed and was skipped.', e); })
            .then(function () { return onTick ? onTick(i + 1, pageList.length) : null; });
        });
      });
      return chain.then(function () { return applyMetadata(out, cache); }).then(function () {
        if (failures && out.getPageCount() === 0) throw new Error('No pages could be processed.');
        if (failures) setStatus(failures + ' page(s) could not be processed and were skipped.');
        return out.save();
      });
    });
  }

  function applyMetadata(out, cache) {
    if (chkStrip.checked) {
      out.setTitle(''); out.setAuthor(''); out.setSubject(''); out.setKeywords([]);
      out.setProducer(''); out.setCreator('');
      try { out.setCreationDate(new Date(0)); out.setModificationDate(new Date(0)); } catch (e) {}
      return Promise.resolve();
    }
    // not stripping: carry over title/author/subject from the FIRST source doc, best-effort
    if (!docs.length) return Promise.resolve();
    return Promise.resolve(getLibDoc(cache, 0)).then(function (src) {
      try {
        if (src.getTitle && src.getTitle()) out.setTitle(src.getTitle());
        if (src.getAuthor && src.getAuthor()) out.setAuthor(src.getAuthor());
        if (src.getSubject && src.getSubject()) out.setSubject(src.getSubject());
      } catch (e) {}
    }).catch(function () {});
  }

  function exportName(kind) {
    return PURE.deriveExportName(docs.length ? docs[0].name : '', docs.length, kind);
  }

  function downloadBytes(bytes, name, mime) {
    var url = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/pdf' }));
    var a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function buildTick(verb) {
    return function (d, t) { return progress(d, t, verb + ' page ' + d + ' of ' + t + '…'); };
  }

  btnDownload.addEventListener('click', function () {
    if (!pages.length || busy) return;
    setBusy(true);
    progress(0, pages.length, 'Building PDF…');
    buildPdf(pages, buildTick('Building')).then(function (bytes) {
      var name = exportName('download');
      downloadBytes(bytes, name);
      setStatus('Saved ' + name + ' (' + fmtSize(bytes.length) + ').' + flattenNote());
    }).catch(function (e) { setStatus('Error: ' + (e && e.message || e)); })
      .then(function () { setBusy(false); });
  });

  btnExtract.addEventListener('click', function () {
    if (busy) return;
    var st = rangeState();
    var idxs = st.empty ? selectedIdx() : st.idx;
    if (!idxs || !idxs.length) return;
    setBusy(true);
    var list = idxs.map(function (i) { return pages[i]; });
    progress(0, list.length, 'Extracting ' + list.length + ' page' + (list.length > 1 ? 's' : '') + '…');
    buildPdf(list, buildTick('Extracting')).then(function (bytes) {
      var name = exportName('extract');
      downloadBytes(bytes, name);
      setStatus('Saved ' + name + ' (' + list.length + ' page' + (list.length > 1 ? 's' : '') + ', ' + fmtSize(bytes.length) + ').' + flattenNote());
    }).catch(function (e) { setStatus('Error: ' + (e && e.message || e)); })
      .then(function () { setBusy(false); });
  });

  btnSplit.addEventListener('click', function () {
    if (!pages.length || busy) return;
    var st = rangeState();
    var idxs = st.empty ? pages.map(function (_, i) { return i; }) : st.idx;
    if (!idxs || !idxs.length) return;
    setBusy(true);
    var files = []; var chain = Promise.resolve();
    idxs.forEach(function (pi, k) {
      chain = chain.then(function () {
        return progress(k, idxs.length, 'Splitting page ' + (k + 1) + ' of ' + idxs.length + '…');
      }).then(function () {
        return buildPdf([pages[pi]]).then(function (bytes) {
          files.push({ name: 'page-' + String(pi + 1).padStart(3, '0') + '.pdf', data: bytes });
        });
      });
    });
    chain.then(function () {
      var zip = storeZip(files);
      var name = exportName('split');
      downloadBytes(zip, name, 'application/zip');
      setStatus('Saved ' + name + ' (' + files.length + ' files, ' + fmtSize(zip.length) + ').');
    }).catch(function (e) { setStatus('Error: ' + (e && e.message || e)); })
      .then(function () { setBusy(false); });
  });

  function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(2) + ' MB'; }
  function flattenNote() { return lastFlattened ? ' ' + lastFlattened + ' page(s) from an encrypted or damaged PDF were flattened to images.' : ''; }

  // ---------- shared page-render helpers (used by sign / compress / redact-bake / OCR) ----------
  function canvasToBytes(canvas, type, quality) {
    return new Promise(function (res, rej) {
      canvas.toBlob(function (b) {
        if (!b) { rej(new Error('page too large to rasterize at this DPI')); return; }  /* toBlob yields null past the browser canvas limit */
        b.arrayBuffer().then(function (ab) { res(new Uint8Array(ab)); }, rej);
      }, type, quality);
    });
  }
  function effPointSize(pg) {
    var sw = (pg.rot % 180) !== 0;
    if (pg.blank) return Promise.resolve({ w: sw ? pg.blank.hPt : pg.blank.wPt, h: sw ? pg.blank.wPt : pg.blank.hPt });
    if (pg.raster) return Promise.resolve({ w: sw ? pg.raster.hPt : pg.raster.wPt, h: sw ? pg.raster.wPt : pg.raster.hPt });
    return docs[pg.docIndex].js.getPage(pg.pageIndex + 1).then(function (page) {
      var v1 = page.getViewport({ scale: 1, rotation: totalRotation(page, pg.rot) });
      return { w: v1.width, h: v1.height };
    });
  }
  function pageEffRotation(pg) {
    if (pg.blank) return Promise.resolve(0);
    if (pg.raster) return Promise.resolve(((pg.rot || 0) % 360 + 360) % 360);
    return docs[pg.docIndex].js.getPage(pg.pageIndex + 1).then(function (page) { return totalRotation(page, pg.rot); });
  }
  // render `pg` (raster, blank, or vector, at its effective rotation) to a canvas `targetPxWidth` wide
  function renderPageCanvas(pg, targetPxWidth) {
    if (pg.blank) {
      var sw = (pg.rot % 180) !== 0;
      var bw = sw ? pg.blank.hPt : pg.blank.wPt, bh = sw ? pg.blank.wPt : pg.blank.hPt;
      var c0 = document.createElement('canvas');
      c0.width = Math.max(1, Math.round(targetPxWidth));
      c0.height = Math.max(1, Math.round(targetPxWidth * bh / bw));
      var b0 = c0.getContext('2d'); b0.fillStyle = '#fff'; b0.fillRect(0, 0, c0.width, c0.height);
      return Promise.resolve({ canvas: c0, wPt: bw, hPt: bh });
    }
    if (pg.raster) {
      var sw2 = (pg.rot % 180) !== 0;
      return rasterToCanvas(pg, targetPxWidth).then(function (c) {
        return { canvas: c, wPt: sw2 ? pg.raster.hPt : pg.raster.wPt, hPt: sw2 ? pg.raster.wPt : pg.raster.hPt };
      });
    }
    return docs[pg.docIndex].js.getPage(pg.pageIndex + 1).then(function (page) {
      var rot = totalRotation(page, pg.rot);
      var v1 = page.getViewport({ scale: 1, rotation: rot });
      var vp = page.getViewport({ scale: targetPxWidth / v1.width, rotation: rot });
      var c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      return page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise.then(function () {
        return { canvas: c, wPt: v1.width, hPt: v1.height };
      });
    });
  }
  // flatten a page to an image in place (used to make a rotated page upright before
  // signing / adding text / watermarking / OCR)
  function bakePageToRaster(pg, dpi) {
    return effPointSize(pg).then(function (sz) {
      return renderPageCanvas(pg, Math.max(1, sz.w * dpi / 72)).then(function (r) {
        return canvasToBytes(r.canvas, 'image/png').then(function (png) {
          pg.raster = { png: png, wPt: sz.w, hPt: sz.h };
          pg.rot = 0; pg.blank = null;
          markDirty(pg);
          return pg;
        });
      });
    });
  }

  // draw a page's live decorations (watermarks, page number, texts, signatures) onto a
  // canvas produced by renderPageCanvas. Pages→images and Shrink build their output
  // straight from canvases, which would otherwise silently DROP everything the user
  // just applied (the thumbnails preview it, so the export must match). Resolves after
  // the async signature images have actually drawn.
  function drawDecor(canvas, pg, gridIdx) {
    return effPointSize(pg).then(function (sz) {
      var ctx = canvas.getContext('2d'), tw = canvas.width, th = canvas.height;
      drawMarks(ctx, pg, tw, th, sz.w, sz.h, gridIdx);
      (pg.texts || []).forEach(function (t) {
        var px = Math.max(1, t.size * tw / sz.w);
        ctx.fillStyle = t.color || '#111'; ctx.font = px + 'px ' + (t.font || 'Helvetica');
        ctx.textBaseline = 'top'; ctx.textAlign = 'left';
        (t.text || '').split('\n').forEach(function (line, i) { ctx.fillText(line, t.x * tw, t.y * th + i * px * 1.2); });
      });
      return Promise.all((pg.sigs || []).map(function (s) {
        return new Promise(function (res) {
          var im = new Image();
          im.onload = function () { ctx.drawImage(im, s.x * tw, s.y * th, s.w * tw, s.h * th); res(); };
          im.onerror = function () { res(); };
          pngUrlInto(im, s.png);
        });
      }));
    });
  }

  // ---------- form fields ----------
  function getFormFields(docIndex) {
    return PDFLib.PDFDocument.load(docs[docIndex].bytes, { ignoreEncryption: true }).then(function (doc) {
      var out = [];
      try {
        doc.getForm().getFields().forEach(function (f) {
          var type = fieldType(f);
          if (!type) return;
          var rec = { name: f.getName(), type: type };
          try { if (type === 'select' || type === 'radio') rec.options = f.getOptions(); } catch (e) {}
          try { if (type === 'text') rec.value = f.getText() || ''; } catch (e) {}
          try { if (type === 'checkbox') rec.value = !!f.isChecked(); } catch (e) {}
          try { if (type === 'select') rec.value = (f.getSelected && f.getSelected()[0]) || ''; } catch (e) {}
          out.push(rec);
        });
      } catch (e) {}
      return out;
    });
  }

  // ---------- compress (rasterize every page to JPEG) ----------
  function compress(dpi, quality, onTick) {
    return PDFLib.PDFDocument.create().then(function (out) {
      var chain = Promise.resolve();
      pages.forEach(function (pg, i) {
        chain = chain.then(function () {
          return effPointSize(pg).then(function (sz) {
            return renderPageCanvas(pg, Math.max(1, sz.w * dpi / 72)).then(function (r) {
              var c = document.createElement('canvas'); c.width = r.canvas.width; c.height = r.canvas.height;
              var cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height); cx.drawImage(r.canvas, 0, 0);
              r.canvas.width = 0;   // free the intermediate canvas
              // keep the user's watermarks / page numbers / texts / signatures — the raw
              // render has only the source page content
              return drawDecor(c, pg, i).then(function () {
                return canvasToBytes(c, 'image/jpeg', quality);
              }).then(function (jpg) {
                c.width = 0;
                return out.embedJpg(jpg).then(function (img) {
                  out.addPage([sz.w, sz.h]).drawImage(img, { x: 0, y: 0, width: sz.w, height: sz.h });
                });
              });
            });
          }).then(function () { return onTick ? onTick(i + 1, pages.length) : null; });
        });
      });
      return chain.then(function () {
        out.setProducer(''); out.setCreator('');
        try { out.setCreationDate(new Date(0)); out.setModificationDate(new Date(0)); } catch (e) {}
        return out.save();
      });
    });
  }
  function inputSize() { return docs.reduce(function (a, d) { return a + d.bytes.length; }, 0); }

  // ---------- shared API for the editor + tools modules ----------
  window.__PT = {
    PURE: PURE,
    jsBase: jsBase,
    pages: function () { return pages; },
    docs: function () { return docs; },
    selectedIdx: selectedIdx,
    totalRotation: totalRotation,
    renderGrid: renderGrid,
    refreshSel: refreshSel,
    updateToolbar: updateToolbar,
    setStatus: setStatus,
    buildPdf: buildPdf,
    buildTick: buildTick,
    renderPageCanvas: renderPageCanvas,
    bakePageToRaster: bakePageToRaster,
    pageEffRotation: pageEffRotation,
    effPointSize: effPointSize,
    canvasToBytes: canvasToBytes,
    getFormFields: getFormFields,
    pdfjsPage: function (pg) { return docs[pg.docIndex].js.getPage(pg.pageIndex + 1); },
    drawMarks: drawMarks,
    drawDecor: drawDecor,
    markDirty: markDirty,
    markAllDirty: markAllDirty,
    orderChanged: orderChanged,
    snapshot: snapshot,
    dropSnapshot: dropSnapshot,
    undo: undo,
    isBusy: function () { return busy; },
    setBusy: setBusy,
    progress: progress,
    progressDone: progressDone,
    nextFrame: nextFrame,
    modalOpen: modalOpen,
    openDialog: openDialog,
    exportName: exportName,
    downloadBytes: downloadBytes,
    fmtSize: fmtSize,
    getPageNums: function () { return pageNums; },
    setPageNums: function (cfg) { pageNums = cfg; },
    rangeState: rangeState
  };

  // ---------- compress dialog ----------
  var shrinkDialog = $('pt-shrink-dialog'), shrinkSel = $('pt-shrink-dpi');
  if (btnShrink) btnShrink.addEventListener('click', function () { if (pages.length) openDialog(shrinkDialog); });
  var shrinkCancel = $('pt-shrink-cancel'); if (shrinkCancel) shrinkCancel.addEventListener('click', function () { shrinkDialog.hidden = true; });
  var shrinkGo = $('pt-shrink-go');
  if (shrinkGo) shrinkGo.addEventListener('click', function () {
    shrinkDialog.hidden = true;
    if (!pages.length || busy) return;
    setBusy(true);
    var parts = (shrinkSel.value || '150,0.7').split(','), dpi = parseInt(parts[0], 10) || 150, q = parseFloat(parts[1]) || 0.7;
    progress(0, pages.length, 'Shrinking ' + pages.length + ' page' + (pages.length > 1 ? 's' : '') + '…');
    var before = inputSize();
    compress(dpi, q, buildTick('Shrinking')).then(function (bytes) {
      var name = exportName('compressed');
      downloadBytes(bytes, name);
      var pct = before ? Math.round((1 - bytes.length / before) * 100) : 0;
      setStatus('Saved ' + name + ' — ' + fmtSize(bytes.length) + (before ? ' (input was ' + fmtSize(before) + ', ' + (pct >= 0 ? pct + '% smaller' : Math.abs(pct) + '% larger') + ')' : '') + '.');
    }).catch(function (e) { setStatus('Error: ' + (e && e.message || e)); })
      .then(function () { setBusy(false); });
  });
  if (shrinkDialog) shrinkDialog.addEventListener('click', function (e) { if (e.target === shrinkDialog) shrinkDialog.hidden = true; });

  // ---------- store-only ZIP writer (no deps) ----------
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
  })();
  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function storeZip(files) {
    var enc = new TextEncoder();
    var locals = [], central = [], offset = 0;
    files.forEach(function (f) {
      var name = enc.encode(f.name), data = f.data, crc = crc32(data);
      var lh = new Uint8Array(30 + name.length);
      var dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0, true);
      dv.setUint16(8, 0, true); dv.setUint16(10, 0, true); dv.setUint16(12, 0, true);
      dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
      dv.setUint16(26, name.length, true); dv.setUint16(28, 0, true);
      lh.set(name, 30);
      locals.push(lh, data);
      var ch = new Uint8Array(46 + name.length); var cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true); cv.setUint16(10, 0, true); cv.setUint16(12, 0, true); cv.setUint16(14, 0, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
      ch.set(name, 46);
      central.push(ch);
      offset += lh.length + data.length;
    });
    var cdSize = central.reduce(function (a, c) { return a + c.length; }, 0);
    var eocd = new Uint8Array(22); var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    var parts = locals.concat(central, [eocd]);
    var total = parts.reduce(function (a, p) { return a + p.length; }, 0);
    var out = new Uint8Array(total), pos = 0;
    parts.forEach(function (p) { out.set(p, pos); pos += p.length; });
    return out;
  }
  window.__PT.storeZip = storeZip;

  // ---------- init ----------
  // Hoist the full-screen editor + dialogs to <body> so a nested stacking context
  // can't trap them under the site masthead.
  Array.prototype.forEach.call(document.querySelectorAll('.pt-modal, #pt-ed'), function (el) { document.body.appendChild(el); });
  updateToolbar();
  updateRangeInfo();
  if (engineNote) engineNote.hidden = true;   // libs already loaded (defer order guarantees it)
})();
