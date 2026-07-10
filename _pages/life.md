---
layout: single
title: "Conway's Game of Life"
permalink: /life/
author_profile: false
excerpt: "An interactive, full-screen Conway's Game of Life."
description: "A full-screen, interactive Conway's Game of Life — draw cells, change the speed, and edit the birth/survival rules."
---

<div class="life-app">
  <div class="life-topfade" aria-hidden="true"></div>
  <canvas id="life-canvas" class="life-canvas" aria-label="Interactive full-screen Game of Life grid"></canvas>

  <div class="life-panel" id="life-panel">
    <div class="life-panel__head">
      <a class="life-panel__title" href="https://en.wikipedia.org/wiki/Conway%27s_Game_of_Life" target="_blank" rel="noopener">Conway's Game of Life</a>
      <button id="life-help" class="gadget-help" type="button" aria-label="Show hint" title="Show hint">?</button>
      <button id="life-collapse" class="life-collapse" type="button" aria-label="Collapse controls" title="Hide / show controls">&ndash;</button>
    </div>

    <div class="life-panel__body" id="life-panel-body">
      <p class="life-blurb">
        A cellular automaton devised by <a href="https://en.wikipedia.org/wiki/John_Horton_Conway" target="_blank" rel="noopener">John Horton Conway</a> in 1970.
        Click or drag anywhere to draw (or erase) cells.
      </p>

      <div class="life-row">
        <button id="life-play" class="life-btn" type="button">Pause</button>
        <button id="life-step" class="life-btn" type="button">Step</button>
        <button id="life-rand" class="life-btn" type="button">Randomize</button>
        <button id="life-clear" class="life-btn" type="button">Clear</button>
        <button id="life-share" class="life-btn" type="button" title="Copy a link to this exact board">Share</button>
      </div>

      <div class="life-presets">
        <span>Patterns:</span>
        <button class="life-pattern" data-pattern="glider-gun" type="button" title="Gosper's glider gun — fires a glider every 30 generations">Glider gun</button>
        <button class="life-pattern" data-pattern="pulsar" type="button" title="A period-3 oscillator">Pulsar</button>
        <button class="life-pattern" data-pattern="lwss" type="button" title="Lightweight spaceship — flies right forever">Spaceship</button>
      </div>

      <label class="life-slider">
        <span>Speed: <span id="life-speed-val">8</span> gen/s</span>
        <input id="life-speed" type="range" min="1" max="30" value="8">
      </label>
      <label class="life-slider">
        <span>Cell size: <span id="life-size-val">6</span> px</span>
        <input id="life-size" type="range" min="3" max="22" value="6">
      </label>

      <div class="life-rule-group">
        <span class="life-rule-label"><strong>Born</strong> &mdash; neighbor counts that bring a cell to life</span>
        <div id="life-born" class="life-toggles"></div>
      </div>
      <div class="life-rule-group">
        <span class="life-rule-label"><strong>Survives</strong> &mdash; neighbor counts that keep a cell alive</span>
        <div id="life-survive" class="life-toggles"></div>
      </div>

      <div class="life-presets">
        <span>Presets:</span>
        <button class="life-preset" data-rule="B3/S23" type="button">Conway</button>
        <button class="life-preset" data-rule="B36/S23" type="button">HighLife</button>
        <button class="life-preset" data-rule="B2/S" type="button">Seeds</button>
        <button class="life-preset" data-rule="B3678/S34678" type="button">Day &amp; Night</button>
      </div>

      <div class="life-rulestring">Rule: <code id="life-rulestring">B3/S23</code></div>

      <p class="life-credit">
        Conway's Game of Life &mdash; learn more on
        <a href="https://en.wikipedia.org/wiki/Conway%27s_Game_of_Life" target="_blank" rel="noopener">Wikipedia</a>.
      </p>
    </div>
  </div>
</div>

<style>
/* Full-screen takeover: hide the normal page chrome, let the fixed canvas own
   the viewport. (These rules only load on /life/.) */
.page__title, .page__meta, .page__footer { display: none !important; }
.page__content { pointer-events: none; } /* clicks fall through to the canvas... */
.life-canvas, .life-panel { pointer-events: auto; } /* ...except the canvas + controls */

/* Header: replace the solid nav block with a soft top fade, so the Game of Life
   shows through and gently fades in just below the nav (links stay readable). */
.masthead { background: transparent !important; border-bottom: 0 !important; }
.greedy-nav { background: transparent !important; }
.life-topfade {
  position: fixed;
  top: 0; left: 0; right: 0;
  height: 120px;
  z-index: 10;          /* above the canvas (0), below the nav (20) + panel (30) */
  pointer-events: none;
  background: linear-gradient(to bottom,
    rgba(18, 18, 18, 0.96) 0%,
    rgba(18, 18, 18, 0.82) 32%,
    rgba(18, 18, 18, 0) 100%);
}
html[data-theme="light"] .life-topfade {
  background: linear-gradient(to bottom,
    rgba(255, 255, 255, 0.96) 0%,
    rgba(255, 255, 255, 0.82) 32%,
    rgba(255, 255, 255, 0) 100%);
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .life-topfade {
    background: linear-gradient(to bottom,
      rgba(255, 255, 255, 0.96) 0%,
      rgba(255, 255, 255, 0.82) 32%,
      rgba(255, 255, 255, 0) 100%);
  }
}

.life-canvas {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  height: 100dvh;        /* iOS: track the visible viewport, not the area behind Safari's chrome */
  z-index: 0;            /* above page background, below masthead (20) + panel */
  background: transparent;
  cursor: crosshair;
  touch-action: none;    /* drag-to-draw works on touch without scrolling */
}

.life-panel {
  position: fixed;
  top: 4.6rem;           /* clear the masthead */
  right: 1rem;
  z-index: 30;
  width: 290px;
  max-width: calc(100vw - 2rem);
  max-height: calc(100vh - 6rem);
  max-height: calc(100dvh - 6rem);
  overflow: auto;
  padding: 0.85rem 1rem 1rem;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  background: rgba(18, 18, 18, 0.96); /* near-solid so the cells behind don't hurt readability */
  -webkit-backdrop-filter: blur(6px);
          backdrop-filter: blur(6px);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  font-size: 0.92em;
}
html[data-theme="light"] .life-panel {
  background: rgba(255, 255, 255, 0.97);
  border-color: rgba(0, 0, 0, 0.12);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.15);
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .life-panel {
    background: rgba(255, 255, 255, 0.97);
    border-color: rgba(0, 0, 0, 0.12);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.15);
  }
}
.life-panel__head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.life-panel__title { font-weight: 700; font-size: 1.05em; text-decoration: none; }
.life-collapse {
  font: inherit; line-height: 1; cursor: pointer; color: inherit;
  width: 1.8em; height: 1.8em; padding: 0;
  border: 1px solid rgba(127, 127, 127, 0.4);
  border-radius: 6px; background: rgba(127, 127, 127, 0.12);
}
.life-panel--collapsed .life-panel__body { display: none; }
.life-panel__body { display: flex; flex-direction: column; gap: 0.8rem; margin-top: 0.7rem; }
.life-blurb { margin: 0; font-size: 0.92em; opacity: 0.85; }

.life-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.life-btn, .life-toggle, .life-preset, .life-pattern {
  font: inherit; color: inherit; cursor: pointer;
  border: 1px solid rgba(127, 127, 127, 0.4);
  background: rgba(127, 127, 127, 0.14);
  border-radius: 6px; padding: 0.4em 0.7em; line-height: 1;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.life-btn:hover, .life-toggle:hover, .life-preset:hover, .life-pattern:hover { background: rgba(127, 127, 127, 0.26); }
.life-slider { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.95em; }
.life-slider input[type="range"] { width: 100%; accent-color: #5b82b8; }
.life-rule-group { display: flex; flex-direction: column; gap: 0.35rem; }
.life-rule-label { font-size: 0.85em; opacity: 0.9; }
.life-toggles { display: flex; flex-wrap: wrap; gap: 0.3rem; }
.life-toggle { width: 2em; padding: 0.4em 0; text-align: center; }
.life-toggle.on { background: #5b82b8; border-color: #5b82b8; color: #fff; }
.life-presets { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; font-size: 0.9em; }
.life-rulestring { font-size: 0.92em; }
.life-credit { margin: 0; font-size: 0.85em; opacity: 0.8; }
</style>

<script defer src="{{ '/assets/js/gadget-ui.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/life-page.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
