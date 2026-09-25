// tests/test_limits_pane.mjs — drawn-limit properties, as source text (the
// renderers import uPlot and cannot load in Node):
//
//   (a) A limit is not a `CaseSeries`, so it stays out of the legend, stats,
//       box and X-Y panes and the ten-line cap.
//   (b) Its dash differs from the preview's.
//   (c) Limits are in the pane signature, so toggling rebuilds the plot.
//   (d) Time pane only (the duration curve's x is a rank).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const charts = readFileSync(join(root, 'src/ui/charts.ts'), 'utf8');
const panes = readFileSync(join(root, 'src/ui/line-panes.ts'), 'utf8');

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`ok - ${label}`);
}

/** One pane's drawing code as text: uPlot panes are functions in
 * `line-panes.ts`; box and X-Y branches in `charts.ts` are anchored on the
 * brace, since a looser anchor returns the whole chain and passes vacuously. */
function branchFor(slot) {
  if (slot === 'time' || slot === 'duration' || slot === 'stacked') {
    const start = panes.indexOf(`function ${slot}(slot: number`);
    assert.ok(start > 0, `line-panes.ts must still declare the ${slot} pane`);
    const end = panes.indexOf('\n  function ', start + 1);
    return panes.slice(start, end < 0 ? panes.length : end);
  }
  const opener = `} else if (slotType === '${slot}') {`;
  const start = charts.indexOf(opener);
  assert.ok(start > 0, `the pane loop must still have a ${slot} branch`);
  const end = charts.indexOf(`} else if (slotType === '`, start + opener.length);
  return charts.slice(start, end < 0 ? charts.length : end);
}

check('(a) a limit is its own type, and is never pushed into the series array', () => {
  assert.match(charts, /export interface DrawnLimit \{/);
  assert.match(charts, /limits\?: DrawnLimit\[\];/, 'ChartsInput carries them separately');
  assert.doesNotMatch(
    charts + panes,
    /series\.push\(/,
    'nothing in the renderer may append to the series array -- a limit that arrived there ' +
      'would reach the legend, the stats table and the ten-line cap',
  );
});

check('(b) the limit dash exists and is not the preview dash', () => {
  const preview = /const PREVIEW_DASH = (\[[^\]]*\]);/.exec(panes);
  const limit = /const LIMIT_DASH = (\[[^\]]*\]);/.exec(panes);
  assert.ok(preview, 'PREVIEW_DASH must still be declared');
  assert.ok(limit, 'LIMIT_DASH must be declared beside it, not reused from the preview');
  assert.notEqual(
    limit[1],
    preview[1],
    'a limit drawn in the preview’s dash makes a pinned line read as a hover preview',
  );
});

check('(c) the limits are part of the time pane’s rebuild signature', () => {
  const time = branchFor('time');
  const wanted = /const wanted =([\s\S]*?);\n/.exec(time);
  assert.ok(wanted, 'the time branch must still build a `wanted` signature');
  assert.match(
    wanted[1],
    /limits/,
    'the signature must vary with the limits, or a toggled-off limit stays on the canvas',
  );
  assert.match(
    time,
    /drawable\.length \+ limits\.length/,
    'the series-count guard must count the limit lines too',
  );
});

check('(d) limits are drawn on the time pane and on no other', () => {
  assert.match(branchFor('time'), /input\.limits/, 'the time branch draws them');
  for (const slot of ['duration', 'stacked', 'box', 'xy']) {
    assert.doesNotMatch(
      branchFor(slot),
      /input\.limits/,
      `the ${slot} branch must not draw limits -- see this file's header for why`,
    );
  }
});

check('the toggle gates the drawing, and no limit takes an extreme marker', () => {
  const time = branchFor('time');
  assert.match(
    time,
    /limitsCheck\.checked \? \(input\.limits \?\? \[\]\) : \[\]/,
    'the one session-wide checkbox decides whether any limit is drawn',
  );
  assert.match(
    time,
    /limits\.map\(\(\) => null\)/,
    'limit lines pass null to markExtremes: the highest point of a limit is not a reading',
  );
});

console.log(`\n${passed} checks passed`);
