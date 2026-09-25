// tests/test_xy_pane.mjs — the X-Y scatter slot. charts.ts couplings are
// asserted as source text (it cannot load in Node); the renderer, xy-plot.ts,
// runs here against stubbed DOM.
//
//   (a) 'xy' is a slot type offered in all four pane selects.
//   (b) the pane is hand-drawn, with no uPlot.
//   (c) anything but exactly two drawables is refused; swap shows only with
//       a pair.
//   (d) x survives by series NAME; zoom reset and download are hidden.
//   (e) each axis reads its own series' scale rules.
//   (f) resize redraws the standing pair; hover follows the pane holding the
//       shared canvas.
//   (g) the math: points only where both series have values, per-axis
//       ranges, padded degenerate ranges, hovers naming the hour.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8');

const charts = read('src/ui/charts.ts');
const xy = read('src/ui/xy-plot.ts');
const html = read('index.html');

/** One assignment statement, from its opening text to the next semicolon --
 * robust to prettier reflowing the right-hand side across lines. */
function statement(text, start) {
  const at = text.indexOf(start);
  assert.ok(at >= 0, `expected a statement starting ${JSON.stringify(start)}`);
  return text.slice(at, text.indexOf(';', at) + 1);
}

// ------------------------------------------------------------------- (a)
assert.match(
  charts,
  /export type SlotType = [^;]*'xy'/,
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

// ------------------------------------------------------------------- (b)
assert.ok(
  !/from 'uplot'/.test(xy),
  'src/ui/xy-plot.ts imports no uPlot: the scatter is hand-drawn, because the four ' +
    'hour-axis helpers the line panes share would all need a branch to host it',
);
const xyBranchAt = charts.indexOf("} else if (slotType === 'xy') {");
assert.ok(xyBranchAt >= 0, "charts.ts has an 'xy' branch in the slot dispatch");
const xyBranch = charts.slice(
  xyBranchAt,
  charts.indexOf('} else if (slotType ===', xyBranchAt + 1),
);
assert.match(
  xyBranch,
  /slotPlots\[i\] = null/,
  'the X-Y branch destroys the pane\u2019s uPlot instance rather than drawing over it',
);

// ------------------------------------------------------------------- (c)
assert.match(
  xyBranch,
  /drawable\.length !== 2/,
  'the X-Y pane refuses anything but exactly two drawables -- never the first two of five',
);
assert.match(
  xyBranch,
  /Select exactly two series/,
  'the refusal says so in words the reader can act on, the way the box pane refuses',
);
const swapGate = statement(charts, 'xySwapBtns[i].style.display');
assert.match(
  swapGate,
  /slotType === 'xy' && drawable\.length === 2/,
  'the swap control exists only while this pane is the X-Y slot AND exactly two series ' +
    'are drawn',
);

// ------------------------------------------------------------------- (d)
const xyPairFn = charts.match(/function xyPair\([\s\S]*?\n  \}/);
assert.ok(xyPairFn, 'charts.ts still declares xyPair');
assert.match(
  xyPairFn[0],
  /findIndex\(\(s\) => \(s\.detail \?\? s\.name\) === stored\)/,
  'the pane\u2019s x is remembered by the series\u2019 FULL label, so it survives a filter change ' +
    'and does not silently attach itself to whichever series lands at that index. Not by ' +
    '`name`: that is shorthand relative to the other drawn line (nameDrawnSet), and it moves ' +
    'when the other line does',
);
assert.match(
  xyPairFn[0],
  /xAxis = x >= 0 \? x : 0/,
  'a remembered name that is no longer selected falls back to selection order (index 0)',
);
assert.match(
  xyPairFn[0],
  /drawable\[1 - xAxis\]/,
  'with exactly two drawables the other one is y, whichever way round x was',
);

const zoomGate = statement(charts, 'zoomResetBtns[i].style.display');
assert.match(
  zoomGate,
  /'xy'/,
  'the zoom reset is hidden for the X-Y slot: a hand-drawn scatter has no zoom to reset',
);
const downloadGate = statement(charts, 'download1Btn.style.display');
assert.ok(
  !downloadGate.includes("'xy'"),
  'the pane-1 CSV download stays a time-axis export: it writes Month/Day/HE columns, ' +
    `and a scatter has no hour axis to export. Gate reads: ${downloadGate.trim()}`,
);

// ------------------------------------------------------------------- (e)
assert.match(
  xy,
  /function axisLabel\(series: CaseSeries\): string \{\s*\n\s*return scalesOf\(\[series\]\)\[0\]\?\.label \?\? series\.unit;/,
  'the axis label reads the kind\u2019s unit-to-scale rules for ONE series at a time',
);
for (const side of ['xs', 'ys']) {
  const calls = xy.split(`axisLabel(${side})`).length - 1;
  assert.equal(
    calls,
    1,
    `the ${side === 'xs' ? 'x' : 'y'} axis is labelled through its own axisLabel read -- ` +
      'one shared scale read is how a MW axis borrows $/MWh\u2019s numbers and the plot ' +
      'looks empty',
  );
}

// ------------------------------------------------------------------- (f)
assert.match(
  charts,
  /if \(slotXyGeometry\[i\]\) \{\s*\n\s*xyPlot\.hover\(/,
  'the canvas hover route reaches the scatter when the pane is showing one',
);
// Box and scatter share a canvas; switching must release the other's hover
// state.
const boxBranchAt = charts.indexOf("} else if (slotType === 'box') {");
const boxBranch = charts.slice(boxBranchAt, xyBranchAt);
assert.match(
  boxBranch,
  /slotXyGeometry\[i\] = null/,
  'a pane showing the box plot releases the scatter\u2019s hover state',
);
assert.match(
  xyBranch,
  /slotBoxGeometry\[i\] = null/,
  'a pane showing the scatter releases the box plot\u2019s hover state',
);
const resizeBranch = charts.match(
  /else if \(currentLayout\[i\] === 'xy' && lastInput\) \{[\s\S]*?if \(pair\) xyPlot\.draw\(i, pair\[0\], pair\[1\], xyFitChecks\[i\]\.checked\);/,
);
assert.ok(
  resizeBranch,
  'a resize redraws the X-Y pane from its standing pair AND its fit state, so a resized ' +
    'scatter is the same scatter at a new size rather than a blank canvas or a dropped fit',
);

// The fit toggle is gated exactly as the swap is -- one pair, one fit -- and
// it is per pane, because two panes can hold two different pairs. A fit
// control on a pane with no pair is a control that cannot mean anything.
const fitGate = statement(charts, 'fitLabel.style.display');
assert.match(
  fitGate,
  /slotType === 'xy' && drawable\.length === 2/,
  'the fit toggle is shown only while this pane is the X-Y slot with exactly two series drawn',
);
for (let pane = 1; pane <= 4; pane++) {
  assert.ok(
    html.includes(`data-el="xy-fit-${pane}"`),
    `pane ${pane}'s header carries its own fit toggle`,
  );
}
assert.match(
  xyBranch,
  /xyPlot\.draw\(i, xs, ys, xyFitChecks\[i\]\.checked\)/,
  'the draw is handed this pane\u2019s own fit state, never another pane\u2019s',
);

console.log(
  'ok - the X-Y slot: selectable in all four panes, hand-drawn, exact-two or refusal, ' +
    'an ordered pairing that survives by name, per-axis unit reads, a per-pane fit toggle ' +
    'gated on the pair, and a resize that redraws',
);

// ------------------------------------------------------------------- (g)
//
// The renderer against deliberately dumb stubs: this proves arithmetic and
// routing; layout is checked by eye.
globalThis.window = globalThis;
globalThis.devicePixelRatio = 1;

const element = () => ({
  style: {},
  className: '',
  textContent: '',
  children: [],
  appendChild(child) {
    this.children.push(child);
  },
  replaceChildren(...nodes) {
    this.children = [...nodes];
  },
});

globalThis.document = { createElement: () => element() };

const drawCalls = [];
const contextStub = () => ({
  font: '',
  fillStyle: '',
  strokeStyle: '',
  textAlign: '',
  globalAlpha: 1,
  setTransform() {},
  clearRect() {},
  rect() {},
  clip() {},
  beginPath() {},
  moveTo() {},
  lineTo() {},
  stroke() {},
  fill() {},
  save() {},
  restore() {},
  translate() {},
  rotate() {},
  fillRect(x, y, w, h) {
    drawCalls.push([x, y, w, h]);
  },
  fillText(text, x, y) {
    drawCalls.push([String(text), x, y]);
  },
  measureText(text) {
    return { width: String(text).length * 6 };
  },
});

const canvasStub = () => {
  const context = contextStub();
  return { width: 0, height: 0, style: {}, getContext: () => context, context };
};

const PANE = { width: 400, height: 220 };
const canvases = [canvasStub()];
const tips = [element()];
const bodies = [{ querySelectorAll: () => [], clientWidth: PANE.width }];
const geometry = [null];
const hits = [[]];
const banners = [];
const scaleReads = [];

const { createXyPlot } = await import('../src/ui/xy-plot.ts');
const xyPlot = createXyPlot({
  paneBodies: bodies,
  slotCanvases: canvases,
  slotTips: tips,
  slotXyGeometry: geometry,
  slotXyHits: hits,
  paneSize: () => PANE,
  scalesOf(series) {
    scaleReads.push(series.map((s) => s.unit));
    return [{ scale: series[0].unit, label: series[0].unit }];
  },
  formatNumber: (value) => (Number.isFinite(value) ? String(Math.round(value)) : '—'),
  hourLabel: (hour) => `HE ${hour + 1}`,
  banner: (_body, _kind, text) => banners.push(text),
  clip: (_context, text) => text,
});

const HOURS = 8760;
const seriesOf = (name, unit, color, at) => {
  const values = new Float32Array(HOURS).fill(NaN);
  at(values);
  return { name, unit, color, values };
};

// x runs 0..99, y runs 1000 down to 10: two magnitudes apart, so an axis
// mapped over the WRONG range lands visibly off the plot rectangle.
const xs = seriesOf('Case 1 · Load', 'MWh', '#1f77b4', (v) => {
  for (let i = 0; i < 100; i++) v[i] = i;
});
const ys = seriesOf('Case 1 · LMP', '$/MWh', '#ff7f0e', (v) => {
  for (let i = 0; i < 100; i++) v[i] = 1000 - i * 10;
});
xyPlot.draw(0, xs, ys);

assert.equal(hits[0].length, 100, 'one point per hour where both series hold a value');
assert.deepEqual(
  scaleReads,
  [['MWh'], ['$/MWh']],
  'the unit-to-scale rules are read once per axis, for that axis\u2019s series alone',
);

const MARGIN_LEFT = 72;
const PLOT_WIDTH = 400 - MARGIN_LEFT - 8;
const MARGIN_TOP = 10;
const PLOT_HEIGHT = 220 - MARGIN_TOP - 34;
const close = (actual, expected, tolerance, what) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: expected ~${expected}, drew ${actual}`,
  );

close(hits[0][0].px, MARGIN_LEFT, 1e-6, 'x at its low sits on the left edge');
close(hits[0][0].py, MARGIN_TOP, 1e-6, 'y at its high sits on the top edge');
close(hits[0][99].px, MARGIN_LEFT + PLOT_WIDTH, 1e-6, 'x at its high sits on the right edge');
close(hits[0][99].py, MARGIN_TOP + PLOT_HEIGHT, 1e-6, 'y at its low sits on the bottom edge');
close(
  hits[0][50].px,
  MARGIN_LEFT + PLOT_WIDTH * (50 / 99),
  1e-6,
  'x maps through its OWN range (0..99)',
);
close(
  hits[0][50].py,
  MARGIN_TOP + PLOT_HEIGHT * (1 - (500 - 10) / (1000 - 10)),
  1e-6,
  'y maps through its OWN range (10..1000), not x\u2019s',
);
assert.equal(geometry[0].x.name, 'Case 1 · Load');
assert.equal(geometry[0].y.color, '#ff7f0e');
assert.ok(
  drawCalls.some(([text]) => text === 'Case 1 · Load (MWh)'),
  'the x axis is named after its series, unit and all',
);
assert.equal(drawCalls.filter(([text]) => text === 'Case 1 · LMP ($/MWh)').length, 1);

// A NaN in one series removes the hour: the point after it takes its place.
xs.values[3] = NaN;
xyPlot.draw(0, xs, ys);
assert.equal(hits[0].length, 99, 'an hour NaN in either series leaves no point');
assert.equal(hits[0][3].hour, 4, 'the surviving points keep their own hours');

// No overlap at all is a refusal, not an empty plot frame.
const noOverlap = seriesOf('Case 2 · Zero', 'MW', '#2ca02c', () => {});
xyPlot.draw(0, xs, noOverlap);
assert.ok(
  banners.some((text) => /no point to plot/i.test(text)),
  'two series sharing no kept hour are refused in words',
);
assert.equal(geometry[0], null);
assert.equal(canvases[0].style.display, 'none');

// A constant series still draws: the padded range keeps every point finite.
const flat = seriesOf('Case 2 · Flat', 'MW', '#2ca02c', (v) => {
  for (let i = 0; i < 10; i++) v[i] = 5;
});
xyPlot.draw(0, flat, ys);
assert.equal(hits[0].length, 10);
assert.ok(
  hits[0].every((point) => Number.isFinite(point.px) && Number.isFinite(point.py)),
  'a degenerate range is padded, never divided by zero',
);
assert.ok(
  hits[0].every((point) => point.px === hits[0][0].px),
  'a constant x draws one vertical line of points',
);

// The hover names the hour it snapped to, with both series' values.
xyPlot.draw(0, xs, ys);
xyPlot.hover(0, hits[0][98].px, hits[0][98].py);
assert.equal(tips[0].style.display, '');
assert.equal(tips[0].children[0].textContent, 'HE 100', 'the head names the hour');
assert.equal(tips[0].children[1].children[2].textContent, '99', 'the x row shows x\u2019s value');
assert.equal(tips[0].children[2].children[2].textContent, '10', 'the y row shows y\u2019s value');
xyPlot.hover(0, 4, 4);
assert.equal(tips[0].style.display, 'none', 'a hover far from any point shows nothing');

xyPlot.clear(0);
assert.equal(geometry[0], null);
assert.equal(hits[0].length, 0);
assert.equal(canvases[0].style.display, 'none');

console.log(
  'ok - the X-Y renderer, run headlessly: pairs only where both series hold a value, ' +
    'per-axis ranges, padded degenerates, and a hover that names its hour',
);

// ------------------------------------------------------------------- (h)
//
// The fit, checked against closed-form answers.
const { fitLine, fitCaption, fitNumber } = await import('../src/ui/xy-plot.ts');

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
const withoutFit = (() => {
  drawCalls.length = 0;
  xyPlot.draw(0, xs, ys);
  return hits[0][0].py;
})();
drawCalls.length = 0;
xyPlot.draw(0, xs, ys, true);
const caption = drawCalls.find(([text]) => typeof text === 'string' && text.startsWith('y = '));
assert.ok(caption, 'the fit caption is drawn');
assert.ok(
  caption[2] < hits[0].reduce((top, point) => Math.min(top, point.py), Infinity),
  'the caption sits above every plotted point rather than over the cloud',
);
assert.ok(
  hits[0][0].py > withoutFit,
  'the caption band is taken out of the plot: turning the fit on moves the points down, ' +
    'rather than painting text over them',
);

console.log(
  'ok - the fit: OLS of y on x recovered exactly, asymmetric under a swap, vertical and flat ' +
    'clouds answered rather than divided by zero, R² bounded, and a caption in its own band',
);
