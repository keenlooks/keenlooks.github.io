/* ==========================================================================
   canvas-edit.js — a tiny overlay editor for a number drawn on a canvas.
   --------------------------------------------------------------------------
   window.makeNumberOverlay(canvas) returns { open, hide, isOpen }. A gadget
   detects a tap/click on a number it drew, then calls open({x, y, value, width,
   onCommit, onDelete}) with the number's position in CANVAS CSS pixels. We show
   a text input (numeric keyboard on mobile) and, if onDelete is given, a "×"
   button. Enter / tapping away commits (parses the number with the visitor's
   locale: "1,5" is 1.5 in de-DE, "$1,000" is 1000 in en-US; the same parser as
   editable-values.js) and calls onCommit(value | null); × calls onDelete(); Escape cancels and
   calls onCancel if given (so a gadget that just ADDED the point can remove it
   again; editors on existing points simply omit onCancel). The overlay is
   clamped inside the canvas box so it never overflows the page on phones.

   Focus is deferred (setTimeout) so a real tap/click's default action — which
   moves focus to <body> — doesn't instantly blur+commit the input.
   ========================================================================== */
(function () {
  var css =
    '.canvas-num-wrap{position:absolute;z-index:6;display:none;align-items:center;gap:3px}' +
    '.canvas-num-edit,.canvas-num-del{font:600 13px "Source Sans 3",system-ui,sans-serif;border-radius:5px;' +
      'border:1px solid #82a6cc;background:#1f1f1f;color:#f0f0f0;box-shadow:0 2px 10px rgba(0,0,0,0.45)}' +
    '.canvas-num-edit{text-align:center;padding:3px 4px}' +
    '.canvas-num-del{cursor:pointer;width:26px;height:28px;line-height:1;padding:0;font-size:16px}' +
    '.canvas-num-del:hover{background:#34568a}' +
    'html[data-theme="light"] .canvas-num-edit,html[data-theme="light"] .canvas-num-del{background:#fff;color:#222;border-color:#34568a;box-shadow:0 2px 10px rgba(0,0,0,0.18)}' +
    '@media(prefers-color-scheme:light){html:not([data-theme="dark"]) .canvas-num-edit,html:not([data-theme="dark"]) .canvas-num-del{background:#fff;color:#222;border-color:#34568a}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

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

  /* A numeric value is shown in the visitor's own digits and decimal mark,
     without grouping, so committing it unchanged reads back the same number. */
  var NF_EDIT = null, NF_ASCII = null;
  try { NF_EDIT = new Intl.NumberFormat(NUM_LOC, { useGrouping: false, maximumFractionDigits: 6 }); } catch (e) {}
  try { NF_ASCII = new Intl.NumberFormat('en-US', { useGrouping: false, maximumFractionDigits: 6 }); } catch (e) {}
  /* a shown value that would not read back as itself falls back to plain ASCII digits:
     committing the overlay unchanged (Enter, or tapping away) must never lose the point */
  function shown(v) {
    if (!(typeof v === 'number' && isFinite(v) && NF_EDIT)) return v;
    var t = NF_EDIT.format(v), a = NF_ASCII ? NF_ASCII.format(v) : String(v);
    return parseLocaleNumber(t) === parseFloat(a) ? t : a;
  }

  window.makeNumberOverlay = function (canvas) {
    var container = canvas.parentNode;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    var wrap = document.createElement('span'); wrap.className = 'canvas-num-wrap';
    var input = document.createElement('input'); input.type = 'text'; input.inputMode = 'decimal'; input.className = 'canvas-num-edit';
    var del = document.createElement('button'); del.type = 'button'; del.className = 'canvas-num-del'; del.textContent = '×'; del.title = 'Delete this point';
    wrap.appendChild(input); wrap.appendChild(del);
    container.appendChild(wrap);
    var cur = null;

    function open(o) {
      cur = o;
      var w = o.width || 74;
      input.style.width = w + 'px';
      del.style.display = o.onDelete ? 'inline-block' : 'none';
      input.value = (o.value == null ? '' : shown(o.value));
      wrap.style.display = 'inline-flex';
      // measure the real rendered width (input padding/border + × button), then
      // clamp inside the canvas box so the overlay never overflows the page
      var totalW = wrap.offsetWidth || (w + (o.onDelete ? 29 : 0));
      var left = canvas.offsetLeft + o.x - totalW / 2;
      var maxL = canvas.offsetLeft + canvas.clientWidth - totalW - 2;
      if (left > maxL) left = maxL;
      if (left < canvas.offsetLeft + 2) left = canvas.offsetLeft + 2;
      wrap.style.left = left + 'px';
      wrap.style.top = (canvas.offsetTop + o.y - 14) + 'px';
      setTimeout(function () { input.focus(); input.select(); }, 0);
    }
    function commit() {
      if (!cur) return;
      var v = parseLocaleNumber(input.value);
      var cb = cur.onCommit; cur = null; wrap.style.display = 'none';
      cb(isNaN(v) ? null : v);
    }
    function remove() {
      if (!cur) return;
      var cb = cur.onDelete; cur = null; wrap.style.display = 'none';
      if (cb) cb();
    }
    /* Escape: close without committing, and let the opener undo a just-added
       point via onCancel (cur is nulled FIRST so the follow-on blur no-ops). */
    function cancel() {
      if (!cur) return;
      var cb = cur.onCancel; cur = null; wrap.style.display = 'none';
      if (cb) cb();
    }
    function hide() { cur = null; wrap.style.display = 'none'; }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', commit);
    // keep focus on the input when pressing ×, so blur doesn't commit before the delete fires
    del.addEventListener('pointerdown', function (e) { e.preventDefault(); e.stopPropagation(); });
    del.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); remove(); });
    wrap.addEventListener('pointerdown', function (e) { e.stopPropagation(); });

    return { open: open, hide: hide, isOpen: function () { return !!cur; } };
  };
})();
