// tests/test_time_ticks.mjs — the time-axis ticks (`timeTicks` in
// src/ui/chart-format.ts), shared by the uPlot panes and the print figure so a
// figure's month, `Jan 5` and `HE` ticks read as the pane's do.
//
// The expected splits and labels below are what the uPlot pane drew when the
// logic still took a uPlot instance; a change to them is a visible change to
// every time, stacked and figure axis. (The Area entity axis is
// tests/test_axis.mjs; this is the hour-of-year axis.)

import assert from 'node:assert/strict';
import './test_loader.mjs';

globalThis.devicePixelRatio = 1;
const { hourLabel, timeTicks, timeSplits, timeAxisValues } =
  await import('../src/ui/chart-format.ts');

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
  const splits = timeSplits(self, 0, w.min, w.max);
  assert.deepEqual(splits, ticks.splits, `${w.name}: the uPlot splits hook agrees`);
  assert.deepEqual(timeAxisValues(self, splits), ticks.labels, `${w.name}: the values hook agrees`);
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

// The pane measures in CSS pixels: a 2x screen reports a bbox twice as wide
// and must not get twice the ticks.
globalThis.devicePixelRatio = 2;
const retina = { bbox: { width: 600 }, scales: { x: { min: 3000, max: 3024 } } };
assert.deepEqual(timeSplits(retina, 0, 3000, 3024), timeTicks(3000, 3024, 300).splits);
ok('the uPlot hook divides its canvas width by devicePixelRatio');

// A caller in another unit passes its own label room: 200 points of plot with
// 32 points per label fits as many labels as 400 px with 64.
assert.deepEqual(timeTicks(3000, 3024, 200, 32), timeTicks(3000, 3024, 400));
ok('the label room scales with the unit the width is given in');

console.log(`\n${checks} checks passed`);
