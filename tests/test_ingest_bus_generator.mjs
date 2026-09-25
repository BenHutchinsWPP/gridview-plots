// tests/test_ingest_bus_generator.mjs — a new shape-W kind costs one
// TypeScript adapter and no wasm, ABI or build change. The bus id row
// (header on line 6, `preambleLines: 5`) is the numbers-only rule's test:
//
//   1. a wide generator export loads with the right axis;
//   2. a wide bus export loads keyed on the Int32 id from the id row;
//   3. two buses sharing a NAME load as two planes;
//   4. an unreadable id row is refused;
//   5. both round-trip through the save envelope.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './test_loader.mjs';
import { exportCsv } from './test_fixtures_interface.mjs';

const { classify } = await import('../src/detect.ts');
const { parseHeaderLine, parseTitleLine, buildColumnPlan } =
  await import('../src/tables/wide/header.ts');
const { instantiateParser, parseBytes, afterNextNewline } =
  await import('../src/tables/wide/block.ts');
const { createAccumulator, blitBlock, layoutFor, finalizeWide } =
  await import('../src/tables/wide/pool.ts');
const busWide = await import('../src/tables/bus/wide.ts');
const generatorWide = await import('../src/tables/generator/wide.ts');
const { serializeBusTable, deserializeBusTable } = await import('../src/tables/bus/types.ts');
const { serializeGeneratorTable, deserializeGeneratorTable } =
  await import('../src/tables/generator/types.ts');
const { HOURS_PER_YEAR } = await import('../src/model/calendar.ts');

const HOURS = HOURS_PER_YEAR;
const NEWLINE = 10;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

const parser = await instantiateParser(
  new WebAssembly.Module(readFileSync(new URL('../parser/wide/block.wasm', import.meta.url))),
);

/** A wide bus export with its id row (only this kind has one). */
function busExportCsv({ ids, names, quantity = 'LMP ($/MWh)', year = 2035, rows = 4 }) {
  const lines = [
    `Bus Hourly '${quantity}' Data for Year ${year}`,
    '',
    `(From the first hour of 1/1/${year} to the last hour of 12/31/${year}. Column identifier -- BusName)`,
    '',
    ['', '', 'BusNumber', ...ids].join(','),
    ['Date', ' Hour', ' TOU', ...names].join(','),
  ];
  for (let hour = 1; hour <= rows; hour++) {
    lines.push(
      [
        `1/1/${year}`,
        String(hour),
        hour % 2 ? 'OffPeak' : 'OnPeak',
        ...ids.map((id, i) => String(id + hour / 10 + i)),
      ].join(','),
    );
  }
  return encoder.encode(lines.join('\r\n') + '\r\n');
}

/** A `File`-alike over an in-memory buffer: `readCasePlan` only slices and
 * reads `name`/`size`, so this is enough to drive the real code path
 * (including the preamble hand-over the bus adapter reads its id row from). */
function fileOf(bytes, name) {
  return {
    name,
    size: bytes.length,
    slice(start, end) {
      const part = bytes.subarray(start, Math.min(end ?? bytes.length, bytes.length));
      return {
        arrayBuffer: async () =>
          part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength),
      };
    },
  };
}

/** Parse a whole in-memory export through the wide reader, given the plan a
 * kind adapter produced, and finalize it the way that adapter's `ingest`
 * would. */
function loadWide(bytes, plan, spec, finalize, blockBytes = 32 * 1024) {
  const columnPlan = buildColumnPlan(plan.header, plan.header.entityNames);
  const layout = layoutFor(parser.budget, columnPlan);
  const accumulator = createAccumulator(columnPlan);
  for (let start = plan.dataStart; start < bytes.length; start += blockBytes) {
    const from = start === plan.dataStart ? plan.dataStart : afterNextNewline(bytes, start);
    if (from < 0) continue;
    let to = afterNextNewline(bytes, Math.min(start + blockBytes, bytes.length));
    if (to < 0) to = bytes.length;
    if (to <= from) continue;
    blitBlock(
      accumulator,
      parseBytes(parser, layout, bytes, from, to, columnPlan.activePlanes, plan.year),
    );
  }
  const shaped = finalizeWide(accumulator, 'case', plan.year, plan.title, spec);
  return finalize(shaped.data, plan).data;
}

// ---------------------------------------------------------------- generator

const GENERATORS = ['2018 G40 1 PV-T', '2021 G2 1 PV-T', 'HYDRO_04'];
const genBytes = exportCsv({
  entity: 'Generator',
  names: GENERATORS,
  quantity: 'Generation (MWh)',
  year: 2036,
  days: 1,
  hours: 4,
});

const genVerdict = classify(genBytes, 'gens.csv');
assert.equal(genVerdict.kind, 'generator');
assert.equal(genVerdict.shape, 'W');
assert.equal(genVerdict.variant, 'Generation (MWh)');
ok('a wide generator export detects as generator/W with its quantity as the slot variant');

const genPlan = await generatorWide.readCasePlan(fileOf(genBytes, 'gens.csv'));
const genTable = loadWide(
  genBytes,
  genPlan,
  generatorWide.GENERATOR_WIDE_SPEC,
  generatorWide.finalizeGenerator,
);
assert.deepEqual(
  genTable.generators,
  GENERATORS,
  'the generator axis is the header, in source order',
);
assert.equal(genTable.quantity, 'Generation (MWh)');
assert.equal(genTable.year, 2036);
assert.equal(genTable.cube.length, GENERATORS.length * HOURS);
assert.ok([...genTable.presence].every((p) => p === 1));
// Spot-check against the file: generator 1, hour 0.
const genLines = decoder.decode(genBytes).split('\r\n');
const genRow0 = genLines[5].split(',');
assert.equal(genTable.cube[1 * HOURS + 0], Math.fround(parseFloat(genRow0[4])));
ok('a wide generator export loads with the correct generator axis and the right values');

// ---------------------------------------------------------------- bus

const BUS_IDS = [10001, 10002, 10003];
const BUS_NAMES = ['HAWTHORNE', 'ASPENDALE', 'HAWTHORNE'];
const busBytes = busExportCsv({ ids: BUS_IDS, names: BUS_NAMES });

const busVerdict = classify(busBytes, 'buses.csv');
assert.equal(busVerdict.kind, 'bus');
assert.equal(busVerdict.shape, 'W');
assert.match(busVerdict.reason, /line 6/, 'detection found the header on line 6, under the id row');
ok('a wide bus export detects as bus/W with its header on line 6');

const busPlan = await busWide.readCasePlan(fileOf(busBytes, 'buses.csv'));
assert.deepEqual(
  busPlan.header.entityNames,
  BUS_IDS.map(String),
  'the column plan is keyed on the id, not on the name',
);
const busTable = loadWide(busBytes, busPlan, busWide.BUS_WIDE_SPEC, busWide.finalizeBus);

assert.ok(busTable.buses instanceof Int32Array, 'the bus axis is an Int32Array of ids');
assert.deepEqual([...busTable.buses], BUS_IDS);
assert.deepEqual(busTable.names, BUS_NAMES, 'the labels ride alongside, in the same order');
assert.equal(busTable.quantity, 'LMP ($/MWh)');
assert.equal(busTable.cube.length, BUS_IDS.length * HOURS);
ok('a wide bus export loads with the correct bus axis, keyed on the Int32 id');

// Buses 10001 and 10003 share a name; a name-keyed axis would silently merge
// them.
assert.equal(busTable.buses.length, 3, 'a duplicated NAME does not collapse two buses');
const busLines = decoder.decode(busBytes).split('\r\n');
const busRow0 = busLines[6].split(',');
for (let i = 0; i < BUS_IDS.length; i++) {
  assert.equal(
    busTable.cube[i * HOURS + 0],
    Math.fround(parseFloat(busRow0[3 + i])),
    `bus ${BUS_IDS[i]} hour 0`,
  );
}
assert.notEqual(
  busTable.cube[0 * HOURS + 0],
  busTable.cube[2 * HOURS + 0],
  'the two same-named buses hold their own values, not one shared plane',
);
ok('two buses sharing a name load as two planes — what keying on the id buys');

// ---------------------------------------------------------------- refusals

await assert.rejects(
  busWide.readCasePlan(
    fileOf(
      // Four preamble lines: a bus export without its id row. The header then
      // lands where the id row should be, and there is no id to key on.
      exportCsv({ entity: 'Bus', names: BUS_NAMES, quantity: 'LMP ($/MWh)', days: 1, hours: 2 }),
      'no-id-row.csv',
    ),
  ),
  /BusNumber/,
  'a bus export with no id row is refused, naming the row it needs',
);

await assert.rejects(
  busWide.readCasePlan(
    fileOf(busExportCsv({ ids: [10001, 'NOT_A_NUMBER', 10003], names: BUS_NAMES }), 'bad-id.csv'),
  ),
  /32-bit integer bus number/,
  'an id that is not an integer is refused rather than coerced',
);

await assert.rejects(
  busWide.readCasePlan(
    fileOf(busExportCsv({ ids: [10001, 10002, 10001], names: BUS_NAMES }), 'dup-id.csv'),
  ),
  /appears twice/,
  'a duplicated id is refused — it would write two columns onto one plane',
);
ok('a missing, unreadable or duplicated id row is refused, never guessed past');

// ---------------------------------------------------------------- round trip

for (const [label, table, serialize, deserialize] of [
  ['bus', busTable, serializeBusTable, deserializeBusTable],
  ['generator', genTable, serializeGeneratorTable, deserializeGeneratorTable],
]) {
  const { fields, cube } = serialize(table);
  // The manifest is JSON on the wire, so anything that does not survive
  // JSON.stringify does not survive a save. An Int32Array would not.
  const wire = JSON.parse(JSON.stringify(fields));
  wire.presence = fields.presence;
  wire.tou = fields.tou;
  const back = deserialize(
    wire,
    cube.buffer.slice(cube.byteOffset, cube.byteOffset + cube.byteLength),
  );
  assert.equal(back.cube.length, table.cube.length, `${label}: cube length`);
  assert.deepEqual([...back.presence], [...table.presence], `${label}: presence byte-for-byte`);
  if (label === 'bus') {
    assert.ok(back.buses instanceof Int32Array, 'bus: the id axis comes back as an Int32Array');
    assert.deepEqual([...back.buses], [...table.buses]);
    assert.deepEqual(back.names, table.names);
  } else {
    assert.deepEqual(back.generators, table.generators);
  }
}
ok('both kinds round-trip through the save envelope, ids and all');

console.log(`\n${checks} checks passed.`);
