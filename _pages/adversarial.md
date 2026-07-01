---
layout: single
title: "Fool a Neural Network"
permalink: /adversarial/
author_profile: false
excerpt: "Add invisible noise to a digit and watch a neural network change its mind — adversarial examples, live in your browser."
description: "An interactive adversarial-example demo by Keane Lucas: a small MNIST classifier runs entirely in your browser, and the Fast Gradient Sign Method nudges every pixel just enough to flip its prediction while the image looks unchanged to you. Draw your own digits and attack them too."
---

<div class="adv-app life-app">
  <div class="adv-topfade" aria-hidden="true"></div>
  <canvas id="adv-canvas" class="adv-canvas"
          aria-label="Three images: an original digit, an amplified noise pattern, and their sum — which the neural network misclassifies even though it looks identical to the original."></canvas>

  <div class="adv-panel" id="adv-panel">
    <div class="adv-panel__head">
      <span class="adv-panel__title">Fool a Neural Network</span>
      <button id="adv-collapse" class="adv-collapse" type="button" aria-label="Hide / show controls" title="Hide / show controls">&ndash;</button>
    </div>
    <div class="adv-panel__body" id="adv-panel-body">
      <p class="adv-blurb">
        A small neural network is running in your browser and reading the digit on the left.
        The middle panel shows the direction in pixel space that most increases its error, which
        is the network's own gradient turned against it. Slide <strong>&epsilon;</strong> up to add a
        small amount of that noise. The prediction changes even though the image looks the same to
        you. This is the
        <a href="https://arxiv.org/abs/1412.6572" target="_blank" rel="noopener">Fast Gradient Sign Method</a>,
        and attacks like it are part of why <a href="{{ base_path }}/publications/">my PhD work</a> was
        about making models more robust.
      </p>

      <label class="adv-slider"><span>Attack strength &epsilon;: <strong id="adv-eps-val" class="editable-val" data-range="adv-eps">0.10</strong></span>
        <input id="adv-eps" type="range" min="0" max="0.3" step="0.01" value="0.1"></label>

      <label class="adv-check"><input id="adv-robust" type="checkbox"> Use the adversarially-trained model</label>

      <div class="adv-row">
        <button id="adv-next" class="adv-btn" type="button">Next digit</button>
        <button id="adv-clear" class="adv-btn" type="button" title="Blank the canvas so you can draw your own digit">Clear &amp; draw</button>
      </div>

      <p class="adv-hint">
        <strong>Click a confidence bar</strong> to aim the attack at that digit. You can also
        <strong>draw on the left image</strong> (right-drag erases); the network reads it live and the
        attack adapts. The adversarially-trained model has seen attacks during training, so it is
        much harder to fool (its clean accuracy is a little lower in exchange).
      </p>
      <p class="adv-status-line"><span id="adv-status"></span></p>
    </div>
  </div>
</div>

<style>
/* Full-screen takeover: hide the normal page chrome, let the fixed canvas own the
   viewport. (These rules only load on /adversarial/.) */
.page__title, .page__meta, .page__footer { display: none !important; }
.page__content { pointer-events: none; }
.adv-canvas, .adv-panel { pointer-events: auto; }

.masthead { background: transparent !important; border-bottom: 0 !important; }
.greedy-nav { background: transparent !important; }
.adv-topfade {
  position: fixed; top: 0; left: 0; right: 0; height: 120px;
  z-index: 10; pointer-events: none;
  background: linear-gradient(to bottom,
    rgba(14,16,20,0.96) 0%, rgba(14,16,20,0.82) 32%, rgba(14,16,20,0) 100%);
}
html[data-theme="light"] .adv-topfade {
  background: linear-gradient(to bottom,
    rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .adv-topfade {
    background: linear-gradient(to bottom,
      rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
  }
}

.adv-canvas {
  position: fixed; inset: 0; width: 100vw; height: 100vh;
  z-index: 0; background: transparent; cursor: crosshair;
  touch-action: none;
}

.adv-panel {
  position: fixed; top: 4.6rem; right: 1rem; z-index: 30;
  width: 300px; max-width: calc(100vw - 2rem); max-height: calc(100vh - 6rem);
  overflow: auto; padding: 0.85rem 1rem 1rem;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
  background: rgba(18,18,18,0.94);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  box-shadow: 0 6px 24px rgba(0,0,0,0.35); font-size: 0.92em;
}
html[data-theme="light"] .adv-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .adv-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
}

.adv-panel__head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.adv-panel__title { font-weight: 700; font-size: 1.05em; }
.adv-collapse {
  font: inherit; line-height: 1; cursor: pointer; color: inherit;
  width: 1.8em; height: 1.8em; padding: 0;
  border: 1px solid rgba(127,127,127,0.4); border-radius: 6px; background: rgba(127,127,127,0.12);
}
.adv-panel--collapsed .adv-panel__body { display: none; }
.adv-panel__body { display: flex; flex-direction: column; gap: 0.8rem; margin-top: 0.7rem; }
.adv-blurb { margin: 0; font-size: 0.9em; opacity: 0.85; line-height: 1.5; }
.adv-slider { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.95em; }
.adv-slider strong { font-variant-numeric: tabular-nums; }
.adv-slider input[type="range"] { width: 100%; accent-color: #82a6cc; }
.adv-check { display: inline-flex; align-items: center; gap: 0.45rem; font-size: 0.95em; cursor: pointer; }
.adv-check input { accent-color: #82a6cc; }
.adv-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.adv-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14);
  border-radius: 6px; padding: 0.45em 0.7em; transition: background 0.15s ease;
}
.adv-btn:hover { background: rgba(127,127,127,0.26); }
.adv-hint { margin: 0; font-size: 0.82em; opacity: 0.7; line-height: 1.5; }
.adv-status-line { margin: 0; font-size: 0.85em; opacity: 0.8; font-variant-numeric: tabular-nums; min-height: 1.2em; }

html[data-theme="light"] .adv-slider input[type="range"],
html[data-theme="light"] .adv-check input { accent-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .adv-slider input[type="range"],
  html:not([data-theme="dark"]) .adv-check input { accent-color: #34568a; }
}
</style>

<script defer src="{{ '/assets/js/adversarial-model.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/adversarial.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/editable-values.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
