// tests/test_long_merge.mjs — date-split long files read into ONE table:
//   - both halves fill one cube;
//   - each member's own column ORDER is followed;
//   - drop order does not change any entity's numbers;
//   - the same entity-hour in two members is refused;
//   - members' years union into one contiguous span: 2030-2031 and 2032 are
//     one three-year table, and a year no member covers is refused by name;
//   - one column spelled two ways is refused.
// Merges join the HOUR axis only, so the duplicate check stays one bit per
// (entity, span hour).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './test_loader.mjs';

const { entityHashes, parseHeaderLine, buildColumnPlan } =
  await import('../src/tables/long/header.ts');
const { BUS_LONG } = await import('../src/tables/bus/long.ts');
const { instantiateParser, parseBytes, scanAxis } = await import('../src/tables/long/block.ts');
const { createAccumulator, blitBlock, readCasePlan } = await import('../src/tables/long/pool.ts');
const { addYearRows, checkMergeGroup, unionMetricNames } =
  await import('../src/tables/long/merge.ts');
const { yearSpanOf } = await import('../src/ingest.ts');
const { finalizeBusLong } = await import('../src/tables/bus/long.ts');
const { YEAR_SLOT_HOURS } = await import('../src/model/calendar.ts');

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

/** Blit `members` into one accumulator over `span`, in the order given, and
 * finalize. */
function merge(members, span = { firstYear: 2035, numYears: 1 }) {
  const union = { ...members[0].header, metricNames: RETAINED };
  const accumulator = createAccumulator(buildColumnPlan(union, RETAINED), busIds.length, span);
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
        span.firstYear,
        span.numYears,
      ),
      plan,
    );
  }
  const casePlan = {
    file: { name: 'merged' },
    label: 'jan.csv + jul.csv',
    header: union,
    ...span,
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

/** Hour 0 of July 1st: slot day 182 in every year (the slot keeps Feb 29). */
const JUL1 = 182 * 24;

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
  assert.equal(lmp.cube[YEAR_SLOT_HOURS + JUL1 + 1], 88.5);
  assert.equal(load.cube[YEAR_SLOT_HOURS + JUL1 + 1], 600.5);
  ok('two halves fill one cube, each member read at its OWN column order');

  // The coverage record rides on the TABLE, not just the
  // accumulator: it is what a later drop into this slot is gated on, and it
  // has to survive finalize and the bundle to be worth anything.
  let covered = 0;
  for (let h = 0; h < YEAR_SLOT_HOURS; h++) covered += accumulator.hourSeen[h];
  assert.equal(covered, 4, "the merged table covers both halves' hours, not one half's");
  for (const table of tables) {
    assert.equal(table.hoursPresent.length, YEAR_SLOT_HOURS);
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
      const from = entity * YEAR_SLOT_HOURS;
      assert.deepEqual(
        [...b.cube.slice(from, from + YEAR_SLOT_HOURS)],
        [...a.cube.slice(from, from + YEAR_SLOT_HOURS)],
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
  /** A plan as `discoverEntities` leaves it: header read, rows per year
   * scanned, its own span set. */
  const plan = async (name, headerLine, ...rows) => {
    const text = [headerLine, ...rows].join('\r\n') + '\r\n';
    const read = await readCasePlan(new File([text], name), BUS_LONG);
    const bytes = new TextEncoder().encode(text);
    addYearRows(read.rowsByYear, scanAxis(parser, bytes, read.dataStart, bytes.length));
    return Object.assign(read, yearSpanOf(`${name} has`, read.rowsByYear).span);
  };

  const jan = await plan('jan.csv', `${KEYS},Load (MW)`, '01/01/2035,1,OffPeak,40001,GC,A1,120.25');
  const jul = await plan('jul.csv', `${KEYS},Load (MW)`, '07/01/2035,1,OnPeak,40001,GC,A1,500.5');
  const ONE_YEAR = { firstYear: 2035, numYears: 1 };
  assert.deepEqual(checkMergeGroup([jan, jul]), { span: ONE_YEAR, warnings: [] });
  assert.deepEqual(checkMergeGroup([jan]), { span: ONE_YEAR, warnings: [] });
  ok('two halves of one year, spelled the same way, merge with nothing to say');

  const next = await plan('next.csv', `${KEYS},Load (MW)`, '07/01/2036,1,OnPeak,40001,GC,A1,500.5');
  assert.deepEqual(checkMergeGroup([next, jan]), {
    span: { firstYear: 2035, numYears: 2 },
    warnings: [],
  });
  ok('two consecutive years assigned to one study span both, whichever is dropped first');

  const later = await plan('later.csv', `${KEYS},Load (MW)`, '07/01/2038,1,OnPeak,40001,GC,A1,1');
  const gap = checkMergeGroup([jan, next, later]);
  assert.equal(gap.span, undefined);
  assert.equal(
    gap.refusal,
    '"jan.csv", "next.csv", "later.csv" were assigned to one study and together have rows for ' +
      '2035-2036 and 2038 but none for 2037. A Case is a contiguous run of years, so the load ' +
      "is refused rather than reading 2037 as no data. Add the missing year's rows, or load " +
      'each run of years as its own Case. Give them different study names to load them ' +
      'separately.',
  );
  ok('a year inside the union that no member covers is refused, naming it');

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

// ------------------------------------------- 2030-2031 + 2032 is three years
{
  const early = half(`${KEYS},LMP ($/MWh),Load (MW)`, [
    '01/01/2031,1,OffPeak,40001,OAKRIDGE,LoadArea1,31.5,120.25',
    '01/01/2030,1,OffPeak,40001,OAKRIDGE,LoadArea1,30.5,110.25',
  ]);
  const late = half(`${KEYS},Load (MW),LMP ($/MWh)`, [
    '12/31/2032,24,OnPeak,40002,PINEHOLLOW,LoadArea2,600.5,88.5',
  ]);
  const span = { firstYear: 2030, numYears: 3 };
  const { data: tables, warnings } = merge([early, late], span);
  const lmp = tables.find((t) => t.quantity === 'LMP ($/MWh)');
  assert.deepEqual([lmp.firstYear, lmp.numYears], [2030, 3]);
  assert.equal(lmp.cube.length, busIds.length * 3 * YEAR_SLOT_HOURS);
  assert.deepEqual([lmp.cube[0], lmp.cube[YEAR_SLOT_HOURS]], [30.5, 31.5]);
  // Bus 40002's plane starts at 3 x 8784; Dec 31 HE 24 of 2032 is its last hour.
  assert.equal(lmp.cube[2 * 3 * YEAR_SLOT_HOURS - 1], 88.5);
  assert.equal(lmp.hoursPresent.length, 3 * YEAR_SLOT_HOURS);
  // 2030 and 2031 are non-leap and 2032 leap: 8,760 + 8,760 + 8,784 real hours.
  assert.ok(
    warnings.some((w) => w.includes('covers 3 of 26,304 hours')),
    `coverage is out of the span's real hours: ${warnings}`,
  );
  ok('a member covering 2030-2031 and one covering 2032 make one three-year table');
}

console.log(`\n${checks} checks passed.`);
