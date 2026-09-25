// tests/test_ingest_interface.mjs — wide ingest against a synthetic export
// (test_fixtures_interface.mjs). Parity and block independence work as in
// test_ingest_area.mjs; specific to this shape:
//
//   1. THE PREAMBLE: the header is line 5, and a comma-bearing title line is
//      never read as a header.
//   2. THE LAST NUMERIC COLUMN (the CRLF trap).
//   3. TOU is read from the file.
//   4. SCHEMA DRIFT: files with different paths and orders share a union
//      axis; a missing column stays NaN.
//   5. REFUSALS: an unholdable layout, rows wider than their header, and
//      unreadable Date or Hour.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './test_loader.mjs';
import { exportCsv, interfaceNames } from './test_fixtures_interface.mjs';

const {
  parseHeaderLine,
  parseTitleLine,
  buildColumnPlan,
  unionSchema,
  dayOfYear,
  KEY_COLS,
  PREAMBLE_LINES,
} = await import('../src/tables/interface/header.ts');
const { instantiateParser, parseBytes, afterNextNewline, maxRowsAt } =
  await import('../src/tables/interface/block.ts');
const {
  createAccumulator,
  blitBlock,
  finalizeCase,
  readCasePlan,
  unionOf,
  coverageOf,
  caseNameOf,
  layoutFor,
} = await import('../src/tables/interface/pool.ts');
const { readWholeRows } = await import('../src/tables/wide/worker.ts');
const { HOURS_PER_YEAR, TOU_LABELS } = await import('../src/model/calendar.ts');

const HOURS = HOURS_PER_YEAR;
const NEWLINE = 10;
const decoder = new TextDecoder();

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

// ---------------------------------------------------------------- the parser

const wasmBytes = readFileSync(new URL('../parser/wide/block.wasm', import.meta.url));
const wasmModule = new WebAssembly.Module(wasmBytes);
const parser = await instantiateParser(wasmModule);

// The budget comes from the committed module, not a mirrored literal.
const BUDGET = parser.budget;
assert.ok(
  BUDGET.arenaBytes > 0 && BUDGET.inbufBytes > 0,
  'the module must report usable byte budgets',
);
ok(
  `block.wasm instantiates and reports its own budgets: ${BUDGET.arenaBytes} B arena, ` +
    `${BUDGET.inbufBytes} B input window`,
);

// The slab's SHAPE is per file now, so every parseBytes below is driven at the
// shape that file's own header implies -- which is exactly what production
// does (pool.ts sizes one layout per case plan).
const layoutOf = (plan) => layoutFor(BUDGET, plan);

// ---------------------------------------------------------------- header BOM

{
  const bomHeader = '\uFEFFDate, Hour, TOU,P01,P02';
  const header = parseHeaderLine(bomHeader);
  // Assert on `raw`: trim() would strip U+FEFF from `canonical` regardless.
  assert.equal(
    header.raw[0],
    'Date',
    'stripBOM must remove the BOM from the untrimmed raw field too',
  );
  assert.equal(header.canonical[0], 'Date', 'a leading UTF-8 BOM must not become part of "Date"');
  assert.equal(header.dateCol, 0);
  assert.equal(header.hourCol, 1);
  assert.equal(header.touCol, 2);
  assert.deepEqual(header.entityNames, ['P01', 'P02'], 'the interface columns are unaffected');
  ok('parseHeaderLine strips a leading BOM before locating the key columns');
}

// ---------------------------------------------------------------- helpers

/** Byte offset just past the n-th newline. */
function skipLines(bytes, n) {
  let at = 0;
  for (let i = 0; i < n; i++) at = afterNextNewline(bytes, at);
  return at;
}

/** The header line and the offset of the first data row, as ingest sees them. */
function headerOf(bytes) {
  const headerStart = skipLines(bytes, PREAMBLE_LINES);
  const headerEnd = bytes.indexOf(NEWLINE, headerStart);
  return {
    header: parseHeaderLine(decoder.decode(bytes.subarray(headerStart, headerEnd))),
    title: parseTitleLine(decoder.decode(bytes.subarray(0, bytes.indexOf(NEWLINE)))),
    dataStart: headerEnd + 1,
  };
}

/** The worker's block-ownership rule -- see test_ingest_area.mjs. */
function wholeRowRanges(bytes, dataStart, blockBytes) {
  const ranges = [];
  for (let start = dataStart; start < bytes.length; start += blockBytes) {
    const from = start === dataStart ? dataStart : afterNextNewline(bytes, start);
    if (from < 0) continue;
    const end = Math.min(start + blockBytes, bytes.length);
    let to = afterNextNewline(bytes, end);
    if (to < 0) to = bytes.length;
    if (to > from) ranges.push([from, to]);
  }
  return ranges;
}

/** Split into lines, keeping BLANK ones: preamble lines 2 and 4 are empty. */
function splitLines(bytes) {
  const lines = decoder.decode(bytes).split('\r\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The year on a file's first data row, the way readCasePlan reads it. */
function yearOf(bytes, dataStart) {
  const end = bytes.indexOf(NEWLINE, dataStart);
  return Number(decoder.decode(bytes.subarray(dataStart, end)).split(',', 1)[0].split('/')[2]);
}

/** Parse a whole in-memory export into a cube, block by block. */
function parseToCube(bytes, retained, blockBytes) {
  const { header, title, dataStart } = headerOf(bytes);
  const plan = buildColumnPlan(header, retained);
  const layout = layoutOf(plan);
  const accumulator = createAccumulator(plan);
  const year = yearOf(bytes, dataStart);
  const ranges = wholeRowRanges(bytes, dataStart, blockBytes);
  for (const [from, to] of ranges) {
    blitBlock(accumulator, parseBytes(parser, layout, bytes, from, to, plan.activePlanes, year));
  }
  return { accumulator, plan, header, title, ranges };
}

// ---------------------------------------------------------------- reference

/** Independent parser: strings, split, parseFloat. Deliberately naive. */
function referenceCube(text, retained) {
  const lines = text.split('\n');
  const header = lines[PREAMBLE_LINES].replace(/\r$/, '')
    .split(',')
    .map((s) => s.trim());
  const dest = new Map();
  retained.forEach((name, index) => dest.set(name, index));

  const cube = new Float32Array(retained.length * HOURS).fill(NaN);
  const tou = new Uint8Array(HOURS).fill(0xff);
  let rows = 0;

  for (let i = PREAMBLE_LINES + 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (line.length === 0) continue;
    const fields = line.split(',');
    const [month, day] = fields[0].split('/').map(Number);
    const doy = dayOfYear(month, day);
    if (doy < 0) continue; // Feb 29, dropped at ingest
    const hour = doy * 24 + (Number(fields[1]) - 1);
    tou[hour] = fields[2].trim() === 'OnPeak' ? 1 : 0;
    rows++;
    for (let col = KEY_COLS; col < fields.length; col++) {
      const column = dest.get(header[col]);
      if (column === undefined) continue;
      cube[column * HOURS + hour] = parseFloat(fields[col]);
    }
  }
  return { cube, tou, rows };
}

// ---------------------------------------------------------------- comparison

// One-ulp tolerance, not a free pass -- see test_ingest_area.mjs for why.
const F32_ULP_RELATIVE = 1.1920929e-7;

function compareCubes(expectedCube, actualCube, retained) {
  assert.equal(expectedCube.length, actualCube.length, 'cubes must be the same shape');
  let live = 0;
  let beyondOneUlp = 0;
  let withinOneUlp = 0;
  const worst = { relative: 0, where: '' };

  for (let i = 0; i < expectedCube.length; i++) {
    const expected = expectedCube[i];
    const actual = actualCube[i];
    if (Number.isNaN(expected)) {
      assert.ok(
        Number.isNaN(actual),
        `cell ${i} is absent in the reference but ${actual} in the parser`,
      );
      continue;
    }
    live++;
    if (expected === actual) continue;
    const relative = Math.abs(expected - actual) / Math.max(Math.abs(expected), 1e-30);
    if (relative <= F32_ULP_RELATIVE) {
      withinOneUlp++;
      if (relative > worst.relative) {
        worst.relative = relative;
        worst.where = retained[Math.floor(i / HOURS)];
      }
      continue;
    }
    beyondOneUlp++;
    if (beyondOneUlp < 4) {
      console.error(
        `  cell ${i} (${retained[Math.floor(i / HOURS)]}, hour ${i % HOURS}): ` +
          `reference ${expected}, parser ${actual}, relative ${relative}`,
      );
    }
  }
  return { live, beyondOneUlp, withinOneUlp, worst };
}

// ---------------------------------------------------------------- 1. parity

const names = interfaceNames(24);
const csv = exportCsv({ names, days: 3, hours: 24, year: 2035 });
const text = decoder.decode(csv);

{
  const { accumulator, plan, header, title } = parseToCube(csv, names, 16 * 1024);
  assert.deepEqual(plan.entities, names, 'the cube axis is the retained list, in order');
  assert.equal(header.entityNames.length, names.length, 'every interface column is seen');
  assert.equal(title.quantity, 'Power Flow (MW)', 'the title line names the quantity');
  assert.equal(title.year, 2035, 'the title line names the year');

  const reference = referenceCube(text, names);
  const result = compareCubes(reference.cube, accumulator.cube, names);
  assert.ok(result.live > 0, 'the comparison must actually compare something');
  assert.equal(result.beyondOneUlp, 0, 'no cell may differ by more than one float32 ulp');
  ok(
    `cell-by-cell parity over ${result.live.toLocaleString()} live cells ` +
      `(${result.withinOneUlp} within 1 ulp, worst ${worstText(result)})`,
  );

  // The last numeric column carries the trailing \r of every CRLF row and is
  // the one place a "parse until the delimiter" bug hides.
  const last = names.length - 1;
  let lastLive = 0;
  for (let hour = 0; hour < HOURS; hour++) {
    const value = accumulator.cube[last * HOURS + hour];
    if (Number.isNaN(value)) continue;
    lastLive++;
    assert.equal(value, reference.cube[last * HOURS + hour], `last column, hour ${hour}`);
  }
  assert.equal(lastLive, 3 * 24, 'the last column must be populated in every data row');
  ok(`the last numeric column survives the CRLF trailing \\r (${lastLive} rows)`);

  // TOU is file data: the fixture alternates it by hour-ending
  // parity, which no calendar rule would ever produce.
  let touChecked = 0;
  for (let hour = 0; hour < 3 * 24; hour++) {
    assert.equal(accumulator.tou[hour], reference.tou[hour], `TOU at hour ${hour}`);
    assert.equal(TOU_LABELS[accumulator.tou[hour]], hour % 2 === 1 ? 'OnPeak' : 'OffPeak');
    touChecked++;
  }
  ok(`TOU is read from the file's own column, ${touChecked} hours checked`);
}

function worstText(result) {
  return result.worst.relative === 0 ? 'exact' : `${result.worst.relative.toExponential(2)}`;
}

// ---------------------------------------------------------------- 2. blocks

{
  // Several block sizes, each landing its boundaries somewhere different
  // inside the rows, plus one big enough to hold the whole file.
  const sizes = [4 * 1024, 7 * 1024 + 13, 64 * 1024, csv.length * 2];
  const baseline = parseToCube(csv, names, 16 * 1024).accumulator.cube;
  for (const size of sizes) {
    const { accumulator, ranges } = parseToCube(csv, names, size);
    assert.deepEqual(
      Array.from(accumulator.cube),
      Array.from(baseline),
      `block size ${size} must produce an identical cube`,
    );
    // Ranges must tile the data region exactly: no gap, no overlap.
    for (let i = 1; i < ranges.length; i++) {
      assert.equal(ranges[i][0], ranges[i - 1][1], `blocks must tile at ${size} B`);
    }
  }
  ok(`identical cubes at ${sizes.length} block sizes, and the ranges tile exactly`);

  // Reverse arrival order: every row carries its own hour, so the order
  // workers finish in cannot matter.
  const { header, dataStart } = headerOf(csv);
  const plan = buildColumnPlan(header, names);
  const layout = layoutOf(plan);
  const accumulator = createAccumulator(plan);
  const year = yearOf(csv, dataStart);
  const ranges = wholeRowRanges(csv, dataStart, 5 * 1024).reverse();
  for (const [from, to] of ranges) {
    blitBlock(accumulator, parseBytes(parser, layout, csv, from, to, plan.activePlanes, year));
  }
  assert.deepEqual(Array.from(accumulator.cube), Array.from(baseline), 'reverse order must match');
  ok(`blocks are position-independent: reversed arrival order is byte-identical`);
}

// ------------------------------------------------- 2b. row order carries no meaning

// Rows out of (Date, Hour) order, even descending, give the SAME cube, byte
// for byte.
{
  const names = interfaceNames(6);
  const csv = exportCsv({ names, days: 3, hours: 24, seed: 24680 });
  const ordered = parseToCube(csv, names, 5 * 1024);

  const lines = splitLines(csv);
  const head = lines.slice(0, PREAMBLE_LINES + 1);
  const rows = lines.slice(PREAMBLE_LINES + 1);

  // Deterministic; a fixture that changes between runs cannot be compared.
  const shuffle = (input, seed0) => {
    const out = input.slice();
    let seed = seed0;
    for (let i = out.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const j = seed % (i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  for (const [label, scrambled] of [
    ['reversed', rows.slice().reverse()],
    ['shuffled', shuffle(rows, 20260812)],
  ]) {
    const bytes = new TextEncoder().encode([...head, ...scrambled].join('\r\n') + '\r\n');
    // Small blocks on purpose: this only means anything if the scrambled rows
    // are spread across several blocks, so a block's first row is routinely
    // not its earliest hour.
    const run = parseToCube(bytes, names, 5 * 1024);
    assert.ok(run.ranges.length > 1, `${label}: must span more than one block to be a real test`);
    assert.deepEqual(
      new Uint8Array(run.accumulator.cube.buffer),
      new Uint8Array(ordered.accumulator.cube.buffer),
      `${label} rows must produce a byte-identical cube`,
    );
    assert.deepEqual(run.accumulator.tou, ordered.accumulator.tou, `${label}: TOU must match`);
    assert.deepEqual(
      run.accumulator.hourSeen,
      ordered.accumulator.hourSeen,
      `${label}: coverage must match`,
    );
  }
  ok('reversed and shuffled row order produce a byte-identical cube -- order carries no meaning');

  // And against the independent reference parser, not only against ourselves:
  // agreeing with our own ordered run would still pass if both were wrong.
  const bytes = new TextEncoder().encode([...head, ...shuffle(rows, 7)].join('\r\n') + '\r\n');
  const run = parseToCube(bytes, names, 5 * 1024);
  const reference = referenceCube(decoder.decode(bytes), names);
  for (let i = 0; i < run.accumulator.cube.length; i++) {
    const got = run.accumulator.cube[i];
    const want = reference.cube[i];
    if (Number.isNaN(got) && Number.isNaN(want)) continue;
    assert.equal(got, want, `shuffled export, cell ${i}`);
  }
  ok('a shuffled export matches the independent reference parser cell for cell');
}

// ------------------------------------------------- 2b2. the worker's own ranges tile

// wholeRowRanges above is a test-local reimplementation; this drives the REAL
// widening the worker does. It has to tile the data region exactly, because an
// overlap hands the same hours in twice.
{
  const names = interfaceNames(4);
  const csv = exportCsv({ names, days: 6, hours: 24, seed: 31415 });
  const { dataStart } = headerOf(csv);
  const file = new File([csv], 'ranges.csv');

  // Deliberately smaller than TAIL_BYTES (64 KiB): a block whose end comes
  // within one tail of EOF must still stop at its own end.
  for (const blockBytes of [512, 4096, 20000]) {
    const seen = new Uint8Array(csv.length);
    for (let start = dataStart; start < file.size; start += blockBytes) {
      const { from, to } = await readWholeRows({
        kind: 'block',
        blockId: 0,
        caseIndex: 0,
        file,
        start,
        end: Math.min(start + blockBytes, file.size),
        skipPartialFirstRow: start !== dataStart,
        activePlanes: buildColumnPlan(headerOf(csv).header, names).activePlanes,
        year: 2036,
      });
      for (let i = from; i < to; i++) {
        assert.equal(
          seen[start + i],
          0,
          `byte ${start + i} covered twice at ${blockBytes} B blocks`,
        );
        seen[start + i] = 1;
      }
    }
    for (let i = dataStart; i < csv.length; i++) {
      assert.equal(seen[i], 1, `byte ${i} covered by no block at ${blockBytes} B blocks`);
    }
  }
  ok('the worker widens blocks to whole rows that tile exactly, even below the 64 KiB tail');
}

// ------------------------------------------------- 2c. one hour, one row

// The one thing the scatter cannot resolve. Two rows for the same hour would
// keep whichever block was blitted last, silently, and both values look
// perfectly plausible. Two exports of one year concatenated do exactly this.
{
  const names = interfaceNames(4);
  const csv = exportCsv({ names, days: 1, hours: 4, seed: 999 });
  const lines = splitLines(csv);
  const head = lines.slice(0, PREAMBLE_LINES + 1);
  const rows = lines.slice(PREAMBLE_LINES + 1);

  // The same hour twice, carrying different values.
  const clash = rows[2].split(',');
  for (let c = KEY_COLS; c < clash.length; c++) clash[c] = '42.5';
  const doubled = new TextEncoder().encode(
    [...head, ...rows, clash.join(',')].join('\r\n') + '\r\n',
  );
  assert.throws(
    () => parseToCube(doubled, names, 64 * 1024),
    /Two rows both describe hour/,
    'a duplicated hour must be refused',
  );
  ok('two rows for one hour are refused rather than silently overwritten');

  // Across BLOCKS as well as within one: the coverage map lives on the
  // accumulator precisely so a duplicate split across two workers is caught.
  assert.throws(
    () => parseToCube(doubled, names, 256),
    /Two rows both describe hour/,
    'a duplicated hour split across blocks must be refused',
  );
  ok('a duplicated hour is caught across block boundaries too');
}

// ---------------------------------------------------------------- 3. preamble

{
  const plan = await readCasePlan(new File([csv], 'Case A.csv'));
  assert.equal(plan.title.quantity, 'Power Flow (MW)');
  assert.equal(plan.year, 2035, 'the year comes from the first data row');
  assert.deepEqual(plan.header.entityNames, names);
  assert.equal(
    decoder.decode(csv.subarray(plan.dataStart, plan.dataStart + 3)),
    '1/1',
    'dataStart must land on the first data row',
  );
  assert.equal(caseNameOf('Case A.csv'), 'Case A', 'the case name drops the extension');
  ok('the four preamble lines are skipped and the header is read from line 5');

  // A file with no preamble is the OLD format. It must be refused, not
  // half-read: line 5 of an area export is a data row, and a data row has no
  // column names in it at all.
  const noPreamble = new TextEncoder().encode(
    'Date, Hour, TOU,P01\r\n1/1/2035,1,OffPeak,1\r\n1/1/2035,2,OffPeak,2\r\n' +
      '1/1/2035,3,OffPeak,3\r\n1/1/2035,4,OffPeak,4\r\n1/1/2035,5,OffPeak,5\r\n',
  );
  await assert.rejects(
    () => readCasePlan(new File([noPreamble], 'flat.csv')),
    /missing the required key column/,
    'a file without the preamble must be refused',
  );
  ok('a header that is not on line 5 is refused rather than misread');

  assert.deepEqual(parseTitleLine("Interface Hourly 'Congestion Cost ($)' Data for Year 2044"), {
    quantity: 'Congestion Cost ($)',
    year: 2044,
    entity: 'Interface',
  });
  assert.deepEqual(parseTitleLine('something else entirely'), {
    quantity: '',
    year: null,
    entity: 'something',
  });
  ok('the title line parses to a quantity and a year, or to nothing at all');

  // The entity word is read independently of the quantity (src/detect.ts
  // gates on it).
  assert.equal(
    parseTitleLine("Area Hourly 'Avg LMP Weighted by Load ($/MWh)' Data for Year 2035").entity,
    'Area',
  );
  assert.equal(parseTitleLine("Bus Hourly 'LMP ($/MWh)' Data for Year 2035").entity, 'Bus');
  assert.equal(
    parseTitleLine("Generator Hourly 'Generation (MWh)' Data for Year 2035").entity,
    'Generator',
  );
  assert.equal(parseTitleLine('Interface Hourly Report -- no quoted quantity').entity, 'Interface');
  assert.equal(parseTitleLine(',,,,,,,').entity, '', 'a blank title cell has no entity word');
  assert.equal(parseTitleLine('').entity, '');
  assert.equal(
    parseTitleLine("\ufeffInterface Hourly 'Power Flow (MW)' Data for Year 2035").entity,
    'Interface',
    'a BOM must not be read as part of the entity word',
  );
  ok('the title line also yields the entity kind word, or nothing');
}

// ---------------------------------------------------------------- 4. drift

{
  // Two files monitoring overlapping but different paths, in different
  // orders.
  const left = interfaceNames(8);
  const right = [...left.slice(2, 6)].reverse().concat(['P99 Only Here N-S']);
  const fileA = exportCsv({ names: left, days: 1, hours: 4, seed: 1 });
  const fileB = exportCsv({
    names: right,
    days: 1,
    hours: 4,
    seed: 2,
    quantity: 'Congestion Cost ($)',
  });

  const plans = [
    await readCasePlan(new File([fileA], 'A.csv')),
    await readCasePlan(new File([fileB], 'B.csv')),
  ];
  const union = unionOf(plans);
  assert.deepEqual(union, [...left, 'P99 Only Here N-S'], 'the union is first-seen order');
  assert.deepEqual(unionSchema([plans[1].header]), right, 'one file s union is its own header');

  const coverage = coverageOf(plans);
  assert.deepEqual(coverage.get(left[0]), ['A'], 'a path only A monitors is only in A');
  assert.deepEqual(coverage.get(left[3]), ['A', 'B'], 'a shared path lists both files');
  assert.deepEqual(coverage.get('P99 Only Here N-S'), ['B']);
  ok('the union spans every dropped file, and coverage says which file carries what');

  // File B, loaded onto the union axis: the columns it lacks must be absent,
  // not zero, and the columns it has must be exactly where the axis says.
  const { accumulator, plan } = parseToCube(fileB, union, 64 * 1024);
  const finalized = finalizeCase(
    accumulator,
    'B',
    plans[1].header.entityNames,
    2036,
    plans[1].title,
  );
  const reference = referenceCube(decoder.decode(fileB), union);
  const result = compareCubes(reference.cube, accumulator.cube, union);
  assert.equal(result.beyondOneUlp, 0, 'drift must not disturb parity');

  union.forEach((name, index) => {
    const present = right.includes(name);
    assert.equal(plan.presence[index], present ? 1 : 0, `presence for ${name}`);
    if (present) return;
    for (let hour = 0; hour < 4; hour++) {
      assert.ok(
        Number.isNaN(accumulator.cube[index * HOURS + hour]),
        `${name} is not in B and must be NaN, never 0`,
      );
    }
  });
  assert.equal(finalized.data.unit, '$', 'the unit comes from the title line');
  assert.equal(finalized.data.quantity, 'Congestion Cost ($)');
  assert.ok(
    finalized.warnings.some((w) => w.includes('not in this export')),
    'the absent columns are stated, not silent',
  );
  ok('a file missing a path loads it as absent (NaN + presence 0) and says so');
}

// ---------------------------------------------------------------- 5. Feb 29

{
  const leap = exportCsv({ year: 2036, days: 60, hours: 2, names: interfaceNames(4), feb29: true });
  const { accumulator } = parseToCube(leap, interfaceNames(4), 32 * 1024);
  assert.equal(accumulator.feb29, 2, 'both Feb 29 rows are counted');

  // Mar 1 must hold Mar 1's data: if Feb 29 had been kept, every hour after
  // it would be shifted by a day and every number would still look fine.
  const reference = referenceCube(decoder.decode(leap), interfaceNames(4));
  const mar1 = dayOfYear(3, 1) * 24;
  assert.equal(accumulator.cube[mar1], reference.cube[mar1], 'Mar 1 hour 1 must not shift');
  assert.ok(!Number.isNaN(accumulator.cube[mar1]), 'Mar 1 must carry data');

  const finalized = finalizeCase(accumulator, 'leap', interfaceNames(4), 2036, {
    quantity: 'Power Flow (MW)',
    year: 2036,
  });
  assert.ok(
    finalized.warnings.some((w) => w.includes('Feb 29')),
    'the dropped leap day is stated',
  );
  ok('Feb 29 is dropped, counted and stated, and the rest of the year does not shift');
}

// ---------------------------------------------------------------- 6. refusals

{
  // The only unloadable width is one whose single row outgrows the arena,
  // computed from the budget the module reported.
  const impossible = Math.floor(BUDGET.arenaBytes / 4) + 1;
  assert.equal(maxRowsAt(BUDGET, impossible), 0, 'the fixture width must not fit one row');
  assert.throws(
    () => layoutFor(BUDGET, { slabPlan: new Int32Array(impossible) }),
    /block arena/,
    'a width whose one row outgrows the arena must be refused',
  );
  ok(`a width the ${BUDGET.arenaBytes} B arena cannot hold one row of is refused up front`);

  // and every width below that IS loadable, which is the point of the
  // change. 5,900 interfaces is the bus-width rung the ladder measures; it
  // needed a 92 MiB slab under v2 and is an ordinary layout under v3.
  const busWidth = layoutFor(BUDGET, { slabPlan: new Int32Array(5900) });
  assert.ok(busWidth.rows > 0, 'bus width must produce a usable layout');
  ok(`bus width (5,900 interfaces) lays out at ${busWidth.rows} rows in the same arena`);

  // A DATA ROW carrying more fields than its own header declared. This is what
  // last_wide_field means now that the slab is sized to the header: the file
  // contradicts itself, and the surplus fields would be dropped in silence.
  const ragged = new TextEncoder().encode('1/1/2035,1,OffPeak,1.5,9.5\r\n');
  const onePlan = buildColumnPlan(parseHeaderLine('Date, Hour, TOU,P01'), ['P01']);
  const oneLayout = layoutOf(onePlan);
  assert.throws(
    () => parseBytes(parser, oneLayout, ragged, 0, ragged.length, onePlan.activePlanes, 2035),
    /sit past column/,
    'a row with more fields than its header must be refused',
  );
  ok('a row carrying more fields than its own header declares is refused, not truncated');

  // A row whose Hour is out of range would otherwise be dropped in silence.
  const mangled = new TextEncoder().encode('1/1/2035,99,OffPeak,1.5\r\n');
  assert.throws(
    () => parseBytes(parser, oneLayout, mangled, 0, mangled.length, onePlan.activePlanes, 2035),
    /could not read/,
    'an unreadable Date or Hour must be refused',
  );
  ok('rows with an unreadable Date or Hour are refused rather than dropped silently');

  // A second year would fold onto the same hours (date_to_day ignores the
  // year), so it is refused.
  const twoYears = new TextEncoder().encode('1/1/2035,1,OffPeak,1.5\r\n1/1/2036,1,OffPeak,2.5\r\n');
  assert.throws(
    () => parseBytes(parser, oneLayout, twoYears, 0, twoYears.length, onePlan.activePlanes, 2035),
    /carry a year other than 2035/,
    'a file holding two calendar years must be refused',
  );
  ok('a second calendar year in one file is refused, not folded onto the same hours');

  // More rows than the configured slab (shorter rows than the sample) must be
  // refused with the marker the retry keys on. The layout is passed
  // explicitly so the fixture can stay small.
  const SHORT_ROWS = 48;
  const short = { metrics: 1, rows: SHORT_ROWS };
  const tiny = [];
  const MONTH_DAYS = [31, 28, 31, 30, 31, 30];
  let month = 1;
  let day = 1;
  while (tiny.length <= SHORT_ROWS) {
    for (let hour = 1; hour <= 24 && tiny.length <= SHORT_ROWS; hour++) {
      tiny.push(`${month}/${day}/2035,${hour},OffPeak,0`);
    }
    if (++day > MONTH_DAYS[month - 1]) {
      day = 1;
      month++;
    }
  }
  const overflowing = new TextEncoder().encode(tiny.join('\r\n') + '\r\n');
  assert.ok(tiny.length > SHORT_ROWS, 'the fixture must actually overrun the slab');
  assert.throws(
    () => parseBytes(parser, short, overflowing, 0, overflowing.length, onePlan.activePlanes, 2035),
    /block-slab-overflow/,
    'a block holding more rows than the slab must be refused, with the retry marker',
  );
  ok(`a block past its layout's ${SHORT_ROWS} rows is refused and tagged for ingest to re-cut`);

  // The same bytes at a layout that DOES fit them parse clean, which is what
  // makes the refusal above a bound rather than a blanket failure.
  const roomy = parseBytes(
    parser,
    { metrics: 1, rows: SHORT_ROWS * 4 },
    overflowing,
    0,
    overflowing.length,
    onePlan.activePlanes,
    2035,
  );
  assert.equal(roomy.rows, tiny.length, 'every row must land once the layout is tall enough');
  ok('the same block parses clean at a taller layout -- the arena is a budget, not a ceiling');
}

// ---------------------------------------------------------------- done

console.log(`\n${checks} checks passed.`);
