/* QR encoder: checked against published ISO 18004 constants, and by reading
   every generated symbol back (format bits, unmask, de-interleave,
   Reed-Solomon syndromes, byte-mode payload). */
const qr = require('../public/qr.js');

/* ---- independent read-back ---- */

function gfTables() {
  const exp = new Array(512), log = new Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) { exp[i] = x; log[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
  return { exp, log };
}
const GF = gfTables();
const mul = (a, b) => (a && b ? GF.exp[GF.log[a] + GF.log[b]] : 0);

function syndromesZero(block, eccLen) {
  for (let i = 0; i < eccLen; i++) {
    let s = 0;
    for (const c of block) s = mul(s, GF.exp[i]) ^ c;
    if (s !== 0) return false;
  }
  return true;
}

function functionMask(size, ver) {
  const fn = [];
  for (let y = 0; y < size; y++) fn.push(new Array(size).fill(false));
  const mark = (x, y) => { if (x >= 0 && y >= 0 && x < size && y < size) fn[y][x] = true; };
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    mark(x, y);
    if (x < 8) mark(size - 1 - x, y);
    if (y < 8) mark(x, size - 1 - y);
  }
  if (ver > 1) {
    const n = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const pos = [6];
    for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
    pos.forEach((ax, a) => pos.forEach((ay, b) => {
      if ((a === 0 && b === 0) || (a === 0 && b === n - 1) || (a === n - 1 && b === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(ax + dx, ay + dy);
    }));
  }
  if (ver >= 7) for (let i = 0; i < 18; i++) { mark(size - 11 + i % 3, Math.floor(i / 3)); mark(Math.floor(i / 3), size - 11 + i % 3); }
  return fn;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
  (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0
];

function readFormat(m) {
  let bits = 0;
  const seq = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  seq.forEach(([x, y], i) => { if (m[y][x]) bits |= 1 << i; });
  return bits;
}

function decode(sym, blocksSpec) {
  const { size, modules: m, version: ver } = sym;
  const fmt = readFormat(m) ^ 0x5412;
  const mask = (fmt >> 10) & 7;
  const fn = functionMask(size, ver);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
      if (!fn[y][x]) bits.push(m[y][x] !== MASKS[mask](x, y) ? 1 : 0);
    }
  }
  const total = Math.floor(bits.length / 8);
  const cw = [];
  for (let i = 0; i < total; i++) { let b = 0; for (let k = 0; k < 8; k++) b = (b << 1) | bits[i * 8 + k]; cw.push(b); }
  const { numBlocks, eccLen } = blocksSpec;
  const numShort = numBlocks - total % numBlocks, shortLen = Math.floor(total / numBlocks);
  const blocks = [];
  for (let b = 0; b < numBlocks; b++) blocks.push([]);
  let p = 0;
  for (let c = 0; c < shortLen - eccLen; c++) for (let b = 0; b < numBlocks; b++) blocks[b].push(cw[p++]);
  for (let b = numShort; b < numBlocks; b++) blocks[b].push(cw[p++]);
  for (let c = 0; c < eccLen; c++) for (let b = 0; b < numBlocks; b++) blocks[b].push(cw[p++]);
  const rsOk = blocks.every((bl) => syndromesZero(bl, eccLen));
  const data = [].concat(...blocks.map((bl) => bl.slice(0, bl.length - eccLen)));
  const dbits = [];
  data.forEach((b) => { for (let k = 7; k >= 0; k--) dbits.push((b >> k) & 1); });
  let q = 0;
  const take = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | dbits[q++]; return v; };
  const mode = take(4);
  const len = take(ver <= 9 ? 8 : 16);
  const out = [];
  for (let i = 0; i < len; i++) out.push(take(8));
  return { fmt: readFormat(m), mode, rsOk, text: Buffer.from(out).toString('utf8') };
}

const SPEC = {
  M: { blocks: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49] }
};
function eccLenM(ver) {
  const raw = (() => { let r = (16 * ver + 128) * ver + 64; if (ver >= 2) { const n = Math.floor(ver / 7) + 2; r -= (25 * n - 10) * n - 55; if (ver >= 7) r -= 36; } return Math.floor(r / 8); })();
  return (raw - qr.dataCodewords(ver, 'M')) / SPEC.M.blocks[ver];
}

describe('qr encoder', () => {
  it('matches published data capacities', () => {
    assert.eq([1, 2, 5, 10, 15, 40].map((v) => qr.dataCodewords(v, 'M')), [16, 28, 86, 216, 415, 2334]);
    assert.eq([1, 2, 10, 40].map((v) => qr.dataCodewords(v, 'L')), [19, 34, 274, 2956]);
  });

  it('writes the standard format string for M / mask 0 and L / mask 0', () => {
    const forMask = (text, ecl) => { const s = qr.encode(text, ecl); return { s, f: readFormat(s.modules) }; };
    const table = { 'M0': 0b101010000010010, 'L0': 0b111011111000100 };
    for (let i = 0; i < 200; i++) {
      const { s, f } = forMask('probe-' + i, i % 2 ? 'L' : 'M');
      if (s.mask === 0) { assert.eq(f, table[s.ecl + '0'], s.ecl + ' mask 0 format'); return; }
    }
    throw new Error('no mask-0 sample found');
  });

  it('writes the standard version block for version 7', () => {
    const s = qr.encode('x'.repeat(110), 'M');
    assert.eq(s.version, 7);
    let v = 0;
    for (let i = 0; i < 18; i++) if (s.modules[Math.floor(i / 3)][s.size - 11 + i % 3]) v |= 1 << i;
    assert.eq(v, 0x07C94);
  });

  it('round-trips wallet links of every size through an independent reader', () => {
    const samples = [
      'A',
      'openid4vp://authorize?client_id=did%3Aweb%3Acredenceid.com%3Acloudsdk%2Fplayground&request_uri=https%3A%2F%2Fcredenceid.com%2Fcloudsdk%2Fplayground%2Fw3c%2Fopenid4vp%2Fv1%2Frequest%2F3f2a9c1e-77b0-4d1a-9f0e-2b6c8d4e1a55',
      'mdoc-openid4vp://?request_uri=' + encodeURIComponent('https://credenceid.com/cloudsdk/playground/openid4vp/v1/mdoc/request/' + 'a'.repeat(64)) + '&client_id=x509_san_dns%3Acredenceid.com',
      'Ünïcødé ✓ ' + 'z'.repeat(300),
      'q'.repeat(1200)
    ];
    samples.forEach((t) => {
      const s = qr.encode(t, 'M');
      const d = decode(s, { numBlocks: SPEC.M.blocks[s.version], eccLen: eccLenM(s.version) });
      assert.eq(d.mode, 4, 'byte mode');
      assert.ok(d.rsOk, 'Reed-Solomon syndromes are zero (v' + s.version + ')');
      assert.eq(d.text, t);
      assert.eq((d.fmt ^ 0x5412) >> 13, 0, 'ECC level M');
    });
  });

  it('renders an SVG with a quiet zone', () => {
    const svg = qr.toSvg('hello');
    assert.ok(svg.indexOf('viewBox="0 0 29 29"') > 0, '21 modules + 2x4 quiet zone');
    assert.ok(svg.indexOf('<path d="M') > 0);
  });
});
