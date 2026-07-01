# Vendored third-party libraries (for /pdftools/)

These are pinned, locally-served copies so the PDF toolbench runs fully offline with no
CDN/network calls (privacy + the site's no-external-deps ethos). Downloaded, not hotlinked.

## pdf-lib — `pdf-lib.min.js`
- Version 1.17.1
- License: **MIT** — https://github.com/Hopding/pdf-lib/blob/master/LICENSE.md
- Used for structural PDF editing (merge, split, reorder, rotate, delete pages, embed
  images for signatures and rasterized redaction, strip metadata). Exposes `window.PDFLib`.

## pdf.js — `pdfjs/pdf.min.js`, `pdfjs/pdf.worker.min.js`
- Version 3.11.174 (legacy UMD build)
- License: **Apache License 2.0** — https://github.com/mozilla/pdf.js/blob/master/LICENSE
  (the full license notice is retained in the minified file headers)
- Mozilla's PDF renderer (Firefox's built-in viewer). Used for DISPLAY ONLY: page
  thumbnails/previews and rasterizing pages for true redaction. Exposes `window.pdfjsLib`;
  the worker is loaded from this local path (never a CDN).

To update: re-download the same files from the upstream release and bump the versions here.
