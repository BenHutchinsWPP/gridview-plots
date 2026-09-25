// scripts/sync-wasm.mjs
//
// parser/<shape>/block.wasm is a COMMITTED BINARY (rebuilding needs clang 18
// + wasm-ld from lld-18, which CI does not have). This script copies each
// shape's committed binary into public/ so Vite emits it at
// dist/<name>-block.wasm, where the matching pool.ts fetches it by that name.
//
// `--check` verifies the public/ copy is byte-identical to its parser/
// source without writing anything, and is invoked explicitly -- it is NOT
// wired into `pretest`/`predev`/`prebuild`. Those run this script plain, so
// they refresh a stale copy rather than refusing it: public/ is gitignored
// and absent on a fresh clone, where --check would fail every first run.
//
// The two pairs below are independent: each shape's ABI_VERSION/PARSER_ABI is
// its own and this script never compares one shape's binary to the other's.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');

const pairs = [
  ['parser/long/block.wasm', 'public/long-block.wasm'],
  ['parser/wide/block.wasm', 'public/wide-block.wasm'],
];

function sameFile(source, target) {
  if (!existsSync(target)) return false;
  const left = readFileSync(source);
  const right = readFileSync(target);
  return left.length === right.length && left.equals(right);
}

for (const [sourceRel, targetRel] of pairs) {
  const source = resolve(root, sourceRel);
  const target = resolve(root, targetRel);

  if (!existsSync(source)) {
    throw new Error(`${sourceRel} is missing; build the parser before starting the app.`);
  }

  if (checkOnly) {
    if (!sameFile(source, target)) {
      throw new Error(`${targetRel} is missing or stale; run npm run sync-wasm.`);
    }
  } else if (!sameFile(source, target)) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}
