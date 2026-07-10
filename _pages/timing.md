---
layout: single
title: "Recovering a Secret From Timing Alone"
permalink: /timing/
author_profile: false
excerpt: "A timing-attack demo: recover a hidden token one character at a time, using nothing but how long a comparison takes."
description: "Interactive timing-attack demo by Keane Lucas: a hidden 8-character token is recovered one character at a time from response times alone against a naive character-by-character compare, while a constant-time compare leaks nothing. Explains why string comparison that bails at the first mismatch is dangerous, and why crypto libraries insist on constant-time primitives."
---

<p class="timing-intro">
When you check a password, an API key, or a message authentication code against a stored
secret, the obvious way to compare them is character by character, stopping at the first
character that differs. That shortcut leaks information. A guess that gets the first three
characters right takes very slightly longer to reject than one that misses immediately,
because the comparison runs three steps further before it gives up. Measure carefully enough
and that tiny difference lets an attacker recover the secret one character at a time, without
ever being told a single character of it.
</p>

<p class="timing-intro">
This page holds a random 8-character hex token that is generated in your browser and never
written into the text you can read. Pick a comparison function and press Attack. The naive
compare gives the token up from timing alone. The constant-time compare does not.
</p>

<div class="timing-explainer tex2jax_ignore">
  <canvas id="timing-canvas" class="timing-canvas"
          aria-label="Bar chart of the measured comparison time for each of the sixteen hex candidates at the current position; the correct character is the tallest bar when attacking the naive compare, and all bars stay level against the constant-time compare."></canvas>

  <div class="timing-controls">
    <label class="timing-field">
      <span>Compare function</span>
      <select id="timing-mode" class="timing-select">
        <option value="naive">Naive (stops at first mismatch)</option>
        <option value="constant">Constant-time (XOR the whole length)</option>
      </select>
    </label>
    <button id="timing-attack" class="timing-btn timing-btn--accent" type="button">Attack</button>
    <button id="timing-reset" class="timing-btn" type="button">New secret</button>
  </div>

  <p class="timing-recovered-line">
    Recovered so far: <span id="timing-recovered" class="timing-recovered" aria-label="recovered characters so far"></span>
  </p>

  <p id="timing-status" class="timing-status" role="status" aria-live="polite">Idle.</p>

  <div id="timing-log" class="timing-log" aria-hidden="true"></div>

  <details class="timing-reveal">
    <summary>Reveal the secret (for checking the result)</summary>
    <p>The hidden token is <code id="timing-secret" class="timing-secret">--------</code>. It changes every time you press &ldquo;New secret&rdquo;.</p>
  </details>
</div>

<h2>Why the naive compare leaks</h2>

<p class="timing-body">
The dangerous line is the early return: <code>if (guess[i] != secret[i]) return false</code>.
The loop does more work the more leading characters are correct, so the time it takes to say
&ldquo;no&rdquo; is a direct function of how much of the secret the guess already has. An attacker
fixes one position at a time: try all sixteen hex values, keep whichever is consistently the
slowest to be rejected, lock it in, and move to the next position. Sixteen values times eight
positions is a few hundred guesses, instead of the four billion a blind search would need.
</p>

<p class="timing-body">
This is not hypothetical. Token and HMAC comparisons have leaked this way for years, and the
Python Keyczar library once shipped a byte-by-byte signature check that let an attacker forge
valid signatures by measuring how long verification took, until it was replaced with a
constant-time comparison. The fix is exactly that: a comparison that always inspects every
byte and folds the differences together with XOR, so the running time no longer depends on
where the first mismatch is. This is why crypto libraries ship primitives like Python's
<code>hmac.compare_digest</code> and tell you to use them for anything secret.
</p>

<h2>About the amplification</h2>

<p class="timing-body">
A real server leaks at the scale of nanoseconds per character, far below what a browser clock
can resolve. Browsers deliberately blur <code>performance.now()</code> for exactly this reason,
to blunt attacks like this one. So this demo amplifies the effect: the naive compare does a
fixed chunk of arithmetic for every character that matches, which turns the same per-character
leak into something visible at millisecond scale. The shape of the attack is real and the
constant-time version genuinely closes it; only the size of the signal is exaggerated so you
can watch it happen in a few seconds.
</p>

<details class="timing-how">
  <summary>How the measurement works</summary>
  <p class="timing-body">
  Timing a single comparison is hopeless: it is faster than the clock can resolve, and any one
  reading is buried in noise from garbage collection, other tabs, and the operating system
  scheduler. So for each candidate character the attack runs the comparison many times in a
  tight batch and records the batch time. It repeats that for about a dozen passes, and it
  measures all sixteen candidates interleaved within each pass (reshuffling the order every
  time) so that any slow drift in CPU frequency or scheduling hits every candidate together
  and cancels out when they are compared. For each candidate it then keeps the average of its
  fastest passes, because a comparison can only be slowed down by interference and never sped
  up, so the fastest readings are the cleanest picture of the real work. The correct character
  is the one whose fastest time is reliably the highest. If no candidate leads the pack by a
  clear margin after two rounds, the attack reports that there is no signal and stops.
  </p>
  <p class="timing-body">
  Browser timer clamping is why this is harder now than it was around 2015, when
  <code>performance.now()</code> still had microsecond resolution and these attacks were a live
  concern for the web. The amplification here stands in for that lost resolution. If you switch
  tabs mid-attack the measurement pauses on purpose, because background timers are throttled
  and would corrupt the samples.
  </p>
</details>

<style>
/* An explainer, but the chart and log want a little more room than the reading column. */
#main { max-width: 960px; }
.page__inner-wrap, .page__content { max-width: 100%; }
.timing-intro, .timing-body { max-width: 70ch; line-height: 1.65; }
.timing-intro { margin: 0.25rem 0 1.1rem; }
.timing-explainer { max-width: 900px; margin: 1.5rem 0; }

.timing-canvas { width: 100%; height: 340px; display: block; touch-action: none; }
@media (max-width: 600px) { .timing-canvas { height: 300px; } }

.timing-controls { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.75rem; margin: 1rem 0 0.9rem; }
.timing-field { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.9rem; }
.timing-field > span { opacity: 0.85; }

/* Selects render washed-out under the theme; force high-contrast colors per theme. */
.timing-select {
  font: inherit; padding: 0.45em 0.6em; border-radius: 6px;
  border: 1px solid rgba(127,127,127,0.45);
  background: #1d1d1d; color: #e8e8e8;
}
.timing-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.12);
  border-radius: 6px; padding: 0.55em 1em; transition: background 0.15s ease, border-color 0.15s ease;
}
.timing-btn:hover { background: rgba(127,127,127,0.24); }
.timing-btn:disabled { opacity: 0.5; cursor: default; }
.timing-btn--accent { background: #82a6cc; border-color: #82a6cc; color: #10151b; }
.timing-btn--accent:hover { background: #a3c2e0; border-color: #a3c2e0; }

.timing-recovered-line { font-size: 1rem; margin: 0.2rem 0 0.4rem; }
.timing-recovered { display: inline-flex; gap: 0.15rem; margin-left: 0.35rem; vertical-align: middle; }
.timing-char {
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 1.25rem; min-width: 1ch; text-align: center; opacity: 0.45;
  border-bottom: 2px solid rgba(127,127,127,0.35);
}
.timing-char--got { opacity: 1; color: #82a6cc; border-bottom-color: #82a6cc; }

.timing-status { font-size: 0.92rem; opacity: 0.85; min-height: 1.4em; margin: 0.1rem 0 0.6rem; font-variant-numeric: tabular-nums; }

.timing-log {
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 0.82rem; line-height: 1.5;
  max-height: 150px; overflow-y: auto;
  border: 1px solid rgba(127,127,127,0.28); border-radius: 6px;
  background: rgba(127,127,127,0.06); padding: 0.55rem 0.7rem;
}
.timing-log:empty { display: none; }
.timing-log__line { white-space: pre-wrap; }

.timing-reveal, .timing-how { margin: 0.9rem 0; }
.timing-reveal summary, .timing-how summary { cursor: pointer; font-size: 0.92rem; opacity: 0.9; }
.timing-secret { font-size: 1.05em; letter-spacing: 0.08em; }

/* Light theme (manual + auto contexts). */
html[data-theme="light"] .timing-select { background: #ffffff; color: #262626; }
html[data-theme="light"] .timing-btn--accent { background: #34568a; border-color: #34568a; color: #ffffff; }
html[data-theme="light"] .timing-btn--accent:hover { background: #25406b; border-color: #25406b; }
html[data-theme="light"] .timing-char--got { color: #34568a; border-bottom-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .timing-select { background: #ffffff; color: #262626; }
  html:not([data-theme="dark"]) .timing-btn--accent { background: #34568a; border-color: #34568a; color: #ffffff; }
  html:not([data-theme="dark"]) .timing-btn--accent:hover { background: #25406b; border-color: #25406b; }
  html:not([data-theme="dark"]) .timing-char--got { color: #34568a; border-bottom-color: #34568a; }
}
</style>

<script defer src="{{ '/assets/js/timing.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
