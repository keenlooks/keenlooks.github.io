---
layout: single
title: "PDF Toolbench: merge, redact, sign, OCR & compress PDFs in your browser"
permalink: /pdftools/
search_keys: "white out whiteout ocr searchable compress password encrypt tools redaction"
og_image: /images/og/pdftools.png
author_profile: false
excerpt: "Merge, split, reorder, redact, sign, add and format text, fill, OCR, copy clean text, watermark, compress, and password-protect PDFs privately, in your browser."
description: "Free private PDF tools that run entirely in your browser: merge and split PDFs, reorder and rotate pages, fill forms, add signatures, add text and format it with bold, italic, underline, highlight and alignment, redact so hidden text is truly removed, make scanned PDFs searchable with OCR in 22 languages, add watermarks and page numbers, export pages as images, compress, and password-protect with AES-256. Your files are never uploaded."
---

<div class="pt-wrap">

  <h1 class="pt-h1">PDF Toolbench</h1>

  <p class="pt-intro">
    A PDF utility that runs entirely in your browser. Merge files, reorder, rotate, and delete pages,
    pull out a range, add text and format it, add a signature, fill in forms, white out part of a page, redact a page so the hidden text is
    actually gone, make a scanned PDF searchable with OCR, copy the text out cleaned up for pasting
    into an AI chat, add watermarks or page numbers, export pages as images, strip metadata, shrink
    the file, or lock it with a password. Ctrl+Z undoes mistakes.
  </p>
  <p class="pt-privacy">Everything runs locally in your browser. Your PDF is never uploaded and never leaves your device. (I use Google Analytics to see whether anyone visits this page, but it cannot see your files or anything you do with them.)</p>
  <p class="pt-privacy" style="margin-top:-0.55rem">A caveat: this is a personal side project and I have not tested it exhaustively. I make no guarantees; keep your originals and check the output before relying on it. Found a problem? <a href="mailto:{{ site.author.email }}?subject=PDF%20Toolbench%20problem">Tell me by email</a> (no need to send the file).</p>

  <div class="pt-toolbar" id="pt-toolbar" hidden>
    <div class="pt-toolbar__row">
      <button id="pt-add" class="pt-btn" type="button">+ Add files</button>
      <span class="pt-count" id="pt-count"></span>
      <span class="pt-sep"></span>
      <button id="pt-editpage" class="pt-btn" type="button" disabled title="Open a page to add text, add a signature, black out or white out content, or fill in form fields">✎ Edit page</button>
      <span class="pt-sep"></span>
      <button id="pt-selall" class="pt-btn" type="button" title="Select all / none">Select all</button>
      <button id="pt-rotate" class="pt-btn" type="button" disabled title="Rotate selected pages 90° clockwise">⟳ Rotate</button>
      <button id="pt-rotccw" class="pt-btn" type="button" disabled title="Rotate selected pages 90° counterclockwise" aria-label="Rotate counterclockwise">⟲</button>
      <button id="pt-dup" class="pt-btn" type="button" disabled title="Duplicate selected pages">⧉ Duplicate</button>
      <button id="pt-blank" class="pt-btn" type="button" title="Insert a blank page (after the selection, or at the end)">▭ Blank page</button>
      <button id="pt-delete" class="pt-btn" type="button" disabled title="Delete selected pages"><svg class="pt-btn__ico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path fill="currentColor" fill-rule="evenodd" d="M6 1h4a1 1 0 0 1 1 1v1h3v1.6H2V3h3V2a1 1 0 0 1 1-1zm.6 1.2v.8h2.8v-.8zM3.4 5.4h9.2l-.75 9.3a1 1 0 0 1-1 .9H5.15a1 1 0 0 1-1-.9zM5.3 7v6.6h.9V7zm2.25 0v6.6h.9V7zm2.25 0v6.6h.9V7z"/></svg> Delete</button>
      <span class="pt-sep"></span>
      <button id="pt-undo" class="pt-btn" type="button" disabled title="Undo (Ctrl+Z)">↶ Undo</button>
      <span class="pt-spacer"></span>
      <label class="pt-rangelabel" for="pt-range">Pages</label>
      <input id="pt-range" class="pt-range" type="text" placeholder="e.g. 1-5, 9, 12-" title="Page range for the selected-pages download and Split, e.g. 1-5,9,12-" autocomplete="off">
      <span class="pt-range-info" id="pt-range-info"></span>
      <button id="pt-extract" class="pt-btn" type="button" disabled title="Download ONLY the selected pages (or the range in the Pages box) as their own PDF. The document here stays as it is.">Download selected</button>
      <button id="pt-split" class="pt-btn" type="button" title="Save every page (or the range above) as its own PDF, bundled in a .zip">Split → .zip</button>
      <button id="pt-download" class="pt-btn pt-btn--accent" type="button" disabled title="Download the whole document: every page shown above, in this order, with all edits applied">Download all</button>
    </div>
    <div class="pt-toolbar__row">
      <button id="pt-ocr" class="pt-btn" type="button" data-pt-needs-pages disabled title="Add an invisible, searchable text layer to scanned pages (OCR)">Make searchable (OCR)…</button>
      <button id="pt-copytext" class="pt-btn" type="button" data-pt-needs-pages disabled title="Extract the text, cleaned up for pasting into an AI chat or anywhere else">Copy clean text…</button>
      <button id="pt-watermark" class="pt-btn" type="button" data-pt-needs-pages disabled title="Stamp text like DRAFT across pages">Watermark…</button>
      <button id="pt-pagenums" class="pt-btn" type="button" data-pt-needs-pages disabled title="Add page numbers">Page numbers…</button>
      <button id="pt-images" class="pt-btn" type="button" data-pt-needs-pages disabled title="Export pages as PNG or JPEG images">Pages → images…</button>
      <button id="pt-shrink" class="pt-btn" type="button" data-pt-needs-pages disabled title="Shrink the file by rasterizing pages">⤓ Shrink…</button>
      <button id="pt-protect" class="pt-btn" type="button" data-pt-needs-pages disabled title="Encrypt the PDF with a password (AES-256)">Protect…</button>
      <span class="pt-spacer"></span>
      <label class="pt-check" title="On download, remove the title, author, producer and dates, and the hidden details pages and photos can carry (XMP data, camera make, location). Photos you add never keep their location or camera details."><input type="checkbox" id="pt-stripmeta" checked> Strip metadata</label>
    </div>
  </div>

  <div class="pt-progress" id="pt-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" hidden><div class="pt-progress__fill" id="pt-progress-fill"></div></div>

  <p class="pt-tip" id="pt-tip" hidden>Double-click any page to add text, sign, black out, white out, or fill forms.</p>

  <div id="pt-drop" class="pt-drop" tabindex="0" role="button" aria-label="Add PDF or image files">
    <input id="pt-file" type="file" accept="application/pdf,.pdf,image/*" multiple hidden style="display:none!important">
    <div class="pt-grid" id="pt-grid"></div>
    <div class="pt-drop__hint" id="pt-hint"><strong>Drop PDFs or images here</strong><br>or <span class="pt-drop__verb">click</span> to choose</div>
  </div>

  <p class="pt-status" id="pt-status" role="status" aria-live="polite"></p>
  <p class="pt-engine" id="pt-engine" hidden>Loading the PDF engine…</p>
  <p class="pt-note">A single click selects a page; double-click it (double-tap on a phone), or click its ✎, to open it
  for editing. Drag a thumbnail to reorder, pressing and holding first on a phone. Ctrl+Z, or the Undo
  button, reverses the last change.</p>
  <p class="pt-credit">Built on open-source libraries:
    <a href="https://github.com/mozilla/pdf.js" target="_blank" rel="noopener">pdf.js</a>
    by Mozilla (Apache&nbsp;2.0) for rendering,
    <a href="https://github.com/Hopding/pdf-lib" target="_blank" rel="noopener">pdf-lib</a>
    (MIT) for editing,
    <a href="https://github.com/naptha/tesseract.js" target="_blank" rel="noopener">tesseract.js</a>
    with the
    <a href="https://github.com/tesseract-ocr/tessdata_fast" target="_blank" rel="noopener">tessdata_fast</a>
    language models (both Apache&nbsp;2.0) for OCR, and
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
      because the text underneath would still be in the file, so when you download every page with
      boxes is re-rendered as an image with the boxes painted on, replacing the original page. The
      hidden text is actually gone. You can verify it yourself: try to select or search the redacted
      area in the downloaded file. Nothing is uploaded at any point.</p>
    </details>
    <details>
      <summary>What do the download buttons and the Pages box do?</summary>
      <p><strong>Download all</strong> saves the whole document as one PDF: every page shown in the grid,
      in that order, with all edits applied. <strong>Download selected</strong> saves only the selected
      pages (or the range typed in the Pages box) as their own PDF, and leaves the document here as it
      is. <strong>Split</strong> saves each page as its own PDF inside a .zip. Shift-click selects a run
      of pages, and the Pages box takes a range like 1-5,9,12- for both the selected-pages download and
      Split. Adding several files merges them into one document, in the order shown, and images are
      turned into pages.</p>
    </details>
    <details>
      <summary>How do I make a scanned PDF searchable?</summary>
      <p>Add the scan, click "Make searchable (OCR)", pick the language, and download. An OCR engine
      running in your browser reads each page and adds an invisible text layer on top, so the file looks
      identical but you can select, copy, and search the text. It reads printed text in 22 languages
      (Arabic, Chinese, Dutch, English, French, German, Greek, Hebrew, Hindi, Indonesian, Italian,
      Japanese, Korean, Polish, Portuguese, Russian, Spanish, Thai, Turkish, Ukrainian, and Vietnamese,
      with Chinese in both simplified and traditional characters), and the text layer is searchable in
      any of them. It works best on clean scans. Handwriting usually does not work.</p>
    </details>
    <details>
      <summary>What does "Copy clean text" do?</summary>
      <p>It pulls the text out of the document, cleaned up for pasting into an AI chat or anywhere
      else. Running headers, footers, and page numbers are removed by a heuristic: a line that repeats
      in about the same spot on most pages, or a line that is just a page number, is dropped. Words
      broken across a line wrap are rejoined, and the rest is reflowed into paragraphs. It is a
      heuristic, not a layout engine, so complex layouts like tables and multi-column pages can come
      out in the wrong order, right-to-left scripts like Arabic and Hebrew come out with the words
      reversed, and scanned pages need "Make searchable" first since there is no text to read yet.
      Text you added with the Text tool is included; values you typed into form fields are not.
      Nothing is uploaded; it reads the text already open in your browser.</p>
    </details>
    <details>
      <summary>How do I add and format text?</summary>
      <p>Open a page for editing, choose the Text tool, and click where the text should go. Type, then
      use the bar above the page to shape it: font, size, line spacing, alignment, bold, italic,
      underline, strikethrough, text color, and highlight. Select part of the text and the change
      applies to just that part; with the cursor sitting in the text and nothing selected, it applies
      to what you type next. Drag the grip above a box to move it, the side handles to give it a width
      so the text wraps, and the corner handle to change the size. Click into any text box later, with
      any tool except Redact, to edit the words again.</p>
      <p>The twelve fonts are the ones built into the PDF format itself (Helvetica, Times, and Courier,
      each in regular, bold, italic, and bold italic), so nothing is downloaded and the text stays
      real, selectable, searchable PDF text. A highlight is a translucent rectangle drawn behind the
      words, and some viewers flatten it to a plain tint. Formatting pasted from somewhere else is
      dropped to plain text on purpose, so what you see in the box is what lands in the file. The text
      is turned into pixels only if the page itself is flattened, which happens for a redaction, a
      watermark, page numbers, OCR, or a rotation.</p>
      <p>Those built-in fonts cover English and Western European letters only. Other letters (Polish
      Ł, Turkish ı, Greek, Cyrillic, Arabic, Hebrew, Chinese, Japanese, Korean) and emoji cannot be
      saved in a text box yet, so they are left out, and the editor tells you as soon as you type
      one. A watermark can be in any language: when its letters are outside those fonts it is
      drawn as an image instead.</p>
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
      <p>Each box is kept and shown on the page as soon as you draw it. Draw as many as you like, move
        them, delete them, or press Ctrl+Z. The page itself keeps its full quality while you work, and
        stays untouched if you remove every box.</p>
      <p class="pt-dialog__tradeoff">The content is removed when you <strong>download</strong>. Drawing
        a black box on top is not enough on its own: the text underneath would still sit in the file and
        could be copied straight back out. So every page that has boxes is re-rendered as an image with
        the boxes painted on, and that image replaces the page. The covered content is then actually
        gone, and because the page is now an image, its text is no longer selectable or searchable.</p>
    </div>
    <div class="pt-modal__foot">
      <button id="pt-dialog-cancel" class="pt-btn" type="button">Cancel</button>
      <span class="pt-spacer"></span>
      <button id="pt-dialog-go" class="pt-btn pt-btn--accent" type="button">Got it, redact</button>
    </div>
  </div>
</div>

<!-- One-time white-out explainer, shown before the first white-out is applied -->
<div class="pt-modal" id="pt-wo-dialog" hidden>
  <div class="pt-modal__box pt-modal__box--narrow" role="dialog" aria-modal="true" aria-labelledby="pt-wo-dialog-head">
    <div class="pt-modal__head" id="pt-wo-dialog-head"><strong>White-out covers, it does not remove</strong></div>
    <div class="pt-dialog__body">
      <p>A white-out paints a white box over the page. Whatever is under it stays in the file and can
        still be found by search or by copying the text. To take content out of the file, use Redact
        instead.</p>
    </div>
    <div class="pt-modal__foot">
      <button id="pt-wo-dialog-cancel" class="pt-btn" type="button">Cancel</button>
      <span class="pt-spacer"></span>
      <button id="pt-wo-dialog-go" class="pt-btn pt-btn--accent" type="button">Got it, white out</button>
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
        smaller</strong>, and the status line reports the size change either way.</p>
      <p class="pt-dialog__tradeoff"><strong>Trade-off:</strong> like redaction, the pages become images,
        so text is no longer selectable or searchable. (Your original file is untouched; this downloads a copy.)</p>
      <label class="pt-field"><span>Quality</span>
        <select id="pt-shrink-dpi">
          <option value="150,0.7">Standard, 150 DPI</option>
          <option value="110,0.6">Smaller, 110 DPI</option>
          <option value="220,0.8">Higher quality, 220 DPI</option>
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
          <option value="slash">1 / 12</option>
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
          <option value="96">96 DPI, screen</option>
          <option value="150" selected>150 DPI, good default</option>
          <option value="300">300 DPI, print</option>
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
      <p class="pt-dialog__tradeoff">It reads <strong>printed text in 22 languages</strong> and works
        best on clean, straight scans. Handwriting usually does not work. The first use downloads about
        <strong>4&nbsp;MB</strong> of OCR engine code from this site (no third-party servers), and each
        language you pick downloads its model once, when OCR starts; your browser keeps a copy for next
        time. Your pages are processed locally and never uploaded.</p>
      <label class="pt-field"><span>Language</span>
        <select id="pt-ocr-lang"></select></label>
      <label class="pt-check pt-field--row" id="pt-ocr-eng-row"><input type="checkbox" id="pt-ocr-eng" checked> Also recognize English</label>
      <p class="pt-modal__hint" id="pt-ocr-size"></p>
      <label class="pt-field"><span>Pages</span>
        <select id="pt-ocr-scope"></select></label>
      <label class="pt-check pt-field--row" title="Pages that already have selectable text (not just an invisible OCR layer) are left as they are, so their text is not doubled"><input type="checkbox" id="pt-ocr-skip" checked> Skip pages that already have text</label>
    </div>
    <div class="pt-modal__foot">
      <button id="pt-ocr-cancel" class="pt-btn" type="button">Cancel</button>
      <span class="pt-spacer"></span>
      <button id="pt-ocr-go" class="pt-btn pt-btn--accent" type="button">Make searchable</button>
    </div>
  </div>
</div>

<!-- Copy clean text dialog -->
<div class="pt-modal" id="pt-ct-dialog" hidden>
  <div class="pt-modal__box" role="dialog" aria-modal="true" aria-labelledby="pt-ct-head">
    <div class="pt-modal__head" id="pt-ct-head"><strong>Copy clean text</strong></div>
    <div class="pt-dialog__body">
      <p>Extracts the text on <strong id="pt-ct-scope"></strong>, with running headers, footers, and
        page numbers heuristically removed, line-wrap hyphens repaired, and paragraphs reflowed into
        plain text, ready to paste into an AI chat or anywhere else. This reads the text layer already
        open in your browser; nothing is uploaded.</p>
      <label class="pt-check pt-field--row"><input type="checkbox" id="pt-ct-markers"> Keep page markers</label>
      <textarea id="pt-ct-preview" class="pt-ct-preview" readonly spellcheck="false" aria-label="Extracted text preview"></textarea>
      <p class="pt-ct-progress" id="pt-ct-progress" aria-live="polite"></p>
      <p class="pt-modal__hint pt-ct-note" id="pt-ct-note" hidden></p>
    </div>
    <div class="pt-modal__foot">
      <button id="pt-ct-close" class="pt-btn" type="button">Close</button>
      <span class="pt-spacer"></span>
      <button id="pt-ct-download" class="pt-btn" type="button" disabled>Download .txt</button>
      <button id="pt-ct-copy" class="pt-btn pt-btn--accent" type="button" disabled>Copy to clipboard</button>
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
      <label class="pt-check pt-field--row"><input type="checkbox" id="pt-protect-show"> Show password</label>
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
    <span class="pt-ed__page notranslate" id="pt-ed-page" translate="no"></span>
    <span class="pt-ed__tools">
      <button id="pt-tool-move" class="pt-btn pt-tool pt-tool--on" type="button" title="Move / select" aria-pressed="true">↖ Move</button>
      <button id="pt-tool-text" class="pt-btn pt-tool" type="button" title="Add text" aria-pressed="false">T Text</button>
      <button id="pt-tool-sign" class="pt-btn pt-tool" type="button" title="Add a signature" aria-pressed="false">✎ Sign</button>
      <button id="pt-tool-redact" class="pt-btn pt-tool" type="button" title="Black out content so it is really removed from the file" aria-pressed="false">▮ Redact</button>
      <button id="pt-tool-whiteout" class="pt-btn pt-tool" type="button" title="White-out: cover part of the page with white (covers, does not remove)" aria-pressed="false">▯ White-out</button>
    </span>
    <span class="pt-ed__opts" id="pt-redact-opts" hidden>
      <label class="pt-ed__optlabel" for="pt-redact-dpi">Download quality</label>
      <select id="pt-redact-dpi" title="Render quality used when redacted pages are flattened to images on download">
        <option value="150" selected>Standard, 150 DPI</option>
        <option value="220">High, 220 DPI</option>
        <option value="100">Smaller file, 100 DPI</option>
      </select>
    </span>
    <span class="pt-spacer"></span>
    <span class="pt-ed__nav">
      <button id="pt-ed-prev" class="pt-btn" type="button" title="Previous page" aria-label="Previous page">‹</button>
      <button id="pt-ed-next" class="pt-btn" type="button" title="Next page" aria-label="Next page">›</button>
    </span>
  </div>

  <div class="pt-ed__textbar" id="pt-ed-textbar" hidden>
    <select id="pt-text-font" title="Font" aria-label="Font">
      <option value="Helvetica">Helvetica</option>
      <option value="Times">Times</option>
      <option value="Courier">Courier</option>
    </select>
    <select id="pt-text-size" title="Font size" aria-label="Font size"></select>
    <select id="pt-text-lh" title="Line spacing" aria-label="Line spacing">
      <option value="1">Spacing 1</option>
      <option value="1.15">Spacing 1.15</option>
      <option value="1.2" selected>Spacing 1.2</option>
      <option value="1.5">Spacing 1.5</option>
      <option value="2">Spacing 2</option>
      <option value="other">Spacing, other…</option>
    </select>
    <span class="pt-ed__group">
      <button id="pt-text-al" class="pt-btn pt-ico" type="button" aria-pressed="true" title="Align left" aria-label="Align left"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"><path fill="currentColor" d="M1 2h14v2H1zM1 6h9v2H1zM1 10h14v2H1zM1 14h9v2H1z"/></svg></button>
      <button id="pt-text-ac" class="pt-btn pt-ico" type="button" aria-pressed="false" title="Align center" aria-label="Align center"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"><path fill="currentColor" d="M1 2h14v2H1zM4 6h8v2H4zM1 10h14v2H1zM4 14h8v2H4z"/></svg></button>
      <button id="pt-text-ar" class="pt-btn pt-ico" type="button" aria-pressed="false" title="Align right" aria-label="Align right"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"><path fill="currentColor" d="M1 2h14v2H1zM6 6h9v2H6zM1 10h14v2H1zM6 14h9v2H6z"/></svg></button>
    </span>
    <span class="pt-ed__group">
      <button id="pt-text-b" class="pt-btn pt-ico pt-ico--b" type="button" aria-pressed="false" title="Bold (Ctrl+B)" aria-label="Bold">B</button>
      <button id="pt-text-i" class="pt-btn pt-ico pt-ico--i" type="button" aria-pressed="false" title="Italic (Ctrl+I)" aria-label="Italic">I</button>
      <button id="pt-text-u" class="pt-btn pt-ico pt-ico--u" type="button" aria-pressed="false" title="Underline (Ctrl+U)" aria-label="Underline">U</button>
      <button id="pt-text-s" class="pt-btn pt-ico pt-ico--s" type="button" aria-pressed="false" title="Strikethrough" aria-label="Strikethrough">S</button>
    </span>
    <input id="pt-text-color" type="color" value="#111111" title="Text color" aria-label="Text color">
    <span class="pt-ed__group">
      <button id="pt-text-hl" class="pt-btn pt-ico" type="button" aria-pressed="false" title="Highlight" aria-label="Highlight">▨</button>
      <button class="pt-sw" type="button" data-hl="#ffe14d" title="Highlight yellow" aria-label="Highlight yellow"></button>
      <button class="pt-sw" type="button" data-hl="#a5e8a1" title="Highlight green" aria-label="Highlight green"></button>
      <button class="pt-sw" type="button" data-hl="#a9d5ff" title="Highlight blue" aria-label="Highlight blue"></button>
      <button class="pt-sw" type="button" data-hl="#ffb3d9" title="Highlight pink" aria-label="Highlight pink"></button>
      <button class="pt-sw" type="button" data-hl="#ffc48a" title="Highlight orange" aria-label="Highlight orange"></button>
      <input id="pt-text-hlcolor" type="color" value="#ffe14d" title="Highlight color" aria-label="Highlight color">
    </span>
    <label class="pt-check" title="Let the box hug its text instead of wrapping at a fixed width"><input type="checkbox" id="pt-text-auto" checked> Auto width</label>
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
    <button id="pt-sig-save" class="pt-btn" type="button" disabled title="Keep this signature in this browser only, ready for next time (it never leaves your device)">Save for next time</button>
    <button id="pt-sig-place" class="pt-btn pt-btn--accent" type="button" disabled aria-pressed="false">Place on page</button>
    <span class="pt-signbar__saved" id="pt-sig-savedwrap" hidden>
      <span class="pt-ed__hint">Saved:</span>
      <span id="pt-sig-saved"></span>
    </span>
  </div>

  <div class="pt-ed__scroll" id="pt-ed-scroll">
    <div class="pt-ed__stage" id="pt-ed-stage" tabindex="0" role="application"
         aria-label="Page preview. With the Text, Redact or White-out tool active, press Enter to add one at the page center. Click a text box to edit its words; a selected text box has a grip above it for moving, side handles that set its width, and a corner handle that changes its size. Arrow keys nudge the selected item, Delete removes it.">
      <canvas id="pt-ed-canvas" class="pt-ed__canvas"></canvas>
      <div class="pt-ed__layer" id="pt-ed-layer"></div>
    </div>
  </div>
  <button class="pt-ed__arrow pt-ed__arrow--left" id="pt-ed-arrow-left" type="button" aria-label="Previous page" title="Previous page">‹</button>
  <button class="pt-ed__arrow pt-ed__arrow--right" id="pt-ed-arrow-right" type="button" aria-label="Next page" title="Next page">›</button>
  <div class="pt-ed__hintbar" id="pt-ed-hint" role="status" aria-live="polite"></div>
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
.pt-privacy { max-width: 70ch; font-size: 0.9em; opacity: 0.8; margin: 0 0 1.1rem; }

/* Buttons (same look as Image Studio). */
.pt-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14);
  border-radius: 6px; padding: 0.5em 0.8em; transition: background 0.15s ease;
}
.pt-btn:hover:not(:disabled) { background: rgba(127,127,127,0.26); }
.pt-btn:disabled { opacity: 0.45; cursor: default; }
.pt-btn__ico { vertical-align: -0.14em; }
/* labels on the accent fill: dark on the dark theme's light-blue fill (#141414 on #82a6cc
   is 7.3:1; white was 2.5:1), white on the light theme's dark-blue fill (7.4:1) */
.pt-btn--accent { background: #82a6cc; border-color: #82a6cc; color: #141414; }
.pt-btn--accent:hover:not(:disabled) { background: #6f97c2; }
.pt-btn--danger { background: #c4574a; border-color: #c4574a; color: #fff; }
.pt-btn--danger:hover:not(:disabled) { background: #b04438; }
html[data-theme="light"] .pt-btn--accent { background: #34568a; border-color: #34568a; color: #fff; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .pt-btn--accent { background: #34568a; border-color: #34568a; color: #fff; } }
/* the generic hover above out-specifies the light fills, which left white on #6f97c2 (3.1:1) */
html[data-theme="light"] .pt-btn--accent:hover:not(:disabled) { background: #25406b; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .pt-btn--accent:hover:not(:disabled) { background: #25406b; } }
/* the ACTIVE tool/tab must keep an accent fill on hover — the generic grey .pt-btn hover
   out-specified the --on rules and left white labels on pale grey in light mode */
.pt-btn.pt-tool--on:hover:not(:disabled), .pt-btn.pt-tab--on:hover:not(:disabled) { background: #6f97c2; border-color: #6f97c2; }
html[data-theme="light"] .pt-btn.pt-tool--on:hover:not(:disabled), html[data-theme="light"] .pt-btn.pt-tab--on:hover:not(:disabled) { background: #25406b; border-color: #25406b; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .pt-btn.pt-tool--on:hover:not(:disabled), html:not([data-theme="dark"]) .pt-btn.pt-tab--on:hover:not(:disabled) { background: #25406b; border-color: #25406b; }
}

/* the only way into the page editor from this screen, so give it an accent edge — a
   second FILLED accent button would compete with Download all */
#pt-editpage:not(:disabled) { border-color: #82a6cc; }
html[data-theme="light"] #pt-editpage:not(:disabled) { border-color: #34568a; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) #pt-editpage:not(:disabled) { border-color: #34568a; } }

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
.pt-rangelabel { font-size: 0.85em; opacity: 0.75; }
.pt-range-info { font-size: 0.8em; opacity: 0.75; min-width: 4.2em; font-variant-numeric: tabular-nums; }
.pt-range-info--bad { color: #c4574a; opacity: 1; }

/* one line above the grid: the editor is only reachable by double-click / the ✎ button /
   the toolbar's Edit page, and nothing on the grid itself says so */
.pt-tip { font-size: 0.85em; opacity: 0.75; margin: 0 0 0.55rem; }
.pt-tip[hidden] { display: none !important; }

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
.pt-thumb__whiteout { font-weight: 700; }
.pt-thumb__ocr { color: #82a6cc; font-weight: 700; font-size: 0.85em; letter-spacing: 0.02em; }
.pt-thumb__acts { display: flex; gap: 0.2rem; }
.pt-thumb__act { font: inherit; font-size: 0.85em; line-height: 1; cursor: pointer; color: inherit; border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14); border-radius: 4px; padding: 0.15em 0.35em; }
.pt-thumb__act:hover { background: rgba(127,127,127,0.3); }
/* (finger-sized ✎ ⟳ × targets live in the pointer:coarse block at the END of this style) */
/* the site's floating theme toggle (fixed, bottom-left, raised on mobile) lands exactly
   on this page's tall wrapped toolbar at natural scroll positions and steals taps from
   enabled buttons — hide it here on small screens (theme still follows the OS setting,
   and the toggle is on every other page) */
@media (max-width: 768px) {
  #theme-toggle { display: none; }
}

.pt-status { font-size: 0.9em; opacity: 0.9; min-height: 1.2em; margin: 0.9rem 0 0.2rem; }
.pt-status--err { color: #c4574a; opacity: 1; }
.pt-status--warn { color: #b8863a; opacity: 1; }
html[data-theme="light"] .pt-status--warn { color: #8a6413; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .pt-status--warn { color: #8a6413; } }
.pt-engine { font-size: 0.85em; opacity: 0.7; margin: 0.2rem 0; }
.pt-note { max-width: 70ch; font-size: 0.82em; opacity: 0.65; line-height: 1.5; margin: 0.4rem 0 0; }
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
.pt-ct-preview {
  display: block; width: 100%; height: 14rem; resize: vertical; box-sizing: border-box;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.82em; line-height: 1.5;
  padding: 0.6em 0.7em; border-radius: 6px; white-space: pre-wrap;
  color: #e8e8e8; background: #20242c; border: 1px solid rgba(255,255,255,0.18);
}
html[data-theme="light"] .pt-ct-preview { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.2); }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .pt-ct-preview { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.2); } }
.pt-ct-progress { font-size: 0.85em; opacity: 0.75; min-height: 1.1em; margin: 0.4rem 0 0; }
.pt-editor { display: block; cursor: crosshair; touch-action: none; background: #fff; }
.pt-dialog__body p { font-size: 0.9rem; line-height: 1.55; margin: 0 0 0.6rem; }
.pt-dialog__tradeoff { opacity: 0.95; }

/* Signature editor */
.pt-tabs { display: flex; gap: 0.4rem; }
.pt-tab--on { background: #82a6cc; border-color: #82a6cc; color: #141414; }
html[data-theme="light"] .pt-tab--on { background: #34568a; border-color: #34568a; color: #fff; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .pt-tab--on { background: #34568a; border-color: #34568a; color: #fff; } }
/* the baseline is a CSS background line, not canvas ink — trimToInk() reads the canvas
   pixels, so anything drawn on it would be exported as part of the signature */
.pt-sigpad {
  background-color: #fff;
  background-image: linear-gradient(rgba(0,0,0,0.22), rgba(0,0,0,0.22));
  background-size: calc(100% - 32px) 1px; background-position: 16px 80px; background-repeat: no-repeat;
  border: 1px dashed rgba(127,127,127,0.5); border-radius: 6px; cursor: crosshair; touch-action: none;
  display: block; width: 300px; max-width: 60vw; height: 110px;
}
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
/* five tools no longer fit one row of a 390px phone: the group wraps onto a second row
   and every label stays on one line (squeezed buttons used to break each label in two,
   "White-" over "out") */
.pt-ed__tools { display: inline-flex; gap: 0.3rem; flex-wrap: wrap; }
.pt-tool { white-space: nowrap; }
/* ‹ › stay a single unit: on a narrow phone the wrapping bar used to leave one of them
   stranded on the row above */
.pt-ed__nav { display: inline-flex; gap: 0.3rem; flex: 0 0 auto; }
.pt-tool--on { background: #82a6cc; border-color: #82a6cc; color: #141414; }
html[data-theme="light"] .pt-tool--on { background: #34568a; border-color: #34568a; color: #fff; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .pt-tool--on { background: #34568a; border-color: #34568a; color: #fff; } }
.pt-ed__opts { display: inline-flex; align-items: center; gap: 0.35rem; }
.pt-ed__opts[hidden] { display: none; }
.pt-ed__opts select { font: inherit; padding: 0.35em 0.4em; border-radius: 6px; color: #e8e8e8; background: #20242c; border: 1px solid rgba(255,255,255,0.18); }
.pt-ed__opts input[type="color"] { width: 30px; height: 30px; padding: 0; border: 1px solid rgba(127,127,127,0.4); border-radius: 6px; background: none; cursor: pointer; }
html[data-theme="light"] .pt-ed__opts select { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.2); }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .pt-ed__opts select { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.2); } }
/* Text formatting bar: a SECOND full-width strip, on the .pt-ed__signbar precedent. Ten
   more controls packed into the primary bar would wrap it to three rows on a phone and
   push the Done / Undo / page / nav row (the row a visitor uses to escape) off screen. */
.pt-ed__textbar { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; padding: 0.45rem 0.8rem; border-bottom: 1px solid rgba(127,127,127,0.25); background: rgba(127,127,127,0.04); }
/* the text bar FLOATS over the top of the page area (the editor places it with top), out
   of the flow, so the page never moves or shrinks when it appears: a box drawn a moment ago
   stays under the pointer when the user switches to Text (White-out ruling 5). Opaque, so
   the page reads cleanly under it; the editor gives the page the bar's height of room
   above so its first lines can still be scrolled into view. */
.pt-ed__textbar { position: absolute; left: 0; right: 0; z-index: 4; background: #14161a; box-shadow: 0 4px 10px rgba(0,0,0,0.35); }
html[data-theme="light"] .pt-ed__textbar { background: #eef0f3; box-shadow: 0 4px 10px rgba(0,0,0,0.12); }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .pt-ed__textbar { background: #eef0f3; box-shadow: 0 4px 10px rgba(0,0,0,0.12); } }
.pt-ed__textbar[hidden] { display: none !important; }   /* the hidden attr loses to display:flex otherwise */
/* on a phone (a coarse pointer, or the narrow layout) the bar DOCKS in the flow BELOW the
   page area instead (White-out fourth pass): it never covers the page, and the page keeps
   its size and its place when the bar appears (only the area under the page gets shorter),
   so a tap on the page always reaches the page. The hint stays last. */
@media (pointer: coarse), (max-width: 639px) {
  #pt-ed .pt-ed__textbar { position: static; order: 1; box-shadow: none; border-bottom: 0; border-top: 1px solid rgba(127,127,127,0.25); }
  #pt-ed .pt-ed__hintbar { order: 2; }
}
.pt-ed__group { display: inline-flex; align-items: center; gap: 0.2rem; }
/* the theme's _forms.scss gives every select width:100%, a 9px bottom margin and the
   compiled DARK text color on white, and all three have to be undone in the bar */
.pt-ed__textbar select { font: inherit; font-size: 0.9em; padding: 0.3em 0.4em; margin-bottom: 0; width: auto; border-radius: 6px; color: #e8e8e8; background: #20242c; border: 1px solid rgba(255,255,255,0.18); }
.pt-ed__textbar select option { color: #e8e8e8; background: #20242c; }
.pt-ed__textbar input[type="color"] { width: 28px; height: 28px; padding: 0; margin-bottom: 0; border: 1px solid rgba(127,127,127,0.4); border-radius: 6px; background: none; cursor: pointer; }
.pt-ed__textbar .pt-check { margin-bottom: 0; }
.pt-ed__textbar .pt-check input { margin: 0; }
html[data-theme="light"] .pt-ed__textbar select { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.2); }
html[data-theme="light"] .pt-ed__textbar select option { color: #1f2430; background: #fff; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .pt-ed__textbar select { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.2); }
  html:not([data-theme="dark"]) .pt-ed__textbar select option { color: #1f2430; background: #fff; }
}
.pt-ico { min-width: 30px; padding: 0.35em 0.45em; display: inline-flex; align-items: center; justify-content: center; }
.pt-ico--b { font-weight: 700; }
.pt-ico--i { font-style: italic; font-family: Georgia, "Times New Roman", serif; }
.pt-ico--u { text-decoration: underline; }
.pt-ico--s { text-decoration: line-through; }
.pt-ico[aria-pressed="true"], .pt-ico[aria-pressed="true"]:hover:not(:disabled) { background: #82a6cc; border-color: #82a6cc; color: #141414; }
html[data-theme="light"] .pt-ico[aria-pressed="true"], html[data-theme="light"] .pt-ico[aria-pressed="true"]:hover:not(:disabled) { background: #34568a; border-color: #34568a; color: #fff; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .pt-ico[aria-pressed="true"], html:not([data-theme="dark"]) .pt-ico[aria-pressed="true"]:hover:not(:disabled) { background: #34568a; border-color: #34568a; color: #fff; }
}
.pt-sw { width: 22px; height: 22px; padding: 0; border-radius: 4px; border: 1px solid rgba(127,127,127,0.55); cursor: pointer; }
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
/* Move and Text (White-out fourth pass): one finger also scrolls the page up and down, so a
   phone can bring any part of it into view; a tap still adds or picks a box (the editor adds
   a text box only for a touch that moved 8 px or less). The boxes keep their own one-finger
   drags (pinch-zoom only; the handles none), and the box-drawing tools and an armed
   signature keep the rule above. A swipe at either end of the page area stops there instead
   of scrolling the page behind the editor. */
.pt-stage--pan, .pt-stage--pan .pt-ed__canvas, .pt-stage--pan .pt-ed__layer { touch-action: pan-y pinch-zoom; }
.pt-stage--pan .pt-anno { touch-action: pinch-zoom; }
.pt-ed__scroll { overscroll-behavior: contain; }
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
   untouched, so drags stay exact).
   Kerning and ligatures are OFF: Arial, Times New Roman and Courier New share advance
   widths with the standard 14 fonts, but only unkerned, which is also what pdf-lib's
   emitter writes (one un-kerned Tj per line). */
.pt-anno__txt { min-width: 1ch; padding: 0; line-height: 1.2; white-space: pre; outline: none; margin-top: -0.13em;
  font-kerning: none; font-variant-ligatures: none; font-feature-settings: "kern" 0, "liga" 0; }
/* the RESTING picture of a text box is a canvas painted by the same shared painter the
   thumbnails and the export preview use: CSS places an inline box by its top edge and the
   browser-font baseline offset is family AND size dependent (41px for Courier New against
   45px for Arial at 48px), so run spans cannot land on the export's 0.82em baseline.
   pointer-events: none keeps every gesture on the wrapper, and it is not selectable, so a
   drag that starts on a resting box is always a gesture and never a text selection. */
.pt-anno__cv { position: absolute; left: 0; top: 0; display: block; pointer-events: none; user-select: none; -webkit-user-select: none; }
.pt-anno__cv[hidden] { display: none !important; }
.pt-anno__txt--static { position: absolute; left: 0; top: 0; pointer-events: none; }
.pt-anno--text.pt-sel, .pt-anno--sig.pt-sel, .pt-anno--redact.pt-sel, .pt-anno--whiteout.pt-sel { outline: 1px dashed #82a6cc; outline-offset: 1px; }
/* a 6px ring OUTSIDE a selected text box drags it, while the interior places the caret.
   The hit area is a pseudo-element, whose events target the box itself, so no second
   element joins the drag / nudge / resize / cancel paths. */
.pt-anno--text.pt-sel::before { content: ''; position: absolute; inset: -6px; }
.pt-anno--sig { cursor: move; z-index: 3; }
.pt-anno--sig img { width: 100%; height: 100%; display: block; pointer-events: none; }
/* the x badge is OUTSIDE the box now. It used to be cleared by padding-right on the
   selected box, which was safe while a box had no width of its own; with a real width
   that padding would shrink the content box and RE-WRAP the text on selection, in
   different places on a phone (16px) than on a desktop (12px). --left flips it when the
   box is near the stage edge, --high lifts it clear of the width handles on a short box.
   Its offsets are its own size plus 2px on BOTH axes, so its inner corner lands just past
   the dashed outline's corner and no pixel of it falls inside the box: on a right-aligned
   line the ink runs to the box edge, and a badge reaching in clipped the last glyph. */
.pt-anno__del { position: absolute; top: -20px; right: -20px; width: 18px; height: 18px; line-height: 16px; text-align: center; font-size: 12px; border-radius: 50%; border: none; background: #c4574a; color: #fff; cursor: pointer; padding: 0; z-index: 6; }
.pt-anno__del--left { right: auto; left: -20px; }
.pt-anno__del--high { top: -22px; }
/* text-box handles: a move grip above the box, east and west width handles at mid height,
   and a south-east corner that scales the font size. touch-action: none on each handle,
   because the stage and layer are pinch-zoom and an unmarked handle drag would pan. */
.pt-anno__grip { position: absolute; left: 50%; transform: translateX(-50%); top: -14px; width: 34px; height: 10px; border-radius: 5px; background: #82a6cc; border: 1px solid #fff; cursor: move; touch-action: none; z-index: 5; }
.pt-anno__grip--below { top: auto; bottom: -14px; }
.pt-anno__he, .pt-anno__hw { position: absolute; top: 50%; transform: translateY(-50%); width: 10px; height: 22px; border-radius: 3px; background: #82a6cc; border: 1px solid #fff; cursor: ew-resize; touch-action: none; z-index: 5; }
/* both width handles sit WHOLLY outside the box, their inner edge just past the dashed
   selection outline (which is drawn at outline-offset 1px), so neither ever covers the
   first or the last character of a line. The offset is the handle's own width plus 2px,
   symmetric east and west, at both pointer sizes. */
.pt-anno__he { right: -12px; }
.pt-anno__hw { left: -12px; }
/* the size handle follows the same law as the width handles: its own size plus 2px on
   both axes, so its inner corner lands just past the dashed outline's bottom-right corner
   and it never covers the last character of the last line. (.pt-anno__resize below is the
   signature handle, which sits on an image and clips no glyph, so it is unchanged.) */
.pt-anno__hse { position: absolute; right: -14px; bottom: -14px; width: 12px; height: 12px; background: #82a6cc; border: 1px solid #fff; border-radius: 2px; cursor: nwse-resize; touch-action: none; z-index: 5; }
.pt-anno__resize { position: absolute; right: -6px; bottom: -6px; width: 12px; height: 12px; background: #82a6cc; border: 1px solid #fff; border-radius: 2px; cursor: nwse-resize; touch-action: none; }
/* a signature being aimed with the pointer: the ghost tracks the pointer at its center */
.pt-sigghost { position: absolute; opacity: 0.6; pointer-events: none; z-index: 6; }
.pt-sigghost[hidden] { display: none; }
.pt-stage--placing { cursor: crosshair; }
/* a committed redaction is solid black (it IS what the download will look like);
   a box still being drawn is translucent with a red edge */
.pt-anno--redact { background: #0d0d0d; cursor: move; z-index: 1; }
.pt-anno--redact-tmp { background: rgba(20,20,20,0.55); border: 1px dashed #c4574a; z-index: 4; }
/* a committed white-out is white (it IS what the download will look like) with a 1px
   neutral hairline drawn INSIDE its edge, in the editor only, so a white box on a white
   page can be found; z-index 0 keeps it under redactions, text and signatures, the order
   every painter and the export use. A box still being drawn is a translucent white with a
   dashed edge in the theme's accent. */
.pt-anno--whiteout { background: #fff; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.28); cursor: move; z-index: 0; }
.pt-anno--whiteout-tmp { background: rgba(255,255,255,0.7); box-shadow: none; border: 1px dashed #82a6cc; z-index: 4; }
html[data-theme="light"] .pt-anno--whiteout-tmp { border-color: #34568a; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .pt-anno--whiteout-tmp { border-color: #34568a; } }
.pt-ed__optlabel { font-size: 0.8rem; opacity: 0.75; }
/* watermarks and page numbers in the editor: their own canvas above the white-out and
   redaction boxes and under text and signatures, as in the thumbnails and the download */
.pt-ed__marks { position: absolute; left: 0; top: 0; width: 100%; height: 100%; display: block; pointer-events: none; z-index: 1; }
/* Form widgets sit ON the rendered page, which is white paper in both themes, so they
   keep paper colors. They must be OPAQUE: pdf.js paints each field's own appearance
   stream into the canvas underneath, and through a translucent overlay that painted
   value showed a few px off from the live one — one dropdown reading as two garbled
   overlapping strings. The accent tint is what the hint means by "highlighted". */
.pt-formwidget { position: absolute; box-sizing: border-box; font: inherit; border: 1px solid #82a6cc; background: #edf2f9; color: #111; padding: 0 2px; }
.pt-formwidget option { color: #111; background: #fff; }
.pt-formwidget[type="checkbox"], .pt-formwidget[type="radio"] { background: #fff; accent-color: #34568a; box-shadow: 0 0 0 2px rgba(52,86,138,0.45); }
.pt-stage--text { cursor: text; }
.pt-stage--text .pt-anno--redact { cursor: text; }   /* the text tool can place a label on a black box */
.pt-stage--text .pt-anno--sig { cursor: text; }      /* ...or a date/name on a signature */
.pt-stage--text .pt-anno--whiteout { cursor: text; } /* ...or a correction on a white-out */
.pt-stage--redact, .pt-stage--whiteout { cursor: crosshair; }
/* redacting: form widgets stay visible to aim at, but must not swallow the drag —
   a box drawn over a filled field is exactly the workflow this tool exists for */
.pt-stage--redact .pt-formwidget, .pt-stage--whiteout .pt-formwidget { pointer-events: none; }
/* each box tool draws straight over the other kind of box (a redaction inside a white-out,
   a white-out across a redaction) instead of the press landing on that box and doing
   nothing; the other kind is still selectable in Move */
.pt-stage--redact .pt-anno--whiteout, .pt-stage--whiteout .pt-anno--redact { pointer-events: none; }
/* same rule for text boxes, now that clicking one edits it in every other tool: a
   redaction drawn across added text must draw a box, not put a caret in the words */
.pt-stage--redact .pt-anno--text { pointer-events: none; }
/* narrow editors have no room for the reserved arrow gutters — hide the overlay
   arrows (the toolbar's ‹ › and the arrow keys still change pages) */
@media (max-width: 639px) {
  .pt-ed__arrow { display: none; }
}
/* fingers need bigger targets: the editor's annotation handles were 18px (×) and
   12px (resize grip). This block must come AFTER the base rules above — same
   specificity, so an earlier media block would lose the cascade. */
@media (pointer: coarse) {
  .pt-anno__del { width: 26px; height: 26px; line-height: 24px; font-size: 15px; top: -28px; right: -28px; }
  .pt-anno__del--left { right: auto; left: -28px; }
  .pt-anno__del--high { top: -30px; }
  .pt-anno__resize { width: 24px; height: 24px; right: -12px; bottom: -12px; }
  .pt-anno__grip { width: 44px; height: 24px; top: -30px; border-radius: 12px; }
  .pt-anno__grip--below { top: auto; bottom: -30px; }
  .pt-anno__he, .pt-anno__hw { width: 24px; height: 34px; border-radius: 6px; }
  .pt-anno__he { right: -26px; }
  .pt-anno__hw { left: -26px; }
  .pt-anno__hse { width: 24px; height: 24px; right: -26px; bottom: -26px; }
  .pt-anno--text.pt-sel::before { inset: -10px; }
  .pt-ico { min-width: 36px; min-height: 36px; }
  .pt-sw { width: 28px; height: 28px; }
  .pt-ed__textbar input[type="color"] { width: 34px; height: 34px; }
  .pt-sigsaved__del { min-width: 24px; min-height: 24px; padding: 0.4em 0.55em; box-sizing: border-box; }
  /* the thumbnail footer row (✎ ⟳ ×) was ~24px with 8px gaps, and × sits two buttons
     from ✎ — give fingers 32px+ and more room between them */
  .pt-thumb__act {
    font-size: 1.05em; padding: 0.45em 0.5em; min-width: 32px; min-height: 32px;
    box-sizing: border-box; line-height: 1;
  }
  .pt-thumb__acts { gap: 0.55rem; }
  .pt-thumb__bar { padding: 0.3rem 0.4rem; }
}
/* the OCR dialog's English checkbox row is hidden while English itself is picked (the
   hidden attr loses to .pt-check's inline-flex otherwise); on a touch screen its language
   picker, checkbox row and buttons are 44 px tall */
#pt-ocr-eng-row[hidden] { display: none !important; }
@media (pointer: coarse) {
  #pt-ocr-dialog .pt-field select, #pt-ocr-dialog .pt-check, #pt-ocr-dialog .pt-modal__foot .pt-btn { min-height: 44px; box-sizing: border-box; }
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
  "description": "Free private PDF tools that run entirely in the browser: merge and split PDFs, reorder and rotate pages, fill forms, add signatures, add text and format it with bold, italic, underline, highlight and alignment, true redaction, OCR in 22 languages to make scanned PDFs searchable, watermarks, page numbers, export pages as images, compression, and AES-256 password protection. Files are never uploaded.",
  "featureList": "Merge PDFs, split PDFs, reorder pages, rotate pages, delete pages, duplicate pages, insert blank pages, extract page ranges, fill PDF forms, sign PDFs, add text to a PDF, format text with bold, italic, underline, strikethrough, highlight, color, line spacing and alignment, redact PDFs, OCR scanned PDFs in 22 languages, copy clean text from a PDF, add watermarks, add page numbers, export pages as images, compress PDFs, password-protect PDFs, strip metadata, undo"
}
</script>

<!-- pdf-lib and pdf.js (assets/js/pdflib/) are loaded by pdftools.js after the page, at idle or on the first file -->
<script defer src="{{ '/assets/js/pdftools.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/pdftools-tools.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/pdftools-editor.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
