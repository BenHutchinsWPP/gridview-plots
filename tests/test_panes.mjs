// tests/test_panes.mjs — a chart pane (src/ui/panes/pane.ts) run in Node
// against a fake DOM and recording adapters. A pane shows one chart type at
// a time, so:
//
//   (a) switching type tears the old adapter down before the new one draws;
//   (b) hover, leave, click, zoom reset, download and resize reach the drawn
//       adapter only, never a type that is not on screen;
//   (c) an empty frame tears the drawn type down, hides every surface and
//       says what `emptyPaneText` says, whichever type the layout names;
//   (d) the pane shows the surface its type draws on and hides the others;
//   (e) the header shows exactly the controls the type names;
//   (f) banners and the header note are cleared on every render;
//   (g) the Figure offer and capture are the type's, and a capture counts
//       out of the real hours of the Cases its drawn lines came from;
//   (h) the size a renderer paints at is the pane's box, with only a 1px
//       floor for a hidden pane;
//   (i) every type draws a Case over every year it spans and offers its
//       figure: no pane refuses a Case for its years, so pane.ts holds no
//       span check and an adapter declares nothing about one. A scatter
//       refuses only lines whose kept years cannot pair hour by hour.

import './test_loader.mjs';
import { plots } from './test_fixtures_uplot.mjs';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom, paneElements, frameOf } from './test_fixtures_dom.mjs';

installFakeDom();
const { createPane } = await import('../src/ui/panes/pane.ts');
const { figureShot } = await import('../src/ui/panes/adapter.ts');
const { createHeatmapAdapter } = await import('../src/ui/panes/heatmap.ts');
const { createTimeAdapter, createDurationAdapter, createStackedAdapter } =
  await import('../src/ui/panes/line.ts');
const { createBoxAdapter } = await import('../src/ui/panes/box.ts');
const { createXyAdapter } = await import('../src/ui/panes/xy.ts');
const { createIntervalAdapter } = await import('../src/ui/panes/interval.ts');
const { createLegendAdapter } = await import('../src/ui/panes/legend.ts');
const { emptyPaneText } = await import('../src/ui/chart-format.ts');

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`ok - ${label}`);
}

const TYPES = ['time', 'duration', 'stacked', 'box', 'xy', 'heatmap', 'interval', 'legend'];
const SURFACE = {
  time: 'uplot',
  duration: 'uplot',
  stacked: 'uplot',
  box: 'canvas',
  xy: 'canvas',
  heatmap: 'canvas',
  interval: 'canvas',
  legend: 'legend',
};
const CONTROLS = { time: ['zoom', 'download', 'dates'], box: ['box'], xy: ['xy'] };

/** A pane whose every adapter logs what the pane asks of it. */
function recordingPane(initial = 'time', overrides = {}) {
  const log = [];
  let host = null;
  const factories = Object.fromEntries(
    TYPES.map((type) => [
      type,
      (given) => {
        host = given;
        return {
          surface: SURFACE[type],
          controls: () => CONTROLS[type] ?? [],
          draw: () => {
            log.push(`${type}.draw`);
            if (type === 'xy') given.note('SAMPLE note');
            if (type === 'box') given.banner('refusal', 'SAMPLE refusal');
          },
          leave: () => log.push(`${type}.leave`),
          resize: () => log.push(`${type}.resize`),
          hover: (x, y) => log.push(`${type}.hover ${x},${y}`),
          unhover: () => log.push(`${type}.unhover`),
          click: (x, y) => log.push(`${type}.click ${x},${y}`),
          resetZoom: () => log.push(`${type}.resetZoom`),
          download: () => log.push(`${type}.download`),
          timeWindow: () => [1, 2],
          ...(type === 'legend'
            ? {}
            : {
                figure: {
                  offered: () => type !== 'duration',
                  capture: () => ({ capture: { pane: type }, shown: { wholeYear: false } }),
                },
              }),
          ...overrides[type],
        };
      },
    ]),
  );
  const elements = paneElements();
  const env = { rerender: () => log.push('rerender'), datesChange: () => {} };
  const pane = createPane(0, elements, env, factories, initial);
  const [uplot, canvasHost, legend] = elements.body.children;
  const canvas = canvasHost.children[0];
  return {
    pane,
    log,
    elements,
    host: () => host,
    surfaces: { uplot, canvas: canvasHost, legend },
    canvas,
  };
}

const SERIES = {
  name: 'SAMPLE line',
  color: '#1f77b4',
  unit: 'MW',
  values: new Float32Array(8784),
  warnings: [],
};
const drawn = frameOf([SERIES]);
const empty = frameOf([]);

check('(a) switching type leaves the old adapter before the new one draws', () => {
  const { pane, log } = recordingPane('time');
  pane.render(drawn);
  assert.deepEqual(log, ['time.draw']);
  pane.setType('xy');
  assert.deepEqual(log, ['time.draw'], 'choosing a type draws nothing until the render');
  pane.render(drawn);
  assert.deepEqual(log, ['time.draw', 'time.leave', 'xy.draw']);
  pane.render(drawn);
  assert.deepEqual(
    log.slice(3),
    ['xy.draw'],
    'a render of the same type redraws it without a teardown',
  );
});

check('(b) pointer, header buttons and resize reach the drawn adapter only', () => {
  const { pane, log, elements, canvas } = recordingPane('box');
  pane.render(drawn);
  canvas.fire('mousemove', { offsetX: 5, offsetY: 7 });
  canvas.fire('click', { offsetX: 1, offsetY: 2 });
  canvas.fire('mouseleave');
  elements.zoomReset.fire('click');
  elements.download.fire('click');
  pane.resize();
  assert.deepEqual(log, [
    'box.draw',
    'box.hover 5,7',
    'box.click 1,2',
    'box.unhover',
    'box.resetZoom',
    'box.download',
    'box.resize',
  ]);
  pane.setType('heatmap');
  pane.render(drawn);
  log.length = 0;
  canvas.fire('mousemove', { offsetX: 3, offsetY: 4 });
  pane.resize();
  assert.deepEqual(
    log,
    ['heatmap.hover 3,4', 'heatmap.resize'],
    'the box plot, sharing the canvas, hears nothing once the pane has left it',
  );
  assert.deepEqual(pane.timeWindow(), [1, 2]);
});

check('(c) an empty frame tears the type down and says what emptyPaneText says', () => {
  const { pane, log, elements, canvas, surfaces } = recordingPane('box');
  pane.render(drawn);
  pane.render(empty);
  assert.deepEqual(log, ['box.draw', 'box.leave']);
  for (const [name, surface] of Object.entries(surfaces)) {
    assert.equal(surface.style.display, 'none', `the ${name} surface is hidden`);
  }
  const refusals = elements.body.querySelectorAll('.pane-banner-refusal');
  assert.deepEqual(
    refusals.map((node) => node.textContent),
    [emptyPaneText(empty.input)],
  );
  canvas.fire('mousemove', { offsetX: 1, offsetY: 1 });
  pane.resize();
  assert.equal(pane.figure(), null, 'an empty pane has no figure');
  assert.equal(pane.timeWindow(), null);
  assert.deepEqual(log, ['box.draw', 'box.leave'], 'an empty pane routes nothing');
  pane.render(drawn);
  assert.deepEqual(log.slice(2), ['box.draw'], 'and draws its type afresh on the next frame');
});

check('(c) the heatmap, too, answers an empty selection with the shared text', () => {
  const elements = paneElements();
  const factories = Object.fromEntries(TYPES.map((type) => [type, createHeatmapAdapter]));
  const pane = createPane(0, elements, {}, factories, 'heatmap');
  pane.render(empty);
  assert.deepEqual(
    elements.body.querySelectorAll('.pane-banner-refusal').map((node) => node.textContent),
    ['Nothing is pinned. Tick a row in the Browse drawer to draw it.'],
  );
});

check('(d) the pane shows the surface its type draws on and hides the others', () => {
  const { pane, surfaces } = recordingPane('time');
  for (const type of TYPES) {
    pane.setType(type);
    pane.render(drawn);
    for (const [name, surface] of Object.entries(surfaces)) {
      assert.equal(
        surface.style.display,
        name === SURFACE[type] ? '' : 'none',
        `a ${type} pane ${name === SURFACE[type] ? 'shows' : 'hides'} the ${name} surface`,
      );
    }
  }
});

check('(e) the header shows exactly the controls the type names', () => {
  const { pane, elements } = recordingPane('xy');
  pane.showControls(drawn);
  const shown = (element) => element.style.display === '';
  assert.ok(shown(elements.xySwap) && shown(elements.xyFit.parentElement));
  for (const hidden of [
    elements.zoomReset,
    elements.download,
    elements.limits.parentElement,
    elements.follow.parentElement,
    elements.overview.parentElement,
    elements.overlayYears.parentElement,
    elements.boxDim.parentElement,
    elements.boxValues.parentElement,
    elements.intervalBy.parentElement,
    elements.intervalColour.parentElement,
    elements.intervalMean.parentElement,
    elements.intervalBand.parentElement,
  ]) {
    assert.equal(hidden.style.display, 'none');
  }
  pane.setType('time');
  pane.showControls(drawn);
  assert.ok(shown(elements.zoomReset) && shown(elements.download));
  assert.ok(shown(elements.follow.parentElement) && shown(elements.overview.parentElement));
  assert.equal(elements.xySwap.style.display, 'none');
  assert.equal(elements.limits.parentElement.style.display, 'none');
});

check('(f) banners and the header note are cleared on every render', () => {
  const { pane, elements } = recordingPane('xy');
  pane.render(drawn);
  assert.equal(elements.note.textContent, 'SAMPLE note');
  assert.equal(elements.note.title, 'SAMPLE note', 'a cut-short note reads in full on hover');
  pane.setType('box');
  pane.render(drawn);
  assert.equal(elements.note.textContent, '', 'a type with nothing to say leaves the note clear');
  assert.equal(elements.body.querySelectorAll('.pane-banner').length, 1);
  pane.render(drawn);
  assert.equal(
    elements.body.querySelectorAll('.pane-banner').length,
    1,
    'a banner lasts one render',
  );
  assert.equal(
    elements.body.querySelectorAll('.pane-banners').length,
    1,
    'every banner goes in the one out-of-flow stack',
  );
  const [stack] = elements.body.querySelectorAll('.pane-banners');
  assert.ok(
    elements.body.querySelectorAll('.pane-banner').every((node) => node.parentElement === stack),
    'and never straight into the pane body, where it would be height the canvas is sized from',
  );
});

check('(g) the Figure offer and capture are the type’s', () => {
  const { pane } = recordingPane('legend');
  pane.render(drawn);
  assert.equal(pane.figureOffered(), false, 'a legend has no figure renderer');
  assert.equal(pane.figure(), null);
  pane.setType('duration');
  pane.render(drawn);
  assert.equal(pane.figureOffered(), false, 'the type may withhold its figure');
  pane.setType('box');
  pane.render(drawn);
  assert.equal(pane.figureOffered(), true);
  assert.deepEqual(pane.figure().capture, { pane: 'box' });
});

check('(g) a capture’s hours are the most real hours of the Cases it draws', () => {
  const host = { controls: { limits: { checked: false } } };
  const of = (lines) =>
    figureShot(
      host,
      { spanOf: (series) => ({ firstYear: series.year, numYears: 1 }) },
      { pane: 'time', ordered: lines, xWindow: [0, 1] },
    ).capture.realHours;
  const year = (y, over = {}) => ({ ...SERIES, spec: { caseId: String(y) }, year: y, ...over });
  assert.equal(of([year(2031)]), 8760, 'a non-leap Case: 8,760, not the slot');
  assert.equal(of([year(2032)]), 8784, 'a leap Case');
  assert.equal(of([year(2031), year(2032)]), 8784, 'the most any drawn Case has');
  assert.equal(of([year(2031), year(2032, { values: null })]), 8760, 'a refused line counts none');
  assert.equal(of([year(2031), year(2032, { dashed: true })]), 8760, 'nor does the preview');
});

check('(h) a renderer paints at the pane’s own box, floored at 1px only', () => {
  const { elements, host } = recordingPane('time');
  elements.body.rect = { width: 399.9, height: 250.5 };
  assert.deepEqual(host().size(), { width: 399, height: 250 });
  elements.body.rect = { width: 1.7, height: 0 };
  assert.deepEqual(
    host().size(),
    { width: 1, height: 1 },
    'a hidden pane measures zero and gets the 1px guard; any larger floor is a minimum ' +
      'chart size, which draws a canvas taller than its box',
  );
});

/** Every type with its real adapter, as `ADAPTERS` in src/ui/charts.ts. */
const REAL = {
  time: createTimeAdapter,
  duration: createDurationAdapter,
  stacked: createStackedAdapter,
  box: createBoxAdapter,
  xy: createXyAdapter,
  heatmap: createHeatmapAdapter,
  interval: createIntervalAdapter,
  legend: createLegendAdapter,
};

/** A drawn line of `numYears` year slots from 2035, every hour kept. */
function spanLine(caseLabel, numYears, color = '#1f77b4') {
  const values = Float32Array.from({ length: 8784 * numYears }, (_, h) => 1 + (h % 24));
  const sorted = values.slice().sort();
  return {
    name: `${caseLabel} line`,
    color,
    unit: 'MW',
    values,
    warnings: [],
    sorted,
    n: values.length,
    stats: { n: values.length, mean: 12.5, min: 1, max: 24, sd: 6.9 },
    quantiles: {
      n: values.length,
      min: 1,
      p25: 6,
      median: 12,
      p75: 18,
      max: 24,
      lowerWhisker: 1,
      upperWhisker: 24,
      outliers: 0,
      degenerate: false,
    },
    allZero: false,
    facets: { caseLabel, kind: 'area', variable: 'Load', unit: 'MW', subject: 'SAMPLE_AREA' },
  };
}
const SPANS = { SAMPLE_CASEM: { firstYear: 2035, numYears: 3 } };
const spanFrame = (lines) =>
  frameOf(lines, {
    spanOf: (line) => SPANS[line.facets.caseLabel] ?? { firstYear: 2035, numYears: 1 },
    overview: () => lines,
    // Each line its own box, as the `case` cut gives them.
    boxes: () =>
      lines.map((line) => ({
        label: line.name,
        boxes: [{ color: line.color, name: line.name, unit: line.unit, quantiles: line.quantiles }],
      })),
  });
check('(i) every type draws a multi-year Case over its span, and offers its figure', () => {
  const oneYear = spanLine('SAMPLE_CASE1', 1);
  const threeYears = spanLine('SAMPLE_CASEM', 3, '#ff7f0e');
  for (const type of TYPES) {
    const elements = paneElements();
    elements.overview.checked = true;
    const pane = createPane(0, elements, { rerender() {}, datesChange() {} }, REAL, type);
    const refusals = () =>
      elements.body.querySelectorAll('.pane-banner-refusal').map((node) => node.textContent);
    const [uplot, canvasHost, legend] = elements.body.children;

    pane.render(spanFrame([oneYear]));
    if (type !== 'xy') assert.deepEqual(refusals(), [], `a ${type} pane draws a one-year Case`);
    const shown = { uplot, canvas: canvasHost, legend }[SURFACE[type]];
    assert.equal(shown.style.display, '', `a ${type} pane shows its surface for one year`);
    if (type === 'time') assert.equal(elements.overviewHost.hidden, false, 'and its overview');

    for (const lines of [[threeYears], [oneYear, threeYears]]) {
      const frame = spanFrame(lines);
      pane.showControls(frame);
      pane.render(frame);
      if (type === 'legend') {
        assert.deepEqual(refusals(), [], 'the legend states every year a line spans');
        assert.equal(legend.style.display, '');
        continue;
      }
      if (type === 'heatmap') {
        assert.deepEqual(refusals(), [], 'a heatmap stacks every year a line spans');
        assert.equal(canvasHost.style.display, '', 'and shows its canvas');
        assert.equal(pane.figureOffered(), true, 'and a figure of its bands');
        // It paints the first drawn line: one band for a one-year Case.
        const { capture } = pane.figure();
        const years = lines[0] === threeYears ? [2035, 2036, 2037] : undefined;
        assert.deepEqual(capture.years, years);
        assert.equal(capture.lines[0].values.length, (years?.length ?? 1) * 8784);
        continue;
      }
      if (type === 'box') {
        assert.deepEqual(refusals(), [], 'a box pane pools every year a line spans');
        assert.equal(canvasHost.style.display, '', 'and shows its canvas');
        assert.equal(pane.figureOffered(), true, 'and a figure of its boxes');
        assert.equal(pane.figure().capture.boxes.groups.length, lines.length);
        continue;
      }
      if (type === 'duration') {
        assert.deepEqual(refusals(), [], 'a duration curve ranks every year a line spans');
        assert.equal(uplot.style.display, '', 'and shows its plot');
        assert.equal(pane.figureOffered(), true, 'and a figure of the curve');
        const { capture } = pane.figure();
        assert.deepEqual(
          capture.lines.map((entry) => entry.values.length),
          lines.map((line) => line.values.length),
          'each line whole, never cut to one slot',
        );
        assert.equal(capture.realHours, 8760 + 8784 + 8760, 'counted over the longest span');
        continue;
      }
      if (type === 'xy') {
        assert.deepEqual(
          refusals(),
          [
            lines.length === 1
              ? 'Select exactly two series to plot one against the other — 1 is drawn.'
              : 'SAMPLE_CASE1 line spans 2035 and SAMPLE_CASEM line spans 2035–2037, so ' +
                'there is no hour-by-hour pairing. Filter Years to the years both should ' +
                'pair on.',
          ],
          'a scatter pairs kept years by position, and refuses different counts of them',
        );
        assert.equal(pane.figure(), null, 'a refused scatter has nothing to capture');
        assert.equal(elements.xySwap.style.display, 'none', 'nor a swap or fit');
        continue;
      }
      if (type === 'interval') {
        assert.deepEqual(refusals(), [], 'an interval pane cuts every year a line spans');
        assert.equal(canvasHost.style.display, '', 'and shows its canvas');
        assert.equal(
          elements.intervalBy.parentElement.style.display,
          '',
          'and offers its controls',
        );
        assert.equal(pane.figureOffered(), true, 'and a figure of its periods');
        // It cuts the first drawn line: three slots of weekdays for 2035–2037.
        const { interval, lines: captured } = pane.figure().capture;
        const slots = lines[0] === threeYears ? 3 : 1;
        assert.equal(captured[0].values.length, slots * 8784);
        assert.equal(interval.weekdays.length, slots * 366, 'a weekday for every span day');
        assert.equal(interval.firstYear, 2035, 'and the year its labels carry');
        continue;
      }
      if (type === 'time' || type === 'stacked') {
        assert.deepEqual(refusals(), [], `a ${type} pane draws every year a line spans`);
        assert.equal(uplot.style.display, '', `a ${type} pane shows its plot`);
        assert.equal(elements.download.style.display, '', 'and offers its controls');
        assert.equal(pane.figureOffered(), true, 'and a figure of the span axis');
        const { capture } = pane.figure();
        assert.equal(capture.firstYear, 2035);
        for (const entry of capture.lines) assert.equal(entry.values.length, 3 * 8784);
        if (type === 'time') {
          assert.equal(elements.overviewHost.hidden, false, 'and its overview over every year');
        }
        continue;
      }
      assert.fail(`a ${type} pane is checked above`);
    }
  }
});

check('(i) a heatmap resized re-decides fit both ways, and its figure follows', () => {
  const elements = paneElements();
  const pane = createPane(0, elements, { rerender() {}, datesChange() {} }, REAL, 'heatmap');
  const refusals = () =>
    elements.body.querySelectorAll('.pane-banner-refusal').map((node) => node.textContent);
  // As updateFigureButtons decides it, after the panes paint.
  const offered = () => pane.figureOffered() && refusals().length === 0 && pane.figure() !== null;
  const canvasHost = elements.body.children[1];
  elements.body.rect = { width: 400, height: 600 };
  pane.render(spanFrame([spanLine('SAMPLE_CASEM', 3)]));
  assert.deepEqual(refusals(), [], 'three years fit a tall pane');
  assert.equal(offered(), true);

  elements.body.rect = { width: 400, height: 120 };
  pane.resize();
  assert.equal(refusals().length, 1, 'shrunk, the bands no longer fit');
  assert.match(refusals()[0], /^3 years of SAMPLE_CASEM line do not fit this pane/);
  assert.equal(offered(), false, 'and the refused pane offers no figure');

  elements.body.rect = { width: 400, height: 600 };
  pane.resize();
  assert.deepEqual(refusals(), [], 'grown back, the refusal goes');
  assert.equal(canvasHost.style.display, '', 'and the bands draw again');
  assert.deepEqual(pane.figure().capture.years, [2035, 2036, 2037]);
  assert.equal(offered(), true, 'with their figure');
});

check('(i) an interval figure under a Years filter names and counts only the kept years', () => {
  const years = { firstYear: 2035, numYears: 3 };
  const base = spanLine('SAMPLE_CASEM', 3);
  const line = { ...base, facets: { ...base.facets, years } };
  const captionYears = (kept) => {
    const pane = createPane(
      0,
      paneElements(),
      { rerender() {}, datesChange() {} },
      REAL,
      'interval',
    );
    const frame = frameOf([line], { spanOf: () => years, ...(kept ? { years: kept } : {}) });
    pane.render(frame);
    return pane.figure().capture.lines[0].facets.years;
  };
  const footnoteHours = (kept) => {
    const pane = createPane(
      0,
      paneElements(),
      { rerender() {}, datesChange() {} },
      REAL,
      'interval',
    );
    pane.render(frameOf([line], { spanOf: () => years, ...(kept ? { years: kept } : {}) }));
    return pane.figure().capture.realHours;
  };
  assert.equal(footnoteHours(null), 8760 + 8784 + 8760, 'unfiltered, every year’s real hours');
  assert.equal(footnoteHours(new Set([2036])), 8784, 'the kept year’s real hours only');
  assert.equal(footnoteHours(new Set([2035, 2037])), 2 * 8760, 'kept years, the gap not counted');
  assert.deepEqual(captionYears(null), years, 'unfiltered, the whole span');
  assert.deepEqual(
    captionYears(new Set([2036])),
    { firstYear: 2036, numYears: 1 },
    'one kept year, which the caption states as no span',
  );
  assert.deepEqual(
    captionYears(new Set([2036, 2037])),
    { firstYear: 2036, numYears: 2 },
    'two kept years name those years',
  );
});

check('(i) a one-year and a three-year duration curve each spread their own hours', () => {
  /** A line whose kept values are 0..n-1, ascending: rank = value. */
  const ranked = (caseLabel, numYears, color) => {
    const line = spanLine(caseLabel, numYears, color);
    const sorted = Float32Array.from({ length: line.values.length }, (_, i) => i);
    return { ...line, sorted, n: sorted.length };
  };
  const lines = [ranked('SAMPLE_CASE1', 1), ranked('SAMPLE_CASEM', 3, '#ff7f0e')];
  const pane = createPane(0, paneElements(), {}, REAL, 'duration');
  plots.length = 0;
  pane.render(spanFrame(lines));
  const [axis, ...columns] = plots[plots.length - 1].data;
  assert.equal(axis[0], 0);
  assert.equal(axis[axis.length - 1], 100, 'both on one % of interval axis');
  lines.forEach((line, i) => {
    const column = columns[i];
    assert.equal(column.length, axis.length);
    assert.equal(column[0], 0, `${line.name} starts at its lowest hour`);
    assert.equal(column[column.length - 1], line.n - 1, `${line.name} ends at its highest`);
    const at = 500;
    const rank = Math.round((at / (axis.length - 1)) * (line.n - 1));
    assert.equal(column[at], rank, `${line.name} at ${axis[at].toFixed(1)}% is its own rank`);
  });
  assert.ok(columns[1][500] > 2 * columns[0][500], 'the three-year line is not cut to one slot');
});

check('(i) no pane refuses a Case for its years, and no adapter declares one', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const dir = join(root, 'src/ui/panes');
  for (const file of readdirSync(dir)) {
    const text = readFileSync(join(dir, file), 'utf8');
    // adapter.ts counts a capture's real hours and names its years.
    if (file !== 'adapter.ts') {
      assert.ok(!/numYears/.test(text), `${file} decides nothing about a Case's years`);
    }
    assert.ok(!/drawsSpans|spanRefusal/.test(text), `${file} holds no span opt-in or refusal`);
  }
});

/** A line of `numYears` slots whose every hour is its own value, NaN on
 * Feb 29 of a non-leap year, as a real Case of those years holds. */
function datedLine(caseLabel, firstYear, numYears, color) {
  const line = spanLine(caseLabel, numYears, color);
  const values = Float32Array.from({ length: 8784 * numYears }, (_, h) => {
    const year = firstYear + Math.floor(h / 8784);
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const hour = h % 8784;
    return !leap && hour >= 1416 && hour < 1440 ? NaN : h;
  });
  return { ...line, values };
}

/** An X-Y pane drawing `x` against `y`, each Case of the given span. */
function xyOf(x, y, spans, extra = {}) {
  const elements = paneElements();
  const pane = createPane(0, elements, { rerender() {}, datesChange() {} }, REAL, 'xy');
  const frame = frameOf([x, y], {
    spanOf: (line) => spans[line.facets.caseLabel],
    ...extra,
  });
  pane.showControls(frame);
  pane.render(frame);
  return {
    pane,
    refusals: () =>
      elements.body.querySelectorAll('.pane-banner-refusal').map((node) => node.textContent),
  };
}

check('(i) a scatter pairs a Case’s years by position, kept year against kept year', () => {
  const YEAR_SLOT_HOURS = 8784;
  const pointsOf = (capture) => {
    const [xs, ys] = capture.lines.map((line) => line.values);
    let n = 0;
    for (let h = 0; h < xs.length; h++) if (Number.isFinite(xs[h]) && Number.isFinite(ys[h])) n++;
    return n;
  };

  // 2034 against 2035: one kept year each, paired.
  {
    const x = datedLine('SAMPLE_CASEA', 2034, 1);
    const y = datedLine('SAMPLE_CASEB', 2035, 1, '#ff7f0e');
    const { pane, refusals } = xyOf(x, y, {
      SAMPLE_CASEA: { firstYear: 2034, numYears: 1 },
      SAMPLE_CASEB: { firstYear: 2035, numYears: 1 },
    });
    assert.deepEqual(refusals(), [], '2034 against 2035 pairs');
    const { capture } = pane.figure();
    assert.deepEqual(capture.xy.years, { x: [2034], y: [2035] }, 'naming both years');
    assert.equal(pointsOf(capture), 8760, 'every hour both years hold');
    assert.equal(capture.realHours, 8760);
  }

  // 2034–2036 against 2035: three kept years against one.
  const x3 = datedLine('SAMPLE_CASEM', 2034, 3);
  const y1 = datedLine('SAMPLE_CASEB', 2035, 1, '#ff7f0e');
  const spans = {
    SAMPLE_CASEM: { firstYear: 2034, numYears: 3 },
    SAMPLE_CASEB: { firstYear: 2035, numYears: 1 },
  };
  {
    const { pane, refusals } = xyOf(x3, y1, spans);
    assert.deepEqual(refusals(), [
      'SAMPLE_CASEM line spans 2034–2036 and SAMPLE_CASEB line spans 2035, so there is no ' +
        'hour-by-hour pairing. Filter Years to the years both should pair on.',
    ]);
    assert.equal(pane.figure(), null);
  }
  // Years = {2035} keeps one year each side: the same pair plots.
  {
    const { pane, refusals } = xyOf(x3, y1, spans, { years: new Set([2035]) });
    assert.deepEqual(refusals(), [], 'filtered to 2035 the pair is one year each');
    const { capture } = pane.figure();
    assert.deepEqual(capture.xy.years, { x: [2035], y: [2035] });
    assert.equal(pointsOf(capture), 8760, '8,760 points: 2035 against 2035');
    assert.equal(capture.lines[0].values[0], YEAR_SLOT_HOURS, 'X is its 2035 slot, not 2034');
  }
  // Years = {2034, 2035} keeps two of X against one of Y: refused by its kept years.
  {
    const { refusals } = xyOf(x3, y1, spans, { years: new Set([2034, 2035]) });
    assert.deepEqual(refusals(), [
      'SAMPLE_CASEM line keeps 2034–2035 and SAMPLE_CASEB line spans 2035, so there is no ' +
        'hour-by-hour pairing. Filter Years to the years both should pair on.',
    ]);
  }

  // Three years against the same three: every hour of all three.
  {
    const a = datedLine('SAMPLE_CASEM', 2035, 3);
    const b = datedLine('SAMPLE_CASEN', 2035, 3, '#ff7f0e');
    const { pane } = xyOf(a, b, {
      SAMPLE_CASEM: { firstYear: 2035, numYears: 3 },
      SAMPLE_CASEN: { firstYear: 2035, numYears: 3 },
    });
    const { capture } = pane.figure();
    assert.equal(pointsOf(capture), 8760 + 8784 + 8760, '26,304 points over 2035–2037');
    assert.deepEqual(capture.xy.years, { x: [2035, 2036, 2037], y: [2035, 2036, 2037] });
    assert.equal(capture.realHours, 26304);
  }
  // 2035–2037 against 2040–2042: equal counts, different years, pair.
  {
    const a = datedLine('SAMPLE_CASEM', 2035, 3);
    const b = datedLine('SAMPLE_CASEN', 2040, 3, '#ff7f0e');
    const { pane, refusals } = xyOf(a, b, {
      SAMPLE_CASEM: { firstYear: 2035, numYears: 3 },
      SAMPLE_CASEN: { firstYear: 2040, numYears: 3 },
    });
    assert.deepEqual(refusals(), [], 'lengths equal, years differ: never a refusal');
    const { capture } = pane.figure();
    // 2036's Feb 29 meets 2041's, which is no day: it pairs nothing.
    assert.equal(pointsOf(capture), 3 * 8760);
    assert.equal(capture.realHours, 3 * 8760, 'nor is it counted');
    assert.deepEqual(capture.xy.years, { x: [2035, 2036, 2037], y: [2040, 2041, 2042] });
  }
});

check('(e) a time pane offers "overlay years" only over more than one year', () => {
  const offered = (lines, spanOf) => {
    const elements = paneElements();
    const pane = createPane(0, elements, { rerender() {}, datesChange() {} }, REAL, 'time');
    pane.showControls(frameOf(lines, { spanOf }));
    return elements.overlayYears.parentElement.style.display === '';
  };
  const span = (numYears) => () => ({ firstYear: 2035, numYears });
  assert.equal(
    offered([spanLine('SAMPLE_CASEM', 1)], span(1)),
    false,
    'one year: nothing to lay over',
  );
  assert.equal(offered([spanLine('SAMPLE_CASEM', 3)], span(3)), true, 'a three-year Case');
  const byCase = { SAMPLE_CASEM: 2035, SAMPLE_CASEN: 2036 };
  assert.equal(
    offered([spanLine('SAMPLE_CASEM', 1), spanLine('SAMPLE_CASEN', 1, '#ff7f0e')], (line) => ({
      firstYear: byCase[line.facets.caseLabel],
      numYears: 1,
    })),
    true,
    'two one-year Cases of different years',
  );
  const elements = paneElements();
  const log = [];
  createPane(0, elements, { rerender: () => log.push('rerender'), datesChange() {} }, REAL, 'time');
  elements.overlayYears.checked = true;
  elements.overlayYears.fire('change');
  assert.deepEqual(log, ['rerender'], 'a tick re-renders');
});

console.log(`\n${passed} checks passed`);
