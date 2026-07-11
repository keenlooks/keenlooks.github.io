/* Unified full-screen page editor for the PDF Toolbench. One page preview with tools:
   Move, Text (click to place, font/size/color), Sign (draw/upload/saved + place), Redact
   (draw boxes — they commit IMMEDIATELY as page annotations; a one-time dialog explains
   that pages with boxes are flattened to images on download, which is when the covered
   content is actually removed). Inline form-field inputs (text, checkbox, dropdown, radio
   groups) are shown when the page has AcroForm widgets. All edits live on the page model
   (pg.texts / pg.sigs / pg.redacts / pg.raster) and on docs[i].formValues, so thumbnails
   and export pick them up, and every edit takes an undo snapshot (Ctrl+Z / the Undo
   buttons). Depends on window.__PT. External file → // comments fine. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var PT = window.__PT; if (!PT) return;
  var ed = $('pt-ed'); if (!ed) return;

  var scrollEl = $('pt-ed-scroll'), stage = $('pt-ed-stage'), canvas = $('pt-ed-canvas'), layer = $('pt-ed-layer');
  // never let a native drag start inside the editor (a stray text selection, or the
  // signature <img>, would otherwise hijack annotation drags via pointercancel)
  ed.addEventListener('dragstart', function (e) { e.preventDefault(); });
  var hint = $('pt-ed-hint'), pageLabel = $('pt-ed-page');
  var fontSel = $('pt-text-font'), sizeSel = $('pt-text-size'), colorInp = $('pt-text-color');

  // size dropdown options
  [8, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 60, 72].forEach(function (s) {
    var o = document.createElement('option'); o.value = s; o.textContent = s + ' pt'; if (s === 14) o.selected = true; sizeSel.appendChild(o);
  });

  var idx = -1, pg = null, tool = 'move';
  var dispW = 0, dispH = 0, Wpt = 0, Hpt = 0, scale = 1;
  var selected = null;                 // selected annotation element
  var redactWarned = false;            // the one-time "how redaction works" dialog was acknowledged
  var pendingBox = null;               // { rec, el } — first-ever box, held until the dialog is confirmed

  function fontFamily(f) { return f === 'Times' ? 'Georgia, "Times New Roman", serif' : f === 'Courier' ? '"Courier New", monospace' : 'Arial, Helvetica, sans-serif'; }

  // ---------- open / render ----------
  function open(i) {
    if (PT.isBusy && PT.isBusy()) return;
    var pages = PT.pages(); if (i < 0 || i >= pages.length) return;
    if (pg) PT.markDirty(pg);          // navigating away — that page's thumbnail may be stale
    idx = i; pg = pages[i]; selected = null; setTool('move');
    ed.hidden = false;
    renderPage();
  }
  function close() {
    if (pg) PT.markDirty(pg);
    ed.hidden = true; pg = null; idx = -1;
    PT.renderGrid(); PT.updateToolbar();
  }

  // annotations (text/sig) are drawn with rotation-0 math at export, so a page with any
  // effective rotation must be flattened upright first (same as redact already does).
  // Snapshotted so Ctrl+Z can undo the flatten.
  function ensureUpright() {
    return PT.pageEffRotation(pg).then(function (r) {
      if (r === 0) return false;
      if (PT.snapshot) PT.snapshot('flatten page ' + (idx + 1) + ' upright');
      return PT.bakePageToRaster(pg, 150).then(function () { return renderPage(); }).then(function () { return true; });
    });
  }

  var renderSeq = 0;   // fast arrow-key navigation: only the LATEST render may append elements
  function renderPage() {
    layer.innerHTML = '';
    var mySeq = ++renderSeq;
    var avW = (scrollEl.clientWidth || 800) - 32, avH = (scrollEl.clientHeight || 600) - 32;
    return PT.effPointSize(pg).then(function (sz) {
      Wpt = sz.w; Hpt = sz.h; var aspect = Hpt / Wpt;
      var w = (avW * aspect <= avH) ? avW : avH / aspect;
      w = Math.max(220, Math.min(w, 1500));
      return PT.renderPageCanvas(pg, w);
    }).then(function (res) {
      if (mySeq !== renderSeq) return;   // a newer render owns the layer now (page-identity checks
                                         // are not enough: going away and BACK reuses the same pg)
      var cx = canvas.getContext('2d');
      canvas.width = res.canvas.width; canvas.height = res.canvas.height;
      cx.drawImage(res.canvas, 0, 0);
      dispW = canvas.width; dispH = canvas.height; scale = dispW / Wpt;
      // watermarks + page numbers preview (texts/sigs are live DOM elements instead)
      if (PT.drawMarks) PT.drawMarks(cx, pg, dispW, dispH, Wpt, Hpt, idx);
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
    if (t === 'sign') renderSavedSigs();
    stage.classList.toggle('pt-stage--text', t === 'text');
    stage.classList.toggle('pt-stage--redact', t === 'redact');
    // text content editable only in the text tool
    Array.prototype.forEach.call(layer.querySelectorAll('.pt-anno__txt'), function (el) { el.contentEditable = (t === 'text'); });
    hint.textContent = t === 'text' ? 'Click anywhere on the page to add text. Pick font, size, and color above.'
      : t === 'sign' ? 'Draw or upload a signature, click “Place on page”, then drag it where you want. Saved signatures stay in this browser only.'
      : t === 'redact' ? 'Drag boxes over anything to remove — they apply right away and stay with the page. On download the page is flattened to an image, so the covered text is truly gone. Click a box for its ×, or Ctrl+Z, to remove it.'
      : 'Click a text box, signature, or redaction to move or delete it. Use ‹ › or the arrow keys to change pages.';
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
  function annoKind(el) {
    return el.classList.contains('pt-anno--sig') ? 'signature'
      : el.classList.contains('pt-anno--redact') ? 'redaction' : 'text';
  }
  function removeAnno(el, skipSnap) {
    var m = el.__model, kind = annoKind(el);
    if (!pg) { el.remove(); selected = null; return; }   // a late blur can land after close()
    if (m) {
      var arr = kind === 'signature' ? pg.sigs : kind === 'redaction' ? pg.redacts : pg.texts;
      var k = (arr || []).indexOf(m);
      if (k >= 0) {
        if (!skipSnap && PT.snapshot) PT.snapshot('remove ' + kind + ' on page ' + (idx + 1));
        arr.splice(k, 1);
      }
    }
    el.remove(); selected = null;
    PT.markDirty(pg);
    if (kind === 'redaction' && !(pg.redacts || []).length)
      PT.setStatus('All redactions removed from this page — it keeps its original quality on download.');
  }

  function buildAnnoEls() {
    (pg.redacts || []).forEach(function (r) { layer.appendChild(makeRedactEl(r)); });
    (pg.texts || []).forEach(function (t) { layer.appendChild(makeTextEl(t)); });
    (pg.sigs || []).forEach(function (s) { layer.appendChild(makeSigEl(s)); });
  }

  function makeTextEl(t, isNew) {
    var el = document.createElement('div'); el.className = 'pt-anno pt-anno--text'; el.__model = t;
    el.style.left = (t.x * dispW) + 'px'; el.style.top = (t.y * dispH) + 'px';
    // the editable content is a separate inner node so handles (×) never become part of the text
    var txt = document.createElement('div'); txt.className = 'pt-anno__txt'; el.__txt = txt;
    txt.style.fontSize = (t.size * scale) + 'px'; txt.style.fontFamily = fontFamily(t.font); txt.style.color = t.color || '#111';
    txt.contentEditable = (tool === 'text'); txt.textContent = t.text || '';
    // one undo snapshot per editing session (a new box is covered by its creation snapshot)
    var armed = !isNew;
    txt.addEventListener('input', function () {
      if (armed) { armed = false; if (PT.snapshot) PT.snapshot('edit text on page ' + (idx + 1)); }
      t.text = txt.innerText;
      PT.markDirty(pg);
    });
    txt.addEventListener('blur', function () { armed = true; if (!(t.text || '').trim()) removeAnno(el, true); });
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
    var img = document.createElement('img');
    var url = URL.createObjectURL(new Blob([s.png], { type: 'image/png' }));
    img.onload = function () { URL.revokeObjectURL(url); };
    img.onerror = function () { URL.revokeObjectURL(url); };
    img.src = url;
    el.appendChild(img);
    el.addEventListener('pointerdown', function (e) { if (tool === 'move' || tool === 'sign') { e.preventDefault(); select(el); startDrag(e, el, s); } });
    return el;
  }
  function makeRedactEl(r) {
    var el = document.createElement('div'); el.className = 'pt-anno pt-anno--redact'; el.__model = r;
    el.style.left = (r.x * dispW) + 'px'; el.style.top = (r.y * dispH) + 'px';
    el.style.width = (r.w * dispW) + 'px'; el.style.height = (r.h * dispH) + 'px';
    el.addEventListener('pointerdown', function (e) {
      if (e.target.classList.contains('pt-anno__del')) return;
      if (tool === 'move') { e.preventDefault(); select(el); startDrag(e, el, r); }
      else if (tool === 'redact') { e.preventDefault(); select(el); }   // select → × to remove
    });
    return el;
  }

  // ---------- drag / resize ----------
  function startDrag(e, el, model) {
    var r = layer.getBoundingClientRect();
    var ox = e.clientX - r.left - model.x * dispW, oy = e.clientY - r.top - model.y * dispH;
    var sx = e.clientX, sy = e.clientY, moved = false;
    function mv(ev) {
      if (!moved) {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 3) return;   // a plain click just selects
        moved = true;
        if (PT.snapshot) PT.snapshot('move ' + annoKind(el) + ' on page ' + (idx + 1));
      }
      var nx = (ev.clientX - r.left - ox) / dispW, ny = (ev.clientY - r.top - oy) / dispH;
      model.x = Math.min(Math.max(0, nx), 1 - (el.offsetWidth / dispW) * 0.3);
      model.y = Math.min(Math.max(0, ny), 1 - (el.offsetHeight / dispH) * 0.3);
      el.style.left = (model.x * dispW) + 'px'; el.style.top = (model.y * dispH) + 'px';
    }
    function up() {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      if (moved) PT.markDirty(pg);
    }
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  }
  function startResize(e, el) {
    e.preventDefault(); e.stopPropagation(); var s = el.__model;
    var r = layer.getBoundingClientRect(), aspect = s.h / s.w;
    var moved = false;
    function mv(ev) {
      if (!moved) { moved = true; if (PT.snapshot) PT.snapshot('resize signature on page ' + (idx + 1)); }
      var w = (ev.clientX - r.left) / dispW - s.x; w = Math.max(0.03, Math.min(w, 1 - s.x));
      s.w = w; s.h = w * aspect * (Wpt / Hpt);   // keep image pixel aspect on the page
      el.style.width = (s.w * dispW) + 'px'; el.style.height = (s.h * dispH) + 'px';
    }
    function up() {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      if (moved) PT.markDirty(pg);
    }
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  }

  // ---------- stage interactions (create text / draw redact) ----------
  function stagePos(e) { var r = layer.getBoundingClientRect(); return { x: (e.clientX - r.left), y: (e.clientY - r.top) }; }
  stage.addEventListener('pointerdown', function (e) {
    if (e.button != null && e.button !== 0) return;                               // left button / touch only
    if (e.target !== canvas && e.target !== stage && e.target !== layer) return;  // clicked an annotation
    var p = stagePos(e);
    if (tool === 'text') {
      var nx = p.x / dispW, ny = p.y / dispH;
      var o = { size: parseInt(sizeSel.value, 10) || 14, font: fontSel.value, color: colorInp.value };
      var myPg = pg;
      ensureUpright().then(function (flattened) {
        if (myPg !== pg) return;   // the user navigated away while a rotated page was flattening
        // the flatten snapshot (if any) already covers this action — one Ctrl+Z undoes both
        if (!flattened && PT.snapshot) PT.snapshot('add text on page ' + (idx + 1));
        var t = { x: nx, y: ny, text: '', size: o.size, font: o.font, color: o.color };
        pg.texts.push(t); var el = makeTextEl(t, true); layer.appendChild(el);
        select(el); setTimeout(function () { el.__txt.focus(); }, 0);
      });
    } else if (tool === 'redact') {
      startRedactBox(e, p);
    } else { deselectAll(); selected = null; }
  });

  function startRedactBox(e, p0) {
    var box = document.createElement('div'); box.className = 'pt-anno pt-anno--redact pt-anno--redact-tmp'; layer.appendChild(box);
    var rec = { x: p0.x / dispW, y: p0.y / dispH, w: 0, h: 0 };
    var pg0 = pg;   // arrow-key nav or Escape mid-drag must not commit to the wrong page
    function mv(ev) {
      var p = stagePos(ev); var x0 = p0.x, y0 = p0.y;
      var x = Math.min(x0, p.x), y = Math.min(y0, p.y), w = Math.abs(p.x - x0), h = Math.abs(p.y - y0);
      box.style.left = x + 'px'; box.style.top = y + 'px'; box.style.width = w + 'px'; box.style.height = h + 'px';
      rec.x = x / dispW; rec.y = y / dispH; rec.w = w / dispW; rec.h = h / dispH;
    }
    function fin(commit) {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel);
      if (!commit || pg !== pg0 || ed.hidden || !(rec.w > 0.008 && rec.h > 0.008)) { box.remove(); return; }
      if (!redactWarned) {
        // hold the first-ever box until the one-time dialog is acknowledged
        pendingBox = { rec: rec, el: box };
        redactDialog.hidden = false;
        return;
      }
      commitRedact(rec, box);
    }
    function up() { fin(true); }
    function cancel() { fin(false); }
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel);
  }

  // a drawn box becomes a page annotation right away — no separate Apply step. The page
  // itself is untouched (full quality) until download, when core buildPdf flattens any
  // page that still has boxes; removing every box (× or Ctrl+Z) restores the page as-is.
  function commitRedact(rec, box) {
    if (PT.snapshot) PT.snapshot('redact on page ' + (idx + 1));
    (pg.redacts || (pg.redacts = [])).push(rec);
    PT.markDirty(pg);
    box.remove();
    var el = makeRedactEl(rec); layer.appendChild(el);
    PT.setStatus('Redaction added. The page is flattened to an image on download, which is what actually removes the covered text. Ctrl+Z undoes it.');
  }

  // live-update selected text style from the toolbar. One snapshot per styling burst:
  // the color picker fires 'input' continuously while dragged, so it disarms on the
  // first event and re-arms on 'change' (picker closed) / discrete select changes.
  var styleArmed = true;
  function applyTextStyle() {
    if (selected && selected.classList.contains('pt-anno--text')) {
      if (styleArmed) { styleArmed = false; if (PT.snapshot) PT.snapshot('restyle text on page ' + (idx + 1)); }
      var t = selected.__model; t.font = fontSel.value; t.size = parseInt(sizeSel.value, 10) || 14; t.color = colorInp.value;
      selected.__txt.style.fontFamily = fontFamily(t.font); selected.__txt.style.fontSize = (t.size * scale) + 'px'; selected.__txt.style.color = t.color;
      PT.markDirty(pg);
    }
  }
  function rearmStyle() { styleArmed = true; }
  fontSel.addEventListener('change', function () { applyTextStyle(); rearmStyle(); });
  sizeSel.addEventListener('change', function () { applyTextStyle(); rearmStyle(); });
  colorInp.addEventListener('input', applyTextStyle);
  colorInp.addEventListener('change', rearmStyle);

  // ---------- redaction dialog (one-time explainer) + download quality ----------
  var redactDialog = $('pt-dialog');
  function dialogCancel() {
    redactDialog.hidden = true;
    if (pendingBox) { pendingBox.el.remove(); pendingBox = null; }
  }
  $('pt-dialog-cancel').addEventListener('click', dialogCancel);
  redactDialog.addEventListener('click', function (e) { if (e.target === redactDialog) dialogCancel(); });
  $('pt-dialog-go').addEventListener('click', function () {
    redactDialog.hidden = true; redactWarned = true;
    if (pendingBox) { commitRedact(pendingBox.rec, pendingBox.el); pendingBox = null; }
  });
  var redactDpiSel = $('pt-redact-dpi');
  if (redactDpiSel && PT.setRedactDpi) {
    PT.setRedactDpi(parseInt(redactDpiSel.value, 10) || 150);
    redactDpiSel.addEventListener('change', function () { PT.setRedactDpi(parseInt(redactDpiSel.value, 10) || 150); });
  }

  // ---------- undo (shared stack with the main page) ----------
  // After an undo the pages array is replaced with clones, so rebind and re-render.
  PT.onUndo = function () {
    if (ed.hidden) return;
    var ps = PT.pages();
    if (!ps.length) { close(); return; }
    if (idx >= ps.length) idx = ps.length - 1;
    pg = ps[idx]; selected = null; pendingBox = null;
    renderPage();
  };
  $('pt-ed-undo').addEventListener('click', function () { if (!(PT.isBusy && PT.isBusy())) PT.undo(); });

  // ---------- signature pad / upload / saved ----------
  var pad = $('pt-sigpad'), padCtx = pad.getContext('2d'), sigCanvas = null;
  function sigReady() {
    $('pt-sig-place').disabled = !sigCanvas;
    var sv = $('pt-sig-save'); if (sv) sv.disabled = !sigCanvas;
  }
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
  function commitPad() { if (!drawing) return; drawing = false; sigCanvas = trimToInk(pad) || sigCanvas; sigReady(); }
  pad.addEventListener('pointerup', commitPad); pad.addEventListener('pointercancel', commitPad);
  $('pt-sig-clear').addEventListener('click', function () { padCtx.clearRect(0, 0, pad.width, pad.height); sigCanvas = null; sigReady(); });
  var sigFile = $('pt-sigfile');
  $('pt-sig-pick').addEventListener('click', function () { sigFile.click(); });
  sigFile.addEventListener('change', function () {
    var f = sigFile.files && sigFile.files[0]; if (!f) return; var url = URL.createObjectURL(f), im = new Image();
    im.onload = function () { URL.revokeObjectURL(url); var c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; c.getContext('2d').drawImage(im, 0, 0); sigCanvas = c; sigReady(); };
    im.onerror = function () { URL.revokeObjectURL(url); };
    im.src = url; sigFile.value = '';
  });
  function trimToInk(c) {
    var w = c.width, h = c.height, d = c.getContext('2d').getImageData(0, 0, w, h).data, minX = w, minY = h, maxX = -1, maxY = -1;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 12) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    if (maxX < 0) return null; var pad2 = 5; minX = Math.max(0, minX - pad2); minY = Math.max(0, minY - pad2); maxX = Math.min(w - 1, maxX + pad2); maxY = Math.min(h - 1, maxY + pad2);
    var cw = maxX - minX + 1, ch = maxY - minY + 1, o = document.createElement('canvas'); o.width = cw; o.height = ch; o.getContext('2d').drawImage(c, minX, minY, cw, ch, 0, 0, cw, ch); return o;
  }

  // saved signatures — trimmed dataURLs in localStorage; nothing leaves the device
  var SIG_KEY = 'pdftools.sigs';
  function loadSavedSigs() {
    try { var a = JSON.parse(localStorage.getItem(SIG_KEY) || '[]'); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function storeSavedSigs(a) { try { localStorage.setItem(SIG_KEY, JSON.stringify(a)); } catch (e) {} }
  function renderSavedSigs() {
    var wrap = $('pt-sig-savedwrap'), row = $('pt-sig-saved');
    if (!wrap || !row) return;
    row.innerHTML = '';
    var a = loadSavedSigs();
    wrap.hidden = a.length === 0;
    a.forEach(function (durl, i) {
      var chip = document.createElement('span'); chip.className = 'pt-sigsaved';
      var im = document.createElement('img');
      im.src = durl; im.alt = 'Saved signature ' + (i + 1); im.title = 'Use this signature';
      im.addEventListener('click', function () {
        var img = new Image();
        img.onload = function () {
          var c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          sigCanvas = c; sigReady();
          PT.setStatus('Signature loaded — click “Place on page”.');
        };
        img.src = durl;
      });
      var del = document.createElement('button'); del.type = 'button'; del.className = 'pt-sigsaved__del'; del.textContent = '×'; del.title = 'Delete this saved signature';
      del.addEventListener('click', function () {
        var b = loadSavedSigs(); b.splice(i, 1); storeSavedSigs(b); renderSavedSigs();
      });
      chip.appendChild(im); chip.appendChild(del);
      row.appendChild(chip);
    });
  }
  var sigSaveBtn = $('pt-sig-save');
  if (sigSaveBtn) sigSaveBtn.addEventListener('click', function () {
    if (!sigCanvas) return;
    var a = loadSavedSigs();
    a.unshift(sigCanvas.toDataURL('image/png'));
    storeSavedSigs(a.slice(0, 4));
    renderSavedSigs();
    PT.setStatus('Signature saved in this browser (it never leaves your device).');
  });

  $('pt-sig-place').addEventListener('click', function () {
    if (!sigCanvas) return;
    // signatures need an upright page; flatten first if rotated (shared with the text tool)
    var myPg = pg;
    ensureUpright().then(function (flattened) {
      return PT.canvasToBytes(sigCanvas, 'image/png').then(function (png) {
        if (myPg !== pg) return;   // the user navigated away while the page was flattening
        if (!flattened && PT.snapshot) PT.snapshot('place signature on page ' + (idx + 1));
        var w = 0.28, h = w * (sigCanvas.height / sigCanvas.width) * (Wpt / Hpt);
        var s = { png: png, x: 0.5 - w / 2, y: 0.6, w: w, h: h };
        pg.sigs.push(s); var el = makeSigEl(s); layer.appendChild(el); select(el);
        PT.markDirty(pg);
        setTool('move'); PT.setStatus('Signature placed — drag it where you want.');
      });
    });
  });

  // ---------- inline form-field widgets ----------
  function saveFieldValue(di, name, value) {
    var d = PT.docs()[di];
    d.formValues = d.formValues || {};
    d.formValues[name] = value;
  }
  function addFormWidgets() {
    if (pg.raster || pg.blank) return;           // a rasterized/blank page has no live form fields
    var myPg = pg, mySeq = renderSeq;
    PT.pageEffRotation(pg).then(function (rot) {
      if (rot !== 0 || myPg !== pg || mySeq !== renderSeq) return;   // only widgets for the LATEST render
      return PT.pdfjsPage(pg).then(function (page) {
        return page.getAnnotations().then(function (annots) {
          if (myPg !== pg || mySeq !== renderSeq) return;
          var di = pg.docIndex, vals = (PT.docs()[di].formValues) || {};
          annots.forEach(function (a) {
            if (a.subtype !== 'Widget' || !a.fieldName) return;
            var r = a.rect; if (!r) return;
            var left = r[0] * scale, top = (Hpt - r[3]) * scale, w = (r[2] - r[0]) * scale, h = (r[3] - r[1]) * scale;
            var el;
            if (a.fieldType === 'Tx') {
              el = document.createElement('input'); el.type = 'text';
              el.value = (a.fieldName in vals) ? vals[a.fieldName] : (a.fieldValue || '');
            } else if (a.fieldType === 'Ch') {
              el = document.createElement('select');
              (a.options || []).forEach(function (o) { var op = document.createElement('option'); var v = (o && o.exportValue != null) ? o.exportValue : (o && o.displayValue != null ? o.displayValue : o); op.value = v; op.textContent = (o && o.displayValue) || v; el.appendChild(op); });
              el.value = (a.fieldName in vals) ? vals[a.fieldName] : (a.fieldValue || '');
            } else if (a.fieldType === 'Btn' && a.radioButton) {
              // radio group: each widget is one option; buttonValue is its export value.
              // pdf-lib's PDFRadioGroup.select() takes that same export value at build time.
              el = document.createElement('input'); el.type = 'radio';
              el.name = 'ptr-' + di + '-' + a.fieldName;
              el.value = a.buttonValue != null ? String(a.buttonValue) : '';
              var cur = (a.fieldName in vals) ? vals[a.fieldName] : a.fieldValue;
              el.checked = cur != null && String(cur) === el.value && el.value !== '';
            } else if (a.fieldType === 'Btn' && !a.pushButton) {
              el = document.createElement('input'); el.type = 'checkbox';
              el.checked = (a.fieldName in vals) ? !!vals[a.fieldName] : (a.fieldValue && a.fieldValue !== 'Off');
            } else return;                        // push buttons and unknown widgets: skip
            el.className = 'pt-formwidget';
            el.style.left = left + 'px'; el.style.top = top + 'px'; el.style.width = w + 'px'; el.style.height = h + 'px';
            if (el.type !== 'checkbox' && el.type !== 'radio') el.style.fontSize = Math.max(9, h * 0.6) + 'px';
            el.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
            // one undo snapshot per focus session, taken before the first change lands
            var armed = true;
            el.addEventListener('focus', function () { armed = true; });
            function commit() {
              if (armed) { armed = false; if (PT.snapshot) PT.snapshot('fill form field'); }
              if (el.type === 'radio') { if (el.checked) saveFieldValue(di, a.fieldName, el.value); }
              else saveFieldValue(di, a.fieldName, el.type === 'checkbox' ? el.checked : el.value);
            }
            el.addEventListener('change', commit);
            el.addEventListener('input', commit);
            layer.appendChild(el);
          });
          if (annots.some(function (a) { return a.subtype === 'Widget' && a.fieldName; })) hint.textContent = 'This page has form fields (highlighted) — click into them to fill. ' + hint.textContent;
        });
      });
    });
  }

  // keyboard: Ctrl+Z undoes, Delete removes selected, Escape closes, arrows navigate
  document.addEventListener('keydown', function (e) {
    if (ed.hidden) return;
    if (!redactDialog.hidden) { if (e.key === 'Escape') dialogCancel(); return; }   // modal traps keys
    var a = document.activeElement;
    var typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
    if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      if (typing || (PT.isBusy && PT.isBusy())) return;   // native undo inside inputs
      e.preventDefault(); PT.undo(); return;
    }
    var onBody = a === document.body;
    if (e.key === 'Escape') { close(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selected && onBody) { removeAnno(selected); }
    else if (e.key === 'ArrowLeft' && onBody) { goPrev(); }
    else if (e.key === 'ArrowRight' && onBody) { goNext(); }
  });

  // expose the opener for the thumbnail Edit buttons
  PT.openEditor = open;
})();
