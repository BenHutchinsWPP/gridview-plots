// tests/test_xy_pane.mjs — the X-Y scatter chart type. Its adapter,
// src/ui/panes/xy.ts, runs here against a fake DOM (tests/test_fixtures_dom.mjs);
// what src/ui/charts.ts declares is read as source text, since it cannot
// load in Node.
//
//   (a) 'xy' is a slot type offered in all four pane selects.
//   (b) the pane is hand-drawn, with no uPlot.
//   (c) anything but exactly two drawables is refused; swap and fit show
//       only with a pair.
//   (d) x survives by series FULL label; zoom reset and download are hidden.
//   (e) each axis reads its own series' scale rules.
//   (f) resize redraws the standing pair and its fit; hover reaches the
//       scatter while it is drawn and nothing after the pane leaves it.
//   (g) the math: points only where both series have values, per-axis
//       ranges, padded degenerate ranges, hovers naming the hour, and its
//       year when the pair's Case names one.

import './test_loader.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom, stubHost, frameOf } from './test_fixtures_dom.mjs';

installFakeDom();
const { createXyAdapter } = await import('../src/ui/panes/xy.ts');
const { hourLabel } = await import('../src/ui/chart-format.ts');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8');

const charts = read('src/ui/charts.ts');
const xy = read('src/ui/panes/xy.ts');
const html = read('index.html');

// ------------------------------------------------------------------- (a)
assert.match(
  charts,
  /export type SlotType =\s*[^;]*'xy'/,
  "'xy' is a SlotType; without it the select's value casts to a string no branch matches",
);

const xyOptions = [...html.matchAll(/<option value="xy">/g)];
assert.equal(
  xyOptions.length,
  4,
  'all four pane selects offer the X-Y slot -- the select value is cast unchecked, ' +
    'so one select missing the option makes the slot unselectable in that pane',
);
for (let pane = 1; pane <= 4; pane++) {
  assert.ok(
    charts.includes(`'[data-el="xy-swap-${pane}"]'`),
    `charts.ts spells out the pane-${pane} swap hook as a literal selector`,
  );
  assert.ok(
    html.includes(`data-el="xy-swap-${pane}"`),
    `index.html's #section-template defines data-el="xy-swap-${pane}"`,
  );
}
assert.match(charts, /xy: createXyAdapter,/, 'the host draws an X-Y pane with this adapter');

// ------------------------------------------------------------------- (b)
assert.ok(
  !/from 'uplot'/.test(xy),
  'src/ui/panes/xy.ts imports no uPlot: the scatter is hand-drawn, because the four ' +
    'hour-axis helpers the line panes share would all need a branch to host it',
);

const { YEAR_SLOT_HOURS: HOURS } = await import('../src/model/calendar.ts');
const seriesOf = (name, unit, color, at, extra = {}) => {
  const values = new Float32Array(HOURS).fill(NaN);
  at(values);
  return { name, unit, color, values, warnings: [], ...extra };
};

// x runs 0..99, y runs 1000 down to 10: two magnitudes apart, so an axis
// mapped over the WRONG range lands visibly off the plot rectangle.
const xs = seriesOf('Case 1 · Load', 'MWh', '#1f77b4', (v) => {
  for (let i = 0; i < 100; i++) v[i] = i;
});
const ys = seriesOf('Case 1 · LMP', '$/MWh', '#ff7f0e', (v) => {
  for (let i = 0; i < 100; i++) v[i] = 1000 - i * 10;
});
const third = seriesOf('Case 2 · Load', 'MWh', '#2ca02c', (v) => v.fill(1, 0, 10));

const PANE = { width: 400, height: 220 };
const { host, record } = stubHost({ size: PANE });
const xyPane = createXyAdapter(host);
const { canvas, tip } = host;
const { xySwap, xyFit } = host.controls;
assert.equal(xyPane.surface, 'canvas', 'the scatter draws on the pane canvas, never uPlot');

/** The points the last draw painted, as the centres of their squares. */
function points() {
  return canvas.context.calls
    .filter((call) => call.op === 'fillRect' && call.w === 2.5)
    .map((call) => ({ px: call.x + 1.25, py: call.y + 1.25 }));
}
function drawAgain(frame) {
  canvas.context.calls.length = 0;
  xyPane.draw(frame);
}

// ------------------------------------------------------------------- (c)
drawAgain(frameOf([xs, ys, third]));
assert.match(
  record.banners.at(-1).text,
  /^Select exactly two series to plot one against the other — 3 are drawn\.$/,
  'the X-Y pane refuses anything but exactly two drawables -- never the first two of five -- ' +
    'in words the reader can act on',
);
assert.equal(points().length, 0, 'and draws no point');
assert.equal(canvas.style.display, 'none');
assert.equal(xyPane.figure.capture(), null, 'a refused scatter has no figure');
assert.deepEqual(
  xyPane.controls(frameOf([xs, ys, third])),
  [],
  'the swap and fit exist only while exactly two series are drawn',
);
assert.deepEqual(xyPane.controls(frameOf([xs])), []);
assert.deepEqual(xyPane.controls(frameOf([xs, ys])), ['xy']);

// ------------------------------------------------------------------- (d)
assert.ok(
  !xyPane.controls(frameOf([xs, ys])).includes('zoom'),
  'the zoom reset is hidden for the X-Y slot: a hand-drawn scatter has no zoom to reset',
);
assert.ok(
  !xyPane.controls(frameOf([xs, ys])).includes('download'),
  'a pane’s CSV download stays a time-axis export: it writes Month/Day/HE columns, ' +
    'and a scatter has no hour axis to export',
);

record.notes.length = 0;
drawAgain(frameOf([xs, ys]));
assert.deepEqual(record.notes, ['X Case 1 · Load / Y Case 1 · LMP'], 'selection order by default');
assert.equal(xySwap.title, 'Put Case 1 · LMP on X and Case 1 · Load on Y');
xySwap.fire('click');
assert.equal(record.rerenders, 1, 'the swap re-renders');
// The same two lines under new relative names: x is remembered by the FULL
// label (`detail`), because `name` is shorthand relative to the other drawn
// line and moves when it does.
const load = { ...xs, name: 'Load', detail: 'Case 1 · Load' };
const lmp = { ...ys, name: 'LMP', detail: 'Case 1 · LMP' };
xyPane.draw(frameOf([load, lmp]));
assert.equal(
  record.notes.at(-1),
  'X LMP / Y Load',
  'a swap puts the other series on X, and it stays there under a changed name and order',
);
xyPane.draw(frameOf([load, third]));
assert.equal(
  record.notes.at(-1),
  'X Load / Y Case 2 · Load',
  'a remembered X that is no longer selected falls back to selection order',
);
xySwap.fire('click');
xyPane.draw(frameOf([load, third]));
assert.equal(
  record.notes.at(-1),
  'X Case 2 · Load / Y Load',
  'with exactly two drawables the other one is y, whichever way round x was',
);
xySwap.fire('click');
// ------------------------------------------------------------------- (e)
{
  // MW and MWh share one scale, whose label names both. Each axis reads the
  // rules for ITS series alone, so each names only its own unit; one shared
  // read would put "MW · MWh" on both.
  const labelled = stubHost({ size: { width: 400, height: 400 } });
  const flow = seriesOf('Case 1 · Flow', 'MW', '#1f77b4', (v) => {
    for (let i = 0; i < 100; i++) v[i] = i;
  });
  const energy = seriesOf('Case 1 · Energy', 'MWh', '#ff7f0e', (v) => {
    for (let i = 0; i < 100; i++) v[i] = 100 - i;
  });
  createXyAdapter(labelled.host).draw(frameOf([flow, energy]));
  const axisTexts = labelled.host.canvas.context.calls
    .filter((call) => call.op === 'fillText' && /^Case 1 · (Flow|Energy) \(/.test(call.text))
    .map((call) => call.text);
  assert.deepEqual(
    axisTexts,
    ['Case 1 \u00b7 Flow (MW)', 'Case 1 \u00b7 Energy (MWh)'],
    'each axis is labelled through the unit-to-scale rules for ITS series alone -- ' +
      'one shared scale read is how a MW axis borrows another axis\u2019s numbers and the ' +
      'plot looks empty',
  );
}

// ------------------------------------------------------------------- (f)
drawAgain(frameOf([xs, ys]));
const standing = points();
canvas.context.calls.length = 0;
xyPane.resize();
assert.deepEqual(
  points(),
  standing,
  'a resize redraws the X-Y pane from its standing pair, so a resized scatter is the same ' +
    'scatter at a new size rather than a blank canvas',
);
const captions = () =>
  canvas.context.calls.filter((call) => call.op === 'fillText' && call.text.startsWith('y = '));
xyFit.checked = true;
canvas.context.calls.length = 0;
xyFit.fire('change');
assert.equal(captions().length, 1, 'ticking fit redraws this pane with its fit');
canvas.context.calls.length = 0;
xyPane.resize();
assert.equal(captions().length, 1, 'and a resize keeps the fit rather than dropping it');
xyFit.checked = false;
drawAgain(frameOf([xs, ys]));
assert.equal(captions().length, 0, 'the draw is handed this pane’s own fit state');
for (let pane = 1; pane <= 4; pane++) {
  assert.ok(
    html.includes(`data-el="xy-fit-${pane}"`),
    `pane ${pane}'s header carries its own fit toggle`,
  );
}

const shot = xyPane.figure.capture();
assert.equal(shot.capture.pane, 'xy');
assert.deepEqual(
  shot.capture.lines.map((line) => line.name),
  ['Case 1 · Load', 'Case 1 · LMP'],
  'the figure takes the pair X first, as the pane holds it',
);
assert.deepEqual(shot.capture.xy, { fit: false });
assert.equal(xyPane.figure.offered(), true);
xyPane.draw(frameOf([xs, { ...ys, dashed: true }]));
assert.equal(xyPane.figure.offered(), false, 'a pair with the preview in it would lose an axis');

// ------------------------------------------------------------------- (g)
drawAgain(frameOf([xs, ys]));
const drawn = points();
assert.equal(drawn.length, 100, 'one point per hour where both series hold a value');

const MARGIN_LEFT = 72;
const PLOT_WIDTH = 400 - MARGIN_LEFT - 8;
const MARGIN_TOP = 10;
const PLOT_HEIGHT = 220 - MARGIN_TOP - 34;
const close = (actual, expected, tolerance, what) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: expected ~${expected}, drew ${actual}`,
  );

close(drawn[0].px, MARGIN_LEFT, 1e-6, 'x at its low sits on the left edge');
close(drawn[0].py, MARGIN_TOP, 1e-6, 'y at its high sits on the top edge');
close(drawn[99].px, MARGIN_LEFT + PLOT_WIDTH, 1e-6, 'x at its high sits on the right edge');
close(drawn[99].py, MARGIN_TOP + PLOT_HEIGHT, 1e-6, 'y at its low sits on the bottom edge');
close(
  drawn[50].px,
  MARGIN_LEFT + PLOT_WIDTH * (50 / 99),
  1e-6,
  'x maps through its OWN range (0..99)',
);
close(
  drawn[50].py,
  MARGIN_TOP + PLOT_HEIGHT * (1 - (500 - 10) / (1000 - 10)),
  1e-6,
  'y maps through its OWN range (10..1000), not x’s',
);
const texts = canvas.context.calls.filter((call) => call.op === 'fillText').map((c) => c.text);
assert.ok(
  texts.includes('Case 1 · Load (MWh)'),
  'the x axis is named after its series, unit and all',
);
assert.equal(texts.filter((text) => text === 'Case 1 · LMP ($/MWh)').length, 1);

// The hover names the hour it snapped to, with both series' values.
xyPane.hover(drawn[98].px, drawn[98].py);
assert.equal(tip.style.display, '');
assert.equal(tip.children[0].textContent, hourLabel(98), 'the head names the hour');
assert.equal(tip.children[1].children[1].textContent, 'Case 1 · Load', 'x row, x’s name');
assert.equal(tip.children[1].children[2].textContent, '98', 'the x row shows x’s value');
assert.equal(tip.children[2].children[2].textContent, '20', 'the y row shows y’s value');
xyPane.hover(4, 4);
assert.equal(tip.style.display, 'none', 'a hover far from any point shows nothing');

// A NaN in one series removes the hour: the point after it takes its place.
xs.values[3] = NaN;
drawAgain(frameOf([xs, ys]));
const gapped = points();
assert.equal(gapped.length, 99, 'an hour NaN in either series leaves no point');
xyPane.hover(gapped[3].px, gapped[3].py);
assert.equal(
  tip.children[0].textContent,
  hourLabel(4),
  'the surviving points keep their own hours',
);

// No overlap at all is a refusal, not an empty plot frame.
const noOverlap = seriesOf('Case 2 · Zero', 'MW', '#2ca02c', () => {});
drawAgain(frameOf([xs, noOverlap]));
assert.ok(
  record.banners.some(({ text }) => /no point to plot/i.test(text)),
  'two series sharing no kept hour are refused in words',
);
assert.equal(points().length, 0);
assert.equal(canvas.style.display, 'none');
xyPane.hover(gapped[3].px, gapped[3].py);
assert.equal(tip.style.display, 'none', 'a refused scatter answers no hover');

// A constant series still draws: the padded range keeps every point finite.
const flat = seriesOf('Case 2 · Flat', 'MW', '#2ca02c', (v) => {
  for (let i = 0; i < 10; i++) v[i] = 5;
});
drawAgain(frameOf([flat, ys]));
const flatPoints = points();
assert.equal(flatPoints.length, 10);
assert.ok(
  flatPoints.every((point) => Number.isFinite(point.px) && Number.isFinite(point.py)),
  'a degenerate range is padded, never divided by zero',
);
assert.ok(
  flatPoints.every((point) => point.px === flatPoints[0].px),
  'a constant x draws one vertical line of points',
);

// The hover's date carries the pair's year when its Case names one, and
// none for the stand-in year a line with no Case is counted under.
{
  const { NO_YEAR } = await import('../src/app/boxes.ts');
  const MAR1 = 1440;
  const at = (offset) => (v) => {
    v[MAR1] = 1 + offset;
    v[MAR1 + 30] = 5 + offset;
  };
  const pairX = seriesOf('Case 3 · Load', 'MWh', '#1f77b4', at(0));
  const pairY = seriesOf('Case 3 · LMP', '$/MWh', '#ff7f0e', at(10));
  const heads = (firstYear) => {
    drawAgain(frameOf([pairX, pairY], { spanOf: () => ({ firstYear, numYears: 1 }) }));
    const [first] = points();
    xyPane.hover(first.px, first.py);
    return tip.children[0].textContent;
  };
  assert.equal(heads(2035), '2035 Mar 1 · HE 1', 'a one-year 2035 pair names its year');
  assert.equal(heads(NO_YEAR), 'Mar 1 · HE 1', 'a line with no year prints none');
  drawAgain(
    frameOf([pairX, pairY], {
      spanOf: (s) => ({ firstYear: s === pairX ? 2035 : 2036, numYears: 1 }),
    }),
  );
  const [first] = points();
  xyPane.hover(first.px, first.py);
  assert.equal(
    tip.children[0].textContent,
    'Mar 1 · HE 1 · 2035 against 2036',
    'a pair of two years names both, X first, never one for both sides',
  );
  drawAgain(
    frameOf([pairX, pairY], {
      spanOf: (s) => ({ firstYear: s === pairX ? 2035 : NO_YEAR, numYears: 1 }),
    }),
  );
  const [undated] = points();
  xyPane.hover(undated.px, undated.py);
  assert.equal(tip.children[0].textContent, 'Mar 1 · HE 1', 'a side with no year names neither');

  // Cases of three years pair their kth years: the head names the pair's own.
  const spanned = (offset) => {
    const values = new Float32Array(3 * HOURS).fill(NaN);
    for (let k = 0; k < 3; k++) values[k * HOURS + MAR1] = offset + k;
    return values;
  };
  const longX = { ...pairX, values: spanned(1) };
  const longY = { ...pairY, values: spanned(10) };
  const headsOf = (yFirst) => {
    drawAgain(
      frameOf([longX, longY], {
        spanOf: (s) => ({ firstYear: s === longX ? 2035 : yFirst, numYears: 3 }),
      }),
    );
    return points().map((point) => {
      xyPane.hover(point.px, point.py);
      return tip.children[0].textContent;
    });
  };
  assert.deepEqual(
    headsOf(2035),
    ['2035 Mar 1 · HE 1', '2036 Mar 1 · HE 1', '2037 Mar 1 · HE 1'],
    'the same years: each point dated in its own year',
  );
  assert.deepEqual(
    headsOf(2040),
    [
      'Mar 1 · HE 1 · 2035 against 2040',
      'Mar 1 · HE 1 · 2036 against 2041',
      'Mar 1 · HE 1 · 2037 against 2042',
    ],
    'different years: both, X first',
  );
  // The Years filter keeps 2036 of X and 2041 of Y: the pair is those two.
  drawAgain(
    frameOf([longX, longY], {
      spanOf: (s) => ({ firstYear: s === longX ? 2035 : 2040, numYears: 3 }),
      years: new Set([2036, 2041]),
    }),
  );
  const [kept] = points();
  assert.equal(points().length, 1);
  xyPane.hover(kept.px, kept.py);
  assert.equal(tip.children[0].textContent, 'Mar 1 · HE 1 · 2036 against 2041');
  assert.equal(tip.children[1].children[2].textContent, '2', 'X’s 2036 value');
  assert.equal(tip.children[2].children[2].textContent, '11', 'against Y’s 2041');
}

// Leaving the type releases the shared canvas and its hover.
drawAgain(frameOf([xs, ys]));
xyPane.leave();
assert.equal(canvas.style.display, 'none');
xyPane.hover(drawn[98].px, drawn[98].py);
assert.equal(tip.style.display, 'none', 'after leave() the scatter answers no hover');
canvas.context.calls.length = 0;
xyPane.resize();
assert.equal(points().length, 0, 'and a resize draws no stale pair');

console.log(
  'ok - the X-Y adapter, run headlessly: exact-two or refusal, an ordered pairing that ' +
    'survives by full label, per-axis ranges and unit reads, padded degenerates, a hover ' +
    'that names its hour, a per-pane fit, a resize that redraws and a leave that releases',
);
// ------------------------------------------------------------------- (h)
//
// The fit, checked against closed-form answers.
const { fitLine, fitCaption, fitNumber } = await import('../src/ui/panes/xy.ts');

const exact = fitLine([
  { x: 1, y: 5 },
  { x: 2, y: 7 },
  { x: 3, y: 9 },
  { x: 4, y: 11 },
]);
assert.ok(exact.ok);
close(exact.slope, 2, 1e-12, 'a line through collinear points recovers its slope');
close(exact.intercept, 3, 1e-12, 'and its intercept');
close(exact.r2, 1, 1e-12, 'a perfect fit is R² = 1');
assert.equal(exact.n, 4);

// y on x, NOT a symmetric fit: swapping the axes must give a different line,
// which is the whole reason the X ⇄ Y button changes the answer.
const noisy = [
  { x: 0, y: 1 },
  { x: 1, y: 1 },
  { x: 2, y: 4 },
  { x: 3, y: 4 },
];
const forward = fitLine(noisy);
const backward = fitLine(noisy.map((p) => ({ x: p.y, y: p.x })));
assert.ok(forward.ok && backward.ok);
close(forward.slope, 1.2, 1e-12, 'OLS of y on x');
assert.ok(
  Math.abs(forward.slope - 1 / backward.slope) > 1e-6,
  'the fit is y on x and not symmetric: swapping the axes is a different line, not the ' +
    'same line read backwards',
);
close(forward.r2, backward.r2, 1e-12, 'R² is the same either way round, though the line is not');

// A vertical cloud and a flat y are real shapes (a unit at its cap) and are
// answered, never divided by zero.
const vertical = fitLine([
  { x: 5, y: 1 },
  { x: 5, y: 9 },
]);
assert.equal(vertical.ok, false);
assert.match(vertical.reason, /same X/, 'a zero-variance x is refused by name');
assert.match(fitCaption(vertical), /^No fit/, 'and the caption says so rather than going blank');

const flatY = fitLine([
  { x: 1, y: 7 },
  { x: 2, y: 7 },
  { x: 3, y: 7 },
]);
assert.ok(flatY.ok);
close(flatY.slope, 0, 1e-12, 'a flat y fits a flat line');
assert.equal(flatY.r2, 1, 'and the residuals are zero, so the fit is exact');

assert.equal(fitLine([{ x: 1, y: 1 }]).ok, false, 'one point is every line, so it is no fit');

// R² is bounded even when floating point overshoots: a value like 1.0000000002
// printed as 1.0000 is harmless, but a negative one reads as a broken chart.
for (const fit of [exact, forward, flatY]) {
  assert.ok(fit.r2 >= 0 && fit.r2 <= 1, `R² stays inside [0, 1]: ${fit.r2}`);
}

// The caption reads in the axes' own terms, and the coefficient formatter is
// NOT the axis one: an axis rounds a slope of 0.00042 to 0.
close(Number(fitNumber(0.00042)), 0.00042, 1e-6, 'a small slope keeps its value');
assert.equal(fitNumber(12), '12', 'a whole coefficient carries no padded zeroes');
assert.match(
  fitNumber(1.23456e-9),
  /e-9$/,
  'a coefficient too small to write out goes exponential',
);
assert.match(fitCaption(exact), /y = 2·x \+ 3\s+R² = 1\.0000/, 'the caption is the equation');
assert.match(
  fitCaption(
    fitLine([
      { x: 1, y: 1 },
      { x: 2, y: 3 },
    ]),
  ),
  /y = 2·x - 1\s/,
  'a negative intercept is subtracted rather than written as "+ -"',
);
assert.match(
  fitCaption(
    fitLine([
      { x: 1, y: 3 },
      { x: 2, y: 1 },
    ]),
  ),
  /y = -2·x \+ 5\s/,
  'and a negative slope wears the same minus the intercept does',
);

// And the drawing: the caption is given a band ABOVE the plot, so the
// scatter's densest region is never underneath it.
xs.values[3] = 3;
xyFit.checked = false;
drawAgain(frameOf([xs, ys]));
const withoutFit = points()[0].py;
xyFit.checked = true;
drawAgain(frameOf([xs, ys]));
const withFit = points();
const caption = canvas.context.calls.find(
  (call) => call.op === 'fillText' && call.text.startsWith('y = '),
);
assert.ok(caption, 'the fit caption is drawn');
assert.ok(
  caption.y < withFit.reduce((top, point) => Math.min(top, point.py), Infinity),
  'the caption sits above every plotted point rather than over the cloud',
);
assert.ok(
  withFit[0].py > withoutFit,
  'the caption band is taken out of the plot: turning the fit on moves the points down, ' +
    'rather than painting text over them',
);

console.log(
  'ok - the fit: OLS of y on x recovered exactly, asymmetric under a swap, vertical and flat ' +
    'clouds answered rather than divided by zero, R² bounded, and a caption in its own band',
);
