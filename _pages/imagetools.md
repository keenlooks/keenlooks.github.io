---
layout: single
title: "Image Studio"
permalink: /imagetools/
author_profile: false
excerpt: "Resize an image to a target file size, crop, rotate, strip metadata, and generate a favicon pack — all privately in your browser."
description: "A private, in-browser image utility by Keane Lucas: resize an image down to a target file size for upload forms, crop, rotate, flip, convert format, strip EXIF/metadata, and generate a full favicon pack as a .zip. Nothing is uploaded — everything runs locally."
---

<div class="it-wrap">

  <p class="it-intro">
    A small image utility that runs entirely in your browser. Resize a photo down to whatever file
    size a form demands, crop and rotate it, convert formats, or turn an image into a favicon pack.
    Nothing is uploaded anywhere; the file never leaves your device, and re-saving it strips the EXIF
    metadata (camera model, GPS location, timestamps) along the way.
  </p>

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
        <button id="it-undo" class="it-btn" type="button" title="Undo (Ctrl+Z)" disabled>↶ Undo</button>
        <button id="it-reset" class="it-btn" type="button">Reset</button>
      </div>
      <p class="it-dims"><span id="it-dims">—</span> <span class="it-hint" id="it-rot-hint"></span></p>
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

      <p class="it-status" id="it-status"></p>
      <p class="it-privacy">🔒 100% in-browser. Your image is never uploaded.</p>
    </div>
  </div>
</div>

<style>
/* This is a utility, not an article — let it use more width than the reading column. */
#main { max-width: 1200px; }
.page { float: none; width: 100%; padding-left: 0; padding-right: 0; }
.page__inner-wrap, .page__content { max-width: 100%; }
.it-wrap { max-width: 1080px; margin: 0 auto; }
.it-intro { max-width: 64ch; opacity: 0.9; line-height: 1.6; }
.it-grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 1.5rem; margin-top: 1.5rem; align-items: start; }
@media (max-width: 760px) { .it-grid { grid-template-columns: 1fr; } }

.it-drop {
  position: relative; display: block; border: 2px dashed rgba(127,127,127,0.4); border-radius: 12px;
  background: rgba(127,127,127,0.06); min-height: 300px;
  cursor: pointer; transition: border-color 0.15s ease, background 0.15s ease; overflow: hidden;
}
.it-drop--over { border-color: #82a6cc; background: rgba(130,166,204,0.10); }
.it-drop--has { cursor: default; }
.it-drop--has .it-drop__hint { display: none; }
.it-canvas { width: 100%; height: 420px; display: block; }
#it-file { display: none !important; }   /* the theme styles inputs, overriding the `hidden` attr */
.it-drop__hint { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); text-align: center; opacity: 0.7; pointer-events: none; line-height: 1.6; }

.it-tools { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.7rem; }
.it-dims { font-size: 0.85em; opacity: 0.7; margin: 0.5rem 0 0; font-variant-numeric: tabular-nums; }
.it-hint { opacity: 0.85; }

.it-h { font-size: 1.15rem; margin: 0 0 0.6rem; }
.it-h--gap { margin-top: 1.6rem; }
.it-field { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.95em; margin-bottom: 0.8rem; }
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
.it-adv { margin: 0 0 0.6rem; font-size: 0.95em; }
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
.it-btn--accent { background: #82a6cc; border-color: #82a6cc; color: #fff; }
.it-btn--accent:hover { background: #6f97c2; }
.it-wide { width: 100%; padding: 0.6em; margin-top: 0.3rem; }
.it-estimate { font-size: 0.9em; opacity: 0.85; min-height: 1.2em; margin: 0.2rem 0 0.6rem; font-variant-numeric: tabular-nums; }
.it-note { font-size: 0.85em; opacity: 0.8; line-height: 1.5; margin: 0 0 0.6rem; }
.it-status { font-size: 0.88em; opacity: 0.9; min-height: 1.2em; margin: 0.8rem 0 0.4rem; }
.it-privacy { font-size: 0.82em; opacity: 0.7; margin: 0; }

html[data-theme="light"] .it-btn--on, html[data-theme="light"] .it-btn--accent { background: #34568a; border-color: #34568a; }
html[data-theme="light"] .it-field input[type="range"] { accent-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .it-btn--on, html:not([data-theme="dark"]) .it-btn--accent { background: #34568a; border-color: #34568a; }
  html:not([data-theme="dark"]) .it-field input[type="range"] { accent-color: #34568a; }
}
</style>

<script defer src="{{ '/assets/js/imagetools.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
