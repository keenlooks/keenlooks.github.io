---
layout: single
title: "The Visible Computer"
permalink: /computer/
author_profile: false
excerpt: "A complete 8-bit computer in your browser: write assembly, then watch every value move between registers, memory, and the ALU while your program draws to a tiny screen."
description: "The Visible Computer by Keane Lucas: the KL-8 is an original 8-bit machine that runs in the browser. Write assembly in a real editor, assemble it, and watch the datapath animate every fetch, decode, and execute while your program draws on a 32 by 32 pixel screen and reads the keyboard."
---

<div id="comp-app" class="comp-app life-app" data-cols="3" data-tab="code">
  <div class="comp-topfade" aria-hidden="true"></div>

  <div id="comp-tabs" class="comp-tabs" role="tablist" aria-label="Panes">
    <button class="comp-tab comp-tab--codetab comp-tab--on" data-tab="code" role="tab" aria-selected="true" type="button">Code</button>
    <button class="comp-tab" data-tab="machine" role="tab" aria-selected="false" type="button">Machine</button>
    <button class="comp-tab" data-tab="screen" role="tab" aria-selected="false" type="button">Screen</button>
  </div>

  <div class="comp-main">
    <section class="comp-pane comp-pane--code" id="pane-code" aria-label="Code editor">
      <div class="comp-row comp-codebar">
        <button id="comp-assemble" class="comp-btn comp-btn--primary" type="button">Assemble &#9656; Run</button>
        <select id="comp-examples" aria-label="Load an example program"></select>
        <button id="comp-ref-btn" class="comp-btn comp-btn--ref" type="button" aria-label="Instruction reference and help" title="Instruction reference">?</button>
      </div>
      <div id="comp-edwrap" class="comp-edwrap">
        <textarea id="comp-src" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="off" aria-label="KL-8 assembly source"></textarea>
        <pre id="comp-srcview" class="comp-srcview" hidden tabindex="0" aria-label="Assembly source, read-only while the machine is loaded. Click it to edit and stop the run."></pre>
      </div>
      <div id="comp-errors" class="comp-errors" role="status" aria-live="polite" hidden></div>
      <p class="comp-blurb">Watch a small computer run: every byte that moves between the chips is drawn on the board, in plain words. When you are curious, open the code and change it. Press the <strong>?</strong> button for the instruction set and memory map.</p>
    </section>

    <section class="comp-pane comp-pane--machine" id="pane-machine" aria-label="Circuit board">
      <div id="comp-dpwrap" class="comp-dpwrap">
        <canvas id="comp-datapath" aria-label="The KL-8 drawn as a circuit board: chips for control, ALU and registers, RAM, video, and I/O, with the bytes that move between them lighting the traces"></canvas>
      </div>
      <div id="comp-narrate" class="comp-narrate">
        <div class="comp-narrate__row">
          <span id="comp-narrate-main" class="comp-narrate__main"></span>
          <button id="comp-bytechip" class="comp-chipbtn" type="button" hidden>Watch it byte by byte</button>
        </div>
        <div id="comp-phase" class="comp-phase"></div>
      </div>
      <p class="comp-legend">Gold traces carry bytes between the chips. The blue spark is a byte in flight.</p>
    </section>

    <section class="comp-pane comp-pane--screen" id="pane-screen" aria-label="Screen, run controls, and memory inspector">
      <div class="comp-screenbox">
        <canvas id="comp-screen" tabindex="0" aria-label="The KL-8 screen, 32 by 32 pixels. Click it to capture the keyboard for the running program."></canvas>
        <p id="comp-capnote" class="comp-capnote" hidden>keyboard captured. Esc or click outside to release.</p>
        <div id="comp-dpad" class="comp-dpad" aria-label="On-screen arrow pad">
          <button class="comp-dbtn comp-dbtn--up" data-bit="1" type="button" aria-label="Up arrow">&#9650;</button>
          <button class="comp-dbtn comp-dbtn--left" data-bit="4" type="button" aria-label="Left arrow">&#9664;</button>
          <button class="comp-dbtn comp-dbtn--down" data-bit="2" type="button" aria-label="Down arrow">&#9660;</button>
          <button class="comp-dbtn comp-dbtn--right" data-bit="8" type="button" aria-label="Right arrow">&#9654;</button>
          <button class="comp-dbtn comp-dbtn--space" data-bit="16" type="button" aria-label="Space, the action key">space</button>
        </div>
      </div>
      <div class="comp-runbox">
        <div class="comp-row">
          <button id="comp-run" class="comp-btn comp-btn--primary" type="button">Run</button>
          <button id="comp-step" class="comp-btn" type="button">Step</button>
          <button id="comp-micro" class="comp-btn" type="button">Micro-step</button>
          <button id="comp-reset" class="comp-btn" type="button">Reset</button>
        </div>
        <label class="comp-slider"><span>Clock: <strong id="comp-speedval">2 kHz</strong></span>
          <input id="comp-speed" type="range" min="0" max="100" step="1" value="60" aria-label="Clock speed, 2 hertz to 200 kilohertz"></label>
        <p id="comp-count" class="comp-count">0 instructions</p>
        <p id="comp-status" class="comp-status" role="status" aria-live="polite"></p>
        <div class="comp-row">
          <button id="comp-share" class="comp-btn" type="button">Share link</button>
          <button id="comp-save" class="comp-btn" type="button">Save image</button>
        </div>
      </div>
      <div class="comp-memhead">
        <select id="comp-region" aria-label="Memory region to inspect">
          <option value="prog" selected>Program</option>
          <option value="stack">Stack $0F00</option>
          <option value="disp">Display $1000</option>
          <option value="io">I-O $1400</option>
        </select>
        <label class="comp-pagelab"><span id="comp-mempageval">$0000</span>
          <input id="comp-mempage" type="range" min="0" max="14" step="1" value="0" aria-label="Memory page within the region"></label>
      </div>
      <div id="comp-mem" class="comp-mem">
        <canvas id="comp-memcanvas" aria-label="Memory inspector showing 256 bytes as a hex dump. Click a byte while paused to edit it."></canvas>
      </div>
      <p class="comp-blurb">Writes flash blue, reads flash gold. Click a byte while paused to edit it.</p>
    </section>
  </div>

  <!-- the aria-live narration mirror must NOT live inside a pane: panes go
       display:none per tab, and a hidden live region announces nothing -->
  <div id="comp-narrate-sr" class="comp-sr" aria-live="polite"></div>

  <aside id="comp-ref" class="comp-ref" aria-hidden="true" role="dialog" aria-label="KL-8 instruction reference">
    <div class="comp-ref-head">
      <strong>KL-8 reference</strong>
      <button id="comp-ref-close" class="comp-btn" type="button" aria-label="Close the reference">&#215;</button>
    </div>
    <div id="comp-ref-body" class="comp-ref-body"></div>
  </aside>
</div>

<style>
/* Full-screen 3-pane app takeover (these rules only load on /computer/). */
.page__title, .page__meta, .page__footer { display: none !important; }
.page__content { pointer-events: none; }
.comp-app { pointer-events: auto; }
.comp-topfade { pointer-events: none; }

.masthead { background: transparent !important; border-bottom: 0 !important; }
.greedy-nav { background: transparent !important; }
.comp-topfade {
  position: fixed; top: 0; left: 0; right: 0; height: 120px;
  z-index: 10;
  background: linear-gradient(to bottom,
    rgba(14,16,20,0.96) 0%, rgba(14,16,20,0.82) 32%, rgba(14,16,20,0) 100%);
}
html[data-theme="light"] .comp-topfade {
  background: linear-gradient(to bottom,
    rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .comp-topfade {
    background: linear-gradient(to bottom,
      rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
  }
}

/* ---- layout: 3 / 2 / 1 panes ---- */
.comp-main {
  position: fixed; top: 4.2rem; left: 0; right: 0; bottom: 0; z-index: 5;
  display: grid; gap: 10px; padding: 0 12px 12px;
  grid-template-columns: 340px minmax(0, 1fr) 316px;
  font-size: 0.92rem;
}
#comp-app[data-cols="2"] .comp-main { grid-template-columns: 320px minmax(0, 1fr); top: calc(4.2rem + 46px); }
#comp-app[data-cols="1"] .comp-main { grid-template-columns: minmax(0, 1fr); top: calc(4.2rem + 46px); }

.comp-tabs {
  display: none; position: fixed; top: 4.2rem; left: 12px; right: 12px; z-index: 15;
  gap: 6px; padding-bottom: 6px;
}
#comp-app[data-cols="1"] .comp-tabs, #comp-app[data-cols="2"] .comp-tabs { display: flex; }
#comp-app[data-cols="2"] .comp-tab--codetab { display: none; }
.comp-tab {
  flex: 1; font: inherit; color: inherit; cursor: pointer; line-height: 1;
  padding: 0.55em 0.6em; min-height: 32px;
  border: 1px solid rgba(127,127,127,0.4); border-radius: 8px;
  background: rgba(127,127,127,0.12);
}
.comp-tab--on { border-color: #82a6cc; background: rgba(130,166,204,0.2); font-weight: 600; }

/* pane visibility per breakpoint + tab */
#comp-app[data-cols="2"][data-tab="screen"] .comp-pane--machine { display: none; }
#comp-app[data-cols="2"]:not([data-tab="screen"]) .comp-pane--screen { display: none; }
#comp-app[data-cols="1"] .comp-pane { display: none; }
#comp-app[data-cols="1"][data-tab="code"] .comp-pane--code { display: flex; }
#comp-app[data-cols="1"][data-tab="machine"] .comp-pane--machine { display: flex; }
#comp-app[data-cols="1"][data-tab="screen"] .comp-pane--screen { display: flex; }

.comp-pane {
  min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px;
  border: 1px solid rgba(127,127,127,0.28); border-radius: 10px;
  background: rgba(127,127,127,0.07); padding: 10px;
}
.comp-pane--machine { overflow: hidden; }
.comp-dpwrap { flex: 1; min-height: 220px; }

/* ---- narrator strip (plain words over the small technical line) ---- */
.comp-narrate { display: flex; flex-direction: column; gap: 1px; }
/* two lines are reserved so a wrapping sentence never shrinks the pane and
   pushes the sized canvas over the strip mid-run */
.comp-narrate__row { display: flex; align-items: baseline; gap: 8px; min-height: 2.7em; }
.comp-narrate__main { flex: 1 1 auto; min-width: 0; font-size: 0.95em; line-height: 1.35; }
.comp-phase {
  min-height: 1.3em; font: 11.5px/1.4 ui-monospace, Consolas, monospace;
  opacity: 0.6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.comp-chipbtn {
  flex: 0 0 auto; font: inherit; font-size: 0.82em; color: inherit; cursor: pointer;
  line-height: 1.1; padding: 0.28em 0.75em; border-radius: 999px;
  border: 1px solid #82a6cc; background: rgba(130,166,204,0.16);
}
.comp-chipbtn:hover { background: rgba(130,166,204,0.3); }
.comp-chipbtn[hidden] { display: none !important; } /* hidden loses to display rules */
.comp-legend { margin: 0; font-size: 0.78em; opacity: 0.6; }
.comp-sr {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%);
  white-space: nowrap; border: 0;
}
html[data-theme="light"] .comp-chipbtn { border-color: #34568a; background: rgba(52,86,138,0.12); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .comp-chipbtn { border-color: #34568a; background: rgba(52,86,138,0.12); }
}

/* ---- editor (explicit high contrast in BOTH themes) ---- */
.comp-codebar { align-items: center; }
/* let the example menu shrink so the bar stays one row on a narrow column */
.comp-codebar select { flex: 1 1 90px; min-width: 0; }
.comp-row { display: flex; flex-wrap: wrap; gap: 6px; }
.comp-edwrap { flex: 1; min-height: 200px; display: flex; position: relative; }
#comp-src, .comp-srcview {
  flex: 1; width: 100%; min-height: 0; margin: 0; resize: none;
  border: 1px solid rgba(127,127,127,0.4); border-radius: 8px;
  background: #10161d; color: #d9dee5;
  font: 12.5px/1.55 ui-monospace, Consolas, monospace;
  padding: 8px 10px; white-space: pre; overflow: auto; tab-size: 8;
}
#comp-src:focus { outline: 2px solid #82a6cc; outline-offset: 1px; }
.comp-srcview { cursor: pointer; }
.comp-srcline { min-height: 1.55em; }
.comp-srcline--cur { background: rgba(130,166,204,0.26); border-radius: 3px; }
html[data-theme="light"] #comp-src, html[data-theme="light"] .comp-srcview {
  background: #f7f9fc; color: #1e2732; border-color: rgba(0,0,0,0.25);
}
html[data-theme="light"] .comp-srcline--cur { background: rgba(52,86,138,0.16); }
html[data-theme="light"] #comp-src:focus { outline-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) #comp-src, html:not([data-theme="dark"]) .comp-srcview {
    background: #f7f9fc; color: #1e2732; border-color: rgba(0,0,0,0.25);
  }
  html:not([data-theme="dark"]) .comp-srcline--cur { background: rgba(52,86,138,0.16); }
  html:not([data-theme="dark"]) #comp-src:focus { outline-color: #34568a; }
}

.comp-errors { display: flex; flex-direction: column; gap: 4px; max-height: 9em; overflow: auto; }
.comp-errors[hidden] { display: none !important; } /* the hidden attr loses to display:flex otherwise */
/* the theme's forms CSS gives textarea an explicit display, which defeats [hidden]
   (CLAUDE.md gotcha: hidden loses to any display rule) — same guard for the swap pair */
#comp-src[hidden], .comp-srcview[hidden] { display: none !important; }
.comp-err {
  font: 12px/1.4 ui-monospace, Consolas, monospace; text-align: left; cursor: pointer;
  color: inherit; border: 1px solid rgba(200,120,120,0.5); border-radius: 6px;
  background: rgba(200,120,120,0.12); padding: 4px 8px;
}
.comp-err--more { border: 0; background: none; cursor: default; opacity: 0.7; }

/* ---- buttons + selects (theme washes these out otherwise) ---- */
.comp-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1.1;
  border: 1px solid rgba(127,127,127,0.45); border-radius: 6px;
  background: rgba(127,127,127,0.14); padding: 0.45em 0.7em; min-height: 30px;
}
.comp-btn:hover { background: rgba(127,127,127,0.26); }
.comp-btn--primary { border-color: #82a6cc; background: rgba(130,166,204,0.2); font-weight: 600; }
.comp-btn--primary:hover { background: rgba(130,166,204,0.32); }
.comp-btn--ref { min-width: 30px; }
#comp-app select {
  font: inherit; color: #d6d6d6; background: #22272e; border: 1px solid rgba(127,127,127,0.45);
  border-radius: 6px; padding: 0.35em 0.5em; min-height: 30px; max-width: 100%;
}
html[data-theme="light"] .comp-btn--primary { border-color: #34568a; background: rgba(52,86,138,0.14); }
html[data-theme="light"] .comp-tab--on { border-color: #34568a; background: rgba(52,86,138,0.14); }
html[data-theme="light"] #comp-app select { color: #262626; background: #ffffff; border-color: rgba(0,0,0,0.3); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .comp-btn--primary { border-color: #34568a; background: rgba(52,86,138,0.14); }
  html:not([data-theme="dark"]) .comp-tab--on { border-color: #34568a; background: rgba(52,86,138,0.14); }
  html:not([data-theme="dark"]) #comp-app select { color: #262626; background: #ffffff; border-color: rgba(0,0,0,0.3); }
}

/* ---- screen + D-pad ---- */
.comp-screenbox { display: flex; flex-direction: column; align-items: center; gap: 8px; }
#comp-screen {
  display: block; border: 1px solid rgba(127,127,127,0.4); border-radius: 4px;
  image-rendering: pixelated; cursor: pointer; touch-action: none;
  background: transparent;
}
.comp-screen--cap { outline: 2px solid #82a6cc; outline-offset: 2px; }
html[data-theme="light"] .comp-screen--cap { outline-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .comp-screen--cap { outline-color: #34568a; }
}
.comp-capnote { margin: 0; font-size: 0.8em; opacity: 0.8; font-style: italic; }
.comp-dpad {
  display: grid; grid-template-columns: repeat(3, 46px); grid-auto-rows: 38px;
  gap: 6px; justify-content: center; touch-action: none; user-select: none; -webkit-user-select: none;
}
.comp-dbtn {
  font: inherit; font-size: 13px; color: inherit; cursor: pointer;
  border: 1px solid rgba(127,127,127,0.45); border-radius: 8px;
  background: rgba(127,127,127,0.14); min-width: 44px; min-height: 38px;
  padding: 0; touch-action: none;
}
.comp-dbtn--up { grid-column: 2; grid-row: 1; }
.comp-dbtn--left { grid-column: 1; grid-row: 2; }
.comp-dbtn--down { grid-column: 2; grid-row: 2; }
.comp-dbtn--right { grid-column: 3; grid-row: 2; }
.comp-dbtn--space { grid-column: 1 / span 3; grid-row: 3; }
.comp-dbtn--on { border-color: #82a6cc; background: rgba(130,166,204,0.3); }
html[data-theme="light"] .comp-dbtn--on { border-color: #34568a; background: rgba(52,86,138,0.2); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .comp-dbtn--on { border-color: #34568a; background: rgba(52,86,138,0.2); }
}

/* ---- run controls + memory ---- */
.comp-runbox { display: flex; flex-direction: column; gap: 8px; }
.comp-slider { display: flex; flex-direction: column; gap: 3px; font-size: 0.95em; }
.comp-slider strong { font-variant-numeric: tabular-nums; }
#comp-app input[type="range"] { width: 100%; accent-color: #82a6cc; }
html[data-theme="light"] #comp-app input[type="range"] { accent-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) #comp-app input[type="range"] { accent-color: #34568a; }
}
.comp-count, .comp-status { margin: 0; font-size: 0.85em; opacity: 0.8; font-variant-numeric: tabular-nums; min-height: 1.2em; }
.comp-memhead { display: flex; gap: 8px; align-items: center; }
.comp-memhead select { flex: 0 0 auto; }
.comp-pagelab { flex: 1; display: flex; flex-direction: column; gap: 2px; font-size: 0.8em; font-variant-numeric: tabular-nums; }
.comp-mem { position: relative; }
#comp-memcanvas { display: block; width: 100%; }
.comp-memedit {
  position: absolute; z-index: 6; width: 56px; padding: 1px 4px;
  font: 12px ui-monospace, Consolas, monospace;
  color: #d6d6d6; background: #10161d; border: 1px solid #82a6cc; border-radius: 4px;
}
html[data-theme="light"] .comp-memedit { color: #1e2732; background: #ffffff; border-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .comp-memedit { color: #1e2732; background: #ffffff; border-color: #34568a; }
}
.comp-blurb { margin: 0; font-size: 0.82em; opacity: 0.75; line-height: 1.45; }
/* the fixed #theme-toggle / #life-link buttons float over the bottom-left of
   every .life-app page (~130px wide, ~78px tall band), so the last line of the
   code pane's blurb has to sit above them */
.comp-pane--code .comp-blurb:last-child { padding-bottom: 3.4rem; }
@media (max-width: 768px) { .comp-pane--code .comp-blurb:last-child { padding-bottom: 0; } }

/* ---- instruction reference slide-over ---- */
.comp-ref {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 40;
  width: min(460px, 94vw); overflow-y: auto;
  padding: 4.6rem 1.2rem 2.5rem;
  background: rgba(18,20,24,0.985); border-left: 1px solid rgba(127,127,127,0.35);
  transform: translateX(103%); transition: transform 0.25s ease;
  font-size: 0.9rem;
}
.comp-ref--open { transform: none; box-shadow: -14px 0 44px rgba(0,0,0,0.45); visibility: visible; }
/* visibility (delayed to the end of the slide) also takes the closed panel out
   of the tab order in browsers without inert support. These two rules come
   AFTER the pair above and have the same specificity, so the open state has to
   restate visibility here or the panel slides in while still invisible. */
.comp-ref { visibility: hidden; transition: transform 0.25s ease, visibility 0s linear 0.25s; }
.comp-ref--open { visibility: visible; transition: transform 0.25s ease, visibility 0s; }
@media (prefers-reduced-motion: reduce) { .comp-ref { transition: none; } }
html[data-theme="light"] .comp-ref { background: rgba(252,253,255,0.99); border-left-color: rgba(0,0,0,0.18); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .comp-ref { background: rgba(252,253,255,0.99); border-left-color: rgba(0,0,0,0.18); }
}
.comp-ref-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.6rem; }
.comp-ref-body h3 { font-size: 1em; margin: 1.1em 0 0.4em; }
.comp-ref-body p, .comp-ref-body li { font-size: 0.92em; line-height: 1.5; }
.comp-ref-body ul { margin: 0.3em 0 0.8em 1.1em; padding: 0; }
.comp-ref-table { width: 100%; border-collapse: collapse; font-size: 0.82em; margin: 0; display: table; }
.comp-ref-table th, .comp-ref-table td {
  text-align: left; padding: 2px 6px; border-bottom: 1px solid rgba(127,127,127,0.2);
}
.comp-ref-table code { font-size: 1em; white-space: nowrap; }
.comp-ref-credit { margin-top: 1.4em; font-size: 0.85em; opacity: 0.75; }

/* ---- small screens: keep clear of the floating corner buttons ----
   #theme-toggle and #life-link float over the bottom-left (bottom: 4rem here,
   ~42px tall, spanning to x~113), and a pane that SCROLLS can put a control
   under them at any scroll offset, so padding cannot fix it — the left column
   has to end above the band. Only the left column is ever under them. */
@media (max-width: 768px) {
  #comp-app[data-cols="1"] .comp-pane,
  #comp-app[data-cols="2"] .comp-pane--code { margin-bottom: 6.6rem; }
}
/* the datapath is 620x352 of design space; fitting that into a phone-width
   pane shrinks its labels to ~6px, so on the single-column layout it keeps a
   legible minimum width and its wrapper pans instead */
#comp-app[data-cols="1"] .comp-dpwrap { overflow-x: auto; overflow-y: hidden; }
@media (max-height: 540px) {
  .comp-edwrap { min-height: 72px; }
  /* small landscape: keep the board legible and let the machine pane
     SCROLL rather than clip; the legend goes, the narrator gets one line.
     280px is the floor below which layoutBoard's chip stack overlaps the
     bus channels (rowH floors at 13px) */
  .comp-pane--machine { overflow: auto; }
  .comp-dpwrap { height: 280px; min-height: 280px; flex: 0 0 auto; }
  .comp-legend { display: none; }
  .comp-narrate__row { min-height: 0; }
  .comp-narrate__main { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .comp-pane--code .comp-blurb { display: none; }
  /* 38vh lands on the toolbar in landscape; drop the hint to the bottom */
  .gadget-hint { top: auto; bottom: 0.5rem; }
}
/* the shared first-run hint normally floats over a canvas; on this page it
   lands on the code editor, so give it a readable band */
.gadget-hint {
  padding: 0.7rem 1.2rem; background: rgba(18,18,18,0.9);
  -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
  border-top: 1px solid rgba(127,127,127,0.25);
  border-bottom: 1px solid rgba(127,127,127,0.25);
}
html[data-theme="light"] .gadget-hint { background: rgba(255,255,255,0.93); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .gadget-hint { background: rgba(255,255,255,0.93); }
}
/* touch targets, and a 16px editor font so iOS does not zoom the page when the
   textarea takes focus */
@media (pointer: coarse) {
  .comp-btn, #comp-app select { min-height: 40px; }
  .comp-tab { min-height: 42px; }
  .comp-dbtn { min-height: 44px; }
  .comp-dpad { grid-auto-rows: 44px; }
  #comp-src, .comp-srcview, .comp-memedit { font-size: 16px; }
  .comp-memedit { width: 66px; min-height: 30px; }
  #comp-app input[type="range"] { height: 34px; }
}
</style>

<script defer src="{{ '/assets/js/gadget-ui.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/share-hash.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/computer-core.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/computer.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
