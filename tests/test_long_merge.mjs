// tests/test_long_merge.mjs — date-split long files read into ONE table:
//   - both halves fill one cube;
//   - each member's own column ORDER is followed;
//   - drop order does not change any entity's numbers;
//   - files may split the METRICS over the same rows (abc in one export, xyz
//     in another); one cell in two members keeps the FIRST member's value,
//     and an hour the first member's TOU, whichever block finished first;
//   - a row repeated inside one file is refused;
//   - members' years union into one contiguous span: 2030-2031 and 2032 are
//     one three-year table, and a year no member covers is refused by name;
//   - one column spelled two ways is refused.
// Which file keeps a cell is `FirstFile` in src/ingest.ts, shared with the
// wide shape.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './test_loader.mjs';

const { entityHashes, parseHeaderLine, buildColumnPlan } =
  await import('../src/tables/long/header.ts');
const { BUS_LONG } = await import('../src/tables/bus/long.ts');
const { instantiateParser, parseBytes, scanAxis } = await import('../src/tables/long/block.ts');
const { createAccumulator, blitBlock, readCasePlan } = await import('../src/tables/long/pool.ts');
const { addYearRows, checkMergeGroup, unionHeader, unionMetricNames } =
  await import('../src/tables/long/merge.ts');
const { yearSpanOf, firstFileNotes } = await import('../src/ingest.ts');
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

/** Blit `members` into one accumulator over `span` and finalize, as `ingest`
 * does for a merge group. `members` is the group order, which decides which
 * file is first; `blitOrder` the order blocks happen to finish in. */
function merge(
  members,
  span = { firstYear: 2035, numYears: 1 },
  blitOrder = members.map((_, i) => i),
) {
  // The group's header, as ingest builds it.
  const union = unionHeader(members);
  const plans = members.map((member) => buildColumnPlan(member.header, RETAINED));
  const accumulator = createAccumulator(
    buildColumnPlan(union, RETAINED),
    busIds.length,
    span,
    plans,
  );
  for (const i of blitOrder) {
    const member = members[i];
    const plan = plans[i];
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

// ------------------------------------ the same cell twice: the first file wins
{
  const again = half(`${KEYS},LMP ($/MWh),Load (MW)`, [
    '01/01/2035,1,OnPeak,40001,OAKRIDGE,LoadArea1,99.5,999.25',
  ]);
  const quantityAt = (result, quantity) => result.data.find((t) => t.quantity === quantity).cube[0];
  for (const blitOrder of [
    [0, 1],
    [1, 0],
  ]) {
    const kept = merge([JAN, again], undefined, blitOrder);
    assert.equal(quantityAt(kept, 'LMP ($/MWh)'), 31.5);
    assert.equal(quantityAt(kept, 'Load (MW)'), 120.25);
    assert.equal(kept.accumulator.tou[0], merge([JAN]).accumulator.tou[0], "the first file's TOU");
    assert.match(
      firstFileNotes('jan + again', kept.accumulator.merge, RETAINED, 'column')[0],
      /2 column\(s\) are in more than one .*first file's values were kept/,
    );
  }
  assert.equal(quantityAt(merge([again, JAN]), 'LMP ($/MWh)'), 99.5);
  ok("one entity-hour in two members keeps the first file's values and TOU, in any blit order");

  const twice = half(`${KEYS},LMP ($/MWh),Load (MW)`, [
    '01/01/2035,1,OffPeak,40001,OAKRIDGE,LoadArea1,31.5,120.25',
    '01/01/2035,1,OffPeak,40001,OAKRIDGE,LoadArea1,31.5,120.25',
  ]);
  assert.throws(() => merge([twice]), /area index 0 at hour 0/);
  assert.throws(() => merge([JUL, twice]), /area index 0 at hour 0/);
  ok('a row repeated inside one file is refused, alone or in a group');

  const mixedTou = half(`${KEYS},LMP ($/MWh),Load (MW)`, [
    '01/01/2035,1,OffPeak,40001,OAKRIDGE,LoadArea1,31.5,120.25',
    '01/01/2035,1,OnPeak,40002,PINEHOLLOW,LoadArea2,32.5,220.25',
  ]);
  assert.throws(
    () => merge([mixedTou]),
    /OnPeak on one row and OffPeak on another of the same file/,
  );
  ok("one file disagreeing with itself on an hour's TOU is still refused");
  // A later file is held to its own TOU too, whichever file's blocks land
  // first: its TOU is ignored for the cube, never its contradiction.
  for (const blitOrder of [
    [0, 1],
    [1, 0],
  ]) {
    assert.throws(() => merge([JAN, mixedTou], undefined, blitOrder), /of the same file/);
  }
  ok('a later file disagreeing with itself is refused in any blit order');
}

// ------------------------------------- files split by metric over the same rows
{
  const prices = half(`${KEYS},LMP ($/MWh)`, [
    '01/01/2035,1,OffPeak,40001,OAKRIDGE,LoadArea1,31.5',
    '01/01/2035,1,OffPeak,40002,PINEHOLLOW,LoadArea2,32.5',
  ]);
  const loads = half(`${KEYS},Load (MW)`, [
    '01/01/2035,1,OnPeak,40002,PINEHOLLOW,LoadArea2,220.25',
    '01/01/2035,1,OnPeak,40001,OAKRIDGE,LoadArea1,120.25',
  ]);
  const split = merge([prices, loads], undefined, [1, 0]);
  const lmp = split.data.find((t) => t.quantity === 'LMP ($/MWh)');
  const load = split.data.find((t) => t.quantity === 'Load (MW)');
  assert.deepEqual([lmp.cube[0], lmp.cube[YEAR_SLOT_HOURS]], [31.5, 32.5]);
  assert.deepEqual([load.cube[0], load.cube[YEAR_SLOT_HOURS]], [120.25, 220.25]);
  assert.deepEqual(firstFileNotes('split', split.accumulator.merge, RETAINED, 'column'), []);
  ok('exports split by metric over the same rows are one table, with nothing to note');
  assert.equal(split.accumulator.tou[0], merge([prices]).accumulator.tou[0]);
  ok("files disagreeing on an hour's TOU keep the first file's, without a refusal");

  const shortLoads = half(`${KEYS},Load (MW)`, [
    '01/01/2035,1,OnPeak,40001,OAKRIDGE,LoadArea1,120.25',
  ]);
  const short = merge([prices, shortLoads]);
  assert.deepEqual(firstFileNotes('short', short.accumulator.merge, RETAINED, 'column'), [
    'short: 1 column(s) are in only some of these files (Load (MW)) and cover only the rows ' +
      'their own files did.',
  ]);
  ok('a metric short of rows another file had is named after the parse');
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
  // Whether it is short of rows is known only after the parse (above).
  assert.deepEqual(checkMergeGroup([jan, priced]), { span: ONE_YEAR, warnings: [] });
  ok('a column only one half carries is not refused by the group check');

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
