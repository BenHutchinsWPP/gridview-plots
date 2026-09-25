// tests/test_case_model.mjs
//
// Exercises the real src/model/case-model.ts directly. It needs test_loader.mjs
// only for the extensionless-import hook: case-model.ts reaches the palette,
// because a Case's colour is fixed when the Case is made. Nothing here wants
// the loader's fixture seeding, and nothing here reads the area axis.
//

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { byCaseName, caseForName, caseLabel, CaseStore, displayNameRefusal, slotKey } =
  await import('../src/model/case-model.ts');

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`ok - ${label}`);
}

// --- create / attach / detach / remove ---------------------------------

check('createCase returns a Case with a synthetic id, given name, and empty tables', () => {
  const store = new CaseStore();
  const c = store.createCase('Base Case');
  assert.equal(c.name, 'Base Case');
  assert.equal(typeof c.id, 'string');
  assert.ok(c.id.length > 0);
  assert.notEqual(c.id, 'Base Case', 'id must not be (or be derived from) the given name');
  assert.equal(c.tables.size, 0);
  assert.deepEqual(store.listCases(), [c]);
});

check('createCase never reuses an id across two cases, even with the same name', () => {
  const store = new CaseStore();
  const a = store.createCase('dup.csv');
  const b = store.createCase('dup.csv');
  assert.notEqual(a.id, b.id);
  assert.equal(store.listCases().length, 2);
});

check('attachTable stores data at the slot and tablesOfKind surfaces it', () => {
  const store = new CaseStore();
  const c = store.createCase('Base Case');
  const key = { kind: 'area' };
  const data = { fake: 'AreaTable' };
  store.attachTable(c.id, key, data);
  assert.equal(c.tables.size, 1);
  assert.deepEqual(c.tables.get(slotKey(key)), { key, data });

  const rows = store.tablesOfKind('area');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].caseId, c.id);
  assert.equal(rows[0].slotKey, slotKey(key));
  assert.equal(rows[0].data, data);
});

check('detachTable removes exactly the named slot and nothing else', () => {
  const store = new CaseStore();
  const c = store.createCase('Base Case');
  const keyA = { kind: 'area', variant: 'x' };
  const keyB = { kind: 'area', variant: 'y' };
  store.attachTable(c.id, keyA, { which: 'a' });
  store.attachTable(c.id, keyB, { which: 'b' });

  store.detachTable(c.id, keyA);

  assert.equal(c.tables.size, 1);
  assert.equal(c.tables.has(slotKey(keyA)), false);
  assert.equal(c.tables.get(slotKey(keyB)).data.which, 'b');
});

check('removeCase drops the case and everything it carried out of tablesOfKind', () => {
  const store = new CaseStore();
  const c = store.createCase('Base Case');
  store.attachTable(c.id, { kind: 'area' }, { fake: 'AreaTable' });

  store.removeCase(c.id);

  assert.deepEqual(store.listCases(), []);
  assert.deepEqual(store.tablesOfKind('area'), []);
});

// --- refuse an unknown id/slot rather than silently succeed -------------

check('removeCase throws on an unknown id instead of silently succeeding', () => {
  const store = new CaseStore();
  assert.throws(() => store.removeCase('no-such-case'), /no case with id/);
});

check(
  'detachTable throws on a slot that does not exist (consistent with removeCase/attachTable)',
  () => {
    const store = new CaseStore();
    const c = store.createCase('Base Case');
    // Case exists, but nothing has ever been attached at this slot.
    assert.throws(() => store.detachTable(c.id, { kind: 'area' }), /has no table at slot/);
  },
);

// --- occupied-slot refusal ----------------------------------------------

check('attachTable throws on an occupied slot unless replace: true is passed', () => {
  const store = new CaseStore();
  const c = store.createCase('Base Case');
  const key = { kind: 'area' };
  store.attachTable(c.id, key, { version: 1 });

  assert.throws(() => store.attachTable(c.id, key, { version: 2 }), /already has a table/);
  // The refused attach must not have mutated the existing entry.
  assert.equal(c.tables.get(slotKey(key)).data.version, 1);

  store.attachTable(c.id, key, { version: 2 }, { replace: true });
  assert.equal(c.tables.get(slotKey(key)).data.version, 2);
  assert.equal(c.tables.size, 1, 'replace must overwrite the slot, not add a second entry');
});

// --- attachTable copies the key, does not alias the caller's object -----

check(
  "attachTable copies the key -- mutating the caller's key object afterward does not desync the slot",
  () => {
    const store = new CaseStore();
    const c = store.createCase('Base Case');
    const key = { kind: 'area', variant: 'Power Flow (MW)' };
    const originalSlot = slotKey(key);
    store.attachTable(c.id, key, { which: 'PF' });

    // Mutate the caller's own object after attaching.
    key.variant = 'mutated after attach';

    // The stored entry's key must be unaffected, so tablesOfKind's filter
    // (which reads entry.key, not the slot string) still agrees with the Map
    // slot the data actually lives at.
    const stored = c.tables.get(originalSlot);
    assert.ok(stored, 'the original slot must still hold the entry');
    assert.equal(stored.key.variant, 'Power Flow (MW)');
    assert.notEqual(
      stored.key,
      key,
      "the stored key must not be the same object as the caller's key",
    );

    const rows = store.tablesOfKind('area');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].slotKey, originalSlot);
  },
);

// --- rename preserves id --------------------------------------------------

check('renameCase changes name in place and leaves id untouched', () => {
  const store = new CaseStore();
  const c = store.createCase('Base Case');
  const originalId = c.id;

  store.renameCase(c.id, 'Renamed Case');

  assert.equal(c.id, originalId);
  assert.equal(c.name, 'Renamed Case');
  const [listed] = store.listCases();
  assert.equal(listed.id, originalId);
  assert.equal(listed.name, 'Renamed Case');
});

// --- two slots, same kind, one case ---------------------------------

check(
  'two-slots-same-kind-one-case: distinct variants of the same kind coexist on one Case',
  () => {
    const store = new CaseStore();
    const c = store.createCase('Base Case');
    const powerFlow = { kind: 'area', variant: 'Power Flow (MW)' };
    const congestionCost = { kind: 'area', variant: 'Congestion Cost ($)' };

    store.attachTable(c.id, powerFlow, { which: 'PF' });
    store.attachTable(c.id, congestionCost, { which: 'CC' });

    assert.notEqual(slotKey(powerFlow), slotKey(congestionCost));
    assert.equal(c.tables.size, 2);

    const rows = store.tablesOfKind('area').sort((r1, r2) => r1.slotKey.localeCompare(r2.slotKey));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.caseId === c.id));
    const bySlot = Object.fromEntries(rows.map((r) => [r.slotKey, r.data]));
    assert.equal(bySlot[slotKey(powerFlow)].which, 'PF');
    assert.equal(bySlot[slotKey(congestionCost)].which, 'CC');
  },
);

// --- slotKey collision, precisely as constructed -------------------------

check("slotKey collapses a missing variant to the empty string, per the spec's separator", () => {
  assert.equal(slotKey({ kind: 'area' }), 'area ');
  assert.equal(slotKey({ kind: 'area', variant: undefined }), 'area ');
  assert.equal(slotKey({ kind: 'area', variant: 'x' }), 'area x');
});

check(
  'two empty-variant keys of the same kind collide on one slot (occupied-slot path, not a silent add)',
  () => {
    const store = new CaseStore();
    const c = store.createCase('Base Case');
    store.attachTable(c.id, { kind: 'area' }, { which: 'first' });
    assert.throws(() =>
      store.attachTable(c.id, { kind: 'area', variant: undefined }, { which: 'second' }),
    );
    assert.equal(c.tables.size, 1);
  },
);

// --- variant:'' is the case parseTitleLine actually produces -------------

check("slotKey treats variant:'' the same as a missing variant", () => {
  assert.equal(slotKey({ kind: 'area', variant: '' }), slotKey({ kind: 'area' }));
  assert.equal(slotKey({ kind: 'area', variant: '' }), 'area ');
});

check(
  "attaching variant:'' then variant:undefined at the same kind collides on the second (parseTitleLine's " +
    'unreadable-title case)',
  () => {
    const store = new CaseStore();
    const c = store.createCase('Base Case');
    store.attachTable(c.id, { kind: 'area', variant: '' }, { which: 'first' });
    assert.throws(() =>
      store.attachTable(c.id, { kind: 'area', variant: undefined }, { which: 'second' }),
    );
    assert.equal(c.tables.size, 1);
    assert.equal(c.tables.get(slotKey({ kind: 'area' })).data.which, 'first');
  },
);

// --- the identity semantics main.ts depends on ------------------------------
//
// A dropped Area file becomes one new Case named after the file, with its
// table at slot {kind:'area'}. The FILENAME is a label from that moment on;
// every downstream key -- AreaQuery.cases, the render buffers, every browse
// row -- is the synthetic id.

check('two drops of the SAME filename are two independent Cases, not one silent replace', () => {
  const store = new CaseStore();
  const first = store.createCase('Case1.csv');
  const second = store.createCase('Case1.csv');
  store.attachTable(first.id, { kind: 'area' }, { cube: 'first' });
  store.attachTable(second.id, { kind: 'area' }, { cube: 'second' });

  assert.notEqual(first.id, second.id);
  const rows = store.tablesOfKind('area');
  assert.equal(rows.length, 2, 'a same-named re-drop must not overwrite the first Case');
  assert.deepEqual(
    rows.map((r) => r.data.cube),
    ['first', 'second'],
    'tablesOfKind reports both, in Case creation order',
  );

  // Removing one by id leaves the other, which a name-keyed list could not do.
  store.removeCase(first.id);
  assert.deepEqual(
    store.tablesOfKind('area').map((r) => r.data.cube),
    ['second'],
  );
});

check('renaming a Case does not touch the table it owns (the name is not in the data, D2)', () => {
  const store = new CaseStore();
  const c = store.createCase('north.csv');
  const table = { cube: 'bytes', areas: ['NORTH'] };
  store.attachTable(c.id, { kind: 'area' }, table);

  store.renameCase(c.id, 'Winter Peak');
  const [row] = store.tablesOfKind('area');
  assert.equal(row.caseId, c.id, 'the id survives the rename, so nothing needs rekeying');
  assert.equal(row.data, table, 'the same table object, unmodified');
  assert.equal(Object.hasOwn(row.data, 'name'), false);
});

check('replacing a table in place preserves Case order (what adoptAxis relies on)', () => {
  const store = new CaseStore();
  const ids = ['a.csv', 'b.csv', 'c.csv'].map((name) => store.createCase(name).id);
  ids.forEach((id, index) => store.attachTable(id, { kind: 'area' }, { cube: index }));

  // adoptAxis rebuilds every loaded cube onto the grown axis and puts each one
  // back at its own Case's area slot. If that reordered the list, the rail
  // order -- and the colour assigned from it -- would shuffle under the user.
  for (const { caseId, data } of store.tablesOfKind('area')) {
    store.attachTable(
      caseId,
      { kind: 'area' },
      { cube: data.cube, reindexed: true },
      { replace: true },
    );
  }

  assert.deepEqual(
    store.tablesOfKind('area').map((r) => r.caseId),
    ids,
  );
  assert.deepEqual(
    store.tablesOfKind('area').map((r) => r.data.cube),
    [0, 1, 2],
  );
  assert.ok(store.tablesOfKind('area').every((r) => r.data.reindexed === true));
});

// --- 'attribute' is a no-op extension point, not wired to anything -------
//
// Proves the seam exists: a value of a shape CaseStore has never been told
// about -- an entity axis and named columns over it -- can be attached to and
// detached from a Case, exercising no kind-specific code path. The shape is
// written out below rather than imported, because the point is that no kind
// declares it.

check('an attribute-shaped table attaches/detaches through CaseStore like any other kind', () => {
  const store = new CaseStore();
  const c = store.createCase('Base Case');
  const generatorLookup = {
    entityAxis: ['GEN1', 'GEN2'],
    columns: [{ name: 'FuelType', values: ['Gas', 'Wind'] }],
    joinsOnArea: true,
  };
  const key = { kind: 'attribute' };

  store.attachTable(c.id, key, generatorLookup);

  assert.equal(c.tables.size, 1);
  assert.equal(c.tables.get(slotKey(key)).data, generatorLookup);

  const rows = store.tablesOfKind('attribute');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].caseId, c.id);
  assert.equal(rows[0].data, generatorLookup);
  // Coexists alongside an Area table on the same Case without either kind
  // knowing about the other (no shared code path between them).
  store.attachTable(c.id, { kind: 'area' }, { fake: 'AreaTable' });
  assert.equal(store.tablesOfKind('area').length, 1);
  assert.equal(store.tablesOfKind('attribute').length, 1);

  store.detachTable(c.id, key);

  assert.equal(c.tables.size, 1, 'only the area table remains');
  assert.deepEqual(store.tablesOfKind('attribute'), []);
});

// --- colour is a property, and the display sort cannot reach it ---------
//
// The old rule assigned a colour by POSITION in a list derived from
// listCases(). Sorting that list for display therefore recoloured every case,
// and so did loading one new case whose name sorted first. `ui/palette.ts`
// states what that costs: a ten-line overlay is only readable if the mapping
// is learned once. These two checks are what keep the fix from being undone
// by a later "just sort the store" change.

check('a Case keeps the colour it was made with, whatever a display sort does', () => {
  const store = new CaseStore();
  const zulu = store.createCase('Zulu');
  const alpha = store.createCase('Alpha');

  assert.notEqual(zulu.color, alpha.color, 'two cases do not share a colour');

  const shown = store.listCases().slice().sort(byCaseName);
  assert.deepEqual(
    shown.map((c) => c.name),
    ['Alpha', 'Zulu'],
    'the sorted view reads alphabetically',
  );
  assert.equal(
    shown[0].color,
    alpha.color,
    'and Alpha is still drawn in the colour Alpha was made with',
  );
  assert.equal(shown[1].color, zulu.color);

  assert.deepEqual(
    store.listCases().map((c) => c.name),
    ['Zulu', 'Alpha'],
    'while the STORE is untouched: its order keys the series pool and the frozen query',
  );

  // The case that sorts first arriving last must not recolour the chart.
  const aaa = store.createCase('AAA');
  assert.equal(zulu.color, store.listCases()[0].color, 'an earlier case keeps its colour');
  assert.notEqual(aaa.color, zulu.color);
});

check('byCaseName is numeric, so Case 2 precedes Case 10', () => {
  const names = ['Case 10', 'Case 2', 'Case 1'].map((name) => ({ name }));
  assert.deepEqual(
    names.sort(byCaseName).map((n) => n.name),
    ['Case 1', 'Case 2', 'Case 10'],
  );
});

// --- display names ------------------------------------------------------

check('a Case label falls back to its name, and clearing a display name restores it', () => {
  const store = new CaseStore();
  const c = store.createCase('2030_HL_v3_final');
  assert.equal(caseLabel(c), '2030_HL_v3_final', 'no display name: the label is the name');
  store.setDisplayName(c.id, '  2030 High Load  ');
  assert.equal(caseLabel(c), '2030 High Load', 'trimmed');
  assert.equal(c.name, '2030_HL_v3_final', 'the name a drop joins on is never changed');
  store.setDisplayName(c.id, '');
  assert.equal(caseLabel(c), '2030_HL_v3_final', 'blank clears it');
  assert.equal(c.displayName, undefined);
  store.setDisplayName(c.id, 'X');
  store.setDisplayName(c.id, '2030_HL_v3_final');
  assert.equal(c.displayName, undefined, 'its own name clears it too');
});

check("a display name matching another Case's name or display name is refused", () => {
  const store = new CaseStore();
  const a = store.createCase('Run A');
  const b = store.createCase('Run B');
  store.setDisplayName(a.id, 'Summer');
  assert.throws(() => store.setDisplayName(b.id, 'Run A'), /Another Case is named "Run A"/);
  assert.throws(
    () => store.setDisplayName(b.id, 'Summer'),
    /Another Case is shown as "Summer" \(its name is "Run A"\)/,
  );
  assert.equal(caseLabel(b), 'Run B', 'a refused name changes nothing');
  assert.equal(displayNameRefusal(store.listCases(), a.id, 'Summer'), undefined, 'its own is fine');
  store.setDisplayName(b.id, 'Winter');
  assert.equal(caseLabel(b), 'Winter');
});

check('a typed name finds a Case by its name or its display name', () => {
  const store = new CaseStore();
  const a = store.createCase('Run A');
  store.setDisplayName(a.id, 'Summer');
  assert.equal(caseForName(store.listCases(), 'Run A'), a);
  assert.equal(caseForName(store.listCases(), 'Summer'), a);
  assert.equal(caseForName(store.listCases(), 'Winter'), undefined);
});

check('byCaseName sorts by the label a reader sees', () => {
  const cases = [{ name: 'zz_run', displayName: 'Alpha' }, { name: 'Beta' }];
  assert.deepEqual(cases.sort(byCaseName).map(caseLabel), ['Alpha', 'Beta']);
});

console.log(`\n${passed} checks passed`);
