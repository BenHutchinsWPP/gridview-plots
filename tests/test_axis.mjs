// tests/test_axis.mjs — the Area axis rebuild (`reindexCase`), which moves
// every plane of a cube to a new index when a drop adds areas. A wrong move
// is SILENT (one area's numbers under another's name), so it is checked
// against the bytes of real ingested cubes:
//
//   1. every cube is axis.length × metrics.length × 8760 values;
//   2. every present plane lands at its NEW index, byte-identical, presence
//      kept;
//   3. planes for areas a file never carried are presence 0 and NaN, never 0.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './test_loader.mjs';

const { parseHeaderLine, buildColumnPlan, entityHashes } =
  await import('../src/tables/long/header.ts');
const { instantiateParser, parseBytes, scanAxis } = await import('../src/tables/long/block.ts');
const { finalizeCase, AREA_LONG } = await import('../src/tables/area/long.ts');
const { createAccumulator, blitBlock, unionEntities } = await import('../src/tables/long/pool.ts');
const { reindexCase, sameAxis } = await import('../src/tables/area/axis.ts');
const { CaseStore } = await import('../src/model/case-model.ts');
const { HOURS_PER_YEAR } = await import('../src/model/calendar.ts');

const HOURS = HOURS_PER_YEAR;
const NEWLINE = 10;

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

// ---------------------------------------------------------------- fixtures
//
// Two small synthetic exports with DISJOINT area sets.

/** Non-leap, so nothing here depends on the Feb 29 drop. */
const YEAR = 2035;
const METRICS = ['Load (MWh)', 'Generation (MWh)'];
const AREAS_A = ['NORTH', 'EAST', 'CENTRAL'];
const AREAS_B = ['SOUTH', 'WEST'];
const FILE_HOURS = 3;

/** A distinct value per (file, area, metric, hour), so a misplaced plane
 * disagrees. */
function cellValue(file, areaIndex, metricIndex, hour) {
  return file * 100000 + areaIndex * 1000 + metricIndex * 100 + hour;
}

/** `metrics` is the subset this file's header carries; omitting one creates a
 * presence-0 plane on the table's OWN axis, so the presence move is
 * exercised with both 0 and 1. */
function csvFor(file, areas, metrics = METRICS) {
  // Stray spaces on three key columns and CRLF throughout, exactly as the real
  // export (and test_fixtures.mjs) has them.
  const lines = [['Date', ' Hour', ' TOU', ' Name', ...metrics].join(',')];
  for (let hour = 1; hour <= FILE_HOURS; hour++) {
    areas.forEach((area, areaIndex) => {
      const fields = [`1/1/${YEAR}`, String(hour), hour % 2 === 0 ? 'OnPeak' : 'OffPeak', area];
      for (const metricName of metrics) {
        const metric = METRICS.indexOf(metricName);
        fields.push(cellValue(file, areaIndex, metric, hour).toFixed(3));
      }
      lines.push(fields.join(','));
    });
  }
  return new TextEncoder().encode(lines.join('\r\n') + '\r\n');
}

const wasmModule = new WebAssembly.Module(
  readFileSync(new URL('../parser/long/block.wasm', import.meta.url)),
);

/** Parse one whole file into a finished AreaTable on its OWN area axis.
 *  `metrics` (default: all of METRICS) is what this file's own header
 *  carries -- see csvFor. */
async function ingestFile(file, areas, label, metrics = METRICS) {
  const bytes = csvFor(file, areas, metrics);
  const headerEnd = bytes.indexOf(NEWLINE);
  const header = parseHeaderLine(new TextDecoder().decode(bytes.subarray(0, headerEnd)), AREA_LONG);
  const plan = buildColumnPlan(header, METRICS);

  // One parser instance per file: the hash table is the file's own area axis.
  const parser = await instantiateParser(wasmModule, entityHashes(areas));
  const accumulator = createAccumulator(plan, areas.length);
  const from = headerEnd + 1;
  const scan = scanAxis(parser, bytes, from, bytes.length);
  blitBlock(
    accumulator,
    parseBytes(
      parser,
      bytes,
      from,
      bytes.length,
      plan.activePlanes,
      areas.length,
      plan.sourceMetricCount,
      scan.rows,
    ),
  );
  return finalizeCase(accumulator, label, header.metricNames, YEAR, areas).data;
}

// File A carries only 'Load (MWh)', so its metric-1 planes are presence 0
// before any reindex.
const FILE_A_METRICS = ['Load (MWh)'];
const tableA = await ingestFile(1, AREAS_A, 'north.csv', FILE_A_METRICS);
const tableB = await ingestFile(2, AREAS_B, 'south.csv');

// The ingested cubes really do hold what the fixture wrote, or every assertion
// below would be comparing one wrong cube against another. Metrics the file
// does not carry must read back as presence-0 and NaN, not as data.
for (const [file, areas, table, carriedMetrics] of [
  [1, AREAS_A, tableA, new Set(FILE_A_METRICS)],
  [2, AREAS_B, tableB, new Set(METRICS)],
]) {
  areas.forEach((_, areaIndex) => {
    for (let metric = 0; metric < METRICS.length; metric++) {
      const base = (areaIndex * METRICS.length + metric) * HOURS;
      const presenceIndex = areaIndex * METRICS.length + metric;
      if (carriedMetrics.has(METRICS[metric])) {
        assert.equal(
          table.presence[presenceIndex],
          1,
          `file ${file} area ${areaIndex} metric ${metric} must be present`,
        );
        for (let hour = 1; hour <= FILE_HOURS; hour++) {
          assert.equal(
            table.cube[base + (hour - 1)],
            cellValue(file, areaIndex, metric, hour),
            `file ${file} area ${areaIndex} metric ${metric} hour ${hour}`,
          );
        }
      } else {
        assert.equal(
          table.presence[presenceIndex],
          0,
          `file ${file} area ${areaIndex} metric ${metric} must be absent`,
        );
        for (let hour = 0; hour < HOURS; hour++) {
          assert.ok(
            Number.isNaN(table.cube[base + hour]),
            `file ${file} area ${areaIndex} metric ${metric} hour ${hour} must be NaN, not data, for an absent column`,
          );
        }
      }
    }
  });
}
ok(
  `two disjoint-axis files ingest: ${AREAS_A.length} areas (Load only, Generation presence-0) and ` +
    `${AREAS_B.length} areas (both metrics)`,
);

// ---------------------------------------------------------------- the store
//
// Each table on its own Case, which owns name and id, so the reindex can
// replace a table wholesale.

const store = new CaseStore();
const caseA = store.createCase('north.csv');
const caseB = store.createCase('south.csv');
store.attachTable(caseA.id, { kind: 'area' }, tableA);
store.attachTable(caseB.id, { kind: 'area' }, tableB);

assert.notEqual(caseA.id, 'north.csv', 'a Case id is never the source filename');
assert.equal(Object.hasOwn(tableA, 'name'), false, 'an AreaTable carries no name');
assert.equal(store.tablesOfKind('area').length, 2);
ok('both tables attach to their own Case at slot {kind:"area"}, ids independent of the filenames');

// ---------------------------------------------------------------- the union
//
// ONE union over the batch plus the loaded axis.

const axis = unionEntities([{ entities: AREAS_A }, { entities: AREAS_B }], []);
assert.deepEqual(axis, [...AREAS_A, ...AREAS_B]);
assert.equal(sameAxis(axis, AREAS_A), false, 'the union is a different axis from either file');
ok(`the batch union is ${axis.length} areas, in first-seen order`);

// A snapshot of every plane BEFORE the move, to compare bytes against.
function snapshot(table) {
  return {
    areas: table.areas.slice(),
    metrics: table.metrics.slice(),
    presence: table.presence.slice(),
    cube: table.cube.slice(),
  };
}
const beforeA = snapshot(tableA);
const beforeB = snapshot(tableB);

/** One (area, metric) plane as raw bytes — byte-identity, not float equality,
 * so a NaN payload or a rounding change would both show up. */
function planeBytes(cube, numMetrics, areaIndex, metricIndex) {
  const plane = areaIndex * numMetrics + metricIndex;
  return Buffer.from(cube.buffer, cube.byteOffset + plane * HOURS * 4, HOURS * 4);
}

// The reindex, exactly as main.ts's adoptAxis runs it: replace each Case's
// area slot with the rebuilt table. Map#set on an existing key keeps its
// position, so the rail order does not shuffle.
for (const { caseId, data } of store.tablesOfKind('area')) {
  store.attachTable(caseId, { kind: 'area' }, reindexCase(data, axis), { replace: true });
}

const reindexed = new Map(store.tablesOfKind('area').map((row) => [row.caseId, row.data]));
const afterA = reindexed.get(caseA.id);
const afterB = reindexed.get(caseB.id);

// --- 1. shape -------------------------------------------------------------
for (const [label, after] of [
  ['north.csv', afterA],
  ['south.csv', afterB],
]) {
  assert.deepEqual(after.areas, axis, `${label}: the table now names the union axis`);
  assert.equal(
    after.cube.length,
    axis.length * METRICS.length * HOURS,
    `${label}: cube is axis x metrics x 8760`,
  );
  assert.equal(
    after.presence.length,
    axis.length * METRICS.length,
    `${label}: presence bitmap is one byte per (area, metric)`,
  );
}
ok(`both cubes are exactly ${axis.length} x ${METRICS.length} x ${HOURS} values after the reindex`);

// --- 2. every present plane survives, byte-identical, at its new index ------
for (const [label, before, after] of [
  ['north.csv', beforeA, afterA],
  ['south.csv', beforeB, afterB],
]) {
  const numMetrics = before.metrics.length;
  let moved = 0;
  before.areas.forEach((area, oldArea) => {
    const newArea = axis.indexOf(area);
    assert.ok(newArea >= 0, `${label}: ${area} must be on the union axis`);
    for (let metric = 0; metric < numMetrics; metric++) {
      assert.equal(
        after.presence[newArea * numMetrics + metric],
        before.presence[oldArea * numMetrics + metric],
        `${label}: presence for ${area}/${METRICS[metric]} must move with its plane`,
      );
      assert.ok(
        planeBytes(before.cube, numMetrics, oldArea, metric).equals(
          planeBytes(after.cube, numMetrics, newArea, metric),
        ),
        `${label}: ${area}/${METRICS[metric]} must be byte-identical at index ${newArea}`,
      );
      moved++;
    }
  });
  assert.equal(moved, before.areas.length * numMetrics, `${label}: every plane checked`);
}
ok('every plane present before the reindex is byte-identical at its new index, presence and all');

// --- 3. planes for an area the file never carried are absent, not zero -----
for (const [label, before, after] of [
  ['north.csv', beforeA, afterA],
  ['south.csv', beforeB, afterB],
]) {
  const numMetrics = before.metrics.length;
  const carried = new Set(before.areas);
  let checkedPlanes = 0;
  axis.forEach((area, areaIndex) => {
    if (carried.has(area)) return;
    for (let metric = 0; metric < numMetrics; metric++) {
      assert.equal(
        after.presence[areaIndex * numMetrics + metric],
        0,
        `${label}: ${area}/${METRICS[metric]} was never in this file and must read as absent`,
      );
      const start = (areaIndex * numMetrics + metric) * HOURS;
      for (let hour = 0; hour < HOURS; hour++) {
        // NaN, never 0: a zero-filled plane is a plausible number a kernel
        // that skipped the presence check would happily average in.
        if (!Number.isNaN(after.cube[start + hour])) {
          assert.fail(
            `${label}: ${area}/${METRICS[metric]} hour ${hour} is ${after.cube[start + hour]}, ` +
              `expected NaN`,
          );
        }
      }
      checkedPlanes++;
    }
  });
  assert.equal(
    checkedPlanes,
    (axis.length - before.areas.length) * numMetrics,
    `${label}: every new plane checked`,
  );
}
ok('every plane for an area the file never carried is presence === 0 and NaN-filled, not zero');

// --- the no-op path -------------------------------------------------------
// A drop that introduces no new area must not rebuild a 72 MB cube.
assert.equal(
  reindexCase(afterA, axis),
  afterA,
  'reindexCase onto the axis a table is already on returns it unchanged, allocating nothing',
);
ok('reindexing onto the same axis is a no-op that returns the same object');

console.log(`\n${checks} checks passed`);
