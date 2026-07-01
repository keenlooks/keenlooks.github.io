/* Unified full-screen page editor for the PDF Toolbench. One page preview with tools:
   Move, Text (click to place, font/size/color), Sign (draw/upload + place), Redact (draw
   boxes → rasterize). Inline form-field inputs are shown when the page has AcroForm widgets.
   All edits live on the page model (pg.texts / pg.sigs / pg.raster) and on
   docs[i].formValues, so thumbnails and export pick them up. Depends on window.__PT.
   External file → // comments fine. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var PT = window.__PT; if (!PT) return;
  var ed = $('pt-ed'); if (!ed) return;

  var scrollEl = $('pt-ed-scroll'), stage = $('pt-ed-stage'), canvas = $('pt-ed-canvas'), layer = $('pt-ed-layer');
  var hint = $('pt-ed-hint'), pageLabel = $('pt-ed-page');
  var fontSel = $('pt-text-font'), sizeSel = $('pt-text-size'), colorInp = $('pt-text-color');

  // size dropdown options
  [8, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 60, 72].forEach(function (s) {
    var o = document.createElement('option'); o.value = s; o.textContent = s + ' pt'; if (s === 14) o.selected = true; sizeSel.appendChild(o);
  });

  var idx = -1, pg = null, tool = 'move';
  var dispW = 0, dispH = 0, Wpt = 0, Hpt = 0, scale = 1;
  var selected = null;                 // selected annotation element
  var pendingRedact = [];              // [{x,y,w,h}] normalized, not yet baked

  function fontFamily(f) { return f === 'Times' ? 'Georgia, "Times New Roman", serif' : f === 'Courier' ? '"Courier New", monospace' : 'Arial, Helvetica, sans-serif'; }

  // ---------- open / render ----------
  function open(i) {
    var pages = PT.pages(); if (i < 0 || i >= pages.length) return;
    idx = i; pg = pages[i]; selected = null; pendingRedact = []; setTool('move');
    ed.hidden = false;
    renderPage();
  }
  function close() { ed.hidden = true; pg = null; idx = -1; PT.renderGrid(); PT.updateToolbar(); }

  // annotations (text/sig) are drawn with rotation-0 math at export, so a page with any
  // effective rotation must be flattened upright first (same as redact/sign already do).
  function ensureUpright() {
    return PT.pageEffRotation(pg).then(function (r) {
      if (r === 0) return false;
      return PT.bakePageToRaster(pg, 150).then(function () { return renderPage(); }).then(function () { return true; });
    });
  }

  function renderPage() {
    layer.innerHTML = '';
    var avW = (scrollEl.clientWidth || 800) - 32, avH = (scrollEl.clientHeight || 600) - 32;
    return PT.effPointSize(pg).then(function (sz) {
      Wpt = sz.w; Hpt = sz.h; var aspect = Hpt / Wpt;
      var w = (avW * aspect <= avH) ? avW : avH / aspect;
      w = Math.max(220, Math.min(w, 1500));
      return PT.renderPageCanvas(pg, w);
    }).then(function (res) {
      var cx = canvas.getContext('2d');
      canvas.width = res.canvas.width; canvas.height = res.canvas.height;
      cx.drawImage(res.canvas, 0, 0);
      dispW = canvas.width; dispH = canvas.height; scale = dispW / Wpt;
      stage.style.width = dispW + 'px'; stage.style.height = dispH + 'px';
      layer.style.width = dispW + 'px'; layer.style.height = dispH + 'px';
      pageLabel.textContent = 'Page ' + (idx + 1) + ' of ' + PT.pages().length;
      buildAnnoEls();
      addFormWidgets();
      updateNav();
    });
  }

  function updateNav() {
    var n = PT.pages().length, atStart = idx <= 0, atEnd = idx >= n - 1;
    $('pt-ed-prev').disabled = atStart; $('pt-ed-next').disabled = atEnd;
    $('pt-ed-arrow-left').disabled = atStart; $('pt-ed-arrow-right').disabled = atEnd;
  }
  function goPrev() { if (idx > 0) open(idx - 1); }
  function goNext() { if (idx < PT.pages().length - 1) open(idx + 1); }
  $('pt-ed-prev').addEventListener('click', goPrev);
  $('pt-ed-next').addEventListener('click', goNext);
  $('pt-ed-arrow-left').addEventListener('click', goPrev);
  $('pt-ed-arrow-right').addEventListener('click', goNext);
  $('pt-ed-done').addEventListener('click', function () {
    // drop empty text boxes
    pg.texts = (pg.texts || []).filter(function (t) { return (t.text || '').trim().length; });
    close();
  });

  // ---------- tools ----------
  function setTool(t) {
    tool = t; selected = null; deselectAll();
    ['move', 'text', 'sign', 'redact'].forEach(function (k) { $('pt-tool-' + k).classList.toggle('pt-tool--on', k === t); });
    $('pt-text-opts').hidden = t !== 'text';
    $('pt-redact-opts').hidden = t !== 'redact';
    $('pt-ed-signbar').hidden = t !== 'sign';
    stage.classList.toggle('pt-stage--text', t === 'text');
    stage.classList.toggle('pt-stage--redact', t === 'redact');
    // text content editable only in the text tool
    Array.prototype.forEach.call(layer.querySelectorAll('.pt-anno__txt'), function (el) { el.contentEditable = (t === 'text'); });
    hint.textContent = t === 'text' ? 'Click anywhere on the page to add text. Pick font, size, and color above.'
      : t === 'sign' ? 'Draw or upload a signature, click “Place on page”, then drag it where you want.'
      : t === 'redact' ? 'Drag boxes over anything to remove, then “Apply redaction”. The page is flattened to an image so the text underneath is gone.'
      : 'Click a text box or signature to move it. Double-click a page thumbnail to edit a different page.';
  }
  ['move', 'text', 'sign', 'redact'].forEach(function (k) { $('pt-tool-' + k).addEventListener('click', function () { setTool(k); }); });

  // ---------- annotation elements ----------
  function deselectAll() { Array.prototype.forEach.call(layer.querySelectorAll('.pt-sel'), function (e) { e.classList.remove('pt-sel'); }); removeHandles(); }
  function removeHandles() { Array.prototype.forEach.call(layer.querySelectorAll('.pt-anno__del,.pt-anno__resize'), function (e) { e.remove(); }); }
  function select(el) {
    deselectAll(); selected = el; if (!el) return; el.classList.add('pt-sel');
    var del = document.createElement('button'); del.className = 'pt-anno__del'; del.type = 'button'; del.textContent = '×';
    del.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    del.addEventListener('click', function (e) { e.stopPropagation(); removeAnno(el); });
    el.appendChild(del);
    if (el.classList.contains('pt-anno--sig')) {
      var rz = document.createElement('span'); rz.className = 'pt-anno__resize';
      rz.addEventListener('pointerdown', function (e) { startResize(e, el); });
      el.appendChild(rz);
    }
  }
  function removeAnno(el) {
    var m = el.__model;
    if (m) { var arr = el.classList.contains('pt-anno--sig') ? pg.sigs : pg.texts; var k = arr.indexOf(m); if (k >= 0) arr.splice(k, 1); }
    el.remove(); selected = null;
  }

  function buildAnnoEls() {
    (pg.texts || []).forEach(function (t) { layer.appendChild(makeTextEl(t)); });
    (pg.sigs || []).forEach(function (s) { layer.appendChild(makeSigEl(s)); });
  }

  function makeTextEl(t) {
    var el = document.createElement('div'); el.className = 'pt-anno pt-anno--text'; el.__model = t;
    el.style.left = (t.x * dispW) + 'px'; el.style.top = (t.y * dispH) + 'px';
    // the editable content is a separate inner node so handles (×) never become part of the text
    var txt = document.createElement('div'); txt.className = 'pt-anno__txt'; el.__txt = txt;
    txt.style.fontSize = (t.size * scale) + 'px'; txt.style.fontFamily = fontFamily(t.font); txt.style.color = t.color || '#111';
    txt.contentEditable = (tool === 'text'); txt.textContent = t.text || '';
    txt.addEventListener('input', function () { t.text = txt.innerText; });
    txt.addEventListener('blur', function () { if (!(t.text || '').trim()) removeAnno(el); });
    el.appendChild(txt);
    el.addEventListener('pointerdown', function (e) {
      if (e.target.classList.contains('pt-anno__del') || e.target.classList.contains('pt-anno__resize')) return;
      if (tool === 'move') { e.preventDefault(); select(el); startDrag(e, el, t); }
      else if (tool === 'text') { select(el); setTimeout(function () { txt.focus(); }, 0); }
    });
    return el;
  }
  function makeSigEl(s) {
    var el = document.createElement('div'); el.className = 'pt-anno pt-anno--sig'; el.__model = s;
    el.style.left = (s.x * dispW) + 'px'; el.style.top = (s.y * dispH) + 'px';
    el.style.width = (s.w * dispW) + 'px'; el.style.height = (s.h * dispH) + 'px';
    var img = document.createElement('img'); img.src = URL.createObjectURL(new Blob([s.png], { type: 'image/png' })); el.appendChild(img);
    el.addEventListener('pointerdown', function (e) { if (tool === 'move' || tool === 'sign') { e.preventDefault(); select(el); startDrag(e, el, s); } });
    return el;
  }

  // ---------- drag / resize ----------
  function startDrag(e, el, model) {
    var r = layer.getBoundingClientRect();
    var ox = e.clientX - r.left - model.x * dispW, oy = e.clientY - r.top - model.y * dispH;
    function mv(ev) {
      var nx = (ev.clientX - r.left - ox) / dispW, ny = (ev.clientY - r.top - oy) / dispH;
      model.x = Math.min(Math.max(0, nx), 1 - (el.offsetWidth / dispW) * 0.3);
      model.y = Math.min(Math.max(0, ny), 1 - (el.offsetHeight / dispH) * 0.3);
      el.style.left = (model.x * dispW) + 'px'; el.style.top = (model.y * dispH) + 'px';
    }
    function up() { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); }
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  }
  function startResize(e, el) {
    e.preventDefault(); e.stopPropagation(); var s = el.__model;
    var r = layer.getBoundingClientRect(), aspect = s.h / s.w;
    function mv(ev) {
      var w = (ev.clientX - r.left) / dispW - s.x; w = Math.max(0.03, Math.min(w, 1 - s.x));
      s.w = w; s.h = w * aspect * (Wpt / Hpt);   // keep image pixel aspect on the page
      el.style.width = (s.w * dispW) + 'px'; el.style.height = (s.h * dispH) + 'px';
    }
    function up() { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); }
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  }

  // ---------- stage interactions (create text / draw redact) ----------
  function stagePos(e) { var r = layer.getBoundingClientRect(); return { x: (e.clientX - r.left), y: (e.clientY - r.top) }; }
  stage.addEventListener('pointerdown', function (e) {
    if (e.target !== canvas && e.target !== stage && e.target !== layer) return;  // clicked an annotation
    var p = stagePos(e);
    if (tool === 'text') {
      var nx = p.x / dispW, ny = p.y / dispH;
      var o = { size: parseInt(sizeSel.value, 10) || 14, font: fontSel.value, color: colorInp.value };
      ensureUpright().then(function () {
        var t = { x: nx, y: ny, text: '', size: o.size, font: o.font, color: o.color };
        pg.texts.push(t); var el = makeTextEl(t); layer.appendChild(el);
        select(el); setTimeout(function () { el.__txt.focus(); }, 0);
      });
    } else if (tool === 'redact') {
      startRedactBox(e, p);
    } else { deselectAll(); selected = null; }
  });

  function startRedactBox(e, p0) {
    var box = document.createElement('div'); box.className = 'pt-anno pt-anno--redact'; layer.appendChild(box);
    var rec = { x: p0.x / dispW, y: p0.y / dispH, w: 0, h: 0 };
    function mv(ev) {
      var p = stagePos(ev); var x0 = p0.x, y0 = p0.y;
      var x = Math.min(x0, p.x), y = Math.min(y0, p.y), w = Math.abs(p.x - x0), h = Math.abs(p.y - y0);
      box.style.left = x + 'px'; box.style.top = y + 'px'; box.style.width = w + 'px'; box.style.height = h + 'px';
      rec.x = x / dispW; rec.y = y / dispH; rec.w = w / dispW; rec.h = h / dispH;
    }
    function up() {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      if (rec.w > 0.008 && rec.h > 0.008) { pendingRedact.push(rec); $('pt-ed-redact-apply').disabled = false; }
      else box.remove();
    }
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  }

  // live-update selected text style from the toolbar
  function applyTextStyle() {
    if (selected && selected.classList.contains('pt-anno--text')) {
      var t = selected.__model; t.font = fontSel.value; t.size = parseInt(sizeSel.value, 10) || 14; t.color = colorInp.value;
      selected.__txt.style.fontFamily = fontFamily(t.font); selected.__txt.style.fontSize = (t.size * scale) + 'px'; selected.__txt.style.color = t.color;
    }
  }
  fontSel.addEventListener('change', applyTextStyle); sizeSel.addEventListener('change', applyTextStyle); colorInp.addEventListener('input', applyTextStyle);

  // ---------- redaction (rasterize) ----------
  var redactDialog = $('pt-dialog');
  $('pt-ed-redact-apply').addEventListener('click', function () { if (pendingRedact.length) redactDialog.hidden = false; });
  $('pt-dialog-cancel').addEventListener('click', function () { redactDialog.hidden = true; });
  redactDialog.addEventListener('click', function (e) { if (e.target === redactDialog) redactDialog.hidden = true; });
  $('pt-dialog-go').addEventListener('click', function () {
    redactDialog.hidden = true; if (!pendingRedact.length) return;
    var dpi = parseInt($('pt-redact-dpi').value, 10) || 150; PT.setStatus('Rasterizing and redacting…');
    var boxes = pendingRedact.slice();
    PT.effPointSize(pg).then(function (sz) {
      return PT.renderPageCanvas(pg, sz.w * dpi / 72).then(function (r) {
        var c = r.canvas, cx = c.getContext('2d'); cx.fillStyle = '#000';
        boxes.forEach(function (b) { cx.fillRect(b.x * c.width, b.y * c.height, b.w * c.width, b.h * c.height); });
        return PT.canvasToBytes(c, 'image/png').then(function (png) {
          pg.raster = { png: png, wPt: sz.w, hPt: sz.h }; pg.rot = 0; pg.redacted = true;
          pendingRedact = []; $('pt-ed-redact-apply').disabled = true; PT.setStatus('Page redacted and flattened.');
          setTool('move'); renderPage();
        });
      });
    }).catch(function (e) { PT.setStatus('Redaction failed: ' + (e && e.message || e)); });
  });

  // ---------- signature pad / upload ----------
  var pad = $('pt-sigpad'), padCtx = pad.getContext('2d'), sigCanvas = null;
  function tab(which) {
    $('pt-sign-draw').hidden = which !== 'draw'; $('pt-sign-upload').hidden = which !== 'upload';
    $('pt-sign-tab-draw').classList.toggle('pt-tab--on', which === 'draw'); $('pt-sign-tab-upload').classList.toggle('pt-tab--on', which === 'upload');
  }
  $('pt-sign-tab-draw').addEventListener('click', function () { tab('draw'); });
  $('pt-sign-tab-upload').addEventListener('click', function () { tab('upload'); });
  var drawing = false, last = null;
  function padPos(e) { var r = pad.getBoundingClientRect(); return { x: (e.clientX - r.left) * pad.width / r.width, y: (e.clientY - r.top) * pad.height / r.height }; }
  pad.addEventListener('pointerdown', function (e) { drawing = true; last = padPos(e); try { pad.setPointerCapture(e.pointerId); } catch (er) {} e.preventDefault(); });
  pad.addEventListener('pointermove', function (e) { if (!drawing) return; var p = padPos(e); padCtx.strokeStyle = '#111'; padCtx.lineWidth = 2.2; padCtx.lineCap = 'round'; padCtx.beginPath(); padCtx.moveTo(last.x, last.y); padCtx.lineTo(p.x, p.y); padCtx.stroke(); last = p; });
  function commitPad() { if (!drawing) return; drawing = false; sigCanvas = trimToInk(pad) || sigCanvas; $('pt-sig-place').disabled = !sigCanvas; }
  pad.addEventListener('pointerup', commitPad); pad.addEventListener('pointercancel', commitPad);
  $('pt-sig-clear').addEventListener('click', function () { padCtx.clearRect(0, 0, pad.width, pad.height); sigCanvas = null; $('pt-sig-place').disabled = true; });
  var sigFile = $('pt-sigfile');
  $('pt-sig-pick').addEventListener('click', function () { sigFile.click(); });
  sigFile.addEventListener('change', function () {
    var f = sigFile.files && sigFile.files[0]; if (!f) return; var url = URL.createObjectURL(f), im = new Image();
    im.onload = function () { URL.revokeObjectURL(url); var c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; c.getContext('2d').drawImage(im, 0, 0); sigCanvas = c; $('pt-sig-place').disabled = false; };
    im.src = url; sigFile.value = '';
  });
  function trimToInk(c) {
    var w = c.width, h = c.height, d = c.getContext('2d').getImageData(0, 0, w, h).data, minX = w, minY = h, maxX = -1, maxY = -1;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 12) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    if (maxX < 0) return null; var pad2 = 5; minX = Math.max(0, minX - pad2); minY = Math.max(0, minY - pad2); maxX = Math.min(w - 1, maxX + pad2); maxY = Math.min(h - 1, maxY + pad2);
    var cw = maxX - minX + 1, ch = maxY - minY + 1, o = document.createElement('canvas'); o.width = cw; o.height = ch; o.getContext('2d').drawImage(c, minX, minY, cw, ch, 0, 0, cw, ch); return o;
  }
  $('pt-sig-place').addEventListener('click', function () {
    if (!sigCanvas) return;
    // signatures need an upright page; flatten first if rotated (shared with the text tool)
    ensureUpright().then(function () {
      return PT.canvasToBytes(sigCanvas, 'image/png').then(function (png) {
        var w = 0.28, h = w * (sigCanvas.height / sigCanvas.width) * (Wpt / Hpt);
        var s = { png: png, x: 0.5 - w / 2, y: 0.6, w: w, h: h };
        pg.sigs.push(s); var el = makeSigEl(s); layer.appendChild(el); select(el);
        setTool('move'); PT.setStatus('Signature placed — drag it where you want.');
      });
    });
  });

  // ---------- inline form-field widgets ----------
  function addFormWidgets() {
    if (pg.raster) return;                       // a rasterized page has no live form fields
    PT.pageEffRotation(pg).then(function (rot) {
      if (rot !== 0) return;                      // only place widgets on upright pages
      return PT.pdfjsPage(pg).then(function (page) {
        return page.getAnnotations().then(function (annots) {
          var di = pg.docIndex, vals = (PT.docs()[di].formValues) || {};
          annots.forEach(function (a) {
            if (a.subtype !== 'Widget' || !a.fieldName) return;
            var r = a.rect; if (!r) return;
            var left = r[0] * scale, top = (Hpt - r[3]) * scale, w = (r[2] - r[0]) * scale, h = (r[3] - r[1]) * scale;
            var el;
            if (a.fieldType === 'Tx') { el = document.createElement('input'); el.type = 'text'; el.value = (a.fieldName in vals) ? vals[a.fieldName] : (a.fieldValue || ''); }
            else if (a.fieldType === 'Ch') {
              el = document.createElement('select');
              (a.options || []).forEach(function (o) { var op = document.createElement('option'); var v = (o && o.exportValue != null) ? o.exportValue : (o && o.displayValue != null ? o.displayValue : o); op.value = v; op.textContent = (o && o.displayValue) || v; el.appendChild(op); });
              el.value = (a.fieldName in vals) ? vals[a.fieldName] : (a.fieldValue || '');
            } else if (a.fieldType === 'Btn') { el = document.createElement('input'); el.type = 'checkbox'; el.checked = (a.fieldName in vals) ? !!vals[a.fieldName] : (a.fieldValue && a.fieldValue !== 'Off'); }
            else return;
            el.className = 'pt-formwidget'; el.style.left = left + 'px'; el.style.top = top + 'px'; el.style.width = w + 'px'; el.style.height = h + 'px';
            if (el.type !== 'checkbox') el.style.fontSize = Math.max(9, h * 0.6) + 'px';
            el.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
            el.addEventListener('change', function () { var d = PT.docs()[di]; d.formValues = d.formValues || {}; d.formValues[a.fieldName] = (el.type === 'checkbox') ? el.checked : el.value; });
            el.addEventListener('input', function () { var d = PT.docs()[di]; d.formValues = d.formValues || {}; d.formValues[a.fieldName] = (el.type === 'checkbox') ? el.checked : el.value; });
            layer.appendChild(el);
          });
          if (annots.some(function (a) { return a.subtype === 'Widget' && a.fieldName; })) hint.textContent = 'This page has form fields (highlighted) — click into them to fill. ' + hint.textContent;
        });
      });
    });
  }

  // keyboard: Delete removes selected, Escape closes
  document.addEventListener('keydown', function (e) {
    if (ed.hidden) return;
    var onBody = document.activeElement === document.body;
    if (e.key === 'Escape') { if (!redactDialog.hidden) redactDialog.hidden = true; else close(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selected && onBody) { removeAnno(selected); }
    else if (e.key === 'ArrowLeft' && onBody) { goPrev(); }
    else if (e.key === 'ArrowRight' && onBody) { goNext(); }
  });

  // expose the opener for the thumbnail Edit buttons
  PT.openEditor = open;
})();
