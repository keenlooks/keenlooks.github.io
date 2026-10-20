/* ==========================================================================
   gadget-ui.js — shared UI helpers for the full-screen Fun gadgets.
   --------------------------------------------------------------------------
   window.GadgetUI provides small primitives every gadget page uses:

   initPanel(opts)   — owns the top-right control panel's collapse state:
                       the toggle click handler, glyph flip (– open, +
                       collapsed), aria-expanded + aria-label updates, and
                       auto-collapse below 600px wide or 500px tall (phone
                       landscape) at init. Optionally wires a
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

   setHintObstacles(fn) — a page may hand over MORE boxes the hint must keep
                       off: fn returns an array of rects ({x,y,w,h} or
                       DOMRect-shaped), measured fresh on every placement.
                       Default is none, so a page that never calls this is
                       placed against the control panel exactly as before.
                       Pass null to clear. Registering also lets the plate be
                       lifted above the obstacles when its own row has no
                       room left, so a page that positions the hint's top
                       itself should not register (none of them do).

   placeHints()      — re-run the placement for every hint currently on
                       screen. A page whose obstacles move (a rail that
                       appears, a strip that grows) calls this from its own
                       layout(); the panel toggle and window resize already
                       call it internally.

   isTyping(e)       — true when a key event belongs to the focused control,
                       so gadget keyboard shortcuts stay out of its way.
                       Text-entry fields (text/search/number/email/url/
                       password/tel inputs, textarea, select, contenteditable)
                       own every key. Non-text controls (range, checkbox,
                       radio, buttons) own only their operating keys — arrows
                       and Home/End/Page on a slider, Space on a checkbox —
                       so page hotkeys like Space-to-pause and R-to-reset
                       stay alive after a click lands focus on a slider.

   coarse()          — true under a coarse (touch) primary pointer. At load,
                       every element carrying data-tap gets that text and
                       every data-tap-label becomes its aria-label, so static
                       copy says "Tap" to touch visitors and "Click" otherwise.

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
    '@media (prefers-reduced-motion: reduce){.gadget-hint{transition:none;}}' +
    touchCss();
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  /* Touch sizing for the older gadget panels (36 to 40 px targets under a
     coarse pointer). Scoped to these panels by id: the newer pages (voyage,
     observatory, Keep It Together, creatures, fourinarow, computer) size
     their own controls and are left exactly as they are. */
  function touchCss() {
    var ids = ['life', 'grav', 'mag', 'pend', 'epi', 'hash', 'adv', 'land', 'tt', 'fx'];
    function sel(tail) {
      return ids.map(function (k) { return '#' + k + '-panel ' + tail; }).join(',');
    }
    return '@media (pointer: coarse){' +
      sel('.gadget-help') + '{min-width:40px;min-height:40px;padding:0 0.6em;}' +
      sel('button') + '{min-width:36px;min-height:40px;}' +
      sel('select') + '{min-height:40px;}' +
      sel('input[type="checkbox"]') + '{width:20px;height:20px;flex:0 0 auto;}' +
      sel('label[class$="-check"]') + '{min-height:40px;}' +
    '}';
  }
  function isCoarse() {
    return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  }
  /* "Tap" for touch visitors: swap the static copy marked up for it */
  function tapWords() {
    if (!isCoarse() || !document.querySelectorAll) return;
    var i, n, els = document.querySelectorAll('[data-tap]');
    for (i = 0; i < els.length; i++) els[i].textContent = els[i].getAttribute('data-tap');
    els = document.querySelectorAll('[data-tap-label]');
    for (i = 0; i < els.length; i++) {
      n = els[i];
      n.setAttribute('aria-label', n.getAttribute('data-tap-label'));
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tapWords);
  else tapWords();

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
    /* small screens start collapsed, and so does a short one (a phone in
       landscape, where the open panel covered about a third of the stage);
       this also normalizes the glyph + aria at init */
    setCollapsed(window.innerWidth < 600 || window.innerHeight < 500);
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
     plate styling, pointer-events and dismiss behaviour are untouched.

     A page with more fixed furniture than a panel (the observatory grows an
     evidence rail, a key, a caption plate and a ticker while its tour runs)
     hands those boxes over with setHintObstacles, and they are then treated
     the same way the panel is. With none registered the law below reduces
     exactly to the panel-only placement described above, which is what the
     other twelve gadget pages get. */
  var HINT_GAP = 12;          /* breathing room at the screen edge and the panel */
  var HINT_STRIP_CENTER = 240; /* wider than this, centre the plate in the strip */
  var HINT_STRIP_MIN = 160;   /* narrower than this, nowhere better to go */
  var HINT_TOP_MIN = 0.15;    /* a lifted plate never climbs into the nav band */
  var panelEl = null;         /* most recently registered control panel */
  var obstacleFn = null;      /* a page's extra boxes, measured per placement */
  var openHints = [];         /* hint nodes currently on screen */
  var hintResizeOn = false;

  function fin(n) { return typeof n === 'number' && isFinite(n); }

  /* takes a DOMRect, a {left,top,width,height} or a {x,y,w,h}; anything with
     no real size is not an obstacle */
  function normRect(r) {
    if (!r) return null;
    var l = fin(r.left) ? r.left : r.x, t = fin(r.top) ? r.top : r.y;
    var w = fin(r.width) ? r.width : r.w, h = fin(r.height) ? r.height : r.h;
    if (!fin(l) || !fin(t) || !fin(w) || !fin(h) || w <= 0 || h <= 0) return null;
    return { left: l, top: t, right: l + w, bottom: t + h, width: w, height: h };
  }

  /* is anything really on top of the plate, rather than merely beside it or
     below it */
  function hintCovered(hintRect, blockers) {
    var hint = normRect(hintRect), i, r;
    if (!hint) return false;
    for (i = 0; blockers && i < blockers.length; i++) {
      r = normRect(blockers[i]);
      if (!r) continue;
      if (r.right > hint.left && r.left < hint.right &&
          r.bottom > hint.top && r.top < hint.bottom) return true;
    }
    return false;
  }

  /* The horizontal placement law, pure so a node test can drive it without a
     browser. Given the plate's rect where the page's own CSS puts it and the
     boxes it must keep off, it returns the strip to move into, or null for
     "leave it where the CSS put it" (nothing really covers it, or nothing
     better is on offer). Only boxes crossing the plate's own horizontal band
     count: a ticker along the bottom edge is not in the way of a plate at 38%
     height. */
  function hintStrip(hintRect, blockers, vw, opts) {
    var o = opts || {};
    var gap = fin(o.gap) ? o.gap : HINT_GAP;
    var min = fin(o.min) ? o.min : HINT_STRIP_MIN;
    var hint = normRect(hintRect);
    if (!hint || !fin(vw) || vw <= 0) return null;
    if (!hintCovered(hint, blockers)) return null;       /* already clear: leave it centred */
    var band = [], i, r;
    for (i = 0; blockers && i < blockers.length; i++) {
      r = normRect(blockers[i]);
      if (!r) continue;
      if (r.bottom <= hint.top || r.top >= hint.bottom) continue;   /* misses the band */
      band.push(r);
    }
    band.sort(function (a, b) { return a.left - b.left; });
    /* walk the band left to right, collecting what the blockers, each padded
       by the gap, leave behind */
    var free = [], x = gap, lim = vw - gap, a, b;
    for (i = 0; i < band.length; i++) {
      a = band[i].left - gap; b = band[i].right + gap;
      if (a > x) free.push({ left: x, right: a < lim ? a : lim });
      if (b > x) x = b;
    }
    if (x < lim) free.push({ left: x, right: lim });
    var best = null, w;
    for (i = 0; i < free.length; i++) {
      w = free[i].right - free[i].left;
      if (w < min) continue;                             /* no strip worth using */
      if (!best || w > best.width) best = { left: free[i].left, right: free[i].right, width: w };
    }
    return best;
  }

  /* The whole placement, strip plus an optional lift.

     A page dense enough to register obstacles can leave the plate's own row
     with nothing but slivers: on the observatory at 1280x800 the caption
     plate, the key, the evidence rail and the panel between them fill the row
     the hint sits on, and the widest gap left is 164px, which folds one
     sentence into a five line column. So when a page has opted in, the plate
     may also step UP, to just above something covering it, and the strip law
     runs again there. Every option is scored by how much of the plate's own
     natural width it keeps, and the plate stays where the page put it unless
     moving really does buy it room (equal room means no move). Up only, never
     down (the ticker and a phone's chat bar live at the bottom edge), never
     above HINT_TOP_MIN of the screen (the site nav band is up there), and
     ONLY when the page registered obstacles: the pages that set the hint's
     top themselves register none, so their top is never touched.

     Returns { top, strip }, either of which may be null (top null = leave the
     CSS top alone, strip null = the plate is clear where it is horizontally),
     or null for "leave the page's own CSS alone". */
  function hintPlace(hintRect, blockers, vw, opts) {
    var o = opts || {};
    var gap = fin(o.gap) ? o.gap : HINT_GAP;
    var vh = o.vh;
    var hint = normRect(hintRect);
    if (!hint || !fin(vw) || vw <= 0) return null;
    if (!hintCovered(hint, blockers)) return null;       /* nothing in the way */
    var here = hintStrip(hint, blockers, vw, o);
    var best = here ? { top: null, strip: here, room: Math.min(hint.width, here.width) } : null;
    if (!o.lift || !fin(vh) || vh <= 0) {                /* the default: no lift */
      return best ? { top: best.top, strip: best.strip } : null;
    }
    /* one candidate per box: the top the plate would need to clear it, kept
       only when that is a step UP. Every box, not only the ones covering the
       plate now: on a narrow screen the furniture is a stack of full width
       plates, and clearing the key lands the plate on the caption above it.
       Nearest first, so an equally roomy step is the smallest one. */
    var tops = [], i, r, t, shifted, s2, room;
    for (i = 0; blockers && i < blockers.length; i++) {
      r = normRect(blockers[i]);
      if (!r) continue;
      t = r.top - gap - hint.height;
      if (t < hint.top) tops.push(t);
    }
    tops.sort(function (a, b) { return b - a; });
    for (i = 0; i < tops.length; i++) {
      t = tops[i];
      if (!fin(t) || t < vh * HINT_TOP_MIN) continue;
      if (t + hint.height > vh - gap) continue;
      shifted = { left: hint.left, top: t, width: hint.width, height: hint.height };
      if (!hintCovered(shifted, blockers)) {
        /* clear up there: the plate keeps its whole width, which is the most
           any option can be worth, so nothing further along can beat it */
        if (!best || hint.width > best.room) best = { top: t, strip: null, room: hint.width };
        break;
      }
      s2 = hintStrip(shifted, blockers, vw, o);
      if (!s2) continue;
      room = Math.min(hint.width, s2.width);
      if (!best || room > best.room) best = { top: t, strip: s2, room: room };
    }
    return best ? { top: best.top, strip: best.strip } : null;
  }

  /* back to the page's own CSS; the top is only ever cleared when a previous
     placement is what set it (computer positions the plate from a measured
     bottom, and nothing here may take that over) */
  function hintReset(node) {
    var s = node.style;
    s.left = ''; s.right = ''; s.transform = ''; s.marginLeft = ''; s.marginRight = '';
    if (node.__ghTop) { s.top = ''; node.__ghTop = false; }
  }

  function hintApply(node, got, vw) {
    var s = node.style;
    if (fin(got.top)) { s.top = got.top + 'px'; node.__ghTop = true; }
    if (!got.strip) return;
    s.left = got.strip.left + 'px';
    s.right = (vw - got.strip.right) + 'px';
    s.transform = 'none';
    /* auto/auto centres the plate inside the strip; a narrow strip keeps it
       against the left edge so the text has as much room as it can get */
    s.marginLeft = got.strip.width >= HINT_STRIP_CENTER ? 'auto' : '0';
    s.marginRight = 'auto';
  }

  function placeHint(node) {
    if (!node || !node.parentNode) return;
    hintReset(node);                                     /* measure from the CSS, not from a previous placement */
    var blockers = [], extra = null, i, p;
    if (panelEl) {
      p = panelEl.getBoundingClientRect();
      if (p.width && p.height) blockers.push(p);         /* a hidden panel is not in the way */
    }
    if (obstacleFn) {
      try { extra = obstacleFn(); } catch (e) { extra = null; }
      for (i = 0; extra && i < extra.length; i++) {
        if (extra[i]) blockers.push(extra[i]);
      }
    }
    if (!blockers.length) return;
    var h = node.getBoundingClientRect();
    if (!h.width) return;
    var vw = document.documentElement.clientWidth || window.innerWidth;
    var vh = document.documentElement.clientHeight || window.innerHeight;
    var opts = { vh: vh, lift: !!obstacleFn };
    var got = hintPlace(h, blockers, vw, opts);
    if (!got) return;
    hintApply(node, got, vw);
    if (!obstacleFn) return;                             /* panel-only pages stop exactly here */
    /* A narrower strip wraps the text onto another line, and the taller plate
       can then reach something the first measurement cleared. The plate as it
       now really is gets one more pass; more than that would chase its own
       tail, and the first placement is kept when nothing better turns up. */
    var pass, now, next;
    for (pass = 0; pass < 2; pass++) {
      now = node.getBoundingClientRect();
      if (!hintCovered(now, blockers)) return;
      hintReset(node);
      next = hintPlace(now, blockers, vw, opts);
      if (!next) { hintApply(node, got, vw); return; }
      got = next;
      hintApply(node, got, vw);
    }
  }

  /* default off: a page opts in, and passing null puts it back to panel-only */
  function setHintObstacles(fn) {
    obstacleFn = typeof fn === 'function' ? fn : null;
    placeHints();
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
    setHintObstacles: setHintObstacles,
    placeHints: placeHints,
    isTyping: isTyping,
    liveStatus: liveStatus,
    coarse: isCoarse,
    /* the placement law on its own, for the node test in _tests/site/hint */
    PURE: { hintStrip: hintStrip, hintPlace: hintPlace, hintCovered: hintCovered }
  };
})();
