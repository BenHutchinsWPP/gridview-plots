// tests/test_figure_dpi.mjs — the resolution a PNG or JPEG figure carries
// (src/figure/dpi.ts), read back from the bytes as Word would read them.
//
//   * A stamped PNG reports 300 dpi in a pHYs chunk right after IHDR, and
//     every chunk's CRC is valid; restamping replaces, never adds.
//   * A caption with ≥ and − round-trips through an iTXt Description.
//   * A JPEG reports 300 dpi whether or not its encoder wrote a JFIF APP0.

import assert from 'node:assert/strict';
import { crc32 as zlibCrc, deflateSync } from 'node:zlib';
import './test_loader.mjs';

const { stampPng, stampJpeg } = await import('../src/figure/dpi.ts');

const checks = [];
const ok = (name, fn) => checks.push([name, fn]);

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function chunk(type, data) {
  const body = Buffer.from([...Buffer.from(type, 'latin1'), ...data]);
  return [...be32(data.length), ...body, ...be32(zlibCrc(body))];
}
/** A 1 × 1 RGBA PNG, as a canvas encoder might write it. */
function png(extra = []) {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', [...be32(1), ...be32(1), 8, 6, 0, 0, 0]),
    ...extra,
    ...chunk('IDAT', [...deflateSync(Buffer.from([0, 10, 20, 30, 255]))]),
    ...chunk('IEND', []),
  ]);
}

/** Every chunk, with whether its CRC checks. */
function chunks(bytes) {
  const out = [];
  let at = 8;
  const view = Buffer.from(bytes);
  while (at < view.length) {
    const length = view.readUInt32BE(at);
    const type = view.toString('latin1', at + 4, at + 8);
    const data = view.subarray(at + 8, at + 8 + length);
    const crc = view.readUInt32BE(at + 8 + length);
    out.push({ type, data, crcOk: crc === zlibCrc(view.subarray(at + 4, at + 8 + length)) });
    at += 12 + length;
  }
  return out;
}

const dpiOf = (phys) => {
  const view = Buffer.from(phys.data);
  assert.equal(view[8], 1, 'unit: metre');
  assert.equal(view.readUInt32BE(0), view.readUInt32BE(4), 'square pixels');
  return view.readUInt32BE(0) * 0.0254;
};

ok('a stamped PNG reports 300 dpi in a pHYs right after IHDR, every CRC valid', () => {
  const stamped = chunks(stampPng(png(), 300));
  assert.deepEqual(
    stamped.map((c) => c.type),
    ['IHDR', 'pHYs', 'IDAT', 'IEND'],
  );
  assert.ok(
    stamped.every((c) => c.crcOk),
    'every chunk CRC checks',
  );
  assert.equal(stamped[1].data.readUInt32BE(0), 11811, '11,811 px/m');
  assert.equal(Math.round(dpiOf(stamped[1])), 300);
});

ok('restamping replaces the pHYs and the caption rather than adding a second', () => {
  const foreign = chunk('pHYs', [...be32(2835), ...be32(2835), 1]);
  const once = stampPng(png(foreign), 300, 'first');
  const twice = chunks(stampPng(once, 300, 'second'));
  assert.equal(twice.filter((c) => c.type === 'pHYs').length, 1);
  assert.equal(Math.round(dpiOf(twice.find((c) => c.type === 'pHYs'))), 300);
  const captions = twice.filter((c) => c.type === 'iTXt');
  assert.equal(captions.length, 1);
  assert.match(captions[0].data.toString('utf8'), /second$/);
  assert.ok(twice.every((c) => c.crcOk));
});

ok('a caption with ≥ and − round-trips through an iTXt Description', () => {
  const caption = 'Power Flow, Max ≥ 500, −12 MW floor';
  const stamped = chunks(stampPng(png(), 300, caption));
  const itxt = stamped.find((c) => c.type === 'iTXt');
  assert.ok(itxt, 'an iTXt chunk');
  // keyword NUL, compression flag, method, language NUL, translated NUL, text
  const data = itxt.data;
  const keyEnd = data.indexOf(0);
  assert.equal(data.toString('latin1', 0, keyEnd), 'Description');
  assert.equal(data[keyEnd + 1], 0, 'uncompressed');
  const langEnd = data.indexOf(0, keyEnd + 3);
  const transEnd = data.indexOf(0, langEnd + 1);
  assert.equal(data.subarray(transEnd + 1).toString('utf8'), caption);
  assert.ok(!stamped.some((c) => c.type === 'tEXt'), 'never Latin-1 tEXt');
  assert.ok(stamped.every((c) => c.crcOk));
});

// A minimal JPEG: SOI, optional APP0, a quantisation table, the scan, EOI.
const DQT = [0xff, 0xdb, 0, 67, 0, ...new Array(64).fill(1)];
const SCAN = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x12, 0x34, 0xff, 0xd9];
const jfif = (units, density) => [
  0xff,
  0xe0,
  0,
  16,
  ...Buffer.from('JFIF\0', 'latin1'),
  1,
  1,
  units,
  density >> 8,
  density & 255,
  density >> 8,
  density & 255,
  0,
  0,
];

/** The JFIF units and densities, found as a reader finds them. */
function jfifOf(bytes) {
  const view = Buffer.from(bytes);
  assert.equal(view.readUInt16BE(0), 0xffd8, 'SOI');
  let at = 2;
  while (view[at] === 0xff && view[at + 1] !== 0xda) {
    const length = view.readUInt16BE(at + 2);
    if (view[at + 1] === 0xe0 && view.toString('latin1', at + 4, at + 9) === 'JFIF\0') {
      return {
        at,
        units: view[at + 11],
        x: view.readUInt16BE(at + 12),
        y: view.readUInt16BE(at + 14),
      };
    }
    at += 2 + length;
  }
  return null;
}

ok('a JPEG with a JFIF APP0 reports 300 dpi, the rest of the file untouched', () => {
  const source = Uint8Array.from([0xff, 0xd8, ...jfif(0, 1), ...DQT, ...SCAN]);
  const stamped = stampJpeg(source, 300);
  assert.deepEqual(jfifOf(stamped), { at: 2, units: 1, x: 300, y: 300 });
  assert.equal(stamped.length, source.length, 'patched in place');
  assert.deepEqual([...stamped.subarray(20)], [...source.subarray(20)]);
});

ok('a JPEG without APP0 gets one after SOI and reports 300 dpi', () => {
  const source = Uint8Array.from([0xff, 0xd8, ...DQT, ...SCAN]);
  const stamped = stampJpeg(source, 300);
  assert.deepEqual(jfifOf(stamped), { at: 2, units: 1, x: 300, y: 300 });
  assert.deepEqual([...stamped.subarray(20)], [...source.subarray(2)], 'the rest follows');
});

let passed = 0;
for (const [name, fn] of checks) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}
console.log(`\n${passed} checks passed`);
