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
//       left out.

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
  `${hourLabel(4403)} (Hour 4404)`,
  'tooltip reflects the mid-slot midday hour, index 4403',
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

console.log(
  'ok - diurnal heatmap: SlotType registration, hand-drawn uPlot-free canvas, color palettes, 8,784 geometry, interactive hover inspection and its figure',
);
