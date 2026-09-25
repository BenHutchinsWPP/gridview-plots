// tests/test_pane_note.mjs — what a pane header may say, checked as source
// text (charts.ts cannot load in Node). One section's panes draw every kind,
// so a header says only what its SLOT knows.
//
//   (a) `ChartsHooks` has no header-note or stats-table members;
//   (b) every pane header is cleared on each render;
//   (c) only X-Y, heatmap and box slots write one;
//   (d) the box pane names its dimension only outside pane 3 (which holds the
//       control);
//   (e) the weighted-mean qualifier is per legend row;
//   (f) the legend states the full path, not the plots' shorthand;
//   (g) an empty pane names the missing step (`emptyPaneText`): a file with
//       no Case, a pinned row otherwise.

import './test_loader.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8');

const charts = read('src/ui/charts.ts');
const section = read('src/tables/area/ui/section.ts');
const html = read('index.html');

// ------------------------------------------------------------------- (a)
const hooks = charts.slice(
  charts.indexOf('export interface ChartsHooks {'),
  charts.indexOf('export type SlotType'),
);
assert.ok(hooks.length > 0, 'ChartsHooks is declared in src/ui/charts.ts');
for (const member of ['paneNote', 'statsColumns', 'statsCells', 'statsFootnote', 'seriesColumn']) {
  assert.ok(
    !hooks.includes(member),
    `ChartsHooks declares no ${member}: a pane header is the slot's to write, ` +
      'and the stats table belongs to the browse drawer',
  );
}
assert.ok(
  !charts.includes('hooks.paneNote') && !section.includes('paneNote'),
  'nothing calls or supplies a kind-written pane note',
);

// ------------------------------------------------------------------- (b)
assert.ok(
  charts.includes("headerNote(root, i + 1, '');"),
  'every pane header is cleared at the top of the per-slot loop',
);

// ------------------------------------------------------------------- (c)
const writes = [...charts.matchAll(/headerNote\(\s*root,\s*i \+ 1,\s*([^\n]*)/g)].map((m) =>
  m[1].trim(),
);
assert.equal(
  writes.length,
  4,
  'four headerNote writes: the clear, plus X-Y, heatmap and box. ' + `Found: ${writes.join(' | ')}`,
);
assert.ok(
  writes.some((text) => text.startsWith('`X ')),
  'the X-Y slot names which series is on X and which on Y',
);
assert.ok(
  writes.some((text) => text.startsWith('`by ')),
  'the box slot names the dimension its boxes are cut on',
);
assert.match(
  charts,
  /slotType === 'heatmap'[\s\S]*?headerNote\(\s*root,\s*i \+ 1,\s*\n?\s*`\$\{s\.name\}\$\{drawable\.length > 1/,
  'the heatmap slot names which of the drawn series it painted',
);

// ------------------------------------------------------------------- (d)
assert.match(
  charts,
  /if \(i !== 2\) headerNote\(root, i \+ 1, `by \$\{boxDimLabel\(\)\}`\)/,
  'the box pane states its dimension except in the pane that owns the control',
);
const dimSelects = [...html.matchAll(/data-el="box-dim-select"/g)];
assert.equal(
  dimSelects.length,
  1,
  'index.html carries exactly one box-dim select, which is what makes the ' +
    'pane-3 exception above the right one',
);
assert.match(
  html,
  /<div data-pane="3" class="pane">[\s\S]*?data-el="box-dim-select"[\s\S]*?<\/div>\s*<div data-pane="3-body"/,
  'that select sits in pane 3',
);

// ------------------------------------------------------------------- (e)
assert.match(
  charts,
  /s\.weightColumn[\s\S]{0,400}?weighted mean by \$\{s\.weightColumn\}/,
  'the legend row carries the weighted-mean qualifier, beside the Mean it qualifies',
);
assert.match(
  charts,
  /const signature = drawable[\s\S]*?s\.weightColumn/,
  'the legend signature includes weightColumn, or a change in weighting ' +
    'would not repaint the table',
);

// ------------------------------------------------------------------- (f)
assert.match(
  charts,
  /pane-legend-label'?;?[\s\S]{0,200}?s\.facets \? subjectLabel\(s\.facets\) : s\.name/,
  'the legend names the subject from the facets, falling back to the short name only ' +
    'for a series built without a browse row',
);
assert.match(
  charts,
  /contextLabel\(s\.facets\)/,
  'and states beneath it the Case, the kind and the quantity the subject was found on',
);
assert.match(
  charts,
  /tr\.title = s\.detail \?\? s\.name;/,
  "the row's own tooltip is the full label, so even a truncated cell can be read in full",
);

// ------------------------------------------------------------------- (g)
assert.doesNotMatch(
  charts,
  /Drop a CSV export to begin/,
  'charts.ts spells no empty-pane text of its own: its empty branch fell back to the ' +
    'empty-app sentence whether or not a Case was loaded',
);
assert.match(
  charts,
  /drawable\.length === 0\) \{[\s\S]*?banner\(body, 'refusal', emptyPaneText\(input\)\);/,
  'the empty branch says what emptyPaneText says',
);
assert.match(
  read('src/ui/box-plot.ts'),
  /input\.series\.length === 0\s*\?\s*emptyPaneText\(input\)/,
  'the box pane, which a resize redraws with no series at all, says the same: it said ' +
    '"Nothing to plot with these filters." with no Case loaded and with nothing pinned',
);
assert.match(
  read('src/main.ts'),
  /charts\.render\(\{[\s\S]*?hasCases: caseStore\.listCases\(\)\.length > 0,/,
  'main.ts hands the charts whether any Case is loaded, as a plain fact',
);
{
  const { emptyPaneText } = await import('../src/ui/chart-format.ts');
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
