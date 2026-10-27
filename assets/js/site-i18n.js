/* site-i18n.js: keep code, hashes, ids and file names as written when a
   visitor's browser translates the page (Chrome, Edge and Safari translate,
   Google Translate). Loaded site-wide from _includes/scripts.html (defer).

   Sets translate="no" (the HTML standard attribute, inherited by everything
   inside) and class "notranslate" (Google's older form) on every code, pre,
   kbd and samp element and on elements carrying data-notranslate or the
   notranslate class. Static markup can carry the attribute itself; this
   covers Markdown output and elements that scripts add later, through one
   MutationObserver that watches childList on the subtree only (no attributes,
   no character data), batches added elements and skips canvases. */
(function () {
  'use strict';
  var SEL = 'code, pre, kbd, samp, [data-notranslate], .notranslate';
  var pending = [];
  var timer = 0;

  function mark(el) {
    if (el.getAttribute('translate') !== 'no') el.setAttribute('translate', 'no');
    if (el.classList && !el.classList.contains('notranslate')) el.classList.add('notranslate');
  }

  function scan(root) {
    if (!root || root.nodeType !== 1 || root.tagName === 'CANVAS') return;
    if (root.matches && root.matches(SEL)) mark(root);
    if (!root.firstElementChild) return;
    var list = root.querySelectorAll(SEL);
    for (var i = 0; i < list.length; i++) mark(list[i]);
  }

  function flush() {
    timer = 0;
    var batch = pending;
    pending = [];
    for (var i = 0; i < batch.length; i++) {
      if (batch[i].isConnected) scan(batch[i]);
    }
  }

  function onMutations(records) {
    for (var r = 0; r < records.length; r++) {
      var added = records[r].addedNodes;
      for (var i = 0; i < added.length; i++) {
        var n = added[i];
        if (n.nodeType === 1 && n.tagName !== 'CANVAS') pending.push(n);
      }
    }
    if (pending.length && !timer) timer = setTimeout(flush, 30);
  }

  function start() {
    try {
      scan(document.body);
      if (window.MutationObserver) {
        new MutationObserver(onMutations).observe(document.body, { childList: true, subtree: true });
      }
    } catch (e) { /* never break the page over a translation hint */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
