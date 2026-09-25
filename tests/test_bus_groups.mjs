// tests/test_bus_groups.mjs — the bus group membership map and its
// persistence: what a membership file becomes, which rows cannot resolve and
// what is kept when they do not.
//
// What has to be right, in order of how badly it fails when it is not:
//
//   * **the stored key is the bus NUMBER.** A bus name may legitimately
//     repeat, so a name-keyed file is resolved through BusList and a name two
//     rows carry resolves to NEITHER. Storing the name would leave "which
//     WILLOWBEND" unanswerable by every later reader.
//   * **an ambiguous or unknown name is kept and flagged, never dropped.**
//   * **an id no list carries stays IN the map.** It is already the stored
//     form, and a grouping written for a bigger study is worth keeping.
//   * **refusals are counted under their own reasons**, for the reason
//     tests/test_generator_groups.mjs states about its own.
//   * **the bundle round-trip**, through the real manifest writer and reader.
//
// Run:  node test_bus_groups.mjs

import assert from 'node:assert/strict';
import './test_loader.mjs';

const {
  BUS_GROUP_BY,
  EDITOR_CSV_HEADERS,
  EDITOR_MAPPING,
  adoptBusGroups,
  busGroupNames,
  busKeyIndex,
  busesInGroup,
  chosenBusGroupMapping,
  clearBusGroups,
  exportBusGroups,
  hasBusGroups,
  loadBusGroups,
  planBusGroups,
  readSavedBusGroups,
  resolveBusMembershipKey,
  setBusMembership,
  summarizeBusGroups,
  unresolvedBusMembershipRows,
} = await import('../src/tables/bus/groups.ts');
const { buildLookup, parseLookupCsv } = await import('../src/lookups/parse.ts');

let checks = 0;
function ok(what) {
  checks++;
  console.log(`ok - ${what}`);
}

/** A BusList carrying one repeated name, because that is the case the id key
 * exists for. */
const LIST = buildLookup(
  parseLookupCsv(
    [
      'BUS_GENERAL,,,',
      'BusID,Name,LoadArea,PSSEZone',
      '4101,SPRUCEFORK,AREA_AV,Z1',
      '4102,SPRUCEFORK,AREA_AV,Z1',
      '4103,SYNFLATS,AREA_NV,Z2',
    ].join('\n'),
    'BusList.csv',
  ).rows,
);
const INDEX = busKeyIndex(LIST);

const ID_MAPPING = { key: { by: 'id', idColumn: 'BusID' }, groupColumn: 'Grouping' };
const NAME_MAPPING = { key: { by: 'name', nameColumn: 'Bus Name' }, groupColumn: 'Grouping' };

// ------------------------------------------------------------- the key

{
  clearBusGroups();
  assert.equal(hasBusGroups(), false);
  assert.equal(BUS_GROUP_BY, 'Bus Group');

  assert.deepEqual(resolveBusMembershipKey(INDEX, { by: 'id', id: ' 4101 ' }), {
    status: 'resolved',
    id: 4101,
  });
  // An id cell that is not an integer is REFUSED, never parsed to NaN: a NaN
  // key matches no bus, which would read as a bus the study lacks.
  assert.equal(resolveBusMembershipKey(INDEX, { by: 'id', id: 'four' }).status, 'refused');
  assert.equal(resolveBusMembershipKey(INDEX, { by: 'id', id: '' }).status, 'refused');
  // An id no list carries still resolves: the id IS the key, and whether this
  // study carries it is a separate question the summary answers.
  assert.deepEqual(resolveBusMembershipKey(INDEX, { by: 'id', id: '99999' }), {
    status: 'resolved',
    id: 99999,
  });
  ok('an id key resolves to itself, and a non-integer cell is refused rather than parsed');

  assert.deepEqual(resolveBusMembershipKey(INDEX, { by: 'name', name: ' synflats ' }), {
    status: 'resolved',
    id: 4103,
  });
  const ambiguous = resolveBusMembershipKey(INDEX, { by: 'name', name: 'SPRUCEFORK' });
  assert.equal(ambiguous.status, 'unresolved', 'a repeated name resolves to NEITHER bus');
  assert.match(ambiguous.reason, /4101, 4102/, 'and the reason names both');
  assert.equal(
    resolveBusMembershipKey(INDEX, { by: 'name', name: 'NOWHERE' }).status,
    'unresolved',
  );
  // With no list there is nothing to resolve a name against at all, and that
  // is a file-level refusal rather than a per-row one.
  assert.equal(resolveBusMembershipKey(undefined, { by: 'name', name: 'X' }).status, 'refused');
  ok('a name key is resolved through BusList, and an ambiguous one is kept rather than guessed');
}

// ------------------------------------------------------------- ingest

{
  clearBusGroups();
  const load = loadBusGroups(
    [
      'BusID,Grouping',
      '4101,North SYN',
      '4102,North SYN',
      '4103,South SYN',
      '4101,South SYN',
      '99999,North SYN',
      ',South SYN',
      'four,South SYN',
      '4101,',
    ].join('\n'),
    ID_MAPPING,
    INDEX,
  );

  assert.deepEqual(busGroupNames(), ['North SYN', 'South SYN']);
  assert.deepEqual(busesInGroup('North SYN'), [4101, 4102, 99999]);
  assert.deepEqual(busesInGroup('South SYN'), [4103, 4101]);
  assert.equal(load.memberships, 5, 'five (bus, group) pairs, not five buses');
  ok('an id-keyed file becomes membership, and a bus may sit in several groups');

  // Three different bad rows, each counted under its own reason. A row that
  // silently vanished is a group that silently shrank.
  const reasons = load.refusals.map((entry) => entry.reason).join(' ');
  assert.equal(
    load.refusals.reduce((sum, entry) => sum + entry.rows, 0),
    3,
  );
  assert.match(reasons, /blank bus number cell/);
  assert.match(reasons, /"four" is not a bus number/);
  assert.match(reasons, /blank group cell/);
  ok('refused rows are counted under their own reasons, never swallowed');

  const summary = summarizeBusGroups([...INDEX.ids]);
  assert.equal(summary.groups, 2);
  assert.equal(summary.mapped, 3, '4101, 4102, 4103');
  assert.deepEqual(summary.offList, [99999]);
  // No figure here is a bus count: 3 + 2 is five memberships over four ids.
  assert.equal(summary.mapped + summary.offList.length, 4);
  ok('the summary speaks in groups, distinct ids and off-list ids — never a summed membership');

  // Judged against NOTHING is not judged against an empty set: with no list
  // loaded, flagging every id would cry wolf on exactly the rows nothing is
  // known about.
  const unchecked = summarizeBusGroups(undefined);
  assert.deepEqual(unchecked.offList, []);
  assert.deepEqual(unchecked.unmapped, []);
  assert.equal(unchecked.groups, 2);
  ok('with no bus set to judge against, coverage is reported as unchecked rather than as zero');
}

{
  clearBusGroups();
  const load = loadBusGroups(
    ['Bus Name,Grouping', 'SYNFLATS,South SYN', 'SPRUCEFORK,North SYN', 'NOWHERE,North SYN'].join(
      '\n',
    ),
    NAME_MAPPING,
    INDEX,
  );
  // Only the unambiguous name became membership; the other two rows are kept
  // beside the map with their own reasons, in file order.
  assert.deepEqual(busGroupNames(), ['South SYN']);
  assert.deepEqual(busesInGroup('South SYN'), [4103]);
  assert.equal(load.unresolved, 2);
  const kept = unresolvedBusMembershipRows();
  assert.deepEqual(
    kept.map((row) => row.name),
    ['SPRUCEFORK', 'NOWHERE'],
  );
  assert.match(kept[0].reason, /names 2 buses/);
  assert.match(kept[1].reason, /carries no bus named/);
  ok('a name-keyed file keeps its ambiguous and unknown rows beside the map, with reasons');

  // A name-keyed file with no list refuses ONCE, as a file, rather than
  // repeating the same sentence per row.
  assert.throws(
    () => planBusGroups('Bus Name,Grouping\nSYNFLATS,South SYN', NAME_MAPPING, undefined),
    /needs BUS_GENERAL loaded/,
  );
  ok('a name-keyed file with no BusList refuses once, as a file');
}

{
  clearBusGroups();
  // A mapping naming a column the file lacks refuses the whole file: the
  // mapping is the user's one free choice and a wrong one is not a row-level
  // problem.
  assert.throws(
    () => planBusGroups('BusID,Grouping\n4101,North SYN', NAME_MAPPING, INDEX),
    /does not carry/,
  );
  assert.equal(hasBusGroups(), false, 'and nothing moved');

  // A file every row of which is refused produces no membership, and says why
  // rather than leaving an empty map behind.
  assert.throws(
    () => planBusGroups('BusID,Grouping\nfour,North SYN', ID_MAPPING, INDEX),
    /produced no group membership/,
  );
  assert.equal(hasBusGroups(), false);
  ok('a refused file leaves the loaded map exactly as it was');
}

// ------------------------------------------------------------- the editor

{
  clearBusGroups();
  setBusMembership(new Map([['Hand SYN', [4101, 4103]]]), [
    { group: 'Hand SYN', name: 'SPRUCEFORK', reason: 'names 2 buses' },
  ]);
  assert.deepEqual(busesInGroup('Hand SYN'), [4101, 4103]);
  // Hand-built groups still record a provenance, because a bundle has to be
  // able to explain where its membership came from.
  assert.deepEqual(chosenBusGroupMapping(), {
    key: { by: 'id', idColumn: 'BusID' },
    groupColumn: 'Grouping',
  });
  assert.equal(unresolvedBusMembershipRows().length, 1, 'the kept rows ride along');
  assert.throws(() => setBusMembership(new Map()), /leaves no groups/);
  assert.equal(busGroupNames().length, 1, 'and the refusal changed nothing');
  ok('the editor may replace the map, carries the kept rows along, and cannot empty it');
}

// ------------------------------------------------------------- the bundle

{
  clearBusGroups();
  loadBusGroups(
    ['BusID,Grouping', '4101,North SYN', '4102,North SYN', '4103,South SYN'].join('\n'),
    ID_MAPPING,
    INDEX,
  );
  const saved = exportBusGroups();
  assert.deepEqual(saved.mapping, ID_MAPPING);
  // Pair arrays, not an object: the order is the file's own and must not ride
  // JSON object key order.
  assert.ok(Array.isArray(saved.members));
  assert.deepEqual(saved.members[0], ['North SYN', [4101, 4102]]);

  const roundTripped = readSavedBusGroups(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(roundTripped, saved);

  clearBusGroups();
  assert.equal(exportBusGroups(), null, 'a session with no map writes no field');
  adoptBusGroups(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(busGroupNames(), ['North SYN', 'South SYN']);
  assert.deepEqual(busesInGroup('North SYN'), [4101, 4102]);
  ok('the map round-trips through the manifest shape, ids and order intact');

  // Read strictly: a half-read membership is a group that silently shrank.
  assert.throws(() => readSavedBusGroups(null), /not an object/);
  assert.throws(
    () => readSavedBusGroups({ ...saved, mapping: { key: { by: 'unit-id' } } }),
    /"unit-id"/,
  );
  assert.throws(() => readSavedBusGroups({ ...saved, members: 'North SYN' }), /not a list/);
  assert.throws(
    () => readSavedBusGroups({ ...saved, members: [['North SYN', ['4101']]] }),
    /not a bus number/,
    'a member saved as TEXT is refused: the key type is the whole of this map',
  );
  assert.throws(() => readSavedBusGroups({ ...saved, unresolved: [{ group: 'x' }] }), /not text/);
  ok('a malformed saved map is refused whole rather than read half-way');
}

{
  // The manifest field is OPTIONAL, through the real writer and reader: a
  // bundle written before bus groups existed loads exactly as it did.
  const { buildManifest } = await import('../src/storage/envelope.ts');
  clearBusGroups();
  const { manifest: without } = buildManifest([], {});
  assert.equal(without.busGroups, undefined);

  loadBusGroups('BusID,Grouping\n4101,North SYN', ID_MAPPING, INDEX);
  const { manifest: with_ } = buildManifest([], { busGroups: exportBusGroups() });
  assert.deepEqual(with_.busGroups.members, [['North SYN', [4101]]]);
  assert.equal(with_.version, without.version, 'and the version integer does not move');
  ok('the bundle carries the map only when there is one, at the same manifest version');
  clearBusGroups();
}

// -------- BusGroups.csv, as the editor saves it, dropped back on the window
//
// Saved through the editor's own model and header, then handed to the drop
// classifier and the plan a drop runs: the classifier must recognise the
// editor's own header, or the file comes back unrecognized.

{
  const { MembershipModel } = await import('../src/ui/membership-model.ts');
  const { classify } = await import('../src/detect.ts');
  const model = new MembershipModel(new Map([['SAMPLE_NORTH', ['90001', '90002']]]));
  // BusGroups.csv's header, as the file carries it.
  const saved = model.toCsv('BusID,Grouping');
  const verdict = classify(new TextEncoder().encode(saved), 'BusGroups.csv');
  assert.equal(verdict.kind, 'groupings', verdict.reason);
  assert.deepEqual(EDITOR_CSV_HEADERS, [['BusID', 'Grouping']], 'and it is what the editor writes');
  assert.deepEqual(verdict.writtenBy, ['bus'], 'only the bus editor writes this header');
  assert.deepEqual(
    planBusGroups(saved, EDITOR_MAPPING, undefined).members.get('SAMPLE_NORTH'),
    [90001, 90002],
  );
  ok("the bus editor's saved file is a groupings drop, and reloads to the same map");
}

console.log(`\n${checks} checks passed.`);
