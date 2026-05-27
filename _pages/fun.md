---
layout: single
title: "Fun"
permalink: /fun/
author_profile: false
excerpt: "A small, growing collection of interactive things I've built for fun."
description: "Interactive visualizations and toys by Keane Lucas — visual explainers and playgrounds, starting with Conway's Game of Life."
---

<p class="xp-intro">
Some fun, sometimes interactive, things built either for interest or to help understand them better.
</p>

<div class="xp-grid">

  <a class="xp-card" href="{{ base_path }}/life/">
    <div class="xp-card__art" aria-hidden="true">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><rect x="9" y="2" width="6" height="6" rx="1"></rect><rect x="16" y="9" width="6" height="6" rx="1"></rect><rect x="2" y="16" width="6" height="6" rx="1"></rect><rect x="9" y="16" width="6" height="6" rx="1"></rect><rect x="16" y="16" width="6" height="6" rx="1"></rect></svg>
    </div>
    <div class="xp-card__body">
      <h2 class="xp-card__title">Conway's Game of Life</h2>
      <p class="xp-card__desc">A full-screen cellular automaton you can draw on. Change the speed, zoom, and birth/survival rules, or drop in presets.</p>
    </div>
  </a>

  <a class="xp-card" href="{{ base_path }}/bonds/">
    <div class="xp-card__art" aria-hidden="true">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"></path><path d="M6 15c3-1 5.5-6.5 9-9"></path><circle cx="15" cy="6" r="1.6" fill="currentColor" stroke="none"></circle></svg>
    </div>
    <div class="xp-card__body">
      <h2 class="xp-card__title">Bonds &amp; Interest Rates</h2>
      <p class="xp-card__desc">Why a bond's price falls when rates rise. Drag the interest rate and watch today's price move against a fixed future payout.</p>
    </div>
  </a>

  <a class="xp-card" href="{{ base_path }}/loans/">
    <div class="xp-card__art" aria-hidden="true">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="6" width="3.5" height="15" rx="1"></rect><rect x="8.5" y="9.5" width="3.5" height="11.5" rx="1"></rect><rect x="14" y="13" width="3.5" height="8" rx="1"></rect><rect x="19.5" y="16.5" width="3.5" height="4.5" rx="1"></rect></svg>
    </div>
    <div class="xp-card__body">
      <h2 class="xp-card__title">Where Loan Payments Go</h2>
      <p class="xp-card__desc">How each payment splits between interest and principal &mdash; and how paying a little extra, sooner, saves a lot.</p>
    </div>
  </a>

  <a class="xp-card" href="{{ base_path }}/diversification/">
    <div class="xp-card__art" aria-hidden="true">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3 L21 11.4"></path><path d="M3 21 L21 12.6"></path><path d="M3 12 L21 12" stroke-opacity="0.45"></path></svg>
    </div>
    <div class="xp-card__body">
      <h2 class="xp-card__title">Diversification &amp; Risk</h2>
      <p class="xp-card__desc">Why holding many investments narrows the range of outcomes while keeping most of the upside &mdash; and how fees skim the top. Real 1995&ndash;2024 data.</p>
    </div>
  </a>

  <a class="xp-card" href="{{ base_path }}/gravity/">
    <div class="xp-card__art" aria-hidden="true">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"></circle><ellipse cx="12" cy="12" rx="9.5" ry="4.6" transform="rotate(-22 12 12)"></ellipse><circle cx="20" cy="8.4" r="1.7" fill="currentColor" stroke="none"></circle></svg>
    </div>
    <div class="xp-card__body">
      <h2 class="xp-card__title">Gravity Sandbox</h2>
      <p class="xp-card__desc">Fling masses into orbit and watch Newtonian gravity do its thing &mdash; they attract, merge, and trace long orbits. Spin up a whole accretion disk and watch it coalesce.</p>
    </div>
  </a>

  <a class="xp-card" href="{{ base_path }}/magnets/">
    <div class="xp-card__art" aria-hidden="true">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3 H4 v7 a8 8 0 0 0 16 0 V3 h-3 v7 a5 5 0 0 1 -10 0 Z"></path><path d="M4 6.5 H7"></path><path d="M17 6.5 H20"></path></svg>
    </div>
    <div class="xp-card__body">
      <h2 class="xp-card__title">Magnetic Field</h2>
      <p class="xp-card__desc">Drop bar magnets and watch their field lines weave together. Drag and spin them; opposite poles snap into a stronger magnet, like poles shove apart.</p>
    </div>
  </a>

</div>

<style>
.xp-intro { max-width: 60ch; margin: 0.25rem 0 2rem; opacity: 0.9; }

.xp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 1.25rem;
  margin: 1.5rem 0 3rem;
}

/* Cards use neutral translucent fills so they read on both themes; the accent
   (dual-context below) only appears on hover/focus. */
/* `.xp-grid .xp-card` (0,2,0) intentionally out-specifies the theme's
   `.page__content a` (0,1,1) so card text stays body-colored, not link-colored. */
.xp-grid .xp-card {
  display: flex;
  flex-direction: column;
  color: inherit;
  text-decoration: none !important;
  border: 1px solid rgba(127, 127, 127, 0.28);
  border-radius: 12px;
  background: rgba(127, 127, 127, 0.06);
  overflow: hidden;
  transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
}
.xp-grid .xp-card:hover,
.xp-grid .xp-card:focus-visible {
  color: inherit;
  transform: translateY(-3px);
  border-color: #82a6cc;                 /* dark-theme accent */
  background: rgba(130, 166, 204, 0.10);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
  outline: none;
}

.xp-card__art {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 120px;
  color: inherit;
  opacity: 0.8;
  background: rgba(127, 127, 127, 0.08);
  border-bottom: 1px solid rgba(127, 127, 127, 0.18);
}
.xp-card__art svg { width: 58px; height: 58px; display: block; }
.xp-card:hover .xp-card__art { opacity: 1; }

.xp-card__body { padding: 1rem 1.1rem 1.2rem; }
.xp-card__title { margin: 0 0 0.35rem; font-size: 1.15rem; font-weight: 700; line-height: 1.25; }
.xp-card__desc { margin: 0; font-size: 0.92rem; line-height: 1.5; opacity: 0.82; }

/* Light-theme accent on hover, applied in BOTH the manual and auto contexts. */
html[data-theme="light"] .xp-card:hover,
html[data-theme="light"] .xp-card:focus-visible {
  border-color: #34568a;
  background: rgba(52, 86, 138, 0.08);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .xp-card:hover,
  html:not([data-theme="dark"]) .xp-card:focus-visible {
    border-color: #34568a;
    background: rgba(52, 86, 138, 0.08);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  }
}
</style>
