/*
 * qr.js - minimal QR Code encoder (byte mode, error correction L or M,
 * versions 1-40, automatic mask selection). Renders to an SVG string.
 *
 * MIT License
 *
 * Copyright (c) 2026 Trojan Market contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Implements ISO/IEC 18004: Reed-Solomon over GF(2^8) with polynomial 0x11D,
 * block interleaving, function patterns, BCH-coded format/version info.
 */
(function (root) {
  'use strict';

  /* index 0 unused; per version 1..40 */
  var ECC_PER_BLOCK = {
    L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28]
  };
  var NUM_BLOCKS = {
    L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49]
  };
  var FORMAT_BITS = { L: 1, M: 0 };

  function bit(x, i) { return ((x >>> i) & 1) !== 0; }

  function rawModules(ver) {
    var r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var n = Math.floor(ver / 7) + 2;
      r -= (25 * n - 10) * n - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }

  function dataCodewords(ver, ecl) {
    return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver];
  }

  /* ---- Reed-Solomon ---- */
  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }

  function rsDivisor(degree) {
    var res = [];
    for (var i = 0; i < degree - 1; i++) res.push(0);
    res.push(1);
    var r = 1;
    for (var k = 0; k < degree; k++) {
      for (var j = 0; j < res.length; j++) {
        res[j] = gfMul(res[j], r);
        if (j + 1 < res.length) res[j] ^= res[j + 1];
      }
      r = gfMul(r, 0x02);
    }
    return res;
  }

  function rsRemainder(data, divisor) {
    var res = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ res.shift();
      res.push(0);
      divisor.forEach(function (coef, i) { res[i] ^= gfMul(coef, factor); });
    });
    return res;
  }

  function utf8(text) {
    return Array.prototype.slice.call(new TextEncoder().encode(String(text)));
  }

  /* ---- encoder ---- */
  function encode(text, ecl) {
    ecl = ecl === 'L' ? 'L' : 'M';
    var bytes = utf8(text);
    var ver, capBits;
    for (ver = 1; ver <= 40; ver++) {
      capBits = dataCodewords(ver, ecl) * 8;
      var need = 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8;
      if (need <= capBits) break;
    }
    if (ver > 40) throw new Error('Data too long for a QR code');

    var bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(4, 4);
    put(bytes.length, ver <= 9 ? 8 : 16);
    bytes.forEach(function (b) { put(b, 8); });
    put(0, Math.min(4, capBits - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (var pad = 0xEC; bits.length < capBits; pad ^= 0xEC ^ 0x11) put(pad, 8);

    var data = [];
    for (var i = 0; i < bits.length; i += 8) {
      var v = 0;
      for (var j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      data.push(v);
    }
    return build(ver, ecl, interleave(data, ver, ecl));
  }

  function interleave(data, ver, ecl) {
    var numBlocks = NUM_BLOCKS[ecl][ver];
    var eccLen = ECC_PER_BLOCK[ecl][ver];
    var raw = Math.floor(rawModules(ver) / 8);
    var numShort = numBlocks - raw % numBlocks;
    var shortLen = Math.floor(raw / numBlocks);
    var div = rsDivisor(eccLen);
    var blocks = [];
    for (var i = 0, k = 0; i < numBlocks; i++) {
      var dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
      k += dat.length;
      var ecc = rsRemainder(dat, div);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    var out = [];
    for (var c = 0; c < blocks[0].length; c++) {
      for (var b = 0; b < blocks.length; b++) {
        if (c !== shortLen - eccLen || b >= numShort) out.push(blocks[b][c]);
      }
    }
    return out;
  }

  function alignmentPositions(ver, size) {
    if (ver === 1) return [];
    var n = Math.floor(ver / 7) + 2;
    var step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    var res = [6];
    for (var pos = size - 7; res.length < n; pos -= step) res.splice(1, 0, pos);
    return res;
  }

  function build(ver, ecl, codewords) {
    var size = ver * 4 + 17;
    var m = [], fn = [];
    for (var y = 0; y < size; y++) { m.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
    function set(x, y, dark) { m[y][x] = dark; fn[y][x] = true; }

    for (var i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(function (c) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var d = Math.max(Math.abs(dx), Math.abs(dy)), xx = c[0] + dx, yy = c[1] + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) set(xx, yy, d !== 2 && d !== 4);
      }
    });
    var ap = alignmentPositions(ver, size), last = ap.length - 1;
    ap.forEach(function (ax, a) {
      ap.forEach(function (ay, b) {
        if ((a === 0 && b === 0) || (a === 0 && b === last) || (a === last && b === 0)) return;
        for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      });
    });
    drawFormat(0);
    if (ver >= 7) {
      var rem = ver;
      for (var r = 0; r < 12; r++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var vbits = ver << 12 | rem;
      for (var q = 0; q < 18; q++) {
        var a2 = size - 11 + q % 3, b2 = Math.floor(q / 3);
        set(a2, b2, bit(vbits, q)); set(b2, a2, bit(vbits, q));
      }
    }

    function drawFormat(mask) {
      var data = FORMAT_BITS[ecl] << 3 | mask, rem = data;
      for (var t = 0; t < 10; t++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var bits = (data << 10 | rem) ^ 0x5412;
      for (var u = 0; u <= 5; u++) set(8, u, bit(bits, u));
      set(8, 7, bit(bits, 6)); set(8, 8, bit(bits, 7)); set(7, 8, bit(bits, 8));
      for (var w = 9; w < 15; w++) set(14 - w, 8, bit(bits, w));
      for (var p = 0; p < 8; p++) set(size - 1 - p, 8, bit(bits, p));
      for (var s = 8; s < 15; s++) set(8, size - 15 + s, bit(bits, s));
      set(8, size - 8, true);
    }

    var idx = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j, up = ((right + 1) & 2) === 0, yy2 = up ? size - 1 - vert : vert;
          if (!fn[yy2][x] && idx < codewords.length * 8) {
            m[yy2][x] = bit(codewords[idx >>> 3], 7 - (idx & 7));
            idx++;
          }
        }
      }
    }

    function applyMask(k) {
      for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) {
        if (fn[y][x]) continue;
        var inv;
        switch (k) {
          case 0: inv = (x + y) % 2 === 0; break;
          case 1: inv = y % 2 === 0; break;
          case 2: inv = x % 3 === 0; break;
          case 3: inv = (x + y) % 3 === 0; break;
          case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: inv = x * y % 2 + x * y % 3 === 0; break;
          case 6: inv = (x * y % 2 + x * y % 3) % 2 === 0; break;
          default: inv = ((x + y) % 2 + x * y % 3) % 2 === 0;
        }
        if (inv) m[y][x] = !m[y][x];
      }
    }

    var best = 0, bestScore = Infinity;
    for (var k = 0; k < 8; k++) {
      applyMask(k); drawFormat(k);
      var sc = penalty(m, size);
      if (sc < bestScore) { bestScore = sc; best = k; }
      applyMask(k);
    }
    applyMask(best); drawFormat(best);
    return { version: ver, ecl: ecl, mask: best, size: size, modules: m };
  }

  function penalty(m, size) {
    var score = 0, dark = 0;
    var finder = [true, false, true, true, true, false, true];
    function line(get) {
      var runColor = null, run = 0;
      for (var i = 0; i < size; i++) {
        var c = get(i);
        if (c === runColor) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else { runColor = c; run = 1; }
        if (i + 7 <= size) {
          var hit = true;
          for (var f = 0; f < 7 && hit; f++) if (get(i + f) !== finder[f]) hit = false;
          if (hit) {
            var lightBefore = true, lightAfter = true;
            for (var q = 1; q <= 4; q++) {
              if (i - q >= 0 && get(i - q)) lightBefore = false;
              if (i + 6 + q < size && get(i + 6 + q)) lightAfter = false;
            }
            if (lightBefore || lightAfter) score += 40;
          }
        }
      }
    }
    for (var y = 0; y < size; y++) line(function (x) { return m[y][x]; });
    for (var x = 0; x < size; x++) line(function (yy) { return m[yy][x]; });
    for (var a = 0; a < size - 1; a++) for (var b = 0; b < size - 1; b++) {
      var c = m[a][b];
      if (c === m[a][b + 1] && c === m[a + 1][b] && c === m[a + 1][b + 1]) score += 3;
    }
    for (var r = 0; r < size; r++) for (var s = 0; s < size; s++) if (m[r][s]) dark++;
    var total = size * size;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }

  /* SVG with a 4-module quiet zone; one path, crisp edges. */
  function toSvg(text, opts) {
    var o = opts || {};
    var q = encode(text, o.ecl);
    var border = o.border === undefined ? 4 : o.border;
    var dim = q.size + border * 2, d = '';
    for (var y = 0; y < q.size; y++) for (var x = 0; x < q.size; x++) {
      if (q.modules[y][x]) d += 'M' + (x + border) + ',' + (y + border) + 'h1v1h-1z';
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges">' +
      '<rect width="100%" height="100%" fill="' + (o.light || '#FFFFFF') + '"/>' +
      '<path d="' + d + '" fill="' + (o.dark || '#000000') + '"/></svg>';
  }

  var api = { encode: encode, toSvg: toSvg, dataCodewords: dataCodewords };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TMQR = api;
})(typeof window !== 'undefined' ? window : this);
