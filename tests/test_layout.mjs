// tests/test_layout.mjs — the height chain and the drawer's closed edge, as
// TEXT (no browser harness; charts.ts cannot load in Node). Each fact here
// keeps the charts inside a short window:
//
//   (a) `.pane` and `.pane-body` clip: canvases are fixed-size.
//   (b) `paneSize()` reads the real box, with only a 1px floor for hidden
//       panes (a larger floor makes canvases taller than their boxes).
//   (c) the closed drawer is a handle, not a bar: `.sections` reserves no
//       strip, and the handle sits bottom-right of the chart cell.
//   (d) the handle's count comes from the selection, above the closed early
//       return, so closing the drawer never costs a tab build.

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'src/styles.css'), 'utf8');
const charts = readFileSync(join(root, 'src/ui/charts.ts'), 'utf8');

// Named rather than globbed, for the reason recorded beside the same list in
// tests/test_dom_contract.mjs: src/ui/ holds other browse-*.ts files that
// DEFINE, rather than call, the symbols a needle here looks for.
const DRAWER_MODULES = [
  'src/ui/browse-drawer.ts',
  'src/ui/browse-popovers.ts',
  'src/ui/browse-detent.ts',
].filter((path) => {
  try {
    statSync(join(root, path));
    return true;
  } catch {
    return false;
  }
});
assert.ok(DRAWER_MODULES.length > 0, 'at least one drawer module exists to scan');
assert.ok(
  DRAWER_MODULES.includes('src/ui/browse-drawer.ts'),
  'the drawer module list still includes src/ui/browse-drawer.ts',
);
const drawerSrc = DRAWER_MODULES.map((path) => readFileSync(join(root, path), 'utf8')).join('\n');
const html = readFileSync(join(root, 'index.html'), 'utf8');

/** The declaration block of a flat (non-nested, non-media-query) rule. */
function rule(selector) {
  const start = css.indexOf(selector + ' {');
  assert.ok(start >= 0, `styles.css has a ${selector} rule`);
  const end = css.indexOf('}', start);
  assert.ok(end > start, `styles.css closes the ${selector} rule`);
  return css.slice(start, end);
}

// ------------------------------------------------------------------- (a)
for (const selector of ['.gv-section .pane', '.gv-section .pane-body']) {
  const block = rule(selector);
  assert.match(
    block,
    /overflow:\s*hidden/,
    `${selector} must clip. A chart canvas is fixed-size and paints at exactly the ` +
      'numbers it was handed, so a pane that does not clip lets a canvas drawn for a ' +
      'larger pane escape toward the bottom of the window.',
  );
}

// ------------------------------------------------------------------- (b)
const fn = charts.match(/function paneSize\([\s\S]*?\n  \}/);
assert.ok(fn, 'src/ui/charts.ts still declares paneSize');
assert.match(
  fn[0],
  /getBoundingClientRect/,
  'paneSize measures the pane it is handed; a constant here would be a size ' +
    'no pane ever voted for',
);
const floors = [...fn[0].matchAll(/Math\.max\(\s*(\d+)\s*,/g)].map((m) => m[1]);
assert.deepEqual(
  floors,
  ['1', '1'],
  'the only floor paneSize may keep is the 1px guard against a hidden or unmounted ' +
    `pane measuring zero -- a larger literal is a minimum chart size, which asks for ` +
    `room the pane does not have and draws a canvas taller than its box. Found: ${floors.join(', ')}`,
);

console.log(
  'ok - the height chain clips at .pane and .pane-body, and paneSize reports the real box',
);

// ------------------------------------------------------------------- (c)

const sectionsBlock = rule('.sections');
assert.ok(
  !/padding-bottom/.test(sectionsBlock),
  '.sections must not reserve a strip for the closed drawer. The handle overlays chart ' +
    'content instead of spending height on an affordance, which is the entire point of ' +
    'replacing the full-width bar: the four-pane grid keeps that height at every viewport.',
);

assert.match(
  rule('.browse-drawer'),
  /align-self:\s*end/,
  'the drawer is bottom-pinned in its grid cell, which is what puts the handle flush ' +
    'above the status row rather than over it',
);

const closedBlock = rule(".browse-drawer[data-detent='closed']");
for (const [needle, said] of [
  ['height:\\s*auto', 'height: auto'],
  ['width:\\s*auto', 'width: auto'],
  ['justify-self:\\s*end', 'justify-self: end'],
]) {
  assert.match(
    closedBlock,
    new RegExp(needle),
    `the collapsed drawer is the handle's own box packed to the bottom-right of the ` +
      `chart cell, and ${said} is what makes it one`,
  );
}

assert.match(
  css,
  /\.browse-drawer\[data-detent='closed'\] \.browse-bar,[\s\S]*?display:\s*none/,
  'the closed detent hides the bar itself -- the handle is the one thing it leaves visible, ' +
    'and a handle that also showed the bar would be the full-width bar again',
);
assert.match(
  css,
  /\.browse-handle\s*\{[^}]*display:\s*none/,
  'the handle is hidden while the drawer is open',
);
assert.match(
  css,
  /\.browse-drawer\[data-detent='closed'\] \.browse-handle\s*\{[^}]*display:\s*(?:inline-)?flex/,
  'the handle is displayed only in the closed detent',
);

const handleMarkup = html.match(/<button[^>]*id="browse-handle"[\s\S]*?<\/button>/);
assert.ok(handleMarkup, 'index.html defines the browse handle button');
assert.match(
  handleMarkup[0],
  />Browse</,
  'the handle carries the label "Browse" -- a collapsed drawer with no readable label ' +
    'is a feature nobody finds again',
);
assert.match(
  handleMarkup[0],
  /browse-handle-chevron/,
  'the handle carries a chevron of its own, pointing up at the drawer it opens',
);

// ------------------------------------------------------------------- (d)

const drawFn = drawerSrc.match(/function draw\(\): void \{[\s\S]*?\n  \}/);
assert.ok(drawFn, 'src/ui/browse-drawer.ts still declares draw()');
const closedBranch = drawFn[0].match(/if \(detent === 'closed'\) \{([\s\S]*?)\n    \}/);
assert.ok(closedBranch, 'draw() still short-circuits on the closed detent');
const aboveTheReturn = drawFn[0].slice(0, drawFn[0].indexOf("if (detent === 'closed')"));
assert.match(
  aboveTheReturn,
  /selection\.list\(\)\.length/,
  'the handle count is painted from the selection list, above the closed early return',
);
assert.ok(
  !/\b(?:activeTab|tabFor)\s*\(/.test(aboveTheReturn) &&
    !/\b(?:activeTab|tabFor)\s*\(/.test(closedBranch[1]),
  'the closed detent reaches no tab build -- a handle that cost a ranking pass would ' +
    'make closing the drawer expensive rather than free',
);
assert.match(
  drawerSrc,
  /`Browse · \$\{/,
  'the handle label grows the selection count, so "three series are drawn" stays ' +
    'visible while the drawer is closed',
);
// The handle both reopens and drags. The drag's preventDefault() on
// pointerdown suppresses the derived `click`, so reopening is served on
// release; the click listener is the keyboard's path.
assert.match(
  drawerSrc,
  /openOnRelease && !drag\.moved && e\.type === 'pointerup'/,
  'a press on the handle that never moved reopens the drawer on pointerup. Wiring the ' +
    'reopen to `click` alone is the bug this pins: the drag preventDefault()s pointerdown, ' +
    'which suppresses the click event the handler was waiting for.',
);
assert.match(
  drawerSrc,
  /function openFromHandle\(\)[\s\S]*?applyDetent\(draggedHeight === null \? 'half' : nearestDetent/,
  'and it reopens to the half detent, or to the detent a standing dragged height matches, ' +
    'so the expand/collapse pair step from where the drawer actually is',
);
assert.match(
  drawerSrc,
  /handle\.addEventListener\('click', openFromHandle\)/,
  'the keyboard reaches that same function through click, which fires without a pointer',
);

console.log(
  'ok - the closed drawer is a bottom-right handle that hides the bar, costs no tab build, ' +
    'and reopens on release',
);

// ------------------------------------------------------------------- (f)
//
// The stacked fill is BANDED: each column is a running sum, so unbanded fills
// would reach the axis and the largest would bury the rest. The bands are
// what make it right, so they are pinned with the fill.

// The three uPlot panes are one function each in `src/ui/line-panes.ts`; what
// `charts.ts` keeps is the dispatch.
const panesSrc = readFileSync(join(root, 'src/ui/line-panes.ts'), 'utf8');
const stackedAt = panesSrc.indexOf('function stacked(slot: number');
assert.ok(stackedAt > 0, 'line-panes.ts still declares the stacked pane');
const stackedBranch = panesSrc.slice(stackedAt);

assert.match(
  stackedBranch,
  /fill:\s*withAlpha\(/,
  'a stacked series fills under its curve, at the palette entry reduced -- never at a ' +
    'second colour literal',
);
assert.match(
  stackedBranch,
  /options\.bands\s*=/,
  'and the fills are clipped by bands. Without them the largest cumulative band paints ' +
    'from its curve to the axis and buries every band below it.',
);

const { withAlpha } = await import('../src/ui/palette.ts');
assert.equal(withAlpha('#1f77b4', 0.3), '#1f77b44d');
assert.equal(withAlpha('#1f77b4', 0), '#1f77b400');
assert.equal(withAlpha('#1f77b4', 1), '#1f77b4ff');
assert.equal(
  withAlpha('rebeccapurple', 0.3),
  'rebeccapurple',
  'a colour that is not #rrggbb comes back untouched: an opaque fill is wrong, a ' +
    'colour with two stray hex digits glued on is not a colour at all',
);

// Bands are right-side up only while the running totals rise, so a signed
// series must be refused wherever the fill is drawn.
assert.match(
  stackedBranch,
  /some\(\(v\) => v < 0\)/,
  'the stacked pane refuses a series that goes negative. A falling running total inverts ' +
    'the band between it and its neighbour, and a filled inverted band is a lie about the ' +
    'area under the curves.',
);
const signedRefusal = stackedBranch.indexOf('some((v) => v < 0)');
const bandsAt = stackedBranch.indexOf('options.bands =');
assert.ok(
  signedRefusal >= 0 && signedRefusal < bandsAt,
  'and it refuses BEFORE the bands are built, not after -- a refusal that ran later would ' +
    'have already drawn the inverted fill',
);

console.log(
  'ok - the stacked pane fills under its curves, banded, at a derived alpha, and refuses ' +
    'a series that would invert a band',
);

// ------------------------------------------------------------------- (g)
//
// The chart grid and rail: panes keep a legible minimum and scroll rather
// than crush, the rail collapses via a custom property, focus stays in flow.

const chartGridBlock = rule('.gv-section .chart-grid');
assert.match(
  chartGridBlock,
  /grid-template-rows:\s*repeat\(2,\s*minmax\(240px,\s*1fr\)\)/,
  '.chart-grid uses minmax(240px, 1fr) rows so plots maintain a legible minimum height',
);
assert.match(
  chartGridBlock,
  /overflow-y:\s*auto/,
  '.chart-grid scrolls vertically when container height is constricted',
);

const focusModeBlock = rule('.gv-section .chart-grid.focus-mode');
assert.ok(
  !/position:\s*fixed/.test(focusModeBlock),
  '.chart-grid.focus-mode must not use position: fixed with hardcoded offsets',
);
assert.match(
  focusModeBlock,
  /grid-template-columns:\s*1fr/,
  '.chart-grid.focus-mode fills a single grid column in normal flow',
);

const collapsedBlock = rule('.app-grid.rail-collapsed');
assert.match(
  collapsedBlock,
  /--rail-width:\s*0px/,
  '.app-grid.rail-collapsed collapses --rail-width to 0px',
);

const shellSrc = readFileSync(join(root, 'src/ui/shell.ts'), 'utf8');
assert.match(
  shellSrc,
  /within<HTMLButtonElement>\(chrome,\s*'#rail-toggle-btn'\)/,
  'shell.ts wires the #rail-toggle-btn to toggle the rail',
);
assert.match(
  shellSrc,
  /event\.key === '\['/,
  'shell.ts wires [ keyboard shortcut to toggle the rail',
);

// ------------------------------------------------------------------- (h)
//
// THE RESIZE LOOP. A canvas is sized from its pane's box, so the box must
// never be sized by its content, or canvas, pane and track grow each other
// every frame. Two ways in, both pinned: an `auto` track maximum (min-height
// 0 does not cap a maximum), and a pane note in normal flow.
for (const [selector, body] of [...css.matchAll(/([^{}]*\.chart-grid[^{}]*)\{([^}]*)\}/g)].map(
  (match) => [match[1].trim(), match[2]],
)) {
  const rows = body.match(/grid-template-rows:([^;]*);/);
  if (!rows) continue;
  assert.ok(
    !/\b(auto|max-content|fit-content)\b/.test(rows[1]),
    `${selector} sizes a pane row from its CONTENT (${rows[1].trim()}). The pane's canvas is ` +
      'drawn to fill that row and then counts as its content, so the two grow each other ' +
      'every frame. Give the track a definite basis -- 1fr against the container -- and put ' +
      'the legible minimum in the minmax MINIMUM, which is what 240px is for.',
  );
}

const bannerStack = rule('.gv-section .pane-banners');
assert.match(
  bannerStack,
  /position:\s*absolute/,
  'a pane banner is an OVERLAY. In flow it adds height to `.pane-body`, which is the box ' +
    'the canvas is then sized from -- the note becomes height the chart is drawn to fill, ' +
    'under a note that is still there. Out of flow it cannot move the box it is measured ' +
    'against.',
);
assert.match(
  bannerStack,
  /pointer-events:\s*none/,
  'and it lets pointer events through: an overlay across the pane would otherwise eat the ' +
    'hover the chart under it was going to answer',
);
assert.match(
  charts,
  /function bannerStack\(/,
  'charts.ts puts banners in that overlay container rather than appending them to the pane ' +
    'body -- one function, because every pane module takes `banner` from here',
);

console.log(
  'ok - the resize loop is shut at both ends: no pane row is sized by its content, and a ' +
    'pane note is an overlay rather than height the next measurement reads back',
);

console.log(
  'ok - the chart grid scales responsively with minmax vertical scroll, and the rail collapses cleanly',
);

// The popover checklists scroll rather than squeeze: in a column flex box,
// rows shrink by default and `overflow-y: auto` never fires. Bounded
// container and unshrinkable rows are asserted as a pair.
for (const [container, item] of [
  ['.browse-filter-checklist', '.browse-filter-item'],
  ['.browse-columns-popover-body', '.browse-columns-popover-item'],
]) {
  const containerBlock = rule(container);
  assert.match(
    containerBlock,
    /max-height:/,
    `${container} bounds its own height, or there is nothing for a scrollbar to be about`,
  );
  assert.match(
    containerBlock,
    /overflow-y:\s*auto/,
    `${container} scrolls once its rows exceed that height`,
  );
  assert.match(
    rule(item),
    /flex:\s*0 0 auto/,
    `${item} must not shrink: a column flex child compresses below its content by default, ` +
      `which is how ${container} came to clip every label to a sliver of text with no ` +
      'scrollbar in sight',
  );
}

console.log(
  'ok - the filter checklist and the column chooser scroll when their rows outgrow them, ' +
    'rather than squeezing the rows',
);

// The height chain survives the section's `<details>`: its
// `::details-content` box is content-sized and unclipped by default, which
// would let panes size the grid (and get stuck at double height after a
// focus toggle).
const detailsContent = rule('.gv-section-details[open]::details-content');
for (const [property, pattern] of [
  ['height: 100%', /height:\s*100%/],
  ['min-height: 0', /min-height:\s*0/],
  ['overflow: hidden', /overflow:\s*hidden/],
]) {
  assert.match(
    detailsContent,
    pattern,
    `.gv-section-details[open]::details-content needs ${property}: it is a box in the height ` +
      'chain between the window and the chart grid, and a link that sizes to its content there ' +
      'lets a pane hold itself open at whatever height its canvas was last drawn to',
  );
}

console.log(
  "ok - the <details> wrapper's own content box is in the height chain and carries it, so a " +
    'pane that was expanded and collapsed again comes back to its share of the grid',
);

// ------------------------------------------------------------------- (i)
//
// Batch notes never cover a plot or take height from the panes: they float
// over the rail's corner.
const notesBlock = rule('.sections-notes');
assert.match(
  notesBlock,
  /position:\s*absolute/,
  '.sections-notes floats. In the flow it takes its height off every pane and keeps it ' +
    'until the next drop',
);
assert.match(
  rule('.sections'),
  /position:\s*relative/,
  '.sections is the positioning context for those notes -- without it the card resolves ' +
    'against the viewport and drifts out of the chart area',
);
assert.match(
  notesBlock,
  /left:\s*12px/,
  'the card sits in the RAIL’s corner, not the chart grid’s: an offset that cleared the ' +
    'rail would put it back over a plot',
);
assert.match(
  notesBlock,
  /max-width:\s*max\([^)]*var\(--rail-width/,
  'and it is no wider than the rail, by the SAME --rail-width the grid sizes the rail with, ' +
    'so an open card does not spill over the panes either. The floor in that max is the ' +
    'collapsed rail, where the variable is 0',
);
// Below the drawer, which is the one surface the user opens deliberately.
const notesZ = /z-index:\s*(\d+)/.exec(notesBlock);
const drawerZ = /z-index:\s*(\d+)/.exec(rule('.browse-drawer'));
assert.ok(notesZ && drawerZ, 'both the notes card and the drawer state a z-index');
assert.ok(
  Number(notesZ[1]) < Number(drawerZ[1]),
  'the notes card sits UNDER the browse drawer: with the rail collapsed the two share a ' +
    'corner, and a card painted over a drawer the user just opened covers the rows they ' +
    'opened it to read',
);

assert.match(
  rule('.sections-notes[hidden]'),
  /display:\s*none/,
  'the `display: flex` above has to be beaten for `hidden` to mean anything, or a sync that ' +
    'clears the notes leaves an empty card floating over the rail',
);

// Collapsed, the card keeps the bubble and count, and NEW text arrives
// collapsed with its own count, so a refusal is never hidden behind an old pill
// and an ordinary load never covers the rail.
const shellNotes = readFileSync(join(root, 'src/ui/shell.ts'), 'utf8');
assert.match(
  shellNotes,
  /notesCount\.textContent = collapsed \? String\(count\)/,
  'the collapse control carries the note COUNT, so a collapsed card still says how much ' +
    'there is to read',
);
assert.match(
  shellNotes,
  /if \(notesLine\.textContent !== shownNotes\)[\s\S]{0,120}collapsed = true/,
  'a change of note text collapses the card to its new count; nothing else may reset it, or ' +
    'it cannot be opened at all, since render() syncs on every interaction',
);
assert.match(shellNotes, /let collapsed = true;/, 'the notes card starts collapsed');
assert.ok(
  !/notesCard\.hidden = (?!notes\.length === 0)/.test(shellNotes),
  'the card is hidden only when there are no notes -- never by the collapse control, which ' +
    'collapses to the bubble instead',
);
// A speech bubble, not a hazard sign, which users learn to ignore.
for (const glyph of ['⚠', '❗', '🚨']) {
  assert.ok(
    !shellNotes.includes(glyph),
    'the notes carry no hazard glyph: they are information, and a sign that cries wolf on ' +
      'every ordinary load is read past on the load that matters',
  );
}
assert.match(
  shellNotes,
  /createElementNS\(svg, 'path'\)/,
  'the bubble is a drawn path, not a character: the glyphs for this shape come out as a ' +
    'colour emoji on one system and a missing-character box on another, while a path takes ' +
    'currentColor and matches the theme',
);

console.log(
  'ok - the batch notes float in the rail’s corner, clear of every plot, collapse to a ' +
    'bubble and a count rather than to nothing, and arrive collapsed when what they say changes',
);
