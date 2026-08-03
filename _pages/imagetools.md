---
layout: single
title: "Resize an Image to an Exact File Size in Your Browser"
permalink: /imagetools/
author_profile: false
excerpt: "Resize an image to a target file size, crop it, rotate it, strip metadata, and generate a favicon pack, all running privately in your browser with nothing uploaded."
description: "Resize an image to an exact file size (like 500 KB) for upload forms, right in your browser. Also crop, rotate, convert JPEG/PNG/WebP, strip EXIF metadata, and generate a favicon pack as a .zip. Nothing is uploaded; everything runs locally."
---

<div class="it-wrap">

  <h1 class="it-title">Image Studio</h1>

  <p class="it-intro">
    A small image utility that runs entirely in your browser. Resize a photo down to whatever file
    size a form demands, crop and rotate it, convert formats, or turn an image into a favicon pack.
    Nothing is uploaded anywhere; the file never leaves your device, and re-saving it strips the EXIF
    metadata (camera model, GPS location, timestamps) along the way.
  </p>
  <p class="it-privacy" style="margin:0 0 0.4rem">A caveat: this is a personal side project and I have not
  tested it exhaustively. I make no guarantees; keep your original files.</p>

  <div class="it-grid">
    <div class="it-left">
      <div id="it-drop" class="it-drop">
        <input id="it-file" type="file" accept="image/*" hidden style="display:none!important">
        <canvas id="it-canvas" class="it-canvas" aria-label="Image preview"></canvas>
        <div class="it-drop__hint">
          <strong>Drop an image here</strong><br>or click to choose one
        </div>
      </div>
      <div class="it-tools">
        <button id="it-rot-l" class="it-btn" type="button" title="Rotate 90° left">⟲</button>
        <button id="it-rot-r" class="it-btn" type="button" title="Rotate 90° right">⟳</button>
        <button id="it-flip-h" class="it-btn" type="button" title="Flip horizontal">⇋</button>
        <button id="it-flip-v" class="it-btn" type="button" title="Flip vertical">⇅</button>
        <button id="it-crop" class="it-btn" type="button" title="Drag a box on the image to crop">Crop</button>
        <button id="it-cutout" class="it-btn" type="button" title="Brush what to keep and what to remove" disabled>Cut out background</button>
        <button id="it-undo" class="it-btn" type="button" title="Undo (Ctrl+Z)" disabled>↶ Undo</button>
        <button id="it-reset" class="it-btn" type="button">Reset</button>
      </div>
      <p class="it-dims"><span id="it-dims">–</span> <span class="it-hint" id="it-rot-hint"></span></p>
    </div>

    <div class="it-right">
      <h2 class="it-h">Export</h2>
      <label class="it-field"><span>Format</span>
        <select id="it-format">
          <option value="jpeg">JPEG (photos, smallest)</option>
          <option value="png">PNG (lossless, transparency)</option>
          <option value="webp">WebP (modern, small)</option>
        </select>
      </label>
      <label class="it-field"><span>Mode</span>
        <select id="it-mode">
          <option value="target">Hit a target file size</option>
          <option value="quality">Set quality manually</option>
        </select>
      </label>
      <label class="it-field" id="it-target-row"><span>Target size: <strong id="it-target-val">500 KB</strong></span>
        <input id="it-target" type="range" min="20" max="3000" step="10" value="500"></label>
      <label class="it-field" id="it-qual-row" style="display:none"><span>Quality: <strong id="it-qual-val">0.85</strong></span>
        <input id="it-qual" type="range" min="0.2" max="0.95" step="0.01" value="0.85"></label>

      <details class="it-adv">
        <summary>Advanced: limit dimensions</summary>
        <label class="it-field"><span>Max width or height (px)</span>
          <input id="it-maxdim" type="number" min="16" max="20000" value="20000"></label>
      </details>

      <p class="it-estimate" id="it-estimate"></p>
      <button id="it-download" class="it-btn it-btn--accent it-wide" type="button">Download image</button>

      <h2 class="it-h it-h--gap">Favicon pack</h2>
      <p class="it-note">Generate every common favicon size, a <code>site.webmanifest</code>, and the
      <code>&lt;link&gt;</code> snippet, bundled as a <code>.zip</code>. A square center-crop is used.</p>
      <button id="it-favicon" class="it-btn it-wide" type="button">Generate favicon pack (.zip)</button>

      <p class="it-status" id="it-status" aria-live="polite"></p>
      <p class="it-privacy">🔒 100% in-browser. Your image is never uploaded. (I use Google Analytics to see whether anyone visits this page, but it cannot see your image.)</p>
    </div>
  </div>

  <div class="it-faq">
    <h2 class="it-h">FAQ</h2>
    <details>
      <summary>How do I resize an image to an exact file size?</summary>
      <p>Drop the image in, leave the mode on "Hit a target file size", and set the size the form
      is asking for. The tool searches JPEG or WebP quality settings for the largest output that
      fits under the limit, and scales the image down if quality alone can't get there.</p>
    </details>
    <details>
      <summary>Does my image get uploaded?</summary>
      <p>No. The whole tool runs in your browser, and the file never leaves your device.
      (I use Google Analytics to see whether anyone visits this page, but it cannot see your image.)</p>
    </details>
    <details>
      <summary>What's in the favicon pack?</summary>
      <p>PNG icons at 16, 32, 48, 96, 192, and 512 pixels, an <code>apple-touch-icon.png</code> at
      180 pixels, a starter <code>site.webmanifest</code>, and a <code>snippet.html</code> with the
      <code>&lt;link&gt;</code> tags to paste into your page's head, all in one .zip. The icons are
      cut from a square center-crop of your image.</p>
    </details>
  </div>

  <p class="it-credit" id="it-cut-credit" hidden>Cutout segmentation: SAM 2 (Meta AI, Apache 2.0) via ONNX Runtime Web (Microsoft, MIT).</p>
</div>

<!-- Cut out background: the workspace overlay. Hidden until the button opens
     it; imagetools-cutout.js hoists it to <body> so no stacking context in
     the page can trap it under the masthead. -->
<div id="it-cut" class="it-cut" hidden aria-hidden="true" role="dialog" aria-modal="true" aria-labelledby="it-cut-title">
  <div class="it-cut__panel">
    <div class="it-cut__head">
      <h2 class="it-cut__title" id="it-cut-title">Cut out background</h2>
      <button id="it-cut-close" class="it-btn it-cut__x" type="button" aria-label="Close the cutout workspace">✕</button>
    </div>
    <p class="it-cut__intro">Brush over what to keep and what to remove. The photo stays on your device.</p>
    <p class="it-cut__dl" id="it-cut-dl"></p>

    <div class="it-cut__stage" id="it-cut-stage">
      <canvas id="it-cut-canvas" class="it-cut__canvas" aria-label="Cutout preview. Drag on the image to brush."></canvas>
    </div>

    <div class="it-cut__tools">
      <button id="it-cut-keep" class="it-btn it-btn--on" type="button" aria-pressed="true">Keep</button>
      <button id="it-cut-remove" class="it-btn" type="button" aria-pressed="false">Remove</button>
      <button id="it-cut-undo" class="it-btn" type="button" disabled>↶ Undo stroke</button>
      <label class="it-cut__check"><input id="it-cut-dots" type="checkbox" checked> Show brush marks</label>
    </div>

    <div class="it-cut__sliders">
      <label class="it-field"><span>Brush size: <strong id="it-cut-radius-val">24 px</strong></span>
        <input id="it-cut-radius" type="range" min="8" max="64" step="1" value="24"></label>
      <label class="it-field"><span>Feather: <strong id="it-cut-feather-val">3</strong></span>
        <input id="it-cut-feather" type="range" min="0" max="20" step="1" value="3"></label>
    </div>

    <p class="it-cut__status" id="it-cut-status" role="status" aria-live="polite"></p>
    <p class="it-cut__limits">Soft edges like hair come out approximate, and a busy scene can take a few strokes
    to get right. Everything runs locally, so nothing is uploaded.</p>

    <div class="it-cut__actions">
      <button id="it-cut-apply" class="it-btn it-btn--accent" type="button" disabled>Apply cutout</button>
      <button id="it-cut-cancel" class="it-btn" type="button">Cancel</button>
    </div>
  </div>
</div>

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Image Studio",
  "url": "{{ site.url }}{{ site.baseurl }}/imagetools/",
  "applicationCategory": "MultimediaApplication",
  "operatingSystem": "Any (runs in the browser)",
  "browserRequirements": "Requires JavaScript",
  "isAccessibleForFree": true,
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "author": { "@type": "Person", "name": "Keane Lucas", "url": "{{ site.url }}{{ site.baseurl }}/" },
  "description": "An in-browser image utility: resize an image to an exact file size, crop, rotate, flip, convert between JPEG, PNG, and WebP, strip EXIF metadata, and generate a favicon pack as a .zip. Nothing is uploaded."
}
</script>

<style>
/* This is a utility, not an article — let it use more width than the reading column. */
#main { max-width: 1200px; }
.page { float: none; width: 100%; padding-left: 0; padding-right: 0; }
.page__inner-wrap, .page__content { max-width: 100%; }
/* The front-matter title is search-facing; the on-page heading stays "Image Studio". */
.page__title { display: none; }
.it-title { margin: 0 0 0.2em; }
/* Bottom padding so the Export column's buttons can always be scrolled clear of
   the fixed chat bar (full width at 768px and under) and the corner buttons. */
.it-wrap { max-width: 1080px; margin: 0 auto; padding-bottom: 2rem; }
@media (max-width: 768px) { .it-wrap { padding-bottom: 4rem; } }
/* The vertical rhythm above the Export column is deliberately tight: it is what
   keeps "Download image" above the chat bar at a 900px-tall window. */
.it-intro { max-width: 64ch; opacity: 0.9; line-height: 1.6; margin-bottom: 0.35rem; }
.it-grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 1.5rem; margin-top: 1rem; align-items: start; }
@media (max-width: 760px) { .it-grid { grid-template-columns: 1fr; } }

.it-drop {
  position: relative; display: block; border: 2px dashed rgba(127,127,127,0.4); border-radius: 12px;
  background: rgba(127,127,127,0.06); min-height: 300px;
  cursor: pointer; transition: border-color 0.15s ease, background 0.15s ease; overflow: hidden;
}
.it-drop--over { border-color: #82a6cc; background: rgba(130,166,204,0.10); }
.it-drop--has { cursor: default; }
.it-drop--has .it-drop__hint { display: none; }
/* touch-action: none — crop drags and the rotation gizmo use Pointer Events;
   without it, touch drags fight page scrolling on phones (site playbook). */
.it-canvas { width: 100%; height: 420px; display: block; touch-action: none; -ms-touch-action: none; }
#it-file { display: none !important; }   /* the theme styles inputs, overriding the `hidden` attr */
.it-drop__hint { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); text-align: center; opacity: 0.7; pointer-events: none; line-height: 1.6; }

.it-tools { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.7rem; }
.it-dims { font-size: 0.85em; opacity: 0.7; margin: 0.5rem 0 0; font-variant-numeric: tabular-nums; }
.it-hint { opacity: 0.85; }

.it-h { font-size: 1.15rem; margin: 0 0 0.45rem; }
.it-h--gap { margin-top: 1.6rem; }
.it-field { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.95em; margin-bottom: 0.6rem; }
/* Solid, high-contrast controls (the theme's faint form styling washed these out). */
.it-field select, .it-field input[type="number"] {
  font: inherit; padding: 0.45em 0.5em; border-radius: 6px;
  color: #e8e8e8; background: #20242c; border: 1px solid rgba(255,255,255,0.18);
}
.it-field select option { color: #e8e8e8; background: #20242c; }
html[data-theme="light"] .it-field select, html[data-theme="light"] .it-field input[type="number"] { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.2); }
html[data-theme="light"] .it-field select option { color: #1f2430; background: #fff; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .it-field select, html:not([data-theme="dark"]) .it-field input[type="number"] { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.2); }
  html:not([data-theme="dark"]) .it-field select option { color: #1f2430; background: #fff; }
}
.it-field input[type="range"] { width: 100%; accent-color: #82a6cc; }
.it-field strong { font-variant-numeric: tabular-nums; }
.it-rotfield { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.92em; margin-top: 0.7rem; }
.it-rotfield input[type="range"] { width: 100%; accent-color: #82a6cc; }
.it-rotfield strong { font-variant-numeric: tabular-nums; }
.it-adv { margin: 0 0 0.4rem; font-size: 0.95em; }
.it-adv summary { cursor: pointer; opacity: 0.8; font-size: 0.9em; }
.it-adv .it-field { margin-top: 0.6rem; }
html[data-theme="light"] .it-rotfield input[type="range"] { accent-color: #34568a; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .it-rotfield input[type="range"] { accent-color: #34568a; } }

.it-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14);
  border-radius: 6px; padding: 0.5em 0.8em; transition: background 0.15s ease;
}
.it-btn:hover { background: rgba(127,127,127,0.26); }
.it-btn--on { background: #82a6cc; border-color: #82a6cc; color: #fff; }
/* `.it-btn:hover` out-specifies `.it-btn--on`, which washed the selected
   state out of a pressed toggle (Crop, and the cutout's Keep/Remove pair).
   On touch the hover sticks after a tap, so the mode looked unset. */
.it-btn--on:hover { background: #82a6cc; border-color: #82a6cc; color: #fff; }
.it-btn--accent { background: #82a6cc; border-color: #82a6cc; color: #fff; }
.it-btn--accent:hover { background: #6f97c2; }
.it-wide { width: 100%; padding: 0.6em; margin-top: 0.3rem; }
.it-estimate { font-size: 0.9em; opacity: 0.85; min-height: 1.2em; margin: 0.15rem 0 0.4rem; font-variant-numeric: tabular-nums; }
.it-note { font-size: 0.85em; opacity: 0.8; line-height: 1.5; margin: 0 0 0.6rem; }
.it-status { font-size: 0.88em; opacity: 0.9; min-height: 1.2em; margin: 0.8rem 0 0.4rem; }
.it-privacy { font-size: 0.82em; opacity: 0.7; margin: 0; }

.it-faq { margin-top: 2.2rem; max-width: 64ch; }
.it-faq details { margin: 0.5rem 0; }
.it-faq summary { cursor: pointer; font-weight: 600; }
.it-faq p { font-size: 0.95em; line-height: 1.6; opacity: 0.9; margin: 0.5rem 0 0.3rem; }

html[data-theme="light"] .it-btn--on, html[data-theme="light"] .it-btn--accent { background: #34568a; border-color: #34568a; }
html[data-theme="light"] .it-btn--on:hover { background: #34568a; border-color: #34568a; }
html[data-theme="light"] .it-field input[type="range"] { accent-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .it-btn--on, html:not([data-theme="dark"]) .it-btn--accent { background: #34568a; border-color: #34568a; }
  html:not([data-theme="dark"]) .it-btn--on:hover { background: #34568a; border-color: #34568a; }
  html:not([data-theme="dark"]) .it-field input[type="range"] { accent-color: #34568a; }
}

/* ---------- Cut out background ---------- */
.it-credit { font-size: 0.8em; opacity: 0.65; margin: 1.6rem 0 0; }
.it-credit[hidden] { display: none !important; }
/* The overlay sits above the chat bar (1050) like the PDF Toolbench editor
   does; `hidden` alone loses to the display rule, hence the [hidden] line. */
.it-cut {
  position: fixed; inset: 0; z-index: 1200; display: flex; overflow: auto;
  padding: 1rem; background: rgba(8,8,10,0.74);
}
.it-cut[hidden] { display: none !important; }
.it-cut, .it-cut * { box-sizing: border-box; }
body.it-cut-open { overflow: hidden; }
.it-cut__panel {
  margin: auto; width: 100%; max-width: 980px; border-radius: 12px;
  padding: 0.9rem 1.1rem 1.1rem; background: #17181c; color: #e2e2e2;
  border: 1px solid rgba(255,255,255,0.15);
}
.it-cut__head { display: flex; align-items: center; gap: 0.6rem; }
.it-cut__title { font-size: 1.2rem; margin: 0; flex: 1 1 auto; color: inherit; }
.it-cut__x { padding: 0.3em 0.6em; line-height: 1; }
.it-cut__intro { margin: 0.35rem 0 0.2rem; font-size: 0.95em; line-height: 1.5; }
.it-cut__dl { margin: 0 0 0.6rem; font-size: 0.85em; opacity: 0.72; line-height: 1.5; }
.it-cut__stage {
  position: relative; height: min(52vh, 460px); border-radius: 8px; overflow: hidden;
  background: rgba(127,127,127,0.10); border: 1px solid rgba(127,127,127,0.28);
}
/* touch-action: none — brushing uses Pointer Events, and without it a finger
   drag scrolls the page instead of painting (site playbook). */
.it-cut__canvas {
  position: absolute; inset: 0; width: 100%; height: 100%; display: block;
  touch-action: none; -ms-touch-action: none; cursor: crosshair;
}
.it-cut__tools { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; margin-top: 0.7rem; }
.it-cut__check { display: inline-flex; align-items: center; gap: 0.35em; font-size: 0.9em; color: inherit; margin: 0 0 0 0.2rem; }
.it-cut__check input { accent-color: #82a6cc; }
.it-cut__sliders { display: grid; grid-template-columns: 1fr 1fr; gap: 0 1rem; margin-top: 0.7rem; }
.it-cut__sliders .it-field { margin-bottom: 0.2rem; color: inherit; }
.it-cut__sliders label span { color: inherit; }
.it-cut__status { font-size: 0.9em; min-height: 1.3em; margin: 0.5rem 0 0.2rem; }
.it-cut__limits { font-size: 0.82em; opacity: 0.7; line-height: 1.5; margin: 0 0 0.7rem; max-width: 62ch; }
.it-cut__actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.it-cut__actions .it-btn { padding: 0.55em 1.1em; }
html[data-theme="light"] .it-cut { background: rgba(232,234,238,0.8); }
html[data-theme="light"] .it-cut__panel { background: #ffffff; color: #262626; border-color: rgba(0,0,0,0.14); }
html[data-theme="light"] .it-cut__check input { accent-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .it-cut { background: rgba(232,234,238,0.8); }
  html:not([data-theme="dark"]) .it-cut__panel { background: #ffffff; color: #262626; border-color: rgba(0,0,0,0.14); }
  html:not([data-theme="dark"]) .it-cut__check input { accent-color: #34568a; }
}
@media (max-width: 760px) {
  .it-cut { padding: 0.5rem; }
  .it-cut__panel { padding: 0.7rem 0.75rem 0.9rem; }
  .it-cut__stage { height: 42vh; }
  .it-cut__sliders { grid-template-columns: 1fr; }
  .it-cut__actions .it-btn { flex: 1 1 auto; }
}
</style>

<script defer src="{{ '/assets/js/imagetools.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/imagetools-cutout.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
