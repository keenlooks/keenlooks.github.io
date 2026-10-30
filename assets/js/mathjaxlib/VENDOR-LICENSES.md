---
title: "Vendored third-party library: MathJax 2.7.9"
description: "License and source of the MathJax copy this site serves for the paper pages that typeset math."
---

MathJax typesets the math on the paper pages that opt in with `math: true` front matter
(`_includes/head/custom.html` loads it only there). It used to load from cdnjs with a
Subresource Integrity hash on `MathJax.js` alone, while the files MathJax's own loader
fetched afterwards (the combined config, the CommonHTML output, its font data and the
web fonts) had none. Serving a pinned copy from this site removes that gap.

## MathJax 2.7.9
- Source: the npm package `mathjax@2.7.9`
  (https://registry.npmjs.org/mathjax/-/mathjax-2.7.9.tgz, integrity
  `sha512-NOGEDTIM9+MrsqnjPEjVGNx4q0GQxqm61yQwSK+/5S59i26wId5IC5gNu9/bu8+CCVl5p9G2IHcAl/wJa+5+BQ==`,
  checked on download, 2026-10-29). `MathJax.js` is byte-identical to the cdnjs file the site
  used (same sha512 as its old SRI attribute).
- License: **Apache-2.0** (a copy is kept next to the files as `LICENSE`).
- Files kept, unmodified: `MathJax.js`, `config/TeX-MML-AM_CHTML.js`, `jax/input/`,
  `jax/element/`, `jax/output/CommonHTML/`, `jax/output/PreviewHTML/`, `extensions/`
  (including the accessibility extensions the menu can turn on), `localization/`, and the
  TeX web fonts `fonts/HTML-CSS/TeX/woff/` and `fonts/HTML-CSS/TeX/otf/`. The HTML-CSS,
  SVG and NativeMML output processors are not shipped, so the page's MathJax config hides
  the menu's renderer switch.

To update: download the same files from a newer 2.x release, keep this list, and bump the
version and integrity here.
