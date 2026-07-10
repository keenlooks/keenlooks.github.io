---
layout: single
title: "Epidemic"
permalink: /epidemic/
author_profile: false
excerpt: "A stochastic SIR outbreak on a grid: poke it, tune it, vaccinate it, and watch the curve."
description: "An interactive epidemic simulator by Keane Lucas: every cell is a person, infections spread to neighbors with a probability you control, and a live epidemic curve draws along the bottom. Raise the vaccinated share and watch herd immunity stop outbreaks before they spread."
---

<div class="epi-app life-app">
  <div class="epi-topfade" aria-hidden="true"></div>
  <canvas id="epi-canvas" class="epi-canvas"
          aria-label="A full-screen grid epidemic simulation: red cells are infected, blue cells recovered, faint cells susceptible. Click to start infections."></canvas>

  <div class="epi-panel" id="epi-panel">
    <div class="epi-panel__head">
      <span class="epi-panel__title">Epidemic</span>
      <button id="epi-help" class="gadget-help" type="button" aria-label="Show hint" title="Show hint">?</button>
      <button id="epi-collapse" class="epi-collapse" type="button" aria-label="Hide / show controls" title="Hide / show controls">&ndash;</button>
    </div>
    <div class="epi-panel__body" id="epi-panel-body">
      <p class="epi-blurb">
        Every cell is a person. Each day, the <strong style="color:#c4574a">infected</strong> cells pass it
        to nearby susceptible cells with the transmission chance you set, then they recover and become
        immune. <strong>Click or drag</strong> to start infections and watch the case curve along the bottom.
        If you vaccinate enough of the grid first, an outbreak often can't spread, which is roughly what
        herd immunity means. The vaccinated slider works while it's running, and you can also paint
        vaccinated regions directly.
      </p>

      <label class="epi-slider"><span>Transmission chance: <strong id="epi-trans-val" class="editable-val" data-range="epi-trans">10%</strong></span>
        <input id="epi-trans" type="range" min="1" max="50" step="1" value="10"></label>
      <label class="epi-slider"><span>Days infectious: <strong id="epi-dur-val" class="editable-val" data-range="epi-dur">10</strong></span>
        <input id="epi-dur" type="range" min="2" max="30" step="1" value="10"></label>
      <label class="epi-slider"><span>Vaccinated: <strong id="epi-vax-val" class="editable-val" data-range="epi-vax">0%</strong></span>
        <input id="epi-vax" type="range" min="0" max="95" step="5" value="0"></label>

      <p class="epi-r0" id="epi-r0"></p>

      <div class="epi-modes">
        <span class="epi-modes__label">Click to:</span>
        <button class="epi-mode epi-mode--on" data-mode="infect" type="button">Infect</button>
        <button class="epi-mode" data-mode="vaccinate" type="button">Vaccinate</button>
        <button class="epi-mode" data-mode="erase" type="button" title="Paint cells back to plain susceptible (a mouse can also right-drag)">Erase</button>
      </div>

      <div class="epi-row">
        <button id="epi-pause" class="epi-btn" type="button">Pause</button>
        <button id="epi-restart" class="epi-btn" type="button">Restart</button>
        <button id="epi-share" class="epi-btn" type="button" title="Copy a link with these exact settings">Share</button>
        <button id="epi-snap" class="epi-btn" type="button" title="Download the grid as a PNG">Save image</button>
      </div>

      <p class="epi-status-line"><span id="epi-status"></span></p>
    </div>
  </div>
</div>

<style>
/* Full-screen takeover: hide the normal page chrome, let the fixed canvas own the
   viewport. (These rules only load on /epidemic/.) */
.page__title, .page__meta, .page__footer { display: none !important; }
.page__content { pointer-events: none; }
.epi-canvas, .epi-panel { pointer-events: auto; }

.masthead { background: transparent !important; border-bottom: 0 !important; }
.greedy-nav { background: transparent !important; }
.epi-topfade {
  position: fixed; top: 0; left: 0; right: 0; height: 120px;
  z-index: 10; pointer-events: none;
  background: linear-gradient(to bottom,
    rgba(16,18,22,0.96) 0%, rgba(16,18,22,0.82) 32%, rgba(16,18,22,0) 100%);
}
html[data-theme="light"] .epi-topfade {
  background: linear-gradient(to bottom,
    rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .epi-topfade {
    background: linear-gradient(to bottom,
      rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
  }
}

.epi-canvas {
  position: fixed; inset: 0; width: 100vw; height: 100vh;
  z-index: 0; background: transparent; cursor: crosshair;
  touch-action: none;
}

.epi-panel {
  position: fixed; top: 4.6rem; right: 1rem; z-index: 30;
  width: 290px; max-width: calc(100vw - 2rem); max-height: calc(100vh - 6rem);
  overflow: auto; padding: 0.85rem 1rem 1rem;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
  background: rgba(18,18,18,0.94);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  box-shadow: 0 6px 24px rgba(0,0,0,0.35); font-size: 0.92em;
}
html[data-theme="light"] .epi-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .epi-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
}

.epi-panel__head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.epi-panel__title { font-weight: 700; font-size: 1.05em; }
.epi-collapse {
  font: inherit; line-height: 1; cursor: pointer; color: inherit;
  width: 1.8em; height: 1.8em; padding: 0;
  border: 1px solid rgba(127,127,127,0.4); border-radius: 6px; background: rgba(127,127,127,0.12);
}
.epi-panel--collapsed .epi-panel__body { display: none; }
.epi-panel__body { display: flex; flex-direction: column; gap: 0.8rem; margin-top: 0.7rem; }
.epi-blurb { margin: 0; font-size: 0.9em; opacity: 0.85; line-height: 1.5; }
.epi-slider { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.95em; }
.epi-slider strong { font-variant-numeric: tabular-nums; }
.epi-slider input[type="range"] { width: 100%; accent-color: #82a6cc; }
.epi-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.epi-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14);
  border-radius: 6px; padding: 0.45em 0.7em; transition: background 0.15s ease;
}
.epi-btn:hover { background: rgba(127,127,127,0.26); }
.epi-modes { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; font-size: 0.9em; }
.epi-modes__label { opacity: 0.8; }
.epi-mode {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14);
  border-radius: 6px; padding: 0.4em 0.7em; transition: background 0.15s ease;
}
.epi-mode:hover { background: rgba(127,127,127,0.26); }
.epi-mode--on { background: #82a6cc; border-color: #82a6cc; color: #fff; }
html[data-theme="light"] .epi-mode--on { background: #34568a; border-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .epi-mode--on { background: #34568a; border-color: #34568a; }
}
.epi-status-line { margin: 0; font-size: 0.85em; opacity: 0.75; font-variant-numeric: tabular-nums; min-height: 1.2em; }
.epi-r0 { margin: 0; font-size: 0.82em; opacity: 0.75; font-variant-numeric: tabular-nums; }

html[data-theme="light"] .epi-slider input[type="range"] { accent-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .epi-slider input[type="range"] { accent-color: #34568a; }
}
</style>

<script defer src="{{ '/assets/js/gadget-ui.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/share-hash.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/epidemic.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/editable-values.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
