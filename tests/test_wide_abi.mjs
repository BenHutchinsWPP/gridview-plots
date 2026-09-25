// tests/test_wide_abi.mjs — the mechanism that keeps the shared wide reader
// from drifting into a dispatcher on kind: its ABI carries NO KIND TOKEN,
// only numbers about bytes and offsets, so `if (kind == BUS)` requires an
// ABI change in the open (AGENTS.md). It asserts that `parser/wide/block.wasm`:
//
//   1. imports nothing (a host callback is another way a kind could cross);
//   2. exports exactly the manifest below, every parameter a described NUMBER;
//   3. takes no pointer-to-char or enum in any exported C function.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WASM = new URL('../parser/wide/block.wasm', import.meta.url);
const SOURCE = new URL('../parser/wide/block.c', import.meta.url);

/** The rule, worded for someone adding a kind whose flag looks reasonable. */
const RULE =
  '\n' +
  "  THE WIDE MODULE'S ABI CARRIES NO KIND TOKEN (AGENTS.md).\n" +
  '  Every value crossing into parser/wide/ is a NUMBER describing bytes and\n' +
  '  offsets: preamble depth, header line index, key column count, slab width,\n' +
  '  row count. No enum, no string, no id naming a kind.\n' +
  '\n' +
  '  ANYTHING THAT CANNOT BE EXPRESSED AS A NUMBER BELONGS IN\n' +
  '  src/tables/<kind>/, NOT IN THE READER. That is where the bus id row is\n' +
  '  read, where an axis becomes an Int32 rather than a name, and where every\n' +
  '  aggregation rule lives.\n' +
  '\n' +
  '  If the surface genuinely must grow, the growth is allowed -- but it is\n' +
  '  allowed IN THE OPEN: add the export here with the number it means, bump\n' +
  '  ABI_VERSION in parser/wide/block.c and PARSER_ABI in\n' +
  '  src/tables/wide/block.ts, and say in review what kind-independent quantity\n' +
  '  the new parameter is.\n';

/** The module's whole exported surface: name, arity (read from `fn.length`,
 * so an unused added argument still fails), and what each parameter means as
 * a number. */
const SURFACE = {
  // Pointers into linear memory: byte offsets.
  inbuf_ptr: [],
  slab_ptr: [],
  row_hour_ptr: [],
  row_tou_ptr: [],
  // Byte budgets this build was compiled with.
  inbuf_size: [],
  arena_bytes: [],
  // The layout `configure` last established.
  slab_rows: [],
  slab_metrics: [],
  // The ABI this binary speaks.
  abi_version: [],
  // Counters from the last `parse_block`, all row counts.
  last_rows: [],
  last_overflow: [],
  last_wide_field: [],
  last_bad_row: [],
  last_feb29: [],
  last_year_mismatch: [],
  // Lay the arena out as `numMetrics` planes x `maxRows` rows.
  configure: [
    "numMetrics: slab planes, the file's own entity column count",
    'maxRows: rows the arena holds at that width',
  ],
  // Clear `rows` rows of the configured slab to NaN.
  slab_fill_nan: ['rows: rows of the configured slab to clear'],
  // Parse `len` bytes of the input window as rows of calendar year `year`.
  parse_block: ['len: bytes in the input window', "year: the case's calendar year"],
};

const module = new WebAssembly.Module(readFileSync(WASM));

// ---------------------------------------------------------------- 1. imports

const imports = WebAssembly.Module.imports(module);
assert.deepEqual(
  imports,
  [],
  `parser/wide/block.wasm imports ${imports.length} thing(s) from the host: ` +
    `${imports.map((i) => `${i.module}.${i.name}`).join(', ')}. A freestanding ` +
    `reader imports nothing, and a host callback is the other way a kind could ` +
    `reach into it.${RULE}`,
);
console.log('ok - the wide module imports nothing from the host');

// ---------------------------------------------------------------- 2. surface

const instance = new WebAssembly.Instance(module, {});
const exported = WebAssembly.Module.exports(module);

const memories = exported.filter((e) => e.kind === 'memory').map((e) => e.name);
assert.deepEqual(memories, ['memory'], 'the module exports exactly its linear memory');

// A global or a table crossing out is not a number the caller reads -- it is
// state the two sides would have to agree about the MEANING of, which is
// exactly where a kind token would hide.
const others = exported.filter((e) => e.kind !== 'memory' && e.kind !== 'function');
assert.deepEqual(
  others,
  [],
  `the wide module exports ${others.map((e) => `${e.kind} ${e.name}`).join(', ')} ` +
    `beyond its memory and its functions.${RULE}`,
);

const functions = exported
  .filter((e) => e.kind === 'function')
  .map((e) => e.name)
  .sort();
assert.deepEqual(
  functions,
  Object.keys(SURFACE).sort(),
  `the wide module's exported functions are not the surface this file records.${RULE}`,
);
console.log(`ok - the exported surface is exactly the ${functions.length} functions recorded here`);

for (const [name, params] of Object.entries(SURFACE)) {
  const fn = instance.exports[name];
  assert.equal(typeof fn, 'function', `${name} is exported as a function`);
  assert.equal(
    fn.length,
    params.length,
    `${name} takes ${fn.length} argument(s), but this file records ${params.length}: ` +
      `${params.join('; ') || '(none)'}.${RULE}`,
  );
  // Every wasm value type is numeric, so what is actually being asserted is
  // that each argument has a number's MEANING recorded above -- and that a new
  // one cannot be added without writing that meaning down.
  for (const meaning of params) {
    assert.ok(
      /^[a-zA-Z]+: /.test(meaning),
      `${name}: every parameter must be recorded as "<name>: <the number it means>".${RULE}`,
    );
  }
}
console.log('ok - every parameter of every export is recorded as the number it means');

// A number is what comes back, too: a return that is not a number is a
// pointer the caller has to interpret, and interpretation is where meaning
// (and then kind) creeps in.
const returns = ['abi_version', 'inbuf_size', 'arena_bytes', 'slab_rows', 'slab_metrics'];
for (const name of returns) {
  assert.equal(typeof instance.exports[name](), 'number', `${name}() returns a number`);
}
console.log('ok - the readable exports return numbers');

// ---------------------------------------------------------------- 3. the C

const source = readFileSync(SOURCE, 'utf8');

// Exported functions are the non-static ones (`--export-dynamic`);
// `export_name` attributes are stripped first so those are scanned too.
const declarations = source.replace(/__attribute__\s*\(\([^)]*\([^)]*\)[^)]*\)\)/g, '');
const definitions = [
  ...declarations.matchAll(
    /^[ \t]*(?!static\b)([A-Za-z_][A-Za-z0-9_ *]*?)\s+\*?([a-z_][a-z0-9_]*)\(([^)]*)\)\s*\{/gm,
  ),
];
const scanned = definitions.map(([, , name]) => name).filter((name) => name in SURFACE);
// The scan is only worth anything if it actually reaches the exports. A regex
// that silently matches nothing is a check that silently passes.
assert.ok(
  scanned.length >= Object.keys(SURFACE).length,
  `the source scan reached ${scanned.length} of ${Object.keys(SURFACE).length} exported ` +
    `definitions in parser/wide/block.c (${scanned.join(', ')}). Fix the scan rather than ` +
    `lowering this bound -- an unread export is an unchecked one.`,
);

for (const [, , name, params] of definitions) {
  if (!(name in SURFACE)) continue;
  assert.ok(
    !/\bchar\s*\*|\bconst\s+char\b|\benum\b/.test(params),
    `parser/wide/block.c's exported ${name}(${params.trim()}) takes a string or an enum. ` +
      `That is a kind token in everything but name.${RULE}`,
  );
}

// The same two shapes must not appear anywhere in the file's own declarations
// either: an enum declared here is one `configure()` argument away from being
// passed in.
assert.ok(
  !/^\s*(typedef\s+)?enum\b/m.test(source),
  `parser/wide/block.c declares an enum. A shape reader has nothing to enumerate; ` +
    `the first enum here is the first kind token.${RULE}`,
);
console.log('ok - no exported C function takes a string or an enum, and the file declares none');

console.log(`\n5 checks passed.`);
