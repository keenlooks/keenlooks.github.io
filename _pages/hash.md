---
layout: single
title: "Hash Avalanche"
permalink: /hash/
author_profile: false
excerpt: "Watch SHA-256's avalanche effect: change one character, flip half the bits."
description: "An interactive SHA-256 avalanche-effect visualizer by Keane Lucas: the digest is drawn as a 16×16 grid of bits, and changing a single character of the message flips roughly half of them — the property that makes cryptographic hashes useful."
---

<div class="hash-app life-app">
  <div class="hash-topfade" aria-hidden="true"></div>
  <canvas id="hash-canvas" class="hash-canvas"
          aria-label="A 16 by 16 grid showing the 256 bits of the message's SHA-256 digest; changed bits flash when the message changes."></canvas>

  <div class="hash-panel" id="hash-panel">
    <div class="hash-panel__head">
      <span class="hash-panel__title">Hash Avalanche</span>
      <button id="hash-collapse" class="hash-collapse" type="button" aria-label="Hide / show controls" title="Hide / show controls">&ndash;</button>
    </div>
    <div class="hash-panel__body" id="hash-panel-body">
      <p class="hash-blurb" id="hash-blurb"></p>

      <div class="hash-views">
        <button class="hash-view" data-view="result" type="button">Avalanche</button>
        <button class="hash-view hash-view--on" data-view="collide" type="button">Collisions</button>
      </div>

      <label class="hash-label hash-result-only" for="hash-text">Message</label>
      <textarea id="hash-text" class="hash-input hash-result-only" rows="3" spellcheck="false">Hello, world!</textarea>

      <div class="hash-row">
        <button id="hash-flip" class="hash-btn" type="button" title="Replace one random character">Change one character</button>
        <button id="hash-find" class="hash-btn" type="button" title="Birthday search for two inputs with the same CRC32">Find a collision</button>
      </div>

      <p class="hash-stat hash-result-only" id="hash-changed">Edit the message to see the avalanche.</p>
      <p class="hash-prev hash-result-only" id="hash-prev"></p>
      <p class="hash-hint" id="hash-hint"></p>

      <details class="hash-note">
        <summary>Why is CRC32 so easy to collide, and can real hashes be broken?</summary>
        <p>CRC32 is a <em>checksum</em>: it's great at catching accidental corruption, but it was never
        meant to stop an attacker, and its 32-bit output means a matching pair shows up after only
        ~2¹⁶–2¹⁷ tries (the birthday bound). Cryptographic hashes <em>are</em> meant to resist this,
        with much longer outputs and carefully designed mixing. Even so, researchers have broken older
        ones:</p>
        <ul>
          <li><b>MD5</b>: Xiaoyun Wang and Hongbo Yu showed practical collisions in 2004.</li>
          <li><b>SHA-1</b>: the <a href="https://shattered.io/" target="_blank" rel="noopener">SHAttered</a>
          team (Marc Stevens, Elie Bursztein, Pierre Karpman, Ange Albertini, Yarik Markov) produced the
          first real SHA-1 collision in 2017, building on Stevens' earlier cryptanalysis.</li>
        </ul>
        <p>Those attacks exploit structure in the algorithm to find collisions far faster than brute
        force. SHA-256 has resisted this so far.</p>
      </details>
    </div>
  </div>
</div>

<style>
/* Full-screen takeover: hide the normal page chrome, let the fixed canvas own the
   viewport. (These rules only load on /hash/.) */
.page__title, .page__meta, .page__footer { display: none !important; }
.page__content { pointer-events: none; }
.hash-canvas, .hash-panel { pointer-events: auto; }

.masthead { background: transparent !important; border-bottom: 0 !important; }
.greedy-nav { background: transparent !important; }
.hash-topfade {
  position: fixed; top: 0; left: 0; right: 0; height: 120px;
  z-index: 10; pointer-events: none;
  background: linear-gradient(to bottom,
    rgba(16,18,22,0.96) 0%, rgba(16,18,22,0.82) 32%, rgba(16,18,22,0) 100%);
}
html[data-theme="light"] .hash-topfade {
  background: linear-gradient(to bottom,
    rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .hash-topfade {
    background: linear-gradient(to bottom,
      rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
  }
}

.hash-canvas {
  position: fixed; inset: 0; width: 100vw; height: 100vh;
  z-index: 0; background: transparent; cursor: pointer;
  touch-action: none;
}

.hash-panel {
  position: fixed; top: 4.6rem; right: 1rem; z-index: 30;
  width: 290px; max-width: calc(100vw - 2rem); max-height: calc(100vh - 6rem);
  overflow: auto; padding: 0.85rem 1rem 1rem;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
  background: rgba(18,18,18,0.94);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  box-shadow: 0 6px 24px rgba(0,0,0,0.35); font-size: 0.92em;
}
html[data-theme="light"] .hash-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .hash-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
}

.hash-panel__head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.hash-panel__title { font-weight: 700; font-size: 1.05em; }
.hash-collapse {
  font: inherit; line-height: 1; cursor: pointer; color: inherit;
  width: 1.8em; height: 1.8em; padding: 0;
  border: 1px solid rgba(127,127,127,0.4); border-radius: 6px; background: rgba(127,127,127,0.12);
}
.hash-panel--collapsed .hash-panel__body { display: none; }
.hash-panel__body { display: flex; flex-direction: column; gap: 0.7rem; margin-top: 0.7rem; }
.hash-blurb { margin: 0; font-size: 0.9em; opacity: 0.85; line-height: 1.5; }
.hash-label { font-size: 0.85em; opacity: 0.85; margin-bottom: -0.4rem; }
.hash-input {
  font: inherit; color: inherit; width: 100%; resize: vertical;
  border: 1px solid rgba(127,127,127,0.4); border-radius: 6px;
  background: rgba(127,127,127,0.10); padding: 0.45em 0.6em;
}
.hash-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.hash-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14);
  border-radius: 6px; padding: 0.45em 0.7em; transition: background 0.15s ease;
}
.hash-btn:hover { background: rgba(127,127,127,0.26); }
.hash-views { display: flex; gap: 0.4rem; }
.hash-view {
  font: inherit; color: inherit; cursor: pointer; line-height: 1; flex: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14);
  border-radius: 6px; padding: 0.45em 0.7em; transition: background 0.15s ease;
}
.hash-view:hover { background: rgba(127,127,127,0.26); }
.hash-view--on { background: #82a6cc; border-color: #82a6cc; color: #fff; }
html[data-theme="light"] .hash-view--on { background: #34568a; border-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .hash-view--on { background: #34568a; border-color: #34568a; }
}
.hash-note { font-size: 0.85em; opacity: 0.85; }
.hash-note summary { cursor: pointer; opacity: 0.9; }
.hash-note p, .hash-note ul { margin: 0.5em 0; line-height: 1.5; }
.hash-note ul { padding-left: 1.1em; }
.hash-stat { margin: 0; font-size: 0.95em; font-variant-numeric: tabular-nums; }
.hash-prev { margin: 0; font-size: 0.8em; opacity: 0.6; overflow-wrap: anywhere; }
.hash-hint { margin: 0; font-size: 0.82em; opacity: 0.7; }
</style>

<script defer src="{{ '/assets/js/hash.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
