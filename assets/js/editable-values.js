/* ==========================================================================
   editable-values.js — make a slider's value label click-to-type.
   --------------------------------------------------------------------------
   Any element with data-range="<rangeInputId>" becomes editable: click it,
   type a number, press Enter (or click away). We parse the number, set the
   linked <input type="range">, and dispatch its 'input' event — so each
   gadget's existing slider handler does the rest (state update + re-render,
   which reformats the label with its units). Units/commas in the displayed
   value are tolerated on input. Works alongside the slider; the slider keeps
   working normally.

   Typed numbers follow the visitor's locale: the decimal and group marks come
   from Intl, so a German visitor's "1,5" is 1.5 (not 15, not 1), "1.500,5" is
   1500.5, and Arabic-Indic or full-width digits work. A lone "," or "." that
   is not the locale's decimal mark counts as a thousands separator only when
   exactly three digits follow it ("1,000"), else as a decimal point ("1.5").
   If the text was not edited at all, the slider value is left alone (another
   gadget's label may be formatted for a different locale).

   The mousedown preventDefault stops the wrapping <label> from redirecting the
   click to the range input, so the value itself receives focus.
   ========================================================================== */
(function () {
  var css = '.editable-val{cursor:text;border-bottom:1px dashed rgba(127,127,127,0.55);outline:none}'
    + '.editable-val:hover{border-bottom-color:currentColor}'
    + '.editable-val:focus{border-bottom-style:solid;border-bottom-color:currentColor}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function selectAll(el) {
    try {
      var r = document.createRange(); r.selectNodeContents(el);
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    } catch (e) {}
  }
  /* the locale numbers are shown in (bonds.js, loans.js and the tools use the same rule):
     the visitor's, with Latin digits; right-to-left languages take en-US */
  var NUM_LOC = (function () {
    try {
      var l = new Intl.NumberFormat().resolvedOptions().locale;
      if (/^(ar|fa|ur|he|iw|yi|ps|sd|ug|ckb|dv|ks|syr)(-|$)/i.test(l)) return 'en-US';
      return l.replace(/-u-.*$/i, '') + '-u-nu-latn';
    } catch (e) { return undefined; }
  })();
  var SEP = (function () {
    var d = '.', g = ',';
    try {
      var parts = new Intl.NumberFormat(NUM_LOC).formatToParts(12345.6);
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'decimal') d = parts[i].value;
        else if (parts[i].type === 'group') g = parts[i].value;
      }
    } catch (e) {}
    return { d: d, g: g };
  })();
  /* the zero of every decimal-digit block a visitor's keyboard or Intl may produce: Arabic-Indic,
     Persian, N'Ko, Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada,
     Malayalam, Sinhala, Thai, Lao, Tibetan, Myanmar (two), Khmer, Mongolian, Limbu, New Tai Lue,
     Tai Tham (two), Balinese, Sundanese, Lepcha, Ol Chiki, Vai, Saurashtra, Kayah Li, Javanese,
     Myanmar Tai Laing, Cham, Meetei Mayek, full-width; plus the default locale's own digits */
  var DIGIT_ZEROS = [0x0660, 0x06F0, 0x07C0, 0x0966, 0x09E6, 0x0A66, 0x0AE6, 0x0B66, 0x0BE6, 0x0C66, 0x0CE6,
    0x0D66, 0x0DE6, 0x0E50, 0x0ED0, 0x0F20, 0x1040, 0x1090, 0x17E0, 0x1810, 0x1946, 0x19D0, 0x1A80, 0x1A90,
    0x1B50, 0x1BB0, 0x1C40, 0x1C50, 0xA620, 0xA8D0, 0xA900, 0xA9D0, 0xA9F0, 0xAA50, 0xABF0, 0xFF10];
  try {
    var z0 = new Intl.NumberFormat(undefined, { useGrouping: false }).format(0).charCodeAt(0);
    if (z0 > 0x7F && z0 < 0xD800 && DIGIT_ZEROS.indexOf(z0) < 0) DIGIT_ZEROS.push(z0);
  } catch (e) {}
  function digitsToAscii(s) {
    var out = '', i, k, j, z;
    for (i = 0; i < s.length; i++) {
      k = s.charCodeAt(i);
      if (k > 0x7F) for (j = 0; j < DIGIT_ZEROS.length; j++) { z = DIGIT_ZEROS[j]; if (k >= z && k <= z + 9) { k = 48 + k - z; break; } }
      out += String.fromCharCode(k);
    }
    return out;
  }
  /* First number in the text, read with the visitor's separators; NaN if none. */
  function parseLocaleNumber(text) {
    var s = digitsToAscii(String(text == null ? '' : text))
      .replace(/[\u2212\uFE63\uFF0D]/g, '-').replace(/\uFF0E/g, '.').replace(/\uFF0C/g, ',')
      .replace(/\u066B/g, 'D').replace(/(\d)\u066C(?=\d)/g, '$1')
      .replace(/(\d)[ \u00A0\u202F](?=\d{3}(?!\d))/g, '$1');            /* "1 000" in any locale */
    if (SEP.g !== '.' && SEP.g !== ',') {
      /* space-like or apostrophe group marks (fr-FR, de-CH): drop them between digits */
      var extra = (/\s/.test(SEP.g) ? ' \\u00A0\\u202F' : '') + (/['\u2019]/.test(SEP.g) ? "'\\u2019" : '');
      s = s.replace(new RegExp('(\\d)[' + extra + SEP.g.replace(/[\\\]^-]/g, '\\$&') + '](?=\\d)', 'g'), '$1');
    }
    var m = s.match(/(-?)((?:\d|[.,D]\d)[\d.,D]*)/);
    if (!m) return NaN;
    var t = m[2].replace(/[.,D]+$/, ''), out;
    var di = t.indexOf('D');
    if (di >= 0) {
      out = t.slice(0, di).replace(/[.,]/g, '') + '.' + t.slice(di + 1).replace(/[.,D]/g, '');
    } else {
      var lastDot = t.lastIndexOf('.'), lastCom = t.lastIndexOf(',');
      if (lastDot >= 0 && lastCom >= 0) {
        var dpos = Math.max(lastDot, lastCom);                          /* the later mark is the decimal */
        out = t.slice(0, dpos).replace(/[.,]/g, '') + '.' + t.slice(dpos + 1).replace(/[.,]/g, '');
      } else if (lastDot >= 0 || lastCom >= 0) {
        var c = lastDot >= 0 ? '.' : ',', pos = t.indexOf(c);
        if (pos !== t.lastIndexOf(c)) out = t.split(c).join('');        /* 1.000.000 */
        else {
          var head = t.slice(0, pos), tail = t.slice(pos + 1);
          var grouped = c !== SEP.d && /^[1-9]\d{0,2}$/.test(head) && /^\d{3}$/.test(tail);
          out = grouped ? head + tail : head + '.' + tail;
        }
      } else out = t;
    }
    var v = parseFloat(out);
    return isNaN(v) ? NaN : (m[1] ? -v : v);
  }
  window.parseLocaleNumber = window.parseLocaleNumber || parseLocaleNumber;

  function commit(el, range) {
    var raw = el.textContent;
    if (raw !== el._evShown) {
      var v = parseLocaleNumber(raw);
      if (!isNaN(v)) range.value = String(v);  // browser clamps to min/max/step on read
    }
    range.dispatchEvent(new Event('input', { bubbles: true }));  // gadget re-renders the label
  }
  /* The words around the value in its label row: "Interest rate (APR): <value>" gives the name
     "Interest rate (APR)"; "Term: <value> years" gives the unit "years". */
  function labelParts(el) {
    var p = el.parentNode, before = '', after = '', seen = false;
    for (var n = p ? p.firstChild : null; n; n = n.nextSibling) {
      if (n === el) { seen = true; continue; }
      if (n.nodeType === 1 && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(n.tagName)) continue;
      if (seen) after += n.textContent; else before += n.textContent;
    }
    return { name: before.replace(/\s+/g, ' ').replace(/[\s:]+$/, '').trim(), unit: after.replace(/\s+/g, ' ').trim() };
  }
  /* Screen readers: the value is named by its row ("Interest rate (APR), type a value"), and the
     paired slider speaks the formatted readout ("6.0%") instead of its raw number ("6"). */
  function syncA11y(el, range) {
    var parts = labelParts(el);
    var name = parts.name ? parts.name + ', type a value' : 'Type a value';
    if (el.getAttribute('aria-label') !== name) el.setAttribute('aria-label', name);
    if (document.activeElement === el) return;   /* mid-edit: keep the last committed readout */
    var vt = (el.textContent + (parts.unit ? ' ' + parts.unit : '')).replace(/\s+/g, ' ').trim();
    if (vt && range.getAttribute('aria-valuetext') !== vt) range.setAttribute('aria-valuetext', vt);
  }
  function enhance(el) {
    var range = document.getElementById(el.getAttribute('data-range'));
    if (!range) return;
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('role', 'textbox');
    el.setAttribute('inputmode', 'decimal');   /* numeric keypad on phones */
    el.setAttribute('title', 'Type a value');
    syncA11y(el, range);
    try {
      new MutationObserver(function () { syncA11y(el, range); })
        .observe(el.parentNode || el, { childList: true, characterData: true, subtree: true });
    } catch (e) {}
    el.addEventListener('pointerdown', function (e) { e.preventDefault(); el.focus(); selectAll(el); });
    el.addEventListener('focus', function () { el._evShown = el.textContent; selectAll(el); });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); range.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); }
    });
    el.addEventListener('blur', function () { commit(el, range); syncA11y(el, range); });
  }
  function init() {
    var els = document.querySelectorAll('.editable-val[data-range]');
    for (var i = 0; i < els.length; i++) enhance(els[i]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
