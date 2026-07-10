# Vendored third-party libraries (for /pdftools/)

These are pinned, locally-served copies so the PDF toolbench runs fully offline with no
CDN/network calls (privacy + the site's no-external-deps ethos). Downloaded, not hotlinked.
This file is the registry for all of them, including the sibling directories
`assets/js/tesseractlib/` (OCR) and `assets/js/qpdflib/` (encryption).

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

## tesseract.js — `../tesseractlib/` (lazy-loaded, only when OCR is used)
- tesseract.js **5.1.1**: `tesseract.min.js`, `worker.min.js`
  (+ the webpack-extracted `*.LICENSE.txt` notices, kept alongside)
- tesseract.js-core **5.1.1**: `tesseract-core-simd-lstm.wasm.js`,
  `tesseract-core-lstm.wasm.js` (single-file builds with the wasm embedded; the worker
  picks the SIMD one when the browser supports it — only the two LSTM cores are vendored
  because the toolbench always runs OEM 1 / LSTM-only)
- License: **Apache License 2.0** — copies kept in the directory as
  `LICENSE-tesseract.js.md` and `LICENSE-tesseract.js-core.txt`
  (https://github.com/naptha/tesseract.js and https://github.com/naptha/tesseract.js-core)
- Language data: `lang/eng.traineddata.gz` — the **tessdata_fast 4.0.0** English model,
  from https://github.com/naptha/tessdata (gh-pages, `4.0.0_fast/`), Apache License 2.0
  (https://github.com/tesseract-ocr/tessdata_fast).
- Used for the "Make searchable (OCR)" feature: recognizes page text in the browser and
  writes an invisible text layer. `workerPath`, `corePath`, and `langPath` all point at
  this local directory; nothing is fetched from a third-party server.

## qpdf (WebAssembly) — `../qpdflib/` (lazy-loaded, only when Protect is used)
- @jspawn/qpdf-wasm **0.0.2** (qpdf compiled to wasm via Emscripten): `qpdf.js`, `qpdf.wasm`
- License: **Apache License 2.0** — copy kept as `LICENSE-qpdf-wasm.txt`
  (https://github.com/jspawn/qpdf-wasm; upstream qpdf: https://github.com/qpdf/qpdf)
- Used for the "Protect…" feature: AES-256 password encryption of the final built PDF,
  entirely in the browser.

To update: re-download the same files from the upstream release and bump the versions here.
