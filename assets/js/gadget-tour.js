/* ==========================================================================
   gadget-tour.js — guided first-run tours for the dense gadget pages
   (design pass F3; spec in .claude/plans/plan-design-pass.md).

   window.GadgetUI.tour(key, steps, opts) registers a short coach-mark tour:
     steps  = [{ rect: fn|selector, text, side }]
              rect fn returns {x,y,w,h} / {left,top,width,height} (viewport
              px) or null; selector = querySelector target. Rects are
              re-evaluated on every reposition, so targets track a resize.
     side   = preferred card side: 'bottom' | 'top' | 'right' | 'left'.
     opts   = { when: fn -> false skips/ends the tour (wrong mode),
                settleMs: delay before the once-per-visitor auto-run,
                avoid: [fn|selector] rects the card should not cover
                (a page's control panel; soft: ignored when nothing fits) }.

   One coach card at a time with a soft accent focus ring around the target
   (no dark page veil; the site's language is understated). Next / Done and
   an X, Esc dismisses at CAPTURE so it never leaks to the gadget's own
   keydown handlers; while the tour is closed no key listener exists at all.
   Runs once per visitor (localStorage 'tour-<key>'); a page's ? button
   re-runs it because this file also REPLACES GadgetUI.firstRunHint on the
   pages that load it: the shimmed hint never auto-shows, and its .show()
   (which the ? buttons already call) starts the tour instead, falling back
   to the original one-line hint when the tour's `when` gate says the page
   is in the wrong mode. Reduced motion: no ring pulse, no fades.
   ========================================================================== */
(function () {
  'use strict';
  var GU = window.GadgetUI;
  /* never CREATE window.GadgetUI here: gadget-ui.js early-returns when the
     global already exists, which would strip every page of initPanel etc. */
  if (!GU || GU.tour) return;

  var css =
    '.gtour-ring{position:fixed;z-index:60;pointer-events:none;' +
      'border:2px solid #82a6cc;border-radius:10px;' +
      'box-shadow:0 0 0 3px rgba(130,166,204,0.18);' +
      'transition:left 0.28s ease,top 0.28s ease,width 0.28s ease,height 0.28s ease,opacity 0.25s ease;' +
      'opacity:0;}' +
    '.gtour-ring--show{opacity:1;}' +
    '.gtour-ring::after{content:"";position:absolute;inset:-7px;border-radius:14px;' +
      'border:4px solid rgba(130,166,204,0.35);' +
      'animation:gtour-pulse 1.9s ease-in-out infinite;}' +
    '@keyframes gtour-pulse{0%,100%{opacity:0.2;}50%{opacity:0.75;}}' +
    '.gtour-card{position:fixed;z-index:61;pointer-events:auto;box-sizing:border-box;' +
      'width:18.5rem;max-width:calc(100vw - 1.25rem);' +
      'padding:0.75rem 2.1rem 0.7rem 0.95rem;' +
      'border:1px solid rgba(255,255,255,0.12);border-radius:10px;' +
      'background:rgba(18,18,18,0.94);color:#d6d6d6;' +
      '-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);' +
      'box-shadow:0 6px 24px rgba(0,0,0,0.35);' +
      'font:400 0.92rem/1.5 "Source Sans 3",system-ui,sans-serif;' +
      'opacity:0;transition:opacity 0.25s ease;}' +
    '.gtour-card--show{opacity:1;}' +
    '.gtour-card__text{margin:0 0 0.6rem;}' +
    '.gtour-card__row{display:flex;align-items:center;gap:0.5rem;}' +
    '.gtour-dots{display:flex;gap:6px;margin-right:auto;align-items:center;}' +
    '.gtour-dot{width:7px;height:7px;border-radius:50%;background:rgba(127,127,127,0.45);}' +
    '.gtour-dot--on{background:#82a6cc;}' +
    '.gtour-btn{font:inherit;color:inherit;cursor:pointer;line-height:1;' +
      'border:1px solid #82a6cc;background:rgba(130,166,204,0.16);' +
      'border-radius:6px;padding:0.4em 0.9em;}' +
    '.gtour-btn:hover{background:rgba(130,166,204,0.3);}' +
    '.gtour-x{position:absolute;top:0.25rem;right:0.3rem;width:1.8em;height:1.8em;' +
      'font:inherit;line-height:1;color:inherit;background:none;border:0;' +
      'padding:0;cursor:pointer;opacity:0.55;}' +
    '.gtour-x:hover,.gtour-x:focus{opacity:1;}' +
    'html[data-theme="light"] .gtour-ring{border-color:#34568a;box-shadow:0 0 0 3px rgba(52,86,138,0.14);}' +
    'html[data-theme="light"] .gtour-ring::after{border-color:rgba(52,86,138,0.3);}' +
    'html[data-theme="light"] .gtour-card{background:rgba(255,255,255,0.97);color:#262626;' +
      'border-color:rgba(0,0,0,0.12);box-shadow:0 6px 24px rgba(0,0,0,0.15);}' +
    'html[data-theme="light"] .gtour-dot--on{background:#34568a;}' +
    'html[data-theme="light"] .gtour-btn{border-color:#34568a;background:rgba(52,86,138,0.12);}' +
    'html[data-theme="light"] .gtour-btn:hover{background:rgba(52,86,138,0.24);}' +
    '@media (prefers-color-scheme: light){' +
      'html:not([data-theme="dark"]) .gtour-ring{border-color:#34568a;box-shadow:0 0 0 3px rgba(52,86,138,0.14);}' +
      'html:not([data-theme="dark"]) .gtour-ring::after{border-color:rgba(52,86,138,0.3);}' +
      'html:not([data-theme="dark"]) .gtour-card{background:rgba(255,255,255,0.97);color:#262626;' +
        'border-color:rgba(0,0,0,0.12);box-shadow:0 6px 24px rgba(0,0,0,0.15);}' +
      'html:not([data-theme="dark"]) .gtour-dot--on{background:#34568a;}' +
      'html:not([data-theme="dark"]) .gtour-btn{border-color:#34568a;background:rgba(52,86,138,0.12);}' +
      'html:not([data-theme="dark"]) .gtour-btn:hover{background:rgba(52,86,138,0.24);}' +
    '}' +
    '@media (pointer: coarse){.gtour-btn{min-height:40px;}.gtour-x{min-width:36px;min-height:36px;}}' +
    '@media (prefers-reduced-motion: reduce){' +
      '.gtour-ring{transition:none;}.gtour-ring::after{animation:none;opacity:0.4;}' +
      '.gtour-card{transition:none;}}';
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  function seenKey(key) { try { return !!localStorage.getItem('tour-' + key); } catch (e) { return false; } }
  function markKey(key) { try { localStorage.setItem('tour-' + key, '1'); } catch (e) {} }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function normRect(r) {
    if (!r) return null;
    var x = (r.x != null) ? r.x : r.left;
    var y = (r.y != null) ? r.y : r.top;
    var w = (r.w != null) ? r.w : r.width;
    var h = (r.h != null) ? r.h : r.height;
    if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return null;
    if (w < 2 || h < 2) return null;
    return { x: x, y: y, w: w, h: h };
  }

  function stepRect(step) {
    try {
      if (typeof step.rect === 'function') return normRect(step.rect());
      if (typeof step.rect === 'string') {
        var el = document.querySelector(step.rect);
        return el ? normRect(el.getBoundingClientRect()) : null;
      }
    } catch (e) {}
    return null;
  }

  function overlaps(a, b, m) {
    return !(a.x + a.w + m <= b.x || b.x + b.w + m <= a.x ||
             a.y + a.h + m <= b.y || b.y + b.h + m <= a.y);
  }

  /* the page's registered tour (one per page in practice) */
  var registered = null;

  function tour(key, steps, opts) {
    opts = opts || {};
    if (!steps || !steps.length) return null;
    var idx = 0, active = false, built = false;
    var ring, card, txtEl, dotEls = [], nextBtn, xBtn, iv = null;

    function okToRun() {
      try { return !opts.when || opts.when() !== false; } catch (e) { return true; }
    }

    function build() {
      if (built) return;
      built = true;
      ring = document.createElement('div');
      ring.className = 'gtour-ring';
      ring.setAttribute('aria-hidden', 'true');
      card = document.createElement('div');
      card.className = 'gtour-card';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-label', 'Quick tour');
      txtEl = document.createElement('p');
      txtEl.className = 'gtour-card__text';
      txtEl.setAttribute('aria-live', 'polite');
      var row = document.createElement('div');
      row.className = 'gtour-card__row';
      var dots = document.createElement('div');
      dots.className = 'gtour-dots';
      dots.setAttribute('aria-hidden', 'true');
      for (var i = 0; i < steps.length; i++) {
        var d = document.createElement('span');
        d.className = 'gtour-dot';
        dots.appendChild(d);
        dotEls.push(d);
      }
      nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'gtour-btn';
      nextBtn.addEventListener('click', next);
      xBtn = document.createElement('button');
      xBtn.type = 'button';
      xBtn.className = 'gtour-x';
      xBtn.textContent = '×';
      xBtn.setAttribute('aria-label', 'Close the tour');
      xBtn.addEventListener('click', dismiss);
      row.appendChild(dots);
      row.appendChild(nextBtn);
      card.appendChild(xBtn);
      card.appendChild(txtEl);
      card.appendChild(row);
      /* keys pressed while the focus is inside the card belong to the card,
         never to the gadget's document/window hotkey handlers */
      card.addEventListener('keydown', function (e) { e.stopPropagation(); });
      document.body.appendChild(ring);
      document.body.appendChild(card);
    }

    function place() {
      if (!active) return;
      /* the page left the mode the tour teaches (e.g. Evolve pressed
         mid-tour): fold the tent quietly */
      if (!okToRun()) { dismiss(); return; }
      var vw = window.innerWidth, vh = window.innerHeight;
      var M = 10, TOP = 68, BOT = 60, GAP = 14, PAD = 6;
      var r = stepRect(steps[idx]);
      if (r) {
        var rx = Math.max(2, r.x - PAD), ry = Math.max(2, r.y - PAD);
        var rw = Math.min(vw - 4 - rx, r.w + PAD * 2);
        var rh = Math.min(vh - 4 - ry, r.h + PAD * 2);
        ring.style.left = rx + 'px';
        ring.style.top = ry + 'px';
        ring.style.width = Math.max(0, rw) + 'px';
        ring.style.height = Math.max(0, rh) + 'px';
        ring.classList.add('gtour-ring--show');
      } else {
        ring.classList.remove('gtour-ring--show');
      }
      var cw = card.offsetWidth, ch = card.offsetHeight;
      /* rects the card should stay off (a page's own control panel): soft
         constraint, dropped when no candidate clears them all */
      var avoid = [];
      if (opts.avoid) {
        for (var ai = 0; ai < opts.avoid.length; ai++) {
          var ar = stepRect({ rect: opts.avoid[ai] });
          if (ar) avoid.push(ar);
        }
      }
      function clearOfAvoid(box) {
        for (var k = 0; k < avoid.length; k++) {
          if (overlaps(box, avoid[k], 0)) return false;
        }
        return true;
      }
      var pos = null;
      if (r) {
        var cx = clamp(r.x + r.w / 2 - cw / 2, M, Math.max(M, vw - cw - M));
        var cy = clamp(r.y + r.h / 2 - ch / 2, TOP, Math.max(TOP, vh - ch - BOT));
        var cands = {
          bottom: { x: cx, y: r.y + r.h + GAP },
          top: { x: cx, y: r.y - ch - GAP },
          right: { x: r.x + r.w + GAP, y: cy },
          left: { x: r.x - cw - GAP, y: cy }
        };
        var order = ['bottom', 'top', 'right', 'left'];
        var pref = steps[idx].side;
        if (pref && cands[pref]) {
          order.splice(order.indexOf(pref), 1);
          order.unshift(pref);
        }
        for (var pass = 0; pass < 2 && !pos; pass++) {
          for (var i = 0; i < order.length && !pos; i++) {
            var p = cands[order[i]];
            var box = { x: p.x, y: p.y, w: cw, h: ch };
            if (p.x >= M && p.y >= TOP && p.x + cw <= vw - M && p.y + ch <= vh - BOT &&
                !overlaps(box, r, 4) &&
                (pass === 1 || clearOfAvoid(box))) pos = p;
          }
        }
        if (!pos) {
          /* nothing fits beside the target: take whichever screen strip
             above or below it has more room, never covering the target */
          var roomAbove = r.y - TOP, roomBelow = vh - BOT - (r.y + r.h);
          pos = { x: cx, y: roomBelow >= roomAbove ? Math.max(TOP, vh - BOT - ch) : TOP };
        }
      } else {
        pos = { x: Math.max(M, (vw - cw) / 2), y: Math.max(TOP, vh * 0.28) };
      }
      card.style.left = Math.round(pos.x) + 'px';
      card.style.top = Math.round(pos.y) + 'px';
    }

    function show(i) {
      idx = i;
      txtEl.textContent = steps[idx].text;
      nextBtn.textContent = (idx === steps.length - 1) ? 'Done' : 'Next';
      for (var k = 0; k < dotEls.length; k++) {
        dotEls[k].className = 'gtour-dot' + (k === idx ? ' gtour-dot--on' : '');
      }
      place();
      requestAnimationFrame(place);
    }

    function next() {
      if (idx < steps.length - 1) show(idx + 1); else dismiss();
    }

    /* CAPTURE phase: dismiss Esc before any gadget keydown handler can see
       it. stopImmediatePropagation stops the remaining document listeners
       AND the bubble to window (creatures listens there). Removed the
       moment the tour closes, so gadget Esc behavior is untouched then. */
    function keyCap(e) {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        e.stopImmediatePropagation();
        dismiss();
      }
    }

    function start(force) {
      if (!force && seenKey(key)) return;
      if (!okToRun()) return;
      markKey(key);
      build();
      if (active) { show(0); return; }
      active = true;
      card.style.display = 'block';
      document.addEventListener('keydown', keyCap, true);
      window.addEventListener('resize', place);
      iv = setInterval(place, 500);
      show(0);
      card.classList.add('gtour-card--show');
      /* keyboard reachability without yanking focus from live typing */
      var ae = document.activeElement;
      if (force || !ae || ae === document.body || ae === document.documentElement) {
        try { nextBtn.focus({ preventScroll: true }); } catch (e) {}
      }
    }

    function dismiss() {
      if (!active) return;
      active = false;
      document.removeEventListener('keydown', keyCap, true);
      window.removeEventListener('resize', place);
      if (iv) { clearInterval(iv); iv = null; }
      card.classList.remove('gtour-card--show');
      ring.classList.remove('gtour-ring--show');
      card.style.display = 'none';
      if (card.contains(document.activeElement)) {
        try { document.activeElement.blur(); } catch (e) {}
      }
    }

    var handle = {
      key: key,
      start: start,
      dismiss: dismiss,
      active: function () { return active; },
      okToRun: okToRun
    };
    registered = handle;

    /* the once-per-visitor auto-run, delayed so the page's layout (corner
       buttons, panel measurements, late chat bar) has settled first */
    if (!seenKey(key)) {
      setTimeout(function () {
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { start(false); });
        });
      }, opts.settleMs || 900);
    }
    return handle;
  }

  /* ---- firstRunHint replacement (these three pages only) -------------------
     The pages' ? buttons all route through a firstRunHint handle's .show()
     (fourinarow via initPanel's help hook, creatures via its per-mode
     ensure*Hint helpers). Shimming the factory sends those clicks to the
     tour instead, and the one-line hint never auto-shows here. When the
     tour's `when` gate refuses (creatures in evolve mode), the ORIGINAL
     hint is created lazily and shown, so mode-appropriate help survives. */
  var origHint = GU.firstRunHint;
  GU.firstRunHint = function (hintKey, text) {
    var real = null;
    return {
      show: function () {
        if (registered && registered.okToRun()) { registered.start(true); return; }
        if (!real) real = origHint.call(GU, hintKey, text);
        real.show();
      },
      dismiss: function () { if (real) real.dismiss(); }
    };
  };

  GU.tour = tour;
})();
