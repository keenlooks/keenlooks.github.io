---
layout: single
title: "Rocket Lander"
permalink: /lander/
author_profile: false
excerpt: "A reinforcement-learning agent lands a rocket. Change gravity, wind, or the pad and watch it cope."
description: "An interactive reinforcement-learning demo by Keane Lucas: a small policy network, trained from scratch, flies a rocket down to a landing pad. Change gravity, wind, or the pad position, or fling the rocket, and watch the agent adapt — with a live view of the network deciding each instant. Inspired by the classic LunarLander environment."
---

<div class="land-app life-app">
  <div class="land-topfade" aria-hidden="true"></div>
  <canvas id="land-canvas" class="land-canvas"
          aria-label="A reinforcement-learning agent flying a rocket down to a landing pad; you can change gravity, wind, and the pad position."></canvas>

  <div class="land-panel" id="land-panel">
    <div class="land-panel__head">
      <span class="land-panel__title">Rocket Lander</span>
      <button id="land-help" class="gadget-help" type="button" aria-label="Show hint" title="Show hint">?</button>
      <button id="land-collapse" class="land-collapse" type="button" aria-label="Hide / show controls" title="Hide / show controls">&ndash;</button>
    </div>
    <div class="land-panel__body" id="land-panel-body">
      <p class="land-blurb">
        This rocket is flown by a small <strong>reinforcement-learning</strong> agent, trained from
        scratch by letting it crash a few hundred thousand times. Change the world and watch it cope.
        It was trained on a range of gravity, wind, and pad positions, so it handles those well;
        push a slider past where it ever trained and you can watch it struggle. You can also
        <strong>drag the rocket</strong> to fling it, or <strong>drag the ground</strong> to move the pad.
      </p>

      <label class="land-slider"><span>Gravity: <strong id="land-grav-val" class="editable-val" data-range="land-grav">0.22</strong></span>
        <input id="land-grav" type="range" min="0.12" max="0.60" step="0.01" value="0.22"></label>
      <label class="land-slider"><span>Wind: <strong id="land-wind-val" class="editable-val" data-range="land-wind">0.00</strong></span>
        <input id="land-wind" type="range" min="-0.25" max="0.25" step="0.01" value="0"></label>
      <label class="land-slider"><span>Pad position: <strong id="land-pad-val" class="editable-val" data-range="land-pad">0.50</strong></span>
        <input id="land-pad" type="range" min="20" max="80" step="1" value="50"></label>

      <div class="land-checks">
        <label class="land-check"><input id="land-auto" type="checkbox" checked> Autopilot (the agent flies)</label>
        <label class="land-check"><input id="land-brain" type="checkbox" checked> Show the agent's brain</label>
      </div>

      <div class="land-row">
        <button id="land-reset" class="land-btn" type="button">New rocket</button>
      </div>

      <p class="land-hint">With autopilot off, fly it yourself: <strong>↑</strong> thrust, <strong>← →</strong> rotate
        (on a touchscreen, buttons appear at the bottom).</p>
      <p class="land-credit">
        Original code and physics. The task and controls are inspired by the classic
        <a href="https://gymnasium.farama.org/environments/box2d/lunar_lander/" target="_blank" rel="noopener">LunarLander</a>
        environment from OpenAI Gym, now maintained by the
        <a href="https://farama.org/" target="_blank" rel="noopener">Farama Foundation</a> as Gymnasium.
      </p>
    </div>
  </div>
</div>

<style>
/* Full-screen takeover (loads only on /lander/). */
.page__title, .page__meta, .page__footer { display: none !important; }
.page__content { pointer-events: none; }
.land-canvas, .land-panel { pointer-events: auto; }

.masthead { background: transparent !important; border-bottom: 0 !important; }
.greedy-nav { background: transparent !important; }
.land-topfade {
  position: fixed; top: 0; left: 0; right: 0; height: 120px;
  z-index: 10; pointer-events: none;
  background: linear-gradient(to bottom, rgba(10,15,31,0.96) 0%, rgba(10,15,31,0.7) 32%, rgba(10,15,31,0) 100%);
}
html[data-theme="light"] .land-topfade { background: linear-gradient(to bottom, rgba(219,230,245,0.96) 0%, rgba(219,230,245,0.7) 32%, rgba(219,230,245,0) 100%); }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .land-topfade { background: linear-gradient(to bottom, rgba(219,230,245,0.96) 0%, rgba(219,230,245,0.7) 32%, rgba(219,230,245,0) 100%); } }

.land-canvas { position: fixed; inset: 0; width: 100vw; height: 100vh; z-index: 0; background: transparent; cursor: grab; touch-action: none; }

.land-panel {
  position: fixed; top: 4.6rem; right: 1rem; z-index: 30;
  width: 290px; max-width: calc(100vw - 2rem); max-height: calc(100vh - 6rem);
  overflow: auto; padding: 0.85rem 1rem 1rem;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
  background: rgba(18,18,18,0.94); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  box-shadow: 0 6px 24px rgba(0,0,0,0.35); font-size: 0.92em;
}
html[data-theme="light"] .land-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .land-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); } }

.land-panel__head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.land-panel__title { font-weight: 700; font-size: 1.05em; }
.land-collapse { font: inherit; line-height: 1; cursor: pointer; color: inherit; width: 1.8em; height: 1.8em; padding: 0; border: 1px solid rgba(127,127,127,0.4); border-radius: 6px; background: rgba(127,127,127,0.12); }
.land-panel--collapsed .land-panel__body { display: none; }
.land-panel__body { display: flex; flex-direction: column; gap: 0.8rem; margin-top: 0.7rem; }
.land-blurb { margin: 0; font-size: 0.9em; opacity: 0.85; line-height: 1.5; }
.land-slider { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.95em; }
.land-slider strong { font-variant-numeric: tabular-nums; }
.land-slider input[type="range"] { width: 100%; accent-color: #82a6cc; }
.land-checks { display: flex; flex-direction: column; gap: 0.4rem; }
.land-check { display: inline-flex; align-items: center; gap: 0.45rem; font-size: 0.95em; cursor: pointer; }
.land-check input { accent-color: #82a6cc; }
.land-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.land-btn { font: inherit; color: inherit; cursor: pointer; line-height: 1; border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14); border-radius: 6px; padding: 0.45em 0.7em; transition: background 0.15s ease; }
.land-btn:hover { background: rgba(127,127,127,0.26); }
.land-hint { font-size: 0.82em; opacity: 0.72; margin: 0; line-height: 1.5; }
.land-credit { font-size: 0.78em; opacity: 0.65; margin: 0; line-height: 1.5; }

html[data-theme="light"] .land-slider input[type="range"], html[data-theme="light"] .land-check input { accent-color: #34568a; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .land-slider input[type="range"], html:not([data-theme="dark"]) .land-check input { accent-color: #34568a; } }
</style>

<script defer src="{{ '/assets/js/lander-model.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/gadget-ui.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/lander.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/editable-values.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
