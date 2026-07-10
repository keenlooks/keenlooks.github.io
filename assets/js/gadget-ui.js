/* ==========================================================================
   gadget-ui.js — shared UI helpers for the full-screen Fun gadgets.
   --------------------------------------------------------------------------
   window.GadgetUI provides small primitives every gadget page uses:

   initPanel(opts)   — owns the top-right control panel's collapse state:
                       the toggle click handler, glyph flip (– open, +
                       collapsed), aria-expanded + aria-label updates, and
                       auto-collapse below 600px at init. Optionally wires a
                       quiet "?" help button to re-show the first-run hint.
                       opts: { panel, toggle, collapsedClass, help, hint,
                       onToggle } (panel/toggle/help take an id or element).

   longPress(el, fn) — a touch/pen long-press (~450 ms; cancelled if the
                       pointer lifts early, moves more than ~8 px, or a
                       second finger lands) so touch users can reach the
                       right-click actions. Mouse is ignored by default
                       (mouse users have a real right-click), so it can
                       never break a mouse drag. Returns { cancel } so a
                       gadget can abort it when its own gesture logic
                       claims the pointer.

   firstRunHint(key, text) — a one-line ghosted hint fixed at ~38% viewport
                       height (DOM text, never canvas text, so the top-nav
                       vignette gotcha doesn't apply). Shown only while
                       localStorage['hint-<key>'] is unset; dissolves on the
                       first pointerdown anywhere and sets the flag. Returns
                       { show } so a "?" button can bring it back. Honors
                       prefers-reduced-motion (appears/disappears with no
                       fade).

   isTyping(e)       — true when a key event targets an input / textarea /
                       select / contenteditable, so gadget keyboard
                       shortcuts stay out of the way of typing.
   ========================================================================== */
(function () {
  if (window.GadgetUI) return;

  var css =
    '.gadget-help{font:inherit;line-height:1;cursor:pointer;color:inherit;background:none;border:0;' +
      'padding:0 0.35em;margin-left:auto;opacity:0.55;transition:opacity 0.15s ease;}' +
    '.gadget-help:hover,.gadget-help:focus{opacity:1;}' +
    '.gadget-hint{position:fixed;left:0;right:0;top:38vh;z-index:25;text-align:center;pointer-events:none;' +
      'font:400 1.05rem/1.45 "Source Sans 3",system-ui,sans-serif;color:rgba(127,127,127,0.95);' +
      'padding:0 1.2rem;opacity:0;transition:opacity 0.5s ease;}' +
    '.gadget-hint--show{opacity:1;}' +
    '@media (prefers-reduced-motion: reduce){.gadget-hint{transition:none;}}';
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  function byId(x) { return typeof x === 'string' ? document.getElementById(x) : x; }
  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function initPanel(opts) {
    var panel = byId(opts.panel), btn = byId(opts.toggle);
    if (!panel || !btn) return null;
    var cls = opts.collapsedClass;
    function setCollapsed(c) {
      panel.classList.toggle(cls, c);
      btn.textContent = c ? '+' : '–';
      btn.setAttribute('aria-expanded', c ? 'false' : 'true');
      btn.setAttribute('aria-label', c ? 'Show controls' : 'Hide controls');
      if (opts.onToggle) opts.onToggle(c);
    }
    btn.addEventListener('click', function () {
      setCollapsed(!panel.classList.contains(cls));
    });
    /* small screens start collapsed; this also normalizes the glyph + aria at init */
    setCollapsed(window.innerWidth < 600);
    var help = byId(opts.help);
    if (help && opts.hint) help.addEventListener('click', function () { opts.hint.show(); });
    return {
      setCollapsed: setCollapsed,
      collapsed: function () { return panel.classList.contains(cls); }
    };
  }

  function longPress(el, handler, opts) {
    opts = opts || {};
    var delay = opts.delay || 450, slop = opts.slop || 8;
    var timer = null, x0 = 0, y0 = 0, pid = null, downs = 0;
    function cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
      pid = null;
    }
    el.addEventListener('pointerdown', function (e) {
      downs++;
      if (downs > 1) { cancel(); return; }                 /* second finger = pinch, not a press */
      if (e.pointerType === 'mouse' && !opts.mouse) return; /* mouse users have a real right-click */
      x0 = e.clientX; y0 = e.clientY; pid = e.pointerId;
      var tgt = e.target, thisId = e.pointerId;
      timer = setTimeout(function () {
        timer = null;
        if (pid !== thisId) return;                        /* superseded or cancelled */
        pid = null;
        handler({ clientX: x0, clientY: y0, pointerId: thisId, target: tgt });
      }, delay);
    });
    el.addEventListener('pointermove', function (e) {
      if (pid !== e.pointerId) return;
      if (Math.abs(e.clientX - x0) > slop || Math.abs(e.clientY - y0) > slop) cancel();
    });
    function up(e) {
      if (downs > 0) downs--;
      if (pid === e.pointerId || downs === 0) cancel();
    }
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return { cancel: cancel };
  }

  function firstRunHint(key, text) {
    var K = 'hint-' + key, node = null, visible = false;
    function seen() { try { return !!localStorage.getItem(K); } catch (e) { return false; } }
    function mark() { try { localStorage.setItem(K, '1'); } catch (e) {} }
    function show() {
      if (!node) {
        node = document.createElement('div');
        node.className = 'gadget-hint';
        node.textContent = text;
        document.body.appendChild(node);
      }
      if (reducedMotion()) {
        node.classList.add('gadget-hint--show');
      } else {
        node.classList.remove('gadget-hint--show');
        void node.offsetWidth;                             /* restart the fade from 0 */
        node.classList.add('gadget-hint--show');
      }
      visible = true;
    }
    function dismiss() {
      if (!visible || !node) return;
      visible = false;
      mark();
      var n = node;
      if (reducedMotion()) {
        if (n.parentNode) n.parentNode.removeChild(n);
        node = null;
        return;
      }
      n.classList.remove('gadget-hint--show');
      setTimeout(function () {
        if (visible) return;                               /* re-shown before the fade finished */
        if (n.parentNode) n.parentNode.removeChild(n);
        if (node === n) node = null;
      }, 600);
    }
    /* the first pointerdown anywhere (canvas included) dissolves the hint */
    document.addEventListener('pointerdown', dismiss, true);
    if (!seen()) show();
    return { show: show, dismiss: dismiss };
  }

  function isTyping(e) {
    var t = e && e.target;
    if (!t) return false;
    var tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || !!t.isContentEditable;
  }

  window.GadgetUI = {
    initPanel: initPanel,
    longPress: longPress,
    firstRunHint: firstRunHint,
    isTyping: isTyping
  };
})();
