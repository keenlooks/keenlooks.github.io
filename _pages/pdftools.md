---
layout: single
title: "PDF Toolbench: merge, redact, sign, OCR & compress PDFs in your browser"
permalink: /pdftools/
author_profile: false
excerpt: "Merge, split, reorder, redact, sign, fill, OCR, watermark, compress, and password-protect PDFs privately, in your browser."
description: "Free private PDF tools that run entirely in your browser: merge and split PDFs, reorder and rotate pages, fill forms, add signatures, redact so hidden text is truly removed, make scanned PDFs searchable with OCR, add watermarks and page numbers, export pages as images, compress, and password-protect with AES-256. Your files are never uploaded."
---

<div class="pt-wrap">

  <h1 class="pt-h1">PDF Toolbench</h1>

  <p class="pt-intro">
    A PDF utility that runs entirely in your browser. Merge files, reorder, rotate, and delete pages,
    pull out a range, add text or a signature, fill in forms, redact a page so the hidden text is
    actually gone, make a scanned PDF searchable with OCR, add watermarks or page numbers, export
    pages as images, strip metadata, shrink the file, or lock it with a password. Everything runs
    locally on your device, your PDFs are never uploaded, and Ctrl+Z undoes mistakes.
  </p>
  <p class="pt-privacy">🔒 Everything runs locally in your browser. Your PDF is never uploaded and never leaves your device. (I use Google Analytics to see whether anyone visits this page, but it cannot see your files or anything you do with them.)</p>
  <p class="pt-privacy" style="margin-top:-0.55rem">A caveat: this is a personal side project and I have not tested it exhaustively. I make no guarantees; keep your originals and check the output before relying on it.</p>

  <div class="pt-toolbar" id="pt-toolbar" hidden>
    <div class="pt-toolbar__row">
      <button id="pt-add" class="pt-btn" type="button">+ Add files</button>
      <span class="pt-count" id="pt-count"></span>
      <span class="pt-sep"></span>
      <button id="pt-selall" class="pt-btn" type="button" title="Select all / none">Select all</button>
      <button id="pt-rotate" class="pt-btn" type="button" disabled title="Rotate selected pages 90° clockwise">⟳ Rotate</button>
      <button id="pt-rotccw" class="pt-btn" type="button" disabled title="Rotate selected pages 90° counterclockwise">⟲</button>
      <button id="pt-dup" class="pt-btn" type="button" disabled title="Duplicate selected pages">⧉ Duplicate</button>
      <button id="pt-blank" class="pt-btn" type="button" title="Insert a blank page (after the selection, or at the end)">▭ Blank page</button>
      <button id="pt-delete" class="pt-btn" type="button" disabled title="Delete selected pages">🗑 Delete</button>
      <span class="pt-sep"></span>
      <button id="pt-undo" class="pt-btn" type="button" disabled title="Undo (Ctrl+Z)">↶ Undo</button>
      <span class="pt-spacer"></span>
      <input id="pt-range" class="pt-range" type="text" placeholder="Pages: 1-5, 9, 12-" title="Page range for the selected-pages download and Split, e.g. 1-5,9,12-" autocomplete="off">
      <span class="pt-range-info" id="pt-range-info"></span>
      <button id="pt-extract" class="pt-btn" type="button" disabled title="Download ONLY the selected pages (or the range in the Pages box) as their own PDF. The document here stays as it is.">Download selected</button>
      <button id="pt-split" class="pt-btn" type="button" title="Save every page (or the range above) as its own PDF, bundled in a .zip">Split → .zip</button>
      <button id="pt-download" class="pt-btn pt-btn--accent" type="button" disabled title="Download the whole document: every page shown above, in this order, with all edits applied">Download all</button>
    </div>
    <div class="pt-toolbar__row">
      <button id="pt-ocr" class="pt-btn" type="button" data-pt-needs-pages disabled title="Add an invisible, searchable text layer to scanned pages (OCR)">Make searchable (OCR)…</button>
      <button id="pt-watermark" class="pt-btn" type="button" data-pt-needs-pages disabled title="Stamp text like DRAFT across pages">Watermark…</button>
      <button id="pt-pagenums" class="pt-btn" type="button" data-pt-needs-pages disabled title="Add page numbers">Page numbers…</button>
      <button id="pt-images" class="pt-btn" type="button" data-pt-needs-pages disabled title="Export pages as PNG or JPEG images">Pages → images…</button>
      <button id="pt-shrink" class="pt-btn" type="button" data-pt-needs-pages disabled title="Shrink the file by rasterizing pages">⤓ Shrink…</button>
      <button id="pt-protect" class="pt-btn" type="button" data-pt-needs-pages disabled title="Encrypt the PDF with a password (AES-256)">Protect…</button>
      <span class="pt-spacer"></span>
      <label class="pt-check" title="Remove author / producer / dates on download"><input type="checkbox" id="pt-stripmeta" checked> Strip metadata</label>
    </div>
  </div>

  <div class="pt-progress" id="pt-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" hidden><div class="pt-progress__fill" id="pt-progress-fill"></div></div>

  <div id="pt-drop" class="pt-drop" tabindex="0" role="button" aria-label="Add PDF or image files">
    <input id="pt-file" type="file" accept="application/pdf,.pdf,image/*" multiple hidden style="display:none!important">
    <div class="pt-grid" id="pt-grid"></div>
    <div class="pt-drop__hint" id="pt-hint"><strong>Drop PDFs or images here</strong><br>or click to choose</div>
  </div>

  <p class="pt-status" id="pt-status" role="status" aria-live="polite"></p>
  <p class="pt-engine" id="pt-engine" hidden>Loading the PDF engine…</p>
  <p class="pt-note">Double-click a page — double-tap on a phone — or click its ✎ to open it for editing: add text, a signature,
  redactions, or fill form fields. A single click selects; drag a thumbnail to reorder (press and hold on
  a phone). Shift-click selects a run of pages, and the Pages box takes a range like 1-5,9,12- for the
  selected-pages download and Split. <strong>Download all</strong> saves the whole document as one PDF;
  <strong>Download selected</strong> saves just the selected pages (or the typed range) as their own PDF
  and leaves the document here untouched. Images are turned
  into pages; adding several files merges them into one document, in the order shown. Ctrl+Z (or the
  Undo button) reverses the last change.</p>
  <p class="pt-credit">Built on open-source libraries:
    <a href="https://github.com/mozilla/pdf.js" target="_blank" rel="noopener">pdf.js</a>
    by Mozilla (Apache&nbsp;2.0) for rendering,
    <a href="https://github.com/Hopding/pdf-lib" target="_blank" rel="noopener">pdf-lib</a>
    (MIT) for editing,
    <a href="https://github.com/naptha/tesseract.js" target="_blank" rel="noopener">tesseract.js</a>
    (Apache&nbsp;2.0) for OCR, and
    <a href="https://github.com/qpdf/qpdf" target="_blank" rel="noopener">qpdf</a>
    (Apache&nbsp;2.0, compiled to WebAssembly) for encryption. All are served from this site,
    never from a third-party CDN. Thank you to their authors.</p>

  <div class="pt-faq">
    <h2>Common questions</h2>
    <details>
      <summary>How do I redact a PDF without uploading it?</summary>
      <p>Add your PDF above, double-click the page (or click its ✎ button), choose the Redact tool, and draw boxes over anything you
      want removed. The boxes apply as soon as you draw them and stay with the page while you work
      (move them, delete them, or undo with Ctrl+Z). Real redaction cannot just draw a black rectangle,
      because the text underneath would still be in the file — so when you download, every page with
      boxes is re-rendered as an image with the boxes painted on, replacing the original page. The
      hidden text is actually gone. You can verify it yourself: try to select or search the redacted
      area in the downloaded file. Nothing is uploaded at any point.</p>
    </details>
    <details>
      <summary>How do I make a scanned PDF searchable?</summary>
      <p>Add the scan, click "Make searchable (OCR)", and download. An OCR engine running in your
      browser reads each page and adds an invisible text layer on top, so the file looks identical but
      you can select, copy, and search the text. It reads printed English and works best on clean
      scans. Handwriting usually does not work.</p>
    </details>
    <details>
      <summary>What happens to my files?</summary>
      <p>They are opened and edited in your browser's memory and never sent anywhere. The processing
      libraries are served from this site, and your document stays on your device. Close the tab and
      everything is gone. Saved signatures, if you use that feature, live only in your browser's local
      storage.</p>
    </details>
    <details>
      <summary>Why is this free?</summary>
      <p>I wanted a PDF tool I could trust with sensitive documents, and the only honest way to build
      that is to keep the files on your device. Since your browser does all the work, hosting this
      page costs me almost nothing. There is no account, no upsell, and no server that could see your
      files even if I wanted it to.</p>
    </details>
  </div>
</div>

<!-- One-time redaction explainer, shown before the first box is applied -->
<div class="pt-modal" id="pt-dialog" hidden>
  <div class="pt-modal__box pt-modal__box--narrow" role="dialog" aria-modal="true" aria-labelledby="pt-dialog-head">
    <div class="pt-modal__head" id="pt-dialog-head"><strong>How redaction works here</strong></div>
    <div class="pt-dialog__body">
      <p>Real redaction can't just draw a black box on top: the text underneath would still sit in the
        file and could be copied straight back out. So when you <strong>download</strong>, every page
        that has redaction boxes is re-rendered as an image with the boxes painted on, and that image
        replaces the page. The covered content is then actually gone from the file.</p>
      <p class="pt-dialog__tradeoff">Until you download, the boxes are just marks on the page: draw as
        many as you like, move them, delete them, or press Ctrl+Z. The page keeps its full quality no
        matter how many boxes you add, and stays untouched if you remove them all. A redacted page in
        the downloaded file is an image, so its text is no longer selectable or searchable.</p>
    </div>
    <div class="pt-modal__foot">
      <button id="pt-dialog-cancel" class="pt-btn" type="button">Cancel</button>
      <span class="pt-spacer"></span>
      <button id="pt-dialog-go" class="pt-btn pt-btn--danger" type="button">Got it — redact</button>
    </div>
  </div>
</div>

<!-- Shrink (compress) dialog -->
<div class="pt-modal" id="pt-shrink-dialog" hidden>
  <div class="pt-modal__box pt-modal__box--narrow" role="dialog" aria-modal="true" aria-labelledby="pt-shrink-head">
    <div class="pt-modal__head" id="pt-shrink-head"><strong>Shrink the PDF</strong></div>
    <div class="pt-dialog__body">
      <p>This shrinks the file by <strong>rendering every page to an image</strong> at the chosen
        quality and rebuilding the PDF from those images. It's most effective on scans and image-heavy
        documents. <strong>On text-only or already-optimized PDFs the result can come out larger, not
        smaller</strong> — the status line reports the size change either way.</p>
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

<!-- Password prompt for encrypted source PDFs -->
<div class="pt-modal" id="pt-pass-dialog" hidden>
  <div class="pt-modal__box pt-modal__box--narrow" role="dialog" aria-modal="true" aria-labelledby="pt-pass-head">
    <div class="pt-modal__head" id="pt-pass-head"><strong>Password required</strong></div>
    <div class="pt-dialog__body">
      <p id="pt-pass-msg"></p>
      <label class="pt-field"><span>Password</span>
        <input id="pt-pass-input" type="password" autocomplete="off">
      </label>
      <p class="pt-modal__hint">The password is used only on your device, to open the file.</p>
    </div>
    <div class="pt-modal__foot">
      <button id="pt-pass-cancel" class="pt-btn" type="button">Skip this file</button>
      <span class="pt-spacer"></span>
      <button id="pt-pass-go" class="pt-btn pt-btn--accent" type="button">Unlock</button>
    </div>
  </div>
</div>

<!-- Watermark dialog -->
<div class="pt-modal" id="pt-wm-dialog" hidden>
  <div class="pt-modal__box pt-modal__box--narrow" role="dialog" aria-modal="true" aria-labelledby="pt-wm-head">
    <div class="pt-modal__head" id="pt-wm-head"><strong>Add a watermark</strong></div>
    <div class="pt-dialog__body">
      <label class="pt-field"><span>Text</span>
        <input id="pt-wm-text" type="text" value="DRAFT" maxlength="80" autocomplete="off"></label>
      <label class="pt-field"><span>Placement</span>
        <select id="pt-wm-pos">
          <option value="diag">Diagonal across the page</option>
          <option value="foot">Small line at the bottom</option>
        </select></label>
      <label class="pt-field"><span>Opacity <span class="pt-field__val" id="pt-wm-op-val">15%</span></span>
        <input id="pt-wm-op" type="range" min="5" max="60" value="15"></label>
      <label class="pt-field"><span>Size <span class="pt-field__val" id="pt-wm-size-val">48 pt</span></span>
        <input id="pt-wm-size" type="range" min="12" max="120" value="48"></label>
      <label class="pt-field"><span>Apply to</span>
        <select id="pt-wm-scope"></select></label>
      <p class="pt-modal__hint">The watermark is drawn into the PDF on download. Rotated pages are
        flattened upright first. Ctrl+Z removes it again.</p>
    </div>
    <div class="pt-modal__foot">
      <button id="pt-wm-cancel" class="pt-btn" type="button">Cancel</button>
      <button id="pt-wm-remove" class="pt-btn" type="button" hidden>Remove existing</button>
      <span class="pt-spacer"></span>
      <button id="pt-wm-go" class="pt-btn pt-btn--accent" type="button">Add watermark</button>
    </div>
  </div>
</div>

<!-- Page numbers dialog -->
<div class="pt-modal" id="pt-pn-dialog" hidden>
  <div class="pt-modal__box pt-modal__box--narrow" role="dialog" aria-modal="true" aria-labelledby="pt-pn-head">
    <div class="pt-modal__head" id="pt-pn-head"><strong>Page numbers</strong></div>
    <div class="pt-dialog__body">
      <label class="pt-field"><span>Format</span>
        <select id="pt-pn-fmt">
          <option value="n">1, 2, 3…</option>
          <option value="nofm">1 of 12</option>
        </select></label>
      <label class="pt-field"><span>Position</span>
        <select id="pt-pn-pos">
          <option value="bc">Bottom center</option>
          <option value="br">Bottom right</option>
        </select></label>
      <label class="pt-field"><span>Start at</span>
        <input id="pt-pn-start" type="number" min="1" step="1" value="1" inputmode="numeric"></label>
      <label class="pt-field"><span>Font size</span>
        <select id="pt-pn-size">
          <option value="8">8 pt</option>
          <option value="9">9 pt</option>
          <option value="10" selected>10 pt</option>
          <option value="11">11 pt</option>
          <option value="12">12 pt</option>
          <option value="14">14 pt</option>
        </select></label>
      <label class="pt-check pt-field--row"><input type="checkbox" id="pt-pn-skip"> Skip the first page (cover)</label>
      <p class="pt-modal__hint">Numbers follow the page order shown in the grid, update automatically if
        you reorder, and are drawn into the PDF on download. Rotated pages are flattened upright first.
        Ctrl+Z removes it again.</p>
    </div>
    <div class="pt-modal__foot">
      <button id="pt-pn-cancel" class="pt-btn" type="button">Cancel</button>
      <button id="pt-pn-remove" class="pt-btn" type="button" hidden>Remove numbers</button>
      <span class="pt-spacer"></span>
      <button id="pt-pn-go" class="pt-btn pt-btn--accent" type="button">Add page numbers</button>
    </div>
  </div>
</div>

<!-- Export pages as images dialog -->
<div class="pt-modal" id="pt-img-dialog" hidden>
  <div class="pt-modal__box pt-modal__box--narrow" role="dialog" aria-modal="true" aria-labelledby="pt-img-head">
    <div class="pt-modal__head" id="pt-img-head"><strong>Export pages as images</strong></div>
    <div class="pt-dialog__body">
      <p>Renders pages to image files. One page downloads as a single image; several pages are bundled
        in a .zip.</p>
      <label class="pt-field"><span>Pages</span>
        <select id="pt-img-scope"></select></label>
      <label class="pt-field"><span>Resolution</span>
        <select id="pt-img-dpi">
          <option value="96">96 DPI — screen</option>
          <option value="150" selected>150 DPI — good default</option>
          <option value="300">300 DPI — print</option>
        </select></label>
      <label class="pt-field"><span>Format</span>
        <select id="pt-img-fmt">
          <option value="png">PNG (sharp, larger files)</option>
          <option value="jpeg">JPEG (smaller files)</option>
        </select></label>
    </div>
    <div class="pt-modal__foot">
      <button id="pt-img-cancel" class="pt-btn" type="button">Cancel</button>
      <span class="pt-spacer"></span>
      <button id="pt-img-go" class="pt-btn pt-btn--accent" type="button">Export images</button>
    </div>
  </div>
</div>

<!-- OCR (make searchable) dialog -->
<div class="pt-modal" id="pt-ocr-dialog" hidden>
  <div class="pt-modal__box pt-modal__box--narrow" role="dialog" aria-modal="true" aria-labelledby="pt-ocr-head">
    <div class="pt-modal__head" id="pt-ocr-head"><strong>Make pages searchable (OCR)</strong></div>
    <div class="pt-dialog__body">
      <p>This reads the text on your pages with an OCR engine that runs <strong>in your browser</strong>
        (tesseract.js) and adds an invisible text layer on top. The pages look exactly the same, but the
        text becomes selectable, copyable, and searchable. Download afterwards to save the result.</p>
      <p class="pt-dialog__tradeoff">It reads <strong>printed English</strong> and works best on clean,
        straight scans. Handwriting usually does not work. The first use downloads about
        <strong>6&nbsp;MB</strong> of OCR engine code from this site (no third-party servers); your
        browser keeps a copy for next time. Your pages are processed locally and never uploaded.</p>
      <label class="pt-field"><span>Pages</span>
        <select id="pt-ocr-scope"></select></label>
    </div>
    <div class="pt-modal__foot">
      <button id="pt-ocr-cancel" class="pt-btn" type="button">Cancel</button>
      <span class="pt-spacer"></span>
      <button id="pt-ocr-go" class="pt-btn pt-btn--accent" type="button">Make searchable</button>
    </div>
  </div>
</div>

<!-- Password-protect (encrypt) dialog -->
<div class="pt-modal" id="pt-protect-dialog" hidden>
  <div class="pt-modal__box pt-modal__box--narrow" role="dialog" aria-modal="true" aria-labelledby="pt-protect-head">
    <div class="pt-modal__head" id="pt-protect-head"><strong>Password-protect the PDF</strong></div>
    <div class="pt-dialog__body">
      <p>Builds the document and encrypts it with <strong>AES-256</strong> using qpdf running in your
        browser, then downloads it. Opening the file will require the password. The first use downloads
        about <strong>1.3&nbsp;MB</strong> of engine code from this site; your PDF never leaves your
        device.</p>
      <p class="pt-dialog__tradeoff"><strong>Careful:</strong> there is no way to recover the password
        later. Write it down.</p>
      <label class="pt-field"><span>Password</span>
        <input id="pt-protect-pw" type="password" autocomplete="new-password"></label>
      <label class="pt-field"><span>Repeat password</span>
        <input id="pt-protect-pw2" type="password" autocomplete="new-password"></label>
      <p class="pt-err" id="pt-protect-err" aria-live="polite"></p>
    </div>
    <div class="pt-modal__foot">
      <button id="pt-protect-cancel" class="pt-btn" type="button">Cancel</button>
      <span class="pt-spacer"></span>
      <button id="pt-protect-go" class="pt-btn pt-btn--accent" type="button">Encrypt &amp; download</button>
    </div>
  </div>
</div>

<!-- ===================== Unified page editor ===================== -->
<div class="pt-ed" id="pt-ed" role="dialog" aria-modal="true" aria-label="Page editor" hidden>
  <div class="pt-ed__bar">
    <button id="pt-ed-done" class="pt-btn pt-btn--accent" type="button">Done</button>
    <button id="pt-ed-undo" class="pt-btn" type="button" disabled title="Undo (Ctrl+Z)">↶ Undo</button>
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
      <label class="pt-ed__optlabel" for="pt-redact-dpi">Download quality</label>
      <select id="pt-redact-dpi" title="Render quality used when redacted pages are flattened to images on download">
        <option value="150" selected>Standard — 150 DPI</option>
        <option value="220">High — 220 DPI</option>
        <option value="100">Smaller file — 100 DPI</option>
      </select>
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
    <button id="pt-sig-save" class="pt-btn" type="button" disabled title="Save this signature in this browser only (it never leaves your device)">Save</button>
    <button id="pt-sig-place" class="pt-btn pt-btn--accent" type="button" disabled>Place on page</button>
    <span class="pt-signbar__saved" id="pt-sig-savedwrap" hidden>
      <span class="pt-ed__hint">Saved:</span>
      <span id="pt-sig-saved"></span>
    </span>
    <span class="pt-ed__hint">Draw or upload, then “Place on page” and drag it where you want.</span>
  </div>

  <div class="pt-ed__scroll" id="pt-ed-scroll">
    <div class="pt-ed__stage" id="pt-ed-stage" tabindex="0" role="application"
         aria-label="Page preview. With the Text or Redact tool active, press Enter to add one at the page center; arrow keys nudge the selected item, Delete removes it.">
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
/* the front-matter title is tuned for search; the visible H1 stays short */
.page__title { display: none; }
.pt-h1 { margin-top: 0; margin-bottom: 0.6rem; }
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
/* the ACTIVE tool/tab must keep an accent fill on hover — the generic grey .pt-btn hover
   out-specified the --on rules and left white labels on pale grey in light mode */
.pt-btn.pt-tool--on:hover:not(:disabled), .pt-btn.pt-tab--on:hover:not(:disabled) { background: #6f97c2; border-color: #6f97c2; }
html[data-theme="light"] .pt-btn.pt-tool--on:hover:not(:disabled), html[data-theme="light"] .pt-btn.pt-tab--on:hover:not(:disabled) { background: #25406b; border-color: #25406b; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .pt-btn.pt-tool--on:hover:not(:disabled), html:not([data-theme="dark"]) .pt-btn.pt-tab--on:hover:not(:disabled) { background: #25406b; border-color: #25406b; }
}

.pt-toolbar { display: flex; flex-direction: column; gap: 0.45rem; margin-bottom: 0.7rem; }
.pt-toolbar[hidden] { display: none !important; }   /* the hidden attr loses to display:flex otherwise */
.pt-toolbar__row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.45rem; }
.pt-sep { width: 1px; align-self: stretch; background: rgba(127,127,127,0.3); margin: 0 0.2rem; }
.pt-spacer { flex: 1 1 auto; }
.pt-count { font-size: 0.85em; opacity: 0.7; font-variant-numeric: tabular-nums; }
.pt-check { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.9em; cursor: pointer; }
.pt-check input { accent-color: #82a6cc; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .pt-check input { accent-color: #34568a; } }
html[data-theme="light"] .pt-check input { accent-color: #34568a; }

/* busy: the toolbar + grid are inert while a long operation runs (progress bar shows) */
.pt-busy { pointer-events: none; opacity: 0.55; }

/* thin accent progress bar */
.pt-progress { height: 4px; border-radius: 2px; background: rgba(127,127,127,0.25); overflow: hidden; margin: 0 0 0.8rem; }
.pt-progress[hidden] { display: none; }
.pt-progress__fill { height: 100%; width: 0%; background: #82a6cc; transition: width 0.15s ease; }
html[data-theme="light"] .pt-progress__fill { background: #34568a; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .pt-progress__fill { background: #34568a; } }

/* page-range input */
.pt-range {
  font: inherit; font-size: 0.9em; padding: 0.45em 0.55em; border-radius: 6px; width: 11.5em;
  color: #e8e8e8; background: #20242c; border: 1px solid rgba(255,255,255,0.18);
}
html[data-theme="light"] .pt-range { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.2); }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .pt-range { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.2); } }
.pt-range-info { font-size: 0.8em; opacity: 0.75; min-width: 4.2em; font-variant-numeric: tabular-nums; }
.pt-range-info--bad { color: #c4574a; opacity: 1; }

.pt-drop {
  position: relative; border: 2px dashed rgba(127,127,127,0.4); border-radius: 12px;
  background: rgba(127,127,127,0.05); min-height: 280px; padding: 1rem; cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.pt-drop--over { border-color: #82a6cc; background: rgba(130,166,204,0.10); }
.pt-drop:focus-visible { border-color: #82a6cc; outline: 2px solid #82a6cc; outline-offset: 2px; }
.pt-drop--has { cursor: default; }
.pt-drop--has .pt-drop__hint { display: none; }
#pt-file { display: none !important; }
.pt-drop__hint { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); text-align: center; opacity: 0.7; pointer-events: none; line-height: 1.7; }

.pt-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 0.9rem; }
.pt-thumb {
  position: relative; border: 1px solid rgba(127,127,127,0.3); border-radius: 8px; overflow: hidden;
  background: rgba(127,127,127,0.06); cursor: grab; user-select: none; -webkit-user-select: none;
  touch-action: pan-y;   /* vertical scroll stays native; long-press starts a drag */
}
.pt-thumb.pt-sel { border-color: #82a6cc; box-shadow: 0 0 0 2px rgba(130,166,204,0.55) inset; }
html[data-theme="light"] .pt-thumb.pt-sel { border-color: #34568a; box-shadow: 0 0 0 2px rgba(52,86,138,0.5) inset; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .pt-thumb.pt-sel { border-color: #34568a; box-shadow: 0 0 0 2px rgba(52,86,138,0.5) inset; } }
.pt-thumb--drag { opacity: 0.4; }
/* insertion indicator while dragging to reorder */
.pt-thumb--before { box-shadow: -4px 0 0 0 #82a6cc; }
.pt-thumb--after { box-shadow: 4px 0 0 0 #82a6cc; }
.pt-thumb__canvas { width: 100%; display: block; background: #fff; }
/* skeleton pulse while a thumbnail renders */
.pt-thumb--loading .pt-thumb__canvas { animation: pt-pulse 1.2s ease-in-out infinite; }
@keyframes pt-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
@media (prefers-reduced-motion: reduce) { .pt-thumb--loading .pt-thumb__canvas { animation: none; } }
.pt-thumb__bar { display: flex; align-items: center; justify-content: space-between; gap: 0.3rem; padding: 0.25rem 0.4rem; font-size: 0.74rem; opacity: 0.85; }
.pt-thumb__num { font-variant-numeric: tabular-nums; }
.pt-thumb__redacted { color: #c4574a; font-weight: 700; }
.pt-thumb__ocr { color: #82a6cc; font-weight: 700; font-size: 0.85em; letter-spacing: 0.02em; }
.pt-thumb__acts { display: flex; gap: 0.2rem; }
.pt-thumb__act { font: inherit; font-size: 0.85em; line-height: 1; cursor: pointer; color: inherit; border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14); border-radius: 4px; padding: 0.15em 0.35em; }
.pt-thumb__act:hover { background: rgba(127,127,127,0.3); }
/* fingers need bigger targets than mouse pointers (the ✎ ⟳ × row was ~19x15px) */
@media (pointer: coarse) {
  .pt-thumb__act { font-size: 1.05em; padding: 0.4em 0.55em; min-width: 24px; box-sizing: border-box; }   /* the × glyph is narrow */
  .pt-thumb__acts { gap: 0.45rem; }
}
/* the site's floating theme toggle (fixed, bottom-left, raised on mobile) lands exactly
   on this page's tall wrapped toolbar at natural scroll positions and steals taps from
   enabled buttons — hide it here on small screens (theme still follows the OS setting,
   and the toggle is on every other page) */
@media (max-width: 768px) {
  #theme-toggle { display: none; }
}

.pt-status { font-size: 0.9em; opacity: 0.9; min-height: 1.2em; margin: 0.9rem 0 0.2rem; }
.pt-engine { font-size: 0.85em; opacity: 0.7; margin: 0.2rem 0; }
.pt-note { font-size: 0.82em; opacity: 0.65; line-height: 1.5; margin: 0.4rem 0 0; }
.pt-credit { font-size: 0.8em; opacity: 0.6; line-height: 1.5; margin: 0.5rem 0 0; }

/* FAQ */
.pt-faq { max-width: 75ch; margin-top: 2.2rem; }
.pt-faq h2 { font-size: 1.15rem; margin-bottom: 0.6rem; }
.pt-faq details { border: 1px solid rgba(127,127,127,0.25); border-radius: 8px; padding: 0.55rem 0.9rem; margin: 0.5rem 0; }
.pt-faq summary { cursor: pointer; font-weight: 600; font-size: 0.95rem; }
.pt-faq p { font-size: 0.9rem; line-height: 1.55; margin: 0.6rem 0 0.3rem; opacity: 0.92; }

.pt-field { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.95em; margin: 0.8rem 0 0; }
.pt-field select,
.pt-field input[type="text"], .pt-field input[type="password"], .pt-field input[type="number"] {
  font: inherit; padding: 0.45em 0.5em; border-radius: 6px;
  color: #e8e8e8; background: #20242c; border: 1px solid rgba(255,255,255,0.18);
}
.pt-field select option { color: #e8e8e8; background: #20242c; }
.pt-field input[type="range"] { accent-color: #82a6cc; }
.pt-field__val { opacity: 0.7; font-weight: 400; font-variant-numeric: tabular-nums; margin-left: 0.35em; }
.pt-field--row { margin: 0.9rem 0 0; }
.pt-err { color: #c4574a; font-size: 0.85em; min-height: 1.1em; margin: 0.6rem 0 0; }
html[data-theme="light"] .pt-field select,
html[data-theme="light"] .pt-field input[type="text"], html[data-theme="light"] .pt-field input[type="password"], html[data-theme="light"] .pt-field input[type="number"] { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.2); }
html[data-theme="light"] .pt-field select option { color: #1f2430; background: #fff; }
html[data-theme="light"] .pt-field input[type="range"] { accent-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .pt-field select,
  html:not([data-theme="dark"]) .pt-field input[type="text"], html:not([data-theme="dark"]) .pt-field input[type="password"], html:not([data-theme="dark"]) .pt-field input[type="number"] { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.2); }
  html:not([data-theme="dark"]) .pt-field select option { color: #1f2430; background: #fff; }
  html:not([data-theme="dark"]) .pt-field input[type="range"] { accent-color: #34568a; }
}

/* Modal / dialog */
.pt-modal { position: fixed; inset: 0; z-index: 1300; display: flex; align-items: center; justify-content: center; padding: 1rem; background: rgba(0,0,0,0.55); -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px); }
.pt-modal[hidden] { display: none !important; }   /* the hidden attr loses to display:flex otherwise */
.pt-modal__box { width: min(900px, 96vw); max-height: 92vh; overflow: auto; display: flex; flex-direction: column; gap: 0.7rem; padding: 1rem 1.1rem 1.1rem; border-radius: 12px; background: #16181d; border: 1px solid rgba(255,255,255,0.12); box-shadow: 0 14px 50px rgba(0,0,0,0.5); }
.pt-modal__box--narrow { width: min(540px, 96vw); }
html[data-theme="light"] .pt-modal__box { background: #fff; border-color: rgba(0,0,0,0.14); }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .pt-modal__box { background: #fff; border-color: rgba(0,0,0,0.14); } }
.pt-modal__head { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; font-size: 1.05rem; }
.pt-modal__hint { font-size: 0.86rem; opacity: 0.8; line-height: 1.5; margin: 0.6rem 0 0; }
.pt-modal__foot { display: flex; align-items: center; gap: 0.5rem; }
.pt-canvas-wrap { overflow: auto; background: rgba(127,127,127,0.12); border-radius: 8px; display: flex; justify-content: center; align-items: flex-start; min-height: 200px; max-height: 64vh; }
.pt-editor { display: block; cursor: crosshair; touch-action: none; background: #fff; }
.pt-dialog__body p { font-size: 0.9rem; line-height: 1.55; margin: 0 0 0.6rem; }
.pt-dialog__tradeoff { opacity: 0.95; }

/* Signature editor */
.pt-tabs { display: flex; gap: 0.4rem; }
.pt-tab--on { background: #82a6cc; border-color: #82a6cc; color: #fff; }
html[data-theme="light"] .pt-tab--on { background: #34568a; border-color: #34568a; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .pt-tab--on { background: #34568a; border-color: #34568a; } }
.pt-sigpad { background: #fff; border: 1px dashed rgba(127,127,127,0.5); border-radius: 6px; cursor: crosshair; touch-action: none; display: block; width: 300px; max-width: 60vw; height: 110px; }
#pt-sigfile { display: none !important; }
.pt-signbar__saved { display: inline-flex; align-items: center; gap: 0.4rem; }
.pt-signbar__saved[hidden] { display: none; }
.pt-sigsaved { display: inline-flex; align-items: flex-start; gap: 0.15rem; margin-right: 0.35rem; }
.pt-sigsaved img { height: 34px; max-width: 110px; background: #fff; border: 1px solid rgba(127,127,127,0.4); border-radius: 4px; cursor: pointer; padding: 2px; box-sizing: content-box; }
.pt-sigsaved__del { font: inherit; font-size: 0.75em; line-height: 1; border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14); border-radius: 4px; color: inherit; cursor: pointer; padding: 0.15em 0.3em; }
.pt-sigsaved__del:hover { background: rgba(127,127,127,0.3); }

/* Form fill */
.pt-form-empty { font-size: 0.9rem; opacity: 0.8; }

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
.pt-signbar__src[hidden] { display: none !important; }   /* the hidden attr loses to display:inline-flex otherwise */
.pt-ed__scroll { flex: 1 1 auto; overflow: auto; display: flex; justify-content: center; align-items: flex-start; padding: 1rem; }
/* touch-action pinch-zoom, NOT none: single-finger drags still reach the pointer
   handlers (drawing boxes, dragging annotations), but a two-finger pinch falls through
   to native browser zoom — the editor has no zoom of its own, and redacting 6px text
   at phone scale needs one */
.pt-ed__stage { position: relative; box-shadow: 0 6px 30px rgba(0,0,0,0.4); background: #fff; touch-action: pinch-zoom; }
.pt-ed__canvas { display: block; touch-action: pinch-zoom; }
.pt-ed__layer { position: absolute; inset: 0; touch-action: pinch-zoom; }
.pt-ed__hintbar { padding: 0.4rem 0.8rem; font-size: 0.82rem; opacity: 0.7; min-height: 1.2em; border-top: 1px solid rgba(127,127,127,0.2); }
.pt-ed__arrow { position: absolute; top: 50%; transform: translateY(-50%); z-index: 5; width: 46px; height: 70px; border: none; border-radius: 10px; background: rgba(127,127,127,0.28); color: #fff; font-size: 2.2rem; line-height: 1; cursor: pointer; opacity: 0.55; transition: opacity 0.15s ease, background 0.15s ease; }
.pt-ed__arrow:hover:not(:disabled) { opacity: 1; background: rgba(130,166,204,0.6); }
.pt-ed__arrow:disabled { opacity: 0; pointer-events: none; }
.pt-ed__arrow--left { left: 12px; }
.pt-ed__arrow--right { right: 12px; }
/* light mode: a white chevron on the pale grey pill was unreadable at rest */
html[data-theme="light"] .pt-ed__arrow { color: #1f2430; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .pt-ed__arrow { color: #1f2430; } }

/* annotations live inside .pt-ed__layer. Fixed z-indexes (redact under text under sig,
   in-flight box on top) so a FRESH edit paints in the same order as reopen (buildAnnoEls)
   and export (drawOverlays) — insertion order used to decide, and the preview lied. */
.pt-anno { position: absolute; box-sizing: border-box; }
.pt-anno--text { cursor: text; z-index: 2; }
/* margin-top -0.13em: the CSS line box puts the first baseline ~0.95em below the top
   (half-leading + ascent) while the export draws it at 0.82em — shift the ink up so the
   editor preview lands where drawText will put it (the wrapper position/model y are
   untouched, so drags stay exact) */
.pt-anno__txt { min-width: 1ch; padding: 0; line-height: 1.2; white-space: pre; outline: none; margin-top: -0.13em; }
.pt-anno--text.pt-sel, .pt-anno--sig.pt-sel, .pt-anno--redact.pt-sel { outline: 1px dashed #82a6cc; outline-offset: 1px; }
.pt-anno--sig { cursor: move; z-index: 3; }
.pt-anno--sig img { width: 100%; height: 100%; display: block; pointer-events: none; }
.pt-anno__del { position: absolute; top: -10px; right: -10px; width: 18px; height: 18px; line-height: 16px; text-align: center; font-size: 12px; border-radius: 50%; border: none; background: #c4574a; color: #fff; cursor: pointer; padding: 0; z-index: 2; }
.pt-anno__resize { position: absolute; right: -6px; bottom: -6px; width: 12px; height: 12px; background: #82a6cc; border: 1px solid #fff; border-radius: 2px; cursor: nwse-resize; }
/* a committed redaction is solid black (it IS what the download will look like);
   a box still being drawn is translucent with a red edge */
.pt-anno--redact { background: #0d0d0d; cursor: move; z-index: 1; }
.pt-anno--redact-tmp { background: rgba(20,20,20,0.55); border: 1px dashed #c4574a; z-index: 4; }
.pt-ed__optlabel { font-size: 0.8rem; opacity: 0.75; }
.pt-formwidget { position: absolute; box-sizing: border-box; font: inherit; border: 1px solid #82a6cc; background: rgba(130,166,204,0.18); color: #111; padding: 0 2px; }
.pt-formwidget[type="checkbox"], .pt-formwidget[type="radio"] { background: #fff; accent-color: #34568a; }
.pt-stage--text { cursor: text; }
.pt-stage--text .pt-anno--redact { cursor: text; }   /* the text tool can place a label on a black box */
.pt-stage--text .pt-anno--sig { cursor: text; }      /* ...or a date/name on a signature */
.pt-stage--redact { cursor: crosshair; }
/* redacting: form widgets stay visible to aim at, but must not swallow the drag —
   a box drawn over a filled field is exactly the workflow this tool exists for */
.pt-stage--redact .pt-formwidget { pointer-events: none; }
/* narrow editors have no room for the reserved arrow gutters — hide the overlay
   arrows (the toolbar's ‹ › and the arrow keys still change pages) */
@media (max-width: 639px) {
  .pt-ed__arrow { display: none; }
}
/* fingers need bigger targets: the editor's annotation handles were 18px (×) and
   12px (resize grip). This block must come AFTER the base rules above — same
   specificity, so an earlier media block would lose the cascade. */
@media (pointer: coarse) {
  .pt-anno__del { width: 26px; height: 26px; line-height: 24px; font-size: 15px; top: -13px; right: -13px; }
  .pt-anno__resize { width: 24px; height: 24px; right: -12px; bottom: -12px; }
  .pt-sigsaved__del { min-width: 24px; min-height: 24px; padding: 0.4em 0.55em; box-sizing: border-box; }
}
</style>

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "PDF Toolbench",
  "url": "https://keanelucas.com/pdftools/",
  "applicationCategory": "UtilitiesApplication",
  "operatingSystem": "Any (runs in the web browser)",
  "browserRequirements": "Requires JavaScript",
  "isAccessibleForFree": true,
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "author": { "@type": "Person", "name": "Keane Lucas", "url": "https://keanelucas.com" },
  "description": "Free private PDF tools that run entirely in the browser: merge and split PDFs, reorder and rotate pages, fill forms, add signatures, true redaction, OCR to make scanned PDFs searchable, watermarks, page numbers, export pages as images, compression, and AES-256 password protection. Files are never uploaded.",
  "featureList": "Merge PDFs, split PDFs, reorder pages, rotate pages, delete pages, duplicate pages, insert blank pages, extract page ranges, fill PDF forms, sign PDFs, redact PDFs, OCR scanned PDFs, add watermarks, add page numbers, export pages as images, compress PDFs, password-protect PDFs, strip metadata, undo"
}
</script>

<script defer src="{{ '/assets/js/pdflib/pdf-lib.min.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/pdflib/pdfjs/pdf.min.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/pdftools.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/pdftools-tools.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/pdftools-editor.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
