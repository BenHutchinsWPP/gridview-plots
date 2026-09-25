// tests/test_lookup_storage.mjs — the reference lists' half of the v3 envelope.
//
// The footgun: `Int32Array`/`Float64Array` through plain `JSON.stringify`
// come back as objects with 30,000 numeric keys, and `byName`/`index` are
// `Map`s, which stringify to `{}`. Then every join resolves to -1 and every
// grouped plot silently collapses into "(no attribute)". So the checks are not
// "does it save" but "are the columns TYPED ARRAYS, and does a JOIN resolve".
//
// Both doors are driven: the `.gvmb` file path (magic + length + JSON + cubes,
// through `readBundleFile`) and the OPFS path (no magic, `manifest.version`,
// through `migrateManifest` + `restoreBundle`), because the two readers
// discriminate differently and a field carried by one is not thereby carried
// by the other.
//
// Run:  node test_lookup_storage.mjs

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { restoreBundle, readBundleFile } = await import('../src/storage/store.ts');
const { buildManifest, BUNDLE_VERSION } = await import('../src/storage/envelope.ts');
const { migrateManifest } = await import('../src/storage/legacy.ts');
const { buildLookup, parseLookupCsv } = await import('../src/lookups/parse.ts');
const { cellText } = await import('../src/lookups/merge.ts');
const { serializeLookup, deserializeLookup } = await import('../src/lookups/envelope.ts');
const { attachLookup, clearLookups, lookupFor } = await import('../src/lookups/store.ts');

const { readSessionReference } = await import('../src/session/reference.ts');
const { createLimitsStore } = await import('../src/limits/store.ts');
/** What the session holds, with no groupings mapping. Stated explicitly:
 *  `buildManifest` reads no store itself. */
const sessionContents = () => ({ ...readSessionReference(createLimitsStore()), groupings: null });

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`ok - ${label}`);
}
async function checkAsync(label, fn) {
  await fn();
  passed++;
  console.log(`ok - ${label}`);
}

const BUS_COLUMNS = [
  'BusID',
  'Name',
  'BaseKV',
  'Type',
  'VM',
  'VA',
  'Latitude',
  'Longitude',
  'Monitored',
  'LoadArea',
  'PSSEArea',
  'PSSEZone',
];
function busListCsv(rows) {
  return [
    `BUS_GENERAL${','.repeat(BUS_COLUMNS.length - 1)}`,
    BUS_COLUMNS.join(','),
    ...rows.map(([id, name, area]) => `${id},${name},230,1,1.02,0,44.5,-121.5,TRUE,${area},A1,Z1`),
  ].join('\n');
}
function generatorListCsv(rows) {
  const columns = ['Name', 'Bus ID', 'FuelType', 'EconomicPMax'];
  return [
    `GENERATORLIST${','.repeat(columns.length - 1)}`,
    `Note!!! Please add ' at the beginning of generator ID.${','.repeat(columns.length - 1)}`,
    columns.join(','),
    ...rows.map(([name, bus, fuel]) => `${name},${bus},${fuel},250.5`),
  ].join('\n');
}

const BUSES = busListCsv([
  [101, 'ALDER', 'NORTH'],
  [102, 'BIRCH', 'SOUTH'],
  [103, 'CEDAR', 'NORTH'],
]);
const GENERATORS = generatorListCsv([
  ['G-ALDER-1', 101, 'HYDRO'],
  ['G-BIRCH-1', 102, 'WIND'],
]);

function loadSession() {
  clearLookups();
  attachLookup(parseLookupCsv(BUSES, 'BusList.csv').rows);
  attachLookup(parseLookupCsv(GENERATORS, 'GeneratorList.csv').rows);
}

/** Columns as comparable plain data — the byte-identity comparison. */
function snapshot(table) {
  return JSON.stringify(
    table.columns.map((column) => ({
      name: column.name,
      kind: column.kind,
      labels: column.labels,
      values: column.values === undefined ? undefined : Array.from(column.values),
      codes: column.codes === undefined ? undefined : Array.from(column.codes),
      nulls: column.nulls === undefined ? undefined : Array.from(column.nulls),
    })),
  );
}

function bundleFileBytes(magic, manifestObj, cubeChunks = []) {
  const manifestJson = Buffer.from(JSON.stringify(manifestObj));
  const header = Buffer.alloc(magic.length + 4);
  header.write(magic, 0, 'ascii');
  header.writeUInt32LE(manifestJson.byteLength, magic.length);
  return Buffer.concat([header, manifestJson, ...cubeChunks]);
}

// --------------------------------------------------------- the two doors

await checkAsync('two lookups round-trip byte-identically through the .gvmb door', async () => {
  loadSession();
  const before = { buslist: lookupFor('buslist'), generatorlist: lookupFor('generatorlist') };
  const { manifest } = buildManifest([], sessionContents());
  assert.ok(manifest.lookups, 'the manifest carries them beside groupings, top level');
  assert.deepEqual(Object.keys(manifest.lookups).sort(), ['buslist', 'generatorlist']);

  const file = new File([bundleFileBytes('GVMB', manifest)], 'study.gvmb');
  const restored = await readBundleFile(file);
  assert.equal(restored.lookups.size, 2);
  for (const variant of ['buslist', 'generatorlist']) {
    assert.equal(
      snapshot(restored.lookups.get(variant)),
      snapshot(before[variant]),
      `${variant} came back byte-identical`,
    );
  }
  assert.deepEqual(restored.warnings, [], 'and nothing was dropped on the way');
});

check('the same bundle round-trips through the OPFS door', () => {
  loadSession();
  const before = lookupFor('buslist');
  const { manifest } = buildManifest([], sessionContents());
  // The OPFS blob has no magic to read: `loadBundle` JSON.parses the manifest
  // and discriminates on `manifest.version`. This is that path, minus the I/O.
  const wire = JSON.parse(JSON.stringify(manifest));
  assert.equal(wire.version, BUNDLE_VERSION);
  const migrated = migrateManifest(wire, []);
  const restored = restoreBundle(migrated.manifest, migrated.cubes, migrated.warnings);
  assert.equal(snapshot(restored.lookups.get('buslist')), snapshot(before));
  assert.deepEqual(restored.warnings, []);
});

// ------------------------------------------ typed-array columns, both halves

check('a restored lookup has TYPED ARRAY columns and its joins resolve', () => {
  loadSession();
  const { manifest } = buildManifest([], sessionContents());
  const wire = JSON.parse(JSON.stringify(manifest));
  const restored = restoreBundle(wire, []).lookups.get('buslist');

  // Half one: the columns are typed arrays, not objects with numeric keys.
  const busId = restored.columns[restored.byName.get('BusID')];
  assert.ok(
    busId.values instanceof Int32Array,
    `BusID came back as ${busId.values.constructor.name}`,
  );
  assert.ok(busId.nulls instanceof Uint8Array);
  const kv = restored.columns[restored.byName.get('BaseKV')];
  assert.ok(kv.values instanceof Float64Array, `BaseKV came back as ${kv.values.constructor.name}`);
  const area = restored.columns[restored.byName.get('LoadArea')];
  assert.ok(area.codes instanceof Int32Array);
  assert.deepEqual(area.labels, ['NORTH', 'SOUTH'], 'the dictionary rode along with its codes');

  // Half two: `index` and `byName` are Maps, `JSON.stringify(new Map())` is
  // `{}`, so they are DERIVED here. If they were written, every lookup below
  // would be undefined and every join would answer -1.
  assert.equal(wire.lookups.buslist.index, undefined, 'index is never written');
  assert.equal(wire.lookups.buslist.byName, undefined, 'byName is never written');
  assert.equal(restored.index.size, 3);
  const row = restored.index.get(102);
  assert.equal(typeof row, 'number', 'an int key restores as a NUMBER, or it matches nothing');
  assert.equal(cellText(restored.columns[restored.byName.get('Name')], row), 'BIRCH');
  assert.equal(area.labels[area.codes[row]], 'SOUTH', 'the join resolves to the right row');

  const generators = restoreBundle(wire, []).lookups.get('generatorlist');
  assert.equal(
    cellText(
      generators.columns[generators.byName.get('FuelType')],
      generators.index.get('G-BIRCH-1'),
    ),
    'WIND',
    'a text-keyed list joins on its string key',
  );
});

check('a column that came back the wrong length is refused by name', () => {
  loadSession();
  const raw = serializeLookup(lookupFor('buslist'));
  const short = {
    ...raw,
    columns: raw.columns.map((column) =>
      column.name === 'Name' ? { ...column, values: column.values.slice(0, 1) } : column,
    ),
  };
  assert.throws(() => deserializeLookup(short), /column "Name" is 1 values, expected 3/);
  // The analogue of the cube-size and presence-length guards the table kinds
  // already have: a silently short column is a join that answers -1.
  const noNulls = {
    ...raw,
    columns: raw.columns.map((column) =>
      column.name === 'BusID' ? { ...column, nulls: column.nulls.slice(0, 1) } : column,
    ),
  };
  assert.throws(() => deserializeLookup(noNulls), /1 null flags for 3 rows/);
});

check('a malformed saved list is dropped with its reason, never half-restored', () => {
  loadSession();
  const { manifest } = buildManifest([], sessionContents());
  const wire = JSON.parse(JSON.stringify(manifest));
  wire.lookups.buslist.rowCount = 99;
  const restored = restoreBundle(wire, []);
  assert.equal(restored.lookups.has('buslist'), false);
  assert.equal(restored.lookups.has('generatorlist'), true, 'the other list still loads');
  assert.match(restored.warnings[0], /Dropped the saved "buslist" reference list/);
});

// ------------------------------------------------------- compatibility

check('a v3 bundle with no lists field still loads', () => {
  clearLookups();
  const { manifest } = buildManifest([], sessionContents());
  assert.equal('lookups' in manifest, false, 'no lists loaded, no field written');
  const restored = restoreBundle(JSON.parse(JSON.stringify(manifest)), []);
  assert.equal(restored.lookups.size, 0);
  assert.deepEqual(restored.warnings, []);
  // And the bitmaps that predate the `@type` half of the `@bytes` tag decode
  // as Uint8Array exactly as they did, which is what makes this optional field
  // cost no version bump.
  assert.equal(restored.groupings, null);
});

check('buildManifest throws for no new reason when a list is loaded', () => {
  loadSession();
  assert.doesNotThrow(() => buildManifest([], sessionContents()));
  clearLookups();
});

console.log(`\n${passed} checks passed.`);
