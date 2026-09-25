// tests/test_long_key_layout.mjs — the long reader's key-column layout is a
// NUMBER (Area: 4 key columns; bus and generator: 6), driven here at a
// six-key shape:
//   - the scan reads the identity at `entityCol`;
//   - key columns after the identity are skipped, never parsed as metrics;
//   - an unreadable layout is refused at instantiate, by name.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './test_loader.mjs';

const { entityHashes, parseHeaderLine, buildColumnPlan, keyColsOf } =
  await import('../src/tables/long/header.ts');
const { BUS_LONG } = await import('../src/tables/bus/long.ts');
const { GENERATOR_LONG } = await import('../src/tables/generator/long.ts');
const { instantiateParser, parseBytes, scanAxis, AREA_KEY_LAYOUT } =
  await import('../src/tables/long/block.ts');
const { unionOf, AREA_LONG } = await import('../src/tables/area/long.ts');
const { layoutOf, readCasePlan, createAccumulator, blitBlock, unionMetricsOf } =
  await import('../src/tables/long/pool.ts');
const { finalizeBusLong } = await import('../src/tables/bus/long.ts');
const { finalizeGeneratorLong } = await import('../src/tables/generator/long.ts');
const { HOURS_PER_YEAR } = await import('../src/model/calendar.ts');

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

const wasmModule = new WebAssembly.Module(
  readFileSync(new URL('../parser/long/block.wasm', import.meta.url)),
);

// A bus-shaped long export: six key columns, identity (BusID) at column 3,
// BusName and Area carried but not cube data, two metrics after them.
const BUS_LAYOUT = { keyCols: 6, entityCol: 3 };
const busIds = ['40001', '40002'];
const header = 'Date,Hour,TOU,BusID,BusName,Area,LMP ($/MWh),Load (MW)';
const rows = [
  '01/01/2036,1,OffPeak,40001,OAKRIDGE,LoadArea1,31.5,120.25',
  '01/01/2036,1,OffPeak,40002,PINEHOLLOW,LoadArea2,32.5,220.25',
  '01/01/2036,2,OnPeak,40001,OAKRIDGE,LoadArea1,41.5,130.25',
];
const bytes = new TextEncoder().encode([header, ...rows].join('\r\n') + '\r\n');
const bodyStart = bytes.indexOf(10) + 1;

const parser = await instantiateParser(wasmModule, entityHashes(busIds), BUS_LAYOUT);

// ------------------------------------------------------------------ the scan
{
  const scan = scanAxis(parser, bytes, bodyStart, bytes.length);
  assert.deepEqual(
    scan.names,
    busIds,
    'the axis is the BusID column. At the area layout the scan would have read ' +
      'BusName, and every bus would have collapsed onto its station name.',
  );
  assert.equal(scan.rows, rows.length);
  ok(`the axis scan reads column ${BUS_LAYOUT.entityCol}: ${scan.names.join(', ')}`);
}

// ----------------------------------------------------------------- the parse
{
  // Both metrics retained: source metric m is column keyCols + m.
  const payload = parseBytes(
    parser,
    bytes,
    bodyStart,
    bytes.length,
    Int32Array.from([0, 1]),
    busIds.length,
    2,
    rows.length,
  );
  assert.equal(payload.rows, 3, 'every row placed');

  const at = (bus, hour) => {
    for (let r = 0; r < payload.rows; r++) {
      if (payload.rowEntity[r] === bus && payload.rowHour[r] === hour) {
        return [payload.values[r * 2], payload.values[r * 2 + 1]];
      }
    }
    return null;
  };
  // Hour is hour-ending in the file, hour-beginning in the cube: 1 -> 0.
  assert.deepEqual(at(0, 0), [31.5, 120.25]);
  assert.deepEqual(at(1, 0), [32.5, 220.25]);
  assert.deepEqual(at(0, 1), [41.5, 130.25]);
  ok('metrics start at column 6: the LMP and Load values land on planes 0 and 1');

  // The failure this test exists for: at the area layout, source metric 0 is
  // column 4 -- BusName -- and parse_float over "OAKRIDGE" is a number
  // nobody asked for on plane 0.
  const areaLayout = await instantiateParser(wasmModule, entityHashes(busIds), AREA_KEY_LAYOUT);
  const wrong = parseBytes(
    areaLayout,
    bytes,
    bodyStart,
    bytes.length,
    Int32Array.from([0, 1]),
    busIds.length,
    2,
    rows.length,
  );
  assert.equal(wrong.rows, 3, 'the rows still place: BusID sits at column 3 either way');
  const wrongFirst = [wrong.values[0], wrong.values[1]];
  assert.ok(
    !(wrongFirst[0] === 31.5 && wrongFirst[1] === 120.25),
    'the area layout must NOT reproduce the right numbers -- it reads BusName and Area as ' +
      `metrics, and got ${wrongFirst.join(', ')}`,
  );
  ok('the same bytes at the area layout produce other numbers -- the layout is doing the work');
}

// ---------------------------------------------------------------- a refusal
for (const bad of [
  { keyCols: 4, entityCol: 2 },
  { keyCols: 3, entityCol: 3 },
  { keyCols: 0, entityCol: 0 },
]) {
  await assert.rejects(
    () => instantiateParser(wasmModule, undefined, bad),
    /refuses a key layout/,
    `layout ${JSON.stringify(bad)} must be refused, not silently read as an area file`,
  );
}
ok('a layout that collides with Date/Hour/TOU is refused at instantiate, by name');

// ------------------------------------------- the header parse takes it too
//
// The header parse is configured with the kind's signature and reports where
// the metrics start.
{
  const busHeader = parseHeaderLine(
    'Date, Hour, TOU,BusID,BusName,Area ,LMP ($/MWh),Load (MW)',
    BUS_LONG,
  );
  assert.equal(busHeader.keyCols, 6);
  assert.equal(busHeader.entityCol, 3);
  assert.deepEqual(busHeader.metricNames, ['LMP ($/MWh)', 'Load (MW)']);
  assert.deepEqual(keyColsOf(BUS_LONG), busHeader.keyCols);

  const genHeader = parseHeaderLine(
    'Date,Hour,TOU,UnitName,BusID,UnitID,Generation (MWh)',
    GENERATOR_LONG,
  );
  assert.deepEqual(genHeader.metricNames, ['Generation (MWh)']);
  ok('the header parse reads a six-key-column bus or generator header, metrics and all');

  // The plan is built off the file's own keyCols, so BusName and Area are
  // skipped rather than landing on planes 0 and 1 as they would at four.
  const plan = buildColumnPlan(busHeader, busHeader.metricNames);
  assert.deepEqual([...plan.slabPlan], [0, 1]);
  assert.equal(plan.sourceMetricCount, 2);
  assert.equal(plan.plan[4], -1, 'BusName is a key column, not a metric');
  assert.equal(plan.plan[5], -1, 'Area is a key column, not a metric');
  ok("the column plan starts the metrics after the kind's key columns, not after four");

  // Area is unchanged, and still the default: nothing that called this before
  // the signature was a parameter had to change.
  const areaHeader = parseHeaderLine('Date, Hour, TOU, Name,Load (MW)', AREA_LONG);
  assert.equal(areaHeader.keyCols, keyColsOf(AREA_LONG));
  assert.deepEqual(areaHeader.metricNames, ['Load (MW)']);
  assert.throws(
    () => parseHeaderLine('Date,Hour,TOU,BusID,BusName,Area,LMP ($/MWh)', AREA_LONG),
    /missing the required key column "Name"/,
  );
  ok('the area signature is the default, and a bus header still fails it by name');

  // A signature whose columns are present but out of order is refused rather
  // than read at the offsets the parser will be told.
  assert.throws(
    () => parseHeaderLine('Date,Hour,TOU,BusName,BusID,Area,LMP ($/MWh)', BUS_LONG),
    /Unsupported column layout/,
  );
  ok('key columns in the wrong order are refused, not read at the offsets they are not at');
}

// -------------------------------------------------- the plan carries the layout
//
// Workers get the layout from the plans' own headers, so module and column
// plan cannot disagree.
{
  const csv = [header, ...rows].join('\r\n') + '\r\n';
  const busPlan = await readCasePlan(new File([csv], 'buses.csv'), BUS_LONG);
  assert.equal(busPlan.header.keyCols, 6);
  assert.equal(busPlan.header.entityCol, 3);
  assert.deepEqual(layoutOf([busPlan]), BUS_LAYOUT);
  ok("a case plan read at a kind's signature carries that kind's key layout");

  const areaCsv = 'Date, Hour, TOU, Name,Load (MW)\r\n01/01/2036,1,OffPeak,A1,12.5\r\n';
  const areaPlan = await readCasePlan(new File([areaCsv], 'areas.csv'), AREA_LONG);
  assert.deepEqual(layoutOf([areaPlan]), AREA_KEY_LAYOUT);
  ok('area is still the default layout, and still four key columns');

  // One batch is one kind. Mixed plans are refused by name rather than parsed
  // at whichever layout happened to come first.
  assert.throws(
    () => layoutOf([busPlan, areaPlan]),
    /buses\.csv has 6 key columns and areas\.csv has 4/,
  );
  ok('a batch whose files disagree about their key layout is refused by name');
}

// ------------------------------------------- one file, one table per metric
//
// One table per metric, identical to what the wide reader would produce.
{
  const busHeader = parseHeaderLine(header, BUS_LONG);
  const plan = buildColumnPlan(busHeader, busHeader.metricNames);
  const accumulator = createAccumulator(plan, busIds.length);
  const payload = parseBytes(
    parser,
    bytes,
    bodyStart,
    bytes.length,
    plan.activePlanes,
    busIds.length,
    plan.sourceMetricCount,
    rows.length,
  );
  blitBlock(accumulator, payload);

  const casePlan = {
    file: { name: 'buses.csv' },
    label: 'buses.csv',
    header: busHeader,
    year: 2036,
  };
  const { data: tables, warnings } = finalizeBusLong(accumulator, casePlan, busIds);

  assert.equal(tables.length, 2, 'two metric columns, two BusTables');
  assert.deepEqual(
    tables.map((t) => t.quantity),
    ['LMP ($/MWh)', 'Load (MW)'],
    'each table is keyed on its own quantity -- that is the slot variant',
  );
  for (const table of tables) {
    assert.deepEqual([...table.buses], [40001, 40002], 'the axis is the Int32 BusID');
    assert.equal(table.cube.length, busIds.length * HOURS_PER_YEAR);
    assert.deepEqual([...table.presence], [1, 1]);
  }
  // Hour-ending 1 in the file is hour 0 in the cube, and the two metrics went
  // to two tables rather than to two planes of one.
  assert.equal(tables[0].cube[0], 31.5);
  assert.equal(tables[0].cube[HOURS_PER_YEAR], 32.5);
  assert.equal(tables[1].cube[0], 120.25);
  assert.equal(tables[1].cube[HOURS_PER_YEAR], 220.25);
  assert.ok(Number.isNaN(tables[0].cube[2]), 'an hour no row covered stays NaN, never zero');
  ok('a long bus export becomes one BusTable per metric, keyed on the BusID axis');

  // Said once for the file, not once per table: one file that covers 3 of
  // 8,760 hours is one note, not eight.
  assert.equal(warnings.length, 2, warnings.join(' | '));
  assert.match(warnings[0], /buses\.csv: covers 2 of 8,760 hours/);
  assert.match(warnings[1], /2036 is a leap year/);
  ok("the file's notes are written once for the file, not once per table it produced");

  // The names are deliberately empty: a long export carries BusName in every
  // row, but the scan reads only the identity column and the browse tab falls
  // back to the session-wide BusList exactly when the export's name is empty.
  assert.deepEqual(tables[0].names, ['', '']);
  ok('a long-loaded bus carries no label of its own, so the BusList names it');

  // A bus id that is not an integer is refused, not coerced: the axis IS the
  // id, so there is nothing to fall back to.
  assert.throws(
    () => finalizeBusLong(accumulator, casePlan, ['40001', 'OAKRIDGE']),
    /not an integer bus number/,
  );
  ok('a non-integer BusID is refused rather than read as NaN on the axis');
}

{
  // The same path for generator, whose axis is the unit NAME and needs no id
  // resolution at all.
  const genHeader = 'Date,Hour,TOU,UnitName,BusID,UnitID,Generation (MWh),Fuel Cost ($)';
  const genRows = [
    '01/01/2036,1,OffPeak,OAK 1,40001,G1,540.5,1200.25',
    '01/01/2036,1,OffPeak,PINE 2,40002,G2,320.5,900.75',
  ];
  const genBytes = new TextEncoder().encode([genHeader, ...genRows].join('\r\n') + '\r\n');
  const genStart = genBytes.indexOf(10) + 1;
  const units = ['OAK 1', 'PINE 2'];
  const genParser = await instantiateParser(wasmModule, entityHashes(units), {
    keyCols: 6,
    entityCol: 3,
  });
  const parsed = parseHeaderLine(genHeader, GENERATOR_LONG);
  const plan = buildColumnPlan(parsed, parsed.metricNames);
  const accumulator = createAccumulator(plan, units.length);
  blitBlock(
    accumulator,
    parseBytes(
      genParser,
      genBytes,
      genStart,
      genBytes.length,
      plan.activePlanes,
      units.length,
      plan.sourceMetricCount,
      genRows.length,
    ),
  );
  const { data: tables } = finalizeGeneratorLong(
    accumulator,
    { file: { name: 'gens.csv' }, label: 'gens.csv', header: parsed, year: 2036 },
    units,
  );
  assert.deepEqual(
    tables.map((t) => t.quantity),
    ['Generation (MWh)', 'Fuel Cost ($)'],
  );
  assert.deepEqual(tables[0].generators, units, "the axis is the UnitName, this kind's identity");
  assert.equal(tables[0].cube[0], 540.5);
  assert.equal(tables[1].cube[HOURS_PER_YEAR], 900.75);
  ok('a long generator export becomes one GeneratorTable per metric on the unit-name axis');
}

// ------------------------------------------- the metric union a kind offers
//
// Bus and generator use `unionMetricsOf`: area's calculated columns would be
// offered and never filled.
{
  const header = 'Date,Hour,TOU,Name,Generation (MWh),Load (MWh)';
  const plans = [{ header: parseHeaderLine(header, AREA_LONG) }];
  assert.ok(
    unionOf(plans).includes('Gen - Load'),
    "area's own union offers the calculated columns its finalizer fills",
  );
  assert.deepEqual(
    unionMetricsOf(plans),
    ['Generation (MWh)', 'Load (MWh)'],
    'the kind-neutral union is the header and nothing else',
  );
  ok("unionMetricsOf offers the file's own metrics, without area's calculated columns");
}

console.log(`\n${checks} checks passed.`);
