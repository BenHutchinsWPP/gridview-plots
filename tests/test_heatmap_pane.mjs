// tests/test_heatmap_pane.mjs
//
// The 24x366 diurnal heatmap chart type. Its adapter, src/ui/panes/heatmap.ts,
// loads under Node, so it is run here against a fake DOM: colour mapping,
// calendar geometry, hover hit-testing and its Figure are proven through
// the adapter's own interface. src/ui/charts.ts cannot load (it imports
// uPlot and a CSS file), so the type list is read as source text.
//
// The assertions:
//   (a) 'heatmap' is a SlotType, all four pane selects offer it, and the
//       host maps it to this adapter;
//   (b) hand-drawn: the adapter draws on the pane's canvas surface, never
//       uPlot's (the pane showing that surface is tests/test_panes.mjs);
//   (c) no series at all is the pane's shared empty text
//       (tests/test_panes.mjs), and a series with no finite value is refused
//       by name;
//   (d) color palette mathematics: smooth viridis interpolation for
//       sequential quantities and cool-warm with centered zero for diverging;
//   (e) calendar arithmetic: the 8,784-hour slot mapped to 366 days x 24
//       hours, a non-leap year's Feb 29 column blank;
//   (f) hover interaction: hit-testing resolves the correct day, hour, and value;
//   (g) the Figure takes the painted series first and names the rest as
//       left out;
//   (h) a Case over several years is a band per year, first on top, each
//       labelled and on one colour scale; hover names the year, the Years
//       filter chooses the bands, and too many for the pane is refused.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Loader shim for extensionless relative imports under Node ESM
import './test_loader.mjs';
import { installFakeDom, stubHost, frameOf } from './test_fixtures_dom.mjs';

installFakeDom();
const { createHeatmapAdapter, heatmapScale, viridisColor, coolwarmColor, HEATMAP_EMPTY } =
  await import('../src/ui/panes/heatmap.ts');
import { YEAR_SLOT_HOURS } from '../src/model/calendar.ts';
const { hourLabel } = await import('../src/ui/chart-format.ts');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8');

const charts = read('src/ui/charts.ts');
const html = read('index.html');

// ------------------------------------------------------------------- (a)
assert.match(
  charts,
  /export type SlotType =[^;]*'heatmap'/,
  "'heatmap' is a declared SlotType in src/ui/charts.ts",
);

const heatmapOptions = [...html.matchAll(/<option value="heatmap">/g)];
assert.equal(heatmapOptions.length, 4, 'all four pane selects offer the Diurnal heatmap slot');
assert.match(charts, /heatmap: createHeatmapAdapter,/, 'the host draws a heatmap pane with it');

// ------------------------------------------------------------------- (b)
const { host, record } = stubHost();
const heatmap = createHeatmapAdapter(host);
assert.equal(heatmap.surface, 'canvas', 'heatmap draws on the shared canvas rather than uPlot');
assert.deepEqual(heatmap.controls(frameOf([])), [], 'and shows no header control of its own');
// ------------------------------------------------------------------- (d) Color palette math
// Sequential viridis: 0 -> deep purple, 1 -> bright yellow
assert.equal(viridisColor(0), 'rgb(68,1,84)', 'viridis starts at purple at t=0');
assert.equal(viridisColor(1), 'rgb(253,231,37)', 'viridis ends at yellow at t=1');
assert.equal(viridisColor(0.5), 'rgb(33,145,140)', 'viridis hits teal midpoint at t=0.5');

// Diverging cool-warm: 0 -> blue, 0.5 -> neutral off-white, 1 -> coral red
assert.equal(coolwarmColor(0), 'rgb(33,102,172)', 'coolwarm starts at blue for negative extremes');
assert.equal(
  coolwarmColor(0.5),
  'rgb(247,247,247)',
  'coolwarm centers at neutral off-white for zero',
);
assert.equal(coolwarmColor(1), 'rgb(178,24,43)', 'coolwarm ends at red for positive extremes');

// Clamping checks
assert.equal(viridisColor(-0.5), viridisColor(0), 'viridis clamps underflow to t=0');
assert.equal(viridisColor(1.5), viridisColor(1), 'viridis clamps overflow to t=1');
assert.equal(coolwarmColor(-10), coolwarmColor(0), 'coolwarm clamps underflow to t=0');
assert.equal(coolwarmColor(10), coolwarmColor(1), 'coolwarm clamps overflow to t=1');

// ------------------------------------------------------------------- (e) Calendar & stubbed render
// A synthetic slot of a non-leap year: Feb 29 (hours 1416-1439) is NaN.
const testValues = new Float64Array(YEAR_SLOT_HOURS);
for (let i = 0; i < YEAR_SLOT_HOURS; i++) {
  // Peak midday (hours 11..15), low at night
  const hourOfDay = i % 24;
  testValues[i] = hourOfDay >= 9 && hourOfDay <= 16 ? 100 + hourOfDay * 10 : 10;
}
testValues.fill(NaN, 1416, 1440);

const testSeries = {
  name: 'Test Solar',
  unit: 'MW',
  color: '#ff7f0e',
  values: testValues,
  warnings: [],
  stats: { mean: 50, sd: 20, min: 10, max: 260 },
  n: YEAR_SLOT_HOURS - 24,
  allZero: false,
};
const otherSeries = { ...testSeries, name: 'Test Wind', color: '#1f77b4' };

const scale = heatmapScale(testValues);
assert.equal(scale.diverging, false, 'strictly positive series detected as sequential');
assert.equal(scale.min, 10, 'min recovered from values');
assert.equal(scale.max, 260, 'max recovered from values');

heatmap.draw(frameOf([testSeries, otherSeries]));
assert.deepEqual(
  record.notes,
  ['Test Solar (1 of 2)'],
  'the header names which of the drawn series it painted',
);
assert.equal(host.canvas.style.display, '', 'a drawn heatmap shows its canvas');

// In 8,784 cells, each cell gets a fillRect call (plus the colorbar fillRect)
const fillRects = host.canvas.context.calls.filter((c) => c.op === 'fillRect');
assert.equal(fillRects.length, YEAR_SLOT_HOURS + 1, 'exactly 8,784 cells plus 1 colorbar drawn');
// Cells are drawn a day column at a time, 24 to a day: column 59 is Feb 29,
// and Dec 31 ends at the plot's right edge.
const last = fillRects[YEAR_SLOT_HOURS - 1];
assert.equal(last.x + last.w, 34 + 400 - 34 - 78, 'day 365 is the last column');
const feb29 = fillRects.slice(59 * 24, 60 * 24);
assert.ok(
  feb29.every((c) => c.fill === HEATMAP_EMPTY),
  'a non-leap year’s Feb 29 column is blank',
);
assert.ok(fillRects.slice(58 * 24, 59 * 24).every((c) => c.fill !== HEATMAP_EMPTY));
assert.ok(fillRects.slice(60 * 24, 61 * 24).every((c) => c.fill !== HEATMAP_EMPTY));

// ------------------------------------------------------------------- (f) Hover test
// The plot box a 400 x 300 pane leaves: margins 34 left, 22 top, 36 bottom,
// 78 right for the colour bar.
const geom = { marginLeft: 34, marginTop: 22, plotWidth: 400 - 34 - 78, plotHeight: 300 - 22 - 36 };
const testPx = geom.marginLeft + Math.round(geom.plotWidth / 2); // mid-slot (day 183, Jul 2)
const testPy = geom.marginTop + Math.round(geom.plotHeight / 2); // ~midday (HE 12)

const tip = host.tip;
heatmap.hover(testPx, testPy);
assert.equal(tip.style.display, '', 'hover inside plot bounds displays tooltip');
assert.ok(tip.children.length >= 2, 'tooltip populates header and row content');
assert.equal(
  tip.children[0].textContent,
  hourLabel(4403),
  'tooltip names the mid-slot midday hour, index 4403, by its date alone',
);

// Test hover outside the plot area
heatmap.hover(0, 0);
assert.equal(tip.style.display, 'none', 'hover outside plot bounds hides tooltip');

// ------------------------------------------------------------------- (g) Figure
const shot = heatmap.figure.capture();
assert.equal(shot.capture.pane, 'heatmap');
assert.deepEqual(
  shot.capture.lines.map((line) => [line.name, line.values === null, line.refusal]),
  [
    ['Test Solar', false, undefined],
    ['Test Wind', true, 'A heatmap paints one series.'],
  ],
  'the painted series first, the other drawn series named as left out',
);
assert.notEqual(shot.capture.lines[0].values, testValues, 'the values are a copy');

// ------------------------------------------------------------------- (c) Refusal
const blank = {
  ...testSeries,
  name: 'Test Blank',
  values: new Float64Array(YEAR_SLOT_HOURS).fill(NaN),
};
heatmap.draw(frameOf([blank]));
assert.deepEqual(record.banners.at(-1), {
  kind: 'refusal',
  text: 'All values in Test Blank are blank or non-finite.',
});
assert.equal(host.canvas.style.display, 'none', 'a refused heatmap hides its canvas');
assert.equal(heatmap.figure.capture(), null, 'and offers nothing to capture');

// Leaving the type releases the shared canvas: a hover finds no heatmap.
heatmap.draw(frameOf([testSeries]));
heatmap.leave();
heatmap.hover(testPx, testPy);
assert.equal(tip.style.display, 'none', 'after leave() the heatmap answers no hover');
assert.equal(heatmap.figure.capture(), null);

// ------------------------------------------------------------------- (h) Stacked years
// One line over 2035-2037: hour of day plus ten a year, so a value recurs
// in another year's band at another hour. 2035 and 2037 are non-leap.
const spanValues = new Float32Array(3 * YEAR_SLOT_HOURS);
for (let i = 0; i < spanValues.length; i++) {
  spanValues[i] = (i % 24) + 10 * Math.floor(i / YEAR_SLOT_HOURS);
}
for (const year of [0, 2])
  spanValues.fill(NaN, year * YEAR_SLOT_HOURS + 1416, year * YEAR_SLOT_HOURS + 1440);
const spanSeries = { ...testSeries, name: 'Test Span', values: spanValues };
const spanInput = (over = {}) => ({ spanOf: () => ({ firstYear: 2035, numYears: 3 }), ...over });

{
  const { host, record } = stubHost();
  const pane = createHeatmapAdapter(host);
  pane.draw(frameOf([spanSeries], spanInput()));
  assert.deepEqual(record.banners, [], 'three years fit a 300px pane');
  const cells = host.canvas.context.calls.filter((c) => c.op === 'fillRect');
  assert.equal(cells.length, 3 * YEAR_SLOT_HOURS + 1, 'three bands of 8,784 cells, one colour bar');
  const texts = host.canvas.context.calls.filter((c) => c.op === 'fillText').map((c) => c.text);
  for (const year of ['2035', '2036', '2037']) assert.ok(texts.includes(year), `labelled ${year}`);
  const band = (b) => cells.slice(b * YEAR_SLOT_HOURS, (b + 1) * YEAR_SLOT_HOURS);
  const feb29 = (b) => band(b).slice(59 * 24, 60 * 24);
  assert.ok(
    feb29(0).every((c) => c.fill === HEATMAP_EMPTY),
    '2035’s Feb 29 is blank',
  );
  assert.ok(
    feb29(1).every((c) => c.fill !== HEATMAP_EMPTY),
    '2036’s Feb 29 is drawn',
  );
  assert.ok(
    feb29(2).every((c) => c.fill === HEATMAP_EMPTY),
    '2037’s Feb 29 is blank',
  );
  const tops = band(0).map((c) => c.y);
  assert.ok(Math.max(...tops) < Math.min(...band(1).map((c) => c.y)), '2035 above 2036');
  // Cells go a day at a time from HE 24 down: index 23 - h is hour h.
  const cellOf = (b, day, h) => band(b)[day * 24 + 23 - h];
  assert.equal(
    cellOf(0, 0, 15).fill,
    cellOf(1, 0, 5).fill,
    'one colour scale: 15 is one colour in 2035 and in 2036',
  );
  assert.equal(cellOf(2, 0, 23).fill, viridisColor(1), 'the top of the scale is 2037’s peak');
  assert.notEqual(cellOf(0, 0, 23).fill, viridisColor(1), 'not each band’s own peak');

  // The bands of a 400 x 300 pane: 71.3px each under a 14px label gap.
  const bandHeight = (242 - 2 * 14) / 3;
  const px = 34 + Math.round(288 / 2);
  pane.hover(px, Math.round(22 + bandHeight + 14 + bandHeight / 2));
  assert.equal(host.tip.children[0].textContent, hourLabel(4403, 2036), 'hover names the year');
  assert.match(host.tip.children[0].textContent, /^2036 Jul 2 · HE 12$/);
  pane.hover(px, Math.round(22 + 2 * (bandHeight + 14) + 1));
  assert.match(host.tip.children[0].textContent, /^2037 Jul 2 · HE 24$/);
  pane.hover(px, Math.round(22 + bandHeight + 7));
  assert.equal(host.tip.style.display, 'none', 'a label gap holds no hour');

  const { capture } = pane.figure.capture();
  assert.deepEqual(capture.years, [2035, 2036, 2037], 'the figure stacks the same years');
  assert.equal(capture.lines[0].values.length, 3 * YEAR_SLOT_HOURS);
  assert.equal(capture.realHours, 8760 + 8784 + 8760, 'out of the real hours of those years');
}

{
  // The Years filter chooses the bands; the one kept still names its year.
  const { host, record } = stubHost();
  const pane = createHeatmapAdapter(host);
  pane.draw(frameOf([spanSeries], spanInput({ years: new Set([2036]) })));
  assert.deepEqual(record.banners, []);
  const cells = host.canvas.context.calls.filter((c) => c.op === 'fillRect');
  assert.equal(cells.length, YEAR_SLOT_HOURS + 1, 'one band for one kept year');
  const texts = host.canvas.context.calls.filter((c) => c.op === 'fillText').map((c) => c.text);
  assert.ok(texts.includes('2036') && !texts.includes('2035') && !texts.includes('2037'));
  pane.hover(testPx, testPy);
  assert.equal(host.tip.children[0].textContent, hourLabel(4403, 2036));
  const { capture } = pane.figure.capture();
  assert.deepEqual(capture.years, [2036]);
  assert.equal(capture.realHours, 8784);
  assert.deepEqual(capture.lines[0].values, spanValues.slice(YEAR_SLOT_HOURS, 2 * YEAR_SLOT_HOURS));
}

{
  // Ten years leave a 300px pane under a pixel an hour: refused, by banner.
  const { host, record } = stubHost();
  const pane = createHeatmapAdapter(host);
  const ten = { ...spanSeries, values: new Float32Array(10 * YEAR_SLOT_HOURS).fill(1) };
  pane.draw(frameOf([ten], { spanOf: () => ({ firstYear: 2035, numYears: 10 }) }));
  assert.equal(record.banners.length, 1);
  assert.equal(record.banners[0].kind, 'refusal');
  assert.match(record.banners[0].text, /^10 years of Test Span do not fit this pane/);
  assert.match(record.banners[0].text, /Years filter/);
  assert.equal(host.canvas.style.display, 'none');
  assert.equal(pane.figure.capture(), null, 'and offers no figure');
  pane.draw(
    frameOf([ten], {
      spanOf: () => ({ firstYear: 2035, numYears: 10 }),
      years: new Set([2036, 2037]),
    }),
  );
  assert.equal(record.banners.length, 1, 'two kept years fit');
}

{
  // A one-year Case with a year names it on hover and draws no band label.
  const { host } = stubHost();
  const pane = createHeatmapAdapter(host);
  pane.draw(frameOf([testSeries], { spanOf: () => ({ firstYear: 2035, numYears: 1 }) }));
  const texts = host.canvas.context.calls.filter((c) => c.op === 'fillText').map((c) => c.text);
  assert.ok(!texts.includes('2035'), 'one year, one unlabelled band');
  pane.hover(testPx, testPy);
  assert.equal(host.tip.children[0].textContent, hourLabel(4403, 2035));
  assert.equal(pane.figure.capture().capture.years, undefined);
}

console.log(
  'ok - diurnal heatmap: SlotType registration, hand-drawn uPlot-free canvas, color palettes, 8,784 geometry, interactive hover inspection and its figure',
);
