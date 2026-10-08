// tests/test_boxes.mjs — the box pane's partition of drawn lines.
//
// `computeBoxes` walks each line over its whole span with that span's
// calendar, so a calendar dimension pools every year a line holds, and the
// `year` dimension gives each year its own box from that year's slot only.
//
// Run:  node tests/test_boxes.mjs

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { YEAR_SLOT_HOURS: H } = await import('../src/model/calendar.ts');
const { computeBoxes } = await import('../src/app/boxes.ts');
const { BOX_DIMS } = await import('../src/tables/area/types.ts');

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`ok - ${label}`);
}

const SPANS = {
  SAMPLE_CASEM: { firstYear: 2035, numYears: 3 },
  SAMPLE_CASE1: { firstYear: 2036, numYears: 1 },
};
const spanOf = (caseId) => SPANS[caseId];

/** A line of `numYears` slots whose year `y` holds `base(y) + (h % 24)`;
 * a non-leap Feb 29 (hours 1416..1439) is NaN as loaded. */
function line(caseId, base, color = '#1f77b4') {
  const { firstYear, numYears } = SPANS[caseId];
  const values = new Float32Array(numYears * H);
  for (let y = 0; y < numYears; y++) {
    const leap = (firstYear + y) % 4 === 0;
    for (let h = 0; h < H; h++) {
      const phantom = !leap && h >= 1416 && h < 1440;
      values[y * H + h] = phantom ? Number.NaN : base(y) + (h % 24);
    }
  }
  return {
    name: `${caseId} line`,
    color,
    unit: 'MW',
    values,
    quantiles: { n: 0 },
    spec: { caseId },
  };
}

/** A scratch source that records each length asked of it. */
function scratchLog() {
  const asked = [];
  return {
    asked,
    scratchOf: (hours) => {
      asked.push(hours);
      return new Float32Array(hours);
    },
  };
}

const three = line('SAMPLE_CASEM', (y) => 1000 * y);

check('a three-year line by month pools all three years', () => {
  const { scratchOf } = scratchLog();
  const january = computeBoxes([three], 'month', spanOf, scratchOf)[0].boxes[0].quantiles;
  assert.equal(january.n, 3 * 31 * 24, 'every January of the span');
  assert.equal(january.min, 0);
  assert.equal(january.max, 2023);
  const yearOne = line('SAMPLE_CASE1', () => 0);
  const alone = computeBoxes([yearOne], 'month', spanOf, scratchOf)[0].boxes[0].quantiles;
  assert.notDeepEqual(alone, january, 'year one alone is another box');
  const february = computeBoxes([three], 'month', spanOf, scratchOf)[1].boxes[0].quantiles;
  assert.equal(february.n, (28 * 3 + 1) * 24, 'one leap Feb 29 of three, the phantoms skipped');
});

check('by year, each year of the span is its own box from its own slot', () => {
  const groups = computeBoxes([three], 'year', spanOf, scratchLog().scratchOf);
  assert.deepEqual(
    groups.map((group) => group.label),
    ['2035', '2036', '2037'],
  );
  groups.forEach((group, y) => {
    assert.equal(group.boxes.length, 1);
    const q = group.boxes[0].quantiles;
    assert.equal(q.min, 1000 * y);
    assert.equal(q.max, 1000 * y + 23);
    assert.equal(q.n, (2035 + y) % 4 === 0 ? 8784 : 8760, 'phantom hours skipped');
  });
});

check('a one-year line adds a box to its own year only', () => {
  const single = line('SAMPLE_CASE1', () => 500, '#ff7f0e');
  const groups = computeBoxes([three, single], 'year', spanOf, scratchLog().scratchOf);
  assert.deepEqual(
    groups.map((group) => [group.label, group.boxes.map((box) => box.name)]),
    [
      ['2035', ['SAMPLE_CASEM line']],
      ['2036', ['SAMPLE_CASEM line', 'SAMPLE_CASE1 line']],
      ['2037', ['SAMPLE_CASEM line']],
    ],
  );
  assert.equal(groups[1].boxes[1].quantiles.min, 500);
});

check('a line with no Case has no year box rather than one under a stand-in year', () => {
  const yearless = { ...line('SAMPLE_CASE1', () => 0), spec: undefined };
  const groups = computeBoxes([yearless], 'year', spanOf, scratchLog().scratchOf);
  assert.deepEqual(groups, []);
});

check('the scratch is asked once, for the longest drawn line', () => {
  const { asked, scratchOf } = scratchLog();
  computeBoxes([line('SAMPLE_CASE1', () => 0), three], 'season', spanOf, scratchOf);
  assert.deepEqual(asked, [3 * H]);
});

check("'year' is a box dimension a bundle may name", () => {
  assert.ok(BOX_DIMS.includes('year'));
  assert.ok(!BOX_DIMS.includes('week'), 'an unknown name is not one, so a pane starts by Case');
});

console.log(`\n${passed} checks passed`);
