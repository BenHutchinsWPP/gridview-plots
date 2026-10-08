// tests/test_long_refusals.mjs — what the long reader refuses, and what it
// reads through. Every row it cannot read is refused with the reason, never
// loaded as a plausible number (AGENTS.md, "Ingest"):
//
//   1. a row outside the Case's years, a day its month lacks, a Feb 29 in a
//      non-leap year, a time other than midnight; a leap Feb 29 is kept at
//      its fixed slot and a span of years places each row in its own;
//   2. an hour that is not a whole number, a TOU that is neither label;
//   3. a value cell that is neither blank nor a number, a lone sign;
//   4. more fields than the header, and an empty or quoted identity;
//   5. two rows disagreeing about one hour's TOU, within a block or across;
//   6. padding, case and a spreadsheet's `1.0` read as the plain value;
//   7. a block of BLOCK_TARGET_BYTES always fits the parser's arena;
//   8. the axis scan counts rows per year, past where a u16 hour would wrap,
//      and the blit places each row at its year's offset in the span cube.

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
async function parse(rows, { axis = AXIS, metrics = 2, year = YEAR, numYears = 1 } = {}) {
  const parser = await instantiateParser(wasmModule, entityHashes(axis));
  const bytes = new TextEncoder().encode(rows.join('\r\n') + '\r\n');
  const scan = scanAxis(parser, bytes, 0, bytes.length);
  const planes = Int32Array.from({ length: metrics }, (_, i) => i);
  return parseBytes(
    parser,
    bytes,
    0,
    bytes.length,
    planes,
    axis.length,
    metrics,
    scan.rows,
    year,
    numYears,
  );
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
  /1 row\(s\) are dated outside 2035, which this Case covers/,
  'a row in a later year',
);
await refuses(
  ['1/1/2035,1,OffPeak,A,1,2', '12/31/2034,24,OffPeak,A,3,4'],
  /dated outside 2035,/,
  'a row in an earlier year',
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
  // Every year is a fixed 8,784-hour leap slot: Feb 29 is day 59 whether or
  // not the year has one, so Mar 1 is the same hour in both.
  const leap = await parse(
    ['2/29/2036,1,OffPeak,A,1,2', '2/29/2036,24,OffPeak,A,3,4', '3/1/2036,1,OffPeak,A,5,6'],
    { year: 2036 },
  );
  assert.equal(leap.rows, 3, 'Feb 29 of a leap year is kept');
  assert.deepEqual(valuesAt(leap, 0, 1416), [1, 2], 'Feb 29 hour-ending 1 is slot hour 1416');
  assert.deepEqual(valuesAt(leap, 0, 1439), [3, 4], 'Feb 29 hour-ending 24 is slot hour 1439');
  assert.deepEqual(valuesAt(leap, 0, 1440), [5, 6], 'Mar 1 follows at 1440');
  const plain = await parse(['3/1/2035,1,OffPeak,A,5,6', '12/31/2035,24,OffPeak,A,7,8']);
  assert.deepEqual(valuesAt(plain, 0, 1440), [5, 6], 'Mar 1 of a non-leap year is 1440 too');
  assert.deepEqual(valuesAt(plain, 0, 8783), [7, 8], 'Dec 31 hour-ending 24 is the last slot hour');
}
{
  // A Case of several years places each row in its own, by offset.
  const span = await parse(
    ['12/31/2032,24,OffPeak,A,1,2', '1/1/2030,1,OffPeak,B,3,4', '2/29/2032,1,OffPeak,A,5,6'],
    { year: 2030, numYears: 3 },
  );
  assert.equal(span.rows, 3);
  assert.deepEqual(Array.from(span.rowYear), [2, 0, 2], 'each row carries its year offset');
  assert.deepEqual(Array.from(span.rowHour), [8783, 0, 1416], 'the hour stays within its year');
  await assert.rejects(
    () =>
      parse(['1/1/2030,1,OffPeak,A,1,2', '1/1/2033,1,OffPeak,A,1,2'], { year: 2030, numYears: 3 }),
    /1 row\(s\) are dated outside 2030-2032/,
    'a row past the last year must be refused, naming the span',
  );
}
ok(
  'a row outside the Case years, a day its month lacks, a non-leap Feb 29 and a time past midnight are refused; leap Feb 29 kept at 1416..1439, each year placed by offset, midnight read as the date',
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
      { firstYear: YEAR, numYears: 1 },
    );
    blitBlock(accumulator, payload);
  },
  /Hour 13 of 2035 \(Jan 1, hour ending 14\) is OffPeak on one row and OnPeak/,
  'two entities disagreeing about one hour',
);
{
  const accumulator = createAccumulator(
    { metrics: ['M1', 'M2'], slabPlan: Int32Array.from([0, 1]), activePlanes: [0, 1] },
    AXIS.length,
    { firstYear: YEAR, numYears: 1 },
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
  const payload = parseBytes(
    parser,
    block,
    0,
    block.length,
    planes,
    1,
    metrics,
    scan.rows,
    YEAR,
    1,
  );
  assert.equal(payload.rows, lines.length);
  assert.ok(
    parser.arena_bytes() >= 4 * (BLOCK_TARGET_BYTES + 1024 * 1024),
    `a block of whole rows needs up to 4x its bytes: a ${parser.arena_bytes()} B arena ` +
      `cannot hold every ${BLOCK_TARGET_BYTES} B block plus its overhanging row`,
  );
  ok(`a ${BLOCK_TARGET_BYTES} B block of ${metrics} empty cells per row fits the arena`);
}

// ----------------------------------------------------- 8. years in the scan
const TWO_METRICS = {
  metrics: ['M1', 'M2'],
  slabPlan: Int32Array.from([0, 1]),
  activePlanes: [0, 1],
};
async function scanOf(rows) {
  const parser = await instantiateParser(wasmModule, entityHashes(AXIS));
  const bytes = new TextEncoder().encode(rows.join('\r\n') + '\r\n');
  return scanAxis(parser, bytes, 0, bytes.length);
}
{
  // Shuffled across years, with 2031 missing: the scan reports the gap as a
  // zero, so it can be refused before a cube is allocated.
  const scan = await scanOf([
    '6/1/2032,5,OffPeak,A,1,2',
    '1/1/2030,1,OffPeak,A,1,2',
    'garbled,1,OffPeak,A,1,2',
    '2/29/2033,1,OffPeak,B,1,2',
    '12/31/2032,24,OffPeak,B,1,2',
    '3/1/2030,1,OffPeak,B,1,2',
  ]);
  assert.equal(scan.rows, 6, 'every non-blank row is counted for maxRows');
  assert.equal(scan.minYear, 2030);
  assert.equal(scan.maxYear, 2032);
  assert.deepEqual(scan.yearRows, [2, 0, 2], 'rows per year; an unreadable date is in none');

  const none = await scanOf(['garbled,1,OffPeak,A,1,2']);
  assert.deepEqual([none.yearRows, Number.isNaN(none.minYear)], [[], true]);
}
{
  // Nine years, 9 x 8,784 slot hours: past 65,535 a u16 span index would
  // fold year 8 onto year 1. The scan counts per year and the parse keeps the
  // hour within its year, so the last row stays in its own.
  const rows = [];
  for (let y = 0; y < 9; y++) {
    for (let d = 1; d <= y + 1; d++) rows.push(`12/${d}/${2030 + y},24,OffPeak,A,${y},${d}`);
  }
  rows.push('12/31/2038,24,OffPeak,B,99,98');
  const scan = await scanOf(rows);
  assert.deepEqual([scan.minYear, scan.maxYear], [2030, 2038]);
  assert.deepEqual(scan.yearRows, [1, 2, 3, 4, 5, 6, 7, 8, 10], 'year 9 is counted as year 9');
  const nine = await parse(rows, { year: 2030, numYears: 9 });
  assert.equal(nine.rows, rows.length);
  const last = nine.rows - 1;
  assert.deepEqual([nine.rowYear[last], nine.rowHour[last]], [8, 8783]);
  assert.deepEqual(valuesAt(nine, 1, 8783), [99, 98]);

  // The blit puts it at year offset 8 of the span cube,
  // `((entity * metrics + metric) * numYears + yearOffset) * 8784 + slotHour`,
  // and year 0's same slot hour stays empty.
  const accumulator = createAccumulator(TWO_METRICS, AXIS.length, { firstYear: 2030, numYears: 9 });
  blitBlock(accumulator, nine);
  const at = (entity, metric, year, hour) => ((entity * 2 + metric) * 9 + year) * 8784 + hour;
  assert.deepEqual(
    [accumulator.cube[at(1, 0, 8, 8783)], accumulator.cube[at(1, 1, 8, 8783)]],
    [99, 98],
  );
  assert.ok(Number.isNaN(accumulator.cube[at(1, 0, 0, 8783)]), 'nothing folded onto year 0');
  assert.equal(accumulator.cube[at(0, 0, 3, (335 + 3) * 24 + 23)], 3, 'Dec 4 2033 HE 24 of A');
  assert.equal(accumulator.hourSeen.length, 9 * 8784);
  assert.deepEqual([accumulator.hourSeen[8 * 8784 + 8783], accumulator.hourSeen[8783]], [1, 0]);
}
{
  // One slot hour in two years is two hours: neither a duplicate nor a TOU
  // clash. The same (entity, hour) twice in year 2 is a duplicate, named by
  // its year and date.
  const span = { firstYear: 2030, numYears: 2 };
  const accumulator = createAccumulator(TWO_METRICS, AXIS.length, span);
  blitBlock(
    accumulator,
    await parse(['1/1/2030,1,OnPeak,A,1,2', '1/1/2031,1,OffPeak,A,3,4'], {
      year: 2030,
      numYears: 2,
    }),
  );
  assert.deepEqual([accumulator.tou[0], accumulator.tou[8784]], [1, 0]);
  const again = await parse(['1/1/2031,1,OffPeak,A,5,6'], { year: 2030, numYears: 2 });
  assert.throws(
    () => blitBlock(accumulator, again),
    /area index 0 at hour 0 of 2031 \(Jan 1, hour ending 1\)/,
  );
  // A block parsed against a wider span than the cube's is refused, not
  // written past the cube.
  const narrow = createAccumulator(TWO_METRICS, AXIS.length, { firstYear: 2030, numYears: 1 });
  assert.throws(() => blitBlock(narrow, again), /year offset 1 of a 1-year Case/);
}
{
  // rowYear is a u8 offset, so a span past 256 years is refused at the scan.
  const wide = await scanOf(['1/1/2000,1,OffPeak,A,1,2', '1/1/2255,1,OffPeak,A,1,2']);
  assert.equal(wide.yearRows.length, 256, 'a 256-year span is the widest the scan reports');
  await assert.rejects(
    () => scanOf(['1/1/2256,1,OffPeak,A,1,2', '1/1/2000,1,OffPeak,A,1,2']),
    /span more than 256 years \(1 row\(s\) past them\)/,
  );
  await assert.rejects(
    () => scanOf(['1/1/2000,1,OffPeak,A,1,2', '1/1/1500,1,OffPeak,A,1,2']),
    /span more than 256 years/,
    'a year far before the first is counted, not written out of bounds',
  );
}
ok(
  'the axis scan reports min, max and rows per year, nine years without a wrap, and refuses a span past 256 years',
);
ok('the blit places each row at its year offset; a duplicate in year 2 is refused by its date');

console.log(`\n${checks} checks passed`);
