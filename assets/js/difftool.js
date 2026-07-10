/* Diff Checker (/diff/) — fully client-side. Nothing is uploaded; this file makes no
   network requests with your text. Diffing uses jsdiff (BSD-3-Clause), vendored locally
   under assets/js/difflib/. PDF text extraction lazily loads the already-vendored pdf.js
   (Apache-2.0) from assets/js/pdflib/ only when a PDF is dropped.

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

  function $(id) { return document.getElementById(id); }

  var taA, taB, out, statsEl, statusEl, noteEl, pdfNoteEl, compareBtn, copyBtn;
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
     us walk both originals in lockstep. */
  function computeHunks(textA, textB, o) {
    var linesA = textA.split('\n');
    var linesB = textB.split('\n');
    /* The terminal '\n' makes jsdiff's token count equal split('\n').length on both
       sides in every trailing-newline case, so the walk below can never drift. */
    var keyA = linesA.map(function (l) { return normLine(l, o); }).join('\n') + '\n';
    var keyB = linesB.map(function (l) { return normLine(l, o); }).join('\n') + '\n';
    var parts = window.Diff.diffLines(keyA, keyB);
    var hunks = [];
    var ai = 0, bi = 0;
    parts.forEach(function (p) {
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
      parts = window.Diff.diffWordsWithSpace(oldLine, newLine, o.icase ? { ignoreCase: true } : undefined);
    } catch (e) { return null; }
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

  function foldEl(id, count, side) {
    var r = document.createElement('div');
    r.className = 'df-row df-foldrow';
    r.dataset.fold = String(id);
    r.dataset.side = side;
    r.setAttribute('role', 'button');
    r.setAttribute('tabindex', '0');
    var c = document.createElement('span');
    c.className = 'df-code df-fold';
    c.textContent = '... ' + count + ' unchanged lines (click to expand)';
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

  function renderSide() {
    var o = opts();
    var colA = document.createElement('div');
    var colB = document.createElement('div');
    colA.className = 'df-col';
    colB.className = 'df-col';
    colA.id = 'df-col-a';
    colB.id = 'df-col-b';
    var fa = document.createDocumentFragment();
    var fb = document.createDocumentFragment();

    lastHunks.forEach(function (h) {
      var i, segs;
      if (h.t === 'eq') {
        emitEqual(h, function (kind, x) {
          if (kind === 'fold') {
            fa.appendChild(foldEl(x, foldMap[x].aLines.length, 'a'));
            fb.appendChild(foldEl(x, foldMap[x].aLines.length, 'b'));
          } else {
            fa.appendChild(rowEl('ctx', h.aStart + x + 1, h.a[x]));
            fb.appendChild(rowEl('ctx', h.bStart + x + 1, h.b[x]));
          }
        });
      } else if (h.t === 'del') {
        for (i = 0; i < h.a.length; i++) {
          fa.appendChild(rowEl('del', h.aStart + i + 1, h.a[i]));
          fb.appendChild(rowEl('empty', null, null));
        }
      } else if (h.t === 'add') {
        for (i = 0; i < h.b.length; i++) {
          fa.appendChild(rowEl('empty', null, null));
          fb.appendChild(rowEl('add', h.bStart + i + 1, h.b[i]));
        }
      } else { // chg
        var n = Math.min(h.a.length, h.b.length);
        for (i = 0; i < n; i++) {
          segs = wordSegs(h.a[i], h.b[i], o);
          fa.appendChild(rowEl('del', h.aStart + i + 1, segs ? segs.left : h.a[i]));
          fb.appendChild(rowEl('add', h.bStart + i + 1, segs ? segs.right : h.b[i]));
        }
        for (i = n; i < h.a.length; i++) {
          fa.appendChild(rowEl('del', h.aStart + i + 1, h.a[i]));
          fb.appendChild(rowEl('empty', null, null));
        }
        for (i = n; i < h.b.length; i++) {
          fa.appendChild(rowEl('empty', null, null));
          fb.appendChild(rowEl('add', h.bStart + i + 1, h.b[i]));
        }
      }
    });

    colA.appendChild(fa);
    colB.appendChild(fb);

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
  }

  function wrapCol(label, fname, colEl) {
    var w = document.createElement('div');
    w.className = 'df-colwrap';
    var head = document.createElement('div');
    head.className = 'df-colhead';
    head.textContent = fname ? label + ' — ' + fname : label;
    w.appendChild(head);
    w.appendChild(colEl);
    return w;
  }

  function renderUnified() {
    var o = opts();
    var col = document.createElement('div');
    col.className = 'df-col df-col--uni';
    var f = document.createDocumentFragment();

    lastHunks.forEach(function (h) {
      var i, segs;
      if (h.t === 'eq') {
        emitEqual(h, function (kind, x) {
          if (kind === 'fold') {
            f.appendChild(foldEl(x, foldMap[x].aLines.length, 'u'));
          } else {
            f.appendChild(rowEl('ctx', h.aStart + x + 1, h.b[x], h.bStart + x + 1));
          }
        });
      } else if (h.t === 'del') {
        for (i = 0; i < h.a.length; i++) f.appendChild(rowEl('del', h.aStart + i + 1, h.a[i], null));
      } else if (h.t === 'add') {
        for (i = 0; i < h.b.length; i++) f.appendChild(rowEl('add', null, h.b[i], h.bStart + i + 1));
      } else { // chg: all removals, then all additions (standard unified order)
        var n = Math.min(h.a.length, h.b.length);
        var segList = [];
        for (i = 0; i < n; i++) segList.push(wordSegs(h.a[i], h.b[i], o));
        for (i = 0; i < h.a.length; i++) {
          segs = i < n ? segList[i] : null;
          f.appendChild(rowEl('del', h.aStart + i + 1, segs ? segs.left : h.a[i], null));
        }
        for (i = 0; i < h.b.length; i++) {
          segs = i < n ? segList[i] : null;
          f.appendChild(rowEl('add', null, segs ? segs.right : h.b[i], h.bStart + i + 1));
        }
      }
    });

    col.appendChild(f);
    out.appendChild(col);
  }

  function render() {
    out.textContent = '';
    foldMap = {};
    foldSeq = 0;
    wordBudget = WORD_PAIRS_MAX;
    if (!lastHunks) return;
    var digits = String(Math.max(lastMeta.textA.split('\n').length, lastMeta.textB.split('\n').length)).length;
    out.style.setProperty('--df-gw', (digits + 1.5) + 'ch');
    if (view === 'side') renderSide(); else renderUnified();
  }

  function expandFold(id) {
    var data = foldMap[id];
    if (!data) return;
    var els = out.querySelectorAll('[data-fold="' + id + '"]');
    Array.prototype.forEach.call(els, function (el) {
      var side = el.dataset.side;
      var f = document.createDocumentFragment();
      var n = data.aLines.length, i;
      if (side === 'a') {
        for (i = 0; i < n; i++) f.appendChild(rowEl('ctx', data.aStart + i + 1, data.aLines[i]));
      } else if (side === 'b') {
        for (i = 0; i < n; i++) f.appendChild(rowEl('ctx', data.bStart + i + 1, data.bLines[i]));
      } else { // unified
        for (i = 0; i < n; i++) f.appendChild(rowEl('ctx', data.aStart + i + 1, data.bLines[i], data.bStart + i + 1));
      }
      el.parentNode.insertBefore(f, el);
      el.parentNode.removeChild(el);
    });
    delete foldMap[id];
  }

  // ------------------------------------------------------------- comparing

  function fmtMB(n) { return (n / (1024 * 1024)).toFixed(1) + ' MB'; }

  function setNote(msg) {
    noteEl.textContent = msg || '';
    noteEl.hidden = !msg;
  }

  function setStatus(msg) { statusEl.textContent = msg || ''; }

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
    if (textA === '' && textB === '') {
      lastHunks = null;
      lastMeta = null;
      out.textContent = '';
      statsEl.textContent = '';
      return;
    }
    lastHunks = computeHunks(textA, textB, opts());
    var adds = 0, dels = 0;
    lastHunks.forEach(function (h) {
      if (h.t === 'add' || h.t === 'chg') adds += h.b.length;
      if (h.t === 'del' || h.t === 'chg') dels += h.a.length;
    });
    lastMeta = { textA: textA, textB: textB, adds: adds, dels: dels, rawEqual: textA === textB };
    render();
    updateStats();
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

  function copyUnified() {
    var textA = taA.value.replace(/\r\n?/g, '\n');
    var textB = taB.value.replace(/\r\n?/g, '\n');
    if (textA.length > HARD_MAX || textB.length > HARD_MAX) {
      setStatus('Inputs are over the 5 MB cap; no patch was generated.');
      return;
    }
    var patch;
    try {
      patch = window.Diff.createTwoFilesPatch(fileNameA || 'original', fileNameB || 'changed', textA, textB, '', '');
    } catch (e) {
      setStatus('Could not generate the patch: ' + e.message);
      return;
    }
    function done() { setStatus('Unified diff copied to the clipboard.'); }
    function fail() { setStatus('Copy failed. Your browser may block clipboard access on this page.'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(patch).then(done, function () { legacyCopy(patch) ? done() : fail(); });
    } else {
      legacyCopy(patch) ? done() : fail();
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

  function extractPdfText(file) {
    return loadPdfJs().then(function (pdfjsLib) {
      return file.arrayBuffer().then(function (buf) {
        // pdf.js detaches the ArrayBuffer it is handed — give it a copy
        function attempt(password) {
          return pdfjsLib.getDocument({ data: buf.slice(0), password: password }).promise
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
              var txt = tc.items.map(function (it) { return it.str; }).join(' ');
              pageTexts.push('=== Page ' + pageNum + ' ===\n' + txt.replace(/[ \t]{2,}/g, ' ').trim());
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

  function setPane(which, text, name) {
    var ta = which === 'a' ? taA : taB;
    ta.value = text;
    if (which === 'a') fileNameA = name || ''; else fileNameB = name || '';
    $('df-file-' + which).textContent = name || '';
    scheduleAuto();
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
        setStatus('Extracted text from ' + res.pages + (res.pages === 1 ? ' page' : ' pages') + ' of ' + file.name + '.');
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
        setStatus(file.name + ' looks like a binary file; diffing it as text anyway.');
      } else {
        setStatus('Loaded ' + file.name + '.');
      }
      setPane(which, text, file.name);
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
