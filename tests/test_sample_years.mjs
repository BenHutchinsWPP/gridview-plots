// tests/test_sample_years.mjs — a long file's years from its first and last
// rows, for the Import Dialog (src/tables/long/sample-years.ts):
//
//   1. `readDate` reads a Date cell exactly as the C reader's axis scan does:
//      the same cells read, to the same year, and the same cells refused;
//   2. a sample in date order is the file's span; a sample out of order is
//      only the years it shows; a file read whole is its span in any order;
//   3. the header line and the rows a chunk cuts are never read as dates.
//
// Run: node tests/test_sample_years.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './test_loader.mjs';

const { readDate, sampleYears } = await import('../src/tables/long/sample-years.ts');
const { instantiateParser, scanAxis } = await import('../src/tables/long/block.ts');
const { entityHashes } = await import('../src/tables/long/header.ts');

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

// ------------------------------------------------------------ 1. parity
const wasmModule = new WebAssembly.Module(
  readFileSync(new URL('../parser/long/block.wasm', import.meta.url)),
);
const parser = await instantiateParser(wasmModule, entityHashes(['A']));
/** The year the C axis scan counts a one-row file's Date toward, or null. */
function scannedYear(cell) {
  const bytes = new TextEncoder().encode(`${cell},1,OffPeak,A,1\r\n`);
  const { minYear } = scanAxis(parser, bytes, 0, bytes.length);
  return Number.isNaN(minYear) ? null : minYear;
}
const CELLS = [
  '1/1/2035',
  '12/31/2045',
  '01/01/2035',
  ' 1/1/2035 ',
  '2/29/2036',
  '2/29/2035',
  '2/29/2100',
  '2/29/2000',
  '4/31/2035',
  '13/1/2035',
  '0/1/2035',
  '1/0/2035',
  '1//2035',
  '1/1/',
  'a/1/2035',
  '1/1/2035x',
  '2035-01-01',
  '1/1/2035 0:00',
  '1/1/2035 00:00:00',
  '1/1/2035 12:00:00 AM',
  '1/1/2035 12:00 am',
  '1/1/2035 12:00AM',
  '1/1/2035\t0:00',
  '1/1/2035 7:00',
  '1/1/2035 12:00 PM',
  '1/1/2035 12:00',
  '1/1/2035 0:00 AM',
  '1/1/2035 0:01',
  '',
];
for (const cell of CELLS) {
  assert.equal(readDate(cell)?.year ?? null, scannedYear(cell), `"${cell}" reads as the C reader`);
}
ok(`every one of ${CELLS.length} Date cells reads to the year the C axis scan counts, or neither`);

// ------------------------------------------------------------ 2. order
const HEADER = 'Date,Hour,TOU,Name,Load (MW)';
const bytesOf = (lines) => new TextEncoder().encode(lines.join('\r\n') + '\r\n');
const row = (date) => `${date},1,OffPeak,A,1`;

assert.deepEqual(
  sampleYears(
    bytesOf([HEADER, row('1/1/2035'), row('1/2/2035')]),
    bytesOf(['35,1,OffPeak,A,1', row('12/31/2037')]),
  ),
  { firstYear: 2035, numYears: 3, whole: true },
  'rows in date order: the first and last rows are the span',
);
assert.deepEqual(
  sampleYears(
    bytesOf([HEADER, row('6/1/2036'), row('1/1/2035')]),
    bytesOf(['35,1,OffPeak,A,1', row('12/31/2035')]),
  ),
  { firstYear: 2035, numYears: 2, whole: false },
  'rows out of order: only the years shown',
);
assert.deepEqual(
  sampleYears(bytesOf([HEADER, row('12/31/2045'), row('1/1/2045')]), null),
  { firstYear: 2045, numYears: 1, whole: true },
  'a file read whole is its span in any order',
);
assert.equal(sampleYears(bytesOf([HEADER]), null), undefined, 'no row, no years');
ok('a sample in date order is a span, one out of order is the years it shows');

// ------------------------------------------------------------ 3. cut rows
{
  // The head chunk ends inside a row dated 2099; the tail chunk starts in one.
  const head = new TextEncoder().encode(`${HEADER}\r\n${row('1/1/2035')}\r\n1/1/20`);
  const tail = new TextEncoder().encode(`99,1,OffPeak,A,1\r\n${row('12/31/2035')}\r\n`);
  assert.deepEqual(sampleYears(head, tail), { firstYear: 2035, numYears: 1, whole: true });
  // A header whose first cell reads as a date is still the header.
  const dated = new TextEncoder().encode(`1/1/2099,Hour\r\n${row('1/1/2035')}\r\n`);
  assert.deepEqual(sampleYears(dated, null), { firstYear: 2035, numYears: 1, whole: true });
}
ok('the header and a row either chunk cuts are not read as dates');

console.log(`\n${checks} sample-years checks passed.`);
