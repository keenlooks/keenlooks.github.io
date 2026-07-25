/* ==========================================================================
   computer-core.js — the KL-8, an original 8-bit teaching computer.
   Pure logic, no DOM: ISA table, two-pass assembler, emulator with a
   micro-trace output for the datapath animation, and the bundled example
   programs. Attaches to globalThis (page + node) and module.exports (node
   tests). In the spirit of Ben Eater's breadboard computer videos; the
   KL-8 design and all of this code are original.

   Memory map:
     $0000-$0FFF  RAM (4 KB). Programs assemble at $0000; $0F00-$0FFF is
                  the stack page by convention (JSR/RTS/PHA/PLA use it).
     $1000-$13FF  display, 32x32 pixels, 1 byte each, addr = $1000+y*32+x.
                  Writes are masked & $0F. Readable.
     $1400        KEYS (read-only)  bit0 up, 1 down, 2 left, 3 right, 4 space
     $1401        RND  (read-only)  16-bit xorshift, seed $ACE1 at reset
     $1402        FRAME (read-only) incremented by cpu.frame(), wraps at 256
   Unmapped reads return 0; writes outside RAM/display are ignored.
   ========================================================================== */
(function () {
  var root = (typeof globalThis !== 'undefined') ? globalThis
           : (typeof self !== 'undefined') ? self : this;
  if (root.KL8) return;

  /* ---------------- ISA table (frozen) ---------------- */
  /* mode: imp (no operand), imm (#v), abs ($addr), abx ($addr,X), ind (($addr)) */
  var ISA = [
    { mn: 'NOP',  mode: 'imp', op: 0x00, len: 1, f: '',    d: 'do nothing' },
    { mn: 'LDA',  mode: 'imm', op: 0x01, len: 2, f: 'ZN',  d: 'A = value' },
    { mn: 'LDA',  mode: 'abs', op: 0x02, len: 3, f: 'ZN',  d: 'A = mem[addr]' },
    { mn: 'LDA',  mode: 'abx', op: 0x03, len: 3, f: 'ZN',  d: 'A = mem[addr+X]' },
    { mn: 'LDA',  mode: 'ind', op: 0x0B, len: 3, f: 'ZN',  d: 'A = mem[pointer at addr]' },
    { mn: 'LDX',  mode: 'imm', op: 0x04, len: 2, f: 'ZN',  d: 'X = value' },
    { mn: 'LDX',  mode: 'abs', op: 0x05, len: 3, f: 'ZN',  d: 'X = mem[addr]' },
    { mn: 'STA',  mode: 'abs', op: 0x06, len: 3, f: '',    d: 'mem[addr] = A' },
    { mn: 'STA',  mode: 'abx', op: 0x07, len: 3, f: '',    d: 'mem[addr+X] = A' },
    { mn: 'STA',  mode: 'ind', op: 0x0C, len: 3, f: '',    d: 'mem[pointer at addr] = A' },
    { mn: 'STX',  mode: 'abs', op: 0x08, len: 3, f: '',    d: 'mem[addr] = X' },
    { mn: 'TAX',  mode: 'imp', op: 0x09, len: 1, f: 'ZN',  d: 'X = A' },
    { mn: 'TXA',  mode: 'imp', op: 0x0A, len: 1, f: 'ZN',  d: 'A = X' },
    { mn: 'ADD',  mode: 'imm', op: 0x10, len: 2, f: 'ZNC', d: 'A = A + value (C = carry out)' },
    { mn: 'ADD',  mode: 'abs', op: 0x11, len: 3, f: 'ZNC', d: 'A = A + mem[addr]' },
    { mn: 'ADD',  mode: 'abx', op: 0x12, len: 3, f: 'ZNC', d: 'A = A + mem[addr+X]' },
    { mn: 'SUB',  mode: 'imm', op: 0x13, len: 2, f: 'ZNC', d: 'A = A - value (C = 1 if no borrow)' },
    { mn: 'SUB',  mode: 'abs', op: 0x14, len: 3, f: 'ZNC', d: 'A = A - mem[addr]' },
    { mn: 'SUB',  mode: 'abx', op: 0x15, len: 3, f: 'ZNC', d: 'A = A - mem[addr+X]' },
    { mn: 'AND',  mode: 'imm', op: 0x16, len: 2, f: 'ZN',  d: 'A = A & value' },
    { mn: 'AND',  mode: 'abs', op: 0x17, len: 3, f: 'ZN',  d: 'A = A & mem[addr]' },
    { mn: 'ORA',  mode: 'imm', op: 0x18, len: 2, f: 'ZN',  d: 'A = A | value' },
    { mn: 'ORA',  mode: 'abs', op: 0x19, len: 3, f: 'ZN',  d: 'A = A | mem[addr]' },
    { mn: 'EOR',  mode: 'imm', op: 0x1A, len: 2, f: 'ZN',  d: 'A = A ^ value (exclusive or)' },
    { mn: 'EOR',  mode: 'abs', op: 0x1B, len: 3, f: 'ZN',  d: 'A = A ^ mem[addr]' },
    { mn: 'SHL',  mode: 'imp', op: 0x1C, len: 1, f: 'ZNC', d: 'C = bit 7, A = A << 1' },
    { mn: 'SHR',  mode: 'imp', op: 0x1D, len: 1, f: 'ZNC', d: 'C = bit 0, A = A >> 1' },
    { mn: 'CMP',  mode: 'imm', op: 0x1E, len: 2, f: 'ZNC', d: 'set flags from A - value' },
    { mn: 'CMP',  mode: 'abs', op: 0x1F, len: 3, f: 'ZNC', d: 'set flags from A - mem[addr]' },
    { mn: 'CPX',  mode: 'imm', op: 0x20, len: 2, f: 'ZNC', d: 'set flags from X - value' },
    { mn: 'INX',  mode: 'imp', op: 0x21, len: 1, f: 'ZN',  d: 'X = X + 1' },
    { mn: 'DEX',  mode: 'imp', op: 0x22, len: 1, f: 'ZN',  d: 'X = X - 1' },
    { mn: 'INC',  mode: 'abs', op: 0x23, len: 3, f: 'ZN',  d: 'mem[addr] = mem[addr] + 1' },
    { mn: 'DEC',  mode: 'abs', op: 0x24, len: 3, f: 'ZN',  d: 'mem[addr] = mem[addr] - 1' },
    { mn: 'JMP',  mode: 'abs', op: 0x30, len: 3, f: '',    d: 'jump to addr' },
    { mn: 'JEQ',  mode: 'abs', op: 0x31, len: 3, f: '',    d: 'jump if Z = 1 (equal / zero)' },
    { mn: 'JNE',  mode: 'abs', op: 0x32, len: 3, f: '',    d: 'jump if Z = 0 (not equal)' },
    { mn: 'JCS',  mode: 'abs', op: 0x33, len: 3, f: '',    d: 'jump if C = 1 (carry set)' },
    { mn: 'JCC',  mode: 'abs', op: 0x34, len: 3, f: '',    d: 'jump if C = 0 (carry clear)' },
    { mn: 'JMI',  mode: 'abs', op: 0x35, len: 3, f: '',    d: 'jump if N = 1 (negative)' },
    { mn: 'JSR',  mode: 'abs', op: 0x36, len: 3, f: '',    d: 'push return address, jump to addr' },
    { mn: 'RTS',  mode: 'imp', op: 0x37, len: 1, f: '',    d: 'return from subroutine' },
    { mn: 'PHA',  mode: 'imp', op: 0x38, len: 1, f: '',    d: 'push A on the stack' },
    { mn: 'PLA',  mode: 'imp', op: 0x39, len: 1, f: 'ZN',  d: 'pull A from the stack' },
    { mn: 'WAIT', mode: 'imp', op: 0x40, len: 1, f: '',    d: 'pause until the next display frame' },
    { mn: 'HLT',  mode: 'imp', op: 0xFF, len: 1, f: '',    d: 'halt the computer' }
  ];

  var byOp = new Array(256);
  var byMn = Object.create(null);
  var MNEMONICS = [];
  (function () {
    for (var i = 0; i < ISA.length; i++) {
      var e = ISA[i];
      byOp[e.op] = e;
      if (!byMn[e.mn]) { byMn[e.mn] = Object.create(null); MNEMONICS.push(e.mn); }
      byMn[e.mn][e.mode] = e;
    }
  })();

  /* ---------------- small helpers ---------------- */
  function hx2(v) { return ('0' + (v & 0xFF).toString(16).toUpperCase()).slice(-2); }
  function hx4(v) { return ('000' + (v & 0xFFFF).toString(16).toUpperCase()).slice(-4); }

  function levenshtein(a, b) {
    var la = a.length, lb = b.length, i, j;
    var prev = new Array(lb + 1), cur = new Array(lb + 1);
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      cur[0] = i;
      for (j = 1; j <= lb; j++) {
        var c = (a.charAt(i - 1) === b.charAt(j - 1)) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
      }
      var t = prev; prev = cur; cur = t;
    }
    return prev[lb];
  }

  function suggestMnemonic(bad) {
    var cand = MNEMONICS.concat(['.ORG', '.BYTE', '.WORD']);
    var best = null, bestD = 3;
    for (var i = 0; i < cand.length; i++) {
      var d = levenshtein(bad.toUpperCase(), cand[i]);
      if (d < bestD) { bestD = d; best = cand[i]; }
    }
    return best;
  }

  /* strip a ; comment, but not a ; inside a 'c' character literal */
  function stripComment(line) {
    var out = '', i = 0, n = line.length;
    while (i < n) {
      var c = line.charAt(i);
      if (c === "'" && i + 2 < n && line.charAt(i + 2) === "'") {
        out += line.substr(i, 3); i += 3; continue;
      }
      if (c === ';') break;
      out += c; i++;
    }
    return out;
  }

  /* split ".byte 1, 'A', 3" args on commas, respecting char literals */
  function splitArgs(text) {
    var parts = [], cur = '', i = 0, n = text.length;
    while (i < n) {
      var c = text.charAt(i);
      if (c === "'" && i + 2 < n && text.charAt(i + 2) === "'") {
        cur += text.substr(i, 3); i += 3; continue;
      }
      if (c === ',') { parts.push(cur); cur = ''; i++; continue; }
      cur += c; i++;
    }
    parts.push(cur);
    return parts;
  }

  /* parse "value" or "value+n" / "value-n" (n decimal).
     Returns { base, sym, add } (sym set when the term is a label) or { err }. */
  function parseExpr(text, allowLabel) {
    text = text.replace(/^\s+|\s+$/g, '');
    if (!text) return { err: 'missing value' };
    var base = 0, sym = null, rest;
    if (text.charAt(0) === "'") {
      if (text.length < 3 || text.charAt(2) !== "'") return { err: 'bad character literal (use \'A\')' };
      var cc = text.charCodeAt(1);
      if (cc < 32 || cc > 126) return { err: 'character literal must be printable ASCII' };
      base = cc; rest = text.slice(3);
    } else {
      var m = /^(\$[0-9A-Fa-f]+|[0-9]+|[A-Za-z_][A-Za-z0-9_]*)/.exec(text);
      if (!m) return { err: 'cannot read a value from "' + text + '"' };
      var tok = m[0]; rest = text.slice(tok.length);
      if (tok.charAt(0) === '$') {
        if (tok.length < 2 || tok.length > 5) return { err: 'hex value out of range: ' + tok };
        base = parseInt(tok.slice(1), 16);
      } else if (/^[0-9]/.test(tok)) {
        base = parseInt(tok, 10);
        if (base > 0xFFFF) return { err: 'value out of range (0-65535): ' + tok };
      } else {
        if (!allowLabel) return { err: 'a label ("' + tok + '") is not allowed here' };
        sym = tok;
      }
    }
    rest = rest.replace(/^\s+|\s+$/g, '');
    var add = 0;
    if (rest) {
      var mm = /^([+\-])\s*([0-9]+)$/.exec(rest);
      if (!mm) return { err: 'only "+n" or "-n" (decimal) may follow a value' };
      add = (mm[1] === '-' ? -1 : 1) * parseInt(mm[2], 10);
    }
    return { base: base, sym: sym, add: add };
  }

  /* ---------------- two-pass assembler ---------------- */
  /* Returns { bytes: Uint8Array, origin, srcMap: Map<addr,line>, symbols,
               errors: [{line, msg}] }. bytes covers origin..last emitted. */
  function assemble(src) {
    var lines = String(src).split(/\r?\n/);
    var errors = [];
    var symbols = Object.create(null);
    var symLine = Object.create(null);
    var items = [];              /* {line, kind, ...} in source order */
    var i, ln;

    function err(line, msg) { errors.push({ line: line, msg: msg }); }

    /* ----- pass 1: parse lines, size items, collect labels ----- */
    var cur = 0x0000;
    for (i = 0; i < lines.length; i++) {
      ln = i + 1;
      var text = stripComment(lines[i]).replace(/^\s+|\s+$/g, '');
      if (!text) continue;

      /* leading labels */
      var lm;
      while ((lm = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*/.exec(text))) {
        var name = lm[1];
        if (symbols[name] !== undefined) {
          err(ln, 'duplicate label "' + name + '" (first defined on line ' + symLine[name] + ')');
        } else {
          symbols[name] = cur; symLine[name] = ln;
        }
        text = text.slice(lm[0].length);
      }
      if (!text) continue;

      var im = /^(\.?[A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/.exec(text);
      if (!im) { err(ln, 'cannot parse this line'); continue; }
      var word = im[1], opnd = im[2].replace(/^\s+|\s+$/g, '');

      if (word.charAt(0) === '.') {
        var dir = word.toLowerCase();
        if (dir === '.org') {
          var oe = parseExpr(opnd, false);
          if (oe.err) { err(ln, '.org: ' + oe.err); continue; }
          var ov = oe.base + oe.add;
          if (ov < 0 || ov > 0xFFFF) { err(ln, '.org address out of range'); continue; }
          cur = ov;
        } else if (dir === '.byte' || dir === '.word') {
          if (!opnd) { err(ln, dir + ' needs at least one value'); continue; }
          var args = splitArgs(opnd), exprs = [];
          for (var a = 0; a < args.length; a++) {
            var ae = parseExpr(args[a], true);
            if (ae.err) { err(ln, dir + ': ' + ae.err); }
            exprs.push(ae);
          }
          var per = (dir === '.word') ? 2 : 1;
          items.push({ line: ln, kind: dir.slice(1), addr: cur, exprs: exprs });
          cur += exprs.length * per;
        } else {
          var ds = suggestMnemonic(word);
          err(ln, 'unknown directive "' + word + '"' + (ds && ds.charAt(0) === '.' ? ' (did you mean ' + ds + '?)' : ''));
        }
        continue;
      }

      var mn = word.toUpperCase();
      var modes = byMn[mn];
      if (!modes) {
        var sg = suggestMnemonic(word);
        err(ln, 'unknown instruction "' + word + '"' + (sg ? ' (did you mean ' + sg + '?)' : ''));
        continue;
      }

      /* classify the operand form */
      var mode, body = '';
      if (!opnd) { mode = 'imp'; }
      else if (opnd.charAt(0) === '#') { mode = 'imm'; body = opnd.slice(1); }
      else if (/^\(.*\)$/.test(opnd)) { mode = 'ind'; body = opnd.slice(1, -1); }
      else if (/,\s*[xX]$/.test(opnd)) { mode = 'abx'; body = opnd.replace(/,\s*[xX]$/, ''); }
      else { mode = 'abs'; body = opnd; }

      var ent = modes[mode];
      if (!ent) {
        var names = { imp: 'no operand', imm: '#value', abs: 'addr', abx: 'addr,X', ind: '(addr)' };
        var have = [];
        for (var k in modes) have.push(names[k]);
        err(ln, mn + ' cannot take that operand form; it supports: ' + have.join(', '));
        continue;
      }

      var expr = null;
      if (mode === 'imm') {
        expr = parseExpr(body, false);
        if (!expr.err && expr.add !== 0) expr = { err: 'immediate operands take a plain number or character literal' };
        if (expr.err) { err(ln, expr.err); continue; }
      } else if (mode !== 'imp') {
        expr = parseExpr(body, true);
        if (expr.err) { err(ln, expr.err); continue; }
      }

      items.push({ line: ln, kind: 'instr', addr: cur, ent: ent, expr: expr });
      cur += ent.len;
    }

    /* ----- pass 2: resolve + emit ----- */
    var mem = new Uint8Array(0x10000);
    var used = new Uint8Array(0x10000);
    var srcMap = new Map();
    var minA = -1, maxA = -1;

    function resolve(line, expr, lo, hi, what) {
      var v;
      if (expr.sym !== null && expr.sym !== undefined) {
        v = symbols[expr.sym];
        if (v === undefined) { err(line, 'undefined label "' + expr.sym + '"'); return null; }
      } else v = expr.base;
      v += expr.add;
      if (v < lo || v > hi) { err(line, what + ' out of range (' + lo + '-' + hi + '): ' + v); return null; }
      return v;
    }

    function emit(line, addr, b) {
      if (addr < 0 || addr > 0x0EFF) {
        err(line, 'byte emitted at $' + hx4(addr) + ' is outside program RAM ' +
          '($0000-$0EFF; the stack page starts at $0F00 and I/O above that)');
        return false;
      }
      if (used[addr]) {
        err(line, 'overlapping code at $' + hx4(addr) + ' (two regions collide, check .org)');
        return false;
      }
      used[addr] = 1;
      mem[addr] = b & 0xFF;
      if (minA < 0 || addr < minA) minA = addr;
      if (addr > maxA) maxA = addr;
      return true;
    }

    for (i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.kind === 'instr') {
        srcMap.set(it.addr, it.line);
        if (!emit(it.line, it.addr, it.ent.op)) continue;
        if (it.ent.mode === 'imm') {
          var iv = resolve(it.line, it.expr, 0, 255, 'immediate value');
          if (iv === null) continue;
          emit(it.line, it.addr + 1, iv);
        } else if (it.ent.mode !== 'imp') {
          var av = resolve(it.line, it.expr, 0, 0xFFFF, 'address');
          if (av === null) continue;
          emit(it.line, it.addr + 1, av & 0xFF);
          emit(it.line, it.addr + 2, (av >> 8) & 0xFF);
        }
      } else if (it.kind === 'byte') {
        for (var b = 0; b < it.exprs.length; b++) {
          if (it.exprs[b].err) continue;
          var bv = resolve(it.line, it.exprs[b], 0, 255, '.byte value');
          if (bv === null) continue;
          emit(it.line, it.addr + b, bv);
        }
      } else if (it.kind === 'word') {
        for (var w = 0; w < it.exprs.length; w++) {
          if (it.exprs[w].err) continue;
          var wv = resolve(it.line, it.exprs[w], 0, 0xFFFF, '.word value');
          if (wv === null) continue;
          emit(it.line, it.addr + w * 2, wv & 0xFF);
          emit(it.line, it.addr + w * 2 + 1, (wv >> 8) & 0xFF);
        }
      }
    }

    if (!errors.length && minA < 0) err(items.length ? items[items.length - 1].line : 1, 'nothing to assemble (no bytes emitted)');

    errors.sort(function (a, b2) { return a.line - b2.line; });
    if (errors.length) {
      return { bytes: new Uint8Array(0), origin: 0, srcMap: srcMap, symbols: symbols, errors: errors };
    }
    return {
      bytes: mem.slice(minA, maxA + 1),
      origin: minA,
      srcMap: srcMap,
      symbols: symbols,
      errors: []
    };
  }

  /* ---------------- emulator ---------------- */
  function nowMs() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  function CPU(opts) {
    opts = opts || {};
    this.readKeys = opts.readKeys || function () { return 0; };
    this.seed0 = (opts.seed == null ? 0xACE1 : opts.seed) & 0xFFFF;
    this.ram = new Uint8Array(0x1000);
    this.disp = new Uint8Array(1024);
    this.dirtyMask = new Uint8Array(1024);
    this.dirtyList = [];
    this.dirtyAll = true;
    this.memLog = null;      /* page sets [] to record (addr | write<<16) entries */
    this.prog = null;
    this.reset();
  }

  CPU.prototype.load = function (prog) {
    this.prog = prog || null;
    this.reset();
  };

  CPU.prototype.reset = function (seed) {
    if (seed != null) this.seed0 = seed & 0xFFFF;
    this.s = this.seed0;
    this.ram.fill(0);
    this.disp.fill(0);
    this.dirtyMask.fill(0);
    this.dirtyList.length = 0;
    this.dirtyAll = true;
    if (this.memLog) this.memLog.length = 0;
    this.A = 0; this.X = 0; this.SP = 0xFF;
    this.Z = 0; this.N = 0; this.C = 0;
    this.frameCount = 0;
    this.halted = false;
    this.waiting = false;
    this.badOp = null;
    this.instrCount = 0;
    if (this.prog && this.prog.bytes && this.prog.bytes.length) {
      var o = this.prog.origin & 0xFFFF;
      for (var i = 0; i < this.prog.bytes.length && o + i < 0x1000; i++) {
        this.ram[o + i] = this.prog.bytes[i];
      }
      this.PC = o;
    } else {
      this.PC = 0x0000;
    }
  };

  CPU.prototype.lineAt = function (addr) {
    if (this.prog && this.prog.srcMap) {
      var l = this.prog.srcMap.get(addr & 0xFFFF);
      return (l === undefined) ? null : l;
    }
    return null;
  };

  CPU.prototype._log = function (addr, isWrite) {
    if (this.memLog && this.memLog.length < 2048) {
      this.memLog.push(addr | (isWrite ? 0x10000 : 0));
    }
  };

  /* read with side effects (RND advances, access logged) */
  CPU.prototype.read = function (a) {
    a &= 0xFFFF;
    if (a < 0x1000) { this._log(a, 0); return this.ram[a]; }
    if (a < 0x1400) { this._log(a, 0); return this.disp[a - 0x1000]; }
    if (a === 0x1400) { this._log(a, 0); return this.readKeys() & 0xFF; }
    if (a === 0x1401) {
      this._log(a, 0);
      var s = this.s;
      s = (s ^ ((s << 7) & 0xFFFF)) & 0xFFFF;
      s = (s ^ (s >> 9)) & 0xFFFF;
      s = (s ^ ((s << 8) & 0xFFFF)) & 0xFFFF;
      this.s = s;
      return s & 0xFF;
    }
    if (a === 0x1402) { this._log(a, 0); return this.frameCount; }
    return 0;
  };

  /* side-effect-free read for inspectors ($1401 shows the state low byte) */
  CPU.prototype.peek = function (a) {
    a &= 0xFFFF;
    if (a < 0x1000) return this.ram[a];
    if (a < 0x1400) return this.disp[a - 0x1000];
    if (a === 0x1400) return this.readKeys() & 0xFF;
    if (a === 0x1401) return this.s & 0xFF;
    if (a === 0x1402) return this.frameCount;
    return 0;
  };

  /* write with the machine's masking rules; returns true if it landed */
  CPU.prototype.write = function (a, v) {
    a &= 0xFFFF; v &= 0xFF;
    if (a < 0x1000) { this.ram[a] = v; this._log(a, 1); return true; }
    if (a < 0x1400) {
      var i = a - 0x1000;
      v &= 0x0F;
      if (this.disp[i] !== v) {
        this.disp[i] = v;
        if (!this.dirtyMask[i]) { this.dirtyMask[i] = 1; this.dirtyList.push(i); }
      }
      this._log(a, 1);
      return true;
    }
    return false; /* I/O and unmapped: ignored */
  };

  /* page/test consumption of display dirtiness */
  CPU.prototype.drainDirty = function () {
    if (this.dirtyAll) {
      this.dirtyAll = false;
      this.dirtyMask.fill(0);
      this.dirtyList.length = 0;
      return 'all';
    }
    if (!this.dirtyList.length) return null;
    var out = this.dirtyList.slice();
    for (var i = 0; i < out.length; i++) this.dirtyMask[out[i]] = 0;
    this.dirtyList.length = 0;
    return out;
  };

  CPU.prototype.frame = function () {
    this.waiting = false;
    this.frameCount = (this.frameCount + 1) & 0xFF;
  };

  /* disassemble the instruction at addr (for the IR block + phase text) */
  CPU.prototype.disasm = function (addr) {
    addr &= 0xFFFF;
    var op = this.peek(addr), e = byOp[op];
    if (!e) return '???';
    if (e.mode === 'imp') return e.mn;
    var o1 = this.peek(addr + 1), o2 = this.peek(addr + 2);
    var a = o1 | (o2 << 8);
    if (e.mode === 'imm') return e.mn + ' #$' + hx2(o1);
    if (e.mode === 'abs') return e.mn + ' $' + hx4(a);
    if (e.mode === 'abx') return e.mn + ' $' + hx4(a) + ',X';
    return e.mn + ' ($' + hx4(a) + ')';
  };

  /* execute ONE instruction; if tr is given, fill tr.phases/tr.text */
  CPU.prototype.execOne = function (tr) {
    var self = this;
    function P(kind, from, to, label, addr, opSym) {
      if (!tr) return;
      var ph = { kind: kind, from: from, to: to, label: label };
      if (addr !== undefined && addr !== null) ph.addr = addr & 0xFFFF;
      if (opSym) ph.op = opSym;
      tr.phases.push(ph);
    }
    function PF() {
      if (!tr) return;
      tr.phases.push({
        kind: 'flag', from: 'ALU', to: 'FLAGS',
        label: 'Z=' + self.Z + ' N=' + self.N + ' C=' + self.C,
        flags: { z: self.Z, n: self.N, c: self.C }
      });
    }
    function setZN(v) { self.Z = (v === 0) ? 1 : 0; self.N = (v >> 7) & 1; }

    var pc0 = this.PC;
    var op = this.read(pc0);
    var e = byOp[op];
    if (!e) {
      this.halted = true;
      this.badOp = op;
      P('flag', 'IR', 'DECODE', 'bad opcode $' + hx2(op) + ' at $' + hx4(pc0) + ' - halted');
      return;
    }
    var o1 = 0, o2 = 0, addr = 0, imm = 0;
    if (e.len >= 2) { o1 = this.read((pc0 + 1) & 0xFFFF); imm = o1; }
    if (e.len >= 3) { o2 = this.read((pc0 + 2) & 0xFFFF); addr = o1 | (o2 << 8); }
    this.PC = (pc0 + e.len) & 0xFFFF;
    this.instrCount++;

    var text = null;
    if (tr) {
      text = (e.mode === 'imp') ? e.mn
        : (e.mode === 'imm') ? e.mn + ' #$' + hx2(imm)
        : (e.mode === 'abs') ? e.mn + ' $' + hx4(addr)
        : (e.mode === 'abx') ? e.mn + ' $' + hx4(addr) + ',X'
        : e.mn + ' ($' + hx4(addr) + ')';
      tr.text = text;
      tr.op = op;
      P('move', 'PC', 'MAR', '$' + hx4(pc0));
      P('move', 'RAM', 'IR', '$' + hx2(op), pc0);
      if (e.len === 2) P('move', 'RAM', 'IR', '$' + hx2(o1), pc0 + 1);
      if (e.len === 3) P('move', 'RAM', 'IR', '$' + hx2(o1) + ' $' + hx2(o2), pc0 + 1);
      P('move', 'IR', 'DECODE', text);
    }

    /* effective address, with its own phases */
    function ea() {
      if (e.mode === 'abs') {
        P('move', 'IR', 'MAR', '$' + hx4(addr));
        return addr;
      }
      if (e.mode === 'abx') {
        var a2 = (addr + self.X) & 0xFFFF;
        P('alu', 'X', 'ALU', '$' + hx4(addr) + ' + X', null, '+');
        P('move', 'ALU', 'MAR', '$' + hx4(a2));
        return a2;
      }
      P('move', 'IR', 'MAR', '$' + hx4(addr));
      var lo = self.read(addr), hi = self.read((addr + 1) & 0xFFFF);
      var pt = lo | (hi << 8);
      P('move', 'RAM', 'MAR', '$' + hx4(pt), addr);
      return pt;
    }

    /* operand value for ALU-style ops, with phases routing into the ALU */
    function operand() {
      if (e.mode === 'imm') { P('move', 'IR', 'ALU', '#$' + hx2(imm)); return imm; }
      var a2 = ea();
      var v = self.read(a2);
      P('move', 'RAM', 'ALU', '$' + hx2(v), a2);
      return v;
    }

    var v, r, a2, ret, lo, hi;
    switch (e.mn) {
      case 'NOP': break;

      case 'LDA':
        if (e.mode === 'imm') { v = imm; P('move', 'IR', 'A', '#$' + hx2(v)); }
        else { a2 = ea(); v = this.read(a2); P('move', 'RAM', 'A', '$' + hx2(v), a2); }
        this.A = v; setZN(v); PF();
        break;

      case 'LDX':
        if (e.mode === 'imm') { v = imm; P('move', 'IR', 'X', '#$' + hx2(v)); }
        else { a2 = ea(); v = this.read(a2); P('move', 'RAM', 'X', '$' + hx2(v), a2); }
        this.X = v; setZN(v); PF();
        break;

      case 'STA':
        a2 = ea();
        this.write(a2, this.A);
        P('move', 'A', 'RAM', '$' + hx2(this.A), a2);
        break;

      case 'STX':
        a2 = ea();
        this.write(a2, this.X);
        P('move', 'X', 'RAM', '$' + hx2(this.X), a2);
        break;

      case 'TAX': this.X = this.A; setZN(this.X); P('move', 'A', 'X', '$' + hx2(this.X)); PF(); break;
      case 'TXA': this.A = this.X; setZN(this.A); P('move', 'X', 'A', '$' + hx2(this.A)); PF(); break;

      case 'ADD':
        v = operand(); r = this.A + v;
        this.C = (r > 255) ? 1 : 0;
        this.A = r & 0xFF; setZN(this.A);
        P('alu', 'A', 'ALU', 'A + $' + hx2(v), null, '+');
        P('move', 'ALU', 'A', '$' + hx2(this.A));
        PF();
        break;

      case 'SUB':
        v = operand();
        this.C = (this.A >= v) ? 1 : 0;
        this.A = (this.A - v) & 0xFF; setZN(this.A);
        P('alu', 'A', 'ALU', 'A - $' + hx2(v), null, '-');
        P('move', 'ALU', 'A', '$' + hx2(this.A));
        PF();
        break;

      case 'AND':
        v = operand(); this.A &= v; setZN(this.A);
        P('alu', 'A', 'ALU', 'A & $' + hx2(v), null, '&');
        P('move', 'ALU', 'A', '$' + hx2(this.A));
        PF();
        break;

      case 'ORA':
        v = operand(); this.A |= v; setZN(this.A);
        P('alu', 'A', 'ALU', 'A | $' + hx2(v), null, '|');
        P('move', 'ALU', 'A', '$' + hx2(this.A));
        PF();
        break;

      case 'EOR':
        v = operand(); this.A ^= v; setZN(this.A);
        P('alu', 'A', 'ALU', 'A ^ $' + hx2(v), null, '^');
        P('move', 'ALU', 'A', '$' + hx2(this.A));
        PF();
        break;

      case 'SHL':
        this.C = (this.A >> 7) & 1;
        this.A = (this.A << 1) & 0xFF; setZN(this.A);
        P('alu', 'A', 'ALU', 'A << 1', null, '<<');
        P('move', 'ALU', 'A', '$' + hx2(this.A));
        PF();
        break;

      case 'SHR':
        this.C = this.A & 1;
        this.A = this.A >> 1; setZN(this.A);
        P('alu', 'A', 'ALU', 'A >> 1', null, '>>');
        P('move', 'ALU', 'A', '$' + hx2(this.A));
        PF();
        break;

      case 'CMP':
        v = operand(); r = (this.A - v) & 0xFF;
        this.C = (this.A >= v) ? 1 : 0;
        this.Z = (this.A === v) ? 1 : 0;
        this.N = (r >> 7) & 1;
        P('alu', 'A', 'ALU', 'A - $' + hx2(v) + ' ?', null, '-');
        PF();
        break;

      case 'CPX':
        v = imm; r = (this.X - v) & 0xFF;
        P('move', 'IR', 'ALU', '#$' + hx2(v));
        this.C = (this.X >= v) ? 1 : 0;
        this.Z = (this.X === v) ? 1 : 0;
        this.N = (r >> 7) & 1;
        P('alu', 'X', 'ALU', 'X - $' + hx2(v) + ' ?', null, '-');
        PF();
        break;

      case 'INX':
        this.X = (this.X + 1) & 0xFF; setZN(this.X);
        P('alu', 'X', 'ALU', 'X + 1', null, '+');
        P('move', 'ALU', 'X', '$' + hx2(this.X));
        PF();
        break;

      case 'DEX':
        this.X = (this.X - 1) & 0xFF; setZN(this.X);
        P('alu', 'X', 'ALU', 'X - 1', null, '-');
        P('move', 'ALU', 'X', '$' + hx2(this.X));
        PF();
        break;

      case 'INC':
      case 'DEC':
        a2 = ea();
        v = this.read(a2);
        P('move', 'RAM', 'ALU', '$' + hx2(v), a2);
        r = (e.mn === 'INC') ? ((v + 1) & 0xFF) : ((v - 1) & 0xFF);
        setZN(r);
        this.write(a2, r);
        P('move', 'ALU', 'RAM', '$' + hx2(r), a2, (e.mn === 'INC' ? '+' : '-'));
        PF();
        break;

      case 'JMP':
        this.PC = addr;
        P('move', 'IR', 'PC', '$' + hx4(addr));
        break;

      case 'JEQ': case 'JNE': case 'JCS': case 'JCC': case 'JMI': {
        var taken =
          (e.mn === 'JEQ') ? (this.Z === 1) :
          (e.mn === 'JNE') ? (this.Z === 0) :
          (e.mn === 'JCS') ? (this.C === 1) :
          (e.mn === 'JCC') ? (this.C === 0) : (this.N === 1);
        var cond =
          (e.mn === 'JEQ') ? 'Z=1' : (e.mn === 'JNE') ? 'Z=0' :
          (e.mn === 'JCS') ? 'C=1' : (e.mn === 'JCC') ? 'C=0' : 'N=1';
        P('flag', 'FLAGS', 'DECODE', cond + ' ? ' + (taken ? 'yes, jump' : 'no, continue'),
          null, null);
        if (taken) {
          this.PC = addr;
          P('move', 'IR', 'PC', '$' + hx4(addr));
        }
        break;
      }

      case 'JSR':
        ret = this.PC; /* already past the operand */
        P('move', 'SP', 'MAR', '$0F' + hx2(this.SP));
        this.write(0x0F00 + this.SP, (ret >> 8) & 0xFF);
        this.SP = (this.SP - 1) & 0xFF;
        this.write(0x0F00 + this.SP, ret & 0xFF);
        P('move', 'PC', 'RAM', 'push $' + hx4(ret), 0x0F00 + this.SP);
        this.SP = (this.SP - 1) & 0xFF;
        this.PC = addr;
        P('move', 'IR', 'PC', '$' + hx4(addr));
        break;

      case 'RTS':
        P('move', 'SP', 'MAR', '$0F' + hx2((this.SP + 1) & 0xFF));
        this.SP = (this.SP + 1) & 0xFF;
        lo = this.read(0x0F00 + this.SP);
        this.SP = (this.SP + 1) & 0xFF;
        hi = this.read(0x0F00 + this.SP);
        this.PC = lo | (hi << 8);
        P('move', 'RAM', 'PC', '$' + hx4(this.PC), 0x0F00 + this.SP);
        break;

      case 'PHA':
        P('move', 'SP', 'MAR', '$0F' + hx2(this.SP));
        this.write(0x0F00 + this.SP, this.A);
        P('move', 'A', 'RAM', '$' + hx2(this.A), 0x0F00 + this.SP);
        this.SP = (this.SP - 1) & 0xFF;
        break;

      case 'PLA':
        this.SP = (this.SP + 1) & 0xFF;
        P('move', 'SP', 'MAR', '$0F' + hx2(this.SP));
        v = this.read(0x0F00 + this.SP);
        this.A = v; setZN(v);
        P('move', 'RAM', 'A', '$' + hx2(v), 0x0F00 + this.SP);
        PF();
        break;

      case 'WAIT':
        this.waiting = true;
        P('flag', 'DECODE', 'DECODE', 'waiting for the next frame');
        break;

      case 'HLT':
        this.halted = true;
        P('flag', 'DECODE', 'DECODE', 'halted');
        break;
    }
  };

  /* one instruction with a micro-trace for the datapath animation */
  CPU.prototype.step = function () {
    if (this.halted) return { phases: [], halted: true, waiting: false, line: null, pc: this.PC, text: '' };
    if (this.waiting) return { phases: [], halted: false, waiting: true, line: this.lineAt(this.PC), pc: this.PC, text: '' };
    var tr = { phases: [], halted: false, waiting: false, pc: this.PC, line: this.lineAt(this.PC), op: null, text: '' };
    this.execOne(tr);
    tr.halted = this.halted;
    tr.waiting = this.waiting;
    return tr;
  };

  /* fast mode: no traces; stops on HLT / WAIT / budget. Returns count run.
     maxMs (optional) bounds wall-clock time so weak devices keep 60 fps. */
  CPU.prototype.run = function (maxInstr, maxMs) {
    var n = 0;
    var cap = (maxInstr == null) ? 100000 : maxInstr;
    var useT = (maxMs != null);
    var t0 = useT ? nowMs() : 0;
    while (!this.halted && !this.waiting && n < cap) {
      this.execOne(null);
      n++;
      if (useT && (n & 511) === 0 && (nowMs() - t0) >= maxMs) break;
    }
    return n;
  };

  /* ---------------- bundled example programs ---------------- */
  var XY2PTR = [
    '',
    '; ptr($F0/$F1) = $1000 + y*32 + x   (x in $E0, y in $E1)',
    'xy2ptr: LDA $E1',
    '        SHR',
    '        SHR',
    '        SHR             ; y / 8',
    '        ADD #$10',
    '        STA $F1',
    '        LDA $E1',
    '        AND #7',
    '        SHL',
    '        SHL',
    '        SHL',
    '        SHL',
    '        SHL             ; (y & 7) * 32',
    '        ADD $E0         ; + x  (never carries: 224+31 = 255)',
    '        STA $F0',
    '        RTS'
  ].join('\n');

  var EX_LINE = [
    '; KL-8 demo: draw a diagonal line',
    '; The screen is 32x32 pixels at $1000, one byte per pixel,',
    '; address = $1000 + y*32 + x. Moving down-and-right = +33.',
    '        LDA #$00        ; pointer low byte',
    '        STA $F0',
    '        LDA #$10        ; pointer high byte ($1000 = screen)',
    '        STA $F1',
    '        LDX #32         ; 32 pixels to draw',
    'loop:   LDA #2          ; color 2 = blue',
    '        STA ($F0)       ; plot through the pointer',
    '        LDA $F0         ; advance pointer by 33',
    '        ADD #33',
    '        STA $F0',
    '        JCC same        ; carry set? bump the high byte',
    '        INC $F1',
    'same:   DEX',
    '        JNE loop',
    '        HLT'
  ].join('\n');

  var EX_BOUNCE = [
    '; KL-8 demo: bouncing pixel',
    '; A gold pixel bounces around the screen. Each frame we erase',
    '; it, move it, flip a delta at the walls, redraw, and WAIT.',
    '; x in $E0, y in $E1, dx in $E2, dy in $E3.',
    '        LDA #5',
    '        STA $E0         ; x = 5',
    '        LDA #3',
    '        STA $E1         ; y = 3',
    '        LDA #1',
    '        STA $E2         ; dx = +1',
    '        STA $E3         ; dy = +1',
    'main:   JSR xy2ptr',
    '        LDA #0',
    '        STA ($F0)       ; erase the old pixel',
    '        LDA $E0         ; x = x + dx',
    '        ADD $E2',
    '        STA $E0',
    '        JEQ flipx       ; hit the left wall (x = 0)?',
    '        CMP #31         ; or the right wall?',
    '        JNE xdone',
    'flipx:  LDA $E2         ; dx = -dx (two\'s complement)',
    '        EOR #$FF',
    '        ADD #1',
    '        STA $E2',
    'xdone:  LDA $E1         ; y = y + dy',
    '        ADD $E3',
    '        STA $E1',
    '        JEQ flipy',
    '        CMP #31',
    '        JNE ydone',
    'flipy:  LDA $E3         ; dy = -dy',
    '        EOR #$FF',
    '        ADD #1',
    '        STA $E3',
    'ydone:  JSR xy2ptr',
    '        LDA #3          ; color 3 = gold',
    '        STA ($F0)       ; draw at the new spot',
    '        WAIT            ; hold until the next screen frame',
    '        JMP main',
    XY2PTR
  ].join('\n');

  var EX_SIERPINSKI = [
    '; KL-8 demo: Sierpinski triangle (rule 90)',
    '; Every new pixel is the XOR of the two pixels diagonally',
    '; above it. One lit pixel at (16,0) grows into a fractal.',
    '; This program reads the display back to compute each row.',
    '        LDA #16',
    '        STA $E0',
    '        LDA #0',
    '        STA $E1',
    '        JSR xy2ptr',
    '        LDA #1',
    '        STA ($F0)       ; seed pixel at (16,0)',
    '        LDA #1',
    '        STA $E1         ; y = 1',
    'nrow:   LDA #1',
    '        STA $E0         ; x = 1 (columns 0 and 31 stay dark)',
    'cell:   DEC $E1         ; look one row up...',
    '        DEC $E0         ; ...one column left',
    '        JSR xy2ptr',
    '        LDA ($F0)       ; left-above neighbor',
    '        STA $E4',
    '        INC $E0',
    '        INC $E0         ; one column right',
    '        JSR xy2ptr',
    '        LDA ($F0)       ; right-above neighbor',
    '        EOR $E4         ; rule 90: XOR the two',
    '        STA $E4',
    '        DEC $E0         ; back to this cell...',
    '        INC $E1         ; ...on this row',
    '        JSR xy2ptr',
    '        LDA $E4',
    '        STA ($F0)       ; write the new pixel',
    '        INC $E0         ; x = x + 1',
    '        LDA $E0',
    '        CMP #31',
    '        JNE cell',
    '        WAIT            ; one new row per frame',
    '        INC $E1         ; y = y + 1',
    '        LDA $E1',
    '        CMP #32',
    '        JNE nrow',
    '        HLT',
    XY2PTR
  ].join('\n');

  var EX_RAIN = [
    '; KL-8 demo: rain',
    '; Four drops fall down the screen. A drop that leaves the',
    '; bottom restarts at the top in a random column (RND, $1401).',
    '; Drops 2 and 3 only fall on even frames (FRAME, $1402),',
    '; so the rain falls at two different speeds.',
    '; Drop i: x in $E4+i, y in $E8+i.',
    '        LDX #0',
    'seed:   LDA $1401       ; random column...',
    '        AND #31',
    '        STA $E4,X',
    '        LDA $1401       ; ...and a random starting height',
    '        AND #31',
    '        STA $E8,X',
    '        INX',
    '        CPX #4',
    '        JNE seed',
    'main:   LDX #0',
    'drop:   CPX #2',
    '        JMI move        ; drops 0 and 1 fall every frame',
    '        LDA $1402       ; drops 2 and 3: only when FRAME is even',
    '        AND #1',
    '        JNE next',
    'move:   LDA $E4,X       ; erase the drop at (x, y)',
    '        STA $E0',
    '        LDA $E8,X',
    '        STA $E1',
    '        JSR xy2ptr',
    '        LDA #0',
    '        STA ($F0)',
    '        LDA $E8,X       ; y = y + 1',
    '        ADD #1',
    '        CMP #32',
    '        JNE keep',
    '        LDA $1401       ; off the bottom: new random column',
    '        AND #31',
    '        STA $E4,X',
    '        LDA #0          ; back to the top row',
    'keep:   STA $E8,X',
    '        STA $E1',
    '        LDA $E4,X',
    '        STA $E0',
    '        JSR xy2ptr',
    '        LDA #3          ; gold',
    '        STA ($F0)       ; draw at the new spot',
    'next:   INX',
    '        CPX #4',
    '        JNE drop',
    '        WAIT',
    '        JMP main',
    XY2PTR
  ].join('\n');

  var EX_PAINT = [
    '; KL-8 demo: paint',
    '; Arrows move the cursor, space paints. Click the screen',
    '; first so it captures your keyboard, or use the pad below it.',
    '; Cursor x,y in $E0,$E1; the pixel under the cursor in $E2.',
    '        LDA #16',
    '        STA $E0',
    '        STA $E1',
    '        LDA #0',
    '        STA $E2',
    'main:   LDA $1402       ; move only every 4th frame,',
    '        AND #3          ; so the cursor is controllable',
    '        JNE cursor',
    '        JSR xy2ptr      ; put back the pixel we sat on',
    '        LDA $E2',
    '        STA ($F0)',
    '        LDA $1400       ; keys: bit0 up, 1 down, 2 left, 3 right',
    '        SHR             ; up -> carry',
    '        JCC ck2',
    '        DEC $E1',
    'ck2:    SHR             ; down -> carry',
    '        JCC ck3',
    '        INC $E1',
    'ck3:    SHR             ; left -> carry',
    '        JCC ck4',
    '        DEC $E0',
    'ck4:    SHR             ; right -> carry',
    '        JCC wrap',
    '        INC $E0',
    'wrap:   LDA $E0         ; stay on the 32x32 grid (wrap around)',
    '        AND #31',
    '        STA $E0',
    '        LDA $E1',
    '        AND #31',
    '        STA $E1',
    '        JSR xy2ptr',
    '        LDA ($F0)       ; remember what is under the cursor',
    '        STA $E2',
    'cursor: LDA $1400',
    '        AND #16         ; space held?',
    '        JEQ blink',
    '        LDA #2          ; paint in blue: it becomes the',
    '        STA $E2         ; pixel "under" the cursor',
    'blink:  JSR xy2ptr',
    '        LDA $1402',
    '        AND #8          ; blink with the frame counter',
    '        JEQ show',
    '        LDA $E2',
    '        EOR #$0F        ; inverted pixel = cursor highlight',
    '        JMP put',
    'show:   LDA $E2',
    'put:    STA ($F0)',
    '        WAIT',
    '        JMP main',
    XY2PTR
  ].join('\n');

  var EX_COUNTER = [
    '; KL-8 demo: binary counter',
    '; One byte counts up. Its eight bits are drawn as blocks,',
    '; most significant first: gold block = 1, grey block = 0.',
    '; SHL pushes the top bit into the carry flag; JCC tests it.',
    '        LDA #0',
    '        STA $E0         ; the counter',
    'main:   LDA $1402       ; frame counter',
    '        AND #15',
    '        JNE hold        ; tick about four times a second',
    '        INC $E0         ; count up',
    '        LDA #$E4        ; pixel pointer = $11E4 (row 15, col 4)',
    '        STA $F0',
    '        LDA #$11',
    '        STA $F1',
    '        LDA $E0',
    '        STA $E1         ; bits shift out of $E1, top bit first',
    '        LDX #0',
    'bit:    LDA $E1',
    '        SHL             ; top bit -> carry',
    '        STA $E1',
    '        LDA #4          ; grey block for a 0 bit',
    '        JCC put',
    '        LDA #3          ; gold block for a 1 bit',
    'put:    STA ($F0)',
    '        INC $F0',
    '        STA ($F0)       ; two pixels wide',
    '        INC $F0',
    '        INC $F0         ; one pixel gap',
    '        INX',
    '        CPX #8',
    '        JNE bit',
    'hold:   WAIT',
    '        JMP main'
  ].join('\n');

  var EXAMPLES = [
    { id: 'line',       name: '1. First pixels',    src: EX_LINE },
    { id: 'bounce',     name: '2. Bouncing pixel',  src: EX_BOUNCE },
    { id: 'sierpinski', name: '3. Sierpinski',      src: EX_SIERPINSKI },
    { id: 'rain',       name: '4. Rain',            src: EX_RAIN },
    { id: 'paint',      name: '5. Paint',           src: EX_PAINT },
    { id: 'counter',    name: '6. Binary counter',  src: EX_COUNTER }
  ];

  /* ---------------- export ---------------- */
  var KL8 = {
    ISA: ISA,
    byOp: byOp,
    byMn: byMn,
    MNEMONICS: MNEMONICS,
    assemble: assemble,
    CPU: CPU,
    EXAMPLES: EXAMPLES,
    DISPLAY: { BASE: 0x1000, W: 32, H: 32 },
    KEYS_ADDR: 0x1400, RND_ADDR: 0x1401, FRAME_ADDR: 0x1402,
    hx2: hx2, hx4: hx4
  };

  root.KL8 = KL8;
  if (typeof module !== 'undefined' && module.exports) module.exports = KL8;
})();
