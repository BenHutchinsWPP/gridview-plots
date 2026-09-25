// tests/test_ingest_area_wide.mjs — a single-metric (wide) Area export loads
// as an AreaTable, not as interfaces:
//
//   1. It detects as `area`, shape `W`.
//   2. The axis is the header, in source order, with no scan pass.
//   3. Cell-by-cell parity via the AreaTable's own index, proving the wide
//      cube is adopted as-is at one metric.
//   4. It aggregates through the Area kernels.
//   5. It rolls into groupings.
//   6. An intensive metric (no weight in a one-metric file) is weighted by 1
//      with a warning naming the column.
//   7. A wide and a long Area table round-trip in one bundle.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './test_loader.mjs';
import { exportCsv } from './test_fixtures_interface.mjs';

const { classify } = await import('../src/detect.ts');
const { parseHeaderLine, parseTitleLine, buildColumnPlan, PREAMBLE_LINES } =
  await import('../src/tables/wide/header.ts');
const { instantiateParser, parseBytes, afterNextNewline, maxRowsAt } =
  await import('../src/tables/wide/block.ts');
const { createAccumulator, blitBlock, layoutFor } = await import('../src/tables/wide/pool.ts');
const { AREA_ENTITY, finalizeCase, AREA_WIDE_SPEC } = await import('../src/tables/area/wide.ts');
const { buildSeries } = await import('../src/tables/area/kernels.ts');
const { setGroupings, setAxis, areasIn } = await import('../src/tables/area/groupings.ts');
const { serializeAreaTable, deserializeAreaTable } = await import('../src/tables/area/types.ts');
const { HOURS_PER_YEAR } = await import('../src/model/calendar.ts');

const HOURS = HOURS_PER_YEAR;
const NEWLINE = 10;
const decoder = new TextDecoder();

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

const wasmModule = new WebAssembly.Module(
  readFileSync(new URL('../parser/wide/block.wasm', import.meta.url)),
);
const parser = await instantiateParser(wasmModule);

/** Area names in the shapes a real export uses -- spaces and hyphens
 * included, because columns map by trimmed name and must survive both. */
const AREAS = ['NORTH', 'SOUTH EAST', 'WEST-1', 'CENTRAL'];
/** EXTENSIVE / SUM in data/area/aggregation-rules.json, so it aggregates by
 * addition across areas -- the plain case. */
const EXTENSIVE = 'Load (MWh)';
/** WEIGHTED_MEAN, weighted by 'Load (MWh)'. A wide file carries one metric,
 * so the weight column cannot be in the same table. See check 6. */
const INTENSIVE = 'Avg LMP Weighted by Load ($/MWh)';

function skipLines(bytes, n) {
  let at = 0;
  for (let i = 0; i < n; i++) {
    const nl = bytes.indexOf(NEWLINE, at);
    if (nl < 0) return -1;
    at = nl + 1;
  }
  return at;
}

/** Drive the wide reader over a whole in-memory export and finalize it the way
 * `src/tables/area/wide.ts` does, block by block. */
function loadWideArea(bytes, retained, blockBytes = 32 * 1024) {
  const headerStart = skipLines(bytes, PREAMBLE_LINES);
  const headerEnd = bytes.indexOf(NEWLINE, headerStart);
  const header = parseHeaderLine(
    decoder.decode(bytes.subarray(headerStart, headerEnd)),
    AREA_WIDE_SPEC.entityNoun,
  );
  const title = parseTitleLine(decoder.decode(bytes.subarray(0, bytes.indexOf(NEWLINE))));
  const dataStart = headerEnd + 1;
  const year = Number(
    decoder
      .decode(bytes.subarray(dataStart, bytes.indexOf(NEWLINE, dataStart)))
      .split(',', 1)[0]
      .split('/')[2],
  );

  const plan = buildColumnPlan(header, retained);
  const layout = layoutFor(parser.budget, plan);
  const accumulator = createAccumulator(plan);

  for (let start = dataStart; start < bytes.length; start += blockBytes) {
    const from = start === dataStart ? dataStart : afterNextNewline(bytes, start);
    if (from < 0) continue;
    let to = afterNextNewline(bytes, Math.min(start + blockBytes, bytes.length));
    if (to < 0) to = bytes.length;
    if (to <= from) continue;
    blitBlock(accumulator, parseBytes(parser, layout, bytes, from, to, plan.activePlanes, year));
  }
  return finalizeCase(accumulator, 'wide case', year, title);
}

/** Independent parser: strings, split, parseFloat. Deliberately naive, and it
 * indexes the cube the way an AreaTable does rather than the way the wide
 * reader does -- which is the point of check 3. */
function referenceAreaCube(text, axis) {
  const lines = text.split('\n');
  const header = lines[PREAMBLE_LINES].replace(/\r$/, '')
    .split(',')
    .map((s) => s.trim());
  const numMetrics = 1;
  const cube = new Float32Array(axis.length * numMetrics * HOURS).fill(NaN);
  const CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

  for (let i = PREAMBLE_LINES + 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (line.length === 0) continue;
    const fields = line.split(',');
    const [month, day] = fields[0].split('/').map(Number);
    if (month === 2 && day === 29) continue;
    const hour = (CUM[month - 1] + day - 1) * 24 + (Number(fields[1]) - 1);
    for (let col = 3; col < fields.length; col++) {
      const area = axis.indexOf(header[col]);
      if (area < 0) continue;
      cube[(area * numMetrics + 0) * HOURS + hour] = Math.fround(parseFloat(fields[col]));
    }
  }
  return cube;
}

// ---------------------------------------------------------------- 1. detect

const wide = exportCsv({
  entity: AREA_ENTITY,
  names: AREAS,
  quantity: EXTENSIVE,
  year: 2036,
  days: 3,
  hours: 24,
});

const verdict = classify(wide, 'All Areas Full Year Single Characteristic.csv');
assert.equal(verdict.kind, 'area', 'a wide Area export classifies as area, not interface');
assert.equal(verdict.shape, 'W', 'and it says which SHAPE it is, so the router can pick a parser');
assert.equal(verdict.confidence, 'high');
ok('a wide Area export detects as area/W with high confidence, not as interfaces');

// The same bytes with the Interface entity word are still an Interface file:
// the ONLY thing that separates them is that first word.
const asInterface = classify(
  exportCsv({ entity: 'Interface', names: AREAS, quantity: EXTENSIVE, days: 1, hours: 2 }),
  'flows.csv',
);
assert.equal(asInterface.kind, 'interface');
assert.equal(asInterface.shape, 'W');
ok('the entity word is the whole of the difference: the same shape reads as interface');

// A wide export whose entity word no adapter claims still refuses honestly.
// `Zone` stands in for the next kind: every kind GridView is known to export
// in this shape has an adapter, and what is being tested is the gate.
const asZone = classify(
  exportCsv({ entity: 'Zone', names: AREAS, quantity: EXTENSIVE, days: 1, hours: 2 }),
  'zone.csv',
);
assert.equal(asZone.kind, 'unrecognized', 'a kind with no adapter is refused, not guessed at');
assert.match(asZone.reason, /"Zone"/, 'and the refusal names the kind it read');
ok('a wide export of a kind with no adapter is still refused by name');

// ---------------------------------------------------------------- 2, 3. load

const { data: table, warnings } = loadWideArea(wide, AREAS);

assert.deepEqual(table.areas, AREAS, 'the area axis is the header, in source order');
assert.deepEqual(table.metrics, [EXTENSIVE], "the metric axis is the title line's quantity");
assert.deepEqual(table.sourceColumns, [EXTENSIVE]);
assert.equal(table.year, 2036);
assert.equal(table.presence.length, AREAS.length * 1, 'one presence byte per (area, metric)');
assert.ok(
  [...table.presence].every((p) => p === 1),
  'every column the header carried is present',
);
ok('a wide Area export loads into an AreaTable with the correct area axis');

const reference = referenceAreaCube(decoder.decode(wide), AREAS);
assert.equal(table.cube.length, reference.length, 'the cube is (areas x 1 metric x 8760)');
let compared = 0;
for (let i = 0; i < reference.length; i++) {
  const expected = reference[i];
  const actual = table.cube[i];
  if (Number.isNaN(expected)) {
    assert.ok(Number.isNaN(actual), `hour ${i} should be no-data`);
  } else {
    assert.equal(actual, expected, `cell ${i}`);
    compared++;
  }
}
assert.equal(compared, AREAS.length * 3 * 24, 'every emitted cell was compared, not skipped');
ok(`${compared} cells match an independent reference parser at AreaTable indices`);

assert.deepEqual(
  warnings.filter((w) => !w.includes('covers')),
  [],
  'no unexpected warnings',
);
ok('the only warning is the honest partial-year coverage note');

// ---------------------------------------------------------------- 4, 5. aggregate

setAxis(AREAS.slice());

const out = new Float32Array(HOURS);
const summed = buildSeries(table, EXTENSIVE, AREAS, out);
assert.equal(summed.refusal, undefined, `aggregation refused: ${summed.refusal ?? ''}`);
assert.equal(summed.rule.series, 'SUM', 'Load (MWh) is EXTENSIVE, summed across areas');

// Hour 0 of the year, summed by hand off the cube.
let expectedHour0 = 0;
for (let a = 0; a < AREAS.length; a++) expectedHour0 += table.cube[a * HOURS + 0];
assert.ok(
  Math.abs(summed.values[0] - expectedHour0) < 1e-3,
  `summed hour 0 is ${summed.values[0]}, expected ${expectedHour0}`,
);
ok('an EXTENSIVE metric aggregates across the wide axis through the ordinary Area kernels');

setGroupings('Name,Grouping\nNORTH,Half\nSOUTH EAST,Half\n');
const half = areasIn('Half');
assert.deepEqual(half, ['NORTH', 'SOUTH EAST']);
const grouped = buildSeries(table, EXTENSIVE, half, new Float32Array(HOURS));
assert.equal(grouped.refusal, undefined);
const expectedGrouped = table.cube[0 * HOURS + 0] + table.cube[1 * HOURS + 0];
assert.ok(
  Math.abs(grouped.values[0] - expectedGrouped) < 1e-3,
  'the grouping sums exactly its two areas',
);
ok('a wide Area table rolls into a grouping — the third thing the misdetection took away');

// ---------------------------------------------------------------- 6. the intensive case

const intensive = loadWideArea(
  exportCsv({ entity: AREA_ENTITY, names: AREAS, quantity: INTENSIVE, days: 1, hours: 4 }),
  AREAS,
).data;
assert.deepEqual(intensive.metrics, [INTENSIVE]);
const weighted = buildSeries(
  intensive,
  INTENSIVE,
  AREAS,
  new Float32Array(HOURS),
  new Float32Array(HOURS),
);
assert.notEqual(weighted.values, null, 'an intensive metric without its weight column still plots');
assert.equal(
  weighted.weightColumn,
  undefined,
  'but it must NOT claim to be weighted -- the stats table keys its pooled-weighted row off this',
);
assert.ok(
  weighted.warnings.some((w) => w.includes('Load (MWh)') && /weight 1/.test(w)),
  `the warning must name the missing weight column and say every area weighs 1: ${JSON.stringify(weighted.warnings)}`,
);

// It really is the plain mean, not something that merely looks plotted.
let expectedMean = 0;
for (let a = 0; a < AREAS.length; a++) expectedMean += intensive.cube[a * HOURS + 0];
expectedMean /= AREAS.length;
assert.ok(
  Math.abs(weighted.values[0] - expectedMean) < 1e-3,
  `hour 0 is ${weighted.values[0]}, expected the plain mean ${expectedMean}`,
);
ok('an intensive wide export falls back to weight 1, plots the plain mean, and says so');

// ---------------------------------------------------------------- 7. round trip

// A LONG Area table on the same axis: several metrics, the same 8,760 hours.
const longMetrics = [EXTENSIVE, 'Generation (MWh)'];
const longCube = new Float32Array(AREAS.length * longMetrics.length * HOURS);
for (let i = 0; i < longCube.length; i++) longCube[i] = i % 977;
const longTable = {
  cube: longCube,
  areas: AREAS.slice(),
  metrics: longMetrics,
  presence: new Uint8Array(AREAS.length * longMetrics.length).fill(1),
  tou: new Uint8Array(HOURS).fill(1),
  sourceColumns: longMetrics,
  year: 2036,
};

for (const [label, original] of [
  ['wide', table],
  ['long', longTable],
]) {
  const { fields, cube } = serializeAreaTable(original);
  const back = deserializeAreaTable(
    fields,
    cube.buffer.slice(cube.byteOffset, cube.byteOffset + cube.byteLength),
  );
  assert.deepEqual(back.areas, original.areas, `${label}: axis survives`);
  assert.deepEqual(back.metrics, original.metrics, `${label}: metrics survive`);
  assert.deepEqual([...back.presence], [...original.presence], `${label}: presence byte-for-byte`);
  assert.equal(back.cube.length, original.cube.length, `${label}: cube length`);
  for (let i = 0; i < original.cube.length; i++) {
    const a = original.cube[i];
    const b = back.cube[i];
    assert.ok(Number.isNaN(a) ? Number.isNaN(b) : a === b, `${label}: cube cell ${i}`);
  }
}
ok('a wide and a long Area table round-trip through the same envelope identically');

console.log(`\n${checks} checks passed.`);
