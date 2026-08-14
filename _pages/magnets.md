---
layout: single
title: "Magnetic Field Visualizer"
permalink: /magnets/
og_image: /images/og/magnets.png
author_profile: false
excerpt: "A full-screen sandbox: drop bar magnets, watch their field lines, and let them snap and repel."
description: "An interactive full-screen magnetic-field sandbox by Keane Lucas: place bar magnets of different strengths, drag and rotate them, and watch the field lines they trace. Opposite poles attract and snap into a stronger magnet; like poles push apart. Optional iron filings, and a toggle to freeze the dynamics for a static field study."
---

<div class="mag-app life-app">
  <div class="mag-topfade" aria-hidden="true"></div>
  <canvas id="mag-canvas" class="mag-canvas"
          aria-label="A full-screen magnetic field sandbox: place bar magnets and watch their field lines; opposite poles snap together, like poles repel."></canvas>

  <div class="mag-panel" id="mag-panel">
    <div class="mag-panel__head">
      <span class="mag-panel__title">Magnetic Field</span>
      <button id="mag-help" class="gadget-help" type="button" aria-label="Show hint" title="Show hint">?</button>
      <button id="mag-collapse" class="mag-collapse" type="button" aria-label="Hide / show controls" title="Hide / show controls">&ndash;</button>
    </div>
    <div class="mag-panel__body" id="mag-panel-body">
      <label class="mag-slider"><span>New magnet strength: <strong id="mag-strength-val" class="editable-val" data-range="mag-strength">3.0</strong></span>
        <input id="mag-strength" type="range" min="1" max="9" step="0.5" value="3"></label>
      <label class="mag-slider"><span>Field lines: <strong id="mag-lines-val" class="editable-val" data-range="mag-lines">12</strong></span>
        <input id="mag-lines" type="range" min="0" max="24" step="1" value="12"></label>

      <div class="mag-checks">
        <label class="mag-check"><input id="mag-filings" type="checkbox"> Iron filings</label>
        <label class="mag-check"><input id="mag-physics" type="checkbox" checked> Magnets move &amp; rotate</label>
        <label class="mag-check"><input id="mag-compass" type="checkbox" checked> Compass (drag it around the field)</label>
      </div>

      <div class="mag-row">
        <button id="mag-preset" class="mag-btn" type="button">Two magnets</button>
        <button id="mag-clear" class="mag-btn" type="button">Clear</button>
      </div>

      <p class="mag-status-line"><span id="mag-status">0 magnets</span></p>

      <p class="mag-blurb">
        <strong>Click</strong> empty space to drop a bar magnet. <strong>Drag the middle</strong>
        to move it, <strong>drag an end</strong> to spin it. Each has a north (red) and south (blue)
        pole; field lines leave the north and curl into the south. Bring opposite poles together and
        they <strong>snap</strong> into a stronger magnet; line up like poles and they shove apart.
      </p>
      <p class="mag-edu">Each magnet is modelled as two point poles; real magnets are continuous dipoles, but the field pattern matches.</p>
      <p class="mag-hint">
        <strong>Right-click</strong> (or press and hold) a magnet: delete &middot;
        <strong>Scroll</strong> over one, or <strong>tap</strong> it for + / &minus; buttons: change its strength
      </p>
    </div>
  </div>
</div>

<style>
/* Full-screen takeover: hide the normal page chrome, let the fixed canvas own the
   viewport. (These rules only load on /magnets/.) */
.page__title, .page__meta, .page__footer { display: none !important; }
.page__content { pointer-events: none; }
.mag-canvas, .mag-panel { pointer-events: auto; }

.masthead { background: transparent !important; border-bottom: 0 !important; }
.greedy-nav { background: transparent !important; }
.mag-topfade {
  position: fixed; top: 0; left: 0; right: 0; height: 120px;
  z-index: 10; pointer-events: none;
  background: linear-gradient(to bottom,
    rgba(14,16,22,0.96) 0%, rgba(14,16,22,0.82) 32%, rgba(14,16,22,0) 100%);
}
html[data-theme="light"] .mag-topfade {
  background: linear-gradient(to bottom,
    rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .mag-topfade {
    background: linear-gradient(to bottom,
      rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
  }
}

.mag-canvas {
  position: fixed; inset: 0; width: 100vw; height: 100vh; height: 100dvh;
  z-index: 0; background: transparent; cursor: crosshair;
  touch-action: none;
}

.mag-panel {
  position: fixed; top: 4.6rem; right: 1rem; z-index: 30;
  width: 270px; max-width: calc(100vw - 2rem);
  /* bottom edge stays clear of the chat bar (desktop) and the corner buttons */
  max-height: calc(100vh - 10rem); max-height: calc(100dvh - 10rem);
  overflow: auto; padding: 0.85rem 1rem 1rem;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
  background: rgba(18,18,18,0.94);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  box-shadow: 0 6px 24px rgba(0,0,0,0.35); font-size: 0.92em;
}
html[data-theme="light"] .mag-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .mag-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
}

@media screen and (max-width: 768px) {
  /* the corner buttons are raised to bottom: 4rem here, so give them more room */
  .mag-panel { max-height: calc(100vh - 12.5rem); max-height: calc(100dvh - 12.5rem); }
}

/* ---- scroll cues (voyage pattern): the panel is height-capped and scrolls,
   and on short viewports the overlay scrollbar hid that. Two cues: a thin
   scrollbar that stays drawn while scrollable, and a soft bottom fade driven
   by a scroll timeline (off when the panel fits, gone at the end). ---- */
@media (pointer: fine) {
  .mag-panel::-webkit-scrollbar { width: 9px; }
  .mag-panel::-webkit-scrollbar-track { background: transparent; }
  .mag-panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.26); border-radius: 5px; }
  .mag-panel:hover::-webkit-scrollbar-thumb,
  .mag-panel:focus-within::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.46); }
}
@supports not selector(::-webkit-scrollbar) {
  .mag-panel { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.30) transparent; }
}
@keyframes mag-scrollcue { from { opacity: 1; } to { opacity: 0; } }
.mag-panel::after {
  content: ''; display: block; pointer-events: none;
  position: sticky; bottom: 0; height: 1.55rem;
  /* negative TOP margin matching the height: a negative bottom margin would
     add phantom scroll height and switch the cue on over panels that fit */
  margin: -1.55rem -1rem 0;
  background: linear-gradient(to bottom, rgba(12,12,12,0), rgba(12,12,12,0.40));
  opacity: 0;
  /* longhands + `nearest` on purpose: the shorthand resets animation-timeline,
     and scroll(self) resolves against the pseudo-element */
  animation-name: mag-scrollcue;
  animation-duration: auto;
  animation-timing-function: linear;
  animation-fill-mode: both;
  animation-timeline: scroll(nearest block);
  animation-range: calc(100% - 2.5rem) 100%;
}
.mag-panel--collapsed::after { display: none; }
/* light theme fades to a soft DARK shadow, never white-on-white */
html[data-theme="light"] .mag-panel::after { background: linear-gradient(to bottom, rgba(30,32,38,0), rgba(30,32,38,0.30)); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .mag-panel::after { background: linear-gradient(to bottom, rgba(30,32,38,0), rgba(30,32,38,0.30)); }
}
@media (pointer: fine) {
  html[data-theme="light"] .mag-panel::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.24); }
  html[data-theme="light"] .mag-panel:hover::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.44); }
}
@media (pointer: fine) and (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .mag-panel::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.24); }
  html:not([data-theme="dark"]) .mag-panel:hover::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.44); }
}
@supports not selector(::-webkit-scrollbar) {
  html[data-theme="light"] .mag-panel { scrollbar-color: rgba(0,0,0,0.28) transparent; }
}
@supports not selector(::-webkit-scrollbar) {
  @media (prefers-color-scheme: light) {
    html:not([data-theme="dark"]) .mag-panel { scrollbar-color: rgba(0,0,0,0.28) transparent; }
  }
}

.mag-panel__head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.mag-panel__title { font-weight: 700; font-size: 1.05em; }
.mag-collapse {
  font: inherit; line-height: 1; cursor: pointer; color: inherit;
  width: 1.8em; height: 1.8em; padding: 0;
  border: 1px solid rgba(127,127,127,0.4); border-radius: 6px; background: rgba(127,127,127,0.12);
}
.mag-panel--collapsed .mag-panel__body { display: none; }
.mag-panel__body { display: flex; flex-direction: column; gap: 0.8rem; margin-top: 0.7rem; }
.mag-blurb { margin: 0; font-size: 0.9em; opacity: 0.85; line-height: 1.5; }
.mag-edu { margin: 0; font-size: 0.82em; opacity: 0.7; line-height: 1.5; }

.mag-slider { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.95em; }
.mag-slider strong { font-variant-numeric: tabular-nums; }
.mag-slider input[type="range"] { width: 100%; accent-color: #82a6cc; }
.mag-checks { display: flex; flex-direction: column; gap: 0.4rem; }
.mag-check { display: inline-flex; align-items: center; gap: 0.45rem; font-size: 0.95em; cursor: pointer; }
.mag-check input { accent-color: #82a6cc; }
.mag-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.mag-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14);
  border-radius: 6px; padding: 0.45em 0.7em; transition: background 0.15s ease;
}
.mag-btn:hover { background: rgba(127,127,127,0.26); }
.mag-hint { font-size: 0.82em; opacity: 0.75; margin: 0; line-height: 1.6; }
.mag-hint strong { opacity: 0.95; }
.mag-status-line { margin: 0; font-size: 0.85em; opacity: 0.7; font-variant-numeric: tabular-nums; }

html[data-theme="light"] .mag-slider input[type="range"],
html[data-theme="light"] .mag-check input { accent-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .mag-slider input[type="range"],
  html:not([data-theme="dark"]) .mag-check input { accent-color: #34568a; }
}
</style>

<script defer src="{{ '/assets/js/gadget-ui.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/magnet.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/editable-values.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
