---
layout: single
title: "Mission to Anywhere"
permalink: /voyage/
author_profile: false
excerpt: "Pick any planet or any real star in the sky, and see what the trip honestly takes, including what relativity does to the clocks."
description: "An interactive full-screen trip planner by Keane Lucas: real JPL planet positions and porkchop transfer windows, a real star catalog with true positions and colors, exoplanets from NASA's archive, and honest relativistic travel times, energy costs and clocks for a constant-acceleration starship."
---

<div class="voy-app life-app">
<script>/* This page defaults to dark because the sky reads better that way. An
   explicit visitor choice, saved by the site toggle under localStorage key
   'theme', still wins. Block comments only: the production build strips
   newlines and a line comment would eat the rest of the script. */
(function(){try{if(!localStorage.getItem('theme')){document.documentElement.setAttribute('data-theme','dark');}}catch(e){}})();</script>
  <div class="voy-topfade" aria-hidden="true"></div>
  <canvas id="voy-canvas" class="voy-canvas"
          aria-label="A 3D view of the solar system and the real night sky. Planets sit on their true orbits for today, and every star is a real star at its true position and color. Tap a planet or a star, or use the search box, to plan a trip to it."></canvas>

  <div class="voy-panel" id="voy-panel">
    <div class="voy-panel__head">
      <span class="voy-panel__title">Mission to Anywhere</span>
      <button id="voy-help" class="gadget-help" type="button" aria-label="Show hint" title="Show hint">?</button>
      <button id="voy-collapse" class="voy-collapse" type="button" aria-label="Hide / show controls" title="Hide / show controls">&ndash;</button>
    </div>
    <div class="voy-panel__body" id="voy-panel-body">
      <p class="voy-blurb">
        The planets here sit where they really are today, and every star is a real star
        from the AT-HYG catalog, in its true position, distance and color. Pick a destination
        by tapping it or searching for it: planets get a real transfer-orbit map, stars get
        the honest relativity of a constant-acceleration ship. Nobody knows how to build
        that ship, and the numbers show why. Somewhere out there your ship is waiting in
        orbit.
      </p>

      <div class="voy-search-wrap">
        <label class="voy-search-label" for="voy-search">Where do you want to go?</label>
        <input id="voy-search" class="voy-search" type="text"
               role="combobox" aria-expanded="false" aria-controls="voy-search-list"
               aria-autocomplete="list" autocomplete="off" spellcheck="false"
               placeholder="Mars, Sirius, TRAPPIST-1 e &hellip;">
        <ul id="voy-search-list" class="voy-search-list" role="listbox"
            aria-label="Search results" hidden></ul>
        <button id="voy-surprise" class="voy-btn voy-surprise" type="button"
                aria-haspopup="menu" aria-expanded="false"
                aria-controls="voy-surprise-list">Surprise me</button>
        <ul id="voy-surprise-list" class="voy-search-list voy-surprise-list"
            role="menu" aria-label="Surprise me" hidden></ul>
      </div>

      <p class="voy-target-line" id="voy-target"></p>
      <p class="voy-legend">Earth is blue; your destination turns gold.</p>

      <div class="voy-row" id="voy-pc-row" hidden>
        <button id="voy-launch" class="voy-btn" type="button">Launch</button>
        <button id="voy-next" class="voy-btn" type="button">Next window</button>
        <button id="voy-back" class="voy-btn" type="button">Back to the sky</button>
      </div>

      <div class="voy-row">
        <button id="voy-share" class="voy-btn" type="button">Share link</button>
        <button id="voy-save" class="voy-btn" type="button">Save image</button>
      </div>

      <details class="voy-details" id="voy-window-details" hidden>
        <summary id="voy-window-sum">Why do the windows repeat?</summary>
        <p id="voy-window-text"></p>
      </details>

      <details class="voy-details">
        <summary>How honest is this?</summary>
        <p>
          Planet positions come from JPL's published orbital elements and are right for
          today's date. Star positions, distances and colors are real, from the AT-HYG
          catalog, and the exoplanets are real discoveries from NASA's archive. The
          transfer orbits and the relativity math are the true equations, but the galaxy
          backdrop is an illustration, exoplanet positions along their orbits are not
          known, and nobody knows how to build a ship that holds a steady push
          like this for years.
          Star sizes on screen show brightness, not true size.
        </p>
        <p>
          About 110,000 real stars are charted here; 10,000 of them are clickable, along
          with a few hundred named objects far across the galaxy. As you pull back the
          faintest of them thin out so the view stays smooth, and they come back as you
          zoom in. Star
          close-ups are procedural art driven by each star's real temperature, size and
          type; the flares and the surface detail are typical for the type, not
          observations. The eight planets of our own system are drawn the same way, as
          likenesses of worlds we do have real pictures of. Every exoplanet
          orb is an impression drawn from its measured size and temperature, and nobody
          has seen any of them up close. In the cockpit view the dust streaks are
          invented motes, but the way the stars crowd forward and shift color is the
          real aberration and Doppler math at the speed shown on the HUD.
        </p>
        <p>
          The galaxy itself is a painting. Its shape, its size and the Sun's place in it
          are real, but nobody has ever seen our galaxy from the outside. The stars drawn
          on top of it, about 110,000 of them, are real stars at their real measured
          positions, and almost all of them are within a few thousand light years. The
          handful of objects farther out are the ones astronomers have individual
          distances for.
        </p>
        <p>
          A few thousand light years from home the map thins out. That is not because the
          stars end. Dust between us blocks the view, and the simple one-over-parallax
          distances in this catalog stretch by five to fifteen percent out there, and by
          much more beyond that. What is charted individually on the far side is a few
          hundred beacons: pulsating stars measured in the infrared, and gas clouds
          measured by radio telescopes linked across the planet. Those are the ones you
          can visit here. The ordinary stars over there are not on anybody's map with a
          distance you could fly to.
        </p>
        <p>
          Those far objects are drawn as markers, never as discs. A globular cluster is a
          swarm because that is what it is, the Magellanic Clouds are soft patches whose
          shape is an impression, and the black hole at the center of the galaxy is drawn
          as the sky bent around it, because it has no surface of its own. None of them
          carry a temperature, a size or a color here, because nobody measured one.
        </p>
        <p>
          Up close at Sagittarius A*, the stars circling it are on their published orbits
          and at their measured positions for today, which is the one place on this page
          where where a body sits on its orbit is a measurement rather than an
          illustration. The bending of light around it is computed from the real geodesics
          for a non-spinning hole of that mass, but the marker is drawn at a fixed size on
          screen: from the parking distance the shadow itself would be far smaller than
          one pixel. Some more of the honest small print for that place:
        </p>
        <p>
          The glow around the real Sgr A* is famously faint; it shines at less than one
          hundred-millionth of what a black hole its size could. We draw it faint. The
          brighten switch is for drama and says so.
        </p>
        <p>
          The famous orange ring photo is radio light, not what eyes would see.
        </p>
        <p>
          Nobody knows how fast it spins; the two best methods disagree. We draw the
          non-spinning case.
        </p>
        <p>
          The background sky here is our own star catalog. The real view from the galactic
          center would blaze with millions of bulge stars nobody has catalogued for us.
          The soft glow standing in for them is an illustration, like the painted galaxy:
          it is brightest along the real plane of the galaxy, but not one point of light
          in it was measured.
        </p>
        <p>
          The two teams that weigh this black hole disagree by about seven percent. We use
          the newer interferometer number.
        </p>
        <p>
          The background star tier is a separate file of up to 100,000 stars, about
          1.07 MB on disk after base64, loaded only after the page has drawn its first
          frame. If it never arrives the map still works.
        </p>
        <p>
          The four-point crosses on the brightest stars are a camera effect. Real
          starlight has no spikes.
        </p>
      </details>

      <p class="voy-status-line"><span id="voy-status"></span></p>
      <p class="voy-credit">
        Star data from the AT-HYG catalog v4.0 (astronexus.com, CC BY-SA 4.0), modified.
        Far-side beacons from Skowron and colleagues 2024 and Reid and colleagues 2019;
        Sagittarius A* from the GRAVITY Collaboration 2021; cluster distances from
        Baumgardt and Vasiliev 2021; the Magellanic Clouds from Pietrzynski and colleagues
        2019 and Graczyk and colleagues 2020. Planets and exoplanets from NASA. All code
        original.
      </p>
      <p class="voy-verify" id="voy-verify"></p>
    </div>
  </div>

  <button id="voy-return" class="voy-return" type="button" aria-pressed="false"
          hidden>Return to ship</button>

  <div class="voy-fpbar" id="voy-fp" hidden>
    <div class="voy-seg" role="group" aria-label="Cruise view">
      <button id="voy-fp-chase" class="voy-seg__btn voy-seg__btn--on" type="button" aria-pressed="true">Chase</button>
      <button id="voy-fp-cockpit" class="voy-seg__btn" type="button" aria-pressed="false">Cockpit</button>
      <button id="voy-fp-map" class="voy-seg__btn" type="button" aria-pressed="false" hidden>Map</button>
      <button id="voy-glow" class="voy-seg__btn" type="button" aria-pressed="false"
              title="Brighten the glow (drama, not measurement)" hidden>Glow</button>
      <button id="voy-fp-info" class="voy-seg__btn" type="button" style="flex:0 0 34px"
              aria-label="Replay what is happening" title="Replay what is happening">&#9432;</button>
    </div>
    <div class="voy-tsrow" id="voy-ts-row">
      <span class="voy-tsrow__lab">Slower</span>
      <input id="voy-ts" class="voy-tsrow__range" type="range" min="0.4" max="2.5" step="0.05"
             value="1" aria-label="How fast the flight plays">
      <span class="voy-tsrow__lab">Faster</span>
      <span class="voy-tsrow__out" id="voy-ts-out">45 s</span>
    </div>
  </div>

  <p id="voy-cap-sr" role="status" aria-live="polite"
     style="position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;"></p>

  <div id="voy-card" class="voy-card" role="region" aria-label="About the selected body" hidden></div>
</div>

<style>
/* Full-screen takeover: hide the normal page chrome, let the fixed canvas own the
   viewport. (These rules only load on /voyage/.) */
.page__title, .page__meta, .page__footer { display: none !important; }
.page__content { pointer-events: none; }
.voy-canvas, .voy-panel, .voy-card, .voy-fpbar { pointer-events: auto; }

.masthead { background: transparent !important; border-bottom: 0 !important; }
.greedy-nav { background: transparent !important; }
.voy-topfade {
  position: fixed; top: 0; left: 0; right: 0; height: 120px;
  z-index: 10; pointer-events: none;
  background: linear-gradient(to bottom,
    rgba(14,16,20,0.96) 0%, rgba(14,16,20,0.82) 32%, rgba(14,16,20,0) 100%);
}
html[data-theme="light"] .voy-topfade {
  background: linear-gradient(to bottom,
    rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-topfade {
    background: linear-gradient(to bottom,
      rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
  }
}

/* ---- the DARK SPACE WINDOW (wave-5 round 5, ruling R7 option B) ----
   In light theme voyage.js keeps painting the sky with the DARK palette
   (space is black; a photograph of the galaxy does not invert), and marks the
   body `.voy-darksky`. Everything in a panel or a card stays light-theme and
   needs nothing here. What DOES need re-inking is the chrome that sits
   directly on the sky with no background of its own: the masthead links, the
   top vignette, and the two floating corner buttons. Without these three
   blocks they are the light theme's near-black ink on a near-black sky.
   Scoped to this page and to light theme only; the dark theme never gets the
   class, so nothing below can affect it. */
body.voy-darksky .voy-topfade {
  background: linear-gradient(to bottom,
    rgba(14,16,20,0.96) 0%, rgba(14,16,20,0.82) 32%, rgba(14,16,20,0) 100%);
}
body.voy-darksky .greedy-nav .visible-links a { color: #d6d6d6; }
body.voy-darksky .greedy-nav .visible-links a:hover { color: #a3c2e0; }
body.voy-darksky .greedy-nav .visible-links a:before { background: #82a6cc; }
body.voy-darksky .greedy-nav button { background-color: #82a6cc; }
body.voy-darksky #theme-toggle,
body.voy-darksky #life-link {
  color: #d6d6d6;
  border-color: rgba(255,255,255,0.22);
  background: rgba(255,255,255,0.10);
  box-shadow: none;
}
body.voy-darksky #theme-toggle:focus-visible,
body.voy-darksky #life-link:focus-visible,
body.voy-darksky .greedy-nav .visible-links a:focus-visible { outline-color: #82a6cc; }

.voy-canvas {
  position: fixed; inset: 0; width: 100vw; height: 100vh; height: 100dvh;
  z-index: 0; background: transparent;
  touch-action: none;
}

.voy-panel {
  position: fixed; top: 4.6rem; right: 1rem; z-index: 30;
  /* The bottom edge has to clear the chat bar (a fixed ~48 px bottom-right bar
     on desktop, full width on phones) and, on phones, the raised corner
     buttons. At the old 6rem cap the last line of the panel sat behind them. */
  width: 300px; max-width: calc(100vw - 2rem); max-height: calc(100vh - 10rem); max-height: calc(100dvh - 10rem);
  overflow: auto; padding: 0.85rem 1rem 1rem;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
  background: rgba(18,18,18,0.94);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  box-shadow: 0 6px 24px rgba(0,0,0,0.35); font-size: 0.92em;
}
html[data-theme="light"] .voy-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-panel { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
}

/* ---- scroll cues for the two scrolling surfaces (the panel and the card) ----
   Both are capped by a max-height and both scroll, and neither said so. On a
   1280x720 laptop the panel holds about 1,230 px of content in a 540 px
   window, the browser's overlay scrollbar fades itself out, and the controls
   below the fold simply looked missing. Two cues, both pure CSS:
     1. a thin scrollbar that stays drawn while the surface is scrollable, and
     2. a soft fade over the bottom edge.
   The fade is a sticky pseudo-element whose opacity is driven by a SCROLL
   timeline, which is what lets one rule serve both surfaces: it is off when
   the surface fits (a three-line card gets no veil over its buttons), it
   rides the scroll while there is more below, and it fades out as you reach
   the end. Its negative bottom margin means it adds no height. A browser
   without scroll timelines drops the animation, the pseudo-element stays at
   its base opacity of 0, and the scrollbar carries the cue on its own. */
/* Chrome and Safari: styling ::-webkit-scrollbar opts the surface OUT of the
   auto-hiding overlay scrollbar, which is the point. The overlay one is
   invisible until you are already scrolling, so it cannot tell you there is
   anything below. Only for fine pointers: on a phone the overlay scrollbar is
   the platform norm and the fade carries the cue on its own. Engines without
   the pseudo (Firefox) get the standard properties instead; setting those in
   Chrome would put the overlay scrollbar back. */
@media (pointer: fine) {
  .voy-panel::-webkit-scrollbar, .voy-card::-webkit-scrollbar { width: 9px; }
  .voy-panel::-webkit-scrollbar-track, .voy-card::-webkit-scrollbar-track { background: transparent; }
  .voy-panel::-webkit-scrollbar-thumb, .voy-card::-webkit-scrollbar-thumb {
    background: rgba(255,255,255,0.26); border-radius: 5px;
  }
  .voy-panel:hover::-webkit-scrollbar-thumb, .voy-card:hover::-webkit-scrollbar-thumb,
  .voy-panel:focus-within::-webkit-scrollbar-thumb, .voy-card:focus-within::-webkit-scrollbar-thumb {
    background: rgba(255,255,255,0.46);
  }
}
@supports not selector(::-webkit-scrollbar) {
  .voy-panel, .voy-card {
    scrollbar-width: thin;
    scrollbar-color: rgba(255,255,255,0.30) transparent;
  }
}
@keyframes voy-scrollcue { from { opacity: 1; } to { opacity: 0; } }
/* ---- E-2: the cue is a hint, not a shutter ----
   At 1440x900 the panel scrolls by only about 20 px before Share link and Save
   image sit squarely under the strip, and at the strength it started with they
   measured 1.8:1 in dark and 1.5:1 in light. That does not read as "there is
   more below", it reads as "these buttons are disabled". Two changes keep the
   cue and give the text back:
     - the band is 1.55rem instead of 2rem, and
     - the peak is capped where a control under it still clears 4.5:1
       (measured, every scroll position, both themes).
   The light branch also stops fading to WHITE. A white veil on a white panel
   pulls the ink up toward the plate, which is the one direction that destroys
   contrast; a soft shadow dims both together and reads as the same affordance.
   The scrollbar above carries the rest of the message either way. */
.voy-panel::after, .voy-card::after {
  content: ''; display: block; pointer-events: none;
  position: sticky; bottom: 0; height: 1.55rem;
  /* The negative TOP margin is load-bearing, and it must match the height: a
     scroll container's scrollable area counts a descendant's border box, and a
     negative BOTTOM margin does not take it back, so hanging the strip off the
     end added about 20 px of phantom scroll to every surface, which in turn
     switched the cue on over cards that fit. Overlapping the last 1.55rem of
     content instead leaves the scroll range byte for byte what it was
     (measured, both spellings side by side), and the strip is only ever
     painted when there is more below. */
  margin: -1.55rem -1rem 0;
  background: linear-gradient(to bottom, rgba(12,12,12,0), rgba(12,12,12,0.40));
  opacity: 0;
  /* longhands, and `nearest`, on purpose. The `animation` shorthand resets
     animation-timeline, and `scroll(self)` resolves against the PSEUDO
     element, which is not a scroll container, so that spelling silently
     leaves the cue at its base opacity (measured in Chrome, both spellings
     side by side). `nearest` is the surface itself. */
  animation-name: voy-scrollcue;
  animation-duration: auto;
  animation-timing-function: linear;
  animation-fill-mode: both;
  animation-timeline: scroll(nearest block);
  animation-range: calc(100% - 2.5rem) 100%;
}
/* collapsed, there is nothing to scroll and nothing to fade */
.voy-panel--collapsed::after { display: none; }
/* The panel and the card keep their light-theme surface even here, where the
   sky stays dark, so both cues re-ink with them. The scrollbar colours stay
   inside the same two branches as above: a `scrollbar-color` outside the
   @supports branch would hand Chrome its overlay scrollbar back. */
html[data-theme="light"] .voy-panel::after, html[data-theme="light"] .voy-card::after {
  background: linear-gradient(to bottom, rgba(30,32,38,0), rgba(30,32,38,0.30));
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-panel::after,
  html:not([data-theme="dark"]) .voy-card::after {
    background: linear-gradient(to bottom, rgba(30,32,38,0), rgba(30,32,38,0.30));
  }
}
@media (pointer: fine) {
  html[data-theme="light"] .voy-panel::-webkit-scrollbar-thumb,
  html[data-theme="light"] .voy-card::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.24); }
  html[data-theme="light"] .voy-panel:hover::-webkit-scrollbar-thumb,
  html[data-theme="light"] .voy-card:hover::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.44); }
}
@media (pointer: fine) and (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-panel::-webkit-scrollbar-thumb,
  html:not([data-theme="dark"]) .voy-card::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.24); }
  html:not([data-theme="dark"]) .voy-panel:hover::-webkit-scrollbar-thumb,
  html:not([data-theme="dark"]) .voy-card:hover::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.44); }
}
@supports not selector(::-webkit-scrollbar) {
  html[data-theme="light"] .voy-panel, html[data-theme="light"] .voy-card {
    scrollbar-color: rgba(0,0,0,0.28) transparent;
  }
}
@supports not selector(::-webkit-scrollbar) {
  @media (prefers-color-scheme: light) {
    html:not([data-theme="dark"]) .voy-panel, html:not([data-theme="dark"]) .voy-card {
      scrollbar-color: rgba(0,0,0,0.28) transparent;
    }
  }
}

.voy-panel__head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.voy-panel__title { font-weight: 700; font-size: 1.05em; }
.voy-collapse {
  font: inherit; line-height: 1; cursor: pointer; color: inherit;
  width: 1.8em; height: 1.8em; padding: 0;
  border: 1px solid rgba(127,127,127,0.4); border-radius: 6px; background: rgba(127,127,127,0.12);
}
.voy-panel--collapsed .voy-panel__body { display: none; }
.voy-panel__body { display: flex; flex-direction: column; gap: 0.8rem; margin-top: 0.7rem; }
.voy-blurb { margin: 0; font-size: 0.9em; opacity: 0.85; line-height: 1.5; }

/* search combobox: the list is IN FLOW inside the scrolling panel body */
.voy-search-wrap { display: flex; flex-direction: column; gap: 0.3rem; }
.voy-search-label { font-size: 0.9em; font-weight: 600; }
.voy-search {
  font: inherit; width: 100%; padding: 0.4em 0.55em;
  font-size: 16px; /* under 16px iOS zooms the whole page on focus */
  border-radius: 6px; border: 1px solid rgba(127,127,127,0.5);
  background: #1d2126; color: #d6d6d6;
}
.voy-search::placeholder { color: rgba(214,214,214,0.45); }
html[data-theme="light"] .voy-search { background: #ffffff; color: #262626; border-color: rgba(0,0,0,0.35); }
html[data-theme="light"] .voy-search::placeholder { color: rgba(38,38,38,0.4); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-search { background: #ffffff; color: #262626; border-color: rgba(0,0,0,0.35); }
  html:not([data-theme="dark"]) .voy-search::placeholder { color: rgba(38,38,38,0.4); }
}
.voy-search-list {
  list-style: none; margin: 0; padding: 0;
  border: 1px solid rgba(127,127,127,0.35); border-radius: 6px; overflow: hidden;
}
.voy-search-list[hidden] { display: none !important; }
.voy-search__opt {
  display: flex; justify-content: space-between; align-items: baseline; gap: 0.6rem;
  padding: 0.35em 0.55em; cursor: pointer; font-size: 0.92em;
}
.voy-search__opt + .voy-search__opt { border-top: 1px solid rgba(127,127,127,0.18); }
.voy-search__opt:hover, .voy-search__opt--hi { background: rgba(130,166,204,0.18); }
html[data-theme="light"] .voy-search__opt:hover, html[data-theme="light"] .voy-search__opt--hi { background: rgba(52,86,138,0.14); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-search__opt:hover,
  html:not([data-theme="dark"]) .voy-search__opt--hi { background: rgba(52,86,138,0.14); }
}
.voy-search__kind { font-size: 0.82em; opacity: 0.55; white-space: nowrap; }

/* "Surprise me" and its in-flow menu. The panel is overflow:auto with a
   max-height, so this list stays IN FLOW under its own button, exactly like
   the search results above it. */
.voy-surprise { align-self: flex-start; margin-top: 0.15rem; }
.voy-surprise-list { margin-top: 0.3rem; }
.voy-surprise__opt { padding: 0; display: block; }
.voy-surprise__btn {
  display: block; width: 100%; text-align: left; background: none; border: 0;
  color: inherit; font: inherit; font-size: 0.92em; cursor: pointer;
  padding: 0.45em 0.6em;
}
.voy-surprise__btn:hover, .voy-surprise__btn:focus-visible {
  background: rgba(130,166,204,0.18);
}
html[data-theme="light"] .voy-surprise__btn:hover,
html[data-theme="light"] .voy-surprise__btn:focus-visible { background: rgba(52,86,138,0.14); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-surprise__btn:hover,
  html:not([data-theme="dark"]) .voy-surprise__btn:focus-visible { background: rgba(52,86,138,0.14); }
}

/* The Return-to-ship chip. Bottom-left is #theme-toggle / #voy-back and the
   top-left corner is the masthead over a 120 px vignette, so it sits just
   below the vignette. */
.voy-return {
  position: fixed; top: 132px; left: 12px; z-index: 12;
  pointer-events: auto;
  padding: 0.38em 0.75em; font-size: 0.86em; line-height: 1.2;
  border-radius: 999px; cursor: pointer;
  background: rgba(255,255,255,0.10); color: inherit;
  border: 1px solid rgba(127,127,127,0.45);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  opacity: 0.85;
}
.voy-return:hover, .voy-return:focus-visible { opacity: 1; }
.voy-return[hidden] { display: none !important; }
html[data-theme="light"] .voy-return { background: rgba(0,0,0,0.04); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-return { background: rgba(0,0,0,0.04); }
}
/* This chip sits ON the sky, which stays dark in light theme (SKY_DARK), so
   it re-inks exactly like the two corner buttons above. In light theme it was
   the near-black light-theme ink on a near-black sky, about 2:1. Placed after
   the light rules on purpose: same specificity, later wins. */
body.voy-darksky .voy-return {
  color: #d6d6d6;
  border-color: rgba(255,255,255,0.30);
  background: rgba(255,255,255,0.10);
}
body.voy-darksky .voy-return:focus-visible { outline-color: #82a6cc; }
body.voy-sheet-open .voy-return { display: none !important; }

/* The first-run hint sits at 38vh by default, which on this page is exactly
   where the intro paints its "Where do you want to go?" headline (canvas,
   H * 0.42). Below it the two can never meet, at any of the viewports this
   page is checked at, and the band is still clear of the card sheet, the chat
   bar and the corner buttons. */
.gadget-hint { top: 58vh; }

.voy-target-line { margin: 0; font-size: 0.88em; opacity: 0.85; }
.voy-legend { margin: 0; font-size: 0.8em; opacity: 0.55; }

.voy-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.voy-row[hidden] { display: none !important; }
.voy-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14);
  border-radius: 6px; padding: 0.45em 0.7em; transition: background 0.15s ease;
}
.voy-btn:hover { background: rgba(127,127,127,0.26); }
.voy-btn--primary { background: rgba(130,166,204,0.22); font-weight: 600; }
.voy-btn--primary:hover { background: rgba(130,166,204,0.34); }
html[data-theme="light"] .voy-btn--primary { background: rgba(52,86,138,0.16); }
html[data-theme="light"] .voy-btn--primary:hover { background: rgba(52,86,138,0.26); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-btn--primary { background: rgba(52,86,138,0.16); }
  html:not([data-theme="dark"]) .voy-btn--primary:hover { background: rgba(52,86,138,0.26); }
}
.voy-btn:disabled { opacity: 0.5; cursor: default; }

.voy-details { font-size: 0.88em; }
.voy-details[hidden] { display: none !important; }
.voy-details summary { cursor: pointer; opacity: 0.85; }
.voy-details p { margin: 0.4em 0 0; opacity: 0.8; line-height: 1.5; }

.voy-status-line { margin: 0; font-size: 0.85em; opacity: 0.8; font-variant-numeric: tabular-nums; min-height: 1.2em; }
.voy-credit { margin: 0; font-size: 0.78em; opacity: 0.6; line-height: 1.45; }
.voy-verify { margin: 0; font-size: 0.78em; opacity: 0.55; font-variant-numeric: tabular-nums; min-height: 1.1em; }
.voy-verify--warn { opacity: 0.9; font-weight: 600; }

/* ---- the info card: a bottom sheet clear of the corner buttons ---- */
.voy-card {
  position: fixed; left: 8.5rem; bottom: 1rem; z-index: 28;
  width: min(420px, calc(100vw - 10rem));
  max-height: calc(100vh - 7rem); max-height: calc(100dvh - 7rem);
  overflow: auto; padding: 0.8rem 1rem 1rem;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
  background: rgba(18,18,18,0.94);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  box-shadow: 0 6px 24px rgba(0,0,0,0.35); font-size: 0.92em;
}
.voy-card[hidden] { display: none !important; }
html[data-theme="light"] .voy-card { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-card { background: rgba(255,255,255,0.97); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
}
.voy-card__head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
.voy-card__titles { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
.voy-card__title { font-weight: 700; font-size: 1.1em; }
.voy-card__sub { font-size: 0.82em; opacity: 0.6; }
.voy-card__close {
  font: inherit; font-size: 1.2em; line-height: 1; cursor: pointer; color: inherit;
  width: 1.5em; height: 1.5em; padding: 0; flex: none;
  border: 1px solid rgba(127,127,127,0.4); border-radius: 6px; background: rgba(127,127,127,0.12);
}
.voy-card__body { display: flex; flex-direction: column; gap: 0.55rem; margin-top: 0.6rem; }
.voy-fact { margin: 0; font-size: 0.92em; line-height: 1.45; opacity: 0.9; }
.voy-fact--chips { margin-top: 0.2rem; font-weight: 600; }
.voy-swatch {
  display: inline-block; width: 0.85em; height: 0.85em; border-radius: 3px;
  border: 1px solid rgba(127,127,127,0.5); vertical-align: middle;
}
.voy-note { margin: 0; font-size: 0.78em; opacity: 0.55; }
.voy-chips { display: flex; flex-direction: column; gap: 0.3rem; }
.voy-chip {
  font: inherit; color: inherit; cursor: pointer; text-align: left;
  display: flex; flex-direction: column; gap: 0.1rem;
  border: 1px solid rgba(127,127,127,0.35); background: rgba(127,127,127,0.1);
  border-radius: 6px; padding: 0.4em 0.6em;
}
.voy-chip:hover { background: rgba(127,127,127,0.2); }
.voy-chip__name { font-weight: 600; font-size: 0.92em; }
.voy-chip__line { font-size: 0.82em; opacity: 0.7; }
.voy-chipbody { padding: 0.2em 0.6em 0.3em; }
.voy-chipbody[hidden] { display: none !important; }
.voy-chipbody p { margin: 0.15em 0; font-size: 0.85em; opacity: 0.8; line-height: 1.4; }
.voy-actions { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.2rem; }

/* ---- DX-1: the card's actions never leave the screen ----
   The owner opened Sagittarius A* and could not find the way to travel there
   or to fall in. Measured on the shipped build: at 1440x900 and at 1280x820
   EVERY action button on that card sat 270 to 380 px below the card's own
   fold, and the only button in view was the close x. A fade cue at the bottom
   edge is a hint, not an affordance: nobody scrolls a panel to look for a
   verb they have no reason to believe is there.
   So the primary row leaves the flow and becomes a sticky footer INSIDE the
   card. The facts scroll UNDER it, the buttons stay put, and because the row
   is still the LAST child of the scroll container it also has a natural
   resting place at the very end, so nothing is permanently hidden beneath it
   when you scroll to the bottom.
   The plate is opaque, and the two colours are the card's own translucent
   surface composited over the page's sky colour, so it reads as the same
   surface rather than a panel stuck on top of it. */
/* The card gives its own bottom padding to the row, so the plate is flush
   with the card's bottom edge both while it floats and at the end of the
   scroll. Never a negative bottom MARGIN here: sticky pins the margin box,
   so a negative one would hang the plate below the scrollport and let the
   card clip it. */
.voy-card--docked { padding-bottom: 0; }
.voy-card__dock {
  position: sticky; bottom: 0; z-index: 2;
  margin: 0.65rem -1rem 0; padding: 0.6rem 1rem 0.85rem;
  background: #121212;
  border-top: 1px solid rgba(127,127,127,0.22);
}
.voy-card__dock .voy-actions { margin-top: 0; }
html[data-theme="light"] .voy-card__dock { background: #f8f8f8; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-card__dock { background: #f8f8f8; }
}
/* the scroll cue moves with the row it used to sit on top of: same gradient,
   same scroll timeline, now hung directly ABOVE the plate. It is absolutely
   positioned, so like the negative margin it replaces it adds no height. */
.voy-card--docked::after { display: none; }
.voy-card__dock::before {
  content: ''; display: block; pointer-events: none;
  position: absolute; left: 0; right: 0; bottom: 100%; height: 1.55rem;
  background: linear-gradient(to bottom, rgba(12,12,12,0), rgba(12,12,12,0.40));
  opacity: 0;
  animation-name: voy-scrollcue;
  animation-duration: auto;
  animation-timing-function: linear;
  animation-fill-mode: both;
  animation-timeline: scroll(nearest block);
  animation-range: calc(100% - 2.5rem) 100%;
}
html[data-theme="light"] .voy-card__dock::before {
  background: linear-gradient(to bottom, rgba(30,32,38,0), rgba(30,32,38,0.30));
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-card__dock::before {
    background: linear-gradient(to bottom, rgba(30,32,38,0), rgba(30,32,38,0.30));
  }
}
/* a button that has done its job (Plan the trip, once the trip is open) gets
   out of the row rather than sitting there disabled next to Launch */
.voy-btn[hidden] { display: none !important; }

.voy-arrive {
  border: 1px solid rgba(200,164,92,0.5); border-radius: 8px;
  background: rgba(200,164,92,0.1); padding: 0.5rem 0.7rem;
  display: flex; flex-direction: column; gap: 0.4rem;
}
html[data-theme="light"] .voy-arrive { border-color: rgba(160,124,44,0.5); background: rgba(160,124,44,0.08); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-arrive { border-color: rgba(160,124,44,0.5); background: rgba(160,124,44,0.08); }
}
.voy-arrive__line { margin: 0; font-weight: 600; font-size: 0.95em; }
/* the end of the plunge takes the arrival banner's shape, in the neutral ink
   of the page rather than the gold of an arrival: nothing was reached */
.voy-bhend { border-color: rgba(255,255,255,0.22); background: rgba(255,255,255,0.05); }
html[data-theme="light"] .voy-bhend { border-color: rgba(0,0,0,0.20); background: rgba(0,0,0,0.04); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-bhend { border-color: rgba(0,0,0,0.20); background: rgba(0,0,0,0.04); }
}

.voy-trip { display: flex; flex-direction: column; gap: 0.55rem; margin-top: 0.3rem; }
.voy-trip[hidden] { display: none !important; }
.voy-trip__title { margin: 0; font-weight: 700; font-size: 0.95em; }
.voy-trip__table { border-collapse: collapse; width: 100%; font-size: 0.82em; margin: 0; }
/* The theme's _tables.scss fills every thead with $lighter-gray and rules
   every cell in $light-gray. Inside this card that is a near-white band with
   faint grey headings on it, plus bright grid lines cutting through a dark
   surface. The card already supplies the background, so the table keeps only
   the soft horizontal rules it draws for itself. The values are neutral
   translucent greys, which read the same on both themes. */
.voy-trip__table, .voy-trip__table thead { border: 0; background: transparent; }
.voy-trip__table th {
  text-align: left; font-weight: 600; opacity: 0.75; padding: 0.15em 0.5em 0.15em 0;
  color: inherit; background: transparent; border-right: 0;
  border-bottom: 1px solid rgba(127,127,127,0.35);
}
.voy-trip__table td {
  padding: 0.28em 0.5em 0.28em 0; vertical-align: top; border-right: 0;
  border-bottom: 1px solid rgba(127,127,127,0.15);
}
.voy-trip__note { opacity: 0.6; font-size: 0.92em; }
.voy-trip__row--hl td { background: rgba(130,166,204,0.14); font-weight: 600; }
html[data-theme="light"] .voy-trip__row--hl td { background: rgba(52,86,138,0.1); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-trip__row--hl td { background: rgba(52,86,138,0.1); }
}
.voy-seg {
  display: flex; border: 1px solid rgba(127,127,127,0.4);
  border-radius: 6px; overflow: hidden;
}
.voy-seg__btn {
  flex: 1; font: inherit; font-size: 0.85em; color: inherit; background: none; border: 0;
  padding: 0.42em 0.2em; cursor: pointer; line-height: 1.2; min-height: 24px;
  /* narrow phones: "generation 1,000,000 t" must wrap between words, never
     shed a lone "t" onto a third line */
  min-width: 0; hyphens: none; overflow-wrap: normal; word-break: normal;
  text-wrap: balance;
}
@media (max-width: 460px) { .voy-seg__btn { font-size: 0.78em; padding: 0.42em 0.15em; } }
.voy-seg__btn + .voy-seg__btn { border-left: 1px solid rgba(127,127,127,0.4); }
.voy-seg__btn--on { background: rgba(130,166,204,0.22); font-weight: 600; }
html[data-theme="light"] .voy-seg__btn--on { background: rgba(52,86,138,0.16); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-seg__btn--on { background: rgba(52,86,138,0.16); }
}
.voy-live { margin: 0; font-size: 0.85em; opacity: 0.85; line-height: 1.45; font-variant-numeric: tabular-nums; }
.voy-warp { margin: 0; font-size: 0.82em; opacity: 0.6; line-height: 1.45; }

/* ---- live preview orbs (star card + expanded exoplanet chip) ---- */
.voy-orbwrap {
  flex: none; display: flex; align-items: center; justify-content: center;
  border-radius: 10px; background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.10); overflow: hidden;
}
.voy-orbwrap--exo { margin: 0.1rem 0 0.35rem; align-self: flex-start; }
.voy-card__head--orb { align-items: flex-start; }
.voy-card__head--orb .voy-card__titles { flex: 1 1 auto; min-width: 0; }
.voy-card__head--orb .voy-orbwrap { margin: 0 0.5rem; }
html[data-theme="light"] .voy-orbwrap { background: rgba(0,0,0,0.035); border-color: rgba(0,0,0,0.10); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-orbwrap { background: rgba(0,0,0,0.035); border-color: rgba(0,0,0,0.10); }
}
.voy-orb { display: block; }
.voy-orbnote { margin: 0.25em 0 0; font-size: 0.78em; opacity: 0.6; line-height: 1.4; }

/* ---- the rocket preview under the acceleration row ---- */
.voy-shipprev-wrap { display: flex; flex-direction: column; gap: 0.25rem; }
.voy-shipprev {
  display: block; width: 100%; max-width: 210px; height: auto;
  border-radius: 8px; border: 1px solid rgba(255,255,255,0.10);
  background: rgba(255,255,255,0.03);
}
html[data-theme="light"] .voy-shipprev { border-color: rgba(0,0,0,0.10); background: rgba(0,0,0,0.03); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-shipprev { border-color: rgba(0,0,0,0.10); background: rgba(0,0,0,0.03); }
}
.voy-shipname { margin: 0; font-size: 0.88em; font-weight: 600; }
.voy-shipline { margin: 0; font-size: 0.8em; opacity: 0.7; line-height: 1.4; }

/* ---- the cruise control bar, under the cruise HUD ----
   Row 1 is the view toggle (Chase / Cockpit, or Chase / Map in an in-system
   flight); row 2 is the time slider. Both live INSIDE this one element on
   purpose: the caption band measures max(hudBottom, .voy-fpbar bottom) and
   knows about nothing else, so a sibling fixed element would silently
   reopen the caption-overlap fix. */
.voy-fpbar {
  position: fixed; left: 50%; transform: translateX(-50%);
  top: 11.8rem; z-index: 29; width: 260px; pointer-events: auto;
  border-radius: 6px;
  background: rgba(18,20,24,0.86);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
}
.voy-fpbar[hidden] { display: none !important; }
html[data-theme="light"] .voy-fpbar { background: rgba(255,255,255,0.9); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-fpbar { background: rgba(255,255,255,0.9); }
}
@media (max-width: 768px) {
  .voy-fpbar { top: 10.4rem; width: 230px; }
}
.voy-tsrow {
  display: flex; align-items: center; gap: 5px;
  padding: 5px 8px 6px;
}
/* the theme's forms CSS gives inputs an explicit display, so [hidden] needs
   help here exactly as it does on the utility pages */
.voy-tsrow[hidden] { display: none !important; }
.voy-seg__btn[hidden] { display: none !important; }
.voy-tsrow__lab { font-size: 0.68em; opacity: 0.62; flex: 0 0 auto; white-space: nowrap; }
.voy-tsrow__out {
  font-size: 0.72em; opacity: 0.85; flex: 0 0 auto;
  min-width: 30px; text-align: right; font-variant-numeric: tabular-nums;
}
.voy-tsrow__range {
  flex: 1 1 auto; min-width: 0; width: auto; margin: 0; padding: 0;
  height: 18px; background: none; border: 0; box-shadow: none;
  accent-color: #82a6cc; cursor: pointer;
}
html[data-theme="light"] .voy-tsrow__range { accent-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .voy-tsrow__range { accent-color: #34568a; }
}

/* The info (i) replay button shares the segmented bar with Chase / Cockpit, but
   it is a momentary action, not a mode: it never takes the "on" fill. The glyph is
   small at the bar's 0.85em, so it gets its own size, and a hover fill so it
   reads as a button. Its flex basis is set inline by the markup; only the look
   is set here. */
#voy-fp-info {
  /* padding kept small enough that this button never sets the bar's height */
  font-size: 1em;
  line-height: 1;
  padding: 0.25em 0;
  opacity: 0.7;
  transition: background 0.15s ease, opacity 0.15s ease;
}
#voy-fp-info:hover, #voy-fp-info:focus-visible {
  opacity: 1;
  background: rgba(130,166,204,0.22);
}
html[data-theme="light"] #voy-fp-info:hover,
html[data-theme="light"] #voy-fp-info:focus-visible { background: rgba(52,86,138,0.16); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) #voy-fp-info:hover,
  html:not([data-theme="dark"]) #voy-fp-info:focus-visible { background: rgba(52,86,138,0.16); }
}

/* Mobile: full-width bottom sheet. The raised corner buttons occupy the
   bottom ~112px band at <=768px, so the sheet keeps 7.5rem of padding under
   its content and nothing interactive lands under them. */
@media (max-width: 768px) {
  .voy-card {
    left: 0; right: 0; bottom: 0; width: auto;
    max-height: 44vh; border-radius: 12px 12px 0 0;
    padding-bottom: 7.5rem;
  }
  /* DX-1 on the sheet. The 7.5rem of padding here was clearance for the
     corner buttons, and this page hides those while a sheet is open
     (body.voy-sheet-open); the chat bar is hidden on phones on every
     .life-app page. So the docked sheet gives that band back to the reader
     and the row runs to the bottom edge, standing its buttons off with its
     OWN padding. Keeping the card's padding-bottom at 0 is what makes the
     sticky arithmetic trivial: the row's floating position and its resting
     position at full scroll are the same place, so nothing is ever stranded
     underneath it. */
  .voy-card--docked { padding-bottom: 0; }
  .voy-card__dock { padding-bottom: 1.6rem; }
  /* the corner buttons are raised to bottom: 4rem here and the chat bar runs
     the full width, so the panel stops higher than it does on desktop */
  .voy-panel { max-height: calc(100vh - 12.5rem); max-height: calc(100dvh - 12.5rem); }
  .voy-blurb { order: 5; }
  .voy-credit { order: 6; }
  .voy-verify { order: 7; }
  .voy-legend { order: 4; }
  /* the panel scrolls, and the raised corner buttons sit in the bottom ~112px
     band, so the end of the scroll needs the same clearance the sheet keeps or
     the last lines read from behind a button */
  .voy-panel__body { padding-bottom: 7rem; }
  /* the sheet scrolls, so mid-scroll content can pass under the fixed
     corner buttons; hide them while a sheet is open (close, Esc, or tap
     the sky to bring them back) */
  body.voy-sheet-open #theme-toggle,
  body.voy-sheet-open #life-link { opacity: 0 !important; pointer-events: none !important; }
}
/* touch targets */
@media (pointer: coarse) {
  .voy-btn { min-height: 40px; padding: 0.5em 0.85em; }
  .voy-seg__btn { min-height: 40px; }
  /* a fingertip needs more than the 34px the markup asks for, and the bar grows
     to match so Chase / Cockpit keep their width. The inline flex basis on the
     button can only be beaten with !important. */
  .voy-fpbar { width: 260px; }
  #voy-fp-info { flex: 0 0 44px !important; }
  .voy-tsrow__range { height: 40px; }
  .voy-collapse { width: 2.3em; height: 2.3em; }
  .voy-panel .gadget-help { min-width: 36px; min-height: 36px; }
  .voy-details summary { padding: 0.35em 0; }
  .voy-card__close { width: 2em; height: 2em; }
  .voy-chip { min-height: 40px; }
  .voy-search { min-height: 40px; }
  .voy-search__opt { min-height: 40px; align-items: center; }
  .voy-surprise__opt { min-height: 40px; }
  .voy-surprise__btn { min-height: 40px; }
  .voy-return { min-height: 40px; }
}
</style>

<script defer src="{{ '/assets/js/gadget-ui.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/share-hash.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/voyage-astro.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/voyage-data.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/voyage-art.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/voyage-gl.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/voyage-galaxy.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/voyage-ships.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/voyage-bh.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/voyage.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
