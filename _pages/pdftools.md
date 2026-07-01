---
layout: single
title: "PDF Toolbench"
permalink: /pdftools/
author_profile: false
excerpt: "Merge, split, reorder, rotate, redact, sign, and fill PDFs — privately, in your browser."
description: "A private, in-browser PDF toolbench by Keane Lucas: merge and split PDFs, reorder, rotate, and delete pages, add text and signatures, fill forms, redact (by rasterizing so the underlying text is removed), strip metadata, and shrink files. Everything runs locally in your browser; your PDFs are never uploaded."
---

<div class="pt-wrap">

  <p class="pt-intro">
    A PDF utility that runs entirely in your browser. Merge files, reorder, rotate, and delete pages,
    pull out a range, add text or a signature, fill in forms, redact a page so the hidden text is
    actually gone, strip metadata, or shrink the file. Everything runs locally on your device, and
    your PDFs are never uploaded.
  </p>
  <p class="pt-privacy">🔒 Everything runs locally in your browser. Your PDF is never uploaded and never leaves your device.</p>

  <div class="pt-toolbar" id="pt-toolbar" hidden>
    <button id="pt-add" class="pt-btn" type="button">+ Add files</button>
    <span class="pt-count" id="pt-count"></span>
    <span class="pt-sep"></span>
    <button id="pt-selall" class="pt-btn" type="button" title="Select all / none">Select all</button>
    <button id="pt-rotate" class="pt-btn" type="button" disabled title="Rotate selected pages 90°">⟳ Rotate</button>
    <button id="pt-delete" class="pt-btn" type="button" disabled title="Delete selected pages">🗑 Delete</button>
    <button id="pt-shrink" class="pt-btn" type="button" disabled title="Shrink the file by rasterizing pages">⤓ Shrink…</button>
    <span class="pt-spacer"></span>
    <label class="pt-check" title="Remove author / producer / dates on download"><input type="checkbox" id="pt-stripmeta" checked> Strip metadata</label>
    <button id="pt-extract" class="pt-btn" type="button" disabled title="Save only the selected pages as one PDF">Extract selected</button>
    <button id="pt-split" class="pt-btn" type="button" title="Save every page as its own PDF, bundled in a .zip">Split → .zip</button>
    <button id="pt-download" class="pt-btn pt-btn--accent" type="button" disabled>Download PDF</button>
  </div>

  <div id="pt-drop" class="pt-drop">
    <input id="pt-file" type="file" accept="application/pdf,.pdf,image/*" multiple hidden style="display:none!important">
    <div class="pt-grid" id="pt-grid"></div>
    <div class="pt-drop__hint" id="pt-hint"><strong>Drop PDFs or images here</strong><br>or click to choose</div>
  </div>

  <p class="pt-status" id="pt-status"></p>
  <p class="pt-engine" id="pt-engine" hidden>Loading the PDF engine…</p>
  <p class="pt-note">Click a page (or its ✎) to open it for editing — add text, a signature, redactions,
  or fill form fields. Drag a thumbnail to reorder. Images are turned into pages; adding several files
  merges them into one document, in the order shown.</p>
  <p class="pt-credit">Built on two open-source libraries:
    <a href="https://github.com/mozilla/pdf.js" target="_blank" rel="noopener">pdf.js</a>
    by Mozilla (Apache&nbsp;2.0) for rendering, and
    <a href="https://github.com/Hopding/pdf-lib" target="_blank" rel="noopener">pdf-lib</a>
    (MIT) for editing. Thank you to their authors.</p>
</div>

<!-- Redaction confirm dialog (reused by the page editor's Redact tool) -->
<div class="pt-modal" id="pt-dialog" hidden>
  <div class="pt-modal__box pt-modal__box--narrow">
    <div class="pt-modal__head"><strong>Permanently redact this page?</strong></div>
    <div class="pt-dialog__body">
      <p>Real redaction can't just draw a black box: the text underneath would still sit in the file and
        could be copied straight back out. To actually remove it, this tool <strong>rasterizes the
        page</strong> — it renders the page to an image, paints the black boxes onto that image, and
        replaces the page with the flat image. The hidden content is then gone.</p>
      <p class="pt-dialog__tradeoff"><strong>Trade-off:</strong> the redacted page becomes an image, so
        its text is no longer selectable or searchable, and the file may be a little larger.</p>
      <label class="pt-field"><span>Render quality</span>
        <select id="pt-redact-dpi">
          <option value="150">Standard — 150 DPI</option>
          <option value="220">High — 220 DPI (crisper, larger)</option>
          <option value="100">Smaller file — 100 DPI</option>
        </select>
      </label>
    </div>
    <div class="pt-modal__foot">
      <button id="pt-dialog-cancel" class="pt-btn" type="button">Cancel</button>
      <span class="pt-spacer"></span>
      <button id="pt-dialog-go" class="pt-btn pt-btn--danger" type="button">Redact &amp; flatten</button>
    </div>
  </div>
</div>

<!-- Shrink (compress) dialog -->
<div class="pt-modal" id="pt-shrink-dialog" hidden>
  <div class="pt-modal__box pt-modal__box--narrow">
    <div class="pt-modal__head"><strong>Shrink the PDF</strong></div>
    <div class="pt-dialog__body">
      <p>This shrinks the file by <strong>rendering every page to an image</strong> at the chosen
        quality and rebuilding the PDF from those images. It's most effective on scans and image-heavy
        documents.</p>
      <p class="pt-dialog__tradeoff"><strong>Trade-off:</strong> like redaction, the pages become images,
        so text is no longer selectable or searchable. (Your original file is untouched; this downloads a copy.)</p>
      <label class="pt-field"><span>Quality</span>
        <select id="pt-shrink-dpi">
          <option value="150,0.7">Standard — 150 DPI</option>
          <option value="110,0.6">Smaller — 110 DPI</option>
          <option value="220,0.8">Higher quality — 220 DPI</option>
        </select>
      </label>
    </div>
    <div class="pt-modal__foot">
      <button id="pt-shrink-cancel" class="pt-btn" type="button">Cancel</button>
      <span class="pt-spacer"></span>
      <button id="pt-shrink-go" class="pt-btn pt-btn--accent" type="button">Shrink &amp; download</button>
    </div>
  </div>
</div>

<!-- ===================== Unified page editor ===================== -->
<div class="pt-ed" id="pt-ed" hidden>
  <div class="pt-ed__bar">
    <button id="pt-ed-done" class="pt-btn pt-btn--accent" type="button">Done</button>
    <span class="pt-ed__page" id="pt-ed-page"></span>
    <span class="pt-ed__tools">
      <button id="pt-tool-move" class="pt-btn pt-tool pt-tool--on" type="button" title="Move / select (V)">↖ Move</button>
      <button id="pt-tool-text" class="pt-btn pt-tool" type="button" title="Add text (T)">T Text</button>
      <button id="pt-tool-sign" class="pt-btn pt-tool" type="button" title="Add a signature">✎ Sign</button>
      <button id="pt-tool-redact" class="pt-btn pt-tool" type="button" title="Redact (rasterizes the page)">▮ Redact</button>
    </span>
    <span class="pt-ed__opts" id="pt-text-opts" hidden>
      <select id="pt-text-font" title="Font">
        <option value="Helvetica">Helvetica</option>
        <option value="Times">Times</option>
        <option value="Courier">Courier</option>
      </select>
      <select id="pt-text-size" title="Font size"></select>
      <input id="pt-text-color" type="color" value="#111111" title="Text color">
    </span>
    <span class="pt-ed__opts" id="pt-redact-opts" hidden>
      <button id="pt-ed-redact-apply" class="pt-btn pt-btn--danger" type="button" disabled>Apply redaction</button>
    </span>
    <span class="pt-spacer"></span>
    <button id="pt-ed-prev" class="pt-btn" type="button" title="Previous page">‹</button>
    <button id="pt-ed-next" class="pt-btn" type="button" title="Next page">›</button>
  </div>

  <div class="pt-ed__signbar" id="pt-ed-signbar" hidden>
    <div class="pt-tabs">
      <button id="pt-sign-tab-draw" class="pt-btn pt-tab pt-tab--on" type="button">Draw</button>
      <button id="pt-sign-tab-upload" class="pt-btn pt-tab" type="button">Upload</button>
    </div>
    <div id="pt-sign-draw" class="pt-signbar__src">
      <canvas id="pt-sigpad" class="pt-sigpad" width="300" height="110"></canvas>
      <button id="pt-sig-clear" class="pt-btn" type="button">Clear</button>
    </div>
    <div id="pt-sign-upload" class="pt-signbar__src" hidden>
      <input id="pt-sigfile" type="file" accept="image/*" hidden style="display:none!important">
      <button id="pt-sig-pick" class="pt-btn" type="button">Choose image…</button>
    </div>
    <button id="pt-sig-place" class="pt-btn pt-btn--accent" type="button" disabled>Place on page</button>
    <span class="pt-ed__hint">Draw or upload, then “Place on page” and drag it where you want.</span>
  </div>

  <div class="pt-ed__scroll" id="pt-ed-scroll">
    <div class="pt-ed__stage" id="pt-ed-stage">
      <canvas id="pt-ed-canvas" class="pt-ed__canvas"></canvas>
      <div class="pt-ed__layer" id="pt-ed-layer"></div>
    </div>
  </div>
  <button class="pt-ed__arrow pt-ed__arrow--left" id="pt-ed-arrow-left" type="button" aria-label="Previous page" title="Previous page">‹</button>
  <button class="pt-ed__arrow pt-ed__arrow--right" id="pt-ed-arrow-right" type="button" aria-label="Next page" title="Next page">›</button>
  <div class="pt-ed__hintbar" id="pt-ed-hint"></div>
</div>

<style>
/* Utility page, not an article — use more than the reading column. */
#main { max-width: 1240px; }
.page { float: none; width: 100%; padding-left: 0; padding-right: 0; }
.page__inner-wrap, .page__content { max-width: 100%; }
.pt-wrap { max-width: 1180px; margin: 0 auto; }
.pt-intro { max-width: 70ch; opacity: 0.9; line-height: 1.6; margin-bottom: 0.4rem; }
.pt-privacy { font-size: 0.9em; opacity: 0.8; margin: 0 0 1.1rem; }

/* Buttons (same look as Image Studio). */
.pt-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14);
  border-radius: 6px; padding: 0.5em 0.8em; transition: background 0.15s ease;
}
.pt-btn:hover:not(:disabled) { background: rgba(127,127,127,0.26); }
.pt-btn:disabled { opacity: 0.45; cursor: default; }
.pt-btn--accent { background: #82a6cc; border-color: #82a6cc; color: #fff; }
.pt-btn--accent:hover:not(:disabled) { background: #6f97c2; }
.pt-btn--danger { background: #c4574a; border-color: #c4574a; color: #fff; }
.pt-btn--danger:hover:not(:disabled) { background: #b04438; }
html[data-theme="light"] .pt-btn--accent { background: #34568a; border-color: #34568a; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .pt-btn--accent { background: #34568a; border-color: #34568a; } }

.pt-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.45rem; margin-bottom: 1rem; }
.pt-sep { width: 1px; align-self: stretch; background: rgba(127,127,127,0.3); margin: 0 0.2rem; }
.pt-spacer { flex: 1 1 auto; }
.pt-count { font-size: 0.85em; opacity: 0.7; font-variant-numeric: tabular-nums; }
.pt-check { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.9em; cursor: pointer; }
.pt-check input { accent-color: #82a6cc; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .pt-check input { accent-color: #34568a; } }
html[data-theme="light"] .pt-check input { accent-color: #34568a; }

.pt-drop {
  position: relative; border: 2px dashed rgba(127,127,127,0.4); border-radius: 12px;
  background: rgba(127,127,127,0.05); min-height: 280px; padding: 1rem; cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.pt-drop--over { border-color: #82a6cc; background: rgba(130,166,204,0.10); }
.pt-drop--has { cursor: default; }
.pt-drop--has .pt-drop__hint { display: none; }
#pt-file { display: none !important; }
.pt-drop__hint { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); text-align: center; opacity: 0.7; pointer-events: none; line-height: 1.7; }

.pt-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 0.9rem; }
.pt-thumb {
  position: relative; border: 1px solid rgba(127,127,127,0.3); border-radius: 8px; overflow: hidden;
  background: rgba(127,127,127,0.06); cursor: grab; user-select: none;
}
.pt-thumb.pt-sel { border-color: #82a6cc; box-shadow: 0 0 0 2px rgba(130,166,204,0.55) inset; }
html[data-theme="light"] .pt-thumb.pt-sel { border-color: #34568a; box-shadow: 0 0 0 2px rgba(52,86,138,0.5) inset; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .pt-thumb.pt-sel { border-color: #34568a; box-shadow: 0 0 0 2px rgba(52,86,138,0.5) inset; } }
.pt-thumb--drag { opacity: 0.4; }
.pt-thumb--over { outline: 2px dashed #82a6cc; outline-offset: -2px; }
.pt-thumb__canvas { width: 100%; display: block; background: #fff; }
.pt-thumb__bar { display: flex; align-items: center; justify-content: space-between; gap: 0.3rem; padding: 0.25rem 0.4rem; font-size: 0.74rem; opacity: 0.85; }
.pt-thumb__num { font-variant-numeric: tabular-nums; }
.pt-thumb__redacted { color: #c4574a; font-weight: 700; }
.pt-thumb__acts { display: flex; gap: 0.2rem; }
.pt-thumb__act { font: inherit; font-size: 0.85em; line-height: 1; cursor: pointer; color: inherit; border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14); border-radius: 4px; padding: 0.15em 0.35em; }
.pt-thumb__act:hover { background: rgba(127,127,127,0.3); }

.pt-status { font-size: 0.9em; opacity: 0.9; min-height: 1.2em; margin: 0.9rem 0 0.2rem; }
.pt-engine { font-size: 0.85em; opacity: 0.7; margin: 0.2rem 0; }
.pt-note { font-size: 0.82em; opacity: 0.65; line-height: 1.5; margin: 0.4rem 0 0; }
.pt-credit { font-size: 0.8em; opacity: 0.6; line-height: 1.5; margin: 0.5rem 0 0; }

.pt-field { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.95em; margin: 0.8rem 0 0; }
.pt-field select { font: inherit; padding: 0.45em 0.5em; border-radius: 6px; color: #e8e8e8; background: #20242c; border: 1px solid rgba(255,255,255,0.18); }
.pt-field select option { color: #e8e8e8; background: #20242c; }
html[data-theme="light"] .pt-field select { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.2); }
html[data-theme="light"] .pt-field select option { color: #1f2430; background: #fff; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .pt-field select { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.2); }
  html:not([data-theme="dark"]) .pt-field select option { color: #1f2430; background: #fff; }
}

/* Modal / dialog */
.pt-modal { position: fixed; inset: 0; z-index: 1300; display: flex; align-items: center; justify-content: center; padding: 1rem; background: rgba(0,0,0,0.55); -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px); }
.pt-modal[hidden] { display: none !important; }   /* the hidden attr loses to display:flex otherwise */
.pt-modal__box { width: min(900px, 96vw); max-height: 92vh; display: flex; flex-direction: column; gap: 0.7rem; padding: 1rem 1.1rem 1.1rem; border-radius: 12px; background: #16181d; border: 1px solid rgba(255,255,255,0.12); box-shadow: 0 14px 50px rgba(0,0,0,0.5); }
.pt-modal__box--narrow { width: min(540px, 96vw); }
html[data-theme="light"] .pt-modal__box { background: #fff; border-color: rgba(0,0,0,0.14); }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .pt-modal__box { background: #fff; border-color: rgba(0,0,0,0.14); } }
.pt-modal__head { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; font-size: 1.05rem; }
.pt-modal__hint { font-size: 0.86rem; opacity: 0.8; line-height: 1.5; margin: 0; }
.pt-modal__foot { display: flex; align-items: center; gap: 0.5rem; }
.pt-canvas-wrap { overflow: auto; background: rgba(127,127,127,0.12); border-radius: 8px; display: flex; justify-content: center; align-items: flex-start; min-height: 200px; max-height: 64vh; }
.pt-editor { display: block; cursor: crosshair; touch-action: none; background: #fff; }
.pt-dialog__body p { font-size: 0.9rem; line-height: 1.55; margin: 0 0 0.6rem; }
.pt-dialog__tradeoff { opacity: 0.95; }

/* Signature editor */
.pt-sign-grid { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 1rem; align-items: start; }
@media (max-width: 720px) { .pt-sign-grid { grid-template-columns: 1fr; } }
.pt-sign-source { display: flex; flex-direction: column; gap: 0.6rem; }
.pt-tabs { display: flex; gap: 0.4rem; }
.pt-tab--on { background: #82a6cc; border-color: #82a6cc; color: #fff; }
html[data-theme="light"] .pt-tab--on { background: #34568a; border-color: #34568a; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .pt-tab--on { background: #34568a; border-color: #34568a; } }
.pt-sigpad { width: 100%; height: 140px; background: #fff; border: 1px dashed rgba(127,127,127,0.5); border-radius: 6px; cursor: crosshair; touch-action: none; display: block; }
.pt-sign-row { display: flex; align-items: center; gap: 0.6rem; }
#pt-sigfile { display: none !important; }
.pt-sign-place { display: flex; flex-direction: column; gap: 0.4rem; }

/* Form fill */
.pt-form-fields { display: flex; flex-direction: column; gap: 0.7rem; overflow: auto; max-height: 56vh; padding: 0.2rem; }
.pt-form-field { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.9rem; }
.pt-form-field > span { opacity: 0.85; word-break: break-word; }
.pt-form-field input[type="text"], .pt-form-field select {
  font: inherit; padding: 0.4em 0.5em; border-radius: 6px;
  color: #e8e8e8; background: #20242c; border: 1px solid rgba(255,255,255,0.18);
}
.pt-form-field input[type="checkbox"] { width: 1.1em; height: 1.1em; accent-color: #82a6cc; }
html[data-theme="light"] .pt-form-field input[type="text"], html[data-theme="light"] .pt-form-field select { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.2); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .pt-form-field input[type="text"], html:not([data-theme="dark"]) .pt-form-field select { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.2); }
}
.pt-form-empty { font-size: 0.9rem; opacity: 0.8; }
.pt-sigpad { width: 300px; max-width: 60vw; height: 110px; }

/* ===================== Unified page editor ===================== */
.pt-ed { position: fixed; inset: 0; z-index: 1200; display: flex; flex-direction: column; background: #14161a; }
.pt-ed[hidden] { display: none !important; }
html[data-theme="light"] .pt-ed { background: #eef0f3; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .pt-ed { background: #eef0f3; } }
.pt-ed__bar { display: flex; align-items: center; gap: 0.5rem; padding: 0.55rem 0.8rem; flex-wrap: wrap; border-bottom: 1px solid rgba(127,127,127,0.25); background: rgba(127,127,127,0.06); }
.pt-ed__page { font-size: 0.85rem; opacity: 0.75; font-variant-numeric: tabular-nums; }
.pt-ed__tools { display: inline-flex; gap: 0.3rem; }
.pt-tool--on { background: #82a6cc; border-color: #82a6cc; color: #fff; }
html[data-theme="light"] .pt-tool--on { background: #34568a; border-color: #34568a; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .pt-tool--on { background: #34568a; border-color: #34568a; } }
.pt-ed__opts { display: inline-flex; align-items: center; gap: 0.35rem; }
.pt-ed__opts[hidden] { display: none; }
.pt-ed__opts select { font: inherit; padding: 0.35em 0.4em; border-radius: 6px; color: #e8e8e8; background: #20242c; border: 1px solid rgba(255,255,255,0.18); }
.pt-ed__opts input[type="color"] { width: 30px; height: 30px; padding: 0; border: 1px solid rgba(127,127,127,0.4); border-radius: 6px; background: none; cursor: pointer; }
html[data-theme="light"] .pt-ed__opts select { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.2); }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .pt-ed__opts select { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.2); } }
.pt-ed__signbar { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; padding: 0.5rem 0.8rem; border-bottom: 1px solid rgba(127,127,127,0.25); }
.pt-ed__signbar[hidden] { display: none; }
.pt-signbar__src { display: inline-flex; align-items: center; gap: 0.5rem; }
.pt-ed__scroll { flex: 1 1 auto; overflow: auto; display: flex; justify-content: center; align-items: flex-start; padding: 1rem; }
.pt-ed__stage { position: relative; box-shadow: 0 6px 30px rgba(0,0,0,0.4); background: #fff; }
.pt-ed__canvas { display: block; }
.pt-ed__layer { position: absolute; inset: 0; }
.pt-ed__hintbar { padding: 0.4rem 0.8rem; font-size: 0.82rem; opacity: 0.7; min-height: 1.2em; border-top: 1px solid rgba(127,127,127,0.2); }
.pt-ed__arrow { position: absolute; top: 50%; transform: translateY(-50%); z-index: 5; width: 46px; height: 70px; border: none; border-radius: 10px; background: rgba(127,127,127,0.28); color: #fff; font-size: 2.2rem; line-height: 1; cursor: pointer; opacity: 0.55; transition: opacity 0.15s ease, background 0.15s ease; }
.pt-ed__arrow:hover:not(:disabled) { opacity: 1; background: rgba(130,166,204,0.6); }
.pt-ed__arrow:disabled { opacity: 0; pointer-events: none; }
.pt-ed__arrow--left { left: 12px; }
.pt-ed__arrow--right { right: 12px; }

/* annotations live inside .pt-ed__layer */
.pt-anno { position: absolute; box-sizing: border-box; }
.pt-anno--text { cursor: text; }
.pt-anno__txt { min-width: 1ch; padding: 0; line-height: 1.2; white-space: pre; outline: none; }
.pt-anno--text.pt-sel, .pt-anno--sig.pt-sel { outline: 1px dashed #82a6cc; outline-offset: 1px; }
.pt-anno--sig { cursor: move; }
.pt-anno--sig img { width: 100%; height: 100%; display: block; pointer-events: none; }
.pt-anno__del { position: absolute; top: -10px; right: -10px; width: 18px; height: 18px; line-height: 16px; text-align: center; font-size: 12px; border-radius: 50%; border: none; background: #c4574a; color: #fff; cursor: pointer; padding: 0; }
.pt-anno__resize { position: absolute; right: -6px; bottom: -6px; width: 12px; height: 12px; background: #82a6cc; border: 1px solid #fff; border-radius: 2px; cursor: nwse-resize; }
.pt-anno--redact { background: rgba(20,20,20,0.82); border: 1px solid #c4574a; }
.pt-formwidget { position: absolute; box-sizing: border-box; font: inherit; border: 1px solid #82a6cc; background: rgba(130,166,204,0.18); color: #111; padding: 0 2px; }
.pt-formwidget[type="checkbox"] { background: #fff; }
.pt-stage--text { cursor: text; }
.pt-stage--redact { cursor: crosshair; }
</style>

<script defer src="{{ '/assets/js/pdflib/pdf-lib.min.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/pdflib/pdfjs/pdf.min.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/pdftools.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/pdftools-editor.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
