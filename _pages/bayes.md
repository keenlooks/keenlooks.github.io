---
layout: single
title: "When a 99% Accurate Test Is Usually Wrong"
permalink: /bayes/
author_profile: false
excerpt: "An interactive look at base rates and Bayes' rule: test 10,000 people at once and watch why a positive result on an accurate test can still usually be a false alarm."
description: "Interactive base-rate and Bayes' rule visualizer by Keane Lucas: a grid of 10,000 person dots with adjustable prevalence, sensitivity, and specificity, plus a security-alert framing showing why rare conditions make accurate tests usually wrong."
---

<p class="bayes-intro">
Suppose a test catches 99% of the people who have a condition and wrongly flags only 1% of the people who do not. You take it and it comes back positive. Most people read that as a 99% chance of being sick. The grid below tests 10,000 people at once so you can watch why that reading fails when the condition is rare.
</p>

<div class="bayes-explainer tex2jax_ignore">
  <div class="bayes-mode" role="group" aria-label="Choose a framing">
    <button id="bayes-mode-med" type="button" class="is-active" aria-pressed="true">Medical test</button>
    <button id="bayes-mode-sec" type="button" aria-pressed="false">Security alerts</button>
  </div>

  <p class="bayes-headline"><span id="bayes-q1">You tested positive.</span>
    <span id="bayes-q2">The chance you actually have it:</span>
    <strong class="bayes-ppv" id="bayes-ppv">33%</strong></p>
  <p class="bayes-counts" id="bayes-counts"></p>
  <p class="bayes-soc" id="bayes-soc" hidden>Real intrusions are rare next to the flood of benign traffic, so even a detector with a tiny false-alarm rate fills the queue with false positives, which is a big part of why security dashboards drown in alerts.</p>

  <canvas id="bayes-canvas" class="bayes-canvas" role="img"
          aria-label="A 100 by 100 grid of 10,000 dots, one per person, colored by test outcome: filled blue for true positives, muted red for false positives, hollow blue for missed cases, faint grey for correct negatives."></canvas>
  <p class="bayes-probe" id="bayes-probe">Hover over a dot to see one person's result.</p>

  <div class="bayes-legend">
    <span class="bayes-key bayes-key--tp"><span id="bayes-key-tp">Sick and tests positive</span></span>
    <span class="bayes-key bayes-key--fp"><span id="bayes-key-fp">Healthy but tests positive (false alarm)</span></span>
    <span class="bayes-key bayes-key--fn"><span id="bayes-key-fn">Sick but the test misses it</span></span>
    <span class="bayes-key bayes-key--tn"><span id="bayes-key-tn">Healthy and tests negative</span></span>
  </div>

  <div class="bayes-controls">
    <div class="bayes-run-row">
      <button id="bayes-run" class="bayes-btn" type="button">Test everyone</button>
    </div>
    <div class="bayes-sliders">
      <label class="bayes-slider">
        <span><span id="bayes-prev-label">Prevalence</span>: <strong id="bayes-prev-val" class="editable-val" data-range="bayes-prev-num">0.5%</strong><span id="bayes-prev-unit"></span></span>
        <input id="bayes-prev" type="range" min="-2" max="1" step="0.001" value="-0.301">
        <span class="bayes-slider__hint" id="bayes-prev-hint">how common the condition is</span>
      </label>
      <label class="bayes-slider">
        <span><span id="bayes-sens-label">Test sensitivity</span>: <strong id="bayes-sens-val" class="editable-val" data-range="bayes-sens">99%</strong></span>
        <input id="bayes-sens" type="range" min="50" max="99.9" step="0.1" value="99">
        <span class="bayes-slider__hint" id="bayes-sens-hint">share of sick people the test catches</span>
      </label>
      <label class="bayes-slider">
        <span><span id="bayes-spec-label">Test specificity</span>: <strong id="bayes-spec-val" class="editable-val" data-range="bayes-spec">99%</strong></span>
        <input id="bayes-spec" type="range" min="50" max="99.9" step="0.1" value="99">
        <span class="bayes-slider__hint" id="bayes-spec-hint">share of healthy people the test correctly clears</span>
      </label>
    </div>
  </div>
  <input id="bayes-prev-num" type="range" min="0.01" max="10" step="0.001" value="0.5" style="display:none!important" aria-hidden="true" tabindex="-1">
</div>

<div class="bayes-copy tex2jax_ignore">
  <p>
  Psychologists call the mistake base rate neglect. A test's accuracy and the chance that a positive result is correct are two different numbers, and people reliably substitute the first for the second. The second one also depends on how common the condition is before you ever run the test, which is the base rate.
  </p>
  <p>
  When the condition is rare, nearly everyone tested is healthy, so even a 1% error rate on that huge healthy pile can produce more false alarms than there are sick people in total. A positive result is then more likely to be noise than signal, no matter how good the test looks on paper. The cure is to count both piles, which is all Bayes' rule does.
  </p>

  <details class="bayes-details">
    <summary>The rule, written out</summary>
    <p>P(sick given positive) = P(positive given sick) &times; P(sick) &divide; P(positive).</p>
    <p>The denominator counts every way a positive can happen, sick or not: P(positive) = P(positive given sick) &times; P(sick) + P(positive given healthy) &times; P(healthy).</p>
    <p>In the sliders' terms: P(sick given positive) = sensitivity &times; prevalence &divide; (sensitivity &times; prevalence + (1 &minus; specificity) &times; (1 &minus; prevalence)). Medicine calls this the positive predictive value. The grid version is simpler: count the filled blue dots, count the filled red dots, and divide blue by blue plus red.</p>
  </details>
</div>

<style>
.bayes-intro, .bayes-copy { max-width: 760px; line-height: 1.65; }
.bayes-intro { margin: 0.25rem 0 1.1rem; }
.bayes-explainer { max-width: 760px; }
.bayes-copy { margin-top: 1.4rem; }

.bayes-mode { display: inline-flex; border: 1px solid rgba(127,127,127,0.45); border-radius: 6px; overflow: hidden; margin: 0.2rem 0 0.3rem; }
.bayes-mode button { font: inherit; font-size: 0.92rem; color: inherit; background: transparent; border: none; border-radius: 0; padding: 0.42em 0.95em; cursor: pointer; line-height: 1.2; }
.bayes-mode button + button { border-left: 1px solid rgba(127,127,127,0.45); }
.bayes-mode button.is-active { background: #82a6cc; color: #141414; }

.bayes-headline { font-size: 1.28rem; line-height: 1.5; margin: 0.75rem 0 0.15rem; }
.bayes-ppv { font-size: 1.6rem; color: #82a6cc; font-variant-numeric: tabular-nums; white-space: nowrap; }
.bayes-counts { font-size: 0.97rem; opacity: 0.92; margin: 0.15rem 0 0.35rem; min-height: 1.5em; }
.bayes-counts strong { font-variant-numeric: tabular-nums; }
.bayes-soc { font-size: 0.92rem; opacity: 0.85; margin: 0 0 0.35rem; }
.bayes-soc[hidden] { display: none !important; }

.bayes-canvas { display: block; width: 100%; max-width: 560px; aspect-ratio: 1 / 1; margin: 0.7rem auto 0.2rem; touch-action: manipulation; }
.bayes-probe { font-size: 0.86rem; opacity: 0.72; min-height: 1.35em; text-align: center; margin: 0.1rem 0 0.45rem; }

.bayes-legend { display: flex; flex-wrap: wrap; gap: 0.3rem 1.1rem; justify-content: center; font-size: 0.85rem; opacity: 0.92; margin: 0 0 1.1rem; }
.bayes-key { display: inline-flex; align-items: center; gap: 0.38rem; }
.bayes-key::before { content: ""; width: 0.72rem; height: 0.72rem; border-radius: 50%; display: inline-block; box-sizing: border-box; flex-shrink: 0; }
.bayes-key--tp::before { background: #82a6cc; }
.bayes-key--fp::before { background: #d98b76; }
.bayes-key--fn::before { background: transparent; border: 2px solid rgba(130,166,204,0.65); }
.bayes-key--tn::before { background: rgba(127,127,127,0.28); }

.bayes-controls { display: flex; flex-direction: column; gap: 0.9rem; }
.bayes-run-row { display: flex; align-items: center; gap: 0.6rem; }
.bayes-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.12);
  border-radius: 6px; padding: 0.5em 0.9em; transition: background 0.15s ease, border-color 0.15s ease;
}
.bayes-btn:hover { background: rgba(127,127,127,0.24); }
.bayes-sliders { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.9rem 1.4rem; }
@media (max-width: 680px) { .bayes-sliders { grid-template-columns: 1fr; } }
.bayes-slider { display: flex; flex-direction: column; gap: 0.28rem; font-size: 0.95rem; }
.bayes-slider strong { font-variant-numeric: tabular-nums; }
.bayes-slider input[type="range"] { width: 100%; accent-color: #82a6cc; }
.bayes-slider__hint { font-size: 0.8rem; opacity: 0.65; line-height: 1.35; }

.bayes-details { max-width: 760px; margin: 1rem 0 0; font-size: 0.95rem; }
.bayes-details summary { cursor: pointer; }
.bayes-details p { margin: 0.5rem 0; line-height: 1.55; }

/* Light-theme accents (manual + auto contexts) */
html[data-theme="light"] .bayes-ppv { color: #34568a; }
html[data-theme="light"] .bayes-mode button.is-active { background: #34568a; color: #ffffff; }
html[data-theme="light"] .bayes-key--tp::before { background: #34568a; }
html[data-theme="light"] .bayes-key--fp::before { background: #b4452f; }
html[data-theme="light"] .bayes-key--fn::before { border-color: rgba(52,86,138,0.6); }
html[data-theme="light"] .bayes-slider input[type="range"] { accent-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .bayes-ppv { color: #34568a; }
  html:not([data-theme="dark"]) .bayes-mode button.is-active { background: #34568a; color: #ffffff; }
  html:not([data-theme="dark"]) .bayes-key--tp::before { background: #34568a; }
  html:not([data-theme="dark"]) .bayes-key--fp::before { background: #b4452f; }
  html:not([data-theme="dark"]) .bayes-key--fn::before { border-color: rgba(52,86,138,0.6); }
  html:not([data-theme="dark"]) .bayes-slider input[type="range"] { accent-color: #34568a; }
}
</style>

<script defer src="{{ '/assets/js/bayes.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/editable-values.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
