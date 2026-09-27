// tests/test_groupings_pane.mjs
//
// The mapping pane's subtitle, as the pane shows it: `showGroupingsMapping`
// is opened against the fake DOM (tests/test_fixtures_dom.mjs) and the
// modal's first `.modal-subtitle` is read.
//
// The subtitle is the pane's one sentence on why it asks, and it has been
// wrong in both directions: it named three of the four entities, and it said
// the file's shape can never tell them apart when a header only one group
// editor writes does exactly that (`writtenBy` in detect.ts). What is pinned
// is the substance, not the wording: all four entities named, the ambiguous
// case named, and no claim that the header never says.
//
// Run: node tests/test_groupings_pane.mjs

import './test_loader.mjs';
import assert from 'node:assert/strict';
import { installFakeDom } from './test_fixtures_dom.mjs';

installFakeDom();
const { showGroupingsMapping } = await import('../src/ui/groupings-mapping.ts');

// Opened on the ambiguous header and on a bus/unit pair: the subtitle is the
// pane's, not the file's, so it is the same sentence either way.
const subtitles = [];
for (const header of [
  ['Name', 'Grouping'],
  ['Bus Number', 'Unit ID', 'Grouping'],
]) {
  void showGroupingsMapping({ fileName: 'SAMPLE.csv', header, hasGeneratorList: false });
  const modal = document.body.children.at(-1);
  subtitles.push(modal.querySelector('.modal-subtitle')?.textContent ?? '');
}
const [subtitle] = subtitles;

let failed = 0;
function ok(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

ok('the pane shows a subtitle', () => {
  assert.ok(subtitle.length > 0, 'the modal has no .modal-subtitle text');
  assert.equal(subtitles[1], subtitle, 'and the same one whichever header opened it');
});

ok('the subtitle names all four entities the pane answers for', () => {
  for (const entity of ['area', 'generator', 'bus', 'interface']) {
    assert.match(subtitle, new RegExp(`\\b${entity}`, 'i'), `subtitle omits ${entity}`);
  }
});

ok('the subtitle names the header that stays ambiguous', () => {
  assert.match(subtitle, /Name,Grouping/);
});

ok('the subtitle does not claim the header can never tell the kinds apart', () => {
  assert.doesNotMatch(subtitle, /cannot tell|can't tell|can never tell|indistinguishable/i);
});

ok('the subtitle makes no status claim', () => {
  assert.doesNotMatch(subtitle, /#\d|\bsince\b|\bnow\b|\byet\b|\btoday\b|\bso far\b/i); // rot-guard:allow
});

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll groupings pane checks passed.');
