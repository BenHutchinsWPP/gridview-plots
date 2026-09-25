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
//   - two members covering the same HOUR is refused, across files
//   - the group refusals: two years, and two quantities on the title lines
//   - a column only one half carries warns and still loads
//   - the union header keeps `raw` aligned to `entityNames`, which is what a
//     bus export's id-to-name pairing rides on
//
// The duplicate check in this shape is one bit per HOUR, not per (entity,
// hour): one wide row is one hour across every entity, so a per-cell check
// would be the same bit repeated across the row. Two halves of a year never
// collide on it, which is what makes them mergeable.
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
const { HOURS_PER_YEAR } = await import('../src/model/calendar.ts');

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

/** Blit `members` into ONE accumulator, in the order given, and finalize --
 * which is what `ingest` does for a merge group. */
function merge(members) {
  const plans = members.map((m) => buildColumnPlan(m.header, RETAINED));
  // The group's plan: one entity axis, presence unioned across its members.
  const presence = plans[0].presence.slice();
  for (const plan of plans.slice(1)) {
    for (let e = 0; e < presence.length; e++) presence[e] ||= plan.presence[e];
  }
  const accumulator = createAccumulator({ ...plans[0], presence });
  members.forEach((member, i) => {
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
      ),
      plans[i],
    );
  });
  return finalizeWide(accumulator, 'jan.csv + jul.csv', 2035, members[0].title, SPEC);
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

/** Hour 0 of July 1st in a non-leap year: 181 days in. */
const JUL1 = 181 * 24;

// ------------------------------------------------ two halves become one year
{
  const { data } = merge([JAN, JUL]);
  assert.deepEqual([...data.entities], RETAINED);
  assert.equal(data.cube[0], 10.5);
  assert.equal(data.cube[HOURS_PER_YEAR], 20.5);
  assert.equal(data.cube[JUL1], 500.5, "P01's July came from the reversed half's P01 column");
  assert.equal(data.cube[HOURS_PER_YEAR + JUL1], 600.5);
  assert.equal(data.cube[JUL1 + 1], 501.5);
  ok('two halves fill one cube, each member read at its OWN column order');
}

// ------------------------------------------------------ drop order is nothing
{
  const forward = merge([JAN, JUL]).data;
  const backward = merge([JUL, JAN]).data;
  assert.deepEqual([...backward.entities], [...forward.entities]);
  forward.entities.forEach((entity, index) => {
    const from = index * HOURS_PER_YEAR;
    assert.deepEqual(
      [...backward.cube.slice(from, from + HOURS_PER_YEAR)],
      [...forward.cube.slice(from, from + HOURS_PER_YEAR)],
      `${entity}'s year changed with the drop order`,
    );
  });
  ok("every entity's year of numbers is the same whichever half was dropped first");
}

// --------------------------------------- the same hour twice is still refused
{
  const again = half(`${KEYS},P01,P02`, ['1/1/2035,1,OffPeak,99.5,99.5']);
  assert.throws(() => merge([JAN, again]), /hour 0 of the year/);
  ok('two members covering one hour is refused across files, not last-write-wins');
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
  assert.deepEqual(checkMergeGroup([jan, jul]), { warnings: [] });
  assert.deepEqual(checkMergeGroup([jan]), { warnings: [] });
  ok('two halves of one year, of one quantity, merge with nothing to say');

  const next = await plan(
    'next.csv',
    "Interface Hourly 'Power Flow (MW)' Data for Year 2036",
    `${KEYS},P01,P02`,
    '7/1/2036,1,OnPeak,500.5,600.5',
  );
  assert.match(checkMergeGroup([jan, next]).refusal, /different years \(2035, 2036\)/);
  ok('two years assigned to one study are refused, not read into one calendar');

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
  const partial = checkMergeGroup([jan, wider]);
  assert.equal(partial.refusal, undefined);
  assert.match(partial.warnings[0], /in only some of them \(P03\)/);
  ok('a column only one half carries is a warning naming it, not a refusal');

  // What a bus export rides on: `entityNames` holds the bus NUMBER and `raw`
  // the bus NAME, paired by index. A union that appended one at the wrong
  // offset would label one bus with another's name.
  const union = unionHeader([jan, wider]);
  assert.deepEqual(union.entityNames, ['P01', 'P02', 'P03']);
  union.entityNames.forEach((name, i) => assert.equal(union.raw[i + KEY_COLS].trim(), name));
  ok('the union header keeps raw aligned to entityNames, so a bus keeps its own name');
}

console.log(`\n${checks} checks passed.`);
