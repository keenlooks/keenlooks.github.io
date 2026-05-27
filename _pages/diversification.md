---
layout: single
title: "Diversification, low fees, and time equals free money"
permalink: /diversification/
author_profile: false
excerpt: "An interactive look at how holding many investments narrows the range of outcomes, cutting the worst cases while keeping most of the upside, and how fees skim off the top."
description: "Interactive diversification explainer by Keane Lucas using real 1995–2024 industry returns (Ken French Data Library): as you hold more industries, the spread of 10-year outcomes funnels inward — the worst cases disappear while the median holds — and a red line shows how much annual fees skim off."
---

<p class="div-intro">
Put all your money in one industry and 30 years later you might have <strong>50&times;</strong> &mdash; or
barely your money back. Spread it across <em>many</em> industries and the wild swings temper significantly. The chart below plays this out on real returns: it grows <strong>$10,000</strong> from
1995&ndash;2024. The faint grey band is the full range <em>any single industry</em> landed in. Drag the
slider to <strong>invest in more industries</strong>, and watch the bold line &mdash; your portfolio. The plot
keeps <strong>reshuffling which industries you hold</strong> every half-second, so you can feel
how much the outcome rides on luck when you hold a few, and how little when you hold many.
</p>

<div class="div-spread tex2jax_ignore">
  <canvas id="div-spread-canvas" class="div-spread-canvas"
          aria-label="Animated chart: the growth of $10,000 from 1995 to 2024 on a log scale. A grey band shows the full range any single industry landed in. A slider sets how many industries are blended equal-weight; the chart reshuffles which ones it holds every half-second. With more industries the blended line and the cloud of recent blends vary less."></canvas>

  <div class="div-spread-controls">
    <label class="div-slider"><span>Industries blended: <strong id="div-n-val" class="editable-val" data-range="div-n">3</strong></span>
      <input id="div-n" type="range" min="1" max="30" step="1" value="3"></label>
    <div class="div-buttons"><button id="div-spread-shuffle" class="div-btn" type="button">Shuffle</button></div>
  </div>
  <p class="div-note" id="div-spread-note"></p>
</div>

<p class="div-intro">
That shrinking cloud in the plot above is the the thing to look at, but can be hard to track with all the shuffling. The chart below
holds it still and charts it over different numbers of industries held. It shows the range of <strong>10-year</strong>
outcomes depending on how many industries are held (each size simulated over hundreds of random 10-year windows and industry picks). Notice how fast the bad outcomes become rare as you diversify over just a few industries, while the median (the middle line) barely budges. The red dashed line shows how significantly low-seeming (e.g., 1%) fees reduce the median outcome, which compounds over time and is the main reason why insisting on holding low-fee (e.g., 0.1%) index funds is important.
</p>

<div class="div-explainer tex2jax_ignore">
  <canvas id="div-canvas" class="div-canvas"
          aria-label="Chart: the spread of 10-year outcomes for a $10,000 investment, by number of industries held. As more industries are held the 5th-to-95th and 25th-to-75th percentile bands narrow toward the median, and a red dashed line shows the median outcome after annual fees."></canvas>

  <div class="div-legend">
    <span class="div-key div-key--b1">middle 90% of outcomes</span>
    <span class="div-key div-key--b2">middle 50%</span>
    <span class="div-key div-key--med">median</span>
    <span class="div-key div-key--fee">median after fees</span>
  </div>

  <div class="div-stats">
    <div class="div-stat"><span class="div-stat__num" id="div-gross">$0</span><span class="div-stat__lbl">typical (all 30)</span></div>
    <div class="div-stat"><span class="div-stat__num div-stat__net" id="div-net">$0</span><span class="div-stat__lbl">after fees</span></div>
    <div class="div-stat"><span class="div-stat__num div-stat__lost" id="div-lost">$0</span><span class="div-stat__lbl">lost to fees</span></div>
  </div>
  <p class="div-note" id="div-note"></p>

  <div class="div-controls">
    <label class="div-slider"><span>Annual fee (expense ratio): <strong id="div-fee-val" class="editable-val" data-range="div-fee">1.0%</strong></span>
      <input id="div-fee" type="range" min="0" max="2.5" step="0.1" value="1"></label>
    <div class="div-buttons">
      <button id="div-shuffle" class="div-btn" type="button">Reshuffle</button>
      <button id="div-reset" class="div-btn" type="button">Reset</button>
    </div>
  </div>
</div>

<p class="div-foot">
 <strong>Diversification</strong>: the spread shrinks fast at first &mdash;
  even a handful of industries removes most of the gut-wrenching downside &mdash; while the median
  barely moves, so you give up little expected return for a lot less risk. <strong>Fees</strong>: the
  red line sits below the median no matter how well you diversify, and the gap compounds over time.
  That gap is the core reason low-fee index funds are hard to beat after costs.
  <span class="div-src">Data: <a href="https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/data_library.html">Ken French Data Library</a>, 30 Industry Portfolios, 1995&ndash;2024. Illustrative; past performance isn't predictive.</span>
</p>

<style>
.div-intro, .div-foot { max-width: 760px; line-height: 1.65; }
.div-intro { margin: 0.25rem 0 1.25rem; }
.div-foot  { margin: 1.4rem 0 0; opacity: 0.92; }
.div-src { display: block; margin-top: 0.6rem; font-size: 0.85rem; opacity: 0.7; }
.div-explainer { max-width: 760px; }

.div-canvas { width: 100%; height: 420px; display: block; }
@media (max-width: 600px) { .div-canvas { height: 340px; } }

/* "blend the lines" intro plot */
.div-spread { max-width: 760px; margin: 0 0 1.6rem; }
.div-spread-canvas { width: 100%; height: 360px; display: block; }
@media (max-width: 600px) { .div-spread-canvas { height: 300px; } }
.div-spread-controls { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.8rem 1.2rem; margin: 0.7rem 0 0.2rem; }
.div-spread-controls .div-slider { flex: 1 1 260px; margin: 0; }
.div-spread .div-note { margin-bottom: 0; }

.div-legend { display: flex; flex-wrap: wrap; gap: 1.1rem; font-size: 0.85rem; opacity: 0.9; margin: 0.7rem 0 0.9rem; }
.div-key { display: inline-flex; align-items: center; gap: 0.4rem; }
.div-key::before { content: ""; width: 1rem; height: 0.8rem; border-radius: 2px; display: inline-block; }
.div-key--b1::before { background: rgba(130,166,204,0.30); }
.div-key--b2::before { background: rgba(130,166,204,0.6); }
.div-key--med::before { background: #82a6cc; height: 0; border-top: 3px solid #82a6cc; border-radius: 0; }
.div-key--fee::before { background: transparent; height: 0; border-top: 3px dashed #d98b76; border-radius: 0; }

.div-stats { display: flex; flex-wrap: wrap; gap: 1.5rem; margin: 0.25rem 0 0.6rem; }
.div-stat { display: flex; flex-direction: column; }
.div-stat__num { font-size: 1.4rem; font-weight: 700; font-variant-numeric: tabular-nums; color: #82a6cc; }
.div-stat__net { color: #d98b76; }
.div-stat__lost { color: #d98b76; }
.div-stat__lbl { font-size: 0.82rem; opacity: 0.75; }

.div-note { font-size: 0.98rem; line-height: 1.55; margin: 0 0 1.25rem; min-height: 1.4em; }

.div-controls { display: flex; flex-direction: column; gap: 0.9rem; }
.div-slider { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.95rem; max-width: 420px; }
.div-slider strong { font-variant-numeric: tabular-nums; }
.div-slider input[type="range"] { width: 100%; accent-color: #82a6cc; }
.div-buttons { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.div-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.12);
  border-radius: 6px; padding: 0.5em 0.85em; transition: background 0.15s ease, border-color 0.15s ease;
}
.div-btn:hover { background: rgba(127,127,127,0.24); }

/* Light-theme accents (manual + auto contexts) */
html[data-theme="light"] .div-stat__num,
html[data-theme="light"] .div-key--med::before { border-top-color: #34568a; }
html[data-theme="light"] .div-stat__num { color: #34568a; }
html[data-theme="light"] .div-stat__net,
html[data-theme="light"] .div-stat__lost { color: #b4452f; }
html[data-theme="light"] .div-key--med::before { background: #34568a; }
html[data-theme="light"] .div-key--fee::before { border-top-color: #b4452f; }
html[data-theme="light"] .div-slider input[type="range"] { accent-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .div-stat__num { color: #34568a; }
  html:not([data-theme="dark"]) .div-stat__net,
  html:not([data-theme="dark"]) .div-stat__lost { color: #b4452f; }
  html:not([data-theme="dark"]) .div-key--med::before { background: #34568a; border-top-color: #34568a; }
  html:not([data-theme="dark"]) .div-key--fee::before { border-top-color: #b4452f; }
  html:not([data-theme="dark"]) .div-slider input[type="range"] { accent-color: #34568a; }
}
</style>

<script defer src="{{ '/assets/js/diversification-data.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/diversification-spread.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/diversification.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/editable-values.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
