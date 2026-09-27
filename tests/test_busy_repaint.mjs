// tests/test_busy_repaint.mjs
//
// A progress message repaints the chrome and nothing else. An ingest
// reports once per block -- sixty times for one bus-width file -- and when
// each report was a full `render()`, the drawer repainted its rows sixty
// times on the main thread the parse also needs: 4 s of a second bus-width
// drop.
//
// Asserted as TEXT, because `src/main.ts` is the composition root and cannot
// be loaded under Node (it builds the DOM at import). The two properties are
// the ones a later edit would break without noticing: `setBusy` with a
// message calls the chrome repaint, and the chrome repaint reaches neither
// the drawer nor the panes.
//
// Also here, because it hangs off the same busy state: while busy the app
// refuses input, except for the dialogs the load itself opens. The chrome
// (src/ui/shell.ts) runs against the fake DOM; the stacking order is CSS.
//
// Run: node tests/test_busy_repaint.mjs

import './test_loader.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeChrome, installFakeDom, keydown } from './test_fixtures_dom.mjs';

installFakeDom();
const { createChrome, registerKeys } = await import('../src/ui/shell.ts');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'src/main.ts'), 'utf8');

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

/** The body of a top-level `function name(...) {...}` in main.ts. */
function body(name) {
  const start = Math.max(
    main.indexOf(`\nfunction ${name}(`),
    main.indexOf(`\nasync function ${name}(`),
  );
  assert.ok(start >= 0, `main.ts declares function ${name}`);
  const end = main.indexOf('\n}\n', start);
  return main.slice(start, end + 2);
}

const setBusy = body('setBusy');
assert.match(
  setBusy,
  /if \(message !== null\) renderChrome\(\);\s*else render\(\);/,
  'a message repaints the chrome; only the end of an operation repaints everything',
);
ok('a progress message repaints the chrome, and null repaints everything');

const chrome = body('renderChrome');
for (const reach of ['render()', 'renderBrowse', 'browseDrawer', 'charts.', 'sections.']) {
  assert.ok(!chrome.includes(reach), `renderChrome reaches ${reach}`);
}
assert.match(chrome, /chrome\.render\(/);
ok('the chrome repaint reaches neither the drawer nor the panes');

// A load refuses input: the app root is inert and shortcuts are ignored while
// busy, and the shield sits BELOW the modals a load itself opens (import
// dialog, pickers), or the load could never be answered.
{
  const chrome = fakeChrome();
  const { render } = createChrome(chrome, {});
  const heard = [];
  registerKeys({ root: chrome, handle: (event) => heard.push(event.key) });
  const state = { status: 'SAMPLE', bytes: 0, cases: 0, files: 0 };

  render({ ...state, busy: true });
  assert.equal(chrome.inert, true, 'the app root is inert while busy');
  document.fire('keydown', keydown('r'));
  document.fire('keydown', keydown('['));
  assert.deepEqual(heard, [], 'the shortcut listener ignores keys while busy');
  assert.ok(!chrome.classList.contains('rail-collapsed'), 'the rail shortcut too');

  render({ ...state, busy: false });
  assert.equal(chrome.inert, false, 'and takes input again once the load ends');
  document.fire('keydown', keydown('r'));
  assert.deepEqual(heard, ['r'], 'so the same key then reaches the section');
}
const css = readFileSync(join(root, 'src/styles.css'), 'utf8');
const zOf = (selector) => {
  const rule = css.match(new RegExp(`\\n${selector.replace('.', '\\.')} \\{[^}]*z-index: (\\d+)`));
  assert.ok(rule, `${selector} states a z-index`);
  return Number(rule[1]);
};
assert.ok(
  zOf('.busy-overlay') < zOf('.modal-backdrop'),
  "the busy overlay sits below a load's own dialogs",
);
ok('a load refuses clicks and keys, and its own dialogs stay above the shield');

// An hourly download is written under the same shield (the export's own
// busy-before-resolve order is asserted through a fake host in
// test_hourly_csv.mjs): progress repaints only the chrome, and so does the
// end, since the export touched no drawn line.
const download = body('downloadHourly');
assert.match(download, /progress: \(message\) => setBusy\(message\)/);
const downloadEnd = download.slice(download.lastIndexOf('} finally {'));
assert.match(downloadEnd, /busy = busyFloor;\s*renderChrome\(\);/);
assert.ok(!downloadEnd.includes('render()'), 'the end of a download does not redraw the chart');
// The drop's own refusal is behaviour in test_drop_load.mjs; here, that the
// root tells it when a download is running.
assert.match(
  main,
  /downloadRunning: \(\) => exportInFlight,/,
  'a drop waits for a download being written',
);
ok('a download is written under busy, yields before it resolves, and ends without a redraw');

console.log(`\n${checks} checks passed.`);
