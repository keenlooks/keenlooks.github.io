/* PDF Toolbench (/pdftools/) — fully client-side. Nothing is uploaded; this file makes
   no network requests with your PDF. Rendering uses pdf.js (Apache-2.0, Mozilla); editing
   uses pdf-lib (MIT). Both are vendored locally under assets/js/pdflib/.

   External file (never HTML-compressed) so // comments are fine here. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  if (!window.PDFLib || !window.pdfjsLib) {
    var s = $('pt-status'); if (s) s.textContent = 'Could not load the PDF engine.';
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

  // ---- state ----
  var docs = [];     // { name, bytes:Uint8Array (for pdf-lib), js:pdfjsDoc (for rendering) }
  var pages = [];     // { docIndex, pageIndex, rot, sel, raster:null|{png:Uint8Array,wPt,hPt}, redacted }
  var lastFlattened = 0;   // how many pages the last build had to rasterize (encrypted/damaged sources)
  var engineNote = $('pt-engine');

  // ---- elements ----
  var drop = $('pt-drop'), grid = $('pt-grid'), fileInput = $('pt-file'), toolbar = $('pt-toolbar');
  var statusEl = $('pt-status'), countEl = $('pt-count');
  var btnAdd = $('pt-add'), btnSelAll = $('pt-selall'), btnRotate = $('pt-rotate'), btnDelete = $('pt-delete'),
      btnRedact = $('pt-redact'), btnSign = $('pt-sign'), btnForm = $('pt-form'), btnShrink = $('pt-shrink'),
      btnExtract = $('pt-extract'), btnSplit = $('pt-split'), btnDownload = $('pt-download'),
      chkStrip = $('pt-stripmeta');

  function setStatus(msg) { if (statusEl) statusEl.textContent = msg || ''; }

  // ---------- loading source PDFs / images ----------
  var IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
  function isImage(f) { return /^image\//.test(f.type) || IMG_RE.test(f.name); }
  function isPdf(f) { return f.type === 'application/pdf' || /\.pdf$/i.test(f.name); }

  function addFiles(fileList) {
    var arr = Array.prototype.slice.call(fileList).filter(function (f) { return isPdf(f) || isImage(f); });
    var rejectedTypes = Array.prototype.slice.call(fileList).length - arr.length;
    if (!arr.length) { if (rejectedTypes) setStatus('Those files aren’t PDFs or images.'); return; }
    setStatus('Reading ' + arr.length + ' file' + (arr.length > 1 ? 's' : '') + '…');
    var failed = [], skipped = [];
    var chain = Promise.resolve();
    arr.forEach(function (f) {
      chain = chain.then(function () {
        var nm = f.name;
        var bytesP = isImage(f) ? imageToPdfBytes(f) : f.arrayBuffer().then(function (b) { return new Uint8Array(b); });
        // one bad file must not abort the rest — isolate each with its own catch
        return bytesP.then(function (bytes) { return addPdfBytes(bytes, nm); })
          .catch(function (e) {
            if (e && e.__ptSkip) skipped.push(nm); else failed.push(nm);
            if (window.console) console.warn('pdftools: could not add ' + nm, e);
          });
      });
    });
    chain.then(function () {
      renderGrid(); updateToolbar();
      var msg = [];
      if (failed.length) msg.push('Couldn’t read: ' + failed.join(', ') + ' (the file may be corrupted or an unsupported format).');
      if (skipped.length) msg.push('Skipped (password not provided): ' + skipped.join(', ') + '.');
      setStatus(msg.join(' '));
    });
  }

  function addPdfBytes(bytes, name) {
    // pdf.js detaches the buffer it's given, so hand it a COPY and keep `bytes` for pdf-lib.
    // Retry with a prompted password if the PDF is password-protected.
    function attempt(password) {
      return pdfjsLib.getDocument({ data: bytes.slice(0), password: password }).promise.then(function (jsDoc) {
        var docIndex = docs.length;
        docs.push({ name: name, bytes: bytes, js: jsDoc, formValues: null });
        for (var i = 0; i < jsDoc.numPages; i++) {
          pages.push({ docIndex: docIndex, pageIndex: i, rot: 0, sel: false, raster: null, redacted: false, sigs: [], texts: [] });
        }
      }).catch(function (e) {
        var needsPw = e && (e.name === 'PasswordException' || /password/i.test(e.message || ''));
        if (needsPw) {
          var again = password != null;   // wrong password the second time around
          var pw = window.prompt((again ? 'Incorrect password. ' : '') + '“' + name + '” is password-protected. Enter its password (or Cancel to skip):');
          if (pw == null) { var skip = new Error('password required'); skip.__ptSkip = true; throw skip; }
          return attempt(pw);
        }
        throw e;
      });
    }
    return attempt(undefined);
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
      im.onerror = rej; im.src = url;
    });
  }

  // ---------- thumbnails ----------
  function totalRotation(jsPage, extra) { return ((jsPage.rotate || 0) + (extra || 0)) % 360; }

  function renderThumbInto(canvas, pg) {
    if (pg.raster) {
      // image-only (redacted/baked) page — draw the stored PNG
      var img = new Image();
      img.onload = function () {
        var w = 150, h = Math.round(w * img.height / img.width);
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        drawThumbOverlays(canvas.getContext('2d'), pg, w, h, pg.raster.wPt, pg.raster.hPt);
      };
      img.src = pngObjectURL(pg.raster.png);
      return;
    }
    docs[pg.docIndex].js.getPage(pg.pageIndex + 1).then(function (page) {
      var rot = totalRotation(page, pg.rot);
      var base = page.getViewport({ scale: 1, rotation: rot });
      var scale = 150 / base.width;
      var vp = page.getViewport({ scale: scale, rotation: rot });
      canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
      page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise.then(function () {
        drawThumbOverlays(canvas.getContext('2d'), pg, canvas.width, canvas.height, base.width, base.height);
      });
    });
  }
  // draw the signature/text annotations onto a thumbnail or preview canvas
  function drawThumbOverlays(ctx, pg, tw, th, Wpt, Hpt) {
    (pg.texts || []).forEach(function (t) {
      var px = Math.max(3, t.size * tw / Wpt);
      ctx.fillStyle = t.color || '#111'; ctx.font = px + 'px ' + (t.font || 'Helvetica'); ctx.textBaseline = 'top';
      (t.text || '').split('\n').forEach(function (line, i) { ctx.fillText(line, t.x * tw, t.y * th + i * px * 1.2); });
    });
    (pg.sigs || []).forEach(function (s) {
      var im = new Image(); im.onload = function () { ctx.drawImage(im, s.x * tw, s.y * th, s.w * tw, s.h * th); }; im.src = pngObjectURL(s.png);
    });
  }

  var _urls = [];
  function pngObjectURL(bytes) {
    var url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    _urls.push(url); return url;
  }

  function renderGrid() {
    _urls.forEach(URL.revokeObjectURL); _urls = [];
    grid.innerHTML = '';
    drop.classList.toggle('pt-drop--has', pages.length > 0);
    pages.forEach(function (pg, idx) {
      var t = document.createElement('div');
      t.className = 'pt-thumb' + (pg.sel ? ' pt-sel' : '');
      t.setAttribute('draggable', 'true');
      t.dataset.idx = idx;

      var c = document.createElement('canvas');
      c.className = 'pt-thumb__canvas';
      t.appendChild(c);
      renderThumbInto(c, pg);

      var bar = document.createElement('div');
      bar.className = 'pt-thumb__bar';
      bar.innerHTML = '<span class="pt-thumb__num">' + (idx + 1) +
        (pg.redacted ? ' <span class="pt-thumb__redacted" title="Redacted &amp; flattened">▮</span>' : '') +
        (pg.sigs && pg.sigs.length ? ' <span class="pt-thumb__signed" title="Signed">✎</span>' : '') + '</span>';
      var acts = document.createElement('div');
      acts.className = 'pt-thumb__acts';
      var eb = document.createElement('button'); eb.className = 'pt-thumb__act'; eb.type = 'button'; eb.title = 'Edit page (text, signature, redact, form)'; eb.textContent = '✎';
      eb.addEventListener('click', function (e) { e.stopPropagation(); if (window.__PT.openEditor) window.__PT.openEditor(idx); });
      var rb = document.createElement('button'); rb.className = 'pt-thumb__act'; rb.type = 'button'; rb.title = 'Rotate 90°'; rb.textContent = '⟳';
      rb.addEventListener('click', function (e) { e.stopPropagation(); pg.rot = (pg.rot + 90) % 360; renderGrid(); });
      var db = document.createElement('button'); db.className = 'pt-thumb__act'; db.type = 'button'; db.title = 'Delete page'; db.textContent = '×';
      db.addEventListener('click', function (e) { e.stopPropagation(); pages.splice(idx, 1); renderGrid(); updateToolbar(); });
      acts.appendChild(eb); acts.appendChild(rb); acts.appendChild(db);
      bar.appendChild(acts);
      t.appendChild(bar);

      // single click selects; double-click opens the editor
      t.addEventListener('click', function () { pg.sel = !pg.sel; renderGrid(); updateToolbar(); });
      t.addEventListener('dblclick', function (e) { e.preventDefault(); if (window.__PT.openEditor) window.__PT.openEditor(idx); });

      // drag to reorder
      t.addEventListener('dragstart', function (e) { dragIdx = idx; t.classList.add('pt-thumb--drag'); e.dataTransfer.effectAllowed = 'move'; });
      t.addEventListener('dragend', function () { dragIdx = -1; renderGrid(); });
      t.addEventListener('dragover', function (e) { e.preventDefault(); t.classList.add('pt-thumb--over'); });
      t.addEventListener('dragleave', function () { t.classList.remove('pt-thumb--over'); });
      t.addEventListener('drop', function (e) {
        e.preventDefault(); t.classList.remove('pt-thumb--over');
        if (dragIdx < 0 || dragIdx === idx) return;
        var moved = pages.splice(dragIdx, 1)[0];
        pages.splice(idx, 0, moved);
        dragIdx = -1; renderGrid(); updateToolbar();
      });

      grid.appendChild(t);
    });
  }
  var dragIdx = -1;

  function selectedIdx() {
    var out = []; pages.forEach(function (p, i) { if (p.sel) out.push(i); }); return out;
  }

  function updateToolbar() {
    var has = pages.length > 0, sel = selectedIdx().length;
    if (toolbar) toolbar.hidden = !has && docs.length === 0;
    if (has) toolbar.hidden = false;
    if (countEl) countEl.textContent = has ? (pages.length + ' page' + (pages.length > 1 ? 's' : '') + (sel ? ', ' + sel + ' selected' : '')) : '';
    btnRotate.disabled = sel === 0;
    btnDelete.disabled = sel === 0;
    if (btnRedact) btnRedact.disabled = sel !== 1;
    if (btnSign) btnSign.disabled = sel !== 1;
    if (btnForm) btnForm.disabled = docs.length === 0;
    if (btnShrink) btnShrink.disabled = !has;
    btnExtract.disabled = sel === 0;
    btnSplit.disabled = !has;
    btnDownload.disabled = !has;
    btnSelAll.textContent = (sel === pages.length && pages.length > 0) ? 'Select none' : 'Select all';
  }

  // ---------- toolbar actions ----------
  btnAdd.addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () { addFiles(fileInput.files); fileInput.value = ''; });

  drop.addEventListener('click', function (e) { if (pages.length === 0 && e.target === drop || e.target.classList.contains('pt-drop__hint') || (e.target.parentNode && e.target.parentNode.classList && e.target.parentNode.classList.contains('pt-drop__hint'))) fileInput.click(); });
  ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); if (e.dataTransfer && Array.prototype.some.call(e.dataTransfer.types || [], function (t) { return t === 'Files'; })) drop.classList.add('pt-drop--over'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { if (ev === 'dragleave' && e.target !== drop) return; drop.classList.remove('pt-drop--over'); }); });
  drop.addEventListener('drop', function (e) { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });

  btnSelAll.addEventListener('click', function () {
    var all = selectedIdx().length === pages.length && pages.length > 0;
    pages.forEach(function (p) { p.sel = !all; });
    renderGrid(); updateToolbar();
  });
  btnRotate.addEventListener('click', function () { selectedIdx().forEach(function (i) { pages[i].rot = (pages[i].rot + 90) % 360; }); renderGrid(); });
  btnDelete.addEventListener('click', function () {
    pages = pages.filter(function (p) { return !p.sel; });
    renderGrid(); updateToolbar();
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
              else if ((ty === 'select' || ty === 'radio') && val) f.select(String(val));
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
  // draw a page's signature images + text annotations on the just-added output page.
  // Rotation-0 math — signed/redacted pages are always made effective-rotation-0 first.
  function drawOverlays(out, info, pg, fontCache) {
    var chain = Promise.resolve();
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

  function buildPdf(pageList) {
    var cache = {}, fontCache = {}, failures = 0;
    lastFlattened = 0;
    return PDFLib.PDFDocument.create().then(function (out) {
      var chain = Promise.resolve();
      pageList.forEach(function (pg) {
        chain = chain.then(function () {
          var added;
          if (pg.raster) {
            added = out.embedPng(pg.raster.png).then(function (img) {
              var p = out.addPage([pg.raster.wPt, pg.raster.hPt]);
              p.drawImage(img, { x: 0, y: 0, width: pg.raster.wPt, height: pg.raster.hPt });
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
          return added.then(function (info) { return drawOverlays(out, info, pg, fontCache); })
            .catch(function (e) { failures++; if (window.console) console.warn('pdftools: a page failed and was skipped.', e); });
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

  function downloadBytes(bytes, name) {
    var url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    var a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /* one build at a time — buildPdf mutates shared state (cache, lastFlattened), so
     concurrent clicks would clobber each other's status/counts and fire duplicate downloads */
  var building = false;

  btnDownload.addEventListener('click', function () {
    if (!pages.length || building) return;
    building = true;
    setStatus('Building PDF…'); btnDownload.disabled = true;
    buildPdf(pages).then(function (bytes) {
      downloadBytes(bytes, 'document.pdf');
      setStatus('Saved document.pdf (' + fmtSize(bytes.length) + ').' + flattenNote());
    }).catch(function (e) { setStatus('Error: ' + (e && e.message || e)); })
      .then(function () { building = false; updateToolbar(); });
  });

  btnExtract.addEventListener('click', function () {
    var sel = selectedIdx(); if (!sel.length || building) return;
    building = true;
    var list = sel.map(function (i) { return pages[i]; });
    setStatus('Extracting ' + list.length + ' page' + (list.length > 1 ? 's' : '') + '…');
    buildPdf(list).then(function (bytes) {
      downloadBytes(bytes, 'extract.pdf');
      setStatus('Saved extract.pdf (' + fmtSize(bytes.length) + ').' + flattenNote());
    }).catch(function (e) { setStatus('Error: ' + (e && e.message || e)); })
      .then(function () { building = false; });
  });

  btnSplit.addEventListener('click', function () {
    if (!pages.length || building) return;
    building = true;
    setStatus('Splitting into ' + pages.length + ' files…');
    var files = []; var chain = Promise.resolve();
    pages.forEach(function (pg, i) {
      chain = chain.then(function () {
        return buildPdf([pg]).then(function (bytes) {
          files.push({ name: 'page-' + String(i + 1).padStart(3, '0') + '.pdf', data: bytes });
        });
      });
    });
    chain.then(function () {
      var zip = storeZip(files);
      var url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
      var a = document.createElement('a'); a.href = url; a.download = 'pages.zip';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      setStatus('Saved pages.zip (' + pages.length + ' files, ' + fmtSize(zip.length) + ').');
    }).catch(function (e) { setStatus('Error: ' + (e && e.message || e)); })
      .then(function () { building = false; });
  });

  function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(2) + ' MB'; }
  function flattenNote() { return lastFlattened ? ' ' + lastFlattened + ' page(s) from an encrypted or damaged PDF were flattened to images.' : ''; }

  // ---------- shared page-render helpers (used by sign / compress / redact-bake) ----------
  function canvasToBytes(canvas, type, quality) {
    return new Promise(function (res, rej) {
      canvas.toBlob(function (b) {
        if (!b) { rej(new Error('page too large to rasterize at this DPI')); return; }  /* toBlob yields null past the browser canvas limit */
        b.arrayBuffer().then(function (ab) { res(new Uint8Array(ab)); }, rej);
      }, type, quality);
    });
  }
  function effPointSize(pg) {
    if (pg.raster) return Promise.resolve({ w: pg.raster.wPt, h: pg.raster.hPt });
    return docs[pg.docIndex].js.getPage(pg.pageIndex + 1).then(function (page) {
      var v1 = page.getViewport({ scale: 1, rotation: totalRotation(page, pg.rot) });
      return { w: v1.width, h: v1.height };
    });
  }
  function pageEffRotation(pg) {
    if (pg.raster) return Promise.resolve(0);
    return docs[pg.docIndex].js.getPage(pg.pageIndex + 1).then(function (page) { return totalRotation(page, pg.rot); });
  }
  // render `pg` (raster or vector, at its effective rotation) to a canvas `targetPxWidth` wide
  function renderPageCanvas(pg, targetPxWidth) {
    if (pg.raster) {
      return new Promise(function (res, rej) {
        var url = URL.createObjectURL(new Blob([pg.raster.png], { type: 'image/png' }));
        var im = new Image();
        im.onload = function () {
          URL.revokeObjectURL(url);
          var s = targetPxWidth / im.width;
          var c = document.createElement('canvas'); c.width = Math.round(im.width * s); c.height = Math.round(im.height * s);
          c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
          res({ canvas: c, wPt: pg.raster.wPt, hPt: pg.raster.hPt });
        };
        im.onerror = rej; im.src = url;
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
  // flatten a page to an image in place (used to make a rotated page upright before signing)
  function bakePageToRaster(pg, dpi) {
    return effPointSize(pg).then(function (sz) {
      return renderPageCanvas(pg, Math.max(1, sz.w * dpi / 72)).then(function (r) {
        return canvasToBytes(r.canvas, 'image/png').then(function (png) {
          pg.raster = { png: png, wPt: sz.w, hPt: sz.h }; pg.rot = 0; return pg;
        });
      });
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
  function compress(dpi, quality) {
    return PDFLib.PDFDocument.create().then(function (out) {
      var chain = Promise.resolve();
      pages.forEach(function (pg) {
        chain = chain.then(function () {
          return effPointSize(pg).then(function (sz) {
            return renderPageCanvas(pg, Math.max(1, sz.w * dpi / 72)).then(function (r) {
              var c = document.createElement('canvas'); c.width = r.canvas.width; c.height = r.canvas.height;
              var cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height); cx.drawImage(r.canvas, 0, 0);
              return canvasToBytes(c, 'image/jpeg', quality).then(function (jpg) {
                return out.embedJpg(jpg).then(function (img) {
                  out.addPage([sz.w, sz.h]).drawImage(img, { x: 0, y: 0, width: sz.w, height: sz.h });
                });
              });
            });
          });
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

  // ---------- redaction (in pt-redact.js helpers, attached to window) ----------
  // Exposed so the redaction module can drive the model:
  window.__PT = {
    pages: function () { return pages; },
    docs: function () { return docs; },
    selectedIdx: selectedIdx,
    totalRotation: totalRotation,
    renderGrid: renderGrid,
    updateToolbar: updateToolbar,
    setStatus: setStatus,
    buildPdf: buildPdf,            // exposed for self-tests
    renderPageCanvas: renderPageCanvas,
    bakePageToRaster: bakePageToRaster,
    pageEffRotation: pageEffRotation,
    effPointSize: effPointSize,
    canvasToBytes: canvasToBytes,
    getFormFields: getFormFields,
    pdfjsPage: function (pg) { return docs[pg.docIndex].js.getPage(pg.pageIndex + 1); }
  };

  // ---------- compress dialog ----------
  var shrinkDialog = $('pt-shrink-dialog'), shrinkSel = $('pt-shrink-dpi');
  if (btnShrink) btnShrink.addEventListener('click', function () { if (pages.length && shrinkDialog) shrinkDialog.hidden = false; });
  var shrinkCancel = $('pt-shrink-cancel'); if (shrinkCancel) shrinkCancel.addEventListener('click', function () { shrinkDialog.hidden = true; });
  var shrinkGo = $('pt-shrink-go');
  if (shrinkGo) shrinkGo.addEventListener('click', function () {
    if (!pages.length || building) { shrinkDialog.hidden = true; return; }
    building = true;
    var parts = (shrinkSel.value || '150,0.7').split(','), dpi = parseInt(parts[0], 10) || 150, q = parseFloat(parts[1]) || 0.7;
    shrinkDialog.hidden = true; setStatus('Shrinking ' + pages.length + ' page' + (pages.length > 1 ? 's' : '') + '…');
    var before = inputSize();
    compress(dpi, q).then(function (bytes) {
      downloadBytes(bytes, 'compressed.pdf');
      var pct = before ? Math.round((1 - bytes.length / before) * 100) : 0;
      setStatus('Saved compressed.pdf — ' + fmtSize(bytes.length) + (before ? ' (input was ' + fmtSize(before) + ', ' + (pct >= 0 ? pct + '% smaller' : Math.abs(pct) + '% larger') + ')' : '') + '.');
    }).catch(function (e) { setStatus('Error: ' + (e && e.message || e)); })
      .then(function () { building = false; });
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
  if (engineNote) engineNote.hidden = true;   // libs already loaded (defer order guarantees it)
})();
