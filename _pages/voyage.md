---
layout: single
title: "Mission to Anywhere"
permalink: /voyage/
author_profile: false
excerpt: "Pick any planet or any real star in the sky, and see what the trip honestly takes, including what relativity does to the clocks."
description: "An interactive full-screen trip planner by Keane Lucas: real JPL planet positions and porkchop transfer windows, a real star catalog with true positions and colors, exoplanets from NASA's archive, and honest relativistic travel times, energy costs and clocks for a constant-acceleration starship."
---

<div class="voy-app life-app">
  <div class="voy-topfade" aria-hidden="true"></div>
  <canvas id="voy-canvas" class="voy-canvas"
          aria-label="A 3D view of the solar system and the real night sky. Planets sit on their true orbits for today, and every star is a real star at its true position and color. Tap a planet or a star, or use the search box, to plan a trip to it."></canvas>

  <div class="voy-panel" id="voy-panel">
    <div class="voy-panel__head">
      <span class="voy-panel__title">Mission to Anywhere</span>
      <button id="voy-help" class="gadget-help" type="button" aria-label="Show hint" title="Show hint">?</button>
      <button id="voy-collapse" class="voy-collapse" type="button" aria-label="Hide / show controls" title="Hide / show controls">&ndash;</button>
    </div>
    <div class="voy-panel__body" id="voy-panel-body">
      <p class="voy-blurb">
        The planets here sit where they really are today, and every star is a real star
        from the HYG catalog, in its true position, distance and color. Pick a destination
        by tapping it or searching for it: planets get a real transfer-orbit map, stars get
        the honest relativity of a constant-acceleration ship. Nobody knows how to build
        that ship, and the numbers show why.
      </p>

      <div class="voy-search-wrap">
        <label class="voy-search-label" for="voy-search">Where do you want to go?</label>
        <input id="voy-search" class="voy-search" type="text"
               role="combobox" aria-expanded="false" aria-controls="voy-search-list"
               aria-autocomplete="list" autocomplete="off" spellcheck="false"
               placeholder="Mars, Sirius, TRAPPIST-1 e &hellip;">
        <ul id="voy-search-list" class="voy-search-list" role="listbox"
            aria-label="Search results" hidden></ul>
      </div>

      <p class="voy-target-line" id="voy-target"></p>
      <p class="voy-legend">Earth is blue; your destination turns gold.</p>

      <div class="voy-row" id="voy-pc-row" hidden>
        <button id="voy-launch" class="voy-btn" type="button">Launch</button>
        <button id="voy-next" class="voy-btn" type="button">Next window</button>
        <button id="voy-back" class="voy-btn" type="button">Back to the sky</button>
      </div>

      <div class="voy-row">
        <button id="voy-share" class="voy-btn" type="button">Share link</button>
        <button id="voy-save" class="voy-btn" type="button">Save image</button>
      </div>

      <details class="voy-details" id="voy-window-details" hidden>
        <summary id="voy-window-sum">Why do the windows repeat?</summary>
        <p id="voy-window-text"></p>
      </details>

      <details class="voy-details">
        <summary>How honest is this?</summary>
        <p>
          Planet positions come from JPL's published orbital elements and are right for
          today's date. Star positions, distances and colors are real, from the HYG
          catalog, and the exoplanets are real discoveries from NASA's archive. The
          transfer orbits and the relativity math are the true equations, but the galaxy
          backdrop is an illustration, exoplanet positions along their orbits are not
          known, and nobody knows how to build a ship that holds 1&nbsp;g for years.
          Star sizes on screen show brightness, not true size.
        </p>
      </details>

      <p class="voy-status-line"><span id="voy-status" role="status"></span></p>
      <p class="voy-credit">
        Star data from the HYG catalog (astronexus.com, CC BY-SA). Planets and exoplanets
        from NASA. All code original.
      </p>
      <p class="voy-verify" id="voy-verify"></p>
    </div>
  </div>

  <div id="voy-card" class="voy-card" role="region" aria-label="About the selected body" hidden></div>
</div>

<style>
/* Full-screen takeover: hide the normal page chrome, let the fixed canvas own the
   viewport. (These rules only load on /voyage/.) */
.page__title, .page__meta, .page__footer { display: none !important; }
.page__content { pointer-events: none; }
.voy-canvas, .voy-panel, .voy-card { pointer-events: auto; }

.masthead { background: transparent !important; border-bottom: 0 !important; }
.greedy-nav { background: transparent !important; }
.voy-topfade {
  position: fixed; top: 0; left: 0; right: 0; height: 120px;
  z-index: 10; pointer-events: none;
  background: linear-gradient(to bottom,
    rgba(14,16,20,0.96) 0%, rgba(14,16,20,0.82) 32%, rgba(14,16,20,0) 100%);
}
html[data-theme="light"] .voy-topfade {
  background: linear-gradient(to bottom,
    rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-topfade {
    background: linear-gradient(to bottom,
      rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
  }
}

.voy-canvas {
  position: fixed; inset: 0; width: 100vw; height: 100vh; height: 100dvh;
  z-index: 0; background: transparent;
  touch-action: none;
}

.voy-panel {
  position: fixed; top: 4.6rem; right: 1rem; z-index: 30;
  width: 300px; max-width: calc(100vw - 2rem); max-height: calc(100vh - 6rem); max-height: calc(100dvh - 6rem);
  overflow: auto; padding: 0.85rem 1rem 1rem;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
  background: rgba(18,18,18,0.94);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  box-shadow: 0 6px 24px rgba(0,0,0,0.35); font-size: 0.92em;
}
html[data-theme="light"] .voy-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
}

.voy-panel__head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.voy-panel__title { font-weight: 700; font-size: 1.05em; }
.voy-collapse {
  font: inherit; line-height: 1; cursor: pointer; color: inherit;
  width: 1.8em; height: 1.8em; padding: 0;
  border: 1px solid rgba(127,127,127,0.4); border-radius: 6px; background: rgba(127,127,127,0.12);
}
.voy-panel--collapsed .voy-panel__body { display: none; }
.voy-panel__body { display: flex; flex-direction: column; gap: 0.8rem; margin-top: 0.7rem; }
.voy-blurb { margin: 0; font-size: 0.9em; opacity: 0.85; line-height: 1.5; }

/* search combobox: the list is IN FLOW inside the scrolling panel body */
.voy-search-wrap { display: flex; flex-direction: column; gap: 0.3rem; }
.voy-search-label { font-size: 0.9em; font-weight: 600; }
.voy-search {
  font: inherit; width: 100%; padding: 0.4em 0.55em;
  font-size: 16px; /* under 16px iOS zooms the whole page on focus */
  border-radius: 6px; border: 1px solid rgba(127,127,127,0.5);
  background: #1d2126; color: #d6d6d6;
}
.voy-search::placeholder { color: rgba(214,214,214,0.45); }
html[data-theme="light"] .voy-search { background: #ffffff; color: #262626; border-color: rgba(0,0,0,0.35); }
html[data-theme="light"] .voy-search::placeholder { color: rgba(38,38,38,0.4); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-search { background: #ffffff; color: #262626; border-color: rgba(0,0,0,0.35); }
  html:not([data-theme="dark"]) .voy-search::placeholder { color: rgba(38,38,38,0.4); }
}
.voy-search-list {
  list-style: none; margin: 0; padding: 0;
  border: 1px solid rgba(127,127,127,0.35); border-radius: 6px; overflow: hidden;
}
.voy-search-list[hidden] { display: none !important; }
.voy-search__opt {
  display: flex; justify-content: space-between; align-items: baseline; gap: 0.6rem;
  padding: 0.35em 0.55em; cursor: pointer; font-size: 0.92em;
}
.voy-search__opt + .voy-search__opt { border-top: 1px solid rgba(127,127,127,0.18); }
.voy-search__opt:hover, .voy-search__opt--hi { background: rgba(130,166,204,0.18); }
html[data-theme="light"] .voy-search__opt:hover, html[data-theme="light"] .voy-search__opt--hi { background: rgba(52,86,138,0.14); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-search__opt:hover,
  html:not([data-theme="dark"]) .voy-search__opt--hi { background: rgba(52,86,138,0.14); }
}
.voy-search__kind { font-size: 0.82em; opacity: 0.55; white-space: nowrap; }

.voy-target-line { margin: 0; font-size: 0.88em; opacity: 0.85; }
.voy-legend { margin: 0; font-size: 0.8em; opacity: 0.55; }

.voy-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.voy-row[hidden] { display: none !important; }
.voy-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14);
  border-radius: 6px; padding: 0.45em 0.7em; transition: background 0.15s ease;
}
.voy-btn:hover { background: rgba(127,127,127,0.26); }
.voy-btn--primary { background: rgba(130,166,204,0.22); font-weight: 600; }
.voy-btn--primary:hover { background: rgba(130,166,204,0.34); }
html[data-theme="light"] .voy-btn--primary { background: rgba(52,86,138,0.16); }
html[data-theme="light"] .voy-btn--primary:hover { background: rgba(52,86,138,0.26); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-btn--primary { background: rgba(52,86,138,0.16); }
  html:not([data-theme="dark"]) .voy-btn--primary:hover { background: rgba(52,86,138,0.26); }
}
.voy-btn:disabled { opacity: 0.5; cursor: default; }

.voy-details { font-size: 0.88em; }
.voy-details[hidden] { display: none !important; }
.voy-details summary { cursor: pointer; opacity: 0.85; }
.voy-details p { margin: 0.4em 0 0; opacity: 0.8; line-height: 1.5; }

.voy-status-line { margin: 0; font-size: 0.85em; opacity: 0.8; font-variant-numeric: tabular-nums; min-height: 1.2em; }
.voy-credit { margin: 0; font-size: 0.78em; opacity: 0.6; line-height: 1.45; }
.voy-verify { margin: 0; font-size: 0.78em; opacity: 0.55; font-variant-numeric: tabular-nums; min-height: 1.1em; }
.voy-verify--warn { opacity: 0.9; font-weight: 600; }

/* ---- the info card: a bottom sheet clear of the corner buttons ---- */
.voy-card {
  position: fixed; left: 8.5rem; bottom: 1rem; z-index: 28;
  width: min(420px, calc(100vw - 10rem));
  max-height: calc(100vh - 7rem); max-height: calc(100dvh - 7rem);
  overflow: auto; padding: 0.8rem 1rem 1rem;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
  background: rgba(18,18,18,0.94);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  box-shadow: 0 6px 24px rgba(0,0,0,0.35); font-size: 0.92em;
}
.voy-card[hidden] { display: none !important; }
html[data-theme="light"] .voy-card { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-card { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
}
.voy-card__head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
.voy-card__titles { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
.voy-card__title { font-weight: 700; font-size: 1.1em; }
.voy-card__sub { font-size: 0.82em; opacity: 0.6; }
.voy-card__close {
  font: inherit; font-size: 1.2em; line-height: 1; cursor: pointer; color: inherit;
  width: 1.5em; height: 1.5em; padding: 0; flex: none;
  border: 1px solid rgba(127,127,127,0.4); border-radius: 6px; background: rgba(127,127,127,0.12);
}
.voy-card__body { display: flex; flex-direction: column; gap: 0.55rem; margin-top: 0.6rem; }
.voy-fact { margin: 0; font-size: 0.92em; line-height: 1.45; opacity: 0.9; }
.voy-fact--chips { margin-top: 0.2rem; font-weight: 600; }
.voy-swatch {
  display: inline-block; width: 0.85em; height: 0.85em; border-radius: 3px;
  border: 1px solid rgba(127,127,127,0.5); vertical-align: middle;
}
.voy-note { margin: 0; font-size: 0.78em; opacity: 0.55; }
.voy-chips { display: flex; flex-direction: column; gap: 0.3rem; }
.voy-chip {
  font: inherit; color: inherit; cursor: pointer; text-align: left;
  display: flex; flex-direction: column; gap: 0.1rem;
  border: 1px solid rgba(127,127,127,0.35); background: rgba(127,127,127,0.1);
  border-radius: 6px; padding: 0.4em 0.6em;
}
.voy-chip:hover { background: rgba(127,127,127,0.2); }
.voy-chip__name { font-weight: 600; font-size: 0.92em; }
.voy-chip__line { font-size: 0.82em; opacity: 0.7; }
.voy-chipbody { padding: 0.2em 0.6em 0.3em; }
.voy-chipbody[hidden] { display: none !important; }
.voy-chipbody p { margin: 0.15em 0; font-size: 0.85em; opacity: 0.8; line-height: 1.4; }
.voy-actions { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.2rem; }

.voy-arrive {
  border: 1px solid rgba(200,164,92,0.5); border-radius: 8px;
  background: rgba(200,164,92,0.1); padding: 0.5rem 0.7rem;
  display: flex; flex-direction: column; gap: 0.4rem;
}
html[data-theme="light"] .voy-arrive { border-color: rgba(160,124,44,0.5); background: rgba(160,124,44,0.08); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-arrive { border-color: rgba(160,124,44,0.5); background: rgba(160,124,44,0.08); }
}
.voy-arrive__line { margin: 0; font-weight: 600; font-size: 0.95em; }

.voy-trip { display: flex; flex-direction: column; gap: 0.55rem; margin-top: 0.3rem; }
.voy-trip[hidden] { display: none !important; }
.voy-trip__title { margin: 0; font-weight: 700; font-size: 0.95em; }
.voy-trip__table { border-collapse: collapse; width: 100%; font-size: 0.82em; margin: 0; }
.voy-trip__table th {
  text-align: left; font-weight: 600; opacity: 0.6; padding: 0.15em 0.5em 0.15em 0;
  border-bottom: 1px solid rgba(127,127,127,0.35);
}
.voy-trip__table td { padding: 0.28em 0.5em 0.28em 0; vertical-align: top; border-bottom: 1px solid rgba(127,127,127,0.15); }
.voy-trip__note { opacity: 0.6; font-size: 0.92em; }
.voy-trip__row--hl td { background: rgba(130,166,204,0.14); font-weight: 600; }
html[data-theme="light"] .voy-trip__row--hl td { background: rgba(52,86,138,0.1); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-trip__row--hl td { background: rgba(52,86,138,0.1); }
}
.voy-seg {
  display: flex; border: 1px solid rgba(127,127,127,0.4);
  border-radius: 6px; overflow: hidden;
}
.voy-seg__btn {
  flex: 1; font: inherit; font-size: 0.85em; color: inherit; background: none; border: 0;
  padding: 0.42em 0.2em; cursor: pointer; line-height: 1.2; min-height: 24px;
}
.voy-seg__btn + .voy-seg__btn { border-left: 1px solid rgba(127,127,127,0.4); }
.voy-seg__btn--on { background: rgba(130,166,204,0.22); font-weight: 600; }
html[data-theme="light"] .voy-seg__btn--on { background: rgba(52,86,138,0.16); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-seg__btn--on { background: rgba(52,86,138,0.16); }
}
.voy-live { margin: 0; font-size: 0.85em; opacity: 0.85; line-height: 1.45; font-variant-numeric: tabular-nums; }
.voy-warp { margin: 0; font-size: 0.82em; opacity: 0.6; line-height: 1.45; }

/* Mobile: full-width bottom sheet. The raised corner buttons occupy the
   bottom ~112px band at <=768px, so the sheet keeps 7.5rem of padding under
   its content and nothing interactive lands under them. */
@media (max-width: 768px) {
  .voy-card {
    left: 0; right: 0; bottom: 0; width: auto;
    max-height: 44vh; border-radius: 12px 12px 0 0;
    padding-bottom: 7.5rem;
  }
  .voy-blurb { order: 5; }
  .voy-credit { order: 6; }
  .voy-verify { order: 7; }
  .voy-legend { order: 4; }
  /* the sheet scrolls, so mid-scroll content can pass under the fixed
     corner buttons; hide them while a sheet is open (close, Esc, or tap
     the sky to bring them back) */
  body.voy-sheet-open #theme-toggle,
  body.voy-sheet-open #life-link { opacity: 0 !important; pointer-events: none !important; }
}
/* touch targets */
@media (pointer: coarse) {
  .voy-btn { min-height: 40px; padding: 0.5em 0.85em; }
  .voy-seg__btn { min-height: 40px; }
  .voy-collapse { width: 2.3em; height: 2.3em; }
  .voy-panel .gadget-help { min-width: 36px; min-height: 36px; }
  .voy-details summary { padding: 0.35em 0; }
  .voy-card__close { width: 2em; height: 2em; }
  .voy-chip { min-height: 40px; }
  .voy-search { min-height: 40px; }
  .voy-search__opt { min-height: 40px; align-items: center; }
}
</style>

<script defer src="{{ '/assets/js/gadget-ui.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/share-hash.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/voyage-astro.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/voyage-data.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/voyage.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
