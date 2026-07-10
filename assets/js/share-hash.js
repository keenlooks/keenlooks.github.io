/* ==========================================================================
   share-hash.js: shared helpers for shareable gadget URLs + PNG snapshots.
   --------------------------------------------------------------------------
   window.ShareHash provides:

   encode(version, obj)  compact base64url string of a versioned payload
                         ({v, o} as JSON; numbers rounded to 3 decimals,
                         NaN/Infinity coerced to 0).
   decode(str)           {version, obj} or null. Treats the string as
                         UNTRUSTED: charset/length checks, try/catch around
                         base64 + JSON, never eval. Call sites must still
                         clamp every field (num/int/arr help with that).
   num/int(v, lo, hi, d) clamp a decoded value into [lo, hi]; d if invalid.
   arr(v, maxLen)        the array capped at maxLen, or [].
   setHash(s)            history.replaceState (no scroll jump, no history
                         spam); only called when the user clicks Share.
   readHash()            the current location.hash without the '#'.
   copyLink(btn, s)      set the hash, copy the full URL to the clipboard
                         (clipboard API, execCommand fallback), and flash
                         the button text to "Copied" for ~1.2 s.
   savePng(canvas, opts) download the canvas as a PNG at 2x its CSS size
                         with a thin caption strip appended at the bottom
                         (gadget name + keanelucas.com). Reads the live
                         canvas; never touches it.
                         opts: { label, file, light, bg }.
   ========================================================================== */
(function () {
  if (window.ShareHash) return;

  function round3(v) {
    if (!isFinite(v)) return 0;
    return Math.round(v * 1000) / 1000;
  }

  function encode(version, obj) {
    var json = JSON.stringify({ v: version, o: obj }, function (k, val) {
      return typeof val === 'number' ? round3(val) : val;
    });
    /* UTF-8-safe base64, then URL-safe alphabet */
    var b64 = btoa(unescape(encodeURIComponent(json)));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decode(str) {
    if (typeof str !== 'string' || !str || str.length > 20000) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(str)) return null;
    var b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var data;
    try { data = JSON.parse(decodeURIComponent(escape(atob(b64)))); }
    catch (e) { return null; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (typeof data.v !== 'number' || !isFinite(data.v)) return null;
    if (!data.o || typeof data.o !== 'object' || Array.isArray(data.o)) return null;
    return { version: data.v, obj: data.o };
  }

  function num(v, lo, hi, def) {
    v = (typeof v === 'number') ? v : parseFloat(v);
    if (!isFinite(v)) return def;
    return v < lo ? lo : (v > hi ? hi : v);
  }
  function int(v, lo, hi, def) {
    v = num(v, lo, hi, def);
    return (typeof v === 'number' && isFinite(v)) ? Math.round(v) : v;
  }
  function arr(v, maxLen) { return Array.isArray(v) ? v.slice(0, maxLen) : []; }

  function setHash(s) {
    try { history.replaceState(null, '', '#' + s); }
    catch (e) { try { location.hash = s; } catch (e2) {} }
  }
  function readHash() {
    var h = location.hash || '';
    return h.charAt(0) === '#' ? h.slice(1) : h;
  }

  function copyLink(btn, s) {
    setHash(s);
    var url = location.origin + location.pathname + '#' + s;
    if (!btn.getAttribute('data-sh-label')) btn.setAttribute('data-sh-label', btn.textContent);
    var orig = btn.getAttribute('data-sh-label');
    function flash(txt) {
      btn.textContent = txt;
      clearTimeout(btn._shFlash);
      btn._shFlash = setTimeout(function () { btn.textContent = orig; }, 1200);
    }
    function fallback() {
      var ok = false;
      try {
        var ta = document.createElement('textarea');
        ta.value = url;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (e) { ok = false; }
      flash(ok ? 'Copied' : 'Link in address bar');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { flash('Copied'); }, fallback);
    } else { fallback(); }
  }

  /* PNG snapshot: offscreen copy at 2x CSS-pixel size + a 28px caption strip. */
  function savePng(canvas, opts) {
    opts = opts || {};
    var w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
    if (!w || !h) return;
    var CAP = 28, SC = 2;
    var out = document.createElement('canvas');
    out.width = Math.round(w * SC);
    out.height = Math.round((h + CAP) * SC);
    var g = out.getContext('2d');
    if (!g) return;
    g.setTransform(SC, 0, 0, SC, 0, 0);
    var light = !!opts.light;
    g.fillStyle = opts.bg || (light ? '#ffffff' : '#141414');
    g.fillRect(0, 0, w, h + CAP);
    try { g.drawImage(canvas, 0, 0, w, h); } catch (e) { return; }
    g.fillStyle = light ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)';
    g.fillRect(0, h, w, CAP);
    g.strokeStyle = light ? 'rgba(0,0,0,0.14)' : 'rgba(255,255,255,0.14)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, h + 0.5); g.lineTo(w, h + 0.5); g.stroke();
    g.font = '600 12px "Source Sans 3", system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.fillStyle = light ? 'rgba(38,38,38,0.75)' : 'rgba(214,214,214,0.75)';
    g.textAlign = 'left';
    g.fillText(opts.label || '', 10, h + CAP / 2 + 1);
    g.textAlign = 'right';
    g.fillText('keanelucas.com', w - 10, h + CAP / 2 + 1);
    out.toBlob(function (blob) {
      if (!blob) return;
      var a = document.createElement('a');
      var href = URL.createObjectURL(blob);
      a.href = href;
      a.download = opts.file || 'snapshot.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(href); }, 4000);
    }, 'image/png');
  }

  window.ShareHash = {
    encode: encode, decode: decode,
    num: num, int: int, arr: arr,
    setHash: setHash, readHash: readHash,
    copyLink: copyLink, savePng: savePng
  };
})();
