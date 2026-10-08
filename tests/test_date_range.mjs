// tests/test_date_range.mjs
//
// The dates filter's arithmetic (src/model/date-range.ts): how the rail's
// ◀ ▶, Alt and Shift arrows, window buttons, typed dates and a pane's
// drag-zoom move one run of days.

import assert from 'node:assert/strict';

import './test_loader.mjs';

const { YEAR_SLOT_DAYS } = await import('../src/model/calendar.ts');
const {
  dayLabel,
  extendRange,
  monthRange,
  parseDay,
  rangeDays,
  rangeHours,
  rangeLabel,
  rangeOfHours,
  stepRange,
  weekdayOf,
  wholeMonths,
  windowFrom,
  normalize,
  toggleDay,
  addRun,
  replaceRun,
  stepSet,
  slideSet,
  extendSet,
  setDays,
  setLabel,
  sameSet,
} = await import('../src/model/date-range.ts');

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`ok - ${label}`);
}

const day = (text) => parseDay(text).day;
const feb20ToMar10 = { start: day('Feb 20'), end: day('Mar 10') };

check('Feb 20 – Mar 10 is 20 days on the leap slot, 480 hours, from HE 1 of Feb 20', () => {
  assert.equal(feb20ToMar10.start, 50);
  assert.equal(rangeDays(feb20ToMar10), 20);
  const [from, to] = rangeHours(feb20ToMar10);
  assert.equal(to - from, 480);
  assert.equal(from, 50 * 24);
  assert.equal(rangeLabel(feb20ToMar10), 'Feb 20 – Mar 10');
  assert.equal(rangeLabel({ start: 50, end: 50 }), 'Feb 20');
});

check('typed dates read three ways, and Feb 29 is day 59 of every year', () => {
  assert.equal(day('Feb 20'), 50);
  assert.equal(day('February 20'), 50);
  assert.equal(day('2/20'), 50);
  assert.equal(day('dec 31'), YEAR_SLOT_DAYS - 1);
  assert.equal(day('Feb 29'), 59);
  assert.equal(day('2/29'), 59);
  assert.equal(day('Mar 1'), 60);
  assert.equal(dayLabel(59), 'Feb 29');
  assert.ok('refusal' in parseDay('Feb 30'));
  assert.ok('refusal' in parseDay('Apr 31'));
  assert.ok('refusal' in parseDay('13/1'));
  assert.ok('refusal' in parseDay('soon'));
});

check('a window steps by its own length and stops at the year’s ends', () => {
  const week = { start: 10, end: 16 };
  assert.deepEqual(stepRange(week, 1), { start: 17, end: 23 });
  assert.deepEqual(stepRange(week, -1), { start: 3, end: 9 });
  assert.deepEqual(stepRange({ start: 2, end: 8 }, -1), { start: 0, end: 6 }, 'stops at Jan 1');
  const last = { start: 359, end: 365 };
  assert.deepEqual(stepRange(last, 1), last, 'a window at Dec 31 does not step on');
  assert.deepEqual(stepRange({ start: 100, end: 100 }, 1), { start: 101, end: 101 });
});

check('whole months step by months, not by days', () => {
  assert.equal(wholeMonths(monthRange(1)), 1);
  assert.deepEqual(stepRange(monthRange(1), 1), monthRange(2), 'February steps to March');
  assert.deepEqual(stepRange(monthRange(2), -1), monthRange(1), 'March steps back to February');
  const janFeb = { start: monthRange(0).start, end: monthRange(1).end };
  assert.equal(wholeMonths(janFeb), 2);
  assert.deepEqual(stepRange(janFeb, 1), { start: monthRange(2).start, end: monthRange(3).end });
  assert.deepEqual(stepRange(monthRange(11), 1), monthRange(11), 'December does not wrap');
  assert.equal(wholeMonths(feb20ToMar10), 0);
});

check('Alt slides a day keeping the length; Shift moves the end', () => {
  assert.deepEqual(slideSet([feb20ToMar10], 1), [{ start: 51, end: 70 }]);
  assert.deepEqual(slideSet([{ start: 0, end: 6 }], -1), [{ start: 0, end: 6 }]);
  assert.deepEqual(extendRange(feb20ToMar10, 1), { start: 50, end: 70 });
  assert.deepEqual(
    extendRange({ start: 5, end: 5 }, -1),
    { start: 5, end: 5 },
    'never before start',
  );
});

check('Day and Week start at From; Month is the month containing it', () => {
  assert.deepEqual(windowFrom(50, 'day'), { start: 50, end: 50 });
  assert.deepEqual(windowFrom(50, 'week'), { start: 50, end: 56 });
  assert.deepEqual(windowFrom(363, 'week'), { start: 359, end: 365 }, 'a week keeps 7 days');
  assert.deepEqual(windowFrom(50, 'month'), monthRange(1));
  assert.deepEqual(monthRange(1), { start: 31, end: 59 }, 'February holds its 29th');
});

check('a drag-zoom over hour indexes becomes the days it touches', () => {
  assert.deepEqual(rangeOfHours(50 * 24 + 3.2, 69 * 24 + 20.7), feb20ToMar10);
  assert.deepEqual(rangeOfHours(-0.5, 8783.5), { start: 0, end: 365 });
});

check('a date’s weekday is its year’s', () => {
  // Jan 1 2035 is a Monday, Jan 1 2045 a Sunday (0 = Monday .. 6 = Sunday).
  assert.equal(weekdayOf(2035, 0), 0);
  assert.equal(weekdayOf(2045, 0), 6);
  assert.equal(dayLabel(0), 'Jan 1');
});

check('a phantom Feb 29 has no weekday; the days after it keep their own', () => {
  assert.equal(weekdayOf(2035, 59), -1, '2035 has no Feb 29');
  assert.equal(weekdayOf(2035, 60), 3, '2035-03-01 is a Thursday');
  assert.equal(weekdayOf(2036, 59), 4, '2036-02-29 is a Friday');
  assert.equal(weekdayOf(2036, 60), 5, '2036-03-01 is a Saturday');
});

check('runs that overlap or touch merge; no runs is every day', () => {
  assert.deepEqual(
    normalize([
      { start: 53, end: 53 },
      { start: 50, end: 52 },
    ]),
    [{ start: 50, end: 53 }],
    'Feb 20–22 plus Feb 23 is one run',
  );
  assert.equal(normalize([]), null);
  assert.deepEqual(addRun(null, { start: 5, end: 6 }), [{ start: 5, end: 6 }]);
});

check('Ctrl-click adds a day, takes a picked one out, and may split a run', () => {
  const run = [{ start: 50, end: 52 }];
  assert.deepEqual(toggleDay(run, 51), [
    { start: 50, end: 50 },
    { start: 52, end: 52 },
  ]);
  assert.deepEqual(toggleDay(run, 60), [
    { start: 50, end: 52 },
    { start: 60, end: 60 },
  ]);
  assert.equal(toggleDay([{ start: 7, end: 7 }], 7), null, 'the last day out is every day again');
  assert.deepEqual(toggleDay(null, 9), [{ start: 9, end: 9 }], 'from every day, that day alone');
});

check('several runs step by a week together and stop at the year’s ends', () => {
  const set = [
    { start: 50, end: 52 },
    { start: 194, end: 194 },
  ];
  assert.deepEqual(stepSet(set, 1), [
    { start: 57, end: 59 },
    { start: 201, end: 201 },
  ]);
  assert.deepEqual(slideSet(set, -1), [
    { start: 49, end: 51 },
    { start: 193, end: 193 },
  ]);
  const late = [
    { start: 300, end: 300 },
    { start: 362, end: 362 },
  ];
  assert.deepEqual(
    stepSet(late, 1),
    [
      { start: 303, end: 303 },
      { start: 365, end: 365 },
    ],
    'moves only as far as Dec 31 allows',
  );
  assert.ok(sameSet(stepSet(stepSet(late, 1), 1), stepSet(late, 1)), 'then stops');
  assert.deepEqual(
    stepSet([{ start: 31, end: 59 }], 1),
    [{ start: 60, end: 90 }],
    'one run as before',
  );
  assert.deepEqual(extendSet(set, 1).at(-1), { start: 194, end: 195 }, 'Shift moves the last end');
});

check('a run dragged onto another merges; a set labels and counts its runs', () => {
  const set = [
    { start: 10, end: 12 },
    { start: 20, end: 22 },
  ];
  assert.deepEqual(replaceRun(set, 1, { start: 13, end: 15 }), [{ start: 10, end: 15 }]);
  assert.equal(setDays(set), 6);
  assert.equal(setLabel(set), 'Jan 11 – Jan 13, Jan 21 – Jan 23');
  assert.equal(
    setLabel([...set, { start: 40, end: 40 }], 2),
    'Jan 11 – Jan 13, Jan 21 – Jan 23 and 1 more run',
  );
});

console.log(`\n${passed} checks passed`);
