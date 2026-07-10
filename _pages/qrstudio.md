---
layout: single
title: "QR Studio"
permalink: /qr/
author_profile: false
excerpt: "Generate and scan QR codes in your browser. The codes are static, so the data lives in the pattern itself, with no redirect service, and a printed code keeps working forever."
description: "A private, in-browser QR utility by Keane Lucas: generate static QR codes for links, text, Wi-Fi, contact cards, email, phone, and SMS, download them as PNG or SVG, and scan codes from an image or your camera. Static codes carry the data themselves, no redirect service involved, so a printed code never expires. Nothing is uploaded."
---

<div class="qs-wrap tex2jax_ignore" id="qs-wrap">

  <p class="qs-intro">
    Make and read QR codes without leaving your browser. Every code generated here is static:
    the data is encoded in the pattern itself, not routed through a shortener or a redirect
    service, so a printed code keeps working for as long as the print does. Scanning is local
    too, from a saved image or your camera.
  </p>

  <div class="qs-tabs" role="tablist" aria-label="QR Studio mode">
    <button id="qs-tab-gen" class="qs-tab qs-tab--on" type="button" role="tab" aria-selected="true">Generate</button>
    <button id="qs-tab-scan" class="qs-tab" type="button" role="tab" aria-selected="false">Scan</button>
  </div>

  <!-- ===================== GENERATE ===================== -->
  <section id="qs-gen" class="qs-panel" role="tabpanel">
    <div class="qs-grid">
      <div class="qs-left">
        <label class="qs-field"><span>What should the code contain?</span>
          <select id="qs-type">
            <option value="url" selected>Link (URL)</option>
            <option value="text">Plain text</option>
            <option value="wifi">Wi-Fi network</option>
            <option value="vcard">Contact card (vCard)</option>
            <option value="email">Email</option>
            <option value="tel">Phone number</option>
            <option value="sms">Text message (SMS)</option>
          </select>
        </label>

        <div class="qs-fields" id="qs-f-url">
          <label class="qs-field"><span>URL</span>
            <input id="qs-url" type="text" inputmode="url" placeholder="https://example.com" autocomplete="off"></label>
        </div>

        <div class="qs-fields" id="qs-f-text" hidden>
          <label class="qs-field"><span>Text</span>
            <textarea id="qs-text" rows="4" placeholder="Any text"></textarea></label>
        </div>

        <div class="qs-fields" id="qs-f-wifi" hidden>
          <label class="qs-field"><span>Network name (SSID)</span>
            <input id="qs-wifi-ssid" type="text" autocomplete="off"></label>
          <label class="qs-field"><span>Password</span>
            <input id="qs-wifi-pass" type="text" autocomplete="off"></label>
          <label class="qs-field"><span>Security</span>
            <select id="qs-wifi-sec">
              <option value="WPA" selected>WPA / WPA2 / WPA3</option>
              <option value="WEP">WEP (legacy)</option>
              <option value="nopass">None (open network)</option>
            </select>
          </label>
          <label class="qs-check"><input id="qs-wifi-hidden" type="checkbox"> Hidden network</label>
        </div>

        <div class="qs-fields" id="qs-f-vcard" hidden>
          <label class="qs-field"><span>Full name</span>
            <input id="qs-vc-name" type="text" autocomplete="off"></label>
          <label class="qs-field"><span>Organization</span>
            <input id="qs-vc-org" type="text" autocomplete="off"></label>
          <label class="qs-field"><span>Title</span>
            <input id="qs-vc-title" type="text" autocomplete="off"></label>
          <label class="qs-field"><span>Phone</span>
            <input id="qs-vc-tel" type="text" inputmode="tel" autocomplete="off"></label>
          <label class="qs-field"><span>Email</span>
            <input id="qs-vc-email" type="text" inputmode="email" autocomplete="off"></label>
          <label class="qs-field"><span>Website</span>
            <input id="qs-vc-url" type="text" inputmode="url" autocomplete="off"></label>
        </div>

        <div class="qs-fields" id="qs-f-email" hidden>
          <label class="qs-field"><span>To</span>
            <input id="qs-em-to" type="text" inputmode="email" placeholder="name@example.com" autocomplete="off"></label>
          <label class="qs-field"><span>Subject</span>
            <input id="qs-em-subj" type="text" autocomplete="off"></label>
          <label class="qs-field"><span>Body</span>
            <textarea id="qs-em-body" rows="3"></textarea></label>
        </div>

        <div class="qs-fields" id="qs-f-tel" hidden>
          <label class="qs-field"><span>Phone number</span>
            <input id="qs-tel-num" type="text" inputmode="tel" placeholder="+1 555 000 0000" autocomplete="off"></label>
        </div>

        <div class="qs-fields" id="qs-f-sms" hidden>
          <label class="qs-field"><span>Phone number</span>
            <input id="qs-sms-num" type="text" inputmode="tel" placeholder="+1 555 000 0000" autocomplete="off"></label>
          <label class="qs-field"><span>Message (optional, pre-filled for the sender)</span>
            <textarea id="qs-sms-msg" rows="3"></textarea></label>
        </div>

        <h2 class="qs-h qs-h--gap">Options</h2>
        <label class="qs-field"><span>Error correction</span>
          <select id="qs-ec">
            <option value="L">L (recovers 7% damage, densest)</option>
            <option value="M" selected>M (recovers 15%, the usual default)</option>
            <option value="Q">Q (recovers 25%)</option>
            <option value="H">H (recovers 30%, best for print)</option>
          </select>
        </label>
        <label class="qs-field"><span>PNG download size</span>
          <select id="qs-size">
            <option value="512">512 px</option>
            <option value="1024" selected>1024 px</option>
            <option value="2048">2048 px</option>
          </select>
        </label>
        <label class="qs-field"><span>Quiet zone (white border, in modules)</span>
          <input id="qs-margin" type="number" min="0" max="16" value="4"></label>
      </div>

      <div class="qs-right">
        <div class="qs-card"><canvas id="qs-canvas" class="qs-canvas" aria-label="QR code preview"></canvas></div>
        <p class="qs-meta" id="qs-meta"></p>
        <div class="qs-dl">
          <button id="qs-png" class="qs-btn qs-btn--accent" type="button" disabled>Download PNG</button>
          <button id="qs-svg" class="qs-btn" type="button" disabled title="Crisp at any size; best for print">Download SVG</button>
        </div>
        <details class="qs-payload">
          <summary>Encoded payload</summary>
          <pre class="qs-code"><code id="qs-payload"></code></pre>
        </details>
      </div>
    </div>
  </section>

  <!-- ===================== SCAN ===================== -->
  <section id="qs-scan" class="qs-panel" role="tabpanel" hidden>
    <div class="qs-grid">
      <div class="qs-left">
        <div id="qs-drop" class="qs-drop">
          <input id="qs-file" type="file" accept="image/*" hidden style="display:none!important">
          <div class="qs-drop__hint"><strong>Drop an image of a QR code here</strong><br>or click to choose one</div>
        </div>
        <div class="qs-camrow">
          <button id="qs-cam" class="qs-btn" type="button">Use camera</button>
          <button id="qs-cam-stop" class="qs-btn" type="button" hidden>Stop camera</button>
        </div>
        <video id="qs-video" class="qs-video" muted playsinline hidden></video>
        <p class="qs-camnote" id="qs-camnote"></p>
      </div>
      <div class="qs-right">
        <h2 class="qs-h">Result</h2>
        <p class="qs-status" id="qs-scan-status">Nothing decoded yet.</p>
        <div id="qs-result" hidden>
          <pre class="qs-code qs-code--result"><code id="qs-decoded"></code></pre>
          <p class="qs-warn" id="qs-linkwarn" hidden>This decodes to a link, shown as plain text on
          purpose. Check it before you open it. A code on a poster or sticker can point anywhere,
          including lookalike domains.</p>
          <button id="qs-copy" class="qs-btn" type="button">Copy text</button>
        </div>
      </div>
    </div>
  </section>

  <details class="qs-note">
    <summary>Static vs. dynamic QR codes, and why it matters for print</summary>
    <p>Every code this page makes is static. The text is encoded directly in the black and white
    pattern, so the code carries its own data and works for as long as the print survives.
    Nothing sits between the scan and the destination.</p>
    <p>Many free QR services generate dynamic codes instead. Those encode a short link that
    bounces through the company's server on the way to the real destination. That design lets
    the service count scans and lets you change the destination later, but it also ties your
    code to the company. When the free tier lapses or the service shuts down, every printed
    code that points at it stops working. There are plenty of dead menus and posters out there
    for exactly this reason. If you are printing something meant to last, use a static code.
    There is nothing in it to expire.</p>
  </details>

  <p class="qs-privacy">🔒 Everything runs locally in your browser. What you encode or scan never
  leaves your device. (I use Google Analytics to see whether anyone visits this page, but it
  cannot see your data.)</p>
  <p class="qs-privacy" style="margin-top:0.35rem">A caveat: this is a personal side project and I make
  no guarantees; test a generated code with the scanner here (or your phone) before printing it
  somewhere important.</p>
  <p class="qs-credit">Built on two open-source libraries:
    <a href="https://github.com/kazuhikoarase/qrcode-generator" target="_blank" rel="noopener">qrcode-generator</a>
    by Kazuhiko Arase (MIT) for encoding, and
    <a href="https://github.com/cozmo/jsQR" target="_blank" rel="noopener">jsQR</a>
    (Apache&nbsp;2.0) for decoding. Thank you to their authors.
    QR Code is a registered trademark of DENSO WAVE INCORPORATED.</p>
</div>

<style>
/* This is a utility, not an article — let it use more width than the reading column. */
#main { max-width: 1200px; }
.page { float: none; width: 100%; padding-left: 0; padding-right: 0; }
.page__inner-wrap, .page__content { max-width: 100%; }
.qs-wrap { max-width: 1040px; margin: 0 auto; }
.qs-wrap [hidden] { display: none !important; }   /* the hidden attr loses to display: rules otherwise */
.qs-intro { max-width: 66ch; opacity: 0.9; line-height: 1.6; }

/* Segmented Generate / Scan control */
.qs-tabs { display: inline-flex; border: 1px solid rgba(127,127,127,0.4); border-radius: 8px; overflow: hidden; margin: 0.5rem 0 1.3rem; }
.qs-tab { font: inherit; color: inherit; background: transparent; border: none; padding: 0.5em 1.4em; cursor: pointer; transition: background 0.15s ease; }
.qs-tab:hover:not(.qs-tab--on) { background: rgba(127,127,127,0.14); }
.qs-tab--on { background: #82a6cc; color: #fff; cursor: default; }
html[data-theme="light"] .qs-tab--on { background: #34568a; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .qs-tab--on { background: #34568a; } }

.qs-grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 1.6rem; align-items: start; }
@media (max-width: 760px) { .qs-grid { grid-template-columns: 1fr; } }

.qs-h { font-size: 1.1rem; margin: 0 0 0.6rem; }
.qs-h--gap { margin-top: 1.4rem; }
.qs-field { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.95em; margin-bottom: 0.8rem; }
/* Solid, high-contrast controls (the theme's faint form styling washes these out). */
.qs-field select, .qs-field input[type="text"], .qs-field input[type="number"], .qs-field textarea {
  font: inherit; padding: 0.45em 0.5em; border-radius: 6px;
  color: #e8e8e8; background: #20242c; border: 1px solid rgba(255,255,255,0.18); box-shadow: none;
}
.qs-field select option { color: #e8e8e8; background: #20242c; }
.qs-field textarea { resize: vertical; line-height: 1.45; }
.qs-check { display: inline-flex; align-items: center; gap: 0.45rem; font-size: 0.95em; margin-bottom: 0.8rem; cursor: pointer; }
.qs-check input { accent-color: #82a6cc; width: 1.05em; height: 1.05em; }
html[data-theme="light"] .qs-field select, html[data-theme="light"] .qs-field input[type="text"], html[data-theme="light"] .qs-field input[type="number"], html[data-theme="light"] .qs-field textarea { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.2); }
html[data-theme="light"] .qs-field select option { color: #1f2430; background: #fff; }
html[data-theme="light"] .qs-check input { accent-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .qs-field select, html:not([data-theme="dark"]) .qs-field input[type="text"], html:not([data-theme="dark"]) .qs-field input[type="number"], html:not([data-theme="dark"]) .qs-field textarea { color: #1f2430; background: #fff; border-color: rgba(0,0,0,0.2); }
  html:not([data-theme="dark"]) .qs-field select option { color: #1f2430; background: #fff; }
  html:not([data-theme="dark"]) .qs-check input { accent-color: #34568a; }
}

/* The QR itself stays black on white on both themes, on a white card, for scannability. */
.qs-card {
  background: #fff; border: 1px solid rgba(127,127,127,0.35); border-radius: 14px;
  padding: 14px; max-width: 360px; box-shadow: 0 4px 18px rgba(0,0,0,0.18);
}
.qs-canvas { display: block; width: 100%; height: auto; }
.qs-meta { font-size: 0.85em; opacity: 0.75; min-height: 1.2em; margin: 0.6rem 0 0.5rem; font-variant-numeric: tabular-nums; }
.qs-dl { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.qs-payload { margin-top: 0.9rem; font-size: 0.9em; }
.qs-payload summary { cursor: pointer; opacity: 0.75; font-size: 0.92em; }

.qs-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14);
  border-radius: 6px; padding: 0.55em 0.9em; transition: background 0.15s ease;
}
.qs-btn:hover:not(:disabled) { background: rgba(127,127,127,0.26); }
.qs-btn:disabled { opacity: 0.45; cursor: default; }
.qs-btn--accent { background: #82a6cc; border-color: #82a6cc; color: #fff; }
.qs-btn--accent:hover:not(:disabled) { background: #6f97c2; }
html[data-theme="light"] .qs-btn--accent { background: #34568a; border-color: #34568a; }
@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) .qs-btn--accent { background: #34568a; border-color: #34568a; } }

/* Scan side */
.qs-drop {
  position: relative; border: 2px dashed rgba(127,127,127,0.4); border-radius: 12px;
  background: rgba(127,127,127,0.06); min-height: 190px; cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.qs-drop--over { border-color: #82a6cc; background: rgba(130,166,204,0.10); }
#qs-file { display: none !important; }   /* the theme styles inputs, overriding the hidden attr */
.qs-drop__hint { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: max-content; max-width: 90%; text-align: center; opacity: 0.7; pointer-events: none; line-height: 1.6; }
.qs-camrow { display: flex; gap: 0.5rem; margin-top: 0.8rem; }
.qs-video { width: 100%; max-width: 480px; border-radius: 10px; background: #000; margin-top: 0.8rem; }
.qs-camnote { font-size: 0.85em; opacity: 0.8; min-height: 1.2em; margin: 0.5rem 0 0; }

.qs-status { font-size: 0.9em; opacity: 0.8; min-height: 1.2em; margin: 0 0 0.6rem; }
.qs-code { background: rgba(127,127,127,0.12); border: 1px solid rgba(127,127,127,0.25); border-radius: 8px; padding: 0.6em 0.8em; margin: 0 0 0.7rem; }
.qs-code code { white-space: pre-wrap; word-break: break-all; font-size: 0.88em; background: none; border: none; padding: 0; }
.qs-warn { font-size: 0.9em; opacity: 0.85; line-height: 1.55; border-left: 3px solid rgba(127,127,127,0.5); padding-left: 0.7em; margin: 0 0 0.8rem; }

.qs-note { margin: 1.6rem 0 0; font-size: 0.95em; max-width: 75ch; }
.qs-note summary { cursor: pointer; opacity: 0.85; }
.qs-note p { font-size: 0.92em; line-height: 1.6; opacity: 0.9; margin: 0.6rem 0 0; }
.qs-privacy { font-size: 0.82em; opacity: 0.7; margin: 1.1rem 0 0; }
.qs-credit { font-size: 0.8em; opacity: 0.6; line-height: 1.5; margin: 0.4rem 0 0; }
</style>

<script defer src="{{ '/assets/js/qrlib/qrcode.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/qrlib/jsQR.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/qrstudio.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
