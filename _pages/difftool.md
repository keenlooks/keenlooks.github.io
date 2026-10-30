---
layout: single
title: "Diff Checker"
permalink: /diff/
og_image: /images/og/diff.png
author_profile: false
excerpt: "Compare two texts, files, or PDFs privately in your browser. Nothing is uploaded."
description: "A private, in-browser diff checker by Keane Lucas: compare two pieces of text, two files, or the extracted text of two PDFs, side by side or unified, with word-level change highlights. Everything runs locally; nothing you paste or drop is uploaded."
---

<div class="df-wrap tex2jax_ignore">

  <p class="df-intro">
    Compare two pieces of text entirely in your browser. <span id="df-intro-load">Paste into the boxes, drop files
    onto them, or drop PDFs and the text is extracted locally, page by page.</span> Nothing you
    put here is uploaded anywhere. <span id="df-intro-keys">Ctrl+Enter (or Cmd+Enter) compares at any time.</span>
  </p>

  <div class="df-inputs">
    <div class="df-pane" id="df-pane-a">
      <div class="df-pane__head">
        <span class="df-pane__label" id="df-label-a">Original</span>
        <span class="df-pane__file" id="df-file-a"></span>
        <button id="df-choose-a" class="df-btn df-btn--sm" type="button">Choose file</button>
      </div>
      <textarea id="df-text-a" class="df-ta" aria-labelledby="df-label-a" spellcheck="false" autocomplete="off" placeholder="Paste the original text, or drop a text file or PDF here"></textarea>
      <input id="df-fileinput-a" type="file" hidden style="display:none!important">
    </div>
    <div class="df-pane" id="df-pane-b">
      <div class="df-pane__head">
        <span class="df-pane__label" id="df-label-b">Changed</span>
        <span class="df-pane__file" id="df-file-b"></span>
        <button id="df-choose-b" class="df-btn df-btn--sm" type="button">Choose file</button>
      </div>
      <textarea id="df-text-b" class="df-ta" aria-labelledby="df-label-b" spellcheck="false" autocomplete="off" placeholder="Paste the changed text, or drop a text file or PDF here"></textarea>
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
    <label class="df-check"><input type="checkbox" id="df-wrapln"> Wrap long lines</label>
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
  <div id="df-out" class="df-out notranslate" translate="no"></div>

  <!-- Password prompt for encrypted PDFs (replaces window.prompt, which showed the password) -->
  <dialog class="df-dialog" id="df-pass-dialog" aria-labelledby="df-pass-head" aria-describedby="df-pass-msg">
    <form id="df-pass-form" method="dialog">
      <p class="df-dialog__head" id="df-pass-head"><strong>Password required</strong></p>
      <p class="df-dialog__msg" id="df-pass-msg"></p>
      <label class="df-dialog__field" for="df-pass-input">Password</label>
      <input id="df-pass-input" class="df-dialog__input" type="password" autocomplete="off" spellcheck="false">
      <p class="df-dialog__hint">The password is used only on your device, to open the file.</p>
      <div class="df-dialog__foot">
        <button id="df-pass-cancel" class="df-btn" type="button">Skip this file</button>
        <button id="df-pass-go" class="df-btn df-btn--accent" type="submit">Unlock</button>
      </div>
    </form>
  </dialog>

  <p class="df-privacy">100% in-browser. Your text and files are never uploaded. (I use Google Analytics to see whether anyone visits this page, but it cannot see your content.)</p>
  <p class="df-privacy" style="margin-top:0.35rem">A caveat: this is a personal side project and I have not tested it exhaustively; for anything important, double-check the result rather than trusting it blindly. Found a problem? <a class="df-report" href="mailto:{{ site.author.email }}?subject=Diff%20Checker%20problem">Tell me</a>.</p>
  <p class="df-credit">Text diffing by <a href="https://github.com/kpdecker/jsdiff" rel="noopener">jsdiff</a> (BSD 3-Clause). PDF text extraction by Mozilla's <a href="https://mozilla.github.io/pdf.js/" rel="noopener">pdf.js</a> (Apache 2.0). Both are served from this site.</p>
</div>

<style>
/* This is a utility, not an article. Let it use more width than the reading column
   (side-by-side diffs want the room). */
#main { max-width: 1400px; }
.page { float: none; width: 100%; padding-left: 0; padding-right: 0; }
.page__inner-wrap, .page__content { max-width: 100%; }
.df-wrap { max-width: 1340px; margin: 0; }   /* left edge shared with the page title */
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
/* Dark text on the light dark-theme accent (white on #82a6cc is 2.5:1; #141414 is 7.3:1). */
.df-btn--on, .df-btn--accent { background: #82a6cc; border-color: #82a6cc; color: #141414; }
.df-btn--accent:hover, .df-btn--on:hover { background: #6f97c2; }
html[data-theme="light"] .df-btn--on, html[data-theme="light"] .df-btn--accent { background: #34568a; border-color: #34568a; color: #fff; }
html[data-theme="light"] .df-btn--accent:hover, html[data-theme="light"] .df-btn--on:hover { background: #2c4a77; }
html[data-theme="light"] .df-check input[type="checkbox"] { accent-color: #34568a; }
html[data-theme="light"] .df-pane--over { border-color: #34568a; background: rgba(52,86,138,0.06); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .df-btn--on, html:not([data-theme="dark"]) .df-btn--accent { background: #34568a; border-color: #34568a; color: #fff; }
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
/* Colour is never the only cue (WCAG 1.4.1): a changed row also carries a +/- sign and a
   3px edge in the kind's colour (over 3:1 against the page), and a changed word is
   underlined as well as tinted. */
.df-out {
  --df-add-bg: rgba(130,166,204,0.14);
  --df-del-bg: rgba(200,90,90,0.15);
  --df-add-mk: rgba(130,166,204,0.40);
  --df-del-mk: rgba(200,90,90,0.40);
  --df-add-edge: #82a6cc;
  --df-del-edge: #d98080;
}
html[data-theme="light"] .df-out {
  --df-add-bg: rgba(52,86,138,0.10);
  --df-del-bg: rgba(180,60,60,0.10);
  --df-add-mk: rgba(52,86,138,0.26);
  --df-del-mk: rgba(180,60,60,0.28);
  --df-add-edge: #34568a;
  --df-del-edge: #b03a3a;
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .df-out {
    --df-add-bg: rgba(52,86,138,0.10);
    --df-del-bg: rgba(180,60,60,0.10);
    --df-add-mk: rgba(52,86,138,0.26);
    --df-del-mk: rgba(180,60,60,0.28);
    --df-add-edge: #34568a;
    --df-del-edge: #b03a3a;
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
/* Rows sit in blocks of 200 (.df-chunk); off-screen blocks skip layout and paint. A block
   is as wide as its longest row (paint containment would otherwise clip long lines). */
.df-chunk { content-visibility: auto; contain-intrinsic-block-size: auto 300em; width: max-content; min-width: 100%; }
.df-out--wrap .df-chunk { width: auto; }
.df-row { display: flex; width: max-content; min-width: 100%; min-height: 1.5em; }
.df-ln {
  flex: none; width: var(--df-gw, 4ch); padding-right: 0.7ch; text-align: right;
  opacity: 0.5; user-select: none; font-variant-numeric: tabular-nums;
}
.df-pre { flex: none; width: 1.4ch; opacity: 0.7; user-select: none; white-space: pre; }
.df-code { white-space: pre; padding-right: 1ch; unicode-bidi: plaintext; }  /* each line takes its own direction: Arabic and Hebrew lines read right to left */
.df-code:empty::after { content: "\00a0"; }

/* Wrap long lines: rows grow downward instead of scrolling sideways. Side by side puts
   each line pair in one row (.df-pair) so the two halves stay level. */
.df-out--wrap .df-row { width: auto; }
.df-out--wrap .df-code { flex: 1 1 auto; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.df-out--wrap .df-col { overflow-x: hidden; }
.df-pairhead, .df-pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.df-pairhead { column-gap: 0.75rem; }
.df-pair > .df-row { min-width: 0; }
.df-pair > .df-row + .df-row { border-left: 1px solid rgba(127,127,127,0.3); }

.df-add { background: var(--df-add-bg); box-shadow: inset 3px 0 0 var(--df-add-edge); }
.df-del { background: var(--df-del-bg); box-shadow: inset 3px 0 0 var(--df-del-edge); }
.df-add > .df-pre, .df-del > .df-pre { opacity: 1; font-weight: 700; }
.df-add > .df-pre { color: var(--df-add-edge); }
.df-del > .df-pre { color: var(--df-del-edge); }
.df-empty { background: rgba(127,127,127,0.07); }
.df-mk { color: inherit; padding: 0; border-radius: 2px; text-decoration: underline 2px; text-underline-offset: 0.18em; text-decoration-skip-ink: none; }
.df-mk-add { background: var(--df-add-mk); text-decoration-color: var(--df-add-edge); }
.df-mk-del { background: var(--df-del-mk); text-decoration-color: var(--df-del-edge); }
/* <ins>/<del> say "added"/"removed" to screen readers; generated text is never copied */
.df-mk::before {
  position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap;
}
.df-mk-add::before { content: " added: "; }
.df-mk-del::before { content: " removed: "; }

.df-foldrow { cursor: pointer; background: rgba(127,127,127,0.10); }
.df-foldrow:hover { background: rgba(127,127,127,0.16); }
.df-fold { opacity: 0.7; font-size: 0.9em; width: 100%; text-align: center; white-space: normal; user-select: none; }
.df-foldrow:hover .df-fold { opacity: 1; }
.df-foldrow:focus-visible { outline: 2px solid #82a6cc; outline-offset: -2px; }
html[data-theme="light"] .df-foldrow:focus-visible { outline-color: #34568a; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .df-foldrow:focus-visible { outline-color: #34568a; } }

/* ---- password dialog (a native <dialog>: modal, focus kept inside, Escape skips) ---- */
.df-dialog {
  width: min(26rem, calc(100vw - 2rem)); padding: 1.1rem 1.2rem 1rem; border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.18); background: #1d2026; color: #e8e8e8;
  box-shadow: 0 12px 40px rgba(0,0,0,0.45);
}
.df-dialog::backdrop { background: rgba(0,0,0,0.55); }
.df-dialog p { margin: 0 0 0.7rem; font-size: 0.95em; line-height: 1.5; }
.df-dialog__head { font-size: 1.05em; }
.df-dialog__msg { overflow-wrap: anywhere; }
.df-dialog__field { display: block; font-size: 0.9em; margin: 0 0 0.3rem; color: inherit; }
.df-dialog .df-dialog__input {
  width: 100%; margin: 0 0 0.6rem; padding: 0.5em 0.6em; font: inherit; border-radius: 6px;
  color: #e8e8e8; background: #141414; border: 1px solid rgba(255,255,255,0.3);
}
.df-dialog__hint { font-size: 0.82em !important; color: #b4b4b4; }
.df-dialog__foot { display: flex; justify-content: flex-end; gap: 0.6rem; flex-wrap: wrap; }
html[data-theme="light"] .df-dialog { background: #fff; color: #1f2430; border-color: rgba(0,0,0,0.2); }
html[data-theme="light"] .df-dialog .df-dialog__input { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.35); }
html[data-theme="light"] .df-dialog__hint { color: #5c5c5c; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .df-dialog { background: #fff; color: #1f2430; border-color: rgba(0,0,0,0.2); }
  html:not([data-theme="dark"]) .df-dialog .df-dialog__input { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.35); }
  html:not([data-theme="dark"]) .df-dialog__hint { color: #5c5c5c; }
}
@media (pointer: coarse) {
  .df-dialog .df-btn { min-height: 44px; }
  .df-dialog .df-dialog__input { font-size: 16px; min-height: 44px; }   /* 16px: iOS does not zoom on focus */
}

/* Solid muted colours rather than opacity, so the links in these lines keep their contrast. */
.df-privacy { font-size: 0.82em; color: #9c9c9c; margin: 1.4rem 0 0; }
.df-credit { font-size: 0.78em; color: #9c9c9c; margin: 0.3rem 0 0; }
.df-report { text-decoration: underline; text-underline-offset: 0.15em; }
html[data-theme="light"] .df-privacy, html[data-theme="light"] .df-credit { color: #6b6b6b; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .df-privacy, html:not([data-theme="dark"]) .df-credit { color: #6b6b6b; }
}
</style>

<script defer src="{{ '/assets/js/difflib/diff.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/difftool.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
