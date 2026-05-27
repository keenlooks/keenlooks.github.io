/* ==========================================================================
   canvas-edit.js — a tiny overlay editor for a number drawn on a canvas.
   --------------------------------------------------------------------------
   window.makeNumberOverlay(canvas) returns { open, hide, isOpen }. A gadget
   detects a tap/click on a number it drew, then calls open({x, y, value, width,
   onCommit, onDelete}) with the number's position in CANVAS CSS pixels. We show
   a text input (numeric keyboard on mobile) and, if onDelete is given, a "×"
   button. Enter / tapping away commits (parses the number, strips $ and commas)
   and calls onCommit(value | null); × calls onDelete(); Escape cancels.

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
      var totalW = w + (o.onDelete ? 29 : 0);
      wrap.style.left = (canvas.offsetLeft + o.x - totalW / 2) + 'px';
      wrap.style.top = (canvas.offsetTop + o.y - 14) + 'px';
      input.value = (o.value == null ? '' : o.value);
      wrap.style.display = 'inline-flex';
      setTimeout(function () { input.focus(); input.select(); }, 0);
    }
    function commit() {
      if (!cur) return;
      var v = parseFloat(String(input.value).replace(/[,$\s]/g, ''));
      var cb = cur.onCommit; cur = null; wrap.style.display = 'none';
      cb(isNaN(v) ? null : v);
    }
    function remove() {
      if (!cur) return;
      var cb = cur.onDelete; cur = null; wrap.style.display = 'none';
      if (cb) cb();
    }
    function hide() { cur = null; wrap.style.display = 'none'; }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); hide(); }
    });
    input.addEventListener('blur', commit);
    // keep focus on the input when pressing ×, so blur doesn't commit before the delete fires
    del.addEventListener('pointerdown', function (e) { e.preventDefault(); e.stopPropagation(); });
    del.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); remove(); });
    wrap.addEventListener('pointerdown', function (e) { e.stopPropagation(); });

    return { open: open, hide: hide, isOpen: function () { return !!cur; } };
  };
})();
