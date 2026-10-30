---
title: "Vendored: tesseract.js and its language models (for /pdftools/ OCR)"
description: "Licenses and sources of tesseract.js and the OCR language models that PDF Toolbench serves from this site."
---

Served from this site, lazy-loaded only when "Make searchable (OCR)" runs; nothing is fetched
from a third-party server. The registry of every vendored library for the toolbench is
`assets/js/pdflib/VENDOR-LICENSES.md`; this file details this directory.

## tesseract.js
- tesseract.js **5.1.1**: `tesseract.min.js`, `worker.min.js` (+ the webpack-extracted
  `*.LICENSE.txt` notices, kept alongside)
- tesseract.js-core **5.1.1**: `tesseract-core-simd-lstm.wasm.js`, `tesseract-core-lstm.wasm.js`
  (single-file builds with the wasm embedded; only the two LSTM cores are vendored because the
  toolbench always runs OEM 1, LSTM only)
- License: **Apache License 2.0**, copies kept here as `LICENSE-tesseract.js.txt` and
  `LICENSE-tesseract.js-core.txt` (https://github.com/naptha/tesseract.js,
  https://github.com/naptha/tesseract.js-core)

## Language models: `lang/<code>.traineddata.gz`
- **tessdata_fast** (https://github.com/tesseract-ocr/tessdata_fast), License: **Apache
  License 2.0** (https://github.com/tesseract-ocr/tessdata_fast/blob/main/LICENSE).
- `eng` was vendored 2026-07 from https://github.com/naptha/tessdata (gh-pages, `4.0.0_fast/`);
  its uncompressed bytes are identical to tessdata_fast `main` (sha256 below, checked
  2026-10-27), and the file was left untouched.
- The other 21 were downloaded 2026-10-27 from tessdata_fast at commit
  `87416418657359cb625c412a48b6e1d6d41c29bd` (the `main` branch that day), as
  `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/<commit>/<code>.traineddata`,
  and gzipped here with `gzip -9 -n` (tesseract.js is created with `gzip: true`).
- sha256 is of the UNCOMPRESSED `.traineddata` (the upstream file); the `.gz` size is what a
  visitor downloads.

| code | language | raw bytes | raw sha256 | .gz bytes |
|---|---|---:|---|---:|
| `ara` | Arabic | 1432056 | `e3206d3dc87fd50c24a0fb9f01838615911d25168f4e64415244b67d2bb3e729` | 716700 |
| `chi_sim` | Chinese, Simplified | 2469156 | `a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730` | 1723376 |
| `chi_tra` | Chinese, Traditional | 2366642 | `529c5b5797d64b126065cd55f2bb4c7fd7b15790798091b1ff259941a829330b` | 1663276 |
| `deu` | German | 1525436 | `19d219bbb6672c869d20a9636c6816a81eb9a71796cb93ebe0cb1530e2cdb22d` | 850737 |
| `ell` | Greek | 1419514 | `4fba8a0b461038d51f1c20d043d4f2ac38c4e778f1b90830847f7bd8fa3ba726` | 702056 |
| `eng` | English | 4113088 | `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2` | 1984273 |
| `fra` | French | 1130365 | `ced037562e8c80c13122dece28dd477d399af80911a28791a66a63ac1e3445ca` | 606702 |
| `heb` | Hebrew | 961404 | `11f9e43ab227f786352a50f75c94c2e9906f1baba86d93276da19da7ce0904db` | 476527 |
| `hin` | Hindi | 1122751 | `4c73ffc59d497c186b19d1e90f5d721d678ea6b2e277b719bee4e2af12271825` | 923147 |
| `ind` | Indonesian | 1122661 | `69786901da87ab8766c1ea7fbb10b28f2110c14da3f6c8f2735df131fba95d88` | 607760 |
| `ita` | Italian | 2701314 | `b8f89e1e785118dac4d51ae042c029a64edb5c3ee42ef73027a6d412748d8827` | 1271630 |
| `jpn` | Japanese | 2471260 | `1f5de9236d2e85f5fdf4b3c500f2d4926f8d9449f28f5394472d9e8d83b91b4d` | 1519725 |
| `kor` | Korean | 1677415 | `6b85e11d9bbf07863b97b3523b1b112844c43e713df8b66418a081fd1060b3b2` | 1106990 |
| `nld` | Dutch | 6050296 | `ced0e5e046a84c908a6aa7accbef9a232c4a5d9a8276691b81c6ee64d02963f6` | 2976725 |
| `pol` | Polish | 4765518 | `c4476cdbc0e33d898d32345122b7be1cbf85ace15f920f06c7714756e1ef79b2` | 2026921 |
| `por` | Portuguese | 1982756 | `c4932b937207a9514b7514d518b931a99938c02a28a5a5a553f8599ed58b7deb` | 1000041 |
| `rus` | Russian | 3861738 | `e16e5e036cce1d9ec2b00063cf8b54472625b9e14d893a169e2b0dedeb4df225` | 1599713 |
| `spa` | Spanish | 2294433 | `6f2e04d02774a18f01bed44b1111f2cd7f3ba7ac9dc4373cd3f898a40ea6b464` | 1127456 |
| `tha` | Thai | 1072600 | `294227cc2d1292b0acb28d61d4115c88252b96d466ca90b417cf4cf0c67bf07c` | 905989 |
| `tur` | Turkish | 4550554 | `7393381111e1152420fc4092cb44eef4237580d21b92bf30d7d221aad192c6b7` | 2004899 |
| `ukr` | Ukrainian | 3825102 | `d59e53e2bded32f4445f124b4b00240fcac7e8044c003ab822ccb94f0b3db59b` | 1611871 |
| `vie` | Vietnamese | 531275 | `79df64caf7bcfb2a27df5042ecb6121e196eada34da774956995747636d5bfa1` | 421978 |

The 21 added models total 25,844,219 bytes gzipped (eng adds 1,984,273). To update: download
the same file names from a pinned tessdata_fast commit, check the sha256, gzip with
`gzip -9 -n`, update this table and the `gz` sizes in `assets/js/pdftools-tools.js`
(`OCR_LANGS`, shown in the OCR dialog).

## The OCR text layer's font (in `assets/js/pdftools.js`, not a file here)
`PURE.GLYPHLESS_TTF` is a 740-byte TrueType font built from scratch for this site by
`_tests/pdftools/ocr-lang/make-glyphless.py` (no third-party font data): one glyph whose only
outline is two one-point contours (nothing to paint), used to write the invisible, searchable
text of non-WinAnsi OCR words.
