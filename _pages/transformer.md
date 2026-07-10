---
layout: single
title: "Tiny Transformer"
permalink: /transformer/
author_profile: false
excerpt: "A tiny GPT writes Shakespeare one character at a time in your browser, with every probability and attention head on display."
description: "An interactive transformer demo by Keane Lucas: a small character-level GPT, trained on Tiny Shakespeare, runs entirely in your browser with no ML library. Watch the next-character probabilities, force its choices, and inspect the attention heads behind every character it writes."
---

<div class="tt-app life-app tex2jax_ignore">
  <div class="tt-topfade" aria-hidden="true"></div>

  <div class="tt-stage" id="tt-stage">
    <div id="tt-text" class="tt-text"
         aria-label="Generated text. Click any character to see the attention snapshot recorded when it was written."></div>

    <div class="tt-bars-wrap">
      <p class="tt-caption">next character · click a bar to force it</p>
      <div id="tt-bars" class="tt-bars" aria-label="Top ten next-character candidates with probabilities"></div>
    </div>

    <div class="tt-attn-wrap">
      <p class="tt-caption" id="tt-attn-caption">attention</p>
      <canvas id="tt-attn" class="tt-attn"
              aria-label="Attention heatmaps: one row per attention head, columns are the recent context characters, brighter cells mean more attention."></canvas>
    </div>
  </div>

  <div class="tt-panel" id="tt-panel">
    <div class="tt-panel__head">
      <span class="tt-panel__title">Tiny Transformer</span>
      <button id="tt-collapse" class="tt-collapse" type="button" aria-label="Hide controls" title="Hide / show controls">&ndash;</button>
    </div>
    <div class="tt-panel__body" id="tt-panel-body">
      <p class="tt-blurb">
        A small GPT-style transformer is running in this page, writing text one character at a
        time. The bars show the probabilities it assigns to the next character, and the heatmap
        rows show where each of its attention heads is looking in the recent text.
      </p>

      <label class="tt-prompt-row"><span>Prompt</span>
        <input id="tt-prompt" type="text" maxlength="60" value="ROMEO: " autocomplete="off" autocapitalize="off" spellcheck="false"></label>

      <div class="tt-row">
        <button id="tt-go" class="tt-btn tt-btn--primary" type="button">Generate</button>
      </div>

      <label class="tt-slider"><span>Temperature: <strong id="tt-temp-val" class="editable-val" data-range="tt-temp">0.80</strong></span>
        <input id="tt-temp" type="range" min="0.1" max="1.5" step="0.05" value="0.8"></label>
      <label class="tt-slider"><span>Speed (chars/sec): <strong id="tt-speed-val" class="editable-val" data-range="tt-speed">20</strong></span>
        <input id="tt-speed" type="range" min="2" max="60" step="1" value="20"></label>
      <label class="tt-slider"><span>Length: <strong id="tt-len-val" class="editable-val" data-range="tt-len">200</strong></span>
        <input id="tt-len" type="range" min="50" max="500" step="10" value="200"></label>

      <p class="tt-hint">
        <strong>Click a probability bar</strong> to force that character on the model.
        <strong>Click any character</strong> it has written to see the attention from the moment
        it was chosen. Low temperature plays the favorite every time; high temperature gambles.
      </p>

      <p class="tt-about">
        <span id="tt-modelinfo">A tiny character-level transformer</span>. Trained on the
        Tiny Shakespeare dataset from Andrej Karpathy's
        <a href="https://github.com/karpathy/char-rnn" target="_blank" rel="noopener">char-rnn</a>.
        The full forward pass runs here in plain JavaScript, no ML library. At this size it
        produces Shakespeare-shaped text, not meaning. The point is that you can watch the
        machinery choose every character.
      </p>

      <p class="tt-status-line"><span id="tt-verify" class="tt-verify"></span></p>
    </div>
  </div>
</div>

<style>
/* Full-screen takeover (loads only on /transformer/). */
.page__title, .page__meta, .page__footer { display: none !important; }
.page__content { pointer-events: none; }
.tt-stage, .tt-panel { pointer-events: auto; }

.masthead { background: transparent !important; border-bottom: 0 !important; }
.greedy-nav { background: transparent !important; }
.tt-topfade {
  position: fixed; top: 0; left: 0; right: 0; height: 110px;
  z-index: 10; pointer-events: none;
  background: linear-gradient(to bottom,
    rgba(20,20,20,0.96) 0%, rgba(20,20,20,0.8) 32%, rgba(20,20,20,0) 100%);
}
html[data-theme="light"] .tt-topfade {
  background: linear-gradient(to bottom,
    rgba(255,255,255,0.96) 0%, rgba(255,255,255,0.8) 32%, rgba(255,255,255,0) 100%);
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .tt-topfade {
    background: linear-gradient(to bottom,
      rgba(255,255,255,0.96) 0%, rgba(255,255,255,0.8) 32%, rgba(255,255,255,0) 100%);
  }
}

/* ---- stage: text card + bars + attention, all DOM ---- */
.tt-stage {
  position: fixed; inset: 0; z-index: 0;
  display: flex; flex-direction: column; gap: 0.8rem;
  padding: 7rem 1rem 0.9rem 1rem;
  overflow-y: auto;
}
.tt-text, .tt-bars-wrap, .tt-attn-wrap { width: 100%; max-width: 1000px; margin: 0 auto; }

.tt-text {
  flex: 1 1 auto; min-height: 64px; overflow-y: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.95rem; line-height: 1.55;
  white-space: pre-wrap; overflow-wrap: anywhere;
  border: 1px solid rgba(127,127,127,0.3); border-radius: 10px;
  background: rgba(127,127,127,0.07);
  padding: 0.75rem 0.95rem;
}
.tt-ch { cursor: pointer; border-radius: 2px; }
.tt-ch:hover { background: rgba(127,127,127,0.3); }
.tt-ch--prompt { opacity: 0.55; }
.tt-ch--sel { background: rgba(130,166,204,0.35); box-shadow: 0 0 0 1px rgba(130,166,204,0.8); }
@keyframes tt-flash {
  from { background-color: rgba(130,166,204,0.85); }
  to { background-color: rgba(130,166,204,0); }
}
.tt-ch--new { animation: tt-flash 0.7s ease-out; }

.tt-caption { margin: 0 0 0.3rem; font-size: 0.78em; opacity: 0.65; }

/* ---- next-char bars ---- */
.tt-bars { display: flex; gap: 6px; align-items: flex-end; }
.tt-bar {
  flex: 1 1 0; max-width: 64px; min-width: 0;
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  background: none; border: 0; padding: 2px; margin: 0;
  cursor: pointer; color: inherit; font: inherit; border-radius: 6px;
}
.tt-bar:hover { background: rgba(127,127,127,0.14); }
.tt-bar__pct { font-size: 0.66em; opacity: 0.7; font-variant-numeric: tabular-nums; }
.tt-bar__track {
  position: relative; width: 100%; max-width: 30px; height: 74px;
  border-radius: 3px; background: rgba(127,127,127,0.12); overflow: hidden;
}
.tt-bar__fill {
  position: absolute; left: 0; right: 0; bottom: 0; height: 0;
  background: #82a6cc; border-radius: 3px 3px 0 0; transition: height 80ms linear;
}
.tt-bar__ch {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9em; line-height: 1.2; white-space: pre;
}
html[data-theme="light"] .tt-bar__fill { background: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .tt-bar__fill { background: #34568a; }
}
@media (prefers-reduced-motion: reduce) {
  .tt-ch--new { animation: none; }
  .tt-bar__fill { transition: none; }
}

/* ---- attention heatmaps ---- */
.tt-attn { display: block; width: 100%; }

/* ---- controls panel ---- */
.tt-panel {
  position: fixed; top: 4.6rem; right: 1rem; z-index: 30;
  width: 320px; max-width: calc(100vw - 2rem); max-height: calc(100vh - 6rem);
  overflow: auto; padding: 0.85rem 1rem 1rem;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
  background: rgba(18,18,18,0.94);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  box-shadow: 0 6px 24px rgba(0,0,0,0.35); font-size: 0.92em;
}
html[data-theme="light"] .tt-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .tt-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
}
.tt-panel__head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.tt-panel__title { font-weight: 700; font-size: 1.05em; }
.tt-collapse {
  font: inherit; line-height: 1; cursor: pointer; color: inherit;
  width: 1.8em; height: 1.8em; padding: 0;
  border: 1px solid rgba(127,127,127,0.4); border-radius: 6px; background: rgba(127,127,127,0.12);
}
.tt-panel--collapsed .tt-panel__body { display: none; }
.tt-panel__body { display: flex; flex-direction: column; gap: 0.8rem; margin-top: 0.7rem; }
.tt-blurb { margin: 0; font-size: 0.9em; opacity: 0.85; line-height: 1.5; }
.tt-prompt-row { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.95em; }
.tt-prompt-row input[type="text"] {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.95em; padding: 0.4em 0.55em; width: 100%; box-sizing: border-box;
  border: 1px solid rgba(127,127,127,0.45); border-radius: 6px;
  background: rgba(127,127,127,0.10); color: inherit;
}
.tt-prompt-row input[type="text"]:focus { outline: none; border-color: #82a6cc; }
html[data-theme="light"] .tt-prompt-row input[type="text"]:focus { border-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .tt-prompt-row input[type="text"]:focus { border-color: #34568a; }
}
.tt-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.tt-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14);
  border-radius: 6px; padding: 0.45em 0.7em; transition: background 0.15s ease;
}
.tt-btn:hover { background: rgba(127,127,127,0.26); }
.tt-btn--primary { border-color: rgba(130,166,204,0.65); background: rgba(130,166,204,0.18); font-weight: 600; min-width: 7em; }
.tt-btn--primary:hover { background: rgba(130,166,204,0.3); }
html[data-theme="light"] .tt-btn--primary { border-color: rgba(52,86,138,0.55); background: rgba(52,86,138,0.12); }
html[data-theme="light"] .tt-btn--primary:hover { background: rgba(52,86,138,0.2); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .tt-btn--primary { border-color: rgba(52,86,138,0.55); background: rgba(52,86,138,0.12); }
  html:not([data-theme="dark"]) .tt-btn--primary:hover { background: rgba(52,86,138,0.2); }
}
.tt-slider { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.95em; }
.tt-slider strong { font-variant-numeric: tabular-nums; }
.tt-slider input[type="range"] { width: 100%; accent-color: #82a6cc; }
html[data-theme="light"] .tt-slider input[type="range"] { accent-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .tt-slider input[type="range"] { accent-color: #34568a; }
}
.tt-hint { margin: 0; font-size: 0.82em; opacity: 0.7; line-height: 1.5; }
.tt-about { margin: 0; font-size: 0.78em; opacity: 0.65; line-height: 1.5; }
.tt-status-line { margin: 0; font-size: 0.8em; min-height: 1.2em; }
.tt-verify { opacity: 0.6; font-variant-numeric: tabular-nums; }
.tt-verify--bad { color: #c4574a; opacity: 1; font-weight: 600; }

/* ---- responsive ---- */
@media (min-width: 1080px) {
  .tt-stage { padding-right: calc(320px + 2.6rem); }
}
@media (max-width: 768px) {
  .tt-stage { padding-bottom: 4.6rem; }  /* clear the full-width chat bar */
}
@media (max-width: 480px) {
  .tt-bar__pct { display: none; }
  .tt-bars { gap: 3px; }
}
</style>

<script defer src="{{ '/assets/js/transformer-model.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/transformer.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/editable-values.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
