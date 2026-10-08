// tests/test_time_ticks.mjs — the time-axis ticks (`timeTicks` in
// src/ui/chart-format.ts), shared by the uPlot panes and the print figure so a
// figure's month, `Jan 5` and `HE` ticks read as the pane's do, and the
// multi-year axis (`axisHour`, `timeAxis`): slot positions from a first year.
//
// The expected splits and labels below are what the uPlot pane drew when the
// logic still took a uPlot instance; a change to them is a visible change to
// every time, stacked and figure axis. (The Area entity axis is
// tests/test_axis.mjs; this is the hour-of-year axis.)

import assert from 'node:assert/strict';
import './test_loader.mjs';

globalThis.devicePixelRatio = 1;
const { axisHour, hourLabel, TIME_LABEL_ROOM, timeAxis, timeTicks } =
  await import('../src/ui/chart-format.ts');
/** The hooks of an axis with no origin: the slot's own labels. */
const slotAxis = timeAxis();

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const WINDOWS = [
  {
    name: 'a full year',
    min: -0.5,
    max: 8783.5,
    width: 900,
    splits: [0, 744, 1440, 2184, 2904, 3648, 4368, 5112, 5856, 6576, 7320, 8040],
    labels: MONTHS,
  },
  {
    name: 'a month (February)',
    min: 743.5,
    max: 1415.5,
    width: 900,
    splits: [744, 792, 840, 888, 936, 984, 1032, 1080, 1128, 1176, 1224, 1272, 1320, 1368],
    labels: [
      'Feb 1',
      'Feb 3',
      'Feb 5',
      'Feb 7',
      'Feb 9',
      'Feb 11',
      'Feb 13',
      'Feb 15',
      'Feb 17',
      'Feb 19',
      'Feb 21',
      'Feb 23',
      'Feb 25',
      'Feb 27',
    ],
  },
  {
    name: 'a week',
    min: 2024,
    max: 2192,
    width: 900,
    splits: [2040, 2064, 2088, 2112, 2136, 2160, 2184],
    labels: ['Mar 26', 'Mar 27', 'Mar 28', 'Mar 29', 'Mar 30', 'Mar 31', 'Apr 1'],
  },
  {
    name: 'a day on a narrow plot',
    min: 3024,
    max: 3048,
    width: 300,
    splits: [3024, 3030, 3036, 3042, 3048],
    labels: ['May 6 HE 1', 'May 6 HE 7', 'May 6 HE 13', 'May 6 HE 19', 'May 7 HE 1'],
  },
  {
    name: 'a day on a wide plot',
    min: 3024,
    max: 3048,
    width: 900,
    splits: [3024, 3026, 3028, 3030, 3032, 3034, 3036, 3038, 3040, 3042, 3044, 3046, 3048],
    labels: [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23]
      .map((he) => `May 6 HE ${he}`)
      .concat('May 7 HE 1'),
  },
];

for (const w of WINDOWS) {
  const ticks = timeTicks(w.min, w.max, w.width);
  assert.deepEqual(ticks.splits, w.splits, `${w.name}: splits`);
  assert.deepEqual(ticks.labels, w.labels, `${w.name}: labels`);
  ok(`${w.name}: ${w.labels[0]} … ${w.labels[w.labels.length - 1]}`);

  // The uPlot hooks are the same function: a pane of this width, zoomed to
  // this window, ticks exactly as the pure call does.
  const self = { bbox: { width: w.width }, scales: { x: { min: w.min, max: w.max } } };
  const splits = slotAxis.splits(self, 0, w.min, w.max);
  assert.deepEqual(splits, ticks.splits, `${w.name}: the uPlot splits hook agrees`);
  assert.deepEqual(
    slotAxis.values(self, splits),
    ticks.labels,
    `${w.name}: the values hook agrees`,
  );
}
ok('the uPlot splits and values hooks give the pure function’s ticks for every window');

// The axis is the leap-calendar slot in every year: Feb 29 is hours 1416-1439
// whether or not the Case's year has one.
assert.equal(hourLabel(1415), 'Feb 28 · HE 24');
assert.equal(hourLabel(1416), 'Feb 29 · HE 1');
assert.equal(hourLabel(1440), 'Mar 1 · HE 1');
assert.equal(hourLabel(8783), 'Dec 31 · HE 24');
assert.deepEqual(timeTicks(1392, 1464, 900).labels, ['Feb 28', 'Feb 29', 'Mar 1', 'Mar 2']);
ok('an hour label and a day tick name Feb 29, and Mar 1 after it');

// A multi-year axis is slot positions from a first year: x = yearOffset ×
// 8,784 + slot hour, so Jan 1 of year k is x = k × 8,784 and a non-leap
// Feb 29 is a day of axis with no hour behind it.
const SLOT = 8784;
assert.equal(hourLabel(0, 2035), '2035 Jan 1 · HE 1');
assert.equal(hourLabel(2 * SLOT, 2035), '2037 Jan 1 · HE 1');
assert.equal(hourLabel(SLOT + 1416 + 2, 2035), '2036 Feb 29 · HE 3');
assert.equal(hourLabel(1416, 2035), '2035 Feb 29 · HE 1 · no such day');
assert.equal(hourLabel(SLOT - 1, 2035), '2035 Dec 31 · HE 24');
assert.deepEqual(axisHour(SLOT + 1416, 2035), {
  year: 2036,
  month: 1,
  day: 29,
  he: 1,
  phantom: false,
});
assert.equal(axisHour(1416, 2035).phantom, true);
assert.equal(axisHour(1415, 2035).phantom, false, 'Feb 28 is real');
assert.equal(axisHour(1440, 2035).phantom, false, 'Mar 1 is real');
assert.equal(axisHour(4 * SLOT + 1439, 2035).phantom, true, '2039 is not leap');
assert.equal(axisHour(65 * SLOT + 1416, 2035).phantom, true, '2100 is not leap');
ok('an axis hour reads its year off the origin, and a non-leap Feb 29 is no such day');

const threeYears = timeTicks(-0.5, 3 * SLOT - 0.5, 900, TIME_LABEL_ROOM, 2035);
assert.deepEqual(threeYears.splits, [0, SLOT, 2 * SLOT]);
assert.deepEqual(threeYears.labels, ['2035', '2036', '2037']);
const tenYears = timeTicks(-0.5, 10 * SLOT - 0.5, 900, TIME_LABEL_ROOM, 2035);
assert.deepEqual(
  tenYears.splits,
  Array.from({ length: 10 }, (_, k) => k * SLOT),
);
assert.equal(tenYears.labels[9], '2044');
const narrowDecade = timeTicks(-0.5, 10 * SLOT - 0.5, 200, TIME_LABEL_ROOM, 2035);
assert.deepEqual(narrowDecade.labels, ['2035', '2039', '2043']);
ok('past two years the ticks are years, on each slot start, thinned to the room');

const oneYear = timeTicks(-0.5, SLOT - 0.5, 900, TIME_LABEL_ROOM, 2035);
assert.deepEqual(oneYear.splits, WINDOWS[0].splits);
assert.deepEqual(oneYear.labels, ['Jan 2035', ...MONTHS.slice(1)]);
const twoYears = timeTicks(-0.5, 2 * SLOT - 0.5, 900, TIME_LABEL_ROOM, 2035);
assert.deepEqual(twoYears.labels, [
  'Jan 2035',
  'Mar',
  'May',
  'Jul',
  'Sep',
  'Nov',
  'Jan 2036',
  'Mar',
  'May',
  'Jul',
  'Sep',
  'Nov',
]);
assert.equal(twoYears.splits[6], SLOT);
const autumnToSpring = timeTicks(SLOT - 92 * 24, SLOT + 90 * 24, 900, TIME_LABEL_ROOM, 2035);
assert.deepEqual(autumnToSpring.labels, ['Oct 2035', 'Nov', 'Dec', 'Jan 2036', 'Feb', 'Mar']);
ok('a year or two ticks months, the year on the first tick and each Jan');

const newYearWeek = timeTicks(SLOT - 72, SLOT + 72, 900, TIME_LABEL_ROOM, 2035);
assert.deepEqual(newYearWeek.labels, [
  '2035 Dec 29',
  'Dec 30',
  'Dec 31',
  '2036 Jan 1',
  'Jan 2',
  'Jan 3',
  'Jan 4',
]);
const newYearHours = timeTicks(SLOT - 6, SLOT + 6, 900, TIME_LABEL_ROOM, 2035);
assert.equal(newYearHours.labels[0], '2035 Dec 31 HE 19');
assert.equal(newYearHours.labels[newYearHours.splits.indexOf(SLOT)], '2036 Jan 1 HE 1');
ok('day and hour ticks name the year on the first tick and where it changes');

// No tick lands mid-day on any window wider than two days, in any year: a
// tick is a day's HE 1, so the day it labels is the day that starts there.
for (const [min, max] of [
  [-0.5, 3 * SLOT - 0.5],
  [-0.5, 2 * SLOT - 0.5],
  [SLOT - 92 * 24, SLOT + 90 * 24],
  [SLOT - 72, SLOT + 72],
  [5 * SLOT + 100, 9 * SLOT + 7],
]) {
  for (const width of [200, 900, 2000]) {
    for (const x of timeTicks(min, max, width, TIME_LABEL_ROOM, 2035).splits) {
      assert.equal(x % 24, 0, `a tick at ${x} is mid-day (window ${min}..${max}, ${width} px)`);
    }
  }
}
ok('no tick lands mid-day');

// The uPlot hooks for an origin agree with the pure call.
const decade = timeAxis(2035);
const decadePlot = { bbox: { width: 900 }, scales: { x: { min: -0.5, max: 10 * SLOT - 0.5 } } };
const decadeSplits = decade.splits(decadePlot, 0, -0.5, 10 * SLOT - 0.5);
assert.deepEqual(decadeSplits, tenYears.splits);
assert.deepEqual(decade.values(decadePlot, decadeSplits), tenYears.labels);
ok('timeAxis(firstYear) hooks tick as timeTicks does for that origin');

// The pane measures in CSS pixels: a 2x screen reports a bbox twice as wide
// and must not get twice the ticks.
globalThis.devicePixelRatio = 2;
const retina = { bbox: { width: 600 }, scales: { x: { min: 3000, max: 3024 } } };
assert.deepEqual(slotAxis.splits(retina, 0, 3000, 3024), timeTicks(3000, 3024, 300).splits);
ok('the uPlot hook divides its canvas width by devicePixelRatio');

// A caller in another unit passes its own label room: 200 points of plot with
// 32 points per label fits as many labels as 400 px with 64.
assert.deepEqual(timeTicks(3000, 3024, 200, 32), timeTicks(3000, 3024, 400));
ok('the label room scales with the unit the width is given in');

console.log(`\n${checks} checks passed`);
