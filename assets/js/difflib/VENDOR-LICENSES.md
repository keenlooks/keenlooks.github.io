# Vendored third-party libraries (for /diff/)

These are pinned, locally-served copies so the Diff Checker runs fully offline with no
CDN/network calls (privacy + the site's no-external-deps ethos). Downloaded, not hotlinked.

## jsdiff — `diff.js`
- Version 5.2.0 (UMD build, `dist/diff.js`)
- License: **BSD 3-Clause** — https://github.com/kpdecker/jsdiff/blob/master/LICENSE
  (a copy is kept next to the file as `LICENSE`, and a header notice is prepended to `diff.js`)
- Kevin Decker's text-diff implementation (Myers algorithm). Used for line-level and
  word-level diffing and for producing unified-diff patch text. Exposes `window.Diff`.

Note: PDF text extraction on /diff/ reuses the already-vendored pdf.js under
`assets/js/pdflib/` (Apache-2.0; see `assets/js/pdflib/VENDOR-LICENSES.md`).

To update: re-download the same files from the upstream release and bump the versions here.
