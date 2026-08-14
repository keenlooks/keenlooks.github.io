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
                       fade). If the viewport-centred plate would land on the
                       control panel (see placeHint) it is re-centred in the
                       free strip beside it.

   isTyping(e)       — true when a key event belongs to the focused control,
                       so gadget keyboard shortcuts stay out of its way.
                       Text-entry fields (text/search/number/email/url/
                       password/tel inputs, textarea, select, contenteditable)
                       own every key. Non-text controls (range, checkbox,
                       radio, buttons) own only their operating keys — arrows
                       and Home/End/Page on a slider, Space on a checkbox —
                       so page hotkeys like Space-to-pause and R-to-reset
                       stay alive after a click lands focus on a slider.

   liveStatus(el)    — mirrors el's textContent into a visually-hidden
                       role="status" div appended to document.body, so a
                       status line that lives inside a collapsible panel
                       still reaches screen readers when the panel is
                       display:none. Returns the mirror node (or null if el
                       is falsy).
   ========================================================================== */
(function () {
  if (window.GadgetUI) return;

  var css =
    '.gadget-help{font:inherit;line-height:1;cursor:pointer;color:inherit;background:none;border:0;' +
      'padding:0 0.35em;margin-left:auto;opacity:0.55;transition:opacity 0.15s ease;}' +
    '.gadget-help:hover,.gadget-help:focus{opacity:1;}' +
    '.gadget-hint{position:fixed;left:50%;top:38vh;transform:translateX(-50%);z-index:25;text-align:center;' +
      'pointer-events:none;max-width:min(34rem, calc(100vw - 2rem));' +
      'font:400 1.05rem/1.45 "Source Sans 3",system-ui,sans-serif;' +
      'padding:0.5rem 0.9rem;border-radius:8px;border:1px solid rgba(127,127,127,0.25);' +
      'background:rgba(18,18,18,0.85);color:#d6d6d6;' +
      'opacity:0;transition:opacity 0.5s ease;}' +
    '.gadget-hint--show{opacity:1;}' +
    'html[data-theme="light"] .gadget-hint{background:rgba(255,255,255,0.92);color:#3a3a3a;}' +
    '@media (prefers-color-scheme: light){html:not([data-theme="dark"]) .gadget-hint{background:rgba(255,255,255,0.92);color:#3a3a3a;}}' +
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
    panelEl = panel;                                     /* for placeHint */
    function setCollapsed(c) {
      panel.classList.toggle(cls, c);
      btn.textContent = c ? '+' : '–';
      btn.setAttribute('aria-expanded', c ? 'false' : 'true');
      btn.setAttribute('aria-label', c ? 'Show controls' : 'Hide controls');
      if (opts.onToggle) opts.onToggle(c);
      placeHints();                    /* the panel's width just changed */
    }
    btn.addEventListener('click', function () {
      setCollapsed(!panel.classList.contains(cls));
    });
    /* small screens start collapsed; this also normalizes the glyph + aria at init */
    setCollapsed(window.innerWidth < 600);
    /* every page calls firstRunHint before initPanel, so this is where a hint
       that is already on screen first learns where the panel is */
    placeHints();
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

  /* ---- hint placement ------------------------------------------------------
     The hint is a plate centred on the viewport; the control panel is a
     translucent box pinned to the top-right corner. Between roughly 600 and
     1100px wide the two overlap, and because the plate is opaque it washes
     out the panel showing through above it (panel z 30, hint z 25) and can
     bury a control. When the two rects really do intersect, the hint is
     re-centred in the free strip left of the panel instead. Only left/right/
     transform/margins are touched: several pages set the hint's top
     themselves (voyage 58vh, computer a bottom offset in landscape), and the
     plate styling, pointer-events and dismiss behaviour are untouched. */
  var HINT_GAP = 12;          /* breathing room at the screen edge and the panel */
  var HINT_STRIP_CENTER = 240; /* wider than this, centre the plate in the strip */
  var HINT_STRIP_MIN = 160;   /* narrower than this, nowhere better to go */
  var panelEl = null;         /* most recently registered control panel */
  var openHints = [];         /* hint nodes currently on screen */
  var hintResizeOn = false;

  function placeHint(node) {
    if (!node || !node.parentNode) return;
    /* measure from the page's own CSS, not from a previous placement */
    var s = node.style;
    s.left = ''; s.right = ''; s.transform = ''; s.marginLeft = ''; s.marginRight = '';
    if (!panelEl) return;
    var p = panelEl.getBoundingClientRect();
    if (!p.width || !p.height) return;                   /* hidden panel */
    var h = node.getBoundingClientRect();
    if (!h.width) return;
    if (h.right <= p.left || h.left >= p.right) return;  /* clear horizontally */
    if (h.bottom <= p.top || h.top >= p.bottom) return;  /* clear vertically */
    var strip = p.left - HINT_GAP * 2;
    if (strip < HINT_STRIP_MIN) return;                  /* no strip worth using */
    var vw = document.documentElement.clientWidth || window.innerWidth;
    s.left = HINT_GAP + 'px';
    s.right = (vw - (p.left - HINT_GAP)) + 'px';
    s.transform = 'none';
    /* auto/auto centres the plate inside the strip; a narrow strip keeps it
       against the left edge so the text has as much room as it can get */
    s.marginLeft = strip >= HINT_STRIP_CENTER ? 'auto' : '0';
    s.marginRight = 'auto';
  }

  function placeHints() {
    for (var i = 0; i < openHints.length; i++) placeHint(openHints[i]);
  }

  function trackHint(node) {
    if (openHints.indexOf(node) < 0) openHints.push(node);
    if (!hintResizeOn) {
      window.addEventListener('resize', placeHints);
      hintResizeOn = true;
    }
  }

  function untrackHint(node) {
    var i = openHints.indexOf(node);
    if (i >= 0) openHints.splice(i, 1);
    if (!openHints.length && hintResizeOn) {
      window.removeEventListener('resize', placeHints);
      hintResizeOn = false;
    }
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
      trackHint(node);
      placeHint(node);
    }
    function dismiss() {
      if (!visible || !node) return;
      visible = false;
      mark();
      var n = node;
      untrackHint(n);
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
    if (tag === 'textarea' || tag === 'select' || !!t.isContentEditable) return true;
    if (tag !== 'input') return false;
    var ty = (t.type || 'text').toLowerCase();
    var k = e.key;
    /* Non-text inputs are not "typing", but each still owns its operating
       keys: treating EVERY input as typing left page hotkeys dead after a
       click on a slider (the gadget canvases preventDefault pointerdown, so
       focus never left it), while handing a slider's arrows to the page
       would steal the keys the control actually uses. */
    if (ty === 'range') {
      return k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown' ||
             k === 'Home' || k === 'End' || k === 'PageUp' || k === 'PageDown';
    }
    if (ty === 'radio') {
      return k === ' ' || k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown';
    }
    if (ty === 'checkbox') return k === ' ';
    if (ty === 'button' || ty === 'submit' || ty === 'reset' || ty === 'file') {
      return k === ' ' || k === 'Enter';
    }
    /* text, search, number, email, url, password, tel, date… : real typing */
    return true;
  }

  function liveStatus(el) {
    el = byId(el);
    if (!el) return null;
    var mirror = document.createElement('div');
    mirror.style.position = 'absolute';
    mirror.style.width = '1px';
    mirror.style.height = '1px';
    mirror.style.overflow = 'hidden';
    mirror.style.clipPath = 'inset(50%)';
    mirror.style.whiteSpace = 'nowrap';
    mirror.setAttribute('role', 'status');
    mirror.setAttribute('aria-live', 'polite');
    document.body.appendChild(mirror);
    function sync() { mirror.textContent = el.textContent; }
    sync();
    var mo = new MutationObserver(sync);
    mo.observe(el, { childList: true, characterData: true, subtree: true });
    return mirror;
  }

  window.GadgetUI = {
    initPanel: initPanel,
    longPress: longPress,
    firstRunHint: firstRunHint,
    isTyping: isTyping,
    liveStatus: liveStatus
  };
})();
