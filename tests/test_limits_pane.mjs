// tests/test_limits_pane.mjs — drawn-limit properties, run through each
// chart type's adapter against the fake DOM, with the uPlot types over
// tests/test_fixtures_uplot.mjs:
//
//   (a) A limit is not a `CaseSeries`, so it stays out of the legend, stats,
//       box and X-Y panes and the ten-line cap.
//   (b) Its dash differs from the preview's.
//   (c) Limits are in the pane signature, so toggling rebuilds the plot.
//   (d) Time pane only (the duration curve's x is a rank).

import './test_loader.mjs';
import './test_fixtures_uplot.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plots } from './test_fixtures_uplot.mjs';
import { installFakeDom, stubHost, frameOf } from './test_fixtures_dom.mjs';

installFakeDom();
const line = await import('../src/ui/panes/line.ts');
const { createBoxAdapter } = await import('../src/ui/panes/box.ts');
const { createXyAdapter } = await import('../src/ui/panes/xy.ts');
const { createHeatmapAdapter } = await import('../src/ui/panes/heatmap.ts');
const { createIntervalAdapter } = await import('../src/ui/panes/interval.ts');
const { createLegendAdapter } = await import('../src/ui/panes/legend.ts');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const charts = readFileSync(join(root, 'src/ui/charts.ts'), 'utf8');

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`ok - ${label}`);
}

const { YEAR_SLOT_HOURS: HOURS } = await import('../src/model/calendar.ts');
/** A drawn series with everything any adapter reads. */
function seriesOf(name, color, at = (hour) => hour % 100, extra = {}) {
  const values = Float32Array.from({ length: HOURS }, (_, hour) => at(hour));
  const sorted = Float32Array.from(values).sort();
  return {
    name,
    color,
    unit: 'MW',
    values,
    sorted,
    n: HOURS,
    stats: { mean: 49.5, sd: 1, min: sorted[0], max: sorted[HOURS - 1] },
    warnings: [],
    ...extra,
  };
}
const limitOf = (name, color, value = 500) => ({
  name,
  color,
  unit: 'MW',
  values: new Float32Array(HOURS).fill(value),
});

const LOAD = seriesOf('SAMPLE Load', '#1f77b4');
const FLOW = seriesOf('SAMPLE Flow', '#ff7f0e', (hour) => (hour * 7) % 90);
const LIMIT = limitOf('SAMPLE Flow max', '#ff7f0e');
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
/** What a box pane cuts the two lines into, and what the interval pane
 * reads the year from: enough for every canvas type to draw. */
const DRAWN = {
  spanOf: () => ({ firstYear: 2031, numYears: 1 }),
  boxes: () => [
    {
      label: 'SAMPLE group',
      boxes: [LOAD, FLOW].map((s) => ({ ...s, quantiles: QUANTILES })),
    },
  ],
};

/** Every adapter, keyed by chart type. */
const FACTORIES = {
  time: line.createTimeAdapter,
  duration: line.createDurationAdapter,
  stacked: line.createStackedAdapter,
  box: createBoxAdapter,
  xy: createXyAdapter,
  heatmap: createHeatmapAdapter,
  interval: createIntervalAdapter,
  legend: createLegendAdapter,
};

/** A host the interval pane can draw on too: its colour select lists the
 * three options index.html gives it. */
function hostFor() {
  const made = stubHost();
  made.host.controls.intervalColour.options = ['time', 'weekday', 'month'].map((value) => ({
    value,
    disabled: false,
  }));
  return made;
}

/** What one adapter drew for `frame`: the plots it built, its canvas calls,
 * its legend rows, its banners and notes. */
function drawnBy(type, frame) {
  const { host, record } = hostFor();
  const adapter = FACTORIES[type](host);
  plots.length = 0;
  adapter.draw(frame);
  return {
    plots: plots.map((plot) => plot.series.slice(1).map((s) => s.label)),
    canvas: JSON.stringify(host.canvas.context.calls),
    legend: host.legendHost.querySelectorAll('.pane-legend-label').map((node) => node.textContent),
    record: JSON.stringify(record),
  };
}

check('(a) a limit is its own type, and is never pushed into the series array', () => {
  assert.match(charts, /export interface DrawnLimit \{/);
  assert.match(charts, /limits\?: DrawnLimit\[\];/, 'ChartsInput carries them separately');
  for (const type of Object.keys(FACTORIES)) {
    const series = [LOAD, FLOW];
    const frame = frameOf(series, { ...DRAWN, limits: [LIMIT] });
    drawnBy(type, frame);
    assert.deepEqual(
      frame.input.series,
      [LOAD, FLOW],
      `the ${type} pane leaves the series array as it was handed -- a limit that arrived ` +
        'there would reach the legend, the stats table and the ten-line cap',
    );
    assert.deepEqual(frame.drawable, [LOAD, FLOW], `and the ${type} pane's drawn set too`);
  }
});

check('(b) the limit dash exists and is not the preview dash', () => {
  const preview = { ...FLOW, name: 'SAMPLE preview', dashed: true };
  const { host } = hostFor();
  plots.length = 0;
  line.createTimeAdapter(host).draw(frameOf([LOAD, preview], { limits: [LIMIT] }));
  const [, solid, dashed, limit] = plots[0].series;
  assert.equal(solid.dash, undefined, 'a pinned line is solid');
  assert.ok(Array.isArray(dashed.dash), 'the preview is dashed');
  assert.ok(Array.isArray(limit.dash), 'a limit is dashed');
  assert.notDeepEqual(
    limit.dash,
    dashed.dash,
    'a limit drawn in the preview’s dash makes a pinned line read as a hover preview',
  );
  assert.equal(limit.stroke, FLOW.color, 'in exactly the colour of the line it bounds');
  assert.equal(limit.points.show, false, 'and with no point markers');
});

check('(c) the limits are part of the time pane’s rebuild signature', () => {
  const { host } = hostFor();
  const time = line.createTimeAdapter(host);
  plots.length = 0;
  time.draw(frameOf([LOAD, FLOW], { limits: [LIMIT] }));
  assert.deepEqual(
    plots.map((plot) => plot.series.length - 1),
    [3],
    'two lines and one limit line',
  );
  time.draw(frameOf([LOAD, FLOW], { limits: [LIMIT] }));
  assert.equal(plots.length, 1, 'an unchanged frame updates the plot in place');
  time.draw(frameOf([LOAD, FLOW], { limits: [limitOf('SAMPLE Load max', '#1f77b4')] }));
  assert.equal(
    plots.length,
    2,
    'a different limit of the same count rebuilds: the signature varies with the limits, or ' +
      'a swapped limit keeps the old one’s colour and name',
  );
  assert.ok(plots[0].destroyed, 'and takes the old plot down');
  host.controls.limits.checked = false;
  time.draw(frameOf([LOAD, FLOW], { limits: [LIMIT] }));
  assert.equal(plots.length, 3, 'unticking the limits rebuilds the plot');
  assert.equal(
    plots[2].series.length - 1,
    2,
    'without the limit line, or a toggled-off limit stays on the canvas',
  );
});

check('(d) limits are drawn on the time pane and on no other', () => {
  const withLimits = frameOf([LOAD, FLOW], { ...DRAWN, limits: [LIMIT] });
  const without = frameOf([LOAD, FLOW], DRAWN);
  assert.deepEqual(drawnBy('time', withLimits).plots, [
    ['SAMPLE Load', 'SAMPLE Flow', 'SAMPLE Flow max'],
  ]);
  for (const type of ['duration', 'stacked', 'box', 'xy', 'heatmap', 'interval', 'legend']) {
    const drawn = drawnBy(type, withLimits);
    assert.ok(
      drawn.plots.length + drawn.legend.length > 0 || drawn.canvas !== '[]',
      `the ${type} pane drew something to compare`,
    );
    assert.ok(!/refusal/.test(drawn.record), `the ${type} pane drew rather than refused`);
    assert.deepEqual(
      drawn,
      drawnBy(type, without),
      `the ${type} pane must draw the same with limits as without -- see this file's header ` +
        'for why',
    );
  }
});

check('the toggle gates the drawing, and no limit takes an extreme marker', () => {
  const { host } = hostFor();
  host.controls.limits.checked = false;
  plots.length = 0;
  line.createTimeAdapter(host).draw(frameOf([FLOW], { limits: [LIMIT] }));
  assert.equal(
    plots[0].series.length - 1,
    1,
    'each time pane’s own checkbox decides whether it draws any limit',
  );

  const ticked = hostFor().host;
  plots.length = 0;
  const peaked = limitOf('SAMPLE peaked max', '#ff7f0e');
  peaked.values[10] = 900;
  line.createTimeAdapter(ticked).draw(frameOf([FLOW], { limits: [peaked] }));
  const plot = plots[0];
  const marks = [];
  const ctx = {
    fillStyle: '',
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    fill() {},
    stroke() {},
    arc(x) {
      marks.push({ at: x, colour: ctx.fillStyle });
    },
  };
  const self = {
    ...plot,
    ctx,
    bbox: { left: 0, top: 0, width: 400, height: 300 },
    scales: { x: { min: 0, max: HOURS - 1 } },
    series: plot.series,
    valToPos: (value) => value,
  };
  for (const hook of plot.options.hooks.draw) hook(self);
  assert.equal(marks.length, 2, 'the line gets its highest and lowest point marked');
  assert.ok(
    marks.every((mark) => mark.colour === FLOW.color),
    'and the limit none: the highest point of a limit is not a reading',
  );
});

console.log(`\n${passed} checks passed`);
