---
layout: single
title: "Fourier Drawing Machine"
permalink: /fourier/
author_profile: false
excerpt: "Draw any shape and a chain of rotating circles traces it back."
description: "An interactive Fourier drawing machine by Keane Lucas: sketch any shape and a stack of rotating circles, sized by the discrete Fourier transform of your stroke, redraws it. More circles means a closer fit."
---

<div class="fx-app life-app">
  <div class="fx-topfade" aria-hidden="true"></div>
  <canvas id="fx-canvas" class="fx-canvas"
          aria-label="A full-screen drawing canvas. Sketch any shape and a chain of rotating circles retraces it as a Fourier series."></canvas>
  <div class="fx-hint" id="fx-hint" aria-hidden="true">draw something</div>

  <div class="fx-panel tex2jax_ignore" id="fx-panel">
    <div class="fx-panel__head">
      <span class="fx-panel__title">Fourier Drawing Machine</span>
      <button id="fx-collapse" class="fx-collapse" type="button" aria-label="Hide controls" title="Hide / show controls">&ndash;</button>
    </div>
    <div class="fx-panel__body" id="fx-panel-body">
      <p class="fx-blurb">
        Any closed curve can be rewritten as a sum of circles, each spinning at its own
        steady rate and riding on the tip of the one before it. Keeping more circles
        captures finer detail, so the traced path follows your drawing more closely.
      </p>

      <label class="fx-slider"><span>Circles: <strong id="fx-terms-val" class="editable-val" data-range="fx-terms">40</strong></span>
        <input id="fx-terms" type="range" min="1" max="150" step="1" value="40"></label>

      <label class="fx-slider"><span>Speed: <strong id="fx-speed-val" class="editable-val" data-range="fx-speed">1.00&times;</strong></span>
        <input id="fx-speed" type="range" min="0" max="3" step="0.05" value="1"></label>

      <label class="fx-field"><span>Presets</span>
        <select id="fx-preset">
          <option value="">Choose a shape</option>
          <option value="dipper">Big Dipper</option>
          <option value="star">Star</option>
          <option value="heart">Heart</option>
        </select>
      </label>

      <div class="fx-row">
        <button id="fx-pause" class="fx-btn" type="button">Pause</button>
        <button id="fx-clear" class="fx-btn" type="button">Clear</button>
      </div>

      <p class="fx-readout-line"><span id="fx-readout">40 circles approximate your drawing</span></p>
    </div>
  </div>
</div>

<style>
/* Full-screen takeover: hide the normal page chrome, let the fixed canvas own the
   viewport. (These rules only load on /fourier/.) */
.page__title, .page__meta, .page__footer { display: none !important; }
.page__content { pointer-events: none; }
.fx-canvas, .fx-panel { pointer-events: auto; }

.masthead { background: transparent !important; border-bottom: 0 !important; }
.greedy-nav { background: transparent !important; }
.fx-topfade {
  position: fixed; top: 0; left: 0; right: 0; height: 120px;
  z-index: 10; pointer-events: none;
  background: linear-gradient(to bottom,
    rgba(14,16,20,0.96) 0%, rgba(14,16,20,0.82) 32%, rgba(14,16,20,0) 100%);
}
html[data-theme="light"] .fx-topfade {
  background: linear-gradient(to bottom,
    rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .fx-topfade {
    background: linear-gradient(to bottom,
      rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
  }
}

.fx-canvas {
  position: fixed; inset: 0; width: 100vw; height: 100vh;
  z-index: 0; background: transparent; cursor: crosshair;
  touch-action: none;
}

.fx-hint {
  position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
  z-index: 5; pointer-events: none;
  font-size: 1.25em; letter-spacing: 0.08em;
  color: rgba(127,127,127,0.8);
  transition: opacity 0.8s ease;
}
.fx-hint--hidden { opacity: 0; }

.fx-panel {
  position: fixed; top: 4.6rem; right: 1rem; z-index: 30;
  width: 280px; max-width: calc(100vw - 2rem); max-height: calc(100vh - 6rem);
  overflow: auto; padding: 0.85rem 1rem 1rem;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
  background: rgba(18,18,18,0.94);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  box-shadow: 0 6px 24px rgba(0,0,0,0.35); font-size: 0.92em;
}
html[data-theme="light"] .fx-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .fx-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
}

.fx-panel__head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.fx-panel__title { font-weight: 700; font-size: 1.05em; }
.fx-collapse {
  font: inherit; line-height: 1; cursor: pointer; color: inherit;
  width: 1.8em; height: 1.8em; padding: 0;
  border: 1px solid rgba(127,127,127,0.4); border-radius: 6px; background: rgba(127,127,127,0.12);
}
.fx-panel--collapsed .fx-panel__body { display: none; }
.fx-panel__body { display: flex; flex-direction: column; gap: 0.8rem; margin-top: 0.7rem; }
.fx-blurb { margin: 0; font-size: 0.9em; opacity: 0.85; line-height: 1.5; }
.fx-slider { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.95em; }
.fx-slider strong { font-variant-numeric: tabular-nums; }
.fx-slider input[type="range"] { width: 100%; accent-color: #82a6cc; }
.fx-field { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.95em; }
/* Solid, high-contrast select (the theme's faint form styling washes these out). */
.fx-field select {
  font: inherit; padding: 0.45em 0.5em; border-radius: 6px;
  color: #e8e8e8; background: #20242c; border: 1px solid rgba(255,255,255,0.18);
}
.fx-field select option { color: #e8e8e8; background: #20242c; }
html[data-theme="light"] .fx-field select { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.2); }
html[data-theme="light"] .fx-field select option { color: #1f2430; background: #fff; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .fx-field select { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.2); }
  html:not([data-theme="dark"]) .fx-field select option { color: #1f2430; background: #fff; }
}
.fx-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.fx-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14);
  border-radius: 6px; padding: 0.45em 0.7em; transition: background 0.15s ease;
}
.fx-btn:hover { background: rgba(127,127,127,0.26); }
.fx-readout-line { margin: 0; font-size: 0.85em; opacity: 0.75; font-variant-numeric: tabular-nums; min-height: 1.2em; }

html[data-theme="light"] .fx-slider input[type="range"] { accent-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .fx-slider input[type="range"] { accent-color: #34568a; }
}
</style>

<script defer src="{{ '/assets/js/fourier.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/editable-values.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
