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
//       floor for a hidden pane.

import './test_loader.mjs';
import assert from 'node:assert/strict';
import { installFakeDom, paneElements, frameOf } from './test_fixtures_dom.mjs';

installFakeDom();
const { createPane } = await import('../src/ui/panes/pane.ts');
const { figureShot } = await import('../src/ui/panes/adapter.ts');
const { createHeatmapAdapter } = await import('../src/ui/panes/heatmap.ts');
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
      { yearOf: (series) => series.year },
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

console.log(`\n${passed} checks passed`);
