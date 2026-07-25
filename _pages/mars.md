---
layout: single
title: "Mission to Mars"
permalink: /mars/
author_profile: false
excerpt: "Pick a launch day on a real porkchop plot, press Launch, and watch your transfer arc fly while the planets move."
description: "An interactive full-screen mission planner by Keane Lucas: planet positions from JPL's approximate orbital elements, thousands of Lambert transfer solutions colored by delta-v, and a cruise animation that flies your chosen route to Mars or Venus."
---

<div class="mars-app life-app">
  <div class="mars-topfade" aria-hidden="true"></div>
  <canvas id="mars-canvas" class="mars-canvas"
          aria-label="A solar-system view with Earth and a target planet on their orbits, next to a porkchop plot where every departure date and flight time is colored by the rocket delta-v it needs. Drag the crosshair to pick a mission and press Launch to fly it."></canvas>

  <div class="mars-panel" id="mars-panel">
    <div class="mars-panel__head">
      <span class="mars-panel__title">Mission to Mars</span>
      <button id="mars-help" class="gadget-help" type="button" aria-label="Show hint" title="Show hint">?</button>
      <button id="mars-collapse" class="mars-collapse" type="button" aria-label="Hide / show controls" title="Hide / show controls">&ndash;</button>
    </div>
    <div class="mars-panel__body" id="mars-panel-body">
      <p class="mars-blurb">
        Every cell in the map is a complete mission: leave Earth on that date, fly for that
        many days, and the color shows the total rocket &Delta;v it costs, found by solving
        Lambert's problem for thousands of date pairs right here in your browser.
        <strong>Drag the crosshair</strong> to pick a mission, then press
        <strong>Launch</strong> and watch the ship coast its transfer ellipse while the
        planets keep moving. The cheap dark bands come around on a schedule, which is why
        missions leave in bunches.
      </p>

      <div class="mars-seg" role="group" aria-label="Target planet">
        <button id="mars-target-mars" class="mars-seg__btn mars-seg__btn--on" type="button" aria-pressed="true">Mars</button>
        <button id="mars-target-venus" class="mars-seg__btn" type="button" aria-pressed="false">Venus</button>
      </div>

      <div class="mars-row">
        <button id="mars-launch" class="mars-btn" type="button">Launch</button>
        <button id="mars-next" class="mars-btn" type="button">Next window</button>
      </div>
      <div class="mars-row">
        <button id="mars-share" class="mars-btn" type="button">Share link</button>
        <button id="mars-save" class="mars-btn" type="button">Save image</button>
      </div>

      <details class="mars-details">
        <summary>Why every 26 months?</summary>
        <p>
          Earth circles the Sun in about 12 months, Mars in about 23, so Earth keeps lapping
          Mars from the inside. The cheap transfer geometry only works when Earth is about to
          catch up and the ship can arrive just as Mars gets there, and that lineup repeats
          about every 26 months (the synodic period). Venus laps Earth instead, on a faster
          cycle, so its windows come about every 19 months.
        </p>
      </details>

      <p class="mars-status-line"><span id="mars-status" role="status"></span></p>
      <p class="mars-credit">
        Planetary elements from NASA/JPL's Approximate Positions of the Planets. All code
        here is original. Positions use JPL's published approximate orbital elements, and
        each transfer is a two-body Lambert arc; real missions refine this with full n-body
        navigation.
      </p>
      <p class="mars-verify" id="mars-verify"></p>
    </div>
  </div>
</div>

<style>
/* Full-screen takeover: hide the normal page chrome, let the fixed canvas own the
   viewport. (These rules only load on /mars/.) */
.page__title, .page__meta, .page__footer { display: none !important; }
.page__content { pointer-events: none; }
.mars-canvas, .mars-panel { pointer-events: auto; }

.masthead { background: transparent !important; border-bottom: 0 !important; }
.greedy-nav { background: transparent !important; }
.mars-topfade {
  position: fixed; top: 0; left: 0; right: 0; height: 120px;
  z-index: 10; pointer-events: none;
  background: linear-gradient(to bottom,
    rgba(14,16,20,0.96) 0%, rgba(14,16,20,0.82) 32%, rgba(14,16,20,0) 100%);
}
html[data-theme="light"] .mars-topfade {
  background: linear-gradient(to bottom,
    rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .mars-topfade {
    background: linear-gradient(to bottom,
      rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
  }
}

.mars-canvas {
  position: fixed; inset: 0; width: 100vw; height: 100vh; height: 100dvh;
  z-index: 0; background: transparent;
  touch-action: none;
}

.mars-panel {
  position: fixed; top: 4.6rem; right: 1rem; z-index: 30;
  width: 300px; max-width: calc(100vw - 2rem); max-height: calc(100vh - 6rem); max-height: calc(100dvh - 6rem);
  overflow: auto; padding: 0.85rem 1rem 1rem;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
  background: rgba(18,18,18,0.94);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  box-shadow: 0 6px 24px rgba(0,0,0,0.35); font-size: 0.92em;
}
html[data-theme="light"] .mars-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .mars-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
}

.mars-panel__head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.mars-panel__title { font-weight: 700; font-size: 1.05em; }
.mars-collapse {
  font: inherit; line-height: 1; cursor: pointer; color: inherit;
  width: 1.8em; height: 1.8em; padding: 0;
  border: 1px solid rgba(127,127,127,0.4); border-radius: 6px; background: rgba(127,127,127,0.12);
}
.mars-panel--collapsed .mars-panel__body { display: none; }
.mars-panel__body { display: flex; flex-direction: column; gap: 0.8rem; margin-top: 0.7rem; }
.mars-blurb { margin: 0; font-size: 0.9em; opacity: 0.85; line-height: 1.5; }

.mars-seg {
  display: flex; border: 1px solid rgba(127,127,127,0.4);
  border-radius: 6px; overflow: hidden;
}
.mars-seg__btn {
  flex: 1; font: inherit; color: inherit; background: none; border: 0;
  padding: 0.42em 0; cursor: pointer; line-height: 1; min-height: 24px;
}
.mars-seg__btn + .mars-seg__btn { border-left: 1px solid rgba(127,127,127,0.4); }
.mars-seg__btn--on { background: rgba(130,166,204,0.22); font-weight: 600; }
html[data-theme="light"] .mars-seg__btn--on { background: rgba(52,86,138,0.16); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .mars-seg__btn--on { background: rgba(52,86,138,0.16); }
}

.mars-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.mars-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14);
  border-radius: 6px; padding: 0.45em 0.7em; transition: background 0.15s ease;
}
.mars-btn:hover { background: rgba(127,127,127,0.26); }

.mars-details { font-size: 0.88em; }
.mars-details summary { cursor: pointer; opacity: 0.85; }
.mars-details p { margin: 0.4em 0 0; opacity: 0.8; line-height: 1.5; }

.mars-status-line { margin: 0; font-size: 0.85em; opacity: 0.8; font-variant-numeric: tabular-nums; min-height: 1.2em; }
.mars-credit { margin: 0; font-size: 0.78em; opacity: 0.6; line-height: 1.45; }
.mars-verify { margin: 0; font-size: 0.78em; opacity: 0.55; font-variant-numeric: tabular-nums; min-height: 1.1em; }
.mars-verify--warn { opacity: 0.9; font-weight: 600; }
</style>

<script defer src="{{ '/assets/js/gadget-ui.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/share-hash.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/mars-astro.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/mars.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
