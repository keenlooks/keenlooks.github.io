/* Diff Checker (/diff/) — fully client-side. Nothing is uploaded; this file makes no
   network requests with your text. Diffing uses jsdiff (BSD-3-Clause), vendored locally
   under assets/js/difflib/. PDF text extraction lazily loads the already-vendored pdf.js
   (Apache-2.0) from assets/js/pdflib/ only when a PDF is dropped. The line diff runs in
   a Web Worker made from a Blob (it loads the same local jsdiff file), so dissimilar
   inputs never freeze the page.

   External file (never HTML-compressed) so // comments are fine here. */
(function () {
  'use strict';

  // ---- limits ----
  var AUTO_MAX = 200 * 1024;        // auto-compare below this many chars per input
  var HARD_MAX = 5 * 1024 * 1024;   // refuse to diff above this
  var PDF_FILE_MAX = 50 * 1024 * 1024; // PDFs are binary; the extracted text hits the caps above
  var CONTEXT = 3;                  // visible lines at each edge of a collapsed run
  var FOLD_MIN = 9;                 // unchanged runs LONGER than 8 lines collapse
  var WORD_PAIR_MAX_CHARS = 4000;   // skip word-level marks on very long line pairs
  var WORD_PAIRS_MAX = 500;         // total word-level diffs per compare
  var WORD_TIMEOUT_MS = 40;         // one word-level diff gives up (whole-line mark) after this
  var LINE_TIMEOUT_MS = 3000;       // the line diff (in the worker) gives up after this
  var SYNC_TIMEOUT_MS = 1500;       // ... and on the main thread, when no worker could start
  var PATCH_SYNC_MS = 40;           // Copy tries a quick in-gesture patch first (small inputs only)
  var SLICE_MS = 12;                // rendering yields to the browser after this much work
  var CHUNK_ROWS = 200;             // rows per .df-chunk (content-visibility: auto skips off-screen ones)

  function $(id) { return document.getElementById(id); }

  var taA, taB, out, statsEl, statusEl, noteEl, pdfNoteEl, compareBtn, copyBtn, wrapEl;
  var viewBtns = {};
  var fileNameA = '', fileNameB = '';
  var view = 'side';
  var lastHunks = null;
  var lastMeta = null;              // { textA, textB, adds, dels, rawEqual }
  var foldSeq = 0;
  var foldMap = {};                 // id -> { aStart, bStart, aLines, bLines }
  var debounceTimer = null;
  var wordBudget = 0;
  var pdfjsPromise = null;
  var compareSeq = 0;               // bumps on every compare; stale worker answers are dropped
  var renderJob = null;             // the time-sliced render in progress, if any
  var patchCache = null;            // { key, patch, full } kept for a second Copy click

  // ---------------------------------------------------------------- options

  function opts() {
    return {
      trim: $('df-trim').checked,
      allws: $('df-allws').checked,
      icase: $('df-case').checked
    };
  }

  function normLine(line, o) {
    var s = line;
    if (o.allws) s = s.replace(/\s+/g, '');
    else if (o.trim) s = s.trim();
    if (o.icase) s = s.toLowerCase();
    return s;
  }

  // ------------------------------------------------------------- computing

  /* Line-level diff. We diff normalized "keys" (so the ignore options apply) but keep
     pointers into the ORIGINAL lines so the output shows the real text of each side.
     jsdiff's diffLines reports a per-part `count` = number of lines, which is what lets
     us walk both originals in lockstep.

     lineParts is self-contained (it only uses normLine and the Diff it is handed): its
     source is also shipped into the Web Worker below, so the worker and the main-thread
     fallback run the very same code. It returns compact parts [kind, count] with kind
     1 = added, -1 = removed, 0 = equal. When jsdiff gives up (timeout) it returns
     gaveUp with the common leading/trailing line counts, and the caller shows the rest
     as fully replaced. */
  function lineParts(textA, textB, o, timeout, D) {
    var la = textA.split('\n'), lb = textB.split('\n');
    var ka = la.map(function (l) { return normLine(l, o); });
    var kb = lb.map(function (l) { return normLine(l, o); });
    /* The terminal '\n' makes jsdiff's token count equal split('\n').length on both
       sides in every trailing-newline case, so the walk can never drift. */
    var parts = D.diffLines(ka.join('\n') + '\n', kb.join('\n') + '\n', { timeout: timeout });
    if (parts) {
      return { parts: parts.map(function (p) { return [p.added ? 1 : (p.removed ? -1 : 0), p.count || 0]; }) };
    }
    var n = Math.min(ka.length, kb.length), pre = 0, suf = 0;
    while (pre < n && ka[pre] === kb[pre]) pre++;
    while (suf < n - pre && ka[ka.length - 1 - suf] === kb[kb.length - 1 - suf]) suf++;
    var out = [];
    if (pre) out.push([0, pre]);
    if (ka.length - pre - suf > 0) out.push([-1, ka.length - pre - suf]);
    if (kb.length - pre - suf > 0) out.push([1, kb.length - pre - suf]);
    if (suf) out.push([0, suf]);
    return { parts: out, gaveUp: true, pre: pre, suf: suf };
  }

  /* A unified patch that replaces the whole of A with the whole of B, formatted by
     jsdiff's own formatPatch exactly as its structuredPatch would format a diff made of
     one removal and one addition (the EOF-newline rules are copied from jsdiff 5.2.0).
     Used for Copy when the line diff gives up: still a valid patch, just not minimal. */
  function fullReplacePatch(nameA, nameB, a, b, D) {
    function lines(s) { return s === '' ? [] : s.replace(/\n$/, '').split('\n'); }
    var la = lines(a), lb = lines(b), body = [], i;
    for (i = 0; i < la.length; i++) body.push('-' + la[i]);
    for (i = 0; i < lb.length; i++) body.push('+' + lb[i]);
    var hunks = [];
    if (body.length) {
      var oldNl = /\n$/.test(a), newNl = /\n$/.test(b);
      var noNlBeforeAdds = body.length > la.length;
      if (!oldNl && noNlBeforeAdds && a.length > 0) body.splice(la.length, 0, '\\ No newline at end of file');
      if ((!oldNl && !noNlBeforeAdds) || !newNl) body.push('\\ No newline at end of file');
      hunks.push({ oldStart: 1, oldLines: la.length, newStart: 1, newLines: lb.length, lines: body });
    }
    return D.formatPatch({ oldFileName: nameA, newFileName: nameB, oldHeader: '', newHeader: '', hunks: hunks });
  }

  /* jsdiff's createTwoFilesPatch with a time limit. Returns { patch, full } or null when
     the diff gave up and fallback is false. */
  function makePatch(nameA, nameB, a, b, timeout, fallback, D) {
    var sp = D.structuredPatch(nameA, nameB, a, b, '', '', { timeout: timeout });
    if (sp) return { patch: D.formatPatch(sp), full: false };
    if (!fallback) return null;
    return { patch: fullReplacePatch(nameA, nameB, a, b, D), full: true };
  }

  // ---------------------------------------------------------- diff worker

  /* The line diff runs in a Web Worker built from a Blob, so the page never freezes on
     dissimilar inputs. The worker loads the same vendored jsdiff file the page loaded
     and runs the same functions as the fallback (their source is copied in). If a
     worker cannot be started, the work runs on the main thread with a short timeout. */
  var worker = null, workerFailed = false, workerUrl = null, workerReqs = {}, workerSeq = 0;

  function diffLibUrl() {
    var s = document.querySelector('script[src*="difflib/diff.js"]');
    return s && s.src ? s.src : assetBase() + 'difflib/diff.js';
  }

  function killWorker(reason) {
    if (worker) { try { worker.terminate(); } catch (e) { /* gone */ } }
    worker = null;
    if (workerUrl) { try { URL.revokeObjectURL(workerUrl); } catch (e) { /* ignore */ } workerUrl = null; }
    var reqs = workerReqs;
    workerReqs = {};
    Object.keys(reqs).forEach(function (k) { reqs[k].reject(reason || new Error('cancelled')); });
  }

  function getWorker() {
    if (workerFailed || typeof Worker === 'undefined' || typeof Blob === 'undefined' || !window.URL) return null;
    if (worker) return worker;
    try {
      var src = 'importScripts(' + JSON.stringify(diffLibUrl()) + ');\n' +
        normLine.toString() + '\n' + lineParts.toString() + '\n' +
        fullReplacePatch.toString() + '\n' + makePatch.toString() + '\n' +
        'onmessage = function (e) {\n' +
        '  var d = e.data, r;\n' +
        '  try {\n' +
        '    r = d.op === "patch" ? makePatch(d.nameA, d.nameB, d.a, d.b, d.timeout, true, self.Diff)\n' +
        '                         : lineParts(d.a, d.b, d.o, d.timeout, self.Diff);\n' +
        '  } catch (err) { r = { error: String((err && err.message) || err) }; }\n' +
        '  r.id = d.id; postMessage(r);\n' +
        '};\n';
      workerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      worker = new Worker(workerUrl);
      worker.onmessage = function (e) {
        var r = e.data, req = r && workerReqs[r.id];
        if (!req) return;
        delete workerReqs[r.id];
        if (r.error) req.reject(new Error(r.error)); else req.resolve(r);
      };
      /* A failed importScripts or a blocked worker lands here: fall back for good. */
      worker.onerror = function (e) {
        if (e && e.preventDefault) e.preventDefault();
        workerFailed = true;
        killWorker(new Error('worker failed'));
      };
      return worker;
    } catch (e) {
      workerFailed = true;
      worker = null;
      return null;
    }
  }

  /* Run one job in the worker; falls back to the main thread when it cannot. The
     returned promise rejects with { cancelled: true } when a newer job replaced it. */
  function inWorker(msg, fallback) {
    var w = getWorker();
    if (!w) {
      return new Promise(function (resolve) { resolve(fallback()); });
    }
    var id = ++workerSeq;
    msg.id = id;
    return new Promise(function (resolve, reject) {
      workerReqs[id] = { resolve: resolve, reject: reject };
      w.postMessage(msg);
    }).catch(function (err) {
      if (err && err.message === 'worker failed') return fallback();
      throw err;
    });
  }

  /* Only one compare matters at a time: a new one stops the worker (abandoning the old,
     possibly long, diff) and starts a fresh one. */
  function cancelWorkerJobs() {
    if (worker && Object.keys(workerReqs).length) killWorker({ cancelled: true });
  }

  function buildHunks(parts, linesA, linesB) {
    var hunks = [];
    var ai = 0, bi = 0;
    parts.forEach(function (pp) {
      var p = { added: pp[0] === 1, removed: pp[0] === -1, count: pp[1] };
      var n = p.count || 0;
      if (p.added) {
        hunks.push({ t: 'add', b: linesB.slice(bi, bi + n), bStart: bi });
        bi += n;
      } else if (p.removed) {
        hunks.push({ t: 'del', a: linesA.slice(ai, ai + n), aStart: ai });
        ai += n;
      } else {
        hunks.push({ t: 'eq', a: linesA.slice(ai, ai + n), b: linesB.slice(bi, bi + n), aStart: ai, bStart: bi });
        ai += n; bi += n;
      }
    });
    // merge adjacent del+add (either order) into "changed" hunks for pairing
    var merged = [];
    for (var i = 0; i < hunks.length; i++) {
      var h = hunks[i], nx = hunks[i + 1];
      if (h.t === 'del' && nx && nx.t === 'add') {
        merged.push({ t: 'chg', a: h.a, aStart: h.aStart, b: nx.b, bStart: nx.bStart });
        i++;
      } else if (h.t === 'add' && nx && nx.t === 'del') {
        merged.push({ t: 'chg', a: nx.a, aStart: nx.aStart, b: h.b, bStart: h.bStart });
        i++;
      } else {
        merged.push(h);
      }
    }
    /* Cosmetic: when BOTH texts end with a newline, the split arrays end in a shared
       empty "line". Drop it so the view does not show a phantom blank context row.
       (If only one side gained a trailing newline it stays visible as an added or
       removed empty line, which is the honest rendering.) */
    var lastH = merged[merged.length - 1];
    if (lastH && lastH.t === 'eq' &&
        lastH.a.length && lastH.a[lastH.a.length - 1] === '' && lastH.b[lastH.b.length - 1] === '' &&
        lastH.aStart + lastH.a.length === linesA.length && lastH.bStart + lastH.b.length === linesB.length) {
      lastH.a = lastH.a.slice(0, -1);
      lastH.b = lastH.b.slice(0, -1);
      if (!lastH.a.length) merged.pop();
    }
    return merged;
  }

  /* Word-level segments for one changed line pair. Returns { left: segs, right: segs }
     where each seg is { text, mark } — or null when skipped (too long / budget spent).
     Segments are sliced back out of the ORIGINAL strings by token length so the line is
     reconstructed exactly even with ignoreCase on. */
  function wordSegs(oldLine, newLine, o) {
    if (oldLine.length + newLine.length > WORD_PAIR_MAX_CHARS) return null;
    if (wordBudget <= 0) return null;
    wordBudget--;
    var parts;
    try {
      parts = window.Diff.diffWordsWithSpace(oldLine, newLine, { ignoreCase: !!o.icase, timeout: WORD_TIMEOUT_MS });
    } catch (e) { return null; }
    if (!parts) return null;      // gave up: the whole line is marked instead
    var left = [], right = [];
    var pa = 0, pb = 0;
    parts.forEach(function (p) {
      var len = p.value.length;
      if (!p.added) { // equal or removed: exists on the left
        left.push({ text: oldLine.substr(pa, len), mark: p.removed ? 'del' : null });
        pa += len;
      }
      if (!p.removed) { // equal or added: exists on the right
        right.push({ text: newLine.substr(pb, len), mark: p.added ? 'add' : null });
        pb += len;
      }
    });
    if (pa < oldLine.length) left.push({ text: oldLine.slice(pa), mark: null });
    if (pb < newLine.length) right.push({ text: newLine.slice(pb), mark: null });
    return { left: left, right: right };
  }

  // ------------------------------------------------------------- rendering

  function rowEl(kind, num, content, extraGutter) {
    var r = document.createElement('div');
    r.className = 'df-row df-' + kind;
    var g = document.createElement('span');
    g.className = 'df-ln';
    g.textContent = num == null ? '' : String(num);
    r.appendChild(g);
    if (extraGutter !== undefined) {
      var g2 = document.createElement('span');
      g2.className = 'df-ln';
      g2.textContent = extraGutter == null ? '' : String(extraGutter);
      r.appendChild(g2);
      var pre = document.createElement('span');
      pre.className = 'df-pre';
      pre.textContent = kind === 'add' ? '+' : (kind === 'del' ? '-' : ' ');
      r.appendChild(pre);
    }
    var c = document.createElement('span');
    c.className = 'df-code';
    if (content == null) {
      // placeholder cell (other side has no matching line)
    } else if (typeof content === 'string') {
      c.textContent = content;
    } else {
      content.forEach(function (seg) {
        if (seg.mark) {
          var m = document.createElement('mark');
          m.className = 'df-mk df-mk-' + seg.mark;
          m.textContent = seg.text;
          c.appendChild(m);
        } else {
          c.appendChild(document.createTextNode(seg.text));
        }
      });
    }
    r.appendChild(c);
    return r;
  }

  function clickWord() {
    return window.matchMedia && window.matchMedia('(pointer: coarse)').matches ? 'tap' : 'click';
  }

  function foldEl(id, count, side) {
    var r = document.createElement('div');
    r.className = 'df-row df-foldrow' + (side === 'p' ? ' df-foldrow--pair' : '');
    r.dataset.fold = String(id);
    r.dataset.side = side;
    r.setAttribute('role', 'button');
    r.setAttribute('tabindex', '0');
    var c = document.createElement('span');
    c.className = 'df-code df-fold';
    c.textContent = '... ' + count + ' unchanged lines (' + clickWord() + ' to expand)';
    r.appendChild(c);
    return r;
  }

  /* Emit an equal hunk into one or two row lists, collapsing long middles. */
  function emitEqual(h, push) {
    var len = h.a.length;
    if (len >= FOLD_MIN) {
      var i;
      for (i = 0; i < CONTEXT; i++) push('line', i);
      var id = ++foldSeq;
      foldMap[id] = {
        aStart: h.aStart + CONTEXT,
        bStart: h.bStart + CONTEXT,
        aLines: h.a.slice(CONTEXT, len - CONTEXT),
        bLines: h.b.slice(CONTEXT, len - CONTEXT)
      };
      push('fold', id);
      for (i = len - CONTEXT; i < len; i++) push('line', i);
    } else {
      for (var j = 0; j < len; j++) push('line', j);
    }
  }

  /* The diff is first flattened into a list of row items (cheap: no DOM, no word diffs),
     then turned into DOM in time slices so a huge diff never freezes the page.
     Side view items: { a: spec, b: spec } or { fold: id }. Unified: { u: spec } or
     { fold: id }. A spec is { kind, num, num2, text, pair, half }; `pair` is shared by
     the two halves of a changed line pair and caches its word-level marks. */
  var EMPTY = { kind: 'empty', num: null, text: null };

  function sideItems() {
    var items = [];
    lastHunks.forEach(function (h) {
      var i;
      if (h.t === 'eq') {
        emitEqual(h, function (kind, x) {
          if (kind === 'fold') items.push({ fold: x });
          else items.push({ a: { kind: 'ctx', num: h.aStart + x + 1, text: h.a[x] },
                            b: { kind: 'ctx', num: h.bStart + x + 1, text: h.b[x] } });
        });
      } else if (h.t === 'del') {
        for (i = 0; i < h.a.length; i++) items.push({ a: { kind: 'del', num: h.aStart + i + 1, text: h.a[i] }, b: EMPTY });
      } else if (h.t === 'add') {
        for (i = 0; i < h.b.length; i++) items.push({ a: EMPTY, b: { kind: 'add', num: h.bStart + i + 1, text: h.b[i] } });
      } else { // chg
        var n = Math.min(h.a.length, h.b.length);
        for (i = 0; i < n; i++) {
          var pr = { a: h.a[i], b: h.b[i] };
          items.push({ a: { kind: 'del', num: h.aStart + i + 1, text: h.a[i], pair: pr, half: 'left' },
                       b: { kind: 'add', num: h.bStart + i + 1, text: h.b[i], pair: pr, half: 'right' } });
        }
        for (i = n; i < h.a.length; i++) items.push({ a: { kind: 'del', num: h.aStart + i + 1, text: h.a[i] }, b: EMPTY });
        for (i = n; i < h.b.length; i++) items.push({ a: EMPTY, b: { kind: 'add', num: h.bStart + i + 1, text: h.b[i] } });
      }
    });
    return items;
  }

  function unifiedItems() {
    var items = [];
    lastHunks.forEach(function (h) {
      var i;
      if (h.t === 'eq') {
        emitEqual(h, function (kind, x) {
          if (kind === 'fold') items.push({ fold: x });
          else items.push({ u: { kind: 'ctx', num: h.aStart + x + 1, text: h.b[x], num2: h.bStart + x + 1 } });
        });
      } else if (h.t === 'del') {
        for (i = 0; i < h.a.length; i++) items.push({ u: { kind: 'del', num: h.aStart + i + 1, text: h.a[i], num2: null } });
      } else if (h.t === 'add') {
        for (i = 0; i < h.b.length; i++) items.push({ u: { kind: 'add', num: null, text: h.b[i], num2: h.bStart + i + 1 } });
      } else { // chg: all removals, then all additions (standard unified order)
        var n = Math.min(h.a.length, h.b.length), prs = [];
        for (i = 0; i < n; i++) prs.push({ a: h.a[i], b: h.b[i] });
        for (i = 0; i < h.a.length; i++) {
          items.push({ u: { kind: 'del', num: h.aStart + i + 1, text: h.a[i], num2: null,
                            pair: i < n ? prs[i] : null, half: 'left' } });
        }
        for (i = 0; i < h.b.length; i++) {
          items.push({ u: { kind: 'add', num: null, text: h.b[i], num2: h.bStart + i + 1,
                            pair: i < n ? prs[i] : null, half: 'right' } });
        }
      }
    });
    return items;
  }

  function specEl(s, o, uni) {
    var content = s.text;
    if (s.pair) {
      if (s.pair.segs === undefined) s.pair.segs = wordSegs(s.pair.a, s.pair.b, o);
      if (s.pair.segs) content = s.pair.segs[s.half];
    }
    return uni ? rowEl(s.kind, s.num, content, s.num2) : rowEl(s.kind, s.num, content);
  }

  function pairEl(ra, rb) {
    var p = document.createElement('div');
    p.className = 'df-pair';
    p.appendChild(ra);
    p.appendChild(rb);
    return p;
  }

  /* Time-sliced work: `step` is called until it returns false or the slice budget is
     spent, then `flush` moves the built rows into the page and the rest waits for the
     next task. A job belongs to one render generation and stops when a newer render
     (or a cleared result) replaces it. */
  var renderGen = 0;
  function runSliced(step, flush, finish) {
    var gen = renderGen;
    function slice() {
      if (gen !== renderGen) return;
      var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
      var more = true;
      while (more) {
        more = step();
        var t = (window.performance && performance.now) ? performance.now() : Date.now();
        if (t - t0 > SLICE_MS) break;
      }
      flush();
      if (more) setTimeout(slice, 0);
      else if (finish) finish();
    }
    slice();
  }

  /* Rows go into blocks of CHUNK_ROWS (.df-chunk, content-visibility: auto in the page
     CSS), so the browser lays out and paints only the blocks on screen: a 40,000-row
     diff costs about as much per frame as a 200-row one. `insert(frag)` places newly
     made blocks; rows added after a flush go straight into the last (live) block. */
  function chunker(insert) {
    var cur = null, n = 0, frag = document.createDocumentFragment();
    function size() { if (cur) cur.style.setProperty('contain-intrinsic-block-size', 'auto ' + (n * 1.5) + 'em'); }
    return {
      add: function (el) {
        if (!cur || n >= CHUNK_ROWS) {
          size();
          cur = document.createElement('div');
          cur.className = 'df-chunk';
          frag.appendChild(cur);
          n = 0;
        }
        cur.appendChild(el);
        n++;
      },
      /* fold rows sit between blocks, not inside one: a block is as wide as its longest
         line, and a centred fold label inside it could land off screen to the right */
      loose: function (el) {
        size();
        cur = null;
        n = 0;
        frag.appendChild(el);
      },
      flush: function () {
        size();
        if (frag.firstChild) insert(frag);
      }
    };
  }

  function renderSide() {
    var o = opts();
    var items = sideItems();
    var idx = 0;

    if (wrapOn()) {
      /* Wrapped lines have different heights on the two sides, so each line pair lives
         in one row (.df-pair) of a single scroll box; that keeps both halves aligned. */
      var head = document.createElement('div');
      head.className = 'df-pairhead';
      head.appendChild(colHead('Original', fileNameA));
      head.appendChild(colHead('Changed', fileNameB));
      var col = document.createElement('div');
      col.className = 'df-col df-col--pairs';
      out.appendChild(head);
      out.appendChild(col);
      var cp = chunker(function (f) { col.appendChild(f); });
      runSliced(function () {
        if (idx >= items.length) return false;
        var it = items[idx++];
        if (it.fold !== undefined) cp.loose(foldEl(it.fold, foldMap[it.fold].aLines.length, 'p'));
        else cp.add(pairEl(specEl(it.a, o), specEl(it.b, o)));
        return idx < items.length;
      }, cp.flush);
      return;
    }

    var colA = document.createElement('div');
    var colB = document.createElement('div');
    colA.className = 'df-col';
    colB.className = 'df-col';
    colA.id = 'df-col-a';
    colB.id = 'df-col-b';
    var fa = chunker(function (f) { colA.appendChild(f); });
    var fb = chunker(function (f) { colB.appendChild(f); });

    var cols = document.createElement('div');
    cols.className = 'df-cols';
    cols.appendChild(wrapCol('Original', fileNameA, colA));
    cols.appendChild(wrapCol('Changed', fileNameB, colB));
    out.appendChild(cols);

    // synced vertical scrolling (equality check terminates the feedback loop)
    colA.addEventListener('scroll', function () {
      if (colB.scrollTop !== colA.scrollTop) colB.scrollTop = colA.scrollTop;
    });
    colB.addEventListener('scroll', function () {
      if (colA.scrollTop !== colB.scrollTop) colA.scrollTop = colB.scrollTop;
    });

    runSliced(function () {
      if (idx >= items.length) return false;
      var it = items[idx++];
      if (it.fold !== undefined) {
        var cnt = foldMap[it.fold].aLines.length;
        fa.loose(foldEl(it.fold, cnt, 'a'));
        fb.loose(foldEl(it.fold, cnt, 'b'));
      } else {
        fa.add(specEl(it.a, o));
        fb.add(specEl(it.b, o));
      }
      return idx < items.length;
    }, function () { fa.flush(); fb.flush(); });
  }

  function colHead(label, fname) {
    var head = document.createElement('div');
    head.className = 'df-colhead';
    head.textContent = fname ? label + ': ' + fname : label;
    return head;
  }

  function wrapCol(label, fname, colEl) {
    var w = document.createElement('div');
    w.className = 'df-colwrap';
    w.appendChild(colHead(label, fname));
    w.appendChild(colEl);
    return w;
  }

  function renderUnified() {
    var o = opts();
    var items = unifiedItems();
    var idx = 0;
    var col = document.createElement('div');
    col.className = 'df-col df-col--uni';
    out.appendChild(col);
    var cu = chunker(function (f) { col.appendChild(f); });
    runSliced(function () {
      if (idx >= items.length) return false;
      var it = items[idx++];
      if (it.fold !== undefined) cu.loose(foldEl(it.fold, foldMap[it.fold].aLines.length, 'u'));
      else cu.add(specEl(it.u, o, true));
      return idx < items.length;
    }, cu.flush);
  }

  function wrapOn() { return !!(wrapEl && wrapEl.checked); }

  function render() {
    renderGen++;
    out.textContent = '';
    foldMap = {};
    foldSeq = 0;
    wordBudget = WORD_PAIRS_MAX;
    out.classList.toggle('df-out--wrap', wrapOn());
    if (!lastHunks) return;
    var digits = String(Math.max(lastMeta.linesA, lastMeta.linesB)).length;
    out.style.setProperty('--df-gw', (digits + 1.5) + 'ch');
    if (view === 'side') renderSide(); else renderUnified();
  }

  /* Expanding a fold inserts its rows in time slices too (a fold can hide thousands of
     lines). The new rows go into fresh blocks just before the (hidden) fold row, which
     is removed at the end. (A fold row inside a block, which render no longer makes,
     splits that block first.) */
  function expandFold(id) {
    var data = foldMap[id];
    if (!data) return;
    delete foldMap[id];
    var els = Array.prototype.slice.call(out.querySelectorAll('[data-fold="' + id + '"]'));
    if (!els.length) return;
    var n = data.aLines.length, i = 0;
    var adders = els.map(function (el) {
      el.hidden = true;
      var block = el.parentNode, tail = el;
      if (block.classList.contains('df-chunk') && el === block.firstChild) {
        tail = block;
      } else if (block.classList.contains('df-chunk')) {
        tail = document.createElement('div');
        tail.className = 'df-chunk';
        while (el.nextSibling) tail.appendChild(el.nextSibling);
        tail.insertBefore(el, tail.firstChild);
        block.parentNode.insertBefore(tail, block.nextSibling);
        block.style.setProperty('contain-intrinsic-block-size', 'auto ' + (block.childNodes.length * 1.5) + 'em');
      }
      return chunker(function (f) { tail.parentNode.insertBefore(f, tail); });
    });
    runSliced(function () {
      if (i >= n) return false;
      els.forEach(function (el, k) {
        var side = el.dataset.side, c = adders[k];
        if (side === 'a') c.add(rowEl('ctx', data.aStart + i + 1, data.aLines[i]));
        else if (side === 'b') c.add(rowEl('ctx', data.bStart + i + 1, data.bLines[i]));
        else if (side === 'p') c.add(pairEl(rowEl('ctx', data.aStart + i + 1, data.aLines[i]),
                                           rowEl('ctx', data.bStart + i + 1, data.bLines[i])));
        else c.add(rowEl('ctx', data.aStart + i + 1, data.bLines[i], data.bStart + i + 1));
      });
      i++;
      return i < n;
    }, function () {
      adders.forEach(function (c) { c.flush(); });
    }, function () {
      els.forEach(function (el) {
        var block = el.parentNode;
        if (!block) return;
        block.removeChild(el);
        if (block.classList.contains('df-chunk')) {
          if (!block.firstChild) block.parentNode.removeChild(block);
          else block.style.setProperty('contain-intrinsic-block-size', 'auto ' + (block.childNodes.length * 1.5) + 'em');
        }
      });
    });
  }


  // ------------------------------------------------------------- comparing

  function fmtMB(n) { return (n / (1024 * 1024)).toFixed(1) + ' MB'; }

  function setNote(msg) {
    noteEl.textContent = msg || '';
    noteEl.hidden = !msg;
  }

  /* One-shot status line. A status set with keepOnce=true (file loads) survives the
     compare that the load itself triggers; everything else is cleared by the next
     compare so an old "Unified diff copied" can never describe a newer result. */
  var statusKeep = false;
  function setStatus(msg, keepOnce) {
    statusEl.textContent = msg || '';
    statusKeep = !!keepOnce;
  }

  function updateStats() {
    if (!lastMeta) { statsEl.textContent = ''; return; }
    if (lastMeta.adds === 0 && lastMeta.dels === 0) {
      statsEl.textContent = lastMeta.rawEqual
        ? 'No differences.'
        : 'No differences. (The inputs differ only in ways you chose to ignore.)';
      return;
    }
    statsEl.textContent =
      lastMeta.adds + (lastMeta.adds === 1 ? ' addition' : ' additions') + ', ' +
      lastMeta.dels + (lastMeta.dels === 1 ? ' deletion' : ' deletions') + '.';
  }

  function runCompare(force) {
    if (statusKeep) statusKeep = false;
    else setStatus('');
    var rawA = taA.value, rawB = taB.value;
    if (rawA.length > HARD_MAX || rawB.length > HARD_MAX) {
      setNote('One of the inputs is about ' + fmtMB(Math.max(rawA.length, rawB.length)) +
        ' of text. This tool tops out around 5 MB, so nothing was compared. Trim the inputs and try again.');
      return;
    }
    if (!force && (rawA.length > AUTO_MAX || rawB.length > AUTO_MAX)) {
      setNote('Inputs over 200 KB are not compared automatically. Press Compare (or Ctrl+Enter) when ready.');
      return;
    }
    setNote('');
    var textA = rawA.replace(/\r\n?/g, '\n');
    var textB = rawB.replace(/\r\n?/g, '\n');
    var seq = ++compareSeq;
    cancelWorkerJobs();
    if (textA === '' && textB === '') {
      lastHunks = null;
      lastMeta = null;
      render();
      out.removeAttribute('aria-busy');
      statsEl.textContent = '';
      return;
    }
    var o = opts();
    /* The diff runs off the main thread; say so if it takes a moment. */
    var busyTimer = setTimeout(function () {
      if (seq !== compareSeq) return;
      statsEl.textContent = 'Comparing…';
      out.setAttribute('aria-busy', 'true');
    }, 200);
    inWorker({ op: 'lines', a: textA, b: textB, o: o, timeout: LINE_TIMEOUT_MS }, function () {
      return lineParts(textA, textB, o, SYNC_TIMEOUT_MS, window.Diff);
    }).then(function (res) {
      clearTimeout(busyTimer);
      if (seq !== compareSeq) return;
      out.removeAttribute('aria-busy');
      var linesA = textA.split('\n'), linesB = textB.split('\n');
      lastHunks = buildHunks(res.parts, linesA, linesB);
      var adds = 0, dels = 0;
      lastHunks.forEach(function (h) {
        if (h.t === 'add' || h.t === 'chg') adds += h.b.length;
        if (h.t === 'del' || h.t === 'chg') dels += h.a.length;
      });
      lastMeta = { textA: textA, textB: textB, linesA: linesA.length, linesB: linesB.length,
                   adds: adds, dels: dels, rawEqual: textA === textB };
      if (res.gaveUp) {
        setNote(res.pre || res.suf
          ? 'These files differ almost everywhere; showing the lines between their matching start and end as fully replaced.'
          : 'These files differ almost everywhere; showing them as fully replaced.');
      }
      render();
      updateStats();
    }, function (err) {
      clearTimeout(busyTimer);
      if (seq !== compareSeq || (err && err.cancelled)) return;
      out.removeAttribute('aria-busy');
      statsEl.textContent = '';
      setStatus('Could not compare the texts' + (err && err.message ? ' (' + err.message + ')' : '') + '.');
    });
  }

  function scheduleAuto() {
    if (debounceTimer) clearTimeout(debounceTimer);
    var big = taA.value.length > AUTO_MAX || taB.value.length > AUTO_MAX;
    if (big) {
      runCompare(false); // only sets the appropriate size note
      return;
    }
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      runCompare(false);
    }, 300);
  }

  /* Copy unified diff. Small inputs get the patch inside the click (some browsers only
     allow a clipboard write during the click itself); anything bigger, or a quick try
     that ran out of time, goes to the worker. If the clipboard then refuses a write that
     came too late, the patch is kept and a second click copies it at once. */
  var copySeq = 0;
  function copyUnified() {
    var textA = taA.value.replace(/\r\n?/g, '\n');
    var textB = taB.value.replace(/\r\n?/g, '\n');
    if (textA.length > HARD_MAX || textB.length > HARD_MAX) {
      setStatus('Inputs are over the 5 MB cap; no patch was generated.');
      return;
    }
    var nameA = fileNameA || 'original', nameB = fileNameB || 'changed';
    var c = patchCache;
    if (c && c.nameA === nameA && c.nameB === nameB && c.a === textA && c.b === textB) {
      writePatch(c, true);
      return;
    }
    var quick = null;
    if (textA.length <= AUTO_MAX && textB.length <= AUTO_MAX) {
      try {
        quick = makePatch(nameA, nameB, textA, textB, PATCH_SYNC_MS, false, window.Diff);
      } catch (e) {
        setStatus('Could not generate the patch: ' + e.message);
        return;
      }
    }
    if (quick) { writePatch(quick, true); return; }
    var seq = ++copySeq;
    setStatus('Making the patch…');
    inWorker({ op: 'patch', nameA: nameA, nameB: nameB, a: textA, b: textB, timeout: LINE_TIMEOUT_MS }, function () {
      return makePatch(nameA, nameB, textA, textB, SYNC_TIMEOUT_MS, true, window.Diff);
    }).then(function (r) {
      if (seq !== copySeq) return;
      patchCache = { nameA: nameA, nameB: nameB, a: textA, b: textB, patch: r.patch, full: r.full };
      writePatch(r, false);
    }, function (err) {
      if (seq !== copySeq) return;
      if (err && err.cancelled) {
        setStatus('A new comparison interrupted the patch. ' + clickWord().replace(/^./, function (m) { return m.toUpperCase(); }) +
          ' Copy unified diff again.');
      } else {
        setStatus('Could not generate the patch' + (err && err.message ? ': ' + err.message : '') + '.');
      }
    });
  }

  function writePatch(r, inGesture) {
    var extra = r.full ? ' The files differ almost everywhere, so the patch replaces the whole file.' : '';
    function done() { setStatus('Unified diff copied to the clipboard.' + extra); }
    function fail() {
      if (!inGesture) {
        setStatus('The patch is ready. ' + clickWord().replace(/^./, function (m) { return m.toUpperCase(); }) +
          ' Copy unified diff again to copy it.');
      } else {
        setStatus('Copy failed. Your browser may block clipboard access on this page.');
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(r.patch).then(done, function () { legacyCopy(r.patch) ? done() : fail(); });
    } else {
      legacyCopy(r.patch) ? done() : fail();
    }
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  // ------------------------------------------------------------- PDF input

  function assetBase() {
    // derive .../assets/js/ from this script's own tag so it works under any base path
    var s = document.querySelector('script[src*="difftool.js"]');
    if (s && s.src) return s.src.split('difftool.js')[0];
    return '/assets/js/';
  }

  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfjsPromise) return pdfjsPromise;
    var base = assetBase() + 'pdflib/pdfjs/';
    pdfjsPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = base + 'pdf.min.js';
      s.onload = function () {
        if (!window.pdfjsLib) { reject(new Error('pdf.js did not initialize')); return; }
        // always the LOCAL worker path, never a CDN
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.js';
        resolve(window.pdfjsLib);
      };
      s.onerror = function () {
        pdfjsPromise = null;
        reject(new Error('could not load the local pdf.js'));
      };
      document.head.appendChild(s);
    });
    return pdfjsPromise;
  }

  /* Rebuild a page's lines from pdf.js text items, in the order the file stores them: a
     new line starts where pdf.js marks an end of line (hasEOL) or where the baseline
     moves by more than half the text height. Within a line a space is put back where
     the gap between two items is wider than a fifth of the font size (or the text jumps
     back left), unless one side already has one. One changed word then marks one line,
     not the whole page. */
  function pageLines(items) {
    var lines = [], cur = '', prev = null;
    function endLine() {
      var t = cur.replace(/[ \t]{2,}/g, ' ').trim();
      if (t) lines.push(t);
      cur = '';
      prev = null;
    }
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || typeof it.str !== 'string') continue;   // marked-content entries
      var tx = it.transform || [1, 0, 0, 1, 0, 0];
      var fh = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]) || Math.abs(it.height) || 0;
      var x = tx[4], y = tx[5];
      if (it.str !== '') {
        if (prev) {
          var em = Math.max(prev.fh, fh, 1);
          if (Math.abs(y - prev.y) > em * 0.5) {
            endLine();
          } else {
            var gap = x - prev.xEnd;
            if ((gap > em * 0.2 || gap < -em) && !/\s$/.test(cur) && !/^\s/.test(it.str)) cur += ' ';
          }
        }
        cur += it.str;
        prev = { y: y, fh: fh, xEnd: x + (it.width || 0) };
      }
      if (it.hasEOL) endLine();
    }
    endLine();
    return lines;
  }

  function extractPdfText(file) {
    return loadPdfJs().then(function (pdfjsLib) {
      return file.arrayBuffer().then(function (buf) {
        // pdf.js detaches the ArrayBuffer it is handed — give it a copy
        function attempt(password) {
          /* isEvalSupported: false keeps pdf.js from compiling font programs into
             JavaScript (CVE-2024-4367: a crafted font could run script on this origin). */
          return pdfjsLib.getDocument({ data: buf.slice(0), password: password, isEvalSupported: false }).promise
            .catch(function (err) {
              if (err && err.name === 'PasswordException' && password === undefined) {
                var pw = window.prompt('This PDF is password-protected. Enter the password to extract its text:');
                if (pw !== null) return attempt(pw);
              }
              throw err;
            });
        }
        return attempt(undefined);
      });
    }).then(function (doc) {
      var pageTexts = [];
      var chain = Promise.resolve();
      var n;
      for (n = 1; n <= doc.numPages; n++) {
        (function (pageNum) {
          chain = chain
            .then(function () { return doc.getPage(pageNum); })
            .then(function (page) { return page.getTextContent(); })
            .then(function (tc) {
              pageTexts.push('=== Page ' + pageNum + ' ===\n' + pageLines(tc.items).join('\n'));
            });
        })(n);
      }
      return chain.then(function () {
        var numPages = doc.numPages;
        try { doc.destroy(); } catch (e) { /* best effort */ }
        return { text: pageTexts.join('\n\n'), pages: numPages };
      });
    });
  }

  // ------------------------------------------------------------ file input

  function setPane(which, text, name, note) {
    var ta = which === 'a' ? taA : taB;
    ta.value = text;
    if (which === 'a') fileNameA = name || ''; else fileNameB = name || '';
    $('df-file-' + which).textContent = (name || '') + (name && note ? ' (' + note + ')' : '');
    scheduleAuto();
  }

  /* file.text() decodes as UTF-8 and turns every invalid byte into U+FFFD. Files saved by
     older Windows programs are often Windows-1252, where an accented letter or the euro
     sign is one byte that is not valid UTF-8, so two files differing in such a letter
     would compare as identical. When the file is not valid UTF-8 and most of its
     non-ASCII characters failed to decode, read it as Windows-1252 and say so. A file
     that is valid UTF-8 (its U+FFFD characters are real) is left alone. */
  function redecode(buf, utf8Text) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf);
      return { text: utf8Text };
    } catch (e) { /* not valid UTF-8: decide below */ }
    var bad = 0, good = 0;
    for (var i = 0; i < utf8Text.length; i++) {
      var c = utf8Text.charCodeAt(i);
      if (c === 0xFFFD) bad++;
      else if (c > 0x7F) good++;
    }
    if (good >= bad) return { text: utf8Text, note: 'some bytes are not valid UTF-8 and show as \uFFFD' };
    try {
      return { text: new TextDecoder('windows-1252').decode(buf), note: 'read as Windows-1252' };
    } catch (e) {
      return { text: utf8Text };
    }
  }

  // Typing or pasting over a loaded file means the pane no longer shows that file —
  // drop the stale name (it also labels the diff columns and the copied patch).
  function clearFileName(which) {
    if (which === 'a') { if (!fileNameA) return; fileNameA = ''; }
    else { if (!fileNameB) return; fileNameB = ''; }
    $('df-file-' + which).textContent = '';
  }

  function handleFile(which, file) {
    if (!file) return;
    var isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (isPdf) {
      if (file.size > PDF_FILE_MAX) {
        setStatus(file.name + ' is ' + fmtMB(file.size) + '; PDFs over ' + fmtMB(PDF_FILE_MAX) + ' are not handled here.');
        return;
      }
      setStatus('Extracting text from ' + file.name + '…');
      extractPdfText(file).then(function (res) {
        setPane(which, res.text, file.name);
        pdfNoteEl.hidden = false;
        setStatus('Extracted text from ' + res.pages + (res.pages === 1 ? ' page' : ' pages') + ' of ' + file.name + '.', true);
      }).catch(function (err) {
        setStatus('Could not read ' + file.name + ' as a PDF' + (err && err.message ? ' (' + err.message + ')' : '') + '.');
      });
      return;
    }
    if (file.size > HARD_MAX) {
      setStatus(file.name + ' is ' + fmtMB(file.size) + '. This tool tops out around 5 MB of text, so the file was not loaded.');
      return;
    }
    file.text().then(function (text) {
      if (text.indexOf('\u0000') !== -1) {
        /* Binary content (NUL bytes) is refused outright: rendering ~1MB of binary
           garbage in a textarea can freeze the tab, and diffing it as text has no
           real use. .docx/.xlsx land here too (they are binary zips). */
        setStatus(file.name + ' looks like a binary file, so it was not loaded. This tool compares text files and PDFs.');
        return null;
      }
      if (text.indexOf('\uFFFD') === -1 || typeof TextDecoder === 'undefined') return { text: text };
      return file.arrayBuffer().then(function (buf) { return redecode(buf, text); });
    }).then(function (r) {
      if (!r) return;
      setStatus('Loaded ' + file.name + (r.note ? ' (' + r.note + ')' : '') + '.', true);
      setPane(which, r.text, file.name, r.note);
    }).catch(function () {
      setStatus('Could not read ' + file.name + '.');
    });
  }

  function dragHasFiles(e) {
    var t = e.dataTransfer;
    if (!t || !t.types) return false;
    return Array.prototype.indexOf.call(t.types, 'Files') !== -1;
  }

  function wirePane(which) {
    var pane = $('df-pane-' + which);
    var input = $('df-fileinput-' + which);
    $('df-choose-' + which).addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
      handleFile(which, input.files && input.files[0]);
      input.value = '';
    });
    pane.addEventListener('dragover', function (e) {
      e.preventDefault();
      if (dragHasFiles(e)) pane.classList.add('df-pane--over');
    });
    pane.addEventListener('dragleave', function () {
      pane.classList.remove('df-pane--over');
    });
    pane.addEventListener('drop', function (e) {
      pane.classList.remove('df-pane--over');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) {
        e.preventDefault();
        handleFile(which, f);
      }
    });
  }

  function setView(v) {
    view = v;
    Object.keys(viewBtns).forEach(function (k) {
      viewBtns[k].classList.toggle('df-btn--on', k === v);
      viewBtns[k].setAttribute('aria-pressed', k === v ? 'true' : 'false');
    });
    if (lastHunks) render();
  }

  // ----------------------------------------------------------------- init

  function init() {
    taA = $('df-text-a');
    taB = $('df-text-b');
    out = $('df-out');
    statsEl = $('df-stats');
    statusEl = $('df-status');
    noteEl = $('df-sizenote');
    pdfNoteEl = $('df-pdfnote');
    compareBtn = $('df-compare');
    copyBtn = $('df-copy');
    wrapEl = $('df-wrapln');
    viewBtns = { side: $('df-view-side'), unified: $('df-view-unified') };

    if (!window.Diff) {
      setStatus('The diff library failed to load; the tool cannot run.');
      return;
    }

    wirePane('a');
    wirePane('b');

    taA.addEventListener('input', function () { clearFileName('a'); scheduleAuto(); });
    taB.addEventListener('input', function () { clearFileName('b'); scheduleAuto(); });
    ['df-trim', 'df-allws', 'df-case'].forEach(function (id) {
      $(id).addEventListener('change', scheduleAuto);
    });

    compareBtn.addEventListener('click', function () { runCompare(true); });
    copyBtn.addEventListener('click', copyUnified);
    viewBtns.side.addEventListener('click', function () { setView('side'); });
    viewBtns.unified.addEventListener('click', function () { setView('unified'); });
    if (wrapEl) wrapEl.addEventListener('change', function () { if (lastHunks) render(); });

    out.addEventListener('click', function (e) {
      var fold = e.target.closest ? e.target.closest('[data-fold]') : null;
      if (fold) expandFold(Number(fold.dataset.fold));
    });
    out.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var fold = e.target.closest ? e.target.closest('[data-fold]') : null;
      if (fold) {
        e.preventDefault();
        expandFold(Number(fold.dataset.fold));
      }
    });

    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        runCompare(true);
      }
    });

    /* If a file drop misses a pane, stop the browser from navigating to the file. */
    document.addEventListener('dragover', function (e) {
      if (dragHasFiles(e)) e.preventDefault();
    });
    document.addEventListener('drop', function (e) {
      if (dragHasFiles(e)) e.preventDefault();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
