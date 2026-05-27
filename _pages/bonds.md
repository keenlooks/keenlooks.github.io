---
layout: single
title: "Why Bond Prices Fall When Rates Rise"
permalink: /bonds/
author_profile: false
excerpt: "An interactive look at why a bond's price drops when interest rates go up."
description: "Interactive explainer by Keane Lucas: a bond is a fixed future payout, so when the market is paying higher interest rates (e.g., the Fed raises rates on their \"risk-free\" securities, so all other bonds have to raise rates as well to remain competitive) that *higher interest rate* manifests as that future payout being worth less today, so current bond prices fall. Drag the rate and watch."
---

<p class="bond-intro">
In the simplest form, buying a bond is really just buying the promise of a <strong>fixed payout at a fixed time</strong>. What you'd pay
for that future payout <em>today</em> can be calculated as that future payout, discounted back to the present by the current going interest
rate.

So... why do bond prices go down when the Fed raises rates? Basically, when the Fed raises its policy rate, yields on a risk-free asset like U.S. Treasuries rise too, and every other borrower has to offer more to stay competitive (usually more than Treasuries, since they can't print their own money like the U.S. government can, so are by definition not as "risk-free"). 

If you have a bond (which is again really just a future payout of a specific amount of money), and you want to sell it, then the fair market price of your bond now depends on the (now higher) current going interest rate. This essentially just increases the slope on the curve below, which (as you can see when the slope increases while the future payout stays fixed) means the price you can sell your bond for today has to go down to match the new, higher interest rate.

TL;DR: the future payout never changes, so when rates rise, the same
future-dollars are worth fewer now-dollars. Drag the rate to see the effect on the plot.
</p>

<div class="bond-explainer tex2jax_ignore">
  <canvas id="bond-canvas" class="bond-canvas"
          aria-label="Chart of a bond's value over time: a curve grows from today's price up to a fixed future payout; raising the interest rate makes the curve steeper and lowers today's price."></canvas>

  <p class="bond-caption" id="bond-caption"></p>

  <div class="bond-controls">
    <div class="bond-modes" role="radiogroup" aria-label="Bond type">
      <label><input type="radio" name="bond-view" id="bond-view-single" checked> Single payout</label>
      <label><input type="radio" name="bond-view" id="bond-view-coupon"> Coupon bond</label>
    </div>

    <div class="bond-sliders">
      <label class="bond-slider">
        <span>Interest rate: <strong id="bond-rate-val" class="editable-val" data-range="bond-rate">3.0%</strong></span>
        <input id="bond-rate" type="range" min="0" max="12" step="0.1" value="3">
      </label>
      <label class="bond-slider">
        <span>Years to maturity: <strong id="bond-years-val" class="editable-val" data-range="bond-years">10</strong></span>
        <input id="bond-years" type="range" min="1" max="30" step="1" value="10">
      </label>
    </div>

    <div class="bond-coupon-controls" id="bond-coupon-controls" hidden>
      <div class="bond-sliders">
        <label class="bond-slider">
          <span>Face value: <strong id="bond-face-val" class="editable-val" data-range="bond-face">$1,000</strong></span>
          <input id="bond-face" type="range" min="100" max="10000" step="100" value="1000">
        </label>
        <label class="bond-slider">
          <span>Coupon rate: <strong id="bond-coupon-val" class="editable-val" data-range="bond-coupon">5.0%</strong></span>
          <input id="bond-coupon" type="range" min="0" max="12" step="0.1" value="5">
        </label>
      </div>
      <p class="bond-hint">In coupon mode: <strong>click a year</strong> to add a payout, click a payout to edit it (× or 0 deletes), and <strong>drag</strong> it to a different time. <strong>Click an x-axis year</strong> to anchor the timeline to a calendar date. &ldquo;Standard bond&rdquo; rebuilds the default.</p>
    </div>

    <label class="bond-check">
      <input id="bond-mode" type="checkbox"> More realistic (compound / exponential discounting)
    </label>

    <div class="bond-scenarios">
      <span class="bond-scenarios__label">Scenarios:</span>
      <button id="bond-raise" class="bond-btn" type="button">Fed raises rates &#9650;</button>
      <button id="bond-cut"   class="bond-btn" type="button">Fed cuts rates &#9660;</button>
      <button id="bond-clear" class="bond-btn" type="button" hidden>Standard bond</button>
      <button id="bond-reset" class="bond-btn" type="button">Reset</button>
    </div>
  </div>
</div>

<p class="bond-foot">
  Why "the payout is fixed but worth less"? Because the curve from <em>today's price</em> up to the
  <em>fixed future payout</em> is the interest rate compounding. A higher rate is a steeper curve &mdash;
  but it still has to land on the same fixed payout, so it must start lower. That lower starting point
  <em>is</em> the new, cheaper price. The same logic runs in reverse when the Fed cuts rates.
</p>

<style>
.bond-intro, .bond-foot { max-width: 760px; line-height: 1.65; }
.bond-intro { margin: 0.25rem 0 1.5rem; }
.bond-foot  { margin: 1.5rem 0 0; opacity: 0.92; }

.bond-explainer { max-width: 760px; margin: 0; }

.bond-canvas {
  width: 100%;
  height: 420px;
  display: block;
  touch-action: none;
}
.bond-explainer.coupon-mode .bond-canvas { cursor: pointer; }

.bond-caption {
  font-size: 1.02rem;
  line-height: 1.6;
  margin: 0.4rem 0 1.4rem;
  min-height: 3em;
}
.bond-caption strong { font-variant-numeric: tabular-nums; }
.bond-note { opacity: 0.7; font-size: 0.92em; }

.bond-modes { display: flex; flex-wrap: wrap; gap: 1.25rem; font-size: 0.95rem; }
.bond-modes label { display: inline-flex; align-items: center; gap: 0.4rem; cursor: pointer; }
.bond-modes input { accent-color: #82a6cc; }
.bond-coupon-controls { display: flex; flex-direction: column; gap: 0.6rem; }
.bond-coupon-controls[hidden] { display: none; }
.bond-hint { font-size: 0.88rem; opacity: 0.78; margin: 0; }
.bond-btn[hidden] { display: none; }
html[data-theme="light"] .bond-modes input { accent-color: #34568a; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .bond-modes input { accent-color: #34568a; } }

.bond-controls { display: flex; flex-direction: column; gap: 1rem; }
.bond-sliders { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem 1.5rem; }
@media (max-width: 560px) { .bond-sliders { grid-template-columns: 1fr; } }

.bond-slider { display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.95rem; }
.bond-slider strong { font-variant-numeric: tabular-nums; }
.bond-slider input[type="range"],
.bond-check input { accent-color: #82a6cc; }   /* dark default; light override below */

.bond-check { display: flex; align-items: center; gap: 0.5rem; font-size: 0.95rem; cursor: pointer; }

.bond-scenarios { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.bond-scenarios__label { font-size: 0.95rem; opacity: 0.85; }
.bond-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127, 127, 127, 0.4);
  background: rgba(127, 127, 127, 0.12);
  border-radius: 6px; padding: 0.5em 0.85em;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.bond-btn:hover { background: rgba(127, 127, 127, 0.24); }

/* Accent on form controls in light mode, in BOTH manual + auto contexts. */
html[data-theme="light"] .bond-slider input[type="range"],
html[data-theme="light"] .bond-check input { accent-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .bond-slider input[type="range"],
  html:not([data-theme="dark"]) .bond-check input { accent-color: #34568a; }
}

@media (max-width: 600px) { .bond-canvas { height: 340px; } }
</style>

<script defer src="{{ '/assets/js/canvas-edit.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/bonds.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/editable-values.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
