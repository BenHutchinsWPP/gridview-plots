// tests/test_append_area.mjs
//
// An Area table joined by a later drop (src/tables/area/append.ts):
//   - disjoint metrics over the same areas and hours join with every value
//   - the plane index uses the joined metric count, areas are found by name
//   - an area outside the loaded axis is refused
//   - a calculated column whose operands came apart is named, not filled
//   - the joined table survives a save round trip
//
// Run:  node test_append_area.mjs

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { appendAreaTable, areaAppendSize } = await import('../src/tables/area/append.ts');
const { appendNotes } = await import('../src/tables/append.ts');
const areaAppendNotes = (files, label, old, fresh) =>
  appendNotes(files, label, appendAreaTable(old, fresh)).filter((n) =>
    /could be calculated/.test(n),
  );
const { serializeAreaTable, deserializeAreaTable } = await import('../src/tables/area/types.ts');
const { YEAR_SLOT_HOURS: H } = await import('../src/model/calendar.ts');

let checks = 0;
function ok(label) {
  checks++;
  console.log(`  ok  ${label}`);
}

/** value(area name, metric name, hour) is distinct per cell. */
const value = (area, metric, h) =>
  (area.charCodeAt(0) * 1000 + metric.charCodeAt(0)) * 10 + (h % 7);

function table(areas, metrics, firstYear = 2030, numYears = 1) {
  const hours = numYears * H;
  const cube = new Float32Array(areas.length * metrics.length * hours);
  areas.forEach((a, ai) =>
    metrics.forEach((m, mi) => {
      const base = (ai * metrics.length + mi) * hours;
      for (let h = 0; h < hours; h++) cube[base + h] = value(a, m, h);
    }),
  );
  return {
    cube,
    areas,
    metrics,
    presence: new Uint8Array(areas.length * metrics.length).fill(1),
    tou: new Uint8Array(hours).fill(1),
    hoursPresent: new Uint8Array(hours).fill(1),
    sourceColumns: [...metrics],
    firstYear,
    numYears,
  };
}
function cell(t, area, metric, h) {
  const a = t.areas.indexOf(area);
  const m = t.metrics.indexOf(metric);
  return t.cube[(a * t.metrics.length + m) * t.numYears * H + h];
}

const AREAS = ['ALDER', 'BIRCH', 'CEDAR'];

// Disjoint metrics, same areas and hours.
{
  const old = table(AREAS, ['A (MW)', 'B (MW)', 'C (MW)']);
  const fresh = table(AREAS, ['X (MW)', 'Y (MW)', 'Z (MW)']);
  const r = appendAreaTable(old, fresh);
  assert.deepEqual(r.table.metrics, [...old.metrics, ...fresh.metrics]);
  assert.deepEqual(r.added, fresh.metrics);
  assert.equal(r.noun, 'metric');
  assert.equal(r.overlapping.length, 0);
  assert.equal(r.table.presence.length, 18);
  assert.ok(r.table.presence.every((p) => p === 1));
  for (const area of AREAS)
    for (const m of r.table.metrics)
      for (const h of [0, 1440, 8783])
        assert.equal(cell(r.table, area, m, h), value(area, m, h), `${area} ${m} ${h}`);
  assert.equal(r.wrote, 3 * 3 * H);
  assert.deepEqual(r.table.areas, old.areas);
  const size = areaAppendSize(old, fresh);
  assert.equal(size.numYears, 1);
  assert.deepEqual(
    size.factors.map((f) => f.count),
    [6, 3],
  );
  ok('disjoint metrics join, every value in its plane');
}

// Wide Load then Gen: one metric each.
{
  const old = table(AREAS, ['Load (MWh)']);
  const fresh = table(AREAS, ['Generation (MWh)']);
  const r = appendAreaTable(old, fresh);
  assert.deepEqual(r.table.metrics, ['Load (MWh)', 'Generation (MWh)']);
  assert.equal(
    cell(r.table, 'BIRCH', 'Generation (MWh)', 5),
    value('BIRCH', 'Generation (MWh)', 5),
  );
  assert.equal(cell(r.table, 'BIRCH', 'Load (MWh)', 5), value('BIRCH', 'Load (MWh)', 5));
  ok('wide Load then Gen gives two metrics');
}

// Areas in another order, and a subset, map by name.
{
  const old = table(AREAS, ['A (MW)']);
  const fresh = table(['CEDAR', 'ALDER'], ['B (MW)', 'C (MW)', 'D (MW)']);
  const r = appendAreaTable(old, fresh);
  assert.deepEqual(r.table.areas, AREAS);
  assert.equal(cell(r.table, 'ALDER', 'B (MW)', 9), value('ALDER', 'B (MW)', 9));
  assert.equal(cell(r.table, 'CEDAR', 'B (MW)', 9), value('CEDAR', 'B (MW)', 9));
  assert.ok(Number.isNaN(cell(r.table, 'BIRCH', 'B (MW)', 9)));
  assert.equal(cell(r.table, 'CEDAR', 'D (MW)', 3), value('CEDAR', 'D (MW)', 3));
  assert.equal(r.table.presence[1 * 4 + 1], 0);
  assert.equal(r.table.presence[0 * 4 + 1], 1);
  assert.equal(cell(r.table, 'BIRCH', 'A (MW)', 9), value('BIRCH', 'A (MW)', 9));
  ok('areas map by name; an area the file lacks is absent');
}

// An area outside the axis throws.
{
  const old = table(AREAS, ['A (MW)']);
  const fresh = table(['ALDER', 'MAPLE'], ['B (MW)']);
  assert.throws(() => appendAreaTable(old, fresh), /MAPLE/);
  ok('an area outside the axis is refused');
}

// Operands from different drops: named, not filled.
{
  const old = table(AREAS, ['Load (MWh)']);
  const fresh = table(AREAS, ['Generation (MWh)']);
  const notes = areaAppendNotes('gen.csv', 'the Case', old, fresh);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Gen - Load/);
  assert.ok(!appendAreaTable(old, fresh).table.metrics.includes('Gen - Load'));
  const both = table(AREAS, ['Load (MWh)', 'Generation (MWh)']);
  assert.deepEqual(areaAppendNotes('f', 't', both, table(AREAS, ['Other (MW)'])), []);
  ok('a calculated column with split operands is named, not filled');
}

// Years extend, and the save round trip keeps the joined table.
{
  const old = table(AREAS, ['A (MW)'], 2030, 1);
  const fresh = table(AREAS, ['B (MW)'], 2031, 1);
  const r = appendAreaTable(old, fresh);
  assert.equal(r.table.numYears, 2);
  const { fields, cube } = serializeAreaTable(r.table);
  const back = deserializeAreaTable(
    fields,
    cube.buffer.slice(cube.byteOffset, cube.byteOffset + cube.byteLength),
  );
  assert.deepEqual(back.areas, r.table.areas);
  assert.deepEqual(back.metrics, r.table.metrics);
  assert.deepEqual(Array.from(back.presence), Array.from(r.table.presence));
  assert.deepEqual(Array.from(back.tou), Array.from(r.table.tou));
  assert.deepEqual(Array.from(back.hoursPresent), Array.from(r.table.hoursPresent));
  assert.equal(back.cube.length, r.table.cube.length);
  for (let i = 0; i < back.cube.length; i++)
    assert.ok(Object.is(back.cube[i], r.table.cube[i]), `cube ${i}`);
  assert.equal(back.firstYear, 2030);
  ok('save round trip deep-equals');
}

{
  const { reindexCase } = await import('../src/tables/area/axis.ts');
  const { hasCell, coverCell } = await import('../src/tables/coverage.ts');
  const original = table(['A', 'B'], ['X', 'Y'], 2035, 2);
  original.cellCoverage = new Uint8Array(original.cube.length / 8);
  coverCell(original.cellCoverage, 0);
  coverCell(original.cellCoverage, 3 * 2 * H + H + 7);
  const moved = reindexCase(original, ['B', 'New', 'A']);
  assert.equal(hasCell(moved.cellCoverage, 4 * 2 * H), true);
  assert.equal(hasCell(moved.cellCoverage, 1 * 2 * H + H + 7), true);
  assert.equal(hasCell(moved.cellCoverage, 0), false);
  assert.ok(moved.cellCoverage.subarray((2 * 2 * H) / 8, (4 * 2 * H) / 8).every((b) => b === 0));
  assert.equal(hasCell(original.cellCoverage, 0), true, 'the source bitmap stays unchanged');
  ok('Area axis widening and reordering move packed ownership over each whole span');
}

console.log(`${checks} checks`);
