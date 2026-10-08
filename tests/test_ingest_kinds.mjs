// tests/test_ingest_kinds.mjs — each kind's batch, through
// `createIngestKinds(...).ingest(kind, shape, drops)` with scripted readers.
//
// The engines' sequence is tests/test_ingest_batch.mjs; this is what each kind
// decides inside it: which reader a (kind, shape) reaches, which slot a table
// lands on, what a cancelled or emptied picker says, and that Area's wide
// batch widens the one area axis once, and only when something committed.
//
// Run: node tests/test_ingest_kinds.mjs

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { createIngestKinds, AREA_SLOT } = await import('../src/app/ingest-kinds.ts');
const { outcomeNotes } = await import('../src/app/batch.ts');

let passed = 0;
async function check(label, fn) {
  await fn();
  passed++;
  console.log(`ok - ${label}`);
}

const drop = (name, caseName, variant) => ({ file: { name }, caseName, variant });

/** A scripted wide reader over one header of `entities`. */
function wideReader(entities, extra = {}) {
  const calls = { ingests: [] };
  return {
    calls,
    hasSimd: () => true,
    NO_SIMD_MESSAGE: 'no simd',
    async readCasePlan(file) {
      return {
        file,
        header: { entityNames: entities },
        preamble: [],
        title: {},
        firstYear: 2035,
        numYears: 1,
      };
    },
    async ingest(plans, retained) {
      calls.ingests.push(retained);
      return {
        cases: plans.map((plan) => ({ name: plan.file.name, retained })),
        ok: plans.map((_, i) => i),
        warnings: [],
        failures: [],
      };
    },
    unionOf: (plans) => [...new Set(plans.flatMap((plan) => plan.header.entityNames))],
    coverageOf: () => new Map(),
    labelsOf: () => new Map(),
    ...extra,
  };
}

/** A scripted long pool: every file carries `metrics` over `entities`. */
function longPool(metrics, entities) {
  const calls = { ingests: [] };
  return {
    calls,
    hasSimd: () => true,
    NO_SIMD_MESSAGE: 'no simd',
    async readCasePlan(file, sig) {
      return {
        file,
        sig,
        header: { metricNames: metrics },
        entities,
        rowsPerBlock: [],
        firstYear: 2035,
        numYears: 1,
      };
    },
    async discoverEntities(plans) {
      return { ok: plans.map((_, i) => i), failures: [] };
    },
    async ingest(plans, retained, axis, longKind) {
      calls.ingests.push({ retained, axis, longKind });
      return {
        // One table per retained metric, per file, as the long kinds finish.
        cases: plans.map((plan) =>
          retained.map((quantity) => ({ name: plan.file.name, quantity })),
        ),
        ok: plans.map((_, i) => i),
        warnings: [],
        failures: [],
      };
    },
    unionEntities: (plans, base = []) => [...new Set([...base, ...entities])],
    unionMetricsOf: () => metrics,
  };
}

/** Retain gates that answer each kind from `answers` (null is a cancel),
 * recording what they were asked. */
function gates(answers) {
  const asked = {};
  const gate = (kind) => ({
    async resolveRetained(store, batch) {
      asked[kind] = batch;
      return kind in answers ? answers[kind] : batch.union;
    },
  });
  return {
    asked,
    gates: {
      area: gate('area'),
      bus: gate('bus'),
      generator: gate('generator'),
      interface: gate('interface'),
    },
  };
}

function setup({ answers = {}, readers = {}, axis = [] } = {}) {
  const attached = [];
  const calls = [];
  const { asked, gates: retainGates } = gates(answers);
  let areaAxis = [...axis];
  const all = {
    long: longPool(['Load (MWh)'], ['SAMPLE_E1', 'SAMPLE_E2']),
    area: wideReader([' SAMPLE_AREA_2 ', 'SAMPLE_AREA_1', '']),
    bus: wideReader(['90001', '90002']),
    generator: wideReader(['SAMPLE_UNIT_1']),
    interface: wideReader(['SAMPLE_P01', 'SAMPLE_P02']),
    ...readers,
  };
  const kinds = createIngestKinds({
    attach: {
      setBusy() {},
      caseIdForName: (name) => `case:${name}`,
      attach: (caseId, slot, table) => attached.push({ caseId, slot, table }),
      heldSpan: () => null,
    },
    // Read by the long kinds' metric state, which forgets with the last table.
    cases: { tablesOfKind: () => [] },
    retainGates,
    keepsEverything: () => false,
    areaAxis: () => areaAxis,
    adoptAxis(next) {
      calls.push(['adoptAxis', next]);
      areaAxis = next;
    },
    refresh: () => calls.push(['refresh']),
    pickMetrics: async ({ union }) => union,
    readers: all,
  });
  return { kinds, attached, calls, asked, readers: all };
}

await check('each (kind, shape) reaches its own reader and lands on its own slot', async () => {
  const { kinds, attached, readers } = setup();
  await kinds.ingest('area', 'W', [drop('a.csv', 'S')]);
  await kinds.ingest('interface', 'W', [drop('i.csv', 'S', 'Power Flow (MW)')]);
  await kinds.ingest('bus', 'W', [drop('b.csv', 'S', 'LMP ($/MWh)')]);
  await kinds.ingest('generator', 'W', [drop('g.csv', 'S', 'Energy (MWh)')]);
  await kinds.ingest('bus', 'L', [drop('bl.csv', 'S')]);
  await kinds.ingest('generator', 'L', [drop('gl.csv', 'S')]);
  assert.deepEqual(
    attached.map((entry) => [entry.table.name, entry.caseId, entry.slot]),
    [
      ['a.csv', 'case:S', AREA_SLOT],
      ['i.csv', 'case:S', { kind: 'interface', variant: 'Power Flow (MW)' }],
      ['b.csv', 'case:S', { kind: 'bus', variant: 'LMP ($/MWh)' }],
      ['g.csv', 'case:S', { kind: 'generator', variant: 'Energy (MWh)' }],
      ['bl.csv', 'case:S', { kind: 'bus', variant: 'Load (MWh)' }],
      ['gl.csv', 'case:S', { kind: 'generator', variant: 'Load (MWh)' }],
    ],
  );
  for (const kind of ['area', 'interface', 'bus', 'generator']) {
    assert.equal(readers[kind].calls.ingests.length, 1, `${kind} W reached its own reader`);
  }
  assert.deepEqual(
    readers.long.calls.ingests.map((call) => call.longKind.sig.noun.many),
    ['buses', 'units'],
    'the long pool is handed the long kind of the kind that was dropped',
  );
});

await check("Area's wide batch builds on the loaded axis, widened once", async () => {
  const { kinds, calls, readers } = setup({ axis: ['SAMPLE_AREA_0'] });
  await kinds.ingest('area', 'W', [drop('a.csv', 'S'), drop('b.csv', 'T')]);
  const widened = ['SAMPLE_AREA_0', 'SAMPLE_AREA_2', 'SAMPLE_AREA_1'];
  assert.deepEqual(readers.area.calls.ingests, [widened], 'trimmed, deduped, blanks dropped');
  assert.deepEqual(
    calls,
    [['adoptAxis', widened], ['refresh']],
    'the axis is adopted once per batch, before the Case list refreshes',
  );
});

await check('an Area batch that commits nothing leaves the axis alone', async () => {
  const empty = wideReader(['SAMPLE_AREA_9'], {
    async ingest(plans) {
      return {
        cases: [],
        ok: [],
        warnings: [],
        failures: plans.map((plan, index) => ({
          index,
          file: plan.file.name,
          message: 'bad block',
        })),
      };
    },
  });
  const { kinds, calls } = setup({ readers: { area: empty } });
  await kinds.ingest('area', 'W', [drop('a.csv', 'S')]);
  assert.ok(!calls.some(([name]) => name === 'adoptAxis'), 'no reindex for nothing');
});

await check('a cancelled bus or generator picker says so; an emptied one is silent', async () => {
  for (const [kind, noun] of [
    ['bus', 'bus'],
    ['generator', 'generator'],
  ]) {
    const cancelled = setup({ answers: { [kind]: null } });
    const said = outcomeNotes(await cancelled.kinds.ingest(kind, 'W', [drop('x.csv', 'S', 'V')]));
    assert.equal(cancelled.attached.length, 0, `${kind}: nothing loads`);
    assert.ok(
      said.some((line) =>
        line.startsWith(`No ${noun} was selected, so no ${noun} table was loaded.`),
      ),
      `${kind}: the picker opens empty, so a silent stop would read as a drop that did nothing`,
    );
    const emptied = setup({ answers: { [kind]: [] } });
    const quiet = outcomeNotes(await emptied.kinds.ingest(kind, 'W', [drop('x.csv', 'S', 'V')]));
    assert.equal(emptied.attached.length, 0, `${kind}: nothing loads`);
    assert.deepEqual(quiet, [], `${kind}: the user just said it, so no sentence`);
  }
});

await check('an Interface picker cancel stops silently; its answer is passed through', async () => {
  const cancelled = setup({ answers: { interface: null } });
  const said = outcomeNotes(
    await cancelled.kinds.ingest('interface', 'W', [drop('i.csv', 'S', 'V')]),
  );
  assert.deepEqual(said, []);
  assert.equal(cancelled.attached.length, 0);
  const narrowed = setup({ answers: { interface: ['SAMPLE_P02'] } });
  await narrowed.kinds.ingest('interface', 'W', [drop('i.csv', 'S', 'V')]);
  assert.deepEqual(narrowed.readers.interface.calls.ingests, [['SAMPLE_P02']]);
});

await check(
  'the bus picker is asked with the labels its rows need, under a key no id takes',
  async () => {
    const labelled = wideReader(['90001'], { labelsOf: () => new Map([[90001, 'SAMPLE_BUS_A']]) });
    const { kinds, asked } = setup({ readers: { bus: labelled } });
    await kinds.ingest('bus', 'W', [drop('b.csv', 'S', 'V')]);
    const keys = [...asked.bus.coverage.keys()];
    assert.equal(keys.length, 1, 'one extra entry on the coverage map');
    assert.ok(!/^\d+$/.test(String(keys[0])), 'its key cannot collide with a bus id');
  },
);

console.log(`\n${passed} ingest-kinds checks passed.`);
