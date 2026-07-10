---
layout: single
title: "Diff Checker"
permalink: /diff/
author_profile: false
excerpt: "Compare two texts, files, or PDFs privately in your browser. Nothing is uploaded."
description: "A private, in-browser diff checker by Keane Lucas: compare two pieces of text, two files, or the extracted text of two PDFs, side by side or unified, with word-level change highlights. Everything runs locally; nothing you paste or drop is uploaded."
---

<div class="df-wrap tex2jax_ignore">

  <p class="df-intro">
    Compare two pieces of text entirely in your browser. Paste into the boxes, drop files
    onto them, or drop PDFs and the text is extracted locally, page by page. Nothing you
    put here is uploaded anywhere. Ctrl+Enter (or Cmd+Enter) compares at any time.
  </p>

  <div class="df-inputs">
    <div class="df-pane" id="df-pane-a">
      <div class="df-pane__head">
        <span class="df-pane__label">Original</span>
        <span class="df-pane__file" id="df-file-a"></span>
        <button id="df-choose-a" class="df-btn df-btn--sm" type="button">Choose file</button>
      </div>
      <textarea id="df-text-a" class="df-ta" spellcheck="false" autocomplete="off" placeholder="Paste the original text, or drop a text file or PDF here"></textarea>
      <input id="df-fileinput-a" type="file" hidden style="display:none!important">
    </div>
    <div class="df-pane" id="df-pane-b">
      <div class="df-pane__head">
        <span class="df-pane__label">Changed</span>
        <span class="df-pane__file" id="df-file-b"></span>
        <button id="df-choose-b" class="df-btn df-btn--sm" type="button">Choose file</button>
      </div>
      <textarea id="df-text-b" class="df-ta" spellcheck="false" autocomplete="off" placeholder="Paste the changed text, or drop a text file or PDF here"></textarea>
      <input id="df-fileinput-b" type="file" hidden style="display:none!important">
    </div>
  </div>

  <div class="df-controls">
    <span class="df-seg" role="group" aria-label="Diff view">
      <button id="df-view-side" class="df-btn df-btn--on" type="button" aria-pressed="true">Side by side</button>
      <button id="df-view-unified" class="df-btn" type="button" aria-pressed="false">Unified</button>
    </span>
    <label class="df-check"><input type="checkbox" id="df-trim"> Ignore leading/trailing whitespace</label>
    <label class="df-check"><input type="checkbox" id="df-allws"> Ignore all whitespace</label>
    <label class="df-check"><input type="checkbox" id="df-case"> Ignore case</label>
    <span class="df-spacer"></span>
    <button id="df-compare" class="df-btn df-btn--accent" type="button" title="Ctrl+Enter">Compare</button>
    <button id="df-copy" class="df-btn" type="button">Copy unified diff</button>
  </div>

  <p class="df-note" id="df-sizenote" hidden></p>
  <p class="df-note" id="df-pdfnote" hidden>
    A note on PDFs: text is extracted in the order the file stores it, which is not always
    reading order. Unusual layouts can scramble text within a page; the === Page N ===
    markers help keep any scrambling contained to one page.
  </p>
  <p class="df-status" id="df-status" aria-live="polite"></p>

  <p class="df-stats" id="df-stats" aria-live="polite"></p>
  <div id="df-out" class="df-out"></div>

  <p class="df-privacy">🔒 100% in-browser. Your text and files are never uploaded. (I use Google Analytics to see whether anyone visits this page, but it cannot see your content.)</p>
  <p class="df-privacy" style="margin-top:0.35rem">A caveat: this is a personal side project and I have not tested it exhaustively; for anything important, double-check the result rather than trusting it blindly.</p>
  <p class="df-credit">Text diffing by <a href="https://github.com/kpdecker/jsdiff" rel="noopener">jsdiff</a> (BSD 3-Clause). PDF text extraction by Mozilla's <a href="https://mozilla.github.io/pdf.js/" rel="noopener">pdf.js</a> (Apache 2.0). Both are served from this site.</p>
</div>

<style>
/* This is a utility, not an article. Let it use more width than the reading column
   (side-by-side diffs want the room). */
#main { max-width: 1400px; }
.page { float: none; width: 100%; padding-left: 0; padding-right: 0; }
.page__inner-wrap, .page__content { max-width: 100%; }
.df-wrap { max-width: 1340px; margin: 0 auto; }
.df-wrap [hidden] { display: none !important; }   /* [hidden] loses to any display: rule */
.df-intro { max-width: 72ch; opacity: 0.9; line-height: 1.6; }

/* ---- input panes ---- */
.df-inputs { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 1.2rem; }
@media (max-width: 760px) { .df-inputs { grid-template-columns: 1fr; } }
.df-pane {
  border: 2px dashed rgba(127,127,127,0.35); border-radius: 10px; padding: 0.6rem;
  transition: border-color 0.15s ease, background 0.15s ease; min-width: 0;
}
.df-pane--over { border-color: #82a6cc; background: rgba(130,166,204,0.08); }
.df-pane__head { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; margin-bottom: 0.45rem; }
.df-pane__label { font-weight: 600; }
.df-pane__file { flex: 1; min-width: 0; font-size: 0.82em; opacity: 0.7; overflow-wrap: anywhere; }
#df-fileinput-a, #df-fileinput-b { display: none !important; }  /* the theme styles inputs, overriding `hidden` */

/* Solid, high-contrast textareas (the theme's faint form styling washes these out). */
.df-ta {
  width: 100%; height: 230px; resize: vertical; margin: 0;
  font-family: Consolas, "SF Mono", Menlo, Monaco, "Liberation Mono", monospace;
  font-size: 0.85rem; line-height: 1.45; border-radius: 6px; padding: 0.5em 0.6em;
  color: #e8e8e8; background: #20242c; border: 1px solid rgba(255,255,255,0.18);
}
.df-ta::placeholder { color: #9aa3af; opacity: 1; }
html[data-theme="light"] .df-ta { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.2); }
html[data-theme="light"] .df-ta::placeholder { color: #737373; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .df-ta { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.2); }
  html:not([data-theme="dark"]) .df-ta::placeholder { color: #737373; }
}

/* ---- controls ---- */
.df-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; margin-top: 0.9rem; }
.df-check { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.9em; opacity: 0.92; margin: 0; cursor: pointer; }
.df-check input[type="checkbox"] { width: auto; margin: 0; accent-color: #82a6cc; }
.df-spacer { flex: 1; }
.df-seg { display: inline-flex; }
.df-seg .df-btn { border-radius: 0; }
.df-seg .df-btn:first-child { border-radius: 6px 0 0 6px; }
.df-seg .df-btn:last-child { border-radius: 0 6px 6px 0; margin-left: -1px; }

.df-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14);
  border-radius: 6px; padding: 0.5em 0.8em; transition: background 0.15s ease;
}
.df-btn:hover { background: rgba(127,127,127,0.26); }
.df-btn--sm { padding: 0.35em 0.65em; font-size: 0.85em; }
.df-btn--on, .df-btn--accent { background: #82a6cc; border-color: #82a6cc; color: #fff; }
.df-btn--accent:hover, .df-btn--on:hover { background: #6f97c2; }
html[data-theme="light"] .df-btn--on, html[data-theme="light"] .df-btn--accent { background: #34568a; border-color: #34568a; }
html[data-theme="light"] .df-btn--accent:hover, html[data-theme="light"] .df-btn--on:hover { background: #2c4a77; }
html[data-theme="light"] .df-check input[type="checkbox"] { accent-color: #34568a; }
html[data-theme="light"] .df-pane--over { border-color: #34568a; background: rgba(52,86,138,0.06); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .df-btn--on, html:not([data-theme="dark"]) .df-btn--accent { background: #34568a; border-color: #34568a; }
  html:not([data-theme="dark"]) .df-btn--accent:hover, html:not([data-theme="dark"]) .df-btn--on:hover { background: #2c4a77; }
  html:not([data-theme="dark"]) .df-check input[type="checkbox"] { accent-color: #34568a; }
  html:not([data-theme="dark"]) .df-pane--over { border-color: #34568a; background: rgba(52,86,138,0.06); }
}

/* ---- notes / stats ---- */
.df-note { font-size: 0.85em; opacity: 0.8; line-height: 1.5; max-width: 84ch; margin: 0.6rem 0 0; }
.df-status { font-size: 0.85em; opacity: 0.85; min-height: 1.2em; margin: 0.4rem 0 0; overflow-wrap: anywhere; }
.df-stats { font-size: 0.9em; margin: 0.9rem 0 0.4rem; font-variant-numeric: tabular-nums; }

/* ---- diff output ---- */
/* Restrained, dual-theme tints: additions reuse the site accent, deletions a muted red. */
.df-out {
  --df-add-bg: rgba(130,166,204,0.14);
  --df-del-bg: rgba(200,90,90,0.15);
  --df-add-mk: rgba(130,166,204,0.34);
  --df-del-mk: rgba(200,90,90,0.34);
}
html[data-theme="light"] .df-out {
  --df-add-bg: rgba(52,86,138,0.10);
  --df-del-bg: rgba(180,60,60,0.10);
  --df-add-mk: rgba(52,86,138,0.22);
  --df-del-mk: rgba(180,60,60,0.24);
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .df-out {
    --df-add-bg: rgba(52,86,138,0.10);
    --df-del-bg: rgba(180,60,60,0.10);
    --df-add-mk: rgba(52,86,138,0.22);
    --df-del-mk: rgba(180,60,60,0.24);
  }
}

.df-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
@media (max-width: 760px) { .df-cols { grid-template-columns: 1fr; } }
.df-colwrap { min-width: 0; }
.df-colhead { font-size: 0.82em; opacity: 0.75; margin-bottom: 0.3rem; overflow-wrap: anywhere; }
.df-col {
  overflow: auto; max-height: 72vh;
  border: 1px solid rgba(127,127,127,0.3); border-radius: 8px; background: rgba(127,127,127,0.05);
  font-family: Consolas, "SF Mono", Menlo, Monaco, "Liberation Mono", monospace;
  font-size: 0.8rem; line-height: 1.5;
}
.df-row { display: flex; width: max-content; min-width: 100%; min-height: 1.5em; }
.df-ln {
  flex: none; width: var(--df-gw, 4ch); padding-right: 0.7ch; text-align: right;
  opacity: 0.5; user-select: none; font-variant-numeric: tabular-nums;
}
.df-pre { flex: none; width: 1.4ch; opacity: 0.7; user-select: none; white-space: pre; }
.df-code { white-space: pre; padding-right: 1ch; }
.df-code:empty::after { content: "\00a0"; }

.df-add { background: var(--df-add-bg); }
.df-del { background: var(--df-del-bg); }
.df-empty { background: rgba(127,127,127,0.07); }
.df-mk { color: inherit; padding: 0; border-radius: 2px; }
.df-mk-add { background: var(--df-add-mk); }
.df-mk-del { background: var(--df-del-mk); }

.df-foldrow { cursor: pointer; background: rgba(127,127,127,0.10); }
.df-foldrow:hover { background: rgba(127,127,127,0.16); }
.df-fold { opacity: 0.7; font-size: 0.9em; width: 100%; text-align: center; white-space: normal; user-select: none; }
.df-foldrow:hover .df-fold { opacity: 1; }
.df-foldrow:focus-visible { outline: 2px solid #82a6cc; outline-offset: -2px; }
html[data-theme="light"] .df-foldrow:focus-visible { outline-color: #34568a; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .df-foldrow:focus-visible { outline-color: #34568a; } }

.df-privacy { font-size: 0.82em; opacity: 0.7; margin: 1.4rem 0 0; }
.df-credit { font-size: 0.78em; opacity: 0.6; margin: 0.3rem 0 0; }
</style>

<script defer src="{{ '/assets/js/difflib/diff.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/difftool.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
