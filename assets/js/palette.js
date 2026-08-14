/* Command palette (design pass F1).
   Ctrl+K / Cmd+K anywhere, or "/" when not typing, opens a small search
   over the site's pages, toys, publications and talks, plus a few actions.
   The masthead magnifier button opens it too.

   Key handling runs at CAPTURE phase on window and stops propagation while
   the palette is open (and for the open keystrokes themselves), so the
   full-screen gadget hotkeys underneath (voyage's Esc ladder especially)
   never fire while the palette owns the keyboard.

   The index (assets/search-index.json, Liquid-generated) is fetched lazily
   on the first open and cached for the life of the page. */
(function () {
  'use strict';

  /* ---- pinned strings ---------------------------------------------- */
  var STR_PLACEHOLDER = 'Search pages, toys, papers';
  var STR_EMPTY = 'Nothing matches that.';
  var STR_HINT = 'Enter to open · Esc to close';

  var SEC_PAGES = 'Pages';
  var SEC_FUN = 'Fun and tools';
  var SEC_PUBS = 'Publications and talks';
  var SEC_ACTIONS = 'Actions';
  var SEC_RECENT = 'Recent';
  var SEC_ORDER = [SEC_RECENT, SEC_PAGES, SEC_FUN, SEC_PUBS, SEC_ACTIONS];

  var MAX_RESULTS = 12;
  var RECENT_KEY = 'palette-recent';
  var RECENT_CAP = 5;

  /* Empty-query "top entries" per section, by url. */
  var PAGE_TOP = ['/', '/fun/', '/publications/', '/cv/'];
  var FUN_TOP = ['/voyage/', '/fourinarow/', '/life/', '/computer/', '/pdftools/'];

  /* ---- locate our own script tag for site root + cache-buster ------- */
  var ROOT = '/', VQ = '';
  (function () {
    var s = document.currentScript;
    if (s && s.src) {
      var m = s.src.match(/^(.*\/)assets\/js\/palette\.js(\?.*)?$/);
      if (m) { ROOT = m[1]; VQ = m[2] || ''; }
    }
  })();
  var INDEX_URL = ROOT + 'assets/search-index.json' + VQ;

  /* ---- module state ------------------------------------------------- */
  var wrap = null, input = null, list = null;
  var isOpen = false;
  var index = null;        /* array from search-index.json, or null */
  var indexP = null;       /* in-flight fetch promise */
  var flat = [];           /* currently rendered entries, flat, in DOM order */
  var selIdx = -1;
  var prevFocus = null;
  var prevOverflow = '', prevPad = '';
  var closingTimer = null;

  /* ---- GadgetUI.isTyping semantics, inline (do not depend on
     gadget-ui.js being loaded on the page) ---------------------------- */
  function isTyping(e) {
    var t = e && e.target;
    if (!t) return false;
    var tag = (t.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'select' || !!t.isContentEditable) return true;
    if (tag !== 'input') return false;
    var ty = (t.type || 'text').toLowerCase();
    var k = e.key;
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
    return true;
  }

  /* ---- actions ------------------------------------------------------ */
  function actSwitchTheme() {
    close();
    var btn = document.getElementById('theme-toggle');
    if (btn) { btn.click(); return; }
    var cur = document.documentElement.getAttribute('data-theme');
    if (cur !== 'light' && cur !== 'dark') {
      cur = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
    }
    var next = (cur === 'light') ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) {}
  }

  function actRandomFun() {
    var pool = [];
    var here = window.location.pathname;
    if (index) {
      for (var i = 0; i < index.length; i++) {
        if (index[i].kind === 'fun' && index[i].url !== here) pool.push(index[i]);
      }
    }
    if (!pool.length) { go({ title: 'Fun', url: ROOT.replace(/\/$/, '') + '/fun/', kind: 'page' }); return; }
    var pick = pool[Math.floor(Math.random() * pool.length)];
    go(pick);
  }

  function actCopyLink(el) {
    var url = window.location.href;
    var done = function () {
      /* brief visual confirmation on the row itself, then close */
      if (el) {
        var t = el.querySelector('.cmdk__item-t');
        if (t) t.textContent = 'Copied';
      }
      if (closingTimer) clearTimeout(closingTimer);
      closingTimer = setTimeout(function () { closingTimer = null; close(); }, 650);
    };
    var fallback = function () {
      try {
        var ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
        input.focus();
      } catch (e) { close(); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, fallback);
    } else {
      fallback();
    }
  }

  var ACTIONS = [
    { title: 'Switch theme', kind: 'action', desc: '', keys: 'dark light mode appearance toggle', run: actSwitchTheme },
    { title: 'Random fun page', kind: 'action', desc: '', keys: 'surprise toy gadget play', run: actRandomFun },
    { title: 'Copy link to this page', kind: 'action', desc: '', keys: 'share url clipboard', run: actCopyLink }
  ];

  /* ---- recents ------------------------------------------------------ */
  function loadRecents() {
    try {
      var raw = localStorage.getItem(RECENT_KEY);
      if (!raw) return [];
      var a = JSON.parse(raw);
      if (!(a instanceof Array)) return [];
      var out = [];
      for (var i = 0; i < a.length && out.length < RECENT_CAP; i++) {
        if (a[i] && typeof a[i].u === 'string' && typeof a[i].t === 'string') out.push(a[i]);
      }
      return out;
    } catch (e) { return []; }
  }

  function pushRecent(entry) {
    try {
      var a = loadRecents();
      var out = [{ u: entry.url, t: entry.title, k: entry.kind || 'page' }];
      for (var i = 0; i < a.length; i++) {
        if (a[i].u !== entry.url && out.length < RECENT_CAP) out.push(a[i]);
      }
      localStorage.setItem(RECENT_KEY, JSON.stringify(out));
    } catch (e) {}
  }

  /* ---- scoring ------------------------------------------------------ */
  function norm(s) { return (s || '').toLowerCase(); }

  function subseq(hay, needle) {
    var i = 0;
    for (var j = 0; j < needle.length; j++) {
      i = hay.indexOf(needle.charAt(j), i);
      if (i < 0) return false;
      i++;
    }
    return true;
  }

  function prep(e) {
    if (e._t === undefined) {
      e._t = norm(e.title);
      e._tw = e._t.split(/\s+/);
      /* desc + keys + the url slug: "/voyage/" must be findable as "voyage"
         even though the page is titled "Mission to Anywhere" */
      var slug = norm(e.url || '').replace(/[\/\-_.]+/g, ' ');
      e._h = ' ' + norm(e.desc) + ' ' + norm(e.keys) + ' ' + slug + ' ';
    }
    return e;
  }

  function scoreEntry(e, words) {
    prep(e);
    var total = 0;
    for (var i = 0; i < words.length; i++) {
      var w = words[i], s = 0;
      var pre = false;
      for (var j = 0; j < e._tw.length; j++) {
        if (e._tw[j].indexOf(w) === 0) { pre = true; break; }
      }
      if (pre) {
        s = 30;
        if (e._t.indexOf(w) === 0) s += 6; /* leading word */
      } else if (e._t.indexOf(w) >= 0) {
        s = 14;
      } else if (subseq(e._t, w)) {
        s = 5;
      }
      /* desc + keys, lower weight than the title */
      if (e._h.indexOf(' ' + w) >= 0) s += 8;
      else if (e._h.indexOf(w) >= 0) s += 4;
      if (s === 0) return 0; /* every query word must match somewhere */
      total += s;
    }
    return total;
  }

  function secOf(e) {
    if (e.kind === 'fun') return SEC_FUN;
    if (e.kind === 'pub' || e.kind === 'talk') return SEC_PUBS;
    if (e.kind === 'action') return SEC_ACTIONS;
    if (e.kind === 'recent') return SEC_RECENT;
    return SEC_PAGES;
  }

  /* ---- result building ---------------------------------------------- */
  function byUrl(url) {
    if (!index) return null;
    for (var i = 0; i < index.length; i++) if (index[i].url === url) return index[i];
    return null;
  }

  function emptyResults() {
    var out = [];
    var used = {};
    var rec = loadRecents();
    for (var r = 0; r < rec.length; r++) {
      out.push({ title: rec[r].t, url: rec[r].u, kind: 'recent', desc: '', keys: '' });
      used[rec[r].u] = true;
    }
    var i, e;
    for (i = 0; i < PAGE_TOP.length; i++) {
      e = byUrl(PAGE_TOP[i]);
      if (e && !used[e.url]) { out.push(e); used[e.url] = true; }
    }
    for (i = 0; i < FUN_TOP.length; i++) {
      e = byUrl(FUN_TOP[i]);
      if (e && !used[e.url]) { out.push(e); used[e.url] = true; }
    }
    if (index) {
      /* newest two publications + newest talk (collections are date-ascending) */
      var pubs = [], talks = [];
      for (i = 0; i < index.length; i++) {
        if (index[i].kind === 'pub') pubs.push(index[i]);
        else if (index[i].kind === 'talk') talks.push(index[i]);
      }
      var picks = pubs.slice(-2).reverse().concat(talks.slice(-1));
      for (i = 0; i < picks.length; i++) {
        if (!used[picks[i].url]) { out.push(picks[i]); used[picks[i].url] = true; }
      }
    }
    for (i = 0; i < ACTIONS.length; i++) out.push(ACTIONS[i]);
    return out;
  }

  function queryResults(q) {
    var words = norm(q).split(/\s+/).filter(function (w) { return w.length; });
    if (!words.length) return emptyResults();
    var scored = [];
    var all = (index || []).concat(ACTIONS);
    for (var i = 0; i < all.length; i++) {
      var s = scoreEntry(all[i], words);
      if (s > 0) scored.push({ e: all[i], s: s });
    }
    scored.sort(function (a, b) {
      if (b.s !== a.s) return b.s - a.s;
      return a.e.title.length - b.e.title.length;
    });
    var out = [];
    for (var j = 0; j < scored.length && j < MAX_RESULTS; j++) out.push(scored[j].e);
    return out;
  }

  /* ---- rendering ---------------------------------------------------- */
  function render(entries) {
    list.textContent = '';
    flat = [];
    selIdx = -1;
    if (!entries.length) {
      var em = document.createElement('div');
      em.className = 'cmdk__empty';
      em.textContent = STR_EMPTY;
      list.appendChild(em);
      input.removeAttribute('aria-activedescendant');
      return;
    }
    /* group into the pinned section order, keeping in-group order */
    for (var s = 0; s < SEC_ORDER.length; s++) {
      var sec = SEC_ORDER[s];
      var group = [];
      for (var i = 0; i < entries.length; i++) {
        if (secOf(entries[i]) === sec) group.push(entries[i]);
      }
      if (!group.length) continue;
      var head = document.createElement('div');
      head.className = 'cmdk__sec';
      head.setAttribute('role', 'presentation');
      head.textContent = sec;
      list.appendChild(head);
      for (var g = 0; g < group.length; g++) {
        var e = group[g];
        var el;
        if (e.kind === 'action') {
          el = document.createElement('button');
          el.type = 'button';
        } else {
          el = document.createElement('a');
          el.href = e.url;
        }
        el.className = 'cmdk__item';
        el.id = 'cmdk-opt-' + flat.length;
        el.setAttribute('role', 'option');
        el.setAttribute('tabindex', '-1');
        el.setAttribute('aria-selected', 'false');
        var t = document.createElement('span');
        t.className = 'cmdk__item-t';
        t.textContent = e.title;
        el.appendChild(t);
        if (e.desc && e.desc !== e.title) {
          var d = document.createElement('span');
          d.className = 'cmdk__item-d';
          d.textContent = e.desc;
          el.appendChild(d);
        }
        el.__entry = e;
        el.__idx = flat.length;
        list.appendChild(el);
        flat.push({ e: e, el: el });
      }
    }
    if (flat.length) {
      /* Results render grouped in the pinned section order, but the default
         selection is the BEST match (entries[0] is score order), so Enter
         always does the expected thing even when the top scorer's section
         renders further down. */
      var best = 0;
      for (var b = 0; b < flat.length; b++) {
        if (flat[b].e === entries[0]) { best = b; break; }
      }
      select(best, false);
    }
  }

  function select(i, scroll) {
    if (!flat.length) return;
    if (i < 0) i = flat.length - 1;
    if (i >= flat.length) i = 0;
    if (selIdx >= 0 && flat[selIdx]) {
      flat[selIdx].el.classList.remove('cmdk__item--sel');
      flat[selIdx].el.setAttribute('aria-selected', 'false');
    }
    selIdx = i;
    var el = flat[i].el;
    el.classList.add('cmdk__item--sel');
    el.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', el.id);
    if (scroll !== false && el.scrollIntoView) {
      el.scrollIntoView({ block: 'nearest' });
    }
  }

  function refresh() {
    render(queryResults(input.value));
  }

  /* ---- activation --------------------------------------------------- */
  function go(entry) {
    pushRecent(entry);
    window.location.href = entry.url;
  }

  function activate(entry, el) {
    if (!entry) return;
    if (entry.kind === 'action') { entry.run(el); return; }
    go(entry);
  }

  /* ---- open / close ------------------------------------------------- */
  function build() {
    if (wrap) return;
    wrap = document.createElement('div');
    wrap.className = 'cmdk';
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="cmdk__scrim"></div>' +
      '<div class="cmdk__panel" role="dialog" aria-modal="true" aria-label="Search this site">' +
        '<input class="cmdk__input" type="text" role="combobox" aria-expanded="true"' +
          ' aria-autocomplete="list" aria-controls="cmdk-list" autocomplete="off"' +
          ' autocorrect="off" autocapitalize="off" spellcheck="false">' +
        '<div class="cmdk__list" id="cmdk-list" role="listbox"></div>' +
        '<div class="cmdk__hint">' + STR_HINT + '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    input = wrap.querySelector('.cmdk__input');
    input.setAttribute('placeholder', STR_PLACEHOLDER);
    list = wrap.querySelector('.cmdk__list');

    input.addEventListener('input', refresh);

    wrap.querySelector('.cmdk__scrim').addEventListener('click', close);

    list.addEventListener('mousemove', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('.cmdk__item') : null;
      if (el && el.__idx !== undefined && el.__idx !== selIdx) select(el.__idx, false);
    });

    list.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('.cmdk__item') : null;
      if (!el || !el.__entry) return;
      var entry = el.__entry;
      if (entry.kind !== 'action' && (e.ctrlKey || e.metaKey || e.shiftKey)) {
        /* modified click on a link: let the browser open it its way */
        pushRecent(entry);
        return;
      }
      e.preventDefault();
      activate(entry, el);
    });
  }

  function open() {
    if (isOpen) return;
    build();
    isOpen = true;
    prevFocus = document.activeElement;
    /* lock body scroll, compensating for the scrollbar so nothing shifts */
    prevOverflow = document.body.style.overflow;
    prevPad = document.body.style.paddingRight;
    var sw = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (sw > 0) document.body.style.paddingRight = sw + 'px';
    wrap.hidden = false;
    input.value = '';
    refresh();
    input.focus();
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(function () {
        if (isOpen && document.activeElement !== input) input.focus();
      });
    }
    if (index === null && !indexP) {
      indexP = fetch(INDEX_URL)
        .then(function (r) { return r.json(); })
        .then(function (a) { index = (a instanceof Array) ? a : []; })
        .catch(function () { index = []; })
        .then(function () { if (isOpen) refresh(); });
    }
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    if (closingTimer) { clearTimeout(closingTimer); closingTimer = null; }
    wrap.hidden = true;
    document.body.style.overflow = prevOverflow;
    document.body.style.paddingRight = prevPad;
    if (prevFocus && prevFocus.focus && document.documentElement.contains(prevFocus)) {
      try { prevFocus.focus(); } catch (e) {}
    }
    prevFocus = null;
  }

  function toggle() { if (isOpen) close(); else open(); }

  /* ---- keyboard (single CAPTURE-phase handler on window) ------------ */
  function onKeydown(e) {
    if (e.isComposing) return;
    var k = e.key;

    if (isOpen) {
      /* Every key is ours while the palette is open; nothing may reach the
         page's own handlers (gadget hotkeys, voyage's Esc ladder, the
         pdftools editor). Browser defaults other than the keys we consume
         are left alone. */
      e.stopPropagation();
      if (k === 'Escape') { e.preventDefault(); close(); return; }
      if (k === 'Tab') { e.preventDefault(); input.focus(); return; }
      if (k === 'ArrowDown') { e.preventDefault(); select(selIdx + 1); return; }
      if (k === 'ArrowUp') { e.preventDefault(); select(selIdx - 1); return; }
      if (k === 'Enter') {
        e.preventDefault();
        if (selIdx >= 0 && flat[selIdx]) activate(flat[selIdx].e, flat[selIdx].el);
        return;
      }
      if ((k === 'k' || k === 'K') && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        close();
        return;
      }
      return;
    }

    if ((k === 'k' || k === 'K') && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      open();
      return;
    }
    if (k === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e)) {
      e.preventDefault();
      e.stopPropagation();
      open();
    }
  }

  window.addEventListener('keydown', onKeydown, true);

  /* ---- masthead button ---------------------------------------------- */
  function wireButton() {
    var btn = document.getElementById('palette-btn');
    if (btn) btn.addEventListener('click', function () { open(); });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireButton);
  } else {
    wireButton();
  }

  /* ---- test hook (read-mostly; real input drives the UI) ------------ */
  window.__cmdk = {
    open: open,
    close: close,
    isOpen: function () { return isOpen; },
    indexLen: function () { return index ? index.length : -1; },
    count: function () { return flat.length; },
    sel: function () { return (selIdx >= 0 && flat[selIdx]) ? flat[selIdx].e.url || flat[selIdx].e.title : null; },
    indexUrl: INDEX_URL
  };
})();
