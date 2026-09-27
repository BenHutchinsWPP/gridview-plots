// tests/test_layout.mjs — the height chain and the drawer's closed edge.
// Layout needs a browser, so the CSS and markup are read as TEXT; the
// modules that load in Node (the drawer's detents, the stacked adapter over
// tests/test_fixtures_uplot.mjs, the shell's notes and rail) are run against
// the fake DOM. Each fact here keeps the charts inside a short window:
//
//   (a) `.pane` and `.pane-body` clip: canvases are fixed-size.
//   (b) `paneSize()` reads the real box, with only a 1px floor for hidden
//       panes (a larger floor makes canvases taller than their boxes);
//       asserted in tests/test_panes.mjs.
//   (c) the closed drawer is a handle, not a bar: `.sections` reserves no
//       strip, and the handle sits bottom-right of the chart cell.
//   (d) the handle's count comes from the selection, above the closed early
//       return, so closing the drawer never costs a tab build.

import './test_loader.mjs';
import './test_fixtures_uplot.mjs';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plots } from './test_fixtures_uplot.mjs';
import {
  FakeElement,
  fakeChrome,
  frameOf,
  installFakeDom,
  keydown,
  stubHost,
} from './test_fixtures_dom.mjs';

installFakeDom();
const { createBrowseDetent } = await import('../src/ui/browse-detent.ts');
const { createStackedAdapter } = await import('../src/ui/panes/line.ts');
const { createChrome, createSectionHost } = await import('../src/ui/shell.ts');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'src/styles.css'), 'utf8');

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

console.log('ok - the height chain clips at .pane and .pane-body');

// ------------------------------------------------------------------- (b)
//
// `paneSize()` (src/ui/panes/pane.ts) loads in Node, so its 1px floor is
// asserted as behaviour in tests/test_panes.mjs (h).

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
// release; the click listener is the keyboard's path. Run through the
// detents' own module, in a chart cell 800px tall (half 400, full 680).
function detentRig() {
  const grid = new FakeElement();
  const drawerRoot = grid.appendChild(new FakeElement());
  drawerRoot.rect = { bottom: 900, width: 400, height: 0 };
  const handle = new FakeElement('button');
  let opened = 0;
  const detent = createBrowseDetent({
    root: drawerRoot,
    handle,
    resizeStrip: new FakeElement(),
    expandButton: new FakeElement('button'),
    collapseButton: new FakeElement('button'),
    closePopover: () => {},
    onOpen: () => opened++,
  });
  const pointer = (type, clientY) => ({
    type,
    button: 0,
    pointerId: 1,
    clientY,
    preventDefault() {},
  });
  return { detent, handle, drawerRoot, pointer, opened: () => opened };
}
globalThis.getComputedStyle = () => ({ gridTemplateRows: '40px 800px 30px' });
{
  const { detent, handle, drawerRoot, pointer } = detentRig();
  handle.fire('pointerdown', pointer('pointerdown', 500));
  drawerRoot.fire('pointerup', pointer('pointerup', 500));
  assert.equal(
    detent.detent(),
    'half',
    'a press on the handle that never moved reopens the drawer on pointerup. Wiring the ' +
      'reopen to `click` alone is the bug this pins: the drag preventDefault()s pointerdown, ' +
      'which suppresses the click event the handler was waiting for.',
  );
}
{
  const { detent, handle, drawerRoot, pointer } = detentRig();
  handle.fire('pointerdown', pointer('pointerdown', 500));
  drawerRoot.fire('pointercancel', pointer('pointercancel', 500));
  assert.equal(detent.detent(), 'closed', 'a cancelled press is not a click');
}
{
  const { detent, handle } = detentRig();
  handle.fire('click');
  assert.equal(
    detent.detent(),
    'half',
    'the keyboard reaches the same reopen through click, which fires without a pointer',
  );
}
{
  const { detent, handle } = detentRig();
  detent.restoreHeight(640);
  assert.equal(detent.detent(), 'closed', 'a restored height never opens the drawer');
  handle.fire('click');
  assert.equal(
    detent.detent(),
    'full',
    'and the handle reopens to the detent a standing dragged height matches, so the ' +
      'expand/collapse pair step from where the drawer actually is',
  );
}

console.log(
  'ok - the closed drawer is a bottom-right handle that hides the bar, costs no tab build, ' +
    'and reopens on release',
);

// ------------------------------------------------------------------- (f)
//
// The stacked fill is BANDED: each column is a running sum, so unbanded fills
// would reach the axis and the largest would bury the rest. The bands are
// what make it right, so they are pinned with the fill.

// The stacked adapter (`src/ui/panes/line.ts`), drawn over the uPlot stand-in.
const { withAlpha } = await import('../src/ui/palette.ts');
const stackedLine = (name, color, value) => ({
  name,
  color,
  unit: 'MW',
  values: new Float32Array(8760).fill(value),
  warnings: [],
});
const STACK = [
  stackedLine('SAMPLE A', '#1f77b4', 1),
  stackedLine('SAMPLE B', '#ff7f0e', 2),
  stackedLine('SAMPLE C', '#2ca02c', 3),
];
{
  const { host } = stubHost();
  const stacked = createStackedAdapter(host);
  plots.length = 0;
  stacked.draw(frameOf(STACK));
  assert.equal(plots.length, 1, 'the stacked pane builds one plot');
  const drawn = plots[0].series.slice(1);
  assert.equal(drawn.length, STACK.length);
  for (const series of drawn) {
    assert.ok(
      typeof series.fill === 'string' &&
        series.fill.length === 9 &&
        series.fill.startsWith(series.stroke) &&
        series.fill !== withAlpha(series.stroke, 1) &&
        series.fill !== withAlpha(series.stroke, 0),
      `a stacked series fills under its curve, at its palette entry reduced -- never at a ` +
        `second colour literal (stroke ${series.stroke}, fill ${series.fill})`,
    );
  }
  assert.deepEqual(
    plots[0].bands,
    [{ series: [2, 1] }, { series: [3, 2] }],
    'and the fills are clipped by bands, each from its curve down to the one below. Without ' +
      'them the largest cumulative band paints from its curve to the axis and buries every ' +
      'band below it.',
  );
}

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
{
  const { host, record } = stubHost();
  const stacked = createStackedAdapter(host);
  plots.length = 0;
  stacked.draw(frameOf(STACK));
  const standing = plots[0];
  const signed = stackedLine('SAMPLE signed', '#d62728', 1);
  signed.values[100] = -1;
  stacked.draw(frameOf([...STACK, signed]));
  assert.deepEqual(
    record.banners.map((banner) => banner.kind),
    ['refusal'],
    'the stacked pane refuses a series that goes negative. A falling running total inverts ' +
      'the band between it and its neighbour, and a filled inverted band is a lie about the ' +
      'area under the curves.',
  );
  assert.match(record.banners[0].text, /^SAMPLE signed goes negative/, 'naming the series');
  assert.equal(
    plots.length,
    1,
    'and it refuses BEFORE a plot is built, not after -- a refusal that ran later would ' +
      'have already drawn the inverted fill',
  );
  assert.ok(standing.destroyed, 'the plot it stood on is taken down with it');
  assert.equal(host.uplotHost.style.display, 'none');
}

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

{
  const chrome = fakeChrome();
  createChrome(chrome, {});
  const toggle = chrome.querySelector('#rail-toggle-btn');
  toggle.fire('click');
  assert.ok(
    chrome.classList.contains('rail-collapsed'),
    'the #rail-toggle-btn collapses the rail, by the class the CSS above keys on',
  );
  document.fire('keydown', keydown('['));
  assert.ok(!chrome.classList.contains('rail-collapsed'), 'and [ toggles it back');
  document.fire('keydown', keydown('[', new FakeElement('input')));
  assert.ok(!chrome.classList.contains('rail-collapsed'), 'but not while typing in a field');
}

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
// That panes/pane.ts puts every banner in that overlay container, never
// straight into the pane body, is behaviour in tests/test_panes.mjs (f).

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
// Batch notes live at the status bar's right end, collapsed to a count, so
// they cover nothing until opened, the rail's slicers included. Open, they
// rise over the charts and never reach the rail.
const notesBlock = rule('.sections-notes');
const notesBody = rule('.sections-notes-body');
const mainTs = readFileSync(join(root, 'src/main.ts'), 'utf8');
assert.match(
  mainTs,
  /createSectionHost\(sectionHost, sectionTemplate, statusBar\)/,
  'the notes are mounted in the status bar, which is on screen with or without a section',
);
assert.match(notesBlock, /position:\s*relative/, 'the card anchors its own body');
assert.match(
  notesBody,
  /position:\s*absolute/,
  'the open body floats. In the flow it would take height off every pane',
);
assert.match(notesBody, /bottom:\s*calc\(100%/, 'the body rises above the status bar');
assert.match(notesBody, /right:\s*0/, 'from the right end, away from the rail');
assert.match(
  notesBody,
  /max-width:\s*min\([^;]*var\(--rail-width/,
  'and no wider than the space right of the rail, by the SAME --rail-width the grid sizes ' +
    'the rail with, so an open card never covers the filters or slicers',
);
// Above the drawer: opening the notes is as deliberate as opening the drawer,
// and the drawer fills the space the body opens into.
const notesZ = /z-index:\s*(\d+)/.exec(notesBody);
const drawerZ = /z-index:\s*(\d+)/.exec(rule('.browse-drawer'));
const busyZ = /z-index:\s*(\d+)/.exec(rule('.busy-overlay'));
assert.ok(notesZ && drawerZ && busyZ, 'the notes body, drawer and busy overlay state a z-index');
assert.ok(
  Number(notesZ[1]) > Number(drawerZ[1]) && Number(notesZ[1]) < Number(busyZ[1]),
  'the open notes sit over the browse drawer and under the busy overlay',
);

assert.match(
  rule('.sections-notes[hidden]'),
  /display:\s*none/,
  'the `display: flex` above has to be beaten for `hidden` to mean anything, or a sync that ' +
    'clears the notes leaves an empty bubble in the status bar',
);

// Collapsed, the card keeps the bubble and count, and NEW text arrives
// collapsed with its own count, so a refusal is never hidden behind an old pill
// and an ordinary load never covers the rail.
{
  const statusBar = new FakeElement();
  const sections = createSectionHost(new FakeElement(), {}, statusBar);
  const card = statusBar.querySelector('.sections-notes');
  const toggle = card.querySelector('.sections-notes-toggle');
  const count = card.querySelector('.sections-notes-count');
  const collapsed = () => card.dataset.collapsed === 'true';

  sections.sync(true, ['SAMPLE one', 'SAMPLE two']);
  assert.ok(collapsed(), 'the notes card starts collapsed');
  assert.equal(
    count.textContent,
    '2',
    'the collapse control carries the note COUNT, so a collapsed card still says how much ' +
      'there is to read',
  );
  toggle.fire('click');
  assert.ok(!collapsed(), 'the control opens the card');
  sections.sync(true, ['SAMPLE one', 'SAMPLE two']);
  assert.ok(
    !collapsed(),
    'a sync of the same text leaves it open: render() syncs on every interaction, so a ' +
      'reset there would mean the card cannot be opened at all',
  );
  sections.sync(true, ['SAMPLE one', 'SAMPLE two', 'SAMPLE three']);
  assert.ok(collapsed(), 'a change of note text collapses the card to its new count');
  assert.equal(count.textContent, '3');
  toggle.fire('click');
  toggle.fire('click');
  assert.equal(
    card.hidden,
    false,
    'the card is hidden only when there are no notes -- never by the collapse control, which ' +
      'collapses to the bubble instead',
  );
  sections.sync(true, []);
  assert.equal(card.hidden, true, 'and with no notes it is hidden');

  // A speech bubble, not a hazard sign, which users learn to ignore.
  sections.sync(true, ['SAMPLE one']);
  const drawn = [card, ...card.descendants()];
  for (const glyph of ['⚠', '❗', '🚨']) {
    assert.ok(
      !drawn.some(
        (node) =>
          node !== card.querySelector('.sections-notes-body') && node.textContent.includes(glyph),
      ),
      'the notes carry no hazard glyph: they are information, and a sign that cries wolf on ' +
        'every ordinary load is read past on the load that matters',
    );
  }
  const bubble = drawn.find((node) => node.tagName === 'PATH');
  assert.ok(
    bubble && toggle.contains(bubble) && bubble.getAttribute('fill') === 'currentColor',
    'the bubble is a drawn path, not a character: the glyphs for this shape come out as a ' +
      'colour emoji on one system and a missing-character box on another, while a path takes ' +
      'currentColor and matches the theme',
  );
}

console.log(
  'ok - the batch notes float in the rail’s corner, clear of every plot, collapse to a ' +
    'bubble and a count rather than to nothing, and arrive collapsed when what they say changes',
);
