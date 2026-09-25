// tests/test_dom_contract.mjs
//
// DOM rules checked as a STATIC scan of source text. Sections are clones of
// one `<template>`, so a global by-id lookup silently wires one section's
// controls to another's charts; nothing throws, so only a scan catches it.
// Read as text because charts.ts imports uplot and CSS (and there is no
// jsdom here).
//
//   (a) no global element lookup in any section/modal module
//   (b) every `data-` hook those modules query exists in the template
//   (c) exactly one persistent keydown listener, in ui/shell.ts
//   (d) every `#id` those modules resolve exists in index.html
//   (e) drawer drag couplings, and the drawer and dialog wiring below
//
// It globs `src/ui/`, `src/figure/` and `src/tables/*/ui/`, so new modules are
// covered.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8');

/** Every `.ts` file directly inside `directory`, or [] when it does not exist. */
function tsFilesIn(directory) {
  let entries;
  try {
    entries = readdirSync(join(root, directory));
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `${directory}/${name}`)
    .sort();
}

/** Every `src/tables/<kind>/ui/` directory that exists today. */
function tableUiDirectories() {
  let kinds;
  try {
    kinds = readdirSync(join(root, 'src/tables'));
  } catch {
    return [];
  }
  return kinds
    .filter((kind) => {
      try {
        return statSync(join(root, 'src/tables', kind)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((kind) => `src/tables/${kind}/ui`)
    .sort();
}

const modulePaths = [
  tsFilesIn('src/ui'),
  tsFilesIn('src/figure'),
  ...tableUiDirectories().map(tsFilesIn),
].flat();

// A shrinking glob is a silently disabled test, so pin the floor: the modules
// that exist today must still be scanned.
assert.ok(
  modulePaths.includes('src/ui/shell.ts') && modulePaths.includes('src/ui/dom.ts'),
  `the glob found src/ui/shell.ts and src/ui/dom.ts (found: ${modulePaths.join(', ')})`,
);
assert.ok(
  modulePaths.includes('src/figure/dialog.ts'),
  `the glob found src/figure/dialog.ts (found: ${modulePaths.join(', ')})`,
);
assert.ok(
  modulePaths.includes('src/ui/charts.ts'),
  `the glob found src/ui/charts.ts (found: ${modulePaths.join(', ')})`,
);
assert.ok(
  modulePaths.includes('src/tables/area/ui/section.ts') &&
    modulePaths.includes('src/tables/interface/ui/picker.ts'),
  "the glob still reaches src/tables/*/ui/ -- a kind's section resolves its own hooks, and " +
    `every kind's picker builds a modal subtree (found: ${modulePaths.join(', ')})`,
);

const modules = modulePaths.map((path) => [path, read(path)]);

// ------------------------------------------------------------------- (a)
//
// Global LOOKUP is banned, not the DOM (`createElement` is fine); modules
// reach elements through a handed root and `within(root, ...)`. The needles
// are banned as TEXT, comments included, so write "a global by-id lookup" in
// prose.
const BANNED = ['getElementById', 'document.querySelector', 'document.body.querySelector'];

const globalLookups = [];
for (const [path, text] of modules) {
  for (const needle of BANNED) {
    let index = text.indexOf(needle);
    while (index >= 0) {
      const line = text.slice(0, index).split('\n').length;
      globalLookups.push(`${path}:${line}: ${needle}`);
      index = text.indexOf(needle, index + needle.length);
    }
  }
}
assert.deepEqual(
  globalLookups,
  [],
  'no global element lookup in src/ui/*.ts or src/tables/*/ui/*.ts. ' +
    'Resolve inside the root the module was handed, with within(root, ...) from src/ui/dom.ts. ' +
    'The needles are banned in comments too -- write "a global by-id lookup" in prose. Found:\n' +
    globalLookups.join('\n'),
);

// ------------------------------------------------------------------- (b)
const html = read('index.html');
const templateStart = html.indexOf('<template id="section-template">');
assert.ok(templateStart >= 0, 'index.html has a <template id="section-template">');
const templateEnd = html.indexOf('</template>', templateStart);
assert.ok(templateEnd > templateStart, 'that template is closed');
const template = html.slice(templateStart, templateEnd);

/** Hooks the module QUERIES: `[data-el="x"]`, bracketed as a selector. */
const QUERIED = /\[data-(el|pane|slot)="([^"]*)"\]/g;
/** Hooks the markup DEFINES: the same attribute without the brackets. */
const DEFINES = /(?<!\[)data-(el|pane|slot)="([^"]*)"/g;

const defined = new Set();
for (const [, attribute, name] of template.matchAll(DEFINES))
  defined.add(`data-${attribute}="${name}"`);
assert.ok(defined.size > 0, 'the template defines at least one data- hook');

const missing = [];
const dynamic = [];
for (const [path, text] of modules) {
  for (const [, attribute, name] of text.matchAll(QUERIED)) {
    const hook = `data-${attribute}="${name}"`;
    // A hook assembled from a variable cannot be matched against the template,
    // so it is not allowed to exist -- spell the four panes out instead.
    if (name.includes('${')) dynamic.push(`${path}: ${hook}`);
    else if (!defined.has(hook)) missing.push(`${path}: ${hook}`);
  }
}
assert.deepEqual(
  dynamic,
  [],
  'every data- hook selector is a literal, so this test can match it against index.html. Found:\n' +
    dynamic.join('\n'),
);
assert.deepEqual(
  missing,
  [],
  "every data- hook queried by a section module exists in index.html's " +
    '<template id="section-template">. Missing:\n' +
    missing.join('\n'),
);

// The Slicers pane is in the section clone's rail, but the drawer (global
// chrome) owns the views it shows: main.ts finds it inside the section root
// and hands it over, so no module resolves it globally.
assert.ok(defined.has('data-el="slicer-pane"'), 'the section template has the Slicers pane');
assert.ok(
  template.indexOf('data-el="slicer-pane"') > template.indexOf('data-el="reset-filters-btn"') &&
    template.indexOf('data-el="slicer-pane"') < template.indexOf('data-el="chart-area"'),
  'the Slicers pane sits in the left rail under the time filters',
);
assert.match(
  read('src/main.ts'),
  /createBrowseDrawer\([\s\S]*?within\(areaRoot, '\[data-el="slicer-pane"\]'\),\s*\);/,
  'main.ts hands the drawer the Slicers pane found inside the section root',
);
console.log('ok - the Slicers pane is in the section rail and handed to the drawer by main.ts');

// ------------------------------------------------------------------- (c)
/** Every `.ts` file under src/, recursively. */
function tsFilesUnder(directory) {
  const found = [];
  for (const name of readdirSync(join(root, directory))) {
    const relative = `${directory}/${name}`;
    if (statSync(join(root, relative)).isDirectory()) found.push(...tsFilesUnder(relative));
    else if (name.endsWith('.ts')) found.push(relative);
  }
  return found.sort();
}

// A document keydown listener must be removed again, count for count (modals
// do this), except the one persistent owner in src/ui/shell.ts.
const KEYDOWN_ADD = "document.addEventListener('keydown'";
const KEYDOWN_REMOVE = "document.removeEventListener('keydown'";

function sitesOf(text, needle) {
  const sites = [];
  let index = text.indexOf(needle);
  while (index >= 0) {
    sites.push(text.slice(0, index).split('\n').length);
    index = text.indexOf(needle, index + needle.length);
  }
  return sites;
}

const persistent = [];
const unbalanced = [];
for (const path of tsFilesUnder('src')) {
  const text = read(path);
  const added = sitesOf(text, KEYDOWN_ADD);
  if (added.length === 0) continue;
  const removed = sitesOf(text, KEYDOWN_REMOVE);
  if (removed.length === 0) {
    for (const line of added) persistent.push(`${path}:${line}`);
  } else if (removed.length !== added.length) {
    unbalanced.push(`${path}: ${added.length} registered, ${removed.length} removed`);
  }
}

assert.deepEqual(
  unbalanced,
  [],
  'a transient keydown listener is removed exactly as often as it is registered. Found:\n' +
    unbalanced.join('\n'),
);
assert.equal(
  persistent.length,
  1,
  'exactly one persistent document keydown listener in src/ -- two sections each ' +
    'registering their own would both fire for every keystroke, so pane focus would ' +
    'toggle in the section the user is not looking at. Found: ' +
    (persistent.join(', ') || 'none'),
);
assert.ok(
  persistent[0].startsWith('src/ui/shell.ts:'),
  'the one persistent keydown listener is in src/ui/shell.ts, which dispatches to the ' +
    `focused section. Found: ${persistent[0]}`,
);

// ------------------------------------------------------------------- (d)
//
// Global chrome keeps its ids (it exists once); modules reach it through
// within(chrome, '#id'), so those ids are checked against index.html too.
const ID_SELECTOR = /within(?:<[^>]*>)?\(\s*[A-Za-z_$][\w$]*\s*,\s*'(#[A-Za-z][-\w]*)'\s*\)/g;
const missingIds = [];
for (const [path, text] of modules) {
  for (const [, selector] of text.matchAll(ID_SELECTOR)) {
    if (!html.includes(`id="${selector.slice(1)}"`)) missingIds.push(`${path}: ${selector}`);
  }
}
assert.deepEqual(
  missingIds,
  [],
  'every #id resolved with within(...) exists in index.html. Missing:\n' + missingIds.join('\n'),
);

// ------------------------------------------------------------------- (e)
//
// The draggable drawer's couplings:
//   1. the tab-cache key has no height term (a resize must not re-rank);
//   2. `applyHeight` rebuilds nothing;
//   3. TS detent shares equal the CSS fallbacks for `--browse-drawer-height`;
//   4. the mirrored bar and pane-header lengths match styles.css.
// Plus the markup: the grip exists, and closed hides it.

// Scanned against the drawer's own modules, NAMED, never globbed: the other
// `browse-*.ts` files DEFINE the functions these needles look for the drawer
// CALLING, so a glob would make every assertion pass vacuously.
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
const drawer = DRAWER_MODULES.map(read).join('\n');
const drawerHeight = read('src/ui/drawer-height.ts');
const css = read('src/styles.css');

assert.ok(
  drawer.includes("const key = `${id}|${view.groupBy ?? ''}|${activePu ? 'pu' : 'abs'}`;"),
  'browse-drawer.ts caches a built tab under id, group-by and per-unit, and nothing else. ' +
    'Height is deliberately not part of that key -- a drag must not rebuild a tab -- so if this ' +
    'line changed to add a term, check the drag is not the reason.',
);

const applyAt = drawer.indexOf('function applyHeight');
assert.ok(applyAt >= 0, 'browse-drawer.ts defines applyHeight');
const applyEnd = drawer.indexOf('\n  }', applyAt);
assert.ok(applyEnd > applyAt, 'applyHeight has a body to check');
assert.ok(
  !drawer.slice(applyAt, applyEnd).includes('draw('),
  'applyHeight resizes the drawer without calling draw(): a drag fires one call per ' +
    'pointermove, and draw() re-renders tabs. Height is CSS-only, and it stays that way.',
);

// Opening must repaint (renders are skipped while closed), keyed on the
// transition out of closed so dragging between open heights stays free.
assert.match(
  drawer,
  /const opening = detent === 'closed' && next !== 'closed';[\s\S]{0,400}?if \(opening\) deps\.onOpen\(\);/,
  'browse-detent.ts calls onOpen exactly when the detent leaves closed',
);
assert.ok(
  drawer.includes('onOpen: () => draw(),'),
  'browse-drawer.ts answers onOpen with draw(), so a reopened drawer shows the current state',
);

// Scroll position survives a repaint of the same tab: read before the rows
// are replaced, written after they land (the holder clamps against the new
// height).
const table = read('src/ui/browse-table.ts');
const applyRowsAt = table.indexOf('function apply(');
assert.ok(applyRowsAt >= 0, 'browse-table.ts defines apply');
const applyRows = table.slice(applyRowsAt, table.indexOf('\n  }\n', applyRowsAt));
const readAt = applyRows.indexOf('const keepTop =');
const replaceAt = applyRows.indexOf('grid.replaceData(');
const writeAt = applyRows.indexOf('holder.scrollTop = keepTop');
assert.ok(
  readAt >= 0 && replaceAt > readAt && writeAt > replaceAt,
  'apply reads the scroll position before it replaces the rows and writes it back once they ' +
    'land. Either half on the wrong side and a tick sends the analyst back to row 1.',
);
assert.ok(
  applyRows.includes('tabId === tab.id'),
  'the carried scroll position is per tab: a different tab is a different list, and the top ' +
    'is the right place to land in it.',
);
// The clicked cell survives a reload of the same tab, even two reloads in one
// moment (a click's preview, then the chart render, on the Selected tab,
// which is rebuilt on every draw). Tabulator resets the range as a load's
// data is processed, so a draw while a load is in flight reuses that load's
// recorded range instead of reading the reset one.
assert.ok(
  /loading > 0 \? inFlightAnchor : rangeAnchor\(\)/.test(applyRows) &&
    applyRows.indexOf('loading++') < replaceAt &&
    /if \(--loading === 0\) inFlightAnchor = null;/.test(applyRows) &&
    applyRows.indexOf('if (anchor) restoreRange(anchor);') > replaceAt,
  'apply records the range once per burst of loads and puts it back after each; reading it ' +
    'during a load in flight would put back the top-left cell.',
);
console.log('ok - a click keeps its cell through overlapping reloads of the same tab');

/** One CSS rule's body, as text: from the selector to the closing brace. */
function cssBlock(text, selector) {
  const at = text.indexOf(`${selector} {`);
  if (at < 0) return '';
  return text.slice(at, text.indexOf('\n}', at));
}

for (const [share, fallback] of [
  ['half: 0.5', 'height: var(--browse-drawer-height, 50%);'],
  ['full: 0.85', 'height: var(--browse-drawer-height, 85%);'],
]) {
  assert.ok(drawerHeight.includes(share), `src/ui/drawer-height.ts declares ${share}`);
  assert.ok(
    css.includes(fallback),
    `src/styles.css carries ${fallback}, matching drawer-height.ts's ${share}. The snap math ` +
      'and the CSS must agree or a drag snaps to a height the stylesheet does not draw.',
  );
}

for (const [constant, block] of [
  ['BAR_HEIGHT_PX = 36', cssBlock(css, '.browse-bar')],
  ['PANE_HEADER_PX = 28', cssBlock(css, '.gv-section .pane-header')],
]) {
  const height = block.match(/height: (\d+)px;/)?.[1];
  assert.ok(drawerHeight.includes(constant), `src/ui/drawer-height.ts declares ${constant}`);
  assert.ok(
    block && height === constant.split('= ')[1],
    `the drag range's ${constant} matches the height its styles.css rule paints ` +
      `(${height ?? 'no such rule'}). Change them together or the clamp guards the wrong pixels.`,
  );
}

assert.ok(
  html.includes('id="browse-resize"'),
  'index.html carries the #browse-resize grip inside the browse drawer',
);
assert.ok(
  css.includes(".browse-drawer[data-detent='closed'] .browse-resize"),
  "closed hides the resize strip along with the bar -- the handle is the closed state's " +
    'one grip, and a strip with no drawer behind it is a dead edge.',
);

//
// Grouped-tab wiring (the model half is in test_browse.mjs):
//   1. the grouped build gets the keep-set and restated context through the
//      model's two functions;
//   2. with a group-by, the filter box commits on leave, not per keystroke;
//   3. a filter change evicts the tab's grouped builds (the cache key names no
//      filter).
//
assert.ok(
  drawer.includes('keptRowKeys(base, view)') &&
    drawer.includes('carryFilterContext(tab, base, view)'),
  'browse-drawer.ts feeds a grouped build the keep-set and carries the filter ' +
    'context onto the tab it returns; test_browse.mjs asserts what the two functions do, ' +
    'this asserts the drawer actually calls them.',
);
assert.ok(
  drawer.includes('focusout') &&
    drawer.includes('const commitOnly = viewOf(activeId).groupBy != null;'),
  'the filter popover commits on blur (focusout) or Enter when a group-by is active on ' +
    'the tab, and types live otherwise; the two paths are one condition, not two boxes.',
);
const setViewAt = drawer.indexOf('const setView =');
const evictAt = drawer.indexOf('evictGrouped(tabId)');
assert.ok(
  setViewAt >= 0 && evictAt > setViewAt,
  'setView evicts the tab\u2019s grouped builds when its filters change: the tab cache key ' +
    'is id, group-by and per-unit only, so without the eviction a filter edit would ' +
    'redraw the old aggregate under the new context column.',
);

//
// The CSV download button is an id in the drawer's markup (not a template
// data- hook, which would collide per section), and the file comes from the
// pure builder test_browse.mjs checks, never a second serializer.
//
assert.ok(
  html.includes('id="browse-download"'),
  'index.html carries the #browse-download button in the browse drawer’s own chrome',
);
assert.ok(
  drawer.includes('browseTableCsv('),
  'browse-drawer.ts builds its CSV through browseTableCsv (src/ui/browse-csv.ts), which ' +
    'test_browse.mjs holds to the precision and descriptor contracts',
);

// The download button opens a menu, one item per file shape; the hourly items
// hand the shown rows and the descriptor to main.ts, captured at the click.
{
  const menu = html.slice(html.indexOf('id="browse-download-menu"'));
  const items = [
    ...menu.slice(0, menu.indexOf('</div>')).matchAll(/data-download="(\w+)">([^<]+)/g),
  ];
  assert.deepEqual(
    items.map((match) => [match[1], match[2]]),
    [
      ['stats', 'Table (stats)'],
      ['wide', 'Hourly series (wide)'],
      ['long', 'Hourly series (long)'],
    ],
    'the download menu offers the stats table and both hourly layouts',
  );
  const button = html.match(/<button[^>]*id="browse-download"[^>]*>/)[0];
  assert.match(
    button,
    /title="Download what this tab shows as CSV: its table of statistics, or the hourly series of every row/,
  );
  assert.match(button, /aria-haspopup="menu"/);
  assert.ok(
    drawer.includes('const withheld = wideWithheld(count);') &&
      drawer.includes('wideNote.textContent = withheld;') &&
      drawer.includes("wideItem.disabled = count === 0 || withheld !== '';"),
    'the wide item is disabled past its limit and the menu states why, before it is picked',
  );
  assert.ok(
    drawer.includes('const note = longNote(count);') &&
      drawer.includes('longNoteLine.textContent = note;') &&
      drawer.includes('longItem.disabled = count === 0;') &&
      html.includes('data-note="long"'),
    'the long item is always offered, and says past Excel’s rows that it is for pandas or R',
  );
  assert.ok(
    drawer.includes('descriptor: browseDescriptor(shown.tab, shown.view, csvMeta())') &&
      drawer.includes('Array.from(visibleRows(tab, view), (row) => tab.rows[row])'),
    'an hourly download carries the rows shown, in order, and the stats file’s descriptor',
  );
}

//
// The column chooser:
//   1. header and rows paint from `visibleColumns`, as the CSV does;
//   2. the header signature covers the VISIBLE columns, so a hide repaints;
//   3. the chooser writes through `setColumnVisible` (hiding clears filters).
//
assert.ok(
  html.includes('id="browse-columns"'),
  'index.html carries the #browse-columns chooser button in the browse drawer’s own chrome',
);
const paintedFrom = table.match(/visibleColumns\(tab, view\)/g) ?? [];
assert.ok(
  paintedFrom.length >= 2,
  'browse-table.ts paints its header and its rows from visibleColumns(tab, view) ' +
    '(src/ui/browse-csv.ts reads the same function). Found ' +
    paintedFrom.length +
    ' call sites.',
);
assert.ok(
  table.includes('const nextSignature = headerSignature(tab, view);'),
  'the header repaints from `headerSignature`, which is exported and pure so the property ' +
    'itself -- it moves whenever a repaint would look different -- is asserted with values in ' +
    'tests/test_browse.mjs rather than as a string here.',
);
assert.ok(
  drawer.includes('setColumnVisible(viewOf(tab.id), column.key, box.checked)'),
  'the chooser writes through setColumnVisible: hiding a column clears its filter, and ' +
    'a drawer that wrote the override directly would be a second copy of that rule to forget.',
);

//
// The column move:
//   1. writes through `moveColumnTo`, beside `setColumnVisible`, so hidden
//      columns keep their place;
//   2. a header button's press is neither a move nor a sort.
//
assert.ok(
  /grid\.on\('columnMoved'[\s\S]*?moveColumnTo\(/.test(table),
  'browse-table.ts writes a column move through moveColumnTo (src/ui/browse-model.ts), the ' +
    'one write edge for the arrangement; test_browse.mjs asserts what it preserves, this ' +
    'asserts the table actually calls it.',
);
assert.ok(
  /function headerButton[\s\S]*?'mousedown', \(event\) => event\.stopPropagation\(\)/.test(table),
  'a header button stops its mousedown, so pressing group or filter never starts a column move',
);

//
// Copy: a dragged range, copied as the model's values with the header row.
//
assert.ok(
  table.includes("clipboardCopyRowRange: 'range'") && table.includes('formatterClipboard:'),
  'Ctrl+C copies the dragged range, and each cell through formatterClipboard as its value, ' +
    'never the painted rounding: a pasted "<1" or "1,234" is text to Excel.',
);
assert.ok(
  /\.browse-grid \.browse-row \{\s*user-select: none;/.test(css),
  'styles.css stops a text selection in the rows: with one live, Tabulator copies it in ' +
    'place of the range.',
);

//
// The Import Dialog:
//   1. the kind-to-colour map is declared once (palette.ts) from the
//      categorical palette, never as more hex literals;
//   2. palette.ts has no runtime import (case-model imports it);
//   3. the kind is also TEXT on every row, not colour alone;
//   4. the dialog emits no kind or variant override;
//   5. a Case box the bulk modes computed is painted as computed.
//
const palette = read('src/ui/palette.ts');
const dialog = read('src/ui/import-dialog.ts');
const registry = read('src/tables/registry.ts');

// Tints are stated in the registry and drawn from the palette.
const tints = registry.match(/tint: CASE_COLORS\[\d+\]/g) ?? [];
assert.ok(
  tints.length >= 4,
  'every registry entry declares a tint, drawn from CASE_COLORS rather than a hex literal',
);
assert.ok(
  /export const KIND_COLORS[\s\S]*?Readonly<Record<TableKind, string>>/.test(registry),
  'KIND_COLORS is derived from the registry and keyed by TableKind, so a new kind fails to ' +
    'compile until it gets a colour',
);
assert.ok(
  !/tint: *'#/.test(registry),
  'a tint is an entry of the categorical palette, never a second set of hex literals',
);
assert.ok(
  !/^import (?!type\b)/m.test(palette),
  'palette.ts takes no runtime import: it must stay loadable under Node, and case-model ' +
    'already imports it (a value import back would close a cycle)',
);

const secondKindMaps = tsFilesUnder('src')
  .filter((path) => path !== 'src/tables/registry.ts')
  .filter((path) => /KIND_COLORS\s*[:=]/.test(read(path)));
assert.deepEqual(
  secondKindMaps,
  [],
  'a second kind-to-colour mapping is declared here; name it once in src/tables/registry.ts ' +
    'so blue means Area everywhere. Found: ' +
    secondKindMaps.join(', '),
);

assert.ok(
  /import \{[^}]*KIND_COLORS[^}]*\} from '\.\.\/tables\/registry'/.test(dialog),
  "import-dialog.ts takes its kind colours from the registry's KIND_COLORS",
);
assert.ok(
  /const detectedText[^;]*file\.detected\.kind/.test(dialog) &&
    /detectedTag\.textContent = `detected: \$\{detectedText\(file\)\}`/.test(dialog),
  'the import dialog names the kind in TEXT on every row: the tint is a cue, never a channel. ' +
    'The one `detectedText` expression is also the row sort key, so a row that stopped naming ' +
    'its kind would also sort by something other than what it shows',
);
assert.ok(
  !dialog.includes('kindOverride') && !dialog.includes('variantOverride'),
  'the import dialog emits no kind or variant override: kind and quantity are read from the ' +
    'file, and an emitted override the user cannot see or change pins every import to a guess',
);
assert.ok(
  !dialog.includes('kindSelect') && !dialog.includes('variantInput'),
  'the import dialog offers no kind dropdown and no per-file quantity field',
);

// The pickers are where allocation size is stated, so the exit that skips
// them is not the default: one `.btn-primary`.
assert.ok(
  /takeAll\.textContent = 'Load everything'/.test(dialog) &&
    /confirm\.textContent = 'Choose what to load…'/.test(dialog),
  'the import dialog offers both load exits, and the one that opens the pickers carries the ' +
    'ellipsis this app uses for "more UI follows"',
);
assert.equal(
  (dialog.match(/className = 'btn btn-primary'/g) ?? []).length,
  1,
  "exactly one of the dialog's exits is primary, and it is the one that asks",
);
assert.ok(
  /confirm\.disabled = conflicts > 0;[\s\S]{0,400}?takeAll\.disabled = conflicts > 0;/.test(dialog),
  'a same-batch slot collision disables BOTH load exits, adjacently and on the same condition: ' +
    'the shortcut is the one that would lose a table to last-write-wins with no picker on the ' +
    'way past',
);

// In bulk modes the Case box is disabled and filled with the derived name; a
// disabled input looks editable until styled, so the disable and the greying
// (box and column caption) are driven by one condition in `refresh`.
const refreshFn = dialog.match(/function refresh\(\): void \{[\s\S]*?\n    \}/);
assert.ok(refreshFn, 'import-dialog.ts still declares refresh()');
assert.ok(
  /caseInput\.disabled = mode !== 'individual'/.test(refreshFn[0]) &&
    /caseHead\.classList\.toggle\(\s*'modal-label-computed',\s*mode !== 'individual'\s*\)/.test(
      refreshFn[0],
    ),
  'the import dialog greys the Case caption in lockstep with disabling the boxes under it: ' +
    "both read `mode !== 'individual'`, and both are in refresh(), so neither can be " +
    'changed without meeting the other',
);
assert.ok(
  /\.modal-filter:disabled\s*\{[^}]*background:/.test(css),
  'styles.css paints a disabled .modal-filter with its own background: without a rule, a ' +
    'computed-and-locked Case box looks exactly as enterable as a live one',
);
assert.ok(
  /\.modal-label-computed\s*\{[^}]*opacity:/.test(css),
  'styles.css fades .modal-label-computed, the caption beside a locked field',
);
assert.ok(
  !/\.modal-filter:disabled\s*\{[^}]*opacity:/.test(css),
  'a disabled .modal-filter must NOT be faded with opacity: its VALUE is the derived Case ' +
    'name the user is being asked to read, and opacity fades exactly that',
);

// ------------------------------------------------------------ the tab ids
//
//   1. Each tab carries its own scope and `collectBrowseTabs` finds the
//      active one; main.ts must not grow an if-chain over tab ids (behaviour
//      is asserted in `tests/test_browse_tabs.mjs`).
//   2. "Is a groups tab" is an argument the caller states; the scope module
//      names no tab ids.
const main = read('src/main.ts');
const browseScope = read('src/app/browse-scope.ts');
assert.ok(
  !/'area-groups'/.test(browseScope) && !/"area-groups"/.test(browseScope),
  'browse-scope.ts names no tab id: variable pairing arrives as the caller\u2019s ' +
    'pairedWith argument, so a second groups tab is another argument rather than ' +
    'a second string comparison',
);

const renderBrowseAt = main.indexOf('function renderBrowse');
assert.ok(renderBrowseAt > 0, 'main.ts defines renderBrowse');
const renderBrowseBlock = main.slice(renderBrowseAt, main.indexOf('\n}\n', renderBrowseAt));
assert.ok(
  !/const shown =\s*active ===/.test(renderBrowseBlock),
  'the active tab\u2019s scope is not picked by an if-chain over ids -- the chain\u2019s ' +
    'last branch silently swallowed any tab id it had never heard of',
);
// Each kind declares its own tabs, in its own directory, and every declaration
// carries the scope it reads. main.ts assembles them and resolves the active
// one through collectBrowseTabs; it names no tab id of its own.
const TAB_DECLARERS = {
  'src/tables/area/ui/browse.ts': ['area', 'area-groups'],
  'src/tables/generator/ui/browse.ts': ['generator', 'generator-groups'],
  'src/tables/bus/ui/browse.ts': ['bus'],
  'src/tables/interface/ui/browse.ts': ['interface'],
};
for (const [file, ids] of Object.entries(TAB_DECLARERS)) {
  const source = read(file);
  for (const id of ids) {
    assert.ok(
      source.includes(`id: '${id}'`),
      `${file} must declare its own '${id}' tab -- a tab declared in main.ts is a tab whose ` +
        `kind cannot see it`,
    );
  }
  assert.ok(
    /scope:\s*\w+,/.test(source),
    `${file}'s tab declarations must each carry the scope they read, so a tab registered ` +
      `without one does not compile`,
  );
}
assert.ok(
  renderBrowseBlock.includes('collectBrowseTabs('),
  'main.ts resolves the active tab through collectBrowseTabs rather than an id chain of its own',
);
assert.ok(
  !/id: '(area|bus|generator|interface)/.test(renderBrowseBlock),
  'main.ts names no browse tab id: the kind that owns the tab is the module that declares it',
);
assert.ok(
  !/signature:\s*\[/.test(renderBrowseBlock),
  'the drawer\u2019s cache key is DERIVED from the declared tabs, never hand-listed: a ' +
    'freshness input left out of a positional array leaves a stale ranking on screen ' +
    'with nothing to say so',
);
assert.ok(
  read('src/tables/generator/ui/browse.ts').includes('isGroupTab: true'),
  'the generator groups tab is declared beside the generator tab, built as a group tab',
);
assert.ok(
  /const PAIRED_TABS[\s\S]*?'generator-groups'[\s\S]*?\};/.test(main),
  'main.ts declares the tab pairing as one map -- an entity tab and its groups tab are ' +
    'one variable seen two ways, stated once rather than branched per tab',
);

console.log(
  'ok - the browse tabs are pinned: the active scope rides on the tab, no id chain picks ' +
    'it, and variable pairing is the caller\u2019s property rather than a tab-name literal',
);

console.log(
  `ok - ${modules.length} section/modal modules carry no global element lookup, ` +
    `their data- hooks all exist in #section-template, and src/ has one keydown owner`,
);
console.log(
  'ok - the drawer drag is pinned: no height in the tab-cache key, applyHeight calls no draw(), ' +
    'and the mirrored heights agree with styles.css',
);
console.log(
  'ok - the grouped drawer is pinned: the build consumes the keep-set, the filter box ' +
    'commits rather than types, and a filter change evicts the grouped cache',
);
console.log(
  'ok - the drawer CSV is pinned: the button is drawer chrome in index.html, and the file ' +
    'is built by the pure builder the model tests hold to its contracts',
);
console.log(
  'ok - the column chooser is pinned: the button is drawer chrome, the paint paths and the ' +
    'CSV read one visibleColumns, the header signature tracks the visible keys, and the ' +
    'chooser writes through setColumnVisible',
);
console.log(
  'ok - the column drag is pinned: the write goes through moveColumnTo, the gesture is split ' +
    'from click-to-sort by a threshold with its click suppressed, a rebuild cancels a live ' +
    'drag, and the drop edge is painted',
);
// A control shown by mode must be able to hide: an inline `display` beats the
// `hidden` attribute, so layout is a class that answers `[hidden]`.
//
// A blocked batch names how to unblock it once, in the summary, since each
// row names only its overlap.
assert.ok(
  /cannot be loaded as assigned[\s\S]*?change a Case name, or remove one of the files/.test(dialog),
  "the import dialog's summary names the recovery for a blocking collision -- the per-row " +
    'reason names only which other file overlaps, so this is the one place that says what to ' +
    'do about it',
);

const labelledFn = dialog.match(/function labelled\([\s\S]*?\n\}/);
assert.ok(labelledFn, 'import-dialog.ts still declares labelled()');
assert.ok(
  !/style\.display/.test(labelledFn[0]),
  'labelled() sets no inline display: the two bulk fields are shown by mode through the ' +
    '`hidden` attribute, and an inline display silently outranks it. Style the wrapper with ' +
    'a class instead.',
);
assert.match(
  css,
  /\.modal-field\[hidden\]\s*\{[^}]*display:\s*none/,
  'styles.css hides a .modal-field carrying [hidden]. The class sets display: inline-flex, ' +
    'which outranks the UA rule that makes `hidden` work, so the class has to take it back.',
);
assert.match(
  css,
  /\.mapping-column\[hidden\],\s*\.mapping-row\[hidden\]\s*\{[^}]*display:\s*none/,
  'styles.css hides a groupings-pane column or row carrying [hidden]. Both classes set ' +
    'display: flex, and the pane shows one entity at a time through `hidden`; without this ' +
    'every entity is on screen at once and Load falls below the modal.',
);
assert.ok(
  /patternWrap\.hidden = mode !== 'derive'/.test(dialog) &&
    /oneCaseWrap\.hidden = mode !== 'one-case'/.test(dialog),
  'each bulk field is shown only in the mode that reads it',
);

console.log(
  'ok - the import dialog is pinned: one kind-to-colour mapping, stated in the registry, the kind stays ' +
    'in text beside the tint, the dialog emits no kind or variant override, and a field shown ' +
    'by mode can actually hide',
);
// (f) Every load-time picker offers "Keep everything" and prices it through
// `confirmLargeAllocation` (via `keepAllCost` or directly): it is the one
// click that can request a multi-hundred-megabyte cube.
const pickerFiles = modules.filter(([path]) => path.endsWith('picker.ts'));
const keepAllPickers = pickerFiles.filter(
  ([, text]) => text.includes("'Keep everything'") || text.includes('keepAllCost'),
);
assert.ok(
  keepAllPickers.length >= 4,
  `the scan finds the keep-everything pickers (found ${keepAllPickers.length}) -- if this ` +
    'drops, the literal moved and the assertion below is checking nothing',
);
for (const [path, text] of keepAllPickers) {
  assert.ok(
    text.includes('confirmLargeAllocation') || text.includes('keepAllCost'),
    `${path} offers "Keep everything" without pricing it: the one click that can allocate the ` +
      'whole axis passes keepAllCost, or calls confirmLargeAllocation itself',
  );
}
for (const [path, text] of pickerFiles) {
  if (!text.includes('showWideEntityPicker')) continue;
  assert.ok(
    text.includes('keepAllCost'),
    `${path} drives showWideEntityPicker without keepAllCost, so its keep-everything button ` +
      'would name no price and open no confirmation',
  );
}
assert.ok(
  read('src/ui/confirm-allocation.ts').includes('LARGE_ALLOCATION_BYTES'),
  'confirm-allocation.ts owns the threshold, so the pickers cannot each pick their own',
);

// The Import Dialog's "Load everything" must reach the same confirmation in
// each picker.
for (const [path, branch] of [
  ['src/ui/wide-entity-picker.ts', /if \(request\.everything\) \{[\s\S]*?\n  \}/],
  ['src/ui/long-metric-picker.ts', /if \(request\.everything\) \{[\s\S]*?\n  \}/],
  ['src/tables/area/ui/picker.ts', /if \(everything\) \{[\s\S]*?\n  \}/],
]) {
  const found = read(path).match(branch);
  assert.ok(found, `${path} no longer answers a keep-everything drop without opening`);
  assert.ok(
    found[0].includes('confirmLargeAllocation'),
    `${path} resolves a keep-everything drop without pricing it: the picker never opened, so ` +
      'this branch is the only place the figure can be stated',
  );
}
assert.ok(
  !/\n\s*return batch\.union;/.test(read('src/ui/retain-gate.ts')),
  'the retain gate answers a keep-everything batch for the kind instead of passing it to the ' +
    "kind's picker, which is the one place that prices the allocation",
);

console.log(
  `ok - ${keepAllPickers.length} pickers offer "Keep everything" and every one of them prices ` +
    'the union, through keepAllCost or confirmLargeAllocation, against one shared threshold — ' +
    'including the Import Dialog shortcut, which each picker answers without opening',
);

console.log(
  'ok - the browse body carries its scroll position across a repaint of the same tab, so a ' +
    'tick leaves the analyst where they were reading',
);

// -------------------------------------------------------------------
//
// A control that SENDS a change must also be FILLED on render. Checked on the
// drawer's variable dropdown: its options are built, and its selection is
// pushed back from state.
const drawerModule = read('src/ui/browse-drawer.ts');
assert.ok(
  drawerModule.includes("variableSelect.addEventListener('change'"),
  'the drawerModule still drives the variable from its select -- if this moved, move the ' +
    'assertions below with it rather than deleting them',
);
assert.ok(
  drawerModule.includes('variableSelect.replaceChildren()') &&
    drawerModule.includes('variableSelect.appendChild('),
  'the drawerModule FILLS its variable select: a select wired to a handler and never given an ' +
    'option is an empty list beside a table that rendered fine, which is not an error anywhere',
);
assert.ok(
  drawerModule.includes('option.selected = variable === shown.variable'),
  'the drawerModule reflects the shown variable back onto the options, so the dropdown shows what ' +
    'is on screen rather than the browser default of the first row',
);

console.log(
  'ok - the browse drawer both fills its variable select and syncs the selection back from state',
);
// -------------------------------------------------------------------
//
// Every tab action an adapter emits is routed in main.ts; an unrouted id is a
// button that does nothing. Read from each kind's adapter, so new ones are
// covered.
const actionIds = new Set();
for (const path of tableUiDirectories().flatMap(tsFilesIn)) {
  if (!path.endsWith('/browse.ts')) continue;
  const text = read(path);
  // From each `actions` binding to the end of its array literal. Tab ids are
  // spelled `id:` too, so the list is read from the actions statement rather
  // than from every `id: '...'` in the file.
  for (const [statement] of text.matchAll(/\bactions\s*[:=][^;]*?\]/gs)) {
    for (const [, id] of statement.matchAll(/id:\s*'([^']+)'/g)) actionIds.add(id);
  }
}
assert.ok(
  actionIds.size >= 2,
  'the scan finds the tab actions the adapters emit -- if this drops to nothing, the `actions` ' +
    `idiom moved and the assertion below is checking nothing (found: ${[...actionIds].join(', ')})`,
);
const unrouted = [...actionIds].filter((id) => !main.includes(`'${id}'`));
assert.deepEqual(
  unrouted,
  [],
  'every tab action id is routed in src/main.ts -- an id only one side knows is a button that ' +
    'renders and does nothing. Unrouted:\n' +
    unrouted.join('\n'),
);

// The groups tab's editor asks for the UNITS tab's filtered rows by name;
// losing that call would silently drop the narrowing.
assert.ok(
  main.includes("filteredRows('generator')"),
  "main.ts opens the generator group editor with the Generator tab's filtered units, read " +
    'from the drawerModule by tab id -- the groups tab that carries the button has group rows, not ' +
    'units, so this call is the only way that set reaches the editor',
);

console.log(
  `ok - ${actionIds.size} tab action id(s) emitted by the browse adapters are routed in main.ts, ` +
    "and the group editor reads the Generator tab's filtered units",
);

// Ticks are an exact `values` filter and the box a `contains` one. A tick
// written into the box as text would come back as a substring match: ticking
// "SAMPLE_HYDRO" would also keep "SAMPLE_HYDRO: Pump 1".
// The checklist is one renderer (`value-checklist.ts`) under the dropdown and
// every Slicer, so the box is written in exactly two places there, and each
// caller hands it its starting text.
const popovers = read('src/ui/browse-popovers.ts');
const checklistSource = read('src/ui/value-checklist.ts');
const textBranch = popovers.slice(
  popovers.indexOf("if (column.kind === 'text') {"),
  popovers.indexOf('// Two bounds on one column'),
);
assert.deepEqual(
  textBranch.match(/input\.value = [^;]*;/g) ?? [],
  [],
  'the popover never writes the box itself',
);
const boxWrites = checklistSource.match(/input\.value = [^;]*;/g) ?? [];
assert.deepEqual(
  boxWrites,
  ['input.value = options.text;', "input.value = '';"],
  'the text box is written only from its starting text and by Clear; a tick must not ' +
    'serialise into it. Found: ' +
    boxWrites.join(' | '),
);
assert.ok(
  textBranch.includes("text: current?.kind === 'text' ? current.text : ''"),
  'the dropdown starts the box from a text filter only',
);
assert.ok(
  textBranch.includes("write({ kind: 'values', values: [...ticked] })"),
  'the popover writes ticks as a values filter',
);
const slicerSource = read('src/ui/browse-slicers.ts');
assert.ok(
  slicerSource.includes("text: '',") &&
    slicerSource.includes("{ kind: 'values', values: [...ticked] }"),
  'a Slicer starts with an empty box and writes its ticks as a values filter',
);

console.log(
  'ok - filter checklist ticks are an exact values filter, never text written into the box, ' +
    'in the dropdown and in a Slicer',
);

// THE STALE COLUMN: the filter button's handler carries the column KEY only,
// since a header cell can outlive its tab (values in tests/test_browse.mjs).
assert.ok(
  table.includes('host.toggleFilterPopover(key, filterBtn)'),
  'the header hands the filter popover a column KEY, never the column object it was painted ' +
    "from: that object closes over that paint's rows, and the header does not repaint when " +
    'only the rows change',
);
assert.ok(
  /toggleFilterPopover\(columnKey: string, button: HTMLElement\)/.test(popovers) &&
    /const tab = deps\.activeTab\(\);[\s\S]{0,200}?tab\?\.columns\.find\(/.test(popovers),
  'browse-popovers.ts resolves that key against the tab on screen when the click arrives, ' +
    'beside the getters it already takes for activeId and activeTab',
);

console.log(
  'ok - the filter popover reads its column at the click, not at the paint that built the button',
);

// THE STALE CHECKLIST: rebuilding the tabs also closes an open popover,
// whose checklist came from the old tab.
assert.ok(
  /if \(state\.signature !== latest\.signature\) \{\s*built\.clear\(\);[\s\S]{0,600}?popovers\.closePopover\(\);/.test(
    drawerModule,
  ),
  'browse-drawer.ts closes an open popover in the same branch that drops the built tabs, so a ' +
    'checklist never outlives the rows it was computed from',
);
console.log('ok - a rebuild of the tabs closes a popover computed from the old ones');

// THE DECLINED GROUP-BY: filters are not marked consumed when the build lists
// units instead (values in tests/test_browse.mjs).
assert.match(
  drawerModule,
  /if \(declinedGroupBy\(tab\)\) \{[\s\S]*?\} else if \(base\) \{\s*tab = carryFilterContext\(tab, base, view\);/,
  'browse-drawer.ts carries filter context only onto a build that actually grouped',
);
for (const surface of [
  'const view = builtView(tab, viewOf(tab.id));',
  'browseTableCsv(tab, builtView(tab, viewOf(tab.id))',
  'visibleRows(tab, builtView(tab, viewOf(tab.id)))',
]) {
  assert.ok(
    drawerModule.includes(surface),
    `browse-drawer.ts paints, exports and acts on the view the tab was built under: ${surface}`,
  );
}
console.log('ok - a group-by the build declined is painted as the ungrouped tab it is');

// THE NOTES-ROW CHIPS: the view states shaping the active tab's rows, each a
// click from cleared (the chip list itself is tested in tests/test_browse.mjs).
const notesRowAt = html.indexOf('id="browse-notes-row"');
const notesRowEnd = html.indexOf('</div>\n      <div class="browse-scroll">', notesRowAt);
assert.ok(
  notesRowAt >= 0 && html.slice(notesRowAt, notesRowEnd).includes('id="browse-chips"'),
  'index.html puts #browse-chips inside the notes row, beside the notes and actions',
);
assert.ok(
  drawerModule.includes("within(root, '#browse-chips')"),
  'browse-drawer.ts finds the chips container through its root',
);
assert.ok(
  drawerModule.includes('const chips = viewChips(tab, viewOf(tab.id));') &&
    drawerModule.includes('setView(tab.id, chip.clear(viewOf(tab.id)))'),
  'a chip clears through setView on the active tab alone, so it re-lists and re-ranks, keeps ' +
    'the selection, and leaves every other tab its view',
);
assert.ok(
  read('src/ui/browse-table.ts').includes('host.setView(setGroupBy('),
  "the header's group toggle goes through setGroupBy, the transform the group chip uses",
);
console.log('ok - the notes row renders view chips that clear through the drawer’s own setView');

// THE CONTENTS PANEL: a modal like the others, appended to <body> above the
// busy overlay, with one Escape listener that is torn down on close. It opens
// from the memory readout, which is global chrome and keeps its id, and the
// root closes it when a load starts.
const contentsPanel = read('src/ui/contents-panel.ts');
assert.equal(
  sitesOf(contentsPanel, KEYDOWN_ADD).length,
  1,
  'contents-panel.ts registers exactly one keydown listener, for Escape',
);
assert.equal(
  sitesOf(contentsPanel, KEYDOWN_REMOVE).length,
  1,
  'contents-panel.ts removes its Escape listener on close',
);
assert.ok(
  contentsPanel.includes("backdrop.className = 'modal-backdrop'") &&
    contentsPanel.includes('document.body.appendChild(backdrop)'),
  'the Contents panel is a modal-backdrop dialog appended to <body>, like the other modals',
);
assert.ok(
  html.includes('<button type="button" id="memory-readout"'),
  'the memory readout is a button in index.html',
);
assert.ok(
  read('src/ui/shell.ts').includes(
    "memoryReadout.addEventListener('click', () => handlers.onContents())",
  ),
  'the readout opens the Contents panel through the chrome handlers',
);
{
  const main = read('src/main.ts');
  const loadFilesAt = main.indexOf('async function loadFiles(');
  const loadAllAt = main.indexOf('async function loadAll(');
  assert.ok(
    main.indexOf('closeContents();', loadFilesAt) < main.indexOf('setBusyFloor(', loadFilesAt) &&
      main.indexOf('closeContents();', loadAllAt) < main.indexOf("setBusy('Loading…')", loadAllAt),
    'both load paths close the Contents panel before they start',
  );
}
// The Log starts collapsed and its open state is never remembered: what is
// loaded now is what the panel shows first.
assert.ok(
  contentsPanel.includes("document.createElement('details')") &&
    !/\.open\s*=|setAttribute\('open'|localStorage|sessionStorage/.test(contentsPanel),
  'the Contents Log is a <details> that is never opened or remembered open by code',
);
// The About note is the panel's one editable field, and a load is about to
// replace it, so it is read-only while one runs.
assert.ok(
  contentsPanel.includes("document.createElement('textarea')") &&
    contentsPanel.includes('about.readOnly = source.loading()') &&
    /loading: \(\) => loadInFlight \|\| busy !== null/.test(read('src/main.ts')),
  'the About note is a textarea, read-only while a load runs',
);
console.log(
  'ok - the Contents panel is a body-level modal with one Escape listener, closed by loads',
);

// THE FIGURE BUTTON AND DIALOG: a Figure button in every pane header, since
// any pane can hold an exportable chart, resolved inside the section's own
// clone; the dialog is a body-level modal whose one Escape listener is torn
// down on close, counted with the other modals' in (c).
{
  const charts = read('src/ui/charts.ts');
  for (const pane of ['1', '2', '3', '4']) {
    const start = template.indexOf(`<div data-pane="${pane}" class="pane">`);
    const header = template.slice(start, template.indexOf('</div>', start));
    assert.ok(
      header.includes(`data-el="figure-${pane}"`),
      `pane ${pane}'s header carries a Figure button`,
    );
    assert.ok(charts.includes(`'[data-el="figure-${pane}"]'`), `charts.ts names figure-${pane}`);
  }
  assert.match(
    charts,
    /FIGURE_HOOKS\.map\(\(hook\) => within<HTMLButtonElement>\(root, hook\)\)/,
    'charts.ts resolves the Figure buttons with within(root, ...)',
  );
  // Hidden on a refused pane: decided after the panes paint, from the
  // refusal banner a pane shows in place of its chart, whichever pane type
  // refused and why.
  assert.match(
    charts,
    /element\.className = `pane-banner pane-banner-\$\{kind\}`/,
    'a refusal banner carries pane-banner-refusal',
  );
  const decide = charts.slice(charts.indexOf('function updateFigureButtons'));
  assert.match(
    decide.slice(0, decide.indexOf('\n  }\n')),
    /!paneBodies\[i\]\.querySelector\('\.pane-banner-refusal'\)/,
    'the Figure button is offered only on a pane without a refusal banner',
  );
  assert.equal(
    (charts.match(/figureBtns\[i\]\.style\.display =/g) ?? []).length,
    1,
    'one place decides the Figure button',
  );
  assert.match(
    charts,
    /renderSlots\(paneContext\);\n\s*updateFigureButtons\(drawable\);/,
    'the Figure buttons are decided after the panes have painted their refusals',
  );
  const dialog = read('src/figure/dialog.ts');
  assert.equal(sitesOf(dialog, KEYDOWN_ADD).length, 1, 'the Figure dialog listens for Escape once');
  assert.equal(
    sitesOf(dialog, KEYDOWN_REMOVE).length,
    1,
    'the Figure dialog removes its Escape listener on close',
  );
  assert.ok(
    dialog.includes("backdrop.className = 'modal-backdrop'") &&
      dialog.includes('document.body.appendChild(backdrop)'),
    'the Figure dialog is a modal-backdrop dialog appended to <body>, like the other modals',
  );
  console.log(
    'ok - a Figure button in every pane header, hidden on a refused pane, and a body-level dialog with one Escape',
  );
}
