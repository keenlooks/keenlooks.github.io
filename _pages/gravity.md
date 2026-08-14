---
layout: single
title: "Gravity Sandbox"
permalink: /gravity/
author_profile: false
excerpt: "A full-screen 2D n-body gravity playground: pick a mass, click to drop a body, or drag it to fling it into orbit, and watch everything pull on everything else."
description: "An interactive full-screen 2D gravity sandbox by Keane Lucas: pick a mass, click to drop a body, or drag to fling it into orbit. Newtonian gravity pulls everything together and colliding bodies merge. Trace orbits and visualize each body's gravity well."
---

<div class="grav-app life-app">
  <div class="grav-topfade" aria-hidden="true"></div>
  <canvas id="grav-canvas" class="grav-canvas"
          aria-label="A full-screen 2D gravity sandbox: click to drop masses, drag to fling them into orbit; they attract each other and merge on contact."></canvas>

  <div class="grav-panel" id="grav-panel">
    <div class="grav-panel__head">
      <span class="grav-panel__title">Gravity Sandbox</span>
      <button id="grav-help" class="gadget-help" type="button" aria-label="Show hint" title="Show hint">?</button>
      <button id="grav-collapse" class="grav-collapse" type="button" aria-label="Hide / show controls" title="Hide / show controls">&ndash;</button>
    </div>
    <div class="grav-panel__body" id="grav-panel-body">
      <label class="grav-slider"><span>Mass: <strong id="grav-mass-val" class="editable-val" data-range="grav-mass">400</strong></span>
        <input id="grav-mass" type="range" min="5" max="10000" step="5" value="400"></label>
      <label class="grav-slider"><span>Speed: <strong id="grav-speed-val" class="editable-val" data-range="grav-speed">1.00&times;</strong></span>
        <input id="grav-speed" type="range" min="0" max="3" step="0.05" value="1"></label>

      <div class="grav-checks">
        <label class="grav-check"><input id="grav-trails" type="checkbox"> Trace orbits</label>
        <label class="grav-check"><input id="grav-wells" type="checkbox"> Gravity wells</label>
      </div>

      <div class="grav-row">
        <button id="grav-pause" class="grav-btn" type="button">Pause</button>
        <button id="grav-preset" class="grav-btn" type="button">Solar system</button>
        <button id="grav-accrete" class="grav-btn" type="button">Accretion disk</button>
        <button id="grav-binary" class="grav-btn" type="button" title="Two equal stars orbiting their barycentre, with circumbinary planets">Binary stars</button>
        <button id="grav-eight" class="grav-btn" type="button" title="The Chenciner–Montgomery figure-8: three equal masses chasing each other along one shared orbit">Figure-8</button>
        <button id="grav-clear" class="grav-btn" type="button">Clear</button>
        <button id="grav-resetview" class="grav-btn" type="button" title="Re-center the camera and reset the zoom">Reset view</button>
        <button id="grav-share" class="grav-btn" type="button" title="Copy a link to this exact scene">Share</button>
        <button id="grav-snap" class="grav-btn" type="button" title="Download the scene as a PNG">Save image</button>
      </div>

      <p class="grav-status-line"><span id="grav-status">0 bodies</span></p>

      <p class="grav-blurb">
        Pick a <strong>mass</strong>, then <strong>click</strong> empty space to drop a body,
        or <strong>drag and release</strong> to fling it into orbit. <strong>Click an existing body</strong>
        to retarget its velocity (drag to aim, or click without dragging to stop it). Everything pulls on
        everything else; bodies that collide <strong>merge</strong>. Tip: drop one heavy "sun," then lower
        the mass and fling light planets around it.
      </p>
      <p class="grav-edu">Every pair attracts with F = G&middot;m&#8321;&middot;m&#8322;/r&sup2;.</p>
      <p class="grav-hint">
        <strong>Click a body</strong>: retarget / stop it &middot; <strong>Right-click</strong> (or press and hold) a body: delete &middot;
        <strong>Right-drag</strong>: pan &middot; <strong>Scroll / pinch</strong>: zoom &middot;
        <strong>Space</strong>: pause &middot; <strong>R</strong>: reset view
      </p>
    </div>
  </div>
</div>

<style>
/* Full-screen takeover: hide the normal page chrome, let the fixed canvas own the
   viewport. (These rules only load on /gravity/.) */
.page__title, .page__meta, .page__footer { display: none !important; }
.page__content { pointer-events: none; }                 /* clicks fall through to the canvas... */
.grav-canvas, .grav-panel { pointer-events: auto; }      /* ...except the canvas + controls */

/* Header: swap the solid nav block for a soft top fade so the scene shows through
   and gently fades in just below the nav (links stay readable). */
.masthead { background: transparent !important; border-bottom: 0 !important; }
.greedy-nav { background: transparent !important; }
.grav-topfade {
  position: fixed; top: 0; left: 0; right: 0; height: 120px;
  z-index: 10;                 /* above the canvas (0), below the nav (20) + panel (30) */
  pointer-events: none;
  background: linear-gradient(to bottom,
    rgba(12,14,19,0.96) 0%, rgba(12,14,19,0.82) 32%, rgba(12,14,19,0) 100%);
}
html[data-theme="light"] .grav-topfade {
  background: linear-gradient(to bottom,
    rgba(238,241,245,0.96) 0%, rgba(238,241,245,0.82) 32%, rgba(238,241,245,0) 100%);
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .grav-topfade {
    background: linear-gradient(to bottom,
      rgba(238,241,245,0.96) 0%, rgba(238,241,245,0.82) 32%, rgba(238,241,245,0) 100%);
  }
}

.grav-canvas {
  position: fixed; inset: 0; width: 100vw; height: 100vh; height: 100dvh;
  z-index: 0; background: transparent; cursor: crosshair;
  touch-action: none;          /* drag works on touch without scrolling */
}

.grav-panel {
  position: fixed; top: 4.6rem; right: 1rem; z-index: 30;
  width: 270px; max-width: calc(100vw - 2rem);
  /* bottom edge stays clear of the chat bar (desktop) and the corner buttons */
  max-height: calc(100vh - 10rem); max-height: calc(100dvh - 10rem);
  overflow: auto; padding: 0.85rem 1rem 1rem;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
  background: rgba(18,18,18,0.94);          /* near-solid so the scene behind stays readable */
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  box-shadow: 0 6px 24px rgba(0,0,0,0.35); font-size: 0.92em;
}
html[data-theme="light"] .grav-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .grav-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
}

@media screen and (max-width: 768px) {
  /* the corner buttons are raised to bottom: 4rem here, so give them more room */
  .grav-panel { max-height: calc(100vh - 12.5rem); max-height: calc(100dvh - 12.5rem); }
}

/* ---- scroll cues (voyage pattern): the panel is height-capped and scrolls,
   and on short viewports the overlay scrollbar hid that. Two cues: a thin
   scrollbar that stays drawn while scrollable, and a soft bottom fade driven
   by a scroll timeline (off when the panel fits, gone at the end). ---- */
@media (pointer: fine) {
  .grav-panel::-webkit-scrollbar { width: 9px; }
  .grav-panel::-webkit-scrollbar-track { background: transparent; }
  .grav-panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.26); border-radius: 5px; }
  .grav-panel:hover::-webkit-scrollbar-thumb,
  .grav-panel:focus-within::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.46); }
}
@supports not selector(::-webkit-scrollbar) {
  .grav-panel { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.30) transparent; }
}
@keyframes grav-scrollcue { from { opacity: 1; } to { opacity: 0; } }
.grav-panel::after {
  content: ''; display: block; pointer-events: none;
  position: sticky; bottom: 0; height: 1.55rem;
  /* negative TOP margin matching the height: a negative bottom margin would
     add phantom scroll height and switch the cue on over panels that fit */
  margin: -1.55rem -1rem 0;
  background: linear-gradient(to bottom, rgba(12,12,12,0), rgba(12,12,12,0.40));
  opacity: 0;
  /* longhands + `nearest` on purpose: the shorthand resets animation-timeline,
     and scroll(self) resolves against the pseudo-element */
  animation-name: grav-scrollcue;
  animation-duration: auto;
  animation-timing-function: linear;
  animation-fill-mode: both;
  animation-timeline: scroll(nearest block);
  animation-range: calc(100% - 2.5rem) 100%;
}
.grav-panel--collapsed::after { display: none; }
/* light theme fades to a soft DARK shadow, never white-on-white */
html[data-theme="light"] .grav-panel::after { background: linear-gradient(to bottom, rgba(30,32,38,0), rgba(30,32,38,0.30)); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .grav-panel::after { background: linear-gradient(to bottom, rgba(30,32,38,0), rgba(30,32,38,0.30)); }
}
@media (pointer: fine) {
  html[data-theme="light"] .grav-panel::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.24); }
  html[data-theme="light"] .grav-panel:hover::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.44); }
}
@media (pointer: fine) and (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .grav-panel::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.24); }
  html:not([data-theme="dark"]) .grav-panel:hover::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.44); }
}
@supports not selector(::-webkit-scrollbar) {
  html[data-theme="light"] .grav-panel { scrollbar-color: rgba(0,0,0,0.28) transparent; }
}
@supports not selector(::-webkit-scrollbar) {
  @media (prefers-color-scheme: light) {
    html:not([data-theme="dark"]) .grav-panel { scrollbar-color: rgba(0,0,0,0.28) transparent; }
  }
}

.grav-panel__head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.grav-panel__title { font-weight: 700; font-size: 1.05em; }
.grav-collapse {
  font: inherit; line-height: 1; cursor: pointer; color: inherit;
  width: 1.8em; height: 1.8em; padding: 0;
  border: 1px solid rgba(127,127,127,0.4); border-radius: 6px; background: rgba(127,127,127,0.12);
}
.grav-panel--collapsed .grav-panel__body { display: none; }
.grav-panel__body { display: flex; flex-direction: column; gap: 0.8rem; margin-top: 0.7rem; }
.grav-blurb { margin: 0; font-size: 0.9em; opacity: 0.85; line-height: 1.5; }
.grav-edu { margin: 0; font-size: 0.82em; opacity: 0.7; }

.grav-slider { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.95em; }
.grav-slider strong { font-variant-numeric: tabular-nums; }
.grav-slider input[type="range"] { width: 100%; accent-color: #82a6cc; }
.grav-checks { display: flex; flex-direction: column; gap: 0.4rem; }
.grav-check { display: inline-flex; align-items: center; gap: 0.45rem; font-size: 0.95em; cursor: pointer; }
.grav-check input { accent-color: #82a6cc; }
.grav-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.grav-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14);
  border-radius: 6px; padding: 0.45em 0.7em; transition: background 0.15s ease;
}
.grav-btn:hover { background: rgba(127,127,127,0.26); }
.grav-hint { font-size: 0.82em; opacity: 0.75; margin: 0; line-height: 1.6; }
.grav-hint strong { opacity: 0.95; }
.grav-status-line { margin: 0; font-size: 0.85em; opacity: 0.7; font-variant-numeric: tabular-nums; }

html[data-theme="light"] .grav-slider input[type="range"],
html[data-theme="light"] .grav-check input { accent-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .grav-slider input[type="range"],
  html:not([data-theme="dark"]) .grav-check input { accent-color: #34568a; }
}
</style>

<script defer src="{{ '/assets/js/gadget-ui.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/share-hash.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/gravity.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/editable-values.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
