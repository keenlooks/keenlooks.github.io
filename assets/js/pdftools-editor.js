/* Unified full-screen page editor for the PDF Toolbench. One page preview with tools:
   Move, Text (click to place, then format it: font/size/line spacing/alignment, and
   bold/italic/underline/strikethrough/color/highlight on a selection), Sign (draw/upload/
   saved + click where it goes), Redact (draw boxes — they commit IMMEDIATELY as page
   annotations; a one-time dialog explains that pages with boxes are flattened to images
   on download, which is when the covered content is actually removed), White-out (the
   same boxes painted WHITE: they cover, the page stays vector and the content under them
   stays in the file; a one-time dialog of its own says so). Inline form-field
   inputs (text, checkbox, dropdown, radio groups) are shown when the page has AcroForm
   widgets. All edits live on the page model (pg.texts / pg.sigs / pg.redacts / pg.raster)
   and on docs[i].formValues, so thumbnails and export pick them up, and every edit takes
   an undo snapshot (Ctrl+Z / the Undo buttons). Depends on window.__PT.

   A text box has TWO renders (spec 12.4): at rest it is a <canvas> painted by the shared
   PURE.paintTextBox, so the preview IS the export picture; while it is being edited it is
   a contenteditable flow of run <span>s. CSS cannot place an inline box by its alphabetic
   baseline and the browser-font baseline offset is family AND size dependent, which is why
   the resting picture is a canvas and not spans.
   External file → // comments fine. */
(function boot() {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var PT = window.__PT;
  // the core starts once the PDF engines have loaded (after the page): wait for it
  if (!PT) { if (!boot.waiting) { boot.waiting = true; window.addEventListener('pt-ready', function () { boot(); }, { once: true }); } return; }
  var ed = $('pt-ed'); if (!ed) return;
  var PURE = PT.PURE || window.__PT_PURE || {};

  var scrollEl = $('pt-ed-scroll'), stage = $('pt-ed-stage'), canvas = $('pt-ed-canvas'), layer = $('pt-ed-layer');
  // never let a native drag start inside the editor (a stray text selection, or the
  // signature <img>, would otherwise hijack annotation drags via pointercancel)
  ed.addEventListener('dragstart', function (e) { e.preventDefault(); });
  var hint = $('pt-ed-hint'), pageLabel = $('pt-ed-page');
  var textbar = $('pt-ed-textbar');
  var fontSel = $('pt-text-font'), sizeSel = $('pt-text-size'), colorInp = $('pt-text-color');
  var lhSel = $('pt-text-lh'), hlBtn = $('pt-text-hl'), hlColor = $('pt-text-hlcolor'), autoChk = $('pt-text-auto');

  // size dropdown options
  [8, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 60, 72].forEach(function (s) {
    var o = document.createElement('option'); o.value = s; o.textContent = s + ' pt'; if (s === 14) o.selected = true; sizeSel.appendChild(o);
  });

  var idx = -1, pg = null, tool = 'move';
  var lastOpenIdx = -1;                // the page whose thumb gets focus back on close
  var opener = null;                   // the control that opened the editor (focus returns to it)
  var dispW = 0, dispH = 0, Wpt = 0, Hpt = 0, scale = 1;
  var selected = null;                 // selected annotation element
  var focusedEl = null;                // the text box currently promoted to the editable flow
  var redactWarned = false;            // the one-time "how redaction works" dialog was acknowledged
  var whiteWarned = false;             // the one-time "white-out covers, it does not remove" dialog was acknowledged
  var pendingBox = null;               // { rec, el, kind } — first-ever box of a kind, held until its dialog is confirmed

  // metric-compatible browser stacks (spec 12.1 / s4): Arial, Times New Roman and Courier
  // New share advance widths with the standard 14, so the flow the user types into breaks
  // lines where the AFM law does. The old Georgia stack was 6 percent wider than Times.
  var FONT_STACKS = {
    Helvetica: 'Arial, "Liberation Sans", Helvetica, sans-serif',
    Times: '"Times New Roman", "Liberation Serif", Times, serif',
    Courier: '"Courier New", "Liberation Mono", Courier, monospace'
  };
  function fontFamily(f) { return FONT_STACKS[f] || FONT_STACKS.Helvetica; }
  function lhOf(t) { var v = +t.lh; return (isFinite(v) && v > 0) ? v : 1.2; }
  function alignOf(t) { return (t.align === 'center' || t.align === 'right') ? t.align : 'left'; }
  function isText(el) { return !!(el && el.classList && el.classList.contains('pt-anno--text')); }
  function isSig(el) { return !!(el && el.classList && el.classList.contains('pt-anno--sig')); }
  function clamp01(v) { return Math.min(1, Math.max(0, v)); }

  // ---------- the layout law (owned by pdftools.js, spec 12.1) ----------
  function metricsTable() { return (PT.metrics ? PT.metrics() : null) || null; }
  function layoutBox(el) {
    var t = el.__model, fn = PURE.layoutTextBox, tab = metricsTable();
    el.__layout = (fn && tab) ? fn(t, Wpt, Hpt, tab) : null;
    return el.__layout;
  }
  // the drag / nudge clamp used to read el.offsetWidth, which stopped meaning the ink
  // width the moment a box could carry its own width and its handles sat outside it
  function elBox(el) {
    if (isText(el)) {
      var t = el.__model, L = el.__layout;
      if (L) return { w: ((t.w != null ? t.w * Wpt : Math.max(L.boxW, 0.5 * t.size))) * scale, h: Math.max(L.boxH, t.size * lhOf(t)) * scale };
    }
    return { w: el.offsetWidth, h: el.offsetHeight };
  }

  // ---------- open / render ----------
  function open(i, keepTool) {
    if (PT.isBusy && PT.isBusy()) return;
    var pages = PT.pages(); if (i < 0 || i >= pages.length) return;
    demoteAll();                       // flush any live edit before the layer is rebuilt
    disarmSig();
    if (pg) PT.markDirty(pg);          // navigating away — that page's thumbnail may be stale
    idx = i; pg = pages[i]; selected = null; lastOpenIdx = i;
    var fresh = ed.hidden;
    if (ed.hidden) {                     // a fresh open measures the hint bar and the room afresh
      opener = document.activeElement && document.activeElement !== document.body && !ed.contains(document.activeElement) ? document.activeElement : null;
      hintMin = 0; hint.style.minHeight = '';
      barPad = 0; padB = 0; stage.style.marginTop = ''; stage.style.marginBottom = ''; scrollEl.scrollTop = 0;
    }
    // page navigation keeps the active tool (redacting a multi-page doc shouldn't snap
    // back to Move on every arrow); a fresh open from the grid starts on Move
    setTool(keepTool ? tool : 'move');
    ed.hidden = false;
    holdHint();
    renderPage();
    // the full-screen editor is a modal: focus goes INTO it (the page preview, whose label
    // says how to use it; arrow keys still change pages from there), never left on the
    // hidden button behind it
    if (fresh) { try { stage.focus({ preventScroll: true }); } catch (er) {} }
  }
  function close() {
    renderSeq++;                       // abandon any in-flight render (it must not touch a null pg)
    if (curTask) { try { curTask.cancel(); } catch (er) {} curTask = null; }
    demoteAll();                       // write the live edit back before the empty filter reads it
    disarmSig();
    if (pg) {
      // EVERY close path drops abandoned empty text boxes, not just the Done button —
      // an invisible {text:''} ghost would otherwise force a rotated page to flatten
      pg.texts = (pg.texts || []).filter(function (t) { return (t.text || '').trim().length; });
      PT.markDirty(pg);
    }
    ed.hidden = true; pg = null; idx = -1;
    // the page's text and a picked size end with the session; the select drops the pick it
    // shows (a size it shows from the last box edited stays: a new box takes it, review7 m3)
    if (pickedSize != null && sizeSel.value === String(pickedSize)) sizeSel.value = '14';
    textSlot = null; pickedSize = null;
    PT.renderGrid(); PT.updateToolbar();
    // hand focus back to what opened the editor when it is still there and usable (the
    // toolbar's Edit page button); else the fresh thumb of the page we were editing
    // (renderGrid rebuilt the nodes, so a thumb opener is gone), else the first thumb,
    // else the Download button
    var thumbs = document.querySelectorAll('#pt-grid .pt-thumb');
    var back = (opener && opener.isConnected && !opener.disabled && opener.offsetParent !== null) ? opener
      : (lastOpenIdx >= 0 && lastOpenIdx < thumbs.length) ? thumbs[lastOpenIdx]
      : (thumbs.length ? thumbs[0] : $('pt-download'));
    opener = null;
    if (back) { try { back.focus(); } catch (er) {} }
  }

  // annotations (text/sig) are drawn with rotation-0 math at export, so a page with any
  // effective rotation must be flattened upright first (same as redact already does).
  // Snapshotted so Ctrl+Z can undo the flatten.
  function ensureUpright() {
    return PT.pageEffRotation(pg).then(function (r) {
      if (r === 0) return false;
      if (PT.snapshot) PT.snapshot('flatten page ' + (idx + 1) + ' upright');
      var mySnap = PT.snapSeq ? PT.snapSeq() : -1;
      var carry = (textSlot && textSlot.pg === pg && textSlot.key === textKey(pg)) ? textSlot : null, myPg = pg;
      // the frame (rotation of the source page) the flatten rasterizes into: a live page's
      // effective rotation, or a raster page's own frame turned by its grid rotation
      var frame = pg.raster ? (pg.raster.frame != null ? (pg.raster.frame + r) % 360 : null) : r;
      return PT.bakePageToRaster(pg, 150).then(null, function (e) {
        // the flatten failed, so its snapshot covers nothing — drop it, but only while
        // it is still top-of-stack (the usual ledger guard)
        if (mySnap >= 0 && PT.snapSeq && PT.snapSeq() === mySnap && PT.dropSnapshot) PT.dropSnapshot();
        throw e;
      }).then(function () {
        // the page's text, read in the frame the flatten has just rasterized, stays its text;
        // the frame goes on the raster itself, so an undo clone or a later visit re-reads it
        if (myPg === pg && pg.raster && frame != null) pg.raster.frame = frame;
        if (carry && textSlot === carry && myPg === pg) carry.key = textKey(pg);
        return renderPage();
      }).then(function () { return true; });
    });
  }

  var renderSeq = 0;   // fast arrow-key navigation: only the LATEST render may append elements
  var curTask = null;  // in-flight pdf.js render task — a superseding render (or close) cancels it
  function renderPage() {
    demoteAll();               // a live edit (ensureUpright re-renders under one) is written back first
    layer.innerHTML = '';
    focusedEl = null; sigGhost = null;
    var mySeq = ++renderSeq;
    if (curTask) { try { curTask.cancel(); } catch (er) {} curTask = null; }
    var edW = scrollEl.clientWidth || 800;
    // reserve the side page-nav arrow gutters (46px arrows at 12px from each edge) so an
    // enabled arrow never overlaps a wide page; below ~640px the arrows are hidden in CSS
    var avW = edW - 32 - (edW >= 620 ? 120 : 0), avH = (scrollEl.clientHeight || 600) + dockH() - 32;
    // the text painters need the AFM width table; it is built once at page init
    return Promise.resolve(PT.metricsReady).catch(function () { return null; }).then(function () {
      return PT.effPointSize(pg);
    }).then(function (sz) {
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
      // watermarks + page numbers are NOT painted into the page canvas any more: they go
      // on their own canvas above the white-out and redaction boxes (addMarksLayer)
      stage.style.width = dispW + 'px'; stage.style.height = dispH + 'px';
      layer.style.width = dispW + 'px'; layer.style.height = dispH + 'px';
      pageLabel.textContent = 'Page ' + (idx + 1) + ' of ' + PT.pages().length;
      buildAnnoEls();
      addMarksLayer();
      addFormWidgets();
      updateNav();
      warmText(pg);                      // a white-out tap then finds the page's text here
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
  // the text bar is shown whenever the Text tool is on OR a text box is selected (a box
  // can be edited in Move and Sign too, ruling 12.6). It FLOATS over the top of the page
  // area (absolute, out of the flow: the md), so showing it never re-measures or moves the
  // page: a box drawn a moment ago stays exactly where the pointer left it when the user
  // switches to Text (White-out ruling 5), and the page keeps its full size in every other
  // tool. So that the bar never hides the page's first lines for good, the page gets the
  // bar's height of room above it (a top margin) while the scroll moves by the same amount
  // (keepStage). Returns true when the in-flow Sign bar changed height, so the caller can
  // re-measure the stage (renderPage sizes the canvas from scrollEl.clientHeight).
  var barPad = 0, padB = 0;
  function syncBars() {
    var showText = (tool === 'text') || (selected && isText(selected)) || !!focusedEl;
    var vis = !ed.hidden;
    var top0 = vis ? stage.getBoundingClientRect().top : 0;
    var signbar = $('pt-ed-signbar'), sign0 = signbar.offsetHeight;
    textbar.hidden = !showText;
    $('pt-redact-opts').hidden = tool !== 'redact';
    signbar.hidden = tool !== 'sign';
    var changed = signbar.offsetHeight !== sign0;
    if (showText) placeTextbar();
    var want = (showText && vis && !docked()) ? textbar.offsetHeight : 0;
    if (want !== barPad) { barPad = want; stage.style.marginTop = barPad ? barPad + 'px' : ''; }
    if (vis && !changed) keepStage(top0);
    // the Sign bar re-lays the page out (the caller re-renders): start that from the top
    if (changed) { padB = 0; stage.style.marginBottom = ''; scrollEl.scrollTop = 0; }
    if (!barPad && padB && scrollEl.scrollTop === 0) { padB = 0; stage.style.marginBottom = ''; }
    return changed;
  }
  // the floating bar sits on the top edge of the page area, wherever the bars above it end
  function placeTextbar() { textbar.style.top = scrollEl.offsetTop + 'px'; }
  // on a phone (a coarse pointer, or the narrow layout: the md) the bar is DOCKED in the
  // flow below the page area instead: no room above the page, nothing over it. The page
  // keeps its size (renderPage counts the docked bar's height back in) and its place (the
  // area only gets shorter at the bottom; keepStage covers the bar closing again).
  function docked() { return getComputedStyle(textbar).position === 'static'; }
  function dockH() { return (!textbar.hidden && docked()) ? textbar.offsetHeight : 0; }
  // a resize or a turn can cross the phone layout or re-wrap the bar: measure it again
  window.addEventListener('resize', function () { if (!ed.hidden && !textbar.hidden) { placeTextbar(); syncBars(); } });
  // scroll by however far the stage moved, so it keeps its screen position; if the page is
  // too short to scroll that far, add room below it first (measured from the content's own
  // bottom edge: while the page is shorter than the area, scrollHeight is just the area)
  function keepStage(top0) {
    var d = stage.getBoundingClientRect().top - top0;
    if (!d) return;
    var sr = scrollEl.getBoundingClientRect(), r = stage.getBoundingClientRect();
    var content = r.bottom - sr.top + scrollEl.scrollTop + padB + (parseFloat(getComputedStyle(scrollEl).paddingBottom) || 0);
    var need = scrollEl.scrollTop + d + scrollEl.clientHeight - content;
    if (need > 0) { padB += Math.ceil(need); stage.style.marginBottom = padB + 'px'; }
    scrollEl.scrollTop += d;
  }
  function setTool(t) {
    tool = t; selected = null; deselectAll(); disarmSig();
    ['move', 'text', 'sign', 'redact', 'whiteout'].forEach(function (k) {
      var b = $('pt-tool-' + k);
      b.classList.toggle('pt-tool--on', k === t);
      b.setAttribute('aria-pressed', k === t ? 'true' : 'false');
    });
    var changed = syncBars();
    if (t === 'sign') renderSavedSigs();
    stage.classList.toggle('pt-stage--text', t === 'text');
    stage.classList.toggle('pt-stage--redact', t === 'redact');
    stage.classList.toggle('pt-stage--whiteout', t === 'whiteout');
    stage.classList.toggle('pt-stage--pan', t === 'move' || t === 'text');   // one finger may scroll (the md)
    if (t === 'text' && pg) warmText(pg);
    // a finger has no Escape, arrow keys or Ctrl+Z: on a coarse pointer the hints say tap
    // and name the Undo and Done buttons (the desktop strings are unchanged)
    if (changed) { hintMin = 0; hint.style.minHeight = ''; }   // the page is re-measured anyway (Sign)
    else noteHint();
    var touch = coarse();
    hint.textContent = t === 'text' ? (touch ? 'Tap anywhere on the page to add text. Tap a text box to edit it; drag its grip to move it. Tap Done when you are finished.'
        : 'Click anywhere on the page to add text. Click a text box to edit it; drag its grip to move it. Press Escape to stop typing, then the arrow keys nudge the box.')
      : t === 'sign' ? (touch ? 'Draw or upload a signature, tap Place, then tap where it goes on the page. Drag it later to adjust. Saved signatures stay in this browser only.'
        : 'Draw or upload a signature, click Place, then click where it goes on the page. Drag it later to adjust. Saved signatures stay in this browser only.')
      : t === 'redact' ? (touch ? 'Drag boxes over anything to remove. Each box is kept and shown as soon as you draw it, so you can move it, tap it for its ×, or tap Undo. On download the page is flattened to an image, which is what actually removes the covered text.'
        : 'Drag boxes over anything to remove. Each box is kept and shown as soon as you draw it, so you can move it, click it for its ×, or press Ctrl+Z. On download the page is flattened to an image, which is what actually removes the covered text.')
      : t === 'whiteout' ? (touch ? 'Drag a box over anything to cover it with white. A white-out only covers: what is under it stays in the file (Redact removes it). Tap a box for its ×, or tap Undo. To type a correction on top, switch to Text and tap the box.'
        : 'Drag a box over anything to cover it with white. A white-out only covers: what is under it stays in the file (Redact removes it). Click a box for its ×, or press Ctrl+Z. To type a correction on top, switch to Text and click the box.')
      : (touch ? 'Tap a text box to edit its words; drag its grip to move it. Tap a signature, redaction or white-out to move or delete it. Use ‹ › to change pages, and tap Done when you are finished.'
        : 'Click a text box to edit its words; drag its grip to move it. Click a signature, redaction or white-out to move or delete it. Use ‹ › or the arrow keys to change pages.');
    holdHint();
    syncTextBar();
    return changed;
  }
  // the hint bar sits under the page: if a shorter hint let it shrink, the scroll area
  // would grow and a page scrolled even 1 px would be clamped down, moving the box the
  // user just drew (White-out ruling 5). So it only ever grows while the editor is open;
  // open() starts it afresh.
  var hintMin = 0;
  function noteHint() { if (!ed.hidden) hintMin = Math.max(hintMin, hint.getBoundingClientRect().height); }   // before the text changes
  function holdHint() {                                                                   // after it changed
    if (ed.hidden) return;
    hint.style.minHeight = hintMin ? hintMin + 'px' : '';
    var hh = hint.getBoundingClientRect().height;
    if (hh > hintMin) { hintMin = hh; hint.style.minHeight = hintMin + 'px'; }
  }
  ['move', 'text', 'sign', 'redact', 'whiteout'].forEach(function (k) {
    $('pt-tool-' + k).addEventListener('click', function () { if (setTool(k) && pg && !ed.hidden) renderPage(); });
  });

  // ---------- annotation elements ----------
  function deselectAll(keep) {
    demoteAll(keep);
    Array.prototype.forEach.call(layer.querySelectorAll('.pt-sel'), function (e) { e.classList.remove('pt-sel'); });
    removeHandles();
  }
  function removeHandles() {
    Array.prototype.forEach.call(layer.querySelectorAll('.pt-anno__del,.pt-anno__resize,.pt-anno__grip,.pt-anno__he,.pt-anno__hw,.pt-anno__hse'), function (e) { e.remove(); });
  }
  // every handle keeps focus where it is (a mousedown whose default runs would focus the
  // tabindex=0 wrapper and blur the flow, which for a still-empty box deletes it) — the
  // Undo button's pointerdown+mousedown pair is the precedent
  function noFocusSteal(el) {
    ['pointerdown', 'mousedown'].forEach(function (ev) { el.addEventListener(ev, function (e) { e.preventDefault(); }); });
  }
  function select(el) {
    deselectAll(el); selected = el; if (!el) { syncBars(); syncTextBar(); return; }
    el.classList.add('pt-sel');
    el.__nudged = false;   // re-arm the one-snapshot-per-selection arrow-key nudge
    var del = document.createElement('button'); del.className = 'pt-anno__del'; del.type = 'button'; del.textContent = '×';
    del.title = 'Delete'; del.setAttribute('aria-label', 'Delete this item');
    // a touch tap that CREATES a box makes the browser synthesize a post-tap click at
    // the tap point — where this × has just appeared — instantly deleting the new box.
    // Only honor a click the × itself was armed for by its own pointerdown; keyboard
    // activation (Enter/Space) has e.detail === 0 and no pointerdown, so it stays allowed.
    var armedDel = false;
    del.addEventListener('pointerdown', function (e) { e.stopPropagation(); e.preventDefault(); armedDel = true; });
    del.addEventListener('mousedown', function (e) { e.preventDefault(); });
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!armedDel && e.detail !== 0) return;
      armedDel = false;
      removeAnno(el);
    });
    el.appendChild(del);
    if (isSig(el)) {
      var rz = document.createElement('span'); rz.className = 'pt-anno__resize';
      noFocusSteal(rz);
      rz.addEventListener('pointerdown', function (e) {
        if (e.button != null && e.button !== 0) return;   // left button / touch only
        startResize(e, el);
      });
      el.appendChild(rz);
    }
    if (isText(el) && tool !== 'redact') buildTextHandles(el);
    placeBadge(el);
    syncBars(); syncTextBar();
  }
  // the x badge sits OUTSIDE the box now (padding-right would re-wrap a box that carries
  // its own width). Two placement rules: flip it to the left when the box's right edge is
  // near the stage edge, and lift it clear of the width handles on a short box.
  function placeBadge(el) {
    var del = el.querySelector('.pt-anno__del'); if (!del) return;
    var b = elBox(el), t = el.__model;
    var rightPx = (isText(el) ? t.x * dispW : el.offsetLeft) + b.w;
    del.classList.toggle('pt-anno__del--left', rightPx > dispW - 20);
    if (isText(el)) del.classList.toggle('pt-anno__del--high', b.h < (coarse() ? 56 : 40));
  }
  function coarse() { try { return window.matchMedia('(pointer: coarse)').matches; } catch (er) { return false; } }
  function gripLift() { return coarse() ? 34 : 22; }
  // n19: the grid tip above the thumbnails says "Double-tap" under a coarse pointer
  // (the static HTML says "Double-click", which is what a mouse visitor sees)
  var gridTip = $('pt-tip');
  if (gridTip && coarse()) gridTip.textContent = gridTip.textContent.replace(/^Double-click\b/, 'Double-tap');
  function buildTextHandles(el) {
    var t = el.__model;
    var grip = document.createElement('span'); grip.className = 'pt-anno__grip';
    grip.title = 'Move this text box'; grip.setAttribute('aria-hidden', 'true');
    // a grip drawn above a box near the top of the page lands off the stage, under the
    // bar. The grip sits 14px above the box (30px on a coarse pointer, where it is bigger).
    if (t.y * dispH < gripLift()) grip.classList.add('pt-anno__grip--below');
    noFocusSteal(grip);
    grip.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      e.stopPropagation(); select(el); startDrag(e, el, t);
    });
    el.appendChild(grip);
    ['he', 'hw'].forEach(function (side) {
      var h = document.createElement('span'); h.className = 'pt-anno__' + side;
      h.title = side === 'he' ? 'Drag to set the text width' : 'Drag to set the text width';
      h.setAttribute('aria-hidden', 'true');
      noFocusSteal(h);
      h.addEventListener('pointerdown', function (e) {
        if (e.button != null && e.button !== 0) return;
        e.stopPropagation(); startWidthDrag(e, el, side === 'he' ? 'e' : 'w');
      });
      el.appendChild(h);
    });
    var se = document.createElement('span'); se.className = 'pt-anno__hse';
    se.title = 'Drag to change the text size'; se.setAttribute('aria-hidden', 'true');
    noFocusSteal(se);
    se.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      e.stopPropagation(); startSizeDrag(e, el);
    });
    el.appendChild(se);
  }
  function annoKind(el) {
    return el.classList.contains('pt-anno--sig') ? 'signature'
      : el.classList.contains('pt-anno--redact') ? 'redaction'
      : el.classList.contains('pt-anno--whiteout') ? 'white-out' : 'text';
  }
  function removeAnno(el, skipSnap) {
    var m = el.__model, kind = annoKind(el);
    if (focusedEl === el) focusedEl = null;
    if (!pg) { el.remove(); if (selected === el) selected = null; return; }   // a late blur can land after close()
    if (m) {
      var arr = kind === 'signature' ? pg.sigs : kind === 'redaction' ? pg.redacts
        : kind === 'white-out' ? pg.whiteouts : pg.texts;
      var k = (arr || []).indexOf(m);
      if (k >= 0) {
        if (!skipSnap && PT.snapshot) PT.snapshot('remove ' + kind + ' on page ' + (idx + 1));
        arr.splice(k, 1);
      }
    }
    el.remove();
    if (selected === el) { selected = null; syncBars(); syncTextBar(); }   // never clobber a selection this el doesn't own
    PT.markDirty(pg);
    if (kind === 'redaction' && !(pg.redacts || []).length)
      PT.setStatus('All redactions removed from this page. It keeps its original quality on download.');
  }

  // watermarks and page numbers on their own canvas, z-index 1 and AFTER the box
  // elements in the layer: above the white-outs (0) and the redactions (1, earlier in the
  // layer), under text (2) and signatures (3). That is the order the thumbnails and the
  // download use (white-outs, redactions, marks, texts, signatures). A page without marks
  // gets no canvas. New boxes are inserted BEFORE it (addBoxEl).
  function addMarksLayer() {
    if (!PT.drawMarks || !((pg.wms && pg.wms.length) || (PT.getPageNums && PT.getPageNums()))) return;
    var mc = document.createElement('canvas'); mc.className = 'pt-ed__marks';
    mc.width = dispW; mc.height = dispH;
    PT.drawMarks(mc.getContext('2d'), pg, dispW, dispH, Wpt, Hpt, idx);
    layer.appendChild(mc);
  }
  function addBoxEl(el) {
    var mk = layer.querySelector('.pt-ed__marks');
    if (mk) layer.insertBefore(el, mk); else layer.appendChild(el);
  }

  function buildAnnoEls() {
    (pg.whiteouts || []).forEach(function (r) { layer.appendChild(makeRedactEl(r, 'whiteout')); });
    (pg.redacts || []).forEach(function (r) { layer.appendChild(makeRedactEl(r)); });
    (pg.texts || []).forEach(function (t) { layer.appendChild(makeTextEl(t)); });
    (pg.sigs || []).forEach(function (s) { layer.appendChild(makeSigEl(s)); });
  }

  /* ==================================================================================
     Text boxes: the run model, the two renders, and the editing flow
     ================================================================================== */

  function mkRun(text, st) {
    st = st || {};
    return { t: text, b: !!st.b, i: !!st.i, u: !!st.u, s: !!st.s, hl: st.hl || null, c: st.c || null };
  }
  function runsOf(t) {
    if (t.runs && t.runs.length) return t.runs;
    return [mkRun(t.text || '', null)];
  }
  function sameStyle(a, b) {
    return !!a.b === !!b.b && !!a.i === !!b.i && !!a.u === !!b.u && !!a.s === !!b.s
      && (a.hl || null) === (b.hl || null) && (a.c || null) === (b.c || null);
  }
  function plainRuns(runs) {
    return (runs || []).every(function (r) { return !r.b && !r.i && !r.u && !r.s && !r.hl && !r.c; });
  }
  function mergeRuns(runs) {
    if (PURE.mergeRuns) return PURE.mergeRuns(runs);
    var out = [];
    (runs || []).forEach(function (r) {
      if (!r.t) return;
      var last = out[out.length - 1];
      if (last && sameStyle(last, r)) last.t += r.t;
      else out.push(mkRun(r.t, r));
    });
    return out;
  }
  // ONE content writer (spec 12.2): PURE.setBoxContent merges adjacent identical runs,
  // writes t.runs (null when nothing carries style, so the box keeps the legacy export
  // path), then sets t.text to the runs joined. No other code assigns t.text, and
  // innerText is never read.
  function writeContent(t, runs) {
    if (PURE.setBoxContent) { PURE.setBoxContent(t, runs); return; }
    var merged = mergeRuns(runs);                       // boot guard only
    t.runs = plainRuns(merged) ? null : merged;
    t.text = merged.map(function (r) { return r.t; }).join('');
  }
  // normalise every content entry point the way pdf-lib's own cleanText does: the metrics
  // table cannot measure a tab, and a CRLF would become two model lines
  function normText(s) { return String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/\t/g, '    '); }

  // ---- run range operations (runs are immutable: every change makes new objects) ----
  function splitAt(runs, offsets) {
    var cuts = {}; offsets.forEach(function (o) { cuts[o] = 1; });
    var out = [], pos = 0;
    runs.forEach(function (r) {
      var start = pos, end = pos + r.t.length, marks = [start];
      Object.keys(cuts).forEach(function (k) { var o = +k; if (o > start && o < end) marks.push(o); });
      marks.sort(function (a, b) { return a - b; });
      marks.push(end);
      for (var i = 0; i < marks.length - 1; i++) if (marks[i + 1] > marks[i]) out.push(mkRun(r.t.slice(marks[i] - start, marks[i + 1] - start), r));
      pos = end;
    });
    return out;
  }
  function mapRange(runs, start, end, fn) {
    var parts = splitAt(runs, [start, end]), pos = 0;
    return parts.map(function (r) {
      var s = pos, e = pos + r.t.length; pos = e;
      if (s >= start && e <= end && e > s) { var st = fn(r); return mkRun(r.t, st); }
      return r;
    });
  }
  function rangeFragments(runs, start, end) {
    var parts = splitAt(runs, [start, end]), pos = 0, out = [];
    parts.forEach(function (r) {
      var s = pos, e = pos + r.t.length; pos = e;
      if (s >= start && e <= end && e > s) out.push(r);
    });
    return out;
  }
  function styleAtOffset(t, off, aff) {
    var runs = runsOf(t), pos = 0, last = runs[0] || mkRun('', null);
    for (var i = 0; i < runs.length; i++) {
      var s = pos, e = pos + runs[i].t.length; pos = e;
      if (aff === 'after' ? (off > s && off <= e) : (off >= s && off < e)) return runs[i];
      if (off >= e) last = runs[i];
    }
    return last;
  }

  // ---- canonical DOM for the focused flow ----
  function applyRunStyle(sp, r) {
    if (r.b) { sp.dataset.b = '1'; sp.style.fontWeight = 'bold'; }
    if (r.i) { sp.dataset.i = '1'; sp.style.fontStyle = 'italic'; }
    if (r.u) sp.dataset.u = '1';
    if (r.s) sp.dataset.s = '1';
    if (r.u || r.s) sp.style.textDecoration = (r.u ? 'underline' : '') + (r.u && r.s ? ' ' : '') + (r.s ? 'line-through' : '');
    if (r.hl) { sp.dataset.hl = r.hl; sp.style.backgroundColor = r.hl; }
    if (r.c) { sp.dataset.c = r.c; sp.style.color = r.c; }
  }
  function buildRunNodes(host, runs) {
    host.textContent = '';
    var joined = '';
    (runs || []).forEach(function (r) {
      if (!r.t) return;
      joined += r.t;
      var sp = document.createElement('span');
      applyRunStyle(sp, r);
      sp.appendChild(document.createTextNode(r.t));
      host.appendChild(sp);
    });
    // a trailing newline has no line box of its own in white-space: pre, so the caret
    // could not reach the empty last line; this filler is skipped by the parser
    if (/\n$/.test(joined)) { var br = document.createElement('br'); br.setAttribute('data-fill', '1'); host.appendChild(br); }
  }
  var canonScratch = null;
  function canonicalHtml(runs) {
    if (!canonScratch) canonScratch = document.createElement('div');
    buildRunNodes(canonScratch, runs);
    return canonScratch.innerHTML;
  }
  // Chrome keeps a bare trailing <br> in an editing host to make the last line reachable;
  // that is not drift
  function sameHtml(live, canon) { return live === canon || live === canon + '<br>'; }

  // ---- parsing the flow back to runs (walk text nodes; innerText is never read) ----
  function deepLast(n) { while (n && n.lastChild) n = n.lastChild; return n; }
  function isBlockEl(el) { return /^(DIV|P|LI|H[1-6]|BLOCKQUOTE|PRE)$/.test(el.tagName); }
  function hexOf(v) {
    if (!v) return null;
    var s = String(v).trim();
    var m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) return '#' + m[1][0] + m[1][0] + m[1][1] + m[1][1] + m[1][2] + m[1][2];
    if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
    m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
    if (m) return '#' + [1, 2, 3].map(function (k) { var h = (+m[k]).toString(16); return h.length < 2 ? '0' + h : h; }).join('');
    return null;
  }
  // browser-inserted <b>/<i>/<u>/<s>/<font>/style is UNTRUSTED input to normalise, never state
  function styleAttrs(el) {
    var st = {}, d = el.dataset || {}, tn = el.tagName, s = el.style;
    if (d.b === '1' || tn === 'B' || tn === 'STRONG') st.b = true;
    if (d.i === '1' || tn === 'I' || tn === 'EM') st.i = true;
    if (d.u === '1' || tn === 'U') st.u = true;
    if (d.s === '1' || tn === 'S' || tn === 'STRIKE' || tn === 'DEL') st.s = true;
    if (s) {
      if (s.fontWeight === 'bold' || parseInt(s.fontWeight, 10) >= 600) st.b = true;
      if (s.fontStyle === 'italic' || s.fontStyle === 'oblique') st.i = true;
      var dec = (s.textDecorationLine || s.textDecoration || '');
      if (/underline/.test(dec)) st.u = true;
      if (/line-through/.test(dec)) st.s = true;
    }
    if (d.hl) st.hl = hexOf(d.hl);
    if (d.c) st.c = hexOf(d.c);
    else if (tn === 'FONT' && el.getAttribute('color')) st.c = hexOf(el.getAttribute('color'));
    return st;
  }
  function mergeStyle(a, b) {
    var o = { b: a.b || b.b, i: a.i || b.i, u: a.u || b.u, s: a.s || b.s, hl: b.hl || a.hl || null, c: b.c || a.c || null };
    return o;
  }
  // pieces: the flow flattened to {node, text, st, off} in document order, where node is
  // the text node the characters came from (null for a synthesized newline)
  function walkFlow(root) {
    var pieces = [], pos = 0, last = deepLast(root);
    function emit(node, text, st) { if (!text) return; pieces.push({ node: node, text: text, st: st, off: pos }); pos += text.length; }
    function rec(n, st) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) emit(c, normText(c.nodeValue), st);
        else if (c.nodeType === 1) {
          if (c.tagName === 'BR') {
            if (c.getAttribute('data-fill') !== '1' && c !== last) emit(null, '\n', st);
            continue;
          }
          var st2 = mergeStyle(st, styleAttrs(c));
          if (isBlockEl(c) && pos > 0) emit(null, '\n', st2);
          rec(c, st2);
        }
      }
    }
    rec(root, {});
    return { pieces: pieces, len: pos };
  }
  function piecesToRuns(pieces) {
    return mergeRuns(pieces.map(function (p) { return mkRun(p.text, p.st); }));
  }

  // ---- caret and selection, in character offsets ----
  function offsetOf(w, node, off) {
    for (var i = 0; i < w.pieces.length; i++) {
      var p = w.pieces[i];
      if (p.node === node) return p.off + normText(node.nodeValue.slice(0, off)).length;
    }
    return null;
  }
  function selState(txt) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var r = sel.getRangeAt(0);
    if (!txt.contains(r.startContainer) || !txt.contains(r.endContainer)) return null;
    var w = walkFlow(txt);
    var a = r.startContainer.nodeType === 3 ? offsetOf(w, r.startContainer, r.startOffset) : boundaryOffset(w, r.startContainer, r.startOffset);
    var b = r.endContainer.nodeType === 3 ? offsetOf(w, r.endContainer, r.endOffset) : boundaryOffset(w, r.endContainer, r.endOffset);
    if (a == null || b == null) return null;
    return { start: Math.min(a, b), end: Math.max(a, b), aff: (a > 0 ? 'after' : 'before'), len: w.len };
  }
  // a caret sitting on an ELEMENT boundary (Chrome parks it there after a rewrite): count
  // the characters in the children before it
  function boundaryOffset(w, el, off) {
    var kids = el.childNodes, n = 0;
    for (var i = 0; i < Math.min(off, kids.length); i++) n += textLenOf(w, kids[i]);
    var before = 0;
    for (var j = 0; j < w.pieces.length; j++) {
      var p = w.pieces[j];
      if (p.node && el.contains(p.node)) { before = p.off; break; }
    }
    return before + n;
  }
  function textLenOf(w, node) {
    var n = 0;
    w.pieces.forEach(function (p) { if (p.node && (p.node === node || (node.contains && node.contains(p.node)))) n += p.text.length; });
    return n;
  }
  function domPos(txt, off, aff) {
    var w = walkFlow(txt), pieces = w.pieces.filter(function (p) { return p.node; });
    if (!pieces.length) return { node: txt, off: 0 };
    for (var i = 0; i < pieces.length; i++) {
      var p = pieces[i], s = p.off, e = p.off + p.text.length;
      var hit = (aff === 'after') ? (off > s && off <= e) : (off >= s && off < e);
      if (hit) return { node: p.node, off: Math.max(0, Math.min(p.node.nodeValue.length, off - s)) };
    }
    var lastP = pieces[pieces.length - 1];
    if (off <= pieces[0].off) return { node: pieces[0].node, off: 0 };
    return { node: lastP.node, off: lastP.node.nodeValue.length };
  }
  function setSelRange(txt, start, end, aff) {
    var sel = window.getSelection(); if (!sel) return;
    var a = domPos(txt, start, start > 0 ? (aff || 'after') : 'before');
    var b = (end === start) ? a : domPos(txt, end, 'after');
    try {
      var r = document.createRange();
      r.setStart(a.node, a.off); r.setEnd(b.node, b.off);
      sel.removeAllRanges(); sel.addRange(r);
    } catch (er) {}
  }

  // ---- the resting render: one canvas, painted by the shared painter ----
  function lawReady() { return !!(PURE.layoutTextBox && PURE.paintTextBox && metricsTable()); }
  // boot guard, NOT a second layout law: if the two zones land out of order on the dev
  // server the box still shows its text (today's plain preview) instead of vanishing
  function staticFallback(el) {
    var t = el.__model, d = el.__cv;
    if (d && d.tagName !== 'DIV') { d.remove(); d = null; }
    if (!d) { d = document.createElement('div'); d.className = 'pt-anno__txt pt-anno__txt--static'; el.appendChild(d); el.__cv = d; }
    d.style.fontSize = (t.size * scale) + 'px'; d.style.fontFamily = fontFamily(t.font);
    d.style.color = t.color || '#111'; d.style.lineHeight = String(lhOf(t));
    d.textContent = t.text || '';
    d.hidden = false;
    el.style.width = ''; el.style.height = '';
    placeBadge(el);
    return null;
  }
  function restingRender(el) {
    if (!lawReady()) return staticFallback(el);
    var t = el.__model, L = layoutBox(el);
    var cv = el.__cv;
    if (cv && cv.tagName !== 'CANVAS') { cv.remove(); cv = el.__cv = null; }
    if (!cv) { cv = el.__cv = document.createElement('canvas'); cv.className = 'pt-anno__cv'; el.appendChild(cv); }
    var lh = lhOf(t), inkR = 0, inkB = 0;
    if (L) {
      L.lines.forEach(function (ln) {
        (ln.runs || []).forEach(function (r) { inkR = Math.max(inkR, r.x + r.w); });
        inkB = Math.max(inkB, ln.baseline + 0.25 * t.size);
      });
    }
    var boxWpt = L ? (t.w != null ? t.w * Wpt : Math.max(L.boxW, 0.5 * t.size)) : 0.5 * t.size;
    var boxHpt = L ? Math.max(L.boxH, t.size * lh) : t.size * lh;
    var cwPt = Math.max(boxWpt, inkR), chPt = Math.max(boxHpt, inkB);
    var wPx = Math.max(1, cwPt * scale), hPx = Math.max(1, chPt * scale);
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.max(1, Math.round(wPx * dpr)); cv.height = Math.max(1, Math.round(hPx * dpr));
    cv.style.width = wPx + 'px'; cv.style.height = hPx + 'px';
    var cx = cv.getContext('2d');
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.clearRect(0, 0, wPx, hPx);
    if (L && PURE.paintTextBox) { cx.save(); try { PURE.paintTextBox(cx, t, L, scale); } catch (er) {} cx.restore(); }
    el.style.width = (boxWpt * scale) + 'px';
    el.style.height = (boxHpt * scale) + 'px';
    cv.hidden = false;
    placeBadge(el);
    return L;
  }

  // ---- the focused flow ----
  var composing = false;              // an IME composition owns the DOM: touch nothing
  var pendingStyle = null;            // collapsed-caret style the next characters carry
  var pendingAt = -1;
  function clearPending() { pendingStyle = null; pendingAt = -1; syncTextBar(); }

  function styleFlow(txt, t) {
    var lh = lhOf(t);
    txt.style.fontSize = (t.size * scale) + 'px';
    txt.style.fontFamily = fontFamily(t.font);
    txt.style.color = t.color || '#111';
    txt.style.lineHeight = String(lh);
    // a CSS line box puts the first baseline at half-leading + ascent while the export
    // draws it at 0.82em; half-leading is (lh - 1)/2 em, so the correction moves with lh
    txt.style.marginTop = (-0.13 - (lh - 1.2) / 2).toFixed(4) + 'em';
    txt.style.textAlign = alignOf(t);
    if (t.w != null) { txt.style.whiteSpace = 'pre-wrap'; txt.style.width = (t.w * dispW) + 'px'; }
    else { txt.style.whiteSpace = 'pre'; txt.style.width = ''; }
  }
  function renderFlow(el) {
    var txt = el.__txt, t = el.__model;
    buildRunNodes(txt, runsOf(t));
  }
  function flushFlow(el) {
    var txt = el.__txt, t = el.__model;
    if (!txt || !pg || !txt.isConnected || composing) return null;
    var w = walkFlow(txt);
    writeContent(t, piecesToRuns(w.pieces));
    return w;
  }
  function onFlowInput(el) {
    var txt = el.__txt, t = el.__model;
    // a browser NATIVE undo can replay edits into this node after the editor closed
    // (pg null) or the layer was rebuilt (node detached) — never sync those to the model
    if (!pg || !txt || !txt.isConnected || composing) return;
    if (el.__armed) { el.__armed = false; if (PT.snapshot) PT.snapshot('edit text on page ' + (idx + 1)); }
    var st = selState(txt);
    flushFlow(el);
    var canon = canonicalHtml(runsOf(t));
    // skip the rewrite when the DOM is already canonical: an unrestored rewrite parks the
    // caret on the host at offset 0 and the next keystroke lands at the start
    if (!sameHtml(txt.innerHTML, canon)) {
      renderFlow(el);
      if (st) setSelRange(txt, st.start, st.end, st.aff);
    }
    PT.markDirty(pg);
    syncTextBar();
    noteDropped(el);
  }

  // The text tool draws with the twelve fonts built into PDF, which cover English and
  // Western European letters only (WinAnsi): any other character is left out of the
  // resting box and the file. Say so the moment such a character is typed or pasted,
  // naming the characters, rather than only after the download.
  function droppedChars(s) {
    var out = [], seen = {};
    Array.from(String(s || '')).forEach(function (ch) {
      if (ch === '\n' || seen[ch] || (PURE.winAnsiOk ? PURE.winAnsiOk(ch) : true)) return;
      seen[ch] = 1; out.push(ch);
    });
    return out;
  }
  function noteDropped(el) {
    var d = droppedChars(el && el.__model && el.__model.text), key = d.join('');
    if (key === (el.__dropKey || '')) return;
    el.__dropKey = key;
    if (!d.length) return;
    edNotice('These characters can’t be saved and will be left out: ' + d.slice(0, 12).join(' ') + (d.length > 12 ? ' …' : '') +
      '. Text boxes use the fonts built into PDF, which cover English and Western European letters only.', 9000);
  }

  // now: focus at once as well, inside the gesture that made the box (the caller has made
  // that safe: a white-out tap's pointerdown is preventDefaulted, so no compat mousedown
  // moves the focus afterwards); the timer below still runs as before
  function promote(el, caretOff, now) {
    if (!el || !isText(el)) return;
    if (focusedEl && focusedEl !== el) demote(focusedEl);
    var t = el.__model;
    if (el.__txt) { focusFlow(el, caretOff, now); return; }
    if (el.__cv) el.__cv.hidden = true;
    var txt = document.createElement('div');
    txt.className = 'pt-anno__txt';
    txt.contentEditable = 'true';
    txt.setAttribute('role', 'textbox');
    txt.setAttribute('aria-multiline', 'true');
    txt.setAttribute('aria-label', 'Text box content');
    styleFlow(txt, t);
    el.__txt = txt;
    buildRunNodes(txt, runsOf(t));
    el.appendChild(txt);
    el.style.width = (t.w != null) ? (t.w * dispW) + 'px' : 'auto';
    el.style.height = 'auto';
    focusedEl = el; savedRange = null; pendingStyle = null; pendingAt = -1;

    txt.addEventListener('input', function () { onFlowInput(el); });
    txt.addEventListener('compositionstart', function () { composing = true; });
    txt.addEventListener('compositionend', function () { composing = false; onFlowInput(el); });
    txt.addEventListener('beforeinput', function (e) { onBeforeInput(e, el); }, true);
    txt.addEventListener('paste', function (e) {
      e.preventDefault();
      var d = e.clipboardData; insertText(el, d ? d.getData('text/plain') : '');
    });
    txt.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        var k = (e.key || '').toLowerCase();
        if (k === 'b' || k === 'i' || k === 'u') { e.preventDefault(); toggleFlag(k); }
      }
    });
    txt.addEventListener('blur', function (e) {
      el.__armed = true;
      if (el.__demoting) return;                  // this blur IS the demotion in progress
      var rt = e.relatedTarget;
      // a click on a toolbar control blurs the flow; the abandoned-empty-box removal must
      // not fire then (the user is about to style the box they just placed)
      if (rt && rt.closest && rt.closest('.pt-ed__bar, .pt-ed__textbar, .pt-ed__signbar')) { flushFlow(el); return; }
      if (activeDragCancel) { flushFlow(el); return; }   // a handle gesture owns the box
      demote(el);
    });
    syncBars(); syncTextBar();
    focusFlow(el, caretOff, now);
  }
  function focusFlow(el, caretOff, now) {
    var txt = el.__txt; if (!txt) return;
    // a real click's default action moves focus to <body> after the handler, so focus in
    // a setTimeout(0) — the documented canvas-overlay focus gotcha
    function go() {
      if (!txt.isConnected) return;
      try { txt.focus(); } catch (er) {}
      var n = (el.__model.text || '').length;
      var off = (caretOff == null) ? n : Math.max(0, Math.min(n, caretOff));
      setSelRange(txt, off, off, off > 0 ? 'after' : 'before');
      syncTextBar();
      reveal(el);
    }
    if (now) go();
    setTimeout(go, 0);
  }
  // a box opened for typing (created, or promoted) is scrolled fully into view, with its x
  // badge and its grip: on a desktop that is below the floating text bar (a box under it
  // would be typed into blind), on a phone the docked bar is outside the page area, so the
  // area itself is the limit. Only the page area scrolls (never the window), and only when
  // something is out of view (the bar's room above the page, barPad, means there is always
  // room to scroll a box out from under the bar).
  function reveal(el) {
    if (!el || !el.isConnected || ed.hidden) return;
    var sr = scrollEl.getBoundingClientRect(), r = el.getBoundingClientRect(), y0 = r.top, y1 = r.bottom;
    var top = sr.top + 4, bot = sr.top + scrollEl.clientHeight - 4;
    if (!textbar.hidden && !docked()) top = Math.max(top, textbar.getBoundingClientRect().bottom + 4);
    // the box's x badge and move grip come into view with it (they sit outside it)
    Array.prototype.forEach.call(el.querySelectorAll('.pt-anno__del, .pt-anno__grip'), function (hd) {
      var q = hd.getBoundingClientRect(); y0 = Math.min(y0, q.top); y1 = Math.max(y1, q.bottom);
    });
    if (y0 < top) scrollEl.scrollTop -= Math.ceil(top - y0);
    else if (y1 > bot) scrollEl.scrollTop += Math.ceil(Math.min(y1 - bot, y0 - top));
  }
  // Chrome dispatches blur SYNCHRONOUSLY while the focused node is being removed, so the
  // flow's own blur handler re-enters this function mid-removal: __txt is nulled and the
  // guard is set BEFORE the node leaves the DOM, or the outer removal throws
  // ("the node to be removed is no longer a child of this node") and takes the gesture
  // that asked for the demotion down with it.
  function demote(el) {
    if (!el || !el.__txt || el.__demoting) return;
    el.__demoting = true;
    try {
      var t = el.__model, txt = el.__txt;
      flushFlow(el);
      el.__txt = null;
      if (focusedEl === el) focusedEl = null;
      savedRange = null;
      clearPending();
      if (txt.parentNode) { try { txt.parentNode.removeChild(txt); } catch (er) {} }
      if (!el.isConnected) return;     // a teardown (undo/nav re-render removed the box)
      if (pg && !(t.text || '').trim()) {
        removeAnno(el, true);
        // only drop the creation snapshot while it is still the top of the stack
        if (el.__createSeq >= 0 && PT.snapSeq && PT.snapSeq() === el.__createSeq && PT.dropSnapshot) PT.dropSnapshot();
        syncBars(); syncTextBar();
        return;
      }
      restingRender(el);
      syncBars(); syncTextBar();
    } finally { el.__demoting = false; }
  }
  function demoteAll(keep) { if (focusedEl && focusedEl !== keep) demote(focusedEl); }

  // ---- editing operations that go through the model, never through the DOM ----
  function insertText(el, str) {
    var t = el.__model, txt = el.__txt; if (!txt) return;
    str = normText(str); if (!str) return;
    if (el.__armed) { el.__armed = false; if (PT.snapshot) PT.snapshot('edit text on page ' + (idx + 1)); }
    var st = selState(txt) || { start: (t.text || '').length, end: (t.text || '').length, aff: 'after' };
    var runs = runsOf(t);
    // a pending style is already a COMPLETE style derived from the caret's own run, so it
    // replaces it rather than merging (a merge could only ever add a flag, never clear one)
    var style = pendingStyle || styleAtOffset(t, st.start, st.start > 0 ? 'after' : 'before');
    var head = rangeFragments(runs, 0, st.start);
    var tail = rangeFragments(runs, st.end, (t.text || '').length);
    writeContent(t, head.concat([mkRun(str, style)], tail));
    renderFlow(el);
    var at = st.start + str.length;
    setSelRange(txt, at, at, 'after');
    if (pendingStyle) pendingAt = at;
    PT.markDirty(pg);
    syncTextBar();
    noteDropped(el);
  }
  // one capture-phase handler owns every input type that would otherwise put markup, a
  // <div>, or a browser history entry into the flow
  function onBeforeInput(e, el) {
    var it = e.inputType || '';
    if (it === 'insertFromPaste' || it === 'insertFromDrop') {
      e.preventDefault();
      var d = e.dataTransfer || e.clipboardData;
      insertText(el, d ? d.getData('text/plain') : '');
      return;
    }
    if (it === 'insertParagraph' || it === 'insertLineBreak') { e.preventDefault(); insertText(el, '\n'); return; }
    if (it === 'formatBold') { e.preventDefault(); toggleFlag('b'); return; }
    if (it === 'formatItalic') { e.preventDefault(); toggleFlag('i'); return; }
    if (it === 'formatUnderline') { e.preventDefault(); toggleFlag('u'); return; }
    if (it === 'formatStrikeThrough') { e.preventDefault(); toggleFlag('s'); return; }
    if (it === 'historyUndo') { e.preventDefault(); if (!(PT.isBusy && PT.isBusy())) PT.undo(); return; }
    if (it === 'historyRedo') { e.preventDefault(); return; }
    if (it === 'insertText' && pendingStyle) { e.preventDefault(); insertText(el, e.data || ''); return; }
  }

  // ---- applying a style ----
  // targets, in order: a live selection inside the focused box; a collapsed caret (which
  // sets a PENDING style the next characters carry, and never rewrites existing text); a
  // selected box that is not focused (the whole box)
  function styleTarget() {
    if (focusedEl) {
      var st = savedRange || selState(focusedEl.__txt);
      if (st && st.end > st.start) return { el: focusedEl, start: st.start, end: st.end };
      return { el: focusedEl, caret: true, at: st ? st.start : (focusedEl.__model.text || '').length };
    }
    if (selected && isText(selected)) return { el: selected, whole: true };
    return null;
  }
  function currentStyle() {
    var tg = styleTarget(); if (!tg) return null;
    var t = tg.el.__model, runs = runsOf(t), frags;
    if (tg.whole) frags = runs;
    else if (tg.caret) return pendingStyle || styleAtOffset(t, tg.at, tg.at > 0 ? 'after' : 'before');
    else frags = rangeFragments(runs, tg.start, tg.end);
    frags = frags.filter(function (r) { return r.t.length; });
    if (!frags.length) return mkRun('', null);
    var all = function (k) { return frags.every(function (r) { return !!r[k]; }); };
    var same = function (k) { var v = frags[0][k] || null; return frags.every(function (r) { return (r[k] || null) === v; }) ? v : null; };
    return { b: all('b'), i: all('i'), u: all('u'), s: all('s'), hl: same('hl'), c: same('c') };
  }
  function applyStyle(patchFn, label) {
    var tg = styleTarget(); if (!tg) return;
    var el = tg.el, t = el.__model;
    if (tg.caret) {
      var cur = currentStyle() || {};
      pendingStyle = patchFn(cur, true);
      pendingAt = tg.at;
      syncTextBar();
      return;
    }
    styleSnapshot(label);
    var runs = runsOf(t);
    var start = tg.whole ? 0 : tg.start, end = tg.whole ? (t.text || '').length : tg.end;
    writeContent(t, mapRange(runs, start, end, function (r) { return patchFn(r, false); }));
    if (el.__txt) { renderFlow(el); setSelRange(el.__txt, start, end, 'after'); savedRange = { start: start, end: end, aff: 'after' }; }
    else restingRender(el);
    PT.markDirty(pg);
    syncTextBar();
  }
  function toggleFlag(k) {
    var cur = currentStyle() || {};
    var on = !cur[k];
    applyStyle(function (r) { var o = { b: r.b, i: r.i, u: r.u, s: r.s, hl: r.hl, c: r.c }; o[k] = on; return o; },
      (k === 'b' ? 'bold' : k === 'i' ? 'italic' : k === 'u' ? 'underline' : 'strikethrough') + ' text');
    rearmStyle();
  }
  function setColor(hex) {
    applyStyle(function (r) { return { b: r.b, i: r.i, u: r.u, s: r.s, hl: r.hl, c: hex }; }, 'color text');
  }
  // forceSet: the custom colour picker always SETS, because a drag that happens to pass
  // back through the colour already applied would otherwise clear the highlight mid-drag
  function setHighlight(hex, forceSet) {
    var cur = currentStyle() || {};
    var off = !forceSet && hex && cur.hl === hex;    // the same swatch again clears it
    applyStyle(function (r) { return { b: r.b, i: r.i, u: r.u, s: r.s, hl: off ? null : hex, c: r.c }; }, 'highlight text');
    rearmStyle();
  }
  // whole-box properties (font, size, line spacing, alignment, width) always apply to the
  // whole box: there is one size and one family per box (spec 12.1)
  function boxTarget() {
    if (focusedEl) return focusedEl;
    if (selected && isText(selected)) return selected;
    return null;
  }
  function applyBoxProp(fn, label) {
    var el = boxTarget(); if (!el) return;
    styleSnapshot(label);
    fn(el.__model);
    refreshBox(el);
    PT.markDirty(pg);
    syncTextBar();
  }
  function refreshBox(el) {
    layoutBox(el);
    if (el.__txt) {
      styleFlow(el.__txt, el.__model);
      el.style.width = (el.__model.w != null) ? (el.__model.w * dispW) + 'px' : 'auto';
      el.style.height = 'auto';
    } else restingRender(el);
    el.style.left = (el.__model.x * dispW) + 'px'; el.style.top = (el.__model.y * dispH) + 'px';
    placeBadge(el);
    var grip = el.querySelector('.pt-anno__grip');
    if (grip) grip.classList.toggle('pt-anno__grip--below', el.__model.y * dispH < gripLift());
  }

  function makeTextEl(t, isNew, ownSnap) {
    var el = document.createElement('div'); el.className = 'pt-anno pt-anno--text'; el.__model = t;
    el.style.left = (t.x * dispW) + 'px'; el.style.top = (t.y * dispH) + 'px';
    // one undo snapshot per editing session (a new box is covered by its creation snapshot)
    el.__armed = !isNew;
    // ownSnap: this new box took its OWN 'add text' snapshot (i.e. no flatten snapshot
    // covers it) — if the box is abandoned empty, that snapshot must be dropped or the
    // next Ctrl+Z becomes a visible no-op
    el.__createSeq = (isNew && ownSnap && PT.snapSeq) ? PT.snapSeq() : -1;
    restingRender(el);
    annoKeyboardable(el);
    el.addEventListener('pointerdown', function (e) { onTextPointerDown(e, el); });
    return el;
  }
  function onTextPointerDown(e, el) {
    if (e.button != null && e.button !== 0) return;                          // left button / touch only
    var t = el.__model;
    if (e.target !== el && e.target.classList && /pt-anno__(del|grip|he|hw|hse|resize)/.test(e.target.className)) return;
    if (el.__txt && el.__txt.contains(e.target)) return;                     // the browser owns the caret inside a live flow
    if (tool === 'redact') return;
    // hit-test precedence: handle (above), then the border ring outside the ink box, then
    // the text (caret), then the stage
    var r = el.getBoundingClientRect();
    var inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) { e.preventDefault(); select(el); startDrag(e, el, t); return; }
    var px = (e.clientX - layer.getBoundingClientRect().left) / scale - t.x * Wpt;
    var py = (e.clientY - layer.getBoundingClientRect().top) / scale - t.y * Hpt;
    var off = caretOffsetAt(t, px, py);
    if (tool === 'text') { e.preventDefault(); select(el); promote(el, off); return; }
    // Move / Sign: a drag moves the box, a click without movement edits it (ruling 12.6).
    // The tool is NEVER changed by an edit click: switching to Text would arm the
    // click-to-create path, which on a rotated page bakes the page to a JPEG.
    e.preventDefault(); select(el);
    startDrag(e, el, t, function (moved) { if (!moved) promote(el, off); });
  }
  function caretOffsetAt(t, px, py) {
    var fn = PURE.hitTextBox, tab = metricsTable();
    if (!fn || !tab) return null;
    try { return fn(t, Wpt, Hpt, tab, px, py); } catch (er) { return null; }
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
      if (sigArmed) return;                                                    // the armed placement owns this click
      if (tool === 'move' || tool === 'sign') { e.preventDefault(); select(el); startDrag(e, el, s); }
    });
    return el;
  }
  // a redaction box, or (kind 'whiteout') a white-out box: the same rect, the same
  // gestures, a different paint and a different model array
  function makeRedactEl(r, kind) {
    kind = kind || 'redact';
    var el = document.createElement('div'); el.className = 'pt-anno pt-anno--' + kind; el.__model = r;
    el.style.left = (r.x * dispW) + 'px'; el.style.top = (r.y * dispH) + 'px';
    el.style.width = (r.w * dispW) + 'px'; el.style.height = (r.h * dispH) + 'px';
    annoKeyboardable(el);
    el.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;                          // left button / touch only
      if (sigArmed) return;
      if (e.target.classList.contains('pt-anno__del')) return;
      if (tool === 'move') { e.preventDefault(); select(el); startDrag(e, el, r); }
      else if (tool === kind) { e.preventDefault(); select(el); }   // select → × to remove
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
  function startDrag(e, el, model, onUp) {
    var r = layer.getBoundingClientRect();
    var pid = e.pointerId;   // ignore any other simultaneous pointer (a resting palm)
                             // so it can't hijack this drag
    var ox = e.clientX - r.left - model.x * dispW, oy = e.clientY - r.top - model.y * dispH;
    var sx = e.clientX, sy = e.clientY, moved = false, pg0 = pg;
    var mx0 = model.x, my0 = model.y, mySnap = -1;   // pre-drag state for Escape cancel
    function mv(ev) {
      if (ev.pointerId !== pid) return;
      if (pg !== pg0 || ed.hidden) return;
      if (!moved) {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 3) return;   // a plain click just selects
        moved = true;
        if (PT.snapshot) { PT.snapshot('move ' + annoKind(el) + ' on page ' + (idx + 1)); mySnap = PT.snapSeq ? PT.snapSeq() : -1; }
      }
      var nx = (ev.clientX - r.left - ox) / dispW, ny = (ev.clientY - r.top - oy) / dispH;
      var b = elBox(el);
      model.x = Math.min(Math.max(0, nx), 1 - (b.w / dispW) * 0.3);
      model.y = Math.min(Math.max(0, ny), 1 - (b.h / dispH) * 0.3);
      el.style.left = (model.x * dispW) + 'px'; el.style.top = (model.y * dispH) + 'px';
      if (isText(el)) placeBadge(el);
    }
    function up(ev) {
      if (ev.pointerId !== pid) return;
      activeDragCancel = null;
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      if (moved && pg === pg0 && pg) PT.markDirty(pg);
      if (onUp && pg === pg0 && !ed.hidden) onUp(moved);
    }
    activeDragCancel = function () {
      activeDragCancel = null;
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      model.x = mx0; model.y = my0;
      el.style.left = (mx0 * dispW) + 'px'; el.style.top = (my0 * dispH) + 'px';
      if (isText(el)) placeBadge(el);
      // drop the 'move' snapshot, but only while it is still the top of the stack
      if (moved && mySnap >= 0 && PT.snapSeq && PT.snapSeq() === mySnap && PT.dropSnapshot) PT.dropSnapshot();
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  }
  function startResize(e, el) {
    e.preventDefault(); e.stopPropagation(); var s = el.__model;
    var r = layer.getBoundingClientRect(), aspect = s.h / s.w;
    var pid = e.pointerId;   // ignore any other simultaneous pointer (a resting palm)
                             // so it can't hijack this resize
    var moved = false, pg0 = pg;
    var w0 = s.w, h0 = s.h, mySnap = -1;             // pre-resize state for Escape cancel
    function mv(ev) {
      if (ev.pointerId !== pid) return;
      if (pg !== pg0 || ed.hidden) return;
      if (!moved) { moved = true; if (PT.snapshot) { PT.snapshot('resize signature on page ' + (idx + 1)); mySnap = PT.snapSeq ? PT.snapSeq() : -1; } }
      var w = (ev.clientX - r.left) / dispW - s.x; w = Math.max(0.03, Math.min(w, 1 - s.x));
      s.w = w; s.h = w * aspect;   // aspect is the NORMALIZED ratio — Wpt/Hpt is already
                                   // baked in at placement, applying it again squashed
                                   // the signature by Wpt/Hpt on every resize
      el.style.width = (s.w * dispW) + 'px'; el.style.height = (s.h * dispH) + 'px';
    }
    function up(ev) {
      if (ev.pointerId !== pid) return;
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
  // width and size drags share a shape with the two above: pg0 capture, pointerId lock,
  // right button ignored, one snapshot on the first real movement, Escape restores the
  // pre-gesture geometry AND re-lays the box out (a geometry cancel is not just a
  // reposition once the text re-wraps)
  function startGeoDrag(e, el, step) {
    e.preventDefault();
    var t = el.__model, pid = e.pointerId, pg0 = pg, moved = false, mySnap = -1;
    var g0 = { x: t.x, w: t.w, size: t.size };
    var wasFocused = !!el.__txt;
    if (wasFocused) demote(el);        // never let two different wraps fight during a gesture
    if (!el.isConnected) return;
    var L0 = layoutBox(el) || { boxW: t.size, boxH: t.size };
    var sx = e.clientX, sy = e.clientY, raf = 0;
    /* GRAB ANCHORED: the step gets the pointer's x AT POINTERDOWN, not the layer rect, so
       every geometry change is the pointer's DELTA applied to the pre-gesture w / size / x.
       Mapping the pointer's absolute x onto the box edge stepped the box by the grab offset
       on the first movement, which is 7 to 14 px now that the handles sit outside the box. */
    function paint() { raf = 0; refreshBox(el); }
    function mv(ev) {
      if (ev.pointerId !== pid) return;
      if (pg !== pg0 || ed.hidden || !el.isConnected) return;
      if (!moved) {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 3) return;
        moved = true;
        if (PT.snapshot) { PT.snapshot('resize text on page ' + (idx + 1)); mySnap = PT.snapSeq ? PT.snapSeq() : -1; }
      }
      step(ev, t, L0, g0, sx);
      if (!raf) raf = requestAnimationFrame(paint);   // one layout per animation frame
    }
    function up(ev) {
      if (ev.pointerId !== pid) return;
      activeDragCancel = null;
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      if (raf) { cancelAnimationFrame(raf); paint(); }
      if (moved && pg === pg0 && pg) PT.markDirty(pg);
    }
    activeDragCancel = function () {
      activeDragCancel = null;
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      t.x = g0.x; t.w = g0.w; t.size = g0.size;
      if (el.isConnected) refreshBox(el);
      if (moved && mySnap >= 0 && PT.snapSeq && PT.snapSeq() === mySnap && PT.dropSnapshot) PT.dropSnapshot();
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  }
  function startWidthDrag(e, el, side) {
    startGeoDrag(e, el, function (ev, t, L0, g0, sx0) {
      var minW = Math.max(0.02, (t.size * 1.2) / Wpt);
      // an auto-width box becomes a fixed-width box on its first width drag, seeded from
      // the width it is drawn at
      var w0 = (g0.w != null) ? g0.w : Math.max(minW, L0.boxW / Wpt);
      var dx = (ev.clientX - sx0) / dispW;
      if (side === 'e') {
        t.x = g0.x;
        t.w = Math.max(minW, Math.min(w0 + dx, 1 - g0.x));
      } else {
        var right = g0.x + w0;
        var nx = Math.max(0, Math.min(g0.x + dx, right - minW));
        t.x = nx; t.w = right - nx;
      }
    });
  }
  function startSizeDrag(e, el) {
    startGeoDrag(e, el, function (ev, t, L0, g0, sx0) {
      var w0px = Math.max(12, (g0.w != null ? g0.w * Wpt : L0.boxW) * scale);
      var f = Math.max(0.2, Math.min(8, 1 + (ev.clientX - sx0) / w0px));
      t.size = Math.max(6, Math.min(144, Math.round(g0.size * f)));
      // a uniform scale: on a fixed-width box the width follows the size, on an auto box
      // the width is the ink and there is nothing to scale
      if (g0.w != null) t.w = Math.max(0.02, Math.min(1 - t.x, g0.w * (t.size / g0.size)));
    });
  }

  // ---------- stage interactions (create text / draw redact) ----------
  function stagePos(e) { var r = layer.getBoundingClientRect(); return { x: (e.clientX - r.left), y: (e.clientY - r.top) }; }
  // create an empty, focused text box at normalized (nx, ny) — shared by the stage
  // click and the keyboard path
  // `quick`: the caller's pointerdown was preventDefaulted (a tap on a white-out), so the
  // box may be focused inside the tap (promote's `now`)
  function createTextAt(nx, ny, wo, quick) {
    var o = {
      size: parseInt(sizeSel.value, 10) || 14, font: fontSel.value, color: colorInp.value,
      lh: parseFloat(lhSel && lhSel.value) || 1.2, align: currentAlign()
    };
    var myPg = pg;
    // the covered run is read BEFORE ensureUpright, in the frame the white-out was drawn in
    // (a rotated page is flattened by it and its text is gone after); with the page's text
    // already read (warmText) every step here settles in microtasks of the tap
    (wo ? coveredRun(wo) : Promise.resolve(null)).then(function (run) {
      if (myPg !== pg) return;
      return ensureUpright().then(function (flattened) {
        if (myPg !== pg) return;   // the user navigated away while a rotated page was flattening
        if (wo) { var at = snapTo(wo, o, run); nx = at.x; ny = at.y; }
        // the flatten snapshot (if any) already covers this action: one Ctrl+Z undoes both
        if (!flattened && PT.snapshot) PT.snapshot('add text on page ' + (idx + 1));
        var t = PURE.newTextBox
          ? PURE.newTextBox({ x: nx, y: ny, size: o.size, font: o.font, color: o.color, lh: o.lh, align: o.align })
          : { x: nx, y: ny, text: '', size: o.size, font: o.font, color: o.color, w: null, lh: o.lh, align: o.align, runs: null };
        pg.texts.push(t); var el = makeTextEl(t, true, !flattened); layer.appendChild(el);
        select(el); promote(el, 0, !!quick && !flattened);
      });
    }).catch(function () {
      // the upright flatten failed (render/encode error on an unusual page) — say so
      // instead of a click that silently does nothing
      if (myPg === pg) edNotice('Could not prepare this page for text.');
    });
  }
  // a correction typed on a white-out (`wo`, its model rect) starts 2 pt in from the box's
  // left edge. Its size (o.size, in place): the covered run's own size when one was found
  // (`run.pt`, read from the page's text), else about 0.8 of the box height but never under
  // 8 pt; whole points. The size select is NOT a cap: it mirrors the last box edited. Only a
  // size the visitor picked for new boxes (`pickedSize`, chosen while no box was the select's
  // target) caps it; without one the caps are 72 (a run) and 14 (no run).
  // Where it sits: a TALL box (more than 2.5 lines of that size) is a block to retype, so the
  // ink starts 2 pt under its top edge; otherwise on the covered line's own baseline
  // (`run.base`) when its ink then fits inside the box, else with its ink band (ascender to
  // descender of the face) centred on the box's middle. Returns the box's model position.
  function snapTo(wo, o, run) {
    var boxH = wo.h * Hpt, top = wo.y * Hpt, bot = (wo.y + wo.h) * Hpt;
    o.size = run ? Math.max(4, Math.min(pickedSize || 72, Math.round(run.pt)))
      : Math.max(8, Math.min(pickedSize || 14, Math.round(boxH * 0.8)));
    var tab = metricsTable(), fk = PURE.faceKey ? PURE.faceKey(o.font, false, false) : o.font;
    var asc = PURE.faceAscent ? PURE.faceAscent(tab, fk) : 0.718, desc = PURE.faceDescent ? PURE.faceDescent(tab, fk) : 0.207;
    var base;
    if (boxH > 2.5 * o.size * o.lh) base = top + 2 + asc * o.size;
    else {
      base = (wo.y + wo.h / 2) * Hpt + (asc - desc) / 2 * o.size;
      if (run && run.base != null && run.base - asc * o.size >= top - 1e-6 && run.base + desc * o.size <= bot + 1e-6) base = run.base;
    }
    return { x: wo.x + 2 / Wpt, y: (base - (PURE.LINE_BASE || 0.82) * o.size) / Hpt };
  }
  // the text of the page the editor SHOWS, read once and kept in ONE slot: fetched when the
  // editor shows a live page and when Text is picked, so a tap on a white-out finds it here
  // and the correction box is made and focused inside the tap, with no round trip to the
  // pdf.js worker (iOS raises its keyboard only for a focus inside the gesture). Showing
  // another page replaces it; close() and a new document clear it; it is keyed by the
  // page's state, so a turned page reads afresh; the editor's own flatten (ensureUpright)
  // CARRIES it: the text was read in the frame the page is shown in (`rot`), which is the
  // frame the flatten rasterizes into, so later corrections on that page still find their
  // line. A page that was a raster or a scan from the start has none. (One slot, not one
  // entry per page: a long word-positioned scan walked in the editor would otherwise hold
  // every page's text content for the whole visit.)
  var textSlot = null;
  function textKey(p) { return p.docIndex + ':' + p.pageIndex + ':' + (p.rot || 0) + ':' + (p.raster ? 1 : 0); }
  // A raster page the editor flattened carries its frame (`raster.frame`, ensureUpright): its
  // SOURCE page's text is read again in that frame (turned by any later grid rotation), so
  // an undo clone, a visit to another page and back, or files added keep the snap.
  function warmText(p) {
    if (!p || p.blank || !PT.pdfjsPage) return null;
    if (textSlot && textSlot.pg === p && textSlot.key === textKey(p)) return textSlot;
    var fr = p.raster ? p.raster.frame : null;
    if (p.raster && fr == null) return null;   // a raster or a scan from the start: no text
    var e = { pg: p, key: textKey(p), page: null, tc: null, p: null, rot: 0 }, r0 = p.rot || 0;
    try {
      e.p = PT.pdfjsPage(p).then(function (page) {
        e.rot = fr != null ? (fr + r0) % 360 : ((page.rotate || 0) + r0) % 360;   // = the frame the page is shown in
        return page.getTextContent().then(function (tc) { e.page = page; e.tc = tc; return e; });
      });
    } catch (er) { return null; }
    textSlot = e;
    e.p.catch(function () { if (textSlot === e) textSlot = null; });
    return e;
  }
  // the page's own text under a white-out: {pt, base} of the pdf.js run with the most of its
  // area under the box, counting only runs whose vertical middle the box covers (as
  // PURE.cutCovered does): its size and, for an upright run, its baseline, both in points
  // from the top of the frame the editor shows NOW (the viewport at the page's own rotation,
  // the white-out's frame; read before any flatten). null when there is no live text there
  // (a scan, a flattened or blank page, vertical text, nothing under the box, a failed read).
  function coveredRun(wo) {
    var e = warmText(pg); if (!e || !PURE.itemToToken) return Promise.resolve(null);
    var myPg = pg;
    return (e.tc ? Promise.resolve(e) : e.p).then(function (r) {
      if (myPg !== pg || !r || !r.tc || !r.page) return null;
      var rot = r.rot;   // the frame shown when the text was read (a flatten keeps it)
      var vp = r.page.getViewport({ scale: 1, rotation: rot }), best = null, most = 0;
      (r.tc.items || []).forEach(function (it) {
        var k = PURE.itemToToken(vp.transform, it, vp.width, vp.height);
        if (!k || (k.y1 - k.y0) > k.fontSize * 2.5) return;
        var cy = (k.y0 + k.y1) / 2, ov = Math.min(k.x1, wo.x + wo.w) - Math.max(k.x0, wo.x);
        if (cy < wo.y || cy > wo.y + wo.h || !(ov > 0)) return;
        var area = ov * Math.min(k.y1 - k.y0, wo.h);
        if (area <= most) return;
        var tx = PURE.combine2d(vp.transform, it.transform);
        most = area;
        best = { pt: k.fontSize * vp.height, base: (tx[0] > 0 && Math.abs(tx[1]) <= 1e-3 * tx[0]) ? tx[5] : null };
      });
      return best;
    }).catch(function () { return null; });
  }
  // a finger adds a box (Text) or deselects (Move, Sign) on a TAP only: a touch that moves
  // more than 8 px is a swipe (the stage lets it scroll the page, the md) and does nothing;
  // so does one the browser takes over as a scroll (pointercancel)
  function onTap(e, fn) {
    var pid = e.pointerId, sx = e.clientX, sy = e.clientY, far = false, pg0 = pg, t0 = tool;
    function mv(ev) { if (ev.pointerId === pid && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8) far = true; }
    function end(ev) {
      if (ev.pointerId !== pid) return;
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end);
      if (ev.type !== 'pointerup') return;
      mv(ev);
      if (!far && pg === pg0 && !ed.hidden && tool === t0) fn();
    }
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
  }
  stage.addEventListener('pointerdown', function (e) {
    if (e.button != null && e.button !== 0) return;                               // left button / touch only
    if (sigArmed) return;                                                         // the capture handler owns it
    // clicks on annotations are theirs — EXCEPT the text tool over a redaction box, a
    // white-out or a signature: typing a replacement label over blacked-out content, a
    // correction over a white-out (or a date/name on a signature) is the natural workflow
    // (the export renders those stacks correctly)
    var onRedactEl = e.target.classList && (e.target.classList.contains('pt-anno--redact') ||
      e.target.classList.contains('pt-anno--whiteout'));
    var onSigEl = !!(e.target.closest && e.target.closest('.pt-anno--sig'));
    var overAnno = (tool === 'text' && (onRedactEl || onSigEl));
    if (e.target !== canvas && e.target !== stage && e.target !== layer && !overAnno) return;
    // the annotation under this click carries tabindex (annoKeyboardable) and its focus
    // handler selects it, so the browser's default focus action would steal focus from the
    // box we are about to create and the empty-box cleanup would delete it inside the same
    // gesture (measured: created then removed before focusFlow's timer ran). The move-tool
    // branches of those annotations already preventDefault for the same reason.
    if (overAnno) e.preventDefault();
    var p = stagePos(e);
    if (tool === 'text') {
      // on a white-out the new box snaps to it (createTextAt); anywhere else it starts at the click
      var onWo = (overAnno && e.target.classList.contains('pt-anno--whiteout')) ? e.target.__model : null;
      if (e.pointerType === 'touch') onTap(e, function () { createTextAt(p.x / dispW, p.y / dispH, onWo, overAnno); });
      else createTextAt(p.x / dispW, p.y / dispH, onWo, overAnno);
    } else if (tool === 'redact' || tool === 'whiteout') {
      startRedactBox(e, p, tool);
    } else if (e.pointerType === 'touch') {
      // a finger on bare page deselects on a TAP: a swipe scrolls (the md) and keeps the
      // selection, so a docked text bar does not drop away in the middle of the swipe
      onTap(e, function () { deselectAll(); selected = null; syncBars(); syncTextBar(); });
    } else { deselectAll(); selected = null; syncBars(); syncTextBar(); }
  });

  var activeRedactCancel = null;   // set while a redact drag is in flight, so Escape can
                                   // cancel the BOX instead of closing the whole editor
  // kind 'redact' (default) or 'whiteout': one drawing gesture for both boxes
  function startRedactBox(e, p0, kind) {
    kind = kind || 'redact';
    var box = document.createElement('div'); box.className = 'pt-anno pt-anno--' + kind + ' pt-anno--' + kind + '-tmp'; layer.appendChild(box);
    var rec = { x: p0.x / dispW, y: p0.y / dispH, w: 0, h: 0 };
    var pg0 = pg;   // arrow-key nav or Escape mid-drag must not commit to the wrong page
    var pid = e.pointerId;   // ignore any other simultaneous pointer (a resting palm) so
                             // it can't hijack the box being drawn
    function mv(ev) {
      if (ev.pointerId !== pid) return;
      var p = stagePos(ev); var x0 = p0.x, y0 = p0.y;
      var x = Math.min(x0, p.x), y = Math.min(y0, p.y), w = Math.abs(p.x - x0), h = Math.abs(p.y - y0);
      box.style.left = x + 'px'; box.style.top = y + 'px'; box.style.width = w + 'px'; box.style.height = h + 'px';
      rec.x = x / dispW; rec.y = y / dispH; rec.w = w / dispW; rec.h = h / dispH;
    }
    function fin(commit) {
      activeRedactCancel = null;
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel);
      if (!commit || pg !== pg0 || ed.hidden || !(rec.w > 0.008 && rec.h > 0.008)) { box.remove(); return; }
      if (!boxWarned(kind)) {
        // hold the first-ever box of this kind until its one-time dialog is acknowledged
        askFirst(kind, rec, box);
        return;
      }
      commitBox(kind, rec, box);
    }
    function up(ev) { if (ev.pointerId === pid) fin(true); }
    function cancel(ev) { if (ev.pointerId === pid) fin(false); }
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
    var el = makeRedactEl(rec); addBoxEl(el);
    PT.setStatus(coarse() ? 'Redaction added. The page is flattened to an image on download, which is what actually removes the covered text. Tap Undo to take it back.'
      : 'Redaction added. The page is flattened to an image on download, which is what actually removes the covered text. Ctrl+Z undoes it.');
    return el;
  }
  // a white-out commits the same way: a page annotation at once, no Apply step. It is
  // painted white on every picture and drawn as one white rectangle on download; the page
  // stays vector and the content under it stays in the file (the dialog says so).
  function commitWhiteout(rec, box) {
    if (PT.snapshot) PT.snapshot('white-out on page ' + (idx + 1));
    (pg.whiteouts || (pg.whiteouts = [])).push(rec);
    PT.markDirty(pg);
    box.remove();
    var el = makeRedactEl(rec, 'whiteout'); addBoxEl(el);
    PT.setStatus(coarse() ? 'White-out added. It covers what is under it but does not remove it from the file. Tap Undo to take it back.'
      : 'White-out added. It covers what is under it but does not remove it from the file. Ctrl+Z undoes it.');
    return el;
  }
  function boxWarned(kind) { return kind === 'whiteout' ? whiteWarned : redactWarned; }
  function askFirst(kind, rec, box) {
    pendingBox = { rec: rec, el: box, kind: kind };
    if (kind === 'whiteout') openWhiteDialog(); else openRedactDialog();
  }
  function commitBox(kind, rec, box) { return kind === 'whiteout' ? commitWhiteout(rec, box) : commitRedact(rec, box); }

  /* ==================================================================================
     The text bar
     ================================================================================== */
  // One snapshot per styling burst: the color pickers fire 'input' continuously while
  // dragged, so a burst disarms on the first event and re-arms on 'change'. Any snapshot
  // taken while a box is focused RE-ARMS that box's typing snapshot, so the typing that
  // follows a style change still takes one of its own.
  var styleArmed = true;
  var savedRange = null;        // the character range a toolbar action works against
  function styleSnapshot(label) {
    if (styleArmed) { styleArmed = false; if (PT.snapshot) PT.snapshot(label + ' on page ' + (idx + 1)); }
    if (focusedEl) focusedEl.__armed = true;
  }
  function rearmStyle() { styleArmed = true; }
  function currentAlign() {
    return $('pt-text-ac').getAttribute('aria-pressed') === 'true' ? 'center'
      : $('pt-text-ar').getAttribute('aria-pressed') === 'true' ? 'right' : 'left';
  }
  function press(el, on) { if (el) el.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  // a size or spacing the user reached by DRAGGING a handle is not one of the listed
  // options; give it one so the control never shows a value the box does not have
  function ensureOption(sel, value, label) {
    var v = String(value);
    for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === v) return;
    var o = document.createElement('option'); o.value = v; o.textContent = label;
    var at = null;
    for (var j = 0; j < sel.options.length; j++) {
      var ov = parseFloat(sel.options[j].value);
      if (isFinite(ov) && ov > parseFloat(v)) { at = sel.options[j]; break; }
    }
    sel.insertBefore(o, at);
  }
  function syncTextBar() {
    var el = boxTarget(), t = el && el.__model;
    var st = currentStyle();
    press($('pt-text-b'), st && st.b); press($('pt-text-i'), st && st.i);
    press($('pt-text-u'), st && st.u); press($('pt-text-s'), st && st.s);
    press(hlBtn, !!(st && st.hl));
    if (st && st.hl) hlColor.value = st.hl;
    if (st && st.c) colorInp.value = st.c;
    if (t) {
      if (fontSel.value !== t.font) fontSel.value = t.font;
      ensureOption(sizeSel, t.size, t.size + ' pt'); sizeSel.value = String(t.size);
      var lv = String(lhOf(t));
      ensureOption(lhSel, lv, 'Spacing ' + lv); lhSel.value = lv;
      autoChk.checked = (t.w == null);
      if (!st || !st.c) colorInp.value = t.color || '#111111';
    }
    var a = t ? alignOf(t) : currentAlign();
    press($('pt-text-al'), a === 'left'); press($('pt-text-ac'), a === 'center'); press($('pt-text-ar'), a === 'right');
    autoChk.disabled = !t;
  }
  // the live selection is invalidated by every re-render, so toolbar actions work against
  // a SAVED range; selects and colour inputs cannot avoid taking focus
  document.addEventListener('selectionchange', function () {
    if (!focusedEl || !focusedEl.__txt) return;
    var st = selState(focusedEl.__txt);
    if (st) savedRange = st;
    if (pendingStyle && st && st.start !== pendingAt) clearPending();
    syncTextBar();
  });

  fontSel.addEventListener('change', function () {
    if (boxTarget()) { applyBoxProp(function (t) { t.font = fontSel.value; }, 'font'); rearmStyle(); }
  });
  // the size select mirrors the box being edited; a choice made while no box is its target
  // is the visitor's size for NEW boxes, the one cap a white-out correction obeys (snapTo)
  var pickedSize = null;
  sizeSel.addEventListener('change', function () {
    if (boxTarget()) { applyBoxProp(function (t) { t.size = parseInt(sizeSel.value, 10) || 14; }, 'text size'); rearmStyle(); }
    else pickedSize = parseInt(sizeSel.value, 10) || null;
  });
  lhSel.addEventListener('change', function () {
    var v = lhSel.value;
    if (v === 'other') {
      var cur = boxTarget() ? lhOf(boxTarget().__model) : 1.2, ans = null;
      try { ans = window.prompt('Line spacing (0.8 to 4)', String(cur)); } catch (er) { ans = null; }
      var n = PURE.parseDecimal ? PURE.parseDecimal(ans) : parseFloat(ans);   // "1,5" is 1.5, not 1
      lhSel.value = String(cur);
      if (!isFinite(n) || n < 0.8 || n > 4) { syncTextBar(); return; }
      if (boxTarget()) { applyBoxProp(function (t) { t.lh = n; }, 'line spacing'); rearmStyle(); }
      return;
    }
    if (boxTarget()) { applyBoxProp(function (t) { t.lh = parseFloat(v) || 1.2; }, 'line spacing'); rearmStyle(); }
  });
  [['pt-text-al', 'left'], ['pt-text-ac', 'center'], ['pt-text-ar', 'right']].forEach(function (pair) {
    var btn = $(pair[0]);
    noFocusSteal(btn);
    btn.addEventListener('click', function () {
      if (boxTarget()) { applyBoxProp(function (t) { t.align = pair[1]; }, 'alignment'); rearmStyle(); }
      else { press($('pt-text-al'), pair[1] === 'left'); press($('pt-text-ac'), pair[1] === 'center'); press($('pt-text-ar'), pair[1] === 'right'); }
    });
  });
  [['pt-text-b', 'b'], ['pt-text-i', 'i'], ['pt-text-u', 'u'], ['pt-text-s', 's']].forEach(function (pair) {
    var btn = $(pair[0]);
    noFocusSteal(btn);
    btn.addEventListener('click', function () { toggleFlag(pair[1]); });
  });
  var colorRaf = 0, hlRaf = 0;
  colorInp.addEventListener('input', function () {
    if (colorRaf) return;
    colorRaf = requestAnimationFrame(function () { colorRaf = 0; setColor(colorInp.value); });
  });
  colorInp.addEventListener('change', rearmStyle);
  noFocusSteal(hlBtn);
  hlBtn.addEventListener('click', function () {
    var st = currentStyle();
    if (st && st.hl) setHighlight(null); else setHighlight(hlColor.value || '#ffe14d');
  });
  Array.prototype.forEach.call(textbar.querySelectorAll('.pt-sw'), function (sw) {
    noFocusSteal(sw);
    sw.style.background = sw.getAttribute('data-hl');
    sw.addEventListener('click', function () { hlColor.value = sw.getAttribute('data-hl'); setHighlight(sw.getAttribute('data-hl')); });
  });
  hlColor.addEventListener('input', function () {
    if (hlRaf) return;
    hlRaf = requestAnimationFrame(function () { hlRaf = 0; setHighlight(hlColor.value, true); });
  });
  hlColor.addEventListener('change', rearmStyle);
  autoChk.addEventListener('change', function () {
    var el = boxTarget(); if (!el) return;
    var on = autoChk.checked;
    applyBoxProp(function (t) {
      if (on) t.w = null;
      else { var L = el.__layout || layoutBox(el); t.w = Math.max(0.02, Math.min(1 - t.x, (L ? L.boxW : t.size * 6) / Wpt)); }
    }, on ? 'auto width' : 'fixed width');
    rearmStyle();
  });

  // ---------- redaction dialog (one-time explainer) + download quality ----------
  var redactDialog = $('pt-dialog');
  function openRedactDialog() {
    redactDialog.hidden = false;
    // move focus into the modal (the core Tab trap keeps it there)
    setTimeout(function () { var b = $('pt-dialog-go'); if (b) b.focus(); }, 0);
  }
  // closing the explainer hands focus back to the stage (the dialog stole it from
  // there); setTimeout(0) so a real click's default focus move can't undo it
  function refocusStage() { setTimeout(function () { if (!ed.hidden) { try { stage.focus({ preventScroll: true }); } catch (er) {} } }, 0); }
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
  // the white-out explainer: the same one-time pattern, its own copy and buttons
  var whiteDialog = $('pt-wo-dialog');
  function openWhiteDialog() {
    whiteDialog.hidden = false;
    setTimeout(function () { var b = $('pt-wo-dialog-go'); if (b) b.focus(); }, 0);
  }
  function whiteDialogCancel() {
    whiteDialog.hidden = true;
    if (pendingBox) { pendingBox.el.remove(); pendingBox = null; }
    refocusStage();
  }
  $('pt-wo-dialog-cancel').addEventListener('click', whiteDialogCancel);
  whiteDialog.addEventListener('click', function (e) { if (e.target === whiteDialog) whiteDialogCancel(); });
  $('pt-wo-dialog-go').addEventListener('click', function () {
    whiteDialog.hidden = true; whiteWarned = true;
    if (pendingBox) { select(commitWhiteout(pendingBox.rec, pendingBox.el)); pendingBox = null; }
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
    focusedEl = null; savedRange = null; pendingStyle = null; pendingAt = -1;
    disarmSig();
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
  // an empty white box does not say "draw here" — ghost a prompt on it (the ruled
  // baseline is a CSS background, deliberately NOT canvas ink). This IS canvas ink, so
  // it must be wiped before the first stroke or trimToInk would export it.
  var padPlaceholder = false, padHadPlaceholder = false;
  function drawPadPlaceholder() {
    padCtx.clearRect(0, 0, pad.width, pad.height);
    padCtx.save();
    padCtx.fillStyle = 'rgba(60,60,60,0.34)';
    padCtx.font = '13px Arial, Helvetica, sans-serif';
    padCtx.textAlign = 'center'; padCtx.textBaseline = 'middle';
    padCtx.fillText('Draw your signature here', pad.width / 2, pad.height / 2 - 4);
    padCtx.restore();
    padPlaceholder = true;
  }
  function clearPadPlaceholder() {
    if (!padPlaceholder) return;
    padPlaceholder = false;
    padCtx.clearRect(0, 0, pad.width, pad.height);
  }
  drawPadPlaceholder();
  function padPos(e) { var r = pad.getBoundingClientRect(); return { x: (e.clientX - r.left) * pad.width / r.width, y: (e.clientY - r.top) * pad.height / r.height }; }
  pad.addEventListener('pointerdown', function (e) {
    if (e.button != null && e.button !== 0) return;
    drawing = true; last = padPos(e); padPid = e.pointerId;
    // pre-stroke snapshot so Escape can abort the stroke instead of closing the editor
    // (taken BEFORE the placeholder is wiped, so an aborted first stroke restores it)
    try { padSnap = padCtx.getImageData(0, 0, pad.width, pad.height); } catch (er) { padSnap = null; }
    padHadPlaceholder = padPlaceholder;
    clearPadPlaceholder();
    try { pad.setPointerCapture(e.pointerId); } catch (er) {}
    e.preventDefault();
  });
  pad.addEventListener('pointermove', function (e) { if (!drawing) return; var p = padPos(e); padCtx.strokeStyle = '#111'; padCtx.lineWidth = 2.2; padCtx.lineCap = 'round'; padCtx.beginPath(); padCtx.moveTo(last.x, last.y); padCtx.lineTo(p.x, p.y); padCtx.stroke(); last = p; });
  function commitPad() {
    if (!drawing) return;
    drawing = false; padSnap = null; padPid = null;
    var ink = trimToInk(pad);
    if (ink) sigCanvas = ink;
    else if (padHadPlaceholder) drawPadPlaceholder();   // a tap that drew nothing: bring the prompt back
    sigReady();
  }
  // Escape mid-stroke: abort the stroke (restore the pad's pre-stroke ink), keep the editor
  function abortPadStroke() {
    if (!drawing) return;
    drawing = false; last = null;
    if (padPid != null) { try { pad.releasePointerCapture(padPid); } catch (er) {} padPid = null; }
    padCtx.clearRect(0, 0, pad.width, pad.height);
    if (padSnap) { try { padCtx.putImageData(padSnap, 0, 0); } catch (er) {} }
    padPlaceholder = padHadPlaceholder;   // the restored pixels are the placeholder again
    padSnap = null;
  }
  pad.addEventListener('pointerup', commitPad); pad.addEventListener('pointercancel', commitPad);
  $('pt-sig-clear').addEventListener('click', function () { drawPadPlaceholder(); sigCanvas = null; sigReady(); });
  var sigFile = $('pt-sigfile');
  $('pt-sig-pick').addEventListener('click', function () { sigFile.click(); });
  // shared by the file input and by images DROPPED onto the open editor (PT.onEditorDrop)
  function loadSigFile(f) {
    var url = URL.createObjectURL(f), im = new Image();
    im.onload = function () {
      URL.revokeObjectURL(url);
      var c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
      c.getContext('2d').drawImage(im, 0, 0); sigCanvas = c; sigReady();
      edNotice(coarse() ? 'Signature image loaded. Tap Place, then tap where it goes.' : 'Signature image loaded. Click Place, then click where it goes.');
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
          edNotice(coarse() ? 'Signature loaded. Tap Place, then tap where it goes.' : 'Signature loaded. Click Place, then click where it goes.');
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

  // ---------- pointer-placed signatures (ruling 12.6) ----------
  var sigPlacing = false;   // a double-click must not run the async place chain twice
                            // (it would stack two identical, invisible-duplicate signatures)
  var sigArmed = false, sigGhost = null;
  var placeBtn = $('pt-sig-place');
  function ghostSize() {
    var wpx = 0.28 * dispW;
    return { w: wpx, h: wpx * (sigCanvas.height / sigCanvas.width) };
  }
  function armSig() {
    if (!sigCanvas || sigPlacing) return;
    sigArmed = true;
    placeBtn.textContent = coarse() ? 'Tap where it goes' : 'Click where it goes';
    placeBtn.setAttribute('aria-pressed', 'true');
    stage.classList.add('pt-stage--placing');
    if (!sigGhost) {
      sigGhost = document.createElement('img');
      sigGhost.className = 'pt-sigghost';
      sigGhost.alt = '';
      try { sigGhost.src = sigCanvas.toDataURL('image/png'); } catch (er) {}
      sigGhost.hidden = true;
      layer.appendChild(sigGhost);
    }
    edNotice(coarse() ? 'Tap the page where the signature goes.' : 'Click on the page where the signature goes.');
  }
  function disarmSig() {
    if (!sigArmed && !sigGhost) return;
    sigArmed = false;
    if (sigGhost) { sigGhost.remove(); sigGhost = null; }
    if (placeBtn) { placeBtn.textContent = 'Place on page'; placeBtn.setAttribute('aria-pressed', 'false'); }
    stage.classList.remove('pt-stage--placing');
  }
  function moveGhost(clientX, clientY) {
    if (!sigGhost || !sigCanvas) return;
    var r = layer.getBoundingClientRect(), g = ghostSize();
    sigGhost.style.width = g.w + 'px'; sigGhost.style.height = g.h + 'px';
    sigGhost.style.left = (clientX - r.left - g.w / 2) + 'px';
    sigGhost.style.top = (clientY - r.top - g.h / 2) + 'px';
    sigGhost.hidden = false;
  }
  stage.addEventListener('pointermove', function (e) { if (sigArmed) moveGhost(e.clientX, e.clientY); });
  // while armed, a pointerdown anywhere on the stage, the layer or any annotation drops
  // the signature and never edits text: capture phase, ahead of every other handler
  stage.addEventListener('pointerdown', function (e) {
    if (!sigArmed) return;
    if (e.button != null && e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    var pid = e.pointerId;
    moveGhost(e.clientX, e.clientY);
    function mv(ev) { if (ev.pointerId === pid) moveGhost(ev.clientX, ev.clientY); }
    function up(ev) {
      if (ev.pointerId !== pid) return;
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel);
      var r = layer.getBoundingClientRect();
      var nx = (ev.clientX - r.left) / dispW, ny = (ev.clientY - r.top) / dispH;
      disarmSig();
      placeSigAt(nx, ny);
    }
    function cancel(ev) { if (ev.pointerId === pid) { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); } }
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel);
  }, true);
  // the drop point is normalized FRACTIONS of the effective page, never layer pixels:
  // ensureUpright resolves through renderPage(), which clears the layer (destroying the
  // ghost), bumps renderSeq and re-measures dispW/dispH/scale
  function placeSigAt(nx, ny) {
    if (!sigCanvas || sigPlacing) return;
    sigPlacing = true;
    placeBtn.disabled = true;
    function done() { sigPlacing = false; sigReady(); }
    var myPg = pg;
    ensureUpright().then(function (flattened) {
      return PT.canvasToBytes(sigCanvas, 'image/png').then(function (png) {
        if (myPg !== pg) return;   // the user navigated away while the page was flattening
        if (!flattened && PT.snapshot) PT.snapshot('place signature on page ' + (idx + 1));
        var w = 0.28, h = w * (sigCanvas.height / sigCanvas.width) * (Wpt / Hpt);
        var s = { png: png, x: clamp01(nx - w / 2), y: clamp01(ny - h / 2), w: w, h: h };
        pg.sigs.push(s); var el = makeSigEl(s); layer.appendChild(el);
        PT.markDirty(pg);
        // setTool BEFORE select — setTool starts with a deselect, which used to wipe
        // the fresh selection and leave the just-placed sig with no ×/resize handles
        setTool('move'); select(el);
        edNotice('Signature placed. Drag it to adjust.');
      });
    }).then(done, function () {
      if (myPg === pg) edNotice('Could not place the signature on this page.');
      done();
    });
  }
  placeBtn.addEventListener('click', function (e) {
    if (!sigCanvas || sigPlacing) return;
    // keyboard activation (Enter or Space) has e.detail === 0 and no pointer to aim
    // with, so it keeps today's behaviour and places at the default spot at once
    if (e.detail === 0) { placeSigAt(0.5, 0.6 + (0.28 * (sigCanvas.height / sigCanvas.width) * (Wpt / Hpt)) / 2); return; }
    if (sigArmed) disarmSig(); else armSig();
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
            hint.textContent = 'This page has form fields, but they can only be filled while the page is upright. Rotate it in the page grid (filled values are kept). ' + hint.textContent;
            return;
          }
          var di = pg.docIndex, vals = (PT.docs()[di].formValues) || {};
          // the widgets go in BEFORE every annotation element, so a white-out or a
          // redaction drawn over a field covers it here as it does in the file (a filled
          // form is flattened into the page before the boxes are drawn); widget order
          // among themselves, and so their Tab order, is kept
          var under = layer.firstChild;
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
            layer.insertBefore(el, under);
          });
          if (hasFields) hint.textContent = 'This page has form fields (highlighted). Click into them to fill. ' + hint.textContent;
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
    var b = elBox(selected);
    m.x = Math.min(Math.max(0, m.x), 1 - (b.w / dispW) * 0.3);
    m.y = Math.min(Math.max(0, m.y), 1 - (b.h / dispH) * 0.3);
    selected.style.left = (m.x * dispW) + 'px'; selected.style.top = (m.y * dispH) + 'px';
    if (isText(selected)) placeBadge(selected);
    PT.markDirty(pg);
  }
  // keyboard path for redaction: drop a default-size box at the page center, then
  // nudge/resize is arrow keys + Delete (the stage is focusable, see the md markup)
  function keyboardRedact(kind) {
    kind = kind || 'redact';
    var rec = { x: 0.35, y: 0.44, w: 0.3, h: 0.08 };
    var box = document.createElement('div'); box.className = 'pt-anno pt-anno--' + kind + ' pt-anno--' + kind + '-tmp';
    box.style.left = (rec.x * dispW) + 'px'; box.style.top = (rec.y * dispH) + 'px';
    box.style.width = (rec.w * dispW) + 'px'; box.style.height = (rec.h * dispH) + 'px';
    layer.appendChild(box);
    if (!boxWarned(kind)) { askFirst(kind, rec, box); return; }
    select(commitBox(kind, rec, box));
  }
  function edFocusables() {
    return Array.prototype.filter.call(ed.querySelectorAll('button, input, select, [tabindex], [contenteditable="true"]'), function (el) {
      return !el.disabled && el.tabIndex >= 0 && el.getClientRects().length;
    });
  }
  // Ctrl+Z undoes (ours everywhere inside the editor, including a focused text box —
  // native contenteditable undo would replay browser markup our parser then reads as
  // user styling); Escape is STAGED (disarm a signature placement → cancel a redact drag
  // → abort a drag/resize → abort a pad stroke → end typing → deselect → close); Delete
  // removes the selection and arrows nudge it / change pages — gated on "not typing",
  // NOT on body focus (a clicked tool button keeps focus, and Delete/arrows used to go
  // dead in exactly that state)
  document.addEventListener('keydown', function (e) {
    if (ed.hidden) return;
    if (!redactDialog.hidden) { if (e.key === 'Escape') dialogCancel(); return; }   // core traps Tab in modals
    if (!whiteDialog.hidden) { if (e.key === 'Escape') whiteDialogCancel(); return; }
    if (PT.modalOpen && PT.modalOpen()) return;
    var a = document.activeElement;
    var typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable
      || !!(a.closest && a.closest('.pt-ed__bar, .pt-ed__textbar, .pt-ed__signbar')));
    if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && !e.altKey) {
      e.preventDefault();                                   // never the browser's own undo/redo
      if (!e.shiftKey && !(PT.isBusy && PT.isBusy())) PT.undo();
      return;
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
      if (sigArmed) { disarmSig(); edNotice('Signature placement cancelled.'); return; }
      if (activeRedactCancel) { activeRedactCancel(); return; }   // cancel the in-flight box only
      if (activeDragCancel) { activeDragCancel(); return; }       // abort an annotation drag/resize
      if (drawing) { abortPadStroke(); return; }                  // abort a sig-pad stroke
      if (typing) { clearPending(); a.blur(); return; }           // end the edit, keep the editor open
      if (selected) { deselectAll(); selected = null; syncBars(); syncTextBar(); return; }
      close(); return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;   // Ctrl+Delete / Alt+arrows are not ours
    if (e.key === 'Enter' && selected && isText(selected) && a === selected && !focusedEl) {
      e.preventDefault(); promote(selected, null); return;        // Tab to a box, Enter to edit it
    }
    if ((e.key === 'Enter' || e.key === ' ') && a === stage) {
      // stage focused: create with the current tool at the page center
      if (tool === 'text') { e.preventDefault(); createTextAt(0.4, 0.44); }
      else if (tool === 'redact' || tool === 'whiteout') { e.preventDefault(); keyboardRedact(tool); }
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
  var edNoticeTimer = 0, edNoticeMsg = null, edNoticePrev = '';
  function edNotice(msg, ms) {
    var prev = (edNoticeTimer && hint.textContent === edNoticeMsg) ? edNoticePrev : hint.textContent;
    noteHint();
    hint.textContent = msg;
    holdHint();
    clearTimeout(edNoticeTimer);
    edNoticeMsg = msg; edNoticePrev = prev;
    edNoticeTimer = setTimeout(function () { edNoticeTimer = 0; if (hint.textContent === msg) hint.textContent = prev; }, ms || 4000);
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
    // a new document: no old pick, and the select drops it if it shows it (the slot stays:
    // it is matched by page and state, never to another page)
    if (pickedSize != null && sizeSel.value === String(pickedSize) && !boxTarget()) sizeSel.value = '14';
    pickedSize = null;
    if (ed.hidden) return;
    pageLabel.textContent = 'Page ' + (idx + 1) + ' of ' + PT.pages().length;
    updateNav();
    edNotice('Pages added at the end. Use › or the arrow keys to reach them.');
  };

  // expose the opener for the thumbnail Edit buttons
  PT.openEditor = open;
  // test hook: the suites read the editor's own view of a box (spec 12.7)
  PT.edState = function () {
    return {
      tool: tool, idx: idx, scale: scale, Wpt: Wpt, Hpt: Hpt, dispW: dispW, dispH: dispH,
      selected: selected ? annoKind(selected) : null,
      focused: !!focusedEl,
      sigArmed: sigArmed,
      layout: selected && isText(selected) ? selected.__layout : null
    };
  };
})();
