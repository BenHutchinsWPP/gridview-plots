// tests/test_generator_resolve.mjs — the membership-key resolver: the two ways a
// groupings file may name a unit become the one key the app uses.
//
// Ranked by how badly each one fails silently when it is wrong:
//
//   * **`Unit ID` equivalence is applied to BOTH sides of the join.** `01`
//     and `1` are the same unit to an analyst; a normalisation only one side
//     applies drops units with no error, which is the silent failure this
//     suite exists to catch.
//   * **A cell that is not a bus number is refused, never NaN.** A NaN bus
//     number matches nothing and reads as a unit the study lacks rather than
//     a cell that was wrong.
//   * **A pair two list rows share refuses with both names**, never resolves
//     to one of them.
//   * **A key naming a unit the study lacks is unresolved, not refused** --
//     the caller keeps and flags it, because a grouping written for a bigger
//     study is worth keeping.
//
// Run:  node test_generator_resolve.mjs

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { buildLookup } = await import('../src/lookups/parse.ts');
const { GENERATOR_LIST } = await import('../src/lookups/schema.ts');
const {
  BUS_ID_COLUMN,
  UNIT_ID_COLUMN,
  busIdOf,
  generatorKeyIndex,
  normaliseUnitId,
  resolveMembershipKey,
} = await import('../src/tables/generator/resolve.ts');

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

/** A GeneratorList carrying only the three columns resolution reads, built
 * through the real `buildLookup` so the column kinds are the schema's and
 * not a hand-rolled imitation of them. Rows: [name, busId, unitId]. */
function syntheticList(rows) {
  const columns = [GENERATOR_LIST.keyColumn, BUS_ID_COLUMN, UNIT_ID_COLUMN];
  const map = new Map(
    rows.map(([name, busId, unitId]) => [
      name,
      [name, busId === null ? null : String(busId), unitId],
    ]),
  );
  return buildLookup({
    entity: 'generator',
    keyColumn: GENERATOR_LIST.keyColumn,
    columns,
    rows: map,
    sources: ['synthetic GeneratorList'],
  });
}

const pair = (busId, unitId) => ({ by: 'bus-unit', busId, unitId });
const name = (n) => ({ by: 'name', name: n });

// ---------------------------------------------- the Name key is the app's key

{
  const list = syntheticList([
    ['SYN-WIND-1', 101, '1'],
    ['SYN-GAS-2', 202, '01'],
  ]);
  const index = generatorKeyIndex(list);

  assert.deepEqual(resolveMembershipKey(index, name('SYN-WIND-1')), {
    status: 'resolved',
    name: 'SYN-WIND-1',
  });
  ok('a Name key the list carries resolves to itself');

  // With no list loaded there is nothing to check a Name against, and none is
  // needed: the name already is the app's key. A file keyed by Name must
  // still load with no list at all.
  assert.deepEqual(resolveMembershipKey(undefined, name('  SYN-WIND-1  ')), {
    status: 'resolved',
    name: 'SYN-WIND-1',
  });
  ok('a Name key passes through as itself, trimmed, with no list loaded');

  const unknown = resolveMembershipKey(index, name('SYN-NOT-HERE'));
  assert.equal(unknown.status, 'unresolved');
  assert.match(unknown.reason, /SYN-NOT-HERE/);
  assert.match(unknown.reason, /GeneratorList\.csv/);
  ok('a Name key the study does not carry is unresolved, with the name in the reason');

  // The leniency the secondary key earns is not extended to names: folding
  // case would silently merge two units an analyst keeps apart on purpose.
  assert.equal(resolveMembershipKey(index, name('syn-wind-1')).status, 'unresolved');
  ok('a Name key compares exactly after the trim -- case is not folded');

  const blank = resolveMembershipKey(undefined, name('   '));
  assert.equal(blank.status, 'refused');
  ok('a blank Name cell is refused, never resolved to an empty key');
}

// ------------------------------------------------ the Unit ID domain rules

{
  // `01` and `1` are different strings and the same unit to an analyst. The
  // equivalence is a named normalisation BOTH join sides call, so it is
  // asserted on both sides: zeros and case in the membership cell, zeros and
  // case in the list's own cell.
  const list = syntheticList([
    ['SYN-WIND-1', 101, '1'],
    ['SYN-GAS-2', 202, '01'],
    ['SYN-HYDRO-3', 303, 'g1'],
  ]);
  const index = generatorKeyIndex(list);

  assert.equal(resolveMembershipKey(index, pair('101', '01')).name, 'SYN-WIND-1');
  ok('a membership Unit ID of "01" resolves the list unit "1"');

  assert.equal(resolveMembershipKey(index, pair('202', '1')).name, 'SYN-GAS-2');
  ok('a list Unit ID of "01" resolves the membership unit "1"');

  assert.equal(resolveMembershipKey(index, pair('303', 'G1')).name, 'SYN-HYDRO-3');
  assert.equal(resolveMembershipKey(index, pair('303', 'g1')).name, 'SYN-HYDRO-3');
  ok('unit IDs match case-insensitively from either side');

  assert.equal(normaliseUnitId('  007 '), '7');
  assert.equal(normaliseUnitId('0'), '0', 'a zero-only unit id is a unit, not a blank');
  ok('the unit-id normalisation itself: trim, upper-case, leading zeros off');

  const blank = resolveMembershipKey(index, pair('101', '  '));
  assert.equal(blank.status, 'refused');
  // A blank membership cell must never match a blank list cell: the list's
  // text column SPELLS its blanks as empty strings.
  ok('a blank Unit ID cell is refused rather than matched against blanks');
}

// --------------------------------------------- the Bus ID cell, integer or no

{
  const list = syntheticList([['SYN-WIND-1', 101, '1']]);
  const index = generatorKeyIndex(list);

  assert.equal(resolveMembershipKey(index, pair(' 101 ', '1')).name, 'SYN-WIND-1');
  assert.equal(resolveMembershipKey(index, pair('101.0', '1')).name, 'SYN-WIND-1');
  assert.equal(resolveMembershipKey(index, pair('101.00', '1')).name, 'SYN-WIND-1');
  ok('a bus number cell parses with surrounding space and a trailing .0');

  for (const cell of ['101.5', 'abc', '', '  ', 'NaN', 'Infinity', '1,234', '101 of 4']) {
    const out = resolveMembershipKey(index, pair(cell, '1'));
    assert.equal(out.status, 'refused', cell);
    if (out.status === 'refused') assert.match(out.reason, /bus number/);
  }
  ok('a cell that is not a bus number is refused naming the cell, never NaN');

  // The direct form of the same rule: null, not NaN, is the refusal. A NaN
  // key would match nothing and read as a unit the study lacks.
  assert.equal(busIdOf('40551.0'), 40551);
  for (const weird of ['40551.5', 'abc', '', 'NaN', 'Infinity', '1e3', '0x101', '101 of 4']) {
    const value = busIdOf(weird);
    assert.ok(value === null || Number.isInteger(value), weird);
  }
  ok('busIdOf returns a finite integer or null, never NaN');
}

// -------------------------------------- resolution needs a list, and says so

{
  const out = resolveMembershipKey(undefined, pair('101', '1'));
  assert.equal(out.status, 'refused');
  assert.match(out.reason, /GeneratorList\.csv/);
  assert.match(out.reason, /Name/);
  ok(
    'a bus-unit key with no list loaded is refused naming the list, the shape the area scope uses',
  );

  assert.equal(resolveMembershipKey(undefined, name('SYN-WIND-1')).status, 'resolved');
  ok('the no-list refusal never reaches a Name-keyed file');
}

// ------------------------------------------------- the ambiguous pair refusal

{
  const list = syntheticList([
    ['SYN-WIND-1', 101, '1'],
    ['SYN-WIND-2', 101, '1'],
    ['SYN-GAS-2', 202, '2'],
  ]);
  const index = generatorKeyIndex(list);

  const out = resolveMembershipKey(index, pair('101', '1'));
  assert.equal(out.status, 'refused');
  assert.match(out.reason, /SYN-WIND-1/);
  assert.match(out.reason, /SYN-WIND-2/);
  ok('a pair two list rows share refuses with both names, never last-writer-wins');

  assert.equal(resolveMembershipKey(index, pair('202', '2')).name, 'SYN-GAS-2');
  ok('the ambiguity refuses only the pair that is ambiguous');
}

// --------------------------- unresolved is a report, not a failure, and blanks

{
  const list = syntheticList([
    ['SYN-WIND-1', 101, '1'],
    // A row whose Bus ID is blank cannot be named by a pair; it must not
    // crash the index build or match a pair by accident.
    ['SYN-ORPHAN-9', null, '9'],
  ]);
  const index = generatorKeyIndex(list);

  const out = resolveMembershipKey(index, pair('999', '7'));
  assert.equal(out.status, 'unresolved');
  assert.match(out.reason, /999/);
  assert.match(out.reason, /GeneratorList\.csv/);
  ok('a pair no list row carries is unresolved -- the caller keeps and flags it');

  assert.equal(resolveMembershipKey(index, pair('101', '9')).status, 'unresolved');
  ok('a list row with a blank Bus ID is never matched by a pair naming its unit');
}

// ------------------------------------------- a list without the pair columns

{
  const list = buildLookup({
    entity: 'generator',
    keyColumn: GENERATOR_LIST.keyColumn,
    columns: [GENERATOR_LIST.keyColumn, UNIT_ID_COLUMN],
    rows: new Map([['SYN-WIND-1', ['SYN-WIND-1', '1']]]),
    sources: ['synthetic GeneratorList'],
  });
  assert.throws(() => generatorKeyIndex(list), /Bus ID/);
  ok('a GeneratorList missing a pair column refuses at index build, naming the column');
}

console.log(`\n${checks} checks passed.`);
