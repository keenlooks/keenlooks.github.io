---
layout: single
title: "Four in a Row"
permalink: /fourinarow/
author_profile: false
excerpt: "Play the classic four-in-a-row game against a neural network refined by self-play, and watch it think: the search tree grows in real time as it considers lines."
description: "Play four in a row against an AlphaZero-style neural network by Keane Lucas. The AI runs entirely in your browser, and its thinking is visible: a live search tree, its raw instinct versus what the search concludes, and a win-probability bar."
---

<div class="c4-app life-app">
  <div class="c4-topfade" aria-hidden="true"></div>
  <canvas id="c4-canvas" class="c4-canvas"
          aria-label="A four in a row board. Click or tap a column to drop a piece; the AI answers, and its search is visualized beside the board."></canvas>

  <div class="c4-panel" id="c4-panel">
    <div class="c4-panel__head">
      <span class="c4-panel__title">Four in a Row</span>
      <button id="c4-help" class="gadget-help" type="button" aria-label="Show hint" title="Show hint">?</button>
      <button id="c4-collapse" class="c4-collapse" type="button" aria-label="Hide / show controls" title="Hide / show controls">&ndash;</button>
    </div>
    <div class="c4-panel__body" id="c4-panel-body">
      <p class="c4-blurb">
        You are <strong>blue</strong>. The AI is a small neural network that first learned
        this game from about 12,000 games played by an exact solver, then improved by
        playing thousands of games against itself. It picks its moves the way AlphaZero
        does: the network's hunch guides a search, and the search decides. While it
        thinks, the panel beside the board shows that search tree growing, its raw
        instinct next to what the search concludes, and the win odds. Turn the strength
        down to Instinct and it plays on the hunch alone, which sometimes misses a mate
        in one. The search is what fixes that.
      </p>

      <div class="c4-row">
        <button id="c4-new" class="c4-btn" type="button">New game</button>
        <button id="c4-undo" class="c4-btn" type="button">Undo</button>
      </div>

      <div class="c4-row" role="group" aria-label="Who plays first">
        <button id="c4-side-first" class="c4-btn c4-seg" type="button" aria-pressed="true">You start</button>
        <button id="c4-side-second" class="c4-btn c4-seg" type="button" aria-pressed="false">AI starts</button>
      </div>

      <label class="c4-slider"><span>AI strength: <strong id="c4-strength-val">Strong</strong></span>
        <input id="c4-strength" type="range" min="0" max="3" step="1" value="2"
               aria-label="AI strength">
        <span class="c4-hint" id="c4-strength-hint">~1-2 s of search</span></label>

      <label class="c4-check"><input id="c4-showthink" type="checkbox" checked> Show thinking</label>

      <div class="c4-row">
        <button id="c4-share" class="c4-btn" type="button">Share link</button>
        <button id="c4-save" class="c4-btn" type="button">Save image</button>
      </div>

      <p class="c4-status-line" role="status" aria-live="polite"><span id="c4-status"></span></p>
      <p class="c4-verify-line"><span id="c4-verify"></span><br><span id="c4-modelnote"></span></p>
      <p class="c4-credit">Policy and value network with PUCT search, trained by
        self-play following the AlphaZero method (Silver et al., 2017, DeepMind). All
        code here is original and runs in your browser.</p>
    </div>
  </div>
</div>

<style>
/* Full-screen takeover (rules only load on /fourinarow/). */
.page__title, .page__meta, .page__footer { display: none !important; }
.page__content { pointer-events: none; }
.c4-canvas, .c4-panel { pointer-events: auto; }

.masthead { background: transparent !important; border-bottom: 0 !important; }
.greedy-nav { background: transparent !important; }
.c4-topfade {
  position: fixed; top: 0; left: 0; right: 0; height: 120px;
  z-index: 10; pointer-events: none;
  background: linear-gradient(to bottom,
    rgba(14,16,20,0.96) 0%, rgba(14,16,20,0.82) 32%, rgba(14,16,20,0) 100%);
}
html[data-theme="light"] .c4-topfade {
  background: linear-gradient(to bottom,
    rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .c4-topfade {
    background: linear-gradient(to bottom,
      rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
  }
}

.c4-canvas {
  position: fixed; inset: 0; width: 100vw; height: 100vh; height: 100dvh;
  z-index: 0; background: transparent;
  touch-action: manipulation;
}

.c4-panel {
  position: fixed; top: 4.6rem; right: 1rem; z-index: 30;
  width: 300px; max-width: calc(100vw - 2rem);
  max-height: calc(100vh - 6rem); max-height: calc(100dvh - 6rem);
  overflow: auto; padding: 0.85rem 1rem 1rem;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
  background: rgba(18,18,18,0.94);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  box-shadow: 0 6px 24px rgba(0,0,0,0.35); font-size: 0.92em;
}
html[data-theme="light"] .c4-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .c4-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
}

.c4-panel__head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.c4-panel__title { font-weight: 700; font-size: 1.05em; }
.c4-collapse {
  font: inherit; line-height: 1; cursor: pointer; color: inherit;
  width: 1.8em; height: 1.8em; padding: 0;
  border: 1px solid rgba(127,127,127,0.4); border-radius: 6px; background: rgba(127,127,127,0.12);
}
.c4-panel--collapsed .c4-panel__body { display: none; }
.c4-panel__body { display: flex; flex-direction: column; gap: 0.8rem; margin-top: 0.7rem; }
.c4-blurb { margin: 0; font-size: 0.9em; opacity: 0.85; line-height: 1.5; }
.c4-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.c4-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14);
  border-radius: 6px; padding: 0.45em 0.7em; transition: background 0.15s ease;
}
.c4-btn:hover { background: rgba(127,127,127,0.26); }
.c4-seg { flex: 1; }
.c4-seg--on { border-color: #82a6cc; background: rgba(130,166,204,0.18); }
.c4-slider { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.95em; }
.c4-slider strong { font-variant-numeric: tabular-nums; }
.c4-slider input[type="range"] { width: 100%; accent-color: #82a6cc; }
.c4-hint { font-size: 0.85em; opacity: 0.65; }
.c4-check { display: inline-flex; align-items: center; gap: 0.45rem; font-size: 0.95em; cursor: pointer; }
.c4-check input { accent-color: #82a6cc; }
.c4-status-line { margin: 0; font-size: 0.9em; opacity: 0.85; min-height: 1.2em; }
.c4-verify-line { margin: 0; font-size: 0.78em; opacity: 0.6; line-height: 1.4; }
.c4-credit { margin: 0; font-size: 0.78em; opacity: 0.55; line-height: 1.4; }

html[data-theme="light"] .c4-seg--on { border-color: #34568a; background: rgba(52,86,138,0.14); }
html[data-theme="light"] .c4-slider input[type="range"],
html[data-theme="light"] .c4-check input { accent-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .c4-seg--on { border-color: #34568a; background: rgba(52,86,138,0.14); }
  html:not([data-theme="dark"]) .c4-slider input[type="range"],
  html:not([data-theme="dark"]) .c4-check input { accent-color: #34568a; }
}
</style>

<script defer src="{{ '/assets/js/gadget-ui.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/share-hash.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/fourinarow-core.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/fourinarow-model.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/fourinarow.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
