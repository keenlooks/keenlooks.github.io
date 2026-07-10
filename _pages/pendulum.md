---
layout: single
title: "Double Pendulum"
permalink: /pendulum/
author_profile: false
excerpt: "Chaos you can grab: two pendulums start 0.001 radians apart and end up nowhere near each other."
description: "An interactive full-screen double pendulum by Keane Lucas: drag the bobs to set a pose and let go. A grey twin starts one thousandth of a radian away — watch how long the two stay together before chaos pulls their paths completely apart."
---

<div class="pend-app life-app">
  <div class="pend-topfade" aria-hidden="true"></div>
  <canvas id="pend-canvas" class="pend-canvas"
          aria-label="A full-screen double pendulum simulation. A second, grey pendulum starts almost identically and diverges, demonstrating chaos."></canvas>

  <div class="pend-panel" id="pend-panel">
    <div class="pend-panel__head">
      <span class="pend-panel__title">Double Pendulum</span>
      <button id="pend-help" class="gadget-help" type="button" aria-label="Show hint" title="Show hint">?</button>
      <button id="pend-collapse" class="pend-collapse" type="button" aria-label="Hide / show controls" title="Hide / show controls">&ndash;</button>
    </div>
    <div class="pend-panel__body" id="pend-panel-body">
      <p class="pend-blurb">
        Two rods and two masses, moving under gravity. The blue pendulum and the grey
        <strong>twin</strong> start about <strong>0.001 radians</strong> apart (roughly 0.06&deg;).
        They stay in step for a few seconds, and then their motions separate completely.
        Identical rules and nearly identical starting points still lead to totally different
        paths. The plot along the bottom shows how far apart the two pendulums' angles are over
        time, and the moment they split happens at a different time on each run.
        <strong>Drag either bob</strong> to set a new starting pose.
      </p>

      <label class="pend-slider"><span>Speed: <strong id="pend-speed-val" class="editable-val" data-range="pend-speed">1.00&times;</strong></span>
        <input id="pend-speed" type="range" min="0" max="2" step="0.05" value="1"></label>

      <div class="pend-checks">
        <label class="pend-check"><input id="pend-twin" type="checkbox" checked> Twin (offset by 0.001 rad)</label>
        <label class="pend-check"><input id="pend-trails" type="checkbox" checked> Trace the tips</label>
      </div>

      <div class="pend-row">
        <button id="pend-pause" class="pend-btn" type="button">Pause</button>
        <button id="pend-reset" class="pend-btn" type="button">Reset</button>
      </div>

      <p class="pend-status-line"><span id="pend-status"></span></p>
    </div>
  </div>
</div>

<style>
/* Full-screen takeover: hide the normal page chrome, let the fixed canvas own the
   viewport. (These rules only load on /pendulum/.) */
.page__title, .page__meta, .page__footer { display: none !important; }
.page__content { pointer-events: none; }
.pend-canvas, .pend-panel { pointer-events: auto; }

.masthead { background: transparent !important; border-bottom: 0 !important; }
.greedy-nav { background: transparent !important; }
.pend-topfade {
  position: fixed; top: 0; left: 0; right: 0; height: 120px;
  z-index: 10; pointer-events: none;
  background: linear-gradient(to bottom,
    rgba(14,16,20,0.96) 0%, rgba(14,16,20,0.82) 32%, rgba(14,16,20,0) 100%);
}
html[data-theme="light"] .pend-topfade {
  background: linear-gradient(to bottom,
    rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .pend-topfade {
    background: linear-gradient(to bottom,
      rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
  }
}

.pend-canvas {
  position: fixed; inset: 0; width: 100vw; height: 100vh;
  z-index: 0; background: transparent; cursor: grab;
  touch-action: none;
}

.pend-panel {
  position: fixed; top: 4.6rem; right: 1rem; z-index: 30;
  width: 280px; max-width: calc(100vw - 2rem); max-height: calc(100vh - 6rem);
  overflow: auto; padding: 0.85rem 1rem 1rem;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
  background: rgba(18,18,18,0.94);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  box-shadow: 0 6px 24px rgba(0,0,0,0.35); font-size: 0.92em;
}
html[data-theme="light"] .pend-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .pend-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
}

.pend-panel__head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.pend-panel__title { font-weight: 700; font-size: 1.05em; }
.pend-collapse {
  font: inherit; line-height: 1; cursor: pointer; color: inherit;
  width: 1.8em; height: 1.8em; padding: 0;
  border: 1px solid rgba(127,127,127,0.4); border-radius: 6px; background: rgba(127,127,127,0.12);
}
.pend-panel--collapsed .pend-panel__body { display: none; }
.pend-panel__body { display: flex; flex-direction: column; gap: 0.8rem; margin-top: 0.7rem; }
.pend-blurb { margin: 0; font-size: 0.9em; opacity: 0.85; line-height: 1.5; }
.pend-slider { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.95em; }
.pend-slider strong { font-variant-numeric: tabular-nums; }
.pend-slider input[type="range"] { width: 100%; accent-color: #82a6cc; }
.pend-checks { display: flex; flex-direction: column; gap: 0.4rem; }
.pend-check { display: inline-flex; align-items: center; gap: 0.45rem; font-size: 0.95em; cursor: pointer; }
.pend-check input { accent-color: #82a6cc; }
.pend-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.pend-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14);
  border-radius: 6px; padding: 0.45em 0.7em; transition: background 0.15s ease;
}
.pend-btn:hover { background: rgba(127,127,127,0.26); }
.pend-status-line { margin: 0; font-size: 0.85em; opacity: 0.75; font-variant-numeric: tabular-nums; min-height: 1.2em; }

html[data-theme="light"] .pend-slider input[type="range"],
html[data-theme="light"] .pend-check input { accent-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .pend-slider input[type="range"],
  html:not([data-theme="dark"]) .pend-check input { accent-color: #34568a; }
}
</style>

<script defer src="{{ '/assets/js/gadget-ui.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/pendulum.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/editable-values.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
