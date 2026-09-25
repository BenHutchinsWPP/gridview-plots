// tests/test_groupings_pane.mjs
//
// The mapping pane's subtitle, asserted as TEXT. `groupings-mapping.ts`
// builds it inside a DOM modal and this suite has no DOM, so the string is
// read out of the source: the concatenated literals assigned to
// `subtitle.textContent`.
//
// The subtitle is the pane's one sentence on why it asks, and it has been
// wrong in both directions: it named three of the four entities, and it said
// the file's shape can never tell them apart when a header only one group
// editor writes does exactly that (`writtenBy` in detect.ts). What is pinned
// is the substance, not the wording: all four entities named, the ambiguous
// case named, and no claim that the header never says.
//
// Run: node tests/test_groupings_pane.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/ui/groupings-mapping.ts'), 'utf8');

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

const assignment = src.match(/subtitle\.textContent\s*=([\s\S]*?);\n/);
const subtitle = assignment
  ? [...assignment[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]).join('')
  : '';

ok('the subtitle is found in the source', () => {
  assert.ok(subtitle.length > 0, 'no `subtitle.textContent = ...;` literal found');
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
