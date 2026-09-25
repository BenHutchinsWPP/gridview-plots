// tests/test_integration.mjs — the whole path in one process: three synthetic
// CSVs in as bytes, out of a saved bundle as three tables on ONE Case, byte
// for byte. It catches what only appears at the seams:
//
//   * A Case with an Area and an Interface table round-trips cube, PRESENCE
//     and TOU (a lost presence bit turns absent data into a plausible number).
//   * TWO Interface tables of different quantities stay distinct from the
//     title line to the restored slot key.
//   * The area `groupings` mapping round-trips.
//   * A legacy `GVAP` bundle migrates and loads through the real file reader.
//
// Unlike the per-module suites, it carries real parser output into a
// CaseStore and a bundle, uses the real `readBundleFile`, and takes variants
// from `detect.classify`. Workers and chart modules are not covered (no DOM).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import './test_loader.mjs';
import { exportCsv as areaExportCsv, groupingsCsv, AREAS } from './test_fixtures.mjs';
import { exportCsv as interfaceExportCsv, interfaceNames } from './test_fixtures_interface.mjs';

const { classify } = await import('../src/detect.ts');
const { planImports } = await import('../src/app/import-plan.ts');
const { CaseStore, slotKey } = await import('../src/model/case-model.ts');
const { restoreBundle, readBundleFile } = await import('../src/storage/store.ts');
const { buildManifest, BUNDLE_VERSION } = await import('../src/storage/envelope.ts');
const { createSectionState } = await import('../src/ui/section-state.ts');
const { allAreas } = await import('../src/tables/area/groupings.ts');
const { HOURS_PER_YEAR, TOU_LABELS } = await import('../src/model/calendar.ts');

const areaHeader = await import('../src/tables/long/header.ts');
const areaBlock = await import('../src/tables/long/block.ts');
const areaPool = await import('../src/tables/long/pool.ts');
const areaLong = await import('../src/tables/area/long.ts');
const ifaceHeader = await import('../src/tables/interface/header.ts');
const ifaceBlock = await import('../src/tables/interface/block.ts');
const ifacePool = await import('../src/tables/interface/pool.ts');

const HOURS = HOURS_PER_YEAR;
const NEWLINE = 10;
const YEAR = 2036;

let checks = 0;
async function check(label, fn) {
  await fn();
  checks++;
  console.log(`ok - ${label}`);
}

/** Raw bytes of a typed array. Values cannot be compared: absent planes are
 * NaN, and `NaN !== NaN` is exactly where the data matters. */
function bytesOf(view) {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

/** The worker's byte-range rule on an in-memory buffer (its tiling is proved
 * in test_ingest_area.mjs / test_ingest_interface.mjs). */
function wholeRowRanges(bytes, dataStart, blockBytes) {
  const ranges = [];
  for (let start = dataStart; start < bytes.length; start += blockBytes) {
    const from = start === dataStart ? dataStart : areaBlock.afterNextNewline(bytes, start);
    if (from < 0) continue;
    const end = Math.min(start + blockBytes, bytes.length);
    let to = areaBlock.afterNextNewline(bytes, end);
    if (to < 0) to = bytes.length;
    if (to > from) ranges.push([from, to]);
  }
  return ranges;
}

// ---------------------------------------------------------------- fixtures
//
// Synthetic. The two Interface fixtures differ in quantity AND paths, so the
// union axis and presence bitmaps are real.

const AREA_CSV = areaExportCsv({ year: YEAR, days: 1, hours: 2 });

const PF_NAMES = interfaceNames(6);
const CC_NAMES = interfaceNames(8).slice(2);
const PF_QUANTITY = 'Power Flow (MW)';
const CC_QUANTITY = 'Congestion Cost ($)';

const PF_CSV = interfaceExportCsv({
  year: YEAR,
  days: 3,
  hours: 24,
  names: PF_NAMES,
  quantity: PF_QUANTITY,
});
const CC_CSV = interfaceExportCsv({
  year: YEAR,
  days: 3,
  hours: 24,
  seed: 987654,
  names: CC_NAMES,
  quantity: CC_QUANTITY,
});

const AREA_FILE = new File([AREA_CSV], '01_area.csv');
const PF_FILE = new File([PF_CSV], '01_PF.csv');
const CC_FILE = new File([CC_CSV], '01_CC.csv');

const CASE_NAME = 'Study 2036 Base';
const GROUPINGS_CSV = groupingsCsv();

// A retained column no export carries: its presence must stay 0 and its plane
// NaN through the round trip.
const ABSENT_METRIC = 'Absent Column (MWh)';

// An axis area no row mentions (legitimate: the axis is not narrowed after
// failures). It also keeps the axis round-trip check non-vacuous.
const GHOST_AREA = 'AREA_GHOST';

// ---------------------------------------------------------------- 1. detect

const detected = {
  area: classify(AREA_CSV, AREA_FILE.name),
  pf: classify(PF_CSV, PF_FILE.name),
  cc: classify(CC_CSV, CC_FILE.name),
};

await check(
  'detect routes each dropped file to its own parser, and reads the two quantities',
  () => {
    assert.equal(detected.area.kind, 'area');
    assert.equal(detected.area.confidence, 'high');
    assert.equal(detected.area.variant, undefined, 'Area has no variant: one Area table per Case');

    assert.equal(detected.pf.kind, 'interface');
    assert.equal(detected.cc.kind, 'interface');
    // Without the variant both Interface files share slot `interface ` and
    // the second replaces the first.
    assert.equal(detected.pf.variant, PF_QUANTITY);
    assert.equal(detected.cc.variant, CC_QUANTITY);
    assert.notEqual(detected.pf.variant, detected.cc.variant);
  },
);

// ------------------------------------------------------------ 2. import plan

const importFiles = [
  { name: AREA_FILE.name, detected: detected.area },
  { name: PF_FILE.name, detected: detected.pf },
  { name: CC_FILE.name, detected: detected.cc },
];

const plans = planImports(importFiles, 'one-case', { caseName: CASE_NAME });

await check('one-case mode puts all three files on one NEW Case, in three distinct slots', () => {
  assert.equal(plans.length, 3);
  for (const plan of plans) {
    assert.equal(plan.caseName, CASE_NAME);
    assert.equal(plan.caseIsNew, true, 'nothing is loaded yet, so the target Case is new');
    assert.equal(plan.replacesExisting, false);
    assert.equal(plan.slotConflict, false, `${plan.file} must not collide`);
  }
  assert.deepEqual(
    plans.map((p) => slotKey({ kind: p.kind, variant: p.variant })),
    ['area ', `interface ${PF_QUANTITY}`, `interface ${CC_QUANTITY}`],
  );

  // The control: without the title-line variants the same files collide, so
  // the passing case is not an inert check.
  const blind = planImports(importFiles, 'one-case', {
    caseName: CASE_NAME,
    // Keyed by INDEX into `importFiles`, never by filename: one drop can
    // legitimately carry two files of the same name.
    overrides: {
      1: { variantOverride: '' },
      2: { variantOverride: '' },
    },
  });
  assert.deepEqual(
    blind.map((p) => p.slotConflict),
    [false, true, true],
    'two Interface files with no variant DO collide -- the check above is live',
  );
});

// --------------------------------------------------------------- 3. ingest
//
// The real parsers on the committed wasm, called in `ingest()`'s order. Only
// the worker dispatch is replaced (Node cannot resolve Vite's worker URLs).

const areaWasm = new WebAssembly.Module(
  readFileSync(new URL('../parser/long/block.wasm', import.meta.url)),
);
const interfaceWasm = new WebAssembly.Module(
  readFileSync(new URL('../parser/wide/block.wasm', import.meta.url)),
);

// --- Area. The axis discovery is batch-wide and stays batch-wide: discovered
// over every surviving plan's scan blocks, unioned once against the axis
// already loaded, and loaded into the parser's hash table once.
const areaPlan = await areaPool.readCasePlan(AREA_FILE, areaLong.AREA_LONG);
const areaRanges = wholeRowRanges(AREA_CSV, areaPlan.dataStart, 4096);
{
  const scanner = await areaBlock.instantiateParser(areaWasm);
  const names = new Set();
  for (const [from, to] of areaRanges) {
    for (const name of areaBlock.scanAxis(scanner, AREA_CSV, from, to).names) names.add(name);
  }
  areaPlan.entities = [...names];
}
const areaAxis = areaPool.unionEntities([areaPlan], [GHOST_AREA]);

// The retained-column decision is made ONCE for the batch, over the union
// schema, and is what a section's `retainedColumns` then holds.
const areaUnion = areaLong.unionOf([areaPlan]);
const AREA_RETAINED = [...areaUnion.slice(0, 3), ABSENT_METRIC];

const areaColumnPlan = areaHeader.buildColumnPlan(areaPlan.header, AREA_RETAINED);
const areaParser = await areaBlock.instantiateParser(areaWasm, areaHeader.entityHashes(areaAxis));
const areaAccumulator = areaPool.createAccumulator(areaColumnPlan, areaAxis.length);
for (const [from, to] of areaRanges) {
  const scan = areaBlock.scanAxis(areaParser, AREA_CSV, from, to);
  areaPool.blitBlock(
    areaAccumulator,
    areaBlock.parseBytes(
      areaParser,
      AREA_CSV,
      from,
      to,
      areaColumnPlan.activePlanes,
      areaAxis.length,
      areaColumnPlan.sourceMetricCount,
      scan.rows,
    ),
  );
}
const areaDerivedWarnings = areaLong.applyDerived(areaAccumulator);
const areaFinal = areaLong.finalizeCase(
  areaAccumulator,
  AREA_FILE.name,
  areaPlan.header.metricNames,
  areaPlan.year,
  areaAxis,
);
const areaTable = areaFinal.data;

// --- Interface. Both plans are read BEFORE either is parsed, because the
// retained set is the union across the batch: a per-file loop would silently
// drop the second file's new paths from the first file's cube.
const pfPlan = await ifacePool.readCasePlan(PF_FILE);
const ccPlan = await ifacePool.readCasePlan(CC_FILE);
const INTERFACE_RETAINED = ifacePool.unionOf([pfPlan, ccPlan]);
const interfaceParser = await ifaceBlock.instantiateParser(interfaceWasm);

function ingestInterface(bytes, plan) {
  const columnPlan = ifaceHeader.buildColumnPlan(plan.header, INTERFACE_RETAINED);
  // One layout per file, sized against the instance's budget, exactly as the
  // pool does it.
  const layout = ifacePool.layoutFor(interfaceParser.budget, columnPlan);
  const accumulator = ifacePool.createAccumulator(columnPlan);
  for (const [from, to] of wholeRowRanges(bytes, plan.dataStart, 2048)) {
    ifacePool.blitBlock(
      accumulator,
      ifaceBlock.parseBytes(
        interfaceParser,
        layout,
        bytes,
        from,
        to,
        columnPlan.activePlanes,
        plan.year,
      ),
    );
  }
  return ifacePool.finalizeCase(
    accumulator,
    ifacePool.caseNameOf(plan.file.name),
    plan.header.entityNames,
    plan.year,
    plan.title,
  );
}

const pfTable = ingestInterface(PF_CSV, pfPlan).data;
const ccTable = ingestInterface(CC_CSV, ccPlan).data;

await check('the three files ingest into three tables with real, mixed presence bitmaps', () => {
  // Area: the axis carries the ghost first, then every area the scan found.
  assert.equal(areaAxis[0], GHOST_AREA);
  assert.deepEqual(
    areaAxis.slice(1).sort(),
    [...AREAS].sort(),
    'every area in the file is on the axis',
  );
  assert.deepEqual(areaDerivedWarnings, [], 'no calculated column is retained in this batch');

  assert.deepEqual(areaTable.areas, areaAxis);
  assert.deepEqual(areaTable.metrics, AREA_RETAINED);
  assert.deepEqual(areaTable.sourceColumns, areaPlan.header.metricNames);
  assert.equal(areaTable.year, YEAR);
  assert.equal(areaTable.cube.length, areaAxis.length * AREA_RETAINED.length * HOURS);
  assert.equal(areaTable.presence.length, areaAxis.length * AREA_RETAINED.length);

  const metricCount = AREA_RETAINED.length;
  const absentMetric = metricCount - 1;
  // The ghost area was never seen, so every one of its planes is absent...
  for (let m = 0; m < metricCount; m++) {
    assert.equal(areaTable.presence[0 * metricCount + m], 0, 'ghost area plane is absent');
  }
  // and the retained column no export carried is absent for every area.
  for (let a = 0; a < areaAxis.length; a++) {
    assert.equal(areaTable.presence[a * metricCount + absentMetric], 0, 'absent metric plane');
  }
  // A bitmap that came back all-zero would satisfy both loops above and prove
  // nothing, so state the present planes too, and that they hold real numbers.
  const realPlane = 1 * metricCount + 0;
  assert.equal(areaTable.presence[realPlane], 1, 'a real (area, metric) plane is present');
  assert.ok(Number.isFinite(areaTable.cube[realPlane * HOURS]), 'and carries a finite value');
  assert.ok(Number.isNaN(areaTable.cube[absentMetric * HOURS]), 'the absent plane is NaN, not 0');
  assert.ok(
    areaFinal.warnings.some((w) => w.includes(ABSENT_METRIC)),
    'a retained column this export lacks is stated, not silent',
  );

  // TOU is read from the file's own TOU column and never recomputed. Two
  // consecutive hours carry different labels in the fixture, and hour 3 is not
  // covered at all, so a derived HE-window rule could not produce this array.
  assert.equal(TOU_LABELS[areaTable.tou[0]], 'OffPeak');
  assert.equal(TOU_LABELS[areaTable.tou[1]], 'OnPeak');
  assert.equal(areaTable.tou[2], 0xff, 'an hour with no row is 0xFF, not a guessed TOU code');

  // Interface: one union axis, two different coverages of it.
  assert.deepEqual(pfTable.interfaces, INTERFACE_RETAINED);
  assert.deepEqual(ccTable.interfaces, INTERFACE_RETAINED);
  assert.deepEqual(INTERFACE_RETAINED, [...PF_NAMES, ...CC_NAMES.slice(4)]);
  assert.deepEqual([...pfTable.presence], [1, 1, 1, 1, 1, 1, 0, 0]);
  assert.deepEqual([...ccTable.presence], [0, 0, 1, 1, 1, 1, 1, 1]);
  assert.ok(Number.isNaN(pfTable.cube[6 * HOURS]), 'a path this export does not monitor is NaN');
  assert.ok(Number.isFinite(pfTable.cube[0]), 'a path it does monitor carries a finite value');

  // The two quantities, and the two UNITS derived from them: this is the
  // cross-unit mix one Case is allowed to hold.
  assert.equal(pfTable.quantity, PF_QUANTITY);
  assert.equal(pfTable.unit, 'MW');
  assert.equal(ccTable.quantity, CC_QUANTITY);
  assert.equal(ccTable.unit, '$');
});

// ----------------------------------------------------------- 4. the CaseStore

const store = new CaseStore();
const study = store.createCase(CASE_NAME);
const TABLES = [
  { plan: plans[0], data: areaTable },
  { plan: plans[1], data: pfTable },
  { plan: plans[2], data: ccTable },
];
for (const { plan, data } of TABLES) {
  store.attachTable(study.id, { kind: plan.kind, variant: plan.variant }, data);
}

const AREA_SLOT = slotKey({ kind: 'area' });
const PF_SLOT = slotKey({ kind: 'interface', variant: PF_QUANTITY });
const CC_SLOT = slotKey({ kind: 'interface', variant: CC_QUANTITY });

await check('one Case holds one Area table and TWO Interface tables, in distinct slots', () => {
  assert.equal(store.listCases().length, 1, 'three files, one Case');

  const areas = store.tablesOfKind('area');
  assert.equal(areas.length, 1);
  assert.equal(areas[0].caseId, study.id);
  assert.equal(areas[0].slotKey, AREA_SLOT);

  const interfaces = store.tablesOfKind('interface');
  assert.equal(
    interfaces.length,
    2,
    'both quantities are separate tables, not one replacing the other',
  );
  assert.deepEqual(new Set(interfaces.map((t) => t.caseId)), new Set([study.id]));
  assert.deepEqual(interfaces.map((t) => t.slotKey).sort(), [CC_SLOT, PF_SLOT].sort());
  assert.notEqual(interfaces[0].slotKey, interfaces[1].slotKey);
  assert.deepEqual(
    interfaces.map((t) => t.data.quantity).sort(),
    [CC_QUANTITY, PF_QUANTITY].sort(),
  );

  // The slot is the Interface UI's unit, so attaching the second quantity must
  // not have overwritten the first: prove it on the CUBES, not the labels.
  const byQuantity = new Map(interfaces.map((t) => [t.data.quantity, t.data]));
  assert.ok(
    !bytesOf(byQuantity.get(PF_QUANTITY).cube).equals(bytesOf(byQuantity.get(CC_QUANTITY).cube)),
  );
});

// -------------------------------------------------------- 5. save -> bytes
//
// `buildManifest(store.listCases(), ...)` is exactly what `saveAll` writes;
// section 10 keeps `saveAll` on this input.

const { manifest, cubes } = buildManifest(store.listCases(), { groupings: GROUPINGS_CSV });

/** The .gvmb byte layout `downloadBundle` writes: magic, uint32 LE manifest
 * length, manifest JSON, then every cube in manifest order. */
function bundleBytes(magic, manifestObject, chunks) {
  const json = new TextEncoder().encode(JSON.stringify(manifestObject));
  const head = new Uint8Array(magic.length + 4);
  head.set(new TextEncoder().encode(magic));
  new DataView(head.buffer).setUint32(magic.length, json.byteLength, true);
  return Buffer.concat([
    Buffer.from(head),
    Buffer.from(json),
    ...chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
  ]);
}

/** The OPFS reader's shape: one ArrayBuffer per CASE, sliced by the only
 * field storage-worker.ts can see. */
function toCaseBlocks(wire, chunks) {
  const all = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
  );
  let offset = 0;
  return wire.cases.map((entry) => {
    const block = all.subarray(offset, offset + entry.cubeBytes);
    offset += entry.cubeBytes;
    return block.buffer.slice(block.byteOffset, block.byteOffset + block.byteLength);
  });
}

const BUNDLE = bundleBytes('GVMB', manifest, cubes);

await check('the v3 manifest carries all three slots, the mapping, and no cube', () => {
  assert.equal(manifest.version, BUNDLE_VERSION);
  assert.equal(manifest.cases.length, 1);
  const entry = manifest.cases[0];
  assert.equal(entry.id, study.id, 'the synthetic Case id travels with the bundle');
  assert.equal(entry.name, CASE_NAME);
  assert.deepEqual(Object.keys(entry.tables).sort(), [AREA_SLOT, CC_SLOT, PF_SLOT].sort());
  assert.equal(entry.tables[PF_SLOT].variant, PF_QUANTITY);
  assert.equal(entry.tables[CC_SLOT].variant, CC_QUANTITY);
  assert.equal(entry.tables[AREA_SLOT].variant, undefined);
  assert.ok(Object.values(entry.tables).every((t) => !('cube' in t)));
  assert.equal(
    entry.cubeBytes,
    Object.values(entry.tables).reduce((sum, t) => sum + t.cubeBytes, 0),
  );
  assert.equal(manifest.groupings, GROUPINGS_CSV);
  // The manifest must survive a real JSON round trip -- a raw Uint8Array
  // bitmap would come back as {"0":1,"1":0,...} and every presence check
  // below would then be reading an object, not bytes.
  assert.deepEqual(JSON.parse(JSON.stringify(manifest)), manifest);
});

// -------------------------------------------------------- 6. bytes -> load

const bundleFile = new File([BUNDLE], 'study-2036.gvmb');
const loaded = await readBundleFile(bundleFile);

await check(
  'a dropped .gvmb is recognized and read back through the real file reader',
  async () => {
    const bundleBytes = new Uint8Array(await bundleFile.arrayBuffer());
    assert.equal(classify(bundleBytes, bundleFile.name).kind, 'bundle');
    assert.notEqual(classify(new TextEncoder().encode(AREA_CSV), '01_area.csv').kind, 'bundle');
    assert.deepEqual(loaded.warnings, []);
    assert.equal(loaded.restoredCases.length, 1);
    assert.equal(loaded.restoredCases[0].name, CASE_NAME);
    // `restoredCases` is the ONLY view of what a bundle carried. A second,
    // Area-only representation would let a restore drop every other table, so
    // its absence is asserted rather than assumed.
    assert.equal(loaded.cases, undefined, 'the lossy single-table view is gone, not hidden');
  },
);

const restoredCase = loaded.restoredCases[0];

await check('every table round-trips byte-for-byte: cube, presence bitmap and TOU', () => {
  assert.equal(restoredCase.id, study.id);
  assert.equal(restoredCase.name, CASE_NAME);
  assert.equal(restoredCase.tables.size, 3);

  for (const [slot, original] of study.tables) {
    const back = restoredCase.tables.get(slot);
    assert.ok(back, `slot "${slot}" survived the round trip`);
    // Field by field: the store keeps `variant: undefined` while the reader
    // omits it; both give the same slot key, which is what lookups use.
    assert.equal(back.key.kind, original.key.kind);
    assert.equal(back.key.variant, original.key.variant);
    assert.equal(slotKey(back.key), slot);
    assert.ok(bytesOf(back.data.cube).equals(bytesOf(original.data.cube)), `${slot}: cube bytes`);
    assert.ok(
      bytesOf(back.data.presence).equals(bytesOf(original.data.presence)),
      `${slot}: presence bitmap`,
    );
    assert.ok(bytesOf(back.data.tou).equals(bytesOf(original.data.tou)), `${slot}: TOU array`);
    assert.ok(back.data.presence instanceof Uint8Array);
    assert.ok(back.data.tou instanceof Uint8Array);
    assert.equal(back.data.year, YEAR);
  }

  // Named planes, so a bitmap that came back all-ones (every kernel would then
  // read a NaN plane as real data) fails here rather than passing a length
  // check. Both directions are stated: absent stays 0, present stays 1.
  const backArea = restoredCase.tables.get(AREA_SLOT).data;
  const metricCount = AREA_RETAINED.length;
  assert.equal(backArea.presence[0], 0, 'the ghost area is still absent after the round trip');
  assert.equal(backArea.presence[metricCount - 1], 0, 'the absent metric is still absent');
  assert.equal(backArea.presence[1 * metricCount], 1, 'a real plane is still present');
  assert.ok(Number.isNaN(backArea.cube[(metricCount - 1) * HOURS]), 'and its cube plane is NaN');

  assert.deepEqual([...restoredCase.tables.get(PF_SLOT).data.presence], [1, 1, 1, 1, 1, 1, 0, 0]);
  assert.deepEqual([...restoredCase.tables.get(CC_SLOT).data.presence], [0, 0, 1, 1, 1, 1, 1, 1]);
});

await check('the Area axis round-trips as saved, not re-derived from the global axis', () => {
  const backArea = restoredCase.tables.get(AREA_SLOT).data;
  // The fixture axis must differ from the global one, or dropping `areas`
  // (which falls back to `allAreas()`) would still pass.
  assert.notDeepEqual(areaTable.areas, allAreas(), 'fixture axis must differ from the global axis');
  assert.equal(areaTable.areas.length, allAreas().length + 1);

  assert.deepEqual(backArea.areas, areaTable.areas);
  assert.equal(backArea.areas[0], GHOST_AREA);
  assert.deepEqual(backArea.metrics, AREA_RETAINED);
  assert.deepEqual(backArea.sourceColumns, areaTable.sourceColumns);
});

await check(
  'the two Interface tables come back as two tables, still told apart by quantity',
  () => {
    const pf = restoredCase.tables.get(PF_SLOT).data;
    const cc = restoredCase.tables.get(CC_SLOT).data;
    assert.equal(pf.quantity, PF_QUANTITY);
    assert.equal(pf.unit, 'MW');
    assert.equal(cc.quantity, CC_QUANTITY);
    assert.equal(cc.unit, '$');
    assert.deepEqual(pf.interfaces, INTERFACE_RETAINED);
    assert.deepEqual(cc.interfaces, INTERFACE_RETAINED);
    assert.deepEqual(pf.sourceColumns, PF_NAMES);
    assert.deepEqual(cc.sourceColumns, CC_NAMES);
    assert.ok(!bytesOf(pf.cube).equals(bytesOf(cc.cube)), 'and they are still different data');
  },
);

await check('the groupings mapping survives the round trip verbatim', () => {
  assert.equal(loaded.groupings, GROUPINGS_CSV);
  // The whole mapping, byte for byte.
  assert.ok(loaded.groupings.startsWith('Name,Grouping\n'));
  assert.equal(loaded.groupings.split('\n').filter(Boolean).length, AREAS.length + 1);
});

await check('the OPFS reader and the file reader agree on identical bytes', () => {
  // The OPFS blob carries no magic at all -- it discriminates on
  // `manifest.version` -- so the two paths only meet at `restoreBundle`. Same
  // manifest, same cube bytes, one block per case: the answers must be equal.
  const wire = JSON.parse(JSON.stringify(manifest));
  const viaOpfs = restoreBundle(wire, toCaseBlocks(wire, cubes));
  assert.deepEqual(viaOpfs.warnings, []);
  assert.equal(viaOpfs.groupings, loaded.groupings);
  assert.equal(viaOpfs.restoredCases.length, 1);
  for (const [slot, fromFile] of restoredCase.tables) {
    const fromOpfs = viaOpfs.restoredCases[0].tables.get(slot);
    assert.ok(fromOpfs, `slot "${slot}" is present on the OPFS path too`);
    assert.ok(bytesOf(fromOpfs.data.cube).equals(bytesOf(fromFile.data.cube)));
    assert.ok(bytesOf(fromOpfs.data.presence).equals(bytesOf(fromFile.data.presence)));
  }
});

// --------------------------------------------- 7. the store after a restore

/** A restore: fresh ids, every slot re-attached. Mirrors `adoptRestoredCases`
 * (main.ts cannot load in Node); section 10 holds the real one to it. */
function adopt(cases) {
  const fresh = new CaseStore();
  for (const entry of cases) {
    const created = fresh.createCase(entry.name);
    for (const table of entry.tables.values()) fresh.attachTable(created.id, table.key, table.data);
  }
  return fresh;
}

const restoredStore = adopt(loaded.restoredCases);
const restoredId = restoredStore.listCases()[0].id;

await check('after the restore, one Case still owns one Area slot and two Interface slots', () => {
  assert.equal(restoredStore.listCases().length, 1);
  assert.equal(restoredStore.tablesOfKind('area').length, 1);
  assert.equal(restoredStore.tablesOfKind('interface').length, 2);
  for (const row of restoredStore.tablesOfKind('interface')) assert.equal(row.caseId, restoredId);
  assert.deepEqual(
    restoredStore
      .tablesOfKind('interface')
      .map((t) => t.slotKey)
      .sort(),
    [CC_SLOT, PF_SLOT].sort(),
  );
  assert.equal(restoredStore.tablesOfKind('attribute').length, 0, 'the seam kind has no tables');
});

await check(
  'detaching ONE Interface slot leaves the other Interface table and the Area table',
  () => {
    const before = restoredStore.tablesOfKind('interface').find((t) => t.slotKey === CC_SLOT).data;
    restoredStore.detachTable(restoredId, { kind: 'interface', variant: PF_QUANTITY });

    const interfaces = restoredStore.tablesOfKind('interface');
    assert.equal(interfaces.length, 1, 'removing one quantity must not remove the other');
    assert.equal(interfaces[0].slotKey, CC_SLOT);
    assert.equal(interfaces[0].data.quantity, CC_QUANTITY);
    // Untouched, on the bytes -- a survivor whose cube had been swapped or
    // NaN-filled would still pass a slot-key-only check.
    assert.ok(bytesOf(interfaces[0].data.cube).equals(bytesOf(before.cube)));
    assert.ok(bytesOf(interfaces[0].data.presence).equals(bytesOf(ccTable.presence)));

    const areas = restoredStore.tablesOfKind('area');
    assert.equal(areas.length, 1, 'and must not touch the Area table on the same Case');
    assert.ok(bytesOf(areas[0].data.cube).equals(bytesOf(areaTable.cube)));
    assert.ok(bytesOf(areas[0].data.presence).equals(bytesOf(areaTable.presence)));
    assert.equal(restoredStore.listCases()[0].name, CASE_NAME, 'the Case itself is still here');
  },
);

// --------------------------------------------------------- 8. section state

await check('each section reads its own kind: one going empty does not clear the other', () => {
  // The retained set each section holds is the batch-wide decision made at
  // ingest time, carried forward -- not re-derived per drop.
  const areaSection = createSectionState('area');
  const interfaceSection = createSectionState('interface');
  areaSection.setRetained(AREA_RETAINED);
  interfaceSection.setRetained(INTERFACE_RETAINED);

  for (const section of [areaSection, interfaceSection]) section.noteTablesChanged(restoredStore);
  assert.equal(restoredStore.tablesOfKind('area').length > 0, true);
  assert.equal(restoredStore.tablesOfKind('interface').length > 0, true);
  assert.deepEqual(interfaceSection.retainedColumns, INTERFACE_RETAINED);

  // Detach the LAST Interface table. The interface state clears; the area
  // state, on the very same Case, must not notice.
  restoredStore.detachTable(restoredId, { kind: 'interface', variant: CC_QUANTITY });
  for (const section of [areaSection, interfaceSection]) section.noteTablesChanged(restoredStore);
  assert.equal(restoredStore.tablesOfKind('interface').length > 0, false);
  assert.equal(interfaceSection.retainedColumns, null);
  assert.equal(
    restoredStore.tablesOfKind('area').length > 0,
    true,
    'the Area table is still loaded',
  );
  assert.deepEqual(areaSection.retainedColumns, AREA_RETAINED, 'so its picker choice stands');
});

// ------------------------------------------------------- 9. a legacy bundle
//
// A legacy .gvap built from the same ingested Area table in v1's manifest
// shape, read through `readBundleFile`: magic dispatch, migration and cube
// slicing on real bytes.

const legacyManifest = {
  version: 1,
  groupings: GROUPINGS_CSV,
  cases: [
    {
      name: 'Legacy Base Case',
      year: areaTable.year,
      metrics: areaTable.metrics,
      sourceColumns: areaTable.sourceColumns,
      areas: areaTable.areas,
      presence: Buffer.from(areaTable.presence).toString('base64'),
      tou: Buffer.from(areaTable.tou).toString('base64'),
      cubeBytes: areaTable.cube.byteLength,
    },
  ],
};
const legacyFile = new File(
  [bundleBytes('GVAP', legacyManifest, [bytesOf(areaTable.cube)])],
  'old-study.gvap',
);
const legacyLoaded = await readBundleFile(legacyFile);

await check('a legacy GVAP file still migrates and loads, bitmaps and mapping intact', () => {
  assert.deepEqual(legacyLoaded.warnings, [
    'Migrated a version-1 (Area-only) bundle to version 3 as it loaded. The original was left ' +
      'untouched — save again to keep this study in the current format.',
  ]);
  assert.equal(legacyLoaded.restoredCases.length, 1);

  const migrated = legacyLoaded.restoredCases[0];
  assert.equal(migrated.name, 'Legacy Base Case');
  assert.equal(migrated.tables.size, 1, 'v1 held exactly one table per case');
  const table = migrated.tables.get(AREA_SLOT);
  assert.ok(table, 'and it lands in the Area slot, with no variant');
  assert.equal(table.key.variant, undefined);

  assert.ok(bytesOf(table.data.cube).equals(bytesOf(areaTable.cube)), 'cube bytes');
  assert.ok(bytesOf(table.data.presence).equals(bytesOf(areaTable.presence)), 'presence bitmap');
  assert.ok(bytesOf(table.data.tou).equals(bytesOf(areaTable.tou)), 'TOU array');
  assert.deepEqual(table.data.areas, areaTable.areas, 'the saved axis, not the global one');
  assert.equal(table.data.presence[0], 0, 'the absent planes are still absent after migration');

  // v1 carried the mapping too, and it must land in v3's top-level field.
  assert.equal(legacyLoaded.groupings, GROUPINGS_CSV);

  // Adopting it gives area tables and no interface table at all -- the
  // "show only what is loaded" property, from a real legacy file.
  const legacyStore = adopt(legacyLoaded.restoredCases);
  assert.equal(legacyStore.tablesOfKind('area').length > 0, true);
  assert.equal(legacyStore.tablesOfKind('interface').length > 0, false);
});

// ------------------------------------------- 10. the app's own save/restore
//
// main.ts cannot load under Node, so its save/restore wiring is read from the
// source (as test_dom_contract.mjs does) to prove it uses the paths tested
// above. Each property below guards a real failure shape:

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const MAIN_TS = read('src/main.ts');

/** One top-level function's CODE, up to the next column-0 `}`, with
 * whole-line comments dropped so prose cannot satisfy a check. */
function bodyOf(signature) {
  const start = MAIN_TS.indexOf(signature);
  assert.notEqual(start, -1, `src/main.ts no longer contains \`${signature}\``);
  const end = MAIN_TS.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `could not find the end of \`${signature}\``);
  return MAIN_TS.slice(start, end)
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join('\n');
}

/** A top-level object literal's CODE, up to the first `close` after it. */
function blockOf(signature, close) {
  const start = MAIN_TS.indexOf(signature);
  assert.notEqual(start, -1, `src/main.ts no longer contains \`${signature}\``);
  const end = MAIN_TS.indexOf(close, start);
  assert.notEqual(end, -1, `could not find the end of \`${signature}\``);
  return MAIN_TS.slice(start, end)
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join('\n');
}

/** How many times `needle` appears in `haystack`. */
function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

await check('saveAll saves the whole store, not the Area tables in it', () => {
  const body = bodyOf('async function saveAll(');
  assert.match(body, /caseStore\.listCases\(\)/, 'the writers are handed every Case');
  assert.doesNotMatch(
    body,
    /areaCases\(\)/,
    'filtering to Area here is what dropped every Interface table from the .gvmb and OPFS',
  );
  // And the refusal counts TABLES: guarding on the Area count refused to save
  // a study made only of Interface tables, saying "drop a CSV export first"
  // about files the user had already dropped.
  assert.match(body, /entry\.tables\.size/, 'the "nothing to save" guard counts tables');
});

await check('the restore path reads restoredCases and every slot on them', () => {
  const adoptBody = bodyOf('function adoptRestoredCases(');
  assert.match(adoptBody, /entry\.tables\.values\(\)/, 'every slot is re-attached');
  assert.doesNotMatch(
    adoptBody,
    /AREA_SLOT/,
    'attaching only the Area slot is what silently discarded restored Interface tables',
  );
  for (const signature of ['async function restoreBundleFile(', 'async function loadAll(']) {
    const body = bodyOf(signature);
    assert.match(body, /loaded\.restoredCases/, `${signature} restores every table kind`);
    // Unknown-kind and migration notices must reach the user whether the
    // restore was taken up or refused.
    assert.ok(
      occurrences(body, 'loaded.warnings') >= 2,
      `${signature} surfaces the load's warnings on both outcomes, not just one`,
    );
  }
});

await check('a restore builds the replacement before it removes anything', () => {
  const body = bodyOf('function adoptRestoredCases(');
  // An unreadable bundle is refused (falsy) before anything is removed, never
  // "Restored 0 case(s)" over a wiped study.
  assert.match(body, /if \(tableCount === 0\) return (false|null);/, 'an empty restore is refused');
  // And the ordering: the new Cases exist before a single old one is removed,
  // so a throw part-way leaves the loaded study in the store.
  assert.ok(
    body.indexOf('createCase(') < body.indexOf('removeCase('),
    'the swap commits only once every restored table has been attached',
  );
});

await check('a drop reads as running from the first byte to the last table', () => {
  // The busy floor keeps the app looking busy between batches:
  //   1. setBusy falls back to the floor, not to nothing;
  //   2. loadFiles clears it in a `finally`, so a throw cannot leave it on.
  const setBusyBody = bodyOf('function setBusy(');
  assert.match(
    setBusyBody,
    /busy = message \?\? busyFloor;/,
    'setBusy(null) falls back to the drop-long floor, not to an idle chrome',
  );
  const loadBody = bodyOf('async function loadFiles(');
  assert.match(loadBody, /setBusyFloor\(/, 'loadFiles holds the busy line for the whole drop');
  const finallyAt = loadBody.lastIndexOf('} finally {');
  assert.ok(
    finallyAt >= 0 && loadBody.indexOf('setBusyFloor(null)', finallyAt) > finallyAt,
    'the floor is dropped in a finally: a drop that throws must not leave the busy bar running',
  );
  // And the chrome has to be TOLD, because a busy message is not tellable from
  // an idle status sentence by reading it -- and on a narrow window the status
  // bar is display:none, where the sentence is no signal at all.
  const renderBody = blockOf('  chrome.render({', '\n  });');
  assert.match(renderBody, /busy: busy !== null/, 'the chrome is told whether a load is running');
});

await check('one commit site serves every ingest, and it replaces', () => {
  // Both engines attach through one host, which must replace: a confirmed
  // `replacesExisting` would otherwise throw and drop every later table.
  const host = blockOf('const ingestHost: IngestHost = {', '\n};');
  assert.match(host, /replace: true/, "the ingest host passes the user's confirmed replace");

  // No engine reaches the store itself. An engine that did would be a second
  // commit site this check cannot see.
  for (const file of ['src/app/ingest-wide.ts', 'src/app/ingest-long.ts', 'src/app/batch.ts']) {
    // Comments dropped, because `IngestHost` documents itself by naming the
    // store method it stands in front of, and a scan that read the prose would
    // fail on the explanation instead of on a violation.
    const code = read(file)
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
      .join('\n');
    assert.doesNotMatch(
      code,
      /attachTable/,
      `${file} must attach through the host, not reach the CaseStore`,
    );
    assert.doesNotMatch(
      code,
      /inventory/i,
      `${file} must report through the host and its outcome, not record in the inventory`,
    );
  }

  // The other `attachTable` calls: the host, the axis reindex (replaces a
  // table with itself), and the restore, which must NOT replace (two tables
  // for one slot in a bundle is a refusal).
  assert.equal(
    occurrences(MAIN_TS, 'caseStore.attachTable('),
    3,
    'a new attachTable site in main.ts has to state its own replace policy here',
  );

  // The host's attach is where the root learns a table's source files, so it
  // is the one place ingest is recorded. Axis widening re-attaches every Area
  // table to the store directly: through the host it would record each table
  // again as if its files had just been loaded.
  assert.match(
    host,
    /attach\(caseId, slot, table, sources\)/,
    'the host is handed the files behind each table',
  );
  assert.match(
    host,
    /inventory\.recordTable\(caseId, slot, sources\)/,
    'the host records each attached table in the inventory',
  );
  assert.equal(
    occurrences(MAIN_TS, 'inventory.recordTable('),
    1,
    'tables are recorded at the ingest host only',
  );
  // A drop's accepted files are logged as one event when the drop ends, so
  // the drop is closed on every exit, a throw included.
  const load = bodyOf('async function loadFiles(');
  const finallyAt = load.lastIndexOf('} finally {');
  assert.ok(
    load.indexOf('inventory.beginDrop()') > 0 && load.indexOf('inventory.beginDrop()') < finallyAt,
    'loadFiles opens a drop in the inventory',
  );
  assert.ok(
    load.indexOf('inventory.endDrop()', finallyAt) > finallyAt,
    'loadFiles closes the drop in its finally',
  );
  // A group file loaded in an editor is recorded on Apply, after the
  // membership is adopted, for every kind; a cancel returns first.
  for (const [opener, apply] of [
    ['function openGeneratorGroupEditor(', 'applyGeneratorMembership(edit.value)'],
    ['function openBusGroupEditor(', 'applyBusMembership(edit.value)'],
    ['function openInterfaceGroupEditor(', 'applyInterfaceMembership(edit.value)'],
  ]) {
    const body = bodyOf(opener);
    const cancelAt = body.indexOf('if (edit === null) return;');
    const applyAt = body.indexOf(apply);
    const recordAt = body.indexOf('recordEditorGroups(');
    assert.ok(
      cancelAt > 0 && cancelAt < applyAt && applyAt < recordAt,
      `${opener} records the editor's file after Apply adopts it, never on cancel`,
    );
  }
  {
    const area = MAIN_TS.indexOf('showGroupEditor({ present: presentAreas() })');
    const tail = MAIN_TS.slice(area, MAIN_TS.indexOf('render();', area));
    assert.ok(
      tail.indexOf('if (csv === null) return;') < tail.indexOf('applyGroupings(csv.value)') &&
        tail.indexOf('applyGroupings(csv.value)') < tail.indexOf("recordEditorGroups('area'"),
      "the Area editor's file is recorded after its groupings apply",
    );
  }
  const widen = bodyOf('function adoptAxis(');
  assert.match(widen, /caseStore\.attachTable\(/);
  assert.doesNotMatch(widen, /ingestHost|sources|inventory/, 'axis widening records nothing');
});

await check('the hourly export reaches app state only through its host', () => {
  // A sequence in src/app/ that imported a store would be the root with extra
  // steps: the export resolves, sets busy and yields through the host main.ts
  // implements, and never holds a Case itself.
  const code = read('src/app/hourly-export.ts')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join('\n');
  const imports = [...code.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(
    imports.filter((path) => /store|case-model|main|storage|limits|lookups|tables\//.test(path)),
    [],
    'the export sequence imports no store',
  );
  assert.doesNotMatch(code, /caseStore|attachTable|listCases/);
  assert.match(
    MAIN_TS,
    /resolve: \(ref\) => resolveDraw\(exportContext,/,
    'the root resolves an exported row through the draw, into the export context',
  );
  assert.match(MAIN_TS, /lines: createScratchPool\(\)/, 'the export context has a one-set pool');
});

console.log(`\n${checks} integration checks passed.`);
