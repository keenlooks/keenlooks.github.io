/* PDF Toolbench (/pdftools/) — fully client-side. Nothing is uploaded; this file makes
   no network requests with your PDF. Rendering uses pdf.js (Apache-2.0, Mozilla); editing
   uses pdf-lib (MIT). Both are vendored locally under assets/js/pdflib/. OCR (lazy-loaded
   on first use) is tesseract.js (Apache-2.0) under assets/js/tesseractlib/; encryption is
   qpdf compiled to wasm (Apache-2.0) under assets/js/qpdflib/.

   External file (never HTML-compressed) so // comments are fine here. */
(function () {
  'use strict';

  /* ==================================================================================
     PURE helpers — no DOM, no pdf.js. Exposed as window.__PT_PURE in the browser and
     as module.exports under node so the test harness can exercise the exact same code.
     ================================================================================== */
  var PURE = {};

  // "1-5, 9, 12-" -> array of 0-based page indices (deduped, in the order given),
  // or null if the string is invalid for a document with `total` pages.
  PURE.parsePageRange = function (str, total) {
    if (str == null || !total) return null;
    var s = String(str).trim();
    if (!s) return null;
    var out = [], seen = {}, parts = s.split(',');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (!p) return null;
      var m = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(p);
      if (!m) return null;
      var a = m[1] ? parseInt(m[1], 10) : null;
      var dash = !!m[2];
      var b = m[3] ? parseInt(m[3], 10) : null;
      if (a == null && b == null) return null;           // "-" or garbage
      if (!dash) { if (a == null) return null; b = a; }  // single number
      if (a == null) a = 1;                              // "-5" == "1-5"
      if (b == null) b = total;                          // "12-" == "12-last"
      if (a < 1 || b > total || a > b) return null;
      for (var n = a; n <= b; n++) { if (!seen[n]) { seen[n] = 1; out.push(n - 1); } }
    }
    return out.length ? out : null;
  };

  // "Scan of lease (final).PDF" -> "Scan of lease (final)" (safe as a filename base)
  PURE.sanitizeBaseName = function (name) {
    var b = String(name || '').replace(/\.[^.]*$/, '');
    b = b.replace(/[\/\\:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (b.length > 60) b = b.slice(0, 60).trim();
    return b || 'document';
  };

  // export filename derived from the first source file
  PURE.deriveExportName = function (firstName, nDocs, kind) {
    var b = PURE.sanitizeBaseName(firstName);
    switch (kind) {
      case 'download':   return nDocs > 1 ? b + '-merged.pdf' : b + '.pdf';
      case 'extract':    return b + '-extract.pdf';
      case 'compressed': return b + '-compressed.pdf';
      case 'split':      return b + '-pages.zip';
      case 'protected':  return b + '-protected.pdf';
      case 'images':     return b + '-images.zip';
      default:           return b + '.pdf';
    }
  };

  // A file opened with its password is exported decrypted, so the "-protected" that
  // Protect put in its name ("lease-protected.pdf", or "lease-protected (1).pdf" after a
  // second download) must not ride into exports that are no longer protected.
  PURE.dropProtectedSuffix = function (name) {
    return String(name || '').replace(/-protected(?=(?: \(\d+\))?(?:\.pdf)?$)/i, '');
  };

  // MS-DOS date and time words for a ZIP entry: local time, two-second resolution, and
  // nothing before 1980 (the format's epoch; an all-zero date reads as 00-00-1980)
  PURE.dosDateTime = function (d) {
    var y = d.getFullYear();
    if (!(y >= 1980)) return { date: (1 << 5) | 1, time: 0 };
    return {
      date: ((Math.min(y, 2107) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
    };
  };

  // A JPEG as a camera or phone wrote it carries more than pixels: EXIF (GPS position,
  // camera make, model and serial, capture time), XMP, IPTC, an ICC profile, MPF secondary
  // images, comments, and on some phones data appended after the image. None of it belongs
  // in a PDF made from the photo (pdf-lib's embedJpg stores the file as it is, whatever
  // "Strip metadata" says). Returns { orientation (the EXIF tag, 1 when absent or bad),
  // w, h (the STORED pixel size, from the frame header), bytes } where bytes keeps only
  // what decoding needs: SOI, a JFIF APP0, an Adobe APP14 (it says how to read CMYK), the
  // tables, the frame header, the scans, EOI; everything else is dropped, and so is
  // anything after EOI. null when the data does not parse (the caller then re-encodes
  // the picture through a canvas instead). The compressed image data is not touched.
  PURE.cleanJpeg = function (b) {
    if (!b || b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null;
    var n = b.length, keep = [[0, 2]], i = 2, orientation = 1, w = 0, h = 0, inScan = false;
    function u16(p, le) { return le ? (b[p] | (b[p + 1] << 8)) : ((b[p] << 8) | b[p + 1]); }
    function u32(p, le) { return le ? ((b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) + b[p + 3] * 16777216) : (b[p] * 16777216 + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3])); }
    function has(p, s) { for (var k = 0; k < s.length; k++) if (b[p + k] !== s.charCodeAt(k)) return false; return true; }
    // the Orientation tag (0x0112, SHORT) in IFD0 of the TIFF block starting at t, inside [t, end)
    function exifOrientation(t, end) {
      if (t + 8 > end) return 0;
      var le = b[t] === 0x49 && b[t + 1] === 0x49;
      if (!le && !(b[t] === 0x4D && b[t + 1] === 0x4D)) return 0;
      if (u16(t + 2, le) !== 42) return 0;
      var ifd = t + u32(t + 4, le);
      if (ifd + 2 > end) return 0;
      var cnt = u16(ifd, le);
      for (var k = 0; k < cnt; k++) {
        var e = ifd + 2 + k * 12;
        if (e + 12 > end) return 0;
        if (u16(e, le) === 0x0112 && u16(e + 2, le) === 3) {
          var v = u16(e + 8, le);
          return v >= 1 && v <= 8 ? v : 0;
        }
      }
      return 0;
    }
    while (i < n) {
      if (inScan) {
        // entropy-coded data runs to the next marker that is not a stuffed FF00 or an RSTn
        var j = i;
        while (j < n - 1 && !(b[j] === 0xFF && b[j + 1] !== 0x00 && !(b[j + 1] >= 0xD0 && b[j + 1] <= 0xD7))) j++;
        if (j >= n - 1) return null;   // no EOI: truncated
        keep.push([i, j]); i = j; inScan = false;
        continue;
      }
      if (b[i] !== 0xFF || i + 1 >= n) return null;
      var m = b[i + 1];
      if (m === 0xFF) { i++; continue; }                                       // fill byte
      if (m === 0xD9) {                                                        // EOI: stop here
        keep.push([i, i + 2]);
        if (!(w > 0 && h > 0)) return null;
        var size = keep.reduce(function (a, r) { return a + r[1] - r[0]; }, 0);
        var out = new Uint8Array(size), pos = 0;
        keep.forEach(function (r) { out.set(b.subarray(r[0], r[1]), pos); pos += r[1] - r[0]; });
        return { orientation: orientation, w: w, h: h, bytes: out };
      }
      if (m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { keep.push([i, i + 2]); i += 2; continue; }
      if (i + 4 > n) return null;
      var len = u16(i + 2), end = i + 2 + len;
      if (len < 2 || end > n) return null;
      var drop = false;
      if (m === 0xFE) drop = true;                                              // COM
      else if (m >= 0xE0 && m <= 0xEF) {                                        // APPn
        if (m === 0xE1 && orientation === 1 && has(i + 4, 'Exif\0\0')) orientation = exifOrientation(i + 10, end) || 1;
        drop = !((m === 0xE0 && has(i + 4, 'JFIF\0')) || (m === 0xEE && has(i + 4, 'Adobe')));
      }
      // SOF0..SOF15 (not DHT C4, JPG C8, DAC CC): precision, height, width
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC && len >= 7) { h = u16(i + 5); w = u16(i + 7); }
      if (!drop) keep.push([i, end]);
      if (m === 0xDA) inScan = true;
      i = end;
    }
    return null;
  };

  // The PDF drawing matrix (a b c d e f, for the cm operator) that shows a stored image
  // the way a viewer honouring EXIF orientation o shows the photo, on a page of PW x PH
  // points that is already sized to the UPRIGHT picture (so 5 to 8 swap the stored width
  // and height). PDF draws an image into the unit square with its first stored row at
  // the top; 1 is the plain [PW 0 0 PH 0 0].
  PURE.orientMatrix = function (o, PW, PH) {
    switch (o) {
      case 2: return [-PW, 0, 0, PH, PW, 0];      // mirrored left to right
      case 3: return [-PW, 0, 0, -PH, PW, PH];    // turned 180
      case 4: return [PW, 0, 0, -PH, 0, PH];      // mirrored top to bottom
      case 5: return [0, -PH, -PW, 0, PW, PH];    // transposed
      case 6: return [0, -PH, PW, 0, 0, PH];      // turned 90 clockwise
      case 7: return [0, PH, PW, 0, 0, 0];        // transversed
      case 8: return [0, PH, -PW, 0, PW, 0];      // turned 90 counterclockwise
      default: return [PW, 0, 0, PH, 0, 0];
    }
  };

  // Plan the COPY-route pages of an export into as few pdf-lib copyPages() calls as
  // possible. This is the whole fix for the split-size bug: pdf-lib 1.17.1 builds a FRESH
  // PDFObjectCopier inside every copyPages() call, and that copier's traversedObjects map
  // is the only thing stopping a shared object being copied twice. One call per page
  // therefore re-copies the master slide, the fonts and every logo once PER PAGE. A
  // 50 MB, 908-slide deck split in half came back as two 120 MB files.
  //
  // `routes` is parallel to the export's page list; an entry with .copy true carries the
  // .docIndex / .pageIndex to copy, everything else (bake, blank, raster, failed) is
  // skipped here and handled by its own route.
  //
  // Returns batches [{ docIndex, indices, slots }] where slots[k] is the position in
  // `routes` that indices[k] belongs to. Rules:
  //   - ONE batch per source document: EVERY index of that document, repeats included,
  //     in page-list order
  //   - batch order follows first appearance of the document
  //
  // 2026-09-20 (round 2): a repeated source page used to be pushed into a SECOND call
  // for that document, on the theory that one copier hands back the same copied node
  // for a repeated index, so two output pages would share a dictionary and one page's
  // rotation would move the other. That is not what pdf-lib 1.17.1 does: copyPDFPage
  // clones the page dictionary before the copier's cache is consulted, so a repeated
  // index yields distinct wrappers, distinct nodes and distinct refs, and independent
  // rotation survives a save and reload. Two independent probes say so:
  // _tests/pdftools/split-size/review/probe-node.js (A) and review/dup-guard.js. The
  // extra call cost a whole extra copy of the shared pile per repeat, which is the
  // owner's bug in miniature (one Duplicate click, 1.82x the export), so it is gone.
  //
  // 2026-09-20 (round 3): that clone is SHALLOW, and the two probes above only looked at
  // the dictionary, the refs and the rotation. The clone's /Contents VALUE is the source
  // page's own object, and the copier caches by that object's identity for the whole
  // call, so the two copies came back sharing ONE copied /Contents array and every
  // overlay drawn on one landed on the other (page numbers read "1 2" on both copies).
  // The repeats stay in the one call; PURE.unshareCopiedContents below un-shares the
  // array afterwards.
  PURE.planCopyBatches = function (routes) {
    var order = [], byDoc = {};
    (routes || []).forEach(function (r, i) {
      if (!r || !r.copy) return;
      var d = r.docIndex;
      if (!byDoc[d]) { byDoc[d] = { docIndex: d, indices: [], slots: [] }; order.push(d); }
      byDoc[d].indices.push(r.pageIndex);
      byDoc[d].slots.push(i);
    });
    return order.map(function (d) { return byDoc[d]; });
  };

  // Un-share the /Contents arrays of pages that one copyPages() call handed back sharing
  // one. pdf-lib 1.17.1's PDFObjectCopier.copyPDFPage clones the page DICTIONARY (so the
  // dicts, the refs and /Rotate really are independent) but the clone is shallow, and
  // copyPDFArray / copyPDFIndirectObject cache by the ORIGINAL object's identity for the
  // whole call. Two copies of one source page therefore come back pointing at the same
  // copied /Contents array, and PDFPage.drawText pushes each page's overlay into it: a
  // page number, a watermark scoped to the duplicate, a text box or a signature drawn on
  // one copy is drawn on the other, while the model, the thumbnails and the editor all
  // say it is on one page. (Reproduced by the reviewer at the library level in
  // _tests/pdftools/split-size/review2/contents-share.js and on the served page with real
  // clicks in review2/dup-overlay.js, dup-image.js and dup-watermark.js.)
  //
  // Every copy past the first claim on a copied array gets its OWN array holding the SAME
  // stream refs, so the content streams stay shared and the size win of the single batched
  // call is untouched (measured at 2 bytes on the reviewer's probe), while each page keeps
  // only its own marks. By the shapes a source /Contents can take:
  //   - a direct array                    leaks; replaced
  //   - an indirect ref to an ARRAY       leaks; replaced with a direct array of the same refs
  //   - an indirect ref to a single STREAM already safe (PDFPageLeaf.normalize wraps it in a
  //                                       fresh array per page); left alone, since registering
  //                                       a second ref to that stream would duplicate its bytes
  //   - no /Contents at all               nothing to share; left alone
  // Keyed on the copied array's identity rather than on the repeated index, so two distinct
  // source pages that share one /Contents array are covered too.
  //
  // WHAT STAYS SHARED (2026-09-20, the round 3 reviewer, review3/shared-objects.js): after this
  // step two copies of one source page still share their /Resources dict, their /Annots array
  // and their /MediaBox by identity (the pre-fix one-call-per-page shape shared none of them).
  // Nothing in pdftools*.js mutates /Annots or /MediaBox, and /Resources is only ever ADDED to
  // with randomly suffixed keys, so today that is harmless and a duplicated page carrying a
  // link and a form field exports correctly (review3/annots-dup.js). The first per-copy
  // mutation of any of those three must un-share it here the same way, or it will leak to
  // the twin exactly as /Contents did.
  //
  // `Lib` is the pdf-lib namespace (window.PDFLib in the page) and `ctx` the output
  // document's PDFContext; passing them in is what lets the node suite exercise this exact
  // function without a DOM. Returns how many pages were given a new array. Never throws:
  // an export must not die because a page had an odd /Contents.
  PURE.unshareCopiedContents = function (Lib, ctx, copies) {
    var KEY = Lib.PDFName.of('Contents'), claimed = new Set(), n = 0;
    (copies || []).forEach(function (cp) {
      try {
        var node = cp && cp.node; if (!node) return;
        var val = node.get(KEY); if (!val) return;
        var arr = (val instanceof Lib.PDFRef) ? ctx.lookup(val) : val;
        if (!(arr instanceof Lib.PDFArray)) return;
        if (!claimed.has(arr)) { claimed.add(arr); return; }
        var refs = [];
        for (var i = 0; i < arr.size(); i++) refs.push(arr.get(i));
        node.set(KEY, ctx.obj(refs));
        n++;
      } catch (e) {}
    });
    return n;
  };

  // deep-enough page clone for the undo stack: identity + small mutable bits are copied,
  // large immutable byte arrays (raster png, signature pngs) are shared by reference
  // (they are replaced wholesale, never mutated in place).
  PURE.clonePage = function (pg) {
    return {
      docIndex: pg.docIndex, pageIndex: pg.pageIndex,
      rot: pg.rot || 0, sel: !!pg.sel,
      raster: pg.raster || null,
      blank: pg.blank ? { wPt: pg.blank.wPt, hPt: pg.blank.hPt } : null,
      ocr: !!pg.ocr,
      redacts: (pg.redacts || []).map(function (r) { return { x: r.x, y: r.y, w: r.w, h: r.h }; }),
      // white-out boxes: the same {x,y,w,h} normalized rects, the same frame as redacts
      whiteouts: (pg.whiteouts || []).map(function (r) { return { x: r.x, y: r.y, w: r.w, h: r.h }; }),
      sigs: (pg.sigs || []).map(function (s) { return { png: s.png, x: s.x, y: s.y, w: s.w, h: s.h }; }),
      texts: (pg.texts || []).map(PURE.copyTextEntry),
      wms: (pg.wms || []).map(function (w) { return { text: w.text, pos: w.pos, opacity: w.opacity, size: w.size }; }),
      ocrWords: pg.ocrWords ? pg.ocrWords.slice() : null
    };
  };

  // rotate normalized {x,y,w,h} rects (fractions of the effective page) by a multiple of
  // 90°, so redaction boxes keep covering the same CONTENT when a page is rotated.
  PURE.rotateRects = function (rects, delta) {
    var d = ((delta % 360) + 360) % 360;
    return (rects || []).map(function (r) {
      if (d === 90) return { x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w };
      if (d === 180) return { x: 1 - r.x - r.w, y: 1 - r.y - r.h, w: r.w, h: r.h };
      if (d === 270) return { x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w };
      return { x: r.x, y: r.y, w: r.w, h: r.h };
    });
  };

  // rotate OCR word bboxes ({text,x0,y0,x1,y1} normalized, y down) with the page, same
  // frame as rotateRects — if the words stayed in the old frame while the redaction
  // rects rotated, the overlap filter below would stop matching and redacted text
  // could survive in the invisible text layer
  PURE.rotateWords = function (words, delta) {
    if (!words) return words;
    var d = ((delta % 360) + 360) % 360;
    return words.map(function (w) {
      if (d === 90) return { text: w.text, x0: 1 - w.y1, y0: w.x0, x1: 1 - w.y0, y1: w.x1 };
      if (d === 180) return { text: w.text, x0: 1 - w.x1, y0: 1 - w.y1, x1: 1 - w.x0, y1: 1 - w.y0 };
      if (d === 270) return { text: w.text, x0: w.y0, y0: 1 - w.x1, x1: w.y1, y1: 1 - w.x0 };
      return { text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 };
    });
  };

  // rotate a normalized POINT (fraction of the effective page) by a multiple of 90°,
  // same frame/formula as rotateRects (a zero-size rect) — the generalized point rotator
  PURE.rotatePoint = function (x, y, delta) {
    var r = PURE.rotateRects([{ x: x, y: y, w: 0, h: 0 }], delta)[0];
    return { x: r.x, y: r.y };
  };

  // rotate text annotations' anchors with the page, same frame as rotateRects/rotateWords
  // (fractions of the EFFECTIVE page view). Text is always drawn upright/horizontal here
  // (there is no glyph-rotation support), so the ANCHOR is what moves; font size is in
  // absolute PDF points and is unaffected by which way the page is turned.
  // `boxes` (optional) is a parallel array of {w,h} — an approximate normalized bounding
  // box for each text, measured by the caller (a canvas is needed for that, so it can't
  // happen in this DOM-free PURE function). Treating the anchor as a bare POINT (the
  // default when boxes is omitted) is only correct for text sitting well clear of the
  // page edge — a real box lets the rotation account for the box's own footprint, so text
  // placed close to an edge does not get rotated into a spot where it runs off the page.
  // `Wpt`/`Hpt` (also optional) are the CURRENT effective page size in points, before this
  // rotation — with them supplied, the anchor is additionally clamped so the text's own
  // PHYSICAL size (which never changes; the glyphs are never actually rotated) still fits
  // inside the rotated page, rather than only having its footprint's fraction swapped
  // (fine for redaction rects, which have no fixed physical content, but not for text).
  PURE.rotateTexts = function (texts, delta, boxes, Wpt, Hpt) {
    var d = ((delta % 360) + 360) % 360, swap = (d === 90 || d === 270);
    return (texts || []).map(function (t, i) {
      var b = (boxes && boxes[i]) || { w: 0, h: 0 };
      var r = PURE.rotateRects([{ x: t.x, y: t.y, w: b.w, h: b.h }], delta)[0];
      if (Wpt && Hpt) {
        var wNew = swap ? b.w * (Wpt / Hpt) : b.w;
        var hNew = swap ? b.h * (Hpt / Wpt) : b.h;
        r.x = Math.min(r.x, Math.max(0, 1 - wNew));
        r.y = Math.min(r.y, Math.max(0, 1 - hNew));
      }
      var o = PURE.copyTextEntry(t);
      o.x = r.x; o.y = r.y;
      // w is a fraction of the effective page WIDTH: after a quarter turn the page's
      // width is the old height, so an unchanged fraction would be a different PHYSICAL
      // width and the box would re-wrap at a different measure. Remapping it keeps the
      // box's physical width and its line breaks; lh, align and runs pass through.
      if (swap && Wpt && Hpt && typeof o.w === 'number' && isFinite(o.w) && o.w > 0) {
        o.w = Math.min(1, o.w * (Wpt / Hpt));
      }
      return o;
    });
  };

  // rotate signature rects with the page — same treatment PURE.rotateRects already gives
  // redaction boxes (position + a w/h swap on 90°/270°). The placed PNG itself is never
  // re-rendered, so this keeps the box (and thus the signature) anchored to the same
  // corner/edge of the rotated page rather than left in the old, now-wrong, position.
  PURE.rotateSigs = function (sigs, delta) {
    return (sigs || []).map(function (s) {
      var r = PURE.rotateRects([{ x: s.x, y: s.y, w: s.w, h: s.h }], delta)[0];
      return { png: s.png, x: r.x, y: r.y, w: r.w, h: r.h };
    });
  };

  // drop OCR words whose box overlaps any redaction rect — the invisible text layer
  // must never resurrect content the user blacked out
  PURE.filterOcrWords = function (words, rects) {
    if (!words || !rects || !rects.length) return words;
    return words.filter(function (w) {
      return !rects.some(function (r) {
        return w.x0 < r.x + r.w && w.x1 > r.x && w.y0 < r.y + r.h && w.y1 > r.y;
      });
    });
  };

  // white-out boxes on an exported page: one white rectangle per box, in page points.
  // The rects are {x,y,w,h} fractions of the effective page, y down (the frame pg.redacts
  // uses), and W x H at (ox, oy) is the box of the page those fractions are of: the visible
  // page (its CropBox), which is the page pdf.js shows in every preview. ox and oy default
  // to 0. The rects must be in the page's UNROTATED frame: drawOverlays maps them back
  // through PURE.rotateRects when the output page carries a /Rotate, so a rotated page
  // keeps its vector text (no flatten). Fill only: no border and no opacity, so no
  // graphics state is written. The content under the box stays in the file, which is
  // what makes it a white-out and not a redaction.
  // Returns the number of rectangles drawn.
  PURE.drawWhiteouts = function (P, page, rects, W, H, ox, oy) {
    var drawn = 0;
    ox = ox || 0; oy = oy || 0;
    (rects || []).forEach(function (r) {
      if (!r || !(r.w > 0) || !(r.h > 0) || !isFinite(r.x) || !isFinite(r.y)) return;
      page.drawRectangle({ x: ox + r.x * W, y: oy + (H - (r.y + r.h) * H), width: r.w * W, height: r.h * H, color: P.rgb(1, 1, 1) });
      drawn++;
    });
    return drawn;
  };

  // White-outs hide CHARACTERS, not whole runs. A text token or OCR word ({text, x0, y0,
  // x1, y1}, fractions, y down) loses exactly the characters whose centre sits under a
  // white-out (the rect must also cover the token's vertical middle), and the text before
  // and after comes back as separate tokens with their own boxes. Each character's share
  // of the token's width is its Helvetica advance from `table` (the AFM table every
  // picture already measures with; 0.5 em for a character it has no advance for; equal
  // shares without a table): a proportional split, not a measurement of the source font.
  // A token taller than 2.5 times its font size (vertical text) keeps the whole-token
  // rule. Redactions keep the whole-run rule (PURE.filterOcrWords): this is for
  // white-outs only, where hiding more than is covered loses words the reader can see.
  // Tokens no rect touches come back as the same objects, in order.
  // Two things the token can say about its run (PURE.itemToToken carries them from pdf.js):
  // dir, pdf.js's own direction for the run: an 'rtl' run comes in LOGICAL order with its
  // first character drawn at the RIGHT end, so its characters are laid out from the right
  // edge, except the stretches pdf.js's own bidi put left to right (numbers, Latin words:
  // PURE.rtlSegments); a token with no dir (an OCR word) is left to right. And mono, a
  // fixed-pitch font, whose characters all get the same share. A cut rtl run comes back as
  // ONE token, its kept stretches in logical order joined by a space (PURE.groupLines orders
  // a line's tokens left to right, which would swap the halves of an rtl run).
  //
  // pdf.js 3.11.174's bidi (its src/core/bidi.js, Apache-2.0, Mozilla Foundation), ported
  // rule for rule: the character type table (one letter per type: L, R, A = AL, E = EN,
  // S = ES, T = ET, N = AN, C = CS, M = NSM, b = BN, s = S, p = B, W = WS, O = ON, '.' none)
  // and rules W1 to W7, N1 (with pdf.js's own neighbour read), N2, I1, I2.
  var BIDI_LO = 'bbbbbbbbbspsWpbbbbbbbbbbbbbbpppsWOOTTTOOOOOSCSCCEEEEEEEEEECOOOOO' +
    'OLLLLLLLLLLLLLLLLLLLLLLLLLLOOOOOOLLLLLLLLLLLLLLLLLLLLLLLLLLOOOOb' +
    'bbbbbpbbbbbbbbbbbbbbbbbbbbbbbbbbCOTTTTOOOOLOObOOTTEEOLOOOELOOOOO' +
    'LLLLLLLLLLLLLLLLLLLLLLLOLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLOLLLLLLLL';
  var BIDI_AR = 'NNNNNNOOATTACAOOMMMMMMMMMMMAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAMMMMMMMMMMMMMMMMMMMMMNNNNNNNNNNTNNAAAMAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAMMMMMMMNOMMMMMMAAMMOMMMMAAEEEEEEEEEEAAAAAA';
  function bidiType(c) {
    if (c <= 255) return BIDI_LO.charAt(c);
    if (c >= 1424 && c <= 1524) return 'R';
    if (c >= 1536 && c <= 1791) return BIDI_AR.charAt(c & 255);
    if ((c >= 1792 && c <= 2220) || (c >= 64336 && c <= 65023) || (c >= 65136 && c <= 65279)) return 'A';
    return 'L';
  }
  // the resolved embedding level of every character of s, start level t (0 ltr, 1 rtl)
  function bidiLevels(s, t) {
    var l = s.length, o = [], f = [], h, e, b, y, n, bt, at, g = (t & 1) ? 'R' : 'L';
    for (h = 0; h < l; h++) { o[h] = bidiType(s.charCodeAt(h)); f[h] = t; }
    y = g; for (h = 0; h < l; h++) { if (o[h] === 'M') o[h] = y; else y = o[h]; }
    y = g; for (h = 0; h < l; h++) { b = o[h]; if (b === 'E') o[h] = y === 'A' ? 'N' : 'E'; else if (b === 'R' || b === 'L' || b === 'A') y = b; }
    for (h = 0; h < l; h++) if (o[h] === 'A') o[h] = 'R';
    for (h = 1; h < l - 1; h++) {
      if (o[h] === 'S' && o[h - 1] === 'E' && o[h + 1] === 'E') o[h] = 'E';
      if (o[h] === 'C' && (o[h - 1] === 'E' || o[h - 1] === 'N') && o[h + 1] === o[h - 1]) o[h] = o[h - 1];
    }
    for (h = 0; h < l; h++) if (o[h] === 'E') {
      for (e = h - 1; e >= 0 && o[e] === 'T'; e--) o[e] = 'E';
      for (e = h + 1; e < l && o[e] === 'T'; e++) o[e] = 'E';
    }
    for (h = 0; h < l; h++) { b = o[h]; if (b === 'W' || b === 'S' || b === 'T' || b === 'C') o[h] = 'O'; }
    y = g; for (h = 0; h < l; h++) { b = o[h]; if (b === 'E') o[h] = y === 'L' ? 'L' : 'E'; else if (b === 'R' || b === 'L') y = b; }
    for (h = 0; h < l; h++) if (o[h] === 'O') {
      for (e = h + 1; e < l && o[e] === 'O'; e++) { /* the run of neutrals */ }
      bt = h > 0 ? o[h - 1] : g;
      at = e + 1 < l ? o[e + 1] : g;   // pdf.js reads one past the run's end (its own code)
      if (bt !== 'L') bt = 'R';
      if (at !== 'L') at = 'R';
      if (bt === at) for (n = h; n < e; n++) o[n] = bt;
      h = e - 1;
    }
    for (h = 0; h < l; h++) if (o[h] === 'O') o[h] = g;
    for (h = 0; h < l; h++) {
      b = o[h];
      if (!(f[h] & 1)) { if (b === 'R') f[h] += 1; else if (b === 'N' || b === 'E') f[h] += 2; }
      else if (b === 'L' || b === 'N' || b === 'E') f[h] += 1;
    }
    return f;
  }
  function revIn(a, i, j) { var x; for (j--; i < j; i++, j--) { x = a[i]; a[i] = a[j]; a[j] = x; } }
  // pdf.js's own bidi(): what getTextContent hands over ({str, dir}) for a run DRAWN as s
  PURE.pdfjsBidi = function (s) {
    s = String(s);
    var l = s.length, d = 0, h, t, ty, f, ch, hi = -1, lo = 99, w, st;
    if (!l) return { str: s, dir: 'ltr' };
    for (h = 0; h < l; h++) { ty = bidiType(s.charCodeAt(h)); if (ty === 'R' || ty === 'A' || ty === 'N') d++; }
    if (!d) return { str: s, dir: 'ltr' };
    t = (d / l < 0.3 && l > 4) ? 0 : 1;
    f = bidiLevels(s, t); ch = s.split('');
    for (h = 0; h < l; h++) { w = f[h]; if (hi < w) hi = w; if (lo > w && (w & 1)) lo = w; }
    for (w = hi; w >= lo; w--) {
      st = -1;
      for (h = 0; h < l; h++) {
        if (f[h] < w) { if (st >= 0) { revIn(ch, st, h); st = -1; } }
        else if (st < 0) st = h;
      }
      if (st >= 0) revIn(ch, st, l);
    }
    for (h = 0; h < l; h++) if (ch[h] === '<' || ch[h] === '>') ch[h] = '';
    return { str: ch.join(''), dir: t ? 'rtl' : 'ltr' };
  };
  function levelSegs(f) {
    var out = [], i = 0, j;
    while (i < f.length) {
      if (f[i] < 2) { out.push([i, i + 1, false]); i++; continue; }
      for (j = i + 1; j < f.length && f[j] >= 2; j++) { /* one left-to-right block */ }
      out.push([i, j, true]); i = j;
    }
    return out;
  }
  function segsDrawn(s, segs) { var v = '', g, q; for (g = segs.length - 1; g >= 0; g--) for (q = segs[g][0]; q < segs[g][1]; q++) v += s.charAt(q); return v; }
  // PURE.rtlSegments: an rtl str (pdf.js's logical order) as [from, to, ltr] segments in
  // logical order: every run pdf.js's levels put at 2 or more is ONE left-to-right block,
  // every other character a segment of its own. pdf.js resolved its levels on the DRAWN
  // string, so the levels of str are a guess: the drawn order they give is checked by
  // running pdf.js's own reorder on it, and the levels of the reversed str are the second
  // guess (review5: the 3,940-line corpus 99.8 % exact, every hand case exact).
  PURE.rtlSegments = function (s) {
    s = String(s);
    var a = levelSegs(bidiLevels(s, 1));
    if (PURE.pdfjsBidi(segsDrawn(s, a)).str === s) return a;
    var b = levelSegs(bidiLevels(s.split('').reverse().join(''), 1).reverse());
    if (PURE.pdfjsBidi(segsDrawn(s, b)).str === s) return b;
    return a;
  };
  // PURE.rtlUnionCover: which characters of an rtl run a white-out hides, never keeping one it
  // covers. pdf.js's str does not say how the neutrals (spaces, currency signs, punctuation)
  // between a right-to-left word and a left-to-right block were drawn: two drawings can give
  // the same str (review6: a price drawn "1,250 SIGN" or "SIGN 1,250" reads back the same).
  // The R / AL letters are level 1 and the L / EN / AN characters level 2 in any reading, so
  // a GAP (a stretch without an R / AL letter) fills the same slice of the drawn line in
  // every reading; only the order inside it changes. A gap is touched when the box meets
  // that slice (review7 M1). In a touched gap of two or more characters every level of its
  // neutrals (a non-spacing mark among them, review7 m1) is tried; a try is a possible truth
  // when pdf.js's own levels read it back as the gap's text, and a character is dropped if
  // ANY possible truth draws it under the box. pdf.js resolves a gap's levels from the gap,
  // the letters either side of it and the first character drawn past the right-hand letter
  // (its N1 reads one past a neutral run), so each try is checked on that short window, that
  // character both ways when the gap beyond could put a left-to-right letter there. Over 12
  // neutrals in a gap, or no try that reads back: that gap goes whole, which can be a whole
  // Latin phrase (review7 m2). It may drop visible characters of a touched gap; it never
  // keeps a covered one. Returns the covered flags by logical index.
  var RTL_NEUT = { O: 1, W: 1, S: 1, T: 1, C: 1, M: 1 };
  function visOfSegs(segs) { var v = [], g, q; for (g = segs.length - 1; g >= 0; g--) for (q = segs[g][0]; q < segs[g][1]; q++) v.push(q); return v; }
  function coverIn(vis, wts, sum, x0, W, row) {
    var c = [], pos = 0, k, q, cx;
    for (k = 0; k < vis.length; k++) {
      q = vis[k];
      cx = ((x0 + W * pos / sum) + (x0 + W * (pos + wts[q]) / sum)) / 2;
      pos += wts[q];
      c[q] = row.some(function (r) { return cx >= r.x && cx <= r.x + r.w; });
    }
    return c;
  }
  PURE.rtlUnionCover = function (s, segs, wts, sum, x0, W, row) {
    var n = s.length, ty = [], gv = visOfSegs(segs), out = coverIn(gv, wts, sum, x0, W, row), at = [], pos = 0, i, j, k;
    for (i = 0; i < n; i++) ty[i] = bidiType(s.charCodeAt(i));
    for (k = 0; k < gv.length; k++) { at[gv[k]] = pos; pos += wts[gv[k]]; }   // the guess's layout, once
    function letter(q) { return ty[q] === 'R' || ty[q] === 'A'; }
    function under(p) { return row.some(function (r) { return p >= r.x && p <= r.x + r.w; }); }
    function unionGap(i, j) {
      var len = j - i, p0 = Infinity, p1 = -Infinity, neu = [], ctx = [''], seen = Object.create(null), hit = [], valid = 0;
      var q, k, m, c, L, d, vs, lv, lg, cx, pp, lt = false, left, right;
      for (q = i; q < j; q++) { p0 = Math.min(p0, at[q]); p1 = Math.max(p1, at[q] + wts[q]); }
      var g0 = x0 + W * p0 / sum, g1 = x0 + W * p1 / sum;
      if (!row.some(function (r) { return r.x <= g1 && r.x + r.w >= g0; })) return;   // the box misses its slice
      for (q = i; q < j; q++) { hit[q] = false; if (RTL_NEUT[ty[q]]) neu.push(q - i); }
      if (neu.length > 12) { for (q = i; q < j; q++) out[q] = true; return; }
      left = j < n ? s.charAt(j) : ''; right = i > 0 ? s.charAt(i - 1) : '';
      if (i > 1) {
        if (letter(i - 2)) ctx = [s.charAt(i - 2)];
        else { for (q = i - 2; q >= 0 && !letter(q); q--) if (ty[q] === 'L') lt = true; ctx = lt ? ['\u05d0', 'a'] : ['\u05d0']; }
      }
      for (m = 0; m < (1 << neu.length); m++) {
        L = [];
        for (q = 0; q < len; q++) L[q] = (ty[i + q] === 'L' || ty[i + q] === 'E' || ty[i + q] === 'N') ? 2 : 1;
        for (k = 0; k < neu.length; k++) L[neu[k]] = (m >> k) & 1 ? 2 : 1;
        vs = visOfSegs(levelSegs(L)); d = '';
        for (k = 0; k < len; k++) d += s.charAt(i + vs[k]);
        if (seen[d]) continue;
        seen[d] = 1;
        for (c = 0; c < ctx.length; c++) {
          lv = bidiLevels(left + d + right + ctx[c], 1).slice(left.length, left.length + len);
          lg = visOfSegs(levelSegs(lv));            // pdf.js's reading: drawn position of each logical character
          for (k = 0; k < len && d.charAt(lg[k]) === s.charAt(i + k); k++) { /* reads back */ }
          if (k < len) continue;
          valid++;
          cx = []; pp = p0;
          for (k = 0; k < len; k++) { cx[k] = ((x0 + W * pp / sum) + (x0 + W * (pp + wts[i + vs[k]]) / sum)) / 2; pp += wts[i + vs[k]]; }
          for (k = 0; k < len; k++) if (under(cx[lg[k]])) hit[i + k] = true;
        }
      }
      for (q = i; q < j; q++) out[q] = valid ? hit[q] : true;
    }
    for (i = 0; i < n;) {
      if (letter(i)) { i++; continue; }
      for (j = i; j < n && !letter(j); j++) { /* the gap [i, j) */ }
      if (j - i > 1) unionGap(i, j);                 // one character alone in a gap cannot move
      i = j;
    }
    return out;
  };
  // PURE.ltrStretchCover (review8 M1): pdf.js reorders a run it calls ltr too when the run
  // holds an R / AL / AN character (fewer than 30 % of a run of five or more): its right-to-left
  // stretches come back in logical order, so str's order is not the drawn order there. A strong
  // L letter is level 0 and never moves, so a stretch without one fills the same slice of the
  // line in str's order and in the drawing; a box that meets such a stretch (one holding an
  // R / AL / AN character) drops all of it. Returns the covered flags, or null when no such
  // stretch is touched (the plain left-to-right test then stands, byte for byte).
  PURE.ltrStretchCover = function (s, xs0, xs1, row) {
    var n = s.length, ty = [], i, j, q, has, c = null, cx;
    for (i = 0; i < n; i++) ty[i] = bidiType(s.charCodeAt(i));
    for (i = 0; i < n;) {
      if (ty[i] === 'L') { i++; continue; }
      for (j = i, has = false; j < n && ty[j] !== 'L'; j++) if (ty[j] === 'R' || ty[j] === 'A' || ty[j] === 'N') has = true;
      if (has && row.some(function (r) { return r.x <= xs1[j - 1] && r.x + r.w >= xs0[i]; })) {
        if (!c) { c = []; for (q = 0; q < n; q++) { cx = (xs0[q] + xs1[q]) / 2; c[q] = row.some(function (r) { return cx >= r.x && cx <= r.x + r.w; }); } }
        for (q = i; q < j; q++) c[q] = true;
      }
      i = j;
    }
    return c;
  };
  // the second half of a surrogate pair (an emoji or another character past U+FFFF): the pair
  // is ONE character, so it takes one share of the run and a cut never splits it (review8 n1)
  function lowHalf(s, i) {
    var c = s.charCodeAt(i), p = i > 0 ? s.charCodeAt(i - 1) : 0;
    return c >= 0xDC00 && c <= 0xDFFF && p >= 0xD800 && p <= 0xDBFF;
  }
  // a non-spacing mark (Unicode Mn: Hebrew points, Arabic harakat, combining accents): pdf.js's
  // text geometry gives every one ZERO advance, so it takes no share of the run either, and it
  // goes with its base letter (verify8 M2). The class is built at run time so a browser without
  // Unicode property escapes falls back to the Mn ranges of the scripts the cut reorders.
  var MN_RE = (function () {
    try { return new RegExp('^\\p{Mn}$', 'u'); }
    catch (er) { return /^[\u0300-\u036f\u0483-\u0487\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06dc\u06df-\u06e4\u06e7\u06e8\u06ea-\u06ed]$/; }
  })();
  function isMark(s, i) { return s.charCodeAt(i) >= 0x0300 && MN_RE.test(s.charAt(i)); }
  // Known limit (no fix from str): in a run that holds an R / AL / AN character pdf.js blanks
  // every < and > from str while their glyphs keep their width in the run, so positions past
  // a bracket drift and a one-glyph box there can keep its character (review8 m1).
  PURE.cutCovered = function (tokens, rects, table) {
    if (!tokens || !rects || !rects.length) return tokens;
    var out = [];
    tokens.forEach(function (t) {
      var hits = rects.filter(function (r) { return t.x0 < r.x + r.w && t.x1 > r.x && t.y0 < r.y + r.h && t.y1 > r.y; });
      if (!hits.length) { out.push(t); return; }
      var s = String(t.text || '');
      if (!s.length) return;
      if (t.fontSize > 0 && (t.y1 - t.y0) > t.fontSize * 2.5) return;   // vertical text: whole-token rule
      var cy = (t.y0 + t.y1) / 2;
      var row = hits.filter(function (r) { return cy >= r.y && cy <= r.y + r.h; });
      if (!row.length) { out.push(t); return; }                         // the box only grazes the line
      // a box over the run's whole extent: every reading puts every character under it, so the
      // run goes at once, with no enumeration (verify8 N1: a page-sized white-out)
      if (row.some(function (r) { return r.x <= Math.min(t.x0, t.x1) && r.x + r.w >= Math.max(t.x0, t.x1); })) return;
      var wts = [], sum = 0, i;
      for (i = 0; i < s.length; i++) {
        var a = t.mono ? 1 : table ? PURE.charAdvance(table, 'Helvetica', s.charCodeAt(i)) : 1;
        if (a == null || !(a > 0)) a = table ? 0.5 : 1;
        if (lowHalf(s, i) || isMark(s, i)) a = 0;                      // a pair: one share; a mark: none
        wts.push(a); sum += a;
      }
      // the order the characters are DRAWN in, left to right: logical for an ltr token; for
      // an rtl token its segments from last to first, a left-to-right block in its own order
      var vis = null, segs, g, q;
      if (t.dir === 'rtl') {
        segs = PURE.rtlSegments(s); vis = [];
        for (g = segs.length - 1; g >= 0; g--) for (q = segs[g][0]; q < segs[g][1]; q++) vis.push(q);
      }
      var W = t.x1 - t.x0, pos = 0, piece = null, xs0 = [], xs1 = [], pcs = [];
      for (i = 0; i < s.length; i++) {
        q = vis ? vis[i] : i;
        xs0[q] = t.x0 + W * pos / sum; xs1[q] = t.x0 + W * (pos + wts[q]) / sum;
        pos += wts[q];
      }
      // an rtl run: the union of every drawing pdf.js reads back as its str (never a leak)
      var cov = vis ? PURE.rtlUnionCover(s, segs, wts, sum, t.x0, W, row) : null;
      if (t.dir === 'ltr') cov = PURE.ltrStretchCover(s, xs0, xs1, row);   // pdf.js runs only (an OCR word has no dir)
      var drop = [], cx;
      for (i = 0; i < s.length; i++) {
        cx = (xs0[i] + xs1[i]) / 2;
        drop[i] = cov ? !!cov[i] : row.some(function (r) { return cx >= r.x && cx <= r.x + r.w; });
      }
      for (i = 1; i < s.length; i++) if (lowHalf(s, i) && (drop[i] || drop[i - 1])) drop[i] = drop[i - 1] = true;
      for (i = 1, q = 0; i < s.length; i++) { if (!isMark(s, i)) q = i; else if (drop[q]) drop[i] = true; }   // a mark goes with its base
      function flush() { if (piece && piece.text.trim()) pcs.push(piece); piece = null; }
      for (i = 0; i < s.length; i++) {
        var cx0 = xs0[i], cx1 = xs1[i];
        if (drop[i]) { flush(); continue; }
        if (!piece) piece = Object.assign({}, t, { text: '', x0: cx0, x1: cx1 });
        piece.text += s[i]; piece.x0 = Math.min(piece.x0, cx0); piece.x1 = Math.max(piece.x1, cx1);
      }
      flush();
      if (vis && pcs.length > 1) {
        // one rtl run stays ONE token: its kept stretches in logical order, its box their union
        out.push(Object.assign({}, t, {
          text: pcs.map(function (p) { return p.text.trim(); }).join(' '),
          x0: Math.min.apply(null, pcs.map(function (p) { return p.x0; })),
          x1: Math.max.apply(null, pcs.map(function (p) { return p.x1; }))
        }));
      } else pcs.forEach(function (p) { out.push(p); });
    });
    return out;
  };

  // bounded LIFO used for undo
  PURE.makeUndoStack = function (limit) {
    var stack = [];
    return {
      push: function (e) { stack.push(e); if (stack.length > limit) stack.shift(); },
      pop: function () { return stack.length ? stack.pop() : null; },
      peek: function () { return stack.length ? stack[stack.length - 1] : null; },
      size: function () { return stack.length; },
      entries: function () { return stack.slice(); },
      clear: function () { stack.length = 0; }
    };
  };

  // strip characters the pdf-lib standard fonts (WinAnsi) can't encode. sanitizeRun is
  // the NON-trimming form, used per text RUN: applied to a run, the trim would eat the
  // run's leading and trailing spaces and shift every later run on that line left.
  // sanitizeWinAnsi keeps the trim, which its watermark and OCR callers rely on.
  PURE.sanitizeRun = function (s) {
    if (!s) return '';
    return String(s).replace(/[^\x20-\x7E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026]/g, '');
  };
  PURE.sanitizeWinAnsi = function (s) {
    if (!s) return '';
    return PURE.sanitizeRun(s).trim();
  };

  // watermark text placement + draw (P = the PDFLib namespace). Rotation-0 math: pages
  // are flattened upright before a watermark is applied. The standard fonts are WinAnsi,
  // so a raw draw is tried first (WinAnsi covers more than the sanitize whitelist), and
  // on failure the encodable remainder is drawn instead of silently dropping the whole
  // watermark. Returns true when characters had to be dropped.
  PURE.drawWatermark = function (P, page, font, wm, W, H, ox, oy) {
    var text = String(wm.text || '');
    if (!text) return false;
    ox = ox || 0; oy = oy || 0;   // the visible box's origin (CropBox pages); 0, 0 otherwise
    var size = wm.size || 48;
    var op = wm.opacity == null ? 0.15 : wm.opacity;
    var col = P.rgb(0.5, 0.5, 0.5);
    function draw(t) {
      var tw = font.widthOfTextAtSize(t, size);
      if (wm.pos === 'foot') {
        page.drawText(t, { x: ox + (W / 2 - tw / 2), y: oy + 34, size: size, font: font, color: col, opacity: op });
        return;
      }
      // diagonal: centered on the page, rotated along the page diagonal
      var rad = Math.atan2(H, W);
      var deg = rad * 180 / Math.PI;
      var x = W / 2 - (tw / 2) * Math.cos(rad) + 0.35 * size * Math.sin(rad);
      var y = H / 2 - (tw / 2) * Math.sin(rad) - 0.35 * size * Math.cos(rad);
      page.drawText(t, { x: ox + x, y: oy + y, size: size, font: font, color: col, opacity: op, rotate: P.degrees(deg) });
    }
    try { draw(text); return false; }
    catch (e) {
      var clean = PURE.sanitizeWinAnsi(text);
      if (clean) { try { draw(clean); } catch (e2) {} }
      return true;
    }
  };

  // page-number label for output page i (0-based) of `total`, or null to skip
  PURE.pageNumText = function (cfg, i, total) {
    if (cfg.skipFirst && i === 0) return null;
    var start = cfg.start || 1;
    var n = start + i - (cfg.skipFirst ? 1 : 0);
    var m = start + total - (cfg.skipFirst ? 1 : 0) - 1;
    return cfg.fmt === 'nofm' ? (n + ' of ' + m) : String(n);
  };

  PURE.drawPageNum = function (P, page, font, cfg, i, total, W, H, ox, oy) {
    var text = PURE.pageNumText(cfg, i, total);
    if (text == null) return;
    var size = cfg.size || 10;
    var tw = font.widthOfTextAtSize(text, size);
    var x = cfg.pos === 'br' ? (W - 36 - tw) : (W / 2 - tw / 2);
    page.drawText(text, { x: (ox || 0) + x, y: (oy || 0) + 22, size: size, font: font, color: P.rgb(0.24, 0.24, 0.24) });
  };

  // invisible OCR text layer: words carry normalized bboxes {text, x0, y0, x1, y1}
  // (fractions of page width/height, y down from the top). Font size is chosen so the
  // drawn word width matches the recognized box, which makes selection/search line up.
  // Each word is drawn WITH a trailing space (its size still from the word alone): an
  // extractor that infers spaces from gaps (Apple PDFKit: Preview, Safari, iOS) read
  // tight OCR gaps as no gap at all ("foxjumps", "ofNovember").
  // The words sit inside one marked-content sequence tagged PURE.OCR_TAG, so Copy clean
  // text on a reopened searchable PDF can tell this layer's words apart (each is a whole
  // word) from a native text layer, where pdf.js's tiny whitespace items are no spaces.
  PURE.OCR_TAG = 'OCRText';
  PURE.drawOcrWords = function (P, page, font, words, W, H, ox, oy) {
    var drawn = 0, opened = false;
    ox = ox || 0; oy = oy || 0;   // the visible box's origin (CropBox pages); 0, 0 otherwise
    (words || []).forEach(function (w) {
      var text = PURE.sanitizeWinAnsi(w.text);
      if (!text) return;
      var bw = (w.x1 - w.x0) * W, bh = (w.y1 - w.y0) * H;
      if (!(bw > 0) || !(bh > 0)) return;
      var w1;
      try { w1 = font.widthOfTextAtSize(text, 1); } catch (e) { return; }
      if (!(w1 > 0)) return;
      var size = Math.max(1, Math.min(bw / w1, bh * 1.6, 200));
      try {
        if (!opened && P.beginMarkedContent) { page.pushOperators(P.beginMarkedContent(PURE.OCR_TAG)); opened = true; }
        page.drawText(text + ' ', { x: ox + w.x0 * W, y: oy + (H - w.y1 * H + bh * 0.18), size: size, font: font, opacity: 0 });
        drawn++;
      } catch (e2) { /* one unencodable word must not break the page */ }
    });
    if (opened) page.pushOperators(P.endMarkedContent());
    return drawn;
  };

  /* ==================================================================================
     Rich text boxes: metrics, the layout law, the hit test, and the ONE shared canvas
     painter. Spec: .claude/plans/plan-pdftools-richtext.md sections 12.1, 12.2, 12.4.

     A text box entry is {x, y, text, size, font, color} plus, optionally:
       w      fraction of the effective page WIDTH, or null/absent = auto width
       lh     line-height multiplier (default 1.2, which is the pre-existing law)
       align  'left' | 'center' | 'right' (default 'left')
       runs   null/absent = legacy plain text, else [{t,b,i,u,s,hl,c}] whose t values
              joined always equal text
     An entry carrying none of the four lays out, paints and exports exactly as it did
     before this build, down to the arithmetic (see baselineAt).
     ================================================================================== */

  // the three families the text tool offers
  PURE.textFamily = function (f) { return (f === 'Times' || f === 'Courier') ? f : 'Helvetica'; };

  // Face key. The plain face keeps the BARE family name, which is exactly the key the
  // export's font cache used before this build, so a legacy box still embeds one font
  // and shares it with the watermark/page-number/OCR Helvetica.
  PURE.faceKey = function (family, b, i) {
    var fam = PURE.textFamily(family);
    return (b || i) ? (fam + '|' + (b ? 'b' : '') + (i ? 'i' : '')) : fam;
  };

  // every code point the standard fonts' WinAnsi encoding covers: ASCII, Latin-1, and
  // the CP1252 0x80-0x9F block (euro, dagger, curly quotes, OE, ...). Anything outside
  // this set is what drawText throws on, so it is what the table records as null.
  PURE.winAnsiCodePoints = function () {
    var out = [], i;
    for (i = 0x20; i <= 0x7E; i++) out.push(i);
    for (i = 0xA0; i <= 0xFF; i++) out.push(i);
    var extra = [0x20AC, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030,
                 0x0160, 0x2039, 0x0152, 0x017D, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022,
                 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x017E, 0x0178];
    for (i = 0; i < extra.length; i++) out.push(extra[i]);
    return out;
  };

  // Build the PER-CHARACTER advance table for the twelve standard faces, once.
  // NEVER a whole-string width: pdf-lib's widthOfTextAtSize adds AFM kern pairs while
  // its emitter writes one UNKERNED Tj per line, so only the per-character sum matches
  // the ink the page actually draws (measured gap up to 7.1 pt on a 49 character
  // Helvetica line at 12 pt). The browser stacks run with kerning off, so the same sum
  // is also what the canvas painters and the editor draw.
  // Resolves to { faces: { faceKey: { adv: {code: advance/1000 or null}, ascent, descent } }, ok }
  // and NEVER rejects: a failed build degrades to an empty table (zero widths), which
  // still draws every line at its own baseline.
  PURE.buildMetrics = function (P) {
    if (!P || !P.PDFDocument || !P.StandardFonts) return Promise.resolve({ faces: {}, ok: false });
    var SF = P.StandardFonts;
    var faces = [
      ['Helvetica', 0, 0, SF.Helvetica], ['Helvetica', 1, 0, SF.HelveticaBold],
      ['Helvetica', 0, 1, SF.HelveticaOblique], ['Helvetica', 1, 1, SF.HelveticaBoldOblique],
      ['Times', 0, 0, SF.TimesRoman], ['Times', 1, 0, SF.TimesRomanBold],
      ['Times', 0, 1, SF.TimesRomanItalic], ['Times', 1, 1, SF.TimesRomanBoldItalic],
      ['Courier', 0, 0, SF.Courier], ['Courier', 1, 0, SF.CourierBold],
      ['Courier', 0, 1, SF.CourierOblique], ['Courier', 1, 1, SF.CourierBoldOblique]
    ];
    var codes = PURE.winAnsiCodePoints();
    return P.PDFDocument.create().then(function (doc) {
      var out = { faces: {}, ok: true };
      faces.forEach(function (f) {
        var key = PURE.faceKey(f[0], f[1], f[2]);
        var rec = { adv: {}, ascent: 0.718, descent: 0.207 };
        var font = null;
        try { font = doc.embedStandardFont(f[3]); } catch (e) { out.ok = false; }
        if (!font) { out.faces[key] = rec; return; }
        codes.forEach(function (c) {
          var w = null;
          try { w = font.widthOfTextAtSize(String.fromCharCode(c), 1000) / 1000; } catch (e2) { w = null; }
          rec.adv[c] = (w != null && isFinite(w)) ? w : null;
        });
        try {
          var asc = font.heightAtSize(1000, { descender: false }) / 1000;
          var full = font.heightAtSize(1000) / 1000;
          if (isFinite(asc) && asc > 0) rec.ascent = asc;
          if (isFinite(full) && full > asc) rec.descent = full - asc;
        } catch (e3) {}
        out.faces[key] = rec;
      });
      return out;
    }).catch(function () { return { faces: {}, ok: false }; });
  };

  // advance of one character, in ems, or null when the standard fonts cannot encode it
  PURE.charAdvance = function (table, fontKey, code) {
    var f = table && table.faces && table.faces[fontKey];
    if (!f) return null;
    var a = f.adv[code];
    return (a == null || !isFinite(a)) ? null : a;
  };
  // width of a string in points for one face. Characters the table cannot encode
  // contribute nothing, which is exactly what the drawn string does: they are dropped
  // before drawing (the layout filters per character, see below).
  PURE.faceWidth = function (table, fontKey, str, size) {
    if (!str) return 0;
    var w = 0;
    for (var i = 0; i < str.length; i++) {
      var a = PURE.charAdvance(table, fontKey, str.charCodeAt(i));
      if (a != null) w += a;
    }
    return w * (size || 0);
  };
  // advance of one CHARACTER, in ems, including the tab rule: pdf-lib's own cleanText
  // expands a tab to four spaces before drawing, so the layout measures and draws it
  // the same way instead of dropping it as unencodable
  PURE.cellAdvance = function (table, fontKey, ch) {
    if (ch === '\t') {
      var sp = PURE.charAdvance(table, fontKey, 32);
      return sp == null ? null : sp * 4;
    }
    if (ch === '\n') return null;
    return PURE.charAdvance(table, fontKey, ch.charCodeAt(0));
  };
  // the string one character contributes to the DRAWN text ('' when nothing can be drawn)
  PURE.cellDraw = function (table, fontKey, ch) {
    if (ch === '\n') return '';
    if (ch === '\t') return PURE.charAdvance(table, fontKey, 32) == null ? '' : '    ';
    return PURE.charAdvance(table, fontKey, ch.charCodeAt(0)) == null ? '' : ch;
  };

  PURE.faceAscent = function (table, fontKey) {
    var f = table && table.faces && table.faces[fontKey];
    return f ? f.ascent : 0.718;
  };
  PURE.faceDescent = function (table, fontKey) {
    var f = table && table.faces && table.faces[fontKey];
    return f ? f.descent : 0.207;
  };

  // every content entry point (typing, paste, drop, the parser) runs through this:
  // CRLF and a bare CR become LF, and each tab becomes four spaces, matching pdf-lib's
  // own cleanText. The metrics table cannot measure 0x09, so a tab must never survive
  // into the model.
  PURE.normalizeContent = function (s) {
    return String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  };

  // normalize a colour to #rrggbb; an unparsable value falls back, so the export can
  // never reach PDFLib.rgb(NaN) and no colour bug is ever reported as dropped characters
  PURE.normColor = function (v, fallback) {
    var m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(String(v == null ? '' : v).trim());
    if (!m) return fallback === undefined ? null : fallback;
    var h = m[1].toLowerCase();
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return '#' + h;
  };

  // the baseline of visual line i, in points below the box's top edge. Written as
  // size*0.82 + (i*size)*lh so that at lh 1.2 it is bit-for-bit the arithmetic the
  // three painters used before this build (a one-ULP drift would change the exported
  // number's decimal string, and with it the legacy byte identity).
  PURE.LINE_BASE = 0.82;
  PURE.baselineAt = function (i, size, lh) { return size * PURE.LINE_BASE + i * size * lh; };

  // ---- the ONE content writer -------------------------------------------------------
  // Runs are IMMUTABLE: merging always builds fresh objects, so PURE.clonePage can copy
  // the array with slice() and share the run objects across undo entries.
  PURE.runStyleKey = function (r) {
    return (r.b ? 'b' : '') + (r.i ? 'i' : '') + (r.u ? 'u' : '') + (r.s ? 's' : '') +
      '|' + (r.c || '') + '|' + (r.hl || '');
  };
  PURE.mergeRuns = function (runs) {
    var out = [];
    (runs || []).forEach(function (r) {
      var text = PURE.normalizeContent((r && r.t != null) ? r.t : '');
      if (!text) return;
      var norm = {
        t: text, b: !!(r && r.b), i: !!(r && r.i), u: !!(r && r.u), s: !!(r && r.s),
        hl: (r && r.hl) ? PURE.normColor(r.hl, null) : null,
        c: (r && r.c) ? PURE.normColor(r.c, null) : null
      };
      var last = out.length ? out[out.length - 1] : null;
      if (last && PURE.runStyleKey(last) === PURE.runStyleKey(norm)) {
        out[out.length - 1] = {
          t: last.t + norm.t, b: last.b, i: last.i, u: last.u, s: last.s, hl: last.hl, c: last.c
        };
      } else out.push(norm);
    });
    return out;
  };
  // setBoxContent(t, runs): merge adjacent identical runs, write t.runs, THEN set
  // t.text to the runs joined, in that order. Nothing else in the app assigns t.text,
  // which is what keeps "runs joined === text" true and with it the export's ghost
  // check, close()'s empty filter and Copy clean text. Passing null returns the box to
  // its legacy form and leaves t.text alone.
  // true when nothing in the run list carries style, so the box can go back to the
  // legacy plain form and keep the legacy export path (no rectangles, one font face)
  PURE.runsArePlain = function (runs) {
    return (runs || []).every(function (r) {
      return !r.b && !r.i && !r.u && !r.s && !r.hl && !r.c;
    });
  };
  PURE.setBoxContent = function (t, runs) {
    if (!t) return t;
    if (runs == null) { t.runs = null; return t; }
    var merged = PURE.mergeRuns(runs);
    t.runs = PURE.runsArePlain(merged) ? null : merged;
    t.text = merged.map(function (r) { return r.t; }).join('');
    return t;
  };

  // the model defaults for a NEW text box: w null = auto width (today's behaviour),
  // lh 1.2 = today's line advance, align left, runs null = plain legacy text. A box
  // created with these lays out, paints and exports exactly like one created before
  // this build; it becomes a v2 box only when a style is actually applied to it.
  PURE.newTextBox = function (o) {
    o = o || {};
    return {
      x: o.x || 0, y: o.y || 0, text: o.text == null ? '' : String(o.text),
      size: o.size || 14, font: PURE.textFamily(o.font),
      color: PURE.normColor(o.color, '#111111'),
      w: (o.w == null ? null : o.w), lh: (o.lh == null ? 1.2 : o.lh),
      align: o.align || 'left', runs: o.runs || null
    };
  };

  // copy one text entry. The four v2 fields are copied only when the entry actually
  // carries them, so a legacy six-key box still round-trips as six keys with no
  // undefined values, and a v2 box keeps every field it had.
  PURE.copyTextEntry = function (t) {
    var o = { x: t.x, y: t.y, text: t.text, size: t.size, font: t.font, color: t.color };
    var has = Object.prototype.hasOwnProperty;
    if (has.call(t, 'w')) o.w = t.w;
    if (has.call(t, 'lh')) o.lh = t.lh;
    if (has.call(t, 'align')) o.align = t.align;
    if (has.call(t, 'runs')) o.runs = t.runs ? t.runs.slice() : null;
    return o;
  };

  // ---- the layout law ---------------------------------------------------------------
  // PURE.layoutTextBox(t, Wpt, Hpt, table) is PURE and SYNCHRONOUS and never reaches
  // for pdf-lib. Everything it returns is in POINTS relative to the box origin
  // (t.x*Wpt, t.y*Hpt). See INTERFACES.md pin C1 for the exact output shape.
  function ltbTokenize(cells) {
    var toks = [], cur = null;
    for (var i = 0; i < cells.length; i++) {
      var sp = (cells[i].ch === ' ');
      if (!cur || cur.sp !== sp) { cur = { sp: sp, cells: [], w: 0 }; toks.push(cur); }
      cur.cells.push(cells[i]); cur.w += cells[i].adv;
    }
    return toks;
  }
  // greedy word wrap at maxW. A word wider than the whole measure is broken by
  // character; the spaces a line wrapped ON stay at the END of that line, where they
  // count for nothing (no width, no decoration), so the next line never begins with them.
  function ltbWrap(cells, maxW) {
    if (maxW == null || !(maxW > 0)) return [{ cells: cells, width: null, trail: 0 }];
    var toks = ltbTokenize(cells), lines = [];
    var cur = [], curW = 0, inkW = 0, trail = 0;
    function flat() {
      var out = [];
      for (var i = 0; i < cur.length; i++) out = out.concat(cur[i].cells);
      return out;
    }
    function flushSoft() {
      lines.push({ cells: flat(), width: inkW, trail: trail });
      cur = []; curW = 0; inkW = 0; trail = 0;
    }
    for (var k = 0; k < toks.length; k++) {
      var tk = toks[k];
      if (tk.sp) { cur.push(tk); curW += tk.w; trail += tk.cells.length; continue; }
      if (inkW > 0 && curW + tk.w > maxW) flushSoft();
      if (curW + tk.w > maxW && tk.w > maxW) {
        var idx = 0, cs = tk.cells;
        while (idx < cs.length) {
          var avail = maxW - curW, take = 0, ww = 0;
          while (idx + take < cs.length) {
            var a = cs[idx + take].adv;
            if (ww + a > avail && (take > 0 || curW > 0)) break;
            ww += a; take++;
          }
          if (take === 0) {
            if (curW > 0) { flushSoft(); continue; }
            take = 1; ww = cs[idx].adv;
          }
          cur.push({ sp: false, cells: cs.slice(idx, idx + take), w: ww });
          curW += ww; inkW = curW; trail = 0;
          idx += take;
          if (idx < cs.length) flushSoft();
        }
        continue;
      }
      cur.push(tk); curW += tk.w; inkW = curW; trail = 0;
    }
    // the last visual line of a hard paragraph keeps its trailing spaces in its width
    lines.push({ cells: flat(), width: curW, trail: 0 });
    return lines;
  }
  PURE.layoutTextBox = function (t, Wpt, Hpt, table) {
    t = t || {};
    var size = (typeof t.size === 'number' && isFinite(t.size) && t.size > 0) ? t.size : 14;
    var lh = (typeof t.lh === 'number' && isFinite(t.lh) && t.lh > 0) ? t.lh : 1.2;
    var align = (t.align === 'center' || t.align === 'right') ? t.align : 'left';
    var family = PURE.textFamily(t.font);
    var boxColor = PURE.normColor(t.color, '#111111');
    var wFrac = (typeof t.w === 'number' && isFinite(t.w) && t.w > 0) ? t.w : null;
    var maxW = (wFrac != null && Wpt > 0) ? wFrac * Wpt : null;
    var srcRuns = (t.runs && t.runs.length) ? t.runs : null;

    // style table, one entry per source run (or one for a legacy box)
    var styles = [];
    function pushStyle(r) {
      var b = !!(r && r.b), it = !!(r && r.i);
      var key = PURE.faceKey(family, b, it);
      styles.push({
        b: b, i: it, u: !!(r && r.u), s: !!(r && r.s),
        hl: (r && r.hl) ? PURE.normColor(r.hl, null) : null,
        c: (r && r.c) ? PURE.normColor(r.c, boxColor) : boxColor,
        fontKey: key, ascent: PURE.faceAscent(table, key), descent: PURE.faceDescent(table, key)
      });
      return styles.length - 1;
    }

    // character stream: one cell per code unit, carrying its style, its offset into
    // t.text, its advance, and whether the standard fonts can encode it
    var cells = [], off = 0;
    var list = srcRuns ? srcRuns : [{ t: (t.text == null ? '' : String(t.text)) }];
    list.forEach(function (r) {
      var si = pushStyle(r);
      var st = styles[si];
      var s = String((r && r.t != null) ? r.t : '');
      for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i);
        var a = PURE.cellAdvance(table, st.fontKey, ch);
        // ch is the character (so offsets stay 1:1 with t.text), draw is what actually
        // reaches the page (a tab draws as four spaces, an unencodable character as '')
        cells.push({
          ch: ch, draw: PURE.cellDraw(table, st.fontKey, ch), st: si, off: off,
          adv: (a == null ? 0 : a * size), enc: a != null
        });
        off++;
      }
    });

    // hard breaks first: a run may span a newline, and the newline is in no fragment
    var hard = [[]], hardOff = [0];
    cells.forEach(function (c) {
      if (c.ch === '\n') { hard.push([]); hardOff.push(c.off + 1); return; }
      hard[hard.length - 1].push(c);
    });

    // wrap, then cut each visual line into fragments at style boundaries
    var raw = [], li = 0, prevEnd = 0;
    hard.forEach(function (hl, hi) {
      ltbWrap(hl, maxW).forEach(function (vl) {
        var lc = vl.cells;
        var lineOff = lc.length ? lc[0].off : (li === 0 ? hardOff[hi] : Math.max(prevEnd, hardOff[hi]));
        var lineEnd = lc.length ? (lc[lc.length - 1].off + 1) : lineOff;
        var trailFrom = lc.length - (vl.trail || 0);
        var frags = [], x = 0, cur = null, lineText = '';
        for (var i = 0; i < lc.length; i++) {
          var c = lc[i];
          lineText += c.ch;
          if (!cur || cur.st !== c.st) {
            if (cur) { frags.push(cur); x += cur.w; }
            cur = { st: c.st, x: x, w: 0, raw: '', text: '', off: c.off, len: 0, drop: false };
          }
          cur.raw += c.ch; cur.len++;
          if (c.enc) { cur.text += c.draw; if (i < trailFrom) cur.w += c.adv; }
          else cur.drop = true;
        }
        if (cur) { frags.push(cur); x += cur.w; }
        raw.push({
          i: li, hard: hi, off: lineOff, end: lineEnd, text: lineText,
          width: (vl.width == null) ? x : vl.width, frags: frags
        });
        prevEnd = lineEnd;
        li++;
      });
    });

    var boxW = maxW;
    if (boxW == null) { boxW = 0; raw.forEach(function (l) { if (l.width > boxW) boxW = l.width; }); }

    // second pass: alignment offset, absolute fragment x, merged highlights, decorations
    var outLines = raw.map(function (l) {
      var offX = align === 'center' ? (boxW - l.width) / 2 : align === 'right' ? (boxW - l.width) : 0;
      var baseline = PURE.baselineAt(l.i, size, lh);
      var runsOut = [], hls = [], decs = [], hlCur = null;
      l.frags.forEach(function (f) {
        var st = styles[f.st];
        var fr = {
          x: offX + f.x, w: f.w, text: f.text, raw: f.raw, off: f.off, len: f.len, drop: f.drop,
          b: st.b, i: st.i, u: st.u, s: st.s, hl: st.hl, c: st.c,
          fontKey: st.fontKey, ascent: st.ascent, descent: st.descent
        };
        runsOut.push(fr);
        // a fragment with no drawn width (an empty run, a fully dropped run, or the
        // spaces a line wrapped on) paints no decoration
        if (!(fr.w > 0)) { hlCur = null; return; }
        if (st.hl) {
          var top = baseline - st.ascent * size, bot = baseline + st.descent * size;
          if (hlCur && hlCur.c === st.hl && Math.abs(hlCur.x + hlCur.w - fr.x) < 1e-9) {
            hlCur.w += fr.w;
            if (top < hlCur.y) { hlCur.h += hlCur.y - top; hlCur.y = top; }
            if (bot > hlCur.y + hlCur.h) hlCur.h = bot - hlCur.y;
          } else {
            hlCur = { x: fr.x, w: fr.w, y: top, h: bot - top, c: st.hl };
            hls.push(hlCur);
          }
        } else hlCur = null;
        if (st.u) decs.push({ kind: 'u', x: fr.x, w: fr.w, y: baseline + 0.12 * size, thickness: 0.06 * size, c: st.c });
        if (st.s) decs.push({ kind: 's', x: fr.x, w: fr.w, y: baseline - 0.30 * size, thickness: 0.06 * size, c: st.c });
      });
      return {
        i: l.i, hard: l.hard, off: l.off, end: l.end, text: l.text,
        top: l.i * size * lh, baseline: baseline, width: l.width, x: offX,
        runs: runsOut, hls: hls, decs: decs
      };
    });

    return {
      Wpt: Wpt, Hpt: Hpt, size: size, lh: lh, align: align, family: family,
      color: boxColor, w: wFrac, boxW: boxW, boxH: outLines.length * size * lh,
      lines: outLines
    };
  };

  // character offset for a point (px, py) in POINTS relative to the box origin. It
  // never reads the DOM: the resting render is a canvas with no text nodes and the
  // focused flow wraps in a browser font, so only the layout knows where a character is.
  PURE.hitTextBox = function (t, Wpt, Hpt, table, px, py) {
    var lay = PURE.layoutTextBox(t, Wpt, Hpt, table);
    var lines = lay.lines;
    if (!lines.length) return 0;
    var adv = lay.size * lay.lh;
    var li = adv > 0 ? Math.floor(py / adv) : 0;
    if (!(li >= 0)) li = 0;
    if (li > lines.length - 1) li = lines.length - 1;
    // a point above the first line is the start of the text, one below the last is its
    // end: clicking in the margin above or below a box puts the caret at the near end
    if (py < 0) return lines[0].off;
    if (py >= lines.length * adv) return lines[lines.length - 1].end;
    var ln = lines[li];
    if (!ln.runs.length) return ln.off;
    for (var i = 0; i < ln.runs.length; i++) {
      var f = ln.runs[i];
      if (px < f.x) return f.off;
      var cx = f.x;
      for (var j = 0; j < f.raw.length; j++) {
        var a = PURE.cellAdvance(table, f.fontKey, f.raw.charAt(j));
        var w = (a == null ? 0 : a * lay.size);
        if (px < cx + w / 2) return f.off + j;
        if (px < cx + w) return f.off + j + 1;
        cx += w;
      }
    }
    return ln.end;
  };

  // one entry per VISUAL line (wrap and line spacing included), in effective-page
  // FRACTIONS: x already carries the alignment offset, w is the drawn line's width and
  // h is the LINE ADVANCE (size*lh). Copy clean text builds its tokens from this, and
  // reports h as the token font size so PURE.groupLines keeps its clustering ratios.
  PURE.textLines = function (t, Wpt, Hpt, table) {
    var lay = PURE.layoutTextBox(t, Wpt, Hpt, table);
    var adv = lay.size * lay.lh;
    var tx = (t && t.x) || 0, ty = (t && t.y) || 0;
    return lay.lines.map(function (ln) {
      return {
        text: ln.text,
        x: tx + (Wpt ? ln.x / Wpt : 0),
        y: ty + (Hpt ? ln.top / Hpt : 0),
        w: Wpt ? Math.min(1, ln.width / Wpt) : 0,
        h: Hpt ? Math.min(1, adv / Hpt) : 0
      };
    });
  };

  // ONE canvas painter, shared by the grid thumbnails, drawDecor (Shrink and
  // Pages to images) and the editor's resting render. opts: {scale, tw, th, floor};
  // a bare number is read as the scale. `floor` is the pixel size floor: the thumbnails
  // keep their deliberate max(3, ...) readability floor, drawDecor keeps max(1, ...).
  // `t` is part of the pinned signature (INTERFACES PIN E1 / C4) and is deliberately not
  // read: the box anchor comes from opts.ox/opts.oy, so a caller can paint the same box
  // into a page canvas and into a per-box canvas without the painter guessing which.
  PURE.paintTextBox = function (ctx, t, layout, opts) {
    if (!ctx || !layout || !layout.lines) return;
    var o = (typeof opts === 'number') ? { scale: opts } : (opts || {});
    var scale = (typeof o.scale === 'number' && isFinite(o.scale) && o.scale > 0) ? o.scale : 1;
    // origin: (ox, oy) in canvas pixels. A bare scale means the canvas origin IS the
    // box's top-left corner (the editor's per-box resting canvas); the two page-wide
    // painters pass the box anchor explicitly rather than translating the context,
    // which keeps the arithmetic bit-for-bit what it was before this build.
    var floor = (o.floor != null) ? o.floor : 1;
    var size = layout.size, lh = layout.lh;
    var px = Math.max(floor, size * scale);
    var k = size > 0 ? px / size : scale;
    var ox = (o.ox != null) ? o.ox : 0, oy = (o.oy != null) ? o.oy : 0;
    var fam = layout.family;
    ctx.save();
    try {
      // highlights first, BEHIND the glyphs, multiplied so black text stays black
      ctx.globalCompositeOperation = 'multiply';
      layout.lines.forEach(function (ln) {
        ln.hls.forEach(function (r) {
          ctx.fillStyle = r.c;
          ctx.fillRect(ox + r.x * k, oy + r.y * k, r.w * k, r.h * k);
        });
      });
      ctx.globalCompositeOperation = 'source-over';
      // alphabetic baseline at px*0.82 + (i*px)*lh: at lh 1.2 this is bit-for-bit the
      // arithmetic the thumbnail and drawDecor painters used before this build
      ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
      layout.lines.forEach(function (ln) {
        var y = oy + px * PURE.LINE_BASE + ln.i * px * lh;
        ln.runs.forEach(function (f) {
          if (!f.text) return;
          ctx.fillStyle = f.c;
          ctx.font = (f.i ? 'italic ' : '') + (f.b ? 'bold ' : '') + px + 'px ' + fam;
          ctx.fillText(f.text, ox + f.x * k, y);
        });
      });
      layout.lines.forEach(function (ln) {
        ln.decs.forEach(function (d) {
          ctx.fillStyle = d.c;
          ctx.fillRect(ox + d.x * k, oy + (d.y - d.thickness / 2) * k, d.w * k, Math.max(0.5, d.thickness * k));
        });
      });
    } catch (e) { /* one bad box must never stop a thumbnail or an export canvas */ }
    ctx.restore();
  };

  /* ==================================================================================
     "Copy clean text" pipeline — extracts the document's text with running
     headers/footers/page numbers heuristically stripped, line-wrap hyphenation
     repaired, and paragraphs reflowed. Every stage is pure and unit-tested on plain
     objects; only the very first stage (pdf.js item -> normalized token) needs numbers
     that come from a real pdf.js page (viewport.transform, item.transform/width/height),
     and even that stage takes them as plain arrays/numbers so it can be tested here
     with synthetic ones. See assets/js/pdftools-tools.js for how the app wires pdf.js
     and pg.ocrWords into these.
     ================================================================================== */

  // 2D affine matrix composition, m1 * m2 (apply m2 first, then m1) — the exact
  // convention pdf.js's own Util.transform uses to combine a viewport transform with a
  // text item's transform, reimplemented here (it's four lines) so this stays pure/testable.
  PURE.combine2d = function (m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
    ];
  };

  // reconstruct a pdf.js text item's on-screen bounding box the same way pdf.js's own
  // text layer does it (see pdf.js's text_layer.js appendText): combine the viewport
  // transform with the item's transform, take the rotation angle and font height off
  // the result, and place a width x fontHeight box starting `fontHeight*0.8` (pdf.js's
  // own fallback ascent ratio, used when a font's real metrics aren't available) above
  // the baseline anchor, rotated by that same angle. Returns a normalized
  // {text, x0, y0, x1, y1, fontSize} box (fractions of a Wpx x Hpx viewport, y down from
  // the top — the same frame pg.redacts/pg.ocrWords already use), or null for a blank/
  // degenerate item so callers can just filter falsy results out.
  // `styles` (optional) is the text content's styles map: a run whose font pdf.js names
  // 'monospace' (or a Courier / Mono name) is marked mono; every item's own dir (ltr, rtl
  // or ttb) is kept; both for PURE.cutCovered.
  PURE.itemToToken = function (viewportTransform, item, Wpx, Hpx, styles) {
    if (!item || !item.str || !String(item.str).trim() || !(Wpx > 0) || !(Hpx > 0)) return null;
    var tx = PURE.combine2d(viewportTransform, item.transform);
    if (!tx.every(function (n) { return isFinite(n); })) return null;
    var angle = Math.atan2(tx[1], tx[0]);
    var fontHeight = Math.hypot(tx[2], tx[3]) || Math.abs(item.height) || 0;
    if (!(fontHeight > 0)) return null;
    var ascent = fontHeight * 0.8;
    var cosA = Math.cos(angle), sinA = Math.sin(angle);
    var left = tx[4] + ascent * sinA, top = tx[5] - ascent * cosA;
    var width = item.width || 0;
    var c0x = left, c0y = top;
    var c1x = left + width * cosA, c1y = top + width * sinA;
    var c2x = left - fontHeight * sinA, c2y = top + fontHeight * cosA;
    var c3x = c1x + (c2x - c0x), c3y = c1y + (c2y - c0y);
    var xs = [c0x, c1x, c2x, c3x], ys = [c0y, c1y, c2y, c3y];
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    var tok = {
      text: String(item.str),
      x0: x0 / Wpx, y0: y0 / Hpx, x1: x1 / Wpx, y1: y1 / Hpx,
      fontSize: fontHeight / Hpx,
      // the same font height normalized by the page WIDTH: x and y are normalized against
      // different page dimensions, so a horizontal gap can only be compared against a
      // horizontally-normalized font size (see PURE.groupLines)
      fontSizeX: fontHeight / Wpx
    };
    if (item.dir) tok.dir = String(item.dir);
    var st = (styles && item.fontName) ? styles[item.fontName] : null;
    if (/courier|mono/i.test(String((st && st.fontFamily) || '') + ' ' + String(item.fontName || ''))) tok.mono = true;
    return tok;
  };

  // group normalized tokens ({text,x0,y0,x1,y1,fontSize}, y down) into reading-order
  // LINES: cluster by vertical center (tolerance scaled to the taller token's own FONT
  // SIZE, so small and large text both cluster sensibly), sort each line's tokens
  // left-to-right, and join them inferring a space wherever the x-gap between adjacent
  // tokens is bigger than a small fraction of the local font size — pdf.js's own runs
  // already include internal spaces, but per-word OCR tokens don't, so this is what
  // puts the spaces back between them.
  // Two normalization traps this has to dodge: (1) the clustering tolerance comes from
  // the font size, NOT the box height — a pdf.js box is axis-aligned, so a 90° rotated
  // stamp's "height" is really the text's WIDTH, and a tolerance taken from that would
  // swallow a dozen body lines; a box far taller than its own font size is rotated text
  // and gets a line of its own. (2) the space threshold uses `fontSizeX` (font size over
  // page WIDTH) where the producer supplies it, because the x-gap it is compared against
  // is width-normalized too — mixing the two makes the threshold aspect-dependent
  // (too eager on portrait pages, too lax on landscape ones).
  PURE.groupLines = function (tokens) {
    var toks = (tokens || []).filter(function (t) {
      return t && t.text && String(t.text).trim() && isFinite(t.x0) && isFinite(t.y0) && isFinite(t.x1) && isFinite(t.y1);
    });
    if (!toks.length) return [];
    toks = toks.slice().sort(function (a, b) { return (a.y0 + a.y1) - (b.y0 + b.y1); });
    var lines = [];
    toks.forEach(function (t) {
      var cy = (t.y0 + t.y1) / 2, h = Math.max(1e-6, t.y1 - t.y0);
      var fs = Math.max(1e-6, t.fontSize || h);
      var solo = h > fs * 2.5;   // rotated text: its box height is the text's own length
      var line = null;
      if (!solo) for (var i = lines.length - 1; i >= 0; i--) {
        var L = lines[i];
        if (L.solo) continue;
        var tol = Math.max(L.fs, fs) * 0.55;
        if (Math.abs(cy - L.cy) <= tol) { line = L; break; }
        if (L.cy < cy - tol * 3) break;   // clearly above any plausible match — stop scanning
      }
      if (!line) { line = { cy: cy, h: h, fs: fs, solo: solo, y0: t.y0, y1: t.y1, toks: [] }; lines.push(line); }
      line.toks.push(t);
      line.cy = (line.cy * (line.toks.length - 1) + cy) / line.toks.length;   // running average
      line.h = Math.max(line.h, h);
      line.fs = Math.max(line.fs, fs);
      line.y0 = Math.min(line.y0, t.y0); line.y1 = Math.max(line.y1, t.y1);
    });
    lines.sort(function (a, b) { return a.cy - b.cy; });
    function gapUnit(t) { return isFinite(t.fontSizeX) ? t.fontSizeX : (t.fontSize || 0); }
    return lines.map(function (L) {
      L.toks.sort(function (a, b) { return a.x0 - b.x0; });
      var text = '', prev = null;
      L.toks.forEach(function (t) {
        var s = String(t.text);
        if (prev) {
          var gap = t.x0 - prev.x1;
          var thresh = Math.max(gapUnit(prev), gapUnit(t)) * 0.18;
          // two OCR words (token.word) are separate words whatever the gap: their boxes are
          // tight to the ink, so a normal word space can measure under the threshold
          if (gap > thresh || (prev.word && t.word)) text += ' ';
        }
        text += s;
        prev = t;
      });
      var fs = L.toks.reduce(function (a, t) { return a + (t.fontSize || 0); }, 0) / L.toks.length;
      return {
        text: text.replace(/[ \t]+/g, ' ').trim(),
        y0: L.y0, y1: L.y1, cy: L.cy, fontSize: fs,
        x0: L.toks[0].x0, x1: L.toks[L.toks.length - 1].x1
      };
    }).filter(function (L) { return L.text; });
  };

  // normalize a line for running header/footer comparison: lowercase, collapse every
  // run of digits to a single '#', collapse whitespace. "Page 3 of 12" and "Page 4 of
  // 97" both normalize to "page # of #", so a running header/footer is recognized even
  // though the visible page number (or a date, etc.) changes from page to page.
  PURE.normLine = function (s) {
    return String(s || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  };

  // a line that consists ONLY of a page number: "12", "- 12 -", "Page 12 of 99", "12 / 99"
  PURE.isPageNumberLine = function (s) {
    var t = String(s || '').trim();
    if (!t) return false;
    if (/^[-–—\s]*\d+[-–—\s]*$/.test(t)) return true;
    if (/^page\s+\d+(\s+of\s+\d+)?$/i.test(t)) return true;
    if (/^\d+\s*\/\s*\d+$/.test(t)) return true;
    return false;
  };

  // detect running headers/footers across a whole document: look at the first/last
  // `edgeLines` grouped lines of every page that ALSO sit within `edgeBand` of the top
  // or bottom of the page (default the top/bottom 15%), normalize them (PURE.normLine),
  // and flag any normalized line that recurs at a similar normalized y-position on at
  // least `minFrac` of pages (and at least `minPages` pages) as a running header/footer.
  // The y-band requirement matters: on a short page (few lines), the first/last GROUPED
  // LINE by index can land well into the body (e.g. a short cover page), and a body
  // sentence that only varies by a page/section number would otherwise normalize
  // identically across pages and get mistaken for a running footer — real headers and
  // footers actually sit near the physical edge of the page, so requiring that too is
  // what keeps this from firing on ordinary body text. `pagesLines` is an array (one
  // entry per page) of grouped-line objects, e.g. from PURE.groupLines.
  PURE.findRunningLines = function (pagesLines, opts) {
    opts = opts || {};
    var edgeN = opts.edgeLines || 2, minFrac = opts.minFrac == null ? 0.6 : opts.minFrac,
        minPages = opts.minPages || 3, yTol = opts.yTol == null ? 0.08 : opts.yTol,
        edgeBand = opts.edgeBand == null ? 0.15 : opts.edgeBand;
    var n = (pagesLines || []).length;
    if (n < minPages) return [];
    var buckets = {};   // normalized text -> [{page, cy, line}]
    pagesLines.forEach(function (lines, pi) {
      var cands = [];
      for (var i = 0; i < Math.min(edgeN, lines.length); i++) cands.push(lines[i]);
      for (var j = Math.max(0, lines.length - edgeN); j < lines.length; j++) {
        if (cands.indexOf(lines[j]) === -1) cands.push(lines[j]);
      }
      cands.forEach(function (L) {
        if (!(L.cy <= edgeBand || L.cy >= 1 - edgeBand)) return;   // nowhere near a real edge
        var key = PURE.normLine(L.text);
        if (!key) return;
        (buckets[key] || (buckets[key] = [])).push({ page: pi, cy: L.cy, line: L });
      });
    });
    var running = [];
    Object.keys(buckets).forEach(function (key) {
      var occ = buckets[key].slice().sort(function (a, b) { return a.cy - b.cy; });
      // cluster occurrences by cy within yTol and keep the largest cluster — the same
      // normalized text could coincidentally appear at two unrelated edge bands. Chain
      // to the LAST element added (not the first): a fixed first-of-cluster anchor lets
      // a slowly-drifting sequence of occurrences (e.g. a heading that pushes everything
      // below it down a bit on one page) sweep in an outlier that is only close to the
      // first element by coincidence, not actually part of the same stable band.
      var best = [], cur = [];
      occ.forEach(function (o) {
        if (cur.length && Math.abs(o.cy - cur[cur.length - 1].cy) > yTol) { if (cur.length > best.length) best = cur; cur = []; }
        cur.push(o);
      });
      if (cur.length > best.length) best = cur;
      var uniquePages = {};
      best.forEach(function (o) { uniquePages[o.page] = 1; });
      var pageCount = Object.keys(uniquePages).length;
      if (pageCount >= minPages && pageCount / n >= minFrac) {
        running.push({ key: key, lines: best.map(function (o) { return o.line; }) });
      }
    });
    return running;
  };

  // drop running headers/footers (PURE.findRunningLines) and any edge line that is
  // ONLY a page number, from every page's grouped lines. Returns a NEW array of arrays
  // (one per page) — the input is not mutated.
  // The page-number branch carries the SAME physical edge-band guard the running-line
  // detector uses, and only applies to a document with more than one page: on a short
  // page the first/last line BY INDEX can sit in the middle of the page, and a bare
  // number there is far more likely to be content (an invoice total, a chart label, a
  // year) than pagination.
  PURE.stripHeadersFooters = function (pagesLines, opts) {
    opts = opts || {};
    var edgeN = opts.edgeLines || 2;
    var edgeBand = opts.edgeBand == null ? 0.15 : opts.edgeBand;
    var running = PURE.findRunningLines(pagesLines, opts);
    var dropRefs = [];
    running.forEach(function (r) { r.lines.forEach(function (L) { dropRefs.push(L); }); });
    var paginated = (pagesLines || []).length > 1;
    return (pagesLines || []).map(function (lines) {
      var n = lines.length;
      return lines.filter(function (L, i) {
        var isEdge = (i < edgeN || i >= n - edgeN) && (L.cy <= edgeBand || L.cy >= 1 - edgeBand);
        if (paginated && isEdge && PURE.isPageNumberLine(L.text)) return false;
        if (dropRefs.indexOf(L) !== -1) return false;
        return true;
      });
    });
  };

  // text/word tokens whose box overlaps a redaction rect must never leak into any
  // output — this is the exact same geometry test PURE.filterOcrWords already uses to
  // keep redacted content out of the invisible OCR text layer, reused here under a name
  // that reads at the Copy-clean-text call site. The honesty contract is identical:
  // redacted content must not survive in ANY extracted text, OCR-derived or vector.
  PURE.filterRedactedTokens = PURE.filterOcrWords;

  // a line starting with a common bullet glyph — kept as its own line (normalized to
  // "- ") rather than merged into flowing prose.
  PURE.BULLET_RE = /^[ \t]*[•◦▪‣∙·○●*]\s+/;

  // median line-to-line vertical gap and median line font size, both computed only
  // WITHIN each page (gaps are never compared across a page boundary — two different
  // pages don't share a coordinate frame) — used as the "what's normal here" baseline
  // for paragraph-break and heading detection.
  PURE.textMetrics = function (pagesLines) {
    var gaps = [], fonts = [];
    (pagesLines || []).forEach(function (lines) {
      for (var i = 0; i < lines.length; i++) {
        fonts.push(lines[i].fontSize || 0);
        if (i > 0) gaps.push(Math.max(0, lines[i].y0 - lines[i - 1].y1));
      }
    });
    gaps.sort(function (a, b) { return a - b; });
    fonts.sort(function (a, b) { return a - b; });
    return {
      medGap: gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0.012,
      medFont: fonts.length ? fonts[Math.floor(fonts.length / 2)] : 0.02
    };
  };

  // stitch grouped lines (one array per page) into paragraph-level blocks. A heading
  // (font size well above the document's median body size) becomes its own block; a
  // bullet line keeps its own line inside a "bullets" block instead of merging into
  // prose; otherwise consecutive lines merge into one paragraph, with a line ending in
  // "-" joining to a lowercase-starting next line WITHOUT the hyphen (de-hyphenation)
  // and everything else joining with a single space. A vertical gap bigger than ~1.6x
  // this document's median line gap starts a new paragraph — and so does every PAGE
  // BREAK, unless the previous line ends in a hyphen that continues onto the next
  // page's first line (a plain page break has no meaningful "vertical gap" to compare,
  // since the two pages don't share a coordinate frame, so it's always treated as a
  // paragraph break rather than guessed at).
  PURE.assembleBlocks = function (pagesLines, opts) {
    opts = opts || {};
    var m = PURE.textMetrics(pagesLines);
    var medFont = opts.medFont != null ? opts.medFont : m.medFont;
    // a token's box is a full font-height tall, so any line whose leading is no bigger
    // than its own box contributes a gap of exactly 0 — with tight leading (or mixed
    // font sizes) the median can land on 0, and then EVERY positive gap would read as a
    // paragraph break. Floor it against the body font size so the comparison stays a
    // comparison.
    var medGap = opts.medGap != null ? opts.medGap : Math.max(m.medGap, medFont * 0.25);
    var blocks = [], cur = null, prevLine = null, prevPage = -1;

    function startBlock(kind, page) { cur = { kind: kind, lines: [], pages: [page] }; blocks.push(cur); }
    function touchPage(page) { if (cur.pages.indexOf(page) === -1) cur.pages.push(page); }
    function pushLine(norm) {
      if (cur.kind === 'bullets') { cur.lines.push(norm); return; }
      if (!cur.lines.length) { cur.lines.push(norm); return; }
      var last = cur.lines[0];
      if (/[a-z]-$/i.test(last) && /^[a-z]/.test(norm)) cur.lines[0] = last.replace(/-\s*$/, '') + norm;
      else cur.lines[0] = last + ' ' + norm;
    }

    (pagesLines || []).forEach(function (lines, pi) {
      lines.forEach(function (L) {
        var text = L.text;
        var isBullet = PURE.BULLET_RE.test(text);
        var norm = isBullet ? text.replace(PURE.BULLET_RE, '- ') : text;
        var isHeading = !isBullet && medFont > 0 && L.fontSize >= medFont * 1.25 && text.length < 140;
        var kind = isHeading ? 'heading' : (isBullet ? 'bullets' : 'para');
        var isNewPage = pi !== prevPage;
        var startNew;
        if (!cur) startNew = true;
        else if (kind !== cur.kind) startNew = true;
        else if (isNewPage) {
          var lastText = cur.lines[cur.lines.length - 1] || '';
          var hyphenJoin = kind !== 'bullets' && /[a-z]-$/i.test(lastText) && /^[a-z]/.test(norm);
          startNew = !hyphenJoin;
        } else {
          startNew = (L.y0 - prevLine.y1) > medGap * 1.6 + 1e-6;
        }
        if (startNew) startBlock(kind, pi); else touchPage(pi);
        pushLine(norm);
        prevLine = L; prevPage = pi;
      });
    });
    return blocks;
  };

  // render blocks (PURE.assembleBlocks) to final plain text: bullet blocks keep one
  // line per item, everything else is a single flowing line per block, and blocks are
  // separated by a blank line. With `opts.pageMarkers`, a "--- page N ---" line is
  // inserted the first time a block touches a page not yet announced (N comes from
  // `opts.pageLabels[pageIndex]`, falling back to `pageIndex+1` — callers pass real
  // document page numbers so a "selected pages" subset still shows the right numbers).
  // A page that contributed no lines at all (blank, or no text layer) gets no marker —
  // there is no content boundary to mark, and that omission is itself informative.
  // Only a block's FIRST page is announced: a paragraph hyphenated across a page break
  // belongs to the page it starts on, and announcing the later page in front of it would
  // put the marker before text that came from the earlier page. The later page gets its
  // marker from the next block that actually starts on it.
  PURE.blocksToText = function (blocks, opts) {
    opts = opts || {};
    var labels = opts.pageLabels;
    function label(p) { return (labels && labels[p] != null) ? labels[p] : (p + 1); }
    var announced = {}, out = [];
    (blocks || []).forEach(function (b) {
      if (opts.pageMarkers) {
        var p0 = b.pages[0];
        if (p0 != null && !announced[p0]) { announced[p0] = true; out.push('--- page ' + label(p0) + ' ---'); }
      }
      out.push(b.kind === 'bullets' ? b.lines.join('\n') : b.lines[0]);
    });
    return out.join('\n\n');
  };

  // full pipeline in one call: per-page TOKENS ({text,x0,y0,x1,y1,fontSize}, one array
  // per page) -> grouped lines -> headers/footers stripped -> paragraph blocks -> text.
  // Each stage above is independently unit-tested; the app (pdftools-tools.js) also
  // calls PURE.blocksToText directly to re-render cheaply when only the "keep page
  // markers" checkbox changes, without repeating the pdf.js work.
  PURE.tokensToCleanText = function (pagesTokens, opts) {
    var pagesLines = (pagesTokens || []).map(function (toks) { return PURE.groupLines(toks); });
    var stripped = PURE.stripHeadersFooters(pagesLines, opts);
    var blocks = PURE.assembleBlocks(stripped, opts);
    return { blocks: blocks, text: PURE.blocksToText(blocks, opts) };
  };

  if (typeof window === 'undefined') {
    // node (test harness): export the pure helpers and stop — everything below needs a DOM
    if (typeof module !== 'undefined' && module.exports) module.exports = PURE;
    return;
  }
  window.__PT_PURE = PURE;

  /* ==================================================================================
     Browser app
     ================================================================================== */
  var $ = function (id) { return document.getElementById(id); };
  if (!window.PDFLib || !window.pdfjsLib) {
    var s0 = $('pt-status'); if (s0) s0.textContent = 'Could not load the PDF engine.';
    return;
  }
  var PDFLib = window.PDFLib, pdfjsLib = window.pdfjsLib;

  // The MINIFIED pdf-lib mangles class names, so constructor.name is useless — detect
  // form-field types by instanceof against the exported classes, with a duck-typing fallback.
  function fieldType(f) {
    if (PDFLib.PDFTextField && f instanceof PDFLib.PDFTextField) return 'text';
    if (PDFLib.PDFCheckBox && f instanceof PDFLib.PDFCheckBox) return 'checkbox';
    if (PDFLib.PDFDropdown && f instanceof PDFLib.PDFDropdown) return 'select';
    if (PDFLib.PDFOptionList && f instanceof PDFLib.PDFOptionList) return 'select';
    if (PDFLib.PDFRadioGroup && f instanceof PDFLib.PDFRadioGroup) return 'radio';
    if (typeof f.setText === 'function') return 'text';
    if (typeof f.check === 'function' && typeof f.isChecked === 'function') return 'checkbox';
    if (typeof f.getOptions === 'function' && typeof f.select === 'function') return 'select';
    return null;
  }

  // point pdf.js at its LOCAL worker (derive the path from this page's pdf.js <script>)
  var pj = document.querySelector('script[src*="pdfjs/pdf.min.js"]');
  pdfjsLib.GlobalWorkerOptions.workerSrc = pj
    ? pj.src.replace('pdf.min.js', 'pdf.worker.min.js')
    : '/assets/js/pdflib/pdfjs/pdf.worker.min.js';

  // base path of assets/js/ (for lazy-loading the OCR + encryption engines)
  var jsBase = (function () {
    var s = document.querySelector('script[src*="pdftools.js"]');
    return s ? s.src.replace(/pdftools\.js.*$/, '') : '/assets/js/';
  })();

  // ---- state ----
  var docs = [];             // { name, bytes:Uint8Array (for pdf-lib), js:pdfjsDoc (for rendering), formValues, pw (until decrypted) }
  var pages = [];            // page model — see newPage()
  var pageNums = null;       // { fmt:'n'|'nofm', pos:'bc'|'br', start, skipFirst, size } or null
  var lastFlattenedRot = 0;  // pages the last build rasterized because overlays sat on a rotated page
  var lastFlattenedSrc = 0;  // pages the last build rasterized because the source was encrypted/damaged
  var lastDropped = 0;       // added texts/watermarks that lost characters (not WinAnsi-encodable)
  var lastSigFailed = 0;     // placed signatures that could not be embedded into the output
  var lastFormFailed = 0;    // filled form field values that could not be applied
  var lastDpiCapped = 0;     // pages flattened at a lower DPI than requested (page too large)
  var lastDpiFloor = 0;      // the lowest effective DPI actually used, when lastDpiCapped > 0
  var redactDpi = 150;       // render quality used when redacted pages are flattened on download
  var busy = false;          // one long operation at a time
  var undoStack = PURE.makeUndoStack(25);
  var lastSelIdx = -1;       // shift-click anchor
  var engineNote = $('pt-engine');

  function newPage(docIndex, pageIndex) {
    return {
      docIndex: docIndex, pageIndex: pageIndex, rot: 0, sel: false,
      raster: null, blank: null, ocr: false,
      redacts: [], whiteouts: [], sigs: [], texts: [], wms: [], ocrWords: null
    };
  }
  function hasRedacts(pg) { return !!(pg.redacts && pg.redacts.length); }
  function hasWhiteouts(pg) { return !!(pg.whiteouts && pg.whiteouts.length); }

  // ---- text metrics + layout (the law lives in the PURE rich-text section) ----
  // ONE metrics service for every picture: the per-character AFM advance table for the
  // twelve standard faces, built once here from a throwaway PDFDocument. It resolves in
  // a microtask (embedStandardFont is synchronous), long before a file can be loaded,
  // and it never rejects. layoutTextBox takes the RESOLVED table, so it stays pure and
  // synchronous and is never rebuilt per call.
  var metricsTable = null;
  var metricsReady = PURE.buildMetrics(PDFLib).then(function (tb) { metricsTable = tb; return tb; });
  function textLayout(t, Wpt, Hpt) { return PURE.layoutTextBox(t, Wpt, Hpt, metricsTable); }

  // approximate normalized {w,h} bounding box for a text annotation, measured against
  // the CURRENT effective page size (Wpt, Hpt) — used only when rotating a page (see
  // PURE.rotateTexts) so the rotation can account for the text's own footprint instead
  // of treating it as a zero-size point (which lets it get rotated into a spot where it
  // runs off the page — text only ever grows right/down from its anchor).
  // Now a thin wrapper over the layout law. The old canvas measure asked for a Georgia
  // stack for Times, about 6 percent wider than the face the page actually draws, so
  // there is exactly one measurement law in the app again.
  function textBoxFrac(t, Wpt, Hpt) {
    var lay = textLayout(t, Wpt, Hpt);
    return { w: Wpt ? Math.min(1, lay.boxW / Wpt) : 0, h: Hpt ? Math.min(1, lay.boxH / Hpt) : 0 };
  }
  function textBoxes(texts, Wpt, Hpt) { return (texts || []).map(function (t) { return textBoxFrac(t, Wpt, Hpt); }); }

  // the visual lines of a box, in effective-page fractions (the law is PURE.textLines)
  function textLines(t, Wpt, Hpt) { return PURE.textLines(t, Wpt, Hpt, metricsTable); }

  // ---- elements ----
  var drop = $('pt-drop'), grid = $('pt-grid'), fileInput = $('pt-file'), toolbar = $('pt-toolbar');
  var statusEl = $('pt-status'), countEl = $('pt-count');
  var tipEl = $('pt-tip'), btnEditPage = $('pt-editpage');
  var btnAdd = $('pt-add'), btnSelAll = $('pt-selall'), btnRotate = $('pt-rotate'), btnRotCcw = $('pt-rotccw'),
      btnDup = $('pt-dup'), btnBlank = $('pt-blank'), btnDelete = $('pt-delete'), btnUndo = $('pt-undo'),
      btnShrink = $('pt-shrink'), btnExtract = $('pt-extract'), btnSplit = $('pt-split'), btnDownload = $('pt-download'),
      chkStrip = $('pt-stripmeta');
  var rangeInput = $('pt-range'), rangeInfo = $('pt-range-info');
  var progWrap = $('pt-progress'), progFill = $('pt-progress-fill');

  // kind: 'err' | 'warn' | omit — styles the status line (see .pt-status--err/--warn)
  function setStatus(msg, kind) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.classList.remove('pt-status--err', 'pt-status--warn');
    if (kind === 'err') statusEl.classList.add('pt-status--err');
    else if (kind === 'warn') statusEl.classList.add('pt-status--warn');
    // the status line sits below the grid, which for multi-page docs is below the fold —
    // bring terminal messages (saved / errors / warnings) into view, never progress ticks
    if (!msg) return;
    var edEl = document.getElementById('pt-ed');
    if (edEl && !edEl.hidden) return;   // the full-screen editor covers the page anyway
    if (/^(Saved|Error|Couldn|Skipped|No pages|Heads up)/.test(msg) || msg.indexOf('flattened') >= 0 ||
        msg.indexOf('could not') >= 0 || msg.indexOf('larger') >= 0) {
      var r = statusEl.getBoundingClientRect();
      if (r.top > window.innerHeight - 30 || r.bottom < 0) {
        try { statusEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
        catch (e) { statusEl.scrollIntoView(); }
      }
    }
  }

  // ---------- progress / busy ----------
  // resolves after the browser has had a chance to PAINT (rAF fires before paint, the
  // timeout queued from it runs after; falls back to a plain timeout in hidden tabs
  // where rAF never fires)
  function nextFrame() {
    return new Promise(function (res) {
      if (document.hidden) { setTimeout(res, 0); return; }
      requestAnimationFrame(function () { setTimeout(res, 0); });
    });
  }
  function progress(done, total, msg) {
    if (progWrap) {
      progWrap.hidden = false;
      var pct = total ? Math.max(0, Math.min(100, Math.round(done / total * 100))) : 0;
      progFill.style.width = pct + '%';
      progWrap.setAttribute('aria-valuenow', String(pct));
    }
    if (msg != null) setStatus(msg);
    return nextFrame();
  }
  function progressDone() {
    if (progWrap) { progWrap.hidden = true; progFill.style.width = '0%'; }
  }
  function setBusy(b) {
    busy = b;
    if (toolbar) toolbar.classList.toggle('pt-busy', b);
    if (drop) drop.classList.toggle('pt-busy', b);
    // the export buttons take a REAL disabled while busy (pointer-events:none on the
    // toolbar does not stop keyboard activation, and a queued rapid second click on
    // Download would build the same PDF twice); updateToolbar restores them after
    if (b) [btnDownload, btnExtract, btnSplit].forEach(function (x) { if (x) x.disabled = true; });
    if (!b) { progressDone(); updateToolbar(); }
  }

  // ---------- undo ----------
  var snapSeq = 0;   // monotonic push counter — lets callers detect "a snapshot was taken since"
  function snapshot(label) {
    snapSeq++;
    undoStack.push({
      label: label,
      pages: pages.map(PURE.clonePage),
      pageNums: pageNums ? {
        fmt: pageNums.fmt, pos: pageNums.pos, start: pageNums.start,
        skipFirst: pageNums.skipFirst, size: pageNums.size
      } : null,
      // filled form values live on the docs, not the pages — capture them too
      forms: docs.map(function (d) { return d.formValues ? Object.assign({}, d.formValues) : null; })
    });
    pruneDocs();     // the bounded stack may just have evicted the last reference to a doc
    updateToolbar();
  }

  // release source docs nothing can reach any more: a doc whose pages were all deleted
  // stays pinned only while some undo entry could restore them; once the 25-deep stack
  // evicts that entry, free the bytes + the pdf.js worker memory. Entries are TOMBSTONED
  // in place (bytes/js nulled), never spliced — pg.docIndex and snapshot.forms are
  // positional.
  function pruneDocs() {
    if (!docs.length) return;
    var used = {};
    function mark(ps) { (ps || []).forEach(function (p) { if (p.docIndex >= 0) used[p.docIndex] = true; }); }
    mark(pages);
    undoStack.entries().forEach(function (e) { mark(e.pages); });
    docs.forEach(function (d, i) {
      if (!d || used[i] || !d.bytes) return;
      d.bytes = null; d.pw = null;
      if (d.js) { try { d.js.destroy(); } catch (e) {} d.js = null; }
    });
  }
  function dropSnapshot() { undoStack.pop(); updateToolbar(); }
  function undo() {
    if (busy) return;
    var e = undoStack.pop();
    if (!e) return;
    snapSeq++;   // invalidate snapSeq top-of-stack guards held across the undo (stale createSeq etc.)
    pages = e.pages;
    pageNums = e.pageNums;
    if (e.forms) e.forms.forEach(function (fv, i) { if (docs[i]) docs[i].formValues = fv; });
    lastSelIdx = -1;
    pruneDocs();   // the popped entry may have held the last reference to a source doc
    renderGrid(); updateToolbar();
    setStatus('Undid: ' + e.label + '.');
    if (window.__PT && window.__PT.onUndo) window.__PT.onUndo();
  }

  function modalOpen() { return !!document.querySelector('.pt-modal:not([hidden])'); }
  function openDialog(el) {
    if (!el || busy || modalOpen()) return false;
    el.__opener = document.activeElement;   // so closeDialog can hand focus back
    el.hidden = false;
    // move focus into the dialog (first field, else the primary button) so keyboard and
    // screen-reader users land inside it, not on the obscured page behind the backdrop
    var pick = el.querySelector('input:not([type=hidden]):not([disabled]), select, textarea') ||
               el.querySelector('.pt-btn--accent, .pt-btn--danger') || el.querySelector('button');
    if (pick) setTimeout(function () { try { pick.focus(); } catch (e) {} }, 0);
    return true;
  }
  // every dialog close path routes through here: without the focus restore, closing a
  // modal drops focus to <body> and a keyboard/SR user restarts from the top of the page
  function closeDialog(el) {
    if (!el) return;
    el.hidden = true;
    var op = el.__opener; el.__opener = null;
    if (op) { try { op.focus(); } catch (e) {} }
  }

  // ---------- loading source PDFs / images ----------
  var IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
  function isImage(f) { return /^image\//.test(f.type) || IMG_RE.test(f.name); }
  function isPdf(f) { return f.type === 'application/pdf' || /\.pdf$/i.test(f.name); }

  function addFiles(fileList) {
    // a drop while a load is running must not vanish silently — say so
    if (busy) { setStatus('Still busy with the current operation, add those files again in a moment.', 'warn'); return; }
    var all = Array.prototype.slice.call(fileList);
    var arr = all.filter(function (f) { return isPdf(f) || isImage(f); });
    var badType = all.filter(function (f) { return !isPdf(f) && !isImage(f); });
    if (!arr.length) { if (badType.length) setStatus('Those files aren’t PDFs or images.', 'err'); return; }
    setBusy(true);
    var beforeLen = pages.length, beforeDocs = docs.length;
    snapshot('add ' + arr.length + ' file' + (arr.length > 1 ? 's' : ''));
    var addSeq = snapSeq;   // guards the trailing dropSnapshot below (top-of-stack check)
    var failed = [], skipped = [];
    var chain = Promise.resolve();
    arr.forEach(function (f, fi) {
      chain = chain.then(function () {
        return progress(fi, arr.length, 'Reading ' + f.name + ' (' + (fi + 1) + ' of ' + arr.length + ')…');
      }).then(function () {
        var nm = f.name;
        var bytesP = isImage(f) ? imageToPdfBytes(f) : f.arrayBuffer().then(function (b) { return new Uint8Array(b); });
        // one bad file must not abort the rest — isolate each with its own catch
        return bytesP.then(function (bytes) { return addPdfBytes(bytes, nm); })
          .catch(function (e) {
            if (e && e.__ptSkip) skipped.push(nm); else failed.push(nm);
            if (window.console) console.warn('pdftools: could not add ' + nm, e);
          })
          .then(function () {
            // show what we have so far — skeleton thumbnails fill in as pdf.js renders
            renderGrid(); updateToolbar();
            return progress(fi + 1, arr.length);
          });
      });
    });
    chain.then(function () {
      // nothing was actually added — drop the "add N files" snapshot, but ONLY while it
      // is still top-of-stack (editor edits made during the load are not gated on busy,
      // so a user snapshot may have landed on top; popping that one corrupts the stack)
      if (pages.length === beforeLen && snapSeq === addSeq) dropSnapshot();
      setBusy(false);
      var added = pages.length - beforeLen;
      // the page count grew, so existing thumbs' "n of m" page-number totals are stale
      if (added > 0) orderChanged();
      renderGrid(); updateToolbar();
      var msg = [];
      if (added > 0) msg.push('Added ' + added + ' page' + (added > 1 ? 's' : '') + '.');
      if (failed.length) msg.push('Couldn’t read: ' + failed.join(', ') + ' (the file may be corrupted or an unsupported format).');
      if (skipped.length) msg.push('Skipped (password not provided): ' + skipped.join(', ') + '.');
      if (badType.length) msg.push('Skipped ' + badType.map(function (f) { return f.name; }).join(', ') + ' (not a PDF or image).');
      var addKind = added === 0 ? 'err' : (failed.length || skipped.length || badType.length) ? 'warn' : undefined;
      var base = msg.join(' ');
      setStatus(base, addKind);
      // a form PDF looks like any other one in the grid until you open the editor — say so
      if (added > 0) hasFillableFields(beforeDocs).then(function (yes) {
        if (!yes || !statusEl || statusEl.textContent !== base) return;   // something else has spoken since
        setStatus(base + ' This PDF has fillable form fields. Double-click a page to fill them.', addKind);
      }, function () {});   // a notice is a nicety: never let it break the rest of the load
      // let the open editor refresh its page label / nav arrows for the new pages
      if (added > 0 && window.__PT && window.__PT.onPagesChanged) window.__PT.onPagesChanged();
    });
  }

  // do any of the docs added from index `from` on carry fillable AcroForm fields? Uses
  // pdf.js's already-parsed field map (cheap — no second pdf-lib load of the bytes) and
  // ignores push buttons and signature widgets, which are not things you can type into.
  function hasFillableFields(from) {
    var ds = docs.slice(from).filter(function (d) { return d && d.js && d.js.getFieldObjects; });
    if (!ds.length) return Promise.resolve(false);
    return Promise.all(ds.map(function (d) {
      var p;
      // a torn-down pdf.js document throws from this call rather than rejecting
      try { p = d.js.getFieldObjects(); } catch (e) { return false; }
      if (!p || !p.then) return false;
      return p.then(function (fo) {
        if (!fo) return false;
        return Object.keys(fo).some(function (k) {
          return (fo[k] || []).some(function (f) {
            return f && f.type && f.type !== 'button' && f.type !== 'signature';
          });
        });
      }, function () { return false; });
    })).then(function (r) { return r.some(Boolean); });
  }

  function addPdfBytes(bytes, name) {
    // pdf.js detaches the buffer it's given, so hand it a COPY and keep `bytes` for pdf-lib.
    // Retry with a password from the styled modal if the PDF is password-protected.
    function attempt(password) {
      // isEvalSupported: false keeps pdf.js from compiling font glyph programs with
      // new Function (CVE-2024-4367: a crafted FontMatrix ran script on this origin)
      return pdfjsLib.getDocument({ data: bytes.slice(0), password: password, isEvalSupported: false }).promise.then(function (jsDoc) {
        var docIndex = docs.length;
        // a password-protected source keeps the password until its first export decrypts
        // it (decryptedLibDoc), and its exports are not protected, so not named so
        var rec = { name: password != null ? PURE.dropProtectedSuffix(name) : name, bytes: bytes, js: jsDoc, formValues: null };
        if (password != null) rec.pw = password;
        docs.push(rec);
        for (var i = 0; i < jsDoc.numPages; i++) pages.push(newPage(docIndex, i));
      }).catch(function (e) {
        var needsPw = e && (e.name === 'PasswordException' || /password/i.test(e.message || ''));
        if (needsPw) {
          return askPassword(name, password != null).then(function (pw) {
            if (pw == null) { var skip = new Error('password required'); skip.__ptSkip = true; throw skip; }
            return attempt(pw);
          });
        }
        throw e;
      });
    }
    return attempt(undefined);
  }

  // ---------- password modal (replaces window.prompt) ----------
  var passDialog = $('pt-pass-dialog'), passMsg = $('pt-pass-msg'), passInput = $('pt-pass-input');
  var passResolve = null;
  function askPassword(name, again) {
    if (!passDialog) return Promise.resolve(null);
    function show() {
      return new Promise(function (res) {
        passResolve = res;
        if (passMsg) passMsg.textContent = (again ? 'That password didn’t work. ' : '') +
          '“' + name + '” is password-protected. Enter its password to open it, or cancel to skip this file.';
        if (passInput) passInput.value = '';
        if (passDialog.hidden) passDialog.__opener = document.activeElement;   // opened directly, not via openDialog
        passDialog.hidden = false;
        setTimeout(function () { if (passInput) passInput.focus(); }, 0);
      });
    }
    // a drag-dropped encrypted file can trigger this while the user already has a
    // different dialog open (Watermark, Shrink, …) — the one-modal-at-a-time design means
    // never stacking a second one on top; wait for the slot to free up first
    if (modalOpen()) {
      return new Promise(function (res) {
        var iv = setInterval(function () {
          if (!modalOpen()) { clearInterval(iv); show().then(res); }
        }, 200);
      });
    }
    return show();
  }
  function passDone(val) {
    if (!passResolve) return;
    closeDialog(passDialog);
    var r = passResolve; passResolve = null;
    r(val);
  }
  if (passDialog) {
    $('pt-pass-go').addEventListener('click', function () { passDone(passInput.value); });
    $('pt-pass-cancel').addEventListener('click', function () { passDone(null); });
    passInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); passDone(passInput.value); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); passDone(null); }
    });
    passDialog.addEventListener('click', function (e) { if (e.target === passDialog) passDone(null); });
  }

  // wrap an image file in a single-page PDF (so it flows through the same pipeline).
  // A JPEG is embedded from PURE.cleanJpeg's copy (EXIF with its GPS and camera data, XMP
  // and the rest cut out, the compressed pixels untouched) and drawn through the matrix
  // its EXIF Orientation asks for, so a portrait phone photo is a portrait page in every
  // picture (thumbnail, editor, export) on every browser. A JPEG that does not parse is
  // re-encoded through a canvas, which writes no metadata either. PNG needs nothing:
  // pdf-lib decodes it and stores only the pixels; webp/gif/bmp go through a canvas.
  function imageToPdfBytes(file) {
    return file.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);
      return PDFLib.PDFDocument.create().then(function (doc) {
        function pageSize(W, H) {
          var maxSide = 1100, s = Math.min(1, maxSide / Math.max(W, H));
          return [Math.max(1, Math.round(W * s)), Math.max(1, Math.round(H * s))];
        }
        function place(img) {
          var sz = pageSize(img.width, img.height);
          doc.addPage(sz).drawImage(img, { x: 0, y: 0, width: sz[0], height: sz[1] });
          return doc.save();
        }
        function placeOriented(img, o) {
          if (o === 1) return place(img);
          var swap = o >= 5;
          var sz = pageSize(swap ? img.height : img.width, swap ? img.width : img.height);
          var page = doc.addPage(sz), m = PURE.orientMatrix(o, sz[0], sz[1]);
          var xo = page.node.newXObject('Image', img.ref);
          page.pushOperators(PDFLib.pushGraphicsState(),
            PDFLib.concatTransformationMatrix(m[0], m[1], m[2], m[3], m[4], m[5]),
            PDFLib.drawObject(xo), PDFLib.popGraphicsState());
          return doc.save();
        }
        if (/png$/i.test(file.type) || /\.png$/i.test(file.name)) return doc.embedPng(bytes).then(place);
        if (/jpe?g$/i.test(file.type) || /\.jpe?g$/i.test(file.name)) {
          var jp = PURE.cleanJpeg(bytes);
          if (jp) return doc.embedJpg(jp.bytes).then(function (img) { return placeOriented(img, jp.orientation); });
          return blobToImageBytes(file, 'image/jpeg', 0.92).then(function (jpg) { return doc.embedJpg(jpg).then(place); });
        }
        return blobToPngBytes(file).then(function (png) { return doc.embedPng(png).then(place); });   // webp/gif/bmp via canvas
      });
    });
  }
  function blobToPngBytes(file) { return blobToImageBytes(file, 'image/png'); }
  // decode an image file with the browser (which applies any orientation tag) and encode
  // it afresh as `mime` (a canvas writes no metadata); JPEG output is drawn on white
  function blobToImageBytes(file, mime, quality) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), im = new Image();
      im.onload = function () {
        URL.revokeObjectURL(url);
        // everything in here must settle the promise — a dropped canvasToBytes rejection
        // (toBlob → null past the browser canvas size limit, e.g. a 20000px WebP) or a
        // drawImage throw would leave addFiles stuck busy forever with the toolbar inert
        try {
          var c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
          var cx = c.getContext('2d');
          if (mime === 'image/jpeg') { cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height); }
          cx.drawImage(im, 0, 0);
          canvasToBytes(c, mime, quality).then(function (out) { c.width = 0; res(out); }, rej);
        } catch (e) { rej(e); }
      };
      im.onerror = function () { URL.revokeObjectURL(url); rej(new Error('could not decode image')); };
      im.src = url;
    });
  }

  // ---------- thumbnails ----------
  function totalRotation(jsPage, extra) { return ((jsPage.rotate || 0) + (extra || 0)) % 360; }

  // object URL that revokes itself once the image has loaded
  function pngUrlInto(img, bytes) {
    var url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    var prevLoad = img.onload, prevErr = img.onerror;
    img.onload = function () { URL.revokeObjectURL(url); if (prevLoad) prevLoad.apply(this, arguments); };
    img.onerror = function () { URL.revokeObjectURL(url); if (prevErr) prevErr.apply(this, arguments); };
    img.src = url;
  }

  // draw a raster page (stored PNG) into a fresh canvas at targetW CSS px, honoring pg.rot
  function rasterToCanvas(pg, targetW) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.onload = function () {
        var rot = ((pg.rot || 0) % 360 + 360) % 360;
        var swap = rot === 90 || rot === 270;
        var effW = swap ? im.height : im.width, effH = swap ? im.width : im.height;
        var s = targetW / effW;
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(effW * s)); c.height = Math.max(1, Math.round(effH * s));
        var cx = c.getContext('2d');
        cx.translate(c.width / 2, c.height / 2);
        cx.rotate(rot * Math.PI / 180);
        cx.scale(s, s);
        cx.drawImage(im, -im.width / 2, -im.height / 2);
        // reset the context — consumers (redact bake, OCR pre-paint, decor) draw through
        // this same context, and a leftover translate/rotate/scale would displace
        // everything they paint (redaction boxes landed in the corner, off the content)
        cx.setTransform(1, 0, 0, 1, 0, 0);
        res(c);
      };
      im.onerror = function () { rej(new Error('could not load page image')); };
      pngUrlInto(im, pg.raster.png);
    });
  }

  // decode a stored PNG raster and re-encode as JPEG on white — for embedding upright-
  // flattened pages without pdf-lib's PNG-embedder RGBA heap cost (see bakedPage's note)
  function rasterPngToJpg(png) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(new Blob([png], { type: 'image/png' })), im = new Image();
      im.onload = function () {
        URL.revokeObjectURL(url);
        try {
          var c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
          var cx = c.getContext('2d');
          cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
          cx.drawImage(im, 0, 0);
          canvasToBytes(c, 'image/jpeg', 0.92).then(function (jpg) { c.width = 0; res(jpg); }, rej);
        } catch (e) { rej(e); }
      };
      im.onerror = function () { URL.revokeObjectURL(url); rej(new Error('could not decode the stored page image')); };
      im.src = url;
    });
  }

  function renderThumbInto(canvas, pg, gridIdx, done) {
    // the text painter needs the AFM metrics table. It resolves in a microtask at init,
    // so this can only ever defer the very first thumbnail, and done() still fires AFTER
    // the text has been painted (the golden and every thumbnail assertion wait on it).
    if (!metricsTable) { metricsReady.then(function () { renderThumbInto(canvas, pg, gridIdx, done); }); return; }
    // per-page render token: two quick rotates can race two pdf.js renders on the same
    // cached canvas (the second resizes/wipes it mid-render → a garbled thumb that never
    // self-corrects). Only the LATEST render may finish; an abandoned/failed one re-marks
    // the page dirty so the next renderGrid repaints it.
    var mySeq = pg._rseq = (pg._rseq || 0) + 1;
    function stale() { return pg._rseq !== mySeq; }
    if (pg._rtask) { try { pg._rtask.cancel(); } catch (e) {} pg._rtask = null; }
    function finish(Wpt, Hpt) {
      drawThumbOverlays(canvas.getContext('2d'), pg, canvas.width, canvas.height, Wpt, Hpt, gridIdx);
      if (done) done();
    }
    function bail() { if (!stale()) pg._tdirty = true; if (done) done(); }
    if (pg.blank) {
      var sw = (pg.rot % 180) !== 0;
      var bw = sw ? pg.blank.hPt : pg.blank.wPt, bh = sw ? pg.blank.wPt : pg.blank.hPt;
      canvas.width = 150; canvas.height = Math.max(1, Math.round(150 * bh / bw));
      var bx = canvas.getContext('2d'); bx.fillStyle = '#fff'; bx.fillRect(0, 0, canvas.width, canvas.height);
      finish(bw, bh);
      return;
    }
    if (pg.raster) {
      rasterToCanvas(pg, 150).then(function (c) {
        if (stale()) { if (done) done(); return; }
        canvas.width = c.width; canvas.height = c.height;
        canvas.getContext('2d').drawImage(c, 0, 0);
        var sw2 = (pg.rot % 180) !== 0;
        finish(sw2 ? pg.raster.hPt : pg.raster.wPt, sw2 ? pg.raster.wPt : pg.raster.hPt);
      }).catch(bail);
      return;
    }
    docs[pg.docIndex].js.getPage(pg.pageIndex + 1).then(function (page) {
      if (stale()) { if (done) done(); return; }
      var rot = totalRotation(page, pg.rot);
      var base = page.getViewport({ scale: 1, rotation: rot });
      var scale = 150 / base.width;
      var vp = page.getViewport({ scale: scale, rotation: rot });
      canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
      var task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
      pg._rtask = task;
      task.promise.then(function () {
        if (pg._rtask === task) pg._rtask = null;
        if (stale()) { if (done) done(); return; }
        // filled form values must show on the thumbnails like on the export surfaces —
        // paint them here too, before the overlays so a redaction box can cover them
        paintFormValues(canvas, pg).then(function () {
          if (stale()) { if (done) done(); return; }
          finish(base.width, base.height);
        });
      }, function () { if (pg._rtask === task) pg._rtask = null; bail(); });
    }).catch(bail);
  }

  // paint the page's white-out boxes white on a canvas (the same normalized rects and the
  // same frame as the redaction boxes). Called just BEFORE paintRedacts in every painting
  // path, so a redaction box stays on top of a white-out, and before the texts and the
  // signatures, so a correction typed over a white-out shows on top of it.
  function paintWhiteouts(ctx, pg, w, h) {
    if (!hasWhiteouts(pg)) return;
    ctx.save();
    ctx.fillStyle = '#fff';
    pg.whiteouts.forEach(function (r) { ctx.fillRect(r.x * w, r.y * h, r.w * w, r.h * h); });
    ctx.restore();
  }

  // black out the page's redaction boxes on a canvas (normalized rects of the effective
  // page). Painted FIRST, before texts/sigs, so replacement text typed over a redacted
  // area stays visible — and painted in EVERY rasterizing path (thumbnails, shrink,
  // images export, OCR input, final build) so the covered content can never leak.
  function paintRedacts(ctx, pg, w, h) {
    if (!hasRedacts(pg)) return;
    ctx.save();
    ctx.fillStyle = '#000';
    pg.redacts.forEach(function (r) { ctx.fillRect(r.x * w, r.y * h, r.w * w, r.h * h); });
    ctx.restore();
  }

  // signature/text annotations + watermarks + page numbers on a thumbnail or preview canvas.
  // The placement math mirrors the export math in drawOverlays/PURE.draw*.
  function drawThumbOverlays(ctx, pg, tw, th, Wpt, Hpt, gridIdx) {
    paintWhiteouts(ctx, pg, tw, th);
    paintRedacts(ctx, pg, tw, th);
    drawMarks(ctx, pg, tw, th, Wpt, Hpt, gridIdx);
    (pg.texts || []).forEach(function (t) {
      // ONE shared painter for the thumbnails, drawDecor and the editor's resting render.
      // The max(3, ...) pixel floor stays: it is a deliberate readability floor for tiny
      // text on a 150 px thumbnail, not an accident.
      PURE.paintTextBox(ctx, t, textLayout(t, Wpt, Hpt), { scale: tw / Wpt, ox: t.x * tw, oy: t.y * th, floor: 3 });
    });
    (pg.sigs || []).forEach(function (s) {
      var im = new Image();
      im.onload = function () { ctx.drawImage(im, s.x * tw, s.y * th, s.w * tw, s.h * th); };
      pngUrlInto(im, s.png);
    });
  }

  // watermarks + page numbers only (also used by the editor preview, which shows
  // texts/sigs as live DOM elements instead)
  function drawMarks(ctx, pg, tw, th, Wpt, Hpt, gridIdx) {
    var s = tw / Wpt;
    (pg.wms || []).forEach(function (wm) {
      ctx.save();
      ctx.globalAlpha = wm.opacity == null ? 0.15 : wm.opacity;
      ctx.fillStyle = '#7f7f7f';
      ctx.font = ((wm.size || 48) * s) + 'px Arial, Helvetica, sans-serif';
      if (wm.pos === 'foot') {
        ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(wm.text, tw / 2, th - 34 * s);
      } else {
        ctx.translate(tw / 2, th / 2);
        ctx.rotate(-Math.atan2(Hpt, Wpt));
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(wm.text, 0, 0);
      }
      ctx.restore();
    });
    if (pageNums && gridIdx != null) {
      var txt = PURE.pageNumText(pageNums, gridIdx, pages.length);
      if (txt != null) {
        ctx.save();
        ctx.fillStyle = '#3d3d3d';
        ctx.font = ((pageNums.size || 10) * s) + 'px Arial, Helvetica, sans-serif';
        ctx.textBaseline = 'alphabetic';
        if (pageNums.pos === 'br') { ctx.textAlign = 'right'; ctx.fillText(txt, tw - 36 * s, th - 22 * s); }
        else { ctx.textAlign = 'center'; ctx.fillText(txt, tw / 2, th - 22 * s); }
        ctx.restore();
      }
    }
  }

  function markDirty(pg) { pg._tdirty = true; }
  function markAllDirty() { pages.forEach(function (p) { p._tdirty = true; }); }
  // page numbers are drawn from the grid position, so any order change invalidates them
  function orderChanged() { if (pageNums) markAllDirty(); }

  var thumbEls = [];
  function renderGrid() {
    grid.innerHTML = '';
    thumbEls = [];
    drop.classList.toggle('pt-drop--has', pages.length > 0);
    // the drop zone is a labeled ARIA button only while EMPTY — once pages exist it
    // wraps the whole grid (button children are presentational to screen readers) and
    // its Enter/Space handler is gated off, so drop the button semantics until it empties
    if (pages.length > 0) {
      if (drop.getAttribute('role') === 'button') {
        drop.__ptAriaLabel = drop.getAttribute('aria-label');
        drop.removeAttribute('role');
        drop.removeAttribute('aria-label');
        drop.setAttribute('tabindex', '-1');
      }
    } else if (drop.getAttribute('role') !== 'button') {
      drop.setAttribute('role', 'button');
      if (drop.__ptAriaLabel) drop.setAttribute('aria-label', drop.__ptAriaLabel);
      drop.setAttribute('tabindex', '0');
    }
    pages.forEach(function (pg, idx) {
      var t = document.createElement('div');
      t.className = 'pt-thumb' + (pg.sel ? ' pt-sel' : '');
      t.dataset.idx = idx;
      // keyboard path to page selection. Deliberately NO role=button/checkbox: the thumb
      // contains its own real buttons (✎ ⟳ ×), and a widget role would make its children
      // presentational to screen readers.
      t.setAttribute('tabindex', '0');
      t.setAttribute('aria-label', 'Page ' + (idx + 1) + (pg.sel ? ', selected' : ''));

      var c = pg._tc;
      if (!c) { c = pg._tc = document.createElement('canvas'); c.width = 150; c.height = 194; pg._tdirty = true; }
      c.className = 'pt-thumb__canvas';
      t.appendChild(c);
      if (pg._tdirty) {
        pg._tdirty = false;
        t.classList.add('pt-thumb--loading');
        renderThumbInto(c, pg, idx, function () { t.classList.remove('pt-thumb--loading'); });
      }

      var bar = document.createElement('div');
      bar.className = 'pt-thumb__bar';
      bar.innerHTML = '<span class="pt-thumb__num">' + (idx + 1) +
        (hasRedacts(pg) ? ' <span class="pt-thumb__redacted" title="Redacted (flattened to an image on download)">▮</span>' : '') +
        (hasWhiteouts(pg) ? ' <span class="pt-thumb__whiteout" title="White-out (covers, does not remove)">▯</span>' : '') +
        (pg.sigs && pg.sigs.length ? ' <span class="pt-thumb__signed" title="Signed">✎</span>' : '') +
        (pg.ocr ? ' <span class="pt-thumb__ocr" title="Searchable text layer added">abc</span>' : '') + '</span>';
      var acts = document.createElement('div');
      acts.className = 'pt-thumb__acts';
      var eb = document.createElement('button'); eb.className = 'pt-thumb__act'; eb.type = 'button'; eb.title = 'Edit page (text, signature, redact, white-out, form)'; eb.textContent = '✎';
      eb.addEventListener('click', function (e) { e.stopPropagation(); if (!busy && window.__PT.openEditor) window.__PT.openEditor(idx); });
      var rb = document.createElement('button'); rb.className = 'pt-thumb__act'; rb.type = 'button'; rb.title = 'Rotate 90°'; rb.textContent = '⟳';
      rb.addEventListener('click', function (e) {
        e.stopPropagation(); if (busy) return;
        setBusy(true);
        // Wpt/Hpt (needed to measure the text boxes below) may require an async pdf.js
        // call for a live vector page — get it BEFORE mutating anything
        effPointSize(pg).then(function (sz) {
          snapshot('rotate page ' + (idx + 1));
          pg.rot = (pg.rot + 90) % 360;
          pg.redacts = PURE.rotateRects(pg.redacts, 90);   // boxes + OCR words + text/sig
          pg.whiteouts = PURE.rotateRects(pg.whiteouts, 90);
          pg.ocrWords = PURE.rotateWords(pg.ocrWords, 90); // annotations all follow the content
          pg.texts = PURE.rotateTexts(pg.texts, 90, textBoxes(pg.texts, sz.w, sz.h), sz.w, sz.h);
          pg.sigs = PURE.rotateSigs(pg.sigs, 90);
          markDirty(pg); renderGrid();
          setStatus('Rotated page ' + (idx + 1) + '.');
        }).then(function () { setBusy(false); });
      });
      var db = document.createElement('button'); db.className = 'pt-thumb__act'; db.type = 'button'; db.title = 'Delete page'; db.textContent = '×';
      db.addEventListener('click', function (e) {
        e.stopPropagation(); if (busy) return;
        snapshot('delete page ' + (idx + 1));
        pages.splice(idx, 1); orderChanged(); renderGrid(); updateToolbar();
        setStatus('Deleted page ' + (idx + 1) + '.');
      });
      acts.appendChild(eb); acts.appendChild(rb); acts.appendChild(db);
      bar.appendChild(acts);
      t.appendChild(bar);

      // click selects (shift-click selects a range); double-click opens the editor
      function toggleSel(shift) {
        if (busy) return;
        if (shift && lastSelIdx >= 0 && lastSelIdx < pages.length) {
          var a = Math.min(lastSelIdx, idx), b = Math.max(lastSelIdx, idx);
          for (var i = a; i <= b; i++) pages[i].sel = true;
        } else {
          pg.sel = !pg.sel;
          lastSelIdx = idx;
        }
        refreshSel();
      }
      t.addEventListener('click', function (ev) {
        if (suppressClick) { suppressClick = false; return; }
        toggleSel(ev.shiftKey);
      });
      // Enter/Space toggle selection from the keyboard (the ✎ ⟳ × buttons keep their own keys)
      t.addEventListener('keydown', function (ev) {
        if (ev.target !== t) return;
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        toggleSel(ev.shiftKey);
      });
      t.addEventListener('dblclick', function (e) { e.preventDefault(); if (!busy && window.__PT.openEditor) window.__PT.openEditor(idx); });

      // pointer-based drag to reorder (mouse + touch; long-press on touch)
      t.addEventListener('pointerdown', function (e) { thumbPointerDown(e, t, idx); });

      grid.appendChild(t);
      thumbEls.push(t);
    });
  }

  // light-weight selection refresh (no thumbnail re-render)
  function refreshSel() {
    thumbEls.forEach(function (t, i) {
      if (!pages[i]) return;
      t.classList.toggle('pt-sel', !!pages[i].sel);
      t.setAttribute('aria-label', 'Page ' + (i + 1) + (pages[i].sel ? ', selected' : ''));
    });
    updateToolbar();
  }

  // ---------- pointer-events thumbnail reorder ----------
  var suppressClick = false, dragActive = false;
  // block page scroll while a touch drag is in flight (touch-action can't change mid-gesture)
  document.addEventListener('touchmove', function (e) { if (dragActive) e.preventDefault(); }, { passive: false });
  // a text selection elsewhere on the page (say the intro copy, or Ctrl+A) would turn a
  // thumb drag into a NATIVE drag of that selection — the browser fires pointercancel and
  // the reorder silently dies. Never let a native drag start inside the grid.
  grid.addEventListener('dragstart', function (e) { e.preventDefault(); });

  function thumbPointerDown(e, t, idx) {
    if (busy) return;
    if (e.button != null && e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('.pt-thumb__act')) return;
    var coarse = e.pointerType === 'touch' || e.pointerType === 'pen';
    var pid = e.pointerId, sx = e.clientX, sy = e.clientY;
    var pg0 = pages[idx];   // capture the page OBJECT — pages[] can be replaced mid-drag
    var engaged = false, timer = 0, curOver = null, insBefore = false;

    function engage() {
      engaged = true; dragActive = true; suppressClick = true;
      t.classList.add('pt-thumb--drag');
      try { t.setPointerCapture(pid); } catch (er) {}
    }
    if (coarse) timer = setTimeout(engage, 350);   // long-press to drag, so scrolling still works

    function clearOver() {
      if (curOver) { curOver.classList.remove('pt-thumb--before'); curOver.classList.remove('pt-thumb--after'); curOver = null; }
    }
    function cleanup() {
      clearTimeout(timer); clearOver(); dragActive = false;
      t.classList.remove('pt-thumb--drag');
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    }
    function mv(ev) {
      if (ev.pointerId !== pid) return;
      var dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!engaged) {
        if (coarse) { if (Math.abs(dx) + Math.abs(dy) > 10) cleanup(); return; }   // it's a scroll
        if (Math.abs(dx) + Math.abs(dy) > 6) engage(); else return;
      }
      if (ev.cancelable) ev.preventDefault();
      var el = document.elementFromPoint(ev.clientX, ev.clientY);
      var over = el && el.closest ? el.closest('.pt-thumb') : null;
      clearOver();
      if (over && over !== t) {
        var r = over.getBoundingClientRect();
        insBefore = (ev.clientX - r.left) < r.width / 2;
        over.classList.add(insBefore ? 'pt-thumb--before' : 'pt-thumb--after');
        curOver = over;
      }
    }
    function up(ev) {
      if (ev.pointerId !== pid) return;
      var target = curOver, before = insBefore, was = engaged;
      cleanup();
      // a click (if the browser fires one) runs before timeouts, so this only clears
      // a stuck flag when NO click follows the drag
      if (was) setTimeout(function () { suppressClick = false; }, 0);
      if (!was || !target) return;
      // pages[] may have been replaced under this drag (an undo re-renders the grid) —
      // re-find the grabbed page by identity and no-op if it's gone; the drop target's
      // dataset.idx may also belong to a re-rendered grid, so bounds-check it too
      // (same capture-the-object pattern the editor drags use)
      var from = pages.indexOf(pg0);
      var to = parseInt(target.dataset.idx, 10) + (before ? 0 : 1);
      if (from < 0 || isNaN(to) || to < 0 || to > pages.length || to === from || to === from + 1) return;
      snapshot('move page ' + (from + 1));
      var moved = pages.splice(from, 1)[0];
      var insertAt = from < to ? to - 1 : to;
      pages.splice(insertAt, 0, moved);
      lastSelIdx = -1;
      orderChanged(); renderGrid(); updateToolbar();
      setStatus('Moved page ' + (from + 1) + ' to position ' + (insertAt + 1) + '.');
    }
    function cancel(ev) {
      if (ev.pointerId !== pid) return;
      var was = engaged;
      cleanup();
      // mirror up(): a pointercancel after the drag engaged (second finger, pinch) must
      // not leave suppressClick armed — it would eat the next tap on any thumbnail
      if (was) setTimeout(function () { suppressClick = false; }, 0);
    }
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }

  function selectedIdx() {
    var out = []; pages.forEach(function (p, i) { if (p.sel) out.push(i); }); return out;
  }

  // ---------- page-range input ----------
  function rangeState() {
    var v = rangeInput ? rangeInput.value.trim() : '';
    if (!v) return { empty: true, idx: null };
    return { empty: false, idx: PURE.parsePageRange(v, pages.length) };
  }
  // pages to act on for the "Download selected" button: a VALID, non-empty range
  // overrides the thumbnail selection; an EMPTY box or one that could not be parsed both
  // fall back to the selection — an invalid range must not strand selected thumbnails
  function extractIdx() {
    var st = rangeState();
    return (st.idx && st.idx.length) ? st.idx : selectedIdx();
  }
  function updateRangeInfo() {
    if (!rangeInfo) return;
    var st = rangeState();
    if (st.empty) { rangeInfo.textContent = ''; rangeInfo.title = ''; rangeInfo.classList.remove('pt-range-info--bad'); }
    else if (st.idx) { rangeInfo.textContent = '→ ' + st.idx.length + ' page' + (st.idx.length > 1 ? 's' : ''); rangeInfo.title = ''; rangeInfo.classList.remove('pt-range-info--bad'); }
    else {
      rangeInfo.textContent = 'not a valid range';
      rangeInfo.title = 'This range could not be read, so the buttons use the pages selected in the grid instead. Try something like 1-5, 9, 12-';
      rangeInfo.classList.add('pt-range-info--bad');
    }
  }
  if (rangeInput) rangeInput.addEventListener('input', function () { updateRangeInfo(); updateToolbar(); });

  function updateToolbar() {
    var has = pages.length > 0, sel = selectedIdx().length;
    if (toolbar) toolbar.hidden = !has && docs.length === 0;
    if (has && toolbar) toolbar.hidden = false;
    if (tipEl) tipEl.hidden = !has;
    // "none selected" is the state most of the toolbar is disabled FOR — say it, rather
    // than leaving the count silent about why Rotate/Delete are greyed out
    if (countEl) countEl.textContent = has ? (pages.length + ' page' + (pages.length > 1 ? 's' : '') + (sel ? ', ' + sel + ' selected' : ', none selected')) : '';
    if (btnEditPage) btnEditPage.disabled = !has;
    if (btnRotate) btnRotate.disabled = sel === 0;
    if (btnRotCcw) btnRotCcw.disabled = sel === 0;
    if (btnDup) btnDup.disabled = sel === 0;
    if (btnDelete) btnDelete.disabled = sel === 0;
    if (btnBlank) btnBlank.disabled = false;
    // a disabled button explains itself: the tooltip says what to do first, not just
    // what the button would have done
    if (btnRotate) btnRotate.title = sel ? 'Rotate selected pages 90° clockwise' : 'Select pages first, then rotate them 90° clockwise';
    if (btnRotCcw) btnRotCcw.title = sel ? 'Rotate selected pages 90° counterclockwise' : 'Select pages first, then rotate them 90° counterclockwise';
    if (btnDup) btnDup.title = sel ? 'Duplicate selected pages' : 'Select pages first, then duplicate them';
    if (btnDelete) btnDelete.title = sel ? 'Delete selected pages' : 'Select pages first, then delete them';
    if (btnUndo) {
      btnUndo.disabled = undoStack.size() === 0;
      var top = undoStack.peek();
      btnUndo.title = top ? ('Undo: ' + top.label + ' (Ctrl+Z)') : 'Undo (Ctrl+Z)';
    }
    var edUndo = $('pt-ed-undo');   // the page editor's own Undo button mirrors the stack
    if (edUndo) {
      edUndo.disabled = undoStack.size() === 0;
      var top2 = undoStack.peek();
      edUndo.title = top2 ? ('Undo: ' + top2.label + ' (Ctrl+Z)') : 'Undo (Ctrl+Z)';
    }
    var st = rangeState();
    if (btnExtract) {
      var exIdx = extractIdx();
      // busy keeps the export buttons disabled even when a mid-operation
      // renderGrid/updateToolbar runs (setBusy(false) re-runs this to restore them)
      btnExtract.disabled = exIdx.length === 0 || busy;
      // same verb as the main button, scope is the only difference: "Download all (12)"
      // vs "Download selected" / "Download 3 pages" (selection or the typed range)
      btnExtract.textContent = exIdx.length ? ('Download ' + exIdx.length + ' page' + (exIdx.length > 1 ? 's' : '')) : 'Download selected';
      btnExtract.title = exIdx.length
        ? 'Download ONLY those pages as their own PDF. The document here stays as it is.'
        : 'Select pages (or type a range in the Pages box) first, then download just those as their own PDF.';
    }
    // Split always has a fallback (the typed range, else the whole document), so an
    // invalid range must not disable it — only having zero pages at all should
    if (btnSplit) btnSplit.disabled = !has || busy;
    if (btnDownload) {
      btnDownload.disabled = !has || busy;
      btnDownload.textContent = has ? ('Download all (' + pages.length + ')') : 'Download all';
    }
    if (btnSelAll) btnSelAll.textContent = (sel === pages.length && pages.length > 0) ? 'Select none' : 'Select all';
    Array.prototype.forEach.call(document.querySelectorAll('[data-pt-needs-pages]'), function (b) { b.disabled = !has; });
    updateRangeInfo();   // the "→ N pages"/"invalid" label must re-validate when the page count changes
  }

  // ---------- toolbar actions ----------
  btnAdd.addEventListener('click', function () { if (!busy) fileInput.click(); });
  // the editor used to be reachable only by double-click or the small ✎ on a thumbnail —
  // this opens the first selected page, else page 1
  if (btnEditPage) btnEditPage.addEventListener('click', function () {
    if (busy || !pages.length) return;
    var sel = selectedIdx();
    if (window.__PT && window.__PT.openEditor) window.__PT.openEditor(sel.length ? sel[0] : 0);
  });
  fileInput.addEventListener('change', function () { addFiles(fileInput.files); fileInput.value = ''; });

  drop.addEventListener('click', function (e) { if (busy) return; if (pages.length === 0 && e.target === drop || e.target.classList.contains('pt-drop__hint') || (e.target.parentNode && e.target.parentNode.classList && e.target.parentNode.classList.contains('pt-drop__hint'))) fileInput.click(); });
  // keyboard path into the tool: the empty state has no other focusable "add" control
  drop.addEventListener('keydown', function (e) {
    if (busy) return;
    if ((e.key === 'Enter' || e.key === ' ') && pages.length === 0) { e.preventDefault(); fileInput.click(); }
  });
  ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); if (e.dataTransfer && Array.prototype.some.call(e.dataTransfer.types || [], function (t) { return t === 'Files'; })) drop.classList.add('pt-drop--over'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { if (ev === 'dragleave' && e.target !== drop) return; drop.classList.remove('pt-drop--over'); }); });
  drop.addEventListener('drop', function (e) { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
  // while busy the drop zone is pointer-events:none, so a drop would land on the document
  // and NAVIGATE the tab to the file — losing the whole session. Catch it here instead
  // (addFiles then explains it's busy, or just adds the files anywhere on the page).
  document.addEventListener('dragover', function (e) { e.preventDefault(); });
  document.addEventListener('drop', function (e) {
    e.preventDefault();
    if (!(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length)) return;
    // while the full-screen editor is open, offer it the drop first (e.g. an image
    // dropped on the Sign tool becomes the signature, not a surprise appended page)
    var edEl = $('pt-ed');
    if (edEl && !edEl.hidden && window.__PT && window.__PT.onEditorDrop &&
        window.__PT.onEditorDrop(e.dataTransfer.files)) return;
    addFiles(e.dataTransfer.files);
  });

  btnSelAll.addEventListener('click', function () {
    if (busy) return;
    var all = selectedIdx().length === pages.length && pages.length > 0;
    pages.forEach(function (p) { p.sel = !all; });
    refreshSel();
  });
  function rotateSelected(delta, label) {
    if (busy) return;
    var sel = selectedIdx(); if (!sel.length) return;
    setBusy(true);
    // Wpt/Hpt (to measure each page's text boxes) may need an async pdf.js call for a
    // live vector page — collect them all BEFORE mutating anything
    Promise.all(sel.map(function (i) { return effPointSize(pages[i]); })).then(function (sizes) {
      snapshot(label + ' ' + sel.length + ' page' + (sel.length > 1 ? 's' : ''));
      sel.forEach(function (i, k) {
        var pg = pages[i], sz = sizes[k];
        pg.rot = (pg.rot + delta) % 360;
        pg.redacts = PURE.rotateRects(pg.redacts, delta);   // boxes + OCR words +
        pg.whiteouts = PURE.rotateRects(pg.whiteouts, delta);
        pg.ocrWords = PURE.rotateWords(pg.ocrWords, delta); // text/sig annotations
        pg.texts = PURE.rotateTexts(pg.texts, delta, textBoxes(pg.texts, sz.w, sz.h), sz.w, sz.h); // all
        pg.sigs = PURE.rotateSigs(pg.sigs, delta);          // follow the content
        markDirty(pg);
      });
      renderGrid();
      setStatus('Rotated ' + sel.length + ' page' + (sel.length > 1 ? 's' : '') + '.');
    }).then(function () { setBusy(false); });
  }
  btnRotate.addEventListener('click', function () { rotateSelected(90, 'rotate'); });
  if (btnRotCcw) btnRotCcw.addEventListener('click', function () { rotateSelected(270, 'rotate'); });
  btnDelete.addEventListener('click', function () {
    if (busy) return;
    var n = selectedIdx().length; if (!n) return;
    snapshot('delete ' + n + ' page' + (n > 1 ? 's' : ''));
    pages = pages.filter(function (p) { return !p.sel; });
    lastSelIdx = -1;
    orderChanged(); renderGrid(); updateToolbar();
    setStatus('Deleted ' + n + ' page' + (n > 1 ? 's' : '') + '.');
  });
  if (btnDup) btnDup.addEventListener('click', function () {
    if (busy) return;
    var sel = selectedIdx(); if (!sel.length) return;
    snapshot('duplicate ' + sel.length + ' page' + (sel.length > 1 ? 's' : ''));
    for (var k = sel.length - 1; k >= 0; k--) {
      var i = sel[k];
      var copy = PURE.clonePage(pages[i]);
      copy.sel = false;
      pages.splice(i + 1, 0, copy);
    }
    lastSelIdx = -1;
    orderChanged(); renderGrid(); updateToolbar();
    setStatus('Duplicated ' + sel.length + ' page' + (sel.length > 1 ? 's' : '') + '.');
  });
  if (btnBlank) btnBlank.addEventListener('click', function () {
    if (busy) return;
    var sel = selectedIdx();
    var selPages = sel.map(function (i) { return pages[i]; });   // capture the OBJECTS, not
                                                                  // indices — the await below
                                                                  // is a gap another action
                                                                  // could otherwise splice into
    setBusy(true);
    var sizeP = sel.length ? effPointSize(pages[sel[0]]) : Promise.resolve({ w: 595.28, h: 841.89 });   // A4 default
    sizeP.then(function (sz) {
      // re-validate after the await: setBusy(true) should already block a concurrent
      // Delete/Ctrl+Z, but re-find the selection by identity anyway rather than trust a
      // captured index that may no longer point at the same page
      var lastSel = -1;
      selPages.forEach(function (p) {
        var at2 = pages.indexOf(p);
        if (at2 > lastSel) lastSel = at2;
      });
      snapshot('insert blank page');
      var pg = newPage(-1, -1);
      pg.blank = { wPt: sz.w, hPt: sz.h };
      var at = lastSel >= 0 ? lastSel + 1 : pages.length;
      pages.splice(at, 0, pg);
      lastSelIdx = -1;
      orderChanged(); renderGrid(); updateToolbar();
      setStatus('Inserted a blank page at position ' + (at + 1) + '.');
    }).catch(function () {
      setStatus('Could not insert a blank page.', 'err');
    }).then(function () { setBusy(false); });
  });
  if (btnUndo) btnUndo.addEventListener('click', undo);

  // Ctrl/Cmd+Z anywhere on the page (outside the editor, inputs, and dialogs)
  document.addEventListener('keydown', function (e) {
    if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      var ed = $('pt-ed'); if (ed && !ed.hidden) return;
      if (modalOpen()) return;
      // an undo would re-render the grid under an in-flight reorder; preventDefault so the
      // browser's NATIVE undo can't replay edits into a stale editor contenteditable instead
      if (dragActive) { e.preventDefault(); return; }
      var a = document.activeElement;
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
      // no focused input here, so native undo has no legit target — suppress it (same
      // stale-contenteditable hazard) even when there is nothing to app-undo
      if (busy || !undoStack.size()) { e.preventDefault(); return; }
      e.preventDefault();
      undo();
    } else if (e.key === 'Escape') {
      // consume the event when it dismisses the password modal — the editor's own
      // document-level keydown fires next on the SAME event, and its modalOpen() check
      // would see the just-hidden modal and run a staged Escape (closing the editor)
      if (passResolve) { e.preventDefault(); e.stopImmediatePropagation(); passDone(null); return; }
      var ed2 = $('pt-ed'); if (ed2 && !ed2.hidden) return;   // the editor handles its own Escape
      var m = document.querySelector('.pt-modal:not([hidden])');
      if (m) closeDialog(m);
    } else if (e.key === 'Tab') {
      // focus trap for any open modal — without it Tab wanders into the obscured page
      // (theme toggle, chat widget) behind the backdrop
      var mm = document.querySelector('.pt-modal:not([hidden])');
      if (mm) {
        var f = Array.prototype.filter.call(mm.querySelectorAll('button, input, select, textarea, [tabindex]'), function (el) {
          return !el.disabled && !el.hidden && el.tabIndex >= 0 && el.getClientRects().length;
        });
        if (f.length) {
          var fi = f.indexOf(document.activeElement);
          if (e.shiftKey) { if (fi <= 0) { e.preventDefault(); f[f.length - 1].focus(); } }
          else if (fi === -1 || fi === f.length - 1) { e.preventDefault(); f[0].focus(); }
        }
      }
    }
  });

  // warn before a reflexive F5 / tab close discards a whole editing session — all state
  // is in-memory only. Checking live state in the handler avoids add/remove bookkeeping.
  window.addEventListener('beforeunload', function (e) {
    if (pages.length) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- build / download ----------
  // pdf-lib reads an encrypted PDF (ignoreEncryption) but cannot decrypt it, so its pages
  // would copy as garbage. The vendored qpdf (PT.qpdfDecrypt, pdftools-tools.js) decrypts
  // the source ONCE, with the password pdf.js accepted ('' for a file that has only an
  // owner password, which opens without asking), and the plain bytes replace d.bytes, so
  // every later build copies vector pages. Any failure (the engine cannot load, qpdf reads
  // the password differently, the output is still encrypted) hands back the encrypted
  // doc, and copyBatch rasterizes its pages as before: the raster route stays for files
  // that cannot be decrypted or are damaged.
  function decryptedLibDoc(d, encDoc) {
    var dec = window.__PT && window.__PT.qpdfDecrypt;
    if (!dec || !d.bytes) return encDoc;
    if (!d.decrypting) d.decrypting = dec(d.bytes, d.pw || '').then(null, function (e) {
      if (window.console) console.warn('pdftools: could not decrypt ' + d.name + '; its pages will be flattened to images', e);
      return null;
    });
    return d.decrypting.then(function (plain) {
      if (!plain) return encDoc;
      return PDFLib.PDFDocument.load(plain, { ignoreEncryption: true }).then(function (doc) {
        if (doc.isEncrypted) { d.decrypting = Promise.resolve(null); return encDoc; }
        if (d.bytes) { d.bytes = plain; d.pw = null; }
        return doc;
      }, function () { d.decrypting = Promise.resolve(null); return encDoc; });
    });
  }

  function getLibDoc(cache, docIndex) {
    if (cache[docIndex]) return cache[docIndex];
    var d = docs[docIndex];
    if (!d || !d.bytes) return (cache[docIndex] = Promise.reject(new Error('source PDF is no longer available')));   // tombstoned by pruneDocs
    cache[docIndex] = PDFLib.PDFDocument.load(d.bytes, { ignoreEncryption: true }).then(function (doc) {
      return doc.isEncrypted ? decryptedLibDoc(d, doc) : doc;
    }).then(function (doc) {
      // apply any filled form values, then flatten so the values bake into page content
      if (d.formValues && Object.keys(d.formValues).length) {
        try {
          var form = doc.getForm();
          Object.keys(d.formValues).forEach(function (name) {
            var val = d.formValues[name];
            try {
              var f = form.getField(name); var ty = fieldType(f);
              if (ty === 'text') f.setText(val == null ? '' : String(val));
              else if (ty === 'checkbox') { if (val) f.check(); else f.uncheck(); }
              else if ((ty === 'select' || ty === 'radio') && val != null && val !== '') {
                /* pdf.js reports a radio widget's appearance-state name (a bare index
                   like "1" for /Opt-based groups, e.g. ones created by pdf-lib), while
                   pdf-lib select() wants the export value ("chocolate") — when a direct
                   select fails, map an integer state through getOptions() */
                var sv = String(val);
                try { f.select(sv); }
                catch (e3) {
                  var opts = (typeof f.getOptions === 'function') ? f.getOptions() : null;
                  var oi = parseInt(sv, 10);
                  if (opts && oi >= 0 && oi < opts.length && String(oi) === sv) f.select(String(opts[oi]));
                }
              }
            } catch (e2) {
              lastFormFailed++;
              if (window.console) console.warn('pdftools: form field "' + name + '" could not be filled.', e2);
            }
          });
          form.flatten();
        } catch (e) {}
      }
      return doc;
    });
    return cache[docIndex];
  }

  // standard faces offered by the text tool (built into pdf-lib, nothing is downloaded):
  // three families x {regular, bold, italic, bold italic}. Looked up by the FACE key
  // PURE.faceKey builds, whose plain face is the bare family name, so a legacy box still
  // embeds exactly one font and shares Helvetica with the watermark/number/OCR path.
  var STD_FONTS = {
    'Helvetica': { r: PDFLib.StandardFonts.Helvetica, b: PDFLib.StandardFonts.HelveticaBold,
                   i: PDFLib.StandardFonts.HelveticaOblique, bi: PDFLib.StandardFonts.HelveticaBoldOblique },
    'Times': { r: PDFLib.StandardFonts.TimesRoman, b: PDFLib.StandardFonts.TimesRomanBold,
               i: PDFLib.StandardFonts.TimesRomanItalic, bi: PDFLib.StandardFonts.TimesRomanBoldItalic },
    'Courier': { r: PDFLib.StandardFonts.Courier, b: PDFLib.StandardFonts.CourierBold,
                 i: PDFLib.StandardFonts.CourierOblique, bi: PDFLib.StandardFonts.CourierBoldOblique }
  };
  function stdFontFor(faceKey) {
    var parts = String(faceKey || '').split('|');
    var fam = STD_FONTS[PURE.textFamily(parts[0])];
    var fl = parts[1] || '';
    var b = fl.indexOf('b') >= 0, i = fl.indexOf('i') >= 0;
    return (b && i) ? fam.bi : b ? fam.b : i ? fam.i : fam.r;
  }
  function hexToRgb(h) {
    h = (h || '#111111').replace('#', ''); if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 };
  }

  // the visible box of an output page in points: its CropBox clipped to its MediaBox (the
  // box pdf.js renders, so the frame every preview and every normalized rect is in).
  // Falls back to 0, 0, info.w, info.h.
  function visibleBox(info) {
    try {
      var cb = info.page.getCropBox(), mb = info.page.getMediaBox();
      var x0 = Math.max(cb.x, mb.x), y0 = Math.max(cb.y, mb.y);
      var x1 = Math.min(cb.x + cb.width, mb.x + mb.width), y1 = Math.min(cb.y + cb.height, mb.y + mb.height);
      if (x1 > x0 && y1 > y0 && isFinite(x0) && isFinite(y0)) return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    } catch (e) {}
    return { x: 0, y: 0, w: info.w, h: info.h };
  }

  // draw a page's watermarks, signature images, text annotations, invisible OCR words,
  // and page number on the just-added output page. Rotation-0 math — pages that carry
  // overlays are always made effective-rotation-0 first (ensureUpright / bake); white-outs
  // are the one exception, mapped through the page's /Rotate instead (below).
  // Everything is placed on the VISIBLE box (the CropBox inside the MediaBox, the page
  // pdf.js previews): for an ordinary page that box is exactly 0, 0, info.w, info.h and
  // every number drawn is bitwise what it was.
  function drawOverlays(out, info, pg, fontCache, outIdx, outTotal) {
    var chain = Promise.resolve();
    var vb = visibleBox(info);
    function helv() {
      return Promise.resolve(fontCache.Helvetica || (fontCache.Helvetica = out.embedFont(PDFLib.StandardFonts.Helvetica)));
    }
    // white-outs FIRST, under everything else the export adds (watermarks, page numbers,
    // texts, signatures): the order every canvas painter uses. A page that was baked or
    // rasterized here (info.painted) already carries them in its image, under the
    // redaction boxes, and drawing them again on top would cover those boxes.
    // A white-out alone never flattens a page: on an output page that carries a /Rotate
    // (the user's turn or the file's own) the rects, kept in the EFFECTIVE frame, are
    // turned back into the page's unrotated frame, so the box lands on the right content
    // and the page keeps its vector text.
    if (hasWhiteouts(pg) && !info.painted) {
      chain = chain.then(function () {
        var rot = 0;
        try { rot = ((info.page.getRotation().angle % 360) + 360) % 360; } catch (er) {}
        var rects = rot ? PURE.rotateRects(pg.whiteouts, 360 - rot) : pg.whiteouts;
        PURE.drawWhiteouts(PDFLib, info.page, rects, vb.w, vb.h, vb.x, vb.y);
      }).catch(function (e) { if (window.console) console.warn('pdftools: a white-out could not be drawn.', e); });
    }
    (pg.wms || []).forEach(function (wm) {
      chain = chain.then(function () {
        return helv().then(function (font) {
          // drawWatermark falls back to the WinAnsi-encodable remainder itself and
          // reports whether characters had to be dropped — surface that in the status
          if (PURE.drawWatermark(PDFLib, info.page, font, wm, vb.w, vb.h, vb.x, vb.y)) lastDropped++;
        }).catch(function (e) { lastDropped++; if (window.console) console.warn('pdftools: a watermark could not be drawn.', e); });
      });
    });
    // page number BEFORE texts/sigs: every preview (drawMarks in thumbnails, Shrink,
    // Pages→images, the editor) paints the number under overlapping annotations, so
    // the export must stack the same way
    if (pageNums) {
      chain = chain.then(function () {
        return helv().then(function (font) { PURE.drawPageNum(PDFLib, info.page, font, pageNums, outIdx, outTotal, vb.w, vb.h, vb.x, vb.y); })
          .catch(function (e) { if (window.console) console.warn('pdftools: a page number could not be drawn.', e); });
      });
    }
    (pg.texts || []).forEach(function (t) {
      chain = chain.then(function () {
        var lay = textLayout(t, vb.w, vb.h);
        // the box's own family is embedded for every box, exactly as before this build,
        // then any bold/italic face the runs actually use, in draw order
        var keys = [lay.family];
        lay.lines.forEach(function (ln) {
          ln.runs.forEach(function (f) { if (f.text && keys.indexOf(f.fontKey) < 0) keys.push(f.fontKey); });
        });
        var loads = keys.map(function (k) {
          var fp = fontCache[k] || (fontCache[k] = out.embedFont(stdFontFor(k)));
          return Promise.resolve(fp).then(function (font) { return [k, font]; });
        });
        return Promise.all(loads).then(function (list) {
          var fonts = {};
          list.forEach(function (e) { fonts[e[0]] = e[1]; });
          var size = lay.size, lh = lay.lh, dropped = false;
          var bx = vb.x + t.x * vb.w, byTop = vb.y + (vb.h - t.y * vb.h);
          // highlight rectangles first, BEHIND the glyphs: multiply with NO opacity key,
          // so no alpha is written into the graphics state and black text stays black
          // even in a viewer that ignores /BM. Adjacent fragments sharing a highlight
          // colour were merged into one rectangle at layout time (pdf-lib allocates a
          // new ExtGState and resource name for every rectangle it draws).
          lay.lines.forEach(function (ln) {
            ln.hls.forEach(function (r) {
              var hc = hexToRgb(r.c);
              try {
                info.page.drawRectangle({
                  x: bx + r.x, y: byTop - (r.y + r.h), width: r.w, height: r.h,
                  color: PDFLib.rgb(hc.r, hc.g, hc.b), blendMode: PDFLib.BlendMode.Multiply
                });
              } catch (eh) { /* a highlight must never cost the text under it */ }
            });
          });
          // one drawText per run FRAGMENT per line, and a fragment never contains a
          // newline (pdf-lib would lay the remainder out at its own line height).
          // For a legacy box this is exactly one call per non-empty line with the same
          // arguments as before: no maxWidth, no lineHeight, no opacity, no blend mode.
          lay.lines.forEach(function (ln) {
            var y = byTop - size * 0.82 - ln.i * size * lh;
            ln.runs.forEach(function (f) {
              if (f.drop) dropped = true;
              if (!f.text) return;
              var fc = hexToRgb(f.c);
              var opts = { x: bx + f.x, y: y, size: size, font: fonts[f.fontKey], color: PDFLib.rgb(fc.r, fc.g, fc.b) };
              // per-fragment try: one unencodable char (emoji, CJK) must not silently
              // drop this fragment AND every fragment after it. sanitizeRun does not
              // trim, so the fragments that follow do not shift left.
              try { info.page.drawText(f.text, opts); }
              catch (e0) {
                dropped = true;
                var clean = PURE.sanitizeRun(f.text);
                try { if (clean) info.page.drawText(clean, opts); } catch (e1) {}
              }
            });
          });
          lay.lines.forEach(function (ln) {
            ln.decs.forEach(function (d) {
              var dc = hexToRgb(d.c);
              try {
                info.page.drawLine({
                  start: { x: bx + d.x, y: byTop - d.y }, end: { x: bx + d.x + d.w, y: byTop - d.y },
                  thickness: d.thickness, color: PDFLib.rgb(dc.r, dc.g, dc.b)
                });
              } catch (ed) { /* an underline must never cost the text it sits under */ }
            });
          });
          if (dropped) lastDropped++;
        }).catch(function (e) { lastDropped++; if (window.console) console.warn('pdftools: a text box could not be drawn.', e); });
      });
    });
    // signatures AFTER texts: the editor, thumbnails, and Shrink/images previews all
    // stack a signature on top of overlapping text, so the export must match
    (pg.sigs || []).forEach(function (sig) {
      chain = chain.then(function () {
        return out.embedPng(sig.png).then(function (img) {
          info.page.drawImage(img, { x: vb.x + sig.x * vb.w, y: vb.y + (vb.h - (sig.y + sig.h) * vb.h), width: sig.w * vb.w, height: sig.h * vb.h });
        }).catch(function (e) {
          lastSigFailed++;
          if (window.console) console.warn('pdftools: a signature could not be drawn.', e);
        });
      });
    });
    if (pg.ocrWords && pg.ocrWords.length) {
      chain = chain.then(function () {
        // never let the invisible text layer resurrect redacted content (whole words), nor
        // carry the characters a white-out covers (what is selectable should match what is
        // seen; the file's own text under a white-out is untouched)
        var words = PURE.cutCovered(PURE.filterOcrWords(pg.ocrWords, pg.redacts), pg.whiteouts, metricsTable);
        return helv().then(function (font) { PURE.drawOcrWords(PDFLib, info.page, font, words, vb.w, vb.h, vb.x, vb.y); })
          .catch(function (e) { if (window.console) console.warn('pdftools: the OCR text layer could not be drawn.', e); });
      });
    }
    return chain;
  }

  // last-resort: render a page to an image and add it as an image-only page, so a page
  // pdf-lib can't copy (odd/edge-case source PDFs) still makes it into the output
  function rasterFallback(out, pg) {
    return effPointSize(pg).then(function (sz) {
      return renderPageCanvas(pg, Math.max(1, sz.w * 150 / 72)).then(function (r) {
        var c = document.createElement('canvas'); c.width = r.canvas.width; c.height = r.canvas.height;
        var cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height); cx.drawImage(r.canvas, 0, 0);
        r.canvas.width = 0;   // free the intermediate canvas
        return paintFormValues(c, pg).then(function () {
          paintWhiteouts(cx, pg, c.width, c.height);
          paintRedacts(cx, pg, c.width, c.height);   // after the values, so a box can black out a filled field
          return canvasToBytes(c, 'image/jpeg', 0.85);
        }).then(function (jpg) {
          c.width = 0;   // free the canvas
          return out.embedJpg(jpg).then(function (img) {
            var p = out.addPage([sz.w, sz.h]); p.drawImage(img, { x: 0, y: 0, width: sz.w, height: sz.h });
            return { page: p, w: sz.w, h: sz.h, painted: true };
          });
        });
      });
    });
  }

  // flatten a page into the output as a high-quality JPEG image page at `dpi`, with its
  // redaction boxes painted on. This is where redaction actually happens: boxes live as
  // annotations while editing (cheap, fully undoable, no quality loss no matter how many
  // are drawn) and the page is rasterized exactly ONCE, here, on download.
  // JPEG (q 0.92), not PNG: the page is opaque (white composited under), and pdf-lib's
  // PNG embedder decodes to raw RGBA channel buffers held until save() — ~7 MB of heap
  // PER redacted page (a 60-page redacted export peaked past 400 MB). embedJpg stores
  // the compressed bytes as-is, so peak memory stays flat.
  function bakedPage(out, pg, dpi) {
    return effPointSize(pg).then(function (sz) {
      var scale = Math.min(dpi / 72, 4000 / sz.w, 4000 / sz.h);   // stay inside canvas limits
      var effDpi = scale * 72;
      // an oversized page silently rendered at a lower DPI than requested must be
      // disclosed, not just quietly downgraded
      if (effDpi < dpi - 0.5) {
        lastDpiCapped++;
        lastDpiFloor = lastDpiFloor ? Math.min(lastDpiFloor, effDpi) : effDpi;
      }
      return renderPageCanvas(pg, Math.max(1, sz.w * scale)).then(function (r) {
        // copy into a fresh identity-transform canvas before painting the boxes —
        // the same belt-and-suspenders compress() and rasterFallback() use, so a
        // dirty context on the render canvas can never displace a redaction
        var c = document.createElement('canvas'); c.width = r.canvas.width; c.height = r.canvas.height;
        var cx = c.getContext('2d'); cx.drawImage(r.canvas, 0, 0);
        r.canvas.width = 0;   // free the intermediate canvas
        return paintFormValues(c, pg).then(function () {
          paintWhiteouts(cx, pg, c.width, c.height);
          paintRedacts(cx, pg, c.width, c.height);   // after the values, so a box can black out a filled field
          cx.globalCompositeOperation = 'destination-over';
          cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
          cx.globalCompositeOperation = 'source-over';
          return canvasToBytes(c, 'image/jpeg', 0.92);
        }).then(function (jpg) {
          c.width = 0;   // free the canvas
          return out.embedJpg(jpg).then(function (img) {
            var p = out.addPage([sz.w, sz.h]);
            p.drawImage(img, { x: 0, y: 0, width: sz.w, height: sz.h });
            return { page: p, w: sz.w, h: sz.h, painted: true };
          });
        });
      });
    });
  }

  // The planner's shape rebuilt without it, for the fallback above: one call per source
  // document in first-appearance order, or (perPage) one call per page as a last resort.
  function simpleBatches(routes, perPage) {
    var order = [], byDoc = {}, flat = [];
    (routes || []).forEach(function (r, i) {
      if (!r || !r.copy) return;
      if (perPage) { flat.push({ docIndex: r.docIndex, indices: [r.pageIndex], slots: [i] }); return; }
      var d = r.docIndex;
      if (!byDoc[d]) { byDoc[d] = { docIndex: d, indices: [], slots: [] }; order.push(d); }
      byDoc[d].indices.push(r.pageIndex);
      byDoc[d].slots.push(i);
    });
    return perPage ? flat : order.map(function (d) { return byDoc[d]; });
  }

  // Which of `indices` can pdf-lib not copy out of `src`? Every trial copy goes into a
  // SCRATCH document that is thrown away, so nothing a failed call registers can reach
  // the real output, and bisection means one damaged page in a 908-page document costs
  // about 20 trial calls instead of 908. A single index that throws is the bad one.
  function findBadCopies(src, indices) {
    function probe(list) {
      if (!list.length) return Promise.resolve([]);
      return PDFLib.PDFDocument.create().then(function (scratch) {
        return scratch.copyPages(src, list);
      }).then(function () { return []; }, function () {
        if (list.length === 1) return [list[0]];
        var mid = Math.floor(list.length / 2);
        return probe(list.slice(0, mid)).then(function (a) {
          return probe(list.slice(mid)).then(function (b) { return a.concat(b); });
        });
      });
    }
    return probe(indices.slice());
  }

  // pdf-lib writes EVERY registered object on save, whether or not a page points at it.
  // A copyPages call that throws PART WAY has already registered whatever it copied
  // before the throw, so those objects ride along in the export as orphans: one failure
  // on a deck page left a whole extra copy of the shared pile in the file (10.85x,
  // measured in _tests/pdftools/split-size/REVIEW.md major 1). Rather than make every
  // document pay for a scratch attempt, the real output is rolled back to the object
  // count it had before the call. Everything a copy registers goes through
  // PDFContext.register -> nextRef, so its object number is strictly above the mark and
  // nothing older can be swept up by this.
  function objMark(out) { return out.context.largestObjectNumber; }
  function rollbackObjects(out, mark) {
    var ctx = out.context, n = 0;
    ctx.enumerateIndirectObjects().forEach(function (entry) {
      if (entry[0].objectNumber > mark) { ctx.delete(entry[0]); n++; }
    });
    ctx.largestObjectNumber = mark;
    return n;
  }

  // Copy one source document's copy-route pages into `out`, in one call where that works.
  function copyBatch(out, cache, routes, b) {
    return Promise.resolve(getLibDoc(cache, b.docIndex)).then(function (src) {
      // pdf-lib loads encrypted PDFs (ignoreEncryption) but does NOT decrypt their streams,
      // so copyPages would copy encrypted garbage → blank/corrupt pages. getLibDoc has
      // already tried qpdf (decryptedLibDoc); a source still encrypted here is one that
      // could not be decrypted, and pdf.js renders it fine, so route it through the
      // rasterize fallback instead.
      // Decided ONCE per document, before any copy is attempted: one warning, no probing,
      // no trial copies for a document that is known not to be copyable.
      if (src && src.isEncrypted) {
        if (window.console) console.warn('pdftools: an encrypted source PDF cannot be copied; rasterizing its ' + b.slots.length + ' page(s) instead.');
        var encErr = new Error('encrypted source PDF; rasterizing to preserve content');
        b.slots.forEach(function (s) { routes[s].copyErr = encErr; });
        return null;
      }
      var mark = objMark(out);
      return out.copyPages(src, b.indices).then(function (cps) {
        // a repeated page rides in this same call, which is what keeps the export small;
        // the copies come back sharing one /Contents array, so split them apart before
        // pass two draws anything on them (PURE.unshareCopiedContents)
        PURE.unshareCopiedContents(PDFLib, out.context, cps);
        b.slots.forEach(function (s, k) {
          if (!cps || !cps[k]) routes[s].copyErr = new Error('copyPages returned no page');
          else routes[s].copied = cps[k];
        });
      }, function (e) {
        // one bad page must still only cost itself, and it must not cost the file its
        // size: drop whatever the failed call registered, find the uncopyable indices in
        // a throwaway document, then copy every good index in ONE call.
        if (window.console) console.warn('pdftools: a batched page copy failed; finding the page that cannot be copied.', e);
        rollbackObjects(out, mark);
        return findBadCopies(src, b.indices).then(function (bad) {
          var goodIdx = [], goodSlots = [];
          b.slots.forEach(function (s, k) {
            if (bad.indexOf(b.indices[k]) >= 0) routes[s].copyErr = e;
            else { goodIdx.push(b.indices[k]); goodSlots.push(s); }
          });
          if (!goodIdx.length) return null;
          var mark2 = objMark(out);
          return out.copyPages(src, goodIdx).then(function (cps) {
            PURE.unshareCopiedContents(PDFLib, out.context, cps);
            goodSlots.forEach(function (s, k) {
              if (!cps || !cps[k]) routes[s].copyErr = new Error('copyPages returned no page');
              else routes[s].copied = cps[k];
            });
          }, function (e2) {
            rollbackObjects(out, mark2);
            goodSlots.forEach(function (s) { routes[s].copyErr = e2; });
          });
        });
      });
    }, function (e) {
      // the source document is tombstoned or will not load at all: every page of it
      // takes the rasterize route, exactly as it did before
      b.slots.forEach(function (s) { routes[s].copyErr = e; });
      return null;
    }).catch(function (e) {
      // copyBatch NEVER rejects. A throw from anywhere in here (a copyPages that throws
      // synchronously instead of rejecting, a pdf-lib internal that blows up while the
      // copies are being handed back) must cost this document its copies and nothing
      // else: the batches for the other documents still run, and pass two rasterizes
      // these pages one at a time. The old per-page loop had this isolation for free.
      if (window.console) console.warn('pdftools: a source PDF could not be copied; its pages will be rasterized.', e);
      b.slots.forEach(function (s) { if (!routes[s].copied) routes[s].copyErr = e; });
      return null;
    });
  }

  // onTick(done, total) is awaited after each page so the progress bar can paint.
  // numMap ({idx:[gridIdx...], total:n}) keeps page NUMBERS at their grid positions for
  // Extract/Split subsets — the thumbnails preview them there, so the export must match.
  //
  // TWO PASSES since 2026-09. Pass one decides each page's route (bake / blank / raster /
  // copy) exactly as before and then copies all of a document's copy-route pages in ONE
  // out.copyPages() call; pass two adds the pages in page-list order and draws the
  // overlays. The split is not a refactor for tidiness: pdf-lib makes a fresh
  // PDFObjectCopier per copyPages() call, so calling it once per page re-copies every
  // shared font, image and master slide once per page. Splitting a 50 MB 908-slide deck
  // in two gave two 120 MB halves. See PURE.planCopyBatches.
  //
  // `sharedCache` (optional) is a getLibDoc cache owned by the CALLER. A caller that
  // loops (Split to zip calls buildPdf once per page) would otherwise re-parse the whole
  // source PDF for every page in the zip: a 908-page split of a 50 MB deck meant 908 full
  // PDFDocument.load calls. buildPdf owns a fresh cache when no caller supplies one.
  function buildPdf(pageList, onTick, numMap, sharedCache) {
    var cache = sharedCache || {}, fontCache = {}, failures = 0;
    lastFlattenedRot = 0; lastFlattenedSrc = 0; lastDropped = 0;
    lastSigFailed = 0; lastFormFailed = 0; lastDpiCapped = 0; lastDpiFloor = 0;
    return PDFLib.PDFDocument.create().then(function (out) {
      var routes = new Array(pageList.length);

      // ---- pass one, part A: route every page. No page is added to `out` yet.
      var plan = Promise.resolve();
      pageList.forEach(function (pg, i) {
        plan = plan.then(function () {
          // overlays (text/sigs/marks) are drawn with rotation-0 math; if the page was
          // rotated AFTER they were added, flatten it so the export matches the preview.
          // Empty text boxes (abandoned in the editor) draw nothing — they must never
          // trigger a flatten on their own.
          var overlaid = (pg.texts && pg.texts.some(function (t) { return (t.text || '').trim().length; })) ||
                         (pg.sigs && pg.sigs.length) ||
                         (pg.wms && pg.wms.length) || (pg.ocrWords && pg.ocrWords.length) || !!pageNums;
          var mustBakeP = hasRedacts(pg) ? Promise.resolve(true)
            : (!overlaid || pg.blank) ? Promise.resolve(false)
            : pageEffRotation(pg).then(function (r) { return r !== 0; });
          return mustBakeP.then(function (mustBake) {
            if (mustBake) {
              if (!hasRedacts(pg)) lastFlattenedRot++;
              routes[i] = { kind: 'bake' };
            } else if (pg.blank) {
              routes[i] = { kind: 'blank' };
            } else if (pg.raster) {
              routes[i] = { kind: 'raster' };
            } else {
              routes[i] = { kind: 'copy', copy: true, docIndex: pg.docIndex, pageIndex: pg.pageIndex };
            }
          }).catch(function (e) { routes[i] = { kind: 'fail', err: e }; });
        });
      });

      // ---- pass one, part B: ONE copyPages call per source document
      plan = plan.then(function () {
        // A throw in this shared step used to reject `plan`, which skips EVERY page's
        // .then, counts all N pages as failures and kills the export with "No pages
        // could be processed." The old per-page loop had no step that could do that, so
        // the planner call falls back to the same one-call-per-document shape and then
        // to one call per page, and the batch stage below swallows its own throw: a page
        // with no copy is rasterized by pass two, one page at a time, and costs one
        // failure, never all of them.
        var batches;
        try {
          batches = PURE.planCopyBatches(routes);
        } catch (e) {
          if (window.console) console.warn('pdftools: the copy planner failed; falling back to one call per source PDF.', e);
          try { batches = simpleBatches(routes, false); }
          catch (e2) {
            try { batches = simpleBatches(routes, true); } catch (e3) { batches = []; }
          }
        }
        var chain = Promise.resolve();
        batches.forEach(function (b) {
          chain = chain.then(function () { return copyBatch(out, cache, routes, b); });
        });
        return chain.catch(function (e) {
          if (window.console) console.warn('pdftools: the batched copy stage failed; any page it did not copy will be rasterized.', e);
        });
      });

      // ---- pass two: add the pages in page-list order and draw the overlays
      var chain = plan;
      pageList.forEach(function (pg, i) {
        chain = chain.then(function () {
          var r = routes[i] || { kind: 'fail' };
          if (r.kind === 'fail') throw (r.err || new Error('this page could not be prepared'));
          var added;
          if (r.kind === 'bake') {
            added = bakedPage(out, pg, hasRedacts(pg) ? redactDpi : 150);
          } else if (r.kind === 'blank') {
            var sw = (pg.rot % 180) !== 0;
            var bw = sw ? pg.blank.hPt : pg.blank.wPt, bh = sw ? pg.blank.wPt : pg.blank.hPt;
            var bp = out.addPage([bw, bh]);
            added = Promise.resolve({ page: bp, w: bw, h: bh });
          } else if (r.kind === 'raster') {
            // transcode the stored PNG to JPEG-on-white first: the page is opaque, and
            // pdf-lib's PNG embedder holds raw RGBA until save() (~7 MB per page — the
            // same blowup the redact bake avoids with embedJpg; page numbers flatten
            // EVERY rotated page this way, so a big scan would hit it at scale). If the
            // transcode fails, embed the PNG after all: correctness over memory.
            added = rasterPngToJpg(pg.raster.png)
              .then(function (jpg) { return out.embedJpg(jpg); },
                    function () { return out.embedPng(pg.raster.png); })
              .then(function (img) {
                var p = out.addPage([pg.raster.wPt, pg.raster.hPt]);
                p.drawImage(img, { x: 0, y: 0, width: pg.raster.wPt, height: pg.raster.hPt });
                if (pg.rot) { try { p.setRotation(PDFLib.degrees(((pg.rot % 360) + 360) % 360)); } catch (e) {} }
                return { page: p, w: pg.raster.wPt, h: pg.raster.hPt };
              });
          } else if (r.copied) {
            var cp = r.copied;
            if (pg.rot) {
              var base = (cp.getRotation && cp.getRotation().angle) || 0;
              cp.setRotation(PDFLib.degrees((base + pg.rot) % 360));
            }
            out.addPage(cp);
            var sz = cp.getSize();
            added = Promise.resolve({ page: cp, w: sz.width, h: sz.height });
          } else {
            if (window.console) console.warn('pdftools: could not copy a page, rasterizing it instead.', r.copyErr);
            lastFlattenedSrc++;
            added = rasterFallback(out, pg);
          }
          return added.then(function (info) {
            return drawOverlays(out, info, pg, fontCache,
              numMap ? numMap.idx[i] : i, numMap ? numMap.total : pageList.length);
          });
        }).catch(function (e) { failures++; if (window.console) console.warn('pdftools: a page failed and was skipped.', e); })
          .then(function () { return onTick ? onTick(i + 1, pageList.length) : null; });
      });
      return chain.then(function () { return applyMetadata(out, cache, pageList); }).then(function () {
        if (failures && out.getPageCount() === 0) throw new Error('No pages could be processed.');
        if (failures) setStatus(failures + ' page(s) could not be processed and were skipped.');
        return out.save();
      });
    });
  }

  // docs[] entries are tombstoned in place, never removed (docIndex is positional), so
  // docs[0] may belong to a file whose pages were ALL deleted — the export identity
  // (filename base, "-merged" suffix, carried-over metadata) must come from the source
  // docs that still have live pages, or a fully-deleted first file haunts the output.
  // `list` (an array of page objects, e.g. an Extract/Split/Pages-to-images subset)
  // scopes this to just those pages; omit it for whole-document operations (Download all).
  function liveDocIndices(list) {
    var seen = {}, out = [];
    (list || pages).forEach(function (p) {
      if (p.docIndex >= 0 && !seen[p.docIndex]) { seen[p.docIndex] = true; out.push(p.docIndex); }
    });
    return out.sort(function (a, b) { return a - b; });
  }

  function applyMetadata(out, cache, list) {
    if (chkStrip.checked) {
      out.setTitle(''); out.setAuthor(''); out.setSubject(''); out.setKeywords([]);
      out.setProducer(''); out.setCreator('');
      try { out.setCreationDate(new Date(0)); out.setModificationDate(new Date(0)); } catch (e) {}
      return Promise.resolve();
    }
    // not stripping: carry over title/author/subject from the first source doc that
    // still has live pages IN THIS EXPORT (best-effort; skip entirely if none — e.g. all
    // blank pages) — a subset export (Extract/Split) must not borrow another file's metadata
    var live = liveDocIndices(list);
    if (!live.length) return Promise.resolve();
    return Promise.resolve(getLibDoc(cache, live[0])).then(function (src) {
      try {
        if (src.getTitle && src.getTitle()) out.setTitle(src.getTitle());
        if (src.getAuthor && src.getAuthor()) out.setAuthor(src.getAuthor());
        if (src.getSubject && src.getSubject()) out.setSubject(src.getSubject());
      } catch (e) {}
    }).catch(function () {});
  }

  // `list` scopes the derived name to a subset export (Extract/Split/Pages-to-images);
  // omit it for whole-document operations, which keeps existing Download-all behavior.
  function exportName(kind, list) {
    var live = liveDocIndices(list);
    return PURE.deriveExportName(live.length ? docs[live[0]].name : '', live.length, kind);
  }

  function downloadBytes(bytes, name, mime) {
    var url = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/pdf' }));
    var a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function buildTick(verb) {
    return function (d, t) { return progress(d, t, verb + ' page ' + d + ' of ' + t + '…'); };
  }

  // a tiny PDF can finish building inside a double-click's gap, so the busy lock alone
  // still lets the second click start an identical second build — swallow re-clicks
  // that land within a second of the previous build finishing
  var lastDlDone = 0;
  btnDownload.addEventListener('click', function () {
    if (!pages.length || busy) return;
    if (Date.now() - lastDlDone < 1000) return;
    setBusy(true);
    progress(0, pages.length, 'Building PDF…');
    buildPdf(pages, buildTick('Building')).then(function (bytes) {
      var name = exportName('download');
      downloadBytes(bytes, name);
      setStatus('Saved ' + name + ' (' + fmtSize(bytes.length) + ').' + flattenNote(), flattenKind());
    }).catch(function (e) { setStatus('Error: ' + (e && e.message || e), 'err'); })
      .then(function () { lastDlDone = Date.now(); setBusy(false); });
  });

  btnExtract.addEventListener('click', function () {
    if (busy) return;
    var idxs = extractIdx();
    if (!idxs.length) return;
    setBusy(true);
    var list = idxs.map(function (i) { return pages[i]; });
    progress(0, list.length, 'Downloading ' + list.length + ' page' + (list.length > 1 ? 's' : '') + '…');
    buildPdf(list, buildTick('Downloading'), { idx: idxs, total: pages.length }).then(function (bytes) {
      var name = exportName('extract', list);
      downloadBytes(bytes, name);
      setStatus('Saved ' + name + ' (' + list.length + ' page' + (list.length > 1 ? 's' : '') + ', ' + fmtSize(bytes.length) + ').' + flattenNote(), flattenKind());
    }).catch(function (e) { setStatus('Error: ' + (e && e.message || e), 'err'); })
      .then(function () { setBusy(false); });
  });

  btnSplit.addEventListener('click', function () {
    if (!pages.length || busy) return;
    var st = rangeState();
    var idxs = (st.idx && st.idx.length) ? st.idx : pages.map(function (_, i) { return i; });
    if (!idxs.length) return;
    setBusy(true);
    var list = idxs.map(function (i) { return pages[i]; });
    // ONE getLibDoc cache for the whole zip: buildPdf builds its own per call, so a
    // 908-page split used to run PDFDocument.load on the same 50 MB deck 908 times.
    var splitCache = {};
    var files = [], splitFailed = 0; var chain = Promise.resolve();
    idxs.forEach(function (pi, k) {
      chain = chain.then(function () {
        return progress(k, idxs.length, 'Splitting page ' + (k + 1) + ' of ' + idxs.length + '…');
      }).then(function () {
        // one unprocessable page must not abort the whole zip — isolate it with its own
        // catch, same principle as buildPdf's own internal per-page isolation
        return buildPdf([pages[pi]], null, { idx: [pi], total: pages.length }, splitCache).then(function (bytes) {
          files.push({ name: 'page-' + String(pi + 1).padStart(3, '0') + '.pdf', data: bytes });
        }).catch(function (e) {
          splitFailed++;
          if (window.console) console.warn('pdftools: could not split out page ' + (pi + 1) + '.', e);
        });
      });
    });
    chain.then(function () {
      if (!files.length) { setStatus('No pages could be processed.', 'err'); return; }
      var zip = storeZip(files);
      var name = exportName('split', list);
      downloadBytes(zip, name, 'application/zip');
      var msg = 'Saved ' + name + ' (' + files.length + ' files, ' + fmtSize(zip.length) + ').';
      if (splitFailed) msg = 'Split ' + files.length + ' page' + (files.length === 1 ? '' : 's') + '; ' + splitFailed + ' could not be processed. ' + msg;
      setStatus(msg, splitFailed ? 'warn' : undefined);
    }).catch(function (e) { setStatus('Error: ' + (e && e.message || e), 'err'); })
      .then(function () { setBusy(false); });
  });

  function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(2) + ' MB'; }
  // per-cause notes, so the status never blames the wrong thing (an intrinsically-
  // rotated source page with page numbers on is neither "rotated by you" nor "damaged")
  function flattenNote() {
    var parts = [];
    if (lastFlattenedRot) parts.push(lastFlattenedRot + ' page(s) were flattened to images so added content (text, signatures, watermarks, or page numbers) renders correctly on rotated pages');
    if (lastFlattenedSrc) parts.push(lastFlattenedSrc + ' page(s) from an encrypted or damaged PDF were flattened to images');
    if (lastDropped) parts.push(lastDropped + ' added text/watermark item(s) contained characters the built-in PDF fonts can’t encode (like emoji or non-Latin scripts), so those characters were left out');
    if (lastSigFailed) parts.push(lastSigFailed + ' signature' + (lastSigFailed > 1 ? 's' : '') + ' could not be embedded');
    if (lastFormFailed) parts.push(lastFormFailed + ' form field' + (lastFormFailed > 1 ? 's' : '') + ' could not be filled');
    if (lastDpiCapped) parts.push(lastDpiCapped + ' page(s) were too large to flatten at the requested quality and were rendered smaller instead (about ' + Math.round(lastDpiFloor) + ' DPI)');
    return parts.length ? ' ' + parts.join('. ') + '.' : '';
  }
  // 'warn' when the build hit a real, disclosable problem (as opposed to routine,
  // expected flatten notes like a rotated page) — callers use this to style the status line
  function flattenKind() { return (lastSigFailed || lastFormFailed || lastDpiCapped) ? 'warn' : undefined; }

  // ---------- shared page-render helpers (used by sign / compress / redact-bake / OCR) ----------
  function canvasToBytes(canvas, type, quality) {
    return new Promise(function (res, rej) {
      canvas.toBlob(function (b) {
        if (!b) { rej(new Error('page too large to rasterize at this DPI')); return; }  /* toBlob yields null past the browser canvas limit */
        b.arrayBuffer().then(function (ab) { res(new Uint8Array(ab)); }, rej);
      }, type, quality);
    });
  }
  function effPointSize(pg) {
    var sw = (pg.rot % 180) !== 0;
    if (pg.blank) return Promise.resolve({ w: sw ? pg.blank.hPt : pg.blank.wPt, h: sw ? pg.blank.wPt : pg.blank.hPt });
    if (pg.raster) return Promise.resolve({ w: sw ? pg.raster.hPt : pg.raster.wPt, h: sw ? pg.raster.wPt : pg.raster.hPt });
    return docs[pg.docIndex].js.getPage(pg.pageIndex + 1).then(function (page) {
      var v1 = page.getViewport({ scale: 1, rotation: totalRotation(page, pg.rot) });
      return { w: v1.width, h: v1.height };
    });
  }
  function pageEffRotation(pg) {
    if (pg.blank) return Promise.resolve(0);
    if (pg.raster) return Promise.resolve(((pg.rot || 0) % 360 + 360) % 360);
    return docs[pg.docIndex].js.getPage(pg.pageIndex + 1).then(function (page) { return totalRotation(page, pg.rot); });
  }
  // render `pg` (raster, blank, or vector, at its effective rotation) to a canvas `targetPxWidth` wide.
  // opts.onTask (optional) receives the pdf.js RenderTask synchronously on the vector
  // branch, so a caller that supersedes a render (the editor's page nav) can cancel it —
  // export/bake callers pass no opts and must never be cancelled.
  function renderPageCanvas(pg, targetPxWidth, opts) {
    if (pg.blank) {
      var sw = (pg.rot % 180) !== 0;
      var bw = sw ? pg.blank.hPt : pg.blank.wPt, bh = sw ? pg.blank.wPt : pg.blank.hPt;
      var c0 = document.createElement('canvas');
      c0.width = Math.max(1, Math.round(targetPxWidth));
      c0.height = Math.max(1, Math.round(targetPxWidth * bh / bw));
      var b0 = c0.getContext('2d'); b0.fillStyle = '#fff'; b0.fillRect(0, 0, c0.width, c0.height);
      return Promise.resolve({ canvas: c0, wPt: bw, hPt: bh });
    }
    if (pg.raster) {
      var sw2 = (pg.rot % 180) !== 0;
      return rasterToCanvas(pg, targetPxWidth).then(function (c) {
        return { canvas: c, wPt: sw2 ? pg.raster.hPt : pg.raster.wPt, hPt: sw2 ? pg.raster.wPt : pg.raster.hPt };
      });
    }
    return docs[pg.docIndex].js.getPage(pg.pageIndex + 1).then(function (page) {
      var rot = totalRotation(page, pg.rot);
      var v1 = page.getViewport({ scale: 1, rotation: rot });
      var vp = page.getViewport({ scale: targetPxWidth / v1.width, rotation: rot });
      var c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      var task = page.render({ canvasContext: c.getContext('2d'), viewport: vp });
      if (opts && opts.onTask) opts.onTask(task);
      return task.promise.then(function () {
        return { canvas: c, wPt: v1.width, hPt: v1.height };
      });
    });
  }
  // flatten a page to an image in place (used to make a rotated page upright before
  // signing / adding text / watermarking / OCR)
  function bakePageToRaster(pg, dpi) {
    return effPointSize(pg).then(function (sz) {
      return renderPageCanvas(pg, Math.max(1, sz.w * dpi / 72)).then(function (r) {
        // fill-ins must survive the flatten (the raster page has no live fields afterwards)
        return paintFormValues(r.canvas, pg).then(function () {
          return canvasToBytes(r.canvas, 'image/png');
        }).then(function (png) {
          r.canvas.width = 0;   // free the canvas
          pg.raster = { png: png, wPt: sz.w, hPt: sz.h };
          pg.rot = 0; pg.blank = null;
          markDirty(pg);
          return pg;
        });
      });
    });
  }

  // paint the user's filled form values onto a rendered page canvas. Every rasterizing
  // path (redact bake, rotated-overlay bake, encrypted/damaged fallback, Shrink,
  // Pages→images, ensureUpright) renders via pdf.js, which draws the fields' stored
  // appearances but knows nothing about our unflattened fill-ins — without this the
  // values silently vanish from any flattened page. Reads formValues at call time, so
  // it always matches the undo state. convertToViewportRectangle handles rotation.
  function paintFormValues(canvas, pg) {
    if (pg.docIndex < 0 || pg.raster || pg.blank) return Promise.resolve();
    var d = docs[pg.docIndex];
    if (!d || !d.formValues || !Object.keys(d.formValues).length) return Promise.resolve();
    return d.js.getPage(pg.pageIndex + 1).then(function (page) {
      return page.getAnnotations().then(function (annots) {
        var rot = totalRotation(page, pg.rot);
        var v1 = page.getViewport({ scale: 1, rotation: rot });
        var vp = page.getViewport({ scale: canvas.width / v1.width, rotation: rot });
        var s = canvas.width / v1.width;
        var ctx = canvas.getContext('2d');
        annots.forEach(function (a) {
          if (a.subtype !== 'Widget' || !a.fieldName || !(a.fieldName in d.formValues) || !a.rect) return;
          var val = d.formValues[a.fieldName];
          if (val == null || val === '' || val === false) return;
          var r = vp.convertToViewportRectangle(a.rect);
          var x0 = Math.min(r[0], r[2]), y0 = Math.min(r[1], r[3]), w = Math.abs(r[2] - r[0]), h = Math.abs(r[1] - r[3]);
          ctx.save();
          ctx.fillStyle = '#111';
          if (a.fieldType === 'Btn' && a.radioButton) {
            if (String(val) === String(a.buttonValue)) {
              ctx.beginPath(); ctx.arc(x0 + w / 2, y0 + h / 2, Math.max(1.5, Math.min(w, h) * 0.28), 0, Math.PI * 2); ctx.fill();
            }
          } else if (a.fieldType === 'Btn') {
            if (val === true) {
              ctx.strokeStyle = '#111'; ctx.lineWidth = Math.max(1.5, h * 0.12);
              ctx.beginPath();
              ctx.moveTo(x0 + w * 0.22, y0 + h * 0.52); ctx.lineTo(x0 + w * 0.42, y0 + h * 0.74); ctx.lineTo(x0 + w * 0.8, y0 + h * 0.26);
              ctx.stroke();
            }
          } else {
            ctx.font = Math.max(6 * s, h * 0.55) + 'px Arial, Helvetica, sans-serif';
            ctx.textBaseline = 'middle';
            ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
            ctx.fillText(String(val), x0 + 2 * s, y0 + h / 2);
          }
          ctx.restore();
        });
      });
    }).catch(function () {});
  }

  // draw a page's live decorations (watermarks, page number, texts, signatures) onto a
  // canvas produced by renderPageCanvas. Pages→images and Shrink build their output
  // straight from canvases, which would otherwise silently DROP everything the user
  // just applied (the thumbnails preview it, so the export must match). Resolves after
  // the async signature images have actually drawn.
  function drawDecor(canvas, pg, gridIdx) {
    return metricsReady.then(function () { return effPointSize(pg); }).then(function (sz) {
      var ctx = canvas.getContext('2d'), tw = canvas.width, th = canvas.height;
      paintWhiteouts(ctx, pg, tw, th);
      paintRedacts(ctx, pg, tw, th);
      drawMarks(ctx, pg, tw, th, sz.w, sz.h, gridIdx);
      (pg.texts || []).forEach(function (t) {
        // the same shared painter the thumbnails use; drawDecor keeps its max(1, ...)
        // floor, which is not a readability floor and does not bind at export DPI
        PURE.paintTextBox(ctx, t, textLayout(t, sz.w, sz.h), { scale: tw / sz.w, ox: t.x * tw, oy: t.y * th, floor: 1 });
      });
      return Promise.all((pg.sigs || []).map(function (s) {
        return new Promise(function (res) {
          var im = new Image();
          im.onload = function () { ctx.drawImage(im, s.x * tw, s.y * th, s.w * tw, s.h * th); res(); };
          im.onerror = function () { res(); };
          pngUrlInto(im, s.png);
        });
      }));
    });
  }

  // ---------- form fields ----------
  function getFormFields(docIndex) {
    var d = docs[docIndex];
    if (!d || !d.bytes) return Promise.resolve([]);   // tombstoned by pruneDocs
    return PDFLib.PDFDocument.load(d.bytes, { ignoreEncryption: true }).then(function (doc) {
      var out = [];
      try {
        doc.getForm().getFields().forEach(function (f) {
          var type = fieldType(f);
          if (!type) return;
          var rec = { name: f.getName(), type: type };
          try { if (type === 'select' || type === 'radio') rec.options = f.getOptions(); } catch (e) {}
          try { if (type === 'text') rec.value = f.getText() || ''; } catch (e) {}
          try { if (type === 'checkbox') rec.value = !!f.isChecked(); } catch (e) {}
          try { if (type === 'select') rec.value = (f.getSelected && f.getSelected()[0]) || ''; } catch (e) {}
          out.push(rec);
        });
      } catch (e) {}
      return out;
    });
  }

  // ---------- compress (rasterize every page to JPEG) ----------
  function compress(dpi, quality, onTick) {
    return PDFLib.PDFDocument.create().then(function (out) {
      var chain = Promise.resolve();
      pages.forEach(function (pg, i) {
        chain = chain.then(function () {
          return effPointSize(pg).then(function (sz) {
            return renderPageCanvas(pg, Math.max(1, sz.w * dpi / 72)).then(function (r) {
              var c = document.createElement('canvas'); c.width = r.canvas.width; c.height = r.canvas.height;
              var cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height); cx.drawImage(r.canvas, 0, 0);
              r.canvas.width = 0;   // free the intermediate canvas
              // keep the user's form fill-ins, watermarks / page numbers / texts /
              // signatures — the raw render has only the source page content
              return paintFormValues(c, pg).then(function () {
                return drawDecor(c, pg, i);
              }).then(function () {
                return canvasToBytes(c, 'image/jpeg', quality);
              }).then(function (jpg) {
                c.width = 0;
                return out.embedJpg(jpg).then(function (img) {
                  out.addPage([sz.w, sz.h]).drawImage(img, { x: 0, y: 0, width: sz.w, height: sz.h });
                });
              });
            });
          }).then(function () { return onTick ? onTick(i + 1, pages.length) : null; });
        });
      });
      return chain.then(function () {
        out.setProducer(''); out.setCreator('');
        try { out.setCreationDate(new Date(0)); out.setModificationDate(new Date(0)); } catch (e) {}
        return out.save();
      });
    });
  }
  function inputSize() { return docs.reduce(function (a, d) { return a + (d.bytes ? d.bytes.length : 0); }, 0); }

  // ---------- shared API for the editor + tools modules ----------
  window.__PT = {
    PURE: PURE,
    jsBase: jsBase,
    pages: function () { return pages; },
    docs: function () { return docs; },
    selectedIdx: selectedIdx,
    totalRotation: totalRotation,
    renderGrid: renderGrid,
    refreshSel: refreshSel,
    updateToolbar: updateToolbar,
    setStatus: setStatus,
    buildPdf: buildPdf,
    buildTick: buildTick,
    renderPageCanvas: renderPageCanvas,
    bakePageToRaster: bakePageToRaster,
    pageEffRotation: pageEffRotation,
    effPointSize: effPointSize,
    canvasToBytes: canvasToBytes,
    textBoxFrac: textBoxFrac,
    // rich text seams (spec 12.1 / 12.2 / 12.4). The table argument is optional on the
    // two __PT wrappers: omit it (or pass null) to use the live one.
    textLines: textLines,
    layoutTextBox: function (t, Wpt, Hpt, table) { return PURE.layoutTextBox(t, Wpt, Hpt, table || metricsTable); },
    hitTextBox: function (t, Wpt, Hpt, table, px, py) { return PURE.hitTextBox(t, Wpt, Hpt, table || metricsTable, px, py); },
    paintTextBox: PURE.paintTextBox,
    buildMetrics: PURE.buildMetrics,
    metrics: function () { return metricsTable; },
    metricsReady: metricsReady,
    sanitizeRun: PURE.sanitizeRun,
    setBoxContent: PURE.setBoxContent,
    newTextBox: PURE.newTextBox,
    getFormFields: getFormFields,
    pdfjsPage: function (pg) { return docs[pg.docIndex].js.getPage(pg.pageIndex + 1); },
    drawMarks: drawMarks,
    drawDecor: drawDecor,
    paintRedacts: paintRedacts,
    paintWhiteouts: paintWhiteouts,
    paintFormValues: paintFormValues,
    hasRedacts: hasRedacts,
    hasWhiteouts: hasWhiteouts,
    setRedactDpi: function (d) { redactDpi = Math.max(72, Math.min(300, d || 150)); },
    getRedactDpi: function () { return redactDpi; },
    onUndo: null,   // the editor sets this to rebind its page after an undo
    onEditorDrop: null,   // the editor sets this to claim file drops while it is open (return truthy = consumed)
    onPagesChanged: null, // the editor sets this to refresh its nav after addFiles adds pages
    markDirty: markDirty,
    markAllDirty: markAllDirty,
    orderChanged: orderChanged,
    snapshot: snapshot,
    dropSnapshot: dropSnapshot,
    snapSeq: function () { return snapSeq; },
    undo: undo,
    isBusy: function () { return busy; },
    setBusy: setBusy,
    progress: progress,
    progressDone: progressDone,
    nextFrame: nextFrame,
    modalOpen: modalOpen,
    openDialog: openDialog,
    closeDialog: closeDialog,
    exportName: exportName,
    liveDocIndices: liveDocIndices,
    downloadBytes: downloadBytes,
    fmtSize: fmtSize,
    getPageNums: function () { return pageNums; },
    setPageNums: function (cfg) { pageNums = cfg; },
    rangeState: rangeState
  };

  // ---------- compress dialog ----------
  var shrinkDialog = $('pt-shrink-dialog'), shrinkSel = $('pt-shrink-dpi');
  if (btnShrink) btnShrink.addEventListener('click', function () { if (pages.length) openDialog(shrinkDialog); });
  var shrinkCancel = $('pt-shrink-cancel'); if (shrinkCancel) shrinkCancel.addEventListener('click', function () { closeDialog(shrinkDialog); });
  var shrinkGo = $('pt-shrink-go');
  if (shrinkGo) shrinkGo.addEventListener('click', function () {
    closeDialog(shrinkDialog);
    if (!pages.length || busy) return;
    setBusy(true);
    var parts = (shrinkSel.value || '150,0.7').split(','), dpi = parseInt(parts[0], 10) || 150, q = parseFloat(parts[1]) || 0.7;
    progress(0, pages.length, 'Shrinking ' + pages.length + ' page' + (pages.length > 1 ? 's' : '') + '…');
    var before = inputSize();
    compress(dpi, q, buildTick('Shrinking')).then(function (bytes) {
      var name = exportName('compressed');
      downloadBytes(bytes, name);
      if (before && bytes.length > before) {
        // lead with the warning instead of burying it in a parenthesis — a text-only PDF
        // coming out bigger is the one outcome that needs explaining, not celebrating
        setStatus('Heads up: ' + name + ' came out larger (' + fmtSize(bytes.length) + ' vs ' + fmtSize(before) +
          ' in). Shrink helps scanned pages, not text PDFs. The file was still downloaded.', 'warn');
      } else {
        var pct = before ? Math.round((1 - bytes.length / before) * 100) : 0;
        setStatus('Saved ' + name + ', ' + fmtSize(bytes.length) + (before ? ' (input was ' + fmtSize(before) + ', ' + pct + '% smaller)' : '') + '.');
      }
    }).catch(function (e) { setStatus('Error: ' + (e && e.message || e), 'err'); })
      .then(function () { setBusy(false); });
  });
  if (shrinkDialog) shrinkDialog.addEventListener('click', function (e) { if (e.target === shrinkDialog) closeDialog(shrinkDialog); });

  // ---------- store-only ZIP writer (no deps) ----------
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
  })();
  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function storeZip(files) {
    var enc = new TextEncoder();
    var locals = [], central = [], offset = 0;
    var dt = PURE.dosDateTime(new Date());   // every entry dated now (an all-zero date unzips as 1979/1980)
    files.forEach(function (f) {
      var name = enc.encode(f.name), data = f.data, crc = crc32(data);
      var lh = new Uint8Array(30 + name.length);
      var dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true);   /* bit 11: names are UTF-8 */
      dv.setUint16(8, 0, true); dv.setUint16(10, dt.time, true); dv.setUint16(12, dt.date, true);
      dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
      dv.setUint16(26, name.length, true); dv.setUint16(28, 0, true);
      lh.set(name, 30);
      locals.push(lh, data);
      var ch = new Uint8Array(46 + name.length); var cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true); cv.setUint16(12, dt.time, true); cv.setUint16(14, dt.date, true);   /* bit 11: names are UTF-8 */
      cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
      ch.set(name, 46);
      central.push(ch);
      offset += lh.length + data.length;
    });
    var cdSize = central.reduce(function (a, c) { return a + c.length; }, 0);
    var eocd = new Uint8Array(22); var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    var parts = locals.concat(central, [eocd]);
    var total = parts.reduce(function (a, p) { return a + p.length; }, 0);
    var out = new Uint8Array(total), pos = 0;
    parts.forEach(function (p) { out.set(p, pos); pos += p.length; });
    return out;
  }
  window.__PT.storeZip = storeZip;

  // ---------- init ----------
  // Hoist the full-screen editor + dialogs to <body> so a nested stacking context
  // can't trap them under the site masthead.
  Array.prototype.forEach.call(document.querySelectorAll('.pt-modal, #pt-ed'), function (el) { document.body.appendChild(el); });
  updateToolbar();
  updateRangeInfo();
  if (engineNote) engineNote.hidden = true;   // libs already loaded (defer order guarantees it)
})();
