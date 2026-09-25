// tests/test_storage.mjs — the v3 envelope end to end IN MEMORY:
// `buildManifest`, bytes laid out as the writers do, `casesFromManifest`.
//
//   * Cubes and PRESENCE bitmaps round-trip byte for byte (a lost presence
//     bit turns absent data into a plausible number).
//   * The top-level `groupings` mapping survives.
//   * An unknown table kind is skipped with a warning, its cube bytes still
//     consumed so later tables stay aligned.

import assert from 'node:assert/strict';

import './test_loader.mjs';
import { AREAS } from './test_fixtures.mjs';

const { restoreBundle, readBundleFile } = await import('../src/storage/store.ts');
const { buildManifest, casesFromManifest, BUNDLE_VERSION } =
  await import('../src/storage/envelope.ts');
const { migrateManifest } = await import('../src/storage/legacy.ts');
const { CaseStore, caseLabel, rowsOfKind, slotKey } = await import('../src/model/case-model.ts');
const { restorePins, rowIdOf } = await import('../src/ui/browse-model.ts');
const { resolveDraws } = await import('../src/app/draw.ts');
const { createSeriesPool } = await import('../src/series/pool.ts');
const { buildInterfaceTab } = await import('../src/tables/interface/ui/browse.ts');
const { buildAreaTab } = await import('../src/tables/area/ui/browse.ts');
const { allAreas, setAxis, setGroupings } = await import('../src/tables/area/groupings.ts');
const { readSessionReference } = await import('../src/session/reference.ts');
const { createLimitsStore } = await import('../src/limits/store.ts');
const { restoreCaseLimits, serializeLimits } = await import('../src/limits/envelope.ts');
const { createInventory, LIMITS_COLUMN, SHARED_LIMITS_INPUT, NOT_RECORDED } =
  await import('../src/inventory/store.ts');
const { buildLookup, parseLookupCsv } = await import('../src/lookups/parse.ts');

const HOURS = 8760;

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`ok - ${label}`);
}

/** For the async `readBundleFile` checks, awaited in order. */
async function checkAsync(label, fn) {
  await fn();
  passed++;
  console.log(`ok - ${label}`);
}

// ------------------------------------------------------------- fixtures

/** Raw bytes of a typed array, for byte-for-byte comparison. Float32Array
 * cannot be compared value-wise: an absent plane is NaN-filled, and
 * `NaN !== NaN`, so a value comparison would either throw or pass vacuously. */
function bytesOf(view) {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

/** A synthetic Area table: 3 areas x 2 metrics x 8760 h, with the second
 * metric of the last area ABSENT -- NaN in the cube, 0 in the bitmap. That is
 * the plane whose presence byte must come back as 0. */
function areaTable(areas = ['AREA01', 'AREA02', 'AREA03']) {
  const metrics = ['Load (MWh)', 'Gen (MWh)'];
  const planes = areas.length * metrics.length;
  const cube = new Float32Array(planes * HOURS);
  const presence = new Uint8Array(planes);
  for (let plane = 0; plane < planes; plane++) {
    const absent = plane === planes - 1;
    presence[plane] = absent ? 0 : 1;
    for (let hour = 0; hour < HOURS; hour++) {
      cube[plane * HOURS + hour] = absent ? NaN : plane * 1000 + (hour % 97) * 0.5;
    }
  }
  const tou = new Uint8Array(HOURS);
  for (let hour = 0; hour < HOURS; hour++) tou[hour] = hour % 3;
  // A HALF year, as a date-split export gives: the first 4,344 hours only.
  const hoursPresent = new Uint8Array(HOURS);
  hoursPresent.fill(1, 0, 4344);
  return {
    cube,
    areas: areas.slice(),
    metrics,
    presence,
    tou,
    hoursPresent,
    sourceColumns: [...metrics, 'Emissions (ton)'],
    year: 2032,
  };
}

/** A synthetic Interface table: 2 interfaces x 8760 h, the second absent. */
function interfaceTable(quantity, unit) {
  const interfaces = ['PATH_A', 'PATH_B'];
  const cube = new Float32Array(interfaces.length * HOURS);
  const presence = new Uint8Array(interfaces.length);
  for (let iface = 0; iface < interfaces.length; iface++) {
    const absent = iface === 1;
    presence[iface] = absent ? 0 : 1;
    for (let hour = 0; hour < HOURS; hour++) {
      cube[iface * HOURS + hour] = absent ? NaN : -1 * (hour % 41);
    }
  }
  const tou = new Uint8Array(HOURS);
  for (let hour = 0; hour < HOURS; hour++) tou[hour] = hour % 2;
  const hoursPresent = new Uint8Array(HOURS).fill(1);
  return {
    cube,
    interfaces: interfaces.slice(),
    presence,
    tou,
    hoursPresent,
    sourceColumns: [...interfaces, 'PATH_C'],
    year: 2032,
    quantity,
    unit,
  };
}

const AREA_SLOT = { kind: 'area' };
const FLOW_SLOT = { kind: 'interface', variant: 'Power Flow (MW)' };
const COST_SLOT = { kind: 'interface', variant: 'Congestion Cost ($)' };

/** One Case holding an Area table and TWO Interface tables of different
 * quantities -- the shape the v3 envelope exists to carry. */
function studyCase(id = 'case-1', name = 'Base Case') {
  const tables = new Map();
  for (const [key, data] of [
    [AREA_SLOT, areaTable()],
    [FLOW_SLOT, interfaceTable('Power Flow (MW)', 'MW')],
    [COST_SLOT, interfaceTable('Congestion Cost ($)', '$')],
  ]) {
    tables.set(slotKey(key), { key, data });
  }
  return { id, name, tables };
}

const GROUPINGS_CSV = 'Name,Grouping\nAREA01,Zone 1\nAREA02,Zone 1\nAREA03,Zone 2\n';

/** The disk layout as the writers produce it: cube chunks in manifest order,
 * re-sliced into one ArrayBuffer per case by `cases[].cubeBytes` (all the
 * OPFS worker can slice by). */
function toCaseBlocks(manifest, cubes) {
  const all = Buffer.concat(
    cubes.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
  );
  let offset = 0;
  return manifest.cases.map((entry) => {
    const block = all.subarray(offset, offset + entry.cubeBytes);
    offset += entry.cubeBytes;
    // Copied into a standalone ArrayBuffer, as a real read would produce.
    return block.buffer.slice(block.byteOffset, block.byteOffset + block.byteLength);
  });
}

/** Full save -> JSON -> load round trip. The JSON.parse/stringify is not
 * decoration: it is what proves every manifest field is JSON-safe, which is
 * where a raw Uint8Array bitmap would silently become `{"0":1,"1":0,...}`. */
function roundTrip(
  cases,
  groupings,
  lookups = new Map(),
  selections = [],
  layout = ['time', 'duration', 'box', 'stacked'],
  drawerHeight = null,
) {
  const { manifest, cubes } = buildManifest(cases, {
    groupings,
    lookups,
    selections,
    layout,
    drawerHeight,
  });
  const wire = JSON.parse(JSON.stringify(manifest));
  const blocks = toCaseBlocks(wire, cubes);
  return {
    manifest,
    wire,
    restored: casesFromManifest(wire, blocks),
    bundle: restoreBundle(wire, blocks),
  };
}

// ------------------------------------------------- the multi-table envelope

check('v3 manifest holds every table of every Case, keyed by slot', () => {
  const { manifest } = buildManifest([studyCase()], { groupings: GROUPINGS_CSV });
  assert.equal(manifest.version, 3);
  assert.equal(BUNDLE_VERSION, 3);
  assert.equal(manifest.cases.length, 1);

  const entry = manifest.cases[0];
  assert.equal(entry.id, 'case-1');
  assert.equal(entry.name, 'Base Case');
  assert.deepEqual(Object.keys(entry.tables).sort(), [
    'area ',
    'interface Congestion Cost ($)',
    'interface Power Flow (MW)',
  ]);
  assert.equal(entry.tables['area '].kind, 'area');
  assert.equal(entry.tables['area '].variant, undefined);
  assert.equal(entry.tables['interface Power Flow (MW)'].variant, 'Power Flow (MW)');

  // The cube never enters the JSON, and the per-case byte count is the sum of
  // its tables' -- the OPFS reader slices the blob by that field.
  const tables = Object.values(entry.tables);
  assert.ok(tables.every((table) => !('cube' in table)));
  assert.equal(
    entry.cubeBytes,
    tables.reduce((sum, table) => sum + table.cubeBytes, 0),
  );
  assert.equal(entry.tables['area '].cubeBytes, 3 * 2 * HOURS * 4);
});

check('a Case with an Area and an Interface table round-trips both, cube bytes intact', () => {
  const original = studyCase();
  const { restored } = roundTrip([original], GROUPINGS_CSV);

  assert.deepEqual(restored.warnings, []);
  assert.equal(restored.cases.length, 1);
  const back = restored.cases[0];
  assert.equal(back.id, 'case-1');
  assert.equal(back.name, 'Base Case');
  assert.equal(back.tables.size, 3);

  for (const [slot, entry] of original.tables) {
    const table = back.tables.get(slot);
    assert.ok(table, `slot "${slot}" survived the round trip`);
    assert.deepEqual(table.key, entry.key);
    // Byte-for-byte, NaN planes included: a cube compared value-wise would
    // pass vacuously wherever data is absent.
    assert.ok(
      bytesOf(table.data.cube).equals(bytesOf(entry.data.cube)),
      `slot "${slot}" cube bytes are identical`,
    );
    assert.equal(table.data.cube.length, entry.data.cube.length);
  }

  // Kind-specific fields, carried opaquely by storage.ts through each kind's
  // own serialize/deserialize.
  const area = back.tables.get(slotKey(AREA_SLOT)).data;
  assert.deepEqual(area.areas, original.tables.get(slotKey(AREA_SLOT)).data.areas);
  assert.deepEqual(area.metrics, ['Load (MWh)', 'Gen (MWh)']);
  assert.deepEqual(area.sourceColumns, ['Load (MWh)', 'Gen (MWh)', 'Emissions (ton)']);
  assert.equal(area.year, 2032);

  const flow = back.tables.get(slotKey(FLOW_SLOT)).data;
  assert.deepEqual(flow.interfaces, ['PATH_A', 'PATH_B']);
  assert.equal(flow.quantity, 'Power Flow (MW)');
  assert.equal(flow.unit, 'MW');
  // two Interface tables in ONE Case, told apart by the slot variant.
  assert.equal(back.tables.get(slotKey(COST_SLOT)).data.quantity, 'Congestion Cost ($)');
});

check(
  'the per-hour coverage record round-trips, and a legacy bundle comes back UNKNOWN not empty',
  () => {
    const original = studyCase();
    const { restored } = roundTrip([original], GROUPINGS_CSV);
    const back = restored.cases[0];

    for (const [slot, entry] of original.tables) {
      const table = back.tables.get(slot);
      assert.ok(
        table.data.hoursPresent instanceof Uint8Array,
        `slot "${slot}" hoursPresent is bytes`,
      );
      assert.ok(
        bytesOf(table.data.hoursPresent).equals(bytesOf(entry.data.hoursPresent)),
        `slot "${slot}" coverage record is byte-for-byte identical`,
      );
    }
    // The half-year Area table is still a half year after a save/load. A record
    // that came back full would let a later append bring hours the table already
    // holds -- and would report a half year as a whole one.
    const area = back.tables.get(slotKey(AREA_SLOT)).data;
    assert.equal(
      area.hoursPresent.reduce((n, h) => n + h, 0),
      4344,
    );

    // A bundle written before the record existed carries no `hoursPresent`.
    // That is UNKNOWN coverage -- undefined -- and must never decode as an
    // all-zero year, which reads as a table covering no hours at all.
    const legacy = studyCase();
    for (const entry of legacy.tables.values()) delete entry.data.hoursPresent;
    const { restored: old } = roundTrip([legacy], GROUPINGS_CSV);
    for (const entry of old.cases[0].tables.values()) {
      assert.equal(entry.data.hoursPresent, undefined, 'no record means unknown, not zero hours');
    }
  },
);

check('presence and TOU bitmaps round-trip byte-for-byte, absent planes still absent', () => {
  const original = studyCase();
  const { restored } = roundTrip([original], GROUPINGS_CSV);
  const back = restored.cases[0];

  for (const [slot, entry] of original.tables) {
    const table = back.tables.get(slot);
    assert.ok(
      bytesOf(table.data.presence).equals(bytesOf(entry.data.presence)),
      `slot "${slot}" presence bitmap is byte-for-byte identical`,
    );
    assert.ok(bytesOf(table.data.tou).equals(bytesOf(entry.data.tou)), `slot "${slot}" TOU bitmap`);
    assert.ok(table.data.presence instanceof Uint8Array);
  }

  // The specific planes that matter: the absent ones must still read 0, and
  // the present ones 1. A bitmap that came back all-1s would make every
  // kernel read a NaN plane as real data.
  const area = back.tables.get(slotKey(AREA_SLOT)).data;
  assert.equal(area.presence.length, area.areas.length * area.metrics.length);
  assert.equal(area.presence[area.presence.length - 1], 0, 'the absent (area, metric) plane');
  assert.equal(area.presence[0], 1);
  assert.ok(Number.isNaN(area.cube[(area.presence.length - 1) * HOURS]), 'absent plane is NaN');

  const flow = back.tables.get(slotKey(FLOW_SLOT)).data;
  assert.deepEqual([...flow.presence], [1, 0]);
  assert.ok(Number.isNaN(flow.cube[HOURS]), 'the absent interface plane is NaN');
});

// -------------------------------------------------------------- groupings

check('a non-empty top-level groupings string round-trips unchanged', () => {
  const { manifest, wire, bundle } = roundTrip([studyCase()], GROUPINGS_CSV);
  // Top-level, not per-table and not per-kind: the mapping is global to the
  // area axis, and no table entry carries a copy of it. Losing it means a
  // restored study is plotted against whatever mapping happens to be loaded.
  assert.equal(manifest.groupings, GROUPINGS_CSV);
  assert.equal(wire.groupings, GROUPINGS_CSV);
  for (const table of Object.values(wire.cases[0].tables)) {
    assert.ok(!('groupings' in table));
  }
  assert.equal(bundle.groupings, GROUPINGS_CSV, 'restored through the shared load path');
  assert.deepEqual(bundle.warnings, []);
  // `restoredCases` is the whole of what a restore hands back -- one Case,
  // all three of its tables. No Area-only view exists beside it.
  assert.equal(bundle.restoredCases.length, 1);
  assert.equal(bundle.restoredCases[0].name, 'Base Case');
  assert.equal(bundle.restoredCases[0].tables.size, 3);
  assert.equal(bundle.cases, undefined, 'the lossy single-table view is gone, not hidden');
});

check('an absent groupings mapping restores as null, not as an empty string', () => {
  const { manifest, wire, bundle } = roundTrip([studyCase()], null);
  assert.equal('groupings' in manifest, false);
  assert.equal(bundle.groupings, null);
  assert.equal(wire.groupings ?? null, null);
});

check('the mapping currently loaded reaches the bundle, stated rather than defaulted', () => {
  // `buildManifest` reads no session store: the caller says what goes in the
  // bundle, and `readSessionReference()` is how it says "whatever is loaded".
  const { manifest } = buildManifest([studyCase()], readSessionReference(createLimitsStore()));
  assert.equal(typeof manifest.groupings, 'string');
  assert.ok(manifest.groupings.startsWith('Name,Grouping'));

  // And the other direction, which is the half that was untestable: an
  // explicit empty session writes no mapping, whatever is loaded.
  assert.equal('groupings' in buildManifest([studyCase()], {}).manifest, false);
});

// ------------------------------------------------- unknown table kinds

check('an unknown table kind is skipped with a warning and the rest still loads', () => {
  const original = studyCase();
  const { manifest, cubes } = buildManifest([original], { groupings: GROUPINGS_CSV });
  const wire = JSON.parse(JSON.stringify(manifest));

  // An unknown kind ('zone') BETWEEN two known tables, so skipping must
  // consume its cube bytes.
  const busBytes = 64;
  const rebuilt = {};
  for (const [slot, table] of Object.entries(wire.cases[0].tables)) {
    rebuilt[slot] = table;
    if (slot === 'area ') {
      rebuilt['zone '] = { kind: 'zone', cubeBytes: busBytes, zones: ['Z1'], year: 2032 };
    }
  }
  wire.cases[0].tables = rebuilt;
  wire.cases[0].cubeBytes += busBytes;

  const blocks = (() => {
    const chunks = cubes.map((chunk) =>
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
    );
    // The unknown table's bytes sit right after the Area cube, matching its
    // position in the manifest.
    chunks.splice(1, 0, Buffer.alloc(busBytes, 0x5a));
    const all = Buffer.concat(chunks);
    return [all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength)];
  })();

  const restored = casesFromManifest(wire, blocks);
  assert.equal(restored.warnings.length, 1);
  assert.match(restored.warnings[0], /zone/);
  assert.match(restored.warnings[0], /Base Case/);

  const back = restored.cases[0];
  assert.equal(back.tables.size, 3, 'the three known tables still loaded');
  assert.equal(back.tables.has('bus '), false, 'the unknown kind was dropped, not guessed at');
  // The proof the skipped bytes were consumed: the tables that follow it in
  // the manifest still hold their own cubes.
  for (const [slot, entry] of original.tables) {
    assert.ok(
      bytesOf(back.tables.get(slot).data.cube).equals(bytesOf(entry.data.cube)),
      `slot "${slot}" is still aligned after the skipped table`,
    );
  }
});

// ------------------------------------------------------------- refusals

check('a version newer than this build is refused by name, never parsed', () => {
  const { manifest, cubes } = buildManifest([studyCase()], { groupings: GROUPINGS_CSV });
  const wire = JSON.parse(JSON.stringify(manifest));
  const blocks = toCaseBlocks(wire, cubes);
  wire.version = 4;
  assert.throws(() => casesFromManifest(wire, blocks), /version 4.*version 3|upgrade/i);
});

check('an older (legacy) version is refused here — migration happens earlier, not a guess', () => {
  const { manifest, cubes } = buildManifest([studyCase()], { groupings: GROUPINGS_CSV });
  const wire = JSON.parse(JSON.stringify(manifest));
  const blocks = toCaseBlocks(wire, cubes);
  wire.version = 1;
  assert.throws(() => casesFromManifest(wire, blocks), /version 1/);
});

check('a case whose tables do not add up to its cubeBytes is refused', () => {
  const { manifest, cubes } = buildManifest([studyCase()], { groupings: GROUPINGS_CSV });
  const wire = JSON.parse(JSON.stringify(manifest));
  const blocks = toCaseBlocks(wire, cubes);
  wire.cases[0].tables['area '].cubeBytes -= 4;
  assert.throws(() => casesFromManifest(wire, blocks), /cube bytes|expected/i);
});

check('a truncated cube is refused rather than restored at the wrong shape', () => {
  const original = {
    ...studyCase(),
    tables: new Map([[slotKey(AREA_SLOT), { key: AREA_SLOT, data: areaTable() }]]),
  };
  const { manifest, cubes } = buildManifest([original], {});
  const wire = JSON.parse(JSON.stringify(manifest));
  // Claim one metric fewer than the cube actually holds: the size check is
  // what stops a plausible, silently mis-indexed restore.
  wire.cases[0].tables['area '].metrics = ['Load (MWh)'];
  assert.throws(() => casesFromManifest(wire, toCaseBlocks(wire, cubes)), /expected/);
});

// ------------------------------------------------ the empty-area-list entry

check('an Area entry with an EMPTY area list restores onto the global axis', () => {
  // A legacy entry with no areas falls back to the loaded axis, resolved
  // before the cube is measured.
  const table = areaTable(allAreas());
  const one = {
    id: 'legacy',
    name: 'Legacy Case',
    tables: new Map([[slotKey(AREA_SLOT), { key: AREA_SLOT, data: table }]]),
  };
  const { manifest, cubes } = buildManifest([one], {});
  const wire = JSON.parse(JSON.stringify(manifest));
  wire.cases[0].tables['area '].areas = [];

  const restored = casesFromManifest(wire, toCaseBlocks(wire, cubes));
  const back = restored.cases[0].tables.get(slotKey(AREA_SLOT)).data;
  assert.deepEqual(back.areas, AREAS);
  assert.equal(back.cube.length, AREAS.length * 2 * HOURS);
  assert.ok(bytesOf(back.presence).equals(bytesOf(table.presence)));
});

// ------------------------------------------------- legacy migration
//
// GVAP (v1) and GVIP (v2) fixtures in the legacy apps' exact manifest shape:
// one flat entry per case, no `tables` map, bitmaps as bare base64.
// `migrateManifest` is driven directly (it keys on version alone); the magic
// refusals go through `readBundleFile` over real bytes.

/** A legacy `GVAP` case entry, matching `LegacyAreaManifestCase` in
 * src/storage/legacy.ts exactly. `overrides` lets one field (e.g. `areas`) diverge
 * from the table it was built from, for the empty-areas fixture. */
function legacyAreaCase(name, table, overrides = {}) {
  return {
    name,
    year: table.year,
    metrics: table.metrics,
    sourceColumns: table.sourceColumns,
    areas: table.areas,
    presence: Buffer.from(table.presence).toString('base64'),
    tou: Buffer.from(table.tou).toString('base64'),
    cubeBytes: table.cube.byteLength,
    ...overrides,
  };
}

/** A legacy `GVIP` case entry, matching `LegacyInterfaceManifestCase` in
 * src/storage/legacy.ts exactly. */
function legacyInterfaceCase(name, table) {
  return {
    name,
    year: table.year,
    interfaces: table.interfaces,
    sourceColumns: table.sourceColumns,
    quantity: table.quantity,
    unit: table.unit,
    presence: Buffer.from(table.presence).toString('base64'),
    tou: Buffer.from(table.tou).toString('base64'),
    cubeBytes: table.cube.byteLength,
  };
}

/** One case's cube as a standalone ArrayBuffer, the shape `casesFromManifest`
 * takes -- a legacy case holds exactly one table, so its whole cube block
 * IS that table's cube. */
function cubeBuffer(view) {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

/** `migrateManifest`'s user-facing note, reproduced (not exported) and
 * asserted verbatim. */
function migratedNote(version, what) {
  return (
    `Migrated a version-${version} (${what}) bundle to version ${BUNDLE_VERSION} as it loaded. ` +
    `The original was left untouched — save again to keep this study in the current format.`
  );
}

/** `[magic][uint32 LE manifest length][manifest JSON][cube bytes]`, with any
 * magic, for the refusal checks. */
function bundleFileBytes(magic, manifestObj, cubeChunks = []) {
  const manifestJson = Buffer.from(JSON.stringify(manifestObj));
  const header = Buffer.alloc(magic.length + 4);
  header.write(magic, 0, 'ascii');
  header.writeUInt32LE(manifestJson.byteLength, magic.length);
  return Buffer.concat([header, manifestJson, ...cubeChunks]);
}

check('a legacy GVAP manifest with a populated areas array migrates to v3 and restores', () => {
  const table = areaTable();
  const raw = { version: 1, cases: [legacyAreaCase('Legacy Base Case', table)] };

  const migrated = migrateManifest(raw, [cubeBuffer(table.cube)]);
  assert.deepEqual(
    migrated.warnings,
    [migratedNote(1, 'Area-only')],
    'the user-facing migration notice',
  );
  assert.equal(migrated.manifest.version, 3);
  assert.equal('groupings' in migrated.manifest, false, 'no groupings field on this fixture');
  assert.equal(migrated.manifest.cases.length, 1);

  const entry = migrated.manifest.cases[0];
  assert.equal(entry.name, 'Legacy Base Case');
  assert.equal(entry.cubeBytes, table.cube.byteLength, "case cubeBytes is its one table's");
  assert.deepEqual(Object.keys(entry.tables), [slotKey(AREA_SLOT)]);
  const manifestTable = entry.tables[slotKey(AREA_SLOT)];
  assert.equal(manifestTable.kind, 'area');
  assert.equal(manifestTable.variant, undefined);
  assert.equal(manifestTable.cubeBytes, table.cube.byteLength);
  assert.deepEqual(manifestTable.areas, table.areas);

  const restored = casesFromManifest(migrated.manifest, migrated.cubes);
  assert.deepEqual(restored.warnings, []);
  assert.equal(restored.cases.length, 1);
  const back = restored.cases[0].tables.get(slotKey(AREA_SLOT)).data;
  assert.deepEqual(back.areas, table.areas);
  assert.deepEqual(back.metrics, table.metrics);
  assert.ok(bytesOf(back.cube).equals(bytesOf(table.cube)), 'cube bytes intact through migration');
  assert.ok(bytesOf(back.presence).equals(bytesOf(table.presence)), 'presence bitmap intact');
  assert.ok(bytesOf(back.tou).equals(bytesOf(table.tou)), 'TOU bitmap intact');
});

check(
  'a legacy GVAP manifest with an EMPTY areas array migrates and restores onto allAreas() ' +
    '(the fallback a populated-areas fixture alone cannot prove)',
  () => {
    // The table's cube/presence are sized for the FULL axis -- only the
    // legacy JSON's `areas` list is empty, exactly the v1 shape whose
    // `entry.areas.length === 0` triggers deserializeAreaTable's fallback.
    const table = areaTable(allAreas());
    const raw = {
      version: 1,
      cases: [legacyAreaCase('Legacy Empty-Areas Case', table, { areas: [] })],
    };

    const migrated = migrateManifest(raw, [cubeBuffer(table.cube)]);
    assert.deepEqual(migrated.warnings, [migratedNote(1, 'Area-only')]);
    assert.deepEqual(migrated.manifest.cases[0].tables[slotKey(AREA_SLOT)].areas, []);

    const restored = casesFromManifest(migrated.manifest, migrated.cubes);
    assert.deepEqual(restored.warnings, []);
    const back = restored.cases[0].tables.get(slotKey(AREA_SLOT)).data;
    assert.deepEqual(back.areas, AREAS, 'fell back to the global axis, not an empty one');
    assert.equal(back.cube.length, AREAS.length * table.metrics.length * HOURS);
    assert.ok(
      bytesOf(back.presence).equals(bytesOf(table.presence)),
      'presence bitmap still intact',
    );
  },
);

check(
  'a legacy GVIP manifest migrates: name becomes the Case name, quantity becomes the slot variant',
  () => {
    const table = interfaceTable('Power Flow (MW)', 'MW');
    const raw = { version: 2, cases: [legacyInterfaceCase('Legacy Interface Case', table)] };

    const migrated = migrateManifest(raw, [cubeBuffer(table.cube)]);
    assert.deepEqual(migrated.warnings, [migratedNote(2, 'Interface-only')]);
    assert.equal(migrated.manifest.version, 3);
    assert.equal('groupings' in migrated.manifest, false, 'GVIP never carried a groupings mapping');
    const entry = migrated.manifest.cases[0];
    assert.equal(entry.name, 'Legacy Interface Case');
    const slot = slotKey(FLOW_SLOT);
    assert.deepEqual(Object.keys(entry.tables), [slot]);
    assert.equal(entry.tables[slot].kind, 'interface');
    assert.equal(entry.tables[slot].variant, 'Power Flow (MW)');

    // Through `restoreBundle`, what the app consumes: a correct migration is
    // worthless if the restore then drops the table.
    const bundle = restoreBundle(migrated.manifest, migrated.cubes, migrated.warnings);
    assert.deepEqual(
      bundle.warnings,
      [migratedNote(2, 'Interface-only')],
      'the migration notice reaches the caller alongside the restored study',
    );
    assert.equal(bundle.restoredCases.length, 1, 'an Interface-only bundle restores its Case');
    const restoredCase = bundle.restoredCases[0];
    assert.equal(restoredCase.name, 'Legacy Interface Case');
    assert.deepEqual([...restoredCase.tables.keys()], [slot], 'and its one Interface slot');

    const back = restoredCase.tables.get(slot).data;
    assert.equal(back.quantity, 'Power Flow (MW)');
    assert.equal(back.unit, 'MW');
    assert.deepEqual(back.interfaces, table.interfaces);
    assert.ok(bytesOf(back.cube).equals(bytesOf(table.cube)));
    assert.ok(bytesOf(back.presence).equals(bytesOf(table.presence)), 'presence bitmap intact');
    assert.ok(bytesOf(back.tou).equals(bytesOf(table.tou)), 'TOU array intact');
  },
);

check(
  "a legacy GVAP manifest's groupings string survives migration into the v3 top-level field",
  () => {
    const table = areaTable();
    const raw = {
      version: 1,
      groupings: GROUPINGS_CSV,
      cases: [legacyAreaCase('Case With Groupings', table)],
    };

    const migrated = migrateManifest(raw, [cubeBuffer(table.cube)]);
    assert.equal(migrated.manifest.groupings, GROUPINGS_CSV);

    const bundle = restoreBundle(migrated.manifest, migrated.cubes, migrated.warnings);
    assert.equal(
      bundle.groupings,
      GROUPINGS_CSV,
      'restored through the shared load path, not just the manifest',
    );
    assert.equal(bundle.restoredCases.length, 1);
    assert.equal(
      bundle.restoredCases[0].tables.get(slotKey(AREA_SLOT)).key.kind,
      'area',
      'and the migrated Area table with it',
    );
    assert.deepEqual(
      bundle.warnings,
      [migratedNote(1, 'Area-only')],
      'the migration notice reaches the caller alongside the restored study',
    );
  },
);

await checkAsync(
  'a manifest whose declared version disagrees with its magic is refused, not guessed at',
  async () => {
    // GVAP is always v1; a 4 is an unknown shape (`assertMagicVersion`, file
    // path only).
    const table = areaTable();
    const raw = { version: 4, cases: [legacyAreaCase('Future Case', table)] };
    const file = new File([bundleFileBytes('GVAP', raw)], 'future-case.gvmb');
    await assert.rejects(
      () => readBundleFile(file),
      /claims magic "GVAP" with version 4.*reads GVAP as version 1/s,
    );
  },
);

await checkAsync('an unknown magic is refused, never guessed at', async () => {
  const file = new File([bundleFileBytes('GVXX', { version: 1, cases: [] })], 'unknown-magic.gvmb');
  await assert.rejects(() => readBundleFile(file), /unknown-magic\.gvmb is not a GridView bundle/);
});

check('four-slot chart layout round-trips intact with bundle', () => {
  const original = studyCase();
  const customLayout = ['duration', 'time', 'stacked', 'box'];
  const { bundle, wire } = roundTrip([original], GROUPINGS_CSV, new Map(), [], customLayout);
  assert.deepEqual(wire.layout, customLayout);
  assert.deepEqual(bundle.layout, customLayout);
});

check('the drawer’s dragged height round-trips, and a detent bundle carries none', () => {
  const original = studyCase();
  const dragged = roundTrip([original], GROUPINGS_CSV, new Map(), [], undefined, 611);
  assert.equal(dragged.wire.drawerHeight, 611);
  assert.equal(dragged.bundle.drawerHeight, 611);
  // A height that resets on reload is worse than the detents it replaces, so
  // the field must be ABSENT when the drawer sat on a detent -- a null written
  // as JSON would come back as null and read as a height of zero.
  const onDetent = roundTrip([original], GROUPINGS_CSV);
  assert.ok(!('drawerHeight' in onDetent.wire), 'the manifest omits the field entirely');
  assert.equal(onDetent.bundle.drawerHeight, undefined);
});

// ------------------------------------------------------- interface limits

check(
  'the interface limits ride the envelope beside the groupings, and cost no version bump',
  () => {
    const limit = (source, value) => ({
      source,
      byInterface: new Map([['PATH_A', { max: new Float32Array(12).fill(value) }]]),
    });
    const { manifest, cubes } = buildManifest([studyCase()], {
      limits: {
        shared: limit('shared.csv', 100),
        cases: new Map([['case-1', limit('mine.csv', 250)]]),
      },
    });
    assert.equal(manifest.version, 3, 'an optional field is not a new envelope version');
    const wire = JSON.parse(JSON.stringify(manifest));
    const bundle = restoreBundle(wire, toCaseBlocks(wire, cubes));
    assert.equal(bundle.limits.shared.source, 'shared.csv');
    assert.equal(bundle.limits.shared.byInterface.get('PATH_A').max[0], 100);
    // Keyed by the Case's index in the bundle, which main.ts resolves against
    // the Cases the restore made -- see the checks at the end of this file.
    assert.equal(bundle.limits.byIndex.get(0).source, 'mine.csv');
  },
);

check('a bundle written before limits existed loads with none, and is not an error', () => {
  const { manifest, cubes } = buildManifest([studyCase()], {});
  assert.ok(!('limits' in manifest), 'a session with no limits writes no field');
  const wire = JSON.parse(JSON.stringify(manifest));
  const bundle = restoreBundle(wire, toCaseBlocks(wire, cubes));
  assert.equal(bundle.limits.shared, undefined);
  assert.equal(bundle.limits.byIndex.size, 0);
});

// ---------------------------------------------- pins against the bundle
//
// Last, because the group pin sets the session's groupings and axis.

setAxis(['AREA01', 'AREA02', 'AREA03']);
setGroupings(GROUPINGS_CSV);

/** Three pins: an Area entity, an Interface path, and a filtered group whose
 * frozen members only the bundle remembers. */
function pinsOn(caseId) {
  const refs = [
    {
      kind: 'area',
      slotKey: 'area ',
      entity: 'AREA01',
      variable: 'Load (MWh)',
      unit: 'MWh',
      axisIndex: 0,
    },
    {
      kind: 'interface',
      slotKey: slotKey(FLOW_SLOT),
      entity: 'PATH_A',
      variable: 'Power Flow (MW)',
      unit: 'MW',
      axisIndex: 0,
    },
    {
      kind: 'area',
      slotKey: 'area ',
      entity: 'Zone 1',
      label: 'Zone 1 (1 area)',
      variable: 'Load (MWh)',
      unit: 'MWh',
      axisIndex: -1,
      groupBy: 'Group',
      groupValue: 'Zone 1',
      members: ['AREA01'],
      filterContext: [{ key: 'entity', label: 'Area', constraint: 'contains 01' }],
    },
  ];
  return refs.map((ref, i) => {
    const full = { ...ref, caseId };
    return { ref: { ...full, id: rowIdOf(full) }, color: `#00000${i}` };
  });
}

/** Resolve pins against the Cases in `store`, as the chart does. */
function drawPins(store, pins) {
  const areaCases = () =>
    rowsOfKind(store, 'area', (owner) => owner.name).map((row) => ({
      id: row.caseId,
      name: row.label,
      color: '#000',
      data: row.data,
    }));
  return resolveDraws(
    {
      filters: {
        months: null,
        daysOfMonth: null,
        hoursOfDay: null,
        daysOfWeek: null,
        seasons: null,
        tou: null,
      },
      caseLabel: (caseId) => caseLabel(store.listCases().find((entry) => entry.id === caseId)),
      areaCases,
      interfaceRows: () => rowsOfKind(store, 'interface', (owner) => owner.name),
      busRows: () => [],
      generatorRows: () => [],
      busNames: () => new Map(),
      busKv: () => null,
      lines: createSeriesPool(),
    },
    pins.map((pin) => ({ ref: pin.ref, color: pin.color, dashed: false })),
  );
}

/** What `adoptRestoredCases` in main.ts does, minus the DOM: one fresh Case
 * per restored case, in bundle order. */
function adopt(store, restored) {
  return restored.map((entry) => {
    const made = store.createCase(entry.name);
    for (const table of entry.tables.values()) store.attachTable(made.id, table.key, table.data);
    return { id: made.id, name: made.name };
  });
}

/** The ids the live tabs list for one restored Case -- what the Selected tab's
 * "In scope" column matches a pin against. */
function liveIds(store, caseId) {
  const mask = new Uint8Array(HOURS).fill(1);
  const owner = store.listCases().find((entry) => entry.id === caseId);
  const at = (slot) => ({
    caseId,
    caseName: owner.name,
    caseLabel: caseLabel(owner),
    slotKey: slot,
    data: owner.tables.get(slot).data,
    mask,
  });
  const ids = new Set();
  for (const row of buildInterfaceTab({ tables: [at(slotKey(FLOW_SLOT))], areas: null }).rows) {
    ids.add(row.id);
  }
  const areaInput = { tables: [at('area ')], variable: 'Load (MWh)', areas: null };
  for (const row of buildAreaTab(areaInput).rows) ids.add(row.id);
  // Scoped to AREA01, which is what narrows Zone 1 to the member set the
  // group pin froze.
  const narrowed = { ...areaInput, areas: new Set(['AREA01']), isGroupTab: true };
  for (const row of buildAreaTab({ ...narrowed, groupBy: 'Group' }).rows) {
    ids.add(row.id);
  }
  return ids;
}

check('a bundle stores pins against its own case list, never a live Case id', () => {
  const selections = pinsOn('case-1');
  const { bundle, wire } = roundTrip([studyCase()], GROUPINGS_CSV, new Map(), selections);
  assert.equal(wire.selections, undefined, 'the id-keyed field is read, never written');
  assert.equal(wire.pins.length, 3);
  assert.ok(
    !JSON.stringify(wire.pins).includes('case-1'),
    'no saved pin carries the id its Case had when it was saved',
  );
  for (const pin of wire.pins) {
    assert.equal(pin.case, 0, 'each names its Case by index into the manifest');
    for (const rebuilt of ['id', 'caseId', 'caseName']) assert.ok(!(rebuilt in pin.ref), rebuilt);
  }
  assert.deepEqual(wire.pins[2].ref.members, ['AREA01'], 'a frozen member set survives');
  assert.deepEqual(wire.pins[2].ref.filterContext, selections[2].ref.filterContext);
  assert.deepEqual(bundle.pins, wire.pins);
});

check('one bundle restored twice into one session: every pin draws, and is in scope', () => {
  const { bundle } = roundTrip([studyCase()], GROUPINGS_CSV, new Map(), pinsOn('case-1'));
  const store = new CaseStore();
  for (const round of [1, 2]) {
    const made = adopt(store, bundle.restoredCases);
    const pins = restorePins(bundle.pins, made);
    assert.equal(pins.length, 3, `restore ${round}: no pin is lost`);
    const inScope = liveIds(store, made[0].id);
    for (const pin of pins) {
      assert.equal(pin.ref.caseId, made[0].id, `restore ${round}: the pin names this restore`);
      assert.ok(inScope.has(pin.ref.id), `restore ${round}: ${pin.ref.id} is a live row id`);
    }
    const drawn = drawPins(store, pins);
    assert.equal(drawn.length, 3, `restore ${round}: every pin resolves to a drawn line`);
    for (const line of drawn) {
      assert.ok(Number.isFinite(line.values[0]), `restore ${round}: ${line.detail} has values`);
    }
  }
  assert.equal(store.listCases().length, 2, 'two restores, two Cases, each with its own pins');
});

check('a bundle saved with id-keyed selections still restores its pins', () => {
  // The shape every bundle written before `pins` carries: the Case id at save
  // time, and a row id spliced from it in the legacy per-kind format.
  const { manifest, cubes } = buildManifest([studyCase('case-legacy', 'Old Study')], {
    groupings: GROUPINGS_CSV,
  });
  const legacy = pinsOn('case-legacy', 'Old Study').map((entry) => ({
    ...entry,
    ref: { ...entry.ref, id: `case-legacy | ${entry.ref.slotKey} | ${entry.ref.entity}` },
  }));
  legacy.push({ ...legacy[0], ref: { ...legacy[0].ref, caseId: 'case-not-in-bundle' } });
  const wire = JSON.parse(JSON.stringify({ ...manifest, selections: legacy }));
  const bundle = restoreBundle(wire, toCaseBlocks(wire, cubes));
  assert.equal(bundle.pins.length, 3, 'a pin whose Case the bundle does not carry is dropped');
  const store = new CaseStore();
  const made = adopt(store, bundle.restoredCases);
  const pins = restorePins(bundle.pins, made);
  const inScope = liveIds(store, made[0].id);
  for (const pin of pins) {
    assert.ok(inScope.has(pin.ref.id), `${pin.ref.id} is rebuilt, not spliced`);
  }
  assert.equal(drawPins(store, pins).length, 3, 'and every one draws');
});

// ------------------------------------ per-Case limits against the bundle
//
// Saved against the case INDEX, as pins are.

/** A one-path limits table whose max is `value` in every month. */
function limitTable(source, value) {
  return {
    source,
    byInterface: new Map([['PATH_A', { max: new Float32Array(12).fill(value) }]]),
  };
}

/** Two Cases, and limits pinned to the SECOND only, so a restore that
 * resolved by position from the wrong end, or by the saved id, is caught. */
function limitedStudy() {
  const cases = [studyCase('case-1', 'Base Case'), studyCase('case-2', 'High Load')];
  const { manifest, cubes } = buildManifest(cases, {
    limits: { shared: undefined, cases: new Map([['case-2', limitTable('own.csv', 250)]]) },
  });
  const wire = JSON.parse(JSON.stringify(manifest));
  return { wire, bundle: restoreBundle(wire, toCaseBlocks(wire, cubes)) };
}

check('a bundle stores per-Case limits against its own case list, never a live Case id', () => {
  const { wire, bundle } = limitedStudy();
  assert.equal(wire.limits.cases, undefined, 'the id-keyed field is read, never written');
  assert.ok(
    !JSON.stringify(wire.limits).includes('case-2'),
    'no saved limits table carries the id its Case had when it was saved',
  );
  assert.deepEqual(
    wire.limits.byCase.map((entry) => entry.case),
    [1],
    'the table names its Case by index into the manifest',
  );
  assert.equal(bundle.limits.byIndex.get(1).source, 'own.csv');
  assert.equal(bundle.limits.dropped, 0);
});

check('one bundle restored twice into one session: per-Case limits land on each restore', () => {
  const { bundle } = limitedStudy();
  const store = new CaseStore();
  const limits = createLimitsStore();
  for (const round of [1, 2]) {
    const made = adopt(store, bundle.restoredCases);
    limits.adoptLimits(bundle.limits.shared, restoreCaseLimits(bundle.limits.byIndex, made));
    assert.equal(
      limits.limitFor(made[1].id, 'PATH_A')?.max[0],
      250,
      `restore ${round}: the Case the limits were saved against draws them`,
    );
    assert.equal(
      limits.limitFor(made[0].id, 'PATH_A'),
      undefined,
      `restore ${round}: its sibling, which had none, draws none`,
    );
  }
});

check('a bundle saved with id-keyed limits still restores them', () => {
  // The shape every bundle written before `byCase` carries: the Case id at
  // save time, which is that Case's id in the same manifest.
  const { manifest, cubes } = buildManifest([studyCase('case-legacy', 'Old Study')], {});
  const wire = JSON.parse(
    JSON.stringify({
      ...manifest,
      limits: {
        cases: {
          'case-legacy': serializeLimits(limitTable('old.csv', 175)),
          'case-not-in-bundle': serializeLimits(limitTable('stray.csv', 1)),
        },
      },
    }),
  );
  const bundle = restoreBundle(wire, toCaseBlocks(wire, cubes));
  assert.equal(bundle.limits.dropped, 1, 'a table whose Case the bundle lacks is counted');
  const store = new CaseStore();
  const made = adopt(store, bundle.restoredCases);
  const limits = createLimitsStore();
  limits.adoptLimits(bundle.limits.shared, restoreCaseLimits(bundle.limits.byIndex, made));
  assert.equal(limits.limitFor(made[0].id, 'PATH_A')?.max[0], 175);
  assert.equal(limits.limitFor('case-legacy', 'PATH_A'), undefined, 'never the saved id');
});

await checkAsync(
  'both restore paths in main.ts adopt one session, or log a refusal and adopt nothing',
  async () => {
    const { readFileSync } = await import('node:fs');
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    const functions = main.split(/\n(?=(?:async )?function )/);
    const restorers = functions.filter((body) =>
      body.includes('adoptRestoredCases(loaded.restoredCases)'),
    );
    assert.deepEqual(
      restorers.map((body) => body.match(/function (\w+)/)[1]).sort(),
      ['loadAll', 'restoreBundleFile'],
      'the file drop and the origin-private Load are the two restore paths',
    );
    for (const body of restorers) {
      const name = body.match(/function (\w+)/)[1];
      assert.match(body, /adoptRestoredSession\(loaded, adopted\.made, /, name);
      // The refusal branch logs and returns before anything is adopted.
      const refused = body.slice(
        body.indexOf('if (!adopted)'),
        body.indexOf('adoptRestoredSession('),
      );
      assert.match(refused, /inventory\.logRefused(?:Source)?\(/, `${name} logs its refusal`);
      assert.match(refused, /\breturn\b/, `${name} adopts nothing when refused`);
    }
    // Inside it: display names before the view repaints; the inventory after
    // the limits and every other input it reconciles against.
    const session = functions.find((body) => body.startsWith('function adoptRestoredSession('));
    assert.ok(session, 'main.ts declares adoptRestoredSession');
    const at = (call) => session.indexOf(call);
    assert.ok(at('adoptRestoredDisplayNames(') < at('adoptRestoredView()'));
    assert.ok(at('adoptRestoredLimits(loaded.limits, made,') > 0, 'limits by the Cases made');
    assert.ok(at('adoptRestoredInventory(') > at('adoptRestoredLimits('));
    assert.match(session, /\.\.\.displayNotes,/, 'a refused display name is said');
  },
);

// ------------------------------------------ Case display names
//
// On the Case's own manifest entry, so by Case index; adopted onto the Cases
// a restore made, after the old ones are gone.

check('a display name round-trips on its Case entry, and an older bundle has none', () => {
  const shown = { ...studyCase('case-2', 'SAMPLE_run_v3_FINAL'), displayName: 'Peak' };
  const { wire, bundle } = roundTrip([studyCase(), shown], GROUPINGS_CSV);
  assert.equal(wire.version, BUNDLE_VERSION, 'the bundle version is unchanged');
  assert.ok(!('displayName' in wire.cases[0]), 'a Case with none writes none');
  assert.equal(wire.cases[1].displayName, 'Peak', 'written on its own Case entry');
  assert.equal(bundle.restoredCases[1].displayName, 'Peak');
  assert.equal(bundle.restoredCases[0].displayName, undefined);

  // Adopted as main.ts does, into a session whose old Case read "Peak".
  const store = new CaseStore();
  const old = store.createCase('Peak');
  store.removeCase(old.id);
  const made = adopt(store, bundle.restoredCases);
  bundle.restoredCases.forEach((entry, i) => {
    if (entry.displayName !== undefined) store.setDisplayName(made[i].id, entry.displayName);
  });
  const [first, second] = made.map((entry) => store.listCases().find((c) => c.id === entry.id));
  assert.equal(caseLabel(first), 'Base Case', 'no display name shows the name');
  assert.equal(caseLabel(second), 'Peak');
  assert.equal(second.name, 'SAMPLE_run_v3_FINAL', 'the name drops join on is kept');

  const older = JSON.parse(JSON.stringify(wire));
  delete older.cases[1].displayName;
  const { cases } = casesFromManifest(
    older,
    toCaseBlocks(older, buildManifest([studyCase(), shown]).cubes),
  );
  assert.ok(
    cases.every((entry) => entry.displayName === undefined),
    'an older bundle shows every Case by its name',
  );
});

// ------------------------------------------ the Contents inventory
//
// Saved against the case INDEX, as pins and per-Case limits are, and taken up
// by `Inventory.restore` against the Cases the restore made.

const sampleFile = (name, size = 10) => new File(['x'.repeat(size)], name, { lastModified: 1 });
const wideSource = (file) => ({
  file,
  shape: 'W',
  counts: { of: 'entities', kept: 1, inSource: 2 },
});
const INV_COLUMNS = [
  { kind: 'area', label: 'Area', enables: 'a' },
  { kind: 'interface', label: 'Interface', enables: 'i' },
  {
    kind: LIMITS_COLUMN,
    label: 'Limits',
    enables: 'l',
    fallback: { input: SHARED_LIMITS_INPUT, label: 'shared' },
  },
];
const INV_ROWS = [
  { input: 'buslist', label: 'BusList', enables: 'b' },
  { input: 'generatorlist', label: 'GeneratorList', enables: 'g' },
  { input: SHARED_LIMITS_INPUT, label: 'Limits (shared)', enables: 's' },
];

/** What `adoptRestoredInventory` in main.ts hands `restore` for a slot. */
function presentIn(store, limits) {
  return (caseId, slot) =>
    slot.kind === LIMITS_COLUMN
      ? limits.caseLimits().has(caseId)
      : (store
          .listCases()
          .find((entry) => entry.id === caseId)
          ?.tables.has(slotKey(slot)) ?? false);
}

/** The pivot as text, one row per Case: each cell's lines joined by `|`. */
function pivotText(inventory, cases) {
  const view = inventory.pivot(
    cases.map((entry) => ({ ...entry, color: '#000' })),
    INV_COLUMNS,
  );
  return view.rows.map((row) =>
    row.cells.map((cell) =>
      cell.lines.length === 0
        ? (cell.fallback ?? '—')
        : cell.lines
            .map(
              (line) =>
                `${line.variant ? `${line.variant}: ` : ''}${line.files.map((f) => f.name ?? NOT_RECORDED).join(' + ')}`,
            )
            .join(' | '),
    ),
  );
}

/** A two-Case session whose SECOND Case holds the recorded tables and its own
 * limits, with a BusList and an About note. */
function inventoriedStudy() {
  const cases = [studyCase('case-1', 'Base Case'), studyCase('case-2', 'High Load')];
  const inventory = createInventory(() => 5);
  inventory.recordTable('case-2', AREA_SLOT, [wideSource(sampleFile('SAMPLE_area.csv'))]);
  // Replaced, so the Log holds an event that names a Case and slot.
  inventory.recordTable('case-2', FLOW_SLOT, [wideSource(sampleFile('SAMPLE_flow_old.csv'))]);
  inventory.recordTable('case-2', FLOW_SLOT, [
    wideSource(sampleFile('SAMPLE_flow_h1.csv')),
    wideSource(sampleFile('SAMPLE_flow_h2.csv')),
  ]);
  inventory.recordCaseFile('case-2', LIMITS_COLUMN, sampleFile('SAMPLE_own_limits.csv'), 'Limits');
  inventory.recordSessionInput('buslist', [sampleFile('SAMPLE_buses.csv')], 'BusList');
  inventory.setAbout('SAMPLE note: made for the round-trip check.');
  const { manifest, cubes } = buildManifest(cases, {
    limits: {
      shared: undefined,
      cases: new Map([['case-2', limitTable('SAMPLE_own_limits.csv', 9)]]),
    },
    inventory: inventory.snapshot(),
  });
  const wire = JSON.parse(JSON.stringify(manifest));
  return { wire, bundle: restoreBundle(wire, toCaseBlocks(wire, cubes)) };
}

check('a bundle stores its inventory against its own case list, never a live Case id', () => {
  const { wire, bundle } = inventoriedStudy();
  assert.equal(wire.version, 3, 'an optional field is not a new envelope version');
  const text = JSON.stringify(wire.inventory);
  assert.ok(!text.includes('case-2') && !text.includes('case-1'), 'no live Case id is written');
  assert.deepEqual(
    [...new Set(wire.inventory.slots.map((entry) => entry.case))],
    [1],
    'every slot names its Case by index into the manifest',
  );
  const onCase = wire.inventory.log.filter((event) => event.slot !== undefined);
  assert.ok(onCase.length > 0 && onCase.every((event) => event.case === 1), 'and every Log event');
  assert.equal(wire.inventory.about, 'SAMPLE note: made for the round-trip check.');
  assert.deepEqual(bundle.inventory, wire.inventory, 'restoreBundle reads it back whole');
});

check('one bundle restored twice: the inventory lands on each restore’s own Cases', () => {
  const { bundle } = inventoriedStudy();
  const store = new CaseStore();
  const limits = createLimitsStore();
  const inventory = createInventory(() => 7);
  for (const round of [1, 2]) {
    const made = adopt(store, bundle.restoredCases);
    limits.adoptLimits(bundle.limits.shared, restoreCaseLimits(bundle.limits.byIndex, made));
    inventory.restore(bundle.inventory, {
      made,
      present: presentIn(store, limits),
      adopted: new Set(['buslist', SHARED_LIMITS_INPUT]),
      source: sampleFile('SAMPLE_bundle.gvmb'),
    });
    assert.deepEqual(
      pivotText(inventory, made),
      [
        ['—', '—', '—'],
        [
          'SAMPLE_area.csv',
          'Power Flow (MW): SAMPLE_flow_h1.csv + SAMPLE_flow_h2.csv',
          'SAMPLE_own_limits.csv',
        ],
      ],
      `restore ${round}: the pivot reads back the same, on the Case it was saved on`,
    );
    const strip = inventory.strip(INV_ROWS);
    assert.deepEqual(
      strip.map((row) => row.files.map((f) => f.name)),
      [['SAMPLE_buses.csv'], [], []],
    );
    assert.equal(inventory.about(), 'SAMPLE note: made for the round-trip check.');
    const log = inventory.log({ cases: made, columns: INV_COLUMNS, rows: INV_ROWS });
    const last = log[log.length - 1];
    assert.equal(last.event, 'restored');
    assert.deepEqual(
      last.files.map((f) => f.name),
      ['SAMPLE_bundle.gvmb'],
    );
    assert.equal(
      log.filter((line) => line.event === 'restored').length,
      1,
      `restore ${round}: the Log is the bundle's, not appended to the last restore's`,
    );
    assert.ok(
      log.some((line) => line.where === 'High Load · Interface: Power Flow (MW)'),
      'a saved event names the Case the restore made',
    );
  }
  // Saved again, the restored inventory writes the same index-keyed entries.
  const cases = store.listCases().slice(-2);
  const again = buildManifest(cases, { inventory: inventory.snapshot() }).manifest.inventory;
  assert.deepEqual(
    again.slots.map((entry) => [entry.case, entry.slot.kind]),
    bundle.inventory.slots.map((entry) => [entry.case, entry.slot.kind]),
  );
});

check('a sparse bundle replaces only the session rows it carried and the restore adopted', () => {
  const { bundle } = inventoriedStudy();
  const store = new CaseStore();
  const limits = createLimitsStore();
  const inventory = createInventory(() => 7);
  inventory.recordSessionInput('buslist', [sampleFile('SAMPLE_old_buses.csv')], 'BusList');
  inventory.recordSessionInput('generatorlist', [sampleFile('SAMPLE_units.csv')], 'GeneratorList');
  inventory.recordSessionInput(SHARED_LIMITS_INPUT, [sampleFile('SAMPLE_shared.csv')], 'Limits');
  const made = adopt(store, bundle.restoredCases);
  inventory.restore(bundle.inventory, {
    made,
    present: presentIn(store, limits),
    // The bundle carried a BusList and no GeneratorList or limits.
    adopted: new Set(['buslist']),
    source: 'origin-private storage',
  });
  assert.deepEqual(
    inventory.strip(INV_ROWS).map((row) => row.files.map((f) => f.name)),
    [['SAMPLE_buses.csv'], ['SAMPLE_units.csv'], ['SAMPLE_shared.csv']],
    'the GeneratorList and shared limits the bundle did not carry keep their rows',
  );
  const log = inventory.log({ cases: made, columns: INV_COLUMNS, rows: INV_ROWS });
  const restored = log.find((line) => line.event === 'restored');
  assert.equal(restored.reason, 'from origin-private storage');
});

check('a limits block with no shared table clears the shared row, as it clears the store', () => {
  const { bundle } = inventoriedStudy();
  const store = new CaseStore();
  const limits = createLimitsStore();
  const inventory = createInventory(() => 7);
  inventory.recordSessionInput(SHARED_LIMITS_INPUT, [sampleFile('SAMPLE_shared.csv')], 'Limits');
  const made = adopt(store, bundle.restoredCases);
  limits.adoptLimits(bundle.limits.shared, restoreCaseLimits(bundle.limits.byIndex, made));
  inventory.restore(bundle.inventory, {
    made,
    present: presentIn(store, limits),
    adopted: new Set(['buslist', SHARED_LIMITS_INPUT]),
    source: 'origin-private storage',
  });
  assert.equal(limits.sharedLimits(), undefined);
  assert.deepEqual(inventory.strip(INV_ROWS)[2].files, [], 'the row says what the store holds');
});

check('a refused restore leaves the inventory as it was, and logs the refusal', () => {
  const inventory = createInventory(() => 7);
  inventory.recordTable('live', AREA_SLOT, [wideSource(sampleFile('SAMPLE_live.csv'))]);
  inventory.setAbout('SAMPLE live note');
  const cases = [{ id: 'live', name: 'Live' }];
  const before = pivotText(inventory, cases);
  // What both restore paths in main.ts do when no table was readable: log,
  // and never reach `restore` (asserted on main.ts below).
  inventory.logRefused([sampleFile('SAMPLE_empty.gvmb')], 'carried no table this build can read');
  inventory.logRefusedSource('origin-private storage', 'a stale blob');
  assert.deepEqual(pivotText(inventory, cases), before);
  assert.equal(inventory.about(), 'SAMPLE live note');
  const log = inventory.log({ cases, columns: INV_COLUMNS, rows: INV_ROWS });
  assert.deepEqual(
    log.map((line) => [line.event, line.files.map((f) => f.name).join()]),
    [
      ['loaded', 'SAMPLE_live.csv'],
      ['refused', 'SAMPLE_empty.gvmb'],
      ['refused', 'origin-private storage'],
    ],
  );
});

check('a table this build cannot read reconciles to `dropped at restore`', () => {
  const cases = [studyCase('case-1', 'Base Case')];
  const inventory = createInventory(() => 5);
  inventory.recordTable('case-1', AREA_SLOT, [wideSource(sampleFile('SAMPLE_area.csv'))]);
  inventory.recordTable('case-1', { kind: 'zone' }, [wideSource(sampleFile('SAMPLE_zone.csv'))]);
  const { manifest, cubes } = buildManifest(cases, { inventory: inventory.snapshot() });
  const wire = JSON.parse(JSON.stringify(manifest));
  // A kind another build wrote: its table rides in the manifest and its cube
  // bytes after the last table, and this build drops it on read.
  const zoneBytes = 64;
  wire.cases[0].tables['zone '] = { kind: 'zone', cubeBytes: zoneBytes, year: 2032 };
  wire.cases[0].cubeBytes += zoneBytes;
  const blocks = toCaseBlocks(wire, [...cubes, new Uint8Array(zoneBytes)]);
  const bundle = restoreBundle(wire, blocks);
  assert.ok(bundle.warnings.some((warning) => /zone/.test(warning)));

  const store = new CaseStore();
  const restored = createInventory(() => 7);
  const made = adopt(store, bundle.restoredCases);
  restored.restore(bundle.inventory, {
    made,
    present: presentIn(store, createLimitsStore()),
    adopted: new Set(),
    source: 'origin-private storage',
  });
  assert.deepEqual(pivotText(restored, made), [['SAMPLE_area.csv', '—', '—']]);
  const log = restored.log({ cases: made, columns: INV_COLUMNS, rows: INV_ROWS });
  const dropped = log.filter((line) => line.event === 'dropped at restore');
  assert.deepEqual(
    dropped.map((line) => [line.files.map((f) => f.name).join(), line.where]),
    [['SAMPLE_zone.csv', 'Base Case · zone']],
  );
  assert.ok(log.indexOf(dropped[0]) > log.findIndex((line) => line.event === 'restored'));
});

// ---------------------------- old bundles: the inventory reconstructed
//
// A bundle saved before the inventory existed still fills the panel, from
// what it holds, with every table's filename "not recorded".

const SAMPLE_BUSLIST = [
  'BUS_GENERAL,,',
  'BusID,Name,LoadArea',
  '90001,SAMPLE_B1,SAMPLE_AREA_1',
  '90002,SAMPLE_B2,SAMPLE_AREA_1',
].join('\n');

/** Restore `bundle` into a fresh session the way main.ts does, with every
 * session input it carried adopted. */
function restoreInto(bundle, adopted) {
  const store = new CaseStore();
  const limits = createLimitsStore();
  const inventory = createInventory(() => 7);
  const made = adopt(store, bundle.restoredCases);
  limits.adoptLimits(bundle.limits.shared, restoreCaseLimits(bundle.limits.byIndex, made));
  inventory.restore(bundle.inventory, {
    made,
    present: presentIn(store, limits),
    adopted: new Set(adopted),
    source: 'origin-private storage',
  });
  return { store, inventory, made };
}

check('a bundle with no inventory reconstructs its Cases, slots, counts and session rows', () => {
  const busList = buildLookup(parseLookupCsv(SAMPLE_BUSLIST, 'SAMPLE_buses.csv').rows);
  const cases = [studyCase('case-1', 'Base Case'), studyCase('case-2', 'High Load')];
  const { manifest, cubes } = buildManifest(cases, {
    groupings: GROUPINGS_CSV,
    lookups: new Map([['buslist', busList]]),
    limits: {
      shared: limitTable('SAMPLE_shared_limits.csv', 100),
      cases: new Map([['case-2', limitTable('SAMPLE_own_limits.csv', 250)]]),
    },
  });
  assert.equal('inventory' in manifest, false, 'the fixture is an old bundle');
  const wire = JSON.parse(JSON.stringify(manifest));
  const bundle = restoreBundle(wire, toCaseBlocks(wire, cubes));
  const { inventory, made } = restoreInto(bundle, ['buslist', SHARED_LIMITS_INPUT, 'groups:area']);

  const notRecorded = (variant) => `${variant}: ${NOT_RECORDED}`;
  const flowAndCost = [notRecorded('Congestion Cost ($)'), notRecorded('Power Flow (MW)')].join(
    ' | ',
  );
  assert.deepEqual(pivotText(inventory, made), [
    [NOT_RECORDED, flowAndCost, 'shared'],
    [NOT_RECORDED, flowAndCost, 'SAMPLE_own_limits.csv'],
  ]);
  const strip = inventory.strip([
    ...INV_ROWS,
    { input: 'groups:area', label: 'Area groups', enables: 'g' },
  ]);
  assert.deepEqual(
    strip.map((row) => row.files.map((file) => file.name ?? NOT_RECORDED)),
    [['SAMPLE_buses.csv'], [], ['SAMPLE_shared_limits.csv'], [NOT_RECORDED]],
    'a list names its own sources, the limits their source, and a group map no file',
  );

  const view = inventory.pivot(
    made.map((entry) => ({ ...entry, color: '#000' })),
    INV_COLUMNS,
  );
  const area = inventory.detail(view.rows[0].cells[0].lines[0].files[0].id);
  const field = (label) => area.fields.find((entry) => entry.label === label)?.value;
  assert.equal(field('File'), NOT_RECORDED);
  assert.equal(field('Kind'), 'area');
  assert.equal(field('Metrics'), '2 kept of 3 in the file', 'counts from the kind’s own fields');
  assert.match(field('Recorded'), /rebuilt/, 'a reconstructed record says so');
  const flow = inventory.detail(view.rows[1].cells[1].lines[1].files[0].id);
  assert.equal(
    flow.fields.find((entry) => entry.label === 'Entities')?.value,
    '2 kept of 3 in the file',
  );
  assert.equal(inventory.about(), '');
});

check('an old bundle whose area mapping is a bare header reconstructs no groups row', () => {
  const { manifest, cubes } = buildManifest([studyCase('case-1', 'Base Case')], {
    groupings: 'Name,Grouping\n',
  });
  const wire = JSON.parse(JSON.stringify(manifest));
  const bundle = restoreBundle(wire, toCaseBlocks(wire, cubes));
  assert.deepEqual(
    bundle.inventory.session.map((entry) => entry.input),
    [],
    'every save writes the mapping, so a header alone names no file',
  );
});

check('a legacy-migrated bundle reconstructs too', () => {
  const table = areaTable();
  const raw = { version: 1, cases: [legacyAreaCase('Legacy Base Case', table)] };
  const migrated = migrateManifest(raw, [cubeBuffer(table.cube)]);
  const bundle = restoreBundle(migrated.manifest, migrated.cubes, migrated.warnings);
  const { inventory, made } = restoreInto(bundle, []);
  assert.deepEqual(pivotText(inventory, made), [[NOT_RECORDED, '—', '—']]);
  const log = inventory.log({ cases: made, columns: INV_COLUMNS, rows: INV_ROWS });
  assert.deepEqual(
    log.map((line) => line.event),
    ['restored'],
    'an old bundle has no Log of its own',
  );
});

check('saving after a reconstructing restore writes an ordinary inventory', () => {
  const cases = [studyCase('case-1', 'Base Case')];
  const { manifest, cubes } = buildManifest(cases, {
    limits: { shared: limitTable('SAMPLE_shared_limits.csv', 100), cases: new Map() },
  });
  const wire = JSON.parse(JSON.stringify(manifest));
  const { store, inventory } = restoreInto(restoreBundle(wire, toCaseBlocks(wire, cubes)), [
    SHARED_LIMITS_INPUT,
  ]);
  const again = JSON.parse(
    JSON.stringify(buildManifest(store.listCases(), { inventory: inventory.snapshot() }).manifest),
  );
  assert.ok(again.inventory, 'the next save carries an inventory');
  assert.ok(
    again.inventory.records.every((record) => !('reconstructed' in record)),
    'with no reconstruction flag: its entries are ordinary ones now',
  );
  assert.deepEqual(again.inventory.slots.map((entry) => entry.slot.kind).sort(), [
    'area',
    'interface',
    'interface',
  ]);
  assert.equal(
    again.inventory.records.filter((record) => record.name === null).length,
    3,
    'a table filename that was never recorded stays unrecorded, never guessed',
  );
  // Restored from the new bundle, it reads the same, and is not rebuilt again.
  const bundle = restoreBundle(again, toCaseBlocks(again, buildManifest(store.listCases()).cubes));
  assert.deepEqual(bundle.inventory.slots.length, 3);
  assert.equal(bundle.inventory.log.length, 1, 'the restore it came from is in its Log');
});

await checkAsync('each kind names the manifest field its group map is saved under', async () => {
  const { GROUPS_FIELDS } = await import('../src/tables/registry.ts');
  const saved = { mapping: {}, members: [] };
  const { manifest } = buildManifest([studyCase()], {
    groupings: GROUPINGS_CSV,
    generatorGroups: saved,
    busGroups: saved,
    interfaceGroups: saved,
  });
  for (const [kind, field] of Object.entries(GROUPS_FIELDS)) {
    // A misspelt field would reconstruct no groups row, silently.
    assert.ok(field in manifest, `${kind}: ${field} is written`);
  }
  assert.equal(new Set(Object.values(GROUPS_FIELDS)).size, Object.keys(GROUPS_FIELDS).length);
});

console.log(`\n${passed} checks passed.`);
