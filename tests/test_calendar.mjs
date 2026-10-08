// tests/test_calendar.mjs
//
// Exercises the real src/*.ts modules directly -- not a reimplementation --
// via Node's built-in TypeScript stripping (Node >=22.6, no flag needed on
// Node 24). test_loader.mjs supplies the two things Node does not: the
// extensionless-import hook, and the area axis and grouping mapping that
// groupings.ts does not ship with the build.
//

import assert from 'node:assert/strict';

import rulesData from '../data/area/aggregation-rules.json' with { type: 'json' };

import './test_loader.mjs';

const {
  buildCalendar,
  buildMask,
  getMonth,
  getDayOfMonth,
  getDayOfWeek,
  YEAR_SLOT_HOURS,
  YEAR_SLOT_DAYS,
  SLOT_MONTH_LENGTHS,
  SLOT_MONTH_STARTS,
  PHANTOM_DAY_SHIFT,
  isLeapYear,
  isPhantomDay,
  realHours,
} = await import('../src/model/calendar.ts');
const { areasIn } = await import('../src/tables/area/groupings.ts');
const {
  ruleFor,
  groupOf,
  metricGroups,
  requiredInputs,
  defaultSelection,
  scaleOf,
  scalesOf,
  DEFAULT_METRICS,
  CALCULATED_GROUP,
} = await import('../src/tables/area/rules.ts');

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`ok - ${label}`);
}

// --- 1. 8,784 entries, leap-slot month histogram ----------------------

check('calendar has exactly 8,784 entries in a leap and a non-leap year', () => {
  assert.equal(buildCalendar(2035).length, YEAR_SLOT_HOURS);
  assert.equal(buildCalendar(2035).length, 8784);
  assert.equal(buildCalendar(2036).length, 8784);
});

check('month histogram matches the slot month lengths x 24 in every year', () => {
  for (const year of [2035, 2036]) {
    const calendar = buildCalendar(year);
    const histogram = new Array(13).fill(0); // 1-indexed, [0] unused
    for (let h = 0; h < calendar.length; h++) {
      histogram[getMonth(calendar[h])]++;
    }
    const expected = [744, 696, 744, 720, 744, 720, 744, 744, 720, 744, 720, 744];
    assert.deepEqual(histogram.slice(1), expected, String(year));
  }
});

// --- 2. Day-of-week for known dates ------------------------------------
//
// Anchors independently verified against Python's datetime module -- a
// different implementation from anything in this repo, so as not to trust a
// single oracle:
//   >>> datetime.date(2035, 1, 1).strftime('%A')  -> 'Monday'
//   >>> datetime.date(2034, 7, 4).strftime('%A')  -> 'Tuesday'
// calendar.ts's dayOfWeek() uses 0=Monday .. 6=Sunday.

function dayOfWeekOf(calendar, month, day) {
  for (let h = 0; h < calendar.length; h++) {
    const entry = calendar[h];
    if (getMonth(entry) === month && getDayOfMonth(entry) === day) return getDayOfWeek(entry);
  }
  throw new Error(`month ${month} day ${day} not found`);
}

check('2035-01-01 is a Monday', () => {
  assert.equal(dayOfWeekOf(buildCalendar(2035), 1, 1), 0);
});

check('2034-07-04 is a Tuesday', () => {
  assert.equal(dayOfWeekOf(buildCalendar(2034), 7, 4), 1);
});

//   >>> datetime.date(2036, 2, 29).strftime('%A')  -> 'Friday'
//   >>> datetime.date(2036, 3, 1).strftime('%A')   -> 'Saturday'
//   >>> datetime.date(2035, 3, 1).strftime('%A')   -> 'Thursday'
check('Feb 29 is a real weekday in a leap year, and Mar 1 follows it', () => {
  assert.equal(dayOfWeekOf(buildCalendar(2036), 2, 29), 4);
  assert.equal(dayOfWeekOf(buildCalendar(2036), 3, 1), 5);
  assert.equal(dayOfWeekOf(buildCalendar(2035), 3, 1), 3);
});

// --- 3. Mask count, computed by hand -------------------------------------
//
// "August only, weekdays only, hours 7-22" for calendar year 2035.
// August 2035 has 31 days; August 1, 2035 is a Wednesday (independently
// confirmed via Python's datetime, not by re-running calendar.ts).
// Walking Wed(1) Thu(2) Fri(3) Sat(4) Sun(5) Mon(6) Tue(7) ... for 31 days
// and counting Mon-Fri by hand gives 23 weekdays. Hours 7 through 22
// inclusive is 22 - 7 + 1 = 16 hours per day.
//   expected = 23 weekdays * 16 hours/day = 368

check('mask for August, weekdays, HE 7-22 has a hand-computed count', () => {
  const calendar = buildCalendar(2035);
  const filters = {
    dates: [{ start: 213, end: 243 }], // August
    hoursOfDay: new Set([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]),
    daysOfWeek: new Set([0, 1, 2, 3, 4]), // Monday..Friday
    seasons: null,
    tou: null,
  };
  const touBitmap = new Uint8Array(YEAR_SLOT_HOURS); // unused: filters.tou is null
  const mask = buildMask(filters, calendar, touBitmap);
  assert.equal(mask.length, YEAR_SLOT_HOURS);
  let kept = 0;
  for (let h = 0; h < mask.length; h++) kept += mask[h];
  const weekdaysInAugust2035 = 23; // hand count, see comment above
  const hoursPerDay = 22 - 7 + 1;
  const expected = weekdaysInAugust2035 * hoursPerDay;
  assert.equal(expected, 368);
  assert.equal(kept, expected);
});

// --- 3b. Dates -------------------------------------------------------------
//
// Every year sits on the leap-calendar slot, so day d is hours 24d … 24d + 23
// in any year: a range keeps the same hours in a 2035 and a 2045 calendar,
// though their weekdays differ. Only a leap year keeps Feb 29 (day 59).

check('a date range keeps the same hours in every year, and intersects', () => {
  const touBitmap = new Uint8Array(YEAR_SLOT_HOURS); // unused: filters.tou is null
  const base = { hoursOfDay: null, daysOfWeek: null, seasons: null, tou: null };
  const kept = (mask) => [...mask.keys()].filter((h) => mask[h] === 1);

  // Feb 20 (day 50) to Mar 10 (day 69): 20 slot days, 19 of them real in a
  // non-leap year.
  const dates = [{ start: 50, end: 69 }];
  const in2035 = kept(buildMask({ ...base, dates }, buildCalendar(2035), touBitmap));
  const in2045 = kept(buildMask({ ...base, dates }, buildCalendar(2045), touBitmap));
  const in2036 = kept(buildMask({ ...base, dates }, buildCalendar(2036), touBitmap));
  assert.equal(in2035.length, 19 * 24);
  assert.equal(in2036.length, 20 * 24, 'a leap year keeps its Feb 29 too');
  assert.deepEqual(in2045, in2035, 'the same hours whatever the year');
  assert.equal(in2035[0], 50 * 24, 'from HE 1 of Feb 20');
  assert.equal(in2035.at(-1), 70 * 24 - 1, 'to HE 24 of Mar 10');
  const first = buildCalendar(2035)[in2035[0]];
  assert.equal([getMonth(first), getDayOfMonth(first)].join('/'), '2/20');

  // It intersects with the other dimensions rather than replacing them.
  const narrow = buildMask(
    { ...base, dates: [{ start: 213, end: 215 }], hoursOfDay: new Set([17]) },
    buildCalendar(2035),
    touBitmap,
  );
  assert.equal(kept(narrow).length, 3, 'Aug 1-3, HE 17');
});

check('scattered dates keep each run’s hours, the same in every year', () => {
  const touBitmap = new Uint8Array(YEAR_SLOT_HOURS);
  const base = { hoursOfDay: null, daysOfWeek: null, seasons: null, tou: null };
  const kept = (mask) => [...mask.keys()].filter((h) => mask[h] === 1);
  // Feb 20, Jul 14 and Aug 3: three days, 72 hours.
  const dates = [
    { start: 50, end: 50 },
    { start: 195, end: 195 },
    { start: 215, end: 215 },
  ];
  const in2035 = kept(buildMask({ ...base, dates }, buildCalendar(2035), touBitmap));
  assert.equal(in2035.length, 72);
  assert.deepEqual(kept(buildMask({ ...base, dates }, buildCalendar(2045), touBitmap)), in2035);
  assert.deepEqual([in2035[0], in2035[24], in2035[48]], [50 * 24, 195 * 24, 215 * 24]);
  const days = [in2035[0], in2035[24], in2035[48]].map((h) => buildCalendar(2035)[h]);
  assert.deepEqual(
    days.map((e) => `${getMonth(e)}/${getDayOfMonth(e)}`),
    ['2/20', '7/14', '8/3'],
  );
});

// --- 3c. The leap-calendar slot ---------------------------------------------

check('leap years follow the Gregorian century rule', () => {
  assert.equal(isLeapYear(2035), false);
  assert.equal(isLeapYear(2036), true);
  assert.equal(isLeapYear(2100), false, 'a century is not leap');
  assert.equal(isLeapYear(2000), true, 'unless divisible by 400');
});

check('realHours counts real hours, never slots', () => {
  assert.equal(realHours(2035, 1), 8760);
  assert.equal(realHours(2036, 1), 8784);
  assert.equal(realHours(2034, 3), 8760 + 8760 + 8784);
  assert.equal(realHours(2034, 3), 26304);
  assert.equal(realHours(2100, 1), 8760);
  assert.equal(realHours(2000, 1), 8784);
});

check('the slot tables span 366 days with Feb 29 at day 59', () => {
  assert.equal(YEAR_SLOT_DAYS, 366);
  assert.equal(YEAR_SLOT_HOURS, YEAR_SLOT_DAYS * 24);
  assert.equal(
    SLOT_MONTH_LENGTHS.reduce((a, b) => a + b, 0),
    YEAR_SLOT_DAYS,
  );
  assert.deepEqual(SLOT_MONTH_STARTS.slice(0, 3), [0, 31, 60]);
  assert.equal(SLOT_MONTH_STARTS[11] + SLOT_MONTH_LENGTHS[11], YEAR_SLOT_DAYS);
  const feb29 = SLOT_MONTH_STARTS[1] + 29 - 1;
  assert.equal(feb29, 59);
  assert.deepEqual([feb29 * 24, feb29 * 24 + 23], [1416, 1439]);
});

check('the phantom-day flag reads bit 31 without a sign', () => {
  const entry = (2 << 0) | (29 << 4) | (1 << 12); // Feb 29, HE 1
  assert.equal(isPhantomDay(entry), false);
  const phantom = entry | (1 << PHANTOM_DAY_SHIFT);
  assert.ok(phantom < 0, 'negative as a JS int');
  assert.equal(isPhantomDay(phantom), true);
  assert.equal(isPhantomDay(new Uint32Array([phantom])[0]), true, 'and stored in a Uint32Array');
  assert.equal(getMonth(phantom), 2, 'the flag leaves the other fields alone');
  assert.equal(getDayOfMonth(phantom), 29);
});

check('Feb 29 is phantom in a non-leap year and real in a leap year', () => {
  const in2035 = buildCalendar(2035);
  const in2036 = buildCalendar(2036);
  for (let h = 0; h < YEAR_SLOT_HOURS; h++) {
    const feb29 = h >= 1416 && h <= 1439;
    assert.equal(isPhantomDay(in2035[h]), feb29, `2035 hour ${h}`);
    assert.equal(isPhantomDay(in2036[h]), false, `2036 hour ${h}`);
  }
  // Still Feb 29 in both, so a month or season reads it as February.
  for (const entry of [in2035[1416], in2036[1439]]) {
    assert.equal(getMonth(entry), 2);
    assert.equal(getDayOfMonth(entry), 29);
  }
});

check('Mar 1 is slot day 60 in a leap and a non-leap year', () => {
  for (const year of [2035, 2036]) {
    const entry = buildCalendar(year)[60 * 24];
    assert.equal(`${getMonth(entry)}/${getDayOfMonth(entry)}`, '3/1', String(year));
  }
});

check('buildMask keeps no phantom hour, even with no filters at all', () => {
  const touBitmap = new Uint8Array(YEAR_SLOT_HOURS);
  const none = { dates: null, hoursOfDay: null, daysOfWeek: null, seasons: null, tou: null };
  const in2035 = buildMask(none, buildCalendar(2035), touBitmap);
  const in2036 = buildMask(none, buildCalendar(2036), touBitmap);
  assert.equal(
    in2035.reduce((a, b) => a + b, 0),
    realHours(2035, 1),
  );
  assert.equal(
    in2036.reduce((a, b) => a + b, 0),
    realHours(2036, 1),
  );
  for (let h = 1416; h <= 1439; h++) assert.equal(in2035[h], 0, `2035 hour ${h}`);
  // A phantom day has no weekday: asking for every weekday still keeps none.
  const everyDay = { ...none, daysOfWeek: new Set([0, 1, 2, 3, 4, 5, 6]) };
  const weekdays = buildMask(everyDay, buildCalendar(2035), touBitmap);
  for (let h = 1416; h <= 1439; h++) assert.equal(weekdays[h], 0, `2035 hour ${h}`);
});

check('a dates filter on day 59 keeps 2036’s Feb 29 and nothing in 2035', () => {
  const touBitmap = new Uint8Array(YEAR_SLOT_HOURS);
  const base = { hoursOfDay: null, daysOfWeek: null, seasons: null, tou: null };
  const kept = (mask) => [...mask.keys()].filter((h) => mask[h] === 1);
  const dates = [{ start: 59, end: 59 }];
  assert.deepEqual(kept(buildMask({ ...base, dates }, buildCalendar(2035), touBitmap)), []);
  const in2036 = kept(buildMask({ ...base, dates }, buildCalendar(2036), touBitmap));
  assert.deepEqual(
    in2036,
    Array.from({ length: 24 }, (_, i) => 1416 + i),
  );
});

// --- 4. Groupings ---------------------------------------------------------

check("areasIn('Zone 1') returns exactly its two member areas", () => {
  assert.deepEqual(areasIn('Zone 1'), ['AREA01', 'AREA02']);
});

// --- 5. Rules ---------------------------------------------------------------

check('Avg LMP Weighted by Load rule is WEIGHTED_MEAN by Load (MWh)', () => {
  const rule = ruleFor('Avg LMP Weighted by Load ($/MWh)');
  assert.ok(rule, 'rule not found');
  assert.equal(rule.series, 'WEIGHTED_MEAN');
  assert.equal(rule.weight, 'Load (MWh)');
});

check("'Gen - Load' is filed under Calculations, not Load", () => {
  assert.equal(groupOf('Gen - Load'), CALCULATED_GROUP);
  assert.equal(groupOf('Load (MWh)'), 'Load');
  // The folder has to exist as its own group, or the picker cannot mark it.
  const titles = metricGroups(['Load (MWh)', 'Generation (MWh)', 'Gen - Load']).map((g) => g.title);
  assert.ok(titles.includes(CALCULATED_GROUP), titles.join(', '));
});

// MW and MWh are the same number for a single hour, so they share one chart
// axis. The scale merge must not leak past the axis: MW stays a rate
// everywhere else, and a unit that is genuinely a different quantity must
// still get its own axis or the chart compares nothing.
check('MW and MWh share one y scale, labelled with both, and nothing else merges', () => {
  assert.equal(scaleOf('MW'), scaleOf('MWh'), 'a rate held for one hour IS that much energy');
  assert.notEqual(scaleOf('$/MWh'), scaleOf('MWh'), 'a price is not an energy');
  assert.notEqual(scaleOf('ratio'), scaleOf('MWh'), 'a dimensionless ratio is not an energy');

  const merged = scalesOf([{ unit: 'MWh' }, { unit: 'MW' }, { unit: 'MWh' }]);
  assert.equal(merged.length, 1, 'one axis, not two');
  assert.equal(merged[0].label, 'MWh · MW', 'the axis must still name both units');

  // Three units, two scales: the pane refuses at three, so this has to draw.
  assert.equal(scalesOf([{ unit: 'MWh' }, { unit: 'MW' }, { unit: '$/MWh' }]).length, 2);

  // The rule table is untouched by any of this -- MW is still CAPACITY, which
  // is what forbids summing it over hours.
  assert.equal(ruleFor('Net Load (MW)').class, 'CAPACITY');
  assert.equal(ruleFor('Net Load (MW)').temporal, 'MEAN');
});

// The default selection has to be able to draw its own charts. Nothing is
// auto-added at load, so a default that names a weighted-mean or calculated
// column without its inputs ships a set whose panes refuse.
check('the default column selection is closed under its own dependencies', () => {
  const everything = rulesData.columns.map((c) => c.canonical.trim());
  const unknown = DEFAULT_METRICS.filter((name) => !everything.includes(name));
  assert.deepEqual(unknown, [], 'every default must be a real canonical name');

  const picked = defaultSelection(everything);
  assert.deepEqual(requiredInputs(picked), [], 'a default must not need a column it leaves out');
  assert.ok(
    picked.length > 0 && picked.length < everything.length,
    `${picked.length} of ${everything.length}`,
  );
});

check('an unrecognised schema falls back to keeping everything', () => {
  // A picker that opens with nothing ticked reads as a failed load.
  assert.deepEqual(defaultSelection(['Some Future Column', 'Another']), [
    'Some Future Column',
    'Another',
  ]);
});

console.log(`\n${passed} checks passed`);
