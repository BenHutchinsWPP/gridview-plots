// tests/test_browse_tabs.mjs — the tab bar, and the key that says it is stale.
//
// The invariant: the drawer holds built
// tabs until the signature moves, so an input a rebuild reads and the
// signature does not mention leaves a ranking on screen that no longer
// describes the data. Nothing fails, nothing is empty -- the numbers are just
// wrong. These assert the derivation rather than the nine terms someone
// remembered to list.
//

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { collectBrowseTabs } = await import('../src/app/browse-tabs.ts');

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`ok - ${label}`);
}

const scope = (signature, { tables = 1, variables = ['MW'], variable = 'MW' } = {}) => ({
  tables: Array.from({ length: tables }, (_, i) => `table${i}`),
  variables,
  variable,
  signature,
});

const tab = (id, sig, opts) => ({
  id,
  label: id.toUpperCase(),
  scope: scope(sig, opts),
  build: id,
});

const SHARED = { lookups: 'BusList.csv', groupingsRev: 0, generatorGroupsRev: 0 };

// --- 1. the bar ------------------------------------------------------------

check('only the tabs with tables reach the bar, in declaration order', () => {
  const out = collectBrowseTabs(
    [tab('area', 'a'), tab('bus', 'b', { tables: 0 }), tab('interface', 'i')],
    SHARED,
    '',
  );
  assert.deepEqual(
    out.tabs.map((t) => t.id),
    ['area', 'interface'],
  );
});

check('the build thunk travels through untouched', () => {
  const out = collectBrowseTabs([tab('area', 'a')], SHARED, '');
  assert.equal(out.tabs[0].build, 'area');
  assert.equal(out.tabs[0].label, 'AREA');
});

check('a tab offering % of range still offers it on the bar', () => {
  // The drawer enables the toggle from this flag alone; dropping it here
  // disables "% of range" on every tab, silently.
  const out = collectBrowseTabs(
    [{ ...tab('area', 'a'), offersRange: true }, tab('bus', 'b')],
    SHARED,
    '',
  );
  assert.equal(out.tabs[0].offersRange, true);
  assert.equal(out.tabs[1].offersRange, undefined);
});

check('nothing loaded is an empty bar, an empty signature-bearing result, no throw', () => {
  const out = collectBrowseTabs([tab('area', 'a', { tables: 0 })], SHARED, 'area');
  assert.deepEqual(out.tabs, []);
  assert.equal(out.shown, undefined);
  assert.equal(out.activeId, '');
  assert.ok(out.signature.length > 0);
});

// --- 2. which scope the variable dropdown reads ----------------------------

check('the preferred tab wins when it is on the bar', () => {
  const out = collectBrowseTabs(
    [tab('area', 'a', { variable: 'Load' }), tab('bus', 'b', { variable: 'Voltage' })],
    SHARED,
    'bus',
  );
  assert.equal(out.activeId, 'bus');
  assert.equal(out.shown.variable, 'Voltage');
});

check('a preferred tab that is no longer on the bar falls back to the first', () => {
  // A tab goes when its kind's last table is detached, and the drawer must
  // land somewhere without anybody clicking.
  const out = collectBrowseTabs(
    [tab('area', 'a', { variable: 'Load' }), tab('bus', 'b', { tables: 0 })],
    SHARED,
    'bus',
  );
  assert.equal(out.activeId, 'area');
  assert.equal(out.shown.variable, 'Load');
});

check('an id no tab has falls back to the first rather than being swallowed', () => {
  // The failure this shape exists to refuse: an if-chain over ids whose last
  // branch silently swallowed an id it had never heard of, landing a new tab
  // in the generator's scope.
  const out = collectBrowseTabs([tab('area', 'a', { variable: 'Load' })], SHARED, 'nonsense');
  assert.equal(out.activeId, 'area');
  assert.equal(out.shown.variable, 'Load');
});

// --- 3. the signature: every declared input moves it ------------------------

const base = () => [tab('area', 'a'), tab('bus', 'b'), tab('interface', 'i')];

check('the same inputs give the same signature', () => {
  const first = collectBrowseTabs(base(), SHARED, 'area').signature;
  const second = collectBrowseTabs(base(), SHARED, 'area').signature;
  assert.equal(first, second);
});

check('a sort, a filter or a tab switch is not an input, so none of them re-ranks', () => {
  const first = collectBrowseTabs(base(), SHARED, 'area').signature;
  const second = collectBrowseTabs(base(), SHARED, 'interface').signature;
  assert.equal(first, second);
});

check("ANY tab's scope signature moving moves the whole signature", () => {
  const before = collectBrowseTabs(base(), SHARED, 'area').signature;
  for (const id of ['area', 'bus', 'interface']) {
    const declared = base().map((t) => (t.id === id ? tab(id, 'MOVED') : t));
    assert.notEqual(
      collectBrowseTabs(declared, SHARED, 'area').signature,
      before,
      `${id}'s scope moved and the signature did not`,
    );
  }
});

check('every shared input moves the signature', () => {
  const before = collectBrowseTabs(base(), SHARED, 'area').signature;
  for (const [key, value] of [
    ['lookups', 'BusList.csv,GeneratorList.csv'],
    ['groupingsRev', 1],
    ['generatorGroupsRev', 1],
  ]) {
    assert.notEqual(
      collectBrowseTabs(base(), { ...SHARED, [key]: value }, 'area').signature,
      before,
      `${key} moved and the signature did not`,
    );
  }
});

check('reordering the shared record is not a cache miss', () => {
  const a = collectBrowseTabs(base(), { lookups: 'x', groupingsRev: 0 }, 'area').signature;
  const b = collectBrowseTabs(base(), { groupingsRev: 0, lookups: 'x' }, 'area').signature;
  assert.equal(a, b);
});

// --- 4. an emptied tab still moves it ---------------------------------------

check('a kind losing its last table moves the signature even as its tab disappears', () => {
  // The reason the signature is derived from the DECLARED tabs and not the
  // shown ones. Dropping a term at the same moment the tab goes is how that
  // change would pass unnoticed by the drawer's cache.
  const before = collectBrowseTabs(base(), SHARED, 'area').signature;
  const after = collectBrowseTabs(
    base().map((t) => (t.id === 'bus' ? tab('bus', 'b-empty', { tables: 0 }) : t)),
    SHARED,
    'area',
  ).signature;
  assert.notEqual(after, before);
});

check('a newly declared tab contributes to the signature by construction', () => {
  // The whole point: declaring the tab IS declaring its freshness. There is no
  // second place to remember.
  const before = collectBrowseTabs(base(), SHARED, 'area').signature;
  const after = collectBrowseTabs([...base(), tab('generator', 'g')], SHARED, 'area').signature;
  assert.notEqual(after, before);
});

check('two tabs cannot swap signatures without the whole one moving', () => {
  // Keyed by id, not concatenated positionally: `a`+`b` and `b`+`a` were the
  // same string when the terms were a bare array.
  const first = collectBrowseTabs([tab('area', 'a'), tab('bus', 'b')], SHARED, 'area').signature;
  const second = collectBrowseTabs([tab('area', 'b'), tab('bus', 'a')], SHARED, 'area').signature;
  assert.notEqual(first, second);
});

console.log(`\n${passed} checks passed`);
