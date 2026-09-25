// tests/test_assets.mjs
//
// Asserts every parser/<kind>/block.wasm committed binary is byte-identical
// to its public/<kind>-block.wasm copy, alongside `scripts/sync-wasm.mjs
// --check`. Run this AFTER `npm run sync-wasm` (or `npm run prebuild`) has
// populated public/ -- it does not itself copy anything.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pairs = [
  ['area', '../parser/long/block.wasm', '../public/long-block.wasm'],
  ['wide', '../parser/wide/block.wasm', '../public/wide-block.wasm'],
];

for (const [kind, parserRel, publicRel] of pairs) {
  const parserWasm = readFileSync(new URL(parserRel, import.meta.url));
  const publicWasm = readFileSync(new URL(publicRel, import.meta.url));
  assert.equal(
    publicWasm.length,
    parserWasm.length,
    `${kind}: served wasm has the same size as ${parserRel}`,
  );
  assert.ok(
    publicWasm.equals(parserWasm),
    `${kind}: served wasm is byte-identical to ${parserRel}`,
  );
}

console.log(
  'ok - long-block.wasm and wide-block.wasm are present for Vite dev and match their parser binaries',
);
