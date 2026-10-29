// tests/test_wide_merge.mjs
//
// Several WIDE-shape files read into ONE table.
//
// The wide-shape twin of tests/test_long_merge.mjs: a date-split study
// exported column-per-entity must also load as one year.
//
// What this file pins:
//   - two halves fill one cube, each member read at its OWN column order
//   - drop order does not change any entity's year of numbers
//   - members may split the ENTITIES over the same hours (one export per
//     region); one entity at one hour in two files keeps the FIRST file's
//     value, and an hour the first file's TOU, whichever worker finished first
//   - a row repeated inside one file is refused
//   - the group's span: abutting years merge, a year between them is refused
//   - the group refusal for two quantities on the title lines
//   - a column short of the table's hours warns and still loads
//   - the union header keeps `raw` aligned to `entityNames`, which is what a
//     bus export's id-to-name pairing rides on
//
// Inside one file a repeated hour is refused: that is a concatenated export.
// Across files the first file wins, by its place in the group, never by
// which block finished first.
//
// Run:  node test_wide_merge.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './test_loader.mjs';

const { parseHeaderLine, parseTitleLine, buildColumnPlan, wideSpec, KEY_COLS } =
  await import('../src/tables/wide/header.ts');
const { instantiateParser, parseBytes } = await import('../src/tables/wide/block.ts');
const { createAccumulator, blitBlock, finalizeWide, layoutFor, readCasePlan, unionHeader } =
  await import('../src/tables/wide/pool.ts');
const { checkMergeGroup } = await import('../src/tables/wide/merge.ts');
const { YEAR_SLOT_HOURS } = await import('../src/model/calendar.ts');

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

const SPEC = wideSpec('interface');
const parser = await instantiateParser(
  new WebAssembly.Module(readFileSync(new URL('../parser/wide/block.wasm', import.meta.url))),
);

/** The retained entity axis every group here shares -- the CUBE's axis, so a
 * member carrying its columns in another order still lands on it. */
const RETAINED = ['P01', 'P02'];

const TITLE = "Interface Hourly 'Power Flow (MW)' Data for Year 2035";

/** One half of a year: four preamble lines, a header, and its rows. */
function half(headerLine, rows, title = TITLE) {
  const text = [title, '', 'Date Range: whatever', '', headerLine, ...rows].join('\r\n') + '\r\n';
  return {
    header: parseHeaderLine(headerLine, SPEC.entityNoun),
    title: parseTitleLine(title),
    bytes: new TextEncoder().encode(text),
  };
}

/** Blit `members` into ONE accumulator and finalize -- which is what `ingest`
 * does for a merge group. `members` is the group order, which decides which
 * file is first; `blitOrder` is the order workers happen to finish in. */
function merge(members, blitOrder = members.map((_, i) => i)) {
  const plans = members.map((m) => buildColumnPlan(m.header, RETAINED));
  // The group's plan: one entity axis, presence unioned across its members.
  const presence = plans[0].presence.slice();
  for (const plan of plans.slice(1)) {
    for (let e = 0; e < presence.length; e++) presence[e] ||= plan.presence[e];
  }
  const accumulator = createAccumulator(
    { ...plans[0], presence },
    { firstYear: 2035, numYears: 1 },
    plans,
  );
  blitOrder.forEach((i) => {
    const member = members[i];
    // Line 5 is the header; the body starts after it.
    let at = 0;
    for (let line = 0; line < SPEC.preambleLines + 1; line++) at = member.bytes.indexOf(10, at) + 1;
    blitBlock(
      accumulator,
      parseBytes(
        parser,
        layoutFor(parser.budget, plans[i]),
        member.bytes,
        at,
        member.bytes.length,
        plans[i].activePlanes,
        2035,
        1,
      ),
      plans[i],
    );
  });
  return finalizeWide(accumulator, 'jan.csv + jul.csv', members[0].title, SPEC);
}

const KEYS = 'Date, Hour, TOU';
const JAN = half(`${KEYS},P01,P02`, [
  '1/1/2035,1,OffPeak,10.5,20.5',
  '1/1/2035,2,OnPeak,11.5,21.5',
]);
// The second half carries its two entity columns in the OTHER order. A merged
// cube read at the first member's plan would put P02's July on P01's plane,
// and every number would still look perfectly plausible.
const JUL = half(`${KEYS},P02,P01`, [
  '7/1/2035,1,OnPeak,600.5,500.5',
  '7/1/2035,2,OnPeak,601.5,501.5',
]);

/** Hour 0 of July 1st: slot day 182 in every year (the slot keeps Feb 29). */
const JUL1 = 182 * 24;

// ------------------------------------------------ two halves become one year
{
  const { data } = merge([JAN, JUL]);
  assert.deepEqual([...data.entities], RETAINED);
  assert.equal(data.cube[0], 10.5);
  assert.equal(data.cube[YEAR_SLOT_HOURS], 20.5);
  assert.equal(data.cube[JUL1], 500.5, "P01's July came from the reversed half's P01 column");
  assert.equal(data.cube[YEAR_SLOT_HOURS + JUL1], 600.5);
  assert.equal(data.cube[JUL1 + 1], 501.5);
  ok('two halves fill one cube, each member read at its OWN column order');
}

// ------------------------------------------------------ drop order is nothing
{
  const forward = merge([JAN, JUL]).data;
  const backward = merge([JUL, JAN]).data;
  assert.deepEqual([...backward.entities], [...forward.entities]);
  forward.entities.forEach((entity, index) => {
    const from = index * YEAR_SLOT_HOURS;
    assert.deepEqual(
      [...backward.cube.slice(from, from + YEAR_SLOT_HOURS)],
      [...forward.cube.slice(from, from + YEAR_SLOT_HOURS)],
      `${entity}'s year changed with the drop order`,
    );
  });
  ok("every entity's year of numbers is the same whichever half was dropped first");
}

// ----------------------------------- the same cell twice: the first file wins
{
  const again = half(`${KEYS},P01,P02`, ['1/1/2035,1,OnPeak,99.5,98.5']);
  for (const blitOrder of [
    [0, 1],
    [1, 0],
  ]) {
    const kept = merge([JAN, again], blitOrder);
    assert.deepEqual([kept.data.cube[0], kept.data.cube[YEAR_SLOT_HOURS]], [10.5, 20.5]);
    assert.equal(kept.data.tou[0], merge([JAN]).data.tou[0], "the first file's TOU");
    assert.ok(
      kept.warnings.some((w) =>
        /2 interface\(s\) are in more than one .*first file's values/.test(w),
      ),
      kept.warnings.join('\n'),
    );
  }
  assert.equal(merge([again, JAN]).data.cube[0], 99.5);
  ok("one entity-hour in two files keeps the first file's value and TOU, in any blit order");

  const twice = half(`${KEYS},P01,P02`, [
    '1/1/2035,1,OffPeak,10.5,20.5',
    '1/1/2035,1,OffPeak,10.5,20.5',
  ]);
  assert.throws(
    () => merge([twice]),
    /Two rows both describe hour 0 of 2035 \(Jan 1, hour ending 1\) in one file/,
  );
  // P03 is not retained, so no cell of this file is claimed: the per-file
  // hour check is what still sees the repeat.
  const unretained = half(`${KEYS},P03`, ['1/1/2035,1,OffPeak,1.5', '1/1/2035,1,OffPeak,1.5']);
  assert.throws(() => merge([JAN, unretained]), /Two rows both describe hour 0 of 2035/);
  ok('a row repeated inside one file is refused, even in a file with no retained column');
}

// ------------------------------------------ files split by entity, same hours
{
  const east = half(`${KEYS},P01`, ['1/1/2035,1,OffPeak,10.5', '1/1/2035,2,OnPeak,11.5']);
  const west = half(`${KEYS},P02`, ['1/1/2035,2,OnPeak,21.5', '1/1/2035,1,OffPeak,20.5']);
  const split = merge([east, west]);
  assert.deepEqual(
    [split.data.cube[0], split.data.cube[1], split.data.cube[YEAR_SLOT_HOURS]],
    [10.5, 11.5, 20.5],
  );
  assert.equal(split.data.cube[YEAR_SLOT_HOURS + 1], 21.5);
  assert.ok(!split.warnings.some((w) => /only some/.test(w)), split.warnings.join('\n'));
  ok('exports split by entity over the same hours are one table, with nothing to warn');

  const offPeak = half(`${KEYS},P02`, ['1/1/2035,2,OffPeak,21.5']);
  const onPeak = merge([east, west]).data.tou[1];
  assert.equal(merge([east, offPeak], [1, 0]).data.tou[1], onPeak);
  assert.notEqual(merge([offPeak, east]).data.tou[1], onPeak);
  ok("two files disagreeing on an hour's TOU keep the first file's, without a refusal");

  const shortWest = half(`${KEYS},P02`, ['1/1/2035,1,OffPeak,20.5']);
  const short = merge([east, shortWest]);
  assert.ok(
    short.warnings.some((w) => /1 interface\(s\) are in only some of these files \(P02\)/.test(w)),
    short.warnings.join('\n'),
  );
  ok('an entity short of hours another file covered is named');
}

// -------------------------------------------- a column only one half carries
{
  const wider = half(`${KEYS},P01,P02,P03`, ['7/1/2035,1,OnPeak,500.5,600.5,700.5']);
  const merged = merge([JAN, wider]);
  assert.equal(merged.data.presence[0], 1);
  // P03 is not on the retained axis here, so what the SHAPE reports is the
  // coverage of the axis it was given -- the union warning is the group
  // check's job, below.
  assert.ok(merged.warnings.some((w) => /covers 3 of 8,760 hours/.test(w)));
  ok('a merged table reports the coverage of the whole group, not of one member');
}

// ------------------------------------------------------------ group refusals
{
  const plan = (name, title, headerLine, row) =>
    readCasePlan(
      new File([[title, '', 'Date Range', '', headerLine, row].join('\r\n') + '\r\n'], name),
      SPEC,
    );

  const jan = await plan('jan.csv', TITLE, `${KEYS},P01,P02`, '1/1/2035,1,OffPeak,10.5,20.5');
  const jul = await plan('jul.csv', TITLE, `${KEYS},P01,P02`, '7/1/2035,1,OnPeak,500.5,600.5');
  const ONE_YEAR = { firstYear: 2035, numYears: 1 };
  assert.deepEqual(checkMergeGroup([jan, jul]), { span: ONE_YEAR, warnings: [] });
  assert.deepEqual(checkMergeGroup([jan]), { span: ONE_YEAR, warnings: [] });
  ok('two halves of one year, of one quantity, merge with nothing to say');

  const next = await plan(
    'next.csv',
    "Interface Hourly 'Power Flow (MW)' Data for Year 2036",
    `${KEYS},P01,P02`,
    '7/1/2036,1,OnPeak,500.5,600.5',
  );
  assert.deepEqual(checkMergeGroup([jan, next]), {
    span: { firstYear: 2035, numYears: 2 },
    warnings: [],
  });
  ok('two abutting years assigned to one study span both');

  const later = await plan(
    'later.csv',
    "Interface Hourly 'Power Flow (MW)' Data for Year 2037",
    `${KEYS},P01,P02`,
    '7/1/2037,1,OnPeak,500.5,600.5',
  );
  assert.match(
    checkMergeGroup([later, jan]).refusal,
    /together have rows for 2035 and 2037 but none for 2036\./,
  );
  ok('two years with a year between them are refused, naming the missing year');

  // The unit is inside the title's quantity in this shape, so a MW half and an
  // MWh half are two tables -- there is no column name to keep them apart.
  const mwh = await plan(
    'jul2.csv',
    "Interface Hourly 'Power Flow (MWh)' Data for Year 2035",
    `${KEYS},P01,P02`,
    '7/1/2035,1,OnPeak,500.5,600.5',
  );
  const unit = checkMergeGroup([jan, mwh]).refusal;
  assert.match(unit, /name different measurements/);
  assert.match(unit, /"Power Flow \(MW\)".*"Power Flow \(MWh\)"/);
  ok('a unit mismatch is refused by name: in this shape the unit is in the title');

  // The real export already ships `Import Flow(MWh)` with the space missing,
  // so a spelling difference across halves is not hypothetical.
  const spaced = await plan(
    'jul3.csv',
    "Interface Hourly 'Power Flow(MW)' Data for Year 2035",
    `${KEYS},P01,P02`,
    '7/1/2035,1,OnPeak,500.5,600.5',
  );
  assert.match(checkMergeGroup([jan, spaced]).refusal, /name different measurements/);
  ok('one quantity spelled two ways is refused, never canonicalized on a guess');

  const wider = await plan(
    'jul4.csv',
    TITLE,
    `${KEYS},P01,P02,P03`,
    '7/1/2035,1,OnPeak,500.5,600.5,700.5',
  );
  // Whether P03 is short of hours is known only after the rows are read.
  assert.deepEqual(checkMergeGroup([jan, wider]), { span: ONE_YEAR, warnings: [] });
  ok('a column only one member carries is not refused by the group check');

  // What a bus export rides on: `entityNames` holds the bus NUMBER and `raw`
  // the bus NAME, paired by index. A union that appended one at the wrong
  // offset would label one bus with another's name.
  const union = unionHeader([jan, wider]);
  assert.deepEqual(union.entityNames, ['P01', 'P02', 'P03']);
  union.entityNames.forEach((name, i) => assert.equal(union.raw[i + KEY_COLS].trim(), name));
  ok('the union header keeps raw aligned to entityNames, so a bus keeps its own name');
}

// -------------------------------------------- coverage is of real hours
{
  const FEB_29 = 59 * 24;
  const covers = (year, fill) => {
    const accumulator = createAccumulator(buildColumnPlan(JAN.header, RETAINED), {
      firstYear: year,
      numYears: 1,
    });
    fill(accumulator.hourSeen);
    const { warnings } = finalizeWide(accumulator, 'year.csv', JAN.title, SPEC);
    return warnings.filter((w) => w.includes('covers'));
  };
  const realOnly = (seen) => seen.fill(1).fill(0, FEB_29, FEB_29 + 24);
  assert.deepEqual(covers(2035, realOnly), [], "a non-leap year's Feb 29 is expected-absent");
  assert.deepEqual(covers(2036, realOnly), [
    'year.csv: covers 8,760 of 8,784 hours; the rest read as no-data.',
  ]);
  ok("coverage counts real hours: a non-leap Feb 29 is no gap, a leap year's missing one is");
}

console.log(`\n${checks} checks passed.`);
