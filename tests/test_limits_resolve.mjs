// tests/test_limits_resolve.mjs
//
// The rule every drawn limit hangs off -- a Case's own limits win, then the
// shared ones, then nothing -- plus the two things that rule is easy to get
// wrong: what happens to a pinned table when its Case goes away, and how
// twelve monthly numbers become the 8,760 hours a pane draws.
//
// Also the unit gate, which is the difference between a dashed line and a
// wrong number on a shared axis.
//
// Run: node test_limits_resolve.mjs

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { createLimitsStore } = await import('../src/limits/store.ts');
const { limitLinesFor, rangeLimitsOf, summedLimitLines, LIMIT_UNIT } =
  await import('../src/limits/draw.ts');
const { serializeLimits, deserializeLimits } = await import('../src/limits/envelope.ts');
const { HOURS_PER_YEAR } = await import('../src/model/calendar.ts');
const { summedLimits } = await import('../src/tables/interface/limits.ts');
const { CaseStore, caseForName } = await import('../src/model/case-model.ts');

let passed = 0;
/** A FRESH store per check, so no check can leak a limits table into the
 *  next. */
let store;
function check(label, fn) {
  store = createLimitsStore();
  fn();
  passed++;
  console.log(`ok - ${label}`);
}

/** A table of one path, flat across the year, with whichever sides are given. */
function table(source, name, sides) {
  const byInterface = new Map();
  const entry = {};
  for (const [side, value] of Object.entries(sides)) {
    entry[side] = new Float32Array(12).fill(value);
  }
  byInterface.set(name, entry);
  return { source, byInterface };
}

// ------------------------------------------------------------ the fallback

check('a Case-scoped limits file matches its Case after the Case is renamed', () => {
  const cases = new CaseStore();
  const run = cases.createCase('SAMPLE_run_v3');
  cases.createCase('SAMPLE_other');
  // The drop resolves its Case the way main.ts does, by name or display
  // name, and the limits are then held by id.
  cases.setDisplayName(run.id, 'Summer');
  for (const typed of ['SAMPLE_run_v3', 'Summer']) {
    assert.equal(caseForName(cases.listCases(), typed), run, `${typed} names the Case`);
  }
  store.setCaseLimits(
    caseForName(cases.listCases(), 'Summer').id,
    table('own.csv', 'P', { max: 9 }),
  );
  cases.setDisplayName(run.id, 'Summer peak');
  assert.equal(store.limitFor(run.id, 'P').max[0], 9, 'a rename moves no limits');
  cases.setDisplayName(run.id, '');
  assert.equal(store.limitsForCase(run.id).source, 'own.csv', 'nor does clearing it');
});

check('with only shared limits, every Case reads them', () => {
  store.setSharedLimits(table('shared.csv', 'PATH_A', { max: 100 }));
  assert.equal(store.limitsForCase('case-1').source, 'shared.csv');
  assert.equal(store.limitsForCase('case-2').source, 'shared.csv');
});

check("a Case's own limits win over the shared ones, and only for that Case", () => {
  store.setSharedLimits(table('shared.csv', 'PATH_A', { max: 100 }));
  store.setCaseLimits('case-1', table('mine.csv', 'PATH_A', { max: 250 }));
  assert.equal(store.limitsForCase('case-1').source, 'mine.csv');
  assert.equal(store.limitsForCase('case-2').source, 'shared.csv', 'the fallback still applies');
  assert.equal(store.limitFor('case-1', 'PATH_A').max[0], 250);
  assert.equal(store.limitFor('case-2', 'PATH_A').max[0], 100);
});

check('with no limits at all, there is nothing to draw and nothing throws', () => {
  assert.equal(store.limitsForCase('case-1'), undefined);
  assert.equal(store.limitFor('case-1', 'PATH_A'), undefined);
  assert.equal(store.hasLimits(), false);
});

check('the join trims, so a padded name in the export still matches', () => {
  store.setSharedLimits(table('shared.csv', 'PATH_A', { max: 100 }));
  assert.ok(store.limitFor('case-1', '  PATH_A '));
});

// The two exports spell a path identically; that is the data owner's
// statement, and it is why the join is exact rather than forgiving. A name
// that differs in case or inner spacing is a DIFFERENT path, and a fuzzy join
// would draw one path's limit on another's line.
check('the join is exact after trimming: case and inner spacing are not forgiven', () => {
  store.setSharedLimits(table('shared.csv', 'PATH A', { max: 100 }));
  assert.ok(store.limitFor('case-1', 'PATH A'));
  assert.equal(store.limitFor('case-1', 'path a'), undefined);
  assert.equal(store.limitFor('case-1', 'PATH  A'), undefined);
});

check('a second shared file REPLACES and names what it replaced', () => {
  store.setSharedLimits(table('first.csv', 'PATH_A', { max: 100 }));
  const replaced = store.setSharedLimits(table('second.csv', 'PATH_A', { max: 200 }));
  assert.equal(replaced, 'first.csv', 'the replacement is announced, never silent');
  assert.equal(store.limitFor('case-1', 'PATH_A').max[0], 200);
});

// -------------------------------------------------------- the Case lifecycle

check('a per-case limit dies with its Case; the shared table does not', () => {
  store.setSharedLimits(table('shared.csv', 'PATH_A', { max: 100 }));
  store.setCaseLimits('case-1', table('mine.csv', 'PATH_A', { max: 250 }));
  store.dropCaseLimits('case-1');
  assert.equal(
    store.limitsForCase('case-1').source,
    'shared.csv',
    'the Case falls back to shared once its own are gone',
  );
  assert.equal(store.sharedLimits().source, 'shared.csv', 'removing a Case never touches shared');
});

// ------------------------------------------------------------ match report

check('the match report counts what a Case matched, per file', () => {
  store.setSharedLimits(table('shared.csv', 'PATH_A', { max: 100 }));
  const report = store.matchReport('case-1', ['PATH_A', 'PATH_B', 'PATH_C']);
  assert.deepEqual({ ...report }, { source: 'shared.csv', matched: 1, total: 3 });
  assert.equal(store.matchReport('case-1', []).matched, 0);
});

check('a Case with no limits at all reports nothing rather than zero of zero', () => {
  assert.equal(store.matchReport('case-1', ['PATH_A']), null);
});

// ------------------------------------------------------------- the drawing

const YEAR = 2035;
const drawn = (over) => ({
  caseId: 'case-1',
  interfaceName: 'PATH_A',
  label: 'Run A · PATH_A',
  color: '#1f77b4',
  unit: LIMIT_UNIT,
  year: YEAR,
  values: new Float32Array(HOURS_PER_YEAR),
  ...over,
});

check('twelve months become 8,760 hours as a STEP, with no interpolation', () => {
  const byMonth = new Float32Array(12);
  for (let m = 0; m < 12; m++) byMonth[m] = 100 + m;
  store.setSharedLimits({
    source: 'shared.csv',
    byInterface: new Map([['PATH_A', { max: byMonth }]]),
  });
  const [line] = limitLinesFor(store, drawn());
  assert.equal(line.values.length, HOURS_PER_YEAR);
  assert.equal(line.values[0], 100, 'hour 0 is January');
  assert.equal(line.values[31 * 24 - 1], 100, 'the last hour of January is still January');
  assert.equal(line.values[31 * 24], 101, 'the first hour of February steps, it does not ramp');
  assert.equal(line.values[HOURS_PER_YEAR - 1], 111, 'the last hour of the year is December');
});

check("the limit borrows the series' colour exactly, and names its side", () => {
  store.setSharedLimits(table('shared.csv', 'PATH_A', { max: 100, min: -50 }));
  const lines = limitLinesFor(store, drawn());
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map((line) => line.name),
    ['Run A · PATH_A (max)', 'Run A · PATH_A (min)'],
  );
  for (const line of lines) assert.equal(line.color, '#1f77b4');
});

check('a filtered hour on the series is a filtered hour on the limit', () => {
  store.setSharedLimits(table('shared.csv', 'PATH_A', { max: 100 }));
  const values = new Float32Array(HOURS_PER_YEAR);
  values[5] = NaN;
  const [line] = limitLinesFor(store, drawn({ values }));
  assert.ok(Number.isNaN(line.values[5]), 'the dashed line stops where the flow line does');
  assert.equal(line.values[6], 100);
});

check('a month with no limit draws nothing, in the middle of a year that does', () => {
  const byMonth = new Float32Array(12).fill(100);
  byMonth[1] = NaN;
  store.setSharedLimits({
    source: 'shared.csv',
    byInterface: new Map([['PATH_A', { max: byMonth }]]),
  });
  const [line] = limitLinesFor(store, drawn());
  assert.equal(line.values[0], 100);
  assert.ok(Number.isNaN(line.values[31 * 24]), 'February is unbounded');
  assert.equal(line.values[(31 + 28) * 24], 100, 'March is bounded again');
});

check('a side that is unbounded in EVERY month is not a line at all', () => {
  store.setSharedLimits({
    source: 'shared.csv',
    byInterface: new Map([['PATH_A', { max: new Float32Array(12).fill(NaN) }]]),
  });
  assert.deepEqual(limitLinesFor(store, drawn()), []);
});

check('the unit gate: a limit is never drawn against a series in another unit', () => {
  store.setSharedLimits(table('shared.csv', 'PATH_A', { max: 100 }));
  assert.deepEqual(
    limitLinesFor(store, drawn({ unit: '$' })),
    [],
    'a MW limit on a $ series is refused',
  );
  assert.equal(limitLinesFor(store, drawn({ unit: LIMIT_UNIT })).length, 1);
});

// The export's limits are MVA ratings compared directly with MW flow, by the
// data owner's decision. The gate is on the SERIES unit, so a limit must draw
// on a Power Flow (MW) line; "correcting" the gate to MVA would draw none.
check('an MVA rating draws on the MW flow series it is compared with', () => {
  store.setSharedLimits(table('shared.csv', 'PATH_A', { max: 100 }));
  assert.equal(limitLinesFor(store, drawn({ unit: 'MW' })).length, 1);
  assert.deepEqual(limitLinesFor(store, drawn({ unit: 'MVA' })), []);
  assert.equal(LIMIT_UNIT, 'MW');
});

check('an interface with no limit row draws nothing and says nothing', () => {
  store.setSharedLimits(table('shared.csv', 'PATH_A', { max: 100 }));
  assert.deepEqual(limitLinesFor(store, drawn({ interfaceName: 'PATH_Z' })), []);
});

check('a refused series (no values) has no limit to draw', () => {
  store.setSharedLimits(table('shared.csv', 'PATH_A', { max: 100 }));
  assert.deepEqual(limitLinesFor(store, drawn({ values: null })), []);
});

// -------------------------------------------------------------- the envelope

check('a table round-trips through the envelope, NaN and all', () => {
  const byMonth = new Float32Array(12).fill(100);
  byMonth[3] = NaN;
  const original = {
    source: 'shared.csv',
    byInterface: new Map([['PATH_A', { max: byMonth, min: new Float32Array(12).fill(-7) }]]),
  };
  // Through JSON, not just through the two functions: `JSON.stringify(NaN)` is
  // `null`, and that round trip is the whole reason this format is plain JSON.
  const back = deserializeLimits(JSON.parse(JSON.stringify(serializeLimits(original))));
  const limit = back.byInterface.get('PATH_A');
  assert.equal(back.source, 'shared.csv');
  assert.equal(limit.max[0], 100);
  assert.ok(Number.isNaN(limit.max[3]), 'no limit stays no limit; it does not come back as 0');
  assert.equal(limit.min[11], -7);
});

check('a side the file never carried stays absent, rather than coming back empty', () => {
  const original = table('shared.csv', 'PATH_A', { max: 100 });
  const back = deserializeLimits(JSON.parse(JSON.stringify(serializeLimits(original))));
  assert.equal(back.byInterface.get('PATH_A').min, undefined);
});

check('a malformed limits block is dropped whole, never half-read', () => {
  assert.equal(deserializeLimits(undefined), undefined);
  assert.equal(deserializeLimits({ rows: [] }), undefined);
  assert.equal(deserializeLimits({ source: 'x.csv', rows: [] }), undefined);
  assert.equal(deserializeLimits({ source: 'x.csv', rows: [['PATH_A', null, null]] }), undefined);
});

check('adopting a restored set replaces the session wholesale', () => {
  store.setSharedLimits(table('old.csv', 'PATH_A', { max: 1 }));
  store.setCaseLimits('case-9', table('old-case.csv', 'PATH_A', { max: 2 }));
  store.adoptLimits(table('new.csv', 'PATH_A', { max: 3 }), [
    ['case-1', table('new-case.csv', 'PATH_A', { max: 4 })],
  ]);
  assert.equal(store.sharedLimits().source, 'new.csv');
  assert.equal(store.limitsForCase('case-9').source, 'new.csv', 'the old pin is gone');
  assert.equal(store.limitsForCase('case-1').source, 'new-case.csv');
});

// ------------------------------------------------------------ % of range

check("a % of range line reads its Case's own limits over the shared ones", () => {
  store.setSharedLimits(table('shared.csv', 'PATH_A', { max: 100, min: -40 }));
  store.setCaseLimits('case-1', table('mine.csv', 'PATH_A', { max: 250 }));
  const own = rangeLimitsOf(store.limitFor('case-1', 'PATH_A'), 2035);
  assert.equal(own.upper[0], 250);
  assert.equal(own.lower, undefined, 'the Case table has no MIN, and does not borrow one');
  const shared = rangeLimitsOf(store.limitFor('case-2', 'PATH_A'), 2035);
  assert.equal(shared.upper[HOURS_PER_YEAR - 1], 100);
  assert.equal(shared.lower[0], -40);
  assert.deepEqual(rangeLimitsOf(store.limitFor('case-2', 'PATH_B'), 2035), {});
});

// A boundary reads each member through the same accessor a path does, so it
// inherits the rule: the Case's own table wins WHOLE, and a path that table
// lacks has no limit in that Case, even when the shared table rates it.
check("a boundary sums its members' limits from the table its Case reads", () => {
  const both = (source, a, b) => ({
    source,
    byInterface: new Map([
      ['PATH_A', { max: new Float32Array(12).fill(a[0]), min: new Float32Array(12).fill(a[1]) }],
      ['PATH_B', { max: new Float32Array(12).fill(b[0]), min: new Float32Array(12).fill(b[1]) }],
    ]),
  });
  store.setSharedLimits(both('shared.csv', [100, -40], [60, -30]));
  store.setCaseLimits('case-1', both('mine.csv', [250, -90], [70, -20]));
  store.setCaseLimits('case-3', table('partial.csv', 'PATH_A', { max: 250, min: -90 }));
  const members = (caseId) =>
    summedLimits([
      { sign: 1, limits: rangeLimitsOf(store.limitFor(caseId, 'PATH_A'), 2035) },
      { sign: -1, limits: rangeLimitsOf(store.limitFor(caseId, 'PATH_B'), 2035) },
    ]);
  const own = members('case-1');
  assert.equal(own.upper[0], 250 + 20, "PATH_A's MAX plus reversed PATH_B's −MIN");
  assert.equal(own.lower[0], -90 - 70);
  const shared = members('case-2');
  assert.equal(shared.upper[0], 100 + 30);
  assert.equal(shared.lower[0], -40 - 60);
  assert.deepEqual(members('case-3'), {}, 'PATH_B is unrated in the table case-3 reads');
});

check('a % of range line draws no limit line: the limit is ±100% by construction', () => {
  store.setSharedLimits(table('shared.csv', 'PATH_A', { max: 100 }));
  const subject = {
    caseId: 'case-1',
    interfaceName: 'PATH_A',
    label: 'PATH_A',
    color: '#000',
    year: 2035,
    values: new Float32Array(HOURS_PER_YEAR).fill(50),
  };
  assert.equal(limitLinesFor(store, { ...subject, unit: LIMIT_UNIT }).length, 1);
  assert.deepEqual(limitLinesFor(store, { ...subject, unit: '%' }), []);
});

// --------------------------------------------------- a boundary's lines

check("a boundary's limit lines are its members' limits summed and swapped", () => {
  // PATH_A forward, PATH_B reversed: max = 100 + 30, min = −40 − 60.
  const a = new Float32Array(12).fill(100);
  a[1] = 120; // February
  store.setSharedLimits({
    source: 'shared.csv',
    byInterface: new Map([
      ['PATH_A', { max: a, min: new Float32Array(12).fill(-40) }],
      ['PATH_B', { max: new Float32Array(12).fill(60), min: new Float32Array(12).fill(-30) }],
    ]),
  });
  const limits = summedLimits([
    { sign: 1, limits: rangeLimitsOf(store.limitFor('case-1', 'PATH_A'), 2035) },
    { sign: -1, limits: rangeLimitsOf(store.limitFor('case-1', 'PATH_B'), 2035) },
  ]);
  const values = new Float32Array(HOURS_PER_YEAR).fill(5);
  values[3] = NaN; // a filtered hour
  const lines = summedLimitLines(limits, {
    label: 'Run A · West',
    color: '#123456',
    unit: LIMIT_UNIT,
    values,
  });
  assert.deepEqual(
    lines.map((line) => line.name),
    ['Run A · West (summed max)', 'Run A · West (summed min)'],
  );
  const [max, min] = lines;
  assert.equal(max.color, '#123456');
  assert.equal(max.values[0], 130);
  assert.equal(max.values[31 * 24], 150, 'February steps with PATH_A');
  assert.equal(min.values[0], -100);
  assert.ok(Number.isNaN(max.values[3]), "the series' filtered hour draws no limit");
});

check('a boundary side no member rates draws no line, and nothing in another unit', () => {
  const limits = summedLimits([
    { sign: 1, limits: { upper: 100 } },
    { sign: 1, limits: { upper: 50, lower: -10 } },
  ]);
  const subject = {
    label: 'West',
    color: '#000',
    unit: LIMIT_UNIT,
    values: new Float32Array(HOURS_PER_YEAR).fill(1),
  };
  assert.deepEqual(
    summedLimitLines(limits, subject).map((line) => line.name),
    ['West (summed max)'],
    'PATH_A has no MIN, so the boundary has none',
  );
  assert.deepEqual(summedLimitLines(limits, { ...subject, unit: '%' }), []);
  assert.deepEqual(summedLimitLines(limits, { ...subject, unit: '$' }), []);
  assert.deepEqual(summedLimitLines(limits, { ...subject, values: null }), []);
  assert.deepEqual(summedLimitLines({}, subject), []);
});

console.log(`\n${passed} checks passed`);
