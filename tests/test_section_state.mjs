// tests/test_section_state.mjs — a kind's retained-column state survives
// hide and show, and clears only when THAT KIND's last table goes. Runs in
// Node because section-state.ts imports no DOM. A remount (new state), or a
// gate reading a cross-kind case list, would reset a selection silently.

import './test_loader.mjs';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { CaseStore } = await import('../src/model/case-model.ts');
const { createSectionState } = await import('../src/ui/section-state.ts');
const { createRetainGate } = await import('../src/ui/retain-gate.ts');

let checks = 0;
function check(what, fn) {
  fn();
  checks++;
  console.log(`ok - ${what}`);
}

/** Re-read the store, and independently ask whether this kind still has a
 * table: the two must agree, or a count of Cases (or all kinds) is being
 * used. */
function observe(state, store) {
  state.noteTablesChanged(store);
  return store.tablesOfKind(state.kind).length > 0;
}

const AREA = { kind: 'area' };
const PF = { kind: 'interface', variant: 'Power Flow (MW)' };
const CC = { kind: 'interface', variant: 'Congestion Cost ($)' };

// --------------------------------------------------------------- the basics

check('a fresh section has no retained set, so the next drop of its kind shows the picker', () => {
  const state = createSectionState('area');
  assert.equal(state.kind, 'area');
  assert.equal(state.retainedColumns, null);
});

check('setRetained is the only writer, and a cancelled picker is recorded as null', () => {
  const store = new CaseStore();
  const one = store.createCase('Case1');
  store.attachTable(one.id, AREA, {});
  const state = createSectionState('area');

  state.setRetained(['Load (MWh)', 'Price ($/MWh)']);
  assert.deepEqual(state.retainedColumns, ['Load (MWh)', 'Price ($/MWh)']);
  state.setRetained(null);
  assert.equal(state.retainedColumns, null, 'a cancelled picker leaves the section without a set');
});

check(
  'a table of this kind coming and going does not disturb the set while one is still loaded',
  () => {
    const store = new CaseStore();
    const first = store.createCase('Case1');
    store.attachTable(first.id, AREA, {});
    const state = createSectionState('area');
    state.setRetained(['Load (MWh)']);

    const second = store.createCase('Case2');
    store.attachTable(second.id, AREA, {});
    assert.equal(observe(state, store), true);
    assert.deepEqual(state.retainedColumns, ['Load (MWh)'], 'a second drop reuses the loaded axis');

    store.detachTable(second.id, AREA);
    assert.equal(observe(state, store), true, 'one Area table left, so the section stays visible');
    assert.deepEqual(state.retainedColumns, ['Load (MWh)']);
  },
);

// ------------------------------------------- hide/show does not touch state

check("the OTHER section being hidden and shown again leaves this one's set untouched", () => {
  const store = new CaseStore();
  // One Case holding an Area table and an Interface table, which is the
  // shape that makes this failure reachable: the two sections share a Case
  // list, so a gate that reads that list decides both kinds at once.
  const study = store.createCase('Study A');
  store.attachTable(study.id, AREA, {});
  store.attachTable(study.id, PF, {});

  const area = createSectionState('area');
  const iface = createSectionState('interface');
  area.setRetained(['Load (MWh)']);
  const chosen = ['NORTH-SOUTH', 'EAST-WEST'];
  iface.setRetained(chosen);

  // A full visibility cycle of the AREA section, driven by the same call the
  // registry makes. Each step asserts the cycle is REAL -- a test where the
  // section never actually hides would pass vacuously.
  assert.equal(observe(area, store), true, 'shown: an Area table is loaded');
  assert.equal(observe(iface, store), true);

  store.detachTable(study.id, AREA); // the last Area table goes
  assert.equal(observe(area, store), false, 'hidden: no Area table left');
  assert.equal(observe(iface, store), true, 'the interface state is untouched by that');
  assert.deepEqual(
    iface.retainedColumns,
    chosen,
    "removing the last case of the OTHER kind must not clear this section's set",
  );

  store.attachTable(study.id, AREA, {}); // and comes back
  assert.equal(observe(area, store), true, 'shown again');
  assert.deepEqual(
    iface.retainedColumns,
    chosen,
    'nor may the other section being shown again clear it',
  );

  store.detachTable(study.id, AREA);
  assert.equal(observe(area, store), false, 'hidden again');
  assert.deepEqual(iface.retainedColumns, chosen, 'still untouched after a second cycle');
  // Identity, not just contents: a re-mounted section would hand back a
  // different array from a different state object even when it happened to
  // hold equal strings.
  assert.equal(iface.retainedColumns, chosen, 'the very same state object survived the cycle');
});

check("removing the whole Case that owned the other kind's table changes nothing here", () => {
  const store = new CaseStore();
  const areaOnly = store.createCase('Area only');
  store.attachTable(areaOnly.id, AREA, {});
  const ifaceOnly = store.createCase('Interface only');
  store.attachTable(ifaceOnly.id, PF, {});

  const iface = createSectionState('interface');
  iface.setRetained(['NORTH-SOUTH']);

  store.removeCase(areaOnly.id);
  assert.equal(store.tablesOfKind('area').length > 0, false);
  assert.equal(observe(iface, store), true);
  assert.deepEqual(iface.retainedColumns, ['NORTH-SOUTH']);
});

// ------------------------------- clears only on this kind's OWN last table

check("the set clears only when this kind's own last table is detached", () => {
  const store = new CaseStore();
  // One Case, two Interface tables: two quantities from one run. The
  // first detach must NOT clear the set -- the section still has a table.
  const study = store.createCase('Study A');
  store.attachTable(study.id, AREA, {});
  store.attachTable(study.id, PF, {});
  store.attachTable(study.id, CC, {});

  const iface = createSectionState('interface');
  iface.setRetained(['NORTH-SOUTH']);

  store.detachTable(study.id, PF);
  assert.equal(observe(iface, store), true, 'one Interface table left');
  assert.deepEqual(iface.retainedColumns, ['NORTH-SOUTH'], 'not the LAST one, so nothing clears');

  store.detachTable(study.id, CC);
  assert.equal(observe(iface, store), false, 'no Interface table left, so the section hides');
  assert.equal(
    iface.retainedColumns,
    null,
    "THIS kind's last table is what clears it: the next Interface drop is offered its picker again",
  );
  // And the Area table that is still loaded is unaffected by any of it.
  assert.equal(store.tablesOfKind('area').length > 0, true);
});

check('removing the last Case that carried this kind clears it, however the table went', () => {
  const store = new CaseStore();
  const study = store.createCase('Study A');
  store.attachTable(study.id, PF, {});
  const iface = createSectionState('interface');
  iface.setRetained(['NORTH-SOUTH']);

  store.removeCase(study.id); // the whole Case, not one slot
  assert.equal(observe(iface, store), false);
  assert.equal(iface.retainedColumns, null);
});

check('an empty store leaves every kind irrelevant and every set null', () => {
  const store = new CaseStore();
  for (const kind of ['area', 'interface', 'attribute']) {
    const state = createSectionState(kind);
    state.setRetained(['something']);
    assert.equal(observe(state, store), false, `${kind} has nothing to show`);
    assert.equal(state.retainedColumns, null, `${kind}'s set cleared`);
  }
});

// ----------------------------------------------------------------- the gate
//
// The gate shows its picker iff `retainedColumns` is null; `requestsPicker`
// mirrors that condition, since the real picker needs a DOM.

function requestsPicker(state) {
  return state.retainedColumns === null;
}

check('the first table of a kind requests a picker', () => {
  const store = new CaseStore();
  const state = createSectionState('area');
  assert.equal(requestsPicker(state), true, 'no Area table has ever loaded');

  const first = store.createCase('Case1');
  store.attachTable(first.id, AREA, {});
  observe(state, store);
  assert.equal(requestsPicker(state), true, 'the table landed, but nothing has resolved a set yet');

  // What `resolveRetained` does once its picker resolves.
  state.setRetained(['Load (MWh)']);
  assert.equal(
    requestsPicker(state),
    false,
    'resolved once, so the next drop of this kind reuses it',
  );
});

check('a second table of the same kind does not request a picker', () => {
  const store = new CaseStore();
  const state = createSectionState('area');
  const first = store.createCase('Case1');
  store.attachTable(first.id, AREA, {});
  observe(state, store);
  state.setRetained(['Load (MWh)']);

  const second = store.createCase('Case2');
  store.attachTable(second.id, AREA, {});
  observe(state, store);
  assert.equal(
    requestsPicker(state),
    false,
    'a second Area table reuses the axis already in memory',
  );
  assert.deepEqual(state.retainedColumns, ['Load (MWh)']);
});

check('removing the last case of that kind means the next drop requests it again', () => {
  const store = new CaseStore();
  const state = createSectionState('interface');
  const study = store.createCase('Study A');
  store.attachTable(study.id, PF, {});
  observe(state, store);
  state.setRetained(['NORTH-SOUTH']);
  assert.equal(requestsPicker(state), false);

  store.detachTable(study.id, PF); // the last Interface table on the last case
  observe(state, store);
  assert.equal(requestsPicker(state), true, 'no Interface table left, so the next drop asks again');
});

check('a kind with zero tables always requests a picker, whatever the other kind is doing', () => {
  const store = new CaseStore();
  const loadedKind = createSectionState('interface');
  const emptyKind = createSectionState('area'); // never gets a table in this check

  const study = store.createCase('Study A');
  store.attachTable(study.id, PF, {});
  observe(loadedKind, store);
  loadedKind.setRetained(['NORTH-SOUTH']);

  // The Area section still sees zero Area tables -- Interface's drop and
  // resolution above must not have touched it (no `cases.length`, no
  // `tablesOfKind(kind)[0]`).
  observe(emptyKind, store);
  assert.equal(
    requestsPicker(emptyKind),
    true,
    'Area has zero tables, so it still requests a picker',
  );
  assert.equal(requestsPicker(loadedKind), false, 'Interface already resolved its own set');
});

// --------------------------------------------------- the structural promises
//
// Two static checks for what the runtime assertions assume.

check('src/ui/section-state.ts touches no DOM and imports nothing at runtime', () => {
  const source = readFileSync(new URL('../src/ui/section-state.ts', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const needle of ['document', 'window', 'HTMLElement', './charts', 'uplot']) {
    assert.ok(!code.includes(needle), `no ${needle} in section-state.ts -- it runs under Node`);
  }
  // Every import is type-only, so nothing it names survives type stripping and
  // the module cannot acquire a DOM dependency through the back door.
  const imports = code.match(/^import .*/gm) ?? [];
  assert.ok(imports.length > 0, 'the module does import its types');
  for (const line of imports) {
    assert.ok(line.startsWith('import type '), `type-only import, found: ${line}`);
  }
});

check('src/ui/shell.ts never removes a mounted section (mount once, then hide)', () => {
  const source = readFileSync(new URL('../src/ui/shell.ts', import.meta.url), 'utf8');
  // Ban the mechanisms (the word "unmount" appears in that file's prose).
  for (const needle of ['removeChild', '.remove()', 'replaceWith', 'replaceChildren']) {
    assert.ok(
      !source.includes(needle),
      `no ${needle} in ui/shell.ts: a section is mounted once and then shown or hidden, ` +
        'never taken out of the document and rebuilt',
    );
  }
  assert.ok(source.includes('hidden = !'), 'visibility is a `hidden` flag on the mounted section');
});

check('a stored selection is reused only over the columns it was offered from', () => {
  // The retained set is sticky over what the picker SHOWED, not over what the
  // user ticked. A file re-dropped after a
  // partial selection offers nothing new and must not ask again.
  const state = createSectionState('bus');
  assert.equal(state.covers(['101']), false, 'nothing stored yet, so the picker opens');

  state.setRetained(['101'], ['101', '102', '103']);
  assert.equal(state.covers(['101', '102', '103']), true, 'the same file again does not ask');
  assert.equal(state.covers(['102']), true, 'nor does a file of buses that were declined');
  assert.equal(state.covers(['101', '104']), false, 'a bus nobody has seen reopens the picker');
});

check('a widening choice widens what counts as offered', () => {
  const state = createSectionState('bus');
  state.setRetained(['101'], ['101', '102']);
  state.setRetained(['101', '104'], ['104', '105']);
  assert.deepEqual(state.retainedColumns, ['101', '104']);
  assert.equal(state.covers(['102', '105']), true, "both pickers' unions are remembered");
  assert.equal(state.covers(['106']), false);
});

check('a cancelled picker forgets what it offered', () => {
  // A cancel is not a selection, so the next drop starts from nothing rather
  // than silently treating the cancelled union as already decided.
  const state = createSectionState('bus');
  state.setRetained(['101'], ['101', '102']);
  state.setRetained(null);
  assert.equal(state.retainedColumns, null);
  assert.equal(state.covers(['101']), false);
});

// ------------------------------------------------ the gate, driven for real
//
// With a stub picker callback. Asserted: "Load everything" is checked before
// `covers` (or an earlier narrow choice is reused silently), and it still
// goes through the kind's picker, which prices it.

async function checkAsync(what, fn) {
  await fn();
  checks++;
  console.log(`ok - ${what}`);
}

/** A gate with a scripted picker and a log. `declines` makes a
 * keep-everything batch resolve `null` (confirmation declined). */
function gateWithLog(kind, answer, declines = false) {
  const asked = [];
  const gate = createRetainGate(kind, async (batch) => {
    asked.push(batch.everything);
    if (!batch.everything) return answer;
    return declines ? null : batch.union;
  });
  return { gate, asked };
}

const batchOf = (union, everything) => ({
  union,
  fileCount: 1,
  axisCount: 0,
  coverage: new Map(),
  everything,
});

await checkAsync('a keep-everything batch reaches the picker, and keeps the union', async () => {
  const store = new CaseStore();
  const { gate, asked } = gateWithLog('bus', ['101']);
  const retained = await gate.resolveRetained(store, batchOf(['101', '102'], true));
  assert.deepEqual(retained, ['101', '102']);
  assert.deepEqual(asked, [true], 'the kind is told, so it can price what it is about to keep');
});

await checkAsync('keeping everything overrides a narrower set already stored', async () => {
  const store = new CaseStore();
  const study = store.createCase('Study A');
  store.attachTable(study.id, PF, {});
  const { gate, asked } = gateWithLog('interface', ['NORTH-SOUTH']);

  const first = await gate.resolveRetained(store, batchOf(['NORTH-SOUTH', 'EAST-WEST'], false));
  assert.deepEqual(first, ['NORTH-SOUTH']);

  const second = await gate.resolveRetained(store, batchOf(['NORTH-SOUTH', 'EAST-WEST'], true));
  assert.deepEqual(second, ['NORTH-SOUTH', 'EAST-WEST'], 'a covered union is still widened');
  assert.deepEqual(asked, [false, true], 'coverage did not answer for the second drop');
});

await checkAsync('keeping everything is recorded as an answer, not skipped', async () => {
  const store = new CaseStore();
  const study = store.createCase('Study A');
  store.attachTable(study.id, PF, {});
  const { gate, asked } = gateWithLog('interface', ['NORTH-SOUTH']);

  await gate.resolveRetained(store, batchOf(['NORTH-SOUTH', 'EAST-WEST'], true));
  const next = await gate.resolveRetained(store, batchOf(['NORTH-SOUTH'], false));
  assert.deepEqual(next, ['NORTH-SOUTH', 'EAST-WEST']);
  assert.deepEqual(
    asked,
    [true],
    'the shortcut answered for this kind, so the next drop reuses it',
  );
});

await checkAsync('a declined allocation leaves the kind with no set at all', async () => {
  // The picker's `null` is the confirmation in front of a very large
  // allocation being declined. It is a cancel, so the next drop asks again --
  // it must not be recorded as "everything was chosen".
  const store = new CaseStore();
  const study = store.createCase('Study A');
  store.attachTable(study.id, PF, {});
  const { gate, asked } = gateWithLog('interface', ['NORTH-SOUTH'], true);

  const declined = await gate.resolveRetained(store, batchOf(['NORTH-SOUTH', 'EAST-WEST'], true));
  assert.equal(declined, null);
  const next = await gate.resolveRetained(store, batchOf(['NORTH-SOUTH'], false));
  assert.deepEqual(next, ['NORTH-SOUTH']);
  assert.deepEqual(asked, [true, false], 'asked again, because nothing was ever settled');
});

console.log(`\n${checks} checks passed.`);
