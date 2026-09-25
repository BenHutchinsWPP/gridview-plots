// tests/test_long_merge.mjs — date-split long files read into ONE table:
//   - both halves fill one cube;
//   - each member's own column ORDER is followed;
//   - drop order does not change any entity's numbers;
//   - the same entity-hour in two members is refused;
//   - group refusals: two years, or one column spelled two ways.
// Merges join the HOUR axis only, so the duplicate check stays one bit per
// (entity, hour).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './test_loader.mjs';

const { entityHashes, parseHeaderLine, buildColumnPlan } =
  await import('../src/tables/long/header.ts');
const { BUS_LONG } = await import('../src/tables/bus/long.ts');
const { instantiateParser, parseBytes } = await import('../src/tables/long/block.ts');
const { createAccumulator, blitBlock, readCasePlan } = await import('../src/tables/long/pool.ts');
const { checkMergeGroup, unionMetricNames } = await import('../src/tables/long/merge.ts');
const { finalizeBusLong } = await import('../src/tables/bus/long.ts');
const { HOURS_PER_YEAR } = await import('../src/model/calendar.ts');

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

const wasmModule = new WebAssembly.Module(
  readFileSync(new URL('../parser/long/block.wasm', import.meta.url)),
);
const BUS_LAYOUT = { keyCols: 6, entityCol: 3 };
const busIds = ['40001', '40002'];
const parser = await instantiateParser(wasmModule, entityHashes(busIds), BUS_LAYOUT);

/** The retained metric axis every group in this file shares. It is the CUBE's
 * axis, so a member carrying its columns in another order still lands on it. */
const RETAINED = ['LMP ($/MWh)', 'Load (MW)'];

/** One half of a year, as bytes plus the header it was written with. */
function half(headerLine, rows) {
  const text = [headerLine, ...rows].join('\r\n') + '\r\n';
  const bytes = new TextEncoder().encode(text);
  return { header: parseHeaderLine(headerLine, BUS_LONG), bytes, rows: rows.length };
}

/** Blit `members` into one accumulator, in the order given, and finalize. */
function merge(members) {
  const union = { ...members[0].header, metricNames: RETAINED };
  const accumulator = createAccumulator(buildColumnPlan(union, RETAINED), busIds.length);
  for (const member of members) {
    const plan = buildColumnPlan(member.header, RETAINED);
    const bodyStart = member.bytes.indexOf(10) + 1;
    blitBlock(
      accumulator,
      parseBytes(
        parser,
        member.bytes,
        bodyStart,
        member.bytes.length,
        plan.activePlanes,
        busIds.length,
        plan.sourceMetricCount,
        member.rows,
      ),
      plan,
    );
  }
  const casePlan = {
    file: { name: 'merged' },
    label: 'jan.csv + jul.csv',
    header: union,
    year: 2035,
  };
  return { accumulator, ...finalizeBusLong(accumulator, casePlan, busIds) };
}

const KEYS = 'Date,Hour,TOU,BusID,BusName,Area';
const JAN = half(`${KEYS},LMP ($/MWh),Load (MW)`, [
  '01/01/2035,1,OffPeak,40001,OAKRIDGE,LoadArea1,31.5,120.25',
  '01/01/2035,2,OnPeak,40001,OAKRIDGE,LoadArea1,41.5,130.25',
  '01/01/2035,1,OffPeak,40002,PINEHOLLOW,LoadArea2,32.5,220.25',
]);
// The second half carries its two metrics in the OTHER order. A merged cube
// whose metric axis came from the first member would put July's prices on
// load's plane, and every number would still look perfectly plausible.
const JUL = half(`${KEYS},Load (MW),LMP ($/MWh)`, [
  '07/01/2035,1,OnPeak,40001,OAKRIDGE,LoadArea1,500.5,77.5',
  '07/01/2035,2,OnPeak,40002,PINEHOLLOW,LoadArea2,600.5,88.5',
]);

/** Hour 0 of July 1st in a non-leap year: 181 days in. */
const JUL1 = 181 * 24;

// ------------------------------------------------ two halves become one year
{
  const { data: tables, accumulator } = merge([JAN, JUL]);
  const lmp = tables.find((t) => t.quantity === 'LMP ($/MWh)');
  const load = tables.find((t) => t.quantity === 'Load (MW)');

  // January, from the first file.
  assert.equal(lmp.cube[0], 31.5);
  assert.equal(load.cube[0], 120.25);
  // July, from the second -- on the right plane despite its reversed columns.
  assert.equal(lmp.cube[JUL1], 77.5);
  assert.equal(load.cube[JUL1], 500.5);
  assert.equal(lmp.cube[HOURS_PER_YEAR + JUL1 + 1], 88.5);
  assert.equal(load.cube[HOURS_PER_YEAR + JUL1 + 1], 600.5);
  ok('two halves fill one cube, each member read at its OWN column order');

  // The coverage record rides on the TABLE, not just the
  // accumulator: it is what a later drop into this slot is gated on, and it
  // has to survive finalize and the bundle to be worth anything.
  let covered = 0;
  for (let h = 0; h < HOURS_PER_YEAR; h++) covered += accumulator.hourSeen[h];
  assert.equal(covered, 4, "the merged table covers both halves' hours, not one half's");
  for (const table of tables) {
    assert.equal(table.hoursPresent.length, HOURS_PER_YEAR);
    assert.equal(
      table.hoursPresent.reduce((n, h) => n + h, 0),
      4,
      "every table cut from the group carries the group's coverage",
    );
    assert.equal(table.hoursPresent[0], 1, 'January hour 1');
    assert.equal(table.hoursPresent[JUL1], 1, 'July hour 1');
    assert.equal(table.hoursPresent[JUL1 - 1], 0, 'an hour no member covered');
  }
  ok("the merged table's coverage is the union of its members'");
}

// ------------------------------------------------------ drop order is nothing
//
// Compared per entity, not byte for byte: axis order is internal.
{
  const forward = merge([JAN, JUL]);
  const backward = merge([JUL, JAN]);
  for (const quantity of RETAINED) {
    const a = forward.data.find((t) => t.quantity === quantity);
    const b = backward.data.find((t) => t.quantity === quantity);
    assert.deepEqual([...b.buses], [...a.buses]);
    for (let entity = 0; entity < a.buses.length; entity++) {
      const from = entity * HOURS_PER_YEAR;
      assert.deepEqual(
        [...b.cube.slice(from, from + HOURS_PER_YEAR)],
        [...a.cube.slice(from, from + HOURS_PER_YEAR)],
        `bus ${a.buses[entity]}'s ${quantity} changed with the drop order`,
      );
    }
  }
  ok("every entity's year of numbers is the same whichever half was dropped first");
}

// --------------------------------------- the same hour twice is still refused
//
// Across files within a group, too.
{
  const again = half(`${KEYS},LMP ($/MWh),Load (MW)`, [
    '01/01/2035,1,OffPeak,40001,OAKRIDGE,LoadArea1,99.5,999.25',
  ]);
  assert.throws(() => merge([JAN, again]), /area index 0 at hour 0/);
  ok('two members describing one entity-hour is refused, not last-write-wins');
}

// ------------------------------------------------------------ group refusals
{
  const plan = async (name, headerLine, row) =>
    readCasePlan(new File([[headerLine, row].join('\r\n') + '\r\n'], name), BUS_LONG);

  const jan = await plan('jan.csv', `${KEYS},Load (MW)`, '01/01/2035,1,OffPeak,40001,GC,A1,120.25');
  const jul = await plan('jul.csv', `${KEYS},Load (MW)`, '07/01/2035,1,OnPeak,40001,GC,A1,500.5');
  assert.deepEqual(checkMergeGroup([jan, jul]), { warnings: [] });
  assert.deepEqual(checkMergeGroup([jan]), { warnings: [] });
  ok('two halves of one year, spelled the same way, merge with nothing to say');

  const other = await plan(
    'next.csv',
    `${KEYS},Load (MW)`,
    '07/01/2036,1,OnPeak,40001,GC,A1,500.5',
  );
  assert.match(checkMergeGroup([jan, other]).refusal, /different years \(2035, 2036\)/);
  ok('two years assigned to one study are refused, not read into one calendar');

  // The real export already ships `Import Flow(MWh)` with the space missing,
  // so this is not hypothetical. Merging on a guess would either split one
  // year across two columns or stack two measurements on one.
  const spaced = await plan(
    'jul2.csv',
    `${KEYS},Load(MW)`,
    '07/01/2035,1,OnPeak,40001,GC,A1,500.5',
  );
  const refusal = checkMergeGroup([jan, spaced]).refusal;
  assert.match(refusal, /spell one column two ways/);
  assert.match(refusal, /"Load \(MW\)".*"Load\(MW\)"/);
  ok('one column spelled two ways is refused by name, never canonicalized on a guess');

  // A column only one half carries is loadable: a full year of load and half a
  // year of price beats refusing the pair over one missing column.
  const priced = await plan(
    'jul3.csv',
    `${KEYS},Load (MW),LMP ($/MWh)`,
    '07/01/2035,1,OnPeak,40001,GC,A1,500.5,77.5',
  );
  const partial = checkMergeGroup([jan, priced]);
  assert.equal(partial.refusal, undefined);
  assert.match(partial.warnings[0], /in only some of them \(LMP \(\$\/MWh\)\)/);
  ok('a column only one half carries is a warning naming it, not a refusal');

  // The unit is part of the column name in this shape, so MW and MWh cannot
  // silently merge -- they are two columns, each earning the coverage note.
  const wrongUnit = await plan(
    'jul4.csv',
    `${KEYS},Load (MWh)`,
    '07/01/2035,1,OnPeak,40001,GC,A1,500.5',
  );
  assert.equal(checkMergeGroup([jan, wrongUnit]).refusal, undefined);
  assert.deepEqual(unionMetricNames([jan, wrongUnit]), ['Load (MW)', 'Load (MWh)']);
  ok('a unit mismatch cannot merge into one column: the unit is IN the name');
}

console.log(`\n${checks} checks passed.`);
