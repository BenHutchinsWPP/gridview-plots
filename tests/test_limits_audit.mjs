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
// duplicate row, the sentinel, and limits in the wrong unit.
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

function writeFlow(file) {
  const names = Object.keys(FLOWS);
  const out = [
    `Interface Hourly 'Power Flow (MW)' Data for Year ${YEAR}`,
    'SYNTHETIC DATA -- invented for tests/test_limits_audit.mjs',
    `(From the first hour of 1/1/${YEAR} to the last hour of 12/31/${YEAR}. Column identifier -- Interface Name)`,
    '',
    `Date, Hour, TOU,${names.join(',')}`,
  ];
  for (let m = 1; m <= 12; m++)
    for (let d = 1; d <= DAYS[m - 1]; d++)
      for (let h = 1; h <= 24; h++)
        out.push(
          `${m}/${d}/${YEAR},${h},${h % 2 ? 'OffPeak' : 'OnPeak'},` +
            names.map((name) => FLOWS[name][h % 2]).join(','),
        );
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
  ['SAMPLE_QPATH_ALPHA', 'MAX', twelve(2718.5)], // a duplicate: dropped, counted
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

  const refused = run('SAMPLE_limits_headerless.csv');
  assert.notEqual(refused.status, 0, 'a file with no header is refused');
  assert.equal(refused.stdout, '');
  ok('a file it cannot read is refused with a non-zero exit');

  // ---------------------------------------------------- what it never prints
  assertNothingLeaked(good, 'a matched audit');
  assertNothingLeaked(tenths, 'a wrong-unit audit');
  assertNothingLeaked(light, 'a lightly loaded audit');
  assertNothingLeaked(refused, 'a refusal');
  ok(`no name and no value from the inputs reaches the output (${INPUT_TEXT.length} searched)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${checks} checks passed.`);
