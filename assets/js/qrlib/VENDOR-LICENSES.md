# Vendored third-party libraries (for /qr/)

These are pinned, locally-served copies so QR Studio runs fully offline with no
CDN/network calls (privacy + the site's no-external-deps ethos). Downloaded, not hotlinked.

## qrcode-generator — `qrcode.js`
- Version 1.5.0
- License: **MIT** — https://github.com/kazuhikoarase/qrcode-generator
  (the MIT notice is retained in the file header: Copyright (c) 2009 Kazuhiko Arase)
- Kazuhiko Arase's QR Code encoder (the reference JavaScript implementation). Used to
  build the module matrix for the GENERATE tab. Exposes a global `qrcode` function.
- The word "QR Code" is a registered trademark of DENSO WAVE INCORPORATED (noted in the
  file header; the on-page credit repeats it).

## jsQR — `jsQR.js`
- Version 1.4.0
- License: **Apache License 2.0** — full text alongside in `LICENSE-jsQR.txt` (copied from
  the npm package). The upstream dist build ships with no header, so an Apache-2.0 notice
  header was prepended when vendoring (marked as such in the header).
- Cozmo Wolfe's pure-JavaScript QR decoder — https://github.com/cozmo/jsQR. Used by the
  SCAN tab to decode dropped images, and as the camera fallback when the browser has no
  native `BarcodeDetector`. Exposes a global `jsQR`.

To update: re-download the same files from the upstream release and bump the versions here.
