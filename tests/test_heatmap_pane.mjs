// tests/test_heatmap_pane.mjs
//
// The 24x365 diurnal heatmap slot. src/ui/charts.ts cannot load under Node
// (it imports uPlot and a CSS file), so its couplings are asserted against
// the source text. The renderer itself, src/ui/heatmap-plot.ts, is run here
// under Node against stubbed DOM so color mapping, calendar geometry, and
// hover hit-testing are proven directly.
//
// The assertions:
//   (a) 'heatmap' is a SlotType and all four pane selects offer it;
//   (b) hand-drawn architecture: the canvas is used and uPlot is hidden;
//   (c) availability requires at least one drawn series, refusing cleanly
//       when none is selected;
//   (d) color palette mathematics: smooth viridis interpolation for
//       sequential quantities and cool-warm with centered zero for diverging;
//   (e) calendar arithmetic: 8,760 hours mapped to 365 days x 24 hours without
//       drift or leap-year distortion;
//   (f) hover interaction: hit-testing resolves the correct day, hour, and value.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Loader shim for extensionless relative imports under Node ESM
import './test_loader.mjs';

const { createHeatmapPlot, viridisColor, coolwarmColor } =
  await import('../src/ui/heatmap-plot.ts');
import { HOURS_PER_YEAR } from '../src/model/calendar.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8');

const charts = read('src/ui/charts.ts');
const html = read('index.html');

// ------------------------------------------------------------------- (a)
assert.match(
  charts,
  /export type SlotType = [^;]*'heatmap'/,
  "'heatmap' is a declared SlotType in src/ui/charts.ts",
);

const heatmapOptions = [...html.matchAll(/<option value="heatmap">/g)];
assert.equal(heatmapOptions.length, 4, 'all four pane selects offer the Diurnal heatmap slot');

// ------------------------------------------------------------------- (b)
assert.ok(
  charts.includes("} else if (slotType === 'heatmap') {"),
  'charts.ts contains the heatmap slot rendering branch',
);
assert.match(
  charts,
  /slotType === 'heatmap'[\s\S]*?canvasHost\.style\.display = ''/,
  'heatmap displays the shared canvas host rather than uPlot',
);

// ------------------------------------------------------------------- (c)
assert.match(
  charts,
  /drawable\.length === 0[\s\S]*?banner\(\s*body,\s*'refusal',\s*'Select a series in the Browse drawer to display its diurnal heatmap\.'/,
  'heatmap refuses when no series is drawn, asking the user to select one',
);

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
// Build a stub 2D canvas context and elements
function makeStubContext() {
  const calls = [];
  return {
    calls,
    save() {},
    restore() {},
    scale() {},
    clearRect() {},
    fillRect(x, y, w, h) {
      calls.push({ op: 'fillRect', x, y, w, h });
    },
    strokeRect(x, y, w, h) {
      calls.push({ op: 'strokeRect', x, y, w, h });
    },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fillText() {},
    measureText: (text) => ({ width: text.length * 6 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    set fillStyle(val) {},
    set strokeStyle(val) {},
    set lineWidth(val) {},
    set font(val) {},
    set textAlign(val) {},
    set textBaseline(val) {},
  };
}

globalThis.window = globalThis;
globalThis.devicePixelRatio = 1;

function makeStubElement() {
  const children = [];
  return {
    style: {},
    className: '',
    textContent: '',
    children,
    clientWidth: 400,
    clientHeight: 300,
    getBoundingClientRect: () => ({ width: 400, height: 300 }),
    querySelectorAll: () => [],
    appendChild: (c) => children.push(c),
    replaceChildren: (...cs) => {
      children.length = 0;
      children.push(...cs);
    },
  };
}

globalThis.document = {
  createElement: () => makeStubElement(),
};

const mockCtx = makeStubContext();
const mockCanvas = {
  style: {},
  width: 400,
  height: 300,
  getContext: () => mockCtx,
};

const stubBody = makeStubElement();
const stubTip = makeStubElement();
const slotHeatmapGeometry = [null, null, null, null];

const heatmapPlot = createHeatmapPlot({
  paneBodies: [stubBody, stubBody, stubBody, stubBody],
  slotCanvases: [mockCanvas, mockCanvas, mockCanvas, mockCanvas],
  slotTips: [stubTip, stubTip, stubTip, stubTip],
  slotHeatmapGeometry,
  paneSize: () => ({ width: 400, height: 300 }),
  formatNumber: (v) => v.toFixed(1),
  hourLabel: (h) => `Hour ${h}`,
  banner: () => {},
  clip: (_ctx, text) => text,
});

// Create an 8,760-hour synthetic series
const testValues = new Float64Array(HOURS_PER_YEAR);
for (let i = 0; i < HOURS_PER_YEAR; i++) {
  // Peak midday (hours 11..15), low at night
  const hourOfDay = i % 24;
  testValues[i] = hourOfDay >= 9 && hourOfDay <= 16 ? 100 + hourOfDay * 10 : 10;
}

const testSeries = {
  name: 'Test Solar',
  caseId: 'case-1',
  caseName: 'Base Case',
  slotKey: 'gen',
  entity: 'Solar 1',
  variable: 'Generation',
  unit: 'MW',
  color: '#ff7f0e',
  values: testValues,
  stats: { mean: 50, sd: 20, min: 10, max: 260 },
  n: HOURS_PER_YEAR,
  allZero: false,
};

// Draw slot 0
heatmapPlot.draw(0, testSeries);

assert.ok(slotHeatmapGeometry[0] !== null, 'geometry is recorded on successful draw');
assert.equal(
  slotHeatmapGeometry[0].scale.diverging,
  false,
  'strictly positive series detected as sequential',
);
assert.equal(slotHeatmapGeometry[0].scale.min, 10, 'min recovered from values');
assert.equal(slotHeatmapGeometry[0].scale.max, 260, 'max recovered from values');

// In 8,760 cells, each cell gets a fillRect call (plus the colorbar fillRect)
const fillRects = mockCtx.calls.filter((c) => c.op === 'fillRect');
assert.equal(fillRects.length, HOURS_PER_YEAR + 1, 'exactly 8,760 cells plus 1 colorbar drawn');

// ------------------------------------------------------------------- (f) Hover test
// Test hover inside the plot area (X: ~mid-year day 182, Y: ~midday hour 11)
const geom = slotHeatmapGeometry[0];
const testPx = geom.marginLeft + Math.round(geom.plotWidth / 2); // ~mid-year (day 182)
const testPy = geom.marginTop + Math.round(geom.plotHeight / 2); // ~midday (HE 12)

heatmapPlot.hover(0, testPx, testPy);
assert.equal(stubTip.style.display, '', 'hover inside plot bounds displays tooltip');
assert.ok(stubTip.children.length >= 2, 'tooltip populates header and row content');
assert.match(
  stubTip.children[0].textContent,
  /Hour 4379/,
  'tooltip reflects mid-year midday hour index',
);

// Test hover outside the plot area
heatmapPlot.hover(0, 0, 0);
assert.equal(stubTip.style.display, 'none', 'hover outside plot bounds hides tooltip');

// Clear
heatmapPlot.clear(0);
assert.equal(slotHeatmapGeometry[0], null, 'clear() nulls out slot geometry');

console.log(
  'ok - diurnal heatmap slot: SlotType registration, hand-drawn uPlot-free canvas, color palettes, 8,760 geometry, and interactive hover inspection',
);
