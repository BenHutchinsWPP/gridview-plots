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
//   4. The Import Dialog blocks a file the load would refuse for its years:
//      a wide file by its date line, a long file by its sampled rows, which
//      prove a span only when they run in date order. Only the tables that
//      differ from the Case's span are marked, each with the Case that
//      clears it; files merged into one table are judged per run of years.
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
const { sampleYears } = await import('../src/tables/long/sample-years.ts');
const { CaseStore, caseForName } = await import('../src/model/case-model.ts');
const { createInventory } = await import('../src/inventory/store.ts');
const { cubeCost, megabytes } = await import('../src/ingest.ts');
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

  await check('the Import Dialog blocks a file whose years the load would refuse', async () => {
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
    const onLoaded = onto({ 'bus LMP': { firstYear: 2034, numYears: 2 } });
    assert.equal(onLoaded.spanReason, 'The rest of this Case is 2034-2035.', 'said short');
    assert.equal(
      onLoaded.spanDetail,
      'Spans 2034-2036, but this Case\'s loaded "bus LMP" table spans 2034-2035. One Case ' +
        'holds one run of years, so the load will refuse this file; give it its own Case.',
      'and whole on hover',
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
    assert.equal(pair[0].spanConflict, false, 'the first table sets the Case span');
    assert.equal(pair[1].spanConflict, true, 'the other is blocked');
    assert.match(
      pair[1].spanDetail,
      /^Spans 2034, but "case-mixedrange-area-wide\.csv", for the same Case, spans 2034-2036\./,
    );
    assert.equal(pair[1].splitTo, 'SAMPLE_MIX_2034', 'its fix is a Case of its own years');
    assert.deepEqual(
      planImports(
        [area, { ...single, detected: { ...single.detected, kind: 'bus' } }],
        'individual',
        {
          overrides: { 0: { caseName: 'SAMPLE_MIX' }, 1: { caseName: pair[1].splitTo } },
        },
      ).map((plan) => plan.spanConflict),
      [false, false],
      'which clears it',
    );

    const mixed = planImports([area, bus], 'one-case', { caseName: 'SAMPLE_MIX' });
    assert.deepEqual(
      mixed.map((plan) => plan.spanConflict),
      [false, false],
      'an unsampled long file is not judged',
    );
    const busFile = fileOf('case-mixedrange-bus-long.csv');
    const sampled = sampleYears(new Uint8Array(await busFile.arrayBuffer()), null);
    assert.deepEqual(sampled, { ...(await yearsOfRows(busFile)), whole: true });
    const withSample = planImports([area, { ...bus, sampled }], 'one-case', {
      caseName: 'SAMPLE_MIX',
    });
    assert.deepEqual(withSample[1].years, sampled, 'the row shows the sampled years');
    assert.equal(withSample[1].sampled, true);
    assert.deepEqual(sampled, { firstYear: 2034, numYears: 2, whole: true });
    assert.equal(withSample[1].spanConflict, true, 'a long file read whole is judged by its span');
    assert.match(withSample[1].spanDetail, /^Its first and last rows are dated 2034-2035, but/);
    assert.equal(withSample[1].splitTo, 'SAMPLE_MIX_2034-2035');

    // An unordered sample proves only the years it shows.
    const seen = (firstYear, numYears) => ({
      ...bus,
      sampled: { firstYear, numYears, whole: false },
    });
    const inside = planImports([area, seen(2035, 1)], 'one-case', { caseName: 'SAMPLE_MIX' });
    assert.equal(inside[1].spanConflict, false, 'a year inside the span may be all it shows');
    const outside = planImports([area, seen(2035, 11)], 'one-case', { caseName: 'SAMPLE_MIX' });
    assert.equal(outside[1].spanConflict, true, 'a year outside it is certain');
    assert.match(outside[1].spanDetail, /^Its sampled rows are dated 2035-2045, but/);

    // Files merged into one table that skip years are judged per run: the
    // later run differs from the Case, and moves like any other table.
    const year = (firstYear) => ({
      ...area,
      name: `area-${firstYear}.csv`,
      detected: { ...area.detected, years: { firstYear, numYears: 1 } },
    });
    const gap = planImports([year(2035), year(2045)], 'one-case', { caseName: 'SAMPLE_GAP' });
    assert.deepEqual(
      gap.map((plan) => [plan.merges, plan.spanConflict, plan.splitTo]),
      [
        [true, false, undefined],
        [true, true, 'SAMPLE_GAP_2045'],
      ],
    );
    assert.equal(gap[1].spanReason, 'The rest of this Case is 2035.');
    // The Case keeps the span most of its tables state; the rest move off.
    const kindYear = (kind, firstYear) => ({
      ...year(firstYear),
      name: `${kind}-${firstYear}.csv`,
      detected: { ...year(firstYear).detected, kind },
    });
    const most = planImports(
      [kindYear('area', 2045), kindYear('bus', 2035), kindYear('generator', 2035)],
      'one-case',
      { caseName: 'SAMPLE_STUDY' },
    );
    assert.deepEqual(
      most.map((plan) => [plan.spanConflict, plan.splitTo]),
      [
        [true, 'SAMPLE_STUDY_2045'],
        [false, undefined],
        [false, undefined],
      ],
      'the one 2045 table moves, though it is first',
    );

    const run = planImports([year(2035), year(2036)], 'one-case', { caseName: 'SAMPLE_GAP' });
    assert.deepEqual(
      run.map((plan) => plan.spanConflict),
      [false, false],
      'two years in a row merge as one table',
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
  assert.equal(three.arithmetic, '1,200 buses × 3 years × 8,784 h × 4 B = 126 MB');
  assert.equal(one.arithmetic, '1,200 buses × 1 year × 8,784 h × 4 B = 42 MB');
  assert.equal(
    cubeCost([{ count: 2, one: 'metric', many: 'metrics' }, ...buses], 3).arithmetic,
    '2 metrics × 1,200 buses × 3 years × 8,784 h × 4 B = 253 MB',
  );
});

await check('a shown MB is bytes / 1e6, never a MiB labelled MB', () => {
  // The 2.07 GB cube a 1,024² divisor shows as 1,977.
  const bytes = 2_073_000_000;
  assert.equal(megabytes(bytes), Math.round(bytes / 1e6).toLocaleString());
  assert.equal(megabytes(bytes), (2073).toLocaleString());
  const cube = cubeCost([{ count: 5900, one: 'bus', many: 'buses' }], 10);
  assert.ok(cube.arithmetic.endsWith(` = ${Math.round(cube.bytes / 1e6).toLocaleString()} MB`));
  assert.equal(megabytes(42_163_200), '42');
  assert.equal(megabytes(2_500_000), '2.5', 'below 10 MB keeps one decimal');
});

console.log(`\n${passed} case-span checks passed.`);
