// tests/test_ingest_area.mjs — long-shape ingest against a synthetic export
// (test_fixtures.mjs):
//
//   1. CELL-BY-CELL PARITY with an independent ~30-line JS reference parser.
//      The wasm parser is trusted because of this, not because charts look
//      right.
//   2. BLOCK INDEPENDENCE: blocks fed in reverse give a byte-identical cube.
//   3. THE LAST NUMERIC COLUMN: CRLF puts `\r` on every row's last field, and
//      `parseFloat("112.4\r")` hides it.
//   4. TOU is read from the file, never recomputed.
//   5. The worker's row-widening tiles the data region exactly.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './test_loader.mjs';
import { exportCsv } from './test_fixtures.mjs';

const { parseHeaderLine, buildColumnPlan, entityHashes, dayOfYear } =
  await import('../src/tables/long/header.ts');
const {
  instantiateParser,
  parseBytes,
  afterNextNewline,
  scanAxis: scanAxisRaw,
  PARSER_ABI,
} = await import('../src/tables/long/block.ts');

/** One byte range through both passes, as the pool runs them. */
function parseRange(instance, bytes, from, to, plan, entityCount) {
  const scan = scanAxisRaw(instance, bytes, from, to);
  return parseBytes(
    instance,
    bytes,
    from,
    to,
    plan.activePlanes,
    entityCount,
    plan.sourceMetricCount,
    scan.rows,
  );
}

/** scanAxis over a whole buffer, skipping the header row. */
function scanAxis(bytes, parser) {
  const headerEnd = bytes.indexOf(NEWLINE);
  return scanAxisRaw(parser, bytes, headerEnd + 1, bytes.length);
}
const { finalizeCase, applyDerived, AREA_LONG } = await import('../src/tables/area/long.ts');
const { createAccumulator, blitBlock } = await import('../src/tables/long/pool.ts');
const { allAreas } = await import('../src/tables/area/groupings.ts');
const { HOURS_PER_YEAR, TOU_LABELS } = await import('../src/model/calendar.ts');

const HOURS = HOURS_PER_YEAR;
const NEWLINE = 10;

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

// ---------------------------------------------------------------- the parser

const areas = allAreas();
const AREA_COUNT = areas.length;

const wasmBytes = readFileSync(new URL('../parser/long/block.wasm', import.meta.url));
const wasmModule = new WebAssembly.Module(wasmBytes);
const parser = await instantiateParser(wasmModule, entityHashes(areas));
ok(`block.wasm instantiates and its area hash table accepts all ${AREA_COUNT} names`);

// ---------------------------------------------------------------- header BOM

{
  const bomHeader = '﻿Date, Hour, TOU, Name,Metric1,Metric2';
  const header = parseHeaderLine(bomHeader, AREA_LONG);
  // Assert on `raw`: `canonical` is trimmed, and trim() strips U+FEFF anyway,
  // so only `raw` shows whether stripBOM() ran.
  assert.equal(
    header.raw[0],
    'Date',
    'stripBOM must remove the BOM from the untrimmed raw field too',
  );
  assert.equal(header.canonical[0], 'Date', 'a leading UTF-8 BOM must not become part of "Date"');
  assert.equal(header.dateCol, 0);
  assert.equal(header.hourCol, 1);
  assert.equal(header.touCol, 2);
  assert.equal(header.entityCol, 3);
  ok('parseHeaderLine strips a leading BOM before locating the key columns');
}

// ---------------------------------------------------------------- block split

/** The worker's byte-range rule on an in-memory buffer. */
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

// ---------------------------------------------------------------- reference

/** Independent parser: strings, split, parseFloat. Deliberately naive. */
function referenceCube(text, metrics, axis = areas) {
  const lines = text.split('\n');
  const header = lines[0]
    .replace(/\r$/, '')
    .split(',')
    .map((s) => s.trim());
  const dest = new Map();
  metrics.forEach((name, index) => dest.set(name, index));

  const cube = new Float32Array(axis.length * metrics.length * HOURS).fill(NaN);
  const tou = new Uint8Array(HOURS).fill(0xff);
  let rows = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (line.length === 0) continue;
    const fields = line.split(',');
    const [month, day] = fields[0].split('/').map(Number);
    const doy = dayOfYear(month, day);
    if (doy < 0) continue; // Feb 29, dropped at ingest
    const hour = doy * 24 + (Number(fields[1]) - 1);
    const area = axis.indexOf(fields[3].trim());
    if (area < 0) continue;
    tou[hour] = fields[2].trim() === 'OnPeak' ? 1 : 0;
    rows++;
    for (let col = 4; col < fields.length; col++) {
      const metric = dest.get(header[col]);
      if (metric === undefined) continue;
      cube[(area * metrics.length + metric) * HOURS + hour] = parseFloat(fields[col]);
    }
  }
  return { cube, tou, rows };
}

// ---------------------------------------------------------------- comparison

/**
 * One float32 ulp (2^-23): anything larger is a parser bug. Differences within
 * one ulp are counted and reported, not hidden: block.c rounds twice where
 * strtod rounds once, which touches a few cells of the 8-digit money columns.
 */
const F32_ULP_RELATIVE = 1.1920929e-7;

function compareCubes(expectedCube, actualCube, metrics) {
  const byColumn = new Map();
  let live = 0;
  let differing = 0;
  let beyondOneUlp = 0;
  let maxRelative = 0;

  for (let i = 0; i < expectedCube.length; i++) {
    const expected = expectedCube[i];
    const actual = actualCube[i];
    if (Number.isNaN(expected) && Number.isNaN(actual)) continue;
    live++;
    if (Object.is(expected, actual)) continue;
    differing++;

    const relative =
      Number.isNaN(expected) || Number.isNaN(actual)
        ? Infinity
        : expected === 0
          ? Math.abs(actual)
          : Math.abs((actual - expected) / expected);
    if (relative > maxRelative) maxRelative = relative;
    if (relative > F32_ULP_RELATIVE) beyondOneUlp++;

    // Column name and relative error only, never a value. The habit predates
    // the synthetic fixture and stays: this reporting path is what would run
    // against a real export if anyone ever points it at one.
    const column = metrics[Math.floor(i / HOURS) % metrics.length];
    const seen = byColumn.get(column) ?? { count: 0, worst: 0, beyond: 0 };
    seen.count++;
    if (relative > seen.worst) seen.worst = relative;
    if (relative > F32_ULP_RELATIVE) seen.beyond++;
    byColumn.set(column, seen);
  }
  return { live, differing, beyondOneUlp, maxRelative, byColumn };
}

function assertWithinOneUlp(diff, label) {
  if (diff.differing > 0) {
    console.log(`\n${label}: differences by column (name + relative error only, never a value):`);
    for (const [column, seen] of diff.byColumn) {
      console.log(
        `  ${column}: ${seen.count} cell(s), worst relative ${seen.worst.toExponential(2)}` +
          `${seen.beyond > 0 ? `, ${seen.beyond} BEYOND one float32 ulp` : ' (within one float32 ulp)'}`,
      );
    }
  }
  assert.equal(
    diff.beyondOneUlp,
    0,
    `${label}: ${diff.beyondOneUlp} of ${diff.live} live cells differ by more than one float32 ` +
      `ulp (max relative ${diff.maxRelative.toExponential(2)}). That is a parser bug, not rounding.`,
  );
}

// ---------------------------------------------------------------- run one file

function ingestBuffer(bytes, blockBytes, { reverse = false } = {}) {
  const headerEnd = bytes.indexOf(NEWLINE);
  const header = parseHeaderLine(new TextDecoder().decode(bytes.subarray(0, headerEnd)), AREA_LONG);
  const plan = buildColumnPlan(header, header.metricNames);
  const accumulator = createAccumulator(plan, AREA_COUNT);

  const ranges = wholeRowRanges(bytes, headerEnd + 1, blockBytes);
  const order = reverse ? [...ranges].reverse() : ranges;
  let rows = 0;
  for (const [from, to] of order) {
    const payload = parseRange(parser, bytes, from, to, plan, AREA_COUNT);
    rows += payload.rows;
    blitBlock(accumulator, payload);
  }
  return { header, plan, accumulator, ranges, rows };
}

// ---------------------------------------------------------------- the fixture

const sampleBytes = exportCsv();
const sampleText = new TextDecoder().decode(sampleBytes);

assert.ok(
  sampleText.includes('\r\n'),
  'the fixture must be CRLF: real exports are, and that is the point',
);
ok('the synthetic export is CRLF, so the last-column trap is actually exercised');

// A block size that lands boundaries mid-row on purpose.
const BLOCK = 7777;
const run = ingestBuffer(sampleBytes, BLOCK);

// 5. The ranges tile the data region exactly.
{
  const dataStart = sampleBytes.indexOf(NEWLINE) + 1;
  assert.ok(run.ranges.length > 1, 'block size must actually split this file');
  assert.equal(run.ranges[0][0], dataStart);
  assert.equal(run.ranges[run.ranges.length - 1][1], sampleBytes.length);
  for (let i = 1; i < run.ranges.length; i++) {
    assert.equal(
      run.ranges[i][0],
      run.ranges[i - 1][1],
      `block ${i} must start exactly where block ${i - 1} ended`,
    );
  }
  ok(`${run.ranges.length} blocks tile the data region with no gap and no overlap`);
}

const reference = referenceCube(sampleText, run.plan.metrics);
assert.equal(run.rows, reference.rows, 'WASM and reference must see the same row count');
ok(`both parsers see ${run.rows.toLocaleString()} data rows`);

// 1. Cell by cell. Live cells only — NaN on both sides is agreement.
{
  const diff = compareCubes(reference.cube, run.accumulator.cube, run.plan.metrics);
  assertWithinOneUlp(diff, 'the synthetic export');
  ok(
    `${diff.live.toLocaleString()} live cells, ${diff.differing} differing, ` +
      `max relative difference ${diff.maxRelative.toExponential(2)}`,
  );
}

// 3. The last numeric column, specifically. Every value in it carried a
//    trailing \r in the source bytes.
{
  const lastMetric = run.plan.metrics.length - 1;
  const name = run.plan.metrics[lastMetric];
  let compared = 0;
  for (let area = 0; area < AREA_COUNT; area++) {
    for (let hour = 0; hour < HOURS; hour++) {
      const at = (area * run.plan.metrics.length + lastMetric) * HOURS + hour;
      const expected = Math.fround(reference.cube[at]);
      if (Number.isNaN(expected)) continue;
      assert.ok(
        Object.is(expected, run.accumulator.cube[at]),
        `CRLF trap: last column "${name}" differs at area ${area} hour ${hour}`,
      );
      compared++;
    }
  }
  assert.ok(compared > 0, 'the last-column check must actually compare something');
  ok(`last numeric column "${name}" matches in all ${compared} live cells (CRLF trap)`);
}

// 4. TOU is read, not recomputed.
{
  let covered = 0;
  for (let hour = 0; hour < HOURS; hour++) {
    assert.equal(run.accumulator.tou[hour], reference.tou[hour], `TOU differs at hour ${hour}`);
    if (reference.tou[hour] !== 0xff) covered++;
  }
  assert.ok(covered > 0, 'the sample must cover at least one hour');
  const labels = new Set();
  for (let hour = 0; hour < HOURS; hour++) {
    if (run.accumulator.tou[hour] !== 0xff) labels.add(TOU_LABELS[run.accumulator.tou[hour]]);
  }
  ok(
    `TOU matches the file's own column across ${covered} covered hour(s): ${[...labels].join(', ')}`,
  );
}

// 2. Block independence.
{
  const reversed = ingestBuffer(sampleBytes, BLOCK, { reverse: true });
  assert.deepEqual(
    new Uint8Array(reversed.accumulator.cube.buffer),
    new Uint8Array(run.accumulator.cube.buffer),
    'cube must be byte-identical when blocks are parsed in reverse order',
  );
  assert.deepEqual(reversed.accumulator.tou, run.accumulator.tou);
  ok('blocks parsed in reverse order produce a byte-identical cube');
}

// A second block size, to prove the result does not depend on where the
// boundaries happen to land.
{
  const other = ingestBuffer(sampleBytes, 1024);
  assert.deepEqual(
    new Uint8Array(other.accumulator.cube.buffer),
    new Uint8Array(run.accumulator.cube.buffer),
    'cube must not depend on block size',
  );
  ok('a different block size produces a byte-identical cube');
}

// ---------------------------------------------------------------- variable shapes
//
// The parser reads its shape at runtime, so these are the same code path with
// different numbers, and the cell-by-cell gate above applies unchanged.

/** A synthetic export of any shape. Values encode (area, hour, metric) so a
 * value landing in the wrong plane is a wrong number, not a plausible one. */
function syntheticCsv(axis, metricCount, { hours = 2, order = null, pad = '' } = {}) {
  const metrics = Array.from(
    { length: metricCount },
    (_, i) => `Metric ${String(i + 1).padStart(2, '0')}`,
  );
  const lines = [['Date', 'Hour', 'TOU', 'Name', ...metrics].join(',')];
  for (let hour = 1; hour <= hours; hour++) {
    const rowOrder = order ? order[(hour - 1) % order.length] : axis;
    for (const area of rowOrder) {
      const code = axis.indexOf(area) + 1;
      const fields = ['1/1/2035', String(hour), hour % 2 ? 'OffPeak' : 'OnPeak', pad + area + pad];
      for (let m = 0; m < metricCount; m++)
        fields.push(String(code * 100000 + hour * 1000 + m + 1));
      lines.push(fields.join(','));
    }
  }
  return { metrics, bytes: new TextEncoder().encode(lines.join('\r\n') + '\r\n') };
}

/** Parse a whole synthetic buffer against `axis`, on its own parser instance
 * -- the area hash table is per-axis, exactly as the pool rebuilds it. */
async function runShape(bytes, axis, retained = null, blockBytes = 4096) {
  const headerEnd = bytes.indexOf(NEWLINE);
  const header = parseHeaderLine(new TextDecoder().decode(bytes.subarray(0, headerEnd)), AREA_LONG);
  const plan = buildColumnPlan(header, retained ?? header.metricNames);
  const shapeParser = await instantiateParser(wasmModule, entityHashes(axis));
  const accumulator = createAccumulator(plan, axis.length);
  let rows = 0;
  for (const [from, to] of wholeRowRanges(bytes, headerEnd + 1, blockBytes)) {
    const payload = parseRange(shapeParser, bytes, from, to, plan, axis.length);
    rows += payload.rows;
    blitBlock(accumulator, payload);
  }
  return { header, plan, accumulator, rows, parser: shapeParser };
}

// Few areas, source metric positions past 50, and area rows in a different
// order per hour.
{
  const axis = ['A', 'B', 'C', 'D'];
  const { bytes } = syntheticCsv(axis, 55, {
    order: [
      ['B', 'A', 'C'],
      ['C', 'B', 'A'],
    ],
  });
  const { plan, accumulator, rows } = await runShape(bytes, axis);
  assert.equal(plan.sourceMetricCount, 55);
  assert.ok(plan.activePlanes[plan.activePlanes.length - 1] >= 50);

  const reference = referenceCube(new TextDecoder().decode(bytes), plan.metrics, axis);
  assert.equal(rows, reference.rows);
  assertWithinOneUlp(
    compareCubes(reference.cube, accumulator.cube, plan.metrics),
    'the variable-shape export',
  );

  const lastMetric = plan.metrics.length - 1;
  assert.equal(
    accumulator.cube[(axis.indexOf('A') * plan.metrics.length + lastMetric) * HOURS + 1],
    Math.fround(102055),
    'metric past source position 50 must parse for shuffled area A',
  );
  assert.ok(
    Number.isNaN(accumulator.cube[(axis.indexOf('D') * plan.metrics.length + lastMetric) * HOURS]),
    'an area absent from this file stays no-data on the shared axis',
  );
  ok('variable area counts, shuffled area rows, and >50 source metrics parse by name');
}

// Many areas (200).
{
  const axis = Array.from({ length: 200 }, (_, i) => `AREA${String(i).padStart(3, '0')}`);
  const { bytes } = syntheticCsv(axis, 7, { hours: 3 });
  const { plan, accumulator, rows } = await runShape(bytes, axis);
  const reference = referenceCube(new TextDecoder().decode(bytes), plan.metrics, axis);
  assert.equal(rows, reference.rows);
  assertWithinOneUlp(
    compareCubes(reference.cube, accumulator.cube, plan.metrics),
    'a 200-area export',
  );
  ok(`${axis.length} areas x ${plan.metrics.length} metrics parse with no fixed area ceiling`);
}

// A padded Name value: the axis uses trimmed names, so the parser must hash
// the trimmed bytes or the file is refused as "unknown area".
{
  const axis = ['A', 'B', 'C'];
  const { bytes } = syntheticCsv(axis, 6, { pad: ' ' });
  const { plan, accumulator } = await runShape(bytes, axis);
  assert.ok(
    !Number.isNaN(accumulator.cube[axis.indexOf('B') * plan.metrics.length * HOURS]),
    'a padded Name must route to its area rather than refuse the file',
  );
  ok('a padded Name field routes by trimmed name, as the area axis is trimmed');
}

// The source-column -> plane map is per file, not per shape: two cases with
// the same counts in a different column order share one worker, and a
// shape-keyed cache would silently read one through the other's plan.
{
  const axis = ['A', 'B', 'C'];
  const { metrics, bytes } = syntheticCsv(axis, 8);
  const first = [metrics[0], metrics[1]];
  const second = [metrics[6], metrics[7]];

  const headerEnd = bytes.indexOf(NEWLINE);
  const header = parseHeaderLine(new TextDecoder().decode(bytes.subarray(0, headerEnd)), AREA_LONG);
  const shapeParser = await instantiateParser(wasmModule, entityHashes(axis));
  const ranges = wholeRowRanges(bytes, headerEnd + 1, 4096);

  // Same instance, alternating plans, exactly as the pool interleaves cases.
  const runs = [];
  for (const retained of [first, second, first]) {
    const plan = buildColumnPlan(header, retained);
    const accumulator = createAccumulator(plan, axis.length);
    for (const [from, to] of ranges) {
      blitBlock(accumulator, parseRange(shapeParser, bytes, from, to, plan, axis.length));
    }
    runs.push({ plan, accumulator });
  }

  for (const { plan, accumulator } of runs) {
    const reference = referenceCube(new TextDecoder().decode(bytes), plan.metrics, axis);
    assertWithinOneUlp(
      compareCubes(reference.cube, accumulator.cube, plan.metrics),
      `retained ${plan.metrics.join(' + ')}`,
    );
  }
  assert.deepEqual(
    new Uint8Array(runs[2].accumulator.cube.buffer),
    new Uint8Array(runs[0].accumulator.cube.buffer),
    'a plan re-run after a different plan must produce the same cube',
  );
  ok('alternating column plans on one parser instance each read their own columns');
}

// Retaining a subset must skip the other columns in WASM rather than parse and
// discard them -- and must not shrink the block's hour coverage while doing it.
{
  const axis = ['A', 'B'];
  const { metrics, bytes } = syntheticCsv(axis, 10, { hours: 5 });
  const { plan, accumulator } = await runShape(bytes, axis, [metrics[9]]);
  assert.equal(plan.activePlanes.length, 1);
  const reference = referenceCube(new TextDecoder().decode(bytes), plan.metrics, axis);
  assertWithinOneUlp(compareCubes(reference.cube, accumulator.cube, plan.metrics), 'one retained');
  let covered = 0;
  for (let hour = 0; hour < HOURS; hour++) covered += accumulator.hourSeen[hour];
  assert.equal(covered, 5, 'hour coverage comes from the rows, not from the retained columns');
  ok('a one-column selection reads that column and still covers every hour');
}

// Rows out of (Date, Hour) order -- a value-sorted export. The parser emits a
// row list and the blit scatters it, so order carries no meaning at all: it
// must produce the SAME CUBE as the ordered file, byte for byte.
{
  const axis = ['A', 'B', 'C'];
  const { bytes } = syntheticCsv(axis, 6, { hours: 8 });
  const ordered = await runShape(bytes, axis, null, 512);

  const lines = new TextDecoder()
    .decode(bytes)
    .split('\r\n')
    .filter((l) => l.length > 0);
  const shuffle = (rows, seed0) => {
    const out = rows.slice();
    let seed = seed0;
    for (let i = out.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const j = seed % (i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  for (const [label, rows] of [
    ['reversed', lines.slice(1).reverse()],
    ['shuffled', shuffle(lines.slice(1), 20260812)],
  ]) {
    const scrambledBytes = new TextEncoder().encode([lines[0], ...rows].join('\r\n') + '\r\n');
    const run = await runShape(scrambledBytes, axis, null, 512);
    assert.equal(run.rows, ordered.rows, `${label}: same row count`);
    assert.deepEqual(
      new Uint8Array(run.accumulator.cube.buffer),
      new Uint8Array(ordered.accumulator.cube.buffer),
      `${label} rows must produce a byte-identical cube`,
    );
    assert.deepEqual(run.accumulator.tou, ordered.accumulator.tou, `${label}: TOU must match`);
  }
  ok('reversed and shuffled row order produce a byte-identical cube -- order carries no meaning');

  // And against the independent reference, not only against ourselves.
  const scrambledBytes = new TextEncoder().encode(
    [lines[0], ...shuffle(lines.slice(1), 7)].join('\r\n') + '\r\n',
  );
  const run = await runShape(scrambledBytes, axis, null, 512);
  const reference = referenceCube(new TextDecoder().decode(scrambledBytes), run.plan.metrics, axis);
  assertWithinOneUlp(
    compareCubes(reference.cube, run.accumulator.cube, run.plan.metrics),
    'a shuffled export',
  );
  ok('a shuffled export matches the independent reference parser cell for cell');
}

// Two rows for the same (area, hour) is the one thing the scatter cannot
// resolve: it would keep whichever worker finished last, silently. Two exports
// of one year concatenated do exactly this.
{
  const axis = ['A', 'B', 'C'];
  const { bytes } = syntheticCsv(axis, 4, { hours: 5 });
  const lines = new TextDecoder()
    .decode(bytes)
    .split('\r\n')
    .filter((l) => l.length > 0);
  const doubled = new TextEncoder().encode(
    [lines[0], ...lines.slice(1), ...lines.slice(1)].join('\r\n') + '\r\n',
  );
  await assert.rejects(
    async () => runShape(doubled, axis, null, 1 << 20),
    /both describe area index/,
    'the same area-hour twice must be refused, not resolved by arrival order',
  );
  ok('a duplicated area-hour is refused rather than decided by which worker finished first');
}

// ---------------------------------------------------------------- axis scan
//
// The area axis must be read from every row. Guessing it from the first rows
// (read Name until one repeats) silently returns a short axis whenever the
// first hour does not list every area exactly once.
{
  const axis = ['A', 'B', 'C', 'D'];
  const { metrics, bytes } = syntheticCsv(axis, 5, { hours: 4 });
  // Drop area D from hour 1 only, so the old first-hour rule would miss it.
  const lines = new TextDecoder()
    .decode(bytes)
    .split('\r\n')
    .filter((l) => l.length > 0);
  const thinned = lines.filter(
    (line, i) => !(i > 0 && i <= axis.length && line.split(',')[3] === 'D'),
  );
  const thinnedBytes = new TextEncoder().encode(thinned.join('\r\n') + '\r\n');

  const shapeParser = await instantiateParser(wasmModule);
  const scan = scanAxis(thinnedBytes, shapeParser);
  assert.deepEqual(
    scan.names.slice().sort(),
    axis.slice().sort(),
    'every area must be found, including one absent from the first hour',
  );
  assert.equal(scan.rows, thinned.length - 1);
  // The scan reports the axis and the row bound, and deliberately nothing about
  // ordering -- see AxisScan. A field here is a field someone can build a
  // refusal on, and row order carries no meaning.
  assert.deepEqual(
    Object.keys(scan).sort(),
    ['names', 'rows'],
    'the scan must not report ordering: no inversion count, no hour range',
  );
  ok(`the area axis is read from every row: ${scan.names.length} areas, ${scan.rows} rows`);

  // A padded Name must land as the same area, since the axis is the key.
  const padded = syntheticCsv(axis, 5, { hours: 2, pad: '  ' });
  const paddedScan = scanAxis(padded.bytes, shapeParser);
  assert.deepEqual(paddedScan.names.slice().sort(), axis.slice().sort());
  ok('the scan trims Name, so a padded file yields the same axis');

  // A scrambled file scans like the ordered one: same axis, same row bound.
  // The SAME thinned rows are reversed so the bounds are comparable.
  const scrambled = [thinned[0], ...thinned.slice(1).reverse()].join('\r\n') + '\r\n';
  const scrambledScan = scanAxis(new TextEncoder().encode(scrambled), shapeParser);
  assert.deepEqual(
    scrambledScan.names.slice().sort(),
    axis.slice().sort(),
    'a scrambled file still yields the COMPLETE axis',
  );
  assert.equal(scrambledScan.rows, scan.rows, 'and the same row bound as the ordered file');
  ok(`a scrambled file scans as ordinary: complete axis, ${scrambledScan.rows} rows, no verdict`);
  void metrics;
}

// A row the parser cannot place is refused, never dropped: an hour outside
// 1-24 (an hour-beginning 0-23 export would otherwise load shifted), an
// unreadable date, a row that ends before Name. Feb 29 alone is dropped.
{
  const axis = ['A', 'B'];
  const good = ['1/1/2035,1,OffPeak,A,1', '1/1/2035,1,OffPeak,B,2'];
  const load = (extra) =>
    runShape(
      new TextEncoder().encode(['Date,Hour,TOU,Name,M'].concat(good, extra).join('\r\n') + '\r\n'),
      axis,
    );
  for (const [bad, what] of [
    ['1/1/2035,0,OffPeak,A,9', 'hour 0'],
    ['1/1/2035,25,OffPeak,A,9', 'hour 25'],
    ['13/1/2035,1,OffPeak,A,9', 'month 13'],
    ['2035-01-01,1,OffPeak,A,9', 'an ISO date'],
    ['1/1/2035,1,OffPeak', 'a row short of Name'],
  ]) {
    await assert.rejects(load([bad]), /could not read/, `${what} is refused`);
  }
  const leap = await load(['2/29/2036,1,OffPeak,A,9']);
  assert.equal(leap.rows, 2, 'the Feb 29 row is dropped, the others kept');
  ok('an unreadable date or hour, or a short row, refuses the load; Feb 29 is dropped');
}

// The committed binary's ABI, stated (instantiateParser also gates on it).
assert.equal(PARSER_ABI, 7);
ok(`block.wasm ABI ${PARSER_ABI} matches this build`);

// Presence, and the leap-year statement ingest must make.
{
  const finalized = finalizeCase(
    run.accumulator,
    'sample.csv',
    run.header.metricNames,
    2036,
    areas,
  );
  // The table carries NO name: the filename labels warnings only, and
  // identity belongs to the Case.
  assert.equal(
    Object.hasOwn(finalized.data, 'name'),
    false,
    'finalizeCase must not embed the source filename in the table',
  );
  assert.equal(finalized.data.metrics.length, run.plan.metrics.length);
  assert.equal(finalized.data.presence.length, AREA_COUNT * run.plan.metrics.length);
  let present = 0;
  for (const flag of finalized.data.presence) present += flag;
  assert.equal(
    present,
    AREA_COUNT * run.plan.metrics.length,
    'every (area, metric) in the sample is present',
  );
  assert.ok(
    finalized.warnings.some((w) => w.includes('Feb 29')),
    'a leap-year case must state that Feb 29 was dropped',
  );
  ok('presence bitmap is full, and the leap-year Feb 29 drop is stated, not silent');
}

// ---------------------------------------------------------------- calculated columns
//
// `Gen - Load` has no source column; its plane is filled from two others.
// Checked against the reference cube: it must be neither NaN nor built from
// the wrong metric.
{
  const DERIVED = 'Gen - Load';
  const metrics = [...run.header.metricNames, DERIVED];
  const plan = buildColumnPlan(run.header, metrics);
  const accumulator = createAccumulator(plan, AREA_COUNT);
  for (const [from, to] of run.ranges) {
    blitBlock(accumulator, parseRange(parser, sampleBytes, from, to, plan, AREA_COUNT));
  }

  const derivedIndex = plan.metrics.indexOf(DERIVED);
  const genIndex = plan.metrics.indexOf('Generation (MWh)');
  const loadIndex = plan.metrics.indexOf('Load (MWh)');
  assert.ok(derivedIndex >= 0 && genIndex >= 0 && loadIndex >= 0, 'operands must be on the axis');

  // Before the fill pass the plane is untouched NaN, so a missing call cannot
  // masquerade as zeros.
  const at = (metric, area, hour) =>
    accumulator.cube[(area * plan.metrics.length + metric) * HOURS + hour];
  assert.ok(Number.isNaN(at(derivedIndex, 0, 0)), 'the derived plane must start absent');
  assert.equal(plan.presence[derivedIndex], 0, 'no source column feeds it, so presence starts 0');

  applyDerived(accumulator);
  assert.equal(plan.presence[derivedIndex], 1, 'presence must be set once the plane is built');

  let compared = 0;
  for (let area = 0; area < AREA_COUNT; area++) {
    for (let hour = 0; hour < HOURS; hour++) {
      const gen = at(genIndex, area, hour);
      const load = at(loadIndex, area, hour);
      const got = at(derivedIndex, area, hour);
      if (Number.isNaN(gen) || Number.isNaN(load)) {
        assert.ok(
          Number.isNaN(got),
          `absent operand must stay absent at area ${area} hour ${hour}`,
        );
        continue;
      }
      assert.ok(
        Object.is(got, Math.fround(gen - load)),
        `Gen - Load wrong at area ${area} hour ${hour}`,
      );
      compared++;
    }
  }
  assert.ok(compared > 0, 'the derived check must actually compare something');
  ok(`Gen - Load computed for all ${compared} live cells, absent where an operand is`);

  // Dropping an operand must leave it absent rather than half-built.
  const without = buildColumnPlan(
    run.header,
    [...run.header.metricNames, DERIVED].filter((name) => name !== 'Load (MWh)'),
  );
  const partial = createAccumulator(without, AREA_COUNT);
  for (const [from, to] of run.ranges) {
    blitBlock(partial, parseRange(parser, sampleBytes, from, to, without, AREA_COUNT));
  }
  applyDerived(partial);
  assert.equal(
    without.presence[without.metrics.indexOf(DERIVED)],
    0,
    'without an operand the calculated column must stay absent, not be built from nothing',
  );
  ok('Gen - Load stays absent when an operand was not retained');

  // `Export - Import` is net exports only for unsigned operands, so the fill
  // warns when one is signed.
  const NET = 'Export - Import';
  const netPlan = buildColumnPlan(run.header, [...run.header.metricNames, NET]);
  const netAcc = createAccumulator(netPlan, AREA_COUNT);
  for (const [from, to] of run.ranges) {
    blitBlock(netAcc, parseRange(parser, sampleBytes, from, to, netPlan, AREA_COUNT));
  }
  const netWarnings = applyDerived(netAcc);
  const netIndex = netPlan.metrics.indexOf(NET);
  const importIndex = netPlan.metrics.indexOf('Import Flow(MWh)');
  const exportIndex = netPlan.metrics.indexOf('Export Flow (MWh)');
  const netAt = (metric, area, hour) =>
    netAcc.cube[(area * netPlan.metrics.length + metric) * HOURS + hour];

  let netCompared = 0;
  for (let area = 0; area < AREA_COUNT; area++) {
    for (let hour = 0; hour < HOURS; hour++) {
      const imported = netAt(importIndex, area, hour);
      const exported = netAt(exportIndex, area, hour);
      if (Number.isNaN(imported) || Number.isNaN(exported)) continue;
      assert.ok(
        Object.is(netAt(netIndex, area, hour), Math.fround(exported - imported)),
        `Export - Import wrong at area ${area} hour ${hour}`,
      );
      netCompared++;
    }
  }
  assert.ok(netCompared > 0, 'the net interchange check must actually compare something');
  ok(`the column equals Export minus Import for all ${netCompared} live cells`);

  // The fixture's Export Flow is negative, which the guard must report.
  assert.equal(netWarnings.length, 1, `expected one sign warning, got ${netWarnings.length}`);
  assert.ok(
    netWarnings[0].includes('Export Flow (MWh)') && netWarnings[0].includes('sign convention'),
    `the warning must name the signed operand: ${netWarnings[0]}`,
  );
  ok('a negative operand is reported instead of silently inverting the net figure');

  // Both operands unsigned: the assumption the column is named for, and the
  // case that must stay quiet or the warning is noise nobody reads.
  for (let area = 0; area < AREA_COUNT; area++) {
    const base = (area * netPlan.metrics.length + exportIndex) * HOURS;
    for (let hour = 0; hour < HOURS; hour++)
      netAcc.cube[base + hour] = Math.abs(netAcc.cube[base + hour]);
  }
  assert.deepEqual(applyDerived(netAcc), [], 'unsigned operands must not raise a sign warning');
  ok('unsigned operands raise nothing');
}

// A dividing calculated column: x/0 must land absent, not Infinity (which no
// NaN guard catches).
{
  const RATIO = 'Generation / Installed Capacity';
  const plan = buildColumnPlan(run.header, [...run.header.metricNames, RATIO]);
  const accumulator = createAccumulator(plan, AREA_COUNT);
  for (const [from, to] of run.ranges) {
    blitBlock(accumulator, parseRange(parser, sampleBytes, from, to, plan, AREA_COUNT));
  }

  const ratioIndex = plan.metrics.indexOf(RATIO);
  const genIndex = plan.metrics.indexOf('Generation (MWh)');
  const capIndex = plan.metrics.indexOf('Installed Capacity (MW)');
  assert.ok(ratioIndex >= 0 && genIndex >= 0 && capIndex >= 0, 'operands must be on the axis');
  const at = (metric, area, hour) =>
    accumulator.cube[(area * plan.metrics.length + metric) * HOURS + hour];

  // One forced zero denominator, on a cell both operands cover (a zero where
  // nothing reported is just absent).
  let zeroed = false;
  for (let area = 0; area < AREA_COUNT && !zeroed; area++) {
    for (let hour = 0; hour < HOURS; hour++) {
      if (Number.isNaN(at(genIndex, area, hour)) || Number.isNaN(at(capIndex, area, hour)))
        continue;
      accumulator.cube[(area * plan.metrics.length + capIndex) * HOURS + hour] = 0;
      zeroed = true;
      break;
    }
  }
  assert.ok(zeroed, 'the fixture must cover at least one (Generation, Installed Capacity) cell');

  const warnings = applyDerived(accumulator);
  let compared = 0;
  for (let area = 0; area < AREA_COUNT; area++) {
    for (let hour = 0; hour < HOURS; hour++) {
      const gen = at(genIndex, area, hour);
      const capacity = at(capIndex, area, hour);
      const got = at(ratioIndex, area, hour);
      if (Number.isNaN(gen) || Number.isNaN(capacity) || capacity === 0) {
        assert.ok(Number.isNaN(got), `a zero or absent denominator must stay absent, not Infinity`);
        continue;
      }
      assert.ok(
        Object.is(got, Math.fround(gen / capacity)),
        `${RATIO} wrong at area ${area} hour ${hour}`,
      );
      compared++;
    }
  }
  assert.ok(compared > 0, 'the ratio check must actually compare something');
  assert.ok(
    warnings.some((w) => w.includes(RATIO) && w.includes('Installed Capacity (MW)')),
    `a zero denominator must be reported: ${JSON.stringify(warnings)}`,
  );
  ok(`${RATIO} computed for ${compared} live cells; zero denominators absent and reported`);
}

console.log(`\n${checks} checks passed`);
