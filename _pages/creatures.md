---
layout: single
title: "Evolving Creatures"
permalink: /creatures/
author_profile: false
excerpt: "Soft-body creatures race to the right, the farthest travelers breed, and within a few minutes wobbling blobs learn to run."
description: "An interactive evolution sandbox by Keane Lucas: a population of soft-body creatures with spring muscles evolves live in your browser. Every twelve seconds the farthest travelers breed, and generation by generation wobbling blobs turn into creatures that genuinely run. Inspired by Karl Sims' Evolved Virtual Creatures."
---

<div class="cre-app life-app">
  <div class="cre-topfade" aria-hidden="true"></div>
  <canvas id="cre-canvas" class="cre-canvas"
          aria-label="A full-screen evolution sandbox. A population of soft-body creatures learns to travel to the right; the farthest travelers of each generation breed the next one."></canvas>
  <canvas id="cre-chart" class="cre-chart" width="260" height="150"
          aria-label="Fitness chart: best and median distance per generation."></canvas>

  <div class="cre-panel" id="cre-panel">
    <div class="cre-panel__head">
      <span class="cre-panel__title">Evolving Creatures</span>
      <button id="cre-help" class="gadget-help" type="button" aria-label="Show hint" title="Show hint">?</button>
      <button id="cre-collapse" class="cre-collapse" type="button" aria-label="Hide / show controls" title="Hide / show controls">&ndash;</button>
    </div>
    <div class="cre-panel__body" id="cre-panel-body">
      <p class="cre-blurb">
        Each creature is a handful of masses joined by springs, and some springs are
        <strong>muscles</strong> that push and pull on a rhythm set by that creature's genome.
        All of them race to the right at once. When the clock runs out, the farthest travelers
        breed with a little mutation and the next generation starts. It is a toy genetic
        algorithm, and it is usually enough to turn wobbling blobs into steady runners.
        Inspired by Karl Sims' Evolved Virtual Creatures (1994). All code here is original.
      </p>

      <label class="cre-select"><span>Body</span>
        <select id="cre-preset">
          <option value="0" selected>Sprinter</option>
          <option value="1">Quadruped</option>
          <option value="2">Worm</option>
          <option value="3">Wheel</option>
          <option value="4">Random body</option>
        </select>
      </label>

      <label class="cre-slider"><span>Population: <strong id="cre-pop-val">40</strong></span>
        <input id="cre-pop" type="range" min="16" max="80" step="4" value="40"></label>

      <label class="cre-slider"><span>Mutation: <strong id="cre-mut-val">1.0&times;</strong></span>
        <input id="cre-mut" type="range" min="0" max="1" step="0.02" value="0.52"></label>

      <label class="cre-slider"><span>Speed: <strong id="cre-speed-val">1&times;</strong></span>
        <input id="cre-speed" type="range" min="0" max="2" step="1" value="0"
               aria-label="Simulation speed: 1x, 4x, or 16x"></label>

      <div class="cre-row">
        <button id="cre-pause" class="cre-btn" type="button">Pause</button>
        <button id="cre-restart" class="cre-btn" type="button">Restart</button>
        <button id="cre-replay" class="cre-btn" type="button">Replay champion</button>
      </div>
      <div class="cre-row">
        <button id="cre-share" class="cre-btn" type="button">Share champion</button>
        <button id="cre-save" class="cre-btn" type="button">Save image</button>
      </div>

      <p class="cre-status-line"><span id="cre-status" role="status" aria-live="polite"></span></p>
    </div>
  </div>
</div>

<style>
/* Full-screen takeover: hide the normal page chrome, let the fixed canvas own the
   viewport. (These rules only load on /creatures/.) */
.page__title, .page__meta, .page__footer { display: none !important; }
.page__content { pointer-events: none; }
.cre-canvas, .cre-panel { pointer-events: auto; }

.masthead { background: transparent !important; border-bottom: 0 !important; }
.greedy-nav { background: transparent !important; }
.cre-topfade {
  position: fixed; top: 0; left: 0; right: 0; height: 120px;
  z-index: 10; pointer-events: none;
  background: linear-gradient(to bottom,
    rgba(14,16,20,0.96) 0%, rgba(14,16,20,0.82) 32%, rgba(14,16,20,0) 100%);
}
html[data-theme="light"] .cre-topfade {
  background: linear-gradient(to bottom,
    rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .cre-topfade {
    background: linear-gradient(to bottom,
      rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
  }
}

.cre-canvas {
  position: fixed; inset: 0; width: 100vw; height: 100vh; height: 100dvh;
  z-index: 0; background: transparent;
  touch-action: none;
}

/* The fitness chart HUD. The bottom-left corner belongs to the fixed
   theme-toggle + back buttons (they span to x~130px, ~47px tall, bottom 1rem,
   rising to bottom 4rem on <=768px) — so the chart sits fully ABOVE them. */
.cre-chart {
  position: fixed; left: 1.2rem; bottom: 5.2rem; z-index: 15;
  width: 260px; height: 150px; pointer-events: none;
}
@media (max-width: 768px) {
  .cre-chart { bottom: 8rem; }
}

.cre-panel {
  position: fixed; top: 4.6rem; right: 1rem; z-index: 30;
  width: 280px; max-width: calc(100vw - 2rem); max-height: calc(100vh - 6rem); max-height: calc(100dvh - 6rem);
  overflow: auto; padding: 0.85rem 1rem 1rem;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
  background: rgba(18,18,18,0.94);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  box-shadow: 0 6px 24px rgba(0,0,0,0.35); font-size: 0.92em;
}
html[data-theme="light"] .cre-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .cre-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
}

.cre-panel__head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.cre-panel__title { font-weight: 700; font-size: 1.05em; }
.cre-collapse {
  font: inherit; line-height: 1; cursor: pointer; color: inherit;
  width: 1.8em; height: 1.8em; padding: 0;
  border: 1px solid rgba(127,127,127,0.4); border-radius: 6px; background: rgba(127,127,127,0.12);
}
.cre-panel--collapsed .cre-panel__body { display: none; }
.cre-panel__body { display: flex; flex-direction: column; gap: 0.8rem; margin-top: 0.7rem; }
.cre-blurb { margin: 0; font-size: 0.9em; opacity: 0.85; line-height: 1.5; }
.cre-slider { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.95em; }
.cre-slider strong { font-variant-numeric: tabular-nums; }
.cre-slider input[type="range"] { width: 100%; accent-color: #82a6cc; }
.cre-select { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.95em; }
/* the theme washes selects out; give it explicit high-contrast colors per theme */
.cre-select select {
  width: 100%; font: inherit; cursor: pointer;
  color: #d6d6d6; background: #202020;
  border: 1px solid rgba(127,127,127,0.4); border-radius: 6px; padding: 0.3em 0.45em;
}
html[data-theme="light"] .cre-select select { color: #262626; background: #ffffff; border-color: rgba(0,0,0,0.25); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .cre-select select { color: #262626; background: #ffffff; border-color: rgba(0,0,0,0.25); }
}
.cre-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.cre-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14);
  border-radius: 6px; padding: 0.45em 0.7em; transition: background 0.15s ease;
}
.cre-btn:hover { background: rgba(127,127,127,0.26); }
.cre-btn:disabled { opacity: 0.45; cursor: default; }
.cre-btn:disabled:hover { background: rgba(127,127,127,0.14); }
.cre-status-line { margin: 0; font-size: 0.85em; opacity: 0.75; font-variant-numeric: tabular-nums; min-height: 1.2em; }

/* the shared-creature banner (created by creatures.js on share links) */
.cre-banner {
  position: fixed; top: 17vh; left: 50%; transform: translateX(-50%);
  z-index: 25; max-width: min(92vw, 26rem); text-align: center;
  padding: 0.8rem 1rem; border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.12); background: rgba(18,18,18,0.94);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  box-shadow: 0 6px 24px rgba(0,0,0,0.35); font-size: 0.95em;
  pointer-events: auto;
}
.cre-banner p { margin: 0 0 0.6rem; }
.cre-banner__row { display: flex; justify-content: center; gap: 0.5rem; flex-wrap: wrap; }
html[data-theme="light"] .cre-banner { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .cre-banner { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
}

html[data-theme="light"] .cre-slider input[type="range"] { accent-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .cre-slider input[type="range"] { accent-color: #34568a; }
}
</style>

<script defer src="{{ '/assets/js/gadget-ui.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/share-hash.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/creatures-core.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/creatures.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
