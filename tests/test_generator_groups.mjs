// tests/test_generator_groups.mjs — the generator group map and its
// persistence.
//
//   * Membership is stored RESOLVED, as names.
//   * Unresolved rows are kept and flagged, never dropped.
//   * Refusals are counted.
//   * No figure reads as a fleet size (many-to-many).
//   * The optional manifest field round-trips; older bundles load unchanged.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './test_loader.mjs';

const { buildLookup } = await import('../src/lookups/parse.ts');
const { GENERATOR_LIST } = await import('../src/lookups/schema.ts');
const { BUS_ID_COLUMN, UNIT_ID_COLUMN, generatorKeyIndex } =
  await import('../src/tables/generator/resolve.ts');
const {
  EDITOR_CSV_HEADERS,
  EDITOR_MAPPING,
  editorCsvShape,
  adoptGeneratorGroups,
  chosenGroupMapping,
  clearGeneratorGroups,
  exportGeneratorGroups,
  generatorGroupNames,
  hasGeneratorGroups,
  indexForMapping,
  loadGeneratorGroups,
  planGeneratorGroups,
  readSavedGeneratorGroups,
  setGeneratorMembership,
  summarizeGeneratorGroups,
  unitsInGroup,
  unresolvedMembershipRows,
} = await import('../src/tables/generator/groups.ts');
const { restoreBundle, readBundleFile } = await import('../src/storage/store.ts');
const { buildManifest, BUNDLE_VERSION } = await import('../src/storage/envelope.ts');

const { readSessionReference } = await import('../src/session/reference.ts');
const { createLimitsStore } = await import('../src/limits/store.ts');
/** Session contents with no groupings mapping -- see test_lookup_storage.mjs. */
const sessionContents = () => ({ ...readSessionReference(createLimitsStore()), groupings: null });

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

/** A GeneratorList carrying only the three columns resolution reads, built
 * through the real `buildLookup` so the column kinds are the schema's. Rows:
 * [name, busId, unitId]. */
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

const LIST = syntheticList([
  ['SYN-WIND-1', 101, '1'],
  ['SYN-HYDRO-2', 101, '2'],
  ['SYN-GAS-3', 202, '01'],
  ['SYN-SOLAR-4', 303, '4'],
]);
const LIST_NAMES = ['SYN-WIND-1', 'SYN-HYDRO-2', 'SYN-GAS-3', 'SYN-SOLAR-4'];

const NAME_MAPPING = {
  key: { by: 'name', nameColumn: 'Unit' },
  groupColumn: 'Injection Group',
};
const NAME_FILE = [
  'Unit,Injection Group',
  'SYN-WIND-1,River SYN',
  'SYN-HYDRO-2,River SYN',
  'SYN-GAS-3,Plant SYN',
  'SYN-WIND-1,Plant SYN',
  'SYN-NOT-HERE,River SYN',
].join('\n');

const PAIR_MAPPING = {
  key: { by: 'bus-unit', busColumn: 'Bus Number', unitColumn: 'Unit' },
  groupColumn: 'Group',
};
const PAIR_FILE = [
  'Bus Number,Unit,Group',
  '101,1,River SYN',
  ' 202.0 ,01,River SYN',
  '101,9,River SYN',
  'abc,1,Plant SYN',
].join('\n');

function reset() {
  clearGeneratorGroups();
}

// ------------------------------------------------------ stored as name keys

{
  reset();
  const load = loadGeneratorGroups(NAME_FILE, NAME_MAPPING, generatorKeyIndex(LIST));

  assert.deepEqual(generatorGroupNames(), ['River SYN', 'Plant SYN']);
  assert.deepEqual(unitsInGroup('River SYN'), ['SYN-WIND-1', 'SYN-HYDRO-2', 'SYN-NOT-HERE']);
  assert.deepEqual(unitsInGroup('Plant SYN'), ['SYN-GAS-3', 'SYN-WIND-1']);
  assert.equal(hasGeneratorGroups(), true);
  assert.equal(load.memberships, 5);
  ok('a name-keyed file builds group -> member names, insertion order kept');
}

{
  reset();
  loadGeneratorGroups(PAIR_FILE, PAIR_MAPPING, generatorKeyIndex(LIST));

  // THE stored-resolved rule: the map holds NAMES, never the pair cells that
  // named them. Both normalisations (leading zeros, trailing ".0", padding)
  // are exercised on the way in, so these rows prove the resolver ran.
  assert.deepEqual(unitsInGroup('River SYN'), ['SYN-WIND-1', 'SYN-GAS-3']);
  for (const group of generatorGroupNames()) {
    for (const member of unitsInGroup(group)) {
      assert.ok(!member.includes('|'), `member "${member}" is a pair, not a name`);
      assert.ok(!/^\s*\d+(\.0)?\s*$/.test(member), `member "${member}" is a bus cell, not a name`);
    }
  }
  ok('a (bus, unit) file is stored RESOLVED — the map holds names, not pairs');
}

{
  reset();
  // The same unit through both spellings, one row naming it twice: a repeated
  // membership is one membership, and a unit in two groups is two.
  const file = [
    'Bus Number,Unit,Group',
    '101,01,River SYN',
    '101,1,River SYN',
    '101,1,Plant SYN',
  ].join('\n');
  const load = loadGeneratorGroups(file, PAIR_MAPPING, generatorKeyIndex(LIST));
  assert.deepEqual(unitsInGroup('River SYN'), ['SYN-WIND-1']);
  assert.deepEqual(unitsInGroup('Plant SYN'), ['SYN-WIND-1']);
  assert.equal(load.memberships, 2, 'the repeated row dedupes to one membership');
  ok('repeated rows dedupe; one unit sits in several groups (many-to-many)');
}

// ------------------------------------------------ unresolved: kept, flagged

{
  reset();
  const load = loadGeneratorGroups(NAME_FILE, NAME_MAPPING, generatorKeyIndex(LIST));

  // The bigger-study row is IN the map — a name is already the stored key —
  // and the flag against the list is what says it cannot be plotted.
  assert.ok(unitsInGroup('River SYN').includes('SYN-NOT-HERE'));
  const summary = summarizeGeneratorGroups(LIST_NAMES);
  assert.equal(summary.groups, 2);
  assert.equal(summary.mapped, 3);
  assert.deepEqual(summary.offList, ['SYN-NOT-HERE']);
  assert.deepEqual(summary.unmapped, ['SYN-SOLAR-4']);
  assert.equal(load.unresolved, 1);
  ok('a name the list lacks stays in the map and is flagged off-list, not dropped');

  assert.deepEqual(summarizeGeneratorGroups(undefined), {
    groups: 2,
    mapped: 0,
    offList: [],
    unmapped: [],
  });
  ok('with no list loaded the summary flags nothing — a name-keyed file loaded without one');
}

{
  reset();
  const load = loadGeneratorGroups(PAIR_FILE, PAIR_MAPPING, generatorKeyIndex(LIST));

  // A pair that resolves to no name has nothing to be stored under: it is
  // kept BESIDE the map, with the file's own cells and the resolver's reason.
  const kept = unresolvedMembershipRows();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].group, 'River SYN');
  assert.equal(kept[0].busId, '101');
  assert.equal(kept[0].unitId, '9');
  assert.match(kept[0].reason, /9/);
  assert.match(kept[0].reason, /GeneratorList\.csv/);
  assert.equal(load.unresolved, 1);
  ok('a pair no list row carries is kept beside the map with its cells and reason');
}

// --------------------------------------------- refusals: counted, not silent

{
  reset();
  const load = loadGeneratorGroups(PAIR_FILE, PAIR_MAPPING, generatorKeyIndex(LIST));

  assert.equal(load.refusals.length, 1);
  assert.equal(load.refusals[0].rows, 1);
  assert.match(load.refusals[0].reason, /bus number/);
  assert.equal(unitsInGroup('Plant SYN').length, 0, 'the refused row became no membership');
  ok('a row that is not a bus number is refused with a count, never NaN-matched');
}

{
  reset();
  const file = [
    'Unit,Injection Group',
    'SYN-WIND-1,', // blank group
    ',Plant SYN', // blank name
    'SYN-GAS-3,Plant SYN',
  ].join('\n');
  const load = loadGeneratorGroups(file, NAME_MAPPING, generatorKeyIndex(LIST));
  assert.equal(load.refusals.length, 2, 'two distinct refusal reasons');
  assert.equal(
    load.refusals.reduce((sum, entry) => sum + entry.rows, 0),
    2,
  );
  assert.deepEqual(generatorGroupNames(), ['Plant SYN']);
  assert.deepEqual(unitsInGroup('Plant SYN'), ['SYN-GAS-3']);
  ok('blank group and blank name rows are refused and counted, the rest still loads');
}

{
  reset();
  // (bus, unit) is not unique in a list; a name key is. The resolver refuses
  // an ambiguous pair with both names, and the file's only row refusing means
  // the load is refused whole — with that reason in the message.
  const ambiguous = syntheticList([
    ['SYN-WIND-1', 101, '1'],
    ['SYN-WIND-2', 101, '1'],
  ]);
  assert.throws(
    () =>
      loadGeneratorGroups(
        'Bus Number,Unit,Group\n101,1,River SYN\n',
        PAIR_MAPPING,
        generatorKeyIndex(ambiguous),
      ),
    /SYN-WIND-1.*SYN-WIND-2/s,
  );
  assert.equal(hasGeneratorGroups(), false);
  ok('an ambiguous pair refuses the load with both names in the reason');
}

// ------------------------------------------------ file-level refusals

{
  reset();
  assert.throws(
    () => loadGeneratorGroups(PAIR_FILE, PAIR_MAPPING, undefined),
    /GeneratorList\.csv/,
  );
  assert.equal(hasGeneratorGroups(), false);
  ok('a (bus, unit) file with no list loaded is refused by name, whole');

  reset();
  loadGeneratorGroups(NAME_FILE, NAME_MAPPING, undefined);
  assert.deepEqual(unitsInGroup('River SYN'), ['SYN-WIND-1', 'SYN-HYDRO-2', 'SYN-NOT-HERE']);
  ok('the no-list refusal never reaches a name-keyed file');
}

{
  reset();
  assert.throws(
    () =>
      loadGeneratorGroups(
        NAME_FILE,
        { key: { by: 'name', nameColumn: 'Unit ID' }, groupColumn: 'Injection Group' },
        generatorKeyIndex(LIST),
      ),
    /Unit ID/,
  );
  ok('a mapping naming a column the file does not carry is refused naming the column');
}

{
  reset();
  loadGeneratorGroups(NAME_FILE, NAME_MAPPING, generatorKeyIndex(LIST));
  const before = exportGeneratorGroups();

  // Every row refuses (a header and one not-a-bus-number row): nothing became
  // membership, so the mapping already loaded is left exactly as it was.
  assert.throws(
    () =>
      loadGeneratorGroups(
        'Bus Number,Unit,Group\nabc,1,River SYN\n',
        PAIR_MAPPING,
        generatorKeyIndex(LIST),
      ),
    /left unchanged/,
  );
  assert.deepEqual(exportGeneratorGroups(), before);
  ok('a file that produces no membership throws and leaves the loaded map unchanged');

  assert.throws(
    () => loadGeneratorGroups('Unit,Injection Group\n', NAME_MAPPING, generatorKeyIndex(LIST)),
    /left unchanged/,
  );
  ok('a header with no rows is refused the same way');
}

{
  reset();
  loadGeneratorGroups(NAME_FILE, NAME_MAPPING, generatorKeyIndex(LIST));
  loadGeneratorGroups(
    'Unit,Injection Group\nSYN-SOLAR-4,Desert SYN\n',
    NAME_MAPPING,
    generatorKeyIndex(LIST),
  );
  assert.deepEqual(generatorGroupNames(), ['Desert SYN']);
  assert.deepEqual(unitsInGroup('Desert SYN'), ['SYN-SOLAR-4']);
  ok('loading replaces the map rather than merging into it');
}

// ------------------------------------------------------------- persistence

{
  reset();
  assert.equal(exportGeneratorGroups(), null);

  loadGeneratorGroups(NAME_FILE, NAME_MAPPING, generatorKeyIndex(LIST));
  const saved = exportGeneratorGroups();
  assert.deepEqual(saved.mapping, NAME_MAPPING);
  assert.deepEqual(chosenGroupMapping(), NAME_MAPPING);
  assert.deepEqual(saved.members, [
    ['River SYN', ['SYN-WIND-1', 'SYN-HYDRO-2', 'SYN-NOT-HERE']],
    ['Plant SYN', ['SYN-GAS-3', 'SYN-WIND-1']],
  ]);
  assert.deepEqual(saved.unresolved, []);
  ok('the session exports its map with the column mapping that produced it');
}

{
  reset();
  loadGeneratorGroups(PAIR_FILE, PAIR_MAPPING, generatorKeyIndex(LIST));
  const saved = exportGeneratorGroups();
  assert.deepEqual(saved.mapping, PAIR_MAPPING);
  assert.equal(saved.unresolved.length, 1);
  ok('kept-unresolved rows ride the saved map beside the members');
}

{
  reset();
  loadGeneratorGroups(NAME_FILE, NAME_MAPPING, generatorKeyIndex(LIST));

  // The writer side of both doors: `downloadBundle`/`saveBundle` hand
  // `buildManifest` this exact object.
  const { manifest } = buildManifest([], sessionContents());
  assert.equal(manifest.version, BUNDLE_VERSION, 'the optional field costs no version bump');
  assert.deepEqual(manifest.generatorGroups, exportGeneratorGroups());

  // The reader side, through the JSON both doors parse: what comes back is
  // what went in, and the reader hands the CALLER the map (it adopts nothing).
  const wire = JSON.parse(JSON.stringify(manifest));
  const bundle = restoreBundle(wire, []);
  assert.deepEqual(bundle.generatorGroups, exportGeneratorGroups());
  assert.deepEqual(bundle.warnings, []);
  ok('the map round-trips through buildManifest -> JSON -> restoreBundle unchanged');
}

{
  reset();
  loadGeneratorGroups(PAIR_FILE, PAIR_MAPPING, generatorKeyIndex(LIST));
  const { manifest } = buildManifest([], sessionContents());
  const json = JSON.stringify(manifest);
  const header = Buffer.alloc(8);
  header.write('GVMB', 0, 'ascii');
  header.writeUInt32LE(Buffer.byteLength(json), 4);
  const file = new File([header, Buffer.from(json)], 'study.gvmb');
  const bundle = await readBundleFile(file);
  assert.deepEqual(bundle.generatorGroups, exportGeneratorGroups());
  ok('the map also survives the real .gvmb file door (magic + length + JSON)');
}

{
  reset();
  // A bundle written before the field existed: the field is absent, the
  // version is the same, and the restore behaves exactly as it always did.
  loadGeneratorGroups(NAME_FILE, NAME_MAPPING, generatorKeyIndex(LIST));
  const withField = buildManifest([], sessionContents()).manifest;
  const withoutField = JSON.parse(JSON.stringify(withField));
  delete withoutField.generatorGroups;

  const bundle = restoreBundle(withoutField, []);
  assert.equal(bundle.generatorGroups, null);
  assert.deepEqual(bundle.warnings, []);
  assert.equal('generatorGroups' in withoutField, false);
  ok('a bundle with no field restores as null with no warning — an older bundle loads as it did');
}

{
  reset();
  assert.equal(buildManifest([], sessionContents()).manifest.generatorGroups, undefined);
  assert.equal('generatorGroups' in buildManifest([], sessionContents()).manifest, false);
  ok('a session with no map writes no field at all');
}

{
  reset();
  loadGeneratorGroups(NAME_FILE, NAME_MAPPING, generatorKeyIndex(LIST));
  const malformed = buildManifest([], sessionContents()).manifest;
  malformed.generatorGroups = { mapping: { key: { by: 'name' } } };

  const bundle = restoreBundle(malformed, []);
  assert.equal(bundle.generatorGroups, null);
  assert.equal(bundle.warnings.length, 1);
  assert.match(bundle.warnings[0], /generator group membership/);
  ok('a malformed field is dropped whole with a warning; the rest of the bundle loads');
}

{
  reset();
  loadGeneratorGroups(PAIR_FILE, PAIR_MAPPING, generatorKeyIndex(LIST));
  const saved = JSON.parse(JSON.stringify(exportGeneratorGroups()));

  // A reload of the study on a fresh session: adopt from raw JSON (what the
  // reader hands back), and the map, the kept rows and the mapping all return.
  clearGeneratorGroups();
  assert.equal(hasGeneratorGroups(), false);
  adoptGeneratorGroups(readSavedGeneratorGroups(saved));
  assert.deepEqual(exportGeneratorGroups(), saved);
  assert.deepEqual(chosenGroupMapping(), PAIR_MAPPING);
  assert.deepEqual(unitsInGroup('River SYN'), ['SYN-WIND-1', 'SYN-GAS-3']);
  assert.equal(unresolvedMembershipRows().length, 1);
  const summary = summarizeGeneratorGroups(LIST_NAMES);
  assert.deepEqual(summary.offList, []);
  ok('adopt from a saved field restores members, kept rows and the chosen mapping');
}

// ------------------------------------------------ plan: pure until applied

{
  reset();
  // The editor reads a CSV through the plan, so the plan must move NOTHING:
  // a file browsed inside the editor is the editor's in-progress membership,
  // not session state.
  planGeneratorGroups(NAME_FILE, NAME_MAPPING, generatorKeyIndex(LIST));
  assert.equal(hasGeneratorGroups(), false);
  assert.deepEqual(generatorGroupNames(), []);
  ok('a plan resolves a file without touching the loaded map — applying is a separate act');

  const plan = planGeneratorGroups(PAIR_FILE, PAIR_MAPPING, generatorKeyIndex(LIST));
  assert.equal(plan.kept.length, 1);
  assert.equal(plan.refusals.length, 1);
  assert.deepEqual([...plan.members.get('River SYN')], ['SYN-WIND-1', 'SYN-GAS-3']);
  loadGeneratorGroups(PAIR_FILE, PAIR_MAPPING, generatorKeyIndex(LIST));
  assert.deepEqual(unitsInGroup('River SYN'), [...plan.members.get('River SYN')]);
  assert.deepEqual(unresolvedMembershipRows(), plan.kept);
  ok('load commits exactly the plan it resolved');
}

// ------------------------------------------------------- the editor's write

{
  reset();
  // Names in, kept rows riding along: an edit of one group's names is no
  // reason to drop rows a bigger study wrote.
  loadGeneratorGroups(PAIR_FILE, PAIR_MAPPING, generatorKeyIndex(LIST));
  const before = unresolvedMembershipRows().map((row) => ({ ...row }));

  setGeneratorMembership(
    new Map([
      ['River SYN', ['SYN-WIND-1']],
      ['Plant SYN', ['SYN-WIND-1', 'SYN-HYDRO-2']],
    ]),
    before,
  );
  assert.deepEqual(unitsInGroup('River SYN'), ['SYN-WIND-1']);
  assert.deepEqual(unitsInGroup('Plant SYN'), ['SYN-WIND-1', 'SYN-HYDRO-2']);
  assert.deepEqual(unresolvedMembershipRows(), before);
  ok('an editor apply replaces the membership and the kept rows ride along');

  // The provenance stays the mapping the membership came from: it records
  // where these names arrived, and an edit does not erase that.
  assert.deepEqual(chosenGroupMapping(), PAIR_MAPPING);
  ok('an edit keeps the mapping that produced the membership');

  setGeneratorMembership(new Map([['Desert SYN', ['SYN-SOLAR-4']]]));
  assert.deepEqual(unresolvedMembershipRows(), []);
  assert.equal(hasGeneratorGroups(), true);
  ok('an apply that carries no kept rows empties them — the caller said so');

  assert.throws(() => setGeneratorMembership(new Map()), /left unchanged/);
  assert.deepEqual(generatorGroupNames(), ['Desert SYN']);
  ok('an empty membership is refused and the loaded map is left unchanged');
}

{
  reset();
  // Groups hand-built with no CSV behind them: the mapping becomes the
  // editor's own file shape, so a bundle can still explain where membership
  // came from and exportGeneratorGroups has a mapping to carry.
  setGeneratorMembership(new Map([['River SYN', ['SYN-WIND-1']]]));
  assert.deepEqual(chosenGroupMapping(), EDITOR_MAPPING);
  const saved = exportGeneratorGroups();
  assert.ok(saved);
  assert.deepEqual(saved.mapping, EDITOR_MAPPING);
  ok('hand-built groups record the editor mapping as their provenance');

  // And that mapping is truthful: the saved map reloads through it unchanged.
  const csv = ['Name,Grouping', 'SYN-WIND-1,River SYN'].join('\n');
  assert.deepEqual(
    planGeneratorGroups(csv, EDITOR_MAPPING, generatorKeyIndex(LIST)).members.get('River SYN'),
    ['SYN-WIND-1'],
  );
  ok('the editor mapping reproduces the membership it claims to have produced');
}

// ---------------------------------------------------- the index a map needs

{
  // A list with no pair columns can still resolve NAMES; the index's own
  // refusal is the reason a (bus, unit) mapping must see instead of the
  // no-list-at-all wording.
  const bare = buildLookup({
    entity: 'generator',
    keyColumn: GENERATOR_LIST.keyColumn,
    columns: [GENERATOR_LIST.keyColumn],
    rows: new Map([
      ['SYN-WIND-1', ['SYN-WIND-1']],
      ['SYN-HYDRO-2', ['SYN-HYDRO-2']],
    ]),
    sources: ['synthetic bare list'],
  });

  assert.equal(indexForMapping(undefined, PAIR_MAPPING), undefined);
  assert.equal(indexForMapping(undefined, NAME_MAPPING), undefined);
  ok('no list loaded is no index, for either key form');

  assert.equal(indexForMapping(bare, NAME_MAPPING), undefined);
  assert.throws(() => indexForMapping(bare, PAIR_MAPPING), /Bus ID/);
  ok(
    'a list without the pair columns resolves names but refuses a pair mapping with its own reason',
  );

  assert.ok(indexForMapping(LIST, PAIR_MAPPING) !== undefined);
  ok('a list with both pair columns yields the index');
}

// --------------------------------------------------- two maps, no restate

{
  // The plan's decision, as an executable rule: the area map stays the AREA
  // map. Folding generator membership into src/lookups/groupings.ts would give the
  // shared map a resolution step only one side has.
  const area = readFileSync(new URL('../src/lookups/groupings.ts', import.meta.url), 'utf8');
  assert.ok(!/generator/i.test(area), 'src/lookups/groupings.ts speaks of generators');
  ok('src/lookups/groupings.ts carries no generator content — the two maps stay two');

  const source = readFileSync(
    new URL('../src/tables/generator/groups.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /from '\.\/resolve'/, 'the map builds on the seam-one resolver');
  assert.ok(
    !/normaliseUnitId|busIdOf/.test(source),
    'the map re-implements a key rule the resolver owns',
  );
  ok('the map imports the resolver instead of restating its key rules');

  // Membership is many-to-many, so a fleet figure would double-count. The
  // module must not offer one under any name.
  assert.ok(!/\btotal/i.test(source), 'the module offers a "total" figure');
  ok('no figure the module exposes reads as the size of the fleet');
}

// -------------------------------------------- the editor's file has two shapes
//
// Identifier columns only when this session can fill them; otherwise just
// `Name,Grouping`.

{
  const withIds = editorCsvShape(true);
  const noIds = editorCsvShape(false);

  assert.deepEqual(withIds.columns, ['Name', BUS_ID_COLUMN, UNIT_ID_COLUMN, 'Grouping']);
  // Spelled off the mapping, not off a literal: the fallback file IS the file
  // EDITOR_MAPPING claims was read, so a drift between them is the provenance
  // lying about the bytes.
  assert.deepEqual(noIds.columns, [EDITOR_MAPPING.key.nameColumn, EDITOR_MAPPING.groupColumn]);
  ok('with no GeneratorList the editor writes the two columns EDITOR_MAPPING names');

  assert.deepEqual(withIds.row('SYN-WIND-1', { bus: '101', unit: '1' }, 'River SYN'), [
    'SYN-WIND-1',
    '101',
    '1',
    'River SYN',
  ]);
  // A unit the list does not claim writes its row anyway: membership IS the
  // name, and the pair is only what this session happens to know.
  assert.deepEqual(withIds.row('SYN-NOT-HERE', undefined, 'River SYN'), [
    'SYN-NOT-HERE',
    '',
    '',
    'River SYN',
  ]);
  assert.deepEqual(noIds.row('SYN-WIND-1', { bus: '101', unit: '1' }, 'River SYN'), [
    'SYN-WIND-1',
    'River SYN',
  ]);
  ok('every row has as many cells as the shape has columns, identifiers known or not');

  assert.deepEqual(withIds.keptRow('909', '1', 'Plant SYN'), ['', '909', '1', 'Plant SYN']);
  // The shape with no pair columns REFUSES the row rather than writing one the
  // header cannot describe. Unreachable by construction -- a kept row implies
  // a list resolved something -- which is why it is loud rather than silent.
  assert.throws(() => noIds.keptRow('909', '1', 'Plant SYN'), /no columns for them/);
  ok('a kept pair is never written into a file with no columns to hold it');

  // The fallback file still round-trips, which is the whole point of falling
  // back to this shape rather than to blanks.
  reset();
  const fallbackFile = [
    noIds.columns.join(','),
    noIds.row('SYN-WIND-1', undefined, 'River SYN').join(','),
    noIds.row('SYN-GAS-3', undefined, 'River SYN').join(','),
  ].join('\n');
  assert.deepEqual(
    planGeneratorGroups(fallbackFile, EDITOR_MAPPING, undefined).members.get('River SYN'),
    ['SYN-WIND-1', 'SYN-GAS-3'],
  );
  ok('a file saved with no list loaded reloads under EDITOR_MAPPING, with no list loaded');
}

// ---------------------------------------- the editor's own file, both ways
//
// The same saved file must load keyed on name AND on the (bus, unit) pair,
// since the pair is what re-keys a grouping for another study.

{
  reset();
  // As `csvHeader` and `csvCells` in src/tables/generator/ui/groups.ts write
  // it, including a row for a pair no list claims: blank Name, both
  // identifiers, its group.
  const EDITOR_FILE = [
    `Name,${BUS_ID_COLUMN},${UNIT_ID_COLUMN},Grouping`,
    'SYN-WIND-1,101,1,River SYN',
    'SYN-GAS-3,202,01,River SYN',
    'SYN-NOT-HERE,,,River SYN',
    ',909,1,Plant SYN',
  ].join('\n');

  const index = generatorKeyIndex(LIST);
  const byName = planGeneratorGroups(EDITOR_FILE, EDITOR_MAPPING, index);
  assert.deepEqual(byName.members.get('River SYN'), ['SYN-WIND-1', 'SYN-GAS-3', 'SYN-NOT-HERE']);
  ok("the editor's own file reloads under EDITOR_MAPPING, extra columns and all");

  // The blank-Name row is REFUSED by row and counted, never swallowed: keyed
  // by name there is nothing in it to key on, and the count is what tells the
  // user to reload it on the pair instead.
  assert.equal(byName.members.has('Plant SYN'), false);
  assert.equal(
    byName.refusals.reduce((rows, entry) => rows + entry.rows, 0),
    1,
  );
  assert.match(byName.refusals[0].reason, /Name cell is blank/);
  ok('a pair-only row is counted as a refusal on a name-keyed reload, not dropped in silence');

  const pairMapping = {
    key: { by: 'bus-unit', busColumn: BUS_ID_COLUMN, unitColumn: UNIT_ID_COLUMN },
    groupColumn: 'Grouping',
  };
  const byPair = planGeneratorGroups(EDITOR_FILE, pairMapping, index);
  // The two rows the list claims come back to the same names the name key
  // gave -- which is the whole point of writing the pair.
  assert.deepEqual(byPair.members.get('River SYN'), ['SYN-WIND-1', 'SYN-GAS-3']);
  ok('the same file re-keyed on the pair resolves to the same names');

  // And the pair-only row rides along again, with the cells it was saved
  // with, so a save/load cycle neither loses it nor promotes it to membership.
  assert.deepEqual(
    byPair.kept.map((row) => [row.group, row.busId, row.unitId]),
    [['Plant SYN', '909', '1']],
  );
  ok('the pair-only row survives the round trip as a kept row, still unresolved');
}

// -- GeneratorGroups.csv, as the editor saves it, dropped back on the window
//
// Both shapes the editor writes, handed to the drop classifier: the
// four-column one (saved when a GeneratorList is loaded) must classify too.

{
  const { classify } = await import('../src/detect.ts');
  for (const withIds of [true, false]) {
    reset();
    const shape = editorCsvShape(withIds);
    const saved = [
      shape.columns.join(','),
      shape.row('SYN-WIND-1', { bus: '101', unit: '1' }, 'River SYN').join(','),
    ].join('\n');
    const verdict = classify(new TextEncoder().encode(saved), 'GeneratorGroups.csv');
    assert.equal(verdict.kind, 'groupings', verdict.reason);
    assert.ok(verdict.writtenBy.includes('generator'));
    assert.deepEqual(
      planGeneratorGroups(saved, EDITOR_MAPPING, generatorKeyIndex(LIST)).members.get('River SYN'),
      ['SYN-WIND-1'],
    );
  }
  assert.deepEqual(
    EDITOR_CSV_HEADERS,
    [editorCsvShape(false).columns, editorCsvShape(true).columns],
    'the classifier is told both shapes the editor writes',
  );
  ok("the generator editor's saved file, either shape, is a groupings drop that reloads");
}

console.log(`\n${checks} checks passed.`);
