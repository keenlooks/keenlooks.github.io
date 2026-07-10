/* ==========================================================================
   editable-values.js — make a slider's value label click-to-type.
   --------------------------------------------------------------------------
   Any element with data-range="<rangeInputId>" becomes editable: click it,
   type a number, press Enter (or click away). We parse the number, set the
   linked <input type="range">, and dispatch its 'input' event — so each
   gadget's existing slider handler does the rest (state update + re-render,
   which reformats the label with its units). Units/commas in the displayed
   value are tolerated on input. Works alongside the slider; the slider keeps
   working normally.

   The mousedown preventDefault stops the wrapping <label> from redirecting the
   click to the range input, so the value itself receives focus.
   ========================================================================== */
(function () {
  var css = '.editable-val{cursor:text;border-bottom:1px dashed rgba(127,127,127,0.55);outline:none}'
    + '.editable-val:hover{border-bottom-color:currentColor}'
    + '.editable-val:focus{border-bottom-style:solid;border-bottom-color:currentColor}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function selectAll(el) {
    try {
      var r = document.createRange(); r.selectNodeContents(el);
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    } catch (e) {}
  }
  function commit(el, range) {
    var raw = el.textContent.replace(/,/g, '');
    var m = raw.match(/-?\d+(\.\d+)?/);
    if (m) range.value = m[0];               // browser clamps to min/max/step on read
    range.dispatchEvent(new Event('input', { bubbles: true }));  // gadget re-renders the label
  }
  function enhance(el) {
    var range = document.getElementById(el.getAttribute('data-range'));
    if (!range) return;
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('role', 'textbox');
    el.setAttribute('inputmode', 'decimal');   /* numeric keypad on phones */
    el.setAttribute('title', 'Click to type a value');
    el.addEventListener('pointerdown', function (e) { e.preventDefault(); el.focus(); selectAll(el); });
    el.addEventListener('focus', function () { selectAll(el); });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); range.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); }
    });
    el.addEventListener('blur', function () { commit(el, range); });
  }
  function init() {
    var els = document.querySelectorAll('.editable-val[data-range]');
    for (var i = 0; i < els.length; i++) enhance(els[i]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
