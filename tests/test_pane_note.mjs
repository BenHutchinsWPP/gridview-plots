// tests/test_pane_note.mjs — what a pane header may say. One section's panes
// draw every kind, so a header says only what its SLOT knows. Every chart
// type's adapter is run against the fake DOM (the uPlot types over
// tests/test_fixtures_uplot.mjs); charts.ts, which imports a CSS file and
// resolves the template, and index.html are read as source text.
//
//   (a) nothing calls or supplies a kind-written pane note;
//   (b) every pane header is cleared on each render (tests/test_panes.mjs (f));
//   (c) only X-Y, heatmap, interval and an unfollowed time slot write one;
//   (d) every pane holds its own box dimension control, so no box pane
//       restates its dimension as a note;
//   (e) the weighted-mean qualifier is per legend row;
//   (f) the legend states the full path, not the plots' shorthand;
//   (g) an empty pane names the missing step (`emptyPaneText`): a file with
//       no Case, a pinned row otherwise.

import './test_loader.mjs';
import './test_fixtures_uplot.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom, stubHost, frameOf } from './test_fixtures_dom.mjs';

installFakeDom();
const line = await import('../src/ui/panes/line.ts');
const { createBoxAdapter } = await import('../src/ui/panes/box.ts');
const { createXyAdapter } = await import('../src/ui/panes/xy.ts');
const { createHeatmapAdapter } = await import('../src/ui/panes/heatmap.ts');
const { createIntervalAdapter } = await import('../src/ui/panes/interval.ts');
const { createLegendAdapter } = await import('../src/ui/panes/legend.ts');
const { contextLabel, subjectLabel } = await import('../src/series/label.ts');
const { emptyPaneText } = await import('../src/ui/chart-format.ts');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8');

const charts = read('src/ui/charts.ts');
/** Each chart type's adapter module, by the file it lives in. */
const adapters = ['pane', 'line', 'box', 'xy', 'heatmap', 'interval', 'legend']
  .map((name) => read(`src/ui/panes/${name}.ts`))
  .join('\n');
// The section and the app-wide pieces it composes around the panes.
const section = ['src/ui/section.ts', 'src/ui/filter-rail.ts', 'src/ui/pane-focus.ts']
  .map(read)
  .join('\n');
const html = read('index.html');

const { YEAR_SLOT_HOURS: HOURS } = await import('../src/model/calendar.ts');
/** A drawn series with everything any adapter reads. */
function seriesOf(name, color, extra = {}) {
  const values = Float32Array.from({ length: HOURS }, (_, hour) => hour % 100);
  const sorted = Float32Array.from(values).sort();
  return {
    name,
    color,
    unit: 'MW',
    values,
    sorted,
    n: HOURS,
    stats: { mean: 49.5, sd: 28.9, min: 0, max: 99 },
    warnings: [],
    ...extra,
  };
}
const LOAD = seriesOf('SAMPLE Load', '#1f77b4');
const FLOW = seriesOf('SAMPLE Flow', '#ff7f0e');
const QUANTILES = {
  n: HOURS,
  min: 0,
  p25: 25,
  median: 50,
  p75: 75,
  max: 99,
  lowerWhisker: 0,
  upperWhisker: 99,
  outliers: 0,
  degenerate: false,
};
/** Enough for every canvas type to draw. */
const DRAWN = {
  spanOf: () => ({ firstYear: 2031, numYears: 1 }),
  boxes: () => [
    { label: 'SAMPLE group', boxes: [LOAD, FLOW].map((s) => ({ ...s, quantiles: QUANTILES })) },
  ],
};

/** A host the interval pane can draw on too. */
function hostFor() {
  const made = stubHost();
  made.host.controls.intervalColour.options = ['time', 'weekday', 'month'].map((value) => ({
    value,
    disabled: false,
  }));
  return made;
}

// ------------------------------------------------------------------- (a)
assert.ok(
  !charts.includes('paneNote') && !section.includes('paneNote'),
  'nothing calls or supplies a kind-written pane note',
);

// ------------------------------------------------------------------- (c)
/** The header notes one adapter writes for one frame. */
function notesOf(factory, frame, setUp = () => {}) {
  const { host, record } = hostFor();
  setUp(host);
  factory(host).draw(frame);
  assert.ok(
    !record.banners.some((banner) => banner.kind === 'refusal'),
    `the pane drew rather than refused: ${JSON.stringify(record.banners)}`,
  );
  return record.notes;
}
const pair = frameOf([LOAD, FLOW], DRAWN);
for (const [type, factory] of [
  ['time', line.createTimeAdapter],
  ['duration', line.createDurationAdapter],
  ['stacked', line.createStackedAdapter],
  ['box', createBoxAdapter],
  ['legend', createLegendAdapter],
]) {
  assert.deepEqual(
    notesOf(factory, pair),
    [],
    `the ${type} slot writes no header note: it knows nothing a kind would have to tell it`,
  );
}
assert.deepEqual(
  notesOf(
    line.createTimeAdapter,
    {
      ...frameOf([LOAD], { dates: [{ start: 10, end: 12 }], overview: true }),
      wholeYear: () => [LOAD],
    },
    (host) => {
      host.controls.follow.checked = false;
    },
  ).map((text) => text.startsWith('whole year · dates ')),
  [true],
  'a time pane showing the whole year says so, since the rail says otherwise',
);
/** The unfollowed time pane's note over a three-year axis. */
function unfollowedNote(years) {
  const span = { firstYear: 2035, numYears: 3 };
  const values = new Float32Array(3 * HOURS).fill(1);
  const spanning = { ...LOAD, values, n: values.length };
  return notesOf(
    line.createTimeAdapter,
    {
      ...frameOf([spanning], {
        dates: [{ start: 10, end: 12 }],
        overview: true,
        years,
        spanOf: () => span,
        spanOfCase: () => span,
      }),
      wholeYear: () => [spanning],
    },
    (host) => {
      host.controls.follow.checked = false;
    },
  );
}
assert.deepEqual(
  unfollowedNote(new Set([2035, 2036, 2038])).map((text) => text.split(' · dates ')[0]),
  ['years 2035–2036, 2038'],
  'with a Years filter, the unfollowed pane names the years it draws',
);
assert.deepEqual(
  unfollowedNote(null).map((text) => text.split(' · dates ')[0]),
  ['every year'],
  'and says every year only when no Years filter is set',
);
assert.deepEqual(
  notesOf(createXyAdapter, pair),
  ['X SAMPLE Load / Y SAMPLE Flow'],
  'the X-Y slot names which series is on X and which on Y',
);
assert.deepEqual(
  notesOf(createHeatmapAdapter, pair),
  ['SAMPLE Load (1 of 2)'],
  'the heatmap slot names which of the drawn series it painted',
);
assert.deepEqual(
  notesOf(createIntervalAdapter, pair),
  ['SAMPLE Load (1 of 2)'],
  'the interval slot names which series it cut',
);
assert.ok(!/\bnote\(/.test(charts), 'the host writes no header note of its own');

// ------------------------------------------------------------------- (d)
for (const n of [1, 2, 3, 4]) {
  assert.match(
    html,
    new RegExp(
      `<div data-pane="${n}" class="pane">[\\s\\S]*?data-el="box-dim-select-${n}"[\\s\\S]*?<div data-pane="${n}-body"`,
    ),
    `pane ${n}'s header holds its own box dimension select`,
  );
}
// The box adapter's own silence is (c); the host is read as text.
assert.ok(!charts.includes('`by ${'), 'no box pane restates its dimension as a header note');

// ------------------------------------------------------------------- (e)
const legendHost = hostFor().host;
const legend = createLegendAdapter(legendHost);
const facets = {
  caseLabel: 'SAMPLE Case',
  kind: 'area',
  variable: 'Avg LMP ($/MWh)',
  unit: '$/MWh',
  subject: 'Northwest (2 areas)',
};
const weighted = seriesOf('Northwest', '#1f77b4', {
  facets,
  detail: 'SAMPLE Case · Area · Northwest (2 areas) · Avg LMP ($/MWh)',
  weightColumn: 'Load (MWh)',
});
legend.draw(frameOf([weighted, FLOW]));
const rows = () => legendHost.legendHost.querySelectorAll('.pane-legend-name');
const contextOf = (row) => row.querySelector('.pane-legend-context')?.textContent ?? null;
assert.equal(
  contextOf(rows()[0]),
  `${contextLabel(facets)} · weighted mean by Load (MWh)`,
  'the legend row carries the weighted-mean qualifier, beside the Mean it qualifies',
);
assert.equal(contextOf(rows()[1]), null, 'and only on the weighted row');
legend.draw(frameOf([{ ...weighted, weightColumn: 'Generation (MWh)' }, FLOW]));
assert.equal(
  contextOf(rows()[0]),
  `${contextLabel(facets)} · weighted mean by Generation (MWh)`,
  'a change in weighting alone repaints the table, so it is in the legend signature',
);

// ------------------------------------------------------------------- (f)
legend.draw(frameOf([weighted, FLOW]));
const labels = legendHost.legendHost
  .querySelectorAll('.pane-legend-label')
  .map((node) => node.textContent);
assert.deepEqual(
  labels,
  [subjectLabel(facets), 'SAMPLE Flow'],
  'the legend names the subject from the facets, falling back to the short name only ' +
    'for a series built without a browse row',
);
assert.ok(
  contextOf(rows()[0]).startsWith(contextLabel(facets)),
  'and states beneath it the Case, the kind and the quantity the subject was found on',
);
const tableRows = legendHost.legendHost.querySelectorAll('.pane-legend-name');
assert.deepEqual(
  tableRows.map((cell) => cell.parentElement.title),
  [weighted.detail, 'SAMPLE Flow'],
  "the row's own tooltip is the full label, so even a truncated cell can be read in full",
);

// ------------------------------------------------------------------- (g)
assert.doesNotMatch(
  charts + adapters,
  /Drop a CSV export to begin/,
  'no pane module spells empty-pane text of its own: its empty branch fell back to the ' +
    'empty-app sentence whether or not a Case was loaded',
);
// The pane's own empty branch is behaviour in tests/test_panes.mjs (c).
for (const hasCases of [false, true]) {
  const { host, record } = hostFor();
  const box = createBoxAdapter(host);
  const empty = frameOf([], { hasCases });
  box.draw(empty);
  box.resize();
  assert.deepEqual(
    record.banners,
    [
      { kind: 'refusal', text: emptyPaneText(empty.input) },
      { kind: 'refusal', text: emptyPaneText(empty.input) },
    ],
    'the box pane, which a resize redraws with no series at all, says the same: it said ' +
      '"Nothing to plot with these filters." with no Case loaded and with nothing pinned',
  );
}
assert.match(
  read('src/main.ts'),
  /const hasCases = caseStore\.listCases\(\)\.length > 0;\s*const frame = computeFrame\(\{[\s\S]*?\n    hasCases,/,
  'main.ts hands the frame, and so the charts, whether any Case is loaded, as a plain fact ' +
    '(behaviour: tests/test_render_frame.mjs)',
);
{
  assert.equal(
    emptyPaneText({ series: [], hasCases: false }),
    'Drop a CSV export to begin.',
    'with no Case loaded, the pane asks for a file, as it always has',
  );
  assert.equal(
    emptyPaneText({ series: [], hasCases: true }),
    'Nothing is pinned. Tick a row in the Browse drawer to draw it.',
    'with Cases loaded and nothing pinned, the pane asks for a pinned row',
  );
  assert.equal(
    emptyPaneText({ refusal: 'SAMPLE refusal', series: [], hasCases: true }),
    'SAMPLE refusal',
    'a refusal is still the answer when there is one',
  );
  assert.equal(
    emptyPaneText({ series: [{ refusal: 'SAMPLE series refusal' }], hasCases: false }),
    'SAMPLE series refusal',
    "and so is the first series' own refusal",
  );
}

console.log('test_pane_note: ok');
