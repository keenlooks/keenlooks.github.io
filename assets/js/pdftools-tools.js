/* PDF Toolbench — document-level tools: watermark, page numbers, export pages as
   images, OCR ("make searchable"), and password-protect (encrypt). All state lives in
   the core (window.__PT / assets/js/pdftools.js); this module wires the dialogs and
   drives the long operations with the shared progress + undo machinery.

   OCR is tesseract.js v5 (Apache-2.0), vendored under assets/js/tesseractlib/ and
   lazy-loaded on first use. Encryption is qpdf compiled to WebAssembly (Apache-2.0),
   vendored under assets/js/qpdflib/, also lazy-loaded. Neither ever sees the network:
   the engines are served from this site and the PDF stays in the page.

   External file (never HTML-compressed) so // comments are fine here. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var PT = window.__PT;
  if (!PT || !PT.PURE) return;
  var PURE = PT.PURE;

  // ---------- small shared helpers ----------
  function allIdx() { return PT.pages().map(function (_, i) { return i; }); }

  function fillScope(selEl) {
    var n = PT.pages().length, s = PT.selectedIdx().length;
    selEl.innerHTML = '';
    var oAll = document.createElement('option');
    oAll.value = 'all'; oAll.textContent = 'All pages (' + n + ')';
    var oSel = document.createElement('option');
    oSel.value = 'sel'; oSel.textContent = 'Selected pages (' + s + ')';
    oSel.disabled = s === 0;
    selEl.appendChild(oAll); selEl.appendChild(oSel);
    selEl.value = s ? 'sel' : 'all';
  }
  function scopeIdx(selEl) { return selEl.value === 'sel' ? PT.selectedIdx() : allIdx(); }

  // run fn(pg, pageIdx, k) serially over the given grid indices with progress ticks
  function eachPage(idxs, fn, verb) {
    var chain = Promise.resolve();
    idxs.forEach(function (pi, k) {
      chain = chain.then(function () {
        return PT.progress(k, idxs.length, verb + ' page ' + (k + 1) + ' of ' + idxs.length + '…');
      }).then(function () { return fn(PT.pages()[pi], pi, k); });
    });
    return chain.then(function () { return PT.progress(idxs.length, idxs.length); });
  }

  // overlays use rotation-0 math, so flatten a rotated page upright first
  // (same rule the editor's text/sign tools follow)
  function ensureUprightPage(pg) {
    return PT.pageEffRotation(pg).then(function (r) {
      if (!r) return false;
      return PT.bakePageToRaster(pg, 150).then(function () { return true; });
    });
  }

  function wireCancel(dialog, btnId) {
    var b = $(btnId);
    if (b) b.addEventListener('click', function () { PT.closeDialog(dialog); });
    dialog.addEventListener('click', function (e) { if (e.target === dialog) PT.closeDialog(dialog); });
  }

  // ==================================================================================
  // Watermark
  // ==================================================================================
  var wmDialog = $('pt-wm-dialog');
  if (wmDialog) {
    var wmText = $('pt-wm-text'), wmPos = $('pt-wm-pos'), wmScope = $('pt-wm-scope'),
        wmOp = $('pt-wm-op'), wmOpVal = $('pt-wm-op-val'),
        wmSize = $('pt-wm-size'), wmSizeVal = $('pt-wm-size-val'),
        wmRemove = $('pt-wm-remove');
    function wmLabels() {
      if (wmOpVal) wmOpVal.textContent = wmOp.value + '%';
      if (wmSizeVal) wmSizeVal.textContent = wmSize.value + ' pt';
    }
    wmOp.addEventListener('input', wmLabels);
    wmSize.addEventListener('input', wmLabels);

    $('pt-watermark').addEventListener('click', function () {
      if (!PT.pages().length) return;
      fillScope(wmScope);
      var any = PT.pages().some(function (p) { return p.wms && p.wms.length; });
      wmRemove.hidden = !any;
      wmLabels();
      if (PT.openDialog(wmDialog)) setTimeout(function () { wmText.focus(); }, 0);
    });
    wireCancel(wmDialog, 'pt-wm-cancel');

    $('pt-wm-go').addEventListener('click', function () {
      var text = wmText.value.trim();
      if (!text) { wmText.focus(); return; }
      var idxs = scopeIdx(wmScope);
      PT.closeDialog(wmDialog);
      if (!idxs.length || PT.isBusy()) return;
      PT.setBusy(true);
      PT.snapshot('watermark ' + idxs.length + ' page' + (idxs.length > 1 ? 's' : ''));
      var wm = {
        text: text,
        pos: wmPos.value,
        opacity: Math.max(0.02, Math.min(0.9, (parseInt(wmOp.value, 10) || 15) / 100)),
        size: Math.max(6, Math.min(200, parseInt(wmSize.value, 10) || 48))
      };
      var wmFlat = 0;
      eachPage(idxs, function (pg) {
        return ensureUprightPage(pg).then(function (flattened) {
          if (flattened) wmFlat++;
          (pg.wms || (pg.wms = [])).push({ text: wm.text, pos: wm.pos, opacity: wm.opacity, size: wm.size });
          PT.markDirty(pg);
        });
      }, 'Watermarking').then(function () {
        PT.renderGrid();
        PT.setStatus('Watermarked ' + idxs.length + ' page' + (idxs.length > 1 ? 's' : '') + '.' +
          (wmFlat ? ' ' + wmFlat + ' rotated page' + (wmFlat > 1 ? 's were' : ' was') + ' flattened upright first (Ctrl+Z undoes it).' : '') +
          ' Download to save the result.');
      }).catch(function (e) { PT.setStatus('Watermark failed: ' + (e && e.message || e), 'err'); })
        .then(function () { PT.setBusy(false); });
    });

    wmRemove.addEventListener('click', function () {
      // respect the same "Apply to" scope shown above this button, not always every page
      var idxs = scopeIdx(wmScope), scoped = wmScope.value === 'sel';
      PT.closeDialog(wmDialog);
      if (PT.isBusy()) return;
      PT.snapshot('remove watermarks');
      var n = 0;
      idxs.forEach(function (pi) {
        var pg = PT.pages()[pi];
        if (pg.wms && pg.wms.length) { pg.wms = []; PT.markDirty(pg); n++; }
      });
      PT.renderGrid(); PT.updateToolbar();
      PT.setStatus('Removed watermarks from ' + n + ' page' + (n === 1 ? '' : 's') + (scoped ? ' (selected pages only)' : '') + '.');
    });
  }

  // ==================================================================================
  // Page numbers
  // ==================================================================================
  var pnDialog = $('pt-pn-dialog');
  if (pnDialog) {
    var pnFmt = $('pt-pn-fmt'), pnPos = $('pt-pn-pos'), pnStart = $('pt-pn-start'),
        pnSize = $('pt-pn-size'), pnSkip = $('pt-pn-skip'), pnRemove = $('pt-pn-remove');

    $('pt-pagenums').addEventListener('click', function () {
      if (!PT.pages().length) return;
      var cur = PT.getPageNums();
      if (cur) {
        pnFmt.value = cur.fmt; pnPos.value = cur.pos; pnStart.value = cur.start;
        pnSize.value = String(cur.size); pnSkip.checked = !!cur.skipFirst;
      }
      pnRemove.hidden = !cur;
      PT.openDialog(pnDialog);
    });
    wireCancel(pnDialog, 'pt-pn-cancel');

    $('pt-pn-go').addEventListener('click', function () {
      PT.closeDialog(pnDialog);
      if (!PT.pages().length || PT.isBusy()) return;
      var cfg = {
        fmt: pnFmt.value === 'nofm' ? 'nofm' : 'n',
        pos: pnPos.value === 'br' ? 'br' : 'bc',
        start: Math.max(1, parseInt(pnStart.value, 10) || 1),
        skipFirst: !!pnSkip.checked,
        size: Math.max(6, Math.min(36, parseInt(pnSize.value, 10) || 10))
      };
      /* honesty check: with "Skip the first page" on a 1-page document, no page gets a
         label — announcing plain success there would be a lie */
      var pnTotal = PT.pages().length, pnAny = false;
      for (var pnI = 0; pnI < pnTotal; pnI++) {
        if (PURE.pageNumText(cfg, pnI, pnTotal) != null) { pnAny = true; break; }
      }
      PT.setBusy(true);
      PT.snapshot('page numbers');
      // numbers are drawn with rotation-0 math, so flatten any rotated pages first —
      // and SAY so (the watermark flow discloses the same flatten; this one must too).
      // Only flatten pages that will actually RECEIVE a number (e.g. "Skip the first
      // page" leaves the cover page alone) — flattening it anyway would needlessly
      // destroy that page's vector quality for nothing.
      var pnFlat = 0;
      eachPage(allIdx(), function (pg, pi) {
        if (PURE.pageNumText(cfg, pi, pnTotal) == null) return Promise.resolve();
        return ensureUprightPage(pg).then(function (f) { if (f) pnFlat++; });
      }, 'Preparing').then(function () {
        PT.setPageNums(cfg);
        PT.markAllDirty();
        PT.renderGrid();
        PT.setStatus((pnAny
          ? 'Page numbers on. They follow the current page order and are added on download.'
          : 'Page numbering is set, but with “Skip the first page” checked this 1-page document gets no visible number; pages added later will be numbered.') +
          (pnFlat ? ' ' + pnFlat + ' rotated page' + (pnFlat > 1 ? 's were' : ' was') + ' flattened upright first (Ctrl+Z undoes it).' : ''));
      }).catch(function (e) { PT.setStatus('Page numbering failed: ' + (e && e.message || e), 'err'); })
        .then(function () { PT.setBusy(false); });
    });

    pnRemove.addEventListener('click', function () {
      PT.closeDialog(pnDialog);
      if (PT.isBusy()) return;
      PT.snapshot('remove page numbers');
      PT.setPageNums(null);
      PT.markAllDirty();
      PT.renderGrid(); PT.updateToolbar();
      PT.setStatus('Page numbers removed.');
    });
  }

  // ==================================================================================
  // Export pages as images
  // ==================================================================================
  var imgDialog = $('pt-img-dialog');
  if (imgDialog) {
    var imgDpi = $('pt-img-dpi'), imgFmt = $('pt-img-fmt'), imgScope = $('pt-img-scope');

    $('pt-images').addEventListener('click', function () {
      if (!PT.pages().length) return;
      fillScope(imgScope);
      PT.openDialog(imgDialog);
    });
    wireCancel(imgDialog, 'pt-img-cancel');

    $('pt-img-go').addEventListener('click', function () {
      var dpi = parseInt(imgDpi.value, 10) || 150;
      var fmt = imgFmt.value === 'jpeg' ? 'jpeg' : 'png';
      var idxs = scopeIdx(imgScope);
      PT.closeDialog(imgDialog);
      if (!idxs.length || PT.isBusy()) return;
      PT.setBusy(true);
      var docs = PT.docs();
      var list = idxs.map(function (i) { return PT.pages()[i]; });
      // per-file names (and the zip name) must come from a doc that still has live pages
      // AMONG THE ONES BEING EXPORTED — docs[0] may be fully deleted (tombstoned), or
      // simply not part of a "selected pages" subset, and would haunt the filenames
      var live = PT.liveDocIndices(list);
      var base = PURE.sanitizeBaseName(live.length ? docs[live[0]].name : '');
      var ext = fmt === 'jpeg' ? 'jpg' : 'png';
      var files = [], dpiCapped = 0, dpiFloor = dpi;
      eachPage(idxs, function (pg, pi) {
        return PT.effPointSize(pg).then(function (sz) {
          var scale = Math.min(dpi / 72, 4000 / sz.w, 4000 / sz.h);
          var effDpi = scale * 72;
          // a huge page silently rendered below the requested DPI must be disclosed
          if (effDpi < dpi - 0.5) { dpiCapped++; dpiFloor = Math.min(dpiFloor, effDpi); }
          return PT.renderPageCanvas(pg, Math.max(1, sz.w * scale));
        }).then(function (r) {
          // keep the user's form fill-ins, watermarks / page numbers / texts /
          // signatures — the raw render has only the source page content
          return PT.paintFormValues(r.canvas, pg)
            .then(function () { return PT.drawDecor(r.canvas, pg, pi); })
            .then(function () { return r; });
        }).then(function (r) {
          var c = r.canvas;
          if (fmt === 'jpeg') {
            var c2 = document.createElement('canvas'); c2.width = c.width; c2.height = c.height;
            var cx = c2.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c2.width, c2.height); cx.drawImage(c, 0, 0);
            c.width = 0; c = c2;
          }
          return PT.canvasToBytes(c, 'image/' + fmt, fmt === 'jpeg' ? 0.9 : undefined).then(function (bytes) {
            c.width = 0;   // free the canvas
            files.push({ name: base + '-page-' + String(pi + 1).padStart(3, '0') + '.' + ext, data: bytes });
          });
        });
      }, 'Rendering').then(function () {
        if (!files.length) throw new Error('no pages could be rendered');
        var note = dpiCapped ? (' ' + dpiCapped + ' page' + (dpiCapped > 1 ? 's were' : ' was') +
          ' too large for ' + dpi + ' DPI and rendered at about ' + Math.round(dpiFloor) + ' DPI instead.') : '';
        var kind = dpiCapped ? 'warn' : undefined;
        if (files.length === 1) {
          PT.downloadBytes(files[0].data, files[0].name, 'image/' + fmt);
          PT.setStatus('Saved ' + files[0].name + ' (' + PT.fmtSize(files[0].data.length) + ').' + note, kind);
        } else {
          var zip = PT.storeZip(files);
          var name = PT.exportName('images', list);
          PT.downloadBytes(zip, name, 'application/zip');
          PT.setStatus('Saved ' + name + ' (' + files.length + ' images, ' + PT.fmtSize(zip.length) + ').' + note, kind);
        }
      }).catch(function (e) { PT.setStatus('Image export failed: ' + (e && e.message || e), 'err'); })
        .then(function () { PT.setBusy(false); });
    });
  }

  // ==================================================================================
  // OCR — "Make searchable"
  // ==================================================================================
  var ocrDialog = $('pt-ocr-dialog');
  var tessPromise = null;
  var ocrCurPage = -1, ocrTotal = 0;

  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (tessPromise) return tessPromise;
    tessPromise = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = PT.jsBase + 'tesseractlib/tesseract.min.js';
      s.onload = function () {
        if (window.Tesseract) res(window.Tesseract);
        else rej(new Error('the OCR engine did not initialize'));
      };
      s.onerror = function () { tessPromise = null; rej(new Error('could not download the OCR engine')); };
      document.head.appendChild(s);
    });
    return tessPromise;
  }

  // tesseract.js v5 flattens blocks→words for us when `blocks` output is on, but be
  // defensive and walk the block tree if `words` is missing
  function flattenWords(data) {
    if (data && data.words && data.words.length) return data.words;
    var out = [];
    ((data && data.blocks) || []).forEach(function (b) {
      (b.paragraphs || []).forEach(function (p) {
        (p.lines || []).forEach(function (l) {
          (l.words || []).forEach(function (w) { out.push(w); });
        });
      });
    });
    return out;
  }

  function runOcr(idxs) {
    if (!idxs.length || PT.isBusy()) return;
    if (typeof WebAssembly !== 'object') { PT.setStatus('OCR needs WebAssembly, which this browser does not support.', 'err'); return; }
    PT.setBusy(true);
    ocrCurPage = -1; ocrTotal = idxs.length;
    PT.progress(0, idxs.length, 'Loading the OCR engine (about 6 MB on first use, then cached)…');
    var worker = null, totalWords = 0, okPages = 0, failedPages = 0, ocrFlat = 0, dpiCapped = 0, dpiFloor = 300;
    loadTesseract().then(function (T) {
      return T.createWorker('eng', 1, {
        workerPath: PT.jsBase + 'tesseractlib/worker.min.js',
        corePath: PT.jsBase + 'tesseractlib',
        langPath: PT.jsBase + 'tesseractlib/lang',
        gzip: true,
        logger: function (m) {
          if (m && m.status === 'recognizing text' && typeof m.progress === 'number' && ocrCurPage >= 0) {
            PT.progress(ocrCurPage + m.progress, ocrTotal,
              'Reading page ' + (ocrCurPage + 1) + ' of ' + ocrTotal + '… ' + Math.round(m.progress * 100) + '%');
          }
        }
      });
    }).then(function (w) {
      worker = w;
      PT.snapshot('OCR ' + idxs.length + ' page' + (idxs.length > 1 ? 's' : ''));
      var chain = Promise.resolve();
      idxs.forEach(function (pi, k) {
        chain = chain.then(function () {
          ocrCurPage = k;
          return PT.progress(k, idxs.length, 'Reading page ' + (k + 1) + ' of ' + idxs.length + '…');
        }).then(function () {
          var pg = PT.pages()[pi];
          return ensureUprightPage(pg).then(function (flattened) {
            /* count it — the flatten must be disclosed in the final status, same as
               the watermark and page-numbers flows */
            if (flattened) ocrFlat++;
            return PT.effPointSize(pg);
          }).then(function (sz) {
            // ~300 DPI, capped so huge pages stay inside browser canvas limits
            var scale = Math.min(300 / 72, 4000 / sz.w, 4000 / sz.h);
            var effDpi = scale * 72;
            if (effDpi < 300 - 0.5) { dpiCapped++; dpiFloor = Math.min(dpiFloor, effDpi); }
            return PT.renderPageCanvas(pg, Math.max(1, sz.w * scale));
          }).then(function (r) {
            var c = r.canvas;
            // black out redaction boxes BEFORE recognition, so the invisible text layer
            // can never contain what the user is redacting
            PT.paintRedacts(c.getContext('2d'), pg, c.width, c.height);
            return worker.recognize(c).then(function (res) {
              var out = [];
              flattenWords(res && res.data).forEach(function (w) {
                if (!w || !w.text || !w.bbox) return;
                if ((w.confidence || 0) < 35) return;
                var t = String(w.text).trim();
                if (!t) return;
                out.push({
                  text: t,
                  x0: w.bbox.x0 / c.width, y0: w.bbox.y0 / c.height,
                  x1: w.bbox.x1 / c.width, y1: w.bbox.y1 / c.height
                });
              });
              c.width = 0;   // free the canvas
              if (out.length) {
                pg.ocrWords = out; pg.ocr = true; PT.markDirty(pg);
                totalWords += out.length;
              }
              okPages++;
            });
          }).catch(function (e) {
            failedPages++;
            if (window.console) console.warn('pdftools: OCR failed on page ' + (pi + 1) + '.', e);
          });
        });
      });
      return chain;
    }).then(function () {
      ocrCurPage = -1;
      PT.renderGrid(); PT.updateToolbar();
      var msg;
      if (totalWords) {
        msg = 'Added a searchable text layer: ' + totalWords + ' words across ' + okPages + ' page' + (okPages === 1 ? '' : 's') + '. Download to save the result.';
      } else {
        msg = 'No text was recognized. OCR reads printed English and works best on clean scans; handwriting usually does not work.';
      }
      if (ocrFlat) msg += ' ' + ocrFlat + ' rotated page' + (ocrFlat > 1 ? 's were' : ' was') + ' flattened upright first (Ctrl+Z undoes it).';
      if (dpiCapped) msg += ' ' + dpiCapped + ' page' + (dpiCapped > 1 ? 's were' : ' was') + ' too large for 300 DPI and read at about ' + Math.round(dpiFloor) + ' DPI instead.';
      if (failedPages) msg += ' ' + failedPages + ' page' + (failedPages === 1 ? '' : 's') + ' could not be read.';
      PT.setStatus(msg, (!totalWords || dpiCapped || failedPages) ? 'warn' : undefined);
    }).catch(function (e) {
      PT.setStatus('OCR failed: ' + (e && e.message || e), 'err');
    }).then(function () {
      if (worker) { try { worker.terminate(); } catch (e) {} }
      PT.setBusy(false);
    });
  }

  if (ocrDialog) {
    var ocrScope = $('pt-ocr-scope');
    $('pt-ocr').addEventListener('click', function () {
      if (!PT.pages().length) return;
      fillScope(ocrScope);
      PT.openDialog(ocrDialog);
    });
    wireCancel(ocrDialog, 'pt-ocr-cancel');
    $('pt-ocr-go').addEventListener('click', function () {
      var idxs = scopeIdx(ocrScope);
      PT.closeDialog(ocrDialog);
      runOcr(idxs);
    });
  }

  // ==================================================================================
  // Password-protect (encrypt with qpdf-wasm, AES-256)
  // ==================================================================================
  var protDialog = $('pt-protect-dialog');
  var qpdfFactory = null, qpdfLoading = null;

  function loadQpdf() {
    if (qpdfFactory) return Promise.resolve(qpdfFactory);
    if (qpdfLoading) return qpdfLoading;
    qpdfLoading = new Promise(function (res, rej) {
      // the qpdf UMD tail publishes its factory on `exports.Module` when an `exports`
      // object exists (same trick the package's own browser wrapper uses)
      var hadExports = Object.prototype.hasOwnProperty.call(window, 'exports');
      var prev = window.exports;
      window.exports = {};
      function restore() {
        if (hadExports) window.exports = prev;
        else { try { delete window.exports; } catch (e) { window.exports = undefined; } }
      }
      var s = document.createElement('script');
      s.src = PT.jsBase + 'qpdflib/qpdf.js';
      s.onload = function () {
        var factory = (window.exports && window.exports.Module) || window.Module;
        restore();
        if (factory) { qpdfFactory = factory; res(factory); }
        else rej(new Error('the encryption engine did not initialize'));
      };
      s.onerror = function () { restore(); qpdfLoading = null; rej(new Error('could not download the encryption engine')); };
      document.head.appendChild(s);
    });
    return qpdfLoading;
  }

  function qpdfEncrypt(bytes, pw) {
    if (typeof WebAssembly !== 'object') return Promise.reject(new Error('this browser does not support WebAssembly'));
    return loadQpdf().then(function (factory) {
      // fresh instance per run: the qpdf CLI runtime is single-shot
      return factory({
        locateFile: function (f) { return PT.jsBase + 'qpdflib/' + f; },
        print: function () {},
        printErr: function () {}
      });
    }).then(function (mod) {
      mod.FS.writeFile('/in.pdf', bytes);
      var rc = 0;
      try { rc = mod.callMain(['/in.pdf', '--encrypt', pw, pw, '256', '--', '/out.pdf']); }
      catch (e) { rc = -1; }
      var out = null;
      try { out = mod.FS.readFile('/out.pdf'); } catch (e2) {}
      // qpdf exit 3 means "succeeded with warnings" — only fail when there is no output
      if (!out || !out.length) throw new Error('encryption failed' + (rc ? ' (qpdf exit ' + rc + ')' : ''));
      return out;
    });
  }

  if (protDialog) {
    var protPw = $('pt-protect-pw'), protPw2 = $('pt-protect-pw2'), protErr = $('pt-protect-err');
    var protShow = $('pt-protect-show');
    // a password you cannot recover later is one you want to read back before committing
    function applyProtMask() {
      var t = (protShow && protShow.checked) ? 'text' : 'password';
      protPw.type = t; protPw2.type = t;
    }
    if (protShow) protShow.addEventListener('change', applyProtMask);
    $('pt-protect').addEventListener('click', function () {
      if (!PT.pages().length) return;
      protPw.value = ''; protPw2.value = ''; protErr.textContent = '';
      if (protShow) protShow.checked = false;
      applyProtMask();
      if (PT.openDialog(protDialog)) setTimeout(function () { protPw.focus(); }, 0);
    });
    wireCancel(protDialog, 'pt-protect-cancel');
    function protSubmit() {
      var pw = protPw.value, pw2 = protPw2.value;
      if (!pw) { protErr.textContent = 'Enter a password.'; protPw.focus(); return; }
      if (pw !== pw2) { protErr.textContent = 'The passwords don’t match.'; protPw2.focus(); return; }
      protErr.textContent = '';
      PT.closeDialog(protDialog);
      protPw.value = ''; protPw2.value = '';
      if (!PT.pages().length || PT.isBusy()) return;
      PT.setBusy(true);
      var n = PT.pages().length;
      PT.progress(0, n + 1, 'Building PDF…');
      PT.buildPdf(PT.pages(), function (d, t) {
        return PT.progress(d, t + 1, 'Building page ' + d + ' of ' + t + '…');
      }).then(function (bytes) {
        return PT.progress(n, n + 1, 'Encrypting (AES-256)…').then(function () {
          return qpdfEncrypt(bytes, pw);
        });
      }).then(function (enc) {
        var name = PT.exportName('protected');
        PT.downloadBytes(enc, name);
        PT.setStatus('Saved ' + name + ' (' + PT.fmtSize(enc.length) + '). Opening it now requires the password. There is no way to recover it if you forget it.');
      }).catch(function (e) { PT.setStatus('Error: ' + (e && e.message || e), 'err'); })
        .then(function () { PT.setBusy(false); });
    }
    $('pt-protect-go').addEventListener('click', protSubmit);
    [protPw, protPw2].forEach(function (inp) {
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); protSubmit(); } });
    });
  }

  // ==================================================================================
  // Copy clean text — extract the document's text with running headers/footers/page
  // numbers heuristically stripped, hyphenated line wraps repaired, and paragraphs
  // reflowed, ready to paste elsewhere. All the geometry/text logic lives in PURE
  // (pdftools.js), unit-tested on plain objects; this just feeds it pdf.js positions
  // and pg.ocrWords and wires the dialog.
  // ==================================================================================
  var ctDialog = $('pt-ct-dialog');
  if (ctDialog) {
    var ctScopeEl = $('pt-ct-scope'), ctPreview = $('pt-ct-preview'), ctMarkers = $('pt-ct-markers'),
        ctNote = $('pt-ct-note'), ctProgress = $('pt-ct-progress'),
        ctCopy = $('pt-ct-copy'), ctDownload = $('pt-ct-download');
    var ctLastBlocks = null, ctLastLabels = null, ctLastText = '', ctLastName = 'document-clean.txt', ctBusy = false;

    // same precedence as "Download selected" (a valid typed range wins, else the
    // thumbnail selection) — but unlike that button, which disables itself when both
    // are empty, this one falls all the way back to the WHOLE document, since "nothing
    // selected" is the ordinary state right after loading a file and Copy-clean-text
    // should still do something useful.
    function ctScopeIdx() {
      var st = PT.rangeState();
      if (st.idx && st.idx.length) return st.idx;
      var sel = PT.selectedIdx();
      if (sel.length) return sel;
      return allIdx();
    }
    function ctScopeLabel(idxs) {
      var total = PT.pages().length;
      var st = PT.rangeState();
      if (st.idx && st.idx.length) return idxs.length + ' page' + (idxs.length === 1 ? '' : 's') + ' (the typed range)';
      if (PT.selectedIdx().length) return idxs.length + ' selected page' + (idxs.length === 1 ? '' : 's');
      return 'all ' + total + ' page' + (total === 1 ? '' : 's');
    }

    // OCR words ({text,x0,y0,x1,y1}) -> the same token shape pdf.js items produce, so
    // both feed the same grouping/paragraph pipeline
    function ocrWordsToTokens(words) {
      return (words || []).map(function (w) {
        return { text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, fontSize: Math.max(1e-4, w.y1 - w.y0) };
      });
    }

    // tokens for one page. A page we ourselves rasterized (pg.raster, e.g. a rotated
    // page flattened for a watermark/page-number/OCR, or one with committed redaction
    // boxes at DOWNLOAD time) no longer has a live text layer worth reading from the
    // ORIGINAL source page — that could resurrect content a redaction hid, or text in a
    // frame that no longer matches the raster's — so a raster page contributes only its
    // own pg.ocrWords (if "Make searchable" has been run on it), same as a real scan.
    // A live (non-raster) page reads pdf.js's text content AND merges in any pg.ocrWords
    // (OCR run on an already-upright page stays live), then filters BOTH by pg.redacts —
    // redaction is only a visual paint until download, so the live text layer still has
    // the original text underneath a committed box.
    function ctPageTokens(pg) {
      if (pg.blank) return Promise.resolve({ tokens: [], scan: false, blank: true });
      if (pg.raster) {
        var toks = PURE.filterRedactedTokens(ocrWordsToTokens(pg.ocrWords), pg.redacts);
        return Promise.resolve({ tokens: toks, scan: toks.length === 0, blank: false });
      }
      return Promise.all([PT.pdfjsPage(pg), PT.effPointSize(pg), PT.pageEffRotation(pg)]).then(function (r) {
        var page = r[0], sz = r[1], rot = r[2];
        return page.getTextContent().then(function (tc) {
          var vp = page.getViewport({ scale: 1, rotation: rot });
          var toks = [];
          (tc.items || []).forEach(function (it) {
            var tok = PURE.itemToToken(vp.transform, it, sz.w, sz.h);
            if (tok) toks.push(tok);
          });
          toks = toks.concat(ocrWordsToTokens(pg.ocrWords));
          toks = PURE.filterRedactedTokens(toks, pg.redacts);
          return { tokens: toks, scan: toks.length === 0, blank: false };
        });
      });
    }

    // chunked so the tab never freezes on a big document: PT.progress yields a frame
    // between pages, and the dialog's own progress line (visible — the shared
    // #pt-progress bar sits behind this modal's backdrop) mirrors the same ticks.
    function ctExtract(idxs) {
      var pagesTokens = new Array(idxs.length);
      var scanCount = 0, blankCount = 0;
      var chain = Promise.resolve();
      idxs.forEach(function (pi, k) {
        chain = chain.then(function () {
          if (ctProgress) ctProgress.textContent = 'Reading page ' + (k + 1) + ' of ' + idxs.length + '…';
          return PT.progress(k, idxs.length);
        }).then(function () {
          return ctPageTokens(PT.pages()[pi]).then(function (r) {
            pagesTokens[k] = r.tokens;
            if (r.blank) blankCount++; else if (r.scan) scanCount++;
          });
        });
      });
      return chain.then(function () { return PT.progress(idxs.length, idxs.length); }).then(function () {
        var labels = idxs.map(function (i) { return i + 1; });
        var res = PURE.tokensToCleanText(pagesTokens, { pageMarkers: false, pageLabels: labels });
        return { blocks: res.blocks, labels: labels, scanCount: scanCount, blankCount: blankCount };
      });
    }

    function ctScanNote(scanCount, blankCount) {
      var bits = [];
      if (scanCount) {
        bits.push(scanCount + ' page' + (scanCount === 1 ? '' : 's') + ' look' + (scanCount === 1 ? 's' : '') +
          ' like ' + (scanCount === 1 ? 'a scan' : 'scans') + ' with no text layer. Run Make searchable first to include ' +
          (scanCount === 1 ? 'it' : 'them') + '.');
      }
      if (blankCount) bits.push(blankCount + ' blank page' + (blankCount === 1 ? '' : 's') + ' contributed nothing.');
      return bits.join(' ');
    }

    function ctRenderText() {
      if (!ctLastBlocks) return '';
      return PURE.blocksToText(ctLastBlocks, { pageMarkers: !!(ctMarkers && ctMarkers.checked), pageLabels: ctLastLabels });
    }

    function ctSetBusy(b) {
      ctBusy = b;
      if (ctCopy) ctCopy.disabled = b || !ctLastText;
      if (ctDownload) ctDownload.disabled = b || !ctLastText;
      if (ctMarkers) ctMarkers.disabled = b;
    }

    function ctRun() {
      var idxs = ctScopeIdx();
      if (ctScopeEl) ctScopeEl.textContent = ctScopeLabel(idxs);
      ctLastBlocks = null; ctLastLabels = null; ctLastText = '';
      if (ctNote) { ctNote.hidden = true; ctNote.textContent = ''; }
      if (!idxs.length) {
        ctPreview.value = '';
        ctSetBusy(false);
        return;
      }
      ctSetBusy(true);
      ctPreview.value = '';
      if (ctProgress) ctProgress.textContent = 'Reading…';
      ctExtract(idxs).then(function (r) {
        ctLastBlocks = r.blocks; ctLastLabels = r.labels;
        ctLastText = ctRenderText();
        ctPreview.value = ctLastText || '(No extractable text was found.)';
        var docs = PT.docs();
        var live = PT.liveDocIndices(idxs.map(function (i) { return PT.pages()[i]; }));
        ctLastName = PURE.sanitizeBaseName(live.length ? docs[live[0]].name : '') + '-clean.txt';
        var note = ctScanNote(r.scanCount, r.blankCount);
        if (ctNote) { ctNote.textContent = note; ctNote.hidden = !note; }
      }).catch(function (e) {
        ctPreview.value = '';
        if (ctNote) { ctNote.textContent = 'Could not extract text: ' + (e && e.message || e); ctNote.hidden = false; }
      }).then(function () {
        if (ctProgress) ctProgress.textContent = '';
        ctSetBusy(false);
      });
    }

    $('pt-copytext').addEventListener('click', function () {
      if (!PT.pages().length) return;
      if (PT.openDialog(ctDialog)) ctRun();
    });
    wireCancel(ctDialog, 'pt-ct-close');
    if (ctMarkers) ctMarkers.addEventListener('change', function () {
      if (ctBusy || !ctLastBlocks) return;
      ctLastText = ctRenderText();
      ctPreview.value = ctLastText || '(No extractable text was found.)';
    });

    function ctFlash(btn, label) {
      var was = btn.textContent;
      btn.textContent = label;
      setTimeout(function () { btn.textContent = was; btn.disabled = ctBusy || !ctLastText; }, 1200);
    }
    function ctFallbackCopy() {
      try {
        ctPreview.focus(); ctPreview.select();
        var ok = document.execCommand('copy');
        var sel = window.getSelection(); if (sel) sel.removeAllRanges();
        return ok;
      } catch (e) { return false; }
    }
    if (ctCopy) ctCopy.addEventListener('click', function () {
      if (!ctLastText) return;
      /* clipboard API needs a secure context (https or localhost); fall back to the
         old select+execCommand trick everywhere else */
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(ctLastText).then(function () { ctFlash(ctCopy, 'Copied'); }, function () {
          if (ctFallbackCopy()) ctFlash(ctCopy, 'Copied');
          else PT.setStatus('Could not copy automatically. Select the text in the box and copy it manually.', 'warn');
        });
      } else if (ctFallbackCopy()) ctFlash(ctCopy, 'Copied');
      else PT.setStatus('Could not copy automatically. Select the text in the box and copy it manually.', 'warn');
    });
    if (ctDownload) ctDownload.addEventListener('click', function () {
      if (!ctLastText) return;
      PT.downloadBytes(new TextEncoder().encode(ctLastText), ctLastName, 'text/plain');
    });
  }
})();
