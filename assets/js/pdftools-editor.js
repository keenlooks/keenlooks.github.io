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
  var lastOpenIdx = -1;                // the page whose thumb gets focus back on close
  var dispW = 0, dispH = 0, Wpt = 0, Hpt = 0, scale = 1;
  var selected = null;                 // selected annotation element
  var redactWarned = false;            // the one-time "how redaction works" dialog was acknowledged
  var pendingBox = null;               // { rec, el } — first-ever box, held until the dialog is confirmed

  function fontFamily(f) { return f === 'Times' ? 'Georgia, "Times New Roman", serif' : f === 'Courier' ? '"Courier New", monospace' : 'Arial, Helvetica, sans-serif'; }

  // ---------- open / render ----------
  function open(i, keepTool) {
    if (PT.isBusy && PT.isBusy()) return;
    var pages = PT.pages(); if (i < 0 || i >= pages.length) return;
    if (pg) PT.markDirty(pg);          // navigating away — that page's thumbnail may be stale
    idx = i; pg = pages[i]; selected = null; lastOpenIdx = i;
    // page navigation keeps the active tool (redacting a multi-page doc shouldn't snap
    // back to Move on every arrow); a fresh open from the grid starts on Move
    setTool(keepTool ? tool : 'move');
    ed.hidden = false;
    renderPage();
  }
  function close() {
    renderSeq++;                       // abandon any in-flight render (it must not touch a null pg)
    if (curTask) { try { curTask.cancel(); } catch (er) {} curTask = null; }
    if (pg) {
      // EVERY close path drops abandoned empty text boxes, not just the Done button —
      // an invisible {text:''} ghost would otherwise force a rotated page to flatten
      pg.texts = (pg.texts || []).filter(function (t) { return (t.text || '').trim().length; });
      PT.markDirty(pg);
    }
    ed.hidden = true; pg = null; idx = -1;
    PT.renderGrid(); PT.updateToolbar();
    // hand focus back to the grid: the fresh thumb of the page we were editing
    // (renderGrid rebuilt the nodes), else the first thumb, else the Download button
    var thumbs = document.querySelectorAll('#pt-grid .pt-thumb');
    var back = (lastOpenIdx >= 0 && lastOpenIdx < thumbs.length) ? thumbs[lastOpenIdx]
      : (thumbs.length ? thumbs[0] : $('pt-download'));
    if (back) { try { back.focus(); } catch (er) {} }
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
  var curTask = null;  // in-flight pdf.js render task — a superseding render (or close) cancels it
  function renderPage() {
    layer.innerHTML = '';
    var mySeq = ++renderSeq;
    if (curTask) { try { curTask.cancel(); } catch (er) {} curTask = null; }
    var edW = scrollEl.clientWidth || 800;
    // reserve the side page-nav arrow gutters (46px arrows at 12px from each edge) so an
    // enabled arrow never overlaps a wide page; below ~640px the arrows are hidden in CSS
    var avW = edW - 32 - (edW >= 620 ? 120 : 0), avH = (scrollEl.clientHeight || 600) - 32;
    return PT.effPointSize(pg).then(function (sz) {
      Wpt = sz.w; Hpt = sz.h; var aspect = Hpt / Wpt;
      var w = (avW * aspect <= avH) ? avW : avH / aspect;
      w = Math.max(220, Math.min(w, 1500));
      return PT.renderPageCanvas(pg, w, { onTask: function (t) {
        if (mySeq === renderSeq) curTask = t;
        else { try { t.cancel(); } catch (er) {} }   // superseded before its task even started
      } });
    }).then(function (res) {
      if (!pg || mySeq !== renderSeq) {  // a newer render owns the layer now, or the editor closed
                                         // (page-identity checks are not enough: going away and
                                         // BACK reuses the same pg; close() nulls pg + bumps seq)
        res.canvas.width = 0;
        return;
      }
      curTask = null;                    // this render owned the task and it just completed
      var cx = canvas.getContext('2d');
      canvas.width = res.canvas.width; canvas.height = res.canvas.height;
      cx.drawImage(res.canvas, 0, 0);
      res.canvas.width = 0;              // free the intermediate canvas (up to 1500px wide)
      dispW = canvas.width; dispH = canvas.height; scale = dispW / Wpt;
      // watermarks + page numbers preview (texts/sigs are live DOM elements instead)
      if (PT.drawMarks) PT.drawMarks(cx, pg, dispW, dispH, Wpt, Hpt, idx);
      stage.style.width = dispW + 'px'; stage.style.height = dispH + 'px';
      layer.style.width = dispW + 'px'; layer.style.height = dispH + 'px';
      pageLabel.textContent = 'Page ' + (idx + 1) + ' of ' + PT.pages().length;
      buildAnnoEls();
      addFormWidgets();
      updateNav();
    }).catch(function (err) {
      /* a superseded render was cancelled (RenderingCancelledException) — expected,
         its continuation is already a no-op via the mySeq guard */
      if (!(err && (err.name === 'RenderingCancelledException' || /cancel/i.test(String(err && err.message || ''))))) {
        if (window.console) console.warn('pdftools: editor page render failed.', err);
      }
    });
  }

  function updateNav() {
    var n = PT.pages().length, atStart = idx <= 0, atEnd = idx >= n - 1;
    $('pt-ed-prev').disabled = atStart; $('pt-ed-next').disabled = atEnd;
    $('pt-ed-arrow-left').disabled = atStart; $('pt-ed-arrow-right').disabled = atEnd;
  }
  function goPrev() { if (idx > 0) open(idx - 1, true); }
  function goNext() { if (idx < PT.pages().length - 1) open(idx + 1, true); }
  $('pt-ed-prev').addEventListener('click', goPrev);
  $('pt-ed-next').addEventListener('click', goNext);
  $('pt-ed-arrow-left').addEventListener('click', goPrev);
  $('pt-ed-arrow-right').addEventListener('click', goNext);
  $('pt-ed-done').addEventListener('click', function () { close(); });   // close() drops empty text boxes

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
    el.__nudged = false;   // re-arm the one-snapshot-per-selection arrow-key nudge
    var del = document.createElement('button'); del.className = 'pt-anno__del'; del.type = 'button'; del.textContent = '×';
    // a touch tap that CREATES a box makes the browser synthesize a post-tap click at
    // the tap point — where this × has just appeared — instantly deleting the new box.
    // Only honor a click the × itself was armed for by its own pointerdown; keyboard
    // activation (Enter/Space) has e.detail === 0 and no pointerdown, so it stays allowed.
    var armedDel = false;
    del.addEventListener('pointerdown', function (e) { e.stopPropagation(); armedDel = true; });
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!armedDel && e.detail !== 0) return;
      armedDel = false;
      removeAnno(el);
    });
    el.appendChild(del);
    if (el.classList.contains('pt-anno--sig')) {
      var rz = document.createElement('span'); rz.className = 'pt-anno__resize';
      rz.addEventListener('pointerdown', function (e) {
        if (e.button != null && e.button !== 0) return;   // left button / touch only
        startResize(e, el);
      });
      el.appendChild(rz);
    }
  }
  function annoKind(el) {
    return el.classList.contains('pt-anno--sig') ? 'signature'
      : el.classList.contains('pt-anno--redact') ? 'redaction' : 'text';
  }
  function removeAnno(el, skipSnap) {
    var m = el.__model, kind = annoKind(el);
    if (!pg) { el.remove(); if (selected === el) selected = null; return; }   // a late blur can land after close()
    if (m) {
      var arr = kind === 'signature' ? pg.sigs : kind === 'redaction' ? pg.redacts : pg.texts;
      var k = (arr || []).indexOf(m);
      if (k >= 0) {
        if (!skipSnap && PT.snapshot) PT.snapshot('remove ' + kind + ' on page ' + (idx + 1));
        arr.splice(k, 1);
      }
    }
    el.remove();
    if (selected === el) selected = null;   // never clobber a selection this el doesn't own
    PT.markDirty(pg);
    if (kind === 'redaction' && !(pg.redacts || []).length)
      PT.setStatus('All redactions removed from this page — it keeps its original quality on download.');
  }

  function buildAnnoEls() {
    (pg.redacts || []).forEach(function (r) { layer.appendChild(makeRedactEl(r)); });
    (pg.texts || []).forEach(function (t) { layer.appendChild(makeTextEl(t)); });
    (pg.sigs || []).forEach(function (s) { layer.appendChild(makeSigEl(s)); });
  }

  function makeTextEl(t, isNew, ownSnap) {
    var el = document.createElement('div'); el.className = 'pt-anno pt-anno--text'; el.__model = t;
    el.style.left = (t.x * dispW) + 'px'; el.style.top = (t.y * dispH) + 'px';
    // the editable content is a separate inner node so handles (×) never become part of the text
    var txt = document.createElement('div'); txt.className = 'pt-anno__txt'; el.__txt = txt;
    txt.style.fontSize = (t.size * scale) + 'px'; txt.style.fontFamily = fontFamily(t.font); txt.style.color = t.color || '#111';
    txt.contentEditable = (tool === 'text'); txt.textContent = t.text || '';
    // one undo snapshot per editing session (a new box is covered by its creation snapshot)
    var armed = !isNew;
    // ownSnap: this new box took its OWN 'add text' snapshot (i.e. no flatten snapshot
    // covers it) — if the box is abandoned empty, that snapshot must be dropped or the
    // next Ctrl+Z becomes a visible no-op
    var createSeq = (isNew && ownSnap && PT.snapSeq) ? PT.snapSeq() : -1;
    txt.addEventListener('input', function () {
      // a browser NATIVE undo can replay edits into this node after the editor closed
      // (pg null) or the layer was rebuilt (node detached) — never sync those to the model
      if (!pg || !txt.isConnected) return;
      if (armed) { armed = false; if (PT.snapshot) PT.snapshot('edit text on page ' + (idx + 1)); }
      t.text = txt.innerText;
      PT.markDirty(pg);
    });
    txt.addEventListener('blur', function () {
      armed = true;
      if (!el.isConnected) return;   // a teardown blur (undo/nav re-render removed the
                                     // box), not the user abandoning it — nothing to drop
      if (!(t.text || '').trim()) {
        removeAnno(el, true);
        // only drop the creation snapshot while it is still the top of the stack
        if (createSeq >= 0 && PT.snapSeq && PT.snapSeq() === createSeq && PT.dropSnapshot) PT.dropSnapshot();
      }
    });
    el.appendChild(txt);
    annoKeyboardable(el);
    el.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;                          // left button / touch only
      if (e.target.classList.contains('pt-anno__del') || e.target.classList.contains('pt-anno__resize')) return;
      if (tool === 'move') { e.preventDefault(); select(el); startDrag(e, el, t); }
      else if (tool === 'text') { select(el); setTimeout(function () { txt.focus(); }, 0); }
    });
    return el;
  }
  // keyboard path to EXISTING annotations: focusable (they join the editor Tab order via
  // [tabindex]) and focusing one selects it, so arrows nudge / Delete removes it. A
  // pointerdown-select doesn't fight this: move-tool pointerdowns preventDefault (no
  // focus change) and the focus handler no-ops when the element is already selected.
  function annoKeyboardable(el) {
    el.setAttribute('tabindex', '0');
    el.addEventListener('focus', function () { if (selected !== el) select(el); });
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
    annoKeyboardable(el);
    el.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;                          // left button / touch only
      if (tool === 'move' || tool === 'sign') { e.preventDefault(); select(el); startDrag(e, el, s); }
    });
    return el;
  }
  function makeRedactEl(r) {
    var el = document.createElement('div'); el.className = 'pt-anno pt-anno--redact'; el.__model = r;
    el.style.left = (r.x * dispW) + 'px'; el.style.top = (r.y * dispH) + 'px';
    el.style.width = (r.w * dispW) + 'px'; el.style.height = (r.h * dispH) + 'px';
    annoKeyboardable(el);
    el.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;                          // left button / touch only
      if (e.target.classList.contains('pt-anno__del')) return;
      if (tool === 'move') { e.preventDefault(); select(el); startDrag(e, el, r); }
      else if (tool === 'redact') { e.preventDefault(); select(el); }   // select → × to remove
    });
    return el;
  }

  // ---------- drag / resize ----------
  // pg0 capture: Escape (or arrow-key nav) can close/change the page MID-DRAG; the
  // pointerup that follows must not touch the old model or markDirty(null) — the same
  // interleaving startRedactBox already guards against.
  var activeDragCancel = null;   // set while an annotation drag/resize is in flight, so
                                 // Escape aborts the gesture (restoring the pre-drag
                                 // state) instead of deselecting while it keeps tracking
  function startDrag(e, el, model) {
    var r = layer.getBoundingClientRect();
    var ox = e.clientX - r.left - model.x * dispW, oy = e.clientY - r.top - model.y * dispH;
    var sx = e.clientX, sy = e.clientY, moved = false, pg0 = pg;
    var mx0 = model.x, my0 = model.y, mySnap = -1;   // pre-drag state for Escape cancel
    function mv(ev) {
      if (pg !== pg0 || ed.hidden) return;
      if (!moved) {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 3) return;   // a plain click just selects
        moved = true;
        if (PT.snapshot) { PT.snapshot('move ' + annoKind(el) + ' on page ' + (idx + 1)); mySnap = PT.snapSeq ? PT.snapSeq() : -1; }
      }
      var nx = (ev.clientX - r.left - ox) / dispW, ny = (ev.clientY - r.top - oy) / dispH;
      model.x = Math.min(Math.max(0, nx), 1 - (el.offsetWidth / dispW) * 0.3);
      model.y = Math.min(Math.max(0, ny), 1 - (el.offsetHeight / dispH) * 0.3);
      el.style.left = (model.x * dispW) + 'px'; el.style.top = (model.y * dispH) + 'px';
    }
    function up() {
      activeDragCancel = null;
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      if (moved && pg === pg0 && pg) PT.markDirty(pg);
    }
    activeDragCancel = function () {
      activeDragCancel = null;
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      model.x = mx0; model.y = my0;
      el.style.left = (mx0 * dispW) + 'px'; el.style.top = (my0 * dispH) + 'px';
      // drop the 'move' snapshot, but only while it is still the top of the stack
      if (moved && mySnap >= 0 && PT.snapSeq && PT.snapSeq() === mySnap && PT.dropSnapshot) PT.dropSnapshot();
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  }
  function startResize(e, el) {
    e.preventDefault(); e.stopPropagation(); var s = el.__model;
    var r = layer.getBoundingClientRect(), aspect = s.h / s.w;
    var moved = false, pg0 = pg;
    var w0 = s.w, h0 = s.h, mySnap = -1;             // pre-resize state for Escape cancel
    function mv(ev) {
      if (pg !== pg0 || ed.hidden) return;
      if (!moved) { moved = true; if (PT.snapshot) { PT.snapshot('resize signature on page ' + (idx + 1)); mySnap = PT.snapSeq ? PT.snapSeq() : -1; } }
      var w = (ev.clientX - r.left) / dispW - s.x; w = Math.max(0.03, Math.min(w, 1 - s.x));
      s.w = w; s.h = w * aspect;   // aspect is the NORMALIZED ratio — Wpt/Hpt is already
                                   // baked in at placement, applying it again squashed
                                   // the signature by Wpt/Hpt on every resize
      el.style.width = (s.w * dispW) + 'px'; el.style.height = (s.h * dispH) + 'px';
    }
    function up() {
      activeDragCancel = null;
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      if (moved && pg === pg0 && pg) PT.markDirty(pg);
    }
    activeDragCancel = function () {
      activeDragCancel = null;
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      s.w = w0; s.h = h0;
      el.style.width = (w0 * dispW) + 'px'; el.style.height = (h0 * dispH) + 'px';
      if (moved && mySnap >= 0 && PT.snapSeq && PT.snapSeq() === mySnap && PT.dropSnapshot) PT.dropSnapshot();
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  }

  // ---------- stage interactions (create text / draw redact) ----------
  function stagePos(e) { var r = layer.getBoundingClientRect(); return { x: (e.clientX - r.left), y: (e.clientY - r.top) }; }
  // create an empty, focused text box at normalized (nx, ny) — shared by the stage
  // click and the keyboard path
  function createTextAt(nx, ny) {
    var o = { size: parseInt(sizeSel.value, 10) || 14, font: fontSel.value, color: colorInp.value };
    var myPg = pg;
    ensureUpright().then(function (flattened) {
      if (myPg !== pg) return;   // the user navigated away while a rotated page was flattening
      // the flatten snapshot (if any) already covers this action — one Ctrl+Z undoes both
      if (!flattened && PT.snapshot) PT.snapshot('add text on page ' + (idx + 1));
      var t = { x: nx, y: ny, text: '', size: o.size, font: o.font, color: o.color };
      pg.texts.push(t); var el = makeTextEl(t, true, !flattened); layer.appendChild(el);
      select(el); setTimeout(function () { el.__txt.focus(); }, 0);
    });
  }
  stage.addEventListener('pointerdown', function (e) {
    if (e.button != null && e.button !== 0) return;                               // left button / touch only
    // clicks on annotations are theirs — EXCEPT the text tool over a redaction box or a
    // signature: typing a replacement label over blacked-out content (or a date/name on
    // a signature) is the natural workflow (the export renders those stacks correctly)
    var onRedactEl = e.target.classList && e.target.classList.contains('pt-anno--redact');
    var onSigEl = !!(e.target.closest && e.target.closest('.pt-anno--sig'));
    if (e.target !== canvas && e.target !== stage && e.target !== layer && !(tool === 'text' && (onRedactEl || onSigEl))) return;
    var p = stagePos(e);
    if (tool === 'text') {
      createTextAt(p.x / dispW, p.y / dispH);
    } else if (tool === 'redact') {
      startRedactBox(e, p);
    } else { deselectAll(); selected = null; }
  });

  var activeRedactCancel = null;   // set while a redact drag is in flight, so Escape can
                                   // cancel the BOX instead of closing the whole editor
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
      activeRedactCancel = null;
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel);
      if (!commit || pg !== pg0 || ed.hidden || !(rec.w > 0.008 && rec.h > 0.008)) { box.remove(); return; }
      if (!redactWarned) {
        // hold the first-ever box until the one-time dialog is acknowledged
        pendingBox = { rec: rec, el: box };
        openRedactDialog();
        return;
      }
      commitRedact(rec, box);
    }
    function up() { fin(true); }
    function cancel() { fin(false); }
    activeRedactCancel = function () { fin(false); };
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
    return el;
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
  function openRedactDialog() {
    redactDialog.hidden = false;
    // move focus into the modal (the core Tab trap keeps it there)
    setTimeout(function () { var b = $('pt-dialog-go'); if (b) b.focus(); }, 0);
  }
  // closing the explainer hands focus back to the stage (the dialog stole it from
  // there); setTimeout(0) so a real click's default focus move can't undo it
  function refocusStage() { setTimeout(function () { if (!ed.hidden) { try { stage.focus(); } catch (er) {} } }, 0); }
  function dialogCancel() {
    redactDialog.hidden = true;
    if (pendingBox) { pendingBox.el.remove(); pendingBox = null; }
    refocusStage();
  }
  $('pt-dialog-cancel').addEventListener('click', dialogCancel);
  redactDialog.addEventListener('click', function (e) { if (e.target === redactDialog) dialogCancel(); });
  $('pt-dialog-go').addEventListener('click', function () {
    redactDialog.hidden = true; redactWarned = true;
    // select the committed box so the keyboard path (dialog on the FIRST box) ends in
    // the same state as every later keyboardRedact()
    if (pendingBox) { select(commitRedact(pendingBox.rec, pendingBox.el)); pendingBox = null; }
    refocusStage();
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
    setTool(tool);   // re-baseline the hint (addFormWidgets prefixes it — without this
                     // every undo on a form page stacks another copy) + reset selection
    renderPage();
  };
  // activating Undo must never BLUR a focused empty text box first: the blur removes
  // the box and drops its creation snapshot, so the click's PT.undo() would pop the
  // NEXT entry — silently reverting the user's previous action (e.g. a redaction)
  ['pointerdown', 'mousedown'].forEach(function (ev) {
    $('pt-ed-undo').addEventListener(ev, function (e) { e.preventDefault(); });
  });
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
  var drawing = false, last = null, padSnap = null, padPid = null;
  function padPos(e) { var r = pad.getBoundingClientRect(); return { x: (e.clientX - r.left) * pad.width / r.width, y: (e.clientY - r.top) * pad.height / r.height }; }
  pad.addEventListener('pointerdown', function (e) {
    if (e.button != null && e.button !== 0) return;
    drawing = true; last = padPos(e); padPid = e.pointerId;
    // pre-stroke snapshot so Escape can abort the stroke instead of closing the editor
    try { padSnap = padCtx.getImageData(0, 0, pad.width, pad.height); } catch (er) { padSnap = null; }
    try { pad.setPointerCapture(e.pointerId); } catch (er) {}
    e.preventDefault();
  });
  pad.addEventListener('pointermove', function (e) { if (!drawing) return; var p = padPos(e); padCtx.strokeStyle = '#111'; padCtx.lineWidth = 2.2; padCtx.lineCap = 'round'; padCtx.beginPath(); padCtx.moveTo(last.x, last.y); padCtx.lineTo(p.x, p.y); padCtx.stroke(); last = p; });
  function commitPad() { if (!drawing) return; drawing = false; padSnap = null; padPid = null; sigCanvas = trimToInk(pad) || sigCanvas; sigReady(); }
  // Escape mid-stroke: abort the stroke (restore the pad's pre-stroke ink), keep the editor
  function abortPadStroke() {
    if (!drawing) return;
    drawing = false; last = null;
    if (padPid != null) { try { pad.releasePointerCapture(padPid); } catch (er) {} padPid = null; }
    padCtx.clearRect(0, 0, pad.width, pad.height);
    if (padSnap) { try { padCtx.putImageData(padSnap, 0, 0); } catch (er) {} }
    padSnap = null;
  }
  pad.addEventListener('pointerup', commitPad); pad.addEventListener('pointercancel', commitPad);
  $('pt-sig-clear').addEventListener('click', function () { padCtx.clearRect(0, 0, pad.width, pad.height); sigCanvas = null; sigReady(); });
  var sigFile = $('pt-sigfile');
  $('pt-sig-pick').addEventListener('click', function () { sigFile.click(); });
  // shared by the file input and by images DROPPED onto the open editor (PT.onEditorDrop)
  function loadSigFile(f) {
    var url = URL.createObjectURL(f), im = new Image();
    im.onload = function () {
      URL.revokeObjectURL(url);
      var c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
      c.getContext('2d').drawImage(im, 0, 0); sigCanvas = c; sigReady();
      edNotice('Signature image loaded — click “Place on page”.');
    };
    im.onerror = function () { URL.revokeObjectURL(url); edNotice('Could not read that image.'); };
    im.src = url;
  }
  sigFile.addEventListener('change', function () {
    var f = sigFile.files && sigFile.files[0]; if (!f) return;
    loadSigFile(f); sigFile.value = '';
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

  var sigPlacing = false;   // a double-click must not run the async place chain twice
                            // (it would stack two identical, invisible-duplicate signatures)
  $('pt-sig-place').addEventListener('click', function () {
    if (!sigCanvas || sigPlacing) return;
    sigPlacing = true;
    var btn = $('pt-sig-place'); btn.disabled = true;
    function done() { sigPlacing = false; sigReady(); }
    // signatures need an upright page; flatten first if rotated (shared with the text tool)
    var myPg = pg;
    ensureUpright().then(function (flattened) {
      return PT.canvasToBytes(sigCanvas, 'image/png').then(function (png) {
        if (myPg !== pg) return;   // the user navigated away while the page was flattening
        if (!flattened && PT.snapshot) PT.snapshot('place signature on page ' + (idx + 1));
        var w = 0.28, h = w * (sigCanvas.height / sigCanvas.width) * (Wpt / Hpt);
        var s = { png: png, x: 0.5 - w / 2, y: 0.6, w: w, h: h };
        pg.sigs.push(s); var el = makeSigEl(s); layer.appendChild(el);
        PT.markDirty(pg);
        // setTool BEFORE select — setTool starts with a deselect, which used to wipe
        // the fresh selection and leave the just-placed sig with no ×/resize handles
        setTool('move'); select(el);
        PT.setStatus('Signature placed — drag it where you want.');
      });
    }).then(done, done);
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
      if (myPg !== pg || mySeq !== renderSeq) return;                // only widgets for the LATEST render
      return PT.pdfjsPage(pg).then(function (page) {
        return page.getAnnotations().then(function (annots) {
          if (myPg !== pg || mySeq !== renderSeq) return;
          var hasFields = annots.some(function (a) { return a.subtype === 'Widget' && a.fieldName; });
          if (rot !== 0) {
            // live widgets use rotation-0 math, so a rotated page can't be filled here —
            // but the form must not just VANISH: paint any already-filled values
            // read-only (the thumbnails and export show them) and explain the limit
            if (!hasFields) return;
            var d0 = PT.docs()[pg.docIndex];
            if (d0 && d0.formValues && Object.keys(d0.formValues).length) {
              // paint onto an offscreen copy, blit back only if this render still owns
              // the canvas (paintFormValues is async — a stale draw would ghost onto
              // the next page)
              var pc = document.createElement('canvas'); pc.width = canvas.width; pc.height = canvas.height;
              pc.getContext('2d').drawImage(canvas, 0, 0);
              PT.paintFormValues(pc, pg).then(function () {
                if (myPg === pg && mySeq === renderSeq) canvas.getContext('2d').drawImage(pc, 0, 0);
                pc.width = 0;
              });
            }
            hint.textContent = 'This page has form fields, but they can only be filled while the page is upright — rotate it in the page grid (filled values are kept). ' + hint.textContent;
            return;
          }
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
              PT.markDirty(myPg);   // the grid thumbnail previews filled values too
            }
            el.addEventListener('change', commit);
            el.addEventListener('input', commit);
            layer.appendChild(el);
          });
          if (hasFields) hint.textContent = 'This page has form fields (highlighted) — click into them to fill. ' + hint.textContent;
        });
      });
    });
  }

  // ---------- keyboard ----------
  // nudge the selected annotation with the arrow keys (1% steps, 5% with Shift)
  function nudgeSelected(key, big) {
    var m = selected && selected.__model; if (!m) return;
    if (!selected.__nudged) { selected.__nudged = true; if (PT.snapshot) PT.snapshot('move ' + annoKind(selected) + ' on page ' + (idx + 1)); }
    var step = big ? 0.05 : 0.01;
    if (key === 'ArrowLeft') m.x -= step; else if (key === 'ArrowRight') m.x += step;
    else if (key === 'ArrowUp') m.y -= step; else if (key === 'ArrowDown') m.y += step;
    m.x = Math.min(Math.max(0, m.x), 1 - (selected.offsetWidth / dispW) * 0.3);
    m.y = Math.min(Math.max(0, m.y), 1 - (selected.offsetHeight / dispH) * 0.3);
    selected.style.left = (m.x * dispW) + 'px'; selected.style.top = (m.y * dispH) + 'px';
    PT.markDirty(pg);
  }
  // keyboard path for redaction: drop a default-size box at the page center, then
  // nudge/resize is arrow keys + Delete (the stage is focusable, see the md markup)
  function keyboardRedact() {
    var rec = { x: 0.35, y: 0.44, w: 0.3, h: 0.08 };
    var box = document.createElement('div'); box.className = 'pt-anno pt-anno--redact pt-anno--redact-tmp';
    box.style.left = (rec.x * dispW) + 'px'; box.style.top = (rec.y * dispH) + 'px';
    box.style.width = (rec.w * dispW) + 'px'; box.style.height = (rec.h * dispH) + 'px';
    layer.appendChild(box);
    if (!redactWarned) { pendingBox = { rec: rec, el: box }; openRedactDialog(); return; }
    select(commitRedact(rec, box));
  }
  function edFocusables() {
    return Array.prototype.filter.call(ed.querySelectorAll('button, input, select, [tabindex], [contenteditable="true"]'), function (el) {
      return !el.disabled && el.tabIndex >= 0 && el.getClientRects().length;
    });
  }
  // Ctrl+Z undoes; Escape is STAGED (cancel a redact drag → end typing → deselect →
  // close); Delete removes the selection and arrows nudge it / change pages — gated on
  // "not typing", NOT on body focus (a clicked tool button keeps focus, and Delete/
  // arrows used to go dead in exactly that state)
  document.addEventListener('keydown', function (e) {
    if (ed.hidden) return;
    if (!redactDialog.hidden) { if (e.key === 'Escape') dialogCancel(); return; }   // core traps Tab in modals
    if (PT.modalOpen && PT.modalOpen()) return;
    var a = document.activeElement;
    var typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
    if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      if (typing || (PT.isBusy && PT.isBusy())) return;   // native undo inside inputs
      e.preventDefault(); PT.undo(); return;
    }
    if (e.key === 'Tab') {
      // keep focus inside the full-screen editor (it covers the whole page)
      var f = edFocusables(); if (!f.length) return;
      var fi = f.indexOf(a);
      if (e.shiftKey) { if (fi <= 0) { e.preventDefault(); f[f.length - 1].focus(); } }
      else if (fi === -1 || fi === f.length - 1) { e.preventDefault(); f[0].focus(); }
      return;
    }
    if (e.key === 'Escape') {
      if (activeRedactCancel) { activeRedactCancel(); return; }   // cancel the in-flight box only
      if (activeDragCancel) { activeDragCancel(); return; }       // abort an annotation drag/resize
      if (drawing) { abortPadStroke(); return; }                  // abort a sig-pad stroke
      if (typing) { a.blur(); return; }                           // end the edit, keep the editor open
      if (selected) { deselectAll(); selected = null; return; }
      close(); return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && a === stage) {
      // stage focused: create with the current tool at the page center
      if (tool === 'text') { e.preventDefault(); createTextAt(0.4, 0.44); }
      else if (tool === 'redact') { e.preventDefault(); keyboardRedact(); }
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !typing) { e.preventDefault(); removeAnno(selected); }
    else if (/^Arrow(Left|Right|Up|Down)$/.test(e.key) && !typing) {
      if (selected) { e.preventDefault(); nudgeSelected(e.key, e.shiftKey); }
      else if (e.key === 'ArrowLeft') { goPrev(); }
      else if (e.key === 'ArrowRight') { goNext(); }
    }
  });

  // transient in-editor notice: the main status line sits BEHIND the full-screen
  // editor, so feedback for editor-context events goes to the hint bar for a few
  // seconds, then the tool hint comes back
  var edNoticeTimer = 0;
  function edNotice(msg) {
    var prev = hint.textContent;
    hint.textContent = msg;
    clearTimeout(edNoticeTimer);
    edNoticeTimer = setTimeout(function () { if (hint.textContent === msg) hint.textContent = prev; }, 4000);
  }

  // files dropped while the editor is open: with the Sign tool active an image becomes
  // the pending signature (same path as the upload input). Return false = not consumed,
  // the core appends the files as pages instead.
  PT.onEditorDrop = function (files) {
    if (ed.hidden) return false;
    var f = files && files[0];
    if (tool === 'sign' && f && /^image\//.test(f.type || '')) { loadSigFile(f); return true; }
    return false;
  };
  // pages appended while the editor is open (a drop the Sign tool didn't claim):
  // refresh the label + nav arrows and say so INSIDE the editor
  PT.onPagesChanged = function () {
    if (ed.hidden) return;
    pageLabel.textContent = 'Page ' + (idx + 1) + ' of ' + PT.pages().length;
    updateNav();
    edNotice('Pages added at the end — use › or the arrow keys to reach them.');
  };

  // expose the opener for the thumbnail Edit buttons
  PT.openEditor = open;
})();
