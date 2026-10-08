// tests/test_limits_audit.mjs
//
// scripts/audit-limits.mjs prints counts and verdicts, and one property of it
// matters more than any count: IT NEVER PRINTS A NAME OR A VALUE. This suite
// builds SAMPLE_ files whose names and numbers are distinctive, runs the
// script as a child process exactly as a user would, and searches everything
// it wrote -- stdout and stderr, success and refusal -- for each of them.
//
// It also pins what the counts and verdicts say for files built to hit each
// branch: a name that differs only by case, one that matches nothing, a
// duplicate row, the sentinel, limits in the wrong unit, a floor and a
// negative ceiling, and flow files a drop would load differently from a naive
// read (a blank cell, a leap year, a repeated hour).
//
// Run: node tests/test_limits_audit.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts', 'audit-limits.mjs');
const dir = mkdtempSync(join(tmpdir(), 'gv-limits-audit-'));

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

const YEAR = 2035;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// Every flow value is one of these, per path, alternating by hour. Distinctive
// decimals, so a printed value cannot hide behind a coincidental count.
const FLOWS = {
  SAMPLE_QPATH_ALPHA: [-173.625, 3777.375],
  SAMPLE_QPATH_BRAVO: [-2963.125, 811.875],
  SAMPLE_QPATH_CHARLIE: [12.4375, 905.8125],
  SAMPLE_QPATH_DELTA: [-44.5625, 66.6875],
};

/** `blank(name, h)` leaves that cell empty; `leap` adds Feb 29; `repeatLast`
 * writes the last hour twice. */
function writeFlow(
  file,
  { year = YEAR, blank = () => false, leap = false, repeatLast = false } = {},
) {
  const names = Object.keys(FLOWS);
  const out = [
    `Interface Hourly 'Power Flow (MW)' Data for Year ${year}`,
    'SYNTHETIC DATA -- invented for tests/test_limits_audit.mjs',
    `(From the first hour of 1/1/${year} to the last hour of 12/31/${year}. Column identifier -- Interface Name)`,
    '',
    `Date, Hour, TOU,${names.join(',')}`,
  ];
  for (let m = 1; m <= 12; m++)
    for (let d = 1; d <= DAYS[m - 1] + (leap && m === 2 ? 1 : 0); d++)
      for (let h = 1; h <= 24; h++)
        out.push(
          `${m}/${d}/${year},${h},${h % 2 ? 'OffPeak' : 'OnPeak'},` +
            names.map((name) => (blank(name, h) ? '' : FLOWS[name][h % 2])).join(','),
        );
  if (repeatLast) out.push(out[out.length - 1]);
  writeFileSync(join(dir, file), out.join('\r\n') + '\r\n');
}

/** `rows` are [name, side, twelve values]. */
function writeLimits(file, rows) {
  const out = [
    'INTERFACELIMITSCHEDULE_MONTHLY,SYNTHETIC DATA,invented for a test',
    ',not a real export',
    '',
    `Interface Name,Year,Type,${MONTHS.join(',')}`,
    ...rows.map(([name, side, values]) => `${name},${YEAR},${side},${values.join(',')}`),
  ];
  writeFileSync(join(dir, file), out.join('\r\n') + '\r\n');
}

const twelve = (value) => Array(12).fill(value);
// ALPHA's MAX steps once, so one side varies within the year.
const alphaMax = [4137.5, ...Array(11).fill(3901.25)];
const LIMIT_ROWS = [
  ['SAMPLE_QPATH_ALPHA', 'MAX', alphaMax],
  ['SAMPLE_QPATH_ALPHA', 'MIN', twelve(-99999)],
  // A duplicate: dropped and counted, and its one cell just inside the
  // no-limit threshold must not reach the layout counts.
  ['SAMPLE_QPATH_ALPHA', 'MAX', [85123.5, ...Array(11).fill(2718.5)]],
  ['SAMPLE_QPATH_BRAVO', 'MIN', twelve(-3141.75)],
  ['sample_qpath_charlie', 'MAX', twelve(1618.25)], // differs from the flow only by case
  ['SAMPLE_QPATH_ECHO', 'MAX', twelve(1414.125)], // in no flow file at all
];

writeFlow('SAMPLE_flow.csv');
writeLimits('SAMPLE_limits.csv', LIMIT_ROWS);
// The same schedule in a unit a tenth the size of the flow's.
writeLimits(
  'SAMPLE_limits_tenths.csv',
  LIMIT_ROWS.map(([name, side, values]) => [
    name,
    side,
    values.map((v) => (Math.abs(v) >= 99999 ? v : v / 10)),
  ]),
);
// Three times the flows: no flow comes near its limit.
writeLimits(
  'SAMPLE_limits_light.csv',
  LIMIT_ROWS.map(([name, side, values]) => [
    name,
    side,
    values.map((v) => (Math.abs(v) >= 99999 ? v : v * 3)),
  ]),
);
writeFileSync(join(dir, 'SAMPLE_limits_headerless.csv'), 'SAMPLE_QPATH_ALPHA,MAX,4137.5\r\n');
// Limits on the far side of zero. CHARLIE flows 12.4375..905.8125 and BRAVO
// -2963.125..811.875: a floor CHARLIE clears, a floor it falls below, a zero
// floor, and a negative MAX BRAVO rises above.
writeLimits('SAMPLE_limits_floors.csv', [
  ['SAMPLE_QPATH_CHARLIE', 'MIN', twelve(7.25)],
  ['SAMPLE_QPATH_CHARLIE', 'MAX', twelve(-0)],
  ['SAMPLE_QPATH_BRAVO', 'MAX', twelve(-212.75)],
]);
writeLimits('SAMPLE_limits_floor_breached.csv', [['SAMPLE_QPATH_CHARLIE', 'MIN', twelve(333.5)]]);
writeLimits('SAMPLE_limits_zero_floor.csv', [['SAMPLE_QPATH_CHARLIE', 'MIN', twelve(0)]]);
// DELTA flows -44.5625 on even hours; its odd hours are blank, so every
// value it carries is below this negative ceiling. Read as 0, a blank would
// breach it.
writeLimits('SAMPLE_limits_delta_ceiling.csv', [['SAMPLE_QPATH_DELTA', 'MAX', twelve(-31.125)]]);
writeFlow('SAMPLE_flow_blanks.csv', {
  blank: (name, h) => name === 'SAMPLE_QPATH_DELTA' && h % 2 === 1,
});
writeFlow('SAMPLE_flow_leap.csv', { year: 2036, leap: true });
writeFlow('SAMPLE_flow_repeated.csv', { repeatLast: true });

function run(limits, flow = 'SAMPLE_flow.csv') {
  const result = spawnSync(process.execPath, [script, join(dir, limits), join(dir, flow)], {
    encoding: 'utf8',
  });
  const fields = Object.fromEntries(
    result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf(': ');
        return [line.slice(0, at), line.slice(at + 2)];
      }),
  );
  return { ...result, fields };
}

/** Every name and every number the inputs carry, as text the output must not contain. */
const INPUT_TEXT = [
  ...Object.keys(FLOWS),
  ...LIMIT_ROWS.map(([name]) => name),
  ...Object.values(FLOWS).flat().map(String),
  ...LIMIT_ROWS.flatMap(([, , values]) => values).map(String),
  ...LIMIT_ROWS.flatMap(([, , values]) => values).map((v) => String(v / 10)),
  ...LIMIT_ROWS.flatMap(([, , values]) => values).map((v) => String(v * 3)),
  '7.25',
  '212.75',
  '333.5',
  '31.125',
].filter((text) => text !== '-99999');

function assertNothingLeaked(result, label) {
  const text = `${result.stdout}\n${result.stderr}`;
  for (const token of INPUT_TEXT) {
    assert.ok(!text.includes(token), `${label}: output contains "${token}"`);
  }
  assert.ok(!/qpath/i.test(text), `${label}: output contains a path name fragment`);
}

try {
  // ------------------------------------------------ what it counts and says
  const good = run('SAMPLE_limits.csv');
  assert.equal(good.status, 0, good.stderr);
  const f = good.fields;
  assert.equal(f['names.limitInterfaces'], '4');
  assert.equal(f['names.flowInterfaces'], '4');
  assert.equal(f['names.matched'], '2');
  assert.equal(f['names.unmatched'], '2');
  assert.equal(f['names.unmatchedThatMatchIgnoringCase'], '1');
  assert.equal(f['names.flowInterfacesWithNoLimit'], '2');
  assert.equal(f['limits.duplicateRowsDropped'], '1');
  assert.equal(f['limits.sidesVaryingWithinYear'], '1');
  assert.equal(f['limits.noLimitCells'], '12');
  assert.equal(f['limits.noLimitNot99999'], '0');
  assert.equal(f['limits.justInsideThreshold'], '0', 'a dropped row is not counted');
  assert.equal(f['limits.markerColumnCount'], '1');
  assert.equal(f['limits.markerHeaderBlank'], 'false');
  assert.equal(f['flow.quantityIsMW'], 'true');
  assert.equal(f['flow.hours'], '8760');
  // ALPHA's MAX and BRAVO's MIN, twelve months each; ALPHA's MIN is all sentinel.
  assert.equal(f['magnitude.monthSides'], '24');
  assert.equal(f['magnitude.exceeded'], '0');
  assert.equal(f['verdicts.1 unit is MW'], 'yes');
  assert.equal(f['verdicts.2 names match exactly after trimming'], 'no');
  assert.equal(f['verdicts.3 one value per month, nothing finer'], 'no');
  assert.equal(f['verdicts.4 MIN/MAX found by value, unambiguously'], 'yes');
  assert.equal(f['verdicts.no-limit cells sit clear of the threshold'], 'yes');
  ok('counts and verdicts on a file built to hit each branch');

  const tenths = run('SAMPLE_limits_tenths.csv');
  assert.equal(tenths.status, 0, tenths.stderr);
  assert.equal(tenths.fields['magnitude.exceeded'], '24');
  assert.equal(tenths.fields['verdicts.1 unit is MW'], 'no');
  ok('limits a tenth the size of the flow are called out as the wrong unit');

  // Flows far inside their limits are a lightly loaded path, not a unit.
  const light = run('SAMPLE_limits_light.csv');
  assert.equal(light.status, 0, light.stderr);
  assert.equal(light.fields['magnitude.below50'], '24');
  assert.equal(light.fields['verdicts.1 unit is MW'], 'undetermined');
  ok('limits no flow approaches leave the unit undetermined rather than refuted');

  // A floor or negative ceiling is checked in its own direction, never by
  // distance from zero.
  const floors = run('SAMPLE_limits_floors.csv');
  assert.equal(floors.status, 0, floors.stderr);
  assert.equal(floors.fields['magnitude.monthSides'], '36');
  assert.equal(floors.fields['magnitude.exceeded'], '24', "CHARLIE's MAX -0 and BRAVO's MAX");
  assert.equal(floors.fields['magnitude.floorOrCeiling'], '12', "CHARLIE's floor, cleared");
  assert.equal(floors.fields['magnitude.below50'], '0');
  const breached = run('SAMPLE_limits_floor_breached.csv');
  assert.equal(breached.fields['magnitude.exceeded'], '12');
  const zero = run('SAMPLE_limits_zero_floor.csv');
  assert.equal(zero.fields['magnitude.exceeded'], '0');
  assert.equal(zero.fields['magnitude.floorOrCeiling'], '12');
  ok('a floor, a zero floor and a negative ceiling are compared in their own direction');

  // A blank cell is absent, as a drop reads it, not a flow of zero.
  const blanks = run('SAMPLE_limits_delta_ceiling.csv', 'SAMPLE_flow_blanks.csv');
  assert.equal(blanks.status, 0, blanks.stderr);
  assert.equal(blanks.fields['magnitude.exceeded'], '0');
  assert.equal(blanks.fields['magnitude.floorOrCeiling'], '12');
  ok('a blank flow cell is no data, not a zero that breaches a negative ceiling');

  const leap = run('SAMPLE_limits.csv', 'SAMPLE_flow_leap.csv');
  assert.equal(leap.status, 0, leap.stderr);
  assert.equal(leap.fields['flow.hours'], '8784');
  ok('a leap-year flow file audits the 8,784 hours a drop keeps, Feb 29 included');

  const repeated = run('SAMPLE_limits.csv', 'SAMPLE_flow_repeated.csv');
  assert.notEqual(repeated.status, 0, 'a repeated hour is refused, as a drop refuses it');
  assert.equal(repeated.stdout, '');
  assert.match(repeated.stderr, /reading the flow file/);
  ok('a flow file with a repeated hour is refused rather than audited');

  const refused = run('SAMPLE_limits_headerless.csv');
  assert.notEqual(refused.status, 0, 'a file with no header is refused');
  assert.equal(refused.stdout, '');
  ok('a file it cannot read is refused with a non-zero exit');

  // ---------------------------------------------------- what it never prints
  assertNothingLeaked(good, 'a matched audit');
  assertNothingLeaked(tenths, 'a wrong-unit audit');
  assertNothingLeaked(light, 'a lightly loaded audit');
  assertNothingLeaked(refused, 'a refusal');
  for (const [result, label] of [
    [floors, 'a floors audit'],
    [breached, 'a breached floor'],
    [zero, 'a zero floor'],
    [blanks, 'a blank-cell audit'],
    [leap, 'a leap-year audit'],
    [repeated, 'a flow refusal'],
  ])
    assertNothingLeaked(result, label);
  ok(`no name and no value from the inputs reaches the output (${INPUT_TEXT.length} searched)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${checks} checks passed.`);
