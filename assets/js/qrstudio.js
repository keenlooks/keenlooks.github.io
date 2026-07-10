/* QR Studio — /qr/
 * Generate static QR codes (URL / text / Wi-Fi / vCard / email / phone / SMS)
 * and scan them (image drop + camera), entirely in the browser.
 *
 * Encoding: qrcode-generator 1.5.0 (Kazuhiko Arase, MIT) — assets/js/qrlib/qrcode.js
 * Decoding: jsQR 1.4.0 (Apache-2.0) — assets/js/qrlib/jsQR.js, with the browser's
 * native BarcodeDetector preferred for the live camera where available.
 *
 * The preview and both exports are always pure black modules on white,
 * regardless of site theme, so the code stays scannable.
 */
(function () {
  'use strict';

  var wrap = document.getElementById('qs-wrap');
  if (!wrap) return;

  function $(id) { return document.getElementById(id); }

  function debounce(fn, ms) {
    var t = 0;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  /* ============================ tabs ============================ */

  var tabGen = $('qs-tab-gen'), tabScan = $('qs-tab-scan');
  var panGen = $('qs-gen'), panScan = $('qs-scan');

  function showTab(which) {
    var gen = (which === 'gen');
    panGen.hidden = !gen;
    panScan.hidden = gen;
    tabGen.classList.toggle('qs-tab--on', gen);
    tabScan.classList.toggle('qs-tab--on', !gen);
    tabGen.setAttribute('aria-selected', gen ? 'true' : 'false');
    tabScan.setAttribute('aria-selected', gen ? 'false' : 'true');
    if (gen) {
      stopCamera('');
      /* the preview canvas was measured while possibly hidden; redraw after layout */
      requestAnimationFrame(drawPreview);
    }
  }
  tabGen.addEventListener('click', function () { showTab('gen'); });
  tabScan.addEventListener('click', function () { showTab('scan'); });

  /* ======================= payload builders ======================= */

  /* WIFI: escaping per the de-facto (ZXing / Wi-Fi Alliance) format:
   * backslash-escape \ ; , : and " in SSID and password. */
  function escWifi(s) {
    return String(s).replace(/([\\;,:"])/g, '\\$1');
  }

  /* vCard 3.0 (RFC 2426) text-value escaping: \ ; , and newlines.
   * (Colons do not need escaping in vCard property values.) */
  function escVcard(s) {
    return String(s)
      .replace(/\\/g, '\\\\')
      .replace(/([;,])/g, '\\$1')
      .replace(/\r?\n/g, '\\n');
  }

  function slug(s) {
    var t = String(s || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return t || 'code';
  }

  function cleanPhone(s) {
    return String(s).replace(/[\s().-]/g, '');
  }

  /* Returns { text, name } or { hint } when required fields are empty. */
  function currentPayload() {
    var type = $('qs-type').value;

    if (type === 'url') {
      var u = $('qs-url').value.trim();
      if (!u) return { hint: 'Enter a URL to generate the code.' };
      if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
      return { text: u, name: 'url-' + slug(u) };
    }

    if (type === 'text') {
      var txt = $('qs-text').value;
      if (!txt.trim()) return { hint: 'Enter some text to generate the code.' };
      return { text: txt, name: 'text-' + slug(txt.slice(0, 30)) };
    }

    if (type === 'wifi') {
      var ssid = $('qs-wifi-ssid').value;
      if (!ssid.trim()) return { hint: 'Enter the network name (SSID) to generate the code.' };
      var sec = $('qs-wifi-sec').value;
      var pass = $('qs-wifi-pass').value;
      var s = 'WIFI:T:' + sec + ';S:' + escWifi(ssid) + ';';
      if (sec !== 'nopass' && pass) s += 'P:' + escWifi(pass) + ';';
      if ($('qs-wifi-hidden').checked) s += 'H:true;';
      s += ';';
      return { text: s, name: 'wifi-' + slug(ssid) };
    }

    if (type === 'vcard') {
      var name = $('qs-vc-name').value.trim();
      if (!name) return { hint: 'Enter a name to generate the contact card.' };
      var family = '', given = name;
      var sp = name.lastIndexOf(' ');
      if (sp > 0) { family = name.slice(sp + 1); given = name.slice(0, sp); }
      var lines = ['BEGIN:VCARD', 'VERSION:3.0'];
      lines.push('N:' + escVcard(family) + ';' + escVcard(given) + ';;;');
      lines.push('FN:' + escVcard(name));
      var org = $('qs-vc-org').value.trim();
      if (org) lines.push('ORG:' + escVcard(org));
      var title = $('qs-vc-title').value.trim();
      if (title) lines.push('TITLE:' + escVcard(title));
      var tel = $('qs-vc-tel').value.trim();
      if (tel) lines.push('TEL;TYPE=CELL:' + escVcard(tel));
      var email = $('qs-vc-email').value.trim();
      if (email) lines.push('EMAIL:' + escVcard(email));
      var vurl = $('qs-vc-url').value.trim();
      if (vurl) lines.push('URL:' + escVcard(vurl));
      lines.push('END:VCARD');
      return { text: lines.join('\r\n'), name: 'vcard-' + slug(name) };
    }

    if (type === 'email') {
      var to = $('qs-em-to').value.trim();
      if (!to) return { hint: 'Enter an email address to generate the code.' };
      var s2 = 'mailto:' + to;
      var q = [];
      var subj = $('qs-em-subj').value;
      if (subj) q.push('subject=' + encodeURIComponent(subj));
      var body = $('qs-em-body').value;
      if (body) q.push('body=' + encodeURIComponent(body));
      if (q.length) s2 += '?' + q.join('&');
      return { text: s2, name: 'email-' + slug(to) };
    }

    if (type === 'tel') {
      var num = $('qs-tel-num').value.trim();
      if (!num) return { hint: 'Enter a phone number to generate the code.' };
      return { text: 'tel:' + cleanPhone(num), name: 'tel-' + slug(cleanPhone(num)) };
    }

    if (type === 'sms') {
      var num2 = $('qs-sms-num').value.trim();
      if (!num2) return { hint: 'Enter a phone number to generate the code.' };
      var msg = $('qs-sms-msg').value;
      var s3 = 'SMSTO:' + cleanPhone(num2);
      if (msg) s3 += ':' + msg;
      return { text: s3, name: 'sms-' + slug(cleanPhone(num2)) };
    }

    return { hint: '' };
  }

  /* =================== generation + preview =================== */

  var qr = null;          /* last successfully built matrix */
  var qrName = 'code';    /* filename stem for downloads */
  var canvas = $('qs-canvas');
  var meta = $('qs-meta');
  var payloadEl = $('qs-payload');
  var btnPng = $('qs-png'), btnSvg = $('qs-svg');

  var fieldGroups = { url: 'qs-f-url', text: 'qs-f-text', wifi: 'qs-f-wifi', vcard: 'qs-f-vcard', email: 'qs-f-email', tel: 'qs-f-tel', sms: 'qs-f-sms' };

  function showFields() {
    var type = $('qs-type').value;
    for (var k in fieldGroups) {
      var el = $(fieldGroups[k]);
      if (el) el.hidden = (k !== type);
    }
  }

  function marginModules() {
    var m = parseInt($('qs-margin').value, 10);
    if (isNaN(m)) m = 4;
    return Math.max(0, Math.min(16, m));
  }

  function regen() {
    var p = currentPayload();
    if (!p.text) {
      qr = null;
      payloadEl.textContent = '';
      meta.textContent = p.hint || '';
      btnPng.disabled = btnSvg.disabled = true;
      drawPreview();
      return;
    }
    if (typeof qrcode === 'undefined') {
      meta.textContent = 'The QR encoder failed to load. Try reloading the page.';
      return;
    }
    try {
      /* Byte mode with real UTF-8 so non-ASCII text scans correctly. */
      qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
      var q = qrcode(0, $('qs-ec').value);   /* typeNumber 0 = auto-pick smallest */
      q.addData(p.text, 'Byte');
      q.make();
      qr = q;
      qrName = p.name;
      var n = qr.getModuleCount();
      meta.textContent = 'Version ' + ((n - 17) / 4) + ', ' + n + '×' + n + ' modules, ' + p.text.length + ' characters.';
      btnPng.disabled = btnSvg.disabled = false;
    } catch (e) {
      qr = null;
      meta.textContent = 'Too much data for one QR code at this error-correction level. Shorten the content or drop the level to L.';
      btnPng.disabled = btnSvg.disabled = true;
    }
    payloadEl.textContent = p.text;
    drawPreview();
  }

  function drawPreview() {
    var ctx = canvas.getContext('2d');
    if (!qr) {
      canvas.width = canvas.height = 220;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 220, 220);
      return;
    }
    var n = qr.getModuleCount();
    var m = marginModules();
    var total = n + 2 * m;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var cssW = canvas.clientWidth || 300;
    var scale = Math.max(1, Math.round(cssW * dpr / total));
    canvas.width = canvas.height = total * scale;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (qr.isDark(y, x)) ctx.fillRect((x + m) * scale, (y + m) * scale, scale, scale);
      }
    }
  }

  /* ========================= downloads ========================= */

  function saveBlob(blob, filename) {
    var a = document.createElement('a');
    var u = URL.createObjectURL(blob);
    a.href = u;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(u); }, 5000);
  }

  function exportPng() {
    if (!qr) return;
    var n = qr.getModuleCount();
    var m = marginModules();
    var total = n + 2 * m;
    var size = Math.max(parseInt($('qs-size').value, 10) || 1024, total);
    var scale = Math.max(1, Math.floor(size / total));
    var off = Math.floor((size - scale * total) / 2);
    var c = document.createElement('canvas');
    c.width = c.height = size;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (qr.isDark(y, x)) ctx.fillRect(off + (x + m) * scale, off + (y + m) * scale, scale, scale);
      }
    }
    c.toBlob(function (b) {
      if (b) saveBlob(b, qrName + '.png');
    }, 'image/png');
  }

  /* One <path> with M/h/v run-length commands: crisp at any size, tiny file. */
  function exportSvg() {
    if (!qr) return;
    var n = qr.getModuleCount();
    var m = marginModules();
    var total = n + 2 * m;
    var d = '';
    for (var y = 0; y < n; y++) {
      var x = 0;
      while (x < n) {
        if (qr.isDark(y, x)) {
          var x0 = x;
          while (x < n && qr.isDark(y, x)) x++;
          var w = x - x0;
          d += 'M' + (x0 + m) + ' ' + (y + m) + 'h' + w + 'v1h-' + w + 'z';
        } else {
          x++;
        }
      }
    }
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total +
      '" shape-rendering="crispEdges"><rect width="' + total + '" height="' + total +
      '" fill="#ffffff"/><path d="' + d + '" fill="#000000"/></svg>';
    saveBlob(new Blob([svg], { type: 'image/svg+xml' }), qrName + '.svg');
  }

  btnPng.addEventListener('click', exportPng);
  btnSvg.addEventListener('click', exportSvg);

  /* live regeneration on any field change */
  var regenSoon = debounce(regen, 120);
  panGen.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'qs-type') showFields();
    regenSoon();
  });
  panGen.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'qs-type') showFields();
    regenSoon();
  });
  window.addEventListener('resize', debounce(function () {
    if (!panGen.hidden) drawPreview();
  }, 150));

  /* ============================ scan ============================ */

  var video = $('qs-video');
  var camnote = $('qs-camnote');
  var btnCam = $('qs-cam'), btnCamStop = $('qs-cam-stop');
  var stream = null;
  var scanTimer = 0;
  var detector = null;
  var detectBusy = false;
  var workCanvas = document.createElement('canvas');
  var workCtx = workCanvas.getContext('2d', { willReadFrequently: true });

  function scanStatus(msg) {
    $('qs-scan-status').textContent = msg;
  }

  function showResult(text) {
    var res = $('qs-result');
    if (!text) {
      res.hidden = true;
      scanStatus('No QR code found in that image. A larger, straighter, better-lit shot usually works.');
      return;
    }
    $('qs-decoded').textContent = text;
    $('qs-linkwarn').hidden = !/^(https?:\/\/|www\.)/i.test(text.trim());
    res.hidden = false;
    scanStatus('Decoded ' + text.length + ' character' + (text.length === 1 ? '' : 's') + '.');
  }

  function jsqrOn(source, w, h) {
    if (typeof jsQR === 'undefined' || !w || !h) return null;
    workCanvas.width = w;
    workCanvas.height = h;
    workCtx.drawImage(source, 0, 0, w, h);
    var img;
    try {
      img = workCtx.getImageData(0, 0, w, h);
    } catch (e) {
      return null;
    }
    var r = jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' });
    return (r && r.data) ? r.data : null;
  }

  /* Try a few downscales: full-res photos are slow AND often decode worse than
   * a downscaled copy; tiny screenshots decode best untouched. */
  function decodeImageEl(img) {
    var w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return null;
    var caps = [900, 1400, 520], tried = {}, i, k, tw, th, text;
    for (i = 0; i < caps.length; i++) {
      k = Math.min(1, caps[i] / Math.max(w, h));
      tw = Math.max(1, Math.round(w * k));
      th = Math.max(1, Math.round(h * k));
      if (tried[tw]) continue;
      tried[tw] = true;
      text = jsqrOn(img, tw, th);
      if (text) return text;
    }
    return null;
  }

  function handleFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      scanStatus('That does not look like an image file.');
      return;
    }
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      scanStatus('Decoding…');
      /* let the status paint before the (possibly slow) decode */
      setTimeout(function () { showResult(decodeImageEl(img)); }, 20);
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      scanStatus('Could not read that image.');
    };
    img.src = url;
  }

  var drop = $('qs-drop'), fileInput = $('qs-file');
  drop.addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () {
    handleFile(fileInput.files && fileInput.files[0]);
    fileInput.value = '';
  });
  drop.addEventListener('dragover', function (e) {
    e.preventDefault();
    drop.classList.add('qs-drop--over');
  });
  drop.addEventListener('dragleave', function () {
    drop.classList.remove('qs-drop--over');
  });
  drop.addEventListener('drop', function (e) {
    e.preventDefault();
    drop.classList.remove('qs-drop--over');
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    handleFile(f);
  });

  /* ------------------------- live camera ------------------------- */

  function startCamera() {
    if (stream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      camnote.textContent = 'This browser has no camera API. You can still decode a saved image.';
      return;
    }
    camnote.textContent = 'Requesting camera…';
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    }).then(function (s) {
      stream = s;
      video.srcObject = s;
      video.hidden = false;
      btnCam.hidden = true;
      btnCamStop.hidden = false;
      camnote.textContent = 'Point the camera at a QR code. It stops on its own once one is found.';
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
      detector = null;
      if (window.BarcodeDetector) {
        try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { detector = null; }
      }
      detectBusy = false;
      scanTimer = setInterval(cameraTick, 100);   /* ~10 fps */
    }).catch(function () {
      camnote.textContent = 'Camera access was denied or unavailable. You can still decode a saved image.';
    });
  }

  function cameraTick() {
    if (!stream || video.readyState < 2 || detectBusy) return;
    if (detector) {
      detectBusy = true;
      detector.detect(video).then(function (codes) {
        detectBusy = false;
        if (codes && codes.length && codes[0].rawValue) cameraFound(codes[0].rawValue);
      }).catch(function () {
        detectBusy = false;
        detector = null;   /* fall back to jsQR on the next tick */
      });
      return;
    }
    var w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return;
    var k = Math.min(1, 640 / Math.max(w, h));
    var text = jsqrOn(video, Math.round(w * k), Math.round(h * k));
    if (text) cameraFound(text);
  }

  function cameraFound(text) {
    stopCamera('Found a code; the camera has been stopped.');
    showResult(text);
  }

  function stopCamera(msg) {
    if (scanTimer) {
      clearInterval(scanTimer);
      scanTimer = 0;
    }
    if (stream) {
      var tracks = stream.getTracks();
      for (var i = 0; i < tracks.length; i++) tracks[i].stop();
      stream = null;
    }
    video.srcObject = null;
    video.hidden = true;
    btnCam.hidden = false;
    btnCamStop.hidden = true;
    if (typeof msg === 'string' && msg) camnote.textContent = msg;
    else if (typeof msg === 'string') camnote.textContent = '';
  }

  btnCam.addEventListener('click', startCamera);
  btnCamStop.addEventListener('click', function () { stopCamera(''); });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopCamera('Camera stopped while the tab was hidden.');
  });
  window.addEventListener('pagehide', function () { stopCamera(''); });

  /* --------------------------- copy --------------------------- */

  function fallbackCopy(t) {
    var ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  $('qs-copy').addEventListener('click', function () {
    var t = $('qs-decoded').textContent;
    var b = $('qs-copy');
    function done(ok) {
      b.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(function () { b.textContent = 'Copy text'; }, 1400);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(function () { done(true); }, function () { done(fallbackCopy(t)); });
    } else {
      done(fallbackCopy(t));
    }
  });

  /* ============================ init ============================ */

  showFields();
  regen();
})();
