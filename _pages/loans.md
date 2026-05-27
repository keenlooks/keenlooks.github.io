---
layout: single
title: "Where Your Loan Payments Actually Go"
permalink: /loans/
author_profile: false
excerpt: "An interactive look at how loan payments split between interest and principal — and how paying extra (especially early) saves you money."
description: "Interactive loan amortization explainer by Keane Lucas: see how each payment splits between interest and principal, and how making extra payments (and starting them sooner) cuts total interest and pays a loan off faster."
---

<p class="loan-intro">
A loan is the mirror image of a <a href="{{ '/bonds/' | relative_url }}">bond</a>: instead of being <em>owed</em> a future payout, you <em>owe</em> one.
You borrow a lump sum today and pay it back in fixed monthly chunks. If you pay more than the required payment, you can pay off the loan faster and save on interest. The below interactive can help see how that works, how much less interest you pay by making extra payments (earlier or later), and how the loan balance changes over time.
</p>

<div class="loan-explainer tex2jax_ignore">
  <canvas id="loan-canvas" class="loan-canvas"
          aria-label="Chart of a loan's remaining balance over time, comparing standard payments to making extra monthly payments, which pays the loan off sooner."></canvas>
  <p class="loan-hint">Tip: <strong>click the chart</strong> to drop a one-time payment and type its amount; <strong>drag</strong> it to move it in time; click it again to change the amount (× or 0 removes it). Click a year on the bottom axis to anchor the timeline to a real date.</p>

  <div class="loan-breakdown">
    <div class="loan-legend">
      <span class="loan-key loan-key--principal">Principal (what you borrowed)</span>
      <span class="loan-key loan-key--interest">Interest (the cost)</span>
    </div>
    <div class="loan-bar-row">
      <span class="loan-bar-label">Standard payments</span>
      <div class="loan-bar" id="bar-base">
        <div class="loan-seg loan-seg--principal" id="bar-base-p"></div>
        <div class="loan-seg loan-seg--interest" id="bar-base-i"></div>
      </div>
      <span class="loan-bar-total" id="bar-base-total"></span>
    </div>
    <div class="loan-bar-row">
      <span class="loan-bar-label">With extra payments</span>
      <div class="loan-bar" id="bar-extra">
        <div class="loan-seg loan-seg--principal" id="bar-extra-p"></div>
        <div class="loan-seg loan-seg--interest" id="bar-extra-i"></div>
      </div>
      <span class="loan-bar-total" id="bar-extra-total"></span>
    </div>
  </div>

  <p class="loan-readout">
    Monthly payment: <strong id="loan-payment">$333/mo</strong>.
    Interest saved by paying extra: <strong id="loan-saved-interest" class="loan-good">$0</strong>
    <span id="loan-saved-time">&mdash;</span>.
  </p>
  <p class="loan-timing" id="loan-timing"></p>

  <div class="loan-controls">
    <div class="loan-sliders">
      <label class="loan-slider"><span>Loan amount: <strong id="loan-principal-val" class="editable-val" data-range="loan-principal">$30,000</strong></span>
        <input id="loan-principal" type="range" min="1000" max="100000" step="1000" value="30000"></label>
      <label class="loan-slider"><span>Interest rate (APR): <strong id="loan-rate-val" class="editable-val" data-range="loan-rate">6.0%</strong></span>
        <input id="loan-rate" type="range" min="0" max="12" step="0.1" value="6"></label>
      <label class="loan-slider"><span>Term: <strong id="loan-years-val" class="editable-val" data-range="loan-years">10</strong> years</span>
        <input id="loan-years" type="range" min="2" max="30" step="1" value="10"></label>
      <label class="loan-slider"><span>Extra payment: <strong id="loan-extra-val" class="editable-val" data-range="loan-extra">$100/mo</strong></span>
        <input id="loan-extra" type="range" min="0" max="1000" step="10" value="100"></label>
      <label class="loan-slider"><span>Start extra payments: <strong id="loan-start-val" class="editable-val" data-range="loan-start">now</strong></span>
        <input id="loan-start" type="range" min="0" max="10" step="1" value="0"></label>
    </div>
    <div class="loan-scenarios">
      <span class="loan-scenarios__label">Try:</span>
      <button id="loan-now" class="loan-btn" type="button">Extra $100 now</button>
      <button id="loan-later" class="loan-btn" type="button">&hellip;but start at year 5</button>
      <button id="loan-clear" class="loan-btn" type="button">Clear placed payments</button>
      <button id="loan-reset" class="loan-btn" type="button">Reset</button>
    </div>
  </div>
</div>

<p class="loan-foot">
  Notice the <em>timing</em>: the same extra dollars wipe out more interest the earlier you pay them,
  because they stop interest from piling up on that balance for longer. Slide &ldquo;Start extra
  payments&rdquo; later (or hit &ldquo;start at year 5&rdquo;) and watch your savings shrink.
</p>

<style>
.loan-intro, .loan-foot { max-width: 760px; line-height: 1.65; }
.loan-intro { margin: 0.25rem 0 1.25rem; }
.loan-foot  { margin: 1.25rem 0 0; opacity: 0.92; }
.loan-explainer { max-width: 760px; }

.loan-canvas { width: 100%; height: 380px; display: block; cursor: crosshair; touch-action: none; }
@media (max-width: 600px) { .loan-canvas { height: 300px; } }
.loan-hint { font-size: 0.88rem; opacity: 0.75; margin: 0.4rem 0 0; }

/* principal vs interest comparison bars */
.loan-breakdown { display: flex; flex-direction: column; gap: 0.55rem; margin: 1.1rem 0 1.1rem; }
.loan-legend { display: flex; flex-wrap: wrap; gap: 1.1rem; font-size: 0.85rem; opacity: 0.88; }
.loan-key { display: inline-flex; align-items: center; gap: 0.4rem; }
.loan-key::before { content: ""; width: 0.8rem; height: 0.8rem; border-radius: 2px; display: inline-block; }
.loan-key--principal::before { background: #82a6cc; }
.loan-key--interest::before  { background: #d98b76; }

.loan-bar-row { display: grid; grid-template-columns: 150px minmax(0, 1fr) auto; align-items: center; gap: 0.75rem; }
.loan-bar-label { font-size: 0.9rem; }
.loan-bar { display: flex; height: 22px; border-radius: 5px; overflow: hidden; background: rgba(127,127,127,0.12); min-width: 3px; max-width: 100%; }
.loan-seg { height: 100%; flex-shrink: 0; transition: width 0.2s ease; }
.loan-seg--principal { background: #82a6cc; }
.loan-seg--interest  { background: #d98b76; }
.loan-bar-total { font-size: 0.88rem; font-variant-numeric: tabular-nums; opacity: 0.9; }
@media (max-width: 560px) {
  .loan-bar-row { grid-template-columns: minmax(0, 1fr) auto; }
  .loan-bar { grid-column: 1 / -1; order: 3; }
}

.loan-readout { font-size: 1rem; line-height: 1.6; margin: 0.25rem 0 0.4rem; }
.loan-readout strong { font-variant-numeric: tabular-nums; }
.loan-good { color: #82a6cc; }
.loan-timing { font-size: 0.92rem; opacity: 0.82; min-height: 1.4em; margin: 0 0 1.25rem; }

.loan-controls { display: flex; flex-direction: column; gap: 1rem; }
.loan-sliders { display: grid; grid-template-columns: 1fr 1fr; gap: 0.9rem 1.5rem; }
@media (max-width: 560px) { .loan-sliders { grid-template-columns: 1fr; } }
.loan-slider { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.95rem; }
.loan-slider strong { font-variant-numeric: tabular-nums; }
.loan-slider input[type="range"] { width: 100%; accent-color: #82a6cc; }
.loan-scenarios { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.loan-scenarios__label { font-size: 0.95rem; opacity: 0.85; }
.loan-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.12);
  border-radius: 6px; padding: 0.5em 0.85em; transition: background 0.15s ease, border-color 0.15s ease;
}
.loan-btn:hover { background: rgba(127,127,127,0.24); }

/* Light-theme accents (manual + auto contexts) */
html[data-theme="light"] .loan-key--principal::before,
html[data-theme="light"] .loan-seg--principal { background: #34568a; }
html[data-theme="light"] .loan-key--interest::before,
html[data-theme="light"] .loan-seg--interest { background: #b4452f; }
html[data-theme="light"] .loan-good { color: #34568a; }
html[data-theme="light"] .loan-slider input[type="range"] { accent-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .loan-key--principal::before,
  html:not([data-theme="dark"]) .loan-seg--principal { background: #34568a; }
  html:not([data-theme="dark"]) .loan-key--interest::before,
  html:not([data-theme="dark"]) .loan-seg--interest { background: #b4452f; }
  html:not([data-theme="dark"]) .loan-good { color: #34568a; }
  html:not([data-theme="dark"]) .loan-slider input[type="range"] { accent-color: #34568a; }
}
</style>

<script defer src="{{ '/assets/js/canvas-edit.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/loans.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/editable-values.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
