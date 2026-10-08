// tests/test_case_span.mjs — one Case is one run of years, and a picker
// prices every year of it.
//
//   1. A drop of the generated mixed-range pair onto one Case attaches the
//      first table and refuses the other before it attaches, naming both
//      spans; the refused file is logged, never recorded.
//   2. A file of another span dropped onto a loaded Case is refused the same
//      way; one of the Case's span attaches; a replace of a Case's only table
//      takes the new span, and a replace beside another table may not.
//   3. Inside one batch, a second table for the same Case is held to the
//      first's span; the files of one merge group span their union; a long
//      file replaces only the metric tables its picker keeps.
//   4. The Import Dialog says so for a wide file, whose date line states its
//      years before ingest; a long file's years wait for its scan.
//   5. A cube's cost names its years: three years cost three times one.
//
// The drop runs through the real `createDropLoad`, `createIngestKinds`, Case
// store, `heldSpan` and inventory. The wide headers are read by the real
// reader; the long scan and both parses are scripted, because the pools'
// Workers do not run under Node.
//
// Run: node tests/test_case_span.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import './test_loader.mjs';

const { generate } = await import('../scripts/make-sample-data.mjs');
const { createDropLoad } = await import('../src/app/drop-load.ts');
const { createIngestKinds } = await import('../src/app/ingest-kinds.ts');
const { createWideIngest } = await import('../src/app/ingest-wide.ts');
const { createEntityLongIngest } = await import('../src/app/ingest-long.ts');
const { createCaseViews } = await import('../src/app/case-views.ts');
const { planImports } = await import('../src/app/import-plan.ts');
const { CaseStore, caseForName } = await import('../src/model/case-model.ts');
const { createInventory } = await import('../src/inventory/store.ts');
const { cubeCost } = await import('../src/ingest.ts');
const { classify, DETECT_PROBE_BYTES } = await import('../src/detect.ts');
const areaWide = await import('../src/tables/area/wide.ts');
const longPool = await import('../src/tables/long/pool.ts');

let passed = 0;
async function check(label, fn) {
  await fn();
  passed++;
  console.log(`ok - ${label}`);
}

/** The years a long file's rows are dated in, as the scan would count them. */
async function yearsOfRows(file) {
  const years = (await file.text())
    .split('\n')
    .slice(1)
    .filter((line) => line.trim() !== '')
    .map((line) => Number(line.split(',', 1)[0].split('/')[2]));
  const firstYear = Math.min(...years);
  return { firstYear, numYears: Math.max(...years) - firstYear + 1 };
}

/** A session: a real store, views and inventory behind a drop host whose
 * Import Dialog puts every file on `caseName`. */
function session() {
  const store = new CaseStore();
  const views = createCaseViews(store);
  const inventory = createInventory(() => 0);
  const said = new Map();
  const gate = { resolveRetained: async (_store, batch) => batch.union };
  const kinds = createIngestKinds({
    attach: {
      setBusy() {},
      caseIdForName: (name) => (caseForName(store.listCases(), name) ?? store.createCase(name)).id,
      attach(caseId, slot, table, sources) {
        store.attachTable(caseId, slot, table, { replace: true });
        inventory.recordTable(caseId, slot, sources);
      },
      heldSpan: views.heldSpan,
    },
    cases: store,
    retainGates: { area: gate, bus: gate, generator: gate, interface: gate },
    keepsEverything: () => false,
    areaAxis: () => [],
    adoptAxis() {},
    refresh() {},
    pickMetrics: async ({ union }) => union,
    readers: {
      area: {
        ...areaWide,
        hasSimd: () => true,
        // Each plan its own table, carrying the span its header states.
        async ingest(plans) {
          return {
            cases: plans.map((plan) => ({ firstYear: plan.firstYear, numYears: plan.numYears })),
            ok: plans.map((_, i) => i),
            warnings: [],
            failures: [],
          };
        },
      },
      long: {
        ...longPool,
        hasSimd: () => true,
        async discoverEntities(plans) {
          for (const plan of plans) {
            Object.assign(plan, await yearsOfRows(plan.file), { entities: ['SAMPLE_E1'] });
          }
          return { ok: plans.map((_, i) => i), failures: [] };
        },
        async ingest(plans, retained) {
          return {
            cases: plans.map((plan) =>
              retained.map((quantity) => ({
                quantity,
                firstYear: plan.firstYear,
                numYears: plan.numYears,
              })),
            ),
            ok: plans.map((_, i) => i),
            warnings: [],
            failures: [],
          };
        },
      },
    },
  });
  let caseName = 'SAMPLE_MIX';
  const drop = createDropLoad({
    inventory,
    say: (channel, lines) => said.set(channel, [...lines]),
    render() {},
    setBusyFloor() {},
    downloadRunning: () => false,
    closeContents() {},
    listCases: () => store.listCases(),
    restoreBundle: async () => [],
    askGroupings: async () => null,
    loadGroupings: () => [],
    kindLabel: (kind) => kind,
    attachLookup: () => ({ alreadyKnown: 0, note: '' }),
    askImport: async (tables, cases) => ({
      plans: planImports(tables, 'one-case', { caseName, existingCases: cases }),
      limits: [],
      everything: false,
    }),
    ingest: kinds.ingest,
    setSharedLimits: () => null,
    setCaseLimits: () => null,
    limitMatchNotes: () => [],
    refreshCases() {},
    revealDrawer() {},
  });
  return {
    store,
    views,
    inventory,
    said,
    async load(name, files) {
      caseName = name;
      await drop.load(files);
    },
    spanOf: (name) => views.spanOfCase(caseForName(store.listCases(), name).id),
    slotsOf: (name) => [...caseForName(store.listCases(), name).tables.keys()],
    recorded: () => [...inventory.snapshot().records.values()].map((record) => record.name),
    log: () => inventory.log({ cases: [], rows: [], columns: [] }),
  };
}

const scratch = mkdtempSync(join(tmpdir(), 'gvp-case-span-'));
try {
  await generate({ out: scratch });
  const fileOf = (name) => new File([readFileSync(join(scratch, name))], name);
  const MIXED_REFUSAL =
    "case-mixedrange-bus-long.csv spans 2034-2035, but SAMPLE_MIX's Area table spans " +
    '2034-2036. One Case holds one run of years; load it as its own Case.';

  await check('the mixed-range pair: the second table is refused before it attaches', async () => {
    const s = session();
    const area = fileOf('case-mixedrange-area-wide.csv');
    const bus = fileOf('case-mixedrange-bus-long.csv');
    await s.load('SAMPLE_MIX', [area, bus]);
    assert.deepEqual(s.slotsOf('SAMPLE_MIX'), ['area '], 'only the Area table attached');
    assert.deepEqual(s.spanOf('SAMPLE_MIX'), { firstYear: 2034, numYears: 3 });
    assert.deepEqual(s.said.get('bus'), [MIXED_REFUSAL]);
    assert.deepEqual(
      s.recorded(),
      ['case-mixedrange-area-wide.csv'],
      'the refused file has no record',
    );
    const refused = s.log().filter((line) => line.event === 'refused');
    assert.deepEqual(
      refused.map((line) => [line.reason, line.files.map((file) => file.name)]),
      [[MIXED_REFUSAL, ['case-mixedrange-bus-long.csv']]],
      'the refused file is logged',
    );
  });

  await check('a file dropped onto a loaded Case is held to its span', async () => {
    const s = session();
    await s.load('SAMPLE_MIX', [fileOf('case-mixedrange-area-wide.csv')]);
    await s.load('SAMPLE_MIX', [fileOf('case-mixedrange-bus-long.csv')]);
    assert.deepEqual(s.slotsOf('SAMPLE_MIX'), ['area ']);
    assert.deepEqual(s.said.get('bus'), [MIXED_REFUSAL]);
    assert.ok(!s.recorded().includes('case-mixedrange-bus-long.csv'));

    // The same Case's years attach.
    await s.load('SAMPLE_MIX', [fileOf('bus-long-multiyear.csv')]);
    assert.ok(s.slotsOf('SAMPLE_MIX').length > 1, 'its metric tables attached');
    assert.ok(s.recorded().includes('bus-long-multiyear.csv'));
    assert.deepEqual(s.spanOf('SAMPLE_MIX'), { firstYear: 2034, numYears: 3 });

    // Replacing the Area table beside the Bus tables may not move the span.
    await s.load('SAMPLE_MIX', [fileOf('area-wide.csv')]);
    assert.match(
      s.said.get('area').join(' '),
      /^area-wide\.csv spans 2034, but SAMPLE_MIX's Bus .* table spans 2034-2036\. /,
    );
    assert.deepEqual(s.spanOf('SAMPLE_MIX'), { firstYear: 2034, numYears: 3 });
  });

  await check("a replace of a Case's only table takes the new span", async () => {
    const s = session();
    await s.load('SAMPLE_SOLO', [fileOf('area-wide-multiyear.csv')]);
    assert.deepEqual(s.spanOf('SAMPLE_SOLO'), { firstYear: 2034, numYears: 3 });
    await s.load('SAMPLE_SOLO', [fileOf('area-wide.csv')]);
    assert.deepEqual(s.spanOf('SAMPLE_SOLO'), { firstYear: 2034, numYears: 1 });
    assert.deepEqual(s.slotsOf('SAMPLE_SOLO'), ['area ']);
  });

  await check('the Import Dialog warns of a wide file whose stated years differ', async () => {
    const detectedOf = async (name) => {
      const head = new Uint8Array(await fileOf(name).slice(0, DETECT_PROBE_BYTES).arrayBuffer());
      return { name, detected: classify(head, name) };
    };
    const area = await detectedOf('case-mixedrange-area-wide.csv');
    const bus = await detectedOf('case-mixedrange-bus-long.csv');
    assert.deepEqual(area.detected.years, { firstYear: 2034, numYears: 3 });
    assert.equal(bus.detected.years, undefined, 'a long file states no years in its head');

    const onto = (slotSpans) =>
      planImports([area], 'one-case', {
        caseName: 'SAMPLE_MIX',
        existingCases: [{ name: 'SAMPLE_MIX', occupiedSlots: Object.keys(slotSpans), slotSpans }],
      })[0];
    assert.equal(
      onto({ 'bus LMP': { firstYear: 2034, numYears: 2 } }).spanReason,
      'Spans 2034-2036, but this Case\'s "bus LMP" table spans 2034-2035. One Case holds one ' +
        'run of years, so the load will refuse this file; give it its own Case.',
    );
    assert.equal(onto({ 'bus LMP': { firstYear: 2034, numYears: 3 } }).spanReason, undefined);
    assert.equal(
      onto({ 'area ': { firstYear: 2034, numYears: 2 } }).spanReason,
      undefined,
      'the table it replaces does not hold it',
    );

    const single = await detectedOf('area-wide.csv');
    const pair = planImports(
      [area, { ...single, detected: { ...single.detected, kind: 'bus' } }],
      'one-case',
      {
        caseName: 'SAMPLE_MIX',
      },
    );
    assert.match(
      pair[0].spanReason,
      /^Spans 2034-2036, but "area-wide\.csv", for the same Case, spans 2034\./,
    );
    const mixed = planImports([area, bus], 'one-case', { caseName: 'SAMPLE_MIX' });
    assert.deepEqual(
      mixed.map((plan) => plan.spanReason),
      [undefined, undefined],
      'nothing is said before the long scan',
    );
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// ------------------------------------------------------- 3. inside one batch

/** A wide reader whose plans state the spans in `spans`, by file name. */
function spanReader(spans) {
  return {
    hasSimd: () => true,
    NO_SIMD_MESSAGE: 'no simd',
    async readCasePlan(file) {
      return { file, header: { entityNames: ['E1'] }, ...spans[file.name] };
    },
    async ingest(plans) {
      return {
        cases: plans.map((plan) => ({ name: plan.file.name })),
        ok: plans.map((_, i) => i),
        warnings: [],
        failures: [],
      };
    },
  };
}

function wideRun(spans, held = null) {
  const attached = [];
  const asked = [];
  const run = createWideIngest({
    setBusy() {},
    caseIdForName: (name) => name,
    attach: (caseId, slot, table) => attached.push(table.name),
    heldSpan(caseName, replacing) {
      asked.push(replacing);
      return held;
    },
  });
  const batch = {
    reader: spanReader(spans),
    noun: 'bus',
    plural: 'buses',
    entities: async () => ({ entities: ['E1'] }),
    slot: (drop) => ({ kind: 'bus', variant: drop.variant }),
    refresh() {},
  };
  return { attached, asked, run: (drops) => run(batch, drops) };
}

const file = (name) => ({ name });

await check("a second table for one Case in one batch is held to the first's span", async () => {
  const { attached, run } = wideRun({
    'a.csv': { firstYear: 2034, numYears: 3 },
    'b.csv': { firstYear: 2034, numYears: 2 },
  });
  const outcome = await run([
    { file: file('a.csv'), caseName: 'S', variant: 'LMP' },
    { file: file('b.csv'), caseName: 'S', variant: 'Load' },
  ]);
  assert.deepEqual(attached, ['a.csv']);
  assert.deepEqual(outcome.failures, [
    {
      files: [file('b.csv')],
      note:
        'b.csv spans 2034-2035, but a.csv, in this drop for the same Case, spans 2034-2036. ' +
        'One Case holds one run of years; load it as its own Case.',
    },
  ]);
});

await check('a merge group spans its members together', async () => {
  const held = { span: { firstYear: 2034, numYears: 2 }, holder: "S's Area table" };
  const { attached, asked, run } = wideRun(
    { 'h1.csv': { firstYear: 2034, numYears: 1 }, 'h2.csv': { firstYear: 2035, numYears: 1 } },
    held,
  );
  const outcome = await run([
    { file: file('h1.csv'), caseName: 'S', variant: 'LMP' },
    { file: file('h2.csv'), caseName: 'S', variant: 'LMP' },
  ]);
  assert.deepEqual(outcome.failures, [], '2034 and 2035 together are 2034-2035');
  assert.deepEqual(attached, ['h1.csv', 'h2.csv'], 'both reach the parse');
  assert.deepEqual(
    asked,
    [[{ kind: 'bus', variant: 'LMP' }]],
    'asked once for the group, excusing the slot it replaces',
  );

  const other = wideRun({ 'x.csv': { firstYear: 2034, numYears: 3 } }, held);
  const refused = await other.run([{ file: file('x.csv'), caseName: 'S', variant: 'LMP' }]);
  assert.deepEqual(other.attached, []);
  assert.match(
    refused.failures[0].note,
    /^x\.csv spans 2034-2036, but S's Area table spans 2034-2035\./,
  );
});

await check('a long file may move the span only over the metric tables it replaces', async () => {
  // The Case holds one Bus table, LMP, over 2034-2035. A 2034-2036 file that
  // offers LMP and Load passes before the picker; after it, only a pick that
  // replaces LMP may take the Case's years.
  const heldLmp = (replacing) =>
    replacing.some((slot) => slot.variant === 'LMP')
      ? null
      : { span: { firstYear: 2034, numYears: 2 }, holder: "S's Bus LMP table" };
  const runWith = async (picked) => {
    const attached = [];
    const engine = createEntityLongIngest(
      {
        setBusy() {},
        caseIdForName: (name) => name,
        attach: (caseId, slot) => attached.push(slot.variant),
        heldSpan: (caseName, replacing) => heldLmp(replacing),
      },
      {
        reader: {
          hasSimd: () => true,
          NO_SIMD_MESSAGE: 'no simd',
          readCasePlan: async (file) => ({ file, header: { metricNames: ['LMP', 'Load'] } }),
          async discoverEntities(plans) {
            for (const plan of plans)
              Object.assign(plan, { firstYear: 2034, numYears: 3, entities: ['1'] });
            return { ok: plans.map((_, i) => i), failures: [] };
          },
        },
        union: () => ['LMP', 'Load'],
        axis: () => ['1'],
        noteTablesChanged() {},
        everything: () => false,
        pickMetrics: async () => picked,
        async parse(plans, retained) {
          return {
            cases: plans.map(() => retained.map((quantity) => ({ quantity }))),
            ok: plans.map((_, i) => i),
            warnings: [],
            failures: [],
          };
        },
        refresh() {},
      },
    );
    const outcome = await engine([{ file: file('bus.csv'), caseName: 'S' }], 'bus', {
      sig: { noun: { one: 'bus', many: 'buses' } },
    });
    return { attached, outcome };
  };
  const narrow = await runWith(['Load']);
  assert.deepEqual(narrow.attached, []);
  assert.match(narrow.outcome.failures[0].note, /^bus\.csv spans 2034-2036, but S's Bus LMP table/);
  const whole = await runWith(['LMP', 'Load']);
  assert.deepEqual(whole.outcome.failures, []);
  assert.deepEqual(whole.attached, ['LMP', 'Load']);
});

// ------------------------------------------------------- 4. the cube's cost

await check('a cube costs every year of its span, and says so', () => {
  const buses = [{ count: 1200, one: 'bus', many: 'buses' }];
  const one = cubeCost(buses, 1);
  const three = cubeCost(buses, 3);
  assert.equal(three.bytes, 3 * one.bytes);
  assert.equal(one.bytes, 1200 * 8784 * 4);
  assert.equal(three.arithmetic, '1,200 buses × 3 years × 8,784 h × 4 B = 121 MB');
  assert.equal(one.arithmetic, '1,200 buses × 1 year × 8,784 h × 4 B = 40 MB');
  assert.equal(
    cubeCost([{ count: 2, one: 'metric', many: 'metrics' }, ...buses], 3).arithmetic,
    '2 metrics × 1,200 buses × 3 years × 8,784 h × 4 B = 241 MB',
  );
});

console.log(`\n${passed} case-span checks passed.`);
