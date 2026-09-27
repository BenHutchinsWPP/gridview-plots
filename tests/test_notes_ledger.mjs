// tests/test_notes_ledger.mjs — the batch notes, and when one dies.
//
// The rule: a channel is rewritten WHOLESALE by the drop that owns it, so a
// bus drop cannot erase the account of the interface drop before it, and a
// note cannot outlive the batch it describes. The concatenation order lives
// in one place, so every channel appears on every surface.
//

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './test_loader.mjs';
import { FakeElement, installFakeDom } from './test_fixtures_dom.mjs';

installFakeDom();
const { createNotesLedger } = await import('../src/app/notes-ledger.ts');
const { createSectionHost } = await import('../src/ui/shell.ts');

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`ok - ${label}`);
}

const ORDER = ['area', 'interface', 'bus', 'generator'];

check('an untouched ledger is empty', () => {
  assert.deepEqual(createNotesLedger(ORDER).all(), []);
});

check('channels read in construction order, whatever order they were set in', () => {
  const ledger = createNotesLedger(ORDER);
  ledger.set('generator', ['g']);
  ledger.set('area', ['a']);
  ledger.set('bus', ['b']);
  ledger.set('interface', ['i']);
  assert.deepEqual(ledger.all(), ['a', 'i', 'b', 'g']);
});

check('a channel never set contributes nothing', () => {
  const ledger = createNotesLedger(ORDER);
  ledger.set('bus', ['b1', 'b2']);
  assert.deepEqual(ledger.all(), ['b1', 'b2']);
});

check('set REPLACES, so a second drop cannot inherit the first drop’s account', () => {
  const ledger = createNotesLedger(ORDER);
  ledger.set('area', ['from the first drop']);
  ledger.set('area', ['from the second']);
  assert.deepEqual(ledger.all(), ['from the second']);
});

check('setting [] clears a channel, which is how a drop carrying none of a kind resets it', () => {
  const ledger = createNotesLedger(ORDER);
  ledger.set('interface', ['a warning from last time']);
  ledger.set('interface', []);
  assert.deepEqual(ledger.all(), []);
});

check('one kind’s drop cannot clear another kind’s channel', () => {
  const ledger = createNotesLedger(ORDER);
  ledger.set('interface', ['interface warning']);
  ledger.set('bus', ['bus warning']);
  ledger.set('bus', []);
  assert.deepEqual(ledger.all(), ['interface warning']);
});

check('the messages handed in are copied, not aliased', () => {
  // The caller builds these with spreads and pushes into them afterwards; a
  // stored reference would let a later push rewrite a batch already published.
  const ledger = createNotesLedger(ORDER);
  const mine = ['one'];
  ledger.set('area', mine);
  mine.push('two');
  assert.deepEqual(ledger.all(), ['one']);
});

check('the returned list is a copy too', () => {
  const ledger = createNotesLedger(ORDER);
  ledger.set('area', ['one']);
  ledger.all().push('injected');
  assert.deepEqual(ledger.all(), ['one']);
});

check('a channel not named in the order is held and never shown', () => {
  // Only channels named in the order exist. TypeScript already rejects this
  // call; this is the runtime backstop.
  const ledger = createNotesLedger(ORDER);
  ledger.set('typo', ['invisible']);
  ledger.set('area', ['visible']);
  assert.deepEqual(ledger.all(), ['visible']);
});

check('two ledgers share nothing', () => {
  const first = createNotesLedger(ORDER);
  const second = createNotesLedger(ORDER);
  first.set('area', ['mine']);
  assert.deepEqual(second.all(), []);
});

// ------------------------------------------------- who may write a channel
//
// Only a drop (`src/app/drop-load.ts`, through its host's `say`) writes the
// four kind channels (one drop's account); everything else (save, restore,
// group edit, their errors) writes `session`, which the next drop clears.
// Checked in main.ts's source; which channel a drop writes when is behaviour
// in test_drop_load.mjs.

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

check('only a drop fills a kind channel', () => {
  assert.match(
    main,
    /say: \(channel, lines\) => notes\.set\(channel, lines\),/,
    'the drop writes the ledger through its host',
  );
  const offenders = [];
  for (const match of main.matchAll(/notes\.set\(\s*'(area|interface|bus|generator)'\s*,\s*/g)) {
    const at = match.index;
    // A CLEAR is not an account and cannot displace one: `adoptRestoredCases`
    // empties a channel because the study it described has been replaced.
    // Only a channel being FILLED from outside a drop is the failure here.
    if (main.slice(at + match[0].length).startsWith('[]')) continue;
    offenders.push(`${main.slice(0, at).split('\n').length}: ${match[0].trim()}`);
  }
  assert.deepEqual(
    offenders,
    [],
    "a kind channel is one drop's account; write a non-drop message to " +
      "'session' instead:\n  " +
      offenders.join('\n  '),
  );
});

// A restore clears every kind channel and neither `session` nor `blocked`:
// behaviour in tests/test_save_restore.mjs.

check('the session channel is cleared by a drop, and blocked is not', () => {
  // That a drop clears `session` once it runs, and a refused one does not, is
  // behaviour in test_drop_load.mjs.
  assert.ok(
    !main.includes("notes.set('blocked', [])"),
    'nothing clears `blocked`: it states a fact about this browser that does not stop being true',
  );
});

// ------------------------------------- a note nobody draws is not a note
//
// Warnings are handed over AFTER the series that raise them (behaviour:
// tests/test_render_frame.mjs), and the surface draws them whether or not a
// section is on screen.

check('the batch notes reach a surface, and the surface draws them either way', () => {
  assert.ok(
    /notes: notes\.all\(\),/.test(main),
    "render() hands the frame the ledger's notes, which it joins to the series warnings",
  );
  assert.ok(
    /sections\.sync\(hasCases, frame\.notes\)/.test(main),
    "and hands the frame's notes to the one surface that draws them",
  );

  const statusBar = new FakeElement();
  const sections = createSectionHost(new FakeElement(), {}, statusBar);
  const body = statusBar.querySelector('.sections-notes-body');
  sections.sync(false, ['SAMPLE one', 'SAMPLE two']);
  assert.equal(body.textContent, 'SAMPLE one\nSAMPLE two', 'sync writes the notes out');
  sections.sync(true, ['SAMPLE three']);
  assert.equal(
    body.textContent,
    'SAMPLE three',
    'and does NOT gate them on `visible`: a note shown only while the section ' +
      'is hidden is a note nobody reads once a case has loaded',
  );
});

console.log(`\n${passed} checks passed`);
