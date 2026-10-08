// tests/test_interval.mjs
//
// The interval pane: one series cut into days, weeks or months and overlaid
// (src/series/interval.ts); its adapter (src/ui/panes/interval.ts), run
// against a fake DOM; and its couplings in src/ui/charts.ts and index.html,
// which cannot load under Node and are checked as source text.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import './test_loader.mjs';
import { installFakeDom, stubHost, frameOf } from './test_fixtures_dom.mjs';

installFakeDom();

const { axisHours, axisLabel, cutPeriods, periodSummary } =
  await import('../src/series/interval.ts');
const {
  coloursFor,
  namesPeriods,
  NAMED_PERIODS_MAX,
  createIntervalAdapter,
  intervalSettings,
  restoreIntervalSettings,
} = await import('../src/ui/panes/interval.ts');
const { weekdayOf } = await import('../src/model/date-range.ts');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8');

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`ok - ${label}`);
}

/** Every hour's value is its own index, so a cell names the hour it came from. */
// Finite even on a phantom Feb 29, so a period holding one would show.
const indexes = () => Float32Array.from({ length: 8784 }, (_, h) => h);
const in2035 = (day) => weekdayOf(2035, day); // Jan 1 2035 is a Monday
const in2036 = (day) => weekdayOf(2036, day); // Jan 1 2036 is a Tuesday, a leap year
const in2045 = (day) => weekdayOf(2045, day); // Jan 1 2045 is a Sunday

check('a day is 24 axis hours, and every real day of the year is a period', () => {
  const days = cutPeriods(indexes(), 'day', in2035);
  assert.equal(axisHours('day'), 24);
  assert.equal(days.length, 365, '2035 has no Feb 29');
  assert.equal(days[50].label, 'Tue Feb 20');
  assert.equal(days[50].values[0], 50 * 24, 'HE 1 of Feb 20 at axis hour 0');
  assert.equal(days[50].values[23], 50 * 24 + 23);
  assert.equal(days[59].label, 'Thu Mar 1', 'Mar 1 follows Feb 28');
  assert.equal(days[59].values[0], 60 * 24, 'Mar 1 is day 60 of the slot');
  const leap = cutPeriods(indexes(), 'day', in2036);
  assert.equal(leap.length, 366);
  assert.equal(leap[59].label, 'Fri Feb 29');
});

check('weeks run Monday to Sunday in the Case’s own year', () => {
  const weeks2035 = cutPeriods(indexes(), 'week', in2035);
  assert.equal(weeks2035[0].label, 'week of Jan 1');
  assert.equal(weeks2035[0].values[0], 0, 'Jan 1 2035, a Monday, opens the axis');
  // 2045 opens on a Sunday: the first week is one day long, at the axis end.
  const weeks2045 = cutPeriods(indexes(), 'week', in2045);
  assert.ok(Number.isNaN(weeks2045[0].values[0]), 'no Monday before Jan 1');
  assert.equal(weeks2045[0].values[6 * 24], 0, 'Jan 1 2045 sits on Sunday');
  assert.equal(weeks2045[1].label, 'week of Jan 2');
  assert.equal(weeks2045[1].values[0], 24, 'Jan 2 2045 is the next Monday');
});

check('a leap year’s week holds its Feb 29 on its own weekday', () => {
  // 2024: Feb 29 is a Thursday and Mar 1 a Friday. Mon Mar 4 (day 63)
  // opens the next week.
  const in2024 = (day) => weekdayOf(2024, day);
  const weeks = cutPeriods(indexes(), 'week', in2024);
  const march4 = weeks.find((week) => week.label === 'week of Mar 4');
  assert.ok(march4, weeks.map((week) => week.label).join(' | '));
  assert.equal(march4.values[0], 63 * 24, 'Mon Mar 4 on Monday');
  const leapWeek = weeks.find((week) => week.label === 'week of Feb 26');
  assert.equal(leapWeek.values[3 * 24], 59 * 24, 'Thu Feb 29 on Thursday');
  assert.equal(leapWeek.values[4 * 24], 60 * 24, 'Fri Mar 1 on Friday');
});

check('a non-leap year cuts no week at its phantom Feb 29', () => {
  // 2035: Feb 26 is a Monday; Wed Feb 28 is followed by Thu Mar 1, so one
  // week runs Feb 26 – Mar 4. Read as a Monday, the phantom day would cut
  // a spurious week there.
  const weeks = cutPeriods(indexes(), 'week', in2035);
  const labels = weeks.map((week) => week.label);
  assert.ok(!labels.includes('week of Feb 29') && !labels.includes('week of Mar 1'), labels.join());
  const feb26 = weeks.find((week) => week.label === 'week of Feb 26');
  assert.equal(feb26.values[2 * 24], 58 * 24, 'Wed Feb 28 on Wednesday');
  assert.equal(feb26.values[3 * 24], 60 * 24, 'Thu Mar 1 on Thursday');
  assert.equal(weeks[weeks.indexOf(feb26) + 1].label, 'week of Mar 5');
  // 365 days from a Monday: 52 whole weeks and Mon Dec 31, as a leap year
  // from a Tuesday makes a partial week and 52 more.
  assert.equal(weeks.length, 53);
  assert.ok(weeks.slice(1).every((week) => in2035(week.startDay) === 0));
  const leapWeeks = cutPeriods(indexes(), 'week', in2036);
  assert.equal(leapWeeks.length, 53);
  assert.ok(leapWeeks.slice(1).every((week) => in2036(week.startDay) === 0));
});

check('a month is 31 days of axis, and February holds day 29 only in a leap year', () => {
  const months = cutPeriods(indexes(), 'month', in2035);
  assert.equal(axisHours('month'), 744);
  assert.equal(months.length, 12);
  assert.equal(months[1].label, 'Feb');
  assert.equal(months[1].values[27 * 24 + 23], 59 * 24 - 1, 'Feb 28 HE 24');
  assert.ok(Number.isNaN(months[1].values[28 * 24]), 'no day 29 in 2035');
  assert.equal(months[2].values[0], 60 * 24, 'Mar 1 opens March at axis hour 0');
  const leap = cutPeriods(indexes(), 'month', in2036);
  assert.equal(leap[1].values[28 * 24], 59 * 24, 'Feb 29 2036 at day 29');
});

check('filters blank hours inside a period and never move it', () => {
  const values = indexes();
  // Keep only Feb 20 – Mar 10 (days 50-69, 2035 has no Feb 29).
  for (let h = 0; h < 8784; h++) if (h < 50 * 24 || h >= 70 * 24) values[h] = NaN;
  const days = cutPeriods(values, 'day', in2035);
  assert.equal(days.length, 19, 'a period with no kept hour is left out');
  const weeks = cutPeriods(values, 'week', in2035);
  assert.equal(weeks[0].label, 'week of Feb 19');
  assert.ok(Number.isNaN(weeks[0].values[0]), 'Mon Feb 19 is outside the dates');
  assert.equal(weeks[0].values[24], 50 * 24, 'Tue Feb 20 keeps its Tuesday');
  const months = cutPeriods(values, 'month', in2035);
  assert.deepEqual(
    months.map((m) => m.label),
    ['Feb', 'Mar'],
  );
  assert.equal(months[0].values[19 * 24], 50 * 24, 'Feb 20 stays at day 20');
});

check('the summary is the mean and nearest-rank p10 and p90 of the periods', () => {
  const periods = Array.from({ length: 11 }, (_, i) => ({
    label: String(i),
    startDay: i,
    values: Float32Array.from([i * 10, i === 0 ? NaN : 5]),
  }));
  const { mean, p10, p90 } = periodSummary(periods, 2);
  assert.equal(mean[0], 50);
  assert.equal(p10[0], 10);
  assert.equal(p90[0], 90);
  assert.equal(mean[1], 5, 'a missing value is left out, not counted as zero');
});

check('colour modes are offered only where they mean something', () => {
  assert.deepEqual(coloursFor('day'), ['time', 'weekday', 'month']);
  assert.deepEqual(coloursFor('week'), ['time', 'month']);
  assert.deepEqual(coloursFor('month'), ['time']);
  assert.equal(axisLabel('week', 2 * 24 + 17), 'Wed HE 18');
  assert.equal(axisLabel('month', 11 * 24), 'day 12 HE 1');
});

check('early → late names each period at ten or fewer, and ramps past that', () => {
  assert.equal(NAMED_PERIODS_MAX, 10);
  assert.ok(namesPeriods('time', 10));
  assert.ok(!namesPeriods('time', 11));
  assert.ok(!namesPeriods('weekday', 3), 'weekday colours stay weekday colours');
});

check('the pane is a SlotType offered in every pane, with its controls in every header', () => {
  const charts = read('src/ui/charts.ts');
  const html = read('index.html');
  assert.match(charts, /export type SlotType =[^;]*'interval'/);
  for (const n of [1, 2, 3, 4]) {
    const select = html.slice(html.indexOf(`data-el="slot-type-${n}"`));
    assert.ok(
      select.slice(0, select.indexOf('</select>')).includes('<option value="interval">'),
      `pane ${n} offers Interval`,
    );
    for (const hook of ['interval-by', 'interval-colour', 'interval-mean', 'interval-band']) {
      assert.ok(html.includes(`data-el="${hook}-${n}"`), `pane ${n} has ${hook}`);
    }
  }
  assert.match(charts, /interval: createIntervalAdapter,/, 'the host draws it with this adapter');
});

/** A colour select with the three options index.html gives it. */
function withColours(host) {
  host.controls.intervalColour.options = ['time', 'weekday', 'month'].map((value) => ({
    value,
    disabled: false,
  }));
  return host;
}

check('the adapter draws one series, and its Figure names the rest as left out', () => {
  const { host, record } = stubHost();
  const pane = createIntervalAdapter(withColours(host));
  assert.equal(pane.surface, 'canvas');
  assert.deepEqual(pane.controls(frameOf([])), ['interval']);
  const series = (name) => ({
    name,
    unit: 'MW',
    color: '#1f77b4',
    values: indexes(),
    warnings: [],
  });
  pane.draw(frameOf([series('SAMPLE A'), series('SAMPLE B')], { yearOf: () => 2023 }));
  assert.deepEqual(record.notes, ['SAMPLE A (1 of 2)'], 'the header names the series it cut');
  const shot = pane.figure.capture();
  assert.equal(shot.capture.pane, 'interval', 'an interval pane offers a Figure');
  assert.deepEqual(
    shot.capture.lines.map((line) => line.refusal),
    [undefined, 'An interval chart draws one series.'],
  );
  const { length, colour, mean, band, picked, weekdays } = shot.capture.interval;
  assert.deepEqual(
    { length, colour, mean, band, picked },
    {
      length: 'day',
      colour: 'time',
      mean: true,
      band: false,
      picked: null,
    },
  );
  assert.equal(weekdays.length, 366, 'one per day of the slot');
  assert.equal(weekdays[0], weekdayOf(2023, 0), "the weekdays are the series' own year's");
  assert.equal(weekdays[59], -1, '2023 has no Feb 29, so it has no weekday');
  pane.leave();
  assert.equal(pane.figure.capture(), null, 'a pane that left the type has nothing to capture');
});

check('a length offers only its colours, and a bundle restores only known settings', () => {
  const { host, record } = stubHost();
  // Its listeners on the header controls are what is under test.
  createIntervalAdapter(withColours(host));
  const { intervalBy, intervalColour } = host.controls;
  intervalColour.value = 'weekday';
  intervalBy.value = 'week';
  intervalBy.fire('change');
  assert.deepEqual(
    intervalColour.options.map((option) => option.disabled),
    [false, true, false],
    'a week holds every weekday, so it cannot be coloured by one',
  );
  assert.equal(intervalColour.value, 'time', 'a colour the length cannot take falls back');
  assert.equal(record.rerenders, 1, 'and the pane re-renders once, after the correction');

  restoreIntervalSettings(host.controls, {
    length: 'fortnight',
    colour: 'weekday',
    mean: 'yes',
    band: true,
  });
  assert.deepEqual(intervalSettings(host.controls), {
    length: 'day',
    colour: 'weekday',
    mean: true,
    band: true,
  });
  restoreIntervalSettings(host.controls, undefined);
  assert.deepEqual(intervalSettings(host.controls), {
    length: 'day',
    colour: 'time',
    mean: true,
    band: false,
  });
});

console.log(`\n${passed} checks passed`);
