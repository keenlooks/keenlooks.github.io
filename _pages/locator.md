---
layout: single
permalink: /locator/
title: "Located by Light"
author_profile: false
og_image: /images/og/locator.png
excerpt: "Your browser estimates where you are from nothing but how long light takes to reach cloud servers and come back."
description: "Your browser estimates where you are from nothing but round-trip times to cloud servers and the speed of light in glass. A region, not an address; nothing is sent to this site."
---

<div class="loc-wrap">

<h1 class="loc-title">Located by Light</h1>

<p class="loc-lede">Your browser estimates where you are from nothing but how long light takes to reach cloud servers and come back.</p>

<p class="loc-honest">Nothing is sent to this site. Your browser times tiny requests to Amazon and Google cloud regions, which see your IP address the way any website does. The answer is a region, not an address.</p>

<figure class="loc-mapfig">
  <div class="loc-maptools">
    <div class="loc-seg" role="group" aria-label="Map view">
      <button type="button" class="loc-btn loc-btn--seg" id="loc-view-world" aria-pressed="true">World</button>
      <button type="button" class="loc-btn loc-btn--seg" id="loc-view-region" aria-pressed="false" disabled>Region</button>
    </div>
  </div>
  <canvas id="loc-map" class="loc-map" role="img" aria-label="World map of the cloud regions this page can time. No measurement yet."></canvas>
  <ul class="loc-legend" aria-label="Map key">
    <li><svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="currentColor"/></svg>AWS</li>
    <li><svg viewBox="0 0 14 14" aria-hidden="true"><rect x="2.5" y="2.5" width="9" height="9" fill="currentColor"/></svg>Google</li>
    <li><svg viewBox="0 0 22 14" aria-hidden="true"><line x1="1" y1="7" x2="21" y2="7" stroke="currentColor" stroke-width="2"/></svg>light in glass</li>
    <li><svg viewBox="0 0 22 14" aria-hidden="true"><line x1="1" y1="7" x2="21" y2="7" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 3"/></svg>light in vacuum</li>
    <li><svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="7" cy="7" r="1.6" fill="currentColor"/></svg>estimate and likely region</li>
    <li class="loc-legend__sim"><svg viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1.5 12.5 7 7 12.5 1.5 7Z" fill="currentColor"/></svg>simulated</li>
  </ul>
  <figcaption id="loc-caption" class="loc-caption">Each dot is a cloud region. Point at a dot to read its numbers; the Measurements table below lists them all.</figcaption>
</figure>

<div class="loc-runrow">
  <button type="button" id="loc-run" class="loc-btn loc-btn--primary" disabled>Loading...</button>
  <p id="loc-progress" class="loc-progress">Nothing runs until you press the button. A run takes about 20 seconds and about 0.7 MB.</p>
</div>
<noscript><p class="loc-note">This page needs JavaScript: the timing happens in your browser.</p></noscript>
<p id="loc-live" class="loc-sr" role="status" aria-live="polite"></p>

<section id="loc-result" class="loc-card" hidden>
  <p class="loc-card__kicker" id="loc-result-kicker">Result</p>
  <h2 id="loc-result-h" class="loc-card__h" tabindex="-1">Result</h2>
  <div id="loc-result-body"></div>
</section>

<h2 id="loc-meas-h" class="loc-h">Measurements</h2>
<p class="loc-p">The fastest of five round trips to each region, its jitter (median minus fastest), how far light in vacuum could have gone at most, how far light in glass goes once the fitted shared delay b is taken off ("under b" when the round trip was no longer than b alone; b = 0 until the fit), and how well the fitted model explains it. <span id="loc-sort-hint">Click a column heading to sort.</span> This table holds everything the map shows.</p>
<div class="loc-tablewrap" role="region" aria-labelledby="loc-meas-h" tabindex="0">
  <table id="loc-table" class="loc-table">
    <caption id="loc-table-cap" class="loc-sr">Measurements per cloud region. Not measured yet.</caption>
    <thead><tr>
      <th scope="col" data-key="metro" aria-sort="none"><button type="button">Region</button></th>
      <th scope="col" data-key="provider" aria-sort="none"><button type="button">Provider</button></th>
      <th scope="col" data-key="code" aria-sort="none"><button type="button">Code</button></th>
      <th scope="col" data-key="rtt" class="num" aria-sort="ascending"><button type="button">Round trip (ms)</button></th>
      <th scope="col" data-key="jitter" class="num" aria-sort="none"><button type="button">Jitter (ms)</button></th>
      <th scope="col" data-key="hard" class="num" aria-sort="none"><button type="button">Light in vacuum, max (km)</button></th>
      <th scope="col" data-key="fibre" class="num" aria-sort="none"><button type="button">Fibre at fitted b (km)</button></th>
      <th scope="col" data-key="dist" class="num" aria-sort="none"><button type="button">From estimate (km)</button></th>
      <th scope="col" data-key="resid" class="num" aria-sort="none"><button type="button">Residual (ms)</button></th>
      <th scope="col" data-key="role" aria-sort="none"><button type="button">Role</button></th>
    </tr></thead>
    <tbody id="loc-tbody" class="notranslate" translate="no"></tbody>
  </table>
</div>

<h2 class="loc-h">The math</h2>
<div id="loc-math" class="loc-math">
<p><strong>Light sets a hard limit.</strong> Light in vacuum travels at c = 299,792.458 km/s. A reply that took <var>rtt</var> milliseconds went out and came back, so the server can be at most</p>
<p class="loc-eq notranslate" translate="no">d<sub>i</sub> &le; c &times; rtt<sub>i</sub> / 2</p>
<p>away. A candidate point that breaks any one of these bounds is impossible. They are the faint dashed circles on the map. <span class="loc-live" id="lm-hard"></span></p>

<p><strong>Glass is slower.</strong> In optical fibre, light is slowed by the glass's refractive index of 1.468 to v<sub>f</sub> = c / 1.468, about 204,218 km/s, roughly two thirds of c. If the first hop of your own connection (router, cable, radio, VPN tunnel) and the servers' own time to answer cost <var>b</var> milliseconds each way, light in glass can have covered at most</p>
<p class="loc-eq notranslate" translate="no">d<sub>i</sub> &le; v<sub>f</sub> &times; (rtt<sub>i</sub> / 2 &minus; b)</p>
<p>These are the solid circles. While the run is going they are drawn with b = 0, a true limit for light in glass. After the fit they are drawn with the fitted b, and then they are estimates, not limits: the page cannot measure b, it fits it (below), and the fitted b also absorbs how much more the short routes near you zigzag. It can even come out longer than half of your fastest round trip; a region that close gets no solid circle, and the table says "under b". Only the dashed circles are hard limits. <span class="loc-live" id="lm-fibre"></span></p>

<p><strong>The model.</strong> Real routes are longer than great circles, so the page fits a route factor <var>k</var> between 1.0 and 2.5 and one shared delay <var>b</var> &ge; 0 (your first hop, plus the servers' own time to answer):</p>
<p class="loc-eq notranslate" translate="no">rtt<sub>i</sub> = 2 &times; k &times; g<sub>i</sub>(x) / v<sub>f</sub> + 2 &times; b + noise</p>
<p>where g<sub>i</sub>(x) is the great-circle distance from a candidate point <var>x</var> to region <var>i</var> (the haversine formula on a sphere of radius 6,371.0088 km). At every candidate point on Earth we ask: what route factor and what first-hop delay would make these timings fit? The place that needs the least excuse wins.</p>

<p><strong>The solver.</strong> A 1 degree grid covers the globe: 64,800 candidate points. At each one the model is a straight line in k and b, so a weighted least-squares fit finds both at once; if k falls outside 1.0 to 2.5 or b below 0, that one is clipped and the other is solved again. Only the 16 fastest regions enter this fit, because one route factor only holds over a limited range: short routes near you zigzag much more than the long undersea cables, and when every region is fitted at once the far ones drag the answer away. Every region that answered still rules out the places its hard bound forbids. The misfit is</p>
<p class="loc-eq notranslate" translate="no">cost(x) = &Sigma; w<sub>i</sub> (rtt<sub>i</sub> &minus; model<sub>i</sub>)<sup>2</sup> / &Sigma; w<sub>i</sub> &nbsp; (ms<sup>2</sup>)</p>
<p>with weights w<sub>i</sub> = provider &times; 1 / (1 + jitter<sub>i</sub> / 5) &times; (20 / max(rtt<sub>i</sub>, 20))<sup>2</sup>: Amazon counts 1.0 and Google 0.7 (Google's front ends add backbone time), steady regions count more than jittery ones, and near regions count much more than far ones, because they carry the most information and because the error in a route grows with its length. The 20 best points are then searched again on a 0.1 degree grid. <span class="loc-live" id="lm-solve"></span></p>

<p><strong>The region.</strong> Every point whose cost is at most twice the best (and at least 1 ms<sup>2</sup> above it), cost &le; cost<sub>min</sub> + max(1, cost<sub>min</sub>), counts as likely; that is the shaded area. It keeps only land: light alone cannot tell a coast from the open sea, and people rarely browse from a boat, so the best point is the best one on land too (if no land fits at all, the sea is shaded). The radius quoted is the distance from the best point that covers 90 percent of the shaded area. It is never quoted below 50 km, because each cloud region is placed at its city, not its building. <span class="loc-live" id="lm-region"></span></p>

<p class="loc-live-block" id="lm-example" hidden></p>
</div>

<h2 class="loc-h">Your connection</h2>
<div id="loc-conn" class="loc-conn">
<p class="loc-p">After a run, this section reads the shared delay b and the jitter for signs of a cellular link, a satellite or a VPN. Every path adds jitter of its own, but your first hop adds the same jitter to all of them, so the rules use the jitter of the quietest quarter of the regions (the lower quartile). The rules: wired or Wi-Fi when b is under 15 ms and the jitter under 4 ms; cellular when b is between 15 and 90 ms, or the jitter is 8 ms or more with b at least 10 ms; a low-orbit satellite when b is between 20 and 70 ms with jitter between 5 and 25 ms and no round trip under 25 ms; a geostationary satellite when no round trip is under 450 ms; a VPN or relay when your device's clock is more than 3 hours from the time the estimate's longitude implies, or when b is above 25 ms with a jitter under 3 ms (a tunnel adds a steady delay, a radio a jittery one).</p>
<div id="loc-conn-out"></div>
<figure class="loc-jfig" id="loc-jfig" hidden>
  <div id="loc-jitter"></div>
  <figcaption class="loc-caption" id="loc-jcap">Jitter per region: the median minus the fastest of its five round trips, regions sorted from nearest (left) to farthest by round trip. The dashed line is the lower quartile the rules use.</figcaption>
</figure>
<p class="loc-p" id="loc-tz"></p>
</div>

<h2 class="loc-h">What if</h2>
<p class="loc-p">Each button below takes the samples you just measured, changes them the way a VPN, a cellular link or a satellite would, and runs the same fit again. The map draws the simulated answer in a second colour over your real one. Every number here is modelled, not measured.</p>
<div class="loc-chips" id="loc-sims" role="group" aria-label="Simulations">
  <button type="button" class="loc-btn loc-chip" data-sim="vpn-frankfurt" aria-pressed="false" disabled>VPN exit in Frankfurt</button>
  <button type="button" class="loc-btn loc-chip" data-sim="vpn-ashburn" aria-pressed="false" disabled>VPN exit in Ashburn</button>
  <button type="button" class="loc-btn loc-chip" data-sim="vpn-singapore" aria-pressed="false" disabled>VPN exit in Singapore</button>
  <button type="button" class="loc-btn loc-chip" data-sim="vpn-saopaulo" aria-pressed="false" disabled>VPN exit in Sao Paulo</button>
  <button type="button" class="loc-btn loc-chip" data-sim="vpn-nearest" aria-pressed="false" disabled>VPN exit nearest to me</button>
  <button type="button" class="loc-btn loc-chip" data-sim="cell" aria-pressed="false" disabled>Cellular (4G/5G)</button>
  <button type="button" class="loc-btn loc-chip" data-sim="hotspot" aria-pressed="false" disabled>Wi-Fi hotspot on a phone</button>
  <button type="button" class="loc-btn loc-chip" data-sim="leo" aria-pressed="false" disabled>Low-orbit satellite (Starlink)</button>
  <button type="button" class="loc-btn loc-chip" data-sim="geo" aria-pressed="false" disabled>Geostationary satellite</button>
  <button type="button" class="loc-btn loc-chip" data-sim="relay" aria-pressed="false" disabled>Private Relay (two hops)</button>
</div>
<div id="loc-sim-out" class="loc-simout"><p class="loc-p loc-muted">Run the measurement first; the simulations reuse its samples.</p></div>

<h2 class="loc-h">Check the answer</h2>
<p class="loc-p">Your browser can also tell this page where your device thinks it is, from GPS or nearby Wi-Fi, if you allow it. The position stays in your browser: this page sends it nowhere. (Your browser may ask its own location service to work it out, as it does for any map.)</p>
<p><button type="button" id="loc-geo" class="loc-btn" disabled>Compare with my device's location</button></p>
<p id="loc-geo-out" class="loc-p" role="status"></p>

<h2 class="loc-h">Notes and limits</h2>
<ul class="loc-notes">
  <li>How good is it? Tried on real round trips measured between 33 Amazon regions, each region in turn playing the visitor with its own server left out, the best point landed a median of about 260 km from the truth, and the shaded region held the true place in 27 of the 33 cases. The settings were tuned on these same cases, and links between data centres are cleaner than home ones, so expect it to do somewhat worse for you. Where no cloud region is within a few thousand km, as in South America or southern Africa with only Amazon's regions, it can miss by thousands.</li>
  <li>The answer is a region. Fibre routes zigzag, Safari rounds timers to a millisecond, and cloud regions are metros, not buildings. A millisecond of round trip is about 100 km of fibre each way, so in Safari each light-in-vacuum bound is widened by 1 ms of round trip, about 150 km, to stay a true limit. Each region sits at the city that names or hosts it.</li>
  <li>A VPN relocates the answer to its exit; a cellular or satellite link widens it; a geostationary satellite defeats it.</li>
  <li>The cloud regions pinged see your IP address, as every website does. This site receives nothing: no cookies, no storage, nothing in the address bar, no events beyond the site's ordinary page view.</li>
  <li>Endpoints come and go; an unanswered region is left out, and with fewer than 8 answers the page says so.</li>
  <li>A run sends about six small requests to each of the <span id="loc-n-eps" class="notranslate" translate="no">76</span> regions, under 500 requests in all. Setting up each encrypted connection costs about 5 KB, so a run moves about 0.7 MB.</li>
</ul>

<h3 class="loc-h3">Credits</h3>
<p class="loc-credit">Map: Natural Earth land polygons (public domain). Endpoints: the public health URLs of Amazon DynamoDB (<code class="notranslate" translate="no">dynamodb.&lt;region&gt;.amazonaws.com/ping</code>) and the Google Cloud Run ping services listed by gcping.com. The fibre index of 1.468 is the effective group index Corning publishes for its SMF-28 Ultra single-mode fibre (1.4676 at 1310 nm, 1.4682 at 1550 nm). The idea of turning delays into distance constraints comes from Gueye, Ziviani, Crovella and Fdida, "Constraint-Based Geolocation of Internet Hosts", IEEE/ACM Transactions on Networking, 2006; the shared first-hop fit is the same trick GPS uses for a receiver's clock error. The accuracy figures in the notes use the public matrix of round trips between AWS regions published by cloudping.co.</p>

</div>

<style>
/* A tool page, not an article: wider than the reading column (as /imagetools/). */
#main { max-width: 1200px; }
.page { float: none; width: 100%; padding-left: 0; padding-right: 0; }
.page__inner-wrap, .page__content { max-width: 100%; }
.page__title { display: none; }
.loc-wrap { max-width: 1080px; margin: 0 auto; padding-bottom: 2rem; }
@media (max-width: 768px) { .loc-wrap { padding-bottom: 4.5rem; } }
.loc-title { margin: 0 0 0.3em; }
.loc-lede { font-size: 1.12em; line-height: 1.5; max-width: 62ch; margin: 0 0 0.5rem; }
.loc-honest { max-width: 66ch; line-height: 1.55; opacity: 0.85; margin: 0 0 1rem; font-size: 0.95em; }
.loc-p, .loc-math p, .loc-notes, .loc-credit { max-width: 72ch; line-height: 1.6; }
.loc-muted { opacity: 0.8; }
.loc-h { margin-top: 2.2rem; }
.loc-h3 { margin-top: 1.6rem; font-size: 1.05em; }
.loc-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); border: 0; white-space: nowrap; }
.loc-note { font-size: 0.9em; opacity: 0.85; }

/* ---- the map ---- */
/* Sized by the window's height too, so the title, the map and the button fit on one screen. */
.loc-mapfig { display: block; margin: 0 0 0.6rem; max-width: min(100%, max(520px, calc((100vh - 540px) * 2))); }
.loc-maptools { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; margin-bottom: 0.45rem; }
.loc-seg { display: inline-flex; }
.loc-seg .loc-btn { border-radius: 0; }
.loc-seg .loc-btn:first-child { border-radius: 6px 0 0 6px; }
.loc-seg .loc-btn:last-child { border-radius: 0 6px 6px 0; border-left-width: 0; }
.loc-legend { display: flex; flex-wrap: wrap; gap: 0.25rem 0.9rem; list-style: none; margin: 0.45rem 0 0; padding: 0; font-size: 0.8em; opacity: 0.9; }
.loc-legend li { display: inline-flex; align-items: center; gap: 0.35em; margin: 0; }
.loc-legend svg { width: 14px; height: 14px; color: #82a6cc; }
.loc-legend svg[viewBox="0 0 22 14"] { width: 22px; }
.loc-legend__sim svg { color: #cf9f55; }
/* pan-y: a vertical swipe over the map scrolls the page (the map has no drag). */
.loc-map { display: block; width: 100%; aspect-ratio: 2 / 1; height: auto; border-radius: 8px; touch-action: pan-y pinch-zoom; border: 1px solid rgba(127,127,127,0.28); cursor: default; }
.loc-caption { font-family: inherit; color: inherit; font-size: 0.85em; line-height: 1.5; opacity: 0.9; margin-top: 0.35rem; min-height: 2.6em; font-variant-numeric: tabular-nums; }

/* ---- buttons ---- */
.loc-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1.2;
  border: 1px solid rgba(127,127,127,0.45); background: rgba(127,127,127,0.12);
  border-radius: 6px; padding: 0.45em 0.85em; transition: background 0.15s ease;
}
.loc-btn:hover { background: rgba(127,127,127,0.24); }
.loc-btn:disabled { opacity: 0.5; cursor: default; }
.loc-btn[aria-pressed="true"] { background: #82a6cc; border-color: #82a6cc; color: #10161d; }
.loc-btn--primary { background: #82a6cc; border-color: #82a6cc; color: #10161d; font-weight: 600; padding: 0.6em 1.3em; min-height: 44px; }
.loc-btn--primary:hover { background: #a3c2e0; }
.loc-btn--primary:disabled { opacity: 0.6; }
.loc-runrow { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem 1rem; margin: 0.8rem 0 0.4rem; }
.loc-progress { margin: 0; font-size: 0.92em; font-variant-numeric: tabular-nums; }
.loc-chips { display: flex; flex-wrap: wrap; gap: 0.45rem; margin: 0.6rem 0 0.8rem; }
.loc-chip { font-size: 0.92em; }
@media (pointer: coarse) {
  .loc-btn { min-height: 44px; }
  .loc-table th button { min-height: 44px; }
}
/* the fixed theme button sits at the bottom left (left 1.25rem, 2.6rem wide);
   on phone heights and in windows narrower than 1280 px it can land on the run
   button at load, so the run row starts to the right of it */
@media (max-width: 1279px) {
  .loc-runrow { padding-left: 3.5rem; }
}

/* ---- result card ---- */
.loc-card { margin: 1rem 0 0.5rem; padding: 0.9rem 1.1rem 0.7rem; border-left: 3px solid #82a6cc; border-radius: 4px; background: rgba(130,166,204,0.08); scroll-margin-top: 0.75rem; }
.loc-card[hidden] { display: none !important; }
.loc-card--sim { border-left-color: #cf9f55; background: rgba(207,159,85,0.09); }
.loc-card__kicker { margin: 0 0 0.2rem; font-size: 0.78em; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600; opacity: 0.85; }
.loc-card__h { margin: 0 0 0.5rem; font-size: 1.3em; line-height: 1.3; }
.loc-card__h:focus { outline: none; }
.loc-card__h:focus-visible { outline: 2px solid #82a6cc; outline-offset: 3px; }
.loc-card ul { margin: 0.3rem 0 0.6rem; padding-left: 1.2rem; }
.loc-card li { margin: 0.25rem 0; line-height: 1.5; }
.loc-card p { margin: 0.35rem 0; line-height: 1.55; max-width: 76ch; }
.loc-pill { display: inline-block; padding: 0.1em 0.55em; border-radius: 999px; font-size: 0.78em; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; background: #cf9f55; color: #1b1409; margin-right: 0.5em; }
.loc-small { font-size: 0.88em; opacity: 0.9; }

/* ---- table ---- */
.loc-tablewrap { overflow-x: auto; -webkit-overflow-scrolling: touch; border: 1px solid rgba(127,127,127,0.28); border-radius: 6px; max-height: 34rem; overflow-y: auto; }
.loc-table { width: 100%; border-collapse: collapse; font-size: 0.82em; font-variant-numeric: tabular-nums; margin: 0; display: table; }
.loc-table th, .loc-table td { padding: 0.35em 0.6em; border-bottom: 1px solid rgba(127,127,127,0.2); text-align: left; white-space: nowrap; }
.loc-table th { position: sticky; top: 0; z-index: 1; background: #1c1c1c; padding: 0; }
.loc-table th button { font: inherit; font-weight: 600; color: inherit; background: none; border: 0; padding: 0.45em 0.6em; cursor: pointer; width: 100%; text-align: inherit; white-space: nowrap; }
.loc-table th[aria-sort="ascending"] button::after { content: " \2191"; }
.loc-table th[aria-sort="descending"] button::after { content: " \2193"; }
.loc-table .num { text-align: right; }
.loc-table tr.loc-row--none td { opacity: 0.7; }
.loc-table tr.loc-row--hl td { background: rgba(130,166,204,0.16); }

/* ---- math ---- */
.loc-math var { font-style: italic; }
.loc-eq { font-family: "Source Sans 3", system-ui, sans-serif; font-size: 1.05em; margin: 0.2rem 0 0.6rem 1.2rem; padding: 0.3rem 0.7rem; border-left: 2px solid rgba(127,127,127,0.4); display: inline-block; }
.loc-live:empty { display: none; }
.loc-live { display: block; margin-top: 0.4rem; padding: 0.4rem 0.7rem; border-radius: 4px; background: rgba(130,166,204,0.08); font-variant-numeric: tabular-nums; }
.loc-live-block { padding: 0.6rem 0.8rem; border-radius: 4px; background: rgba(130,166,204,0.08); font-variant-numeric: tabular-nums; max-width: 76ch; line-height: 1.6; }
.loc-live-block[hidden] { display: none !important; }

/* ---- connection ---- */
.loc-jfig { display: block; margin: 0.8rem 0; }
.loc-jfig[hidden] { display: none !important; }
#loc-jitter svg { display: block; width: 100%; height: auto; }
.loc-simout { min-height: 2.5rem; }
.loc-notes li { margin: 0.35rem 0; }
.loc-credit { font-size: 0.88em; opacity: 0.9; }

/* ---- light theme (manual and OS) ---- */
html[data-theme="light"] .loc-btn[aria-pressed="true"], html[data-theme="light"] .loc-btn--primary { background: #34568a; border-color: #34568a; color: #fff; }
html[data-theme="light"] .loc-btn--primary:hover { background: #25406b; }
html[data-theme="light"] .loc-legend svg { color: #34568a; }
html[data-theme="light"] .loc-legend__sim svg { color: #916315; }
html[data-theme="light"] .loc-card { border-left-color: #34568a; background: #eff4ff; }
html[data-theme="light"] .loc-card--sim { border-left-color: #916315; background: #fbf4e8; }
html[data-theme="light"] .loc-pill { background: #916315; color: #fff; }
html[data-theme="light"] .loc-table th { background: #f5f5f5; }
html[data-theme="light"] .loc-card__h:focus-visible { outline-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .loc-btn[aria-pressed="true"], html:not([data-theme="dark"]) .loc-btn--primary { background: #34568a; border-color: #34568a; color: #fff; }
  html:not([data-theme="dark"]) .loc-btn--primary:hover { background: #25406b; }
  html:not([data-theme="dark"]) .loc-legend svg { color: #34568a; }
  html:not([data-theme="dark"]) .loc-legend__sim svg { color: #916315; }
  html:not([data-theme="dark"]) .loc-card { border-left-color: #34568a; background: #eff4ff; }
  html:not([data-theme="dark"]) .loc-card--sim { border-left-color: #916315; background: #fbf4e8; }
  html:not([data-theme="dark"]) .loc-pill { background: #916315; color: #fff; }
  html:not([data-theme="dark"]) .loc-table th { background: #f5f5f5; }
  html:not([data-theme="dark"]) .loc-card__h:focus-visible { outline-color: #34568a; }
}
@media (prefers-reduced-motion: reduce) { .loc-btn { transition: none; } }
</style>

<script defer src="{{ '/assets/js/obs-earth-data.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/locator-endpoints.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/locator.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
