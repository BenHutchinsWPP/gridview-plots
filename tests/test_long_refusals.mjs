// tests/test_long_refusals.mjs — what the long reader refuses, and what it
// reads through. Every row it cannot read is refused with the reason, never
// loaded as a plausible number (AGENTS.md, "Ingest"):
//
//   1. a second year, a day its month lacks, a Feb 29 in a non-leap year,
//      a time other than midnight;
//   2. an hour that is not a whole number, a TOU that is neither label;
//   3. a value cell that is neither blank nor a number, a lone sign;
//   4. more fields than the header, and an empty or quoted identity;
//   5. two rows disagreeing about one hour's TOU, within a block or across;
//   6. padding, case and a spreadsheet's `1.0` read as the plain value;
//   7. a block of BLOCK_TARGET_BYTES always fits the parser's arena.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './test_loader.mjs';

const { entityHashes } = await import('../src/tables/long/header.ts');
const { instantiateParser, parseBytes, scanAxis } = await import('../src/tables/long/block.ts');
const { createAccumulator, blitBlock, BLOCK_TARGET_BYTES } =
  await import('../src/tables/long/pool.ts');

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

const wasmModule = new WebAssembly.Module(
  readFileSync(new URL('../parser/long/block.wasm', import.meta.url)),
);
const AXIS = ['A', 'B'];
const YEAR = 2035;

/** Scan and parse `rows` (Date,Hour,TOU,Name,M1,M2) as one block. */
async function parse(rows, { axis = AXIS, metrics = 2, year = YEAR } = {}) {
  const parser = await instantiateParser(wasmModule, entityHashes(axis));
  const bytes = new TextEncoder().encode(rows.join('\r\n') + '\r\n');
  const scan = scanAxis(parser, bytes, 0, bytes.length);
  const planes = Int32Array.from({ length: metrics }, (_, i) => i);
  return parseBytes(parser, bytes, 0, bytes.length, planes, axis.length, metrics, scan.rows, year);
}

/** One row's values, by entity index and hour of the year. */
function valuesAt(payload, entity, hour) {
  for (let r = 0; r < payload.rows; r++) {
    if (payload.rowEntity[r] === entity && payload.rowHour[r] === hour) {
      return Array.from(payload.values.subarray(r * payload.planes, (r + 1) * payload.planes));
    }
  }
  return undefined;
}

async function refuses(rows, pattern, what) {
  await assert.rejects(async () => parse(rows), pattern, `${what} must be refused`);
}

// ------------------------------------------------------------ 1. the calendar
await refuses(
  ['1/1/2035,1,OffPeak,A,1,2', '1/1/2036,2,OffPeak,A,3,4'],
  /year other than 2035/,
  'a row in a second year',
);
await refuses(['4/31/2035,1,OffPeak,A,1,2'], /could not read/, 'April 31');
await refuses(['2/30/2035,1,OffPeak,A,1,2'], /could not read/, 'February 30');
await refuses(['2/29/2035,1,OffPeak,A,1,2'], /could not read/, 'Feb 29 of a non-leap year');
await refuses(['1//2035,1,OffPeak,A,1,2'], /could not read/, 'a date with no day');
await refuses(['1/1/2035x,1,OffPeak,A,1,2'], /could not read/, 'a date with a trailing byte');
await refuses(
  ['1/1/2035 7:00,1,OffPeak,A,1,2'],
  /could not read/,
  'a date at a time past midnight',
);
await refuses(['1/1/2035 12:00 PM,1,OffPeak,A,1,2'], /could not read/, 'a date at noon');
for (const at of ['0:00', '00:00:00', '12:00:00 AM', '12:00 am']) {
  const one = await parse([`1/1/2035 ${at},1,OffPeak,A,1,2`]);
  assert.equal(one.rows, 1, `a date at ${at} reads as the date`);
}
{
  const leap = await parse(['2/29/2036,1,OffPeak,A,1,2', '3/1/2036,1,OffPeak,A,1,2'], {
    year: 2036,
  });
  assert.equal(leap.rows, 1, 'Feb 29 of a leap year is dropped, the other row kept');
}
ok(
  'a second year, a day its month lacks, a non-leap Feb 29 and a time past midnight are refused; leap Feb 29 dropped, midnight read as the date',
);

// ------------------------------------------------------------ 2. hour and TOU
for (const hour of ['13.5', '7:00', '', '1e1']) {
  await refuses([`1/1/2035,${hour},OffPeak,A,1,2`], /could not read/, `hour "${hour}"`);
}
for (const tou of ['', '"OnPeak"', 'Shoulder', 'On']) {
  await refuses([`1/1/2035,1,${tou},A,1,2`], /TOU other than OnPeak or OffPeak/, `TOU "${tou}"`);
}
ok('an hour that is not a whole number, and a TOU that is neither label, are refused');

// ------------------------------------------------------------ 3. value cells
for (const cell of ['N/A', '#VALUE!', 'NaN', '-', '.', 'e', '1e', '12.5x']) {
  await refuses(
    [`1/1/2035,1,OffPeak,A,${cell},2`],
    /neither blank nor a number/,
    `value "${cell}"`,
  );
}
ok('a value cell that is neither blank nor a number is refused, a lone sign included');

// --------------------------------------------------- 4. fields and identity
await refuses(
  ['1/1/2035,1,OffPeak,A,1,2,99'],
  /more fields than the header/,
  'a row with an extra field',
);
await refuses(
  ['1/1/2035,1,OffPeak,A,"1,5",2'],
  /more fields than the header/,
  'a quoted comma in a value',
);
await refuses(['1/1/2035,1,OffPeak,,1,2'], /empty or quoted entity field/, 'an empty identity');
await refuses(['1/1/2035,1,OffPeak,"A",1,2'], /empty or quoted entity field/, 'a quoted identity');
ok('an extra field, and an empty or quoted identity, are refused by name');

// ------------------------------------------------------------- 5. TOU clash
await assert.rejects(
  async () => {
    const payload = await parse(['1/1/2035,14,OnPeak,A,1,2', '1/1/2035,14,OffPeak,B,1,2']);
    const accumulator = createAccumulator(
      { metrics: ['M1', 'M2'], slabPlan: Int32Array.from([0, 1]), activePlanes: [0, 1] },
      AXIS.length,
    );
    blitBlock(accumulator, payload);
  },
  /Hour 13 of the year is OffPeak on one row and OnPeak/,
  'two entities disagreeing about one hour',
);
{
  const accumulator = createAccumulator(
    { metrics: ['M1', 'M2'], slabPlan: Int32Array.from([0, 1]), activePlanes: [0, 1] },
    AXIS.length,
  );
  blitBlock(accumulator, await parse(['1/1/2035,14,OnPeak,A,1,2']));
  const second = await parse(['1/1/2035,14,OffPeak,B,1,2']);
  assert.throws(() => blitBlock(accumulator, second), /OffPeak on one row and OnPeak/);

  // A repeated row is a duplicate first, whatever its TOU says.
  const again = await parse(['1/1/2035,14,OffPeak,A,1,2']);
  assert.throws(() => blitBlock(accumulator, again), /Two rows both describe/);
}
ok('two rows disagreeing about one hour are refused within a block and across blocks');

// ---------------------------------------------------------- 6. read through
{
  const payload = await parse([
    '1/1/2035, 1.0 , On-Peak ,  A , 12.5 ,-7E-05',
    ' 01/01/2035 ,2,off peak,B,,',
    '1/1/2035,3,OFFPEAK,A,+3',
  ]);
  assert.equal(payload.rows, 3);
  assert.deepEqual(valuesAt(payload, 0, 0), [12.5, Math.fround(-7e-5)]);
  assert.ok(valuesAt(payload, 1, 1).every(Number.isNaN), 'blank cells are absent');
  const short = valuesAt(payload, 0, 2);
  assert.equal(short[0], 3);
  assert.ok(Number.isNaN(short[1]), 'a short row leaves its missing cells absent');
  assert.deepEqual(Array.from(payload.rowTou), [1, 0, 0]);
}
ok('padding, case, dashes, `1.0` and a short row read as their plain values');

// ------------------------------------------------------------ 7. the arena
{
  // The densest arena use per byte: many retained cells, every one empty.
  const parser = await instantiateParser(wasmModule, entityHashes(['A']));
  const metrics = 1000;
  const emptyCells = ','.repeat(metrics);
  const lines = [];
  let bytes = 0;
  for (let hour = 0; bytes < BLOCK_TARGET_BYTES; hour++) {
    const month = Math.floor(hour / 24 / 28) + 1;
    const day = (Math.floor(hour / 24) % 28) + 1;
    const line = `${month}/${day}/2035,${(hour % 24) + 1},OnPeak,A${emptyCells}`;
    lines.push(line);
    bytes += line.length + 2;
  }
  const block = new TextEncoder().encode(lines.join('\r\n') + '\r\n');
  const scan = scanAxis(parser, block, 0, block.length);
  const planes = Int32Array.from({ length: metrics }, (_, i) => i);
  const payload = parseBytes(parser, block, 0, block.length, planes, 1, metrics, scan.rows, YEAR);
  assert.equal(payload.rows, lines.length);
  assert.ok(
    parser.arena_bytes() >= 4 * (BLOCK_TARGET_BYTES + 1024 * 1024),
    `a block of whole rows needs up to 4x its bytes: a ${parser.arena_bytes()} B arena ` +
      `cannot hold every ${BLOCK_TARGET_BYTES} B block plus its overhanging row`,
  );
  ok(`a ${BLOCK_TARGET_BYTES} B block of ${metrics} empty cells per row fits the arena`);
}

console.log(`\n${checks} checks passed`);
