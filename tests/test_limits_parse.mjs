// tests/test_limits_parse.mjs
//
// The five rules `src/limits/parse.ts` states, asserted against a synthetic
// file. None of them is derivable from the bytes -- they are domain judgements
// by the owner of the data -- so each one is asserted as text here, and a
// change to any of them has to arrive with a change to this file.
//
// Run: node test_limits_parse.mjs

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { parseLimitsCsv, NO_LIMIT_BEYOND, LIMITS_BANNER } = await import('../src/limits/parse.ts');

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`ok - ${label}`);
}

/** Twelve values, January first. */
const months = (...values) => values.join(',');
const ramp = (base) => months(...Array.from({ length: 12 }, (_, m) => base + m));

const PREAMBLE = [
  `${LIMITS_BANNER},something,something else`,
  ',a note line',
  ',word,another note',
].join('\n');

const HEADER = 'Interface Name,Year,Type,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec';

const file = (...rows) => [PREAMBLE, HEADER, ...rows].join('\n') + '\n';

check('the header is found under the preamble, and both sides of a path read', () => {
  const { table } = parseLimitsCsv(
    file(`PATH_A,2035,MAX,${ramp(1000)}`, `PATH_A,2035,MIN,${ramp(-900)}`),
    'limits.csv',
  );
  const limit = table.byInterface.get('PATH_A');
  assert.ok(limit, 'PATH_A is in the table');
  assert.equal(limit.max[0], 1000);
  assert.equal(limit.max[11], 1011);
  assert.equal(limit.min[0], -900);
  assert.equal(table.source, 'limits.csv');
});

check('rule 1: the year is discarded — two years of one path are one key, first wins', () => {
  const { table } = parseLimitsCsv(
    file(`PATH_A,2035,MAX,${ramp(1000)}`, `PATH_A,2040,MAX,${ramp(5000)}`),
    'limits.csv',
  );
  assert.equal(table.byInterface.size, 1);
  assert.equal(table.byInterface.get('PATH_A').max[0], 1000, 'the FIRST row wins, not the last');
});

check('rule 2: a duplicate (path, side) is dropped and COUNTED, never merged', () => {
  const { table, warnings } = parseLimitsCsv(
    file(`PATH_A,2035,MAX,${ramp(1000)}`, `PATH_A,2035,MAX,${ramp(2000)}`),
    'limits.csv',
  );
  assert.equal(table.byInterface.get('PATH_A').max[0], 1000);
  assert.ok(
    warnings.some((line) => line.includes('duplicate') && line.includes('1')),
    `a dropped duplicate must produce a counted warning, got: ${warnings.join(' | ')}`,
  );
});

check('rule 3: the side is found by VALUE, at whatever column it sits in', () => {
  // The marker moved to the LAST column and the header renamed. Nothing here
  // may depend on either.
  const moved = [
    PREAMBLE,
    'Interface Name,Year,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec,Direction',
    `PATH_A,2035,${ramp(100)},MAX`,
  ].join('\n');
  const { table } = parseLimitsCsv(moved, 'limits.csv');
  assert.equal(table.byInterface.get('PATH_A').max[0], 100);
  assert.equal(table.byInterface.get('PATH_A').min, undefined);
});

check('rule 3: MIN and MAX rows read the same in either order', () => {
  const first = parseLimitsCsv(
    file(`PATH_A,2035,MAX,${ramp(1000)}`, `PATH_A,2035,MIN,${ramp(-900)}`),
    'a.csv',
  ).table.byInterface.get('PATH_A');
  const second = parseLimitsCsv(
    file(`PATH_A,2035,MIN,${ramp(-900)}`, `PATH_A,2035,MAX,${ramp(1000)}`),
    'b.csv',
  ).table.byInterface.get('PATH_A');
  assert.deepEqual([...first.max], [...second.max]);
  assert.deepEqual([...first.min], [...second.min]);
});

check('rule 4: a path may carry only a MIN, or only a MAX', () => {
  const { table } = parseLimitsCsv(
    file(`PATH_A,2035,MAX,${ramp(1000)}`, `PATH_B,2035,MIN,${ramp(-50)}`),
    'limits.csv',
  );
  assert.equal(table.byInterface.get('PATH_A').min, undefined);
  assert.equal(table.byInterface.get('PATH_B').max, undefined);
  assert.equal(table.byInterface.get('PATH_B').min[0], -50);
});

check('rule 5: the sentinel is per CELL and tested on MAGNITUDE, not on sign', () => {
  const mixed = months(100, 99999, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100);
  const negative = months(-100, -100, -99999, -100, -100, -100, -100, -100, -100, -100, -100, -100);
  const { table } = parseLimitsCsv(
    file(`PATH_A,2035,MAX,${mixed}`, `PATH_A,2035,MIN,${negative}`),
    'limits.csv',
  );
  const limit = table.byInterface.get('PATH_A');
  assert.equal(limit.max[0], 100, 'January is bounded');
  assert.ok(Number.isNaN(limit.max[1]), 'February is unbounded — same path, same row');
  assert.ok(Number.isNaN(limit.min[2]), 'a negative sentinel is a sentinel too');
  assert.equal(limit.min[0], -100);
});

check('rule 5: no-limit is any cell beyond ±90,000, not only the ±99999 spelling', () => {
  const cells = [99999, -99999, 95000, -90000.5, 90000, -90000, 89999, 1500, 100000, -1e5, 0, 5];
  const { table } = parseLimitsCsv(file(`PATH_A,2035,MAX,${cells.join(',')}`), 'limits.csv');
  const max = Array.from(table.byInterface.get('PATH_A').max);
  const unbounded = max.map((value) => Number.isNaN(value));
  assert.deepEqual(
    unbounded,
    [true, true, true, true, false, false, false, false, true, true, false, false],
    'beyond 90,000 either way is no limit; exactly 90,000 and anything inside is a limit',
  );
  assert.equal(max[4], 90000);
  assert.equal(NO_LIMIT_BEYOND, 90000);
});

check('a blank cell is no limit, not zero', () => {
  const { table } = parseLimitsCsv(
    // January blank, the other eleven months numbered.
    file(`PATH_A,2035,MAX,,${months(2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12)}`),
    'limits.csv',
  );
  assert.ok(Number.isNaN(table.byInterface.get('PATH_A').max[0]));
});

check('a row with no MIN/MAX marker is skipped and counted, never guessed at', () => {
  const { table, warnings } = parseLimitsCsv(
    file(`PATH_A,2035,MAX,${ramp(10)}`, `PATH_B,2035,LIMIT,${ramp(10)}`),
    'limits.csv',
  );
  assert.equal(table.byInterface.has('PATH_B'), false);
  assert.ok(warnings.some((line) => line.includes('no MIN or MAX')));
});

check('a file with no month header is REFUSED by name, never half-read', () => {
  assert.throws(
    () =>
      parseLimitsCsv(`${PREAMBLE}\nInterface Name,Year,Type,Q1,Q2\nPATH_A,2035,MAX,1,2\n`, 'x.csv'),
    /twelve month columns/,
  );
});

check('a header with no usable row after it is REFUSED, not returned empty', () => {
  assert.throws(() => parseLimitsCsv(`${PREAMBLE}\n${HEADER}\n`, 'x.csv'), /defines no limits/);
});

check('names are trimmed and quoted names survive the comma inside them', () => {
  const { table } = parseLimitsCsv(file(`"  PATH A, EAST  ",2035,MAX,${ramp(1)}`), 'limits.csv');
  assert.ok(table.byInterface.has('PATH A, EAST'));
});

console.log(`\n${passed} checks passed`);
