// tests/test_time_span.mjs — the time and stacked panes over a Case's every
// year (src/ui/panes/line.ts), run against the fake DOM with the uPlot
// stand-in of tests/test_fixtures_uplot.mjs. The axis is slot positions from
// the earliest drawn Case's first year (AGENTS.md, "the time axis is slot
// positions"), so:
//
//   (a) a line sits at its Case's year offset, null outside its years, and a
//       one-year frame keeps the one-slot axis;
//   (b) Cases of different years sit side by side by date, never overlaid;
//   (c) a limit sits at its own Case's offset;
//   (d) stacked shares the axis and sums per x;
//   (e) a phantom hour's hover names the date as no such day, with no value;
//   (f) follow dates names one year's days, and a window across years takes
//       every date and keeps the zoom;
//   (g) the pane CSV writes the drawer's wide layout: the slot hours the
//       window covers, a column per line and year it touches, named by year
//       only past one, and a window inside one year the one-year file;
//   (h) the Figure is the pane's axis: lines placed at their years, ticked
//       by year, phantom Feb 29s as gaps, the hours footnote out of the
//       years the window touches, and the caption naming the years past one;
//   (i) the year overview strip spans the drawn years, phantom Feb 29s
//       empty, each run of the dates drawn in every year, and a drag in
//       any year moves the run's slot days, stopping at the slot's end;
//       a one-year strip is the one year it always was;
//   (j) followed dates on a multi-year axis show one year's days: the year
//       last zoomed or clicked in the overview, else the first with data,
//       with a note counting the years the statistics take; a zoom reset
//       or a double-click returns to that year; the Figure's
//       caption names only the years its window shows;
//   (k) "overlay years" cuts each line into its years on one Jan–Dec slot,
//       each year a shade of the line's colour, oldest to newest: a phantom
//       Feb 29 stays a gap, a year the Years filter drops is not drawn, the
//       hover names each line's year and no year in its head, the year in
//       a cell no ellipsis cuts, and rows past the pane's height flow into
//       columns (past its width too: the nearest kept, the rest counted);
//       a limit is drawn once, the pane CSV writes a column per line and
//       year, the lines are capped by a refusal naming the Years filter;
//       the Figure
//       draws every line and year in its shade on the one slot, keys each
//       series once with its year ramp, names the years overlaid in the
//       caption, and not again as the Years filter, and counts hours out of
//       the drawn years' real hours;
//       unticked, or over one year, nothing changes.

import './test_loader.mjs';
import './test_fixtures_uplot.mjs';
import assert from 'node:assert/strict';
import { plots } from './test_fixtures_uplot.mjs';
import { installFakeDom, stubHost, frameOf, FakeElement } from './test_fixtures_dom.mjs';

installFakeDom();
const { createTimeAdapter, createStackedAdapter } = await import('../src/ui/panes/line.ts');
const { YEAR_SLOT_HOURS: H } = await import('../src/model/calendar.ts');
const { NO_YEAR } = await import('../src/app/boxes.ts');
const { buildFigure, FIGURE_SIZES } = await import('../src/figure/build.ts');
const { shade } = await import('../src/ui/palette.ts');
const { createLegendAdapter } = await import('../src/ui/panes/legend.ts');
const { filtersLabel } = await import('../src/app/browse-scope.ts');
const { figureFilters } = await import('../src/app/render-frame.ts');
const { readFileSync } = await import('node:fs');

let passed = 0;
async function check(label, fn) {
  await fn();
  passed++;
  console.log(`ok - ${label}`);
}

/** Feb 29's hours in the slot. */
const FEB29 = [1416, 1440];

/** A line of a Case `years` slots long from `firstYear`, its value at slot
 * position h being `at(h)`; Feb 29 of a non-leap year is NaN, as a load
 * leaves it. */
function lineOf(caseLabel, firstYear, years, at = (h) => 1 + (h % 24), color = '#1f77b4') {
  const values = Float32Array.from({ length: H * years }, (_, h) => {
    const year = firstYear + Math.floor(h / H);
    const slot = h % H;
    const leap = year % 4 === 0;
    return !leap && slot >= FEB29[0] && slot < FEB29[1] ? NaN : at(h);
  });
  return {
    name: `${caseLabel} line`,
    color,
    unit: 'MW',
    values,
    sorted: values.slice().sort(),
    n: values.length,
    stats: { n: values.length, mean: 1, min: 1, max: 24, sd: 1 },
    warnings: [],
    allZero: false,
    facets: { caseLabel, kind: 'area', variable: 'Load', unit: 'MW', subject: 'SAMPLE_AREA' },
    span: { firstYear, numYears: years },
  };
}

const frameFor = (lines, extra = {}) => frameOf(lines, { spanOf: (line) => line.span, ...extra });

/** The adapter `make` drawn once on `frame`, and the plot it built. */
function drawn(make, frame) {
  const { host, record } = stubHost();
  const adapter = make(host);
  plots.length = 0;
  adapter.draw(frame);
  return { host, record, adapter, plot: plots.at(-1) };
}

const valuesAt = (column, from, to) => column.slice(from, to);

await check('(a) a three-year line draws on a three-slot axis, each year at its offset', () => {
  const line = lineOf('SAMPLE_CASEM', 2035, 3, (h) => h);
  const { plot } = drawn(createTimeAdapter, frameFor([line]));
  assert.equal(plot.data[0].length, 3 * H);
  assert.equal(plot.data[1][0], 0);
  assert.equal(plot.data[1][2 * H + 5], 2 * H + 5, 'year 3 is at x ≥ 17,568');
  assert.equal(plot.data[1][3 * H - 1], 3 * H - 1);
  assert.equal(plot.data[1][FEB29[0]], null, '2035 has no Feb 29');
  assert.equal(plot.data[1][2 * H + FEB29[0]], null, 'nor 2037');
  assert.equal(plot.data[1][H + FEB29[0]], H + FEB29[0], '2036 does');
  assert.deepEqual(plot.scales.x, { min: -0.5, max: 3 * H - 0.5 }, 'the whole span is shown');
});

await check('(a) a one-year frame keeps the one-slot axis', () => {
  const line = lineOf('SAMPLE_CASE1', 2031, 1);
  for (const frame of [frameFor([line]), frameOf([line])]) {
    const { plot } = drawn(createTimeAdapter, frame);
    assert.equal(plot.data[0].length, H);
    assert.deepEqual(
      plot.data[1],
      Array.from(line.values, (v) => (Number.isNaN(v) ? null : v)),
    );
  }
});

await check('(a, b) a one-year Case beside a three-year one sits in its own year', () => {
  const span = lineOf('SAMPLE_CASEM', 2035, 3);
  const one = lineOf('SAMPLE_CASE1', 2036, 1, (h) => 100 + (h % 7), '#ff7f0e');
  const { plot } = drawn(createTimeAdapter, frameFor([span, one]));
  assert.equal(plot.data[0].length, 3 * H);
  const column = plot.data[2];
  assert.ok(
    valuesAt(column, 0, H).every((v) => v === null),
    'null in 2035',
  );
  assert.ok(
    valuesAt(column, 2 * H, 3 * H).every((v) => v === null),
    'null in 2037',
  );
  for (const x of [H, H + 1500, 2 * H - 1]) assert.equal(column[x], one.values[x - H]);
});

await check('(b) one-year Cases of 2034 and 2035 sit side by side', () => {
  const early = lineOf('SAMPLE_CASEA', 2034, 1, () => 1);
  const late = lineOf('SAMPLE_CASEB', 2035, 1, () => 2, '#ff7f0e');
  const { plot } = drawn(createTimeAdapter, frameFor([late, early]));
  assert.equal(plot.data[0].length, 2 * H, 'the union of their years');
  assert.equal(plot.data[1][10], null, 'the 2035 Case is not drawn over 2034');
  assert.equal(plot.data[1][H + 10], 2);
  assert.equal(plot.data[2][10], 1);
  assert.equal(plot.data[2][H + 10], null);
});

await check('(b) a line with no year names no origin and sits at x = 0', () => {
  const yearless = {
    ...lineOf('SAMPLE_NOYEAR', NO_YEAR, 1),
    span: { firstYear: NO_YEAR, numYears: 1 },
  };
  const dated = lineOf('SAMPLE_CASEB', 2036, 1);
  const alone = drawn(createTimeAdapter, frameFor([yearless])).plot;
  assert.equal(alone.data[0].length, H);
  const tip = hoverAt(alone, 1500);
  assert.equal(tip.head, 'Mar 3 · HE 13', 'no year is printed for a placeholder');
  const mixed = drawn(createTimeAdapter, frameFor([yearless, dated])).plot;
  assert.equal(mixed.data[0].length, H, 'the dated line is the origin');
  assert.equal(hoverAt(mixed, 1500).head, '2036 Mar 3 · HE 13');
});

await check('(c) each limit sits at its own Case’s offset', () => {
  const span = lineOf('SAMPLE_CASEM', 2035, 3);
  const one = lineOf('SAMPLE_CASE1', 2036, 1);
  const limit = (firstYear, years, value) => ({
    name: `limit ${value}`,
    color: '#000',
    unit: 'MW',
    firstYear,
    values: new Float32Array(years * H).fill(value),
  });
  const { plot } = drawn(
    createTimeAdapter,
    frameFor([span, one], { limits: [limit(2035, 3, 500), limit(2036, 1, 300)] }),
  );
  const [, , , spanLimit, oneLimit] = plot.data;
  assert.equal(spanLimit[0], 500);
  assert.equal(spanLimit[3 * H - 1], 500, 'repeated over every year of its Case');
  assert.equal(oneLimit[H - 1], null);
  assert.equal(oneLimit[H], 300);
  assert.equal(oneLimit[2 * H - 1], 300);
  assert.equal(oneLimit[2 * H], null);
});

await check('(d) stacked shares the axis and sums per x', () => {
  const span = lineOf('SAMPLE_CASEM', 2035, 3, () => 2);
  const one = lineOf('SAMPLE_CASE1', 2036, 1, () => 1, '#ff7f0e');
  const { plot, record } = drawn(createStackedAdapter, frameFor([one, span]));
  assert.deepEqual(record.banners, []);
  assert.equal(plot.data[0].length, 3 * H);
  const top = plot.data[2];
  assert.equal(top[10], 2, '2035: the span alone');
  assert.equal(top[H + 10], 3, '2036: both');
  assert.equal(top[2 * H + 10], 2, '2037: the span alone');
  assert.equal(top[FEB29[0]], null, 'a phantom day has nothing to stack');
  const tip = hoverAt(plot, H + 10);
  assert.deepEqual(tip.values, ['2', '1', '3'], 'its own values and the total');
});

/** The hover readout at x, read through the plot's first cursor hook. */
function hoverAt(plot, x) {
  const over = new FakeElement();
  plot.options.hooks.setCursor[0]({
    over,
    cursor: { idx: x, left: 10 },
    data: plot.data,
    series: plot.series,
  });
  const tip = over.children[0];
  if (tip.style.display === 'none') return null;
  const [head, ...rows] = tip.children;
  return {
    head: head.textContent,
    values: rows.map((row) => row.children.at(-1).textContent),
  };
}

await check('(e) a phantom hour names its date as no such day, and shows no value', () => {
  const line = lineOf('SAMPLE_CASEM', 2035, 3);
  const { plot } = drawn(createTimeAdapter, frameFor([line]));
  assert.deepEqual(hoverAt(plot, FEB29[0] + 4), {
    head: '2035 Feb 29 · HE 5 · no such day',
    values: [],
  });
  assert.deepEqual(hoverAt(plot, H + FEB29[0] + 4), {
    head: '2036 Feb 29 · HE 5',
    values: ['5'],
  });
  const filtered = lineOf('SAMPLE_CASEM', 2035, 3, () => NaN);
  const blank = drawn(createTimeAdapter, frameFor([filtered])).plot;
  assert.equal(hoverAt(blank, 10), null, 'an hour filtered out still shows nothing');
  const stacked = drawn(createStackedAdapter, frameFor([line])).plot;
  assert.deepEqual(hoverAt(stacked, FEB29[0]), {
    head: '2035 Feb 29 · HE 1 · no such day',
    values: [],
  });
});

/** Drag-zoom the plot over [from, to] as uPlot's select reports it. */
function zoom(plot, from, to) {
  for (const hook of plot.options.hooks.setSelect) {
    hook({ select: { left: from, width: to - from }, posToVal: (px) => px });
  }
  plot.setScale('x', { min: from, max: to });
}

await check(
  '(f) follow dates: one year’s window names its days; across years, every date',
  async () => {
    const line = lineOf('SAMPLE_CASEM', 2035, 3);
    const dates = [{ start: 40, end: 50 }];
    const { host, adapter, plot } = drawn(createTimeAdapter, frameFor([line], { dates }));
    const asked = [];
    host.datesChange = (set) => asked.push(set);

    zoom(plot, H + 24 * 10 + 3, H + 24 * 12 + 5);
    await Promise.resolve();
    assert.deepEqual(asked.pop(), [{ start: 10, end: 12 }], 'the slot days of the 2036 window');

    zoom(plot, 8000, 9500);
    await Promise.resolve();
    assert.equal(asked.pop(), null, 'a window across 2035 and 2036 takes every date');
    adapter.draw(frameFor([line]));
    assert.deepEqual(
      plot.scales.x,
      { min: 8000, max: 9500 },
      'and the render that follows keeps it',
    );
    adapter.draw(frameFor([line]));
    assert.deepEqual(plot.scales.x, { min: -0.5, max: 3 * H - 0.5 }, 'once only');

    zoom(plot, 8000, 9500);
    await Promise.resolve();
    adapter.draw(frameFor([line]));
    assert.deepEqual(
      plot.scales.x,
      { min: -0.5, max: 3 * H - 0.5 },
      'with no dates to clear, nothing re-renders, so nothing is held for a later render',
    );
  },
);

await check('(f) a date filter while following shows its days in one year, not every year', () => {
  const dates = [{ start: 40, end: 40 }];
  const masked = lineOf('SAMPLE_CASEM', 2035, 3, (h) =>
    Math.floor((h % H) / 24) === 40 ? 1 : NaN,
  );
  const { plot } = drawn(createTimeAdapter, frameFor([masked], { dates }));
  assert.deepEqual(plot.scales.x, { min: 40 * 24 - 0.5, max: 41 * 24 - 0.5 });
});

/** What `download()` saved, as text, or null. */
async function downloaded(adapter) {
  let saved = null;
  globalThis.URL.createObjectURL = (blob) => {
    saved = blob;
    return 'blob:sample';
  };
  // The URL's revoke timer would hold the process open for a minute.
  const { setTimeout } = globalThis;
  const { createElement } = document;
  globalThis.setTimeout = () => 0;
  document.createElement = (tag) => Object.assign(createElement(tag), { click() {} });
  try {
    adapter.download();
  } finally {
    globalThis.setTimeout = setTimeout;
    document.createElement = createElement;
  }
  return saved ? saved.text() : null;
}

await check(
  '(g) the pane CSV writes every year it shows, on the slot, a column per year',
  async () => {
    for (const make of [createTimeAdapter, createStackedAdapter]) {
      // Each year at its own level: x is the span position, so 2035 is 1xx,
      // 2036 2xx and 2037 3xx.
      const line = lineOf('SAMPLE_CASEM', 2035, 3, (h) => 100 * (1 + Math.floor(h / H)) + (h % 24));
      const span = drawn(make, frameFor([line]));
      const whole = (await downloaded(span.adapter)).trim().split('\n');
      assert.deepEqual(span.record.banners, [], 'nothing is refused');
      assert.equal(
        whole[0],
        'Month,Day,HE,HourOfYear,SAMPLE_CASEM line 2035,SAMPLE_CASEM line 2036,SAMPLE_CASEM line 2037',
      );
      assert.equal(whole.length, 1 + H, 'one row per slot hour');
      assert.equal(whole[1], 'Jan,1,1,0,100,200,300');
      assert.equal(whole[1 + FEB29[0]], 'Feb,29,1,1416,,200,', 'Feb 29 only in 2036');

      // A window across New Year 2035–2036: Dec 31 HE 23 to Jan 1 HE 2,
      // its rows in date order from the window's first.
      span.plot.setScale('x', { min: H - 2, max: H + 1 });
      const turn = (await downloaded(span.adapter)).trim().split('\n');
      assert.deepEqual(turn, [
        'Month,Day,HE,HourOfYear,SAMPLE_CASEM line 2035,SAMPLE_CASEM line 2036',
        'Dec,31,23,8782,122,',
        'Dec,31,24,8783,123,',
        'Jan,1,1,0,,200',
        'Jan,1,2,1,,201',
      ]);

      // One-year Cases of different years, a window across both: each Case
      // writes its own year, blank in the other's.
      const early = lineOf('SAMPLE_CASEA', 2034, 1, () => 1);
      const late = lineOf('SAMPLE_CASEB', 2035, 1, () => 2, '#ff7f0e');
      const pair = drawn(make, frameFor([early, late]));
      pair.plot.setScale('x', { min: H - 1.5, max: H + 0.5 });
      assert.deepEqual((await downloaded(pair.adapter)).trim().split('\n'), [
        'Month,Day,HE,HourOfYear,SAMPLE_CASEA line 2034,SAMPLE_CASEA line 2035,' +
          'SAMPLE_CASEB line 2034,SAMPLE_CASEB line 2035',
        'Dec,31,24,8783,1,,,',
        'Jan,1,1,0,,,,2',
      ]);

      // A window inside one year is the one-year file: no year in a name.
      pair.plot.setScale('x', { min: H - 0.5, max: H + 1.5 });
      const rows = (await downloaded(pair.adapter)).trim().split('\n');
      assert.equal(rows[0], 'Month,Day,HE,HourOfYear,SAMPLE_CASEA line,SAMPLE_CASEB line');
      assert.equal(rows.length, 3, 'a header and the two hours of 2035 shown');
      assert.match(rows[1], /^Jan,1,1,0,,2$/, 'its slot hour, the 2034 Case blank there');
    }
  },
);

/** A figure of what `adapter` drew, as the dialog would build it. */
function figureOf(adapter) {
  const { capture } = adapter.figure.capture();
  return buildFigure({
    ...capture,
    hourFilter: 'all hours',
    size: FIGURE_SIZES.half,
    measureText: (text, pt) => text.length * pt * 0.5,
  });
}

/** Every stroked line's points (`polyline` in src/figure/svg.ts), as
 * [x, y] pairs. */
const polylines = (svg) =>
  [...svg.matchAll(/<path d="([^"]*)" fill="none"/g)].map((m) =>
    [...m[1].matchAll(/[ML]([-\d.]+) ([-\d.]+)/g)].map((p) => [Number(p[1]), Number(p[2])]),
  );

const svgTexts = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

await check('(h) a three-year time figure spans the three slots, ticked by year', () => {
  // Each year at its own level, so year 3 drawn shows as its value.
  const line = lineOf('SAMPLE_CASEM', 2035, 3, (h) => 10 * (1 + Math.floor(h / H)));
  const { adapter } = drawn(createTimeAdapter, frameFor([line]));
  assert.equal(adapter.figure.offered(), true);
  const { capture } = adapter.figure.capture();
  assert.equal(capture.firstYear, 2035);
  assert.equal(capture.lines[0].values.length, 3 * H);
  assert.equal(capture.lines[0].values[2 * H + 5], 30, 'year 3 is captured at its offset');
  assert.equal(capture.realHours, 8760 + 8784 + 8760);

  const figure = figureOf(adapter);
  const labels = svgTexts(figure.svg);
  for (const year of ['2035', '2036', '2037']) assert.ok(labels.includes(year), year);
  // Feb 29 of 2035 and of 2037 are phantom: three runs, never bridged.
  const runs = polylines(figure.svg);
  assert.equal(runs.length, 3, 'two phantom Feb 29s, two gaps');
  const xs = runs.flat().map(([x]) => x);
  const [left, right] = [Math.min(...xs), Math.max(...xs)];
  const yearEnds = (run) => [run[0][0], run.at(-1)[0]];
  // 2035 Jan–Feb 28, then Mar 2035 through Feb 28 2037 (2036 is leap), then
  // Mar 2037 to the end: each break sits a phantom day into its year.
  const width = right - left;
  const at = (x) => (x - left) / width;
  assert.ok(Math.abs(at(yearEnds(runs[1])[0]) - 1440 / (3 * H)) < 0.01);
  assert.ok(Math.abs(at(yearEnds(runs[2])[0]) - (2 * H + 1440) / (3 * H)) < 0.01);
  // Year 3's level is drawn, above year 1's.
  const yOfRun = (run) => run[0][1];
  assert.ok(yOfRun(runs[2]) < yOfRun(runs[0]), 'year 3 (30) is drawn above year 1 (10)');
});

await check('(h) the hours footnote counts out of the years the window touches', () => {
  const line = lineOf('SAMPLE_CASEM', 2035, 3);
  const { adapter, plot } = drawn(createTimeAdapter, frameFor([line]));
  assert.deepEqual(
    figureOf(adapter).texts.filter((t) => t.id.startsWith('footnote[')),
    [],
    'every real hour shown: no footnote',
  );
  const footnote = (min, max) => {
    plot.setScale('x', { min, max });
    return figureOf(adapter)
      .texts.filter((t) => t.id.startsWith('footnote['))
      .map((t) => t.text);
  };
  assert.deepEqual(footnote(-0.5, H - 0.5), [], 'all of 2035: every real hour of it');
  // Jun 10 to Jun 15 2036.
  assert.deepEqual(
    footnote(H + 161 * 24 - 0.5, H + 167 * 24 - 0.5),
    ['Hours shown: 144 of 8,784 hours'],
    'a week of 2036 counts out of 2036 alone',
  );
  // Dec 31 2035 to Jan 1 2036.
  assert.deepEqual(
    footnote(H - 24 - 0.5, H + 24 - 0.5),
    ['Hours shown: 48 of 17,544 hours'],
    'a window across years counts out of both',
  );
  assert.deepEqual(
    footnote(H - 24 - 0.5, 3 * H - 0.5),
    ['Hours shown: 17,568 of 26,304 hours'],
    'a window into all three years counts out of every year',
  );
});

await check('(h) a one-year 2036 line beside a three-year one is placed in the middle slot', () => {
  for (const make of [createTimeAdapter, createStackedAdapter]) {
    const span = lineOf('SAMPLE_CASEM', 2035, 3, () => 2);
    const one = lineOf('SAMPLE_CASE1', 2036, 1, () => 1, '#ff7f0e');
    const { adapter } = drawn(make, frameFor([span, one]));
    const { capture } = adapter.figure.capture();
    const placed = capture.lines.find((entry) => entry.facets.caseLabel === 'SAMPLE_CASE1');
    assert.equal(placed.values.length, 3 * H);
    assert.ok(Number.isNaN(placed.values[H - 1]), 'nothing in 2035');
    assert.equal(placed.values[H], 1, '2036 Jan 1 HE 1');
    assert.equal(placed.values[2 * H - 1], 1);
    assert.ok(Number.isNaN(placed.values[2 * H]), 'nothing in 2037');
    assert.equal(capture.realHours, 26304, 'the one-year line adds no year');
    const figure = figureOf(adapter);
    assert.ok(polylines(figure.svg).length > 0);
  }
});

await check('(h) the caption names the years when the figure covers more than one', () => {
  const withYears = (line) => ({
    ...line,
    facets: { ...line.facets, years: line.span },
  });
  const caption = (lines) =>
    figureOf(drawn(createTimeAdapter, frameFor(lines.map(withYears))).adapter).caption;
  assert.equal(
    caption([lineOf('SAMPLE_CASEM', 2035, 3)]),
    'Hourly Area Load for SAMPLE_AREA, Case SAMPLE_CASEM, 2035–2037.',
  );
  assert.equal(
    caption([lineOf('SAMPLE_CASEA', 2034, 1), lineOf('SAMPLE_CASEB', 2035, 1)]),
    'Hourly Area Load for SAMPLE_AREA, Cases SAMPLE_CASEA and SAMPLE_CASEB, 2034–2035.',
  );
  assert.equal(
    caption([lineOf('SAMPLE_CASE1', 2035, 1)]),
    'Hourly Area Load for SAMPLE_AREA, Case SAMPLE_CASE1.',
    'one year: the ticks name it',
  );
});

await check('(h) a one-year figure ticks months, naming its year once', () => {
  const { adapter } = drawn(createTimeAdapter, frameFor([lineOf('SAMPLE_CASE1', 2035, 1)]));
  const labels = svgTexts(figureOf(adapter).svg);
  assert.ok(labels.includes('Jan 2035'), labels.join('|'));
  assert.ok(labels.includes('Jun'));
  const yearless = drawn(createTimeAdapter, frameOf([lineOf('SAMPLE_CASE1', 2035, 1)])).adapter;
  assert.equal(yearless.figure.capture().capture.firstYear, undefined, 'no year, no origin');
  assert.ok(svgTexts(figureOf(yearless).svg).includes('Jan'));
});

/** A time pane drawn on `lines` with its overview ticked, and the strip's
 * svg. The overview spans the plot, 400 px from x = 0. */
function overviewOf(lines, dates = null) {
  const { host } = stubHost();
  const asked = [];
  host.datesChange = (set) => asked.push(set);
  host.controls.overview.checked = true;
  const strip = host.controls.overviewHost;
  strip.rect = { left: 0, width: 400, height: 56 };
  const adapter = createTimeAdapter(host);
  const frame = { ...frameFor(lines, { dates, overview: () => lines }), wholeYear: () => lines };
  adapter.draw(frame);
  return { strip, asked, adapter, frame, svg: () => strip.children[0] };
}

const ofKind = (svg, tag, test = () => true) =>
  svg.children.filter((node) => node.tagName === tag.toUpperCase() && test(node.attributes));
/** The x of every point on the strip's daily mean trace. */
const traceXs = (svg) =>
  ofKind(svg, 'path', (a) => a.fill === 'none')[0]
    .attributes.d.match(/[ML][\d.]+/g)
    .map((step) => Number(step.slice(1)));
/** The left x of each window of the dates. */
const windowXs = (svg) =>
  ofKind(svg, 'rect', (a) => a.fill === 'none' && a.stroke === '#0066cc').map((node) =>
    Number(node.attributes.x),
  );
const px = (day, days) => (day / days) * 400;
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 0.06, `expected ~${expected}, drew ${actual}`);

globalThis.requestAnimationFrame ??= () => 1;
globalThis.cancelAnimationFrame ??= () => {};

await check('(i) a three-year overview draws 3 × 366 days, a year boundary every 366', () => {
  const { strip, svg } = overviewOf([lineOf('SAMPLE_CASEM', 2035, 3)]);
  assert.equal(strip.hidden, false, 'the strip is shown under a multi-year axis');
  const days = 3 * 366;
  const xs = traceXs(svg());
  assert.equal(xs.length, days - 2, 'every day but the two phantom Feb 29s');
  const drawnAt = (day) => xs.some((x) => Math.abs(x - px(day + 0.5, days)) < 0.06);
  assert.ok(!drawnAt(59), '2035 Feb 29 is no data');
  assert.ok(drawnAt(366 + 59), '2036 Feb 29 is a day');
  assert.ok(!drawnAt(2 * 366 + 59), '2037 Feb 29 is no data');
  assert.ok(drawnAt(0) && drawnAt(days - 1), 'Jan 1 2035 to Dec 31 2037');
  const years = ofKind(svg(), 'line', (a) => a.stroke === '#bbbbbb').map((n) =>
    Number(n.attributes.x1),
  );
  assert.equal(years.length, 2);
  close(years[0], px(366, days));
  close(years[1], px(732, days));
  assert.deepEqual(
    ofKind(svg(), 'text').map((n) => n.textContent),
    ['2035', '2036', '2037'],
    'past two years the strip names years, not months',
  );
});

await check('(i) a two-year overview names months, its Januaries by year', () => {
  const { svg } = overviewOf([
    lineOf('SAMPLE_CASEA', 2034, 1),
    lineOf('SAMPLE_CASEB', 2035, 1, undefined, '#ff7f0e'),
  ]);
  const labels = ofKind(svg(), 'text').map((n) => n.textContent);
  assert.equal(labels[0], '2034');
  assert.ok(labels.includes('2035'));
  assert.ok(labels.length < 24, 'thinned to fit 400 px');
  const [mean2034, mean2035] = ofKind(svg(), 'path', (a) => a.fill === 'none').map((n) =>
    n.attributes.d.match(/M[\d.]+/)[0].slice(1),
  );
  close(Number(mean2034), px(0.5, 732));
  close(Number(mean2035), px(366.5, 732), 'each line at its own year');
});

await check('(i) a run of the dates draws in every year', () => {
  const dates = [{ start: 40, end: 50 }];
  const { svg } = overviewOf([lineOf('SAMPLE_CASEM', 2035, 3)], dates);
  const xs = windowXs(svg());
  assert.equal(xs.length, 3);
  [40, 366 + 40, 732 + 40].forEach((day, i) => close(xs[i], px(day, 3 * 366)));
});

await check('(i) a drag in 2036 moves the slot days, so every copy, and stops at Dec 31', () => {
  const dates = [{ start: 40, end: 50 }];
  const days = 3 * 366;
  const { strip, asked, svg } = overviewOf([lineOf('SAMPLE_CASEM', 2035, 3)], dates);
  const pointer = (type, day) =>
    strip.fire(type, { clientX: px(day, days), pointerId: 1, preventDefault() {} });
  pointer('pointerdown', 366 + 45.5);
  pointer('pointermove', 366 + 55.5);
  const xs = windowXs(svg());
  [50, 366 + 50, 732 + 50].forEach((day, i) => close(xs[i], px(day, days)));
  pointer('pointerup', 366 + 55.5);
  assert.deepEqual(asked.pop(), [{ start: 50, end: 60 }], 'slot days, not 2036’s axis days');

  pointer('pointerdown', 366 + 45.5);
  pointer('pointermove', 366 + 600.5);
  pointer('pointerup', 366 + 600.5);
  assert.deepEqual(asked.pop(), [{ start: 355, end: 365 }], 'never carried into 2037');

  pointer('pointerdown', 2 * 366 + 200.5);
  pointer('pointermove', 2 * 366 + 210.5);
  pointer('pointerup', 2 * 366 + 210.5);
  assert.deepEqual(asked.pop(), [{ start: 200, end: 210 }], 'a new run from 2037’s slot days');
});

await check('(i) a one-year overview is the one year, months as always', async () => {
  const { svg } = overviewOf([lineOf('SAMPLE_CASE1', 2031, 1)], [{ start: 10, end: 20 }]);
  const { MONTH_NAMES, SLOT_MONTH_STARTS } = await import('../src/model/calendar.ts');
  assert.deepEqual(
    ofKind(svg(), 'text').map((n) => n.textContent),
    [...MONTH_NAMES],
  );
  const rules = ofKind(svg(), 'line');
  assert.equal(rules.length, 12, 'a rule per month and no year rule');
  rules.forEach((n, m) => close(Number(n.attributes.x1), px(SLOT_MONTH_STARTS[m], 366)));
  assert.equal(traceXs(svg()).length, 365, '2031 has no Feb 29');
  close(traceXs(svg())[0], px(0.5, 366));
  const xs = windowXs(svg());
  assert.equal(xs.length, 1);
  close(xs[0], px(10, 366));
  assert.equal(
    svg().attributes['aria-label'],
    'The whole year, by day, with the dates as a window',
  );
});

/** `lineOf` kept only on the days of `dates`, in every year, as the masked
 * lines of a frame with those dates. */
function datedLine(caseLabel, firstYear, years, dates, keep = () => true) {
  const inDates = (h) => {
    const day = Math.floor((h % H) / 24);
    return dates.some((run) => day >= run.start && day <= run.end);
  };
  return lineOf(caseLabel, firstYear, years, (h) =>
    inDates(h) && keep(Math.floor(h / H)) ? 1 + (h % 24) : NaN,
  );
}

const week = [{ start: 160, end: 166 }];
/** Slot `slot`'s view of `week`. */
const weekIn = (slot) => ({ min: slot * H + 160 * 24 - 0.5, max: slot * H + 167 * 24 - 0.5 });
const noteFor = (year, held = 3, of = 3) =>
  `Showing ${year}. The dates apply in every year: ${held} of ${of} years in the statistics.`;

await check(
  '(j) a week zoomed in 2036 shows that week in 2036, the dates in every year',
  async () => {
    const line = lineOf('SAMPLE_CASEM', 2035, 3);
    const { host, record, adapter, plot } = drawn(createTimeAdapter, frameFor([line]));
    const asked = [];
    host.datesChange = (set) => asked.push(set);
    zoom(plot, H + 160 * 24 + 3, H + 166 * 24 + 5);
    await Promise.resolve();
    assert.deepEqual(asked.pop(), week);
    adapter.draw(frameFor([datedLine('SAMPLE_CASEM', 2035, 3, week)], { dates: week }));
    assert.deepEqual(plot.scales.x, weekIn(1), 'slot 1 only');
    assert.equal(record.notes.at(-1), noteFor(2036));
    adapter.resetZoom();
    assert.deepEqual(plot.scales.x, weekIn(1), 'a zoom reset returns to the shown year');
  },
);

/** A double-click on the plot, as uPlot binds it: its own handler widens x
 * to the whole data, then the pane's listener runs. */
function dblclick(plot) {
  const target = {};
  const own = () => plot.setScale('x', { min: plot.data[0][0], max: plot.data[0].at(-1) });
  plot.options.cursor.bind.dblclick(plot, target, own)({ button: 0, target });
}

await check('(j) a double-click lands where the zoom reset does', async () => {
  const line = lineOf('SAMPLE_CASEM', 2035, 3);
  const { host, adapter, plot } = drawn(createTimeAdapter, frameFor([line]));
  host.datesChange = () => {};
  zoom(plot, H + 160 * 24 + 3, H + 166 * 24 + 5);
  await Promise.resolve();
  adapter.draw(frameFor([datedLine('SAMPLE_CASEM', 2035, 3, week)], { dates: week }));
  plot.setScale('x', { min: H + 162 * 24, max: H + 163 * 24 });
  dblclick(plot);
  assert.deepEqual(plot.scales.x, weekIn(1), 'following: the shown year, not the span');

  const unfollowed = stubHost().host;
  unfollowed.controls.follow.checked = false;
  plots.length = 0;
  createTimeAdapter(unfollowed).draw({
    ...frameFor([datedLine('SAMPLE_CASEM', 2035, 3, week)], { dates: week, overview: {} }),
    wholeYear: () => [line],
  });
  const whole = plots.at(-1);
  whole.setScale('x', { min: H + 162 * 24, max: H + 163 * 24 });
  dblclick(whole);
  assert.deepEqual(whole.scales.x, { min: -0.5, max: 3 * H - 0.5 }, 'unfollowed: the extent');

  const one = drawn(
    createTimeAdapter,
    frameFor([datedLine('SAMPLE_CASE1', 2035, 1, week)], { dates: week }),
  ).plot;
  one.setScale('x', { min: 160 * 24, max: 161 * 24 });
  dblclick(one);
  assert.deepEqual(one.scales.x, weekIn(0), 'one year: its dates, as before');

  const stacked = drawn(createStackedAdapter, frameFor([line])).plot;
  stacked.setScale('x', { min: 100, max: 200 });
  dblclick(stacked);
  assert.deepEqual(stacked.scales.x, { min: -0.5, max: 3 * H - 0.5 }, 'stacked: its extent');
});

await check('(j) dates from the rail show the first year with data on them', () => {
  const all = drawn(
    createTimeAdapter,
    frameFor([datedLine('SAMPLE_CASEM', 2035, 3, week)], { dates: week }),
  );
  assert.deepEqual(all.plot.scales.x, weekIn(0));
  assert.equal(all.record.notes.at(-1), noteFor(2035));
  const later = datedLine('SAMPLE_CASEM', 2035, 3, week, (slot) => slot > 0);
  const { plot, record } = drawn(createTimeAdapter, frameFor([later], { dates: week }));
  assert.deepEqual(plot.scales.x, weekIn(1), '2035 holds none of the dates');
  assert.equal(record.notes.at(-1), noteFor(2036, 2, 3));
  const kept = datedLine('SAMPLE_CASEM', 2035, 3, week, (slot) => slot < 2);
  const years = drawn(
    createTimeAdapter,
    frameFor([kept], { dates: week, years: new Set([2035, 2036]) }),
  );
  assert.equal(years.record.notes.at(-1), noteFor(2035, 2, 2), 'only the years kept count');
});

await check('(j) a click on the 2037 run shows 2037 and leaves the dates', () => {
  const lines = [datedLine('SAMPLE_CASEM', 2035, 3, week)];
  const { strip, asked, adapter, frame } = overviewOf(lines, week);
  const plot = plots.at(-1);
  assert.deepEqual(plot.scales.x, weekIn(0));
  const days = 3 * 366;
  const pointer = (type, day) =>
    strip.fire(type, { clientX: px(day, days), pointerId: 1, preventDefault() {} });
  pointer('pointerdown', 2 * 366 + 163.5);
  pointer('pointerup', 2 * 366 + 163.5);
  assert.deepEqual(asked, [], 'the dates are untouched');
  assert.deepEqual(plot.scales.x, weekIn(2));
  adapter.draw(frame);
  assert.deepEqual(plot.scales.x, weekIn(2), 'and a render keeps the year');
});

await check('(j) clearing the dates, or a new origin, forgets the year', async () => {
  const line = lineOf('SAMPLE_CASEM', 2035, 3);
  const { host, adapter, plot } = drawn(createTimeAdapter, frameFor([line]));
  host.datesChange = () => {};
  const dated = frameFor([datedLine('SAMPLE_CASEM', 2035, 3, week)], { dates: week });
  zoom(plot, H + 160 * 24 + 3, H + 166 * 24 + 5);
  adapter.draw(dated);
  assert.deepEqual(plot.scales.x, weekIn(1));
  adapter.draw(frameFor([line]));
  adapter.draw(dated);
  assert.deepEqual(plot.scales.x, weekIn(0), 'cleared');

  zoom(plot, H + 160 * 24 + 3, H + 166 * 24 + 5);
  adapter.draw(dated);
  assert.deepEqual(plot.scales.x, weekIn(1));
  adapter.draw(frameFor([datedLine('SAMPLE_CASEN', 2036, 3, week)], { dates: week }));
  assert.deepEqual(plots.at(-1).scales.x, weekIn(0), 'from 2036: its first year, not 2037');
});

await check('(j) a one-year axis draws the dates as before, with no note', () => {
  const { plot, record } = drawn(
    createTimeAdapter,
    frameFor([datedLine('SAMPLE_CASE1', 2035, 1, week)], { dates: week }),
  );
  assert.deepEqual(plot.scales.x, weekIn(0));
  assert.deepEqual(record.notes, []);
});

await check('(j) the caption names only the years the window shows', () => {
  const line = lineOf('SAMPLE_CASEM', 2035, 3);
  const withYears = { ...line, facets: { ...line.facets, years: line.span } };
  const { adapter, plot } = drawn(createTimeAdapter, frameFor([withYears]));
  const tail = 'Hourly Area Load for SAMPLE_AREA, Case SAMPLE_CASEM';
  assert.equal(figureOf(adapter).caption, `${tail}, 2035–2037.`);
  // Apr 1 to Sep 30 2036.
  plot.setScale('x', { min: H + 91 * 24 - 0.5, max: H + 274 * 24 - 0.5 });
  const zoomed = figureOf(adapter);
  assert.equal(zoomed.caption, `${tail}.`);
  assert.ok(
    svgTexts(zoomed.svg).some((t) => t.includes('2036')),
    'the ticks name the year',
  );
  // Dec 2035 to Jan 2036.
  plot.setScale('x', { min: H - 31 * 24 - 0.5, max: H + 31 * 24 - 0.5 });
  assert.equal(figureOf(adapter).caption, `${tail}, 2035–2036.`);
});

/** The time adapter drawn once on `frame` with "overlay years" ticked. */
function overlaid(frame) {
  const { host, record } = stubHost();
  host.controls.overlayYears.checked = true;
  const adapter = createTimeAdapter(host);
  plots.length = 0;
  adapter.draw(frame);
  return { host, record, adapter, plot: plots.at(-1) };
}

const nullOf = (values) => Array.from(values, (v) => (Number.isNaN(v) ? null : v));
const labelsOf = (plot) => plot.series.slice(1).map((s) => s.label);

await check('(k) a three-year line overlays as three years on one slot, in shades', () => {
  const line = lineOf('SAMPLE_CASEM', 2035, 3, (h) => h);
  const { plot, record } = overlaid(frameFor([line]));
  assert.deepEqual(record.banners, []);
  assert.equal(plot.data[0].length, H, 'one Jan–Dec slot');
  assert.deepEqual(labelsOf(plot), [
    'SAMPLE_CASEM line · 2035',
    'SAMPLE_CASEM line · 2036',
    'SAMPLE_CASEM line · 2037',
  ]);
  assert.deepEqual(
    plot.series.slice(1).map((s) => s.stroke),
    [0, 1, 2].map((i) => shade(line.color, i, 3)),
  );
  assert.equal(plot.series[1 + 1].stroke, line.color, 'the middle year is the base colour');
  assert.deepEqual(plot.data[2], nullOf(line.values.subarray(H, 2 * H)), 'year 2 is slot 2');
  assert.equal(plot.data[1][FEB29[0]], null, '2035 has no Feb 29');
  assert.equal(plot.data[2][FEB29[0]], H + FEB29[0], '2036 does');
  assert.equal(plot.data[3][FEB29[0]], null, 'nor 2037');
  assert.deepEqual(plot.scales.x, { min: -0.5, max: H - 0.5 });
});

await check('(k) two series over three years: six lines, two legend rows, six hover rows', () => {
  const a = lineOf('SAMPLE_CASEM', 2035, 3, () => 1);
  const b = lineOf('SAMPLE_CASEN', 2035, 3, () => 2, '#ff7f0e');
  const frame = frameFor([a, b]);
  const { plot } = overlaid(frame);
  assert.equal(plot.series.length - 1, 6);
  assert.deepEqual(
    plot.series.slice(1).map((s) => s.stroke),
    [a, b].flatMap((line) => [0, 1, 2].map((i) => shade(line.color, i, 3))),
  );
  const over = new FakeElement();
  plot.options.hooks.setCursor[0]({
    over,
    cursor: { idx: 2 * 24 + 4, left: 10 },
    data: plot.data,
    series: plot.series,
  });
  const [head, ...rows] = over.children[0].children;
  assert.equal(head.textContent, 'Jan 3 · HE 5', 'no year in the head');
  assert.deepEqual(
    rows.map((row) => [row.children[1].textContent, row.children[2].textContent]),
    [a, b].flatMap((line) => [2035, 2036, 2037].map((year) => [line.name, `${year}`])),
    'the name and the year in cells of their own',
  );
  assert.deepEqual(
    rows.map((row) => row.children[0].style.background),
    plot.series.slice(1).map((s) => s.stroke),
  );

  const { host } = stubHost();
  createLegendAdapter(host).draw(frame);
  const [, tbody] = host.legendHost.children[0].children;
  assert.deepEqual(
    tbody.children.map((tr) => tr.children[0].children[0].style.background),
    [a.color, b.color],
    'the legend pane: one row per series, in its base colour',
  );
});

/** The hover the plot's first cursor hook builds at hour `idx`, in an
 * `over` of the given size: the tip, its head and its rows. */
function hovered(plot, idx, { width = 400, height = 300, top = 0 } = {}) {
  const over = new FakeElement();
  over.rect = { width, height };
  plot.options.hooks.setCursor[0]({
    over,
    cursor: { idx, left: 10, top },
    data: plot.data,
    series: plot.series,
    valToPos: (value) => value,
  });
  const tip = over.children[0];
  const [head, ...rows] = tip.children;
  return { tip, head, rows };
}

/** The declarations of `selector`'s one rule in src/styles.css. */
function cssRule(selector) {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `styles.css has ${selector}`);
  return css.slice(at, css.indexOf('}', at));
}

await check('(k) a long name gives way in the hover; the year never does', () => {
  const long = 'SAMPLE_INTERFACE · Power Flow (MW) as % of summed limits, Case SAMPLE_CASEM';
  const line = { ...lineOf('SAMPLE_CASEM', 2035, 3), name: long };
  const { plot } = overlaid(frameFor([line]));
  const { rows } = hovered(plot, 5);
  for (const [k, row] of rows.entries()) {
    const [, name, year] = row.children;
    assert.equal(name.className, 'chart-tip-name');
    assert.equal(name.textContent, long, 'the name whole, for the ellipsis to cut');
    assert.equal(year.className, 'chart-tip-tag');
    assert.equal(year.textContent, `${2035 + k}`);
  }
  const name = cssRule('.gv-section .chart-tip-name');
  assert.match(name, /text-overflow: ellipsis/);
  const tag = cssRule('.gv-section .chart-tip-tag');
  assert.match(tag, /flex-shrink: 0/, 'the year cell never shrinks');
  assert.doesNotMatch(tag, /overflow|max-width/, 'nor cuts its text');

  const plain = drawn(createTimeAdapter, frameFor([line])).plot;
  const [row] = hovered(plain, 5).rows;
  assert.deepEqual(
    row.children.map((cell) => cell.className),
    ['chart-tip-dot', 'chart-tip-name', ''],
    'off the overlay, a row is as it was: no tag',
  );
  assert.equal(row.children[1].textContent, long);
});

await check('(k) thirty hover rows in a short pane flow into columns inside it', () => {
  const lines = [0, 1, 2].map((n) =>
    lineOf(`SAMPLE_CASE${n}`, 2035, 10, () => n, ['#1f77b4', '#ff7f0e', '#2ca02c'][n]),
  );
  const { plot } = overlaid(frameFor(lines));
  // A row is 17px (styles.css: 11px at line-height 1.5); the tip loses 24px
  // to its inset, padding and border, and its head a row.
  const height = 200;
  const perColumn = Math.floor((height - 24 - 17) / 17);
  const { tip, rows } = hovered(plot, 5, { width: 1100, height });
  assert.equal(rows.length, 30, 'every series and year');
  const columns = Number(tip.style.columnCount);
  assert.equal(columns, Math.ceil(30 / perColumn));
  assert.ok(24 + 17 + Math.ceil(30 / columns) * 17 <= height, 'the tallest column fits the pane');
  assert.ok(columns * 240 <= 1100 - 12, 'and the columns its width');
  assert.match(cssRule('.gv-section .chart-tip-row'), /break-inside: avoid/);
  assert.match(cssRule('.gv-section .chart-tip-x'), /column-span: all/);

  const tall = hovered(plot, 5, { width: 900, height: 600 });
  assert.equal(tall.tip.style.columnCount, '', 'a tip that fits is one column, as ever');
});

await check('(k) rows past the columns the pane holds keep the nearest, and count the rest', () => {
  const lines = [0, 1, 2].map((n) =>
    lineOf(`SAMPLE_CASE${n}`, 2035, 10, () => 10 * n, ['#1f77b4', '#ff7f0e', '#2ca02c'][n]),
  );
  const { plot } = overlaid(frameFor(lines));
  // 7 rows a column, one column across: six rows and the count.
  const { tip, rows } = hovered(plot, 5, { width: 300, height: 160, top: 20 });
  const shown = rows.filter((row) => row.className === 'chart-tip-row');
  const more = rows.at(-1);
  assert.equal(more.className, 'chart-tip-more');
  assert.equal(more.textContent, '+24 more, farther from the cursor');
  assert.equal(shown.length, 6);
  assert.ok(
    shown.every((row) => row.children[1].textContent === 'SAMPLE_CASE2 line'),
    'the rows nearest the cursor: the series drawn at 20',
  );
  assert.equal(tip.style.columnCount, '');
});

await check('(k) a non-overlay hover that fits is unchanged by the fitting', () => {
  const a = lineOf('SAMPLE_CASEM', 2035, 1);
  const b = lineOf('SAMPLE_CASEN', 2035, 1, undefined, '#ff7f0e');
  const { plot } = drawn(createTimeAdapter, frameFor([a, b]));
  const { tip, head, rows } = hovered(plot, 5);
  assert.equal(head.className, 'chart-tip-x');
  assert.deepEqual(
    rows.map((row) => [row.className, row.children[1].textContent, row.children.length]),
    [
      ['chart-tip-row', a.name, 3],
      ['chart-tip-row', b.name, 3],
    ],
  );
  assert.equal(tip.style.columnCount, '');
  assert.equal(tip.style.display, '');
});

await check(
  '(k) the Years filter’s dropped years are not drawn, and the shades span the kept',
  () => {
    const kept = lineOf('SAMPLE_CASEM', 2035, 3, (h) => (Math.floor(h / H) === 1 ? NaN : 7));
    const other = lineOf(
      'SAMPLE_CASEN',
      2035,
      3,
      (h) => (Math.floor(h / H) === 1 ? NaN : 8),
      '#ff7f0e',
    );
    const { plot } = overlaid(frameFor([kept, other], { years: new Set([2035, 2037]) }));
    assert.deepEqual(labelsOf(plot), [
      'SAMPLE_CASEM line · 2035',
      'SAMPLE_CASEM line · 2037',
      'SAMPLE_CASEN line · 2035',
      'SAMPLE_CASEN line · 2037',
    ]);
    assert.deepEqual(
      plot.series.slice(1).map((s) => s.stroke),
      [kept, other].flatMap((line) => [0, 1].map((i) => shade(line.color, i, 2))),
    );
  },
);

await check('(k) unticked, or over one year, the axis is as before', () => {
  const line = lineOf('SAMPLE_CASEM', 2035, 3, (h) => h);
  const { plot } = drawn(createTimeAdapter, frameFor([line]));
  assert.equal(plot.data[0].length, 3 * H, 'unticked: the span axis');
  assert.equal(plot.series.length - 1, 1);
  const one = lineOf('SAMPLE_CASE1', 2035, 1, (h) => h);
  const single = overlaid(frameFor([one])).plot;
  assert.equal(single.data[0].length, H);
  assert.deepEqual(labelsOf(single), ['SAMPLE_CASE1 line'], 'one year: no overlay, no year');
});

await check('(k) a limit is drawn once, folded onto the slot, in its line’s colour', () => {
  const line = lineOf('SAMPLE_CASEM', 2035, 3);
  const values = Float32Array.from({ length: 3 * H }, (_, h) => {
    const slot = h % H;
    // As a load masks it: no 2035 or 2037 Feb 29.
    if (h < H && slot >= FEB29[0] && slot < FEB29[1]) return NaN;
    if (h >= 2 * H && slot >= FEB29[0] && slot < FEB29[1]) return NaN;
    return slot < 744 ? 500 : 600;
  });
  const limit = { name: 'limit', color: line.color, unit: 'MW', firstYear: 2035, values };
  const { plot, adapter } = overlaid(frameFor([line], { limits: [limit] }));
  assert.equal(plot.series.length - 1, 4, 'three years and one limit');
  const [figured] = adapter.figure.capture().capture.limits;
  assert.deepEqual(
    Array.from(figured.values, (v) => (Number.isNaN(v) ? null : v)),
    plot.data[4],
    'the figure’s too',
  );
  assert.equal(figured.color, line.color);
  const drawnLimit = plot.data[4];
  assert.equal(drawnLimit.length, H);
  assert.equal(drawnLimit[0], 500);
  assert.equal(drawnLimit[H - 1], 600);
  assert.equal(drawnLimit[FEB29[0]], 600, 'Feb 29 from the year that has one');
  assert.equal(plot.series[4].stroke, line.color);
});

await check('(k) the pane CSV writes a column per line and year over the window', async () => {
  const line = lineOf('SAMPLE_CASEM', 2035, 3, (h) => 100 * (1 + Math.floor(h / H)) + (h % 24));
  const { adapter, plot } = overlaid(frameFor([line]));
  plot.setScale('x', { min: FEB29[0] - 1.5, max: FEB29[0] + 0.5 });
  assert.deepEqual((await downloaded(adapter)).trim().split('\n'), [
    'Month,Day,HE,HourOfYear,SAMPLE_CASEM line 2035,SAMPLE_CASEM line 2036,SAMPLE_CASEM line 2037',
    'Feb,28,24,1415,123,223,323',
    'Feb,29,1,1416,,200,',
  ]);
});

await check('(k) past thirty lines the overlay is refused, naming the Years filter', () => {
  const lines = [0, 1, 2, 3].map((n) =>
    lineOf(`SAMPLE_CASE${n}`, 2035, 10, () => n, ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728'][n]),
  );
  const { record, host } = overlaid(frameFor(lines));
  assert.deepEqual(record.banners, [
    {
      kind: 'refusal',
      text:
        'Overlaying 4 series over 10 years draws 40 lines; the most a chart can tell apart ' +
        'is 30. Keep fewer years with the Years filter, or fewer series.',
    },
  ]);
  assert.equal(host.uplotHost.style.display, 'none');
  const three = overlaid(frameFor(lines.slice(0, 3)));
  assert.deepEqual(three.record.banners, [], 'thirty lines draw');
  assert.equal(three.plot.series.length - 1, 30);
});

await check('(k) a zoom over an overlay follows slot days', async () => {
  const line = lineOf('SAMPLE_CASEM', 2035, 3);
  const { host, plot } = overlaid(frameFor([line], { dates: [{ start: 40, end: 50 }] }));
  const asked = [];
  host.datesChange = (set) => asked.push(set);
  zoom(plot, 24 * 10 + 3, 24 * 12 + 5);
  await Promise.resolve();
  assert.deepEqual(asked, [[{ start: 10, end: 12 }]]);
});

/** A line's facets naming its Case's span, as a kind builds them. */
const spanned = (line) => ({ ...line, facets: { ...line.facets, years: line.span } });

await check('(k) the overlay Figure: a line per series and year, in the pane’s shades', () => {
  const a = spanned(lineOf('SAMPLE_CASEM', 2035, 3, (h) => 10 + Math.floor(h / H)));
  const b = spanned(lineOf('SAMPLE_CASEN', 2035, 3, (h) => 20 + Math.floor(h / H), '#ff7f0e'));
  const { adapter, plot } = overlaid(frameFor([a, b]));
  assert.equal(adapter.figure.offered(), true);
  const { capture } = adapter.figure.capture();
  assert.equal(capture.firstYear, undefined, 'one slot, no year');
  assert.equal(capture.lines.length, 6);
  assert.deepEqual(
    capture.lines.map((l) => l.color),
    plot.series.slice(1).map((s) => s.stroke),
    'the pane’s own shades',
  );
  assert.deepEqual(
    capture.lines.map((l) => l.overlay),
    [a, b].flatMap((line, series) =>
      [2035, 2036, 2037].map((year) => ({ series, year, base: line.color })),
    ),
  );
  assert.ok(capture.lines.every((l) => l.values.length === H));
  assert.equal(capture.lines[4].values[0], 21, 'SAMPLE_CASEN 2036 at Jan 1');
  assert.equal(capture.realHours, 8760 + 8784 + 8760);

  const figure = figureOf(adapter);
  const strokes = [...figure.svg.matchAll(/<path d="[^"]*" fill="none" stroke="([^"]*)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    [...new Set(strokes)],
    capture.lines.map((l) => l.color),
    'six lines in six shades',
  );
  const ids = figure.texts.map((t) => t.id);
  assert.ok(ids.includes('legend[1][0]') && !ids.includes('legend[2][0]'), 'two key rows');
  assert.deepEqual(
    figure.texts.filter((t) => t.id.includes('[year]')),
    [0, 1].flatMap((r) =>
      [2035, 2036, 2037].map((year, k) => ({ id: `legend[${r}][year][${k}]`, text: `${year}` })),
    ),
  );
  assert.ok(
    figure.svg.includes(`stroke="${a.color}"`) && figure.svg.includes(`stroke="${b.color}"`),
    'each row’s swatch in its series’ colour',
  );
  assert.ok(
    svgTexts(figure.svg).every((t) => !/^20\d\d$/.test(t) || ['2035', '2036', '2037'].includes(t)),
  );
  assert.equal(
    figure.caption,
    'Hourly Area Load for SAMPLE_AREA, Cases SAMPLE_CASEM and SAMPLE_CASEN, ' +
      'years 2035–2037 overlaid.',
  );
  assert.deepEqual(
    figure.texts.filter((t) => t.id.startsWith('footnote[')),
    [],
    'every real hour of the three years shown',
  );
  const { capture: shot } = adapter.figure.capture();
  const edited = buildFigure({
    ...shot,
    hourFilter: 'all hours',
    size: FIGURE_SIZES.half,
    measureText: (text, pt) => text.length * pt * 0.5,
    edits: { 'legend[1][year][2]': 'Y3' },
  });
  assert.ok(svgTexts(edited.svg).includes('Y3'), 'a ramp label is edited by its id');
});

await check(
  '(k) the overlay Figure’s footnote and caption over a zoom and the Years filter',
  () => {
    const line = spanned(
      lineOf('SAMPLE_CASEM', 2035, 3, (h) => (Math.floor(h / H) === 1 ? NaN : 7)),
    );
    const { adapter, plot } = overlaid(frameFor([line], { years: new Set([2035, 2037]) }));
    assert.equal(adapter.figure.capture().capture.realHours, 8760 + 8760, 'only the years drawn');
    let figure = figureOf(adapter);
    assert.equal(
      figure.caption,
      'Hourly Area Load for SAMPLE_AREA, Case SAMPLE_CASEM, years 2035 and 2037 overlaid.',
    );
    // The caption's hour filter, as the section hands it: the overlay names
    // the kept years, so the Years filter is not said again.
    const filters = {
      years: new Set([2035, 2037]),
      dates: null,
      hoursOfDay: new Set([5]),
      daysOfWeek: null,
      seasons: null,
      tou: null,
    };
    const shot = adapter.figure.capture();
    assert.deepEqual(shot.shown, { wholeYear: false, yearsOverlaid: true });
    const hourFilter = filtersLabel(figureFilters(filters, shot.shown));
    assert.equal(hourFilter, 'Hour (HE): 5');
    assert.equal(
      buildFigure({
        ...shot.capture,
        hourFilter,
        size: FIGURE_SIZES.half,
        measureText: (text, pt) => text.length * pt * 0.5,
      }).caption,
      'Hourly Area Load for SAMPLE_AREA, Case SAMPLE_CASEM, years 2035 and 2037 overlaid; ' +
        'hours: Hour (HE): 5.',
    );
    const spanShot = drawn(
      createTimeAdapter,
      frameFor([line], { years: filters.years }),
    ).adapter.figure.capture();
    assert.equal(
      filtersLabel(figureFilters(filters, spanShot.shown)),
      'Years: 2035, 2037 · Hour (HE): 5',
      'off the overlay the Years filter is named',
    );

    // January: 744 hours in each of the two years.
    plot.setScale('x', { min: -0.5, max: 744 - 0.5 });
    figure = figureOf(adapter);
    assert.deepEqual(
      figure.texts.filter((t) => t.id.startsWith('footnote[')).map((t) => t.text),
      ['Hours shown: 1,488 of 17,520 hours'],
    );
  },
);

await check('(k) the overview strip under an overlay is its one slot, a trace per year', () => {
  const { host } = stubHost();
  host.controls.overview.checked = true;
  host.controls.overlayYears.checked = true;
  const strip = host.controls.overviewHost;
  strip.rect = { left: 0, width: 400, height: 56 };
  const line = lineOf('SAMPLE_CASEM', 2035, 3);
  const lines = [line];
  createTimeAdapter(host).draw({
    ...frameFor(lines, { overview: () => lines }),
    wholeYear: () => lines,
  });
  const svg = strip.children[0];
  const traces = ofKind(svg, 'path', (a) => a.fill === 'none');
  assert.deepEqual(
    traces.map((node) => node.attributes.stroke),
    [0, 1, 2].map((i) => shade(line.color, i, 3)),
  );
  close(traceXs(svg).at(-1), px(366 - 0.5, 366));
  assert.ok(
    ofKind(svg, 'text').every((n) => !/20\d\d/.test(n.textContent)),
    'no year named',
  );
});

console.log(`\n${passed} checks passed`);
